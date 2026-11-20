// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einheitliche Fehlerklasse für Agent und Web. Codes siehe docs/schnittstellen.md §6.

export const CODES = Object.freeze([
  'E_PARAMS', 'E_RECHTE', 'E_ANMELDUNG', 'E_TOTP', 'E_BREMSE', 'E_CSRF', 'E_NICHT_GEFUNDEN', 'E_EXISTIERT',
  'E_BELEGT', 'E_KONFIG', 'E_RENDER', 'E_SYSTEM', 'E_PLATZ', 'E_AGENT', 'E_TICKET', 'E_ABGEBROCHEN', 'E_GEAENDERT', 'E_UNBEKANNT',
]);

export class FahnasFehler extends Error {
  /**
   * @param {string} code      einer aus CODES
   * @param {string} meldung   deutsch, für den Nutzer lesbar
   * @param {object} [details] maschinenlesbare Zusatzangaben (z. B. {feld:"name"})
   */
  constructor(code, meldung, details) {
    super(meldung);
    this.name = 'FahnasFehler';
    this.code = CODES.includes(code) ? code : 'E_UNBEKANNT';
    this.details = details;
  }

  toJSON() {
    const f = { code: this.code, meldung: this.message };
    if (this.details !== undefined) f.details = this.details;
    return f;
  }

  /** Macht aus einem beliebigen Fehler einen FahnasFehler (Systemfehler werden nicht mit Interna nach außen gereicht). */
  static aus(e) {
    if (e instanceof FahnasFehler) return e;
    if (e && e.code === 'ENOENT') return new FahnasFehler('E_NICHT_GEFUNDEN', 'Nicht gefunden', { pfad: e.path });
    if (e && e.code === 'EEXIST') return new FahnasFehler('E_EXISTIERT', 'Existiert bereits', { pfad: e.path });
    if (e && e.code === 'EACCES') return new FahnasFehler('E_RECHTE', 'Keine Berechtigung', { pfad: e.path });
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) return new FahnasFehler('E_PLATZ', 'Kein Platz mehr');
    return new FahnasFehler('E_UNBEKANNT', 'Unerwarteter Fehler', { grund: String(e && e.message || e) });
  }
}
