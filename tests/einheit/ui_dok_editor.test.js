// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dokument-Editor, Kern (Plan 05 Aufgabe 11): Tippen wird über den Zeilen-Diff zum Delta, Enter/Löschen an Zeilengrenzen
// und zeilenübergreifende Eingaben laufen übers Modell, IME-Komposition übersteht fremde Änderungen (Review Focus 1),
// die eigene Auswahl bleibt bei fremden Änderungen stehen, ein DOM, der nicht mehr zum Modell passt, wird ohne Op neu
// aufgebaut, Einfügen aus der Zwischenablage, nur lesen.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let dokument; let editorEinbinden; let _test; let sel;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ editorEinbinden, _test } = await imp('office', 'dokument', 'editor.js'));
});
after(() => dom.aufraeumen());

beforeEach(() => { sel = auswahlAttrappe(); });
const schein = (delta, recht) => scheinSitzung(dokument, delta, recht);
const einbinden = (s) => einbindenIn(editorEinbinden, s);

const eingabe = (art, init = {}) => new InputEvent(art, { bubbles: true, cancelable: art === 'beforeinput', ...init });

test('Aufbau: Leiste, Seite mit Text und Cursor-Ebene, Rand; Export folgt später', async () => {
  const s = schein([{ insert: 'a\n' }]); const { behaelter, editor } = await einbinden(s);
  const e = behaelter.querySelector('.od-editor');
  assert.ok(e.querySelector('.od-leiste[role="toolbar"]'));
  const text = e.querySelector('.od-flaeche > .od-seite > .od-text');
  assert.deepEqual([text.getAttribute('contenteditable'), text.getAttribute('spellcheck'), text.getAttribute('role'), text.getAttribute('aria-multiline')], ['true', 'true', 'textbox', 'true']);
  assert.equal(e.querySelector('.od-seite > .od-cursor-ebene').getAttribute('aria-hidden'), 'true');
  assert.ok(e.querySelector('.od-flaeche > aside.od-rand'));
  assert.deepEqual(editor.exportformate.map((f) => f.id), ['docx', 'md', 'pdf'], 'Exportformate (Aufgabe 18)');
  await assert.rejects(editor.exportieren('xyz'), /kein_export/);
  assert.equal(_test.ed.wurzel, text);
  editor.verlassen();
  assert.equal(behaelter.querySelector('.od-editor'), null);
});

test('Tippen in einer Zeile → ein Delta mit den Formaten davor', async () => {
  const s = schein([{ insert: 'a' }, { insert: 'b', attributes: { fett: true } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  const span = wurzel.querySelector('span'); span.firstChild.data = 'bc'; sel.setze(span.firstChild, 2);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'c' }));
  assert.deepEqual(s.ops, [{ d: [{ retain: 2 }, { insert: 'c', attributes: { fett: true } }] }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 3, kopf: 3 });
  // vorgemerkte Formate gelten für die nächste Eingabe, null nimmt ein Format weg
  _test.ed.vormerken('fett', null); _test.ed.vormerken('kursiv', true);
  const t = wurzel.querySelector('span').firstChild; t.data = 'bcd'; sel.setze(t, 3);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'd' }));
  assert.deepEqual(s.ops.at(-1), { d: [{ retain: 3 }, { insert: 'd', attributes: { kursiv: true } }] });
  assert.deepEqual(_test.ed.vorgemerkt, {});
  assert.equal(_test.ed.verlauf.kannZurueck, true, 'eigene Änderungen kommen in den Verlauf');
});

test('insertParagraph und Backspace am Zeilenanfang laufen übers Modell', async () => {
  const s = schein([{ insert: 'ab\n' }]); const { wurzel } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  const enter = eingabe('beforeinput', { inputType: 'insertParagraph' });
  wurzel.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(s.ops[0].d, [{ retain: 1 }, { insert: '\n' }]);
  assert.equal(wurzel.querySelectorAll('.od-zeile').length, 2);
  assert.deepEqual(_test.ed.auswahl(), { anker: 2, kopf: 2 });

  const l = schein([{ insert: 'x' }, { insert: '\n', attributes: { liste: 'punkte' } }]); const b = await einbinden(l);
  sel.setze(b.wurzel.children[0].lastChild, 0);
  const rueck = eingabe('beforeinput', { inputType: 'deleteContentBackward' });
  b.wurzel.dispatchEvent(rueck);
  assert.equal(rueck.defaultPrevented, true);
  assert.deepEqual(l.daten.delta, [{ insert: 'x\n' }], 'Liste entfernt');
  // mitten in der Zeile übernimmt der Browser (input-Weg)
  sel.setze(b.wurzel.children[0].firstChild, 1);
  const innen = eingabe('beforeinput', { inputType: 'deleteContentBackward' });
  b.wurzel.dispatchEvent(innen);
  assert.equal(innen.defaultPrevented, false);

  const m = schein([{ insert: 'ab\ncd\n' }]); const c = await einbinden(m);
  sel.setze(c.wurzel.children[0].firstChild, 1, c.wurzel.children[1].firstChild, 1);
  const x = eingabe('beforeinput', { inputType: 'insertText', data: 'x' });
  c.wurzel.dispatchEvent(x);
  assert.equal(x.defaultPrevented, true);
  assert.equal(m.ops.length, 1, 'ein Delta');
  assert.deepEqual(m.daten.delta, [{ insert: 'axd\n' }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 2, kopf: 2 });

  // Löschen über Zeilengrenzen (Entf) und Ausschneiden
  const n = schein([{ insert: 'ab\ncd\n' }]); const d = await einbinden(n);
  sel.setze(d.wurzel.children[0].firstChild, 2);
  d.wurzel.dispatchEvent(eingabe('beforeinput', { inputType: 'deleteContentForward' }));
  assert.deepEqual(n.daten.delta, [{ insert: 'abcd\n' }]);
  sel.setze(d.wurzel.children[0].firstChild, 1, d.wurzel.children[0].firstChild, 3);
  d.wurzel.dispatchEvent(eingabe('beforeinput', { inputType: 'deleteByCut' }));
  assert.deepEqual(n.daten.delta, [{ insert: 'ad\n' }]);
  for (const art of ['insertFromPaste', 'insertFromDrop', 'deleteByDrag', 'formatBold', 'historyUndo']) {
    const ev = eingabe('beforeinput', { inputType: art }); d.wurzel.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, art);
  }
  // historyUndo nimmt (seit Aufgabe 12) zurück – Entf und Ausschneiden lagen innerhalb von 500 ms, also ein Schritt;
  // formatBold ohne Auswahl merkt nur vor
  assert.equal(n.ops.length, 3);
  assert.deepEqual(n.daten.delta, [{ insert: 'ab\ncd\n' }]);
});

test('Komposition mit fremder Änderung (Review Focus 1)', async () => {
  const s = schein([{ insert: 'eins\nzwei\n' }]); const { wurzel } = await einbinden(s);
  const z2 = wurzel.children[1]; sel.setze(z2.firstChild, 4);
  wurzel.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  z2.firstChild.data = 'zweiX'; sel.setze(z2.firstChild, 5);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertCompositionText', data: 'X', isComposing: true }));
  assert.equal(s.ops.length, 0, 'während der Komposition keine Op');
  s.fremd({ d: [{ insert: 'A' }] });
  assert.equal(wurzel.children[1], z2); assert.equal(wurzel.children[0].textContent, 'Aeins');
  wurzel.dispatchEvent(new Event('compositionend', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { d: [{ retain: 10 }, { insert: 'X' }] }); assert.equal(s.daten.delta[0].insert, 'Aeins\nzweiX\n');
  assert.deepEqual(_test.ed.auswahl(), { anker: 11, kopf: 11 });

  // fremde neue Zeilen oberhalb: die Kompositionszeile bleibt dasselbe Element an der richtigen Stelle
  const t = schein([{ insert: 'eins\nzwei\n' }]); const b = await einbinden(t);
  const k = b.wurzel.children[1]; sel.setze(k.firstChild, 4);
  b.wurzel.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  k.firstChild.data = 'zweiY'; sel.setze(k.firstChild, 5);
  t.fremd({ d: [{ insert: 'neu\n' }] });
  assert.deepEqual(b.wurzel.children.map((e) => e.textContent), ['neu', 'eins', 'zweiY']);
  assert.equal(b.wurzel.children[2], k);
  b.wurzel.dispatchEvent(new Event('compositionend', { bubbles: true }));
  assert.deepEqual(t.ops.at(-1), { d: [{ retain: 13 }, { insert: 'Y' }] });
  assert.equal(t.daten.delta[0].insert, 'neu\neins\nzweiY\n');
  assert.deepEqual(b.wurzel.children.map((e) => e.textContent), ['neu', 'eins', 'zweiY']);
});

test('fremde Änderung erhält die eigene Auswahl und verschiebt den Verlauf', async () => {
  const s = schein([{ insert: 'abcd\n' }]); const { wurzel } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 3);
  s.fremd({ d: [{ insert: 'XY' }] });
  assert.equal(wurzel.children[0].textContent, 'XYabcd');
  assert.deepEqual(_test.ed.auswahl(), { anker: 5, kopf: 5 });
  // eigene Eingabe, dann fremde Einfügung davor → Rückgängig trifft nur das Eigene
  const t = wurzel.children[0].firstChild; t.data = 'XYabcQd'; sel.setze(t, 6);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'Q' }));
  s.fremd({ d: [{ insert: 'Z' }] });
  assert.deepEqual(_test.ed.verlauf.rueckgaengig(s.daten.delta), [{ retain: 6 }, { delete: 1 }]);
});

test('DOM passt nicht mehr zum Modell → Neuaufbau ohne Op', async () => {
  const s = schein([{ insert: 'eins\nzwei\ndrei\n' }]); const { wurzel, meldungen } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 2);
  wurzel.children[1].remove();
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'x' }));
  assert.equal(s.ops.length, 0);
  assert.deepEqual(wurzel.children.map((e) => e.textContent), ['eins', 'zwei', 'drei']);
  assert.deepEqual(meldungen.at(-1).slice(0, 2), ['office.dok_eingabe_verworfen', 'warnung']);
  // Auswahl außerhalb jeder Zeile (z. B. in der Wurzel selbst) zählt genauso
  sel.setze(document.body, 0);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertText', data: 'x' }));
  assert.equal(s.ops.length, 0);
});

test('Einfügen: Klartext übernimmt Listenformat, HTML-Absatz landet in der Zeile', async () => {
  const s = schein([{ insert: 'ab' }, { insert: '\n', attributes: { liste: 'punkte' } }]); const { wurzel } = await einbinden(s);
  sel.setze(wurzel.children[0].firstChild, 1);
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { files: [], getData: (t) => (t === 'text/plain' ? 'x\ny' : '') };
  wurzel.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(s.daten.delta, [{ insert: 'ax' }, { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'yb' }, { insert: '\n', attributes: { liste: 'punkte' } }]);
  assert.deepEqual(_test.ed.auswahl(), { anker: 4, kopf: 4 });

  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString() {
      const body = document.createElement('body'); const p = document.createElement('p'); const b = document.createElement('b');
      b.appendChild(document.createTextNode('F')); p.appendChild(b); body.appendChild(p); return { body };
    }
  };
  try {
    const h = schein([{ insert: 'ab\n' }]); const c = await einbinden(h);
    sel.setze(c.wurzel.children[0].firstChild, 1);
    const ev2 = new Event('paste', { bubbles: true, cancelable: true });
    ev2.clipboardData = { files: [], getData: (t) => (t === 'text/html' ? '<p><b>F</b></p>' : 'F') };
    c.wurzel.dispatchEvent(ev2);
    assert.deepEqual(h.daten.delta, [{ insert: 'a' }, { insert: 'F', attributes: { fett: true } }, { insert: 'b\n' }]);
  } finally {
    if (vorher) Object.defineProperty(globalThis, 'DOMParser', vorher); else delete globalThis.DOMParser;
  }
});

test('Auswahl: selectionchange meldet, sendet und leert Vorgemerktes', async () => {
  const s = schein([{ insert: 'abc\n' }]); const { wurzel } = await einbinden(s);
  const gesehen = [];
  _test.ed.on('auswahl', (aw) => gesehen.push(aw));
  _test.ed.vormerken('fett', true);
  sel.setze(wurzel.children[0].firstChild, 2);
  document.dispatchEvent(new Event('selectionchange'));
  assert.deepEqual(gesehen, [{ anker: 2, kopf: 2 }]);
  assert.deepEqual(s.gesendet, [{ anker: 2, kopf: 2 }]);
  assert.deepEqual(_test.ed.vorgemerkt, {});
});

test('nur lesen: kein contenteditable, recht-Wechsel schaltet um', async () => {
  const s = schein([{ insert: 'abc\n' }], 'lesen'); const { behaelter, wurzel } = await einbinden(s);
  assert.equal(wurzel.getAttribute('contenteditable'), 'false');
  assert.ok(behaelter.querySelector('.od-editor').classList.contains('od-nur-lesen'));
  assert.equal(behaelter.querySelectorAll('.od-leiste [data-bearbeiten]').length, 0);
  assert.equal(behaelter.querySelector('.od-nur-lesen-marke').hidden, false);
  s.recht = 'bearbeiten'; s.emit('recht', { recht: 'bearbeiten' });
  assert.equal(wurzel.getAttribute('contenteditable'), 'true');
  assert.equal(behaelter.querySelector('.od-editor').classList.contains('od-nur-lesen'), false);
  assert.equal(behaelter.querySelector('.od-nur-lesen-marke').hidden, true);
});

test('Prüfbericht I-3: Autokorrektur behält Format, Link und Kommentar des ersetzten Worts', async () => {
  const s = schein([{ insert: 'Hallo ' }, { insert: 'welt', attributes: { fett: true, kommentar: 'kom001' } }, { insert: '\n' }]); const { wurzel } = await einbinden(s);
  const span = wurzel.querySelector('span'); span.firstChild.data = 'Welt'; sel.setze(span.firstChild, 4);
  wurzel.dispatchEvent(eingabe('input', { inputType: 'insertReplacementText', data: 'Welt' }));
  assert.deepEqual(s.ops.at(-1).d, [{ retain: 6 }, { insert: 'Welt', attributes: { fett: true, kommentar: 'kom001' } }, { delete: 4 }]);
  assert.deepEqual(s.daten.delta, [{ insert: 'Hallo ' }, { insert: 'Welt', attributes: { fett: true, kommentar: 'kom001' } }, { insert: '\n' }]);
});

test('Prüfbericht I-7: Aufgaben-Häkchen per Klick und Strg/⌘+Enter abhaken, nicht beim Lesen', async () => {
  const s = schein([{ insert: 'tun' }, { insert: '\n', attributes: { liste: 'aufgabe' } }]); const { wurzel } = await einbinden(s);
  wurzel.querySelector('.od-haken').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(s.daten.delta, [{ insert: 'tun' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } }]);
  assert.equal(wurzel.querySelector('.od-haken').getAttribute('aria-checked'), 'true');
  sel.setze(wurzel.children[0].lastChild, 1);
  const k = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }); wurzel.dispatchEvent(k);
  assert.equal(k.defaultPrevented, true);
  assert.deepEqual(s.daten.delta, [{ insert: 'tun' }, { insert: '\n', attributes: { liste: 'aufgabe' } }]);
  const l = schein([{ insert: 'x' }, { insert: '\n', attributes: { liste: 'aufgabe' } }], 'lesen'); const b = await einbinden(l);
  b.wurzel.querySelector('.od-haken').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  assert.equal(l.ops.length, 0);
});

test('Prüfbericht I-2: eigene Op während der Komposition verschiebt das Getippte richtig', async () => {
  const s = schein([{ insert: 'eins\nzwei\n' }]); const { wurzel } = await einbinden(s);
  const z2 = wurzel.children[1]; sel.setze(z2.firstChild, 4);
  wurzel.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  z2.firstChild.data = 'zweiX'; sel.setze(z2.firstChild, 5);
  _test.ed.aendern({ d: [{ insert: { bild: { datei: 'abcdefghijkl-a.png' } } }] }); // z. B. ein fertiger Upload
  assert.equal(wurzel.children[1], z2);
  wurzel.dispatchEvent(new Event('compositionend', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { d: [{ retain: 10 }, { insert: 'X' }] });
  assert.deepEqual(s.daten.delta, [{ insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'eins\nzweiX\n' }]);
});
