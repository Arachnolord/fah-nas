// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dokument-Editor: Modell und Befehle (Plan 05 Aufgabe 7) – Zeilen aus dem Delta, Formate an einer Stelle/über einen
// Bereich, Einfügeformate (Link/Kommentar nur innen), Listennummern, Zeilen-Diff für IME/Autokorrektur sowie die
// reinen Befehle Enter, Löschen, Formatieren, Einzug, Blöcke, Bilder, Links und Kommentare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const { OBJ, zeilenAus, zeileBei, formateBei, einfuegeFormate, listenNummern, zeilenDiff } = await import(pathToFileURL(path.join(PUBLIC, 'office', 'dokument', 'modell.js')).href);
const B = await import(pathToFileURL(path.join(PUBLIC, 'office', 'dokument', 'befehle.js')).href);
const { anwenden } = await import(pathToFileURL(path.join(PUBLIC, 'gemeinsam', 'sync', 'delta.js')).href);
const { eingabeDelta, loeschenDelta, enterDelta, formatDelta, zeilenFormatDelta, einzugDelta, blockEinfuegenDelta, bildEinfuegenDelta, linkBereich, kommentarBereich, attributEntfernenDelta } = B;

const D = Object.freeze({
  delta: [{ insert: 'Titel' }, { insert: '\n', attributes: { ueberschrift: 1 } }, { insert: 'eins' }, { insert: '\n', attributes: { liste: 'punkte' } },
    { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'ab' }, { insert: 'c', attributes: { fett: true } }, { insert: '\n' }],
  kommentare: {},
});
const A = (aw) => ({ anker: aw, kopf: aw });
const dok = (delta) => ({ delta, kommentare: {} });

test('zeilenAus und formateBei', () => {
  assert.deepEqual(zeilenAus(D.delta).map((z) => [z.start, z.laenge, z.text, z.attribute]), [[0, 6, 'Titel', { ueberschrift: 1 }], [6, 5, 'eins', { liste: 'punkte' }], [11, 1, '', { liste: 'punkte' }], [12, 4, 'abc', {}]]);
  assert.deepEqual(formateBei(D.delta, 12, 3).inline, {}); assert.deepEqual(formateBei(D.delta, 14, 1).inline, { fett: true });
  assert.deepEqual(formateBei(D.delta, 7, 3).zeile, { liste: 'punkte' }); assert.deepEqual(formateBei(D.delta, 7, 6).zeile, {});
  const z = zeilenAus([{ insert: 'a\n' }, { insert: { seitenumbruch: true } }, { insert: '\n' }, { insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'x\n' }]);
  assert.deepEqual(z.map((x) => [x.nr, x.start, x.laenge, x.text, x.block]), [[0, 0, 2, 'a', null], [1, 2, 2, OBJ, 'seitenumbruch'], [2, 4, 3, `${OBJ}x`, null]]);
  assert.equal(zeileBei(z, 3).nr, 1); assert.equal(zeileBei(z, 7).nr, 2, 'hinter dem Ende → letzte Zeile');
  assert.deepEqual(z[2].inhalt, [{ insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'x' }]);
});

test('einfuegeFormate: Link und Kommentar nur innen', () => {
  const L = [{ insert: 'ab', attributes: { link: 'https://x.de', fett: true } }, { insert: '\n' }];
  assert.deepEqual([0, 1, 2].map((i) => einfuegeFormate(L, i)), [{ fett: true }, { link: 'https://x.de', fett: true }, { fett: true }]);
  assert.deepEqual(einfuegeFormate(D.delta, 15), { fett: true });
  assert.deepEqual(einfuegeFormate(D.delta, 11), {}, 'leere Zeile');
  assert.deepEqual(einfuegeFormate([{ insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'x\n', attributes: { fett: true } }], 1), {}, 'hinter einem Embed keine');
});

test('listenNummern', () => {
  const z = [{ liste: 'zahlen' }, { liste: 'zahlen' }, { liste: 'zahlen', einzug: 1 }, { liste: 'zahlen', einzug: 1 }, { liste: 'zahlen', einzug: 2 }, { liste: 'zahlen', einzug: 2 }, { liste: 'zahlen', einzug: 2 }, { liste: 'zahlen', einzug: 2 }, { liste: 'zahlen' }, {}, { liste: 'zahlen' }, { liste: 'punkte' }]
    .map((attribute) => ({ attribute }));
  assert.deepEqual(listenNummern(z), ['1.', '2.', 'a.', 'b.', 'i.', 'ii.', 'iii.', 'iv.', '3.', null, '1.', null]);
  const viele = Array.from({ length: 28 }, () => ({ attribute: { liste: 'zahlen', einzug: 1 } }));
  assert.deepEqual(listenNummern(viele).slice(24), ['y.', 'z.', 'aa.', 'ab.']);
  assert.equal(listenNummern(Array.from({ length: 14 }, () => ({ attribute: { liste: 'zahlen', einzug: 2 } }))).at(-1), 'xiv.');
});

test('zeilenDiff: Cursor entscheidet, Autokorrektur, keine halben Ersatzpaare', () => {
  assert.deepEqual(zeilenDiff('aa', 'aaa', 3), { start: 2, loeschen: 0, einfuegen: 'a' });
  assert.deepEqual(zeilenDiff('aa', 'aaa', 1), { start: 0, loeschen: 0, einfuegen: 'a' });
  assert.deepEqual(zeilenDiff('Hallo welt', 'Hallo Welt', 10), { start: 6, loeschen: 4, einfuegen: 'Welt' });
  assert.deepEqual(zeilenDiff('a😀b', 'a😁b', 3), { start: 1, loeschen: 2, einfuegen: '😁' });
  assert.equal(zeilenDiff('gleich', 'gleich', 6), null);
  assert.deepEqual(zeilenDiff('abc', 'ac'), { start: 1, loeschen: 1, einfuegen: '' });
});

test('enterDelta', () => {
  assert.deepEqual(enterDelta(D, A(5)), [{ retain: 5 }, { insert: '\n', attributes: { ueberschrift: 1 } }, { retain: 1, attributes: { ueberschrift: null } }]);
  assert.deepEqual(enterDelta(D, A(2)), [{ retain: 2 }, { insert: '\n', attributes: { ueberschrift: 1 } }]);
  assert.deepEqual(enterDelta(D, A(11)), [{ retain: 11 }, { retain: 1, attributes: { liste: null } }]);
  assert.deepEqual(enterDelta(D, A(8)), [{ retain: 8 }, { insert: '\n', attributes: { liste: 'punkte' } }]);
  // mit Auswahl: erst löschen (Zeilen zusammen, Attribute der ersten Zeile), dann teilen
  assert.deepEqual(anwenden(D.delta, enterDelta(D, { anker: 8, kopf: 2 })),
    [{ insert: 'Ti' }, { insert: '\n', attributes: { ueberschrift: 1 } }, { insert: 'ns' }, { insert: '\n', attributes: { ueberschrift: 1 } }, { insert: '\n', attributes: { liste: 'punkte' } }, { insert: 'ab' }, { insert: 'c', attributes: { fett: true } }, { insert: '\n' }]);
  const aufgabe = dok([{ insert: 'x' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true, einzug: 2 } }]);
  assert.deepEqual(enterDelta(aufgabe, A(1)), [{ retain: 1 }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true, einzug: 2 } }, { retain: 1, attributes: { erledigt: null } }]);
  const leereAufgabe = dok([{ insert: '\n', attributes: { liste: 'aufgabe', erledigt: true, einzug: 2 } }]);
  assert.deepEqual(enterDelta(leereAufgabe, A(0)), [{ retain: 1, attributes: { liste: null, erledigt: null, einzug: null } }]);
});

test('loeschenDelta', () => {
  assert.deepEqual(loeschenDelta(D, A(6), 'zurueck'), [{ retain: 10 }, { retain: 1, attributes: { liste: null } }]);
  assert.deepEqual(loeschenDelta(D, A(12), 'zurueck'), [{ retain: 11 }, { delete: 1 }, { retain: 3 }, { retain: 1, attributes: { liste: 'punkte' } }]);
  assert.equal(loeschenDelta(D, A(0), 'zurueck'), null); assert.equal(loeschenDelta(D, A(15), 'vor'), null);
  assert.deepEqual(loeschenDelta(D, { anker: 3, kopf: 8 }, 'zurueck'), [{ retain: 3 }, { delete: 5 }, { retain: 2 }, { retain: 1, attributes: { ueberschrift: 1, liste: null } }]);
  // Einzug und Zitat vor dem Zusammenlegen; mitten in der Zeile ein Zeichen, Ersatzpaare ganz
  assert.deepEqual(loeschenDelta(dok([{ insert: 'a\nb' }, { insert: '\n', attributes: { einzug: 2 } }]), A(2), 'zurueck'), [{ retain: 3 }, { retain: 1, attributes: { einzug: 1 } }]);
  assert.deepEqual(loeschenDelta(dok([{ insert: 'a\nb' }, { insert: '\n', attributes: { einzug: 1 } }]), A(2), 'zurueck'), [{ retain: 3 }, { retain: 1, attributes: { einzug: null } }]);
  assert.deepEqual(loeschenDelta(dok([{ insert: 'a\nb' }, { insert: '\n', attributes: { zitat: true } }]), A(2), 'zurueck'), [{ retain: 3 }, { retain: 1, attributes: { zitat: null } }]);
  assert.deepEqual(loeschenDelta(D, A(14), 'zurueck'), [{ retain: 13 }, { delete: 1 }]);
  assert.deepEqual(loeschenDelta(dok([{ insert: 'a😀\n' }]), A(3), 'zurueck'), [{ retain: 1 }, { delete: 2 }]);
  assert.deepEqual(loeschenDelta(dok([{ insert: 'a😀\n' }]), A(1), 'vor'), [{ retain: 1 }, { delete: 2 }]);
  // vor am Zeilenende: Folgezeile anhängen, deren Zeilenende bekommt die Attribute der aktuellen Zeile
  assert.deepEqual(loeschenDelta(D, A(5), 'vor'), [{ retain: 5 }, { delete: 1 }, { retain: 4 }, { retain: 1, attributes: { ueberschrift: 1, liste: null } }]);
  assert.deepEqual(loeschenDelta(D, A(10), 'vor'), [{ retain: 10 }, { delete: 1 }], 'gleiche Attribute: nur löschen');
  // Blöcke werden als Ganzes gelöscht
  const mitBlock = dok([{ insert: 'a\n' }, { insert: { seitenumbruch: true } }, { insert: '\nb\n' }]);
  assert.deepEqual(loeschenDelta(mitBlock, A(4), 'zurueck'), [{ retain: 2 }, { delete: 2 }]);
  assert.deepEqual(loeschenDelta(mitBlock, A(1), 'vor'), [{ retain: 2 }, { delete: 2 }]);
  assert.equal(loeschenDelta(mitBlock, A(2), 'zurueck'), null, 'Block nicht in die Textzeile davor ziehen');
  assert.deepEqual(loeschenDelta(dok([{ insert: '\n' }, { insert: { seitenumbruch: true } }, { insert: '\n' }]), A(1), 'zurueck'), [{ delete: 1 }], 'leere Zeile davor fällt weg');
  // Auswahl bis ans Ende: das letzte \n bleibt
  assert.deepEqual(loeschenDelta(D, { anker: 12, kopf: 16 }, 'zurueck'), [{ retain: 12 }, { delete: 3 }]);
});

test('Formate, Einzug, Blöcke', () => {
  assert.deepEqual(formatDelta(D, { anker: 15, kopf: 12 }, 'fett', true), [{ retain: 12 }, { retain: 3, attributes: { fett: true } }]);
  assert.equal(formatDelta(D, A(3), 'fett', true), null);
  assert.deepEqual(zeilenFormatDelta(D, { anker: 7, kopf: 13 }, 'liste', 'zahlen'), [{ retain: 10 }, { retain: 2, attributes: { liste: 'zahlen' } }, { retain: 3 }, { retain: 1, attributes: { liste: 'zahlen' } }]);
  assert.deepEqual(zeilenFormatDelta(D, A(2), 'ausrichtung', 'links'), [{ retain: 5 }, { retain: 1, attributes: { ausrichtung: null } }], 'Standard wird nicht gespeichert');
  assert.deepEqual(einzugDelta(D, A(7), 1), [{ retain: 10 }, { retain: 1, attributes: { einzug: 1 } }]); assert.equal(einzugDelta(D, A(7), -1), null);
  assert.deepEqual(blockEinfuegenDelta(D, 13, { seitenumbruch: true }), { delta: [{ retain: 13 }, { insert: '\n' }, { insert: { seitenumbruch: true } }, { insert: '\n' }], cursor: 16 });
  assert.deepEqual(blockEinfuegenDelta(D, 12, { seitenumbruch: true }), { delta: [{ retain: 12 }, { insert: { seitenumbruch: true } }, { insert: '\n' }], cursor: 14 });
  assert.deepEqual(blockEinfuegenDelta(D, 2, { seitenumbruch: true }).delta, [{ retain: 2 }, { insert: '\n', attributes: { ueberschrift: 1 } }, { insert: { seitenumbruch: true } }, { insert: '\n' }]);
  // Inline-Formate lassen Zeilenumbrüche und Blöcke aus; Bilder tragen nur Link/Kommentar
  const mitBild = dok([{ insert: 'a' }, { insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'b\nc\n' }]);
  assert.deepEqual(formatDelta(mitBild, { anker: 0, kopf: 5 }, 'fett', true), [{ retain: 1, attributes: { fett: true } }, { retain: 1 }, { retain: 1, attributes: { fett: true } }, { retain: 1 }, { retain: 1, attributes: { fett: true } }]);
  assert.deepEqual(formatDelta(mitBild, { anker: 0, kopf: 5 }, 'link', 'https://a.de'), [{ retain: 3, attributes: { link: 'https://a.de' } }, { retain: 1 }, { retain: 1, attributes: { link: 'https://a.de' } }]);
});

test('Text eingeben, Bild einfügen, Links, Kommentare', () => {
  assert.deepEqual(eingabeDelta(D, A(15), 'd', { fett: true }), [{ retain: 15 }, { insert: 'd', attributes: { fett: true } }]);
  assert.deepEqual(eingabeDelta(D, { anker: 12, kopf: 14 }, 'X', {}), [{ retain: 12 }, { insert: 'X' }, { delete: 2 }]);
  assert.deepEqual(bildEinfuegenDelta(D, { anker: 12, kopf: 14 }, { datei: 'abcdefghijkl-a.png', breite: 200 }), { delta: [{ retain: 12 }, { insert: { bild: { datei: 'abcdefghijkl-a.png', breite: 200 } } }, { delete: 2 }], cursor: 13 });
  const L = dok([{ insert: 'x ' }, { insert: 'link', attributes: { link: 'https://a.de' } }, { insert: ' y\n' }]);
  assert.deepEqual(linkBereich(L, 4), { start: 2, laenge: 4, url: 'https://a.de' });
  assert.deepEqual(linkBereich(L, 6), { start: 2, laenge: 4, url: 'https://a.de' }, 'direkt hinter dem Link');
  assert.equal(linkBereich(L, 0), null);
  const K = dok([{ insert: 'a' }, { insert: 'bc', attributes: { kommentar: 'kom001', fett: true } }, { insert: 'd' }, { insert: 'e', attributes: { kommentar: 'kom001' } }, { insert: '\n' }]);
  assert.deepEqual(kommentarBereich(K, 'kom001'), { start: 1, laenge: 4 });
  assert.equal(kommentarBereich(K, 'kom999'), null);
  assert.deepEqual(attributEntfernenDelta(K, 'kommentar', 'kom001'), [{ retain: 1 }, { retain: 2, attributes: { kommentar: null } }, { retain: 1 }, { retain: 1, attributes: { kommentar: null } }]);
  assert.deepEqual(attributEntfernenDelta(D, 'kommentar', 'kom001'), []);
});
