// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Verlauf (Plan 02, Aufgabe 2): Ereigniszeilen falten, Monatsdateien anhängen, LRU-Zwischenspeicher, Blättern, Suche.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { falten, laden, anhaengen, seite, suchen, vergessen, LRU_GROESSE, _test } from '../../src/agent/chat/verlauf.js';
import { verlaufOrdner } from '../../src/agent/chat/ablage.js';

const N = (id, zeit, von, text, extra = {}) => ({ t: 'n', id, zeit, von, text, ...extra });
const R = 'rAAAAAAAAAAAAAAAA';
let tmp; let w;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-a-chatverlauf-')); w = { pfade: { chat: path.join(tmp, 'chat') } }; _test.zuruecksetzen(); });
afterEach(async () => { _test.zuruecksetzen(); await fs.rm(tmp, { recursive: true, force: true }); });

test('falten: neu, bearbeitet, gelöscht, Reaktion an/aus, System, doppelt', () => {
  const z = falten([
    N('n000000001aaaaaa', '2026-10-18T10:00:00.000Z', 'anna', 'hallo'),
    N('n000000001aaaaaa', '2026-10-18T10:00:00.000Z', 'anna', 'doppelt'),
    { t: 'b', id: 'n000000001aaaaaa', zeit: '2026-10-18T10:01:00.000Z', text: 'hallo!' },
    { t: 'r', id: 'n000000001aaaaaa', von: 'ben', emoji: '👍', an: true },
    { t: 'r', id: 'n000000001aaaaaa', von: 'cara', emoji: '👍', an: true },
    { t: 'r', id: 'n000000001aaaaaa', von: 'ben', emoji: '👍', an: false },
    N('n000000002bbbbbb', '2026-10-18T10:02:00.000Z', 'ben', 'weg', { anhaenge: ['aAAAAAAAAAAAAAAAA'] }),
    { t: 'l', id: 'n000000002bbbbbb', zeit: '2026-10-18T10:03:00.000Z', von: 'ben' },
    { t: 's', id: 'n000000003cccccc', zeit: '2026-10-18T10:04:00.000Z', art: 'beitritt', wer: 'cara' },
    { t: 'x', id: 'egal' },
  ]);
  const a = z.nachrichten.get('n000000001aaaaaa');
  assert.equal(a.text, 'hallo!'); assert.equal(a.bearbeitet, '2026-10-18T10:01:00.000Z');
  assert.deepEqual(a.reaktionen, { '👍': ['cara'] });
  const b = z.nachrichten.get('n000000002bbbbbb');
  assert.equal(b.text, ''); assert.deepEqual(b.anhaenge, []); assert.equal(b.geloescht, '2026-10-18T10:03:00.000Z');
  assert.deepEqual(z.nachrichten.get('n000000003cccccc').system, { art: 'beitritt', wer: 'cara', daten: null });
  assert.equal(z.nachrichten.get('n000000003cccccc').von, null);
  assert.deepEqual(z.ids, ['n000000001aaaaaa', 'n000000002bbbbbb', 'n000000003cccccc']);
});

test('falten: Bearbeiten/Reaktion auf gelöschte oder unbekannte Nachrichten wirkt nicht', () => {
  const z = falten([
    N('n000000001aaaaaa', '2026-10-18T10:00:00.000Z', 'anna', 'x'),
    { t: 'l', id: 'n000000001aaaaaa', zeit: '2026-10-18T10:01:00.000Z', von: 'anna' },
    { t: 'b', id: 'n000000001aaaaaa', zeit: '2026-10-18T10:02:00.000Z', text: 'wieder da?' },
    { t: 'r', id: 'n000000001aaaaaa', von: 'ben', emoji: '👍', an: true },
    { t: 'b', id: 'n999999999zzzzzz', zeit: '2026-10-18T10:02:00.000Z', text: 'gibts nicht' },
  ]);
  const a = z.nachrichten.get('n000000001aaaaaa');
  assert.equal(a.text, ''); assert.equal(a.bearbeitet, null); assert.deepEqual(a.reaktionen, {});
  assert.equal(z.nachrichten.has('n999999999zzzzzz'), false);
});

test('anhaengen schreibt Monatsdateien 0600, laden faltet in Dateireihenfolge, kaputte letzte Zeile wird übersprungen', async () => {
  await anhaengen(w, R, N('n000000001aaaaaa', '2026-09-30T23:00:00.000Z', 'anna', 'sep'));
  await anhaengen(w, R, N('n000000002aaaaaa', '2026-10-01T00:00:00.000Z', 'anna', 'okt'));
  const ordner = verlaufOrdner(w, R);
  assert.deepEqual((await fs.readdir(ordner)).sort(), ['2026-09.ndjson', '2026-10.ndjson']);
  for (const d of await fs.readdir(ordner)) assert.equal((await fs.stat(path.join(ordner, d))).mode & 0o777, 0o600);
  await fs.appendFile(path.join(ordner, '2026-10.ndjson'), '{"t":"n","id":');
  _test.zuruecksetzen();
  const alt = process.stderr.write; process.stderr.write = () => true;
  let z; try { z = await laden(w, R); } finally { process.stderr.write = alt; }
  assert.deepEqual(z.ids, ['n000000001aaaaaa', 'n000000002aaaaaa']);
  assert.equal(z.nachrichten.get('n000000002aaaaaa').text, 'okt');
});

test('laden: fehlender Verlauf → leer', async () => {
  const z = await laden(w, R);
  assert.deepEqual(z.ids, []);
  assert.equal(z.nachrichten.size, 0);
});

test('anhaengen hält einen geladenen Raum aktuell', async () => {
  const z = await laden(w, R);
  await anhaengen(w, R, N('n000000001aaaaaa', '2026-10-18T10:00:00.000Z', 'anna', 'live'));
  assert.equal(z.nachrichten.get('n000000001aaaaaa').text, 'live');
});

function fuenf() {
  return falten([1, 2, 3, 4, 5].map((i) => N(`n00000000${i}aaaaaa`, `2026-10-18T10:0${i}:00.000Z`, 'anna', `nachricht ${i}`)));
}

test('seite: neueste zuerst gewählt, aufsteigend geliefert, vor/ab/mehr', () => {
  const z = fuenf();
  const ids = (r) => r.liste.map((n) => n.id.slice(9, 10));
  let r = seite(z, { anzahl: 2 });
  assert.deepEqual(ids(r), ['4', '5']); assert.equal(r.mehr, true);
  r = seite(z, { vor: 'n000000004aaaaaa', anzahl: 2 });
  assert.deepEqual(ids(r), ['2', '3']); assert.equal(r.mehr, true);
  r = seite(z, { vor: 'n000000002aaaaaa', anzahl: 5 });
  assert.deepEqual(ids(r), ['1']); assert.equal(r.mehr, false);
  r = seite(z, { ab: '2026-10-18T10:03:00.000Z', anzahl: 10 });
  assert.deepEqual(ids(r), ['3', '4', '5']); assert.equal(r.mehr, false);
});

test('suchen: ohne Groß/Klein, nur nicht gelöschte, neueste zuerst, höchstens max', () => {
  const z = falten([
    N('n000000001aaaaaa', '2026-10-18T10:01:00.000Z', 'anna', 'Äpfel kaufen'),
    N('n000000002aaaaaa', '2026-10-18T10:02:00.000Z', 'ben', 'Birne'),
    N('n000000003aaaaaa', '2026-10-18T10:03:00.000Z', 'ben', 'äPFEL sind alle'),
    N('n000000004aaaaaa', '2026-10-18T10:04:00.000Z', 'anna', 'äpfel gelöscht'),
    { t: 'l', id: 'n000000004aaaaaa', zeit: '2026-10-18T10:05:00.000Z', von: 'anna' },
    N('n000000005aaaaaa', '2026-10-18T10:06:00.000Z', 'cara', 'noch mehr Äpfel'),
  ]);
  assert.deepEqual(suchen(z, 'äpfel').map((n) => n.id), ['n000000005aaaaaa', 'n000000003aaaaaa', 'n000000001aaaaaa']);
  assert.deepEqual(suchen(z, 'ÄPFEL', 2).map((n) => n.id), ['n000000005aaaaaa', 'n000000003aaaaaa']);
  assert.deepEqual(suchen(z, 'gelöscht'), []);
});

test('LRU: höchstens 20 Räume, Zugriff frischt auf, vergessen entfernt', async () => {
  assert.equal(LRU_GROESSE, 20);
  const raeume = Array.from({ length: 21 }, (_v, i) => `r${String(i).padStart(16, '0')}`);
  for (const r of raeume) await laden(w, r);
  assert.equal(_test.lru().length, 20);
  assert.equal(_test.lru().includes(raeume[0]), false);
  await laden(w, raeume[2]);
  assert.equal(_test.lru().at(-1), raeume[2]);
  vergessen(raeume[2]);
  assert.equal(_test.lru().includes(raeume[2]), false);
});

test('gleichzeitiges Anhängen in einen Raum verliert keine Zeile', async () => {
  await Promise.all(Array.from({ length: 50 }, (_v, i) => anhaengen(w, R, N(`n${String(i).padStart(9, '0')}aaaaaa`, '2026-10-18T10:00:00.000Z', 'anna', `x${i}`))));
  const text = await fs.readFile(path.join(verlaufOrdner(w, R), '2026-10.ndjson'), 'utf8');
  assert.equal(text.trim().split('\n').length, 50);
  _test.zuruecksetzen();
  assert.equal((await laden(w, R)).ids.length, 50);
});
