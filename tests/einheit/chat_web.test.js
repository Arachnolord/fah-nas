// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Dienst im Web (Plan 02, Aufgabe 11): WebSocket /api/chat/ws für NAS-Nutzer (Sitzung) und Gäste (Keks),
// Freigabelisten, aktiv/ausweis setzt der Server, Verteilung nur an Empfänger, Schließcodes, Bremse, Anruf-Haken.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, warte, standardAttrappe, dienstStarten, Browser } from './web_hilfen.js';
import { wsVerbinden } from './ws_hilfen.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const R = 'rAAAAAAAAAAAAAAAA';
const GID = 'gBBBBBBBBBBBBBBBB';
const GEHEIM = 'G'.repeat(43);
let a; let dienst; let port; let pruefenErlaubt;

beforeEach(async () => {
  a = await standardAttrappe(await tmp());
  pruefenErlaubt = true;
  a.aktion('chat.uebersicht', { rolle: 'nutzer', fn: () => ({ raeume: [] }) });
  a.aktion('chat.senden', { rolle: 'nutzer', fn: (p) => ({ nachricht: { id: 'n1', text: p.text } }) });
  a.aktion('chat.empfaenger', { rolle: 'nutzer', fn: () => ({ nutzer: ['fabian', 'tina'], gaeste: [] }) });
  a.aktion('system.status', { rolle: 'nutzer', fn: () => ({}) });
  a.aktion('chat.gast.pruefen', { rolle: 'gast', fn: (p) => {
    if (!pruefenErlaubt || !p.ausweis || p.ausweis.id !== GID || p.ausweis.geheimnis !== GEHEIM) throw new FahnasFehler('E_RECHTE', 'Gastzugang ungültig');
    return { raum: R, raum_name: 'Team', name: 'Gustav', gast: GID };
  } });
  a.aktion('chat.gast.verlauf', { rolle: 'gast', fn: () => ({ nachrichten: [], mehr: false }) });
  a.aktion('chat.gast.senden', { rolle: 'gast', fn: (p) => ({ nachricht: { id: 'n2', text: p.text } }) });
  a.aktion('chat.gast.empfaenger', { rolle: 'gast', fn: () => ({ nutzer: ['fabian'], gaeste: [GID] }) });
  ({ dienst, port } = await dienstStarten(a, { heartbeat_ms: 50 }));
});
afterEach(async () => { await dienst.stoppen(); await a.stoppen(); });

async function nutzerSocket(name = 'fabian', pw = 'geheim123') {
  const b = new Browser(port); await b.anmelden(name, pw);
  if (name === 'tina') await b.post('/api/anmelden/totp', { code: '123456' });
  const c = await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie });
  return { b, c };
}
const gastSocket = () => wsVerbinden(port, '/api/chat/ws', { cookie: `fahnas_chatgast=${GID}.${GEHEIM}` });

test('Upgrade: ohne Identität 401, fremde Herkunft 403, Sitzung 101 + online', async () => {
  assert.equal((await wsVerbinden(port, '/api/chat/ws')).status, 401);
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  assert.equal((await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie, origin: 'https://boese.example' })).status, 403);
  assert.equal((await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie, origin: null })).status, 403);
  const c = await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie });
  assert.equal(c.status, 101);
  assert.deepEqual(await c.naechste((m) => m.art === 'online'), { art: 'online', nutzer: ['fabian'] });
  assert.equal((await wsVerbinden(port, '/api/chat/ws', { cookie: `fahnas_chatgast=${GID}.${'x'.repeat(43)}` })).status, 401);
  c.schliessen();
});

test('offene 2FA (Zugriff aus dem Internet) → 401', async () => {
  await dienst.stoppen(); await a.stoppen();
  a = await standardAttrappe(await tmp());
  ({ dienst, port } = await dienstStarten(a, { anmeldeschutz: { extern: () => true } }));
  const b = new Browser(port); await b.anmelden('tina', 'tina1234');
  assert.equal((await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie })).status, 401);
});

test('Nutzer: nur freigegebene Aktionen; aktiv setzt der Server', async () => {
  const { c } = await nutzerSocket();
  c.senden({ art: 'aufruf', id: '1', aktion: 'system.status', params: {} });
  const f = await c.naechste((m) => m.id === '1');
  assert.equal(f.ok, false); assert.equal(f.fehler.code, 'E_RECHTE');
  assert.ok(!a.anfragen.some((x) => x.aktion === 'system.status'));
  c.senden({ art: 'sichtbar', ja: true });
  c.senden({ art: 'aufruf', id: '2', aktion: 'chat.senden', params: { raum: R, text: 'x', aktiv: ['niemand'] } });
  const ok = await c.naechste((m) => m.id === '2');
  assert.deepEqual(ok, { art: 'antwort', id: '2', ok: true, ergebnis: { nachricht: { id: 'n1', text: 'x' } } });
  const anfrage = a.anfragen.findLast((x) => x.aktion === 'chat.senden');
  assert.deepEqual(anfrage.params.aktiv, ['fabian']);
  assert.equal(anfrage.kontext.nutzer, 'fabian'); assert.equal(anfrage.kontext.rolle, 'admin');
  // kaputte Hülle → Fehler, Socket bleibt offen
  c.senden({ art: 'aufruf', id: 5, aktion: 'chat.senden' });
  assert.equal((await c.naechste((m) => m.art === 'fehler')).fehler.code, 'E_PARAMS');
  c.senden({ art: 'aufruf', id: '3', aktion: 'chat.uebersicht', params: {} });
  assert.equal((await c.naechste((m) => m.id === '3')).ok, true);
});

test('Gast darf nur abgebildete Aktionen, Ausweis setzt der Server', async () => {
  const g = await gastSocket();
  assert.equal(g.status, 101);
  g.senden({ art: 'aufruf', id: '1', aktion: 'chat.verlauf', params: { raum: R } });
  assert.equal((await g.naechste((m) => m.id === '1')).ok, true);
  const anf = a.anfragen.findLast((x) => x.aktion === 'chat.gast.verlauf');
  assert.deepEqual(anf.params, { raum: R, ausweis: { id: GID, geheimnis: GEHEIM } });
  assert.equal(anf.kontext.rolle, 'gast');
  g.senden({ art: 'aufruf', id: '2', aktion: 'chat.raum.mitglieder', params: { raum: R, hinzu: ['x'] } });
  assert.equal((await g.naechste((m) => m.id === '2')).fehler.code, 'E_RECHTE');
  g.senden({ art: 'aufruf', id: '3', aktion: 'chat.gast.verlauf', params: { raum: R, ausweis: { id: 'gCCCCCCCCCCCCCCCC', geheimnis: 'x'.repeat(43) } } });
  assert.equal((await g.naechste((m) => m.id === '3')).fehler.code, 'E_RECHTE', 'Gäste dürfen keine Gast-Aktionen mit fremdem Ausweis schicken');
  assert.equal(await g.naechste((m) => m.art === 'online', 200).catch(() => null), null, 'Gäste bekommen keine Online-Liste');
});

test('Verteiler: nur an genannte Empfänger, Gäste bekommen daten_gast', async () => {
  const { c } = await nutzerSocket('fabian');
  const { c: t } = await nutzerSocket('tina', 'tina1234');
  const g = await gastSocket();
  await warte(50);
  a.ereignis({ ereignis: 'chat', raum: R, art: 'nachricht', daten: { id: 'n1', von: 'fabian' }, daten_gast: { id: 'n1', von: null }, an: { nutzer: ['fabian'], gaeste: [GID] } });
  assert.deepEqual(await c.naechste((m) => m.art === 'chat'), { art: 'chat', raum: R, ereignis: 'nachricht', daten: { id: 'n1', von: 'fabian' } });
  assert.deepEqual((await g.naechste((m) => m.art === 'chat')).daten, { id: 'n1', von: null });
  assert.equal(await t.naechste((m) => m.art === 'chat', 200).catch(() => null), null, 'tina ist kein Empfänger');
});

test('gast_entfernt schließt mit 4003 und verwirft den Zwischenspeicher; raum_weg ebenso', async () => {
  const g = await gastSocket();
  pruefenErlaubt = false;
  a.ereignis({ ereignis: 'chat', raum: R, art: 'gast_entfernt', daten: { gast: GID }, an: { nutzer: ['fabian'], gaeste: [GID] } });
  assert.equal((await g.zu).code, 4003);
  assert.equal((await gastSocket()).status, 401);
  pruefenErlaubt = true;
  const g2 = await gastSocket();
  a.ereignis({ ereignis: 'chat', raum: R, art: 'raum_weg', daten: { raum: R }, an: { nutzer: ['fabian'], gaeste: [GID] } });
  assert.equal((await g2.zu).code, 4003);
});

test('TURN-Zugang weg: entfernter Gast, gesperrter oder gelöschter Nutzer (Prüfbericht Plan 03, I6)', async () => {
  const gesperrt = [];
  dienst.turn.sperren = (wer) => gesperrt.push(wer);
  a.ereignis({ ereignis: 'chat', raum: R, art: 'gast_entfernt', daten: { gast: GID }, an: { nutzer: ['fabian'], gaeste: [GID] } });
  const { b } = await nutzerSocket('tina', 'tina1234');
  void b;
  dienst.sitzungen.loescheNutzer('tina', undefined, 'gesperrt');
  dienst.sitzungen.loescheNutzer('fabian', undefined, 'beendet');
  await warte(20);
  assert.deepEqual(gesperrt, [`gast-${GID}`, 'tina'], 'nur Sperre/Löschung, nicht normales Abmelden');
});

test('raum_weg beim Austritt eines Mitglieds lässt verbundene Gäste im Raum (Prüfbericht Plan 02, Befund 3)', async () => {
  const g = await gastSocket();
  await warte(50);
  a.ereignis({ ereignis: 'chat', raum: R, art: 'raum_weg', daten: { raum: R }, an: { nutzer: ['tina'], gaeste: [] }, teil: true });
  assert.equal(await Promise.race([g.zu.then((x) => x.code), warte(300).then(() => 'offen')]), 'offen');
  a.ereignis({ ereignis: 'chat', raum: R, art: 'nachricht', daten: { id: 'n9' }, daten_gast: { id: 'n9' }, an: { nutzer: [], gaeste: [GID] } });
  assert.equal((await g.naechste((m) => m.art === 'chat')).daten.id, 'n9');
});

test('tippt: höchstens eins je 2 s und Verbindung (auch mit erfundenen Räumen); Gäste nur im eigenen Raum (Befund 8)', async () => {
  let abfragen = 0; let gastAbfragen = 0;
  a.aktion('chat.empfaenger', { rolle: 'nutzer', fn: () => { abfragen++; return { nutzer: ['fabian', 'tina'], gaeste: [] }; } });
  a.aktion('chat.gast.empfaenger', { rolle: 'gast', fn: () => { gastAbfragen++; return { nutzer: ['fabian'], gaeste: [GID] }; } });
  const { c } = await nutzerSocket('fabian');
  await warte(50);
  for (let i = 0; i < 20; i++) c.senden({ art: 'tippt', raum: `r${String(i).padStart(16, 'A')}` });
  await warte(200);
  assert.equal(abfragen, 1, 'nur das erste tippt fragt den Agenten');
  const g = await gastSocket();
  await warte(50);
  g.senden({ art: 'tippt', raum: 'rZZZZZZZZZZZZZZZZ' });
  await warte(150);
  assert.equal(gastAbfragen, 0, 'fremder Raum: keine Abfrage');
});

test('tippt an Gäste: Mitglied ohne Anzeigenamen erscheint als „Mitglied“, nie mit Login-Namen (Befund 11)', async () => {
  a.nutzer.otto = { passwort: 'otto12345', rolle: 'nutzer', totp: false };
  a.aktion('chat.empfaenger', { rolle: 'nutzer', fn: () => ({ nutzer: ['otto'], gaeste: [GID] }) });
  const g = await gastSocket();
  const { c } = await nutzerSocket('otto', 'otto12345');
  await warte(50);
  c.senden({ art: 'tippt', raum: R });
  assert.deepEqual(await g.naechste((m) => m.art === 'tippt'), { art: 'tippt', raum: R, wer: null, name: 'Mitglied' });
});

test('Nachrichtenflut: mehr als 200 Nachrichten in 10 s → 1008 (Befund 8)', async () => {
  const g = await gastSocket();
  await warte(50);
  for (let i = 0; i < 205; i++) g.senden({ art: 'sichtbar', ja: i % 2 === 0 });
  assert.equal((await Promise.race([g.zu, warte(1000).then(() => ({ code: 'offen' }))])).code, 1008);
});

test('tippt geht an die Raum-Empfänger außer dem Absender; Abmelden → 4001; stoppen → 1001', async () => {
  const { b, c } = await nutzerSocket('fabian');
  const { c: t } = await nutzerSocket('tina', 'tina1234');
  await warte(50);
  c.senden({ art: 'tippt', raum: R });
  assert.deepEqual(await t.naechste((m) => m.art === 'tippt'), { art: 'tippt', raum: R, wer: 'fabian', name: 'Fabian H.' });
  assert.equal(await c.naechste((m) => m.art === 'tippt', 200).catch(() => null), null);
  await b.post('/api/abmelden', {});
  assert.equal((await c.zu).code, 4001);
  await dienst.stoppen();
  assert.equal((await t.zu).code, 1001);
});

test('Bremse: 51. Aufruf in 10 s → E_BREMSE; 11. Socket desselben Nutzers → 429', async () => {
  const { b, c } = await nutzerSocket('fabian');
  for (let i = 0; i < 50; i++) c.senden({ art: 'aufruf', id: `a${i}`, aktion: 'chat.uebersicht', params: {} });
  for (let i = 0; i < 50; i++) assert.equal((await c.naechste((m) => m.id === `a${i}`)).ok, true);
  c.senden({ art: 'aufruf', id: 'zuviel', aktion: 'chat.uebersicht', params: {} });
  const f = await c.naechste((m) => m.id === 'zuviel');
  assert.equal(f.fehler.code, 'E_BREMSE'); assert.ok(f.fehler.details.warte_s > 0);
  const weitere = [];
  for (let i = 0; i < 9; i++) weitere.push(await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie }));
  assert.ok(weitere.every((x) => x.status === 101));
  assert.equal((await wsVerbinden(port, '/api/chat/ws', { cookie: b.kopf().cookie })).status, 429);
});

test('handler: anruf.* erreicht den Haken, andere unbekannte Arten → {art:"fehler"}', async () => {
  dienst.chat.handler('anruf.test', (v, n) => { v.ws.senden({ art: 'anruf.ok', wer: v.identitaet.nutzer, x: n.x }); });
  assert.throws(() => dienst.chat.handler('xyz', () => {}));
  const { c } = await nutzerSocket('fabian');
  c.senden({ art: 'anruf.test', x: 1 });
  assert.deepEqual(await c.naechste((m) => m.art === 'anruf.ok'), { art: 'anruf.ok', wer: 'fabian', x: 1 });
  c.senden({ art: 'xyz' });
  assert.equal((await c.naechste((m) => m.art === 'fehler')).fehler.code, 'E_PARAMS');
  c.senden({ art: 'anruf.unbekannt' });
  assert.equal((await c.naechste((m) => m.art === 'fehler' && m !== null, 2000)).fehler.code, 'E_PARAMS');
});

test('chat.personen ist über den WebSocket erlaubt (DM- und Mitgliederwahl)', async () => {
  const { NUTZER_AKTIONEN } = await import('../../src/web/chat/dienst.js');
  assert.ok(NUTZER_AKTIONEN.has('chat.personen'));
});
