// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „laufwerke.*“: externe USB-/SATA-Laufwerke erkennen, einhängen (NTFS/exFAT/vfat/ext/btrfs/xfs/hfs+),
// sicher auswerfen, formatieren, S.M.A.R.T. lesen und auf Wunsch als Netzfreigabe anbieten. Die Systemplatte
// (FAHNAS-SYSTEM/FAHNAS-DATEN) ist nie anfassbar. Der Zustand steht in laufwerke.json; laufwerke.apply hängt
// bekannte Geräte beim Start ein und startet die Überwachung (udev + 15-s-Abgleich). Alle Systembefehle laufen
// über werkzeuge.system (Argumentlisten, keine Shell) und sind im Test ersetzbar.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { geraeteLesen, nameVorschlag, NAME_MUSTER } from '../laufwerke/erkennen.js';
import { einhaengeVersuche, istPosix } from '../laufwerke/einhaengen.js';
import * as ueberwachung from '../laufwerke/ueberwachung.js';
import { ansichtenLoesen } from './protokolle.js';

const DATEI = 'laufwerke.json';
const GRUPPE_NUTZER = 'fahnas-nutzer';
const LSBLK_SPALTEN = 'NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,PARTUUID,MODEL,SERIAL,TRAN,RM,RO,MOUNTPOINT,PKNAME,PARTN,FSAVAIL,FSUSED';
const SMART_ALLE_CODES = Object.freeze([...Array(256).keys()]);
const GERAET_MUSTER = /^\/dev\/[a-zA-Z0-9/_-]+$/;

function pfadeVon(w) { return w.pfade || PFADE; }

// ---------------------------------------------------------------------------------------------------------------
// laufwerke.json (Zustand)
// ---------------------------------------------------------------------------------------------------------------
function normieren(d) { return { geraete: Array.isArray(d?.geraete) ? d.geraete : [] }; }
async function ladenKonfig(w) { return normieren(await w.konfig.laden(DATEI, { geraete: [] })); }
async function aendernKonfig(w, fn) {
  return w.konfig.aendern(DATEI, async (roh) => { const d = normieren(roh); await fn(d); return d; }, { geraete: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// Erkennung + Zustand zusammenführen
// ---------------------------------------------------------------------------------------------------------------
/** Alle erkannten Geräte (lsblk + geraeteLesen); auch für den Speicherort der Freigaben (freigaben.js). */
export async function lsblkRoh(system) {
  let json;
  try {
    const r = await system.ausfuehren('lsblk', ['-J', '-b', '-o', LSBLK_SPALTEN]);
    json = JSON.parse(r.stdout || '{}');
  } catch (e) {
    throw new FahnasFehler('E_SYSTEM', 'Die Laufwerke konnten nicht gelesen werden', { befehl: 'lsblk', ausgabe: e.details?.ausgabe || e.message });
  }
  return geraeteLesen(json);
}

/** Alle erkannten Laufwerke, angereichert mit dem gespeicherten Zustand (bekannt/automatisch/freigabe/Name). */
export async function geraeteMitZustand(w) {
  const roh = await lsblkRoh(w.system);
  const konf = await ladenKonfig(w);
  return roh.map((g) => {
    const bek = g.kennung ? konf.geraete.find((x) => x.kennung === g.kennung) : null;
    return {
      ...g,
      bekannt: !!bek,
      automatisch: bek ? bek.automatisch !== false : false,
      freigabe: bek ? !!bek.freigabe : false,
      name: bek?.name || null,
      nur_lesen: bek ? !!(bek.optionen && bek.optionen.nur_lesen) : false,
    };
  });
}

/** Die von der Oberfläche erwartete, schlanke Sicht je Gerät. */
function ansicht(g, freigaben = []) {
  const f = g.name ? freigaben.find((x) => x.extern && x.name === g.name) : null;
  return {
    pfad: g.pfad, kennung: g.kennung, name: g.name, fs: g.fs, label: g.label, modell: g.modell,
    groesse: g.groesse, belegt: g.belegt, frei: g.frei, eingehaengt: g.eingehaengt, einhaengepunkt: g.einhaengepunkt,
    system: g.system, tran: g.tran, bekannt: g.bekannt, automatisch: g.automatisch, freigabe: g.freigabe, nur_lesen: g.nur_lesen, platte: g.platte || null,
    // Freigabe ohne Berechtigte (und ohne Gäste): Samba schaltet sie ab (leeres „valid users“ hieße „jeder“) – Oberfläche warnt
    freigabe_ohne_rechte: !!f && !f.gaeste && !(f.lesen || []).length && !(f.schreiben || []).length,
  };
}

/**
 * Rechte für eine vom Admin eingeschaltete Laufwerks-Freigabe: der Admin selbst darf schreiben – ohne Berechtigte schaltet
 * Samba die Freigabe ab (Betreiber-Fund 26.09.). Nur echte FAH-NAS-Nutzer (nicht „system“, nicht Konsolenaufrufe).
 */
async function freigabeRechte(w, kontext) {
  if (!kontext || !kontext.nutzer || kontext.rolle === 'system') return {};
  const nutzer = (await w.konfig.laden('users.json'))?.nutzer || [];
  return nutzer.some((n) => n.name === kontext.nutzer) ? { schreiben: [kontext.nutzer] } : {};
}

// ---------------------------------------------------------------------------------------------------------------
// Einhängen / Aushängen (Kern, auch von apply/Überwachung genutzt)
// ---------------------------------------------------------------------------------------------------------------
/** GID der Gruppe fahnas-nutzer über getent (im Test ersetzbar); 0, wenn unbekannt. */
async function gidNutzer(system) {
  try {
    const r = await system.ausfuehren('getent', ['group', GRUPPE_NUTZER], { erlaubteCodes: [0, 2] });
    const t = String(r.stdout).trim().split('\n')[0].split(':');
    const gid = Number(t[2]);
    return Number.isInteger(gid) ? gid : 0;
  } catch { return 0; }
}

/** Hängt ein erkanntes Gerät nach shares/<name> ein (mit Rückfall ntfs3→ntfs-3g). Gibt den Einhängepunkt zurück. */
async function geraetEinhaengen(w, g, { name, nur_lesen }) {
  const { system } = w;
  const ziel = path.join(pfadeVon(w).shares, name);
  const gid = await gidNutzer(system);
  const versuche = einhaengeVersuche(g.fs, g.pfad, ziel, { gid, nur_lesen });
  if (!versuche.length) throw new FahnasFehler('E_PARAMS', `Das Dateisystem „${g.fs || 'unbekannt'}“ kann nicht eingehängt werden`, { feld: 'pfad' });
  await fs.mkdir(ziel, { recursive: true, mode: 0o755 });
  let letzter = null; let ok = false;
  for (const args of versuche) {
    try { await system.ausfuehren(args[0], args.slice(1)); ok = true; break; }
    catch (e) { letzter = e; }
  }
  if (!ok) {
    try { await fs.rmdir(ziel); } catch { /* nicht leer oder Einhängepunkt einer früheren Freigabe – belassen */ }
    throw new FahnasFehler('E_SYSTEM', 'Das Laufwerk konnte nicht eingehängt werden', { befehl: versuche[versuche.length - 1].join(' '), ausgabe: letzter?.details?.ausgabe || letzter?.message });
  }
  if (istPosix(g.fs) && !nur_lesen) {
    // Rechte-Rundgang nur bei POSIX-Dateisystemen (die anderen bekommen ihre Rechte aus den Einhängeoptionen)
    try {
      await system.ausfuehren('chown', [`root:${GRUPPE_NUTZER}`, ziel]);
      await system.ausfuehren('chmod', ['2770', ziel]);
    } catch (e) { process.stderr.write(`[laufwerke] Rechte auf ${ziel} nicht gesetzt: ${e.message}\n`); }
  }
  return ziel;
}

/** Der zugehörige Plattenpfad (für power-off): /dev/sdb1 → /dev/sdb, /dev/nvme0n1p2 → /dev/nvme0n1. */
function plattenName(basis) {
  const b = path.basename(basis);
  if (/^nvme\d+n\d+p\d+$/.test(b)) return b.replace(/p\d+$/, '');
  if (/^mmcblk\d+p\d+$/.test(b)) return b.replace(/p\d+$/, '');
  return b.replace(/\d+$/, '');
}

/** Strom abschalten: udisksctl power-off, Rückfall /sys/block/<x>/device/delete. */
async function stromAbschalten(system, plattePfad) {
  try { await system.ausfuehren('udisksctl', ['power-off', '-b', plattePfad], { erlaubteCodes: [0, 1] }); return true; }
  catch { /* Rückfall */ }
  try { await fs.writeFile(`/sys/block/${plattenName(plattePfad)}/device/delete`, '1'); return true; }
  catch (e) { process.stderr.write(`[laufwerke] Strom abschalten fehlgeschlagen: ${e.message}\n`); return false; }
}

/** Hängt alle bekannten, angeschlossenen Geräte mit automatisch:true ein und rendert danach Samba neu. */
export async function bekannteEinhaengen(w) {
  // erst tote Einhängungen weg – sonst landete ein wieder angestecktes Laufwerk auf dem toten Einhängepunkt (gestapelt)
  await verwaisteAushaengen(w);
  const konf = await ladenKonfig(w);
  const geraete = await geraeteMitZustand(w);
  const eingehaengt = []; const fehler = [];
  for (const e of konf.geraete) {
    if (e.automatisch === false) continue;
    const g = geraete.find((x) => x.kennung === e.kennung);
    if (!g || g.system || g.eingehaengt || !g.fs) continue;
    try {
      await geraetEinhaengen(w, g, { name: e.name, nur_lesen: !!(e.optionen && e.optionen.nur_lesen) });
      eingehaengt.push(e.name);
    } catch (err) { fehler.push({ name: e.name, meldung: err.message }); }
  }
  if (eingehaengt.length) { try { await w.intern('freigaben.apply', {}); } catch (e) { process.stderr.write(`[laufwerke] Samba nach Auto-Einhängen: ${e.message}\n`); } }
  return { eingehaengt, fehler };
}

/** findmnt -r maskiert Leer- und Sonderzeichen als \xNN. */
export function findmntText(s) { return String(s).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }

/**
 * Verwaiste Einhängungen aufräumen (Betreiber-Fund 09.10., /data/shares/256gb): Wird ein Laufwerk ohne „Aushängen“
 * abgezogen, bleibt sein Einhängepunkt <Freigaben>/<name> stehen – das Gerät ist weg, der Kernel hält das tote
 * Dateisystem fest, Samba bietet die Freigabe weiter an. Jede Einhängung direkt unter dem Freigaben-Ordner, deren
 * Quellgerät lsblk nicht mehr kennt und dessen Gerätedatei fehlt, wird lazy ausgehängt (umount -l – ein normales umount scheitert an einem toten Gerät
 * oft); danach rendert freigaben.apply Samba neu (available = no). Liefert lsblk nichts (Lesefehler), passiert nichts.
 * @returns {Promise<string[]>} ausgehängte Einhängepunkte
 */
export async function verwaisteAushaengen(w) {
  const shares = pfadeVon(w).shares.replace(/\/+$/, '');
  let geraete; let r;
  try { geraete = await lsblkRoh(w.system); } catch { return []; }
  if (!geraete.length) return [];
  try { r = await w.system.ausfuehren('findmnt', ['-rn', '-o', 'TARGET,SOURCE'], { erlaubteCodes: [0, 1] }); } catch { return []; }
  const vorhanden = new Set(geraete.map((g) => g.pfad));
  const ausgehaengt = [];
  for (const zeile of String(r.stdout || '').split('\n')) {
    const [zielRoh, quelleRoh] = zeile.trim().split(/\s+/);
    if (!zielRoh || !quelleRoh) continue;
    const ziel = findmntText(zielRoh);
    const name = ziel.startsWith(`${shares}/`) ? ziel.slice(shares.length + 1) : '';
    if (!name || name.includes('/')) continue; // nur Einhängepunkte direkt unter dem Freigaben-Ordner
    const quelle = findmntText(quelleRoh).replace(/\[.*\]$/, '');
    if (!GERAET_MUSTER.test(quelle) || vorhanden.has(quelle)) continue; // nur Block-Geräte, die lsblk nicht mehr kennt …
    try { if ((await w.system.ausfuehren('test', ['-b', quelle], { erlaubteCodes: [0, 1] })).code === 0) continue; } catch { continue; } // … und deren Gerätedatei weg ist (z. B. /dev/mapper/… führt lsblk hier nicht)
    try {
      await ansichtenLoesen(w, ziel);
      await w.system.ausfuehren('umount', ['-l', ziel]);
      ausgehaengt.push(ziel);
      melde(w, 'ausgehaengt', { pfad: quelle, name, grund: 'abgezogen' });
      process.stderr.write(`[laufwerke] ${quelle} wurde ohne Aushängen abgezogen – ${ziel} ausgehängt\n`);
    } catch (e) { process.stderr.write(`[laufwerke] tote Einhängung ${ziel} ließ sich nicht aushängen: ${e.message}\n`); }
  }
  if (ausgehaengt.length) { try { await w.intern('freigaben.apply', {}); } catch (e) { process.stderr.write(`[laufwerke] Samba nach dem Aufräumen: ${e.message}\n`); } }
  return ausgehaengt;
}

// ---------------------------------------------------------------------------------------------------------------
// Überwachung (udev + 15-s-Abgleich)
// ---------------------------------------------------------------------------------------------------------------
let letzteKennungen = null;
export const _test = {
  abgleichZuruecksetzen() { letzteKennungen = null; },
  ueberwachungStoppen() { ueberwachung.stoppen(); },
};

/** Vergleicht die aktuell angeschlossenen Geräte mit dem letzten Stand, meldet Ereignisse, hängt Bekanntes ein. */
export async function abgleich(w) {
  const geraete = await geraeteMitZustand(w);
  const jetzt = new Set(geraete.filter((g) => !g.system && g.kennung).map((g) => g.kennung));
  if (letzteKennungen) {
    for (const g of geraete) {
      if (g.system || !g.kennung || letzteKennungen.has(g.kennung)) continue;
      melde(w, 'angesteckt', { pfad: g.pfad, kennung: g.kennung, fs: g.fs, label: g.label, name: g.name });
    }
    for (const k of letzteKennungen) if (!jetzt.has(k)) melde(w, 'entfernt', { kennung: k });
  }
  letzteKennungen = jetzt;
  return bekannteEinhaengen(w);
}

function melde(w, zustand, geraet) {
  try { w.ereignis?.('system', { art: 'laufwerk', zustand, geraet }); } catch { /* nie werfen */ }
}

async function aufUdevEreignis(w, ev) {
  if (ev.aktion === 'add' || ev.aktion === 'change') { melde(w, 'angesteckt', { name: ev.geraet }); await bekannteEinhaengen(w); }
  else if (ev.aktion === 'remove') { melde(w, 'entfernt', { name: ev.geraet }); await verwaisteAushaengen(w); }
}

function ueberwachungStarten(w) {
  ueberwachung.starten({ system: w.system, aufEreignis: (ev) => aufUdevEreignis(w, ev), abgleich: () => abgleich(w) });
}

// ---------------------------------------------------------------------------------------------------------------
// S.M.A.R.T. (kleine eigene Auswertung – kein Import aus system.js)
// ---------------------------------------------------------------------------------------------------------------
export function smartAuswerten(geraet, json, code = 0, modell = null) {
  const aus = { geraet, modell, temperatur: null, zustand: 'ok', stunden: null, details: {} };
  if (!json || typeof json !== 'object') { aus.zustand = 'unbekannt'; aus.details.hinweis = 'S.M.A.R.T. nicht lesbar'; return aus; }
  if (json.model_name) aus.modell = json.model_name;
  if (json.serial_number) aus.details.seriennummer = json.serial_number;
  if (Number.isFinite(json.temperature?.current)) aus.temperatur = json.temperature.current;
  if (Number.isFinite(json.power_on_time?.hours)) aus.stunden = json.power_on_time.hours;
  const nvme = json.nvme_smart_health_information_log;
  const gruende = [];
  const oeffnenFehlgeschlagen = (code & 0b110) !== 0 && !json.smart_status;
  if (oeffnenFehlgeschlagen || (!json.smart_status && !nvme && !json.ata_smart_attributes)) {
    aus.zustand = 'unbekannt'; aus.details.hinweis = 'Keine S.M.A.R.T.-Werte: der USB-Adapter gibt sie nicht weiter'; return aus; // kein Schadenshinweis → keine Warnung
  }
  if (json.smart_status && json.smart_status.passed === false) gruende.push('Selbstprüfung der Platte meldet FEHLER');
  if (code & 0b1000) gruende.push('Platte fällt aus (smartctl Bit 3)');
  if (code & 0b10000) gruende.push('Vorwarn-Attribut unter Schwelle (smartctl Bit 4)');
  if (nvme) {
    aus.details.typ = 'nvme';
    if (Number.isFinite(nvme.percentage_used)) { aus.details.verbraucht_prozent = nvme.percentage_used; if (nvme.percentage_used >= 90) gruende.push(`Lebensdauer zu ${nvme.percentage_used} % verbraucht`); }
    if (Number.isFinite(nvme.media_errors) && nvme.media_errors > 0) gruende.push(`${nvme.media_errors} Medienfehler`);
    if (nvme.critical_warning) gruende.push(`Kritische Warnung der NVMe (${nvme.critical_warning})`);
    if (Number.isFinite(nvme.temperature) && aus.temperatur === null) aus.temperatur = nvme.temperature;
  }
  const tabelle = json.ata_smart_attributes?.table;
  if (Array.isArray(tabelle)) {
    aus.details.typ = aus.details.typ || 'sata';
    const kritisch = { 5: 'Reallocated_Sector_Ct', 197: 'Current_Pending_Sector', 198: 'Offline_Uncorrectable' };
    for (const a of tabelle) {
      if (!a || !(a.id in kritisch)) continue;
      const roh = Number(a.raw?.value ?? 0);
      aus.details[kritisch[a.id].toLowerCase()] = roh;
      if (roh > 0) gruende.push(`${a.name || kritisch[a.id]} = ${roh}`);
    }
  }
  if (json.smart_status && json.smart_status.passed === false || (code & 0b1000)) aus.zustand = 'fehler';
  else if (gruende.length) aus.zustand = 'warnung';
  if (gruende.length) aus.details.gruende = gruende;
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Formatieren
// ---------------------------------------------------------------------------------------------------------------
function mkfsBefehl(fs, label, pfad) {
  switch (fs) {
    case 'exfat': return ['mkfs.exfat', '-n', label, pfad];
    case 'ext4': return ['mkfs.ext4', '-F', '-L', label, pfad];
    case 'btrfs': return ['mkfs.btrfs', '-f', '-L', label, pfad];
    case 'ntfs': return ['mkntfs', '-f', '-L', label, pfad];
    default: throw new FahnasFehler('E_PARAMS', 'Unbekanntes Dateisystem', { feld: 'fs' });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------------------------------------------
export function registriere(reg, werkzeuge) {
  reg.aktion('laufwerke.liste', {
    rolle: 'nutzer', schema: {}, beschreibung: 'Angeschlossene Laufwerke (Systemplatte grau, externe nutzbar)',
    ausfuehren: async (_p, _k, w) => {
      const freigaben = (await w.konfig.laden('shares.json'))?.freigaben || [];
      return (await geraeteMitZustand(w)).map((g) => ansicht(g, freigaben));
    },
  });

  reg.aktion('laufwerke.einhaengen', {
    rolle: 'admin', beschreibung: 'Ein externes Laufwerk einhängen (und auf Wunsch als Freigabe anbieten)',
    schema: {
      pfad: { typ: 'string', pflicht: true, max: 256, muster: GERAET_MUSTER, hinweis: 'Gerätepfad wie /dev/sdb1' },
      name: { typ: 'string', max: 32, muster: NAME_MUSTER, hinweis: 'Name: klein, 1–32 Zeichen aus a-z, 0-9, - und _' },
      nur_lesen: { typ: 'boolean', standard: false },
      automatisch: { typ: 'boolean', standard: true },
      freigabe: { typ: 'boolean', standard: false },
    },
    ausfuehren: async (p, k, w) => {
      const geraete = await geraeteMitZustand(w);
      const g = geraete.find((x) => x.pfad === p.pfad);
      if (!g) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Laufwerk gibt es nicht (mehr)', { feld: 'pfad' });
      if (g.system) throw new FahnasFehler('E_RECHTE', 'Das gehört zur Systemplatte und darf nicht angefasst werden', { feld: 'pfad' });
      if (!g.fs) throw new FahnasFehler('E_PARAMS', 'Auf diesem Laufwerk ist kein bekanntes Dateisystem – bitte erst formatieren', { feld: 'pfad' });
      if (g.eingehaengt) throw new FahnasFehler('E_BELEGT', 'Das Laufwerk ist schon eingehängt', { feld: 'pfad', einhaengepunkt: g.einhaengepunkt });
      if (!g.kennung) throw new FahnasFehler('E_SYSTEM', 'Das Laufwerk hat keine stabile Kennung (UUID/Seriennummer) – Einhängen nicht möglich', { feld: 'pfad' });

      const shares = await w.konfig.laden('shares.json');
      const belegt = new Set((shares?.freigaben || []).map((f) => f.name));
      const konf = await ladenKonfig(w);
      for (const e of konf.geraete) if (e.name && e.kennung !== g.kennung) belegt.add(e.name);
      const eigenerName = konf.geraete.find((e) => e.kennung === g.kennung)?.name;
      let name = p.name || eigenerName || g.name || nameVorschlag(g, belegt);
      if (!NAME_MUSTER.test(name)) throw new FahnasFehler('E_PARAMS', 'Der Name ist ungültig', { feld: 'name' });
      if (belegt.has(name) && name !== eigenerName) throw new FahnasFehler('E_EXISTIERT', `Der Name „${name}“ ist schon vergeben`, { feld: 'name' });

      const ziel = await geraetEinhaengen(w, g, { name, nur_lesen: p.nur_lesen });
      await aendernKonfig(w, (d) => {
        d.geraete = d.geraete.filter((e) => e.kennung !== g.kennung);
        d.geraete.push({ kennung: g.kennung, name, fs: g.fs, label: g.label, modell: g.modell, groesse: g.groesse, automatisch: p.automatisch !== false, freigabe: !!p.freigabe, optionen: { nur_lesen: !!p.nur_lesen }, zuletzt: new Date().toISOString() });
      });
      let freigabeAngelegt = false;
      if (p.freigabe) {
        try { await w.intern('freigaben.anlegen', { name, beschreibung: `Externes Laufwerk (${g.label || g.fs || 'Laufwerk'})`, extern: true, pfad: ziel, ...(await freigabeRechte(w, k)) }); freigabeAngelegt = true; }
        catch (e) { if (!(e instanceof FahnasFehler && e.code === 'E_EXISTIERT')) throw e; freigabeAngelegt = true; }
      }
      // Bestehende Freigabe dieses Laufwerks: Samba neu schreiben – sie war ohne Einhängung abgeschaltet (available=no)
      const bestehend = ((await w.konfig.laden('shares.json'))?.freigaben || []).some((f) => f.extern && f.name === name);
      if (bestehend) { try { await w.intern('freigaben.apply', {}); } catch (e) { process.stderr.write(`[laufwerke] Samba nach Einhängen: ${e.message}\n`); } }
      w.konfigGeaendert?.('laufwerke');
      if (freigabeAngelegt) w.konfigGeaendert?.('freigaben');
      melde(w, 'eingehaengt', { pfad: g.pfad, kennung: g.kennung, name, einhaengepunkt: ziel });
      return { kennung: g.kennung, name, pfad: g.pfad, einhaengepunkt: ziel, fs: g.fs, nur_lesen: !!p.nur_lesen, automatisch: p.automatisch !== false, freigabe: freigabeAngelegt };
    },
  });

  reg.aktion('laufwerke.aushaengen', {
    rolle: 'admin', beschreibung: 'Ein Laufwerk sicher auswerfen (mit „vergessen“ auch abschalten)',
    schema: { kennung: { typ: 'string', pflicht: true, max: 200 }, vergessen: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, _k, w) => {
      const geraete = await geraeteMitZustand(w);
      const g = geraete.find((x) => x.kennung === p.kennung);
      const konf = await ladenKonfig(w);
      const eintrag = konf.geraete.find((e) => e.kennung === p.kennung);
      if (!g && !eintrag) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Laufwerk ist nicht bekannt', { feld: 'kennung' });
      if (g && g.system) throw new FahnasFehler('E_RECHTE', 'Die Systemplatte lässt sich nicht auswerfen', { feld: 'kennung' });
      const name = eintrag?.name || g?.name || null;
      const ziel = g?.einhaengepunkt || (name ? path.join(pfadeVon(w).shares, name) : null);
      const shares = await w.konfig.laden('shares.json');
      const share = name ? (shares?.freigaben || []).find((f) => f.extern && f.name === name) : null;

      if (g && g.eingehaengt && ziel) {
        if (share) { try { await w.system.ausfuehren('smbcontrol', ['all', 'close-share', name], { erlaubteCodes: [0, 1, 255] }); } catch { /* smbd evtl. aus */ } }
        try { await w.system.ausfuehren('sync', []); } catch { /* egal */ }
        await ansichtenLoesen(w, ziel); // SFTP/WebDAV/DLNA-Ansichten halten das Dateisystem sonst weiter fest
        try {
          await w.system.ausfuehren('umount', [ziel]);
        } catch (e) {
          const aus = String(e?.details?.ausgabe || e?.message || '');
          if (/busy|EBUSY/i.test(aus) || e?.details?.code === 32) {
            let prozesse = '';
            try { const r = await w.system.ausfuehren('fuser', ['-vm', ziel], { erlaubteCodes: [0, 1] }); prozesse = `${r.stdout || ''}${r.stderr || ''}`.trim(); } catch { /* fuser fehlt */ }
            throw new FahnasFehler('E_BELEGT', 'Das Laufwerk ist noch in Benutzung – bitte offene Dateien/Programme schließen', { name, prozesse: prozesse.slice(0, 2000) });
          }
          throw new FahnasFehler('E_SYSTEM', 'Das Laufwerk konnte nicht ausgehängt werden', { befehl: `umount ${ziel}`, ausgabe: aus });
        }
      }
      // Freigabe bleibt in shares.json; Samba neu rendern → available=no (Renderer prüft findmnt)
      if (share) { try { await w.intern('freigaben.apply', {}); } catch (e) { process.stderr.write(`[laufwerke] Samba nach Aushängen: ${e.message}\n`); } }
      if (p.vergessen) {
        await aendernKonfig(w, (d) => { d.geraete = d.geraete.filter((e) => e.kennung !== p.kennung); });
        if (g && g.platte) await stromAbschalten(w.system, g.platte);
      }
      w.konfigGeaendert?.('laufwerke');
      melde(w, 'entfernt', { kennung: p.kennung, name });
      return { kennung: p.kennung, name, ausgehaengt: true, vergessen: !!p.vergessen };
    },
  });

  reg.aktion('laufwerke.aendern', {
    rolle: 'admin', beschreibung: 'Einstellungen eines bekannten Laufwerks ändern (Auto-Einhängen, Freigabe, nur lesen)',
    schema: { kennung: { typ: 'string', pflicht: true, max: 200 }, automatisch: { typ: 'boolean' }, freigabe: { typ: 'boolean' }, nur_lesen: { typ: 'boolean' } },
    ausfuehren: async (p, k, w) => {
      const vorher = (await ladenKonfig(w)).geraete.find((x) => x.kennung === p.kennung);
      if (!vorher) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Laufwerk ist nicht bekannt', { feld: 'kennung' });
      const neu = await aendernKonfig(w, (d) => {
        const t = d.geraete.find((x) => x.kennung === p.kennung);
        if (!t) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Laufwerk ist nicht bekannt', { feld: 'kennung' });
        if (p.automatisch !== undefined) t.automatisch = p.automatisch;
        if (p.freigabe !== undefined) t.freigabe = p.freigabe;
        if (p.nur_lesen !== undefined) t.optionen = { ...(t.optionen || {}), nur_lesen: p.nur_lesen };
      });
      const t = neu.geraete.find((x) => x.kennung === p.kennung);
      // Freigabe an/aus (nur wenn sich der Wunsch geändert hat)
      if (p.freigabe !== undefined && p.freigabe !== !!vorher.freigabe) {
        const shares = await w.konfig.laden('shares.json');
        const vorhanden = (shares?.freigaben || []).some((f) => f.extern && f.name === t.name);
        if (p.freigabe && !vorhanden) {
          const g = (await geraeteMitZustand(w)).find((x) => x.kennung === p.kennung);
          if (g && g.eingehaengt) {
            try { await w.intern('freigaben.anlegen', { name: t.name, beschreibung: 'Externes Laufwerk', extern: true, pfad: path.join(pfadeVon(w).shares, t.name), ...(await freigabeRechte(w, k)) }); w.konfigGeaendert?.('freigaben'); }
            catch (e) { if (!(e instanceof FahnasFehler && e.code === 'E_EXISTIERT')) throw e; }
          }
        } else if (!p.freigabe && vorhanden) {
          try { await w.intern('freigaben.loeschen', { name: t.name, daten: 'behalten' }); w.konfigGeaendert?.('freigaben'); }
          catch (e) { process.stderr.write(`[laufwerke] Freigabe entfernen: ${e.message}\n`); }
        }
      }
      w.konfigGeaendert?.('laufwerke');
      return { kennung: p.kennung, name: t.name, automatisch: t.automatisch !== false, freigabe: !!t.freigabe, nur_lesen: !!(t.optionen && t.optionen.nur_lesen) };
    },
  });

  reg.aktion('laufwerke.formatieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Ein Laufwerk formatieren – alle Daten darauf gehen verloren',
    schema: {
      pfad: { typ: 'string', pflicht: true, max: 256, muster: GERAET_MUSTER, hinweis: 'Gerätepfad wie /dev/sdb1' },
      fs: { typ: 'string', pflicht: true, werte: ['exfat', 'ext4', 'btrfs', 'ntfs'] },
      label: { typ: 'string', pflicht: true, min: 1, max: 32, muster: /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/, hinweis: 'Bezeichnung: Buchstaben, Ziffern, Leerzeichen, - und _' },
      bestaetigung: { typ: 'string', pflicht: true, max: 256, hinweis: 'Zur Sicherheit den Gerätepfad noch einmal eintippen' },
    },
    ausfuehren: async (p, _k, w, aufgabe) => {
      if (p.bestaetigung !== p.pfad) throw new FahnasFehler('E_PARAMS', 'Zur Sicherheit den angezeigten Gerätepfad genau so eintippen', { feld: 'bestaetigung' });
      const g = (await geraeteMitZustand(w)).find((x) => x.pfad === p.pfad);
      if (!g) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Laufwerk gibt es nicht (mehr)', { feld: 'pfad' });
      if (g.system) throw new FahnasFehler('E_RECHTE', 'Die Systemplatte wird nicht formatiert', { feld: 'pfad' });
      if (g.eingehaengt) throw new FahnasFehler('E_BELEGT', 'Das Laufwerk ist eingehängt – bitte erst auswerfen', { feld: 'pfad', einhaengepunkt: g.einhaengepunkt });
      aufgabe?.fortschritt(0.1, `Dateisystem ${p.fs} wird angelegt`);
      const befehl = mkfsBefehl(p.fs, p.label, p.pfad);
      try { await w.system.ausfuehren(befehl[0], befehl.slice(1), { zeitlimit_ms: 600_000 }); }
      catch (e) { throw new FahnasFehler('E_SYSTEM', 'Das Formatieren ist fehlgeschlagen', { befehl: befehl.join(' '), ausgabe: e.details?.ausgabe || e.message }); }
      if (g.kennung) await aendernKonfig(w, (d) => { d.geraete = d.geraete.filter((e) => e.kennung !== g.kennung); }); // neue UUID → alter Eintrag ist hinfällig
      aufgabe?.fortschritt(1, 'Fertig');
      w.konfigGeaendert?.('laufwerke');
      return { pfad: p.pfad, fs: p.fs, label: p.label, formatiert: true };
    },
  });

  reg.aktion('laufwerke.smart', {
    rolle: 'admin', beschreibung: 'S.M.A.R.T.-Zustand eines Laufwerks',
    schema: { pfad: { typ: 'string', pflicht: true, max: 256, muster: GERAET_MUSTER } },
    ausfuehren: async (p, _k, w) => {
      const g = (await geraeteMitZustand(w)).find((x) => x.pfad === p.pfad);
      const ziel = g?.platte || p.pfad; // S.M.A.R.T. sitzt auf der Platte, nicht auf der Partition
      let json = null; let code = 0;
      try {
        const r = await w.system.ausfuehren('smartctl', ['-j', '-H', '-A', ziel], { erlaubteCodes: SMART_ALLE_CODES });
        code = r.code; try { json = JSON.parse(r.stdout); } catch { json = null; }
      } catch (e) {
        return { geraet: ziel, modell: g?.modell || null, temperatur: null, zustand: 'warnung', stunden: null, details: { hinweis: 'smartctl nicht ausführbar', ausgabe: e.details?.ausgabe || e.message } };
      }
      return smartAuswerten(ziel, json, code, g?.modell || null);
    },
  });

  reg.aktion('laufwerke.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Bekannte Laufwerke einhängen und die Überwachung starten (beim Agent-Start)',
    ausfuehren: async (_p, _k, w) => {
      const r = await bekannteEinhaengen(w);
      try { ueberwachungStarten(w); } catch (e) { process.stderr.write(`[laufwerke] Überwachung nicht gestartet: ${e.message}\n`); }
      return { eingehaengt: r.eingehaengt, fehler: r.fehler, ueberwachung: ueberwachung.laeuft() };
    },
  });
}
