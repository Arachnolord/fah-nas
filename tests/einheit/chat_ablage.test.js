// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Ablage (Plan 02, Aufgabe 1): Kennungen, btrfs-Unterlaufwerk /data/chat (0700), raum.json mit 0600.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../../src/gemeinsam/pfade.js';
import {
  nachrichtId, dmId, neueRaumId, neueGastId, neueAnhangId, neueEinladungId, S, ablageSicherstellen, chatKonfig, raumDatei,
  DATEIMODUS, _test,
} from '../../src/agent/chat/ablage.js';
import { chatUmgebung } from './chat_hilfen.js';

test('Kennungen: Form, Sortierung, DM symmetrisch', () => {
  assert.match(nachrichtId(0), /^n000000000[0-9a-z]{6}$/);
  assert.ok(nachrichtId(1_000) < nachrichtId(2_000));
  assert.equal(nachrichtId().length, 16);
  assert.equal(dmId('anna', 'ben'), dmId('ben', 'anna'));
  assert.match(dmId('anna', 'ben'), /^d[A-Za-z0-9_-]{20}$/);
  assert.match(neueRaumId(), S.raum.muster); assert.match(dmId('a', 'b'), S.raum.muster);
  assert.match(neueGastId(), S.gast.muster); assert.match(neueAnhangId(), S.anhang.muster); assert.match(neueEinladungId(), S.einladung.muster);
  assert.match(nachrichtId(), S.nachricht.muster);
});

test('ablageSicherstellen: btrfs-Unterlaufwerk, 0700, Unterordner, nur einmal', async () => {
  const e = await chatUmgebung();
  try {
    _test.zuruecksetzen();
    await ablageSicherstellen(e.w); await ablageSicherstellen(e.w);
    assert.equal(e.u.scheins.befehle.filter((b) => b.programm === 'btrfs').length, 1);
    assert.equal((await fs.stat(e.chat)).mode & 0o777, 0o700);
    for (const o of ['raeume', 'anhaenge']) assert.equal((await fs.stat(path.join(e.chat, o))).mode & 0o777, 0o700);
  } finally { await e.aufraeumen(); }
});

test('ablageSicherstellen: btrfs scheitert → mkdir genügt', async () => {
  const e = await chatUmgebung();
  try {
    _test.zuruecksetzen();
    e.u.scheins.fehlschlag = (p) => (p === 'btrfs' ? { code: 1, stderr: 'kein btrfs' } : null);
    await ablageSicherstellen(e.w);
    assert.equal((await fs.stat(e.chat)).isDirectory(), true);
    assert.equal((await fs.stat(e.chat)).mode & 0o777, 0o700);
  } finally { await e.aufraeumen(); }
});

test('chatKonfig schreibt raum.json mit 0600 unter raeume/<id>/', async () => {
  const e = await chatUmgebung();
  try {
    _test.zuruecksetzen();
    const id = neueRaumId(); await ablageSicherstellen(e.w);
    await chatKonfig(e.w).speichern(raumDatei(id), { schema: 1, id }, DATEIMODUS);
    assert.equal((await fs.stat(path.join(e.chat, 'raeume', id, 'raum.json'))).mode & 0o777, 0o600);
    // auch ohne ausdrücklichen Modus 0600
    await chatKonfig(e.w).speichern(raumDatei(id), { schema: 1, id, zwei: true });
    assert.equal((await fs.stat(path.join(e.chat, 'raeume', id, 'raum.json'))).mode & 0o777, 0o600);
  } finally { await e.aufraeumen(); }
});

test('PFADE.chat Standard /data/chat', () => { assert.equal(PFADE.chat, process.env.FAHNAS_CHAT || '/data/chat'); });
