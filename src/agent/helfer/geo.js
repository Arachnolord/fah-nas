// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ortsbestimmung für die Weltkarte – vollständig lokal, keine IP verlässt den NAS:
//   • Stadt-Datenbank DB-IP City Lite (CC BY 4.0): monatlich von download.db-ip.com nach PFADE.geo (/data/geo)
//     geladen, gestreamt entpackt in eine Temp-Datei daneben, mit dem eigenen MMDB-Leser geprüft, atomar umbenannt.
//     Prüfung beim Start und alle 6 h; geladen wird nur, wenn der Stand älter als der laufende Monat ist; nach einem
//     Fehler frühestens nach 1 h wieder. Die alte Datei bleibt bis zum erfolgreichen Austausch in Gebrauch.
//   • Länder-Datenbank DB-IP Country Lite + laender.json (Landesmitten, deutsche Namen) liegen im Programm
//     (PFADE.geoMit) – Rückfall ohne Internet oder bei abgeschalteter Einstellung „Ortsdaten monatlich laden“.
// Private Adressen bekommen keinen Ort (die Karte bündelt sie als „Heimnetz“), Anycast-Adressen liegen überall
// zugleich und liefern { anycast:true }.

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { oeffneMmdb } from './mmdb.js';
import { ipNormal, istPrivat, ANYCAST } from './netzadressen.js';

export { istPrivat, ANYCAST, istAnycast, ipNormal } from './netzadressen.js';

export const DATEIEN = Object.freeze({
  stadt: 'dbip-city-lite.mmdb', land: 'dbip-country-lite.mmdb', laender: 'laender.json', stand: 'stand.json',
});
export const DBIP_QUELLE = 'https://download.db-ip.com/free';
const PRUEF_TAKT_MS = 6 * 3_600_000;     // Prüfung alle 6 h
const WIEDERHOLEN_MS = 3_600_000;        // nach einem Fehler frühestens nach 1 h wieder
const ZEITLIMIT_MS = 10 * 60_000;        // ganzer Download (~60 MB gz) – reicht ab ~1 Mbit/s
const MAX_ENTPACKT = 512 * 1024 * 1024;  // Schutz gegen endlose/entgleiste Antworten (City Lite entpackt ~130 MB)

/** Monat 'JJJJ-MM' eines Zeitpunkts in UTC (DB-IP benennt die Dateien nach UTC-Monat). */
export function monatVon(datum) {
  return datum.toISOString().slice(0, 7);
}

/** Monat davor, über den Jahreswechsel hinweg. */
export function vormonat(monat) {
  const [j, m] = monat.split('-').map(Number);
  return m === 1 ? `${j - 1}-12` : `${j}-${String(m - 1).padStart(2, '0')}`;
}

/** Download-Adresse der Lite-Datenbank `art` ('city' | 'country') eines Monats. */
export function dbipUrl(art, monat, quelle = DBIP_QUELLE) {
  return `${quelle}/dbip-${art}-lite-${monat}.mmdb.gz`;
}

/** Monat aus build_epoch (Sekunden) der Metadaten; unbrauchbar → null. */
function monatAusEpoch(epoch) {
  const s = typeof epoch === 'bigint' ? Number(epoch) : epoch;
  return Number.isFinite(s) && s > 0 ? monatVon(new Date(s * 1000)) : null;
}

/**
 * Stichproben der Prüfung: Google/Cloudflare-DNS, Google IPv6, Canonical (Ubuntu-Spiegel), GitHub – Adressen, die der
 * NAS tatsächlich anspricht. Keine davon darf beim Nachschlagen werfen (z. B. Budget des MMDB-Lesers gerissen).
 */
export const STICHPROBEN = Object.freeze(['8.8.8.8', '1.1.1.1', '2a00:1450::1', '91.189.91.113', '140.82.121.4']);

/**
 * Prüft eine heruntergeladene Datei: MMDB lesbar, database_type passt zur Art, keine Stichprobe wirft beim
 * Nachschlagen, Probe 8.8.8.8 liefert ein Land.
 * @returns {Promise<object>} Metadaten
 */
export async function pruefeDbip(datei, art) {
  const db = await oeffneMmdb(datei);
  try {
    const typ = String(db.metadaten.database_type ?? '');
    if (!(art === 'city' ? /city/i : /country/i).test(typ)) throw new Error(`falscher Datenbanktyp „${typ}“`);
    const treffer = new Map();
    for (const ip of STICHPROBEN) {
      try { treffer.set(ip, db.suche(ip)); } catch (e) { throw new Error(`Probe ${ip}: ${e.message}`); }
    }
    if (!treffer.get('8.8.8.8')?.country?.iso_code) throw new Error('Probe 8.8.8.8 liefert kein Land');
    return db.metadaten;
  } finally { await db.schliessen(); }
}

/** Lesbare Fehlerursache: fetch meldet nur „fetch failed“ (Ursache in e.cause), das Zeitlimit als TimeoutError. */
export function meldungVon(e) {
  if (e?.name === 'TimeoutError') return 'Zeitlimit überschritten';
  const ursache = e?.cause?.code || e?.cause?.message;
  return ursache ? `${e.message} (${ursache})` : String(e?.message ?? e);
}

async function verwerfen(res) {
  try { await res.body?.cancel(); } catch { /* schon zu */ }
}

/**
 * Lädt die DB-IP-Lite-Datenbank `art` nach `ziel`: laufender Monat, bei HTTP 404 der Vormonat (die neue Datei
 * erscheint erst in den ersten Tagen des Monats). Entpackt gestreamt in `<ziel>.<pid>.<zufall>.tmp` im selben Ordner,
 * prüft sie und benennt sie atomar um; bei jedem Fehler wird die Temp-Datei gelöscht und `ziel` bleibt unberührt.
 * `bekannt` = schon vorhandener Monat: ist nichts Neueres zu haben, wird nichts geladen ({neu:false}).
 * @returns {Promise<{monat:string, bytes:number, neu:boolean}>}
 */
export async function ladeDbip({ art, ziel, holen = globalThis.fetch, jetzt = () => new Date(), bekannt = null, quelle = DBIP_QUELLE,
  signal, zeitlimit_ms = ZEITLIMIT_MS, maxBytes = MAX_ENTPACKT }) {
  const aktuell = monatVon(jetzt());
  for (const monat of [aktuell, vormonat(aktuell)]) {
    if (bekannt && monat <= bekannt) return { monat: bekannt, bytes: 0, neu: false };
    const zeit = AbortSignal.timeout(zeitlimit_ms);
    const sig = signal ? AbortSignal.any([signal, zeit]) : zeit;
    const res = await holen(dbipUrl(art, monat, quelle), { signal: sig });
    if (res.status === 404) { await verwerfen(res); continue; }
    if (!res.ok || !res.body) { await verwerfen(res); throw new Error(`HTTP ${res.status} für ${monat}`); }
    const tmp = `${ziel}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      let bytes = 0;
      const zaehler = new Transform({
        transform(stueck, _kodierung, weiter) {
          bytes += stueck.length;
          if (bytes > maxBytes) weiter(new Error(`entpackte Datei größer als ${maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${maxBytes} Byte`}`));
          else weiter(null, stueck);
        },
      });
      await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), zaehler, createWriteStream(tmp, { mode: 0o644, flush: true }), { signal: sig });
      await pruefeDbip(tmp, art);
      await fs.rename(tmp, ziel);
      return { monat, bytes, neu: true };
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  throw new Error(`keine Datei für ${aktuell} oder ${vormonat(aktuell)} (HTTP 404)`);
}

/** Bevorzugt deutscher Name. */
function nameDe(namen) {
  return typeof namen?.de === 'string' && namen.de ? namen.de : null;
}
function nameEn(namen) {
  return typeof namen?.en === 'string' && namen.en ? namen.en : null;
}

/** laender.json → { CC: {name, lat, lon} } (nur gültige Einträge). Fehlt/kaputt → {}. */
async function leseLaender(datei, protokoll) {
  let roh;
  try { roh = JSON.parse(await fs.readFile(datei, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') protokoll(`Landesmitten (${path.basename(datei)}) unlesbar: ${e.message}`);
    return {};
  }
  const aus = {};
  for (const [cc, l] of Object.entries(roh?.laender ?? {})) {
    if (/^[A-Z]{2}$/.test(cc) && Number.isFinite(l?.lat) && Number.isFinite(l?.lon)) aus[cc] = { name: typeof l.name === 'string' ? l.name : cc, lat: l.lat, lon: l.lon };
  }
  return aus;
}

/**
 * Geo-Verwaltung des Agenten.
 * @param {{pfade:{mit:string, daten:string}, holen?:Function, jetzt?:()=>Date, stadtLaden?:()=>boolean, protokoll?:(text:string)=>void}} o
 */
export function erzeugeGeo({ pfade, holen = globalThis.fetch, jetzt = () => new Date(), stadtLaden = () => true, protokoll = () => {} }) {
  const datei = {
    stadt: path.join(pfade.daten, DATEIEN.stadt), stand: path.join(pfade.daten, DATEIEN.stand),
    land: path.join(pfade.mit, DATEIEN.land), laender: path.join(pfade.mit, DATEIEN.laender),
  };
  let stadt = null;          // geöffnete Stadt-DB (oder null)
  let land = null;           // geöffnete Länder-DB (oder null)
  let laender = {};          // Landesmitten
  let stand = null;          // Monat der Stadt-DB
  let fehler = null;         // { zeit(ms), meldung } des letzten gescheiterten Downloads
  let laeuft = null;         // laufender Download (Promise) – gleichzeitige Aufrufe teilen ihn
  let abbruch = null;        // AbortController des laufenden Downloads
  let zeitgeber = null;
  let gestartet = false;
  let letzterSuchfehler = '';

  const laden = () => { try { return stadtLaden() !== false; } catch { return true; } };

  async function oeffnen(pfad) {
    try { return await oeffneMmdb(pfad); } catch (e) {
      if (e.code !== 'ENOENT') protokoll(`${path.basename(pfad)} unbrauchbar: ${e.message}`);
      return null;
    }
  }

  /** Temp-Reste abgebrochener Downloads (Stromausfall, Absturz) entfernen – nur eigene Namen. */
  async function aufraeumen() {
    let namen = [];
    try { namen = await fs.readdir(pfade.daten); } catch { return; }
    for (const n of namen) {
      if (n.endsWith('.tmp') && (n.startsWith(DATEIEN.stadt) || n.startsWith(DATEIEN.stand))) await fs.rm(path.join(pfade.daten, n), { force: true }).catch(() => {});
    }
  }

  async function leseStand() {
    if (!stadt) return null;
    try {
      const j = JSON.parse(await fs.readFile(datei.stand, 'utf8'));
      if (typeof j?.monat === 'string' && /^\d{4}-\d{2}$/.test(j.monat)) return j.monat;
    } catch { /* fehlt/kaputt → aus den Metadaten */ }
    return monatAusEpoch(stadt.metadaten.build_epoch);
  }

  async function schreibeStand(inhalt) {
    const tmp = `${datei.stand}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(inhalt, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(tmp, datei.stand);
  }

  function quelle() {
    if (stadt && laden()) return 'stadt';
    if (land && Object.keys(laender).length) return 'land';
    return 'keine';
  }

  function status() {
    const q = quelle();
    let hinweis = null;
    if (fehler && laden()) hinweis = `Städte-Ortsdaten konnten nicht geladen werden (${fehler.meldung}) – neuer Versuch frühestens in einer Stunde.`;
    else if (q === 'keine') hinweis = 'Keine Ortsdaten vorhanden – Orte werden nicht bestimmt.';
    else if (q === 'land' && laden() && laeuft) hinweis = 'Städte-Ortsdaten werden geladen – bis dahin nur Länder.';
    const standQ = q === 'stadt' ? stand : q === 'land' ? monatAusEpoch(land.metadaten.build_epoch) : null;
    return { quelle: q, stand: standQ, hinweis };
  }

  function ortAusStadt(r) {
    const cc = typeof r?.country?.iso_code === 'string' ? r.country.iso_code.toUpperCase() : null;
    if (!cc) return null;
    const mitte = laender[cc];
    const lat = r.location?.latitude; const lon = r.location?.longitude;
    const genau = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!genau && !mitte) return null;
    return {
      land: cc, land_name: mitte?.name ?? nameDe(r.country.names) ?? nameEn(r.country.names) ?? cc, // kurz wie auf der Karte (DB-IP de ist lang)
      stadt: nameDe(r.city?.names) ?? nameEn(r.city?.names) ?? null,
      lat: genau ? lat : mitte.lat, lon: genau ? lon : mitte.lon, genau: genau ? 'stadt' : 'land',
    };
  }

  function ortAusLand(r) {
    const cc = typeof r?.country?.iso_code === 'string' ? r.country.iso_code.toUpperCase() : null;
    const mitte = cc ? laender[cc] : null;
    if (!mitte) return null;
    return { land: cc, land_name: mitte.name ?? nameDe(r.country.names) ?? nameEn(r.country.names) ?? cc, stadt: null, lat: mitte.lat, lon: mitte.lon, genau: 'land' };
  }

  /** Ort einer Adresse: privat/Unsinn → null, Anycast → {anycast:true}, sonst Ort aus Stadt- bzw. Länder-DB oder null. */
  function suche(ip) {
    const a = ipNormal(ip);
    if (!a || istPrivat(a)) return null;
    if (ANYCAST.has(a)) return { anycast: true };
    try {
      if (stadt && laden()) {
        const ort = ortAusStadt(stadt.suche(a));
        if (ort) return ort;
      }
      if (land) return ortAusLand(land.suche(a));
    } catch (e) {
      if (e.message !== letzterSuchfehler) { letzterSuchfehler = e.message; protokoll(`Ortssuche: ${e.message}`); }
    }
    return null;
  }

  async function herunterladen(erzwingen) {
    const ctrl = new AbortController();
    abbruch = ctrl;
    try {
      await fs.mkdir(pfade.daten, { recursive: true });
      const r = await ladeDbip({ art: 'city', ziel: datei.stadt, holen, jetzt, bekannt: erzwingen ? null : stand, signal: ctrl.signal });
      if (r.neu) {
        // Datei liegt schon am Platz → Stand sofort festhalten (sonst lädt der nächste Start dieselbe Datei noch einmal)
        await schreibeStand({ monat: r.monat, geladen: jetzt().toISOString(), bytes: r.bytes });
        if (ctrl.signal.aborted) return; // während des Downloads gestoppt – der nächste Start öffnet die neue Datei
        const neu = await oeffneMmdb(datei.stadt);
        if (ctrl.signal.aborted) { await neu.schliessen(); return; }
        const alt = stadt;
        stadt = neu; stand = r.monat;
        if (alt) await alt.schliessen().catch(() => {});
        protokoll(`Städte-Ortsdaten ${r.monat} geladen (${(r.bytes / 1048576).toFixed(1)} MB)`);
      }
      fehler = null;
    } catch (e) {
      if (ctrl.signal.aborted) return;
      fehler = { zeit: jetzt().getTime(), meldung: meldungVon(e) };
      protokoll(`Städte-Ortsdaten konnten nicht geladen werden: ${fehler.meldung}`);
    } finally {
      laeuft = null; abbruch = null;
    }
  }

  /** Lädt die Stadt-DB, wenn nötig (bzw. erzwungen); liefert danach status(). */
  async function aktualisieren({ erzwingen = false } = {}) {
    if (!laden()) return status();
    if (!laeuft) {
      if (!erzwingen) {
        if (stand && stand >= monatVon(jetzt())) return status();
        if (fehler && jetzt().getTime() - fehler.zeit < WIEDERHOLEN_MS) return status();
      }
      laeuft = herunterladen(erzwingen);
    }
    await laeuft;
    return status();
  }

  async function starten() {
    if (gestartet) return; // läuft schon – nichts doppelt öffnen (Marke vor dem ersten await: auch gleichzeitig sicher)
    gestartet = true;
    await aufraeumen();
    laender = await leseLaender(datei.laender, protokoll);
    land = await oeffnen(datei.land);
    stadt = await oeffnen(datei.stadt);
    stand = await leseStand();
    zeitgeber = setInterval(() => { aktualisieren().catch((e) => protokoll(`Prüfung: ${e.message}`)); }, PRUEF_TAKT_MS);
    if (typeof zeitgeber.unref === 'function') zeitgeber.unref();
    aktualisieren().catch((e) => protokoll(`Prüfung: ${e.message}`)); // im Hintergrund – der Start wartet nicht auf 60 MB
  }

  async function stoppen() {
    if (zeitgeber) { clearInterval(zeitgeber); zeitgeber = null; }
    abbruch?.abort();
    if (laeuft) await laeuft.catch(() => {});
    const offen = [stadt, land];
    stadt = null; land = null; stand = null; gestartet = false;
    for (const db of offen) if (db) await db.schliessen().catch(() => {});
  }

  return { starten, stoppen, suche, status, aktualisieren };
}
