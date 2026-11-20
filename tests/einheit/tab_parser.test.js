// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 2): Formel-Parser mit Excel-Vorrang (Potenz links-assoziativ, unäres Minus vor ^,
// % nachgestellt), Funktionen mit leeren Argumenten und Stelligkeit, Fehler mit Grund und Position, keine
// Stapelüberläufe bei tiefer Verschachtelung; Funktionstabelle deutsch ↔ englisch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FORMELN = path.join(HIER, '..', '..', 'public', 'office', 'tabelle', 'formeln');
const { parsen, FormelFehler } = await import(pathToFileURL(path.join(FORMELN, 'parser.js')).href);
const { FUNKTIONEN, funktionAusDeutsch, funktionAufDeutsch } = await import(pathToFileURL(path.join(FORMELN, 'funktionen.js')).href);
const { bezugText } = await import(pathToFileURL(path.join(FORMELN, 'lexer.js')).href);

/** Knoten → Klammertext, damit der Vorrang sichtbar wird. */
function baum(k) {
  switch (k.art) {
    case 'zahl': return String(k.wert);
    case 'text': return JSON.stringify(k.wert);
    case 'bool': return k.wert ? 'TRUE' : 'FALSE';
    case 'fehler': return k.wert;
    case 'bezug': return bezugText(k, 'intern');
    case 'name': return k.text;
    case 'leer': return '_';
    case 'unaer': return `(${k.op}${baum(k.a)})`;
    case 'prozent': return `(${baum(k.a)}%)`;
    case 'binaer': return `(${baum(k.a)}${k.op}${baum(k.b)})`;
    case 'funktion': return `${k.name}(${k.argumente.map((a) => baum(a)).join(',')})`;
    default: throw new Error(`unbekannter Knoten ${k.art}`);
  }
}
const grund = (s, m) => { try { parsen(s, m); return null; } catch (e) { assert.ok(e instanceof FormelFehler); return e.grund; } };

test('Vorrang: Vergleich < & < +- < */ < ^ < unäres Minus < %', () => {
  assert.equal(baum(parsen('1+2*3')), '(1+(2*3))');
  assert.equal(baum(parsen('-2^2')), '((-2)^2)');
  assert.equal(baum(parsen('2^3^2')), '((2^3)^2)');
  assert.equal(baum(parsen('-50%')), '(-(50%))');
  assert.equal(baum(parsen('1&2+3')), '(1&(2+3))');
  assert.equal(baum(parsen('A1=1&2')), '(A1=(1&2))');
  assert.equal(baum(parsen('1<2=TRUE')), '((1<2)=TRUE)');
  assert.equal(baum(parsen('(1+2)*3')), '((1+2)*3)');
});
test('Funktionen, leere Argumente, unbekannte Namen', () => {
  assert.equal(baum(parsen('IF(A1,,1)')), 'IF(A1,_,1)');
  assert.equal(baum(parsen('FOO(1)')), 'FOO(1)');
  assert.equal(parsen('Umsatz').art, 'name');
  assert.equal(baum(parsen('SUMME(1;2)', 'anzeige')), 'SUMME(1,2)'); // Name bleibt wie geschrieben; Übersetzung macht uebersetzen.js
});
test('Fehler mit Grund', () => {
  assert.deepEqual(['1+', 'SUM(1', '1)', '@', 'IF(1)', 'ROUND(1)', 'TODAY(1)', ''].map((s) => grund(s)), ['syntax', 'klammer', 'klammer', 'unbekannt', 'argumente', 'argumente', 'argumente', 'syntax']);
});
test('FUNKTIONEN: 17 Einträge, deutsch ↔ englisch', () => {
  assert.equal(Object.keys(FUNKTIONEN).length, 17);
  assert.deepEqual(['summe', 'ZÄHLENWENN', 'zaehlenwenn', 'SVERWEIS', 'XVERWEIS'].map(funktionAusDeutsch), ['SUM', 'COUNTIF', 'COUNTIF', 'VLOOKUP', null]);
  assert.equal(funktionAufDeutsch('CONCATENATE'), 'VERKETTEN');
});
test('Stelligkeit auch deutsch, Position im Fehler, Leerraum und Kleinschreibung', () => {
  assert.deepEqual([grund('WENN(1)', 'anzeige'), grund('HEUTE()', 'anzeige'), grund('SUMME()', 'anzeige')], ['argumente', null, 'argumente']);
  assert.deepEqual(['SUM(', '(', '(1 2)', 'SUM(1,', '1+)', '1,2'].map((s) => grund(s)), ['klammer', 'klammer', 'syntax', 'klammer', 'syntax', 'syntax']);
  try { parsen('A1 + @'); assert.fail('wirft nicht'); } catch (e) { assert.equal(e.grund, 'unbekannt'); assert.equal(e.pos, 5); }
  try { parsen('SUM(1 2)'); assert.fail('wirft nicht'); } catch (e) { assert.equal(e.grund, 'syntax'); assert.equal(e.pos, 6); }
  assert.equal(baum(parsen(' sum( a1:b2 , -$C$3 ) ')), 'SUM(A1:B2,(-$C$3))');
  assert.equal(baum(parsen('"a"&"b"<>"ab"')), '(("a"&"b")<>"ab")');
});
test('Tiefe Verschachtelung: Grenze statt Stapelüberlauf, lange Ketten ohne Rekursion', () => {
  assert.equal(parsen('('.repeat(200) + '1' + ')'.repeat(200)).wert, 1);
  assert.equal(grund('('.repeat(5000) + '1' + ')'.repeat(5000)), 'syntax');
  assert.equal(grund('SUM('.repeat(5000) + '1' + ')'.repeat(5000)), 'syntax');
  let k = parsen('-'.repeat(20000) + '1'), tiefe = 0;
  while (k.art === 'unaer') { k = k.a; tiefe++; }
  assert.deepEqual([tiefe, k.wert], [20000, 1]);
  k = parsen('1' + '-2'.repeat(20000)); tiefe = 0;
  while (k.art === 'binaer') { assert.equal(k.b.wert, 2); k = k.a; tiefe++; }
  assert.deepEqual([tiefe, k.wert], [20000, 1]);
});
