// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Darstellung des Office-Dokuments (Plan 05 Aufgabe 9): Zeilen mit Formaten, Listen, Aufgaben, Embeds; Abbildung
// DOM-Stelle ↔ Index; Neuzeichnen nur geänderter Zeilen; Farbpalette lesbar auf Papierweiß und vollständig im CSS.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const OFFICE_CSS = path.join(PUBLIC, 'ansichten', 'office.css');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let zeilenAus; let OBJ; let FARBEN; let HINTERGRUENDE;
let zeileRendern; let dokumentRendern; let textAusDom; let domZuIndex; let indexZuDom; let tabelleRendern;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ zeilenAus, OBJ } = await imp('office', 'dokument', 'modell.js'));
  ({ FARBEN, HINTERGRUENDE } = await imp('gemeinsam', 'sync', 'typen', 'dokument-attribute.js'));
  ({ zeileRendern, dokumentRendern, textAusDom, domZuIndex, indexZuDom, tabelleRendern } = await imp('office', 'dokument', 'darstellung.js'));
});
after(() => dom.aufraeumen());

// WCAG 2.1, gleiche Formel wie ui_fixes.test.js
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
function kontrast(vorne, hinten) {
  const l1 = leuchtdichte(hexZuRgb(vorne)); const l2 = leuchtdichte(hexZuRgb(hinten));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const OPT = { dateiUrl: (d) => `/d/${d}` };

test('Zeile mit Formaten, Link, eigener Farbe und Kommentar', () => {
  const z = zeilenAus([{ insert: 'a' }, { insert: 'b', attributes: { fett: true, farbe: 'rot' } }, { insert: 'c', attributes: { link: 'https://x.de' } },
    { insert: 'd', attributes: { farbe: '#123456', kommentar: 'kom001' } }, { insert: '\n', attributes: { ueberschrift: 2 } }])[0];
  const e = zeileRendern(z, OPT);
  assert.equal(e.className, 'od-zeile od-u2');
  const [b, d] = e.querySelectorAll('span');
  assert.deepEqual([b.className, b.textContent, d.className, d.style.color, d.dataset.kommentar], ['od-f od-farbe-rot', 'b', 'od-kommentiert', '#123456', 'kom001']);
  const a = e.querySelector('a');
  assert.deepEqual([a.className, a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')], ['od-link', 'https://x.de', 'noopener noreferrer', '_blank']);
  assert.equal(e.firstChild.nodeType, 3, 'Lauf ohne Format ist ein reiner Textknoten');
  assert.equal(textAusDom(e), 'abcd');

  const alle = zeilenAus([{ insert: 'x', attributes: { fett: true, kursiv: true, unterstrichen: true, durchgestrichen: true, code: true, farbe: 'blau', hintergrund: 'gelb', kommentar: 'kom002' } },
    { insert: 'y', attributes: { hintergrund: '#abcdef', link: 'mailto:a@b.de', kursiv: true } }, { insert: '\n' }])[0];
  const f = zeileRendern(alle, OPT);
  assert.equal(f.querySelector('span').className, 'od-f od-k od-u od-s od-code od-farbe-blau od-hg-gelb od-kommentiert');
  const l = f.querySelector('a');
  assert.deepEqual([l.className, l.style.backgroundColor], ['od-link od-k', '#abcdef']);

  // nur erlaubte Links werden zu Links (falls ein Fremdformat durchrutscht)
  const boese = zeileRendern(zeilenAus([{ insert: 'x', attributes: { link: 'javascript:alert(1)' } }, { insert: '\n' }])[0], OPT);
  assert.equal(boese.querySelector('a'), null); assert.equal(textAusDom(boese), 'x');
});

test('Liste, Aufgabe, leere Zeile, Bild, Seitenumbruch, Tabelle', () => {
  const zeilen = zeilenAus([
    { insert: 'eins' }, { insert: '\n', attributes: { liste: 'zahlen' } },
    { insert: 'punkt' }, { insert: '\n', attributes: { liste: 'punkte', einzug: 1 } },
    { insert: 'tun' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } },
    { insert: '\n' },
    { insert: { bild: { datei: 'abcdefghijkl-a.png', breite: 300, alt: 'Logo' } } }, { insert: '\n', attributes: { ausrichtung: 'mitte', zitat: true } },
    { insert: 'tief' }, { insert: '\n', attributes: { liste: 'punkte', einzug: 3 } },
    { insert: '\n', attributes: { liste: 'aufgabe' } },
  ]);
  const l = zeileRendern(zeilen[0], { ...OPT, nummer: '1.' });
  assert.equal(l.className, 'od-zeile od-liste od-liste-zahlen'); assert.equal(l.dataset.marke, '1.');
  const p = zeileRendern(zeilen[1], OPT);
  assert.equal(p.className, 'od-zeile od-liste od-liste-punkte od-einzug-1'); assert.equal(p.dataset.marke, '◦');
  assert.equal(zeileRendern(zeilen[5], OPT).dataset.marke, '•', 'Punkte zyklisch je Ebene');
  const a = zeileRendern(zeilen[2], OPT);
  assert.equal(a.className, 'od-zeile od-liste od-liste-aufgabe od-erledigt');
  const h = a.querySelector('.od-haken');
  assert.equal(a.firstChild, h);
  assert.deepEqual([h.className, h.getAttribute('contenteditable'), h.getAttribute('role'), h.getAttribute('aria-checked')], ['od-haken od-nt', 'false', 'checkbox', 'true']);
  assert.equal(textAusDom(a), 'tun');
  assert.equal(zeileRendern(zeilen[6], OPT).querySelector('.od-haken').getAttribute('aria-checked'), 'false');
  const leer = zeileRendern(zeilen[3], OPT);
  assert.equal(leer.className, 'od-zeile'); assert.equal(leer.lastChild.localName, 'br'); assert.equal(textAusDom(leer), '');
  const leereAufgabe = zeileRendern(zeilen[6], OPT);
  assert.deepEqual(leereAufgabe.childNodes.map((k) => k.localName), ['span', 'br']); assert.equal(textAusDom(leereAufgabe), '');

  const b = zeileRendern(zeilen[4], OPT);
  assert.equal(b.className, 'od-zeile od-ausr-mitte od-zitat');
  assert.equal(textAusDom(b), OBJ);
  const rahmen = b.querySelector('.od-bild-rahmen');
  assert.deepEqual([rahmen.className, rahmen.getAttribute('contenteditable')], ['od-bild-rahmen od-embed', 'false']);
  const img = rahmen.querySelector('img');
  assert.deepEqual([img.className, img.getAttribute('src'), img.getAttribute('alt'), img.getAttribute('draggable'), img.style.width],
    ['od-bild', '/d/abcdefghijkl-a.png', 'Logo', 'false', '300px']);
  assert.ok(rahmen.querySelector('.od-bild-griff'));
  assert.equal(zeileRendern(zeilen[4], { ...OPT, nurLesen: true }).querySelector('.od-bild-griff'), null, 'Griff nur bearbeitbar');

  const bloecke = zeilenAus([{ insert: { seitenumbruch: true } }, { insert: '\n' }]);
  const s = zeileRendern(bloecke[0], OPT);
  assert.equal(s.className, 'od-zeile od-block-zeile');
  const su = s.firstChild;
  assert.deepEqual([su.className, su.getAttribute('contenteditable'), su.textContent], ['od-seitenumbruch od-embed', 'false', 'office.dok_seitenumbruch']);
  assert.equal(textAusDom(s), OBJ);

  const tab = { id: 'tab001', zeilen: ['z00001', 'z00002', 'z00003'], spalten: ['s00001', 's00002'], weg: ['z00002'],
    zellen: { 'z00001|s00001': [{ insert: 'A1' }], 'z00002|s00001': [{ insert: 'weg' }], 'z00003|s00002': [{ insert: 'C2', attributes: { fett: true } }] }, breiten: { s00001: 120 } };
  const t = tabelleRendern(tab, { nurLesen: true });
  assert.deepEqual([t.className, t.getAttribute('contenteditable'), t.firstChild.className], ['od-tabelle-rahmen od-embed', 'false', 'od-tabelle']);
  const zeilenEl = t.querySelectorAll('tr');
  assert.deepEqual(zeilenEl.map((tr) => tr.querySelectorAll('td').map((td) => td.textContent)), [['A1', ''], ['', 'C2']], 'gelöschte Zeile fehlt');
  assert.equal(zeilenEl[1].querySelectorAll('td')[1].querySelector('span').className, 'od-f');
  assert.deepEqual(t.querySelectorAll('col').map((c) => c.style.width || ''), ['120px', '']);
  const tz = zeileRendern(zeilenAus([{ insert: { tabelle: tab } }, { insert: '\n' }])[0], OPT);
  assert.equal(tz.className, 'od-zeile od-block-zeile'); assert.ok(tz.querySelector('table.od-tabelle')); assert.equal(textAusDom(tz), OBJ);
});

test('domZuIndex / indexZuDom', () => {
  const delta = [{ insert: 'ab' }, { insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: 'c\nzwei\n' }];
  const zeilen = zeilenAus(delta); const w = document.createElement('div'); dokumentRendern(w, zeilen, { dateiUrl: (d) => d });
  const [z1, z2] = w.children; const tc = z1.childNodes[2]; const tz = z2.childNodes[0];
  assert.deepEqual([domZuIndex(w, zeilen, tc, 1), domZuIndex(w, zeilen, tz, 2), domZuIndex(w, zeilen, w, 1)], [4, 7, 5]);
  assert.deepEqual(indexZuDom(w, zeilen, 3), { knoten: tc, offset: 0 }); assert.deepEqual(indexZuDom(w, zeilen, 9), { knoten: tz, offset: 4 });
  // Gleichstand Textende/Embed: das Textende gewinnt; Knoten im Embed → Index des Embeds; Wurzel-Ende → Dokumentende
  assert.deepEqual(indexZuDom(w, zeilen, 2), { knoten: z1.childNodes[0], offset: 2 });
  assert.equal(domZuIndex(w, zeilen, z1.querySelector('img'), 0), 2);
  assert.equal(domZuIndex(w, zeilen, z1, 2), 3);
  assert.equal(domZuIndex(w, zeilen, w, 2), 9);
  assert.equal(domZuIndex(w, zeilen, document.createTextNode('x'), 0), null);

  // Zeile nur mit Bild, leere Zeile, leere Aufgabe
  const d2 = [{ insert: { bild: { datei: 'abcdefghijkl-a.png' } } }, { insert: '\n\n' }, { insert: '\n', attributes: { liste: 'aufgabe' } }];
  const zl = zeilenAus(d2); const w2 = document.createElement('div'); dokumentRendern(w2, zl, { dateiUrl: (d) => d });
  const [b, l, a] = w2.children;
  assert.deepEqual(indexZuDom(w2, zl, 0), { knoten: b, offset: 0 });
  assert.deepEqual(indexZuDom(w2, zl, 1), { knoten: b, offset: 1 });
  assert.deepEqual(indexZuDom(w2, zl, 2), { knoten: l, offset: 0 });
  assert.deepEqual(indexZuDom(w2, zl, 3), { knoten: a, offset: 1 });
  assert.equal(domZuIndex(w2, zl, a, 1), 3);
  assert.equal(domZuIndex(w2, zl, b, 1), 1);
});

test('dokumentRendern behält unveränderte Zeilen', () => {
  const w = document.createElement('div');
  dokumentRendern(w, zeilenAus([{ insert: 'eins\nzwei\ndrei\n' }]), OPT);
  const [e0, e1, e2] = w.children;
  w.appendChild(document.createTextNode('Streuner'));
  dokumentRendern(w, zeilenAus([{ insert: 'eins\nzwo\ndrei\n' }]), OPT);
  assert.equal(w.children[0], e0); assert.notEqual(w.children[1], e1); assert.equal(w.children[2], e2);
  assert.equal(w.children[1].textContent, 'zwo');
  assert.equal(w.childNodes.length, 3, 'Fremdknoten in der Wurzel fallen weg');
  dokumentRendern(w, zeilenAus([{ insert: 'eins\n' }]), OPT);
  assert.deepEqual([w.children.length, w.children[0]], [1, e0], 'überzählige Zeilen weg');

  // Nummer und nur-lesen gehören zum Schlüssel
  const liste = [{ insert: 'a' }, { insert: '\n', attributes: { liste: 'zahlen' } }, { insert: 'b' }, { insert: '\n', attributes: { liste: 'zahlen' } }];
  const w2 = document.createElement('div');
  dokumentRendern(w2, zeilenAus(liste), OPT);
  assert.deepEqual(w2.children.map((e) => e.dataset.marke), ['1.', '2.']);
  const b0 = w2.children[1];
  dokumentRendern(w2, zeilenAus([{ insert: 'b' }, { insert: '\n', attributes: { liste: 'zahlen' } }]), OPT);
  assert.equal(w2.children[0].dataset.marke, '1.');
  dokumentRendern(w2, zeilenAus(liste), OPT);
  const b1 = w2.children[1];
  assert.notEqual(b1, b0);
  dokumentRendern(w2, zeilenAus(liste), { ...OPT, nurLesen: true });
  assert.notEqual(w2.children[1], b1);

  // behalten: das Element bleibt, auch wenn sich seine Zeile geändert hat (Komposition)
  const w3 = document.createElement('div');
  dokumentRendern(w3, zeilenAus([{ insert: 'a\nb\n' }]), OPT);
  const k = w3.children[1]; k.firstChild.data = 'bX';
  dokumentRendern(w3, zeilenAus([{ insert: 'Aa\nbY\n' }]), { ...OPT, behalten: new Set([k]) });
  assert.equal(w3.children[1], k); assert.equal(k.textContent, 'bX'); assert.equal(w3.children[0].textContent, 'Aa');

  // behalten als Map Element → Zeilennummer: neue Zeilen davor rücken das Element an seinen Platz, ohne es zu bewegen
  const w4 = document.createElement('div');
  dokumentRendern(w4, zeilenAus([{ insert: 'eins\nzwei\ndrei\n' }]), OPT);
  const [, z2, z3] = w4.children; z2.firstChild.data = 'zweiX';
  dokumentRendern(w4, zeilenAus([{ insert: 'neu\nalt\neins\nzwei\ndrei\n' }]), { ...OPT, behalten: new Map([[z2, 3]]) });
  assert.deepEqual(w4.children.map((e) => e.textContent), ['neu', 'alt', 'eins', 'zweiX', 'drei']);
  assert.equal(w4.children[3], z2); assert.equal(w4.children[4], z3, 'unveränderte Zeile dahinter bleibt');
  dokumentRendern(w4, zeilenAus([{ insert: 'zwei\n' }]), { ...OPT, behalten: new Map([[z2, 0]]) });
  assert.deepEqual([w4.children.length, w4.children[0]], [1, z2], 'überzählige Zeilen davor und dahinter weg');
});

test('Palette: Kontrast ≥ 4,5:1 auf Papier, Regeln stehen in office.css', async () => {
  const css = await fs.readFile(OFFICE_CSS, 'utf8');
  for (const [n, hex] of Object.entries(FARBEN)) { assert.ok(kontrast(hex, '#ffffff') >= 4.5, n); assert.ok(css.includes(`.od-farbe-${n} { color: ${hex}; }`), n); }
  for (const [n, hex] of Object.entries(HINTERGRUENDE)) { assert.ok(kontrast('#1c1c1c', hex) >= 4.5, n); assert.ok(css.includes(`.od-hg-${n} { background-color: ${hex}; }`), n); }
  for (const s of ['.od-seite {', '.od-text {', '.od-liste::before', '.od-einzug-8 {', '.od-tabelle td {', '.od-seitenumbruch {']) assert.ok(css.includes(s), s);
});

test('Prüfbericht I-6: eine neue oder gelöschte Zeile zeichnet nicht alles danach neu', () => {
  const w = document.createElement('div');
  const text = `${Array.from({ length: 300 }, (_, i) => `z${i}`).join('\n')}\n`;
  dokumentRendern(w, zeilenAus([{ insert: text }]), OPT);
  const vorher = [...w.children];
  dokumentRendern(w, zeilenAus([{ insert: `z0\nneu\n${text.slice(3)}` }]), OPT);
  assert.equal(w.children.length, 301);
  const bleiben = vorher.filter((e) => e.parentNode === w).length;
  assert.ok(bleiben >= 300, `nur ${bleiben} von 300 Zeilen blieben`);
  assert.equal(w.children[1].textContent, 'neu');
  dokumentRendern(w, zeilenAus([{ insert: `z0\nneu\n${text.slice(3)}`.replace('z150\n', '') }]), OPT); // eine Zeile gelöscht
  assert.equal(w.children.length, 300);
  assert.ok(vorher.filter((e) => e.parentNode === w).length >= 299);
});
