// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Beispiele für die Tests des Datentyps „tabelle“ (Plan 06 Aufgaben 8–10, 17): Startmappe D0 mit zwei
// Blättern und einer Formel über Blattgrenzen, je eine Op aller Op-Arten auf D0 (BEISPIELE), die TP1-Prüfung und
// kleine Helfer zum Bauen und Ablesen von Mappen.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { tabelle, LEER_F } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);

/** Objekt samt allen Unterobjekten einfrieren: wer es ändert, wirft (Module laufen im strikten Modus). */
export function tiefFrieren(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) tiefFrieren(v);
  }
  return o;
}

const A = (d, op) => tabelle.anwenden(d, op);

/** Startmappe: blatt1 mit A1..A3 (A3 = Summe) und fettem B5, blatt2 „Daten“ mit einem Bezug auf blatt1!A3. */
export function D0() {
  return A(A(tabelle.leer(), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: '1' }, A2: { w: '2' }, A3: { w: '=SUM(A1:A2)' }, B5: { f: { fett: true } } } }),
    { typ: 'blatt_neu', blatt: { id: 'blatt2', name: 'Daten', pos: 'r', zellen: { A1: { w: '=[blatt1]!A3*2' } } } });
}

/** Je eine Op jeder Art auf D0 (Sortierung absteigend nach Wert: 3, 2, 1 – die Formel rückt dabei zwei Zeilen hoch). */
export const BEISPIELE = tiefFrieren([
  { typ: 'zelle', blatt: 'blatt1', zelle: 'A4', w: '=A3+1' },
  { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: '7' }, C1: { f: { farbe: '#b42318' } } } },
  { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 2, anzahl: 2 },
  { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 2, anzahl: 1 },
  { typ: 'spalten_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 },
  { typ: 'spalten_loeschen', blatt: 'blatt1', ab: 1, anzahl: 1 },
  { typ: 'sortieren', blatt: 'blatt1', bereich: 'A1:A3', spalte: 1, absteigend: true, zellen: { A1: { w: '=SUM(#REF!)', f: LEER_F }, A2: { w: '2', f: LEER_F }, A3: { w: '1', f: LEER_F } } },
  { typ: 'blatt_neu', blatt: { id: 'blatt3', name: 'Neu', pos: 'z', zellen: { A1: { w: '=[blatt1]!A2*3' }, B1: { w: '=A1+1', f: { kursiv: true } } }, spalten: { B: { breite: 80 } } } },
  { typ: 'blatt_umbenennen', blatt: 'blatt2', name: 'X' },
  { typ: 'blatt_loeschen', blatt: 'blatt2', rest: ['blatt1'] },
  { typ: 'blatt_verschieben', blatt: 'blatt2', pos: 'a' },
  { typ: 'spalte_breite', blatt: 'blatt1', spalte: 2, breite: 140 },
  { typ: 'fixieren', blatt: 'blatt1', zeilen: 1 },
  { typ: 'noop' },
]);

/** TP1: beide Reihenfolgen ergeben dieselben Daten (a kam beim Server zuerst an). */
export function tp1(d, a, b) {
  const T = tabelle.transformiere;
  assert.deepEqual(A(A(d, a), T(b, a, 'rechts')), A(A(d, b), T(a, b, 'links')), `${JSON.stringify(a).slice(0, 90)} ↔ ${JSON.stringify(b).slice(0, 90)}`);
}

/** Mappe aus {blattId: {Adresse: w}} – Blätter in der angegebenen Reihenfolge, Namen Tabelle1, Tabelle2 … */
export function mappe(inhalt) {
  const blaetter = Object.entries(inhalt).map(([id, zellen], i) => ({
    id, name: `Tabelle${i + 1}`, pos: 'ikmoqsuwy'[i] || `z${i}`,
    zellen: Object.fromEntries(Object.entries(zellen).map(([adr, w]) => [adr, { w }])), spalten: {}, zeilen: {}, fixiert: { zeilen: 0 },
  }));
  return { blaetter };
}

/** {Adresse: w} eines Blatts, nur Zellen mit Wert. */
export function werteVon(daten, blattId) {
  const blatt = daten.blaetter.find((b) => b.id === blattId);
  return blatt ? Object.fromEntries(Object.entries(blatt.zellen).filter(([, z]) => z.w !== undefined).map(([adr, z]) => [adr, z.w])) : null;
}
