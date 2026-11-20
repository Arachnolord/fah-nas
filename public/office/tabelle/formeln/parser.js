// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Formel-Parser der Office-Tabelle (Plan 06): rekursiver Abstieg über die Tokens des Lexers (Leerraum zählt nicht) mit
// dem Vorrang von Excel, von außen nach innen: Vergleich (= <> < > <= >=) → Verkettung (&) → Summe (+ -) → Produkt
// (* /) → Potenz (^, links-assoziativ wie Excel: 2^3^2 = 64) → Vorzeichen (vorangestelltes - und +, bindet stärker als ^:
// -2^2 = 4) → Prozent (nachgestelltes %) → Literal, Bezug, Name, Funktion oder Klammer. Ketten (1+1+…, ----1) laufen
// ohne Rekursion; nur Klammern und Funktionen schachteln, höchstens MAX_TIEFE Ebenen – tiefer wäre ein Stapelüberlauf.
// Fehler kommen als FormelFehler mit Grund und Zeichenposition. Ohne DOM.

import { zerlegen } from './lexer.js';
import { FUNKTIONEN, funktionAusDeutsch } from './funktionen.js';

const MAX_TIEFE = 256;
const VERGLEICH = new Set(['=', '<>', '<', '>', '<=', '>=']);
const VERKETTUNG = new Set(['&']);
const SUMME = new Set(['+', '-']);
const PRODUKT = new Set(['*', '/']);
const POTENZ = new Set(['^']);
const VORZEICHEN = new Set(['-', '+']);
const PROZENT = new Set(['%']);

/** Grund: 'syntax' | 'klammer' | 'unbekannt' | 'argumente' | 'blatt' (Blattname unbekannt, wirft uebersetzen.js). */
export class FormelFehler extends Error {
  constructor(grund, pos = 0) {
    super(grund);
    this.name = 'FormelFehler';
    this.grund = grund;
    this.pos = pos;
  }
}

/** Formeltext (ohne „=“) → Baum. Wirft FormelFehler. */
export function parsen(text, modus = 'intern') {
  const tokens = [];
  let ende = 0;
  for (const t of zerlegen(text, modus)) {
    if (t.art !== 'leer') tokens.push({ t, pos: ende });
    ende += t.text.length;
  }
  const fremd = tokens.find((x) => x.t.art === 'unbekannt');
  if (fremd) throw new FormelFehler('unbekannt', fremd.pos);

  let i = 0, tiefe = 0;
  const jetzt = () => (i < tokens.length ? tokens[i].t : null);
  const hier = () => (i < tokens.length ? tokens[i].pos : ende);
  const fehler = (grund) => new FormelFehler(grund, hier());
  const istOp = (ops) => { const t = jetzt(); return t !== null && t.art === 'op' && ops.has(t.text); };
  const hinein = () => { if (++tiefe > MAX_TIEFE) throw fehler('syntax'); };
  // Nach Klammerinhalt oder Argument: das Ende heißt „Klammer fehlt“, jedes andere Token ist ein Syntaxfehler.
  const erwartet = () => fehler(jetzt() === null ? 'klammer' : 'syntax');

  /** Eine links-assoziative Ebene: a op b op c → ((a op b) op c). */
  const ebene = (ops, naechste) => () => {
    let a = naechste();
    while (istOp(ops)) { const op = tokens[i++].t.text; a = { art: 'binaer', op, a, b: naechste() }; }
    return a;
  };

  function primaer() {
    const t = jetzt();
    if (t === null) throw fehler('syntax');
    switch (t.art) {
      case 'zahl': case 'text': case 'bool': case 'fehler': i++; return { art: t.art, wert: t.wert };
      case 'bezug': i++; return { art: 'bezug', blatt: t.blatt, von: t.von, bis: t.bis };
      case 'name': i++; return { art: 'name', text: t.text };
      case 'funktion': return funktion();
      case 'auf': {
        hinein(); i++;
        if (jetzt() === null) throw fehler('klammer');
        const a = vergleich();
        if (jetzt()?.art !== 'zu') throw erwartet();
        i++; tiefe--;
        return a;
      }
      default: throw fehler('syntax');
    }
  }

  function funktion() {
    const start = hier(), name = tokens[i].t.name;
    hinein(); i += 2; // Name und „(“ – der Lexer meldet eine Funktion nur direkt vor „(“
    const argumente = [];
    if (jetzt()?.art === 'zu') i++;
    else {
      for (;;) {
        const t = jetzt();
        if (t === null) throw fehler('klammer');
        argumente.push(t.art === 'trenner' || t.art === 'zu' ? { art: 'leer' } : vergleich());
        const d = jetzt();
        if (d?.art === 'trenner') { i++; continue; }
        if (d?.art === 'zu') { i++; break; }
        throw erwartet();
      }
    }
    tiefe--;
    const en = modus === 'anzeige' ? funktionAusDeutsch(name) : name;
    const def = en !== null && Object.hasOwn(FUNKTIONEN, en) ? FUNKTIONEN[en] : null;
    if (def && (argumente.length < def.min || argumente.length > def.max)) throw new FormelFehler('argumente', start);
    return { art: 'funktion', name, argumente };
  }

  function prozent() {
    let a = primaer();
    while (istOp(PROZENT)) { i++; a = { art: 'prozent', a }; }
    return a;
  }

  function vorzeichen() {
    const ops = [];
    while (istOp(VORZEICHEN)) ops.push(tokens[i++].t.text);
    let a = prozent();
    for (let k = ops.length - 1; k >= 0; k--) a = { art: 'unaer', op: ops[k], a };
    return a;
  }

  const potenz = ebene(POTENZ, vorzeichen);
  const produkt = ebene(PRODUKT, potenz);
  const summe = ebene(SUMME, produkt);
  const verkettung = ebene(VERKETTUNG, summe);
  const vergleich = ebene(VERGLEICH, verkettung);

  const baum = vergleich();
  if (i < tokens.length) throw fehler(tokens[i].t.art === 'zu' ? 'klammer' : 'syntax');
  return baum;
}
