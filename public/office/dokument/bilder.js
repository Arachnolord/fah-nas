// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bilder und Seitenumbruch im Dokument (Plan 05): Klappmenü „Bild einfügen“ (Hochladen, Aus dem NAS), Einfügen von
// Bilddateien beim Ablegen/Einfügen (ed.bilderEinfuegen), Breite per Griff (Pointer Events, live sichtbar, beim
// Loslassen als Op) und der Knopf „Seitenumbruch“. Fremde Änderungen während des Hochladens verschieben die Stelle mit.

import { el, t } from '../../app.js';
import { normalisieren, laenge, positionTransformieren } from '../../gemeinsam/sync/delta.js';
import { GRENZEN } from '../../gemeinsam/sync/typen/dokument.js';
import { bildEinfuegenDelta, blockEinfuegenDelta } from './befehle.js';
import { domZuIndex } from './darstellung.js';

export const BILD_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BILD_ENDUNG = /\.(png|jpe?g|gif|webp)$/i;
const SEITE_ERSATZ = 642; // Innenbreite der A4-Seite in px, wenn der Browser keine liefert

/** Neue Bildbreite: gerundet, mindestens 16, höchstens die Seitenbreite bzw. 2000 px. */
export function bildBreite(start, dx, max) {
  const grenze = Math.min(Number.isFinite(max) && max > 0 ? max : GRENZEN.bild_max, GRENZEN.bild_max);
  return Math.min(grenze, Math.max(GRENZEN.bild_min, Math.round(start + dx)));
}

/** Bildwert des Embeds an Stelle `index` oder null. */
function bildBei(delta, index) {
  let p = 0;
  for (const op of delta) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    if (index < p + l) return typeof op.insert === 'object' && op.insert.bild ? op.insert.bild : null;
    p += l;
  }
  return null;
}

/** Klappmenü, Dateifeld, Griff und Seitenumbruch am Editor einrichten → Abmelden. */
export function bilderEinrichten(ed) {
  const { wurzel, sitzung, ctx } = ed;
  let menue = null;
  let eigenesEinfuegen = false; // die eigene Bild-Op verschiebt die Stelle nicht noch einmal
  const cursorStelle = () => { const aw = ed.auswahl() || ed.letzteAuswahl; return aw ? Math.min(aw.anker, aw.kopf) : null; };
  /** Fremde und eigene Änderungen (etwa Weitertippen) verschieben `stelle.pos`, solange `fn` läuft (Hochladen, NAS-Auswahl). */
  async function mitVerfolgung(stelle, fn) {
    const ab = sitzung.on('aenderung', ({ op } = {}) => { if (!eigenesEinfuegen && op && op.d) stelle.pos = positionTransformieren(stelle.pos, op.d, false); });
    try { return await fn(); } finally { ab(); }
  }
  /** Ein Bild an `pos` einfügen → Stelle dahinter. */
  function einfuegen(r, pos) {
    const alt = String(r.name || '').slice(0, GRENZEN.alt);
    const p = Math.max(0, Math.min(pos, laenge(ed.daten.delta) - 1));
    const { delta, cursor } = bildEinfuegenDelta(ed.daten, { anker: p, kopf: p }, alt ? { datei: r.datei, alt } : { datei: r.datei });
    eigenesEinfuegen = true;
    try { return ed.aendern({ d: delta }, { cursor }) ? cursor : pos; } finally { eigenesEinfuegen = false; }
  }

  ed.bilderEinfuegen = async (dateien, index = null) => {
    if (ed.nurLesen) return;
    const stelle = { pos: Number.isInteger(index) ? index : cursorStelle() };
    if (stelle.pos === null) return;
    let falscherTyp = false;
    await mitVerfolgung(stelle, async () => {
      for (const datei of dateien || []) {
        if (!datei || !BILD_MIME.includes(datei.type)) { falscherTyp = true; continue; }
        let r;
        try { r = await sitzung.dateiHochladen(datei); } catch (e) { ctx.zeigeFehler(e); continue; }
        if (r && r.datei && !ed.nurLesen) stelle.pos = einfuegen({ datei: r.datei, name: r.name || datei.name }, stelle.pos);
      }
    });
    if (falscherTyp) ctx.melden(t('office.dok_bild_typ'), 'warnung');
  };

  async function ausNas() {
    if (ed.nurLesen) return;
    const stelle = { pos: cursorStelle() ?? 0 };
    let r;
    try { r = await mitVerfolgung(stelle, () => sitzung.dateiAusNas()); } catch (e) { ctx.zeigeFehler(e); return; }
    if (!r || !r.datei || ed.nurLesen) return;
    if (r.mime ? !BILD_MIME.includes(r.mime) : !BILD_ENDUNG.test(r.name || r.datei)) { ctx.melden(t('office.dok_bild_typ'), 'warnung'); return; }
    einfuegen(r, stelle.pos);
  }

  const feld = el('input', { type: 'file', class: 'od-bild-feld', accept: BILD_MIME.join(','), multiple: true, hidden: true, tabindex: '-1' });
  feld.addEventListener('change', () => {
    const dateien = Array.from(feld.files || []);
    try { feld.value = ''; } catch { /* egal */ } // dieselbe Datei lässt sich erneut wählen
    if (dateien.length) ed.bilderEinfuegen(dateien, cursorStelle());
  });
  ed.editor.appendChild(feld);

  function menueZu() {
    if (!menue) return;
    menue.hidden = true;
    const k = ed.leiste.querySelector('.od-knopf-bild');
    if (k) k.setAttribute('aria-expanded', 'false');
  }
  function menueBauen() {
    const eintrag = (text, fn) => el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', role: 'menuitem', 'aria-label': text, 'data-bearbeiten': '', onclick: () => { menueZu(); fn(); } }, text);
    const m = el('div', { class: 'od-palette od-bild-menue', role: 'menu', 'aria-label': t('office.dok_bild'), hidden: true }, [
      eintrag(t('office.dok_bild_hochladen'), () => feld.click()),
      eintrag(t('office.dok_bild_nas'), () => { ausNas(); }),
    ]);
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); menueZu(); } });
    return m;
  }
  ed.aktionen.bild = () => {
    if (ed.nurLesen) return;
    const knopf = ed.leiste.querySelector('.od-knopf-bild');
    if (!knopf) return;
    if (!menue || menue.parentNode !== knopf.parentNode) { if (menue && menue.parentNode) menue.parentNode.removeChild(menue); menue = menueBauen(); knopf.parentNode.appendChild(menue); }
    menue.hidden = !menue.hidden;
    knopf.setAttribute('aria-haspopup', 'true');
    knopf.setAttribute('aria-expanded', menue.hidden ? 'false' : 'true');
  };
  ed.aktionen.seitenumbruch = () => {
    if (ed.nurLesen) return;
    const pos = cursorStelle();
    if (pos === null) return;
    const { delta, cursor } = blockEinfuegenDelta(ed.daten, pos, { seitenumbruch: true });
    ed.aendern({ d: delta }, { cursor });
  };

  /** Bildbreite: Griff ziehen (live), beim Loslassen als Op. */
  function griffAb(e) {
    const griff = e.target && typeof e.target.closest === 'function' ? e.target.closest('.od-bild-griff') : null;
    if (!griff || ed.nurLesen) return;
    const rahmen = griff.parentNode;
    const img = rahmen.querySelector('img.od-bild');
    const index = domZuIndex(wurzel, ed.zeilen, rahmen, 0);
    const wert = index === null ? null : bildBei(ed.daten.delta, index);
    if (!img || !wert) return;
    e.preventDefault();
    const start = Number.isInteger(wert.breite) ? wert.breite : Math.round(img.getBoundingClientRect().width) || img.naturalWidth || 300;
    const x0 = e.clientX; const max = wurzel.clientWidth || SEITE_ERSATZ;
    let breite = start;
    const bewegen = (ev) => { breite = bildBreite(start, ev.clientX - x0, max); img.style.width = `${breite}px`; };
    const loesen = () => { for (const [art, fn] of hoerer) griff.removeEventListener(art, fn); };
    const ende = (ev) => {
      if (ev && Number.isFinite(ev.clientX)) bewegen(ev);
      loesen();
      if (breite === start) return;
      const i = domZuIndex(wurzel, ed.zeilen, rahmen, 0);
      if (i !== null) ed.aendern({ d: normalisieren([{ retain: i }, { retain: { bild: { breite } } }]) });
    };
    const abbruch = () => { loesen(); ed.neuAufbauen(); };
    const hoerer = [['pointermove', bewegen], ['pointerup', ende], ['pointercancel', abbruch]];
    try { griff.setPointerCapture(e.pointerId); } catch { /* ohne Capture */ }
    for (const [art, fn] of hoerer) griff.addEventListener(art, fn);
  }

  const draussen = (e) => {
    if (!menue || menue.hidden) return;
    const k = e.target;
    if (menue.contains(k) || (k && typeof k.closest === 'function' && k.closest('.od-knopf-bild'))) return;
    menueZu();
  };
  wurzel.addEventListener('pointerdown', griffAb);
  document.addEventListener('pointerdown', draussen);
  const abmelden = () => {
    wurzel.removeEventListener('pointerdown', griffAb);
    document.removeEventListener('pointerdown', draussen);
    feld.remove();
  };
  ed.beimVerlassen.push(abmelden);
  return abmelden;
}
