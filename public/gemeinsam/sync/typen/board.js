// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „board“ (Kanban wie Nextcloud Deck) für den Sync-Motor (V12). Daten: {spalten:[{id, titel, pos}],
// karten:{<id>:{id, spalte, pos, titel, beschreibung, zustaendig, faellig, etiketten, checkliste, kommentare, anhaenge,
// archiviert, erstellt, ersteller}}, etiketten:{<id>:{name, farbe}}}. Ops ändern nie die Eingabe; Transformation nach
// Jupiter-Art: transformiere(op, gegen, seite) – 'rechts' = op kam später (op gewinnt), 'links' = gegen kam später.
// Regeln: Felder „spätere gewinnt“, Verschieben „spätere gewinnt“, Löschen gewinnt immer, Ops auf gelöschte Karten sind
// Noops. Reihenfolgen über Bruchindex-Positionen (pos) mit der ID als Gleichstandsregel.

import { SyncFehler } from '../fehler.js';
import { DATEI_MUSTER, DATEI_MAX_BYTES } from '../konstanten.js';

export const ETIKETT_FARBEN = Object.freeze(['rot', 'orange', 'gelb', 'gruen', 'tuerkis', 'blau', 'lila', 'grau']);
export const OP_TYPEN = Object.freeze([
  'karte_neu', 'karte_setzen', 'karte_verschieben', 'karte_loeschen', 'spalte_neu', 'spalte_setzen', 'spalte_verschieben', 'spalte_loeschen',
  'kommentar', 'checkliste', 'etikett', 'anhang', 'noop',
]);

const ID = /^[A-Za-z0-9_-]{6,24}$/;
const POS = /^[0-9a-z]{1,64}$/;
const DATUM = /^\d{4}-\d\d-\d\d$/;
const NUTZER = /^(?=.{2,31}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
const ZEIT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const MIME = /^[A-Za-z0-9.+-]{1,60}\/[A-Za-z0-9.+-]{1,60}$/;
const DATEINAME = /^[^/\\\u0000-\u001f]{1,200}$/;
const GRENZEN = Object.freeze({ titel: 200, beschreibung: 20000, kommentar: 5000, punkt: 500, spaltentitel: 80, etikettname: 40, etiketten: 20, zustaendig: 50, name: 200, checkliste: 200, kommentare: 1000, anhaenge: 100, karten: 10000 });
const KARTEN_FELDER = Object.freeze(['titel', 'beschreibung', 'zustaendig', 'faellig', 'etiketten', 'archiviert']);
const KARTE_NEU_FELDER = Object.freeze(['id', 'spalte', 'pos', ...KARTEN_FELDER, 'checkliste', 'kommentare', 'anhaenge', 'erstellt', 'ersteller']);
/** Ops, die auf genau eine Karte zielen (werden zu Noops, wenn die Karte gleichzeitig gelöscht wird). */
const KARTEN_OPS = new Set(['karte_setzen', 'karte_verschieben', 'kommentar', 'checkliste', 'anhang']);

const noop = () => ({ typ: 'noop' });
const vergleich = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const eigen = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

/** Nach (pos, id) sortiert – Spalten und Checkpunkte. */
export function sortiert(liste) {
  return [...liste].sort((a, b) => vergleich(a.pos, b.pos) || vergleich(a.id, b.id));
}

const Z = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Bruchindex: eine Position echt zwischen `vor` und `nach` (null = Anfang bzw. Ende); `vor >= nach` → dahinter. */
export function zwischen(vor = null, nach = null) {
  if (vor !== null && nach !== null && vor >= nach) nach = null;
  const a = vor ?? ''; let b = nach; let aus = '';
  for (let i = 0; ; i++) {
    const ca = i < a.length ? Z.indexOf(a[i]) : 0;
    const cb = b !== null && i < b.length ? Z.indexOf(b[i]) : 36;
    if (cb - ca > 1) return aus + Z[Math.floor((ca + cb) / 2)];
    aus += Z[ca];
    if (cb - ca === 1) b = null; // ab hier ist nach oben alles frei
  }
}

// ---- Daten -----------------------------------------------------------------------------------------------------

function leer() {
  return { spalten: [{ id: 'todo00', titel: 'Zu erledigen', pos: 'i' }, { id: 'doing0', titel: 'In Arbeit', pos: 'r' }, { id: 'fertig', titel: 'Erledigt', pos: 'v' }], karten: {}, etiketten: {} };
}

function karteNormal(k) {
  return {
    id: k.id, spalte: k.spalte, pos: k.pos, titel: k.titel ?? '', beschreibung: k.beschreibung ?? '', zustaendig: [...(k.zustaendig || [])], faellig: k.faellig ?? null,
    etiketten: [...(k.etiketten || [])], checkliste: sortiert((k.checkliste || []).map((p) => ({ id: p.id, text: p.text ?? '', erledigt: !!p.erledigt, pos: p.pos }))),
    kommentare: (k.kommentare || []).map((c) => ({ ...c })).sort(kommentarFolge), anhaenge: (k.anhaenge || []).map((a) => ({ ...a })).sort(anhangFolge),
    archiviert: !!k.archiviert, erstellt: k.erstellt, ersteller: k.ersteller,
  };
}

const kommentarFolge = (a, b) => vergleich(a.zeit, b.zeit) || vergleich(a.id, b.id);
const anhangFolge = (a, b) => vergleich(a.name, b.name) || vergleich(a.datei, b.datei);

/** Karte über eine Änderungsfunktion ersetzen; fehlt die Karte oder bleibt sie gleich, kommen die Daten unverändert zurück. */
function mitKarte(daten, id, fn) {
  const k = eigen(daten.karten, id);
  if (!k) return daten;
  const neu = fn(k);
  return neu === k ? daten : { ...daten, karten: { ...daten.karten, [id]: neu } };
}

function anwenden(daten, op) {
  if (!op || op.typ === 'noop') return daten;
  switch (op.typ) {
    case 'karte_neu':
      if (eigen(daten.karten, op.karte.id)) return daten;
      return { ...daten, karten: { ...daten.karten, [op.karte.id]: karteNormal(structuredClone(op.karte)) } };
    case 'karte_setzen':
      return mitKarte(daten, op.id, (k) => ({ ...k, ...structuredClone(op.felder) }));
    case 'karte_verschieben':
      return mitKarte(daten, op.id, (k) => ({ ...k, spalte: op.spalte, pos: op.pos }));
    case 'karte_loeschen': {
      if (!eigen(daten.karten, op.id)) return daten;
      const karten = { ...daten.karten }; delete karten[op.id];
      return { ...daten, karten };
    }
    case 'spalte_neu':
      if (daten.spalten.some((s) => s.id === op.spalte.id)) return daten;
      return { ...daten, spalten: sortiert([...daten.spalten, { id: op.spalte.id, titel: op.spalte.titel, pos: op.spalte.pos }]) };
    case 'spalte_setzen':
      if (!daten.spalten.some((s) => s.id === op.id)) return daten;
      return { ...daten, spalten: daten.spalten.map((s) => (s.id === op.id ? { ...s, titel: op.titel } : s)) };
    case 'spalte_verschieben':
      if (!daten.spalten.some((s) => s.id === op.id)) return daten;
      return { ...daten, spalten: sortiert(daten.spalten.map((s) => (s.id === op.id ? { ...s, pos: op.pos } : s))) };
    case 'spalte_loeschen': {
      const weg = (op.karten || []).filter((id) => eigen(daten.karten, id));
      const spalten = daten.spalten.filter((s) => s.id !== op.id);
      if (!weg.length && spalten.length === daten.spalten.length) return daten;
      const karten = { ...daten.karten }; for (const id of weg) delete karten[id];
      return { ...daten, spalten, karten };
    }
    case 'kommentar':
      return mitKarte(daten, op.karte, (k) => {
        const c = op.kommentar;
        if (c.weg) {
          const alt = k.kommentare.find((x) => x.id === c.id);
          return alt && alt.wer === c.wer ? { ...k, kommentare: k.kommentare.filter((x) => x.id !== c.id) } : k; // nur den eigenen
        }
        const neu = { id: c.id, wer: c.wer, name: c.name, zeit: c.zeit, text: c.text };
        return { ...k, kommentare: [...k.kommentare.filter((x) => x.id !== c.id), neu].sort(kommentarFolge) };
      });
    case 'checkliste':
      return mitKarte(daten, op.karte, (k) => {
        const e = op.eintrag;
        const alt = k.checkliste.find((p) => p.id === e.id);
        if (e.weg) return alt ? { ...k, checkliste: k.checkliste.filter((p) => p.id !== e.id) } : k;
        if (!alt && !e.neu) return k; // inzwischen gelöscht
        const basis = alt || { id: e.id, text: '', erledigt: false, pos: e.pos };
        const neu = { ...basis, ...(e.text !== undefined ? { text: e.text } : {}), ...(e.erledigt !== undefined ? { erledigt: !!e.erledigt } : {}), ...(e.pos !== undefined ? { pos: e.pos } : {}) };
        return { ...k, checkliste: sortiert([...k.checkliste.filter((p) => p.id !== e.id), neu]) };
      });
    case 'etikett': {
      const alt = eigen(daten.etiketten, op.id);
      if (op.etikett.weg) {
        if (!alt) return daten;
        const etiketten = { ...daten.etiketten }; delete etiketten[op.id];
        return { ...daten, etiketten }; // Karten behalten die ID – unbekannte Etiketten zeigt die Ansicht nicht (konvergiert ohne Umbau)
      }
      const neu = { name: op.etikett.name ?? (alt ? alt.name : ''), farbe: op.etikett.farbe ?? (alt ? alt.farbe : 'grau') };
      return { ...daten, etiketten: { ...daten.etiketten, [op.id]: neu } };
    }
    case 'anhang':
      return mitKarte(daten, op.karte, (k) => {
        const a = op.anhang;
        if (a.weg) return k.anhaenge.some((x) => x.datei === a.datei) ? { ...k, anhaenge: k.anhaenge.filter((x) => x.datei !== a.datei) } : k;
        const neu = { datei: a.datei, name: a.name, groesse: a.groesse, mime: a.mime };
        return { ...k, anhaenge: [...k.anhaenge.filter((x) => x.datei !== a.datei), neu].sort(anhangFolge) };
      });
    default:
      return daten;
  }
}

// ---- Transformation -------------------------------------------------------------------------------------------

function karteVon(op) { return op.typ === 'karte_setzen' || op.typ === 'karte_verschieben' ? op.id : op.karte; }
function geloeschteKarten(op) { return op.typ === 'karte_loeschen' ? [op.id] : op.typ === 'spalte_loeschen' ? (op.karten || []) : []; }

/** Felder eines Setzers, die `gegen` ebenfalls setzt, fallen weg (gegen kam später); leer → noop. */
function ohneFelder(felder, gegenFelder) {
  const aus = {};
  for (const [k, v] of Object.entries(felder)) if (!Object.hasOwn(gegenFelder, k)) aus[k] = v;
  return Object.keys(aus).length ? aus : null;
}

/** Setzer gegen Setzer am selben Ziel: 'rechts' gewinnt op, 'links' gewinnt gegen (je Feld). */
function setzerGegen(op, gegen, seite, schluessel, felderOp, felderGegen) {
  if (seite === 'rechts') return op;
  const rest = ohneFelder(felderOp, felderGegen);
  return rest ? { ...op, [schluessel]: rest } : noop();
}

/** Felder eines Checkpunkts ohne Steuerangaben. */
function punktFelder(e) { const aus = {}; for (const k of ['text', 'erledigt', 'pos']) if (e[k] !== undefined) aus[k] = e[k]; return aus; }

function transformiere(op, gegen, seite) {
  if (!op || !gegen || op.typ === 'noop' || gegen.typ === 'noop') return op;
  // Löschen gewinnt: Ops auf eine gleichzeitig gelöschte Karte bzw. Spalte werden Noops
  if (KARTEN_OPS.has(op.typ) && geloeschteKarten(gegen).includes(karteVon(op))) return noop();
  if ((op.typ === 'spalte_setzen' || op.typ === 'spalte_verschieben') && gegen.typ === 'spalte_loeschen' && gegen.id === op.id) return noop();
  if (op.typ !== gegen.typ) return op;
  switch (op.typ) {
    case 'karte_setzen':
      return op.id === gegen.id ? setzerGegen(op, gegen, seite, 'felder', op.felder, gegen.felder) : op;
    case 'spalte_setzen':
      return op.id === gegen.id && seite === 'links' ? noop() : op;
    case 'karte_verschieben':
    case 'spalte_verschieben':
      return op.id === gegen.id && seite === 'links' ? noop() : op;
    case 'checkliste': {
      if (op.karte !== gegen.karte || op.eintrag.id !== gegen.eintrag.id) return op;
      if (gegen.eintrag.weg) return op.eintrag.weg ? op : noop();
      if (op.eintrag.weg) return op;
      if (seite === 'rechts') return op;
      const rest = ohneFelder(punktFelder(op.eintrag), punktFelder(gegen.eintrag));
      if (!rest) return noop();
      return { ...op, eintrag: { id: op.eintrag.id, ...(op.eintrag.neu ? { neu: true } : {}), ...rest } };
    }
    case 'etikett': {
      if (op.id !== gegen.id) return op;
      if (gegen.etikett.weg) return op.etikett.weg ? op : noop();
      if (op.etikett.weg) return op;
      return setzerGegen(op, gegen, seite, 'etikett', op.etikett, gegen.etikett);
    }
    case 'kommentar': {
      if (op.karte !== gegen.karte || op.kommentar.id !== gegen.kommentar.id) return op;
      if (gegen.kommentar.weg) return op.kommentar.weg || op.kommentar.wer !== gegen.kommentar.wer ? op : noop();
      if (op.kommentar.weg) return op;
      return seite === 'links' ? noop() : op; // gleiche ID zweimal angelegt: die spätere gilt
    }
    case 'anhang': {
      if (op.karte !== gegen.karte || op.anhang.datei !== gegen.anhang.datei) return op;
      if (gegen.anhang.weg) return op.anhang.weg ? op : noop();
      if (op.anhang.weg) return op;
      return seite === 'links' ? noop() : op;
    }
    default:
      return op; // karte_neu/spalte_neu: eindeutige IDs; doppeltes Löschen ist idempotent
  }
}

/** Zwei aufeinanderfolgende eigene Ops zu einer zusammenfassen (nur Setzer/Verschieben desselben Ziels), sonst null. */
function zusammensetzen(a, b) {
  if (!a || !b || a.typ !== b.typ) return null;
  switch (a.typ) {
    case 'karte_setzen': return a.id === b.id ? { typ: a.typ, id: a.id, felder: { ...a.felder, ...b.felder } } : null;
    case 'spalte_setzen': case 'karte_verschieben': case 'spalte_verschieben': return a.id === b.id ? b : null;
    case 'etikett': return a.id === b.id && !a.etikett.weg && !b.etikett.weg ? { typ: 'etikett', id: a.id, etikett: { ...a.etikett, ...b.etikett } } : null;
    case 'checkliste':
      return a.karte === b.karte && a.eintrag.id === b.eintrag.id && !a.eintrag.weg && !b.eintrag.weg ? { typ: 'checkliste', karte: a.karte, eintrag: { ...a.eintrag, ...b.eintrag } } : null;
    default: return null;
  }
}

function istNoop(op) { return !op || op.typ === 'noop'; }

/** Auswahl im Board = geöffnete Karte {karte}; wird sie gelöscht, gibt es keine Auswahl mehr. */
function auswahlTransformieren(auswahl, op) {
  if (!auswahl || !auswahl.karte || !op) return auswahl;
  return geloeschteKarten(op).includes(auswahl.karte) ? { ...auswahl, karte: null } : auswahl;
}

// ---- Prüfung --------------------------------------------------------------------------------------------------

const fehler = (meldung, feld) => new SyncFehler('E_PARAMS', meldung, feld ? { feld } : undefined);
function objekt(o, erlaubt, feld) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw fehler('Ungültige Angabe', feld);
  for (const k of Object.keys(o)) if (!erlaubt.includes(k)) throw fehler(`Unbekanntes Feld „${k}“`, feld ? `${feld}.${k}` : k);
}
function textPruefen(v, max, feld, min = 0) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw fehler(`„${feld}“: ${min}–${max} Zeichen`, feld);
}
function muster(v, re, feld) { if (typeof v !== 'string' || !re.test(v)) throw fehler(`„${feld}“ ist ungültig`, feld); }
function liste(v, max, re, feld) {
  if (!Array.isArray(v) || v.length > max) throw fehler(`„${feld}“: höchstens ${max} Einträge`, feld);
  for (const x of v) muster(x, re, feld);
  if (new Set(v).size !== v.length) throw fehler(`„${feld}“ enthält Doppelte`, feld);
}

function kartenFelderPruefen(f, feld) {
  if (f.titel !== undefined) textPruefen(f.titel, GRENZEN.titel, `${feld}.titel`);
  if (f.beschreibung !== undefined) textPruefen(f.beschreibung, GRENZEN.beschreibung, `${feld}.beschreibung`);
  if (f.zustaendig !== undefined) liste(f.zustaendig, GRENZEN.zustaendig, NUTZER, `${feld}.zustaendig`);
  if (f.faellig !== undefined && f.faellig !== null) muster(f.faellig, DATUM, `${feld}.faellig`);
  if (f.etiketten !== undefined) liste(f.etiketten, GRENZEN.etiketten, ID, `${feld}.etiketten`);
  if (f.archiviert !== undefined && typeof f.archiviert !== 'boolean') throw fehler('„archiviert“ muss ja/nein sein', `${feld}.archiviert`);
}

function kommentarPruefen(c, feld) {
  if (c && c.weg !== undefined) { objekt(c, ['id', 'wer', 'weg'], feld); if (c.weg !== true) throw fehler('„weg“ muss true sein', feld); }
  else { objekt(c, ['id', 'wer', 'name', 'zeit', 'text'], feld); textPruefen(c.name, GRENZEN.name, `${feld}.name`, 1); muster(c.zeit, ZEIT, `${feld}.zeit`); textPruefen(c.text, GRENZEN.kommentar, `${feld}.text`, 1); }
  muster(c.id, ID, `${feld}.id`); muster(c.wer, NUTZER, `${feld}.wer`);
}

function punktPruefen(e, feld) {
  objekt(e, ['id', 'text', 'erledigt', 'pos', 'neu', 'weg'], feld);
  muster(e.id, ID, `${feld}.id`);
  if (e.weg !== undefined) { if (e.weg !== true || Object.keys(e).length !== 2) throw fehler('Löschen nur mit {id, weg:true}', feld); return; }
  if (e.neu !== undefined && e.neu !== true) throw fehler('„neu“ muss true sein', `${feld}.neu`);
  if (e.neu && (e.text === undefined || e.pos === undefined)) throw fehler('Neuer Checkpunkt braucht Text und Position', feld);
  if (e.text === undefined && e.erledigt === undefined && e.pos === undefined) throw fehler('Nichts zu ändern', feld);
  if (e.text !== undefined) textPruefen(e.text, GRENZEN.punkt, `${feld}.text`);
  if (e.erledigt !== undefined && typeof e.erledigt !== 'boolean') throw fehler('„erledigt“ muss ja/nein sein', `${feld}.erledigt`);
  if (e.pos !== undefined) muster(e.pos, POS, `${feld}.pos`);
}

function anhangPruefen(a, feld) {
  if (a && a.weg !== undefined) { objekt(a, ['datei', 'weg'], feld); if (a.weg !== true) throw fehler('„weg“ muss true sein', feld); muster(a.datei, DATEI_MUSTER, `${feld}.datei`); return; }
  objekt(a, ['datei', 'name', 'groesse', 'mime'], feld);
  muster(a.datei, DATEI_MUSTER, `${feld}.datei`); muster(a.name, DATEINAME, `${feld}.name`); muster(a.mime, MIME, `${feld}.mime`);
  if (!Number.isInteger(a.groesse) || a.groesse < 0 || a.groesse > DATEI_MAX_BYTES) throw fehler('„groesse“ ungültig', `${feld}.groesse`);
}

function kartePruefen(k) {
  objekt(k, KARTE_NEU_FELDER, 'karte');
  muster(k.id, ID, 'karte.id'); muster(k.spalte, ID, 'karte.spalte'); muster(k.pos, POS, 'karte.pos');
  textPruefen(k.titel, GRENZEN.titel, 'karte.titel');
  kartenFelderPruefen(k, 'karte');
  muster(k.erstellt, ZEIT, 'karte.erstellt'); muster(k.ersteller, NUTZER, 'karte.ersteller');
  for (const [name, max] of [['checkliste', GRENZEN.checkliste], ['kommentare', GRENZEN.kommentare], ['anhaenge', GRENZEN.anhaenge]]) {
    if (k[name] !== undefined && (!Array.isArray(k[name]) || k[name].length > max)) throw fehler(`„${name}“: höchstens ${max} Einträge`, `karte.${name}`);
  }
  for (const p of k.checkliste || []) { objekt(p, ['id', 'text', 'erledigt', 'pos'], 'karte.checkliste'); muster(p.id, ID, 'karte.checkliste.id'); textPruefen(p.text, GRENZEN.punkt, 'karte.checkliste.text'); muster(p.pos, POS, 'karte.checkliste.pos'); }
  for (const c of k.kommentare || []) {
    if (c && c.weg !== undefined) throw fehler('Eine neue Karte enthält keine gelöschten Kommentare', 'karte.kommentare');
    kommentarPruefen(c, 'karte.kommentare');
  }
  for (const a of k.anhaenge || []) anhangPruefen(a, 'karte.anhaenge');
}

/** Wirft SyncFehler E_PARAMS, wenn die Op nicht in Form und Grenzen passt (Server und Klient prüfen gleich). */
function pruefen(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op) || !OP_TYPEN.includes(op.typ)) throw fehler('Unbekannte Änderung', 'typ');
  const nur = (felder) => objekt(op, ['typ', ...felder], null);
  switch (op.typ) {
    case 'noop': nur([]); return;
    case 'karte_neu': nur(['karte']); kartePruefen(op.karte); return;
    case 'karte_setzen':
      nur(['id', 'felder']); muster(op.id, ID, 'id'); objekt(op.felder, KARTEN_FELDER, 'felder');
      if (!Object.keys(op.felder).length) throw fehler('Nichts zu ändern', 'felder');
      kartenFelderPruefen(op.felder, 'felder'); return;
    case 'karte_verschieben': nur(['id', 'spalte', 'pos']); muster(op.id, ID, 'id'); muster(op.spalte, ID, 'spalte'); muster(op.pos, POS, 'pos'); return;
    case 'karte_loeschen': nur(['id']); muster(op.id, ID, 'id'); return;
    case 'spalte_neu':
      nur(['spalte']); objekt(op.spalte, ['id', 'titel', 'pos'], 'spalte');
      muster(op.spalte.id, ID, 'spalte.id'); textPruefen(op.spalte.titel, GRENZEN.spaltentitel, 'spalte.titel'); muster(op.spalte.pos, POS, 'spalte.pos'); return;
    case 'spalte_setzen': nur(['id', 'titel']); muster(op.id, ID, 'id'); textPruefen(op.titel, GRENZEN.spaltentitel, 'titel'); return;
    case 'spalte_verschieben': nur(['id', 'pos']); muster(op.id, ID, 'id'); muster(op.pos, POS, 'pos'); return;
    case 'spalte_loeschen': nur(['id', 'karten']); muster(op.id, ID, 'id'); liste(op.karten, GRENZEN.karten, ID, 'karten'); return;
    case 'kommentar': nur(['karte', 'kommentar']); muster(op.karte, ID, 'karte'); kommentarPruefen(op.kommentar, 'kommentar'); return;
    case 'checkliste': nur(['karte', 'eintrag']); muster(op.karte, ID, 'karte'); punktPruefen(op.eintrag, 'eintrag'); return;
    case 'etikett': {
      nur(['id', 'etikett']); muster(op.id, ID, 'id');
      const e = op.etikett;
      if (e && e.weg !== undefined) { objekt(e, ['weg'], 'etikett'); if (e.weg !== true) throw fehler('„weg“ muss true sein', 'etikett'); return; }
      objekt(e, ['name', 'farbe'], 'etikett');
      if (e.name === undefined && e.farbe === undefined) throw fehler('Nichts zu ändern', 'etikett');
      if (e.name !== undefined) textPruefen(e.name, GRENZEN.etikettname, 'etikett.name');
      if (e.farbe !== undefined && !ETIKETT_FARBEN.includes(e.farbe)) throw fehler('Unbekannte Farbe', 'etikett.farbe');
      return;
    }
    case 'anhang': nur(['karte', 'anhang']); muster(op.karte, ID, 'karte'); anhangPruefen(op.anhang, 'anhang'); return;
    default: throw fehler('Unbekannte Änderung', 'typ');
  }
}

/** Kommentare und neue Karten nur im eigenen Namen (V12-Haken, vom Server vor transformiere gerufen). */
function autorPruefen(op, nutzer) {
  if (op && op.typ === 'kommentar' && op.kommentar && op.kommentar.wer !== nutzer) throw new SyncFehler('E_RECHTE', 'Kommentare nur im eigenen Namen');
  if (op && op.typ === 'karte_neu' && op.karte && op.karte.ersteller !== nutzer) throw new SyncFehler('E_RECHTE', 'Karten nur im eigenen Namen anlegen');
  if (op && op.typ === 'karte_neu' && op.karte && (op.karte.kommentare || []).some((c) => !c || c.wer !== nutzer)) throw new SyncFehler('E_RECHTE', 'Kommentare nur im eigenen Namen');
}

export const board = Object.freeze({ name: 'board', leer, anwenden, transformiere, zusammensetzen, istNoop, pruefen, auswahlTransformieren, autorPruefen });
export default board;
