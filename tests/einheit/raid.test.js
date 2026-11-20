// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Speicherverbünde (RAID, 12.10.2026): Regeln (Kapazität, Plattenwahl, mdadm-Argumente, mdstat/--detail,
// Zustand, mdadm.conf-Block) und die Aktionen raid.* gegen ein Schein-System (lsblk/mdadm/mkfs/mount) samt
// Freigabe „verbund“ (anlegen/löschen nur über raid.*), Fehlerrücknahme und Meldungen bei Ausfall/Wiederherstellung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as r from '../../src/agent/raid/regeln.js';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import * as raid from '../../src/agent/aktionen/raid.js';
import { werkzeugeBauen, scheinsystem } from './nutzer_scheinsystem.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const GB = 1024 ** 3;

test('raid: Kapazität und verkraftbare Ausfälle je Stufe', () => {
  const vier = [4000, 4000, 4000, 4000].map((x) => x * GB);
  assert.deepEqual([r.rechnen('raid1', vier.slice(0, 2)).kapazitaet / GB, r.rechnen('raid1', vier.slice(0, 2)).ausfaelle], [4000, 1]);
  assert.equal(r.rechnen('raid5', vier.slice(0, 3)).kapazitaet / GB, 8000);
  assert.equal(r.rechnen('raid6', vier).kapazitaet / GB, 8000); assert.equal(r.rechnen('raid6', vier).ausfaelle, 2);
  assert.equal(r.rechnen('raid10', vier).kapazitaet / GB, 8000);
  assert.equal(r.rechnen('raid0', vier.slice(0, 2)).ausfaelle, 0);
  const gemischt = r.rechnen('raid5', [4000 * GB, 2000 * GB, 2000 * GB]);
  assert.equal(gemischt.kapazitaet / GB, 4000, 'kleinste Platte zählt'); assert.equal(gemischt.verschnitt / GB, 2000);
});

const LSBLK = {
  blockdevices: [
    { name: 'sda', type: 'disk', size: 256 * GB, model: 'SSD', tran: 'sata', rota: false, children: [
      { name: 'sda1', type: 'part', label: 'FAHNAS-EFI', mountpoint: '/boot/efi' },
      { name: 'sda2', type: 'part', label: 'FAHNAS-SYSTEM', mountpoint: '/' }] },
    { name: 'sdb', type: 'disk', size: 4000 * GB, model: 'WD Red ', serial: 'A1', tran: 'sata', rota: true },
    { name: 'sdc', type: 'disk', size: 4000 * GB, model: 'WD Red', serial: 'A2', tran: 'sata', rota: true },
    { name: 'nvme0n1', type: 'disk', size: 4000 * GB, model: 'Samsung', serial: 'N1', tran: 'nvme', rota: false },
    { name: 'sdd', type: 'disk', size: 4000 * GB, tran: 'sata', children: [{ name: 'sdd1', type: 'part', children: [{ name: 'vg-daten', type: 'lvm', mountpoints: ['/srv'] }] }] },
    { name: 'sde', type: 'disk', size: 2000 * GB, tran: 'usb' },
    { name: 'sdf', type: 'disk', size: 4000 * GB, tran: 'sata', children: [{ name: 'md127', type: 'raid1' }] },
    { name: 'loop0', type: 'loop', size: 200 * 1024 * 1024 },
    { name: 'sr0', type: 'rom', size: 1 },
  ],
};
const systemPruefen = (d) => [d, ...(d.children || [])].some((x) => x && (x.label === 'FAHNAS-SYSTEM' || x.mountpoint === '/'));

test('raid: Plattenwahl – Systemplatte, verschachtelt Eingehängtes, Verbundmitglied gesperrt; USB/Loop/CD nie', () => {
  const p = r.plattenAuswerten(LSBLK, { systemPruefen });
  assert.deepEqual(p.map((x) => [x.name, x.grund || '', x.art]), [
    ['sda', 'system', 'ssd'], ['sdb', '', 'hdd'], ['sdc', '', 'hdd'], ['nvme0n1', '', 'nvme'], ['sdd', 'eingehaengt', 'ssd'], ['sdf', 'verbund', 'ssd'],
  ]);
  assert.equal(p[1].modell, 'WD Red', 'Modell ohne Leerzeichen am Ende');
  const alt = process.env.FAHNAS_RAID_TEST_LOOPS;
  process.env.FAHNAS_RAID_TEST_LOOPS = '1';
  try { assert.ok(r.plattenAuswerten(LSBLK, { systemPruefen }).some((x) => x.name === 'loop0'), 'Prüfmodus: Loop-Geräte wählbar'); } finally {
    if (alt === undefined) delete process.env.FAHNAS_RAID_TEST_LOOPS; else process.env.FAHNAS_RAID_TEST_LOOPS = alt;
  }
});

test('raid: neuer Verbund – Prüfungen und mdadm-Argumente', () => {
  const platten = r.plattenAuswerten(LSBLK, { systemPruefen });
  const v = r.verbundNormal({ name: ' Daten ', stufe: 'raid5', platten: ['sdb', 'sdc', 'nvme0n1', 'sdb'] }, { platten });
  assert.equal(v.name, 'daten'); assert.deepEqual(v.platten.map((x) => x.pfad), ['/dev/sdb', '/dev/sdc', '/dev/nvme0n1']);
  assert.deepEqual(r.anlegenArgumente(v), ['--create', '/dev/md/fahnas-daten', '--run', '--metadata=1.2', '--name=fahnas-daten', '--level=5', '--raid-devices=3', '--bitmap=internal', '/dev/sdb', '/dev/sdc', '/dev/nvme0n1']);
  const zehn = r.anlegenArgumente({ name: 'x', stufe: 'raid10', platten: [{ pfad: '/a' }, { pfad: '/b' }, { pfad: '/c' }, { pfad: '/d' }] });
  assert.ok(zehn.includes('--layout=n2') && zehn.includes('--level=10'));
  assert.ok(!r.anlegenArgumente({ name: 'x', stufe: 'raid0', platten: [{ pfad: '/a' }, { pfad: '/b' }] }).includes('--bitmap=internal'));
  const fehlt = (e, feld) => (err) => err.details && err.details.feld === feld && (e ? err.code === e : true);
  assert.throws(() => r.verbundNormal({ name: 'a b', stufe: 'raid1', platten: ['sdb', 'sdc'] }, { platten }), fehlt('E_PARAMS', 'name'));
  assert.throws(() => r.verbundNormal({ name: 'daten', stufe: 'raid1', platten: ['sdb', 'sdc'] }, { platten, belegt: ['daten'] }), fehlt('E_EXISTIERT', 'name'));
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid7', platten: ['sdb', 'sdc'] }, { platten }), fehlt('E_PARAMS', 'stufe'));
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid5', platten: ['sdb', 'sdc'] }, { platten }), /mindestens 3/);
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid1', platten: ['sdb', 'sda'] }, { platten }), /Systemplatte/);
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid1', platten: ['sdb', 'sdd'] }, { platten }), /eingehängt/);
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid1', platten: ['sdb', 'sde'] }, { platten }), /gibt es nicht/, 'USB wird gar nicht angeboten');
  assert.throws(() => r.verbundNormal({ name: 'x', stufe: 'raid10', platten: ['sdb', 'sdc', 'nvme0n1'] }, { platten }), /mindestens 4/);
});

const MDSTAT = `Personalities : [raid1] [raid6] [raid5] [raid4] [raid10]
md127 : active raid5 loop3[3] loop2[2] loop0[0] loop1[1](F)
      405504 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [U_U]
      [=>...................]  recovery =  8.5% (17280/202752) finish=0.1min speed=17280K/sec
      bitmap: 0/1 pages [0KB], 65536KB chunk

md126 : active raid1 sdb[1] sda[0]
      976630464 blocks super 1.2 [2/2] [UU]
      [==>..................]  check = 12.0% (117195776/976630464) finish=95.3min speed=150000K/sec

md125 : inactive sdc[0](S)
      976630464 blocks super 1.2

unused devices: <none>
`;

const DETAIL = (zustand = 'clean, degraded', aktiv = 2, zeilen = ['       0       7        0        0      active sync   /dev/loop0', '       -       0        0        1      removed', '       2       7        2        2      active sync   /dev/loop2', '', '       1       7        1        -      faulty   /dev/loop1']) => `/dev/md127:
           Version : 1.2
        Raid Level : raid5
        Array Size : 405504 (396.00 MiB 415.24 MB)
      Raid Devices : 3
     Total Devices : 3
             State : ${zustand}
    Active Devices : ${aktiv}
   Working Devices : ${aktiv}
    Failed Devices : ${3 - aktiv}
     Spare Devices : 0

              Name : fahnas:fahnas-daten  (local to host fahnas)
              UUID : 1a2b3c4d:5e6f7a8b:9c0d1e2f:3a4b5c6d

    Number   Major   Minor   RaidDevice State
${zeilen.join('\n')}
`;

test('raid: /proc/mdstat und mdadm --detail auswerten, Zustand bewerten', () => {
  const m = r.mdstatParsen(MDSTAT);
  assert.equal(m.md127.stufe, 'raid5'); assert.equal(m.md127.status, 'U_U');
  assert.deepEqual(m.md127.geraete.map((g) => [g.name, g.defekt]), [['loop3', false], ['loop2', false], ['loop0', false], ['loop1', true]]);
  assert.deepEqual(m.md127.fortschritt, { art: 'recovery', prozent: 8.5, rest_min: 0.1 });
  assert.deepEqual(m.md126.fortschritt, { art: 'check', prozent: 12, rest_min: 95.3 });
  assert.equal(m.md125.zustand, 'inactive'); assert.equal(m.md125.geraete[0].ersatz, true);
  const d = r.detailParsen(DETAIL());
  assert.equal(d.stufe, 'raid5'); assert.equal(d.groesse, 405504 * 1024); assert.equal(d.uuid, '1a2b3c4d:5e6f7a8b:9c0d1e2f:3a4b5c6d');
  assert.deepEqual([d.aktiv, d.gesamt, d.defekt], [2, 3, 1]);
  assert.deepEqual(d.geraete, [{ pfad: '/dev/loop0', rolle: 'active sync' }, { pfad: null, rolle: 'removed' }, { pfad: '/dev/loop2', rolle: 'active sync' }, { pfad: '/dev/loop1', rolle: 'faulty' }]);
  assert.equal(r.zustandBewerten(d, null), 'beeintraechtigt');
  assert.equal(r.zustandBewerten(d, m.md127), 'wiederaufbau');
  assert.equal(r.zustandBewerten(r.detailParsen(DETAIL('clean', 3)), null), 'ok');
  assert.equal(r.zustandBewerten(r.detailParsen(DETAIL('clean', 3)), { fortschritt: { art: 'resync' } }), 'ok', 'erster Abgleich: nutzbar');
  assert.equal(r.zustandBewerten(r.detailParsen(DETAIL('clean, FAILED', 1)), null), 'ausgefallen');
  assert.equal(r.zustandBewerten(r.detailParsen(''), null), 'fehlt');
});

test('raid/laufwerke: Ansichten (SFTP/DLNA) desselben Dateisystems finden – sie halten es nach dem Aushängen fest', async () => {
  const { ansichtenDesDateisystems } = await import('../../src/agent/protokolle/regeln.js');
  const info = [
    '1518 155 0:235 / /data/shares/raidtest rw,noatime shared:953 - btrfs /dev/md127 rw',
    '1464 34 0:235 / /run/fahnas-ansicht/fabian/raidtest rw,noatime - btrfs /dev/md127 rw',
    '1470 34 0:235 /Filme /run/fahnas-dlna/Filme ro,noatime - btrfs /dev/md127 rw',
    '1465 34 0:57 / /run/fahnas-ansicht/fabian/private rw - btrfs /dev/sda3 rw',
    '1466 34 0:235 / /mnt/fremd rw - btrfs /dev/md127 rw',
  ].join('\n');
  assert.deepEqual(ansichtenDesDateisystems(info, '/data/shares/raidtest'), ['/run/fahnas-ansicht/fabian/raidtest', '/run/fahnas-dlna/Filme']);
  assert.deepEqual(ansichtenDesDateisystems(info, '/data/shares/gibtsnicht'), []);
});

test('raid: mdadm.conf – verwalteter Block wird eingefügt, ersetzt und entfernt, Fremdes bleibt', () => {
  const basis = 'HOMEHOST <system>\nMAILADDR root\n';
  const eins = r.mdadmConfBlock(basis, ['ARRAY /dev/md/fahnas-a metadata=1.2 UUID=1']);
  assert.match(eins, /^HOMEHOST <system>\nMAILADDR root\n\n# FAH-NAS Speicherverbünde – Anfang/);
  const zwei = r.mdadmConfBlock(eins, ['ARRAY /dev/md/fahnas-b metadata=1.2 UUID=2']);
  assert.ok(!zwei.includes('fahnas-a') && zwei.includes('fahnas-b'));
  assert.equal((zwei.match(/Anfang/g) || []).length, 1);
  assert.equal(r.mdadmConfBlock(zwei, []), basis);
});

/** Schein-System für mdadm & Co. über dem Nutzer-/Freigaben-Schein (getent, setfacl, testparm …). */
function raidSchein() {
  const s = scheinsystem();
  const basis = s.ausfuehren;
  const st = { verbund: false, detail: DETAIL('clean', 3, ['       0       8       16        0      active sync   /dev/sdb', '       1       8       32        1      active sync   /dev/sdc', '       2     259        0        2      active sync   /dev/nvme0n1']), eingehaengt: new Set(), fehlerBei: null, extra: [] };
  s.raid = st;
  s.ausfuehren = async (programm, args = [], opt = {}) => {
    const ok = (stdout = '') => { s.befehle.push({ programm, args: [...args], eingabe: opt.eingabe }); return { code: 0, stdout, stderr: '' }; };
    const nein = (code, stderr) => { s.befehle.push({ programm, args: [...args] }); if ((opt.erlaubteCodes || [0]).includes(code)) return { code, stdout: '', stderr }; throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { ausgabe: stderr }); };
    if (st.fehlerBei && st.fehlerBei(programm, args)) return nein(1, `ERROR: ${programm} kaputt\n`);
    switch (programm) {
      case 'dpkg-query': return ok('install ok installed');
      case 'lsblk': {
        const geraete = JSON.parse(JSON.stringify(LSBLK.blockdevices.filter((d) => !['sdd', 'sdf'].includes(d.name))));
        for (const d of geraete) if (st.verbund && ['sdb', 'sdc', 'nvme0n1'].includes(d.name)) d.children = [{ name: 'md127', type: 'raid5' }];
        return ok(JSON.stringify({ blockdevices: [...geraete, ...st.extra] }));
      }
      case 'mdadm':
        if (args[0] === '--create') { st.verbund = true; return ok(); }
        if (args[0] === '--zero-superblock') return nein(1, 'Unrecognised md component device');
        if (args[0] === '--detail' && args[1] === '--brief') return st.verbund ? ok(`ARRAY ${args[2]} metadata=1.2 UUID=1a2b3c4d:5e6f7a8b:9c0d1e2f:3a4b5c6d\n`) : nein(1, 'cannot open');
        if (args[0] === '--detail') return st.verbund ? ok(st.detail) : nein(1, 'cannot open');
        if (args[0] === '--stop') { st.verbund = false; return ok(); }
        return ok();
      case 'blkid': return ok('fs-uuid-1\n');
      case 'findmnt': {
        const ziel = args[args.length - 1];
        return st.eingehaengt.has(ziel) ? ok(args.includes('TARGET,FSTYPE') ? `${ziel} btrfs\n` : `${ziel}\n`) : nein(1, '');
      }
      case 'mount': st.eingehaengt.add(args[args.length - 1]); return ok();
      case 'umount': { // ausgehängt: der Inhalt des Verbunds verschwindet aus dem Einhängepunkt
        st.eingehaengt.delete(args[0]);
        for (const n of await fs.readdir(args[0]).catch(() => [])) await fs.rm(path.join(args[0], n), { recursive: true, force: true });
        return ok();
      }
      case 'df': return ok('        1B-blocks           Avail\n 12000000000 9000000000\n');
      case 'wipefs': case 'udevadm': case 'mkfs.btrfs': case 'chattr': return ok();
      case 'btrfs': if (args[0] === 'filesystem') return ok(); return basis(programm, args, opt);
      default: return basis(programm, args, opt);
    }
  };
  return s;
}

const MELDUNGEN = [];
const meldeModul = { registriere(reg) {
  reg.aktion('benachrichtigungen.senden', { rolle: 'system', beschreibung: 'Schein', schema: { art: { typ: 'string', pflicht: true }, stufe: { typ: 'string' }, titel: { typ: 'string', pflicht: true }, text: { typ: 'string', pflicht: true }, schluessel: { typ: 'string' } }, ausfuehren: async (p) => { MELDUNGEN.push(p); return true; } });
} };

async function aufbau() {
  const scheins = raidSchein();
  const u = await werkzeugeBauen({ scheins, module: [nutzer, freigaben, raid, meldeModul] });
  process.env.FAHNAS_MDADM_CONF = path.join(u.w, 'mdadm.conf');
  await fs.writeFile(process.env.FAHNAS_MDADM_CONF, 'MAILADDR root\n');
  await u.system('nutzer.anlegen', { name: 'chef', passwort: 'sehr-geheim-123', rolle: 'admin' });
  scheins.leeren(); MELDUNGEN.length = 0; raid._test.gemeldet.clear();
  return u;
}

test('raid: anlegen → mdadm, btrfs, einhängen, raid.json, mdadm.conf, Freigabe „verbund“; Liste mit Zustand', async () => {
  const u = await aufbau();
  try {
    const ziel = path.join(u.pfade.shares, 'daten');
    await assert.rejects(u.admin('raid.anlegen', { name: 'daten', stufe: 'raid5', platten: ['sdb', 'sdc', 'nvme0n1'], bestaetigung: 'falsch' }), (e) => e.details.feld === 'bestaetigung');
    assert.ok(!u.scheins.zeilen().some((z) => z.startsWith('wipefs')), 'ohne Bestätigung wird nichts geleert');
    const v = await u.admin('raid.anlegen', { name: 'daten', stufe: 'raid5', platten: ['sdb', 'sdc', 'nvme0n1'], bestaetigung: 'daten' });
    const z = u.scheins.zeilen();
    assert.ok(z.includes('mdadm --create /dev/md/fahnas-daten --run --metadata=1.2 --name=fahnas-daten --level=5 --raid-devices=3 --bitmap=internal /dev/sdb /dev/sdc /dev/nvme0n1'));
    assert.ok(z.includes('mkfs.btrfs -f -L FAHNAS-RAID-daten /dev/md/fahnas-daten'));
    assert.ok(z.includes(`chattr +i ${ziel}`), 'Einhängepunkt gesperrt');
    assert.ok(z.includes(`mount -o noatime,compress=zstd:1,subvol=daten UUID=fs-uuid-1 ${ziel}`), 'Freigabe = Unterlaufwerk daten');
    assert.ok(z.includes(`mount -o noatime,compress=zstd:1,subvol=schnappschuesse UUID=fs-uuid-1 ${path.join(u.pfade.snapshots, 'daten')}`), 'Schnappschüsse auf demselben Dateisystem');
    assert.ok(z.some((x) => /^btrfs subvolume create .*raid-daten\/daten$/.test(x)) && z.some((x) => /^btrfs subvolume create .*raid-daten\/schnappschuesse$/.test(x)));
    assert.ok(z.indexOf('wipefs -a /dev/sdb') < z.findIndex((x) => x.startsWith('mdadm --create')));
    assert.equal(v.zustand, 'ok'); assert.equal(v.eingehaengt, true); assert.equal(v.schnappschuesse, true); assert.deepEqual(v.platz, { gesamt: 12000000000, frei: 9000000000 });
    const json = await u.konfig.laden('raid.json');
    assert.deepEqual(json.verbuende.map((x) => [x.name, x.stufe, x.fs_uuid, x.md_uuid, x.platten.length]), [['daten', 'raid5', 'fs-uuid-1', '1a2b3c4d:5e6f7a8b:9c0d1e2f:3a4b5c6d', 3]]);
    assert.match(await fs.readFile(process.env.FAHNAS_MDADM_CONF, 'utf8'), /^MAILADDR root\n\n# FAH-NAS Speicherverbünde – Anfang.*\nARRAY \/dev\/md\/fahnas-daten metadata=1\.2 UUID=1a2b3c4d/s);
    const f = (await u.konfig.laden('shares.json')).freigaben.find((x) => x.name === 'daten');
    assert.equal(f.verbund, true); assert.deepEqual(f.schreiben, ['chef']); assert.equal(f.groesse_gb, null);
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'daten.conf'), 'utf8')).includes(`path = ${ziel}`));
    // Freigabe-Ansicht: Belegung aus df, kein Kontingent
    const liste = await u.admin('freigaben.liste', {});
    const fa = (Array.isArray(liste) ? liste : liste.freigaben).find((x) => x.name === 'daten');
    assert.deepEqual([fa.verbund, fa.eingehaengt, fa.kapazitaet, fa.belegt], [true, true, 12000000000, 3000000000]);
    // Gleicher Name noch einmal → E_EXISTIERT; Platten sind jetzt Verbundmitglieder
    await assert.rejects(u.admin('raid.anlegen', { name: 'daten', stufe: 'raid1', platten: ['sdb', 'sdc'], bestaetigung: 'daten' }), (e) => e.code === 'E_EXISTIERT');
    const l = await u.admin('raid.liste', {});
    assert.deepEqual(l.verbuende.map((x) => [x.name, x.zustand]), [['daten', 'ok']]);
    assert.deepEqual(l.platten.filter((p) => p.grund === 'verbund').map((p) => p.name), ['sdb', 'sdc', 'nvme0n1']);
    assert.deepEqual(l.stufen.raid10, { min: 4, gerade: true });
    // Freigabe des Verbunds lässt sich nicht über die Freigaben löschen; ohne Einhängung nicht als Verbund anlegen
    await assert.rejects(u.admin('freigaben.loeschen', { name: 'daten', daten: 'loeschen' }), /Speicherverbund/);
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'fremd', verbund: true }), (e) => e.code === 'E_BELEGT');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'fremd', verbund: true, extern: true }), (e) => e.code === 'E_PARAMS');
  } finally { await u.aufraeumen(); }
});

test('raid: Fehler beim Anlegen → Platten wieder frei, kein Eintrag, Meldung mit der letzten Zeile', async () => {
  const u = await aufbau();
  try {
    u.scheins.raid.fehlerBei = (p) => p === 'mkfs.btrfs';
    await assert.rejects(u.admin('raid.anlegen', { name: 'daten', stufe: 'raid1', platten: ['sdb', 'sdc'], bestaetigung: 'daten' }), /Verbund ließ sich nicht anlegen: ERROR: mkfs\.btrfs kaputt/);
    const z = u.scheins.zeilen();
    assert.ok(z.includes('mdadm --stop /dev/md/fahnas-daten'));
    assert.ok(z.filter((x) => x === 'wipefs -a /dev/sdb').length === 2, 'vor dem Anlegen und beim Aufräumen');
    assert.deepEqual(((await u.konfig.laden('raid.json')) || { verbuende: [] }).verbuende, []);
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben, []);
  } finally { await u.aufraeumen(); }
});

test('raid: Ausfall melden, Platte ersetzen, Wiederherstellung melden, Ersatzplatte, Löschen', async () => {
  const u = await aufbau();
  try {
    const ziel = path.join(u.pfade.shares, 'daten');
    await u.admin('raid.anlegen', { name: 'daten', stufe: 'raid5', platten: ['sdb', 'sdc', 'nvme0n1'], bestaetigung: 'daten' });
    const w = u.werkzeuge;
    assert.equal((await u.konfig.laden('raid.json')).verbuende[0].erstabgleich, true);
    await raid.taktPruefen(w);
    assert.equal(MELDUNGEN.length, 0, 'alles in Ordnung → keine Meldung');
    assert.equal((await u.konfig.laden('raid.json')).verbuende[0].erstabgleich, undefined, 'erster Abgleich fertig → Merker weg');
    u.scheins.raid.detail = DETAIL('clean, degraded', 2, ['       0       8       16        0      active sync   /dev/sdb', '       -       0        0        1      removed', '       2     259        0        2      active sync   /dev/nvme0n1', '', '       1       8       32        -      faulty   /dev/sdc']);
    await raid.taktPruefen(w); await raid.taktPruefen(w);
    assert.equal(MELDUNGEN.length, 1, 'nur einmal melden');
    assert.deepEqual([MELDUNGEN[0].art, MELDUNGEN[0].stufe], ['platte', 'fehler']);
    assert.match(MELDUNGEN[0].text, /fehlt eine Platte \(\/dev\/sdc\)/);
    // Ersetzen: neue Platte sdg (gleich groß), zu kleine sdh wird abgelehnt
    u.scheins.raid.extra = [{ name: 'sdg', type: 'disk', size: 4000 * GB, tran: 'sata', serial: 'G1' }, { name: 'sdh', type: 'disk', size: 1000 * GB, tran: 'sata' }];
    await assert.rejects(u.admin('raid.platte_ersetzen', { name: 'daten', alt: 'sdc', neu: 'sdh' }), /kleiner/);
    await assert.rejects(u.admin('raid.platte_ersetzen', { name: 'daten', alt: 'sdc', neu: 'sdb' }), /nicht wählbar/);
    u.scheins.leeren();
    await u.admin('raid.platte_ersetzen', { name: 'daten', alt: 'sdc', neu: 'sdg' });
    assert.ok(u.scheins.zeilen().includes('mdadm --zero-superblock --force /dev/sdc'), 'alte Platte kein Mitglied mehr');
    assert.deepEqual(u.scheins.zeilen().filter((x) => x.startsWith('mdadm --manage')), ['mdadm --manage /dev/md/fahnas-daten --fail /dev/sdc', 'mdadm --manage /dev/md/fahnas-daten --remove /dev/sdc', 'mdadm --manage /dev/md/fahnas-daten --add /dev/sdg']);
    assert.deepEqual((await u.konfig.laden('raid.json')).verbuende[0].platten.map((p) => p.name), ['sdb', 'nvme0n1', 'sdg']);
    u.scheins.raid.detail = DETAIL('clean', 3, ['       0       8       16        0      active sync   /dev/sdb', '       3       8       96        1      active sync   /dev/sdg', '       2     259        0        2      active sync   /dev/nvme0n1']);
    await raid.taktPruefen(w);
    assert.equal(MELDUNGEN.length, 2); assert.equal(MELDUNGEN[1].stufe, 'info'); assert.match(MELDUNGEN[1].titel, /wieder in Ordnung/);
    // Ersatzplatte
    u.scheins.raid.extra = [{ name: 'sdi', type: 'disk', size: 4000 * GB, tran: 'sata' }];
    await u.admin('raid.ersatz_hinzufuegen', { name: 'daten', neu: 'sdi' });
    assert.ok(u.scheins.zeilen().includes('mdadm --manage /dev/md/fahnas-daten --add-spare /dev/sdi'));
    assert.equal((await u.konfig.laden('raid.json')).verbuende[0].platten.find((p) => p.name === 'sdi').ersatz, true);
    // Start: zusammensetzen und einhängen
    u.scheins.raid.eingehaengt.clear(); u.scheins.leeren();
    assert.equal(await u.system('raid.apply', {}), true);
    assert.ok(u.scheins.zeilen().includes('mdadm --assemble --scan') && u.scheins.raid.eingehaengt.has(ziel));
    // Löschen: Bestätigung, Freigabe weg, aushängen, Platten frei, Block aus mdadm.conf
    await assert.rejects(u.admin('raid.loeschen', { name: 'daten', bestaetigung: 'nein' }), (e) => e.details.feld === 'bestaetigung');
    u.scheins.leeren();
    assert.deepEqual(await u.admin('raid.loeschen', { name: 'daten', bestaetigung: 'daten' }), { geloescht: 'daten' });
    const z = u.scheins.zeilen();
    assert.ok(z.includes(`umount ${ziel}`) && z.includes(`umount ${path.join(u.pfade.snapshots, 'daten')}`) && z.includes('mdadm --stop /dev/md/fahnas-daten'));
    for (const p of ['/dev/sdb', '/dev/nvme0n1', '/dev/sdg', '/dev/sdi']) assert.ok(z.includes(`wipefs -a ${p}`), p);
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben, []);
    assert.deepEqual((await u.konfig.laden('raid.json')).verbuende, []);
    assert.equal(await fs.readFile(process.env.FAHNAS_MDADM_CONF, 'utf8'), 'MAILADDR root\n');
    await assert.rejects(fs.stat(ziel), 'Einhängepunkt entfernt');
    await assert.rejects(fs.stat(path.join(u.pfade.snapshots, 'daten')), 'Schnappschuss-Einhängepunkt entfernt');
    await assert.rejects(u.admin('raid.loeschen', { name: 'daten', bestaetigung: 'daten' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); delete process.env.FAHNAS_MDADM_CONF; }
});

test('raid: Erweitern (RAID 5 + Platte, RAID 1 → RAID 5), Größere Platten nutzen, Abschluss wächst das Dateisystem', async () => {
  const u = await aufbau();
  try {
    await u.admin('raid.anlegen', { name: 'daten', stufe: 'raid1', platten: ['sdb', 'sdc'], bestaetigung: 'daten' });
    u.scheins.raid.detail = DETAIL('clean', 2, ['       0       8       16        0      active sync   /dev/sdb', '       1       8       32        1      active sync   /dev/sdc']).replace('raid5', 'raid1').replace('Raid Devices : 3', 'Raid Devices : 2').replace('              Name :', '     Intent Bitmap : Internal\n              Name :');
    u.scheins.raid.extra = [{ name: 'sdg', type: 'disk', size: 4000 * GB, tran: 'sata' }];
    await assert.rejects(u.admin('raid.erweitern', { name: 'daten', platten: ['sdg'], stufe: 'raid6', bestaetigung: 'daten' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('raid.erweitern', { name: 'daten', platten: ['sdg'], stufe: 'raid5', bestaetigung: 'nein' }), (e) => e.details.feld === 'bestaetigung');
    u.scheins.leeren();
    const v = await u.admin('raid.erweitern', { name: 'daten', platten: ['sdg'], stufe: 'raid5', bestaetigung: 'daten' });
    assert.equal(v.wachstum, true);
    const z = u.scheins.zeilen().filter((x) => x.startsWith('mdadm --grow') || x.startsWith('mdadm --manage'));
    assert.deepEqual(z, ['mdadm --grow /dev/md/fahnas-daten --bitmap=none', 'mdadm --grow /dev/md/fahnas-daten --level=5', 'mdadm --manage /dev/md/fahnas-daten --add /dev/sdg', 'mdadm --grow /dev/md/fahnas-daten --raid-devices=3']);
    const json = (await u.konfig.laden('raid.json')).verbuende[0];
    assert.deepEqual([json.stufe, json.platten.map((p) => p.name), json.wachstum.bitmap], ['raid5', ['sdb', 'sdc', 'sdg'], true]);
    // Umbau fertig (kein Fortschritt) → Bitmap wieder an, btrfs wächst, Meldung, Merker weg
    u.scheins.leeren(); MELDUNGEN.length = 0;
    await raid.taktPruefen(u.werkzeuge);
    const z2 = u.scheins.zeilen();
    assert.ok(z2.includes('mdadm --grow /dev/md/fahnas-daten --bitmap=internal'));
    assert.ok(z2.includes(`btrfs filesystem resize max ${path.join(u.pfade.shares, 'daten')}`));
    assert.equal((await u.konfig.laden('raid.json')).verbuende[0].wachstum, undefined);
    assert.match(MELDUNGEN.find((m) => /erweitert/.test(m.titel)).text, /fertig/);
    // RAID 0/10 lassen sich nicht erweitern; Vergrößern ruft --size=max
    assert.throws(() => r.erweiterungPruefen({ stufe: 'raid10' }, { gesamt: 4, neu: 1 }), /nicht erweitern/);
    assert.deepEqual(r.erweiterungPruefen({ stufe: 'raid5' }, { gesamt: 3, neu: 2 }), { ziel: 'raid5', gesamt: 5, umbau: false });
    assert.equal(r.vergroesserbar(2000 * GB, [4000 * GB, 4000 * GB]), true); assert.equal(r.vergroesserbar(4000 * GB - 1, [4000 * GB]), false);
    u.scheins.leeren();
    await u.admin('raid.vergroessern', { name: 'daten' });
    assert.ok(u.scheins.zeilen().includes('mdadm --grow /dev/md/fahnas-daten --size=max'));
  } finally { await u.aufraeumen(); delete process.env.FAHNAS_MDADM_CONF; }
});
