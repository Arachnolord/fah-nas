// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// TURN-Zugangsdaten (Plan 03, Aufgabe 3): username mit Ablauf, credential = HMAC, ICE-Server-Liste, Geheimnis in
// web/turn.json (32 Byte, 0600, bleibt erhalten).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmp } from './web_hilfen.js';
import { zugangsdaten, passwortFuer, usernameLesen, werVon, iceServer, geheimnisLaden, externMerken } from '../../src/web/turn/zugang.js';

const G = Buffer.alloc(32, 7);
test('zugangsdaten: Form, Ablauf 12 h, credential = HMAC', () => {
  const z = zugangsdaten(G, 'anna', 1_800_000_000_000);
  assert.deepEqual([z.username, z.ablauf_s], ['1800043200:anna', 1_800_043_200]);
  assert.equal(z.credential, crypto.createHmac('sha1', G).update('1800043200:anna').digest('base64'));
  assert.equal(passwortFuer(G, z.username), z.credential);
});
test('usernameLesen', () => {
  assert.deepEqual(usernameLesen('1800043200:gast-gAAAAAAAAAAAAAAAA'), { ablauf_s: 1_800_043_200, wer: 'gast-gAAAAAAAAAAAAAAAA' });
  for (const s of ['anna', '1:Anna', 'x:anna', '1800043200:anna:b', '1800043200:gast-kurz', '1800043200:m..w', '1800043200:m.']) assert.equal(usernameLesen(s), null);
  assert.deepEqual(usernameLesen('1800043200:m.mustermann'), { ablauf_s: 1_800_043_200, wer: 'm.mustermann' });
});
test('werVon und iceServer', () => {
  assert.equal(werVon({ art: 'gast', gast: 'gAAAAAAAAAAAAAAAA' }), 'gast-gAAAAAAAAAAAAAAAA');
  const z = { username: 'u', credential: 'c' };
  assert.deepEqual(iceServer({ lan_ip: '192.168.1.29', port: 3478, zugang: z }), [{ urls: ['stun:192.168.1.29:3478', 'turn:192.168.1.29:3478?transport=udp'], username: 'u', credential: 'c' }]);
  assert.deepEqual(iceServer({ lan_ip: '192.168.1.29', port: 3478, domain: 'nas.example', zugang: z })[0].urls.slice(2), ['stun:nas.example:3478', 'turn:nas.example:3478?transport=udp']);
});
test('geheimnisLaden: erzeugt 32 Byte, 0600, bleibt gleich; externMerken behält es', async () => {
  const o = await tmp();
  const a = await geheimnisLaden(o); const b = await geheimnisLaden(o);
  assert.equal(a.geheimnis.length, 32); assert.ok(a.geheimnis.equals(b.geheimnis)); assert.equal(a.extern_zuletzt, null);
  assert.equal((await fs.stat(path.join(o, 'turn.json'))).mode & 0o777, 0o600);
  await externMerken(o, '2026-10-18T10:00:00.000Z');
  const c = await geheimnisLaden(o); assert.ok(c.geheimnis.equals(a.geheimnis)); assert.equal(c.extern_zuletzt, '2026-10-18T10:00:00.000Z');
  await fs.writeFile(path.join(o, 'turn.json'), '{"version":1,"geheimnis":"kurz"}');
  assert.equal((await geheimnisLaden(o)).geheimnis.length, 32);
});
