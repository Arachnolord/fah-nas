// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/helfer/geo.js (Ortsbestimmung für die Weltkarte: Stadt-Datenbank monatlich geladen,
// Länder-Datenbank + laender.json mitgeliefert) und tools/geo_holen.mjs (Länder-Datenbank beim Release-Bau).
// Alle Downloads laufen gegen eine Attrappe (`holen`), die Uhr ist ersetzbar (`jetzt`) – kein Netz nötig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as netzadressen from '../../src/agent/helfer/netzadressen.js';
import { erzeugeGeo, ladeDbip, pruefeDbip, STICHPROBEN, monatVon, vormonat, dbipUrl, istPrivat, ANYCAST, istAnycast, ipNormal } from '../../src/agent/helfer/geo.js';
import { holeLaenderDb } from '../../tools/geo_holen.mjs';
import { schreibeMmdb, schreibeBombe, T, US_STADT, US_LAND } from './mmdb_hilfen.js';
import { blockadeMessen } from './schleife_hilfen.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DE_NAMEN = { de: 'Deutschland', en: 'Germany' };
const STADT_DB = () => schreibeMmdb([
  { netz: '8.8.8.0/24', daten: US_STADT },
  { netz: '140.82.112.0/20', daten: { city: { names: { de: 'Frankfurt am Main', en: 'Frankfurt' } }, country: { iso_code: 'DE', names: DE_NAMEN },
    location: { latitude: T.dbl(50.1), longitude: T.dbl(8.7) } } },
  { netz: '151.101.0.0/16', daten: { city: { names: { en: 'Irgendwo' } }, country: { iso_code: 'DE', names: DE_NAMEN } } }, // ohne Koordinaten
  { netz: '198.51.100.0/24', daten: { continent: { code: 'EU' } } },                                                         // ohne Land
  { netz: '2a00:1450::/32', daten: { city: { names: { en: 'Hamburg' } }, country: { iso_code: 'de', names: { en: 'Germany' } },
    location: { latitude: T.dbl(53.55), longitude: T.dbl(10) } } },
  // private Netze stehen absichtlich MIT Ort in der Datenbank – geo.suche darf sie trotzdem nie verorten
  { netz: '10.0.0.0/8', daten: { city: { names: { en: 'Privatstadt' } }, country: { iso_code: 'DE', names: DE_NAMEN }, location: { latitude: T.dbl(1), longitude: T.dbl(1) } } },
  { netz: '192.168.0.0/16', daten: { city: { names: { en: 'Privatstadt' } }, country: { iso_code: 'DE', names: DE_NAMEN }, location: { latitude: T.dbl(1), longitude: T.dbl(1) } } },
  { netz: 'fd00::/8', daten: { city: { names: { en: 'Privatstadt' } }, country: { iso_code: 'DE', names: DE_NAMEN }, location: { latitude: T.dbl(1), longitude: T.dbl(1) } } },
], { typ: 'DBIP-City-Lite' });
const LAND_DB = () => schreibeMmdb([
  { netz: '8.8.8.0/24', daten: US_LAND },
  { netz: '140.82.112.0/20', daten: { continent: { code: 'EU' }, country: { iso_code: 'DE', names: DE_NAMEN } } },
  { netz: '203.0.113.0/24', daten: { country: { iso_code: 'ZZ', names: { en: 'Nirgendwo' } } } }, // nicht in laender.json
  { netz: '45.0.0.0/8', daten: { country: { iso_code: 'DE', names: DE_NAMEN } } },               // nur in der Länder-DB
  { netz: '10.0.0.0/8', daten: { country: { iso_code: 'DE', names: DE_NAMEN } } },               // privat, trotzdem nie verorten
], { typ: 'DBIP-Country-Lite', metadaten: { build_epoch: T.u64(Date.UTC(2026, 7, 3) / 1000) } });
const LAENDER = { quelle: 'Test', laender: { US: { name: 'Vereinigte Staaten', lat: 39.8, lon: -98.6 }, DE: { name: 'Deutschland', lat: 51.2, lon: 10.4 },
  XX: { name: 'kaputt', lat: 'x', lon: 1 } } };

/** Temp-Ordner mit mit/ (Länder-DB, laender.json) und daten/ (Stadt-DB, stand.json) nach Wunsch. */
async function aufbau({ stadt = false, land = false, laender = true, stand = null } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-geo-'));
  const pfade = { mit: path.join(w, 'mit'), daten: path.join(w, 'daten') };
  await fs.mkdir(pfade.mit); await fs.mkdir(pfade.daten);
  if (laender) await fs.writeFile(path.join(pfade.mit, 'laender.json'), JSON.stringify(LAENDER));
  if (land) await fs.writeFile(path.join(pfade.mit, 'dbip-country-lite.mmdb'), LAND_DB());
  if (stadt) await fs.writeFile(path.join(pfade.daten, 'dbip-city-lite.mmdb'), stadt === true ? STADT_DB() : stadt);
  if (stand) await fs.writeFile(path.join(pfade.daten, 'stand.json'), JSON.stringify({ monat: stand, geladen: '2026-01-01T00:00:00.000Z', bytes: 1 }));
  return { w, pfade, weg: () => fs.rm(w, { recursive: true, force: true }) };
}

/** Uhr-Attrappe: jetzt() liefert `zeit`, verstellbar. */
function uhr(iso) {
  const u = { ms: Date.parse(iso) };
  u.jetzt = () => new Date(u.ms);
  u.vor = (minuten) => { u.ms += minuten * 60_000; };
  return u;
}

/** Download-Attrappe: Antworten je Monat ('2026-09' → Buffer (wird gzip-t) | Zahl (HTTP-Status) | Funktion → Response). */
function holer(antworten) {
  const aufrufe = [];
  const holen = async (url, optionen) => {
    aufrufe.push(url);
    assert.ok(optionen?.signal instanceof AbortSignal, 'Download braucht ein Zeitlimit (signal)');
    const monat = /-(\d{4}-\d{2})\.mmdb\.gz$/.exec(url)?.[1];
    const a = antworten[monat];
    if (a === undefined) return new Response(null, { status: 404 });
    if (typeof a === 'number') return new Response(null, { status: a });
    if (typeof a === 'function') return a();
    return new Response(zlib.gzipSync(a), { status: 200 });
  };
  return { holen, aufrufe };
}

const ORT_US = { land: 'US', land_name: 'Vereinigte Staaten', stadt: 'Mountain View', lat: 37.4, lon: -122.1, genau: 'stadt' };

test('geo.js reicht istPrivat/ANYCAST/istAnycast/ipNormal aus netzadressen.js unverändert weiter', () => {
  assert.equal(istPrivat, netzadressen.istPrivat);
  assert.equal(ANYCAST, netzadressen.ANYCAST);
  assert.equal(istAnycast, netzadressen.istAnycast);
  assert.equal(ipNormal, netzadressen.ipNormal);
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '224.0.0.251',
    'fd00::1', 'fe80::1%eno1', '::1', '::ffff:192.168.1.5']) assert.equal(istPrivat(ip), true, ip);
  for (const ip of ['172.32.0.1', '8.8.8.8', '2a00:1450::1']) assert.equal(istPrivat(ip), false, ip);
});

test('Monatsrechnung: UTC, Vormonat über den Jahreswechsel, Download-Adresse', () => {
  assert.equal(monatVon(new Date('2026-09-30T23:59:59Z')), '2026-09');
  assert.equal(monatVon(new Date('2026-10-01T00:00:00Z')), '2026-10');
  assert.equal(vormonat('2026-09'), '2026-08');
  assert.equal(vormonat('2026-01'), '2025-12');
  assert.equal(dbipUrl('city', '2026-09'), 'https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz');
  assert.equal(dbipUrl('country', '2025-12'), 'https://download.db-ip.com/free/dbip-country-lite-2025-12.mmdb.gz');
});

test('Stadt-Datenbank: Ort mit Stadt und Koordinaten, deutsche Namen bevorzugt; Status „stadt“ mit Stand aus stand.json', async () => {
  const a = await aufbau({ stadt: true, land: true, stand: '2026-09' });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo.starten();
    assert.deepEqual(geo.suche('8.8.8.9'), ORT_US);
    assert.deepEqual(geo.suche('140.82.121.4'), { land: 'DE', land_name: 'Deutschland', stadt: 'Frankfurt am Main', lat: 50.1, lon: 8.7, genau: 'stadt' });
    assert.deepEqual(geo.suche('::ffff:140.82.121.4'), geo.suche('140.82.121.4'));
    // Stadt ohne Koordinaten → Landesmitte, genau 'land'; Landescode klein → groß, Name aus laender.json vor names.en
    assert.deepEqual(geo.suche('151.101.1.69'), { land: 'DE', land_name: 'Deutschland', stadt: 'Irgendwo', lat: 51.2, lon: 10.4, genau: 'land' });
    assert.deepEqual(geo.suche('2a00:1450:4001:82b::200e'), { land: 'DE', land_name: 'Deutschland', stadt: 'Hamburg', lat: 53.55, lon: 10, genau: 'stadt' });
    // Eintrag ohne Land in der Stadt-DB → Rückfall auf die Länder-DB (dort unbekannt) → null
    assert.equal(geo.suche('198.51.100.7'), null);
    assert.deepEqual(geo.status(), { quelle: 'stadt', stand: '2026-09', hinweis: null });
  } finally { await geo.stoppen(); await a.weg(); }
});

test('suche: privat → null, Anycast → {anycast:true}, Unsinn → null, nicht gefunden → Rückfall auf Länder-DB', async () => {
  const a = await aufbau({ stadt: true, land: true, stand: '2026-09' });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo.starten();
    for (const ip of ['192.168.1.1', '192.168.1.5', '::1', 'fe80::1%eno1', '100.64.0.1', '::ffff:10.0.0.1']) assert.equal(geo.suche(ip), null, ip);
    for (const ip of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '2606:4700:4700::1111', '::ffff:1.0.0.1']) assert.deepEqual(geo.suche(ip), { anycast: true }, ip);
    for (const ip of ['', 'kein-ip', '1.2.3', null, undefined, 7]) assert.equal(geo.suche(ip), null, String(ip));
    assert.equal(geo.suche('203.0.113.9'), null, 'Land ohne Mitte in laender.json → kein Ort');
    assert.equal(geo.suche('5.5.5.5'), null, 'nirgends gefunden');
    assert.deepEqual(geo.suche('45.1.2.3'), { land: 'DE', land_name: 'Deutschland', stadt: null, lat: 51.2, lon: 10.4, genau: 'land' },
      'nicht in der Stadt-DB → Länder-DB');
    for (const ip of ['10.9.9.9', '192.168.178.1', 'fd12::1']) assert.equal(geo.suche(ip), null, `${ip}: privat trotz Eintrag in der Datenbank`);
  } finally { await geo.stoppen(); await a.weg(); }
});

test('Nur Länder-Datenbank → Landesmitte (genau „land“, stadt null); stadtLaden:false mit vorhandener Stadt-DB ebenso', async () => {
  const erwartet = { land: 'US', land_name: 'Vereinigte Staaten', stadt: null, lat: 39.8, lon: -98.6, genau: 'land' };
  const a = await aufbau({ land: true });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => false });
  try {
    await geo.starten();
    assert.deepEqual(geo.suche('8.8.8.9'), erwartet);
    assert.deepEqual(geo.suche('140.82.121.4'), { land: 'DE', land_name: 'Deutschland', stadt: null, lat: 51.2, lon: 10.4, genau: 'land' });
    assert.deepEqual(geo.status(), { quelle: 'land', stand: '2026-08', hinweis: null }, 'Stand der Länder-DB aus build_epoch');
  } finally { await geo.stoppen(); await a.weg(); }

  const b = await aufbau({ stadt: true, land: true, stand: '2026-09' });
  let laden = true;
  const geo2 = erzeugeGeo({ pfade: b.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => laden });
  try {
    await geo2.starten();
    assert.equal(geo2.suche('8.8.8.9').genau, 'stadt');
    laden = false; // Einstellung umgeschaltet – wirkt ohne Neustart
    assert.deepEqual(geo2.suche('8.8.8.9'), erwartet);
    assert.equal(geo2.status().quelle, 'land');
  } finally { await geo2.stoppen(); await b.weg(); }
});

test('Weder Stadt- noch Länder-Datenbank → suche null, Status „keine“ mit Hinweis; Länder-DB ohne laender.json ebenso', async () => {
  const a = await aufbau({ laender: false });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => false });
  try {
    await geo.starten();
    assert.equal(geo.suche('8.8.8.9'), null);
    const s = geo.status();
    assert.equal(s.quelle, 'keine'); assert.equal(s.stand, null);
    assert.equal(typeof s.hinweis, 'string'); assert.ok(s.hinweis.length > 10);
  } finally { await geo.stoppen(); await a.weg(); }
  const b = await aufbau({ land: true, laender: false });
  const geo2 = erzeugeGeo({ pfade: b.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => false });
  try {
    await geo2.starten();
    assert.equal(geo2.suche('8.8.8.9'), null);
    assert.equal(geo2.status().quelle, 'keine');
  } finally { await geo2.stoppen(); await b.weg(); }
});

test('Download: aktueller Monat 404 → Vormonat; Datei atomar an ihrem Platz, stand.json, keine Temp-Reste, sofort wirksam', async () => {
  const a = await aufbau({ land: true });
  const h = holer({ '2026-08': STADT_DB() });
  const u = uhr('2026-09-15T12:00:00Z');
  const meldungen = [];
  const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: u.jetzt, protokoll: (t) => meldungen.push(t) });
  try {
    await geo.starten();
    const s = await geo.aktualisieren();
    assert.deepEqual(h.aufrufe, ['https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz', 'https://download.db-ip.com/free/dbip-city-lite-2026-08.mmdb.gz']);
    assert.deepEqual(s, { quelle: 'stadt', stand: '2026-08', hinweis: null });
    assert.deepEqual((await fs.readdir(a.pfade.daten)).sort(), ['dbip-city-lite.mmdb', 'stand.json']);
    const stand = JSON.parse(await fs.readFile(path.join(a.pfade.daten, 'stand.json'), 'utf8'));
    assert.equal(stand.monat, '2026-08'); assert.equal(stand.geladen, '2026-09-15T12:00:00.000Z'); assert.equal(stand.bytes, STADT_DB().length);
    assert.deepEqual(geo.suche('8.8.8.9'), ORT_US, 'neue Stadt-DB ohne Neustart aktiv');
    assert.ok(meldungen.some((m) => /2026-08/.test(m)), 'Download wird protokolliert');
    // Vormonat schon vorhanden, aktueller Monat weiter 404 → nichts erneut herunterladen
    u.vor(7 * 60);
    await geo.aktualisieren();
    assert.deepEqual(h.aufrufe.slice(2), ['https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz'], 'nur nachsehen, ob der neue Monat da ist');
  } finally { await geo.stoppen(); await a.weg(); }
});

test('Download kaputt (Müll, falscher Typ, Abbruch mitten im Strom, HTTP 500) → alte DB bleibt, keine Temp-Reste, Hinweis; neuer Versuch erst nach 1 h', async () => {
  const faelle = {
    muell: () => new Response(zlib.gzipSync(Buffer.from('das ist keine Datenbank '.repeat(500))), { status: 200 }),
    keinGzip: () => new Response(Buffer.from('<html>Wartung</html>'), { status: 200 }),
    falscherTyp: () => new Response(zlib.gzipSync(LAND_DB()), { status: 200 }),
    abbruch: () => {
      const gz = zlib.gzipSync(STADT_DB());
      return new Response(new ReadableStream({ start(c) { c.enqueue(gz.subarray(0, 200)); c.error(new Error('Netz weg')); } }), { status: 200 });
    },
    http500: 500,
  };
  for (const [name, antwort] of Object.entries(faelle)) {
    const altDb = schreibeMmdb([{ netz: '8.8.8.0/24', daten: { ...US_STADT, city: { names: { en: 'Alte Stadt' } } } }], { typ: 'DBIP-City-Lite' });
    const a = await aufbau({ stadt: altDb, land: true, stand: '2026-07' });
    const h = holer({ '2026-09': antwort });
    const u = uhr('2026-09-15T12:00:00Z');
    const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: u.jetzt });
    try {
      await geo.starten();
      const s = await geo.aktualisieren();
      assert.equal(h.aufrufe.length, 1, `${name}: kein Rückfall auf den Vormonat bei einer Antwort ≠ 404`);
      assert.equal(s.quelle, 'stadt', name); assert.equal(s.stand, '2026-07', name);
      assert.match(s.hinweis, /konnten nicht geladen werden/, name);
      assert.equal(geo.suche('8.8.8.9').stadt, 'Alte Stadt', `${name}: alte DB weiter in Gebrauch`);
      assert.deepEqual((await fs.readdir(a.pfade.daten)).sort(), ['dbip-city-lite.mmdb', 'stand.json'], `${name}: keine Temp-Reste`);
      assert.equal((await fs.readFile(path.join(a.pfade.daten, 'dbip-city-lite.mmdb'))).length, altDb.length, `${name}: alte Datei unverändert`);
      u.vor(30);
      await geo.aktualisieren();
      assert.equal(h.aufrufe.length, 1, `${name}: innerhalb 1 h kein neuer Versuch`);
      u.vor(31);
      await geo.aktualisieren();
      assert.equal(h.aufrufe.length, 2, `${name}: nach 61 min wieder`);
    } finally { await geo.stoppen(); await a.weg(); }
  }
});

test('Netzfehler: Hinweis nennt die Ursache (fetch failed → ENOTFOUND, Zeitlimit); doppeltes starten öffnet nichts doppelt', async () => {
  for (const [fehler, erwartet] of [
    [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND download.db-ip.com'), { code: 'ENOTFOUND' }) }), /ENOTFOUND/],
    [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), /Zeitlimit überschritten/],
  ]) {
    const a = await aufbau({ land: true });
    const geo = erzeugeGeo({ pfade: a.pfade, holen: async () => { throw fehler; }, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
    try {
      await geo.starten();
      await geo.starten();
      const s = await geo.aktualisieren();
      assert.equal(s.quelle, 'land');
      assert.match(s.hinweis, erwartet);
      assert.deepEqual(await fs.readdir(a.pfade.daten), []);
    } finally { await geo.stoppen(); await a.weg(); }
  }
});

test('Stand = aktueller Monat → kein Download; erzwingen:true → Download trotzdem (auch innerhalb der Fehler-Wartezeit)', async () => {
  const a = await aufbau({ stadt: true, stand: '2026-09' });
  const h = holer({ '2026-09': STADT_DB() });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo.starten();
    await geo.aktualisieren();
    assert.equal(h.aufrufe.length, 0);
    const s = await geo.aktualisieren({ erzwingen: true });
    assert.deepEqual(h.aufrufe, ['https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz']);
    assert.equal(s.stand, '2026-09');
  } finally { await geo.stoppen(); await a.weg(); }
  // Fehler-Wartezeit: normaler Aufruf wartet, erzwungener nicht
  const b = await aufbau({ stadt: true, stand: '2026-08' });
  let versuch = 0;
  const h2 = holer({ '2026-09': () => (++versuch === 1 ? new Response(null, { status: 500 }) : new Response(zlib.gzipSync(STADT_DB()), { status: 200 })) });
  const geo2 = erzeugeGeo({ pfade: b.pfade, holen: h2.holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo2.starten();
    assert.match((await geo2.aktualisieren()).hinweis, /konnten nicht geladen werden/);
    await geo2.aktualisieren();
    assert.equal(h2.aufrufe.length, 1, 'normaler Aufruf wartet nach einem Fehler');
    const s = await geo2.aktualisieren({ erzwingen: true });
    assert.equal(h2.aufrufe.length, 2);
    assert.deepEqual(s, { quelle: 'stadt', stand: '2026-09', hinweis: null }, 'Erfolg löscht den Fehler-Hinweis');
  } finally { await geo2.stoppen(); await b.weg(); }
});

test('stadtLaden:false → lädt nie etwas (auch nicht erzwungen, auch nicht beim Start)', async () => {
  const a = await aufbau({ land: true });
  const h = holer({ '2026-09': STADT_DB() });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => false });
  try {
    await geo.starten();
    await geo.aktualisieren();
    await geo.aktualisieren({ erzwingen: true });
    assert.equal(h.aufrufe.length, 0);
    assert.equal(geo.status().quelle, 'land');
  } finally { await geo.stoppen(); await a.weg(); }
});

test('starten: räumt Temp-Reste weg, prüft sofort im Hintergrund, gleichzeitige Aufrufe laden nur einmal; stoppen schließt alles', async () => {
  const a = await aufbau({ land: true });
  await fs.writeFile(path.join(a.pfade.daten, 'dbip-city-lite.mmdb.4711.abcd.tmp'), 'Rest eines Absturzes');
  await fs.writeFile(path.join(a.pfade.daten, 'stand.json.4711.tmp'), '{');
  await fs.writeFile(path.join(a.pfade.daten, 'fremd.txt'), 'bleibt');
  const h = holer({ '2026-09': STADT_DB() });
  const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo.starten();
    const [s1, s2] = await Promise.all([geo.aktualisieren(), geo.aktualisieren()]);
    assert.equal(h.aufrufe.length, 1, 'Start-Prüfung und zwei Aufrufe teilen sich einen Download');
    assert.equal(s1.quelle, 'stadt'); assert.deepEqual(s1, s2);
    assert.deepEqual((await fs.readdir(a.pfade.daten)).sort(), ['dbip-city-lite.mmdb', 'fremd.txt', 'stand.json']);
    await geo.stoppen();
    assert.equal(geo.suche('8.8.8.9'), null);
    assert.equal(geo.status().quelle, 'keine');
  } finally { await geo.stoppen(); await a.weg(); }
});

test('Stand ohne stand.json: aus build_epoch der Stadt-DB; kaputte Stadt-DB wird ignoriert (Länder-Rückfall), nicht geworfen', async () => {
  const a = await aufbau({ stadt: true, land: true });
  const h = holer({});
  const geo = erzeugeGeo({ pfade: a.pfade, holen: h.holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
  try {
    await geo.starten();
    await geo.aktualisieren();
    assert.equal(geo.status().stand, '2026-09', 'build_epoch 2026-09-01 → Stand 2026-09');
    assert.equal(h.aufrufe.length, 0, 'aktueller Monat vorhanden → kein Download');
  } finally { await geo.stoppen(); await a.weg(); }
  const b = await aufbau({ stadt: Buffer.from('kaputt'), land: true, stand: '2026-09' });
  const meldungen = [];
  const geo2 = erzeugeGeo({ pfade: b.pfade, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, stadtLaden: () => false, protokoll: (t) => meldungen.push(t) });
  try {
    await geo2.starten();
    assert.equal(geo2.status().quelle, 'land');
    assert.equal(geo2.suche('8.8.8.9').genau, 'land');
    assert.ok(meldungen.some((m) => /MMDB/.test(m)), 'kaputte Datei wird protokolliert');
  } finally { await geo2.stoppen(); await b.weg(); }
});

test('ladeDbip: Größengrenze greift beim Entpacken, Temp-Datei weg; 404 in beiden Monaten → Fehler', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-geo-lade-'));
  try {
    const ziel = path.join(w, 'dbip-city-lite.mmdb');
    await assert.rejects(ladeDbip({ art: 'city', ziel, holen: holer({ '2026-09': STADT_DB() }).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt, maxBytes: 100 }), /größer als 100 Byte/);
    assert.deepEqual(await fs.readdir(w), []);
    await assert.rejects(ladeDbip({ art: 'city', ziel, holen: holer({}).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt }), /2026-09.*2026-08|404/);
    assert.deepEqual(await fs.readdir(w), []);
    const r = await ladeDbip({ art: 'country', ziel: path.join(w, 'dbip-country-lite.mmdb'), holen: holer({ '2026-09': LAND_DB() }).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt });
    assert.deepEqual(r, { monat: '2026-09', bytes: LAND_DB().length, neu: true });
    assert.deepEqual(await fs.readdir(w), ['dbip-country-lite.mmdb']);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('pruefeDbip: Bombe an einer beliebigen Stichprobe (nicht nur 8.8.8.8) verwirft die Datei – schnell, Ereignisschleife frei', async () => {
  assert.deepEqual(STICHPROBEN, ['8.8.8.8', '1.1.1.1', '2a00:1450::1', '91.189.91.113', '140.82.121.4']);
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-geo-bombe-'));
  try {
    const datei = path.join(w, 'x.mmdb');
    // gesunde Stadt-DB: alle Stichproben laufen, 8.8.8.8 hat ein Land
    await fs.writeFile(datei, STADT_DB());
    assert.equal((await pruefeDbip(datei, 'city')).database_type, 'DBIP-City-Lite');
    // Bombe im Datensatz einer anderen Stichprobe, 8.8.8.8 bleibt gesund → trotzdem verworfen
    for (const netz of ['1.1.1.0/24', '2a00:1450::/32', '91.189.91.0/24', '140.82.112.0/20']) {
      await fs.writeFile(datei, schreibeBombe({ ort: 'daten', netz, dazu: [{ netz: '8.8.8.0/24', daten: US_STADT }] }));
      const m = await blockadeMessen(() => assert.rejects(pruefeDbip(datei, 'city'), (e) => /zu groß/.test(e.message), netz));
      assert.ok(m.rechen < 200, `${netz}: nach ${Math.round(m.rechen)} ms Rechenzeit verworfen`);
    }
    // ladeDbip: Bombe im Download → Fehler, Temp-Datei weg, Ziel unberührt; die Ereignisschleife steht nie lange
    const ziel = path.join(w, 'dbip-city-lite.mmdb');
    await fs.rm(datei);
    for (const bombe of [schreibeBombe({ ebenen: 30 }), schreibeBombe({ ort: 'daten', netz: '91.189.91.0/24', dazu: [{ netz: '8.8.8.0/24', daten: US_STADT }] })]) {
      const m = await blockadeMessen(() => assert.rejects(ladeDbip({ art: 'city', ziel, holen: holer({ '2026-09': bombe }).holen, jetzt: uhr('2026-09-15T12:00:00Z').jetzt }), /zu groß/));
      assert.ok(m.luecke < 200, `Ereignisschleife stand ${Math.round(m.luecke)} ms (Wanduhr ${Math.round(m.wandLuecke)} ms)`);
      assert.deepEqual(await fs.readdir(w), [], 'keine Temp-Reste, kein Ziel');
    }
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('tools/geo_holen.mjs: Länder-DB laden (404 → Vormonat), --wenn-noetig überspringt frische Datei, lädt ab 45 Tagen neu, behält ältere bei Fehler', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-geo-holen-'));
  const still = () => {};
  try {
    const u = uhr('2026-10-02T08:00:00Z');
    const h1 = holer({ '2026-09': LAND_DB() });
    const r1 = await holeLaenderDb({ ziel: w, holen: h1.holen, jetzt: u.jetzt, ausgabe: still, warnung: still });
    assert.equal(r1.geholt, true); assert.equal(r1.monat, '2026-09');
    assert.deepEqual(h1.aufrufe, ['https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz', 'https://download.db-ip.com/free/dbip-country-lite-2026-09.mmdb.gz']);
    const datei = path.join(w, 'dbip-country-lite.mmdb');
    assert.equal((await fs.readFile(datei)).length, LAND_DB().length);
    assert.deepEqual(await fs.readdir(w), ['dbip-country-lite.mmdb']);

    // frisch (Dateialter < 45 Tage) → nichts laden
    const h2 = holer({ '2026-10': LAND_DB() });
    await fs.utimes(datei, new Date(u.ms - 10 * 86_400_000), new Date(u.ms - 10 * 86_400_000));
    const r2 = await holeLaenderDb({ ziel: w, wennNoetig: true, holen: h2.holen, jetzt: u.jetzt, ausgabe: still, warnung: still });
    assert.equal(r2.geholt, false); assert.equal(h2.aufrufe.length, 0);

    // älter als 45 Tage → neu laden
    await fs.utimes(datei, new Date(u.ms - 46 * 86_400_000), new Date(u.ms - 46 * 86_400_000));
    const r3 = await holeLaenderDb({ ziel: w, wennNoetig: true, holen: h2.holen, jetzt: u.jetzt, ausgabe: still, warnung: still });
    assert.equal(r3.geholt, true); assert.equal(r3.monat, '2026-10');

    // alt + Download scheitert → Warnung, ältere Datei bleibt (Exit 0 im Werkzeug)
    await fs.utimes(datei, new Date(u.ms - 60 * 86_400_000), new Date(u.ms - 60 * 86_400_000));
    const warnungen = [];
    const r4 = await holeLaenderDb({ ziel: w, wennNoetig: true, holen: holer({ '2026-10': 503 }).holen, jetzt: u.jetzt, ausgabe: still, warnung: (t) => warnungen.push(t) });
    assert.equal(r4.geholt, false); assert.equal(warnungen.length, 1); assert.match(warnungen[0], /ältere/);
    assert.deepEqual(await fs.readdir(w), ['dbip-country-lite.mmdb']);

    // unlesbare Datei gilt als fehlend
    await fs.writeFile(datei, 'kaputt');
    await fs.utimes(datei, new Date(u.ms), new Date(u.ms));
    const h5 = holer({ '2026-10': LAND_DB() });
    const r5 = await holeLaenderDb({ ziel: w, wennNoetig: true, holen: h5.holen, jetzt: u.jetzt, ausgabe: still, warnung: still });
    assert.equal(r5.geholt, true);

    // gar keine Datei + Fehler → wirft
    await fs.rm(datei);
    await assert.rejects(holeLaenderDb({ ziel: w, wennNoetig: true, holen: holer({ '2026-10': 503 }).holen, jetzt: u.jetzt, ausgabe: still, warnung: still }), /503/);
    assert.deepEqual(await fs.readdir(w), []);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('tools/geo_holen.mjs als Kommando: unbekannte Option → Exit 2, Hilfe → 0, --wenn-noetig mit frischer Datei → 0 ohne Netz', async () => {
  const skript = path.join(WURZEL, 'tools', 'geo_holen.mjs');
  const laufen = (args) => new Promise((ok) => {
    execFile(process.execPath, [skript, ...args], { timeout: 30_000 }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  const u = await laufen(['--quatsch']);
  assert.equal(u.code, 2); assert.match(u.stderr, /Unbekannte Option/);
  assert.equal((await laufen(['hilfe'])).code, 0);
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-geo-cli-'));
  try {
    await fs.writeFile(path.join(w, 'dbip-country-lite.mmdb'), LAND_DB());
    const r = await laufen(['--wenn-noetig', '--ziel', w]);
    assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /aktuell genug/);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Release und Namensnennung: build_release.sh nimmt geo/ mit und holt die Länder-DB bei Bedarf; .gitignore; LICENSE-HINWEIS.md', async () => {
  const skript = await fs.readFile(path.join(WURZEL, 'tools', 'build_release.sh'), 'utf8');
  assert.match(skript, /^INHALT=\(.*\bgeo\b.*\)$/m, 'geo/ gehört ins Release');
  assert.match(skript, /^INHALT=\(.*\bLICENSE-HINWEIS\.md\b.*\)$/m, 'Namensnennung gehört ins Release');
  assert.match(skript, /node tools\/geo_holen\.mjs --wenn-noetig/);
  assert.match(skript, /--ohne-geo-holen\)/);
  const ignoriert = (await fs.readFile(path.join(WURZEL, '.gitignore'), 'utf8')).split('\n');
  assert.ok(ignoriert.includes('geo/*.mmdb'), '.gitignore: geo/*.mmdb');
  const hinweis = await fs.readFile(path.join(WURZEL, 'LICENSE-HINWEIS.md'), 'utf8');
  assert.match(hinweis, /Erdacht und programmiert von Fabian Hammer/);
  for (const muss of ['DB-IP', 'CC BY 4.0', 'https://db-ip.com', 'creativecommons.org/licenses/by/4.0', 'Natural Earth', 'https://www.naturalearthdata.com',
    'IP-Geolokalisierung: DB-IP.com (CC BY 4.0) · Karte: Natural Earth']) assert.ok(hinweis.includes(muss), `LICENSE-HINWEIS.md: ${muss}`);
});
