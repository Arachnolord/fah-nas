// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Die 17 Funktionen der Office-Tabelle (Plan 06): englischer Name (so steht die Formel in den Daten und in der
// xlsx-Datei) → deutscher Name für die Oberfläche, erlaubte Anzahl Argumente, ob die Funktion „volatil“ ist (HEUTE/JETZT
// rechnen regelmäßig neu) und die Rechenfunktion fn(argumente, umgebung). Die Argumente kommen faul als Funktionen, die
// einen Wert, einen Bereich oder {art:'leer'} (leeres Argument wie in WENN(A1;;1)) liefern – WENN wertet so nur den
// gewählten Zweig aus. Ein Zellbezug kommt als Bereich aus einer Zelle, damit SUMME(A1) wie in Excel Text in A1
// übergeht; wo ein einzelner Wert gebraucht wird, gilt ein 1×1-Bereich als sein Wert. Fehler in einem ausgewerteten
// Argument gehen sofort zurück (der erste in Argumentreihenfolge, im Bereich zeilenweise). Ohne DOM.

import {
  FEHLER, istFehler, zuZahl, zuText, zuBool, vergleichen, typRang, jetztSerie, textFormat, kriterium, platzhalterTest,
} from './werte.js';
import { GRENZEN } from './adresse.js';

/**
 * Bereich = {art:'bereich', zeilen, spalten, wert(i, j), belegte() → zeilenweise {i, j, wert}, nur nicht leere}
 * (0-basiert). Optional: jeder(fn) – derselbe Lauf ohne ein Objekt je Zelle, fn(wert, i, j), false beendet ihn –,
 * teil(zeilen, spalten) – derselbe Bereich ab derselben Ecke in anderer Größe – und suchen(wert, passt) – erste Zeile
 * der ersten Spalte, deren Wert gleich ist (passt prüft jeden Treffer nach), sonst -1. Der Rechner liefert alle drei.
 */
export function istBereich(x) { return x !== null && typeof x === 'object' && x.art === 'bereich'; }
const istLeer = (x) => x !== null && typeof x === 'object' && x.art === 'leer';

/** Jede belegte Zelle eines Bereichs zeilenweise: fn(wert, i, j); gibt fn false zurück, endet der Lauf. */
function alleBelegten(bereich, fn) {
  if (typeof bereich.jeder === 'function') { bereich.jeder(fn); return; }
  for (const { i, j, wert } of bereich.belegte()) if (fn(wert, i, j) === false) return;
}

/** Ein einzelner Wert: 1×1-Bereich → sein Wert, größerer Bereich → #VALUE!, leeres Argument → leer. */
function skalar(x) {
  if (istBereich(x)) return x.zeilen === 1 && x.spalten === 1 ? x.wert(0, 0) : FEHLER.VALUE;
  return istLeer(x) ? null : x;
}

const endlich = (n) => (Number.isFinite(n) ? n : FEHLER.NUM);

/**
 * Zahlen wie SUMME: im Bereich nur Zahlen, direkt Zahl, Wahrheitswert oder deutsch lesbarer Text (sonst #VALUE!), ein
 * leeres Argument zählt als 0. fn bekommt jede Zahl; Rückgabe: der erste Fehler oder null.
 */
function jedeZahl(argumente, fn) {
  for (const arg of argumente) {
    const x = arg();
    if (istBereich(x)) {
      let fehler = null;
      alleBelegten(x, (wert) => {
        if (istFehler(wert)) { fehler = wert; return false; }
        if (typeof wert === 'number') fn(wert);
        return true;
      });
      if (fehler) return fehler;
    } else if (istLeer(x)) fn(0);
    else if (x !== null && x !== undefined) {
      const n = zuZahl(x);
      if (istFehler(n)) return n;
      fn(n);
    }
  }
  return null;
}

/** Wahrheitswerte wie UND/ODER: im Bereich Wahrheitswerte und Zahlen (Text und leere zählen nicht), direkt über zuBool. */
function jederWahrheitswert(argumente, fn) {
  let gesehen = 0;
  for (const arg of argumente) {
    const x = arg();
    if (istBereich(x)) {
      let fehler = null;
      alleBelegten(x, (wert) => {
        if (istFehler(wert)) { fehler = wert; return false; }
        if (typeof wert === 'boolean' || typeof wert === 'number') { fn(typeof wert === 'boolean' ? wert : wert !== 0); gesehen++; }
        return true;
      });
      if (fehler) return fehler;
    } else {
      const b = zuBool(istLeer(x) ? null : x);
      if (istFehler(b)) return b;
      fn(b); gesehen++;
    }
  }
  return gesehen === 0 ? FEHLER.VALUE : null;
}

function summe(argumente) {
  let s = 0;
  return jedeZahl(argumente, (n) => { s += n; }) ?? endlich(s);
}

function mittelwert(argumente) {
  let s = 0, n = 0;
  const f = jedeZahl(argumente, (x) => { s += x; n++; });
  return f ?? (n === 0 ? FEHLER.DIV0 : endlich(s / n));
}

/** MIN/MAX; ohne eine einzige Zahl → 0 wie Excel. */
const extrem = (besser) => (argumente) => {
  let e = null;
  return jedeZahl(argumente, (n) => { if (e === null || besser(n, e)) e = n; }) ?? (e ?? 0);
};

function anzahl(argumente) {
  let n = 0;
  for (const arg of argumente) {
    const x = arg();
    if (istBereich(x)) alleBelegten(x, (wert) => { if (typeof wert === 'number') n++; });
    else if (typeof x === 'number' || typeof x === 'boolean') n++;
    else if (typeof x === 'string' && !istFehler(zuZahl(x))) n++;
  }
  return n;
}

function anzahl2(argumente) {
  let n = 0;
  for (const arg of argumente) {
    const x = arg();
    if (istBereich(x)) alleBelegten(x, () => { n++; });
    else if (x !== null && x !== undefined && !istLeer(x)) n++; // auch Fehler und ''
  }
  return n;
}

/** Ergebnis eines Zweigs von WENN: ein leerer Zweig ergibt 0, Bereiche gehen unverändert weiter (SUMME(WENN(…;A1:A3))). */
function zweig(arg) { const x = arg(); return istLeer(x) ? 0 : x; }

function wenn([bedingung, dann, sonst]) {
  const b = zuBool(skalar(bedingung()));
  if (istFehler(b)) return b;
  if (b) return zweig(dann);
  return sonst === undefined ? false : zweig(sonst);
}

function und(argumente) {
  let e = true;
  return jederWahrheitswert(argumente, (b) => { e = e && b; }) ?? e;
}

function oder(argumente) {
  let e = false;
  return jederWahrheitswert(argumente, (b) => { e = e || b; }) ?? e;
}

/** Zahl aus einem Argument, das ein einzelner Wert sein muss. */
const zahlArg = (arg) => zuZahl(skalar(arg()));

/** RUNDEN halb vom Nullpunkt weg; auf 15 Stellen gerechnet, damit 2,675 → 2,68 und 1,005 → 1,01 (wie Excel). */
function runden([zahl, stellen]) {
  const x = zahlArg(zahl);
  if (istFehler(x)) return x;
  const s = zahlArg(stellen);
  if (istFehler(s)) return s;
  const n = Math.max(-308, Math.min(308, Math.trunc(s)));
  const faktor = 10 ** Math.abs(n);
  const skaliert = n >= 0 ? Math.abs(x) * faktor : Math.abs(x) / faktor;
  if (!Number.isFinite(skaliert)) return x; // feiner als darstellbar: nichts zu runden
  const r = Math.round(Number(skaliert.toPrecision(15)));
  return endlich(Math.sign(x) * (n >= 0 ? r / faktor : r * faktor) + 0); // + 0 macht aus -0 eine 0
}

/** Ein einzelner Wert als Tabelle aus einer Zelle (SVERWEIS(5;5;1) wie Excel). */
function alsBereich(x) {
  if (istBereich(x)) return x;
  const w = istLeer(x) ? null : x;
  return { art: 'bereich', zeilen: 1, spalten: 1, wert: (i, j) => (i === 0 && j === 0 ? w : null), * belegte() { if (w !== null) yield { i: 0, j: 0, wert: w }; } };
}

/** Prüfung „gleich wie such“ für SVERWEIS genau: Text ohne Groß/Klein mit Platzhaltern, Zahl auf 15 Stellen, sonst gleich. */
function gleichWie(such) {
  if (typeof such === 'string') return platzhalterTest(such);
  if (typeof such !== 'number') return (w) => w === such;
  return (w) => typeof w === 'number' && vergleichen(w, such) === 0;
}

/** SVERWEIS genau: erste Zeile, deren erste Spalte gleich ist. */
function genauSuchen(tabelle, such) {
  const passt = gleichWie(such);
  // Ohne Platzhalter sucht der Rechner über einen Index der ersten Spalte (viele SVERWEISe auf eine große Tabelle).
  if (typeof tabelle.suchen === 'function' && !(typeof such === 'string' && /[*?~]/.test(such))) return tabelle.suchen(such, passt);
  const ersteSpalte = typeof tabelle.teil === 'function' ? tabelle.teil(tabelle.zeilen, 1) : tabelle;
  let treffer = -1;
  alleBelegten(ersteSpalte, (wert, i, j) => {
    if (j !== 0 || !passt(wert)) return true;
    treffer = i;
    return false;
  });
  return treffer;
}

/**
 * SVERWEIS ungefähr: binäre Suche nach der letzten Zeile, deren erste Spalte ≤ Suchwert ist (Ordnung Zahl < Text <
 * Wahrheitswert, leere Zellen und Fehler gelten als größer); sie muss denselben Typ haben wie der Suchwert.
 */
function ungefaehrSuchen(tabelle, such) {
  const r = typRang(such);
  const hoechstens = (w) => {
    if (w === null || w === undefined) return false;
    const rw = typRang(w);
    return rw !== r ? rw < r : vergleichen(w, such) <= 0;
  };
  let unten = 0, oben = tabelle.zeilen - 1, treffer = -1;
  while (unten <= oben) {
    const mitte = Math.floor((unten + oben) / 2);
    if (hoechstens(tabelle.wert(mitte, 0))) { treffer = mitte; unten = mitte + 1; } else oben = mitte - 1;
  }
  return treffer >= 0 && typRang(tabelle.wert(treffer, 0)) === r ? treffer : -1;
}

function sverweis([suchArg, tabelleArg, spalteArg, ungefaehrArg]) {
  const such = skalar(suchArg());
  if (istFehler(such)) return such;
  const t = tabelleArg();
  if (istFehler(t)) return t;
  const tabelle = alsBereich(t);
  const spalte = zahlArg(spalteArg);
  if (istFehler(spalte)) return spalte;
  const ungefaehr = ungefaehrArg === undefined ? true : zuBool(skalar(ungefaehrArg()));
  if (istFehler(ungefaehr)) return ungefaehr;
  const k = Math.trunc(spalte);
  if (k < 1) return FEHLER.VALUE;
  if (k > tabelle.spalten) return FEHLER.REF;
  if (such === null || such === undefined) return FEHLER.NA;
  const zeile = ungefaehr ? ungefaehrSuchen(tabelle, such) : genauSuchen(tabelle, such);
  return zeile < 0 ? FEHLER.NA : tabelle.wert(zeile, k - 1); // eine leere Zelle bleibt leer (als Zellergebnis 0)
}

/** Bereich ab derselben oberen linken Ecke in anderer Größe (Summenbereich von SUMMEWENN). */
function zuschneiden(b, zeilen, spalten) {
  if (b.zeilen === zeilen && b.spalten === spalten) return b;
  if (typeof b.teil === 'function') return b.teil(zeilen, spalten);
  return {
    art: 'bereich', zeilen, spalten, wert: (i, j) => b.wert(i, j),
    * belegte() { for (let i = 0; i < zeilen; i++) for (let j = 0; j < spalten; j++) { const w = b.wert(i, j); if (w !== null && w !== undefined) yield { i, j, wert: w }; } },
  };
}

/** SUMMEWENN: der Summenbereich beginnt oben links im dritten Argument und hat die Größe des ersten; fehlt er, zählt der erste. */
function summewenn([bereichArg, kriteriumArg, summeArg]) {
  const b = bereichArg();
  if (istFehler(b)) return b;
  if (!istBereich(b)) return FEHLER.VALUE;
  const pruefe = kriterium(skalar(kriteriumArg()));
  let s = b;
  if (summeArg !== undefined) {
    const x = summeArg();
    if (istFehler(x)) return x;
    if (istBereich(x)) s = zuschneiden(x, b.zeilen, b.spalten);
    else if (!istLeer(x)) return FEHLER.VALUE;
  }
  let gesamt = 0, fehler = null;
  const dazu = (v) => {
    if (istFehler(v)) { fehler = v; return false; }
    if (typeof v === 'number') gesamt += v;
    return true;
  };
  // Erfüllen auch leere Zellen das Kriterium, läuft die Suche über die belegten Summenzellen, sonst über die belegten
  // Kriteriumszellen – nie über alle Zellen eines ganzen Spaltenbereichs.
  if (pruefe(null)) alleBelegten(s, (wert, i, j) => (pruefe(b.wert(i, j)) ? dazu(wert) : true));
  else alleBelegten(b, (wert, i, j) => (pruefe(wert) ? dazu(s === b ? wert : s.wert(i, j)) : true));
  return fehler ?? endlich(gesamt);
}

/** ZÄHLENWENN: passende belegte Zellen, dazu alle leeren, wenn das Kriterium auf leer passt. */
function zaehlenwenn([bereichArg, kriteriumArg]) {
  const b = bereichArg();
  if (istFehler(b)) return b;
  if (!istBereich(b)) return FEHLER.VALUE;
  const pruefe = kriterium(skalar(kriteriumArg()));
  let n = 0, belegt = 0;
  alleBelegten(b, (wert) => { belegt++; if (pruefe(wert)) n++; });
  return pruefe(null) ? n + b.zeilen * b.spalten - belegt : n;
}

const jetzt = (umgebung) => (typeof umgebung?.jetzt === 'function' ? umgebung.jetzt() : new Date());

function text([wertArg, formatArg]) {
  const w = skalar(wertArg());
  if (istFehler(w)) return w;
  const f = zuText(skalar(formatArg()));
  if (istFehler(f)) return f;
  return textFormat(w, f);
}

/** VERKETTEN: jedes Argument als Text; ein Bereich (größer als eine Zelle) → #VALUE!, mehr als 32 767 Zeichen auch. */
function verketten(argumente) {
  let aus = '';
  for (const arg of argumente) {
    const t = zuText(skalar(arg()));
    if (istFehler(t)) return t;
    aus += t;
    if (aus.length > GRENZEN.w) return FEHLER.VALUE;
  }
  return aus;
}

const eintrag = (de, min, max, fn, volatil = false) => Object.freeze(volatil ? { de, min, max, volatil: true, fn } : { de, min, max, fn });

export const FUNKTIONEN = Object.freeze({
  SUM: eintrag('SUMME', 1, 255, summe),
  AVERAGE: eintrag('MITTELWERT', 1, 255, mittelwert),
  MIN: eintrag('MIN', 1, 255, extrem((a, b) => a < b)),
  MAX: eintrag('MAX', 1, 255, extrem((a, b) => a > b)),
  COUNT: eintrag('ANZAHL', 1, 255, anzahl),
  COUNTA: eintrag('ANZAHL2', 1, 255, anzahl2),
  IF: eintrag('WENN', 2, 3, wenn),
  AND: eintrag('UND', 1, 255, und),
  OR: eintrag('ODER', 1, 255, oder),
  ROUND: eintrag('RUNDEN', 2, 2, runden),
  VLOOKUP: eintrag('SVERWEIS', 3, 4, sverweis),
  SUMIF: eintrag('SUMMEWENN', 2, 3, summewenn),
  COUNTIF: eintrag('ZÄHLENWENN', 2, 2, zaehlenwenn),
  TODAY: eintrag('HEUTE', 0, 0, (argumente, umgebung) => Math.floor(jetztSerie(jetzt(umgebung))), true),
  NOW: eintrag('JETZT', 0, 0, (argumente, umgebung) => jetztSerie(jetzt(umgebung)), true),
  TEXT: eintrag('TEXT', 2, 2, text),
  CONCATENATE: eintrag('VERKETTEN', 1, 255, verketten),
});

// Deutsch → englisch; ohne Umlaut geschrieben gilt auch (ZAEHLENWENN = ZÄHLENWENN).
const ohneUmlaut = (s) => s.replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE');
const AUS_DEUTSCH = new Map();
for (const [en, { de }] of Object.entries(FUNKTIONEN)) { AUS_DEUTSCH.set(de, en); AUS_DEUTSCH.set(ohneUmlaut(de), en); }

/** Deutscher Funktionsname (Groß/Klein egal) → englischer; unbekannt → null. */
export function funktionAusDeutsch(name) {
  return typeof name === 'string' ? AUS_DEUTSCH.get(name.toUpperCase()) ?? null : null;
}

/** Englischer Funktionsname → deutscher; unbekannt → null. */
export function funktionAufDeutsch(en) {
  const gross = typeof en === 'string' ? en.toUpperCase() : '';
  return Object.hasOwn(FUNKTIONEN, gross) ? FUNKTIONEN[gross].de : null;
}
