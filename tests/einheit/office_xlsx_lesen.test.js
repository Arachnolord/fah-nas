// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 13): Import aus Excel (.xlsx) – Rundreise schreiben → lesen ergibt dasselbe Modell,
// eine handgebaute Datei mit allem, was nicht übernommen wird (Diagramm, Pivot, bedingte Formatierung, verbundene
// Zellen, Makros, Kommentar, Formeln nur als Wert, unbekannte Funktionen), gemeinsame Formeln, 1904-Datumssystem,
// Grenzen und kaputte Dateien (Review Focus 4). Mit FAHNAS_XLSX_PROBE=<pfad> legt die Rundreise zusätzlich eine
// Probe-Mappe für die Echtprobe in LibreOffice ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { M_RUND, HAND, zipBombe, xlsxVonHand, idsNachReihenfolge } from './tab_xlsx_proben.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const { xlsxLesen, xlsxSchreiben, FEHLTE_ARTEN_XLSX } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'tabelle', 'xlsx.js')).href);
const { zipSchreiben } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'format', 'zip.js')).href);
const { datenPruefen } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);

/** Probe-Mappe für LibreOffice: erwartet wird die CSV-Zeile 1,2,3,6,groß,2,2.68,a1.5. */
const PROBE = {
  blaetter: [
    {
      id: 'blatt1', name: 'Tabelle1', pos: 'i', spalten: {}, zeilen: {}, fixiert: { zeilen: 0 },
      zellen: {
        A1: { w: '1' }, B1: { w: '2' }, C1: { w: '3' }, D1: { w: '=SUM(A1:C1)' }, E1: { w: '=IF(D1>5,"groß","klein")' },
        F1: { w: '=COUNTIF(A1:C1,">1")' }, G1: { w: '=ROUND(2.675,2)' }, H1: { w: '=CONCATENATE("a",1.5)' },
      },
    },
    { id: 'blatt2', name: 'Mein Blatt', pos: 'r', spalten: {}, zeilen: {}, fixiert: { zeilen: 0 }, zellen: { A1: { w: '=[blatt1]!D1*2' } } },
  ],
};

test('Rundreise: schreiben → lesen → gleiches Modell', async () => {
  const r = await xlsxLesen(await (await xlsxSchreiben(M_RUND)).arrayBuffer());
  assert.deepEqual(r.fehlte, []); assert.deepEqual(r.dateien, []); assert.doesNotThrow(() => datenPruefen(r.daten));
  assert.deepEqual(idsNachReihenfolge(r.daten), idsNachReihenfolge(M_RUND));
  assert.deepEqual(r.daten.blaetter.map((b) => b.pos), ['i', 'r']);
  // Kennungen über die mitgegebene Funktion
  let n = 0;
  const k = await xlsxLesen(await (await xlsxSchreiben(PROBE)).arrayBuffer(), { id: () => `kenn0${++n}` });
  assert.deepEqual([k.daten.blaetter.map((b) => b.id), k.daten.blaetter[1].zellen.A1.w], [['kenn01', 'kenn02'], '=[kenn01]!D1*2']);
  if (process.env.FAHNAS_XLSX_PROBE) fs.writeFileSync(process.env.FAHNAS_XLSX_PROBE, new Uint8Array(await (await xlsxSchreiben(PROBE)).arrayBuffer()));
});

test('Handgebaute Datei mit nicht unterstützten Teilen', async () => {
  assert.deepEqual(FEHLTE_ARTEN_XLSX, ['diagramme', 'pivot', 'bedingt', 'verbunden', 'makros', 'bilder', 'kommentare', 'links', 'datenpruefung', 'formeln', 'funktionen', 'groesse']);
  const r = await xlsxLesen((await zipSchreiben(HAND)).buffer);
  assert.deepEqual(r.fehlte, [{ art: 'diagramme', anzahl: 1 }, { art: 'pivot', anzahl: 1 }, { art: 'bedingt', anzahl: 1 }, { art: 'verbunden', anzahl: 2 }, { art: 'makros', anzahl: 1 },
    { art: 'kommentare', anzahl: 1 }, { art: 'formeln', anzahl: 2 }, { art: 'funktionen', anzahl: 1, namen: ['XLOOKUP'] }]);
  const z = r.daten.blaetter[0].zellen;
  assert.deepEqual([z.B2.w, z.B3.w, z.B4.w], ['=A2*2', '=A3*2', '=A4*2']); // gemeinsame Formel ausgeklappt
  assert.deepEqual([z.C1.w, z.C2.w, z.C3.w, z.D1.w], ['Inline', '=#N/A', '7', '=_xlfn.XLOOKUP(1,A:A,B:B)']); // inlineStr, Fehlerkonstante, Strukturbezug nur als Wert, unbekannte Funktion bleibt (mit _xlfn.)
  assert.deepEqual([z.E1.f, z.E2.f, z.E3.f, z.E4.f, z.E5.f], [{ zahl: 'datum' }, { zahl: 'euro' }, { zahl: 'prozent' }, { zahl: 'text' }, undefined]); // 14, '#,##0.00 €', 9, 49, Theme-Farbe ignoriert
  assert.equal(z.E1.w, String(45000 + 1462)); // 1904-System
  assert.deepEqual([r.daten.blaetter[0].fixiert, r.daten.blaetter[0].spalten.B, r.daten.blaetter[0].zeilen['2']], [{ zeilen: 1 }, { breite: 140 }, { hoehe: 30 }]);
  // gemeinsame Zeichenketten (Läufe verbunden, Lautschrift übersprungen), Werte, Name, Blattbereich nur als Wert
  assert.deepEqual([z.A1.w, z.E4.w, z.A2.w, z.E2.w, z.E3.w, z.E5.w, z.D2.w], ['Kopf', 'Lauf fett', '1', '1234.5', '0.5', '9', '3']);
  assert.deepEqual([r.daten.blaetter[0].name, r.dateien], ['Sheet1', []]);
  assert.doesNotThrow(() => datenPruefen(r.daten));
});

test('Sonderfälle: unbekannte Fehlerwerte, Datum als ISO, Matrixformel, Text-Ergebnis, Name ohne Excel-Sonderregeln', async () => {
  const r = await xlsxLesen(await xlsxVonHand({
    A1: '<c r="A1" t="e"><v>#SPILL!</v></c>', A2: '<c r="A2" t="d"><v>2026-10-18T12:00:00</v></c>',
    A3: '<c r="A3"><f t="array" ref="A3">SUM(B1:B2*C1:C2)</f><v>11</v></c>', A4: '<c r="A4" t="str"><f>"x"&amp;1</f><v>x1</v></c>',
    A5: '<c r="A5" t="b"><v>0</v></c>', A6: '<c r="A6" t="s"><v>9</v></c>', B1: '<c t="n"><v>1.50</v></c>', C1: '=x',
  }, { name: 'History' }));
  const z = r.daten.blaetter[0].zellen;
  assert.deepEqual([z.A1.w, z.A2.w, z.A2.f, z.A3.w, z.A4.w, z.A5.w, z.A6, z.B1.w, z.C1.w], ['=#VALUE!', '46313.5', { zahl: 'datum' }, '11', '="x"&1', 'FALSE', undefined, '1.5', "'=x"]);
  assert.deepEqual([r.daten.blaetter[0].name, r.fehlte], ['History', [{ art: 'formeln', anzahl: 1 }]]);
});

test('Grenzen: Zelle in XFD1 wird verworfen und gemeldet', async () => {
  assert.deepEqual((await xlsxLesen(await xlsxVonHand({ XFD1: 'x', A1: 'y' }))).fehlte, [{ art: 'groesse', anzahl: 1 }]);
});

test('kaputt → xlsx_kaputt, kein ZIP → zip_kaputt, Bombe → zip_zu_gross', async () => {
  await assert.rejects(xlsxLesen((await zipSchreiben([{ name: 'a.txt', daten: 'x' }])).buffer), /xlsx_kaputt/);
  await assert.rejects(xlsxLesen(new Uint8Array(10).buffer), /zip_kaputt/);
  await assert.rejects(xlsxLesen(zipBombe()), /zip_zu_gross/);
  // Arbeitsmappe ohne lesbares XML bzw. Blatt mit kaputtem XML
  await assert.rejects(xlsxLesen((await zipSchreiben([{ name: 'xl/workbook.xml', daten: '<workbook' }])).buffer), /xlsx_kaputt/);
  await assert.rejects(xlsxLesen(await xlsxVonHand({ A1: '<c r="A1"><v>1</c>' })), /xlsx_kaputt/);
});
