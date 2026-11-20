// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Admins sind root (Betreiber 11.11.2026): sudoers, sshd-Regel und Wrapper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-adminroot-'));
Object.assign(process.env, {
  FAHNAS_SUDOERS_ADMIN: path.join(wurzel, 'sudoers.d', 'fahnas-admin'),
  FAHNAS_SSHD_ADMIN: path.join(wurzel, 'sshd_config.d', 'fahnas-admin.conf'),
  FAHNAS_ADMIN_WRAPPER: path.join(wurzel, 'lib', 'admin-als-root'),
});
const { rendereAdminRoot, sudoersText, sshdText, wrapperText, pfade, SFTP_SERVER } = await import('../../src/agent/render/adminroot.js');
const ausf = promisify(execFile);

function systemAttrappe(fehlerBei = () => false) {
  const aufrufe = [];
  return {
    aufrufe,
    ausfuehren: async (prog, args) => {
      aufrufe.push([prog, ...args].join(' '));
      if (fehlerBei(prog, args)) { const e = new Error(`${prog} fehlgeschlagen`); e.details = { ausgabe: 'kaputt' }; throw e; }
      return { stdout: '', stderr: '' };
    },
  };
}

const allesWeg = () => Promise.all(Object.values(pfade).map((f) => fs.rm(f(), { force: true })));

test('Texte: nur die Admin-Gruppe, ohne Passwort, sshd-Block endet mit Match all', () => {
  assert.match(sudoersText(), /^%fahnas-admin ALL=\(ALL:ALL\) NOPASSWD: ALL$/m);
  const s = sshdText('/x/admin-als-root');
  assert.match(s, /^Match Group fahnas-admin$/m);
  assert.match(s, /^ {4}ForceCommand \/x\/admin-als-root$/m);
  assert.equal(s.trimEnd().split('\n').at(-1), 'Match all', 'sonst schluckt der Block die Hauptkonfiguration');
  for (const z of ['ChrootDirectory none', 'PermitTTY yes', 'AllowTcpForwarding yes']) {
    assert.ok(s.indexOf(`    ${z}`) > 0 && s.indexOf(`    ${z}`) < s.indexOf('ForceCommand'), `${z} vor ForceCommand – schlägt den SFTP-Block`);
  }
  assert.ok(!/ -H /.test(wrapperText()), 'sudo-rs kennt -H nicht');
  assert.ok(wrapperText().startsWith('#!/bin/sh\n'));
});

test('Rendern legt Wrapper, sudoers und sshd an, prüft vorher und ist danach idempotent', async () => {
  await allesWeg();
  const sys = systemAttrappe();
  const r = await rendereAdminRoot({ system: sys });
  assert.deepEqual(r.geaendert, ['wrapper', 'sudoers', 'sshd']);
  assert.deepEqual(sys.aufrufe, [`visudo -c -f ${pfade.sudoers()}.neu`, 'sshd -t', 'systemctl reload ssh.service']);
  assert.equal(await fs.readFile(pfade.sudoers(), 'utf8'), sudoersText());
  assert.equal(await fs.readFile(pfade.sshd(), 'utf8'), sshdText());
  assert.equal((await fs.stat(pfade.sudoers())).mode & 0o777, 0o440);
  assert.equal((await fs.stat(pfade.wrapper())).mode & 0o777, 0o755);
  await assert.rejects(fs.stat(`${pfade.sudoers()}.neu`), 'Zwischendatei ist weg');

  const sys2 = systemAttrappe();
  const r2 = await rendereAdminRoot({ system: sys2 });
  assert.deepEqual(r2.geaendert, []);
  assert.deepEqual(sys2.aufrufe, [], 'nichts neu laden, wenn alles stimmt');
});

test('ungültige sudoers-Regel wird nicht abgelegt, sshd bleibt unangetastet', async () => {
  await allesWeg();
  const sys = systemAttrappe((prog) => prog === 'visudo');
  await assert.rejects(rendereAdminRoot({ system: sys }), /sudo-Regel/);
  await assert.rejects(fs.stat(pfade.sudoers()));
  await assert.rejects(fs.stat(`${pfade.sudoers()}.neu`));
  await assert.rejects(fs.stat(pfade.sshd()), 'ohne sudoers keine Weiterleitung auf den Wrapper');
});

test('scheitert sshd -t, kommt der alte Stand zurück und es wird nicht neu geladen', async () => {
  await allesWeg();
  await fs.mkdir(path.dirname(pfade.sshd()), { recursive: true });
  await fs.writeFile(pfade.sshd(), '# alt\n');
  const sys = systemAttrappe((prog) => prog === 'sshd');
  await assert.rejects(rendereAdminRoot({ system: sys }), /SSH-Regel/);
  assert.equal(await fs.readFile(pfade.sshd(), 'utf8'), '# alt\n');
  assert.ok(!sys.aufrufe.includes('systemctl reload ssh.service'));

  await allesWeg();
  await assert.rejects(rendereAdminRoot({ system: systemAttrappe((prog) => prog === 'sshd') }));
  await assert.rejects(fs.stat(pfade.sshd()), 'neue Datei wird bei Fehler wieder entfernt');
});

// Wrapper echt ausführen, mit einem falschen sudo im PATH, das nur seine Argumente ausgibt.
async function wrapper(befehl, sudoGeht) {
  const bin = await fs.mkdtemp(path.join(wurzel, 'bin-'));
  await fs.writeFile(path.join(bin, 'sudo'), `#!/bin/sh\nif [ "$1 $2" = "-n true" ]; then exit ${sudoGeht ? 0 : 1}; fi\necho "SUDO $*"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'sftp-server'), '#!/bin/sh\necho "SFTP $*"\n', { mode: 0o755 });
  const skript = path.join(bin, 'wrapper.sh');
  await fs.writeFile(skript, wrapperText().replace(`sftp=${SFTP_SERVER}`, `sftp=${path.join(bin, 'sftp-server')}`), { mode: 0o755 });
  if (befehl !== null) befehl = befehl.replace('SFTP', path.join(bin, 'sftp-server'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: wurzel };
  if (befehl !== null) env.SSH_ORIGINAL_COMMAND = befehl;
  const { stdout } = await ausf('/bin/sh', [skript], { env });
  return stdout.trim();
}

test('Wrapper: Admin mit sudo – Befehl, SFTP und Shell laufen als root', async () => {
  assert.equal(await wrapper("sh -c 'ls -1ApL' sh L2RhdGE=", true), "SUDO -n -- /bin/bash -c sh -c 'ls -1ApL' sh L2RhdGE=");
  assert.match(await wrapper('SFTP', true), /^SUDO -n -- \S+\/sftp-server -u 0002$/);
  assert.match(await wrapper('internal-sftp', true), /^SUDO -n -- \S+\/sftp-server -u 0002$/);
  assert.match(await wrapper('ls -l SFTP', true), /^SUDO -n -- \/bin\/bash -c ls -l /, 'Befehl, der den Pfad nur erwähnt, bleibt ein Befehl');
  assert.equal(await wrapper(null, true), 'SUDO -n -i');
});

test('Wrapper: ohne sudo bleibt alles beim angemeldeten Nutzer', async () => {
  assert.equal(await wrapper('echo als-nutzer', false), 'als-nutzer');
  assert.equal(await wrapper('SFTP', false), 'SFTP', 'SFTP-Server ohne sudo und ohne -u');
});
