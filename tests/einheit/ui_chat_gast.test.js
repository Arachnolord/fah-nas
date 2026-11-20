// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gastseite für Einladungslinks (Plan 02, Aufgabe 18): Token aus dem Pfad, Rahmen-Texte de/en, Texte der Bausteine
// aus chat.json (Rückfall de), Ende der Verbindung bei „entfernt“ (4003), Helfer im Stil von app.js.

import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let gast; let vb;

before(async () => {
  dom = domAttrappe();
  gast = await import(pathToFileURL(path.join(PUBLIC, 'chat-gast.js')).href);
  vb = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'verbindung.js')).href);
});
after(() => dom.aufraeumen());

test('tokenAusPfad', () => {
  assert.equal(gast.tokenAusPfad('/einladung/abcDEF_-1234567890'), 'abcDEF_-1234567890');
  assert.equal(gast.tokenAusPfad('/einladung/'), null);
  assert.equal(gast.tokenAusPfad('/einladung/kurz'), null);
  assert.equal(gast.tokenAusPfad('/link/abcDEF_-1234567890'), null);
  assert.equal(gast.tokenAusPfad('/einladung/abcDEF_-1234567890/mehr'), null);
});

test('gastTexte: englisch, unbekannte Sprache → deutsch, Platzhalter', () => {
  assert.equal(gast.gastTexte('en')('beitreten'), 'Join');
  assert.equal(gast.gastTexte('fr')('beitreten'), 'Beitreten');
  assert.equal(gast.gastTexte('de')('bremse', { s: 12 }), 'Zu viele Versuche – bitte warte 12 Sekunden.');
  assert.equal(gast.gastTexte('de')('gibtsnicht'), 'gibtsnicht');
});

test('chatTexteLaden: englische Datei, bei 404 die deutsche; Schlüssel bekommen „chat.“', async () => {
  const angefragt = [];
  const holen = (fehlt) => async (url) => {
    angefragt.push(url);
    const m = /^\/sprache\/(de|en)\/chat\.json$/.exec(url);
    if (!m || m[1] === fehlt) return { ok: false, status: 404, json: async () => ({}) };
    const text = await fs.readFile(path.join(PUBLIC, 'sprache', m[1], 'chat.json'), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const en = await gast.chatTexteLaden('en', holen(null));
  assert.equal(en('chat.senden'), 'Send');
  assert.equal(en('chat.tippt', { name: 'Ben' }), 'Ben is typing …');
  assert.equal(en('chat.gibtsnicht'), 'chat.gibtsnicht');
  const rueck = await gast.chatTexteLaden('en', holen('en'));
  assert.equal(rueck('chat.senden'), 'Senden');
  assert.deepEqual(angefragt.slice(-2), ['/sprache/en/chat.json', '/sprache/de/chat.json']);
  const fr = await gast.chatTexteLaden('fr', holen(null));
  assert.equal(fr('chat.senden'), 'Senden', 'unbekannte Sprache → deutsch');
});

test('el und symbol der Gastseite verhalten sich wie in app.js (Eigenschaften, Klassen, Ereignisse)', () => {
  let geklickt = 0;
  const k = gast.el('button', { class: 'knopf', type: 'button', hidden: true, disabled: true, 'aria-label': 'x', onclick: () => { geklickt++; } }, ['a', null, ['b']]);
  assert.equal(k.className, 'knopf'); assert.equal(k.hidden, true); assert.equal(k.disabled, true);
  assert.equal(k.getAttribute('aria-label'), 'x'); assert.equal(k.textContent, 'ab');
  k.click(); assert.equal(geklickt, 1);
  const s = gast.symbol('chat', 'gross');
  assert.equal(s.getAttribute('class'), 'symbol gross');
  assert.equal(s.querySelector('use').getAttribute('href'), '/symbole.svg#symbol-chat');
});

class Schein {
  static alle = [];
  constructor() { this.readyState = 0; this.gesendet = []; Schein.alle.push(this); }
  send(t) { this.gesendet.push(t); }
  close() { this.readyState = 3; }
}
beforeEach(() => { Schein.alle = []; });
afterEach(() => { mock.timers.reset(); });

test('Gast-Verbindung endet bei 4003 („entfernt“) ohne Wiederverbinden', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const v = new vb.ChatVerbindung({ url: 'ws://x/api/chat/ws', WebSocketKlasse: Schein, dokument: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  let beendet = null; v.on('beendet', (e) => { beendet = e; });
  v.starten();
  const s = Schein.alle[0]; s.readyState = 1; s.onopen({});
  s.readyState = 3; s.onclose({ code: 4003 });
  assert.deepEqual(beendet, { code: 4003 });
  mock.timers.tick(60_000);
  assert.equal(Schein.alle.length, 1);
});

test('anrufeGastStarten: Knöpfe im Kopf, Audio holt ICE und tritt bei, 4003 legt auf; kein app.js', async () => {
  const hoerer = new Map(); const gesendet = [];
  const verbindung = {
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    senden(o) { gesendet.push(o); return true; },
    ausloesen(art, d) { for (const fn of [...(hoerer.get(art) || [])]) fn(d); },
  };
  const spur = () => ({ kind: 'audio', enabled: true, stop() {}, addEventListener() {} });
  const medien = { async getUserMedia() { const s = [spur()]; return { getTracks: () => s, getAudioTracks: () => s, getVideoTracks: () => [], addTrack() {} }; } };
  const vorher = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: medien, configurable: true });
  try {
    const h = { el: gast.el, t: (k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k), symbol: gast.symbol, format: {} };
    const kopf = document.createElement('div'); document.body.appendChild(kopf);
    const geholt = [];
    const holen = async (url, o) => { geholt.push([url, o.credentials]); return { json: async () => ({ ok: true, ergebnis: { ice_server: [{ urls: ['stun:nas:3478'] }], gueltig_bis: null } }) }; };
    const R = 'rAAAAAAAAAAAAAAAA';
    const a = gast.anrufeGastStarten({ verbindung, h, kopf, raum: { id: R, name: 'Team' }, holen });
    assert.ok(kopf.querySelector('[data-knopf="audio"]')); assert.ok(kopf.querySelector('[data-knopf="video"]'));
    kopf.querySelector('[data-knopf="audio"]').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(geholt, [['/api/chat/ice', 'same-origin']]);
    assert.deepEqual(gesendet.find((m) => m.art === 'anruf.beitreten'), { art: 'anruf.beitreten', raum: R, video: false });
    assert.deepEqual(a.steuerung.aktiv(), { raum: R });
    verbindung.ausloesen('beendet', { code: 4003 });
    assert.equal(a.steuerung.aktiv(), null);
    a.stoppen();
  } finally {
    if (vorher) Object.defineProperty(globalThis.navigator, 'mediaDevices', vorher); else delete globalThis.navigator.mediaDevices;
    document.body.textContent = '';
  }
  const quelle = await fs.readFile(path.join(PUBLIC, 'chat-gast.js'), 'utf8');
  assert.doesNotMatch(quelle, /app\.js/);
});
