// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 1): Spalten und Zelladressen, Grenzen, Formel-Lexer in den Modi intern (englisch,
// Blatt-ID), excel und anzeige (deutsch, Komma, Semikolon), Bezüge bis XFD1048576, Leerraum bleibt, zerlegen wirft nie,
// Bezüge zurück in Text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FORMELN = path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln');
const { spalteZuText, textZuSpalte, adresseLesen, bereichLesen, bereichText } = await import(pathToFileURL(path.join(FORMELN, 'adresse.js')).href);
const { zerlegen, tokensText, bezugText } = await import(pathToFileURL(path.join(FORMELN, 'lexer.js')).href);

test('Spalten und Adressen', () => {
  assert.deepEqual([1, 26, 27, 52, 702, 703, 1024].map(spalteZuText), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA', 'AMJ']);
  assert.deepEqual(['A', 'z', 'AMJ', '', 'A1'].map(textZuSpalte), [1, 26, 1024, 0, 0]);
  assert.deepEqual(adresseLesen('B3'), { z: 3, s: 2 });
  for (const s of ['$B$3', 'B0', 'AMK1', 'A100001', 'b3x']) assert.equal(adresseLesen(s), null, s);
  assert.deepEqual(bereichLesen('C3:A1'), { z1: 1, s1: 1, z2: 3, s2: 3 }); assert.equal(bereichText({ z1: 2, s1: 2, z2: 2, s2: 2 }), 'B2');
});
test('intern: Zahlen, Text, Bezüge, Funktionen; Leerraum bleibt', () => {
  const t = zerlegen('SUM([blatt2]!$A$1:B3, 2.5) & "a""b"');
  assert.deepEqual(t.map((x) => x.art), ['funktion', 'auf', 'bezug', 'trenner', 'leer', 'zahl', 'zu', 'leer', 'op', 'leer', 'text']);
  assert.deepEqual(t[2], { art: 'bezug', text: '[blatt2]!$A$1:B3', blatt: 'blatt2', von: { z: 1, s: 1, zAbs: true, sAbs: true }, bis: { z: 3, s: 2, zAbs: false, sAbs: false } });
  assert.equal(t[5].wert, 2.5); assert.equal(t[10].wert, 'a"b');
  assert.equal(tokensText(zerlegen('SUM(A1)  +1')), 'SUM(A1)  +1');
});
test('anzeige: Komma, Semikolon, Blattnamen, deutsche Fehler und Wahrheitswerte', () => {
  const t = zerlegen("SUMME('Mein Blatt'!A:A;1,5;WAHR;#BEZUG!)", 'anzeige');
  assert.deepEqual(t.map((x) => x.art), ['funktion', 'auf', 'bezug', 'trenner', 'zahl', 'trenner', 'bool', 'trenner', 'fehler', 'zu']);
  assert.deepEqual([t[2].blatt, t[2].von.z, t[2].von.s, t[2].bis.s, t[4].wert, t[6].wert, t[8].wert], ['Mein Blatt', null, 1, 1, 1.5, true, '#REF!']);
  assert.equal(zerlegen("'O''Neil'!B2", 'anzeige')[0].blatt, "O'Neil");
  assert.deepEqual(zerlegen('2:4', 'anzeige')[0].von, { z: 2, s: null, zAbs: false, sAbs: false });
});
test('Funktion vor Bezug, Bezug bis XFD1048576, sonst Name', () => {
  assert.deepEqual(zerlegen('LOG10(A1)').slice(0, 1).map((x) => x.art), ['funktion']);
  assert.equal(zerlegen('XFD1048576')[0].art, 'bezug'); assert.equal(zerlegen('XFE1')[0].art, 'name'); assert.equal(zerlegen('TRUE')[0].art, 'bool');
});
test('zerlegen wirft nie; Unbekanntes wird markiert', () => {
  for (const s of ['', '@', 'SUM(', '"offen', '[x!A1', '1,,2', '\u0000']) assert.doesNotThrow(() => zerlegen(s), s);
  assert.ok(zerlegen('A1 @ 2').some((x) => x.art === 'unbekannt')); assert.equal(zerlegen('"offen').at(-1).art, 'unbekannt');
});
test('bezugText', () => {
  assert.equal(bezugText({ blatt: 'blatt2', von: { z: 1, s: 1, zAbs: true, sAbs: false }, bis: null }, 'intern'), '[blatt2]!A$1');
  assert.equal(bezugText({ blatt: 'Mein Blatt', von: { z: null, s: 2, zAbs: false, sAbs: false }, bis: { z: null, s: 3, zAbs: false, sAbs: false } }, 'anzeige'), "'Mein Blatt'!B:C");
});
test('bezugText quotet nur wo nötig; Blatt ohne Namen → Fehlerwert des Modus', () => {
  const a1 = { z: 1, s: 1, zAbs: false, sAbs: false };
  assert.deepEqual(['Daten', 'Tab1', 'WAHR', "O'Neil", '2026', 'R1C1'].map((blatt) => bezugText({ blatt, von: a1, bis: null }, 'excel')),
    ['Daten!A1', "'Tab1'!A1", "'WAHR'!A1", "'O''Neil'!A1", "'2026'!A1", "'R1C1'!A1"]);
  assert.equal(bezugText({ blatt: 'weg', von: a1, bis: null }, 'anzeige', () => null), '#BEZUG!');
  assert.equal(bezugText({ blatt: null, von: a1, bis: { z: 2, s: 3, zAbs: true, sAbs: true } }, 'intern'), 'A1:$C$2');
});
test('Grenzen wählbar (Zellen jenseits GRENZEN nach dem Einfügen), nur kanonische Adressen', () => {
  const frei = { zeilen: Infinity, spalten: Infinity };
  assert.deepEqual(adresseLesen('A100001', frei), { z: 100001, s: 1 });
  assert.deepEqual(bereichLesen('B100002:A99999', frei), { z1: 99999, s1: 1, z2: 100002, s2: 2 });
  assert.equal(bereichLesen('A99999:B100002'), null);
  for (const s of ['b3', 'B03', 'A1:B2:C3']) assert.equal(adresseLesen(s) ?? bereichLesen(s), null, s);
});
