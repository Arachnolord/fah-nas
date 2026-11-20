// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Export und Import des Office-Dokuments (Plan 05 Aufgabe 18): Markdown (Formate, Listen, Escapes, Tabellen, Bilder),
// Word-Import mit übersetzten Hinweisen und Fehlern, Bilder verknüpfen, Exportformate des Editors und der Export-Ablauf
// im Rahmen (Druck lädt nichts herunter).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';
import { D, lader } from './office_docx_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let app; let dokument; let editorEinbinden; let markdownSchreiben; let importieren; let verknuepfen; let docxSchreiben; let MIME_DOCX; let exportAusfuehren;
before(async () => {
  dom = domAttrappe();
  app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ editorEinbinden } = await imp('office', 'dokument', 'editor.js'));
  ({ markdownSchreiben } = await imp('office', 'dokument', 'md.js'));
  ({ docxSchreiben, MIME_DOCX } = await imp('office', 'dokument', 'docx.js'));
  ({ exportAusfuehren } = await imp('office', 'rahmen.js'));
  ({ importieren, verknuepfen } = await imp('office', 'dokument', 'import.js'));
});
after(() => dom.aufraeumen());
beforeEach(() => { auswahlAttrappe(); app._test.setzeT((k) => k); });

const TAB_2x2 = Object.freeze({ id: 'tab001', zeilen: ['z00001', 'z00002'], spalten: ['s00001', 's00002'], weg: [],
  zellen: { 'z00001|s00001': [{ insert: 'a' }], 'z00001|s00002': [{ insert: 'b' }], 'z00002|s00001': [{ insert: 'c' }], 'z00002|s00002': [{ insert: 'x|y' }] }, breiten: {} });
const md = (delta) => markdownSchreiben({ delta, kommentare: {} });

test('markdownSchreiben', () => {
  const daten = { delta: [
    { insert: 'Titel' }, { insert: '\n', attributes: { ueberschrift: 1 } },
    { insert: 'a ' }, { insert: 'fett ', attributes: { fett: true } }, { insert: 'und ' }, { insert: 'Link', attributes: { link: 'https://x.de' } }, { insert: ' *Stern* <b>\n' },
    { insert: 'eins' }, { insert: '\n', attributes: { liste: 'zahlen' } }, { insert: 'unter' }, { insert: '\n', attributes: { liste: 'punkte', einzug: 1 } },
    { insert: 'erledigt' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } },
    { insert: 'Zitat' }, { insert: '\n', attributes: { zitat: true } }, { insert: '\n' },
    { insert: { seitenumbruch: true } }, { insert: '\n' }, { insert: { bild: { datei: 'abcdefghijkl-Mein Bild.png', alt: 'Logo' } } }, { insert: '\n' },
    { insert: { tabelle: TAB_2x2 } }, { insert: '\n' }], kommentare: {} };
  assert.equal(markdownSchreiben(daten),
    '# Titel\n\na **fett** und [Link](https://x.de) \\*Stern\\* \\<b\\>\n\n1. eins\n    - unter\n- [x] erledigt\n\n> Zitat\n\n---\n\n![Logo](Mein%20Bild.png)\n\n| a | b |\n| --- | --- |\n| c | x\\|y |\n');
});

test('markdownSchreiben: Randfälle', () => {
  assert.equal(md([{ insert: '\n' }]), '\n', 'leeres Dokument');
  assert.equal(md([{ insert: '# keine Überschrift\n1. kein Punkt\n- kein Strich\n+ plus\n> kein Zitat\n' }]),
    '\\# keine Überschrift\n\n1\\. kein Punkt\n\n\\- kein Strich\n\n\\+ plus\n\n\\> kein Zitat\n');
  assert.equal(md([{ insert: '\tEingerückt  \n' }]), 'Eingerückt\n', 'Leerraum am Zeilenrand fällt weg (sonst Codeblock)');
  assert.equal(md([{ insert: 'a`b', attributes: { code: true } }, { insert: ' und ' }, { insert: 'c_d', attributes: { code: true } }, { insert: '\n' }]), '``a`b`` und `c_d`\n', 'Code ohne Escapes, Zaun nach Inhalt');
  assert.equal(md([{ insert: 'x', attributes: { fett: true } }, { insert: 'y', attributes: { fett: true, kursiv: true } }, { insert: 'z', attributes: { fett: true } }, { insert: '\n' }]), '**x*y*z**\n', 'gemeinsame Marker bleiben offen');
  assert.equal(md([{ insert: 'weg', attributes: { durchgestrichen: true, unterstrichen: true, farbe: 'rot', hintergrund: 'gelb', kommentar: 'kom001' } }, { insert: '\n' }]), '~~weg~~\n');
  assert.equal(md([{ insert: 'a' }, { insert: { bild: { datei: 'abcdefghijkl-b (1).png' } } }, { insert: 'c\n' }]), 'a![](b%20%281%29.png)c\n', 'Bild in der Zeile');
  assert.equal(md([{ insert: 'L', attributes: { link: 'https://x.de/a_(b)' } }, { insert: '\n' }]), '[L](https://x.de/a_%28b%29)\n');
  assert.equal(md([{ insert: 'p' }, { insert: '\n', attributes: { liste: 'zahlen' } }, { insert: 'q' }, { insert: '\n', attributes: { liste: 'zahlen', einzug: 1 } },
    { insert: 'r' }, { insert: '\n', attributes: { liste: 'zahlen', einzug: 1 } }, { insert: 's' }, { insert: '\n', attributes: { liste: 'zahlen' } }, { insert: 'neu\n' },
    { insert: 't' }, { insert: '\n', attributes: { liste: 'zahlen' } }]), '1. p\n    1. q\n    2. r\n2. s\n\nneu\n\n1. t\n', 'Zahlen je Ebene, nach einem Absatz neu');
  assert.equal(md([{ insert: 'H' }, { insert: '\n', attributes: { ueberschrift: 3 } }, { insert: 'o' }, { insert: '\n', attributes: { liste: 'aufgabe' } }, { insert: 'Z' }, { insert: '\n', attributes: { zitat: true, liste: 'punkte' } }]),
    '### H\n\n- [ ] o\n> - Z\n');
  const zelle = { ...TAB_2x2, zellen: { 'z00001|s00001': [{ insert: 'zwei\nZeilen' }], 'z00002|s00002': [{ insert: 'f', attributes: { fett: true } }] } };
  assert.equal(md([{ insert: { tabelle: zelle } }, { insert: '\n' }]), '| zwei Zeilen |  |\n| --- | --- |\n|  | **f** |\n');
});

test('verknuepfen', () => {
  const d = { delta: [{ insert: { bild: { datei: 'bild1', breite: 10 } } }, { insert: { bild: { datei: 'bild2' } } }, { insert: '\n' }], kommentare: {} };
  assert.deepEqual(verknuepfen(d, new Map([['bild1', 'abcdefghijkl-bild1.png']])).delta, [{ insert: { bild: { datei: 'abcdefghijkl-bild1.png', breite: 10 } } }, { insert: '\n' }]);
  const e = { delta: [{ insert: 'a' }, { insert: { bild: { datei: 'bild9' } } }, { insert: 'b\n' }], kommentare: {} };
  assert.deepEqual(verknuepfen(e, new Map()).delta, [{ insert: 'ab\n' }], 'Text um ein weggefallenes Bild verschmilzt');
});

test('importieren: Rundreise ohne fehlte, Fehler übersetzt', async () => {
  app._test.setzeT((k, w) => (w ? `${k}:${w.n}` : k));
  const r = await importieren(await docxSchreiben(D, lader), 'Q3.docx');
  assert.deepEqual(r.fehlte, []);
  assert.equal(r.dateien.length, 1);
  // erst nach dem Verknüpfen tragen Bilder echte Datei-Kennungen – dann ist das Delta gültig
  dokument.pruefen({ d: verknuepfen(r.daten, new Map([[r.dateien[0].schluessel, 'abcdefghijkl-logo.png']])).delta });
  await assert.rejects(importieren(new Blob(['kein zip']), 'x.docx'), (e) => e.message === 'office.dok_import_kaputt');
});

test('Editor: Exportformate, docx/md als Blob, pdf druckt und liefert null; Rahmen lädt bei null nichts', async () => {
  const s = scheinSitzung(dokument, [{ insert: 'Hallo ' }, { insert: 'Welt', attributes: { fett: true } }, { insert: '\n' }]);
  const { editor } = await einbindenIn(editorEinbinden, s, { nutzer: { name: 'anna', anzeigename: 'Anna A.' } });
  assert.deepEqual(editor.exportformate, [{ id: 'docx', titel: 'office.dok_export_docx' }, { id: 'md', titel: 'office.dok_export_md' }, { id: 'pdf', titel: 'office.dok_export_pdf' }]);
  const m = await editor.exportieren('md');
  assert.equal(m.name, 'Bericht.md'); assert.equal(m.blob.type, 'text/markdown;charset=utf-8');
  assert.equal(await m.blob.text(), 'Hallo **Welt**\n');
  const w = await editor.exportieren('docx');
  assert.equal(w.name, 'Bericht.docx'); assert.equal(w.blob.type, MIME_DOCX); assert.ok(w.blob.size > 1000);
  await assert.rejects(editor.exportieren('xyz'), /kein_export/);

  let gedruckt = 0; const vorher = globalThis.print; globalThis.print = () => { gedruckt++; };
  try {
    const geladen = [];
    assert.equal(await exportAusfuehren(editor, 'pdf', (r) => geladen.push(r)), false);
    assert.equal(gedruckt, 1); assert.equal(geladen.length, 0);
    assert.equal(document.body.querySelector('.od-druck').textContent, 'Hallo Welt');
    globalThis.dispatchEvent(new Event('afterprint'));
    assert.equal(await exportAusfuehren(editor, 'md', (r) => geladen.push(r)), true);
    assert.deepEqual(geladen.map((r) => r.name), ['Bericht.md']);
  } finally { globalThis.print = vorher; }
});
