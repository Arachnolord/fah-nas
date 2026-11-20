// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 16): Aktionen des Editors als Ops – Eingabe (Zahlformat nur ohne eigenes Format,
// HEUTE/JETZT → Datum), Leeren (Formate bleiben), Format umschalten, Ausfüllen nach unten, Kopieren und Einfügen (TSV
// aus Excel, intern mit relativ wandernden Formeln und Formaten, eine Zelle füllt die Auswahl), Sortieren (Zahlen vor
// Text, leer zuletzt, stabil), Struktur-Ops aus der Auswahl, neues Blatt, Filter als Ansicht. Ohne DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mappe } from './tab_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const TABELLE = path.join(WURZEL, 'public', 'office', 'tabelle');
const imp = (datei) => import(pathToFileURL(path.join(TABELLE, datei)).href);
const {
  eingabeOp, leerenOp, formatOp, kopieren, einfuegenOp, ausfuellenOp, sortierenOp, sortierBereich, strukturOp, neuesBlattOp,
} = await imp('aktionen.js');
const { KOPIER_TYP, tsvLesen, tsvSchreiben } = await imp('zwischenablage.js');
const { filterWerte, versteckteZeilen } = await imp('filter.js');
const { Rechner } = await imp(path.join('formeln', 'auswerter.js'));
const { FormelFehler } = await imp(path.join('formeln', 'parser.js'));
const { tabelle, LEER_F } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);

const d = mappe({ blatt1: { A1: 'Name', B1: 'Betrag' }, blatt2: { A1: '5' } });
const r = new Rechner(); r.setzen(d);
const BL = d.blaetter;
const dMitEuroInC1 = mappe({ blatt1: { C1: ['', { zahl: 'euro' }] } });

test('Eingabe: Zahlformat nur ohne eigenes Format, HEUTE wird Datum', () => {
  assert.deepEqual(eingabeOp(d, 'blatt1', 1, 3, '12,5 %'), { typ: 'zelle', blatt: 'blatt1', zelle: 'C1', w: '0.125', f: { zahl: 'prozent' } });
  assert.deepEqual(eingabeOp(dMitEuroInC1, 'blatt1', 1, 3, '12,5 %'), { typ: 'zelle', blatt: 'blatt1', zelle: 'C1', w: '0.125' });
  assert.deepEqual(eingabeOp(d, 'blatt1', 1, 4, '=heute()'), { typ: 'zelle', blatt: 'blatt1', zelle: 'D1', w: '=TODAY()', f: { zahl: 'datum' } });
  // JETZT ebenso, aber nur als ganze Formel; Blattnamen werden Kennungen; leer leert den Wert; Fehler in der Formel wirft
  assert.deepEqual(eingabeOp(d, 'blatt1', 2, 1, '=JETZT()'), { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '=NOW()', f: { zahl: 'datum' } });
  assert.deepEqual(eingabeOp(d, 'blatt1', 2, 1, '=HEUTE()+1'), { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '=TODAY()+1' });
  assert.deepEqual(eingabeOp(d, 'blatt1', 2, 1, '=Tabelle2!A1*2'), { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '=[blatt2]!A1*2' });
  assert.deepEqual(eingabeOp(d, 'blatt1', 1, 1, ''), { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: null });
  assert.throws(() => eingabeOp(d, 'blatt1', 2, 1, '=SUMME(A1;'), FormelFehler);
});

test('Leeren behält Formate; Format umschalten', () => {
  assert.deepEqual(leerenOp(mappe({ blatt1: { A1: ['1', { fett: true }], A2: ['', { kursiv: true }] } }), 'blatt1', { z1: 1, s1: 1, z2: 3, s2: 1 }), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: null } } });
  const f = mappe({ blatt1: { A1: ['1', { fett: true }], A2: '2' } });
  assert.deepEqual(formatOp(f, 'blatt1', { z1: 1, s1: 1, z2: 2, s2: 1 }, 'fett', 'umschalten').werte, { A1: { f: { fett: true } }, A2: { f: { fett: true } } });
  assert.deepEqual(formatOp(mappe({ blatt1: { A1: ['1', { fett: true }] } }), 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 1 }, 'fett', 'umschalten').werte, { A1: { f: { fett: null } } });
  // nichts zu leeren → null; andere Felder setzen den Wert, null entfernt; zu groß → zu_viel
  assert.equal(leerenOp(f, 'blatt1', { z1: 5, s1: 5, z2: 6, s2: 6 }), null);
  assert.deepEqual(formatOp(f, 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 2 }, 'farbe', '#b42318'), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { f: { farbe: '#b42318' } }, B1: { f: { farbe: '#b42318' } } } });
  assert.deepEqual(formatOp(f, 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 1 }, 'zahl', null).werte, { A1: { f: { zahl: null } } });
  assert.throws(() => formatOp(f, 'blatt1', { z1: 1, s1: 1, z2: 50001, s2: 1 }, 'fett', true), /zu_viel/);
  assert.equal(formatOp(f, 'blatt1', { z1: 1, s1: 1, z2: 50000, s2: 1 }, 'fett', true).typ, 'zellen');
});

test('Ausfüllen nach unten mit relativen Bezügen und Format', () => {
  const a = mappe({ blatt1: { A1: '1', B1: ['=A1*2', { zahl: 'euro' }] } });
  assert.deepEqual(ausfuellenOp(a, 'blatt1', { z1: 1, s1: 2, z2: 3, s2: 2 }), { typ: 'zellen', blatt: 'blatt1', werte: { B2: { w: '=A2*2', f: { ...LEER_F, zahl: 'euro' } }, B3: { w: '=A3*2', f: { ...LEER_F, zahl: 'euro' } } } });
  assert.deepEqual(ausfuellenOp(a, 'blatt1', { z1: 2, s1: 2, z2: 2, s2: 2 }).werte, { B2: { w: '=A2*2', f: { ...LEER_F, zahl: 'euro' } } }); // eine Zeile → von oben
  // erste Zeile ohne Zeile darüber → null; Werte werden kopiert, leere Quelle leert; $-Bezüge bleiben
  assert.equal(ausfuellenOp(a, 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 2 }), null);
  assert.deepEqual(ausfuellenOp(mappe({ blatt1: { A1: '7', C1: '=$A$1+A1' } }), 'blatt1', { z1: 1, s1: 1, z2: 2, s2: 3 }).werte,
    { A2: { w: '7', f: LEER_F }, B2: { w: null, f: LEER_F }, C2: { w: '=$A$1+A2', f: LEER_F } });
});

test('TSV aus Excel lesen und einfügen; eine Zelle füllt die Auswahl', () => {
  assert.equal(KOPIER_TYP, 'application/x-fah-tabelle');
  assert.deepEqual(tsvLesen('"a\nb"\tc\r\nd\t"e""f"\r\n'), [['a\nb', 'c'], ['d', 'e"f']]);
  assert.equal(tsvSchreiben([['a\tb', 'c'], ['d', '']]), '"a\tb"\tc\r\nd\t\r\n');
  assert.deepEqual(einfuegenOp(d, 'blatt1', { z: 1, s: 1 }, { art: 'tsv', text: 'Name\tBetrag\r\nMüller\t1.234,50\r\n' }, { blaetter: BL, auswahl: { z1: 1, s1: 1, z2: 1, s2: 1 } }).werte,
    { A1: { w: 'Name' }, B1: { w: 'Betrag' }, A2: { w: 'Müller' }, B2: { w: '1234.5' } });
  assert.deepEqual(Object.keys(einfuegenOp(d, 'blatt1', { z: 2, s: 2 }, { art: 'tsv', text: 'x' }, { blaetter: BL, auswahl: { z1: 2, s1: 2, z2: 3, s2: 3 } }).werte), ['B2', 'C2', 'B3', 'C3']);
  // Formeln wie getippt, erkanntes Format, leere Felder leeren, Zeilen ungleich lang, nichts → null, zu groß → zu_viel
  assert.deepEqual(einfuegenOp(d, 'blatt1', { z: 4, s: 1 }, { art: 'tsv', text: '=SUMME(A1;1)\t5 %\r\n\r\nx\r\n' }, { blaetter: BL, auswahl: { z1: 4, s1: 1, z2: 4, s2: 1 } }).werte,
    { A4: { w: '=SUM(A1,1)' }, B4: { w: '0.05', f: { zahl: 'prozent' } }, A5: { w: null }, B5: { w: null }, A6: { w: 'x' }, B6: { w: null } });
  assert.equal(einfuegenOp(d, 'blatt1', { z: 1, s: 1 }, { art: 'tsv', text: '' }, { blaetter: BL, auswahl: { z1: 1, s1: 1, z2: 1, s2: 1 } }), null);
  assert.throws(() => einfuegenOp(d, 'blatt1', { z: 1, s: 1 }, { art: 'tsv', text: 'x' }, { blaetter: BL, auswahl: { z1: 1, s1: 1, z2: 50001, s2: 1 } }), /zu_viel/);
  // jenseits von 100 000 Zeilen fällt weg
  assert.deepEqual(Object.keys(einfuegenOp(d, 'blatt1', { z: 100000, s: 1 }, { art: 'tsv', text: 'a\r\nb\r\n' }, { blaetter: BL, auswahl: { z1: 100000, s1: 1, z2: 100000, s2: 1 } }).werte), ['A100000']);
});

test('Intern kopieren und einfügen: Formeln wandern relativ, Formate kommen mit', () => {
  const quelle = mappe({ blatt1: { A1: '2', B1: ['=A1*2', { fett: true }] } });
  const r2 = new Rechner(); r2.setzen(quelle);
  const k = kopieren(quelle, r2, 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 2 });
  assert.equal(k.tsv, '2\t4\r\n');
  assert.deepEqual(einfuegenOp(d, 'blatt1', { z: 5, s: 3 }, { art: 'intern', json: k.intern }, { blaetter: BL, auswahl: { z1: 5, s1: 3, z2: 5, s2: 3 } }).werte,
    { C5: { w: '2', f: LEER_F }, D5: { w: '=C5*2', f: { ...LEER_F, fett: true } } });
  // eine Formelzelle in eine größere Auswahl: jede Zelle bekommt ihre eigene Verschiebung; Lücken leeren Wert und Format
  const k1 = kopieren(quelle, r2, 'blatt1', { z1: 1, s1: 2, z2: 1, s2: 2 });
  assert.deepEqual(einfuegenOp(d, 'blatt1', { z: 2, s: 2 }, { art: 'intern', json: k1.intern }, { blaetter: BL, auswahl: { z1: 2, s1: 2, z2: 3, s2: 2 } }).werte,
    { B2: { w: '=A2*2', f: { ...LEER_F, fett: true } }, B3: { w: '=A3*2', f: { ...LEER_F, fett: true } } });
  const q2 = mappe({ blatt1: { A1: 'x;"y"', C1: ['', { kursiv: true }] } }); const rq2 = new Rechner(); rq2.setzen(q2);
  const k2 = kopieren(q2, rq2, 'blatt1', { z1: 1, s1: 1, z2: 1, s2: 3 });
  assert.deepEqual(JSON.parse(k2.intern), { quelle: { z: 1, s: 1 }, zellen: [[{ w: 'x;"y"', f: null }, null, { w: null, f: { kursiv: true } }]] });
  assert.equal(k2.tsv, '"x;""y"""\t\t\r\n');
  assert.deepEqual(einfuegenOp(d, 'blatt1', { z: 1, s: 1 }, { art: 'intern', json: k2.intern }, { blaetter: BL, auswahl: { z1: 1, s1: 1, z2: 1, s2: 1 } }).werte,
    { A1: { w: 'x;"y"', f: LEER_F }, B1: { w: null, f: LEER_F }, C1: { w: null, f: { ...LEER_F, kursiv: true } } });
});

test('Sortieren: Zahlen vor Text, leer zuletzt, stabil, Formeln wandern mit ihrer Zeile', () => {
  const s = mappe({ blatt1: { A1: 'Name', A2: 'b', A3: '10', A4: 'a', A5: '2', B2: '=A2&"!"', B3: '=A3&"!"', B4: '=A4&"!"', B5: '=A5&"!"', B6: 'x' } }); const rs = new Rechner(); rs.setzen(s);
  const op = sortierenOp(s, rs, 'blatt1', { z1: 2, s1: 1, z2: 6, s2: 2 }, 1, false);
  assert.deepEqual(['A2', 'A3', 'A4', 'A5', 'A6', 'B2', 'B6'].map((a) => op.zellen[a].w), ['2', '10', 'a', 'b', null, '=A2&"!"', 'x']);
  assert.deepEqual(['A2', 'A3', 'A4', 'A5'].map((a) => sortierenOp(s, rs, 'blatt1', { z1: 2, s1: 1, z2: 6, s2: 2 }, 1, true).zellen[a].w), ['b', 'a', '10', '2']);
  assert.deepEqual([op.typ, op.bereich, op.spalte, op.absteigend], ['sortieren', 'A2:B6', 1, false]);
  // jede Adresse im Schnappschuss, leere mit LEER_F; die Op besteht die Prüfung des Typs; zu groß → zu_viel
  assert.deepEqual(Object.keys(op.zellen).sort(), ['A2', 'A3', 'A4', 'A5', 'A6', 'B2', 'B3', 'B4', 'B5', 'B6']);
  assert.deepEqual(op.zellen.A6, { w: null, f: LEER_F });
  assert.doesNotThrow(() => tabelle.pruefen(op));
  assert.throws(() => sortierenOp(s, rs, 'blatt1', { z1: 1, s1: 1, z2: 25001, s2: 2 }, 1, false), /zu_viel/);
  // stabil: gleiche Schlüssel behalten ihre Reihenfolge, auch absteigend; Groß/Klein gilt als gleich
  const g = mappe({ blatt1: { A1: 'x', B1: '1', A2: 'X', B2: '2', A3: 'a', B3: '3' } }); const rg = new Rechner(); rg.setzen(g);
  assert.deepEqual(['B1', 'B2', 'B3'].map((a) => sortierenOp(g, rg, 'blatt1', { z1: 1, s1: 1, z2: 3, s2: 2 }, 1, true).zellen[a].w), ['1', '2', '3']);
});

test('Sortierbereich: Auswahl über mehrere Zeilen, sonst alle belegten Zeilen (ohne fixierte Kopfzeile)', () => {
  const s = mappe({ blatt1: { B1: 'Kopf', B2: '3', D4: '1', C3: ['', { fett: true }] } });
  const aw = (z1, s1, z2, s2) => ({ blatt: 'blatt1', anker: { z: z1, s: s1 }, kopf: { z: z2, s: s2 } });
  assert.deepEqual(sortierBereich(s, 'blatt1', aw(3, 2, 2, 1)), { z1: 2, s1: 1, z2: 3, s2: 2 });
  assert.deepEqual(sortierBereich(s, 'blatt1', aw(2, 2, 2, 2)), { z1: 1, s1: 2, z2: 4, s2: 4 });
  s.blaetter[0].fixiert = { zeilen: 1 };
  assert.deepEqual(sortierBereich(s, 'blatt1', aw(2, 2, 2, 2)), { z1: 2, s1: 2, z2: 4, s2: 4 });
  assert.equal(sortierBereich(mappe({ blatt1: {} }), 'blatt1', aw(1, 1, 1, 1)), null);
});

test('Struktur, neues Blatt, Filter als Ansicht', () => {
  assert.deepEqual(strukturOp('zeilen_einfuegen', 'blatt1', { z1: 3, s1: 1, z2: 5, s2: 2 }), { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 3, anzahl: 3 });
  assert.deepEqual(neuesBlattOp(tabelle.leer(), 'Tabelle').blatt.name, 'Tabelle2'); assert.equal(neuesBlattOp(tabelle.leer(), 'Tabelle').blatt.pos, 'r');
  const fd = mappe({ blatt1: { A1: 'Stadt', A2: 'Bern', A3: 'Ulm', A4: 'Bern' } }); const rf = new Rechner(); rf.setzen(fd);
  assert.deepEqual(filterWerte(fd, rf, 'blatt1', 1), [{ text: 'Bern', anzahl: 2 }, { text: 'Ulm', anzahl: 1 }]);
  assert.deepEqual([...versteckteZeilen(fd, rf, 'blatt1', { spalte: 1, erlaubt: new Set(['Ulm']) })], [2, 4]);
  // Spalten-Ops, kleinster freier Name (ohne Groß/Klein), gültige Op; leer zuletzt, Anzeigeformat, kein Filter
  assert.deepEqual(strukturOp('spalten_loeschen', 'blatt1', { z1: 3, s1: 2, z2: 5, s2: 4 }), { typ: 'spalten_loeschen', blatt: 'blatt1', ab: 2, anzahl: 3 });
  const zwei = tabelle.anwenden(tabelle.leer(), { typ: 'blatt_neu', blatt: { id: 'blattX1', name: 'tabelle2', pos: 'r' } });
  const neu = neuesBlattOp(zwei, 'Tabelle');
  assert.deepEqual([neu.typ, neu.blatt.name, neu.blatt.pos], ['blatt_neu', 'Tabelle3', 'v']);
  assert.doesNotThrow(() => tabelle.pruefen(neu));
  const fl = mappe({ blatt1: { A1: 'Preis', A2: ['2', { zahl: 'euro' }], B3: 'x', A4: ['2', { zahl: 'euro' }], A5: 'Apfel' } }); const rl = new Rechner(); rl.setzen(fl);
  assert.deepEqual(filterWerte(fl, rl, 'blatt1', 1), [{ text: '2,00 €', anzahl: 2 }, { text: 'Apfel', anzahl: 1 }, { text: '', anzahl: 1 }]);
  assert.deepEqual([...versteckteZeilen(fl, rl, 'blatt1', { spalte: 1, erlaubt: new Set(['']) })], [2, 4, 5]);
  assert.equal(versteckteZeilen(fl, rl, 'blatt1', null).size, 0);
});
