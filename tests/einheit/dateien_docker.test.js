// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests System-Freigabe „docker“ im Dateimanager (Betreiber 12.10.2026): nur Admins, nur bei eingeschaltetem
// docker_freigabe, Dateihelfer dort als root, sonst als Nutzer; keine Download-Links; freigaben.liste {mit_system}.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { freigabeRechte, idsFuer, dockerAnsicht, registriere as regDateien } from '../../src/agent/aktionen/dateien.js';
import { registriere as regFreigaben } from '../../src/agent/aktionen/freigaben.js';

const ADMIN = { nutzer: 'chef', rolle: 'admin', ip: '-' };
const NUTZER = { nutzer: 'lisa', rolle: 'nutzer', ip: '-' };

async function umgebung(dockerFreigabe) {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-docker-'));
  const apps = path.join(wurzel, 'apps'); const shares = path.join(wurzel, 'shares');
  await fs.mkdir(path.join(apps, 'gitea'), { recursive: true }); await fs.mkdir(shares, { recursive: true });
  const konfig = new Konfig(path.join(wurzel, 'konfig')); await konfig.sicherstellen();
  await konfig.aendern('system.json', (s) => { s.docker_freigabe = dockerFreigabe; });
  await konfig.speichern('shares.json', { freigaben: [] });
  const ids = [];
  const system = { nutzerIds: async (n) => { ids.push(n); return { uid: 1001, gid: 1001, gruppen: [980] }; }, existiert: async () => true, ausfuehren: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const w = { konfig, system, pfade: { shares, apps, konfig: path.join(wurzel, 'konfig') }, ereignis: () => {}, konfigGeaendert: () => {} };
  return { w, apps, ids, aufraeumen: () => fs.rm(wurzel, { recursive: true, force: true }) };
}

test('docker-Freigabe: nur Admins, nur bei eingeschaltetem Schalter', async () => {
  const an = await umgebung(true);
  const aus = await umgebung(false);
  try {
    const r = await freigabeRechte(an.w, 'docker', ADMIN);
    assert.equal(r.wurzel, an.apps); assert.ok(r.lesen && r.schreiben); assert.equal(r.freigabe.papierkorb, false); assert.equal(r.freigabe.system, true);
    await assert.rejects(freigabeRechte(an.w, 'docker', NUTZER), /gibt es nicht/, 'Nutzer sehen den App-Ordner nicht');
    await assert.rejects(freigabeRechte(aus.w, 'docker', ADMIN), /gibt es nicht/, 'Schalter aus → keine Freigabe');
    assert.ok(await dockerAnsicht(an.w, ADMIN));
    assert.equal(await dockerAnsicht(an.w, NUTZER), null);
    assert.equal(await dockerAnsicht(aus.w, ADMIN), null);
  } finally { await an.aufraeumen(); await aus.aufraeumen(); }
});

test('docker-Freigabe: Dateihelfer als root nur im App-Ordner und nur für Admins', async () => {
  const u = await umgebung(true);
  try {
    assert.deepEqual(await idsFuer(u.w, ADMIN, u.apps), { uid: 0, gid: 0, gruppen: [] });
    assert.deepEqual(await idsFuer(u.w, ADMIN, '/data/shares/private', u.apps), { uid: 0, gid: 0, gruppen: [] }, 'Kopieren zwischen Freigabe und App-Ordner');
    assert.equal((await idsFuer(u.w, ADMIN, '/data/shares/private')).uid, 1001, 'normale Freigabe → als Nutzer');
    assert.equal((await idsFuer(u.w, NUTZER, u.apps)).uid, 1001, 'Nicht-Admin nie als root');
    assert.deepEqual(u.ids, ['chef', 'lisa']);
  } finally { await u.aufraeumen(); }
});

test('docker-Freigabe: freigaben.liste nur mit mit_system, keine Download-Links', async () => {
  const u = await umgebung(true);
  try {
    const reg = new Register(); regFreigaben(reg, u.w); regDateien(reg, u.w);
    const rufe = async (name, params, k) => { const { aktion, params: p } = reg.vorbereiten(name, params, k); return aktion.ausfuehren(p, k, u.w); };
    assert.deepEqual((await rufe('freigaben.liste', {}, ADMIN)).map((f) => f.name), [], 'Freigaben-Verwaltung sieht docker nicht');
    assert.deepEqual((await rufe('freigaben.liste', { mit_system: true }, ADMIN)).map((f) => f.name), ['docker']);
    assert.deepEqual((await rufe('freigaben.liste', { mit_system: true }, NUTZER)).map((f) => f.name), []);
    await assert.rejects(rufe('dateien.link.anlegen', { freigabe: 'docker', pfad: 'gitea', gueltig_h: 1 }, ADMIN), /keine Download-Links/);
  } finally { await u.aufraeumen(); }
});
