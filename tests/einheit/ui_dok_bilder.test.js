// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bilder, Seitenumbruch und Drucken im Dokument (Plan 05 Aufgabe 14): Breite begrenzen, Hochladen nur von Bildtypen,
// Bild aus dem NAS, Breite per Griff, Seitenumbruch-Knopf, Druckkopie mit Aufräumen.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, AttrappeNode } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let dokument; let editorEinbinden; let _test; let sel; let bildBreite; let BILD_MIME; let drucken;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ editorEinbinden, _test } = await imp('office', 'dokument', 'editor.js'));
  ({ bildBreite, BILD_MIME } = await imp('office', 'dokument', 'bilder.js'));
  ({ drucken } = await imp('office', 'dokument', 'druck.js'));
});
after(() => dom.aufraeumen());
beforeEach(() => { sel = auswahlAttrappe(); });

const warten = () => new Promise((r) => setTimeout(r, 0));
const knopf = (b, name) => b.querySelector(`.od-leiste [aria-label="office.dok_${name}"]`);
function schein(delta, extra = {}) {
  const s = scheinSitzung(dokument, delta);
  s.hochgeladen = [];
  s.dateiHochladen = async (f) => { s.hochgeladen.push(f); if (f.kaputt) throw new Error('E_HOCHLADEN'); return { datei: `abcdefghijkl-${f.name}`, name: f.name }; };
  s.dateiAusNas = async () => s.nasAntwort ?? null;
  return Object.assign(s, extra);
}
const einbinden = (s) => einbindenIn(editorEinbinden, s);

test('bildBreite', () => {
  assert.deepEqual([bildBreite(300, 50, 642), bildBreite(300, -400, 642), bildBreite(600, 100, 642)], [350, 16, 642]);
  assert.equal(bildBreite(1900, 500, 5000), 2000, 'höchstens 2000');
  assert.equal(bildBreite(100, 10.6, 642), 111, 'gerundet');
  assert.deepEqual(BILD_MIME, ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
});

test('Hochladen: nur Bildtypen, Embed mit alt = Dateiname', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter, meldungen, fehler } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  await _test.ed.bilderEinfuegen([{ name: 'Foto 1.jpg', type: 'image/jpeg', size: 5 }], 1);
  assert.deepEqual(s.ops.at(-1).d, [{ retain: 1 }, { insert: { bild: { datei: 'abcdefghijkl-Foto 1.jpg', alt: 'Foto 1.jpg' } } }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 2, kopf: 2 });

  const n = s.ops.length;
  await _test.ed.bilderEinfuegen([{ name: 'a.pdf', type: 'application/pdf', size: 5 }], 0);
  assert.equal(s.ops.length, n); assert.deepEqual(meldungen.at(-1).slice(0, 2), ['office.dok_bild_typ', 'warnung']);
  await _test.ed.bilderEinfuegen([{ name: 'k.png', type: 'image/png', size: 5, kaputt: true }], 0);
  assert.equal(s.ops.length, n); assert.equal(fehler.length, 1);

  // mehrere nacheinander an der Cursorstelle, über das Klappmenü und das versteckte Dateifeld
  knopf(behaelter, 'bild').click();
  const menue = behaelter.querySelector('.od-bild-menue');
  assert.equal(menue.hidden, false);
  const feld = behaelter.querySelector('input[type="file"]');
  assert.equal(feld.getAttribute('accept'), 'image/png,image/jpeg,image/gif,image/webp');
  assert.equal(feld.hasAttribute('multiple'), true);
  let geklickt = 0; feld.addEventListener('click', () => { geklickt++; });
  menue.querySelector('[aria-label="office.dok_bild_hochladen"]').click();
  assert.equal(geklickt, 1); assert.equal(menue.hidden, true);
  sel.setze(wurzel.children[0].firstChild, 1);
  feld.files = [{ name: 'x.png', type: 'image/png', size: 1 }, { name: 'y.gif', type: 'image/gif', size: 1 }];
  feld.dispatchEvent(new Event('change', { bubbles: true }));
  await warten(); await warten();
  const bilder = s.daten.delta.filter((op) => op.insert.bild).map((op) => op.insert.bild.alt);
  assert.deepEqual(bilder, ['x.png', 'y.gif', 'Foto 1.jpg']);
});

test('Aus dem NAS; Abbruch → nichts', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 2);
  s.nasAntwort = { datei: 'abcdefghijkl-b.png', name: 'b.png' };
  knopf(behaelter, 'bild').click();
  behaelter.querySelector('.od-bild-menue [aria-label="office.dok_bild_nas"]').click();
  await warten();
  assert.deepEqual(s.ops.at(-1).d, [{ retain: 2 }, { insert: { bild: { datei: 'abcdefghijkl-b.png', alt: 'b.png' } } }]);
  s.nasAntwort = null; const n = s.ops.length;
  knopf(behaelter, 'bild').click();
  behaelter.querySelector('.od-bild-menue [aria-label="office.dok_bild_nas"]').click();
  await warten();
  assert.equal(s.ops.length, n);
});

test('Breite ziehen → retain {bild:{breite}}', async () => {
  const s = schein([{ insert: 'ab' }, { insert: { bild: { datei: 'abcdefghijkl-a.png', breite: 300 } } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  const griff = wurzel.querySelector('.od-bild-griff');
  const ev = (art, x) => Object.assign(new Event(art, { bubbles: true, cancelable: true }), { clientX: x, pointerId: 7 });
  griff.dispatchEvent(ev('pointerdown', 100));
  griff.dispatchEvent(ev('pointermove', 150));
  assert.equal(wurzel.querySelector('img.od-bild').style.width, '350px', 'live');
  griff.dispatchEvent(ev('pointerup', 150));
  assert.deepEqual(s.ops.at(-1).d, [{ retain: 2 }, { retain: { bild: { breite: 350 } } }]);
  // ohne Bewegung keine Op
  const n = s.ops.length;
  const g2 = wurzel.querySelector('.od-bild-griff');
  g2.dispatchEvent(ev('pointerdown', 10)); g2.dispatchEvent(ev('pointerup', 10));
  assert.equal(s.ops.length, n);
});

test('Seitenumbruch-Knopf fügt einen Block ein', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  knopf(behaelter, 'seitenumbruch').click();
  assert.deepEqual(s.daten.delta, [{ insert: 'a\n' }, { insert: { seitenumbruch: true } }, { insert: '\nb\n' }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 4, kopf: 4 });
});

test('Bild, das nicht lädt, zeigt den Ersatztext', async () => {
  const s = schein([{ insert: { bild: { datei: 'abcdefghijkl-weg.png' } } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  const img = wurzel.querySelector('img.od-bild');
  img.dispatchEvent(new Event('error'));
  assert.equal(img.getAttribute('alt'), 'office.dok_bild_fehlt');
  assert.ok(img.classList.contains('od-bild-fehlt'));
});

test('drucken: Kopie, Klasse, print, Aufräumen nach afterprint', () => {
  const q = document.createElement('div'); q.setAttribute('contenteditable', 'true'); q.appendChild(document.createTextNode('Text'));
  const zelle = document.createElement('td'); zelle.setAttribute('contenteditable', 'true'); q.appendChild(zelle);
  let gedruckt = 0;
  const fenster = Object.assign(new AttrappeNode(), { print: () => { gedruckt++; } });
  drucken(q, { fenster });
  const kopie = document.body.querySelector('.od-druck');
  assert.equal(kopie.textContent, 'Text'); assert.equal(document.documentElement.classList.contains('od-drucken'), true); assert.equal(gedruckt, 1);
  assert.equal(kopie.querySelectorAll('[contenteditable]').length, 0, 'nichts bearbeitbar in der Kopie');
  assert.equal(q.getAttribute('contenteditable'), 'true', 'das Original bleibt');
  fenster.dispatchEvent(new Event('afterprint'));
  assert.equal(document.body.querySelector('.od-druck'), null); assert.equal(document.documentElement.classList.contains('od-drucken'), false);
  // ohne afterprint räumt spätestens der nächste Fokus auf
  drucken(q, { fenster });
  fenster.dispatchEvent(new Event('focus'));
  assert.equal(document.body.querySelector('.od-druck'), null);
});

test('Strg+P: beforeprint legt die Druckkopie des Textes an, afterprint und Verlassen räumen auf', async () => {
  for (const k of [...document.body.children]) k.remove(); // Editoren der anderen Tests sind nicht mehr eingehängt
  const s = schein([{ insert: 'Brief\n' }]); const { editor } = await einbinden(s);
  globalThis.dispatchEvent(new Event('beforeprint'));
  assert.equal(document.body.querySelector('.od-druck').textContent, 'Brief');
  globalThis.dispatchEvent(new Event('afterprint'));
  assert.equal(document.body.querySelector('.od-druck'), null);
  globalThis.dispatchEvent(new Event('beforeprint'));
  editor.verlassen();
  assert.equal(document.body.querySelector('.od-druck'), null);
  assert.equal(document.documentElement.classList.contains('od-drucken'), false);
  globalThis.dispatchEvent(new Event('beforeprint'));
  assert.equal(document.body.querySelector('.od-druck'), null, 'nach dem Verlassen kein Hörer mehr');
});

test('Prüfbericht I-2: eigenes Tippen während des Hochladens verschiebt die Einfügestelle', async () => {
  let freigeben;
  const s = schein([{ insert: 'abc\n' }], { dateiHochladen: (f) => new Promise((r) => { freigeben = () => r({ datei: `abcdefghijkl-${f.name}`, name: f.name }); }) });
  const { wurzel } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 2);
  const fertig = _test.ed.bilderEinfuegen([{ name: 'x.png', type: 'image/png', size: 1 }], 2);
  _test.ed.aendern({ d: [{ insert: 'ZZ' }] }); // eigene Eingabe weiter vorn, während das Bild noch hochlädt
  freigeben(); await fertig;
  assert.deepEqual(s.daten.delta, [{ insert: 'ZZab' }, { insert: { bild: { datei: 'abcdefghijkl-x.png', alt: 'x.png' } } }, { insert: 'c\n' }]);
});
