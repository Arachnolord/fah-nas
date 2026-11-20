// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Verbindung des Web-Dienstes zum Agenten: eine dauerhafte NDJSON-Verbindung, Multiplex über id,
// automatischer Neuaufbau, Ereignisse als EventEmitter ("ereignis", "verbunden", "getrennt").

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PFADE } from '../gemeinsam/pfade.js';
import { zeilenleser, sende, kennung } from '../gemeinsam/protokoll.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export class AgentClient extends EventEmitter {
  constructor(socketPfad = PFADE.agentSocket, datenSocket = PFADE.datenSocket) {
    super();
    this.socketPfad = socketPfad; this.datenSocket = datenSocket;
    this.socket = null; this.offen = new Map(); this.wartezeit = 1000; this.gestoppt = false; this.verbunden = false;
  }

  starten() { this.gestoppt = false; this._verbinden(); }

  _verbinden() {
    if (this.gestoppt) return;
    const s = net.createConnection(this.socketPfad);
    s.on('connect', () => { this.socket = s; this.verbunden = true; this.wartezeit = 1000; this.emit('verbunden'); });
    zeilenleser(s, (n) => {
      if (n.id && this.offen.has(n.id)) {
        const { ok, nein, timer } = this.offen.get(n.id); clearTimeout(timer); this.offen.delete(n.id);
        if (n.ok) ok(n); else nein(new FahnasFehler(n.fehler?.code || 'E_UNBEKANNT', n.fehler?.meldung || 'Fehler', n.fehler?.details));
      } else if (n.ereignis) {
        this.emit('ereignis', n);
      }
    }, () => s.destroy());
    const weg = () => {
      if (this.socket === s || !this.verbunden) {
        const warVerbunden = this.verbunden;
        this.socket = null; this.verbunden = false;
        for (const [, o] of this.offen) { clearTimeout(o.timer); o.nein(new FahnasFehler('E_AGENT', 'Steuerdienst nicht erreichbar')); }
        this.offen.clear();
        if (warVerbunden) this.emit('getrennt');
      }
      if (!this.gestoppt) { setTimeout(() => this._verbinden(), this.wartezeit); this.wartezeit = Math.min(30_000, this.wartezeit * 2); }
    };
    s.on('close', weg); s.on('error', () => {});
  }

  /**
   * Schickt eine Aktion mit Nutzerkontext. Löst mit der vollständigen Antwort auf ({ok, ergebnis} oder {ok, aufgabe}).
   */
  anfrage(aktion, params, kontext, zeitlimit_ms = 120_000) {
    if (!this.socket || !this.verbunden) return Promise.reject(new FahnasFehler('E_AGENT', 'Steuerdienst nicht erreichbar'));
    const id = kennung('r-');
    return new Promise((ok, nein) => {
      const timer = setTimeout(() => { this.offen.delete(id); nein(new FahnasFehler('E_AGENT', 'Steuerdienst antwortet nicht')); }, zeitlimit_ms);
      this.offen.set(id, { ok, nein, timer });
      if (!sende(this.socket, { id, aktion, params: params ?? {}, kontext })) { clearTimeout(timer); this.offen.delete(id); nein(new FahnasFehler('E_AGENT', 'Steuerdienst nicht erreichbar')); }
    });
  }

  /** Bequem: gibt direkt `ergebnis` zurück (bei Aufgaben {aufgabe}). */
  async aktion(aktion, params, kontext) {
    const a = await this.anfrage(aktion, params, kontext);
    return a.aufgabe !== undefined ? { aufgabe: a.aufgabe } : a.ergebnis;
  }

  /**
   * Öffnet den Datenkanal für ein Ticket. Gibt den Socket zurück (Duplex). Bei Fehler vor dem Start schickt der Agent
   * eine JSON-Zeile – der Aufrufer muss die erste Zeile nur bei `art:"schreiben"`-Abschluss lesen (siehe Web-API).
   */
  datenkanal(ticket, nutzer) {
    return new Promise((ok, nein) => {
      const s = net.createConnection(this.datenSocket);
      s.once('connect', () => { s.write(JSON.stringify({ ticket, nutzer }) + '\n'); ok(s); });
      s.once('error', (e) => nein(new FahnasFehler('E_AGENT', 'Datenkanal nicht erreichbar', { grund: e.message })));
    });
  }

  stoppen() { this.gestoppt = true; if (this.socket) this.socket.destroy(); }
}
