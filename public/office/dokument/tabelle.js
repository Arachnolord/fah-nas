// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tabellen im Dokument (Plan 05): neue Tabelle, Zeilen/Spalten-Befehle (mit Grabsteinen, damit gleichzeitiges
// Löschen eindeutig bleibt), Zellen als eigene Eingabefelder. Getipptes geht 300 ms nach der letzten Eingabe als
// `zelle`-Op hinaus (beim Verlassen der Zelle sofort); die fokussierte Zelle mit ungesendetem Text wird beim
// Neuzeichnen nicht angefasst. Dazu die Leistengruppe „Tabelle“ (nur bei Fokus in einer Zelle) und die Spaltenbreite
// per Griff.

import { el, t } from '../../app.js';
import { normalisieren, teil, anwenden as deltaAnwenden } from '../../gemeinsam/sync/delta.js';
import { neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { zellKey, sichtbareZeilen, sichtbareSpalten } from '../../gemeinsam/sync/typen/dokument-tabelle.js';
import { zeilenDiff, einfuegeFormate, elementBei, inlineAttribute } from './modell.js';
import { blockEinfuegenDelta } from './befehle.js';
import { zelleMerken } from './darstellung.js';
import { tasteAuswerten } from './werkzeugleiste.js';

/** Mehr Zeilen bzw. Spalten bietet die Oberfläche nicht an. */
export const TABELLE_MAX = Object.freeze({ zeilen: 200, spalten: 50 });
const SENDEN_MS = 300;
const BREITE = Object.freeze({ min: 40, max: 2000 });
const FORMAT_EINGABE = new Map([['formatBold', 'fett'], ['formatItalic', 'kursiv'], ['formatUnderline', 'unterstrichen']]);

const kinderVon = (k) => Array.prototype.slice.call(k.childNodes || []);
const nurGesetzte = (a) => Object.fromEntries(Object.entries(a || {}).filter(([, v]) => v !== null && v !== undefined && v !== false));
const auswahlObjekt = () => (typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null);
const textVon = (delta) => (delta || []).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');

/** Leere Tabelle mit neuen Kennungen (erst die Tabelle, dann Zeilen, dann Spalten). */
export function neueTabelle(zeilen = 3, spalten = 3, id = neueId) {
  const tabId = id();
  return { id: tabId, zeilen: Array.from({ length: zeilen }, () => id()), spalten: Array.from({ length: spalten }, () => id()), weg: [], zellen: {}, breiten: {} };
}

/** Zellen enden nie mit einem Zeilenumbruch. */
function ohneEndUmbruch(delta) {
  const aus = delta.map((op) => ({ ...op }));
  while (aus.length && /\n$/.test(aus[aus.length - 1].insert)) {
    const l = aus[aus.length - 1];
    l.insert = l.insert.replace(/\n+$/, '');
    if (!l.insert) aus.pop();
  }
  return normalisieren(aus);
}

/** Neuer Zellinhalt aus dem getippten Text (Diff gegen das Zell-Delta, Eingefügtes erbt die Formate davor); gleich → null. */
export function zelleNeu(wert, zeile, spalte, neuerText, cursor) {
  const k = zellKey(zeile, spalte);
  const alt = wert.zellen && Object.hasOwn(wert.zellen, k) ? wert.zellen[k] : [];
  const diff = zeilenDiff(textVon(alt), String(neuerText).replace(/￼/g, ''), Number.isInteger(cursor) ? cursor : null);
  if (!diff) return null;
  const ops = [{ retain: diff.start }];
  if (diff.loeschen) ops.push({ delete: diff.loeschen });
  if (diff.einfuegen) {
    // ersetzt (Autokorrektur): Formate des ersten ersetzten Zeichens, sonst die davor
    const e = diff.loeschen ? elementBei(alt, diff.start) : null;
    const f = nurGesetzte(e && !e.embed ? inlineAttribute(e.attributes) : einfuegeFormate(alt, diff.start));
    ops.push(Object.keys(f).length ? { insert: diff.einfuegen, attributes: f } : { insert: diff.einfuegen });
  }
  const neu = ohneEndUmbruch(deltaAnwenden(alt, normalisieren(ops)));
  return JSON.stringify(neu) === JSON.stringify(alt) ? null : neu;
}

/** Tabellen-Ops für einen Leistenbefehl an der Zelle {zeile, spalte}; „davor“ hängt hinter den direkten Vorgänger (auch Grabsteine). */
export function tabellenBefehl(wert, { zeile, spalte }, befehl, id = neueId) {
  const vorgaenger = (liste, x) => { const i = liste.indexOf(x); return i > 0 ? liste[i - 1] : null; };
  switch (befehl) {
    case 'zeile_davor': return [{ typ: 'zeile_einfuegen', nach: vorgaenger(wert.zeilen, zeile), id: id() }];
    case 'zeile_danach': return [{ typ: 'zeile_einfuegen', nach: zeile, id: id() }];
    case 'spalte_davor': return [{ typ: 'spalte_einfuegen', nach: vorgaenger(wert.spalten, spalte), id: id() }];
    case 'spalte_danach': return [{ typ: 'spalte_einfuegen', nach: spalte, id: id() }];
    case 'zeile_loeschen': return [{ typ: 'zeile_loeschen', id: zeile }];
    case 'spalte_loeschen': return [{ typ: 'spalte_loeschen', id: spalte }];
    default: return [];
  }
}

/** Text einer Zelle aus dem DOM: br und Absätze (div/p) als Zeilenumbruch; ein Umbruch am Ende zählt nicht (Platzhalter). */
export function zellTextDom(td) {
  let s = '';
  const gehe = (k) => {
    for (const c of kinderVon(k)) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1) {
        if (c.localName === 'br') { s += '\n'; continue; }
        if ((c.localName === 'div' || c.localName === 'p') && s && !s.endsWith('\n')) s += '\n';
        gehe(c);
      }
    }
  };
  gehe(td);
  return s.replace(/\n$/, '');
}

/** Zeichen vor der DOM-Stelle in der Zelle (wie zellTextDom gezählt). */
function zellOffset(td, knoten, offset) {
  let n = 0; let letztes = '';
  const gehe = (k) => {
    const kinder = kinderVon(k);
    for (let i = 0; i < kinder.length; i++) {
      if (k === knoten && i === offset) return true;
      const c = kinder[i];
      if (c.nodeType === 3) {
        if (c === knoten) { n += Math.min(offset, c.data.length); return true; }
        n += c.data.length; if (c.data) letztes = c.data[c.data.length - 1];
      } else if (c.nodeType === 1) {
        if (c.localName === 'br') { n += 1; letztes = '\n'; continue; }
        if ((c.localName === 'div' || c.localName === 'p') && n > 0 && letztes !== '\n') { n += 1; letztes = '\n'; }
        if (gehe(c)) return true;
      }
    }
    return k === knoten;
  };
  gehe(td);
  return n;
}

/** DOM-Stelle für Zeichen `index` in der Zelle. */
function zellPosition(td, index) {
  let p = 0; let treffer = null;
  const gehe = (k) => {
    for (const c of kinderVon(k)) {
      if (treffer) return;
      if (c.nodeType === 3) {
        if (index <= p + c.data.length) { treffer = { knoten: c, offset: index - p }; return; }
        p += c.data.length;
      } else if (c.nodeType === 1) {
        if (c.localName === 'br') { p += 1; continue; }
        gehe(c);
      }
    }
  };
  gehe(td);
  return treffer || { knoten: td, offset: td.childNodes.length };
}

/** Zellen-Eingabe, Leistengruppe, Spaltenbreite und „Tabelle einfügen“ am Editor einrichten → Abmelden. */
export function tabelleEinrichten(ed) {
  const { wurzel } = ed;
  const offen = new Map(); // td → {tabelle, zeile, spalte, zeitgeber}: Getipptes, noch nicht gesendet
  let komponiert = null; // Zelle mit laufender IME-Eingabe
  let gruppe = null; let knoepfe = new Map();

  const hoch = (k, klasse) => { for (let x = k; x && x !== wurzel; x = x.parentNode) if (x.nodeType === 1 && x.classList && x.classList.contains(klasse)) return x; return null; };
  const zelleVon = (k) => hoch(k, 'od-zelle');
  const rahmenVon = (k) => hoch(k, 'od-tabelle-rahmen');
  const aktiveZelle = () => zelleVon(document.activeElement);
  const tabZeile = (id) => ed.zeilen.find((z) => z.block === 'tabelle' && z.inhalt[0].insert.tabelle.id === id) || null;
  const zeileZu = (td) => { const r = rahmenVon(td); return r ? tabZeile(r.dataset.tabelle) : null; };
  const tabOp = (zeile, ops) => normalisieren([{ retain: zeile.start }, { retain: { tabelle: ops } }]);
  function zelleSuchen(tabId, zeile, spalte) {
    const r = [...wurzel.querySelectorAll('.od-tabelle-rahmen')].find((x) => x.dataset.tabelle === tabId);
    return r ? [...r.querySelectorAll('td.od-zelle')].find((td) => td.dataset.zeile === zeile && td.dataset.spalte === spalte) || null : null;
  }

  function senden(td) {
    const e = offen.get(td);
    if (!e) return;
    clearTimeout(e.zeitgeber);
    offen.delete(td);
    if (ed.nurLesen || !td.parentNode) return;
    const zeile = tabZeile(e.tabelle);
    if (!zeile) return; // Tabelle inzwischen gelöscht
    const s = auswahlObjekt();
    const cursor = s && s.focusNode && td.contains(s.focusNode) ? zellOffset(td, s.focusNode, s.focusOffset) : null;
    const inhalt = zelleNeu(zeile.inhalt[0].insert.tabelle, e.zeile, e.spalte, zellTextDom(td), cursor);
    if (!inhalt) return;
    zelleMerken(td, inhalt); // die Zelle zeigt das schon – nicht neu zeichnen
    ed.aendern({ d: tabOp(zeile, [{ typ: 'zelle', zeile: e.zeile, spalte: e.spalte, inhalt }]) });
  }

  function planen(td) {
    let e = offen.get(td);
    if (!e) {
      const r = rahmenVon(td);
      if (!r) return;
      e = { tabelle: r.dataset.tabelle, zeile: td.dataset.zeile, spalte: td.dataset.spalte, zeitgeber: null };
      offen.set(td, e);
    }
    clearTimeout(e.zeitgeber);
    e.zeitgeber = setTimeout(() => senden(td), SENDEN_MS);
  }

  /** Strg/⌘+B/I/U in der Zelle: Format über die Auswahl im Zell-Delta umschalten. */
  function zellFormat(td, attr) {
    senden(td);
    const zeile = zeileZu(td);
    const s = auswahlObjekt();
    if (!zeile || !s || !s.anchorNode || !td.contains(s.anchorNode)) return;
    const a = zellOffset(td, s.anchorNode, s.anchorOffset);
    const b = s.focusNode && td.contains(s.focusNode) ? zellOffset(td, s.focusNode, s.focusOffset) : a;
    const von = Math.min(a, b); const bis = Math.max(a, b);
    if (von === bis) return;
    const wert = zeile.inhalt[0].insert.tabelle;
    const k = zellKey(td.dataset.zeile, td.dataset.spalte);
    const alt = Object.hasOwn(wert.zellen, k) ? wert.zellen[k] : [];
    const an = teil(alt, von, bis).every((op) => op.attributes && op.attributes[attr] === true);
    const inhalt = deltaAnwenden(alt, normalisieren([{ retain: von }, { retain: bis - von, attributes: { [attr]: an ? null : true } }]));
    ed.aendern({ d: tabOp(zeile, [{ typ: 'zelle', zeile: td.dataset.zeile, spalte: td.dataset.spalte, inhalt }]) });
    const pa = zellPosition(td, von); const pb = zellPosition(td, bis);
    try { s.setBaseAndExtent(pa.knoten, pa.offset, pb.knoten, pb.offset); } catch { /* egal */ }
  }

  function gruppeAktualisieren() {
    if (!gruppe) return;
    const td = aktiveZelle();
    const zeile = td ? zeileZu(td) : null;
    gruppe.hidden = !zeile || ed.nurLesen;
    if (!zeile) return;
    const wert = zeile.inhalt[0].insert.tabelle;
    const vollZ = sichtbareZeilen(wert).length >= TABELLE_MAX.zeilen;
    const vollS = sichtbareSpalten(wert).length >= TABELLE_MAX.spalten;
    for (const [befehl, k] of knoepfe) {
      const voll = befehl.startsWith('zeile_d') ? vollZ : befehl.startsWith('spalte_d') ? vollS : false;
      k.disabled = voll;
      k.setAttribute('title', voll ? t('office.dok_tabelle_grenze') : k.getAttribute('aria-label'));
    }
  }

  function befehl(name) {
    const td = aktiveZelle();
    if (!td || ed.nurLesen) return;
    senden(td);
    const zeile = zeileZu(td);
    if (!zeile) return;
    const wert = zeile.inhalt[0].insert.tabelle;
    const z = td.dataset.zeile; const s = td.dataset.spalte;
    const vz = sichtbareZeilen(wert); const vs = sichtbareSpalten(wert);
    if ((name === 'zeile_loeschen' && vz.length <= 1) || (name === 'spalte_loeschen' && vs.length <= 1)) {
      // die letzte Zeile bzw. Spalte: die ganze Tabelle weg
      if (ed.aendern({ d: normalisieren([{ retain: zeile.start }, { delete: zeile.laenge }]) })) {
        try { wurzel.focus({ preventScroll: true }); } catch { /* egal */ }
        ed.auswahlSetzen({ anker: zeile.start, kopf: zeile.start });
      }
      gruppeAktualisieren();
      return;
    }
    if ((name.startsWith('zeile_d') && vz.length >= TABELLE_MAX.zeilen) || (name.startsWith('spalte_d') && vs.length >= TABELLE_MAX.spalten)) return;
    const ziel = { zeile: z, spalte: s };
    if (name === 'zeile_loeschen') { const i = vz.indexOf(z); ziel.zeile = vz[i + 1] || vz[i - 1]; }
    if (name === 'spalte_loeschen') { const i = vs.indexOf(s); ziel.spalte = vs[i + 1] || vs[i - 1]; }
    ed.aendern({ d: tabOp(zeile, tabellenBefehl(wert, { zeile: z, spalte: s }, name)) });
    const neu = zelleSuchen(wert.id, ziel.zeile, ziel.spalte);
    if (neu && neu !== document.activeElement) neu.focus();
    gruppeAktualisieren();
  }

  const BEFEHLE = [['zeile_davor', () => t('office.dok_zeile_davor')], ['zeile_danach', () => t('office.dok_zeile_danach')],
    ['spalte_davor', () => t('office.dok_spalte_davor')], ['spalte_danach', () => t('office.dok_spalte_danach')],
    ['zeile_loeschen', () => t('office.dok_zeile_loeschen')], ['spalte_loeschen', () => t('office.dok_spalte_loeschen')]];
  ed.leisteZusaetze.push(() => {
    knoepfe = new Map();
    const liste = BEFEHLE.map(([name, text]) => {
      const k = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: text(), 'aria-label': text(), 'data-bearbeiten': '', onclick: () => befehl(name) }, text());
      knoepfe.set(name, k);
      return k;
    });
    gruppe = el('div', { class: 'od-leiste-gruppe od-tabellen-gruppe', role: 'group', 'aria-label': t('office.dok_tabelle_gruppe'), hidden: true }, liste);
    gruppeAktualisieren();
    return gruppe;
  });

  ed.aktionen.tabelle = () => {
    if (ed.nurLesen) return;
    const aw = ed.auswahl() || ed.letzteAuswahl;
    if (!aw) return;
    const wert = neueTabelle();
    const { delta, cursor } = blockEinfuegenDelta(ed.daten, Math.min(aw.anker, aw.kopf), { tabelle: wert });
    if (!ed.aendern({ d: delta }, { cursor })) return;
    const td = zelleSuchen(wert.id, wert.zeilen[0], wert.spalten[0]);
    if (td) td.focus();
    gruppeAktualisieren();
  };
  // die fokussierte Zelle mit ungesendetem Text (oder laufender IME-Eingabe) beim Neuzeichnen nicht anfassen
  ed.geschuetzteZelle = () => { const td = aktiveZelle(); return td && (offen.has(td) || komponiert === td) ? td : null; };

  function beiEingabe(e) {
    const td = zelleVon(e.target);
    if (!td || ed.nurLesen || e.isComposing || komponiert === td) return;
    planen(td);
  }
  function vorEingabe(e) {
    const td = zelleVon(e.target);
    if (!td) return;
    if (ed.nurLesen) { e.preventDefault(); return; }
    const art = e.inputType || '';
    if (art === 'insertParagraph') {
      // Enter bricht in der Zelle nur die Zeile um (statt neuer Absatz-Elemente)
      e.preventDefault();
      if (typeof document.execCommand === 'function') document.execCommand('insertLineBreak');
      return;
    }
    if (art === 'insertFromDrop' || art === 'deleteByDrag') { e.preventDefault(); return; }
    if (FORMAT_EINGABE.has(art)) { e.preventDefault(); zellFormat(td, FORMAT_EINGABE.get(art)); return; }
    if (art === 'historyUndo' || art === 'historyRedo') { e.preventDefault(); senden(td); if (typeof ed.verlaufEingabe === 'function') ed.verlaufEingabe(art); }
  }
  function beiTaste(e) {
    const td = zelleVon(e.target);
    if (!td || ed.nurLesen || e.isComposing) return;
    const b = tasteAuswerten(e);
    if (b === 'fett' || b === 'kursiv' || b === 'unterstrichen') { e.preventDefault(); zellFormat(td, b); } else if (b === 'zurueck' || b === 'vor') {
      e.preventDefault(); senden(td);
      if (typeof ed.verlaufEingabe === 'function') ed.verlaufEingabe(b === 'zurueck' ? 'historyUndo' : 'historyRedo');
    }
  }
  function beimEinfuegen(e) {
    const td = zelleVon(e.target);
    if (!td || ed.nurLesen) return;
    // in Zellen nur Klartext
    e.preventDefault();
    const text = e.clipboardData && typeof e.clipboardData.getData === 'function' ? e.clipboardData.getData('text/plain') : '';
    if (text && typeof document.execCommand === 'function') document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
    planen(td);
  }
  function beiKompositionStart(e) { const td = zelleVon(e.target); if (td) komponiert = td; }
  function beiKompositionEnde(e) { const td = zelleVon(e.target); if (td && komponiert === td) { komponiert = null; planen(td); } }
  function beiFokusWeg(e) {
    const td = zelleVon(e.target);
    if (td) { if (komponiert === td) komponiert = null; senden(td); }
    gruppeAktualisieren();
  }

  /** Spaltenbreite: Griff im Spaltenkopf ziehen, beim Loslassen 40–2000 px senden. */
  function griffAb(e) {
    const griff = e.target && typeof e.target.closest === 'function' ? e.target.closest('.od-spaltengriff') : null;
    if (!griff || ed.nurLesen) return;
    const th = griff.parentNode; const r = rahmenVon(th);
    const zeile = r ? tabZeile(r.dataset.tabelle) : null;
    if (!zeile) return;
    e.preventDefault();
    const wert = zeile.inhalt[0].insert.tabelle; const tabId = wert.id; const spalte = th.dataset.spalte;
    const start = e.clientX;
    const breite0 = Number.isInteger(wert.breiten[spalte]) ? wert.breiten[spalte] : Math.round(th.getBoundingClientRect().width) || 100;
    const col = r.querySelectorAll('col')[sichtbareSpalten(wert).indexOf(spalte)];
    let breite = breite0;
    const bewegen = (ev) => {
      breite = Math.min(BREITE.max, Math.max(BREITE.min, Math.round(breite0 + ev.clientX - start)));
      if (col) col.style.width = `${breite}px`;
    };
    const loesen = () => { for (const [art, fn] of hoerer) griff.removeEventListener(art, fn); };
    const ende = (ev) => {
      if (ev && Number.isFinite(ev.clientX)) bewegen(ev);
      loesen();
      const z2 = tabZeile(tabId);
      if (!z2 || breite === breite0) return;
      ed.aendern({ d: tabOp(z2, [{ typ: 'breite', spalte, px: breite }]) });
    };
    const abbruch = () => { loesen(); ed.neuAufbauen(); };
    const hoerer = [['pointermove', bewegen], ['pointerup', ende], ['pointercancel', abbruch]];
    try { griff.setPointerCapture(e.pointerId); } catch { /* ohne Capture */ }
    for (const [art, fn] of hoerer) griff.addEventListener(art, fn);
  }

  /** Nach dem Neuzeichnen: steht der Fokus in einer Zelle, deren Inhalt ersetzt wurde, Cursor ans Ende. */
  function nachRendern() {
    const td = aktiveZelle();
    const s = auswahlObjekt();
    if (!td || !s || typeof s.setBaseAndExtent !== 'function' || (s.anchorNode && td.contains(s.anchorNode))) return;
    const p = zellPosition(td, zellTextDom(td).length);
    try { s.setBaseAndExtent(p.knoten, p.offset, p.knoten, p.offset); } catch { /* egal */ }
  }

  const hoerer = [['input', beiEingabe], ['beforeinput', vorEingabe], ['keydown', beiTaste], ['paste', beimEinfuegen],
    ['compositionstart', beiKompositionStart], ['compositionend', beiKompositionEnde], ['focusout', beiFokusWeg],
    ['focusin', gruppeAktualisieren], ['pointerdown', griffAb]];
  for (const [art, fn] of hoerer) wurzel.addEventListener(art, fn);
  const ab = [ed.on('gerendert', nachRendern), ed.on('gerendert', gruppeAktualisieren)];
  const abmelden = () => {
    for (const td of [...offen.keys()]) senden(td); // ausstehende Zellen noch senden
    for (const [art, fn] of hoerer) wurzel.removeEventListener(art, fn);
    for (const x of ab) x();
  };
  ed.beimVerlassen.push(abmelden);
  return abmelden;
}
