// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Steuerung des STUN/TURN-Dienstes im Web-Prozess (Plan 03): fragt den Agenten (chat.turn_info: LAN-IP, an/aus, Port),
// startet bzw. startet neu, wenn sich die Chat-Einstellungen ändern oder der Agent wieder da ist, und gibt Browsern
// ICE-Zugänge (12 h gültig). Merkt sich, wann zuletzt jemand von außen einen Relay-Port bekam (für die Admin-Karte).

import { gastKontext } from '../api/anmelden.js';
import { TurnDienst } from './turn.js';
import { REALM, geheimnisLaden, externMerken, zugangsdaten, werVon, iceServer, GUELTIG_S } from './zugang.js';

export const INFO_MS = 300_000;
export const EXTERN_SCHREIBEN_MS = 600_000;

export class TurnSteuerung {
  constructor({ agent, ordner, protokoll = null, linkAdresse = null, TurnKlasse = TurnDienst, portFest = null, relayVon = 49160, relayBis = 49200, jetzt = () => Date.now() }) {
    this.agent = agent; this.ordner = ordner; this.protokoll = protokoll; this.linkAdresse = linkAdresse; this.TurnKlasse = TurnKlasse;
    this.portFest = portFest; this.relayVon = relayVon; this.relayBis = relayBis; this.jetzt = jetzt;
    this.geheimnis = null; this.dienst = null; this.laufend = null; // laufend = {port, relayIp}
    this.entzogen = new Map(); // wer → Zeitpunkt (ms) des Entzugs; geht an jeden neu gestarteten Dienst
    this.infoStand = null; this.infoZeit = 0; this.letzteInfo = null; this.fehler = null;
    this.externZuletzt = null; this.externGeschrieben = 0;
    this.kette = Promise.resolve();
    this._beiVerbunden = () => { this.neuLaden(); };
    this._beiEreignis = (e) => { if (e && e.ereignis === 'konfig' && e.bereich === 'chat') this.neuLaden(); };
  }

  async starten() {
    const g = await geheimnisLaden(this.ordner);
    this.geheimnis = g.geheimnis; this.externZuletzt = g.extern_zuletzt;
    this.agent.on('verbunden', this._beiVerbunden);
    this.agent.on('ereignis', this._beiEreignis);
    await this.neuLaden();
  }

  async stoppen() {
    this.agent.off('verbunden', this._beiVerbunden);
    this.agent.off('ereignis', this._beiEreignis);
    await this.kette;
    await this._dienstStoppen();
  }

  /** Neu einlesen und den Dienst anpassen – nie zwei Läufe gleichzeitig. */
  neuLaden() {
    const lauf = this.kette.then(() => this._neuLaden());
    this.kette = lauf.catch(() => {});
    return this.kette;
  }

  /** Auskunft des Agenten (300 s zwischengespeichert). Scheitert sie, wirft sie. */
  async info() {
    const jetzt = this.jetzt();
    if (this.infoStand && jetzt - this.infoZeit < INFO_MS) return this.infoStand;
    const i = await this.agent.aktion('chat.turn_info', {}, gastKontext('-'));
    this.infoStand = { lan_ip: (i && i.lan_ip) || null, aktiv: !!(i && i.aktiv), port: (i && i.port) || 3478 };
    this.infoZeit = jetzt; this.letzteInfo = this.infoStand;
    return this.infoStand;
  }

  async _neuLaden() {
    this.infoStand = null;
    let i;
    try { i = await this.info(); } catch {
      this.fehler = 'agent';
      this.protokoll?.eintrag?.('turn', { fehler: 'agent' });
      return;
    }
    if (!i.aktiv) { this.fehler = null; await this._dienstStoppen(); return; }
    if (!i.lan_ip) { this.fehler = 'keine_lan_ip'; await this._dienstStoppen(); this.protokoll?.eintrag?.('turn', { fehler: 'keine_lan_ip' }); return; }
    const port = this.portFest ?? i.port;
    if (this.dienst && this.laufend && this.laufend.port === port && this.laufend.relayIp === i.lan_ip) { this.fehler = null; return; }
    await this._dienstStoppen();
    const d = new this.TurnKlasse({ port, relayVon: this.relayVon, relayBis: this.relayBis, realm: REALM, geheimnis: this.geheimnis, relayIp: i.lan_ip, protokoll: this.protokoll });
    d.on('zuteilung', (z) => this._zuteilung(z));
    for (const [wer, ab] of this.entzogen) d.zugangEntziehen(wer, ab);
    try {
      const echt = await d.starten();
      this.dienst = d; this.laufend = { port: echt ?? port, relayIp: i.lan_ip }; this.fehler = null;
      this.protokoll?.eintrag?.('turn', { zustand: 'aktiv', port: this.laufend.port });
    } catch (e) {
      this.fehler = e && e.code === 'EADDRINUSE' ? 'port_belegt' : 'start';
      this.protokoll?.eintrag?.('turn', { fehler: this.fehler, port });
    }
  }

  async _dienstStoppen() {
    const d = this.dienst; this.dienst = null; this.laufend = null;
    if (!d) return;
    try { await d.stoppen(); } catch { /* schon zu */ }
    this.protokoll?.eintrag?.('turn', { zustand: 'aus' });
  }

  _zuteilung({ extern }) {
    if (!extern) return;
    const jetzt = this.jetzt();
    this.externZuletzt = new Date(jetzt).toISOString();
    if (this.externGeschrieben && jetzt - this.externGeschrieben < EXTERN_SCHREIBEN_MS) return;
    this.externGeschrieben = jetzt;
    externMerken(this.ordner, this.externZuletzt).catch(() => {});
  }

  /** Zugang einer Identität (`wer` wie im TURN-username) entziehen – auch für später neu gestartete Dienste (bis 12 h). */
  sperren(wer) {
    const ab = this.jetzt();
    for (const [w, zeit] of this.entzogen) if (ab - zeit > GUELTIG_S * 1000) this.entzogen.delete(w);
    this.entzogen.set(wer, ab);
    if (this.dienst) this.dienst.zugangEntziehen(wer, ab);
  }

  /** ICE-Server für den Browser dieser Identität; ohne laufenden Dienst eine leere Liste. */
  async ice(identitaet) {
    try {
      const i = await this.info();
      if (this.dienst && this.laufend && i.lan_ip && i.lan_ip !== this.laufend.relayIp) await this.neuLaden();
    } catch { /* der laufende Stand gilt weiter */ }
    if (!this.dienst || !this.laufend || !this.geheimnis) return { ice_server: [], gueltig_bis: null };
    let domain = null;
    try { domain = this.linkAdresse && this.linkAdresse.wert ? new URL(this.linkAdresse.wert).hostname : null; } catch { domain = null; }
    const zugang = zugangsdaten(this.geheimnis, werVon(identitaet), this.jetzt());
    return {
      ice_server: iceServer({ lan_ip: this.laufend.relayIp, port: this.laufend.port, domain, zugang }),
      gueltig_bis: new Date(zugang.ablauf_s * 1000).toISOString(),
    };
  }

  stand() {
    const s = this.dienst ? this.dienst.stand() : null;
    return {
      aktiv: !!(s && s.aktiv), port: this.laufend ? this.laufend.port : null, lan_ip: this.letzteInfo ? this.letzteInfo.lan_ip : null,
      zuteilungen: s ? s.zuteilungen : 0, extern_zuletzt: this.externZuletzt, fehler: this.fehler,
    };
  }
}
