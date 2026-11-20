// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „spiegelung.*“ (Betreiber 11.10.2026): Ordner automatisch abgleichen – einseitig (rsync) oder beidseitig
// (unison), per Zeitplan, bei Änderungen oder von Hand; Gelöschtes 30 Tage im Papierkorb des Ziels.
// spiegelung.json = Aufträge (Wahrheit), spiegelung-zustand.json = Laufzustand, spiegelung-verlauf.json = letzte Läufe.
// Läufe laufen NICHT in der allgemeinen Aufgaben-Warteschlange (die hat nur 2 Plätze, ein langer Erstabgleich würde
// App-Installationen blockieren), sondern je Spiegelung für sich; Fortschritt geht als Ereignis „spiegelung“ hinaus.
// Entwurf: docs/superpowers/specs/2026-10-11-spiegelung-design.md

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { auftragNormal, artVon, faelligerZeitpunkt, naechsterZeitpunkt, MAX_AUFTRAEGE, ZUGANG_ID, zugangNormal, zugangAnsicht, relPfad, ordnerNameNormal, freigabeFernNormal } from '../spiegelung/regeln.js';
import { ZUGAENGE, zugaengeLaden, zugangHolen, erreichbar, freigabenListen, ordnerListen, ordnerAnlegenFern } from '../spiegelung/fern.js';
import { laufen, papierkorbAufraeumen, seiteAufloesen, istNichtAngeschlossen, werkzeugeDa } from '../spiegelung/abgleich.js';
import { KORB, korbOrte, korbStaende, externeKoerbeAufraeumen } from '../spiegelung/korb.js';
import { Waechter } from '../spiegelung/waechter.js';
import { cloudZugangNormal, cloudFreigaben, cloudOrdner, cloudOrdnerAnlegen, cloudHost } from '../spiegelung/cloud.js';

export const DATEI = 'spiegelung.json';
export const ZUSTAND = 'spiegelung-zustand.json';
export const VERLAUF = 'spiegelung-verlauf.json';
export const TAKT_MS = 30_000;
const AUFRAEUMEN_MS = 24 * 3_600_000;
const VERLAUF_JE_AUFTRAG = 20;
const ID = /^s-[a-z0-9]{6,16}$/;

const S_SEITE = { typ: 'object', pflicht: true, felder: { zugang: { typ: 'string', max: 13 }, freigabe: { typ: 'string', pflicht: true, max: 80 }, pfad: { typ: 'string', max: 1024, standard: '' } } };
const S_ZUGANG = { typ: 'string', pflicht: true, muster: ZUGANG_ID, hinweis: 'Unbekannte Verbindung' };
const MAX_ZUGAENGE = 20;
const S_ID = { typ: 'string', pflicht: true, muster: ID, hinweis: 'Unbekannte Spiegelung' };

// Laufzeit-Zustand des Moduls (ein Agent je Prozess)
const lauf = new Map();       // id → {abbruch, nochmal, beginn, fortschritt, meldung}
const waechter = new Map();   // id → Waechter
let takt = null;
let werkzeuge = null;
let letzteAufraeumung = 0;
let startTimer = [];

function datenNormal(d) { return { version: 1, auftraege: Array.isArray(d?.auftraege) ? d.auftraege.filter((a) => a && ID.test(a.id)) : [] }; }
async function ladenAuftraege(w) { return datenNormal(await w.konfig.laden(DATEI, { version: 1, auftraege: [] })); }
async function ladenZustand(w) { const z = await w.konfig.laden(ZUSTAND, {}); return z && typeof z === 'object' && !Array.isArray(z) ? z : {}; }
async function zustandAendern(w, id, fn) {
  return w.konfig.aendern(ZUSTAND, (z) => { const d = z && typeof z === 'object' && !Array.isArray(z) ? z : {}; d[id] = fn(d[id] || {}) || d[id]; return d; }, {});
}

function finde(daten, id) {
  const a = daten.auftraege.find((x) => x.id === id);
  if (!a) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Spiegelung gibt es nicht (mehr)', { feld: 'id' });
  return a;
}

/**
 * unison-Archiv je Spiegelung. Ein gemeinsames Archiv je Ordnerpaar (unison-Standard) führte im Praxistest 11.10. zu falschen
 * „was_deleted“-Konflikten, als dieselben Ordner neu angelegt wurden – deshalb je id, verworfen bei Löschen/Ordnerwechsel.
 */
export function unisonOrdner(w, id) { return path.join(w.pfade.konfig, 'spiegelung', 'unison', id); }
async function archivVerwerfen(w, id) { try { await fs.rm(unisonOrdner(w, id), { recursive: true, force: true }); } catch { /* egal */ } }

function melden(w, id, daten) { try { w.ereignis?.('spiegelung', { id, ...daten }); } catch { /* nie werfen */ } }

/** Zustand einer Spiegelung für die Oberfläche. */
function zustandFuer(a, z, jetzt = new Date()) {
  const l = lauf.get(a.id);
  const wa = waechter.get(a.id);
  const naechster = a.aktiv && a.ausloeser === 'zeitplan' ? naechsterZeitpunkt(a, jetzt) : null;
  return {
    laeuft: !!l, fortschritt: l ? l.fortschritt : null, meldung: l ? l.meldung : null, beginn: l ? l.beginn : null,
    letzter: z?.letzter || null, ausstehend: !!z?.ausstehend,
    naechster: naechster ? new Date(naechster).toISOString() : null,
    waechter: a.aktiv && a.ausloeser === 'aenderung' ? (wa ? wa.zustand() : { aktiv: false, fehler: null, wartet: false }) : null,
  };
}

/** Verlaufseintrag anhängen (je Spiegelung die letzten 20). */
async function verlaufEintragen(w, id, eintrag) {
  await w.konfig.aendern(VERLAUF, (v) => {
    const d = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    d[id] = [eintrag, ...(Array.isArray(d[id]) ? d[id] : [])].slice(0, VERLAUF_JE_AUFTRAG);
    return d;
  }, {});
}

/**
 * Stößt einen Lauf an (nicht blockierend). Läuft schon einer, wird „danach noch einmal“ vorgemerkt.
 * @returns {{gestartet:boolean, nochmal?:boolean}}
 */
export function anstossen(w, a, anlass) {
  if (lauf.has(a.id)) { lauf.get(a.id).nochmal = true; return { gestartet: false, nochmal: true }; }
  const l = { abbruch: false, nochmal: false, beginn: new Date().toISOString(), fortschritt: 0, meldung: 'Startet …' };
  lauf.set(a.id, l);
  melden(w, a.id, { zustand: 'laeuft', fortschritt: 0, meldung: l.meldung });
  let letzteMeldung = 0;
  const griff = {
    fortschritt: (anteil, meldung) => {
      l.fortschritt = anteil; if (meldung !== undefined) l.meldung = meldung;
      if (Date.now() - letzteMeldung > 1000) { letzteMeldung = Date.now(); melden(w, a.id, { zustand: 'laeuft', fortschritt: anteil, meldung: l.meldung }); }
    },
    abgebrochen: () => l.abbruch,
  };
  (async () => {
    const beginn = Date.now();
    let eintrag;
    try {
      const r = await laufen(w, a, { griff, unisonOrdner: unisonOrdner(w, a.id) });
      eintrag = { beginn: l.beginn, ende: new Date().toISOString(), dauer_ms: Date.now() - beginn, anlass, ergebnis: r.ergebnis, meldung: r.meldung || '', zahlen: r.zahlen, protokoll: r.protokoll };
      await zustandAendern(w, a.id, (z) => ({ ...z, ausstehend: false }));
    } catch (e) {
      const f = FahnasFehler.aus(e);
      const uebersprungen = istNichtAngeschlossen(f);
      eintrag = {
        beginn: l.beginn, ende: new Date().toISOString(), dauer_ms: Date.now() - beginn, anlass,
        ergebnis: uebersprungen ? 'uebersprungen' : (f.code === 'E_ABGEBROCHEN' ? 'abgebrochen' : 'fehler'), meldung: f.message,
        zahlen: null, protokoll: Array.isArray(f.details?.protokoll) ? f.details.protokoll : (f.details?.ausgabe ? String(f.details.ausgabe).split('\n') : []),
      };
      await zustandAendern(w, a.id, (z) => ({ ...z, ausstehend: uebersprungen }));
    }
    const { protokoll, ...kurz } = eintrag;
    await zustandAendern(w, a.id, (z) => ({ ...z, letzter: kurz })).catch(() => {});
    await verlaufEintragen(w, a.id, eintrag).catch((e) => process.stderr.write(`[spiegelung] Verlauf: ${e.message}\n`));
    lauf.delete(a.id);
    melden(w, a.id, { zustand: 'fertig', ergebnis: eintrag.ergebnis, meldung: eintrag.meldung });
    if (l.nochmal && !l.abbruch) {
      const daten = await ladenAuftraege(w).catch(() => null);
      const neu = daten?.auftraege.find((x) => x.id === a.id);
      if (neu && neu.aktiv) anstossen(w, neu, 'nachlauf');
    }
  })().catch((e) => { lauf.delete(a.id); process.stderr.write(`[spiegelung] Lauf ${a.id}: ${e && e.message}\n`); });
  return { gestartet: true };
}

/**
 * Wächter an die gespeicherten Aufträge angleichen (starten, neu aufsetzen, stoppen). Aufrufe laufen nacheinander – zwei
 * gleichzeitige (Agent-Start + Speichern, Praxistest 11.10.) hätten sonst zwei Wächter für dieselbe Spiegelung anlegen können.
 */
let abgleichKette = Promise.resolve();
export function waechterAbgleichen(w) {
  const lauf = abgleichKette.catch(() => {}).then(() => waechterAbgleichenJetzt(w));
  abgleichKette = lauf;
  return lauf;
}

async function waechterAbgleichenJetzt(w) {
  const d = await ladenAuftraege(w);
  const soll = new Map();
  for (const a of d.auftraege) {
    if (!a.aktiv || a.ausloeser !== 'aenderung') continue;
    try {
      // nur Seiten auf diesem NAS – Änderungen auf einem anderen NAS sieht inotify nicht (die bringt der nächste Lauf mit)
      const pfade = [];
      if (!a.quelle.zugang) pfade.push((await seiteAufloesen(w, a.quelle)).voll);
      if (a.richtung === 'beidseitig' && !a.ziel.zugang) pfade.push((await seiteAufloesen(w, a.ziel)).voll);
      if (pfade.length) soll.set(a.id, { a, pfade });
    } catch { /* Freigabe weg – kein Wächter */ }
  }
  for (const [id, wa] of waechter) {
    const s = soll.get(id);
    if (!s || wa.schluessel !== `${s.pfade.join('|')}#${s.a.wartezeit_min * 60_000}`) { wa.stoppen(); waechter.delete(id); }
  }
  for (const [id, { a, pfade }] of soll) {
    if (waechter.has(id)) continue;
    const wa = new Waechter({
      system: w.system, pfade, wartezeit_ms: a.wartezeit_min * 60_000,
      ausloesen: async () => {
        const aktuell = (await ladenAuftraege(w).catch(() => null))?.auftraege.find((x) => x.id === id);
        if (aktuell && aktuell.aktiv) anstossen(w, aktuell, 'aenderung');
      },
    });
    waechter.set(id, wa);
    wa.starten();
  }
}

/** Sind beide Seiten wieder da? Diese NAS: Laufwerk eingehängt; anderes NAS: SMB (TCP 445) erreichbar. */
async function seitenBereit(w, a) {
  for (const s of [a.quelle, a.ziel]) {
    if (s.zugang) {
      const z = await zugangHolen(w, s.zugang);
      if (z.art === 'cloud') { const h = cloudHost(z); if (!await erreichbar(h.host, { port: h.port })) return false; } else if (!await erreichbar(z.adresse)) return false;
    }
    else if (!(await seiteAufloesen(w, s)).eingehaengt) return false;
  }
  return true;
}

/** Ein Takt des Planers: fällige Zeitplan-Läufe, nachzuholende Läufe (Laufwerk wieder da), täglich Papierkorb aufräumen. */
export async function planen(w, jetzt = new Date()) {
  const daten = await ladenAuftraege(w);
  const zustand = await ladenZustand(w);
  for (const a of daten.auftraege) {
    if (!a.aktiv || lauf.has(a.id)) continue;
    const z = zustand[a.id] || {};
    const faellig = faelligerZeitpunkt(a, jetzt, z.bedient_bis ?? null);
    if (faellig !== null) {
      await zustandAendern(w, a.id, (x) => ({ ...x, bedient_bis: faellig }));
      anstossen(w, a, 'zeitplan');
      continue;
    }
    if (z.ausstehend && a.ausloeser !== 'hand') {
      try { if (await seitenBereit(w, a)) anstossen(w, a, 'nachholen'); } catch { /* Freigabe/Verbindung weg */ }
    }
  }
  if (jetzt.getTime() - letzteAufraeumung > AUFRAEUMEN_MS) {
    letzteAufraeumung = jetzt.getTime();
    for (const a of daten.auftraege) {
      try { const weg = await papierkorbAufraeumen(w, a, jetzt); if (weg.length) process.stdout.write(`[spiegelung] ${a.name}: Papierkorb ${weg.join(', ')} gelöscht (älter als 30 Tage)\n`); } catch (e) { process.stderr.write(`[spiegelung] Papierkorb ${a.id}: ${e.message}\n`); }
    }
    try { const weg = await externeKoerbeAufraeumen(w, daten, jetzt); if (weg.length) process.stdout.write(`[spiegelung] Externe Papierkörbe: ${weg.length} Einträge abgelaufen\n`); } catch { /* nächster Tag */ }
  }
}

export function registriere(reg, w) {
  reg.aktion('spiegelung.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Alle Spiegelungen mit Laufzustand',
    ausfuehren: async () => {
      const daten = await ladenAuftraege(w);
      const zustand = await ladenZustand(w);
      const jetzt = new Date();
      const zugaenge = (await zugaengeLaden(w)).map((z) => ({ id: z.id, name: z.name, adresse: z.adresse }));
      return { auftraege: daten.auftraege.map((a) => ({ ...a, art: artVon(a), zustand: zustandFuer(a, zustand[a.id], jetzt) })), zugaenge, werkzeuge: await werkzeugeDa(w) };
    },
  });

  reg.aktion('spiegelung.speichern', {
    rolle: 'admin', beschreibung: 'Spiegelung anlegen oder ändern',
    schema: {
      id: { typ: 'string', muster: ID, hinweis: 'Unbekannte Spiegelung' }, name: { typ: 'string', pflicht: true, max: 60 },
      aktiv: { typ: 'boolean', standard: true }, art: { typ: 'string', werte: ['sicherung', 'spiegelung'] }, quelle: S_SEITE, ziel: S_SEITE,
      richtung: { typ: 'string', pflicht: true, max: 20 }, ausloeser: { typ: 'string', pflicht: true, max: 20 },
      tage: { typ: 'array', max: 7, elemente: { typ: 'integer', min: 0, max: 6 }, standard: [] },
      zeiten: { typ: 'array', max: 24, elemente: { typ: 'string', max: 5 }, standard: [] },
      wartezeit_min: { typ: 'integer', min: 1, max: 1440, standard: 2 },
      versionen_tage: { typ: 'integer', min: 1, max: 3650 },
    },
    ausfuehren: async (p) => {
      // Freigaben bzw. Verbindungen müssen existieren (externe Laufwerke / andere NAS dürfen gerade weg sein)
      const arten = [];
      for (const s of [p.quelle, p.ziel]) {
        if (s.zugang) arten.push((await zugangHolen(w, s.zugang)).art === 'cloud' ? 'cloud' : 'smb');
        else { arten.push('lokal'); await seiteAufloesen(w, { freigabe: s.freigabe, pfad: '' }); }
      }
      if (arten.includes('cloud')) {
        if (p.richtung !== 'einseitig') throw new FahnasFehler('E_PARAMS', 'Mit Cloud-Speichern geht nur „einseitig“ (NAS → Cloud oder Cloud → NAS)', { feld: 'richtung' });
        if (!arten.includes('lokal')) throw new FahnasFehler('E_PARAMS', 'Eine Seite einer Cloud-Spiegelung muss auf diesem NAS liegen', { feld: 'quelle' });
      }
      let gespeichert;
      let ordnerGewechselt = false;
      await w.konfig.aendern(DATEI, (roh) => {
        const d = datenNormal(roh);
        const vorher = p.id ? finde(d, p.id) : null;
        if (!vorher && d.auftraege.length >= MAX_AUFTRAEGE) throw new FahnasFehler('E_PARAMS', `Höchstens ${MAX_AUFTRAEGE} Spiegelungen`, { feld: 'name' });
        const id = vorher ? vorher.id : `s-${crypto.randomBytes(5).toString('hex')}`;
        gespeichert = auftragNormal(p, { id, vorher });
        ordnerGewechselt = !!vorher && JSON.stringify([vorher.quelle, vorher.ziel, vorher.richtung]) !== JSON.stringify([gespeichert.quelle, gespeichert.ziel, gespeichert.richtung]);
        d.auftraege = vorher ? d.auftraege.map((x) => (x.id === id ? gespeichert : x)) : [...d.auftraege, gespeichert];
        return d;
      }, { version: 1, auftraege: [] });
      if (ordnerGewechselt) await archivVerwerfen(w, gespeichert.id);
      // Ab jetzt planen: vergangene Zeitpunkte von heute nicht sofort nachholen
      await zustandAendern(w, gespeichert.id, (z) => ({ ...z, bedient_bis: Date.now() }));
      await waechterAbgleichen(w);
      w.konfigGeaendert?.('spiegelung');
      return gespeichert;
    },
  });

  reg.aktion('spiegelung.loeschen', {
    rolle: 'admin', beschreibung: 'Spiegelung entfernen (Ordner und Papierkorb bleiben unangetastet)',
    schema: { id: S_ID },
    ausfuehren: async (p) => {
      if (lauf.has(p.id)) throw new FahnasFehler('E_BELEGT', 'Die Spiegelung läuft gerade – bitte erst abbrechen');
      await w.konfig.aendern(DATEI, (roh) => { const d = datenNormal(roh); finde(d, p.id); d.auftraege = d.auftraege.filter((x) => x.id !== p.id); return d; }, { version: 1, auftraege: [] });
      await w.konfig.aendern(ZUSTAND, (z) => { const d = z && typeof z === 'object' ? z : {}; delete d[p.id]; return d; }, {});
      await w.konfig.aendern(VERLAUF, (v) => { const d = v && typeof v === 'object' ? v : {}; delete d[p.id]; return d; }, {});
      await archivVerwerfen(w, p.id);
      await waechterAbgleichen(w);
      w.konfigGeaendert?.('spiegelung');
      return { geloescht: true };
    },
  });

  reg.aktion('spiegelung.starten', {
    rolle: 'admin', beschreibung: 'Jetzt abgleichen (läuft im Hintergrund, Fortschritt als Ereignis „spiegelung“)',
    schema: { id: S_ID },
    ausfuehren: async (p) => {
      const a = finde(await ladenAuftraege(w), p.id);
      return anstossen(w, a, 'hand');
    },
  });

  reg.aktion('spiegelung.abbrechen', {
    rolle: 'admin', beschreibung: 'Laufenden Abgleich abbrechen',
    schema: { id: S_ID },
    ausfuehren: async (p) => {
      const l = lauf.get(p.id);
      if (!l) return { laeuft: false };
      l.abbruch = true; l.nochmal = false;
      return { laeuft: true, abgebrochen: true };
    },
  });

  reg.aktion('spiegelung.vorschau', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Zeigt, was ein einseitiger Abgleich ändern würde (ohne etwas zu ändern)',
    schema: { id: S_ID },
    ausfuehren: async (p, _k, _w, griff) => {
      const a = finde(await ladenAuftraege(w), p.id);
      const r = await laufen(w, a, { vorschau: true, griff, unisonOrdner: unisonOrdner(w, a.id) });
      return { zahlen: r.zahlen, vorschau: r.vorschau };
    },
  });

  // ---- Ältere Stände (Betreiber 12.10.2026: „Sicherung mit Versionen“) ------------------------------------------------
  // Jeder einseitige Lauf legt überschriebene/gelöschte Dateien in <Ziel>/.fah-papierkorb/<Stand> ab. Hier: Stände auf
  // einem Ziel AUF DIESEM NAS auflisten, durchblättern und eine Datei/einen Ordner in die Quelle zurückholen.
  const STAND = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
  const standZeit = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : null; };
  async function versionenOrdner(id) {
    const a = finde(await ladenAuftraege(w), id);
    if (a.ziel.zugang) return { a, ordner: null };
    const z = await seiteAufloesen(w, a.ziel);
    if (!z.eingehaengt) throw new FahnasFehler('E_BELEGT', 'Das Ziel-Laufwerk ist nicht angeschlossen', { feld: 'id' });
    return { a, ziel: z, ordner: path.join(z.wurzel, KORB) };
  }
  async function innerhalb(wurzel, p) {
    const [w0, p0] = await Promise.all([fs.realpath(wurzel), fs.realpath(p)]);
    if (p0 !== w0 && !p0.startsWith(`${w0}/`)) throw new FahnasFehler('E_RECHTE', 'Der Pfad zeigt aus dem Stand hinaus', { feld: 'pfad' });
  }

  reg.aktion('spiegelung.versionen', {
    rolle: 'admin', lesend: true, schema: { id: S_ID }, beschreibung: 'Ältere Stände einer Sicherung (Ziel auf diesem NAS)',
    ausfuehren: async (p) => {
      const { a, ordner } = await versionenOrdner(p.id);
      if (!ordner) return { fern: true, tage: a.versionen_tage || 30, staende: [] };
      const namen = korbStaende(await fs.readdir(ordner).catch(() => []), a.id);
      return { fern: false, tage: a.versionen_tage || 30, staende: namen.map((n) => ({ stand: n, zeit: standZeit(n) })) };
    },
  });

  reg.aktion('spiegelung.versionen.inhalt', {
    rolle: 'admin', lesend: true, schema: { id: S_ID, stand: { typ: 'string', pflicht: true, muster: STAND, hinweis: 'Unbekannter Stand' }, pfad: { typ: 'string', max: 4096 } },
    beschreibung: 'Inhalt eines älteren Stands',
    ausfuehren: async (p) => {
      const { a, ziel, ordner } = await versionenOrdner(p.id);
      if (!ordner) throw new FahnasFehler('E_PARAMS', 'Ältere Stände auf einem anderen NAS oder in der Cloud lassen sich hier nicht durchsuchen', { feld: 'id' });
      const rel = relPfad(p.pfad || '', 'pfad');
      const wurzel = korbOrte(ziel, a.id, p.stand).inhalt;
      const voll = rel ? path.join(wurzel, rel) : wurzel;
      await innerhalb(wurzel, voll);
      const eintraege = [];
      for (const e of await fs.readdir(voll, { withFileTypes: true })) {
        let st = null; try { st = await fs.lstat(path.join(voll, e.name)); } catch { continue; }
        eintraege.push({ name: e.name, ordner: e.isDirectory(), groesse: e.isDirectory() ? null : st.size, geaendert: st.mtime.toISOString() });
      }
      return { pfad: rel, eintraege: eintraege.sort((x, y) => (x.ordner === y.ordner ? x.name.localeCompare(y.name) : x.ordner ? -1 : 1)) };
    },
  });

  reg.aktion('spiegelung.versionen.zurueckholen', {
    rolle: 'admin', schema: { id: S_ID, stand: { typ: 'string', pflicht: true, muster: STAND, hinweis: 'Unbekannter Stand' }, pfad: { typ: 'string', pflicht: true, max: 4096 } },
    beschreibung: 'Datei/Ordner aus einem älteren Stand in die Quelle zurückholen (vorhandenes bleibt, die Kopie bekommt den Stand im Namen)',
    ausfuehren: async (p) => {
      const { a, ziel: stand, ordner } = await versionenOrdner(p.id);
      if (!ordner) throw new FahnasFehler('E_PARAMS', 'Nur für Sicherungen auf ein Laufwerk dieses NAS', { feld: 'id' });
      if (a.quelle.zugang) throw new FahnasFehler('E_PARAMS', 'Die Quelle liegt nicht auf diesem NAS', { feld: 'id' });
      const rel = relPfad(p.pfad, 'pfad');
      if (!rel) throw new FahnasFehler('E_PARAMS', 'Bitte eine Datei oder einen Ordner wählen', { feld: 'pfad' });
      const basis = korbOrte(stand, a.id, p.stand).inhalt;
      const von = path.join(basis, rel);
      await innerhalb(basis, von);
      const q = await seiteAufloesen(w, a.quelle);
      let ziel = path.join(q.voll, rel);
      try {
        await fs.lstat(ziel);
        const ext = path.extname(ziel); const t = p.stand.replace(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\d{2}$/, '$1 $2.$3'); // Ortszeit des Stands
        ziel = `${ziel.slice(0, ziel.length - ext.length)} (Stand ${t})${ext}`;
      } catch { /* frei */ }
      await fs.mkdir(path.dirname(ziel), { recursive: true });
      await innerhalb(q.wurzel, path.dirname(ziel));
      await fs.cp(von, ziel, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
      return { ziel: path.relative(q.wurzel, ziel), freigabe: q.freigabe };
    },
  });

  // ---- Andere NAS (SMB) --------------------------------------------------------------------------------------------
  const benutztVon = async (id) => (await ladenAuftraege(w)).auftraege.filter((a) => a.quelle.zugang === id || a.ziel.zugang === id);

  reg.aktion('spiegelung.zugaenge', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Gespeicherte Verbindungen zu anderen NAS (ohne Passwörter)',
    ausfuehren: async () => {
      const auftraege = (await ladenAuftraege(w)).auftraege;
      return (await zugaengeLaden(w)).map((z) => zugangAnsicht(z, auftraege.filter((a) => a.quelle.zugang === z.id || a.ziel.zugang === z.id).length));
    },
  });

  reg.aktion('spiegelung.zugang.speichern', {
    rolle: 'admin', beschreibung: 'Verbindung zu einem anderen NAS anlegen oder ändern (leeres Passwort = unverändert)',
    schema: {
      id: { typ: 'string', muster: ZUGANG_ID, hinweis: 'Unbekannte Verbindung' }, name: { typ: 'string', pflicht: true, max: 40 },
      adresse: { typ: 'string', max: 260, standard: '' }, benutzer: { typ: 'string', max: 128, standard: '' }, passwort: { typ: 'string', max: 256, standard: '' },
      art: { typ: 'string', werte: ['smb', 'cloud'], standard: 'smb' }, anbieter: { typ: 'string', max: 10 }, endpunkt: { typ: 'string', max: 500 }, region: { typ: 'string', max: 40 },
      hersteller: { typ: 'string', max: 20 }, port: { typ: 'integer', min: 1, max: 65535 }, schluessel_id: { typ: 'string', max: 128 }, schluessel: { typ: 'string', max: 256, standard: '' },
    },
    ausfuehren: async (p) => {
      let gespeichert; let adresseNeu = false;
      await w.konfig.aendern(ZUGAENGE, (roh) => {
        const d = { version: 1, zugaenge: Array.isArray(roh?.zugaenge) ? roh.zugaenge : [] };
        const vorher = p.id ? d.zugaenge.find((z) => z.id === p.id) : null;
        if (p.id && !vorher) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Verbindung gibt es nicht (mehr)', { feld: 'id' });
        if (!vorher && d.zugaenge.length >= MAX_ZUGAENGE) throw new FahnasFehler('E_PARAMS', `Höchstens ${MAX_ZUGAENGE} Verbindungen`, { feld: 'name' });
        const id = vorher ? vorher.id : `z-${crypto.randomBytes(5).toString('hex')}`;
        gespeichert = p.art === 'cloud' ? cloudZugangNormal(p, { id, vorher }) : zugangNormal(p, { id, vorher });
        adresseNeu = !!vorher && vorher.adresse !== gespeichert.adresse;
        d.zugaenge = vorher ? d.zugaenge.map((z) => (z.id === id ? gespeichert : z)) : [...d.zugaenge, gespeichert];
        return d;
      }, { version: 1, zugaenge: [] });
      // anderes NAS → die unison-Archive der Spiegelungen darüber passen nicht mehr
      if (adresseNeu) for (const a of await benutztVon(gespeichert.id)) await archivVerwerfen(w, a.id);
      w.konfigGeaendert?.('spiegelung');
      return zugangAnsicht(gespeichert, (await benutztVon(gespeichert.id)).length);
    },
  });

  reg.aktion('spiegelung.zugang.loeschen', {
    rolle: 'admin', beschreibung: 'Verbindung entfernen (nur wenn keine Spiegelung sie nutzt)',
    schema: { id: S_ZUGANG },
    ausfuehren: async (p) => {
      const nutzer = await benutztVon(p.id);
      if (nutzer.length) throw new FahnasFehler('E_BELEGT', `Wird noch benutzt von: ${nutzer.map((a) => a.name).join(', ')}`);
      await w.konfig.aendern(ZUGAENGE, (roh) => {
        const d = { version: 1, zugaenge: Array.isArray(roh?.zugaenge) ? roh.zugaenge : [] };
        if (!d.zugaenge.some((z) => z.id === p.id)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Verbindung gibt es nicht (mehr)', { feld: 'id' });
        d.zugaenge = d.zugaenge.filter((z) => z.id !== p.id);
        return d;
      }, { version: 1, zugaenge: [] });
      w.konfigGeaendert?.('spiegelung');
      return { geloescht: true };
    },
  });

  reg.aktion('spiegelung.zugang.pruefen', {
    rolle: 'admin', beschreibung: 'Verbindung zu einem anderen NAS prüfen und seine Freigaben auflisten (wenige Sekunden)',
    schema: { id: S_ZUGANG },
    ausfuehren: async (p) => {
      const z = await zugangHolen(w, p.id);
      return { freigaben: z.art === 'cloud' ? await cloudFreigaben(w, z) : await freigabenListen(w, z) };
    },
  });

  reg.aktion('spiegelung.zugang.ordner', {
    rolle: 'admin', lesend: true, beschreibung: 'Unterordner auf einem anderen NAS (für die Ordnerwahl, kurz nur lesend eingehängt)',
    schema: { zugang: S_ZUGANG, freigabe: { typ: 'string', pflicht: true, max: 80 }, pfad: { typ: 'string', max: 1024, standard: '' } },
    ausfuehren: async (p) => {
      const z = await zugangHolen(w, p.zugang);
      const rel = relPfad(p.pfad);
      const freigabe = freigabeFernNormal(p.freigabe);
      return { pfad: rel, ordner: z.art === 'cloud' ? await cloudOrdner(w, z, freigabe, rel) : await ordnerListen(w, z, freigabe, rel) };
    },
  });

  // Betreiber 09.11.2026: in der Ordnerwahl gleich einen neuen Zielordner anlegen – auch auf einem anderen NAS / in der Cloud
  reg.aktion('spiegelung.zugang.ordner.anlegen', {
    rolle: 'admin', beschreibung: 'Neuen Ordner auf einem anderen NAS oder in der Cloud anlegen (für die Ordnerwahl)',
    schema: { zugang: S_ZUGANG, freigabe: { typ: 'string', pflicht: true, max: 80 }, pfad: { typ: 'string', max: 1024, standard: '' }, name: { typ: 'string', pflicht: true, max: 255 } },
    ausfuehren: async (p) => {
      const z = await zugangHolen(w, p.zugang);
      const rel = relPfad(p.pfad);
      const name = ordnerNameNormal(p.name);
      const freigabe = freigabeFernNormal(p.freigabe);
      if (z.art === 'cloud') await cloudOrdnerAnlegen(w, z, freigabe, rel, name); else await ordnerAnlegenFern(w, z, freigabe, rel, name);
      return { pfad: rel ? `${rel}/${name}` : name };
    },
  });

  reg.aktion('spiegelung.verlauf', {
    rolle: 'admin', lesend: true, beschreibung: 'Letzte Läufe einer Spiegelung samt Protokoll',
    schema: { id: S_ID },
    ausfuehren: async (p) => {
      const v = await w.konfig.laden(VERLAUF, {});
      return { laeufe: Array.isArray(v?.[p.id]) ? v[p.id] : [] };
    },
  });
}

/** Start-Haken: Planer-Takt, Wächter, und Änderungs-Spiegelungen einmal nach der Wartezeit (Änderungen ohne Wächter). */
export async function starten(w) {
  werkzeuge = w;
  await waechterAbgleichen(w).catch((e) => process.stderr.write(`[spiegelung] Wächter: ${e.message}\n`));
  try {
    const d = await ladenAuftraege(w);
    for (const a of d.auftraege.filter((x) => x.aktiv && x.ausloeser === 'aenderung')) {
      startTimer.push(setTimeout(async () => {
        const aktuell = (await ladenAuftraege(w).catch(() => null))?.auftraege.find((x) => x.id === a.id);
        if (aktuell && aktuell.aktiv && aktuell.ausloeser === 'aenderung') anstossen(w, aktuell, 'start');
      }, a.wartezeit_min * 60_000));
    }
  } catch (e) { process.stderr.write(`[spiegelung] Start: ${e.message}\n`); }
  takt = setInterval(() => { planen(w).catch((e) => process.stderr.write(`[spiegelung] Planer: ${e.message}\n`)); }, TAKT_MS);
  if (takt.unref) takt.unref();
}

export async function stoppen() {
  clearInterval(takt); takt = null;
  for (const t of startTimer) clearTimeout(t); startTimer = [];
  for (const wa of waechter.values()) wa.stoppen();
  waechter.clear();
  for (const l of lauf.values()) { l.abbruch = true; l.nochmal = false; }
  werkzeuge = null;
}

export const _test = { lauf, waechter, zustandFuer, get werkzeuge() { return werkzeuge; } };
