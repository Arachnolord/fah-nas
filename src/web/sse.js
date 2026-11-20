// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Server-Sent Events: GET /api/ereignisse (Sitzung nötig). Jede Sekunde „messwerte“, Agent-Ereignisse
// (aufgabe nur an Besitzer oder Admins; konfig/system an alle), „agent“ verbunden/getrennt, Heartbeat alle 15 s.
// Die Rolle wird beim SENDEN aus der Sitzung gelesen (eine Herabstufung wirkt sofort, nicht erst beim Neuverbinden);
// Fehlerdetails in Aufgaben-Ereignissen gehen ungekürzt nur an Admins. Verbindungen einer Sitzung werden bei
// Abmeldung/Ablauf geschlossen. GET /api/messwerte/verlauf → Ringpuffer.

import { json, detailsFuerRolle } from './server.js';

const MAX_RUECKSTAND = 1024 * 1024; // langsame Empfänger (1 MB ungesendet) werden getrennt
/** Agent-Ereignisse mit privaten Inhalten (Chat, Office) gehen nie über SSE – der Chat/Office-Dienst verteilt sie gezielt (V7). */
export const PRIVATE_EREIGNISSE = Object.freeze(new Set(['chat', 'office']));

function textFuer(art, daten) { return `event: ${art}\ndata: ${JSON.stringify(daten)}\n\n`; }

/** Aufgaben-Ereignis für Nicht-Admins: `fehler.details` auf die Whitelist gekürzt (Prüfbericht R1, Fund 14). */
export function aufgabeFuerNutzer(daten) {
  if (!daten || !daten.fehler || typeof daten.fehler !== 'object' || daten.fehler.details === undefined) return daten;
  const { details } = detailsFuerRolle(daten.fehler.details, 'nutzer');
  const fehler = { ...daten.fehler };
  if (details === undefined) delete fehler.details; else fehler.details = details;
  return { ...daten, fehler };
}

export class Ereignisse {
  constructor({ messwerte, agent, sitzungen, heartbeat_ms = 15_000 }) {
    this.messwerte = messwerte; this.agent = agent; this.sitzungen = sitzungen; this.heartbeat_ms = heartbeat_ms;
    this.verbindungen = new Set(); this.timer = null;
    this._beiMesswerte = (m) => this.senden('messwerte', m);
    this._beiEreignis = (e) => this.weiterleiten(e);
    this._beiVerbunden = () => this.senden('agent', { zustand: 'verbunden' });
    this._beiGetrennt = () => this.senden('agent', { zustand: 'getrennt' });
    this._beiBeendet = ({ id }) => this.schliesseSitzung(id);
  }

  starten() {
    if (this.timer) return;
    this.messwerte.on('messwerte', this._beiMesswerte);
    this.agent.on('ereignis', this._beiEreignis);
    this.agent.on('verbunden', this._beiVerbunden);
    this.agent.on('getrennt', this._beiGetrennt);
    this.sitzungen.on('beendet', this._beiBeendet);
    this.timer = setInterval(() => this.roh(': heartbeat\n\n'), this.heartbeat_ms);
    this.timer.unref();
  }

  /** Hängt eine Anfrage als Ereignisstrom an. */
  verbinden(ctx) {
    const { req, res, sitzung } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const v = { res, sitzungId: sitzung.id, nutzer: sitzung.nutzer, rolle: sitzung.rolle };
    this.verbindungen.add(v);
    const weg = () => this.verbindungen.delete(v);
    req.on('close', weg); res.on('close', weg); res.on('error', weg);
    res.write(`retry: 3000\n\nevent: agent\ndata: ${JSON.stringify({ zustand: this.agent.verbunden ? 'verbunden' : 'getrennt' })}\n\n`);
    if (this.messwerte.aktuell) this._schreiben(v, textFuer('messwerte', this.messwerte.aktuell));
  }

  /** Rolle beim Senden aus der Sitzung (Herabstufung wirkt sofort). null = Sitzung gibt es nicht mehr. */
  rolleVon(v) {
    if (this.sitzungen && typeof this.sitzungen.rolleVon === 'function') {
      const r = this.sitzungen.rolleVon(v.sitzungId);
      if (r !== null) v.rolle = r;
      return r;
    }
    return v.rolle;
  }

  _schreiben(v, text) {
    if (v.res.destroyed || v.res.writableEnded) { this.verbindungen.delete(v); return; }
    if (v.res.writableLength > MAX_RUECKSTAND) { this.verbindungen.delete(v); v.res.destroy(); return; }
    try { v.res.write(text); } catch { this.verbindungen.delete(v); }
  }

  roh(text) { for (const v of [...this.verbindungen]) this._schreiben(v, text); }

  /** Sendet ein Ereignis an alle Verbindungen, die `filter(v)` bestehen (Standard: alle). */
  senden(art, daten, filter) {
    const text = textFuer(art, daten);
    for (const v of [...this.verbindungen]) if (!filter || filter(v)) this._schreiben(v, text);
  }

  /** Agent-Ereignis → SSE. Aufgaben nur an den Besitzer oder Admins (Details gekürzt für Nicht-Admins), alles andere an alle. */
  weiterleiten(e) {
    if (e && PRIVATE_EREIGNISSE.has(e.ereignis)) return;
    if (!e || typeof e.ereignis !== 'string') return;
    const { ereignis, ...daten } = e;
    if (ereignis === 'aufgabe') {
      const voll = textFuer('aufgabe', daten);
      let gekuerzt = null; // erst bauen, wenn ein Nicht-Admin es braucht
      for (const v of [...this.verbindungen]) {
        const rolle = this.rolleVon(v);
        if (rolle === 'admin') this._schreiben(v, voll);
        else if (rolle !== null && v.nutzer === e.nutzer) this._schreiben(v, gekuerzt || (gekuerzt = textFuer('aufgabe', aufgabeFuerNutzer(daten))));
      }
      return;
    }
    if (ereignis === 'konfig' || ereignis === 'system') return this.senden(ereignis, daten, (v) => this.rolleVon(v) !== null);
    // unbekannte Arten werden ebenfalls durchgereicht (spätere Teilprojekte), aber nur an Admins
    this.senden(ereignis, daten, (v) => this.rolleVon(v) === 'admin');
  }

  schliesseSitzung(id) { for (const v of [...this.verbindungen]) if (v.sitzungId === id) { this.verbindungen.delete(v); try { v.res.end(); } catch { /* egal */ } } }

  schliesseNutzer(nutzer) { for (const v of [...this.verbindungen]) if (v.nutzer === nutzer) { this.verbindungen.delete(v); try { v.res.end(); } catch { /* egal */ } } }

  stoppen() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.messwerte.off('messwerte', this._beiMesswerte);
    this.agent.off('ereignis', this._beiEreignis);
    this.agent.off('verbunden', this._beiVerbunden);
    this.agent.off('getrennt', this._beiGetrennt);
    this.sitzungen.off('beendet', this._beiBeendet);
    for (const v of [...this.verbindungen]) { try { v.res.end(); } catch { /* egal */ } }
    this.verbindungen.clear();
  }
}

/** Routen: /api/ereignisse (SSE) und /api/messwerte/verlauf. */
export function registriere(router, { ereignisse, messwerte }) {
  router.add('GET', '/api/ereignisse', { sitzung: 'voll' }, (ctx) => ereignisse.verbinden(ctx));
  router.add('GET', '/api/messwerte/verlauf', { sitzung: 'voll' }, (ctx) => json(ctx.res, 200, { ok: true, ergebnis: messwerte.verlauf() }));
  router.add('GET', '/api/messwerte', { sitzung: 'voll' }, (ctx) => json(ctx.res, 200, { ok: true, ergebnis: messwerte.aktuell }));
}
