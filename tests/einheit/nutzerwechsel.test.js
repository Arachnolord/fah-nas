// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Betreiber-Fund 26.09.: eingehängtes exFAT-Laufwerk (Ventoy) weder sichtbar noch beschreibbar.
// Ursache 1: Node verwirft beim Start mit {uid, gid} die Zusatzgruppen (libuv setgroups(0)) – Dateiaktionen liefen ohne
//   „fahnas-nutzer“, exFAT/NTFS/FAT (uid=root,gid=fahnas-nutzer,umask=007) blieben verschlossen (E_RECHTE).
//   Jetzt: Nutzerwechsel über setpriv mit ausdrücklichen Zusatzgruppen (nur FAH-NAS-Gruppen, nie sudo/docker/adm).
// Ursache 2: Die Agent-Unit erzeugte über ProtectKernelLogs/ProtectClock einen eigenen Mount-Namensraum – was der Agent
//   einhängte, sahen Samba, Apps und das System nie (leerer Ordner). Die Unit darf keine Namensraum-Optionen tragen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gruppenAusId, alsNutzer, startArgumente } from '../../src/gemeinsam/system.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('gruppenAusId: nur FAH-NAS-Gruppen (fahnas-nutzer/-admin, eigene Gruppen ≥ 1000), nie Systemgruppen oder die Hauptgruppe', () => {
  const id = 'uid=1000(fabian) gid=1000(fabian) groups=1000(fabian),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),100(users),101(lxd),109(docker),979(fahnas-admin),980(fahnas-nutzer),982(libvirt),1001(familie),65534(nogroup)';
  assert.deepEqual(gruppenAusId(id, 1000), [979, 980, 1001]);
  assert.deepEqual(gruppenAusId('uid=1002(tina) gid=1002(tina) groups=1002(tina),980(fahnas-nutzer)', 1002), [980]);
  assert.deepEqual(gruppenAusId('uid=1002(tina) gid=1002(tina) groups=1002(tina)', 1002), []);
  assert.deepEqual(gruppenAusId('', 0), []);
  assert.deepEqual(gruppenAusId('uid=1003(x) gid=980(fahnas-nutzer) groups=980(fahnas-nutzer)', 980), [], 'Hauptgruppe nicht doppelt');
});

test('alsNutzer: setpriv mit uid, gid, Zusatzgruppen (oder ausdrücklich keine) und ohne vererbbare Rechte', () => {
  assert.deepEqual(alsNutzer('cat', ['--', '/data/shares/ventoy/a.txt'], { uid: 1000, gid: 1000, gruppen: [980, 979] }), {
    programm: 'setpriv',
    argumente: ['--reuid=1000', '--regid=1000', '--groups=980,979', '--inh-caps=-all', '--', 'cat', '--', '/data/shares/ventoy/a.txt'],
  });
  assert.deepEqual(alsNutzer('dd', ['of=/x'], { uid: 1002, gid: 1002 }).argumente, ['--reuid=1002', '--regid=1002', '--clear-groups', '--inh-caps=-all', '--', 'dd', 'of=/x']);
  assert.throws(() => alsNutzer('cat', [], { uid: 'x', gid: 1 }), /uid/);
  assert.throws(() => alsNutzer('cat', [], { uid: 1, gid: 1, gruppen: ['980;rm'] }), /gruppen/);
});

test('startArgumente: als root mit uid → setpriv (uid/gid nicht mehr an spawn); ohne uid oder ohne root unverändert', () => {
  const alsRoot = startArgumente('node', ['helfer.js', 'liste'], { uid: 1000, gid: 1000, gruppen: [980], stdio: 'pipe', cwd: '/tmp' }, true);
  assert.equal(alsRoot.programm, 'setpriv');
  assert.deepEqual(alsRoot.argumente.slice(-3), ['node', 'helfer.js', 'liste']);
  assert.ok(alsRoot.argumente.includes('--groups=980'));
  assert.equal(alsRoot.optionen.uid, undefined); assert.equal(alsRoot.optionen.gid, undefined); assert.equal(alsRoot.optionen.gruppen, undefined);
  assert.equal(alsRoot.optionen.stdio, 'pipe'); assert.equal(alsRoot.optionen.cwd, '/tmp');
  const exportRoot = startArgumente('cat', ['--', '/x'], { uid: 0, gid: 0 }, true);
  assert.equal(exportRoot.programm, 'cat', 'uid 0 (Export als root) braucht keinen Wechsel');
  assert.equal(exportRoot.optionen.uid, undefined);
  const ohneRoot = startArgumente('cat', ['/x'], { uid: 1000, gid: 1000, gruppen: [980] }, false);
  assert.deepEqual(ohneRoot, { programm: 'cat', argumente: ['/x'], optionen: { uid: 1000, gid: 1000 } }, 'Entwicklung ohne root: wie bisher (gruppen fällt weg)');
  assert.deepEqual(startArgumente('ls', ['-l'], { cwd: '/' }, true), { programm: 'ls', argumente: ['-l'], optionen: { cwd: '/' } });
});

test('Agent-Unit: keine Option, die einen eigenen Mount-Namensraum erzeugt (sonst sieht nur der Agent eingehängte Laufwerke)', async () => {
  const unit = await fs.readFile(path.join(WURZEL, 'systemd', 'fahnas-agent.service'), 'utf8');
  const aktiv = unit.split('\n').filter((z) => !z.trim().startsWith('#'));
  for (const option of ['PrivateTmp', 'PrivateDevices', 'PrivateMounts', 'PrivateIPC', 'ProtectSystem', 'ProtectHome', 'ProtectKernelModules',
    'ProtectKernelLogs', 'ProtectKernelTunables', 'ProtectControlGroups', 'ProtectClock', 'ProtectHostname', 'ProtectProc', 'ProcSubset',
    'ReadWritePaths', 'ReadOnlyPaths', 'InaccessiblePaths', 'ExecPaths', 'NoExecPaths', 'TemporaryFileSystem', 'BindPaths', 'BindReadOnlyPaths',
    'MountFlags', 'RootDirectory', 'RootImage', 'MountAPIVFS', 'PrivateUsers', 'PrivateNetwork', 'NetworkNamespacePath']) {
    const treffer = aktiv.find((z) => z.trim().startsWith(`${option}=`));
    assert.ok(!treffer || /=(no|false|0|)$/.test(treffer.trim()), `${option} in der Agent-Unit: ${treffer}`);
  }
});
