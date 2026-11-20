// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dateihelfer: läuft als Kindprozess des Agenten MIT DER UID/GID DES ANFRAGENDEN NUTZERS. Liest genau eine
// JSON-Zeile {op, params} von stdin, arbeitet ausschließlich mit node:fs und gibt genau eine Ergebniszeile aus:
// {ok:true, ergebnis} oder {fehler:{code, meldung, details?}}. Lang laufende Operationen (kopieren, verschieben,
// snapshot_zurueckholen) schicken vorher zusätzliche Zeilen {fortschritt, meldung}.
// Der Helfer ist eigenständig: er importiert nur src/gemeinsam/pfade.js und fehler.js. Alle Wurzeln kommen als
// absolute Pfade vom Agenten; relative Pfade werden HIER (mit den Rechten des Nutzers) nochmals gegen Pfadflucht
// und Symlink-Ausbruch geprüft.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { sicherAufloesen, relativerPfad, pruefeDateiname } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import {
  ENDUNGEN, BUENDEL_MUSTER, OFFICE_ARTEN, INHALT_DATEI, VERLAUF_DATEI, DATEIEN_ORDNER, INHALT_MAX_BYTES, VERLAUF_MAX, SCHEMA, artAusName, imBuendel,
} from '../../gemeinsam/office.js';

export const PAPIERKORB = '.papierkorb';
const SAMBA_KORB = 'samba';
const PAPIERKORB_DATEI = 'papierkorb.json';
const FORTSCHRITT_TAKT_MS = 250;
/** Hochladen schreibt erst in diese versteckte Zwischendatei im Zielordner; erst der vollständige Upload ersetzt/legt ab. */
export const UPLOAD_PRAEFIX = '.fahnas-upload-';
const UPLOAD_REST_MS = 24 * 3600 * 1000; // Zwischendateien, die so lange unberührt liegen (Agent-Absturz), räumt liste weg
/** Umgang mit einem schon vorhandenen Namen beim Hochladen: ablehnen, ersetzen (alte Version → Papierkorb), beide behalten. */
export const BEI_VORHANDEN = Object.freeze(['fehler', 'ersetzen', 'beide']);
const OHNE_HARTE_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

let abbruch = false;

// ---------------------------------------------------------------------------------------------------------------
// MIME-Tabelle (klein, eigene Pflege – kein Fremdpaket)
// ---------------------------------------------------------------------------------------------------------------
const MIME = Object.freeze({
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain',
  yaml: 'text/yaml', yml: 'text/yaml', ini: 'text/plain', conf: 'text/plain', sh: 'text/x-shellscript', py: 'text/x-python',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', bz2: 'application/x-bzip2', xz: 'application/x-xz', zst: 'application/zstd',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  iso: 'application/x-iso9660-image', img: 'application/octet-stream',
});

/** MIME-Typ aus der Dateiendung; unbekannt → application/octet-stream. */
export function mimeVon(name) {
  const e = path.extname(String(name || '')).slice(1).toLowerCase();
  return MIME[e] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------------------------------------------
// Kleine Hilfen
// ---------------------------------------------------------------------------------------------------------------
function schreibe(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

/** Relativer Pfad, bereinigt; der Papierkorb ist über normale Operationen nicht erreichbar. */
function relPruefen(p, feld = 'pfad') {
  const rel = relativerPfad(p);
  const erstes = rel.split('/')[0];
  if (erstes === PAPIERKORB) throw new FahnasFehler('E_RECHTE', 'Der Papierkorb ist nur über die Papierkorb-Funktionen erreichbar', { feld });
  return rel;
}

function rechteText(mode) {
  const b = ['r', 'w', 'x'];
  let s = '';
  for (let i = 8; i >= 0; i--) s += (mode & (1 << i)) ? b[(8 - i) % 3] : '-';
  return s;
}

function artVon(st) {
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'ordner';
  return 'datei';
}

async function lstatOderNull(p) { try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }

function eintragAus(name, st) {
  const art = artVon(st);
  const e = { name, art, groesse: art === 'datei' ? st.size : (art === 'ordner' ? null : st.size), geaendert: st.mtime.toISOString(), rechte: rechteText(st.mode) };
  if (art === 'datei') e.mime = mimeVon(name);
  return e;
}

const SORTIERER = {
  name: (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' }),
  groesse: (a, b) => (a.groesse ?? -1) - (b.groesse ?? -1) || SORTIERER.name(a, b),
  geaendert: (a, b) => (a.geaendert < b.geaendert ? -1 : a.geaendert > b.geaendert ? 1 : 0) || SORTIERER.name(a, b),
  art: (a, b) => (a.mime || '').localeCompare(b.mime || '') || SORTIERER.name(a, b),
};

function sortiere(eintraege, sortierung = 'name', absteigend = false) {
  const f = SORTIERER[sortierung] || SORTIERER.name;
  // Ordner immer zuerst, danach die gewählte Ordnung
  eintraege.sort((a, b) => {
    const oa = a.art === 'ordner' ? 0 : 1; const ob = b.art === 'ordner' ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const r = f(a, b);
    return absteigend ? -r : r;
  });
  return eintraege;
}

/** Summe der Dateigrößen unter einem Pfad (Symlinks nicht verfolgt). */
async function groesseBaum(p) {
  const st = await fs.lstat(p);
  if (st.isDirectory()) {
    let summe = 0;
    for (const k of await fs.readdir(p)) summe += await groesseBaum(path.join(p, k));
    return summe;
  }
  return st.isFile() ? st.size : 0;
}

/** Alle Dateien (keine Ordner) unter einem Pfad als relative Pfade. */
async function dateienUnter(wurzel, rel = '') {
  const abs = path.join(wurzel, rel);
  const st = await fs.lstat(abs);
  if (!st.isDirectory()) return [{ pfad: rel, st }];
  const aus = [];
  for (const k of (await fs.readdir(abs)).sort()) aus.push(...(await dateienUnter(wurzel, rel ? `${rel}/${k}` : k)));
  return aus;
}

/** Zeitstempel als Ordnername: ISO-Zeit ohne Doppelpunkte/Punkte (Windows-Clients über Samba können keine „:“). */
function korbKennung(zeit) { return zeit.toISOString().replace(/[:.]/g, '-'); }

/** Legt einen Vorgangsordner im Papierkorb an: <wurzel>/.papierkorb/<Zeitstempel>[-n]. */
async function korbOrdnerAnlegen(wurzel, zeit) {
  const korb = path.join(await fs.realpath(wurzel), PAPIERKORB);
  await fs.mkdir(korb, { recursive: true });
  let kennung = korbKennung(zeit);
  let ordner = path.join(korb, kennung);
  for (let n = 2; ; n++) {
    try { await fs.mkdir(ordner); break; } catch (e) { if (e.code !== 'EEXIST') throw e; kennung = `${korbKennung(zeit)}-${n}`; ordner = path.join(korb, kennung); }
  }
  return { kennung, ordner };
}

async function korbInfoSchreiben(ordner, eintraege, nutzer, zeit, grund) {
  const info = { herkunft: gemeinsamerElter(eintraege.map((e) => e.pfad)), nutzer: nutzer || null, zeit: zeit.toISOString(), eintraege };
  if (grund) info.grund = grund;
  await fs.writeFile(path.join(ordner, PAPIERKORB_DATEI), JSON.stringify(info, null, 2) + '\n');
}

/** "Bericht.pdf" → ["Bericht", ".pdf"]; ".tar.gz" bleibt zusammen, ".bashrc" und "Notiz. Final" haben keine Endung. */
export function nameTeilen(name) {
  const m = /^(.+?)((?:\.tar)?\.[^.\s]{1,12})$/i.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
}

/**
 * Nächster freier Name „Name (n).ext“ in `ordnerAbs` (wie Finder/Explorer). Ein Name, der schon „(n)“ trägt, zählt
 * weiter statt „(n) (1)“ anzuhängen. `vergeben` = Namen, die derselbe Vorgang schon verplant hat.
 */
export async function freierName(ordnerAbs, name, vergeben = new Set()) {
  const [stamm, endung] = nameTeilen(name);
  const m = /^(.*\S) \((\d{1,6})\)$/.exec(stamm);
  const basis = m ? m[1] : stamm;
  let n = m ? Number(m[2]) + 1 : 1;
  for (let i = 0; i < 10000; i++, n++) {
    const kandidat = `${basis} (${n})${endung}`;
    if (Buffer.byteLength(kandidat) > 255) throw new FahnasFehler('E_PARAMS', `„${name}“ ist zu lang für eine nummerierte Kopie`, { feld: 'name' });
    if (!vergeben.has(kandidat) && !(await lstatOderNull(path.join(ordnerAbs, kandidat)))) return kandidat;
  }
  throw new FahnasFehler('E_EXISTIERT', `Für „${name}“ ist kein freier Name mehr zu finden`, { feld: 'name' });
}

/**
 * Legt die Datei `quelle` unter `ziel` ab, OHNE etwas zu ersetzen. Mit hartem Link atomar (link schlägt bei belegtem
 * Ziel mit EEXIST fehl); Dateisysteme ohne harte Links (exFAT, FAT, …) prüfen und benennen um. false = Ziel belegt.
 */
async function ablegenOhneErsetzen(quelle, ziel) {
  try {
    await fs.link(quelle, ziel);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!OHNE_HARTE_LINKS.has(e.code)) throw e;
    if (await lstatOderNull(ziel)) return false;
    await fs.rename(quelle, ziel);
    return true;
  }
  await fs.unlink(quelle);
  return true;
}

/** Gemeinsamer Elternpfad mehrerer relativer Pfade ("" = Wurzel). */
function gemeinsamerElter(rels) {
  const eltern = rels.map((r) => r.split('/').slice(0, -1));
  if (!eltern.length) return '';
  let gemeinsam = eltern[0];
  for (const e of eltern.slice(1)) {
    let i = 0;
    while (i < gemeinsam.length && i < e.length && gemeinsam[i] === e[i]) i++;
    gemeinsam = gemeinsam.slice(0, i);
  }
  return gemeinsam.join('/');
}

async function leereElternEntfernen(von, bis) {
  let p = von;
  while (p !== bis && p.startsWith(bis + path.sep)) {
    try { const k = await fs.readdir(p); if (k.length) return; await fs.rmdir(p); } catch { return; }
    p = path.dirname(p);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Verschieben mit Rückfall auf Kopieren+Löschen (btrfs: rename über Unterlaufwerksgrenzen liefert EXDEV)
// ---------------------------------------------------------------------------------------------------------------
async function verschiebeRobust(quelle, ziel, zaehler) {
  try { await fs.rename(quelle, ziel); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  await kopiereBaum(quelle, ziel, zaehler || { gesamt: await groesseBaum(quelle), kopiert: 0, letzte: 0, ueberschreiben: false });
  await fs.rm(quelle, { recursive: true, force: false });
}

/**
 * Eine Datei kopieren: copyFile mit Reflink (btrfs teilt Blöcke). libuv überträgt danach die Rechte per fchmod – auf
 * exFAT/FAT/NTFS-Einhängungen (alles gehört root, uid=/gid=-Optionen) scheitert das für jeden Nutzer mit EPERM und libuv
 * entfernt das Ziel wieder. Dann ohne Rechte-Übernahme als Datenstrom kopieren (Rechte legt dort ohnehin die Einhängung fest).
 */
async function dateiKopieren(quelle, ziel, ueberschreiben) {
  try {
    await fs.copyFile(quelle, ziel, ueberschreiben ? fsSync.constants.COPYFILE_FICLONE : (fsSync.constants.COPYFILE_FICLONE | fsSync.constants.COPYFILE_EXCL));
    return;
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
  }
  // Ohne ueberschreiben kann ein noch vorhandenes Ziel nur der eigene Rest des gescheiterten Versuchs sein (EXCL)
  const flags = ueberschreiben || (await lstatOderNull(ziel)) ? 'w' : 'wx';
  await pipeline(fsSync.createReadStream(quelle), fsSync.createWriteStream(ziel, { flags }));
}

/** Kopiert rekursiv; Dateien per copyFile mit Reflink (btrfs teilt Blöcke), Symlinks als Symlinks, Zeiten bleiben. */
async function kopiereBaum(quelle, ziel, z) {
  if (abbruch) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
  const st = await fs.lstat(quelle);
  if (st.isDirectory()) {
    try { await fs.mkdir(ziel, { mode: st.mode & 0o777 }); } catch (e) { if (!(e.code === 'EEXIST' && z.ueberschreiben)) throw e; }
    for (const k of (await fs.readdir(quelle)).sort()) await kopiereBaum(path.join(quelle, k), path.join(ziel, k), z);
    try { await fs.utimes(ziel, st.atime, st.mtime); } catch { /* Zeiten sind Beiwerk */ }
    return;
  }
  if (st.isSymbolicLink()) {
    const zielDesLinks = await fs.readlink(quelle);
    if (z.ueberschreiben) { try { await fs.unlink(ziel); } catch { /* war nicht da */ } }
    await fs.symlink(zielDesLinks, ziel);
    return;
  }
  if (!st.isFile()) return; // Sockets, Geräte usw. werden nicht kopiert
  try {
    await dateiKopieren(quelle, ziel, z.ueberschreiben);
  } catch (e) {
    if (abbruch) { try { await fs.unlink(ziel); } catch { /* egal */ } throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen'); }
    throw e;
  }
  try { await fs.utimes(ziel, st.atime, st.mtime); } catch { /* Beiwerk */ }
  z.kopiert += st.size;
  const jetzt = Date.now();
  if (z.gesamt > 0 && jetzt - z.letzte >= FORTSCHRITT_TAKT_MS) {
    z.letzte = jetzt;
    schreibe({ fortschritt: Math.min(0.99, z.kopiert / z.gesamt), meldung: `Kopiere ${path.basename(quelle)}` });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Operationen
// ---------------------------------------------------------------------------------------------------------------
async function opListe({ wurzel, pfad, sortierung, absteigend, versteckte }) {
  const rel = relPruefen(pfad);
  const abs = await sicherAufloesen(wurzel, rel);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) throw new FahnasFehler('E_PARAMS', 'Der Pfad ist kein Ordner', { feld: 'pfad' });
  const namen = await fs.readdir(abs);
  const eintraege = [];
  for (const name of namen) {
    if (rel === '' && name === PAPIERKORB) continue;
    if (name.startsWith(UPLOAD_PRAEFIX)) {
      // Zwischendatei eines laufenden Uploads: nie zeigen. Liegt sie seit einem Tag unberührt (Agent-Absturz), weg damit.
      const s = await lstatOderNull(path.join(abs, name));
      if (s && s.isFile() && Date.now() - s.mtimeMs > UPLOAD_REST_MS) await fs.unlink(path.join(abs, name)).catch(() => {});
      continue;
    }
    if (!versteckte && name.startsWith('.')) continue;
    const s = await lstatOderNull(path.join(abs, name));
    if (!s) continue; // zwischenzeitlich verschwunden
    eintraege.push(eintragAus(name, s));
  }
  sortiere(eintraege, sortierung, absteigend);
  return { eintraege, pfad: rel, eltern: rel === '' ? null : (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') };
}

async function opOrdner({ wurzel, pfad, name }) {
  const rel = relPruefen(pfad);
  pruefeDateiname(name);
  if (rel === '' && name === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Dieser Name ist für den Papierkorb reserviert', { feld: 'name' });
  const abs = await sicherAufloesen(wurzel, rel ? `${rel}/${name}` : name);
  try { await fs.mkdir(abs); } catch (e) {
    if (e.code === 'EEXIST') throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es hier schon`, { feld: 'name' });
    if (e.code === 'ENOENT') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Der übergeordnete Ordner existiert nicht', { feld: 'pfad' });
    throw e;
  }
  return { pfad: rel ? `${rel}/${name}` : name };
}

async function opUmbenennen({ wurzel, pfad, neuer_name }) {
  const rel = relPruefen(pfad);
  if (rel === '') throw new FahnasFehler('E_PARAMS', 'Die Wurzel der Freigabe kann nicht umbenannt werden', { feld: 'pfad' });
  pruefeDateiname(neuer_name, 'neuer_name');
  const quelle = await sicherAufloesen(wurzel, rel);
  if (!(await lstatOderNull(quelle))) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
  const elternRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  if (elternRel === '' && neuer_name === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Dieser Name ist für den Papierkorb reserviert', { feld: 'neuer_name' });
  const ziel = path.join(path.dirname(quelle), neuer_name);
  if (await lstatOderNull(ziel)) throw new FahnasFehler('E_EXISTIERT', `„${neuer_name}“ gibt es hier schon`, { feld: 'neuer_name' });
  await fs.rename(quelle, ziel);
  return { pfad: elternRel ? `${elternRel}/${neuer_name}` : neuer_name };
}

// ---------------------------------------------------------------------------------------------------------------
// Mehrere auf einmal umbenennen (Betreiber 12.10.2026): „001“ → „001 (01).mkv“, „001 (02).mkv“ … – Endung bleibt,
// Nummer nach der Reihenfolge der Liste, mindestens zweistellig. Die Oberfläche rechnet die Vorschau mit derselben Regel
// (public/ansichten/dateien.js serienNamen – Test prüft Gleichheit).
// ---------------------------------------------------------------------------------------------------------------

const DOPPEL_ENDUNG = /(\.tar\.(?:gz|bz2|xz|zst|lz4))$/i;

/** Endung eines Dateinamens (Ordner: keine, außer Office-Bündel). „.tar.gz“ zählt als eine Endung, „.env“ (nur Punkt vorn) hat keine. */
export function endungVon(name, ordner = false) {
  if (ordner) { const b = BUENDEL_MUSTER.exec(name); return b && b.index > 0 ? b[0] : ''; }
  const doppel = DOPPEL_ENDUNG.exec(name);
  if (doppel && doppel.index > 0) return doppel[1];
  const e = path.extname(name);
  return e === name ? '' : e;
}

/** Neue Namen für eine Serie: [{alt, ordner}] + basis → [{alt, neu}]. */
export function serienNamen(eintraege, basis) {
  const breite = Math.max(2, String(eintraege.length).length);
  return eintraege.map((e, i) => ({ alt: e.alt, neu: `${basis} (${String(i + 1).padStart(breite, '0')})${endungVon(e.alt, e.ordner)}` }));
}

async function opUmbenennenSerie({ wurzel, pfad, namen, basis }) {
  const ordnerRel = relPruefen(pfad || '');
  if (!Array.isArray(namen) || !namen.length || namen.length > 1000) throw new FahnasFehler('E_PARAMS', 'Bitte 1 bis 1000 Einträge wählen', { feld: 'namen' });
  if (new Set(namen).size !== namen.length) throw new FahnasFehler('E_PARAMS', 'Ein Eintrag ist doppelt gewählt', { feld: 'namen' });
  const b = typeof basis === 'string' ? basis.trim() : '';
  pruefeDateiname(b, 'basis');
  const ordner = await sicherAufloesen(wurzel, ordnerRel);
  const quellen = [];
  for (const n of namen) {
    pruefeDateiname(n, 'namen');
    if (ordnerRel === '' && n === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Der Papierkorb lässt sich nicht umbenennen', { feld: 'namen' });
    const st = await lstatOderNull(path.join(ordner, n));
    if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${n}“ gibt es hier nicht (mehr)`, { feld: 'namen' });
    quellen.push({ alt: n, ordner: st.isDirectory() });
  }
  const ziele = serienNamen(quellen, b);
  const alt = new Set(namen);
  for (const z of ziele) {
    pruefeDateiname(z.neu, 'basis');
    if (ordnerRel === '' && z.neu === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Dieser Name ist für den Papierkorb reserviert', { feld: 'basis' });
    // Ein vorhandener fremder Eintrag mit dem neuen Namen → nichts anfassen (die gewählten tauschen ihre Namen gefahrlos)
    if (!alt.has(z.neu) && await lstatOderNull(path.join(ordner, z.neu))) throw new FahnasFehler('E_EXISTIERT', `„${z.neu}“ gibt es hier schon`, { feld: 'basis' });
  }
  // Zwei Schritte über Zwischennamen, damit sich die gewählten nicht gegenseitig im Weg stehen; bei Fehler zurück
  const kennung = crypto.randomBytes(4).toString('hex');
  const zwischen = [];
  try {
    for (let i = 0; i < ziele.length; i++) {
      const tmp = `.fahnas-umbenennen-${kennung}-${i}`;
      await fs.rename(path.join(ordner, ziele[i].alt), path.join(ordner, tmp));
      zwischen.push(tmp);
    }
  } catch (e) {
    for (let i = zwischen.length - 1; i >= 0; i--) { try { await fs.rename(path.join(ordner, zwischen[i]), path.join(ordner, ziele[i].alt)); } catch { /* bestmöglich */ } }
    throw FahnasFehler.aus(e);
  }
  const fertig = new Set();
  try {
    for (let i = 0; i < ziele.length; i++) { await fs.rename(path.join(ordner, zwischen[i]), path.join(ordner, ziele[i].neu)); fertig.add(i); }
  } catch (e) {
    for (let i = 0; i < ziele.length; i++) if (!fertig.has(i)) { try { await fs.rename(path.join(ordner, zwischen[i]), path.join(ordner, ziele[i].alt)); } catch { /* bestmöglich */ } }
    throw FahnasFehler.aus(e);
  }
  return { umbenannt: ziele, anzahl: ziele.length };
}

/**
 * Gemeinsamer Kern für kopieren, verschieben und snapshot_zurueckholen.
 * Namenskonflikte am Ziel: ohne Angabe → E_EXISTIERT (nichts passiert). `ersetzen` (Namen) legt das Vorhandene vorher in
 * den Papierkorb der Zielfreigabe (ohne Papierkorb: endgültig weg), `beide` (Namen) legt unter „Name (n)“ ab.
 * `ueberschreiben` (Schnappschuss zurückholen) mischt wie bisher ohne Papierkorb in das Vorhandene hinein.
 */
async function uebertragen({ wurzel, quellen, ziel_wurzel, ziel_pfad, ueberschreiben, ersetzen, beide, papierkorb = true, nutzer }, modus) {
  if (!Array.isArray(quellen) || !quellen.length) throw new FahnasFehler('E_PARAMS', 'Keine Quellen angegeben', { feld: 'quellen' });
  const zielRel = relPruefen(ziel_pfad, 'ziel_pfad');
  const zielAbs = await sicherAufloesen(ziel_wurzel, zielRel);
  const zst = await lstatOderNull(zielAbs);
  if (!zst) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Zielordner nicht gefunden', { feld: 'ziel_pfad' });
  if (!zst.isDirectory()) throw new FahnasFehler('E_PARAMS', 'Das Ziel ist kein Ordner', { feld: 'ziel_pfad' });
  const ersetzenNamen = new Set(Array.isArray(ersetzen) ? ersetzen : []);
  const beideNamen = new Set(Array.isArray(beide) ? beide : []);

  // Erst alles prüfen, dann arbeiten – damit nichts halb passiert, was vermeidbar wäre.
  const plan = [];
  const vergeben = new Set();
  for (const q of quellen) {
    const rel = modus === 'snapshot' ? relativerPfad(q) : relPruefen(q, 'quellen');
    if (rel === '') throw new FahnasFehler('E_PARAMS', 'Die Wurzel kann nicht kopiert oder verschoben werden', { feld: 'quellen' });
    const abs = await sicherAufloesen(wurzel, rel);
    const st = await lstatOderNull(abs);
    if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${rel}“ nicht gefunden`, { feld: 'quellen' });
    const name = path.basename(rel);
    if (zielRel === '' && name === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Dieser Name ist für den Papierkorb reserviert', { feld: 'quellen' });
    const entscheidung = ueberschreiben ? 'ueberschreiben' : ersetzenNamen.has(name) ? 'ersetzen' : beideNamen.has(name) ? 'beide' : null;
    let zielName = name;
    let zielEintrag = path.join(zielAbs, name);
    let weglegen = null;
    const selbst = zielEintrag === abs;
    // Am selben Ort: nur „beide behalten“ beim Kopieren ergibt Sinn (Duplikat „Name (1)“)
    if (selbst && !(modus === 'kopieren' && entscheidung === 'beide')) throw new FahnasFehler('E_PARAMS', `„${name}“ liegt schon an diesem Ort`, { feld: 'ziel_pfad' });
    const belegt = vergeben.has(name) || (await lstatOderNull(zielEintrag));
    if (belegt) {
      if (entscheidung === 'beide') {
        zielName = await freierName(zielAbs, name, vergeben);
        zielEintrag = path.join(zielAbs, zielName);
      } else if (entscheidung === 'ersetzen' && !vergeben.has(name)) {
        if (abs.startsWith(zielEintrag + path.sep)) throw new FahnasFehler('E_PARAMS', `„${name}“ kann nicht durch seinen eigenen Inhalt ersetzt werden`, { feld: 'ziel_pfad' });
        weglegen = { rel: zielRel ? `${zielRel}/${name}` : name, st: belegt };
      } else if (entscheidung !== 'ueberschreiben') {
        throw new FahnasFehler('E_EXISTIERT', `Am Ziel gibt es „${name}“ schon`, { feld: 'ziel_pfad', name });
      }
    }
    if (st.isDirectory() && (zielEintrag === abs || zielEintrag.startsWith(abs + path.sep))) {
      throw new FahnasFehler('E_PARAMS', 'Ein Ordner kann nicht in sich selbst kopiert oder verschoben werden', { feld: 'ziel_pfad' });
    }
    vergeben.add(zielName);
    plan.push({ rel, abs, name, zielEintrag, zielRel: zielRel ? `${zielRel}/${zielName}` : zielName, st, weglegen });
  }

  // „Ersetzen“: Vorhandenes vor dem Übertragen in den Papierkorb der Zielfreigabe (ein Vorgang für alle), sonst löschen
  const zuErsetzen = plan.filter((p) => p.weglegen);
  let korb = null;
  if (zuErsetzen.length) {
    const zeit = new Date();
    if (papierkorb) {
      korb = await korbOrdnerAnlegen(ziel_wurzel, zeit);
      const eintraege = [];
      for (const p of zuErsetzen) {
        const imKorb = path.join(korb.ordner, p.weglegen.rel);
        await fs.mkdir(path.dirname(imKorb), { recursive: true });
        await verschiebeRobust(p.zielEintrag, imKorb);
        eintraege.push({ pfad: p.weglegen.rel, name: path.basename(p.weglegen.rel), art: artVon(p.weglegen.st), groesse: p.weglegen.st.isFile() ? p.weglegen.st.size : null });
      }
      await korbInfoSchreiben(korb.ordner, eintraege, nutzer, zeit, 'ersetzt');
    } else {
      for (const p of zuErsetzen) await fs.rm(p.zielEintrag, { recursive: true, force: true });
    }
  }
  const extra = { ersetzt: zuErsetzen.length, papierkorb: korb ? korb.kennung : null };

  const uebertragenListe = [];
  if (modus === 'verschieben') {
    const zaehler = { gesamt: 0, kopiert: 0, letzte: 0, ueberschreiben: !!ueberschreiben };
    for (const [i, p] of plan.entries()) {
      if (abbruch) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
      schreibe({ fortschritt: i / plan.length, meldung: `Verschiebe ${p.name}` });
      if (ueberschreiben) { try { await fs.rm(p.zielEintrag, { recursive: true, force: true }); } catch { /* egal */ } }
      try { await fs.rename(p.abs, p.zielEintrag); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        zaehler.gesamt = await groesseBaum(p.abs); zaehler.kopiert = 0;
        await kopiereBaum(p.abs, p.zielEintrag, zaehler);
        await fs.rm(p.abs, { recursive: true, force: false });
      }
      uebertragenListe.push({ von: p.rel, nach: p.zielRel });
    }
    return { uebertragen: uebertragenListe, bytes: zaehler.kopiert, ...extra };
  }

  // kopieren / snapshot: Gesamtgröße vorab für den Fortschritt
  let gesamt = 0;
  for (const p of plan) gesamt += await groesseBaum(p.abs);
  const zaehler = { gesamt, kopiert: 0, letzte: 0, ueberschreiben: !!ueberschreiben };
  for (const p of plan) {
    schreibe({ fortschritt: gesamt ? Math.min(0.99, zaehler.kopiert / gesamt) : 0, meldung: `Kopiere ${p.name}` });
    await kopiereBaum(p.abs, p.zielEintrag, zaehler);
    uebertragenListe.push({ von: p.rel, nach: p.zielRel });
  }
  return { uebertragen: uebertragenListe, bytes: zaehler.kopiert, ...extra };
}

async function opLoeschen({ wurzel, pfade, endgueltig, nutzer }) {
  if (!Array.isArray(pfade) || !pfade.length) throw new FahnasFehler('E_PARAMS', 'Keine Pfade angegeben', { feld: 'pfade' });
  const ziele = [];
  for (const p of pfade) {
    const rel = relPruefen(p, 'pfade');
    if (rel === '') throw new FahnasFehler('E_PARAMS', 'Die Wurzel der Freigabe kann nicht gelöscht werden', { feld: 'pfade' });
    const abs = await sicherAufloesen(wurzel, rel);
    const st = await lstatOderNull(abs);
    if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${rel}“ nicht gefunden`, { feld: 'pfade' });
    ziele.push({ rel, abs, st });
  }
  if (endgueltig) {
    for (const z of ziele) await fs.rm(z.abs, { recursive: true, force: false });
    return { geloescht: ziele.length, endgueltig: true, papierkorb: null };
  }
  const zeit = new Date();
  const { kennung, ordner } = await korbOrdnerAnlegen(wurzel, zeit);
  const eintraege = [];
  for (const z of ziele) {
    const zielImKorb = path.join(ordner, z.rel);
    await fs.mkdir(path.dirname(zielImKorb), { recursive: true });
    await verschiebeRobust(z.abs, zielImKorb);
    eintraege.push({ pfad: z.rel, name: path.basename(z.rel), art: artVon(z.st), groesse: z.st.isFile() ? z.st.size : null });
  }
  await korbInfoSchreiben(ordner, eintraege, nutzer, zeit);
  return { geloescht: ziele.length, endgueltig: false, papierkorb: kennung };
}

async function opPapierkorbListe({ wurzel }) {
  const korb = path.join(await fs.realpath(wurzel), PAPIERKORB);
  let kinder;
  try { kinder = await fs.readdir(korb); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const aus = [];
  for (const k of kinder) {
    const p = path.join(korb, k);
    const st = await lstatOderNull(p);
    if (!st || !st.isDirectory()) continue;
    if (k === SAMBA_KORB) {
      // Samba (vfs_recycle mit keeptree): .papierkorb/samba/<ursprünglicher Pfad>, keine Beschreibungsdatei
      for (const d of await dateienUnter(p)) {
        aus.push({
          id: SAMBA_KORB, quelle: 'samba', zeit: d.st.mtime.toISOString(), nutzer: null,
          herkunft: d.pfad.includes('/') ? d.pfad.slice(0, d.pfad.lastIndexOf('/')) : '',
          eintraege: [{ pfad: d.pfad, name: path.basename(d.pfad), art: artVon(d.st), groesse: d.st.isFile() ? d.st.size : null }],
        });
      }
      continue;
    }
    let info = null;
    try { info = JSON.parse(await fs.readFile(path.join(p, PAPIERKORB_DATEI), 'utf8')); } catch { /* fehlt oder kaputt → aus dem Inhalt ableiten */ }
    if (!info || !Array.isArray(info.eintraege)) {
      const namen = (await fs.readdir(p)).filter((n) => n !== PAPIERKORB_DATEI);
      const eintraege = [];
      for (const n of namen) { const s = await lstatOderNull(path.join(p, n)); if (s) eintraege.push({ pfad: n, name: n, art: artVon(s), groesse: s.isFile() ? s.size : null }); }
      info = { herkunft: '', nutzer: null, zeit: st.mtime.toISOString(), eintraege };
    }
    aus.push({ id: k, quelle: 'fahnas', zeit: info.zeit, nutzer: info.nutzer ?? null, herkunft: info.herkunft ?? '', grund: info.grund ?? null, eintraege: info.eintraege });
  }
  aus.sort((a, b) => (a.zeit < b.zeit ? 1 : a.zeit > b.zeit ? -1 : 0));
  return aus;
}

async function opPapierkorbWiederherstellen({ wurzel, eintraege }) {
  if (!Array.isArray(eintraege) || !eintraege.length) throw new FahnasFehler('E_PARAMS', 'Keine Einträge angegeben', { feld: 'eintraege' });
  const wurzelEcht = await fs.realpath(wurzel);
  const korb = path.join(wurzelEcht, PAPIERKORB);
  const wiederhergestellt = []; const uebersprungen = []; const umbenannt = [];
  const beruehrteIds = new Set();

  // Ist der ursprüngliche Ort belegt (z. B. von der neuen Version einer beim Hochladen ersetzten Datei), kommt der
  // Eintrag als „Name (n)“ daneben zurück – nichts wird überschrieben, nichts bleibt unerreichbar im Papierkorb.
  async function zurueck(quelle, rel) {
    let ziel = await sicherAufloesen(wurzelEcht, relPruefen(rel));
    let zielRel = rel;
    await fs.mkdir(path.dirname(ziel), { recursive: true });
    if (await lstatOderNull(ziel)) {
      const neu = await freierName(path.dirname(ziel), path.basename(ziel));
      ziel = path.join(path.dirname(ziel), neu);
      zielRel = rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/'))}/${neu}` : neu;
      umbenannt.push({ pfad: rel, neu: zielRel });
    }
    await verschiebeRobust(quelle, ziel);
    wiederhergestellt.push(zielRel);
  }

  for (const e of eintraege) {
    if (!e || typeof e.id !== 'string') throw new FahnasFehler('E_PARAMS', 'Eintrag ohne id', { feld: 'eintraege' });
    pruefeDateiname(e.id, 'eintraege.id');
    const ordner = path.join(korb, e.id);
    const ost = await lstatOderNull(ordner);
    if (!ost || !ost.isDirectory()) { uebersprungen.push({ pfad: e.id, grund: 'Papierkorb-Eintrag nicht gefunden' }); continue; }
    beruehrteIds.add(e.id);
    if (e.id === SAMBA_KORB) {
      if (!e.pfad) throw new FahnasFehler('E_PARAMS', 'Beim Samba-Papierkorb muss der Pfad angegeben werden', { feld: 'eintraege.pfad' });
      const rel = relativerPfad(e.pfad);
      const quelle = await sicherAufloesen(ordner, rel);
      if (!(await lstatOderNull(quelle))) { uebersprungen.push({ pfad: rel, grund: 'Im Papierkorb nicht gefunden' }); continue; }
      await zurueck(quelle, rel);
      await leereElternEntfernen(path.dirname(quelle), ordner);
      continue;
    }
    let pfade;
    if (e.pfad) pfade = [relativerPfad(e.pfad)];
    else {
      let info = null;
      try { info = JSON.parse(await fs.readFile(path.join(ordner, PAPIERKORB_DATEI), 'utf8')); } catch { /* fehlt */ }
      pfade = info && Array.isArray(info.eintraege) ? info.eintraege.map((x) => x.pfad) : (await fs.readdir(ordner)).filter((n) => n !== PAPIERKORB_DATEI);
    }
    for (const rel of pfade) {
      const quelle = await sicherAufloesen(ordner, rel);
      if (!(await lstatOderNull(quelle))) { uebersprungen.push({ pfad: rel, grund: 'Im Papierkorb nicht gefunden' }); continue; }
      await zurueck(quelle, rel);
    }
  }
  // Leere Papierkorb-Ordner aufräumen (nur noch papierkorb.json → weg damit)
  for (const id of beruehrteIds) {
    if (id === SAMBA_KORB) continue;
    const ordner = path.join(korb, id);
    try {
      const rest = (await dateienUnter(ordner)).filter((d) => d.pfad !== PAPIERKORB_DATEI);
      if (!rest.length) await fs.rm(ordner, { recursive: true, force: true });
    } catch { /* egal */ }
  }
  return { wiederhergestellt, uebersprungen, umbenannt };
}

async function opPapierkorbLeeren({ wurzel }) {
  const korb = path.join(await fs.realpath(wurzel), PAPIERKORB);
  let kinder;
  try { kinder = await fs.readdir(korb); } catch (e) { if (e.code === 'ENOENT') return { entfernt: 0, bytes: 0 }; throw e; }
  let bytes = 0; let entfernt = 0;
  for (const k of kinder) {
    const p = path.join(korb, k);
    // nur Nutzdaten zählen, nicht die Beschreibungsdatei
    try { for (const d of await dateienUnter(p)) if (path.basename(d.pfad) !== PAPIERKORB_DATEI && d.st.isFile()) bytes += d.st.size; } catch { /* egal */ }
    await fs.rm(p, { recursive: true, force: true });
    entfernt++;
  }
  return { entfernt, bytes };
}

/** Bildmaße aus PNG/GIF/JPEG-Kopf (nur die ersten 512 KB werden gelesen). */
async function bildmasse(abs, mime) {
  if (!/^image\/(png|gif|jpeg)$/.test(mime)) return undefined;
  const fh = await fs.open(abs, 'r');
  try {
    const b = Buffer.alloc(512 * 1024);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    const d = b.subarray(0, bytesRead);
    if (mime === 'image/png' && d.length >= 24 && d.toString('latin1', 1, 4) === 'PNG') return { breite: d.readUInt32BE(16), hoehe: d.readUInt32BE(20) };
    if (mime === 'image/gif' && d.length >= 10) return { breite: d.readUInt16LE(6), hoehe: d.readUInt16LE(8) };
    if (mime === 'image/jpeg' && d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
      let i = 2;
      while (i + 9 < d.length) {
        if (d[i] !== 0xff) { i++; continue; }
        const marker = d[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
        const laenge = d.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { hoehe: d.readUInt16BE(i + 5), breite: d.readUInt16BE(i + 7) };
        }
        i += 2 + laenge;
      }
    }
  } finally { await fh.close(); }
  return undefined;
}

async function opInfo({ wurzel, pfad }) {
  const rel = relPruefen(pfad);
  const abs = await sicherAufloesen(wurzel, rel);
  const st = await lstatOderNull(abs);
  if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
  const art = artVon(st);
  const name = rel === '' ? path.basename(wurzel) : path.basename(rel);
  const aus = {
    name, pfad: rel, art, groesse: art === 'datei' ? st.size : null, geaendert: st.mtime.toISOString(), erstellt: st.birthtime.toISOString(),
    rechte: rechteText(st.mode), besitzer: { uid: st.uid, gid: st.gid }, mime: art === 'datei' ? mimeVon(name) : (art === 'ordner' ? 'inode/directory' : 'inode/symlink'),
  };
  if (art === 'ordner') { try { aus.eintraege = (await fs.readdir(abs)).filter((n) => !(rel === '' && n === PAPIERKORB)).length; } catch { aus.eintraege = null; } }
  if (art === 'datei') { try { const m = await bildmasse(abs, aus.mime); if (m) aus.bild = m; } catch { /* kein Bild */ } }
  if (art === 'link') { try { aus.ziel = await fs.readlink(abs); } catch { /* egal */ } }
  return aus;
}

/**
 * Prüft vor einem Hochladen: Elternordner vorhanden und beschreibbar, Ziel (falls da) ist kein Ordner, und – bei
 * `bei_vorhanden` „fehler“ (Standard) – dass es den Namen noch nicht gibt. Liefert zusätzlich den Pfad der versteckten
 * Zwischendatei im selben Ordner, in die der Datenkanal schreibt (siehe opUploadAbschliessen).
 */
async function opPruefeSchreiben({ wurzel, pfad, bei_vorhanden = 'fehler' }) {
  const rel = relPruefen(pfad);
  if (rel === '') throw new FahnasFehler('E_PARAMS', 'Dateiname fehlt', { feld: 'pfad' });
  if (!BEI_VORHANDEN.includes(bei_vorhanden)) throw new FahnasFehler('E_PARAMS', 'bei_vorhanden ungültig', { feld: 'bei_vorhanden' });
  const abs = await sicherAufloesen(wurzel, rel);
  const eltern = await elternSchreibbar(abs);
  const zst = await lstatOderNull(abs);
  const name = path.basename(rel);
  if (zst && zst.isDirectory() && bei_vorhanden !== 'beide') throw new FahnasFehler('E_EXISTIERT', 'Am Ziel liegt ein Ordner mit diesem Namen', { feld: 'pfad', name });
  if (zst && bei_vorhanden === 'fehler') throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es hier schon`, { feld: 'pfad', name });
  const tmp = path.join(eltern, `${UPLOAD_PRAEFIX}${crypto.randomBytes(8).toString('hex')}`);
  return { pfad: abs, tmp, dateiname: name, existiert: !!zst, mime: mimeVon(rel) };
}

/** Zwischendatei eines Uploads: muss im Zielordner liegen und das Präfix tragen (nichts anderes wird angefasst). */
async function uploadTmp(wurzel, rel, tmp) {
  const ziel = await sicherAufloesen(wurzel, rel);
  const ordner = path.dirname(ziel);
  if (typeof tmp !== 'string' || path.dirname(tmp) !== ordner || !path.basename(tmp).startsWith(UPLOAD_PRAEFIX)) {
    throw new FahnasFehler('E_PARAMS', 'Zwischendatei ungültig', { feld: 'tmp' });
  }
  return { ziel, ordner };
}

/**
 * Schließt ein vollständiges Hochladen ab: Zwischendatei → Ziel. „fehler“: nur, wenn der Name noch frei ist
 * (atomar per hartem Link). „beide“: bei belegtem Namen „Name (n).ext“. „ersetzen“: die bisherige Datei kommt in den
 * Papierkorb (als harter Link, damit das Ersetzen per rename atomar bleibt – ein Leser sieht nie eine halbe Datei),
 * ohne Papierkorb ersetzt rename sie direkt. Bei jedem Fehler verschwindet die Zwischendatei.
 */
/** Elternordner einer Zieldatei: vorhanden, ein Ordner und für den Nutzer beschreibbar (Upload und Texteditor). */
async function elternSchreibbar(abs) {
  const eltern = path.dirname(abs);
  const est = await lstatOderNull(eltern);
  if (!est || !est.isDirectory()) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Zielordner nicht gefunden', { feld: 'pfad' });
  try { await fs.access(eltern, fsSync.constants.W_OK); } catch { throw new FahnasFehler('E_RECHTE', 'In diesem Ordner darfst du nicht schreiben', { feld: 'pfad' }); }
  return eltern;
}

/** Höchstgröße einer Textdatei aus dem Editor in Bytes (Plan 01). */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Stand einer Datei, wie ihn dateien.liste/dateien.info melden (mtime als ISO mit Millisekunden + Größe). */
function standVon(st) { return { geaendert: st.mtime.toISOString(), groesse: st.size }; }

/**
 * Rechte-Bits der ersetzten Datei auf die neue übertragen. Auf Laufwerken ohne Unix-Rechte (FAT/exFAT/NTFS – dort
 * gehört jede Datei root) geht chmod nicht (EPERM/ENOTSUP); dann bleiben die Bits, wie das Dateisystem sie vorgibt.
 */
async function modusUebernehmen(datei, modus) {
  if (modus === null || modus === undefined) return;
  if (((await fs.stat(datei)).mode & 0o7777) === modus) return;
  try { await fs.chmod(datei, modus); } catch (e) { if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(e && e.code)) throw e; }
}

/** Wurde die Datei seit dem Laden geändert (SMB, anderes Fenster)? Dann nie still überschreiben → E_GEAENDERT. */
function standPruefen(st, erwartet) {
  if (!erwartet) return;
  const jetzt = standVon(st);
  if (jetzt.geaendert !== erwartet.geaendert || jetzt.groesse !== erwartet.groesse) throw new FahnasFehler('E_GEAENDERT', 'Die Datei wurde inzwischen geändert', jetzt);
}

/**
 * Texteditor: Inhalt atomar schreiben (Zwischendatei im selben Ordner, fsync, rename). Ohne `neu` muss die Datei da
 * sein; mit `erwartet` wird der Stand vorher UND direkt vor dem Tausch geprüft. Rechte-Bits der alten Datei bleiben.
 * `neu` legt exklusiv an (vorhanden → E_EXISTIERT). Kein Papierkorb – ältere Fassungen holen Schnappschüsse zurück.
 */
async function opTextSchreiben({ wurzel, pfad, inhalt = '', erwartet = null, neu = false }) {
  if (typeof inhalt !== 'string') throw new FahnasFehler('E_PARAMS', 'Inhalt fehlt', { feld: 'inhalt' });
  const daten = Buffer.from(inhalt, 'utf8');
  if (daten.length > TEXT_MAX_BYTES) throw new FahnasFehler('E_PARAMS', 'Die Datei wäre größer als 2 MiB', { feld: 'inhalt', max: TEXT_MAX_BYTES });
  const rel = relPruefen(pfad);
  if (rel === '') throw new FahnasFehler('E_PARAMS', 'Dateiname fehlt', { feld: 'pfad' });
  const abs = await sicherAufloesen(wurzel, rel);
  const eltern = await elternSchreibbar(abs);
  const name = path.basename(rel);
  let modus = null;
  if (neu) {
    if (await lstatOderNull(abs)) throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es hier schon`, { feld: 'pfad', name });
  } else {
    const st = await lstatOderNull(abs);
    if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${name}“ gibt es nicht`, { feld: 'pfad', name });
    if (!st.isFile()) throw new FahnasFehler('E_PARAMS', `„${name}“ ist keine Textdatei`, { feld: 'pfad', name });
    standPruefen(st, erwartet);
    modus = st.mode & 0o7777;
  }
  const tmp = path.join(eltern, `${UPLOAD_PRAEFIX}${crypto.randomBytes(8).toString('hex')}`);
  try {
    const fh = await fs.open(tmp, 'wx', modus ?? 0o666);
    try { await fh.writeFile(daten); await fh.sync(); } finally { await fh.close(); }
    await modusUebernehmen(tmp, modus); // open unterliegt der umask – die alten Bits ausdrücklich setzen
    if (neu) {
      if (!(await ablegenOhneErsetzen(tmp, abs))) throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es hier schon`, { feld: 'pfad', name });
    } else {
      const st = await lstatOderNull(abs);
      if (!st) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${name}“ gibt es nicht mehr`, { feld: 'pfad', name });
      standPruefen(st, erwartet);
      await fs.rename(tmp, abs);
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {}); // nach Erfolg schon weg; nach Fehler aufräumen
  }
  return { pfad: rel, name, ...standVon(await fs.lstat(abs)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Office-Bündel (Plan 04, V13): anlegen, lesen, schreiben – als der Nutzer, atomar, mit Stand-Prüfung
// ---------------------------------------------------------------------------------------------------------------

/** Pfad eines Bündels prüfen und auflösen → {rel, abs, name, art}. */
async function buendelPfad(wurzel, rel) {
  const r = relPruefen(rel);
  const name = r.split('/').pop();
  const art = artAusName(name);
  if (!r || !art) throw new FahnasFehler('E_PARAMS', 'Das ist kein Office-Dokument', { feld: 'pfad' });
  const abs = await sicherAufloesen(wurzel, r);
  const st = await lstatOderNull(abs);
  if (!st || !st.isDirectory()) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${name}“ gibt es nicht`, { feld: 'pfad', name });
  return { rel: r, abs, name, art };
}

/** inhalt.json muss ein FAH-Office-Dokument passender Art sein und darf nicht aus einer neueren Fassung stammen. */
function inhaltPruefen(inhalt, art) {
  const kaputt = (meldung) => new FahnasFehler('E_PARAMS', meldung, { feld: 'inhalt' });
  if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt) || inhalt.format !== 'fah-office') throw kaputt('Das Office-Dokument ist beschädigt');
  if (!OFFICE_ARTEN.includes(inhalt.art) || inhalt.art !== art) throw kaputt('Die Art des Office-Dokuments passt nicht zur Endung');
  if (!Number.isInteger(inhalt.schema) || inhalt.schema < 1) throw kaputt('Das Office-Dokument ist beschädigt');
  if (inhalt.schema > SCHEMA) throw kaputt('Dieses Dokument braucht eine neuere FAH-NAS-Fassung');
}

/** Verlaufszeilen lesen: kaputte überspringen, nur bis `version`, die letzten VERLAUF_MAX. */
async function verlaufLesen(datei, version) {
  let text = '';
  try { text = await fs.readFile(datei, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const aus = [];
  for (const zeile of text.split('\n')) {
    if (!zeile.trim()) continue;
    let z;
    try { z = JSON.parse(zeile); } catch { continue; }
    if (z && Number.isInteger(z.v) && z.v <= version) aus.push(z);
  }
  return aus.slice(-VERLAUF_MAX);
}

/** Text atomar in eine Datei des Bündels schreiben (Zwischendatei, fsync, rename); `pruefen` läuft direkt vor dem Tausch. */
async function buendelDateiSchreiben(abs, datei, text, modus, pruefen = null) {
  const tmp = path.join(abs, `${UPLOAD_PRAEFIX}${crypto.randomBytes(8).toString('hex')}`);
  try {
    const fh = await fs.open(tmp, 'wx', modus ?? 0o666);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    await modusUebernehmen(tmp, modus);
    if (pruefen) await pruefen();
    await fs.rename(tmp, datei);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function opOfficeAnlegen({ wurzel, rel_ordner = '', name, endung, inhalt, beide = false }) {
  if (!Object.values(ENDUNGEN).includes(endung)) throw new FahnasFehler('E_PARAMS', 'Unbekannte Office-Endung', { feld: 'endung' });
  if (typeof name !== 'string' || !name || /[/\\]/.test(name) || name.startsWith('.')) throw new FahnasFehler('E_PARAMS', 'Ungültiger Name', { feld: 'name' });
  pruefeDateiname(`${name}${endung}`, 'name');
  const relOrdner = relPruefen(rel_ordner || '', 'ordner');
  if (imBuendel(relOrdner)) throw new FahnasFehler('E_PARAMS', 'In einem Office-Dokument lässt sich kein weiteres anlegen', { feld: 'ordner' });
  const ordnerAbs = await sicherAufloesen(wurzel, relOrdner);
  const ost = await lstatOderNull(ordnerAbs);
  if (!ost || !ost.isDirectory()) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Zielordner nicht gefunden', { feld: 'ordner' });
  const text = JSON.stringify(inhalt);
  if (!inhalt || typeof inhalt !== 'object' || Buffer.byteLength(text, 'utf8') > INHALT_MAX_BYTES) throw new FahnasFehler('E_PARAMS', 'Inhalt fehlt oder ist zu groß', { feld: 'inhalt', max: INHALT_MAX_BYTES });
  const buendelName = beide ? await freierName(ordnerAbs, `${name}${endung}`) : `${name}${endung}`;
  const abs = path.join(ordnerAbs, buendelName);
  await elternSchreibbar(abs);
  try { await fs.mkdir(abs); } catch (e) {
    if (e.code === 'EEXIST') throw new FahnasFehler('E_EXISTIERT', `„${buendelName}“ gibt es hier schon`, { feld: 'name', name: buendelName });
    throw e;
  }
  try {
    await fs.mkdir(path.join(abs, DATEIEN_ORDNER));
    const fh = await fs.open(path.join(abs, INHALT_DATEI), 'wx', 0o666);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  } catch (e) {
    await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const rel = relOrdner ? `${relOrdner}/${buendelName}` : buendelName;
  return { pfad: rel, name: buendelName, stand: (await fs.lstat(path.join(abs, INHALT_DATEI))).mtime.toISOString() };
}

async function opOfficeLesen({ wurzel, rel, mit_verlauf = false }) {
  const b = await buendelPfad(wurzel, rel);
  const datei = path.join(b.abs, INHALT_DATEI);
  const st = await lstatOderNull(datei);
  if (!st || !st.isFile()) throw new FahnasFehler('E_PARAMS', 'Das Office-Dokument ist unvollständig', { feld: 'inhalt' });
  if (st.size > INHALT_MAX_BYTES) throw new FahnasFehler('E_PARAMS', 'Das Office-Dokument ist zu groß', { feld: 'inhalt', max: INHALT_MAX_BYTES });
  let inhalt;
  try { inhalt = JSON.parse(await fs.readFile(datei, 'utf8')); } catch { throw new FahnasFehler('E_PARAMS', 'Das Office-Dokument ist beschädigt', { feld: 'inhalt' }); }
  inhaltPruefen(inhalt, b.art);
  const aus = { inhalt, stand: st.mtime.toISOString() };
  if (mit_verlauf) aus.verlauf = await verlaufLesen(path.join(b.abs, VERLAUF_DATEI), Number.isInteger(inhalt.version) ? inhalt.version : 0);
  return aus;
}

async function opOfficeSchreiben({ wurzel, rel, inhalt, stand_vorher = null, verlauf = [], verlauf_max = VERLAUF_MAX }) {
  if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt)) throw new FahnasFehler('E_PARAMS', 'Inhalt fehlt', { feld: 'inhalt' });
  const text = JSON.stringify(inhalt);
  if (Buffer.byteLength(text, 'utf8') > INHALT_MAX_BYTES) throw new FahnasFehler('E_PARAMS', 'Das Dokument wäre größer als 32 MiB', { feld: 'inhalt', max: INHALT_MAX_BYTES });
  const b = await buendelPfad(wurzel, rel);
  const datei = path.join(b.abs, INHALT_DATEI);
  const standPruefen = async () => {
    const st = await lstatOderNull(datei);
    if (!st || !st.isFile()) throw new FahnasFehler('E_NICHT_GEFUNDEN', `„${b.name}“ gibt es nicht mehr`, { feld: 'pfad', name: b.name });
    if (stand_vorher && st.mtime.toISOString() !== stand_vorher) throw new FahnasFehler('E_GEAENDERT', 'Das Dokument wurde inzwischen geändert', standVon(st));
    return st;
  };
  const vorher = await standPruefen();
  const modus = vorher.mode & 0o7777;
  await buendelDateiSchreiben(b.abs, datei, text, modus, standPruefen);
  // erst der Inhalt, dann der Verlauf: bricht es dazwischen ab, fehlen nur Verlaufszeilen (Klienten laden dann neu)
  if (Array.isArray(verlauf) && verlauf.length) {
    const vdatei = path.join(b.abs, VERLAUF_DATEI);
    let alt = [];
    try { alt = (await fs.readFile(vdatei, 'utf8')).split('\n').filter((z) => z.trim()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const max = Number.isInteger(verlauf_max) && verlauf_max > 0 ? Math.min(verlauf_max, VERLAUF_MAX) : VERLAUF_MAX;
    const zeilen = [...alt, ...verlauf.map((z) => JSON.stringify(z))].slice(-max);
    await buendelDateiSchreiben(b.abs, vdatei, `${zeilen.join('\n')}\n`, modus);
  }
  return { stand: (await fs.lstat(datei)).mtime.toISOString() };
}

async function opUploadAbschliessen({ wurzel, pfad, tmp, bei_vorhanden = 'fehler', papierkorb = true, nutzer }) {
  const rel = relPruefen(pfad);
  if (rel === '') throw new FahnasFehler('E_PARAMS', 'Dateiname fehlt', { feld: 'pfad' });
  if (!BEI_VORHANDEN.includes(bei_vorhanden)) throw new FahnasFehler('E_PARAMS', 'bei_vorhanden ungültig', { feld: 'bei_vorhanden' });
  const { ziel, ordner } = await uploadTmp(wurzel, rel, tmp);
  const tst = await lstatOderNull(tmp);
  if (!tst || !tst.isFile()) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Die hochgeladenen Daten fehlen', { feld: 'tmp' });
  const name = path.basename(rel);
  const elternRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  try {
    if (bei_vorhanden === 'ersetzen') {
      const alt = await lstatOderNull(ziel);
      if (alt && alt.isDirectory()) throw new FahnasFehler('E_EXISTIERT', 'Am Ziel liegt ein Ordner mit diesem Namen', { feld: 'pfad', name });
      if (!alt || !papierkorb) { await fs.rename(tmp, ziel); return { pfad: rel, name, ersetzt: !!alt, umbenannt: false, papierkorb: null }; }
      const zeit = new Date();
      const korb = await korbOrdnerAnlegen(wurzel, zeit);
      const imKorb = path.join(korb.ordner, rel);
      await fs.mkdir(path.dirname(imKorb), { recursive: true });
      let verlinkt = true;
      try { await fs.link(ziel, imKorb); } catch (e) {
        if (!OHNE_HARTE_LINKS.has(e.code)) { await fs.rm(korb.ordner, { recursive: true, force: true }).catch(() => {}); throw e; }
        verlinkt = false;
        await verschiebeRobust(ziel, imKorb);
      }
      try { await fs.rename(tmp, ziel); } catch (e) {
        // Neue Version ließ sich nicht ablegen: alte an ihren Platz zurück (verlinkt: steht noch da, nur den Link weg)
        if (!verlinkt) await verschiebeRobust(imKorb, ziel).catch(() => {});
        await fs.rm(korb.ordner, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      await korbInfoSchreiben(korb.ordner, [{ pfad: rel, name, art: artVon(alt), groesse: alt.isFile() ? alt.size : null }], nutzer, zeit, 'ersetzt');
      return { pfad: rel, name, ersetzt: true, umbenannt: false, papierkorb: korb.kennung };
    }
    if (await ablegenOhneErsetzen(tmp, ziel)) return { pfad: rel, name, ersetzt: false, umbenannt: false, papierkorb: null };
    if (bei_vorhanden === 'fehler') throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es hier schon`, { feld: 'pfad', name });
    for (let versuch = 0; versuch < 20; versuch++) {
      const neu = await freierName(ordner, name);
      if (await ablegenOhneErsetzen(tmp, path.join(ordner, neu))) {
        return { pfad: elternRel ? `${elternRel}/${neu}` : neu, name: neu, ersetzt: false, umbenannt: true, papierkorb: null };
      }
    }
    throw new FahnasFehler('E_EXISTIERT', `Für „${name}“ ist kein freier Name zu finden`, { feld: 'pfad', name });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {}); // nach Erfolg schon weg; nach Fehler aufräumen
  }
}

/** Abgebrochenes/gescheitertes Hochladen: nur die Zwischendatei entfernen – das Ziel bleibt, wie es war. */
async function opUploadVerwerfen({ wurzel, pfad, tmp }) {
  const rel = relPruefen(pfad);
  await uploadTmp(wurzel, rel, tmp);
  await fs.rm(tmp, { force: true });
  return { verworfen: true };
}

/**
 * Welche der Namen (relativ zu `pfad`, auch mit Unterordnern) gibt es schon? Für die Rückfrage vor dem Hochladen und
 * vor Kopieren/Verschieben. Nicht vorhandene Namen fehlen im Ergebnis; ein fehlender Zwischenordner heißt „frei“.
 */
async function opVorhanden({ wurzel, pfad, namen }) {
  const basis = relPruefen(pfad);
  if (!Array.isArray(namen)) throw new FahnasFehler('E_PARAMS', 'namen fehlt', { feld: 'namen' });
  const vorhanden = [];
  for (const n of namen) {
    const rel = relPruefen(basis ? `${basis}/${n}` : n, 'namen');
    if (rel === basis) continue;
    let abs;
    try { abs = await sicherAufloesen(wurzel, rel); } catch (e) { if (e instanceof FahnasFehler && e.code === 'E_RECHTE') continue; throw e; }
    const st = await lstatOderNull(abs);
    if (!st) continue;
    vorhanden.push({ name: n, art: artVon(st), groesse: st.isFile() ? st.size : null, geaendert: st.mtime.toISOString() });
  }
  return { vorhanden };
}

/**
 * Größe eines Ordners samt Unterordnern (Betreiber 15.10.2026: „bei ext. festplatten sieht man die ordnergröße nicht“):
 * Summe der Dateigrößen, Links werden nicht verfolgt, der Papierkorb der Freigabe zählt nicht. Nach `zeitlimit_ms`
 * bricht der Lauf ab und meldet vollstaendig:false (Anzeige „≥ …“). Unlesbare Unterordner werden übersprungen.
 */
async function opOrdnergroesse({ wurzel, pfad, zeitlimit_ms = 20_000 }) {
  const rel = relPruefen(pfad);
  const abs = await sicherAufloesen(wurzel, rel);
  const st = await lstatOderNull(abs);
  if (!st || !st.isDirectory()) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Ordner nicht gefunden', { feld: 'pfad' });
  const ende = Date.now() + Math.min(Math.max(Number(zeitlimit_ms) || 20_000, 1000), 60_000);
  const wurzelEcht = await sicherAufloesen(wurzel, ''); // Wurzel aufgelöst wie abs (Symlinks im Pfad, z. B. /var → /private/var)
  let groesse = 0; let dateien = 0; let ordner = 0; let vollstaendig = true; let uebersprungen = 0;
  const stapel = [abs];
  while (stapel.length) {
    if (Date.now() > ende) { vollstaendig = false; break; }
    const dir = stapel.pop();
    let eintraege;
    try { eintraege = await fs.readdir(dir, { withFileTypes: true }); } catch { uebersprungen++; continue; }
    for (const e of eintraege) {
      if (dir === wurzelEcht && e.name === PAPIERKORB) continue;
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { ordner++; stapel.push(voll); continue; }
      if (!e.isFile()) continue;
      try { groesse += (await fs.lstat(voll)).size; dateien++; } catch { /* inzwischen weg */ }
    }
  }
  return { groesse, dateien, ordner, vollstaendig, uebersprungen };
}

const OPS = {
  liste: opListe,
  ordnergroesse: opOrdnergroesse,
  ordner: opOrdner,
  umbenennen: opUmbenennen,
  umbenennen_serie: opUmbenennenSerie,
  verschieben: (p) => uebertragen(p, 'verschieben'),
  kopieren: (p) => uebertragen(p, 'kopieren'),
  loeschen: opLoeschen,
  papierkorb_liste: opPapierkorbListe,
  papierkorb_wiederherstellen: opPapierkorbWiederherstellen,
  papierkorb_leeren: opPapierkorbLeeren,
  info: opInfo,
  pruefe_schreiben: opPruefeSchreiben,
  text_schreiben: opTextSchreiben,
  office_anlegen: opOfficeAnlegen,
  office_lesen: opOfficeLesen,
  office_schreiben: opOfficeSchreiben,
  upload_abschliessen: opUploadAbschliessen,
  upload_verwerfen: opUploadVerwerfen,
  vorhanden: opVorhanden,
  // Schnappschüsse: Wurzel = /data/.snapshots/<freigabe>/<id>, nur lesen bzw. herauskopieren
  snapshot_liste: opListe,
  snapshot_info: opInfo,
  snapshot_zurueckholen: (p) => uebertragen(p, 'snapshot'),
};

export const OPERATIONEN = Object.freeze(Object.keys(OPS));

/** Führt eine Operation aus (auch direkt im Prozess nutzbar, z. B. für Tests). */
export async function ausfuehrenOp(op, params) {
  const f = OPS[op];
  if (!f) throw new FahnasFehler('E_PARAMS', `Unbekannte Dateioperation „${op}“`, { feld: 'op' });
  if (!params || typeof params !== 'object') throw new FahnasFehler('E_PARAMS', 'Parameter fehlen');
  for (const w of ['wurzel', 'ziel_wurzel']) {
    if (params[w] !== undefined && (typeof params[w] !== 'string' || !path.isAbsolute(params[w]))) throw new FahnasFehler('E_PARAMS', `${w} muss ein absoluter Pfad sein`);
  }
  if (typeof params.wurzel !== 'string') throw new FahnasFehler('E_PARAMS', 'wurzel fehlt');
  return f(params);
}

// ---------------------------------------------------------------------------------------------------------------
// Start als Kindprozess: eine Zeile lesen, arbeiten, eine Ergebniszeile schreiben. Exit immer 0, damit der Agent
// die strukturierte Fehlermeldung bekommt (Exit ≠ 0 nur bei unlesbarer Eingabe).
// ---------------------------------------------------------------------------------------------------------------
async function stdinLesen() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const teil of process.stdin) { text += teil; if (text.includes('\n')) break; }
  return text.split('\n')[0];
}

async function hauptprogramm() {
  process.on('SIGTERM', () => { abbruch = true; });
  process.on('SIGINT', () => { abbruch = true; });
  let anfrage;
  try { anfrage = JSON.parse(await stdinLesen()); } catch { process.stderr.write('Dateihelfer: Eingabe ist kein JSON\n'); process.exit(2); }
  const op = process.argv[2] || (anfrage && anfrage.op);
  try {
    const ergebnis = await ausfuehrenOp(op, anfrage.params);
    schreibe({ ok: true, ergebnis });
  } catch (e) {
    schreibe({ fehler: FahnasFehler.aus(e).toJSON() });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hauptprogramm().then(() => process.exit(0), (e) => { process.stderr.write(`Dateihelfer: ${e && e.stack || e}\n`); process.exit(1); });
}
