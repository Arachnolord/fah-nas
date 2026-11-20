// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Modell des Dokument-Editors (Plan 05): Zeilen aus dem Delta (Text mit Embeds als U+FFFC, Zeilen-Attribute des
// Zeilenumbruchs, Block-Zeilen), Formate an einer Stelle bzw. über einen Bereich, die Formate fürs Weitertippen,
// Listennummern (1., a., i. je Ebene) und der Zeilen-Diff, mit dem der Editor Browser-Eingaben (IME, Autokorrektur) in
// Änderungen übersetzt. Ohne DOM.

import { ZEILEN_ATTRIBUTE, INLINE_ATTRIBUTE } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { gleich } from '../../gemeinsam/sync/delta.js';

export const OBJ = '￼';
const BLOECKE = Object.freeze(['tabelle', 'seitenumbruch']);

const nurSchluessel = (attr, liste) => {
  const aus = {};
  for (const [k, v] of Object.entries(attr || {})) if (liste.includes(k) && v !== null && v !== undefined) aus[k] = v;
  return aus;
};
export const zeilenAttribute = (attr) => nurSchluessel(attr, ZEILEN_ATTRIBUTE);
export const inlineAttribute = (attr) => nurSchluessel(attr, INLINE_ATTRIBUTE);

/** Text des Dokuments mit Embeds als U+FFFC (Positionen wie im Delta). */
export function textAus(delta) { return delta.map((op) => (typeof op.insert === 'string' ? op.insert : OBJ)).join(''); }

/** Element an Position i → {embed, name?, z, attributes} oder null. */
export function elementBei(delta, i) {
  let p = 0;
  for (const op of delta) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    if (i < p + l) {
      if (typeof op.insert === 'string') return { embed: false, z: op.insert[i - p], attributes: op.attributes || {} };
      return { embed: true, name: Object.keys(op.insert)[0], z: OBJ, attributes: op.attributes || {} };
    }
    p += l;
  }
  return null;
}

/** Zeilen: [{nr, start, laenge (mit \n), inhalt (Delta ohne \n), text, attribute, block}]. */
export function zeilenAus(delta) {
  const zeilen = [];
  let start = 0; let pos = 0; let inhalt = []; let text = '';
  const abschliessen = (attr) => {
    const block = inhalt.length === 1 && typeof inhalt[0].insert === 'object' && BLOECKE.includes(Object.keys(inhalt[0].insert)[0]) ? Object.keys(inhalt[0].insert)[0] : null;
    zeilen.push({ nr: zeilen.length, start, laenge: pos - start, inhalt, text, attribute: zeilenAttribute(attr), block });
    start = pos; inhalt = []; text = '';
  };
  for (const op of delta) {
    if (typeof op.insert !== 'string') { inhalt.push(op); text += OBJ; pos += 1; continue; }
    const teile = op.insert.split('\n');
    teile.forEach((t, j) => {
      if (t) { inhalt.push(op.attributes ? { insert: t, attributes: op.attributes } : { insert: t }); text += t; pos += t.length; }
      if (j < teile.length - 1) { pos += 1; abschliessen(op.attributes); }
    });
  }
  if (inhalt.length) abschliessen(null); // Dokument ohne abschließendes \n (sollte nicht vorkommen)
  return zeilen;
}

/** Zeile, in der `index` liegt (hinter dem Ende: die letzte). */
export function zeileBei(zeilen, index) {
  for (const z of zeilen) if (index < z.start + z.laenge) return z;
  return zeilen[zeilen.length - 1];
}

/** Gemeinsame Attribute einer Liste (nur Werte, die alle gleich tragen). */
function gemeinsam(liste) {
  if (!liste.length) return {};
  const aus = { ...liste[0] };
  for (const a of liste.slice(1)) for (const k of Object.keys(aus)) if (!gleich(aus[k], a[k])) delete aus[k];
  return aus;
}

/**
 * Formate an `index` bzw. über [index, index + laenge): inline nur, was alle Textzeichen gleich tragen (bei laenge 0 die
 * Formate fürs Weitertippen), zeile nur, was alle betroffenen Zeilen gleich tragen.
 */
export function formateBei(delta, index, laenge = 0) {
  const zeilen = zeilenAus(delta);
  let inline;
  if (laenge > 0) {
    const sammlung = [];
    let p = 0;
    for (const op of delta) {
      const l = typeof op.insert === 'string' ? op.insert.length : 1;
      if (p + l > index && p < index + laenge && typeof op.insert === 'string') {
        const stueck = op.insert.slice(Math.max(0, index - p), Math.min(l, index + laenge - p));
        if (stueck.replace(/\n/g, '')) sammlung.push(inlineAttribute(op.attributes));
      }
      p += l;
      if (p >= index + laenge) break;
    }
    inline = gemeinsam(sammlung);
  } else inline = einfuegeFormate(delta, index);
  const betroffen = laenge > 0 ? zeilen.filter((z) => z.start < index + laenge && z.start + z.laenge > index) : [zeileBei(zeilen, index)];
  return { inline, zeile: gemeinsam(betroffen.filter(Boolean).map((z) => z.attribute)) };
}

/**
 * Formate für neu getippten Text an `index`: die des Zeichens davor (am Zeilenanfang die des ersten Zeichens der Zeile);
 * hinter bzw. vor einem Embed keine. Link und Kommentar nur, wenn das Zeichen davor und danach denselben Wert tragen.
 */
export function einfuegeFormate(delta, index) {
  const vor = index > 0 ? elementBei(delta, index - 1) : null;
  const zeilenanfang = !vor || vor.z === '\n';
  const quelle = zeilenanfang ? elementBei(delta, index) : vor;
  if (!quelle || quelle.embed || quelle.z === '\n') return {};
  const a = inlineAttribute(quelle.attributes);
  const nach = elementBei(delta, index);
  for (const k of ['link', 'kommentar']) {
    if (a[k] === undefined) continue;
    const vw = vor && !vor.embed ? vor.attributes[k] : undefined;
    const nw = nach && !nach.embed ? nach.attributes[k] : undefined;
    if (!(vw !== undefined && vw === nw && vw === a[k])) delete a[k];
  }
  return a;
}

function buchstaben(n) {
  let s = '';
  while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function roemisch(n) {
  const werte = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [w, z] of werte) while (n >= w) { s += z; n -= w; }
  return s;
}

/** Nummer je Zeile (null ohne Zahlenliste): je Ebene 0–8 eigener Zähler, Format nach Ebene % 3 (1., a., i.). */
export function listenNummern(zeilen) {
  const zaehler = new Array(9).fill(0);
  return zeilen.map((z) => {
    const a = z.attribute || {};
    if (!a.liste) { zaehler.fill(0); return null; }
    const ebene = Math.min(8, Math.max(0, a.einzug || 0));
    if (a.liste !== 'zahlen') { for (let i = ebene; i < 9; i++) zaehler[i] = 0; return null; }
    zaehler[ebene] += 1;
    for (let i = ebene + 1; i < 9; i++) zaehler[i] = 0;
    const n = zaehler[ebene];
    const art = ebene % 3;
    return `${art === 0 ? n : art === 1 ? buchstaben(n) : roemisch(n)}.`;
  });
}

const hoch = (c) => c >= 0xd800 && c <= 0xdbff;
const tief = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Unterschied zweier Zeilentexte → {start, loeschen, einfuegen} | null. Das gemeinsame Ende reicht höchstens bis zum
 * Cursor (so landet eine Wiederholung dort, wo getippt wurde); Ersatzpaare werden nie geteilt.
 */
export function zeilenDiff(alt, neu, cursorNeu = null) {
  if (alt === neu) return null;
  let maxS = Math.min(alt.length, neu.length);
  if (Number.isInteger(cursorNeu)) maxS = Math.min(maxS, Math.max(0, neu.length - cursorNeu));
  let s = 0;
  while (s < maxS && alt[alt.length - 1 - s] === neu[neu.length - 1 - s]) s++;
  const altRest = alt.length - s; const neuRest = neu.length - s;
  let p = 0;
  while (p < altRest && p < neuRest && alt[p] === neu[p]) p++;
  if (p > 0 && hoch(neu.charCodeAt(p - 1))) p--;
  if (s > 0 && tief(neu.charCodeAt(neu.length - s))) s--;
  return { start: p, loeschen: alt.length - s - p, einfuegen: neu.slice(p, neu.length - s) };
}
