// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldung: POST /api/anmelden {name, passwort, angemeldet_bleiben} → nutzer.pruefen beim Agenten (Rolle gast),
// POST /api/anmelden/totp {code} → nutzer.totp.pruefen (TOTP-Code oder Wiederherstellungscode im selben Feld).
// Bremse je IP und Name: der Versuch wird VOR dem Agent-Aufruf reserviert (`bremse.beginnen`), damit gleichzeitige
// Anfragen nicht alle an der Zählung vorbeikommen. Fehlversuche nur im Web-Protokoll.
// Aus dem Internet (src/web/anmeldeschutz.js, 16.10.2026): Ländersperre, Rechenaufgabe (GET /api/anmelden/aufgabe), strenge
// Bremse und zweiter Faktor; aus Heimnetz/VPN ohne zweiten Faktor (die Sitzung merkt sich das – siehe Auth.sitzungAus).

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';
import { json, leseJson } from '../server.js';
import { NAME_EXTERN } from '../anmeldeschutz.js';

const NAME = MUSTER_NUTZERNAME;

export function gastKontext(ip) { return { nutzer: 'web', rolle: 'gast', ip }; }

/** Der Agent verweigert dem Web-Dienst eine Gast-Aktion (Rolle „system“ im Register) → verständliche Meldung. */
export function agentVerweigert(e, aktion, protokoll) {
  if (e && e.code === 'E_RECHTE') {
    if (protokoll) protokoll.eintrag('agent_verweigert', { aktion, meldung: e.message });
    return new FahnasFehler('E_AGENT', `Derzeit nicht möglich: Der Steuerdienst erlaubt dem Web-Dienst die Aktion ${aktion} nicht`, { aktion });
  }
  return e;
}

export function registriere(router, { agent, auth, bremse, sitzungen, protokoll, schutz = null }) {
  // Vor dem Anmelden aus dem Internet (Anmeldeschutz): Rechenaufgabe holen bzw. gleich erfahren, dass das Land gesperrt ist.
  // Heimnetz/VPN: {noetig:false} – dort bleibt alles wie gehabt.
  router.add('GET', '/api/anmelden/aufgabe', { sitzung: 'keine' }, async (ctx) => {
    const { res, ip } = ctx;
    if (!schutz || !schutz.extern(ip)) return json(res, 200, { ok: true, ergebnis: { noetig: false } });
    try { await schutz.landPruefen(ip); } catch (e) { return json(res, 200, { ok: true, ergebnis: { noetig: true, land_gesperrt: true, meldung: e.message, laender: e.details && e.details.laender } }); }
    const warte_s = schutz.bremse.gesperrt(ip, '-');
    json(res, 200, { ok: true, ergebnis: { noetig: true, ...schutz.aufgabe(ip), warte_s } });
  });

  // Übersicht für die Kachel „Anmeldeschutz“ und die Karte unter System (nur Admins)
  router.add('GET', '/api/anmeldeschutz', { sitzung: 'voll' }, async (ctx) => {
    if (ctx.sitzung.rolle !== 'admin') throw new FahnasFehler('E_RECHTE', 'Nur für Admins');
    if (!schutz) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Der Anmeldeschutz ist nicht aktiv');
    json(ctx.res, 200, { ok: true, ergebnis: { ...(await schutz.uebersicht()), du_extern: schutz.extern(ctx.ip) } });
  });

  router.add('POST', '/api/anmelden', { sitzung: 'keine', herkunft: true }, async (ctx) => {
    const { res, ip } = ctx;
    const b = await leseJson(ctx.req);
    const name = typeof b.name === 'string' ? b.name.trim().toLowerCase().slice(0, 64) : '';
    const passwort = typeof b.passwort === 'string' ? b.passwort : '';
    const bleiben = b.angemeldet_bleiben === true;
    // Aus dem Internet (Anmeldeschutz): erst Land, dann Rechenaufgabe, dann die strenge Bremse mit eigenem Namensschlüssel
    const extern = !!schutz && schutz.extern(ip);
    if (extern) {
      schutz.bremse.pruefen(ip, NAME_EXTERN(name));
      await schutz.landPruefen(ip);
      schutz.aufgabePruefen(ip, b.aufgabe, typeof b.loesung === 'number' ? String(b.loesung) : b.loesung);
    }
    const br = extern ? schutz.bremse : bremse;
    const brName = extern ? NAME_EXTERN(name) : (name || '-');
    // Versuch reservieren: wirft E_BREMSE bei Sperre oder wenn Fehler + laufende Versuche die Grenze erreichen
    const versuch = br.beginnen(ip, brName);
    try {
      let erg = null;
      if (NAME.test(name) && passwort.length >= 1 && passwort.length <= 256) {
        try {
          erg = await agent.aktion('nutzer.pruefen', { name, passwort }, gastKontext(ip));
        } catch (e) {
          if (e.code === 'E_ANMELDUNG' || e.code === 'E_PARAMS' || e.code === 'E_NICHT_GEFUNDEN') erg = { ok: false };
          else throw agentVerweigert(e, 'nutzer.pruefen', protokoll);
        }
      }
      if (!erg || erg.ok !== true) {
        const sperre_ms = extern ? await schutz.fehlversuch(ip, name) : bremse.fehler(ip, name || '-');
        protokoll.eintrag('anmeldung_fehler', { name: name || '-', ip, sperre_ms, extern });
        throw new FahnasFehler('E_ANMELDUNG', 'Name oder Passwort ist falsch');
      }
      if (extern) await schutz.erfolg(ip, name); else bremse.erfolg(ip, name);
      const rolle = erg.rolle === 'admin' ? 'admin' : 'nutzer';
      // Zweiter Faktor nur von außen (Betreiber 16.10.2026: „nur wenn ich außerhalb von VPN oder Heimnetz zugreife“).
      // Ohne Anmeldeschutz (Tests, alter Aufbau) gilt er wie bisher immer.
      const hatTotp = erg.totp_noetig === true;
      const totp_offen = hatTotp && (extern || !schutz);
      const s = auth.anmelden(res, {
        nutzer: name, rolle, anzeigename: typeof erg.anzeigename === 'string' && erg.anzeigename ? erg.anzeigename : name,
        bleiben, ip, totp_offen, totp: typeof erg.totp === 'boolean' ? erg.totp : hatTotp, totp_spaeter: hatTotp && !totp_offen,
      }, ctx.req);
      protokoll.eintrag('anmeldung', { nutzer: name, rolle, ip, bleiben, totp_offen, extern });
      json(res, 200, { ok: true, totp_noetig: s.totp_offen, ergebnis: { totp_noetig: s.totp_offen, name, rolle } });
    } finally {
      versuch.ende();
    }
  });

  router.add('POST', '/api/anmelden/totp', { sitzung: 'offen', csrf: true }, async (ctx) => {
    const { res, ip, sitzung } = ctx;
    if (!sitzung.totp_offen) return json(res, 200, { ok: true, ergebnis: { totp_noetig: false } });
    const b = await leseJson(ctx.req);
    const code = typeof b.code === 'string' ? b.code.replace(/\s+/g, '').slice(0, 64) : '';
    const name = sitzung.nutzer;
    // gilt für TOTP-Code UND Wiederherstellungscode (beide laufen über dieses Feld); aus dem Internet die strenge Bremse
    const extern = !!schutz && schutz.extern(ip);
    const br = extern ? schutz.bremse : bremse;
    const brName = extern ? NAME_EXTERN(name) : name;
    const versuch = br.beginnen(ip, brName);
    try {
      let erg = null;
      if (code.length >= 4) {
        try {
          erg = await agent.aktion('nutzer.totp.pruefen', { name, code }, gastKontext(ip));
        } catch (e) {
          if (e.code === 'E_TOTP' || e.code === 'E_ANMELDUNG' || e.code === 'E_PARAMS') erg = { ok: false };
          else throw agentVerweigert(e, 'nutzer.totp.pruefen', protokoll);
        }
      }
      if (!erg || erg.ok !== true) {
        const sperre_ms = extern ? await schutz.fehlversuch(ip, name) : bremse.fehler(ip, name);
        protokoll.eintrag('totp_fehler', { nutzer: name, ip, sperre_ms, extern });
        throw new FahnasFehler('E_TOTP', 'Der Code ist falsch oder abgelaufen');
      }
      br.erfolg(ip, brName);
      sitzungen.aktualisieren(sitzung.id, { totp_offen: false, totp: true, totp_spaeter: false });
      protokoll.eintrag('totp_ok', { nutzer: name, ip, wiederherstellung: erg.wiederherstellung === true });
      json(res, 200, { ok: true, ergebnis: { totp_noetig: false, wiederherstellung: erg.wiederherstellung === true, verbleibend: erg.wiederherstellung === true ? erg.verbleibend : undefined } });
    } finally {
      versuch.ende();
    }
  });
}
