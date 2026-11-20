// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Formate des Office-Dokuments (Plan 05): erlaubte Inline- und Zeilen-Attribute mit ihren Werten, Farbpaletten für
// Schrift und Hervorhebung, sichere Links (nur http, https, mailto) und Kennungen. Standardwerte (Einzug 0, links) werden
// nie gespeichert, damit gleiche Inhalte gleich aussehen. Browser und Web-Dienst prüfen damit gleich.

import { SyncFehler } from '../fehler.js';
import { DATEI_MUSTER } from '../konstanten.js';

export { DATEI_MUSTER };

export const FARBEN = Object.freeze({ rot: '#b42318', orange: '#b54708', gelb: '#8a6d00', gruen: '#1e7a34', tuerkis: '#0e7470', blau: '#1d4ed8', lila: '#6d28d9', grau: '#4b5563' });
export const HINTERGRUENDE = Object.freeze({ gelb: '#fff3a3', gruen: '#c9f2d0', tuerkis: '#c4efec', blau: '#d3e3fb', lila: '#e6dafa', rosa: '#fbd3e4', orange: '#fde2c4', grau: '#e5e7eb' });
export const ID_MUSTER = /^[A-Za-z0-9_-]{6,24}$/;
export const INLINE_ATTRIBUTE = Object.freeze(['fett', 'kursiv', 'unterstrichen', 'durchgestrichen', 'code', 'farbe', 'hintergrund', 'link', 'kommentar']);
export const ZEILEN_ATTRIBUTE = Object.freeze(['ueberschrift', 'zitat', 'liste', 'erledigt', 'einzug', 'ausrichtung']);
export const LINK_MAX = 2048;

const HEX = /^#[0-9a-f]{6}$/;
const AN_AUS = new Set(['fett', 'kursiv', 'unterstrichen', 'durchgestrichen', 'code', 'zitat', 'erledigt']);
const LISTEN = Object.freeze(['punkte', 'zahlen', 'aufgabe']);
const AUSRICHTUNGEN = Object.freeze(['mitte', 'rechts', 'block']);
const ID_ZEICHEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const fehler = (meldung) => new SyncFehler('E_PARAMS', meldung, { feld: 'attributes' });

/** Neue Kennung: 8 Zeichen base64url aus 6 Zufallsbytes. */
export function neueId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(6));
  let aus = '';
  for (let i = 0; i < 6; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    aus += ID_ZEICHEN[(n >> 18) & 63] + ID_ZEICHEN[(n >> 12) & 63] + ID_ZEICHEN[(n >> 6) & 63] + ID_ZEICHEN[n & 63];
  }
  return aus;
}

/** Erlaubter Link: http(s) mit Ziel oder mailto, höchstens 2048 Zeichen, ohne Leer- und Steuerzeichen. */
export function linkErlaubt(url) {
  if (typeof url !== 'string' || !url || url.length > LINK_MAX) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  return /^https?:\/\/[^/?#]+/i.test(url) || /^mailto:[^\s]+$/i.test(url);
}

/**
 * Farbe aus Fremdformaten (rgb(), #RGB, #RRGGBB, Paletten-Schlüssel) → Paletten-Schlüssel, wenn sie genau einem
 * Palettenwert entspricht, sonst '#rrggbb'; Unlesbares → null.
 */
export function farbeNormal(wert, palette = FARBEN) {
  if (typeof wert !== 'string') return null;
  const w = wert.trim().toLowerCase();
  if (Object.hasOwn(palette, w)) return w;
  let hex = null;
  let m;
  if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(w))) hex = `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  else if (/^#[0-9a-f]{6}$/.test(w)) hex = w;
  else if ((m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(1|1\.0+|0?\.\d+|0))?\s*\)$/.exec(w))) {
    if (m[4] !== undefined && Number(m[4]) < 1) return null; // durchscheinend: keine feste Farbe
    const teile = [m[1], m[2], m[3]].map(Number);
    if (teile.some((x) => x > 255)) return null;
    hex = `#${teile.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  if (!hex) return null;
  const treffer = Object.keys(palette).filter((k) => palette[k] === hex);
  return treffer.length === 1 ? treffer[0] : hex;
}

function farbePruefen(wert, palette, name) {
  if (typeof wert !== 'string' || !(Object.hasOwn(palette, wert) || HEX.test(wert))) throw fehler(`„${name}“ ist keine erlaubte Farbe`);
}

/**
 * Attribute prüfen: nur bekannte Namen mit gültigen Werten; Zeilen-Attribute nur mit `zeile`; `null` (= entfernen) nur
 * mit `mitNull`. Wirft SyncFehler E_PARAMS {feld:'attributes'}.
 */
export function attributePruefen(attr, { zeile = false, mitNull = false } = {}) {
  if (attr === undefined) return;
  if (attr === null || typeof attr !== 'object' || Array.isArray(attr)) throw fehler('Formate ungültig');
  for (const [k, v] of Object.entries(attr)) {
    const bekannt = INLINE_ATTRIBUTE.includes(k) || (zeile && ZEILEN_ATTRIBUTE.includes(k));
    if (!bekannt) throw fehler(`Format „${String(k).slice(0, 40)}“ ist hier nicht erlaubt`);
    if (v === null) { if (!mitNull) throw fehler(`„${k}“ ohne Wert`); continue; }
    if (AN_AUS.has(k)) { if (v !== true) throw fehler(`„${k}“ muss true sein`); continue; }
    switch (k) {
      case 'farbe': farbePruefen(v, FARBEN, k); break;
      case 'hintergrund': farbePruefen(v, HINTERGRUENDE, k); break;
      case 'link': if (!linkErlaubt(v)) throw fehler('Link nicht erlaubt (nur http, https, mailto)'); break;
      case 'kommentar': if (typeof v !== 'string' || !ID_MUSTER.test(v)) throw fehler('Kommentar-Kennung ungültig'); break;
      case 'ueberschrift': if (![1, 2, 3].includes(v)) throw fehler('Überschrift nur 1, 2 oder 3'); break;
      case 'liste': if (!LISTEN.includes(v)) throw fehler('Unbekannte Listenart'); break;
      case 'einzug': if (!Number.isInteger(v) || v < 1 || v > 8) throw fehler('Einzug nur 1–8'); break;
      case 'ausrichtung': if (!AUSRICHTUNGEN.includes(v)) throw fehler('Ausrichtung nur mitte, rechts oder block'); break;
      default: throw fehler(`Format „${k}“ unbekannt`);
    }
  }
}
