// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatare (0.22.0, Betreiber 19.10.2026: „möglichkeit ein avatar/bild zu hinterlegen was dann als userbild überall
// angezeigt wird“): nutzer.avatar.setzen/lesen/loeschen und nutzer.avatare. Nur PNG, JPEG oder WebP bis 300 KB, nur das
// eigene Konto (Admins alle); die Version steht in users.json, die Datei unter config/avatare/<name>; beim Löschen des
// Nutzers ist sie mit weg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';

const PW = 'sehr-geheim-123';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);
const b64 = (b) => b.toString('base64');
const GAST = { nutzer: 'web', rolle: 'gast', ip: '1.2.3.4' };

async function umgebung() {
  const u = await werkzeugeBauen({ module: [nutzer, freigaben] });
  await u.system('nutzer.anlegen', { name: 'chef', anzeigename: 'Der Chef', passwort: PW, rolle: 'admin' });
  await u.admin('nutzer.anlegen', { name: 'anna', anzeigename: 'Anna', passwort: PW, rolle: 'nutzer' });
  await u.admin('nutzer.anlegen', { name: 'ben', passwort: PW, rolle: 'nutzer' });
  return u;
}
const datei = (u, name) => path.join(u.pfade.konfig, 'avatare', name);
const da = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

test('avatar: eigenes Bild setzen und lesen, Versionen für alle Angemeldeten, Version in der Nutzerliste', async () => {
  const u = await umgebung();
  try {
    const anna = u.als('anna');
    const { v } = await anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(PNG) });
    assert.match(v, /^[0-9a-f]{12}$/);
    assert.deepEqual(await fs.readFile(datei(u, 'anna')), PNG);
    assert.deepEqual(await u.als('ben')('nutzer.avatare', {}), { anna: v });
    assert.deepEqual(await u.als('ben')('nutzer.avatar.lesen', { name: 'anna' }), { mime: 'image/png', v, daten: b64(PNG) });
    const liste = await u.admin('nutzer.liste', {});
    assert.equal(liste.find((n) => n.name === 'anna').avatar, v);
    assert.equal(liste.find((n) => n.name === 'ben').avatar, null);
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'nutzer'), 'Änderung wird gemeldet (Oberflächen laden neu)');
    const neu = await anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(WEBP) });
    assert.notEqual(neu.v, v, 'neues Bild → neue Version, der Browser lädt es neu');
    assert.equal((await anna('nutzer.avatar.lesen', { name: 'anna' })).mime, 'image/webp');
    // Anzeigename ändern lässt das Bild stehen
    await u.admin('nutzer.aendern', { name: 'anna', anzeigename: 'Anna A.' });
    assert.deepEqual(await anna('nutzer.avatare', {}), { anna: neu.v });
  } finally { await u.aufraeumen(); }
});

test('avatar: nur für das eigene Konto – Admins dürfen alle, Gäste gar nichts', async () => {
  const u = await umgebung();
  try {
    await assert.rejects(u.als('ben')('nutzer.avatar.setzen', { name: 'anna', daten: b64(PNG) }), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.als('ben')('nutzer.avatar.loeschen', { name: 'anna' }), (e) => e.code === 'E_RECHTE');
    const { v } = await u.admin('nutzer.avatar.setzen', { name: 'anna', daten: b64(JPEG) });
    assert.equal((await u.als('anna')('nutzer.avatar.lesen', { name: 'anna' })).mime, 'image/jpeg');
    assert.deepEqual(await u.admin('nutzer.avatare', {}), { anna: v });
    for (const a of ['nutzer.avatare', 'nutzer.avatar.lesen', 'nutzer.avatar.setzen', 'nutzer.avatar.loeschen']) {
      await assert.rejects(u.rufen(a, { name: 'anna', daten: b64(PNG) }, GAST), (e) => e.code === 'E_RECHTE', a);
    }
  } finally { await u.aufraeumen(); }
});

test('avatar: nur PNG, JPEG oder WebP bis 300 KB; unbekannter Nutzer; bei Fehlern bleibt alles, wie es war', async () => {
  const u = await umgebung();
  try {
    const anna = u.als('anna');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    await assert.rejects(anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(svg) }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'daten');
    await assert.rejects(anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(Buffer.from('GIF89a......')) }), (e) => e.code === 'E_PARAMS');
    const gross = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
    await assert.rejects(anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(gross) }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'daten');
    await assert.rejects(anna('nutzer.avatar.setzen', { name: 'anna', daten: 'kein base64!' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(anna('nutzer.avatar.setzen', { name: 'anna', daten: '' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.avatar.setzen', { name: 'niemand', daten: b64(PNG) }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.equal(await da(datei(u, 'anna')), false);
    assert.equal(await da(datei(u, 'niemand')), false);
    assert.deepEqual(await anna('nutzer.avatare', {}), {});
    await assert.rejects(anna('nutzer.avatar.lesen', { name: 'anna' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('avatar: entfernen; beim Löschen des Nutzers ist das Bild mit weg', async () => {
  const u = await umgebung();
  try {
    const anna = u.als('anna');
    await anna('nutzer.avatar.setzen', { name: 'anna', daten: b64(PNG) });
    assert.deepEqual(await anna('nutzer.avatar.loeschen', { name: 'anna' }), { name: 'anna' });
    assert.equal(await da(datei(u, 'anna')), false);
    assert.deepEqual(await anna('nutzer.avatare', {}), {});
    await assert.rejects(anna('nutzer.avatar.lesen', { name: 'anna' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.deepEqual(await anna('nutzer.avatar.loeschen', { name: 'anna' }), { name: 'anna' }, 'ohne Bild: nichts zu tun, kein Fehler');
    await u.als('ben')('nutzer.avatar.setzen', { name: 'ben', daten: b64(PNG) });
    await u.admin('nutzer.loeschen', { name: 'ben', dateien: 'behalten' });
    assert.equal(await da(datei(u, 'ben')), false);
    assert.deepEqual(await anna('nutzer.avatare', {}), {});
  } finally { await u.aufraeumen(); }
});
