// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Räume (Plan 02): raum.json je Raum (nur der Agent schreibt; im Speicher zwischengehalten), Mitgliedschaft,
// Empfängerlisten für Ereignisse, Löschen samt Verlauf und Anhängen, Chat-Einstellungen (Konfig chat.json, 0600).
// Wer kein Mitglied ist, bekommt „Diesen Raum gibt es nicht“ – auch Admins, damit nichts über fremde Räume verrät.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { chatKonfig, chatWurzel, raumDatei, raumOrdner, anhangOrdner, DATEIMODUS } from './ablage.js';
import { vergessen } from './verlauf.js';

export const EINSTELLUNGEN_DATEI = 'chat.json';
export const EINSTELLUNGEN_STANDARD = Object.freeze({ version: 1, max_anhang_mb: 2048, turn: Object.freeze({ aktiv: true, port: 3478 }) });
export const GAESTE_DATEI = 'gaeste.json';

const raumCache = new Map(); // `${wurzel}|${raumId}` → raum
const schluessel = (w, raumId) => `${chatWurzel(w)}|${raumId}`;

/** raum.json eines Raums (Zwischenspeicher) oder null. */
export async function raumLaden(w, raumId) {
  const k = schluessel(w, raumId);
  if (raumCache.has(k)) return raumCache.get(k);
  const r = await chatKonfig(w).laden(raumDatei(raumId), null);
  if (r) raumCache.set(k, r);
  return r;
}

/** raum.json unter der Sperre der Datei ändern (fn bekommt den Stand oder null) und den Zwischenspeicher nachziehen. */
export async function raumAendern(w, raumId, fn) {
  const neu = await chatKonfig(w).aendern(raumDatei(raumId), fn, undefined, DATEIMODUS);
  if (neu) raumCache.set(schluessel(w, raumId), neu);
  return neu;
}

export async function alleRaeume(w) {
  let namen = [];
  try { namen = await fs.readdir(path.join(chatWurzel(w), 'raeume')); } catch { return []; }
  const aus = [];
  for (const id of namen.sort()) {
    try { const r = await raumLaden(w, id); if (r) aus.push(r); } catch (e) { process.stderr.write(`[chat] raum.json ${id}: ${e.message}\n`); }
  }
  return aus;
}

/** Ist `name` Mitglied? Nur eigene Schlüssel zählen (ein Nutzer „constructor“ erbte sonst Object.prototype.constructor). */
export function istMitglied(raum, name) { return !!raum && !!raum.mitglieder && typeof name === 'string' && Object.hasOwn(raum.mitglieder, name); }

/** Raum für ein Mitglied – sonst E_NICHT_GEFUNDEN ohne Hinweis, ob es den Raum gibt. */
export async function raumFuerNutzer(w, raumId, kontext) {
  const r = await raumLaden(w, raumId);
  if (!r || !kontext || !istMitglied(r, kontext.nutzer)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Raum gibt es nicht', { feld: 'raum' });
  return r;
}

export function istVerwalter(raum, nutzer) { return Array.isArray(raum.verwalter) && raum.verwalter.includes(nutzer); }

export function empfaenger(raum) {
  return { nutzer: Object.keys(raum.mitglieder || {}).sort(), gaeste: Object.keys(raum.gaeste || {}).sort() };
}

/** Nutzer aus users.json: Name → {anzeigename, gesperrt, rolle, einstellungen}. */
export async function nutzerDaten(w) {
  const users = await w.konfig.laden('users.json', { nutzer: [], gruppen: [] });
  return new Map(((users && users.nutzer) || []).filter((n) => n && n.name).map((n) => [n.name, { anzeigename: n.anzeigename || '', gesperrt: !!n.gesperrt, rolle: n.rolle, einstellungen: n.einstellungen || {} }]));
}

export function anzeigename(namen, name) {
  const n = namen && namen.get(name);
  return (n && n.anzeigename) || name;
}

/** raum.json eines Raums aus dem Zwischenspeicher werfen (Ordner von außen umgezogen). */
export function raumVergessen(w, raumId) { raumCache.delete(schluessel(w, raumId)); vergessen(raumId); }

/** Raum samt Verlauf und Anhängen löschen; Zwischenspeicher und Gast-Index nachziehen. */
export async function raumLoeschen(w, raumId) {
  await fs.rm(raumOrdner(w, raumId), { recursive: true, force: true });
  await fs.rm(anhangOrdner(w, raumId), { recursive: true, force: true });
  raumCache.delete(schluessel(w, raumId));
  vergessen(raumId);
  try {
    await chatKonfig(w).aendern(GAESTE_DATEI, (d) => {
      const neu = { ...(d || {}) };
      for (const [g, r] of Object.entries(neu)) if (r === raumId) delete neu[g];
      return neu;
    }, {}, DATEIMODUS);
  } catch (e) { process.stderr.write(`[chat] Gast-Index nach Löschen von ${raumId}: ${e.message}\n`); }
}

/**
 * Agent-Ereignis `chat` an genau die Empfänger (der Web-Dienst verteilt; SSE reicht es nie weiter, V7). Mit eigener
 * Empfängerliste (`an`) heißt es `teil: true` – der Web-Dienst merkt sich dann nicht diese Liste als alle Empfänger.
 */
export function chatEreignis(w, raum, art, daten, { an, datenGast } = {}) {
  try { w.ereignis?.('chat', { raum: raum.id, art, daten, ...(datenGast ? { daten_gast: datenGast } : {}), an: an || empfaenger(raum), ...(an ? { teil: true } : {}) }); } catch { /* nie werfen */ }
}

export async function chatEinstellungen(w) {
  const d = (await w.konfig.laden(EINSTELLUNGEN_DATEI, null)) || {};
  return {
    max_anhang_mb: Number.isInteger(d.max_anhang_mb) ? d.max_anhang_mb : EINSTELLUNGEN_STANDARD.max_anhang_mb,
    turn: { aktiv: d.turn && typeof d.turn.aktiv === 'boolean' ? d.turn.aktiv : EINSTELLUNGEN_STANDARD.turn.aktiv, port: d.turn && Number.isInteger(d.turn.port) ? d.turn.port : EINSTELLUNGEN_STANDARD.turn.port },
  };
}

export const _test = { zuruecksetzen() { raumCache.clear(); } };
