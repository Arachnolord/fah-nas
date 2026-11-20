// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zwischenablage der Office-Tabelle (Plan 06): Text mit Tabulatoren (TSV), wie Excel, LibreOffice und Google Tabellen
// ihn kopieren und einfügen – Felder mit Tab, Zeilenumbruch oder " stehen in Anführungszeichen, "" ist ein ", Zeilen
// enden mit CRLF. Daneben trägt die Zwischenablage beim Kopieren innerhalb des Office den eigenen Typ KOPIER_TYP mit
// Werten, Formeln und Formaten (aktionen.js baut und liest ihn). Ohne DOM.

import { felderLesen } from './csv.js';

/** MIME-Typ der eigenen Zwischenablage (JSON {quelle:{z,s}, zellen:[[{w,f}|null]]}). */
export const KOPIER_TYP = 'application/x-fah-tabelle';

const MUSS_QUOTE = /[\t\r\n"]/;

/** TSV → Zeilen mit Feldern (RFC-4180-Regeln mit Tab als Trenner; eine letzte leere Zeile entfällt). */
export function tsvLesen(text) {
  return felderLesen(typeof text === 'string' ? text : String(text ?? ''), '\t');
}

/** Zeilen → TSV: Felder mit Tab, CR, LF oder " in Anführungszeichen, jede Zeile endet mit CRLF. */
export function tsvSchreiben(matrix) {
  return (matrix ?? []).map((zeile) => `${zeile.map((f) => {
    const s = typeof f === 'string' ? f : String(f ?? '');
    return MUSS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join('\t')}\r\n`).join('');
}
