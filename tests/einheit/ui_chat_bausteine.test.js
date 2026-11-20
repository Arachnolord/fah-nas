// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Geteilte Chat-Bausteine (Plan 02, Aufgabe 16): Verlauf (zusammenführen, Ereignisse, Gruppen, Ansicht), Eingabe
// (Tasten, Senden, Zähler), Anhänge (Adresse, Menü, Element) und Hinweise (wann Ton/Meldung). Ohne app.js – die
// Gastseite nutzt dieselben Bausteine.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, alsText } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let verlauf; let eingabe; let anhang; let hinweise; let h;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  const t = (k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k);
  app._test.setzeT(t);
  h = { el: app.el, t, symbol: app.symbol, format: { zeit: (x) => x, zeitGenau: (x) => x, groesse: (b) => `${b} B` } };
  verlauf = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'verlauf.js')).href);
  eingabe = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'eingabe.js')).href);
  anhang = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anhang.js')).href);
  hinweise = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'hinweise.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { document.body.textContent = ''; });

const zeit = (tag, std, min) => new Date(2026, 9, tag, std, min).toISOString();
const nachricht = (id, von, z, weiteres = {}) => ({ id, von, von_name: von, zeit: z, text: `t-${id}`, anhaenge: [], reaktionen: {}, ...weiteres });

test('zusammenfuehren entdoppelt und sortiert', () => {
  const a = [{ id: 'n1', text: 'a' }, { id: 'n3', text: 'c' }]; const b = [{ id: 'n2', text: 'b' }, { id: 'n3', text: 'c2' }];
  assert.deepEqual(verlauf.zusammenfuehren(a, b).map((n) => [n.id, n.text]), [['n1', 'a'], ['n2', 'b'], ['n3', 'c2']]);
});

test('ereignisAnwenden: gelöscht wird Platzhalter', () => {
  const l = verlauf.ereignisAnwenden([{ id: 'n1', text: 'x', anhaenge: [{ id: 'a' }], reaktionen: { '👍': ['ben'] } }], 'geloescht', { id: 'n1' });
  assert.deepEqual(l[0], { id: 'n1', text: '', anhaenge: [], reaktionen: {}, geloescht: true });
});

test('ereignisAnwenden: nachricht, bearbeitet, reaktion; Antwort-Zitate folgen', () => {
  let l = [nachricht('n1', 'anna', zeit(18, 10, 0)), nachricht('n2', 'ben', zeit(18, 10, 1), { antwort: { id: 'n1', von_name: 'anna', kurz: 't-n1' } })];
  l = verlauf.ereignisAnwenden(l, 'nachricht', nachricht('n3', 'ben', zeit(18, 10, 2)));
  assert.deepEqual(l.map((n) => n.id), ['n1', 'n2', 'n3']);
  l = verlauf.ereignisAnwenden(l, 'bearbeitet', { id: 'n1', text: 'neu', bearbeitet: '2026-10-18T10:05:00.000Z' });
  assert.equal(l[0].text, 'neu'); assert.equal(l[0].bearbeitet, '2026-10-18T10:05:00.000Z');
  assert.equal(l[1].antwort.kurz, 'neu', 'Zitat zeigt den neuen Text');
  l = verlauf.ereignisAnwenden(l, 'reaktion', { id: 'n2', reaktionen: { '🎉': ['anna'] } });
  assert.deepEqual(l[1].reaktionen, { '🎉': ['anna'] });
  l = verlauf.ereignisAnwenden(l, 'geloescht', { id: 'n1' });
  assert.deepEqual(l[1].antwort, { id: 'n1', von_name: 'anna', kurz: '', geloescht: true }, 'gelöschter Text verschwindet auch aus Zitaten');
  assert.equal(verlauf.ereignisAnwenden(l, 'bearbeitet', { id: 'weg', text: 'x' }), l, 'unbekannte ID ändert nichts');
});

test('nachWiederverbinden: Lücke → neue Seite ersetzt die Liste (mehr), Überschneidung oder ganze Seite → zusammenführen (Befund 9)', () => {
  const alt = [{ id: 'n1' }, { id: 'n2' }];
  assert.deepEqual(verlauf.nachWiederverbinden(alt, { nachrichten: [{ id: 'n2' }, { id: 'n3' }], mehr: true }, false), { nachrichten: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], mehr: false });
  assert.deepEqual(verlauf.nachWiederverbinden(alt, { nachrichten: [{ id: 'n7' }, { id: 'n8' }], mehr: true }, false), { nachrichten: [{ id: 'n7' }, { id: 'n8' }], mehr: true });
  assert.deepEqual(verlauf.nachWiederverbinden(alt, { nachrichten: [{ id: 'n7' }], mehr: false }, false), { nachrichten: [{ id: 'n1' }, { id: 'n2' }, { id: 'n7' }], mehr: false });
  assert.deepEqual(verlauf.nachWiederverbinden([], { nachrichten: [{ id: 'n7' }], mehr: true }, false), { nachrichten: [{ id: 'n7' }], mehr: true });
});

test('gruppiere: Tage, Folge innerhalb 5 min, eigen', () => {
  const l = [
    nachricht('n1', 'anna', zeit(18, 10, 0)), nachricht('n2', 'anna', zeit(18, 10, 4)), nachricht('n3', 'anna', zeit(18, 10, 10)),
    nachricht('n4', 'ben', zeit(18, 10, 11)), { ...nachricht('n5', null, zeit(18, 10, 12)), system: { art: 'beitritt', wer_name: 'carla' } },
    nachricht('n6', 'ben', zeit(18, 10, 13)), nachricht('n7', 'ben', zeit(19, 9, 0)),
  ];
  const g = verlauf.gruppiere(l, { ich: 'anna' });
  assert.deepEqual(g.map((x) => x.tag), ['2026-10-18', '2026-10-19']);
  assert.deepEqual(g[0].eintraege.map((e) => e.folge), [false, true, false, false, false, false]);
  assert.deepEqual(g[0].eintraege.map((e) => e.eigen), [true, true, true, false, false, false]);
  assert.equal(g[1].eintraege[0].folge, false, 'neuer Tag beginnt neu');
  // Gastsicht: NAS-Nutzer ohne Login-Namen (von null) werden nach Anzeigenamen getrennt
  const gast = verlauf.gruppiere([{ ...nachricht('n1', null, zeit(18, 10, 0)), von_name: 'Anna' }, { ...nachricht('n2', null, zeit(18, 10, 1)), von_name: 'Ben' }], { ich: 'gast:g1' });
  assert.deepEqual(gast[0].eintraege.map((e) => e.folge), [false, false]);
});

test('tasteAuswerten', () => {
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', shiftKey: false }), 'senden');
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', shiftKey: true }), 'zeile');
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', shiftKey: false, isComposing: true }), null);
  assert.equal(eingabe.tasteAuswerten({ key: 'a' }), null);
});

test('tasteAuswerten am Handy: Enter macht eine neue Zeile, gesendet wird mit dem Knopf oder Strg+Enter (Befund 22)', () => {
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', shiftKey: false }, { beruehrung: true }), 'zeile');
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', ctrlKey: true }, { beruehrung: true }), 'senden');
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', metaKey: true }, { beruehrung: true }), 'senden');
  assert.equal(eingabe.tasteAuswerten({ key: 'Enter', shiftKey: false }, { beruehrung: false }), 'senden');
});

test('Bedienbarkeit: Reaktions-Chips mindestens 40 px, Nachrichten-Aktionen per Tastatur erreichbar (Befund 22)', async () => {
  const css = await fs.readFile(path.join(PUBLIC, 'ansichten', 'chat.css'), 'utf8');
  const regel = (sel) => { const i = css.indexOf(`\n${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  assert.match(regel('.chat-reaktion'), /min-height: (4\d|[5-9]\d)px/);
  assert.doesNotMatch(regel('.chat-aktionen'), /visibility: hidden/, 'unsichtbar ja, aber per Tab erreichbar');
  assert.match(css, /\.chat-nachricht:focus-within \.chat-aktionen/);
  const touch = css.slice(css.indexOf('@media (hover: none)'));
  assert.match(touch.slice(0, touch.indexOf('}')), /opacity: 1; pointer-events: auto/, 'am Handy (ohne Hover) immer sichtbar und bedienbar');
});

test('eingabeLeiste: Enter sendet Text und Antwort, leert danach; Zähler ab 9000 Zeichen', async () => {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const gesendet = [];
  const leiste = eingabe.eingabeLeiste(behaelter, { h, beiSenden: (x) => { gesendet.push(x); return Promise.resolve(); }, beiTippen() {} });
  const feld = behaelter.querySelector('textarea');
  feld.value = 'Hallo';
  leiste.antwortSetzen({ id: 'n1', von_name: 'ben', text: 'Frage' });
  assert.match(alsText(behaelter), /ben/);
  feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));
  await warte();
  assert.deepEqual(gesendet, [{ text: 'Hallo', antwort: 'n1', dateien: [] }]);
  assert.equal(feld.value, '');
  assert.equal(behaelter.querySelector('.chat-eingabe-antwort').hidden, true);
  feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));
  await warte();
  assert.equal(gesendet.length, 1, 'leere Eingabe sendet nicht');
  const zaehler = behaelter.querySelector('.chat-zeichen');
  feld.value = 'x'.repeat(8999); feld.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(zaehler.hidden, true);
  feld.value = 'x'.repeat(9000); feld.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(zaehler.hidden, false); assert.equal(zaehler.textContent, 'chat.zeichen:9000');
});

test('eingabeLeiste: scheitert das Senden, bleibt der Text stehen', async () => {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const leiste = eingabe.eingabeLeiste(behaelter, { h, beiSenden: () => Promise.reject(new Error('weg')), beiTippen() {} });
  const feld = behaelter.querySelector('textarea');
  feld.value = 'Wichtig';
  feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));
  await warte();
  assert.equal(feld.value, 'Wichtig');
  leiste.leeren();
  assert.equal(feld.value, '');
});

test('menueEintraege: Standardordner nur wenn gesetzt, Gäste nur Herunterladen', () => {
  const a = { id: 'a1', name: 'x.pdf' };
  assert.deepEqual(anhang.menueEintraege(a, { h, standardordner: { freigabe: 'team', pfad: 'Chat' } }).map((e) => e.id), ['herunterladen', 'standard', 'waehlen']);
  assert.match(anhang.menueEintraege(a, { h, standardordner: { freigabe: 'team', pfad: 'Chat' } })[1].text, /team\/Chat/);
  assert.deepEqual(anhang.menueEintraege(a, { h, standardordner: null }).map((e) => e.id), ['herunterladen', 'waehlen']);
  assert.deepEqual(anhang.menueEintraege(a, { h, standardordner: { freigabe: 'team', pfad: '' }, istGast: true }).map((e) => e.id), ['herunterladen']);
});

test('anhangUrl kodiert', () => {
  assert.equal(anhang.anhangUrl('r A', 'a/b', { vorschau: 256 }), '/api/chat/anhang?raum=r%20A&anhang=a%2Fb&vorschau=256');
  assert.equal(anhang.anhangUrl('r1', 'a1', { herunterladen: true }), '/api/chat/anhang?raum=r1&anhang=a1&herunterladen=1');
});

test('anhangElement: Bild mit Vorschau, Auswahl „Los“ speichert in den Standardordner oder fragt nach dem Ordner', () => {
  const gespeichert = [];
  const url = (o = {}) => anhang.anhangUrl('r1', 'a1', o);
  const bild = anhang.anhangElement({ id: 'a1', name: 'b.png', mime: 'image/png', bild: true, groesse: 10 }, { h, url, standardordner: { freigabe: 'team', pfad: 'Chat' }, beiSpeichern: (a, z) => gespeichert.push([a.id, z]) });
  document.body.appendChild(bild);
  const img = bild.querySelector('img');
  assert.equal(img.getAttribute('src'), '/api/chat/anhang?raum=r1&anhang=a1&vorschau=256');
  assert.equal(img.getAttribute('loading'), 'lazy');
  const wahl = bild.querySelector('select');
  wahl.value = 'standard'; bild.querySelector('.chat-anhang-los').click();
  wahl.value = 'waehlen'; bild.querySelector('.chat-anhang-los').click();
  assert.deepEqual(gespeichert, [['a1', { freigabe: 'team', pfad: 'Chat' }], ['a1', null]]);
  const video = anhang.anhangElement({ id: 'a2', name: 'v.mp4', mime: 'video/mp4', video: true, groesse: 10 }, { h, url, istGast: true, beiSpeichern() {} });
  assert.equal(video.querySelector('video').getAttribute('preload'), 'metadata');
  assert.equal(video.querySelectorAll('option').length, 1, 'Gäste: nur Herunterladen');
});

test('sollMelden: Tabelle der Fälle', () => {
  const basis = { eigen: false, sichtbar: false, raumOffen: false, stumm: false, ton: true, browser: true, erlaubt: 'granted' };
  const f = (x) => hinweise.sollMelden({ ...basis, ...x });
  assert.deepEqual(f({ eigen: true }), { ton: false, meldung: false });
  assert.deepEqual(f({ stumm: true }), { ton: false, meldung: false });
  assert.deepEqual(f({ sichtbar: true, raumOffen: true }), { ton: false, meldung: false });
  assert.deepEqual(f({ sichtbar: true }), { ton: true, meldung: false });
  assert.deepEqual(f({}), { ton: true, meldung: true });
  assert.deepEqual(f({ erlaubt: 'default' }), { ton: true, meldung: false });
  assert.deepEqual(f({ ton: false, browser: false }), { ton: false, meldung: false });
});

test('verlaufAnsicht zeigt HTML im Text als Text und baut unveränderte Nachrichten nicht neu', () => {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const v = verlauf.verlaufAnsicht(behaelter, { h, ich: 'anna', beiAnhang: () => null });
  v.setzen([nachricht('n1', 'ben', zeit(18, 10, 0), { text: '<img src=x onerror=1>' })], false);
  assert.equal(behaelter.querySelectorAll('img').length, 0);
  assert.match(alsText(behaelter), /&lt;img|<img src=x onerror=1>/);
  const erste = behaelter.querySelector('[data-id="n1"]');
  v.anwenden('nachricht', nachricht('n2', 'anna', zeit(18, 10, 1)));
  assert.equal(behaelter.querySelector('[data-id="n1"]'), erste, 'n1 bleibt dasselbe Element');
  assert.ok(behaelter.querySelector('[data-id="n2"]').classList.contains('eigen'));
  v.anwenden('geloescht', { id: 'n1' });
  assert.match(alsText(behaelter.querySelector('[data-id="n1"]')), /chat\.geloescht/);
  v.tippt('ben');
  assert.match(alsText(behaelter), /chat\.tippt:ben/);
  v.gelesenSetzen({ ben: 'n2', anna: 'n2' }, { ben: 'Ben' });
  assert.match(alsText(behaelter), /chat\.gelesen_von:Ben/);
  v.verlassen();
});

test('verlaufAnsicht: Absender mit Avatar – Bild nur für Mitglieder mit Bild, Gäste mit Buchstaben, Folge-Nachrichten ohne (0.22.0)', async () => {
  const av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
  av.avatareSetzen({ ben: 'abcdef012345' });
  try {
    const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
    const v = verlauf.verlaufAnsicht(behaelter, { h, ich: 'anna', beiAnhang: () => null });
    v.setzen([
      nachricht('n1', 'ben', zeit(18, 10, 0), { von_name: 'Ben' }),
      nachricht('n2', 'ben', zeit(18, 10, 1), { von_name: 'Ben' }),
      { id: 'n3', gast: true, von_name: 'Gustav', zeit: zeit(18, 10, 2), text: 'Hallo', anhaenge: [], reaktionen: {} },
    ], false);
    const kopf = (id) => behaelter.querySelector(`[data-id="${id}"] .chat-kopf`);
    assert.equal(kopf('n1').querySelector('.avatar img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
    assert.equal(kopf('n2'), null, 'Folge-Nachricht ohne Kopf und Bild');
    const gast = kopf('n3').querySelector('.avatar');
    assert.equal(gast.textContent, 'G'); assert.equal(gast.querySelector('img'), null); assert.equal(gast.getAttribute('data-avatar'), null);
    v.verlassen();
  } finally { av.avatareSetzen({}); }
});

test('verlaufAnsicht: Zitat einer früheren Nachricht (Gast) nur als Hinweis, ohne Name und Sprungziel', () => {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const v = verlauf.verlaufAnsicht(behaelter, { h, ich: 'gast:g1', beiAnhang: () => null });
  v.setzen([nachricht('n3', null, zeit(18, 11, 0), { text: 'Antwort', von_name: 'Anna A.', antwort: { frueher: true } })], false);
  const z = behaelter.querySelector('[data-id="n3"] .chat-zitat');
  assert.ok(z.classList.contains('chat-zitat-frueher'));
  assert.equal(z.textContent, 'chat.antwort_frueher');
  assert.equal(z.getAttribute('role'), null, 'kein Sprungziel');
  v.verlassen();
  behaelter.remove();
});

test('keine Abhängigkeit von app.js', async () => {
  for (const d of ['verlauf.js', 'eingabe.js', 'anhang.js', 'hinweise.js']) {
    const q = await fs.readFile(path.join(PUBLIC, 'chat', d), 'utf8');
    assert.doesNotMatch(q, /app\.js/, d);
  }
});
