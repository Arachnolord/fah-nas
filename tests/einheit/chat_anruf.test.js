// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufe im Agenten (Plan 03, Aufgabe 6): Beginn (Handy-Meldung an Abwesende, nicht stumm, ohne Inhalt), Ende
// (Systemnotiz mit Dauer), Verpasst (nur DMs), Rechte, Gäste, TURN-Auskunft, Audit und Export.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatUmgebung } from './chat_hilfen.js';
import { _test as ablageTest } from '../../src/agent/chat/ablage.js';
import { _test as raeumeTest } from '../../src/agent/chat/raeume.js';
import { AUSSCHLUSS } from '../../src/agent/export.js';

let e; let raum; let dm; let anderer;
beforeEach(async () => {
  ablageTest.zuruecksetzen(); raeumeTest.zuruecksetzen();
  e = await chatUmgebung();
  ({ raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben', 'cara'] }));
  ({ raum: anderer } = await e.als('ben')('chat.raum.anlegen', { name: 'Anders', mitglieder: [] }));
  ({ raum: dm } = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' }));
  const users = await e.u.konfig.laden('users.json');
  users.nutzer.find((n) => n.name === 'ben').einstellungen = { chat: { stumm: [raum] } };
  await e.u.konfig.speichern('users.json', users);
});
afterEach(async () => { await e.aufraeumen(); });

test('beginn: Push an Mitglieder ohne Verbindung, nicht an Anrufer, nicht stumm, ohne Inhalt', async () => {
  assert.deepEqual(await e.als('anna')('chat.anruf', { raum, art: 'beginn', video: true, aktiv: ['cara'] }), { benachrichtigt: [] });
  const vorher = e.ereignisse().filter((x) => x.art === 'nachricht').length;
  const r = await e.als('anna')('chat.anruf', { raum, art: 'beginn', video: true });
  assert.deepEqual(r, { benachrichtigt: ['cara'] });
  assert.deepEqual(e.push.at(-1), { nutzer: 'cara', titel: 'Team', text: 'Anna A. ruft an', schluessel: `anruf:${raum}:cara` });
  assert.equal(e.ereignisse().filter((x) => x.art === 'nachricht').length, vorher, 'Beginn schreibt keine Notiz');
});

test('beginn in der DM: Titel ist der Anrufer', async () => {
  assert.deepEqual(await e.als('anna')('chat.anruf', { raum: dm, art: 'beginn' }), { benachrichtigt: ['ben'] });
  assert.deepEqual(e.push.at(-1), { nutzer: 'ben', titel: 'Anna A.', text: 'Anna A. ruft an', schluessel: `anruf:${dm}:ben` });
});

test('ende: Systemnotiz anruf_ende mit Dauer, Ereignis nachricht, kein Push', async () => {
  const vorher = e.push.length;
  const { nachricht } = await e.als('ben')('chat.anruf', { raum, art: 'ende', video: true, dauer_s: 125 });
  assert.equal(nachricht.system.art, 'anruf_ende'); assert.deepEqual(nachricht.system.daten, { dauer_s: 125, video: true });
  assert.equal(e.ereignisse().findLast((x) => x.art === 'nachricht').daten.id, nachricht.id);
  assert.equal(e.push.length, vorher);
});

test('verpasst: nur in DMs; Notiz mit Anrufer, Push an den anderen', async () => {
  const { nachricht } = await e.als('anna')('chat.anruf', { raum: dm, art: 'verpasst', aktiv: ['ben'] }); // aktiv zählt bei verpasst nicht
  assert.equal(nachricht.system.art, 'anruf_verpasst'); assert.equal(nachricht.system.wer_name, 'Anna A.');
  assert.deepEqual(e.push.at(-1), { nutzer: 'ben', titel: 'Anna A.', text: 'Verpasster Anruf von Anna A.', schluessel: `anruf_verpasst:${dm}:ben` });
  await assert.rejects(e.als('anna')('chat.anruf', { raum, art: 'verpasst' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'art');
});

test('Rechte und Grenzen', async () => {
  await assert.rejects(e.als('cara')('chat.anruf', { raum: dm, art: 'beginn' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('anna')('chat.anruf', { raum, art: 'ende', dauer_s: 86_401 }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.anruf', { raum, art: 'klingeln' }), (f) => f.code === 'E_PARAMS');
});

test('Gast: eigener Raum ja, fremder nein, verpasst nie', async () => {
  const { token } = await e.als('anna')('chat.einladung.anlegen', { raum, gueltig_h: 24 });
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const r = await e.gast('chat.gast.anruf', { ausweis, raum, art: 'beginn' });
  assert.deepEqual(r, { benachrichtigt: ['anna', 'cara'] });
  assert.deepEqual(e.push.at(-1), { nutzer: 'cara', titel: 'Team', text: 'Gustav ruft an', schluessel: `anruf:${raum}:cara` });
  await assert.rejects(e.gast('chat.gast.anruf', { ausweis, raum: anderer, art: 'beginn' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.gast('chat.gast.anruf', { ausweis, raum, art: 'verpasst' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'art');
  const { nachricht } = await e.gast('chat.gast.anruf', { ausweis, raum, art: 'ende', dauer_s: 3 });
  assert.equal(nachricht.system.art, 'anruf_ende');
});

test('turn_info: LAN-IP, Standard an, folgt den Einstellungen', async () => {
  e.w.nasNetz = async () => ({ ip: '192.168.1.29', gateway: '192.168.1.1' });
  assert.deepEqual(await e.gast('chat.turn_info', {}), { lan_ip: '192.168.1.29', aktiv: true, port: 3478 });
  await e.als('chef', 'admin')('chat.einstellungen.setzen', { turn: { aktiv: false, port: 3479 } });
  assert.deepEqual(await e.gast('chat.turn_info', {}), { lan_ip: '192.168.1.29', aktiv: false, port: 3479 });
  e.w.nasNetz = async () => { throw new Error('kein Netz'); };
  assert.equal((await e.gast('chat.turn_info', {})).lan_ip, null);
});

test('Audit still, Export ohne turn.json', () => {
  assert.equal(e.u.reg.hole('chat.anruf').audit, false); assert.equal(e.u.reg.hole('chat.gast.anruf').audit, false);
  assert.ok(AUSSCHLUSS.includes('web/turn.json'));
});
