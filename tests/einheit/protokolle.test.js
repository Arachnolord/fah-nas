// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Protokolle (Ausbau Oktober 2026): Eingaben, wer welche Freigabe sieht (Admins, Gruppen, nur lesen, externe
// Laufwerke), NFS-Exporte, sshd-Ergänzung, rclone-Units, Firewall-Ports, WebDAV-Anmeldung (echter Passwort-Hash) und
// protokolle.speichern mit Schein-System (Mounts, Dateien, Dienste).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-proto-'));
Object.assign(process.env, {
  FAHNAS_CONFIG: path.join(wurzel, 'konfig'), FAHNAS_NFT: path.join(wurzel, 'fahnas.nft'), FAHNAS_ANSICHT: path.join(wurzel, 'ansicht'), FAHNAS_DLNA: path.join(wurzel, 'dlna'),
  FAHNAS_EXPORTS: path.join(wurzel, 'exports'), FAHNAS_NFS_CONF: path.join(wurzel, 'nfs.conf'), FAHNAS_SSHD_SFTP: path.join(wurzel, 'sshd-sftp.conf'), FAHNAS_UNITS: path.join(wurzel, 'units'),
});
const r = await import('../../src/agent/protokolle/regeln.js');
const { anmelden } = await import('../../src/agent/protokolle/webdav-auth.js');
const proto = await import('../../src/agent/aktionen/protokolle.js');
const { nftText, protokollPortsLesen } = await import('../../src/agent/render/firewall.js');
const { hashErzeugen } = await import('../../src/agent/totp.js');
const { Konfig } = await import('../../src/gemeinsam/konfig.js');
test.after(() => fs.rm(wurzel, { recursive: true, force: true }));

const SHARES = { freigaben: [
  { name: 'private', pfad: path.join(wurzel, 'shares', 'private'), lesen: [], schreiben: ['fabian'], extern: false },
  { name: 'medien', pfad: path.join(wurzel, 'shares', 'medien'), lesen: ['@familie'], schreiben: ['fabian'], extern: false },
  { name: '1500gb', pfad: path.join(wurzel, 'shares', '1500gb'), lesen: ['@familie'], schreiben: ['fabian'], extern: true },
] };
const USERS = { nutzer: [{ name: 'fabian', rolle: 'admin', gruppen: [] }, { name: 'olga', rolle: 'admin', gruppen: [] }, { name: 'lisa', rolle: 'nutzer', gruppen: ['familie'] }, { name: 'tom', rolle: 'nutzer', gruppen: [], gesperrt: true }, { name: 'max', rolle: 'nutzer', gruppen: [] }], gruppen: [{ name: 'familie' }] };

test('protokolle: wer sieht welche Freigabe (Admin alles, Gruppe nur lesen, extern nur mit Schreibrecht, gesperrt nichts)', () => {
  const plan = r.ansichtenPlan(USERS, SHARES);
  assert.deepEqual(plan.get('fabian').map((x) => [x.freigabe, x.nur_lesen]), [['1500gb', false], ['medien', false], ['private', false]]);
  assert.deepEqual(plan.get('lisa').map((x) => [x.freigabe, x.nur_lesen]), [['medien', true]], 'extern nur lesbar → ausgelassen');
  assert.equal(plan.has('tom'), false);
  assert.deepEqual(plan.get('max'), [], 'ohne Rechte: leere Ansicht');
});

test('protokolle: Eingaben prüfen, Exporte, sshd, Units, Firewall-Ports', () => {
  const nutzer = ['fabian', 'lisa'];
  const c = r.normal({ nfs: { aktiv: true, netz: '192.168.1.0/24', freigaben: [{ name: 'medien', nur_lesen: true, als_nutzer: 'lisa' }] }, sftp: { aktiv: true }, webdav: { aktiv: true, port: 5006 }, dlna: { aktiv: true, name: 'Wohnzimmer NAS', freigaben: ['medien', '1500gb'] } }, r.STANDARD, { freigaben: SHARES.freigaben, nutzer });
  assert.throws(() => r.normal({ nfs: { aktiv: true, netz: '192.168.1.0/24', freigaben: [{ name: '1500gb', als_nutzer: 'lisa' }] } }, r.STANDARD, { freigaben: SHARES.freigaben, nutzer }), /externe Laufwerke/);
  assert.throws(() => r.normal({ nfs: { aktiv: true, netz: 'x', freigaben: [{ name: 'medien', als_nutzer: 'lisa' }] } }, r.STANDARD, { freigaben: SHARES.freigaben, nutzer }), (e) => e.details.feld === 'nfs.netz');
  assert.throws(() => r.normal({ nfs: { freigaben: [{ name: 'medien', als_nutzer: 'eve' }] } }, r.STANDARD, { freigaben: SHARES.freigaben, nutzer }), /eve/);
  assert.throws(() => r.normal({ webdav: { aktiv: true, port: 8443 } }), (e) => e.details.feld === 'webdav.port');
  assert.throws(() => r.normal({ dlna: { aktiv: true, freigaben: [] } }, r.STANDARD, { freigaben: SHARES.freigaben }), (e) => e.details.feld === 'dlna.ordner');
  const ex = r.exportsText(c, SHARES.freigaben, { lisa: 1001 }, 990);
  assert.match(ex, new RegExp(`^"${SHARES.freigaben[1].pfad}" 10\\.0\\.10\\.0/24\\(ro,sync,no_subtree_check,all_squash,anonuid=1001,anongid=990,fsid=\\d+\\)$`, 'm'));
  assert.equal(r.fsid('/a'), r.fsid('/a')); assert.notEqual(r.fsid('/a'), r.fsid('/b'));
  assert.match(r.NFS_CONF, /vers3=n/);
  const s = r.sshdText();
  assert.match(s, /^Match Group fahnas-sftp$/m); assert.match(s, /ChrootDirectory \/run\/fahnas-ansicht\/%u/); assert.match(s, /ForceCommand internal-sftp/); assert.match(s, /^Match all$/m);
  const wd = r.webdavUnit(c, { authSkript: '/opt/fahnas/src/agent/protokolle/webdav-auth.js', cert: '/c.pem', key: '/k.pem' });
  assert.match(wd, /rclone serve webdav --addr :5006 --cert \/c\.pem --key \/k\.pem "--auth-proxy=\/usr\/bin\/node \/opt\/fahnas\/src\/agent\/protokolle\/webdav-auth\.js"/);
  assert.match(r.dlnaUnit(c), /rclone serve dlna \/run\/fahnas-dlna --addr :8200 "--name=Wohnzimmer NAS" --read-only/);
  assert.deepEqual(r.firewallPorts(c).map((x) => `${x.port}/${x.proto}`), ['2049/tcp', '5006/tcp', '8200/tcp', '1900/udp']);
  const n = nftText({ ssh: true, zusatz: r.firewallPorts(c) });
  assert.ok(n.includes('tcp dport 2049 accept') && n.includes('udp dport 1900 accept'));
  // DLNA: Unterordner, alte Form (ganze Freigaben), eindeutige Namen, kein „..“
  const d1 = r.normal({ dlna: { aktiv: true, ordner: [{ freigabe: 'medien', pfad: 'Filme' }, { freigabe: 'private', pfad: 'x/Filme' }, { freigabe: 'medien', pfad: 'Filme' }, { freigabe: '1500gb', pfad: '' }] } }, r.STANDARD, { freigaben: SHARES.freigaben, nutzer });
  assert.deepEqual(d1.dlna.ordner, [{ freigabe: 'medien', pfad: 'Filme' }, { freigabe: 'private', pfad: 'x/Filme' }, { freigabe: '1500gb', pfad: '' }], 'doppelte fallen weg');
  assert.deepEqual(r.dlnaZiele(d1.dlna.ordner, SHARES.freigaben).map((z) => z.name), ['Filme', 'Filme (private)', '1500gb']);
  assert.equal(r.dlnaZiele(d1.dlna.ordner, SHARES.freigaben)[1].quelle, `${SHARES.freigaben[0].pfad}/x/Filme`);
  assert.deepEqual(r.dlnaOrdner({ freigaben: ['medien'] }), [{ freigabe: 'medien', pfad: '' }], 'alte Einstellung bleibt gültig');
  assert.throws(() => r.normal({ dlna: { aktiv: true, ordner: [{ freigabe: 'medien', pfad: '../etc' }] } }, r.STANDARD, { freigaben: SHARES.freigaben }), /\.\./);
  const mi = r.mountinfoParsen('36 25 0:32 / /run/fahnas-ansicht/lisa/medien rw,relatime shared:1 - btrfs /dev/sda3 rw\n37 25 0:32 / /run/fahnas-ansicht/lisa/x ro,relatime - btrfs /dev/sda3 rw\n38 25 0:32 / /data rw - btrfs x rw\n');
  assert.deepEqual([...mi.entries()], [['/run/fahnas-ansicht/lisa/medien', { ro: false }], ['/run/fahnas-ansicht/lisa/x', { ro: true }]]);
});

test('protokolle: WebDAV-Anmeldung prüft das NAS-Passwort und liefert die eigene Ansicht', async () => {
  const k = path.join(wurzel, 'auth-konfig'); const a = path.join(wurzel, 'auth-ansicht');
  await fs.mkdir(k, { recursive: true }); await fs.mkdir(path.join(a, 'lisa'), { recursive: true });
  await fs.writeFile(path.join(k, 'users.json'), JSON.stringify({ nutzer: [{ name: 'lisa', hash: await hashErzeugen('Geheim 123') }, { name: 'tom', hash: await hashErzeugen('x'), gesperrt: true }] }));
  const o = { konfig: k, wurzel: a };
  assert.deepEqual(await anmelden(JSON.stringify({ user: 'lisa', pass: 'Geheim 123' }), o), { type: 'local', _root: path.join(a, 'lisa') });
  assert.equal(await anmelden(JSON.stringify({ user: 'lisa', pass: 'falsch' }), o), null);
  assert.equal(await anmelden(JSON.stringify({ user: 'tom', pass: 'x' }), o), null, 'gesperrt');
  assert.equal(await anmelden(JSON.stringify({ user: '../etc', pass: 'x' }), o), null);
  assert.equal(await anmelden('kaputt', o), null);
});

test('protokolle: speichern – Ansichten einhängen (nur lesen per remount), Exporte, sshd geprüft, Units, Firewall', async () => {
  for (const f of SHARES.freigaben) await fs.mkdir(f.pfad, { recursive: true });
  await fs.mkdir(path.join(SHARES.freigaben[1].pfad, 'Filme'), { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(SHARES.freigaben[1].pfad, 'Weg')).catch(() => {}); // Verknüpfung aus der Freigabe hinaus
  const konfig = new Konfig(process.env.FAHNAS_CONFIG); await konfig.sicherstellen();
  await konfig.speichern('users.json', USERS); await konfig.speichern('shares.json', SHARES);
  const aufrufe = [];
  const system = { ausfuehren: async (prog, a) => {
    aufrufe.push([prog, ...a].join(' '));
    if (prog === 'dpkg-query') return { stdout: 'install ok installed' };
    if (prog === 'id') return { stdout: a[1] === 'lisa' ? '1001\n' : '1000\n' };
    if (prog === 'getent' && a[0] === 'group') return { stdout: 'fahnas-nutzer:x:990:\n' };
    if (prog === 'getent' && a[0] === 'passwd') return { stdout: `${a[1]}:x:1001:990::/nonexistent:${a[1] === 'fabian' ? '/bin/bash' : '/usr/sbin/nologin'}\n` };
    if (prog === 'ip') return { stdout: '[]' };
    return { stdout: '' };
  } };
  const intern = [];
  const w = { konfig, system, konfigGeaendert: () => {}, intern: async (n, x) => { intern.push({ n, x }); return { ergebnis: null }; } };
  const akt = {}; proto.registriere({ aktion: (n, d) => { akt[n] = d; } }, w);
  await konfig.speichern('system.json', { ssh: false });
  const e = await akt['protokolle.speichern'].ausfuehren({ sftp: { aktiv: true }, webdav: { aktiv: true, port: 5006 }, nfs: { aktiv: true, netz: '192.168.1.0/24', freigaben: [{ name: 'medien', nur_lesen: true, als_nutzer: 'lisa' }] }, dlna: { aktiv: true, name: 'FAH-NAS', ordner: [{ freigabe: 'medien', pfad: 'Filme' }, { freigabe: 'medien', pfad: 'fehlt' }, { freigabe: 'medien', pfad: 'Weg' }] } }, {}, w, { fortschritt: () => {} });
  assert.deepEqual(e.ansichten.lisa, [{ freigabe: 'medien', nur_lesen: true }]);
  assert.ok((await fs.stat(path.join(process.env.FAHNAS_ANSICHT, 'max'))).isDirectory(), 'auch ohne Freigaben ein Ordner (SFTP-Chroot)');
  assert.ok(intern.some((x) => x.n === 'system.dienst' && x.x.zustand === 'an'), 'SSH für SFTP eingeschaltet');
  const ziel = path.join(process.env.FAHNAS_ANSICHT, 'lisa', 'medien');
  assert.ok(aufrufe.includes(`mount --rbind ${SHARES.freigaben[1].pfad} ${ziel}`) && aufrufe.includes(`mount --make-rslave ${ziel}`) && aufrufe.includes(`mount -o remount,bind,ro ${ziel}`));
  assert.ok(!aufrufe.some((x) => x.includes(`${path.join(process.env.FAHNAS_ANSICHT, 'fabian', 'medien')}`) && x.includes(',ro')), 'Admin rw');
  assert.ok(aufrufe.includes(`mount -o remount,bind,ro ${path.join(process.env.FAHNAS_DLNA, 'Filme')}`), 'DLNA-Unterordner nur lesen');
  assert.ok(!aufrufe.some((x) => x.includes(path.join(process.env.FAHNAS_DLNA, 'fehlt'))), 'fehlender Ordner wird übersprungen');
  assert.ok(!aufrufe.some((x) => x.includes(path.join(process.env.FAHNAS_DLNA, 'Weg'))), 'Verknüpfung aus der Freigabe hinaus wird nicht eingehängt');
  assert.match(await fs.readFile(process.env.FAHNAS_EXPORTS, 'utf8'), /anonuid=1001,anongid=990/);
  assert.ok(aufrufe.includes('sshd -t') && aufrufe.includes('systemctl reload ssh.service'));
  assert.ok(aufrufe.includes('gpasswd -a lisa fahnas-sftp') && aufrufe.includes('gpasswd -d fabian fahnas-sftp'), 'nur Konten ohne Shell in die SFTP-Gruppe');
  assert.ok(aufrufe.includes('gpasswd -d olga fahnas-sftp') && !aufrufe.includes('gpasswd -a olga fahnas-sftp'), 'Admins nie in die SFTP-Ansicht, auch ohne Shell (Root-Wrapper, adminroot.js)');
  assert.match(await fs.readFile(path.join(process.env.FAHNAS_UNITS, 'fahnas-webdav.service'), 'utf8'), /serve webdav/);
  assert.ok(aufrufe.includes('systemctl restart fahnas-dlna.service') && aufrufe.includes('exportfs -ra'));
  assert.deepEqual((await protokollPortsLesen()).map((x) => x.port), [2049, 5006, 8200, 1900]);
  assert.match(await fs.readFile(process.env.FAHNAS_NFT, 'utf8'), /tcp dport 5006 accept/);
  // Ausschalten räumt auf
  await akt['protokolle.speichern'].ausfuehren({ sftp: { aktiv: false }, webdav: { aktiv: false }, nfs: { aktiv: false }, dlna: { aktiv: false } }, {}, w, { fortschritt: () => {} });
  await assert.rejects(fs.access(process.env.FAHNAS_EXPORTS)); await assert.rejects(fs.access(process.env.FAHNAS_SSHD_SFTP));
  await assert.rejects(fs.access(path.join(process.env.FAHNAS_UNITS, 'fahnas-webdav.service')));
  assert.ok(!(await fs.readFile(process.env.FAHNAS_NFT, 'utf8')).includes('5006'));
});
