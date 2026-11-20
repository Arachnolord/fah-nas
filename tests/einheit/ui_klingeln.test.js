// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Klingeln in der ganzen Oberfläche (Plan 03, Aufgabe 13): Zustand aus klingelt/stand/Zeit, Overlay mit Annehmen,
// Mit Video annehmen, Ablehnen; blinkender Tab-Titel; Klingelton alle 3 s; Ende nach 45 s; mehrere Räume.

import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, alsText } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let k; let h;

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  const t = (s, w) => (w ? `${s}:${Object.values(w).join(',')}` : s);
  h = { el: app.el, t, symbol: app.symbol, format: app.format };
  k = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'klingeln.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { mock.timers.reset(); document.body.textContent = ''; });

function scheinVerbindung() {
  const hoerer = new Map();
  return {
    gesendet: [],
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    senden(o) { this.gesendet.push(o); return true; },
    ausloesen(art, n) { for (const fn of [...(hoerer.get(art) || [])]) fn(n); },
  };
}
function scheinAudio() {
  const zaehler = { toene: 0 };
  const erzeugen = () => ({
    currentTime: 0, state: 'running', destination: {},
    resume: async () => {}, close: async () => {},
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() { zaehler.toene++; }, stop() {} }; },
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; },
  });
  return { zaehler, erzeugen };
}

test('klingelnReduzieren', () => {
  const z = k.klingelnReduzieren(new Map(), { art: 'anruf.klingelt', raum: 'D', von_name: 'Anna A.', video: true }, 1000);
  assert.deepEqual(z.get('D'), { von_name: 'Anna A.', video: true, seit: 1000 });
  assert.equal(k.klingelnReduzieren(z, { art: 'anruf.stand', raum: 'D', teilnehmer: [{ id: 'p1', ich: true }] }, 2000).has('D'), false);
  assert.equal(k.klingelnReduzieren(z, { art: 'anruf.stand', raum: 'D', teilnehmer: [{ id: 'p1', ich: false }] }, 2000).has('D'), true);
  assert.equal(k.klingelnReduzieren(z, { art: 'anruf.stand', raum: 'D', teilnehmer: [] }, 2000).has('D'), false);
  assert.equal(k.klingelnReduzieren(z, { art: 'zeit' }, 46_001).has('D'), false);
  assert.equal(k.klingelnReduzieren(z, { art: 'zeit' }, 40_000).has('D'), true);
  assert.equal(k.klingelnReduzieren(z, { art: 'weg', raum: 'D' }, 0).has('D'), false);
  assert.equal(k.klingelnReduzieren(z, { art: 'chat' }, 0), z);
});

test('titelText', () => {
  assert.equal(k.titelText('Chat – nas', 'Anna', true, h.t), 'chat.anruf_ruft_an:Anna');
  assert.equal(k.titelText('Chat – nas', 'Anna', false, h.t), 'Chat – nas');
});

test('Overlay: Annehmen, mit Video, Ablehnen; Titel blinkt; Ton; schließt nach 45 s', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const v = scheinVerbindung(); const audio = scheinAudio(); const angenommen = [];
  document.title = 'Chat – nas';
  const s = k.klingelnStarten({ verbindung: v, h, beiAnnehmen: (raum, o) => angenommen.push([raum, o]), tonErzeugen: audio.erzeugen });
  v.ausloesen('anruf.klingelt', { art: 'anruf.klingelt', raum: 'D', von_name: 'Anna A.', video: false });
  const o = document.body.querySelector('.klingeln');
  assert.equal(o.getAttribute('role'), 'alertdialog');
  assert.match(alsText(o), /chat\.anruf_ruft_an:Anna A\./);
  assert.equal(o.querySelectorAll('button').length, 3);
  assert.equal(document.head.querySelectorAll('link[href="/chat/anruf.css"]').length, 1, 'Stil auch ohne laufenden Anruf');
  o.querySelector('[data-knopf="ablehnen"]').click();
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.ablehnen', raum: 'D' });
  assert.equal(document.body.querySelector('.klingeln'), null);
  assert.equal(document.title, 'Chat – nas');
  v.ausloesen('anruf.klingelt', { art: 'anruf.klingelt', raum: 'D', von_name: 'Anna A.', video: true });
  document.body.querySelector('[data-knopf="annehmen_video"]').click();
  assert.deepEqual(angenommen, [['D', { video: true, raumName: 'Anna A.' }]]);
  assert.equal(document.body.querySelector('.klingeln'), null);
  v.ausloesen('anruf.klingelt', { art: 'anruf.klingelt', raum: 'D', von_name: 'Anna A.', video: false });
  await Promise.resolve();
  const toeneAnfang = audio.zaehler.toene;
  assert.ok(toeneAnfang > 0, 'Ton beim Klingeln');
  mock.timers.tick(1000);
  assert.equal(document.title, 'chat.anruf_ruft_an:Anna A.');
  mock.timers.tick(1000);
  assert.equal(document.title, 'Chat – nas');
  mock.timers.tick(1000);
  await Promise.resolve();
  assert.ok(audio.zaehler.toene > toeneAnfang, 'Ton wiederholt sich alle 3 s');
  mock.timers.tick(42_000);
  assert.equal(document.body.querySelector('.klingeln'), null, 'nach 45 s weg');
  assert.equal(document.title, 'Chat – nas');
  v.ausloesen('anruf.klingelt', { art: 'anruf.klingelt', raum: 'D', von_name: 'Anna A.', video: false });
  v.ausloesen('anruf.klingelt', { art: 'anruf.klingelt', raum: 'E', von_name: 'Ben', video: false });
  assert.equal(document.body.querySelectorAll('.klingeln').length, 2, 'zwei Räume übereinander');
  v.ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'D', teilnehmer: [], beginn: null });
  assert.equal(document.body.querySelectorAll('.klingeln').length, 1, 'Anrufer hat aufgelegt');
  document.body.querySelector('[data-knopf="annehmen"]').click();
  assert.deepEqual(angenommen.at(-1), ['E', { video: false, raumName: 'Ben' }]);
  s.stoppen();
  assert.equal(document.title, 'Chat – nas');
});
