// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tabellen im Office-Dokument (Plan 05): Embed {tabelle:T} mit T = {id, zeilen, spalten, weg, zellen, breiten}.
// Zeilen und Spalten haben Kennungen; gelöschte bleiben als Grabsteine (weg) in ihrer Liste stehen, damit „nach X
// einfügen“ auch bei gleichzeitigem Löschen eindeutig bleibt. Löschen versteckt nur: Inhalte und Breiten bleiben gespeichert,
// Zellen und Breiten wirken auch auf Verstecktes, „zurück“ macht nur wieder sichtbar. Änderungen sind Listen von Tabellen-Ops:
// Zellen und Breiten „letzte Änderung gewinnt“, die Sichtbarkeit einer Zeile/Spalte ebenso (Löschen ↔ zurück) – so laufen
// gleichzeitiges Löschen, Rückgängig und Tippen bei allen gleich aus (Prüfbericht Plan 05, I-4).

import { SyncFehler } from '../fehler.js';
import { gleich } from '../delta.js';
import { ID_MUSTER, attributePruefen } from './dokument-attribute.js';

export const TABELLEN_OPS = Object.freeze(['zelle', 'zeile_einfuegen', 'zeile_loeschen', 'zeile_zurueck', 'spalte_einfuegen', 'spalte_loeschen', 'spalte_zurueck', 'breite']);
export const GRENZEN = Object.freeze({ ops: 1000, zelltext: 20000, zeilen: 10000, spalten: 1000, breite_min: 40, breite_max: 2000 });

const fehler = (meldung, feld = 'op') => new SyncFehler('E_PARAMS', meldung, { feld });
const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
const eigen = (o, k) => (istObjekt(o) && Object.hasOwn(o, k) ? o[k] : undefined);

export const zellKey = (zeile, spalte) => `${zeile}|${spalte}`;
export const sichtbareZeilen = (w) => w.zeilen.filter((id) => !w.weg.includes(id));
export const sichtbareSpalten = (w) => w.spalten.filter((id) => !w.weg.includes(id));
const sichtbar = (liste, w, id) => liste.includes(id) && !w.weg.includes(id);

// ---- Prüfen ------------------------------------------------------------------------------------------------------

function idPruefen(id, feld) { if (typeof id !== 'string' || !ID_MUSTER.test(id)) throw fehler(`„${feld}“ ist keine gültige Kennung`, feld); }
function nur(o, felder, feld) {
  if (!istObjekt(o)) throw fehler('Ungültige Angabe', feld);
  for (const k of Object.keys(o)) if (!felder.includes(k)) throw fehler(`Unbekanntes Feld „${String(k).slice(0, 40)}“`, feld);
}
function breitePruefen(px, feld, mitNull) {
  if (px === null && mitNull) return;
  if (!Number.isInteger(px) || px < GRENZEN.breite_min || px > GRENZEN.breite_max) throw fehler(`Spaltenbreite ${GRENZEN.breite_min}–${GRENZEN.breite_max} px`, feld);
}

/** Zellinhalt: nur Text-inserts mit Inline-Formaten, höchstens 20 000 Zeichen, ohne abschließenden Zeilenumbruch. */
function zellDeltaPruefen(delta, feld) {
  if (!Array.isArray(delta)) throw fehler('Zellinhalt ungültig', feld);
  let n = 0;
  for (const op of delta) {
    nur(op, ['insert', 'attributes'], feld);
    if (typeof op.insert !== 'string' || !op.insert) throw fehler('Zellen enthalten nur Text', feld);
    attributePruefen(op.attributes);
    n += op.insert.length;
  }
  if (n > GRENZEN.zelltext) throw fehler(`Zelltext höchstens ${GRENZEN.zelltext} Zeichen`, feld);
  if (delta.length && delta[delta.length - 1].insert.endsWith('\n')) throw fehler('Zellinhalt endet nicht mit einem Zeilenumbruch', feld);
}

function zellenMapPruefen(zellen, feld) {
  if (!istObjekt(zellen)) throw fehler('Zellen ungültig', feld);
  for (const [k, v] of Object.entries(zellen)) { idPruefen(k, feld); zellDeltaPruefen(v, feld); }
}

/** Liste von Tabellen-Ops prüfen (Form, Kennungen, Grenzen). */
export function tabellenOpsPruefen(liste) {
  if (!Array.isArray(liste) || liste.length > GRENZEN.ops) throw fehler(`Höchstens ${GRENZEN.ops} Tabellenänderungen`);
  for (const op of liste) {
    if (!istObjekt(op) || !TABELLEN_OPS.includes(op.typ)) throw fehler('Unbekannte Tabellenänderung');
    switch (op.typ) {
      case 'zelle': nur(op, ['typ', 'zeile', 'spalte', 'inhalt']); idPruefen(op.zeile, 'zeile'); idPruefen(op.spalte, 'spalte'); zellDeltaPruefen(op.inhalt, 'inhalt'); break;
      case 'zeile_einfuegen': case 'spalte_einfuegen':
        nur(op, ['typ', 'nach', 'id']); idPruefen(op.id, 'id'); if (op.nach !== null) idPruefen(op.nach, 'nach'); break;
      case 'zeile_loeschen': case 'spalte_loeschen': nur(op, ['typ', 'id']); idPruefen(op.id, 'id'); break;
      // zellen/breite in zurück: aus früheren Fassungen noch erlaubt, aber ohne Wirkung (Löschen behält die Inhalte)
      case 'zeile_zurueck': nur(op, ['typ', 'id', 'zellen']); idPruefen(op.id, 'id'); if (op.zellen !== undefined) zellenMapPruefen(op.zellen, 'zellen'); break;
      case 'spalte_zurueck':
        nur(op, ['typ', 'id', 'zellen', 'breite']); idPruefen(op.id, 'id'); if (op.zellen !== undefined) zellenMapPruefen(op.zellen, 'zellen');
        if (op.breite !== undefined) breitePruefen(op.breite, 'breite', false);
        break;
      case 'breite': nur(op, ['typ', 'spalte', 'px']); idPruefen(op.spalte, 'spalte'); breitePruefen(op.px, 'px', true); break;
      default: throw fehler('Unbekannte Tabellenänderung');
    }
  }
}

/** Ganzen Tabellenwert prüfen (Import, eingefügte Tabellen). */
export function tabelleWertPruefen(wert) {
  nur(wert, ['id', 'zeilen', 'spalten', 'weg', 'zellen', 'breiten'], 'tabelle');
  idPruefen(wert.id, 'tabelle.id');
  const liste = (l, max, feld) => {
    if (!Array.isArray(l) || l.length > max) throw fehler(`„${feld}“ ungültig`, feld);
    for (const id of l) idPruefen(id, feld);
    if (new Set(l).size !== l.length) throw fehler(`„${feld}“ enthält Doppelte`, feld);
  };
  liste(wert.zeilen, GRENZEN.zeilen, 'zeilen'); liste(wert.spalten, GRENZEN.spalten, 'spalten');
  const alle = new Set([...wert.zeilen, ...wert.spalten]);
  if (alle.size !== wert.zeilen.length + wert.spalten.length) throw fehler('Zeilen und Spalten brauchen verschiedene Kennungen', 'tabelle');
  liste(wert.weg, GRENZEN.zeilen + GRENZEN.spalten, 'weg');
  if (wert.weg.some((id) => !alle.has(id)) || wert.weg.some((id, i) => i > 0 && wert.weg[i - 1] >= id)) throw fehler('„weg“ ungültig', 'weg');
  if (!istObjekt(wert.zellen)) throw fehler('Zellen ungültig', 'zellen');
  for (const [k, v] of Object.entries(wert.zellen)) {
    const [z, s, rest] = k.split('|');
    if (rest !== undefined || !wert.zeilen.includes(z) || !wert.spalten.includes(s)) throw fehler('Zelle ohne Zeile oder Spalte', 'zellen');
    zellDeltaPruefen(v, 'zellen');
  }
  if (!istObjekt(wert.breiten)) throw fehler('Breiten ungültig', 'breiten');
  for (const [k, v] of Object.entries(wert.breiten)) {
    if (!wert.spalten.includes(k)) throw fehler('Breite ohne Spalte', 'breiten');
    breitePruefen(v, 'breiten', false);
  }
}

// ---- Anwenden ----------------------------------------------------------------------------------------------------

function einfuegen(liste, nach, id) {
  if (nach === null) { liste.unshift(id); return; }
  const i = liste.indexOf(nach);
  if (i < 0) liste.push(id); else liste.splice(i + 1, 0, id);
}

function wegSetzen(w, id) { if (!w.weg.includes(id)) { w.weg.push(id); w.weg.sort(); } }


/** Eine Op auf den (kopierten) Wert anwenden – ändert `w`. Unbekannte Kennungen: nichts. */
function einzeln(w, op) {
  switch (op.typ) {
    case 'zelle': {
      if (!w.zeilen.includes(op.zeile) || !w.spalten.includes(op.spalte)) return;
      const k = zellKey(op.zeile, op.spalte);
      if (op.inhalt.length) w.zellen[k] = structuredClone(op.inhalt); else delete w.zellen[k];
      return;
    }
    case 'zeile_einfuegen': if (!w.zeilen.includes(op.id) && !w.spalten.includes(op.id)) einfuegen(w.zeilen, op.nach, op.id); return;
    case 'spalte_einfuegen': if (!w.spalten.includes(op.id) && !w.zeilen.includes(op.id)) einfuegen(w.spalten, op.nach, op.id); return;
    case 'zeile_loeschen': if (w.zeilen.includes(op.id)) wegSetzen(w, op.id); return;
    case 'spalte_loeschen': if (w.spalten.includes(op.id)) wegSetzen(w, op.id); return;
    case 'zeile_zurueck': case 'spalte_zurueck':
      if ((op.typ === 'zeile_zurueck' ? w.zeilen : w.spalten).includes(op.id)) w.weg = w.weg.filter((x) => x !== op.id);
      return;
    case 'breite':
      if (!w.spalten.includes(op.spalte)) return;
      if (op.px === null) delete w.breiten[op.spalte]; else w.breiten[op.spalte] = op.px;
      return;
    default:
  }
}

function anwenden(wert, liste) {
  const w = structuredClone(wert);
  for (const op of liste || []) einzeln(w, op);
  return w;
}

// ---- Transformieren ----------------------------------------------------------------------------------------------

const sichtbarkeit = (op) => op.typ.endsWith('_loeschen') || op.typ.endsWith('_zurueck');
const achse = (op) => (op.typ.startsWith('zeile') ? 'zeile' : 'spalte');

/** Eine Op x gegen eine gleichzeitige Op y; null = x entfällt. 'links' = y kam später, 'rechts' = x kam später. */
function t1(x, y, seite) {
  if (!x || !y) return x;
  // 1. Sichtbarkeit derselben Zeile/Spalte (löschen ↔ zurück): die spätere Op gewinnt
  if (sichtbarkeit(x) && sichtbarkeit(y) && x.typ !== y.typ && achse(x) === achse(y) && x.id === y.id) return seite === 'links' ? null : x;
  // 2. gleichzeitig nach derselben Zeile/Spalte eingefügt: die spätere rückt hinter die frühere
  if (x.typ === y.typ && (x.typ === 'zeile_einfuegen' || x.typ === 'spalte_einfuegen') && x.nach === y.nach) {
    return seite === 'rechts' ? { ...x, nach: y.id } : x;
  }
  // 3. dasselbe Ziel: letzte Änderung gewinnt
  if (x.typ === y.typ) {
    const gleichesZiel = (x.typ === 'zelle' && x.zeile === y.zeile && x.spalte === y.spalte) || (x.typ === 'breite' && x.spalte === y.spalte);
    if (gleichesZiel) return seite === 'links' ? null : x;
  }
  return x;
}

/** Liste a gegen Liste b (beide auf demselben Stand). */
function transformiere(a, b, seite) {
  const gegenSeite = seite === 'links' ? 'rechts' : 'links';
  let bAkt = b || [];
  const aus = [];
  for (const x of a || []) {
    let x2 = x;
    const bNeu = [];
    for (const y of bAkt) {
      const x3 = t1(x2, y, seite);
      const y2 = t1(y, x2, gegenSeite);
      if (y2) bNeu.push(y2);
      x2 = x3;
      if (x2 === null) break;
    }
    if (x2) { aus.push(x2); bAkt = bNeu; }
  }
  return aus;
}

// ---- Umkehren ----------------------------------------------------------------------------------------------------

/** Umkehrung einer Op gegen den Stand `w` davor (Liste, leer = bewirkte nichts). */
function einzelUmkehr(op, w) {
  switch (op.typ) {
    case 'zelle': {
      if (!w.zeilen.includes(op.zeile) || !w.spalten.includes(op.spalte)) return [];
      const alt = eigen(w.zellen, zellKey(op.zeile, op.spalte)) || [];
      return gleich(alt, op.inhalt) ? [] : [{ typ: 'zelle', zeile: op.zeile, spalte: op.spalte, inhalt: structuredClone(alt) }];
    }
    case 'zeile_einfuegen': return w.zeilen.includes(op.id) || w.spalten.includes(op.id) ? [] : [{ typ: 'zeile_loeschen', id: op.id }];
    case 'spalte_einfuegen': return w.spalten.includes(op.id) || w.zeilen.includes(op.id) ? [] : [{ typ: 'spalte_loeschen', id: op.id }];
    case 'zeile_loeschen': return sichtbar(w.zeilen, w, op.id) ? [{ typ: 'zeile_zurueck', id: op.id }] : [];
    case 'spalte_loeschen': return sichtbar(w.spalten, w, op.id) ? [{ typ: 'spalte_zurueck', id: op.id }] : [];
    case 'zeile_zurueck': return w.zeilen.includes(op.id) && w.weg.includes(op.id) ? [{ typ: 'zeile_loeschen', id: op.id }] : [];
    case 'spalte_zurueck': return w.spalten.includes(op.id) && w.weg.includes(op.id) ? [{ typ: 'spalte_loeschen', id: op.id }] : [];
    case 'breite': {
      if (!w.spalten.includes(op.spalte)) return [];
      const alt = eigen(w.breiten, op.spalte) ?? null;
      return alt === op.px ? [] : [{ typ: 'breite', spalte: op.spalte, px: alt }];
    }
    default: return [];
  }
}

function invertieren(liste, basis) {
  let w = basis;
  const gruppen = [];
  for (const op of liste || []) {
    gruppen.push(einzelUmkehr(op, w));
    w = anwenden(w, [op]);
  }
  return gruppen.reverse().flat();
}

/** Embed-Handler für {tabelle:…} im Delta (V12-Register). */
export const tabelle = Object.freeze({
  anwenden,
  transformiere,
  zusammensetzen: (a, b) => [...(a || []), ...(b || [])],
  invertieren,
});
