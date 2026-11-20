// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordner-Favoriten je Nutzer (Betreiber 13.11.2026: „ordner als favouriten markieren und im menübaum einen favouriten
// eintrag um schnell zu einem dieser ordner navigieren zu können“). Gespeichert in users.json → einstellungen.favoriten
// ({liste: [{freigabe, pfad}]}) über nutzer.einstellungen.lesen/setzen – kein eigener Agent-Weg nötig.
// Markiert wird in „Dateien“ (Stern neben den Brotkrumen, Menü eines Ordners); gezeigt in der Navigation unter
// „Dateien“ (aufklappbar, Standard eingeklappt) und als Kachel in der Übersicht.

import { api } from './api.js';

export const BEREICH = 'favoriten';
export const MAX = 50;

let nutzer = null;
let liste = [];
const hoerer = new Set();

function pfadNormal(p) { return String(p || '').split('/').filter((s) => s !== '' && s !== '.').join('/'); }

/** Gespeicherte Form → saubere Liste (unbekanntes fällt weg, doppelte nur einmal, höchstens MAX). */
export function normal(roh) {
  if (!Array.isArray(roh)) return [];
  const gesehen = new Set();
  const aus = [];
  for (const f of roh) {
    if (!f || typeof f.freigabe !== 'string' || !f.freigabe) continue;
    const e = { freigabe: f.freigabe, pfad: pfadNormal(f.pfad) };
    const k = `${e.freigabe}\u0000${e.pfad}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    aus.push(e);
    if (aus.length >= MAX) break;
  }
  return aus;
}

function melden() { for (const fn of hoerer) { try { fn(alle()); } catch (e) { console.warn('[favoriten]', e && e.message); } } }

/** Nach der Anmeldung: Favoriten des Nutzers holen. Fehler → leere Liste (die Oberfläche läuft ohne weiter). */
export async function laden(name) {
  nutzer = name || null;
  try {
    const r = nutzer ? await api('nutzer.einstellungen.lesen', { name: nutzer, bereich: BEREICH }) : null;
    liste = normal(r && r.wert && r.wert.liste);
  } catch { liste = []; }
  melden();
  return alle();
}

/** Beim Abmelden. */
export function zuruecksetzen() { nutzer = null; liste = []; melden(); }

const sortierer = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Alphabetisch nach Anzeigename (Betreiber 13.11.2026), bei Gleichstand nach Ort. */
export function alle() {
  return liste.map((f) => ({ ...f })).sort((a, b) => sortierer.compare(anzeigeName(a), anzeigeName(b)) || sortierer.compare(ort(a), ort(b)));
}

export function ist(freigabe, pfad) {
  const p = pfadNormal(pfad);
  return liste.some((f) => f.freigabe === freigabe && f.pfad === p);
}

/** Anzeigename: letzter Ordner, in der Freigabe-Wurzel der Freigabename. */
export function anzeigeName(f) { return f.pfad ? f.pfad.split('/').pop() : f.freigabe; }

/** Voller Ort für Tooltips: „medien/Urlaub/2026“. */
export function ort(f) { return f.pfad ? `${f.freigabe}/${f.pfad}` : f.freigabe; }

/**
 * Mehrere Ordner auf einmal (Mehrfachauswahl in „Dateien“): `an` = true nimmt alle auf, false nimmt alle heraus.
 * `ordner` = [{freigabe, pfad}]. Liefert die Zahl der tatsächlich geänderten Einträge.
 */
export async function setzen(ordner, an) {
  if (!nutzer) throw new Error('Nicht angemeldet.');
  let basis = liste;
  try {
    const r = await api('nutzer.einstellungen.lesen', { name: nutzer, bereich: BEREICH });
    basis = normal(r && r.wert && r.wert.liste);
  } catch { /* mit dem lokalen Stand weiter */ }
  const ziele = normal(ordner);
  const gleich = (a, b) => a.freigabe === b.freigabe && a.pfad === b.pfad;
  let neu;
  let geaendert = 0;
  if (an) {
    neu = [...basis];
    for (const z of ziele) if (!neu.some((f) => gleich(f, z))) { neu.push(z); geaendert++; }
  } else {
    neu = basis.filter((f) => !ziele.some((z) => gleich(f, z)));
    geaendert = basis.length - neu.length;
  }
  if (neu.length > MAX) {
    const f = new Error(`Höchstens ${MAX} Favoriten.`);
    f.code = 'E_ZU_VIELE';
    throw f;
  }
  if (geaendert) await api('nutzer.einstellungen.setzen', { name: nutzer, bereich: BEREICH, wert: { liste: neu } });
  liste = neu;
  melden();
  return geaendert;
}

/** Meldet jede Änderung (Navigation, Übersicht, Stern in „Dateien“); liefert die Abmeldung. */
export function beiAenderung(fn) { hoerer.add(fn); return () => hoerer.delete(fn); }

/**
 * Ordner zu den Favoriten nehmen bzw. wieder herausnehmen. Liefert true, wenn er danach Favorit ist.
 * Vor dem Speichern wird der gespeicherte Stand frisch gelesen – ein zweiter Browser-Tab geht so nicht verloren.
 */
export async function umschalten(freigabe, pfad) {
  if (!nutzer) throw new Error('Nicht angemeldet.');
  const p = pfadNormal(pfad);
  let basis = liste;
  try {
    const r = await api('nutzer.einstellungen.lesen', { name: nutzer, bereich: BEREICH });
    basis = normal(r && r.wert && r.wert.liste);
  } catch { /* mit dem lokalen Stand weiter */ }
  const war = basis.some((f) => f.freigabe === freigabe && f.pfad === p);
  const neu = war ? basis.filter((f) => !(f.freigabe === freigabe && f.pfad === p)) : [...basis, { freigabe, pfad: p }];
  if (neu.length > MAX) {
    const f = new Error(`Höchstens ${MAX} Favoriten.`);
    f.code = 'E_ZU_VIELE';
    throw f;
  }
  await api('nutzer.einstellungen.setzen', { name: nutzer, bereich: BEREICH, wert: { liste: neu } });
  liste = neu;
  melden();
  return !war;
}
