// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 6): der Rechner – Formeln Ende zu Ende mit Excel-Vorrang und Fehlerwerten,
// Abhängigkeitsgraph (nur betroffene Zellen rechnen neu), Zirkel erkennen und wieder auflösen (Review Focus 3),
// lange Ketten ohne Stapelüberlauf, dünne Spalten-/Zeilenbereiche und HEUTE/JETZT nur über volatileNeu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mappe, werteVon, tiefFrieren, kontrast } from './tab_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FORMELN = path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln');
const { Rechner, abhaengigkeiten } = await import(pathToFileURL(path.join(FORMELN, 'auswerter.js')).href);
const { FEHLER } = await import(pathToFileURL(path.join(FORMELN, 'werte.js')).href);
const { parsen } = await import(pathToFileURL(path.join(FORMELN, 'parser.js')).href);

test('rechnet Formeln, Text mit Apostroph, Blattbezug', () => {
  const r = new Rechner(); r.setzen(mappe({ blatt1: { A1: '1', A2: '2', A3: '=A1+A2', B1: '=SUM(A1:A3)*2', C1: '=[blatt2]!A1&"x"' }, blatt2: { A1: "'007" } }));
  assert.deepEqual([r.wert('blatt1', 'A3'), r.wert('blatt1', 'B1'), r.wert('blatt1', 'C1'), r.wert('blatt1', 'Z9')], [3, 12, '007x', null]);
});
test('Vorrang und Fehler Ende zu Ende', () => {
  const faelle = { A1: ['=-2^2', 4], A2: ['=2^3^2', 64], A3: ['=1+2*3', 7], A4: ['=50%*4', 2], A5: ['="a"&1+1', 'a2'], A6: ['=1=1', true], A7: ['="a"="A"', true],
    A8: ['=1/0', FEHLER.DIV0], A9: ['=FOO(1)', FEHLER.NAME], A10: ['=#REF!+1', FEHLER.REF], A11: ['=B1:B2', FEHLER.VALUE], A12: ['=10^400', FEHLER.NUM], A13: ['=[weg001]!A1', FEHLER.REF], A14: ['=Umsatz', FEHLER.NAME] };
  const r = new Rechner(); r.setzen(mappe({ blatt1: Object.fromEntries(Object.entries(faelle).map(([a, [w]]) => [a, w])) }));
  for (const [a, [, soll]] of Object.entries(faelle)) assert.deepEqual(r.wert('blatt1', a), soll, a);
});
test('nur betroffene Zellen werden neu gerechnet', () => {
  const z = { A1: '1', A2: '2', A3: '=A1+A2', B1: '=SUM(A1:A3)*2', C1: '=A2*10' }; const r = new Rechner(); r.setzen(mappe({ blatt1: z }));
  assert.equal(r.statistik.berechnet, 3);
  assert.deepEqual([...r.aendern(mappe({ blatt1: { ...z, A1: '5' } }), 'blatt1', ['A1'])].sort(), ['blatt1|A1', 'blatt1|A3', 'blatt1|B1']);
  assert.equal(r.statistik.berechnet, 5); assert.deepEqual([r.wert('blatt1', 'A3'), r.wert('blatt1', 'B1')], [7, 28]);
});
test('Zirkel (Review Focus 3): erkannt, weitergereicht, wieder aufgelöst', () => {
  const z = { A1: '=B1', B1: '=A1', C1: '=A1+1', D1: '=D1' }; const r = new Rechner(); r.setzen(mappe({ blatt1: z }));
  assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map((a) => r.wert('blatt1', a)), [FEHLER.CIRC, FEHLER.CIRC, FEHLER.CIRC, FEHLER.CIRC]);
  r.aendern(mappe({ blatt1: { ...z, B1: '5' } }), 'blatt1', ['B1']);
  assert.deepEqual(['A1', 'B1', 'C1'].map((a) => r.wert('blatt1', a)), [5, 5, 6]);
});
test('Kette über 20 000 Zeilen ohne Stapelüberlauf', () => {
  const z = { A1: '1' }; for (let i = 2; i <= 20000; i++) z[`A${i}`] = `=A${i - 1}+1`;
  const r = new Rechner(); r.setzen(mappe({ blatt1: z })); assert.equal(r.wert('blatt1', 'A20000'), 20000);
  r.aendern(mappe({ blatt1: { ...z, A1: '5' } }), 'blatt1', ['A1']); assert.equal(r.wert('blatt1', 'A20000'), 20004);
});
test('Spalten- und Zeilenbereiche sind dünn und reagieren auf neue Zellen', () => {
  const z = { A1: '1', A2: '2', A3: '3', A100: '10', B1: '=SUM(A:A)', B2: '=COUNTA(3:3)' }; const r = new Rechner(); r.setzen(mappe({ blatt1: z }));
  assert.deepEqual([r.wert('blatt1', 'B1'), r.wert('blatt1', 'B2')], [16, 1]);
  r.aendern(mappe({ blatt1: { ...z, A5000: '4' } }), 'blatt1', ['A5000']); assert.equal(r.wert('blatt1', 'B1'), 20);
});
test('HEUTE nur über volatileNeu', () => {
  let jetzt = new Date(2026, 9, 18, 9, 0); const r = new Rechner({ jetzt: () => jetzt }); const d = mappe({ blatt1: { A1: '=TODAY()', A2: '=A1+1' } });
  r.setzen(d); assert.equal(r.wert('blatt1', 'A2'), 46314);
  jetzt = new Date(2026, 9, 19, 9, 0); assert.deepEqual([...r.volatileNeu(d)].sort(), ['blatt1|A1', 'blatt1|A2']); assert.equal(r.wert('blatt1', 'A2'), 46315);
});
test('Ergänzungen: Zellbezug in Funktionen, lange Formelketten, Bereich als Ergebnis, abhaengigkeiten', () => {
  const kette = `=1${'+1'.repeat(4000)}`, minus = `=${'-'.repeat(8000)}1`;
  const r = new Rechner(); r.setzen(mappe({ blatt1: { A1: 'x', A2: '2', B1: '=SUM(A1,A2)', B2: kette, B3: minus, B4: '=A1:A1&"!"', B5: '=IF(TRUE,A1:A2)', B6: '=SUM(IF(TRUE,A1:A2))', B7: '=0.1+0.2=0.3', B8: '=C9', B9: '=VLOOKUP("x",A1:C1,3,FALSE)&""' } }));
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map((a) => r.wert('blatt1', a)), [2, 4001, 1, 'x!', FEHLER.VALUE, 2, true, 0, '']);
  assert.deepEqual(abhaengigkeiten(parsen('SUM(A1:B2,[blatt2]!C:C)+3:4+$D$5'), 'blatt1'), [
    { blatt: 'blatt1', z1: 1, s1: 1, z2: 2, s2: 2 }, { blatt: 'blatt2', z1: null, s1: 3, z2: null, s2: 3 }, { blatt: 'blatt1', z1: 3, s1: null, z2: 4, s2: null }, { blatt: 'blatt1', z1: 5, s1: 4, z2: 5, s2: 4 }]);
});
test('Ergänzungen: neues Blatt, Formel wird Wert, Zelle wird leer, Selbstbezug über Bereich', () => {
  const r = new Rechner(); r.setzen(mappe({ blatt1: { A1: '=[blatt2]!A1+1', B1: '=SUM(B2:B3)', B2: '=A1*2', C1: '=SUM(C:C)' } }));
  assert.deepEqual([r.wert('blatt1', 'A1'), r.wert('blatt1', 'B1'), r.wert('blatt1', 'C1')], [FEHLER.REF, FEHLER.REF, FEHLER.CIRC]);
  const d = mappe({ blatt1: { A1: '=[blatt2]!A1+1', B1: '=SUM(B2:B3)', B2: '=A1*2', C1: '=SUM(C:C)' }, blatt2: { A1: '41' } });
  assert.deepEqual([...r.aendern(d, 'blatt2', ['A1'])].sort(), ['blatt1|A1', 'blatt1|B1', 'blatt1|B2', 'blatt2|A1']); assert.equal(r.wert('blatt1', 'B1'), 84);
  const ohneB2 = mappe({ blatt1: { A1: '=[blatt2]!A1+1', B1: '=SUM(B2:B3)', B2: '7' }, blatt2: { A1: '41' } });
  r.aendern(ohneB2, 'blatt1', ['B2', 'C1']); assert.deepEqual([r.wert('blatt1', 'B1'), r.wert('blatt1', 'C1')], [7, null]);
});
test('Ergänzungen: SVERWEIS genau über den Suchindex – Groß/Klein, Umlaute, erster Treffer, geänderte Tabelle', () => {
  const z = { A1: 'Müller', B1: '1', A2: 'MÜLLER', B2: '2', A3: '5', B3: '3', A4: 'Straße', B4: '4',
    C1: '=VLOOKUP("müller",A1:B4,2,FALSE)', C2: '=VLOOKUP(5,A1:B4,2,FALSE)', C3: '=VLOOKUP("STRAẞE",A1:B4,2,FALSE)', C4: '=VLOOKUP("Mu*",A1:B4,2,FALSE)', C5: '=VLOOKUP("Muller",A1:B4,2,FALSE)', C6: '=VLOOKUP("5",A1:B4,2,FALSE)' };
  const r = new Rechner(); r.setzen(mappe({ blatt1: z }));
  assert.deepEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((a) => r.wert('blatt1', a)), [1, 3, 4, FEHLER.NA, FEHLER.NA, FEHLER.NA]);
  r.aendern(mappe({ blatt1: { ...z, A1: 'Meier' } }), 'blatt1', ['A1']);
  assert.deepEqual(['C1', 'C4'].map((a) => r.wert('blatt1', a)), [2, FEHLER.NA]);
});
test('Testhilfen', () => {
  const d = tiefFrieren(mappe({ blatt1: { A1: '1', A2: ['', { fett: true }] }, blatt2: {} }));
  assert.deepEqual(d.blaetter.map((b) => [b.id, b.name, b.pos]), [['blatt1', 'Tabelle1', 'i'], ['blatt2', 'Tabelle2', 'r']]);
  assert.deepEqual(d.blaetter[0].zellen, { A1: { w: '1' }, A2: { f: { fett: true } } }); assert.ok(Object.isFrozen(d.blaetter[0].zellen.A2.f));
  assert.deepEqual(werteVon(d, 'blatt1'), { A1: '1' }); assert.equal(Math.round(kontrast('#000000', '#ffffff')), 21);
});
