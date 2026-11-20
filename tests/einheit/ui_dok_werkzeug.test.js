// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Werkzeugleiste des Dokument-Editors (Plan 05 Aufgabe 12): Tastenkürzel, Zeichen- und Absatzformate, Farben, Listen,
// Einzug, Ausrichtung, Links (geprüfte Eingabe, leer entfernt), Rückgängig/Wiederholen, Zustand der Knöpfe, Symbole,
// keine Bearbeiten-Knöpfe im Nur-lesen-Modus.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let dokument; let editorEinbinden; let _test; let tasteAuswerten; let sel;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ editorEinbinden, _test } = await imp('office', 'dokument', 'editor.js'));
  ({ tasteAuswerten } = await imp('office', 'dokument', 'werkzeugleiste.js'));
});
after(() => dom.aufraeumen());
beforeEach(() => { sel = auswahlAttrappe(); });

const schein = (delta, recht) => scheinSitzung(dokument, delta, recht);
const einbinden = (s, ctx) => einbindenIn(editorEinbinden, s, ctx);
const knopf = (b, name) => b.querySelector(`.od-leiste [aria-label="office.dok_${name}"]`);
const taste = (w, key, mods = {}) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...mods }); w.dispatchEvent(e); return e; };
const eingabe = (art, init = {}) => new InputEvent(art, { bubbles: true, cancelable: art === 'beforeinput', ...init });

test('tasteAuswerten', () => {
  assert.equal(tasteAuswerten({ key: 'b', ctrlKey: true }), 'fett'); assert.equal(tasteAuswerten({ key: 'z', metaKey: true, shiftKey: true }), 'vor');
  assert.equal(tasteAuswerten({ key: 'y', ctrlKey: true }), 'vor'); assert.equal(tasteAuswerten({ key: 'Tab', shiftKey: true }), 'einzug_weniger'); assert.equal(tasteAuswerten({ key: 'b' }), null);
  assert.equal(tasteAuswerten({ key: 'Z', ctrlKey: true, shiftKey: true }), 'vor');
  assert.equal(tasteAuswerten({ key: 'z', ctrlKey: true }), 'zurueck');
  assert.equal(tasteAuswerten({ key: 'i', metaKey: true }), 'kursiv'); assert.equal(tasteAuswerten({ key: 'u', ctrlKey: true }), 'unterstrichen');
  assert.equal(tasteAuswerten({ key: 'k', ctrlKey: true }), 'link'); assert.equal(tasteAuswerten({ key: 'Tab' }), 'einzug_mehr');
  assert.equal(tasteAuswerten({ key: 'b', ctrlKey: true, altKey: true }), null, 'AltGr (Strg+Alt) bleibt frei');
  assert.equal(tasteAuswerten({ key: 'Tab', ctrlKey: true }), null);
  assert.equal(tasteAuswerten({ key: 'Enter', metaKey: true }), 'erledigt'); assert.equal(tasteAuswerten({ key: 'Enter' }), null);
});

test('Fett mit Auswahl → Format-Delta; zusammengeklappt → vormerken, nächste Eingabe fett', async () => {
  const s = schein([{ insert: 'abc\n' }]); const { wurzel, behaelter } = await einbinden(s);
  const t0 = wurzel.children[0].firstChild; sel.setze(t0, 0, t0, 2);
  knopf(behaelter, 'fett').click();
  assert.deepEqual(s.ops[0].d, [{ retain: 2, attributes: { fett: true } }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 0, kopf: 2 }, 'Auswahl bleibt');
  assert.equal(knopf(behaelter, 'fett').getAttribute('aria-pressed'), 'true');
  knopf(behaelter, 'fett').click();
  assert.deepEqual(s.ops[1].d, [{ retain: 2, attributes: { fett: null } }]);

  const t1 = wurzel.children[0].firstChild; sel.setze(t1, 3);
  knopf(behaelter, 'fett').click();
  assert.equal(s.ops.length, 2); assert.deepEqual(_test.ed.vorgemerkt, { fett: true });
  assert.equal(knopf(behaelter, 'fett').getAttribute('aria-pressed'), 'true');
  t1.data = 'abcd'; sel.setze(t1, 4);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'd' }));
  assert.deepEqual(s.ops[2].d, [{ retain: 3 }, { insert: 'd', attributes: { fett: true } }]);

  // Tastenkürzel und beforeinput formatItalic wirken gleich
  const t2 = wurzel.children[0].firstChild; sel.setze(t2, 0, t2, 1);
  const k = taste(wurzel, 'i', { ctrlKey: true });
  assert.equal(k.defaultPrevented, true);
  assert.deepEqual(s.ops[3].d, [{ retain: 1, attributes: { kursiv: true } }]);
  const b = eingabe('beforeinput', { inputType: 'formatUnderline' }); wurzel.dispatchEvent(b);
  assert.equal(b.defaultPrevented, true);
  assert.deepEqual(s.ops[4].d, [{ retain: 1, attributes: { unterstrichen: true } }]);

  // Farben aus dem Klappmenü, eigene Farbe, ohne
  knopf(behaelter, 'farbe').click();
  const palette = behaelter.querySelector('.od-palette-farbe');
  assert.equal(palette.hidden, false);
  palette.querySelector('[aria-label="office.dok_farbe_rot"]').click();
  assert.deepEqual(s.ops[5].d, [{ retain: 1, attributes: { farbe: 'rot' } }]);
  assert.equal(palette.hidden, true, 'Menü schließt nach der Wahl');
  const eigen = behaelter.querySelector('.od-palette-farbe input[type="color"]');
  eigen.value = '#123456'; eigen.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops[6].d, [{ retain: 1, attributes: { farbe: '#123456' } }]);
  behaelter.querySelector('.od-palette-hg [aria-label="office.dok_farbe_rosa"]').click();
  assert.deepEqual(s.ops[7].d, [{ retain: 1, attributes: { hintergrund: 'rosa' } }]);
  behaelter.querySelector('.od-palette-hg [aria-label="office.dok_farbe_ohne"]').click();
  assert.deepEqual(s.ops[8].d, [{ retain: 1, attributes: { hintergrund: null } }]);
});

test('Absatzformat, Listen, Ausrichtung, Einzug per Tab nur in Listen', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  const absatz = behaelter.querySelector('.od-leiste select.od-absatz');
  absatz.value = '2'; absatz.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops, [{ d: [{ retain: 2 }, { retain: 1, attributes: { ueberschrift: 2 } }] }]);
  absatz.value = ''; absatz.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops[1].d, [{ retain: 2 }, { retain: 1, attributes: { ueberschrift: null } }]);

  sel.setze(wurzel.children[0].firstChild, 1);
  knopf(behaelter, 'liste_zahlen').click();
  assert.deepEqual(s.daten.delta, [{ insert: 'ab' }, { insert: '\n', attributes: { liste: 'zahlen' } }]);
  assert.equal(knopf(behaelter, 'liste_zahlen').getAttribute('aria-pressed'), 'true');
  knopf(behaelter, 'liste_zahlen').click();
  assert.deepEqual(s.daten.delta, [{ insert: 'ab\n' }], 'zweites Mal schaltet aus');

  // Aufgabe erledigt: Ausschalten nimmt erledigt mit
  const a = schein([{ insert: 'x' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } }]); const b = await einbinden(a);
  sel.setze(b.wurzel.children[0].lastChild, 0);
  knopf(b.behaelter, 'liste_aufgabe').click();
  assert.deepEqual(a.daten.delta, [{ insert: 'x\n' }]);

  // Tab in Liste → Einzug, Umschalt+Tab zurück; außerhalb → Tabulator
  const l = schein([{ insert: 'p' }, { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'q\n' }]); const c = await einbinden(l);
  sel.setze(c.wurzel.children[0].firstChild, 1);
  assert.equal(taste(c.wurzel, 'Tab').defaultPrevented, true);
  assert.deepEqual(l.daten.delta[1], { insert: '\n', attributes: { liste: 'punkte', einzug: 1 } });
  sel.setze(c.wurzel.children[0].firstChild, 1);
  taste(c.wurzel, 'Tab', { shiftKey: true });
  assert.deepEqual(l.daten.delta[1], { insert: '\n', attributes: { liste: 'punkte' } });
  sel.setze(c.wurzel.children[1].firstChild, 1);
  assert.equal(taste(c.wurzel, 'Tab').defaultPrevented, true);
  assert.deepEqual(l.daten.delta.at(-1), { insert: 'q\t\n' });
  assert.equal(taste(c.wurzel, 'Tab', { shiftKey: true }).defaultPrevented, false, 'Umschalt+Tab außerhalb von Listen verlässt den Text');

  // Ausrichtung, Zitat, Einzug-Knöpfe
  sel.setze(c.wurzel.children[1].firstChild, 0);
  knopf(c.behaelter, 'ausrichten_mitte').click();
  assert.deepEqual(l.daten.delta.at(-1), { insert: '\n', attributes: { ausrichtung: 'mitte' } });
  assert.equal(knopf(c.behaelter, 'ausrichten_mitte').getAttribute('aria-pressed'), 'true');
  knopf(c.behaelter, 'ausrichten_links').click();
  assert.deepEqual(l.daten.delta.at(-1), { insert: 'q\t\n' });
  knopf(c.behaelter, 'zitat').click();
  assert.deepEqual(l.daten.delta.at(-1), { insert: '\n', attributes: { zitat: true } });
  knopf(c.behaelter, 'einzug_mehr').click();
  assert.deepEqual(l.daten.delta.at(-1), { insert: '\n', attributes: { zitat: true, einzug: 1 } });
  knopf(c.behaelter, 'einzug_weniger').click();
  assert.deepEqual(l.daten.delta.at(-1), { insert: '\n', attributes: { zitat: true } });
});

test('Link: Eingabe geprüft, leer entfernt den Link', async () => {
  const antworten = ['https://x.de', '', 'https://y.de', null]; const aufrufe = [];
  const eingabeFn = async (o) => {
    aufrufe.push(o);
    assert.equal(o.pruefen('javascript:x'), 'office.dok_link_ungueltig'); assert.equal(o.pruefen(''), null); assert.equal(o.pruefen('mailto:a@b.de'), null);
    assert.equal(o.maxlaenge, 2048);
    return antworten.shift();
  };
  const s = schein([{ insert: 'abc\n' }]); const { wurzel, behaelter } = await einbinden(s, { eingabe: eingabeFn });
  const t0 = wurzel.children[0].firstChild; sel.setze(t0, 0, t0, 3);
  knopf(behaelter, 'link').click(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(s.ops[0].d, [{ retain: 3, attributes: { link: 'https://x.de' } }]);
  assert.equal(aufrufe[0].titel, 'office.dok_link_titel');

  sel.setze(wurzel.querySelector('a').firstChild, 1);
  taste(wurzel, 'k', { ctrlKey: true }); await new Promise((r) => setTimeout(r, 0));
  assert.equal(aufrufe[1].wert, 'https://x.de', 'im Link: bisherige Adresse vorbelegt');
  assert.deepEqual(s.ops[1].d, [{ retain: 3, attributes: { link: null } }]);

  sel.setze(wurzel.children[0].firstChild, 3);
  knopf(behaelter, 'link').click(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(s.ops[2].d, [{ retain: 3 }, { insert: 'https://y.de', attributes: { link: 'https://y.de' } }]);
  knopf(behaelter, 'link').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.ops.length, 3, 'Abbrechen ändert nichts');

  // Strg/⌘+Klick öffnet den Link, ein normaler Klick im Editor nicht
  const offen = []; const vorher = globalThis.open; globalThis.open = (...a) => { offen.push(a); return null; };
  try {
    const a = wurzel.querySelector('a');
    const k1 = new Event('click', { bubbles: true, cancelable: true }); a.dispatchEvent(k1);
    assert.equal(offen.length, 0);
    const k2 = new Event('click', { bubbles: true, cancelable: true }); k2.ctrlKey = true; a.dispatchEvent(k2);
    assert.deepEqual(offen, [['https://y.de', '_blank', 'noopener']]); assert.equal(k2.defaultPrevented, true);
  } finally { globalThis.open = vorher; }
});

test('Rückgängig/Wiederholen per Knopf, Taste und beforeinput historyUndo', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter } = await einbinden(s);
  assert.equal(knopf(behaelter, 'rueckgaengig').disabled, true);
  const t0 = wurzel.children[0].firstChild; t0.data = 'abX'; sel.setze(t0, 3);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'X' }));
  assert.equal(knopf(behaelter, 'rueckgaengig').disabled, false);
  knopf(behaelter, 'rueckgaengig').click();
  assert.deepEqual(s.daten.delta, [{ insert: 'ab\n' }]);
  assert.deepEqual(s.ops.at(-1).d, [{ retain: 2 }, { delete: 1 }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 2, kopf: 2 });
  assert.equal(_test.ed.verlauf.kannZurueck, false, 'die Umkehr kommt nicht in den Verlauf');
  assert.equal(knopf(behaelter, 'wiederholen').disabled, false);
  taste(wurzel, 'z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(s.daten.delta, [{ insert: 'abX\n' }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 3, kopf: 3 });
  const u = eingabe('beforeinput', { inputType: 'historyUndo' }); wurzel.dispatchEvent(u);
  assert.equal(u.defaultPrevented, true);
  assert.deepEqual(s.daten.delta, [{ insert: 'ab\n' }]);
  wurzel.dispatchEvent(eingabe('beforeinput', { inputType: 'historyRedo' }));
  assert.deepEqual(s.daten.delta, [{ insert: 'abX\n' }]);
  taste(wurzel, 'y', { ctrlKey: true });
  assert.equal(s.ops.length, 5, 'nichts mehr zu wiederholen');
});

test('Zustand: aria-pressed folgt formateBei', async () => {
  const s = schein([{ insert: 'a' }, { insert: 'bc', attributes: { fett: true } }, { insert: 'd' }, { insert: '\n', attributes: { ueberschrift: 3, liste: 'punkte' } }]);
  const { wurzel, behaelter } = await einbinden(s);
  sel.setze(wurzel.querySelector('span').firstChild, 1);
  document.dispatchEvent(new Event('selectionchange'));
  assert.equal(knopf(behaelter, 'fett').getAttribute('aria-pressed'), 'true');
  assert.equal(knopf(behaelter, 'kursiv').getAttribute('aria-pressed'), 'false');
  assert.equal(behaelter.querySelector('select.od-absatz').value, '3');
  assert.equal(knopf(behaelter, 'liste_punkte').getAttribute('aria-pressed'), 'true');
  assert.equal(knopf(behaelter, 'ausrichten_links').getAttribute('aria-pressed'), 'true');
  sel.setze(wurzel.children[0].lastChild, 1);
  document.dispatchEvent(new Event('selectionchange'));
  assert.equal(knopf(behaelter, 'fett').getAttribute('aria-pressed'), 'false');
});

test('nur lesen: keine Bearbeiten-Knöpfe, Rechtewechsel baut die Leiste', async () => {
  const s = schein([{ insert: 'a\n' }], 'lesen'); const { behaelter } = await einbinden(s);
  assert.equal(behaelter.querySelectorAll('.od-leiste [data-bearbeiten]').length, 0);
  s.recht = 'bearbeiten'; s.emit('recht', { recht: 'bearbeiten' });
  assert.ok(behaelter.querySelectorAll('.od-leiste [data-bearbeiten]').length > 20);
  for (const b of behaelter.querySelectorAll('.od-leiste button.knopf-symbol')) {
    assert.ok(b.getAttribute('title') && b.getAttribute('title') === b.getAttribute('aria-label'), b.getAttribute('aria-label'));
  }
  s.recht = 'lesen'; s.emit('recht', { recht: 'lesen' });
  assert.equal(behaelter.querySelectorAll('.od-leiste [data-bearbeiten]').length, 0);
});

test('Symbole vorhanden', async () => {
  const svg = await fs.readFile(path.join(PUBLIC, 'symbole.svg'), 'utf8');
  for (const n of ['fett', 'kursiv', 'unterstrichen', 'durchgestrichen', 'code', 'farbe', 'markieren', 'liste-punkte', 'liste-zahlen', 'liste-aufgabe',
    'einzug-mehr', 'einzug-weniger', 'ausrichten-links', 'ausrichten-mitte', 'ausrichten-rechts', 'ausrichten-block', 'zitat', 'seitenumbruch',
    'kommentar', 'rueckgaengig', 'wiederholen', 'drucken']) {
    assert.ok(svg.includes(`id="symbol-${n}"`), n);
  }
});
