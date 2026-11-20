// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// CSV der Office-Tabelle (Plan 06): Zeichensatz erkennen (UTF-8 mit/ohne BOM, UTF-16LE mit BOM, sonst Windows-1252 wie
// aus dem deutschen Excel – mit eigener Tabelle, ohne ICU), Trennzeichen erkennen, Felder nach RFC 4180 lesen,
// schreiben mit Semikolon, CRLF und BOM (so öffnet das deutsche Excel Umlaute richtig). Ein Blatt wird so exportiert,
// wie es angezeigt wird (Zahlformate, Formelergebnisse); Text, der in einem anderen Programm als Formel liefe (=, +, -,
// @, Tab, CR am Anfang), bekommt ein ' davor. Beim Import wird jedes Feld wie getippt gelesen, aber nie als Formel.
// Ohne DOM.

import { GRENZEN, adresse, adresseLesen } from './formeln/adresse.js';
import { wertAnzeigen } from './formeln/werte.js';
import { eingabeZuIntern } from './formeln/uebersetzen.js';

/** Trennzeichen in der Reihenfolge, in der sie Gleichstände gewinnen. */
const KANDIDATEN = Object.freeze([';', '\t', ',']);
const PROBEZEILEN = 20;
const BOM = '﻿';
// Windows-1252 0x80–0x9F; die fünf freien Stellen (0x81, 0x8D, 0x8F, 0x90, 0x9D) bleiben wie in Latin-1
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
// Ein Feld braucht Anführungszeichen, wenn es Trenner, ", CR oder LF enthält oder mit Leerraum beginnt bzw. endet
const MUSS_QUOTE = /[;"\r\n]|^\s|\s$/;
const SCHUTZ = /^[=+\-@\t\r]/;
const NAME_VERBOTEN = /[:\\/?*[\]\u0000-\u001f]/g;
/** Zellschlüssel dürfen nach dem Einfügen jenseits von GRENZEN liegen – exportiert wird trotzdem alles. */
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });

/** Bytes als Windows-1252 (in Stücken, damit auch 15 MB nicht am Argument-Limit scheitern). */
function windows1252(bytes) {
  const teile = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const stueck = bytes.subarray(i, i + 8192);
    teile.push(String.fromCharCode(...Array.from(stueck, (b) => (b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : b))));
  }
  return teile.join('');
}

/** Bytes einer CSV-Datei → Text: BOM EF BB BF → UTF-8, FF FE → UTF-16LE, sonst UTF-8 oder (ungültig) Windows-1252. */
export function csvDekodieren(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return windows1252(b);
  }
}

/**
 * Trennzeichen aus bis zu 20 Zeilen (leere zählen nicht): Trenner außerhalb von Anführungszeichen je Zeile zählen;
 * Kandidat ist, wer in allen Probezeilen gleich oft und mindestens einmal vorkommt; davon der häufigste, bei Gleichstand
 * ; vor Tab vor Komma; keiner → ;.
 */
function trennerErkennen(s) {
  const proben = [];
  let zahl = { ';': 0, '\t': 0, ',': 0 }, inhalt = false, inQuotes = false;
  for (let i = 0; i < s.length && proben.length < PROBEZEILEN; i++) {
    const c = s[i];
    if (c === '"') { inQuotes = !inQuotes; inhalt = true; continue; }
    if (!inQuotes && (c === '\n' || c === '\r')) {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (inhalt) proben.push(zahl);
      zahl = { ';': 0, '\t': 0, ',': 0 }; inhalt = false;
      continue;
    }
    inhalt = true;
    if (!inQuotes && Object.hasOwn(zahl, c)) zahl[c]++;
  }
  if (inhalt && proben.length < PROBEZEILEN) proben.push(zahl);
  let trenner = ';', beste = 0;
  for (const k of KANDIDATEN) {
    const n = proben.length ? proben[0][k] : 0;
    if (n > beste && proben.every((p) => p[k] === n)) { trenner = k; beste = n; }
  }
  return trenner;
}

/**
 * Felder nach RFC 4180 mit dem Trenner t: ein Feld in Anführungszeichen darf Trenner und Zeilenumbrüche enthalten, ""
 * ist ein "; Zeichen nach dem schließenden " und " mitten im Feld gelten wörtlich; ein offenes " nimmt den Rest der
 * Datei. Zeilenenden CRLF, LF oder CR; eine letzte leere Zeile entfällt. (Auch für TSV aus der Zwischenablage.)
 */
export function felderLesen(s, t) {
  const zeilen = [], n = s.length;
  let zeile = [], i = 0;
  for (;;) {
    let feld = '';
    if (s[i] === '"') {
      i++;
      for (;;) {
        const q = s.indexOf('"', i);
        if (q < 0) { feld += s.slice(i); i = n; break; }
        feld += s.slice(i, q);
        if (s[q + 1] === '"') { feld += '"'; i = q + 2; continue; }
        i = q + 1;
        break;
      }
    }
    let j = i;
    while (j < n && s[j] !== t && s[j] !== '\n' && s[j] !== '\r') j++;
    zeile.push(feld + s.slice(i, j));
    if (j >= n) { zeilen.push(zeile); break; }
    if (s[j] === t) { i = j + 1; continue; }
    i = s[j] === '\r' && s[j + 1] === '\n' ? j + 2 : j + 1;
    zeilen.push(zeile);
    zeile = [];
    if (i >= n) break;
  }
  const letzte = zeilen[zeilen.length - 1];
  if (letzte && letzte.length === 1 && letzte[0] === '') zeilen.pop();
  return zeilen;
}

/** CSV-Text (BOM wird entfernt) → { zeilen: string[][], trenner }. */
export function csvLesen(text) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  if (s.startsWith(BOM)) s = s.slice(1);
  const trenner = trennerErkennen(s);
  return { zeilen: felderLesen(s, trenner), trenner };
}

const feldText = (f) => {
  const s = typeof f === 'string' ? f : String(f ?? '');
  return MUSS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const zeileText = (felder) => `${felder.map(feldText).join(';')}\r\n`;

/** Zeilen → CSV mit BOM, Semikolon und CRLF (auch nach der letzten Zeile); Anführungszeichen nur, wo nötig. */
export function csvSchreiben(zeilen) {
  return BOM + (zeilen ?? []).map(zeileText).join('');
}

/** Text, den ein Tabellenprogramm als Formel ausführen würde (= + - @, Tab, CR am Anfang) → mit ' davor. */
export function csvSchutz(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return SCHUTZ.test(s) ? `'${s}` : s;
}

/**
 * Ein Blatt als CSV, wie es angezeigt wird: Bereich A1 bis zur letzten Zeile/Spalte mit Inhalt (Zellen nur mit Format
 * zählen nicht), Werte aus dem Rechner im Zahlformat der Zelle; csvSchutz nur für Zellen, deren Wert Text ist.
 */
export function blattZuCsv(daten, blattId, rechner) {
  const blatt = (daten?.blaetter ?? []).find((b) => b.id === blattId);
  const zeilen = new Map(); // z → Map<s, Anzeigetext>
  let zMax = 0, sMax = 0;
  for (const [adr, zelle] of Object.entries(blatt?.zellen ?? {})) {
    if (typeof zelle?.w !== 'string' || zelle.w === '') continue;
    const o = adresseLesen(adr, OHNE_GRENZEN);
    if (!o) continue;
    const wert = rechner.wert(blattId, adr);
    const text = wertAnzeigen(wert, zelle.f?.zahl ?? null);
    let zeile = zeilen.get(o.z);
    if (!zeile) zeilen.set(o.z, (zeile = new Map()));
    zeile.set(o.s, typeof wert === 'string' ? csvSchutz(text) : text);
    zMax = Math.max(zMax, o.z); sMax = Math.max(sMax, o.s);
  }
  const teile = [BOM], leer = `${';'.repeat(Math.max(0, sMax - 1))}\r\n`;
  for (let z = 1; z <= zMax; z++) {
    const zeile = zeilen.get(z);
    if (!zeile) { teile.push(leer); continue; }
    const felder = new Array(sMax).fill('');
    for (const [s, text] of zeile) felder[s - 1] = text;
    teile.push(zeileText(felder));
  }
  return teile.join('');
}

/** Blattname aus dem Dateinamen: auf 31 Zeichen gekürzt, verbotene Zeichen und ' am Rand → _, leer → Tabelle1. */
function blattName(name) {
  let n = typeof name === 'string' ? name : '';
  if (n.length > GRENZEN.name) n = n.slice(0, /[\ud800-\udbff]/.test(n[GRENZEN.name - 1]) ? GRENZEN.name - 1 : GRENZEN.name);
  n = n.replace(NAME_VERBOTEN, '_').replace(/^'/, '_').replace(/'$/, '_');
  return n.trim() === '' ? 'Tabelle1' : n;
}

/**
 * CSV-Text → { daten, fehlte }: ein Blatt „blatt1“ mit dem Namen `name`; jedes Feld wie getippt gelesen (deutsche
 * Zahlen und Daten, beim Komma-Trenner englische Zahlen), nie als Formel; ein erkanntes Zahlformat wird f.zahl. Felder
 * jenseits von GRENZEN.zeilen/.spalten oder über GRENZEN.zellen_mappe entfallen und zählen als 'groesse'; Text über
 * GRENZEN.w Zeichen wird gekürzt.
 */
export function csvZuDaten(text, { name = '' } = {}) {
  const { zeilen, trenner } = csvLesen(text);
  const zahlen = trenner === ',' ? 'en' : 'de';
  const zellen = {};
  let anzahl = 0, zuGross = 0;
  for (let i = 0; i < zeilen.length; i++) {
    const felder = zeilen[i];
    for (let j = 0; j < felder.length; j++) {
      if (felder[j] === '') continue;
      if (i + 1 > GRENZEN.zeilen || j + 1 > GRENZEN.spalten || anzahl >= GRENZEN.zellen_mappe) { zuGross++; continue; }
      const e = eingabeZuIntern(felder[j], { zahlen, formeln: false });
      if (e.w === null) continue;
      const zelle = { w: e.w.length > GRENZEN.w ? e.w.slice(0, GRENZEN.w) : e.w };
      if (e.zahl) zelle.f = { zahl: e.zahl };
      zellen[adresse(i + 1, j + 1)] = zelle;
      anzahl++;
    }
  }
  // pos 'i' wie das erste Blatt einer neuen Mappe (leer())
  const blatt = { id: 'blatt1', name: blattName(name), pos: 'i', zellen, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } };
  return { daten: { blaetter: [blatt] }, fehlte: zuGross ? [{ art: 'groesse', anzahl: zuGross }] : [] };
}
