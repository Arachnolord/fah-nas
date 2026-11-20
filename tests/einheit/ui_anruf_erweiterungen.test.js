// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufe in Chat-Ansicht, Kachel und Einstellungen (Plan 03, Aufgabe 14): laufende Anrufe für die Kachel, Port-Prüfung,
// Raumkopf mit Audio/Video und Banner, Admin-Karte „Anrufe von unterwegs“, Registrierung der Erweiterungen.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let h; let kopf; let einst; let erw; let erweiterungen;
const ticks = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  const t = (k, w) => (w ? `${k}:${JSON.stringify(w)}` : k);
  app._test.setzeT(t);
  h = { el: app.el, t, symbol: app.symbol, format: app.format };
  kopf = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-kopf.js')).href);
  einst = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-einstellungen.js')).href);
  erw = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-erweiterungen.js')).href);
  ({ erweiterungen } = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'erweiterungen.js')).href));
});
after(() => dom.aufraeumen());
afterEach(() => { document.body.textContent = ''; });

function scheinStand(karte) {
  const hoerer = new Set();
  return { karte, laufende: () => karte, on(fn) { hoerer.add(fn); return () => hoerer.delete(fn); }, setzen(k) { this.karte = k; karte = k; for (const fn of hoerer) fn(k); }, anzahl: () => hoerer.size };
}
function scheinSteuerung() {
  const hoerer = new Set(); let aktiv = null;
  return { aufrufe: [], beitreten(raum, o) { this.aufrufe.push([raum, o]); }, aktiv: () => aktiv, setzeAktiv(a) { aktiv = a; for (const fn of hoerer) fn(a); }, on(fn) { hoerer.add(fn); return () => hoerer.delete(fn); } };
}

test('laufendeZeilen', () => {
  const ueb = { raeume: [{ id: 'R', name: 'Team' }, { id: 'D', name: 'Ben' }, { id: 'S', name: 'Später' }] };
  const lauf = new Map([
    ['S', { raum: 'S', teilnehmer: [{}], beginn: '2026-10-18T10:09:00Z' }],
    ['R', { raum: 'R', teilnehmer: [{}, {}], beginn: '2026-10-18T10:05:00Z' }],
    ['X', { raum: 'X', teilnehmer: [{}], beginn: '2026-10-18T10:00:00Z' }],
  ]);
  assert.deepEqual(erw.laufendeZeilen(ueb, lauf), [{ raum: 'R', name: 'Team', anzahl: 2, beginn: '2026-10-18T10:05:00Z' }, { raum: 'S', name: 'Später', anzahl: 1, beginn: '2026-10-18T10:09:00Z' }]);
  assert.deepEqual(erw.laufendeZeilen(null, lauf), []);
});

test('portPruefen', () => { assert.deepEqual(['3478', '1023', '65536', '3478.5', 'x', ' 49999 '].map(einst.portPruefen), [3478, null, null, null, null, 49999]); });

test('anrufKopf: zwei Knöpfe, Banner bei laufendem Anruf, Beitreten ruft die Steuerung (DOM-Attrappe)', () => {
  const stand = scheinStand(new Map([['R', { raum: 'R', teilnehmer: [{}, {}], beginn: 'x' }]]));
  const steuerung = scheinSteuerung();
  const k = kopf.anrufKopf({ id: 'R', name: 'Team' }, { h, steuerung, stand });
  document.body.appendChild(k);
  const banner = k.querySelector('.anruf-banner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /chat\.anruf_laeuft:\{"n":2\}/);
  banner.querySelector('[data-knopf="beitreten"]').click();
  assert.deepEqual(steuerung.aufrufe.at(-1), ['R', { video: false, raumName: 'Team' }]);
  steuerung.setzeAktiv({ raum: 'R' });
  assert.equal(banner.hidden, true, 'selbst im Anruf → kein Banner');
  k.querySelector('[data-knopf="video"]').click();
  assert.deepEqual(steuerung.aufrufe.at(-1), ['R', { video: true, raumName: 'Team' }]);
  k.querySelector('[data-knopf="audio"]').click();
  assert.deepEqual(steuerung.aufrufe.at(-1), ['R', { video: false, raumName: 'Team' }]);
  steuerung.setzeAktiv(null); stand.setzen(new Map());
  assert.equal(banner.hidden, true, 'kein Anruf → kein Banner');
  k.remove();
  stand.setzen(new Map());
  assert.equal(stand.anzahl(), 0, 'nach dem Entfernen abgemeldet');
});

/** Admin-Kontext: Einstellung (chat.einstellungen.*) und Laufzustand (/api/chat/turn) getrennt wie im Agenten bzw. Web-Dienst. */
function adminCtx({ einstellung, stand }) {
  const api = []; const z = { einstellung: { ...einstellung }, stand: { ...stand } };
  const ctx = {
    rolle: 'admin', melden() {}, zeigeFehler() {}, fehlerText: (e) => e.message,
    get: async (url) => { assert.equal(url, '/api/chat/turn'); return { ...z.stand }; },
    api: async (aktion, p) => {
      api.push([aktion, p]);
      if (aktion === 'chat.einstellungen.lesen') return { max_anhang_mb: 2048, turn: { ...z.einstellung } };
      if (aktion === 'chat.einstellungen.setzen') z.einstellung = { ...z.einstellung, ...p.turn };
      return {};
    },
  };
  return { ctx, api, z, setzen: () => api.filter(([a]) => a === 'chat.einstellungen.setzen') };
}

test('Admin-Karte: nur für Admins; Weiterleitung, Stand, Speichern', async () => {
  const einstellungen = erweiterungen.einstellungen;
  assert.ok(einstellungen.length >= 1, 'Erweiterung registriert');
  assert.deepEqual(einstellungen.map((fn) => fn({ rolle: 'nutzer' })).filter(Boolean), []);
  const { ctx, z, setzen } = adminCtx({ einstellung: { aktiv: true, port: 3478 }, stand: { aktiv: true, port: 3478, lan_ip: '192.168.1.29', zuteilungen: 0, extern_zuletzt: null, fehler: null } });
  const karte = einstellungen.map((fn) => fn(ctx)).find(Boolean);
  document.body.appendChild(karte);
  await ticks();
  assert.match(karte.textContent, /chat\.unterwegs_weiterleiten:\{"port":3478,"ip":"192\.168\.1\.29"\}/);
  assert.match(karte.textContent, /chat\.unterwegs_nie/);
  assert.match(karte.textContent, /chat\.unterwegs_zuteilungen/);
  for (const feld of karte.querySelectorAll('.schalter, .feld')) assert.ok(feld.querySelector('.erklaerung'), 'jede Einstellung erklärt sich');
  const schalter = karte.querySelector('input[type="checkbox"]');
  assert.equal(schalter.checked, true);
  z.stand = { ...z.stand, aktiv: false, port: null };
  schalter.checked = false; schalter.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.deepEqual(setzen().at(-1), ['chat.einstellungen.setzen', { turn: { aktiv: false, port: 3478 } }]);
  assert.match(karte.textContent, /chat\.unterwegs_aus/);
  const port = karte.querySelector('input[type="number"]');
  port.value = '1023'; port.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.equal(setzen().length, 1, 'ungültiger Port → kein Speichern');
  assert.equal(karte.querySelector('.feld-fehler').hidden, false);
});

test('Admin-Karte: Einstellung und Laufzustand getrennt – belegter Port zeigt den eingestellten Port, Speichern schaltet nichts ab (Prüfbericht Plan 03, I7)', async () => {
  const { ctx, z, setzen } = adminCtx({ einstellung: { aktiv: true, port: 3479 }, stand: { aktiv: false, port: null, lan_ip: '192.168.1.29', zuteilungen: 0, extern_zuletzt: null, fehler: 'port_belegt' } });
  const karte = erweiterungen.einstellungen.map((fn) => fn(ctx)).find(Boolean);
  document.body.appendChild(karte);
  await ticks();
  assert.equal(karte.querySelector('input[type="checkbox"]').checked, true, 'Schalter zeigt die Einstellung');
  assert.equal(karte.querySelector('input[type="number"]').value, '3479');
  assert.match(karte.textContent, /chat\.unterwegs_port_belegt:\{"port":3479\}/);
  assert.doesNotMatch(karte.textContent, /chat\.unterwegs_aus/);
  z.stand = { ...z.stand, aktiv: true, port: 3480, fehler: null };
  const port = karte.querySelector('input[type="number"]');
  port.value = '3480'; port.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.deepEqual(setzen().at(-1), ['chat.einstellungen.setzen', { turn: { aktiv: true, port: 3480 } }], 'bleibt an');
  for (const [fehler, text] of [['agent', /chat\.unterwegs_fehler_agent/], ['start', /chat\.unterwegs_fehler_start/]]) {
    const g = adminCtx({ einstellung: { aktiv: true, port: 3478 }, stand: { aktiv: false, port: null, lan_ip: null, zuteilungen: 0, extern_zuletzt: null, fehler } });
    const k = erweiterungen.einstellungen.map((fn) => fn(g.ctx)).find(Boolean);
    document.body.appendChild(k); await ticks();
    assert.match(k.textContent, text, fehler);
  }
});

test('Erweiterungen registriert: Raumkopf und Kachel liefern Elemente', () => {
  assert.ok(erweiterungen.raumKopf.length >= 1);
  assert.ok(erweiterungen.kachel.length >= 1);
  const kachel = erweiterungen.kachel.map((fn) => fn({ raeume: [] })).find(Boolean);
  assert.equal(kachel.tagName, 'UL'); assert.equal(kachel.hidden, true, 'ohne laufende Anrufe versteckt');
});
