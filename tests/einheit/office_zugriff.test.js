// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Zugriff (Plan 04, Aufgabe 2, V14): Freigabe-Recht des Aufrufers, Office-Freigabe als Besitzer nur für genau
// dieses Bündel, das höhere Recht gewinnt, gesperrte/gelöschte Besitzer, kein Hinweis ohne Recht, Admin-Sonderrecht,
// Index 0600 und „zuletzt“.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { officeUmgebung } from './office_hilfen.js';
import { ausfuehrenOp } from '../../src/agent/helfer/dateihelfer.js';
import { officeZugriff } from '../../src/agent/office/zugriff.js';
import { indexAendern, indexLaden, zuletztMerken, eintragAmOrt, pfadUnter, ZULETZT_MAX } from '../../src/agent/office/index.js';
import { neueOfficeId, schnappschuesseAn, inhaltBauen } from '../../src/agent/office/buendel.js';
import { DETAILS_FUER_NUTZER } from '../../src/agent/agent.js';
import { DETAILS_FUER_ALLE } from '../../src/web/server.js';

const K = Object.fromEntries(['anna', 'ben', 'cara', 'dora'].map((n) => [n, { nutzer: n, rolle: 'nutzer', ip: '-' }]));
K.chef = { nutzer: 'chef', rolle: 'admin', ip: '-' };
let e; const ID = {};

async function buendel(freigabe, name, eintrag = {}) {
  const id = neueOfficeId();
  const wurzel = path.join(e.shares, freigabe);
  const inhalt = { format: 'fah-office', art: 'board', schema: 1, id, version: 0, erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T08:00:00.000Z', besitzer: 'anna', daten: null };
  await ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: '', name, endung: '.fahboard', inhalt });
  await indexAendern(e.w, (ix) => {
    ix.dokumente[id] = { id, art: 'board', name, freigabe, pfad: `${name}.fahboard`, besitzer: 'anna', erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T08:00:00.000Z', freigaben: {}, ...eintrag };
    return ix;
  });
  return id;
}

beforeEach(async () => {
  e = await officeUmgebung();
  ID.team = await buendel('team', 'Plan');
  ID.lesen = await buendel('lesen', 'Plan');
  ID.privat = await buendel('privat', 'Plan', { freigaben: { cara: 'bearbeiten' } });
  ID.privat2 = await buendel('privat', 'Zwei');
});
afterEach(async () => { await e.aufraeumen(); });

test('Freigabe-Recht des Aufrufers: schreiben → bearbeiten, lesen → lesen, als = Aufrufer', async () => {
  const z = await officeZugriff(e.w, { id: ID.team }, K.ben);
  assert.deepEqual([z.recht, z.ueber, z.als.nutzer, z.rel], ['bearbeiten', 'freigabe', 'ben', 'Plan.fahboard']);
  assert.equal(z.wurzel, path.join(e.shares, 'team'));
  assert.equal(z.eintrag.id, ID.team);
  assert.equal((await officeZugriff(e.w, { id: ID.lesen }, K.ben)).recht, 'lesen');
  await assert.rejects(officeZugriff(e.w, { id: ID.lesen }, K.ben, { schreiben: true }), (f) => f.code === 'E_RECHTE');
});

test('Office-Freigabe arbeitet als Besitzer, nur für genau dieses Bündel', async () => {
  const z = await officeZugriff(e.w, { id: ID.privat }, K.cara, { schreiben: true });
  assert.deepEqual([z.recht, z.ueber, z.als.nutzer, z.als.rolle], ['bearbeiten', 'office', 'anna', 'nutzer']);
  await assert.rejects(officeZugriff(e.w, { id: ID.privat2 }, K.cara), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('höheres Recht gewinnt: Freigabe lesen + Office bearbeiten → bearbeiten über office', async () => {
  await indexAendern(e.w, (ix) => { ix.dokumente[ID.lesen].freigaben = { ben: 'bearbeiten' }; return ix; });
  const z = await officeZugriff(e.w, { id: ID.lesen }, K.ben, { schreiben: true });
  assert.deepEqual([z.recht, z.ueber, z.als.nutzer], ['bearbeiten', 'office', 'anna']);
  await indexAendern(e.w, (ix) => { ix.dokumente[ID.team].freigaben = { ben: 'lesen' }; return ix; });
  const t = await officeZugriff(e.w, { id: ID.team }, K.ben);
  assert.deepEqual([t.recht, t.ueber, t.als.nutzer], ['bearbeiten', 'freigabe', 'ben'], 'schwächere Office-Freigabe ändert nichts');
});

test('Besitzer gesperrt oder gelöscht → E_RECHTE; Besitzer ohne Schreibrecht → nur lesen', async () => {
  await indexAendern(e.w, (ix) => { ix.dokumente[ID.privat2].besitzer = 'dora'; ix.dokumente[ID.privat2].freigaben = { cara: 'lesen' }; return ix; });
  await assert.rejects(officeZugriff(e.w, { id: ID.privat2 }, K.cara), (f) => f.code === 'E_RECHTE');
  await indexAendern(e.w, (ix) => { ix.dokumente[ID.privat2].besitzer = 'niemand'; return ix; });
  await assert.rejects(officeZugriff(e.w, { id: ID.privat2 }, K.cara), (f) => f.code === 'E_RECHTE');
  const shares = await e.u.konfig.laden('shares.json');
  shares.freigaben.find((f) => f.name === 'privat').schreiben = []; shares.freigaben.find((f) => f.name === 'privat').lesen = ['anna'];
  await e.u.konfig.speichern('shares.json', shares);
  const z = await officeZugriff(e.w, { id: ID.privat }, K.cara);
  assert.deepEqual([z.recht, z.ueber], ['lesen', 'office']);
  await assert.rejects(officeZugriff(e.w, { id: ID.privat }, K.cara, { schreiben: true }), (f) => f.code === 'E_RECHTE');
});

test('ohne jedes Recht über die ID → E_NICHT_GEFUNDEN ohne Hinweis; geloescht → details.office', async () => {
  await assert.rejects(officeZugriff(e.w, { id: ID.privat }, K.ben), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details === undefined);
  await assert.rejects(officeZugriff(e.w, { id: 'oZZZZZZZZZZZZZZZZ' }, K.anna), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await indexAendern(e.w, (ix) => { ix.dokumente[ID.team].geloescht = '2026-10-18T09:00:00.000Z'; return ix; });
  await assert.rejects(officeZugriff(e.w, { id: ID.team }, K.anna), (f) => f.code === 'E_NICHT_GEFUNDEN' && f.details.office === 'geloescht');
  await assert.rejects(officeZugriff(e.w, {}, K.anna), (f) => f.code === 'E_PARAMS' && f.details.feld === 'id');
});

test('Ort statt ID: Freigabe + Pfad, Eintrag darf fehlen; ohne Freigabe-Recht E_RECHTE', async () => {
  const z = await officeZugriff(e.w, { freigabe: 'team', pfad: 'Plan.fahboard' }, K.ben);
  assert.equal(z.eintrag.id, ID.team); assert.equal(z.recht, 'bearbeiten');
  const neu = await officeZugriff(e.w, { freigabe: 'team', pfad: 'Neu.fahboard' }, K.ben);
  assert.deepEqual([neu.eintrag, neu.recht, neu.ueber, neu.als.nutzer, neu.rel], [null, 'bearbeiten', 'freigabe', 'ben', 'Neu.fahboard']);
  await assert.rejects(officeZugriff(e.w, { freigabe: 'geheim', pfad: 'x.fahboard' }, K.ben), (f) => f.code === 'E_RECHTE');
});

test('Admin hat über die Freigabe immer bearbeiten (Sonderrecht bleibt)', async () => {
  const z = await officeZugriff(e.w, { id: ID.privat }, K.chef, { schreiben: true });
  assert.deepEqual([z.recht, z.ueber, z.als.nutzer], ['bearbeiten', 'freigabe', 'chef']);
});

test('Detailfeld office ist für Nutzer sichtbar', () => {
  assert.ok(DETAILS_FUER_NUTZER.includes('office')); assert.ok(DETAILS_FUER_ALLE.includes('office'));
});

test('Index 0600, zuletztMerken entdoppelt und kürzt auf 20; eintragAmOrt, pfadUnter', async () => {
  const datei = path.join(e.u.pfade.konfig, 'office.json');
  assert.equal((await fs.stat(datei)).mode & 0o777, 0o600);
  const ix = await indexLaden(e.w);
  for (let i = 0; i < 25; i++) zuletztMerken(ix, 'anna', `o${String(i).padStart(16, 'A')}`, `2026-10-18T08:${String(i).padStart(2, '0')}:00.000Z`);
  zuletztMerken(ix, 'anna', `o${String(3).padStart(16, 'A')}`, '2026-10-18T09:00:00.000Z');
  assert.equal(ix.zuletzt.anna.length, ZULETZT_MAX);
  assert.equal(ix.zuletzt.anna[0].id, `o${String(3).padStart(16, 'A')}`);
  assert.equal(ix.zuletzt.anna.filter((z) => z.id === `o${String(3).padStart(16, 'A')}`).length, 1);
  assert.equal(eintragAmOrt(ix, 'team', 'Plan.fahboard').id, ID.team);
  assert.equal(eintragAmOrt(ix, 'team', 'Weg.fahboard'), null);
  assert.equal(pfadUnter('a/b/c', 'a/b'), true); assert.equal(pfadUnter('a/bc', 'a/b'), false); assert.equal(pfadUnter('a/b', 'a/b'), true);
});

test('Bündel-Hilfen: inhaltBauen, schnappschuesseAn', async () => {
  const eintrag = { id: 'oAAAAAAAAAAAAAAAA', art: 'board', besitzer: 'anna', erstellt: '2026-10-18T08:00:00.000Z' };
  assert.deepEqual(inhaltBauen(eintrag, { version: 3, daten: { spalten: [] }, geaendert: '2026-10-18T09:00:00.000Z' }),
    { format: 'fah-office', art: 'board', schema: 1, id: 'oAAAAAAAAAAAAAAAA', version: 3, erstellt: '2026-10-18T08:00:00.000Z', geaendert: '2026-10-18T09:00:00.000Z', besitzer: 'anna', daten: { spalten: [] } });
  await e.u.konfig.speichern('snapshots.json', { plaene: [{ ziel: 'team', zeitplan: { stuendlich: false, taeglich: true, woechentlich: false } }, { ziel: 'privat', zeitplan: { stuendlich: false, taeglich: false, woechentlich: false } }] });
  assert.equal(await schnappschuesseAn(e.w, 'team'), true);
  assert.equal(await schnappschuesseAn(e.w, 'privat'), false);
  assert.equal(await schnappschuesseAn(e.w, 'lesen'), false);
});
