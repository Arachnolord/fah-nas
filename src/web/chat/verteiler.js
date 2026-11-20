// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Offene Chat-Verbindungen (Plan 02): wer ist da (online), wer schaut gerade hin (aktiv = Meldung „sichtbar“ in den
// letzten 120 s – diese Nutzer bekommen keine Handy-Meldung), und Zustellen nur an genannte Empfänger.

export const AKTIV_MS = 120_000;

export class Verteiler {
  constructor() { this.verbindungen = new Set(); }

  anmelden(v) { this.verbindungen.add(v); }
  abmelden(v) { this.verbindungen.delete(v); }
  alle() { return [...this.verbindungen]; }
  fuerNutzer(name) { return this.alle().filter((v) => v.identitaet.art === 'nutzer' && v.identitaet.nutzer === name); }
  fuerGast(id) { return this.alle().filter((v) => v.identitaet.art === 'gast' && v.identitaet.gast === id); }

  /** An genau diese Nutzer und Gäste (alle ihre Verbindungen), optional ohne eine Verbindung bzw. Identität. */
  senden({ nutzer = [], gaeste = [] } = {}, obj, { ausser = null } = {}) {
    const n = new Set(nutzer); const g = new Set(gaeste);
    for (const v of this.verbindungen) {
      if (ausser && (v === ausser || (typeof ausser === 'function' && ausser(v)))) continue;
      const id = v.identitaet;
      if ((id.art === 'nutzer' && n.has(id.nutzer)) || (id.art === 'gast' && g.has(id.gast))) v.ws.senden(obj);
    }
  }

  online() {
    return [...new Set(this.alle().filter((v) => v.identitaet.art === 'nutzer').map((v) => v.identitaet.nutzer))].sort();
  }

  aktive(jetzt = Date.now()) {
    return [...new Set(this.alle().filter((v) => v.identitaet.art === 'nutzer' && v.sichtbarSeit !== null && jetzt - v.sichtbarSeit <= AKTIV_MS).map((v) => v.identitaet.nutzer))].sort();
  }

  sichtbar(v, ja, jetzt = Date.now()) { v.sichtbarSeit = ja ? jetzt : null; }
}
