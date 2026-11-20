// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Filter der Office-Tabelle (Plan 06): eine reine Ansicht – er blendet Zeilen nur im eigenen Raster aus und ändert
// keine Daten (andere sehen ihre eigene Ansicht). Zeile 1 ist die Kopfzeile, gefiltert wird ab Zeile 2 bis zur letzten
// belegten Zeile des Blatts, verglichen wird der angezeigte Text der Zelle (leer = ''). Der Editor hält die ausgeblendeten
// Zeilen beim Setzen fest (wie „Erneut anwenden“ in Excel) und verschiebt sie mit Struktur-Ops. Ohne DOM.

import { adresse, adresseLesen } from './formeln/adresse.js';
import { wertAnzeigen } from './formeln/werte.js';

const MAX_WERTE = 1000;
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });

/** Letzte Zeile mit Inhalt (w) im Blatt; leer → 0. */
function letzteZeile(blatt) {
  let z = 0;
  for (const [adr, zelle] of Object.entries(blatt?.zellen ?? {})) {
    if (typeof zelle?.w !== 'string') continue;
    const o = adresseLesen(adr, OHNE_GRENZEN);
    if (o && o.z > z) z = o.z;
  }
  return z;
}

/** Angezeigter Text der Zelle (z, spalte); leer → ''. */
function zellText(blatt, rechner, blattId, z, spalte) {
  const adr = adresse(z, spalte), zelle = blatt?.zellen?.[adr];
  return typeof zelle?.w === 'string' ? wertAnzeigen(rechner.wert(blattId, adr), zelle.f?.zahl ?? null) : '';
}

/**
 * Die Werte einer Spalte ab Zeile 2 mit Anzahl → [{text, anzahl}], deutsch sortiert, leer ('') zuletzt, höchstens
 * 1000 Einträge.
 */
export function filterWerte(daten, rechner, blattId, spalte) {
  const blatt = (daten?.blaetter ?? []).find((b) => b.id === blattId);
  const zaehler = new Map();
  for (let z = 2, ende = letzteZeile(blatt); z <= ende; z++) {
    const text = zellText(blatt, rechner, blattId, z, spalte);
    zaehler.set(text, (zaehler.get(text) ?? 0) + 1);
  }
  return [...zaehler].map(([text, anzahl]) => ({ text, anzahl }))
    .sort((a, b) => (a.text === '') - (b.text === '') || a.text.localeCompare(b.text, 'de'))
    .slice(0, MAX_WERTE);
}

/** Zeilen (ab 2), deren Text in der Filterspalte nicht erlaubt ist → Set der Zeilennummern; kein Filter → leer. */
export function versteckteZeilen(daten, rechner, blattId, filter) {
  const aus = new Set();
  if (!filter) return aus;
  const blatt = (daten?.blaetter ?? []).find((b) => b.id === blattId);
  for (let z = 2, ende = letzteZeile(blatt); z <= ende; z++) {
    if (!filter.erlaubt.has(zellText(blatt, rechner, blattId, z, filter.spalte))) aus.add(z);
  }
  return aus;
}
