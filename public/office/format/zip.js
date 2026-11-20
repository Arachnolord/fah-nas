// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ZIP lesen und schreiben im Browser (Plan 05, V17) – für docx und xlsx. Lesen: stored und deflate (DecompressionStream
// 'deflate-raw'), CRC-Prüfung, Schutz vor Zip-Bomben (Summe, Eintrag, Verhältnis – vor dem Entpacken und beim Entpacken
// mitgezählt, ein lügender Kopf fällt auf). Schreiben: Medien ungepackt, alles andere deflate, UTF-8-Namen, DOS-Zeit.
// Nicht unterstützt: Zip64, Verschlüsselung, andere Packverfahren. Fehler: Error('zip_kaputt' | 'zip_nicht_unterstuetzt' |
// 'zip_zu_gross').

export const ZIP_GRENZEN = Object.freeze({ summe: 209715200, eintrag: 104857600, verhaeltnis: 100 });
const MEDIEN = /\.(png|jpe?g|gif|webp)$/i;
const SIG_LOKAL = 0x04034b50;
const SIG_ZENTRAL = 0x02014b50;
const SIG_ENDE = 0x06054b50;

let crcTabelle = null;

/** CRC-32 (Polynom 0xedb88320), vorzeichenlos. */
export function crc32(bytes) {
  if (!crcTabelle) {
    crcTabelle = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTabelle[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTabelle[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesVon(daten) {
  if (daten instanceof Uint8Array) return daten;
  if (daten instanceof ArrayBuffer) return new Uint8Array(daten);
  if (ArrayBuffer.isView(daten)) return new Uint8Array(daten.buffer, daten.byteOffset, daten.byteLength);
  return null;
}

async function alleBytes(strom, max) {
  const leser = strom.getReader();
  const teile = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      n += value.length;
      if (n > max) { leser.cancel().catch(() => {}); throw new Error('zip_zu_gross'); }
      teile.push(value);
    }
  } catch (e) {
    if (e && e.message === 'zip_zu_gross') throw e;
    throw new Error('zip_kaputt');
  }
  const aus = new Uint8Array(n);
  let o = 0;
  for (const t of teile) { aus.set(t, o); o += t.length; }
  return aus;
}

const entpacken = (stueck, max) => alleBytes(new Blob([stueck]).stream().pipeThrough(new DecompressionStream('deflate-raw')), max);
const packen = async (roh) => new Uint8Array(await new Response(new Blob([roh]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());

/** ZIP lesen → Map(Name → Bytes); Ordner-Einträge fallen weg. */
export async function zipLesen(daten) {
  const b = bytesVon(daten);
  if (!b || b.length < 22) throw new Error('zip_kaputt');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let ende = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === SIG_ENDE) { ende = i; break; }
  if (ende < 0) throw new Error('zip_kaputt');
  const anzahl = dv.getUint16(ende + 10, true);
  const cdGroesse = dv.getUint32(ende + 12, true);
  const cdStart = dv.getUint32(ende + 16, true);
  if (anzahl === 0xffff || cdStart === 0xffffffff || cdGroesse === 0xffffffff) throw new Error('zip_nicht_unterstuetzt');
  if (cdStart + cdGroesse > ende) throw new Error('zip_kaputt');

  const dekoder = new TextDecoder('utf-8');
  const eintraege = [];
  const namen = new Set();
  let p = cdStart;
  for (let i = 0; i < anzahl; i++) {
    if (p + 46 > ende || dv.getUint32(p, true) !== SIG_ZENTRAL) throw new Error('zip_kaputt');
    const flag = dv.getUint16(p + 8, true);
    const methode = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const gepackt = dv.getUint32(p + 20, true);
    const ungepackt = dv.getUint32(p + 24, true);
    const nameLaenge = dv.getUint16(p + 28, true);
    const extraLaenge = dv.getUint16(p + 30, true);
    const kommentarLaenge = dv.getUint16(p + 32, true);
    const lokal = dv.getUint32(p + 42, true);
    if (p + 46 + nameLaenge > ende) throw new Error('zip_kaputt');
    const name = dekoder.decode(b.subarray(p + 46, p + 46 + nameLaenge));
    p += 46 + nameLaenge + extraLaenge + kommentarLaenge;
    if (flag & 1) throw new Error('zip_nicht_unterstuetzt');
    if (gepackt === 0xffffffff || ungepackt === 0xffffffff || lokal === 0xffffffff) throw new Error('zip_nicht_unterstuetzt');
    if (name.endsWith('/')) continue;
    if (methode !== 0 && methode !== 8) throw new Error('zip_nicht_unterstuetzt');
    if (namen.has(name)) throw new Error('zip_kaputt');
    namen.add(name);
    eintraege.push({ name, methode, crc, gepackt, ungepackt, lokal });
  }

  // Grenzen vor dem Entpacken (laut Kopf); beim Entpacken wird zusätzlich mitgezählt
  let summe = 0;
  for (const e of eintraege) {
    summe += e.ungepackt;
    if (e.ungepackt > ZIP_GRENZEN.eintrag || summe > ZIP_GRENZEN.summe) throw new Error('zip_zu_gross');
    if (e.ungepackt > ZIP_GRENZEN.verhaeltnis * Math.max(e.gepackt, 1)) throw new Error('zip_zu_gross');
  }

  const aus = new Map();
  for (const e of eintraege) {
    const q = e.lokal;
    if (q + 30 > b.length || dv.getUint32(q, true) !== SIG_LOKAL) throw new Error('zip_kaputt');
    const start = q + 30 + dv.getUint16(q + 26, true) + dv.getUint16(q + 28, true);
    if (start + e.gepackt > b.length) throw new Error('zip_kaputt');
    const stueck = b.subarray(start, start + e.gepackt);
    let inhalt;
    if (e.methode === 0) {
      if (e.gepackt !== e.ungepackt) throw new Error('zip_kaputt');
      inhalt = stueck.slice();
    } else inhalt = await entpacken(stueck, e.ungepackt);
    if (inhalt.length !== e.ungepackt || crc32(inhalt) !== e.crc) throw new Error('zip_kaputt');
    aus.set(e.name, inhalt);
  }
  return aus;
}

function dosZeit(zeit) {
  const d = zeit instanceof Date && !Number.isNaN(zeit.getTime()) ? zeit : new Date();
  const jahr = Math.min(2107, Math.max(1980, d.getFullYear()));
  const datum = ((jahr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const uhr = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { datum, uhr };
}

/** ZIP schreiben: [{name, daten: Uint8Array|string}] → Uint8Array. */
export async function zipSchreiben(eintraege, { zeit = new Date() } = {}) {
  if (eintraege.length > 65535) throw new Error('zip_nicht_unterstuetzt');
  const { datum, uhr } = dosZeit(zeit);
  const kodierer = new TextEncoder();
  const teile = []; const zentral = [];
  let off = 0;
  for (const e of eintraege) {
    const name = kodierer.encode(e.name);
    const roh = typeof e.daten === 'string' ? kodierer.encode(e.daten) : bytesVon(e.daten);
    if (!roh) throw new Error('zip_kaputt');
    const stored = MEDIEN.test(e.name);
    const gepackt = stored ? roh : await packen(roh);
    const crc = crc32(roh);
    const lokal = new Uint8Array(30 + name.length);
    const lv = new DataView(lokal.buffer);
    lv.setUint32(0, SIG_LOKAL, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint16(10, uhr, true); lv.setUint16(12, datum, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, gepackt.length, true); lv.setUint32(22, roh.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lokal.set(name, 30);
    teile.push(lokal, gepackt);
    const z = new Uint8Array(46 + name.length);
    const zv = new DataView(z.buffer);
    zv.setUint32(0, SIG_ZENTRAL, true); zv.setUint16(4, 20, true); zv.setUint16(6, 20, true); zv.setUint16(8, 0x0800, true); zv.setUint16(10, stored ? 0 : 8, true);
    zv.setUint16(12, uhr, true); zv.setUint16(14, datum, true); zv.setUint32(16, crc, true);
    zv.setUint32(20, gepackt.length, true); zv.setUint32(24, roh.length, true); zv.setUint16(28, name.length, true);
    zv.setUint32(42, off, true);
    z.set(name, 46);
    zentral.push(z);
    off += lokal.length + gepackt.length;
  }
  const cdGroesse = zentral.reduce((n, z) => n + z.length, 0);
  const ende = new Uint8Array(22);
  const ev = new DataView(ende.buffer);
  ev.setUint32(0, SIG_ENDE, true); ev.setUint16(8, eintraege.length, true); ev.setUint16(10, eintraege.length, true);
  ev.setUint32(12, cdGroesse, true); ev.setUint32(16, off, true);
  const aus = new Uint8Array(off + cdGroesse + 22);
  let o = 0;
  for (const t of [...teile, ...zentral, ende]) { aus.set(t, o); o += t.length; }
  return aus;
}
