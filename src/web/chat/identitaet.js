// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Wer spricht mit dem Chat? (Plan 02) NAS-Nutzer über ihre Sitzung (offene 2FA zählt nicht), Gäste über den Keks
// fahnas_chatgast = '<gastId>.<geheimnis>'. Den Gast-Ausweis prüft der Agent; das Ergebnis hält der Web-Dienst 60 s,
// verwirft es aber sofort, wenn der Gast entfernt oder sein Raum gelöscht wird.

import { cookies } from '../server.js';
import { gastKontext } from '../api/anmelden.js';

export const GAST_KEKS = 'fahnas_chatgast';
const KEKS = /^(g[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

/** Gast-Ausweis aus dem Keks oder null. */
export function keksLesen(req) {
  const wert = cookies(req).get(GAST_KEKS);
  const m = KEKS.exec(String(wert || ''));
  return m ? { id: m[1], geheimnis: m[2] } : null;
}

export class GastPruefer {
  constructor({ agent, ttl_ms = 60_000 }) { this.agent = agent; this.ttl_ms = ttl_ms; this.speicher = new Map(); }

  /** Ausweis prüfen → {id, raum, raum_name, name} oder null (ungültig). */
  async pruefen(ausweis, ip) {
    if (!ausweis) return null;
    const k = `${ausweis.id}.${ausweis.geheimnis}`;
    const v = this.speicher.get(k);
    if (v && v.bis > Date.now()) return v.wert;
    try {
      const r = await this.agent.aktion('chat.gast.pruefen', { ausweis }, gastKontext(ip));
      const wert = { id: r.gast || ausweis.id, raum: r.raum, raum_name: r.raum_name, name: r.name };
      this.speicher.set(k, { wert, bis: Date.now() + this.ttl_ms });
      return wert;
    } catch { this.speicher.delete(k); return null; }
  }

  /** Zwischenspeicher für einen Gast oder alle Gäste eines Raums verwerfen. */
  verwerfen({ gast, raum } = {}) {
    for (const [k, v] of this.speicher) if ((gast && v.wert.id === gast) || (raum && v.wert.raum === raum)) this.speicher.delete(k);
  }
}

/** Name, unter dem Gäste eine Identität sehen: Gast → sein Name; NAS-Nutzer → Anzeigename, ohne eigenen „Mitglied“ (nie der Login). */
export function gastSichtName(id) {
  if (!id) return 'Mitglied';
  if (id.art === 'gast') return id.name;
  if (id.gastname) return id.gastname;
  return id.anzeigename && id.anzeigename !== id.nutzer ? id.anzeigename : 'Mitglied';
}

/** Identität einer Anfrage: Sitzung (ohne offene 2FA) vor Gast-Keks; sonst null. */
export async function identitaetAus(req, { auth, pruefer, ip }) {
  const s = await auth.sitzungAus(req).catch(() => null);
  if (s && !s.totp_offen) {
    return { art: 'nutzer', nutzer: s.nutzer, rolle: s.rolle, anzeigename: s.anzeigename || s.nutzer, gastname: s.anzeigename && s.anzeigename !== s.nutzer ? s.anzeigename : 'Mitglied', sitzungId: s.id };
  }
  const ausweis = keksLesen(req);
  if (!ausweis) return null;
  const g = await pruefer.pruefen(ausweis, ip);
  return g ? { art: 'gast', gast: g.id, raum: g.raum, raum_name: g.raum_name, name: g.name, ausweis } : null;
}
