// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übersetzen der Formeln der Office-Tabelle (Plan 06). Drei Schreibweisen derselben Formel (immer ohne führendes =):
// - deutsch (Oberfläche, Eingabe): SUMME(A1:B3;2,5), 'Mein Blatt'!A1, WAHR, #BEZUG!
// - intern (Daten):                SUM(A1:B3,2.5), [blattId]!A1, TRUE, #REF! – Blattbezüge über die ID, damit Umbenennen
//                                  und gleichzeitiges Anlegen gleichnamiger Blätter keine Formel umschreiben müssen
// - Excel (xlsx):                  wie intern, aber mit Blattnamen und _xlfn. vor neueren Funktionen
// Übersetzt wird Token für Token: nur Funktionsnamen, Zahlen (Dezimalzeichen), Trenner, Wahrheitswerte, Fehlerwerte und
// Bezüge (Blattvorsilbe, $ und Spalten groß) ändern sich, alles andere bleibt zeichengleich – auch Leerraum und Text.
// Dazu das Lesen einer Eingabe wie im deutschen Excel (1.234,5 · 12,5 % · 1.234,50 € · 18.10.2026 · WAHR · '0049) und
// der Weg zurück in die Bearbeitungszeile. Ohne DOM.

import { GRENZEN } from './adresse.js';
import { zerlegen, tokensText, bezugText, blattNameText } from './lexer.js';
import { parsen, FormelFehler } from './parser.js';
import { FUNKTIONEN, funktionAusDeutsch, funktionAufDeutsch } from './funktionen.js';
import { FEHLER_ANZEIGE, textIntern, wertAusW, zuText, datumLesen, serieZuDatum } from './werte.js';

// Blattnamen: nicht : \ / ? * [ ], keine Steuerzeichen (die xlsx-Datei könnte sie nicht schreiben).
const NAME_VERBOTEN = /[:\\/?*[\]\u0000-\u001f]/;
const nameSchluessel = (name) => String(name).toLowerCase();
const XL_VORSILBE = /^(?:_(?:xlfn|xlws)\.)+/i;
const ZAHL_DE = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?(?:[eE][+-]?\d+)?$/;
const ZAHL_EN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const WAHRHEITSWERT = /^(?:WAHR|FALSCH|TRUE|FALSE)$/i;
const zwei = (x) => String(x).padStart(2, '0');

/** Blatt mit diesem Namen (ohne Groß/Klein, bei doppelten Namen das erste in der Reihenfolge) → ID oder null. */
function blattIdVon(blaetter, name) {
  const k = nameSchluessel(name);
  for (const b of blaetter ?? []) if (nameSchluessel(b.name) === k) return b.id;
  return null;
}

/** Blatt-ID → Name; gelöscht → null. */
function blattNameVon(blaetter, id) {
  for (const b of blaetter ?? []) if (b.id === id) return b.name;
  return null;
}

/** Tokens im Quellmodus der Reihe nach umschreiben; fn(token, position) gibt das Token für die Zielschreibweise. */
function umschreiben(text, modus, fn) {
  let pos = 0;
  return zerlegen(text, modus).map((t) => { const neu = fn(t, pos); pos += t.text.length; return neu; });
}

const adresseIntern = (t) => bezugText({ blatt: null, von: t.von, bis: t.bis }, 'intern');

/** Deutsch → intern. Wirft FormelFehler (Grund 'blatt' bei unbekanntem Blattnamen, sonst wie parsen). */
export function zuIntern(text, { blaetter = [] } = {}) {
  const tokens = umschreiben(text, 'anzeige', (t, pos) => {
    switch (t.art) {
      case 'funktion': return { ...t, text: funktionAusDeutsch(t.name) ?? t.name }; // unbekannte: groß, sonst unverändert
      case 'zahl': return { ...t, text: t.text.replace(',', '.') };
      case 'trenner': return { ...t, text: ',' };
      case 'bool': return { ...t, text: t.wert ? 'TRUE' : 'FALSE' };
      case 'fehler': return { ...t, text: t.wert };
      case 'bezug': {
        if (t.blatt === null) return { ...t, text: adresseIntern(t) };
        const id = blattIdVon(blaetter, t.blatt);
        if (id === null) throw new FormelFehler('blatt', pos);
        return { ...t, text: bezugText({ blatt: id, von: t.von, bis: t.bis }, 'intern') };
      }
      default: return t;
    }
  });
  const intern = tokensText(tokens);
  parsen(intern, 'intern');
  return intern;
}

/** Intern → deutsch; ein Bezug auf ein gelöschtes Blatt wird #BEZUG!. */
export function zuAnzeige(text, { blaetter = [] } = {}) {
  return tokensText(umschreiben(text, 'intern', (t) => {
    switch (t.art) {
      case 'funktion': return { ...t, text: funktionAufDeutsch(t.name) ?? t.text };
      case 'zahl': return { ...t, text: t.text.replace('.', ',') };
      case 'trenner': return { ...t, text: ';' };
      case 'bool': return { ...t, text: t.wert ? 'WAHR' : 'FALSCH' };
      case 'fehler': return { ...t, text: FEHLER_ANZEIGE[t.wert] ?? t.text };
      case 'bezug': return { ...t, text: bezugText(t, 'anzeige', (id) => blattNameVon(blaetter, id)) };
      default: return t;
    }
  }));
}

/** Leerraum zwischen zwei Bezügen ist in Excel die Schnittmenge (A1:B2 B1:C2) – die gibt es hier nicht. */
function istSchnittmenge(tokens, i) {
  let v = i - 1, n = i + 1;
  while (v >= 0 && tokens[v].art === 'leer') v--;
  while (n < tokens.length && tokens[n].art === 'leer') n++;
  return v >= 0 && n < tokens.length && tokens[v].art === 'bezug' && tokens[n].art === 'bezug';
}

/**
 * Formel aus einer xlsx-Datei → { w, unbekannt } (w intern ohne =; unbekannte Funktionen behalten dort ihr _xlfn./_xlws.,
 * damit Excel sie nach dem Export wieder rechnet; unbekannt = ihre Namen ohne Vorsilbe, ohne Doppel) oder
 * { fehler: 'formeln' }, wenn die Formel hier nicht darstellbar ist:
 * Tabellenbezüge (Table1[Spalte]), Blattbereiche (Sheet1:Sheet2!A1), externe Mappen ([1]Blatt!A1), Schnittmengen,
 * unbekannte Blätter, unbekannte Zeichen oder Fehlerwerte (#NULL!, #SPILL!), Syntaxfehler, zu lang.
 */
export function excelZuIntern(text, { blaetter = [] } = {}) {
  const fehler = { fehler: 'formeln' };
  const tokens = zerlegen(text, 'excel');
  const unbekannt = [], aus = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.art === 'unbekannt' || (t.art === 'leer' && istSchnittmenge(tokens, i))) return fehler;
    if (t.art === 'funktion') {
      const name = t.name.replace(XL_VORSILBE, '');
      if (Object.hasOwn(FUNKTIONEN, name)) { aus.push({ ...t, text: name, name }); continue; }
      if (!unbekannt.includes(name)) unbekannt.push(name);
      aus.push(t); // unbekannt: mit _xlfn./_xlws. – so rechnet Excel sie nach dem Export wieder
    } else if (t.art === 'bezug') {
      if (t.blatt === null) { aus.push({ ...t, text: adresseIntern(t) }); continue; }
      const id = /[:[\]]/.test(t.blatt) ? null : blattIdVon(blaetter, t.blatt);
      if (id === null) return fehler;
      aus.push({ ...t, text: bezugText({ blatt: id, von: t.von, bis: t.bis }, 'intern') });
    } else if (t.art === 'fehler') aus.push({ ...t, text: t.wert });
    else if (t.art === 'bool') aus.push({ ...t, text: t.wert ? 'TRUE' : 'FALSE' });
    else aus.push(t);
  }
  const w = tokensText(aus);
  if (w.length + 1 > GRENZEN.formel) return fehler;
  try { parsen(w, 'intern'); } catch (e) {
    if (e instanceof FormelFehler) return fehler;
    throw e;
  }
  return { w, unbekannt };
}

/** Intern → Excel: Blatt-IDs werden die (exportierten) Blattnamen, ein gelöschtes Blatt wird #REF!. */
export function internZuExcel(text, { blaetter = [] } = {}) {
  return tokensText(zerlegen(text, 'intern').map((t) => {
    if (t.art === 'bezug' && t.blatt !== null) return { ...t, text: bezugText(t, 'excel', (id) => blattNameVon(blaetter, id)) };
    // _xlfn./_xlws. schreibt Excel klein – auch wenn die Formel in der Bearbeitungszeile groß geschrieben wurde
    if (t.art === 'funktion' && XL_VORSILBE.test(t.text)) return { ...t, text: t.text.replace(XL_VORSILBE, (v) => v.toLowerCase()) };
    return t;
  }));
}

// ---- Eingabe -----------------------------------------------------------------------------------------------------

/** Zahl als w: String(n), −0 → '0'. */
const zahlIntern = (n) => String(n + 0);

/** Zahl ohne Zeichen: deutsch (1.234,5) oder englisch (1234.5). → Zahl | null */
function zahlLesen(s, zahlen) {
  if (zahlen === 'en') return ZAHL_EN.test(s) ? Number(s) : null;
  return ZAHL_DE.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : null;
}

/** Zahl, optional mit % / „ %“ (÷ 100) oder € / „ €“ dahinter bzw. „€ “ davor. → {n, zahl?} | null */
function zahlEingabe(text, zahlen) {
  let s = text, zahl = null, m;
  if ((m = /^(.*?) ?%$/s.exec(s))) { s = m[1]; zahl = 'prozent'; } else if ((m = /^(.*?) ?€$/s.exec(s))) { s = m[1]; zahl = 'euro'; } else if ((m = /^€ ?(.*)$/s.exec(s))) { s = m[1]; zahl = 'euro'; }
  let n = zahlLesen(s, zahlen);
  if (n === null || !Number.isFinite(n)) return null;
  if (zahl === 'prozent') n = Number((n / 100).toPrecision(15)); // 1,1 % → 0.011, nicht 0.011000000000000001
  return zahl ? { n, zahl } : { n };
}

/**
 * Eingabe aus Zelle oder Bearbeitungszeile → { w, zahl? } (w = null: Zelle leeren). Reihenfolge: leer; Zellformat
 * Text → als Text; beginnt mit ' → wie getippt; = mit Inhalt → Formel (zuIntern, wirft FormelFehler); WAHR/FALSCH/
 * TRUE/FALSE; Zahl (deutsch bzw. mit zahlen 'en' englisch, optional Prozent oder Euro); Datum (T.M.JJJJ, T.M.JJ, T.M.,
 * JJJJ-MM-TT, optional Uhrzeit; ungültig → Text; reine Uhrzeit bleibt Text); sonst Text. `zahl` kommt nur, wenn ein
 * Format erkannt wurde.
 */
export function eingabeZuIntern(text, { blaetter = [], zahl = null, zahlen = 'de', formeln = true } = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s === '') return { w: null };
  if (zahl === 'text') return { w: textIntern(s) };
  if (s.startsWith("'")) return { w: s };
  if (formeln && s.length > 1 && s.startsWith('=')) {
    const w = `=${zuIntern(s.slice(1), { blaetter })}`;
    if (w.length > GRENZEN.formel) throw new FormelFehler('syntax', GRENZEN.formel);
    return { w };
  }
  if (WAHRHEITSWERT.test(s)) return { w: /^(?:WAHR|TRUE)$/i.test(s) ? 'TRUE' : 'FALSE' };
  const z = zahlEingabe(s, zahlen);
  if (z) return z.zahl ? { w: zahlIntern(z.n), zahl: z.zahl } : { w: zahlIntern(z.n) };
  const serie = datumLesen(s, new Date().getFullYear());
  if (serie !== null) return { w: zahlIntern(serie), zahl: 'datum' };
  return { w: textIntern(s) };
}

/** Seriennummer → „18.10.2026“, mit Uhrzeit „18.10.2026 14:30“ (Sekunden nur, wenn nicht 0). */
function datumEingabe(n) {
  const d = serieZuDatum(n);
  const tag = `${zwei(d.t)}.${zwei(d.m)}.${String(d.j).padStart(4, '0')}`;
  if (!d.std && !d.min && !d.sek) return tag;
  return `${tag} ${zwei(d.std)}:${zwei(d.min)}${d.sek ? `:${zwei(d.sek)}` : ''}`;
}

/**
 * w → Text für die Bearbeitungszeile, so dass dieselbe Eingabe wieder dasselbe ergibt: Formel deutsch, Zahl mit Komma
 * (Datum als Datum, Prozent mit %), WAHR/FALSCH, Text mit ' davor nur, wenn er getippt etwas anderes ergäbe ('0049).
 */
export function internZuEingabe(w, { blaetter = [], zahl = null } = {}) {
  if (typeof w !== 'string' || w === '') return '';
  if (w.startsWith('=')) return `=${zuAnzeige(w.slice(1), { blaetter })}`;
  const v = wertAusW(w);
  if (typeof v === 'boolean') return v ? 'WAHR' : 'FALSCH';
  if (typeof v === 'number') {
    if (zahl === 'datum' && v >= 1 && v < 2958466) return datumEingabe(v);
    if (zahl === 'prozent') return `${zuText(Number((v * 100).toPrecision(15)))} %`;
    return zuText(v);
  }
  if (typeof v !== 'string') return w; // nicht darstellbare Zahl (1e999): wie gespeichert
  let gleich = false;
  try {
    const e = eingabeZuIntern(v, { blaetter, zahl });
    gleich = e.w !== null && !e.w.startsWith('=') && wertAusW(e.w) === v;
  } catch { gleich = false; }
  return gleich ? v : `'${v}`;
}

// ---- Blattnamen --------------------------------------------------------------------------------------------------

/** Blattname, wie er in einer Formel steht: wenn nötig in Hochkommas ('Mein Blatt', 'A1', 'WAHR'). */
export function blattNameAnzeige(name) { return blattNameText(name); }

/**
 * Blattname prüfen → null oder Grund: 'leer', 'lang' (über 31 Zeichen), 'zeichen' (: \ / ? * [ ], Steuerzeichen oder '
 * am Anfang/Ende), 'doppelt' (ohne Groß/Klein schon vergeben; das Blatt eigeneId selbst zählt nicht).
 */
export function blattNamePruefen(name, blaetter = [], eigeneId = null) {
  const n = typeof name === 'string' ? name : '';
  if (n.trim() === '') return 'leer';
  if (n.length > GRENZEN.name) return 'lang';
  if (NAME_VERBOTEN.test(n) || n.startsWith("'") || n.endsWith("'")) return 'zeichen';
  const k = nameSchluessel(n);
  return (blaetter ?? []).some((b) => b.id !== eigeneId && nameSchluessel(b.name) === k) ? 'doppelt' : null;
}
