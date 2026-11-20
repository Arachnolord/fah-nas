// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// CSRF-Schutz: doppeltes Token (Cookie fahnas_csrf + Kopfzeile X-FAHNAS-CSRF), zusätzlich an die Sitzung gebunden.
// Ohne Sitzung (Anmelden, Ersteinrichtung) wird stattdessen die Herkunft (Sec-Fetch-Site / Origin) geprüft.

import crypto from 'node:crypto';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export const CSRF_COOKIE = 'fahnas_csrf';
export const CSRF_KOPF = 'x-fahnas-csrf';

/** Zufälliges Token je Sitzung (24 Byte, base64url). */
export function csrfToken() { return crypto.randomBytes(24).toString('base64url'); }

/** Zeitkonstanter Textvergleich. */
export function gleich(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function cookieWert(req, name) {
  const h = req.headers.cookie;
  if (!h) return undefined;
  for (const teil of h.split(';')) {
    const i = teil.indexOf('=');
    if (i > 0 && teil.slice(0, i).trim() === name) return teil.slice(i + 1).trim();
  }
  return undefined;
}

/** Kopfzeile muss Cookie UND dem in der Sitzung gespeicherten Token entsprechen, sonst E_CSRF. */
export function csrfPruefen(req, sitzung) {
  const kopf = req.headers[CSRF_KOPF];
  const keks = cookieWert(req, CSRF_COOKIE);
  if (typeof kopf !== 'string' || !keks || !gleich(kopf, keks) || !sitzung || !gleich(kopf, sitzung.csrf)) {
    throw new FahnasFehler('E_CSRF', 'Sicherheitsprüfung fehlgeschlagen – lade die Seite neu und versuche es noch einmal');
  }
}

/**
 * Herkunft ohne Sitzung: Sec-Fetch-Site muss same-origin oder none sein; fehlt sie, muss ein vorhandener
 * Origin zum Host passen. Fehlen beide (kein Browser), wird nicht blockiert – dort kann es kein CSRF geben.
 */
export function herkunftPruefen(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    if (site === 'same-origin' || site === 'none') return;
    throw new FahnasFehler('E_CSRF', 'Anfrage von fremder Herkunft abgelehnt');
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (origin === 'null') throw new FahnasFehler('E_CSRF', 'Anfrage ohne Herkunft abgelehnt');
  let host;
  try { host = new URL(origin).host; } catch { throw new FahnasFehler('E_CSRF', 'Anfrage mit ungültiger Herkunft abgelehnt'); }
  if (!req.headers.host || host.toLowerCase() !== String(req.headers.host).toLowerCase()) {
    throw new FahnasFehler('E_CSRF', 'Anfrage von fremder Herkunft abgelehnt');
  }
}
