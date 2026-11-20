// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 11): CSV lesen und schreiben – Zeichensatz erkennen (UTF-8 mit/ohne BOM, UTF-16LE,
// Windows-1252 aus dem deutschen Excel), Trennzeichen erkennen, Felder nach RFC 4180, Schreiben mit Semikolon, CRLF
// und BOM, ein Blatt mit Anzeigeformaten und Formelwerten als CSV (Text wie =… wird geschützt), CSV → Daten ohne
// Formeln und die Grenzen der Mappe (Review Focus 5). Ohne DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mappe } from './tab_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const TABELLE = path.join(HIER, '..', '..', 'public', 'office', 'tabelle');
const { csvDekodieren, csvLesen, csvSchreiben, csvSchutz, blattZuCsv, csvZuDaten } = await import(pathToFileURL(path.join(TABELLE, 'csv.js')).href);
const { Rechner } = await import(pathToFileURL(path.join(TABELLE, 'formeln', 'auswerter.js')).href);
const { datenPruefen } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);

test('Dekodieren: UTF-8 mit/ohne BOM, UTF-16LE, Windows-1252', () => {
  assert.equal(csvDekodieren(new Uint8Array([0xef, 0xbb, 0xbf, 0x4d, 0xc3, 0xbc])), 'Mü');
  assert.equal(csvDekodieren(new Uint8Array([0xff, 0xfe, 0x4d, 0x00, 0xfc, 0x00])), 'Mü');
  assert.equal(csvDekodieren(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0x80])), 'Müller €');
  assert.equal(csvDekodieren(new Uint8Array([0x4d, 0xc3, 0xbc])), 'Mü'); // UTF-8 ohne BOM
  assert.equal(csvDekodieren(new Uint8Array([0x84, 0x93, 0x9f, 0xe4, 0x81])), '„“Ÿä\u0081'); // 0x81 ist in Windows-1252 frei
});

test('Trennzeichen erkennen', () => {
  assert.deepEqual(['a;b;c\n1;2;3', 'a,b\n1,2', 'a\tb\n1\t2', 'a;b,c\n1;2,5', 'nur'].map((t) => csvLesen(t).trenner), [';', ',', '\t', ';', ';']);
  assert.equal(csvLesen('"a;b",c\n"x;y",z').trenner, ','); // Trenner in Anführungszeichen zählen nicht
  assert.equal(csvLesen('a,b,c\n1,2\n').trenner, ';'); // ungleiche Anzahl → kein Kandidat
  assert.equal(csvLesen('a,b\n\n1,2\n').trenner, ','); // leere Zeile zählt nicht als Probezeile
});

test('Anführungszeichen, Zeilenumbruch im Feld, verdoppelte Quotes, CRLF, BOM, leere Felder', () => {
  assert.deepEqual(csvLesen('﻿Name;Notiz\r\n"Müller; Hans";"Zeile 1\nZeile ""2"""\r\n').zeilen, [['Name', 'Notiz'], ['Müller; Hans', 'Zeile 1\nZeile "2"']]);
  assert.deepEqual(csvLesen('a;;c\n;\n').zeilen, [['a', '', 'c'], ['', '']]);
  assert.deepEqual(csvLesen('"offen;x').zeilen, [['offen;x']]);
  assert.deepEqual(csvLesen('a\rb').zeilen, [['a'], ['b']]);
  assert.deepEqual(csvLesen('').zeilen, []);
  assert.deepEqual(csvLesen('"ab"cd;e"f\n').zeilen, [['abcd', 'e"f']]); // nach dem schließenden " und mitten im Feld wörtlich
});

test('Schreiben: Semikolon, CRLF, BOM, Quotes nur wo nötig', () => {
  assert.equal(csvSchreiben([['a', 'b;c', 'd"e'], ['x\ny', ' rand', '']]), '﻿a;"b;c";"d""e"\r\n"x\ny";" rand";\r\n');
  assert.equal(csvSchreiben([['a\r', 'rand\t', 'mitte n']]), '﻿"a\r";"rand\t";mitte n\r\n');
  assert.equal(csvSchreiben([]), '﻿');
});

test('Schutz: = + - @, Tab und CR am Anfang', () => {
  assert.deepEqual(['=1', '+x', '-y', '@z', '\tT', '\rR', 'ok', '', "'=x"].map(csvSchutz), ["'=1", "'+x", "'-y", "'@z", "'\tT", "'\rR", 'ok', '', "'=x"]);
});

test('Blatt als CSV: Anzeigeformat, Formelwerte, Schutz nur für Text', () => {
  const d = mappe({ blatt1: { A1: 'Name', B1: 'Betrag', A2: 'Müller; Hans', B2: ['1234.5', { zahl: 'euro' }], A3: "'=SUMME(1)", B3: '-5', A4: '+x', B4: '=A2&"!"' } });
  const r = new Rechner(); r.setzen(d);
  assert.equal(blattZuCsv(d, 'blatt1', r), '﻿Name;Betrag\r\n"Müller; Hans";1.234,50 €\r\n\'=SUMME(1);-5\r\n\'+x;"Müller; Hans!"\r\n');
  // Lücken werden leere Felder, der Bereich endet an der letzten belegten Zeile/Spalte; Zellen nur mit Format zählen nicht
  const l = mappe({ blatt1: { B2: '=1/0', C3: ['', { fett: true }], A3: 'WAHR', D1: ['46313', { zahl: 'datum' }] } });
  const rl = new Rechner(); rl.setzen(l);
  assert.equal(blattZuCsv(l, 'blatt1', rl), '﻿;;;18.10.2026\r\n;#DIV/0!;;\r\nWAHR;;;\r\n');
  assert.equal(blattZuCsv(mappe({ blatt1: {} }), 'blatt1', rl), '﻿');
});

test('CSV → Daten: deutsche Zahlen und Daten, nie Formeln, englisches Komma-CSV, Rundreise', () => {
  const { daten, fehlte } = csvZuDaten('Name;Betrag;Datum;Notiz\r\nMüller;1.234,50 €;18.10.2026;\'=x\r\n', { name: 'Liste' });
  assert.deepEqual(fehlte, []); assert.equal(daten.blaetter[0].name, 'Liste');
  assert.deepEqual(daten.blaetter[0].zellen, { A1: { w: 'Name' }, B1: { w: 'Betrag' }, C1: { w: 'Datum' }, D1: { w: 'Notiz' }, A2: { w: 'Müller' }, B2: { w: '1234.5', f: { zahl: 'euro' } }, C2: { w: '46313', f: { zahl: 'datum' } }, D2: { w: "'=x" } });
  assert.equal(csvZuDaten('a,b\n1.5,=A1\n', { name: 'x' }).daten.blaetter[0].zellen.A2.w, '1.5');
  assert.equal(csvZuDaten('a,b\n1.5,=A1\n', { name: 'x' }).daten.blaetter[0].zellen.B2.w, "'=A1");
  assert.deepEqual(daten.blaetter[0], { id: 'blatt1', name: 'Liste', pos: 'i', zellen: daten.blaetter[0].zellen, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } });
  assert.doesNotThrow(() => datenPruefen(daten));
  // Rundreise: Blatt → CSV → Daten ergibt dieselben Zellen
  const r = new Rechner(); r.setzen(daten);
  assert.deepEqual(csvZuDaten(blattZuCsv(daten, 'blatt1', r), { name: 'Liste' }).daten, daten);
});

test('Blattname aus dem Namen: gekürzt, verbotene Zeichen, leer', () => {
  const name = (n) => csvZuDaten('x', { name: n }).daten.blaetter[0].name;
  assert.deepEqual([name('a/b:c*?[d]\\e'), name('x'.repeat(40)), name(''), name('   '), name("'zitat'"), name(undefined)],
    ['a_b_c___d__e', 'x'.repeat(31), 'Tabelle1', 'Tabelle1', '_zitat_', 'Tabelle1']);
});

test('Grenzen: Spalten über 1024 werden abgeschnitten und gemeldet', () => {
  assert.deepEqual(csvZuDaten(Array(1030).fill('x').join(';'), { name: 'g' }).fehlte, [{ art: 'groesse', anzahl: 6 }]);
  // leere Felder jenseits der Grenze zählen nicht
  assert.deepEqual(csvZuDaten(`a${';'.repeat(1100)}`, { name: 'g' }).fehlte, []);
});
