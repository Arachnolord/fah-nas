// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Board-Ansicht ohne DOM (Plan 04): welche Karten in welcher Spalte stehen (nach Position), mit Filtern „meine“,
// Etikett und Fälligkeit, das Archiv als eigene Liste, und die Board-Mitglieder (wer Karten übernehmen kann).

import { sortiert } from '../../gemeinsam/sync/typen/board.js';

/** Datum „JJJJ-MM-TT“ plus n Tage (Kalenderrechnung in UTC, damit Sommerzeit nicht stört). */
function plusTage(datum, n) {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Passt eine Karte zu den Filtern? faellig: 'heute' | 'ueberfaellig' | 'woche' (heute bis 6 Tage weiter) | null. */
function passt(k, { meine = false, etikett = null, faellig = null } = {}, nutzer, heute) {
  if (meine && !(k.zustaendig || []).includes(nutzer)) return false;
  if (etikett && !(k.etiketten || []).includes(etikett)) return false;
  if (faellig) {
    if (!k.faellig) return false;
    if (faellig === 'heute' && k.faellig !== heute) return false;
    if (faellig === 'ueberfaellig' && !(k.faellig < heute)) return false;
    if (faellig === 'woche' && !(k.faellig >= heute && k.faellig <= plusTage(heute, 6))) return false;
  }
  return true;
}

/**
 * Spalten mit ihren sichtbaren Karten → [{spalte, karten}], Spalten und Karten nach (pos, id). Karten ohne vorhandene
 * Spalte stehen in der ersten Spalte. `archiv:true` → eine Liste aller archivierten Karten ({spalte:null, karten}).
 */
export function sichtbareKarten(daten, { filter = {}, nutzer, heute, archiv = false } = {}) {
  const spalten = sortiert(Array.isArray(daten && daten.spalten) ? daten.spalten : []);
  const alle = Object.values((daten && daten.karten) || {}).filter((k) => k && passt(k, filter, nutzer, heute));
  if (archiv) return [{ spalte: null, karten: sortiert(alle.filter((k) => k.archiviert)) }];
  if (!spalten.length) return [];
  const bekannt = new Set(spalten.map((s) => s.id));
  const je = new Map(spalten.map((s) => [s.id, []]));
  for (const k of alle) {
    if (k.archiviert) continue;
    je.get(bekannt.has(k.spalte) ? k.spalte : spalten[0].id).push(k);
  }
  return spalten.map((s) => ({ spalte: s, karten: sortiert(je.get(s.id)) }));
}

/** Board-Mitglieder: Besitzer und alle, die bearbeiten dürfen (aus office.freigaben), sortiert, ohne Doppelte. */
export function mitglieder(freigaben, besitzer) {
  const namen = new Set(besitzer ? [besitzer] : []);
  for (const g of (freigaben && Array.isArray(freigaben.geteilt_mit) ? freigaben.geteilt_mit : [])) if (g && g.name && g.recht === 'bearbeiten') namen.add(g.name);
  return [...namen].sort((a, b) => a.localeCompare(b, 'de'));
}

/** Heutiges Datum als „JJJJ-MM-TT“ in Ortszeit. */
export function heuteText(jetzt = new Date()) {
  const zwei = (z) => String(z).padStart(2, '0');
  return `${jetzt.getFullYear()}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())}`;
}
