// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „wartung.*“ (Betreiber 12.10.2026: „mach alle 8 punkte“): automatische Prüfungen (SMART-Selbsttests,
// RAID-Datenprüfung) mit Meldung bei Fehlern, automatische Updates (unattended-upgrades aus der Oberfläche) und der
// Sicherheits-Check, dessen Punkte im Handlungsbedarf erscheinen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import * as totp from '../totp.js';
import * as r from '../wartung/regeln.js';
import { kontingentZeigen } from './freigaben.js';
import { heimPfad } from './heim.js';

export const DATEI = 'wartung.json';
const ZUSTAND_DATEI = 'wartung_zustand.json';
const TAKT_MS = 60_000;
const ABFRAGE_MS = 10 * 60_000;        // laufende Selbsttests alle 10 min nachsehen
const SELBSTTEST_MAX_MS = 36 * 3600_000; // länger läuft kein Test – danach „unbekannt“
const PW_TTL_MS = 6 * 3600_000;
const SMART_CODES = Object.freeze([...Array(256).keys()]);
const p = {
  aptConf: () => process.env.FAHNAS_APT_CONF_D || '/etc/apt/apt.conf.d',
  units: () => process.env.FAHNAS_UNITS || '/etc/systemd/system',
  uuLog: () => process.env.FAHNAS_UU_LOG || '/var/log/unattended-upgrades/unattended-upgrades.log',
  neustart: () => process.env.FAHNAS_REBOOT_REQUIRED || '/var/run/reboot-required',
  sysBlock: () => process.env.FAHNAS_SYS_BLOCK || '/sys/block',
};

const laden = async (w) => r.normal((await w.konfig.laden(DATEI, null)) || {});
const zustandLaden = async (w) => { const z = (await w.konfig.laden(ZUSTAND_DATEI, null)) || {}; return { letzte: z.letzte || {}, smart: z.smart || {}, raid: z.raid || {} }; };
const zustandAendern = (w, fn) => w.konfig.aendern(ZUSTAND_DATEI, (roh) => fn({ letzte: {}, smart: {}, raid: {}, ...(roh || {}) }), { letzte: {}, smart: {}, raid: {} });
const lesen = async (datei) => { try { return await fs.readFile(datei, 'utf8'); } catch { return ''; } };
const melden = (w, m) => w.intern('benachrichtigungen.senden', m).catch(() => {});

async function platten(w) {
  try {
    const j = JSON.parse(String((await w.system.ausfuehren('lsblk', ['-J', '-d', '-o', 'NAME,TYPE,MODEL,TRAN'])).stdout || '{}'));
    return (j.blockdevices || []).filter((d) => d && d.type === 'disk' && /^[a-zA-Z0-9]+$/.test(d.name || '') && !/^(loop|zram|sr|ram|fd|md)/.test(d.name))
      .map((d) => ({ geraet: `/dev/${d.name}`, modell: (d.model || '').trim(), usb: d.tran === 'usb' }));
  } catch { return []; }
}

// ---- automatische Updates --------------------------------------------------------------------------------------
async function autoUpdatesAnwenden(w, u) {
  if (u.aktiv) await paketeSicherstellen(w.system, ['unattended-upgrades'], { zweck: 'automatische Updates' });
  const d = r.autoUpdateDateien(u);
  await fs.mkdir(p.aptConf(), { recursive: true });
  await fs.writeFile(path.join(p.aptConf(), '21fahnas-auto-upgrades'), d.periodic);
  await fs.writeFile(path.join(p.aptConf(), '52fahnas-unattended-upgrades'), d.unattended);
  const timerOrdner = path.join(p.units(), 'apt-daily-upgrade.timer.d');
  await fs.mkdir(timerOrdner, { recursive: true });
  await fs.writeFile(path.join(timerOrdner, 'fahnas.conf'), d.timer);
  try { await w.system.ausfuehren('systemctl', ['daemon-reload']); await w.system.ausfuehren('systemctl', ['restart', 'apt-daily-upgrade.timer']); } catch { /* Timer fehlt (Test) */ }
}

async function updateStatus(w) {
  const lauf = r.letzterUpdateLauf(await lesen(p.uuLog()));
  let neustart = false; try { await fs.access(p.neustart()); neustart = true; } catch { /* keiner nötig */ }
  return { letzter_lauf: lauf, neustart_noetig: neustart };
}

// ---- Prüfungen --------------------------------------------------------------------------------------------------
async function smartStarten(w, art) {
  const liste = await platten(w);
  const jetzt = Date.now();
  const gestartet = [];
  for (const pl of liste) {
    try {
      const res = await w.system.ausfuehren('smartctl', ['-t', art === 'smart_lang' ? 'long' : 'short', pl.geraet], { erlaubteCodes: SMART_CODES, zeitlimit_ms: 60_000 });
      if (/has begun|Testing has begun|Self-test has begun|Self Test has begun|started/i.test(String(res.stdout))) gestartet.push(pl);
      else await zustandAendern(w, (z) => { z.smart[pl.geraet] = { modell: pl.modell, art, gestartet: jetzt, ende: jetzt, bestanden: null, text: 'Selbsttest wird von dieser Platte nicht unterstützt' }; return z; });
    } catch { /* smartctl fehlt */ }
  }
  await zustandAendern(w, (z) => {
    for (const pl of gestartet) z.smart[pl.geraet] = { modell: pl.modell, art, gestartet: jetzt, ende: null, bestanden: null, text: 'läuft', geprueft: jetzt };
    z.letzte.smart = jetzt; return z;
  });
  return gestartet.length;
}

async function smartNachsehen(w) {
  const z = await zustandLaden(w);
  const jetzt = Date.now();
  for (const [geraet, s] of Object.entries(z.smart)) {
    if (s.ende || jetzt - (s.geprueft || 0) < ABFRAGE_MS) continue;
    let ergebnis;
    try {
      const res = await w.system.ausfuehren('smartctl', ['-j', '-c', '-l', 'selftest', geraet], { erlaubteCodes: SMART_CODES, zeitlimit_ms: 30_000 });
      let json = null; try { json = JSON.parse(res.stdout); } catch { json = null; }
      ergebnis = r.selbsttestAuswerten(json);
    } catch { ergebnis = { laeuft: false, bestanden: null, text: 'smartctl nicht ausführbar' }; }
    const zuLang = jetzt - s.gestartet > SELBSTTEST_MAX_MS;
    await zustandAendern(w, (zz) => {
      const e = zz.smart[geraet]; if (!e) return zz;
      e.geprueft = jetzt;
      if (ergebnis.laeuft && !zuLang) { e.text = ergebnis.text; e.prozent_rest = ergebnis.prozent_rest ?? null; return zz; }
      Object.assign(e, { ende: jetzt, bestanden: zuLang ? null : ergebnis.bestanden, text: zuLang ? 'Ergebnis nicht ermittelbar' : ergebnis.text, prozent_rest: null });
      return zz;
    });
    if (!ergebnis.laeuft && ergebnis.bestanden === false) {
      await melden(w, { art: 'platte', stufe: 'fehler', titel: `Selbsttest fehlgeschlagen: ${s.modell || geraet}`, text: `Der ${s.art === 'smart_lang' ? 'gründliche' : 'kurze'} Selbsttest der Platte ${s.modell || ''} (${geraet}) ist fehlgeschlagen: ${ergebnis.text}. Die Platte sollte bald ersetzt werden – vorher sichern!`, schluessel: `selbsttest_${geraet}_${s.gestartet}` });
    }
  }
}

async function mdName(name) { try { return path.basename(await fs.realpath(`/dev/md/fahnas-${name}`)); } catch { return null; } }

async function raidStarten(w) {
  let liste = [];
  try { const res = await w.intern('raid.liste', {}); liste = ((res && 'ergebnis' in res ? res.ergebnis : res) || {}).verbuende || []; } catch { liste = []; } // intern liefert {ergebnis}
  const jetzt = Date.now();
  const gestartet = [];
  for (const v of liste) {
    if (v.stufe === 'raid0' || v.zustand !== 'ok' || (v.fortschritt && v.fortschritt.art)) continue;
    try { await w.intern('raid.pruefen', { name: v.name }); gestartet.push(v.name); } catch { /* nicht startbar */ }
  }
  await zustandAendern(w, (z) => { for (const n of gestartet) z.raid[n] = { gestartet: jetzt, ende: null, fehler: null }; z.letzte.raid = jetzt; return z; });
  return gestartet.length;
}

async function raidNachsehen(w) {
  const z = await zustandLaden(w);
  for (const [name, s] of Object.entries(z.raid)) {
    if (s.ende) continue;
    const md = await mdName(name);
    if (!md) { await zustandAendern(w, (zz) => { if (zz.raid[name]) Object.assign(zz.raid[name], { ende: Date.now(), fehler: null, text: 'Verbund nicht vorhanden' }); return zz; }); continue; }
    const aktion = (await lesen(path.join(p.sysBlock(), md, 'md', 'sync_action'))).trim();
    if (aktion && aktion !== 'idle') continue;
    const unstimmig = Number((await lesen(path.join(p.sysBlock(), md, 'md', 'mismatch_cnt'))).trim()) || 0;
    await zustandAendern(w, (zz) => { if (zz.raid[name]) Object.assign(zz.raid[name], { ende: Date.now(), fehler: unstimmig, text: unstimmig ? `${unstimmig} unstimmige Sektoren` : 'in Ordnung' }); return zz; });
    if (unstimmig) await melden(w, { art: 'platte', stufe: 'warnung', titel: `RAID „${name}“: Datenprüfung mit Abweichungen`, text: `Die monatliche Prüfung des Verbunds „${name}“ fand ${unstimmig} unstimmige Sektoren. Bitte die Plattengesundheit (S.M.A.R.T.) prüfen.`, schluessel: `raidpruefung_${name}_${s.gestartet}` });
  }
}

/** Ein Takt: fällige Prüfungen starten, laufende nachsehen. */
export async function taktPruefen(w, jetzt = new Date()) {
  const c = await laden(w);
  const z = await zustandLaden(w);
  for (const art of r.faellig(c.pruefungen, z.letzte, jetzt)) {
    if (art === 'raid') await raidStarten(w); else await smartStarten(w, art);
  }
  await smartNachsehen(w);
  await raidNachsehen(w);
}

// ---- Sicherheits-Check -----------------------------------------------------------------------------------------
const pwCache = { zeit: 0, stand: '', schwach: [] };
async function schwacheAnmeldungen(w, users) {
  const stand = JSON.stringify((users.nutzer || []).map((n) => [n.name, n.hash]));
  if (pwCache.stand === stand && Date.now() - pwCache.zeit < PW_TTL_MS) return pwCache.schwach;
  const schwach = [];
  for (const n of users.nutzer || []) {
    if (!n.hash || n.gesperrt) continue;
    for (const k of r.einfachePasswoerter(n.name)) { if (await totp.hashPruefen(k, n.hash)) { schwach.push(n.name); break; } }
  }
  Object.assign(pwCache, { zeit: Date.now(), stand, schwach });
  return schwach;
}

async function appGeheimnisse(w) {
  const apps = (w.pfade && w.pfade.apps) || PFADE.apps;
  const aus = [];
  let namen = [];
  try { namen = await fs.readdir(apps); } catch { return aus; }
  for (const name of namen) {
    const env = r.envLesen(await lesen(path.join(apps, name, '.env')));
    for (const [k, v] of Object.entries(env)) if (r.GEHEIM_SCHLUESSEL.test(k) && r.schwachesPasswort(v)) { aus.push({ app: name, feld: k }); break; }
  }
  return aus;
}

/**
 * Punkte für den Handlungsbedarf: [{id, stufe, schluessel, werte, ziel:[ansicht, …]}]; schluessel = dashboard.<schluessel>.
 */
export async function sicherheitPruefen(w) {
  const punkte = [];
  const neu = (id, stufe, schluessel, werte, ziel) => punkte.push({ id, stufe, schluessel, werte, ziel });
  const users = (await w.konfig.laden('users.json', null)) || {};
  for (const n of users.nutzer || []) if (n.rolle === 'admin' && !n.totp && !n.gesperrt) neu(`2fa-${n.name}`, 'warnung', 'sc_2fa', { name: n.name }, ['nutzer', 'ziel', n.name]);
  for (const name of await schwacheAnmeldungen(w, users)) neu(`pw-${name}`, 'fehler', 'sc_passwort', { name }, ['nutzer', 'ziel', name]);
  const shares = (w.pfade && w.pfade.shares) || PFADE.shares;
  for (const f of ((await w.konfig.laden('shares.json', null)) || {}).freigaben || []) {
    if (f.gaeste) neu(`gast-${f.name}`, 'hinweis', 'sc_gaeste', { name: f.name }, ['freigaben', 'ziel', f.name]);
    if (f.verschluesselt) {
      let offen = false;
      try { offen = String((await w.system.ausfuehren('findmnt', ['-n', '-o', 'TARGET', '--mountpoint', path.join(shares, f.name)], { erlaubteCodes: [0, 1] })).stdout).trim() !== ''; } catch { offen = false; }
      if (!offen) neu(`gesperrt-${f.name}`, 'hinweis', 'sc_gesperrt', { name: f.name }, ['freigaben', 'ziel', f.name]);
    }
  }
  const sys = (await w.konfig.laden('system.json', null)) || {};
  if (sys.ssh) {
    try { const res = await w.system.ausfuehren('sshd', ['-T'], { zeitlimit_ms: 10_000 }); if (/^passwordauthentication yes$/m.test(String(res.stdout))) neu('ssh', 'hinweis', 'sc_ssh', {}, ['system', 'dienste']); } catch { /* sshd fehlt */ }
  }
  // persönliche Ordner fast voll (≥ 90 % der Grenze)
  for (const n of users.nutzer || []) {
    if (!n.heim || !n.heim.aktiv || !n.heim.groesse_gb) continue;
    try {
      const k = await kontingentZeigen(w.system, heimPfad(w, n.name));
      const prozent = k.belegt != null ? Math.round((k.belegt / (n.heim.groesse_gb * 1024 ** 3)) * 100) : 0;
      if (prozent >= 90) neu(`heim-${n.name}`, 'warnung', 'sc_heim_voll', { name: n.name, prozent }, ['nutzer', 'ziel', n.name]);
    } catch { /* keine Quoten */ }
  }
  const c = await laden(w);
  if (!c.auto_updates.aktiv) neu('auto-updates', 'warnung', 'sc_auto_updates', {}, ['system', 'autoupdates']);
  for (const a of await appGeheimnisse(w)) neu(`app-pw-${a.app}`, 'warnung', 'sc_app', { app: a.app, feld: a.feld }, ['apps', 'ziel', a.app]);
  const st = await updateStatus(w);
  if (st.neustart_noetig) neu('neustart', 'hinweis', 'sc_neustart', {}, ['system', 'strom']);
  // Ergebnisse der automatischen Prüfungen
  const z = await zustandLaden(w);
  for (const [geraet, s] of Object.entries(z.smart)) if (s.ende && s.bestanden === false) neu(`selbsttest-${geraet}`, 'fehler', 'sc_selbsttest', { platte: s.modell ? `${s.modell} (${geraet})` : geraet }, ['system', 'pruefungen']);
  for (const [name, s] of Object.entries(z.raid)) if (s.ende && s.fehler) neu(`raidpruefung-${name}`, 'warnung', 'sc_raidpruefung', { name, n: s.fehler }, ['laufwerke', 'raid']);
  return punkte;
}

// ---- Registrierung ---------------------------------------------------------------------------------------------
const S_ZEIT = { typ: 'string', max: 5 };
export function registriere(reg, w) {
  reg.aktion('wartung.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Automatische Prüfungen und Updates: Einstellungen, letzte Ergebnisse, nächster Termin',
    ausfuehren: async () => {
      const c = await laden(w); const z = await zustandLaden(w);
      return { ...c, naechste_pruefung: r.naechsterTermin(c.pruefungen), smart: z.smart, raid: z.raid, letzte: z.letzte, updates: await updateStatus(w) };
    },
  });

  reg.aktion('wartung.speichern', {
    rolle: 'admin', beschreibung: 'Automatische Prüfungen und Updates einstellen',
    schema: {
      pruefungen: { typ: 'object', felder: { aktiv: { typ: 'boolean' }, tag: { typ: 'integer', min: 0, max: 6 }, zeit: S_ZEIT, smart_lang: { typ: 'boolean' }, raid: { typ: 'boolean' } } },
      auto_updates: { typ: 'object', felder: { aktiv: { typ: 'boolean' }, umfang: { typ: 'string', werte: ['sicherheit', 'alle'] }, zeit: S_ZEIT, neustart: { typ: 'boolean' }, neustart_zeit: S_ZEIT } },
    },
    ausfuehren: async (e) => {
      const alt = await laden(w);
      const neu = r.normal({ pruefungen: { ...alt.pruefungen, ...(e.pruefungen || {}) }, auto_updates: { ...alt.auto_updates, ...(e.auto_updates || {}) } }, { streng: true });
      if (JSON.stringify(neu.auto_updates) !== JSON.stringify(alt.auto_updates) || !(await w.konfig.laden(DATEI, null))) await autoUpdatesAnwenden(w, neu.auto_updates);
      await w.konfig.speichern(DATEI, neu);
      w.konfigGeaendert?.('wartung');
      return neu;
    },
  });

  reg.aktion('wartung.jetzt', {
    rolle: 'admin', beschreibung: 'Prüfung sofort starten (kurzer/gründlicher Selbsttest aller Platten, RAID-Datenprüfung)',
    schema: { art: { typ: 'string', pflicht: true, werte: ['smart_kurz', 'smart_lang', 'raid'] } },
    ausfuehren: async (e) => {
      const n = e.art === 'raid' ? await raidStarten(w) : await smartStarten(w, e.art);
      w.konfigGeaendert?.('wartung');
      if (!n) throw new FahnasFehler('E_PARAMS', e.art === 'raid' ? 'Kein Verbund, der jetzt geprüft werden kann' : 'Keine Platte hat den Selbsttest angenommen');
      return { gestartet: n };
    },
  });

  reg.aktion('wartung.sicherheit', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Sicherheits-Check für den Handlungsbedarf',
    ausfuehren: async () => sicherheitPruefen(w),
  });

  reg.aktion('wartung.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Automatische Updates ins System schreiben (Start, Import)',
    ausfuehren: async () => { if (!(await w.konfig.laden(DATEI, null))) return false; await autoUpdatesAnwenden(w, (await laden(w)).auto_updates); return true; },
  });
}

let takt = null;
export async function starten(w) {
  // Erster Start ohne wartung.json: Standard (Sicherheitsupdates automatisch) einmal ins System schreiben
  try { if (!(await w.konfig.laden(DATEI, null))) { const c = r.normal({}); await autoUpdatesAnwenden(w, c.auto_updates); await w.konfig.speichern(DATEI, c); } } catch (e) { process.stderr.write(`[wartung] Erststart: ${e.message}\n`); }
  takt = setInterval(() => { taktPruefen(w).catch((e) => process.stderr.write(`[wartung] ${e.message}\n`)); }, TAKT_MS);
  takt.unref?.();
}
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
export const _test = { pwCache, p };
