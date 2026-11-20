// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „hardware.*“ (Betreiber 19.10.2026): Gehäuse-LEDs und Lüfter auf UGREEN-DXP-Geräten. Läuft nur, wenn das
// Gehäuse erkannt wird (DMI) – auf anderen Rechnern bleibt der Bereich still. LEDs: Betrieb an, Netz an bei Verbindung
// und blinkt bei Verkehr, Schacht-LEDs an bei vorhandener Platte, blinken bei Zugriff, rot bei RAID-Fehler. Lüfter: Kurve
// aus CPU-, Platten- und NVMe-Temperatur (Modi Leise/Normal/Leistung) oder BIOS; Mindestdrehzahl, 100 % bei unlesbarer
// CPU-Temperatur oder stehendem Lüfter (mit Meldung), Rückgabe an das BIOS beim Beenden (auch nach Absturz: ExecStopPost
// ruft src/agent/hardware/luefter-bios.js). Einstellungen in hardware.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import * as u from '../hardware/ugreen.js';

const DATEI = 'hardware.json';
const LED_TAKT_MS = 300;
const LUEFTER_TAKT_MS = 5000;
const NACHLAUF_MS = 700;      // Zugriff/Verkehr gilt so lange nach dem letzten Zählerwechsel als „aktiv“ (kein Flackern der Befehle)
const STILLSTAND_TAKTE = 3;   // so viele Lüfter-Takte ohne Drehzahl bei Tastgrad ≥ Minimum → Alarm
export const STANDARD = Object.freeze({ leds: { an: true, helligkeit: 25, aktivitaet: true }, luefter: { modus: 'normal' }, watchdog: { schutz: false } });
export const WATCHDOG_UNIT = 'fahnas-watchdog.service';
// Schutz bei Systemhänger: systemd bedient den Hardware-Watchdog (RuntimeWatchdogSec); hängt das System, startet er neu
export const WATCHDOG_CONF = '[Manager]\nRuntimeWatchdogSec=3min\nRebootWatchdogSec=10min\n';

/** Pfade (für Tests ersetzbar). */
export const quellen = {
  dmi: '/sys/class/dmi/id/product_name', sysBlock: '/sys/block', sysNet: '/sys/class/net', hwmon: '/sys/class/hwmon',
  i2c: '/sys/class/i2c-dev', route: '/proc/net/route', lockdown: '/sys/kernel/security/lockdown', port: '/dev/port',
  bios: () => path.join(process.env.FAHNAS_RUN || PFADE.run, 'luefter-bios.json'),
  watchdog: '/sys/class/watchdog', systemConfD: () => process.env.FAHNAS_SYSTEMD_CONF_D || '/etc/systemd/system.conf.d',
};

const z = {
  modell: null, start: null,
  leds: { verfuegbar: false, grund: null, bus: null, gesendet: {}, letzte: {}, aktivBis: {}, netz: { bytes: null, aktivBis: 0 } },
  luefter: { verfuegbar: false, grund: null, io: null, ec: null, basis: null, kanaele: [], bios: {}, duty: {}, rpm: {}, still: {}, gemeldet: false, temps: null, eigen: false },
  watchdog: { treiber: null, unit: null, grund: null },
  einstellungen: structuredClone(STANDARD), timerLed: null, timerLuefter: null, laeuft: { led: false, luefter: false },
};

async function einstellungenLaden(w) {
  const d = await w.konfig.laden(DATEI, null).catch(() => null);
  return {
    leds: { ...STANDARD.leds, ...(d?.leds || {}) },
    luefter: { ...STANDARD.luefter, ...(d?.luefter || {}) },
    watchdog: { ...STANDARD.watchdog, ...(d?.watchdog || {}) },
  };
}

// ---- Watchdog ----------------------------------------------------------------------------------------------------------
// Der Super-I/O der DXP-Gehäuse hat einen Hardware-Watchdog, den das BIOS starten kann (unter UGOS aktiv, 178 s). Früh im
// Start übernimmt ihn fahnas-watchdog.service (tools/watchdog_halten.py): Treiber it87_wdt laden – dann hält ihn der
// Kernel am Leben – oder, wenn der Treiber den Chip nicht kennt, im Chip ausschalten. Optional bedient ihn systemd
// („Schutz bei Systemhänger“): hängt das System drei Minuten lang, startet der Watchdog es neu.

/** Vom Treiber it87_wdt geführter Watchdog: {geraet, zustand, sekunden} oder null. */
export async function watchdogLesen(wurzel = quellen.watchdog) {
  for (const n of (await fs.readdir(wurzel).catch(() => [])).filter((x) => /^watchdog\d+$/.test(x)).sort()) {
    if ((await zahlLesen(path.join(wurzel, n, 'identity'))) !== 'IT87 WDT') continue;
    return { geraet: n, zustand: (await zahlLesen(path.join(wurzel, n, 'state'))) || null, sekunden: Number(await zahlLesen(path.join(wurzel, n, 'timeout'))) || null };
  }
  return null;
}

/** Start-Unit aktiv halten (Systeme, die vor 0.25.1 installiert wurden, haben sie noch nicht aktiviert). */
async function watchdogUnitPruefen(w) {
  try {
    const r = await w.system.ausfuehren('systemctl', ['is-enabled', WATCHDOG_UNIT], { erlaubteCodes: [0, 1], zeitlimit_ms: 10_000 });
    if (String(r.stdout).trim() !== 'enabled') await w.system.ausfuehren('systemctl', ['enable', WATCHDOG_UNIT], { zeitlimit_ms: 20_000 });
    z.watchdog.unit = true;
  } catch (e) { z.watchdog.unit = false; z.watchdog.grund = `Start-Unit: ${e.message}`; }
}

/** Schutz bei Systemhänger an/aus: system.conf.d schreiben oder entfernen, systemd neu einlesen (nur bei Änderung). */
async function watchdogSchutzAngleichen(w, an) {
  const datei = path.join(quellen.systemConfD(), 'fahnas-watchdog.conf');
  const ist = await fs.readFile(datei, 'utf8').catch(() => null);
  if (an && ist === WATCHDOG_CONF) return false;
  if (!an && ist === null) return false;
  if (an) { await fs.mkdir(path.dirname(datei), { recursive: true }); await fs.writeFile(datei, WATCHDOG_CONF, { mode: 0o644 }); } else await fs.rm(datei, { force: true });
  await w.system.ausfuehren('systemctl', ['daemon-reexec'], { zeitlimit_ms: 60_000 });
  return true;
}

// ---- LEDs --------------------------------------------------------------------------------------------------------------
async function ledsVorbereiten(w) {
  try { await w.system.ausfuehren('modprobe', ['i2c-dev'], { erlaubteCodes: [0, 1] }); } catch { /* ohne modprobe */ }
  try { await paketeSicherstellen(w.system, ['i2c-tools'], { zweck: 'die Gehäuse-LEDs' }); } catch (e) { z.leds.grund = FahnasFehler.aus(e).message; return; }
  const bus = await u.i2cBusFinden(quellen.i2c);
  if (bus === null) { z.leds.grund = 'SMBus-Adapter (I801) nicht gefunden'; return; }
  try {
    const r = await w.system.ausfuehren('i2cget', ['-y', String(bus), '0x3a', '0x81', 'i', '11'], { zeitlimit_ms: 5000 });
    if (!u.ledStatusLesen(u.i2cAusgabeLesen(r.stdout))) { z.leds.grund = 'LED-Controller antwortet nicht wie erwartet'; return; }
  } catch (e) { z.leds.grund = `LED-Controller nicht erreichbar (${FahnasFehler.aus(e).message})`; return; }
  z.leds.bus = bus; z.leds.verfuegbar = true; z.leds.grund = null;
}

async function ledSenden(w, name, soll) {
  const id = u.ledNummer(name);
  for (const bytes of u.ledBefehle(id, soll)) {
    await w.system.ausfuehren('i2cset', ['-y', String(z.leds.bus), '0x3a', `0x${id.toString(16).padStart(2, '0')}`, ...bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`), 'i'], { zeitlimit_ms: 3000 });
  }
}

async function zahlLesen(datei) { return String(await fs.readFile(datei, 'utf8').catch(() => '')).trim(); }

/** Gerätezustand für die LEDs: Platten je Schacht (vorhanden/aktiv/fehler), Netz (verbunden/Verkehr). */
async function geraeteZustand(jetzt) {
  const schaechte = Array.from({ length: z.modell.platten }, () => null);
  let namen = [];
  try { namen = (await fs.readdir(quellen.sysBlock)).filter((n) => /^sd[a-z]+$/.test(n)); } catch { /* kein /sys */ }
  // RAID-Fehler: Mitglied „faulty“ in /sys/block/mdX/md/dev-*/state
  const defekt = new Set();
  for (const md of (await fs.readdir(quellen.sysBlock).catch(() => [])).filter((n) => /^md\d+$/.test(n))) {
    for (const d of (await fs.readdir(path.join(quellen.sysBlock, md, 'md')).catch(() => [])).filter((x) => x.startsWith('dev-'))) {
      if (/faulty/.test(await zahlLesen(path.join(quellen.sysBlock, md, 'md', d, 'state')))) defekt.add(d.slice(4).replace(/\d+$/, ''));
    }
  }
  for (const n of namen) {
    const schacht = await u.schachtVon(n, quellen.sysBlock);
    if (!schacht || schacht > schaechte.length) continue;
    const t = (await zahlLesen(path.join(quellen.sysBlock, n, 'stat'))).split(/\s+/);
    const zaehler = `${t[2]}:${t[6]}`; // gelesene/geschriebene Sektoren
    if (z.leds.letzte[n] !== undefined && z.leds.letzte[n] !== zaehler) z.leds.aktivBis[n] = jetzt + NACHLAUF_MS;
    z.leds.letzte[n] = zaehler;
    schaechte[schacht - 1] = { vorhanden: true, aktiv: (z.leds.aktivBis[n] || 0) > jetzt, fehler: defekt.has(n) };
  }
  // Netz: Schnittstelle der Standardroute
  let iface = null;
  for (const zeile of (await zahlLesen(quellen.route)).split('\n').slice(1)) { const s = zeile.trim().split(/\s+/); if (s[1] === '00000000') { iface = s[0]; break; } }
  let verbunden = false;
  if (iface) {
    verbunden = (await zahlLesen(path.join(quellen.sysNet, iface, 'carrier'))) === '1';
    const bytes = Number(await zahlLesen(path.join(quellen.sysNet, iface, 'statistics', 'rx_bytes'))) + Number(await zahlLesen(path.join(quellen.sysNet, iface, 'statistics', 'tx_bytes')));
    if (z.leds.netz.bytes !== null && bytes - z.leds.netz.bytes > 4096) z.leds.netz.aktivBis = jetzt + NACHLAUF_MS;
    z.leds.netz.bytes = bytes;
  }
  return { netz: { verbunden, verkehr: z.leds.netz.aktivBis > jetzt }, platten: schaechte };
}

export async function ledTakt(w, jetzt = Date.now()) {
  if (!z.leds.verfuegbar || z.laeuft.led) return;
  z.laeuft.led = true;
  try {
    const soll = u.ledSoll(await geraeteZustand(jetzt), z.einstellungen.leds);
    for (const [name, s] of Object.entries(soll)) {
      const text = JSON.stringify(s);
      if (z.leds.gesendet[name] === text) continue;
      await ledSenden(w, name, s);
      z.leds.gesendet[name] = text;
    }
  } catch (e) { process.stderr.write(`[hardware] LEDs: ${e.message}\n`); } finally { z.laeuft.led = false; }
}

// ---- Lüfter ------------------------------------------------------------------------------------------------------------
async function luefterVorbereiten(w, ioFabrik = u.devPort) {
  if (await u.lockdownAktiv(quellen.lockdown)) { z.luefter.grund = 'Secure Boot (Kernel-Lockdown) sperrt den direkten Zugriff auf den Lüfter-Chip – das BIOS regelt'; return; }
  try { await w.system.ausfuehren('modprobe', ['drivetemp'], { erlaubteCodes: [0, 1] }); } catch { /* ohne Plattentemperatur */ }
  let io;
  try { io = ioFabrik(quellen.port); } catch (e) { z.luefter.grund = `Kein Zugriff auf /dev/port (${e.message})`; return; }
  const chip = u.superIoFinden(io);
  if (!chip) { io.schliessen(); z.luefter.grund = 'Lüfter-Chip IT8613E nicht gefunden'; return; }
  const e = u.ec(io, chip.basis);
  u.sechzehnBit(e);
  const kanaele = [];
  for (let i = 0; i < 5; i++) if (u.drehzahl(e, i) > 0) kanaele.push(i);
  if (!kanaele.length) { io.schliessen(); z.luefter.grund = 'Kein drehender Lüfter am Chip gefunden'; return; }
  // BIOS-Zustand sichern – nur wenn noch keiner gesichert ist (nach einem Neustart des Dienstes gilt der erste)
  let bios = null;
  try { bios = JSON.parse(await fs.readFile(quellen.bios(), 'utf8')); } catch { /* erster Start */ }
  if (!bios || bios.basis !== chip.basis) {
    bios = { basis: chip.basis, kanaele: Object.fromEntries(kanaele.map((i) => [i, u.pwmLesen(e, i)])) };
    await fs.mkdir(path.dirname(quellen.bios()), { recursive: true });
    await fs.writeFile(quellen.bios(), JSON.stringify(bios), { mode: 0o600 });
  }
  Object.assign(z.luefter, { io, ec: e, basis: chip.basis, kanaele, bios: bios.kanaele, verfuegbar: true, grund: null });
}

function luefterZurueck() {
  const l = z.luefter;
  if (!l.ec || !l.eigen) return;
  for (const i of l.kanaele) { const alt = l.bios[i]; if (alt) { try { u.pwmZurueck(l.ec, i, alt); } catch { /* weiter */ } } }
  l.eigen = false;
}

export async function luefterTakt(w) {
  const l = z.luefter;
  if (!l.verfuegbar || z.laeuft.luefter) return;
  z.laeuft.luefter = true;
  try {
    l.temps = await u.temperaturen(quellen.hwmon);
    const modus = z.einstellungen.luefter.modus;
    for (const i of l.kanaele) l.rpm[i] = u.drehzahl(l.ec, i);
    if (modus === 'bios') { luefterZurueck(); for (const i of l.kanaele) l.duty[i] = u.pwmLesen(l.ec, i).duty; return; }
    let alarm = false;
    for (const i of l.kanaele) {
      let ziel = u.zielTastgrad(l.temps, modus, l.duty[i]);
      l.still[i] = l.duty[i] >= u.MIN_TASTGRAD && l.rpm[i] === 0 ? (l.still[i] || 0) + 1 : 0;
      if (l.still[i] >= STILLSTAND_TAKTE) { ziel = 255; alarm = true; }
      u.pwmSetzen(l.ec, i, ziel);
      l.duty[i] = ziel; l.eigen = true;
    }
    if (alarm && !l.gemeldet) {
      l.gemeldet = true;
      await w.intern('benachrichtigungen.senden', { art: 'system', stufe: 'fehler', titel: 'Gehäuselüfter steht', text: `Der Lüfter des ${z.modell.name} dreht nicht, obwohl er angesteuert wird. FAH-NAS hat ihn auf 100 % gestellt – bitte den Lüfter prüfen.`, schluessel: `luefter_steht_${Date.now()}` }).catch(() => {});
    } else if (!alarm) l.gemeldet = false;
  } catch (e) {
    process.stderr.write(`[hardware] Lüfter: ${e.message}\n`);
  } finally { z.laeuft.luefter = false; }
}

// ---- Start / Stopp ---------------------------------------------------------------------------------------------------
export async function starten(w, { ioFabrik } = {}) {
  const produkt = String(await fs.readFile(quellen.dmi, 'utf8').catch(() => '')).trim();
  z.modell = u.modellVon(produkt);
  if (!z.modell) return; // kein UGREEN-Gehäuse – Bereich bleibt still
  z.start = new Date().toISOString();
  z.einstellungen = await einstellungenLaden(w);
  await watchdogUnitPruefen(w);
  z.watchdog.treiber = await watchdogLesen();
  if (z.watchdog.treiber) { try { await watchdogSchutzAngleichen(w, !!z.einstellungen.watchdog.schutz); } catch (e) { z.watchdog.grund = e.message; } }
  // Lüfter zuerst (Sicherheit), LEDs danach – i2c-tools kann eine Paketinstallation brauchen und darf den Start nicht aufhalten
  await luefterVorbereiten(w, ioFabrik);
  if (z.luefter.verfuegbar) { await luefterTakt(w); z.timerLuefter = setInterval(() => { luefterTakt(w).catch(() => {}); }, LUEFTER_TAKT_MS); z.timerLuefter.unref?.(); }
  z.ledsBereit = ledsVorbereiten(w).then(() => {
    if (z.leds.verfuegbar && z.modell) { z.timerLed = setInterval(() => { ledTakt(w).catch(() => {}); }, LED_TAKT_MS); z.timerLed.unref?.(); }
  }).catch((e) => { z.leds.grund = e.message; });
}

export function stoppen() {
  clearInterval(z.timerLed); clearInterval(z.timerLuefter); z.timerLed = null; z.timerLuefter = null;
  luefterZurueck();
  if (z.luefter.io) z.luefter.io.schliessen();
  z.luefter = { ...z.luefter, io: null, ec: null, verfuegbar: false };
}

function status() {
  const l = z.luefter;
  return {
    modell: z.modell ? z.modell.name : null,
    leds: { verfuegbar: z.leds.verfuegbar, grund: z.leds.grund, ...z.einstellungen.leds },
    luefter: {
      verfuegbar: l.verfuegbar, grund: l.grund, modus: z.einstellungen.luefter.modus,
      kanaele: l.kanaele.map((i) => ({ nr: i + 1, rpm: l.rpm[i] ?? null, prozent: l.duty[i] === undefined ? null : Math.round((l.duty[i] / 255) * 100), steht: (l.still[i] || 0) >= STILLSTAND_TAKTE })),
      temperaturen: l.temps,
    },
    watchdog: {
      verfuegbar: !!z.watchdog.treiber, zustand: z.watchdog.treiber?.zustand || null, sekunden: z.watchdog.treiber?.sekunden || null,
      start_unit: z.watchdog.unit, grund: z.watchdog.grund, schutz: !!z.einstellungen.watchdog.schutz,
    },
  };
}

export function registriere(reg, w) {
  reg.aktion('hardware.status', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Gehäuse: Modell, LEDs, Lüfter (Drehzahl, Tastgrad, Temperaturen)',
    ausfuehren: async () => status(),
  });
  reg.aktion('hardware.einstellen', {
    rolle: 'admin',
    schema: {
      leds: { typ: 'object', felder: { an: { typ: 'boolean' }, helligkeit: { typ: 'integer', min: 2, max: 100 }, aktivitaet: { typ: 'boolean' } } },
      luefter: { typ: 'object', felder: { modus: { typ: 'string', werte: ['bios', 'leise', 'normal', 'leistung'] } } },
      watchdog: { typ: 'object', felder: { schutz: { typ: 'boolean' } } },
    },
    beschreibung: 'Gehäuse-LEDs (an, Helligkeit, Blinken bei Zugriff), Lüftermodus und Watchdog-Schutz einstellen',
    ausfuehren: async (p) => {
      if (!z.modell) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Kein unterstütztes UGREEN-Gehäuse erkannt', { feld: 'leds' });
      if (p.watchdog?.schutz && !z.watchdog.treiber) throw new FahnasFehler('E_PARAMS', 'Der Watchdog-Treiber kennt den Chip nicht – der Watchdog ist ausgeschaltet, Schutz bei Systemhänger geht hier nicht', { feld: 'watchdog' });
      await w.konfig.aendern(DATEI, (d) => ({
        leds: { ...STANDARD.leds, ...(d?.leds || {}), ...(p.leds || {}) },
        luefter: { ...STANDARD.luefter, ...(d?.luefter || {}), ...(p.luefter || {}) },
        watchdog: { ...STANDARD.watchdog, ...(d?.watchdog || {}), ...(p.watchdog || {}) },
      }), null);
      z.einstellungen = await einstellungenLaden(w);
      z.leds.gesendet = {}; // alles neu senden
      if (z.luefter.verfuegbar) await luefterTakt(w);
      if (p.watchdog && z.watchdog.treiber) { await watchdogSchutzAngleichen(w, !!z.einstellungen.watchdog.schutz); z.watchdog.treiber = await watchdogLesen(); }
      w.konfigGeaendert?.('hardware');
      return status();
    },
  });
}

export const _test = { z, status, quellen };
