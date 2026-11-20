// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bereich „netz“ des Agenten: Aktion netz.verbindungen für die Weltkarte der Übersicht (nur Admins; „lesend“, also
// ohne Eintrag im Prüfprotokoll – die Übersicht fragt alle 5 s). Hält je Agent-Prozess einen Verbindungs-Sammler
// (conntrack, helfer/verbindungen.js) und die Geo-Verwaltung (Orte aus DB-IP Lite, lokal, helfer/geo.js). Beide
// starten über den Start-Haken des Agenten (starten/stoppen) und lesen ihre Einstellungen aus system.json bei jeder
// Probe bzw. Abfrage neu (Stempel aus Inode/Größe/Zeit) – Änderungen in „System → Standort und Verbindungen“ greifen
// ohne Neustart. Die Geo-Verwaltung wird erst beim Start dynamisch geladen; fehlt sie, arbeitet die Aktion ohne Orte.
// Vertrag: docs/superpowers/specs/2026-09-26-weltkarte-design.md §4.6, §4.7.

import fs from 'node:fs/promises';
import { PFADE } from '../../gemeinsam/pfade.js';
import { STANDARD } from '../../gemeinsam/konfig.js';
import { VerbindungsSammler, heimatAus, geoStatus, GRENZEN } from '../helfer/verbindungen.js';

const GEO_MODUL = '../helfer/geo.js';
const HINWEIS_GEO_FEHLT = 'Die Ortsdaten-Verwaltung fehlt in dieser Fassung – Orte werden nicht bestimmt.';
const HINWEIS_GEO_LAEDT = 'Die Ortsdaten werden gerade geladen.';

/** Zustand je Agent-Prozess. `konfig` = zuletzt gelesene system.json mit ihrem Stempel. */
const zustand = { sammler: null, geo: null, geoFehlt: false, konfig: { stempel: null, sys: null } };
/** Ersatz für Tests: Fabrik (optionen → Objekt) oder fertiges Objekt; geoModul = Pfad des Geo-Moduls. */
const ersatz = { sammler: null, geo: null, geoModul: GEO_MODUL };

const protokoll = (t) => process.stderr.write(`[netz] ${t}\n`);
const aufzeichnenAn = (sys) => !(sys && sys.verbindungen && sys.verbindungen.aufzeichnen === false);
const stadtLadenAn = (sys) => !(sys && sys.geo && sys.geo.stadt_laden === false);

/**
 * system.json lesen, aber nur, wenn sie sich geändert hat (Inode, Größe, Änderungszeit – Konfig schreibt atomar per
 * rename, jede Änderung bekommt eine neue Inode). Fehlt sie, gelten die Standardwerte; ist sie kaputt, bleibt der
 * letzte gute Stand.
 */
async function systemAktuell(w) {
  let stempel = 'fehlt';
  try { const st = await fs.stat(w.konfig.pfad('system.json')); stempel = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { /* fehlt → Standard */ }
  if (stempel !== zustand.konfig.stempel || !zustand.konfig.sys) {
    try {
      const geladen = await w.konfig.laden('system.json');
      const vorher = zustand.konfig.sys;
      zustand.konfig = { stempel, sys: { ...structuredClone(STANDARD['system.json']), ...(geladen && typeof geladen === 'object' ? geladen : {}) } };
      // Städte-Ortsdaten gerade eingeschaltet → sofort laden statt erst bei der nächsten 6-h-Prüfung
      if (vorher && !stadtLadenAn(vorher) && stadtLadenAn(zustand.konfig.sys) && zustand.geo && zustand.geo.aktualisieren) {
        zustand.geo.aktualisieren().catch((e) => protokoll(`Ortsdaten laden: ${e && e.message}`));
      }
    } catch (e) {
      protokoll(`system.json nicht lesbar: ${e && e.message}`);
      if (!zustand.konfig.sys) zustand.konfig = { stempel: null, sys: structuredClone(STANDARD['system.json']) };
    }
  }
  return zustand.konfig.sys;
}

/** Ersatz, wenn helfer/geo.js fehlt (paralleler Bau) oder nicht ladbar ist: keine Orte, ehrlicher Hinweis. */
function ersatzGeo() {
  const status = () => ({ quelle: 'keine', stand: null, hinweis: HINWEIS_GEO_FEHLT });
  return { starten: async () => {}, stoppen: async () => {}, suche: () => null, status, aktualisieren: async () => status() };
}

function geoAktuell() {
  if (zustand.geo) return geoStatus(zustand.geo);
  return { quelle: 'keine', stand: null, hinweis: zustand.geoFehlt ? HINWEIS_GEO_FEHLT : HINWEIS_GEO_LAEDT };
}

/** Der Sammler sieht die Geo-Verwaltung über diese Hülle – so kann sie nach dem Sammler geladen werden. */
const geoHuelle = Object.freeze({
  suche: (ip) => (zustand.geo && typeof zustand.geo.suche === 'function' ? zustand.geo.suche(ip) : null),
  status: () => geoAktuell(),
});

function erzeugen(fabrik, optionen) { return typeof fabrik === 'function' ? fabrik(optionen) : fabrik; }

function sammlerAnlegen(w) {
  if (zustand.sammler) return zustand.sammler;
  const optionen = {
    system: w.system, geo: geoHuelle, konfig: w.konfig,
    aufzeichnenHolen: async () => aufzeichnenAn(await systemAktuell(w)),
    standortHolen: () => heimatAus(zustand.konfig.sys && zustand.konfig.sys.standort),
    protokoll: (t) => process.stderr.write(`[verbindungen] ${t}\n`),
  };
  zustand.sammler = ersatz.sammler ? erzeugen(ersatz.sammler, optionen) : new VerbindungsSammler(optionen);
  return zustand.sammler;
}

async function geoLaden(w) {
  if (zustand.geo) return zustand.geo;
  const pf = w.pfade || {};
  const optionen = {
    pfade: { mit: pf.geoMit || PFADE.geoMit, daten: pf.geo || PFADE.geo },
    stadtLaden: () => stadtLadenAn(zustand.konfig.sys),
    protokoll: (t) => process.stderr.write(`[geo] ${t}\n`),
  };
  let geo;
  try {
    if (ersatz.geo) geo = erzeugen(ersatz.geo, optionen);
    else {
      const { erzeugeGeo } = await import(ersatz.geoModul);
      geo = erzeugeGeo(optionen);
    }
    if (!geo || typeof geo !== 'object') throw new Error('erzeugeGeo lieferte nichts');
  } catch (e) {
    protokoll(`Ortsdaten-Verwaltung nicht ladbar (${(e && (e.code || e.message)) || e}) – die Weltkarte zeigt keine Orte`);
    geo = ersatzGeo();
    zustand.geoFehlt = true;
  }
  zustand.geo = geo;
  try { if (typeof geo.starten === 'function') await geo.starten(); } catch (e) { protokoll(`Ortsdaten: ${e && e.message}`); }
  return geo;
}

async function sicher(text, fn) {
  try { await fn(); } catch (e) { protokoll(`${text}: ${e && e.message}`); }
}

/**
 * Start-Haken (agent.js, nach „bereit“): Sammler und Geo-Verwaltung nebeneinander starten – ein langsamer Download
 * der Ortsdaten hält den Sammler nicht auf; bis dahin sind die Orte leer und werden danach nachgetragen.
 */
export async function starten(w) {
  await systemAktuell(w).catch(() => {});
  const sammler = sammlerAnlegen(w);
  await Promise.all([
    sicher('Verbindungs-Sammler', () => (typeof sammler.starten === 'function' ? sammler.starten() : undefined)),
    sicher('Ortsdaten', () => geoLaden(w)),
  ]);
}

export async function stoppen() {
  const { sammler, geo } = zustand;
  zustand.sammler = null;
  zustand.geo = null;
  zustand.geoFehlt = false;
  await Promise.all([
    sicher('Verbindungs-Sammler', () => (sammler && typeof sammler.stoppen === 'function' ? sammler.stoppen() : undefined)),
    sicher('Ortsdaten', () => (geo && typeof geo.stoppen === 'function' ? geo.stoppen() : undefined)),
  ]);
}

const zahl = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Ergebnis §4.6: Sammler-Daten + frische Einstellungen (Aufzeichnung, Standort) + Status der Ortsdaten. */
async function verbindungen(w, richtung) {
  const sammler = sammlerAnlegen(w);
  const sys = await systemAktuell(w);
  const aufzeichnung = aufzeichnenAn(sys);
  let e = {};
  if (!aufzeichnung) {
    // sofort vergessen, nicht erst mit der nächsten Probe
    try { if (typeof sammler.verwerfen === 'function') sammler.verwerfen(); } catch { /* egal */ }
  } else {
    try { e = sammler.ergebnis(richtung) || {}; } catch (f) { protokoll(`Ergebnis: ${f && f.message}`); e = {}; }
    // gerade eingeschaltet: nicht auf den nächsten Takt warten
    if (e.aufzeichnung === false && typeof sammler.probe === 'function') Promise.resolve().then(() => sammler.probe()).catch(() => {});
  }
  let werkzeug = e.werkzeug;
  if (!werkzeug) { try { werkzeug = typeof sammler.werkzeugStatus === 'function' ? sammler.werkzeugStatus() : null; } catch { werkzeug = null; } }
  const summe = aufzeichnung && e.summe ? e.summe : {};
  const werkzeugAus = { ok: !(werkzeug && werkzeug.ok === false), hinweis: werkzeug && typeof werkzeug.hinweis === 'string' ? werkzeug.hinweis : null };
  if (werkzeug && werkzeug.gekuerzt === true) werkzeugAus.gekuerzt = true; // riesige Tabelle: nur ein Teil ausgewertet
  return {
    richtung,
    zeit: typeof e.zeit === 'string' ? e.zeit : new Date().toISOString(),
    fenster_s: Number.isFinite(e.fenster_s) ? e.fenster_s : 3600,
    aufzeichnung,
    werkzeug: werkzeugAus,
    geo: geoAktuell(),
    heimat: heimatAus(sys.standort),
    summe: { anzahl: zahl(summe.anzahl), bytes: zahl(summe.bytes), gegenstellen: zahl(summe.gegenstellen) },
    gegenstellen: aufzeichnung && Array.isArray(e.gegenstellen) ? e.gegenstellen.slice(0, GRENZEN.ergebnis) : [],
    lokal: aufzeichnung && Array.isArray(e.lokal) ? e.lokal : [],
  };
}

export function registriere(reg) {
  reg.aktion('netz.verbindungen', {
    rolle: 'admin', lesend: true, beschreibung: 'Verbindungen der letzten Stunde für die Weltkarte (eingehend oder ausgehend)',
    schema: { richtung: { typ: 'string', pflicht: true, werte: ['ein', 'aus'] } },
    ausfuehren: async (p, _k, w) => verbindungen(w, p.richtung),
  });

  // Land einer Adresse für die Ländersperre der Anmeldung aus dem Internet (Web-Dienst, ohne Sitzung – deshalb Rolle gast;
  // nur eine Nachschlage-Funktion in den lokalen Ortsdaten, nichts Geheimes). Unbekannt/privat → land null.
  reg.aktion('netz.land', {
    rolle: 'gast', lesend: true, beschreibung: 'Land einer IP-Adresse aus den lokalen Ortsdaten (Ländersperre der Anmeldung)',
    schema: { ip: { typ: 'string', pflicht: true, max: 45 } },
    ausfuehren: async (p) => {
      let o = null;
      try { o = geoHuelle.suche(p.ip); } catch { o = null; }
      return { ip: p.ip, land: o && o.land ? o.land : null, land_name: o && o.land_name ? o.land_name : null, stadt: o && o.stadt ? o.stadt : null, geo: geoAktuell().quelle };
    },
  });

  // Ort zu Adressen (Kachel „Freigabelinks“: wer gerade zugreift). Nur aus der lokalen DB-IP-Lite-Datenbank, nichts geht
  // nach außen; private Adressen und unbekannte → null.
  reg.aktion('netz.orte', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Ort (Stadt, Land) zu IP-Adressen aus den lokalen Ortsdaten',
    schema: { ips: { typ: 'array', pflicht: true, max: 100, elemente: { typ: 'string', max: 45 } } },
    ausfuehren: async (p) => {
      const aus = {};
      for (const ip of p.ips) {
        let o = null;
        try { o = geoHuelle.suche(ip); } catch { o = null; }
        aus[ip] = o && o.land ? { stadt: o.stadt || null, land: o.land, land_name: o.land_name || o.land } : null;
      }
      return aus;
    },
  });
}

/** Nur für Tests: Attrappen setzen (Fabrik oder Objekt; null = echt), Zustand einsehen und zurücksetzen. */
export const _test = {
  setze({ sammler, geo, geoModul } = {}) {
    if (sammler !== undefined) ersatz.sammler = sammler;
    if (geo !== undefined) ersatz.geo = geo;
    if (geoModul !== undefined) ersatz.geoModul = geoModul || GEO_MODUL;
  },
  async zuruecksetzen() {
    await stoppen();
    ersatz.sammler = null; ersatz.geo = null; ersatz.geoModul = GEO_MODUL;
    zustand.konfig = { stempel: null, sys: null };
  },
  zustand,
};
