// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Räume (Plan 02, Aufgabe 4): Anlegen, Übersicht nur eigener Räume, Mitglieder/Verwalter-Regeln, DMs, Löschen
// durch Admins ohne Inhalte, Chat-Einstellungen (chat.json 0600), Audit ohne Beschreibung.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chatUmgebung } from './chat_hilfen.js';
import { dmId, _test as ablageTest } from '../../src/agent/chat/ablage.js';
import { _test as raeumeTest } from '../../src/agent/chat/raeume.js';

let e;
beforeEach(async () => { ablageTest.zuruecksetzen(); raeumeTest.zuruecksetzen(); e = await chatUmgebung(); });
afterEach(async () => { await e.aufraeumen(); });

const existiert = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

test('anlegen: Ersteller ist Mitglied und Verwalter, unbekannte Mitglieder → E_PARAMS, Ereignis an alle', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  const r = JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));
  assert.deepEqual(Object.keys(r.mitglieder).sort(), ['anna', 'ben']); assert.deepEqual(r.verwalter, ['anna']); assert.equal(r.art, 'raum');
  assert.equal((await fs.stat(path.join(e.chat, 'raeume', raum, 'raum.json'))).mode & 0o777, 0o600);
  await assert.rejects(e.als('anna')('chat.raum.anlegen', { name: 'X', mitglieder: ['niemand'] }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'mitglieder');
  await assert.rejects(e.als('anna')('chat.raum.anlegen', { name: 'a\u0007b' }), (f) => f.code === 'E_PARAMS');
  const ev = e.ereignisse().find((x) => x.art === 'raum' && x.raum === raum);
  assert.deepEqual(ev.an, { nutzer: ['anna', 'ben'], gaeste: [] });
});

test('übersicht: nur eigene Räume, auch für Admins; DM-Name ist der andere', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  assert.deepEqual((await e.als('chef', 'admin')('chat.uebersicht', {})).raeume, []);
  assert.deepEqual((await e.als('cara')('chat.uebersicht', {})).raeume, []);
  const benSicht = (await e.als('ben')('chat.uebersicht', {})).raeume;
  assert.equal(benSicht.length, 1);
  assert.equal(benSicht[0].id, raum); assert.equal(benSicht[0].name, 'Team'); assert.equal(benSicht[0].verwalter, false);
  assert.deepEqual(benSicht[0].verwaltende, ['anna'], 'wer den Raum verwaltet (Mitglieder-Dialog)');
  assert.deepEqual(benSicht[0].mitglieder.map((m) => [m.name, m.anzeigename]).sort(), [['anna', 'Anna A.'], ['ben', 'Ben']]);
  const dm = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' });
  assert.equal(dm.raum, dmId('anna', 'ben'));
  const dmSicht = (await e.als('ben')('chat.uebersicht', {})).raeume.find((x) => x.art === 'dm');
  assert.equal(dmSicht.name, 'Anna A.');
  assert.equal((await e.als('anna')('chat.uebersicht', {})).raeume.find((x) => x.art === 'dm').name, 'Ben');
});

test('nicht Mitglied → E_NICHT_GEFUNDEN, nicht Verwalter → E_RECHTE', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  await assert.rejects(e.als('cara')('chat.raum.aendern', { raum: raum, name: 'X' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('ben')('chat.raum.aendern', { raum: raum, name: 'X' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('ben')('chat.raum.loeschen', { raum: raum }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('ben')('chat.raum.mitglieder', { raum: raum, hinzu: ['cara'] }), (f) => f.code === 'E_RECHTE');
  const r = await e.als('anna')('chat.raum.aendern', { raum, name: 'Team neu' });
  assert.equal(r.raum, raum);
  assert.equal(JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8')).name, 'Team neu');
});

test('Nutzername „constructor“ ist kein Mitglied aller Räume und reserviert (Prüfbericht Plan 02, Befund 4)', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  await e.als('anna')('chat.senden', { raum, text: 'intern' });
  assert.deepEqual((await e.als('constructor')('chat.uebersicht', {})).raeume, []);
  await assert.rejects(e.als('constructor')('chat.verlauf', { raum }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('constructor')('chat.gelesen', { raum, bis: 'n000000000000000' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('constructor')('chat.empfaenger', { raum }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  const { RESERVIERT } = await import('../../src/agent/aktionen/nutzer.js');
  assert.ok(RESERVIERT.has('constructor'), 'kein neues Konto mit diesem Namen');
});

test('gelöschtes Konto: aus Räumen ausgetragen, Verwalter rückt nach, DM geschlossen; gleichnamiger Nachfolger erbt nichts (Befund 5)', async () => {
  const { nutzerAusChatEntfernen } = await import('../../src/agent/chat/konten.js');
  const { raum } = await e.als('ben')('chat.raum.anlegen', { name: 'Bens Raum', mitglieder: ['anna', 'cara'] });
  const { raum: allein } = await e.als('ben')('chat.raum.anlegen', { name: 'Nur Ben' });
  const { raum: dm } = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' });
  await e.als('ben')('chat.senden', { raum: dm, text: 'GEHEIM an Anna' });
  await e.als('ben')('chat.senden', { raum, text: 'Hallo Team' });
  await e.u.konfig.aendern('users.json', (d) => { d.nutzer = d.nutzer.filter((n) => n.name !== 'ben'); return d; }); // wie nutzer.loeschen
  await nutzerAusChatEntfernen(e.w, 'ben', 'Ben');
  const r = JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));
  assert.deepEqual([Object.keys(r.mitglieder).sort(), r.verwalter], [['anna', 'cara'], ['anna']], 'Verwalter rückt nach (ältestes Mitglied)');
  await assert.rejects(fs.stat(path.join(e.chat, 'raeume', allein)), 'leerer Raum gelöscht');
  const u = (await e.als('anna')('chat.uebersicht', {})).raeume.find((x) => x.id === dm);
  assert.deepEqual([u.name, u.geschlossen], ['Ben', true]);
  await assert.rejects(e.als('anna')('chat.senden', { raum: dm, text: 'x' }), (f) => f.code === 'E_PARAMS');
  assert.ok((await e.als('anna')('chat.verlauf', { raum: dm })).nachrichten.some((n) => n.text === 'GEHEIM an Anna'), 'Verlauf bleibt für Anna lesbar');
  // neues Konto mit demselben Namen
  await e.u.konfig.aendern('users.json', (d) => { d.nutzer.push({ name: 'ben', anzeigename: 'Ben Neu', rolle: 'nutzer', gesperrt: false, gruppen: [] }); return d; });
  assert.deepEqual((await e.als('ben')('chat.uebersicht', {})).raeume, []);
  await assert.rejects(e.als('ben')('chat.verlauf', { raum: dm }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  const { raum: dm2 } = await e.als('ben')('chat.dm.oeffnen', { nutzer: 'anna' });
  assert.notEqual(dm2, dm);
  assert.equal((await e.als('ben')('chat.verlauf', { raum: dm2 })).nachrichten.length, 0);
  assert.equal((await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' })).raum, dm2, 'beide landen in derselben neuen DM');
  assert.equal(dm, dmId('anna', 'ben'), 'alte Kennung unverändert (Bestand)');
});

test('Mitglieder: jeder darf sich selbst entfernen, letzter Verwalter nicht, solange andere da sind', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben', 'cara'] });
  await e.als('ben')('chat.raum.mitglieder', { raum: raum, weg: ['ben'] });
  const weg = e.ereignisse().find((x) => x.art === 'raum_weg' && x.raum === raum);
  assert.deepEqual(weg.an, { nutzer: ['ben'], gaeste: [] });
  await assert.rejects(e.als('anna')('chat.raum.mitglieder', { raum: raum, weg: ['anna'] }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'weg');
  await e.als('anna')('chat.raum.mitglieder', { raum: raum, verwalter_hinzu: ['cara'] });
  await e.als('anna')('chat.raum.mitglieder', { raum: raum, weg: ['anna'] });
  const r = JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));
  assert.deepEqual(Object.keys(r.mitglieder), ['cara']); assert.deepEqual(r.verwalter, ['cara']);
  await e.als('cara')('chat.raum.mitglieder', { raum: raum, weg: ['cara'] });
  assert.equal(await existiert(path.join(e.chat, 'raeume', raum)), false, 'letzte Person weg → Raum gelöscht');
});

test('Mitglieder hinzufügen: nur bestehende, nicht gesperrte Nutzer; Doppelte übergangen', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team' });
  await assert.rejects(e.als('anna')('chat.raum.mitglieder', { raum: raum, hinzu: ['niemand'] }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'hinzu');
  await e.als('anna')('chat.raum.mitglieder', { raum: raum, hinzu: ['ben', 'anna'] });
  const r = JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));
  assert.deepEqual(Object.keys(r.mitglieder).sort(), ['anna', 'ben']);
  await assert.rejects(e.als('anna')('chat.raum.mitglieder', { raum: raum, verwalter_hinzu: ['cara'] }), (f) => f.code === 'E_PARAMS');
});

test('DM: nicht mit sich selbst, nur bestehende Nutzer, keine Verwaltung, nicht löschbar', async () => {
  await assert.rejects(e.als('anna')('chat.dm.oeffnen', { nutzer: 'anna' }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.dm.oeffnen', { nutzer: 'niemand' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'nutzer');
  const a = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' });
  const b = await e.als('ben')('chat.dm.oeffnen', { nutzer: 'anna' });
  assert.equal(a.raum, b.raum);
  assert.equal(a.raum, dmId('anna', 'ben'));
  assert.equal(e.ereignisse().filter((x) => x.art === 'raum' && x.raum === a.raum).length, 1);
  await assert.rejects(e.als('anna')('chat.raum.aendern', { raum: a.raum, name: 'X' }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.raum.mitglieder', { raum: a.raum, hinzu: ['cara'] }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.raum.loeschen', { raum: a.raum }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('chef', 'admin')('chat.raum.loeschen', { raum: a.raum }), (f) => f.code === 'E_PARAMS');
});

test('Admin löscht fremden Raum über raum.alle, ohne Inhalte zu sehen', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' });
  const alle = await e.als('chef', 'admin')('chat.raum.alle', {});
  assert.deepEqual(alle, [{ id: raum, name: 'Team', mitglieder_anzahl: 2, gaeste_anzahl: 0, ersteller: 'anna', letzte_zeit: null }]);
  await e.als('chef', 'admin')('chat.raum.loeschen', { raum: raum });
  assert.equal(await existiert(path.join(e.chat, 'raeume', raum)), false);
  const weg = e.ereignisse().find((x) => x.art === 'raum_weg' && x.raum === raum);
  assert.deepEqual(weg.an, { nutzer: ['anna', 'ben'], gaeste: [] });
  assert.throws(() => e.u.reg.vorbereiten('chat.raum.alle', {}, { nutzer: 'anna', rolle: 'nutzer', ip: '-' }), (f) => f.code === 'E_RECHTE');
});

test('Einstellungen: lesen für alle, setzen nur Admin, Grenzen, chat.json 0600', async () => {
  assert.deepEqual(await e.als('anna')('chat.einstellungen.lesen', {}), { max_anhang_mb: 2048, turn: { aktiv: true, port: 3478 } });
  assert.throws(() => e.u.reg.vorbereiten('chat.einstellungen.setzen', { max_anhang_mb: 100 }, { nutzer: 'anna', rolle: 'nutzer', ip: '-' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('chef', 'admin')('chat.einstellungen.setzen', { max_anhang_mb: 0 }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('chef', 'admin')('chat.einstellungen.setzen', { turn: { aktiv: true, port: 80 } }), (f) => f.code === 'E_PARAMS');
  const neu = await e.als('chef', 'admin')('chat.einstellungen.setzen', { max_anhang_mb: 100 });
  assert.deepEqual(neu, { max_anhang_mb: 100, turn: { aktiv: true, port: 3478 } });
  assert.ok(e.u.ereignisse.some((x) => x.ereignis === 'konfig' && x.bereich === 'chat'));
  assert.equal((await fs.stat(path.join(e.u.pfade.konfig, 'chat.json'))).mode & 0o777, 0o600);
});

test('chat.empfaenger nur für Mitglieder', async () => {
  const { raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] });
  assert.deepEqual(await e.als('ben')('chat.empfaenger', { raum: raum }), { nutzer: ['anna', 'ben'], gaeste: [] });
  await assert.rejects(e.als('cara')('chat.empfaenger', { raum: raum }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Audit: raum.anlegen protokolliert ohne Beschreibung', () => {
  assert.deepEqual(e.u.reg.hole('chat.raum.anlegen').audit({ name: 'T', beschreibung: 'GEHEIM', mitglieder: ['ben'] }), { name: 'T', mitglieder: ['ben'] });
});

test('personen: alle nicht gesperrten NAS-Nutzer mit Anzeigenamen, für jeden Nutzer (DM und Mitglieder wählen)', async () => {
  const users = await e.u.konfig.laden('users.json');
  users.nutzer.push({ name: 'dora', anzeigename: 'Dora', rolle: 'nutzer', gesperrt: true, gruppen: [] });
  await e.u.konfig.speichern('users.json', users);
  const r = await e.als('ben')('chat.personen', {});
  assert.deepEqual(r.personen, [
    { name: 'anna', anzeigename: 'Anna A.' }, { name: 'ben', anzeigename: 'Ben' }, { name: 'cara', anzeigename: 'cara' }, { name: 'chef', anzeigename: 'Chef' },
  ]);
});
