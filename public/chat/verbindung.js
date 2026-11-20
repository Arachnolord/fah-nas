// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Verbindung im Browser (Plan 02): ein WebSocket zu /api/chat/ws für Aufrufe (aufruf → antwort per id) und
// Ereignisse vom Server (chat, tippt, online, anruf.*). Bricht die Leitung ab, verbindet sie neu (1 s, verdoppelt bis
// 30 s); Aufrufe ohne Verbindung warten höchstens 20 s. Meldet „sichtbar“, damit keine Handy-Meldung kommt, solange
// jemand hinschaut. Kein Import aus app.js – die Gastseite nutzt dieselbe Verbindung.

export const ENDGUELTIG = Object.freeze([4001, 4003]);
const WARTEN_MS = 20_000;
const SICHTBAR_MS = 60_000;

// Pfeilfunktionen statt fester Verweise: so greift immer die aktuelle Uhr (auch eine Test-Uhr)
const STANDARD_UHR = Object.freeze({
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
});

/** Wartezeit vor dem nächsten Verbindungsversuch: 1 s, verdoppelt, höchstens 30 s. */
export function naechsteWartezeit(versuch) { return Math.min(30_000, 1000 * 2 ** versuch); }

export class ChatFehler extends Error {
  constructor(code, meldung, details) {
    super(meldung || code);
    this.name = 'ChatFehler'; this.code = code; this.meldung = meldung || code; this.details = details;
  }
}

export class ChatVerbindung {
  constructor({ url, WebSocketKlasse = globalThis.WebSocket, dokument = globalThis.document, uhr = STANDARD_UHR, endgueltig = ENDGUELTIG } = {}) {
    this.url = url; this.WebSocketKlasse = WebSocketKlasse; this.dokument = dokument; this.uhr = uhr; this.endgueltig = new Set(endgueltig);
    this.ws = null; this._status = 'getrennt'; this.laufend = false; this.versuch = 0; this.warVerbunden = false; this.zaehler = 0;
    this.hoerer = new Map(); this.offen = new Map(); this.schlange = [];
    this.wiederTimer = null; this.sichtbarTimer = null;
    this._sichtbarkeit = () => this._sichtbarMelden();
  }

  get status() { return this._status; }

  /** Hörer für eine Art (`chat`, `tippt`, `online`, `anruf.*`, `status`, `wieder`, `beendet`); gibt die Abmeldung zurück. */
  on(art, fn) {
    if (!this.hoerer.has(art)) this.hoerer.set(art, new Set());
    this.hoerer.get(art).add(fn);
    return () => { this.hoerer.get(art)?.delete(fn); };
  }

  starten() {
    if (this.laufend) return;
    this.laufend = true; this.versuch = 0; this.warVerbunden = false;
    this.dokument?.addEventListener?.('visibilitychange', this._sichtbarkeit);
    this._verbinden();
  }

  stoppen() {
    this.laufend = false;
    this._aufraeumen();
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; try { ws.close(1000); } catch { /* schon zu */ } }
    this._offeneAbbrechen();
    this._statusSetzen('getrennt');
  }

  /** Aufruf einer Chat-Aktion; ohne Verbindung wartet er höchstens 20 s, sonst E_AGENT. */
  aufrufen(aktion, params = {}) {
    return new Promise((ok, nein) => {
      if (!this.laufend) { nein(new ChatFehler('E_AGENT', 'Keine Chat-Verbindung')); return; }
      const eintrag = { aktion, params, ok, nein, timer: null };
      if (this._status === 'verbunden' && this._absenden(eintrag)) return;
      eintrag.timer = this.uhr.setTimeout(() => {
        this.schlange = this.schlange.filter((x) => x !== eintrag);
        nein(new ChatFehler('E_AGENT', 'Der Chat ist gerade nicht erreichbar'));
      }, WARTEN_MS);
      this.schlange.push(eintrag);
    });
  }

  /** Sendet ein Objekt, wenn verbunden; sonst false. */
  senden(obj) {
    if (this._status !== 'verbunden' || !this.ws) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  _absenden(eintrag) {
    const id = String(++this.zaehler);
    this.offen.set(id, eintrag);
    if (this.senden({ art: 'aufruf', id, aktion: eintrag.aktion, params: eintrag.params })) return true;
    this.offen.delete(id);
    return false;
  }

  _verbinden() {
    this.wiederTimer = null;
    if (!this.laufend) return;
    this._statusSetzen('verbinde');
    let ws;
    try { ws = new this.WebSocketKlasse(this.url); } catch { this._getrennt(1006); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.versuch = 0;
      this._statusSetzen('verbunden');
      this._sichtbarMelden();
      this.sichtbarTimer = this.uhr.setInterval(() => { if (this._sichtbarJa()) this._sichtbarMelden(); }, SICHTBAR_MS);
      const warten = this.schlange; this.schlange = [];
      for (const e of warten) {
        this.uhr.clearTimeout(e.timer);
        if (!this._absenden(e)) e.nein(new ChatFehler('E_AGENT', 'Der Chat ist gerade nicht erreichbar'));
      }
      if (this.warVerbunden) this._ausloesen('wieder');
      this.warVerbunden = true;
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this._empfangen(ev && ev.data); };
    ws.onclose = (ev) => { if (this.ws !== ws) return; this.ws = null; this._getrennt(ev && ev.code); };
    ws.onerror = () => { /* onclose folgt */ };
  }

  _getrennt(code) {
    if (this.sichtbarTimer !== null) { this.uhr.clearInterval(this.sichtbarTimer); this.sichtbarTimer = null; }
    this._offeneAbbrechen(false);
    if (this.endgueltig.has(code)) {
      this.laufend = false;
      this._aufraeumen();
      this._offeneAbbrechen();
      this._statusSetzen('beendet');
      this._ausloesen('beendet', { code });
      return;
    }
    this._statusSetzen('getrennt');
    if (!this.laufend) return;
    const ms = naechsteWartezeit(this.versuch); this.versuch += 1;
    this.wiederTimer = this.uhr.setTimeout(() => this._verbinden(), ms);
  }

  /** Bricht abgeschickte Aufrufe ab (ihre Antwort kommt nie); mit `schlange` auch die wartenden. */
  _offeneAbbrechen(schlange = true) {
    const fehler = () => new ChatFehler('E_AGENT', 'Die Chat-Verbindung wurde unterbrochen');
    const offen = [...this.offen.values()]; this.offen.clear();
    for (const e of offen) e.nein(fehler());
    if (!schlange) return;
    const warten = this.schlange; this.schlange = [];
    for (const e of warten) { this.uhr.clearTimeout(e.timer); e.nein(fehler()); }
  }

  _aufraeumen() {
    if (this.wiederTimer !== null) { this.uhr.clearTimeout(this.wiederTimer); this.wiederTimer = null; }
    if (this.sichtbarTimer !== null) { this.uhr.clearInterval(this.sichtbarTimer); this.sichtbarTimer = null; }
    this.dokument?.removeEventListener?.('visibilitychange', this._sichtbarkeit);
  }

  _empfangen(text) {
    let n;
    try { n = JSON.parse(text); } catch { return; }
    if (!n || typeof n !== 'object' || typeof n.art !== 'string') return;
    if (n.art === 'antwort') {
      const e = this.offen.get(n.id);
      if (!e) return;
      this.offen.delete(n.id);
      if (n.ok) e.ok(n.ergebnis);
      else e.nein(new ChatFehler((n.fehler && n.fehler.code) || 'E_UNBEKANNT', (n.fehler && n.fehler.meldung) || '', n.fehler && n.fehler.details));
      return;
    }
    this._ausloesen(n.art, n);
  }

  _sichtbarJa() { return !this.dokument || this.dokument.visibilityState !== 'hidden'; }

  _sichtbarMelden() { this.senden({ art: 'sichtbar', ja: this._sichtbarJa() }); }

  _statusSetzen(s) {
    if (s === this._status) return;
    this._status = s;
    this._ausloesen('status', s);
  }

  _ausloesen(art, daten) {
    for (const fn of [...(this.hoerer.get(art) || [])]) {
      try { fn(daten); } catch (e) { console.error(e); }
    }
  }
}

let einzelstueck = null;

/** Die eine Chat-Verbindung der Seite (Rahmen, Chat-Ansicht und Anrufe teilen sie). */
export function chatVerbindung() {
  if (!einzelstueck) einzelstueck = new ChatVerbindung({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/chat/ws` });
  return einzelstueck;
}
