// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dokument-Editor (Plan 05, V18): Leiste, Seite mit dem bearbeitbaren Text und Rand für Kommentare. Das Modell ist die
// Wahrheit: jede Änderung läuft als Delta über die Sitzung, danach wird aus dem Modell gezeichnet (nur geänderte
// Zeilen) und die Auswahl wieder gesetzt. Eigene Änderungen kommen in den Verlauf, fremde verschieben ihn. Das Objekt
// `ed` ist die Schnittstelle für Werkzeugleiste, Tabellen, Bilder und Kommentare (Aufgaben 12–15).

import { el, t } from '../../app.js';
import { dokument } from '../../gemeinsam/sync/typen/dokument.js';
import { positionTransformieren } from '../../gemeinsam/sync/delta.js';
import { zeilenAus, zeileBei } from './modell.js';
import { dokumentRendern, domZuIndex, indexZuDom } from './darstellung.js';
import { Rueckgaengig } from './verlauf.js';
import { eingabeEinrichten } from './eingabe.js';
import { werkzeugleisteBauen } from './werkzeugleiste.js';
import { tabelleEinrichten } from './tabelle.js';
import { bilderEinrichten } from './bilder.js';
import { druckVorbereiten } from './druck.js';
import { kommentareEinrichten } from './kommentare.js';
import { cursorEinrichten } from './cursor.js';
import { drucken } from './druck.js';
import { markdownSchreiben } from './md.js';
import { docxSchreiben } from './docx.js';

/** Nur für Tests: der zuletzt eingebundene Editor. */
export const _test = { ed: null };

const AUSWAHL_MS = 150;

/** WebP kann Word nicht: als PNG neu zeichnen (OffscreenCanvas, sonst canvas) → Blob oder null. */
async function webpZuPng(blob) {
  try {
    const bild = await createImageBitmap(blob);
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(bild.width, bild.height);
      c.getContext('2d').drawImage(bild, 0, 0);
      return await c.convertToBlob({ type: 'image/png' });
    }
    const c = document.createElement('canvas'); c.width = bild.width; c.height = bild.height;
    c.getContext('2d').drawImage(bild, 0, 0);
    return await new Promise((fertig) => c.toBlob(fertig, 'image/png'));
  } catch { return null; }
}

/** Bild aus dem Bündel für den Word-Export → {bytes, mime} oder null (fehlt / nicht lesbar). */
async function bildLaden(sitzung, datei) {
  let antwort;
  try { antwort = await fetch(sitzung.dateiUrl(datei), { credentials: 'same-origin' }); } catch { return null; }
  if (!antwort.ok) return null;
  let blob = await antwort.blob();
  let mime = blob.type || antwort.headers.get('content-type') || '';
  if (mime === 'image/webp') { blob = await webpZuPng(blob); mime = 'image/png'; if (!blob) return null; }
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}

/** Export (V18): docx/md → {name, blob}; pdf → Druckdialog, null. */
async function exportieren(ed, id) {
  const name = ed.sitzung.dok.name || 'Dokument';
  if (id === 'md') return { name: `${name}.md`, blob: new Blob([markdownSchreiben(ed.sitzung.daten)], { type: 'text/markdown;charset=utf-8' }) };
  if (id === 'pdf') { drucken(ed.wurzel); return null; }
  if (id === 'docx') {
    const autor = (ed.ctx.nutzer && (ed.ctx.nutzer.anzeigename || ed.ctx.nutzer.name)) || '';
    const blob = await docxSchreiben(ed.sitzung.daten, (datei) => bildLaden(ed.sitzung, datei), { titel: name, autor });
    return { name: `${name}.docx`, blob };
  }
  throw new Error('kein_export');
}
const gleicheAuswahl = (a, b) => a === b || (!!a && !!b && a.anker === b.anker && a.kopf === b.kopf);
const auswahlObjekt = () => (typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null);

/** Liegt die Auswahl in einem Element (Tabellenzelle, Bild)? Dann gehört sie nicht dem Text-Cursor. */
function auswahlImEmbed(wurzel) {
  const s = auswahlObjekt();
  for (let k = s && s.anchorNode; k && k !== wurzel; k = k.parentNode) if (k.nodeType === 1 && k.classList && k.classList.contains('od-embed')) return true;
  return false;
}

/** Dokument-Editor in `behaelter` einbinden (V18). */
export async function editorEinbinden(behaelter, { ctx, sitzung, recht }) {
  const z = {
    recht: recht || sitzung.recht, weg: false, zeilen: [], hoerer: new Map(), ab: [],
    cursorZiel: null, gesetzt: null, letzteAuswahl: null,
    gesendet: undefined, zuSenden: null, gesendetZeit: 0, sendeZeitgeber: null, druckAufraeumen: null,
  };
  const nurLesenMarke = el('span', { class: 'of-marke od-nur-lesen-marke', text: t('office.dok_nur_lesen') });
  const leiste = el('div', { class: 'od-leiste', role: 'toolbar', 'aria-label': t('office.dok_werkzeuge') }, nurLesenMarke);
  const wurzel = el('div', { class: 'od-text', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('office.dok_text') });
  const seite = el('div', { class: 'od-seite' }, [wurzel, el('div', { class: 'od-cursor-ebene', 'aria-hidden': 'true' })]);
  const rand = el('aside', { class: 'od-rand' });
  const editor = el('div', { class: 'od-editor' }, [leiste, el('div', { class: 'od-flaeche' }, [seite, rand])]);
  behaelter.appendChild(editor);

  const melde = (art, x) => { for (const fn of [...(z.hoerer.get(art) || [])]) { try { fn(x); } catch (e) { console.error(e); } } };

  const ed = {
    ctx, sitzung, wurzel, seite, leiste, rand, editor,
    get nurLesen() { return z.recht !== 'bearbeiten'; },
    get daten() { return sitzung.daten; },
    get zeilen() { return z.zeilen; },
    /** Letzte bekannte Auswahl im Text (für Knöpfe und Dialoge, wenn der Fokus woanders liegt). */
    get letzteAuswahl() { return z.letzteAuswahl; },
    vorgemerkt: {},
    aktionen: {}, // Einfügen/Kommentar aus der Leiste, gefüllt von den Aufgaben 13–15
    leisteZusaetze: [], // weitere Leistengruppen (() → Element), z. B. „Tabelle“
    komposition: null, // {zeilenEl, basisText, basisStart, basisDelta, start, seit} während einer IME-Eingabe
    verlauf: new Rueckgaengig(),
    beimVerlassen: [], // Aufräumer der Aufgaben 12–15 (ausstehende Zellen senden, Druckkopie entfernen …)

    on(art, fn) {
      if (!z.hoerer.has(art)) z.hoerer.set(art, new Set());
      z.hoerer.get(art).add(fn);
      return () => { z.hoerer.get(art)?.delete(fn); };
    },

    /** Eigene Auswahl als Indizes – nur, wenn sie im Text liegt. */
    auswahl() {
      const s = auswahlObjekt();
      if (!s || !s.rangeCount || !s.anchorNode || !wurzel.contains(s.anchorNode)) return null;
      const anker = domZuIndex(wurzel, z.zeilen, s.anchorNode, s.anchorOffset);
      const kopf = s.focusNode && wurzel.contains(s.focusNode) ? domZuIndex(wurzel, z.zeilen, s.focusNode, s.focusOffset) : anker;
      return anker === null || kopf === null ? null : { anker, kopf };
    },

    auswahlSetzen(aw) {
      const s = auswahlObjekt();
      if (!s || !aw || typeof s.setBaseAndExtent !== 'function') return;
      const a = indexZuDom(wurzel, z.zeilen, aw.anker);
      const k = aw.kopf === aw.anker ? a : indexZuDom(wurzel, z.zeilen, aw.kopf);
      try { s.setBaseAndExtent(a.knoten, a.offset, k.knoten, k.offset); } catch { return; }
      z.gesetzt = ed.auswahl();
      if (z.gesetzt) z.letzteAuswahl = z.gesetzt;
    },

    /** Format für die nächste Eingabe merken (null = Format ausdrücklich weglassen). */
    vormerken(attr, wert) { ed.vorgemerkt = { ...ed.vorgemerkt, [attr]: wert }; },

    rendern({ behalten = null } = {}) {
      z.zeilen = zeilenAus(sitzung.daten.delta);
      const fokusZelle = typeof ed.geschuetzteZelle === 'function' ? ed.geschuetzteZelle() : null;
      dokumentRendern(wurzel, z.zeilen, { dateiUrl: (d) => sitzung.dateiUrl(d), nurLesen: ed.nurLesen, embedRendern: ed.embedRendern || null, behalten, fokusZelle });
      melde('gerendert');
    },

    /** Alles neu aufbauen (Sicherheitsnetz, wenn der DOM nicht mehr zum Modell passt). */
    neuAufbauen() {
      wurzel.textContent = '';
      ed.rendern();
      if (z.letzteAuswahl) ed.auswahlSetzen(z.letzteAuswahl);
    },

    /** Eigene Änderung: über die Sitzung (zeichnet und setzt den Cursor), danach in den Verlauf. */
    aendern(op, { cursor = null, verlauf = true } = {}) {
      if (!op || ed.nurLesen) return false;
      const vorher = sitzung.daten;
      z.cursorZiel = cursor;
      try {
        sitzung.lokal(op);
      } catch (e) {
        z.cursorZiel = null;
        ctx.zeigeFehler(e);
        ed.neuAufbauen();
        return false;
      }
      z.cursorZiel = null;
      if (sitzung.daten === vorher) { ed.neuAufbauen(); return false; } // ohne Wirkung: den Browser-Stand verwerfen
      if (verlauf && op.d) ed.verlauf.eigene(op.d, vorher.delta, Date.now());
      if (typeof ed.leisteAktualisieren === 'function') ed.leisteAktualisieren();
      return true;
    },
  };

  function modus() {
    wurzel.setAttribute('contenteditable', ed.nurLesen ? 'false' : 'true');
    editor.classList.toggle('od-nur-lesen', ed.nurLesen);
    nurLesenMarke.hidden = !ed.nurLesen;
  }

  function nachAenderung({ op, lokal } = {}) {
    if (z.weg || !op) return;
    if (!lokal && op.d) ed.verlauf.fremde(op.d);
    const k = ed.komposition;
    if (k) {
      // die Zeile mit der laufenden IME-Eingabe bleibt stehen, alles andere wird neu gezeichnet; eigene wie fremde
      // Änderungen werden am Ende der Komposition eingerechnet
      k.seit.push(op);
      if (op.d) k.start = positionTransformieren(k.start, op.d, true);
      const nr = zeileBei(zeilenAus(sitzung.daten.delta), k.start).nr;
      ed.rendern({ behalten: new Map([[k.zeilenEl, nr]]) });
      return;
    }
    const aw = auswahlImEmbed(wurzel) ? null : ed.auswahl(); // noch mit den alten Zeilen; in einer Zelle bleibt die Auswahl dort
    ed.rendern();
    let ziel = null;
    if (lokal && Number.isInteger(z.cursorZiel)) ziel = { anker: z.cursorZiel, kopf: z.cursorZiel };
    else if (aw) ziel = dokument.auswahlTransformieren(aw, op, !!lokal);
    if (aw && ziel) ed.auswahlSetzen(ziel);
  }

  function jetztSenden() {
    z.sendeZeitgeber = null;
    if (z.weg) return;
    z.gesendet = z.zuSenden; z.gesendetZeit = Date.now();
    try { sitzung.auswahlSenden(z.zuSenden); } catch { /* offline: die nächste Auswahl geht wieder raus */ }
  }

  function auswahlGeaendert() {
    if (z.weg || ed.komposition) return;
    const aw = ed.auswahl();
    if (aw && !gleicheAuswahl(aw, z.gesetzt)) ed.vorgemerkt = {};
    z.gesetzt = null;
    if (aw) z.letzteAuswahl = aw;
    melde('auswahl', aw);
    z.zuSenden = aw;
    if (z.sendeZeitgeber || gleicheAuswahl(aw, z.gesendet)) return;
    const warten = AUSWAHL_MS - (Date.now() - z.gesendetZeit);
    if (warten <= 0) jetztSenden(); else z.sendeZeitgeber = setTimeout(jetztSenden, warten);
  }

  modus();
  ed.rendern();
  tabelleEinrichten(ed);
  bilderEinrichten(ed);
  werkzeugleisteBauen(ed);
  kommentareEinrichten(ed);
  cursorEinrichten(ed);
  const eingabeAb = eingabeEinrichten(ed);
  document.addEventListener('selectionchange', auswahlGeaendert);
  // Strg+P bzw. Browser-Druck: nur der Text, ohne Leiste und Rahmen
  const vorDruck = () => { if (wurzel.isConnected && !document.documentElement.classList.contains('od-drucken')) z.druckAufraeumen = druckVorbereiten(wurzel); };
  globalThis.addEventListener('beforeprint', vorDruck);
  z.ab.push(
    sitzung.on('aenderung', nachAenderung),
    sitzung.on('recht', ({ recht: neu } = {}) => { z.recht = neu || sitzung.recht; modus(); ed.rendern(); melde('recht', z.recht); }),
    () => document.removeEventListener('selectionchange', auswahlGeaendert),
    () => { globalThis.removeEventListener('beforeprint', vorDruck); if (z.druckAufraeumen) z.druckAufraeumen(); },
    eingabeAb,
  );
  _test.ed = ed;

  return {
    exportformate: [{ id: 'docx', titel: t('office.dok_export_docx') }, { id: 'md', titel: t('office.dok_export_md') }, { id: 'pdf', titel: t('office.dok_export_pdf') }],
    exportieren: (id) => exportieren(ed, id),
    verlassen() {
      if (z.weg) return;
      for (const fn of ed.beimVerlassen) { try { fn(); } catch (e) { console.error(e); } }
      z.weg = true;
      if (z.sendeZeitgeber) { clearTimeout(z.sendeZeitgeber); z.sendeZeitgeber = null; }
      for (const ab of z.ab) { try { ab(); } catch { /* egal */ } }
      z.ab = [];
      editor.remove();
    },
  };
}
