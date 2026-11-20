// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigener SSH-Port (Betreiber 11.11.2026): sshd-Port, ssh.socket, Rücknahme bei Fehlern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-sshport-'));
Object.assign(process.env, {
  FAHNAS_SSHD_PORT: path.join(wurzel, 'sshd_config.d', 'fahnas-port.conf'),
  FAHNAS_SSH_SOCKET: path.join(wurzel, 'ssh.socket.d', 'fahnas-port.conf'),
});
const { rendereSshPort, pruefeSshPort, pfade, sshdText, socketText } = await import('../../src/agent/render/sshport.js');
const { nftText } = await import('../../src/agent/render/firewall.js');

function attrappe(fehlerBei = () => false) {
  const aufrufe = [];
  return { aufrufe, ausfuehren: async (prog, args) => {
    aufrufe.push([prog, ...args].join(' '));
    if (fehlerBei(prog, args)) { const e = new Error(`${prog} kaputt`); e.details = { ausgabe: 'kaputt' }; throw e; }
    return { code: 0, stdout: '', stderr: '' };
  } };
}
const lesen = (f) => fs.readFile(f, 'utf8').catch(() => null);
const weg = () => Promise.all([fs.rm(pfade.sshd(), { force: true }), fs.rm(pfade.socket(), { force: true })]);

test('Port-Prüfung: 22 oder 1024–65535, nichts, was FAH-NAS selbst belegt', () => {
  assert.equal(pruefeSshPort(22), 22);
  assert.equal(pruefeSshPort(2222), 2222);
  assert.equal(pruefeSshPort('2222'), 2222);
  for (const p of [0, 21, 80, 443, 445, 1023, 8443, 65536, 1.5, 'abc']) assert.throws(() => pruefeSshPort(p), (e) => e.code === 'E_PARAMS' && e.details.feld === 'ssh_port', String(p));
});

test('eigener Port: sshd und Socket umgestellt, neu geladen, zweiter Lauf ändert nichts, 22 räumt auf', async () => {
  await weg();
  const s = attrappe();
  assert.deepEqual(await rendereSshPort(2222, { system: s }), { port: 2222, geaendert: true });
  assert.equal(await lesen(pfade.sshd()), sshdText(2222));
  assert.equal(await lesen(pfade.socket()), socketText(2222));
  assert.match(socketText(2222), /^ListenStream=\n/m, 'Ubuntus Port 22 wird erst geleert');
  assert.match(socketText(2222), /^BindIPv6Only=ipv6-only$/m, 'IPv4 und IPv6 getrennt binden');
  assert.deepEqual(s.aufrufe, ['sshd -t', 'systemctl daemon-reload', 'systemctl try-restart ssh.socket', 'systemctl try-restart ssh.service']);

  const s2 = attrappe();
  assert.equal((await rendereSshPort(2222, { system: s2 })).geaendert, false);
  assert.deepEqual(s2.aufrufe, []);

  const s3 = attrappe();
  assert.equal((await rendereSshPort(22, { system: s3 })).geaendert, true);
  assert.equal(await lesen(pfade.sshd()), null); assert.equal(await lesen(pfade.socket()), null);
  assert.ok(s3.aufrufe.includes('systemctl try-restart ssh.socket'));
});

test('sshd -t lehnt ab: alter Stand bleibt, Socket wird nicht angefasst', async () => {
  await weg();
  await fs.mkdir(path.dirname(pfade.sshd()), { recursive: true });
  await fs.writeFile(pfade.sshd(), sshdText(2222));
  await assert.rejects(rendereSshPort(2222, { system: attrappe((p) => p === 'sshd') }), (e) => e.code === 'E_RENDER');
  assert.equal(await lesen(pfade.sshd()), sshdText(2222));
  assert.equal(await lesen(pfade.socket()), null);
});

test('Neustart scheitert: beide Dateien zurück und Socket erneut gestartet', async () => {
  await weg();
  const s = attrappe((p, a) => p === 'systemctl' && a[1] === 'ssh.socket' && s.aufrufe.filter((x) => x === 'systemctl try-restart ssh.socket').length === 1);
  await assert.rejects(rendereSshPort(2222, { system: s }), (e) => e.code === 'E_RENDER');
  assert.equal(await lesen(pfade.sshd()), null); assert.equal(await lesen(pfade.socket()), null);
  assert.equal(s.aufrufe.filter((x) => x === 'systemctl try-restart ssh.socket').length, 2, 'Rücknahme startet den Socket wieder');
});

test('Firewall-Übersicht nennt den eigenen SSH-Port', () => {
  assert.match(nftText({ ssh: true, ssh_port: 2222 }), /tcp dport 2222 accept comment "SSH/);
  assert.match(nftText({ ssh: true }), /tcp dport 22 accept comment "SSH/);
  assert.match(nftText({ ssh: false, ssh_port: 2222 }), /# SSH \(2222\/tcp\) ist ausgeschaltet/);
});
