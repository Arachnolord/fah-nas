// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rückgängig und Wiederholen im Dokument (Plan 05 Aufgabe 8): eigene Änderungen innerhalb von 500 ms bilden einen
// Schritt, fremde Änderungen verschieben die Stapel (Rückgängig nimmt nur Eigenes zurück), höchstens 200 Schritte,
// eine neue eigene Änderung leert Wiederholen, Tabellen-Änderungen lassen sich umkehren.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const { Rueckgaengig } = await import(pathToFileURL(path.join(PUBLIC, 'office', 'dokument', 'verlauf.js')).href);
const { anwenden } = await import(pathToFileURL(path.join(PUBLIC, 'gemeinsam', 'sync', 'delta.js')).href);
await import(pathToFileURL(path.join(PUBLIC, 'gemeinsam', 'sync', 'typen', 'dokument.js')).href); // trägt die Embed-Handler ein

test('Gruppierung 500 ms', () => {
  const v = new Rueckgaengig(); let dok = [{ insert: '\n' }];
  const tippe = (d, t) => { v.eigene(d, dok, t); dok = anwenden(dok, d); };
  tippe([{ insert: 'H' }], 0); tippe([{ retain: 1 }, { insert: 'a' }], 100); tippe([{ retain: 2 }, { insert: '!' }], 700);
  assert.equal(v.kannZurueck, true); assert.equal(v.kannVor, false);
  assert.deepEqual(v.rueckgaengig(dok), [{ retain: 2 }, { delete: 1 }]); dok = anwenden(dok, [{ retain: 2 }, { delete: 1 }]);
  assert.deepEqual(v.rueckgaengig(dok), [{ delete: 2 }]); assert.equal(v.rueckgaengig(anwenden(dok, [{ delete: 2 }])), null);
  assert.equal(v.kannZurueck, false); assert.equal(v.kannVor, true);
  // tippen und gleich wieder löschen hebt sich auf: kein leerer Schritt
  const w = new Rueckgaengig(); let s = [{ insert: '\n' }];
  w.eigene([{ insert: 'a' }], s, 0); s = anwenden(s, [{ insert: 'a' }]);
  w.eigene([{ delete: 1 }], s, 100); s = anwenden(s, [{ delete: 1 }]);
  assert.equal(w.kannZurueck, false);
  // nach Wiederholen beginnt eine neue Gruppe, auch wenn der Wiederholen-Stapel leer ist
  w.eigene([{ insert: 'A' }], s, 1000); s = anwenden(s, [{ insert: 'A' }]);
  s = anwenden(s, w.rueckgaengig(s)); s = anwenden(s, w.wiederholen(s));
  w.eigene([{ retain: 1 }, { insert: 'B' }], s, 1100); s = anwenden(s, [{ retain: 1 }, { insert: 'B' }]);
  assert.deepEqual(w.rueckgaengig(s), [{ retain: 1 }, { delete: 1 }]);
});

test('fremde Änderung verschiebt den Verlauf (Review Focus 2)', () => {
  const v = new Rueckgaengig(); let dok = [{ insert: '\n' }];
  v.eigene([{ insert: 'Hallo' }], dok, 0); dok = anwenden(dok, [{ insert: 'Hallo' }]);
  v.fremde([{ insert: 'Ben: ' }]); dok = anwenden(dok, [{ insert: 'Ben: ' }]);
  const z = v.rueckgaengig(dok); assert.deepEqual(z, [{ retain: 5 }, { delete: 5 }]); dok = anwenden(dok, z);
  assert.deepEqual(dok, [{ insert: 'Ben: \n' }]);
  assert.deepEqual(v.wiederholen(dok), [{ retain: 5 }, { insert: 'Hallo' }]);
  // löscht jemand den eigenen Text ganz, bleibt nichts zum Zurücknehmen
  const w = new Rueckgaengig(); let d2 = [{ insert: '\n' }];
  w.eigene([{ insert: 'ab' }], d2, 0); d2 = anwenden(d2, [{ insert: 'ab' }]);
  w.fremde([{ delete: 2 }]);
  assert.equal(w.kannZurueck, false);
});

test('neue eigene Änderung leert Wiederholen; max 200; Tabellen-Embed invertierbar', () => {
  assert.equal(new Rueckgaengig().max, 200); assert.equal(new Rueckgaengig().gruppierenMs, 500);
  const v = new Rueckgaengig({ max: 3 }); let dok = [{ insert: '\n' }];
  for (let i = 0; i < 5; i++) {
    const d = i ? [{ retain: i }, { insert: String(i) }] : [{ insert: '0' }];
    v.eigene(d, dok, i * 1000); dok = anwenden(dok, d);
  }
  let n = 0;
  for (;;) { const u = v.rueckgaengig(dok); if (!u) break; dok = anwenden(dok, u); n++; }
  assert.equal(n, 3, 'nur die letzten 3 Schritte'); assert.deepEqual(dok, [{ insert: '01\n' }]);
  assert.equal(v.kannVor, true);
  const r = v.wiederholen(dok); dok = anwenden(dok, r);
  assert.deepEqual(dok, [{ insert: '012\n' }]);
  v.eigene([{ retain: 3 }, { insert: 'x' }], dok, 20_000); dok = anwenden(dok, [{ retain: 3 }, { insert: 'x' }]);
  assert.equal(v.kannVor, false, 'neue eigene Änderung leert Wiederholen');
  // nach Rückgängig beginnt eine neue Gruppe, auch innerhalb von 500 ms
  const u = v.rueckgaengig(dok); dok = anwenden(dok, u);
  v.eigene([{ retain: 3 }, { insert: 'y' }], dok, 20_100); dok = anwenden(dok, [{ retain: 3 }, { insert: 'y' }]);
  assert.deepEqual(v.rueckgaengig(dok), [{ retain: 3 }, { delete: 1 }]);
  v.leeren(); assert.equal(v.kannZurueck, false); assert.equal(v.kannVor, false);

  const tab = { id: 'tab001', zeilen: ['z00001'], spalten: ['s00001'], weg: [], zellen: {}, breiten: {} };
  const d0 = [{ insert: { tabelle: tab } }, { insert: '\n' }];
  const t = new Rueckgaengig();
  const aend = [{ retain: { tabelle: [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'Hi' }] }] } }];
  t.eigene(aend, d0, 0); const d1 = anwenden(d0, aend);
  const zurueck = t.rueckgaengig(d1); const d2 = anwenden(d1, zurueck);
  assert.deepEqual(d2, d0);
  assert.deepEqual(anwenden(d2, t.wiederholen(d2)), d1);
});
