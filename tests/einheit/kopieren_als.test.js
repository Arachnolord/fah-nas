// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V10 Kopieren als anderer Nutzer (Plan 02, Aufgabe 6): Quelle (z. B. Chat-Speicher als root) → Zwischendatei im
// Zielordner als Ziel-Nutzer → ablegen ohne Überschreiben; Platzprüfung, Namensprüfung, Aufräumen bei Fehlern.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chatUmgebung } from './chat_hilfen.js';
import { kopierenAls, stromKopieren } from '../../src/agent/helfer/kopieren_als.js';

let e;
const ANNA = { nutzer: 'anna', rolle: 'nutzer', ip: '-' };
const ROOT = { uid: 0, gid: 0, gruppen: [] };
beforeEach(async () => { e = await chatUmgebung(); });
afterEach(async () => { await e.aufraeumen(); });
const reste = async (ordner) => (await fs.readdir(ordner)).filter((n) => n.startsWith('.fahnas-upload-'));

test('kopiert in die Freigabe, Namenskonflikt → „Name (1).ext“, keine Zwischendatei bleibt', async () => {
  const quelle = path.join(e.u.w, 'quelle.txt'); await fs.writeFile(quelle, 'Inhalt');
  const ziel = path.join(e.shares, 'team');
  const a = await kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'bericht.txt', zielKontext: ANNA });
  const b = await kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'bericht.txt', zielKontext: ANNA });
  assert.deepEqual([a.name, b.name], ['bericht.txt', 'bericht (1).txt']); // wie beim Hochladen in FAH-NAS (freierName)
  assert.equal(a.pfad, path.join(ziel, 'bericht.txt'));
  assert.equal(await fs.readFile(b.pfad, 'utf8'), 'Inhalt');
  assert.deepEqual(await reste(ziel), []);
});

test('beiVorhanden fehler → E_EXISTIERT', async () => {
  const quelle = path.join(e.u.w, 'q.txt'); await fs.writeFile(quelle, 'x');
  const ziel = path.join(e.shares, 'team');
  await kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'a.txt', zielKontext: ANNA, beiVorhanden: 'fehler' });
  await assert.rejects(kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'a.txt', zielKontext: ANNA, beiVorhanden: 'fehler' }), (f) => f.code === 'E_EXISTIERT');
});

test('Namen mit Pfadteilen und ersetzen → E_PARAMS, nichts entsteht', async () => {
  const quelle = path.join(e.u.w, 'q.txt'); await fs.writeFile(quelle, 'x');
  const ziel = path.join(e.shares, 'team');
  for (const zielName of ['../x.txt', 'a/b', '', '.versteckt/../x']) {
    await assert.rejects(kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName, zielKontext: ANNA }), (f) => f.code === 'E_PARAMS', zielName);
  }
  await assert.rejects(kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'ok.txt', zielKontext: ANNA, beiVorhanden: 'ersetzen' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'bei_vorhanden');
  assert.deepEqual(await fs.readdir(ziel), []);
  assert.deepEqual(await fs.readdir(e.u.w).then((l) => l.filter((n) => n === 'x.txt')), []);
});

test('zu wenig Platz → E_PLATZ {noetig, frei}, keine Zwischendatei', async () => {
  const quelle = path.join(e.u.w, 'q.txt'); await fs.writeFile(quelle, 'sechs!');
  const ziel = path.join(e.shares, 'team');
  const alt = e.w.system.ausfuehren;
  e.w.system.ausfuehren = async (p, a, o) => (p === 'df' ? { code: 0, stdout: '1B-blocks Avail\n1000 3\n', stderr: '' } : alt(p, a, o));
  await assert.rejects(kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'a.txt', zielKontext: ANNA }), (f) => f.code === 'E_PLATZ' && f.details.noetig === 6 && f.details.frei === 3);
  assert.deepEqual(await fs.readdir(ziel), []);
});

test('Quelle fehlt → E_NICHT_GEFUNDEN, keine Datei', async () => {
  const ziel = path.join(e.shares, 'team');
  await assert.rejects(kopierenAls(e.w, { quelleAbs: path.join(e.u.w, 'gibtsnicht'), quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'a.txt', zielKontext: ANNA }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  assert.deepEqual(await fs.readdir(ziel), []);
});

test('Fehler beim Kopieren verwirft die Zwischendatei', async () => {
  const quelle = path.join(e.u.w, 'q.txt'); await fs.writeFile(quelle, 'x');
  const ziel = path.join(e.shares, 'team');
  const alt = e.w.system.starten;
  e.w.system.starten = (p, a, o) => (p === 'cat' ? alt('false', [], o) : alt(p, a, o));
  await assert.rejects(kopierenAls(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielOrdnerAbs: ziel, zielName: 'a.txt', zielKontext: ANNA }), (f) => f.code === 'E_SYSTEM');
  e.w.system.starten = alt;
  assert.deepEqual(await fs.readdir(ziel), []);
});

test('stromKopieren meldet Bytes', async () => {
  const daten = crypto.randomBytes(70000);
  const quelle = path.join(e.u.w, 'gross.bin'); await fs.writeFile(quelle, daten);
  const zielAbs = path.join(e.u.w, 'kopie.bin');
  assert.equal(await stromKopieren(e.w, { quelleAbs: quelle, quelleIds: ROOT, zielAbs, zielIds: { uid: 2000, gid: 100 } }), 70000);
  assert.deepEqual(await fs.readFile(zielAbs), daten);
});
