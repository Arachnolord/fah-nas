// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Bündel (Plan 04, V13): ein Office-Dokument ist ein Ordner „<Name>.fahdoc|.fahtab|.fahboard“ in einer Freigabe
// mit inhalt.json (Stand), verlauf.ndjson (letzte Änderungen) und dateien/ (Bilder, Anhänge). Nur Konstanten und reine
// Hilfen – ohne Importe, damit der Dateihelfer eigenständig bleibt.

export const OFFICE_ARTEN = Object.freeze(['dokument', 'tabelle', 'board']);
export const ENDUNGEN = Object.freeze({ dokument: '.fahdoc', tabelle: '.fahtab', board: '.fahboard' });
export const BUENDEL_MUSTER = /\.(fahdoc|fahtab|fahboard)$/i;
export const INHALT_DATEI = 'inhalt.json';
export const VERLAUF_DATEI = 'verlauf.ndjson';
export const DATEIEN_ORDNER = 'dateien';
export const INHALT_MAX_BYTES = 33554432; // 32 MiB
export const DATEI_MAX_BYTES = 104857600; // 100 MiB je Bild/Anhang
export const VERLAUF_MAX = 500;
export const SCHEMA = 1;
/** Datei im Bündel: „<12 Zeichen base64url>-<Name>“. */
export const DATEI_MUSTER = /^[A-Za-z0-9_-]{12}-[^/\\\u0000-\u001f]{1,200}$/;

/** Art aus dem Bündelnamen („Plan.fahboard“ → 'board'), sonst null. */
export function artAusName(name) {
  const m = BUENDEL_MUSTER.exec(String(name || ''));
  if (!m) return null;
  const endung = `.${m[1].toLowerCase()}`;
  return OFFICE_ARTEN.find((a) => ENDUNGEN[a] === endung) || null;
}

/** Liegt der relative Pfad in einem Bündel (oder ist er eins)? */
export function imBuendel(rel) {
  return String(rel || '').split('/').some((teil) => BUENDEL_MUSTER.test(teil));
}
