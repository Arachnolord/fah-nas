// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 12): Export nach Excel (.xlsx) – Teile, Content-Types und Beziehungen, gültige und
// eindeutige Blattnamen, Neuberechnung beim Öffnen, Zelltypen mit zwischengespeicherten Formelwerten (Fehler, Zirkel),
// Stile in Schema-Reihenfolge, Blattansicht mit fixierter Zeile, Spaltenbreiten und Zeilenhöhen (Review Focus 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { M, ZEIT, text, sst, zellenVon } from './tab_xlsx_proben.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const { xlsxSchreiben, blattNamenFuerExcel, MIME_XLSX } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'tabelle', 'xlsx.js')).href);
const { zipLesen } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'format', 'zip.js')).href);
const { xmlLesen, kind, kinder } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'format', 'xml.js')).href);

const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const blob = await xlsxSchreiben(M, { titel: 'Budget', zeit: ZEIT });
const z = await zipLesen(await blob.arrayBuffer());

test('Teile, Content-Types, Beziehungen', async () => {
  assert.equal(MIME_XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(blob.type, MIME_XLSX);
  assert.deepEqual([...z.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']);
  const ct = xmlLesen(text(z, '[Content_Types].xml'));
  assert.deepEqual(kinder(ct, 'Default').map((d) => [d.attribute.Extension, d.attribute.ContentType]),
    [['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']]);
  assert.deepEqual(Object.fromEntries(kinder(ct, 'Override').map((o) => [o.attribute.PartName, o.attribute.ContentType])), {
    '/xl/workbook.xml': `${SML}.sheet.main+xml`, '/xl/worksheets/sheet1.xml': `${SML}.worksheet+xml`, '/xl/worksheets/sheet2.xml': `${SML}.worksheet+xml`,
    '/xl/worksheets/sheet3.xml': `${SML}.worksheet+xml`, '/xl/styles.xml': `${SML}.styles+xml`, '/xl/sharedStrings.xml': `${SML}.sharedStrings+xml`,
    '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml', '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  });
  const rel = (teil) => kinder(xmlLesen(text(z, teil)), 'Relationship').map((r) => [r.attribute.Id, r.attribute.Type.split('/').pop(), r.attribute.Target]);
  assert.deepEqual(rel('_rels/.rels'), [['rId1', 'officeDocument', 'xl/workbook.xml'], ['rId2', 'core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]);
  assert.deepEqual(rel('xl/_rels/workbook.xml.rels'), [['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'worksheet', 'worksheets/sheet3.xml'],
    ['rId4', 'styles', 'styles.xml'], ['rId5', 'sharedStrings', 'sharedStrings.xml']]);
  const core = xmlLesen(text(z, 'docProps/core.xml'));
  assert.deepEqual([kind(core, 'dc:title').text, kind(core, 'dcterms:created').text], ['Budget', '2026-10-18T12:00:00Z']);
  assert.equal(kind(xmlLesen(text(z, 'docProps/app.xml')), 'Application').text, 'FAH-NAS Office');
});

test('Arbeitsmappe: gültige, eindeutige Namen und Neuberechnung beim Öffnen', async () => {
  const wb = xmlLesen(text(z, 'xl/workbook.xml'));
  assert.deepEqual(wb.kinder.map((k) => k.name), ['bookViews', 'sheets', 'calcPr']);
  assert.deepEqual(kinder(kind(wb, 'sheets'), 'sheet').map((s) => s.attribute.name), ['Umsatz 2026', 'A_B_C___x_', 'umsatz 2026 (2)']);
  assert.deepEqual(kinder(kind(wb, 'sheets'), 'sheet').map((s) => [s.attribute.sheetId, s.attribute['r:id']]), [['1', 'rId1'], ['2', 'rId2'], ['3', 'rId3']]);
  assert.deepEqual(kind(wb, 'calcPr').attribute, { calcId: '191029', fullCalcOnLoad: '1' });
  assert.equal(kind(kind(wb, 'bookViews'), 'workbookView').attribute.activeTab, '0');
});

test('Blattnamen für Excel: History, leer, lang, doppelt, Hochkomma am Rand', () => {
  const lang = 'x'.repeat(40);
  const namen = blattNamenFuerExcel([{ id: 'a', name: 'history' }, { id: 'b', name: '' }, { id: 'c', name: lang }, { id: 'd', name: lang }, { id: 'e', name: 'Tabelle' }, { id: 'f', name: "'q'" }]);
  assert.deepEqual([...namen.entries()], [['a', 'history_'], ['b', 'Tabelle'], ['c', 'x'.repeat(31)], ['d', `${'x'.repeat(27)} (2)`], ['e', 'Tabelle (2)'], ['f', '_q_']]);
});

test('Zellen: Typen, Formeln mit zwischengespeicherten Werten, Fehler, Zirkel', async () => {
  const c = zellenVon(text(z, 'xl/worksheets/sheet1.xml')); // Map adr → {t, s, f, v}
  assert.deepEqual([c.get('A1').t, sst(z)[Number(c.get('A1').v)]], ['s', '<&> ']);
  assert.match(text(z, 'xl/sharedStrings.xml'), /<t xml:space="preserve">&lt;&amp;&gt; <\/t>/);
  assert.deepEqual([c.get('A2').t, c.get('A2').v], [undefined, '1234.5']);
  assert.deepEqual([c.get('A3').f, c.get('A3').v], ['SUM(A1:A2)', '1234.5']);
  assert.deepEqual([c.get('B1').f, c.get('B1').v], ['A_B_C___x_!A1', '5']);
  assert.deepEqual([c.get('C1').t, c.get('C1').v, c.get('C2').t, c.get('C2').v, c.get('C3').t, c.get('C3').v, c.get('D1').t, c.get('D1').v],
    ['e', '#DIV/0!', 'str', '<&> x', 'b', '1', 'e', '#VALUE!']);
  assert.deepEqual([c.get('D2').t, c.get('D2').v], ['e', '#VALUE!']);
  assert.equal(sst(z)[Number(c.get('E4').v)], '007');
  assert.equal(zellenVon(text(z, 'xl/worksheets/sheet2.xml')).get('A1').v, '5');
  assert.equal(zellenVon(text(z, 'xl/worksheets/sheet3.xml')).size, 0);
  // nur Format, kein Wert → <c r s/>; leeres Formelergebnis → 0
  const n = zellenVon(text(await zipLesen(await (await xlsxSchreiben({ blaetter: [{ ...M.blaetter[0], zellen: { A1: { f: { fett: true } }, B1: { w: '=C1' } } }] })).arrayBuffer()), 'xl/worksheets/sheet1.xml'));
  assert.deepEqual([n.get('A1').v, n.get('A1').f, typeof n.get('A1').s, n.get('B1').v], [undefined, undefined, 'string', '0']);
});

test('Stile: Reihenfolge, Zahlformate, Schrift, Füllung, Ausrichtung', async () => {
  const st = xmlLesen(text(z, 'xl/styles.xml'));
  assert.deepEqual(st.kinder.map((k) => k.name), ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles']);
  assert.deepEqual(kinder(kind(st, 'numFmts'), 'numFmt').map((n) => [n.attribute.numFmtId, n.attribute.formatCode]), [['164', 'DD.MM.YYYY'], ['165', '#,##0.00\\ "€"']]);
  assert.equal(kinder(kind(st, 'fills'), 'fill')[1].kinder[0].attribute.patternType, 'gray125');
  const c = zellenVon(text(z, 'xl/worksheets/sheet1.xml'));
  const xfs = kinder(kind(st, 'cellXfs'), 'xf'), fonts = kinder(kind(st, 'fonts'), 'font'), fills = kinder(kind(st, 'fills'), 'fill');
  assert.deepEqual(fonts[0].kinder.map((k) => [k.name, k.attribute]), [['sz', { val: '11' }], ['color', { theme: '1' }], ['name', { val: 'Calibri' }], ['family', { val: '2' }]]);
  assert.deepEqual(xfs[0].attribute, { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0', xfId: '0' });
  for (const [k, n] of [['fonts', fonts], ['fills', fills], ['cellXfs', xfs]]) assert.equal(kind(st, k).attribute.count, String(n.length), k);
  // A2: zahl2, fett, rot, gelbe Füllung, mittig
  const a2 = xfs[Number(c.get('A2').s)];
  assert.deepEqual(a2.attribute, { numFmtId: '4', fontId: a2.attribute.fontId, fillId: a2.attribute.fillId, borderId: '0', xfId: '0', applyNumberFormat: '1', applyFont: '1', applyFill: '1', applyAlignment: '1' });
  const font = fonts[Number(a2.attribute.fontId)];
  assert.deepEqual(font.kinder.map((k) => [k.name, k.attribute]), [['b', {}], ['sz', { val: '11' }], ['color', { rgb: 'FFB42318' }], ['name', { val: 'Calibri' }], ['family', { val: '2' }]]);
  const pf = kind(fills[Number(a2.attribute.fillId)], 'patternFill');
  assert.deepEqual([pf.attribute.patternType, kind(pf, 'fgColor').attribute, kind(pf, 'bgColor').attribute], ['solid', { rgb: 'FFFFF3A3' }, { indexed: '64' }]);
  assert.deepEqual(kind(a2, 'alignment').attribute, { horizontal: 'center' });
  assert.deepEqual(['E1', 'E2', 'E3', 'E4'].map((a) => xfs[Number(c.get(a).s)].attribute.numFmtId), ['164', '10', '165', '49']);
  assert.deepEqual(['E1', 'E2', 'E3', 'E4'].map((a) => xfs[Number(c.get(a).s)].attribute.fontId), ['0', '0', '0', '0']);
  assert.equal(c.get('A1').s, undefined);
});

test('Blattansicht, Spalten, Zeilen, Schema-Reihenfolge', async () => {
  const ws = xmlLesen(text(z, 'xl/worksheets/sheet1.xml'));
  assert.deepEqual(ws.kinder.map((k) => k.name), ['sheetViews', 'sheetFormatPr', 'cols', 'sheetData']);
  const sv = kind(kind(ws, 'sheetViews'), 'sheetView');
  assert.deepEqual(sv.attribute, { tabSelected: '1', workbookViewId: '0' });
  assert.deepEqual(sv.kinder.map((k) => k.name), ['pane', 'selection']);
  assert.deepEqual(kind(sv, 'pane').attribute, { ySplit: '1', topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' });
  assert.deepEqual(kind(sv, 'selection').attribute, { pane: 'bottomLeft' });
  assert.deepEqual(kind(ws, 'sheetFormatPr').attribute, { defaultRowHeight: '15' });
  assert.deepEqual(kind(kind(ws, 'cols'), 'col').attribute, { min: '2', max: '2', width: '19.29', customWidth: '1' });
  const rows = kinder(kind(ws, 'sheetData'), 'row');
  assert.deepEqual(rows[1].attribute, { r: '2', ht: '22.5', customHeight: '1' });
  assert.deepEqual(rows[0].attribute, { r: '1' });
  // Zeilen aufsteigend, Zellen je Zeile nach Spalte aufsteigend, in jeder <c> steht <f> vor <v>
  assert.deepEqual(rows.map((r) => r.attribute.r), ['1', '2', '3', '4']);
  assert.deepEqual(rows.map((r) => kinder(r, 'c').map((c) => c.attribute.r)), [['A1', 'B1', 'C1', 'D1', 'E1'], ['A2', 'C2', 'D2', 'E2'], ['A3', 'C3', 'E3'], ['E4']]);
  for (const r of rows) for (const c of kinder(r, 'c')) assert.deepEqual(c.kinder.map((k) => k.name), kind(c, 'f') ? ['f', 'v'] : kind(c, 'v') ? ['v'] : [], c.attribute.r);
  // zweites Blatt: nicht ausgewählt, nicht fixiert, ohne Spalten
  const ws2 = xmlLesen(text(z, 'xl/worksheets/sheet2.xml'));
  assert.deepEqual(ws2.kinder.map((k) => k.name), ['sheetViews', 'sheetFormatPr', 'sheetData']);
  assert.deepEqual(kind(kind(ws2, 'sheetViews'), 'sheetView'), { name: 'sheetView', attribute: { workbookViewId: '0' }, kinder: [], text: '' });
});
