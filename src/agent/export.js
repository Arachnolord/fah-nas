// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Export und Import der Konfiguration (/data/config) als tar-Archiv, wahlweise ohne Geheimnisse (Passwort-Hashes,
// TOTP, Wiederherstellungscodes) und wahlweise verschlüsselt (AES-256-GCM, Schlüssel per scrypt aus dem Passwort).
// Dateiformat verschlüsselt: "FAHNAS1" + Salz(16) + IV(12) + Tag(16) + Daten  →  Endung .tar.fahnas

import fs from 'node:fs/promises';
import fsSync, { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { FahnasFehler } from '../gemeinsam/fehler.js';
import { SCHEMA_VERSION, MODUS } from '../gemeinsam/konfig.js';

export const MAGIC = Buffer.from('FAHNAS1', 'ascii');
const SALZ_LAENGE = 16;
const IV_LAENGE = 12;
const TAG_LAENGE = 16;
export const KOPF_LAENGE = MAGIC.length + SALZ_LAENGE + IV_LAENGE + TAG_LAENGE; // 51 Byte
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const EXPORT_MAX_ALTER_MS = 60 * 60 * 1000; // Exporte im Eingang leben höchstens eine Stunde

/** Dateien/Ordner, die NIE in den Export gehen (Sitzungen, Anmeldebremse, der Eingang selbst, die Aufgabenliste). */
export const AUSSCHLUSS = Object.freeze(['web/sitzungen.json', 'web/bremse.json', 'eingang', 'aufgaben.json', 'benachrichtigungen-persoenlich.json', 'web/turn.json']);
/**
 * Zusätzlich ohne Geheimnisse ausgeschlossen: der TLS-Schlüssel des Web-Dienstes, die Samba-Passwortdatenbank
 * (passdb.tdb = NT-Hashes, secrets.tdb = SID) und die Download-Tokens (links.json).
 */
export const AUSSCHLUSS_OHNE_GEHEIMNISSE = Object.freeze(['web/tls', 'samba', 'links.json', 'chat.json']);
/** Was der Import übernimmt (niemals web/ oder protokoll/). */
export const IMPORT_DATEIEN = Object.freeze(['system.json', 'users.json', 'shares.json', 'snapshots.json', 'links.json', 'remote.json']);
export const IMPORT_ORDNER = Object.freeze(['apps', 'vms', 'avatare']); // avatare: Nutzerbilder (0.22.0), passend zu users.json

function schluessel(passwort, salz) {
  return new Promise((ok, nein) => {
    crypto.scrypt(Buffer.from(String(passwort), 'utf8'), salz, 32, SCRYPT, (e, k) => (e ? nein(e) : ok(k)));
  });
}

function pruefePasswort(passwort) {
  if (typeof passwort !== 'string' || passwort.length < 8) {
    throw new FahnasFehler('E_PARAMS', 'Das Passwort für den Export muss mindestens 8 Zeichen haben', { feld: 'passwort' });
  }
}

/** Entfernt Geheimnisse aus users.json-Daten (Hash, TOTP, Wiederherstellungscodes). */
export function bereinigeNutzer(users) {
  const kopie = structuredClone(users ?? { nutzer: [], gruppen: [] });
  if (Array.isArray(kopie.nutzer)) {
    kopie.nutzer = kopie.nutzer.map((n) => {
      const { hash, totp, wiederherstellung, wiederherstellungscodes, ...rest } = n ?? {}; // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  return kopie;
}

/** Verschlüsselt eine Datei (streamend). Tag wird nach dem Durchlauf an seine Stelle im Kopf geschrieben. */
export async function verschluesseln(quelle, ziel, passwort) {
  pruefePasswort(passwort);
  const salz = crypto.randomBytes(SALZ_LAENGE);
  const iv = crypto.randomBytes(IV_LAENGE);
  const k = await schluessel(passwort, salz);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  // 1. Kopf mit Platzhalter für den Tag, 2. Daten streamend dahinter, 3. Tag an seine Stelle im Kopf
  await fs.writeFile(ziel, Buffer.concat([MAGIC, salz, iv, Buffer.alloc(TAG_LAENGE)]), { mode: 0o600 });
  await pipeline(createReadStream(quelle), cipher, createWriteStream(ziel, { flags: 'r+', start: KOPF_LAENGE }));
  const fh = await fs.open(ziel, 'r+');
  try {
    await fh.write(cipher.getAuthTag(), 0, TAG_LAENGE, MAGIC.length + SALZ_LAENGE + IV_LAENGE);
    await fh.sync();
  } finally { await fh.close(); }
}

/** Entschlüsselt eine .tar.fahnas-Datei. Falsches Passwort oder Manipulation → E_PARAMS. */
export async function entschluesseln(quelle, ziel, passwort) {
  if (typeof passwort !== 'string' || !passwort) throw new FahnasFehler('E_PARAMS', 'Die Datei ist verschlüsselt – bitte Passwort angeben', { feld: 'passwort' });
  const fh = await fs.open(quelle, 'r');
  let kopf;
  try {
    kopf = Buffer.alloc(KOPF_LAENGE);
    const { bytesRead } = await fh.read(kopf, 0, KOPF_LAENGE, 0);
    if (bytesRead < KOPF_LAENGE || !kopf.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new FahnasFehler('E_PARAMS', 'Das ist keine verschlüsselte FAH-NAS-Exportdatei', { feld: 'datei' });
    }
  } finally { await fh.close(); }
  const salz = kopf.subarray(MAGIC.length, MAGIC.length + SALZ_LAENGE);
  const iv = kopf.subarray(MAGIC.length + SALZ_LAENGE, MAGIC.length + SALZ_LAENGE + IV_LAENGE);
  const tag = kopf.subarray(MAGIC.length + SALZ_LAENGE + IV_LAENGE, KOPF_LAENGE);
  const k = await schluessel(passwort, salz);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(quelle, { start: KOPF_LAENGE }), decipher, createWriteStream(ziel, { mode: 0o600 }));
  } catch (e) {
    try { await fs.unlink(ziel); } catch { /* egal */ }
    if (/auth|unable|unsupported state/i.test(String(e.message))) {
      throw new FahnasFehler('E_PARAMS', 'Passwort falsch oder Datei beschädigt', { feld: 'passwort' });
    }
    throw FahnasFehler.aus(e);
  }
}

/** Löscht Dateien im Eingang, die älter als maxAlter sind (Exporte und liegen gebliebene Importe). */
export async function aufraeumen(eingang, maxAlter_ms = EXPORT_MAX_ALTER_MS, jetzt = Date.now()) {
  let namen = [];
  try { namen = await fs.readdir(eingang); } catch { return []; }
  const weg = [];
  for (const n of namen) {
    const p = path.join(eingang, n);
    try {
      const st = await fs.lstat(p);
      if (!st.isFile()) continue;
      if (jetzt - st.mtimeMs > maxAlter_ms) { await fs.unlink(p); weg.push(n); }
    } catch { /* egal */ }
  }
  return weg;
}

function zeitstempel(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Erzeugt den Export.
 * @param {{konfigOrdner:string, mit_geheimnissen?:boolean, passwort?:string, system:object, hostname?:string, eingang?:string}} o
 * @returns {Promise<{pfad:string, dateiname:string, groesse:number, verschluesselt:boolean}>}
 */
export async function exportErzeugen(o) {
  const { konfigOrdner, system } = o;
  const mit = o.mit_geheimnissen === true;
  const passwort = o.passwort ? String(o.passwort) : '';
  if (passwort) pruefePasswort(passwort);
  const eingang = o.eingang || path.join(konfigOrdner, 'eingang');
  await fs.mkdir(eingang, { recursive: true, mode: 0o750 });
  await aufraeumen(eingang);
  const zeit = zeitstempel();
  const hostname = (o.hostname || os.hostname()).split('.')[0].replace(/[^a-zA-Z0-9-]/g, '') || 'fahnas';
  const tar = path.join(eingang, `export-${zeit}-${crypto.randomBytes(3).toString('hex')}.tar`);

  let quelle = konfigOrdner;
  let tmp = null;
  const ausschluss = [...AUSSCHLUSS];
  try {
    if (!mit) {
      // bereinigte Kopie in einem Zwischenordner: users.json ohne Hash/TOTP/Wiederherstellung, kein TLS-Schlüssel
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-export-'));
      const ohne = new Set([...AUSSCHLUSS, ...AUSSCHLUSS_OHNE_GEHEIMNISSE].map((r) => path.join(konfigOrdner, r)));
      await fs.cp(konfigOrdner, tmp, {
        recursive: true, force: true, preserveTimestamps: true, dereference: false,
        filter: (src) => {
          const rel = path.relative(konfigOrdner, src);
          if (rel === '') return true;
          for (const a of ohne) if (src === a || src.startsWith(a + path.sep)) return false;
          return !rel.endsWith('.tmp');
        },
      });
      let users = { nutzer: [], gruppen: [] };
      try { users = JSON.parse(await fs.readFile(path.join(konfigOrdner, 'users.json'), 'utf8')); } catch { /* fehlt oder leer */ }
      await fs.writeFile(path.join(tmp, 'users.json'), JSON.stringify(bereinigeNutzer(users), null, 2) + '\n', { mode: 0o600 });
      quelle = tmp;
    }
    try {
      await system.ausfuehren('tar', ['-C', quelle, ...ausschluss.map((a) => `--exclude=${a}`), '-cf', tar, '.']);
    } catch (e) {
      try { await fs.unlink(tar); } catch { /* egal */ }
      throw new FahnasFehler('E_SYSTEM', 'Export-Archiv konnte nicht erstellt werden', { befehl: 'tar', ausgabe: e.details?.ausgabe || e.message });
    }
    await fs.chmod(tar, 0o600);
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  }

  let pfad = tar;
  if (passwort) {
    pfad = `${tar}.fahnas`;
    try { await verschluesseln(tar, pfad, passwort); } finally { await fs.unlink(tar).catch(() => {}); }
  }
  const st = await fs.stat(pfad);
  const dateiname = `fahnas-export-${hostname}-${zeit.slice(0, 8)}.tar${passwort ? '.fahnas' : ''}`;
  return { pfad, dateiname, groesse: st.size, verschluesselt: !!passwort };
}

async function jsonOderNull(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new FahnasFehler('E_KONFIG', `${path.basename(p)} im Archiv ist beschädigt`, { datei: path.basename(p) });
  }
}

let tarGnu = null;
/** GNU tar kennt --no-overwrite-dir, bsdtar (macOS, Tests) nicht – einmal ermitteln. */
async function tarIstGnu(system) {
  if (tarGnu !== null) return tarGnu;
  try { const r = await system.ausfuehren('tar', ['--version'], { erlaubteCodes: [0, 1] }); tarGnu = /GNU tar/i.test(String(r.stdout)); } catch { tarGnu = false; }
  return tarGnu;
}
export const _test = { tarErkennungZuruecksetzen() { tarGnu = null; } };

/**
 * Prüft die Mitgliederliste eines Archivs, BEVOR etwas entpackt wird: nur Dateien und Ordner (Typzeichen `-`/`d`),
 * keine Symlinks (`l`), keine Hardlinks (`h`), keine Geräte/Pipes, keine `..`-Bestandteile, keine absoluten Namen.
 * Sonst könnte z. B. `apps -> /etc` als root nach /data/config gelangen (und später Schreibzugriffe umleiten).
 * `ausfuehrlich` = Ausgabe von `tar -tvf`, `namen` = Ausgabe von `tar -tf`.
 */
export function archivMitgliederPruefen(ausfuehrlich, namen) {
  const gruende = [];
  for (const zeile of String(ausfuehrlich ?? '').split('\n')) {
    if (!zeile.trim()) continue;
    const typ = zeile[0];
    if (typ === '-' || typ === 'd') continue;
    if (typ === 'l') gruende.push(`Symbolische Verknüpfung: ${zeile.trim().slice(0, 200)}`);
    else if (typ === 'h') gruende.push(`Harte Verknüpfung: ${zeile.trim().slice(0, 200)}`);
    else gruende.push(`Unerlaubter Eintragstyp „${typ}“: ${zeile.trim().slice(0, 200)}`);
  }
  for (const n of String(namen ?? '').split('\n')) {
    if (!n) continue;
    if (n.startsWith('/')) gruende.push(`Absoluter Pfad im Archiv: ${n.slice(0, 200)}`);
    else if (n.split('/').some((t) => t === '..')) gruende.push(`Pfad führt aus dem Archiv hinaus: ${n.slice(0, 200)}`);
  }
  if (gruende.length) {
    throw new FahnasFehler('E_PARAMS', 'Das Archiv enthält Verknüpfungen oder unerlaubte Pfade und wird nicht übernommen', { feld: 'datei', gruende: gruende.slice(0, 20) });
  }
}

/** Geht einen Baum mit lstat durch; alles außer regulären Dateien und Ordnern ist ein Fehler (E_PARAMS). */
export async function baumNurDateienUndOrdner(wurzel) {
  const st = await fs.lstat(wurzel);
  if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) throw new FahnasFehler('E_PARAMS', 'Das Archiv enthält Verknüpfungen und wird nicht übernommen', { feld: 'datei', eintrag: path.basename(wurzel) });
  if (!st.isDirectory()) return;
  for (const d of await fs.readdir(wurzel, { withFileTypes: true })) {
    const p = path.join(wurzel, d.name);
    if (d.isSymbolicLink() || !(d.isDirectory() || d.isFile())) throw new FahnasFehler('E_PARAMS', 'Das Archiv enthält Verknüpfungen und wird nicht übernommen', { feld: 'datei', eintrag: path.relative(wurzel, p) });
    if (d.isDirectory()) await baumNurDateienUndOrdner(p);
  }
}

/**
 * Entpackt ein Export-Archiv (ggf. nach Entschlüsselung) in einen Zwischenordner und liest die Kerndateien.
 * Der Aufrufer räumt `ordner` mit fs.rm auf.
 * @returns {Promise<{ordner:string, version:object, system:object|null, users:object|null, shares:object|null, snapshots:object|null}>}
 */
export async function importEntpacken({ datei, passwort, system }) {
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-import-'));
  try {
    let tar = datei;
    if (datei.endsWith('.fahnas')) {
      tar = path.join(ordner, 'archiv.tar');
      await entschluesseln(datei, tar, passwort);
    } else {
      // Kopf prüfen: verschlüsselte Datei ohne passende Endung?
      const fh = await fs.open(datei, 'r');
      try {
        const b = Buffer.alloc(MAGIC.length);
        await fh.read(b, 0, MAGIC.length, 0);
        if (b.equals(MAGIC)) { tar = path.join(ordner, 'archiv.tar'); await entschluesseln(datei, tar, passwort); }
      } finally { await fh.close(); }
    }
    const inhalt = path.join(ordner, 'inhalt');
    await fs.mkdir(inhalt, { mode: 0o700 });
    // Vorprüfung der Mitgliederliste (Typ und Namen), erst dann entpacken – ohne Besitzerübernahme, ohne
    // Rechteübernahme, ohne vorhandene Ordner zu überschreiben (GNU tar; bsdtar kennt die letzte Option nicht).
    let liste;
    try {
      liste = await Promise.all([system.ausfuehren('tar', ['-tvf', tar]), system.ausfuehren('tar', ['-tf', tar])]);
    } catch (e) {
      throw new FahnasFehler('E_PARAMS', 'Die Datei ist kein lesbares FAH-NAS-Export-Archiv', { feld: 'datei', ausgabe: e.details?.ausgabe || e.message });
    }
    archivMitgliederPruefen(liste[0].stdout, liste[1].stdout);
    const optionen = ['--no-same-owner', '--no-same-permissions', ...((await tarIstGnu(system)) ? ['--no-overwrite-dir'] : [])];
    try {
      await system.ausfuehren('tar', ['-C', inhalt, ...optionen, '-xf', tar]);
    } catch (e) {
      throw new FahnasFehler('E_PARAMS', 'Die Datei ist kein lesbares FAH-NAS-Export-Archiv', { feld: 'datei', ausgabe: e.details?.ausgabe || e.message });
    }
    await baumNurDateienUndOrdner(inhalt);
    const version = await jsonOderNull(path.join(inhalt, 'version.json'));
    if (!version || typeof version.schema !== 'number') throw new FahnasFehler('E_KONFIG', 'Im Archiv fehlt version.json – das ist kein FAH-NAS-Export');
    if (version.schema > SCHEMA_VERSION) {
      throw new FahnasFehler('E_KONFIG', `Das Archiv stammt von einer neueren FAH-NAS-Version (Schema ${version.schema}, hier ${SCHEMA_VERSION}). Bitte erst das System aktualisieren.`, { schema: version.schema, aktuell: SCHEMA_VERSION });
    }
    return {
      ordner, inhalt, version,
      system: await jsonOderNull(path.join(inhalt, 'system.json')),
      users: await jsonOderNull(path.join(inhalt, 'users.json')),
      shares: await jsonOderNull(path.join(inhalt, 'shares.json')),
      snapshots: await jsonOderNull(path.join(inhalt, 'snapshots.json')),
    };
  } catch (e) {
    await fs.rm(ordner, { recursive: true, force: true });
    throw e;
  }
}

function namenVergleich(altListe, neuListe, schluessel = 'name') {
  const alt = new Map((altListe ?? []).map((e) => [e[schluessel], e]));
  const neu = new Map((neuListe ?? []).map((e) => [e[schluessel], e]));
  const hinzu = [...neu.keys()].filter((n) => !alt.has(n)).sort();
  const weg = [...alt.keys()].filter((n) => !neu.has(n)).sort();
  const geaendert = [...neu.keys()].filter((n) => alt.has(n) && JSON.stringify(alt.get(n)) !== JSON.stringify(neu.get(n))).sort();
  return { hinzu, weg, geaendert };
}

/**
 * Ermittelt die Unterschiede zwischen dem aktuellen Stand und dem Archiv.
 * @param {{system, users, shares, snapshots}} jetzt
 * @param {{system, users, shares, snapshots}} archiv
 */
export function unterschiede(jetzt, archiv) {
  const aus = {
    nutzer: namenVergleich(jetzt.users?.nutzer, archiv.users?.nutzer),
    gruppen: namenVergleich(jetzt.users?.gruppen, archiv.users?.gruppen),
    freigaben: namenVergleich(jetzt.shares?.freigaben, archiv.shares?.freigaben),
    system: [],
    snapshots: JSON.stringify(jetzt.snapshots ?? null) !== JSON.stringify(archiv.snapshots ?? null),
    hinweise: [],
  };
  if (archiv.system) {
    const felder = new Set([...Object.keys(jetzt.system ?? {}), ...Object.keys(archiv.system)]);
    for (const f of felder) {
      if (f === 'version') continue;
      if (JSON.stringify(jetzt.system?.[f]) !== JSON.stringify(archiv.system[f])) aus.system.push(f);
    }
    aus.system.sort();
  }
  const ohneHash = (archiv.users?.nutzer ?? []).filter((n) => !n.hash).map((n) => n.name);
  if (ohneHash.length) aus.hinweise.push(`Ohne Passwort im Archiv (Export ohne Geheimnisse) – Passwort danach neu setzen: ${ohneHash.join(', ')}`);
  if (!archiv.users) aus.hinweise.push('Archiv enthält keine users.json – Nutzer bleiben unverändert');
  if (!archiv.shares) aus.hinweise.push('Archiv enthält keine shares.json – Freigaben bleiben unverändert');
  return aus;
}

/**
 * Übernimmt die Dateien aus dem entpackten Archiv nach konfigOrdner (system.json, users.json, shares.json,
 * snapshots.json, links.json, remote.json, apps/, vms/). web/, protokoll/ und version.json werden NICHT angefasst.
 * Schreibt jede Datei atomar (tmp + rename).
 * @returns {Promise<string[]>} übernommene Einträge
 */
export async function importAnwenden({ inhalt, konfigOrdner }) {
  // Sicherheitsnetz: auch ein von Hand befüllter Zwischenordner darf keine Verknüpfungen enthalten
  await baumNurDateienUndOrdner(inhalt);
  const uebernommen = [];
  for (const d of IMPORT_DATEIEN) {
    const q = path.join(inhalt, d);
    let text;
    try { text = await fs.readFile(q, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw FahnasFehler.aus(e); }
    try { JSON.parse(text); } catch { throw new FahnasFehler('E_KONFIG', `${d} im Archiv ist kein gültiges JSON`, { datei: d }); }
    const z = path.join(konfigOrdner, d);
    const tmp = `${z}.${process.pid}.tmp`;
    try { await fs.unlink(tmp); } catch { /* nicht da */ }
    const fh = await fs.open(tmp, 'wx', MODUS[d] ?? 0o640); // users.json/links.json tragen Geheimnisse → nur root (MODUS-Tabelle)
    try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, z);
    uebernommen.push(d);
  }
  const nurRegulaer = (src) => { const st = fsSync.lstatSync(src); return st.isDirectory() || st.isFile(); };
  for (const o of IMPORT_ORDNER) {
    const q = path.join(inhalt, o);
    try { if (!(await fs.lstat(q)).isDirectory()) continue; } catch { continue; }
    const z = path.join(konfigOrdner, o);
    await fs.rm(z, { recursive: true, force: true });
    await fs.cp(q, z, { recursive: true, force: true, dereference: false, filter: nurRegulaer });
    uebernommen.push(`${o}/`);
  }
  return uebernommen;
}
