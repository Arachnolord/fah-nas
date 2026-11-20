// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 7): Formeln übersetzen – deutsch (Oberfläche: SUMME, Semikolon, Komma, Blattnamen)
// ↔ intern (Daten: SUM, Komma, Punkt, [blattId]!) ↔ Excel (xlsx: englisch mit Blattnamen, _xlfn.); Eingaben lesen wie
// das deutsche Excel (Zahlen, Prozent, Euro, Datum, Wahrheitswerte, Text mit Apostroph) und zurück in die
// Bearbeitungszeile; Blattnamen prüfen und für Formeln schreiben.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FORMELN = path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln');
const {
  zuIntern, zuAnzeige, excelZuIntern, internZuExcel, eingabeZuIntern, internZuEingabe, blattNameAnzeige, blattNamePruefen,
} = await import(pathToFileURL(path.join(FORMELN, 'uebersetzen.js')).href);
const { FormelFehler } = await import(pathToFileURL(path.join(FORMELN, 'parser.js')).href);
const { datumZuSerie } = await import(pathToFileURL(path.join(FORMELN, 'werte.js')).href);

const BL = [{ id: 'blatt1', name: 'Tabelle1' }, { id: 'blatt2', name: 'Mein Blatt' }, { id: 'blatt3', name: 'Daten' }];
test('Rundreise deutsch → intern → deutsch verlustfrei', () => {
  for (const [de, intern] of [
    ['SUMME(A1:B3;2,5)', 'SUM(A1:B3,2.5)'], ['WENN(A1>=10;"groß";"klein")', 'IF(A1>=10,"groß","klein")'],
    ["SVERWEIS(A2;'Mein Blatt'!$A$1:$C$10;3;FALSCH)", 'VLOOKUP(A2,[blatt2]!$A$1:$C$10,3,FALSE)'],
    ['ZÄHLENWENN(Daten!A:A;">5,5")', 'COUNTIF([blatt3]!A:A,">5,5")'], ['-2^2+5%', '-2^2+5%'], ['A1&" €" ', 'A1&" €" '],
    ['RUNDEN(1,005; 2)', 'ROUND(1.005, 2)'], ['XVERWEIS(A1;B:B;C:C)', 'XVERWEIS(A1,B:B,C:C)'], ['#BEZUG!+1', '#REF!+1'], ['HEUTE()', 'TODAY()'], ['VERKETTEN(Tabelle1!A1;"x")', 'CONCATENATE([blatt1]!A1,"x")'],
  ]) { assert.equal(zuIntern(de, { blaetter: BL }), intern, de); assert.equal(zuAnzeige(intern, { blaetter: BL }), de, intern); }
});
test('Großschreibung, Blattnamen ohne Groß/Klein, unbekanntes Blatt, gelöschtes Blatt', () => {
  assert.equal(zuIntern('summe(a1)', { blaetter: BL }), 'SUM(A1)'); assert.equal(zuIntern('daten!a1', { blaetter: BL }), '[blatt3]!A1');
  assert.throws(() => zuIntern('Fehlt!A1', { blaetter: BL }), (e) => e instanceof FormelFehler && e.grund === 'blatt');
  assert.equal(zuAnzeige('[weg001]!A1*2', { blaetter: BL }), '#BEZUG!*2');
});
test('Excel ↔ intern', () => {
  assert.deepEqual(excelZuIntern("SUM('Mein Blatt'!A1:A3)+_xlfn.XLOOKUP(1,A:A,B:B)", { blaetter: BL }), { w: 'SUM([blatt2]!A1:A3)+_xlfn.XLOOKUP(1,A:A,B:B)', unbekannt: ['XLOOKUP'] });
  for (const s of ['Table1[Spalte]', 'Sheet1:Sheet2!A1', '[1]Blatt!A1', 'A1 B1']) assert.deepEqual(excelZuIntern(s, { blaetter: BL }), { fehler: 'formeln' }, s);
  assert.equal(internZuExcel('VLOOKUP(A2,[blatt2]!$A$1:$C$10,3,FALSE)+[weg001]!A1', { blaetter: BL }), "VLOOKUP(A2,'Mein Blatt'!$A$1:$C$10,3,FALSE)+#REF!");
});
test('Eingabe lesen wie deutsches Excel', () => {
  const E = (s, o) => eingabeZuIntern(s, { blaetter: BL, ...o });
  assert.deepEqual([E('1.234,5'), E('12,5 %'), E('1.234,50 €'), E('18.10.2026'), E('18.10.26'), E('31.02.2026')],
    [{ w: '1234.5' }, { w: '0.125', zahl: 'prozent' }, { w: '1234.5', zahl: 'euro' }, { w: '46313', zahl: 'datum' }, { w: '46313', zahl: 'datum' }, { w: '31.02.2026' }]);
  assert.deepEqual([E('=summe(a1:a3;2,5)'), E('wahr'), E("'0049"), E('0049'), E('1.5'), E('Hallo'), E(''), E('=')],
    [{ w: '=SUM(A1:A3,2.5)' }, { w: 'TRUE' }, { w: "'0049" }, { w: '49' }, { w: "'1.5" }, { w: 'Hallo' }, { w: null }, { w: "'=" }]);
  assert.deepEqual([E('1.5', { zahlen: 'en' }), E('5', { zahl: 'text' }), E('=A1', { zahl: 'text' }), E('=A1', { formeln: false })], [{ w: '1.5' }, { w: "'5" }, { w: "'=A1" }, { w: "'=A1" }]);
  assert.ok(Math.abs(Number(E('18.10.2026 14:30').w) - (46313 + 14.5 / 24)) < 1e-9);
  assert.throws(() => E('=1+'), FormelFehler);
});
test('intern → Eingabe', () => {
  const I = (w, zahl = null) => internZuEingabe(w, { blaetter: BL, zahl });
  assert.deepEqual([I('46313', 'datum'), I('0.125', 'prozent'), I('1234.5'), I("'0049"), I("'Hallo"), I('=SUM([blatt2]!A1,2.5)'), I('TRUE')],
    ['18.10.2026', '12,5 %', '1234,5', "'0049", 'Hallo', "=SUMME('Mein Blatt'!A1;2,5)", 'WAHR']);
});
test('Blattnamen', () => {
  assert.deepEqual([['', BL], ['x'.repeat(32), BL], ['a[b]', BL], ["'a", BL], ['daten', BL], ['Daten', BL, 'blatt3'], ['Neu', BL]].map(([n, b, id]) => blattNamePruefen(n, b, id)),
    ['leer', 'lang', 'zeichen', 'zeichen', 'doppelt', null, null]);
  assert.deepEqual(['Tabelle1', 'Mein Blatt', 'A1', 'WAHR'].map(blattNameAnzeige), ['Tabelle1', "'Mein Blatt'", "'A1'", "'WAHR'"]);
});
test('Ergänzungen: Prozent und Euro, Datum ohne Jahr und ISO, zu lange Formel, Excel-Sonderfälle, Eingabe zurück', () => {
  const E = (s, o) => eingabeZuIntern(s, { blaetter: BL, ...o });
  const jahr = new Date().getFullYear();
  assert.deepEqual([E('1,1%'), E('€ 5'), E('-3 €'), E('18.10.'), E('2026-10-18'), E('14:30'), E('1e999')],
    [{ w: '0.011', zahl: 'prozent' }, { w: '5', zahl: 'euro' }, { w: '-3', zahl: 'euro' }, { w: String(datumZuSerie(jahr, 10, 18)), zahl: 'datum' }, { w: '46313', zahl: 'datum' }, { w: '14:30' }, { w: "'1e999" }]);
  assert.throws(() => E(`=${'1+'.repeat(4096)}1`), FormelFehler);
  for (const s of ["'Sheet1:Sheet2'!A1", 'ROUND(1)', 'SUM(1)#NULL!']) assert.deepEqual(excelZuIntern(s, { blaetter: BL }), { fehler: 'formeln' }, s);
  assert.deepEqual(excelZuIntern("_xlfn.CONCAT(A1)&_xlfn.CONCAT(B1)+daten!A1", { blaetter: BL }), { w: '_xlfn.CONCAT(A1)&_xlfn.CONCAT(B1)+[blatt3]!A1', unbekannt: ['CONCAT'] });
  const I = (w, zahl = null) => internZuEingabe(w, { blaetter: BL, zahl });
  assert.deepEqual([I('46313.75', 'datum'), I('1234.5', 'euro'), I("'=x"), I("'18.10.2026"), I("'1.5"), I('5', 'text'), I(null), I("'")],
    ['18.10.2026 18:00', '1234,5', "'=x", "'18.10.2026", '1.5', '5', '', "'"]);
});

test('Neuere Excel-Funktionen behalten _xlfn./_xlws. – nach dem Export rechnet Excel sie wieder (Prüfbericht M3)', () => {
  for (const [excel, w, unbekannt, zurueck] of [
    ['_xlfn.XLOOKUP(1,A:A,B:B)', '_xlfn.XLOOKUP(1,A:A,B:B)', ['XLOOKUP'], '_xlfn.XLOOKUP(1,A:A,B:B)'],
    ['_xlfn._xlws.FILTER(A1:A3,B1:B3)', '_xlfn._xlws.FILTER(A1:A3,B1:B3)', ['FILTER'], '_xlfn._xlws.FILTER(A1:A3,B1:B3)'],
    ['_xlfn.SUM(A1)', 'SUM(A1)', [], 'SUM(A1)'],
  ]) {
    const r = excelZuIntern(excel, { blaetter: BL });
    assert.deepEqual(r, { w, unbekannt }, excel);
    assert.equal(internZuExcel(r.w, { blaetter: BL }), zurueck, excel);
  }
  assert.equal(zuAnzeige('_xlfn.XLOOKUP(1,A:A,B:B)', { blaetter: BL }), '_xlfn.XLOOKUP(1;A:A;B:B)');
  // in der Bearbeitungszeile geändert (groß geschrieben): der Export schreibt die Vorsilbe so, wie Excel sie erwartet
  assert.equal(internZuExcel(zuIntern('_xlfn.XLOOKUP(2;A:A;B:B)', { blaetter: BL }), { blaetter: BL }), '_xlfn.XLOOKUP(2,A:A,B:B)');
});
