// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// HTTP-Mechanik des Web-Dienstes: kleiner Router (Methode + Pfadmuster), Sicherheitskopfzeilen, JSON-Antworten,
// Cookies, Anfragetext-Lesen mit Größenbegrenzung, Fehler → HTTP-Status, HTTP→HTTPS-Umleitung.
// Kennt selbst keine Rechte – Sitzung und CSRF werden hier nur durchgesetzt, geprüft wird in auth.js/csrf.js.

import http from 'node:http';
import net from 'node:net';
import { FahnasFehler } from '../gemeinsam/fehler.js';
import { csrfPruefen, herkunftPruefen } from './csrf.js';
import { clientIp, ipNormal } from './bremse.js';

export const MAX_JSON = 1024 * 1024; // 1 MB je JSON-Anfrage

/** Fehlercode → HTTP-Status (Schnittstellen §6). Alles Unbekannte wird 500. */
const STATUS = Object.freeze({
  E_PARAMS: 400, E_ANMELDUNG: 401, E_TOTP: 401, E_RECHTE: 403, E_CSRF: 403, E_NICHT_GEFUNDEN: 404,
  E_EXISTIERT: 409, E_BELEGT: 409, E_ABGEBROCHEN: 409, E_GEAENDERT: 409, E_TICKET: 410, E_BREMSE: 429, E_AGENT: 503, E_PLATZ: 507,
});
export function httpStatus(code) { return STATUS[code] ?? 500; }

export const CSP = "default-src 'self'; img-src 'self' blob: data: https:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** Kamera, Mikrofon und Bildschirmfreigabe nur für die eigene Seite (Anrufe im Chat, 0.21.0); alles andere aus. */
export const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** Setzt die Sicherheitskopfzeilen (Entwurf §7) auf jede Antwort. HSTS nur auf Wunsch (gültiges Zertifikat). */
export function sicherheitsKopf(res, { hsts = false } = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

/** JSON-Antwort mit Status. */
export function json(res, status, obj, kopf) {
  if (res.headersSent) return;
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...kopf });
  res.end(text);
}

export function fehlerObjekt(code, meldung, details) { return { ok: false, fehler: new FahnasFehler(code, meldung, details).toJSON() }; }

/** Felder in `fehler.details`, die auch Nicht-Admins zu sehen bekommen (Prüfbericht R1, Fund 14). */
export const DETAILS_FUER_ALLE = Object.freeze(['feld', 'warte_s', 'verbleibend', 'noetig', 'frei', 'max', 'min', 'aktion', 'hinweis', 'wiederherstellung', 'protokoll', 'geaendert', 'groesse', 'office', 'gesperrt', 'nur_lesen']);
export const DETAILS_VERWEIS = 'Einzelheiten stehen im Protokoll des Web-Dienstes';

/**
 * Kürzt Fehlerdetails für Nicht-Admins auf die Whitelist: absolute Pfade, Befehlszeilen, stderr-Ausgaben u. ä.
 * bleiben Admins vorbehalten (zusätzlich zu dem, was der Agent selbst filtert). Wurde etwas weggelassen, steht in
 * `details.protokoll` ein Verweis auf das Protokoll. Gibt {details, entfernt} zurück – `entfernt` (die
 * weggelassenen Felder) ist null, wenn nichts gekürzt wurde.
 */
export function detailsFuerRolle(details, rolle) {
  if (details === undefined || rolle === 'admin') return { details, entfernt: null };
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return { details: { protokoll: DETAILS_VERWEIS }, entfernt: details };
  const aus = {}; const weg = {}; let n = 0;
  for (const [k, v] of Object.entries(details)) { if (DETAILS_FUER_ALLE.includes(k)) aus[k] = v; else { weg[k] = v; n++; } }
  if (n === 0) return { details, entfernt: null };
  aus.protokoll = DETAILS_VERWEIS;
  return { details: aus, entfernt: weg };
}

/**
 * Wandelt einen Fehler in eine JSON-Antwort. Unbekannte Fehler gehen ohne Interna nach außen (nur ins Protokoll).
 * `info` = {rolle, nutzer, pfad}: für Rolle admin gehen `details` vollständig an den Browser, für nutzer/gast nur
 * die Whitelist-Felder; der Rest landet als `fehler_details` im Web-Protokoll.
 * Sind die Kopfzeilen schon gesendet (mitten in einem Stream), wird die Verbindung getrennt.
 */
export function fehlerAntwort(res, e, protokoll, info = {}) {
  let f = e instanceof FahnasFehler ? e : null;
  if (!f) {
    if (protokoll) protokoll.eintrag('fehler', { meldung: String(e && e.stack || e).slice(0, 2000) });
    f = new FahnasFehler('E_UNBEKANNT', 'Unerwarteter Fehler im Web-Dienst');
  }
  if (res.headersSent) { res.destroy(); return; }
  const roh = f.toJSON();
  const { details, entfernt } = detailsFuerRolle(roh.details, info.rolle);
  if (entfernt !== null && protokoll) protokoll.eintrag('fehler_details', { fehlerart: f.code, meldung: f.message, nutzer: info.nutzer, rolle: info.rolle, pfad: info.pfad, details: entfernt });
  const fehler = { code: roh.code, meldung: roh.meldung };
  if (details !== undefined) fehler.details = details;
  json(res, httpStatus(f.code), { ok: false, fehler });
}

/** Cookies der Anfrage als Map (erster Wert je Name gewinnt). */
export function cookies(req) {
  const m = new Map();
  const h = req.headers.cookie;
  if (!h) return m;
  for (const teil of h.split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    const k = teil.slice(0, i).trim(); const v = teil.slice(i + 1).trim();
    if (k && !m.has(k)) m.set(k, v);
  }
  return m;
}

/** Baut einen Set-Cookie-Text. Werte sind bei uns immer base64url, deshalb ohne Kodierung. */
export function cookieText(name, wert, { httpOnly = true, secure = false, maxAge } = {}) {
  let s = `${name}=${wert}; Path=/; SameSite=Lax`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  return s;
}

export function cookieAnhaengen(res, text) {
  const alt = res.getHeader('Set-Cookie');
  const liste = alt ? (Array.isArray(alt) ? alt : [alt]) : [];
  res.setHeader('Set-Cookie', [...liste, text]);
}

/** Liest den Anfragetext als JSON-Objekt (max. `max` Bytes). Leerer Text = {}. */
export function leseJson(req, max = MAX_JSON) {
  return new Promise((ok, nein) => {
    const laenge = Number(req.headers['content-length']);
    if (Number.isFinite(laenge) && laenge > max) { req.resume(); return nein(new FahnasFehler('E_PARAMS', 'Anfrage ist zu groß', { max })); }
    const teile = []; let groesse = 0; let fertig = false;
    req.on('data', (t) => {
      if (fertig) return;
      groesse += t.length;
      if (groesse > max) { fertig = true; nein(new FahnasFehler('E_PARAMS', 'Anfrage ist zu groß', { max })); req.destroy(); return; }
      teile.push(t);
    });
    req.on('end', () => {
      if (fertig) return; fertig = true;
      const text = Buffer.concat(teile).toString('utf8').trim();
      if (!text) return ok({});
      let obj;
      try { obj = JSON.parse(text); } catch { return nein(new FahnasFehler('E_PARAMS', 'Der Anfragetext ist kein gültiges JSON')); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return nein(new FahnasFehler('E_PARAMS', 'Der Anfragetext muss ein JSON-Objekt sein'));
      ok(obj);
    });
    req.on('error', () => { if (!fertig) { fertig = true; nein(new FahnasFehler('E_PARAMS', 'Anfrage abgebrochen')); } });
  });
}

/**
 * Router: Methode + Pfadmuster mit ":name"-Segmenten. Optionen je Route:
 *  sitzung: "keine" | "offen" (auch mit offener TOTP-Stufe) | "voll" (Standard)
 *  csrf: schreibende Anfragen mit Sitzung brauchen X-FAHNAS-CSRF (Standard: true außer GET/HEAD)
 *  herkunft: ohne Sitzung stattdessen Origin/Sec-Fetch-Site prüfen
 */
export class Router {
  constructor() { this.routen = []; }

  add(methode, muster, optionen, handler) {
    if (typeof optionen === 'function') { handler = optionen; optionen = {}; }
    const schreibend = methode !== 'GET' && methode !== 'HEAD';
    this.routen.push({
      methode, teile: muster.split('/').filter(Boolean),
      optionen: { sitzung: 'voll', csrf: schreibend, herkunft: false, ...optionen },
      handler,
    });
  }

  finde(methode, pfad) {
    const teile = pfad.split('/').filter(Boolean);
    let methodeFalsch = false;
    for (const r of this.routen) {
      if (r.teile.length !== teile.length) continue;
      const params = {}; let passt = true;
      for (let i = 0; i < teile.length; i++) {
        const m = r.teile[i];
        if (m.startsWith(':')) { try { params[m.slice(1)] = decodeURIComponent(teile[i]); } catch { passt = false; break; } } else if (m !== teile[i]) { passt = false; break; }
      }
      if (!passt) continue;
      if (r.methode !== methode && !(r.methode === 'GET' && methode === 'HEAD')) { methodeFalsch = true; continue; }
      return { route: r, params };
    }
    return methodeFalsch ? { route: null, params: null, methodeFalsch: true } : null;
  }
}

/**
 * Baut den Anfragebehandler: Kopfzeilen, Route finden, Sitzung/TOTP/CSRF durchsetzen, sonst statische Dateien.
 * `auth.sitzungAus(req)` liefert die Sitzung oder null; `vertrauteProxys()` die BlockList für X-Forwarded-For.
 */
export function erstelleBehandler({ router, statisch, auth, vertrauteProxys, hsts = false, protokoll }) {
  return async (req, res) => {
    sicherheitsKopf(res, { hsts });
    res.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://fahnas'); } catch { return json(res, 400, fehlerObjekt('E_PARAMS', 'Ungültige Adresse')); }
    const pfad = url.pathname;
    const api = pfad === '/api' || pfad.startsWith('/api/');
    const treffer = router.finde(req.method, pfad);
    if (!treffer || !treffer.route) {
      if (treffer && treffer.methodeFalsch) return json(res, 405, fehlerObjekt('E_PARAMS', 'Methode für diesen Pfad nicht erlaubt'), { Allow: 'GET, POST' });
      if (api) return json(res, 404, fehlerObjekt('E_NICHT_GEFUNDEN', 'Unbekannter API-Pfad', { pfad }), { 'Cache-Control': 'no-store' });
      if (req.method === 'GET' || req.method === 'HEAD') return statisch.bedienen(req, res, pfad);
      return json(res, 405, fehlerObjekt('E_PARAMS', 'Methode nicht erlaubt'), { Allow: 'GET, HEAD' });
    }
    const { route, params } = treffer;
    res.setHeader('Cache-Control', 'no-store');
    const ip = clientIp(req, vertrauteProxys ? vertrauteProxys() : null);
    const ctx = { req, res, params, query: url.searchParams, ip, sitzung: null, kontext: { nutzer: 'gast', rolle: 'gast', ip } };
    try {
      if (route.optionen.sitzung !== 'keine') {
        const s = await auth.sitzungAus(req);
        if (!s) throw new FahnasFehler('E_ANMELDUNG', 'Bitte melde dich an');
        if (s.totp_offen && route.optionen.sitzung === 'voll') throw new FahnasFehler('E_TOTP', 'Bitte gib den Code deiner Zwei-Faktor-Anmeldung ein');
        ctx.sitzung = s;
        ctx.kontext = { nutzer: s.nutzer, rolle: s.rolle, ip };
        if (route.optionen.csrf) csrfPruefen(req, s);
      } else if (route.optionen.herkunft) {
        herkunftPruefen(req);
      }
      await route.handler(ctx);
    } catch (e) {
      fehlerAntwort(res, e, protokoll, { rolle: ctx.kontext.rolle, nutzer: ctx.kontext.nutzer, pfad });
    }
  };
}

const HOST_ERLAUBT = /^[A-Za-z0-9.\-[\]:]+$/;

/**
 * HTTP-Server, der alles auf https:// umleitet: Port fällt weg, wenn HTTPS auf 443 läuft. Der Host aus der Anfrage
 * wird nur übernommen, wenn er bekannt ist (eigener Hostname, `<hostname>.local`, `localhost`, `erlaubteHosts` oder
 * die IP-Adresse, unter der uns der Client gerade erreicht hat) – sonst zielt die Umleitung auf genau diese
 * lokale Adresse. Damit ist der Umleiter keine offene Weiterleitung (Prüfbericht R1, Fund 15 d).
 * Wird noch nicht gestartet (listen macht der Aufrufer).
 */
export function umleitungsServer({ zielPort = 443, hostname = 'fahnas', erlaubteHosts = [] } = {}) {
  const bekannt = new Set();
  for (const h of [hostname, 'localhost', ...(Array.isArray(erlaubteHosts) ? erlaubteHosts : [])]) {
    if (typeof h !== 'string' || !h || !HOST_ERLAUBT.test(h)) continue;
    bekannt.add(h.toLowerCase()); bekannt.add(`${h.toLowerCase()}.local`);
  }
  const server = http.createServer((req, res) => {
    sicherheitsKopf(res);
    const lokal = ipNormal(req.socket && req.socket.localAddress);
    const lokalHost = lokal ? (net.isIPv6(lokal) ? `[${lokal}]` : lokal) : hostname;
    let host = String(req.headers.host || '');
    if (!HOST_ERLAUBT.test(host)) host = '';
    // Port abtrennen (IPv6 in Klammern beachten)
    host = host.startsWith('[') ? host.replace(/\]:\d+$/, ']') : host.replace(/:\d+$/, '');
    const hostIp = ipNormal(host); // „[fd00::1]“ → „fd00::1“, „192.168.1.50“ → „192.168.1.50“, Namen → „“
    const erlaubt = !!host && (bekannt.has(host.toLowerCase()) || (!!hostIp && hostIp === lokal));
    if (!erlaubt) host = lokalHost;
    const pfad = /^\/[^\s]*$/.test(req.url || '') ? req.url : '/';
    const ziel = `https://${host}${zielPort === 443 ? '' : `:${zielPort}`}${pfad}`;
    res.writeHead(301, { Location: ziel, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`Weiter zu ${ziel}\n`);
  });
  server.headersTimeout = 30_000;
  return server;
}

/** Schließt einen Server samt offener Verbindungen (SSE!) und wartet darauf. */
export function serverSchliessen(server) {
  if (!server) return Promise.resolve();
  return new Promise((ok) => {
    server.close(() => ok());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}
