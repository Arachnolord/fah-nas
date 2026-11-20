// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rechner der Office-Tabelle (Plan 06): hält die Werte aller Zellen einer Mappe und rechnet nach einer Änderung nur
// die betroffenen Formeln neu.
// - Werte liegen je Blatt und Spalte (Zeile → Wert), dazu je Spalte die sortierten belegten Zeilen. Spalten- und
//   Zeilenbereiche (A:A, 3:3) sind so dünn: gelesen werden nur belegte Zellen.
// - Graph: jede Formelzelle kennt ihre Bezüge (abhaengigkeiten). Einzelne Zellen führen über „nach“ zu den Formeln, die
//   sie nennen. Jeder Bereich ist ein eigener Knoten (gleiche Bereiche mehrerer Formeln nur einmal, z. B. die Tabelle
//   aller SVERWEISe), gefunden über einen Index je Spalte (breite Bereiche und ganze Zeilen in einer eigenen Liste).
// - Neu rechnen: betroffen sind die geänderten Zellen und alle Formeln, die über beliebig viele Stufen von ihnen
//   abhängen. Ein Tarjan mit eigenem Stapel (keine Rekursion, auch nicht bei 20 000 verketteten Zellen) zerlegt sie in
//   starke Komponenten und liefert Vorgänger zuerst; eine Komponente mit mehr als einem Knoten oder mit Selbstbezug ist
//   ein Zirkel (#CIRC, angezeigt #ZIRKEL), jede andere Formel wird in dieser Reihenfolge genau einmal ausgewertet.
// - Auswerten läuft rekursiv nur über Klammern und Funktionen (der Parser begrenzt sie auf 256 Ebenen); lange Ketten
//   aus Operatoren und Vorzeichen (1+1+…+1, ----1) laufen in einer Schleife.
// Ohne DOM – derselbe Rechner läuft im Editor und überall, wo eine Mappe gerechnet werden muss (xlsx/csv-Export).

import { EXCEL_MAX, GRENZEN, adresseLesen, spalteZuText } from './adresse.js';
import { parsen } from './parser.js';
import { FUNKTIONEN, istBereich } from './funktionen.js';
import { FEHLER, istFehler, fehlerAusCode, wertAusW, zuZahl, zuText, vergleichen, textSchluessel } from './werte.js';

const UNBEGRENZT = Object.freeze({ zeilen: Infinity, spalten: Infinity });
const LEER = Object.freeze({ art: 'leer' });
/** Bereiche über mindestens so viele Spalten (und ganze Zeilen) stehen nicht je Spalte, sondern in einer Liste. */
const BREIT = 64;
/** Höchstens so viele geparste Formeln im Vorrat; darüber wird er geleert. */
const BAUM_VORRAT = 50000;
/** Höchstens so viele Suchindizes (SVERWEIS genau) zugleich; darüber wird der Vorrat geleert. */
const SUCH_VORRAT = 1000;
const VERGLEICHE = new Set(['=', '<>', '<', '>', '<=', '>=']);

const SPALTEN_TEXT = [];
const spalteText = (s) => SPALTEN_TEXT[s] ?? (SPALTEN_TEXT[s] = spalteZuText(s));
/** Schlüssel einer Zelle: 'blattId|A1' (Bereichsknoten beginnen mit #, Blatt-IDs nie). */
const schluessel = (blatt, z, s) => `${blatt}|${spalteText(s)}${z}`;
const istBereichsknoten = (k) => k.startsWith('#');
const wVon = (zelle) => (typeof zelle?.w === 'string' && zelle.w !== '' ? zelle.w : null);
const einzelzelle = (d) => d.z1 !== null && d.s1 !== null && d.z1 === d.z2 && d.s1 === d.s2;
const gleich = (a, b) => a === b || (istFehler(a) && istFehler(b) && a.fehler === b.fehler);

/** Schlüssel für die genaue Suche: gleiche Werte (Zahl auf 15 Stellen, Text ohne Groß/Klein) → gleicher Schlüssel. */
function suchSchluessel(w) {
  if (typeof w === 'number') return `n${Number(w.toPrecision(15))}`;
  if (typeof w === 'string') return `t${textSchluessel(w)}`;
  if (typeof w === 'boolean') return w ? 'b1' : 'b0';
  return null;
}

/** Bezug-Knoten → {blatt, z1, s1, z2, s2}, geordnet; null = offen (ganze Spalte bzw. Zeile). */
function bezugGrenzen(k, eigenesBlatt) {
  const v = k.von, b = k.bis ?? k.von;
  const spanne = (x, y) => (x === null ? [null, null] : [Math.min(x, y), Math.max(x, y)]);
  const [z1, z2] = spanne(v.z, b.z), [s1, s2] = spanne(v.s, b.s);
  return { blatt: k.blatt ?? eigenesBlatt, z1, s1, z2, s2 };
}

/** Alle Bezüge eines Formelbaums in Lesereihenfolge (ohne Rekursion); Bezüge ohne Blatt gehören zu eigenesBlatt. */
export function abhaengigkeiten(knoten, eigenesBlatt) {
  const aus = [];
  const offen = [knoten];
  while (offen.length) {
    const k = offen.pop();
    if (k.art === 'bezug') aus.push(bezugGrenzen(k, eigenesBlatt));
    else if (k.art === 'funktion') for (let i = k.argumente.length - 1; i >= 0; i--) offen.push(k.argumente[i]);
    else if (k.art === 'binaer') offen.push(k.b, k.a);
    else if (k.art === 'unaer' || k.art === 'prozent') offen.push(k.a);
  }
  return aus;
}

/** Enthält der Baum HEUTE/JETZT (oder eine andere volatile Funktion)? */
function istVolatil(knoten) {
  const offen = [knoten];
  while (offen.length) {
    const k = offen.pop();
    if (k.art === 'funktion') {
      if (Object.hasOwn(FUNKTIONEN, k.name) && FUNKTIONEN[k.name].volatil) return true;
      offen.push(...k.argumente);
    } else if (k.art === 'binaer') offen.push(k.a, k.b);
    else if (k.art === 'unaer' || k.art === 'prozent') offen.push(k.a);
  }
  return false;
}

// ---- Zeilenindex je Spalte ---------------------------------------------------------------------------------------

/** Erste Stelle im sortierten Array mit a[i] ≥ x. */
function untereGrenze(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** Sortierte Zeilen ohne `weg`, mit `neu` (ohne Doppel) – ein Durchgang, auch für viele Änderungen auf einmal. */
function zusammenfuehren(zeilen, neu, weg) {
  const alt = weg.size ? zeilen.filter((z) => !weg.has(z)) : zeilen;
  if (!neu.length) return alt;
  neu.sort((a, b) => a - b);
  const aus = [];
  for (let i = 0, j = 0; i < alt.length || j < neu.length;) {
    const x = j >= neu.length || (i < alt.length && alt[i] <= neu[j]) ? alt[i++] : neu[j++];
    if (aus.length === 0 || aus[aus.length - 1] !== x) aus.push(x);
  }
  return aus;
}

/** Orte (Zeile, Spalte) je Blatt: Spalte → sortierte Zeilen. */
class Ortsindex {
  constructor() { this.karte = new Map(); }

  /** Änderungen [{blatt, z, s, da}] gesammelt einsortieren (da = Ort kommt hinzu, sonst fällt er weg). */
  anwenden(aenderungen) {
    const gruppen = new Map();
    for (const { blatt, z, s, da } of aenderungen) {
      const k = `${blatt}|${s}`;
      let g = gruppen.get(k);
      if (!g) gruppen.set(k, (g = { blatt, s, neu: [], weg: new Set() }));
      if (da) g.neu.push(z); else g.weg.add(z);
    }
    for (const { blatt, s, neu, weg } of gruppen.values()) {
      let spalten = this.karte.get(blatt);
      if (!spalten) this.karte.set(blatt, (spalten = new Map()));
      const zeilen = zusammenfuehren(spalten.get(s) ?? [], neu, weg);
      if (zeilen.length) spalten.set(s, zeilen); else spalten.delete(s);
      if (!spalten.size) this.karte.delete(blatt);
    }
  }

  /** Jeder Ort im Rechteck (Reihenfolge je Spalte, nicht zeilenweise): fn(z, s). */
  jeder(blatt, z1, s1, z2, s2, fn) {
    const spalten = this.karte.get(blatt);
    if (!spalten) return;
    for (const [s, zeilen] of spalten) {
      if (s < s1 || s > s2) continue;
      for (let k = untereGrenze(zeilen, z1); k < zeilen.length && zeilen[k] <= z2; k++) fn(zeilen[k], s);
    }
  }
}

// ---- Rechnen -----------------------------------------------------------------------------------------------------

/** Ein einzelner Wert: 1×1-Bereich → sein Wert, größerer Bereich → #VALUE! (Excel ohne Matrixformeln). */
function einzeln(v) {
  if (istBereich(v)) return v.zeilen === 1 && v.spalten === 1 ? v.wert(0, 0) : FEHLER.VALUE;
  return v === LEER ? null : v;
}

function unaer(op, v) {
  if (istFehler(v) || op === '+') return v; // das vorangestellte + ändert nichts, auch nicht den Typ
  const n = zuZahl(v);
  if (istFehler(n)) return n;
  return n === 0 ? 0 : -n;
}

function prozent(v) {
  if (istFehler(v)) return v;
  const n = zuZahl(v);
  return istFehler(n) ? n : n / 100;
}

/** a op b wie Excel: & verkettet Texte, Vergleiche über vergleichen, sonst Zahlen; nicht endlich → #NUM!. */
function rechnen(op, a, b) {
  if (istFehler(a)) return a;
  if (op === '&') {
    if (istFehler(b)) return b;
    const x = zuText(a), y = zuText(b);
    if (istFehler(x)) return x;
    if (istFehler(y)) return y;
    return x.length + y.length > GRENZEN.w ? FEHLER.VALUE : x + y;
  }
  if (VERGLEICHE.has(op)) {
    if (istFehler(b)) return b;
    const c = vergleichen(a, b);
    return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  }
  const x = zuZahl(a);
  if (istFehler(x)) return x;
  if (istFehler(b)) return b;
  const y = zuZahl(b);
  if (istFehler(y)) return y;
  let r;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/': if (y === 0) return FEHLER.DIV0; r = x / y; break;
    case '^':
      if (x === 0 && y === 0) return FEHLER.NUM;
      if (x === 0 && y < 0) return FEHLER.DIV0;
      r = x ** y; break;
    default: return FEHLER.VALUE;
  }
  return Number.isFinite(r) ? r + 0 : FEHLER.NUM; // + 0 macht aus -0 eine 0
}

export class Rechner {
  constructor({ jetzt = () => new Date() } = {}) {
    this.umgebung = { jetzt };
    this.statistik = { berechnet: 0 };
    this.baeume = new Map(); // Formeltext → Baum (null = nicht lesbar, wertet zu #NAME?)
    this._stand = 0; // zählt jede Wertänderung; jede Spalte merkt sich die letzte (Suchindex veraltet?)
    this._leeren();
  }

  _leeren() {
    this.werteJeSpalte = new Map(); // blatt → Map<s, {werte: Map<z, Wert>, stand}> aller belegten Zellen (Formeln: Ergebnis)
    this.suchIndex = new Map(); // 'blatt|s|z1|z2' → {spalte, stand, karte: Map<Suchschlüssel, Zeilen>}
    this.wTexte = new Map(); // 'blatt|A1' → w
    this.formeln = new Map(); // 'blatt|A1' → {w, baum, vor, volatil, blatt, z, s, bereiche}
    this.nach = new Map(); // 'blatt|A1' → Set der Formeln, die diese Zelle einzeln nennen
    this.bereiche = new Map(); // '#blatt|z1|s1|z2|s2' → {id, blatt, z1, s1, z2, s2, nutzer: Set der Formeln}
    this.bereichsIndex = new Map(); // blatt → {spalten: Map<s, Set<Bereichsknoten>>, breit: Set<Bereichsknoten>}
    this.belegt = new Ortsindex(); // alle Zellen mit w
    this.formelOrte = new Ortsindex(); // nur Formelzellen
    this.volatile = new Set();
    this.blaetter = new Set();
  }

  /** Wert einer Zelle; leer → null. */
  wert(blattId, adr) {
    const o = adresseLesen(adr, UNBEGRENZT);
    return o ? this._wertBei(blattId, o.z, o.s) : null;
  }

  _wertBei(blatt, z, s) { return this.werteJeSpalte.get(blatt)?.get(s)?.werte.get(z) ?? null; }

  _wertSetzen(blatt, z, s, w) {
    let spalten = this.werteJeSpalte.get(blatt);
    if (!spalten) this.werteJeSpalte.set(blatt, (spalten = new Map()));
    let spalte = spalten.get(s);
    if (!spalte) spalten.set(s, (spalte = { werte: new Map(), stand: 0 }));
    spalte.werte.set(z, w);
    spalte.stand = ++this._stand;
  }

  _wertLoeschen(blatt, z, s) {
    const spalten = this.werteJeSpalte.get(blatt), spalte = spalten?.get(s);
    if (!spalte) return;
    spalte.werte.delete(z);
    spalte.stand = ++this._stand;
    if (spalte.werte.size) return;
    spalten.delete(s);
    if (!spalten.size) this.werteJeSpalte.delete(blatt);
  }

  /**
   * SVERWEIS genau: erste Zeile in Spalte s (z1…z2), deren Wert gleich `such` ist, über einen Index Schlüssel → Zeilen.
   * Der Index gilt, bis sich ein Wert der Spalte ändert; in einem Rechenlauf stehen die Werte der Tabelle fest, bevor
   * der erste SVERWEIS sie liest (der Bereich ist ein Vorgänger), er wird also einmal gebaut. → Zeile ab z1 (0-basiert) oder -1.
   */
  _suchen(blatt, z1, s, z2, such, passt) {
    const spalte = this.werteJeSpalte.get(blatt)?.get(s), schluesselSuche = suchSchluessel(such);
    if (!spalte || schluesselSuche === null) return -1;
    const id = `${blatt}|${s}|${z1}|${z2}`;
    let index = this.suchIndex.get(id);
    if (!index || index.spalte !== spalte || index.stand !== spalte.stand) {
      const karte = new Map();
      this._jeder(blatt, z1, s, z2, s, (w, z) => {
        const k = suchSchluessel(w);
        if (k === null) return;
        const zeilen = karte.get(k);
        if (zeilen) zeilen.push(z); else karte.set(k, [z]);
      });
      if (this.suchIndex.size >= SUCH_VORRAT) this.suchIndex.clear();
      this.suchIndex.set(id, (index = { spalte, stand: spalte.stand, karte }));
    }
    for (const z of index.karte.get(schluesselSuche) ?? []) if (passt(spalte.werte.get(z))) return z - z1;
    return -1;
  }

  /** Alles neu aufbauen und rechnen (Laden, Struktur-Ops, Import). */
  setzen(daten) {
    this._leeren();
    this.statistik.berechnet = 0;
    const orte = [], formelOrte = [];
    for (const blatt of daten?.blaetter ?? []) {
      this.blaetter.add(blatt.id);
      for (const [adr, zelle] of Object.entries(blatt.zellen ?? {})) {
        const w = wVon(zelle), o = w === null ? null : adresseLesen(adr, UNBEGRENZT);
        if (!o) continue;
        const ort = { blatt: blatt.id, z: o.z, s: o.s, da: true };
        this.wTexte.set(`${blatt.id}|${adr}`, w);
        orte.push(ort);
        if (w.startsWith('=')) { this._formelEintragen(`${blatt.id}|${adr}`, blatt.id, o.z, o.s, w); formelOrte.push(ort); } else this._wertSetzen(blatt.id, o.z, o.s, wertAusW(w));
      }
    }
    this.belegt.anwenden(orte);
    this.formelOrte.anwenden(formelOrte);
    this._neuRechnen(new Set(this.formeln.keys()));
  }

  /**
   * Zellen `adressen` auf Blatt `blattId` haben sich in `daten` geändert: Graph nachführen, Betroffenes neu rechnen.
   * → Schlüssel 'blatt|A1' aller Zellen mit neuem Wert, dazu immer die übergebenen. Kam ein Blatt hinzu oder fiel eines
   * weg, wird alles neu aufgebaut (Bezüge auf das Blatt ändern ihren Wert).
   */
  aendern(daten, blattId, adressen) {
    if (!this._gleicheBlaetter(daten)) return this._neuAufbauen(daten, blattId, adressen);
    const zellen = daten.blaetter.find((b) => b.id === blattId)?.zellen ?? {};
    const start = [], orte = [], formelOrte = [];
    for (const adr of adressen) {
      const o = adresseLesen(adr, UNBEGRENZT);
      if (!o) continue;
      const key = `${blattId}|${adr}`, ort = { blatt: blattId, z: o.z, s: o.s };
      const alt = this.wTexte.get(key) ?? null, neu = Object.hasOwn(zellen, adr) ? wVon(zellen[adr]) : null;
      start.push({ key, ...ort });
      if (alt === neu) continue;
      if (alt !== null && alt.startsWith('=')) { this._formelEntfernen(key); formelOrte.push({ ...ort, da: false }); }
      if (neu === null) { this.wTexte.delete(key); this._wertLoeschen(blattId, o.z, o.s); orte.push({ ...ort, da: false }); continue; }
      this.wTexte.set(key, neu);
      if (alt === null) orte.push({ ...ort, da: true });
      if (neu.startsWith('=')) { this._formelEintragen(key, blattId, o.z, o.s, neu); formelOrte.push({ ...ort, da: true }); } else this._wertSetzen(blattId, o.z, o.s, wertAusW(neu));
    }
    this.belegt.anwenden(orte);
    this.formelOrte.anwenden(formelOrte);
    const geaendert = this._neuRechnen(this._betroffen(start));
    for (const { key } of start) geaendert.add(key);
    return geaendert;
  }

  /** HEUTE/JETZT und alles, was davon abhängt, neu rechnen. → Schlüssel der Zellen mit neuem Wert. */
  volatileNeu(daten) {
    if (!this._gleicheBlaetter(daten)) return this._neuAufbauen(daten, null, []);
    const start = [...this.volatile].map((key) => { const f = this.formeln.get(key); return { key, blatt: f.blatt, z: f.z, s: f.s }; });
    return this._neuRechnen(this._betroffen(start));
  }

  _gleicheBlaetter(daten) {
    const ids = (daten?.blaetter ?? []).map((b) => b.id);
    return ids.length === this.blaetter.size && ids.every((id) => this.blaetter.has(id));
  }

  /** Alle Werte als 'blatt|A1' → Wert (nur für den Vergleich beim Neuaufbau). */
  _alleWerte() {
    const aus = new Map();
    for (const [blatt, spalten] of this.werteJeSpalte) for (const [s, spalte] of spalten) for (const [z, w] of spalte.werte) aus.set(schluessel(blatt, z, s), w);
    return aus;
  }

  /** Alles neu, Rückgabe wie aendern über den Vergleich alter und neuer Werte; der Zähler läuft weiter. */
  _neuAufbauen(daten, blattId, adressen) {
    const alt = this._alleWerte(), bisher = this.statistik.berechnet;
    this.setzen(daten);
    this.statistik.berechnet += bisher;
    const neu = this._alleWerte(), geaendert = new Set();
    for (const [k, w] of neu) if (!gleich(alt.get(k), w)) geaendert.add(k);
    for (const k of alt.keys()) if (!neu.has(k)) geaendert.add(k);
    for (const adr of adressen) geaendert.add(`${blattId}|${adr}`);
    return geaendert;
  }

  // ---- Graph -----------------------------------------------------------------------------------------------------

  _formelEintragen(key, blatt, z, s, w) {
    let baum = this.baeume.get(w);
    if (baum === undefined) {
      try { baum = parsen(w.slice(1), 'intern'); } catch { baum = null; } // FormelFehler → #NAME?
      if (this.baeume.size >= BAUM_VORRAT) this.baeume.clear();
      this.baeume.set(w, baum);
    }
    const vor = baum ? abhaengigkeiten(baum, blatt) : [];
    const volatil = baum ? istVolatil(baum) : false;
    const bereiche = [];
    for (const d of vor) {
      if (einzelzelle(d)) {
        const ziel = schluessel(d.blatt, d.z1, d.s1);
        let menge = this.nach.get(ziel);
        if (!menge) this.nach.set(ziel, (menge = new Set()));
        menge.add(key);
      } else {
        const b = this._bereichsknoten(d);
        b.nutzer.add(key);
        bereiche.push(b);
      }
    }
    this.formeln.set(key, { w, baum, vor, volatil, blatt, z, s, bereiche });
    if (volatil) this.volatile.add(key);
  }

  _formelEntfernen(key) {
    const f = this.formeln.get(key);
    if (!f) return;
    for (const d of f.vor) {
      if (!einzelzelle(d)) continue;
      const ziel = schluessel(d.blatt, d.z1, d.s1), menge = this.nach.get(ziel);
      if (menge) { menge.delete(key); if (!menge.size) this.nach.delete(ziel); }
    }
    for (const b of f.bereiche) {
      b.nutzer.delete(key);
      if (!b.nutzer.size && this.bereiche.get(b.id) === b) this._bereichsknotenEntfernen(b);
    }
    this.formeln.delete(key);
    this.volatile.delete(key);
  }

  /** Knoten für einen Bereich (gleiche Bereiche teilen sich einen), eingetragen im Spaltenindex des Blatts. */
  _bereichsknoten(d) {
    const z1 = d.z1 ?? 1, z2 = d.z2 ?? Infinity, s1 = d.s1 ?? 1, s2 = d.s2 ?? Infinity;
    const id = `#${d.blatt}|${z1}|${s1}|${z2}|${s2}`;
    let b = this.bereiche.get(id);
    if (b) return b;
    b = { id, blatt: d.blatt, z1, s1, z2, s2, nutzer: new Set() };
    this.bereiche.set(id, b);
    let index = this.bereichsIndex.get(d.blatt);
    if (!index) this.bereichsIndex.set(d.blatt, (index = { spalten: new Map(), breit: new Set() }));
    if (s2 - s1 < BREIT) {
      for (let s = s1; s <= s2; s++) {
        let menge = index.spalten.get(s);
        if (!menge) index.spalten.set(s, (menge = new Set()));
        menge.add(b);
      }
    } else index.breit.add(b);
    return b;
  }

  _bereichsknotenEntfernen(b) {
    this.bereiche.delete(b.id);
    const index = this.bereichsIndex.get(b.blatt);
    if (!index) return;
    if (b.s2 - b.s1 < BREIT) {
      for (let s = b.s1; s <= b.s2; s++) {
        const menge = index.spalten.get(s);
        if (menge) { menge.delete(b); if (!menge.size) index.spalten.delete(s); }
      }
    } else index.breit.delete(b);
    if (!index.spalten.size && !index.breit.size) this.bereichsIndex.delete(b.blatt);
  }

  /** Die Startzellen und alle Formeln, die über beliebig viele Stufen von ihnen abhängen. */
  _betroffen(start) {
    const menge = new Set(), offen = [], bereicheGesehen = new Set();
    const dazu = (f) => {
      if (menge.has(f)) return;
      menge.add(f);
      const r = this.formeln.get(f);
      offen.push({ key: f, blatt: r.blatt, z: r.z, s: r.s });
    };
    for (const o of start) if (!menge.has(o.key)) { menge.add(o.key); offen.push(o); }
    while (offen.length) {
      const { key, blatt, z, s } = offen.pop();
      const einzeln = this.nach.get(key);
      if (einzeln) for (const f of einzeln) dazu(f);
      const index = this.bereichsIndex.get(blatt);
      if (!index) continue;
      // Jeder Bereich gibt seine Nutzer nur einmal weiter, auch wenn viele seiner Zellen betroffen sind.
      const bereich = (b) => { if (!bereicheGesehen.has(b)) { bereicheGesehen.add(b); for (const f of b.nutzer) dazu(f); } };
      for (const b of index.spalten.get(s) ?? []) if (b.z1 <= z && z <= b.z2) bereich(b);
      for (const b of index.breit) if (b.z1 <= z && z <= b.z2 && b.s1 <= s && s <= b.s2) bereich(b);
    }
    return menge;
  }

  /** Kanten für Tarjan: eine Formel hängt von Formeln (einzeln genannt) und Bereichsknoten ab, ein Bereich von seinen Formeln. */
  _vorgaenger(knoten, menge) {
    const aus = [];
    if (istBereichsknoten(knoten)) {
      const b = this.bereiche.get(knoten);
      this.formelOrte.jeder(b.blatt, b.z1, b.s1, b.z2, b.s2, (z, s) => { const k = schluessel(b.blatt, z, s); if (menge.has(k)) aus.push(k); });
      return aus;
    }
    const f = this.formeln.get(knoten);
    for (const d of f.vor) {
      if (!einzelzelle(d)) continue;
      const k = schluessel(d.blatt, d.z1, d.s1);
      if (menge.has(k) && this.formeln.has(k)) aus.push(k);
    }
    for (const b of f.bereiche) aus.push(b.id);
    return aus;
  }

  /** Starke Komponenten der Formeln in `menge` (Tarjan mit eigenem Stapel), Vorgänger zuerst. */
  * _komponenten(menge) {
    const index = new Map(), tief = new Map(), stapel = [], aufStapel = new Set(), selbst = new Set();
    let n = 0;
    for (const anfang of menge) {
      if (!this.formeln.has(anfang) || index.has(anfang)) continue;
      const aufrufe = [];
      const besuchen = (v) => { index.set(v, n); tief.set(v, n); n++; stapel.push(v); aufStapel.add(v); aufrufe.push({ v, kanten: this._vorgaenger(v, menge), k: 0 }); };
      besuchen(anfang);
      while (aufrufe.length) {
        const rahmen = aufrufe[aufrufe.length - 1], v = rahmen.v;
        if (rahmen.k < rahmen.kanten.length) {
          const w = rahmen.kanten[rahmen.k++];
          if (w === v) selbst.add(v);
          if (!index.has(w)) besuchen(w);
          else if (aufStapel.has(w)) tief.set(v, Math.min(tief.get(v), index.get(w)));
          continue;
        }
        aufrufe.pop();
        if (aufrufe.length) { const u = aufrufe[aufrufe.length - 1].v; tief.set(u, Math.min(tief.get(u), tief.get(v))); }
        if (tief.get(v) !== index.get(v)) continue;
        const liste = [];
        let w;
        do { w = stapel.pop(); aufStapel.delete(w); liste.push(w); } while (w !== v);
        yield { liste, zirkel: liste.length > 1 || selbst.has(v) };
      }
    }
  }

  /** Formeln in `menge` in Abhängigkeitsfolge rechnen; Zirkel → #CIRC. → Schlüssel mit neuem Wert. */
  _neuRechnen(menge) {
    const geaendert = new Set();
    const setzeWert = (k, neu) => {
      const f = this.formeln.get(k), alt = this.werteJeSpalte.get(f.blatt)?.get(f.s)?.werte.get(f.z);
      if (alt !== undefined && gleich(alt, neu)) return; // unverändert: die Spalte behält ihren Stand (Suchindex bleibt gültig)
      geaendert.add(k);
      this._wertSetzen(f.blatt, f.z, f.s, neu);
    };
    for (const { liste, zirkel } of this._komponenten(menge)) {
      if (zirkel) { for (const k of liste) if (!istBereichsknoten(k)) setzeWert(k, FEHLER.CIRC); continue; }
      if (istBereichsknoten(liste[0])) continue;
      setzeWert(liste[0], this._auswerten(liste[0]));
      this.statistik.berechnet++;
    }
    return geaendert;
  }

  // ---- Auswerten -------------------------------------------------------------------------------------------------

  /** Ergebnis einer Formelzelle: ein Bereich nur, wenn er eine Zelle ist (sonst #VALUE!), leer → 0. */
  _auswerten(key) {
    const f = this.formeln.get(key);
    if (!f.baum) return FEHLER.NAME;
    let v;
    try { v = einzeln(this._knoten(f.baum, f.blatt)); } catch (e) {
      if (e instanceof RangeError) return FEHLER.VALUE; // Sicherheitsnetz, falls ein Baum doch zu tief wäre
      throw e;
    }
    return v === null || v === undefined ? 0 : v;
  }

  /** Wert eines Knotens; Operator- und Vorzeichenketten laufen über den linken Ast in einer Schleife. */
  _knoten(k, blatt) {
    const kette = [];
    let x = k;
    while (x.art === 'binaer' || x.art === 'unaer' || x.art === 'prozent') { kette.push(x); x = x.a; }
    let v = this._grundwert(x, blatt);
    for (let i = kette.length - 1; i >= 0; i--) {
      const n = kette[i], a = einzeln(v);
      if (n.art === 'unaer') v = unaer(n.op, a);
      else if (n.art === 'prozent') v = prozent(a);
      else v = istFehler(a) ? a : rechnen(n.op, a, einzeln(this._knoten(n.b, blatt)));
    }
    return v;
  }

  _grundwert(x, blatt) {
    switch (x.art) {
      case 'zahl': case 'text': case 'bool': return x.wert;
      case 'fehler': return fehlerAusCode(x.wert) ?? FEHLER.VALUE;
      case 'bezug': return this._bezug(x, blatt, false);
      case 'funktion': return this._funktion(x, blatt);
      case 'leer': return LEER;
      default: return FEHLER.NAME; // Name (Umsatz) – benannte Bereiche gibt es nicht
    }
  }

  /** Bezug → Wert (eine Zelle) oder Bereich; als Funktionsargument ist auch eine einzelne Zelle ein Bereich. */
  _bezug(x, blatt, alsArgument) {
    const ziel = x.blatt ?? blatt;
    if (!this.blaetter.has(ziel)) return FEHLER.REF; // Blatt gelöscht
    if (x.bis === null) {
      const { z, s } = x.von;
      return alsArgument ? this._bereich(ziel, z, s, z, s) : this._wertBei(ziel, z, s);
    }
    const g = bezugGrenzen(x, blatt);
    return this._bereich(ziel, g.z1 ?? 1, g.s1 ?? 1, g.z2 ?? EXCEL_MAX.zeilen, g.s2 ?? EXCEL_MAX.spalten);
  }

  _funktion(x, blatt) {
    if (!Object.hasOwn(FUNKTIONEN, x.name)) return FEHLER.NAME;
    const argumente = x.argumente.map((a) => () => (a.art === 'leer' ? LEER : a.art === 'bezug' ? this._bezug(a, blatt, true) : this._knoten(a, blatt)));
    const v = FUNKTIONEN[x.name].fn(argumente, this.umgebung);
    return v === undefined ? null : v;
  }

  /** Jede belegte Zelle im Rechteck zeilenweise (in der Zeile Spalten aufsteigend): fn(wert, z, s); false beendet. */
  _jeder(blatt, z1, s1, z2, s2, fn) {
    const zeilenJe = this.belegt.karte.get(blatt), werteJe = this.werteJeSpalte.get(blatt);
    if (!zeilenJe || !werteJe) return;
    const spalten = [];
    for (const s of zeilenJe.keys()) if (s >= s1 && s <= s2) spalten.push(s);
    if (spalten.length === 1) {
      const s = spalten[0], zeilen = zeilenJe.get(s), werte = werteJe.get(s)?.werte;
      for (let k = untereGrenze(zeilen, z1); k < zeilen.length && zeilen[k] <= z2; k++) {
        const w = werte?.get(zeilen[k]);
        if (w !== undefined && w !== null && fn(w, zeilen[k], s) === false) return;
      }
      return;
    }
    // Mehrere Spalten: zeilenweise mischen, je Spalte ein Zeiger auf die nächste belegte Zeile.
    spalten.sort((a, b) => a - b);
    const zeilenListen = spalten.map((s) => zeilenJe.get(s)), werteListen = spalten.map((s) => werteJe.get(s)?.werte);
    const zeiger = zeilenListen.map((zeilen) => untereGrenze(zeilen, z1));
    for (;;) {
      let z = Infinity;
      for (let c = 0; c < spalten.length; c++) if (zeiger[c] < zeilenListen[c].length && zeilenListen[c][zeiger[c]] < z) z = zeilenListen[c][zeiger[c]];
      if (z > z2) return;
      for (let c = 0; c < spalten.length; c++) {
        if (zeiger[c] >= zeilenListen[c].length || zeilenListen[c][zeiger[c]] !== z) continue;
        zeiger[c]++;
        const w = werteListen[c]?.get(z);
        if (w !== undefined && w !== null && fn(w, z, spalten[c]) === false) return;
      }
    }
  }

  /** Bereich (siehe funktionen.js) über die Werte des Rechners, mit jeder(), teil() und suchen(). */
  _bereich(blatt, z1, s1, z2, s2) {
    const r = this;
    const bereich = {
      art: 'bereich', zeilen: z2 - z1 + 1, spalten: s2 - s1 + 1,
      wert: (i, j) => r._wertBei(blatt, z1 + i, s1 + j),
      jeder: (fn) => r._jeder(blatt, z1, s1, z2, s2, (w, z, s) => fn(w, z - z1, s - s1)),
      * belegte() {
        const liste = [];
        bereich.jeder((wert, i, j) => { liste.push({ i, j, wert }); });
        yield* liste;
      },
      teil: (zeilen, spalten) => r._bereich(blatt, z1, s1, z1 + zeilen - 1, s1 + spalten - 1),
      suchen: (such, passt) => r._suchen(blatt, z1, s1, z2, such, passt),
    };
    return bereich;
  }
}
