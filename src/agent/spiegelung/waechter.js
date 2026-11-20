// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung – Änderungs-Wächter: inotifywait (inotify-tools) überwacht die Ordner einer Spiegelung rekursiv. Nach der
// Wartezeit ohne weitere Änderung wird `ausloesen()` gerufen. Keine Änderung wird verworfen – auch nicht während eines
// Laufs (Praxistest 11.10.: eine Änderung 1 s nach einem Lauf ging sonst verloren); läuft gerade einer, merkt sich der
// Aufrufer „danach noch einmal“. Eine beidseitige Spiegelung löst mit ihren eigenen Schreibvorgängen so höchstens EINEN
// weiteren Lauf aus, der nichts mehr zu tun hat und nichts schreibt – danach ist Ruhe.
// Endet inotifywait (Ordner fehlt, Laufwerk abgezogen), startet der Wächter nach einer Minute neu.

import { PAPIERKORB } from './regeln.js';

export const NEUSTART_MS = 60_000;
const AUSSCHLUSS = `(/${PAPIERKORB.replace('.', '\\.')}(/|$)|/\\.papierkorb(/|$)|/\\.unison\\.)`;
/** Eigene Pfade zählen nie als Änderung. Das --exclude von inotifywait greift nicht für das Anlegen dieser Ordner selbst
 *  (Praxistest 11.10.: „CREATE,ISDIR …/.fah-papierkorb“ kam durch → Lauf jede Minute) – deshalb hier noch einmal filtern. */
export const EIGENE_PFADE = new RegExp(AUSSCHLUSS);

export class Waechter {
  /**
   * @param {object} o
   * @param {object} o.system        gemeinsam/system.js (starten)
   * @param {string[]} o.pfade       zu überwachende Ordner
   * @param {number} o.wartezeit_ms  Ruhe nach der letzten Änderung, bevor ausgelöst wird
   * @param {() => void} o.ausloesen
   */
  constructor({ system, pfade, wartezeit_ms, ausloesen }) {
    this.system = system; this.pfade = pfade; this.wartezeit_ms = wartezeit_ms; this.ausloesen = ausloesen;
    this.kind = null; this.timer = null; this.neustart = null; this.gestoppt = false; this.fehler = null; this.aktiv = false;
  }

  /** Kennung der Einstellung – ändert sie sich, wird der Wächter neu aufgesetzt. */
  get schluessel() { return `${this.pfade.join('|')}#${this.wartezeit_ms}`; }

  starten() {
    if (this.gestoppt || this.kind) return;
    let kind;
    try {
      kind = this.system.starten('inotifywait', ['-m', '-r', '-q', '--format', '%w%f', '-e', 'close_write,create,delete,move,attrib', '--exclude', AUSSCHLUSS, '--', ...this.pfade], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { this._beendet(`inotifywait ließ sich nicht starten: ${e.message}`); return; }
    this.kind = kind; this.aktiv = true;
    let fehlertext = '';
    let rest = '';
    kind.stdout.on('data', (d) => {
      const zeilen = (rest + d.toString()).split('\n');
      rest = zeilen.pop();
      if (zeilen.some((z) => z && !EIGENE_PFADE.test(z))) this._aenderung();
    });
    kind.stderr.on('data', (d) => { fehlertext = (fehlertext + d.toString()).slice(-500); });
    kind.on('error', (e) => { fehlertext = e.message; });
    kind.on('close', () => { this.kind = null; this._beendet(fehlertext.trim() || 'Überwachung beendet'); });
  }

  _aenderung() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (!this.gestoppt) this.ausloesen(); }, this.wartezeit_ms);
  }

  _beendet(grund) {
    this.aktiv = false;
    if (this.gestoppt) return;
    this.fehler = grund;
    clearTimeout(this.neustart);
    this.neustart = setTimeout(() => { this.neustart = null; this.fehler = null; this.starten(); }, NEUSTART_MS);
  }

  stoppen() {
    this.gestoppt = true; this.aktiv = false;
    clearTimeout(this.timer); clearTimeout(this.neustart); this.timer = null; this.neustart = null;
    if (this.kind) { try { this.kind.kill('SIGTERM'); } catch { /* weg */ } this.kind = null; }
  }

  zustand() { return { aktiv: this.aktiv, fehler: this.aktiv ? null : this.fehler, wartet: !!this.timer }; }
}
