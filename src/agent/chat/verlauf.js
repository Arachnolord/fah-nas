// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Verlauf (Plan 02): je Raum nur angehängte Monatsdateien verlauf/<JJJJ-MM>.ndjson mit Ereigniszeilen
// (n = neu, b = bearbeitet, l = gelöscht, r = Reaktion, s = Systemnotiz). Beim ersten Zugriff werden alle Monate eines
// Raums zu einem Zustand gefaltet und in einem LRU-Zwischenspeicher (20 Räume) gehalten; Anhängen hält ihn aktuell.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verlaufOrdner, DATEIMODUS, ORDNERMODUS } from './ablage.js';

export const LRU_GROESSE = 20;
const MONATSDATEI = /^\d{4}-\d{2}\.ndjson$/;

const zwischenspeicher = new Map(); // `${wurzel}|${raumId}` → Zustand (Einfügereihenfolge = LRU, ältester zuerst)
const ketten = new Map(); // raumId → Promise (Anhängen in Reihenfolge)

export function leererZustand() { return { nachrichten: new Map(), ids: [] }; }

function neueNachricht(z) {
  return {
    id: z.id, zeit: z.zeit, von: z.von ?? null, text: typeof z.text === 'string' ? z.text : '', antwort: z.antwort ?? null,
    anhaenge: Array.isArray(z.anhaenge) ? [...z.anhaenge] : [], bearbeitet: null, geloescht: null, reaktionen: {}, system: null,
  };
}

/** Ereigniszeilen auf einen Zustand anwenden (verändert `zustand`, gibt ihn zurück). */
export function falten(zeilen, zustand = leererZustand()) {
  for (const z of zeilen) {
    if (!z || typeof z !== 'object' || typeof z.id !== 'string') continue;
    const n = zustand.nachrichten.get(z.id);
    switch (z.t) {
      case 'n':
        if (n) break;
        zustand.nachrichten.set(z.id, neueNachricht(z)); zustand.ids.push(z.id);
        break;
      case 's':
        if (n) break;
        zustand.nachrichten.set(z.id, { ...neueNachricht({ ...z, von: null, text: '' }), system: { art: z.art, wer: z.wer ?? null, daten: z.daten ?? null } });
        zustand.ids.push(z.id);
        break;
      case 'b':
        if (n && !n.geloescht && typeof z.text === 'string') { n.text = z.text; n.bearbeitet = z.zeit ?? null; }
        break;
      case 'l':
        if (n) { n.geloescht = z.zeit ?? new Date(0).toISOString(); n.text = ''; n.anhaenge = []; n.reaktionen = {}; }
        break;
      case 'r': {
        if (!n || n.geloescht || typeof z.emoji !== 'string' || typeof z.von !== 'string') break;
        const liste = n.reaktionen[z.emoji] || [];
        if (z.an) { if (!liste.includes(z.von)) liste.push(z.von); n.reaktionen[z.emoji] = liste; } else {
          const rest = liste.filter((x) => x !== z.von);
          if (rest.length) n.reaktionen[z.emoji] = rest; else delete n.reaktionen[z.emoji];
        }
        break;
      }
      default: break; // unbekannte Art: überspringen (spätere Fassungen dürfen neue Arten schreiben)
    }
  }
  return zustand;
}

const schluessel = (w, raumId) => `${verlaufOrdner(w, raumId)}|${raumId}`;

/** Zustand eines Raums (LRU): Zugriff frischt auf, über LRU_GROESSE fällt der älteste heraus. */
export async function laden(w, raumId) {
  const k = schluessel(w, raumId);
  if (zwischenspeicher.has(k)) {
    const z = zwischenspeicher.get(k);
    zwischenspeicher.delete(k); zwischenspeicher.set(k, z);
    return z;
  }
  const ordner = verlaufOrdner(w, raumId);
  let dateien = [];
  try { dateien = (await fs.readdir(ordner)).filter((d) => MONATSDATEI.test(d)).sort(); } catch { /* noch kein Verlauf */ }
  const zustand = leererZustand();
  let kaputt = 0;
  for (const d of dateien) {
    const text = await fs.readFile(path.join(ordner, d), 'utf8');
    const zeilen = [];
    for (const zeile of text.split('\n')) {
      if (!zeile.trim()) continue;
      try { zeilen.push(JSON.parse(zeile)); } catch { kaputt++; }
    }
    falten(zeilen, zustand);
  }
  if (kaputt) process.stderr.write(`[chat] Verlauf ${raumId}: ${kaputt} unlesbare Zeile(n) übersprungen\n`);
  // Ein anderer Aufruf kann inzwischen geladen haben – dann dessen Zustand nehmen (Anhängen pflegt nur diesen)
  if (zwischenspeicher.has(k)) return laden(w, raumId);
  zwischenspeicher.set(k, zustand);
  while (zwischenspeicher.size > LRU_GROESSE) zwischenspeicher.delete(zwischenspeicher.keys().next().value);
  return zustand;
}

/** Zeile an die Monatsdatei anhängen (je Raum in Reihenfolge) und einen geladenen Zustand nachführen. */
export function anhaengen(w, raumId, zeile) {
  const vorher = ketten.get(raumId) || Promise.resolve();
  const lauf = vorher.catch(() => {}).then(async () => {
    const ordner = verlaufOrdner(w, raumId);
    const monat = String(zeile.zeit ?? new Date().toISOString()).slice(0, 7);
    await fs.mkdir(ordner, { recursive: true, mode: ORDNERMODUS });
    // ohne fsync (SSD schonen): nach einem Stromausfall fehlt schlimmstenfalls die letzte Zeile
    await fs.appendFile(path.join(ordner, `${monat}.ndjson`), JSON.stringify(zeile) + '\n', { mode: DATEIMODUS, flag: 'a' });
    const z = zwischenspeicher.get(schluessel(w, raumId));
    if (z) falten([zeile], z);
  });
  ketten.set(raumId, lauf);
  lauf.finally(() => { if (ketten.get(raumId) === lauf) ketten.delete(raumId); }).catch(() => {});
  return lauf;
}

/** `fn` in der Anhänge-Kette des Raums ausführen (nichts wird zwischendurch angehängt); danach Zwischenspeicher leeren. */
export function exklusiv(raumId, fn) {
  const vorher = ketten.get(raumId) || Promise.resolve();
  const lauf = vorher.catch(() => {}).then(fn).finally(() => vergessen(raumId));
  ketten.set(raumId, lauf);
  lauf.finally(() => { if (ketten.get(raumId) === lauf) ketten.delete(raumId); }).catch(() => {});
  return lauf;
}

/**
 * Alle Zeilen eines Raums umschreiben (Nutzer umbenannt): `fn(zeile)` liefert die neue Zeile oder dieselbe. Monatsdatei
 * über Zwischendatei + Umbenennen, nie halb geschrieben. → Zahl geänderter Zeilen.
 */
export function umschreiben(w, raumId, fn) {
  return exklusiv(raumId, async () => {
    const ordner = verlaufOrdner(w, raumId);
    let dateien = [];
    try { dateien = (await fs.readdir(ordner)).filter((d) => MONATSDATEI.test(d)); } catch { return 0; }
    let n = 0;
    for (const d of dateien) {
      const datei = path.join(ordner, d);
      let anders = false;
      const zeilen = (await fs.readFile(datei, 'utf8')).split('\n').map((z) => {
        if (!z.trim()) return z;
        let o; try { o = JSON.parse(z); } catch { return z; }
        const neu = fn(o);
        if (neu === o) return z;
        anders = true; n++;
        return JSON.stringify(neu);
      });
      if (!anders) continue;
      const zwischen = `${datei}.${crypto.randomBytes(4).toString('hex')}.neu`;
      await fs.writeFile(zwischen, zeilen.join('\n'), { mode: DATEIMODUS });
      await fs.rename(zwischen, datei);
    }
    return n;
  });
}

/** Eine Seite Nachrichten: die neuesten `anzahl` (vor `vor`, ab Zeitpunkt `ab`), aufsteigend; `mehr` = ältere vorhanden. */
export function seite(zustand, { vor = null, anzahl = 50, ab = null } = {}) {
  let kandidaten = zustand.ids;
  if (ab) kandidaten = kandidaten.filter((id) => String(zustand.nachrichten.get(id).zeit) >= ab);
  if (vor) kandidaten = kandidaten.filter((id) => id < vor);
  const start = Math.max(0, kandidaten.length - anzahl);
  return { liste: kandidaten.slice(start).map((id) => zustand.nachrichten.get(id)), mehr: start > 0 };
}

/** Volltextsuche ohne Groß/Klein über nicht gelöschte Nachrichten (keine Systemzeilen), neueste zuerst. */
export function suchen(zustand, text, max = 50) {
  const nadel = String(text).toLocaleLowerCase('de');
  const aus = [];
  for (let i = zustand.ids.length - 1; i >= 0 && aus.length < max; i--) {
    const n = zustand.nachrichten.get(zustand.ids[i]);
    if (!n || n.geloescht || n.system) continue;
    if (n.text.toLocaleLowerCase('de').includes(nadel)) aus.push(n);
  }
  return aus;
}

/** Raum aus dem Zwischenspeicher werfen (gelöscht oder von außen geändert). */
export function vergessen(raumId) {
  for (const k of [...zwischenspeicher.keys()]) if (k.endsWith(`|${raumId}`)) zwischenspeicher.delete(k);
}

export const _test = {
  lru: () => [...zwischenspeicher.keys()].map((k) => k.slice(k.lastIndexOf('|') + 1)),
  zuruecksetzen() { zwischenspeicher.clear(); ketten.clear(); },
};
