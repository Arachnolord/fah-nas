// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rückgängig und Wiederholen in der Tabelle (Plan 06): beide Stapel halten je Schritt eine Liste von Ops, die auf den
// aktuellen Stand passt (die Umkehrung aus invertieren). Fremde Änderungen schieben die Stapel weiter – so nimmt
// Rückgängig nur Eigenes zurück, und eine spätere fremde Änderung gewinnt Feldkonflikte (anna schreibt B2, ben
// überschreibt, anna drückt Strg+Z → bens Wert bleibt). Der Editor ruft eigene() für jede eigene Op (vor dem Anwenden),
// fremde() für jede fremde und schickt die Rückgabe von rueckgaengig()/wiederholen() über sitzung.lokal, ohne sie noch
// einmal mit eigene() zu merken. Ohne DOM.

import { tabelle, invertieren, loeschtFremdes } from '../../gemeinsam/sync/typen/tabelle.js';

/**
 * Fremde Op `op` (passt auf den aktuellen Stand) durch einen Stapel schieben, vom jüngsten Schritt zum ältesten: jeder
 * Schritt passt auf den Stand, den die Schritte darüber zurückgeben, also wandert op mit. Wirkungslos Gewordenes fällt
 * aus den Listen; ein leerer Schritt bleibt, bis Rückgängig ihn verbraucht. Nähme ein Schritt mit, was die fremde Op
 * geschrieben oder eingefügt hat (Rückgängig eines Einfügens, nachdem jemand dort schrieb), fällt er weg – mit allen
 * älteren, die auf seinem Stand aufbauen: Rückgängig nimmt nie Fremdes zurück.
 */
function durchschieben(stapel, op) {
  let f = op;
  for (let i = stapel.length - 1; i >= 0; i--) {
    const liste = [];
    for (const o of stapel[i]) {
      if (loeschtFremdes(o, f)) { stapel.splice(0, i + 1); return; }
      const neu = tabelle.transformiere(o, f, 'links'); // die fremde Änderung gilt als später: sie gewinnt Feldkonflikte
      f = tabelle.transformiere(f, o, 'rechts');
      if (!tabelle.istNoop(neu)) liste.push(neu);
    }
    stapel[i] = liste;
  }
}

export class TabVerlauf {
  constructor({ max = 100 } = {}) {
    this.max = max;
    this._zurueck = [];
    this._vor = [];
  }

  get kannZurueck() { return this._zurueck.length > 0; }
  get kannVor() { return this._vor.length > 0; }

  /** Eigene Op, bevor sie auf `datenVorher` angewandt wird. Ohne Wirkung (Noop, gleicher Wert) wird nichts gemerkt. */
  eigene(datenVorher, op) {
    const inv = invertieren(datenVorher, op);
    if (!inv.length) return;
    this._zurueck.push(inv);
    if (this._zurueck.length > this.max) this._zurueck.splice(0, this._zurueck.length - this.max);
    this._vor = [];
  }

  /** Fremde Op, wie sie auf den aktuellen Stand angewandt wurde. */
  fremde(op) {
    if (tabelle.istNoop(op)) return;
    durchschieben(this._zurueck, op);
    durchschieben(this._vor, op);
  }

  /**
   * Letzten eigenen Schritt zurücknehmen → Ops auf `daten` ([] wenn fremde Änderungen ihn aufgehoben haben) oder null.
   * `passt(ops)` prüft den Schritt vorab (ganz oder gar nicht): false → er bleibt liegen, Rückgabe false.
   */
  rueckgaengig(daten, passt) { return this._umschichten(this._zurueck, this._vor, daten, passt); }

  /** Zuletzt Zurückgenommenes wiederholen → Ops auf `daten`, null oder false (wie rueckgaengig). */
  wiederholen(daten, passt) { return this._umschichten(this._vor, this._zurueck, daten, passt); }

  leeren() { this._zurueck = []; this._vor = []; }

  /** Obersten Schritt von `von` nehmen und seine Umkehrung (Gegenliste rückwärts) auf `nach` legen. */
  _umschichten(von, nach, daten, passt) {
    if (!von.length) return null;
    const liste = von[von.length - 1];
    if (passt && !passt(liste)) return false;
    von.pop();
    const gegen = [];
    let x = daten;
    for (const o of liste) {
      gegen.push(invertieren(x, o));
      x = tabelle.anwenden(x, o);
    }
    const umkehrung = gegen.reverse().flat();
    if (umkehrung.length) {
      nach.push(umkehrung);
      if (nach.length > this.max) nach.splice(0, nach.length - this.max);
    }
    return liste;
  }
}
