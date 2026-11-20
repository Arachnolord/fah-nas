// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rückgängig und Wiederholen im Dokument (Plan 05): beide Stapel halten Umkehrungen, die auf den aktuellen Stand
// passen. Eigene Änderungen innerhalb von `gruppierenMs` bilden einen Schritt; fremde Änderungen verschieben die Stapel
// (Rückgängig nimmt nur Eigenes zurück, nie das, was andere geschrieben haben). Ohne DOM.

import { invertieren, zusammensetzen, transformiere } from '../../gemeinsam/sync/delta.js';

/** Nur Zahl-retain ohne Attribute: ändert nichts. */
const leer = (d) => d.every((op) => typeof op.retain === 'number' && !op.attributes);

/** Fremde Änderung `d` (auf dem aktuellen Stand) durch einen Stapel schieben, von oben nach unten. */
function verschieben(stapel, d) {
  let r = d;
  for (let i = stapel.length - 1; i >= 0; i--) {
    const alt = stapel[i];
    stapel[i] = transformiere(alt, r, 'links');
    r = transformiere(r, alt, 'rechts');
  }
  return stapel.filter((e) => !leer(e));
}

export class Rueckgaengig {
  constructor({ gruppierenMs = 500, max = 200 } = {}) {
    this.gruppierenMs = gruppierenMs;
    this.max = max;
    this._zurueck = [];
    this._vor = [];
    this._letzte = -Infinity; // Zeitpunkt der letzten eigenen Änderung der laufenden Gruppe
  }

  get kannZurueck() { return this._zurueck.length > 0; }
  get kannVor() { return this._vor.length > 0; }

  /** Eigene Änderung `d`, angewandt auf `basisDelta`, zum Zeitpunkt `zeit` (ms). */
  eigene(d, basisDelta, zeit) {
    const inv = invertieren(d, basisDelta);
    if (leer(inv)) return;
    if (zeit - this._letzte < this.gruppierenMs && !this._vor.length && this._zurueck.length) {
      const neu = zusammensetzen(inv, this._zurueck.pop());
      if (!leer(neu)) this._zurueck.push(neu);
    } else {
      this._zurueck.push(inv);
      if (this._zurueck.length > this.max) this._zurueck.splice(0, this._zurueck.length - this.max);
    }
    this._vor = [];
    this._letzte = zeit;
  }

  /** Fremde Änderung `d` auf dem aktuellen Stand. */
  fremde(d) {
    if (leer(d)) return;
    this._zurueck = verschieben(this._zurueck, d);
    this._vor = verschieben(this._vor, d);
  }

  /** Letzten eigenen Schritt zurücknehmen → Änderung auf `aktuell` oder null. */
  rueckgaengig(aktuell) { return this._umschichten(this._zurueck, this._vor, aktuell); }

  /** Zuletzt Zurückgenommenes wiederholen → Änderung auf `aktuell` oder null. */
  wiederholen(aktuell) { return this._umschichten(this._vor, this._zurueck, aktuell); }

  leeren() { this._zurueck = []; this._vor = []; this._letzte = -Infinity; }

  _umschichten(von, nach, aktuell) {
    this._letzte = -Infinity; // die Zeitgruppe ist beendet
    if (!von.length) return null;
    const u = von[von.length - 1];
    const inv = invertieren(u, aktuell); // passt `aktuell` nicht, bleiben beide Stapel unberührt
    von.pop();
    nach.push(inv);
    if (nach.length > this.max) nach.splice(0, nach.length - this.max);
    return u;
  }
}
