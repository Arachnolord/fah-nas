#!/usr/bin/env node
// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Holt die freie Länder-Datenbank DB-IP Country Lite (CC BY 4.0) für das Release nach geo/dbip-country-lite.mmdb:
// laufender Monat, bei HTTP 404 der Vormonat; gestreamt entpackt, mit dem eigenen MMDB-Leser geprüft (Typ „Country“,
// Probe 8.8.8.8), atomar ersetzt. Die Datei ist nicht im Git (.gitignore) – tools/build_release.sh ruft dieses
// Werkzeug mit --wenn-noetig auf und packt geo/ ins Release (Rückfall des NAS ohne Internet).
// Aufruf: node tools/geo_holen.mjs [--wenn-noetig] [--ziel <ordner>]
//   --wenn-noetig  nur laden, wenn die Datei fehlt, unlesbar oder älter als 45 Tage ist; scheitert der Download und
//                  eine ältere, lesbare Datei ist da, wird sie mit Warnung weiterverwendet (Exit 0)
//   --ziel         Ordner statt <projekt>/geo

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladeDbip, pruefeDbip, meldungVon, DATEIEN } from '../src/agent/helfer/geo.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GEO_ORDNER = path.join(WURZEL, 'geo');
const TAG_MS = 86_400_000;

/**
 * Lädt die Länder-Datenbank nach `<ziel>/dbip-country-lite.mmdb`.
 * @returns {Promise<{geholt:boolean, monat:string|null, bytes:number, datei:string}>}
 */
export async function holeLaenderDb({ ziel = GEO_ORDNER, wennNoetig = false, holen = globalThis.fetch, jetzt = () => new Date(), maxAlterTage = 45,
  ausgabe = (t) => console.log(t), warnung = (t) => console.error(t) } = {}) {
  const datei = path.join(ziel, DATEIEN.land);
  let vorhanden = null; // { alterTage, metadaten } einer lesbaren vorhandenen Datei
  try {
    const st = await fs.stat(datei);
    const metadaten = await pruefeDbip(datei, 'country');
    vorhanden = { alterTage: (jetzt().getTime() - st.mtimeMs) / TAG_MS, metadaten };
  } catch (e) {
    if (e.code !== 'ENOENT') warnung(`Vorhandene ${DATEIEN.land} ist unbrauchbar (${e.message}) – wird neu geladen.`);
  }
  if (wennNoetig && vorhanden && vorhanden.alterTage < maxAlterTage) {
    ausgabe(`Länder-Ortsdaten aktuell genug (${Math.floor(vorhanden.alterTage)} Tage alt): ${path.relative(process.cwd(), datei) || datei}`);
    return { geholt: false, monat: null, bytes: 0, datei };
  }
  await fs.mkdir(ziel, { recursive: true });
  try {
    const r = await ladeDbip({ art: 'country', ziel: datei, holen, jetzt });
    const m = await pruefeDbip(datei, 'country');
    ausgabe(`Länder-Ortsdaten ${r.monat} geladen: ${path.relative(process.cwd(), datei) || datei} `
      + `(${(r.bytes / 1048576).toFixed(1)} MB, ${m.database_type}, ${m.node_count} Knoten)`);
    return { geholt: true, monat: r.monat, bytes: r.bytes, datei };
  } catch (e) {
    if (wennNoetig && vorhanden) {
      warnung(`WARNUNG: Länder-Ortsdaten konnten nicht geladen werden (${meldungVon(e)}) – die ältere Datei `
        + `(${Math.floor(vorhanden.alterTage)} Tage) wird weiterverwendet.`);
      return { geholt: false, monat: null, bytes: 0, datei };
    }
    throw e;
  }
}

async function hauptprogramm(argv) {
  let wennNoetig = false; let ziel = GEO_ORDNER;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wenn-noetig') wennNoetig = true;
    else if (a === '--ziel' && argv[i + 1]) ziel = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help' || a === 'hilfe') { console.log('Aufruf: node tools/geo_holen.mjs [--wenn-noetig] [--ziel <ordner>]'); return 0; }
    else { console.error(`Unbekannte Option: ${a}`); return 2; }
  }
  try {
    await holeLaenderDb({ ziel, wennNoetig });
    return 0;
  } catch (e) {
    console.error(`FEHLER: Länder-Ortsdaten konnten nicht geladen werden: ${meldungVon(e)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await hauptprogramm(process.argv.slice(2));
}
