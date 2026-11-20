// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dashboard-Kachel „Chat“ (Plan 02, Aufgabe 20): Zeilen (Ungelesene zuerst, dann neueste, höchstens 8, Summe über
// alle) und Standardgröße.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let dashboard; let raster;

before(async () => {
  dom = domAttrappe();
  dashboard = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  raster = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard-raster.js')).href);
});
after(() => dom.aufraeumen());

test('chatZeilen: Ungelesene zuerst, dann neueste, höchstens 8, Summe über alle', () => {
  const r = dashboard.chatZeilen({ raeume: [
    { id: 'r1', name: 'A', art: 'raum', ungelesen: 0, letzte: { zeit: '2026-10-18T12:00:00Z' } },
    { id: 'r2', name: 'B', art: 'raum', ungelesen: 2, letzte: { zeit: '2026-10-18T09:00:00Z' } },
    { id: 'd1', name: 'Ben', art: 'dm', ungelesen: 5, letzte: { zeit: '2026-10-18T08:00:00Z' }, stumm: true },
  ] });
  assert.deepEqual(r.zeilen.map((z) => z.id), ['d1', 'r2', 'r1']); assert.equal(r.summe, 7);
  assert.deepEqual(r.zeilen[0], { id: 'd1', name: 'Ben', art: 'dm', ungelesen: 5, letzte: { zeit: '2026-10-18T08:00:00Z' }, stumm: true });
  const viele = dashboard.chatZeilen({ raeume: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: String(i), ungelesen: 1 })) });
  assert.equal(viele.zeilen.length, 8); assert.equal(viele.summe, 12, 'Summe auch über die abgeschnittenen');
  assert.deepEqual(dashboard.chatZeilen(null), { zeilen: [], summe: 0 });
});

test('Standardgröße 4×6', () => { assert.deepEqual(raster.STANDARD_GROESSE.chat, [4, 6]); });
