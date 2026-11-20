// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Nachrichten (Plan 02, Aufgabe 5): senden, bearbeiten, löschen, Reaktionen, Lesestand, Suche, Handy-Meldungen,
// Prüfprotokoll ohne Inhalte.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatUmgebung } from './chat_hilfen.js';
import { _test as ablageTest } from '../../src/agent/chat/ablage.js';
import { _test as raeumeTest } from '../../src/agent/chat/raeume.js';
import { _test as verlaufTest } from '../../src/agent/chat/verlauf.js';
import { kurz } from '../../src/agent/chat/nachrichten.js';
import * as chat from '../../src/agent/aktionen/chat.js';
import { Agent } from '../../src/agent/agent.js';
import { PFADE } from '../../src/gemeinsam/pfade.js';

let e; let raum;
const ruhe = () => new Promise((r) => setTimeout(r, 50));
beforeEach(async () => {
  ablageTest.zuruecksetzen(); raeumeTest.zuruecksetzen(); verlaufTest.zuruecksetzen();
  e = await chatUmgebung();
  ({ raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] }));
});
afterEach(async () => { await e.aufraeumen(); });
const raumJson = async () => JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));

test('kurz: Leerraum zusammengefasst, über max gekürzt', () => {
  assert.equal(kurz('  a \n b  '), 'a b');
  assert.equal(kurz('x'.repeat(81)), `${'x'.repeat(79)}…`);
  assert.equal(kurz('x'.repeat(80)), 'x'.repeat(80));
});

test('senden: Ereignis an Mitglieder mit Ansicht, Verlauf, letzte und ungelesen in raum.json', async () => {
  const { nachricht } = await e.als('anna')('chat.senden', { raum, text: 'Hallo **Team**' });
  assert.match(nachricht.id, /^n[0-9a-z]{15}$/);
  assert.deepEqual([nachricht.von, nachricht.von_name, nachricht.gast, nachricht.text], ['anna', 'Anna A.', false, 'Hallo **Team**']);
  const ev = e.ereignisse().find((x) => x.art === 'nachricht');
  assert.equal(ev.daten.id, nachricht.id); assert.deepEqual(ev.an.nutzer, ['anna', 'ben']);
  assert.equal(ev.daten_gast.von, null, 'Gäste sehen keine Login-Namen');
  const r = await raumJson();
  assert.equal(r.mitglieder.ben.ungelesen, 1); assert.equal(r.mitglieder.anna.ungelesen, 0);
  assert.deepEqual(r.letzte, { id: nachricht.id, zeit: nachricht.zeit, von: 'anna', kurz: 'Hallo **Team**' });
  const v = await e.als('ben')('chat.verlauf', { raum });
  assert.deepEqual(v.nachrichten.map((n) => n.id), [nachricht.id]); assert.equal(v.mehr, false);
  assert.deepEqual(v.gelesen, { anna: null, ben: null });
  const u = (await e.als('ben')('chat.uebersicht', {})).raeume[0];
  assert.equal(u.ungelesen, 1); assert.equal(u.letzte.von_name, 'Anna A.'); assert.equal(u.letzte.kurz, 'Hallo **Team**');
});

test('Grenzen: leerer Text ohne Anhang, 10001 Zeichen, unbekannte Antwort, nur Mitglieder', async () => {
  await assert.rejects(e.als('anna')('chat.senden', { raum, text: '   ' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'text');
  await assert.rejects(e.als('anna')('chat.senden', { raum, text: 'x'.repeat(10001) }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.senden', { raum, text: 'a', antwort: 'n000000000zzzzzz' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'antwort');
  await assert.rejects(e.als('cara')('chat.senden', { raum, text: 'a' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('cara')('chat.verlauf', { raum }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Antwort zeigt Zitat der ursprünglichen Nachricht', async () => {
  const { nachricht: a } = await e.als('anna')('chat.senden', { raum, text: 'Frage?' });
  const { nachricht: b } = await e.als('ben')('chat.senden', { raum, text: 'Antwort', antwort: a.id });
  assert.deepEqual(b.antwort, { id: a.id, von_name: 'Anna A.', kurz: 'Frage?' });
});

test('bearbeiten nur eigene, löschen eigene oder als Verwalter, Platzhalter bleibt', async () => {
  const { nachricht: a } = await e.als('anna')('chat.senden', { raum, text: 'eins' });
  const { nachricht: b } = await e.als('ben')('chat.senden', { raum, text: 'zwei' });
  await assert.rejects(e.als('ben')('chat.bearbeiten', { raum, nachricht: a.id, text: 'x' }), (f) => f.code === 'E_RECHTE');
  const ba = await e.als('anna')('chat.bearbeiten', { raum, nachricht: a.id, text: 'eins!' });
  assert.equal(ba.nachricht.text, 'eins!'); assert.ok(ba.nachricht.bearbeitet);
  const evB = e.ereignisse().find((x) => x.art === 'bearbeitet');
  assert.deepEqual(Object.keys(evB.daten).sort(), ['bearbeitet', 'id', 'text']);
  await assert.rejects(e.als('ben')('chat.loeschen', { raum, nachricht: a.id }), (f) => f.code === 'E_RECHTE');
  assert.deepEqual(await e.als('anna')('chat.loeschen', { raum, nachricht: b.id }), { geloescht: true });
  const v = await e.als('anna')('chat.verlauf', { raum });
  const geloescht = v.nachrichten.find((n) => n.id === b.id);
  assert.ok(geloescht.geloescht); assert.equal(geloescht.text, '');
  assert.deepEqual(e.ereignisse().find((x) => x.art === 'geloescht').daten, { id: b.id });
  await assert.rejects(e.als('ben')('chat.bearbeiten', { raum, nachricht: b.id, text: 'wieder' }), (f) => f.code === 'E_PARAMS' || f.code === 'E_RECHTE');
});

test('Löschen senkt ungelesen und setzt letzte neu', async () => {
  const { nachricht: a } = await e.als('anna')('chat.senden', { raum, text: 'eins' });
  const { nachricht: b } = await e.als('anna')('chat.senden', { raum, text: 'zwei' });
  assert.equal((await raumJson()).mitglieder.ben.ungelesen, 2);
  await e.als('anna')('chat.loeschen', { raum, nachricht: b.id });
  const r = await raumJson();
  assert.equal(r.mitglieder.ben.ungelesen, 1);
  assert.equal(r.letzte.id, a.id);
});

test('Reaktion an/aus, nur Mitglieder, Emoji ≤ 16 Zeichen', async () => {
  const { nachricht: a } = await e.als('anna')('chat.senden', { raum, text: 'eins' });
  assert.deepEqual(await e.als('ben')('chat.reaktion', { raum, nachricht: a.id, emoji: '👍', an: true }), { reaktionen: { '👍': ['ben'] } });
  assert.deepEqual(await e.als('ben')('chat.reaktion', { raum, nachricht: a.id, emoji: '👍', an: false }), { reaktionen: {} });
  await assert.rejects(e.als('ben')('chat.reaktion', { raum, nachricht: a.id, emoji: 'x'.repeat(17), an: true }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('cara')('chat.reaktion', { raum, nachricht: a.id, emoji: '👍', an: true }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('gelesen: setzt Lesestand, zählt ungelesen neu, Ereignis nur an NAS-Mitglieder', async () => {
  const ids = [];
  for (const t of ['a', 'b', 'c']) ids.push((await e.als('anna')('chat.senden', { raum, text: t })).nachricht.id);
  assert.deepEqual(await e.als('ben')('chat.gelesen', { raum, bis: ids[1] }), { ungelesen: 1 });
  assert.equal((await e.als('anna')('chat.verlauf', { raum })).gelesen.ben, ids[1]);
  const ev = e.ereignisse().find((x) => x.art === 'gelesen');
  assert.deepEqual(ev.daten, { wer: 'ben', bis: ids[1] }); assert.deepEqual(ev.an.gaeste, []);
  // älterer Stand senkt nicht
  assert.deepEqual(await e.als('ben')('chat.gelesen', { raum, bis: ids[0] }), { ungelesen: 1 });
});

test('Suche im Raum, neueste zuerst, nur Mitglieder', async () => {
  await e.als('anna')('chat.senden', { raum, text: 'Team-Treffen' });
  await e.als('ben')('chat.senden', { raum, text: 'Ein anderes TEAM' });
  const t = await e.als('ben')('chat.suche', { raum, text: 'tea' });
  assert.deepEqual(t.treffer.map((n) => n.text), ['Ein anderes TEAM', 'Team-Treffen']);
  await assert.rejects(e.als('ben')('chat.suche', { raum, text: 'a' }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('cara')('chat.suche', { raum, text: 'tea' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Push-Regeln: nicht an Absender, nicht an aktive, nicht in stummen Räumen, nie mit Inhalt', async () => {
  await e.als('anna')('chat.raum.mitglieder', { raum, hinzu: ['cara'] });
  await e.u.konfig.aendern('users.json', (d) => { d.nutzer.find((n) => n.name === 'ben').einstellungen = { chat: { stumm: [raum] } }; return d; });
  await e.als('anna')('chat.senden', { raum, text: 'GEHEIMTEXT eins', aktiv: ['cara'] });
  await ruhe();
  assert.deepEqual(e.push, []);
  await e.als('anna')('chat.senden', { raum, text: 'GEHEIMTEXT zwei' });
  await ruhe();
  assert.deepEqual(e.push, [{ nutzer: 'cara', titel: 'Team', text: 'Anna A.: neue Nachricht', schluessel: `chat:${raum}:cara` }]);
  await e.u.konfig.speichern('web/link-adresse.json', { adresse: 'https://nas.example' });
  await e.als('ben')('chat.senden', { raum, text: 'GEHEIMTEXT drei' });
  await ruhe();
  const anCara = e.push.filter((p) => p.nutzer === 'cara').at(-1);
  assert.equal(anCara.klick, `https://nas.example/#/chat/${raum}`);
  const { raum: dm } = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' });
  await e.als('anna')('chat.senden', { raum: dm, text: 'GEHEIMTEXT vier' });
  await ruhe();
  assert.equal(e.push.at(-1).titel, 'Anna A.');
  assert.equal(e.push.at(-1).nutzer, 'ben');
  assert.equal(JSON.stringify(e.push).includes('GEHEIMTEXT'), false);
});

test('Prüfprotokoll: senden/bearbeiten/reaktion/gelesen still, suche ohne Text (echter Agent)', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-a-chataudit-'));
  const agent = new Agent({ konfigOrdner: path.join(w, 'config'), socketPfad: path.join(w, 'a.sock'), datenSocket: path.join(w, 'd.sock'), hintergrund: false });
  agent.werkzeuge.pfade = { ...PFADE, konfig: path.join(w, 'config'), chat: path.join(w, 'chat'), daten: w };
  agent.werkzeuge.persoenlichSenden = async () => true;
  await agent.konfig.sicherstellen();
  await agent.konfig.speichern('users.json', { nutzer: [{ name: 'anna', rolle: 'nutzer' }, { name: 'ben', rolle: 'nutzer' }], gruppen: [] });
  chat.registriere(agent.register, agent.werkzeuge);
  const k = { nutzer: 'anna', rolle: 'nutzer', ip: '-' };
  const alt = process.stderr.write; process.stderr.write = () => true;
  try {
    const { raum: r } = (await agent.ausfuehren('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] }, k)).ergebnis;
    const { nachricht } = (await agent.ausfuehren('chat.senden', { raum: r, text: 'GEHEIMTEXT' }, k)).ergebnis;
    await agent.ausfuehren('chat.bearbeiten', { raum: r, nachricht: nachricht.id, text: 'GEHEIMTEXT2' }, k);
    await agent.ausfuehren('chat.suche', { raum: r, text: 'GEHEIMTEXT' }, k);
    await assert.rejects(agent.ausfuehren('chat.senden', { raum: r, text: 'GEHEIMTEXT'.repeat(2000) }, k));
    await agent.audit.kette;
    const roh = JSON.stringify((await agent.audit.lesen({ je_seite: 500 })).eintraege);
    assert.ok(!roh.includes('GEHEIMTEXT'));
    assert.ok(roh.includes('chat.raum.anlegen'));
  } finally { process.stderr.write = alt; await fs.rm(w, { recursive: true, force: true }); }
});
