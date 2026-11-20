// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Word (.docx) für das Office-Dokument (Plan 05). Schreiben: Modell → WordprocessingML mit festen Stilen (Überschrift
// 1–3, Listenabsatz, Zitat, Hyperlink, Code, Tabellengitter), Nummerierung je Listenblock, Seite A4 mit 20 mm Rand.
// Damit Word, LibreOffice und Pages die Datei ohne Reparatur öffnen: Kinder von rPr/pPr in Schema-Reihenfolge, jede
// Zelle mit Absatz, ein Absatz vor sectPr und zwischen zwei Tabellen, eindeutige rIds, abstractNum vor num, für jede
// Medienendung ein Content-Type. Kommentare werden nicht exportiert; Aufgaben werden zu ☐/☑ vor dem Text (Word kennt
// keine Aufgabenliste ohne Inhaltssteuerelemente).
// Lesen: fremde .docx → Modell. Präfixe werden auf die Standard-Namensräume gebracht, Stile und Nummerierung aufgelöst;
// Unbekanntes fällt weg und wird je Art gezählt (fehlte). Fremde Dateien werden nie ausgewertet: externe Ziele (Bilder,
// Links) werden nie geladen, Links nur http/https/mailto, keine DTD; Zip-Bomben fängt zipLesen ab. Fehler:
// Error('docx_kaputt') bzw. die Fehler von zipLesen.

import { zipSchreiben, zipLesen } from '../format/zip.js';
import { xmlEscape, xmlLesen, kind, kinder } from '../format/xml.js';
import { zeilenAus } from './modell.js';
import { normalisieren } from '../../gemeinsam/sync/delta.js';
import { FARBEN, HINTERGRUENDE, linkErlaubt, farbeNormal, neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { zellKey, sichtbareZeilen, sichtbareSpalten } from '../../gemeinsam/sync/typen/dokument-tabelle.js';

export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const RPR_REIHENFOLGE = Object.freeze(['w:rStyle', 'w:rFonts', 'w:b', 'w:i', 'w:strike', 'w:color', 'w:highlight', 'w:u', 'w:shd']);
const PPR_REIHENFOLGE = Object.freeze(['w:pStyle', 'w:pageBreakBefore', 'w:numPr', 'w:ind', 'w:jc']);

const NS = Object.freeze({
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
});
const REL = `${NS.r}`;
const REL_TYP = Object.freeze({
  dokument: `${REL}/officeDocument`, stile: `${REL}/styles`, nummern: `${REL}/numbering`, bild: `${REL}/image`, link: `${REL}/hyperlink`,
  app: `${REL}/extended-properties`, core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
});
const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

// Maße: 1 px = 9525 EMU = 15 twips; Inhaltsbreite 642 px = 9638 twips (A4 11906 − 2 × 1134); Einzug 720 twips je Stufe
const EMU_PX = 9525;
const TWIPS_PX = 15;
const INHALT_PX = 642;
const INHALT_TWIPS = 9638;
const EINZUG_TWIPS = 720;
const TABELLE_MAX = Object.freeze({ zeilen: 200, spalten: 50 }); // wie die Editor-Oberfläche

const KOPF = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const x = xmlEscape;
const LISTEN = Object.freeze(['punkte', 'zahlen', 'aufgabe']);
const JC = Object.freeze({ mitte: 'center', rechts: 'right', block: 'both' });
const BILD_ENDUNG = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif' });
const PUNKTE = Object.freeze(['•', '◦', '▪']);
const ZAHLFORMATE = Object.freeze(['decimal', 'lowerLetter', 'lowerRoman']);

const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
const eigen = (o, k) => (istObjekt(o) && Object.hasOwn(o, k) ? o[k] : undefined);

function bytesVon(daten) {
  if (daten instanceof Uint8Array) return daten;
  if (daten instanceof ArrayBuffer) return new Uint8Array(daten);
  if (ArrayBuffer.isView(daten)) return new Uint8Array(daten.buffer, daten.byteOffset, daten.byteLength);
  return null;
}

// ---- Bildmaße --------------------------------------------------------------------------------------------------------

/** Format und Pixelmaße aus dem Dateikopf (PNG, GIF, JPEG, WebP) → {format, breite, hoehe} | null. */
function bildKopf(bytes) {
  const b = bytesVon(bytes);
  if (!b) return null;
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const be32 = (i) => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (format, breite, hoehe) => (breite > 0 && hoehe > 0 ? { format, breite, hoehe } : null);
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') return ok('png', be32(16), be32(20));
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return ok('gif', le16(6), le16(8));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Segmente bis zum ersten SOF (C0–CF außer C4 Huffman, C8 reserviert, CC arithmetisch)
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i += 1; continue; } // Füllbyte
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // ohne Länge
      if (m === 0xd9 || m === 0xda) return null; // Ende bzw. Bilddaten ohne SOF davor
      const laenge = be16(i + 2);
      if (laenge < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 8 < b.length ? ok('jpeg', be16(i + 7), be16(i + 5)) : null;
      i += 2 + laenge;
    }
    return null;
  }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const art = ascii(12, 4);
    if (art === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok('webp', le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (art === 'VP8L' && b[20] === 0x2f) return ok('webp', 1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (art === 'VP8X') return ok('webp', 1 + le24(24), 1 + le24(27));
  }
  return null;
}

/** Pixelmaße aus dem Dateikopf (PNG IHDR, GIF, JPEG SOF0–SOF15 ohne C4/C8/CC, WebP VP8/VP8L/VP8X) → {breite, hoehe} | null. */
export function bildMasse(bytes) {
  const k = bildKopf(bytes);
  return k ? { breite: k.breite, hoehe: k.hoehe } : null;
}

// ---- Schreiben: feste Teile ------------------------------------------------------------------------------------------

/** Kinder in Schema-Reihenfolge: {name: xml} → xml. */
function geordnet(teile, reihenfolge) { return reihenfolge.filter((n) => teile[n]).map((n) => teile[n]).join(''); }

const RAND = `<w:top w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>`
  + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>'
  + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>';
const ueberschrift = (n, sz) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
  + `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;

const STILE = `${KOPF}<w:styles xmlns:w="${NS.w}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + ueberschrift(1, 32) + ueberschrift(2, 28) + ueberschrift(3, 24)
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="1D4ED8"/><w:u w:val="single"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>'
  + '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${RAND}</w:tblBorders></w:tblPr></w:style>`
  + '</w:styles>';

const PAKET_RELS = `${KOPF}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="${REL_TYP.dokument}" Target="word/document.xml"/>`
  + `<Relationship Id="rId2" Type="${REL_TYP.core}" Target="docProps/core.xml"/>`
  + `<Relationship Id="rId3" Type="${REL_TYP.app}" Target="docProps/app.xml"/></Relationships>`;

const APP = `${KOPF}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>FAH-NAS Office</Application></Properties>`;

function coreXml(titel, autor, zeit) {
  const d = zeit instanceof Date && !Number.isNaN(zeit.getTime()) ? zeit : new Date();
  const iso = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${KOPF}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + (titel ? `<dc:title>${x(titel)}</dc:title>` : '') + (autor ? `<dc:creator>${x(autor)}</dc:creator>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
}

function typenXml(endungen) {
  return `${KOPF}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + endungen.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
    + `<Override PartName="/word/document.xml" ContentType="${WML}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${WML}.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="${WML}.numbering+xml"/>`
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
}

/** Nummerierung: abstractNum 0 Punkte, 1 Zahlen (je 9 Ebenen), num 1 → Punkte, num 2…höchste → Zahlen mit Neustart. */
function nummernXml(hoechste) {
  const ebene = (l, format, text) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${x(text)}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${EINZUG_TWIPS * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const neun = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  let s = `${KOPF}<w:numbering xmlns:w="${NS.w}">`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${neun.map((l) => ebene(l, 'bullet', PUNKTE[l % 3])).join('')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${neun.map((l) => ebene(l, ZAHLFORMATE[l % 3], `%${l + 1}.`)).join('')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  // Neustart auf allen Ebenen: ein Block, der mit einer Unterebene beginnt, zählt sonst beim vorigen Block weiter
  const neustart = neun.map((l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
  for (let n = 2; n <= hoechste; n++) s += `<w:num w:numId="${n}"><w:abstractNumId w:val="1"/>${neustart}</w:num>`;
  return `${s}</w:numbering>`;
}

// ---- Schreiben: Inhalt -----------------------------------------------------------------------------------------------

/** Farbe aus Palette oder #rrggbb → RRGGBB; sonst null. */
function hexVon(wert, palette) {
  const w = typeof wert === 'string' ? (Object.hasOwn(palette, wert) ? palette[wert] : wert) : null;
  return w && /^#[0-9a-f]{6}$/i.test(w) ? w.slice(1).toUpperCase() : null;
}

const linkVon = (a) => (a && typeof a.link === 'string' && linkErlaubt(a.link) ? a.link : null);

function rPrXml(a) {
  const t = {};
  const link = linkVon(a);
  if (link) t['w:rStyle'] = '<w:rStyle w:val="Hyperlink"/>';
  else if (a.code === true) t['w:rStyle'] = '<w:rStyle w:val="Code"/>';
  if (link && a.code === true) t['w:rFonts'] = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
  if (a.fett === true) t['w:b'] = '<w:b/>';
  if (a.kursiv === true) t['w:i'] = '<w:i/>';
  if (a.durchgestrichen === true) t['w:strike'] = '<w:strike/>';
  const farbe = hexVon(a.farbe, FARBEN);
  if (farbe) t['w:color'] = `<w:color w:val="${farbe}"/>`;
  if (a.unterstrichen === true) t['w:u'] = '<w:u w:val="single"/>';
  const hg = hexVon(a.hintergrund, HINTERGRUENDE);
  if (hg) t['w:shd'] = `<w:shd w:val="clear" w:color="auto" w:fill="${hg}"/>`;
  const innen = geordnet(t, RPR_REIHENFOLGE);
  return innen ? `<w:rPr>${innen}</w:rPr>` : '';
}

/** Text eines Laufs: Tabs als w:tab, Wagenrücklauf fällt weg. */
function textXml(s) {
  return s.replace(/\r/g, '').split('\t').map((teil) => (teil ? `<w:t xml:space="preserve">${x(teil)}</w:t>` : '')).join('<w:tab/>');
}

function bildXml(wert, a, kx) {
  const b = kx.bilder.get(wert.datei);
  const alt = typeof wert.alt === 'string' ? wert.alt : '';
  if (!b) return `<w:r>${rPrXml(a)}<w:t xml:space="preserve">${x(alt ? `[Bild: ${alt}]` : '[Bild]')}</w:t></w:r>`;
  const n = ++kx.zeichnungen;
  const rid = kx.rel(REL_TYP.bild, b.ziel);
  const breite = Number.isInteger(wert.breite) && wert.breite > 0 ? wert.breite : Math.min(b.masse ? b.masse.breite : INHALT_PX, INHALT_PX);
  const cx = breite * EMU_PX;
  const cy = b.masse ? Math.max(1, Math.round((cx * b.masse.hoehe) / b.masse.breite)) : cx; // ohne Maße quadratisch
  const descr = alt ? ` descr="${x(alt)}"` : '';
  return `<w:r>${rPrXml(a)}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${n}" name="Bild ${n}"${descr}/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${x(b.name)}"${descr}/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

/** Ein Lauf (Text, Bild, Seitenumbruch); Tabellen setzt der Aufrufer als Block. */
function laufXml(op, kx) {
  const a = istObjekt(op.attributes) ? op.attributes : {};
  if (typeof op.insert === 'string') { const t = textXml(op.insert); return t ? `<w:r>${rPrXml(a)}${t}</w:r>` : ''; }
  if (!istObjekt(op.insert)) return '';
  if (istObjekt(op.insert.bild) && typeof op.insert.bild.datei === 'string') return bildXml(op.insert.bild, a, kx);
  if (op.insert.seitenumbruch === true) return '<w:r><w:br w:type="page"/></w:r>';
  return '';
}

/** Läufe eines Absatzes; aufeinanderfolgende Läufe mit gleichem Link teilen ein w:hyperlink. */
function laeufeXml(ops, kx) {
  let aus = ''; let offen = null;
  for (const op of ops) {
    const l = linkVon(op.attributes);
    if (l !== offen) {
      if (offen) aus += '</w:hyperlink>';
      if (l) aus += `<w:hyperlink r:id="${kx.rel(REL_TYP.link, l, true)}" w:history="1">`;
      offen = l;
    }
    aus += laufXml(op, kx);
  }
  return offen ? `${aus}</w:hyperlink>` : aus;
}

function pPrXml(attr, numId) {
  const t = {};
  const liste = LISTEN.includes(attr.liste) && numId ? attr.liste : null;
  const einzug = Number.isInteger(attr.einzug) && attr.einzug >= 1 && attr.einzug <= 8 ? attr.einzug : 0;
  if ([1, 2, 3].includes(attr.ueberschrift)) t['w:pStyle'] = `<w:pStyle w:val="Heading${attr.ueberschrift}"/>`;
  else if (attr.zitat === true) t['w:pStyle'] = '<w:pStyle w:val="Quote"/>';
  else if (liste) t['w:pStyle'] = '<w:pStyle w:val="ListParagraph"/>';
  if (liste) t['w:numPr'] = `<w:numPr><w:ilvl w:val="${einzug}"/><w:numId w:val="${numId}"/></w:numPr>`;
  else if (einzug) t['w:ind'] = `<w:ind w:left="${EINZUG_TWIPS * einzug}"/>`;
  if (Object.hasOwn(JC, attr.ausrichtung)) t['w:jc'] = `<w:jc w:val="${JC[attr.ausrichtung]}"/>`;
  const innen = geordnet(t, PPR_REIHENFOLGE);
  return innen ? `<w:pPr>${innen}</w:pPr>` : '';
}

/** Zellinhalt → je Zellzeile ein w:p (auch leer, mindestens einer). */
function zellAbsaetze(delta, kx) {
  const absaetze = [[]];
  for (const op of Array.isArray(delta) ? delta : []) {
    if (!op || typeof op.insert !== 'string') continue;
    op.insert.split('\n').forEach((t, i) => {
      if (i > 0) absaetze.push([]);
      if (t) absaetze[absaetze.length - 1].push(op.attributes ? { insert: t, attributes: op.attributes } : { insert: t });
    });
  }
  return absaetze.map((ops) => `<w:p>${laeufeXml(ops, kx)}</w:p>`).join('');
}

/** Tabelle → w:tbl (sichtbare Zeilen/Spalten, höchstens 200 × 50); ohne sichtbare Zelle → null. */
function tabelleXml(wert, kx) {
  if (!istObjekt(wert) || !Array.isArray(wert.zeilen) || !Array.isArray(wert.spalten)) return null;
  const w = { ...wert, weg: Array.isArray(wert.weg) ? wert.weg : [] };
  const zeilen = sichtbareZeilen(w).slice(0, TABELLE_MAX.zeilen);
  const spalten = sichtbareSpalten(w).slice(0, TABELLE_MAX.spalten);
  if (!zeilen.length || !spalten.length) return null;
  const breiten = spalten.map((s) => {
    const px = eigen(wert.breiten, s);
    return Number.isInteger(px) && px > 0 ? px * TWIPS_PX : Math.floor(INHALT_TWIPS / spalten.length);
  });
  let aus = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>'
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + `<w:tblGrid>${breiten.map((b) => `<w:gridCol w:w="${b}"/>`).join('')}</w:tblGrid>`;
  for (const z of zeilen) {
    aus += '<w:tr>';
    spalten.forEach((s, j) => {
      aus += `<w:tc><w:tcPr><w:tcW w:w="${breiten[j]}" w:type="dxa"/></w:tcPr>${zellAbsaetze(eigen(wert.zellen, zellKey(z, s)), kx)}</w:tc>`;
    });
    aus += '</w:tr>';
  }
  return `${aus}</w:tbl>`;
}

const istTabelle = (op) => istObjekt(op.insert) && Object.hasOwn(op.insert, 'tabelle');

/** Eine Zeile des Modells → Körper-Elemente [{art:'p'|'tbl', xml}]. */
function zeileXml(zeile, numId, kx) {
  if (zeile.block === 'seitenumbruch') return [{ art: 'p', xml: '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }];
  const attr = zeile.attribute || {};
  const ppr = pPrXml(attr, numId);
  // Tabellen stehen eigentlich allein in ihrer Zeile; steht doch Text daneben, wird die Zeile an der Tabelle geteilt
  const stuecke = [[]];
  for (const op of zeile.inhalt) {
    if (istTabelle(op)) stuecke.push(op, []); else stuecke[stuecke.length - 1].push(op);
  }
  const aus = [];
  let erster = true;
  stuecke.forEach((st) => {
    if (!Array.isArray(st)) { const t = tabelleXml(st.insert.tabelle, kx); aus.push(t ? { art: 'tbl', xml: t } : { art: 'p', xml: '<w:p/>' }); return; }
    if (!st.length && stuecke.length > 1) return; // leere Ränder neben einer Tabelle
    let laeufe = '';
    if (erster && attr.liste === 'aufgabe' && numId) laeufe += `<w:r><w:t xml:space="preserve">${attr.erledigt === true ? '☑ ' : '☐ '}</w:t></w:r>`;
    erster = false;
    laeufe += laeufeXml(st, kx);
    aus.push({ art: 'p', xml: `<w:p>${ppr}${laeufe}</w:p>` });
  });
  return aus;
}

const istListe = (z) => !z.block && LISTEN.includes((z.attribute || {}).liste);

/** numId je Zeile: Punkte und Aufgaben → 1, Zahlen → je Listenblock (größte Folge von Listenzeilen) eine neue num ab 2. */
function nummernVergeben(zeilen) {
  const ids = new Array(zeilen.length).fill(0);
  let naechste = 2;
  let i = 0;
  while (i < zeilen.length) {
    if (!istListe(zeilen[i])) { i++; continue; }
    let ende = i;
    while (ende < zeilen.length && istListe(zeilen[ende])) ende++;
    const zahlen = zeilen.slice(i, ende).some((z) => z.attribute.liste === 'zahlen') ? naechste++ : 0;
    for (let j = i; j < ende; j++) ids[j] = zeilen[j].attribute.liste === 'zahlen' ? zahlen : 1;
    i = ende;
  }
  return { ids, hoechste: naechste - 1 };
}

/**
 * Dokument → .docx (Blob). `dateiLader(datei)` → {bytes, mime} | null liefert die Bilder (PNG, JPEG, GIF; WebP wandelt
 * der Lader vorher in PNG); fehlt ein Bild, steht „[Bild: alt]“ im Text.
 */
export async function docxSchreiben(daten, dateiLader, { titel = '', autor = '', zeit = new Date() } = {}) {
  const delta = daten && Array.isArray(daten.delta) && daten.delta.length ? daten.delta : [{ insert: '\n' }];
  const zeilen = zeilenAus(delta);

  // Bilder vorab laden – je Datei einmal; rIds vergibt danach das Schreiben in Dokumentreihenfolge
  const bilder = new Map(); const medien = [];
  for (const op of delta) {
    const b = op && istObjekt(op.insert) ? op.insert.bild : null;
    if (!istObjekt(b) || typeof b.datei !== 'string' || bilder.has(b.datei)) continue;
    let r = null;
    try { r = typeof dateiLader === 'function' ? await dateiLader(b.datei) : null; } catch { r = null; }
    const bytes = r ? bytesVon(r.bytes) : null;
    const mime = r && typeof r.mime === 'string' ? r.mime.toLowerCase() : '';
    const endung = Object.hasOwn(BILD_ENDUNG, mime) ? BILD_ENDUNG[mime] : undefined;
    if (!bytes || !bytes.length || !endung) { bilder.set(b.datei, null); continue; }
    const name = `bild${medien.length + 1}.${endung}`;
    medien.push({ name: `word/media/${name}`, daten: bytes, endung });
    bilder.set(b.datei, { ziel: `media/${name}`, name, masse: bildMasse(bytes) });
  }

  const rels = [['rId1', REL_TYP.stile, 'styles.xml', false], ['rId2', REL_TYP.nummern, 'numbering.xml', false]];
  const relIds = new Map();
  const kx = {
    bilder,
    zeichnungen: 0,
    rel(typ, ziel, extern = false) {
      const k = `${typ}|${ziel}`;
      if (!relIds.has(k)) { relIds.set(k, `rId${rels.length + 1}`); rels.push([relIds.get(k), typ, ziel, extern]); }
      return relIds.get(k);
    },
  };

  const { ids, hoechste } = nummernVergeben(zeilen);
  const elemente = [];
  zeilen.forEach((z, i) => { elemente.push(...zeileXml(z, ids[i], kx)); });
  // Word verlangt einen Absatz zwischen zwei Tabellen und vor sectPr
  let koerper = '';
  elemente.forEach((e, i) => { if (e.art === 'tbl' && i > 0 && elemente[i - 1].art === 'tbl') koerper += '<w:p/>'; koerper += e.xml; });
  if (!elemente.length || elemente[elemente.length - 1].art === 'tbl') koerper += '<w:p/>';
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
  const dokument = `${KOPF}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>${koerper}${sectPr}</w:body></w:document>`;
  const dokRels = `${KOPF}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map(([id, typ, ziel, extern]) => `<Relationship Id="${id}" Type="${typ}" Target="${x(ziel)}"${extern ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';

  const eintraege = [
    { name: '[Content_Types].xml', daten: typenXml([...new Set(medien.map((m) => m.endung))]) },
    { name: '_rels/.rels', daten: PAKET_RELS },
    { name: 'docProps/core.xml', daten: coreXml(String(titel || ''), String(autor || ''), zeit) },
    { name: 'docProps/app.xml', daten: APP },
    { name: 'word/document.xml', daten: dokument },
    { name: 'word/_rels/document.xml.rels', daten: dokRels },
    { name: 'word/styles.xml', daten: STILE },
    { name: 'word/numbering.xml', daten: nummernXml(hoechste) },
    ...medien.map((m) => ({ name: m.name, daten: m.daten })),
  ];
  return new Blob([await zipSchreiben(eintraege, { zeit })], { type: MIME_DOCX });
}

// ---- Lesen: Paket, Namensräume, Beziehungen --------------------------------------------------------------------------

/** Was beim Import nicht übernommen wurde, in der Reihenfolge der Ausgabe. */
export const FEHLTE_ARTEN = Object.freeze(['kopfzeilen', 'fussnoten', 'kommentare', 'diagramme', 'formen', 'textfelder', 'felder', 'formeln', 'objekte', 'bilder', 'verbunden', 'verschachtelt', 'tabellengroesse']);

/** Namensraum-URI (Transitional und Strict) → Kurzname, unter dem der Import die Elemente erwartet. */
const NS_KURZ = new Map([
  [NS.w, 'w'], ['http://purl.oclc.org/ooxml/wordprocessingml/main', 'w'],
  [NS.r, 'r'], ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'r'],
  [NS.wp, 'wp'], ['http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing', 'wp'],
  [NS.a, 'a'], ['http://purl.oclc.org/ooxml/drawingml/main', 'a'],
  [NS.pic, 'pic'], ['http://purl.oclc.org/ooxml/drawingml/picture', 'pic'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
  ['http://schemas.microsoft.com/office/word/2010/wordprocessingShape', 'wps'],
  ['urn:schemas-microsoft-com:vml', 'v'],
  ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'c'], ['http://purl.oclc.org/ooxml/drawingml/chart', 'c'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'm'], ['http://purl.oclc.org/ooxml/officeDocument/math', 'm'],
]);

const UEBERSCHRIFT = /^(heading|überschrift|berschrift|titre|titolo|kop)([1-9])$/;
const ZITAT = /^(quote|zitat|intensequote|intensiveszitat|intensivesanführungszeichen)$/;
const LINKSTIL = /^(hyperlink|followedhyperlink|internetlink|internetverknüpfung|besuchteinternetverknüpfung|visitedinternetlink)$/;
const MONO = new Set(['consolas', 'courier new', 'courier', 'menlo', 'monaco', 'lucida console', 'source code pro']);
const MARKIERUNG = new Map([['yellow', 'gelb'], ['green', 'gruen'], ['cyan', 'tuerkis'], ['magenta', 'rosa'], ['lightGray', 'grau'], ['blue', 'blau'], ['darkYellow', 'orange']]);
const AUSRICHTUNG = new Map([['center', 'mitte'], ['right', 'rechts'], ['end', 'rechts'], ['both', 'block'], ['distribute', 'block']]);
const AUS = new Set(['0', 'false', 'off']);
const BILD_DATEI = /\.(png|jpe?g|gif|webp)$/i;
const AUFGABE = /^([☐☑☒])[ \t]/;
const ZELLE_MAX = 20000;
const ALT_MAX = 500;
const SEITE = Symbol('seitenumbruch');

const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const val = (k) => (k ? k.attribute['w:val'] : undefined);
/** An/aus-Eigenschaft: vorhanden und nicht 0/false/off. */
const an = (k) => !!k && !AUS.has(String(val(k) ?? '').toLowerCase());
const ganz = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const begrenzt = (n, min, max) => Math.min(max, Math.max(min, n));
/** Auf n UTF-16-Zeichen kürzen, ohne ein Ersatzpaar zu teilen. */
const gekuerzt = (s, n) => { const t = s.slice(0, n); return /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t; };

/** Maß in twips (Zahl oder mit Einheit mm, cm, in, pt, pc, pi) → Zahl | null. */
function twips(v) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|in|pt|pc|pi)?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const faktor = { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 };
  return Number(m[1]) * (m[2] ? faktor[m[2]] : 1);
}

/** Erster Nachfahre mit diesem Namen (Tiefensuche) oder null. */
function finde(knoten, name) {
  for (const k of knoten ? knoten.kinder : []) {
    if (k.name === name) return k;
    const t = finde(k, name);
    if (t) return t;
  }
  return null;
}

/**
 * Präfixe auf die Kurznamen der Standard-Namensräume bringen (rekursiv, xmlns-Angaben gelten für ihren Teilbaum);
 * Elemente und Attribute fremder Namensräume bekommen „~“ vorn und fallen so überall heraus. mc:AlternateContent wird
 * durch den Inhalt der ersten Wahl ersetzt (mc:Choice, sonst mc:Fallback).
 */
function namensraeume(knoten, bereich) {
  let b = bereich;
  for (const [a, v] of Object.entries(knoten.attribute)) {
    if (a !== 'xmlns' && !a.startsWith('xmlns:')) continue;
    if (b === bereich) b = new Map(bereich);
    b.set(a === 'xmlns' ? '' : a.slice(6), NS_KURZ.get(v) || null);
  }
  const name = (n, element) => {
    const i = n.indexOf(':');
    if (i < 0 && !element) return n; // Attribute ohne Präfix gehören zu keinem Namensraum
    const p = i < 0 ? '' : n.slice(0, i);
    if (p === 'xml' || p === 'xmlns' || !b.has(p)) return n;
    const lokal = i < 0 ? n : n.slice(i + 1);
    return b.get(p) ? `${b.get(p)}:${lokal}` : `~${p}:${lokal}`;
  };
  knoten.name = name(knoten.name, true);
  const attribute = {};
  for (const [a, v] of Object.entries(knoten.attribute)) attribute[a === 'xmlns' || a.startsWith('xmlns:') ? a : name(a, false)] = v;
  knoten.attribute = attribute;
  const neu = [];
  for (const k of knoten.kinder) {
    namensraeume(k, b);
    if (k.name !== 'mc:AlternateContent') { neu.push(k); continue; }
    const wahl = kind(k, 'mc:Choice') || kind(k, 'mc:Fallback');
    if (wahl) neu.push(...wahl.kinder);
  }
  knoten.kinder = neu;
  return knoten;
}

function xmlDekodieren(bytes) {
  const art = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(art).decode(bytes);
}

/** Zugriff auf die Teile: Namen auch ohne Groß-/Kleinschreibung und URL-kodiert; XML wird je Teil einmal gelesen. */
function paketVon(zip) {
  const klein = new Map();
  for (const n of zip.keys()) if (!klein.has(n.toLowerCase())) klein.set(n.toLowerCase(), n);
  const finden = (name) => (zip.has(name) ? name : klein.get(name.toLowerCase()));
  const bytes = (name) => {
    let n = finden(name);
    if (n === undefined) { try { n = finden(decodeURIComponent(name)); } catch { n = undefined; } }
    return n === undefined ? null : zip.get(n);
  };
  const cache = new Map();
  const xml = (name, normal = true) => {
    const schluessel = `${normal ? 'n' : 'r'}|${name}`;
    if (!cache.has(schluessel)) {
      let w = null;
      const b = bytes(name);
      if (b) { try { w = xmlLesen(xmlDekodieren(b)); if (normal) namensraeume(w, new Map()); } catch { w = null; } }
      cache.set(schluessel, w);
    }
    return cache.get(schluessel);
  };
  return { bytes, xml };
}

/** Relatives Ziel einer Beziehung auflösen („../“, führender „/“ = Paketwurzel). */
function pfadAufloesen(ordner, ziel) {
  const roh = String(ziel).replace(/\\/g, '/');
  const aus = [];
  for (const t of (roh.startsWith('/') ? roh : `${ordner}/${roh}`).split('/')) {
    if (!t || t === '.') continue;
    if (t === '..') aus.pop(); else aus.push(t);
  }
  return aus.join('/');
}

/** Beziehungen eines Teils (<ordner>/_rels/<datei>.rels; '' = Paket) → Map(Id → {typ, ziel, extern}). */
function beziehungen(paket, teil) {
  const i = teil.lastIndexOf('/');
  const ordner = i < 0 ? '' : teil.slice(0, i);
  const aus = new Map();
  const w = paket.xml(`${ordner ? `${ordner}/` : ''}_rels/${teil.slice(i + 1)}.rels`, false);
  for (const r of w ? w.kinder : []) {
    if (r.name.slice(r.name.indexOf(':') + 1) !== 'Relationship') continue;
    const { Id: id, Target: ziel } = r.attribute;
    if (!id || typeof ziel !== 'string' || aus.has(id)) continue;
    const extern = /^external$/i.test(r.attribute.TargetMode || '');
    aus.set(id, { typ: String(r.attribute.Type || ''), ziel: extern ? ziel : pfadAufloesen(ordner, ziel), extern });
  }
  return aus;
}

// ---- Lesen: Stile und Nummerierung -----------------------------------------------------------------------------------

function stileLesen(w) {
  const stile = new Map();
  let standard;
  for (const s of w ? kinder(w, 'w:style') : []) {
    const sid = s.attribute['w:styleId'];
    if (!sid || stile.has(sid)) continue;
    const ppr = kind(s, 'w:pPr');
    const np = kind(ppr, 'w:numPr');
    const art = s.attribute['w:type'] || 'paragraph';
    const vorgabe = s.attribute['w:default'];
    if (art === 'paragraph' && standard === undefined && vorgabe !== undefined && !AUS.has(String(vorgabe).toLowerCase())) standard = sid;
    stile.set(sid, {
      id: sid, name: val(kind(s, 'w:name')) || '', basedOn: val(kind(s, 'w:basedOn')), art, pPr: ppr, rPr: kind(s, 'w:rPr'),
      numPr: np ? { numId: val(kind(np, 'w:numId')), ilvl: val(kind(np, 'w:ilvl')) } : null,
    });
  }
  return { stile, standard };
}

/** Stil und seine Vorfahren (basedOn), höchstens 10, ohne Schleifen. */
function stilKette(stile, sid) {
  const kette = [];
  let s = sid === undefined ? undefined : stile.get(sid);
  while (s && kette.length < 10 && !kette.includes(s)) { kette.push(s); s = s.basedOn === undefined ? undefined : stile.get(s.basedOn); }
  return kette;
}

/** Was ein Absatzstil (samt Vorfahren) fürs Modell bedeutet: Überschrift, Zitat, Liste, Ausrichtung. */
function absatzstilLesen(stile, sid) {
  const aus = { ueberschrift: 0, zitat: false, numPr: null, jc: undefined };
  for (const s of stilKette(stile, sid)) {
    for (const n of [normName(s.name), normName(s.id)]) {
      if (!aus.ueberschrift) {
        const m = UEBERSCHRIFT.exec(n);
        if (m) aus.ueberschrift = Math.min(3, Number(m[2])); else if (n === 'title') aus.ueberschrift = 1; else if (n === 'subtitle') aus.ueberschrift = 2;
      }
      if (ZITAT.test(n)) aus.zitat = true;
    }
    if (!aus.numPr && s.numPr) aus.numPr = s.numPr;
    if (aus.jc === undefined) aus.jc = val(kind(s.pPr, 'w:jc'));
  }
  return aus;
}

/** Nummerierung → (numId, ilvl) → 'punkte' | 'zahlen' | null. numId 0 oder unbekannt: keine Liste. */
function nummerierungLesen(w, stile) {
  const ebenen = (knoten) => {
    const m = new Map();
    for (const l of kinder(knoten, 'w:lvl')) { const i = ganz(l.attribute['w:ilvl']); if (i !== null && !m.has(i)) m.set(i, val(kind(l, 'w:numFmt'))); }
    return m;
  };
  const abstrakt = new Map(); const nums = new Map();
  for (const a of w ? kinder(w, 'w:abstractNum') : []) abstrakt.set(a.attribute['w:abstractNumId'], { ebenen: ebenen(a), link: val(kind(a, 'w:numStyleLink')) });
  for (const n of w ? kinder(w, 'w:num') : []) {
    const ueber = new Map();
    for (const o of kinder(n, 'w:lvlOverride')) {
      const i = ganz(o.attribute['w:ilvl']);
      const lvl = kind(o, 'w:lvl');
      if (i !== null && lvl) ueber.set(i, val(kind(lvl, 'w:numFmt')));
    }
    nums.set(n.attribute['w:numId'], { abstrakt: val(kind(n, 'w:abstractNumId')), ueber });
  }
  const format = (numId, ilvl, tiefe) => {
    const n = nums.get(String(numId));
    if (!n || tiefe > 5) return undefined;
    if (n.ueber.has(ilvl)) return n.ueber.get(ilvl);
    const a = abstrakt.get(n.abstrakt);
    if (a && a.ebenen.has(ilvl)) return a.ebenen.get(ilvl);
    // Listenstil (numStyleLink): dessen Nummerierung
    const st = a && a.link !== undefined ? stile.get(a.link) : null;
    return st && st.numPr && st.numPr.numId !== undefined ? format(st.numPr.numId, ilvl, tiefe + 1) : undefined;
  };
  return (numId, ilvl) => {
    if (numId === undefined || String(numId) === '0' || !nums.has(String(numId))) return null;
    const f = format(numId, ilvl, 0);
    return f === 'bullet' ? 'punkte' : f === 'none' ? null : 'zahlen';
  };
}

const monoSchrift = (rpr) => {
  const s = kind(rpr, 'w:rFonts');
  return !!s && [s.attribute['w:ascii'], s.attribute['w:hAnsi']].some((n) => MONO.has(String(n || '').trim().toLowerCase()));
};

/** Laufformate aus einem rPr übernehmen (nach Stil, vor eigenem); `farben` = auch Farbe und Hintergrund. */
function rprAnwenden(f, rpr, farben) {
  const schalter = (k, schluessel) => { if (k) { if (an(k)) f[schluessel] = true; else delete f[schluessel]; } };
  schalter(kind(rpr, 'w:b'), 'fett');
  schalter(kind(rpr, 'w:i'), 'kursiv');
  const strike = kind(rpr, 'w:strike'); const dstrike = kind(rpr, 'w:dstrike');
  if (strike || dstrike) { if (an(strike) || an(dstrike)) f.durchgestrichen = true; else delete f.durchgestrichen; }
  const u = kind(rpr, 'w:u');
  if (u) { if (val(u) !== 'none') f.unterstrichen = true; else delete f.unterstrichen; }
  if (monoSchrift(rpr)) f.code = true;
  if (!farben) return;
  const c = val(kind(rpr, 'w:color'));
  if (typeof c === 'string') {
    if (c.toLowerCase() === 'auto') delete f.farbe;
    else { const n = farbeNormal(`#${c}`, FARBEN); if (n) f.farbe = n; }
  }
  const fill = String(kind(rpr, 'w:shd')?.attribute['w:fill'] ?? '').toLowerCase();
  if (fill && fill !== 'auto' && fill !== 'ffffff') { const n = farbeNormal(`#${fill}`, HINTERGRUENDE); if (n) f.hintergrund = n; }
  const h = val(kind(rpr, 'w:highlight')); // Markierung liegt in Word über der Schattierung
  if (MARKIERUNG.has(h)) f.hintergrund = MARKIERUNG.get(h);
}

// ---- Lesen: Inhalt ---------------------------------------------------------------------------------------------------

class DocxLeser {
  constructor(paket, rels, stile, standard, liste, id) {
    Object.assign(this, { paket, rels, stile, standard, liste, id });
    this.zahl = Object.fromEntries(FEHLTE_ARTEN.map((a) => [a, 0]));
    this.dateien = [];
    this.bildSchluessel = new Map(); // Ziel → Schlüssel | null (nicht lesbar)
    this.absatzstile = new Map();
    this.kopfGeprueft = new Set();
    this.felder = []; // offene Felder: {code} – Feldcode bis „separate“ überspringen
    this.imCode = 0;
  }

  zaehlen(art) { this.zahl[art] += 1; }

  einmal(art) { this.zahl[art] = 1; }

  // Felder: Code (instrText …) bis „separate“ überspringen, das Ergebnis übernehmen; gezählt wird je äußerem Feld
  feldZeichen(typ) {
    if (typ === 'begin') {
      if (!this.felder.length) this.zaehlen('felder');
      this.felder.push({ code: true }); this.imCode += 1;
    } else if (typ === 'separate') {
      const f = this.felder[this.felder.length - 1];
      if (f && f.code) { f.code = false; this.imCode -= 1; }
    } else if (typ === 'end') {
      const f = this.felder.pop();
      if (f && f.code) this.imCode -= 1;
    }
  }

  /** Ein Feldcode endet spätestens mit seinem Absatz (sonst verschluckte ein kaputtes Feld den Rest). */
  absatzEnde() {
    if (!this.imCode) return;
    for (const f of this.felder) f.code = false;
    this.imCode = 0;
  }

  absatzstil(sid) {
    if (!this.absatzstile.has(sid)) this.absatzstile.set(sid, absatzstilLesen(this.stile, sid));
    return this.absatzstile.get(sid);
  }

  /** Zeilen-Attribute eines Absatzes: Stil (Überschrift, Zitat, Liste, Ausrichtung) und eigenes pPr davor. */
  zeilenFormate(ppr) {
    const a = {};
    const st = this.absatzstil(val(kind(ppr, 'w:pStyle')) ?? this.standard);
    if (st.ueberschrift) a.ueberschrift = st.ueberschrift;
    if (st.zitat) a.zitat = true;
    const np = kind(ppr, 'w:numPr');
    const numId = val(kind(np, 'w:numId')) ?? (st.numPr ? st.numPr.numId : undefined);
    const ilvl = begrenzt(ganz(val(kind(np, 'w:ilvl')) ?? (st.numPr ? st.numPr.ilvl : undefined)) ?? 0, 0, 8);
    const liste = this.liste(numId, ilvl);
    if (liste) {
      a.liste = liste;
      if (ilvl) a.einzug = ilvl;
    } else {
      // nur der eigene Einzug: Listen- und Zitatstile rücken selbst ein
      const ind = kind(ppr, 'w:ind');
      const links = ind ? twips(ind.attribute['w:left'] ?? ind.attribute['w:start']) : null;
      const e = links === null ? 0 : begrenzt(Math.round(links / EINZUG_TWIPS), 0, 8);
      if (e) a.einzug = e;
    }
    const jc = val(kind(ppr, 'w:jc')) ?? st.jc;
    if (AUSRICHTUNG.has(jc)) a.ausrichtung = AUSRICHTUNG.get(jc);
    return a;
  }

  /** Laufformate: Zeichenstil (Link-Stile nie, Code-Stil nur als code), dann eigenes rPr; ausgeblendet → null. */
  laufFormate(rpr) {
    const f = {};
    const kette = stilKette(this.stile, val(kind(rpr, 'w:rStyle')));
    if (kette.length && !kette.some((s) => LINKSTIL.test(normName(s.name)) || LINKSTIL.test(normName(s.id)))) {
      const code = kette.some((s) => normName(s.id) === 'code' || normName(s.name) === 'code' || monoSchrift(s.rPr));
      for (const s of kette.reverse()) if (s.rPr) rprAnwenden(f, s.rPr, !code);
      if (code) f.code = true;
    }
    if (rpr) {
      if (an(kind(rpr, 'w:vanish'))) return null;
      rprAnwenden(f, rpr, true);
    }
    return f;
  }

  /** Inhalt eines Absatzes (oder eines Teils davon) → Stücke {text, f, link} | {bild, link} | {umbruch}. */
  inline(knoten, stuecke, link) {
    for (const k of knoten.kinder) {
      switch (k.name) {
        case 'w:r': this.lauf(k, stuecke, link); break;
        case 'w:hyperlink': {
          // nur externe Ziele mit erlaubtem Schema; Sprungmarken (w:anchor) bleiben Text
          const r = k.attribute['r:id'] ? this.rels.get(k.attribute['r:id']) : null;
          this.inline(k, stuecke, r && r.extern && linkErlaubt(r.ziel) ? r.ziel : null);
          break;
        }
        case 'w:fldSimple':
          if (this.imCode) break;
          if (!this.felder.length) this.zaehlen('felder');
          this.inline(k, stuecke, link);
          break;
        case 'w:ins': case 'w:moveTo': case 'w:smartTag': case 'w:customXml': case 'w:dir': case 'w:bdo': this.inline(k, stuecke, link); break;
        case 'w:sdt': { const c = kind(k, 'w:sdtContent'); if (c) this.inline(c, stuecke, link); break; }
        case 'm:oMath': case 'm:oMathPara': this.zaehlen('formeln'); break;
        default: // w:del, w:moveFrom, Lesezeichen, Rechtschreibmarken, Kommentarbereiche, pPr …
      }
    }
  }

  lauf(r, stuecke, link) {
    const f = this.laufFormate(kind(r, 'w:rPr'));
    if (!f) return;
    const text = (s) => { if (!this.imCode && s) stuecke.push({ text: s, f, link }); };
    for (const k of r.kinder) {
      switch (k.name) {
        case 'w:t': text(k.text.replace(/[\r\n]+/g, ' ').replace(/\ufffc/g, '')); break; // U+FFFC steht im Modell für Embeds
        case 'w:tab': case 'w:ptab': text('\t'); break;
        case 'w:noBreakHyphen': text('-'); break;
        case 'w:br': if (!this.imCode) stuecke.push({ umbruch: k.attribute['w:type'] === 'page' ? 'seite' : 'zeile' }); break;
        case 'w:cr': if (!this.imCode) stuecke.push({ umbruch: 'zeile' }); break;
        case 'w:drawing': if (!this.imCode) this.zeichnung(k, stuecke, link); break;
        case 'w:pict': if (!this.imCode) this.vml(k, stuecke, link); break;
        case 'w:object': case 'w:control': this.zaehlen('objekte'); break;
        case 'w:footnoteReference': case 'w:endnoteReference': this.zaehlen('fussnoten'); break;
        case 'w:commentReference': this.zaehlen('kommentare'); break;
        case 'w:fldChar': this.feldZeichen(k.attribute['w:fldCharType']); break;
        default: // rPr, instrText, delText, sym, softHyphen, lastRenderedPageBreak …
      }
    }
  }

  zeichnung(d, stuecke, link) {
    const rahmen = kind(d, 'wp:inline') || kind(d, 'wp:anchor');
    const daten = kind(kind(rahmen, 'a:graphic'), 'a:graphicData');
    if (/\/(chart|chartex|diagram)$/i.test(String(daten ? daten.attribute.uri || '' : ''))) { this.zaehlen('diagramme'); return; }
    if (finde(d, 'wps:wsp')) { this.zaehlen(finde(d, 'wps:txbx') ? 'textfelder' : 'formen'); return; }
    const blip = finde(kind(daten, 'pic:pic'), 'a:blip');
    if (!blip) { this.zaehlen('formen'); return; }
    const cx = ganz(kind(rahmen, 'wp:extent')?.attribute.cx);
    stuecke.push({ bild: { rid: blip.attribute['r:embed'] || null, breite: cx > 0 ? Math.round(cx / EMU_PX) : null, alt: String(kind(rahmen, 'wp:docPr')?.attribute.descr || '') }, link });
  }

  /** Alte Bilder (VML): v:imagedata → Bild (Breite aus dem Stil der Form), v:textbox → Textfeld, sonst Form. */
  vml(p, stuecke, link) {
    if (finde(p, 'v:textbox')) { this.zaehlen('textfelder'); return; }
    const daten = finde(p, 'v:imagedata');
    if (!daten) { this.zaehlen('formen'); return; }
    const form = finde(p, 'v:shape');
    const m = /(?:^|;)\s*width\s*:\s*([\d.]+)\s*(pt|px|in|cm|mm)?/i.exec(String(form ? form.attribute.style || '' : ''));
    const px = m ? Number(m[1]) * { pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[(m[2] || 'px').toLowerCase()] : 0;
    stuecke.push({ bild: { rid: daten.attribute['r:id'] || null, breite: px > 0 ? Math.round(px) : null, alt: String(form ? form.attribute.alt || '' : '') }, link });
  }

  /** Bild-Stück → Embed-Wert {datei: Schlüssel, breite?, alt?} oder null (extern, fehlt, Format nicht unterstützt). */
  bildAufloesen(b) {
    const r = b.rid ? this.rels.get(b.rid) : null;
    if (!r || r.extern) { this.zaehlen('bilder'); return null; }
    if (!this.bildSchluessel.has(r.ziel)) {
      const bytes = BILD_DATEI.test(r.ziel) ? this.paket.bytes(r.ziel) : null;
      const kopf = bytes ? bildKopf(bytes) : null; // Inhalt prüfen, nicht nur die Endung
      let schluessel = null;
      if (kopf) {
        schluessel = `bild${this.dateien.length + 1}`;
        const endung = kopf.format === 'jpeg' ? (/\.jpeg$/i.test(r.ziel) ? 'jpeg' : 'jpg') : kopf.format;
        this.dateien.push({ schluessel, name: `${schluessel}.${endung}`, blob: new Blob([bytes], { type: `image/${kopf.format}` }) });
      }
      this.bildSchluessel.set(r.ziel, schluessel);
    }
    const schluessel = this.bildSchluessel.get(r.ziel);
    if (!schluessel) { this.zaehlen('bilder'); return null; }
    const wert = { datei: schluessel };
    if (b.breite !== null && b.breite !== undefined) wert.breite = begrenzt(b.breite, 16, 2000);
    if (b.alt) wert.alt = gekuerzt(b.alt, ALT_MAX);
    return wert;
  }

  /** Kopf-/Fußzeilen eines Abschnitts: mit Inhalt (Text oder Bild) → kopfzeilen 1. */
  kopfFuss(sect) {
    for (const ref of sect.kinder) {
      if (this.zahl.kopfzeilen || (ref.name !== 'w:headerReference' && ref.name !== 'w:footerReference')) continue;
      const r = this.rels.get(ref.attribute['r:id']);
      if (!r || r.extern || this.kopfGeprueft.has(r.ziel)) continue;
      this.kopfGeprueft.add(r.ziel);
      const hatInhalt = (k) => (k.name === 'w:t' && !!k.text.trim()) || k.name === 'w:drawing' || k.name === 'w:pict' || k.kinder.some(hatInhalt);
      const w = this.paket.xml(r.ziel);
      if (w && hatInhalt(w)) this.einmal('kopfzeilen');
    }
  }

  /** Inhalt des Dokumentkörpers (auch in Inhaltssteuerelementen) → Blöcke. */
  koerper(knoten, bloecke) {
    for (const k of knoten.kinder) {
      switch (k.name) {
        case 'w:p': this.absatz(k, bloecke); break;
        case 'w:tbl': this.tabelle(k, bloecke); break;
        case 'w:sdt': { const c = kind(k, 'w:sdtContent'); if (c) this.koerper(c, bloecke); break; }
        case 'w:customXml': this.koerper(k, bloecke); break;
        case 'w:altChunk': this.zaehlen('objekte'); break;
        case 'w:sectPr': this.kopfFuss(k); break;
        default:
      }
    }
  }

  /** Absatz → Zeilen (w:br teilt mit gleichen Zeilen-Attributen, Seitenumbrüche werden eigene Zeilen). */
  absatz(p, bloecke) {
    const ppr = kind(p, 'w:pPr');
    const sect = kind(ppr, 'w:sectPr');
    if (sect) this.kopfFuss(sect);
    const attr = this.zeilenFormate(ppr);
    const stuecke = [];
    this.inline(p, stuecke, null);
    this.absatzEnde();
    const zeilen = an(kind(ppr, 'w:pageBreakBefore')) ? [SEITE] : [];
    let akt = []; let zuletzt = null;
    for (const s of stuecke) {
      if (s.umbruch === 'seite') { if (akt.length) zeilen.push(akt); akt = []; zeilen.push(SEITE); zuletzt = 'seite'; continue; }
      if (s.umbruch === 'zeile') { zeilen.push(akt); akt = []; zuletzt = 'zeile'; continue; }
      akt.push(s); zuletzt = null;
    }
    // leere Teilstücke neben einem Seitenumbruch ergeben keine Leerzeile
    if (akt.length || zuletzt !== 'seite') zeilen.push(akt);
    const leer = zeilen.length === 1 && zeilen[0] !== SEITE && !zeilen[0].length && !Object.keys(attr).length;
    bloecke.push({ art: 'zeilen', zeilen, attr, leer });
  }

  /** Eine Zeile → Ops (Text, Bilder, Zeilenende); Aufgaben aus ☐/☑/☒ vor dem Text einer Punkte-Liste. */
  zeileOps(zeile, attr, ops) {
    if (zeile === SEITE) { ops.push({ insert: { seitenumbruch: true } }, { insert: '\n' }); return; }
    let a = attr;
    if (a.liste === 'punkte') {
      let anfang = '';
      for (const s of zeile) { if (s.text === undefined || anfang.length >= 2) break; anfang += s.text; }
      const m = AUFGABE.exec(anfang);
      if (m) {
        let rest = 2;
        for (const s of zeile) {
          if (!rest || s.text === undefined) break;
          const n = Math.min(rest, s.text.length);
          s.text = s.text.slice(n); rest -= n;
        }
        a = { ...a, liste: 'aufgabe' };
        if (m[1] !== '☐') a.erledigt = true;
      }
    }
    for (const s of zeile) {
      if (s.bild) {
        const b = this.bildAufloesen(s.bild);
        if (b) ops.push(s.link ? { insert: { bild: b }, attributes: { link: s.link } } : { insert: { bild: b } });
      } else if (s.text) ops.push({ insert: s.text, attributes: s.link ? { ...s.f, link: s.link } : { ...s.f } });
    }
    ops.push(Object.keys(a).length ? { insert: '\n', attributes: { ...a } } : { insert: '\n' });
  }

  /** w:tr bzw. w:tc auch in Inhaltssteuerelementen und customXml sammeln. */
  sammeln(knoten, name, aus) {
    for (const k of knoten.kinder) {
      if (k.name === name) aus.push(k);
      else if (k.name === 'w:sdt') { const c = kind(k, 'w:sdtContent'); if (c) this.sammeln(c, name, aus); } else if (k.name === 'w:customXml') this.sammeln(k, name, aus);
    }
  }

  /** Zellinhalt → Zeilen aus Text-Stücken; Tabellen in der Zelle → nur ihr Text, Bilder fallen weg. */
  zellInhalt(knoten, zeilen) {
    for (const k of knoten.kinder) {
      if (k.name === 'w:p') {
        const stuecke = [];
        this.inline(k, stuecke, null);
        this.absatzEnde();
        let akt = [];
        for (const s of stuecke) {
          if (s.umbruch === 'zeile') { zeilen.push(akt); akt = []; } else if (s.bild) this.zaehlen('bilder'); else if (s.text) akt.push(s);
        }
        zeilen.push(akt);
      } else if (k.name === 'w:tbl') {
        this.einmal('verschachtelt');
        const reihen = []; this.sammeln(k, 'w:tr', reihen);
        for (const tr of reihen) { const zellen = []; this.sammeln(tr, 'w:tc', zellen); for (const tc of zellen) this.zellInhalt(tc, zeilen); }
      } else if (k.name === 'w:sdt') { const c = kind(k, 'w:sdtContent'); if (c) this.zellInhalt(c, zeilen); } else if (k.name === 'w:customXml') this.zellInhalt(k, zeilen);
    }
  }

  /** Zelle → Delta (Absätze mit \n verbunden, nur Inline-Formate, ohne \n am Ende, höchstens 20 000 Zeichen). */
  zelle(tc) {
    const zeilen = [];
    this.zellInhalt(tc, zeilen);
    while (zeilen.length && !zeilen[zeilen.length - 1].length) zeilen.pop();
    const ops = [];
    zeilen.forEach((z, i) => {
      if (i > 0) ops.push({ insert: '\n' });
      for (const s of z) ops.push({ insert: s.text, attributes: s.link ? { ...s.f, link: s.link } : { ...s.f } });
    });
    let delta = normalisieren(ops);
    let n = 0;
    for (let i = 0; i < delta.length; i++) {
      if (n + delta[i].insert.length <= ZELLE_MAX) { n += delta[i].insert.length; continue; }
      const t = gekuerzt(delta[i].insert, ZELLE_MAX - n);
      delta = [...delta.slice(0, i), ...(t ? [{ ...delta[i], insert: t }] : [])];
      this.einmal('tabellengroesse');
      break;
    }
    // kein Zeilenumbruch am Ende (auch nicht nach dem Kürzen)
    while (delta.length) {
      const l = delta[delta.length - 1];
      const t = l.insert.replace(/\n+$/, '');
      if (t === l.insert) break;
      if (t) delta[delta.length - 1] = { ...l, insert: t }; else delta.pop();
    }
    return delta;
  }

  /** Tabelle → Embed-Wert; Raster nach Gitterspalten (gridSpan, gridBefore), höchstens 200 × 50. */
  tabelle(tbl, bloecke) {
    const reihen = [];
    this.sammeln(tbl, 'w:tr', reihen);
    if (reihen.length > TABELLE_MAX.zeilen) { reihen.length = TABELLE_MAX.zeilen; this.einmal('tabellengroesse'); }
    const raster = reihen.map((tr) => {
      const reihe = [];
      let spalte = begrenzt(ganz(val(kind(kind(tr, 'w:trPr'), 'w:gridBefore'))) ?? 0, 0, 1000);
      const zellen = []; this.sammeln(tr, 'w:tc', zellen);
      for (const tc of zellen) {
        const tcPr = kind(tc, 'w:tcPr');
        const spann = begrenzt(ganz(val(kind(tcPr, 'w:gridSpan'))) ?? 1, 1, 1000);
        if (spann > 1 || kind(tcPr, 'w:vMerge') || kind(tcPr, 'w:hMerge')) this.einmal('verbunden');
        if (spalte < TABELLE_MAX.spalten) reihe[spalte] = this.zelle(tc);
        spalte += spann;
      }
      return { reihe, breite: spalte };
    });
    let n = raster.reduce((m, r) => Math.max(m, r.breite), 0);
    if (n > TABELLE_MAX.spalten) { n = TABELLE_MAX.spalten; this.einmal('tabellengroesse'); }
    if (!raster.length || !n) return;
    const tabelle = { id: this.id(), zeilen: raster.map(() => this.id()), spalten: Array.from({ length: n }, () => this.id()), weg: [], zellen: {}, breiten: {} };
    raster.forEach((r, i) => {
      for (let j = 0; j < n; j++) if (r.reihe[j] && r.reihe[j].length) tabelle.zellen[zellKey(tabelle.zeilen[i], tabelle.spalten[j])] = r.reihe[j];
    });
    // Breiten aus dem Gitter; gleich verteilte volle Breite (unser Export ohne Breite) bleibt frei
    const gitter = kinder(kind(tbl, 'w:tblGrid'), 'w:gridCol');
    const gleich = Math.floor(INHALT_TWIPS / Math.max(1, gitter.length));
    gitter.slice(0, n).forEach((g, j) => {
      const w = twips(g.attribute['w:w']);
      if (w > 0 && Math.round(w) !== gleich) tabelle.breiten[tabelle.spalten[j]] = begrenzt(Math.round(w / TWIPS_PX), 40, 2000);
    });
    bloecke.push({ art: 'tabelle', wert: tabelle });
  }
}

/**
 * .docx lesen → {daten, dateien: [{schluessel, name, blob}], fehlte: [{art, anzahl}]}. Bilder tragen bis zum Verknüpfen
 * ihren Schlüssel (bild1, bild2, …) als datei. Fehler: Error('docx_kaputt'), dazu die Fehler von zipLesen.
 */
export async function docxLesen(arrayBuffer, { id = neueId } = {}) {
  const paket = paketVon(await zipLesen(arrayBuffer));
  try {
    let haupt = 'word/document.xml';
    for (const r of beziehungen(paket, '').values()) if (!r.extern && /\/officeDocument$/.test(r.typ)) { haupt = r.ziel; break; }
    const dok = paket.xml(haupt);
    if (!dok || dok.name !== 'w:document') throw new Error('docx_kaputt');
    const rels = beziehungen(paket, haupt);
    const teil = (typ, standard) => { for (const r of rels.values()) if (!r.extern && r.typ.endsWith(`/${typ}`)) return r.ziel; return standard; };
    const { stile, standard } = stileLesen(paket.xml(teil('styles', 'word/styles.xml')));
    const liste = nummerierungLesen(paket.xml(teil('numbering', 'word/numbering.xml')), stile);
    const leser = new DocxLeser(paket, rels, stile, standard, liste, id);
    const bloecke = [];
    const body = kind(dok, 'w:body');
    if (body) leser.koerper(body, bloecke);
    const ops = [];
    bloecke.forEach((b, i) => {
      // leerer Absatz zwischen zwei Tabellen: Word braucht ihn, das Modell nicht
      if (b.leer && bloecke[i - 1]?.art === 'tabelle' && bloecke[i + 1]?.art === 'tabelle') return;
      if (b.art === 'tabelle') ops.push({ insert: { tabelle: b.wert } }, { insert: '\n' });
      else for (const z of b.zeilen) leser.zeileOps(z, b.attr, ops);
    });
    const delta = normalisieren(ops);
    const l = delta[delta.length - 1];
    if (l && !(typeof l.insert === 'string' && l.insert.endsWith('\n'))) delta.push({ insert: '\n' });
    return {
      daten: delta.length ? { delta, kommentare: {} } : { delta: [{ insert: '\n' }], kommentare: {} },
      dateien: leser.dateien,
      fehlte: FEHLTE_ARTEN.filter((a) => leser.zahl[a] > 0).map((a) => ({ art: a, anzahl: leser.zahl[a] })),
    };
  } catch (e) {
    if (e && e.message === 'docx_kaputt') throw e;
    throw new Error('docx_kaputt', { cause: e });
  }
}
