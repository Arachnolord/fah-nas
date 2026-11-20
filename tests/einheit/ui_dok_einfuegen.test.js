// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einfügen ins Office-Dokument (Plan 05 Aufgabe 10): Fremd-HTML (Word, Google Docs, Webseiten) wird zu einem sauberen
// Delta – Formate, Listen, Aufgaben, Zitate, Code, Tabellen als Embed, nichts Ausführbares; Klartext und das Einfügen an
// der Auswahl; welche Art aus der Zwischenablage genommen wird.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let htmlZuDelta; let textZuDelta; let stilLesen; let einfuegenDelta; let zwischenablageLesen; let dokumentPruefen; let ID_MUSTER;
before(async () => {
  dom = domAttrappe();
  ({ htmlZuDelta, textZuDelta, stilLesen, einfuegenDelta, zwischenablageLesen } = await imp('office', 'dokument', 'einfuegen.js'));
  ({ dokumentPruefen } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ ID_MUSTER } = await imp('gemeinsam', 'sync', 'typen', 'dokument-attribute.js'));
});
after(() => dom.aufraeumen());

/** Baum aus ['tag', {attr}, …kinder] (Kinder: Text oder wieder ein Baum). */
function baue([tag, attr, ...kinder]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr || {})) e.setAttribute(k, v);
  for (const k of kinder) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : baue(k));
  return e;
}

test('Fremd-HTML wird sauber (Review Focus 5)', () => {
  const w = baue(['body', {}, ['b', { style: 'font-weight:normal' },
    ['p', {}, 'Hallo ', ['strong', {}, 'fett'], ['span', { style: 'color:#000000' }, '!']], ['h2', {}, 'Kopf'],
    ['ul', {}, ['li', {}, 'eins', ['ul', {}, ['li', {}, 'zwei']]]],
    ['p', {}, ['a', { href: 'javascript:alert(1)' }, 'böse'], ' ', ['a', { href: 'https://x.de' }, 'gut']],
    ['script', {}, 'alert(1)'], ['img', { src: 'x', onerror: 'alert(1)' }], ['span', { class: 'od-f' }, 'eigen']]]);
  assert.deepEqual(htmlZuDelta(w), [
    { insert: 'Hallo ' }, { insert: 'fett', attributes: { fett: true } }, { insert: '!\nKopf' }, { insert: '\n', attributes: { ueberschrift: 2 } },
    { insert: 'eins' }, { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'zwei' }, { insert: '\n', attributes: { liste: 'punkte', einzug: 1 } },
    { insert: 'böse ' }, { insert: 'gut', attributes: { link: 'https://x.de' } }, { insert: '\n' }, { insert: 'eigen', attributes: { fett: true } }, { insert: '\n' }]);
});

test('Listen, Aufgaben, Code, Zitat, Umbrüche, Leerraum, Ausrichtung', () => {
  const w = baue(['body', {},
    ['ol', {}, ['li', {}, 'erst'], ['li', {}, ['input', { type: 'checkbox', checked: '' }], ' fertig']],
    ['pre', {}, 'x = 1\n  y'],
    ['blockquote', {}, ['p', {}, 'Zitat']],
    ['h5', {}, 'klein'],
    ['p', {}, 'a', ['br', {}], ['br', {}], 'b'],
    ['p', {}],
    ['p', { style: 'text-align: center' }, '  viel \n  Raum  '],
    ['p', { align: 'right' }, 'rechts', ['span', { style: 'display:none' }, 'versteckt']],
    ['template', {}, 'nie'], ['style', {}, 'p{}'], ['iframe', {}, 'nie'],
  ]);
  assert.deepEqual(htmlZuDelta(w), [
    { insert: 'erst' }, { insert: '\n', attributes: { liste: 'zahlen' } },
    { insert: 'fertig' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } },
    { insert: 'x = 1', attributes: { code: true } }, { insert: '\n' }, { insert: '  y', attributes: { code: true } }, { insert: '\nZitat' }, { insert: '\n', attributes: { zitat: true } },
    { insert: 'klein' }, { insert: '\n', attributes: { ueberschrift: 3 } },
    { insert: 'a\n\nb\nviel Raum ' }, { insert: '\n', attributes: { ausrichtung: 'mitte' } },
    { insert: 'rechts' }, { insert: '\n', attributes: { ausrichtung: 'rechts' } }]);
  assert.deepEqual(htmlZuDelta(baue(['body', {}, ['p', {}, '  '], ['script', {}, 'x']])), [], 'nichts Sichtbares → leer');
});

test('eigenes Office-HTML (Kopieren im Office) behält Zeilenformate und Seitenumbruch', () => {
  const w = baue(['body', {},
    ['div', { class: 'od-zeile od-u1' }, 'Titel'],
    ['div', { class: 'od-zeile od-liste od-liste-punkte od-einzug-2 od-ausr-rechts' }, ['span', { class: 'od-k od-farbe-blau od-hg-gruen constructor' }, 'p']],
    ['div', { class: 'od-zeile od-block-zeile' }, ['div', { class: 'od-seitenumbruch od-embed', contenteditable: 'false' }, ['span', {}, 'Seitenumbruch']]],
    ['div', { class: 'od-zeile od-liste od-liste-aufgabe od-erledigt' }, ['span', { class: 'od-haken od-nt', contenteditable: 'false' }], 'erledigt'],
  ]);
  assert.deepEqual(htmlZuDelta(w), [
    { insert: 'Titel' }, { insert: '\n', attributes: { ueberschrift: 1 } },
    { insert: 'p', attributes: { kursiv: true, farbe: 'blau', hintergrund: 'gruen' } }, { insert: '\n', attributes: { liste: 'punkte', einzug: 2, ausrichtung: 'rechts' } },
    { insert: { seitenumbruch: true } }, { insert: '\nerledigt' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } }]);
});

test('stilLesen', () => {
  assert.deepEqual(stilLesen('font-weight:700; color: rgb(180, 35, 24); background-color:#FFF3A3; text-decoration: underline line-through; font-style:italic'),
    { fett: true, farbe: 'rot', hintergrund: 'gelb', unterstrichen: true, durchgestrichen: true, kursiv: true });
  assert.deepEqual(stilLesen('color:#111111; background-color: transparent; font-weight: normal'), {});
  assert.deepEqual(stilLesen('font-weight: bold !important; color: #123456'), { fett: true, farbe: '#123456' });
  // auf weißem Papier unlesbar: helle Schrift, dunkler Hintergrund
  assert.deepEqual(stilLesen('color: #fafafa; background-color: rgb(30, 30, 30)'), {});
  assert.deepEqual(stilLesen('background-color: #ffffff'), {});
});

test('Klartext und Einfügen an der Auswahl', () => {
  assert.deepEqual(textZuDelta('a\r\nb', { liste: 'punkte' }), [{ insert: 'a' }, { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'b' }]);
  assert.deepEqual(textZuDelta('a\u000bb\u0000￼\tc\n', {}), [{ insert: 'a\nb\tc\n' }], 'weicher Umbruch aus Word wird Zeile, Steuerzeichen fallen weg');
  assert.deepEqual(textZuDelta('x', { ueberschrift: 1, fett: true }), [{ insert: 'x' }]);
  const D = { delta: [{ insert: 'xyz\n' }], kommentare: {} };
  assert.deepEqual(einfuegenDelta(D, { anker: 1, kopf: 2 }, [{ insert: 'AB' }]), { delta: [{ retain: 1 }, { insert: 'AB' }, { delete: 1 }], cursor: 3 });
  assert.deepEqual(einfuegenDelta(D, { anker: 4, kopf: 0 }, [{ insert: 'n' }]), { delta: [{ insert: 'n' }, { delete: 3 }], cursor: 1 }, 'das letzte \\n bleibt');
  assert.deepEqual(einfuegenDelta(D, { anker: 2, kopf: 2 }, [{ insert: 'Q', attributes: { fett: true } }]), { delta: [{ retain: 2 }, { insert: 'Q', attributes: { fett: true } }], cursor: 3 });
});

test('Tabelle aus HTML wird Tabellen-Embed in eigener Zeile', () => {
  const w = baue(['body', {}, ['table', {}, ['tbody', {},
    ['tr', {}, ['th', {}, 'Kopf'], ['th', {}, 'B']],
    ['tr', {}, ['td', {}, ['p', {}, 'c'], ['p', {}, 'zwei']], ['td', {}, ['b', {}, 'd'], ['img', { src: 'x' }]]]]]]);
  const d = htmlZuDelta(w);
  assert.equal(d.length, 2); assert.deepEqual(d[1], { insert: '\n' });
  const t = d[0].insert.tabelle;
  assert.deepEqual([t.zeilen.length, t.spalten.length, t.weg, t.breiten], [2, 2, [], {}]);
  for (const id of [t.id, ...t.zeilen, ...t.spalten]) assert.match(id, ID_MUSTER);
  assert.equal(new Set([t.id, ...t.zeilen, ...t.spalten]).size, 5);
  const zelle = (i, j) => t.zellen[`${t.zeilen[i]}|${t.spalten[j]}`];
  assert.deepEqual([zelle(0, 0), zelle(0, 1), zelle(1, 0), zelle(1, 1)], [
    [{ insert: 'Kopf', attributes: { fett: true } }], [{ insert: 'B', attributes: { fett: true } }], [{ insert: 'c\nzwei' }], [{ insert: 'd', attributes: { fett: true } }]]);
  dokumentPruefen({ delta: d, kommentare: {} });

  // davor/danach Text, colspan füllt auf, verschachtelte Tabelle wird Text in der Zelle, leere Zellen fehlen
  const w2 = baue(['body', {}, ['p', {}, 'vor'], ['table', {},
    ['tr', {}, ['td', { colspan: '2' }, 'breit'], ['td', {}, ['table', {}, ['tr', {}, ['td', {}, 'i1'], ['td', {}, 'i2']]]]],
    ['tr', {}, ['td', {}, ''], ['td', {}, 'x']]], 'nach']);
  const d2 = htmlZuDelta(w2);
  assert.deepEqual([d2[0], d2[2]], [{ insert: 'vor\n' }, { insert: '\nnach\n' }]);
  const t2 = d2[1].insert.tabelle;
  assert.deepEqual([t2.zeilen.length, t2.spalten.length, Object.keys(t2.zellen).length], [2, 3, 3]);
  assert.deepEqual(t2.zellen[`${t2.zeilen[0]}|${t2.spalten[2]}`], [{ insert: 'i1\ni2' }]);
  assert.deepEqual(t2.zellen[`${t2.zeilen[1]}|${t2.spalten[1]}`], [{ insert: 'x' }]);
  dokumentPruefen({ delta: d2, kommentare: {} });
  assert.deepEqual(htmlZuDelta(baue(['body', {}, ['table', {}]])), [], 'leere Tabelle → nichts');
});

test('Zwischenablage: HTML mit Inhalt vor Bilddateien, sonst Bilder, sonst Text', () => {
  const vorher = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  const geparst = [];
  globalThis.DOMParser = class {
    parseFromString(html, typ) {
      geparst.push([html.slice(0, 20), typ]);
      if (html.includes('<table')) return { body: baue(['body', {}, ['table', {}, ['tr', {}, ['td', {}]]]]) };
      if (html.includes('Text')) return { body: baue(['body', {}, ['p', {}, 'Text']]) };
      return { body: baue(['body', {}, ['img', { src: 'x' }]]) };
    }
  };
  try {
    const bild = { type: 'image/png', name: 'a.png' }; const pdf = { type: 'application/pdf', name: 'a.pdf' };
    const dt = (daten, files = [], items) => ({ files, items, getData: (t) => daten[t] || '' });
    let r = zwischenablageLesen(dt({ 'text/html': '<p>Text</p>', 'text/plain': 'Text' }, [bild]));
    assert.equal(r.art, 'html'); assert.equal(r.wurzel.textContent, 'Text'); assert.deepEqual(geparst.at(-1), ['<p>Text</p>', 'text/html']);
    r = zwischenablageLesen(dt({ 'text/html': '<table><tr><td>' }, [bild]));
    assert.equal(r.art, 'html', 'Tabelle (etwa aus Excel) statt des Bildes der Zellen');
    assert.deepEqual(zwischenablageLesen(dt({ 'text/html': '<img src="x">', 'text/plain': 'x' }, [pdf, bild])), { art: 'dateien', dateien: [bild] });
    assert.deepEqual(zwischenablageLesen(dt({}, [], [{ kind: 'string' }, { kind: 'file', getAsFile: () => bild }])), { art: 'dateien', dateien: [bild] });
    const n = geparst.length;
    assert.deepEqual(zwischenablageLesen(dt({ 'text/html': `<p>${'x'.repeat(2_097_152)}</p>`, 'text/plain': 'kurz' })), { art: 'text', text: 'kurz' });
    assert.equal(geparst.length, n, 'zu großes HTML wird nicht geparst');
    assert.equal(zwischenablageLesen(dt({})), null);
    assert.equal(zwischenablageLesen(dt({}, [pdf])), null);
    assert.equal(zwischenablageLesen(null), null);
  } finally {
    if (vorher) Object.defineProperty(globalThis, 'DOMParser', vorher); else delete globalThis.DOMParser;
  }
});

test('Prüfbericht I-8: Listen aus Word (mso-list) werden Listen, Aufzählungszeichen fallen weg', () => {
  const marke = (zeichen) => ['span', { style: 'font-family:Symbol' }, ['span', { style: 'mso-list:Ignore' }, zeichen, ['span', { style: 'font:7.0pt "Times New Roman"' }, '    ']]];
  const w = baue(['body', {},
    ['p', { class: 'MsoListParagraphCxSpFirst', style: 'text-indent:-18.0pt;mso-list:l0 level1 lfo1' }, marke('·'), 'Eins'],
    ['p', { class: 'MsoListParagraphCxSpMiddle', style: 'margin-left:72.0pt;mso-list:l0 level2 lfo1' }, marke('o'), 'Unter'],
    ['p', { class: 'MsoListParagraphCxSpLast', style: 'text-indent:-18.0pt;mso-list:l1 level1 lfo2' }, marke('1.'), 'Zwei'],
    ['p', { class: 'MsoNormal' }, 'Normal'],
  ]);
  assert.deepEqual(htmlZuDelta(w), [
    { insert: 'Eins' }, { insert: '\n', attributes: { liste: 'punkte' } },
    { insert: 'Unter' }, { insert: '\n', attributes: { liste: 'punkte', einzug: 1 } },
    { insert: 'Zwei' }, { insert: '\n', attributes: { liste: 'zahlen' } },
    { insert: 'Normal\n' }]);
});
