// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil G (ISO, Erststart, systemd) – laufen auf macOS ohne Linux-Werkzeuge: user-data (YAML über ruby/python,
// Schema-Teilmenge, Pflichtinhalte), Plattenwahl (platte_waehlen.py gegen Probe-lsblk-Daten), fstab-Text von
// partitionen.sh, GRUB-Menü, Shell-Syntax (bash -n, shellcheck falls da), Units, smb.conf = Renderer, nftables,
// Paketlisten-Gleichstand user-data ⇄ erststart.sh, Urheber-Köpfe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruefen, schemaPruefen, pflichtPruefen, PAKETE_PFLICHT } from '../../iso/werkzeuge/autoinstall_pruefen.mjs';
import { globaleVorlage } from '../../src/agent/render/samba.js';
import { nftText } from '../../src/agent/render/firewall.js';
import { SYSCTL_DATEI, SYSCTL_TEXT } from '../../src/agent/helfer/verbindungen.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ISO = path.join(WURZEL, 'iso');
const P = (...t) => path.join(WURZEL, ...t);
const lesen = (...t) => fs.readFile(P(...t), 'utf8');
const KOPF = ['Erdacht und programmiert von Fabian Hammer, Deutschland.', '(c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.'];

function laufen(programm, args, { env = {}, eingabe } = {}) {
  return new Promise((ok) => {
    const kind = execFile(programm, args, { env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      ok({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), fehlt: !!(e && e.code === 'ENOENT') });
    });
    kind.on('error', () => {});
    if (eingabe !== undefined && kind.stdin) kind.stdin.end(eingabe);
  });
}
async function vorhanden(programm) { const r = await laufen('sh', ['-c', `command -v ${programm}`]); return r.code === 0; }
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-iso-')); }

// ---------------------------------------------------------------------------------------------------------------
// user-data
// ---------------------------------------------------------------------------------------------------------------
test('user-data: YAML lesbar, Schema-Teilmenge, Pflichtinhalte von FAH-NAS', async () => {
  const { fehler, werkzeug, cfg } = await pruefen();
  assert.deepEqual(fehler, [], `Funde (YAML über ${werkzeug}): ${fehler.join(' | ')}`);
  assert.equal(cfg.version, 1);
  assert.deepEqual(cfg['interactive-sections'], ['identity']);
  assert.ok(cfg['late-commands'].some((z) => /partitionen\.sh/.test(z)));
  assert.ok(cfg['early-commands'].some((z) => /platte_waehlen\.sh/.test(z)));
  assert.ok(Array.isArray(cfg['error-commands']) && cfg['error-commands'].length >= 1);
  for (const p of PAKETE_PFLICHT) assert.ok(cfg.packages.includes(p), `Paket ${p}`);
  assert.ok(!cfg.packages.includes('grub-btrfs'), 'grub-btrfs ist kein Ubuntu-Paket und darf nicht in packages stehen');
  // storage-Vorlage: Reihenfolge und Größen laut Entwurf §3
  const parts = cfg.storage.config.filter((a) => a.type === 'partition');
  assert.deepEqual(parts.map((a) => a.number), [1, 2, 3, 4]);
  assert.deepEqual(parts.map((a) => a.size), [1024 ** 3, 8 * 1024 ** 3, 48 * 1024 ** 3, 'FAHNAS_DATEN_GROESSE']);
  const formate = cfg.storage.config.filter((a) => a.type === 'format');
  assert.deepEqual(formate.map((a) => [a.fstype, a.label]), [['fat32', 'FAHNAS-EFI'], ['swap', 'FAHNAS-SWAP'], ['btrfs', 'FAHNAS-SYSTEM'], ['btrfs', 'FAHNAS-DATEN']]);
  assert.ok(formate.every((a) => a.preserve === false));
  assert.equal(cfg.storage.config[0].path, 'FAHNAS_ZIELPLATTE');
});

test('user-data: Paketliste ist identisch mit PAKETE in erststart.sh (Nachinstallation deckt genau die Liste)', async () => {
  const { cfg } = await pruefen();
  const skript = await lesen('iso', 'payload', 'erststart.sh');
  const m = /^PAKETE="([^"]+)"/m.exec(skript);
  assert.ok(m, 'PAKETE="…" in erststart.sh');
  assert.deepEqual([...m[1].trim().split(/\s+/)].sort(), [...cfg.packages].sort());
});

test('schemaPruefen: erkennt Typfehler, unbekannte Felder, enum, required, anyOf; pflichtPruefen: fehlendes Paket, grub-btrfs', async () => {
  const schema = JSON.parse(await lesen('iso', 'autoinstall-schema.json'));
  assert.deepEqual(schemaPruefen(schema, { version: 1 }), []);
  assert.ok(schemaPruefen(schema, { version: 'eins' }).some((f) => /Typ/.test(f)));
  assert.ok(schemaPruefen(schema, { version: 1, updates: 'alles' }).some((f) => /einer dieser Werte/.test(f)));
  assert.ok(schemaPruefen(schema, { version: 1, keyboard: { layout: 'de', schmuggel: 1 } }).some((f) => /unbekanntes Feld/.test(f)));
  assert.ok(schemaPruefen(schema, { version: 1, identity: { username: 'a' } }).some((f) => /Pflichtfeld/.test(f)));
  assert.ok(schemaPruefen(schema, { version: 1, apt: { fallback: 'egal' } }).length > 0);
  assert.deepEqual(schemaPruefen(schema, { version: 1, 'late-commands': ['a', ['b', 'c']] }), []);
  assert.ok(schemaPruefen(schema, { version: 1, 'late-commands': [5] }).length > 0);
  const { cfg } = await pruefen();
  const ohne = structuredClone(cfg); ohne.packages = ohne.packages.filter((p) => p !== 'samba');
  assert.ok(pflichtPruefen(ohne).some((f) => /samba fehlt/.test(f)));
  const mit = structuredClone(cfg); mit.packages.push('grub-btrfs');
  assert.ok(pflichtPruefen(mit).some((f) => /grub-btrfs/.test(f)));
  const falsch = structuredClone(cfg); falsch['interactive-sections'] = ['identity', 'storage'];
  assert.ok(pflichtPruefen(falsch).some((f) => /interactive-sections/.test(f)));
});

// ---------------------------------------------------------------------------------------------------------------
// Plattenwahl (platte_waehlen.py, --probe ohne Installer)
// ---------------------------------------------------------------------------------------------------------------
const GIB = 1024 ** 3; const MIB = 1024 ** 2;
function platte(name, size, extra = {}) {
  return { name, path: `/dev/${name}`, type: 'disk', size, rm: false, ro: false, model: 'Test', serial: 'S', tran: 'sata', pkname: null, label: null, fstype: null, parttype: null, partn: null, start: null, mountpoint: null, ...extra };
}
function teil(pk, n, start, size, label, fstype, parttype) {
  return { name: `${pk}${n}`, path: `/dev/${pk}${n}`, type: 'part', size, rm: false, ro: false, pkname: pk, label, fstype, parttype, partn: n, start, mountpoint: null };
}
const MEDIUM = platte('sr0', 2_927_861_760, { type: 'rom', rm: true, mountpoint: '/cdrom' });
const ALT_PLATTE = platte('sda', 500_107_862_016, { children: [
  teil('sda', 1, 2048, GIB, 'FAHNAS-EFI', 'vfat', 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'),
  teil('sda', 2, 2_099_200, 8 * GIB, 'FAHNAS-SWAP', 'swap', '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f'),
  teil('sda', 3, 18_876_416, 48 * GIB, 'FAHNAS-SYSTEM', 'btrfs', '0fc63daf-8483-4772-8e79-3d69d8477de4'),
  teil('sda', 4, 119_537_664, 438_903_242_752, 'FAHNAS-DATEN', 'btrfs', '0fc63daf-8483-4772-8e79-3d69d8477de4'),
] });

async function probe(geraete, { bios = false, cmdline = '', medium = '/dev/sr0' } = {}) {
  const w = await tmp();
  const datei = path.join(w, 'lsblk.json');
  await fs.writeFile(datei, JSON.stringify({ blockdevices: geraete }));
  const args = [P('iso', 'payload', 'platte_waehlen.py'), '--probe', datei, '--medium', medium, '--cmdline', cmdline];
  if (bios) args.push('--bios');
  const r = await laufen('python3', args);
  if (r.fehlt) assert.fail('python3 fehlt – auf macOS über Xcode-Werkzeuge oder brew install python3');
  return { ...r, daten: r.code === 0 ? JSON.parse(r.stdout) : null };
}

test('platte_waehlen: eine interne Platte (UEFI) → vier Partitionen, Daten = Rest (size -1), EFI trägt grub_device', async () => {
  const groesse = 512_110_190_592;
  const r = await probe([MEDIUM, platte('nvme0n1', groesse, { tran: 'nvme' }), platte('zram0', 4e9, { tran: '' }), platte('loop0', 1e6, { type: 'loop', ro: true })]);
  assert.equal(r.code, 0, r.stderr);
  const { platte: ziel, modus, uefi, storage } = r.daten;
  assert.equal(ziel, '/dev/nvme0n1'); assert.equal(modus, 'neu'); assert.equal(uefi, true);
  assert.equal(storage.version, 2); assert.deepEqual(storage.swap, { size: 0 });
  const disk = storage.config[0];
  assert.deepEqual([disk.type, disk.path, disk.ptable, disk.preserve, disk.grub_device, disk.wipe], ['disk', '/dev/nvme0n1', 'gpt', false, false, 'superblock-recursive']);
  const parts = storage.config.filter((a) => a.type === 'partition');
  assert.deepEqual(parts.map((a) => a.number), [1, 2, 3, 4]);
  assert.deepEqual(parts.map((a) => a.flag), ['boot', 'swap', undefined, undefined]);
  assert.equal(parts[0].grub_device, true);
  assert.deepEqual(parts.slice(0, 3).map((a) => a.size), [GIB, 8 * GIB, 48 * GIB]);
  // Rest der Platte: size -1 (Autoinstall-Referenz, storage) statt eigener Rechnung – subiquity kennt die echte Ausrichtung (4Kn)
  assert.equal(parts[3].size, -1);
  assert.ok(parts.slice(0, 3).every((a) => a.size > 0), 'nur die letzte Partition darf -1 tragen');
  assert.ok(r.daten.hinweise.some((h) => /Daten 4\d\d(\.\d+)? GiB/.test(h) || /Daten 4\d\d/.test(h)), `Hinweis nennt den ungefähren Rest: ${r.daten.hinweise.join(' | ')}`);
  const mounts = storage.config.filter((a) => a.type === 'mount').map((a) => a.path);
  assert.deepEqual(mounts, ['/boot/efi', '/']);
  const formate = storage.config.filter((a) => a.type === 'format');
  assert.deepEqual(formate.map((a) => a.label), ['FAHNAS-EFI', 'FAHNAS-SWAP', 'FAHNAS-SYSTEM', 'FAHNAS-DATEN']);
  assert.ok(formate.every((a) => a.preserve === false));
});

test('platte_waehlen: BIOS → zusätzlich bios_grub 1 MiB als p1, grub_device an der Platte, Nummern +1', async () => {
  const r = await probe([MEDIUM, platte('sda', 256 * GIB)], { bios: true });
  assert.equal(r.code, 0, r.stderr);
  const parts = r.daten.storage.config.filter((a) => a.type === 'partition');
  assert.deepEqual(parts.map((a) => [a.number, a.flag]), [[1, 'bios_grub'], [2, 'boot'], [3, 'swap'], [4, undefined], [5, undefined]]);
  assert.equal(parts[0].size, MIB);
  assert.equal(r.daten.storage.config[0].grub_device, true);
  assert.equal(parts[1].grub_device, false);
  assert.equal(parts[4].size, -1, 'Datenpartition = Rest der Platte (size -1)');
});

test('platte_waehlen: Übernahme – Platte mit FAHNAS-DATEN gewinnt, alles preserve mit Offsets, nur Daten ohne Neuformatierung', async () => {
  const stick = platte('sdb', 31e9, { rm: true, tran: 'usb', children: [teil('sdb', 1, 64, 2_927_861_760, 'FAH-NAS Installer', 'iso9660', null)] });
  stick.children[0].mountpoint = '/cdrom';
  const r = await probe([stick, ALT_PLATTE, platte('sdc', 2_000_398_934_016, { model: 'WD' })], { medium: '/dev/sdb1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.daten.platte, '/dev/sda'); assert.equal(r.daten.modus, 'uebernahme');
  const st = r.daten.storage.config;
  assert.deepEqual([st[0].preserve, st[0].wipe, st[0].grub_device], [true, undefined, false]);
  const parts = st.filter((a) => a.type === 'partition');
  assert.ok(parts.every((a) => a.preserve === true && a.wipe === undefined));
  assert.deepEqual(parts.map((a) => a.offset), [2048 * 512, 2_099_200 * 512, 18_876_416 * 512, 119_537_664 * 512]);
  assert.deepEqual(parts.map((a) => a.size), [GIB, 8 * GIB, 48 * GIB, 438_903_242_752]);
  const formate = st.filter((a) => a.type === 'format');
  assert.deepEqual(formate.map((a) => [a.label, a.preserve]), [['FAHNAS-EFI', false], ['FAHNAS-SWAP', false], ['FAHNAS-SYSTEM', false], ['FAHNAS-DATEN', true]]);
  assert.ok(r.daten.hinweise.some((h) => /Übernahme/.test(h)));
  // fahnas.neu=1 erzwingt Neuaufbau derselben Platte
  const neu = await probe([stick, ALT_PLATTE, platte('sdc', 2_000_398_934_016)], { medium: '/dev/sdb1', cmdline: 'quiet fahnas.neu=1' });
  assert.equal(neu.code, 0); assert.equal(neu.daten.platte, '/dev/sda'); assert.equal(neu.daten.modus, 'neu');
  assert.ok(neu.daten.hinweise.some((h) => /GELÖSCHT/.test(h)));
});

test('platte_waehlen: mehrere Platten → Stopp mit Liste; fahnas.platte= wählt; USB/klein/Medium werden übersprungen', async () => {
  const zwei = [MEDIUM, platte('sda', 250 * GIB, { model: 'A' }), platte('sdb', 250 * GIB, { model: 'B' }), platte('sdd', 32e9, { model: 'klein' })];
  const r = await probe(zwei);
  assert.equal(r.code, 2);
  assert.match(r.stderr + r.stdout, /Mehrere mögliche Zielplatten/);
  assert.match(r.stderr + r.stdout, /fahnas\.platte=/);
  const gewaehlt = await probe(zwei, { cmdline: 'ro quiet fahnas.platte=/dev/sdb' });
  assert.equal(gewaehlt.code, 0); assert.equal(gewaehlt.daten.platte, '/dev/sdb');
  const nurUsb = await probe([MEDIUM, platte('sdb', 500 * GIB, { tran: 'usb' })]);
  assert.equal(nurUsb.code, 2); assert.match(nurUsb.stderr, /Keine passende Zielplatte/); assert.match(nurUsb.stderr, /Wechselmedium\/USB/);
  const usbErzwungen = await probe([MEDIUM, platte('sdb', 500 * GIB, { tran: 'usb', rm: true })], { cmdline: 'fahnas.platte=/dev/sdb' });
  assert.equal(usbErzwungen.code, 0);
  const klein = await probe([MEDIUM, platte('sda', 20 * GIB)]);
  assert.equal(klein.code, 2); assert.match(klein.stderr, /zu klein/);
  // kleine Platten (VM, alte SSD): 80 GiB → Swap 8 + System 32; 40 GiB → Swap 4 + System 20
  const mittel = await probe([MEDIUM, platte('sda', 80 * GIB)]);
  assert.equal(mittel.code, 0, mittel.stderr);
  const mParts = mittel.daten.storage.config.filter((a) => a.type === 'partition');
  assert.deepEqual(mParts.slice(0, 3).map((a) => a.size), [GIB, 8 * GIB, 32 * GIB]);
  const kleinOk = await probe([MEDIUM, platte('sda', 40 * GIB)]);
  assert.equal(kleinOk.code, 0, kleinOk.stderr);
  assert.deepEqual(kleinOk.daten.storage.config.filter((a) => a.type === 'partition').slice(0, 3).map((a) => a.size), [GIB, 4 * GIB, 20 * GIB]);
  const medium = await probe([MEDIUM], { cmdline: 'fahnas.platte=/dev/sr0' });
  assert.equal(medium.code, 2); assert.match(medium.stderr, /Installationsmedium/);
  const fehlt = await probe([MEDIUM, platte('sda', 250 * GIB)], { cmdline: 'fahnas.platte=/dev/sdz' });
  assert.equal(fehlt.code, 2); assert.match(fehlt.stderr, /keine solche Platte/);
});

test('platte_waehlen: Umstieg von UGOS – RAID/LVM-Datenplatten nie Kandidat, die alte Systemplatte bleibt übrig', async () => {
  const raid = (name, size, extra = {}) => platte(name, size, { children: [teil(name, 1, 2048, 15 * GIB, null, null, null), teil(name, 2, 32_000_000, size - 16 * GIB, null, 'linux_raid_member', null)], ...extra });
  const ugreen = [MEDIUM,
    raid('sda', 9_000 * GIB, { model: 'HUH721010ALN600' }), raid('sdb', 9_000 * GIB), raid('sdc', 930 * GIB), raid('sdd', 930 * GIB),
    raid('nvme0n1', 238 * GIB, { tran: 'nvme' }), raid('nvme1n1', 931 * GIB, { tran: 'nvme' }),
    platte('nvme2n1', 119 * GIB, { tran: 'nvme', model: 'YSR128GHLCV-E3C-1', children: [teil('nvme2n1', 1, 2048, 256 * 1024 * 1024, null, 'vfat', null), teil('nvme2n1', 2, 600_000, 2 * GIB, null, 'ext4', null)] }),
    platte('sde', 931 * GIB, { tran: 'usb', children: [teil('sde', 1, 2048, 930 * GIB, null, 'ntfs', null)] }),
  ];
  const r = await probe(ugreen);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.daten.platte, '/dev/nvme2n1');
  assert.match(r.stderr + r.stdout, /sda .*RAID\/LVM.*nie automatisch/);
  // ganze Platte als LVM-Mitglied (ohne Partitionen) zählt genauso
  const lvm = await probe([MEDIUM, platte('sda', 500 * GIB, { fstype: 'LVM2_member' }), platte('sdb', 250 * GIB)]);
  assert.equal(lvm.code, 0, lvm.stderr); assert.equal(lvm.daten.platte, '/dev/sdb');
  // erzwungen geht weiterhin (bewusste Entscheidung)
  const erzwungen = await probe(ugreen, { cmdline: 'fahnas.platte=/dev/sdc' });
  assert.equal(erzwungen.code, 0); assert.equal(erzwungen.daten.platte, '/dev/sdc');
});

test('platte_waehlen: Übernahme-Sonderfälle – BIOS ohne bios_grub, fehlende Rollen, doppelte Rollen, zwei Datenplatten', async () => {
  const bios = await probe([MEDIUM, ALT_PLATTE], { bios: true });
  assert.equal(bios.code, 2); assert.match(bios.stderr, /bios_grub/);
  const ohneSystem = structuredClone(ALT_PLATTE); ohneSystem.children.splice(2, 1);
  const r1 = await probe([MEDIUM, ohneSystem]);
  assert.equal(r1.code, 2); assert.match(r1.stderr, /Aufbau fehlt \(system\)/);
  const doppelt = structuredClone(ALT_PLATTE); doppelt.children.push(teil('sda', 5, 200_000_000, GIB, 'FAHNAS-EFI', 'vfat', null));
  const r2 = await probe([MEDIUM, doppelt]);
  assert.equal(r2.code, 2); assert.match(r2.stderr, /doppelt/);
  const zweite = structuredClone(ALT_PLATTE); zweite.name = 'sdc'; zweite.path = '/dev/sdc';
  const r3 = await probe([MEDIUM, ALT_PLATTE, zweite]);
  assert.equal(r3.code, 2); assert.match(r3.stderr, /Mehrere Platten mit FAHNAS-DATEN/);
  // fremde Partition auf der Altplatte bleibt unangetastet (preserve ohne format)
  const fremd = structuredClone(ALT_PLATTE); fremd.children.push(teil('sda', 5, 900_000_000, GIB, 'FOTOS', 'ext4', '0fc63daf-8483-4772-8e79-3d69d8477de4'));
  const r4 = await probe([MEDIUM, fremd]);
  assert.equal(r4.code, 0, r4.stderr);
  const p5 = r4.daten.storage.config.find((a) => a.type === 'partition' && a.number === 5);
  assert.equal(p5.preserve, true);
  assert.ok(!r4.daten.storage.config.some((a) => a.type === 'format' && a.volume === p5.id));
  assert.ok(r4.daten.hinweise.some((h) => /Fremde Partition bleibt unangetastet: \/dev\/sda5/.test(h)));
});

// ---------------------------------------------------------------------------------------------------------------
// partitionen.sh (fstab-Text), Shell-Syntax, GRUB
// ---------------------------------------------------------------------------------------------------------------
test('partitionen.sh --fstab-test: alle Einhängungen mit UUID, subvol, EINHEITLICHE btrfs-Optionen je Dateisystem (kein nodatacow), swap; ohne EFI/Swap weniger Zeilen', async () => {
  const env = { UUID_SYS: 'aaaa-sys', UUID_DATEN: 'bbbb-dat', UUID_EFI: 'CCCC-EFI1', UUID_SWAP: 'dddd-swap' };
  const r = await laufen('bash', [P('iso', 'payload', 'partitionen.sh'), '--fstab-test'], { env });
  assert.equal(r.code, 0, r.stderr);
  const z = r.stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  const soll = [
    'UUID=aaaa-sys  /  btrfs  subvol=@,compress=zstd:1,noatime  0  0',
    'UUID=CCCC-EFI1  /boot/efi  vfat  umask=0077  0  1',
    'UUID=aaaa-sys  /var/log  btrfs  subvol=@log,compress=zstd:1,noatime  0  0',
    'UUID=aaaa-sys  /.snapshots  btrfs  subvol=@snapshots,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data  btrfs  subvolid=5,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/config  btrfs  subvol=@config,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /var/lib/docker  btrfs  subvol=@docker,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/apps  btrfs  subvol=@apps,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/vms  btrfs  subvol=@vms,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/shares  btrfs  subvol=@shares,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/backup  btrfs  subvol=@backup,compress=zstd:1,noatime  0  0',
    'UUID=bbbb-dat  /data/.snapshots  btrfs  subvol=@snapshots_daten,compress=zstd:1,noatime  0  0',
    'UUID=dddd-swap  none  swap  sw  0  0',
  ];
  assert.deepEqual(z, soll);
  // btrfs(5): Optionen gelten je Dateisystem ab der ersten Einhängung – alle btrfs-Zeilen einer Partition müssen gleich lauten
  const optionenJeGeraet = new Map();
  for (const l of z) {
    const [uuid, , typ, opt] = l.split(/ {2}/);
    if (typ !== 'btrfs') continue;
    const ohneSubvol = opt.split(',').filter((o) => !/^subvol(id)?=/.test(o)).sort().join(',');
    if (!optionenJeGeraet.has(uuid)) optionenJeGeraet.set(uuid, ohneSubvol);
    assert.equal(ohneSubvol, optionenJeGeraet.get(uuid), `abweichende Optionen auf ${uuid}: ${l}`);
  }
  assert.ok(!/nodatacow/.test(z.join('\n')), 'nodatacow darf nicht in der fstab stehen (nur chattr +C)');
  assert.match(r.stdout, /^# .*je DATEISYSTEM/m, 'fstab-Kommentar erklärt die Regel');
  const ohne = await laufen('bash', [P('iso', 'payload', 'partitionen.sh'), '--fstab-test'], { env: { UUID_SYS: 'a', UUID_DATEN: 'b', UUID_EFI: '', UUID_SWAP: '' } });
  assert.equal(ohne.code, 0);
  assert.equal(ohne.stdout.split('\n').filter((l) => l.startsWith('UUID=')).length, 11);
  const kaputt = await laufen('bash', [P('iso', 'payload', 'partitionen.sh'), '--fstab-test'], { env: { UUID_SYS: '', UUID_DATEN: '' } });
  assert.equal(kaputt.code, 2);
});

test('partitionen.sh: Ablauf enthält die vertraglichen Schritte; Umzug nach @ als Reflink-Kopie + Löschen mit Fertig-Kriterium „nur @*“', async () => {
  const s = await lesen('iso', 'payload', 'partitionen.sh');
  assert.match(s, /^set -euo pipefail$/m);
  for (const t of ['subvolid=5', 'btrfs subvolume create', 'subvolume set-default', '@log', '@snapshots', '@snapshots_daten', 'chattr +C', 'umount -R', 'grub-install', 'update-grub', 'rootflags=subvol=@', 'fahnas-partitionen.log']) {
    assert.ok(s.includes(t), `partitionen.sh enthält „${t}“`);
  }
  assert.match(s, /DATEN_SUBVOLS="@config @docker @apps @vms @shares @backup @snapshots_daten"/);
  // EXDEV: kein mv über die Unterlaufwerksgrenze, sondern cp -a --reflink=auto und danach rm der Quelle – in dieser Reihenfolge
  assert.ok(!s.includes('mv -t "$MNT/sys/@/"'), 'kein mv der Wurzel (rename über Unterlaufwerke ist unmöglich, mv würde still kopieren)');
  const kopie = s.indexOf(`! -name '@*' -exec cp -a --reflink=auto -t "$MNT/sys/@/" -- {} +`);
  const loeschen = s.indexOf(`! -name '@*' -exec rm -rf -- {} +`);
  assert.ok(kopie > 0 && loeschen > kopie, 'erst Reflink-Kopie nach @, dann Quelle löschen');
  assert.ok(s.includes(`toplevel_hat_reste() { [ -n "$(find "$MNT/sys" -mindepth 1 -maxdepth 1 ! -name '@*' -print -quit)" ]; }`), 'Fertig-Kriterium: Top-Level enthält nur @*');
  assert.ok(!s.includes('if [ -d "$MNT/sys/@/etc" ]'), 'alter Marker „@/etc existiert“ ist kein Kriterium mehr (halb kopierter Umzug)');
  assert.ok(s.includes('toplevel_hat_reste && fehler'), 'nach dem Umzug dürfen keine Reste bleiben');
  assert.ok(s.includes('-exec cp -a --reflink=auto -t "$MNT/sys/@log/" -- {} +'), '/var/log ebenso als Kopie + Löschen');
  assert.match(s, /Verschieben übersprungen/, 'Meldung für den zweiten Lauf (Integrationstest 06 prüft sie)');
});

test('Shell-Skripte bestehen bash -n (und shellcheck, falls installiert)', async () => {
  const skripte = [P('iso', 'build_iso.sh'), P('iso', 'payload', 'erststart.sh'), P('iso', 'payload', 'partitionen.sh'), P('iso', 'payload', 'platte_waehlen.sh')];
  for (const d of await fs.readdir(P('tests', 'integration'))) if (d.endsWith('.sh')) skripte.push(P('tests', 'integration', d));
  for (const s of skripte) {
    const r = await laufen('bash', ['-n', s]);
    assert.equal(r.code, 0, `bash -n ${path.relative(WURZEL, s)}: ${r.stderr}`);
  }
  if (await vorhanden('shellcheck')) {
    for (const s of skripte) {
      const r = await laufen('shellcheck', ['-S', 'warning', '-e', 'SC1091', s]);
      assert.equal(r.code, 0, `shellcheck ${path.relative(WURZEL, s)}:\n${r.stdout}`);
    }
  } else {
    process.stdout.write('  (shellcheck nicht installiert – übersprungen)\n');
  }
  const py = await laufen('python3', ['-m', 'py_compile', P('iso', 'payload', 'platte_waehlen.py')]);
  assert.equal(py.code, 0, py.stderr);
  await fs.rm(P('iso', 'payload', '__pycache__'), { recursive: true, force: true });
});

test('grub.cfg: drei Einträge, autoinstall-Eintrag mit korrektem Escape, Timeout 10, Standard 0', async () => {
  const g = await lesen('iso', 'grub', 'grub.cfg');
  assert.match(g, /^set timeout=10$/m);
  assert.match(g, /^set default=0$/m);
  const eintraege = [...g.matchAll(/^menuentry "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(eintraege, ['FAH-NAS installieren (Platte wird eingerichtet)', 'FAH-NAS installieren (Textmodus/serielle Konsole)', 'Von der Festplatte starten']);
  const autoinstall = [...g.matchAll(/linux\t\/casper\/vmlinuz autoinstall ds=nocloud\\;s=\/cdrom\/nocloud\/ .*---$/gm)];
  assert.equal(autoinstall.length, 2, 'beide Installations-Einträge mit autoinstall ds=nocloud\\;s=/cdrom/nocloud/ und „---“ am Ende');
  assert.match(g, /console=ttyS0,115200n8/);
  assert.equal((g.match(/initrd\t\/casper\/initrd/g) || []).length, 2);
  assert.match(g, /search --no-floppy --set=fahnas_teil --label FAHNAS-SYSTEM/);
  assert.ok(!/ds=nocloud;s=/.test(g), 'Semikolon muss als \\; geschrieben sein');
});

test('build_iso.sh: Release 26.04, Volumen-ID, Standardarchiv, Nachprüfung der eigenen Dateien', async () => {
  const b = await lesen('iso', 'build_iso.sh');
  assert.match(b, /^REL="26\.04"$/m);
  assert.match(b, /^VOLUMEN_ID="FAH-NAS Installer"$/m);
  assert.match(b, /dist\/fahnas_release\.tar\.gz/);
  assert.match(b, /tools\/build_release\.sh/);
  assert.match(b, /fahnas-\$VERSION-\$STEMPEL-ubuntu\$REL-amd64\.iso/);
  for (const p of ['/nocloud/user-data', '/fahnas/fahnas_release.tar.gz', '/fahnas/erststart.sh', '/fahnas/partitionen.sh', '/fahnas/platte_waehlen.py', '/fahnas/samba/smb.conf', '/fahnas/nftables/fahnas.nft', '/boot/grub/grub.cfg']) assert.ok(b.includes(p), `Nachprüfung ${p}`);
  assert.match(b, /autoinstall_pruefen\.mjs/);
  assert.match(b, /-append_partition 2 28732ac11ff8d211ba4b00a0c93ec93b/);
  assert.match(b, /--grub2-mbr/);
});

// ---------------------------------------------------------------------------------------------------------------
// systemd-Units, Samba-Vorlage, nftables, zram, quellen.env
// ---------------------------------------------------------------------------------------------------------------
function unitWerte(text) {
  const w = new Map();
  for (const z of text.split('\n')) { const m = /^([A-Za-z]+)=(.*)$/.exec(z.trim()); if (m) w.set(m[1], [...(w.get(m[1]) || []), m[2]]); }
  return w;
}

test('fahnas-web.service: Härtung laut Vertrag', async () => {
  const w = unitWerte(await lesen('systemd', 'fahnas-web.service'));
  const eins = (k) => (w.get(k) || []).join(' ');
  assert.equal(eins('User'), 'fahnas'); assert.equal(eins('Group'), 'fahnas'); assert.equal(eins('SupplementaryGroups'), 'fahnas');
  assert.equal(eins('AmbientCapabilities'), 'CAP_NET_BIND_SERVICE'); assert.equal(eins('CapabilityBoundingSet'), 'CAP_NET_BIND_SERVICE');
  assert.equal(eins('NoNewPrivileges'), 'yes'); assert.equal(eins('ProtectSystem'), 'strict'); assert.equal(eins('ProtectHome'), 'yes');
  assert.equal(eins('ReadWritePaths'), '/data/config/web /run/fahnas'); assert.equal(eins('PrivateTmp'), 'yes');
  assert.equal(eins('ProtectKernelTunables'), 'yes'); assert.equal(eins('ProtectControlGroups'), 'yes');
  assert.equal(eins('RestrictAddressFamilies'), 'AF_UNIX AF_INET AF_INET6 AF_NETLINK'); assert.equal(eins('Restart'), 'always'); // AF_NETLINK: os.networkInterfaces() (Zertifikat-SAN) braucht es – VM-Test 25.09.
  assert.equal(eins('After'), 'fahnas-agent.service network-online.target'); assert.equal(eins('Requires'), 'fahnas-agent.service');
  assert.ok(eins('Environment').includes('FAHNAS_WEB_PORT=8443') && eins('Environment').includes('FAHNAS_HTTP_PORT='));
  assert.equal(eins('ExecStart'), '/usr/bin/node /opt/fahnas/src/web/web.js'); assert.equal(eins('Type'), 'simple'); assert.equal(eins('NotifyAccess'), ''); // Type=simple: systemd-notify aus Kindprozess kam im VM-Test nicht an (Start-Timeout)
  assert.ok(!w.has('MemoryDenyWriteExecute'), 'MemoryDenyWriteExecute würde Node (JIT) brechen');
});

test('fahnas-agent.service: Type=simple, root:fahnas, RuntimeDirectory 0750 erhalten, kein NoNewPrivileges', async () => {
  const w = unitWerte(await lesen('systemd', 'fahnas-agent.service'));
  const eins = (k) => (w.get(k) || []).join(' ');
  assert.equal(eins('Type'), 'simple'); assert.equal(eins('NotifyAccess'), '');
  assert.equal(eins('User'), 'root'); assert.equal(eins('Group'), 'fahnas');
  assert.equal(eins('ExecStart'), '/usr/bin/node /opt/fahnas/src/agent/agent.js');
  assert.ok(eins('Environment').includes('NODE_ENV=production'));
  assert.equal(eins('RuntimeDirectory'), 'fahnas'); assert.equal(eins('RuntimeDirectoryMode'), '0750'); assert.equal(eins('RuntimeDirectoryPreserve'), 'yes');
  assert.equal(eins('Restart'), 'always'); assert.ok(eins('After').includes('network-online.target') && eins('After').includes('smbd.service'));
  assert.equal(eins('Wants'), 'network-online.target');
  assert.ok(!w.has('WatchdogSec')); assert.ok(!w.has('NoNewPrivileges')); assert.ok(!w.has('ProtectSystem'));
  const t = unitWerte(await lesen('systemd', 'fahnas.target'));
  assert.ok((t.get('Wants') || []).join(' ').includes('fahnas-agent.service'));
});

test('fahnas-erststart.service: oneshot mit Restart=on-failure/60 s, ohne Startlimit, Bedingung fertig.ok', async () => {
  const w = unitWerte(await lesen('iso', 'payload', 'fahnas-erststart.service'));
  const eins = (k) => (w.get(k) || []).join(' ');
  assert.equal(eins('Type'), 'oneshot'); assert.equal(eins('Restart'), 'on-failure'); assert.equal(eins('RestartSec'), '60');
  assert.equal(eins('StartLimitIntervalSec'), '0'); assert.equal(eins('ConditionPathExists'), '!/var/lib/fahnas/erststart/fertig.ok');
  assert.equal(eins('ExecStart'), '/bin/bash /opt/fahnas-install/erststart.sh'); assert.equal(eins('TimeoutStartSec'), '0');
});

test('erststart.sh: alle Schritte in der vertraglichen Reihenfolge (Firewall vor Docker, libvirt getrennt) und die Kernbefehle', async () => {
  const s = await lesen('iso', 'payload', 'erststart.sh');
  const reihenfolge = [...s.matchAll(/^schritt(?:_immer)? (\w+) s_\w+$/gm)].map((m) => m[1]);
  assert.deepEqual(reihenfolge, ['dns_rueckfall', 'pakete', 'gruppen_nutzer', 'release', 'konfig_rechte', 'startcode', 'samba', 'snapper_grub', 'zram', 'firewall', 'docker', 'libvirt', 'dienste', 'konsole', 'fertig']);
  for (const t of ['groupadd -r', 'useradd --system --gid fahnas', 'usermod -aG', 'sha256sum -c', '--no-same-owner -xzf', '/usr/local/bin/fahnas', 'fahnas" startcode',
    'chmod 2750 "$KONFIG"', 'chown fahnas:fahnas "$KONFIG/web"', 'chown root:fahnas-nutzer /data/shares', 'chmod 0751 /data/shares', 'testparm -s', 'disable --now nmbd',
    'systemctl enable smbd.service avahi-daemon.service', 'systemctl restart smbd.service', 'snapper-timeline.timer snapper-cleanup.timer', 'GRUB_BTRFS_LIMIT', '41_snapshots-btrfs', 'grub-btrfsd.service', 'update-grub',
    'GRUB_BTRFS_SCRIPT_CHECK grub-script-check', '/etc/default/grub.d/fahnas.cfg', 'GRUB_TIMEOUT_STYLE=menu', 'GRUB_TIMEOUT=3', `grep -q '41_snapshots-btrfs' /boot/grub/grub.cfg`,
    '/etc/default/zramswap', '"storage-driver":"overlay2"', 'enable --now docker.service', 'is-enabled libvirtd.service', 'enable --now libvirtd.service', 'virtqemud.socket virtnetworkd.socket virtstoraged.socket',
    '/etc/nftables.d', 'nft -c -f /etc/nftables.conf', 'nft -f /etc/nftables.conf', 'systemctl enable nftables.service', 'nftables.service.d/fahnas.conf', 'ExecStop=-/usr/sbin/nft delete table inet fahnas',
    'fahnas-agent.service fahnas-web.service', 'fahnas" issue', 'update-motd.d/60-fahnas', 'systemctl disable fahnas-erststart.service', '/var/lib/fahnas/erststart',
    'fahnas-erststart.log', '--erneut', 'warte_auf_internet', 'seq 1 60', 'sort -V', 'neuer_als "$version" "$alt"']) {
    assert.ok(s.includes(t), `erststart.sh enthält „${t}“`);
  }
  // Fund R2-1/3/14: kein voller Pfad in SCRIPT_CHECK, kein Restart der nftables-Unit (ExecStop = flush ruleset), kein statischer Startcode in issue.d
  const code = s.split('\n').filter((z) => !z.trim().startsWith('#')).join('\n');   // ohne Kommentarzeilen
  assert.ok(!/GRUB_BTRFS_SCRIPT_CHECK "\$\(command -v/.test(code), 'GRUB_BTRFS_SCRIPT_CHECK nur als Name');
  assert.ok(!/systemctl restart nftables/.test(code), 'nftables.service wird nie neu gestartet (Stop = flush ruleset)');
  assert.ok(!/enable --now nftables/.test(code), 'nftables nicht mit --now (Start lädt die Datei; Restart wäre ein Flush)');
  assert.ok(!/cat > \/etc\/issue\.d\/fahnas\.issue/.test(code), 'issue-Datei schreibt nur noch „fahnas issue“ (Startcode verschwindet nach der Ersteinrichtung)');
  assert.ok(!code.includes('s_docker_libvirt'), 'Docker und libvirt sind getrennte Schritte');
  assert.match(s, /^set -uo pipefail$/m);
  assert.ok(/\( set -euo pipefail; "\$fn" \)/.test(s), 'Schritte laufen in einer Unterschale mit set -e');
  // Mini-PC 25.09.: als if-Bedingung wäre set -e wirkungslos; „list-unit-files | grep -q“ scheitert an SIGPIPE (pipefail)
  assert.ok(!/if \( set -e/.test(code), 'Unterschale nie als if-Bedingung (set -e wäre abgeschaltet)');
  assert.ok(!/list-unit-files[^\n]*\| *grep -q/.test(code), 'kein „systemctl list-unit-files | grep -q“ (SIGPIPE + pipefail)');
  for (const t of ['show -p LoadState --value zramswap.service', 'zramswap.service.d/fahnas.conf', 'echo 1 > /sys/block/zram0/reset', 'try-restart snapperd.service']) assert.ok(s.includes(t), `erststart.sh enthält „${t}“`);
});

test('Vorschaubilder (0.4.0): Paket ffmpeg in allen Paketlisten – ISO-Pflichtprüfung, user-data und erststart PAKETE', async () => {
  assert.ok(PAKETE_PFLICHT.includes('ffmpeg'), 'autoinstall_pruefen kennt ffmpeg');
  const { cfg } = await pruefen();
  assert.ok(cfg.packages.includes('ffmpeg'), 'user-data installiert ffmpeg');
  const s = await lesen('iso', 'payload', 'erststart.sh');
  assert.ok(/^PAKETE="[^"]*\bffmpeg\b[^"]*"/m.test(s), 'PAKETE in erststart.sh enthält ffmpeg');
});

test('Weltkarte: Paket conntrack in allen Paketlisten, Erststart schaltet die Byte-Zähler ein (gleiche sysctl-Datei wie der Agent)', async () => {
  assert.ok(PAKETE_PFLICHT.includes('conntrack'), 'autoinstall_pruefen kennt conntrack');
  const { cfg } = await pruefen();
  assert.ok(cfg.packages.includes('conntrack'), 'user-data installiert conntrack');
  const s = await lesen('iso', 'payload', 'erststart.sh');
  assert.ok(/^PAKETE="[^"]*\bconntrack\b[^"]*"/m.test(s), 'PAKETE in erststart.sh enthält conntrack');
  // Die Datei hat denselben Inhalt wie SYSCTL_TEXT – dann schreibt der Agent sie beim Sammlerstart nicht noch einmal
  assert.ok(s.includes(`cat > ${SYSCTL_DATEI} <<'TXT'\n${SYSCTL_TEXT}TXT\n`), 'sysctl-Datei mit dem Text des Agenten');
  assert.ok(s.includes(`sysctl -p ${SYSCTL_DATEI}`), 'Einstellung sofort anwenden');
  assert.ok(s.includes('/etc/modules-load.d/60-fahnas-conntrack.conf') && s.includes('nf_conntrack'), 'Modul früh laden, damit systemd-sysctl die Einstellung beim Start findet');
  // im Schritt firewall (nach dem Laden der Regeln ist nf_conntrack da), ohne den Schritt scheitern zu lassen
  const fw = /^s_firewall\(\) \{[\s\S]*?^\}$/m.exec(s)[0];
  assert.ok(fw.includes(`sysctl -p ${SYSCTL_DATEI}`) && /sysctl -p [^\n]*\|\| log/.test(fw), 'Fehlschlag von sysctl ist nur ein Hinweis');
});

test('erststart.sh schritt(): ein „|| fehlschlag“ mitten im Schritt bricht ab und setzt keine Markierung', async (t) => {
  if (!(await vorhanden('bash'))) return t.skip('bash fehlt');
  const s = await lesen('iso', 'payload', 'erststart.sh');
  const fn = (name) => { const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(s); assert.ok(m, `${name}() gefunden`); return m[0]; };
  const d = await tmp();
  try {
    const skript = [
      'set -uo pipefail', `MARKER=${JSON.stringify(d)}`, 'LOG=/dev/null',
      'log() { :; }', 'konsole() { :; }', 'fehlschlag() { echo "FEHLER: $*"; return 1; }',
      fn('schritt'),
      's_mitte() { false || fehlschlag "mitten"; echo "weiter-nach-fehler"; }',
      's_gut() { echo "gut"; }',
      '( schritt gut s_gut ); echo "rc_gut=$?"',
      '( schritt mitte s_mitte ); echo "rc_mitte=$?"',
    ].join('\n');
    const r = await laufen('bash', ['-c', skript]);
    assert.match(r.stdout, /rc_gut=0/);
    assert.match(r.stdout, /FEHLER: mitten/);
    assert.ok(!r.stdout.includes('weiter-nach-fehler'), 'nach fehlschlag läuft der Schritt nicht weiter');
    assert.match(r.stdout, /rc_mitte=1/);
    assert.ok(await fs.stat(path.join(d, 'gut.ok')).then(() => true, () => false), 'Markierung für den guten Schritt');
    assert.ok(!(await fs.stat(path.join(d, 'mitte.ok')).then(() => true, () => false)), 'keine Markierung für den gescheiterten Schritt');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('erststart.sh --neuer-als: Versionsvergleich per sort -V (Medium ersetzt nur einen älteren Stand)', async () => {
  const skript = P('iso', 'payload', 'erststart.sh');
  const v = async (a, b) => (await laufen('bash', [skript, '--neuer-als', a, b])).code;
  assert.equal(await v('0.2.0', '0.1.0'), 0, 'Medium 0.2.0 ist neuer als installiert 0.1.0');
  assert.equal(await v('0.1.0', '0.2.0'), 1, 'Medium 0.1.0 ist NICHT neuer als installiert 0.2.0 (fahnas update bleibt)');
  assert.equal(await v('0.1.0', '0.1.0'), 1, 'gleich = nicht neuer');
  assert.equal(await v('0.10.0', '0.9.1'), 0, 'numerisch, nicht lexikalisch');
  assert.equal(await v('0.1.0', ''), 0, 'nichts installiert → Medium gilt als neuer');
  assert.equal(await v('', '0.1.0'), 1, 'leere Medium-Version ist nie neuer');
  assert.equal(await v('1.0.0', '0.99.9'), 0, 'Hauptversion schlägt Nebenversion');
  assert.equal(await v('0.1.1', '0.1.0'), 0, 'Fehlerkorrektur-Stufe zählt');
});

test('smb.conf-Vorlage = globaleVorlage() des Renderers (ohne Urheber-Kopf), mit include und fruit', async () => {
  const datei = await lesen('iso', 'payload', 'samba', 'smb.conf');
  const ohneKopf = datei.split('\n').filter((z, i) => !(i < 4 && /^# (====|Erdacht|\(c\) 2026)/.test(z))).join('\n');
  assert.equal(ohneKopf, globaleVorlage());
  assert.match(datei, /^\s*include = \/etc\/samba\/fahnas\/alle\.conf$/m);
  assert.match(datei, /vfs objects = fruit streams_xattr/); assert.match(datei, /fruit:model = MacSamba/);
  assert.match(datei, /server min protocol = SMB2/); assert.match(datei, /map to guest = Bad User/); assert.match(datei, /server role = standalone server/);
  assert.match(datei, /private dir = \/data\/config\/samba/);
});

test('nftables-Grundregelwerk: Tabelle inet fahnas, dauerhaft aus (policy accept, kein drop), Port-Übersicht, include, kein flush ruleset', async () => {
  const n = await lesen('iso', 'payload', 'nftables', 'fahnas.nft');
  assert.match(n, /^table inet fahnas$/m); assert.match(n, /^flush table inet fahnas$/m);
  assert.match(n, /type filter hook input priority 0; policy accept;/); // Betreiber 12.10.2026: Firewall dauerhaft aus
  assert.ok(!/\bdrop\b/.test(n.split('\n').filter((z) => !z.trim().startsWith('#')).join('\n')), 'keine drop-Regel');
  for (const t of ['iif "lo" accept', 'ct state established,related accept', 'meta l4proto icmp accept', 'meta l4proto ipv6-icmp accept', 'tcp dport 8443 accept', 'tcp dport 445 accept', 'tcp dport 22 accept', 'udp dport 5353 accept',
    'ip protocol igmp accept', 'iifname "virbr*" accept']) assert.ok(n.includes(t), t);
  assert.match(n, /^include "\/etc\/nftables\.d\/\*\.nft"$/m);
  const regeln = n.split('\n').filter((z) => !z.trim().startsWith('#')).join('\n');
  assert.ok(!/flush ruleset/.test(regeln)); assert.ok(!/hook forward/.test(regeln), 'keine forward-Kette (Docker)');
  assert.match(n, /^#!\/usr\/sbin\/nft -f$/m);
  for (const k of [...n.matchAll(/comment "([^"]*)"/g)].map((m) => m[1])) assert.match(k, /^[\x20-\x7e]{1,120}$/, `nft-Kommentar nur ASCII, max. 120 Zeichen: ${k}`);
});

test('nftables: jede Regel des Agenten-Renderers (firewall.js) steht auch im Grundregelwerk (Renderer ⊆ Payload; IGMP/virbr* sind dort noch nachzuziehen)', async () => {
  const payload = await lesen('iso', 'payload', 'nftables', 'fahnas.nft');
  const payloadRegeln = new Set(payload.split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('#')));
  const renderer = nftText({ ssh: true }).split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('#') && !/^[{}]$/.test(z) && !/[{}]$/.test(z));
  assert.ok(renderer.length >= 8, 'Renderer liefert Regeln');
  for (const r of renderer) assert.ok(payloadRegeln.has(r), `Renderer-Regel fehlt im Grundregelwerk: ${r}`);
  // Umgekehrt dokumentiert: was das Grundregelwerk mehr hat, muss der Renderer (Teil C) übernehmen – erlaubt sind nur die
  // beiden bekannten Ergänzungen (leer, sobald firewall.js nachgezogen hat; alles andere wäre neue, unbesprochene Abweichung)
  const erlaubt = ['ip protocol igmp accept', 'iifname "virbr*" accept'];
  const nurPayload = [...payloadRegeln].filter((z) => /accept|drop/.test(z) && !z.startsWith('type ') && !renderer.includes(z) && !z.startsWith('include')).map((z) => z.split(' comment ')[0]);
  assert.ok(nurPayload.every((z) => erlaubt.includes(z)), `unbesprochene Payload-Ergänzung gegenüber firewall.js: ${nurPayload.join(' | ')}`);
});

test('zram.conf und quellen.env: Schlüssel/Werte, Prüfsumme 64 Hex, Version passt zu URL und Datei', async () => {
  const z = await lesen('iso', 'payload', 'zram.conf');
  assert.match(z, /^ALGO=zstd$/m); assert.match(z, /^PERCENT=50$/m);
  const q = await lesen('iso', 'payload', 'quellen.env');
  const w = Object.fromEntries([...q.matchAll(/^([A-Z0-9_]+)=(.+)$/gm)].map((m) => [m[1], m[2]]));
  assert.match(w.GRUB_BTRFS_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(w.GRUB_BTRFS_URL.endsWith(`v${w.GRUB_BTRFS_VERSION}.tar.gz`)); assert.equal(w.GRUB_BTRFS_DATEI, `grub-btrfs-${w.GRUB_BTRFS_VERSION}.tar.gz`);
  for (const zeile of q.split('\n')) if (zeile && !zeile.startsWith('#')) assert.match(zeile, /^[A-Z0-9_]+=[^\s$`;|&]+$/, `quellen.env nur VARIABLE=Wert: ${zeile}`);
});

test('meta-data und README: instance-id, Hinweise auf fahnas.platte= und fahnas.neu=', async () => {
  assert.match(await lesen('iso', 'nocloud', 'meta-data'), /^instance-id: fahnas-installer$/m);
  const r = await lesen('iso', 'README.md'); const t = await lesen('iso', 'payload', 'README.txt');
  for (const x of ['fahnas.platte=', 'fahnas.neu=1', 'FAHNAS-DATEN']) { assert.ok(r.includes(x), `README.md ${x}`); assert.ok(t.includes(x), `README.txt ${x}`); }
  assert.match(r, /re-read after the early-commands/);
  assert.match(r, /select_autoinstall/);
  // Fund R2-4: interactive-sections erzwingt zwei Bestätigungen – dokumentiert mit Beleg statt still übergangen
  for (const x of ['Confirm destructive action', 'Reboot Now']) { assert.ok(r.includes(x), `README.md nennt „${x}“`); assert.ok(t.includes(x), `README.txt nennt „${x}“`); }
  assert.match(r, /user_shutdown_event/, 'Beleg aus shutdown.py');
  assert.ok(!/size: -1.*NICHT dokumentiert/.test(r), 'size -1 ist dokumentiert (Autoinstall-Referenz) und wird benutzt');
  assert.match(r, /fill the\s+remaining space/);
  const u = await lesen('iso', 'nocloud', 'user-data');
  assert.match(u, /Confirm destructive action/);
  for (const x of ['totp-entfernen', 'sitzungen-beenden', 'issue']) assert.ok(t.includes(x), `README.txt nennt fahnas ${x}`);
});

test('Urheber-Kopf in allen Dateien von Teil G', async () => {
  const dateien = [
    P('iso', 'build_iso.sh'), P('iso', 'grub', 'grub.cfg'), P('iso', 'nocloud', 'user-data'), P('iso', 'nocloud', 'meta-data'),
    P('iso', 'payload', 'erststart.sh'), P('iso', 'payload', 'partitionen.sh'), P('iso', 'payload', 'platte_waehlen.sh'), P('iso', 'payload', 'platte_waehlen.py'),
    P('iso', 'payload', 'fahnas-erststart.service'), P('iso', 'payload', 'samba', 'smb.conf'), P('iso', 'payload', 'nftables', 'fahnas.nft'), P('iso', 'payload', 'zram.conf'),
    P('iso', 'payload', 'README.txt'), P('iso', 'payload', 'quellen.env'), P('iso', 'werkzeuge', 'autoinstall_pruefen.mjs'),
    P('systemd', 'fahnas-agent.service'), P('systemd', 'fahnas-web.service'), P('systemd', 'fahnas.target'), fileURLToPath(import.meta.url),
  ];
  for (const d of await fs.readdir(P('tests', 'integration'))) if (d.endsWith('.sh')) dateien.push(P('tests', 'integration', d));
  for (const d of dateien) {
    const kopf = (await fs.readFile(d, 'utf8')).split('\n').slice(0, 8).join('\n');
    for (const k of KOPF) assert.ok(kopf.includes(k), `${path.relative(WURZEL, d)}: Kopfzeile „${k.slice(0, 30)}…“ fehlt`);
  }
});
