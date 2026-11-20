// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 3): Bezüge wie Excel verschieben – beim Einfügen und Löschen von Zeilen/Spalten
// (nur das betroffene Blatt, gelöschte Bezüge → #REF!, Bereiche wachsen und schrumpfen, Rand XFD1048576) und beim
// Kopieren (relative Teile wandern, absolute bleiben). Unbetroffene Teile der Formel bleiben zeichengleich.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { indexVerschieben, spanneVerschieben, strukturVerschieben, formelVerschieben } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln', 'verschieben.js')).href);

const Z = (art, ab, anzahl, blatt = 'blatt1') => ({ eigenesBlatt: 'blatt1', blatt, achse: 'zeilen', art, ab, anzahl });
const S = (art, ab, anzahl) => ({ eigenesBlatt: 'blatt1', blatt: 'blatt1', achse: 'spalten', art, ab, anzahl });
test('Einfügen: ab der Stelle rücken, Bereiche wachsen innen, Bereichsanfang verschiebt', () => {
  assert.equal(strukturVerschieben('A4+A5+$A$6', Z('einfuegen', 5, 2)), 'A4+A7+$A$8');
  assert.equal(strukturVerschieben('SUM(A3:A5)', Z('einfuegen', 5, 2)), 'SUM(A3:A7)');
  assert.equal(strukturVerschieben('SUM(A5:A8)', Z('einfuegen', 5, 2)), 'SUM(A7:A10)');
  assert.equal(strukturVerschieben('SUM(A3:A5)', Z('einfuegen', 6, 2)), 'SUM(A3:A5)');
  assert.equal(strukturVerschieben('SUM(B:B)+SUM(2:4)', Z('einfuegen', 3, 1)), 'SUM(B:B)+SUM(2:5)');
});
test('Löschen: gelöschte Bezüge → #REF!, Bereiche schrumpfen', () => {
  assert.equal(strukturVerschieben('A4+A10', Z('loeschen', 3, 3)), '#REF!+A7');
  assert.equal(strukturVerschieben('SUM(A4:A10)', Z('loeschen', 3, 3)), 'SUM(A3:A7)');
  assert.equal(strukturVerschieben('SUM(A1:A4)', Z('loeschen', 3, 3)), 'SUM(A1:A2)');
  assert.equal(strukturVerschieben('SUM(A3:A5)', Z('loeschen', 3, 3)), 'SUM(#REF!)');
  assert.equal(strukturVerschieben('[blatt1]!A4*2', { ...Z('loeschen', 4, 1), eigenesBlatt: 'blatt2' }), '#REF!*2');
});
test('nur das betroffene Blatt; Text und Funktionsnamen bleiben', () => {
  assert.equal(strukturVerschieben('A5+[blatt1]!A5', { eigenesBlatt: 'blatt2', blatt: 'blatt1', achse: 'zeilen', art: 'einfuegen', ab: 1, anzahl: 1 }), 'A5+[blatt1]!A6');
  assert.equal(strukturVerschieben('"A5"&LOG10(A5)', Z('einfuegen', 1, 1)), '"A5"&LOG10(A6)');
  assert.equal(strukturVerschieben('SUM(A1:C1)+D1', S('loeschen', 2, 1)), 'SUM(A1:B1)+C1');
});
test('index und Spanne', () => {
  assert.deepEqual([4, 5, 6, 8].map((i) => indexVerschieben(i, { art: 'loeschen', ab: 5, anzahl: 2 })), [4, null, null, 6]);
  assert.deepEqual(spanneVerschieben(4, 10, { art: 'loeschen', ab: 3, anzahl: 3 }), [3, 7]);
  assert.equal(spanneVerschieben(3, 5, { art: 'loeschen', ab: 3, anzahl: 3 }), null);
});
test('formelVerschieben: relativ wandert, absolut bleibt, Rand → #REF!', () => {
  assert.equal(formelVerschieben('A1+$A1+A$1+$A$1', 2, 1), 'B3+$A3+B$1+$A$1');
  assert.equal(formelVerschieben('SUM(A1:A3)', -1, 0), 'SUM(#REF!)');
  assert.equal(formelVerschieben('A2', -1, 0), 'A1');
  assert.equal(formelVerschieben('B:B', 0, 1), 'C:C');
  assert.equal(formelVerschieben('SUMIF(Tab1!A1:A2, ">5")', 1, 0, 'excel'), 'SUMIF(Tab1!A2:A3, ">5")');
});
test('Rand XFD1048576: Einzelbezug → #REF!, Bereichsende bleibt am Rand; umgedrehte Bereiche; ganze Spalte gelöscht', () => {
  assert.equal(strukturVerschieben('A1048576+SUM(A2:A1048576)+SUM(A1048576:A1048576)', Z('einfuegen', 1, 1)), '#REF!+SUM(A3:A1048576)+SUM(#REF!)');
  assert.equal(strukturVerschieben('SUM(A1:XFD1)', S('einfuegen', 2, 1)), 'SUM(A1:XFD1)');
  assert.equal(strukturVerschieben('SUM(A5:A3)', Z('einfuegen', 4, 2)), 'SUM(A3:A7)');
  assert.equal(strukturVerschieben('SUM($A5:A$3)', Z('einfuegen', 1, 1)), 'SUM($A$4:A6)');
  assert.equal(strukturVerschieben('SUM(B:B)+C1', S('loeschen', 2, 1)), 'SUM(#REF!)+B1');
  assert.equal(formelVerschieben('XFD1+A1048576', 0, 1), '#REF!+B1048576');
  assert.equal(formelVerschieben("'Mein Blatt'!A1&Tab1!B2", 1, 0, 'anzeige'), "'Mein Blatt'!A2&Tab1!B3");
  assert.equal(formelVerschieben('A1*2', -1, 0, 'anzeige'), '#BEZUG!*2');
});
