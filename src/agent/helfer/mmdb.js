// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigener Leser für das MaxMind-DB-Format 2.0 (so liefert DB-IP seine freien Lite-Datenbanken) – ohne Pakete.
// Aufbau einer .mmdb: binärer Suchbaum (je Knoten zwei Einträge à 24/28/32 Bit), 16 Null-Bytes, Datenteil
// (selbstbeschreibende Werte: Map, Text, Zahlen, Zeiger …), am Ende die Kennung „\xAB\xCD\xEFMaxMind.com“ mit den
// Metadaten als Map. IPv4 liegt in IPv6-Datenbanken unter ::/96 (erst 96 Null-Bits ablaufen, Startknoten gemerkt).
// Die Datei wird NICHT ganz geladen: gelesen wird in Blöcken zu 64 KiB, höchstens 256 davon bleiben (LRU) im Speicher –
// die ~125-MB-Stadtdatenbank kostet so höchstens 16 MiB RAM. Gelesen wird synchron über den Deskriptor des
// FileHandle (fs.readSync): suche() bleibt damit synchron, ein Block kommt aus dem Seitencache in Mikrosekunden.
// Budget je Dekodier-Aufruf (Metadaten bzw. eine Suche): höchstens 20 000 Werte und 4 MiB Text/Bytes. Sonst reichen
// wenige KB mit Zeigern, die mehrfach auf dieselbe nächste Ebene zeigen („Zeiger-Bombe“), für 2^30 Werte – der Agent
// stünde minutenlang oder liefe in den Speichertod (Prüfbericht 26.09.). Ein echter Stadt-Datensatz braucht ~300 Werte.

import fs from 'node:fs/promises';
import { readSync } from 'node:fs';
import net from 'node:net';
import { ipNormal } from './netzadressen.js';

const KENNUNG = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com', 'ascii')]);
const METADATEN_MAX = 128 * 1024;  // laut Spezifikation stehen die Metadaten in den letzten 128 KiB
const TRENNER = 16;                // Null-Bytes zwischen Suchbaum und Datenteil
const MAX_TIEFE = 64;              // Verschachtelung + Zeiger; schützt vor Zeigerschleifen in kaputten Dateien
const MAX_WERTE = 20_000;          // erzeugte Werte je Dekodier-Aufruf (Zeiger zählen mit)
const MAX_BYTES = 4 * 1024 * 1024; // dekodierte Text-/Byte-Inhalte je Dekodier-Aufruf
export const BUDGET = Object.freeze({ werte: MAX_WERTE, bytes: MAX_BYTES });
const UINT_MAX_BYTES = { 5: 2, 6: 4, 8: 4, 9: 8, 10: 16 };

function kaputt(text) { return new Error(`MMDB: ${text}`); }
function zuGross() { return new Error('MMDB kaputt (zu groß)'); }

/** Liest die zwei Einträge eines Knotens ab `o` (24: 3+3 Byte, 28: 3 + geteiltes Mittelbyte + 3, 32: 4+4). */
function knoten(b, o, recordSize) {
  if (recordSize === 24) return [b.readUIntBE(o, 3), b.readUIntBE(o + 3, 3)];
  if (recordSize === 28) {
    const mitte = b[o + 3];
    return [((mitte & 0xf0) << 20) | b.readUIntBE(o, 3), ((mitte & 0x0f) << 24) | b.readUIntBE(o + 4, 3)];
  }
  return [b.readUInt32BE(o), b.readUInt32BE(o + 4)];
}

/** Vorzeichenlose Zahl aus 0–16 Byte; über 2^53 bleibt sie BigInt (sonst verlöre sie Stellen). */
function uint(b) {
  if (b.length === 0) return 0;
  if (b.length <= 6) return b.readUIntBE(0, b.length);
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x;
}

/**
 * Dekoder für einen Datenbereich. `lese(pos, laenge)` liefert genau `laenge` Bytes oder wirft; Zeigerziele zählen ab
 * `basis` (Anfang des Datenteils bzw. der Metadaten). Rückgabe je Wert: [wert, position dahinter].
 * Jeder Aufruf des zurückgegebenen Dekoders hat ein frisches Budget (Werte und Bytes, siehe oben).
 */
function erzeugeDekoder(lese, basis) {
  let werte = 0; let bytes = 0;
  /** Text-/Byte-Inhalt zählen, BEVOR er gelesen und kopiert wird. */
  const inhalt = (n) => { bytes += n; if (bytes > MAX_BYTES) throw zuGross(); };
  function dekodiere(pos, tiefe) {
    if (tiefe > MAX_TIEFE) throw kaputt('Daten zu tief verschachtelt (Zeigerschleife?)');
    if (++werte > MAX_WERTE) throw zuGross();
    const ctrl = lese(pos, 1)[0]; pos += 1;
    let typ = ctrl >> 5;
    if (typ === 1) { // Zeiger: Größenfeld ss (2 Bit) + 3 Bit Wert, dann 1–4 Byte
      const ss = (ctrl >> 3) & 3; const vvv = ctrl & 7;
      const b = lese(pos, ss + 1); pos += ss + 1;
      let ziel;
      if (ss === 0) ziel = (vvv << 8) | b[0];
      else if (ss === 1) ziel = 2048 + ((vvv << 16) | (b[0] << 8) | b[1]);
      else if (ss === 2) ziel = 526336 + vvv * 0x1000000 + ((b[0] << 16) | (b[1] << 8) | b[2]);
      else ziel = b.readUInt32BE(0);
      return [dekodiere(basis + ziel, tiefe + 1)[0], pos];
    }
    if (typ === 0) { // erweiterter Typ im Folgebyte (+7)
      typ = 7 + lese(pos, 1)[0]; pos += 1;
      if (typ < 8 || typ > 15) throw kaputt(`unbekannter Datentyp ${typ}`);
    }
    let groesse = ctrl & 31;
    if (groesse >= 29) {
      const n = groesse - 28; const b = lese(pos, n); pos += n;
      if (n === 1) groesse = 29 + b[0];
      else if (n === 2) groesse = 285 + ((b[0] << 8) | b[1]);
      else groesse = 65821 + ((b[0] << 16) | (b[1] << 8) | b[2]);
    }
    switch (typ) {
      case 2: inhalt(groesse); return [lese(pos, groesse).toString('utf8'), pos + groesse];
      case 3:
        if (groesse !== 8) throw kaputt(`double mit ${groesse} Byte`);
        return [lese(pos, 8).readDoubleBE(0), pos + 8];
      case 4: inhalt(groesse); return [Buffer.from(lese(pos, groesse)), pos + groesse];
      case 5: case 6: case 9: case 10:
        if (groesse > UINT_MAX_BYTES[typ]) throw kaputt(`Ganzzahl (Typ ${typ}) mit ${groesse} Byte`);
        return [uint(lese(pos, groesse)), pos + groesse];
      case 8: { // int32: Zweierkomplement, kürzere Formen sind positiv (links mit Nullen aufgefüllt)
        if (groesse > 4) throw kaputt(`int32 mit ${groesse} Byte`);
        const b = lese(pos, groesse);
        return [groesse === 4 ? b.readInt32BE(0) : uint(b), pos + groesse];
      }
      case 7: { // Map: groesse Paare, Schlüssel sind Texte (oft als Zeiger)
        const obj = {};
        for (let i = 0; i < groesse; i++) {
          const [k, p1] = dekodiere(pos, tiefe + 1);
          if (typeof k !== 'string') throw kaputt('Map-Schlüssel ist kein Text');
          const [v, p2] = dekodiere(p1, tiefe + 1);
          if (k === '__proto__') Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
          else obj[k] = v;
          pos = p2;
        }
        return [obj, pos];
      }
      case 11: {
        const liste = [];
        for (let i = 0; i < groesse; i++) { const [v, p] = dekodiere(pos, tiefe + 1); liste.push(v); pos = p; }
        return [liste, pos];
      }
      case 12: return [null, pos + groesse]; // Daten-Cache-Container: nur für Schreibwerkzeuge, hier bedeutungslos
      case 13: return [null, pos];           // Endmarke
      case 14:
        if (groesse > 1) throw kaputt(`boolean mit Wert ${groesse}`);
        return [groesse === 1, pos];
      case 15:
        if (groesse !== 4) throw kaputt(`float mit ${groesse} Byte`);
        return [lese(pos, 4).readFloatBE(0), pos + 4];
      default: throw kaputt(`unbekannter Datentyp ${typ}`);
    }
  }
  return (pos) => { werte = 0; bytes = 0; return dekodiere(pos, 0)[0]; };
}

/** Adresse → 4 bzw. 16 Bytes (nach ipNormal: Zone weg, ::ffff:-Abbild als IPv4, IPv6 kanonisch). Unsinn → null. */
function adressBytes(ip) {
  const a = ipNormal(ip);
  if (!a) return null;
  if (net.isIPv4(a)) return Uint8Array.from(a.split('.').map(Number));
  const teile = a.split('::');
  const links = teile[0] ? teile[0].split(':') : [];
  const rechts = teile.length > 1 && teile[1] ? teile[1].split(':') : [];
  const hinten = teile.length > 1 ? rechts : links;
  if (hinten.length && hinten[hinten.length - 1].includes('.')) { // eingebettetes IPv4 → zwei Gruppen
    const v4 = hinten.pop().split('.').map(Number);
    hinten.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const gruppen = teile.length > 1 ? [...links, ...Array(8 - links.length - rechts.length).fill('0'), ...rechts] : links;
  if (gruppen.length !== 8) return null;
  const b = new Uint8Array(16);
  gruppen.forEach((g, i) => { const x = parseInt(g, 16); b[2 * i] = x >> 8; b[2 * i + 1] = x & 255; });
  return b;
}

/**
 * Öffnet eine MMDB-Datei.
 * @param {string} pfad
 * @param {{blockGroesse?:number, maxBloecke?:number}} [optionen]  nur für Tests verändern
 * @returns {Promise<{metadaten:object, suche:(ip:string)=>object|null, schliessen:()=>Promise<void>, _statistik:()=>object}>}
 */
export async function oeffneMmdb(pfad, { blockGroesse = 64 * 1024, maxBloecke = 256 } = {}) {
  if (!Number.isInteger(blockGroesse) || blockGroesse < 16) throw new Error('MMDB: blockGroesse ungültig');
  if (!Number.isInteger(maxBloecke) || maxBloecke < 1) throw new Error('MMDB: maxBloecke ungültig');
  const fh = await fs.open(pfad, 'r');
  try {
    const { size } = await fh.stat();
    if (size < KENNUNG.length) throw kaputt('Datei zu klein');
    // Metadaten: letzte Kennung in den letzten 128 KiB, dahinter eine Map
    const schwanzLaenge = Math.min(size, METADATEN_MAX + KENNUNG.length);
    const schwanz = Buffer.alloc(schwanzLaenge);
    await fh.read(schwanz, 0, schwanzLaenge, size - schwanzLaenge);
    const idx = schwanz.lastIndexOf(KENNUNG);
    if (idx < 0) throw kaputt('Metadaten-Kennung fehlt – keine MaxMind-Datenbank');
    const kennungPos = size - schwanzLaenge + idx; // Ende von Suchbaum + Datenteil
    const metaStart = idx + KENNUNG.length;
    const leseSchwanz = (pos, laenge) => {
      if (pos < metaStart || pos + laenge > schwanz.length) throw kaputt('Metadaten abgeschnitten');
      return schwanz.subarray(pos, pos + laenge);
    };
    let metadaten;
    try { metadaten = erzeugeDekoder(leseSchwanz, metaStart)(metaStart); } catch (e) { throw kaputt(`Metadaten unlesbar (${e.message})`); }
    if (!metadaten || typeof metadaten !== 'object' || Array.isArray(metadaten) || Buffer.isBuffer(metadaten)) throw kaputt('Metadaten sind keine Map');
    const { node_count: anzahl, record_size: recordSize, ip_version: ipVersion } = metadaten;
    if (!Number.isInteger(anzahl) || anzahl <= 0) throw kaputt('node_count fehlt oder ist 0');
    if (![24, 28, 32].includes(recordSize)) throw kaputt(`record_size ${recordSize} wird nicht unterstützt`);
    if (ipVersion !== 4 && ipVersion !== 6) throw kaputt(`ip_version ${ipVersion} ungültig`);
    if (metadaten.binary_format_major_version !== 2) throw kaputt(`Formatversion ${metadaten.binary_format_major_version} wird nicht unterstützt`);
    const knotenBytes = recordSize / 4;
    const baumGroesse = anzahl * knotenBytes;
    const datenStart = baumGroesse + TRENNER;
    if (datenStart > kennungPos) throw kaputt('Suchbaum größer als die Datei');

    // Blockweises Lesen mit LRU-Zwischenspeicher (Map behält die Einfügereihenfolge: vorne = am längsten unbenutzt)
    const bloecke = new Map();
    const statistik = { gelesen: 0 };
    let geschlossen = false;
    let zuletzt = -1; let zuletztBlock = null; // schneller Pfad: derselbe Block wie eben (ohne LRU-Umsortieren)
    const block = (nr) => {
      if (nr === zuletzt) return zuletztBlock;
      let b = bloecke.get(nr);
      if (b) { bloecke.delete(nr); bloecke.set(nr, b); zuletzt = nr; zuletztBlock = b; return b; }
      const start = nr * blockGroesse;
      const laenge = Math.min(blockGroesse, size - start);
      b = Buffer.allocUnsafe(laenge);
      for (let gelesen = 0; gelesen < laenge;) {
        const n = readSync(fh.fd, b, gelesen, laenge - gelesen, start + gelesen);
        if (n === 0) throw kaputt('Datei kürzer als erwartet');
        gelesen += n;
      }
      statistik.gelesen += 1;
      bloecke.set(nr, b);
      if (bloecke.size > maxBloecke) bloecke.delete(bloecke.keys().next().value);
      zuletzt = nr; zuletztBlock = b;
      return b;
    };
    const lese = (pos, laenge) => {
      if (geschlossen) throw kaputt('Datenbank ist geschlossen');
      if (!Number.isSafeInteger(pos) || pos < 0 || pos + laenge > kennungPos) throw kaputt('Verweis außerhalb der Datei (beschädigt?)');
      const nr = Math.floor(pos / blockGroesse);
      const b = block(nr);
      const off = pos - nr * blockGroesse;
      if (off + laenge <= b.length) return b.subarray(off, off + laenge);
      const aus = Buffer.allocUnsafe(laenge); // über Blockgrenzen: stückweise zusammensetzen
      for (let kopiert = 0; kopiert < laenge;) {
        const p = pos + kopiert; const n2 = Math.floor(p / blockGroesse); const o2 = p - n2 * blockGroesse;
        const bb = block(n2); const k = Math.min(bb.length - o2, laenge - kopiert);
        bb.copy(aus, kopiert, o2, o2 + k); kopiert += k;
      }
      return aus;
    };
    const dekodiere = erzeugeDekoder(lese, datenStart);
    const eintrag = (nr, bit) => { // Knoten meist direkt aus dem Block (ohne Zwischenpuffer), nur an Blockgrenzen über lese()
      const pos = nr * knotenBytes;
      const bnr = Math.floor(pos / blockGroesse); const off = pos - bnr * blockGroesse;
      if (!geschlossen && pos + knotenBytes <= kennungPos) {
        const b = block(bnr);
        if (off + knotenBytes <= b.length) return knoten(b, off, recordSize)[bit];
      }
      return knoten(lese(pos, knotenBytes), 0, recordSize)[bit];
    };

    // IPv4 in einer IPv6-Datenbank: 96 Null-Bits ab der Wurzel – der erreichte Knoten ist der Start aller IPv4-Suchen
    let v4Start = 0;
    if (ipVersion === 6) for (let i = 0; i < 96 && v4Start < anzahl; i++) v4Start = eintrag(v4Start, 0);

    function suche(ip) {
      if (geschlossen) throw kaputt('Datenbank ist geschlossen');
      const bytes = adressBytes(ip);
      if (!bytes) return null;
      if (bytes.length === 16 && ipVersion === 4) return null;
      let nr = bytes.length === 4 && ipVersion === 6 ? v4Start : 0;
      for (let i = 0; i < bytes.length * 8 && nr < anzahl; i++) nr = eintrag(nr, (bytes[i >> 3] >> (7 - (i & 7))) & 1);
      if (nr === anzahl) return null;                                   // kein Eintrag für diese Adresse
      if (nr < anzahl) throw kaputt('Suchbaum endet nicht in einem Eintrag');
      return dekodiere(datenStart + (nr - anzahl - TRENNER));
    }

    async function schliessen() {
      if (geschlossen) return;
      geschlossen = true;
      bloecke.clear(); zuletzt = -1; zuletztBlock = null;
      await fh.close();
    }

    return {
      metadaten, suche, schliessen,
      _statistik: () => ({ bloecke: bloecke.size, gelesen: statistik.gelesen, blockGroesse, maxBloecke }),
    };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

export const _test = { knoten, adressBytes };
