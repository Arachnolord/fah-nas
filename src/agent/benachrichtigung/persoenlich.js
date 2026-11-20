// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Persönliche Handy-Meldungen (Plan 02, V9): jeder Nutzer kann ein eigenes ntfy-Thema einschalten
// (users.json → einstellungen.benachrichtigung = {aktiv, thema}). Server und Zugang kommen aus der systemweiten
// ntfy-Einstellung – unabhängig davon, ob der Admin die System-Meldungen eingeschaltet hat. Grenzen: je Schlüssel
// höchstens eine Meldung in 120 s, NAS-weit höchstens 200 am Tag (ntfy.sh erlaubt 250 je IP und Tag). Wirft nie.

import { ntfySenden } from './senden.js';

export const PERSOENLICH_DATEI = 'benachrichtigungen-persoenlich.json';
export const TAGES_GRENZE = 200;
export const ABSTAND_MS = 120_000;
const THEMA = /^[A-Za-z0-9_-]{1,64}$/;
const SYSTEM_DATEI = 'benachrichtigungen.json';

const zuletzt = new Map(); // schluessel → Zeitpunkt der letzten Meldung

/**
 * Sendet eine Meldung an das persönliche Thema von `nutzer`. Gibt true zurück, wenn sie raus ist; false bei
 * ausgeschaltet/kein Thema/Sperre/Tagesgrenze/Fehler. Inhalte bestimmt der Aufrufer (Chat: nie den Nachrichtentext).
 */
export async function persoenlichSenden(w, nutzer, { titel, text, klick, schluessel } = {}) {
  try {
    const jetzt = typeof w.jetzt === 'function' ? w.jetzt() : Date.now();
    const users = await w.konfig.laden('users.json', { nutzer: [] });
    const n = ((users && users.nutzer) || []).find((x) => x && x.name === nutzer);
    const e = n && n.einstellungen && n.einstellungen.benachrichtigung;
    if (!e || e.aktiv !== true || typeof e.thema !== 'string' || !THEMA.test(e.thema)) return false;
    if (schluessel) {
      const vorher = zuletzt.get(schluessel);
      if (vorher !== undefined && jetzt - vorher < ABSTAND_MS) return false;
    }
    const tag = new Date(jetzt).toISOString().slice(0, 10);
    let erlaubt = false;
    await w.konfig.aendern(PERSOENLICH_DATEI, (d) => {
      const z = d && d.tag === tag ? { ...d } : { tag, anzahl: 0, gemeldet: false };
      if (z.anzahl >= TAGES_GRENZE) {
        if (!z.gemeldet) { process.stderr.write(`[benachrichtigung] persönliche Meldungen: Tagesgrenze ${TAGES_GRENZE} erreicht\n`); z.gemeldet = true; return z; }
        return d && d.tag === tag ? z : z;
      }
      z.anzahl += 1; erlaubt = true;
      return z;
    }, { tag: '', anzahl: 0, gemeldet: false });
    if (!erlaubt) return false;
    if (schluessel) zuletzt.set(schluessel, jetzt);
    const sys = await w.konfig.laden(SYSTEM_DATEI, null);
    const ntfy = (sys && sys.ntfy) || {};
    await ntfySenden({ ...ntfy, server: ntfy.server || 'https://ntfy.sh', thema: e.thema }, { titel, text, stufe: 'info', klick }, typeof w.holen === 'function' ? w.holen : fetch);
    return true;
  } catch (f) {
    process.stderr.write(`[benachrichtigung] persönliche Meldung an ${nutzer}: ${f && f.message}\n`);
    return false;
  }
}

/** Server der Handy-Meldungen für den QR-Code der Oberfläche (ohne Zugangsdaten). */
export async function persoenlichServer(w) {
  try { const sys = await w.konfig.laden(SYSTEM_DATEI, null); return (sys && sys.ntfy && sys.ntfy.server) || 'https://ntfy.sh'; } catch { return 'https://ntfy.sh'; }
}

export const _test = { zuruecksetzen() { zuletzt.clear(); } };
