// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Import-Modul der Office-Tabelle (Plan 06 Aufgabe 14, V18): .xlsx und .csv/.tsv/.txt → Daten, übersetzte Hinweise,
// was fehlte, übersetzte Fehler (kaputt, zu groß); CSV aus dem deutschen Excel in Windows-1252 (Review Focus 5) mit
// dem Blattnamen aus dem Dateinamen; verknuepfen gibt die Daten unverändert zurück (Tabellen haben keine Dateien).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { M_RUND, HAND, zipBombe } from './tab_xlsx_proben.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let importieren; let verknuepfen; let xlsxSchreiben; let zipSchreiben; let tabelle;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k, w) => (w ? [k, ...Object.values(w)].join(':') : k));
  ({ importieren, verknuepfen } = await imp('office', 'tabelle', 'import.js'));
  ({ xlsxSchreiben } = await imp('office', 'tabelle', 'xlsx.js'));
  ({ zipSchreiben } = await imp('office', 'format', 'zip.js'));
  ({ tabelle } = await imp('gemeinsam', 'sync', 'typen', 'tabelle.js'));
});
after(() => dom.aufraeumen());

test('xlsx: Rundreise ohne fehlte; Meldungen übersetzt', async () => {
  const r = await importieren(await xlsxSchreiben(M_RUND), 'Q3.xlsx'); assert.deepEqual([r.fehlte, r.dateien], [[], []]);
  assert.deepEqual(r.daten.blaetter.map((b) => b.name), ['Umsatz 2026', 'Mein Blatt']);
  const h = await importieren(new Blob([await zipSchreiben(HAND)]), 'alt.xlsx');
  assert.deepEqual(h.fehlte, ['office.tab_fehlte_diagramme:1', 'office.tab_fehlte_pivot:1', 'office.tab_fehlte_bedingt:1', 'office.tab_fehlte_verbunden:2', 'office.tab_fehlte_makros:1',
    'office.tab_fehlte_kommentare:1', 'office.tab_fehlte_formeln:2', 'office.tab_fehlte_funktionen:1:XLOOKUP']);
  // Endung ohne Groß/Klein
  assert.deepEqual((await importieren(await xlsxSchreiben(M_RUND), 'Q3.XLSX')).fehlte, []);
});

test('csv: Windows-1252 aus deutschem Excel (Review Focus 5), Blattname aus dem Dateinamen', async () => {
  const bytes = new Uint8Array([...'Name;Betrag;Notiz\r\nM'].map((c) => c.charCodeAt(0)).concat([0xfc], [...'ller;1.234,50;"a\r\n""b"""\r\n'].map((c) => c.charCodeAt(0))));
  const r = await importieren(new Blob([bytes]), 'Kunden.csv');
  assert.deepEqual([r.daten.blaetter[0].name, r.daten.blaetter[0].zellen.A2.w, r.daten.blaetter[0].zellen.B2.w, r.daten.blaetter[0].zellen.C2.w], ['Kunden', 'Müller', '1234.5', 'a\r\n"b"']);
  assert.deepEqual([r.fehlte, r.dateien], [[], []]);
  // .tsv und .txt, Tabulator erkannt; zu breite Zeile → übersetzte Größen-Meldung
  const tsv = await importieren(new Blob(['a\tb\n1\t2\n']), 'liste.export.TSV');
  assert.deepEqual([tsv.daten.blaetter[0].name, tsv.daten.blaetter[0].zellen.B2.w], ['liste.export', '2']);
  const txt = await importieren(new Blob([Array(1030).fill('x').join(';')]), 'breit.txt');
  assert.deepEqual(txt.fehlte, ['office.tab_fehlte_groesse:6']);
});

test('Fehler werden übersetzte Sätze', async () => {
  await assert.rejects(importieren(new Blob(['kein zip']), 'x.xlsx'), (e) => e.message === 'office.tab_import_kaputt');
  await assert.rejects(importieren(new Blob([zipBombe()]), 'x.xlsx'), (e) => e.message === 'office.tab_import_zu_gross');
  await assert.rejects(importieren(new Blob(['x']), 'x.ods'), (e) => e.message === 'office.tab_import_kaputt');
  await assert.rejects(importieren(new Blob(['x']), 'ohne_endung'), (e) => e.message === 'office.tab_import_kaputt');
  // Ergebnis über GRENZEN.json_import (15 MiB JSON) → zu groß
  const gross = `${'x'.repeat(30000)};`.repeat(40) + '\n';
  await assert.rejects(importieren(new Blob([gross.repeat(14)]), 'gross.csv'), (e) => e.message === 'office.tab_import_zu_gross');
});

test('verknuepfen gibt die Daten unverändert zurück', () => { const d = tabelle.leer(); assert.equal(verknuepfen(d, new Map()), d); });
