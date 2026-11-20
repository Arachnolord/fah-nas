// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Speicher (Plan 02, V11): eigenes btrfs-Unterlaufwerk PFADE.chat (root, 0700, nicht im Konfig-Export) mit
// raeume/<raumId>/raum.json (atomar über eine eigene Konfig-Instanz, Dateien 0600), raeume/<raumId>/verlauf/<JJJJ-MM>.ndjson
// und anhaenge/<raumId>/. Dazu Kennungen (sortierbare Nachrichten-IDs, symmetrische DM-IDs) und Schema-Bausteine.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PFADE } from '../../gemeinsam/pfade.js';
import { Konfig } from '../../gemeinsam/konfig.js';
import { kennung } from '../../gemeinsam/protokoll.js';

export const DATEIMODUS = 0o600;
export const ORDNERMODUS = 0o700;

export function chatWurzel(w) { return (w && w.pfade && w.pfade.chat) || PFADE.chat; }

const sichergestellt = new Map(); // Wurzel → Promise
const konfigs = new Map(); // Wurzel → ChatKonfig

/** Konfig mit 0600 als Standardmodus (Chat-Dateien liest nur root). */
class ChatKonfig extends Konfig {
  speichern(name, daten, modus = DATEIMODUS) { return super.speichern(name, daten, modus); }
  aendern(name, fn, standard, modus = DATEIMODUS) { return super.aendern(name, fn, standard, modus); }
}

/**
 * Legt den Chat-Speicher einmal je Wurzel an: fehlt er, als btrfs-Unterlaufwerk (Schnappschüsse/Kontingente möglich);
 * gelingt das nicht (kein btrfs, Test), genügt ein Ordner. Danach 0700 und die Unterordner raeume/ und anhaenge/.
 */
export function ablageSicherstellen(w) {
  const wurzel = chatWurzel(w);
  if (!sichergestellt.has(wurzel)) {
    const lauf = (async () => {
      await fs.mkdir(path.dirname(wurzel), { recursive: true });
      let da = false;
      try { await fs.lstat(wurzel); da = true; } catch { /* fehlt */ }
      if (!da) {
        try { await w.system.ausfuehren('btrfs', ['subvolume', 'create', wurzel]); } catch (e) { process.stderr.write(`[chat] btrfs-Unterlaufwerk ${wurzel}: ${e.message} – lege einen Ordner an\n`); }
      }
      await fs.mkdir(wurzel, { recursive: true, mode: ORDNERMODUS });
      await fs.chmod(wurzel, ORDNERMODUS);
      for (const o of ['raeume', 'anhaenge']) {
        await fs.mkdir(path.join(wurzel, o), { recursive: true, mode: ORDNERMODUS });
        await fs.chmod(path.join(wurzel, o), ORDNERMODUS);
      }
      return wurzel;
    })();
    lauf.catch(() => sichergestellt.delete(wurzel)); // nach einem Fehler beim nächsten Mal erneut versuchen
    sichergestellt.set(wurzel, lauf);
  }
  return sichergestellt.get(wurzel);
}

/** Eine Konfig-Instanz je Wurzel (Sperren je Datei gelten so für alle Chat-Module gemeinsam). */
export function chatKonfig(w) {
  const wurzel = chatWurzel(w);
  if (!konfigs.has(wurzel)) konfigs.set(wurzel, new ChatKonfig(wurzel));
  return konfigs.get(wurzel);
}

/** Nachrichten-ID: 'n' + Zeit base36 (9 Stellen) + 6 Zufallszeichen [a-z0-9] → 16 Zeichen, nach Zeit sortierbar. */
export function nachrichtId(jetzt = Date.now()) {
  let zufall = '';
  for (let i = 0; i < 6; i++) zufall += crypto.randomInt(36).toString(36);
  return `n${Math.max(0, Math.floor(jetzt)).toString(36).padStart(9, '0')}${zufall}`;
}

/**
 * Direktnachricht zwischen genau zwei Nutzern: dieselbe ID, egal wer sie öffnet. `folge` > 0 ergibt Nachfolge-IDs für den
 * Fall, dass eine frühere DM geschlossen ist (Konto gelöscht und gleichnamig neu angelegt).
 */
export function dmId(a, b, folge = 0) {
  const basis = [String(a), String(b)].sort().join(':');
  return `d${crypto.createHash('sha256').update(folge ? `${basis}:${folge}` : basis).digest('base64url').slice(0, 20)}`;
}

export const neueRaumId = () => kennung('r');
export const neueAnhangId = () => kennung('a');
export const neueGastId = () => kennung('g');
export const neueEinladungId = () => kennung('e');

const GAST = { typ: 'string', pflicht: true, muster: /^g[A-Za-z0-9_-]{16}$/, hinweis: 'Gast ungültig' };
export const S = Object.freeze({
  raum: { typ: 'string', pflicht: true, muster: /^(r[A-Za-z0-9_-]{16}|d[A-Za-z0-9_-]{20})$/, hinweis: 'Raum ungültig' },
  nachricht: { typ: 'string', pflicht: true, muster: /^n[0-9a-z]{15}$/, hinweis: 'Nachricht ungültig' },
  anhang: { typ: 'string', pflicht: true, muster: /^a[A-Za-z0-9_-]{16}$/, hinweis: 'Anhang ungültig' },
  gast: GAST,
  einladung: { typ: 'string', pflicht: true, muster: /^e[A-Za-z0-9_-]{16}$/, hinweis: 'Einladung ungültig' },
  token: { typ: 'string', pflicht: true, min: 16, max: 128, muster: /^[A-Za-z0-9_-]+$/, hinweis: 'Token ungültig' },
  ausweis: { typ: 'object', pflicht: true, felder: { id: GAST, geheimnis: { typ: 'string', pflicht: true, min: 43, max: 43, muster: /^[A-Za-z0-9_-]+$/, hinweis: 'Ausweis ungültig' } } },
});

export const raumDatei = (raumId) => `raeume/${raumId}/raum.json`;
export function raumOrdner(w, raumId) { return path.join(chatWurzel(w), 'raeume', raumId); }
export function verlaufOrdner(w, raumId) { return path.join(raumOrdner(w, raumId), 'verlauf'); }
export function anhangOrdner(w, raumId) { return path.join(chatWurzel(w), 'anhaenge', raumId); }

/** Raumordner (und Verlaufsordner) mit 0700 anlegen. */
export async function raumOrdnerAnlegen(w, raumId) {
  for (const o of [raumOrdner(w, raumId), verlaufOrdner(w, raumId)]) {
    await fs.mkdir(o, { recursive: true, mode: ORDNERMODUS });
    await fs.chmod(o, ORDNERMODUS);
  }
}

export const _test = { zuruecksetzen() { sichergestellt.clear(); konfigs.clear(); } };
