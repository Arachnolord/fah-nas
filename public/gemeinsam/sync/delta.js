// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Delta (Plan 05): Text mit Attributen und Embeds als Folge von Ops – {insert, attributes?}, {retain, attributes?},
// {delete} – nach Quill-Semantik. Ein Dokument besteht nur aus insert-Ops. Rechenregeln: anwenden, zusammensetzen,
// transformieren (Jupiter: 'links' = die andere Op kam später, 'rechts' = diese kam später), invertieren und Positionen
// verschieben. Embeds ({bild}, {tabelle}, …) haben die Länge 1; ihre eigenen Änderungen ({retain:{name: op}}) rechnet
// ein im Register eingetragener Handler. Läuft unverändert im Browser und im Web-Dienst; ändert nie die Eingaben.

import { SyncFehler } from './fehler.js';

const HANDLER = new Map();
const fehler = (meldung) => new SyncFehler('E_PARAMS', meldung, { feld: 'op' });
const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
/** Keine Element-Änderung (null bzw. leere Liste, z. B. Tabellen-Ops) → einfaches retain. */
const leer = (w) => w === null || w === undefined || (Array.isArray(w) && w.length === 0);

/** Embed-Handler eintragen: {anwenden(wert, op), transformiere(a, b, seite), zusammensetzen(a, b), invertieren(op, basisWert)}. */
export function registriereEmbed(name, handler) { HANDLER.set(name, handler); }

function handler(name) {
  const h = HANDLER.get(name);
  if (!h) throw fehler(`Unbekanntes Element „${String(name).slice(0, 40)}“`);
  return h;
}

/** Name und Wert eines Embed-Objekts ({bild:{…}} → ['bild', {…}]); genau ein Schlüssel. */
function embedTeile(obj) {
  const k = istObjekt(obj) ? Object.keys(obj) : [];
  if (k.length !== 1) throw fehler('Ungültiges Element');
  return [k[0], obj[k[0]]];
}

export function opLaenge(op) {
  if (typeof op.delete === 'number') return op.delete;
  if (op.retain !== undefined) return typeof op.retain === 'number' ? op.retain : 1;
  return typeof op.insert === 'string' ? op.insert.length : 1;
}

/** Länge eines Deltas (Summe aller Ops). */
export function laenge(delta) { let n = 0; for (const op of delta) n += opLaenge(op); return n; }

/** Länge des Stands, auf den eine Änderung passt (retain + delete). */
export function basisLaenge(aenderung) {
  let n = 0;
  for (const op of aenderung) if (op.insert === undefined) n += opLaenge(op);
  return n;
}

/** Tiefer Vergleich von JSON-Werten (fehlende Schlüssel = undefined). */
export function gleich(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => gleich(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && gleich(a[k], b[k]));
}

/** Attribute aufräumen: leere → undefined; bei insert fallen null-Werte weg. */
function attrSauber(attributes, ohneNull) {
  if (!istObjekt(attributes)) return undefined;
  const aus = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || (ohneNull && v === null)) continue;
    aus[k] = v;
  }
  return Object.keys(aus).length ? aus : undefined;
}

/** Neue Op (Kopie) mit sauberen Attributen; Länge 0 → null. */
function kopie(op) {
  if (typeof op.delete === 'number') return op.delete > 0 ? { delete: op.delete } : null;
  if (op.retain !== undefined) {
    if (typeof op.retain === 'number' && !(op.retain > 0)) return null;
    const attributes = attrSauber(op.attributes, false);
    return attributes ? { retain: op.retain, attributes } : { retain: op.retain };
  }
  if (op.insert === undefined || op.insert === '') return null;
  const attributes = attrSauber(op.attributes, true);
  return attributes ? { insert: op.insert, attributes } : { insert: op.insert };
}

/** Op anhängen und dabei verschmelzen (Quill push): insert steht vor einem direkt vorausgehenden delete. */
function anhaengen(aus, op) {
  const neu = kopie(op);
  if (!neu) return;
  let i = aus.length;
  let letzte = aus[i - 1];
  if (letzte) {
    if (neu.delete !== undefined && letzte.delete !== undefined) { aus[i - 1] = { delete: letzte.delete + neu.delete }; return; }
    if (letzte.delete !== undefined && neu.insert !== undefined) {
      i -= 1; letzte = aus[i - 1];
      if (!letzte) { aus.unshift(neu); return; }
    }
    if (gleich(letzte.attributes, neu.attributes)) {
      if (typeof neu.insert === 'string' && typeof letzte.insert === 'string') { aus[i - 1] = mitAttr({ insert: letzte.insert + neu.insert }, neu.attributes); return; }
      if (typeof neu.retain === 'number' && typeof letzte.retain === 'number') { aus[i - 1] = mitAttr({ retain: letzte.retain + neu.retain }, neu.attributes); return; }
    }
  }
  aus.splice(i, 0, neu);
}

function mitAttr(op, attributes) { if (attributes) op.attributes = attributes; return op; }

/** Am Ende stehende retain ohne Attribute fallen weg. */
function kuerzen(aus) {
  while (aus.length) {
    const l = aus[aus.length - 1];
    if (typeof l.retain === 'number' && !l.attributes) aus.pop(); else break;
  }
  return aus;
}

/** Delta in die kanonische Form bringen (verschmelzen, Leeres weg, insert vor delete, retain am Ende weg). */
export function normalisieren(ops) {
  const aus = [];
  for (const op of ops || []) anhaengen(aus, op);
  return kuerzen(aus);
}

/** Läuft stückweise über die Ops eines Deltas. */
class Iter {
  constructor(ops) { this.ops = ops; this.i = 0; this.off = 0; }
  hat() { return this.rest() < Infinity; }
  rest() { const op = this.ops[this.i]; return op ? opLaenge(op) - this.off : Infinity; }
  typ() {
    const op = this.ops[this.i];
    if (!op) return 'retain';
    if (typeof op.delete === 'number') return 'delete';
    return op.retain !== undefined ? 'retain' : 'insert';
  }
  naechste(n = Infinity) {
    const op = this.ops[this.i];
    if (!op) return { retain: Infinity };
    const offen = opLaenge(op) - this.off;
    const off = this.off;
    if (n >= offen) { n = offen; this.i += 1; this.off = 0; } else this.off += n;
    if (typeof op.delete === 'number') return { delete: n };
    if (op.retain !== undefined) return mitAttr({ retain: typeof op.retain === 'number' ? n : op.retain }, op.attributes);
    if (typeof op.insert === 'string') return mitAttr({ insert: op.insert.substr(off, n) }, op.attributes);
    return mitAttr({ insert: op.insert }, op.attributes);
  }
  /** Alle übrigen Teil-Ops am Stück (eine angebrochene zuerst als Rest); danach ist der Iterator erschöpft. */
  restListe() {
    if (this.i >= this.ops.length) return [];
    const kopf = this.off > 0 ? [this.naechste()] : [];
    const aus = kopf.concat(this.ops.slice(this.i));
    this.i = this.ops.length; this.off = 0;
    return aus;
  }
}

/** Teil-Ops am Stück anhängen: die erste mit Verschmelzen, der Rest unverändert (Ops werden nie nachträglich geändert). */
function anhaengenAlle(aus, liste) {
  if (!liste.length) return;
  anhaengen(aus, liste[0]);
  for (let i = 1; i < liste.length; i++) aus.push(liste[i]);
}

/** Teilstück eines Dokuments von `von` bis `bis` (Zeichenpositionen). */
export function teil(dok, von, bis = Infinity) {
  const aus = [];
  const it = new Iter(dok);
  let i = 0;
  while (i < bis && it.hat()) {
    if (i < von) { const x = it.naechste(von - i); i += opLaenge(x); continue; }
    const x = it.naechste(bis - i);
    i += opLaenge(x);
    aus.push(x);
  }
  return normalisieren(aus);
}

/** Attribute zusammensetzen: b überschreibt a; `mitNull` behält null (retain auf retain). */
function attrZusammen(a, b, mitNull) {
  const aus = { ...(istObjekt(b) ? b : {}) };
  for (const [k, v] of Object.entries(istObjekt(a) ? a : {})) if (v !== undefined && b?.[k] === undefined) aus[k] = v;
  return attrSauber(aus, !mitNull);
}

/** Zwei Änderungen zu einer zusammenfassen (erst a, dann b); auf ein Dokument angewandt ergibt das ein Dokument. */
export function zusammensetzen(a, b) {
  const A = new Iter(a); const B = new Iter(b);
  const aus = [];
  while (A.hat() || B.hat()) {
    // ist eine Seite zu Ende, bleibt der Rest der anderen, wie er ist (Schnellweg für lange Änderungen)
    if (!B.hat()) { anhaengenAlle(aus, A.restListe()); break; }
    if (!A.hat()) { anhaengenAlle(aus, B.restListe()); break; }
    if (B.typ() === 'insert') { anhaengen(aus, B.naechste()); continue; }
    if (A.typ() === 'delete') { anhaengen(aus, A.naechste()); continue; }
    const n = Math.min(A.rest(), B.rest());
    const x = A.naechste(n); const y = B.naechste(n);
    if (y.retain !== undefined) {
      const neu = {};
      if (x.retain !== undefined) {
        // retain auf retain: Zahl gegen Zahl → Zahl, Embed gegen Zahl → Embed, Embed gegen Embed → Handler
        if (typeof y.retain === 'object') {
          if (typeof x.retain === 'object') {
            const [nx, wx] = embedTeile(x.retain); const [ny, wy] = embedTeile(y.retain);
            if (nx !== ny) throw fehler('Änderung passt nicht zum Element');
            const z = handler(nx).zusammensetzen(wx, wy);
            neu.retain = leer(z) ? 1 : { [nx]: z };
          } else neu.retain = y.retain;
        } else neu.retain = typeof x.retain === 'object' ? x.retain : n;
        const attributes = attrZusammen(x.attributes, y.attributes, true);
        if (attributes) neu.attributes = attributes;
      } else {
        // retain auf insert
        if (typeof y.retain === 'object') {
          if (typeof x.insert !== 'object') throw fehler('Element-Änderung auf Text');
          const [nx, wx] = embedTeile(x.insert); const [ny, wy] = embedTeile(y.retain);
          if (nx !== ny) throw fehler('Änderung passt nicht zum Element');
          neu.insert = { [nx]: handler(nx).anwenden(wx, wy) };
        } else neu.insert = x.insert;
        const attributes = attrZusammen(x.attributes, y.attributes, false);
        if (attributes) neu.attributes = attributes;
      }
      anhaengen(aus, neu);
    } else if (y.delete !== undefined && x.retain !== undefined) {
      anhaengen(aus, y);
    }
    // delete auf insert: beide entfallen
  }
  return kuerzen(aus);
}

/** Änderung auf ein Dokument anwenden → neues Dokument; passt sie nicht → SyncFehler E_PARAMS. */
export function anwenden(dok, aenderung) {
  if (basisLaenge(aenderung) > laenge(dok)) throw fehler('Änderung passt nicht zum Dokument');
  const aus = zusammensetzen(dok, aenderung);
  if (aus.some((op) => op.insert === undefined)) throw fehler('Änderung passt nicht zum Dokument');
  return aus;
}

/** Attribute transformieren: 'rechts' (eigene kam später) → eigene; sonst eigene ohne die Schlüssel der anderen. */
function attrT(eigene, gegen, seite) {
  if (!eigene) return undefined;
  if (seite === 'rechts' || !gegen) return eigene;
  const aus = {};
  for (const [k, v] of Object.entries(eigene)) if (!Object.hasOwn(gegen, k)) aus[k] = v;
  return Object.keys(aus).length ? aus : undefined;
}

/** a gegen b transformieren (beide auf demselben Stand): 'links' = b kam später, 'rechts' = a kam später. */
export function transformiere(a, b, seite) {
  const A = new Iter(a); const B = new Iter(b);
  const aus = [];
  while (A.hat() || B.hat()) {
    // B zu Ende: der Rest von a bleibt, wie er ist; a zu Ende: es kämen nur noch retain, die kuerzen ohnehin streicht
    if (!B.hat()) { anhaengenAlle(aus, A.restListe()); break; }
    if (!A.hat()) break;
    if (A.typ() === 'insert' && (seite === 'links' || B.typ() !== 'insert')) { anhaengen(aus, A.naechste()); continue; }
    if (B.typ() === 'insert') { anhaengen(aus, { retain: opLaenge(B.naechste()) }); continue; }
    const n = Math.min(A.rest(), B.rest());
    const x = A.naechste(n); const y = B.naechste(n);
    if (y.delete !== undefined) continue; // schon gelöscht: a entfällt hier
    if (x.delete !== undefined) { anhaengen(aus, x); continue; }
    let r = typeof x.retain === 'object' ? x.retain : n;
    if (typeof x.retain === 'object' && typeof y.retain === 'object') {
      const [name, wx] = embedTeile(x.retain); const [nameY, wy] = embedTeile(y.retain);
      if (name === nameY) {
        const t = handler(name).transformiere(wx, wy, seite);
        r = leer(t) ? 1 : { [name]: t };
      }
    }
    anhaengen(aus, mitAttr({ retain: r }, attrT(x.attributes, y.attributes, seite)));
  }
  return kuerzen(aus);
}

/** Umkehrung einer Änderung gegen den Stand `basis`, auf dem sie angewandt wurde. */
export function invertieren(aenderung, basis) {
  const aus = [];
  let i = 0;
  for (const op of aenderung) {
    if (op.insert !== undefined) { anhaengen(aus, { delete: opLaenge(op) }); continue; }
    if (typeof op.delete === 'number') { for (const s of teil(basis, i, i + op.delete)) anhaengen(aus, s); i += op.delete; continue; }
    if (typeof op.retain === 'number') {
      if (!op.attributes) { anhaengen(aus, { retain: op.retain }); i += op.retain; continue; }
      for (const s of teil(basis, i, i + op.retain)) anhaengen(aus, mitAttr({ retain: opLaenge(s) }, attrUmkehr(op.attributes, s.attributes)));
      i += op.retain;
      continue;
    }
    // Embed-retain
    const [s] = teil(basis, i, i + 1);
    if (!s || typeof s.insert !== 'object') throw fehler('Element-Änderung auf Text');
    const [name, wert] = embedTeile(op.retain);
    const [nameB, basisWert] = embedTeile(s.insert);
    if (name !== nameB) throw fehler('Änderung passt nicht zum Element');
    anhaengen(aus, mitAttr({ retain: { [name]: handler(name).invertieren(wert, basisWert) } }, attrUmkehr(op.attributes, s.attributes)));
    i += 1;
  }
  return kuerzen(aus);
}

/** Für jedes geänderte Attribut den alten Wert (fehlte er → null). */
function attrUmkehr(attr, basisAttr) {
  if (!istObjekt(attr)) return undefined;
  const aus = {};
  for (const [k, v] of Object.entries(attr)) {
    const alt = basisAttr?.[k];
    if (gleich(v, alt === undefined ? null : alt)) continue;
    aus[k] = alt === undefined ? null : alt;
  }
  return Object.keys(aus).length ? aus : undefined;
}

/** Position nach einer Änderung (Quill transformPosition): eigene Einfügungen an der Stelle schieben sie mit. */
export function positionTransformieren(index, aenderung, eigen) {
  let offset = 0;
  for (const op of aenderung) {
    if (offset > index) break;
    const l = opLaenge(op);
    if (typeof op.delete === 'number') { index -= Math.min(l, index - offset); continue; }
    if (op.insert !== undefined && (offset < index || eigen)) index += l;
    offset += l;
  }
  return index;
}
