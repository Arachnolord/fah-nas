// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zugangsdaten für den eigenen STUN/TURN-Dienst (Plan 03): zeitlich begrenzte Benutzernamen „<ablauf>:<wer>“ mit
// credential = HMAC-SHA1 aus einem Geheimnis, das nur der Web-Dienst kennt (web/turn.json, 32 Byte, 0600, nie im Export).
// Der Browser bekommt die Daten über /api/chat/ice und gibt sie an RTCPeerConnection weiter.

import crypto from 'node:crypto';
import { Konfig, UNVERAENDERT } from '../../gemeinsam/konfig.js';

export const GUELTIG_S = 43_200;
export const TURN_DATEI = 'turn.json';
export const REALM = 'fah-nas';
// „gast-…“ nur als Gast-Kennung – ein Nutzername darf hier nicht wie ein Gast aussehen
const USERNAME = /^(\d{1,12}):((?!gast-)(?=[^:]{2,31}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*|gast-g[A-Za-z0-9_-]{16})$/;
const MODUS = 0o600;

/** Passwort (credential) zu einem Benutzernamen: base64(HMAC-SHA1(geheimnis, username)). */
export function passwortFuer(geheimnis, username) {
  return crypto.createHmac('sha1', geheimnis).update(String(username)).digest('base64');
}

/** Zugangsdaten für 12 Stunden. */
export function zugangsdaten(geheimnis, wer, jetzt_ms = Date.now()) {
  const ablauf_s = Math.floor(jetzt_ms / 1000) + GUELTIG_S;
  const username = `${ablauf_s}:${wer}`;
  return { username, credential: passwortFuer(geheimnis, username), ablauf_s };
}

/** Benutzernamen zerlegen; fremde Form → null. */
export function usernameLesen(username) {
  const m = USERNAME.exec(String(username || ''));
  return m ? { ablauf_s: Number(m[1]), wer: m[2] } : null;
}

/** Wer im Benutzernamen steht: Nutzername bzw. „gast-<gastId>“. */
export function werVon(identitaet) {
  return identitaet && identitaet.art === 'gast' ? `gast-${identitaet.gast}` : String(identitaet && identitaet.nutzer);
}

/** ICE-Server-Eintrag für RTCPeerConnection: erst die LAN-Adresse, dann (falls bekannt) die öffentliche Domain. */
export function iceServer({ lan_ip, port, domain = null, zugang }) {
  const urls = [`stun:${lan_ip}:${port}`, `turn:${lan_ip}:${port}?transport=udp`];
  if (domain) urls.push(`stun:${domain}:${port}`, `turn:${domain}:${port}?transport=udp`);
  return [{ urls, username: zugang.username, credential: zugang.credential }];
}

const konfigs = new Map(); // Ordner → Konfig (gemeinsame Schreibkette je Ordner)
function konfig(ordner) {
  if (!konfigs.has(ordner)) konfigs.set(ordner, new Konfig(ordner));
  return konfigs.get(ordner);
}

const gueltigesGeheimnis = (d) => {
  if (!d || typeof d.geheimnis !== 'string') return null;
  const g = Buffer.from(d.geheimnis, 'base64');
  return g.length === 32 ? g : null;
};

/** Geheimnis laden; fehlt es, ist die Datei kaputt oder nicht 32 Byte lang, wird ein neues erzeugt (0600). */
export async function geheimnisLaden(ordner) {
  const k = konfig(ordner);
  const neu = (alt) => ({ version: 1, geheimnis: crypto.randomBytes(32).toString('base64'), extern_zuletzt: alt && typeof alt.extern_zuletzt === 'string' ? alt.extern_zuletzt : null });
  let d;
  try {
    d = await k.aendern(TURN_DATEI, (alt) => (gueltigesGeheimnis(alt) ? UNVERAENDERT : neu(alt)), null, MODUS);
  } catch (e) {
    if (!e || e.code !== 'E_KONFIG') throw e;
    d = neu(null); // beschädigt: neu anlegen (bisher ausgegebene Zugangsdaten verfallen)
    await k.speichern(TURN_DATEI, d, MODUS);
  }
  return { geheimnis: gueltigesGeheimnis(d), extern_zuletzt: typeof d.extern_zuletzt === 'string' ? d.extern_zuletzt : null };
}

/** Zeitpunkt des letzten Zugriffs von außen merken (das Geheimnis bleibt). */
export async function externMerken(ordner, iso) {
  await geheimnisLaden(ordner);
  await konfig(ordner).aendern(TURN_DATEI, (d) => ({ ...d, extern_zuletzt: iso }), null, MODUS);
}
