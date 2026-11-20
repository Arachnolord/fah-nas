// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „dokument“ (Plan 05, V12): Daten {delta, kommentare}. Das Delta (Quill-Semantik, delta.js) endet immer mit
// einem Zeilenumbruch; Embeds sind bild, seitenumbruch und tabelle. Ops {d?: Delta, k?: {<id>: null | Teiländerung}}:
// Kommentare werden je Feld bzw. je Antwort gesetzt, damit gleichzeitige Antworten nicht verloren gehen; Löschen gewinnt.
// Läuft unverändert im Browser und im Web-Dienst; prüft jede Op vollständig (Formate, Links, Embeds, Grenzen).

import { SyncFehler } from '../fehler.js';
import * as D from '../delta.js';
import { ID_MUSTER, DATEI_MUSTER, ZEILEN_ATTRIBUTE, attributePruefen } from './dokument-attribute.js';
import { tabelle, tabelleWertPruefen, tabellenOpsPruefen } from './dokument-tabelle.js';

export const GRENZEN = Object.freeze({ teilops: 100000, einfuegen: 1000000, kommentar: 5000, name: 100, antworten: 200, alt: 500, bild_min: 16, bild_max: 2000 });
const NUTZER = /^(?=.{1,32}$)[a-z_][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
const ZEIT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const BILD_ATTRIBUTE = Object.freeze(['link', 'kommentar']);

const fehler = (meldung, feld = 'op') => new SyncFehler('E_PARAMS', meldung, { feld });
const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
const eigen = (o, k) => (istObjekt(o) && Object.hasOwn(o, k) ? o[k] : undefined);
function nur(o, felder, feld) {
  if (!istObjekt(o)) throw fehler('Ungültige Angabe', feld);
  for (const k of Object.keys(o)) if (!felder.includes(k)) throw fehler(`Unbekanntes Feld „${String(k).slice(0, 40)}“`, feld);
}

// ---- Embed „bild“ ------------------------------------------------------------------------------------------------

const ohneNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** Embed-Handler für {bild:{datei, breite?, alt?}}: Felder „letzte gewinnt“. */
export const bild = Object.freeze({
  anwenden: (wert, op) => ohneNull({ ...wert, ...op }),
  transformiere: (a, b, seite) => {
    if (seite !== 'links') return a;
    const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !Object.hasOwn(b || {}, k)));
    return Object.keys(rest).length ? rest : null;
  },
  zusammensetzen: (a, b) => ({ ...a, ...b }),
  invertieren: (op, w) => Object.fromEntries(Object.keys(op).map((f) => [f, w?.[f] ?? null])),
});

D.registriereEmbed('bild', bild);
D.registriereEmbed('tabelle', tabelle);

// ---- Prüfen ------------------------------------------------------------------------------------------------------

function bildWertPruefen(b, { aenderung }) {
  nur(b, aenderung ? ['breite', 'alt'] : ['datei', 'breite', 'alt'], 'bild');
  if (!aenderung && (typeof b.datei !== 'string' || !DATEI_MUSTER.test(b.datei))) throw fehler('Bilddatei ungültig', 'bild');
  if (aenderung && !Object.keys(b).length) throw fehler('Nichts zu ändern', 'bild');
  if (b.breite !== undefined && !(aenderung && b.breite === null) && (!Number.isInteger(b.breite) || b.breite < GRENZEN.bild_min || b.breite > GRENZEN.bild_max)) {
    throw fehler(`Bildbreite ${GRENZEN.bild_min}–${GRENZEN.bild_max} px`, 'bild');
  }
  if (b.alt !== undefined && !(aenderung && b.alt === null) && (typeof b.alt !== 'string' || b.alt.length > GRENZEN.alt)) throw fehler(`Bildbeschreibung höchstens ${GRENZEN.alt} Zeichen`, 'bild');
}

function insertPruefen(op) {
  if (typeof op.insert === 'string') {
    if (!op.insert || op.insert.length > GRENZEN.einfuegen) throw fehler(`Einfügetext 1–${GRENZEN.einfuegen} Zeichen`);
    attributePruefen(op.attributes, { zeile: true });
    if (op.attributes && Object.keys(op.attributes).some((k) => ZEILEN_ATTRIBUTE.includes(k)) && !/^\n+$/.test(op.insert)) {
      throw fehler('Zeilenformate nur auf Zeilenumbrüchen', 'attributes');
    }
    return;
  }
  const embed = op.insert;
  if (!istObjekt(embed) || Object.keys(embed).length !== 1) throw fehler('Ungültiges Element');
  const [name, wert] = Object.entries(embed)[0];
  if (name === 'bild') {
    bildWertPruefen(wert, { aenderung: false });
    attributePruefen(op.attributes);
    if (op.attributes && Object.keys(op.attributes).some((k) => !BILD_ATTRIBUTE.includes(k))) throw fehler('Bilder tragen nur Link und Kommentar', 'attributes');
    return;
  }
  if (name === 'seitenumbruch') {
    if (wert !== true) throw fehler('Seitenumbruch ungültig');
    if (op.attributes !== undefined) throw fehler('Seitenumbruch ohne Formate', 'attributes');
    return;
  }
  if (name === 'tabelle') {
    tabelleWertPruefen(wert);
    if (op.attributes !== undefined) throw fehler('Tabelle ohne Formate', 'attributes');
    return;
  }
  throw fehler(`Unbekanntes Element „${String(name).slice(0, 40)}“`);
}

function retainPruefen(op) {
  if (typeof op.retain === 'number') {
    if (!Number.isInteger(op.retain) || op.retain < 1) throw fehler('retain ungültig');
    attributePruefen(op.attributes, { zeile: true, mitNull: true });
    return;
  }
  const e = op.retain;
  if (!istObjekt(e) || Object.keys(e).length !== 1) throw fehler('Ungültige Element-Änderung');
  const [name, wert] = Object.entries(e)[0];
  if (name === 'bild') bildWertPruefen(wert, { aenderung: true });
  else if (name === 'tabelle') tabellenOpsPruefen(wert);
  else throw fehler(`„${String(name).slice(0, 40)}“ lässt sich nicht ändern`);
  attributePruefen(op.attributes, { mitNull: true });
}

/** Delta prüfen; mit `dokument` als ganzes Dokument (nur insert, endet mit '\n'). */
export function deltaPruefen(delta, { dokument = false } = {}) {
  if (!Array.isArray(delta) || delta.length > GRENZEN.teilops) throw fehler(`Höchstens ${GRENZEN.teilops} Teiländerungen`);
  for (const op of delta) {
    if (!istObjekt(op)) throw fehler('Ungültige Teiländerung');
    const art = ['insert', 'retain', 'delete'].filter((k) => op[k] !== undefined);
    if (art.length !== 1) throw fehler('Teiländerung braucht genau eins von insert, retain, delete');
    if (art[0] === 'delete') {
      nur(op, ['delete']);
      if (!Number.isInteger(op.delete) || op.delete < 1) throw fehler('delete ungültig');
    } else if (art[0] === 'retain') {
      nur(op, ['retain', 'attributes']); retainPruefen(op);
    } else {
      nur(op, ['insert', 'attributes']); insertPruefen(op);
    }
  }
  if (dokument) {
    if (delta.some((op) => op.insert === undefined)) throw fehler('Ein Dokument besteht nur aus Einfügungen');
    const l = delta[delta.length - 1];
    if (!l || typeof l.insert !== 'string' || !l.insert.endsWith('\n')) throw fehler('Das Dokument muss mit einem Zeilenumbruch enden');
  }
}

function eintragPruefen(e, feld) {
  nur(e, ['wer', 'name', 'zeit', 'text'], feld);
  if (typeof e.wer !== 'string' || !NUTZER.test(e.wer)) throw fehler('Verfasser ungültig', feld);
  if (typeof e.name !== 'string' || !e.name || e.name.length > GRENZEN.name) throw fehler(`Name 1–${GRENZEN.name} Zeichen`, feld);
  if (typeof e.zeit !== 'string' || !ZEIT.test(e.zeit)) throw fehler('Zeit ungültig', feld);
  if (typeof e.text !== 'string' || !e.text || e.text.length > GRENZEN.kommentar) throw fehler(`Kommentar 1–${GRENZEN.kommentar} Zeichen`, feld);
}

function kPruefen(k) {
  if (!istObjekt(k)) throw fehler('Kommentare ungültig', 'k');
  for (const [id, x] of Object.entries(k)) {
    if (!ID_MUSTER.test(id)) throw fehler('Kommentar-Kennung ungültig', 'k');
    if (x === null) continue;
    nur(x, ['neu', 'erledigt', 'antworten'], 'k');
    if (!Object.keys(x).length) throw fehler('Nichts zu ändern', 'k');
    if (x.neu !== undefined) eintragPruefen(x.neu, 'k.neu');
    if (x.erledigt !== undefined && typeof x.erledigt !== 'boolean') throw fehler('„erledigt“ muss ja/nein sein', 'k');
    if (x.antworten !== undefined) {
      if (!istObjekt(x.antworten) || Object.keys(x.antworten).length > GRENZEN.antworten) throw fehler(`Höchstens ${GRENZEN.antworten} Antworten`, 'k');
      for (const [aid, a] of Object.entries(x.antworten)) {
        if (!ID_MUSTER.test(aid)) throw fehler('Antwort-Kennung ungültig', 'k');
        if (a !== null) eintragPruefen(a, 'k.antworten');
      }
    }
  }
}

/** Op prüfen (Form und Grenzen). Wirft SyncFehler E_PARAMS. */
function pruefen(op) {
  nur(op, ['d', 'k'], null);
  if (op.d === undefined && op.k === undefined) throw fehler('Leere Änderung');
  if (op.d !== undefined) deltaPruefen(op.d);
  if (op.k !== undefined) kPruefen(op.k);
}

/** Ganzes Dokument prüfen (Import, Tests). */
export function dokumentPruefen(daten) {
  nur(daten, ['delta', 'kommentare'], 'daten');
  deltaPruefen(daten.delta, { dokument: true });
  if (!istObjekt(daten.kommentare)) throw fehler('Kommentare ungültig', 'kommentare');
  for (const [id, k] of Object.entries(daten.kommentare)) {
    if (!ID_MUSTER.test(id)) throw fehler('Kommentar-Kennung ungültig', 'kommentare');
    nur(k, ['wer', 'name', 'zeit', 'text', 'erledigt', 'antworten'], 'kommentare');
    eintragPruefen({ wer: k.wer, name: k.name, zeit: k.zeit, text: k.text }, 'kommentare');
    if (typeof k.erledigt !== 'boolean') throw fehler('„erledigt“ muss ja/nein sein', 'kommentare');
    if (!Array.isArray(k.antworten) || k.antworten.length > GRENZEN.antworten) throw fehler(`Höchstens ${GRENZEN.antworten} Antworten`, 'kommentare');
    for (const a of k.antworten) {
      nur(a, ['id', 'wer', 'name', 'zeit', 'text'], 'kommentare');
      if (typeof a.id !== 'string' || !ID_MUSTER.test(a.id)) throw fehler('Antwort-Kennung ungültig', 'kommentare');
      eintragPruefen({ wer: a.wer, name: a.name, zeit: a.zeit, text: a.text }, 'kommentare');
    }
  }
}

/** Kommentare und Antworten nur im eigenen Namen (V12-Haken, vom Server vor transformiere gerufen). */
function autorPruefen(op, nutzer) {
  for (const x of Object.values(op?.k || {})) {
    if (!x) continue;
    if (x.neu && x.neu.wer !== nutzer) throw new SyncFehler('E_RECHTE', 'Kommentare nur im eigenen Namen');
    for (const a of Object.values(x.antworten || {})) if (a && a.wer !== nutzer) throw new SyncFehler('E_RECHTE', 'Kommentare nur im eigenen Namen');
  }
}

// ---- Rechnen -----------------------------------------------------------------------------------------------------

const antwortFolge = (a, b) => (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function leer() { return { delta: [{ insert: '\n' }], kommentare: {} }; }

function anwenden(daten, op) {
  let { delta, kommentare } = daten;
  if (op.d) {
    delta = D.anwenden(delta, op.d);
    const l = delta[delta.length - 1];
    if (!l || typeof l.insert !== 'string' || !l.insert.endsWith('\n')) throw fehler('Das Dokument muss mit einem Zeilenumbruch enden');
  }
  if (op.k) {
    kommentare = { ...kommentare };
    for (const [id, x] of Object.entries(op.k)) {
      if (x === null) { delete kommentare[id]; continue; }
      let k = eigen(kommentare, id);
      // „neu“ setzt die Grunddaten (auch über einen gleichzeitig mit derselben Kennung angelegten – dann gewinnt die spätere)
      if (x.neu) k = { wer: x.neu.wer, name: x.neu.name, zeit: x.neu.zeit, text: x.neu.text, erledigt: k ? k.erledigt : false, antworten: k ? k.antworten : [] };
      if (!k) continue; // Teiländerung an einem fehlenden Kommentar
      if (x.erledigt !== undefined) k = { ...k, erledigt: x.erledigt };
      if (x.antworten) {
        const liste = k.antworten.filter((a) => !Object.hasOwn(x.antworten, a.id));
        for (const [aid, a] of Object.entries(x.antworten)) if (a) liste.push({ id: aid, wer: a.wer, name: a.name, zeit: a.zeit, text: a.text });
        k = { ...k, antworten: liste.sort(antwortFolge) };
      }
      kommentare[id] = k;
    }
  }
  return { delta, kommentare };
}

const nurRetain = (d) => !d || d.every((o) => typeof o.retain === 'number' && !o.attributes);

function transformiere(op, gegen, seite) {
  const aus = {};
  if (op.d) {
    const d = gegen && gegen.d ? D.transformiere(op.d, gegen.d, seite) : op.d;
    if (!nurRetain(d)) aus.d = d;
  }
  if (op.k) {
    const k = {};
    for (const [id, x] of Object.entries(op.k)) {
      const y = eigen(gegen && gegen.k, id);
      if (y === null) continue; // gleichzeitig gelöscht: Löschen gewinnt
      if (x === null || y === undefined || seite !== 'links') { k[id] = x; continue; }
      // beide ändern denselben Kommentar, gegen kam später: dessen Felder gewinnen
      const x2 = {};
      if (x.neu && !y.neu) x2.neu = x.neu;
      if (x.erledigt !== undefined && y.erledigt === undefined) x2.erledigt = x.erledigt;
      if (x.antworten) {
        const a = Object.fromEntries(Object.entries(x.antworten).filter(([aid]) => !Object.hasOwn(y.antworten || {}, aid)));
        if (Object.keys(a).length) x2.antworten = a;
      }
      if (Object.keys(x2).length) k[id] = x2;
    }
    if (Object.keys(k).length) aus.k = k;
  }
  return aus;
}

function zusammensetzen(a, b) {
  const aus = {};
  if (a.d || b.d) aus.d = a.d && b.d ? D.zusammensetzen(a.d, b.d) : (a.d || b.d);
  if (a.k || b.k) {
    const k = { ...(a.k || {}) };
    for (const [id, y] of Object.entries(b.k || {})) {
      const x = eigen(a.k, id);
      if (y === null || x === undefined) { k[id] = y; continue; }
      if (x === null) return null; // gelöscht und danach geändert: nicht zusammensetzbar
      const z = {};
      const neu = y.neu ?? x.neu;
      if (neu) z.neu = neu;
      const erledigt = y.erledigt ?? x.erledigt;
      if (erledigt !== undefined) z.erledigt = erledigt;
      if (x.antworten || y.antworten) z.antworten = { ...(x.antworten || {}), ...(y.antworten || {}) };
      k[id] = z;
    }
    aus.k = k;
  }
  return aus;
}

function istNoop(op) {
  return !op || (nurRetain(op.d) && (!op.k || !Object.keys(op.k).length));
}

/** Auswahl {anker, kopf} gegen eine Op verschieben; `eigen` = eigene Einfügung an der Stelle schiebt mit. */
function auswahlTransformieren(auswahl, op, eigen) {
  if (!auswahl || !op || !op.d) return auswahl;
  return { anker: D.positionTransformieren(auswahl.anker, op.d, !!eigen), kopf: D.positionTransformieren(auswahl.kopf, op.d, !!eigen) };
}

export const dokument = Object.freeze({ name: 'dokument', leer, anwenden, transformiere, zusammensetzen, istNoop, pruefen, auswahlTransformieren, autorPruefen });
export default dokument;
