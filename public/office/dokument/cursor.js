// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fremde Cursor im Dokument (Plan 05): je anderem Klienten ein farbiger Strich mit Namen und seine Auswahl als
// durchscheinende Fläche. Die Lage kommt aus Range-Rechtecken relativ zur Seite und wird per CSSOM gesetzt (kein
// HTML aus Fremddaten); gezeichnet wird gebündelt im nächsten Frame nach Änderung, Auswahl, Scrollen und Größenwechsel.

import { el } from '../../app.js';
import { indexZuDom } from './darstellung.js';

const FARBE_ERSATZ = '#1d4ed8';
const sichereFarbe = (f) => (typeof f === 'string' && /^#[0-9a-f]{6}$/i.test(f) ? f : FARBE_ERSATZ);

function kasten(klasse, r, farbe) {
  const e = el('div', { class: klasse });
  e.style.setProperty('--farbe', farbe);
  e.style.left = `${Math.round(r.x)}px`; e.style.top = `${Math.round(r.y)}px`;
  e.style.width = `${Math.max(0, Math.round(r.b))}px`; e.style.height = `${Math.max(0, Math.round(r.h))}px`;
  return e;
}

/** Cursor und Auswahlen der Einträge in `ebene` zeichnen; `rechteckeFuer(anker, kopf)` → [{x, y, b, h}] relativ zur Seite. */
export function cursorZeichnen(ebene, eintraege, rechteckeFuer) {
  ebene.textContent = '';
  for (const e of eintraege || []) {
    if (!e || !e.auswahl) continue;
    const farbe = sichereFarbe(e.farbe);
    const { anker, kopf } = e.auswahl;
    const von = Math.min(anker, kopf); const bis = Math.max(anker, kopf);
    if (von !== bis) for (const r of rechteckeFuer(von, bis)) ebene.appendChild(kasten('od-fauswahl', r, farbe));
    const [c] = rechteckeFuer(kopf, kopf);
    if (!c) continue;
    const strich = kasten('od-fcursor', { ...c, b: 2 }, farbe);
    const name = el('div', { class: 'od-fcursor-name', text: String(e.name || '') });
    name.style.setProperty('--farbe', farbe);
    name.style.left = `${Math.round(c.x)}px`; name.style.top = `${Math.round(c.y)}px`;
    ebene.append(strich, name);
  }
}

/** Rechtecke einer Stelle bzw. eines Bereichs im Text, relativ zur Seite. */
function rechteckeVon(ed) {
  return (von, bis) => {
    if (typeof document.createRange !== 'function') return [];
    const a = indexZuDom(ed.wurzel, ed.zeilen, von);
    const b = von === bis ? a : indexZuDom(ed.wurzel, ed.zeilen, bis);
    const r = document.createRange();
    try { r.setStart(a.knoten, a.offset); r.setEnd(b.knoten, b.offset); } catch { return []; }
    let liste = Array.from(r.getClientRects() || []);
    if (!liste.length && von === bis && typeof r.getBoundingClientRect === 'function') liste = [r.getBoundingClientRect()];
    const basis = ed.seite.getBoundingClientRect();
    return liste.map((x) => ({ x: x.left - basis.left, y: x.top - basis.top, b: x.width, h: x.height || 16 }));
  };
}

/** Fremde Auswahlen der Sitzung verfolgen und zeichnen → Abmelden. */
export function cursorEinrichten(ed) {
  const ebene = ed.seite.querySelector('.od-cursor-ebene');
  const eintraege = new Map(); // von → {von, name, farbe, auswahl}
  for (const e of (ed.sitzung.fremdeAuswahl && ed.sitzung.fremdeAuswahl.values()) || []) if (e && e.auswahl) eintraege.set(e.von, e);
  let geplant = false;
  const zeichnen = () => { geplant = false; if (ebene) cursorZeichnen(ebene, [...eintraege.values()], rechteckeVon(ed)); };
  const planen = () => {
    if (geplant) return;
    geplant = true;
    (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame : (fn) => setTimeout(fn, 16))(zeichnen);
  };
  const ab = [
    ed.sitzung.on('auswahl', (e) => {
      if (!e || !e.von) return;
      if (e.auswahl) eintraege.set(e.von, e); else eintraege.delete(e.von);
      planen();
    }),
    ed.sitzung.on('anwesend', (liste) => {
      const da = new Set((Array.isArray(liste) ? liste : []).map((x) => x && x.kid));
      for (const von of [...eintraege.keys()]) if (!da.has(von)) eintraege.delete(von);
      planen();
    }),
    ed.on('gerendert', planen),
  ];
  globalThis.addEventListener('resize', planen);
  globalThis.addEventListener('scroll', planen, true);
  planen();
  const abmelden = () => {
    for (const x of ab) x();
    globalThis.removeEventListener('resize', planen);
    globalThis.removeEventListener('scroll', planen, true);
  };
  ed.beimVerlassen.push(abmelden);
  return abmelden;
}
