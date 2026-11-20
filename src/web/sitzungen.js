// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sitzungsspeicher des Web-Dienstes: /data/config/web/sitzungen.json (atomar, 0600), ID 32 Byte base64url.
// Gleitendes Ablaufen 12 h, „angemeldet bleiben“ 30 Tage. Bereinigung alle 10 Minuten.
// Seit 16.10.2026 je Nutzer „Automatisch abmelden“ (Betreiber: „werde immer nach geraumer zeit ausgeloggt – das würde ich
// gerne einstellen können wann und überhaupt“): /data/config/web/abmelden.json {nutzer: minuten}, 0 = nie. Ohne Eintrag
// gilt der Standard oben; mit Eintrag gilt die Zeit für alle Sitzungen des Nutzers, und das Cookie überlebt das Schließen
// des Browsers (sonst würde „nie“ beim nächsten Browserstart doch abmelden).
// Die Rolle steht in der Sitzung (der Agent prüft sie gegen die Mindestrolle der Aktion). Ändert ein Admin über
// diesen Web-Dienst Rolle/Sperre/Passwort eines Nutzers, passt api/agent.js dessen Sitzungen sofort an.
// Geräte (20.10.2026, Betreiber: „52 aktive Sitzungen völlig überzogen … logins von geräten sollten zählen“): jeder Browser
// trägt ein dauerhaftes Geräte-Cookie; eine neue Anmeldung desselben Nutzers am selben Gerät ersetzt dessen alte Sitzung.
// Sitzungen von vor dieser Änderung (ohne Gerät) bekommen es bei der nächsten Benutzung; unbenutzte davon räumt die
// Bereinigung nach 30 Tagen weg (sonst blieben sie mit „nie abmelden“ ewig liegen).

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FahnasFehler } from '../gemeinsam/fehler.js';
import { Konfig } from '../gemeinsam/konfig.js';
import { PFADE } from '../gemeinsam/pfade.js';
import { csrfToken } from './csrf.js';

export const SITZUNG_COOKIE = 'fahnas_sitzung';
export const GERAET_COOKIE = 'fahnas_geraet';
export const GERAET_MUSTER = /^[A-Za-z0-9_-]{24,64}$/;
/** Sitzungen ohne Gerät (von vor dem 20.10.2026), die so lange unbenutzt sind, gelten als verwaist. */
export const VERWAIST_MS = 30 * 24 * 60 * 60 * 1000;
export const ABLAUF_MS = 12 * 60 * 60 * 1000;
export const BLEIBEN_MS = 30 * 24 * 60 * 60 * 1000;
export const BEREINIGUNG_MS = 10 * 60 * 1000;
const SCHREIBABSTAND_MS = 60_000; // „zuletzt“ höchstens jede Minute auf die Platte
const DATEI = 'sitzungen.json';
const ABMELDEN_DATEI = 'abmelden.json';
/** Wählbare Zeiten ohne Bedienung bis zur Abmeldung (Minuten); null = Standard, 0 = nie. */
export const ABMELDEN_STUFEN = Object.freeze([null, 15, 60, 240, 720, 1440, 10080, 43200, 0]);
export const NIE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Lebensdauer dauerhafter Cookies (Chrome begrenzt auf 400 Tage); ob die Sitzung gilt, entscheidet der Server. */
export const COOKIE_DAUERHAFT_S = 400 * 24 * 60 * 60;

function iso(ms) { return new Date(ms).toISOString(); }

/** Neue Gerätekennung für das Geräte-Cookie. */
export function neueGeraeteKennung() { return crypto.randomBytes(24).toString('base64url'); }

export class Sitzungen extends EventEmitter {
  constructor(ordner = PFADE.web, { ablauf_ms = ABLAUF_MS, bleiben_ms = BLEIBEN_MS, bereinigung_ms = BEREINIGUNG_MS } = {}) {
    super();
    this.konfig = new Konfig(ordner);
    this.ablauf_ms = ablauf_ms; this.bleiben_ms = bleiben_ms; this.bereinigung_ms = bereinigung_ms;
    this.alle = new Map();           // id → Sitzung (ohne id)
    this.abmelden = new Map();       // nutzer → Minuten bis zur Abmeldung (0 = nie); fehlt = Standard
    this.gespeichertZuletzt = new Map(); // id → zuletzt (ms), wie auf der Platte
    this.timer = null; this.schreibTimer = null; this.schreibKette = Promise.resolve();
  }

  dauer(s) {
    const m = this.abmelden.get(s.nutzer);
    if (m === 0) return NIE_MS;
    if (m > 0) return m * 60_000;
    return s.bleiben ? this.bleiben_ms : this.ablauf_ms;
  }

  /** Soll das Cookie das Schließen des Browsers überleben? („angemeldet bleiben“ oder eigene Abmelde-Zeit) */
  dauerhaft(s) { return !!s.bleiben || this.abmelden.has(s.nutzer); }

  /** Eigene Abmelde-Zeit eines Nutzers in Minuten (0 = nie) oder null (Standard). */
  abmeldenVon(nutzer) { return this.abmelden.has(nutzer) ? this.abmelden.get(nutzer) : null; }

  /** Setzt die Abmelde-Zeit (Minuten aus ABMELDEN_STUFEN, null = Standard) und rechnet die Sitzungen des Nutzers neu. */
  async abmeldenSetzen(nutzer, minuten) {
    if (!ABMELDEN_STUFEN.includes(minuten)) throw new FahnasFehler('E_PARAMS', 'Unbekannte Abmelde-Zeit', { feld: 'minuten' });
    if (minuten === null) this.abmelden.delete(nutzer); else this.abmelden.set(nutzer, minuten);
    for (const s of this.alle.values()) if (s.nutzer === nutzer) s.ablauf = iso((Date.parse(s.zuletzt) || Date.now()) + this.dauer(s));
    this._planeSpeichern();
    await this.konfig.speichern(ABMELDEN_DATEI, { nutzer: Object.fromEntries(this.abmelden) }, 0o600);
    return minuten;
  }

  /** Nutzer umbenannt: die eigene Abmelde-Zeit gilt für den neuen Namen. */
  async abmeldenUmbenennen(alt, neu) {
    if (!this.abmelden.has(alt)) return false;
    this.abmelden.set(neu, this.abmelden.get(alt)); this.abmelden.delete(alt);
    await this.konfig.speichern(ABMELDEN_DATEI, { nutzer: Object.fromEntries(this.abmelden) }, 0o600);
    return true;
  }

  async laden() {
    try {
      const a = await this.konfig.laden(ABMELDEN_DATEI, { nutzer: {} });
      for (const [n, m] of Object.entries(a && a.nutzer ? a.nutzer : {})) if (ABMELDEN_STUFEN.includes(m) && m !== null) this.abmelden.set(n, m);
    } catch { /* Standard für alle */ }
    let d;
    try { d = await this.konfig.laden(DATEI, { sitzungen: {} }); } catch { d = { sitzungen: {} }; }
    const jetzt = Date.now();
    for (const [id, s] of Object.entries(d && d.sitzungen ? d.sitzungen : {})) {
      if (!s || typeof s !== 'object' || typeof s.nutzer !== 'string') continue;
      if (Date.parse(s.ablauf) <= jetzt) continue;
      if (!s.csrf) s.csrf = csrfToken();
      this.alle.set(id, s);
      this.gespeichertZuletzt.set(id, Date.parse(s.zuletzt) || jetzt);
    }
  }

  /** Speichern entprellt (100 ms), damit viele Anfragen nicht viele Schreibvorgänge auslösen. */
  _planeSpeichern() {
    if (this.schreibTimer) return;
    this.schreibTimer = setTimeout(() => { this.schreibTimer = null; this.schreibKette = this.schreibKette.then(() => this.speichern()).catch((e) => process.stderr.write(`[web] Sitzungen speichern: ${e.message}\n`)); }, 100);
    this.schreibTimer.unref();
  }

  async speichern() {
    const sitzungen = {};
    for (const [id, s] of this.alle) { sitzungen[id] = s; this.gespeichertZuletzt.set(id, Date.parse(s.zuletzt)); }
    await this.konfig.speichern(DATEI, { sitzungen }, 0o600);
  }

  /**
   * Legt eine Sitzung an. Gibt {id, csrf, …} zurück.
   * `totp_spaeter`: Anmeldung aus Heimnetz/VPN ohne zweiten Faktor (Betreiber 16.10.2026: 2FA nur von außen) – taucht die
   * Sitzung später mit einer Adresse aus dem Internet auf, verlangt Auth.sitzungAus den Code.
   * `geraet`: Kennung aus dem Geräte-Cookie – eine ältere Sitzung desselben Nutzers auf diesem Gerät endet ('ersetzt').
   * @param {{nutzer:string, rolle:string, anzeigename?:string, bleiben?:boolean, ip?:string, totp_offen?:boolean, totp?:boolean, totp_spaeter?:boolean, geraet?:string|null}} d
   */
  anlegen({ nutzer, rolle, anzeigename, bleiben = false, ip = '-', totp_offen = false, totp = false, totp_spaeter = false, geraet = null }) {
    const id = crypto.randomBytes(32).toString('base64url');
    const jetzt = Date.now();
    const s = {
      nutzer, rolle, anzeigename: anzeigename || nutzer, erstellt: iso(jetzt), zuletzt: iso(jetzt),
      ablauf: '', bleiben: !!bleiben, ip, totp_offen: !!totp_offen, totp: !!totp, totp_spaeter: !!totp_spaeter,
      csrf: csrfToken(), geraet: geraet || null,
    };
    s.ablauf = iso(jetzt + this.dauer(s));
    if (s.geraet) for (const [alt, x] of [...this.alle]) if (x.nutzer === nutzer && x.geraet === s.geraet) this.loeschen(alt, 'ersetzt');
    this.alle.set(id, s);
    this._planeSpeichern();
    return { id, ...s };
  }

  /** Holt eine gültige Sitzung (verlängert gleitend) oder null. */
  hole(id) {
    if (typeof id !== 'string' || id.length < 16 || id.length > 128) return null;
    const s = this.alle.get(id);
    if (!s) return null;
    const jetzt = Date.now();
    if (Date.parse(s.ablauf) <= jetzt) { this.alle.delete(id); this.gespeichertZuletzt.delete(id); this._planeSpeichern(); this.emit('beendet', { id, nutzer: s.nutzer, grund: 'abgelaufen' }); return null; }
    s.zuletzt = iso(jetzt);
    s.ablauf = iso(jetzt + this.dauer(s));
    if (jetzt - (this.gespeichertZuletzt.get(id) || 0) > SCHREIBABSTAND_MS) this._planeSpeichern();
    return { id, ...s };
  }

  /** Ordnet einer Sitzung ohne Gerät (von vor dem 20.10.2026) die Kennung aus dem Geräte-Cookie zu. */
  geraetBinden(id, geraet) {
    const s = this.alle.get(id);
    if (!s || s.geraet || !geraet) return false;
    s.geraet = geraet;
    this._planeSpeichern();
    return true;
  }

  /** Aktuelle Rolle einer Sitzung ohne Nebenwirkung (kein Verlängern) – für den SSE-Filter. null = Sitzung weg. */
  rolleVon(id) { const s = this.alle.get(id); return s ? s.rolle : null; }

  aktualisieren(id, aenderungen) {
    const s = this.alle.get(id);
    if (!s) return null;
    for (const k of ['rolle', 'anzeigename', 'totp_offen', 'totp', 'ip', 'totp_spaeter']) if (aenderungen[k] !== undefined) s[k] = aenderungen[k];
    this._planeSpeichern();
    return { id, ...s };
  }

  loeschen(id, grund = 'abgemeldet') {
    const s = this.alle.get(id);
    if (!s) return false;
    this.alle.delete(id); this.gespeichertZuletzt.delete(id);
    this._planeSpeichern();
    this.emit('beendet', { id, nutzer: s.nutzer, grund });
    return true;
  }

  /** Beendet alle Sitzungen eines Nutzers (außer `ausserId`). Gibt die Anzahl zurück. */
  loescheNutzer(nutzer, ausserId, grund = 'beendet') {
    let n = 0;
    for (const [id, s] of [...this.alle]) if (s.nutzer === nutzer && id !== ausserId) { this.loeschen(id, grund); n++; }
    return n;
  }

  /** Passt Felder aller Sitzungen eines Nutzers an (z. B. Rolle nach Änderung durch einen Admin). */
  aktualisiereNutzer(nutzer, aenderungen) {
    let n = 0;
    for (const [id, s] of this.alle) if (s.nutzer === nutzer) { this.aktualisieren(id, aenderungen); n++; }
    return n;
  }

  /** Liste ohne Geheimnisse (ID nur als kurze Kennung). */
  liste(nutzer) {
    const aus = [];
    for (const [id, s] of this.alle) {
      if (nutzer !== undefined && s.nutzer !== nutzer) continue;
      // Gerät nur als kurzer Fingerabdruck – die Kennung selbst steht im Cookie und bleibt geheim
      const geraet = s.geraet ? crypto.createHash('sha256').update(s.geraet).digest('base64url').slice(0, 10) : null;
      aus.push({ kennung: id.slice(0, 10), nutzer: s.nutzer, rolle: s.rolle, erstellt: s.erstellt, zuletzt: s.zuletzt, ablauf: s.ablauf, bleiben: s.bleiben, ip: s.ip, totp_offen: s.totp_offen, geraet });
    }
    return aus.sort((a, b) => (a.zuletzt < b.zuletzt ? 1 : -1));
  }

  /** Findet die volle ID zu einer kurzen Kennung (nur für Beenden über die Oberfläche). */
  idZuKennung(kennung, nutzer) {
    if (typeof kennung !== 'string' || kennung.length < 10) return null;
    for (const [id, s] of this.alle) if (id.startsWith(kennung) && (nutzer === undefined || s.nutzer === nutzer)) return id;
    return null;
  }

  bereinigen() {
    const jetzt = Date.now(); let n = 0;
    for (const [id, s] of [...this.alle]) {
      if (Date.parse(s.ablauf) <= jetzt) { this.loeschen(id, 'abgelaufen'); n++; }
      else if (!s.geraet && jetzt - (Date.parse(s.zuletzt) || 0) > VERWAIST_MS) { this.loeschen(id, 'verwaist'); n++; }
    }
    return n;
  }

  starten() {
    if (this.timer) return;
    this.timer = setInterval(() => this.bereinigen(), this.bereinigung_ms);
    this.timer.unref();
  }

  async stoppen() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.schreibTimer) { clearTimeout(this.schreibTimer); this.schreibTimer = null; }
    await this.schreibKette.catch(() => {});
    try { await this.speichern(); } catch (e) { process.stderr.write(`[web] Sitzungen speichern: ${e.message}\n`); }
  }
}
