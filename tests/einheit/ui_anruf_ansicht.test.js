// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anruf-Ansicht und -Steuerung (Plan 03, Aufgabe 12): Raster je Personenzahl, Steuerknöpfe nach Zustand, ICE holen,
// Kacheln mit Video (eigenes stumm), Auflegen; Steuerung als Einzelstück mit Ebene, Raumwechsel legt vorher auf.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let ansicht; let steuerung; let h;
const ticks = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  const t = (k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k);
  h = { el: app.el, t, symbol: app.symbol, format: app.format };
  ansicht = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-ansicht.js')).href);
  steuerung = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-steuerung.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { document.body.textContent = ''; });

/** Schein-Anruf mit Ereignissen. */
function scheinAnruf(teilnehmer = []) {
  const hoerer = new Map(); const aufrufe = [];
  return {
    aufrufe, raum: 'R',
    teilnehmer: new Map(teilnehmer.map((x) => [x.id, x])),
    lokalerStrom: { lokal: true }, medienStand: { audio: true, video: true, bildschirm: false },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    ausloesen(art, d) { for (const fn of hoerer.get(art) || []) fn(d); },
    mikrofon(an) { aufrufe.push(['mikrofon', an]); this.medienStand.audio = an; },
    async kamera(an) { aufrufe.push(['kamera', an]); }, async bildschirm(an) { aufrufe.push(['bildschirm', an]); },
    async starten(o) { aufrufe.push(['starten', o]); return true; }, verlassen() { aufrufe.push(['verlassen']); this.ausloesen('ende', { grund: 'verlassen' }); },
  };
}

test('rasterKlasse', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ansicht.rasterKlasse), ['anruf-raster-1', 'anruf-raster-2', 'anruf-raster-4', 'anruf-raster-4', 'anruf-raster-6', 'anruf-raster-6']);
});

test('steuerKnoepfe', () => {
  assert.deepEqual(ansicht.steuerKnoepfe({ audio: true, video: false, bildschirm: false, kannBildschirm: false }).map((k) => [k.id, k.symbol]),
    [['mikrofon', 'mikrofon'], ['kamera', 'kamera_aus'], ['geraete', 'menue'], ['vollbild', 'vollbild'], ['auflegen', 'auflegen']]);
  const mit = ansicht.steuerKnoepfe({ audio: false, video: true, bildschirm: true, kannBildschirm: true });
  assert.equal(mit[2].text, 'chat.anruf_bildschirm_ende');
  assert.deepEqual(mit[0], { id: 'mikrofon', symbol: 'mikrofon_aus', text: 'chat.anruf_mikro_an' });
  assert.deepEqual(mit[1], { id: 'kamera', symbol: 'kamera', text: 'chat.anruf_kamera_aus' });
});

test('iceHolen', async () => {
  const r = await steuerung.iceHolen(async (url, o) => { assert.equal(url, '/api/chat/ice'); assert.equal(o.credentials, 'same-origin'); return { json: async () => ({ ok: true, ergebnis: { ice_server: [], gueltig_bis: null } }) }; });
  assert.deepEqual(r, { ice_server: [], gueltig_bis: null });
  await assert.rejects(steuerung.iceHolen(async () => ({ json: async () => ({ ok: false, fehler: { code: 'E_ANMELDUNG', meldung: 'x' } }) })), (e) => e.code === 'E_ANMELDUNG');
});

test('anrufAnsicht: eigene Kachel stumm, je Teilnehmer ein video playsinline, Auflegen ruft beiAuflegen (DOM-Attrappe)', () => {
  const anruf = scheinAnruf([
    { id: 'pA', name: 'Ben', gast: false, medien: { audio: true, video: true, bildschirm: false }, strom: { ben: true } },
    { id: 'pC', name: 'Cara', gast: true, medien: { audio: false, video: false, bildschirm: false }, strom: null },
  ]);
  const b = document.createElement('div'); document.body.appendChild(b);
  let aufgelegt = 0;
  const a = ansicht.anrufAnsicht(b, { h, anruf, raumName: 'Team', beiAuflegen: () => { aufgelegt++; }, beiKlein() {} });
  const videos = b.querySelectorAll('video');
  assert.equal(videos.length, 3);
  assert.ok(videos.every((v) => v.hasAttribute('playsinline') && v.hasAttribute('autoplay')));
  const eigen = b.querySelector('.anruf-eigen video');
  assert.equal(eigen.muted, true); assert.equal(eigen.srcObject, anruf.lokalerStrom);
  assert.ok(b.querySelector('.anruf-raster').classList.contains('anruf-raster-4'));
  assert.ok(b.querySelector('[data-teilnehmer="pC"] .anruf-mikro-aus'), 'Mikro aus sichtbar');
  assert.equal(b.querySelector('[data-teilnehmer="pC"] .anruf-initial').textContent, 'C');
  b.querySelector('[data-knopf="mikrofon"]').click();
  assert.deepEqual(anruf.aufrufe.at(-1), ['mikrofon', false]);
  b.querySelector('[data-knopf="auflegen"]').click();
  assert.equal(aufgelegt, 1);
  anruf.teilnehmer.delete('pC'); anruf.ausloesen('teilnehmer', anruf.teilnehmer);
  assert.equal(b.querySelectorAll('video').length, 2);
  assert.ok(b.querySelector('.anruf-raster').classList.contains('anruf-raster-2'));
  a.meldung('Hallo');
  assert.equal(b.querySelector('.anruf-meldung').textContent, 'Hallo');
  a.verlassen();
});

test('anrufAnsicht: eigene Kachel zeigt den eigenen Namen mit „(du)“ und dessen Anfangsbuchstaben (Bedienprobe 0.21.1)', () => {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const anruf = scheinAnruf([]); anruf.medienStand.video = false; anruf.eigenerName = 'Fabian';
  const a = ansicht.anrufAnsicht(behaelter, { h, anruf, raumName: 'R' });
  const eigen = behaelter.querySelector('.anruf-eigen');
  assert.equal(eigen.querySelector('.anruf-name').textContent, 'Fabian chat.du');
  assert.equal(eigen.querySelector('.anruf-initial').textContent, 'F');
  // vor dem ersten Stand ist der eigene Name noch unbekannt: nur „(du)“, aber nie dessen Klammer als Buchstabe
  anruf.eigenerName = ''; a.aktualisieren();
  assert.equal(eigen.querySelector('.anruf-name').textContent, 'chat.du');
  assert.equal(eigen.querySelector('.anruf-initial').textContent, '?');
});

test('anrufAnsicht: ohne Kamera das Avatar-Bild in der Kachel – auch in der eigenen; Gäste mit Buchstaben (0.22.0)', async () => {
  const av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
  av.avatareSetzen({ ben: 'abcdef012345', anna: '0123456789ab' });
  try {
    const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
    const ohneBild = { audio: true, video: false, bildschirm: false };
    const anruf = scheinAnruf([{ id: 'pB', name: 'Ben', nutzer: 'ben', gast: false, medien: ohneBild }, { id: 'pG', name: 'Gustav', gast: true, medien: ohneBild }]);
    anruf.medienStand.video = false; anruf.eigenerName = 'Anna'; anruf.eigenerNutzer = 'anna';
    ansicht.anrufAnsicht(behaelter, { h, anruf, raumName: 'R' });
    const kachel = (id) => behaelter.querySelector(`[data-teilnehmer="${id}"] .anruf-initial`);
    assert.equal(kachel('pB').querySelector('img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
    assert.equal(kachel('ich').querySelector('img').getAttribute('src'), '/api/avatar/anna?v=0123456789ab');
    assert.equal(kachel('pG').querySelector('img'), null); assert.equal(kachel('pG').textContent, 'G');
    assert.equal(kachel('pB').hidden, false, 'ohne Kamera sichtbar');
  } finally { av.avatareSetzen({}); }
});

test('anrufSteuerung: Einzelstück, Ebene mit CSS, Raumwechsel legt vorher auf, Ende räumt auf', async () => {
  const verbindung = { on: () => () => {}, senden: () => true };
  const erzeugt = [];
  class ScheinKlasse { constructor(o) { const a = scheinAnruf(); Object.assign(a, { optionen: o }); erzeugt.push(a); return a; } }
  const s = steuerung.anrufSteuerung({ verbindung, h, iceHolen: async () => ({ ice_server: [{ urls: ['stun:x'] }], gueltig_bis: null }), AnrufKlasse: ScheinKlasse });
  assert.equal(steuerung.anrufSteuerung({ verbindung, h }), s, 'Einzelstück je Verbindung');
  const stand = []; s.on((x) => stand.push(x));
  await s.beitreten('R', { video: true, raumName: 'Team' });
  assert.deepEqual(s.aktiv(), { raum: 'R' });
  assert.deepEqual(erzeugt[0].optionen.iceServer, [{ urls: ['stun:x'] }]);
  assert.deepEqual(erzeugt[0].aufrufe[0], ['starten', { video: true }]);
  assert.ok(document.body.querySelector('.anruf-ebene'));
  assert.equal(document.head.querySelectorAll('link[href="/chat/anruf.css"]').length, 1);
  await s.beitreten('R2', { video: false, raumName: 'Anders' });
  assert.deepEqual(erzeugt[0].aufrufe.at(-1), ['verlassen'], 'erst auflegen');
  assert.deepEqual(s.aktiv(), { raum: 'R2' });
  assert.equal(document.body.querySelectorAll('.anruf-ebene').length, 1);
  assert.equal(document.head.querySelectorAll('link[href="/chat/anruf.css"]').length, 1, 'CSS nur einmal');
  s.verlassen();
  await ticks();
  assert.equal(s.aktiv(), null);
  assert.equal(document.body.querySelector('.anruf-ebene'), null);
  assert.deepEqual(stand.at(-1), null);
});

test('Steuerung: Gründe kein_raum und fehler haben eigene Texte (nicht den Mikrofon-Text) (Prüfbericht Plan 03, M2)', async () => {
  const quelle = await fs.readFile(path.join(PUBLIC, 'chat', 'anruf-steuerung.js'), 'utf8');
  assert.match(quelle, /kein_raum: 'chat\.anruf_kein_raum'/); assert.match(quelle, /fehler: 'chat\.anruf_fehler'/);
  for (const sp of ['de', 'en']) {
    const texte = JSON.parse(await fs.readFile(path.join(PUBLIC, 'sprache', sp, 'chat.json'), 'utf8'));
    assert.ok(texte.anruf_kein_raum && texte.anruf_fehler, sp);
  }
});

test('Anruf-Bausteine nutzen nur chat.*-Texte – die Gastseite lädt keine rahmen.*-Texte (Prüfbericht Plan 03, M3)', async () => {
  for (const d of ['anruf-ansicht.js', 'anruf-steuerung.js', 'anruf.js', 'klingeln.js']) {
    const quelle = await fs.readFile(path.join(PUBLIC, 'chat', d), 'utf8');
    assert.doesNotMatch(quelle, /t\('rahmen\./, d);
  }
  for (const sp of ['de', 'en']) {
    const texte = JSON.parse(await fs.readFile(path.join(PUBLIC, 'sprache', sp, 'chat.json'), 'utf8'));
    assert.ok(texte.abbrechen && texte.uebernehmen, sp);
  }
});

test('CSS: Raumkopf (.anruf-kopf) und Kopf der Anruf-Ebene (.anruf-ebene-kopf) getrennt (Prüfbericht Plan 03, M4)', async () => {
  const ansichtCss = await fs.readFile(path.join(PUBLIC, 'chat', 'anruf.css'), 'utf8');
  assert.doesNotMatch(ansichtCss, /\.anruf-kopf\b/, 'anruf.css verstellt den Raumkopf nicht');
  assert.match(ansichtCss, /\.anruf-ebene-kopf \{/);
  const quelle = await fs.readFile(path.join(PUBLIC, 'chat', 'anruf-ansicht.js'), 'utf8');
  assert.match(quelle, /class: 'anruf-ebene-kopf'/);
});

test('Symbole vorhanden', async () => {
  const svg = await fs.readFile(path.join(PUBLIC, 'symbole.svg'), 'utf8');
  for (const n of ['anruf', 'auflegen', 'kamera', 'kamera_aus', 'mikrofon', 'mikrofon_aus', 'bildschirm', 'vollbild']) assert.match(svg, new RegExp(`id="symbol-${n}"`));
});
