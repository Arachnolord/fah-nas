// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kopieren als anderer Nutzer (Plan 02, V10): eine Datei, die der Ziel-Nutzer selbst nicht lesen darf (z. B. ein
// Anhang im Chat-Speicher, root 0700), landet trotzdem nur dort, wo ER schreiben darf – mit seinen Rechten:
// `cat` läuft mit den IDs der Quelle, `dd` mit den IDs des Ziels in eine Zwischendatei im Zielordner, danach legt der
// Dateihelfer (als Ziel-Nutzer) sie ab („Name (2).ext“ bei Gleichnamigem). Keine Shell, keine Zwischendatei bleibt liegen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { pruefeDateiname } from '../../gemeinsam/pfade.js';
import { helfer, idsFuer, plattenPlatz, kontingentFrei } from '../aktionen/dateien.js';

const ERLAUBT = ['beide', 'fehler'];

const ende = (kind) => new Promise((ok) => {
  let fertig = false;
  kind.on('error', () => { if (!fertig) { fertig = true; ok(-1); } });
  kind.on('close', (code) => { if (!fertig) { fertig = true; ok(code ?? -1); } });
});

/** Datenstrom von quelleAbs (als quelleIds) nach zielAbs (als zielIds); gibt die Anzahl Bytes zurück. */
export async function stromKopieren(w, { quelleAbs, quelleIds, zielAbs, zielIds }) {
  const cat = w.system.starten('cat', ['--', quelleAbs], { ...quelleIds, stdio: ['ignore', 'pipe', 'pipe'] });
  const dd = w.system.starten('dd', [`of=${zielAbs}`, 'bs=1M', 'status=none'], { ...zielIds, stdio: ['pipe', 'ignore', 'pipe'] });
  let bytes = 0;
  cat.stdout.on('data', (d) => { bytes += d.length; });
  cat.stdout.pipe(dd.stdin);
  dd.stdin.on('error', () => {}); // EPIPE nie als uncaughtException
  let fehlertext = '';
  for (const k of [cat, dd]) if (k.stderr) k.stderr.on('data', (d) => { if (fehlertext.length < 2000) fehlertext += String(d); });
  const [c1, c2] = await Promise.all([ende(cat), ende(dd)]);
  if (c1 !== 0 || c2 !== 0) throw new FahnasFehler('E_SYSTEM', 'Kopieren fehlgeschlagen', { code_cat: c1, code_dd: c2, ausgabe: fehlertext.trim().slice(0, 500) });
  return bytes;
}

/**
 * Kopiert quelleAbs als zielName in zielOrdnerAbs mit den Rechten von zielKontext. Ergebnis {pfad (absolut), name}.
 * beiVorhanden: 'beide' (Standard, „Name (2).ext“) oder 'fehler' (E_EXISTIERT); 'ersetzen' gibt es hier nicht.
 */
export async function kopierenAls(w, { quelleAbs, quelleIds, zielOrdnerAbs, zielName, zielKontext, beiVorhanden = 'beide' }) {
  pruefeDateiname(zielName, 'name');
  if (!ERLAUBT.includes(beiVorhanden)) throw new FahnasFehler('E_PARAMS', 'Ersetzen ist beim Kopieren aus dem Chat nicht vorgesehen', { feld: 'bei_vorhanden' });
  let groesse;
  try { groesse = (await fs.stat(quelleAbs)).size; } catch (e) { throw FahnasFehler.aus(e); }
  const wurzel = zielOrdnerAbs;
  const ziel = await helfer(w, zielKontext, 'pruefe_schreiben', { wurzel, pfad: zielName, bei_vorhanden: beiVorhanden });
  const platte = await plattenPlatz(w.system, wurzel);
  const kontingent = await kontingentFrei(w.system, wurzel);
  const frei = Math.min(platte.frei, kontingent ?? Infinity);
  if (groesse > frei) throw new FahnasFehler('E_PLATZ', 'Nicht genug freier Platz am Ziel', { noetig: groesse, frei });
  const zielIds = await idsFuer(w, zielKontext, wurzel);
  try {
    await stromKopieren(w, { quelleAbs, quelleIds, zielAbs: ziel.tmp, zielIds });
  } catch (e) {
    await helfer(w, zielKontext, 'upload_verwerfen', { wurzel, pfad: zielName, tmp: ziel.tmp }).catch(() => {});
    throw e;
  }
  const erg = await helfer(w, zielKontext, 'upload_abschliessen', { wurzel, pfad: zielName, tmp: ziel.tmp, bei_vorhanden: beiVorhanden, papierkorb: false, nutzer: zielKontext.nutzer }, { zeitlimit_ms: 0 });
  return { pfad: path.join(zielOrdnerAbs, erg.name), name: erg.name };
}
