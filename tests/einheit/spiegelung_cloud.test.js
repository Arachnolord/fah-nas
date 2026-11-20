// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Cloud-Ziele der Spiegelung (Ausbau Oktober 2026): Verbindungen prüfen, rclone.conf (verschleierte Passwörter wie
// „rclone obscure“), Fehler deuten, Fortschritt/Statistik/Vorschau – und, wenn rclone installiert ist, ein echter Lauf
// gegen einen lokalen WebDAV-Server (rclone serve webdav): sichern, Papierkorb, Leer-Schutz, Vorschau, zurückholen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import * as system from '../../src/gemeinsam/system.js';
import {
  obscure, reveal, cloudNormal, cloudZugangNormal, rcloneKonfig, cloudFehlerDeuten, rcloneFortschritt, rcloneStatistik, rcloneVorschau, laufenCloud, cloudHost, fernPfad,
} from '../../src/agent/spiegelung/cloud.js';
import { zugangAnsicht } from '../../src/agent/spiegelung/regeln.js';

let rcloneDa = true; try { execFileSync('rclone', ['version'], { stdio: 'ignore' }); } catch { rcloneDa = false; }

test('cloud: obscure wie rclone (Rundweg; mit rclone reveal gegengeprüft, falls installiert)', () => {
  const o = obscure('Pa$$ wört#1');
  assert.equal(reveal(o), 'Pa$$ wört#1');
  assert.notEqual(obscure('x'), obscure('x'), 'zufälliger IV');
  if (rcloneDa) assert.equal(execFileSync('rclone', ['reveal', o]).toString().trim(), 'Pa$$ wört#1');
});

test('cloud: Verbindungen je Anbieter, Geheimnisse bleiben, Ansicht ohne Geheimnis', () => {
  const s3 = cloudNormal({ anbieter: 's3', endpunkt: 'https://fsn1.your-objectstorage.com/', schluessel_id: 'AKIA1', schluessel: 'geheim' });
  assert.deepEqual(s3, { art: 'cloud', anbieter: 's3', endpunkt: 'https://fsn1.your-objectstorage.com', region: '', schluessel_id: 'AKIA1', schluessel: 'geheim', adresse: 'fsn1.your-objectstorage.com', benutzer: 'AKIA1' });
  assert.equal(cloudNormal({ anbieter: 's3', schluessel_id: 'AKIA1', schluessel: '' }, s3).schluessel, 'geheim', 'leer = unverändert');
  assert.throws(() => cloudNormal({ anbieter: 's3', schluessel_id: 'A' }), (e) => e.details.feld === 'schluessel');
  assert.throws(() => cloudNormal({ anbieter: 'webdav', endpunkt: 'cloud.example.de', benutzer: 'a', passwort: 'b' }), (e) => e.details.feld === 'endpunkt');
  assert.throws(() => cloudNormal({ anbieter: 'gdrive' }), (e) => e.details.feld === 'anbieter');
  const sftp = cloudNormal({ anbieter: 'sftp', adresse: 'u1.your-storagebox.de', port: 23, benutzer: 'u1', passwort: 'p' });
  assert.deepEqual(cloudHost(sftp), { host: 'u1.your-storagebox.de', port: 23 });
  assert.deepEqual(cloudHost(s3), { host: 'fsn1.your-objectstorage.com', port: 443 });
  assert.deepEqual(cloudHost(cloudNormal({ anbieter: 'b2', schluessel_id: 'k', schluessel: 'a' })), { host: 'api.backblazeb2.com', port: 443 });
  const z = cloudZugangNormal({ name: 'Hetzner', anbieter: 's3', endpunkt: 'https://fsn1.your-objectstorage.com', schluessel_id: 'AKIA1', schluessel: 'geheim' }, { id: 'z-0123456789' });
  const a = zugangAnsicht(z, 2);
  assert.equal(a.art, 'cloud'); assert.equal(a.anbieter, 's3'); assert.equal(a.passwort_gesetzt, true); assert.equal(a.benutzt, 2);
  assert.ok(!JSON.stringify(a).includes('geheim'));
});

test('cloud: rclone.conf je Anbieter (Passwörter verschleiert, Schlüssel im Klartext wie rclone sie erwartet)', () => {
  const s3 = rcloneKonfig({ anbieter: 's3', endpunkt: 'https://x.example', region: 'eu', schluessel_id: 'K', schluessel: 'S' });
  assert.match(s3, /^\[fern\]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = K\nsecret_access_key = S\nendpoint = https:\/\/x\.example\nregion = eu\n$/);
  assert.match(rcloneKonfig({ anbieter: 's3', schluessel_id: 'K', schluessel: 'S' }), /provider = AWS/);
  assert.match(rcloneKonfig({ anbieter: 'b2', schluessel_id: 'K', schluessel: 'S' }), /type = b2\naccount = K\nkey = S/);
  const wd = rcloneKonfig({ anbieter: 'webdav', endpunkt: 'https://c/remote.php/dav/files/f', hersteller: 'nextcloud', benutzer: 'f', passwort: 'geheim' });
  const pass = /pass = (\S+)/.exec(wd)[1];
  assert.equal(reveal(pass), 'geheim'); assert.ok(!wd.includes('geheim')); assert.match(wd, /vendor = nextcloud/);
  assert.match(rcloneKonfig({ anbieter: 'sftp', adresse: 'h', port: 23, benutzer: 'u', passwort: 'p' }), /type = sftp\nhost = h\nport = 23\nuser = u\npass = \S+\nshell_type = none/);
  assert.equal(fernPfad('bucket', 'a/b'), 'fern:bucket/a/b'); assert.equal(fernPfad('bucket', ''), 'fern:bucket');
});

test('cloud: Fehler deuten, Fortschritt, Statistik, Vorschau', () => {
  assert.equal(cloudFehlerDeuten('Failed to create file system: dial tcp: lookup x: no such host').art, 'nicht_erreichbar');
  assert.equal(cloudFehlerDeuten('InvalidAccessKeyId: The AWS Access Key Id you provided does not exist').art, 'anmeldung');
  assert.equal(cloudFehlerDeuten('directory not found').art, 'fehlt');
  assert.equal(rcloneFortschritt('2026/10/12 15:00:01 NOTICE:     12.000 MiB / 40.000 MiB, 30%, 6.000 MiB/s, ETA 4s'), 0.3);
  assert.equal(rcloneFortschritt('2026/10/12 INFO  : a.txt: Copied (new)'), null);
  const st = rcloneStatistik(['2026/10/12 INFO  : O/b.txt: Copied (new)', '2026/10/12 INFO  : c.txt: Moved into backup dir', '2026/10/12 INFO  : c.txt: Copied (replaced existing)', '2026/10/12 INFO  : alt.txt: Moved (server-side)', '2026/10/12 INFO  : alt.txt: Moved into backup dir'], '2026/10/12 NOTICE:    1.500 MiB / 1.500 MiB, 100%, 0 B/s, ETA -');
  assert.deepEqual(st, { uebertragen: 2, geloescht: 1, neu: 1, bytes_uebertragen: 1572864 });
  const v = rcloneVorschau(['2026/10/12 NOTICE: a.txt: Skipped copy as --dry-run is set (size 3)', '2026/10/12 NOTICE: alt.txt: Skipped delete as --dry-run is set (size 1)', '2026/10/12 NOTICE: b.txt: Skipped update modification time as --dry-run is set']);
  assert.equal(v.neu, 1); assert.equal(v.geloescht, 1); assert.deepEqual(v.zeilen, ['+ a.txt', '− alt.txt']);
});

/** Freier Port. */
const freierPort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

function prozess(programm, argumente, { umgebung, beiZeile, abgebrochen }) {
  return new Promise((ok) => {
    const k = spawn(programm, argumente, { env: { ...process.env, ...umgebung }, stdio: ['ignore', 'pipe', 'pipe'] });
    const zeilen = []; let rest = '';
    const lesen = (b) => { rest += b.toString(); const t = rest.split(/[\r\n]/); rest = t.pop(); for (const z of t) if (z && !(beiZeile && beiZeile(z))) zeilen.push(z); };
    k.stdout.on('data', lesen); k.stderr.on('data', lesen);
    const wache = setInterval(() => { if (abgebrochen && abgebrochen()) k.kill('SIGTERM'); }, 500);
    k.on('close', (code) => { clearInterval(wache); if (rest) zeilen.push(rest); ok({ code: code ?? -1, zeilen }); });
  });
}

test('cloud: echter Lauf gegen lokalen WebDAV-Server (rclone serve webdav)', { skip: rcloneDa ? false : 'rclone fehlt' }, async () => {
  const w0 = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cloud-'));
  const port = await freierPort();
  const dav = path.join(w0, 'dav'); const lokal = path.join(w0, 'lokal'); const zurueck = path.join(w0, 'zurueck');
  await fs.mkdir(path.join(dav, 'sicherung'), { recursive: true }); await fs.mkdir(path.join(lokal, 'Ordner'), { recursive: true });
  await fs.writeFile(path.join(lokal, 'a.txt'), 'eins'); await fs.writeFile(path.join(lokal, 'Ordner', 'b.txt'), 'zwei');
  const server = spawn('rclone', ['serve', 'webdav', dav, '--addr', `127.0.0.1:${port}`, '--user', 'fabian', '--pass', 'Geh eim#1'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); }); if (ok) break; await new Promise((r) => setTimeout(r, 200)); }
    const z = { id: 'z-0000000001', name: 'Test-DAV', ...cloudNormal({ anbieter: 'webdav', endpunkt: `http://127.0.0.1:${port}`, hersteller: 'other', benutzer: 'fabian', passwort: 'Geh eim#1' }) };
    const w = { system };
    const auftrag = { id: 's-test', richtung: 'einseitig', quelle: { freigabe: 'private', pfad: 'x' }, ziel: { zugang: z.id, freigabe: 'sicherung', pfad: 'nas' } };
    const opt = { lokal: { voll: lokal, anzeige: 'private/x' }, prozess, melde: () => {} };
    const v = await laufenCloud(w, auftrag, z, { ...opt, vorschau: true });
    assert.equal(v.vorschau.neu, 2, 'Vorschau zeigt zwei neue Dateien');
    await assert.rejects(fs.access(path.join(dav, 'sicherung', 'nas', 'a.txt')), 'Vorschau ändert nichts');
    const r1 = await laufenCloud(w, auftrag, z, { ...opt, jetzt: new Date('2026-10-12T10:00:00') });
    assert.equal(r1.ergebnis, 'ok'); assert.equal(r1.zahlen.uebertragen, 2);
    assert.equal(await fs.readFile(path.join(dav, 'sicherung', 'nas', 'Ordner', 'b.txt'), 'utf8'), 'zwei');
    // Löschen → landet im Papierkorb der Cloud
    await fs.rm(path.join(lokal, 'a.txt'));
    await laufenCloud(w, auftrag, z, { ...opt, jetzt: new Date('2026-10-12T11:00:00') });
    await assert.rejects(fs.access(path.join(dav, 'sicherung', 'nas', 'a.txt')));
    assert.equal(await fs.readFile(path.join(dav, 'sicherung', 'nas', '.fah-papierkorb', '2026-10-12_110000', 'a.txt'), 'utf8'), 'eins');
    // Leer-Schutz
    await fs.rm(path.join(lokal, 'Ordner'), { recursive: true });
    await assert.rejects(laufenCloud(w, auftrag, z, opt), (e) => e.details.grund === 'quelle_leer');
    // Cloud → NAS
    const holen = { ...auftrag, quelle: auftrag.ziel, ziel: { freigabe: 'private', pfad: 'zurueck' } };
    const r3 = await laufenCloud(w, holen, z, { ...opt, lokal: { voll: zurueck, anzeige: 'private/zurueck' } });
    assert.equal(r3.ergebnis, 'ok');
    assert.equal(await fs.readFile(path.join(zurueck, 'Ordner', 'b.txt'), 'utf8'), 'zwei');
    await assert.rejects(fs.access(path.join(zurueck, '.fah-papierkorb')), 'Papierkorb der Cloud wird nicht mitgeholt');
    // falsches Passwort
    const falsch = { ...z, passwort: 'nein' };
    await fs.writeFile(path.join(lokal, 'c.txt'), 'drei');
    await assert.rejects(laufenCloud(w, auftrag, falsch, opt), (e) => e.code === 'E_RECHTE');
    await assert.rejects(laufenCloud(w, { ...auftrag, richtung: 'beidseitig' }, z, opt), (e) => e.details.feld === 'richtung');
  } finally { server.kill('SIGTERM'); await fs.rm(w0, { recursive: true, force: true }); }
});
