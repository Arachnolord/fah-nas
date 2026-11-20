// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldeschutz (16.10.2026): Internet oder Heimnetz/VPN, Rechenaufgabe (Browser-Löser gegen Server-Prüfung), Ablauf,
// Schwierigkeit je Fehlversuch, Bremse mit festen Stufen 1 h / 24 h.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Anmeldeschutz, istExtern, nullBits } from '../../src/web/anmeldeschutz.js';
import { loesen } from '../../public/anmeldung-aufgabe.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-schutz-'));

test('istExtern: öffentliche Adressen ja; Heimnetz, VPN, CGNAT, Loopback, IPv6-ULA nein', () => {
  for (const ip of ['203.0.113.5', '8.8.4.4', '2a00:1450::1']) assert.equal(istExtern(ip), true, ip);
  for (const ip of ['192.168.1.146', '192.168.5.3', '172.21.0.2', '100.64.1.1', '127.0.0.1', 'fd00::1', '-', '', undefined]) assert.equal(istExtern(ip), false, String(ip));
});

test('Rechenaufgabe: Browser-Löser trifft die Server-Prüfung; IP-Bindung, Ablauf, einmalig, Schwierigkeit steigt mit Fehlversuchen', async () => {
  let jetzt = 1_800_000_000_000;
  const s = new Anmeldeschutz({ ordner: await tmp(), agent: null, systemKonfig: () => ({}), jetzt: () => jetzt, bits: 10, gastKontext: () => ({}) });
  await s.laden();
  const { aufgabe, bits } = s.aufgabe('203.0.113.5');
  assert.equal(bits, 10);
  const l = loesen(aufgabe, bits);
  assert.ok(nullBits(crypto.createHash('sha256').update(`${aufgabe}:${l}`).digest()) >= 10, 'eigenes SHA-256 = node:crypto');
  assert.throws(() => s.aufgabePruefen('203.0.113.6', aufgabe, l), (e) => e.code === 'E_PARAMS');
  s.aufgabePruefen('203.0.113.5', aufgabe, l);
  assert.throws(() => s.aufgabePruefen('203.0.113.5', aufgabe, l), /schon benutzt/);
  const alt = s.aufgabe('203.0.113.5');
  jetzt += 6 * 60_000;
  assert.throws(() => s.aufgabePruefen('203.0.113.5', alt.aufgabe, loesen(alt.aufgabe, alt.bits)), /abgelaufen/);
  assert.throws(() => s.aufgabePruefen('203.0.113.5', 'a.b.c.d', '1'), (e) => e.code === 'E_PARAMS');
  assert.throws(() => s.aufgabePruefen('203.0.113.5', alt.aufgabe, 'x'), (e) => e.code === 'E_PARAMS');
  // Fehlversuche machen die Aufgabe schwerer (je Fehler +1 Bit, je Sperrstufe +2)
  s.bremse.fehler('203.0.113.5', '@internet:x'); s.bremse.fehler('203.0.113.5', '@internet:x');
  assert.equal(s.aufgabe('203.0.113.5').bits, 12);
  assert.equal(nullBits(Buffer.from([0, 0x0f])), 12); assert.equal(nullBits(Buffer.from([0x80])), 0);
});

test('Bremse aus dem Internet: 3 Fehler → 1 h, nächste Sperre 24 h, eigene Datei', async () => {
  const ordner = await tmp();
  const s = new Anmeldeschutz({ ordner, agent: { aktion: async () => ({ land: 'DE', stadt: 'X' }) }, systemKonfig: () => ({}), gastKontext: () => ({}) });
  await s.laden();
  let ms = 0;
  for (let i = 0; i < 3; i++) ms = await s.fehlversuch('203.0.113.5', 'fabian');
  assert.equal(ms, 3_600_000);
  assert.throws(() => s.bremse.pruefen('203.0.113.5', '-'), (e) => e.code === 'E_BREMSE' && e.details.warte_s > 3500);
  s.bremse.eintraege.ip['203.0.113.5'].bis = 0; s.bremse.eintraege.nutzer['@internet:fabian'].bis = 0;
  for (let i = 0; i < 3; i++) ms = await s.fehlversuch('203.0.113.5', 'fabian');
  assert.equal(ms, 24 * 3_600_000);
  await s.stoppen();
  assert.ok((await fs.readdir(ordner)).includes('bremse-extern.json'));
  // Länder: leere Liste = alle; DE erlaubt; unbekannt gesperrt
  const l = new Anmeldeschutz({ ordner, agent: { aktion: async (_a, { ip }) => ({ land: ip === '1.1.1.1' ? null : 'DE' }) }, systemKonfig: () => ({ anmeldeschutz: { laender: ['de'] } }), gastKontext: () => ({}) });
  await l.landPruefen('203.0.113.5');
  await assert.rejects(l.landPruefen('1.1.1.1'), (e) => e.code === 'E_RECHTE' && e.details.grund === 'land');
});
