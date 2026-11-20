// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Energie (Ausbau Oktober 2026) – reine Regeln ohne Systemzugriff: Ein-/Ausschalt-Zeitplan, Wake-on-LAN (ethtool,
// Magic Packet), USV über NUT (Konfigurationsdateien, upsc auswerten, wann herunterfahren).

import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
export const NACHHOLEN_MS = 10 * 60_000;   // verpasstes Ausschalten nur 10 Minuten lang nachholen (nicht Stunden nach dem Start)

export const STANDARD = Object.freeze({
  version: 1,
  zeitplan: { aktiv: false, aus: { tage: [], zeit: '23:00' }, an: { aktiv: false, tage: [], zeit: '07:00' } },
  wol: { geraete: [] },
  usv: { aktiv: false, art: 'usb', host: '', ups: 'ups', benutzer: '', passwort: '', akku_unter: 30, minuten_auf_akku: 0, monitor_passwort: '' },
});

// ---- Zeitplan ---------------------------------------------------------------------------------------------------
const tageNormal = (t) => [...new Set((Array.isArray(t) ? t : []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
function zeitNormal(z, feld) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(z || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw fehler('Uhrzeit bitte als HH:MM', feld);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export function zeitplanNormal(e = {}) {
  const aus = { tage: tageNormal(e.aus && e.aus.tage), zeit: zeitNormal(e.aus && e.aus.zeit, 'zeitplan.aus.zeit') };
  const an = { aktiv: !!(e.an && e.an.aktiv), tage: tageNormal(e.an && e.an.tage), zeit: zeitNormal(e.an && e.an.zeit, 'zeitplan.an.zeit') };
  const aktiv = !!e.aktiv;
  if (aktiv && !aus.tage.length) throw fehler('Bitte mindestens einen Tag zum Ausschalten wählen', 'zeitplan.aus.tage');
  if (aktiv && an.aktiv && !an.tage.length) throw fehler('Bitte mindestens einen Tag zum Einschalten wählen', 'zeitplan.an.tage');
  return { aktiv, aus, an };
}

function amTag(basis, tageZurueck, zeit) {
  const [h, m] = zeit.split(':').map(Number);
  const d = new Date(basis.getTime()); d.setDate(d.getDate() + tageZurueck); d.setHours(h, m, 0, 0);
  return d;
}

/** Fälliges Ausschalten (ms) – der jüngste Planzeitpunkt ≤ jetzt, höchstens 10 Minuten alt und nach `bedientBis`. */
export function ausFaellig(z, jetzt, bedientBis = null) {
  if (!z || !z.aktiv || !z.aus.tage.length) return null;
  let bester = null;
  for (const d of [0, -1]) {
    const t = amTag(jetzt, d, z.aus.zeit);
    if (!z.aus.tage.includes(t.getDay())) continue;
    const ms = t.getTime();
    if (ms > jetzt.getTime() || jetzt.getTime() - ms > NACHHOLEN_MS || (bedientBis !== null && ms <= bedientBis)) continue;
    if (bester === null || ms > bester) bester = ms;
  }
  return bester;
}

/** Nächster Zeitpunkt (ms) einer Regel {tage, zeit} nach `jetzt` (bis 8 Tage) oder null. */
export function naechster(regel, jetzt) {
  if (!regel || !regel.tage || !regel.tage.length) return null;
  for (let d = 0; d <= 8; d++) {
    const t = amTag(jetzt, d, regel.zeit);
    if (regel.tage.includes(t.getDay()) && t.getTime() > jetzt.getTime() + 60_000) return t.getTime();
  }
  return null;
}

// ---- Wake-on-LAN ------------------------------------------------------------------------------------------------
export function macNormal(text, feld = 'mac') {
  const h = String(text || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (h.length !== 12) throw fehler('MAC-Adresse bitte wie 00:11:22:33:44:55 angeben', feld);
  return h.match(/../g).join(':');
}

/** Magic Packet: 6 × FF, dann 16 × MAC. */
export function magicPacket(mac) {
  const m = Buffer.from(macNormal(mac).replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
}

/** `ethtool <if>` → {unterstuetzt: 'pumbg', aktuell: 'g'} */
export function ethtoolWol(text) {
  const u = /Supports Wake-on:\s*(\S+)/.exec(String(text || ''));
  const a = /^\s*Wake-on:\s*(\S+)/m.exec(String(text || ''));
  return { unterstuetzt: u ? u[1] : '', aktuell: a ? a[1] : '' };
}

export function wolUnit(schnittstelle, an) {
  if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(schnittstelle)) throw fehler('Netzwerkschnittstelle ungültig', 'wol');
  return ['# Erzeugt von FAH-NAS (System → Energie) – nicht von Hand ändern.', '[Unit]', 'Description=FAH-NAS: Wake-on-LAN einstellen', 'After=network-pre.target', 'Wants=network-pre.target', '',
    '[Service]', 'Type=oneshot', `ExecStart=/usr/sbin/ethtool -s ${schnittstelle} wol ${an ? 'g' : 'd'}`, '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n');
}

export function wolGeraeteNormal(liste) {
  const aus = [];
  for (const [i, g] of (Array.isArray(liste) ? liste : []).entries()) {
    const name = String(g && g.name || '').trim();
    if (!/^[\p{L}\p{N} ._-]{1,32}$/u.test(name)) throw fehler('Gerätename: 1–32 Zeichen', `wol.geraete.${i}.name`);
    aus.push({ name, mac: macNormal(g.mac, `wol.geraete.${i}.mac`) });
  }
  if (aus.length > 30) throw fehler('Höchstens 30 Geräte', 'wol.geraete');
  return aus;
}

// ---- USV (NUT) --------------------------------------------------------------------------------------------------
const NUT_NAME = /^[A-Za-z0-9_.-]{1,32}$/;

export function usvNormal(e = {}, alt = STANDARD.usv) {
  const u = { ...STANDARD.usv, ...alt, ...e };
  u.aktiv = !!u.aktiv;
  if (!['usb', 'netz'].includes(u.art)) u.art = 'usb';
  u.host = String(u.host || '').trim(); u.ups = String(u.ups || 'ups').trim(); u.benutzer = String(u.benutzer || '').trim();
  if (e.passwort === undefined || e.passwort === '') u.passwort = alt.passwort || '';
  u.akku_unter = Number(u.akku_unter); u.minuten_auf_akku = Number(u.minuten_auf_akku);
  if (!Number.isInteger(u.akku_unter) || u.akku_unter < 5 || u.akku_unter > 95) throw fehler('Herunterfahren bei Akkustand: 5–95 %', 'usv.akku_unter');
  if (!Number.isInteger(u.minuten_auf_akku) || u.minuten_auf_akku < 0 || u.minuten_auf_akku > 240) throw fehler('Minuten auf Akku: 0 (aus) bis 240', 'usv.minuten_auf_akku');
  if (u.aktiv && u.art === 'netz') {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(u.host)) throw fehler('Netzwerk-USV: Adresse des NUT-Servers eintragen (z. B. 192.168.1.23)', 'usv.host');
    if (!NUT_NAME.test(u.ups)) throw fehler('Netzwerk-USV: Name der USV (oft „ups“)', 'usv.ups');
    if (!NUT_NAME.test(u.benutzer)) throw fehler('Netzwerk-USV: Benutzer (bei Synology/UGREEN oft „monuser“)', 'usv.benutzer');
    if (!u.passwort || /["\n\r]/.test(u.passwort)) throw fehler('Netzwerk-USV: Passwort eintragen (ohne Anführungszeichen)', 'usv.passwort');
  }
  if (!u.monitor_passwort) u.monitor_passwort = crypto.randomBytes(12).toString('hex');
  return u;
}

/** Ziel für upsc/upsmon: „fahnas@localhost“ (USB) oder „ups@host“ (Netz). */
export const usvZiel = (u) => (u.art === 'netz' ? `${u.ups}@${u.host}` : 'fahnas@localhost');

/** ups.conf ohne Abschnitt: USV aus oder Netzwerk-USV, hier läuft kein Treiber. */
export const UPS_CONF_OHNE_GERAET = '# Erzeugt von FAH-NAS (System → Energie → USV) – nicht von Hand ändern.\n# Kein lokales USV-Gerät.\n';

/** NUT-Konfigurationsdateien {name: inhalt}. `treiber` = Abschnitt aus nut-scanner (nur USB). */
export function nutDateien(u, treiber = null) {
  const kopf = '# Erzeugt von FAH-NAS (System → Energie → USV) – nicht von Hand ändern.\n';
  const d = { 'nut.conf': `${kopf}MODE=${u.art === 'netz' ? 'netclient' : 'standalone'}\n` };
  const monitor = u.art === 'netz'
    ? `MONITOR ${usvZiel(u)} 1 ${u.benutzer} "${u.passwort}" secondary`
    : `MONITOR fahnas@localhost 1 fahnas-monitor "${u.monitor_passwort}" primary`;
  d['upsmon.conf'] = `${kopf}${monitor}\nMINSUPPLIES 1\nSHUTDOWNCMD "/sbin/shutdown -h +0"\nPOWERDOWNFLAG /etc/killpower\nPOLLFREQ 5\nPOLLFREQALERT 5\nDEADTIME 25\n`;
  if (u.art === 'usb') {
    const t = treiber || { driver: 'usbhid-ups', port: 'auto' };
    const zeilen = Object.entries(t).filter(([k, v]) => /^[a-z_.]{1,32}$/.test(k) && v !== undefined && !/["\n\r]/.test(String(v))).map(([k, v]) => `  ${k} = "${v}"`);
    d['ups.conf'] = `${kopf}maxretry = 3\n\n[fahnas]\n${zeilen.join('\n')}\n  desc = "USV am FAH-NAS"\n  pollinterval = 10\n`;
    d['upsd.conf'] = `${kopf}LISTEN 127.0.0.1 3493\nLISTEN ::1 3493\n`;
    d['upsd.users'] = `${kopf}[fahnas-monitor]\n  password = "${u.monitor_passwort}"\n  upsmon primary\n`;
  }
  return d;
}

/** `nut-scanner -U -q` → erster Treiber-Abschnitt {driver, port, vendorid, productid, …} oder null. */
export function nutScannerParsen(text) {
  let akt = null; const alle = [];
  for (const z of String(text || '').split('\n')) {
    if (/^\s*\[[^\]]+\]\s*$/.test(z)) { akt = {}; alle.push(akt); continue; }
    const m = /^\s*([a-z_.]+)\s*=\s*"?([^"]*)"?\s*$/.exec(z);
    if (m && akt) akt[m[1]] = m[2];
  }
  const t = alle.find((x) => x.driver);
  return t ? Object.fromEntries(Object.entries(t).filter(([k]) => ['driver', 'port', 'vendorid', 'productid', 'product', 'serial', 'vendor', 'bus'].includes(k))) : null;
}

/** `upsc <ziel>` → Zustand {status, netz, akku, ladung, restzeit_s, last, modell}. */
export function upscParsen(text) {
  const w = {};
  for (const z of String(text || '').split('\n')) { const i = z.indexOf(':'); if (i > 0) w[z.slice(0, i).trim()] = z.slice(i + 1).trim(); }
  const status = (w['ups.status'] || '').split(/\s+/).filter(Boolean);
  const zahl = (k) => (w[k] !== undefined && Number.isFinite(Number(w[k])) ? Number(w[k]) : null);
  return {
    status: status.join(' ') || null, netz: status.includes('OL'), akku: status.includes('OB'), schwach: status.includes('LB'),
    ladung: zahl('battery.charge'), restzeit_s: zahl('battery.runtime'), last: zahl('ups.load'),
    modell: [w['device.mfr'] || w['ups.mfr'], w['device.model'] || w['ups.model']].filter(Boolean).join(' ') || null,
  };
}

/**
 * Entscheidung je Takt: melden (Stromausfall/zurück) und ob jetzt heruntergefahren werden soll.
 * `merk` = {auf_akku_seit: ms|null} (wird angepasst).
 * @returns {{meldung?: {stufe, titel, text, schluessel}, herunterfahren?: string}}
 */
export function usvEntscheiden(z, u, merk, jetzt = Date.now()) {
  const aus = {};
  if (!z || z.status === null) return aus;
  if (z.akku) {
    if (!merk.auf_akku_seit) {
      merk.auf_akku_seit = jetzt;
      aus.meldung = { stufe: 'warnung', titel: 'Stromausfall – NAS läuft auf USV-Akku', text: `Die USV meldet Akkubetrieb${z.ladung !== null ? ` (Ladung ${z.ladung} %)` : ''}. FAH-NAS fährt bei ${u.akku_unter} %${u.minuten_auf_akku ? ` oder nach ${u.minuten_auf_akku} Minuten` : ''} herunter.`, schluessel: `usv_akku_${jetzt}` };
    }
    const minuten = (jetzt - merk.auf_akku_seit) / 60_000;
    if (z.ladung !== null && z.ladung <= u.akku_unter) aus.herunterfahren = `Akkustand ${z.ladung} % (Grenze ${u.akku_unter} %)`;
    else if (u.minuten_auf_akku > 0 && minuten >= u.minuten_auf_akku) aus.herunterfahren = `${Math.floor(minuten)} Minuten auf Akku (Grenze ${u.minuten_auf_akku})`;
  } else if (z.netz && merk.auf_akku_seit) {
    merk.auf_akku_seit = null;
    aus.meldung = { stufe: 'info', titel: 'Strom wieder da', text: `Die USV läuft wieder am Netz${z.ladung !== null ? ` (Ladung ${z.ladung} %)` : ''}.`, schluessel: `usv_netz_${jetzt}` };
  }
  return aus;
}
