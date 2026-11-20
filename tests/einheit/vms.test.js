// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests VMs (Teilprojekt 3): Eingaben, virt-install-Argumente (Linux/Windows/Brücke), virsh-Auswertung, Aktionen mit
// Schein-virsh – und der Konsolenweg Ende zu Ende: Browser-WebSocket → Webdienst (konsole.js) → Datenkanal (Ticket „tcp“)
// → TCP-Dienst (hier ein Echo statt VNC), samt Ablehnung fremder Herkunft, fremder Sitzung und verbrauchter Tickets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import * as r from '../../src/agent/vms/regeln.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import * as vms from '../../src/agent/aktionen/vms.js';
import { Datenkanal } from '../../src/agent/datenkanal.js';
import { konsoleUpgrade, rahmen, rahmenLesen, annahmeSchluessel, PFAD } from '../../src/web/konsole.js';
import { Ticketmerker } from '../../src/web/api/dateien.js';

test('vms: Eingaben prüfen (Grenzen, Windows-Mindestwerte, ISO nur aus Freigaben)', () => {
  const host = { cpus: 4, ram_mb: 30000 };
  const v = r.vmNormal({ name: 'AllInOne', system: 'linux', cpu: 2, ram_mb: 4096, platte_gb: 40, iso: '/data/shares/iso/u.iso', netz: 'bruecke', autostart: true }, { host, isos: ['/data/shares/iso/u.iso'] });
  assert.deepEqual(v, { name: 'allinone', system: 'linux', cpu: 2, ram_mb: 4096, platte_gb: 40, iso: '/data/shares/iso/u.iso', netz: 'bruecke', firmware: 'uefi', tpm: false, autostart: true, titel: '' });
  assert.throws(() => r.vmNormal({ name: 'a b', cpu: 1, ram_mb: 1024, platte_gb: 10 }, { host }), (e) => e.details.feld === 'name');
  assert.throws(() => r.vmNormal({ name: 'x', cpu: 5, ram_mb: 1024, platte_gb: 10 }, { host }), (e) => e.details.feld === 'cpu');
  assert.throws(() => r.vmNormal({ name: 'x', cpu: 1, ram_mb: 29500, platte_gb: 10 }, { host }), (e) => e.details.feld === 'ram_mb', '1 GB bleibt fürs NAS');
  assert.throws(() => r.vmNormal({ name: 'x', system: 'windows', cpu: 2, ram_mb: 2048, platte_gb: 80 }, { host }), /mindestens 4096/);
  assert.throws(() => r.vmNormal({ name: 'x', system: 'windows', cpu: 2, ram_mb: 4096, platte_gb: 40 }, { host }), /64 GB/);
  assert.throws(() => r.vmNormal({ name: 'x', cpu: 1, ram_mb: 1024, platte_gb: 10, iso: '/etc/passwd' }, { host, isos: [] }), (e) => e.details.feld === 'iso');
  assert.throws(() => r.vmNormal({ name: 'x', cpu: 1, ram_mb: 1024, platte_gb: 10 }, { host, vorhanden: ['x'] }), (e) => e.code === 'E_EXISTIERT');
  const w = r.vmNormal({ name: 'win', system: 'windows', cpu: 2, ram_mb: 8192, platte_gb: 80, firmware: 'bios' }, { host });
  assert.equal(w.firmware, 'uefi'); assert.equal(w.tpm, true);
});

test('vms: virt-install-Argumente (Linux NAT, Windows mit TPM, Brücke)', () => {
  const host = { cpus: 4, ram_mb: 30000 };
  const l = r.virtInstallArgumente(r.vmNormal({ name: 'l', cpu: 2, ram_mb: 2048, platte_gb: 20, iso: '/i.iso' }, { host, isos: ['/i.iso'] }), { plattePfad: '/data/vms/l/platte.qcow2' }).join(' ');
  assert.match(l, /--name l --memory 2048 --vcpus 2 --cpu host-passthrough --disk path=\/data\/vms\/l\/platte\.qcow2,size=20,format=qcow2,bus=virtio,cache=none,discard=unmap --cdrom \/i\.iso --osinfo detect=on,require=off --network network=default,model=virtio --graphics vnc,listen=127\.0\.0\.1 --video virtio --boot uefi --noautoconsole --wait 0/);
  const w = r.virtInstallArgumente(r.vmNormal({ name: 'w', system: 'windows', cpu: 2, ram_mb: 8192, platte_gb: 80, netz: 'bruecke' }, { host }), { plattePfad: '/p', schnittstelle: 'eno1', osinfo: 'win11' }).join(' ');
  assert.match(w, /bus=sata/); assert.match(w, /--import/); assert.match(w, /--osinfo win11/); assert.match(w, /type=direct,source=eno1,source_mode=bridge,model=e1000e/);
  assert.match(w, /--tpm emulator,model=tpm-crb,version=2\.0/); assert.match(w, /--video qxl/);
  assert.ok(!r.virtInstallArgumente(r.vmNormal({ name: 'b', cpu: 1, ram_mb: 1024, platte_gb: 8, firmware: 'bios' }), { plattePfad: '/p' }).includes('--boot'));
});

test('vms: virsh-Ausgaben auswerten', () => {
  assert.deepEqual(r.dominfoParsen('Id:             3\nName:           allinone\nState:          running\nCPU(s):         4\nMax memory:     8388608 KiB\nUsed memory:    8388608 KiB\nAutostart:      enable\nTitle:          allinone Suite\n'), { zustand: 'running', cpu: 4, ram_mb: 8192, autostart: true, titel: 'allinone Suite' });
  assert.equal(r.zustandKurz('shut off'), 'aus'); assert.equal(r.zustandKurz('running'), 'laeuft'); assert.equal(r.zustandKurz('paused'), 'pause'); assert.equal(r.zustandKurz('crashed'), 'fehler');
  assert.equal(r.vncPort('127.0.0.1:0\n'), 5900); assert.equal(r.vncPort(':3'), 5903); assert.equal(r.vncPort('error: Requested operation is not valid'), null);
  assert.equal(r.ipAus(' Name       MAC address          Protocol     Address\n-------------------------------------------------------------------------------\n vnet0      52:54:00:12:34:56    ipv4         192.168.122.57/24\n'), '192.168.122.57');
  const blk = r.plattenParsen(' Type   Device   Target   Source\n----------------------------------------\n file   disk     vda      /data/vms/l/platte.qcow2\n file   cdrom    sda      /data/shares/iso/u.iso\n');
  assert.deepEqual(blk, { platten: ['/data/vms/l/platte.qcow2'], cd: '/data/shares/iso/u.iso', cd_ziel: 'sda' });
  assert.equal(r.plattenParsen(' Type   Device   Target   Source\n---\n file   cdrom    sda      -\n').cd, null);
});

test('vms: Aktionen mit Schein-virsh – Liste, Anlegen (Windows: win11 unbekannt → win10), Steuern, Löschen', async () => {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-vms-'));
  const shares = path.join(wurzel, 'shares', 'iso'); await fs.mkdir(shares, { recursive: true }); await fs.writeFile(path.join(shares, 'win.iso'), 'x');
  const aufrufe = []; const da = new Set();
  const system = { ausfuehren: async (p, a) => {
    aufrufe.push([p, ...a].join(' '));
    if (p === 'virsh') {
      const b = a.slice(2);
      if (b[0] === 'list') return { stdout: [...da].join('\n') };
      if (b[0] === 'dominfo') return { stdout: 'State:          shut off\nCPU(s):         2\nMax memory:     8388608 KiB\nAutostart:      disable\n' };
      if (b[0] === 'domblklist') return { stdout: ` Type Device Target Source\n---\n file disk sda ${path.join(wurzel, 'vms', b[1], 'platte.qcow2')}\n` };
      if (b[0] === 'undefine') { if (b.includes('--tpm')) throw new Error('unknown option --tpm'); da.delete(b[1]); return { stdout: '' }; }
      return { stdout: '' };
    }
    if (p === 'virt-install') {
      if (a.includes('win11')) throw new FahnasFehler('E_SYSTEM', 'virt-install fehlgeschlagen', { ausgabe: 'ERROR    Unknown OS name \'win11\'' });
      da.add(a[a.indexOf('--name') + 1]); return { stdout: '' };
    }
    if (p === 'chattr' || p === 'ip') return { stdout: '[]' };
    throw new Error(p);
  } };
  const konfig = { laden: async (n, s) => (n === 'shares.json' ? { freigaben: [{ name: 'iso', pfad: shares }] } : s) };
  const w = { system, konfig, pfade: { vms: path.join(wurzel, 'vms') }, konfigGeaendert: () => {}, intern: async () => ({}) };
  const akt = {}; vms.registriere({ aktion: (n, d) => { akt[n] = d; } }, w);
  const rufe = (n, p = {}) => akt[n].ausfuehren(p, { nutzer: 'fabian' }, w, { fortschritt: () => {} });
  try {
    const isos = await rufe('vms.isos');
    assert.deepEqual(isos.map((i) => [i.name, i.ort]), [['win.iso', 'iso']]);
    const v = await rufe('vms.anlegen', { name: 'win', system: 'windows', cpu: 2, ram_mb: 4096, platte_gb: 64, iso: isos[0].pfad });
    assert.equal(v.name, 'win');
    assert.ok(aufrufe.some((x) => x.startsWith('virt-install') && x.includes('--osinfo win10')), 'Rückfall auf win10');
    assert.ok(aufrufe.includes(`chattr +C ${path.join(wurzel, 'vms', 'win')}`));
    await assert.rejects(rufe('vms.anlegen', { name: 'win', cpu: 1, ram_mb: 1024, platte_gb: 8 }), (e) => e.code === 'E_EXISTIERT');
    await rufe('vms.steuern', { name: 'win', aktion: 'start' });
    assert.ok(aufrufe.includes('virsh -c qemu:///system start win'));
    await rufe('vms.loeschen', { name: 'win' });
    assert.ok(aufrufe.includes('virsh -c qemu:///system undefine win --nvram'), 'Rückfall ohne --tpm');
    await assert.rejects(fs.access(path.join(wurzel, 'vms', 'win')));
  } finally { await fs.rm(wurzel, { recursive: true, force: true }); }
});

test('konsole: WebSocket-Rahmen und Annahme-Schlüssel (RFC 6455)', () => {
  assert.equal(annahmeSchluessel('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const maske = Buffer.from([1, 2, 3, 4]);
  const maskiert = (daten, op = 2) => { const k = rahmen(daten, op); const kopfLen = k.length - daten.length; const kopf = Buffer.from(k.subarray(0, kopfLen)); kopf[1] |= 0x80; const n = Buffer.from(daten.map((b, i) => b ^ maske[i & 3])); return Buffer.concat([kopf, maske, n]); };
  for (const groesse of [5, 300, 70000]) {
    const d = crypto.randomBytes(groesse);
    const r1 = rahmenLesen(Buffer.concat([maskiert(d), maskiert(Buffer.from('x'))]));
    assert.equal(r1.rahmen.length, 2); assert.ok(r1.rahmen[0].daten.equals(d)); assert.equal(r1.rest.length, 0);
  }
  const teil = maskiert(Buffer.from('hallo')).subarray(0, 5);
  assert.equal(rahmenLesen(teil).rahmen.length, 0, 'unvollständig → warten');
  assert.throws(() => rahmenLesen(rahmen(Buffer.from('x'))), /unmaskiert/);
});

test('konsole: Ende zu Ende – WebSocket → Webdienst → Datenkanal → TCP (Echo), Ablehnungen', async () => {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-konsole-'));
  const echo = net.createServer((s) => s.pipe(s)); await new Promise((ok) => echo.listen(0, '127.0.0.1', ok));
  const dk = new Datenkanal(path.join(wurzel, 'daten.sock')); await dk.starten();
  const tickets = new Ticketmerker();
  const sitzung = { id: 's1', nutzer: 'fabian', rolle: 'admin' };
  const auth = { sitzungAus: async (req) => (String(req.headers.cookie || '').includes('sitzung=s1') ? sitzung : null) };
  const server = http.createServer((q, a) => { a.writeHead(404); a.end(); });
  server.on('upgrade', konsoleUpgrade({ auth, tickets, agent: { datenSocket: dk.socketPfad }, protokoll: { eintrag: () => {} } }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const neuesTicket = () => { const t = { ...dk.ticket({ nutzer: 'fabian', uid: 0, gid: 0, art: 'tcp', host: '127.0.0.1', port: echo.address().port, pfad: '-', dateiname: 'k' }), art: 'konsole' }; tickets.merken(t, 's1', 'fabian'); return t.ticket; };
  const verbinden = (ticket, { origin = `http://127.0.0.1:${port}`, cookie = 'sitzung=s1' } = {}) => new Promise((ok) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${PFAD}?ticket=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`));
    let puffer = Buffer.alloc(0);
    s.on('data', (d) => { puffer = Buffer.concat([puffer, d]); const i = puffer.indexOf('\r\n\r\n'); if (i >= 0) { s.removeAllListeners('data'); ok({ s, kopf: puffer.subarray(0, i).toString(), rest: puffer.subarray(i + 4) }); } });
    s.on('error', () => {});
  });
  try {
    assert.throws(() => dk.ticket({ nutzer: 'x', uid: 0, gid: 0, art: 'tcp', host: '10.0.0.1', port: 22, pfad: '-', dateiname: 'k' }), /127\.0\.0\.1/);
    const t1 = neuesTicket();
    const { s, kopf } = await verbinden(t1);
    assert.match(kopf, /^HTTP\/1\.1 101/); assert.match(kopf, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); assert.match(kopf, /Sec-WebSocket-Protocol: binary/);
    const nachricht = Buffer.from('RFB 003.008\n');
    const maske = Buffer.from([9, 8, 7, 6]);
    s.write(Buffer.concat([Buffer.from([0x82, 0x80 | nachricht.length]), maske, Buffer.from(nachricht.map((b, i) => b ^ maske[i & 3]))]));
    const antwort = await new Promise((ok) => { let p = Buffer.alloc(0); s.on('data', (d) => { p = Buffer.concat([p, d]); if (p.length >= 2 + nachricht.length) ok(p); }); });
    assert.equal(antwort[0], 0x82); assert.equal(antwort[1], nachricht.length); assert.ok(antwort.subarray(2).equals(nachricht), 'Echo kommt über den ganzen Weg zurück');
    s.destroy();
    assert.match((await verbinden(t1)).kopf, /^HTTP\/1\.1 404/, 'Ticket ist verbraucht');
    assert.match((await verbinden(neuesTicket(), { origin: 'https://boese.example' })).kopf, /^HTTP\/1\.1 403/, 'fremde Herkunft');
    assert.match((await verbinden(neuesTicket(), { cookie: 'sitzung=fremd' })).kopf, /^HTTP\/1\.1 401/, 'ohne Sitzung');
  } finally { server.close(); echo.close(); dk.server?.close(); await fs.rm(wurzel, { recursive: true, force: true }); }
});

test('vms: Fehlertext aus der ERROR-Zeile von virt-install', () => {
  const ausgabe = "WARNING  Treating --wait 0 as --noautoconsole\nERROR    Cannot access storage file '/data/vms/x/platte.qcow2' (as uid:64055, gid:992): Permission denied\nDomain installation does not appear to have been successful.\notherwise, please restart your installation.\n";
  assert.match(vms.virtFehlerText({ details: { ausgabe } }), /^Cannot access storage file .* Permission denied$/);
  assert.equal(vms.virtFehlerText({ message: 'kaputt' }), 'kaputt');
});
