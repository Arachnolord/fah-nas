// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 5): die 17 Funktionen wie in Excel – Bereiche zählen nur Zahlen, direkte Argumente
// werden umgewandelt, Fehler gehen zurück, WENN wertet nur den gewählten Zweig aus, RUNDEN halb vom Nullpunkt weg,
// SVERWEIS genau (mit Platzhaltern) und ungefähr, SUMMEWENN/ZÄHLENWENN mit Kriterien, HEUTE/JETZT, TEXT, VERKETTEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FORMELN = path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln');
const { FUNKTIONEN, istBereich } = await import(pathToFileURL(path.join(FORMELN, 'funktionen.js')).href);
const { FEHLER } = await import(pathToFileURL(path.join(FORMELN, 'werte.js')).href);

const JETZT = { jetzt: () => new Date(2026, 9, 18, 18, 0) };
const LEER = { art: 'leer' };
/** Bereich aus einer Matrix (Zeilen von Werten, null = leer); belegte() zeilenweise, nur nicht leere. */
const B = (matrix) => ({
  art: 'bereich', zeilen: matrix.length, spalten: Math.max(0, ...matrix.map((z) => z.length)),
  wert: (i, j) => matrix[i]?.[j] ?? null,
  * belegte() { for (let i = 0; i < matrix.length; i++) for (let j = 0; j < matrix[i].length; j++) if (matrix[i][j] !== null) yield { i, j, wert: matrix[i][j] }; },
});
/** Funktion mit faulen Argumenten aufrufen. */
const F = (name, ...args) => FUNKTIONEN[name].fn(args.map((a) => () => a), JETZT);

test('SUMME, MITTELWERT, MIN, MAX', () => {
  assert.equal(F('SUM', B([[1, 2, 'x', true, null]]), 3), 6); assert.equal(F('SUM', '4', true), 5);
  assert.deepEqual(F('SUM', 'a'), FEHLER.VALUE); assert.deepEqual(F('SUM', B([[1, FEHLER.DIV0]])), FEHLER.DIV0);
  assert.equal(F('AVERAGE', B([[1, 2, 3, 'x']])), 2); assert.deepEqual(F('AVERAGE', B([['x']])), FEHLER.DIV0);
  assert.deepEqual([F('MIN', B([[3, 1, 'x']])), F('MIN', B([[]])), F('MAX', B([[-1, -5]]))], [1, 0, -1]);
});
test('ANZAHL und ANZAHL2', () => {
  assert.equal(F('COUNT', B([[1, '2', true, null, 'x']]), 3, '4'), 3);
  assert.equal(F('COUNTA', B([[1, '', null, 'x', FEHLER.NA]])), 4);
});
test('WENN, UND, ODER', () => {
  assert.deepEqual([F('IF', true, 'ja', 'nein'), F('IF', 0, 1), F('IF', true, LEER)], ['ja', false, 0]);
  assert.deepEqual(F('IF', 'x', 1, 2), FEHLER.VALUE);
  let gerufen = 0; FUNKTIONEN.IF.fn([() => true, () => 1, () => { gerufen++; return 2; }], JETZT); assert.equal(gerufen, 0);
  assert.equal(F('AND', true, 1, B([[true, 'x']])), true); assert.deepEqual(F('AND', B([['x']])), FEHLER.VALUE);
  assert.deepEqual([F('OR', false, 0), F('OR', B([[false, true]]))], [false, true]);
});
test('RUNDEN halb vom Nullpunkt weg, robust gegen Gleitkomma', () => {
  assert.deepEqual([F('ROUND', 2.675, 2), F('ROUND', 1.005, 2), F('ROUND', -1.5, 0), F('ROUND', 1234.5, -2)], [2.68, 1.01, -2, 1200]);
});
test('SVERWEIS genau und ungefähr', () => {
  const T = B([[1, 'a'], [3, 'c'], [5, 'e']]);
  assert.deepEqual([F('VLOOKUP', 3, T, 2, false), F('VLOOKUP', 4, T, 2, true), F('VLOOKUP', 4, T, 2)], ['c', 'c', 'c']);
  assert.deepEqual([F('VLOOKUP', 4, T, 2, false), F('VLOOKUP', 0, T, 2), F('VLOOKUP', 3, T, 3, false), F('VLOOKUP', 3, T, 0, false)], [FEHLER.NA, FEHLER.NA, FEHLER.REF, FEHLER.VALUE]);
  assert.deepEqual([F('VLOOKUP', 'C*', B([['Anna', 1], ['Carl', 2]]), 2, false), F('VLOOKUP', 'carl', B([['Anna', 1], ['Carl', 2]]), 2, false)], [2, 2]);
});
test('SUMMEWENN und ZÄHLENWENN', () => {
  assert.equal(F('SUMIF', B([[1], [6], [7]]), '>5'), 13);
  assert.equal(F('SUMIF', B([['a'], ['b'], ['a']]), 'a', B([[1], [2], [3]])), 4);
  assert.deepEqual([F('COUNTIF', B([['Berlin'], ['Bern'], ['Hamburg']]), 'Ber*'), F('COUNTIF', B([[1], [null], ['']]), '')], [2, 2]);
});
test('HEUTE, JETZT, TEXT, VERKETTEN', () => {
  assert.deepEqual([F('TODAY'), F('NOW'), F('TEXT', 1234.5, '#.##0,00'), F('CONCATENATE', 'a', 1.5, true)], [46313, 46313.75, '1.234,50', 'a1,5WAHR']);
  assert.deepEqual(F('CONCATENATE', B([['a', 'b']])), FEHLER.VALUE);
});
test('Ergänzungen: Zellbezug als 1×1-Bereich, Summenbereich mit anderer Größe, leere Zellen bei SUMMEWENN', () => {
  assert.equal(istBereich(B([[1]])), true); assert.equal(istBereich({ fehler: '#REF!' }), false);
  // Ein einzelner Zellbezug kommt als 1×1-Bereich: SUMME ignoriert Text darin, WENN/VERKETTEN lesen den Wert.
  assert.deepEqual([F('SUM', B([['abc']]), 2), F('IF', B([[true]]), 'ja'), F('CONCATENATE', B([[1.5]]), 'x')], [2, 'ja', '1,5x']);
  // Summenbereich nur oben links angegeben: er hat die Größe des ersten Bereichs.
  assert.equal(F('SUMIF', B([['a'], ['b'], ['a']]), 'a', { ...B([[1], [2], [3]]), zeilen: 1 }), 4);
  assert.equal(F('SUMIF', B([['a'], [null], ['a']]), '', B([[1], [2], [3]])), 2);
  assert.deepEqual([F('VLOOKUP', 'x', B([['x', null]]), 2, false), F('ROUND', -0.001, 2)], [null, 0]);
});
