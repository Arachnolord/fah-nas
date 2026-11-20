// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat über HTTP (Plan 02, Aufgabe 12): Einladungsseite, Gast-Beitritt mit Keks, Gast abmelden, Anhänge lesen und
// hochladen für Nutzer und Gäste.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmp, standardAttrappe, dienstStarten, Browser, anfrage } from './web_hilfen.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const R = 'rAAAAAAAAAAAAAAAA';
const GID = 'gBBBBBBBBBBBBBBBB';
const GEHEIM = 'G'.repeat(43);
const TOKEN = 'T'.repeat(43);
const A = 'aCCCCCCCCCCCCCCCC';
const KEKS = `fahnas_chatgast=${GID}.${GEHEIM}`;
let a; let dienst; let port;

beforeEach(async () => {
  a = await standardAttrappe(await tmp());
  a.aktion('chat.gast.einladung', { rolle: 'gast', fn: (p) => { if (p.token !== TOKEN) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)'); return { raum: R, raum_name: 'Team', gueltig: true }; } });
  a.aktion('chat.gast.beitreten', { rolle: 'gast', fn: (p) => { if (p.token !== TOKEN) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'weg'); return { ausweis: { id: GID, geheimnis: GEHEIM }, raum: R }; } });
  a.aktion('chat.gast.pruefen', { rolle: 'gast', fn: (p) => { if (!p.ausweis || p.ausweis.id !== GID || p.ausweis.geheimnis !== GEHEIM) throw new FahnasFehler('E_RECHTE', 'Gastzugang ungültig'); return { raum: R, raum_name: 'Team', name: 'Gustav', gast: GID }; } });
  a.aktion('chat.gast.verlassen', { rolle: 'gast', fn: () => ({ verlassen: true }) });
  a.aktion('chat.gast.anhang_ticket', { rolle: 'gast', fn: (p) => ({ ticket: a.ticketAnlegen({ nutzer: `gast:${GID}`, art: 'schreiben', pfad: 'x', antwort: { ok: true, ergebnis: { id: A, name: p.name, groesse: p.groesse, mime: 'text/plain' } } }), dateiname: p.name, groesse: p.groesse }) });
  a.aktion('chat.gast.anhang_lesen', { rolle: 'gast', fn: (p) => ({ ticket: a.ticketAnlegen({ nutzer: `gast:${GID}`, art: 'lesen', inhalt: Buffer.from('gastdatei') }), dateiname: 'g.txt', groesse: 9, mime: 'text/plain', _p: p }) });
  a.aktion('chat.anhang.lesen', { rolle: 'nutzer', fn: (p, k) => (p.vorschau
    ? { mime: 'image/webp', daten: Buffer.from('bild').toString('base64') }
    : { ticket: a.ticketAnlegen({ nutzer: k.nutzer, art: 'lesen', inhalt: Buffer.from('<b>hallo</b>') }), dateiname: 'foto.html', groesse: 12, mime: 'text/html' }) });
  ({ dienst, port } = await dienstStarten(a));
});
afterEach(async () => { await dienst.stoppen(); await a.stoppen(); });

function chunked(pfad, kopf) {
  return new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pfad, headers: { ...kopf, 'transfer-encoding': 'chunked' } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(t) }));
    });
    req.write('abc'); req.end();
  });
}

test('Einladungsseite: gültig mit Skript, ungültig 404 ohne Skript und zählt in der Bremse', async () => {
  const ok = await anfrage(port, 'GET', `/einladung/${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /<script type="module" src="\/chat-gast\.js"><\/script>/);
  assert.match(ok.text, /<main id="chat-gast"/);
  assert.equal(ok.kopf['x-robots-tag'], 'noindex, nofollow');
  const weg = await anfrage(port, 'GET', '/einladung/kurz');
  assert.equal(weg.status, 404); assert.ok(!weg.text.includes('<script')); assert.match(weg.text, /ungültig oder abgelaufen/);
  for (let i = 0; i < 4; i++) assert.equal((await anfrage(port, 'GET', `/einladung/${'X'.repeat(43)}`)).status, 404);
  assert.equal((await anfrage(port, 'GET', `/einladung/${TOKEN}`)).status, 429, '5 Fehlversuche → auch gültige Links gebremst');
});

test('Einladung als JSON ohne Raum-ID; angemeldet/gast_hier', async () => {
  const r = await anfrage(port, 'GET', `/api/chat/einladung/${TOKEN}`);
  assert.deepEqual(r.json.ergebnis, { raum_name: 'Team', gueltig: true, angemeldet: false, gast_hier: false });
  const g = await anfrage(port, 'GET', `/api/chat/einladung/${TOKEN}`, { kopf: { cookie: KEKS } });
  assert.equal(g.json.ergebnis.gast_hier, true);
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  assert.equal((await b.get(`/api/chat/einladung/${TOKEN}`)).json.ergebnis.angemeldet, true);
  assert.equal((await anfrage(port, 'GET', `/api/chat/einladung/${'X'.repeat(43)}`)).status, 404);
});

test('Beitreten setzt den Gast-Keks; fremde Herkunft → 403', async () => {
  const r = await anfrage(port, 'POST', '/api/chat/gast/beitreten', { body: { token: TOKEN, name: 'Gustav' }, kopf: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.ergebnis, { raum: R, raum_name: 'Team', name: 'Gustav' });
  assert.match(r.setCookie.join('\n'), new RegExp(`fahnas_chatgast=${GID}\\.${GEHEIM}; Path=/; SameSite=Lax; HttpOnly; Max-Age=34560000`));
  assert.equal((await anfrage(port, 'POST', '/api/chat/gast/beitreten', { body: { token: TOKEN, name: 'G' }, kopf: { origin: 'https://boese.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('Gast ich: mit Keks die eigene Identität, sonst 401', async () => {
  assert.deepEqual((await anfrage(port, 'GET', '/api/chat/gast/ich', { kopf: { cookie: KEKS } })).json.ergebnis, { raum: R, raum_name: 'Team', name: 'Gustav', gast: GID });
  assert.equal((await anfrage(port, 'GET', '/api/chat/gast/ich')).status, 401);
});

test('Hochladen: Content-Length Pflicht, Gast-Ticket mit Ausweis, Antwort mit Anhang', async () => {
  const ohne = await chunked(`/api/chat/hochladen?raum=${R}&name=a.txt`, { cookie: KEKS, origin: `http://127.0.0.1:${port}` });
  assert.equal(ohne.status, 400); assert.equal(ohne.json.fehler.details.feld, 'Content-Length');
  const r = await anfrage(port, 'POST', `/api/chat/hochladen?raum=${R}&name=a.txt`, { body: Buffer.from('12345'), kopf: { cookie: KEKS, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/octet-stream' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.ergebnis, { anhang: { id: A, name: 'a.txt', groesse: 5, mime: 'text/plain' } });
  assert.deepEqual(a.anfragen.findLast((x) => x.aktion === 'chat.gast.anhang_ticket').params, { ausweis: { id: GID, geheimnis: GEHEIM }, raum: R, name: 'a.txt', groesse: 5 });
  assert.equal(a.datenKoepfe.at(-1).nutzer, `gast:${GID}`);
  assert.equal((await anfrage(port, 'POST', `/api/chat/hochladen?raum=${R}&name=a.txt`, { body: Buffer.from('1'), kopf: { origin: `http://127.0.0.1:${port}` } })).status, 401);
});

test('Anhang lesen: inline, herunterladen=1 als attachment, Vorschau mit sandbox, ohne Identität 401', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const inline = await b.get(`/api/chat/anhang?raum=${R}&anhang=${A}`);
  assert.equal(inline.status, 200); assert.equal(inline.text, '<b>hallo</b>');
  assert.match(inline.kopf['content-disposition'], /^inline/);
  assert.match(inline.kopf['content-type'], /^text\/plain/, 'aktive Typen werden beim Anzeigen zu Text');
  const dl = await b.get(`/api/chat/anhang?raum=${R}&anhang=${A}&herunterladen=1`);
  assert.match(dl.kopf['content-disposition'], /^attachment/);
  const v = await b.get(`/api/chat/anhang?raum=${R}&anhang=${A}&vorschau=256`);
  assert.equal(v.kopf['content-type'], 'image/webp'); assert.equal(v.kopf['content-security-policy'], "default-src 'none'; sandbox"); assert.equal(v.text, 'bild');
  assert.equal((await anfrage(port, 'GET', `/api/chat/anhang?raum=${R}&anhang=${A}`)).status, 401);
  const g = await anfrage(port, 'GET', `/api/chat/anhang?raum=${R}&anhang=${A}`, { kopf: { cookie: KEKS } });
  assert.equal(g.text, 'gastdatei');
  assert.equal((await b.get(`/api/chat/anhang?raum=${R}&anhang=kaputt`)).status, 400);
});

test('Gast abmelden: verlassen beim Agenten, Keks gelöscht', async () => {
  const r = await anfrage(port, 'POST', '/api/chat/gast/abmelden', { body: {}, kopf: { cookie: KEKS, origin: `http://127.0.0.1:${port}` } });
  assert.equal(r.status, 200);
  assert.ok(a.anfragen.some((x) => x.aktion === 'chat.gast.verlassen'));
  assert.match(r.setCookie.join('\n'), /fahnas_chatgast=; Path=\/; SameSite=Lax; HttpOnly; Max-Age=0/);
});
