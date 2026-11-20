// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 19): Werkzeugleiste (Fett, Zahlformat, Farben, Ausrichtung, Fixieren, Funktionen,
// nur lesen), Blätter-Reiter (neu, umbenennen mit Prüfung, verschieben, löschen, letztes Blatt bleibt), Spaltenbreite
// ziehen, Kontextmenü (Zeilen/Spalten, Sortieren), Filter als reine Ansicht, Symbole, Verbote im Quelltext und die
// Kontraste des Rasters.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { mappe, kontrast, scheinSitzung, editorTesten, zelleText } from './tab_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const SYMBOLE = path.join(PUBLIC, 'symbole.svg');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);
const ticks = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

let dom; let tabelle; let editorEinbinden; let _test; let FARBEN; let HINTERGRUENDE; let adresse;
const offen = [];
before(async () => {
  dom = domAttrappe();
  globalThis.requestAnimationFrame = undefined; // Rückfall des Editors: sofort zeichnen
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ tabelle } = await imp('gemeinsam', 'sync', 'typen', 'tabelle.js'));
  ({ FARBEN, HINTERGRUENDE } = await imp('gemeinsam', 'sync', 'typen', 'dokument-attribute.js'));
  ({ adresse } = await imp('office', 'tabelle', 'formeln', 'adresse.js'));
  ({ editorEinbinden, _test } = await imp('office', 'tabelle', 'editor.js'));
});
after(() => dom.aufraeumen());
afterEach(() => {
  for (const e of offen.splice(0)) { try { e.verlassen(); } catch { /* schon verlassen */ } }
  document.body.textContent = '';
  document.activeElement = null;
});

const schein = (daten, recht) => scheinSitzung(tabelle, daten, recht);

/** Schein-ctx: eingabe antwortet ctx.antwort (und merkt sich die Prüfung), bestaetigen ctx.bestaetigt, dialog legt den Inhalt in den body. */
function ctxSchein() {
  const ctx = {
    antwort: null, bestaetigt: false, eingaben: [], fragen: [], dialoge: [],
    eingabe(o) { ctx.eingaben.push(o); return Promise.resolve(ctx.antwort); },
    letztePruefung(w) { return ctx.eingaben.at(-1).pruefen(w); },
    bestaetigen(text, o) { ctx.fragen.push([text, o]); return Promise.resolve(ctx.bestaetigt); },
    dialog(inhalt, o = {}) {
      const koerper = document.createElement('div');
      koerper.className = 'dialog-koerper';
      for (const k of [].concat(inhalt)) if (k) koerper.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
      document.body.appendChild(koerper);
      const d = {
        koerper, element: koerper, titel: o.titel, offen: true,
        schliessen() { if (!d.offen) return; d.offen = false; koerper.remove(); if (o.beimSchliessen) o.beimSchliessen(); },
      };
      ctx.dialoge.push(d);
      return d;
    },
  };
  return ctx;
}

async function einbinden(s) {
  const x = await editorTesten(editorEinbinden, s, ctxSchein());
  offen.push(x.editor);
  const { wurzel, zeigerAuf, ctx } = x;
  /** Werkzeugleiste: Knopf [data-aktion], Auswahlfeld (Wert), Palette (erst öffnen) oder Knopf mit [data-wert]. */
  const leiste = (aktion, wert) => {
    const l = wurzel.querySelector('.ot-leiste');
    const feld = l.querySelector(`select[data-aktion="${aktion}"]`);
    if (feld) { feld.value = wert; feld.dispatchEvent(new Event('change', { bubbles: true })); return; }
    const oeffner = l.querySelector(`[data-menue="${aktion}"]`);
    if (oeffner) oeffner.click();
    const knopf = l.querySelector(wert === undefined ? `button[data-aktion="${aktion}"]` : `button[data-aktion="${aktion}"][data-wert="${wert}"]`);
    assert.ok(knopf, `Leiste: ${aktion} ${wert ?? ''}`);
    knopf.click();
  };
  /** Menü des i-ten Blatt-Reiters öffnen → Inhalt des Dialogs. */
  const reiterMenue = (i) => {
    const tab = wurzel.querySelectorAll('.ot-reiter .ot-tab')[i];
    assert.ok(tab, `Reiter ${i}`);
    tab.querySelector('[data-aktion="menue"]').click();
    return ctx.dialoge.at(-1).koerper;
  };
  const reiter = async (aktion, i) => {
    if (aktion === 'neu') wurzel.querySelector('.ot-reiter [data-aktion="neu"]').click();
    else reiterMenue(i).querySelector(`[data-aktion="${aktion}"]`).click();
    await ticks();
  };
  /** Griff um dx Pixel ziehen (pointerdown, pointermove, pointerup). */
  const ziehen = (selektor, dx) => {
    const griff = wurzel.querySelector(selektor);
    assert.ok(griff, selektor);
    zeigerAuf(griff, 'pointerdown', { clientX: 0 });
    zeigerAuf(griff, 'pointermove', { clientX: dx });
    zeigerAuf(griff, 'pointerup', { clientX: dx });
  };
  /** Kontextmenü (rechte Maustaste) auf der aktiven Zelle bzw. ihrem Spalten-/Zeilenkopf, dann den Eintrag wählen. */
  const menue = (art, aktion) => {
    const { anker } = _test.ed.aw;
    const ziel = art === 'spalte' ? wurzel.querySelector(`.ot-kopf-spalte[data-s="${anker.s}"]`)
      : art === 'zeile' ? wurzel.querySelector(`.ot-kopf-zeile[data-z="${anker.z}"]`)
        : wurzel.querySelector(`.ot-zelle[data-adr="${adresse(anker.z, anker.s)}"]`);
    ziel.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 }));
    const eintrag = wurzel.querySelector(`.ot-kontext [data-aktion="${aktion}"]`);
    assert.ok(eintrag, `Kontextmenü: ${aktion}`);
    eintrag.click();
  };
  /** Filter über die Leiste auf Spalte `spalte`: nur `werte` angehakt, übernehmen. */
  const filter = async (spalte, werte) => {
    x.klick(adresse(1, spalte));
    leiste('filter');
    const d = ctx.dialoge.at(-1);
    for (const kk of d.koerper.querySelectorAll('input[type="checkbox"]')) {
      kk.checked = werte.includes(kk.value);
      kk.dispatchEvent(new Event('change', { bubbles: true }));
    }
    d.koerper.querySelector('[data-aktion="uebernehmen"]').click();
    await ticks();
  };
  return { ...x, leiste, reiter, reiterMenue, ziehen, menue, filter };
}

/** Alle .js-Dateien unter `ordner` (rekursiv). */
async function alleJs(ordner) {
  const aus = [];
  for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
    const p = path.join(ordner, e.name);
    if (e.isDirectory()) aus.push(...await alleJs(p)); else if (e.name.endsWith('.js')) aus.push(p);
  }
  return aus.sort();
}

test('Fett, Zahlformat, Farbe, Ausrichtung aus der Leiste', async () => {
  const s = schein(mappe({ blatt1: { A1: '1', A2: '2' } })); const { klick, leiste, wurzel } = await einbinden(s);
  klick('A1'); klick('A2', { shiftKey: true }); leiste('fett');
  assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { f: { fett: true } }, A2: { f: { fett: true } } } });
  leiste('zahl', 'euro'); assert.deepEqual(s.ops.at(-1).werte.A1, { f: { zahl: 'euro' } });
  leiste('farbe', FARBEN.rot); assert.deepEqual(s.ops.at(-1).werte.A2, { f: { farbe: '#b42318' } });
  leiste('ausr', 'mitte'); assert.deepEqual(s.ops.at(-1).werte.A1, { f: { ausr: 'mitte' } });
  // Füllfarbe und „Keine“; die Leiste zeigt den Stand der aktiven Zelle
  leiste('hinter', HINTERGRUENDE.gelb); assert.deepEqual(s.ops.at(-1).werte.A1, { f: { hinter: '#fff3a3' } });
  leiste('farbe', ''); assert.deepEqual(s.ops.at(-1).werte.A1, { f: { farbe: null } });
  const l = wurzel.querySelector('.ot-leiste');
  assert.equal(l.querySelector('[data-aktion="fett"]').getAttribute('aria-pressed'), 'true');
  assert.equal(l.querySelector('[data-aktion="ausr"][data-wert="mitte"]').getAttribute('aria-pressed'), 'true');
  assert.equal(l.querySelector('select[data-aktion="zahl"]').value, 'euro');
  leiste('zahl', 'standard'); assert.deepEqual(s.ops.at(-1).werte.A1, { f: { zahl: null } });
  // fx: Funktionsname in die Bearbeitungszeile; Rückgängig aus der Leiste
  leiste('funktion', 'SUMME'); assert.deepEqual([_test.ed.bearbeitet, _test.ed.bearbeitOrt, wurzel.querySelector('.ot-formel').value], [true, 'zeile', '=SUMME(']);
  _test.ed.bearbeitenBeenden(false);
  const vorher = s.ops.length; leiste('zurueck'); assert.equal(s.ops.length, vorher + 1);
  assert.deepEqual(s.ops.at(-1).werte.A1, { f: { zahl: 'euro' } });
});

test('Leiste beim Lesen: nur Filter (und Menü), Rechtewechsel baut um', async () => {
  const s = schein(mappe({ blatt1: { A1: '1' } }), 'lesen'); const { wurzel } = await einbinden(s);
  const aktionen = () => wurzel.querySelectorAll('.ot-leiste [data-aktion]').map((k) => k.getAttribute('data-aktion'));
  assert.deepEqual(aktionen(), ['filter', 'menue']);
  assert.equal(wurzel.querySelector('.ot-reiter [data-aktion="neu"]'), null);
  s.emit('recht', { recht: 'bearbeiten' });
  assert.ok(aktionen().includes('fett') && aktionen().includes('fixieren'));
  assert.ok(wurzel.querySelector('.ot-reiter [data-aktion="neu"]'));
});

test('Reiter: neu, umbenennen mit Prüfung, löschen, letztes Blatt nicht löschbar', async () => {
  const s = schein(tabelle.leer()); const { reiter, ctx, reiterMenue, wurzel } = await einbinden(s);
  reiter('neu'); assert.deepEqual([s.ops.at(-1).typ, s.ops.at(-1).blatt.name, s.ops.at(-1).blatt.pos], ['blatt_neu', 'office.tab_blatt_standard1', 'r']);
  assert.equal(_test.ed.blatt, s.ops[0].blatt.id, 'das neue Blatt ist aktiv');
  ctx.antwort = 'Tabelle1'; await reiter('umbenennen', 1); assert.equal(ctx.letztePruefung('Tabelle1'), 'office.tab_name_doppelt');
  assert.equal(s.ops.length, 1, 'ein doppelter Name wird nicht gesendet');
  assert.deepEqual(['', 'x'.repeat(32), 'a/b', "'a"].map((n) => ctx.letztePruefung(n)), ['office.tab_name_leer', 'office.tab_name_lang', 'office.tab_name_zeichen', 'office.tab_name_zeichen']);
  ctx.antwort = 'Kosten'; await reiter('umbenennen', 1); assert.deepEqual(s.ops.at(-1), { typ: 'blatt_umbenennen', blatt: s.ops[0].blatt.id, name: 'Kosten' });
  assert.deepEqual(wurzel.querySelectorAll('.ot-reiter .ot-tab-name').map((k) => k.textContent), ['Tabelle1', 'Kosten']);
  await reiter('links', 1); assert.equal(s.ops.at(-1).typ, 'blatt_verschieben');
  assert.deepEqual(wurzel.querySelectorAll('.ot-reiter .ot-tab-name').map((k) => k.textContent), ['Kosten', 'Tabelle1']);
  assert.equal(reiterMenue(0).querySelector('[data-aktion="links"]').disabled, true, 'ganz links geht es nicht weiter');
  await reiter('rechts', 0); assert.deepEqual(wurzel.querySelectorAll('.ot-reiter .ot-tab-name').map((k) => k.textContent), ['Tabelle1', 'Kosten']);
  ctx.bestaetigt = true; await reiter('loeschen', 1); assert.equal(s.ops.at(-1).typ, 'blatt_loeschen');
  assert.deepEqual(s.ops.at(-1), { typ: 'blatt_loeschen', blatt: s.ops[0].blatt.id, rest: ['blatt1'] });
  assert.equal(ctx.fragen.at(-1)[1].gefahr, true);
  assert.equal(reiterMenue(0).querySelector('[data-aktion="loeschen"]').disabled, true);
});

test('Spaltenbreite ziehen', async () => {
  const s = schein(mappe({ blatt1: {} })); const { ziehen, wurzel, zeigerAuf } = await einbinden(s);
  ziehen('.ot-griff[data-spalte="2"]', 40); assert.deepEqual(s.ops.at(-1), { typ: 'spalte_breite', blatt: 'blatt1', spalte: 2, breite: 140 });
  ziehen('.ot-griff[data-spalte="2"]', -500); assert.equal(s.ops.at(-1).breite, 20);
  assert.equal(_test.ed.aw.kopf.s, 1, 'der Griff wählt keine Spalte');
  // Vorschau während des Ziehens: Spalte 2 ist schon breiter, gesendet wird erst beim Loslassen
  const griff = wurzel.querySelector('.ot-griff[data-spalte="2"]'); const anzahl = s.ops.length;
  zeigerAuf(griff, 'pointerdown', { clientX: 0 }); zeigerAuf(griff, 'pointermove', { clientX: 80 });
  assert.equal(wurzel.querySelector('.ot-kopf-spalte[data-s="2"]').style.width, '100px'); assert.equal(s.ops.length, anzahl);
  zeigerAuf(griff, 'pointerup', { clientX: 80 }); assert.equal(s.ops.at(-1).breite, 100);
  griff.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true })); assert.deepEqual(s.ops.at(-1), { typ: 'spalte_breite', blatt: 'blatt1', spalte: 2, breite: null });
});

test('Kontextmenü: Zeilen einfügen und löschen, Spalten, Sortieren', async () => {
  const s = schein(mappe({ blatt1: { A1: 'b', A2: 'a' } })); const { klick, menue } = await einbinden(s);
  klick('A2'); klick('B3', { shiftKey: true }); menue('zelle', 'zeilen_einfuegen'); assert.deepEqual(s.ops.at(-1), { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 2, anzahl: 2 });
  klick('A1'); menue('zelle', 'sortieren_auf'); assert.equal(s.ops.at(-1).typ, 'sortieren'); assert.equal(s.ops.at(-1).bereich, 'A1:A4'); // A2 'a' liegt nach dem Einfügen in A4
  assert.deepEqual(s.ops.at(-1).zellen.A1.w, 'a');
  klick('B1'); menue('spalte', 'spalten_einfuegen'); assert.deepEqual(s.ops.at(-1), { typ: 'spalten_einfuegen', blatt: 'blatt1', ab: 2, anzahl: 1 });
  klick('A3'); menue('zelle', 'zeilen_loeschen'); assert.deepEqual(s.ops.at(-1), { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 3, anzahl: 1 });
  klick('A1'); menue('zelle', 'inhalt_loeschen'); assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: null } } });
  assert.equal(document.querySelector('.ot-kontext'), null, 'das Menü schließt nach der Wahl');
});

test('Filter ist eine Ansicht: keine Op, Zeilen verschwinden nur bei mir', async () => {
  const s = schein(mappe({ blatt1: { A1: 'Stadt', A2: 'Bern', A3: 'Ulm' } })); const { wurzel, filter, ctx } = await einbinden(s);
  const anzahl = s.ops.length; await filter(1, ['Ulm']);
  assert.equal(s.ops.length, anzahl); assert.equal(zelleText(wurzel, 'A2'), null); assert.equal(zelleText(wurzel, 'A3'), 'Ulm');
  assert.equal(ctx.dialoge.at(-1).koerper.querySelector('.erklaerung').textContent, 'office.tab_filter_erklaerung');
  // die gefilterte Spalte trägt den Filterknopf im Kopf; „Filter entfernen“ zeigt wieder alles
  const knopf = wurzel.querySelector('.ot-kopf-spalte[data-s="1"] .ot-filterknopf'); assert.ok(knopf);
  assert.equal(wurzel.querySelector('.ot-leiste [data-aktion="filter"]').getAttribute('aria-pressed'), 'true');
  knopf.click(); ctx.dialoge.at(-1).koerper.querySelector('[data-aktion="entfernen"]').click();
  assert.equal(zelleText(wurzel, 'A2'), 'Bern'); assert.equal(wurzel.querySelector('.ot-filterknopf'), null);
  assert.equal(s.ops.length, anzahl);
});

test('Fixieren schaltet um', async () => {
  const s = schein(mappe({ blatt1: {} })); const { leiste, wurzel } = await einbinden(s);
  leiste('fixieren'); assert.deepEqual(s.ops.at(-1), { typ: 'fixieren', blatt: 'blatt1', zeilen: 1 });
  assert.equal(wurzel.querySelector('.ot-leiste [data-aktion="fixieren"]').getAttribute('aria-pressed'), 'true');
  leiste('fixieren'); assert.deepEqual(s.ops.at(-1), { typ: 'fixieren', blatt: 'blatt1', zeilen: 0 });
});

test('Symbole, Verbote und Raster-Kontraste', async () => {
  const svg = await fs.readFile(SYMBOLE, 'utf8'); for (const n of ['sortieren-auf', 'sortieren-ab', 'filter', 'fixieren', 'funktion']) assert.ok(svg.includes(`id="symbol-${n}"`), n);
  for (const datei of await alleJs(path.join(PUBLIC, 'office', 'tabelle'))) {
    const q = await fs.readFile(datei, 'utf8');
    assert.doesNotMatch(q, /innerHTML|outerHTML|insertAdjacentHTML|setAttribute\(\s*['"]style|\son[a-z]+\s*=\s*["']/, datei);
  }
  for (const [vorder, hinter] of [['#1c1c1c', '#ffffff'], ['#374151', '#f3f4f6'], ['#ffffff', '#1d4ed8']]) assert.ok(kontrast(vorder, hinter) >= 4.5, `${vorder} auf ${hinter}`);
});
