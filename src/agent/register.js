// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionsregister des Agenten: feste Liste, je Aktion Mindestrolle + Parameter-Schema + Ausführung.

import { FahnasFehler } from '../gemeinsam/fehler.js';
import { pruefe } from '../gemeinsam/schema.js';

export const ROLLEN = Object.freeze({ gast: 0, nutzer: 1, admin: 2, system: 3 });
const NAME = /^[a-z]+(\.[a-z_]+)+$/;

/**
 * Parameter für das Prüfprotokoll (V1 Audit-Schwärzung): ohne `audit` die echten Parameter; `audit: false` → bei Erfolg
 * kein Eintrag (null), bei Fehler leere Parameter; `audit: (p) => obj` → obj statt der Parameter (Text, Dateiinhalt,
 * Ausweise erscheinen so nie im Protokoll). Wirft die Funktion, steht `{}` im Protokoll.
 */
export function auditParams(aktion, params, ok) {
  if (aktion && aktion.audit === false) return ok ? null : {};
  if (aktion && typeof aktion.audit === 'function') {
    try { return aktion.audit(params ?? {}) ?? {}; } catch { return {}; }
  }
  return params;
}

export class Register {
  constructor() { this.aktionen = new Map(); }

  /**
   * @param {string} name   z. B. "freigaben.anlegen"
   * @param {{rolle:'gast'|'nutzer'|'admin'|'system', schema:object, aufgabe?:boolean, lesend?:boolean, ausfuehren:Function, beschreibung?:string}} def
   *   lesend: reine Abfrage, die die Oberfläche regelmäßig stellt – erfolgreiche Aufrufe kommen nicht ins Prüfprotokoll
   *   (Fehlschläge schon).
   *   audit: false | (p) => object – siehe auditParams (Inhalte nie ins Prüfprotokoll).
   */
  aktion(name, def) {
    if (!NAME.test(name)) throw new Error(`Ungültiger Aktionsname ${name}`);
    if (this.aktionen.has(name)) throw new Error(`Aktion ${name} doppelt registriert`);
    if (!(def.rolle in ROLLEN)) throw new Error(`Aktion ${name}: unbekannte Rolle ${def.rolle}`);
    if (typeof def.ausfuehren !== 'function') throw new Error(`Aktion ${name}: ausfuehren fehlt`);
    if (!def.schema || typeof def.schema !== 'object') throw new Error(`Aktion ${name}: schema fehlt`);
    if (def.audit !== undefined && def.audit !== false && typeof def.audit !== 'function') throw new Error(`Aktion ${name}: audit muss false oder eine Funktion sein`);
    this.aktionen.set(name, { name, rolle: def.rolle, schema: def.schema, aufgabe: !!def.aufgabe, lesend: !!def.lesend, audit: def.audit, ausfuehren: def.ausfuehren, beschreibung: def.beschreibung || '' });
  }

  hole(name) {
    const a = this.aktionen.get(name);
    if (!a) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Unbekannte Aktion „${name}“`, { aktion: name });
    return a;
  }

  /** Prüft Rolle und Parameter; gibt {aktion, params} zurück. */
  vorbereiten(name, params, kontext) {
    const a = this.hole(name);
    const rolle = kontext && kontext.rolle;
    if (!(rolle in ROLLEN)) throw new FahnasFehler('E_RECHTE', 'Unbekannte Rolle');
    if (ROLLEN[rolle] < ROLLEN[a.rolle]) throw new FahnasFehler('E_RECHTE', 'Dafür fehlt dir die Berechtigung', { aktion: name, noetig: a.rolle });
    return { aktion: a, params: pruefe(a.schema, params ?? {}) };
  }

  liste() {
    return [...this.aktionen.values()].map((a) => ({ name: a.name, rolle: a.rolle, aufgabe: a.aufgabe, beschreibung: a.beschreibung }));
  }
}
