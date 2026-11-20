// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung – andere NAS per SMB (Betreiber 12.10.2026): Verbindungen laden, Freigaben eines anderen NAS nur für die
// Dauer eines Laufs einhängen (mount.cifs, Zugangsdaten in einer kurzlebigen 0600-Datei, nie auf der Befehlszeile),
// danach aushängen; Erreichbarkeit per TCP 445; Freigaben (smbclient -L) und Unterordner für die Ordnerwahl auflisten.

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { mountArgumente, mountFehlerDeuten, smbFreigabenParsen, zugangsdatei } from './regeln.js';

export const ZUGAENGE = 'spiegelung-zugaenge.json';
const UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
const PAKETE = Object.freeze({ 'mount.cifs': 'cifs-utils', smbclient: 'smbclient' });

export async function zugaengeLaden(w) {
  const d = await w.konfig.laden(ZUGAENGE, { version: 1, zugaenge: [] });
  return Array.isArray(d?.zugaenge) ? d.zugaenge : [];
}

export async function zugangHolen(w, id, liste = null) {
  const z = (liste || await zugaengeLaden(w)).find((x) => x.id === id);
  if (!z) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Verbindung zu einem anderen NAS gibt es nicht (mehr)', { feld: 'zugang' });
  return z;
}

/** Laufzeitordner für Einhängepunkte und Zugangsdateien. */
function laufzeit(w) { return path.join(w.pfade.run || '/run/fahnas', 'spiegelung'); }

/** cifs-utils/smbclient bei Bedarf per apt nachinstallieren. */
export async function paketSicherstellen(w, programm) {
  for (const ort of ['/usr/sbin', '/usr/bin', '/sbin', '/bin']) if (await w.system.existiert(path.join(ort, programm))) return;
  await w.system.ausfuehren('apt-get', ['install', '-y', '--no-install-recommends', PAKETE[programm]], {
    zeitlimit_ms: 10 * 60_000, umgebung: { ...UMGEBUNG, DEBIAN_FRONTEND: 'noninteractive' },
  });
}

/** Ist SMB (TCP 445) erreichbar? Kurzer Verbindungsversuch, nie werfen. */
export function erreichbar(adresse, { port = 445, zeitlimit_ms = 3000 } = {}) {
  return new Promise((fertig) => {
    const s = net.connect({ host: adresse.replace(/^\[|\]$/g, ''), port });
    const ende = (ok) => { try { s.destroy(); } catch { /* egal */ } fertig(ok); };
    s.setTimeout(zeitlimit_ms, () => ende(false));
    s.once('connect', () => ende(true));
    s.once('error', () => ende(false));
  });
}

/** Zugangsdatei (0600) schreiben, `arbeit(pfad)` ausführen, Datei sicher wieder löschen. */
async function mitZugangsdatei(w, z, arbeit) {
  const ordner = laufzeit(w);
  await fs.mkdir(ordner, { recursive: true, mode: 0o700 });
  const datei = path.join(ordner, `zugang-${crypto.randomBytes(6).toString('hex')}`);
  await fs.writeFile(datei, zugangsdatei(z), { mode: 0o600 });
  try { return await arbeit(datei); } finally { await fs.rm(datei, { force: true }); }
}

/** Nicht erreichbar → wie ein abgezogenes Laufwerk: übersprungen, später nachgeholt. */
export function fernNichtErreichbar(z) {
  return new FahnasFehler('E_NICHT_GEFUNDEN', `Das NAS „${z.name}“ (${z.adresse}) ist nicht erreichbar – der Lauf wird nachgeholt, sobald es wieder da ist`, { grund: 'nicht_eingehaengt', zugang: z.id });
}

/**
 * Freigabe eines anderen NAS einhängen. Gibt {pfad, aushaengen()} zurück. Wirft „nicht erreichbar“ (nachholen) oder
 * einen klaren Fehler für falsche Anmeldung / fehlende Freigabe.
 */
export async function einhaengen(w, z, freigabe, { name, nurLesen = false } = {}) {
  if (!await erreichbar(z.adresse)) throw fernNichtErreichbar(z);
  await paketSicherstellen(w, 'mount.cifs');
  const ziel = path.join(laufzeit(w), name || `blick-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(ziel, { recursive: true, mode: 0o700 });
  await aushaengenWennBelegt(w, ziel); // Rest eines abgebrochenen Laufs
  await mitZugangsdatei(w, z, async (datei) => {
    try {
      await w.system.ausfuehren('mount', mountArgumente({ adresse: z.adresse, freigabe, ziel, zugangsdatei: datei, nurLesen }), { zeitlimit_ms: 60_000 });
    } catch (e) {
      const f = FahnasFehler.aus(e);
      const d = mountFehlerDeuten(`${f.details?.ausgabe || ''} ${f.message}`);
      await aushaengenWennBelegt(w, ziel);
      try { await fs.rmdir(ziel); } catch { /* egal */ }
      if (d.art === 'nicht_erreichbar') throw fernNichtErreichbar(z);
      if (d.art === 'anmeldung') throw new FahnasFehler('E_RECHTE', `Anmeldung am NAS „${z.name}“ abgelehnt – Benutzer oder Passwort falsch`, { zugang: z.id });
      if (d.art === 'freigabe') throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die Freigabe „${freigabe}“ gibt es auf „${z.name}“ nicht`, { zugang: z.id, freigabe });
      throw new FahnasFehler('E_SYSTEM', `Freigabe „${freigabe}“ auf „${z.name}“ ließ sich nicht einhängen: ${d.text}`, { zugang: z.id });
    }
  });
  return { pfad: ziel, aushaengen: () => aushaengen(w, ziel) };
}

async function aushaengenWennBelegt(w, ziel) {
  try {
    const r = await w.system.ausfuehren('findmnt', ['-n', '-o', 'TARGET', '--', ziel], { erlaubteCodes: [0, 1], zeitlimit_ms: 10_000 });
    if (r.code === 0 && String(r.stdout).trim()) await aushaengen(w, ziel, false);
  } catch { /* nichts eingehängt */ }
}

/** Aushängen (notfalls „lazy“) und den leeren Einhängepunkt entfernen. Nie werfen. */
export async function aushaengen(w, ziel, ordnerWeg = true) {
  try { await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 60_000 }); } catch {
    try { await w.system.ausfuehren('umount', ['-l', ziel], { zeitlimit_ms: 30_000 }); } catch { /* war nicht eingehängt */ }
  }
  if (ordnerWeg) { try { await fs.rmdir(ziel); } catch { /* nicht leer oder weg */ } }
}

/** Freigaben eines anderen NAS auflisten (Verbindung prüfen). */
export async function freigabenListen(w, z) {
  if (!await erreichbar(z.adresse)) throw fernNichtErreichbar(z);
  await paketSicherstellen(w, 'smbclient');
  return mitZugangsdatei(w, z, async (datei) => {
    let r;
    try { r = await w.system.ausfuehren('smbclient', ['-L', `//${z.adresse}`, '-g', '-A', datei], { zeitlimit_ms: 30_000, erlaubteCodes: [0, 1] }); } catch (e) {
      throw new FahnasFehler('E_SYSTEM', `Verbindung zu „${z.name}“ fehlgeschlagen`, { ausgabe: FahnasFehler.aus(e).details?.ausgabe });
    }
    const text = `${r.stdout}\n${r.stderr}`;
    if (/LOGON_FAILURE|ACCESS_DENIED/i.test(text)) throw new FahnasFehler('E_RECHTE', `Anmeldung am NAS „${z.name}“ abgelehnt – Benutzer oder Passwort falsch`, { zugang: z.id });
    const freigaben = smbFreigabenParsen(r.stdout);
    if (r.code !== 0 && !freigaben.length) throw new FahnasFehler('E_SYSTEM', `Verbindung zu „${z.name}“ fehlgeschlagen: ${text.trim().split('\n').pop()}`.slice(0, 300), { zugang: z.id });
    return freigaben;
  });
}

/** Unterordner eines Pfads auf einem anderen NAS (kurz nur lesend eingehängt). Versteckte und Systemordner bleiben weg. */
export async function ordnerListen(w, z, freigabe, rel) {
  const e = await einhaengen(w, z, freigabe, { nurLesen: true });
  try {
    const wurzel = e.pfad;
    const voll = rel ? path.join(wurzel, rel) : wurzel;
    if (voll !== wurzel && !voll.startsWith(wurzel + '/')) throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
    let eintraege;
    let echt;
    try { echt = await fs.realpath(voll); } catch { throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Ordner gibt es auf dem anderen NAS nicht', { feld: 'pfad' }); }
    const echteWurzel = await fs.realpath(wurzel);
    if (echt !== echteWurzel && !echt.startsWith(echteWurzel + '/')) throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
    try { eintraege = await fs.readdir(echt, { withFileTypes: true }); } catch { throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Ordner gibt es auf dem anderen NAS nicht', { feld: 'pfad' }); }
    return eintraege.filter((x) => x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('@') && !x.name.startsWith('#')).map((x) => x.name).sort((a, b) => a.localeCompare(b, 'de'));
  } finally { await e.aushaengen(); }
}

/** Neuen Ordner auf einem anderen NAS anlegen (kurz beschreibbar eingehängt). Gibt es ihn schon, ist das ein Fehler. */
export async function ordnerAnlegenFern(w, z, freigabe, rel, name) {
  const e = await einhaengen(w, z, freigabe);
  try {
    const wurzel = e.pfad;
    const eltern = rel ? path.join(wurzel, rel) : wurzel;
    const neu = path.join(eltern, name);
    if (!neu.startsWith(wurzel + '/')) throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
    let echt;
    try { echt = await fs.realpath(eltern); } catch { throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Ordner gibt es auf dem anderen NAS nicht', { feld: 'pfad' }); }
    // Symlinks auf dem anderen NAS (SMB-Unix-Erweiterungen) dürfen nicht aus dem Einhängepunkt hinausführen – mkdir läuft als root
    const echteWurzel = await fs.realpath(wurzel);
    if (echt !== echteWurzel && !echt.startsWith(echteWurzel + '/')) throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
    try { await fs.mkdir(path.join(echt, name)); } catch (err) {
      if (err.code === 'EEXIST') throw new FahnasFehler('E_EXISTIERT', `Einen Ordner „${name}“ gibt es dort schon`, { feld: 'name' });
      if (err.code === 'EACCES' || err.code === 'EPERM') throw new FahnasFehler('E_RECHTE', `Auf „${z.name}“ darf dieser Benutzer hier keinen Ordner anlegen`, { feld: 'name' });
      throw new FahnasFehler('E_SYSTEM', `Ordner ließ sich nicht anlegen: ${err.message}`, { feld: 'name' });
    }
    // Zeitfenster realpath → mkdir: liegt der neue Ordner doch außerhalb, wieder entfernen (leer, eben angelegt)
    const danach = await fs.realpath(path.join(echt, name)).catch(() => null);
    if (!danach || !danach.startsWith(echteWurzel + '/')) {
      try { await fs.rmdir(path.join(echt, name)); } catch { /* weg */ }
      throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
    }
  } finally { await e.aushaengen(); }
}
