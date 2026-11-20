// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V6 JSON-WebSocket und Upgrade-Verteiler (Plan 02, Aufgabe 9).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { wsAnnehmen, upgradeVerteiler, herkunftGleich, WsVerbindung } from '../../src/web/ws.js';
import { annahmeSchluessel, rahmen, rahmenLesen } from '../../src/web/konsole.js';
import { maskiert, wsVerbinden } from './ws_hilfen.js';

let server; let port;
const verbindungen = [];
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = http.createServer();
  server.on('upgrade', upgradeVerteiler(new Map([
    ['/t', (req, s, k) => {
      const v = wsAnnehmen(req, s, k, { ping_ms: 50, max_nachricht: 1024 });
      verbindungen.push(v);
      v.on('nachricht', (n) => { if (n.art === 'schliessen') v.schliessen(n.code, 'tschüss'); else v.senden(n); });
    }],
    ['/r', (req, s, k) => { verbindungen.push(wsAnnehmen(req, s, k, { ping_ms: 0, max_rueckstand: 10 })); }],
  ])));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => { for (const v of verbindungen) v.schliessen(1001); await new Promise((r) => server.close(r)); });

test('konsole.js exportiert die Rahmen-Funktionen weiter', () => {
  assert.equal(annahmeSchluessel('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const r = rahmenLesen(maskiert(Buffer.from('hi')));
  assert.equal(r.rahmen[0].daten.toString(), 'hi');
  assert.ok(Buffer.isBuffer(rahmen(Buffer.from('x'), 1)));
});

test('Handschlag, Echo, Fragmente werden zusammengesetzt', async () => {
  const c = await wsVerbinden(port, '/t');
  assert.equal(c.status, 101);
  c.senden({ art: 'echo', x: 1 });
  assert.deepEqual(await c.naechste(), { art: 'echo', x: 1 });
  c.sendeRoh(Buffer.concat([maskiert(Buffer.from('{"art":"ec'), 1, false), maskiert(Buffer.from('ho","y":2}'), 0, true)]));
  assert.deepEqual(await c.naechste((o) => o.y === 2), { art: 'echo', y: 2 });
  c.schliessen();
});

test('kein JSON-Objekt oder ohne art → 1007, Binär → 1003, zu groß → 1009', async () => {
  for (const [roh, code] of [
    [maskiert(Buffer.from('[1]')), 1007],
    [maskiert(Buffer.from('{"x":1}')), 1007],
    [maskiert(Buffer.from('kein json')), 1007],
    [maskiert(Buffer.from([0xff, 0xfe])), 1007],
    [maskiert(Buffer.from('abc'), 2), 1003],
    [maskiert(Buffer.alloc(2000, 0x61)), 1009],
    [Buffer.concat([maskiert(Buffer.alloc(800, 0x61), 1, false), maskiert(Buffer.alloc(800, 0x61), 0, true)]), 1009],
  ]) {
    const c = await wsVerbinden(port, '/t');
    c.sendeRoh(roh);
    assert.equal((await c.zu).code, code);
  }
});

test('Totmann: Klient antwortet nicht auf Ping → nach 2 verpassten Pongs zu', async () => {
  const c = await wsVerbinden(port, '/t', { pong: false });
  const v = verbindungen.at(-1);
  const zu = new Promise((r) => v.once('zu', r));
  const ergebnis = await Promise.race([zu, warte(400).then(() => null)]);
  assert.ok(ergebnis, 'Server schließt binnen 400 ms');
  assert.equal(ergebnis.grund, 'totmann');
  void c;
});

test('mit Pong bleibt die Verbindung offen', async () => {
  const c = await wsVerbinden(port, '/t');
  await warte(300);
  c.senden({ art: 'noch_da' });
  assert.deepEqual(await c.naechste(), { art: 'noch_da' });
  c.schliessen();
});

test('Rückstand > max_rueckstand → schliessen(1013), senden liefert false', async () => {
  const c = await wsVerbinden(port, '/r');
  c.socket.pause();
  const v = verbindungen.at(-1);
  const gross = 'x'.repeat(65536);
  let r = true;
  for (let i = 0; i < 4000 && r; i++) r = v.senden({ art: 'last', d: gross });
  assert.equal(r, false);
  assert.equal(v.offen, false);
  c.socket.destroy();
});

test('Kontrollrahmen: Ping > 125 Byte oder ohne FIN → 1002 (RFC 6455 §5.5)', async () => {
  for (const roh of [maskiert(Buffer.alloc(126, 0x61), 0x9), maskiert(Buffer.from('x'), 0x9, false)]) {
    const c = await wsVerbinden(port, '/t');
    c.sendeRoh(roh);
    assert.equal(await Promise.race([c.zu.then((z) => z.code), warte(500).then(() => 'offen')]), 1002);
  }
});

/** Schein-Socket für WsVerbindung ohne Netz. */
function scheinSocket(writableLength = 0) {
  const geschrieben = [];
  const s = Object.assign(new EventEmitter(), { writableLength, destroyed: false, geschrieben, write: (b) => { geschrieben.push(b); return true; }, end: (b) => { if (b) geschrieben.push(b); }, destroy() { this.destroyed = true; } });
  return s;
}

test('Pong nur ohne Rückstau: steht zu viel aus, schließt 1013 statt zu antworten', () => {
  const s = scheinSocket(1000);
  const v = new WsVerbindung(s, { ping_ms: 0, max_rueckstand: 10 });
  let zu = null; v.on('zu', (e) => { zu = e; });
  v._daten(maskiert(Buffer.from('p'), 0x9));
  assert.equal(zu && zu.code, 1013);
  assert.ok(!s.geschrieben.some((b) => (b[0] & 0x0f) === 0xa), 'kein Pong');
});

test('großer Rahmen in 1-Byte-Stücken wird linear zusammengesetzt (kein quadratisches Kopieren)', () => {
  const v = new WsVerbindung(scheinSocket(), { ping_ms: 0, max_nachricht: 1024 * 1024 });
  let n = null; v.on('nachricht', (o) => { n = o; });
  const roh = maskiert(Buffer.from(JSON.stringify({ art: 'gross', d: 'x'.repeat(256 * 1024) })));
  const start = process.hrtime.bigint();
  for (let i = 0; i < roh.length; i++) v._daten(roh.subarray(i, i + 1));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(n && n.d.length, 256 * 1024);
  assert.ok(ms < 2000, `dauerte ${Math.round(ms)} ms`);
  // danach zwei Nachrichten in einem Stück
  const zwei = Buffer.concat([maskiert(Buffer.from('{"art":"a"}')), maskiert(Buffer.from('{"art":"b"}'))]);
  const arten = []; v.on('nachricht', (o) => arten.push(o.art));
  v._daten(zwei.subarray(0, 5)); v._daten(zwei.subarray(5));
  assert.deepEqual(arten, ['a', 'b']);
});

test('schliessen(4003, grund) sendet Close-Rahmen mit Code', async () => {
  const c = await wsVerbinden(port, '/t');
  c.senden({ art: 'schliessen', code: 4003 });
  assert.equal((await c.zu).code, 4003);
});

test('Verteiler: unbekannter Pfad → 404, herkunftGleich', async () => {
  assert.equal((await wsVerbinden(port, '/nix')).status, 404);
  assert.equal(herkunftGleich({ headers: { origin: 'https://a:1', host: 'a:1' } }), true);
  assert.equal(herkunftGleich({ headers: { origin: 'https://boese:1', host: 'a:1' } }), false);
  assert.equal(herkunftGleich({ headers: { host: 'a:1' } }), false);
  assert.equal(herkunftGleich({ headers: { origin: 'kaputt', host: 'a:1' } }), false);
});
