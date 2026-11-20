// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Konstanten für den Browser – Kopie aus src/gemeinsam/office.js (der Browser kann src/ nicht laden; ein Test
// prüft, dass beide gleich sind).

/** Datei im Bündel: „<12 Zeichen>-<Name>“. */
export const DATEI_MUSTER = /^[A-Za-z0-9_-]{12}-[^/\\\u0000-\u001f]{1,200}$/;
/** Höchstens 100 MiB je Bild/Anhang. */
export const DATEI_MAX_BYTES = 104857600;
