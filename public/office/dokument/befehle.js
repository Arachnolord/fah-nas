// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bearbeitungsbefehle des Dokument-Editors (Plan 05): reine Funktionen, die aus Daten und Auswahl ({anker, kopf}) ein
// Delta machen – Text eingeben, Enter (Listen und Überschriften wie in Word), Löschen (Zeilenanfang: erst Liste, Einzug,
// Zitat, dann Zusammenlegen; Blöcke als Ganzes), Inline- und Zeilenformate (Standardwerte werden nicht gespeichert),
// Einzug, Blöcke und Bilder einfügen, Links und Kommentare finden bzw. entfernen. Ohne DOM.

import { normalisieren, zusammensetzen, anwenden } from '../../gemeinsam/sync/delta.js';
import { zeilenAus, zeileBei, textAus, elementBei } from './modell.js';

const bereich = (aw) => ({ von: Math.min(aw.anker, aw.kopf), bis: Math.max(aw.anker, aw.kopf) });
const nlVon = (z) => z.start + z.laenge - 1;
const laengeVon = (delta) => textAus(delta).length;
const hoch = (c) => c >= 0xd800 && c <= 0xdbff;
const tief = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Attribute für ein Zeilenende: Werte aus `neu`, null für Schlüssel, die nur `alt` trägt; nur Änderungen; leer → null. */
function attrDiff(neu, alt) {
  const aus = {};
  for (const [k, v] of Object.entries(neu)) if (alt[k] !== v) aus[k] = v;
  for (const k of Object.keys(alt)) if (!Object.hasOwn(neu, k)) aus[k] = null;
  return Object.keys(aus).length ? aus : null;
}

/** Standardwerte werden nicht gespeichert: Ausrichtung links, Einzug 0. */
function zeilenWert(attr, wert) {
  if (attr === 'ausrichtung' && wert === 'links') return null;
  if (attr === 'einzug' && wert === 0) return null;
  return wert;
}

/** Bereich [von, bis) löschen (nie das letzte \n); über Zeilen bekommt das verbleibende Zeilenende die Attribute der ersten. */
function loeschBereich(daten, von, bis) {
  const L = laengeVon(daten.delta);
  const ende = Math.min(bis, L - 1);
  if (ende <= von) return null;
  const zeilen = zeilenAus(daten.delta);
  const zA = zeileBei(zeilen, von); const zB = zeileBei(zeilen, ende);
  const ops = [{ retain: von }, { delete: ende - von }];
  if (zA.nr !== zB.nr) {
    const diff = attrDiff(zA.attribute, zB.attribute);
    if (diff) ops.push({ retain: nlVon(zB) - ende }, { retain: 1, attributes: diff });
  }
  return normalisieren(ops);
}

/** Erst die Auswahl löschen (falls nicht leer), dann `fn(daten, index)` auf dem neuen Stand; zusammengesetzt. */
function nachLoeschen(daten, aw, fn) {
  const { von, bis } = bereich(aw);
  const erst = von !== bis ? loeschBereich(daten, von, bis) : null;
  const basis = erst ? { ...daten, delta: anwenden(daten.delta, erst) } : daten;
  const dann = fn(basis, von);
  if (!erst) return dann;
  return dann ? normalisieren(zusammensetzen(erst, dann)) : erst;
}

/** Text eingeben (ersetzt die Auswahl). */
export function eingabeDelta(daten, aw, text, formate = {}) {
  return nachLoeschen(daten, aw, (_d, i) => normalisieren([{ retain: i }, Object.keys(formate || {}).length ? { insert: text, attributes: { ...formate } } : { insert: text }]));
}

/** Löschen: 'zurueck' (Rücktaste) bzw. 'vor' (Entf); null = nichts zu tun. */
export function loeschenDelta(daten, aw, richtung) {
  const { von, bis } = bereich(aw);
  if (von !== bis) return loeschBereich(daten, von, bis);
  const i = von;
  const zeilen = zeilenAus(daten.delta);
  const z = zeileBei(zeilen, i);
  const s = textAus(daten.delta);
  if (richtung === 'zurueck') {
    if (i === z.start) {
      const a = z.attribute; const nl = nlVon(z);
      if (a.liste) return normalisieren([{ retain: nl }, { retain: 1, attributes: { liste: null, ...(a.erledigt ? { erledigt: null } : {}) } }]);
      if (a.einzug) return normalisieren([{ retain: nl }, { retain: 1, attributes: { einzug: a.einzug > 1 ? a.einzug - 1 : null } }]);
      if (a.zitat) return normalisieren([{ retain: nl }, { retain: 1, attributes: { zitat: null } }]);
      if (z.nr === 0) return null;
      const vor = zeilen[z.nr - 1];
      if (vor.block) return normalisieren([{ retain: vor.start }, { delete: vor.laenge }]);
      if (z.block) return vor.laenge === 1 ? normalisieren([{ retain: vor.start }, { delete: 1 }]) : null; // Block nicht in die Textzeile ziehen
      const diff = attrDiff(vor.attribute, z.attribute);
      return normalisieren([{ retain: i - 1 }, { delete: 1 }, ...(diff ? [{ retain: nl - i }, { retain: 1, attributes: diff }] : [])]);
    }
    const n = i >= 2 && tief(s.charCodeAt(i - 1)) && hoch(s.charCodeAt(i - 2)) ? 2 : 1;
    return normalisieren([{ retain: i - n }, { delete: n }]);
  }
  const nl = nlVon(z);
  if (i === nl) {
    if (z.nr === zeilen.length - 1) return null;
    const nach = zeilen[z.nr + 1];
    if (nach.block) return normalisieren([{ retain: nach.start }, { delete: nach.laenge }]);
    if (z.block) return nach.laenge === 1 ? normalisieren([{ retain: nach.start }, { delete: 1 }]) : null;
    const diff = attrDiff(z.attribute, nach.attribute);
    return normalisieren([{ retain: i }, { delete: 1 }, ...(diff ? [{ retain: nlVon(nach) - (i + 1) }, { retain: 1, attributes: diff }] : [])]);
  }
  const n = hoch(s.charCodeAt(i)) && tief(s.charCodeAt(i + 1)) ? 2 : 1;
  return normalisieren([{ retain: i }, { delete: n }]);
}

/** Enter: leere Listenzeile beendet die Liste, sonst neue Zeile mit den Zeilenformaten (am Zeilenende ohne Überschrift/Haken). */
export function enterDelta(daten, aw) {
  return nachLoeschen(daten, aw, (basis, i) => {
    const z = zeileBei(zeilenAus(basis.delta), i);
    const a = z.attribute; const nl = nlVon(z);
    if (z.laenge === 1 && a.liste) {
      const weg = { liste: null };
      if (a.erledigt) weg.erledigt = null;
      if (a.einzug) weg.einzug = null;
      return normalisieren([{ retain: nl }, { retain: 1, attributes: weg }]);
    }
    const ops = [{ retain: i }, Object.keys(a).length ? { insert: '\n', attributes: { ...a } } : { insert: '\n' }];
    if (i === nl) {
      const weg = {};
      if (a.ueberschrift) weg.ueberschrift = null;
      if (a.erledigt) weg.erledigt = null;
      if (Object.keys(weg).length) ops.push({ retain: 1, attributes: weg });
    }
    return normalisieren(ops);
  });
}

/** Inline-Format über die Auswahl (Zeilenumbrüche und Blöcke ausgelassen; Bilder nur Link/Kommentar); leer → null. */
export function formatDelta(daten, aw, attr, wert) {
  const { von, bis } = bereich(aw);
  if (von === bis) return null;
  const ops = [{ retain: von }];
  let p = 0; let getroffen = false;
  for (const op of daten.delta) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    const a = Math.max(p, von); const e = Math.min(p + l, bis);
    if (a < e) {
      if (typeof op.insert === 'string') {
        for (const teil of op.insert.slice(a - p, e - p).split(/(\n)/)) {
          if (!teil) continue;
          if (teil === '\n') ops.push({ retain: 1 }); else { ops.push({ retain: teil.length, attributes: { [attr]: wert } }); getroffen = true; }
        }
      } else if (op.insert.bild && (attr === 'link' || attr === 'kommentar')) { ops.push({ retain: 1, attributes: { [attr]: wert } }); getroffen = true; } else ops.push({ retain: 1 });
    }
    p += l;
    if (p >= bis) break;
  }
  return getroffen ? normalisieren(ops) : null;
}

/** Zeilen, die die Auswahl berührt (zusammengeklappt: die Zeile des Cursors). */
function betroffeneZeilen(daten, aw) {
  const { von, bis } = bereich(aw);
  const zeilen = zeilenAus(daten.delta);
  if (von === bis) return [zeileBei(zeilen, von)];
  return zeilen.filter((z) => z.start < bis && z.start + z.laenge > von);
}

function zeilenEndenDelta(liste) {
  const ops = []; let p = 0;
  for (const [pos, attributes] of liste.sort((a, b) => a[0] - b[0])) { ops.push({ retain: pos - p }, { retain: 1, attributes }); p = pos + 1; }
  return normalisieren(ops);
}

/** Zeilenformat auf alle berührten Zeilen. */
export function zeilenFormatDelta(daten, aw, attr, wert) {
  const w = zeilenWert(attr, wert);
  return zeilenEndenDelta(betroffeneZeilen(daten, aw).map((z) => [nlVon(z), { [attr]: w }]));
}

/** Einzug ± schritt (0–8); keine Zeile ändert sich → null. */
export function einzugDelta(daten, aw, schritt) {
  const liste = [];
  for (const z of betroffeneZeilen(daten, aw)) {
    const alt = z.attribute.einzug || 0;
    const neu = Math.min(8, Math.max(0, alt + schritt));
    if (neu !== alt) liste.push([nlVon(z), { einzug: zeilenWert('einzug', neu) }]);
  }
  return liste.length ? zeilenEndenDelta(liste) : null;
}

/** Block (Tabelle, Seitenumbruch) allein in eine Zeile; nicht am Zeilenanfang wird die Zeile vorher geteilt. */
export function blockEinfuegenDelta(daten, index, embed) {
  const z = zeileBei(zeilenAus(daten.delta), index);
  const ops = [{ retain: index }];
  let cursor = index;
  if (index !== z.start) { ops.push(Object.keys(z.attribute).length ? { insert: '\n', attributes: { ...z.attribute } } : { insert: '\n' }); cursor += 1; }
  ops.push({ insert: embed }, { insert: '\n' });
  cursor += 2;
  return { delta: normalisieren(ops), cursor };
}

/** Bild an der Auswahl (ersetzt sie); Bilder tragen keine Inline-Formate. */
export function bildEinfuegenDelta(daten, aw, bild) {
  const { von } = bereich(aw);
  const delta = nachLoeschen(daten, aw, (_d, i) => normalisieren([{ retain: i }, { insert: { bild: { ...bild } } }]));
  return { delta, cursor: von + 1 };
}

/** Link an der Stelle (Zeichen an oder vor `index`) → {start, laenge, url} | null. */
export function linkBereich(daten, index) {
  const an = elementBei(daten.delta, index);
  const vor = index > 0 ? elementBei(daten.delta, index - 1) : null;
  const url = an?.attributes?.link ?? vor?.attributes?.link;
  if (!url) return null;
  let start = an?.attributes?.link === url ? index : index - 1;
  let ende = start;
  while (start > 0 && elementBei(daten.delta, start - 1)?.attributes?.link === url) start--;
  while (elementBei(daten.delta, ende + 1)?.attributes?.link === url) ende++;
  return { start, laenge: ende - start + 1, url };
}

/** Bereich vom ersten bis zum letzten Zeichen mit Kommentar `id` → {start, laenge} | null. */
export function kommentarBereich(daten, id) {
  let p = 0; let erst = -1; let letzt = -1;
  for (const op of daten.delta) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    if (op.attributes?.kommentar === id) { if (erst < 0) erst = p; letzt = p + l - 1; }
    p += l;
  }
  return erst < 0 ? null : { start: erst, laenge: letzt - erst + 1 };
}

/** Attribut mit genau diesem Wert überall entfernen (z. B. kommentar === id). */
export function attributEntfernenDelta(daten, attr, wert) {
  const ops = [];
  for (const op of daten.delta) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    ops.push(op.attributes?.[attr] === wert ? { retain: l, attributes: { [attr]: null } } : { retain: l });
  }
  return normalisieren(ops);
}
