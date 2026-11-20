// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einladungen und Gäste (Plan 02): Einladungslinks je Raum (Token 32 Byte, Ablauf, Höchstzahl), Gast-Ausweis
// {id, geheimnis} – in raum.json steht nur der SHA-256 des Geheimnisses; der Index gaeste.json führt Gast → Raum.
// Gäste sehen genau einen Raum ab ihrem Beitritt; eine Drossel bremst Nachrichten und Uploads je Gast.

import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { chatKonfig, DATEIMODUS } from './ablage.js';
import { raumLaden, raumAendern, alleRaeume, empfaenger, chatEreignis } from './raeume.js';

export const GAST_INDEX = 'gaeste.json';

export function hashVon(geheimnis) { return crypto.createHash('sha256').update(String(geheimnis)).digest('base64url'); }

/** Ausweis prüfen → {raum, gast, gastId}; unbekannt oder falsches Geheimnis → E_RECHTE (ohne Hinweis, was nicht stimmt). */
export async function ausweisPruefen(w, ausweis) {
  const ungueltig = () => new FahnasFehler('E_RECHTE', 'Gastzugang ungültig');
  if (!ausweis || typeof ausweis.id !== 'string' || typeof ausweis.geheimnis !== 'string') throw ungueltig();
  const index = await chatKonfig(w).laden(GAST_INDEX, {});
  const raumId = index && index[ausweis.id];
  if (!raumId) throw ungueltig();
  const raum = await raumLaden(w, raumId);
  const g = raum && raum.gaeste && raum.gaeste[ausweis.id];
  if (!g || typeof g.geheimnis_hash !== 'string') throw ungueltig();
  const a = Buffer.from(hashVon(ausweis.geheimnis)); const b = Buffer.from(g.geheimnis_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw ungueltig();
  return { raum, gast: g, gastId: ausweis.id };
}

/** Gilt die Einladung noch (Ablauf, Höchstzahl)? */
export function einladungGueltig(e, jetzt = Date.now()) {
  return !!e && (e.ablauf === null || Date.parse(e.ablauf) > jetzt) && (e.max === null || e.max === undefined || (e.beitritte || 0) < e.max);
}

/** Einladung zu einem Token suchen → {raum, einladung}; ungültig/abgelaufen/voll → E_NICHT_GEFUNDEN. */
export async function einladungFinden(w, token) {
  for (const r of await alleRaeume(w)) {
    if (r.art !== 'raum') continue;
    const e = (r.einladungen || []).find((x) => x.token === token);
    if (e && einladungGueltig(e)) return { raum: r, einladung: e };
  }
  throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)', { feld: 'token' });
}

export async function indexSetzen(w, gastId, raumId) {
  await chatKonfig(w).aendern(GAST_INDEX, (d) => {
    const n = { ...(d || {}) };
    if (raumId) n[gastId] = raumId; else delete n[gastId];
    return n;
  }, {}, DATEIMODUS);
}

/**
 * Gast aus dem Raum nehmen (entfernt oder selbst gegangen): sein Name bleibt unter gaeste_alt für alte Nachrichten,
 * der Index vergisst ihn, Ereignis `gast_entfernt` an alle bisherigen Empfänger (auch den Gast – sein Socket schließt).
 */
export async function gastEntfernen(w, raum, gastId) {
  const vorher = empfaenger(raum);
  const r = await raumAendern(w, raum.id, (d) => {
    const g = d && d.gaeste && d.gaeste[gastId];
    if (!g) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Gast gibt es nicht', { feld: 'gast' });
    const x = { ...d, gaeste: { ...d.gaeste }, gaeste_alt: { ...(d.gaeste_alt || {}), [gastId]: { name: g.name } } };
    delete x.gaeste[gastId];
    return x;
  });
  await indexSetzen(w, gastId, null);
  chatEreignis(w, r, 'gast_entfernt', { gast: gastId }, { an: vorher });
  return r;
}

const fenster = new Map(); // `${art}|${gastId}` → Zeitstempel
/** Gast-Drossel: höchstens `max` Vorgänge je `fensterMs` – sonst E_BREMSE {warte_s}. */
export function drossel(gastId, art, fensterMs, max, jetzt = Date.now()) {
  const k = `${art}|${gastId}`;
  const liste = (fenster.get(k) || []).filter((t) => jetzt - t < fensterMs);
  if (liste.length >= max) {
    fenster.set(k, liste);
    throw new FahnasFehler('E_BREMSE', 'Zu viele Vorgänge – bitte kurz warten', { warte_s: Math.max(1, Math.ceil((liste[0] + fensterMs - jetzt) / 1000)) });
  }
  liste.push(jetzt); fenster.set(k, liste);
}

export const _test = { drosselZuruecksetzen() { fenster.clear(); } };
