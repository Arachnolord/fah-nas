// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// POST /api/agent/<aktion>: Body = params → 1:1 an den Agenten mit Kontext aus der Sitzung. Nur Aktionen der Rollen
// nutzer/admin (Liste einmal vom Agenten geholt und zwischengespeichert); system/gast werden nie weitergereicht.
// Nachwirkungen: Ändert ein Admin hier Rolle/Sperre/Passwort eines Nutzers, werden dessen Sitzungen angepasst.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { json, leseJson } from '../server.js';

const NAME = /^[a-z]+(\.[a-z_]+)+$/;
/** Aktionen, die länger als die üblichen 2 Minuten brauchen dürfen: Starten baut ein fehlendes FAH-Image aus dem Quellcode. */
const LANGE_AKTIONEN = Object.freeze({ 'apps.steuern': 15 * 60 * 1000 });
/** Aktionen, deren Parameter größer als die üblichen 1 MiB JSON sein dürfen (V2): Textdateien bis 2 MiB Inhalt plus Escape-Zuschlag. */
/** Aktionen, die nur der Web-Dienst selbst aufruft, nie über /api/agent: Anruf-Notizen und -Meldungen entstehen nur aus echten Anrufen (Prüfbericht Plan 03, I5). */
export const NUR_INTERN = Object.freeze(new Set(['chat.anruf', 'office.speichern'])); // office.speichern: nur geprüfte Ops über den Office-Dienst
export const GROSSE_AKTIONEN = Object.freeze({ 'dateien.text.speichern': 8 * 1024 * 1024, 'office.anlegen': 16 * 1024 * 1024, 'office.import_setzen': 16 * 1024 * 1024 });

export class AgentApi {
  constructor({ agent, sitzungen, protokoll, tickets = null, hintergrund = null }) {
    this.agent = agent; this.sitzungen = sitzungen; this.protokoll = protokoll; this.tickets = tickets; this.hintergrund = hintergrund;
    this.liste = null; // Map name → {name, rolle, aufgabe}
    this.ladeLauf = null;
    agent.on('getrennt', () => { this.liste = null; this.ladeLauf = null; });
  }

  /** Holt die Aktionsliste vom Agenten (einmal je Verbindung). */
  async aktionen(kontext) {
    if (this.liste) return this.liste;
    if (!this.ladeLauf) {
      this.ladeLauf = this.agent.aktion('agent.aktionen', {}, kontext).then((l) => {
        if (!Array.isArray(l)) throw new FahnasFehler('E_AGENT', 'Aktionsliste des Steuerdienstes unlesbar');
        this.liste = new Map(l.filter((a) => a && typeof a.name === 'string').map((a) => [a.name, a]));
        return this.liste;
      }).finally(() => { this.ladeLauf = null; });
    }
    return this.ladeLauf;
  }

  async aufrufen(ctx) {
    const { res, kontext, params } = ctx;
    const name = params.aktion;
    if (typeof name !== 'string' || name.length > 80 || !NAME.test(name)) throw new FahnasFehler('E_PARAMS', 'Ungültiger Aktionsname', { feld: 'aktion' });
    const liste = await this.aktionen(kontext);
    const def = liste.get(name);
    if (!def) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Unbekannte Aktion „${name}“`, { aktion: name });
    if (NUR_INTERN.has(name) || (def.rolle !== 'nutzer' && def.rolle !== 'admin')) throw new FahnasFehler('E_RECHTE', 'Diese Aktion ist nur dem Steuerdienst selbst erlaubt', { aktion: name });
    const body = await leseJson(ctx.req, GROSSE_AKTIONEN[name]);
    const antwort = await this.agent.anfrage(name, body, kontext, LANGE_AKTIONEN[name]);
    this.nachwirkung(name, body, ctx);
    // Tickets aus Aktionsergebnissen (z. B. system.export → /api/agent-download) gehören GENAU dieser Sitzung
    if (this.tickets && ctx.sitzung && antwort.ergebnis && typeof antwort.ergebnis === 'object') this.tickets.merken(antwort.ergebnis, ctx.sitzung.id, ctx.sitzung.nutzer);
    if (antwort.aufgabe !== undefined) return json(res, 200, { ok: true, aufgabe: antwort.aufgabe });
    json(res, 200, { ok: true, ergebnis: antwort.ergebnis === undefined ? null : antwort.ergebnis });
  }

  /** Sitzungen anderer Nutzer nachziehen, wenn ein Admin sie hier verändert hat (siehe docs/abweichungen.md, D). */
  nachwirkung(name, params, ctx) {
    const ziel = params && typeof params.name === 'string' ? params.name : null;
    const eigene = ctx.sitzung;
    switch (name) {
      case 'nutzer.loeschen':
        if (ziel) this.sitzungen.loescheNutzer(ziel, undefined, 'nutzer_geloescht');
        break;
      case 'nutzer.aendern':
        if (!ziel) break;
        if (params.gesperrt === true) { this.sitzungen.loescheNutzer(ziel, undefined, 'gesperrt'); break; }
        {
          const aend = {};
          if (params.rolle === 'admin' || params.rolle === 'nutzer') aend.rolle = params.rolle;
          if (typeof params.anzeigename === 'string') aend.anzeigename = params.anzeigename;
          if (Object.keys(aend).length) this.sitzungen.aktualisiereNutzer(ziel, aend);
        }
        break;
      case 'nutzer.umbenennen':
        // Umbenannt: Anmeldung gilt nur noch unter dem neuen Namen – alle Sitzungen (auch die eigene) enden; die eigene
        // Abmelde-Zeit und die Hintergrundbilder ziehen mit
        if (!ziel || typeof params.neu !== 'string') break;
        this.sitzungen.abmeldenUmbenennen(ziel, params.neu).catch((e) => process.stderr.write(`[web] Abmelde-Zeit ${ziel}: ${e.message}\n`));
        if (this.hintergrund) this.hintergrund.umbenennen(ziel, params.neu).catch((e) => process.stderr.write(`[web] Hintergrund ${ziel}: ${e.message}\n`));
        this.sitzungen.loescheNutzer(ziel, undefined, 'umbenannt');
        break;
      case 'nutzer.passwort':
        // Passwort geändert: alle anderen Sitzungen dieses Nutzers beenden (die eigene bleibt)
        if (ziel) this.sitzungen.loescheNutzer(ziel, eigene && eigene.nutzer === ziel ? eigene.id : undefined, 'passwort_geaendert');
        break;
      case 'nutzer.totp.bestaetigen':
        if (ziel) this.sitzungen.aktualisiereNutzer(ziel, { totp: true });
        break;
      case 'nutzer.totp.entfernen':
        if (ziel) this.sitzungen.aktualisiereNutzer(ziel, { totp: false });
        break;
      default:
    }
  }

  routen(router) {
    router.add('POST', '/api/agent/:aktion', { sitzung: 'voll', csrf: true }, (ctx) => this.aufrufen(ctx));
  }
}
