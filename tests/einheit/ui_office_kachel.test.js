// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übersichts-Kachel „Office“ (Plan 04 Aufgabe 16): zuletzt bearbeitete Dokumente (höchstens 5, Symbol je Art) und meine
// fälligen Board-Karten (höchstens 5, überfällige zuerst und markiert), Summe als Wert, Leer-Text, Link zum Office.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const ID = 'oAAAAAAAAAAAAAAAA';
let dom; let app; let dashboard; let raster;
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  dashboard = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  raster = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard-raster.js')).href);
});
after(() => dom.aufraeumen());

test('officeZeilen: höchstens 5, überfällige zuerst, Summe', () => {
  const r = dashboard.officeZeilen({ zuletzt: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, art: 'board', name: String(i), geaendert: '2026-10-18T10:00:00Z' })) },
    { karten: [{ karte_id: 'a', faellig: '2026-10-18', ueberfaellig: false }, { karte_id: 'b', faellig: '2026-10-10', ueberfaellig: true }] });
  assert.equal(r.zuletzt.length, 5); assert.deepEqual(r.karten.map((k) => k.karte_id), ['b', 'a']); assert.equal(r.anzahl_faellig, 2);
  assert.deepEqual(r.zuletzt[0], { id: 'o0', art: 'board', name: '0', geaendert: '2026-10-18T10:00:00Z' });
  assert.deepEqual(dashboard.officeZeilen(null, null), { zuletzt: [], karten: [], anzahl_faellig: 0 });
  const viele = dashboard.officeZeilen({}, { karten: Array.from({ length: 7 }, (_, i) => ({ board_id: ID, board_name: 'Sprint', karte_id: `k${i}aaaa`, titel: `K${i}`, faellig: `2026-10-1${i}`, ueberfaellig: i < 2 })) });
  assert.equal(viele.karten.length, 5); assert.equal(viele.anzahl_faellig, 7, 'Summe auch über die abgeschnittenen');
  assert.deepEqual(viele.karten.slice(0, 2).map((k) => k.ueberfaellig), [true, true]);
  assert.deepEqual(viele.karten[0], { board_id: ID, board_name: 'Sprint', karte_id: 'k0aaaa', titel: 'K0', faellig: '2026-10-10', ueberfaellig: true });
});

test('Standardgröße 4×6', () => { assert.deepEqual(raster.STANDARD_GROESSE.office, [4, 6]); });

test('Kachel: Zuletzt mit Symbol je Art, fällige Karten (überfällige mit .warnung), Wert, Link; leer → Hinweis', async () => {
  let liste = { zuletzt: [{ id: ID, art: 'board', name: 'Sprint', geaendert: '2026-10-18T10:00:00.000Z' }, { id: 'oBBBBBBBBBBBBBBBB', art: 'tabelle', name: 'Budget', geaendert: '2026-10-17T10:00:00.000Z' }], meine: [], fuer_mich: [] };
  let faellig = { karten: [{ board_id: ID, board_name: 'Sprint', karte_id: 'k1aaaa', titel: 'Release', faellig: '2026-10-10', ueberfaellig: true }, { board_id: ID, board_name: 'Sprint', karte_id: 'k2aaaa', titel: 'Doku', faellig: '2026-10-18', ueberfaellig: false }] };
  const aufrufe = [];
  const ctx = {
    rolle: 'nutzer', nutzer: { name: 'anna', rolle: 'nutzer' }, get: async () => ({ links: [], orte: {} }), sse: { on() { return () => {}; } },
    hashFuer: app.hashFuer, melden() {}, fehlerText: (e) => (e && e.message) || 'Fehler', bestaetigen: async () => true, dialog: () => ({ schliessen() {} }),
    api: async (aktion) => {
      aufrufe.push(aktion);
      if (aktion === 'office.liste') return structuredClone(liste);
      if (aktion === 'office.faellig') return structuredClone(faellig);
      if (aktion === 'apps.liste' || aktion === 'agent.aufgaben' || aktion === 'laufwerke.liste') return [];
      return {};
    },
  };
  const wurzel = document.createElement('main'); document.body.appendChild(wurzel);
  await dashboard.default.einbinden(wurzel, ctx);
  await ticks();
  try {
    const k = wurzel.querySelector('[data-kachel="office"]');
    assert.ok(k, 'Kachel da (auch für Nutzer)');
    assert.equal(k.querySelector('.kachel-wert').textContent, 'dashboard.office_faellig_wert:2');
    const zuletzt = k.querySelectorAll('.dashboard-office li');
    assert.equal(zuletzt.length, 2);
    assert.equal(zuletzt[0].querySelector('a').getAttribute('href'), `#/office/d/${ID}`);
    assert.equal(zuletzt[0].querySelector('a').textContent, 'Sprint');
    assert.ok(zuletzt[0].querySelector('svg use').getAttribute('href').endsWith('#symbol-board'));
    assert.ok(zuletzt[1].querySelector('svg use').getAttribute('href').endsWith('#symbol-tabelle'));
    const karten = k.querySelectorAll('.dashboard-office-karten li');
    assert.equal(karten.length, 2);
    assert.ok(karten[0].classList.contains('warnung'), 'überfällig markiert'); assert.equal(karten[1].classList.contains('warnung'), false);
    assert.equal(karten[0].querySelector('a').getAttribute('href'), `#/office/d/${ID}`);
    assert.match(karten[0].textContent, /Release/); assert.match(karten[0].textContent, /Sprint/);
    assert.equal(k.querySelector('.kachel-fuss a').getAttribute('href'), '#/office');
    assert.equal(k.querySelector('.kachel-fuss a').textContent, 'dashboard.office_link');
    assert.ok(aufrufe.includes('office.liste') && aufrufe.includes('office.faellig'));
  } finally { dashboard.default.verlassen(); }

  // leer
  liste = { zuletzt: [], meine: [], fuer_mich: [] }; faellig = { karten: [] };
  const w2 = document.createElement('main'); document.body.appendChild(w2);
  await dashboard.default.einbinden(w2, ctx);
  await ticks();
  try {
    const k = w2.querySelector('[data-kachel="office"]');
    assert.equal(k.querySelector('.kachel-wert').textContent, 'dashboard.office_faellig_wert:0');
    assert.equal(k.querySelector('.kachel-neben').textContent, 'dashboard.office_leer');
    assert.equal(k.querySelector('.dashboard-office').hidden, true);
  } finally { dashboard.default.verlassen(); }
});
