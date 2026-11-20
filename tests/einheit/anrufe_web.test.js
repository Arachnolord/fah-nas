// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufe im echten Web-Dienst (Plan 03, Aufgabe 9): /api/chat/ice für Sitzung und Gast, /api/chat/turn nur für Admins,
// STUN/TURN am laufenden Dienst mit den ausgegebenen Zugangsdaten, Signalisierung Ende zu Ende über den WebSocket,
// Abschalten über die Chat-Einstellungen.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, standardAttrappe, dienstStarten, Browser, anfrage } from './web_hilfen.js';
import { wsVerbinden } from './ws_hilfen.js';
import { turnKlient } from './turn_hilfen.js';
import { METHODE, KLASSE } from '../../src/web/turn/stun.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const R = 'rAAAAAAAAAAAAAAAA';
const GID = 'gBBBBBBBBBBBBBBBB';
const GEHEIM = 'G'.repeat(43);
const GAST_KEKS = `fahnas_chatgast=${GID}.${GEHEIM}`;
let a; let dienst; let port; let turnInfo;
const bis = async (fn, ms = 3000) => { const ende = Date.now() + ms; while (Date.now() < ende) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

beforeEach(async () => {
  a = await standardAttrappe(await tmp());
  turnInfo = { lan_ip: '127.0.0.1', aktiv: true, port: 3478 };
  a.aktion('chat.turn_info', { rolle: 'gast', fn: () => ({ ...turnInfo }) });
  a.aktion('chat.empfaenger', { rolle: 'nutzer', fn: () => ({ nutzer: ['fabian', 'tina'], gaeste: [GID] }) });
  a.aktion('chat.gast.pruefen', { rolle: 'gast', fn: (p) => {
    if (!p.ausweis || p.ausweis.id !== GID || p.ausweis.geheimnis !== GEHEIM) throw new FahnasFehler('E_RECHTE', 'Gastzugang ungültig');
    return { raum: R, raum_name: 'Team', name: 'Gustav', gast: GID };
  } });
  a.aktion('chat.gast.empfaenger', { rolle: 'gast', fn: () => ({ nutzer: ['fabian', 'tina'], gaeste: [GID] }) });
  a.aktion('chat.anruf', { rolle: 'nutzer', fn: () => ({ benachrichtigt: [] }) });
  a.aktion('chat.gast.anruf', { rolle: 'gast', fn: () => ({ benachrichtigt: [] }) });
  ({ dienst, port } = await dienstStarten(a, { heartbeat_ms: 50, turn: { portFest: 0, relayVon: 47830, relayBis: 47835 } }));
  assert.ok(await bis(() => dienst.turn.stand().aktiv), 'TURN läuft nach dem Start');
});
afterEach(async () => { await dienst.stoppen(); await a.stoppen(); });

async function tina() {
  const t = new Browser(port); await t.anmelden('tina', 'tina1234'); await t.post('/api/anmelden/totp', { code: '123456' });
  return t;
}

test('ICE: ohne Identität 401; Sitzung und Gast bekommen eigene Zugangsdaten', async () => {
  assert.equal((await anfrage(port, 'GET', '/api/chat/ice')).status, 401);
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const antwort = await b.get('/api/chat/ice');
  assert.equal(antwort.kopf['cache-control'], 'no-store');
  const r = antwort.json.ergebnis;
  const tport = dienst.turn.stand().port;
  assert.deepEqual(r.ice_server[0].urls, [`stun:127.0.0.1:${tport}`, `turn:127.0.0.1:${tport}?transport=udp`]);
  assert.match(r.ice_server[0].username, /^\d+:fabian$/);
  assert.ok(Date.parse(r.gueltig_bis) > Date.now());
  const g = await anfrage(port, 'GET', '/api/chat/ice', { kopf: { cookie: GAST_KEKS } });
  assert.match(g.json.ergebnis.ice_server[0].username, new RegExp(`^\\d+:gast-${GID}$`));
});

test('TURN-Stand nur für Admins', async () => {
  const t = await tina();
  const r = await t.get('/api/chat/turn');
  assert.equal(r.status, 403); assert.equal(r.json.fehler.code, 'E_RECHTE');
  assert.equal((await anfrage(port, 'GET', '/api/chat/turn')).status, 401);
  const f = new Browser(port); await f.anmelden('fabian', 'geheim123');
  assert.deepEqual((await f.get('/api/chat/turn')).json.ergebnis, { aktiv: true, port: dienst.turn.stand().port, lan_ip: '127.0.0.1', zuteilungen: 0, extern_zuletzt: null, fehler: null });
});

test('STUN-Binding am echten Dienst; Zugangsdaten aus /api/chat/ice gelten für Allocate', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const r = (await b.get('/api/chat/ice')).json.ergebnis;
  const k = await turnKlient(dienst.turn.stand().port);
  try {
    assert.equal((await k.anfrage(METHODE.binding)).klasse, KLASSE.erfolg);
    const s = await k.allocate({ username: r.ice_server[0].username, credential: r.ice_server[0].credential });
    assert.equal(s.antwort.klasse, KLASSE.erfolg);
    assert.equal(s.relay.ip, '127.0.0.1'); assert.ok(s.relay.port >= 47830 && s.relay.port <= 47835);
    assert.equal(dienst.turn.stand().zuteilungen, 1);
  } finally { await k.schliessen(); }
});

test('Ende zu Ende über den WebSocket: Stand an Nicht-Teilnehmer, Signal nur an den Adressaten', async () => {
  const f = new Browser(port); await f.anmelden('fabian', 'geheim123');
  const t = await tina();
  const fw = await wsVerbinden(port, '/api/chat/ws', { cookie: f.kopf().cookie });
  const tw = await wsVerbinden(port, '/api/chat/ws', { cookie: t.kopf().cookie });
  const gw = await wsVerbinden(port, '/api/chat/ws', { cookie: GAST_KEKS });
  try {
    fw.senden({ art: 'anruf.beitreten', raum: R, video: false });
    const fid = (await fw.naechste((m) => m.art === 'anruf.beigetreten')).id;
    tw.senden({ art: 'anruf.beitreten', raum: R, video: true });
    const tid = (await tw.naechste((m) => m.art === 'anruf.beigetreten')).id;
    const st = await gw.naechste((m) => m.art === 'anruf.stand' && m.teilnehmer.length === 2);
    assert.deepEqual(st.teilnehmer.map((x) => [x.name, x.gast, x.ich]), [['Fabian H.', false, false], ['Tina', false, false]]);
    assert.ok(st.teilnehmer.every((x) => !('nutzer' in x)), 'Gäste erfahren keine Login-Namen (auch nicht für Avatare)');
    // Mitglieder bekommen den Login-Namen dazu – für das Avatar-Bild in der Kachel (0.22.0)
    const tst = await tw.naechste((m) => m.art === 'anruf.stand' && m.teilnehmer.length === 2);
    assert.deepEqual(tst.teilnehmer.map((x) => [x.nutzer, x.ich]), [['fabian', false], ['tina', true]]);
    fw.senden({ art: 'anruf.signal', raum: R, an: tid, daten: { kandidat: null } });
    assert.deepEqual(await tw.naechste((m) => m.art === 'anruf.signal'), { art: 'anruf.signal', raum: R, von: fid, daten: { kandidat: null } });
    await assert.rejects(gw.naechste((m) => m.art === 'anruf.signal', 200));
    fw.schliessen();
    // (Tina sah vorher schon einen Stand mit nur Fabian – gesucht ist der Stand ohne Fabian)
    const nach = await tw.naechste((m) => m.art === 'anruf.stand' && m.teilnehmer.length === 1 && m.teilnehmer[0].id === tid);
    assert.equal(nach.teilnehmer[0].ich, true);
  } finally { tw.schliessen(); gw.schliessen(); }
});

test('konfig chat mit aktiv:false stoppt TURN, ICE wird leer', async () => {
  turnInfo = { ...turnInfo, aktiv: false };
  a.ereignis({ ereignis: 'konfig', bereich: 'chat' });
  assert.ok(await bis(() => dienst.turn.stand().aktiv === false), 'TURN aus');
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  assert.deepEqual((await b.get('/api/chat/ice')).json.ergebnis, { ice_server: [], gueltig_bis: null });
});
