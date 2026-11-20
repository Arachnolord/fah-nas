// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kommentare am Rand und fremde Cursor (Plan 05 Aufgabe 15): Anlegen als ein Op (Markierung + Kommentar), Antworten,
// Erledigen, Löschen nur für Autor oder Besitzer, Liste nach Stelle, Karte ↔ markierter Text, Handy-Knopf, Cursor
// anderer mit Name und Farbe, die beim Gehen verschwinden.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { auswahlAttrappe, schein as scheinSitzung, einbinden as einbindenIn } from './dok_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let dokument; let editorEinbinden; let _test; let sel; let ID_MUSTER; let kommentarListe; let cursorZeichnen;
before(async () => {
  dom = domAttrappe();
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ dokument } = await imp('gemeinsam', 'sync', 'typen', 'dokument.js'));
  ({ ID_MUSTER } = await imp('gemeinsam', 'sync', 'typen', 'dokument-attribute.js'));
  ({ editorEinbinden, _test } = await imp('office', 'dokument', 'editor.js'));
  ({ kommentarListe } = await imp('office', 'dokument', 'kommentare.js'));
  ({ cursorZeichnen } = await imp('office', 'dokument', 'cursor.js'));
});
after(() => dom.aufraeumen());
beforeEach(() => { sel = auswahlAttrappe(); });

const warten = () => new Promise((r) => setTimeout(r, 5));
const knopf = (b, name) => b.querySelector(`.od-leiste [aria-label="office.dok_${name}"]`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const K_BEN = Object.freeze({ wer: 'ben', name: 'Ben', zeit: '2026-10-18T10:00:00.000Z', text: 'Hm', erledigt: false, antworten: [] });

/** ctx mit Dialog-Attrappe (hängt den Inhalt an body, schliessen ruft beimSchliessen) und Bestätigung. */
function ctxMit(nutzer = { name: 'anna', anzeigename: 'Anna A.' }) {
  const dialoge = [];
  return {
    dialoge,
    nutzer,
    bestaetigen: async () => true,
    dialog(inhalt, optionen = {}) {
      const wurzel = document.createElement('div'); wurzel.className = 'test-dialog';
      for (const k of [].concat(inhalt)) wurzel.appendChild(k);
      document.body.appendChild(wurzel);
      const d = { wurzel, optionen, schliessen() { wurzel.remove(); if (optionen.beimSchliessen) optionen.beimSchliessen(); } };
      dialoge.push(d);
      return d;
    },
  };
}
function schein(delta, kommentare = {}, recht = 'bearbeiten') {
  const s = scheinSitzung(dokument, delta, recht);
  s.daten = { delta, kommentare };
  return s;
}
const einbinden = (s, ctx) => einbindenIn(editorEinbinden, s, ctx);

test('Kommentar anlegen: ein Op mit Markierung und Kommentar', async () => {
  const s = schein([{ insert: 'Hallo Welt\n' }]); const ctx = ctxMit(); const { wurzel, behaelter } = await einbinden(s, ctx);
  assert.equal(behaelter.querySelector('.od-rand').hidden, true, 'ohne Kommentare kein Rand');
  const t0 = wurzel.children[0].firstChild;
  sel.setze(t0, 2); document.dispatchEvent(new Event('selectionchange'));
  assert.equal(knopf(behaelter, 'kommentar').disabled, true, 'zusammengeklappte Auswahl');
  sel.setze(t0, 0, t0, 5); document.dispatchEvent(new Event('selectionchange'));
  assert.equal(knopf(behaelter, 'kommentar').disabled, false);
  knopf(behaelter, 'kommentar').click();
  const d = ctx.dialoge.at(-1);
  assert.equal(d.optionen.titel, 'office.dok_kommentar_neu');
  const form = d.wurzel.querySelector('form');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(d.wurzel.querySelector('.feld-fehler').hidden, false, 'leer geht nicht');
  d.wurzel.querySelector('textarea').value = '  Prüfen ';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await warten();
  const op = s.ops.at(-1);
  const [id] = Object.keys(op.k);
  assert.match(id, ID_MUSTER);
  assert.deepEqual(op.d, [{ retain: 5, attributes: { kommentar: id } }]);
  assert.deepEqual({ ...op.k[id].neu, zeit: 'Z' }, { wer: 'anna', name: 'Anna A.', zeit: 'Z', text: 'Prüfen' });
  assert.match(op.k[id].neu.zeit, ISO);
  assert.equal(behaelter.querySelector('.od-rand').hidden, false);
  assert.equal(behaelter.querySelectorAll('.od-rand .od-kommentar').length, 1);
  assert.equal(wurzel.querySelector('.od-kommentiert').dataset.kommentar, id);
  // Abbrechen ändert nichts
  const n = s.ops.length;
  sel.setze(wurzel.children[0].lastChild, 0, wurzel.children[0].lastChild, 3);
  knopf(behaelter, 'kommentar').click();
  ctx.dialoge.at(-1).schliessen(); await warten();
  assert.equal(s.ops.length, n);
});

test('antworten, erledigen, löschen nur eigener oder Besitzer', async () => {
  const delta = [{ insert: 'Hallo', attributes: { kommentar: 'kom001' } }, { insert: ' Welt\n' }];
  const s = schein(delta, { kom001: K_BEN }); const ctx = ctxMit(); const { behaelter } = await einbinden(s, ctx);
  const karte = () => behaelter.querySelector('.od-rand .od-kommentar');
  assert.equal(karte().querySelector('.od-kommentar-name').textContent, 'Ben');
  const feld = karte().querySelector('textarea.od-antwort-feld');
  feld.value = 'Ja'; feld.dispatchEvent(new Event('input', { bubbles: true }));
  karte().querySelector('[aria-label="office.dok_antworten"]').click();
  const [[aid, antwort]] = Object.entries(s.ops.at(-1).k.kom001.antworten);
  assert.match(aid, ID_MUSTER);
  assert.deepEqual({ ...antwort, zeit: 'Z' }, { wer: 'anna', name: 'Anna A.', zeit: 'Z', text: 'Ja' });
  assert.equal(s.ops.at(-1).d, undefined);
  assert.equal(karte().querySelectorAll('.od-antwort').length, 1);
  assert.equal(karte().querySelector('textarea.od-antwort-feld').value, '', 'Entwurf weg nach dem Senden');

  karte().querySelector('[aria-label="office.dok_erledigt"]').click();
  assert.deepEqual(s.ops.at(-1), { k: { kom001: { erledigt: true } } });
  assert.equal(karte(), null, 'erledigte sind ausgeblendet');
  const schalter = behaelter.querySelector('.od-rand input[type="checkbox"]');
  schalter.checked = true; schalter.dispatchEvent(new Event('change', { bubbles: true }));
  assert.ok(karte().querySelector('[aria-label="office.dok_wieder_oeffnen"]'));

  karte().querySelector('[aria-label="office.dok_kommentar_loeschen"]').click();
  await warten();
  assert.deepEqual(s.ops.at(-1), { d: [{ retain: 5, attributes: { kommentar: null } }], k: { kom001: null } });
  assert.equal(behaelter.querySelector('.od-rand').hidden, true);

  // cara ist weder Autorin noch Besitzerin: kein Löschen; Leser: keine Eingaben
  const c = schein(delta, { kom001: K_BEN }); const b = await einbinden(c, ctxMit({ name: 'cara', anzeigename: 'Cara' }));
  assert.equal(b.behaelter.querySelector('.od-kommentar [aria-label="office.dok_kommentar_loeschen"]'), null);
  assert.ok(b.behaelter.querySelector('.od-kommentar [aria-label="office.dok_antworten"]'));
  const l = schein(delta, { kom001: K_BEN }, 'lesen'); const r = await einbinden(l, ctxMit({ name: 'ben', anzeigename: 'Ben' }));
  assert.ok(r.behaelter.querySelector('.od-kommentar'));
  assert.equal(r.behaelter.querySelectorAll('.od-kommentar textarea, .od-kommentar button').length, 0);
});

test('kommentarListe: Reihenfolge, erledigt ausgeblendet, Stelle gelöscht', () => {
  const daten = {
    delta: [{ insert: 'ab' }, { insert: 'cd', attributes: { kommentar: 'b00001' } }, { insert: 'efgh' }, { insert: 'ij', attributes: { kommentar: 'a00001' } }, { insert: 'kl', attributes: { kommentar: 'e00001' } }, { insert: '\n' }],
    kommentare: { a00001: K_BEN, b00001: { ...K_BEN, text: 'B' }, c00001: { ...K_BEN, text: 'ohne' }, e00001: { ...K_BEN, erledigt: true } },
  };
  const l = kommentarListe(daten);
  assert.deepEqual(l.map((k) => k.id), ['b00001', 'a00001', 'c00001']);
  assert.deepEqual([l[0].start, l[0].laenge, l[1].start, l[2].ohneStelle, l[2].start], [2, 2, 8, true, null]);
  assert.deepEqual(kommentarListe(daten, { erledigteZeigen: true }).map((k) => k.id), ['b00001', 'a00001', 'e00001', 'c00001']);
});

test('Karte ↔ Stelle: Klick auf die Karte wählt die Stelle, Klick in den Text hebt die Karte hervor', async () => {
  const delta = [{ insert: 'ab' }, { insert: 'cd', attributes: { kommentar: 'kom001' } }, { insert: '\n' }];
  const s = schein(delta, { kom001: K_BEN }); const { wurzel, behaelter } = await einbinden(s, ctxMit());
  behaelter.querySelector('.od-kommentar').click();
  assert.deepEqual(_test.ed.auswahl(), { anker: 2, kopf: 4 });
  assert.ok(wurzel.querySelector('.od-kommentiert').classList.contains('od-aktiv'));
  assert.ok(behaelter.querySelector('.od-kommentar').classList.contains('od-aktiv'));
  // Neuzeichnen behält die Hervorhebung
  s.fremd({ d: [{ insert: 'X' }] });
  assert.ok(wurzel.querySelector('.od-kommentiert').classList.contains('od-aktiv'));
  wurzel.children[0].firstChild.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(behaelter.querySelector('.od-kommentar').classList.contains('od-aktiv'), false);
  wurzel.querySelector('.od-kommentiert').dispatchEvent(new Event('click', { bubbles: true }));
  assert.ok(behaelter.querySelector('.od-kommentar').classList.contains('od-aktiv'));
});

test('Handy: Knopf „Kommentare (n)“ öffnet die Liste im Dialog', async () => {
  const delta = [{ insert: 'Hallo', attributes: { kommentar: 'kom001' } }, { insert: '\n' }];
  const s = schein(delta, { kom001: K_BEN }, 'lesen'); const ctx = ctxMit(); const { behaelter } = await einbinden(s, ctx);
  const k = behaelter.querySelector('.od-leiste .od-knopf-kommentare');
  assert.equal(k.textContent, 'office.dok_kommentare');
  k.click();
  assert.equal(ctx.dialoge.at(-1).wurzel.querySelectorAll('.od-kommentar').length, 1);
});

test('cursorZeichnen: Name, Farbe per CSSOM, Auswahlrechtecke', () => {
  const ebene = document.createElement('div');
  cursorZeichnen(ebene, [{ von: 'k2', name: 'Ben', farbe: '#2f7fd1', auswahl: { anker: 1, kopf: 3 } }], () => [{ x: 10, y: 20, b: 30, h: 16 }]);
  const c = ebene.querySelector('.od-fcursor'); assert.equal(c.style.getPropertyValue('--farbe'), '#2f7fd1'); assert.equal(ebene.querySelector('.od-fcursor-name').textContent, 'Ben');
  assert.equal(ebene.querySelectorAll('.od-fauswahl').length, 1);
  assert.deepEqual([c.style.left, c.style.top, c.style.height], ['10px', '20px', '16px']);
  cursorZeichnen(ebene, [], () => []); assert.equal(ebene.childNodes.length, 0);
  cursorZeichnen(ebene, [{ von: 'k3', name: 'X', farbe: 'red;background:url(x)', auswahl: { anker: 0, kopf: 0 } }], () => [{ x: 0, y: 0, b: 0, h: 10 }]);
  assert.equal(ebene.querySelector('.od-fcursor').style.getPropertyValue('--farbe'), '#1d4ed8', 'nur #rrggbb');
});

test('Cursor verschwindet, wenn der Klient nicht mehr anwesend ist', async () => {
  const vorher = document.createRange;
  document.createRange = () => ({ setStart() {}, setEnd() {}, getClientRects: () => [{ left: 5, top: 6, width: 0, height: 16 }], getBoundingClientRect: () => ({ left: 5, top: 6, width: 0, height: 16 }) });
  try {
    const s = schein([{ insert: 'abc\n' }]); const { behaelter } = await einbinden(s, ctxMit());
    s.emit('auswahl', { von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2f7fd1', auswahl: { anker: 1, kopf: 1 } });
    await warten();
    assert.equal(behaelter.querySelectorAll('.od-cursor-ebene .od-fcursor').length, 1);
    s.emit('anwesend', [{ kid: 'k1' }]);
    await warten();
    assert.equal(behaelter.querySelectorAll('.od-cursor-ebene .od-fcursor').length, 0);
    s.emit('auswahl', { von: 'k3', name: 'Cara', farbe: '#b42318', auswahl: { anker: 0, kopf: 2 } });
    await warten();
    assert.equal(behaelter.querySelectorAll('.od-fauswahl').length, 1);
    s.emit('auswahl', { von: 'k3', auswahl: null });
    await warten();
    assert.equal(behaelter.querySelectorAll('.od-cursor-ebene > *').length, 0);
  } finally { if (vorher) document.createRange = vorher; else delete document.createRange; }
});
