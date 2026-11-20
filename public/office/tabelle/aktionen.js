// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen der Office-Tabelle (Plan 06) als Ops des Datentyps „tabelle“: Eingabe, Leeren, Formate, Kopieren und
// Einfügen, Ausfüllen nach unten, Sortieren, Zeilen/Spalten und neues Blatt. Alle Funktionen sind rein – sie lesen
// die Daten (und für Werte den Rechner) und bauen eine Op; anwenden und senden macht der Editor. Bereiche sind
// {z1, s1, z2, s2} (1-basiert, z1 ≤ z2, s1 ≤ s2). Formeln wandern beim Einfügen, Ausfüllen und Sortieren relativ mit
// (formelVerschieben), Formate kommen beim Einfügen, Ausfüllen und Sortieren voll mit (fehlende Felder → null).
// Zu große Bereiche → Error('zu_viel'). Ohne DOM.

import { GRENZEN, adresse, adresseLesen, bereichText } from './formeln/adresse.js';
import { eingabeZuIntern } from './formeln/uebersetzen.js';
import { formelVerschieben } from './formeln/verschieben.js';
import { wertAnzeigen, vergleichen } from './formeln/werte.js';
import { bereichVon } from './auswahl.js';
import { tsvLesen, tsvSchreiben } from './zwischenablage.js';
import { LEER_F } from '../../gemeinsam/sync/typen/tabelle.js';
import { zwischen } from '../../gemeinsam/sync/typen/board.js';
import { neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';

/** Zellschlüssel dürfen nach dem Einfügen jenseits von GRENZEN liegen. */
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });
const HEUTE_JETZT = /^=\s*(?:TODAY|NOW)\s*\(\s*\)\s*$/i;

const zuViel = () => new Error('zu_viel');
const groesse = (b) => (b.z2 - b.z1 + 1) * (b.s2 - b.s1 + 1);
const zellenVon = (daten, blattId) => (daten?.blaetter ?? []).find((b) => b.id === blattId)?.zellen ?? {};
const zellenOp = (blattId, werte) => ({ typ: 'zellen', blatt: blattId, werte });
/** Nur Formeln wandern; Text wie 'A1 bliebe sonst nicht, was er ist. */
const verschoben = (w, dz, ds) => (typeof w === 'string' && w.startsWith('=') && (dz || ds) ? formelVerschieben(w, dz, ds) : w);
/** Zelle mit vollem Format (jedes fehlende Feld null) – so ersetzt sie Wert und Format am Ziel ganz. */
const voll = (w, f) => ({ w: w ?? null, f: { ...LEER_F, ...(f || {}) } });
const innerhalb = (o, b) => o.z >= b.z1 && o.z <= b.z2 && o.s >= b.s1 && o.s <= b.s2;

/**
 * Text wie getippt → Eintrag {w, f?}: eingabeZuIntern mit dem Zahlformat der Zelle (wirft FormelFehler); ein erkanntes
 * Format (12,5 % → prozent) und =HEUTE()/=JETZT() als ganze Formel (→ datum) setzen f.zahl nur, wenn die Zelle noch
 * keines hat.
 */
function eintragAusEingabe(blaetter, alt, text) {
  const eigenes = alt?.f?.zahl ?? null;
  const e = eingabeZuIntern(text, { blaetter, zahl: eigenes });
  const zahl = e.zahl ?? (typeof e.w === 'string' && HEUTE_JETZT.test(e.w) ? 'datum' : null);
  return zahl && !eigenes ? { w: e.w, f: { zahl } } : { w: e.w };
}

/** Eingabe in Zelle (z, s) → zelle-Op; wirft FormelFehler. */
export function eingabeOp(daten, blattId, z, s, text) {
  const zelle = adresse(z, s);
  return { typ: 'zelle', blatt: blattId, zelle, ...eintragAusEingabe(daten?.blaetter ?? [], zellenVon(daten, blattId)[zelle], text) };
}

/** Werte im Bereich leeren, Formate bleiben → zellen-Op (nur Zellen mit Wert) oder null. */
export function leerenOp(daten, blattId, bereich) {
  const werte = {};
  for (const [adr, zelle] of Object.entries(zellenVon(daten, blattId))) {
    if (typeof zelle?.w !== 'string') continue;
    const o = adresseLesen(adr, OHNE_GRENZEN);
    if (o && innerhalb(o, bereich)) werte[adr] = { w: null };
  }
  const anzahl = Object.keys(werte).length;
  if (anzahl > GRENZEN.zellen_op) throw zuViel();
  return anzahl ? zellenOp(blattId, werte) : null;
}

/**
 * Ein Formatfeld im Bereich setzen (wert null = entfernen) → zellen-Op. fett/kursiv mit 'umschalten': true, außer alle
 * Zellen haben es schon – dann null.
 */
export function formatOp(daten, blattId, bereich, feld, wert) {
  if (groesse(bereich) > GRENZEN.zellen_op) throw zuViel();
  const zellen = zellenVon(daten, blattId);
  let neu = wert;
  if ((feld === 'fett' || feld === 'kursiv') && wert === 'umschalten') {
    let alle = true;
    for (let z = bereich.z1; z <= bereich.z2 && alle; z++) for (let s = bereich.s1; s <= bereich.s2 && alle; s++) alle = zellen[adresse(z, s)]?.f?.[feld] === true;
    neu = alle ? null : true;
  }
  const werte = {};
  for (let z = bereich.z1; z <= bereich.z2; z++) for (let s = bereich.s1; s <= bereich.s2; s++) werte[adresse(z, s)] = { f: { [feld]: neu } };
  return zellenOp(blattId, werte);
}

/**
 * Bereich kopieren → { tsv (angezeigte Werte für andere Programme), intern (JSON {quelle:{z,s}, zellen:[[{w,f}|null]]}
 * mit Formeln und Formaten) }. Über GRENZEN.zellen_op → zu_viel (so viel ließe sich ohnehin nicht einfügen).
 */
export function kopieren(daten, rechner, blattId, bereich) {
  if (groesse(bereich) > GRENZEN.zellen_op) throw zuViel();
  const zellen = zellenVon(daten, blattId), anzeige = [], intern = [];
  for (let z = bereich.z1; z <= bereich.z2; z++) {
    const zeileA = [], zeileI = [];
    for (let s = bereich.s1; s <= bereich.s2; s++) {
      const adr = adresse(z, s), zelle = zellen[adr];
      const hatW = typeof zelle?.w === 'string';
      zeileA.push(hatW ? wertAnzeigen(rechner.wert(blattId, adr), zelle.f?.zahl ?? null) : '');
      zeileI.push(hatW || zelle?.f ? { w: hatW ? zelle.w : null, f: zelle.f ?? null } : null);
    }
    anzeige.push(zeileA); intern.push(zeileI);
  }
  return { tsv: tsvSchreiben(anzeige), intern: JSON.stringify({ quelle: { z: bereich.z1, s: bereich.s1 }, zellen: intern }) };
}

/**
 * Einfügen ab `ziel` {z, s} → zellen-Op oder null (nichts einzufügen). inhalt {art:'tsv', text}: jedes Feld wie getippt
 * (Formeln erlaubt, erkanntes Zahlformat wie bei der Eingabe), leere Felder leeren den Wert; {art:'intern', json}: Wert
 * und volles Format, Formeln relativ verschoben, Lücken leeren Wert und Format. Eine einzelne Zelle in eine größere
 * Auswahl füllt die ganze Auswahl. Ziele jenseits von GRENZEN fallen weg; mehr als GRENZEN.zellen_op → zu_viel. Wirft
 * FormelFehler (TSV) bzw. SyntaxError (kaputtes JSON).
 */
export function einfuegenOp(daten, blattId, ziel, inhalt, { blaetter = daten?.blaetter ?? [], auswahl = null } = {}) {
  const intern = inhalt?.art === 'intern';
  const kopie = intern ? JSON.parse(inhalt.json) : null;
  const matrix = intern ? (Array.isArray(kopie?.zellen) ? kopie.zellen : []) : tsvLesen(inhalt?.text ?? '');
  const hoehe = matrix.length, breite = matrix.reduce((m, zeile) => Math.max(m, zeile.length), 0);
  if (!hoehe || !breite) return null;
  const quelle = intern ? { z: Number(kopie.quelle?.z) || 1, s: Number(kopie.quelle?.s) || 1 } : null;

  // Zielzellen: [z, s, Feld der Matrix]
  const ziele = [];
  if (hoehe === 1 && breite === 1 && auswahl && groesse(auswahl) > 1) {
    if (groesse(auswahl) > GRENZEN.zellen_op) throw zuViel();
    for (let z = auswahl.z1; z <= auswahl.z2; z++) for (let s = auswahl.s1; s <= auswahl.s2; s++) ziele.push([z, s, 0, 0]);
  } else {
    if (hoehe * breite > GRENZEN.zellen_op) throw zuViel();
    for (let i = 0; i < hoehe; i++) for (let j = 0; j < breite; j++) ziele.push([ziel.z + i, ziel.s + j, i, j]);
  }

  const zellen = zellenVon(daten, blattId), werte = {};
  for (const [z, s, i, j] of ziele) {
    if (z > GRENZEN.zeilen || s > GRENZEN.spalten) continue;
    const adr = adresse(z, s), feld = matrix[i]?.[j];
    if (!intern) { werte[adr] = eintragAusEingabe(blaetter, zellen[adr], typeof feld === 'string' ? feld : ''); continue; }
    // intern: das Feld stammt aus (quelle.z + i, quelle.s + j)
    werte[adr] = feld && typeof feld === 'object' ? voll(verschoben(feld.w ?? null, z - (quelle.z + i), s - (quelle.s + j)), feld.f) : voll(null, null);
  }
  return Object.keys(werte).length ? zellenOp(blattId, werte) : null;
}

/**
 * Ausfüllen nach unten → zellen-Op oder null: Quelle ist die erste Zeile des Bereichs (bei nur einer Zeile die Zeile
 * darüber; Zeile 1 → null), jede Zielzeile bekommt ihren Wert (Formeln relativ verschoben) und ihr volles Format.
 */
export function ausfuellenOp(daten, blattId, bereich) {
  const eineZeile = bereich.z1 === bereich.z2;
  const quelleZ = eineZeile ? bereich.z1 - 1 : bereich.z1, von = eineZeile ? bereich.z1 : bereich.z1 + 1;
  if (quelleZ < 1) return null;
  if ((bereich.z2 - von + 1) * (bereich.s2 - bereich.s1 + 1) > GRENZEN.zellen_op) throw zuViel();
  const zellen = zellenVon(daten, blattId), werte = {};
  for (let z = von; z <= bereich.z2; z++) {
    for (let s = bereich.s1; s <= bereich.s2; s++) {
      const q = zellen[adresse(quelleZ, s)];
      werte[adresse(z, s)] = voll(typeof q?.w === 'string' ? verschoben(q.w, z - quelleZ, 0) : null, q?.f);
    }
  }
  return zellenOp(blattId, werte);
}

/**
 * Bereich nach Spalte `spalte` sortieren → sortieren-Op mit Schnappschuss: Schlüssel ist der Wert aus dem Rechner;
 * Zahl vor Text vor Wahrheitswert vor Fehler, innerhalb wie vergleichen (Text ohne Groß/Klein); absteigend umgekehrt;
 * leer immer zuletzt; Gleichstand nach alter Zeile (stabil). Jede Zeile nimmt ihre Zellen mit (Formeln relativ
 * verschoben, volles Format); jede Adresse des Bereichs steht im Schnappschuss, leere als {w:null, f:LEER_F}.
 */
export function sortierenOp(daten, rechner, blattId, bereich, spalte, absteigend) {
  if (groesse(bereich) > GRENZEN.sortieren) throw zuViel();
  const zeilen = [];
  for (let z = bereich.z1; z <= bereich.z2; z++) zeilen.push({ z, wert: rechner.wert(blattId, adresse(z, spalte)) });
  zeilen.sort((a, b) => {
    const la = a.wert === null, lb = b.wert === null;
    if (la || lb) return la === lb ? a.z - b.z : la ? 1 : -1;
    const c = vergleichen(a.wert, b.wert);
    return (absteigend ? -c : c) || a.z - b.z;
  });
  const zellen = zellenVon(daten, blattId), schnappschuss = {};
  zeilen.forEach(({ z: alt }, k) => {
    const neu = bereich.z1 + k;
    for (let s = bereich.s1; s <= bereich.s2; s++) {
      const q = zellen[adresse(alt, s)];
      schnappschuss[adresse(neu, s)] = voll(typeof q?.w === 'string' ? verschoben(q.w, neu - alt, 0) : null, q?.f);
    }
  });
  return { typ: 'sortieren', blatt: blattId, bereich: bereichText(bereich), spalte, absteigend: !!absteigend, zellen: schnappschuss };
}

/**
 * Was „Sortieren“ sortiert: eine Auswahl über mehrere Zeilen so, wie sie ist; sonst alle belegten Zeilen (ab Zeile 2,
 * wenn die erste fixiert ist, sonst ab 1) über alle belegten Spalten → bereich oder null (nichts belegt).
 */
export function sortierBereich(daten, blattId, aw) {
  const b = bereichVon(aw);
  if (b.z2 > b.z1) return b;
  const blatt = (daten?.blaetter ?? []).find((x) => x.id === blattId);
  let z2 = 0, s1 = Infinity, s2 = 0;
  for (const [adr, zelle] of Object.entries(blatt?.zellen ?? {})) {
    if (typeof zelle?.w !== 'string') continue;
    const o = adresseLesen(adr, OHNE_GRENZEN);
    if (!o) continue;
    z2 = Math.max(z2, o.z); s1 = Math.min(s1, o.s); s2 = Math.max(s2, o.s);
  }
  const z1 = blatt?.fixiert?.zeilen === 1 ? 2 : 1;
  return z2 >= z1 ? { z1, s1, z2, s2 } : null;
}

/** Zeilen/Spalten einfügen oder löschen für die Auswahl: ab und anzahl aus ihren Zeilen bzw. Spalten. */
export function strukturOp(art, blattId, bereich) {
  return art.startsWith('zeilen')
    ? { typ: art, blatt: blattId, ab: bereich.z1, anzahl: bereich.z2 - bereich.z1 + 1 }
    : { typ: art, blatt: blattId, ab: bereich.s1, anzahl: bereich.s2 - bereich.s1 + 1 };
}

/** Neues Blatt hinter dem letzten: Name <standardname><n> mit dem kleinsten freien n (ohne Groß/Klein). */
export function neuesBlattOp(daten, standardname) {
  const blaetter = daten?.blaetter ?? [];
  const namen = new Set(blaetter.map((b) => String(b.name).toLowerCase()));
  let n = 1;
  while (namen.has(`${standardname}${n}`.toLowerCase())) n++;
  const letzte = blaetter.reduce((max, b) => (max === null || b.pos > max ? b.pos : max), null);
  return { typ: 'blatt_neu', blatt: { id: neueId(), name: `${standardname}${n}`, pos: zwischen(letzte, null) } };
}
