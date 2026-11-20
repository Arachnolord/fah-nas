// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tabellen im Dokument (Plan 05 Aufgabe 13): neue Tabelle und Befehle mit Grabsteinen, Zellinhalt per Diff mit Formaten,
// Tippen in Zellen (300 ms, beim Verlassen sofort, fokussierte Zelle bleibt bei fremden Änderungen stehen), Leiste
// „Tabelle“ mit Grenzen, Spaltenbreite per Griff, Nur-lesen.

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let dokument; let editorEinbinden; let _test; let sel;
let neueTabelle; let zelleNeu; let tabellenBefehl; let zellTextDom;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ editorEinbinden, _test } = await imp('office', 'dokument', 'editor.js'));
  ({ neueTabelle, zelleNeu, tabellenBefehl, zellTextDom } = await imp('office', 'dokument', 'tabelle.js'));
});
after(() => dom.aufraeumen());
beforeEach(() => { sel = auswahlAttrappe(); });

const schein = (delta, recht) => scheinSitzung(dokument, delta, recht);
const einbinden = (s) => einbindenIn(editorEinbinden, s);
const folge = (v) => { let n = 0; return () => `${v.repeat(5)}${++n}`; };
const W0 = Object.freeze({ id: 'tab001', zeilen: ['z00001', 'z00002'], spalten: ['s00001', 's00002'], weg: [], zellen: {}, breiten: {} });
const zelle = (w, z, s) => [...w.querySelectorAll('td.od-zelle')].find((td) => td.dataset.zeile === z && td.dataset.spalte === s);
const knopf = (b, name) => b.querySelector(`.od-leiste [aria-label="office.dok_${name}"]`);
const tabWert = (s) => s.daten.delta.find((op) => op.insert && op.insert.tabelle)?.insert.tabelle;

test('neueTabelle und Befehle mit Grabsteinen', () => {
  const w = neueTabelle(2, 2, folge('a')); // folge liefert 'aaaaa1', 'aaaaa2', …
  assert.deepEqual([w.zeilen.length, w.spalten.length, w.weg, w.zellen, w.breiten], [2, 2, [], {}, {}]);
  assert.equal(new Set([w.id, ...w.zeilen, ...w.spalten]).size, 5);
  const w2 = { ...w, zeilen: [w.zeilen[0], 'grab01', w.zeilen[1]], weg: ['grab01'] };
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[1], spalte: w.spalten[0] }, 'zeile_davor', () => 'neu001'), [{ typ: 'zeile_einfuegen', nach: 'grab01', id: 'neu001' }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[0] }, 'zeile_loeschen'), [{ typ: 'zeile_loeschen', id: w.zeilen[0] }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[0] }, 'zeile_davor', () => 'neu002'), [{ typ: 'zeile_einfuegen', nach: null, id: 'neu002' }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[1] }, 'spalte_danach', () => 'neu003'), [{ typ: 'spalte_einfuegen', nach: w.spalten[1], id: 'neu003' }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[1] }, 'spalte_davor', () => 'neu004'), [{ typ: 'spalte_einfuegen', nach: w.spalten[0], id: 'neu004' }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[1] }, 'spalte_loeschen'), [{ typ: 'spalte_loeschen', id: w.spalten[1] }]);
  assert.deepEqual(tabellenBefehl(w2, { zeile: w.zeilen[0], spalte: w.spalten[1] }, 'quatsch'), []);
});

test('zelleNeu behält Formate', () => {
  const w = { ...W0, zellen: { 'z00001|s00001': [{ insert: 'ab', attributes: { fett: true } }] } };
  assert.deepEqual(zelleNeu(w, 'z00001', 's00001', 'abc', 3), [{ insert: 'abc', attributes: { fett: true } }]);
  assert.equal(zelleNeu(w, 'z00001', 's00001', 'ab', 2), null);
  assert.deepEqual(zelleNeu(w, 'z00001', 's00001', '', 0), [], 'leer gelöscht');
  assert.deepEqual(zelleNeu(W0, 'z00002', 's00002', 'x\ny\n', 4), [{ insert: 'x\ny' }], 'kein Zeilenumbruch am Ende');
  assert.equal(zelleNeu(W0, 'z00002', 's00002', '\n', 1), null, 'nur ein Umbruch am Ende ändert nichts');
  // Text aus der Zelle: br und Absätze als Zeilenumbruch, der Platzhalter-br am Ende zählt nicht
  const td = document.createElement('td');
  td.append('a', document.createElement('br'), 'b', document.createElement('br'));
  assert.equal(zellTextDom(td), 'a\nb');
  const td2 = document.createElement('td'); const d = document.createElement('div'); d.append('zwei');
  td2.append('eins', d);
  assert.equal(zellTextDom(td2), 'eins\nzwei');
});

test('Tippen in einer Zelle sendet nach 300 ms eine zelle-Op, beim Verlassen sofort', async () => {
  const s = schein([{ insert: 'vor\n' }, { insert: { tabelle: W0 } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const td = zelle(wurzel, 'z00001', 's00001');
    assert.equal(td.getAttribute('contenteditable'), 'true');
    td.focus(); td.textContent = 'neu'; sel.setze(td.firstChild, 3);
    td.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'u' }));
    mock.timers.tick(299);
    assert.equal(s.ops.length, 0, 'noch nichts gesendet, und kein Text-Diff des Haupteditors');
    mock.timers.tick(1);
    assert.deepEqual(s.ops.at(-1).d, [{ retain: 4 }, { retain: { tabelle: [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'neu' }] }] } }]);
    assert.equal(zelle(wurzel, 'z00001', 's00001'), td); assert.equal(td.textContent, 'neu');

    td.textContent = 'neuer'; sel.setze(td.firstChild, 5);
    td.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'r' }));
    // fremde Änderung an einer anderen Zelle, während hier noch nicht gesendet ist: diese Zelle bleibt stehen
    s.fremd({ d: [{ retain: 4 }, { retain: { tabelle: [{ typ: 'zelle', zeile: 'z00002', spalte: 's00002', inhalt: [{ insert: 'B' }] }] } }] });
    assert.equal(zelle(wurzel, 'z00001', 's00001'), td); assert.equal(td.textContent, 'neuer');
    assert.equal(zelle(wurzel, 'z00002', 's00002').textContent, 'B');
    td.dispatchEvent(new Event('focusout', { bubbles: true }));
    assert.deepEqual(s.ops.at(-1).d[1].retain.tabelle[0].inhalt, [{ insert: 'neuer' }]);
    const n = s.ops.length;
    mock.timers.tick(500);
    assert.equal(s.ops.length, n, 'der Zeitgeber ist erledigt');
    assert.deepEqual(tabWert(s).zellen, { 'z00001|s00001': [{ insert: 'neuer' }], 'z00002|s00002': [{ insert: 'B' }] });

    // Strg+B in der Zelle formatiert die Auswahl im Zell-Delta
    td.focus(); sel.setze(td.firstChild, 0, td.firstChild, 3);
    const k = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', ctrlKey: true }); td.dispatchEvent(k);
    assert.equal(k.defaultPrevented, true);
    assert.deepEqual(tabWert(s).zellen['z00001|s00001'], [{ insert: 'neu', attributes: { fett: true } }, { insert: 'er' }]);
    assert.equal(zelle(wurzel, 'z00001', 's00001').querySelector('span.od-f').textContent, 'neu');
  } finally { mock.timers.reset(); }
});

test('Werkzeugleiste: Tabelle einfügen (3×3), Zeile darunter, Spalte löschen; Grenzen 200/50 sperren die Knöpfe', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel, behaelter } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  knopf(behaelter, 'tabelle').click();
  const w = tabWert(s);
  assert.deepEqual([w.zeilen.length, w.spalten.length], [3, 3]);
  assert.deepEqual(s.daten.delta.map((op) => (op.insert.tabelle ? 'T' : op.insert)), ['a\n', 'T', '\nb\n']);
  const erste = zelle(wurzel, w.zeilen[0], w.spalten[0]);
  assert.equal(document.activeElement, erste, 'Fokus in der ersten Zelle');
  erste.dispatchEvent(new Event('focusin', { bubbles: true }));
  const gruppe = behaelter.querySelector('.od-tabellen-gruppe');
  assert.equal(gruppe.hidden, false);
  knopf(behaelter, 'zeile_danach').click();
  assert.equal(tabWert(s).zeilen.length, 4); assert.equal(tabWert(s).zeilen[1], tabWert(s).zeilen.find((z) => !w.zeilen.includes(z)));
  zelle(wurzel, w.zeilen[0], w.spalten[0]).focus();
  knopf(behaelter, 'spalte_loeschen').click();
  assert.deepEqual(tabWert(s).weg, [w.spalten[0]]);
  assert.equal(wurzel.querySelectorAll('tbody tr')[0].children.length, 2);
  // Fokus verlässt die Zellen → Gruppe weg
  wurzel.children[0].dispatchEvent(new Event('focusin', { bubbles: true })); document.activeElement = wurzel;
  wurzel.dispatchEvent(new Event('focusout', { bubbles: true }));
  assert.equal(behaelter.querySelector('.od-tabellen-gruppe').hidden, true);

  // Grenzen: 200 Zeilen bzw. 50 Spalten
  const viele = { id: 'tab002', zeilen: Array.from({ length: 200 }, (_, i) => `z${String(i).padStart(5, '0')}`), spalten: Array.from({ length: 50 }, (_, i) => `s${String(i).padStart(5, '0')}`), weg: [], zellen: {}, breiten: {} };
  const g = schein([{ insert: { tabelle: viele } }, { insert: '\n' }]); const b = await einbinden(g);
  const td = zelle(b.wurzel, 'z00000', 's00000'); td.focus(); td.dispatchEvent(new Event('focusin', { bubbles: true }));
  for (const n of ['zeile_davor', 'zeile_danach', 'spalte_davor', 'spalte_danach']) {
    const k = knopf(b.behaelter, n);
    assert.equal(k.disabled, true, n); assert.equal(k.getAttribute('title'), 'office.dok_tabelle_grenze');
  }
  assert.equal(knopf(b.behaelter, 'zeile_loeschen').disabled, false);

  // die letzte sichtbare Spalte löschen nimmt die ganze Tabelle weg
  const e = schein([{ insert: 'x\n' }, { insert: { tabelle: { ...W0, spalten: ['s00001'] } } }, { insert: '\n' }]); const c = await einbinden(e);
  const z1 = zelle(c.wurzel, 'z00001', 's00001'); z1.focus(); z1.dispatchEvent(new Event('focusin', { bubbles: true }));
  knopf(c.behaelter, 'spalte_loeschen').click();
  assert.deepEqual(e.daten.delta, [{ insert: 'x\n' }]);
});

test('Spaltenbreite per Griff', async () => {
  const s = schein([{ insert: { tabelle: W0 } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  const griff = wurzel.querySelectorAll('.od-spaltengriff')[1];
  assert.ok(griff);
  griff.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), { clientX: 100, pointerId: 1 }));
  griff.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { clientX: 150, pointerId: 1 }));
  griff.dispatchEvent(Object.assign(new Event('pointerup', { bubbles: true }), { clientX: 150, pointerId: 1 }));
  assert.deepEqual(s.ops.at(-1).d, [{ retain: { tabelle: [{ typ: 'breite', spalte: 's00002', px: 150 }] } }]);
  assert.deepEqual(tabWert(s).breiten, { s00002: 150 });
  griff.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), { clientX: 0, pointerId: 2 }));
  griff.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { clientX: -500, pointerId: 2 }));
  griff.dispatchEvent(Object.assign(new Event('pointerup', { bubbles: true }), { clientX: -500, pointerId: 2 }));
  assert.equal(tabWert(s).breiten.s00002, 40, 'Mindestbreite');
});

test('Leser: Zellen nicht bearbeitbar', async () => {
  const s = schein([{ insert: { tabelle: { ...W0, zellen: { 'z00001|s00001': [{ insert: 'A' }] } } } }, { insert: '\n' }], 'lesen');
  const { wurzel, behaelter } = await einbinden(s);
  for (const td of wurzel.querySelectorAll('td.od-zelle')) assert.equal(td.getAttribute('contenteditable'), 'false');
  assert.equal(wurzel.querySelectorAll('.od-spaltengriff').length, 0);
  assert.equal(behaelter.querySelector('.od-tabellen-gruppe'), null);
  s.recht = 'bearbeiten'; s.emit('recht', { recht: 'bearbeiten' });
  assert.equal(zelle(wurzel, 'z00001', 's00001').getAttribute('contenteditable'), 'true');
  assert.equal(zelle(wurzel, 'z00001', 's00001').textContent, 'A');
});

test('Prüfbericht I-3: zelleNeu übernimmt bei Ersetzung die Formate des ersetzten Texts', () => {
  const w = { ...W0, zellen: { 'z00001|s00001': [{ insert: 'a ' }, { insert: 'welt', attributes: { kursiv: true } }] } };
  assert.deepEqual(zelleNeu(w, 'z00001', 's00001', 'a Welt', 6), [{ insert: 'a ' }, { insert: 'Welt', attributes: { kursiv: true } }]);
});

test('Prüfbericht I-1: fokussierte Zelle bleibt bei fremden Änderungen über und in der Tabelle', async () => {
  const W3 = { id: 'tab001', zeilen: ['z00001', 'z00002', 'z00003'], spalten: ['s00001', 's00002'], weg: [], zellen: {}, breiten: {} };
  const s = schein([{ insert: 'vor\n' }, { insert: { tabelle: W3 } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const td = zelle(wurzel, 'z00003', 's00002'); const tr = td.parentNode; const tbody = tr.parentNode;
    let bewegt = 0; const einfuegen = tbody.insertBefore.bind(tbody);
    tbody.insertBefore = (k, ref) => { if (k === tr) bewegt++; return einfuegen(k, ref); };
    td.focus(); td.textContent = 'neu'; sel.setze(td.firstChild, 3);
    td.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'u' }));
    s.fremd({ d: [{ retain: 1 }, { insert: '\n' }] }); // ben drückt über der Tabelle Enter
    assert.ok(zelle(wurzel, 'z00003', 's00002') === td, 'dieselbe Zelle nach Enter darüber'); assert.equal(td.isConnected, true); assert.equal(td.textContent, 'neu');
    s.fremd({ d: [{ retain: 5 }, { retain: { tabelle: [{ typ: 'zeile_loeschen', id: 'z00001' }] } }] }); // ben löscht eine Zeile darüber
    assert.ok(zelle(wurzel, 'z00003', 's00002') === td, 'dieselbe Zelle nach Löschen darüber'); assert.equal(td.isConnected, true); assert.equal(td.textContent, 'neu');
    assert.equal(bewegt, 0, 'die Tabellenzeile der Zelle wird nie umgehängt');
    assert.equal(wurzel.querySelectorAll('tbody tr').length, 2);
    mock.timers.tick(300);
    assert.deepEqual(s.ops.at(-1).d, [{ retain: 5 }, { retain: { tabelle: [{ typ: 'zelle', zeile: 'z00003', spalte: 's00002', inhalt: [{ insert: 'neu' }] }] } }]);
  } finally { mock.timers.reset(); }
});
