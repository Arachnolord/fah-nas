// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/helfer/mmdb.js (eigener Leser für das MaxMind-DB-Format 2.0): Suche IPv4/IPv6, alle
// Datentypen, Zeiger in allen vier Größen, record_size 24/28/32, Größenfelder an den Grenzen, blockweises Lesen mit
// begrenztem Zwischenspeicher, ungültige Adressen und kaputte Dateien, Budget gegen Zeiger-/Breiten-Bomben.
// Die Testdatenbanken baut mmdb_hilfen.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { oeffneMmdb, BUDGET, _test } from '../../src/agent/helfer/mmdb.js';
import { schreibeMmdb, schreibeBombe, T, US_STADT, MARKE, VOLLER_STADTSATZ } from './mmdb_hilfen.js';
import { blockadeMessen } from './schleife_hilfen.js';

const ERWARTET_US = { city: { names: { en: 'Mountain View' } }, continent: { code: 'NA', names: { de: 'Nordamerika', en: 'North America' } },
  country: { iso_code: 'US', names: { de: 'USA', en: 'United States' } }, location: { latitude: 37.4, longitude: -122.1 } };
const GOOGLE_V6 = { country: { iso_code: 'US', names: { en: 'United States' } }, netz: 'google-v6' };
const LINKLOKAL = { art: 'link-lokal' };

const BEISPIEL = [
  { netz: '8.8.8.0/24', daten: US_STADT },
  { netz: '140.82.112.0/20', daten: { country: { iso_code: 'DE', names: { de: 'Deutschland', en: 'Germany' } }, city: { names: { en: 'Frankfurt am Main' } } } },
  { netz: '2001:4860::/32', daten: GOOGLE_V6 },
  { netz: 'fe80::/16', daten: LINKLOKAL },
];

async function mitDatei(puffer, fn, optionen) {
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-mmdb-'));
  const datei = path.join(ordner, 'test.mmdb');
  await fs.writeFile(datei, puffer);
  const db = await oeffneMmdb(datei, optionen);
  try { return await fn(db, datei); } finally { await db.schliessen(); await fs.rm(ordner, { recursive: true, force: true }); }
}

async function oeffnenScheitert(puffer) {
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-mmdb-kaputt-'));
  const datei = path.join(ordner, 'kaputt.mmdb');
  await fs.writeFile(datei, puffer);
  try { await assert.rejects(oeffneMmdb(datei), (e) => e instanceof Error && /MMDB/.test(e.message)); } finally { await fs.rm(ordner, { recursive: true, force: true }); }
}

test('Suche IPv4 im IPv6-Baum: verschachtelte Maps, double, Metadaten', async () => {
  await mitDatei(schreibeMmdb(BEISPIEL), (db) => {
    assert.deepEqual(db.suche('8.8.8.8'), ERWARTET_US);
    assert.deepEqual(db.suche('8.8.8.255'), ERWARTET_US);
    assert.equal(db.suche('8.8.9.1'), null, 'knapp daneben');
    assert.equal(db.suche('140.82.121.4').city.names.en, 'Frankfurt am Main');
    assert.equal(db.metadaten.database_type, 'Test-City');
    assert.equal(db.metadaten.ip_version, 6);
    assert.equal(db.metadaten.record_size, 24);
    assert.ok(db.metadaten.node_count > 96);
    assert.equal(db.metadaten.binary_format_major_version, 2);
    assert.equal(db.metadaten.build_epoch, Date.UTC(2026, 8, 1) / 1000, 'uint64 klein → Number');
    assert.deepEqual(db.metadaten.languages, ['de', 'en']);
    assert.deepEqual(db.metadaten.description, { en: 'FAH-NAS Testdatenbank' });
  });
});

test('Suche IPv6: Treffer im /32, knapp daneben null; IPv4 ohne IPv4-Netze in der Datenbank → null', async () => {
  await mitDatei(schreibeMmdb(BEISPIEL), (db) => {
    assert.deepEqual(db.suche('2001:4860::1'), GOOGLE_V6);
    assert.deepEqual(db.suche('2001:4860:ffff:ffff:ffff:ffff:ffff:ffff'), GOOGLE_V6);
    assert.equal(db.suche('2001:4861::1'), null);
    assert.equal(db.suche('2a00:1450::1'), null);
  });
  await mitDatei(schreibeMmdb([{ netz: '2001:4860::/32', daten: GOOGLE_V6 }]), (db) => {
    assert.equal(db.suche('8.8.8.8'), null);
    assert.deepEqual(db.suche('2001:4860::8888'), GOOGLE_V6);
  });
});

test('Schreibweisen: ::ffff:-Abbild, Großbuchstaben, voll ausgeschrieben, Zonen-ID, Leerraum', async () => {
  await mitDatei(schreibeMmdb(BEISPIEL), (db) => {
    assert.deepEqual(db.suche('::ffff:8.8.8.8'), db.suche('8.8.8.8'));
    assert.deepEqual(db.suche('::FFFF:808:808'), ERWARTET_US);
    assert.deepEqual(db.suche('2001:4860:0000:0000:0000:0000:0000:0001'), GOOGLE_V6);
    assert.deepEqual(db.suche('2001:4860::A'), GOOGLE_V6);
    assert.deepEqual(db.suche('fe80::1%eno1'), LINKLOKAL);
    assert.deepEqual(db.suche('fe80::1%eno1'), db.suche('fe80::1'));
    assert.deepEqual(db.suche(' 8.8.8.8 '), ERWARTET_US);
  });
});

test('Ungültige Adressen → null (kein Wurf)', async () => {
  await mitDatei(schreibeMmdb(BEISPIEL), (db) => {
    for (const x of ['kein-ip', '', '1.2.3', '300.1.1.1', '::ffff:999.1.1.1', '1.2.3.4/24', '%eno1', null, undefined, 42, {}]) {
      assert.equal(db.suche(x), null, String(x));
    }
  });
});

test('record_size 24, 28 und 32 liefern dieselben Treffer', async () => {
  for (const recordSize of [24, 28, 32]) {
    await mitDatei(schreibeMmdb(BEISPIEL, { recordSize }), (db) => {
      assert.equal(db.metadaten.record_size, recordSize);
      assert.deepEqual(db.suche('8.8.8.8'), ERWARTET_US, `record_size ${recordSize}`);
      assert.deepEqual(db.suche('2001:4860::1'), GOOGLE_V6, `record_size ${recordSize}`);
      assert.deepEqual(db.suche('fe80::abcd'), LINKLOKAL, `record_size ${recordSize}`);
      assert.equal(db.suche('2001:4861::1'), null, `record_size ${recordSize}`);
      assert.equal(db.suche('9.9.9.9'), null, `record_size ${recordSize}`);
    });
  }
});

test('Knoten lesen: 28-Bit-Einträge teilen sich das Mittelbyte (oberes Halbbyte links, unteres rechts)', () => {
  const b = Buffer.from([0x12, 0x34, 0x56, 0xab, 0x78, 0x9a, 0xbc]);
  assert.deepEqual(_test.knoten(b, 0, 28), [0xa123456, 0xb789abc]);
  assert.deepEqual(_test.knoten(Buffer.from([1, 2, 3, 4, 5, 6]), 0, 24), [0x010203, 0x040506]);
  assert.deepEqual(_test.knoten(Buffer.from([0xff, 0, 0, 1, 0x80, 0, 0, 2]), 0, 32), [0xff000001, 0x80000002]);
  assert.deepEqual(_test.knoten(Buffer.from([9, 9, 1, 2, 3, 4, 5, 6]), 2, 24), [0x010203, 0x040506], 'Versatz');
});

test('IPv4-Datenbank (ip_version 4): IPv4-Suche ab der Wurzel, IPv6 → null', async () => {
  await mitDatei(schreibeMmdb([{ netz: '8.8.8.0/24', daten: US_STADT }, { netz: '1.0.0.0/8', daten: { a: 1 } }], { ipVersion: 4 }), (db) => {
    assert.equal(db.metadaten.ip_version, 4);
    assert.deepEqual(db.suche('8.8.8.8'), ERWARTET_US);
    assert.deepEqual(db.suche('::ffff:1.2.3.4'), { a: 1 });
    assert.equal(db.suche('2001:4860::1'), null);
    assert.equal(db.suche('9.9.9.9'), null);
  });
});

test('Alle Datentypen: utf8, double, bytes, uint16/32/64/128, int32, map, array, boolean, float; Cache-Container und Endmarke ignoriert', async () => {
  const daten = {
    text: 'Grüße aus München – ✓', leer: '', dbl: T.dbl(-0.125), bytes: Buffer.from([0, 1, 2, 254, 255]), keineBytes: Buffer.alloc(0),
    u16: T.u16(65535), u16null: T.u16(0), u32: T.u32(4294967295), u32klein: T.u32(7),
    i32neg: T.i32(-123456), i32min: T.i32(-2147483648), i32pos: T.i32(2147483647), i32klein: T.i32(5),
    u64sicher: T.u64(Number.MAX_SAFE_INTEGER), u64gross: T.u64(18446744073709551615n), u128: T.u128(2n ** 127n + 5n), u128klein: T.u128(42),
    wahr: true, falsch: false, f32: T.f32(1.5), f32neg: T.f32(-2.25),
    liste: [1, 'zwei', { drei: 3 }, [4], true], leereListe: [], leereMap: {},
    tief: { a: { b: { c: { d: 'unten' } } } },
    cache: T.roh([0x00, 0x05]), ende: T.roh([0x00, 0x06]), danach: 'geht weiter',
  };
  await mitDatei(schreibeMmdb([{ netz: '203.0.113.0/24', daten }]), (db) => {
    const r = db.suche('203.0.113.7');
    assert.equal(r.text, 'Grüße aus München – ✓');
    assert.equal(r.leer, '');
    assert.equal(r.dbl, -0.125);
    assert.ok(Buffer.isBuffer(r.bytes)); assert.deepEqual([...r.bytes], [0, 1, 2, 254, 255]);
    assert.equal(r.keineBytes.length, 0);
    assert.equal(r.u16, 65535); assert.equal(r.u16null, 0);
    assert.equal(r.u32, 4294967295); assert.equal(r.u32klein, 7);
    assert.equal(r.i32neg, -123456); assert.equal(r.i32min, -2147483648); assert.equal(r.i32pos, 2147483647); assert.equal(r.i32klein, 5);
    assert.equal(r.u64sicher, Number.MAX_SAFE_INTEGER); assert.equal(typeof r.u64sicher, 'number');
    assert.equal(r.u64gross, 18446744073709551615n, 'unsicher groß bleibt BigInt');
    assert.equal(r.u128, 2n ** 127n + 5n); assert.equal(r.u128klein, 42);
    assert.equal(r.wahr, true); assert.equal(r.falsch, false);
    assert.equal(r.f32, 1.5); assert.equal(r.f32neg, -2.25);
    assert.deepEqual(r.liste, [1, 'zwei', { drei: 3 }, [4], true]);
    assert.deepEqual(r.leereListe, []); assert.deepEqual(r.leereMap, {});
    assert.equal(r.tief.a.b.c.d, 'unten');
    assert.equal(r.cache, null); assert.equal(r.ende, null);
    assert.equal(r.danach, 'geht weiter');
  });
});

test('Größenfelder an den Grenzen (28/29/284/285/65820/65821/70000 Byte) und große Maps', async () => {
  const laengen = [28, 29, 284, 285, 65820, 65821, 70000];
  const daten = Object.fromEntries(laengen.map((n) => [`s${n}`, 'x'.repeat(n - 1) + 'y']));
  const grosseMap = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
  await mitDatei(schreibeMmdb([{ netz: '198.51.100.0/24', daten: { ...daten, grosseMap } }], { teilen: false }), (db) => {
    const r = db.suche('198.51.100.1');
    for (const n of laengen) { assert.equal(r[`s${n}`].length, n, `Länge ${n}`); assert.ok(r[`s${n}`].endsWith('y')); }
    assert.equal(Object.keys(r.grosseMap).length, 300);
    assert.equal(r.grosseMap.k299, 299);
  });
});

test('Zeiger: geteilte Teil-Datensätze und Schlüssel in allen vier Zeigergrößen', async () => {
  const aa = { code: 'AA', n: 1 };
  const bb = { code: 'BB', n: 2 };
  const eintraege = [
    { netz: '10.0.0.0/24', daten: { pad: Buffer.alloc(3000, 1) } },         // schiebt „aa“ hinter 2048 → Zeiger ss=1
    { netz: '10.0.1.0/24', daten: { land: aa, x: 0 } },
    { netz: '10.0.2.0/24', daten: { pad2: Buffer.alloc(530000, 2) } },      // schiebt „bb“ hinter 526336 → Zeiger ss=2
    { netz: '10.0.3.0/24', daten: { land: bb, x: 0 } },
    { netz: '10.0.4.0/24', daten: { land: aa, x: 1 } },                     // Zeiger auf aa (ss=1), Schlüssel „land“/„x“ geteilt
    { netz: '10.0.5.0/24', daten: { land: bb, x: 2 } },                     // Zeiger auf bb (ss=2)
    { netz: '10.0.6.0/24', daten: { pad: Buffer.alloc(1, 3) } },            // Schlüssel „pad“ am Anfang → Zeiger ss=0
    { netz: '10.0.7.0/24', daten: { land: aa, x: 0 } },                     // gleicher Datensatz wie 10.0.1.0 → selbe Stelle
  ];
  const mit = schreibeMmdb(eintraege);
  const ohne = schreibeMmdb(eintraege, { teilen: false });
  assert.ok(mit.length < ohne.length, 'mit Teilen muss die Datei kleiner sein (Zeiger benutzt)');
  for (const [puffer, name] of [[mit, 'kleinste Zeiger'], [schreibeMmdb(eintraege, { zeiger32: true }), 'Zeiger ss=3'], [ohne, 'ohne Zeiger']]) {
    await mitDatei(puffer, (db) => {
      assert.equal(db.suche('10.0.0.1').pad.length, 3000, name);
      assert.deepEqual(db.suche('10.0.1.1'), { land: aa, x: 0 }, name);
      assert.equal(db.suche('10.0.2.1').pad2.length, 530000, name);
      assert.deepEqual(db.suche('10.0.3.1'), { land: bb, x: 0 }, name);
      assert.deepEqual(db.suche('10.0.4.1'), { land: aa, x: 1 }, name);
      assert.deepEqual(db.suche('10.0.5.1'), { land: bb, x: 2 }, name);
      assert.deepEqual([...db.suche('10.0.6.1').pad], [3], name);
      assert.deepEqual(db.suche('10.0.7.1'), { land: aa, x: 0 }, name);
      assert.equal(db.suche('10.0.8.1'), null, name);
    });
  }
});

test('Zeiger: dekodierte Werte sind unabhängige Kopien (Ändern eines Treffers verändert keinen anderen)', async () => {
  const geteilt = { names: { de: 'Deutschland' } };
  await mitDatei(schreibeMmdb([{ netz: '10.1.0.0/16', daten: { country: geteilt, a: 1 } }, { netz: '10.2.0.0/16', daten: { country: geteilt, a: 2 } }]), (db) => {
    const eins = db.suche('10.1.0.1');
    eins.country.names.de = 'verändert';
    assert.equal(db.suche('10.2.0.1').country.names.de, 'Deutschland');
    assert.equal(db.suche('10.1.0.1').country.names.de, 'Deutschland');
  });
});

test('Block-Cache: Datei > 64 KiB, Treffer über Blockgrenzen, höchstens maxBloecke im Speicher', async () => {
  const eintraege = Array.from({ length: 5000 }, (_, i) => ({ netz: `20.${i >> 8}.${i & 255}.0/24`, daten: { n: i, name: `Netz Nummer ${i}` } }));
  eintraege.push({ netz: '21.0.0.0/8', daten: { lang: 'z'.repeat(70000) } });
  const puffer = schreibeMmdb(eintraege, { recordSize: 28 });
  assert.ok(puffer.length > 3 * 65536, `Datei muss größer als drei Blöcke sein (${puffer.length})`);
  const pruefen = (db) => {
    for (let i = 0; i < 5000; i += 7) assert.deepEqual(db.suche(`20.${i >> 8}.${i & 255}.9`), { n: i, name: `Netz Nummer ${i}` }, `Netz ${i}`);
    assert.equal(db.suche('21.1.2.3').lang.length, 70000);
    assert.equal(db.suche('20.200.0.1'), null);
  };
  await mitDatei(puffer, (db) => {
    pruefen(db);
    const s = db._statistik();
    assert.ok(s.bloecke >= 2 && s.bloecke <= 256, `Blöcke ${s.bloecke}`);
    assert.equal(s.blockGroesse, 65536);
  });
  await mitDatei(puffer, (db) => {
    pruefen(db);
    pruefen(db); // zweiter Durchlauf nach Verdrängung
    const s = db._statistik();
    assert.ok(s.bloecke <= 3, `höchstens 3 Blöcke im Speicher, sind ${s.bloecke}`);
    assert.ok(s.gelesen > 3, 'Blöcke wurden verdrängt und neu gelesen');
  }, { blockGroesse: 4096, maxBloecke: 3 });
});

test('Kaputte Dateien: ohne Kennung, leer, falsche record_size, fehlende Felder, Baum größer als Datei → Error mit „MMDB“', async () => {
  const gut = schreibeMmdb(BEISPIEL);
  await oeffnenScheitert(Buffer.from('das ist keine Datenbank, nur Text '.repeat(100)));
  await oeffnenScheitert(Buffer.alloc(0));
  await oeffnenScheitert(gut.subarray(0, gut.lastIndexOf(MARKE))); // Metadaten abgeschnitten
  await oeffnenScheitert(schreibeMmdb(BEISPIEL, { metadaten: { record_size: T.u16(20) } }));
  await oeffnenScheitert(schreibeMmdb(BEISPIEL, { metadaten: { node_count: undefined } }));
  await oeffnenScheitert(schreibeMmdb(BEISPIEL, { metadaten: { node_count: T.u32(0) } }));
  await oeffnenScheitert(schreibeMmdb(BEISPIEL, { metadaten: { ip_version: T.u16(5) } }));
  await oeffnenScheitert(schreibeMmdb(BEISPIEL, { metadaten: { node_count: T.u32(10_000_000) } }));
  await oeffnenScheitert(Buffer.concat([MARKE, Buffer.from([0xe1, 0x42])])); // Metadaten-Map mit abgeschnittenem Inhalt
  await oeffnenScheitert(Buffer.concat([MARKE, Buffer.from([0x45, 0x41, 0x42, 0x43, 0x44, 0x45])])); // Metadaten sind keine Map
});

test('Kaputter Datenteil: Zeiger ins Leere oder Endlos-Zeiger → Error mit „MMDB“ bei der Suche', async () => {
  const puffer = schreibeMmdb([{ netz: '8.8.8.0/24', daten: { a: 1 } }]);
  const knoten = 96 + 24; // Pfad bis zum /24 (IPv4 im IPv6-Baum)
  // letzten Knoten auf dem Pfad so verbiegen, dass beide Einträge weit hinter das Dateiende zeigen
  const kaputt = Buffer.from(puffer);
  kaputt.writeUIntBE(knoten + 16 + 16_000_000, (knoten - 1) * 6, 3);
  kaputt.writeUIntBE(knoten + 16 + 16_000_000, (knoten - 1) * 6 + 3, 3);
  await mitDatei(kaputt, (db) => {
    assert.throws(() => db.suche('8.8.8.8'), /MMDB/);
  });
  // Datensatz ist ein Zeiger auf sich selbst → Tiefe begrenzt statt Endlosschleife
  const schleife = schreibeMmdb([{ netz: '8.8.8.0/24', daten: T.roh([0x20, 0x00]) }]);
  await mitDatei(schleife, (db) => {
    assert.throws(() => db.suche('8.8.8.8'), /MMDB/);
  });
});

test('schliessen: danach wirft suche, doppeltes Schließen schadet nicht', async () => {
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-mmdb-zu-'));
  try {
    const datei = path.join(ordner, 'a.mmdb');
    await fs.writeFile(datei, schreibeMmdb(BEISPIEL));
    const db = await oeffneMmdb(datei);
    assert.deepEqual(db.suche('8.8.8.8'), ERWARTET_US);
    await db.schliessen();
    await db.schliessen();
    assert.throws(() => db.suche('8.8.8.8'), /MMDB/);
  } finally { await fs.rm(ordner, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// Budget je Dekodier-Aufruf (Prüfbericht 26.09.: Zeiger-Bombe – 4 KB Datei → 2^30 Werte, Agent hing/OOM)
// ---------------------------------------------------------------------------------------------------------------

test('Zeiger-Bombe in den Metadaten (2^30 Werte aus 4 KB): oeffneMmdb scheitert schnell mit „MMDB kaputt (zu groß)“', async () => {
  for (const ebenen of [16, 22, 30]) {
    const puffer = schreibeBombe({ ebenen, k: 2 });
    assert.ok(puffer.length < 5000, `Datei klein (${puffer.length} Byte)`);
    const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-mmdb-bombe-'));
    try {
      const datei = path.join(ordner, 'bombe.mmdb');
      await fs.writeFile(datei, puffer);
      // Rechenzeit statt Wanduhr (die Suite läuft parallel): vorher 4,4 s bzw. Speichertod
      const m = await blockadeMessen(() => assert.rejects(oeffneMmdb(datei), (e) => /MMDB kaputt \(zu groß\)/.test(e.message)));
      assert.ok(m.rechen < 200, `2^${ebenen}: nach ${Math.round(m.rechen)} ms Rechenzeit abgelehnt`);
      assert.ok(m.luecke < 200, `2^${ebenen}: Ereignisschleife stand ${Math.round(m.luecke)} ms`);
    } finally { await fs.rm(ordner, { recursive: true, force: true }); }
  }
});

test('Zeiger-Bombe im Datenteil: suche wirft schnell „MMDB kaputt (zu groß)“, andere Adressen bleiben nutzbar', async () => {
  const puffer = schreibeBombe({ ort: 'daten', ebenen: 30, netz: '91.189.91.0/24', dazu: [{ netz: '8.8.8.0/24', daten: US_STADT }] });
  await mitDatei(puffer, (db) => {
    const c0 = process.cpuUsage();
    assert.throws(() => db.suche('91.189.91.113'), /MMDB kaputt \(zu groß\)/);
    const c = process.cpuUsage(c0);
    assert.ok((c.user + c.system) / 1000 < 200, `nach ${Math.round((c.user + c.system) / 1000)} ms Rechenzeit abgelehnt`);
    assert.deepEqual(db.suche('8.8.8.8'), ERWARTET_US, 'das Budget gilt je Suche – danach ist wieder alles frei');
    assert.throws(() => db.suche('91.189.91.1'), /zu groß/, 'jede Suche hat ihr eigenes, frisches Budget');
  });
});

test('Breiten-Bombe (100 Zeiger auf denselben 65-KB-Text = 6,5 MB): Byte-Budget 4 MiB greift; 60 Zeiger (3,9 MB) gehen noch', async () => {
  await mitDatei(schreibeBombe({ ort: 'daten', art: 'breite', anzahl: 100, laenge: 65_000 }), (db) => {
    assert.throws(() => db.suche('8.8.8.8'), /MMDB kaputt \(zu groß\)/);
  });
  await mitDatei(schreibeBombe({ ort: 'daten', art: 'breite', anzahl: 60, laenge: 65_000 }), (db) => {
    const r = db.suche('8.8.8.8');
    assert.equal(r.length, 60); assert.equal(r[59].length, 65_000);
  });
  await oeffnenScheitert(schreibeBombe({ art: 'breite', anzahl: 100, laenge: 65_000 }));
  // Werte-Grenze genau: ein Array mit n Zahlen sind n + 1 Werte
  assert.deepEqual(BUDGET, { werte: 20_000, bytes: 4 * 1024 * 1024 });
  await mitDatei(schreibeMmdb([{ netz: '8.8.8.0/24', daten: Array(BUDGET.werte - 1).fill(7) }, { netz: '9.9.9.0/24', daten: Array(BUDGET.werte).fill(7) }]), (db) => {
    assert.equal(db.suche('8.8.8.8').length, BUDGET.werte - 1);
    assert.throws(() => db.suche('9.9.9.9'), /MMDB kaputt \(zu groß\)/);
  });
});

test('Budget: echte Datensätze (Stadt mit Namen in 8 Sprachen, alle Teilbereiche) und große Metadaten passen weiterhin', async () => {
  const beschreibung = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, `Beschreibung ${i} `.repeat(20)]));
  const eintraege = [
    { netz: '81.169.145.0/24', daten: VOLLER_STADTSATZ },
    { netz: '2a01:238::/32', daten: VOLLER_STADTSATZ },
  ];
  for (const opt of [{}, { teilen: false }, { zeiger32: true }]) {
    await mitDatei(schreibeMmdb(eintraege, { ...opt, metadaten: { description: beschreibung, languages: ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh-CN'] } }), (db) => {
      for (const ip of ['81.169.145.1', '2a01:238::1']) {
        const r = db.suche(ip);
        assert.equal(r.city.names.de, 'München (de)');
        assert.equal(r.city.names['zh-CN'], 'München (zh-CN)');
        assert.equal(r.subdivisions[1].names.ru, 'Oberbayern (ru)');
        assert.equal(r.location.time_zone, 'Europe/Berlin');
        assert.equal(r.country.is_in_european_union, true);
      }
      assert.equal(Object.keys(db.metadaten.description).length, 40);
    });
  }
  // viele Suchen hintereinander: das Budget wird je Suche neu gezählt, nicht über die Lebenszeit der Datenbank
  await mitDatei(schreibeMmdb(eintraege), (db) => {
    for (let i = 0; i < 2000; i++) assert.equal(db.suche(`81.169.145.${i & 255}`).country.iso_code, 'DE');
  });
});
