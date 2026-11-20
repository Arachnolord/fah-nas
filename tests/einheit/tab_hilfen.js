// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Testhilfen der Office-Tabelle (Plan 06, Aufgaben 6–19): eine Mappe aus einer knappen Beschreibung bauen, die
// w-Werte eines Blatts lesen, Daten tief einfrieren (anwenden darf nicht verändern) und den WCAG-Kontrast zweier Farben
// rechnen (wie ui_fixes.test.js). Für die Editor-Tests (Aufgaben 18, 19) dazu eine Schein-Sitzung, das Einbinden in
// die DOM-Attrappe mit Tasten, Zeigern und Ereignissen wie im Browser und eine Zwischenablage-Attrappe.

import { zwischen } from '../../public/gemeinsam/sync/typen/board.js';

/**
 * Mappe aus { <blattId>: { <adr>: w | [w, f] } } → Daten der Tabelle. Blätter heißen Tabelle1, Tabelle2 … in
 * Schlüsselreihenfolge, pos über zwischen (erstes Blatt 'i' wie leer()); leere w entfallen, eine Zelle ohne w und f fehlt.
 */
export function mappe(beschreibung) {
  let pos = null;
  const blaetter = Object.entries(beschreibung).map(([id, zellen], i) => {
    pos = zwischen(pos, null);
    const z = {};
    for (const [adr, eintrag] of Object.entries(zellen)) {
      const [w, f] = Array.isArray(eintrag) ? eintrag : [eintrag, undefined];
      const zelle = {};
      if (typeof w === 'string' && w !== '') zelle.w = w;
      if (f && Object.keys(f).length) zelle.f = { ...f };
      if (Object.keys(zelle).length) z[adr] = zelle;
    }
    return { id, name: `Tabelle${i + 1}`, pos, zellen: z, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } };
  });
  return { blaetter };
}

/** Die w-Werte eines Blatts als { <adr>: w } (Zellen nur mit Format fehlen). */
export function werteVon(daten, blattId) {
  const blatt = daten.blaetter.find((b) => b.id === blattId);
  const aus = {};
  for (const [adr, zelle] of Object.entries(blatt?.zellen ?? {})) if (typeof zelle?.w === 'string') aus[adr] = zelle.w;
  return aus;
}

/** Objekt samt allen Unterobjekten einfrieren; gibt dasselbe Objekt zurück. */
export function tiefFrieren(obj) {
  const offen = [obj];
  while (offen.length) {
    const o = offen.pop();
    if (o === null || typeof o !== 'object' || Object.isFrozen(o)) continue;
    Object.freeze(o);
    for (const wert of Object.values(o)) offen.push(wert);
  }
  return obj;
}

function hexZuRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function leuchtdichte([r, g, b]) {
  const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG-Kontrastverhältnis zweier Farben (#rrggbb oder #rgb), 1 … 21. */
export function kontrast(vorne, hinten) {
  const l1 = leuchtdichte(hexZuRgb(vorne)), l2 = leuchtdichte(hexZuRgb(hinten));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---- Editor-Tests (Aufgaben 18, 19) ----------------------------------------------------------------------------------

/**
 * Schein-Sitzung (V18) für den Tabellen-Editor: lokal(op) prüft und wendet die Op an wie der Sync-Klient, zeichnet sie in
 * `ops` auf und meldet 'aenderung' {op, lokal: true}; fremd(op) meldet lokal: false. ctx.melden landet in `meldungen`,
 * ctx.zeigeFehler in `fehler`, gesendete Auswahlen in `auswahlen`.
 */
export function scheinSitzung(typ, daten, recht = 'bearbeiten') {
  const hoerer = new Map();
  const s = {
    dok: { id: 'oX', art: 'tabelle', name: 'Budget', besitzer: 'anna', recht }, recht, kid: 'k1', anwesend: [], daten,
    ops: [], auswahlen: [], meldungen: [], fehler: [],
    lokal(op) { typ.pruefen(op); s.daten = typ.anwenden(s.daten, op); s.ops.push(op); s.emit('aenderung', { op, lokal: true }); },
    fremd(op) { typ.pruefen(op); s.daten = typ.anwenden(s.daten, op); s.emit('aenderung', { op, lokal: false }); },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    emit(art, x) { for (const fn of [...(hoerer.get(art) || [])]) fn(x); },
    hoererZahl() { let n = 0; for (const x of hoerer.values()) n += x.size; return n; },
    auswahlSenden(a) { s.auswahlen.push(a); },
  };
  return s;
}

/** Zwischenablage-Attrappe für copy/cut/paste: daten[typ] = Text, fehlende Typen lesen sich wie im Browser als ''. */
export function clipboardAttrappe(daten = {}) {
  return {
    daten: { ...daten },
    get types() { return Object.keys(this.daten); },
    setData(typ, wert) { this.daten[typ] = String(wert); },
    getData(typ) { return Object.hasOwn(this.daten, typ) ? this.daten[typ] : ''; },
  };
}

/** Angezeigter Text der Zelle `adr` im Raster; nicht gezeichnet (außerhalb des Ausschnitts, ausgeblendet) → null. */
export function zelleText(wurzel, adr) {
  const zelle = wurzel.querySelector(`.ot-zelle[data-adr="${adr}"]`);
  return zelle ? zelle.textContent : null;
}

/**
 * Tabellen-Editor in einen neuen Behälter einbinden → { behaelter, wurzel, editor, ctx, taste, tippen, klick, zeiger,
 * zeigerAuf, ereignis }. Tasten gehen wie im Browser an das fokussierte Feld des Editors (sonst an die Fokusfalle); bleibt
 * ein Zeichen unverhindert, fügt das Feld es ein und meldet 'input'. klick/zeiger = pointerdown + pointerup auf der Zelle.
 */
export async function editorTesten(editorEinbinden, s, ctxMehr = {}) {
  const behaelter = document.createElement('div');
  document.body.appendChild(behaelter);
  // dasselbe Objekt ergänzen (nicht kopieren): Schein-ctx lesen ihre Antworten (ctx.antwort …) über sich selbst
  const ctx = ctxMehr;
  const standard = {
    nutzer: { name: 'anna', anzeigename: 'Anna A.' }, t: (k) => k,
    melden: (text, art) => { s.meldungen.push([text, art]); }, zeigeFehler: (e) => { s.fehler.push(e); },
  };
  for (const [k, v] of Object.entries(standard)) if (!(k in ctx)) ctx[k] = v;
  const editor = await editorEinbinden(behaelter, { ctx, sitzung: s, recht: s.recht });
  const wurzel = behaelter.querySelector('.ot-editor');
  const ziel = () => {
    const a = document.activeElement;
    return a && wurzel.contains(a) && (a.localName === 'input' || a.localName === 'textarea') ? a : wurzel.querySelector('.ot-fokus');
  };
  const taste = (key, mehr = {}) => {
    const feld = ziel();
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mehr });
    feld.dispatchEvent(ev);
    if (!ev.defaultPrevented && key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
      feld.value += key;
      feld.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
    }
    return ev;
  };
  const tippen = (text) => { for (const zeichen of text) taste(zeichen); };
  const zelle = (adr) => {
    const z = wurzel.querySelector(`.ot-zelle[data-adr="${adr}"]`);
    if (!z) throw new Error(`Zelle ${adr} ist nicht gezeichnet`);
    return z;
  };
  const zeigerAuf = (knoten, typ, mehr = {}) => {
    const ev = new Event(typ, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: typ === 'pointerup' ? 0 : 1, clientX: 0, clientY: 0, shiftKey: false, ...mehr });
    knoten.dispatchEvent(ev);
    return ev;
  };
  const zeiger = (adr, pointerType = 'mouse', mehr = {}) => {
    const z = zelle(adr);
    zeigerAuf(z, 'pointerdown', { pointerType, ...mehr });
    zeigerAuf(z, 'pointerup', { pointerType, ...mehr });
  };
  const klick = (adr, mehr = {}) => zeiger(adr, 'mouse', mehr);
  const ereignis = (art, init = {}) => {
    const ev = new Event(art, { bubbles: true, cancelable: true, ...init });
    ziel().dispatchEvent(ev);
    return ev;
  };
  return { behaelter, wurzel, editor, ctx, taste, tippen, klick, zeiger, zeigerAuf, ereignis };
}
