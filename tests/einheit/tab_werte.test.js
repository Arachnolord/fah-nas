// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 4): Werte der Zellen – Datum im 1900-System von Excel (mit dem Schaltjahrfehler
// 29.02.1900), Anzeige der Zahlformate ohne Intl, interne Form und textIntern, Zwang und Vergleich wie Excel,
// Kriterien für SUMMEWENN/ZÄHLENWENN mit Platzhaltern und die Formate der Funktion TEXT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const {
  FEHLER, wertAusW, textIntern, zuZahl, zuText, vergleichen, datumZuSerie, serieZuDatum, jetztSerie, wertAnzeigen, textFormat, kriterium,
  platzhalterTest,
} = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln', 'werte.js')).href);

test('Datum im 1900-System mit Schaltjahrfehler', () => {
  assert.deepEqual([datumZuSerie(1900, 1, 1), datumZuSerie(1900, 2, 28), datumZuSerie(1900, 3, 1), datumZuSerie(2026, 10, 18)], [1, 59, 61, 46313]);
  assert.deepEqual(serieZuDatum(60), { j: 1900, m: 2, t: 29, std: 0, min: 0, sek: 0 });
  assert.deepEqual(serieZuDatum(46313.75), { j: 2026, m: 10, t: 18, std: 18, min: 0, sek: 0 });
  assert.equal(jetztSerie(new Date(2026, 9, 18, 18, 0)), 46313.75);
});
test('Anzeige der Zahlformate', () => {
  assert.deepEqual([[1234.5, 'standard'], [1234.5, 'zahl2'], [-1234.5, 'euro'], [0.125, 'prozent'], [46313, 'datum'], [46313.75, 'datum'], [1 / 3, null], [123456789012, null], [0.1 + 0.2, null]]
    .map(([w, z]) => wertAnzeigen(w, z)), ['1234,5', '1.234,50', '-1.234,50 €', '12,50 %', '18.10.2026', '18.10.2026 18:00', '0,3333333333', '1,23457E+11', '0,3']);
  assert.deepEqual([wertAnzeigen(true, null), wertAnzeigen(FEHLER.REF, null), wertAnzeigen(FEHLER.CIRC, null), wertAnzeigen('Text', 'euro'), wertAnzeigen(null, 'zahl2')], ['WAHR', '#BEZUG!', '#ZIRKEL', 'Text', '']);
});
test('interne Werte und textIntern', () => {
  assert.deepEqual(['1234.5', 'TRUE', "'007", 'Hallo', '1e+21'].map(wertAusW), [1234.5, true, '007', 'Hallo', 1e21]);
  assert.deepEqual(['007', 'TRUE', '=A1', "'x", 'Hallo'].map(textIntern), ["'007", "'TRUE", "'=A1", "''x", 'Hallo']);
});
test('Zwang und Vergleich wie Excel', () => {
  assert.deepEqual([zuZahl('3,5'), zuZahl('1.234'), zuZahl(true), zuZahl(null)], [3.5, 1234, 1, 0]); assert.deepEqual(zuZahl('abc'), FEHLER.VALUE);
  assert.deepEqual([zuText(1.5), zuText(false), zuText(null)], ['1,5', 'FALSCH', '']);
  assert.deepEqual([vergleichen(1, 'a'), vergleichen('a', 'B'), vergleichen('b', true), vergleichen('A', 'a'), vergleichen(null, 0)], [-1, -1, -1, 0, 0]);
});
test('Kriterien', () => {
  assert.deepEqual([5, 6, '7', 'x'].map(kriterium('>5')), [false, true, false, false]);
  assert.deepEqual(['Berlin', 'bern', 'Hamburg'].map(kriterium('Ber*')), [true, true, false]);
  assert.deepEqual([null, '', 'a', 0].map(kriterium('')), [true, true, false, false]);
  assert.deepEqual([null, 'a'].map(kriterium('<>')), [false, true]);
  assert.deepEqual(['*', 'a'].map(kriterium('~*')), [true, false]);
  assert.deepEqual([5.4, 5.6].map(kriterium('>5,5')), [false, true]);
  assert.deepEqual(['an', 'ann'].map(kriterium('?n')), [true, false]);
});
test('TEXT-Formate', () => {
  assert.deepEqual([[1234.567, '#.##0,00'], [0.256, '0%'], [46313, 'TT.MM.JJJJ'], [46313, 'DD.MM.YYYY'], [46313.5, 'hh:mm'], [7, '000'], ['abc', '0,00'], [3, '"Nr. "0']]
    .map(([w, f]) => textFormat(w, f)), ['1.234,57', '26%', '18.10.2026', '18.10.2026', '12:00', '007', 'abc', 'Nr. 3']);
});
test('Ergänzungen: volle Genauigkeit im Formeltext, Akzente zählen, Datum im Kriterium, Abschnitte in TEXT', () => {
  assert.deepEqual([zuText(123456789012), zuText(1 / 3), wertAnzeigen(12345678901, null)], ['123456789012', '0,333333333333333', '12345678901']);
  assert.deepEqual([vergleichen('Müller', 'muller'), vergleichen(0.1 + 0.2, 0.3)], [1, 0]);
  assert.deepEqual([46313, 46312, '18.10.2026'].map(kriterium('>=18.10.2026')), [true, false, false]);
  assert.deepEqual([textFormat(-5, '0;"neg"'), textFormat(46313, 'TTTT, T. MMMM JJJJ'), textFormat(-0.001, '0,00')], ['neg', 'Sonntag, 18. Oktober 2026', '0,00']);
});

test('Platzhalter ohne Zurückspringen: viele * auf langen Texten bleiben schnell (Prüfbericht I5)', () => {
  const t0 = performance.now();
  const ergebnisse = [
    platzhalterTest('*a*a*b')('a'.repeat(2000)), platzhalterTest('*a*a*a*a*b')('a'.repeat(200)), kriterium('*a*a*a*b')('a'.repeat(300)),
  ];
  const dauer = performance.now() - t0;
  assert.deepEqual(ergebnisse, [false, false, false]);
  assert.ok(dauer < 250, `Platzhalter brauchten ${dauer.toFixed(0)} ms`);
});

test('Platzhalter: *, ?, ~, Groß/Klein und ganze Zeichenkette wie bisher', () => {
  const p = (m, w) => platzhalterTest(m)(w);
  assert.deepEqual([
    p('a*c', 'ABC'), p('a*c', 'abcd'), p('*', ''), p('?', ''), p('?', 'ü'), p('a?c', 'abc'), p('a?c', 'ac'), p('*b*', 'abc'), p('**b', 'b'),
    p('a~*c', 'a*c'), p('a~*c', 'abc'), p('a~?', 'a?'), p('~~', '~'), p('~x', '~x'), p('MÜ*', 'müller'), p('*.csv', 'Liste.CSV'),
    p('a*b*c', 'aXbYc'), p('a*b*c', 'acb'), p('', ''), p('', 'x'), p('*a', 'ba'), p('*a', 'ab'), p('ab*ab', 'ab'), p('ab*ab', 'abab'),
    p('😀*', '😀x'), p('?', '😀'), p('1', 1), p('a(b)*', 'A(B)c'),
  ], [
    true, false, true, false, true, true, false, true, true,
    true, false, true, true, true, true, true,
    true, false, true, false, true, false, false, true,
    true, true, false, true,
  ]);
});
