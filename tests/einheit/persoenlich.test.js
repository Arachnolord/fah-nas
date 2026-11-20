// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V9 Persönliche Handy-Meldungen (Plan 02, Aufgabe 3): eigenes ntfy-Thema je Nutzer, Sperre je Schlüssel 120 s,
// Tagesgrenze 200 für das ganze NAS, wirft nie; Aktionen persoenlich_test / persoenlich_info.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';
import * as benachrichtigungen from '../../src/agent/aktionen/benachrichtigungen.js';
import { STANDARD } from '../../src/agent/aktionen/benachrichtigungen.js';
import { persoenlichSenden, PERSOENLICH_DATEI, TAGES_GRENZE, ABSTAND_MS, _test } from '../../src/agent/benachrichtigung/persoenlich.js';
import { AUSSCHLUSS } from '../../src/agent/export.js';

beforeEach(() => _test.zuruecksetzen());

async function umgebung(einstellung = { aktiv: true, thema: 'fah-nas-abcdefghijkl' }) {
  const u = await werkzeugeBauen({ module: [benachrichtigungen] });
  await u.konfig.speichern('users.json', { nutzer: [{ name: 'anna', rolle: 'nutzer', einstellungen: einstellung ? { benachrichtigung: einstellung } : {} }], gruppen: [] });
  await u.konfig.speichern('benachrichtigungen.json', { ...STANDARD, ntfy: { ...STANDARD.ntfy, aktiv: false, server: 'https://ntfy.example', token: 'tk' } });
  const gesendet = [];
  u.werkzeuge.holen = async (url, o) => { gesendet.push({ url, kopf: o.headers, body: JSON.parse(o.body) }); return { ok: true, status: 200 }; };
  let jetzt = Date.parse('2026-10-18T08:00:00Z');
  u.werkzeuge.jetzt = () => jetzt;
  return { u, gesendet, vor: (ms) => { jetzt += ms; } };
}

test('Konstanten', () => {
  assert.equal(PERSOENLICH_DATEI, 'benachrichtigungen-persoenlich.json');
  assert.equal(TAGES_GRENZE, 200);
  assert.equal(ABSTAND_MS, 120_000);
});

test('sendet an das persönliche Thema, auch wenn ntfy.aktiv aus ist; click gesetzt', async () => {
  const { u, gesendet } = await umgebung();
  try {
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 'Team', text: 'Ben: neue Nachricht', klick: 'https://nas.example/#/chat/r1', schluessel: 'chat:r1:anna' }), true);
    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].url, 'https://ntfy.example');
    assert.deepEqual([gesendet[0].body.topic, gesendet[0].body.title, gesendet[0].body.message, gesendet[0].body.click], ['fah-nas-abcdefghijkl', 'Team', 'Ben: neue Nachricht', 'https://nas.example/#/chat/r1']);
    assert.equal(gesendet[0].kopf.Authorization, 'Bearer tk');
  } finally { await u.aufraeumen(); }
});

test('click nur für http(s)', async () => {
  const { u, gesendet } = await umgebung();
  try {
    await persoenlichSenden(u.werkzeuge, 'anna', { titel: 'x', text: 'y', klick: 'javascript:alert(1)', schluessel: 'k1' });
    assert.equal('click' in gesendet[0].body, false);
  } finally { await u.aufraeumen(); }
});

test('aus, ohne Thema, ungültiges Thema, unbekannter Nutzer → false, nichts gesendet', async () => {
  for (const e of [{ aktiv: false, thema: 'fah-nas-abcdefghijkl' }, { aktiv: true, thema: '' }, { aktiv: true, thema: 'a b' }, null]) {
    const { u, gesendet } = await umgebung(e);
    try {
      assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'k' }), false);
      assert.equal(await persoenlichSenden(u.werkzeuge, 'niemand', { titel: 't', text: 'x', schluessel: 'k2' }), false);
      assert.equal(gesendet.length, 0);
    } finally { await u.aufraeumen(); }
  }
});

test('gleicher Schlüssel höchstens alle 120 s', async () => {
  const { u, gesendet, vor } = await umgebung();
  try {
    const m = { titel: 't', text: 'x', schluessel: 'chat:r1:anna' };
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', m), true);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', m), false);
    vor(119_999);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', m), false);
    vor(1);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', m), true);
    assert.equal(gesendet.length, 2);
  } finally { await u.aufraeumen(); }
});

test('Tagesgrenze 200 für das ganze NAS, Zähler in der Konfig, neuer Tag zählt neu', async () => {
  const { u, gesendet, vor } = await umgebung();
  const alt = process.stderr.write; const meldungen = [];
  process.stderr.write = (s) => { meldungen.push(String(s)); return true; };
  try {
    for (let i = 0; i < 200; i++) assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: `k${i}` }), true);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'k200' }), false);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'k201' }), false);
    assert.equal(gesendet.length, 200);
    assert.deepEqual(await u.konfig.laden(PERSOENLICH_DATEI), { tag: '2026-10-18', anzahl: 200, gemeldet: true });
    assert.equal(meldungen.filter((m) => m.includes('Tagesgrenze')).length, 1, 'nur einmal je Tag protokolliert');
    vor(24 * 3600_000);
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'k202' }), true);
  } finally { process.stderr.write = alt; await u.aufraeumen(); }
});

test('wirft nie: Netzfehler und kaputte users.json → false', async () => {
  const { u } = await umgebung();
  try {
    u.werkzeuge.holen = async () => { throw new Error('Netz weg'); };
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'a' }), false);
    await fs.writeFile(path.join(u.pfade.konfig, 'users.json'), 'kein json');
    assert.equal(await persoenlichSenden(u.werkzeuge, 'anna', { titel: 't', text: 'x', schluessel: 'b' }), false);
  } finally { await u.aufraeumen(); }
});

test('Aktionen persoenlich_test und persoenlich_info', async () => {
  const { u, gesendet } = await umgebung();
  try {
    assert.deepEqual(await u.als('anna')('benachrichtigungen.persoenlich_test', {}), { gesendet: true });
    assert.equal(gesendet[0].body.title, 'FAH-NAS');
    const info = await u.als('anna')('benachrichtigungen.persoenlich_info', {});
    assert.deepEqual(info, { server: 'https://ntfy.example' });
    assert.equal(JSON.stringify(info).includes('tk'), false, 'kein Token im Ergebnis');
  } finally { await u.aufraeumen(); }
});

test('Export schließt den Zähler aus', () => { assert.ok(AUSSCHLUSS.includes('benachrichtigungen-persoenlich.json')); });
