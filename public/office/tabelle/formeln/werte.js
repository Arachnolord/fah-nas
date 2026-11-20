// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Werte der Office-Tabelle (Plan 06): Fehlerwerte, die interne Form der Zellen (w), Zwang zwischen Zahl, Text und
// Wahrheitswert wie Excel, Datum im 1900-System von Excel (mit dem Schaltjahrfehler 29.02.1900), die Anzeige der
// Zahlformate, die Formate der Funktion TEXT und die Kriterien von SUMMEWENN/ZÄHLENWENN. Zahlen werden ohne Intl
// formatiert, damit die Anzeige nicht von der ICU-Ausstattung abhängt; nur Textvergleiche nutzen die deutsche
// Sortierung. Ohne DOM – der Web-Dienst lädt die Datei über den Sync-Typ.

// ---- Fehlerwerte -------------------------------------------------------------------------------------------------

const fehler = (code) => Object.freeze({ fehler: code });
/** Die Fehlerwerte des Rechners; intern englisch, #CIRC ist ein Zirkelbezug. */
export const FEHLER = Object.freeze({
  DIV0: fehler('#DIV/0!'), NAME: fehler('#NAME?'), REF: fehler('#REF!'), VALUE: fehler('#VALUE!'), NA: fehler('#N/A'), NUM: fehler('#NUM!'), CIRC: fehler('#CIRC'),
});
/** Englischer Code → deutsche Anzeige. */
export const FEHLER_ANZEIGE = Object.freeze({
  '#DIV/0!': '#DIV/0!', '#NAME?': '#NAME?', '#REF!': '#BEZUG!', '#VALUE!': '#WERT!', '#N/A': '#NV', '#NUM!': '#ZAHL!', '#CIRC': '#ZIRKEL',
});
/** Englischer Code → Code in der xlsx-Datei; Excel kennt keinen Zirkel-Fehlerwert. */
export const FEHLER_EXCEL = Object.freeze({
  '#DIV/0!': '#DIV/0!', '#NAME?': '#NAME?', '#REF!': '#REF!', '#VALUE!': '#VALUE!', '#N/A': '#N/A', '#NUM!': '#NUM!', '#CIRC': '#VALUE!',
});
const NACH_CODE = new Map(Object.values(FEHLER).map((f) => [f.fehler, f]));

/** Ist der Wert ein Fehlerwert? */
export function istFehler(w) { return w !== null && typeof w === 'object' && typeof w.fehler === 'string'; }

/** Englischer Fehlercode (wie im Lexer-Token) → Fehlerwert aus FEHLER; unbekannt → null. */
export function fehlerAusCode(code) { return NACH_CODE.get(code) ?? null; }

// ---- Interne Form ------------------------------------------------------------------------------------------------

/** So steht eine Zahl in w: Punkt als Dezimalzeichen, optional Exponent. */
export const ZAHL_INTERN = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const WAHRHEIT_INTERN = /^(?:TRUE|FALSE)$/;

/** Text → w: was wie Zahl, Wahrheitswert, Formel oder „'…“ aussähe, bekommt ein ' davor. */
export function textIntern(s) {
  const t = String(s);
  return ZAHL_INTERN.test(t) || WAHRHEIT_INTERN.test(t) || t.startsWith('=') || t.startsWith("'") ? `'${t}` : t;
}

/** w (keine Formel) → Wert: Zahl, Wahrheitswert, Text (ohne das führende ') oder null für leer. */
export function wertAusW(w) {
  if (typeof w !== 'string' || w === '') return null;
  if (w.startsWith("'")) return w.slice(1);
  if (w === 'TRUE') return true;
  if (w === 'FALSE') return false;
  if (ZAHL_INTERN.test(w)) {
    const n = Number(w);
    return Number.isFinite(n) ? n + 0 : FEHLER.NUM; // + 0 macht aus -0 eine 0
  }
  return w;
}

// ---- Zahlen als Text ---------------------------------------------------------------------------------------------

/** Zahl ohne Exponentenschreibweise (String() schreibt kleine Zahlen als 1e-7). */
function ohneExponent(x) {
  const s = String(x);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const e = Number(m[4]), ziffern = m[2] + (m[3] ?? '');
  return e < 0 ? `${m[1]}0.${'0'.repeat(-e - 1)}${ziffern}` : m[1] + ziffern.padEnd(e + 1, '0');
}

/** Format „Standard“: `stellen` gültige Ziffern, ab `gross` oder unter 1e-9 mit Exponent (1,23457E+11). */
function allgemein(n, stellen, gross, expStellen) {
  if (!Number.isFinite(n)) return FEHLER_ANZEIGE['#NUM!'];
  if (n === 0) return '0';
  const b = Math.abs(n);
  if (b >= gross || b < 1e-9) {
    const [mantisse, exp] = n.toExponential(expStellen).split('e');
    const e = Number(exp);
    return `${mantisse.replace(/\.?0+$/, '').replace('.', ',')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  return ohneExponent(Number(n.toPrecision(stellen))).replace('.', ',');
}

/**
 * Zahl im Format „Standard“ der Zelle: 10 gültige Ziffern, Komma, keine Tausenderpunkte; elfstellige ganze Zahlen
 * bleiben vollständig (12345678901, nicht 12345678900).
 */
export function zahlText(n) { return allgemein(n, Math.abs(n) >= 1e10 ? 11 : 10, 1e11, 5); }

// Zahl als Text in Formeln (& , VERKETTEN, Kriterien): 15 gültige Ziffern wie Excel, ohne die Breitenregel der Zelle.
const zahlTextVoll = (n) => allgemein(n, 15, 1e15, 14);

/** Ganze Zahl ≥ 0 mit höchstens 15 gültigen Ziffern → Ziffernfolge (auch über 1e21 ohne Exponent). */
function ganzzahlText(x) {
  if (x < 1e15) return String(x);
  const [mantisse, exp] = x.toExponential(14).split('e+');
  return mantisse.replace('.', '').padEnd(Number(exp) + 1, '0');
}

/**
 * Betrag ≥ 0 auf `stellen` Nachkommastellen, halb vom Nullpunkt weg und auf 15 Stellen gerechnet wie Excel
 * (2,675 → 2,68) → {ganz, bruch} als Ziffernfolgen; Überlauf → null.
 */
function ziffern(betrag, stellen) {
  const skaliert = Number((betrag * 10 ** stellen).toPrecision(15));
  if (!Number.isFinite(skaliert)) return null;
  const s = ganzzahlText(Math.round(skaliert)).padStart(stellen + 1, '0');
  return { ganz: s.slice(0, s.length - stellen), bruch: s.slice(s.length - stellen) };
}

const gruppieren = (ganz) => ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const zwei = (x) => String(x).padStart(2, '0');

/** Feste Nachkommastellen mit Tausenderpunkten; was auf 0 rundet, bekommt kein Minus. */
function festText(n, stellen) {
  const z = ziffern(Math.abs(n), stellen);
  if (z === null) return zahlText(n);
  const minus = n < 0 && /[1-9]/.test(z.ganz + z.bruch) ? '-' : '';
  return minus + gruppieren(z.ganz) + (stellen > 0 ? `,${z.bruch}` : '');
}

/** Deutsch geschriebene Zahl (1.234,5 – Punkte nur in Dreiergruppen, auch ,5 und 1e3) → Zahl; sonst null. */
const DE_ZAHL = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d*)(?:,(\d+))?(?:[eE]([+-]?\d+))?$/;
export function deZahlLesen(text) {
  if (typeof text !== 'string') return null;
  const m = DE_ZAHL.exec(text.trim());
  if (!m || (m[2] === '' && m[3] === undefined)) return null;
  const n = Number(`${m[1]}${m[2].replace(/\./g, '') || '0'}.${m[3] ?? '0'}e${m[4] ?? '0'}`);
  return Number.isFinite(n) ? n + 0 : null;
}

// ---- Datum (1900-System) -----------------------------------------------------------------------------------------

const TAG_MS = 86400000;
const BASIS = Date.UTC(1899, 11, 30); // Serie 0 ab dem 01.03.1900; davor zählt Excel ab dem 31.12.1899
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const TAGE_KURZ = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
/** Höchste Seriennummer (31.12.9999) + 1. */
const SERIE_ENDE = 2958466;

/** Tage seit dem 30.12.1899 (UTC, ohne Sommerzeit); Jahre unter 100 bleiben, wie sie sind. */
function utcTage(j, m, t) {
  const d = new Date(BASIS);
  d.setUTCFullYear(j, m - 1, t);
  return Math.round((d.getTime() - BASIS) / TAG_MS);
}

/** Jahr, Monat (1–12), Tag → Seriennummer wie Excel: 01.01.1900 = 1, 29.02.1900 = 60 (gibt es nur in Excel), 01.03.1900 = 61. */
export function datumZuSerie(j, m, t) {
  if (j === 1900 && m === 2 && t === 29) return 60;
  const tage = utcTage(j, m, t);
  return tage >= 61 ? tage : tage - 1;
}

/** Seriennummer → {j, m, t, std, min, sek}; der Bruchteil wird auf ganze Sekunden gerundet. */
export function serieZuDatum(n) {
  let tag = Math.floor(n), sek = Math.round((n - tag) * 86400);
  if (sek >= 86400) { tag += 1; sek -= 86400; }
  let j = 1900, m = 2, t = 29;
  if (tag !== 60) {
    const d = new Date(BASIS + (tag < 60 ? tag + 1 : tag) * TAG_MS);
    j = d.getUTCFullYear(); m = d.getUTCMonth() + 1; t = d.getUTCDate();
  }
  return { j, m, t, std: Math.floor(sek / 3600), min: Math.floor(sek / 60) % 60, sek: sek % 60 };
}

/** Zeitpunkt (Ortszeit des Browsers bzw. Servers) → Seriennummer mit Uhrzeit, für JETZT und HEUTE. */
export function jetztSerie(date) {
  const tag = datumZuSerie(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return tag + (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000) / 86400;
}

function gueltigesDatum(j, m, t) {
  if (j < 1900 || j > 9999 || m < 1 || m > 12 || t < 1) return false;
  if (j === 1900 && m === 2 && t === 29) return true;
  return t <= new Date(Date.UTC(j, m, 0)).getUTCDate();
}

const DATUM_DE = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const DATUM_ISO = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Deutsch oder ISO geschriebenes Datum → Seriennummer (mit Uhrzeit als Bruchteil); ungültig → null. Formen: T.M.JJJJ,
 * T.M.JJ (00–29 → 20xx, 30–99 → 19xx), T.M. (nur mit `jahr`), JJJJ-MM-TT, jeweils optional „ HH:MM[:SS]“.
 */
export function datumLesen(text, jahr = null) {
  if (typeof text !== 'string') return null;
  let j, m, t, zeit, x = DATUM_DE.exec(text);
  if (x) {
    t = Number(x[1]); m = Number(x[2]);
    if (x[3] === undefined) { if (jahr === null) return null; j = jahr; } else j = x[3].length === 2 ? (Number(x[3]) < 30 ? 2000 : 1900) + Number(x[3]) : Number(x[3]);
    zeit = x.slice(4, 7);
  } else if ((x = DATUM_ISO.exec(text))) {
    j = Number(x[1]); m = Number(x[2]); t = Number(x[3]);
    zeit = x.slice(4, 7);
  } else return null;
  if (!gueltigesDatum(j, m, t)) return null;
  let serie = datumZuSerie(j, m, t);
  if (zeit[0] !== undefined) {
    const std = Number(zeit[0]), min = Number(zeit[1]), sek = Number(zeit[2] ?? 0);
    if (std > 23 || min > 59 || sek > 59) return null;
    serie += (std * 3600 + min * 60 + sek) / 86400;
  }
  return serie;
}

// ---- Zwang und Vergleich -----------------------------------------------------------------------------------------

/** WAHR/FALSCH/TRUE/FALSE (Groß/Klein egal) → Wahrheitswert; sonst null. */
function boolAusText(s) {
  const g = s.trim().toUpperCase();
  return g === 'WAHR' || g === 'TRUE' ? true : g === 'FALSCH' || g === 'FALSE' ? false : null;
}

/** Wert → Zahl: Wahrheitswert 1/0, leer 0, Text nach deutschen Regeln, sonst #VALUE!. Fehler bleiben. */
export function zuZahl(w) {
  if (istFehler(w)) return w;
  if (w === null || w === undefined) return 0;
  if (typeof w === 'number') return w;
  if (typeof w === 'boolean') return w ? 1 : 0;
  if (typeof w === 'string') { const n = deZahlLesen(w); return n === null ? FEHLER.VALUE : n; }
  return FEHLER.VALUE;
}

/** Wert → Text: Zahl mit Komma (15 gültige Ziffern), WAHR/FALSCH, leer ''. Fehler bleiben. */
export function zuText(w) {
  if (istFehler(w)) return w;
  if (w === null || w === undefined) return '';
  if (typeof w === 'string') return w;
  if (typeof w === 'boolean') return w ? 'WAHR' : 'FALSCH';
  if (typeof w === 'number') return zahlTextVoll(w);
  return FEHLER.VALUE;
}

/** Wert → Wahrheitswert: Zahl ≠ 0, Text WAHR/FALSCH/TRUE/FALSE, leer FALSCH, sonst #VALUE!. Fehler bleiben. */
export function zuBool(w) {
  if (istFehler(w)) return w;
  if (w === null || w === undefined) return false;
  if (typeof w === 'boolean') return w;
  if (typeof w === 'number') return w !== 0;
  if (typeof w === 'string') { const b = boolAusText(w); return b === null ? FEHLER.VALUE : b; }
  return FEHLER.VALUE;
}

// Texte ohne Groß/Klein, aber mit Akzenten („a“ = „A“, „Müller“ ≠ „Muller“) und in deutscher Reihenfolge.
const SORTIERUNG = new Intl.Collator('de', { sensitivity: 'accent' });
/** Typrang für Vergleich und Sortierung: Zahl 0, Text 1, Wahrheitswert 2, sonst (Fehler) 3. */
export function typRang(w) { return typeof w === 'number' ? 0 : typeof w === 'string' ? 1 : typeof w === 'boolean' ? 2 : 3; }
const leerWie = (w) => (typeof w === 'string' ? '' : typeof w === 'boolean' ? false : 0);
// Zahlen gelten wie in Excel als gleich, wenn sie in 15 gültigen Ziffern übereinstimmen (0,1+0,2 = 0,3).
const auf15 = (n) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);

/** Vergleich wie Excel: Zahl < Text < Wahrheitswert; Text ohne Groß/Klein; leer zählt als 0, '' bzw. FALSCH. */
export function vergleichen(a, b) {
  if (a === null || a === undefined) a = leerWie(b);
  if (b === null || b === undefined) b = leerWie(a);
  const ra = typRang(a), rb = typRang(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 1) return Math.sign(SORTIERUNG.compare(a, b));
  if (ra === 0) {
    if (a === b) return 0;
    // Weichen zwei Zahlen um mehr als 1e-13 relativ ab, runden sie nie auf dieselben 15 Stellen: kein toPrecision nötig.
    const d = a - b;
    if (Math.abs(d) > Math.max(Math.abs(a), Math.abs(b)) * 1e-13) return d < 0 ? -1 : 1;
  }
  let x = a, y = b;
  if (ra === 0) { x = auf15(a); y = auf15(b); } else if (ra === 3) { x = istFehler(a) ? a.fehler : ''; y = istFehler(b) ? b.fehler : ''; }
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---- Anzeige -----------------------------------------------------------------------------------------------------

function datumAnzeige(n) {
  const d = serieZuDatum(n);
  const tag = `${zwei(d.t)}.${zwei(d.m)}.${String(d.j).padStart(4, '0')}`;
  return d.std || d.min || d.sek ? `${tag} ${zwei(d.std)}:${zwei(d.min)}` : tag;
}

/**
 * Wert → Text in der Zelle. Nur Zahlen werden formatiert: zahl2 (1.234,50), euro (1.234,50 €), prozent (12,50 %),
 * datum (18.10.2026, mit Uhrzeit 18.10.2026 18:00; außerhalb 1…2958465 Standard); sonst Standard.
 */
export function wertAnzeigen(wert, zahl = null) {
  if (wert === null || wert === undefined) return '';
  if (istFehler(wert)) return FEHLER_ANZEIGE[wert.fehler] ?? wert.fehler;
  if (typeof wert === 'boolean') return wert ? 'WAHR' : 'FALSCH';
  if (typeof wert === 'string') return wert;
  if (typeof wert !== 'number') return '';
  if (zahl === 'zahl2') return festText(wert, 2);
  if (zahl === 'euro') return `${festText(wert, 2)} €`;
  if (zahl === 'prozent') return `${festText(wert * 100, 2)} %`;
  if (zahl === 'datum' && wert >= 1 && wert < SERIE_ENDE) return datumAnzeige(wert);
  return zahlText(wert);
}

// ---- Funktion TEXT -----------------------------------------------------------------------------------------------

/** Formatabschnitte an „;“ außerhalb von "…" und \x trennen (positiv; negativ; null). */
function abschnitte(format) {
  const teile = [];
  let start = 0, inText = false;
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '"') inText = !inText;
    else if (c === '\\' && !inText) i++;
    else if (c === ';' && !inText) { teile.push(format.slice(start, i)); start = i + 1; }
  }
  teile.push(format.slice(start));
  return teile;
}

/** Ein Formatabschnitt → Teile: {art:'text'}, {art:'datum', code, n} (T/D, M, J/Y, H, S) oder {art:'zahl', code} (0 # , . %). */
function formatTeile(abschnitt) {
  const teile = [];
  for (let i = 0; i < abschnitt.length;) {
    const c = abschnitt[i], g = c.toUpperCase();
    if (c === '"') {
      const e = abschnitt.indexOf('"', i + 1), ende = e < 0 ? abschnitt.length : e;
      teile.push({ art: 'text', text: abschnitt.slice(i + 1, ende) }); i = ende + 1;
    } else if (c === '\\') {
      teile.push({ art: 'text', text: abschnitt[i + 1] ?? '' }); i += 2;
    } else if ('TDMJYHS'.includes(g)) {
      let j = i;
      while (j < abschnitt.length && abschnitt[j].toUpperCase() === g) j++;
      teile.push({ art: 'datum', code: g === 'D' ? 'T' : g === 'Y' ? 'J' : g, n: j - i, text: abschnitt.slice(i, j) }); i = j;
    } else if ('0#,.%'.includes(c)) {
      teile.push({ art: 'zahl', code: c, text: c }); i++;
    } else {
      teile.push({ art: 'text', text: c }); i++;
    }
  }
  return teile;
}

const istStelle = (t) => t.art === 'zahl' && (t.code === '0' || t.code === '#');

/** Ist „M“ an Stelle i Minute? Ja direkt nach h/hh oder direkt vor s/ss (Literale dazwischen zählen nicht). */
function istMinute(teile, i) {
  for (let k = i - 1; k >= 0; k--) if (teile[k].art === 'datum') { if (teile[k].code === 'H') return true; break; }
  for (let k = i + 1; k < teile.length; k++) if (teile[k].art === 'datum') return teile[k].code === 'S';
  return false;
}

function datumFormatieren(n, teile) {
  if (!(n >= 0 && n < SERIE_ENDE)) return FEHLER.VALUE;
  const d = serieZuDatum(n), wochentag = (datumZuSerie(d.j, d.m, d.t) + 6) % 7; // Serie 1 ist in Excel ein Sonntag
  let aus = '';
  teile.forEach((t, i) => {
    if (t.art !== 'datum') { aus += t.text; return; }
    const kurzLang = (zahl, kurz, lang) => (t.n === 1 ? String(zahl) : t.n === 2 ? zwei(zahl) : t.n === 3 ? kurz : lang);
    switch (t.code) {
      case 'T': aus += kurzLang(d.t, TAGE_KURZ[wochentag], TAGE[wochentag]); break;
      case 'M':
        if (t.n <= 2 && istMinute(teile, i)) aus += t.n === 1 ? String(d.min) : zwei(d.min);
        else aus += t.n >= 5 ? MONATE[d.m - 1][0] : kurzLang(d.m, MONATE_KURZ[d.m - 1], MONATE[d.m - 1]);
        break;
      case 'J': aus += t.n <= 2 ? zwei(d.j % 100) : String(d.j).padStart(4, '0'); break;
      case 'H': aus += t.n === 1 ? String(d.std) : zwei(d.std); break;
      default: aus += t.n === 1 ? String(d.sek) : zwei(d.sek); // S
    }
  });
  return aus;
}

/** Zahl in einem Abschnitt mit Zahlcodes: 0 (Pflichtziffer), # (Ziffer, wenn nötig), , (Dezimal), . (Tausender), % (×100). */
function zahlFormatieren(n, teile, mitMinus) {
  const komma = teile.findIndex((t) => t.art === 'zahl' && t.code === ',');
  const ganzStellen = [], bruchStellen = [];
  teile.forEach((t, i) => { if (istStelle(t)) (komma >= 0 && i > komma ? bruchStellen : ganzStellen).push(i); });
  const erste = ganzStellen[0] ?? -1, letzte = ganzStellen.at(-1) ?? -1;
  // Tausenderpunkt = ein „.“ zwischen zwei Ganzzahlstellen (#.##0); jeder andere Punkt ist ein Literal.
  const istGruppe = (t, i) => t.art === 'zahl' && t.code === '.' && i > erste && i < letzte;
  const tausender = teile.some(istGruppe);
  const prozente = teile.filter((t) => t.art === 'zahl' && t.code === '%').length;
  const z = ziffern(Math.abs(n) * 100 ** prozente, bruchStellen.length);
  if (z === null) return zahlText(n);
  let ganz = z.ganz === '0' ? '' : z.ganz;
  ganz = ganz.padStart(ganzStellen.filter((i) => teile[i].code === '0').length, '0');
  if (tausender) ganz = gruppieren(ganz);
  // Ganzzahl auf die Stellen verteilen: von rechts je eine Ziffer, die erste Stelle nimmt den Rest (mit Gruppen alles).
  const aufStelle = new Map();
  if (tausender || ganzStellen.length === 1) { if (erste >= 0) aufStelle.set(erste, ganz); } else {
    let rest = ganz;
    for (let k = ganzStellen.length - 1; k > 0; k--) { aufStelle.set(ganzStellen[k], rest.slice(-1)); rest = rest.slice(0, -1); }
    if (erste >= 0) aufStelle.set(erste, rest);
  }
  // Nachkommastellen: führende Ziffern auf die Stellen, nicht nötige Nullen hinten fallen bei # weg.
  let bruch = z.bruch;
  for (let k = bruchStellen.length - 1; k >= 0 && teile[bruchStellen[k]].code === '#' && bruch[k] === '0'; k--) bruch = bruch.slice(0, k);
  bruchStellen.forEach((i, k) => aufStelle.set(i, bruch[k] ?? ''));
  let aus = '';
  teile.forEach((t, i) => {
    if (istStelle(t)) aus += aufStelle.get(i) ?? '';
    else if (istGruppe(t, i)) { /* steckt schon in der Ganzzahl */ } else {
      // Ohne Ganzzahlstellen stehen die Ziffern vor dem Komma (,00 → 12,50).
      if (i === komma && erste < 0) aus += ganz;
      aus += t.text;
    }
  });
  const minus = mitMinus && n < 0 && /[1-9]/.test(z.ganz + z.bruch) ? '-' : '';
  return minus + aus;
}

/**
 * Funktion TEXT: Wert → Text nach einem Format wie in Excel (#.##0,00 · 0% · TT.MM.JJJJ · hh:mm · "Nr. "0). Text bleibt
 * unverändert, Wahrheitswerte werden WAHR/FALSCH, leer zählt als 0. Abschnitte positiv;negativ;null. Ohne Zahl- und
 * Datumscode → der Wert als Text; „Standard“ → Format Standard.
 */
export function textFormat(wert, format) {
  if (istFehler(wert)) return wert;
  if (typeof wert === 'string') return wert;
  if (typeof wert === 'boolean') return zuText(wert);
  const n = wert === null || wert === undefined ? 0 : wert;
  if (typeof n !== 'number') return FEHLER.VALUE;
  const f = String(format ?? '');
  if (f === '') return '';
  if (/^\s*(?:standard|general)\s*$/i.test(f)) return zahlText(n);
  const liste = abschnitte(f).map(formatTeile);
  if (!liste.some((teile) => teile.some((t) => istStelle(t) || t.art === 'datum'))) return zuText(n);
  const datum = (teile) => teile.some((t) => t.art === 'datum') && !teile.some(istStelle);
  if (datum(liste[0])) return datumFormatieren(n, liste[0]);
  if (n < 0 && liste.length >= 2) return zahlFormatieren(-n, liste[1], false);
  if (n === 0 && liste.length >= 3) return zahlFormatieren(0, liste[2], false);
  return zahlFormatieren(n, liste[0], true);
}

// ---- Kriterien (SUMMEWENN, ZÄHLENWENN) ---------------------------------------------------------------------------

/**
 * Text mit Platzhaltern (* beliebig viele Zeichen, ? genau eins, ~ hebt auf) → Prüfung, ob ein Text-Wert passt (ohne Groß/Klein).
 * Ohne Zurückspringen: die Stücke zwischen den * haben feste Länge und werden der Reihe nach je am frühesten Platz gesucht
 * (das erste am Anfang, das letzte am Ende) – höchstens Textlänge × Musterlänge Schritte, auch bei „*a*a*a*b“ auf langem Text.
 */
export function platzhalterTest(muster) {
  const stuecke = [''];
  const m = String(muster);
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    const n = stuecke.length - 1;
    if (c === '~' && (m[i + 1] === '*' || m[i + 1] === '?' || m[i + 1] === '~')) { i++; stuecke[n] += m[i] === '~' ? '~' : `\\${m[i]}`; } else if (c === '*') { if (n === 0 || stuecke[n] !== '') stuecke.push(''); } // ** wie *
    else if (c === '?') stuecke[n] += '[\\s\\S]';
    else stuecke[n] += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  if (stuecke.length === 1) {
    const ganz = new RegExp(`^(?:${stuecke[0]})$`, 'iu');
    return (w) => typeof w === 'string' && ganz.test(w);
  }
  const anfang = new RegExp(stuecke[0], 'iuy');
  const mitte = stuecke.slice(1, -1).map((s) => new RegExp(s, 'giu'));
  const ende = new RegExp(`(?:${stuecke[stuecke.length - 1]})$`, 'giu');
  return (w) => {
    if (typeof w !== 'string') return false;
    anfang.lastIndex = 0;
    if (!anfang.test(w)) return false;
    let pos = anfang.lastIndex;
    for (const re of mitte) {
      re.lastIndex = pos;
      const t = re.exec(w);
      if (!t) return false;
      pos = t.index + t[0].length;
    }
    ende.lastIndex = pos;
    return ende.test(w);
  };
}

/**
 * Schlüssel für Textgleichheit ohne Groß/Klein, wie platzhalterTest (ohne Platzhalter) sie sieht: gleiche Texte haben
 * gleiche Schlüssel („ẞ“ wie „ß“, „ſ“ wie „s“, „µ“ wie „μ“); selten haben auch ungleiche denselben – wer über den
 * Schlüssel sucht, prüft Treffer mit platzhalterTest nach.
 */
export function textSchluessel(t) {
  if (/^[\x00-\x7f]*$/.test(t)) return t.toLowerCase();
  let aus = '';
  for (const c of t) {
    const g = c.toUpperCase();
    aus += g.length === c.length ? g.toLowerCase() : c.toLowerCase(); // Großschreibung mit mehr Zeichen (ß → SS) zählt nicht
  }
  return aus;
}

const KRITERIUM = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/;
const erfuellt = (op, c) => (op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '>=' ? c >= 0 : op === '<>' ? c !== 0 : c === 0);

/**
 * Kriterium wie in Excel → Prüffunktion für einen Wert. Zahl/Wahrheitswert: gleich (nur gleicher Typ). Text mit
 * Vorsilbe <= >= <> < > =: ist der Rest eine deutsche Zahl oder ein Datum, wird nur mit Zahlen verglichen, bei
 * WAHR/FALSCH nur mit Wahrheitswerten; sonst Textvergleich ohne Groß/Klein, bei = und <> mit Platzhaltern. '' und '='
 * passen auf leer und '', '<>' auf alles außer leer; „<>…“ passt auch auf leere Zellen. Eine leere Zelle als
 * Kriterium zählt wie 0.
 */
export function kriterium(k) {
  if (istFehler(k)) return (w) => istFehler(w) && w.fehler === k.fehler;
  if (k === null || k === undefined) return kriterium(0);
  if (typeof k === 'number') return (w) => typeof w === 'number' && vergleichen(w, k) === 0;
  if (typeof k === 'boolean') return (w) => w === k;
  const [, op = '=', rest] = KRITERIUM.exec(String(k));
  if (rest === '') {
    if (op === '=') return (w) => w === null || w === undefined || w === '';
    if (op === '<>') return (w) => w !== null && w !== undefined;
    return () => false;
  }
  let ziel = deZahlLesen(rest) ?? datumLesen(rest.trim()), typ = 'number';
  if (ziel === null) { ziel = boolAusText(rest); typ = 'boolean'; }
  if (ziel !== null) {
    if (op === '<>') return (w) => !(typeof w === typ && vergleichen(w, ziel) === 0);
    return (w) => typeof w === typ && erfuellt(op, vergleichen(w, ziel));
  }
  if (op === '=' || op === '<>') {
    const passt = platzhalterTest(rest);
    return op === '=' ? passt : (w) => !passt(w);
  }
  return (w) => typeof w === 'string' && erfuellt(op, vergleichen(w, rest));
}
