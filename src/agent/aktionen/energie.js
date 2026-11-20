// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „energie.*“ (Ausbau Oktober 2026): Ein-/Ausschalt-Zeitplan (Ausschalten zur Uhrzeit, Wiedereinschalten über
// den RTC-Wecker), Wake-on-LAN (dauerhaft per kleiner systemd-Unit, andere Geräte aufwecken) und USV über NUT (USB am NAS
// oder Netzwerk-USV eines anderen Geräts, Herunterfahren bei Akkustand/Dauer, Meldungen). Wahrheit: energie.json (0600).

import fs from 'node:fs/promises';
import path from 'node:path';
import dgram from 'node:dgram';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { paketeSicherstellen, paketeFehlend } from '../helfer/pakete.js';
import * as r from '../energie/regeln.js';

export const DATEI = 'energie.json';
const ZUSTAND = 'energie-zustand.json';
const TAKT_MS = 30_000;
const AUFSCHUB_MS = 10 * 60_000;
const AUFSCHUB_MAX_MS = 2 * 3_600_000;
const nutOrdner = () => process.env.FAHNAS_NUT || '/etc/nut';
const wolUnitPfad = () => process.env.FAHNAS_WOL_UNIT || '/etc/systemd/system/fahnas-wol.service';

export function normal(d) {
  const s = structuredClone(r.STANDARD);
  if (!d || typeof d !== 'object') return s;
  return { version: 1, zeitplan: { ...s.zeitplan, ...(d.zeitplan || {}), aus: { ...s.zeitplan.aus, ...(d.zeitplan?.aus || {}) }, an: { ...s.zeitplan.an, ...(d.zeitplan?.an || {}) } }, wol: { ...s.wol, ...(d.wol || {}) }, usv: { ...s.usv, ...(d.usv || {}) } };
}
const laden = async (w) => normal(await w.konfig.laden(DATEI, null));

/** Schnittstelle der Standardroute, ihre MAC und der Wake-on-LAN-Stand. */
async function wolStand(w) {
  let dev = null;
  try { dev = (JSON.parse((await w.system.ausfuehren('ip', ['-j', 'route', 'show', 'default'])).stdout || '[]')[0] || {}).dev || null; } catch { /* keine Route */ }
  if (!dev) return { schnittstelle: null, mac: null, unterstuetzt: false, an: false };
  let mac = null; try { mac = (await fs.readFile(`/sys/class/net/${dev}/address`, 'utf8')).trim(); } catch { /* egal */ }
  let e = { unterstuetzt: '', aktuell: '' };
  try { e = r.ethtoolWol((await w.system.ausfuehren('ethtool', [dev], { erlaubteCodes: [0, 75, 76] })).stdout); } catch { /* ethtool fehlt */ }
  return { schnittstelle: dev, mac, unterstuetzt: e.unterstuetzt.includes('g'), an: e.aktuell.includes('g') };
}

async function wolSetzen(w, an) {
  const s = await wolStand(w);
  if (!s.schnittstelle) throw new FahnasFehler('E_SYSTEM', 'Keine Netzwerkschnittstelle mit Standardroute gefunden');
  if (an && !s.unterstuetzt) throw new FahnasFehler('E_PARAMS', 'Die Netzwerkkarte unterstützt Wake-on-LAN nicht (oder es ist im BIOS aus)', { feld: 'wol' });
  await w.system.ausfuehren('ethtool', ['-s', s.schnittstelle, 'wol', an ? 'g' : 'd']);
  await fs.writeFile(wolUnitPfad(), r.wolUnit(s.schnittstelle, an), { mode: 0o644 });
  await w.system.ausfuehren('systemctl', ['daemon-reload']);
  await w.system.ausfuehren('systemctl', ['enable', path.basename(wolUnitPfad())]);
}

async function nutGid(w) {
  try { return Number(String((await w.system.ausfuehren('getent', ['group', 'nut'])).stdout).split(':')[2]) || 0; } catch { return 0; }
}

const nutStoppen = async (w, units) => {
  for (const s of units) { try { await w.system.ausfuehren('systemctl', ['disable', '--now', s]); } catch { /* war nie an oder fehlt */ } }
};

/** Lokaler Treiber weg: nut-driver@fahnas hat Restart=always und scheitert ohne USV sonst alle 15 s. Ohne Gerät in
 *  ups.conf nimmt der Enumerator die Instanz selbst zurück; er kann dabei upsd neu starten, deshalb erst danach stoppen. */
async function nutTreiberEntfernen(w) {
  const conf = path.join(nutOrdner(), 'ups.conf');
  try { await fs.access(conf); } catch { return; }
  await fs.writeFile(conf, r.UPS_CONF_OHNE_GERAET);
  try { await w.system.ausfuehren('systemctl', ['restart', 'nut-driver-enumerator.service'], { zeitlimit_ms: 60_000 }); } catch { /* Unit fehlt */ }
  await nutStoppen(w, ['nut-server.service', 'nut-driver-enumerator.path', 'nut-driver-enumerator.service', 'nut-driver.target']);
}

const nutEingeschaltet = async (w) => {
  try { return String((await w.system.ausfuehren('systemctl', ['is-enabled', 'nut.target'], { erlaubteCodes: [0, 1, 4] })).stdout).trim() === 'enabled'; } catch { return false; }
};

/** USV einrichten bzw. abschalten. nut.target zieht Server, Monitor und Treiber beim Hochfahren hoch, auch wenn diese
 *  einzeln „disabled“ sind – „aus“ muss es deshalb mit abschalten, „an“ wieder einschalten. */
async function usvAnwenden(w, u, fortschritt = () => {}) {
  const ziel = nutOrdner();
  if (!u.aktiv) {
    await nutTreiberEntfernen(w);
    await nutStoppen(w, ['nut.target', 'nut-monitor.service', 'nut-server.service', 'nut-driver-enumerator.path', 'nut-driver-enumerator.service', 'nut-driver.target']);
    try { await w.system.ausfuehren('systemctl', ['reset-failed', 'nut-monitor.service', 'nut-server.service']); } catch { /* nichts zurückzusetzen */ }
    return null;
  }
  fortschritt('Pakete prüfen');
  await paketeSicherstellen(w.system, [u.art === 'netz' ? 'nut-client' : 'nut'], { fortschritt, zweck: 'die USV' });
  let treiber = null;
  if (u.art === 'usb') {
    fortschritt('USV am USB suchen');
    try { treiber = r.nutScannerParsen((await w.system.ausfuehren('nut-scanner', ['-U', '-q'], { zeitlimit_ms: 60_000, erlaubteCodes: [0, 1] })).stdout); } catch { treiber = null; }
    if (!treiber) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Keine USV am USB gefunden – Kabel stecken? (Manche USVs brauchen ein paar Sekunden nach dem Einstecken)', { feld: 'usv.art' });
  }
  const gid = await nutGid(w);
  await fs.mkdir(ziel, { recursive: true });
  for (const [name, inhalt] of Object.entries(r.nutDateien(u, treiber))) {
    const p = path.join(ziel, name);
    await fs.writeFile(p, inhalt, { mode: 0o640 });
    if (gid) { try { await fs.chown(p, 0, gid); } catch { /* Tests ohne root */ } }
  }
  fortschritt('USV-Dienste starten');
  const units = u.art === 'usb' ? ['nut-driver-enumerator.path', 'nut-driver-enumerator.service', 'nut-server.service', 'nut-monitor.service'] : ['nut-monitor.service'];
  if (u.art === 'netz') await nutTreiberEntfernen(w);
  for (const s of ['nut.target', ...(u.art === 'usb' ? ['nut-driver.target'] : [])]) { try { await w.system.ausfuehren('systemctl', ['enable', s]); } catch { /* manche Units sind statisch */ } }
  for (const s of units) {
    try { await w.system.ausfuehren('systemctl', ['enable', s]); } catch { /* manche Units sind statisch */ }
    await w.system.ausfuehren('systemctl', ['restart', s], { zeitlimit_ms: 60_000 });
  }
  return treiber;
}

async function usvStatus(w, u) {
  if (!u.aktiv) return null;
  try { return r.upscParsen((await w.system.ausfuehren('upsc', [r.usvZiel(u)], { zeitlimit_ms: 15_000 })).stdout); } catch (e) { return { fehler: FahnasFehler.aus(e).details?.ausgabe?.trim().split('\n').pop() || 'USV antwortet nicht' }; }
}

function ansicht(c) {
  const { passwort, monitor_passwort: _m, ...usv } = c.usv; // eslint-disable-line no-unused-vars
  return { zeitplan: c.zeitplan, wol_geraete: c.wol.geraete, usv: { ...usv, passwort_gesetzt: !!passwort } };
}

function naechste(c, jetzt = new Date()) {
  const z = c.zeitplan;
  return { naechstes_aus: z.aktiv ? r.naechster(z.aus, jetzt) : null, naechstes_an: z.aktiv && z.an.aktiv ? r.naechster(z.an, jetzt) : null };
}

/** Magic Packet an die Broadcast-Adresse (Port 9) senden. */
export function aufwecken(mac, { ziel = '255.255.255.255', socketBauen = () => dgram.createSocket('udp4') } = {}) {
  const paket = r.magicPacket(mac);
  return new Promise((ok, nein) => {
    const s = socketBauen();
    s.once('error', (e) => { try { s.close(); } catch { /* egal */ } nein(new FahnasFehler('E_SYSTEM', `Wake-on-LAN-Paket nicht gesendet: ${e.message}`)); });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch { /* egal */ }
      s.send(paket, 9, ziel, (e) => { try { s.close(); } catch { /* egal */ } if (e) nein(new FahnasFehler('E_SYSTEM', `Wake-on-LAN-Paket nicht gesendet: ${e.message}`)); else ok(paket.length); });
    });
  });
}

/** Herunterfahren (Zeitplan oder USV): Meldung, ggf. RTC-Wecker, dann poweroff. */
export async function herunterfahren(w, { grund, anMs = null, art = 'energie' }) {
  await w.intern('benachrichtigungen.senden', { art, stufe: art === 'usv' ? 'fehler' : 'info', titel: 'NAS fährt herunter', text: `FAH-NAS fährt jetzt herunter: ${grund}.${anMs ? ` Einschalten geplant für ${new Date(anMs).toLocaleString('de-DE')}.` : ''}`, schluessel: `aus_${Date.now()}` }).catch(() => {});
  if (anMs) {
    try { await w.system.ausfuehren('rtcwake', ['-m', 'no', '-t', String(Math.floor(anMs / 1000))]); } catch (e) { process.stderr.write(`[energie] rtcwake: ${e.message}\n`); }
  }
  await w.system.ausfuehren('systemctl', ['poweroff']);
}

export function registriere(reg, w) {
  reg.aktion('energie.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Zeitplan, Wake-on-LAN und USV (ohne Passwörter)',
    ausfuehren: async () => {
      const c = await laden(w);
      let fehlen = [];
      try { fehlen = await paketeFehlend(w.system, [c.usv.art === 'netz' ? 'nut-client' : 'nut']); } catch { /* egal */ }
      return { ...ansicht(c), wol: await wolStand(w), ...naechste(c), usv_pakete_fehlen: fehlen };
    },
  });

  reg.aktion('energie.status', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'USV-Zustand, nächstes Aus-/Einschalten, Wake-on-LAN',
    ausfuehren: async () => {
      const c = await laden(w);
      const z = await w.konfig.laden(ZUSTAND, {});
      return { usv_aktiv: c.usv.aktiv, usv: await usvStatus(w, c.usv), auf_akku_seit: z.auf_akku_seit || null, ...naechste(c), zeitplan_aktiv: c.zeitplan.aktiv, wol: (await wolStand(w)).an };
    },
  });

  reg.aktion('energie.speichern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Zeitplan, Wake-on-LAN und USV einstellen',
    schema: { zeitplan: { typ: 'object' }, wol: { typ: 'object' }, usv: { typ: 'object' } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const alt = await laden(w);
      const c = structuredClone(alt);
      if (p.zeitplan) c.zeitplan = r.zeitplanNormal({ ...alt.zeitplan, ...p.zeitplan });
      if (p.wol && p.wol.geraete !== undefined) c.wol.geraete = r.wolGeraeteNormal(p.wol.geraete);
      if (p.usv) c.usv = r.usvNormal(p.usv, alt.usv);
      if (p.wol && typeof p.wol.an === 'boolean') { aufgabe?.fortschritt(0.1, 'Wake-on-LAN'); await wolSetzen(w, p.wol.an); }
      let treiber = null;
      if (p.usv) {
        try { treiber = await usvAnwenden(w, c.usv, (t) => aufgabe?.fortschritt(0.4, t)); } catch (e) {
          if (alt.usv.aktiv) { try { await usvAnwenden(w, alt.usv); } catch { /* bestmöglich */ } }
          throw e;
        }
      }
      await w.konfig.speichern(DATEI, c);
      w.konfigGeaendert?.('energie');
      aufgabe?.fortschritt(1, 'Gespeichert');
      return { ...ansicht(c), wol: await wolStand(w), ...naechste(c), usv_treiber: treiber };
    },
  });

  reg.aktion('energie.aufwecken', {
    rolle: 'admin', beschreibung: 'Anderes Gerät per Wake-on-LAN aufwecken',
    schema: { mac: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p) => ({ gesendet: await aufwecken(p.mac), mac: r.macNormal(p.mac) }),
  });

  reg.aktion('energie.usv_suchen', {
    rolle: 'admin', aufgabe: true, schema: {}, beschreibung: 'USB-USV suchen (installiert dafür NUT)',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      await paketeSicherstellen(w.system, ['nut'], { fortschritt: (t) => aufgabe?.fortschritt(0.3, t), zweck: 'die USV-Suche' });
      aufgabe?.fortschritt(0.7, 'USB wird durchsucht');
      let t = null; try { t = r.nutScannerParsen((await w.system.ausfuehren('nut-scanner', ['-U', '-q'], { zeitlimit_ms: 60_000, erlaubteCodes: [0, 1] })).stdout); } catch { t = null; }
      return { gefunden: !!t, treiber: t };
    },
  });

  reg.aktion('energie.apply', {
    rolle: 'system', schema: {}, beschreibung: 'USV-Konfiguration aus energie.json herstellen (Start, Import)',
    ausfuehren: async () => {
      const c = await laden(w);
      if (!c.usv.aktiv) {
        if (!(await nutEingeschaltet(w))) return false;
        await usvAnwenden(w, c.usv);
        return true;
      }
      if ((await paketeFehlend(w.system, [c.usv.art === 'netz' ? 'nut-client' : 'nut'])).length) return false;
      await usvAnwenden(w, c.usv);
      return true;
    },
  });
}

// ---- Takt -------------------------------------------------------------------------------------------------------
let takt = null;
const merk = { auf_akku_seit: null };

/** Ein Takt: Zeitplan prüfen (mit Aufschub, solange Aufgaben laufen) und USV-Regeln anwenden. */
export async function taktPruefen(w, jetzt = new Date()) {
  const c = await laden(w);
  // USV
  if (c.usv.aktiv) {
    const z = await usvStatus(w, c.usv);
    if (z && !z.fehler) {
      const vorher = merk.auf_akku_seit;
      const e = r.usvEntscheiden(z, c.usv, merk, jetzt.getTime());
      if (merk.auf_akku_seit !== vorher) await w.konfig.speichern(ZUSTAND, { ...(await w.konfig.laden(ZUSTAND, {})), auf_akku_seit: merk.auf_akku_seit });
      if (e.meldung) await w.intern('benachrichtigungen.senden', { art: 'usv', ...e.meldung }).catch(() => {});
      if (e.herunterfahren) { await herunterfahren(w, { grund: `USV – ${e.herunterfahren}`, art: 'usv' }); return 'usv'; }
    }
  }
  // Zeitplan
  const zust = await w.konfig.laden(ZUSTAND, {});
  const faellig = r.ausFaellig(c.zeitplan, jetzt, zust.aus_bedient_bis ?? null);
  const aufschub = zust.aufschub_bis && jetzt.getTime() < zust.aufschub_bis;
  if (faellig === null && !(zust.aufschub_seit && !aufschub)) return null;
  if (aufschub) return null;
  const laufend = typeof w.aufgaben?.liste === 'function' ? w.aufgaben.liste().filter((a) => a.status === 'laeuft') : [];
  const seit = zust.aufschub_seit || jetzt.getTime();
  if (laufend.length && jetzt.getTime() - seit < AUFSCHUB_MAX_MS) {
    await w.konfig.speichern(ZUSTAND, { ...zust, aus_bedient_bis: faellig ?? zust.aus_bedient_bis, aufschub_seit: seit, aufschub_bis: jetzt.getTime() + AUFSCHUB_MS });
    if (!zust.aufschub_seit) await w.intern('benachrichtigungen.senden', { art: 'energie', stufe: 'info', titel: 'Ausschalten verschoben', text: `Es laufen noch ${laufend.length} Aufgabe(n) (z. B. ${laufend[0].aktion}). FAH-NAS versucht es alle 10 Minuten erneut, höchstens 2 Stunden lang.`, schluessel: `aufschub_${seit}` }).catch(() => {});
    return 'aufschub';
  }
  await w.konfig.speichern(ZUSTAND, { ...zust, aus_bedient_bis: faellig ?? zust.aus_bedient_bis ?? jetzt.getTime(), aufschub_seit: null, aufschub_bis: null });
  const an = c.zeitplan.an.aktiv ? r.naechster(c.zeitplan.an, jetzt) : null;
  await herunterfahren(w, { grund: 'Zeitplan', anMs: an });
  return 'aus';
}

export async function starten(w) {
  try { merk.auf_akku_seit = (await w.konfig.laden(ZUSTAND, {})).auf_akku_seit || null; } catch { /* egal */ }
  takt = setInterval(() => { taktPruefen(w).catch((e) => process.stderr.write(`[energie] ${e && e.message}\n`)); }, TAKT_MS); takt.unref?.();
}
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
export const _test = { merk };
