// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Excel (.xlsx) für die Office-Tabelle (Plan 06). Schreiben: Mappe → SpreadsheetML mit festen Teilen (Arbeitsmappe,
// Blätter, Stile, gemeinsame Zeichenketten, docProps). Damit Excel, LibreOffice und Numbers die Datei ohne Reparatur
// öffnen: Blattnamen gültig und eindeutig (verbotene Zeichen → _, höchstens 31 Zeichen, „History“ ist reserviert),
// Kinder in Schema-Reihenfolge, Zeilen und Zellen aufsteigend, <f> vor <v>. Formeln stehen englisch mit Blattnamen in
// der Datei, dazu ihr Ergebnis aus dem Rechner (Excel rechnet beim Öffnen ohnehin neu: fullCalcOnLoad); ein Zirkel wird
// #VALUE!, weil Excel keinen Zirkel-Fehlerwert kennt.
// Lesen: fremde .xlsx → Mappe. Präfixe werden auf den Standard-Namensraum gebracht, Stile auf die sechs Formatfelder
// abgebildet (Theme- und Index-Farben fallen weg), gemeinsame Formeln ausgeklappt; was hier nicht darstellbar ist,
// fällt weg und wird je Art gezählt (fehlte) – Formeln, die das Office nicht lesen kann, kommen als ihr Wert. Fremde
// Dateien werden nie ausgewertet: externe Ziele werden nie geladen, keine DTD; Zip-Bomben fängt zipLesen ab. Fehler:
// Error('xlsx_kaputt') bzw. die Fehler von zipLesen.

import { zipSchreiben, zipLesen } from '../format/zip.js';
import { xmlEscape, xmlLesen, kind, kinder } from '../format/xml.js';
import { GRENZEN, EXCEL_MAX, adresse, adresseLesen, spalteZuText, textZuSpalte } from './formeln/adresse.js';
import { Rechner } from './formeln/auswerter.js';
import { internZuExcel, excelZuIntern } from './formeln/uebersetzen.js';
import { formelVerschieben } from './formeln/verschieben.js';
import { FEHLER_EXCEL, istFehler, fehlerAusCode, textIntern, datumLesen } from './formeln/werte.js';
import { zwischen } from '../../gemeinsam/sync/typen/board.js';
import { neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { datenPruefen } from '../../gemeinsam/sync/typen/tabelle.js';

export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const KOPF = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = Object.freeze({
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  paket: 'http://schemas.openxmlformats.org/package/2006/relationships',
});
const REL_TYP = Object.freeze({
  dokument: `${NS.r}/officeDocument`, blatt: `${NS.r}/worksheet`, stile: `${NS.r}/styles`, zeichenketten: `${NS.r}/sharedStrings`,
  app: `${NS.r}/extended-properties`, core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
});
const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const x = xmlEscape;

/** Zahlformat → numFmtId: eingebaute (4 = #,##0.00, 10 = 0.00 %, 49 = Text) und zwei eigene (164, 165). */
const ZAHLFORMAT_ID = Object.freeze({ zahl2: 4, euro: 165, prozent: 10, datum: 164, text: 49 });
const EIGENE_FORMATE = Object.freeze([[164, 'DD.MM.YYYY'], [165, '#,##0.00\\ "€"']]);
const AUSRICHTUNG = Object.freeze({ links: 'left', mitte: 'center', rechts: 'right' });
const NAME_VERBOTEN = /[:\\/?*[\]\u0000-\u001f]/g;
const NAME_MAX = 31;
/** Zellschlüssel dürfen nach dem Einfügen jenseits von GRENZEN liegen; Excel fasst höchstens XFD1048576. */
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });

/** Auf n UTF-16-Zeichen kürzen, ohne ein Ersatzpaar zu teilen. */
const gekuerzt = (s, n) => { const t = s.slice(0, n); return /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t; };
const RAND_LEER = /^\s|\s$/;

/**
 * Blattnamen, die Excel annimmt → Map<id, name> in der Reihenfolge der Blätter: verbotene Zeichen (: \ / ? * [ ],
 * Steuerzeichen) und ' am Rand → _, höchstens 31 Zeichen, leer → „Tabelle“, „History“ → „History_“; doppelte (ohne
 * Groß/Klein) bekommen „ (2)“, „ (3)“ … – vorher so gekürzt, dass 31 Zeichen reichen.
 */
export function blattNamenFuerExcel(blaetter) { return gueltigeNamen(blaetter, true); }

/** Gültige, eindeutige Blattnamen → Map<id, name>; `excel` = zusätzlich die Sonderregel für „History“. */
function gueltigeNamen(blaetter, excel) {
  const aus = new Map(), vergeben = new Set();
  for (const b of blaetter ?? []) {
    let n = gekuerzt(String(b?.name ?? '').replace(NAME_VERBOTEN, '_'), NAME_MAX).replace(/^'/, '_').replace(/'$/, '_');
    if (n.trim() === '') n = 'Tabelle';
    if (excel && n.toLowerCase() === 'history') n += '_';
    let name = n;
    for (let i = 2; vergeben.has(name.toLowerCase()); i++) {
      const zusatz = ` (${i})`;
      name = gekuerzt(n, NAME_MAX - zusatz.length) + zusatz;
    }
    vergeben.add(name.toLowerCase());
    aus.set(b.id, name);
  }
  return aus;
}

// ---- Stile ---------------------------------------------------------------------------------------------------------

const argb = (hex) => `FF${hex.slice(1).toUpperCase()}`;

/** Sammelt Schriften, Füllungen und Zellformate (je Kombination einmal); Index 0 ist jeweils der Standard. */
class Stile {
  constructor() {
    this.schriften = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'];
    this.fuellungen = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.indizes = { schriften: new Map(), fuellungen: new Map(), xfs: new Map() };
  }

  _eintrag(art, schluessel, xml) {
    const karte = this.indizes[art];
    if (!karte.has(schluessel)) { karte.set(schluessel, this[art].length); this[art].push(xml); }
    return karte.get(schluessel);
  }

  /** Format f einer Zelle → Index in cellXfs (0 = Standard). */
  index(f) {
    if (!f) return 0;
    const fett = f.fett === true, kursiv = f.kursiv === true;
    const farbe = typeof f.farbe === 'string' && /^#[0-9a-f]{6}$/i.test(f.farbe) ? f.farbe : null;
    const hinter = typeof f.hinter === 'string' && /^#[0-9a-f]{6}$/i.test(f.hinter) ? f.hinter : null;
    const ausr = Object.hasOwn(AUSRICHTUNG, f.ausr ?? '') ? AUSRICHTUNG[f.ausr] : null;
    const numFmt = Object.hasOwn(ZAHLFORMAT_ID, f.zahl ?? '') ? ZAHLFORMAT_ID[f.zahl] : 0;
    const schrift = fett || kursiv || farbe
      ? this._eintrag('schriften', `${fett}|${kursiv}|${farbe}`, `<font>${fett ? '<b/>' : ''}${kursiv ? '<i/>' : ''}<sz val="11"/>`
        + `${farbe ? `<color rgb="${argb(farbe)}"/>` : '<color theme="1"/>'}<name val="Calibri"/><family val="2"/></font>`)
      : 0;
    const fuellung = hinter
      ? this._eintrag('fuellungen', hinter, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(hinter)}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    if (!numFmt && !schrift && !fuellung && !ausr) return 0;
    const anwenden = (numFmt ? ' applyNumberFormat="1"' : '') + (schrift ? ' applyFont="1"' : '') + (fuellung ? ' applyFill="1"' : '') + (ausr ? ' applyAlignment="1"' : '');
    const kopf = `<xf numFmtId="${numFmt}" fontId="${schrift}" fillId="${fuellung}" borderId="0" xfId="0"${anwenden}`;
    return this._eintrag('xfs', `${numFmt}|${schrift}|${fuellung}|${ausr}`, ausr ? `${kopf}><alignment horizontal="${ausr}"/></xf>` : `${kopf}/>`);
  }

  xml() {
    const liste = (name, eintraege) => `<${name} count="${eintraege.length}">${eintraege.join('')}</${name}>`;
    return `${KOPF}<styleSheet xmlns="${NS.main}">`
      + liste('numFmts', EIGENE_FORMATE.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${x(code)}"/>`))
      + liste('fonts', this.schriften) + liste('fills', this.fuellungen)
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + liste('cellXfs', this.xfs)
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
}

// ---- Gemeinsame Zeichenketten --------------------------------------------------------------------------------------

/** Zeichenketten in Reihenfolge des ersten Auftretens. */
class Zeichenketten {
  constructor() { this.liste = []; this.index = new Map(); this.anzahl = 0; }

  nummer(s) {
    this.anzahl++;
    if (!this.index.has(s)) { this.index.set(s, this.liste.length); this.liste.push(s); }
    return this.index.get(s);
  }

  xml() {
    return `${KOPF}<sst xmlns="${NS.main}" count="${this.anzahl}" uniqueCount="${this.liste.length}">`
      + this.liste.map((s) => `<si>${tText(s)}</si>`).join('') + '</sst>';
  }
}

const tText = (s) => (RAND_LEER.test(s) ? `<t xml:space="preserve">${x(s)}</t>` : `<t>${x(s)}</t>`);

// ---- Blätter -------------------------------------------------------------------------------------------------------

/** Zelle → <c>: Text t="s", Zahl, Wahrheitswert t="b", Fehler t="e"; Formel mit Ergebnis (Text t="str", leer 0). */
function zelleXml(adr, zelle, wert, s, sst, formelText) {
  const stil = s ? ` s="${s}"` : '';
  const w = typeof zelle.w === 'string' && zelle.w !== '' ? zelle.w : null;
  if (w === null) return `<c r="${adr}"${stil}/>`;
  const formel = w.startsWith('=');
  const f = formel ? `<f>${x(formelText(w.slice(1)))}</f>` : '';
  let typ = '', v;
  if (istFehler(wert)) { typ = 'e'; v = FEHLER_EXCEL[wert.fehler] ?? '#VALUE!'; } else if (typeof wert === 'boolean') { typ = 'b'; v = wert ? '1' : '0'; } else if (typeof wert === 'number') v = String(wert);
  else if (typeof wert === 'string') {
    if (formel) { typ = 'str'; v = wert; } else { typ = 's'; v = String(sst.nummer(wert)); }
  } else if (formel) v = '0';
  else return `<c r="${adr}"${stil}/>`;
  return `<c r="${adr}"${stil}${typ ? ` t="${typ}"` : ''}>${f}<v>${x(v)}</v></c>`;
}

/** Ein Blatt als SpreadsheetML (Kinder in Schema-Reihenfolge: sheetViews, sheetFormatPr, cols, sheetData). */
function blattXml(blatt, erstes, rechner, stile, sst, formelText) {
  const fixiert = blatt.fixiert?.zeilen === 1;
  const ansicht = `<sheetView${erstes ? ' tabSelected="1"' : ''} workbookViewId="0"`
    + (fixiert ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>' : '/>');

  const spalten = Object.entries(blatt.spalten ?? {})
    .map(([k, v]) => [textZuSpalte(k), v?.breite])
    .filter(([n, px]) => n >= 1 && n <= EXCEL_MAX.spalten && Number.isFinite(px))
    .sort((a, b) => a[0] - b[0])
    .map(([n, px]) => `<col min="${n}" max="${n}" width="${Math.round(((px - 5) / 7) * 100) / 100}" customWidth="1"/>`);

  // Zeilen → Zellen (aufsteigend); Zeilen mit eigener Höhe auch ohne Zellen
  const zeilen = new Map();
  const zeile = (z) => { let e = zeilen.get(z); if (!e) zeilen.set(z, (e = { hoehe: null, zellen: [] })); return e; };
  for (const [adr, zelle] of Object.entries(blatt.zellen ?? {})) {
    const o = adresseLesen(adr, OHNE_GRENZEN);
    if (!o || o.z > EXCEL_MAX.zeilen || o.s > EXCEL_MAX.spalten || !zelle) continue;
    zeile(o.z).zellen.push({ s: o.s, adr, zelle });
  }
  for (const [k, v] of Object.entries(blatt.zeilen ?? {})) {
    const z = Number(k);
    if (Number.isInteger(z) && z >= 1 && z <= EXCEL_MAX.zeilen && Number.isFinite(v?.hoehe)) zeile(z).hoehe = v.hoehe;
  }
  let daten = '';
  for (const z of [...zeilen.keys()].sort((a, b) => a - b)) {
    const { hoehe, zellen } = zeilen.get(z);
    const kopf = `<row r="${z}"${hoehe !== null ? ` ht="${(hoehe * 3) / 4}" customHeight="1"` : ''}`;
    if (!zellen.length) { daten += `${kopf}/>`; continue; }
    zellen.sort((a, b) => a.s - b.s);
    daten += `${kopf}>${zellen.map((c) => zelleXml(c.adr, c.zelle, rechner.wert(blatt.id, c.adr), stile.index(c.zelle.f), sst, formelText)).join('')}</row>`;
  }

  return `${KOPF}<worksheet xmlns="${NS.main}" xmlns:r="${NS.r}"><sheetViews>${ansicht}</sheetViews><sheetFormatPr defaultRowHeight="15"/>`
    + (spalten.length ? `<cols>${spalten.join('')}</cols>` : '') + `<sheetData>${daten}</sheetData></worksheet>`;
}

// ---- Feste Teile ---------------------------------------------------------------------------------------------------

function coreXml(titel, autor, zeit) {
  const d = zeit instanceof Date && !Number.isNaN(zeit.getTime()) ? zeit : new Date();
  const iso = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${KOPF}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + (titel ? `<dc:title>${x(titel)}</dc:title>` : '') + (autor ? `<dc:creator>${x(autor)}</dc:creator>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
}

const APP = `${KOPF}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>FAH-NAS Office</Application></Properties>`;

const PAKET_RELS = `${KOPF}<Relationships xmlns="${NS.paket}">`
  + `<Relationship Id="rId1" Type="${REL_TYP.dokument}" Target="xl/workbook.xml"/>`
  + `<Relationship Id="rId2" Type="${REL_TYP.core}" Target="docProps/core.xml"/>`
  + `<Relationship Id="rId3" Type="${REL_TYP.app}" Target="docProps/app.xml"/></Relationships>`;

function typenXml(anzahl) {
  let s = `${KOPF}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${SML}.sheet.main+xml"/>`;
  for (let i = 1; i <= anzahl; i++) s += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="${SML}.worksheet+xml"/>`;
  return `${s}<Override PartName="/xl/styles.xml" ContentType="${SML}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SML}.sharedStrings+xml"/>`
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
}

function mappeXml(blaetter, namen) {
  return `${KOPF}<workbook xmlns="${NS.main}" xmlns:r="${NS.r}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>`
    + blaetter.map((b, i) => `<sheet name="${x(namen.get(b.id))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
}

function mappeRels(anzahl) {
  let s = `${KOPF}<Relationships xmlns="${NS.paket}">`;
  for (let i = 1; i <= anzahl; i++) s += `<Relationship Id="rId${i}" Type="${REL_TYP.blatt}" Target="worksheets/sheet${i}.xml"/>`;
  return `${s}<Relationship Id="rId${anzahl + 1}" Type="${REL_TYP.stile}" Target="styles.xml"/>`
    + `<Relationship Id="rId${anzahl + 2}" Type="${REL_TYP.zeichenketten}" Target="sharedStrings.xml"/></Relationships>`;
}

/**
 * Mappe → .xlsx als Blob. Ein Rechner mit `jetzt` rechnet die Mappe (HEUTE/JETZT zum Exportzeitpunkt); Blätter in der
 * Reihenfolge der Daten, das erste ist ausgewählt.
 */
export async function xlsxSchreiben(daten, { titel = '', autor = '', zeit = new Date(), jetzt = () => zeit } = {}) {
  const blaetter = daten?.blaetter ?? [];
  const namen = blattNamenFuerExcel(blaetter);
  const exportBlaetter = blaetter.map((b) => ({ id: b.id, name: namen.get(b.id) }));
  const formelText = (text) => internZuExcel(text, { blaetter: exportBlaetter });
  const rechner = new Rechner({ jetzt });
  rechner.setzen(daten);
  const stile = new Stile(), sst = new Zeichenketten();
  const blattTeile = blaetter.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, daten: blattXml(b, i === 0, rechner, stile, sst, formelText) }));
  const eintraege = [
    { name: '[Content_Types].xml', daten: typenXml(blaetter.length) },
    { name: '_rels/.rels', daten: PAKET_RELS },
    { name: 'docProps/core.xml', daten: coreXml(titel, autor, zeit) },
    { name: 'docProps/app.xml', daten: APP },
    { name: 'xl/workbook.xml', daten: mappeXml(blaetter, namen) },
    { name: 'xl/_rels/workbook.xml.rels', daten: mappeRels(blaetter.length) },
    { name: 'xl/styles.xml', daten: stile.xml() },
    { name: 'xl/sharedStrings.xml', daten: sst.xml() },
    ...blattTeile,
  ];
  return new Blob([await zipSchreiben(eintraege, { zeit })], { type: MIME_XLSX });
}


// ---- Lesen ---------------------------------------------------------------------------------------------------------

/** Was beim Import wegfallen kann, in der Reihenfolge der Meldung. */
export const FEHLTE_ARTEN_XLSX = Object.freeze(['diagramme', 'pivot', 'bedingt', 'verbunden', 'makros', 'bilder', 'kommentare', 'links', 'datenpruefung', 'formeln', 'funktionen', 'groesse']);

// Namensräume (auch Strict OOXML) → Kurzname: SpreadsheetML ohne Präfix, Beziehungen r:
const NS_KURZ = new Map([
  [NS.main, ''], ['http://purl.oclc.org/ooxml/spreadsheetml/main', ''],
  [NS.r, 'r'], ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'r'],
]);
/** Eingebaute Zahlformate → Format der Zelle (null = Standard); andere eingebaute Formate bleiben Standard. */
const EINGEBAUT = new Map([
  [0, null], [1, null], [2, 'zahl2'], [3, null], [4, 'zahl2'], [5, 'euro'], [6, 'euro'], [7, 'euro'], [8, 'euro'], [9, 'prozent'], [10, 'prozent'],
  [14, 'datum'], [15, 'datum'], [16, 'datum'], [17, 'datum'], [22, 'datum'], [49, 'text'],
]);
const AUSRICHTUNG_LESEN = Object.freeze({ left: 'links', center: 'mitte', right: 'rechts' });
const DATUM_1904 = 1462; // Tage zwischen dem 1900- und dem 1904-System
const BREITE = Object.freeze({ min: 20, max: 1000 });
const HOEHE = Object.freeze({ min: 12, max: 400 });
const kaputt = () => new Error('xlsx_kaputt');
const wahr = (v) => v === '1' || String(v).toLowerCase() === 'true';
const begrenzt = (n, min, max) => Math.min(max, Math.max(min, n));
const lokalName = (n) => n.slice(n.indexOf(':') + 1);

/**
 * Präfixe auf die Kurznamen bringen (rekursiv, xmlns-Angaben gelten für ihren Teilbaum): SpreadsheetML-Elemente heißen
 * danach ohne Präfix (auch wenn die Datei x: schreibt), Attribute im Beziehungs-Namensraum r:…; alles andere bleibt.
 */
function namensraeume(knoten, bereich) {
  let b = bereich;
  for (const [a, v] of Object.entries(knoten.attribute)) {
    if (a !== 'xmlns' && !a.startsWith('xmlns:')) continue;
    if (b === bereich) b = new Map(bereich);
    b.set(a === 'xmlns' ? '' : a.slice(6), v);
  }
  const name = (n, element) => {
    const i = n.indexOf(':');
    if (i < 0 && !element) return n; // Attribute ohne Präfix gehören zu keinem Namensraum
    const p = i < 0 ? '' : n.slice(0, i);
    if (p === 'xml' || p === 'xmlns') return n;
    const kurz = NS_KURZ.get(b.get(p));
    if (kurz === undefined) return n;
    const lokal = i < 0 ? n : n.slice(i + 1);
    return kurz ? `${kurz}:${lokal}` : lokal;
  };
  knoten.name = name(knoten.name, true);
  const attribute = {};
  for (const [a, v] of Object.entries(knoten.attribute)) attribute[a === 'xmlns' || a.startsWith('xmlns:') ? a : name(a, false)] = v;
  knoten.attribute = attribute;
  for (const k of knoten.kinder) namensraeume(k, b);
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
  /** Teil als XML-Baum; fehlt → null, unlesbar → wirft xlsx_kaputt. `normal` = Präfixe normalisieren. */
  const xml = (name, normal = true) => {
    const schluessel = `${normal ? 'n' : 'r'}|${name}`;
    if (!cache.has(schluessel)) {
      const b = bytes(name);
      let w = null;
      if (b) {
        try { w = xmlLesen(xmlDekodieren(b)); } catch { throw kaputt(); }
        if (normal) namensraeume(w, new Map());
      }
      cache.set(schluessel, w);
    }
    return cache.get(schluessel);
  };
  return { namen: [...zip.keys()], bytes, xml };
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
    if (lokalName(r.name) !== 'Relationship') continue;
    const { Id: id, Target: ziel } = r.attribute;
    if (!id || typeof ziel !== 'string' || aus.has(id)) continue;
    const extern = /^external$/i.test(r.attribute.TargetMode || '');
    aus.set(id, { typ: String(r.attribute.Type || ''), ziel: extern ? ziel : pfadAufloesen(ordner, ziel), extern });
  }
  return aus;
}

/** Text eines si- bzw. is-Elements: eigenes t oder die Läufe r/t verbunden; Lautschrift (rPh) fällt weg. */
function zeichenkette(k) {
  if (!k) return null;
  const t = kind(k, 't');
  return (t ? t.text : '') + kinder(k, 'r').map((r) => kind(r, 't')?.text ?? '').join('');
}

/** Eigener Zahlformat-Code → Format der Zelle: € → euro, % → prozent, d m y → datum, @ → text, 0.00 → zahl2. */
function zahlformatAusCode(code) {
  const s = String(code ?? '');
  if (s.includes('€')) return 'euro'; // auch [$€-407]
  const ohne = s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, ''); // Text, \x und [Rot]/[$-407] zählen nicht
  if (ohne.includes('%')) return 'prozent';
  if (/[dmy]/i.test(ohne)) return 'datum';
  if (ohne.includes('@')) return 'text';
  if (ohne.includes('0.00')) return 'zahl2';
  return null;
}

/** ARGB/RGB in rgb → #rrggbb; Theme- und Index-Farben und die Standardfarbe `aus` → null. */
function farbeVon(k, aus) {
  const m = k ? /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(k.attribute.rgb ?? '') : null;
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return hex === aus ? null : `#${hex}`;
}

/** An/aus-Eigenschaft (b, i): vorhanden und nicht 0/false. */
const an = (k) => !!k && !['0', 'false'].includes(String(k.attribute.val ?? '').toLowerCase());

/** styles.xml → je Index in cellXfs das Format f (nur gesetzte Felder) oder null. */
function stileLesen(st) {
  if (!st) return [];
  const codes = new Map(kinder(kind(st, 'numFmts'), 'numFmt').map((n) => [Number(n.attribute.numFmtId), n.attribute.formatCode]));
  const schriften = kinder(kind(st, 'fonts'), 'font').map((f) => ({ fett: an(kind(f, 'b')), kursiv: an(kind(f, 'i')), farbe: farbeVon(kind(f, 'color'), '000000') }));
  const fuellungen = kinder(kind(st, 'fills'), 'fill').map((f) => {
    const p = kind(f, 'patternFill');
    return p && p.attribute.patternType === 'solid' ? farbeVon(kind(p, 'fgColor'), 'ffffff') : null;
  });
  return kinder(kind(st, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(xf.attribute.numFmtId ?? 0);
    const zahl = EINGEBAUT.has(id) ? EINGEBAUT.get(id) : codes.has(id) ? zahlformatAusCode(codes.get(id)) : null;
    const schrift = schriften[Number(xf.attribute.fontId ?? 0)], hinter = fuellungen[Number(xf.attribute.fillId ?? 0)] ?? null;
    const h = kind(xf, 'alignment')?.attribute.horizontal;
    const f = {};
    if (schrift?.fett) f.fett = true;
    if (schrift?.kursiv) f.kursiv = true;
    if (schrift?.farbe) f.farbe = schrift.farbe;
    if (hinter) f.hinter = hinter;
    if (Object.hasOwn(AUSRICHTUNG_LESEN, h ?? '')) f.ausr = AUSRICHTUNG_LESEN[h];
    if (zahl) f.zahl = zahl;
    return Object.keys(f).length ? f : null;
  });
}

/** Alle Nachfahren, deren Name (ohne Präfix) `name` ist, zählen. */
function zaehlen(knoten, name) {
  let n = 0;
  const offen = knoten ? [knoten] : [];
  while (offen.length) {
    const k = offen.pop();
    if (lokalName(k.name) === name) n++;
    offen.push(...k.kinder);
  }
  return n;
}

/**
 * Gespeicherter Wert einer Zelle → w: t="s" gemeinsame Zeichenkette, inlineStr, b → TRUE/FALSE, e → =#…(unbekannte
 * Fehlerwerte wie #SPILL! → #VALUE!), str → Text, d (ISO-Datum) → Seriennummer, sonst Zahl (1904-System: Datum + 1462).
 * → { w, datum } (datum: Wert ist ein Datum ohne Datumsformat) | null
 */
function gespeicherterWert(c, t, v, f, lx) {
  switch (t) {
    case 's': { const s = v === null ? undefined : lx.sst[Number(v)]; return typeof s === 'string' ? { w: textIntern(s) } : null; }
    case 'inlineStr': { const s = zeichenkette(kind(c, 'is')); return s === null ? null : { w: textIntern(s) }; }
    case 'b': return v === null ? null : { w: wahr(v) ? 'TRUE' : 'FALSE' };
    case 'e': return v === null ? null : { w: `=${fehlerAusCode(v.trim()) ? v.trim() : '#VALUE!'}` };
    case 'str': return v === null ? null : { w: textIntern(v) };
    case 'd': {
      if (v === null) return null;
      const serie = datumLesen(v.trim().replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)?$/, ''));
      return serie === null ? { w: textIntern(v) } : { w: String(serie), datum: true };
    }
    default: {
      if (v === null || v.trim() === '') return null;
      let n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (lx.datum1904 && f?.zahl === 'datum') n += DATUM_1904;
      return { w: String(n + 0) };
    }
  }
}

/** Ein Arbeitsblatt lesen → {zellen, spalten, zeilen, fixiert}; zählt in lx, was wegfällt. */
function blattLesen(ws, blattId, lx) {
  const zellen = {}, spalten = {}, zeilen = {};
  const geteilt = new Map(); // si → {text, z, s} der gemeinsamen Formel
  const sheetData = kind(ws, 'sheetData');
  let zeileNr = 0;
  for (const row of kinder(sheetData, 'row')) {
    const r = Number(row.attribute.r);
    zeileNr = Number.isInteger(r) && r >= 1 ? r : zeileNr + 1;
    const ht = Number(row.attribute.ht);
    if (wahr(row.attribute.customHeight) && Number.isFinite(ht) && zeileNr <= GRENZEN.zeilen) zeilen[String(zeileNr)] = { hoehe: begrenzt(Math.round((ht * 4) / 3), HOEHE.min, HOEHE.max) };
    let spalte = 0;
    for (const c of kinder(row, 'c')) {
      const o = c.attribute.r ? adresseLesen(String(c.attribute.r).toUpperCase().replace(/\$/g, ''), EXCEL_MAX) : null;
      const z = o ? o.z : zeileNr, s = o ? o.s : spalte + 1;
      spalte = s;
      const fk = kind(c, 'f'), vk = kind(c, 'v');
      const f = c.attribute.s !== undefined ? lx.stile[Number(c.attribute.s)] ?? null : null;
      // gemeinsame Formel: die erste Zelle trägt den Text, die übrigen nur si – merken, bevor die Grenze greift
      if (fk && fk.attribute.t === 'shared' && fk.attribute.si !== undefined && fk.text.trim() !== '') geteilt.set(fk.attribute.si, { text: fk.text, z, s });
      if (!fk && !vk && !kind(c, 'is') && !f) continue;
      if (z > GRENZEN.zeilen || s > GRENZEN.spalten || lx.zellen >= GRENZEN.zellen_mappe) { lx.zahl.groesse++; continue; }

      const t = c.attribute.t ?? 'n', v = vk ? vk.text : null;
      let wert = null, formel = null, nurWert = false;
      if (fk) {
        const ft = fk.attribute.t ?? 'normal';
        if (ft === 'shared' && fk.attribute.si !== undefined) {
          const m = geteilt.get(fk.attribute.si);
          if (m) formel = m.z === z && m.s === s ? m.text : formelVerschieben(m.text, z - m.z, s - m.s, 'excel');
          else nurWert = true;
        } else if (ft === 'normal') formel = fk.text;
        else nurWert = true; // Matrix- und Datentabellen-Formeln gibt es hier nicht
      }
      if (formel !== null && formel.trim() !== '') {
        const e = excelZuIntern(formel, { blaetter: lx.blaetter });
        if (e.fehler) nurWert = true;
        else {
          wert = { w: `=${e.w}` };
          if (e.unbekannt.length) { lx.zahl.funktionen++; for (const n of e.unbekannt) lx.funktionsNamen.add(n); }
        }
      } else if (fk && !nurWert) nurWert = true; // leere Formel
      if (nurWert) lx.zahl.formeln++;
      if (!wert) wert = gespeicherterWert(c, t, v, f, lx);

      const zelle = {}, w = wert?.w ?? null;
      if (w !== null && w !== '') zelle.w = w.length > GRENZEN.w && !w.startsWith('=') ? w.slice(0, GRENZEN.w) : w;
      const fNeu = f ? { ...f } : {};
      if (wert?.datum && !fNeu.zahl) fNeu.zahl = 'datum';
      if (Object.keys(fNeu).length) zelle.f = fNeu;
      if (!Object.keys(zelle).length) continue;
      const adr = adresse(z, s);
      if (!Object.hasOwn(zellen, adr)) lx.zellen++;
      zellen[adr] = zelle;
    }
  }

  for (const cols of kinder(ws, 'cols')) {
    for (const col of kinder(cols, 'col')) {
      const breite = Number(col.attribute.width), min = Number(col.attribute.min), max = Math.min(Number(col.attribute.max), GRENZEN.spalten);
      if (!wahr(col.attribute.customWidth) || !Number.isFinite(breite) || !Number.isInteger(min) || !Number.isInteger(max) || min < 1) continue;
      for (let n = min; n <= max; n++) spalten[spalteZuText(n)] = { breite: begrenzt(Math.round(breite * 7 + 5), BREITE.min, BREITE.max) };
    }
  }
  const pane = kind(kind(kind(ws, 'sheetViews'), 'sheetView'), 'pane');
  const fixiert = { zeilen: pane && Number(pane.attribute.ySplit) === 1 && pane.attribute.state === 'frozen' ? 1 : 0 };

  lx.zahl.bedingt += kinder(ws, 'conditionalFormatting').length;
  lx.zahl.verbunden += kinder(kind(ws, 'mergeCells'), 'mergeCell').length;
  lx.zahl.links += kinder(kind(ws, 'hyperlinks'), 'hyperlink').length;
  lx.zahl.datenpruefung += kinder(kind(ws, 'dataValidations'), 'dataValidation').length;
  return { id: blattId, zellen, spalten, zeilen, fixiert };
}

/**
 * .xlsx lesen → { daten, dateien: [], fehlte: [{art, anzahl, namen?}] } (fehlte in der Reihenfolge von
 * FEHLTE_ARTEN_XLSX, nur Arten mit Anzahl; namen nur bei 'funktionen'). Blatt-Kennungen über `id`. Fehler:
 * Error('xlsx_kaputt'), dazu die Fehler von zipLesen (zip_kaputt, zip_zu_gross, zip_nicht_unterstuetzt).
 */
export async function xlsxLesen(arrayBuffer, { id = neueId } = {}) {
  const paket = paketVon(await zipLesen(arrayBuffer));
  try {
    let haupt = 'xl/workbook.xml';
    for (const r of beziehungen(paket, '').values()) if (!r.extern && /\/officeDocument$/.test(r.typ)) { haupt = r.ziel; break; }
    const wb = paket.xml(haupt);
    if (!wb || wb.name !== 'workbook') throw kaputt();
    const rels = beziehungen(paket, haupt);
    const teil = (typ) => { for (const r of rels.values()) if (!r.extern && r.typ.endsWith(`/${typ}`)) return r.ziel; return null; };
    const sstXml = paket.xml(teil('sharedStrings') ?? 'xl/sharedStrings.xml');
    const lx = {
      sst: sstXml ? kinder(sstXml, 'si').map(zeichenkette) : [],
      stile: stileLesen(paket.xml(teil('styles') ?? 'xl/styles.xml')),
      datum1904: wahr(kind(wb, 'workbookPr')?.attribute.date1904 ?? ''),
      blaetter: [], zellen: 0, funktionsNamen: new Set(),
      zahl: Object.fromEntries(FEHLTE_ARTEN_XLSX.map((a) => [a, 0])),
    };

    // erst alle Blätter (Formeln dürfen auf spätere Blätter zeigen), Diagrammblätter zählen nur
    const eintraege = [];
    for (const sh of kinder(kind(wb, 'sheets'), 'sheet')) {
      const r = rels.get(sh.attribute['r:id']);
      if (r && /\/chartsheet$/.test(r.typ)) { lx.zahl.diagramme++; continue; }
      if (r && (r.extern || !/\/worksheet$/.test(r.typ))) continue; // Dialog- und Makroblätter gibt es hier nicht
      eintraege.push({ id: id(), name: String(sh.attribute.name ?? ''), teil: r ? r.ziel : null });
    }
    lx.blaetter = eintraege.map((e) => ({ id: e.id, name: e.name }));
    const namen = gueltigeNamen(eintraege, false);
    let pos = null;
    const blaetter = eintraege.map((e) => {
      const ws = e.teil ? paket.xml(e.teil) : null;
      const blatt = ws ? blattLesen(ws, e.id, lx) : { id: e.id, zellen: {}, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } };
      pos = zwischen(pos, null);
      return { id: e.id, name: namen.get(e.id), pos, zellen: blatt.zellen, spalten: blatt.spalten, zeilen: blatt.zeilen, fixiert: blatt.fixiert };
    });

    // Teile, die das Office nicht übernimmt (nur gezählt – ein unlesbarer Teil zählt nicht, statt den Import zu kippen)
    const sicher = (fn) => { try { return fn(); } catch { return 0; } };
    for (const n of paket.namen) {
      if (/^xl\/charts\/chart\d+\.xml$/i.test(n)) lx.zahl.diagramme++;
      else if (/^xl\/pivotTables\/pivotTable\d+\.xml$/i.test(n)) lx.zahl.pivot++;
      else if (/^xl\/vbaProject\.bin$/i.test(n)) lx.zahl.makros = 1;
      else if (/^xl\/drawings\/[^/]+\.xml$/i.test(n)) lx.zahl.bilder += sicher(() => zaehlen(paket.xml(n, false), 'pic'));
      else if (/^xl\/comments[^/]*\.xml$/i.test(n)) lx.zahl.kommentare += sicher(() => zaehlen(kind(paket.xml(n), 'commentList'), 'comment'));
    }

    const daten = { blaetter };
    datenPruefen(daten);
    const funktionsNamen = [...lx.funktionsNamen].sort();
    return {
      daten,
      dateien: [],
      fehlte: FEHLTE_ARTEN_XLSX.filter((a) => lx.zahl[a] > 0).map((a) => (a === 'funktionen' ? { art: a, anzahl: lx.zahl[a], namen: funktionsNamen } : { art: a, anzahl: lx.zahl[a] })),
    };
  } catch (e) {
    if (e && e.message === 'xlsx_kaputt') throw e;
    throw new Error('xlsx_kaputt', { cause: e });
  }
}
