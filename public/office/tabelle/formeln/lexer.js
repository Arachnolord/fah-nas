// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Formel-Lexer der Office-Tabelle (Plan 06): zerlegt einen Formeltext (ohne führendes „=“) in Tokens. Drei Modi:
// intern (so steht die Formel in den Daten: englisch, Komma trennt, Punkt ist Dezimalzeichen, anderes Blatt als
// „[blattId]!A1“), excel (wie intern, aber Blattnamen wie in der xlsx-Datei) und anzeige (deutsch: Semikolon trennt,
// Komma ist Dezimalzeichen, WAHR/FALSCH, #BEZUG! usw.). Jedes Token behält seinen Originaltext, tokensText setzt die
// Formel zeichengleich wieder zusammen – auch Leerraum. zerlegen wirft nie: was es nicht versteht, wird zum Token
// „unbekannt“; über Gültigkeit entscheidet erst der Parser. Ohne DOM – der Web-Dienst lädt die Datei über den Sync-Typ.

import { ID_MUSTER } from '../../../gemeinsam/sync/typen/dokument-attribute.js';
import { EXCEL_MAX, spalteZuText, textZuSpalte } from './adresse.js';

export const MODI = Object.freeze({
  intern: Object.freeze({ dezimal: '.', trenner: ',', blatt: 'id' }),
  excel: Object.freeze({ dezimal: '.', trenner: ',', blatt: 'name' }),
  anzeige: Object.freeze({ dezimal: ',', trenner: ';', blatt: 'name' }),
});

// Fehlerwerte als Text → englischer Code; im Modus anzeige zusätzlich die deutschen. Längste zuerst.
const FEHLER_EN = ['#DIV/0!', '#NAME?', '#REF!', '#VALUE!', '#N/A', '#NUM!'].map((f) => [f, f]);
const FEHLER_DE = [['#BEZUG!', '#REF!'], ['#WERT!', '#VALUE!'], ['#NV', '#N/A'], ['#ZAHL!', '#NUM!']];
const nachLaenge = (liste) => Object.freeze(liste.sort((a, b) => b[0].length - a[0].length));
const FEHLER_TEXTE = Object.freeze({ intern: nachLaenge([...FEHLER_EN]), excel: nachLaenge([...FEHLER_EN]), anzeige: nachLaenge([...FEHLER_EN, ...FEHLER_DE]) });

// Zeichen eines Bezeichners; ein Bezug darf nicht direkt von ihnen oder von „(“ gefolgt werden (LOG10( ist eine Funktion).
const NAME_ZEICHEN = 'A-Za-z0-9ÄÖÜäöüß_.';
const NACH_BEZUG = `(?![${NAME_ZEICHEN}(])`;
const LEER = /\s+/y;
const BEZEICHNER = /[A-Za-zÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß_.]*/y;
const ZELLE = new RegExp(`(\\$?)([A-Za-z]{1,3})(\\$?)(\\d+)(?::(\\$?)([A-Za-z]{1,3})(\\$?)(\\d+))?${NACH_BEZUG}`, 'y');
const SPALTEN = new RegExp(`(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})${NACH_BEZUG}`, 'y');
const ZEILEN = new RegExp(`(\\$?)(\\d+):(\\$?)(\\d+)${NACH_BEZUG}`, 'y');
// Blattvorsilben: intern „[id]!“, sonst „Name!“ oder „'Name mit ''Hochkomma'''!“ (Blattnamen haben höchstens 31 Zeichen).
const BLATT_ID = /\[([^\]\s]{1,64})\]!/y;
const BLATT_NAME = /([A-Za-zÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß_.]*)!/y;
const BLATT_QUOTIERT = /'((?:[^']|''){1,31})'!/y;
const zahlMuster = (d) => new RegExp(`(?:\\d+(?:${d}\\d+)?|${d}\\d+)(?:[eE][+-]?\\d+)?`, 'y');
const ZAHL = Object.freeze({ '.': zahlMuster('\\.'), ',': zahlMuster(',') });
const OPS_ZWEI = new Set(['<>', '<=', '>=']);
const OPS_EINS = new Set(['+', '-', '*', '/', '^', '&', '=', '<', '>', '%']);

// Blattnamen, die bezugText in Hochkommas setzt: nicht nach Bezeichner-Muster (zum Schreiben ohne Punkt, damit Excel,
// LibreOffice und Numbers den Namen sicher lesen), wie ein Bezug aussehend (A1-Form, auch R1C1-Form) oder ein Wahrheitswert.
const NAME_OHNE_QUOTE = /^[A-Za-zÄÖÜäöüß_][A-Za-z0-9ÄÖÜäöüß_]*$/;
const WIE_BEZUG = /^(?:[A-Za-z]{1,3}\d+|R\d*C?\d*|C\d*)$/i;
const WAHRHEITSWERT = /^(?:TRUE|FALSE|WAHR|FALSCH)$/i;

const modusVon = (modus) => (Object.hasOwn(MODI, modus) ? MODI[modus] : MODI.intern);

/** Bezugsteil (Zeile oder Spalte darf fehlen = ganze Spalte bzw. Zeile). */
const teil = (z, s, zAbs, sAbs) => ({ z, s, zAbs, sAbs });
const gueltig = (t) => (t.z === null || (t.z >= 1 && t.z <= EXCEL_MAX.zeilen)) && (t.s === null || (t.s >= 1 && t.s <= EXCEL_MAX.spalten));

/** Bezug ab Position i: „$A$1“, „A1:B3“, „A:C“ oder „2:4“; außerhalb von XFD1048576 kein Bezug. → {laenge, von, bis} | null */
function bezugBei(s, i) {
  let m;
  ZELLE.lastIndex = i;
  if ((m = ZELLE.exec(s))) {
    const von = teil(Number(m[4]), textZuSpalte(m[2]), m[3] === '$', m[1] === '$');
    const bis = m[8] === undefined ? null : teil(Number(m[8]), textZuSpalte(m[6]), m[7] === '$', m[5] === '$');
    return gueltig(von) && (!bis || gueltig(bis)) ? { laenge: m[0].length, von, bis } : null;
  }
  SPALTEN.lastIndex = i;
  if ((m = SPALTEN.exec(s))) {
    const von = teil(null, textZuSpalte(m[2]), false, m[1] === '$'), bis = teil(null, textZuSpalte(m[4]), false, m[3] === '$');
    return gueltig(von) && gueltig(bis) ? { laenge: m[0].length, von, bis } : null;
  }
  ZEILEN.lastIndex = i;
  if ((m = ZEILEN.exec(s))) {
    const von = teil(Number(m[2]), null, m[1] === '$', false), bis = teil(Number(m[4]), null, m[3] === '$', false);
    return gueltig(von) && gueltig(bis) ? { laenge: m[0].length, von, bis } : null;
  }
  return null;
}

/** Blattvorsilbe ab Position i (ohne den folgenden Bezug). → {laenge, blatt} | null */
function vorsilbeBei(s, i, modus) {
  let m;
  if (modus.blatt === 'id') {
    if (s[i] !== '[') return null;
    BLATT_ID.lastIndex = i;
    m = BLATT_ID.exec(s);
    return m && ID_MUSTER.test(m[1]) ? { laenge: m[0].length, blatt: m[1] } : null;
  }
  if (s[i] === "'") {
    BLATT_QUOTIERT.lastIndex = i;
    m = BLATT_QUOTIERT.exec(s);
    return m ? { laenge: m[0].length, blatt: m[1].replace(/''/g, "'") } : null;
  }
  BLATT_NAME.lastIndex = i;
  m = BLATT_NAME.exec(s);
  return m ? { laenge: m[0].length, blatt: m[1] } : null;
}

/** Textliteral ab dem „"“ an Position i; "" steht für ein ". Fehlt das Ende → null. */
function textBei(s, i) {
  let wert = '';
  for (let j = i + 1; ;) {
    const k = s.indexOf('"', j);
    if (k < 0) return null;
    wert += s.slice(j, k);
    if (s[k + 1] !== '"') return { laenge: k + 1 - i, wert };
    wert += '"';
    j = k + 2;
  }
}

function fehlerBei(s, i, liste) {
  for (const [text, code] of liste) if (s.slice(i, i + text.length).toUpperCase() === text) return { laenge: text.length, code };
  return null;
}

function wahrheitswert(text, modus) {
  const gross = text.toUpperCase();
  const [wahr, falsch] = modus === MODI.anzeige ? ['WAHR', 'FALSCH'] : ['TRUE', 'FALSE'];
  return gross === wahr ? true : gross === falsch ? false : null;
}

/** Formeltext → Tokens. Wirft nie; Unbekanntes wird je Zeichen zum Token „unbekannt“, ein offener Text als Ganzes. */
export function zerlegen(text, modus = 'intern') {
  const s = typeof text === 'string' ? text : '';
  const md = modusVon(modus);
  const fehlerListe = FEHLER_TEXTE[Object.hasOwn(MODI, modus) ? modus : 'intern'];
  const tokens = [];
  let i = 0, m;
  const nimm = (token) => { tokens.push(token); i += token.text.length; };
  while (i < s.length) {
    const c = s[i];
    LEER.lastIndex = i;
    if ((m = LEER.exec(s))) { nimm({ art: 'leer', text: m[0] }); continue; }
    if (c === '"') {
      const t = textBei(s, i);
      nimm(t ? { art: 'text', text: s.slice(i, i + t.laenge), wert: t.wert } : { art: 'unbekannt', text: s.slice(i) });
      continue;
    }
    if (c === '#') {
      const f = fehlerBei(s, i, fehlerListe);
      if (f) { nimm({ art: 'fehler', text: s.slice(i, i + f.laenge), wert: f.code }); continue; }
    }
    const v = vorsilbeBei(s, i, md);
    const b = v ? bezugBei(s, i + v.laenge) : null;
    if (b) { nimm({ art: 'bezug', text: s.slice(i, i + v.laenge + b.laenge), blatt: v.blatt, von: b.von, bis: b.bis }); continue; }
    const r = bezugBei(s, i);
    if (r) { nimm({ art: 'bezug', text: s.slice(i, i + r.laenge), blatt: null, von: r.von, bis: r.bis }); continue; }
    const zahl = ZAHL[md.dezimal];
    zahl.lastIndex = i;
    if ((m = zahl.exec(s))) { nimm({ art: 'zahl', text: m[0], wert: Number(md.dezimal === '.' ? m[0] : m[0].replace(md.dezimal, '.')) }); continue; }
    BEZEICHNER.lastIndex = i;
    if ((m = BEZEICHNER.exec(s))) {
      const t = m[0], w = wahrheitswert(t, md);
      if (s[i + t.length] === '(') nimm({ art: 'funktion', text: t, name: t.toUpperCase() });
      else if (w !== null) nimm({ art: 'bool', text: t, wert: w });
      else nimm({ art: 'name', text: t });
      continue;
    }
    const zwei = s.slice(i, i + 2);
    if (OPS_ZWEI.has(zwei)) { nimm({ art: 'op', text: zwei }); continue; }
    if (OPS_EINS.has(c)) { nimm({ art: 'op', text: c }); continue; }
    if (c === '(') { nimm({ art: 'auf', text: c }); continue; }
    if (c === ')') { nimm({ art: 'zu', text: c }); continue; }
    if (c === md.trenner) { nimm({ art: 'trenner', text: c }); continue; }
    nimm({ art: 'unbekannt', text: String.fromCodePoint(s.codePointAt(i)) });
  }
  return tokens;
}

/** Tokens → Text, zeichengleich zum Original für unveränderte Tokens. */
export function tokensText(tokens) { return tokens.map((t) => t.text).join(''); }

const teilText = (t) => (t.s === null ? '' : (t.sAbs ? '$' : '') + spalteZuText(t.s)) + (t.z === null ? '' : (t.zAbs ? '$' : '') + t.z);

/** Blattname so, wie er in einer Formel stehen muss: wenn nötig in Hochkommas, ' wird ''. */
export function blattNameText(name) {
  const s = String(name);
  return NAME_OHNE_QUOTE.test(s) && !WIE_BEZUG.test(s) && !WAHRHEITSWERT.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * Bezug → Text im Modus: intern „[id]!A1“, sonst „Name!A1“ bzw. „'Mein Blatt'!A1“. blattAnzeige bildet das gespeicherte
 * Blatt (ID oder Name) auf das ab, was im Modus stehen soll; liefert sie nichts, ist das Blatt weg → #REF! (anzeige #BEZUG!).
 */
export function bezugText({ blatt = null, von, bis = null }, modus = 'intern', blattAnzeige = (b) => b) {
  const md = modusVon(modus);
  let vorsilbe = '';
  if (blatt !== null && blatt !== undefined) {
    const b = blattAnzeige(blatt);
    if (b === null || b === undefined || b === '') return md === MODI.anzeige ? '#BEZUG!' : '#REF!';
    vorsilbe = md.blatt === 'id' ? `[${b}]!` : `${blattNameText(b)}!`;
  }
  return vorsilbe + teilText(von) + (bis ? `:${teilText(bis)}` : '');
}
