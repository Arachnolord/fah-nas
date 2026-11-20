// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Verbindung und Rahmen (Plan 02, Aufgabe 13): Aufrufe über den WebSocket, Wiederverbinden 1 s → 30 s, Warten
// ohne Verbindung (20 s), „sichtbar“-Meldungen, Ungelesen-Summe, Tab-Titel, Navigationsabzeichen.

import { test, mock, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let vb; let rahmen; let app; let dom;

class Schein {
  static alle = [];
  static get letzte() { return Schein.alle.at(-1); }
  constructor(url) { this.url = url; this.readyState = 0; this.gesendet = []; Schein.alle.push(this); }
  send(t) { if (this.readyState !== 1) throw new Error('nicht offen'); this.gesendet.push(t); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  oeffnen() { this.readyState = 1; this.onopen?.({}); }
  nachricht(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  zu(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  gesendetObj() { return this.gesendet.map((t) => JSON.parse(t)); }
}
function scheinDokument() {
  const hoerer = new Map();
  return { visibilityState: 'visible', addEventListener(a, f) { hoerer.set(a, f); }, removeEventListener(a) { hoerer.delete(a); }, feuern(a) { hoerer.get(a)?.(); } };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

before(async () => {
  dom = domAttrappe();
  vb = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'verbindung.js')).href);
  rahmen = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'rahmen.js')).href);
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
});
after(() => dom.aufraeumen());
beforeEach(() => { Schein.alle = []; mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); });
afterEach(() => { mock.timers.reset(); });

test('naechsteWartezeit: 1 s verdoppelt bis 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(vb.naechsteWartezeit), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('aufrufen: Antwort per id, Fehler als ChatFehler mit code', async () => {
  const v = new vb.ChatVerbindung({ url: 'ws://x/api/chat/ws', WebSocketKlasse: Schein, dokument: scheinDokument() });
  v.starten(); Schein.letzte.oeffnen();
  assert.equal(v.status, 'verbunden');
  const p = v.aufrufen('chat.uebersicht', {});
  const gesendet = Schein.letzte.gesendetObj().find((g) => g.art === 'aufruf');
  assert.deepEqual([gesendet.art, gesendet.aktion], ['aufruf', 'chat.uebersicht']);
  Schein.letzte.nachricht({ art: 'antwort', id: gesendet.id, ok: false, fehler: { code: 'E_RECHTE', meldung: 'nein' } });
  await assert.rejects(p, (e) => e instanceof vb.ChatFehler && e.code === 'E_RECHTE');
  const p2 = v.aufrufen('chat.uebersicht', {});
  const g2 = Schein.letzte.gesendetObj().filter((g) => g.art === 'aufruf').at(-1);
  Schein.letzte.nachricht({ art: 'antwort', id: g2.id, ok: true, ergebnis: { raeume: [] } });
  assert.deepEqual(await p2, { raeume: [] });
  v.stoppen();
});

test('Ereignisse vom Server gehen an on(art)', async () => {
  const v = new vb.ChatVerbindung({ url: 'ws://x', WebSocketKlasse: Schein, dokument: scheinDokument() });
  const empfangen = [];
  const ab = v.on('chat', (e) => empfangen.push(e));
  v.starten(); Schein.letzte.oeffnen();
  Schein.letzte.nachricht({ art: 'chat', raum: 'r', ereignis: 'nachricht', daten: { id: 'n' } });
  ab();
  Schein.letzte.nachricht({ art: 'chat', raum: 'r', ereignis: 'nachricht', daten: { id: 'n2' } });
  assert.equal(empfangen.length, 1);
  v.stoppen();
});

test('Wiederverbinden: offene Aufrufe → E_AGENT, neuer Versuch nach 1 s, dann 2 s; „wieder“ nach Erfolg', async () => {
  const v = new vb.ChatVerbindung({ url: 'ws://x', WebSocketKlasse: Schein, dokument: scheinDokument() });
  let wieder = 0; v.on('wieder', () => { wieder++; });
  v.starten(); Schein.letzte.oeffnen();
  const p = v.aufrufen('chat.uebersicht');
  Schein.letzte.zu(1006);
  await assert.rejects(p, (e) => e.code === 'E_AGENT');
  assert.equal(v.status, 'getrennt');
  mock.timers.tick(999); assert.equal(Schein.alle.length, 1);
  mock.timers.tick(1); assert.equal(Schein.alle.length, 2);
  Schein.letzte.zu(1006);
  mock.timers.tick(1999); assert.equal(Schein.alle.length, 2);
  mock.timers.tick(1); assert.equal(Schein.alle.length, 3);
  Schein.letzte.oeffnen();
  assert.equal(wieder, 1);
  Schein.letzte.zu(1006);
  mock.timers.tick(1000); assert.equal(Schein.alle.length, 4, 'nach Erfolg beginnt die Wartezeit wieder bei 1 s');
  v.stoppen();
});

test('endgültige Schließcodes: kein Wiederverbinden, Ereignis beendet', async () => {
  const v = new vb.ChatVerbindung({ url: 'ws://x', WebSocketKlasse: Schein, dokument: scheinDokument() });
  let beendet = null; v.on('beendet', (e) => { beendet = e; });
  v.starten(); Schein.letzte.oeffnen();
  Schein.letzte.zu(4003);
  assert.deepEqual(beendet, { code: 4003 });
  assert.equal(v.status, 'beendet');
  mock.timers.tick(60_000); assert.equal(Schein.alle.length, 1);
});

test('ohne Verbindung wartet ein Aufruf höchstens 20 s, dann E_AGENT; verbindet es vorher, geht er raus', async () => {
  const v = new vb.ChatVerbindung({ url: 'ws://x', WebSocketKlasse: Schein, dokument: scheinDokument() });
  v.starten();
  let fehler = null;
  const p = v.aufrufen('chat.uebersicht').catch((e) => { fehler = e; });
  mock.timers.tick(19_999); await flush();
  assert.equal(fehler, null);
  mock.timers.tick(1); await flush(); await p;
  assert.equal(fehler.code, 'E_AGENT');
  const q = v.aufrufen('chat.verlauf', { raum: 'r' });
  Schein.letzte.oeffnen();
  const g = Schein.letzte.gesendetObj().find((x) => x.art === 'aufruf');
  assert.equal(g.aktion, 'chat.verlauf');
  Schein.letzte.nachricht({ art: 'antwort', id: g.id, ok: true, ergebnis: 1 });
  assert.equal(await q, 1);
  v.stoppen();
});

test('sichtbar: beim Öffnen, bei visibilitychange und alle 60 s solange sichtbar', async () => {
  const d = scheinDokument();
  const v = new vb.ChatVerbindung({ url: 'ws://x', WebSocketKlasse: Schein, dokument: d });
  v.starten(); Schein.letzte.oeffnen();
  const sichtbar = () => Schein.letzte.gesendetObj().filter((g) => g.art === 'sichtbar').map((g) => g.ja);
  assert.deepEqual(sichtbar(), [true]);
  d.visibilityState = 'hidden'; d.feuern('visibilitychange');
  assert.deepEqual(sichtbar(), [true, false]);
  mock.timers.tick(60_000);
  assert.deepEqual(sichtbar(), [true, false], 'versteckt: keine Erneuerung');
  d.visibilityState = 'visible'; d.feuern('visibilitychange');
  mock.timers.tick(60_000);
  assert.deepEqual(sichtbar(), [true, false, true, true]);
  v.stoppen();
});

test('Rahmen: Summe, Tab-Titel', () => {
  assert.equal(rahmen.ungelesenSumme({ raeume: [{ ungelesen: 2 }, { ungelesen: 0 }, { ungelesen: 5, stumm: true }] }), 7);
  assert.equal(rahmen.ungelesenSumme(null), 0);
  assert.equal(rahmen.titelMitZaehler('Chat – nas', 3), '(3) Chat – nas');
  assert.equal(rahmen.titelMitZaehler('x', 150), '(99+) x');
  assert.equal(rahmen.titelMitZaehler('x', 0), 'x');
});

test('chatRahmenStarten: Abzeichen und Titel aus chat.uebersicht, neu laden entprellt nach chat-Ereignissen', async () => {
  const hoerer = new Map(); let aufrufe = 0; let n = 2;
  const verbindung = { starten() {}, on(a, f) { hoerer.set(a, f); return () => hoerer.delete(a); }, aufrufen: async () => { aufrufe++; return { raeume: [{ id: 'r', ungelesen: n, stumm: false }] }; } };
  const abzeichen = []; const titel = [];
  const r = await rahmen.chatRahmenStarten({ verbindung, t: (k) => k, nutzer: { name: 'anna' }, navigationAbzeichen: (id, x) => abzeichen.push([id, x]), titelZaehlerSetzen: (x) => titel.push(x) });
  assert.deepEqual(abzeichen.at(-1), ['chat', 2]); assert.equal(titel.at(-1), 2);
  n = 3;
  hoerer.get('chat')({ art: 'chat', raum: 'r', ereignis: 'nachricht', daten: { von: 'ben' } });
  hoerer.get('chat')({ art: 'chat', raum: 'r', ereignis: 'nachricht', daten: { von: 'ben' } });
  mock.timers.tick(1000); await flush();
  assert.equal(aufrufe, 2, 'zwei Ereignisse → ein Neuladen');
  assert.deepEqual(abzeichen.at(-1), ['chat', 3]);
  r.stoppen();
  assert.deepEqual(abzeichen.at(-1), ['chat', 0]);
});

test('navigationAbzeichen setzt und entfernt das Abzeichen (app.js)', () => {
  const nav = document.createElement('nav');
  const eintrag = document.createElement('a'); eintrag.setAttribute('data-id', 'chat'); eintrag.className = 'navigation-eintrag';
  nav.appendChild(eintrag); document.body.appendChild(nav);
  app._test.knoten.nav = nav;
  app.navigationAbzeichen('chat', 4);
  const span = eintrag.querySelector('.navigation-abzeichen');
  assert.equal(span.textContent, '4'); assert.equal(span.getAttribute('aria-label'), 'navigation.abzeichen:4');
  app.navigationAbzeichen('chat', 150);
  assert.equal(eintrag.querySelectorAll('.navigation-abzeichen').length, 1);
  assert.equal(eintrag.querySelector('.navigation-abzeichen').textContent, '99+');
  app.navigationAbzeichen('chat', 0);
  assert.equal(eintrag.querySelector('.navigation-abzeichen'), null);
  app.titelZaehlerSetzen(5);
  assert.match(document.title, /^\(5\) /);
  app.titelZaehlerSetzen(0);
  assert.doesNotMatch(document.title, /^\(/);
});

test('navigationAbzeichen: Gruppenknopf zeigt die Summe seiner Einträge (Handy-Leiste)', () => {
  const nav = document.createElement('nav');
  const gruppe = document.createElement('li'); gruppe.className = 'navigation-gruppe';
  const knopf = document.createElement('button'); knopf.className = 'navigation-eintrag navigation-gruppe-knopf';
  const a = document.createElement('a'); a.className = 'navigation-eintrag'; a.setAttribute('data-id', 'chat');
  const b = document.createElement('a'); b.className = 'navigation-eintrag'; b.setAttribute('data-id', 'office');
  gruppe.appendChild(knopf); gruppe.appendChild(a); gruppe.appendChild(b); nav.appendChild(gruppe);
  app._test.knoten.nav = nav;
  app.navigationAbzeichen('chat', 3);
  assert.equal(knopf.querySelector('.navigation-abzeichen').textContent, '3');
  app.navigationAbzeichen('chat', 0);
  assert.equal(knopf.querySelector('.navigation-abzeichen'), null);
});
