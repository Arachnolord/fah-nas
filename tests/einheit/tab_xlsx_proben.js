// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Testmappen und Hilfen für xlsx der Office-Tabelle (Plan 06 Aufgaben 12–14): die Mappe M mit allen Zelltypen,
// Formaten, Zirkel, Blattbezug, ungültigen und doppelten Blattnamen, dazu Teile einer xlsx-Datei als Text lesen, die
// gemeinsamen Zeichenketten und die Zellen eines Blatts als Map. Für das Lesen (Aufgabe 13/14): die Rundreise-Mappe
// M_RUND, die handgebaute Datei HAND mit allem, was nicht übernommen wird, eine Zip-Bombe, eine Mappe aus einzelnen
// Zellen und das Gleichmachen der Blatt-Kennungen (zufällig beim Lesen).

import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const { xmlLesen, xmlEscape, kind, kinder } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'format', 'xml.js')).href);
const { zipSchreiben, crc32 } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'format', 'zip.js')).href);
const { zwischen } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen', 'board.js')).href);

/** Feste Zeit für docProps und HEUTE/JETZT. */
export const ZEIT = new Date(Date.UTC(2026, 9, 18, 12, 0, 0));

const p1 = zwischen(null, null), p2 = zwischen(p1, null), p3 = zwischen(p2, null);

/**
 * Testmappe M: Blatt „Umsatz 2026“ mit Text mit Rand-Leerzeichen, Zahl mit allen Formaten, Formeln (Summe, Blattbezug,
 * Fehler, Text, Zirkel), Wahrheitswert, Datum, Prozent, Euro, Text-Format; Breite, Höhe, Fixierung. Zweites Blatt mit
 * in Excel verbotenen Zeichen im Namen, drittes Blatt gleichnamig ohne Groß/Klein (leer).
 */
export const M = {
  blaetter: [
    {
      id: 'blatt1', name: 'Umsatz 2026', pos: p1,
      zellen: {
        A1: { w: '<&> ' },
        A2: { w: '1234.5', f: { zahl: 'zahl2', fett: true, farbe: '#b42318', hinter: '#fff3a3', ausr: 'mitte' } },
        A3: { w: '=SUM(A1:A2)' }, B1: { w: '=[blatt2]!A1' }, C1: { w: '=1/0' }, C2: { w: '=A1&"x"' }, C3: { w: 'TRUE' },
        D1: { w: '=D2' }, D2: { w: '=D1' },
        E1: { w: '46313', f: { zahl: 'datum' } }, E2: { w: '0.125', f: { zahl: 'prozent' } }, E3: { w: '1234.5', f: { zahl: 'euro' } },
        E4: { w: "'007", f: { zahl: 'text' } },
      },
      spalten: { B: { breite: 140 } }, zeilen: { 2: { hoehe: 30 } }, fixiert: { zeilen: 1 },
    },
    { id: 'blatt2', name: 'A/B:C*?[x]', pos: p2, zellen: { A1: { w: '5' } }, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } },
    { id: 'blatt3', name: 'umsatz 2026', pos: p3, zellen: {}, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } },
  ],
};

/** Teil der entpackten Datei als Text. */
export function text(zip, teil) {
  const b = zip.get(teil);
  if (!b) throw new Error(`Teil fehlt: ${teil}`);
  return new TextDecoder().decode(b);
}

/** Gemeinsame Zeichenketten in Reihenfolge (si/t oder Läufe r/t verbunden). */
export function sst(zip) {
  return kinder(xmlLesen(text(zip, 'xl/sharedStrings.xml')), 'si').map((si) => [kind(si, 't'), ...kinder(si, 'r').map((r) => kind(r, 't'))].filter(Boolean).map((t) => t.text).join(''));
}

/** Zellen eines Blatts: Map adr → {t, s, f, v} (fehlende Angaben undefined). */
export function zellenVon(xml) {
  const aus = new Map();
  for (const row of kinder(kind(xmlLesen(xml), 'sheetData'), 'row')) {
    for (const c of kinder(row, 'c')) aus.set(c.attribute.r, { t: c.attribute.t, s: c.attribute.s, f: kind(c, 'f')?.text, v: kind(c, 'v')?.text });
  }
  return aus;
}

// ---- Lesen (Aufgaben 13 und 14) ------------------------------------------------------------------------------------

/**
 * Rundreise-Mappe: zwei gültige, eindeutige Blätter, alle Formatfelder (jede Ausrichtung, jedes Zahlformat), Formeln mit
 * Blattbezug in beide Richtungen, Text '007 und mit Rand-Leerzeichen, Wahrheitswerte, eine Zelle nur mit Format,
 * Breiten, Höhen (auch einer Zeile ohne Zellen), Fixierung – wie M, aber ohne Zirkel und ohne doppelte Namen.
 */
export const M_RUND = {
  blaetter: [
    {
      id: 'blatt1', name: 'Umsatz 2026', pos: p1,
      zellen: {
        A1: { w: '<&> ' },
        A2: { w: '1234.5', f: { zahl: 'zahl2', fett: true, farbe: '#b42318', hinter: '#fff3a3', ausr: 'mitte' } },
        A3: { w: '=SUM(A1:A2)' }, B1: { w: '=[blatt2]!A1' },
        B2: { w: '-7.25', f: { kursiv: true, ausr: 'links' } }, B3: { w: 'Mitte', f: { ausr: 'rechts', farbe: '#1d4ed8' } },
        C1: { w: '=1/0' }, C2: { w: '=A1&"x"' }, C3: { w: 'TRUE' }, C4: { w: 'FALSE' }, D1: { w: '=IF(A2>1000,"groß","klein")' },
        E1: { w: '46313', f: { zahl: 'datum' } }, E2: { w: '0.125', f: { zahl: 'prozent' } }, E3: { w: '1234.5', f: { zahl: 'euro' } },
        E4: { w: "'007", f: { zahl: 'text' } }, F5: { f: { hinter: '#d1fae5' } },
      },
      spalten: { B: { breite: 140 }, D: { breite: 20 } }, zeilen: { 2: { hoehe: 30 } }, fixiert: { zeilen: 1 },
    },
    { id: 'blatt2', name: 'Mein Blatt', pos: p2, zellen: { A1: { w: '5' }, A2: { w: '=[blatt1]!A2*3' } }, spalten: {}, zeilen: { 7: { hoehe: 12 } }, fixiert: { zeilen: 0 } },
  ],
};

const XML_KOPF = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PAKET = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const rels = (liste) => `${XML_KOPF}<Relationships xmlns="${NS_PAKET}">${liste.map(([id, typ, ziel]) => `<Relationship Id="${id}" Type="${typ.startsWith('http') ? typ : `${NS_R}/${typ}`}" Target="${ziel}"/>`).join('')}</Relationships>`;
const PAKET_RELS = rels([['rId1', 'officeDocument', 'xl/workbook.xml']]);
const typen = (blaetter) => `${XML_KOPF}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SML}.sheet.main+xml"/>`
  + Array.from({ length: blaetter }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${SML}.worksheet+xml"/>`).join('') + '</Types>';

/**
 * Handgebaute Datei, wie sie Excel schreiben könnte: Arbeitsmappe mit fremdem Präfix x: und 1904-Datumssystem,
 * gemeinsame Zeichenketten mit Läufen und Lautschrift, Stile (14, 164 „#,##0.00 €“, 9, 49, Schrift mit Theme-Farbe),
 * ein Blatt mit gemeinsamer Formel, inlineStr, Fehlerkonstante, Tabellenbezug, _xlfn.XLOOKUP, Blattbereich, Fixierung,
 * Spaltenbreite, Zeilenhöhe, zwei verbundenen Bereichen und einer bedingten Formatierung; dazu Diagramm, Pivot-Tabelle,
 * Makros und ein Kommentar. Als Einträge für zipSchreiben.
 */
export const HAND = [
  { name: '[Content_Types].xml', daten: typen(1) },
  { name: '_rels/.rels', daten: PAKET_RELS },
  {
    name: 'xl/workbook.xml',
    daten: `${XML_KOPF}<x:workbook xmlns:x="${NS_MAIN}" xmlns:r="${NS_R}"><x:workbookPr date1904="1"/><x:sheets><x:sheet name="Sheet1" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
  },
  { name: 'xl/_rels/workbook.xml.rels', daten: rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'styles', 'styles.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml'], ['rId4', 'http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'vbaProject.bin']]) },
  {
    name: 'xl/sharedStrings.xml',
    daten: `${XML_KOPF}<sst xmlns="${NS_MAIN}" count="2" uniqueCount="2"><si><t>Kopf</t></si><si><r><t xml:space="preserve">Lauf </t></r><r><rPr><b/></rPr><t>fett</t></r><rPh sb="0" eb="1"><t>ラ</t></rPh></si></sst>`,
  },
  {
    name: 'xl/styles.xml',
    daten: `${XML_KOPF}<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00 €"/></numFmts>`
      + '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><sz val="11"/><color theme="4"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
  },
  {
    name: 'xl/worksheets/sheet1.xml',
    daten: `${XML_KOPF}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/><cols><col min="2" max="2" width="19.29" customWidth="1"/></cols><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Inline</t></is></c><c r="D1"><f>_xlfn.XLOOKUP(1,A:A,B:B)</f><v>0</v></c><c r="E1" s="1"><v>45000</v></c></row>'
      + '<row r="2" ht="22.5" customHeight="1"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B4" si="0">A2*2</f><v>2</v></c><c r="C2" t="e"><v>#N/A</v></c>'
      + '<c r="D2"><f>Sheet1:Sheet2!A1</f><v>3</v></c><c r="E2" s="2"><v>1234.5</v></c></row>'
      + '<row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c><c r="C3"><f>Table1[Spalte]</f><v>7</v></c><c r="E3" s="3"><v>0.5</v></c></row>'
      + '<row r="4"><c r="A4"><v>3</v></c><c r="B4"><f t="shared" si="0"/><v>6</v></c><c r="E4" s="4" t="s"><v>1</v></c></row>'
      + '<row r="5"><c r="E5" s="5"><v>9</v></c></row></sheetData>'
      + '<mergeCells count="2"><mergeCell ref="F1:G1"/><mergeCell ref="F2:G2"/></mergeCells>'
      + '<conditionalFormatting sqref="A1:A4"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>1</formula></cfRule></conditionalFormatting></worksheet>',
  },
  { name: 'xl/charts/chart1.xml', daten: `${XML_KOPF}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>` },
  { name: 'xl/pivotTables/pivotTable1.xml', daten: `${XML_KOPF}<pivotTableDefinition xmlns="${NS_MAIN}" name="P1"/>` },
  { name: 'xl/vbaProject.bin', daten: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]) },
  {
    name: 'xl/comments1.xml',
    daten: `${XML_KOPF}<comments xmlns="${NS_MAIN}"><authors><author>Anna</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Hinweis</t></text></comment></commentList></comments>`,
  },
];

/**
 * Zip-Bombe (synchron, damit sie auch in new Blob([…]) passt): ein Eintrag mit 4 MiB Nullen, gepackt rund 4 KiB –
 * Verhältnis weit über 100:1. → ArrayBuffer
 */
export function zipBombe() {
  const roh = new Uint8Array(4 * 1024 * 1024);
  const gepackt = new Uint8Array(deflateRawSync(roh));
  const name = new TextEncoder().encode('xl/workbook.xml');
  const crc = crc32(roh);
  const lokal = new Uint8Array(30 + name.length), zentral = new Uint8Array(46 + name.length), ende = new Uint8Array(22);
  const lv = new DataView(lokal.buffer), zv = new DataView(zentral.buffer), ev = new DataView(ende.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc, true);
  lv.setUint32(18, gepackt.length, true); lv.setUint32(22, roh.length, true); lv.setUint16(26, name.length, true); lokal.set(name, 30);
  zv.setUint32(0, 0x02014b50, true); zv.setUint16(4, 20, true); zv.setUint16(6, 20, true); zv.setUint16(10, 8, true); zv.setUint32(16, crc, true);
  zv.setUint32(20, gepackt.length, true); zv.setUint32(24, roh.length, true); zv.setUint16(28, name.length, true); zentral.set(name, 46);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, zentral.length, true); ev.setUint32(16, lokal.length + gepackt.length, true);
  const aus = new Uint8Array(lokal.length + gepackt.length + zentral.length + ende.length);
  aus.set(lokal, 0); aus.set(gepackt, lokal.length); aus.set(zentral, lokal.length + gepackt.length); aus.set(ende, aus.length - ende.length);
  return aus.buffer;
}

/**
 * Kleinste xlsx mit einem Blatt aus einzelnen Zellen: { <adr>: Text } als inlineStr, ein Wert, der mit „<c“ beginnt,
 * wird roh übernommen (Sonderfälle). → ArrayBuffer
 */
export async function xlsxVonHand(zellen, { name = 'Tabelle1' } = {}) {
  const zeilen = new Map();
  for (const [adr, wert] of Object.entries(zellen)) {
    const z = Number(/\d+$/.exec(adr)[0]);
    const xml = String(wert).startsWith('<c') ? wert : `<c r="${adr}" t="inlineStr"><is><t>${xmlEscape(wert)}</t></is></c>`;
    if (!zeilen.has(z)) zeilen.set(z, []);
    zeilen.get(z).push(xml);
  }
  const daten = [...zeilen.keys()].sort((a, b) => a - b).map((z) => `<row r="${z}">${zeilen.get(z).join('')}</row>`).join('');
  return (await zipSchreiben([
    { name: '[Content_Types].xml', daten: typen(1) },
    { name: '_rels/.rels', daten: PAKET_RELS },
    { name: 'xl/workbook.xml', daten: `${XML_KOPF}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', daten: rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']]) },
    { name: 'xl/worksheets/sheet1.xml', daten: `${XML_KOPF}<worksheet xmlns="${NS_MAIN}"><sheetData>${daten}</sheetData></worksheet>` },
  ])).buffer;
}

/** Blatt-Kennungen nach Reihenfolge benennen (norm01, norm02 …, auch in [id]! der Formeln) und pos nach Reihenfolge setzen. */
export function idsNachReihenfolge(daten) {
  const karte = new Map(daten.blaetter.map((b, i) => [b.id, `norm${String(i + 1).padStart(2, '0')}`]));
  const umschreiben = (w) => {
    if (typeof w !== 'string' || !w.startsWith('=')) return w;
    let s = w;
    for (const [alt, neu] of karte) s = s.split(`[${alt}]!`).join(`[${neu}]!`);
    return s;
  };
  return {
    blaetter: daten.blaetter.map((b, i) => ({
      ...b, id: karte.get(b.id), pos: `p${String(i + 1).padStart(3, '0')}`,
      zellen: Object.fromEntries(Object.entries(b.zellen).map(([adr, z]) => [adr, z.w === undefined ? z : { ...z, w: umschreiben(z.w) }])),
    })),
  };
}
