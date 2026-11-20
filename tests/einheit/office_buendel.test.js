// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Bündel (Plan 04, Aufgabe 1): office_anlegen/office_lesen/office_schreiben im Dateihelfer – exklusiv anlegen,
// freier Name, Namensprüfung, Verlauf bis zur Version, atomares Schreiben mit Stand-Prüfung, Verlauf-Grenze,
// Formatprüfung, keine Zwischendateien.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ausfuehrenOp, UPLOAD_PRAEFIX } from '../../src/agent/helfer/dateihelfer.js';
import { INHALT_MAX_BYTES, artAusName, imBuendel, BUENDEL_MUSTER } from '../../src/gemeinsam/office.js';

const INHALT = { format: 'fah-office', art: 'board', schema: 1, id: 'oAAAAAAAAAAAAAAAA', version: 0, erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T08:00:00.000Z', besitzer: 'anna', daten: null };
let wurzel;
beforeEach(async () => { wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'office-')); await fs.mkdir(path.join(wurzel, 'Projekte')); });
afterEach(async () => { await fs.rm(wurzel, { recursive: true, force: true }); });
const anlegen = () => ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: 'Projekte', name: 'Plan', endung: '.fahboard', inhalt: INHALT });
const inhaltDatei = () => path.join(wurzel, 'Projekte/Plan.fahboard/inhalt.json');
const verlaufDatei = () => path.join(wurzel, 'Projekte/Plan.fahboard/verlauf.ndjson');

test('Hilfen: artAusName, imBuendel', () => {
  assert.equal(artAusName('Plan.fahboard'), 'board'); assert.equal(artAusName('Text.FAHDOC'), 'dokument'); assert.equal(artAusName('x.txt'), null);
  assert.equal(imBuendel('Projekte/Plan.fahboard/dateien'), true); assert.equal(imBuendel('Projekte/Plan.fahboard'), true); assert.equal(imBuendel('Projekte'), false);
  assert.ok(BUENDEL_MUSTER.test('a.fahtab'));
});

test('office_anlegen legt exklusiv an, beide → „Name (1)“', async () => {
  const r = await anlegen();
  assert.equal(r.pfad, 'Projekte/Plan.fahboard'); assert.equal(r.name, 'Plan.fahboard'); assert.match(r.stand, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.deepEqual((await fs.readdir(path.join(wurzel, 'Projekte', 'Plan.fahboard'))).sort(), ['dateien', 'inhalt.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(inhaltDatei(), 'utf8')), INHALT);
  await assert.rejects(anlegen(), (e) => e.code === 'E_EXISTIERT' && e.details.name === 'Plan.fahboard');
  const b = await ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: 'Projekte', name: 'Plan', endung: '.fahboard', inhalt: INHALT, beide: true });
  assert.equal(b.name, 'Plan (1).fahboard'); assert.equal(b.pfad, 'Projekte/Plan (1).fahboard');
});

test('Namen mit Pfadteilen und fremde Endung → E_PARAMS, nichts entsteht', async () => {
  for (const name of ['../x', 'a/b', 'a\\b', '.versteckt', '']) await assert.rejects(ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: '', name, endung: '.fahboard', inhalt: INHALT }), (e) => e.code === 'E_PARAMS', name);
  await assert.rejects(ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: '', name: 'x', endung: '.exe', inhalt: INHALT }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'endung');
  await anlegen();
  await assert.rejects(ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: 'Projekte/Plan.fahboard', name: 'innen', endung: '.fahboard', inhalt: INHALT }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'ordner');
  assert.deepEqual((await fs.readdir(wurzel)).filter((n) => n !== 'Projekte'), []);
});

test('office_lesen: Inhalt, Stand, Verlauf nur bis zur Version', async () => {
  await anlegen();
  await fs.writeFile(inhaltDatei(), JSON.stringify({ ...INHALT, version: 2 }));
  await fs.writeFile(verlaufDatei(), [1, 2, 3].map((v) => JSON.stringify({ v, op: { typ: 'x' }, cid: `c${v}` })).join('\n') + '\n{kaputt\n');
  const r = await ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte/Plan.fahboard', mit_verlauf: true });
  assert.equal(r.inhalt.version, 2); assert.equal(typeof r.stand, 'string');
  assert.deepEqual(r.verlauf.map((z) => z.v), [1, 2]);
  const ohne = await ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte/Plan.fahboard' });
  assert.equal('verlauf' in ohne, false);
  await assert.rejects(ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte/Weg.fahboard' }), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.feld === 'pfad');
});

test('office_schreiben: atomar, veralteter Stand → E_GEAENDERT, Datei unverändert', async () => {
  await anlegen();
  const { stand } = await ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte/Plan.fahboard' });
  const r = await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 1, daten: { spalten: [] } }, stand_vorher: stand, verlauf: [{ v: 1, op: { typ: 'noop' }, cid: 'c1' }] });
  assert.equal(typeof r.stand, 'string');
  await assert.rejects(ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 2, daten: {} }, stand_vorher: '2020-01-01T00:00:00.000Z' }),
    (e) => e.code === 'E_GEAENDERT' && typeof e.details.geaendert === 'string' && typeof e.details.groesse === 'number');
  assert.equal(JSON.parse(await fs.readFile(inhaltDatei(), 'utf8')).version, 1);
  assert.deepEqual((await fs.readFile(verlaufDatei(), 'utf8')).trim().split('\n').map((z) => JSON.parse(z).v), [1]);
  const ohneStand = await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 2, daten: {} } });
  assert.equal(typeof ohneStand.stand, 'string', 'ohne stand_vorher kein Vergleich');
});

test('Verlauf hängt an und behält die letzten 500', async () => {
  await anlegen();
  const zeilen = (von) => Array.from({ length: 300 }, (_, i) => ({ v: von + i, op: { typ: 'x' }, cid: 'c' }));
  await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 300 }, verlauf: zeilen(1) });
  await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 600 }, verlauf: zeilen(301) });
  const z = (await fs.readFile(verlaufDatei(), 'utf8')).trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(z.length, 500); assert.equal(z[0].v, 101); assert.equal(z.at(-1).v, 600);
});

test('kaputtes JSON, fremdes Format, schema 2, kein Bündel, zu groß → E_PARAMS', async () => {
  await anlegen();
  const lesen = () => ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte/Plan.fahboard' });
  await fs.writeFile(inhaltDatei(), 'x');
  await assert.rejects(lesen(), (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt');
  await fs.writeFile(inhaltDatei(), JSON.stringify({ ...INHALT, format: 'anders' }));
  await assert.rejects(lesen(), (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt');
  await fs.writeFile(inhaltDatei(), JSON.stringify({ ...INHALT, art: 'tabelle' }));
  await assert.rejects(lesen(), (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt', 'Art passt nicht zur Endung');
  await fs.writeFile(inhaltDatei(), JSON.stringify({ ...INHALT, schema: 2 }));
  await assert.rejects(lesen(), (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt' && /neuere FAH-NAS-Fassung/.test(e.message));
  await assert.rejects(ausfuehrenOp('office_lesen', { wurzel, rel: 'Projekte' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'pfad');
  await fs.writeFile(inhaltDatei(), JSON.stringify(INHALT));
  const riesig = { ...INHALT, daten: { x: 'a'.repeat(INHALT_MAX_BYTES) } };
  await assert.rejects(ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: riesig }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt' && e.details.max === INHALT_MAX_BYTES);
});

test('keine Zwischendateien bleiben liegen, auch nach E_GEAENDERT', async () => {
  await anlegen();
  await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 1 }, verlauf: [{ v: 1, op: {}, cid: 'c' }] });
  await assert.rejects(ausfuehrenOp('office_schreiben', { wurzel, rel: 'Projekte/Plan.fahboard', inhalt: { ...INHALT, version: 2 }, stand_vorher: '2020-01-01T00:00:00.000Z' }));
  const namen = await fs.readdir(path.join(wurzel, 'Projekte/Plan.fahboard'));
  assert.deepEqual(namen.filter((n) => n.startsWith(UPLOAD_PRAEFIX)), []);
  assert.deepEqual(namen.sort(), ['dateien', 'inhalt.json', 'verlauf.ndjson']);
});
