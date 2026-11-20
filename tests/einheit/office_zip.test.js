// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ZIP im Browser (Plan 05 Aufgabe 5, V17): CRC32, Rundreise (Medien stored, sonst deflate, UTF-8-Namen), von Hand mit
// zlib gebaute Archive (damit Lesen und Schreiben sich nicht gegenseitig bestätigen), kaputte, nicht unterstützte und zu
// große Archive (Zip-Bombe mit lügendem Kopf).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { zipLesen, zipSchreiben, crc32, ZIP_GRENZEN } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'office', 'format', 'zip.js')).href);

/** CRC32 unabhängig von zip.js (bitweise). */
function crcVonHand(buf) {
  let crc = 0xffffffff;
  for (const b of buf) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP von Hand: [{name, daten, methode = 0, crcFalsch, groesseLuege}] → Uint8Array. */
function zipVonHand(eintraege) {
  const teile = []; const zentral = []; let off = 0;
  for (const e of eintraege) {
    const name = Buffer.from(e.name, 'utf8');
    const roh = Buffer.isBuffer(e.daten) ? e.daten : Buffer.from(e.daten);
    const methode = e.methode ?? 0;
    const gepackt = methode === 8 ? zlib.deflateRawSync(roh) : roh;
    let crc = crcVonHand(roh); if (e.crcFalsch) crc = (crc ^ 1) >>> 0;
    const groesse = e.groesseLuege ?? roh.length;
    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0); lokal.writeUInt16LE(20, 4); lokal.writeUInt16LE(0x0800, 6); lokal.writeUInt16LE(methode, 8);
    lokal.writeUInt16LE(0, 10); lokal.writeUInt16LE(0x21, 12); lokal.writeUInt32LE(crc, 14); lokal.writeUInt32LE(gepackt.length, 18); lokal.writeUInt32LE(groesse, 22);
    lokal.writeUInt16LE(name.length, 26); lokal.writeUInt16LE(0, 28);
    teile.push(lokal, name, gepackt);
    const z = Buffer.alloc(46);
    z.writeUInt32LE(0x02014b50, 0); z.writeUInt16LE(20, 4); z.writeUInt16LE(20, 6); z.writeUInt16LE(0x0800, 8); z.writeUInt16LE(methode, 10);
    z.writeUInt16LE(0, 12); z.writeUInt16LE(0x21, 14); z.writeUInt32LE(crc, 16); z.writeUInt32LE(gepackt.length, 20); z.writeUInt32LE(groesse, 24);
    z.writeUInt16LE(name.length, 28); z.writeUInt32LE(off, 42);
    zentral.push(z, name);
    off += 30 + name.length + gepackt.length;
  }
  const cd = Buffer.concat(zentral);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0); ende.writeUInt16LE(eintraege.length, 8); ende.writeUInt16LE(eintraege.length, 10); ende.writeUInt32LE(cd.length, 12); ende.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...teile, cd, ende]));
}

/** Einträge des zentralen Verzeichnisses (Name, Methode, Flag) aus fertigen Bytes. */
function verzeichnis(z) {
  const b = Buffer.from(z); const aus = [];
  for (let i = 0; i + 46 <= b.length; i++) {
    if (b.readUInt32LE(i) !== 0x02014b50) continue;
    const n = b.readUInt16LE(i + 28);
    aus.push({ name: b.subarray(i + 46, i + 46 + n).toString('utf8'), flag: b.readUInt16LE(i + 8), methode: b.readUInt16LE(i + 10), zeit: b.readUInt16LE(i + 12), datum: b.readUInt16LE(i + 14) });
  }
  return aus;
}

test('crc32 Prüfwert', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.deepEqual(ZIP_GRENZEN, { summe: 209715200, eintrag: 104857600, verhaeltnis: 100 });
});

test('Rundreise: stored für Medien, deflate sonst, UTF-8-Namen', async () => {
  const z = await zipSchreiben([{ name: 'word/document.xml', daten: '<a>ä</a>'.repeat(100) }, { name: 'word/media/bild1.png', daten: new Uint8Array([1, 2, 3]) }, { name: 'Ordner/Größe.txt', daten: 'x' }], { zeit: new Date(2026, 9, 18, 12, 0, 0) });
  const m = await zipLesen(z);
  assert.deepEqual([...m.keys()], ['word/document.xml', 'word/media/bild1.png', 'Ordner/Größe.txt']);
  assert.equal(new TextDecoder().decode(m.get('word/document.xml')), '<a>ä</a>'.repeat(100));
  assert.deepEqual([...m.get('word/media/bild1.png')], [1, 2, 3]);
  assert.equal(new TextDecoder().decode(m.get('Ordner/Größe.txt')), 'x');
  const v = verzeichnis(z);
  assert.deepEqual(v.map((e) => [e.name, e.methode]), [['word/document.xml', 8], ['word/media/bild1.png', 0], ['Ordner/Größe.txt', 8]]);
  assert.ok(v.every((e) => e.flag & 0x0800), 'UTF-8-Flag');
  assert.deepEqual([v[0].datum, v[0].zeit], [(46 << 9) | (10 << 5) | 18, 12 << 11], 'DOS-Datum 2026-10-18 12:00');
  // und node:zlib liest unsere Deflate-Daten
  const b = Buffer.from(z);
  const nameLen = b.readUInt16LE(26); const gepackt = b.readUInt32LE(18);
  assert.equal(zlib.inflateRawSync(b.subarray(30 + nameLen, 30 + nameLen + gepackt)).toString('utf8'), '<a>ä</a>'.repeat(100));
  assert.equal((await zipLesen(await zipSchreiben([]))).size, 0, 'leeres Archiv');
});

test('von Hand gebaut: deflate und stored lesbar, Ordner-Einträge übersprungen', async () => {
  const z = zipVonHand([{ name: 'a.txt', daten: 'Hallo Welt '.repeat(20), methode: 8 }, { name: 'ordner/', daten: '' }, { name: 'b.bin', daten: Buffer.from([1, 2, 3]) }, { name: 'leer.txt', daten: '', methode: 8 }]);
  const m = await zipLesen(z);
  assert.deepEqual([...m.keys()], ['a.txt', 'b.bin', 'leer.txt']);
  assert.equal(new TextDecoder().decode(m.get('a.txt')), 'Hallo Welt '.repeat(20));
  assert.deepEqual([...m.get('b.bin')], [1, 2, 3]);
  assert.equal(m.get('leer.txt').length, 0);
  const ab = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
  assert.equal((await zipLesen(ab)).size, 3, 'ArrayBuffer geht auch');
});

test('kaputt, nicht unterstützt, zu groß', async () => {
  await assert.rejects(zipLesen(zipVonHand([{ name: 'a', daten: 'abc', crcFalsch: true }])), /zip_kaputt/);
  await assert.rejects(zipLesen(new Uint8Array(30)), /zip_kaputt/);
  await assert.rejects(zipLesen(zipVonHand([{ name: 'a', daten: 'abc', methode: 12 }])), /zip_nicht_unterstuetzt/);
  await assert.rejects(zipLesen(zipVonHand([{ name: 'a', daten: 'x'.repeat(300000), methode: 8 }])), /zip_zu_gross/); // Verhältnis > 100:1
  await assert.rejects(zipLesen(zipVonHand([{ name: 'a', daten: 'y'.repeat(5000), methode: 8, groesseLuege: 10 }])), /zip_zu_gross/); // Kopf lügt
  await assert.rejects(zipLesen(zipVonHand([{ name: 'a', daten: 'a' }, { name: 'a', daten: 'b' }])), /zip_kaputt/);
  // verschlüsselt (Flag Bit 0) und abgeschnitten
  const v = zipVonHand([{ name: 'a', daten: 'abc' }]); const vb = Buffer.from(v);
  const cd = vb.length - 22 - 46 - 1; vb.writeUInt16LE(0x0801, cd + 8);
  await assert.rejects(zipLesen(new Uint8Array(vb)), /zip_nicht_unterstuetzt/);
  const ganz = zipVonHand([{ name: 'a.txt', daten: 'Inhalt '.repeat(50), methode: 8 }]);
  await assert.rejects(zipLesen(ganz.subarray(10)), /zip_kaputt/);
  await assert.rejects(zipLesen('kein zip'), /zip_kaputt/);
});
