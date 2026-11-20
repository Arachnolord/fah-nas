// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Andockstellen der Chat-Ansicht für spätere Bausteine (Plan 03: Anrufe): Knöpfe im Raumkopf, Karten in den
// Einstellungen, Zeilen in der Dashboard-Kachel. Jede Funktion darf null liefern (dann erscheint nichts).

export const erweiterungen = { raumKopf: [], einstellungen: [], kachel: [] };

/** `art`: 'raumKopf' → fn(raum, ctx, v), 'einstellungen' → fn(ctx), 'kachel' → fn(uebersicht); jeweils → HTMLElement|null. */
export function erweiterungHinzu(art, fn) {
  if (!Object.hasOwn(erweiterungen, art)) throw new Error(`Unbekannte Chat-Erweiterung „${art}“`);
  if (typeof fn !== 'function') throw new Error('Chat-Erweiterung braucht eine Funktion');
  if (!erweiterungen[art].includes(fn)) erweiterungen[art].push(fn);
}

/** Ruft alle Erweiterungen einer Art auf; Fehler einer Erweiterung blenden nur sie aus. */
export function erweiterungenBauen(art, ...args) {
  const aus = [];
  for (const fn of erweiterungen[art] || []) {
    try { const k = fn(...args); if (k) aus.push(k); } catch (e) { console.warn(`[chat] Erweiterung ${art}:`, e && e.message); }
  }
  return aus;
}
