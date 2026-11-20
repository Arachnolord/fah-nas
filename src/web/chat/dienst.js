// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Dienst im Web-Dienst (Plan 02): JSON-WebSocket /api/chat/ws für NAS-Nutzer (Sitzung) und Gäste (Keks).
// Aufrufe gehen nur über Freigabelisten an den Agenten; `aktiv` (wer gerade hinschaut, keine Handy-Meldung) und den
// Gast-Ausweis setzt immer der Server. Agent-Ereignisse `chat` gehen nur an die genannten Empfänger; Gäste bekommen die
// Fassung ohne Login-Namen. Haken für Anrufe (Plan 03): handler('anruf.*', fn) und Ereignis 'weg' beim Schließen.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { wsAnnehmen, upgradeAblehnen, herkunftGleich } from '../ws.js';
import { clientIp } from '../bremse.js';
import { gastKontext } from '../api/anmelden.js';
import { detailsFuerRolle } from '../server.js';
import { GastPruefer, identitaetAus, gastSichtName } from './identitaet.js';
import { Verteiler } from './verteiler.js';
import { chatHttpRouten } from './http.js';

export const WS_PFAD = '/api/chat/ws';
export const NUTZER_AKTIONEN = Object.freeze(new Set([
  'chat.uebersicht', 'chat.verlauf', 'chat.senden', 'chat.bearbeiten', 'chat.loeschen', 'chat.reaktion', 'chat.gelesen', 'chat.suche',
  'chat.raum.anlegen', 'chat.raum.aendern', 'chat.raum.mitglieder', 'chat.raum.loeschen', 'chat.dm.oeffnen', 'chat.anhang.speichern',
  'chat.anhang.aus_nas', 'chat.einladung.anlegen', 'chat.einladung.liste', 'chat.einladung.loeschen', 'chat.einladung.annehmen', 'chat.gast.entfernen',
  'chat.personen',
]));
export const GAST_ABBILDUNG = Object.freeze({
  'chat.verlauf': 'chat.gast.verlauf', 'chat.senden': 'chat.gast.senden', 'chat.loeschen': 'chat.gast.loeschen',
  'chat.reaktion': 'chat.gast.reaktion', 'chat.gelesen': 'chat.gast.gelesen', 'chat.gast.verlassen': 'chat.gast.verlassen',
});
const NAME = /^[a-z]+(\.[a-z_]+)+$/;
const MAX_SOCKETS = { nutzer: 10, gast: 3 };
const AUFRUFE = { anzahl: 50, fenster_ms: 10_000 };
/** Alle eingehenden Nachrichten je Verbindung (tippt, sichtbar, anruf.* …): mehr → 1008 (Prüfbericht Plan 02, Befund 8). */
const NACHRICHTEN = { anzahl: 200, fenster_ms: 10_000 };
const TIPPT_MS = 2_000;
const EMPFAENGER_MS = 30_000;
const RAUM = /^(r[A-Za-z0-9_-]{16}|d[A-Za-z0-9_-]{20})$/;

export class ChatDienst extends EventEmitter {
  constructor({ agent, auth, sitzungen, bremse = null, protokoll = null, dateien = null, vertrauteProxys = () => null, secure = true }) {
    super();
    this.agent = agent; this.auth = auth; this.sitzungen = sitzungen; this.bremse = bremse; this.protokoll = protokoll; this.dateien = dateien;
    this.vertrauteProxys = vertrauteProxys; this.secure = secure;
    this.pruefer = new GastPruefer({ agent });
    this.verteiler = new Verteiler();
    this.haken = new Map();
    this._trennung = new Set(); // Haken nach dem Schließen einer Verbindung (Anrufe)
    this.empfaengerCache = new Map();
    this.onlineZuletzt = '';
    this.onlineTimer = null;
    this._beiEreignis = (e) => { if (e && e.ereignis === 'chat') this._chatEreignis(e); };
    this._beiBeendet = ({ id }) => {
      for (const v of this.verteiler.alle()) if (v.identitaet.art === 'nutzer' && v.identitaet.sitzungId === id) v.ws.schliessen(4001, 'abgemeldet');
    };
  }

  /** HTTP-Routen: Einladungsseite, Gast-Beitritt/-Abmelden, Anhänge lesen und hochladen. */
  routen(router) { chatHttpRouten(router, this); }

  starten() {
    this.agent.on('ereignis', this._beiEreignis);
    this.sitzungen.on('beendet', this._beiBeendet);
  }

  stoppen() {
    this.agent.off('ereignis', this._beiEreignis);
    this.sitzungen.off('beendet', this._beiBeendet);
    if (this.onlineTimer) { clearTimeout(this.onlineTimer); this.onlineTimer = null; }
    for (const v of this.verteiler.alle()) v.ws.schliessen(1001, 'herunterfahren');
  }

  /** Haken für Anrufe: nur Arten mit der Vorsilbe 'anruf.'; fn(verbindung, nachricht). */
  handler(art, fn) {
    if (!String(art).startsWith('anruf.')) throw new Error(`Chat-Haken nur für anruf.*, nicht ${art}`);
    this.haken.set(art, fn);
  }

  /** fn(verbindung) nach dem Abmelden einer geschlossenen Verbindung; gibt die Abmeldung zurück. */
  beiTrennung(fn) { this._trennung.add(fn); return () => this._trennung.delete(fn); }

  senden(empfaenger, obj, optionen) { this.verteiler.senden(empfaenger, obj, optionen); }

  /** Empfänger eines Raums (30 s aus den Ereignissen zwischengespeichert, sonst vom Agenten). */
  async empfaenger(identitaet, raum) {
    const c = this.empfaengerCache.get(raum);
    if (c && c.bis > Date.now()) {
      const darf = identitaet.art === 'nutzer' ? c.an.nutzer.includes(identitaet.nutzer) : c.an.gaeste.includes(identitaet.gast);
      if (darf) return c.an;
    }
    const an = identitaet.art === 'nutzer'
      ? await this.agent.aktion('chat.empfaenger', { raum }, { nutzer: identitaet.nutzer, rolle: identitaet.rolle, ip: '-' })
      : await this.agent.aktion('chat.gast.empfaenger', { raum, ausweis: identitaet.ausweis }, gastKontext('-'));
    this.empfaengerCache.set(raum, { an, bis: Date.now() + EMPFAENGER_MS });
    return an;
  }

  async upgrade(req, socket, kopf) {
    socket.on('error', () => {});
    if (!herkunftGleich(req)) return upgradeAblehnen(socket, 403, 'Forbidden');
    const ip = clientIp(req, this.vertrauteProxys());
    const identitaet = await identitaetAus(req, { auth: this.auth, pruefer: this.pruefer, ip }).catch(() => null);
    if (!identitaet) return upgradeAblehnen(socket, 401, 'Unauthorized');
    const offen = identitaet.art === 'nutzer' ? this.verteiler.fuerNutzer(identitaet.nutzer) : this.verteiler.fuerGast(identitaet.gast);
    if (offen.length >= MAX_SOCKETS[identitaet.art]) return upgradeAblehnen(socket, 429, 'Too Many Requests');
    const ws = wsAnnehmen(req, socket, kopf);
    if (!ws) return undefined;
    const v = { id: crypto.randomUUID(), identitaet, ws, ip, sichtbarSeit: null, aufrufe: [], eingang: [], tipptZuletzt: 0 };
    this.verteiler.anmelden(v);
    ws.on('nachricht', (n) => { this._nachricht(v, n).catch((e) => { this.protokoll?.eintrag?.('chat_fehler', { meldung: e.message }); }); });
    ws.on('zu', () => {
      this.verteiler.abmelden(v);
      for (const fn of this._trennung) { try { fn(v); } catch (e) { this.protokoll?.eintrag?.('chat_fehler', { meldung: e.message }); } }
      if (identitaet.art === 'nutzer') this._onlineGeaendert();
      this.emit('weg', v);
    });
    if (identitaet.art === 'nutzer') { ws.senden({ art: 'online', nutzer: this.verteiler.online() }); this._onlineGeaendert(); }
    return v;
  }

  /** Online-Liste an alle NAS-Sockets, entprellt (1 s), nur bei Änderung. */
  _onlineGeaendert() {
    if (this.onlineTimer) return;
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      const liste = this.verteiler.online();
      const k = liste.join(',');
      if (k === this.onlineZuletzt) return;
      this.onlineZuletzt = k;
      this.verteiler.senden({ nutzer: liste }, { art: 'online', nutzer: liste });
    }, 1000);
    this.onlineTimer.unref?.();
  }

  async _nachricht(v, n) {
    const { identitaet, ws } = v;
    const jetzt = Date.now();
    v.eingang = v.eingang.filter((t) => jetzt - t < NACHRICHTEN.fenster_ms);
    if (v.eingang.length >= NACHRICHTEN.anzahl) { ws.schliessen(1008, 'flut'); return undefined; }
    v.eingang.push(jetzt);
    if (n.art === 'aufruf') return this._aufruf(v, n);
    if (n.art === 'sichtbar') { this.verteiler.sichtbar(v, n.ja === true); return undefined; }
    if (n.art === 'tippt') return this._tippt(v, n);
    if (n.art.startsWith('anruf.') && this.haken.has(n.art)) return this.haken.get(n.art)(v, n);
    ws.senden({ art: 'fehler', fehler: { code: 'E_PARAMS', meldung: `Unbekannte Nachricht „${String(n.art).slice(0, 40)}“` } });
    void identitaet;
    return undefined;
  }

  async _aufruf(v, n) {
    const { identitaet, ws } = v;
    const id = n.id;
    const fehler = (code, meldung, details) => ws.senden({ art: 'antwort', id, ok: false, fehler: { code, meldung, ...(details ? { details } : {}) } });
    if (typeof id !== 'string' || id.length > 64 || typeof n.aktion !== 'string' || !NAME.test(n.aktion) || (n.params !== undefined && (typeof n.params !== 'object' || n.params === null || Array.isArray(n.params)))) {
      ws.senden({ art: 'fehler', fehler: { code: 'E_PARAMS', meldung: 'Ungültiger Aufruf' } });
      return;
    }
    const jetzt = Date.now();
    v.aufrufe = v.aufrufe.filter((t) => jetzt - t < AUFRUFE.fenster_ms);
    if (v.aufrufe.length >= AUFRUFE.anzahl) {
      fehler('E_BREMSE', 'Zu viele Aufrufe – bitte kurz warten', { warte_s: Math.max(1, Math.ceil((v.aufrufe[0] + AUFRUFE.fenster_ms - jetzt) / 1000)) });
      return;
    }
    v.aufrufe.push(jetzt);
    const params = { ...(n.params || {}) };
    let aktion; let kontext; let rolle;
    if (identitaet.art === 'nutzer') {
      rolle = this.sitzungen.rolleVon(identitaet.sitzungId);
      if (!rolle) { ws.schliessen(4001, 'abgemeldet'); return; }
      if (!NUTZER_AKTIONEN.has(n.aktion)) { fehler('E_RECHTE', 'Diese Aktion ist im Chat nicht erlaubt'); return; }
      aktion = n.aktion;
      if (aktion === 'chat.senden') params.aktiv = this.verteiler.aktive();
      kontext = { nutzer: identitaet.nutzer, rolle, ip: v.ip };
    } else {
      rolle = 'gast';
      aktion = GAST_ABBILDUNG[n.aktion];
      if (!aktion) { fehler('E_RECHTE', 'Diese Aktion ist für Gäste nicht erlaubt'); return; }
      params.ausweis = identitaet.ausweis;
      if (aktion === 'chat.gast.senden') params.aktiv = this.verteiler.aktive();
      kontext = gastKontext(v.ip);
    }
    try {
      const ergebnis = await this.agent.aktion(aktion, params, kontext);
      ws.senden({ art: 'antwort', id, ok: true, ergebnis: ergebnis === undefined ? null : ergebnis });
    } catch (e) {
      const { details } = detailsFuerRolle(e && e.details, rolle);
      fehler((e && e.code) || 'E_UNBEKANNT', (e && (e.meldung || e.message)) || 'Fehler', details);
    }
  }

  async _tippt(v, n) {
    const { identitaet } = v;
    if (typeof n.raum !== 'string' || !RAUM.test(n.raum)) return;
    if (identitaet.art === 'gast' && n.raum !== identitaet.raum) return; // Gäste tippen nur in ihrem Raum
    // höchstens ein „tippt“ je 2 s und Verbindung – auch erfundene Raum-IDs lösen so keine Agent-Flut aus (Befund 8)
    const jetzt = Date.now();
    if (jetzt - v.tipptZuletzt < TIPPT_MS) return;
    v.tipptZuletzt = jetzt;
    let an;
    try { an = await this.empfaenger(identitaet, n.raum); } catch { return; }
    const ich = identitaet.art === 'nutzer' ? identitaet.nutzer : `gast:${identitaet.gast}`;
    const name = identitaet.art === 'nutzer' ? identitaet.anzeigename : identitaet.name;
    const ausser = (x) => (identitaet.art === 'nutzer' ? x.identitaet.art === 'nutzer' && x.identitaet.nutzer === identitaet.nutzer : x.identitaet.art === 'gast' && x.identitaet.gast === identitaet.gast);
    this.verteiler.senden({ nutzer: an.nutzer || [] }, { art: 'tippt', raum: n.raum, wer: ich, name }, { ausser });
    this.verteiler.senden({ gaeste: an.gaeste || [] }, { art: 'tippt', raum: n.raum, wer: identitaet.art === 'gast' ? ich : null, name: gastSichtName(identitaet) }, { ausser });
  }

  _chatEreignis(e) {
    const { raum, art, daten, daten_gast: datenGast, an } = e;
    if (!an || typeof raum !== 'string') return;
    if (!e.teil) this.empfaengerCache.set(raum, { an: { nutzer: an.nutzer || [], gaeste: an.gaeste || [] }, bis: Date.now() + EMPFAENGER_MS }); // Teillisten nie als „alle“ merken
    this.verteiler.senden({ nutzer: an.nutzer || [] }, { art: 'chat', raum, ereignis: art, daten });
    this.verteiler.senden({ gaeste: an.gaeste || [] }, { art: 'chat', raum, ereignis: art, daten: datenGast ?? daten });
    if (art === 'gast_entfernt' && daten && daten.gast) {
      this.pruefer.verwerfen({ gast: daten.gast });
      for (const v of this.verteiler.fuerGast(daten.gast)) v.ws.schliessen(4003, 'entfernt');
    }
    if (art === 'raum_weg') {
      this.pruefer.verwerfen({ raum });
      this.empfaengerCache.delete(raum);
      // Nur die genannten Gäste sind raus (Raum gelöscht); tritt bloß ein Mitglied aus, bleiben die Gäste verbunden
      const raus = new Set(an.gaeste || []);
      for (const v of this.verteiler.alle()) if (v.identitaet.art === 'gast' && v.identitaet.raum === raum && raus.has(v.identitaet.gast)) v.ws.schliessen(4003, 'raum_weg');
    }
  }
}
