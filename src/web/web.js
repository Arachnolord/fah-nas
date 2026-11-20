// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// fahnas-web: läuft als Nutzer fahnas, HTTPS auf FAHNAS_WEB_PORT (443) mit Zertifikat aus /data/config/web/tls,
// HTTP auf FAHNAS_HTTP_PORT (80) leitet um. FAHNAS_OHNE_TLS=1 → nur HTTP (Entwicklung/Tests). Schreibt nur nach
// /data/config/web; system.json wird lesend für sprache/design/vertraute_proxys benutzt. Alle Rechte prüft der Agent.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PFADE } from '../gemeinsam/pfade.js';
import { Konfig, STANDARD } from '../gemeinsam/konfig.js';
import { AgentClient } from './agentclient.js';
import { Router, erstelleBehandler, umleitungsServer, serverSchliessen } from './server.js';
import { Sitzungen } from './sitzungen.js';
import { Bremse, proxyListe } from './bremse.js';
import { Statisch, PUBLIC_STANDARD } from './statisch.js';
import { Messwerte } from './messwerte.js';
import { Ereignisse, registriere as sseRegistriere } from './sse.js';
import { Auth } from './auth.js';
import { WebProtokoll } from './webprotokoll.js';
import { zertifikatSicherstellen, hostnameBereinigt } from './tls.js';
import * as anmelden from './api/anmelden.js';
import * as ersteinrichtung from './api/ersteinrichtung.js';
import { AgentApi } from './api/agent.js';
import { konsoleUpgrade, PFAD as KONSOLE_PFAD } from './konsole.js';
import { upgradeVerteiler } from './ws.js';
import { ChatDienst, WS_PFAD as CHAT_PFAD } from './chat/dienst.js';
import { OfficeDienst, WS_PFAD as OFFICE_PFAD } from './office/index.js';
import { Anrufe } from './chat/anrufe.js';
import { anrufRouten } from './chat/anruf_http.js';
import { TurnSteuerung } from './turn/steuerung.js';
import { HintergrundApi } from './api/hintergrund.js';
import { avatarRouten } from './api/avatar.js';
import { DateienApi } from './api/dateien.js';
import { LinkZugriffe, OeffentlicheAdresse } from './links.js';
import { Anmeldeschutz } from './anmeldeschutz.js';

const warte = (ms) => new Promise((ok) => { const t = setTimeout(ok, ms); t.unref?.(); });

function horchen(server, port) {
  return new Promise((ok, nein) => {
    server.once('error', nein);
    server.listen(port, () => { server.off('error', nein); ok(server.address().port); });
  });
}

export class WebDienst {
  /**
   * Alle Angaben sind für Tests überschreibbar; Standard kommt aus Umgebung/PFADE.
   * @param {{konfigOrdner?, webOrdner?, publicOrdner?, agentSocket?, datenSocket?, port?, httpPort?, ohneTls?, hsts?, hostname?,
   *          sitzungen?, bremse?, messwerte?, heartbeat_ms?}} o
   */
  constructor(o = {}) {
    const env = process.env;
    this.konfigOrdner = o.konfigOrdner ?? PFADE.konfig;
    this.webOrdner = o.webOrdner ?? PFADE.web;
    this.publicOrdner = o.publicOrdner ?? PUBLIC_STANDARD;
    this.agentSocket = o.agentSocket ?? PFADE.agentSocket;
    this.datenSocket = o.datenSocket ?? PFADE.datenSocket;
    this.port = o.port ?? Number(env.FAHNAS_WEB_PORT || 8443);
    // FAHNAS_HTTP_PORT leer = keine Umleitung von http:// (Port 80 gehört seit 0.6.17 FAH-Proxy); ungesetzt = keine
    this.httpPort = o.httpPort !== undefined ? o.httpPort : (env.FAHNAS_HTTP_PORT ? Number(env.FAHNAS_HTTP_PORT) : null);
    this.ohneTls = o.ohneTls ?? env.FAHNAS_OHNE_TLS === '1';
    this.hsts = o.hsts ?? env.FAHNAS_HSTS === '1';
    this.hostname = o.hostname ?? hostnameBereinigt();
    this.rotation_ms = o.rotation_ms ?? 24 * 60 * 60 * 1000; // Web-Protokoll: alte Monate täglich löschen, nicht nur beim Start
    this.rotationTimer = null;

    this.system = structuredClone(STANDARD['system.json']);
    this.konfig = new Konfig(this.konfigOrdner);
    this.protokoll = new WebProtokoll(this.webOrdner, { aufbewahrung_monate: this.system.aufbewahrung.protokoll_monate, ausgabe: o.protokollAusgabe });
    this.sitzungen = new Sitzungen(this.webOrdner, o.sitzungen);
    this.bremse = new Bremse(this.webOrdner, o.bremse);
    this.messwerte = new Messwerte(o.messwerte);
    this.statisch = new Statisch(this.publicOrdner);
    this.agent = new AgentClient(this.agentSocket, this.datenSocket);
    this.proxys = null;
    this.ereignisse = new Ereignisse({ messwerte: this.messwerte, agent: this.agent, sitzungen: this.sitzungen, heartbeat_ms: o.heartbeat_ms });
    this.linkZugriffe = new LinkZugriffe(this.webOrdner);
    this.linkAdresse = new OeffentlicheAdresse(this.webOrdner);
    this.schutz = new Anmeldeschutz({ ordner: this.webOrdner, agent: this.agent, systemKonfig: () => this.system, protokoll: this.protokoll, gastKontext: anmelden.gastKontext, ...(o.anmeldeschutz || {}) });
    this.auth = new Auth({ sitzungen: this.sitzungen, secure: !this.ohneTls, systemKonfig: () => this.system, protokoll: this.protokoll, linkAdresse: this.linkAdresse, vertrauteProxys: () => this.proxys, extern: (ip) => this.schutz.extern(ip) });
    this.dateienApi = new DateienApi({ agent: this.agent, protokoll: this.protokoll, bremse: this.bremse, zugriffe: this.linkZugriffe });
    this.hintergrund = new HintergrundApi({ ordner: this.webOrdner }); // eigene Tapete je Nutzer
    this.agentApi = new AgentApi({ agent: this.agent, sitzungen: this.sitzungen, protokoll: this.protokoll, tickets: this.dateienApi.tickets, hintergrund: this.hintergrund });
    this.office = new OfficeDienst({ agent: this.agent, auth: this.auth, sitzungen: this.sitzungen, protokoll: this.protokoll, dateien: this.dateienApi, vertrauteProxys: () => this.proxys });
    this.chat = new ChatDienst({ agent: this.agent, auth: this.auth, sitzungen: this.sitzungen, bremse: this.bremse, protokoll: this.protokoll, dateien: this.dateienApi, vertrauteProxys: () => this.proxys, secure: !this.ohneTls });
    // Anrufe (Plan 03): STUN/TURN im Web-Prozess, Signalisierung über den Chat-WebSocket
    this.turn = new TurnSteuerung({ agent: this.agent, ordner: this.webOrdner, protokoll: this.protokoll, linkAdresse: this.linkAdresse, ...(o.turn || {}) });
    // TURN-Zugang sofort entziehen: entfernter Gast, gesperrter oder gelöschter Nutzer (Prüfbericht Plan 03, I6)
    this.sitzungen.on('beendet', ({ nutzer, grund }) => { if (nutzer && (grund === 'gesperrt' || grund === 'nutzer_geloescht' || grund === 'umbenannt')) this.turn.sperren(nutzer); });
    this.agent.on('ereignis', (e) => { if (e && e.ereignis === 'chat' && e.art === 'gast_entfernt' && e.daten && typeof e.daten.gast === 'string') this.turn.sperren(`gast-${e.daten.gast}`); });
    this.anrufe = new Anrufe({ chat: this.chat, agent: this.agent, protokoll: this.protokoll });
    this.router = new Router();
    this.server = null; this.umleitung = null; this.gestartet = false;

    this.agent.on('verbunden', () => { this.protokoll.eintrag('agent', { zustand: 'verbunden' }); this.systemLaden().catch(() => {}); });
    this.agent.on('getrennt', () => this.protokoll.eintrag('agent', { zustand: 'getrennt' }));
    this.agent.on('ereignis', (e) => { if (e && e.ereignis === 'konfig' && e.bereich === 'system') this.systemLaden().catch(() => {}); });
  }

  /** system.json lesend: sprache, design, vertraute_proxys, aufbewahrung. Fehler → Standardwerte bleiben. */
  async systemLaden() {
    try {
      const s = await this.konfig.laden('system.json');
      if (s && typeof s === 'object') this.system = { ...structuredClone(STANDARD['system.json']), ...s };
    } catch (e) {
      this.protokoll.eintrag('system_json', { meldung: e.message });
    }
    this.proxys = proxyListe(this.system.vertraute_proxys);
    if (this.system.aufbewahrung && Number.isFinite(this.system.aufbewahrung.protokoll_monate)) this.protokoll.aufbewahrung_monate = this.system.aufbewahrung.protokoll_monate;
    return this.system;
  }

  /** Wartet (höchstens `zeit_ms`) auf die Verbindung zum Agenten. */
  agentBereit(zeit_ms = 5000) {
    if (this.agent.verbunden) return Promise.resolve(true);
    return new Promise((ok) => {
      const t = setTimeout(() => { this.agent.off('verbunden', fertig); ok(false); }, zeit_ms);
      const fertig = () => { clearTimeout(t); ok(true); };
      this.agent.once('verbunden', fertig);
    });
  }

  _routen() {
    const r = this.router;
    const gemeinsam = { agent: this.agent, auth: this.auth, bremse: this.bremse, sitzungen: this.sitzungen, protokoll: this.protokoll, schutz: this.schutz };
    ersteinrichtung.registriere(r, gemeinsam);
    anmelden.registriere(r, gemeinsam);
    this.auth.routen(r);
    this.agentApi.routen(r);
    this.dateienApi.routen(r);
    this.hintergrund.routen(r);
    avatarRouten(r, { agent: this.agent }); // Nutzerbilder (0.22.0)
    sseRegistriere(r, { ereignisse: this.ereignisse, messwerte: this.messwerte });
    this.chat.routen(r);
    anrufRouten(r, { chat: this.chat, turn: this.turn, auth: this.auth, vertrauteProxys: () => this.proxys });
    this.office.routen(r);
  }

  /** Startet alles. Gibt die tatsächlich gewählten Ports zurück (bei 0: zufällig). */
  async starten() {
    await fs.mkdir(this.webOrdner, { recursive: true, mode: 0o700 });
    await this.systemLaden();
    await this.protokoll.rotieren();
    await this.sitzungen.laden();
    await this.bremse.laden();
    await this.linkZugriffe.laden();
    await this.linkAdresse.laden();
    await this.schutz.laden();
    this._routen();
    const behandler = erstelleBehandler({
      router: this.router, statisch: this.statisch, auth: this.auth, vertrauteProxys: () => this.proxys, hsts: this.hsts && !this.ohneTls, protokoll: this.protokoll,
    });
    if (this.ohneTls) {
      this.server = http.createServer(behandler);
    } else {
      const { cert, key, neu } = await zertifikatSicherstellen(path.join(this.webOrdner, 'tls'), { hostname: this.hostname });
      if (neu) this.protokoll.eintrag('tls', { erzeugt: true, hostname: this.hostname });
      this.server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, behandler);
    }
    this.server.requestTimeout = 0;      // große Uploads dürfen länger als 5 Minuten dauern
    this.server.headersTimeout = 60_000;
    // WebSockets je Pfad (V6): VM-Konsole; Chat/Office hängen sich hier ein
    this.upgradeRouten = new Map([
      [KONSOLE_PFAD, konsoleUpgrade({ auth: this.auth, tickets: this.dateienApi.tickets, agent: this.agent, protokoll: this.protokoll })],
      [CHAT_PFAD, (req, socket, kopf) => this.chat.upgrade(req, socket, kopf)],
      [OFFICE_PFAD, (req, socket, kopf) => this.office.upgrade(req, socket, kopf)],
    ]);
    this.server.on('upgrade', upgradeVerteiler(this.upgradeRouten));
    this.server.on('clientError', (e, socket) => { if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    this.agent.starten();
    this.messwerte.starten();
    this.ereignisse.starten();
    this.chat.starten();
    this.anrufe.einhaengen();
    // TURN-Fehler verhindern den Start des Web-Dienstes nie (Stand und Fehler zeigt die Admin-Karte)
    try { await this.turn.starten(); } catch (e) { this.protokoll.eintrag('turn', { fehler: e && e.message }); }
    this.sitzungen.starten();
    if (this.rotation_ms > 0) {
      this.rotationTimer = setInterval(() => { this.protokoll.rotieren().catch(() => {}); }, this.rotation_ms);
      this.rotationTimer.unref();
    }
    const port = await horchen(this.server, this.port);
    let httpPort = null;
    if (!this.ohneTls && this.httpPort !== null && this.httpPort !== undefined && Number.isFinite(this.httpPort)) {
      // Umleitung nur auf bekannte Hosts (eigener Name, system.json.hostname, .local, erreichte IP) – keine offene Weiterleitung
      this.umleitung = umleitungsServer({ zielPort: port, hostname: this.hostname, erlaubteHosts: [this.system.hostname].filter((h) => typeof h === 'string') });
      try { httpPort = await horchen(this.umleitung, this.httpPort); } catch (e) { this.protokoll.eintrag('http_umleitung', { fehler: e.message }); this.umleitung = null; }
    }
    this.gestartet = true;
    this.protokoll.eintrag('start', { port, httpPort, tls: !this.ohneTls });
    return { port, httpPort };
  }

  async stoppen() {
    if (this.rotationTimer) { clearInterval(this.rotationTimer); this.rotationTimer = null; }
    this.ereignisse.stoppen();
    this.messwerte.stoppen();
    // V15: offene Office-Dokumente sichern (höchstens 20 s), solange der Agent noch erreichbar ist; dann Office-Sockets 1001
    await Promise.race([this.office.abschliessen(), warte(20_000)]);
    this.office.stoppen();
    this.anrufe.stoppen(); // keine Anruf-Meldungen mehr, wenn gleich die Sockets zugehen
    this.chat.stoppen(); // Chat-Sockets 1001, bevor die Agent-Verbindung zugeht
    await this.turn.stoppen();
    this.agent.stoppen();
    await Promise.all([serverSchliessen(this.server), serverSchliessen(this.umleitung)]);
    this.server = null; this.umleitung = null;
    await this.sitzungen.stoppen();
    await this.bremse.stoppen();
    await this.linkZugriffe.stoppen();
    await this.schutz.stoppen();
    if (this.gestartet) this.protokoll.eintrag('stopp', {});
    await this.protokoll.stoppen();
    this.gestartet = false;
  }
}

// Start als Programm
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dienst = new WebDienst();
  dienst.starten().then(({ port, httpPort }) => {
    process.stdout.write(`[web] bereit: ${dienst.ohneTls ? 'http' : 'https'} Port ${port}${httpPort ? `, Umleitung von Port ${httpPort}` : ''}\n`);
    if (process.env.NOTIFY_SOCKET) { import('../gemeinsam/system.js').then((s) => s.befehl('systemd-notify', ['--ready'])).catch(() => {}); }
  }).catch((e) => { process.stderr.write(`[web] Start fehlgeschlagen: ${e.stack || e}\n`); process.exit(1); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => dienst.stoppen().finally(() => process.exit(0)));
}
