// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Mehrfach-Umbenennen (Betreiber 12.10.2026): „001“ → „001 (01).mkv“, „001 (02).mkv“ … – Endung bleibt, Reihenfolge
// der Auswahl, mindestens zweistellig, Tausch innerhalb der Auswahl, Abbruch ohne Änderung bei fremden Namen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serienNamen, endungVon, ausfuehrenOp } from '../../src/agent/helfer/dateihelfer.js';

test('serie: Endungen und Nummern', () => {
  assert.equal(endungVon('clip.mkv'), '.mkv'); assert.equal(endungVon('archiv.tar.gz'), '.tar.gz'); assert.equal(endungVon('.env'), '');
  assert.equal(endungVon('ohne'), ''); assert.equal(endungVon('Ordner.mit.punkt', true), '');
  assert.equal(endungVon('Plan.fahboard', true), '.fahboard'); assert.equal(endungVon('Brief.FAHDOC', true), '.FAHDOC'); assert.equal(endungVon('.fahtab', true), '');
  assert.deepEqual(serienNamen([{ alt: 'Plan.fahboard', ordner: true }], 'Q').map((z) => z.neu), ['Q (01).fahboard'], 'Office-Dokumente behalten ihre Endung');
  assert.deepEqual(serienNamen([{ alt: 'b.mkv' }, { alt: 'a.MP4' }, { alt: 'Ordner', ordner: true }], '001').map((z) => z.neu), ['001 (01).mkv', '001 (02).MP4', '001 (03)']);
  const viele = serienNamen(Array.from({ length: 120 }, (_, i) => ({ alt: `f${i}.jpg` })), 'Urlaub');
  assert.equal(viele[0].neu, 'Urlaub (001).jpg'); assert.equal(viele[119].neu, 'Urlaub (120).jpg');
});

async function ordnerMit(dateien) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-serie-'));
  for (const [n, inhalt] of Object.entries(dateien)) await fs.writeFile(path.join(w, n), inhalt);
  return w;
}

test('serie: umbenennen in einem Zug – Namen tauschen sich gefahrlos, Inhalte bleiben zugeordnet', async () => {
  const w = await ordnerMit({ 'c.mkv': 'C', 'a.mkv': 'A', '001 (02).mkv': 'alt-zwei', 'fremd.txt': 'x' });
  try {
    const r = await ausfuehrenOp('umbenennen_serie', { wurzel: w, pfad: '', namen: ['a.mkv', '001 (02).mkv', 'c.mkv'], basis: ' 001 ' });
    assert.equal(r.anzahl, 3);
    assert.deepEqual((await fs.readdir(w)).sort(), ['001 (01).mkv', '001 (02).mkv', '001 (03).mkv', 'fremd.txt']);
    assert.equal(await fs.readFile(path.join(w, '001 (01).mkv'), 'utf8'), 'A');
    assert.equal(await fs.readFile(path.join(w, '001 (02).mkv'), 'utf8'), 'alt-zwei');
    assert.equal(await fs.readFile(path.join(w, '001 (03).mkv'), 'utf8'), 'C');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('serie: fremder Eintrag mit neuem Namen → Abbruch, nichts verändert; ungültige Eingaben', async () => {
  const w = await ordnerMit({ 'a.txt': 'A', 'b.txt': 'B', 'x (01).txt': 'fremd' });
  try {
    await assert.rejects(ausfuehrenOp('umbenennen_serie', { wurzel: w, pfad: '', namen: ['a.txt', 'b.txt'], basis: 'x' }), /gibt es hier schon/);
    assert.deepEqual((await fs.readdir(w)).sort(), ['a.txt', 'b.txt', 'x (01).txt']);
    await assert.rejects(ausfuehrenOp('umbenennen_serie', { wurzel: w, pfad: '', namen: ['a.txt', 'a.txt'], basis: 'y' }), /doppelt/);
    await assert.rejects(ausfuehrenOp('umbenennen_serie', { wurzel: w, pfad: '', namen: ['a.txt', 'gibtsnicht'], basis: 'y' }), /nicht/);
    await assert.rejects(ausfuehrenOp('umbenennen_serie', { wurzel: w, pfad: '', namen: ['a.txt'], basis: 'a/b' }));
    assert.deepEqual((await fs.readdir(w)).sort(), ['a.txt', 'b.txt', 'x (01).txt'], 'nach allen Fehlern unverändert');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('ordnergroesse: Summe samt Unterordnern, Papierkorb und Links zählen nicht, kein Ausbruch', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-ogr-'));
  try {
    await fs.mkdir(path.join(w, 'a', 'b', 'c'), { recursive: true });
    await fs.mkdir(path.join(w, '.papierkorb', 'x'), { recursive: true });
    await fs.writeFile(path.join(w, 'a', 'eins.bin'), Buffer.alloc(1000));
    await fs.writeFile(path.join(w, 'a', 'b', 'zwei.bin'), Buffer.alloc(250));
    await fs.writeFile(path.join(w, 'a', 'b', 'c', 'drei.bin'), Buffer.alloc(5));
    await fs.writeFile(path.join(w, '.papierkorb', 'x', 'alt.bin'), Buffer.alloc(9999));
    await fs.symlink('/etc', path.join(w, 'a', 'link'));
    assert.deepEqual(await ausfuehrenOp('ordnergroesse', { wurzel: w, pfad: 'a' }), { groesse: 1255, dateien: 3, ordner: 2, vollstaendig: true, uebersprungen: 0 });
    const ganz = await ausfuehrenOp('ordnergroesse', { wurzel: w, pfad: '' });
    assert.equal(ganz.groesse, 1255, 'Papierkorb der Freigabe zählt nicht');
    await assert.rejects(ausfuehrenOp('ordnergroesse', { wurzel: w, pfad: 'a/eins.bin' }), /nicht gefunden/);
    await assert.rejects(ausfuehrenOp('ordnergroesse', { wurzel: w, pfad: '../..' }));
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});
