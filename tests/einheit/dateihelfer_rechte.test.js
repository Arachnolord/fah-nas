// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rechte-Bits beim Ersetzen (Abschlussprüfung Plan 01, Befund 2): Auf Laufwerken ohne Unix-Rechte (FAT/exFAT/NTFS,
// Dateien gehören root) scheitert chmod mit EPERM – das Speichern muss trotzdem gelingen (Texteditor und Office).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ausfuehrenOp } from '../../src/agent/helfer/dateihelfer.js';

let wurzel;
beforeEach(async () => { wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'rechte-')); });
afterEach(async () => { await fs.rm(wurzel, { recursive: true, force: true }); });
const eperm = async () => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); };

test('text_schreiben: chmod mit EPERM wird übergangen', async (t) => {
  await fs.writeFile(path.join(wurzel, 'a.txt'), 'alt');
  await fs.chmod(path.join(wurzel, 'a.txt'), 0o666);
  t.mock.method(fs, 'chmod', eperm);
  const r = await ausfuehrenOp('text_schreiben', { wurzel, pfad: 'a.txt', inhalt: 'neu' });
  assert.equal(r.name, 'a.txt');
  assert.equal(await fs.readFile(path.join(wurzel, 'a.txt'), 'utf8'), 'neu');
});

test('text_schreiben: andere chmod-Fehler bleiben Fehler', async (t) => {
  await fs.writeFile(path.join(wurzel, 'a.txt'), 'alt');
  await fs.chmod(path.join(wurzel, 'a.txt'), 0o666);
  t.mock.method(fs, 'chmod', async () => { throw Object.assign(new Error('Ein-/Ausgabefehler'), { code: 'EIO' }); });
  await assert.rejects(ausfuehrenOp('text_schreiben', { wurzel, pfad: 'a.txt', inhalt: 'neu' }));
  assert.equal(await fs.readFile(path.join(wurzel, 'a.txt'), 'utf8'), 'alt');
});

test('office_schreiben: chmod mit EPERM wird übergangen', async (t) => {
  const inhalt = { format: 'fah-office', art: 'board', schema: 1, id: 'oAAAAAAAAAAAAAAAA', version: 0, daten: null };
  await ausfuehrenOp('office_anlegen', { wurzel, rel_ordner: '', name: 'Plan', endung: '.fahboard', inhalt });
  await fs.chmod(path.join(wurzel, 'Plan.fahboard', 'inhalt.json'), 0o666);
  t.mock.method(fs, 'chmod', eperm);
  await ausfuehrenOp('office_schreiben', { wurzel, rel: 'Plan.fahboard', inhalt: { ...inhalt, version: 1 }, verlauf: [{ v: 1, op: {}, cid: 'c' }] });
  assert.equal(JSON.parse(await fs.readFile(path.join(wurzel, 'Plan.fahboard', 'inhalt.json'), 'utf8')).version, 1);
});
