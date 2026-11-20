// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// fahnas-agent: läuft als root, hört auf /run/fahnas/agent.sock (NDJSON), führt nur registrierte, geprüfte
// Aktionen aus, protokolliert alles, rendert die Konfiguration ins System. Siehe docs/schnittstellen.md.

import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PFADE } from '../gemeinsam/pfade.js';
import { Konfig } from '../gemeinsam/konfig.js';
import { zeilenleser, sende, MAX_ZEILE } from '../gemeinsam/protokoll.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';
import * as system from '../gemeinsam/system.js';
import { Register, auditParams } from './register.js';
import { Audit } from './audit.js';
import { Aufgaben, AUFGABEN_DATEI } from './aufgaben.js';
import { Datenkanal } from './datenkanal.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const BEREICHE = ['system', 'nutzer', 'freigaben', 'dateien', 'snapshots', 'apps', 'laufwerke', 'netz', 'spiegelung', 'benachrichtigungen', 'vpn', 'gpu', 'energie', 'protokolle', 'vms', 'raid', 'wartung', 'heim', 'chat', 'office', 'importe', 'hardware', 'speicherorte'];
const AUDIT_AUFRAEUMEN_MS = 24 * 60 * 60 * 1000;
const START_HAKEN_WARTEN_MS = 5000;

/**
 * Fehlerdetails, die auch ein normaler Nutzer sehen darf (Feldname für die Oberfläche, Wartezeiten, Platz).
 * Alles andere – Befehlszeilen, stderr, absolute Pfade, Exit-Codes, Gründe mit Interna – bekommt nur ein Admin
 * (Vertrag §6: „Systemfehler nicht mit Interna nach außen“).
 */
export const DETAILS_FUER_NUTZER = Object.freeze(['feld', 'warte_s', 'verbleibend', 'noetig', 'frei', 'prozent', 'aktion', 'freigabe', 'wert', 'stufe', 'name', 'dateiname', 'geaendert', 'groesse', 'office', 'max', 'gesperrt', 'nur_lesen']);

/** Filtert `fehler.details` je nach Rolle: admin/system/konsole alles, sonst nur die harmlosen Felder. */
export function fehlerFuerRolle(fehlerJson, rolle) {
  if (!fehlerJson || typeof fehlerJson !== 'object') return fehlerJson;
  if (rolle === 'admin' || rolle === 'system') return fehlerJson;
  const { details, ...rest } = fehlerJson;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return rest;
  const erlaubt = {};
  for (const k of DETAILS_FUER_NUTZER) if (details[k] !== undefined) erlaubt[k] = details[k];
  return Object.keys(erlaubt).length ? { ...rest, details: erlaubt } : rest;
}

export class Agent {
  /**
   * @param {object} [o]
   * @param {boolean} [o.hintergrund=true] Start-Haken der Bereiche ausführen (Hintergrunddienste wie der Verbindungs-
   *   Sammler und das Laden der Ortsdaten). Einheitstests schalten sie ab – dort sollen keine echten Systembefehle
   *   oder Downloads im Hintergrund laufen.
   */
  constructor({ konfigOrdner = PFADE.konfig, socketPfad = PFADE.agentSocket, datenSocket = PFADE.datenSocket, hintergrund = true } = {}) {
    this.konfig = new Konfig(konfigOrdner);
    this.hintergrund = hintergrund !== false;
    this.bereichsModule = []; // [{name, modul}] – geladene Aktionsmodule, für die Start-Haken
    this._startHaken = null;
    this.socketPfad = socketPfad;
    this.register = new Register();
    this.audit = new Audit(path.join(konfigOrdner, 'protokoll'));
    this.verbindungen = new Set();
    this.zuhoerer = new Set(); // Bereiche, die Ereignisse mitlesen (z. B. Benachrichtigungen) – werkzeuge.beobachten
    this.aufgaben = new Aufgaben((e) => this.rundruf(e), 2, {
      laden: () => this.konfig.laden(AUFGABEN_DATEI, []),
      speichern: (liste) => this.konfig.speichern(AUFGABEN_DATEI, liste),
    });
    this.datenkanal = new Datenkanal(datenSocket);
    this.version = '0.0.0';
    this._auditTimer = null;
    this.werkzeuge = {
      konfig: this.konfig, system, audit: this.audit, aufgaben: this.aufgaben, pfade: PFADE, datenkanal: this.datenkanal,
      ereignis: (art, daten) => this.rundruf({ ereignis: art, ...daten }),
      konfigGeaendert: (bereich) => this.rundruf({ ereignis: 'konfig', bereich }),
      intern: (aktion, params) => this.ausfuehren(aktion, params, { nutzer: 'system', rolle: 'system', ip: '-' }),
      beobachten: (fn) => { this.zuhoerer.add(fn); return () => this.zuhoerer.delete(fn); },
      version: () => this.version,
    };
  }

  /** Lädt alle Aktionsmodule aus src/agent/aktionen/. Fehlende Module (paralleler Bau) werden gemeldet, nicht fatal. */
  async aktionenLaden() {
    for (const b of BEREICHE) {
      try {
        const m = await import(path.join(HIER, 'aktionen', `${b}.js`));
        if (typeof m.registriere !== 'function') throw new Error('registriere() fehlt');
        m.registriere(this.register, this.werkzeuge);
        this.bereichsModule.push({ name: b, modul: m });
      } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') process.stderr.write(`[agent] Bereich ${b} fehlt noch\n`);
        else throw e;
      }
    }
    // eingebaute Aktionen
    this.register.aktion('agent.aktionen', { rolle: 'nutzer', schema: {}, ausfuehren: async () => this.register.liste() });
    this.register.aktion('agent.aufgaben', {
      rolle: 'nutzer', beschreibung: 'Aufgaben (eigene; admin: alle), neueste zuerst, seitenweise',
      schema: { seite: { typ: 'integer', min: 1, max: 1_000_000, standard: 1 }, je_seite: { typ: 'integer', min: 1, max: 500, standard: 200 } },
      ausfuehren: async (p, k) => {
        const sichtbar = this.aufgaben.liste().filter((a) => k.rolle === 'admin' || a.nutzer === k.nutzer);
        const start = (p.seite - 1) * p.je_seite;
        return sichtbar.slice(start, start + p.je_seite);
      },
    });
    this.register.aktion('agent.aufgabe_abbrechen', { rolle: 'nutzer', schema: { id: { typ: 'string', pflicht: true, max: 64 } }, ausfuehren: async (p, k) => { const a = this.aufgaben.hole(p.id); if (k.rolle !== 'admin' && a.nutzer !== k.nutzer) throw new FahnasFehler('E_RECHTE', 'Nicht deine Aufgabe'); return this.aufgaben.abbrechen(p.id); } });
  }

  /**
   * Gleicht den mitgelieferten Kontext mit users.json ab: Rolle und Sperre kommen aus der Konfiguration, nicht aus
   * der Sitzung (D5). Unbekannte Namen mit Rolle nutzer/admin werden abgelehnt – außer den festen Kennungen
   * konsole/system (Kommandozeile als root, interne Aufrufe), die nicht in users.json stehen.
   */
  async kontextAbgleichen(kontext) {
    if (!kontext || !['nutzer', 'admin'].includes(kontext.rolle)) return kontext;
    if (kontext.nutzer === 'konsole' || kontext.nutzer === 'system') return kontext;
    let daten;
    try {
      const p = this.konfig.pfad('users.json');
      const st = await fs.stat(p);
      if (!this._nutzerCache || this._nutzerCache.mtime !== st.mtimeMs || this._nutzerCache.groesse !== st.size) {
        this._nutzerCache = { mtime: st.mtimeMs, groesse: st.size, daten: await this.konfig.laden('users.json') };
      }
      daten = this._nutzerCache.daten;
    } catch { daten = null; }
    const liste = Array.isArray(daten) ? daten : (daten && Array.isArray(daten.nutzer) ? daten.nutzer : []);
    const n = liste.find((x) => x && x.name === kontext.nutzer);
    if (!n) throw new FahnasFehler('E_RECHTE', 'Nutzer nicht (mehr) vorhanden – bitte neu anmelden', { nutzer: kontext.nutzer });
    if (n.gesperrt) throw new FahnasFehler('E_RECHTE', 'Dieses Konto ist gesperrt', { nutzer: kontext.nutzer });
    return { ...kontext, rolle: n.rolle === 'admin' ? 'admin' : 'nutzer' };
  }

  /** Führt eine Aktion aus (auch intern nutzbar). Gibt {ergebnis} oder {aufgabe} zurück. */
  async ausfuehren(name, params, kontext) {
    const start = Date.now();
    let vorbereitet;
    try {
      kontext = await this.kontextAbgleichen(kontext);
      vorbereitet = this.register.vorbereiten(name, params, kontext);
    } catch (e) {
      const f = FahnasFehler.aus(e);
      // Schemafehler (z. B. zu langer Text) tragen die ROHEN Parameter – auch hier die Schwärzung der Aktion anwenden
      const satz = this.register.aktionen.get(name);
      if (f.code !== 'E_NICHT_GEFUNDEN') this.audit.eintrag({ ...kontext, aktion: name, params: satz ? auditParams(satz, params, false) : params, ok: false, fehler: f.toJSON(), dauer_ms: Date.now() - start });
      throw f;
    }
    const { aktion, params: p } = vorbereitet;
    if (aktion.aufgabe) {
      const id = this.aufgaben.einstellen({
        aktion: name, nutzer: kontext.nutzer, rolle: kontext.rolle,
        arbeit: (griff) => aktion.ausfuehren(p, kontext, this.werkzeuge, griff),
      });
      this.audit.eintrag({ ...kontext, aktion: name, params: auditParams(aktion, p, true) ?? {}, ok: true, aufgabe: id, dauer_ms: 0 });
      return { aufgabe: id };
    }
    try {
      const ergebnis = await aktion.ausfuehren(p, kontext, this.werkzeuge);
      // lesend (Register-Flag): regelmäßige Abfragen der Oberfläche (netz.verbindungen alle 5 s, system.protokoll alle 30 s)
      // würden das Prüfprotokoll fluten – nur Fehlschläge landen dort (unten)
      const auditP = auditParams(aktion, p, true);
      if (auditP !== null && !aktion.lesend && (aktion.rolle !== 'nutzer' || !/\.(liste|status|lesen|info|verbindung|durchsuchen|startmenue)$/.test(name))) {
        this.audit.eintrag({ ...kontext, aktion: name, params: auditP, ok: true, dauer_ms: Date.now() - start });
      }
      return { ergebnis: ergebnis === undefined ? null : ergebnis };
    } catch (e) {
      const f = FahnasFehler.aus(e);
      this.audit.eintrag({ ...kontext, aktion: name, params: auditParams(aktion, p, false), ok: false, fehler: f.toJSON(), dauer_ms: Date.now() - start });
      throw f;
    }
  }

  /**
   * Ereignis an alle Verbindungen. Fehlerdetails in Aufgaben-Ereignissen werden nach der Rolle des Auftraggebers
   * gefiltert (der Web-Dienst reicht sie an den Besitzer weiter). Zu große Ereignisse werden nicht gesendet.
   */
  rundruf(obj) {
    for (const fn of this.zuhoerer) { try { fn(obj); } catch (e) { process.stderr.write(`[agent] Zuhörer: ${e && e.message}\n`); } }
    let aus = obj;
    if (obj && obj.ereignis === 'aufgabe' && obj.fehler) aus = { ...obj, fehler: fehlerFuerRolle(obj.fehler, obj.rolle) };
    const text = JSON.stringify(aus);
    if (text.length > MAX_ZEILE) { process.stderr.write(`[agent] Ereignis ${obj && obj.ereignis} zu groß (${text.length} Zeichen) – nicht gesendet\n`); return; }
    for (const s of this.verbindungen) { if (s && !s.destroyed && s.writable) s.write(text + '\n'); }
  }

  /** Antwort auf eine Anfrage: erst prüfen, ob sie in eine Zeile passt – sonst E_SYSTEM statt Verbindungsabriss. */
  _antworten(socket, id, antwort, rolle) {
    let text = JSON.stringify(antwort);
    if (text.length > MAX_ZEILE) {
      const f = new FahnasFehler('E_SYSTEM', 'Ergebnis zu groß – bitte die Anfrage einschränken (Seite wählen, Ordner aufteilen)', { zeichen: text.length, max: MAX_ZEILE });
      text = JSON.stringify({ id, ok: false, fehler: fehlerFuerRolle(f.toJSON(), rolle) });
    }
    if (!socket || socket.destroyed || !socket.writable) return false;
    socket.write(text + '\n');
    return true;
  }

  _verbindung(socket) {
    this.verbindungen.add(socket);
    socket.on('close', () => this.verbindungen.delete(socket));
    socket.on('error', () => this.verbindungen.delete(socket));
    zeilenleser(socket, async (n) => {
      const id = n && typeof n.id === 'string' ? n.id.slice(0, 64) : null;
      if (!id || typeof n.aktion !== 'string' || !n.kontext || typeof n.kontext !== 'object') {
        return sende(socket, { id, ok: false, fehler: new FahnasFehler('E_PARAMS', 'Anfrage unvollständig').toJSON() });
      }
      const kontext = { nutzer: String(n.kontext.nutzer || 'gast').slice(0, 64), rolle: String(n.kontext.rolle || 'gast'), ip: String(n.kontext.ip || '-').slice(0, 64) };
      if (kontext.rolle === 'system') return sende(socket, { id, ok: false, fehler: new FahnasFehler('E_RECHTE', 'Systemrolle nur intern').toJSON() });
      // wirksame Rolle für den Detail-Filter (users.json gewinnt gegen die Sitzung; konsole bleibt admin)
      let rolle = kontext.rolle;
      try { rolle = (await this.kontextAbgleichen(kontext)).rolle; } catch { rolle = 'gast'; }
      try {
        const r = await this.ausfuehren(n.aktion, n.params, kontext);
        this._antworten(socket, id, { id, ok: true, ...r }, rolle);
      } catch (e) {
        sende(socket, { id, ok: false, fehler: fehlerFuerRolle(FahnasFehler.aus(e).toJSON(), rolle) });
      }
    }, (fehler) => { sende(socket, { id: null, ok: false, fehler: fehler.toJSON() }); socket.destroy(); });
  }

  /**
   * Start-Haken: Bereiche mit Hintergrundarbeit exportieren `starten(werkzeuge)` (z. B. netz: Verbindungs-Sammler und
   * Ortsdaten). Alle laufen nebeneinander; ein Fehler betrifft nur seinen Bereich und wird protokolliert, nie geworfen.
   */
  async bereicheStarten() {
    await Promise.all(this.bereichsModule.filter(({ modul }) => typeof modul.starten === 'function').map(async ({ name, modul }) => {
      try { await modul.starten(this.werkzeuge); } catch (e) { process.stderr.write(`[agent] Start von Bereich ${name}: ${e && e.message}\n`); }
    }));
  }

  /** Gegenstück zu bereicheStarten: `stoppen()` jedes Bereichs, Fehler nur protokolliert. */
  async bereicheStoppen() {
    await Promise.all(this.bereichsModule.filter(({ modul }) => typeof modul.stoppen === 'function').map(async ({ name, modul }) => {
      try { await modul.stoppen(); } catch (e) { process.stderr.write(`[agent] Stopp von Bereich ${name}: ${e && e.message}\n`); }
    }));
  }

  /** Löscht Monatsdateien des Prüfprotokolls jenseits der Aufbewahrung (system.json). Nie fatal. */
  async auditAufraeumen() {
    try {
      const sys = await this.konfig.laden('system.json');
      const weg = await this.audit.aufraeumen(sys?.aufbewahrung?.protokoll_monate ?? 12);
      if (weg.length) process.stdout.write(`[agent] Prüfprotokoll: ${weg.join(', ')} gelöscht (Aufbewahrung)\n`);
      return weg;
    } catch (e) { process.stderr.write(`[agent] Prüfprotokoll aufräumen: ${e.message}\n`); return []; }
  }

  async starten() {
    try { this.version = (await fs.readFile(path.join(PFADE.programm, 'BUILD_VERSION'), 'utf8')).trim(); } catch { try { this.version = (await fs.readFile(path.join(HIER, '..', '..', 'BUILD_VERSION'), 'utf8')).trim(); } catch { /* egal */ } }
    await this.konfig.sicherstellen();
    // Aufgaben, die beim letzten Lauf offen waren, gelten als abgebrochen (Ereignis + Zustandsdatei)
    const abgebrochen = await this.aufgaben.wiederherstellen();
    if (abgebrochen.length) process.stdout.write(`[agent] ${abgebrochen.length} offene Aufgabe(n) aus dem letzten Lauf als abgebrochen markiert\n`);
    await fs.mkdir(path.dirname(this.socketPfad), { recursive: true, mode: 0o750 });
    let gid;
    try { gid = await system.gruppenId('fahnas'); } catch { gid = undefined; }
    this.datenkanal.gruppeGid = gid;
    await this.aktionenLaden();
    try { await fs.unlink(this.socketPfad); } catch { /* nicht da */ }
    this.server = net.createServer((s) => this._verbindung(s));
    await new Promise((ok, nein) => this.server.listen(this.socketPfad, (e) => (e ? nein(e) : ok())));
    await fs.chmod(this.socketPfad, 0o660);
    if (gid !== undefined && process.getuid && process.getuid() === 0) { try { await fs.chown(this.socketPfad, 0, gid); } catch { /* egal */ } }
    await this.datenkanal.starten();
    // Konfiguration ins System rendern (idempotent), Fehler nicht fatal – wird protokolliert
    if (this.register.aktionen.has('system.apply')) {
      try { await this.werkzeuge.intern('system.apply', {}); } catch (e) { process.stderr.write(`[agent] apply: ${e.message}\n`); }
    }
    await this.auditAufraeumen();
    this._auditTimer = setInterval(() => { this.auditAufraeumen(); }, AUDIT_AUFRAEUMEN_MS);
    this._auditTimer.unref();
    // Units laufen als Type=simple (systemd-notify aus einem Kindprozess kam beim VM-Test nicht an → Start-Timeout); Meldung bleibt optional
    if (process.env.NOTIFY_SOCKET) { try { await system.befehl('systemd-notify', ['--ready']); } catch { /* egal */ } }
    process.stdout.write(`[agent] bereit auf ${this.socketPfad} (Version ${this.version})\n`);
    // Hintergrunddienste der Bereiche erst nach „bereit“ und ohne zu warten (ein langsamer Download der Ortsdaten darf
    // den Start nicht aufhalten)
    if (this.hintergrund) this._startHaken = this.bereicheStarten();
  }

  async stoppen() {
    if (this._auditTimer) { clearInterval(this._auditTimer); this._auditTimer = null; }
    if (this._startHaken) {
      // laufende Starts kurz abwarten (höchstens 5 s – systemd wartet beim Stopp nur 30 s), dann alle Bereiche stoppen
      let t;
      await Promise.race([this._startHaken, new Promise((ok) => { t = setTimeout(ok, START_HAKEN_WARTEN_MS); })]);
      clearTimeout(t);
      this._startHaken = null;
      await this.bereicheStoppen();
    }
    for (const s of this.verbindungen) s.destroy();
    if (this.server) await new Promise((ok) => this.server.close(() => ok()));
    await this.datenkanal.stoppen();
    await this.aufgaben.gespeichert();
  }
}

// Start als Programm
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Wächter: ein einzelner Kanal- oder Kindprozessfehler darf nie den ganzen Root-Dienst beenden. Die Ursache wird
  // protokolliert; systemd startet nur bei echten Abstürzen neu.
  process.on('uncaughtException', (e) => { process.stderr.write(`[agent] Unbehandelter Fehler (abgefangen): ${e && e.stack || e}\n`); });
  process.on('unhandledRejection', (e) => { process.stderr.write(`[agent] Unbehandelte Ablehnung (abgefangen): ${e && e.stack || e}\n`); });
  const agent = new Agent();
  agent.starten().catch((e) => { process.stderr.write(`[agent] Start fehlgeschlagen: ${e.stack || e}\n`); process.exit(1); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => agent.stoppen().finally(() => process.exit(0)));
}
