// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kleine Schema-Prüfung für Aktionsparameter und Konfigurationsdateien (kein Fremdpaket).
// Schema: { feld: { typ, pflicht?, muster?, min?, max?, werte?, elemente?, felder?, standard? } }

import { FahnasFehler } from './fehler.js';

const TYPEN = new Set(['string', 'number', 'boolean', 'array', 'object', 'integer']);

function typVon(w) {
  if (Array.isArray(w)) return 'array';
  if (w === null) return 'null';
  return typeof w;
}

/**
 * Prüft `daten` gegen `schema`. Unbekannte Felder sind ein Fehler (verhindert Tippfehler und Schmuggelware).
 * Gibt ein neues Objekt mit Standardwerten zurück.
 */
export function pruefe(schema, daten, pfad = '') {
  if (typVon(daten) !== 'object') throw new FahnasFehler('E_PARAMS', 'Parameter müssen ein Objekt sein', { feld: pfad || 'params' });
  const aus = {};
  for (const feld of Object.keys(daten)) {
    if (!(feld in schema)) throw new FahnasFehler('E_PARAMS', `Unbekanntes Feld „${feld}“`, { feld: pfad + feld });
  }
  for (const [feld, regel] of Object.entries(schema)) {
    const voll = pfad + feld;
    let wert = daten[feld];
    if (wert === undefined || wert === null) {
      if (regel.pflicht) throw new FahnasFehler('E_PARAMS', `„${feld}“ fehlt`, { feld: voll });
      if (regel.standard !== undefined) aus[feld] = typeof regel.standard === 'function' ? regel.standard() : structuredClone(regel.standard);
      continue;
    }
    aus[feld] = pruefeWert(regel, wert, voll, feld);
  }
  return aus;
}

function pruefeWert(regel, wert, voll, feld) {
  if (!TYPEN.has(regel.typ)) throw new FahnasFehler('E_UNBEKANNT', `Schema-Fehler: unbekannter Typ ${regel.typ}`);
  const t = typVon(wert);
  if (regel.typ === 'integer') {
    if (t !== 'number' || !Number.isInteger(wert)) throw new FahnasFehler('E_PARAMS', `„${feld}“ muss eine ganze Zahl sein`, { feld: voll });
  } else if (t !== regel.typ) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“ hat den falschen Typ (erwartet ${regel.typ})`, { feld: voll });
  }
  if (regel.typ === 'string') {
    if (regel.min !== undefined && wert.length < regel.min) throw new FahnasFehler('E_PARAMS', `„${feld}“ ist zu kurz (mind. ${regel.min})`, { feld: voll });
    if (regel.max !== undefined && wert.length > regel.max) throw new FahnasFehler('E_PARAMS', `„${feld}“ ist zu lang (max. ${regel.max})`, { feld: voll });
    if (regel.muster && !regel.muster.test(wert)) throw new FahnasFehler('E_PARAMS', regel.hinweis || `„${feld}“ hat ein ungültiges Format`, { feld: voll });
  }
  if (regel.typ === 'number' || regel.typ === 'integer') {
    if (!Number.isFinite(wert)) throw new FahnasFehler('E_PARAMS', `„${feld}“ ist keine gültige Zahl`, { feld: voll });
    if (regel.min !== undefined && wert < regel.min) throw new FahnasFehler('E_PARAMS', `„${feld}“ ist zu klein (mind. ${regel.min})`, { feld: voll });
    if (regel.max !== undefined && wert > regel.max) throw new FahnasFehler('E_PARAMS', `„${feld}“ ist zu groß (max. ${regel.max})`, { feld: voll });
  }
  if (regel.werte && !regel.werte.includes(wert)) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“ muss einer dieser Werte sein: ${regel.werte.join(', ')}`, { feld: voll });
  }
  if (regel.typ === 'array') {
    if (regel.max !== undefined && wert.length > regel.max) throw new FahnasFehler('E_PARAMS', `„${feld}“ hat zu viele Einträge (max. ${regel.max})`, { feld: voll });
    if (regel.elemente) return wert.map((e, i) => pruefeWert(regel.elemente, e, `${voll}[${i}]`, feld));
  }
  if (regel.typ === 'object' && regel.felder) return pruefe(regel.felder, wert, voll + '.');
  return wert;
}

/** Nutzername (Linux/Samba): klein, beginnt mit Buchstabe, 2–31 Zeichen aus a-z, 0-9, - und _, dazu einzelne Punkte
 *  zwischen zwei Teilen (m.mustermann) – nie am Anfang, am Ende oder doppelt (kein „..“ in Pfaden). */
export const MUSTER_NUTZERNAME = /^(?=.{2,31}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
/** Nutzer- oder @Gruppenname in Listen (Freigaberechte, Sichtbarkeit). */
export const MUSTER_NUTZER_ODER_GRUPPE = /^(?:@[a-z][a-z0-9_-]{0,31}|(?=.{1,32}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)$/;

/** Häufige Regeln als Bausteine. */
export const R = Object.freeze({
  nutzername: { typ: 'string', pflicht: true, muster: MUSTER_NUTZERNAME, hinweis: 'Nutzername: klein, beginnt mit Buchstabe, 2–31 Zeichen aus a-z, 0-9, -, _ und Punkt (z. B. m.mustermann)' },
  freigabename: { typ: 'string', pflicht: true, muster: /^[a-z0-9][a-z0-9_-]{0,31}$/, hinweis: 'Freigabename: klein, 1–32 Zeichen aus a-z, 0-9, - und _' },
  passwort: { typ: 'string', pflicht: true, min: 8, max: 256 },
  text: (max = 200) => ({ typ: 'string', max }),
  pfad: { typ: 'string', max: 4096, standard: '' },
  ja_nein: { typ: 'boolean' },
  liste_namen: { typ: 'array', max: 500, elemente: { typ: 'string', max: 64, muster: MUSTER_NUTZER_ODER_GRUPPE, hinweis: 'Nutzer- oder @Gruppenname ungültig' } },
});
