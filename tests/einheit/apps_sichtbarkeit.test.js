// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// App-Sichtbarkeit je Nutzer (Plan 07, Aufgabe 1): Nicht-Admins sehen nur freigegebene Apps; Katalog, Details und
// Protokolle sind Admins vorbehalten; die Freigabe überlebt Bearbeiten.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { registriere, appSichtbar } from '../../src/agent/aktionen/apps.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const K = { chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, anna: { nutzer: 'anna', rolle: 'nutzer', ip: '-' } };
const USERS = { nutzer: [{ name: 'chef', rolle: 'admin', gruppen: [] }, { name: 'anna', rolle: 'nutzer', gruppen: ['familie'] }], gruppen: [{ name: 'familie' }] };
let u;

/** Kleine Umgebung nach dem Muster von apps.test.js: echte Konfig, Docker antwortet leer (keine Container). */
async function umgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-apps-sicht-'));
  const pfade = { apps: path.join(w, 'data', 'apps'), shares: path.join(w, 'data', 'shares'), konfig: path.join(w, 'config'), katalog: path.join(HIER, '..', 'daten', 'katalog'), backup: path.join(w, 'data', 'backup'), nft: path.join(w, 'nft', 'fahnas.nft'), run: path.join(w, 'run') };
  for (const [k, p] of Object.entries(pfade)) if (k !== 'katalog') await fs.mkdir(k === 'nft' ? path.dirname(p) : p, { recursive: true });
  const konfig = new Konfig(pfade.konfig); await konfig.sicherstellen();
  await konfig.speichern('users.json', USERS);
  const werkzeuge = { konfig, system: { ausfuehren: async () => ({ code: 0, stdout: '', stderr: '' }) }, pfade, ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} } };
  const reg = new Register(); registriere(reg, werkzeuge);
  async function auf(name, params, kontext = K.chef) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    return aktion.ausfuehren(p, kontext, werkzeuge, { fortschritt() {}, abgebrochen: () => false });
  }
  return { w, konfig, reg, auf, aufraeumen: () => fs.rm(w, { recursive: true, force: true }) };
}

/** Ein installierter App-Satz wie vor 0.21.0 – ohne Feld sichtbar_fuer. */
async function satzOhneFeld(name) {
  await u.konfig.speichern(`apps/${name}/app.json`, { name, titel: 'Gitea', katalog_id: 'x', kategorie: 'Werkzeuge', webui: '', ports: [], dienste: [], vorlage: { id: 'x', quelle: 'eingebaut', compose: '', felder: [] }, werte: {}, autostart: true });
}

beforeEach(async () => { u = await umgebung(); await satzOhneFeld('gitea'); });
afterEach(async () => { await u.aufraeumen(); });

test('Satz ohne Feld = nur Admins; Liste je Rolle', async () => {
  const admin = await u.auf('apps.liste', {}, K.chef);
  assert.equal(admin.length, 1);
  assert.deepEqual(admin[0].sichtbar_fuer, []);
  assert.deepEqual(await u.auf('apps.liste', {}, K.anna), []);
});

test('Freigabe für Gruppe und Nutzer; Nicht-Admins bekommen gekürzte Einträge', async () => {
  await u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['@familie'] }, K.chef);
  const l = await u.auf('apps.liste', {}, K.anna);
  assert.equal(l.length, 1);
  for (const feld of ['sichtbar_fuer', 'risiken', 'quelle', 'zip', 'portkonflikt']) assert.equal(feld in l[0], false, feld);
  // anna nicht mehr in der Gruppe → nicht mehr sichtbar
  await u.konfig.speichern('users.json', { ...USERS, nutzer: [USERS.nutzer[0], { name: 'anna', rolle: 'nutzer', gruppen: [] }] });
  assert.deepEqual(await u.auf('apps.liste', {}, K.anna), []);
  await u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['anna'] }, K.chef);
  assert.equal((await u.auf('apps.liste', {}, K.anna)).length, 1);
});

test('unbekannte Namen → E_PARAMS; Sortierung und Doppel', async () => {
  await assert.rejects(u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['gibtsnicht'] }, K.chef), (e) => e.code === 'E_PARAMS' && e.details.feld === 'sichtbar_fuer');
  await assert.rejects(u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['@keinegruppe'] }, K.chef), (e) => e.code === 'E_PARAMS');
  const r = await u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['anna', '@familie', 'anna'] }, K.chef);
  assert.deepEqual(r, { name: 'gitea', sichtbar_fuer: ['@familie', 'anna'] });
  await assert.rejects(u.auf('apps.sichtbarkeit', { name: 'gibtsnicht', sichtbar_fuer: [] }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
});

test('Feld überlebt apps.aendern (Autostart)', async () => {
  await u.auf('apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['anna'] }, K.chef);
  await u.auf('apps.aendern', { name: 'gitea', autostart: false }, K.chef);
  const satz = await u.konfig.laden('apps/gitea/app.json');
  assert.equal(satz.autostart, false);
  assert.deepEqual(satz.sichtbar_fuer, ['anna']);
});

test('Nicht-Admins: Details, Protokoll, Katalog, Sichtbarkeit → E_RECHTE', () => {
  for (const [a, p] of [['apps.details', { name: 'gitea' }], ['apps.protokoll', { name: 'gitea' }], ['apps.katalog.liste', {}], ['apps.katalog.eintrag', { id: 'test-nginx' }], ['apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: [] }]]) {
    assert.throws(() => u.reg.vorbereiten(a, p, K.anna), (e) => e.code === 'E_RECHTE', a);
  }
});

test('appSichtbar ist rein', () => {
  const users = { nutzer: [{ name: 'anna', gruppen: ['familie'] }] };
  assert.equal(appSichtbar({ sichtbar_fuer: [] }, K.chef, users), true);
  assert.equal(appSichtbar({}, K.anna, users), false);
  assert.equal(appSichtbar({ sichtbar_fuer: ['@familie'] }, K.anna, users), true);
  assert.equal(appSichtbar({ sichtbar_fuer: ['anna'] }, K.anna, users), true);
  assert.equal(appSichtbar({ sichtbar_fuer: ['tom'] }, K.anna, users), false);
});
