// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Index folgt dem Dateimanager (Plan 04, Aufgabe 5): Umbenennen (auch Elternordner und Serien), Verschieben in
// andere Freigaben, Papierkorb (löschen, wiederherstellen, leeren, endgültig). nachfuehren wirft nie.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { officeUmgebung } from './office_hilfen.js';
import { indexLaden } from '../../src/agent/office/index.js';

const K = { nutzer: 'anna', rolle: 'nutzer', ip: '-' };
let e; let T;
const aufgabe = async (name, params) => {
  const { aktion, params: p } = e.u.reg.vorbereiten(name, params, K);
  return aktion.ausfuehren(p, K, e.w, { fortschritt() {}, abgebrochen: () => false });
};
const pfadVon = async (id) => (await indexLaden(e.w)).dokumente[id];

beforeEach(async () => {
  e = await officeUmgebung();
  await fs.mkdir(path.join(e.shares, 'team', 'Projekte'));
  T = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Sprint' })).id;
  await e.als('anna')('office.freigeben', { id: T, nutzer: 'cara', recht: 'lesen' });
});
afterEach(async () => { await e.aufraeumen(); });

test('Bündel umbenennen und Elternordner umbenennen: laden über die ID geht weiter', async () => {
  await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', neuer_name: 'Q4.fahboard' });
  const d = await e.als('anna')('office.laden', { id: T });
  assert.deepEqual([d.pfad, d.name], ['Projekte/Q4.fahboard', 'Q4']);
  await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'Projekte', neuer_name: 'Archiv' });
  assert.equal((await e.als('anna')('office.laden', { id: T })).pfad, 'Archiv/Q4.fahboard');
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'pfad', id: T, freigabe: 'team', pfad: 'Archiv/Q4.fahboard', name: 'Q4' });
  assert.deepEqual((await pfadVon(T)).freigaben, { cara: 'lesen' });
});

test('Endung weg → Eintrag weg', async () => {
  await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', neuer_name: 'Q4' });
  await assert.rejects(e.als('anna')('office.laden', { id: T }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  assert.equal(await pfadVon(T), undefined);
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'geloescht', id: T });
});

test('verschieben in andere Freigabe folgt, Freigaben bleiben', async () => {
  const r = await aufgabe('dateien.verschieben', { freigabe: 'team', quellen: ['Projekte/Sprint.fahboard'], ziel_freigabe: 'privat', ziel_pfad: '' });
  assert.deepEqual(r.uebertragen, [{ von: 'Projekte/Sprint.fahboard', nach: 'Sprint.fahboard' }]);
  const d = await pfadVon(T);
  assert.deepEqual([d.freigabe, d.pfad, d.name, d.freigaben], ['privat', 'Sprint.fahboard', 'Sprint', { cara: 'lesen' }]);
  assert.equal((await e.als('cara')('office.laden', { id: T })).recht, 'lesen');
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'pfad', id: T, freigabe: 'privat', pfad: 'Sprint.fahboard', name: 'Sprint' });
  // Kopieren legt keinen Eintrag um
  await aufgabe('dateien.kopieren', { freigabe: 'privat', quellen: ['Sprint.fahboard'], ziel_freigabe: 'team', ziel_pfad: '' });
  assert.equal((await pfadVon(T)).freigabe, 'privat');
});

test('Serie umbenennen: getauschte Namen landen beim richtigen Eintrag', async () => {
  const U = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Zweites' })).id;
  await e.als('anna')('dateien.umbenennen_serie', { freigabe: 'team', pfad: 'Projekte', basis: 'Board', namen: ['Zweites.fahboard', 'Sprint.fahboard'] });
  assert.deepEqual([(await pfadVon(U)).pfad, (await pfadVon(T)).pfad, (await pfadVon(T)).name], ['Projekte/Board (01).fahboard', 'Projekte/Board (02).fahboard', 'Board (02)']);
  await e.als('anna')('dateien.umbenennen_serie', { freigabe: 'team', pfad: 'Projekte', basis: 'Board', namen: ['Board (02).fahboard', 'Board (01).fahboard'] });
  assert.deepEqual([(await pfadVon(T)).pfad, (await pfadVon(U)).pfad], ['Projekte/Board (01).fahboard', 'Projekte/Board (02).fahboard'], 'Tausch');
  assert.equal((await e.als('anna')('office.laden', { id: T })).id, T);
});

test('Papierkorb: löschen → geloescht, wiederherstellen → zurück, leeren/endgültig → weg', async () => {
  await e.als('anna')('dateien.loeschen', { freigabe: 'team', pfade: ['Projekte'] });
  await assert.rejects(e.als('anna')('office.laden', { id: T }), (f) => f.details?.office === 'geloescht');
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'geloescht', id: T });
  const korb = await e.als('anna')('dateien.papierkorb.liste', { freigabe: 'team' });
  await e.als('anna')('dateien.papierkorb.wiederherstellen', { freigabe: 'team', eintraege: [{ id: korb[0].id }] });
  const d = await e.als('anna')('office.laden', { id: T });
  assert.equal(d.pfad, 'Projekte/Sprint.fahboard');
  assert.deepEqual((await pfadVon(T)).freigaben, { cara: 'lesen' });
  assert.equal((await pfadVon(T)).geloescht, undefined);
  // Wiederherstellen an belegten Ort → „Name (1)“, der Eintrag folgt
  await e.als('anna')('dateien.loeschen', { freigabe: 'team', pfade: ['Projekte/Sprint.fahboard'] });
  const N = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Sprint' })).id;
  const korb2 = await e.als('anna')('dateien.papierkorb.liste', { freigabe: 'team' });
  await e.als('anna')('dateien.papierkorb.wiederherstellen', { freigabe: 'team', eintraege: [{ id: korb2[0].id }] });
  assert.deepEqual([(await pfadVon(T)).pfad, (await pfadVon(T)).name, (await pfadVon(N)).pfad], ['Projekte/Sprint (1).fahboard', 'Sprint (1)', 'Projekte/Sprint.fahboard']);
  assert.equal((await e.als('anna')('office.laden', { id: T })).id, T);
  // erneut löschen + leeren → weg; endgültig → sofort weg
  await e.als('anna')('dateien.loeschen', { freigabe: 'team', pfade: ['Projekte/Sprint (1).fahboard'] });
  await e.als('anna')('dateien.papierkorb.leeren', { freigabe: 'team' });
  assert.equal(await pfadVon(T), undefined);
  await e.als('anna')('dateien.loeschen', { freigabe: 'team', pfade: ['Projekte/Sprint.fahboard'], endgueltig: true });
  assert.equal(await pfadVon(N), undefined);
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'geloescht', id: N });
});

test('verschwundenes Bündel am Ziel eines Umbenennens gilt als gelöscht', async () => {
  const X = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Alt' })).id;
  await fs.rm(path.join(e.shares, 'team', 'Projekte', 'Alt.fahboard'), { recursive: true });
  await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', neuer_name: 'Alt.fahboard' });
  assert.ok((await pfadVon(X)).geloescht);
  assert.equal((await e.als('anna')('office.laden', { freigabe: 'team', pfad: 'Projekte/Alt.fahboard' })).id, T);
});

test('fremder Pfad ohne Bündel ändert den Index nicht; nachfuehren wirft nie', async () => {
  await fs.writeFile(path.join(e.shares, 'team', 'notiz.txt'), 'x');
  const datei = path.join(e.u.pfade.konfig, 'office.json');
  const vorher = await fs.readFile(datei, 'utf8'); const mtime = (await fs.stat(datei)).mtimeMs;
  await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'notiz.txt', neuer_name: 'notiz2.txt' });
  assert.equal(await fs.readFile(datei, 'utf8'), vorher); assert.equal((await fs.stat(datei)).mtimeMs, mtime);
  await fs.writeFile(datei, 'kaputt{');
  const r = await e.als('anna')('dateien.umbenennen', { freigabe: 'team', pfad: 'notiz2.txt', neuer_name: 'notiz3.txt' });
  assert.equal(r.pfad, 'notiz3.txt');
  await e.als('anna')('dateien.loeschen', { freigabe: 'team', pfade: ['notiz3.txt'] });
});
