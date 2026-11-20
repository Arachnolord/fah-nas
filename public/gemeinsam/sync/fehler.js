// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fehler des Sync-Motors (V12): dieselben Felder wie FahnasFehler (code, message, details), weil der Browser src/ nicht
// laden kann. Der Web-Dienst wandelt SyncFehler in FahnasFehler um.

export class SyncFehler extends Error {
  constructor(code, meldung, details) {
    super(meldung);
    this.name = 'SyncFehler';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    const f = { code: this.code, meldung: this.message };
    if (this.details !== undefined) f.details = this.details;
    return f;
  }
}
