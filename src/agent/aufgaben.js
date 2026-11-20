// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aufgaben-Warteschlange für lang laufende Aktionen: Fortschritt, Abbruch, begrenzte Parallelität, Ereignisse.
// Die Liste wird in eine Zustandsdatei gespiegelt (aufgaben.json in der Konfiguration); beim Start des Agenten
// werden dort noch offene Aufgaben (wartet/laeuft) als „abgebrochen“ übernommen und gemeldet – sonst stünden sie
// in der Oberfläche nach einem Neustart ewig auf „läuft“.

import { kennung } from '../gemeinsam/protokoll.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export const AUFGABEN_DATEI = 'aufgaben.json';
const BEHALTEN = 200;

export class Aufgaben {
  /**
   * @param {(ereignis:object)=>void} melden  wird bei jeder Zustandsänderung mit {ereignis:"aufgabe", …} gerufen
   * @param {number} parallel                 gleichzeitig laufende Aufgaben
   * @param {{laden:()=>Promise<object[]>, speichern:(liste:object[])=>Promise<void>}} [ablage]  Zustandsdatei (optional)
   */
  constructor(melden, parallel = 2, ablage = null) {
    this.melden = melden; this.parallel = parallel; this.ablage = ablage;
    this.alle = new Map(); this.warteschlange = []; this.laufend = 0;
    this._speicherKette = Promise.resolve();
  }

  /**
   * Übernimmt Aufgaben aus der Zustandsdatei: beendete bleiben zur Ansicht, offene werden „abgebrochen“
   * (der Agent wurde neu gestartet) und als Ereignis gemeldet.
   * @returns {Promise<string[]>} Kennungen der als abgebrochen markierten Aufgaben
   */
  async wiederherstellen() {
    if (!this.ablage) return [];
    let liste = [];
    try { liste = await this.ablage.laden(); } catch (e) { process.stderr.write(`[aufgaben] Zustandsdatei nicht lesbar: ${e.message}\n`); return []; }
    if (!Array.isArray(liste)) return [];
    const abgebrochen = [];
    const jetzt = new Date().toISOString();
    for (const e of liste) {
      if (!e || typeof e.id !== 'string' || this.alle.has(e.id)) continue;
      const a = { ...e, _abbruch: false, _arbeit: null };
      if (a.status === 'wartet' || a.status === 'laeuft') {
        a.status = 'abgebrochen'; a.beendet = jetzt; a.meldung = 'Der Steuerdienst wurde neu gestartet – die Aufgabe wurde abgebrochen';
        a.fehler = new FahnasFehler('E_ABGEBROCHEN', a.meldung).toJSON();
        abgebrochen.push(a.id);
      }
      this.alle.set(a.id, a);
    }
    this._aufraeumen();
    for (const id of abgebrochen) this._melden(this.alle.get(id), false);
    this._speichern();
    return abgebrochen;
  }

  /**
   * Stellt eine Aufgabe ein. `arbeit(aufgabe)` bekommt {fortschritt(anteil, meldung), abgebrochen(), id}.
   * `rolle` ist die wirksame Rolle des Auftraggebers – der Agent filtert danach Fehlerdetails in Ereignissen.
   * @returns {string} Aufgaben-ID
   */
  einstellen({ aktion, nutzer, rolle, arbeit }) {
    const id = kennung('t-');
    const a = { id, aktion, nutzer, rolle: rolle || 'nutzer', status: 'wartet', fortschritt: 0, meldung: '', ergebnis: undefined, fehler: undefined, gestartet: new Date().toISOString(), beendet: undefined, _abbruch: false, _arbeit: arbeit };
    this.alle.set(id, a);
    this.warteschlange.push(a);
    this._melden(a);
    this._naechste();
    return id;
  }

  _naechste() {
    while (this.laufend < this.parallel && this.warteschlange.length) {
      const a = this.warteschlange.shift();
      if (a._abbruch) { a.status = 'abgebrochen'; a.beendet = new Date().toISOString(); this._melden(a); continue; }
      this.laufend++;
      a.status = 'laeuft'; this._melden(a);
      const griff = {
        id: a.id,
        fortschritt: (anteil, meldung) => { a.fortschritt = Math.max(0, Math.min(1, Number(anteil) || 0)); if (meldung !== undefined) a.meldung = String(meldung); this._melden(a, false); },
        abgebrochen: () => a._abbruch,
      };
      Promise.resolve().then(() => a._arbeit(griff)).then((ergebnis) => {
        a.status = a._abbruch ? 'abgebrochen' : 'fertig'; a.fortschritt = 1; a.ergebnis = ergebnis;
      }).catch((e) => {
        const f = FahnasFehler.aus(e); a.status = f.code === 'E_ABGEBROCHEN' ? 'abgebrochen' : 'fehler'; a.fehler = f.toJSON();
      }).finally(() => {
        a.beendet = new Date().toISOString(); this.laufend--; this._melden(a); this._naechste(); this._aufraeumen();
      });
    }
  }

  abbrechen(id) {
    const a = this.alle.get(id);
    if (!a) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Aufgabe nicht gefunden');
    if (a.status === 'wartet' || a.status === 'laeuft') { a._abbruch = true; if (a.status === 'wartet') { a.status = 'abgebrochen'; a.beendet = new Date().toISOString(); this._melden(a); } }
    return this.ansicht(a);
  }

  ansicht(a) {
    const { _arbeit, _abbruch, ...rest } = a; // eslint-disable-line no-unused-vars
    return rest;
  }

  /** Alle Aufgaben, neueste zuerst; optional seitenweise (seite ab 1). */
  liste({ seite = 1, je_seite } = {}) {
    const alle = [...this.alle.values()].map((a) => this.ansicht(a)).sort((x, y) => (x.gestartet < y.gestartet ? 1 : -1));
    if (!je_seite) return alle;
    const start = (Math.max(1, seite) - 1) * je_seite;
    return alle.slice(start, start + je_seite);
  }

  hole(id) { const a = this.alle.get(id); if (!a) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Aufgabe nicht gefunden'); return this.ansicht(a); }

  /** Meldet den Stand; Statuswechsel landen zusätzlich in der Zustandsdatei (Fortschritt allein nicht – zu häufig). */
  _melden(a, statuswechsel = true) {
    try { this.melden({ ereignis: 'aufgabe', aufgabe: a.id, ...this.ansicht(a) }); } catch { /* nie werfen */ }
    if (statuswechsel) this._speichern();
  }

  /** Schreibt die Liste in die Zustandsdatei (in Reihenfolge, Fehler nur auf stderr). Gibt die Kette zurück (Tests). */
  _speichern() {
    if (!this.ablage) return this._speicherKette;
    const liste = this.liste();
    this._speicherKette = this._speicherKette.then(() => this.ablage.speichern(liste)).catch((e) => { process.stderr.write(`[aufgaben] Zustandsdatei: ${e.message}\n`); });
    return this._speicherKette;
  }

  /** Wartet, bis alle ausstehenden Schreibvorgänge der Zustandsdatei fertig sind (für Stoppen und Tests). */
  gespeichert() { return this._speicherKette; }

  /** Behält höchstens 200 beendete Aufgaben im Speicher. */
  _aufraeumen() {
    const beendet = [...this.alle.values()].filter((a) => a.beendet).sort((x, y) => (x.beendet < y.beendet ? -1 : 1));
    while (beendet.length > BEHALTEN) this.alle.delete(beendet.shift().id);
  }
}
