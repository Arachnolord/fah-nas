// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „tabelle“ (Plan 06) für den Sync-Motor (V12). Daten: {blaetter:[{id, name, pos, zellen:{'A1':{w?, f?}},
// spalten:{'B':{breite}}, zeilen:{'3':{hoehe}}, fixiert:{zeilen}}]}, Blätter nach (pos, id) sortiert. Zell-Ops setzen
// je Feld („null“ entfernt, Standardwerte werden nie gespeichert, eine leere Zelle verschwindet). Struktur-Ops (Zeilen
// oder Spalten einfügen/löschen) verschieben Zellen und Metadaten ihres Blatts und die Bezüge jeder Formel aller
// Blätter – mit denselben Regeln wie formeln/verschieben.js, damit Browser und Web-Dienst gleich rechnen. anwenden
// ändert nie die Eingabe und wirft nicht; Ops auf unbekannte Blätter ändern nichts. Ein gelöschtes Blatt nimmt die
// Bezüge darauf mit (#REF!); ob danach das leere Standardblatt „blatt1“ entsteht, entscheidet die Liste `rest` der Op.
// invertieren liefert die Umkehrung einer Op für Rückgängig im Editor (der Server ruft es nie).

import { SyncFehler } from '../fehler.js';
import { ID_MUSTER, neueId } from './dokument-attribute.js';
import { GRENZEN, adresseLesen, adresse, spalteZuText, textZuSpalte, bereichLesen, bereichText } from '../../../office/tabelle/formeln/adresse.js';
import { strukturVerschieben, indexVerschieben, spanneVerschieben } from '../../../office/tabelle/formeln/verschieben.js';
import { zerlegen, tokensText } from '../../../office/tabelle/formeln/lexer.js';

export const OP_TYPEN = Object.freeze([
  'zelle', 'zellen', 'zeilen_einfuegen', 'zeilen_loeschen', 'spalten_einfuegen', 'spalten_loeschen', 'sortieren',
  'blatt_neu', 'blatt_umbenennen', 'blatt_loeschen', 'blatt_verschieben', 'spalte_breite', 'fixieren', 'noop',
]);
export const F_FELDER = Object.freeze(['fett', 'kursiv', 'farbe', 'hinter', 'ausr', 'zahl']);
/** Alle sechs Formatfelder entfernt – so setzt eine Op das ganze Format einer Zelle zurück. */
export const LEER_F = Object.freeze({ fett: null, kursiv: null, farbe: null, hinter: null, ausr: null, zahl: null });

/** Struktur-Ops: Achse und Art (wie verschieben.js sie erwartet). */
const STRUKTUR = Object.freeze({
  zeilen_einfuegen: Object.freeze({ achse: 'zeilen', art: 'einfuegen' }), zeilen_loeschen: Object.freeze({ achse: 'zeilen', art: 'loeschen' }),
  spalten_einfuegen: Object.freeze({ achse: 'spalten', art: 'einfuegen' }), spalten_loeschen: Object.freeze({ achse: 'spalten', art: 'loeschen' }),
});
/** Standardwerte der Formatfelder: werden nie gespeichert. */
const STANDARD_F = Object.freeze({ fett: false, kursiv: false, zahl: 'standard' });
const AUSRICHTUNGEN = Object.freeze(['links', 'mitte', 'rechts']);
const ZAHLFORMATE = Object.freeze(['standard', 'zahl2', 'euro', 'prozent', 'datum', 'text']);
const HEX = /^#[0-9a-f]{6}$/;
const POS = /^[0-9a-z]{1,64}$/;
const ZEILE = /^[1-9]\d{0,14}$/;
const NAME_VERBOTEN = /[:\\/?*[\]]/;
const BREITE = Object.freeze({ min: 20, max: 1000 });
const HOEHE = Object.freeze({ min: 12, max: 400 });
/** Zellschlüssel dürfen nach dem Einfügen jenseits von GRENZEN liegen (GRENZEN gilt nie fürs Verschieben). */
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });
/** Kennung des Standardblatts: erstes Blatt einer neuen Mappe und Ersatz, wenn das letzte Blatt gelöscht wird. */
const STANDARD_ID = 'blatt1';
/** Größer (JSON in Byte) geht eine Op nicht hinaus – der Web-Dienst nimmt Nachrichten bis 8 MiB an. */
export const OP_MAX = 7_340_032;
/** Stücke der Umkehrung und zusammengesetzte Ops höchstens so viele JSON-Zeichen: auch mit 3 Byte je Zeichen unter OP_MAX. */
const STUECK_ZEICHEN = 2_000_000;

/** Op-JSON über OP_MAX Byte? (erst ab einem Drittel der Grenze in Zeichen wird genau gezählt) */
export function zuGross(op) {
  let json;
  try { json = JSON.stringify(op); } catch { return true; }
  if (json.length > OP_MAX) return true;
  if (json.length * 3 <= OP_MAX) return false;
  return new TextEncoder().encode(json).length > OP_MAX;
}

const vergleich = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const istObjekt = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const eigen = (o, k) => (istObjekt(o) && Object.hasOwn(o, k) ? o[k] : undefined);

/** Blätter nach (pos, id) sortiert. */
function sortiert(blaetter) {
  return [...blaetter].sort((a, b) => vergleich(a.pos, b.pos) || vergleich(a.id, b.id));
}

function standardBlatt() {
  return { id: STANDARD_ID, name: 'Tabelle1', pos: 'i', zellen: {}, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } };
}

function leer() { return { blaetter: [standardBlatt()] }; }

/** Blatt mit dieser Kennung oder null. */
export function blattVon(daten, id) {
  return (daten && Array.isArray(daten.blaetter) && daten.blaetter.find((b) => b.id === id)) || null;
}

/** Blatt über eine Änderungsfunktion ersetzen; fehlt es oder bleibt es gleich, kommen die Daten unverändert zurück. */
function mitBlatt(daten, id, fn) {
  const i = daten.blaetter.findIndex((b) => b.id === id);
  if (i < 0) return daten;
  const neu = fn(daten.blaetter[i]);
  if (neu === daten.blaetter[i]) return daten;
  const blaetter = [...daten.blaetter];
  blaetter[i] = neu;
  return { ...daten, blaetter };
}

// ---- Zellen ----------------------------------------------------------------------------------------------------

/** Felder einer Zell-Op als Eintrag {w?, f?}. */
const eintragVon = (op) => ({ ...(op.w !== undefined ? { w: op.w } : {}), ...(op.f !== undefined ? { f: op.f } : {}) });

function gleichesF(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Eintrag {w?, f?} auf eine Zelle anwenden: w null oder '' entfernt den Wert, ein f-Feld mit null oder Standardwert
 * fällt weg, ein leeres f ebenso. Ergebnis undefined = leere Zelle; unverändert → dieselbe Zelle.
 */
function zelleMit(alt, eintrag) {
  let w = alt ? alt.w : undefined;
  let f = alt ? alt.f : undefined;
  if (eintrag.w !== undefined) w = eintrag.w === null || eintrag.w === '' ? undefined : eintrag.w;
  if (istObjekt(eintrag.f)) {
    const neu = { ...(f || {}) };
    for (const k of F_FELDER) {
      if (!Object.hasOwn(eintrag.f, k)) continue;
      const v = eintrag.f[k];
      if (v === null || v === undefined || v === STANDARD_F[k]) delete neu[k]; else neu[k] = v;
    }
    f = Object.keys(neu).length ? neu : undefined;
  }
  if (w === undefined && f === undefined) return undefined;
  if (alt && alt.w === w && gleichesF(alt.f, f)) return alt;
  return { ...(w !== undefined ? { w } : {}), ...(f !== undefined ? { f } : {}) };
}

/** Einträge {Adresse: {w?, f?}} auf ein Blatt anwenden (zelle, zellen, sortieren). */
function zellenAnwenden(blatt, werte) {
  let zellen = null;
  for (const [adr, eintrag] of Object.entries(istObjekt(werte) ? werte : {})) {
    if (!istObjekt(eintrag) || !adresseLesen(adr, OHNE_GRENZEN)) continue;
    const alt = eigen(blatt.zellen, adr);
    const neu = zelleMit(alt, eintrag);
    if (neu === alt) continue;
    if (!zellen) zellen = { ...blatt.zellen };
    if (neu === undefined) delete zellen[adr]; else zellen[adr] = neu;
  }
  return zellen ? { ...blatt, zellen } : blatt;
}

// ---- Struktur --------------------------------------------------------------------------------------------------

/** Index einer Zelladresse auf der Achse; null bei unlesbarem Schlüssel. */
function achsenIndex(adr, achse) {
  const a = adresseLesen(adr, OHNE_GRENZEN);
  return a ? { a, i: achse === 'zeilen' ? a.z : a.s } : null;
}

/** Zellen und Metadaten (Zeilenhöhen bzw. Spaltenbreiten) des betroffenen Blatts neu verschlüsseln; Gelöschtes fällt weg. */
function blattUmschluesseln(blatt, achse, schritt) {
  const zellen = {};
  for (const [adr, z] of Object.entries(blatt.zellen || {})) {
    const x = achsenIndex(adr, achse);
    if (!x) { zellen[adr] = z; continue; } // unlesbarer Schlüssel (kommt nach datenPruefen nicht vor) bleibt stehen
    const i = indexVerschieben(x.i, schritt);
    if (i !== null) zellen[achse === 'zeilen' ? adresse(i, x.a.s) : adresse(x.a.z, i)] = z;
  }
  const feld = achse === 'zeilen' ? 'zeilen' : 'spalten';
  const meta = {};
  for (const [k, v] of Object.entries(blatt[feld] || {})) {
    const n = achse === 'zeilen' ? (ZEILE.test(k) ? Number(k) : 0) : textZuSpalte(k);
    if (!n) { meta[k] = v; continue; }
    const i = indexVerschieben(n, schritt);
    if (i !== null) meta[achse === 'zeilen' ? String(i) : spalteZuText(i)] = v;
  }
  return { ...blatt, zellen, [feld]: meta };
}

/** Formeln eines Blatts nach einer Struktur-Op anpassen; ohne Änderung kommt dasselbe Objekt zurück. */
function formelnVerschieben(zellen, p) {
  const vorsilbe = `[${p.blatt}]!`;
  let neu = null;
  for (const [adr, z] of Object.entries(zellen || {})) {
    if (typeof z?.w !== 'string' || z.w[0] !== '=') continue;
    if (p.eigenesBlatt !== p.blatt && !z.w.includes(vorsilbe)) continue; // fremdes Blatt ohne Bezug auf das geänderte
    const w = '=' + strukturVerschieben(z.w.slice(1), p);
    if (w === z.w) continue;
    if (!neu) neu = { ...zellen };
    neu[adr] = { ...z, w };
  }
  return neu || zellen;
}

/** Zeilen/Spalten einfügen oder löschen: Zellen und Metadaten des Blatts verschieben, Formeln aller Blätter anpassen. */
function strukturAnwenden(daten, op) {
  if (!blattVon(daten, op.blatt) || !Number.isInteger(op.ab) || !Number.isInteger(op.anzahl)) return daten;
  const { achse, art } = STRUKTUR[op.typ];
  const schritt = { art, ab: op.ab, anzahl: op.anzahl };
  let geaendert = false;
  const blaetter = daten.blaetter.map((b) => {
    let neu = b.id === op.blatt ? blattUmschluesseln(b, achse, schritt) : b;
    const zellen = formelnVerschieben(neu.zellen, { eigenesBlatt: b.id, blatt: op.blatt, achse, ...schritt });
    if (zellen !== neu.zellen) neu = { ...neu, zellen };
    if (neu !== b) geaendert = true;
    return neu;
  });
  return geaendert ? { ...daten, blaetter } : daten;
}

// ---- Blätter ---------------------------------------------------------------------------------------------------

const leeresObjekt = (o) => o === undefined || (istObjekt(o) && !Object.keys(o).length);

/** Nutzlast eines neuen Blatts, die genau dem leeren Standardblatt entspricht. */
function istStandardBlatt(b) {
  const std = standardBlatt();
  return istObjekt(b) && b.id === std.id && b.name === std.name && b.pos === std.pos && leeresObjekt(b.zellen) && leeresObjekt(b.spalten)
    && leeresObjekt(b.zeilen) && (b.fixiert === undefined || eigen(b.fixiert, 'zeilen') === 0);
}

/** Bezüge auf ein Blatt auf eine neue Kennung umschreiben (Formel mit „=“). */
function bezuegeUmbenennen(w, alt, neu) {
  if (typeof w !== 'string' || w[0] !== '=' || !w.includes(`[${alt}]!`)) return w;
  const tokens = zerlegen(w.slice(1), 'intern');
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.art === 'bezug' && t.blatt === alt) tokens[k] = { ...t, blatt: neu, text: `[${neu}]!` + t.text.slice(alt.length + 3) };
  }
  return '=' + tokensText(tokens);
}

/** Formel ohne Bezüge auf ein gelöschtes Blatt: jeder Bezug darauf wird #REF! (Anzeige #BEZUG!). */
function bezuegeAufBlattWeg(w, id) {
  if (typeof w !== 'string' || w[0] !== '=' || !w.includes(`[${id}]!`)) return w;
  const tokens = zerlegen(w.slice(1), 'intern');
  let geaendert = false;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].art === 'bezug' && tokens[k].blatt === id) { tokens[k] = { art: 'fehler', text: '#REF!', wert: '#REF!' }; geaendert = true; }
  }
  return geaendert ? '=' + tokensText(tokens) : w;
}

/** Zellen (gespeichert oder Einträge einer Op) ohne Bezüge auf ein gelöschtes Blatt; ohne Änderung dasselbe Objekt. */
function zellenOhneBlatt(zellen, id) {
  let neu = null;
  for (const [adr, z] of Object.entries(istObjekt(zellen) ? zellen : {})) {
    if (!istObjekt(z)) continue;
    const w = bezuegeAufBlattWeg(z.w, id);
    if (w === z.w) continue;
    if (!neu) neu = { ...zellen };
    neu[adr] = { ...z, w };
  }
  return neu || zellen;
}

/**
 * Blatt löschen. Bezüge anderer Blätter darauf werden #REF! – sonst verschöbe eine gleichzeitige Struktur-Op auf dem
 * Blatt sie nur in einer der beiden Reihenfolgen. Ob danach das Standardblatt nötig ist, entscheidet `rest` (die übrigen
 * Blätter, die der Auslöser kannte; transformiere hält die Liste aktuell): leer → Standardblatt. Nur so ergibt Löschen
 * des letzten Blatts neben einem gleichzeitig angelegten in beiden Reihenfolgen dasselbe. Ohne `rest` (alte Ops, Tests)
 * zählt, ob noch ein Blatt übrig ist.
 */
function blattLoeschen(daten, op) {
  if (!blattVon(daten, op.blatt)) return daten;
  const blaetter = daten.blaetter.filter((b) => b.id !== op.blatt).map((b) => {
    const zellen = zellenOhneBlatt(b.zellen, op.blatt);
    return zellen === b.zellen ? b : { ...b, zellen };
  });
  const standard = !blaetter.length || (Array.isArray(op.rest) && !op.rest.length);
  if (standard && !blaetter.some((b) => b.id === STANDARD_ID)) blaetter.push(standardBlatt());
  return { ...daten, blaetter: sortiert(blaetter) };
}

/** Blatt aus der Nutzlast von blatt_neu: Standardfelder ergänzt, Zellen in gespeicherter Form. */
function blattAusNutzlast(b) {
  const blatt = { ...standardBlatt(), id: b.id, name: b.name, pos: b.pos };
  blatt.zellen = zellenAnwenden({ zellen: {} }, b.zellen).zellen;
  for (const feld of ['spalten', 'zeilen']) {
    for (const [k, v] of Object.entries(istObjekt(b[feld]) ? b[feld] : {})) if (istObjekt(v)) blatt[feld][k] = { ...v };
  }
  blatt.fixiert = { zeilen: eigen(b.fixiert, 'zeilen') === 1 ? 1 : 0 };
  return blatt;
}

function anwenden(daten, op) {
  if (!istObjekt(op) || op.typ === 'noop') return daten;
  switch (op.typ) {
    case 'zelle':
      return typeof op.zelle === 'string' ? mitBlatt(daten, op.blatt, (b) => zellenAnwenden(b, { [op.zelle]: eintragVon(op) })) : daten;
    case 'zellen':
      return mitBlatt(daten, op.blatt, (b) => zellenAnwenden(b, op.werte));
    case 'sortieren':
      return mitBlatt(daten, op.blatt, (b) => zellenAnwenden(b, op.zellen));
    case 'zeilen_einfuegen': case 'zeilen_loeschen': case 'spalten_einfuegen': case 'spalten_loeschen':
      return strukturAnwenden(daten, op);
    case 'blatt_neu':
      if (!istObjekt(op.blatt) || blattVon(daten, op.blatt.id)) return daten;
      return { ...daten, blaetter: sortiert([...daten.blaetter, blattAusNutzlast(op.blatt)]) };
    case 'blatt_loeschen':
      return blattLoeschen(daten, op);
    case 'blatt_umbenennen':
      return mitBlatt(daten, op.blatt, (b) => (b.name === op.name ? b : { ...b, name: op.name }));
    case 'blatt_verschieben': {
      const neu = mitBlatt(daten, op.blatt, (b) => (b.pos === op.pos ? b : { ...b, pos: op.pos }));
      return neu === daten ? daten : { ...neu, blaetter: sortiert(neu.blaetter) };
    }
    case 'spalte_breite':
      return mitBlatt(daten, op.blatt, (b) => {
        const k = spalteZuText(op.spalte);
        if (op.breite === null) {
          if (!eigen(b.spalten, k)) return b;
          const spalten = { ...b.spalten }; delete spalten[k];
          return { ...b, spalten };
        }
        return eigen(b.spalten, k)?.breite === op.breite ? b : { ...b, spalten: { ...b.spalten, [k]: { breite: op.breite } } };
      });
    case 'fixieren':
      return mitBlatt(daten, op.blatt, (b) => (eigen(b.fixiert, 'zeilen') === op.zeilen ? b : { ...b, fixiert: { zeilen: op.zeilen } }));
    default:
      return daten;
  }
}

// ---- Transformation --------------------------------------------------------------------------------------------
// transformiere(op, gegen, seite) nach V12: 'rechts' = op kam später an, 'links' = gegen kam später an und gewinnt
// Feldkonflikte; op gewinnt Gleichstände der Position.

const noop = () => ({ typ: 'noop' });
const ZELL_OPS = new Set(['zelle', 'zellen', 'sortieren']);
const BLATT_FELD_OPS = new Set(['blatt_umbenennen', 'blatt_verschieben', 'fixieren']);
const istStruktur = (op) => Object.hasOwn(STRUKTUR, op.typ);
const ueberlappung = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1) + 1);

/** Einträge {Adresse: {w?, f?}} einer Zell-Op. */
function eintraegeVon(op) {
  if (op.typ === 'zelle') return { [op.zelle]: eintragVon(op) };
  const eintraege = op.typ === 'zellen' ? op.werte : op.zellen;
  return istObjekt(eintraege) ? eintraege : {};
}

/** Zell-Op mit neuen Einträgen; zelle bleibt zelle, nichts übrig → noop. */
function mitEintraegen(op, eintraege) {
  const adressen = Object.keys(eintraege);
  if (!adressen.length) return noop();
  if (op.typ === 'zelle') return { typ: 'zelle', blatt: op.blatt, zelle: adressen[0], ...eintraege[adressen[0]] };
  if (op.typ === 'zellen') return { typ: 'zellen', blatt: op.blatt, werte: eintraege };
  return { ...op, zellen: eintraege };
}

/** Formel eines Eintrags nach einer Struktur-Op anpassen. */
function eintragVerschieben(e, p) {
  if (typeof e.w !== 'string' || e.w[0] !== '=') return e;
  const w = '=' + strukturVerschieben(e.w.slice(1), p);
  return w === e.w ? e : { ...e, w };
}

/** Regel 3: Zell-Op gegen Struktur-Op – Adressen auf dem Blatt wandern (gelöscht → Eintrag weg), Formeln überall. */
function zellOpGegenStruktur(op, gegen) {
  const { achse, art } = STRUKTUR[gegen.typ];
  const schritt = { art, ab: gegen.ab, anzahl: gegen.anzahl };
  const p = { eigenesBlatt: op.blatt, blatt: gegen.blatt, achse, ...schritt };
  const gleich = op.blatt === gegen.blatt;
  const neu = {};
  for (const [adr, e] of Object.entries(eintraegeVon(op))) {
    let ziel = adr;
    const x = gleich ? achsenIndex(adr, achse) : null;
    if (x) {
      const i = indexVerschieben(x.i, schritt);
      if (i === null) continue;
      ziel = achse === 'zeilen' ? adresse(i, x.a.s) : adresse(x.a.z, i);
    }
    neu[ziel] = istObjekt(e) ? eintragVerschieben(e, p) : e;
  }
  const aus = mitEintraegen(op, neu);
  if (aus.typ !== 'sortieren' || !gleich) return aus;
  // sortieren: Bereich und Schlüsselspalte sind reine Angaben – die Wirkung tragen allein die Einträge
  const b = bereichLesen(op.bereich, OHNE_GRENZEN);
  if (!b) return aus;
  const [von, bis] = achse === 'zeilen' ? [b.z1, b.z2] : [b.s1, b.s2];
  const r = spanneVerschieben(von, bis, schritt);
  if (r === null) return noop();
  const nb = achse === 'zeilen' ? { ...b, z1: r[0], z2: r[1] } : { ...b, s1: r[0], s2: r[1] };
  const spalte = achse === 'spalten' ? (indexVerschieben(op.spalte, schritt) ?? nb.s1) : op.spalte;
  return { ...aus, bereich: bereichText(nb), spalte };
}

/**
 * Regel 4: Struktur gegen Struktur auf demselben Blatt und derselben Achse. Gleichzeitiges Einfügen im gelöschten
 * Bereich oder direkt an seinem Rand (erste gelöschte Zeile bis Zeile danach) verliert gegen das Löschen: die neuen
 * Zeilen gehen mit. Nur so verschieben beide Reihenfolgen die Bezüge gleich – sonst landete ein Bereich, dessen Ende
 * (oder Anfang) im gelöschten Teil lag, je nach Reihenfolge mit oder ohne die neuen Zeilen.
 */
function strukturGegenStruktur(op, gegen, seite) {
  if (op.blatt !== gegen.blatt || STRUKTUR[op.typ].achse !== STRUKTUR[gegen.typ].achse) return op;
  const opArt = STRUKTUR[op.typ].art;
  const s = gegen.ab, e = gegen.ab + gegen.anzahl - 1, m = gegen.anzahl;
  if (opArt === 'einfuegen' && STRUKTUR[gegen.typ].art === 'einfuegen') {
    if (op.ab < s || (op.ab === s && seite === 'links')) return op;
    return { ...op, ab: op.ab + m };
  }
  if (opArt === 'einfuegen') { // gegen löscht
    if (op.ab < s) return op;
    if (op.ab > e + 1) return { ...op, ab: op.ab - m };
    return noop(); // im gelöschten Bereich oder an seinem Rand: Löschen gewinnt
  }
  const oe = op.ab + op.anzahl - 1;
  if (STRUKTUR[gegen.typ].art === 'einfuegen') { // op löscht, gegen fügt ein
    if (s < op.ab) return { ...op, ab: op.ab + m };
    if (s > oe + 1) return op;
    return { ...op, anzahl: op.anzahl + m }; // die eingefügten Zeilen gehen mit
  }
  const anzahl = op.anzahl - ueberlappung(op.ab, oe, s, e);
  if (anzahl <= 0) return noop();
  return { ...op, ab: op.ab - ueberlappung(s, e, 1, op.ab - 1), anzahl };
}

/** Regel 6: Zell-Op gegen Zell-Op auf demselben Blatt – 'links': die Felder, die gegen setzt, fallen weg. */
function zellOpGegenZellOp(op, gegen, seite) {
  if (seite === 'rechts' || op.blatt !== gegen.blatt) return op;
  const g = eintraegeVon(gegen);
  const neu = {};
  for (const [adr, e] of Object.entries(eintraegeVon(op))) {
    const ge = eigen(g, adr);
    if (!istObjekt(ge) || !istObjekt(e)) { neu[adr] = e; continue; }
    const r = {};
    if (e.w !== undefined && ge.w === undefined) r.w = e.w;
    if (istObjekt(e.f)) {
      const f = {};
      for (const [k, v] of Object.entries(e.f)) if (!(istObjekt(ge.f) && Object.hasOwn(ge.f, k))) f[k] = v;
      if (Object.keys(f).length) r.f = f;
    }
    if (Object.keys(r).length) neu[adr] = r;
  }
  return mitEintraegen(op, neu);
}

/**
 * Neues Blatt gegen Struktur-Op: seine Formeln wandern wie die gespeicherten (anwenden passt später alle Blätter an,
 * also muss es die Nutzlast hier genauso); trägt es die Kennung des geänderten Blatts (Rückgängig), wandern auch Zellen
 * und Metadaten.
 */
function blattNeuGegenStruktur(op, gegen) {
  const { achse, art } = STRUKTUR[gegen.typ];
  const schritt = { art, ab: gegen.ab, anzahl: gegen.anzahl };
  let b = op.blatt;
  if (b.id === gegen.blatt) {
    const feld = achse === 'zeilen' ? 'zeilen' : 'spalten';
    b = blattUmschluesseln({ ...b, zellen: istObjekt(b.zellen) ? b.zellen : {}, [feld]: istObjekt(b[feld]) ? b[feld] : {} }, achse, schritt);
  }
  const zellen = formelnVerschieben(b.zellen, { eigenesBlatt: b.id, blatt: gegen.blatt, achse, ...schritt });
  if (zellen !== b.zellen) b = { ...b, zellen };
  return b === op.blatt ? op : { ...op, blatt: b };
}

/**
 * Regel 2: gegen löscht ein Blatt. Ops auf dieses Blatt werden Noops, auch ein neues Blatt mit dieser Kennung; Formeln
 * anderer Zell-Ops und neuer Blätter verlieren ihre Bezüge darauf (#REF!) wie die gespeicherten. Zwei Löschungen
 * verschiedener Blätter führen ihre `rest`-Listen zusammen (die übrigen Blätter, die einer der beiden Auslöser kannte);
 * eine, die schon das letzte Blatt löschte, bleibt dabei – außer gegen löscht das Standardblatt selbst, das sie angelegt
 * hätte. Dasselbe Blatt zweimal: die spätere bewirkt nichts mehr, außer dem Standardblatt, falls nur sie es anlegte.
 */
function gegenBlattLoeschen(op, gegen) {
  if (op.typ === 'blatt_loeschen') {
    const letztes = Array.isArray(op.rest) && !op.rest.length;
    if (op.blatt === gegen.blatt) return letztes ? { typ: 'blatt_neu', blatt: standardBlatt() } : noop();
    if (!Array.isArray(op.rest) || (letztes && gegen.blatt !== STANDARD_ID)) return op;
    const rest = new Set(op.rest.filter((id) => id !== gegen.blatt));
    if (Array.isArray(gegen.rest)) for (const id of gegen.rest) if (id !== op.blatt) rest.add(id);
    return { ...op, rest: [...rest].sort() };
  }
  if (op.blatt === gegen.blatt) return noop();
  if (ZELL_OPS.has(op.typ)) {
    const e = eintraegeVon(op);
    const neu = zellenOhneBlatt(e, gegen.blatt);
    return neu === e ? op : mitEintraegen(op, neu);
  }
  if (op.typ === 'blatt_neu' && istObjekt(op.blatt)) {
    // Gleiche Kennung (das Standardblatt „blatt1“ oder ein per Rückgängig zurückgeholtes Blatt): Löschen gewinnt auch hier
    if (op.blatt.id === gegen.blatt) return noop();
    const zellen = zellenOhneBlatt(op.blatt.zellen, gegen.blatt);
    return zellen === op.blatt.zellen ? op : { ...op, blatt: { ...op.blatt, zellen } };
  }
  return op;
}

function transformiere(op, gegen, seite) {
  if (!istObjekt(op) || !istObjekt(gegen) || op.typ === 'noop' || gegen.typ === 'noop') return op;
  if (gegen.typ === 'blatt_loeschen') return gegenBlattLoeschen(op, gegen);
  if (op.typ === 'blatt_neu') return istStruktur(gegen) && istObjekt(op.blatt) ? blattNeuGegenStruktur(op, gegen) : op;
  if (ZELL_OPS.has(op.typ)) {
    if (istStruktur(gegen)) return zellOpGegenStruktur(op, gegen);
    if (ZELL_OPS.has(gegen.typ)) return zellOpGegenZellOp(op, gegen, seite);
    return op;
  }
  if (istStruktur(op)) return istStruktur(gegen) ? strukturGegenStruktur(op, gegen, seite) : op;
  if (op.typ === 'spalte_breite') {
    if (gegen.blatt !== op.blatt) return op;
    if (istStruktur(gegen) && STRUKTUR[gegen.typ].achse === 'spalten') {
      const spalte = indexVerschieben(op.spalte, { art: STRUKTUR[gegen.typ].art, ab: gegen.ab, anzahl: gegen.anzahl });
      return spalte === null ? noop() : spalte === op.spalte ? op : { ...op, spalte };
    }
    return gegen.typ === 'spalte_breite' && gegen.spalte === op.spalte && seite === 'links' ? noop() : op;
  }
  if (BLATT_FELD_OPS.has(op.typ)) return gegen.typ === op.typ && gegen.blatt === op.blatt && seite === 'links' ? noop() : op;
  return op;
}

/**
 * Nähme das Löschen `op` (aus dem Rückgängig-Verlauf) mit, was die fremde Op `gegen` (auf denselben Stand) geschrieben oder
 * eingefügt hat? Zeilen/Spalten löschen: ein Eintrag von `gegen` in den gelöschten Zeilen bzw. Spalten, ein fremdes Einfügen
 * darin oder direkt dahinter (es ginge nach Regel 4 mit), eine fremde Breite einer gelöschten Spalte. Blatt löschen: jede
 * fremde Op auf diesem Blatt außer dessen Löschen.
 */
export function loeschtFremdes(op, gegen) {
  if (!istObjekt(op) || !istObjekt(gegen) || gegen.typ === 'noop') return false;
  if (op.typ === 'blatt_loeschen') return gegen.typ !== 'blatt_loeschen' && gegen.blatt === op.blatt;
  if (!istStruktur(op) || STRUKTUR[op.typ].art !== 'loeschen' || gegen.blatt !== op.blatt) return false;
  const { achse } = STRUKTUR[op.typ];
  const von = op.ab, bis = op.ab + op.anzahl - 1;
  if (ZELL_OPS.has(gegen.typ)) {
    return Object.keys(eintraegeVon(gegen)).some((adr) => { const x = achsenIndex(adr, achse); return x !== null && x.i >= von && x.i <= bis; });
  }
  if (istStruktur(gegen)) return STRUKTUR[gegen.typ].achse === achse && STRUKTUR[gegen.typ].art === 'einfuegen' && gegen.ab >= von && gegen.ab <= bis + 1;
  if (gegen.typ === 'spalte_breite') return achse === 'spalten' && gegen.spalte >= von && gegen.spalte <= bis;
  return false;
}

/**
 * Ungefährer Aufwand, `op` gegen die Ops `gegen` (seit ihrer Basis) zu transformieren – für die Grenze im Web-Dienst: je Op 1,
 * dazu je Struktur-Op oder gelöschtem Blatt die Einträge der Zell-Op bzw. die Zellen eines neuen Blatts (jede Formel darin
 * wird umgeschrieben).
 */
function aufwand(op, gegen) {
  let teuer = 0;
  for (const g of gegen) if (istObjekt(g) && (istStruktur(g) || g.typ === 'blatt_loeschen')) teuer++;
  if (!teuer || !istObjekt(op)) return gegen.length;
  const n = ZELL_OPS.has(op.typ) ? Object.keys(eintraegeVon(op)).length
    : op.typ === 'blatt_neu' && istObjekt(op.blatt) && istObjekt(op.blatt.zellen) ? Object.keys(op.blatt.zellen).length : 1;
  return gegen.length + teuer * n;
}

/** Zwei aufeinanderfolgende eigene Ops zu einer zusammenfassen, sonst null. */
function zusammensetzen(a, b) {
  if (!istObjekt(a) || !istObjekt(b)) return null;
  const zelle = (op) => op.typ === 'zelle' || op.typ === 'zellen';
  if (zelle(a) && zelle(b)) {
    if (a.blatt !== b.blatt) return null;
    const werte = {};
    for (const [adr, e] of Object.entries(eintraegeVon(a))) werte[adr] = { ...e, ...(e.f ? { f: { ...e.f } } : {}) };
    for (const [adr, e] of Object.entries(eintraegeVon(b))) {
      const alt = werte[adr] || {};
      const neu = { ...alt };
      if (e.w !== undefined) neu.w = e.w;
      if (istObjekt(e.f)) neu.f = { ...(alt.f || {}), ...e.f };
      werte[adr] = neu;
    }
    if (Object.keys(werte).length > GRENZEN.zellen_op) return null;
    const op = { typ: 'zellen', blatt: a.blatt, werte };
    return JSON.stringify(op).length > STUECK_ZEICHEN ? null : op; // zusammen nicht größer als ein Stück der Umkehrung
  }
  if (a.typ !== b.typ || a.blatt !== b.blatt) return null;
  if (a.typ === 'spalte_breite') return a.spalte === b.spalte ? b : null;
  return BLATT_FELD_OPS.has(a.typ) ? b : null;
}

function istNoop(op) {
  if (!istObjekt(op) || op.typ === 'noop') return true;
  if (op.typ === 'zellen') return !istObjekt(op.werte) || !Object.keys(op.werte).length;
  if (op.typ === 'sortieren') return !istObjekt(op.zellen) || !Object.keys(op.zellen).length;
  return false;
}

/**
 * Auswahl {blatt, von, bis} nach einer Op: Struktur-Ops auf dem Blatt verschieben beide Ecken (eine gelöschte Ecke
 * landet am Anfang des gelöschten Bereichs), gelöschtes Blatt → null. Eigene und fremde Ops wirken gleich.
 */
function auswahlTransformieren(auswahl, op) {
  if (!auswahl || !istObjekt(op)) return auswahl ?? null;
  if (op.typ === 'blatt_loeschen') return op.blatt === auswahl.blatt ? null : auswahl;
  if (!istStruktur(op) || op.blatt !== auswahl.blatt) return auswahl;
  const von = adresseLesen(auswahl.von, OHNE_GRENZEN), bis = adresseLesen(auswahl.bis, OHNE_GRENZEN);
  if (!von || !bis) return auswahl;
  const { achse, art } = STRUKTUR[op.typ];
  const feld = achse === 'zeilen' ? 'z' : 's';
  const max = achse === 'zeilen' ? GRENZEN.zeilen : GRENZEN.spalten;
  const schritt = { art, ab: op.ab, anzahl: op.anzahl };
  const neu = (i) => Math.min(indexVerschieben(i, schritt) ?? op.ab, max);
  const a = neu(von[feld]), b = neu(bis[feld]);
  const ecke = (alt, i) => ({ ...alt, [feld]: i });
  const v = ecke(von, Math.min(a, b)), w = ecke(bis, Math.max(a, b));
  return { ...auswahl, von: adresse(v.z, v.s), bis: adresse(w.z, w.s) };
}

// ---- Prüfung ---------------------------------------------------------------------------------------------------

const fehler = (meldung, feld) => new SyncFehler('E_PARAMS', meldung, feld ? { feld } : undefined);

/** Objekt mit genau erlaubten Schlüsseln. */
function felder(o, erlaubt, feld) {
  if (!istObjekt(o)) throw fehler('Ungültige Angabe', feld);
  for (const k of Object.keys(o)) if (!erlaubt.includes(k)) throw fehler(`Unbekanntes Feld „${String(k).slice(0, 40)}“`, feld ? `${feld}.${k}` : k);
}
function idPruefen(v, feld) { if (typeof v !== 'string' || !ID_MUSTER.test(v)) throw fehler(`„${feld}“ ist keine gültige Kennung`, feld); }
function ganzzahl(v, min, max, feld) { if (!Number.isInteger(v) || v < min || v > max) throw fehler(`„${feld}“: ganze Zahl ${min}–${max}`, feld); }
function adressePruefen(adr, feld) { if (!adresseLesen(adr)) throw fehler(`„${String(adr).slice(0, 20)}“ ist keine gültige Zelle`, feld); }

/** Wert w: Text (Formel höchstens GRENZEN.formel, sonst GRENZEN.w Zeichen); null nur in Ops. */
function wPruefen(w, feld, { mitNull = true } = {}) {
  if (w === null && mitNull) return;
  if (typeof w !== 'string') throw fehler(`„${feld}“ muss Text sein`, feld);
  const max = w[0] === '=' ? GRENZEN.formel : GRENZEN.w;
  if (w.length > max) throw fehler(`„${feld}“: höchstens ${max} Zeichen`, feld);
  if (!mitNull && w === '') throw fehler(`„${feld}“ ist leer`, feld);
}

/** Format f: nur bekannte Felder mit erlaubten Werten; gespeichert (mitNull = false) ohne null und ohne Standardwerte. */
function fPruefen(f, feld, { mitNull = true } = {}) {
  felder(f, F_FELDER, feld);
  if (!Object.keys(f).length) throw fehler('Kein Format angegeben', feld);
  for (const [k, v] of Object.entries(f)) {
    if (v === null && mitNull) continue;
    if (!mitNull && (v === null || v === STANDARD_F[k])) throw fehler(`„${k}“ wird nicht gespeichert`, `${feld}.${k}`);
    const ok = k === 'fett' || k === 'kursiv' ? typeof v === 'boolean'
      : k === 'farbe' || k === 'hinter' ? typeof v === 'string' && HEX.test(v)
        : k === 'ausr' ? AUSRICHTUNGEN.includes(v) : ZAHLFORMATE.includes(v);
    if (!ok) throw fehler(`„${k}“ hat keinen erlaubten Wert`, `${feld}.${k}`);
  }
}

/** Eintrag einer Zell-Op {w?, f?} bzw. (gespeichert) eine Zelle. */
function eintragPruefen(e, feld, { gespeichert = false } = {}) {
  felder(e, ['w', 'f'], feld);
  if (e.w === undefined && e.f === undefined) throw fehler('Nichts zu ändern', feld);
  if (e.w !== undefined) wPruefen(e.w, `${feld}.w`, { mitNull: !gespeichert });
  if (e.f !== undefined) fPruefen(e.f, `${feld}.f`, { mitNull: !gespeichert });
}

function namePruefen(name, feld) {
  if (typeof name !== 'string' || name.length < 1 || name.length > GRENZEN.name || NAME_VERBOTEN.test(name) || name[0] === "'" || name[name.length - 1] === "'") {
    throw fehler(`Blattname: 1–${GRENZEN.name} Zeichen, ohne : \\ / ? * [ ], nicht mit ' am Anfang oder Ende`, feld);
  }
}

/** Ein Blatt (gespeichert oder als Nutzlast von blatt_neu, dort sind zellen/spalten/zeilen/fixiert freiwillig) → Zellenzahl. */
function blattPruefen(b, { nutzlast = false } = {}) {
  felder(b, ['id', 'name', 'pos', 'zellen', 'spalten', 'zeilen', 'fixiert'], 'blatt');
  idPruefen(b.id, 'blatt.id'); namePruefen(b.name, 'blatt.name');
  if (typeof b.pos !== 'string' || !POS.test(b.pos)) throw fehler('„blatt.pos“ ist ungültig', 'blatt.pos');
  for (const k of ['zellen', 'spalten', 'zeilen', 'fixiert']) {
    if (b[k] === undefined) { if (nutzlast) continue; throw fehler(`„blatt.${k}“ fehlt`, `blatt.${k}`); }
    if (!istObjekt(b[k])) throw fehler(`„blatt.${k}“ ist ungültig`, `blatt.${k}`);
  }
  const zellen = Object.entries(b.zellen || {});
  if (zellen.length > GRENZEN.zellen_mappe) throw fehler(`Höchstens ${GRENZEN.zellen_mappe} Zellen`, 'blatt.zellen');
  for (const [adr, z] of zellen) { adressePruefen(adr, 'blatt.zellen'); eintragPruefen(z, `blatt.zellen.${adr}`, { gespeichert: true }); }
  for (const [k, v] of Object.entries(b.spalten || {})) {
    const n = textZuSpalte(k);
    if (!n || n > GRENZEN.spalten || spalteZuText(n) !== k) throw fehler(`Spalte „${String(k).slice(0, 10)}“ ist ungültig`, 'blatt.spalten');
    felder(v, ['breite'], `blatt.spalten.${k}`); ganzzahl(v.breite, BREITE.min, BREITE.max, `blatt.spalten.${k}.breite`);
  }
  for (const [k, v] of Object.entries(b.zeilen || {})) {
    if (!ZEILE.test(k) || Number(k) > GRENZEN.zeilen) throw fehler(`Zeile „${String(k).slice(0, 10)}“ ist ungültig`, 'blatt.zeilen');
    felder(v, ['hoehe'], `blatt.zeilen.${k}`); ganzzahl(v.hoehe, HOEHE.min, HOEHE.max, `blatt.zeilen.${k}.hoehe`);
  }
  if (b.fixiert !== undefined) { felder(b.fixiert, ['zeilen'], 'blatt.fixiert'); ganzzahl(b.fixiert.zeilen, 0, 1, 'blatt.fixiert.zeilen'); }
  return zellen.length;
}

/** Wirft SyncFehler E_PARAMS, wenn die Op nicht in Form und Grenzen passt (Server und Klient prüfen gleich). */
function pruefen(op) {
  if (!istObjekt(op) || !OP_TYPEN.includes(op.typ)) throw fehler('Unbekannte Änderung', 'typ');
  const nur = (liste) => felder(op, ['typ', ...liste], null);
  switch (op.typ) {
    case 'noop': nur([]); return;
    case 'zelle':
      nur(['blatt', 'zelle', 'w', 'f']); idPruefen(op.blatt, 'blatt'); adressePruefen(op.zelle, 'zelle');
      eintragPruefen(eintragVon(op), 'zelle'); return;
    case 'zellen': {
      nur(['blatt', 'werte']); idPruefen(op.blatt, 'blatt');
      if (!istObjekt(op.werte)) throw fehler('„werte“ fehlt', 'werte');
      const eintraege = Object.entries(op.werte);
      if (eintraege.length < 1 || eintraege.length > GRENZEN.zellen_op) throw fehler(`„werte“: 1–${GRENZEN.zellen_op} Zellen`, 'werte');
      for (const [adr, e] of eintraege) { adressePruefen(adr, 'werte'); eintragPruefen(e, `werte.${adr}`); }
      return;
    }
    case 'zeilen_einfuegen': case 'zeilen_loeschen': case 'spalten_einfuegen': case 'spalten_loeschen': {
      nur(['blatt', 'ab', 'anzahl']); idPruefen(op.blatt, 'blatt');
      const max = STRUKTUR[op.typ].achse === 'zeilen' ? GRENZEN.zeilen : GRENZEN.spalten;
      ganzzahl(op.ab, 1, max, 'ab'); ganzzahl(op.anzahl, 1, max, 'anzahl');
      if (op.ab + op.anzahl - 1 > max) throw fehler(`Höchstens bis ${max}`, 'anzahl');
      return;
    }
    case 'sortieren': {
      nur(['blatt', 'bereich', 'spalte', 'absteigend', 'zellen']); idPruefen(op.blatt, 'blatt');
      const b = bereichLesen(op.bereich);
      if (!b) throw fehler('„bereich“ ist ungültig', 'bereich');
      const groesse = (b.z2 - b.z1 + 1) * (b.s2 - b.s1 + 1);
      if (groesse > GRENZEN.sortieren) throw fehler(`Höchstens ${GRENZEN.sortieren} Zellen sortieren`, 'bereich');
      ganzzahl(op.spalte, b.s1, b.s2, 'spalte');
      if (typeof op.absteigend !== 'boolean') throw fehler('„absteigend“ muss ja/nein sein', 'absteigend');
      if (!istObjekt(op.zellen)) throw fehler('„zellen“ fehlt', 'zellen');
      const eintraege = Object.entries(op.zellen);
      if (eintraege.length < 1 || eintraege.length > groesse) throw fehler('„zellen“ passt nicht zum Bereich', 'zellen');
      for (const [adr, e] of eintraege) {
        const a = adresseLesen(adr);
        if (!a || a.z < b.z1 || a.z > b.z2 || a.s < b.s1 || a.s > b.s2) throw fehler(`„${String(adr).slice(0, 20)}“ liegt nicht im Bereich`, 'zellen');
        eintragPruefen(e, `zellen.${adr}`);
      }
      return;
    }
    case 'blatt_neu':
      nur(['blatt']); blattPruefen(op.blatt, { nutzlast: true });
      // „blatt1“ kommt per blatt_neu nur als leeres Standardblatt – sonst stieße es mit dem Standardblatt zusammen, das
      // gleichzeitiges Löschen des letzten Blatts anlegt (Rückgängig holt ein gelöschtes blatt1 unter neuer Kennung zurück)
      if (op.blatt.id === STANDARD_ID && !istStandardBlatt(op.blatt)) throw fehler('„blatt1“ ist dem leeren Standardblatt vorbehalten', 'blatt.id');
      return;
    case 'blatt_umbenennen': nur(['blatt', 'name']); idPruefen(op.blatt, 'blatt'); namePruefen(op.name, 'name'); return;
    case 'blatt_loeschen': {
      // rest: die übrigen Blätter, die der Auslöser kennt – ohne sie wäre Löschen des letzten Blatts nicht konvergent
      nur(['blatt', 'rest']); idPruefen(op.blatt, 'blatt');
      if (!Array.isArray(op.rest) || op.rest.length > GRENZEN.blaetter) throw fehler(`„rest“: Liste mit höchstens ${GRENZEN.blaetter} Blättern`, 'rest');
      for (const id of op.rest) idPruefen(id, 'rest');
      if (new Set(op.rest).size !== op.rest.length || op.rest.includes(op.blatt)) throw fehler('„rest“ enthält Doppelte oder das gelöschte Blatt', 'rest');
      return;
    }
    case 'blatt_verschieben':
      nur(['blatt', 'pos']); idPruefen(op.blatt, 'blatt');
      if (typeof op.pos !== 'string' || !POS.test(op.pos)) throw fehler('„pos“ ist ungültig', 'pos');
      return;
    case 'spalte_breite':
      nur(['blatt', 'spalte', 'breite']); idPruefen(op.blatt, 'blatt'); ganzzahl(op.spalte, 1, GRENZEN.spalten, 'spalte');
      if (op.breite !== null) ganzzahl(op.breite, BREITE.min, BREITE.max, 'breite');
      return;
    case 'fixieren': nur(['blatt', 'zeilen']); idPruefen(op.blatt, 'blatt'); ganzzahl(op.zeilen, 0, 1, 'zeilen'); return;
    default: throw fehler('Unbekannte Änderung', 'typ');
  }
}

/** Ganze Mappe prüfen (Import, Tests): 1–100 Blätter, eindeutige Kennungen, Zellen in Grenzen. Wirft SyncFehler E_PARAMS. */
export function datenPruefen(daten) {
  felder(daten, ['blaetter'], null);
  if (!Array.isArray(daten.blaetter) || daten.blaetter.length < 1 || daten.blaetter.length > GRENZEN.blaetter) {
    throw fehler(`Eine Mappe hat 1–${GRENZEN.blaetter} Blätter`, 'blaetter');
  }
  const ids = new Set();
  let zellen = 0;
  for (const b of daten.blaetter) {
    zellen += blattPruefen(b);
    if (ids.has(b.id)) throw fehler('Doppelte Blatt-Kennung', 'blaetter');
    ids.add(b.id);
  }
  if (zellen > GRENZEN.zellen_mappe) throw fehler(`Höchstens ${GRENZEN.zellen_mappe} Zellen je Mappe`, 'blaetter');
}

// ---- Umkehrung -------------------------------------------------------------------------------------------------

/** zellen-Ops mit höchstens GRENZEN.zellen_op Einträgen und STUECK_ZEICHEN JSON-Zeichen – jede geht für sich hinaus. */
function zellenOps(blatt, werte) {
  const ops = [];
  let stueck = {}, n = 0, zeichen = 0;
  for (const [adr, e] of Object.entries(werte)) {
    const groesse = adr.length + JSON.stringify(e).length + 4; // "adr": … ,
    if (n && (n >= GRENZEN.zellen_op || zeichen + groesse > STUECK_ZEICHEN)) { ops.push({ typ: 'zellen', blatt, werte: stueck }); stueck = {}; n = 0; zeichen = 0; }
    stueck[adr] = e; n++; zeichen += groesse;
  }
  if (n) ops.push({ typ: 'zellen', blatt, werte: stueck });
  return ops;
}

/** Alte Werte jedes Felds, das die Einträge setzen (null, wo es fehlte). */
function alteWerte(blatt, werte) {
  const aus = {};
  for (const [adr, e] of Object.entries(istObjekt(werte) ? werte : {})) {
    if (!istObjekt(e)) continue;
    const alt = eigen(blatt.zellen, adr);
    const r = {};
    if (e.w !== undefined) r.w = alt?.w ?? null;
    if (istObjekt(e.f)) { const f = {}; for (const k of F_FELDER) if (Object.hasOwn(e.f, k)) f[k] = alt?.f?.[k] ?? null; if (Object.keys(f).length) r.f = f; }
    if (Object.keys(r).length) aus[adr] = r;
  }
  return aus;
}

/** Ganze Zelle als Eintrag, der genau sie wiederherstellt (volles f). */
const volleZelle = (z) => ({ w: z.w ?? null, f: { ...LEER_F, ...(z.f || {}) } });

/** Formeln, die eine Struktur-Op samt Gegen-Op nicht zeichengleich zurückbringt (z. B. #REF! am Excel-Rand). */
function formelnZurueck(soll, ist) {
  const ops = [];
  for (const b of soll.blaetter) {
    const ib = blattVon(ist, b.id);
    const werte = {};
    for (const [adr, z] of Object.entries(b.zellen)) if (z.w !== undefined && eigen(ib?.zellen, adr)?.w !== z.w) werte[adr] = { w: z.w };
    ops.push(...zellenOps(b.id, werte));
  }
  return ops;
}

/** Umkehrung von Zeilen/Spalten löschen: einfügen, gelöschte Zellen voll zurück, geänderte Formeln aller Blätter, Breiten. */
function loeschenUmkehren(daten, neu, op) {
  const { achse } = STRUKTUR[op.typ];
  const schritt = { art: 'loeschen', ab: op.ab, anzahl: op.anzahl };
  const ops = [{ typ: op.typ.replace('loeschen', 'einfuegen'), blatt: op.blatt, ab: op.ab, anzahl: op.anzahl }];
  for (const b of daten.blaetter) {
    const nb = blattVon(neu, b.id);
    const werte = {};
    for (const [adr, z] of Object.entries(b.zellen)) {
      let neuAdr = adr;
      const x = b.id === op.blatt ? achsenIndex(adr, achse) : null;
      if (x) {
        const i = indexVerschieben(x.i, schritt);
        if (i === null) { werte[adr] = volleZelle(z); continue; } // gelöscht: ganz zurück
        neuAdr = achse === 'zeilen' ? adresse(i, x.a.s) : adresse(x.a.z, i);
      }
      if (z.w !== undefined && eigen(nb?.zellen, neuAdr)?.w !== z.w) werte[adr] = { w: z.w }; // Formel geändert
    }
    ops.push(...zellenOps(b.id, werte));
  }
  if (achse === 'spalten') {
    for (const [k, v] of Object.entries(blattVon(daten, op.blatt).spalten)) {
      const n = textZuSpalte(k);
      if (n >= op.ab && n < op.ab + op.anzahl) ops.push({ typ: 'spalte_breite', blatt: op.blatt, spalte: n, breite: v.breite });
    }
  }
  return ops;
}

/**
 * Ein gelöschtes Blatt zurückholen, dazu die Bezüge anderer Blätter darauf (sie wurden #REF!); hatte das Löschen das
 * Standardblatt angelegt, kommt dieses wieder weg. Ein gelöschtes „blatt1“ kommt unter neuer Kennung zurück, alle
 * Bezüge darauf mit ihr – blatt_neu darf blatt1 nur als leeres Standardblatt anlegen (siehe pruefen).
 */
function blattZurueck(daten, neu, op) {
  const alt = blattVon(daten, op.blatt);
  const standardAngelegt = (!blattVon(daten, STANDARD_ID) || alt.id === STANDARD_ID) && Boolean(blattVon(neu, STANDARD_ID));
  const id = alt.id === STANDARD_ID ? neueId() : alt.id;
  const um = (w) => (id === alt.id ? w : bezuegeUmbenennen(w, alt.id, id));
  const zellen = Object.fromEntries(Object.entries(alt.zellen).map(([adr, z]) => [adr, z.w === undefined ? { ...z } : { ...z, w: um(z.w) }]));
  // das Blatt leer anlegen, die Zellen in Stücken danach – ein großes Blatt ginge als eine Op nicht hinaus
  const ops = [{ typ: 'blatt_neu', blatt: { ...structuredClone({ ...alt, zellen: {} }), id } }, ...zellenOps(id, zellen)];
  if (standardAngelegt) ops.push({ typ: 'blatt_loeschen', blatt: STANDARD_ID, rest: [id, ...neu.blaetter.map((b) => b.id).filter((x) => x !== STANDARD_ID)] });
  for (const b of daten.blaetter) {
    if (b.id === alt.id) continue;
    const nb = blattVon(neu, b.id);
    const werte = {};
    for (const [adr, z] of Object.entries(b.zellen)) if (z.w !== undefined && eigen(nb?.zellen, adr)?.w !== z.w) werte[adr] = { w: um(z.w) };
    ops.push(...zellenOps(b.id, werte));
  }
  return ops;
}

/**
 * Umkehrung einer Op, vor dem Anwenden auf `daten` gerufen: die Ops, die den Stand nach `op` wieder zu `daten` machen.
 * Ändert die Op nichts (noop, unbekanntes Blatt, gleicher Wert), ist die Umkehrung leer.
 */
export function invertieren(daten, op) {
  if (!istObjekt(op) || op.typ === 'noop') return [];
  const neu = anwenden(daten, op);
  if (neu === daten) return [];
  switch (op.typ) {
    case 'zelle': return zellenOps(op.blatt, alteWerte(blattVon(daten, op.blatt), { [op.zelle]: eintragVon(op) }));
    case 'zellen': return zellenOps(op.blatt, alteWerte(blattVon(daten, op.blatt), op.werte));
    case 'sortieren': return zellenOps(op.blatt, alteWerte(blattVon(daten, op.blatt), op.zellen));
    case 'zeilen_einfuegen': case 'spalten_einfuegen': {
      const gegen = { typ: op.typ.replace('einfuegen', 'loeschen'), blatt: op.blatt, ab: op.ab, anzahl: op.anzahl };
      return [gegen, ...formelnZurueck(daten, anwenden(neu, gegen))];
    }
    case 'zeilen_loeschen': case 'spalten_loeschen': return loeschenUmkehren(daten, neu, op);
    case 'blatt_neu': return [{ typ: 'blatt_loeschen', blatt: op.blatt.id, rest: daten.blaetter.map((b) => b.id) }];
    case 'blatt_loeschen': return blattZurueck(daten, neu, op);
    case 'blatt_umbenennen': return [{ typ: op.typ, blatt: op.blatt, name: blattVon(daten, op.blatt).name }];
    case 'blatt_verschieben': return [{ typ: op.typ, blatt: op.blatt, pos: blattVon(daten, op.blatt).pos }];
    case 'spalte_breite': return [{ typ: op.typ, blatt: op.blatt, spalte: op.spalte, breite: eigen(blattVon(daten, op.blatt).spalten, spalteZuText(op.spalte))?.breite ?? null }];
    case 'fixieren': return [{ typ: op.typ, blatt: op.blatt, zeilen: blattVon(daten, op.blatt).fixiert.zeilen }];
    default: return [];
  }
}

export const tabelle = Object.freeze({ name: 'tabelle', leer, anwenden, transformiere, zusammensetzen, istNoop, pruefen, auswahlTransformieren, aufwand });
export default tabelle;
