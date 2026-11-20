// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Aktionen (Plan 04, Aufgabe 3, V14): anlegen, laden, speichern, Import, Liste, Office-Freigaben, Umbenennen,
// Recht, Personen; Bündel per SMB verschoben oder kopiert; Admins ohne Sonderrecht in der Liste; Audit ohne Inhalte.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { officeUmgebung } from './office_hilfen.js';
import { ausfuehrenOp } from '../../src/agent/helfer/dateihelfer.js';
import { indexLaden, officeKontoEntfernen } from '../../src/agent/office/index.js';
import { GROSSE_AKTIONEN } from '../../src/web/api/agent.js';

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
let e;

beforeEach(async () => { e = await officeUmgebung(); });
afterEach(async () => { await e.aufraeumen(); });

/** Grundbestand: annas Board „Sprint“ in team (T) und „Privat“ in privat (P); inhalt.json eine Minute zurückdatiert. */
async function grund() {
  const T = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Sprint' })).id;
  const P = (await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'privat', ordner: '', name: 'Privat' })).id;
  const frueher = new Date(Date.now() - 60_000);
  for (const d of ['team/Sprint.fahboard', 'privat/Privat.fahboard']) await fs.utimes(path.join(e.shares, d, 'inhalt.json'), frueher, frueher);
  return { T, P };
}

/** Bündel per Hand (wie per SMB abgelegt) mit eigener id/besitzer. */
async function fremdesBuendel(freigabe, name, { id, besitzer }) {
  const inhalt = { format: 'fah-office', art: 'board', schema: 1, id, version: 0, erstellt: '2026-10-01T08:00:00.000Z', geaendert: '2026-10-01T08:00:00.000Z', besitzer, daten: null };
  await ausfuehrenOp('office_anlegen', { wurzel: path.join(e.shares, freigabe), rel_ordner: '', name, endung: '.fahboard', inhalt });
}

test('anlegen → laden: leeres Board, Index, zuletzt; Name mit ../ → E_PARAMS', async () => {
  const r = await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Sprint' });
  assert.match(r.id, /^o[A-Za-z0-9_-]{16}$/); assert.deepEqual([r.art, r.freigabe, r.pfad, r.name], ['board', 'team', 'Sprint.fahboard', 'Sprint']);
  const d = await e.als('ben')('office.laden', { id: r.id });
  assert.deepEqual([d.art, d.recht, d.version, d.daten, d.besitzer, d.verlauf.length, d.schnappschuesse], ['board', 'bearbeiten', 0, null, 'anna', 0, false]);
  assert.deepEqual([d.id, d.name, d.freigabe, d.pfad], [r.id, 'Sprint', 'team', 'Sprint.fahboard']); assert.match(d.stand, ISO);
  assert.equal((await e.als('ben')('office.liste', {})).zuletzt[0].id, r.id);
  const ix = await indexLaden(e.w);
  assert.deepEqual(ix.dokumente[r.id], { id: r.id, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Sprint.fahboard', besitzer: 'anna', erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T08:00:00.000Z', freigaben: {} });
  const b = await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Sprint', beide: true });
  assert.deepEqual([b.pfad, b.name], ['Sprint (1).fahboard', 'Sprint (1)']);
  await assert.rejects(e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Sprint' }), (f) => f.code === 'E_EXISTIERT');
  await assert.rejects(e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: '../x' }), (f) => f.code === 'E_PARAMS');
  for (const name of ['a\\b', '.x', 'a\u0007b']) await assert.rejects(e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'name', name);
  await assert.rejects(e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Sprint.fahboard', name: 'x' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'ordner');
  await assert.rejects(e.als('cara')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'x' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('ben')('office.anlegen', { art: 'board', freigabe: 'lesen', ordner: '', name: 'x' }), (f) => f.code === 'E_RECHTE');
});

test('speichern: Stand, Verlauf, E_GEAENDERT bei veraltetem Stand; Audit ohne daten', async () => {
  const { T: id } = await grund();
  const d = await e.als('anna')('office.laden', { id });
  e.jetzt.wert = Date.parse('2026-10-18T09:30:00.000Z');
  const s = await e.als('anna')('office.speichern', { id, version: 1, daten: { geheim: 'GEHEIM' }, ops: [{ v: 1, op: { typ: 'noop' }, cid: 'c1' }], stand: d.stand });
  assert.match(s.stand, ISO); assert.notEqual(s.stand, d.stand);
  const d2 = await e.als('ben')('office.laden', { id });
  assert.deepEqual([d2.version, d2.daten, d2.verlauf, d2.stand], [1, { geheim: 'GEHEIM' }, [{ v: 1, op: { typ: 'noop' }, cid: 'c1' }], s.stand]);
  const inhalt = JSON.parse(await fs.readFile(path.join(e.shares, 'team', 'Sprint.fahboard', 'inhalt.json'), 'utf8'));
  assert.deepEqual(inhalt, { format: 'fah-office', art: 'board', schema: 1, id, version: 1, erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T09:30:00.000Z', besitzer: 'anna', daten: { geheim: 'GEHEIM' } });
  assert.equal((await indexLaden(e.w)).dokumente[id].geaendert, '2026-10-18T09:30:00.000Z');
  await assert.rejects(e.als('anna')('office.speichern', { id, version: 2, daten: {}, ops: [], stand: d.stand }), (f) => f.code === 'E_GEAENDERT');
  await assert.rejects(e.als('cara')('office.speichern', { id, version: 2, daten: {}, ops: [], stand: s.stand }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  const def = e.u.reg.aktionen.get('office.speichern');
  assert.deepEqual(def.audit({ id, version: 1, daten: { geheim: 'GEHEIM' }, ops: [] }), { id, version: 1 });
  assert.equal(JSON.stringify(e.u.reg.aktionen.get('office.import_setzen').audit({ id, daten: { x: 'GEHEIM' } })).includes('GEHEIM'), false);
  assert.equal(JSON.stringify(e.u.reg.aktionen.get('office.anlegen').audit({ art: 'board', freigabe: 'team', ordner: '', name: 'S' })).includes('daten'), false);
  assert.equal(e.u.reg.aktionen.get('office.laden').audit, false);
  assert.equal(e.u.reg.aktionen.get('office.recht').audit, false);
});

test('import_setzen nur bei Version 0', async () => {
  const { T, P } = await grund();
  const r = await e.als('anna')('office.import_setzen', { id: T, daten: { spalten: [] } });
  assert.equal(r.version, 1); assert.match(r.stand, ISO);
  const d = await e.als('ben')('office.laden', { id: T });
  assert.deepEqual([d.version, d.daten, d.stand], [1, { spalten: [] }, r.stand]);
  await assert.rejects(e.als('anna')('office.import_setzen', { id: T, daten: {} }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'id');
  await assert.rejects(e.als('ben')('office.import_setzen', { id: P, daten: {} }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Office-Freigabe: cara bearbeitet annas privates Board als anna', async () => {
  const { P } = await grund();
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'cara', recht: 'bearbeiten' });
  e.ids.length = 0;
  const d = await e.als('cara')('office.laden', { id: P });
  assert.equal(d.recht, 'bearbeiten');
  await e.als('cara')('office.speichern', { id: P, version: 1, daten: {}, ops: [], stand: d.stand });
  assert.ok(e.ids.length > 0 && e.ids.every((n) => n === 'anna'), 'Helfer liefen als anna');
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'rechte', id: P });
  assert.equal((await e.als('cara')('office.liste', {})).fuer_mich[0].id, P);
  await assert.rejects(e.als('cara')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('ben')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('anna')('office.freigeben', { id: P, nutzer: 'anna', recht: 'lesen' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'nutzer');
  await assert.rejects(e.als('anna')('office.freigeben', { id: P, nutzer: 'niemand', recht: 'lesen' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'nutzer');
  assert.deepEqual(await e.als('anna')('office.freigeben', { id: P, nutzer: 'cara', recht: 'keins' }), { freigaben: {} });
  await assert.rejects(e.als('cara')('office.laden', { id: P }), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details === undefined);
});

test('freigaben: privat, geteilt_mit ohne Admins', async () => {
  const { T, P } = await grund();
  assert.deepEqual(await e.als('anna')('office.freigaben', { id: P }), { besitzer: 'anna', freigaben: {}, geteilt_mit: [], privat: true });
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' });
  const f1 = await e.als('anna')('office.freigaben', { id: P });
  assert.deepEqual([f1.freigaben, f1.geteilt_mit, f1.privat], [{ ben: 'lesen' }, [{ name: 'ben', anzeigename: 'Ben', recht: 'lesen', ueber: 'office' }], false]);
  assert.deepEqual((await e.als('ben')('office.freigaben', { id: P })).geteilt_mit.map((g) => g.name), ['ben'], 'jedes Recht darf sehen');
  const ft = await e.als('ben')('office.freigaben', { id: T });
  assert.deepEqual(ft.geteilt_mit, [{ name: 'ben', anzeigename: 'Ben', recht: 'bearbeiten', ueber: 'freigabe' }]);
  await e.als('anna')('office.freigeben', { id: T, nutzer: 'chef', recht: 'lesen' });
  await e.als('anna')('office.freigeben', { id: T, nutzer: 'ben', recht: 'lesen' });
  assert.deepEqual((await e.als('anna')('office.freigaben', { id: T })).geteilt_mit.map((g) => [g.name, g.recht, g.ueber]), [['ben', 'bearbeiten', 'freigabe'], ['chef', 'lesen', 'office']], 'Admin nur mit Office-Freigabe; schwächere Office-Freigabe ändert nichts');
  await assert.rejects(e.als('cara')('office.freigaben', { id: T }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  // Gruppen und „gaeste“: Mitglieder zählen, gesperrte nicht
  const users = await e.u.konfig.laden('users.json');
  users.gruppen = [{ name: 'g1', mitglieder: ['cara', 'dora'] }];
  await e.u.konfig.speichern('users.json', users);
  const shares = await e.u.konfig.laden('shares.json');
  shares.freigaben.find((f) => f.name === 'privat').lesen = ['@g1'];
  await e.u.konfig.speichern('shares.json', shares);
  assert.deepEqual((await e.als('anna')('office.freigaben', { id: P })).geteilt_mit.map((g) => [g.name, g.recht, g.ueber]), [['ben', 'lesen', 'office'], ['cara', 'lesen', 'freigabe']]);
  shares.freigaben.find((f) => f.name === 'privat').lesen = []; shares.freigaben.find((f) => f.name === 'privat').gaeste = true;
  await e.u.konfig.speichern('shares.json', shares);
  assert.deepEqual((await e.als('anna')('office.freigaben', { id: P })).geteilt_mit.map((g) => [g.name, g.ueber]), [['ben', 'freigabe'], ['cara', 'freigabe']]);
});

test('liste: meine, für mich, Ansicht', async () => {
  const { T, P } = await grund();
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'ben', recht: 'lesen' });
  const l = await e.als('anna')('office.liste', {});
  assert.deepEqual(l.meine.map((a) => a.id).sort(), [T, P].sort());
  assert.deepEqual(l.meine.find((a) => a.id === P), { id: P, art: 'board', name: 'Privat', freigabe: 'privat', pfad: 'Privat.fahboard', besitzer: 'anna', besitzer_name: 'Anna A.', geaendert: '2026-10-18T08:00:00.000Z', recht: 'bearbeiten', geteilt: true });
  assert.equal(l.meine.find((a) => a.id === T).geteilt, false);
  assert.deepEqual(l.zuletzt.map((a) => a.id), [P, T]);
  const lb = await e.als('ben')('office.liste', {});
  assert.deepEqual([lb.meine, lb.zuletzt, lb.fuer_mich.map((a) => [a.id, a.recht])], [[], [], [[P, 'lesen']]]);
});

test('Nutzername „constructor“: leere Listen, kein Absturz, kein Zugriff (nur eigene Schlüssel zählen)', async () => {
  const { P } = await grund();
  assert.deepEqual(await e.als('constructor')('office.liste', {}), { zuletzt: [], meine: [], fuer_mich: [] });
  await assert.rejects(e.als('constructor')('office.laden', { id: P }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  const ix = await indexLaden(e.w);
  const { zuletztMerken } = await import('../../src/agent/office/index.js');
  zuletztMerken(ix, 'constructor', P, '2026-10-18T08:00:00.000Z');
  assert.deepEqual(ix.zuletzt.constructor, [{ id: P, zeit: '2026-10-18T08:00:00.000Z' }]);
});

test('Admin-Liste ohne Sonderrecht', async () => {
  const { P } = await grund();
  const l = await e.als('chef', 'admin')('office.liste', {});
  assert.deepEqual([l.meine.length, l.fuer_mich.length, l.zuletzt.length], [0, 0, 0]);
  assert.equal((await e.als('chef', 'admin')('office.laden', { id: P })).recht, 'bearbeiten'); // Öffnen bleibt erlaubt
  assert.equal((await e.als('chef', 'admin')('office.liste', {})).zuletzt[0].id, P);         // selbst geöffnet → in „Zuletzt“
});

test('verschoben, umgezogen, kopiert (SMB)', async () => {
  const { T } = await grund();
  await e.als('anna')('office.freigeben', { id: T, nutzer: 'cara', recht: 'lesen' });
  await fs.mkdir(path.join(e.shares, 'team', 'Neu'));
  await fs.rename(path.join(e.shares, 'team', 'Sprint.fahboard'), path.join(e.shares, 'team', 'Neu', 'Sprint.fahboard'));
  await assert.rejects(e.als('anna')('office.laden', { id: T }), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details.office === 'verschoben');
  const neu = await e.als('anna')('office.laden', { freigabe: 'team', pfad: 'Neu/Sprint.fahboard' });
  assert.equal(neu.id, T); assert.equal(neu.pfad, 'Neu/Sprint.fahboard');
  assert.equal((await e.als('cara')('office.laden', { id: T })).recht, 'lesen');
  await fs.cp(path.join(e.shares, 'team', 'Neu', 'Sprint.fahboard'), path.join(e.shares, 'team', 'Kopie.fahboard'), { recursive: true });
  const k = await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Kopie.fahboard' });
  assert.notEqual(k.id, T); assert.equal(k.besitzer, 'ben'); assert.equal(k.name, 'Kopie');
  assert.deepEqual((await indexLaden(e.w)).dokumente[k.id].freigaben, {});
  assert.equal((await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Kopie.fahboard' })).id, k.id, 'zweites Öffnen findet den Eintrag');
  // fremde Bündel: gültige unbekannte ID bleibt, Besitzer nur wenn aktiv; ungültige ID → neue
  await fremdesBuendel('team', 'Fremd', { id: 'oBBBBBBBBBBBBBBBB', besitzer: 'cara' });
  await fremdesBuendel('team', 'Gesperrt', { id: 'oCCCCCCCCCCCCCCCC', besitzer: 'dora' });
  await fremdesBuendel('team', 'Kaputt', { id: 'xyz', besitzer: 'anna' });
  const f = await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Fremd.fahboard' });
  assert.deepEqual([f.id, f.besitzer], ['oBBBBBBBBBBBBBBBB', 'cara']);
  const g = await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Gesperrt.fahboard' });
  assert.deepEqual([g.id, g.besitzer], ['oCCCCCCCCCCCCCCCC', 'ben']);
  const x = await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Kaputt.fahboard' });
  assert.match(x.id, /^o[A-Za-z0-9_-]{16}$/); assert.equal(x.besitzer, 'ben');
  await assert.rejects(e.als('cara')('office.laden', { freigabe: 'team', pfad: 'Fremd.fahboard' }), (f2) => f2.code === 'E_RECHTE');
  await assert.rejects(e.als('ben')('office.laden', {}), (f2) => f2.code === 'E_PARAMS' && f2.details.feld === 'id');
});

test('anlegen am Ort eines verschwundenen Bündels: alter Eintrag gilt als gelöscht', async () => {
  const { T } = await grund();
  await e.als('anna')('office.freigeben', { id: T, nutzer: 'cara', recht: 'bearbeiten' });
  await fs.rm(path.join(e.shares, 'team', 'Sprint.fahboard'), { recursive: true });
  const n = await e.als('ben')('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Sprint' });
  await assert.rejects(e.als('cara')('office.laden', { id: T }), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details.office === 'geloescht');
  assert.equal((await e.als('ben')('office.laden', { freigabe: 'team', pfad: 'Sprint.fahboard' })).id, n.id);
});

test('umbenennen, recht, personen', async () => {
  await fs.mkdir(path.join(e.shares, 'team', 'Neu'));
  const { id } = await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Neu', name: 'Plan' });
  const u = await e.als('ben')('office.umbenennen', { id, name: 'Q4' });
  assert.deepEqual(u, { id, name: 'Q4', pfad: 'Neu/Q4.fahboard' });
  assert.deepEqual(e.ereignisse().at(-1), { ereignis: 'office', art: 'pfad', id, freigabe: 'team', pfad: 'Neu/Q4.fahboard', name: 'Q4' });
  const d = await e.als('ben')('office.laden', { id });
  assert.deepEqual([d.name, d.pfad], ['Q4', 'Neu/Q4.fahboard']);
  for (const name of ['a/b', '.x']) await assert.rejects(e.als('ben')('office.umbenennen', { id, name }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'name', name);
  const { id: L } = await e.als('anna')('office.anlegen', { art: 'board', freigabe: 'lesen', ordner: '', name: 'L' });
  await assert.rejects(e.als('ben')('office.umbenennen', { id: L, name: 'M' }), (f) => f.code === 'E_RECHTE');
  const r = await e.als('ben')('office.recht', { id });
  assert.deepEqual([r.id, r.recht, r.stand], [id, 'bearbeiten', d.stand]);
  assert.equal((await e.als('ben')('office.recht', { id: L })).recht, 'lesen');
  assert.equal((await e.als('ben')('office.recht', { freigabe: 'team', pfad: 'Neu/Q4.fahboard' })).id, id);
  assert.equal((await e.als('ben')('office.liste', {})).zuletzt[0].id, id);
  await e.als('ben')('office.recht', { id: L, merken: true });
  assert.equal((await e.als('ben')('office.liste', {})).zuletzt[0].id, L);
  await fs.rm(path.join(e.shares, 'team', 'Neu', 'Q4.fahboard'), { recursive: true });
  await assert.rejects(e.als('ben')('office.recht', { id }), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details.office === 'verschoben');
  assert.deepEqual(await e.als('anna')('office.personen', {}), [{ name: 'ben', anzeigename: 'Ben' }, { name: 'cara', anzeigename: 'cara' }, { name: 'chef', anzeigename: 'Chef' }]);
});

test('V2: GROSSE_AKTIONEN enthält office.anlegen und office.import_setzen mit 16 MiB', () => {
  assert.equal(GROSSE_AKTIONEN['office.import_setzen'], 16 * 1024 * 1024); assert.equal(GROSSE_AKTIONEN['office.anlegen'], 16 * 1024 * 1024);
});

test('Prüfbericht Plan 04, I2: gelöschtes Konto – Office-Freigaben, Zuletzt und Besitz fallen weg; ein neuer „ben“ erbt nichts', async () => {
  const anna = e.als('anna'); const ben = e.als('ben');
  const a = await anna('office.anlegen', { art: 'board', freigabe: 'privat', ordner: '', name: 'Annas' });
  await anna('office.freigeben', { id: a.id, nutzer: 'ben', recht: 'bearbeiten' });
  const b = await ben('office.anlegen', { art: 'board', freigabe: 'team', ordner: '', name: 'Bens' });
  await ben('office.freigeben', { id: b.id, nutzer: 'cara', recht: 'lesen' });
  await ben('office.laden', { id: a.id });
  const vorher = e.ereignisse().length;
  assert.deepEqual((await officeKontoEntfernen(e.w, 'ben')).sort(), [a.id, b.id].sort());
  const ix = await e.u.konfig.laden('office.json');
  assert.deepEqual(ix.dokumente[a.id].freigaben, {});
  assert.equal(ix.dokumente[b.id].besitzer, null); assert.deepEqual(ix.dokumente[b.id].freigaben, {});
  assert.equal(Object.hasOwn(ix.zuletzt, 'ben'), false);
  assert.deepEqual(e.ereignisse().slice(vorher).map((x) => x.art), ['rechte', 'rechte']);
  // ein neuer „ben“ sieht nichts als Seins oder als für ihn freigegeben
  const liste = await ben('office.liste', {});
  assert.deepEqual([liste.meine.length, liste.fuer_mich.length, liste.zuletzt.length], [0, 0, 0]);
  await assert.rejects(ben('office.laden', { id: a.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(ben('office.freigeben', { id: b.id, nutzer: 'anna', recht: 'lesen' }), (f) => f.code === 'E_RECHTE', 'kein Besitzer mehr');
  // und nutzer.loeschen ruft die Bereinigung
  const quelle = await fs.readFile(new URL('../../src/agent/aktionen/nutzer.js', import.meta.url), 'utf8');
  assert.match(quelle, /officeKontoEntfernen\(werkzeuge, p\.name\)/);
});
