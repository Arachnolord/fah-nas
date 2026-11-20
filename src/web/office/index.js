// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Dienst im Web (Plan 04, V12/V15): WebSocket /api/office/ws für angemeldete Nutzer (Sitzung ohne offene 2FA,
// gleiche Herkunft, höchstens 10 je Nutzer) – öffnen, Ops, Auswahl, Wiederaufnahme, schließen – über das Register
// offener Dokumente; Datei-Endpunkte für Bilder und Anhänge im Bündel; Abschluss-Haken speichert alles vor dem Stopp.
// Agent-Ereignisse „office“ (Rechte, Pfad, gelöscht) kommen nur hier an, nie über SSE (V7).

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { kennung } from '../../gemeinsam/protokoll.js';
import { wsAnnehmen, upgradeAblehnen, herkunftGleich } from '../ws.js';
import { clientIp } from '../bremse.js';
import { json, detailsFuerRolle } from '../server.js';
import { inhaltslaenge } from '../api/dateien.js';
import { DokumentRegister, ANWESEND_FARBEN } from './dokumente.js';
import { DATEI_MUSTER } from '../../../public/gemeinsam/sync/konstanten.js';

export { ANWESEND_FARBEN };
export const WS_PFAD = '/api/office/ws';
export const MAX_NACHRICHT = 8 * 1024 * 1024;
export const MAX_SOCKETS = 10;

const ID = /^o[A-Za-z0-9_-]{16}$/;
const FREIGABE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CACHE_DAUERHAFT = 'private, max-age=31536000, immutable'; // Dateien im Bündel ändern sich nie (neuer Name je Datei)

export class OfficeDienst {
  constructor({ agent, auth, sitzungen, protokoll = null, dateien, uhr, vertrauteProxys = () => null }) {
    this.agent = agent; this.auth = auth; this.sitzungen = sitzungen; this.protokoll = protokoll; this.dateien = dateien; this.vertrauteProxys = vertrauteProxys;
    this.register = new DokumentRegister({ agent, protokoll, ...(uhr ? { uhr } : {}) });
    this.sockets = new Set(); // {nutzer, sitzungId, anzeigename, ip, ws, doks: Map dok → kid}
    this._beiEreignis = (e) => {
      if (!e) return;
      if (e.ereignis === 'office') this._ereignis(e);
      // Freigabe-Rechte oder Konten geändert: Rechte aller offenen Dokumente neu prüfen (Prüfbericht Plan 04, I1)
      else if (e.ereignis === 'konfig' && (e.bereich === 'freigaben' || e.bereich === 'nutzer')) this.register.alleRechtePruefen().then(() => this._aufraeumen()).catch(() => {});
    };
    this._beiBeendet = ({ id }) => { for (const v of this.sockets) if (v.sitzungId === id) v.ws.schliessen(4001, 'abgemeldet'); };
    agent.on('ereignis', this._beiEreignis);
    sitzungen.on('beendet', this._beiBeendet);
  }

  // ---- HTTP -------------------------------------------------------------------------------------------------------

  routen(router) {
    router.add('GET', '/api/office/datei', { sitzung: 'voll' }, async (ctx) => {
      const id = ctx.query.get('id') || ''; const datei = ctx.query.get('datei') || '';
      if (!ID.test(id) || !DATEI_MUSTER.test(datei)) throw new FahnasFehler('E_PARAMS', 'Dokument oder Datei ungültig');
      const t = await this.agent.aktion('office.datei_lesen', { id, datei }, ctx.kontext);
      await this.dateien.herunterladen(ctx, t, { anzeigen: true, nutzer: ctx.kontext.nutzer, range: ctx.req.headers.range || null, cache: CACHE_DAUERHAFT });
    });
    router.add('POST', '/api/office/hochladen', { sitzung: 'voll', csrf: true }, async (ctx) => {
      const id = ctx.query.get('id') || ''; const name = ctx.query.get('name') || '';
      if (!ID.test(id) || !name || name.length > 200) throw new FahnasFehler('E_PARAMS', 'Dokument oder Dateiname ungültig', { feld: !ID.test(id) ? 'id' : 'name' });
      const groesse = inhaltslaenge(ctx.req);
      const t = await this.agent.aktion('office.datei_ticket', { id, name, groesse }, ctx.kontext);
      const erg = await this.dateien._hochladenStrom(ctx, t.ticket, ctx.kontext.nutzer);
      if (!erg.ergebnis) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst bestätigte die Datei nicht');
      json(ctx.res, 200, { ok: true, ergebnis: erg.ergebnis });
    });
  }

  // ---- WebSocket --------------------------------------------------------------------------------------------------

  async upgrade(req, socket, kopf) {
    socket.on('error', () => {});
    if (!herkunftGleich(req)) return upgradeAblehnen(socket, 403, 'Forbidden');
    const s = await this.auth.sitzungAus(req).catch(() => null);
    if (!s || s.totp_offen) return upgradeAblehnen(socket, 401, 'Unauthorized');
    if ([...this.sockets].filter((v) => v.nutzer === s.nutzer).length >= MAX_SOCKETS) return upgradeAblehnen(socket, 429, 'Too Many Requests');
    const ws = wsAnnehmen(req, socket, kopf, { max_nachricht: MAX_NACHRICHT });
    if (!ws) return undefined;
    const v = { nutzer: s.nutzer, sitzungId: s.id, anzeigename: s.anzeigename || s.nutzer, ip: clientIp(req, this.vertrauteProxys()), ws, doks: new Map() };
    this.sockets.add(v);
    ws.on('nachricht', (n) => { this._nachricht(v, n).catch((e) => this.protokoll?.eintrag?.('office_fehler', { meldung: e && e.message })); });
    ws.on('zu', () => {
      this.sockets.delete(v);
      for (const [dok, kid] of v.doks) this.register.schliessen(dok, kid);
      v.doks.clear();
    });
    return v;
  }

  _ref(ref) {
    if (!ref || typeof ref !== 'object') return null;
    if (typeof ref.id === 'string') return ID.test(ref.id) ? { id: ref.id } : null;
    if (typeof ref.freigabe === 'string' && FREIGABE.test(ref.freigabe) && typeof ref.pfad === 'string' && ref.pfad && ref.pfad.length <= 4096) return { freigabe: ref.freigabe, pfad: ref.pfad };
    return null;
  }

  _fehlerText(e, rolle) {
    const { details } = detailsFuerRolle(e && e.details, rolle);
    return { code: (e && e.code) || 'E_UNBEKANNT', meldung: (e && (e.meldung || e.message)) || 'Fehler', ...(details ? { details } : {}) };
  }

  _klient(v, kontext) { return { kid: kennung('k'), kontext, name: v.anzeigename, senden: (o) => v.ws.senden(o) }; }

  /** Diese Verbindung hat das Dokument schon offen: die alte Anmeldung aufgeben (ein Klient je Dokument und Verbindung). */
  _merken(v, dok, kid) {
    const alt = v.doks.get(dok);
    if (alt && alt !== kid) this.register.schliessen(dok, alt);
    v.doks.set(dok, kid);
  }

  async _nachricht(v, n) {
    const rolle = this.sitzungen.rolleVon(v.sitzungId);
    if (!rolle) { v.ws.schliessen(4001, 'abgemeldet'); return; }
    const kontext = { nutzer: v.nutzer, rolle, ip: v.ip };
    const kid = typeof n.dok === 'string' ? v.doks.get(n.dok) : undefined;
    switch (n.art) {
      case 'oeffnen': {
        const ref = this._ref(n.ref);
        if (!ref) { v.ws.senden({ art: 'fehler', anfrage: n.anfrage, fehler: { code: 'E_PARAMS', meldung: 'Dokument ungültig' } }); return; }
        const klient = this._klient(v, kontext);
        try {
          const { dok, recht, anwesend } = await this.register.oeffnen(ref, klient);
          this._merken(v, dok.meta.id, klient.kid);
          const m = dok.meta;
          v.ws.senden({
            art: 'geoeffnet', anfrage: n.anfrage, kid: klient.kid, anwesend,
            dok: { id: m.id, art: m.art, name: m.name, freigabe: m.freigabe, pfad: m.pfad, recht, besitzer: m.besitzer, version: dok.version, daten: dok.daten, schnappschuesse: m.schnappschuesse },
          });
        } catch (e) { v.ws.senden({ art: 'fehler', anfrage: n.anfrage, fehler: this._fehlerText(e, rolle) }); }
        return;
      }
      case 'op':
        // nicht (mehr) angemeldet – auch, wenn das Register das Dokument inzwischen entladen hat: Antwort statt Stille
        if (!kid || !this.register.op(n.dok, kid, { basis: n.basis, cid: n.cid, op: n.op })) {
          if (kid) v.doks.delete(n.dok);
          v.ws.senden({ art: 'fehler', dok: n.dok, cid: n.cid, fehler: { code: 'E_NICHT_GEFUNDEN', meldung: 'Dieses Dokument ist nicht geöffnet' } });
        }
        return;
      case 'auswahl':
        if (kid) this.register.auswahl(n.dok, kid, { version: n.version, auswahl: n.auswahl });
        return;
      case 'wiederaufnehmen': {
        const ref = this._ref(n.ref) || (typeof n.dok === 'string' ? this._ref({ id: n.dok }) : null);
        if (!ref) { v.ws.senden({ art: 'fehler', dok: n.dok, fehler: { code: 'E_PARAMS', meldung: 'Dokument ungültig' } }); return; }
        const klient = this._klient(v, kontext);
        try {
          const antwort = await this.register.wiederaufnehmen(ref, n.version, klient);
          if (antwort.art === 'wiederaufgenommen') this._merken(v, antwort.dok, klient.kid);
          v.ws.senden(antwort);
        } catch (e) { v.ws.senden({ art: 'fehler', dok: n.dok, fehler: this._fehlerText(e, rolle) }); }
        return;
      }
      case 'schliessen':
        if (kid) { this.register.schliessen(n.dok, kid); v.doks.delete(n.dok); }
        return;
      case 'sichtbar':
        return; // sendet die wiederverwendete ChatVerbindung von selbst – hier ohne Bedeutung
      default:
        v.ws.senden({ art: 'fehler', fehler: { code: 'E_PARAMS', meldung: `Unbekannte Nachricht „${String(n.art).slice(0, 40)}“` } });
    }
  }

  /** Agent-Ereignis office: Rechte neu prüfen, Pfad nachführen, gelöscht. */
  _ereignis(e) {
    if (typeof e.id !== 'string') return;
    if (e.art === 'rechte') {
      this.register.rechtePruefen(e.id).then(() => this._aufraeumen()).catch(() => {});
    } else if (e.art === 'pfad') this.register.pfadGeaendert(e.id, { name: e.name, pfad: e.pfad, freigabe: e.freigabe }).then(() => this._aufraeumen()).catch(() => {});
    else if (e.art === 'geloescht') { this.register.geloescht(e.id); this._aufraeumen(); }
  }

  /** Anmeldungen, die das Register nicht mehr kennt (Recht entzogen, gelöscht), aus den Verbindungen streichen. */
  _aufraeumen() {
    for (const v of this.sockets) for (const [dok, kid] of v.doks) { const e = this.register.offen.get(dok); if (!e || !e.klienten.has(kid)) v.doks.delete(dok); }
  }

  /** V15: alles Ungespeicherte schreiben (vor agent.stoppen()). */
  async abschliessen() { await this.register.alleSpeichern(); }

  stoppen() {
    this.agent.off('ereignis', this._beiEreignis);
    this.sitzungen.off('beendet', this._beiBeendet);
    for (const v of [...this.sockets]) v.ws.schliessen(1001, 'herunterfahren');
    this.register.stoppen();
  }
}
