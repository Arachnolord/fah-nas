// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Import aus Word (Plan 05 Aufgabe 17): Rundreise schreiben → lesen ohne Verlust, handgebaute docx mit nicht
// unterstützten Teilen (fehlte), fremde Präfixe und Stile, Absatz- und Laufformate aus Word, Tabellen (Raster, Breiten,
// verschachtelt, verbunden, zu groß), Bilder (eingebettet, VML, extern, kaputt) und kaputte bzw. bösartige Dateien
// (Review Focus 3). Mit FAHNAS_DOCX_PROBE=<pfad> legt die Rundreise die exportierte Datei für die Echtprobe ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D, BILD, PNG_2x1, ZEIT, lader } from './office_docx_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const laden = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);
const { docxSchreiben, docxLesen, FEHLTE_ARTEN } = await laden('office', 'dokument', 'docx.js');
const { zipSchreiben } = await laden('office', 'format', 'zip.js');
const { zeilenAus } = await laden('office', 'dokument', 'modell.js');
const { dokumentPruefen } = await laden('gemeinsam', 'sync', 'typen', 'dokument.js');
const { tabelleWertPruefen, sichtbareZeilen, sichtbareSpalten } = await laden('gemeinsam', 'sync', 'typen', 'dokument-tabelle.js');
const { normalisieren } = await laden('gemeinsam', 'sync', 'delta.js');

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture', mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  v: 'urn:schemas-microsoft-com:vml', o: 'urn:schemas-microsoft-com:office:office', c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
};
const XMLNS = Object.entries(NS).map(([p, u]) => `xmlns:${p}="${u}"`).join(' ');
const JPEG_5x6 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 6, 0, 5, 1, 1, 0x11, 0, 0xff, 0xd9]);

const relsXml = (liste) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${liste.map(([id, typ, ziel, extern]) => `<Relationship Id="${id}" Type="${typ.includes('/') ? typ : `${NS.r}/${typ}`}" Target="${ziel}"${extern ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const dokXml = (body, sect = '<w:sectPr/>') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${XMLNS}><w:body>${body}${sect}</w:body></w:document>`;

/** docx von Hand: Körper (oder ganzes document.xml), Beziehungen, styles/numbering (Inhalt oder ganzes XML), weitere Teile. */
async function docxAus({ body = '', dokument = null, sect, rels = [], stile = null, nummern = null, teile = {}, paket = true }) {
  const r = [...rels];
  if (stile !== null) r.push(['rIdStile', 'styles', 'styles.xml']);
  if (nummern !== null) r.push(['rIdNummern', 'numbering', 'numbering.xml']);
  const eintraege = [{ name: '[Content_Types].xml', daten: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' }];
  if (paket) eintraege.push({ name: '_rels/.rels', daten: relsXml([['rId1', 'officeDocument', 'word/document.xml']]) });
  eintraege.push({ name: 'word/document.xml', daten: dokument ?? dokXml(body, sect) }, { name: 'word/_rels/document.xml.rels', daten: relsXml(r) });
  if (stile !== null) eintraege.push({ name: 'word/styles.xml', daten: stile.startsWith('<') && stile.includes('styles ') ? stile : `<w:styles xmlns:w="${NS.w}">${stile}</w:styles>` });
  if (nummern !== null) eintraege.push({ name: 'word/numbering.xml', daten: nummern.includes('numbering ') ? nummern : `<w:numbering xmlns:w="${NS.w}">${nummern}</w:numbering>` });
  for (const [name, daten] of Object.entries(teile)) eintraege.push({ name, daten });
  return (await zipSchreiben(eintraege)).buffer;
}

/** Feste Kennungen statt Zufall: id0001, id0002, … (ID_MUSTER verlangt 6–24 Zeichen) */
const ids = () => { let n = 0; return () => `id${String(++n).padStart(4, '0')}`; };
const textVon = (r) => r.daten.delta.map((o) => (typeof o.insert === 'string' ? o.insert : '')).join('');
const zeilenVon = (r) => zeilenAus(r.daten.delta).map((z) => [z.block || z.text, z.attribute]);
const laeufeVon = (z) => z.inhalt.map((o) => [o.insert, o.attributes || {}]);

/** Bildschlüssel → Datei-ID (wie verknuepfen nach dem Hochladen). */
function verknuepfeFuerTest(r, datei = () => BILD) {
  const karte = new Map(r.dateien.map((d) => [d.schluessel, datei(d)]));
  const delta = r.daten.delta.map((op) => (op.insert && op.insert.bild ? { ...op, insert: { bild: { ...op.insert.bild, datei: karte.get(op.insert.bild.datei) } } } : op));
  return { ...r.daten, delta };
}
/** Tabellen-, Zeilen- und Spalten-Kennungen nach Reihenfolge (t1, z1, s1), ohne Grabsteine und ohne weg. */
function ohneIds(delta) {
  let t = 0;
  return delta.map((op) => {
    const tab = op.insert && op.insert.tabelle;
    if (!tab) return op;
    t += 1;
    const zn = new Map(sichtbareZeilen(tab).map((z, i) => [z, `z${i + 1}`]));
    const sn = new Map(sichtbareSpalten(tab).map((s, i) => [s, `s${i + 1}`]));
    const zellen = {};
    for (const [k, v] of Object.entries(tab.zellen)) { const [z, s] = k.split('|'); if (zn.has(z) && sn.has(s)) zellen[`${zn.get(z)}|${sn.get(s)}`] = v; }
    const breiten = {};
    for (const [s, px] of Object.entries(tab.breiten)) if (sn.has(s)) breiten[sn.get(s)] = px;
    return { ...op, insert: { tabelle: { id: `t${t}`, zeilen: [...zn.values()], spalten: [...sn.values()], zellen, breiten } } };
  });
}
const ohneKommentare = (delta) => normalisieren(delta.map((op) => {
  if (!op.attributes || op.attributes.kommentar === undefined) return op;
  const { kommentar, ...rest } = op.attributes; // eslint-disable-line no-unused-vars
  return { ...op, attributes: rest };
}));

test('Rundreise: alle unterstützten Merkmale (schreiben → lesen → gleiches Modell)', async () => {
  const blob = await docxSchreiben(D, lader, { titel: 'Bericht', autor: 'Anna', zeit: ZEIT });
  if (process.env.FAHNAS_DOCX_PROBE) fs.writeFileSync(process.env.FAHNAS_DOCX_PROBE, new Uint8Array(await blob.arrayBuffer()));
  const r = await docxLesen(await blob.arrayBuffer());
  assert.deepEqual(r.fehlte, []);
  assert.doesNotThrow(() => dokumentPruefen(verknuepfeFuerTest(r)));
  assert.deepEqual(ohneIds(verknuepfeFuerTest(r).delta), ohneIds(ohneKommentare(D.delta)));
  assert.deepEqual(r.daten.kommentare, {});
  assert.deepEqual(r.dateien.map((d) => [d.schluessel, d.name, d.blob.type]), [['bild1', 'bild1.png', 'image/png']]);
  assert.deepEqual(new Uint8Array(await r.dateien[0].blob.arrayBuffer()), PNG_2x1);
  assert.deepEqual(FEHLTE_ARTEN, ['kopfzeilen', 'fussnoten', 'kommentare', 'diagramme', 'formen', 'textfelder', 'felder', 'formeln', 'objekte', 'bilder', 'verbunden', 'verschachtelt', 'tabellengroesse']);
  // eigene Kennungen: Tabellen, Zeilen und Spalten kommen aus dem Erzeuger
  const r2 = await docxLesen(await blob.arrayBuffer(), { id: ids() });
  const t = r2.daten.delta.find((o) => o.insert && o.insert.tabelle).insert.tabelle;
  assert.deepEqual([t.id, t.zeilen, t.spalten, t.weg], ['id0001', ['id0002', 'id0003'], ['id0004', 'id0005'], []]);
  // eine Tabelle am Dokumentende bekommt in Word einen Absatz dahinter – der bleibt als Zeile, damit man weiterschreiben kann
  const am = await docxLesen(await (await docxSchreiben({ delta: [{ insert: 'a\n' }, { insert: { tabelle: D.delta.find((o) => o.insert.tabelle).insert.tabelle } }, { insert: '\n' }], kommentare: {} }, lader)).arrayBuffer());
  assert.deepEqual(zeilenVon(am).map((z) => z[0]), ['a', 'tabelle', '']);
});

test('Handgebaute docx mit nicht unterstützten Teilen (fehlte gefüllt)', async () => {
  const zeichnung = (uri, innen, art = 'inline') => `<w:r><w:drawing><wp:${art}><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="${uri}">${innen}</a:graphicData></a:graphic></wp:${art}></w:drawing></w:r>`;
  const body = `<w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr><w:r><w:t>Überschrift</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Fuß</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t>noten</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
    <w:p>${zeichnung('http://schemas.openxmlformats.org/drawingml/2006/chart', '<c:chart r:id="rId3"/>')}</w:p>
    <w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="2" name="Textfeld"/><a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Im Textfeld</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>
      <mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Im Textfeld</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Seite </w:t></w:r><w:fldSimple w:instr=" PAGE   \\* MERGEFORMAT "><w:r><w:t>3</w:t></w:r></w:fldSimple></w:p>
    <w:p><w:hyperlink r:id="rId4"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>böse</w:t></w:r></w:hyperlink></w:p>
    <w:p>${zeichnung(NS.pic, '<pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic>')}</w:p>
    <w:p><w:del w:id="7" w:author="a"><w:r><w:t>weg</w:t></w:r></w:del><w:ins w:id="8" w:author="a"><w:r><w:t>neu</w:t></w:r></w:ins></w:p>
    <w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>über zwei</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`;
  const z = await docxAus({
    body, sect: '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId6"/></w:sectPr>',
    rels: [['rId2', 'header', 'header1.xml'], ['rId3', 'chart', 'charts/chart1.xml'], ['rId4', 'hyperlink', 'javascript:alert(1)', true], ['rId5', 'image', 'https://example.com/bild.png', true], ['rId6', 'footer', 'footer1.xml']],
    stile: '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/></w:style><w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>',
    teile: { 'word/header1.xml': `<w:hdr xmlns:w="${NS.w}"><w:p><w:r><w:t>Kopfzeile</w:t></w:r></w:p></w:hdr>`, 'word/footer1.xml': `<w:ftr xmlns:w="${NS.w}"><w:p/></w:ftr>` },
  });
  const r = await docxLesen(z);
  assert.deepEqual(r.fehlte, [{ art: 'kopfzeilen', anzahl: 1 }, { art: 'fussnoten', anzahl: 2 }, { art: 'diagramme', anzahl: 1 }, { art: 'textfelder', anzahl: 1 },
    { art: 'felder', anzahl: 1 }, { art: 'bilder', anzahl: 1 }, { art: 'verbunden', anzahl: 1 }]);
  const text = textVon(r);
  assert.ok(text.includes('Seite 3') && text.includes('böse') && text.includes('neu') && !text.includes('weg'));
  assert.ok(!text.includes('Im Textfeld') && !text.includes('Kopfzeile'));
  assert.ok(r.daten.delta.every((o) => !o.attributes?.link)); // javascript-Link fällt weg, Text bleibt
  assert.deepEqual(r.daten.delta.find((o) => o.attributes?.ueberschrift)?.attributes, { ueberschrift: 1 });
  assert.equal(r.dateien.length, 0); // externes Bild nie geladen
  const t = r.daten.delta.find((o) => o.insert && o.insert.tabelle).insert.tabelle;
  assert.deepEqual(sichtbareZeilen(t).map((zz) => sichtbareSpalten(t).map((s) => (t.zellen[`${zz}|${s}`] || []).map((o) => o.insert).join(''))), [['über zwei', ''], ['a', 'b']]);
  assert.deepEqual(t.breiten, Object.fromEntries(t.spalten.map((s) => [s, 133])));
});

test('fremder Präfix, Title/Subtitle, Ebenen > 3, w:br, Liste über Stil', async () => {
  const stile = '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Untertitel"><w:name w:val="Subtitle"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/></w:style><w:style w:type="paragraph" w:styleId="titre2"><w:name w:val="Titre 2"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Eigen"><w:name w:val="Meine Überschrift"/><w:basedOn w:val="Heading2"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Kreis1"><w:name w:val="Kreis1"/><w:basedOn w:val="Kreis2"/></w:style><w:style w:type="paragraph" w:styleId="Kreis2"><w:name w:val="Kreis2"/><w:basedOn w:val="Kreis1"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Zitat"><w:name w:val="Intense Quote"/></w:style>';
  const neun = (f) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${f(l)}"/></w:lvl>`).join('');
  const nummern = `<w:abstractNum w:abstractNumId="7">${neun(() => 'bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="8">${neun((l) => (l === 3 ? 'none' : l === 2 ? 'upperRoman' : 'decimal'))}</w:abstractNum>`
    + '<w:num w:numId="5"><w:abstractNumId w:val="7"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="8"/></w:num>'
    + '<w:num w:numId="9"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:lvlOverride></w:num>';
  const p = (ppr, t) => `<w:p><w:pPr>${ppr}</w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const body = p('<w:pStyle w:val="Title"/>', 'Titel') + p('<w:pStyle w:val="Untertitel"/>', 'Unter') + p('<w:pStyle w:val="Heading5"/>', 'Fünf') + p('<w:pStyle w:val="titre2"/>', 'Deux')
    + p('<w:pStyle w:val="Eigen"/>', 'Geerbt') + p('<w:pStyle w:val="Kreis1"/>', 'Kreis') + p('<w:pStyle w:val="Fehlt"/>', 'Unbekannt') + p('<w:pStyle w:val="Zitat"/>', 'Intensiv')
    + p('<w:pStyle w:val="ListBullet"/>', 'Stilpunkt') + p('<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="2"/><w:numId w:val="6"/></w:numPr>', 'Eigene Zahl')
    + p('<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="1"/></w:numPr>', 'Stil mit Ebene') + p('<w:numPr><w:ilvl w:val="3"/><w:numId w:val="6"/></w:numPr>', 'Ohne Format')
    + p('<w:pStyle w:val="ListBullet"/><w:numPr><w:numId w:val="0"/></w:numPr><w:ind w:left="720"/>', 'Abgeschaltet') + p('<w:numPr><w:ilvl w:val="12"/><w:numId w:val="5"/></w:numPr>', 'Tief')
    + p('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr>', 'Überschrieben') + p('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="77"/></w:numPr>', 'Ohne Nummerierung')
    + '<w:p><w:pPr><w:jc w:val="center"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="6"/></w:numPr></w:pPr><w:r><w:t>eins</w:t><w:br/><w:t>zwei</w:t><w:cr/><w:t>drei</w:t><w:br w:type="textWrapping"/></w:r></w:p>';
  const erwartet = [['Titel', { ueberschrift: 1 }], ['Unter', { ueberschrift: 2 }], ['Fünf', { ueberschrift: 3 }], ['Deux', { ueberschrift: 2 }], ['Geerbt', { ueberschrift: 2 }],
    ['Kreis', {}], ['Unbekannt', {}], ['Intensiv', { zitat: true }], ['Stilpunkt', { liste: 'punkte' }], ['Eigene Zahl', { liste: 'zahlen', einzug: 2 }],
    ['Stil mit Ebene', { liste: 'punkte', einzug: 1 }], ['Ohne Format', {}], ['Abgeschaltet', { einzug: 1 }], ['Tief', { liste: 'punkte', einzug: 8 }],
    ['Überschrieben', { liste: 'zahlen' }], ['Ohne Nummerierung', {}],
    ['eins', { ausrichtung: 'mitte', liste: 'zahlen' }], ['zwei', { ausrichtung: 'mitte', liste: 'zahlen' }], ['drei', { ausrichtung: 'mitte', liste: 'zahlen' }], ['', { ausrichtung: 'mitte', liste: 'zahlen' }]];
  const r = await docxLesen(await docxAus({ body, stile, nummern }));
  assert.deepEqual(zeilenVon(r), erwartet);
  assert.deepEqual(r.fehlte, []);
  // dasselbe mit fremden Präfixen: ns0 im Dokument, Standard-Namensraum in styles.xml, x in numbering.xml
  const ns0 = (s) => s.replace(/<(\/?)w:/g, '<$1ns0:').replace(/ w:/g, ' ns0:');
  const dokument = `<?xml version="1.0"?><ns0:document xmlns:ns0="${NS.w}" xmlns:ns1="${NS.r}"><ns0:body>${ns0(body)}<ns0:sectPr/></ns0:body></ns0:document>`;
  const stileStandard = `<styles xmlns="${NS.w}" xmlns:q="${NS.w}">${stile.replace(/<(\/?)w:/g, '<$1').replace(/ w:/g, ' q:')}</styles>`;
  const nummernX = `<x:numbering xmlns:x="${NS.w}">${nummern.replace(/<(\/?)w:/g, '<$1x:').replace(/ w:/g, ' x:')}</x:numbering>`;
  const r2 = await docxLesen(await docxAus({ dokument, stile: stileStandard, nummern: nummernX }));
  assert.deepEqual(zeilenVon(r2), erwartet);
  // ein fremder Namensraum unter dem Präfix „w“ ist kein WordprocessingML
  const falsch = `<?xml version="1.0"?><x:document xmlns:x="${NS.w}" xmlns:w="urn:fremd"><x:body><x:p><w:r><w:t>fremd</w:t></w:r><x:r><x:t>echt</x:t></x:r></x:p></x:body></x:document>`;
  assert.equal(textVon(await docxLesen(await docxAus({ dokument: falsch }))), 'echt\n');
});

test('Absatz- und Laufformate aus Word: Einzug, Ausrichtung, Seitenumbruch, an/aus, Farben, Code, Zeichenstile, Felder, Aufgaben', async () => {
  const stile = '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="InternetLink"><w:name w:val="Internet Link"/><w:rPr><w:color w:val="000080"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Betont"><w:name w:val="Betont"/><w:basedOn w:val="Strong"/><w:rPr><w:i/><w:color w:val="B42318"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="567"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:color w:val="2F5496"/></w:rPr></w:style>';
  const nummern = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  const lauf = (rpr, t) => `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const p = (ppr, innen) => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${innen}</w:p>`;
  const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
  const body = p('<w:ind w:left="1440"/>', t('zwei')) + p('<w:ind w:start="700"/><w:jc w:val="end"/>', t('eins rechts')) + p('<w:ind w:left="100" w:hanging="360"/><w:jc w:val="distribute"/>', t('block'))
    + p('<w:ind w:left="99999"/><w:jc w:val="left"/>', t('acht')) + p('<w:ind w:left="-500"/><w:jc w:val="both"/>', t('negativ')) + p('<w:pStyle w:val="Quote"/>', t('Zitat'))
    + p('<w:pStyle w:val="Heading1"/>', t('Kopf')) + p('<w:pageBreakBefore/>', t('neue Seite')) + p('', `${t('vor')}<w:r><w:br w:type="page"/></w:r>${t('nach')}`)
    + p('', lauf('<w:b w:val="0"/><w:i w:val="false"/><w:strike w:val="off"/><w:u w:val="none"/><w:color w:val="auto"/><w:shd w:val="clear" w:color="auto" w:fill="FFFFFF"/>', 'schlicht')
      + lauf('<w:b w:val="1"/><w:i w:val="true"/><w:dstrike/><w:u w:val="double"/>', 'an') + lauf('<w:color w:val="FF0000"/><w:highlight w:val="yellow"/>', 'rot')
      + lauf('<w:color w:val="b42318"/><w:highlight w:val="darkYellow"/>', 'palette') + lauf('<w:highlight w:val="red"/><w:shd w:val="clear" w:color="auto" w:fill="C9F2D0"/>', 'schattiert')
      + lauf('<w:color w:val="12345"/><w:highlight w:val="none"/><w:shd w:val="clear" w:fill="auto"/>', 'unsinn'))
    + p('', lauf('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>', 'mono') + lauf('<w:rFonts w:hAnsi="menlo"/>', 'menlo') + lauf('<w:rStyle w:val="Code"/>', 'stil')
      + lauf('<w:rStyle w:val="Strong"/>', 'stark') + lauf('<w:rStyle w:val="Betont"/><w:b w:val="0"/>', 'betont') + lauf('<w:rStyle w:val="Hyperlink"/>', 'keinlink')
      + lauf('<w:rStyle w:val="InternetLink"/>', 'lo') + lauf('<w:vanish/>', 'versteckt') + lauf('<w:rStyle w:val="Fehlt"/>', 'unbekannt'))
    + p('', `${t('Datum: ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "dd.MM.yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${t('18.10.2026')}<w:r><w:fldChar w:fldCharType="end"/></w:r>${t(' ok')}`)
    + p('', '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>OFFEN</w:instrText></w:r><w:r><w:t>Code</w:t></w:r>') + p('', t('danach'))
    + p('', `<w:sdt><w:sdtPr/><w:sdtContent><w:r><w:t>Feld</w:t></w:r></w:sdtContent></w:sdt><w:smartTag w:element="x"><w:r><w:t>tag</w:t></w:r></w:smartTag><w:proofErr w:type="spellStart"/><w:bookmarkStart w:id="0" w:name="a"/>`
      + '<w:r><w:t>-</w:t><w:noBreakHyphen/><w:t>-</w:t><w:sym w:font="Wingdings" w:char="F0FC"/><w:softHyphen/><w:lastRenderedPageBreak/></w:r><w:bookmarkEnd w:id="0"/><w:moveFrom><w:r><w:t>alt</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>hin</w:t></w:r></w:moveTo>'
      + '<w:r><mc:AlternateContent><mc:Choice Requires="w14"><w:t>Wahl</w:t></mc:Choice><mc:Fallback><w:t>Ersatz</w:t></mc:Fallback></mc:AlternateContent></w:r>')
    + p('', `${t('Kommentar')}<w:r><w:commentReference w:id="0"/></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:object/></w:r><w:r><w:endnoteReference w:id="3"/></w:r>`)
    + p('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', `${t('☒ ')}${lauf('<w:b/>', 'fertig')}`) + p('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', `${t('☐')}${t(' offen')}`)
    + p('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', t('☑')) + p('', t('☐ keine Liste')) + p('', t('Zeilen&#10;umbruch&#13;im Text&#xFFFC;'));
  const r = await docxLesen(await docxAus({ body, stile, nummern }));
  const zeilen = zeilenAus(r.daten.delta);
  assert.deepEqual(zeilen.map((z) => [z.block || z.text, z.attribute]), [['zwei', { einzug: 2 }], ['eins rechts', { einzug: 1, ausrichtung: 'rechts' }], ['block', { ausrichtung: 'block' }],
    ['acht', { einzug: 8 }], ['negativ', { ausrichtung: 'block' }], ['Zitat', { zitat: true, ausrichtung: 'mitte' }], ['Kopf', { ueberschrift: 1 }], ['seitenumbruch', {}], ['neue Seite', {}],
    ['vor', {}], ['seitenumbruch', {}], ['nach', {}], ['schlichtanrotpaletteschattiertunsinn', {}], ['monomenlostilstarkbetontkeinlinklounbekannt', {}], ['Datum: 18.10.2026 ok', {}],
    ['', {}], ['danach', {}], ['Feldtag---hinWahl', {}], ['Kommentar', {}], ['fertig', { liste: 'aufgabe', erledigt: true }], ['offen', { liste: 'aufgabe' }],
    ['☑', { liste: 'punkte' }], ['☐ keine Liste', {}], ['Zeilen umbruch im Text', {}]]);
  assert.deepEqual(laeufeVon(zeilen[6]), [['Kopf', {}]], 'Absatzstil-Formate gehören zum Stil, nicht zum Text');
  assert.deepEqual(laeufeVon(zeilen[12]), [['schlicht', {}], ['an', { fett: true, kursiv: true, durchgestrichen: true, unterstrichen: true }], ['rot', { farbe: '#ff0000', hintergrund: 'gelb' }],
    ['palette', { farbe: 'rot', hintergrund: 'orange' }], ['schattiert', { hintergrund: 'gruen' }], ['unsinn', {}]]);
  assert.deepEqual(laeufeVon(zeilen[13]), [['monomenlostil', { code: true }], ['stark', { fett: true }], ['betont', { kursiv: true, farbe: 'rot' }], ['keinlinklounbekannt', {}]]);
  assert.deepEqual(laeufeVon(zeilen[19]), [['fertig', { fett: true }]]);
  assert.deepEqual(r.fehlte, [{ art: 'fussnoten', anzahl: 1 }, { art: 'kommentare', anzahl: 1 }, { art: 'felder', anzahl: 2 }, { art: 'formeln', anzahl: 1 }, { art: 'objekte', anzahl: 1 }]);
  assert.doesNotThrow(() => dokumentPruefen(r.daten));
});

test('Tabellen aus Word: Raster mit aufgefüllten Zeilen, Breiten, Zellabsätze, verschachtelt, verbunden, Bild in der Zelle, Trennabsatz', async () => {
  const zelle = (innen, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${innen}</w:tc>`;
  const p = (s, rpr = '') => `<w:p><w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${s}</w:t></w:r></w:p>`;
  const bild = `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:blipFill><a:blip r:embed="rIdB"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const t1 = '<w:tbl><w:tblGrid><w:gridCol w:w="1440"/><w:gridCol w:w="300"/><w:gridCol w:w="99999"/></w:tblGrid>'
    + `<w:tr>${zelle(p('A', '<w:b/>'))}${zelle(p('B'))}${zelle(p('C'))}</w:tr>`
    + `<w:tr>${zelle(`<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Kopf</w:t></w:r></w:p>${p('zweite')}<w:p/><w:p/>`)}${zelle(`<w:tbl><w:tr>${zelle(p('innen 1'))}${zelle(`${p('innen 2')}<w:tbl><w:tr>${zelle(p('ganz innen'))}</w:tr></w:tbl>`)}</w:tr></w:tbl>${p('nach innen')}`)}</w:tr>`
    + `<w:tr>${zelle(p('unten'), '<w:vMerge w:val="restart"/>')}${zelle(`<w:p><w:r><w:t>x</w:t><w:br/><w:t>y</w:t><w:br w:type="page"/></w:r>${bild}</w:p>`)}</w:tr>`
    + `<w:sdt><w:sdtContent><w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${zelle('<w:p/>', '<w:vMerge/>')}${zelle(p('rechts'))}</w:tr></w:sdtContent></w:sdt></w:tbl>`;
  const t2 = `<w:tbl><w:tblGrid><w:gridCol w:w="4819"/><w:gridCol w:w="4819"/></w:tblGrid><w:tr>${zelle(p('x'))}${zelle('<w:p/>')}</w:tr></w:tbl>`;
  const leer = '<w:tbl><w:tblGrid/></w:tbl>';
  const body = `${t1}<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:bookmarkStart w:id="1" w:name="b"/></w:p>${t2}${leer}<w:p/>${t2}${p('dazwischen')}${t2}<w:p/>`;
  const z = await docxAus({ body, rels: [['rIdB', 'image', 'media/b.png']], teile: { 'word/media/b.png': PNG_2x1 } });
  const r = await docxLesen(z, { id: ids() });
  assert.deepEqual(zeilenVon(r).map((x) => x[0]), ['tabelle', 'tabelle', 'tabelle', 'dazwischen', 'tabelle', '']);
  const tabs = r.daten.delta.filter((o) => o.insert && o.insert.tabelle).map((o) => o.insert.tabelle);
  for (const t of tabs) assert.doesNotThrow(() => tabelleWertPruefen(t));
  const zellText = (t) => sichtbareZeilen(t).map((zz) => sichtbareSpalten(t).map((s) => (t.zellen[`${zz}|${s}`] || []).map((o) => o.insert).join('')));
  assert.deepEqual(zellText(tabs[0]), [['A', 'B', 'C'], ['Kopf\nzweite', 'innen 1\ninnen 2\nganz innen\nnach innen', ''], ['unten', 'x\ny', ''], ['', '', 'rechts']]);
  assert.deepEqual(tabs[0].zellen[`${tabs[0].zeilen[0]}|${tabs[0].spalten[0]}`], [{ insert: 'A', attributes: { fett: true } }]);
  assert.deepEqual(tabs[0].spalten.map((s) => tabs[0].breiten[s]), [96, 40, 2000]);
  assert.deepEqual(tabs[0].weg, []);
  assert.deepEqual(zellText(tabs[1]), [['x', '']]);
  assert.deepEqual(tabs[1].breiten, {}, 'Breiten wie unser Export ohne Breite (9638 / Spalten) bleiben frei');
  assert.equal(new Set(tabs.flatMap((t) => [t.id, ...t.zeilen, ...t.spalten])).size, tabs.reduce((n, t) => n + 1 + t.zeilen.length + t.spalten.length, 0));
  assert.deepEqual(r.fehlte, [{ art: 'bilder', anzahl: 1 }, { art: 'verbunden', anzahl: 1 }, { art: 'verschachtelt', anzahl: 1 }]);
  assert.equal(r.dateien.length, 0, 'Bilder in Zellen werden nicht übernommen');
});

test('Tabellen über 200 Zeilen, 50 Spalten oder 20 000 Zeichen je Zelle werden gekürzt', async () => {
  const zeile = (i) => `<w:tr>${Array.from({ length: 51 }, (_, j) => `<w:tc><w:p><w:r><w:t>${i}.${j}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;
  const gross = `<w:tbl>${Array.from({ length: 201 }, (_, i) => zeile(i)).join('')}</w:tbl>`;
  const r = await docxLesen(await docxAus({ body: gross }));
  const t = r.daten.delta[0].insert.tabelle;
  assert.deepEqual([t.zeilen.length, t.spalten.length], [200, 50]);
  assert.equal(t.zellen[`${t.zeilen[199]}|${t.spalten[49]}`][0].insert, '199.49');
  assert.deepEqual(r.fehlte, [{ art: 'tabellengroesse', anzahl: 1 }]);
  const lang = `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>${'x'.repeat(15000)}</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${'y'.repeat(15000)}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const r2 = await docxLesen(await docxAus({ body: lang }));
  const z = Object.values(r2.daten.delta[0].insert.tabelle.zellen)[0];
  assert.equal(z.map((o) => o.insert).join('').length, 20000);
  assert.deepEqual(z.map((o) => [o.insert.length, o.attributes]), [[15001, undefined], [4999, { fett: true }]]);
  assert.deepEqual(r2.fehlte, [{ art: 'tabellengroesse', anzahl: 1 }]);
  assert.doesNotThrow(() => tabelleWertPruefen(r2.daten.delta[0].insert.tabelle));
});

test('Bilder: eingebettet mit Breite und alt, gleiches Ziel → gleicher Schlüssel, Link, VML, nicht unterstützt oder extern', async () => {
  const zeichnung = (rid, cx, descr = '', art = 'inline', attr = 'r:embed') => `<w:r><w:drawing><wp:${art}><wp:extent cx="${cx}" cy="1"/><wp:docPr id="1" name="x"${descr ? ` descr="${descr}"` : ''}/>`
    + `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:blipFill><a:blip ${attr}="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:${art}></w:drawing></w:r>`;
  const body = `<w:p>${zeichnung('rIdA', 2857500, 'Logo &amp; mehr')}${zeichnung('rIdA', 1)}${zeichnung('rIdJ', 99999999, '', 'anchor')}</w:p>`
    + `<w:p><w:hyperlink r:id="rIdL">${zeichnung('rIdA', 952500, 'x'.repeat(600))}</w:hyperlink></w:p>`
    + '<w:p><w:r><w:pict><v:shape style="position:absolute;width:75pt;height:30pt" alt="Alt VML"><v:imagedata r:id="rIdA" o:title=""/></v:shape></w:pict></w:r><w:r><w:pict><v:rect/></w:pict></w:r></w:p>'
    + `<w:p>${zeichnung('rIdE', 952500)}${zeichnung('rIdK', 952500)}${zeichnung('rIdF', 952500)}${zeichnung('rIdX', 952500)}${zeichnung('rIdA', 952500, '', 'inline', 'r:link')}`
    + `<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="10" name="g"/><a:graphic><a:graphicData uri="${NS.wpg}"><wpg:wgp/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    + `<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="11" name="f"/><a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const rels = [['rIdA', 'image', 'media/image1.png'], ['rIdJ', 'image', '/word/media/foto.JPG'], ['rIdE', 'image', '../word/media/x.emf'], ['rIdK', 'image', 'media/kaputt.png'],
    ['rIdF', 'image', 'media/fehlt.png'], ['rIdX', 'image', 'https://x.de/a.png', true], ['rIdL', 'hyperlink', 'https://fah.de/bild', true]];
  const teile = { 'word/media/image1.png': PNG_2x1, 'word/media/foto.JPG': JPEG_5x6, 'word/media/x.emf': new Uint8Array([1, 0, 0, 0, 1, 2, 3]), 'word/media/kaputt.png': new Uint8Array([1, 2, 3, 4]) };
  const r = await docxLesen(await docxAus({ body, rels, teile }));
  const zeilen = zeilenAus(r.daten.delta);
  assert.deepEqual(laeufeVon(zeilen[0]), [[{ bild: { datei: 'bild1', breite: 300, alt: 'Logo & mehr' } }, {}], [{ bild: { datei: 'bild1', breite: 16 } }, {}], [{ bild: { datei: 'bild2', breite: 2000 } }, {}]]);
  assert.deepEqual(laeufeVon(zeilen[1]), [[{ bild: { datei: 'bild1', breite: 100, alt: 'x'.repeat(500) } }, { link: 'https://fah.de/bild' }]]);
  assert.deepEqual(laeufeVon(zeilen[2]), [[{ bild: { datei: 'bild1', breite: 100, alt: 'Alt VML' } }, {}]]);
  assert.deepEqual(laeufeVon(zeilen[3]), []);
  assert.deepEqual(r.dateien.map((d) => [d.schluessel, d.name, d.blob.type, d.blob.size]), [['bild1', 'bild1.png', 'image/png', PNG_2x1.length], ['bild2', 'bild2.jpg', 'image/jpeg', JPEG_5x6.length]]);
  assert.deepEqual(r.fehlte, [{ art: 'formen', anzahl: 3 }, { art: 'bilder', anzahl: 5 }]);
  assert.doesNotThrow(() => dokumentPruefen(verknuepfeFuerTest(r, (d) => `abcdefghijkl-${d.name}`)));
});

test('kaputt → docx_kaputt, zu groß → zip_zu_gross', async () => {
  await assert.rejects(docxLesen((await zipSchreiben([{ name: 'a.txt', daten: 'x' }])).buffer), /docx_kaputt/);
  await assert.rejects(docxLesen(new Uint8Array(10).buffer), /zip_kaputt/);
  // Zip-Bombe: der Kopf behauptet 2 GiB → Abbruch vor dem Entpacken
  const bombe = await zipSchreiben([{ name: 'word/document.xml', daten: dokXml('<w:p/>') }]);
  const dv = new DataView(bombe.buffer);
  for (let i = 0; i + 4 <= bombe.length; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 0x7fffffff, true);
  await assert.rejects(docxLesen(bombe.buffer), /zip_zu_gross/);
  // Kopf lügt in die andere Richtung (behauptet 100 Byte) → Abbruch beim Entpacken
  const luege = await zipSchreiben([{ name: 'word/document.xml', daten: dokXml('<w:p/>'.repeat(500)) }]);
  const lv = new DataView(luege.buffer);
  assert.equal(lv.getUint32(0, true), 0x04034b50);
  lv.setUint32(22, 100, true);
  for (let i = 0; i + 4 <= luege.length; i++) if (lv.getUint32(i, true) === 0x02014b50) lv.setUint32(i + 24, 100, true);
  await assert.rejects(docxLesen(luege.buffer), /zip_zu_gross/);
  // kein Word-Dokument: Arbeitsmappe, kaputtes XML, zu tief verschachtelt, Wurzel ohne Körper
  const mappe = await zipSchreiben([{ name: '_rels/.rels', daten: relsXml([['rId1', 'officeDocument', 'xl/workbook.xml']]) }, { name: 'xl/workbook.xml', daten: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' }]);
  await assert.rejects(docxLesen(mappe.buffer), /docx_kaputt/);
  await assert.rejects(docxLesen(await docxAus({ dokument: `<w:document xmlns:w="${NS.w}"><w:body><w:p></w:body></w:document>` })), /docx_kaputt/);
  await assert.rejects(docxLesen(await docxAus({ body: `${'<w:sdt><w:sdtContent>'.repeat(200)}${'</w:sdtContent></w:sdt>'.repeat(200)}` })), /docx_kaputt/);
  await assert.rejects(docxLesen(await docxAus({ dokument: '<?xml version="1.0"?><nix/>' })), /docx_kaputt/);
  // DTD-Entität bleibt Text, Dokument ohne _rels/.rels, leeres Dokument → leer()
  const dtd = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "BOOM"><!ENTITY y SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${NS.w}"><w:body><w:p><w:r><w:t>&x;&y;</w:t></w:r></w:p></w:body></w:document>`;
  assert.equal(textVon(await docxLesen(await docxAus({ dokument: dtd, paket: false }))), '&x;&y;\n');
  assert.deepEqual((await docxLesen(await docxAus({ body: '' }))).daten, { delta: [{ insert: '\n' }], kommentare: {} });
  assert.deepEqual((await docxLesen(await docxAus({ dokument: `<w:document xmlns:w="${NS.w}"/>` }))).daten, { delta: [{ insert: '\n' }], kommentare: {} });
});
