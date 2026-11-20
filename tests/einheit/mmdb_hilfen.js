// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kleiner MMDB-Schreiber NUR für Tests (MaxMind-DB-Format 2.0): Suchbaum (IPv6 mit IPv4 unter ::/96 oder reines
// IPv4, record_size 24/28/32), Datenteil mit allen Datentypen und Zeigern, Metadaten hinter der Kennung
// „\xAB\xCD\xEFMaxMind.com“. Damit prüfen mmdb.test.js und geo.test.js den eigenen Leser ohne echte Datenbank und
// ohne Netz. Absichtlich unabhängig vom Leser geschrieben (eigene Adress-Zerlegung), damit sich Fehler nicht
// gegenseitig aufheben.

import net from 'node:net';
import { createHash } from 'node:crypto';

export const MARKE = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com', 'ascii')]);

/** Typ-Hüllen für eine eindeutige Kodierung (JS-Zahlen allein sind mehrdeutig). */
export const T = {
  u16: (w) => ({ $typ: 'uint16', w: BigInt(w) }),
  u32: (w) => ({ $typ: 'uint32', w: BigInt(w) }),
  u64: (w) => ({ $typ: 'uint64', w: BigInt(w) }),
  u128: (w) => ({ $typ: 'uint128', w: BigInt(w) }),
  i32: (w) => ({ $typ: 'int32', w }),
  f32: (w) => ({ $typ: 'float', w }),
  dbl: (w) => ({ $typ: 'double', w }),
  /** Rohe Bytes unverändert in den Datenteil (z. B. Daten-Cache-Container oder Endmarke). */
  roh: (w) => ({ $typ: 'roh', w: Buffer.from(w) }),
};

const TYP = { zeiger: 1, utf8: 2, double: 3, bytes: 4, uint16: 5, uint32: 6, map: 7, int32: 8, uint64: 9, uint128: 10,
  array: 11, boolean: 14, float: 15 };

/** Kontrollbyte(s): Typ (3 Bit bzw. erweitert im Folgebyte) + Größe (5 Bit, 29/30/31 mit 1/2/3 Folgebytes). */
function kopf(typ, groesse) {
  let ctrl = typ <= 7 ? typ << 5 : 0;
  const ext = typ <= 7 ? [] : [typ - 7];
  let gross = [];
  if (groesse < 29) ctrl |= groesse;
  else if (groesse < 285) { ctrl |= 29; gross = [groesse - 29]; }
  else if (groesse < 65821) { ctrl |= 30; const g = groesse - 285; gross = [g >> 8, g & 255]; }
  else { ctrl |= 31; const g = groesse - 65821; gross = [(g >> 16) & 255, (g >> 8) & 255, g & 255]; }
  return Buffer.from([ctrl, ...ext, ...gross]);
}

/** Zeiger (Typ 1) in der kleinsten passenden Form – oder immer 32 Bit (ss=3), wenn erzwungen. */
function zeiger(p, immer32) {
  if (!immer32 && p < 2048) return Buffer.from([0x20 | (p >> 8), p & 255]);
  if (!immer32 && p < 526336) { const q = p - 2048; return Buffer.from([0x28 | (q >> 16), (q >> 8) & 255, q & 255]); }
  if (!immer32 && p < 134744064) { const q = p - 526336; return Buffer.from([0x30 | (q >> 24), (q >> 16) & 255, (q >> 8) & 255, q & 255]); }
  const b = Buffer.alloc(5); b[0] = 0x38; b.writeUInt32BE(p, 1); return b;
}

/** Vorzeichenlose Zahl mit so wenigen Bytes wie nötig (0 → keine Bytes). */
function uintBytes(w) {
  const bytes = [];
  for (let x = BigInt(w); x > 0n; x >>= 8n) bytes.unshift(Number(x & 255n));
  return Buffer.from(bytes);
}

/** Schlüssel zum Wiederfinden gleicher Werte (Zeiger-Teilen); Buffer als Prüfsumme, BigInt als Text. */
function schluessel(wert) {
  return JSON.stringify(wert, function ersetzen(k, v) {
    const roh = this[k];
    if (Buffer.isBuffer(roh)) return `buf:${createHash('sha1').update(roh).digest('hex')}`;
    if (typeof v === 'bigint') return `big:${v}`;
    return v;
  });
}

/** Datenteil: hängt kodierte Werte an und merkt sich, wo Zeichenketten/Maps/Arrays schon liegen (Zeiger-Teilen). */
class Datenteil {
  constructor({ teilen = true, zeiger32 = false } = {}) {
    this.teile = []; this.laenge = 0; this.bekannt = new Map(); this.datensaetze = new Map();
    this.teilen = teilen; this.zeiger32 = zeiger32;
  }
  anhaengen(b) { this.teile.push(b); this.laenge += b.length; }
  puffer() { return Buffer.concat(this.teile); }

  /** Oberster Datensatz eines Netzes: gleiche Datensätze teilen sich eine Stelle (wie in echten Datenbanken). */
  datensatz(wert) {
    const k = schluessel(wert);
    if (this.datensaetze.has(k)) return this.datensaetze.get(k);
    const off = this.laenge;
    this.wert(wert, true);
    this.datensaetze.set(k, off);
    return off;
  }

  wert(w, oberster = false) {
    const teilbar = this.teilen && !oberster && (typeof w === 'string' || Array.isArray(w)
      || (w && typeof w === 'object' && !w.$typ && !Buffer.isBuffer(w) && !(w instanceof Uint8Array)));
    if (teilbar) {
      const k = schluessel(w);
      if (this.bekannt.has(k)) { this.anhaengen(zeiger(this.bekannt.get(k), this.zeiger32)); return; }
      this.bekannt.set(k, this.laenge);
    }
    if (typeof w === 'string') { const b = Buffer.from(w, 'utf8'); this.anhaengen(kopf(TYP.utf8, b.length)); this.anhaengen(b); return; }
    if (typeof w === 'boolean') { this.anhaengen(kopf(TYP.boolean, w ? 1 : 0)); return; }
    if (typeof w === 'bigint') { this.wert(w < 2n ** 64n ? T.u64(w) : T.u128(w)); return; }
    if (typeof w === 'number') {
      if (Number.isInteger(w) && w >= 0 && w <= 0xffffffff) { this.wert(T.u32(w)); return; }
      if (Number.isInteger(w) && w < 0 && w >= -(2 ** 31)) { this.wert(T.i32(w)); return; }
      this.wert(T.dbl(w)); return;
    }
    if (Buffer.isBuffer(w) || w instanceof Uint8Array) { this.anhaengen(kopf(TYP.bytes, w.length)); this.anhaengen(Buffer.from(w)); return; }
    if (Array.isArray(w)) { this.anhaengen(kopf(TYP.array, w.length)); for (const x of w) this.wert(x); return; }
    if (w && w.$typ) {
      switch (w.$typ) {
        case 'uint16': case 'uint32': case 'uint64': case 'uint128': {
          const b = uintBytes(w.w); this.anhaengen(kopf(TYP[w.$typ], b.length)); this.anhaengen(b); return;
        }
        case 'int32': {
          let b;
          if (w.w < 0) { b = Buffer.alloc(4); b.writeInt32BE(w.w); } else b = uintBytes(w.w);
          this.anhaengen(kopf(TYP.int32, b.length)); this.anhaengen(b); return;
        }
        case 'double': { const b = Buffer.alloc(8); b.writeDoubleBE(w.w); this.anhaengen(kopf(TYP.double, 8)); this.anhaengen(b); return; }
        case 'float': { const b = Buffer.alloc(4); b.writeFloatBE(w.w); this.anhaengen(kopf(TYP.float, 4)); this.anhaengen(b); return; }
        case 'roh': this.anhaengen(w.w); return;
        default: throw new Error(`Unbekannter Testtyp ${w.$typ}`);
      }
    }
    if (w && typeof w === 'object') {
      const paare = Object.entries(w).filter(([, v]) => v !== undefined); // undefined = Feld weglassen
      this.anhaengen(kopf(TYP.map, paare.length));
      for (const [k, v] of paare) { this.wert(k); this.wert(v); }
      return;
    }
    throw new Error(`Nicht kodierbar: ${String(w)}`);
  }
}

/** Adresse → Bytes (IPv4 4, IPv6 16), eigene Zerlegung inkl. „::“ und eingebettetem IPv4. */
function adresseBytes(a) {
  if (net.isIPv4(a)) return a.split('.').map(Number);
  if (!net.isIPv6(a)) throw new Error(`Keine Adresse: ${a}`);
  let text = a;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) { const b = v4[1].split('.').map(Number); text = text.slice(0, -v4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; }
  const [links, rechts] = text.includes('::') ? text.split('::') : [text, null];
  const l = links ? links.split(':') : [];
  const r = rechts ? rechts.split(':') : [];
  const gruppen = rechts === null ? l : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  return gruppen.flatMap((g) => { const x = parseInt(g, 16); return [x >> 8, x & 255]; });
}

/** Netz „a.b.c.d/p“ bzw. „x::/p“ → Bitfolge im Baum (IPv4 im IPv6-Baum unter ::/96). */
function netzBits(netz, ipVersion) {
  const [adr, p] = netz.split('/');
  let bytes = adresseBytes(adr);
  let praefix = Number(p);
  if (bytes.length === 4 && ipVersion === 6) { bytes = [...Array(12).fill(0), ...bytes]; praefix += 96; }
  if (bytes.length === 16 && ipVersion === 4) throw new Error('IPv6-Netz in IPv4-Datenbank');
  return { bit: (i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1, praefix };
}

const LEER = Symbol('leer');

/** Knoten mit zwei Einträgen schreiben (24: 3+3, 28: 3 + geteiltes Mittelbyte + 3, 32: 4+4 Byte). */
function schreibeKnoten(baum, i, links, rechts, recordSize) {
  const o = i * (recordSize / 4);
  if (recordSize === 24) { baum.writeUIntBE(links, o, 3); baum.writeUIntBE(rechts, o + 3, 3); }
  else if (recordSize === 28) {
    baum.writeUIntBE(links & 0xffffff, o, 3);
    baum[o + 3] = ((links >>> 24) << 4) | (rechts >>> 24);
    baum.writeUIntBE(rechts & 0xffffff, o + 4, 3);
  } else { baum.writeUInt32BE(links, o); baum.writeUInt32BE(rechts, o + 4); }
}

/**
 * Baut eine MMDB-Datei im Speicher.
 * @param {{netz:string, daten:object}[]} eintraege  spätere, spezifischere Netze überschreiben frühere
 * @param {{recordSize?:24|28|32, ipVersion?:4|6, typ?:string, teilen?:boolean, zeiger32?:boolean, metadaten?:object}} [o]
 * @returns {Buffer}
 */
export function schreibeMmdb(eintraege, { recordSize = 24, ipVersion = 6, typ = 'Test-City', teilen = true, zeiger32 = false, metadaten = {} } = {}) {
  const daten = new Datenteil({ teilen, zeiger32 });
  const knoten = [{ l: LEER, r: LEER }];
  for (const e of eintraege) {
    const ziel = { off: daten.datensatz(e.daten) };
    const { bit, praefix } = netzBits(e.netz, ipVersion);
    let n = 0;
    for (let i = 0; i < praefix; i++) {
      const seite = bit(i) ? 'r' : 'l';
      if (i === praefix - 1) { knoten[n][seite] = ziel; break; }
      let weiter = knoten[n][seite];
      if (typeof weiter !== 'number') { // leer oder Daten → neuer Knoten erbt den bisherigen Wert auf beiden Seiten
        knoten.push({ l: weiter, r: weiter }); weiter = knoten.length - 1; knoten[n][seite] = weiter;
      }
      n = weiter;
    }
  }
  const anzahl = knoten.length;
  const wert = (x) => (typeof x === 'number' ? x : x === LEER ? anzahl : anzahl + 16 + x.off);
  const baum = Buffer.alloc(anzahl * (recordSize / 4));
  knoten.forEach((k, i) => schreibeKnoten(baum, i, wert(k.l), wert(k.r), recordSize));
  const meta = new Datenteil({ teilen: false });
  meta.wert({
    node_count: T.u32(anzahl), record_size: T.u16(recordSize), ip_version: T.u16(ipVersion), database_type: typ,
    languages: ['de', 'en'], binary_format_major_version: T.u16(2), binary_format_minor_version: T.u16(0),
    build_epoch: T.u64(Date.UTC(2026, 8, 1) / 1000), description: { en: 'FAH-NAS Testdatenbank' }, ...metadaten,
  });
  return Buffer.concat([baum, Buffer.alloc(16), daten.puffer(), MARKE, meta.puffer()]);
}

// ---------------------------------------------------------------------------------------------------------------
// Bösartige Dateien (Prüfbericht 26.09.: Zeiger-Bombe) – wenige KB, beim Auspacken aber Milliarden Werte bzw. GB
// ---------------------------------------------------------------------------------------------------------------

/**
 * Zeiger-Bombe als rohe Bytes: `ebenen` Arrays mit je `k` Zeigern (immer 32 Bit, feste Länge) auf die jeweils nächste
 * Ebene, am Ende ein Text. Kein Zyklus und Tiefe < 64 – nur die Zahl der Werte wächst mit k^ebenen. Zeigerziele zählen
 * ab dem Anfang des Bereichs (Datenteil bzw. Metadaten); `basis` = Stelle, an der die erste Ebene landet.
 */
export function zeigerBombe({ ebenen = 30, k = 2, basis = 0, blatt = 'A'.repeat(100) } = {}) {
  const kopfArray = kopf(TYP.array, k);
  const ebeneLaenge = kopfArray.length + 5 * k;
  const teile = [];
  for (let i = 0; i < ebenen; i++) {
    teile.push(kopfArray);
    for (let j = 0; j < k; j++) teile.push(zeiger(basis + (i + 1) * ebeneLaenge, true));
  }
  const b = Buffer.from(blatt, 'utf8');
  teile.push(kopf(TYP.utf8, b.length), b);
  return Buffer.concat(teile);
}

/**
 * Breite Bombe als rohe Bytes: ein Array mit `anzahl` Zeigern auf denselben langen Text (`laenge` Byte) – wenige
 * Werte, aber anzahl × laenge dekodierte Bytes.
 */
export function breitenBombe({ anzahl = 100, laenge = 65_000, basis = 0 } = {}) {
  const kopfArray = kopf(TYP.array, anzahl);
  const textStelle = basis + kopfArray.length + 5 * anzahl;
  const text = Buffer.alloc(laenge, 0x42);
  return Buffer.concat([kopfArray, ...Array.from({ length: anzahl }, () => zeiger(textStelle, true)), kopf(TYP.utf8, laenge), text]);
}

/**
 * MMDB-Datei mit Bombe.
 *  • ort 'metadaten': die Metadaten-Map hat ein Feld „x“, das auf die Bombe zeigt (wie pruefung3/bombe.mjs) –
 *    oeffneMmdb muss scheitern.
 *  • ort 'daten': der Datensatz von `netz` IST die Bombe (liegt als erster Datensatz an Stelle 0 des Datenteils),
 *    `dazu` sind weitere, gesunde Einträge – suche(netz) muss scheitern, alles andere geht.
 * @param {{art?:'zeiger'|'breite', ebenen?:number, k?:number, anzahl?:number, laenge?:number, ort?:'metadaten'|'daten',
 *   netz?:string, dazu?:{netz:string, daten:object}[], typ?:string}} [o]
 */
export function schreibeBombe({ art = 'zeiger', ebenen = 30, k = 2, anzahl = 100, laenge = 65_000, ort = 'metadaten',
  netz = '8.8.8.0/24', dazu = [], typ = 'DBIP-City-Lite' } = {}) {
  const bombe = (basis) => (art === 'breite' ? breitenBombe({ anzahl, laenge, basis }) : zeigerBombe({ ebenen, k, basis }));
  if (ort === 'daten') return schreibeMmdb([{ netz, daten: T.roh(bombe(0)) }, ...dazu], { typ });
  const START = 4096; // Metadaten-Map vorn, Bombe dahinter (Zeiger ab Stelle 2048 → 32-Bit-Form, feste Länge)
  const meta = new Datenteil({ teilen: false });
  meta.wert({ node_count: T.u32(1), record_size: T.u16(24), ip_version: T.u16(6), binary_format_major_version: T.u16(2),
    database_type: typ, x: T.roh(zeiger(START, true)) });
  const map = meta.puffer();
  const baum = Buffer.alloc(6); baum.writeUIntBE(1, 0, 3); baum.writeUIntBE(1, 3, 3); // ein Knoten, beide Seiten „leer“
  return Buffer.concat([baum, Buffer.alloc(16), MARKE, map, Buffer.alloc(START - map.length), bombe(START)]);
}

/** Beispiel-Datensätze im Stil von DB-IP City Lite / Country Lite. */
export const US_STADT = { city: { names: { en: 'Mountain View' } }, continent: { code: 'NA', names: { de: 'Nordamerika', en: 'North America' } },
  country: { iso_code: 'US', names: { de: 'USA', en: 'United States' } }, location: { latitude: T.dbl(37.4), longitude: T.dbl(-122.1) } };
export const US_LAND = { continent: { code: 'NA' }, country: { iso_code: 'US', names: { de: 'USA', en: 'United States' } } };

/** Namen in den 8 Sprachen der echten DB-IP/MaxMind-Stadtdatenbanken. */
const acht = (basis) => Object.fromEntries(['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh-CN'].map((s) => [s, `${basis} (${s})`]));
/** Voller Stadt-Datensatz wie in DB-IP City bzw. GeoLite2-City (alle Teilbereiche, Namen in 8 Sprachen). */
export const VOLLER_STADTSATZ = {
  city: { geoname_id: T.u32(2867714), names: acht('München') },
  continent: { code: 'EU', geoname_id: T.u32(6255148), names: acht('Europa') },
  country: { geoname_id: T.u32(2921044), is_in_european_union: true, iso_code: 'DE', names: acht('Deutschland') },
  location: { accuracy_radius: T.u16(20), latitude: T.dbl(48.1374), longitude: T.dbl(11.5755), time_zone: 'Europe/Berlin' },
  postal: { code: '80331' },
  registered_country: { geoname_id: T.u32(2921044), is_in_european_union: true, iso_code: 'DE', names: acht('Deutschland') },
  subdivisions: [{ geoname_id: T.u32(2951839), iso_code: 'BY', names: acht('Bayern') }, { geoname_id: T.u32(2861322), names: acht('Oberbayern') }],
};
