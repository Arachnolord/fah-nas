// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bilder und Anhänge im Office-Bündel (Plan 04, Aufgabe 4): Hochladen über den Datenkanal in dateien/ (über eine
// Office-Freigabe als Besitzer), Lese-Tickets, Kopieren aus dem NAS mit den eigenen Rechten an der Quelle.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { officeUmgebung } from './office_hilfen.js';
import { DETAILS_FUER_NUTZER } from '../../src/agent/agent.js';

let e; let P;
const DATEIEN = () => path.join(e.shares, 'privat', 'Sprint.fahboard', 'dateien');

beforeEach(async () => {
  e = await officeUmgebung();
  P = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'privat', ordner: '', name: 'Sprint' })).id;
});
afterEach(async () => { await e.aufraeumen(); });

test('Upload: Ticket als Besitzer in dateien/, Abschluss liefert {datei, name}', async () => {
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'cara', recht: 'bearbeiten' });
  e.ids.length = 0;
  await e.als('cara')('office.datei_ticket', { id: P, name: 'foto.jpg', groesse: 5 });
  const d = e.tickets.at(-1);
  assert.deepEqual([d.nutzer, d.art, d.groesse, d.mime, d.dateiname], ['cara', 'schreiben', 5, 'image/jpeg', 'foto.jpg']);
  assert.ok(e.ids.length > 0 && e.ids.every((n) => n === 'anna'), 'Helfer und Ticket als anna');
  const erg = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('hallo'));
  assert.match(erg.datei, /^[A-Za-z0-9_-]{12}-foto\.jpg$/); assert.equal(erg.name, 'foto.jpg');
  assert.equal(await fs.readFile(path.join(DATEIEN(), erg.datei), 'utf8'), 'hallo');
  assert.deepEqual(await fs.readdir(DATEIEN()), [erg.datei], 'keine Zwischendatei übrig');
});

test('Upload ohne Recht → E_RECHTE, Name mit ../ → E_PARAMS, zu groß → E_PARAMS max', async () => {
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' });
  await assert.rejects(e.als('ben')('office.datei_ticket', { id: P, name: 'a.txt', groesse: 1 }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('cara')('office.datei_ticket', { id: P, name: 'a.txt', groesse: 1 }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  for (const name of ['../a.txt', 'a\\b.txt', '.']) await assert.rejects(e.als('anna')('office.datei_ticket', { id: P, name, groesse: 1 }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'name', name);
  await assert.rejects(e.als('anna')('office.datei_ticket', { id: P, name: 'a.bin', groesse: 104857601 }), (f) => f.code === 'E_PARAMS' && f.details.max === 104857600);
  assert.ok(DETAILS_FUER_NUTZER.includes('max'), 'Grenze erreicht auch Nutzer');
  assert.deepEqual(await fs.readdir(DATEIEN()), []);
  await e.als('anna')('office.datei_ticket', { id: P, name: 'weg.txt', groesse: 3 });
  await e.tickets.at(-1).abschluss(false);
  assert.deepEqual(await fs.readdir(DATEIEN()), [], 'abgebrochen → verworfen');
});

test('lesen: Ticket als Besitzer für den Leser; fremde Datei-ID → E_NICHT_GEFUNDEN; ohne Recht E_NICHT_GEFUNDEN', async () => {
  await e.als('anna')('office.datei_ticket', { id: P, name: 'notiz.txt', groesse: 5 });
  const { datei } = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('hallo'));
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' });
  e.ids.length = 0;
  await e.als('ben')('office.datei_lesen', { id: P, datei });
  const t = e.tickets.at(-1);
  assert.deepEqual([t.nutzer, t.art, t.dateiname, t.groesse, t.mime], ['ben', 'lesen', 'notiz.txt', 5, 'text/plain']);
  assert.equal(t.pfad, await fs.realpath(path.join(DATEIEN(), datei)));
  assert.ok(e.ids.length > 0 && e.ids.every((n) => n === 'anna'), 'gelesen als anna');
  await assert.rejects(e.als('ben')('office.datei_lesen', { id: P, datei: 'AAAAAAAAAAAA-gibtsnicht.txt' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('cara')('office.datei_lesen', { id: P, datei }), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details === undefined);
  for (const falsch of ['../inhalt.json', 'kurz-x.txt', 'AAAAAAAAAAAA-a/b']) await assert.rejects(e.als('ben')('office.datei_lesen', { id: P, datei: falsch }), (f) => f.code === 'E_PARAMS', falsch);
});

test('aus dem NAS kopieren: Quelle mit eigenen Rechten, Ziel als Besitzer; Quelle ohne Leserecht → E_RECHTE', async () => {
  await fs.writeFile(path.join(e.shares, 'team', 'plan.pdf'), 'PDF-INHALT');
  await fs.mkdir(path.join(e.shares, 'team', 'ordner'));
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'cara', recht: 'bearbeiten' });
  await assert.rejects(e.als('cara')('office.datei_kopieren', { id: P, freigabe: 'team', pfad: 'plan.pdf' }), (f) => f.code === 'E_RECHTE');
  const r = await e.als('anna')('office.datei_kopieren', { id: P, freigabe: 'team', pfad: 'plan.pdf' });
  assert.match(r.datei, /^[A-Za-z0-9_-]{12}-plan\.pdf$/); assert.equal(r.name, 'plan.pdf');
  assert.equal(r.groesse, 10); assert.equal(r.mime, 'application/pdf'); // für den Board-Anhang (Aufgabe 14)
  assert.equal(await fs.readFile(path.join(DATEIEN(), r.datei), 'utf8'), 'PDF-INHALT');
  await assert.rejects(e.als('anna')('office.datei_kopieren', { id: P, freigabe: 'team', pfad: '' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'pfad');
  await assert.rejects(e.als('anna')('office.datei_kopieren', { id: P, freigabe: 'team', pfad: 'ordner' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'pfad');
  await assert.rejects(e.als('anna')('office.datei_kopieren', { id: P, freigabe: 'geheim', pfad: 'x.pdf' }), (f) => f.code === 'E_RECHTE');
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' });
  await assert.rejects(e.als('ben')('office.datei_kopieren', { id: P, freigabe: 'team', pfad: 'plan.pdf' }), (f) => f.code === 'E_RECHTE', 'nur lesen am Dokument');
});
