// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ersteinrichtung: GET /api/ersteinrichtung → {noetig}; POST {startcode, name, passwort, anzeigename} legt über den
// Agenten den ersten Admin an und meldet ihn direkt an (Sitzungs- und CSRF-Cookie werden gesetzt). Antwort:
// {angelegt:true, angemeldet:true|false, name, rolle, totp_noetig:false} – bei angemeldet:true ist KEIN zweites
// POST /api/anmelden nötig (Prüfbericht R3, Fund 14). Der Startcode ist gegen Raten gebremst (je IP, Versuch wird
// vor dem Agent-Aufruf reserviert). Nach abgeschlossener Ersteinrichtung antwortet POST mit 409 E_EXISTIERT.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';
import { json, leseJson } from '../server.js';
import { gastKontext, agentVerweigert } from './anmelden.js';

const NAME = MUSTER_NUTZERNAME;
const BREMSE_NAME = '@ersteinrichtung';

export function registriere(router, { agent, auth, bremse, protokoll }) {
  router.add('GET', '/api/ersteinrichtung', { sitzung: 'keine' }, async (ctx) => {
    let erg;
    try { erg = await agent.aktion('system.ersteinrichtung.status', {}, gastKontext(ctx.ip)); } catch (e) { throw agentVerweigert(e, 'system.ersteinrichtung.status', protokoll); }
    json(ctx.res, 200, { ok: true, ergebnis: { noetig: !!(erg && erg.noetig) } });
  });

  router.add('POST', '/api/ersteinrichtung', { sitzung: 'keine', herkunft: true }, async (ctx) => {
    const { res, ip } = ctx;
    const b = await leseJson(ctx.req);
    const startcode = typeof b.startcode === 'string' ? b.startcode.trim() : '';
    const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '';
    const passwort = typeof b.passwort === 'string' ? b.passwort : '';
    const anzeigename = typeof b.anzeigename === 'string' && b.anzeigename.trim() ? b.anzeigename.trim().slice(0, 100) : name;
    if (!startcode || startcode.length > 32) throw new FahnasFehler('E_PARAMS', 'Bitte gib den Startcode von der Konsole ein', { feld: 'startcode' });
    if (!NAME.test(name)) throw new FahnasFehler('E_PARAMS', 'Nutzername: klein, beginnt mit Buchstabe, 2–31 Zeichen aus a-z, 0-9, - und _', { feld: 'name' });
    if (passwort.length < 8 || passwort.length > 256) throw new FahnasFehler('E_PARAMS', 'Das Passwort braucht mindestens 8 Zeichen', { feld: 'passwort' });
    const versuch = bremse.beginnen(ip, BREMSE_NAME);
    let uebernommen = false;
    try {
      try {
        const antwort = await agent.aktion('system.ersteinrichtung', { startcode, admin: { name, passwort, anzeigename } }, gastKontext(ip));
        uebernommen = !!(antwort && antwort.uebernommen);
      } catch (e) {
        if (e.code === 'E_ANMELDUNG' || e.code === 'E_TOTP' || (e.code === 'E_PARAMS' && e.details && e.details.feld === 'startcode')) {
          const sperre_ms = bremse.fehler(ip, BREMSE_NAME);
          protokoll.eintrag('ersteinrichtung_fehler', { ip, fehlerart: e.code, sperre_ms }); // nicht „code“ – das schwärzt das Protokoll
          throw new FahnasFehler('E_ANMELDUNG', 'Der Startcode ist falsch', { feld: 'startcode', ...(e.details && typeof e.details === 'object' ? e.details : {}) });
        }
        if (e.code === 'E_EXISTIERT' || e.code === 'E_RECHTE') {
          // Der Agent meldet E_RECHTE sowohl für „Ersteinrichtung schon abgeschlossen“ als auch für „Aktion dem
          // Web-Dienst nicht erlaubt“ (D2) – der Status entscheidet, was gemeint ist.
          let status = null;
          try { status = await agent.aktion('system.ersteinrichtung.status', {}, gastKontext(ip)); } catch { status = null; }
          if (e.code === 'E_EXISTIERT' || (status && status.noetig === false)) {
            throw new FahnasFehler('E_EXISTIERT', 'Die Ersteinrichtung ist schon abgeschlossen – bitte melde dich an');
          }
        }
        throw agentVerweigert(e, 'system.ersteinrichtung', protokoll);
      }
    } finally {
      versuch.ende();
    }
    bremse.erfolg(ip, BREMSE_NAME);
    protokoll.eintrag('ersteinrichtung', { admin: name, ip });
    // direkt anmelden (eigene Sitzung; die Oberfläche muss danach NICHT mehr /api/anmelden aufrufen)
    let erg = null;
    try { erg = await agent.aktion('nutzer.pruefen', { name, passwort }, gastKontext(ip)); } catch { erg = null; }
    if (erg && erg.ok === true) {
      const rolle = erg.rolle === 'nutzer' ? 'nutzer' : 'admin';
      auth.anmelden(res, { nutzer: name, rolle, anzeigename: erg.anzeigename || anzeigename, bleiben: false, ip, totp_offen: false, totp: false }, ctx.req);
      protokoll.eintrag('anmeldung', { nutzer: name, rolle, ip, bleiben: false, totp_offen: false, ersteinrichtung: true });
      return json(res, 200, { ok: true, ergebnis: { angelegt: true, angemeldet: true, name, rolle, totp_noetig: false, uebernommen } });
    }
    json(res, 200, { ok: true, ergebnis: { angelegt: true, angemeldet: false, name, rolle: 'admin', totp_noetig: false, uebernommen } });
  });
}
