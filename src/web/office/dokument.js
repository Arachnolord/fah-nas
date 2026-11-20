// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Offenes Office-Dokument im Web-Dienst (Plan 04, V12): der Server ist während der Sitzung die Wahrheit. Er ordnet alle
// Ops zentral, transformiert jede eingehende gegen den Verlauf seit ihrer Basis ('rechts' – die eingehende kam später),
// erkennt doppelt gesendete (gleiche cid) und hält den Verlauf für Wiederaufnahmen – Ungespeichertes nie gekürzt.

import { FahnasFehler } from '../../gemeinsam/fehler.js';

/**
 * Höchster Aufwand (`typ.aufwand`, etwa Einträge × Struktur-Ops) für das Nachrechnen einer Op gegen den Verlauf seit ihrer
 * Basis: darüber lädt der Klient neu, statt dass der Web-Dienst – und mit ihm jeder Nutzer – sekundenlang rechnet.
 */
export const AUFWAND_MAX = 250_000;

/**
 * Gespeicherter Verlauf höchstens so viele JSON-Zeichen (dazu höchstens `verlauf_max` Einträge): Tabellen-Ops können mehrere MB
 * groß sein, 500 davon sprengten den Speicher des Web-Dienstes. Ungespeichertes wird nie gekürzt.
 */
export const VERLAUF_ZEICHEN = 32 * 1024 * 1024;
const ZEICHEN = new WeakMap(); // Verlaufseintrag → JSON-Zeichen seiner Op
function zeichenVon(op) { try { return JSON.stringify(op).length; } catch { return 0; } }

export class OffenesDokument {
  constructor({ meta, typ, version, daten, stand, verlauf = [], verlauf_max = 500, verlauf_zeichen = VERLAUF_ZEICHEN }) {
    this.meta = meta; this.typ = typ; this.stand = stand; this.verlauf_max = verlauf_max; this.verlauf_zeichen = verlauf_zeichen;
    this._version = version; this._daten = daten === null || daten === undefined ? typ.leer() : daten;
    this.verlauf = [...verlauf]; this.gespeichertBis = version;
    this._zeichen = 0;
    for (const e of this.verlauf) this._merken(e);
  }

  /** Größe eines Verlaufseintrags für die Zeichengrenze merken. */
  _merken(e) { const n = zeichenVon(e.op); ZEICHEN.set(e, n); this._zeichen += n; }

  get version() { return this._version; }
  get daten() { return this._daten; }

  /** Ops nach Version `b` – oder null, wenn der Verlauf nicht mehr so weit zurückreicht. */
  opsSeit(b) {
    if (b === this._version) return [];
    const aelteste = this.verlauf[0];
    if (!aelteste || aelteste.v > b + 1) return null;
    return this.verlauf.filter((e) => e.v > b);
  }

  /** Op eines Klienten einordnen → {v, op, cid, doppelt}. Wirft E_PARAMS/E_RECHTE (Prüfung) oder E_GEAENDERT (zu alt). */
  opAnnehmen({ basis, cid, op, nutzer }) {
    if (!Number.isInteger(basis) || basis < 0 || basis > this._version) throw new FahnasFehler('E_PARAMS', 'Basis ungültig', { feld: 'basis' });
    const alt = this.verlauf.find((e) => e.cid === cid);
    if (alt) return { ...alt, doppelt: true };
    const seit = this.opsSeit(basis);
    if (seit === null) throw new FahnasFehler('E_GEAENDERT', 'Zu alter Stand – bitte neu laden');
    try { this.typ.pruefen(op); this.typ.autorPruefen?.(op, nutzer); } catch (e) { throw new FahnasFehler(e.code || 'E_PARAMS', e.message, e.details); }
    if (typeof this.typ.aufwand === 'function' && this.typ.aufwand(op, seit.map((e) => e.op)) > AUFWAND_MAX) {
      throw new FahnasFehler('E_GEAENDERT', 'Zu viel nachzurechnen – bitte neu laden');
    }
    // Transformieren und Anwenden können an einer unpassenden Op scheitern (V12, Plan 05): dann bleibt alles, wie es war
    let o = op; let daten;
    try {
      for (const e of seit) o = this.typ.transformiere(o, e.op, 'rechts');
      daten = this.typ.anwenden(this._daten, o);
    } catch (e) { throw new FahnasFehler(e.code || 'E_PARAMS', e.message, e.details); }
    this._daten = daten;
    const eintrag = { v: this._version + 1, op: o, cid };
    this._version = eintrag.v;
    this.verlauf.push(eintrag);
    this._merken(eintrag);
    this._kuerzen();
    return { ...eintrag, doppelt: false };
  }

  /** Noch nicht gespeicherte Verlaufseinträge. */
  ungespeichert() { return this.verlauf.filter((e) => e.v > this.gespeichertBis); }

  /** Gespeichert bis `version` mit neuem Stand der Datei. */
  gespeichert(version, stand) {
    this.gespeichertBis = Math.max(this.gespeichertBis, version);
    this.stand = stand;
    this._kuerzen();
  }

  /** Höchstens verlauf_max Einträge und verlauf_zeichen JSON-Zeichen – aber nie Ungespeichertes. */
  _kuerzen() {
    while (this.verlauf.length && (this.verlauf.length > this.verlauf_max || this._zeichen > this.verlauf_zeichen) && this.verlauf[0].v <= this.gespeichertBis) {
      this._zeichen -= ZEICHEN.get(this.verlauf.shift()) || 0;
    }
  }
}
