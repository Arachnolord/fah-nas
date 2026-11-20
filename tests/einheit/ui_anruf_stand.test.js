// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anruf-Stand in der Oberfläche (Plan 03, Aufgabe 10): laufende Anrufe je Raum aus anruf.stand, Anruf-Notizen im
// Verlauf, Abfragen beim Start und nach dem Wiederverbinden.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, alsText } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let as; let verlauf; let app;

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  as = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'anruf-stand.js')).href);
  verlauf = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'verlauf.js')).href);
});
after(() => dom.aufraeumen());

test('standAnwenden: setzen, leeren entfernen, Fremdes ignorieren', () => {
  const k1 = as.standAnwenden(new Map(), { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'p1' }], beginn: '2026-10-18T10:00:00.000Z' });
  assert.deepEqual(k1.get('R'), { raum: 'R', teilnehmer: [{ id: 'p1' }], beginn: '2026-10-18T10:00:00.000Z' });
  assert.equal(as.standAnwenden(k1, { art: 'anruf.stand', raum: 'R', teilnehmer: [], beginn: null }).has('R'), false);
  assert.equal(k1.has('R'), true, 'rein: die alte Karte bleibt');
  assert.equal(as.standAnwenden(k1, { art: 'chat' }), k1);
});

test('anrufSystemText', () => {
  const t = (k, w) => `${k}|${JSON.stringify(w ?? {})}`; const format = { dauer: (s) => `${s}s` };
  assert.equal(as.anrufSystemText({ art: 'anruf_ende', daten: { dauer_s: 125 } }, t, format), 'chat.system_anruf_ende|{"dauer":"125s"}');
  assert.equal(as.anrufSystemText({ art: 'anruf_ende', daten: { dauer_s: 0 } }, t, format), 'chat.system_anruf_nicht_angenommen|{}');
  assert.equal(as.anrufSystemText({ art: 'anruf_verpasst', wer_name: 'Anna A.', daten: {} }, t, format), 'chat.system_anruf_verpasst|{"name":"Anna A."}');
  assert.equal(as.anrufSystemText({ art: 'beitritt' }, t, format), null);
});

test('anrufStand: abfragen beim Start und nach wieder; Hörer bei Änderung; Einzelstück je Verbindung', () => {
  const hoerer = new Map(); const gesendet = []; let offen = true;
  const v = { on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, []); hoerer.get(art).push(fn); return () => {}; }, senden(o) { if (!offen) return false; gesendet.push(o); return true; } };
  const ausloesen = (art, d) => { for (const fn of hoerer.get(art) || []) fn(d); };
  const s = as.anrufStand(v);
  assert.equal(as.anrufStand(v), s);
  assert.deepEqual(gesendet, [{ art: 'anruf.abfragen' }]);
  const gesehen = [];
  s.on((k) => gesehen.push(new Map(k)));
  ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'p1' }], beginn: 'x' });
  assert.equal(gesehen.length, 1); assert.ok(gesehen[0].has('R')); assert.ok(s.laufende().has('R'));
  ausloesen('wieder');
  assert.deepEqual(gesendet, [{ art: 'anruf.abfragen' }, { art: 'anruf.abfragen' }]);
  assert.equal(s.laufende().size, 0, 'nach dem Wiederverbinden zählt nur der neue Stand');
  // nicht verbunden: die Abfrage wartet auf das nächste „verbunden“
  const hoerer2 = new Map(); const gesendet2 = []; let verbunden = false;
  const v2 = { on(art, fn) { hoerer2.set(art, fn); return () => {}; }, senden(o) { if (!verbunden) return false; gesendet2.push(o); return true; } };
  as.anrufStand(v2);
  assert.deepEqual(gesendet2, []);
  verbunden = true; hoerer2.get('status')('verbunden');
  assert.deepEqual(gesendet2, [{ art: 'anruf.abfragen' }]);
  void offen;
});

test('Verlauf zeigt Anruf-Notizen', () => {
  const t = (k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k);
  const h = { el: app.el, t, symbol: app.symbol, format: { dauer: (s) => `${s} s` } };
  const b = document.createElement('div'); document.body.appendChild(b);
  const v = verlauf.verlaufAnsicht(b, { h, ich: 'anna' });
  v.setzen([
    { id: 'n1', zeit: '2026-10-18T10:00:00.000Z', von: null, von_name: '', text: '', anhaenge: [], reaktionen: {}, system: { art: 'anruf_ende', wer_name: '', daten: { dauer_s: 65, video: true } } },
    { id: 'n2', zeit: '2026-10-18T10:05:00.000Z', von: null, von_name: '', text: '', anhaenge: [], reaktionen: {}, system: { art: 'anruf_verpasst', wer_name: 'Ben', daten: { video: false } } },
  ], false);
  assert.match(alsText(b), /chat\.system_anruf_ende:65 s/);
  assert.match(alsText(b), /chat\.system_anruf_verpasst:Ben/);
  v.verlassen();
});
