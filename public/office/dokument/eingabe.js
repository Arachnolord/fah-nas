// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eingabe im Dokument-Editor (Plan 05): Was die Zeilenstruktur ändert (Enter, Löschen über Zeilengrenzen, Tippen über
// eine zeilenübergreifende Auswahl, Ausschneiden), fängt `beforeinput` ab und rechnet es übers Modell. Tippen innerhalb
// einer Zeile übernimmt der Browser; danach vergleicht `input` den Zeilentext mit dem Modell und macht daraus ein Delta.
// IME-Eingaben (Komposition, auch Android-Tastaturen) laufen ungestört und werden am Ende gegen fremde Änderungen
// verschoben. Einfügen und Ablegen gehen über die Zwischenablage-Regeln aus einfuegen.js.

import { t } from '../../app.js';
import { normalisieren, zusammensetzen, transformiere, positionTransformieren } from '../../gemeinsam/sync/delta.js';
import { zeileBei, zeilenDiff, einfuegeFormate, elementBei, inlineAttribute } from './modell.js';
import { textAusDom, zeilenOffset, domZuIndex } from './darstellung.js';
import { eingabeDelta, loeschenDelta, enterDelta, zeilenFormatDelta } from './befehle.js';
import { zwischenablageLesen, htmlZuDelta, textZuDelta, einfuegenDelta } from './einfuegen.js';

const OBJ_RE = /￼/g;
const AUSGESPERRT = new Set(['insertFromDrop', 'deleteByDrag', 'insertFromPaste']); // laufen über paste/drop

/** Nur gesetzte Formate (null/false = ausdrücklich weg). */
const nurGesetzte = (a) => Object.fromEntries(Object.entries(a || {}).filter(([, v]) => v !== null && v !== undefined && v !== false));
const vonBis = (aw) => [Math.min(aw.anker, aw.kopf), Math.max(aw.anker, aw.kopf)];
const auswahlObjekt = () => (typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null);

function zeilenElement(wurzel, knoten) {
  let k = knoten;
  while (k && k.parentNode !== wurzel) k = k.parentNode;
  return k && k.nodeType === 1 ? k : null;
}

/** In einem Embed (Tabellenzelle, Bild) – das regeln die Aufgaben 13/14 selbst. */
function imEmbed(wurzel, knoten) {
  for (let k = knoten; k && k !== wurzel; k = k.parentNode) if (k.nodeType === 1 && k.classList.contains('od-embed')) return true;
  return false;
}

/** Ersetztes Wort (Autokorrektur, Vorschlag): Formate samt Link und Kommentar des ersten ersetzten Zeichens. */
function ersetztFormate(delta, pos) {
  const e = elementBei(delta, pos);
  return e && !e.embed && e.z !== '\n' ? inlineAttribute(e.attributes) : einfuegeFormate(delta, pos);
}

/** Delta für eine Zeilenänderung (Diff gegen den Modelltext) an Stelle `pos` im Stand `delta`. */
function diffDelta(ed, delta, pos, diff) {
  const einfuegen = diff.einfuegen.replace(OBJ_RE, '');
  const ops = [{ retain: pos }];
  if (diff.loeschen) ops.push({ delete: diff.loeschen });
  if (einfuegen) {
    const f = nurGesetzte({ ...(diff.loeschen ? ersetztFormate(delta, pos) : einfuegeFormate(delta, pos)), ...ed.vorgemerkt });
    ops.push(Object.keys(f).length ? { insert: einfuegen, attributes: f } : { insert: einfuegen });
  }
  ed.vorgemerkt = {};
  return { d: normalisieren(ops), laenge: einfuegen.length };
}

/** Eingabe-Hörer am Text einrichten → Abmelden. */
export function eingabeEinrichten(ed) {
  const { wurzel } = ed;
  const anwenden = (d, von) => { if (d && d.length) ed.aendern({ d }, { cursor: positionTransformieren(von, d, true) }); };

  function verworfen() {
    console.warn('[office] Eingabe verworfen: DOM passte nicht');
    if (typeof ed.ctx.melden === 'function') ed.ctx.melden(t('office.dok_eingabe_verworfen'), 'warnung');
    ed.neuAufbauen();
  }

  function vorEingabe(e) {
    if (ed.nurLesen || ed.komposition || e.isComposing || imEmbed(wurzel, e.target)) return;
    const art = e.inputType || '';
    if (AUSGESPERRT.has(art)) { e.preventDefault(); return; }
    if (art.startsWith('format')) { e.preventDefault(); if (typeof ed.formatEingabe === 'function') ed.formatEingabe(art, e); return; }
    if (art.startsWith('history')) { e.preventDefault(); if (typeof ed.verlaufEingabe === 'function') ed.verlaufEingabe(art); return; }
    const aw = ed.auswahl();
    if (!aw) return;
    const [von, bis] = vonBis(aw);
    const zA = zeileBei(ed.zeilen, von);
    const ueber = zA.nr !== zeileBei(ed.zeilen, bis).nr;
    if (art === 'insertParagraph' || art === 'insertLineBreak') { e.preventDefault(); anwenden(enterDelta(ed.daten, aw), von); return; }
    if (art === 'insertText' || art === 'insertReplacementText') {
      if (!ueber) return;
      e.preventDefault();
      const text = String(e.data ?? (e.dataTransfer && e.dataTransfer.getData('text/plain')) ?? '').replace(OBJ_RE, '');
      const formate = nurGesetzte({ ...einfuegeFormate(ed.daten.delta, von), ...ed.vorgemerkt });
      ed.vorgemerkt = {};
      anwenden(eingabeDelta(ed.daten, aw, text, formate), von);
      return;
    }
    if (art === 'deleteByCut') { e.preventDefault(); if (von !== bis) anwenden(loeschenDelta(ed.daten, aw, 'zurueck'), von); return; }
    if (art.startsWith('delete')) {
      const rueck = !art.endsWith('Forward');
      const amRand = von === bis && (rueck ? von === zA.start : von === zA.start + zA.laenge - 1);
      if (ueber || amRand || (von === bis && zA.block)) { e.preventDefault(); anwenden(loeschenDelta(ed.daten, aw, rueck ? 'zurueck' : 'vor'), von); }
    }
  }

  function nachEingabe(e) {
    if (ed.komposition || e.isComposing || imEmbed(wurzel, e.target)) return;
    if (ed.nurLesen) { ed.neuAufbauen(); return; }
    const s = auswahlObjekt();
    const knoten = s && (s.focusNode || s.anchorNode);
    const zeilenEl = knoten ? zeilenElement(wurzel, knoten) : null;
    if (!zeilenEl || wurzel.children.length !== ed.zeilen.length) { verworfen(); return; }
    const zeile = ed.zeilen[Array.prototype.indexOf.call(wurzel.children, zeilenEl)];
    const offset = s.focusNode ? s.focusOffset : s.anchorOffset;
    const diff = zeilenDiff(zeile.text, textAusDom(zeilenEl), zeilenOffset(zeilenEl, knoten, offset));
    if (!diff) return;
    const pos = zeile.start + diff.start;
    const { d, laenge } = diffDelta(ed, ed.daten.delta, pos, diff);
    if (!d.length) { ed.neuAufbauen(); return; }
    ed.aendern({ d }, { cursor: pos + laenge });
  }

  function kompositionStart(e) {
    if (ed.nurLesen || ed.komposition || imEmbed(wurzel, e.target)) return;
    let aw = ed.auswahl();
    if (!aw) return;
    let [von, bis] = vonBis(aw);
    if (zeileBei(ed.zeilen, von).nr !== zeileBei(ed.zeilen, bis).nr) {
      // zeilenübergreifende Auswahl zuerst übers Modell löschen, die Komposition läuft dann in einer Zeile
      anwenden(loeschenDelta(ed.daten, aw, 'zurueck'), von);
      aw = { anker: von, kopf: von }; bis = von;
    }
    const zeile = zeileBei(ed.zeilen, von);
    const zeilenEl = wurzel.children[zeile.nr];
    if (!zeilenEl) return;
    ed.komposition = { zeilenEl, basisText: zeile.text, basisStart: zeile.start, basisDelta: ed.daten.delta, start: zeile.start, seit: [] };
  }

  function kompositionEnde() {
    const k = ed.komposition;
    ed.komposition = null;
    if (!k) return;
    if (k.zeilenEl.parentNode !== wurzel) { ed.neuAufbauen(); return; }
    const s = auswahlObjekt();
    const cursor = s && s.focusNode && k.zeilenEl.contains(s.focusNode) ? zeilenOffset(k.zeilenEl, s.focusNode, s.focusOffset) : null;
    const diff = zeilenDiff(k.basisText, textAusDom(k.zeilenEl), cursor);
    if (!diff) { ed.rendern(); return; }
    const pos = k.basisStart + diff.start;
    let { d } = diffDelta(ed, k.basisDelta, pos, diff);
    const laenge = diff.einfuegen.replace(OBJ_RE, '').length;
    let ziel = pos;
    const seit = k.seit.map((op) => op.d).filter(Boolean); // fremde und eigene Änderungen während der Komposition
    if (seit.length) {
      const f = seit.reduce((a, b) => zusammensetzen(a, b));
      d = transformiere(d, f, 'rechts');
      ziel = positionTransformieren(pos, f, true);
    }
    if (!d.length) { ed.neuAufbauen(); return; }
    ed.aendern({ d }, { cursor: ziel + laenge });
  }

  function einfuegen(inhalt, aw) {
    if (!inhalt || !aw) return;
    if (inhalt.art === 'dateien') {
      if (typeof ed.bilderEinfuegen === 'function') ed.bilderEinfuegen(inhalt.dateien, vonBis(aw)[0]);
      return;
    }
    let neu;
    if (inhalt.art === 'html') {
      neu = htmlZuDelta(inhalt.wurzel);
      // ein abschließender Zeilenumbruch ohne Formate teilt die Zeile nicht: ein Absatz landet in der Zeile
      const l = neu[neu.length - 1];
      if (l && typeof l.insert === 'string' && l.insert.endsWith('\n') && !l.attributes) {
        neu = l.insert === '\n' ? neu.slice(0, -1) : [...neu.slice(0, -1), { insert: l.insert.slice(0, -1) }];
      }
    } else {
      const { ueberschrift, erledigt, ...rest } = zeileBei(ed.zeilen, vonBis(aw)[0]).attribute || {}; // eslint-disable-line no-unused-vars
      neu = textZuDelta(inhalt.text, rest);
    }
    if (!neu.length) return;
    const { delta, cursor } = einfuegenDelta(ed.daten, aw, neu);
    ed.aendern({ d: delta }, { cursor });
  }

  function indexAusPunkt(x, y) {
    const d = globalThis.document;
    let knoten = null; let offset = 0;
    if (typeof d.caretPositionFromPoint === 'function') {
      const p = d.caretPositionFromPoint(x, y);
      if (p) { knoten = p.offsetNode; offset = p.offset; }
    } else if (typeof d.caretRangeFromPoint === 'function') {
      const r = d.caretRangeFromPoint(x, y);
      if (r) { knoten = r.startContainer; offset = r.startOffset; }
    }
    return knoten ? domZuIndex(wurzel, ed.zeilen, knoten, offset) : null;
  }

  function beimEinfuegen(e) {
    if (ed.nurLesen || imEmbed(wurzel, e.target)) return;
    e.preventDefault();
    einfuegen(zwischenablageLesen(e.clipboardData), ed.auswahl());
  }

  function beimAblegen(e) {
    if (ed.nurLesen || imEmbed(wurzel, e.target)) return;
    e.preventDefault();
    const index = indexAusPunkt(e.clientX, e.clientY);
    einfuegen(zwischenablageLesen(e.dataTransfer), index === null ? ed.auswahl() : { anker: index, kopf: index });
  }

  /** Aufgaben-Häkchen: ein Klick schaltet „erledigt“ der Zeile um (der Cursor bleibt, wo er war). */
  function hakenVon(e) { return e.target && typeof e.target.closest === 'function' ? e.target.closest('.od-haken') : null; }
  function hakenDruck(e) { if (hakenVon(e)) e.preventDefault(); }
  function hakenKlick(e) {
    const haken = hakenVon(e);
    if (!haken) return;
    e.preventDefault();
    if (ed.nurLesen) return;
    const z = ed.zeilen[Array.prototype.indexOf.call(wurzel.children, haken.parentNode)];
    if (z) ed.erledigtUmschalten(z);
  }

  const hoerer = [['beforeinput', vorEingabe], ['input', nachEingabe], ['compositionstart', kompositionStart],
    ['compositionend', kompositionEnde], ['paste', beimEinfuegen], ['drop', beimAblegen],
    ['mousedown', hakenDruck], ['pointerdown', hakenDruck], ['click', hakenKlick]];
  /** „erledigt“ einer Aufgaben-Zeile umschalten (auch für Strg/⌘+Enter). */
  ed.erledigtUmschalten = (z) => {
    if (ed.nurLesen || !z || z.attribute.liste !== 'aufgabe') return false;
    const d = zeilenFormatDelta(ed.daten, { anker: z.start, kopf: z.start }, 'erledigt', z.attribute.erledigt ? null : true);
    return !!(d && d.length && ed.aendern({ d }));
  };
  for (const [art, fn] of hoerer) wurzel.addEventListener(art, fn);
  return () => { for (const [art, fn] of hoerer) wurzel.removeEventListener(art, fn); };
}
