// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Export nach Word (Plan 05 Aufgabe 16): Teile und Content-Types, Schema-Reihenfolge und Pflichtteile (Review Focus 4:
// rPr/pPr in Schema-Reihenfolge, jede Zelle mit Absatz, Absatz vor sectPr und zwischen zwei Tabellen, eindeutige rIds,
// abstractNum vor num), Bilder in EMU bzw. als Ersatztext, Absätze und Listen, Läufe mit Formaten und Links, Tabellen
// sowie die Bildmaße aus den Dateiköpfen (PNG, GIF, JPEG, WebP).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D, T2, BILD, PNG_2x1, ZEIT, LINK, lader } from './office_docx_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const laden = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);
const { docxSchreiben, bildMasse, MIME_DOCX } = await laden('office', 'dokument', 'docx.js');
const { zipLesen } = await laden('office', 'format', 'zip.js');
const { xmlLesen, kind, kinder } = await laden('office', 'format', 'xml.js');
const { dokumentPruefen } = await laden('gemeinsam', 'sync', 'typen', 'dokument.js');

const RPR_REIHENFOLGE = ['w:rStyle', 'w:rFonts', 'w:b', 'w:i', 'w:strike', 'w:color', 'w:highlight', 'w:u', 'w:shd'];
const PPR_REIHENFOLGE = ['w:pStyle', 'w:pageBreakBefore', 'w:numPr', 'w:ind', 'w:jc'];
const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

const text = (z, name) => new TextDecoder().decode(z.get(name));
function alle(knoten, name, aus = []) {
  for (const k of knoten.kinder) { if (k.name === name) aus.push(k); alle(k, name, aus); }
  return aus;
}
/** Sichtbarer Text (w:t, w:tab als \t) in Dokumentreihenfolge. */
const absatzText = (k) => (k.name === 'w:t' ? k.text : k.name === 'w:tab' ? '\t' : k.kinder.map(absatzText).join(''));
/** w:val am Ende eines Pfads von Kindern. */
const wert = (k, ...pfad) => { let x = k; for (const n of pfad) x = kind(x, n); return x ? x.attribute['w:val'] : undefined; };
const docx = async (daten, l = lader, o = { titel: 'Bericht', autor: 'Anna', zeit: ZEIT }) => zipLesen(await (await docxSchreiben(daten, l, o)).arrayBuffer());
const relsVon = (z) => kinder(xmlLesen(text(z, 'word/_rels/document.xml.rels')), 'Relationship');

let z; let body; let absaetze; let laeufe;
before(async () => {
  dokumentPruefen(D); // die Testdaten selbst sind ein gültiges Dokument
  z = await docx(D);
  body = kind(xmlLesen(text(z, 'word/document.xml')), 'w:body');
  absaetze = new Map(kinder(body, 'w:p').map((p) => [absatzText(p), p]));
  laeufe = new Map(alle(body, 'w:r').map((r) => [absatzText(r), r]));
});

test('Teile und Content-Types', async () => {
  const blob = await docxSchreiben(D, lader, { titel: 'Bericht', zeit: ZEIT });
  assert.equal(blob.type, MIME_DOCX);
  const z1 = await zipLesen(await blob.arrayBuffer());
  assert.deepEqual([...z1.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/media/bild1.png', 'word/numbering.xml', 'word/styles.xml']);
  assert.equal([...z1.keys()][0], '[Content_Types].xml');
  assert.deepEqual(z1.get('word/media/bild1.png'), PNG_2x1);
  const ct = xmlLesen(text(z1, '[Content_Types].xml'));
  assert.deepEqual(kinder(ct, 'Default').map((d) => d.attribute.Extension).sort(), ['png', 'rels', 'xml']);
  assert.deepEqual(Object.fromEntries(kinder(ct, 'Default').map((d) => [d.attribute.Extension, d.attribute.ContentType])),
    { rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', png: 'image/png' });
  assert.deepEqual(Object.fromEntries(kinder(ct, 'Override').map((o) => [o.attribute.PartName, o.attribute.ContentType])), {
    '/word/document.xml': `${W}.document.main+xml`, '/word/styles.xml': `${W}.styles+xml`, '/word/numbering.xml': `${W}.numbering+xml`,
    '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml', '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  });
  assert.deepEqual(kinder(xmlLesen(text(z1, '_rels/.rels')), 'Relationship').map((r) => [r.attribute.Id, r.attribute.Type.split('/').pop(), r.attribute.Target]),
    [['rId1', 'officeDocument', 'word/document.xml'], ['rId2', 'core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]);
  assert.deepEqual(relsVon(z1).slice(0, 2).map((r) => [r.attribute.Id, r.attribute.Type.split('/').pop(), r.attribute.Target]), [['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml']]);
  const core = xmlLesen(text(z1, 'docProps/core.xml'));
  assert.equal(kind(core, 'dc:title').text, 'Bericht');
  for (const n of ['dcterms:created', 'dcterms:modified']) {
    assert.equal(kind(core, n).text, '2026-10-18T12:34:56Z');
    assert.equal(kind(core, n).attribute['xsi:type'], 'dcterms:W3CDTF');
  }
  assert.equal(kind(xmlLesen(text(z, 'docProps/core.xml')), 'dc:creator').text, 'Anna');
  assert.equal(kind(xmlLesen(text(z1, 'docProps/app.xml')), 'Application').text, 'FAH-NAS Office');
  const wurzel = xmlLesen(text(z1, 'word/document.xml'));
  assert.equal(wurzel.name, 'w:document');
  for (const p of ['w', 'r', 'wp', 'a', 'pic']) assert.ok(wurzel.attribute[`xmlns:${p}`], `Namensraum ${p}`);
});

test('Schema-Reihenfolge und Pflichtteile (Review Focus 4)', async () => {
  for (const rpr of alle(body, 'w:rPr')) assert.deepEqual(rpr.kinder.map((k) => k.name), RPR_REIHENFOLGE.filter((n) => rpr.kinder.some((k) => k.name === n)));
  for (const ppr of alle(body, 'w:pPr')) assert.deepEqual(ppr.kinder.map((k) => k.name), PPR_REIHENFOLGE.filter((n) => ppr.kinder.some((k) => k.name === n)));
  assert.ok(alle(body, 'w:rPr').length > 10 && alle(body, 'w:pPr').length > 10);
  for (const tc of alle(body, 'w:tc')) assert.ok(kinder(tc, 'w:p').length >= 1);
  const namen = body.kinder.map((k) => k.name); assert.equal(namen.at(-1), 'w:sectPr'); assert.equal(namen.at(-2), 'w:p');
  for (let i = 1; i < namen.length; i++) assert.ok(!(namen[i] === 'w:tbl' && namen[i - 1] === 'w:tbl'));
  const rels = relsVon(z); assert.equal(new Set(rels.map((r) => r.attribute.Id)).size, rels.length);
  const num = xmlLesen(text(z, 'word/numbering.xml')).kinder.map((k) => k.name); assert.ok(num.lastIndexOf('w:abstractNum') < num.indexOf('w:num'));
  assert.equal(rels.find((r) => r.attribute.TargetMode === 'External').attribute.Target, 'https://fah.de/a?a=1&b=2');
  // jeder Verweis aus dem Dokument zeigt auf eine vorhandene Beziehung, gleicher Link → dieselbe rId
  const ids = new Set(rels.map((r) => r.attribute.Id));
  for (const h of alle(body, 'w:hyperlink')) assert.ok(ids.has(h.attribute['r:id']));
  for (const b of alle(body, 'a:blip')) assert.ok(ids.has(b.attribute['r:embed']));
  assert.equal(rels.filter((r) => r.attribute.Target === LINK).length, 1);
  assert.ok(rels.filter((r) => r.attribute.TargetMode === 'External').every((r) => r.attribute.Type.endsWith('/hyperlink')));
});

test('Bild: Maße in EMU, fehlende Datei → [Bild: alt]', async () => {
  const ext = alle(body, 'wp:extent')[0];
  assert.deepEqual([ext.attribute.cx, ext.attribute.cy], ['2857500', '1428750']);
  const inline = alle(body, 'wp:inline')[0];
  assert.deepEqual(['distT', 'distB', 'distL', 'distR'].map((k) => inline.attribute[k]), ['0', '0', '0', '0']);
  assert.deepEqual(kind(inline, 'wp:docPr').attribute, { id: '1', name: 'Bild 1', descr: 'Logo' });
  assert.equal(alle(inline, 'a:graphicFrameLocks')[0].attribute.noChangeAspect, '1');
  assert.equal(alle(inline, 'a:fillRect').length, 1); assert.equal(alle(inline, 'a:prstGeom')[0].attribute.prst, 'rect');
  assert.deepEqual([alle(inline, 'a:ext')[0].attribute.cx, alle(inline, 'a:ext')[0].attribute.cy], ['2857500', '1428750']);
  const blip = alle(inline, 'a:blip')[0];
  assert.equal(relsVon(z).find((r) => r.attribute.Id === blip.attribute['r:embed']).attribute.Target, 'media/bild1.png');
  // ohne Breite: natürliche Größe (höchstens 642 px), Höhe nach den Maßen; dieselbe Datei zweimal → ein Medium, eine rId
  const z2 = await docx({ delta: [{ insert: { bild: { datei: BILD } } }, { insert: { bild: { datei: BILD, breite: 100 } } }, { insert: '\n' }], kommentare: {} });
  const b2 = kind(xmlLesen(text(z2, 'word/document.xml')), 'w:body');
  assert.deepEqual(alle(b2, 'wp:extent').map((e) => [e.attribute.cx, e.attribute.cy]), [['19050', '9525'], ['952500', '476250']]);
  assert.deepEqual(alle(b2, 'wp:docPr').map((d) => d.attribute.id), ['1', '2']);
  assert.equal(new Set(alle(b2, 'a:blip').map((b) => b.attribute['r:embed'])).size, 1);
  assert.deepEqual([...z2.keys()].filter((n) => n.startsWith('word/media/')), ['word/media/bild1.png']);
  // Lader liefert nichts (oder ein Format, das er hätte umwandeln müssen) → Ersatztext, kein Medium, kein Bild-Typ
  for (const l of [async () => null, async () => ({ bytes: PNG_2x1, mime: 'image/webp' }), async () => { throw new Error('404'); }]) {
    const z3 = await docx({ delta: [{ insert: 'Vorher ' }, { insert: { bild: { datei: BILD, breite: 300, alt: 'Logo' } } }, { insert: { bild: { datei: 'abcdefghijkm-x.png' } } }, { insert: '\n' }], kommentare: {} }, l);
    const b3 = kind(xmlLesen(text(z3, 'word/document.xml')), 'w:body');
    assert.equal(absatzText(kinder(b3, 'w:p')[0]), 'Vorher [Bild: Logo][Bild]');
    assert.equal(alle(b3, 'w:drawing').length, 0);
    assert.deepEqual([...z3.keys()].filter((n) => n.startsWith('word/media/')), []);
    assert.deepEqual(kinder(xmlLesen(text(z3, '[Content_Types].xml')), 'Default').map((d) => d.attribute.Extension).sort(), ['rels', 'xml']);
  }
  // JPEG: Endung und Content-Type jpeg
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 6, 0, 5, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const z4 = await docx({ delta: [{ insert: { bild: { datei: BILD } } }, { insert: '\n' }], kommentare: {} }, async () => ({ bytes: JPEG.buffer, mime: 'image/jpeg' }));
  assert.ok(z4.has('word/media/bild1.jpeg'));
  assert.equal(kinder(xmlLesen(text(z4, '[Content_Types].xml')), 'Default').find((d) => d.attribute.Extension === 'jpeg').attribute.ContentType, 'image/jpeg');
  assert.deepEqual(alle(kind(xmlLesen(text(z4, 'word/document.xml')), 'w:body'), 'wp:extent').map((e) => [e.attribute.cx, e.attribute.cy]), [['47625', '57150']]);
});

test('Absätze: Stile, Nummerierung je Listenblock neu, Aufgabe als ☐/☑, Einzug 1440, jc both, A4-Seite', async () => {
  const pPr = (t) => { const p = absaetze.get(t); assert.ok(p, `Absatz „${t}“ fehlt`); return kind(p, 'w:pPr'); };
  assert.deepEqual(['Titel', 'Abschnitt', 'Unterabschnitt', 'Zitat'].map((t) => wert(pPr(t), 'w:pStyle')), ['Heading1', 'Heading2', 'Heading3', 'Quote']);
  const liste = (t) => [wert(pPr(t), 'w:pStyle'), wert(pPr(t), 'w:numPr', 'w:ilvl'), wert(pPr(t), 'w:numPr', 'w:numId')];
  assert.deepEqual(liste('Punkt'), ['ListParagraph', '0', '1']);
  assert.deepEqual(liste('Eins'), ['ListParagraph', '0', '2']);
  assert.deepEqual(liste('Unterpunkt'), ['ListParagraph', '1', '2']);
  assert.deepEqual(liste('☑ Erledigt'), ['ListParagraph', '0', '1']);
  assert.deepEqual(liste('☐ Offen'), ['ListParagraph', '0', '1']);
  assert.deepEqual(liste('Zahl'), ['ListParagraph', '0', '3'], 'zweiter Listenblock → neue Nummerierung');
  const haken = kinder(absaetze.get('☑ Erledigt'), 'w:r')[0];
  assert.equal(absatzText(haken), '☑ '); assert.equal(kind(haken, 'w:rPr'), null);
  assert.equal(kind(pPr('Eingerückt'), 'w:ind').attribute['w:left'], '1440');
  assert.equal(kind(pPr('Eins'), 'w:ind'), null, 'Listen rücken über die Nummerierung ein');
  assert.deepEqual(['Blocksatz', 'Mitte', 'Rechts'].map((t) => wert(pPr(t), 'w:jc')), ['both', 'center', 'right']);
  assert.equal(pPr('Ende'), null);
  // Seitenumbruch als eigener Absatz
  const umbruch = kinder(body, 'w:p').find((p) => alle(p, 'w:br').length);
  assert.equal(alle(umbruch, 'w:br')[0].attribute['w:type'], 'page'); assert.equal(absatzText(umbruch), '');
  // Nummerierung: Punkte und Zahlen je 9 Ebenen, num 1 → Punkte, je Zahlen-Block eine neue num mit Neustart
  const num = xmlLesen(text(z, 'word/numbering.xml'));
  const ebenen = Object.fromEntries(kinder(num, 'w:abstractNum').map((a) => [a.attribute['w:abstractNumId'], kinder(a, 'w:lvl')]));
  assert.deepEqual(Object.keys(ebenen), ['0', '1']); assert.equal(ebenen[0].length, 9); assert.equal(ebenen[1].length, 9);
  const einzug = (l) => kind(kind(l, 'w:pPr'), 'w:ind').attribute;
  assert.deepEqual(ebenen[0].slice(0, 4).map((l) => [l.attribute['w:ilvl'], wert(l, 'w:numFmt'), wert(l, 'w:lvlText'), einzug(l)['w:left'], einzug(l)['w:hanging']]),
    [['0', 'bullet', '•', '720', '360'], ['1', 'bullet', '◦', '1440', '360'], ['2', 'bullet', '▪', '2160', '360'], ['3', 'bullet', '•', '2880', '360']]);
  assert.deepEqual(ebenen[1].slice(0, 4).map((l) => [wert(l, 'w:numFmt'), wert(l, 'w:lvlText'), einzug(l)['w:left']]),
    [['decimal', '%1.', '720'], ['lowerLetter', '%2.', '1440'], ['lowerRoman', '%3.', '2160'], ['decimal', '%4.', '2880']]);
  const nums = kinder(num, 'w:num').map((n) => [n.attribute['w:numId'], wert(n, 'w:abstractNumId'), wert(kinder(n, 'w:lvlOverride')[0], 'w:startOverride')]);
  assert.deepEqual(nums, [['1', '0', undefined], ['2', '1', '1'], ['3', '1', '1']]);
  assert.deepEqual(kinder(kinder(num, 'w:num')[1], 'w:lvlOverride')[0].attribute, { 'w:ilvl': '0' });
  // Stile
  const stile = Object.fromEntries(kinder(xmlLesen(text(z, 'word/styles.xml')), 'w:style').map((s) => [s.attribute['w:styleId'], s]));
  for (const id of ['Normal', 'Heading1', 'Heading2', 'Heading3', 'ListParagraph', 'Quote', 'Hyperlink', 'Code', 'TableGrid']) assert.ok(stile[id], `Stil ${id}`);
  assert.deepEqual([1, 2, 3].map((n) => [wert(stile[`Heading${n}`], 'w:name'), wert(stile[`Heading${n}`], 'w:basedOn'), wert(stile[`Heading${n}`], 'w:rPr', 'w:sz'), wert(stile[`Heading${n}`], 'w:pPr', 'w:outlineLvl')]),
    [['heading 1', 'Normal', '32', '0'], ['heading 2', 'Normal', '28', '1'], ['heading 3', 'Normal', '24', '2']]);
  assert.equal(stile.Normal.attribute['w:default'], '1');
  assert.deepEqual([stile.Hyperlink.attribute['w:type'], stile.Code.attribute['w:type'], stile.TableGrid.attribute['w:type']], ['character', 'character', 'table']);
  assert.equal(wert(stile.Quote, 'w:name'), 'Quote'); assert.equal(wert(stile.ListParagraph, 'w:name'), 'List Paragraph');
  // Seite: A4 mit 20 mm Rand
  const sect = kind(body, 'w:sectPr');
  assert.deepEqual(kind(sect, 'w:pgSz').attribute, { 'w:w': '11906', 'w:h': '16838' });
  assert.deepEqual(kind(sect, 'w:pgMar').attribute, { 'w:top': '1134', 'w:right': '1134', 'w:bottom': '1134', 'w:left': '1134', 'w:header': '709', 'w:footer': '709', 'w:gutter': '0' });
});

test('Läufe: Formate, Farben in HEX, Links teilen ein w:hyperlink, Tab und Sonderzeichen, Kommentar nicht exportiert', async () => {
  const rpr = (t) => { const r = laeufe.get(t); assert.ok(r, `Lauf „${t}“ fehlt`); return kind(r, 'w:rPr'); };
  const namen = (t) => (rpr(t) ? rpr(t).kinder.map((k) => k.name) : []);
  assert.deepEqual(namen('fett'), ['w:b']); assert.deepEqual(namen('kursiv'), ['w:i']); assert.deepEqual(namen('durch'), ['w:strike']);
  assert.equal(wert(rpr('unter'), 'w:u'), 'single'); assert.equal(wert(rpr('code'), 'w:rStyle'), 'Code');
  assert.equal(wert(rpr('rot'), 'w:color'), 'B42318'); assert.equal(wert(rpr('eigen'), 'w:color'), '123456');
  assert.deepEqual(kind(rpr('gelb'), 'w:shd').attribute, { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': 'FFF3A3' });
  assert.equal(kind(rpr('hell'), 'w:shd').attribute['w:fill'], 'ABCDEF');
  assert.deepEqual(namen('alles'), ['w:b', 'w:i', 'w:strike', 'w:color', 'w:u', 'w:shd']);
  assert.equal(wert(rpr('alles'), 'w:color'), '1D4ED8'); assert.equal(kind(rpr('alles'), 'w:shd').attribute['w:fill'], 'FBD3E4');
  assert.deepEqual(namen('kommentiert'), []);
  // Links
  const links = alle(body, 'w:hyperlink');
  const ziel = new Map(relsVon(z).map((r) => [r.attribute.Id, r.attribute.Target]));
  assert.deepEqual(links.map((h) => [ziel.get(h.attribute['r:id']), absatzText(h)]), [[LINK, 'Link'], ['mailto:info@fah.de', 'Mail'], [LINK, 'Code-Link'], ['https://fah.de/t', 'Web']]);
  assert.equal(kinder(links[0], 'w:r').length, 2, 'aufeinanderfolgende Läufe mit gleichem Link teilen ein w:hyperlink');
  assert.equal(links[0].attribute['r:id'], links[2].attribute['r:id']);
  assert.deepEqual(namen('nk'), ['w:rStyle', 'w:b']); assert.equal(wert(rpr('Li'), 'w:rStyle'), 'Hyperlink');
  assert.deepEqual(namen('Code-Link'), ['w:rStyle', 'w:rFonts']); assert.equal(wert(rpr('Code-Link'), 'w:rStyle'), 'Hyperlink');
  assert.equal(kind(rpr('Code-Link'), 'w:rFonts').attribute['w:ascii'], 'Consolas');
  // Tab, Sonderzeichen, Emoji, Leerzeichen bleiben
  const tab = laeufe.get('Tab\tund <&> 😀');
  assert.deepEqual(tab.kinder.map((k) => k.name), ['w:t', 'w:tab', 'w:t']);
  assert.ok(kinder(tab, 'w:t').every((t) => t.attribute['xml:space'] === 'preserve'));
  assert.ok(text(z, 'word/document.xml').includes('und &lt;&amp;&gt; 😀'));
  assert.equal(laeufe.get('Normal ').kinder[0].text, 'Normal ');
});

test('Tabellen: Gitter und Breiten, Zellabsätze, Grabsteine fehlen, Absatz zwischen und hinter Tabellen', async () => {
  const [t1, t2] = kinder(body, 'w:tbl');
  const tblPr = kind(t1, 'w:tblPr');
  assert.deepEqual(tblPr.kinder.map((k) => k.name), ['w:tblStyle', 'w:tblW', 'w:tblLook']);
  assert.equal(wert(tblPr, 'w:tblStyle'), 'TableGrid'); assert.equal(kind(tblPr, 'w:tblW').attribute['w:type'], 'auto');
  assert.deepEqual(kinder(kind(t1, 'w:tblGrid'), 'w:gridCol').map((g) => g.attribute['w:w']), ['3000', '4819']);
  const zeilen = kinder(t1, 'w:tr');
  assert.deepEqual(zeilen.map((tr) => kinder(tr, 'w:tc').map((tc) => kinder(tc, 'w:p').map(absatzText))), [[['Kopf'], ['B1']], [['Zeile', 'zwei'], ['Web']]]);
  assert.deepEqual(kinder(zeilen[0], 'w:tc').map((tc) => kind(kind(tc, 'w:tcPr'), 'w:tcW').attribute), [{ 'w:w': '3000', 'w:type': 'dxa' }, { 'w:w': '4819', 'w:type': 'dxa' }]);
  assert.deepEqual(alle(kinder(zeilen[0], 'w:tc')[0], 'w:rPr')[0].kinder.map((k) => k.name), ['w:b']);
  assert.deepEqual(kinder(kind(t2, 'w:tblGrid'), 'w:gridCol').map((g) => g.attribute['w:w']), ['4819', '4819']);
  assert.deepEqual(kinder(t2, 'w:tr').map((tr) => kinder(tr, 'w:tc').map((tc) => kinder(tc, 'w:p').map(absatzText))), [[['x'], ['']], [[''], ['y']]]);
  const namen = body.kinder.map((k) => k.name); const i = namen.indexOf('w:tbl');
  assert.deepEqual(namen.slice(i, i + 3), ['w:tbl', 'w:p', 'w:tbl']); assert.equal(kinder(body, 'w:p')[namen.slice(0, i + 1).filter((n) => n === 'w:p').length].kinder.length, 0);
  // Dokument endet mit einer Tabelle → leerer Absatz vor sectPr; Tabelle ohne sichtbare Zeilen → nur ein leerer Absatz
  const z5 = await docx({ delta: [{ insert: { tabelle: T2 } }, { insert: '\n' }], kommentare: {} });
  assert.deepEqual(kind(xmlLesen(text(z5, 'word/document.xml')), 'w:body').kinder.map((k) => k.name), ['w:tbl', 'w:p', 'w:sectPr']);
  const z6 = await docx({ delta: [{ insert: { tabelle: { ...T2, weg: ['zeileA2', 'zeileB2'], zellen: {} } } }, { insert: '\n' }], kommentare: {} });
  assert.deepEqual(kind(xmlLesen(text(z6, 'word/document.xml')), 'w:body').kinder.map((k) => k.name), ['w:p', 'w:sectPr']);
});

test('bildMasse', () => {
  assert.deepEqual(bildMasse(PNG_2x1), { breite: 2, hoehe: 1 });
  assert.deepEqual(bildMasse(PNG_2x1.buffer), { breite: 2, hoehe: 1 });
  assert.deepEqual(bildMasse(new Uint8Array([...Buffer.from('GIF89a'), 3, 0, 4, 0, 0x80, 0, 0])), { breite: 3, hoehe: 4 });
  // JPEG: APP0, dann eine Huffman-Tabelle (C4 ist kein SOF), dann SOF0 mit Höhe 6 und Breite 5
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc4, 0, 4, 0xff, 0xc0, 0xff, 0xc0, 0, 11, 8, 0, 6, 0, 5, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(bildMasse(jpeg), { breite: 5, hoehe: 6 });
  const riff = (art, daten) => new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(art), 10, 0, 0, 0, ...daten, 0, 0, 0, 0]);
  assert.deepEqual(bildMasse(riff('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0])), { breite: 640, hoehe: 480 });
  assert.deepEqual(bildMasse(riff('VP8L', [0x2f, 0x06, 0x00, 0x02, 0x00, 0, 0, 0, 0, 0])), { breite: 7, hoehe: 9 });
  assert.deepEqual(bildMasse(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 11, 0, 13, 0])), { breite: 11, hoehe: 13 });
  for (const unsinn of [new Uint8Array([1, 2, 3]), new Uint8Array(0), PNG_2x1.slice(0, 20), new Uint8Array([...Buffer.from('GIF89a'), 0, 0, 4, 0]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0]), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), riff('VP8 ', [0, 0, 0, 1, 2, 3, 11, 0, 13, 0]), 'text', null]) {
    assert.equal(bildMasse(unsinn), null);
  }
});
