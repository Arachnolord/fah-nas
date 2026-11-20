// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil D2 – externe Laufwerke: lsblk-Auswertung (System-/Fremdplatten, mehrere Partitionen, unbekanntes fs),
// Systemplatten-Erkennung, Namensbildung, Einhängeoptionen je Dateisystem (Soll-Argumentlisten), ntfs3→ntfs-3g-
// Rückfall, Einhängen/Aushängen (EBUSY), Auto-Einhängen (apply), Formatieren-Sicherungen, udev-Zeilenparser,
// extern-Freigabe im Samba-Renderer (available=no/yes), Schnappschuss-Zeitplan überspringt extern, Paketlisten gleich.

process.env.FAHNAS_UEBERWACHUNG = '0'; // im Test keine udevadm-Prozesse starten

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import * as laufwerke from '../../src/agent/aktionen/laufwerke.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import { registriere as regSnapshots, _test as snapTest } from '../../src/agent/aktionen/snapshots.js';
import * as samba from '../../src/agent/render/samba.js';
import { geraeteLesen, nameVorschlag, kennungVon, plattenIstSystem, NAME_MUSTER } from '../../src/agent/laufwerke/erkennen.js';
import { einhaengeVersuche, istPosix, basisOptionen } from '../../src/agent/laufwerke/einhaengen.js';
import { parseUdevZeile } from '../../src/agent/laufwerke/ueberwachung.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN = { nutzer: 'chef', rolle: 'admin', ip: '-' };
const SYSTEM = { nutzer: 'system', rolle: 'system', ip: '-' };

// --- lsblk-Probedaten ------------------------------------------------------------------------------------------
function teil(name, extra) { return { name, path: `/dev/${name}`, type: 'part', size: 1e9, fstype: null, label: null, uuid: null, partuuid: null, mountpoint: null, partn: Number(name.replace(/\D/g, '')) || null, fsavail: null, fsused: null, ...extra }; }
function platte(name, extra) { return { name, path: `/dev/${name}`, type: 'disk', size: 2e12, fstype: null, label: null, uuid: null, partuuid: null, model: null, serial: null, tran: null, rm: false, ro: false, mountpoint: null, children: [], ...extra }; }

// NVMe-Systemplatte + USB-Stick (vfat) + USB-Platte (ntfs mit 2 Partitionen + exfat) + unbekanntes fs + zram/loop (ignoriert)
const PROBE = {
  blockdevices: [
    platte('zram0', { type: 'disk', fstype: 'swap', mountpoint: '[SWAP]' }),
    platte('loop0', { type: 'loop', fstype: 'squashfs', mountpoint: '/snap/x/1' }),
    platte('nvme0n1', {
      tran: 'nvme', model: 'Interne SSD', serial: 'NV1', children: [
        teil('nvme0n1p1', { path: '/dev/nvme0n1p1', size: 1e9, fstype: 'vfat', label: 'FAHNAS-EFI', uuid: 'efi', mountpoint: '/boot/efi', partn: 1 }),
        teil('nvme0n1p2', { path: '/dev/nvme0n1p2', size: 4e9, fstype: 'swap', label: 'FAHNAS-SWAP', uuid: 'sw', mountpoint: '[SWAP]', partn: 2 }),
        teil('nvme0n1p3', { path: '/dev/nvme0n1p3', size: 2e10, fstype: 'btrfs', label: 'FAHNAS-SYSTEM', uuid: 'sys', mountpoint: '/', partn: 3 }),
        teil('nvme0n1p4', { path: '/dev/nvme0n1p4', size: 1e12, fstype: 'btrfs', label: 'FAHNAS-DATEN', uuid: 'dat', mountpoint: '/data', partn: 4 }),
      ],
    }),
    platte('sdb', {
      tran: 'usb', model: 'Kingston DT', serial: 'STK1', rm: true, children: [
        teil('sdb1', { path: '/dev/sdb1', size: 3e10, fstype: 'vfat', label: 'STICK', uuid: 'u-stick', partuuid: 'p-stick', partn: 1 }),
      ],
    }),
    platte('sdc', {
      tran: 'usb', model: 'WD Elements', serial: 'WD123', children: [
        teil('sdc1', { path: '/dev/sdc1', size: 1e12, fstype: 'ntfs', label: 'Backup Platte!', uuid: 'u-win', partn: 1 }),
        teil('sdc2', { path: '/dev/sdc2', size: 5e11, fstype: 'exfat', label: 'MEDIA', uuid: 'u-media', partn: 2 }),
      ],
    }),
    platte('sdd', { tran: 'sata', model: 'Alt', serial: 'OLD', fstype: 'reiserfs', uuid: 'u-unknown' }), // ganze Platte, unbekanntes fs
  ],
};

// --- Testumgebung (Aktionen gegen ein Schein-System) -----------------------------------------------------------
/** Setzt in der lsblk-Baumstruktur den Einhängepunkt aller passenden Geräte (spiegelt echtes mount/umount). */
function setzeLsblkMount(json, passt, mp) {
  const geh = (d) => { if (!d) return; if (passt(d)) d.mountpoint = mp; for (const c of d.children || []) geh(c); };
  for (const d of json.blockdevices || []) geh(d);
}

async function bau({ lsblk = PROBE } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-d2-'));
  const pfade = { konfig: path.join(w, 'config'), shares: path.join(w, 'shares'), snapshots: path.join(w, 'snapshots'), samba: path.join(w, 'samba'), avahi: path.join(w, 'avahi'), backup: path.join(w, 'backup'), daten: w, run: path.join(w, 'run') };
  for (const p of Object.values(pfade)) await fs.mkdir(p, { recursive: true });
  const konfig = new Konfig(pfade.konfig);
  await konfig.sicherstellen();
  await konfig.speichern('users.json', { nutzer: [{ name: ADMIN.nutzer, rolle: 'admin', uid: 1001, gruppen: ['fahnas-admin'] }], gruppen: [] });
  const ereignisse = [];
  const st = { lsblk: structuredClone(lsblk), mounts: new Set(), mountFs: new Map(), aufrufe: [], regeln: [], smart: null, smartCode: 0, fuser: '' };
  st.ausfuehren = async (programm, argumente = [], opt = {}) => {
    st.aufrufe.push([programm, ...argumente]);
    const erl = opt.erlaubteCodes || [0];
    let res = null;
    for (const r of st.regeln) { const x = r(programm, argumente, opt, st); if (x) { res = x; break; } }
    if (!res) {
      const letzt = argumente[argumente.length - 1];
      switch (programm) {
        case 'lsblk': res = { code: 0, stdout: JSON.stringify(st.lsblk) }; break;
        case 'findmnt': res = st.mounts.has(letzt) ? { code: 0, stdout: argumente.includes('TARGET,FSTYPE') ? `${letzt} ${st.mountFs.get(letzt) || 'ext4'}\n` : letzt + '\n' } : { code: 1, stdout: '' }; break;
        case 'getent': res = { code: 0, stdout: 'fahnas-nutzer:x:980:\n' }; break;
        case 'mount': { const geraet = argumente[argumente.length - 2]; st.mounts.add(letzt); if (argumente[0] === '-t') st.mountFs.set(letzt, argumente[1]); setzeLsblkMount(st.lsblk, (d) => d.path === geraet, letzt); res = { code: 0 }; break; }
        case 'umount': st.mounts.delete(letzt); setzeLsblkMount(st.lsblk, (d) => d.mountpoint === letzt, null); res = { code: 0 }; break;
        case 'fuser': res = { code: 0, stderr: st.fuser }; break;
        case 'smartctl': res = { code: st.smartCode, stdout: st.smart ? JSON.stringify(st.smart) : '{}' }; break;
        case 'df': res = { code: 0, stdout: '1B avail\n1000000000 900000000\n' }; break;
        case 'btrfs': if (argumente[0] === 'subvolume' && argumente[1] === 'snapshot') await fs.mkdir(letzt, { recursive: true }); res = { code: 0 }; break;
        default: res = { code: 0, stdout: '', stderr: '' };
      }
    }
    const r = { code: res.code ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
    if (!erl.includes(r.code)) throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { befehl: [programm, ...argumente].join(' '), code: r.code, ausgabe: r.stderr || r.stdout });
    return r;
  };
  const werkzeuge = {
    konfig, system: st, pfade, audit: { eintrag() {} }, aufgaben: null,
    ereignis: (art, daten) => ereignisse.push({ ereignis: art, ...daten }),
    konfigGeaendert: (bereich) => ereignisse.push({ ereignis: 'konfig', bereich }),
    version: () => 'test',
  };
  const reg = new Register();
  werkzeuge.intern = (aktion, params) => rufen(aktion, params, SYSTEM);
  async function rufen(aktion, params, kontext, griff) {
    const { aktion: a, params: p } = reg.vorbereiten(aktion, params ?? {}, kontext);
    const g = griff || { fortschritte: [], fortschritt(x, m) { g.fortschritte.push([x, m]); }, abgebrochen: () => false };
    return a.ausfuehren(p, kontext, werkzeuge, g);
  }
  freigaben.registriere(reg, werkzeuge);
  regSnapshots(reg, werkzeuge);
  laufwerke.registriere(reg, werkzeuge);
  laufwerke._test.abgleichZuruecksetzen();
  return {
    w, pfade, konfig, st, ereignisse, werkzeuge, reg,
    admin: (a, p) => rufen(a, p, ADMIN),
    system: (a, p) => rufen(a, p, SYSTEM),
    ruf: rufen,
    aufraeumen: async () => { laufwerke._test.ueberwachungStoppen(); snapTest.stoppen(); await fs.rm(w, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reine Funktionen (kein System nötig)
// ---------------------------------------------------------------------------------------------------------------
test('erkennen: lsblk-Auswertung – System- und Fremdplatten, mehrere Partitionen, unbekanntes fs, loop/zram ignoriert', () => {
  const g = geraeteLesen(PROBE);
  const nachPfad = Object.fromEntries(g.map((x) => [x.pfad, x]));
  // loop/zram/swap tauchen nicht auf
  assert.ok(!g.some((x) => /loop|zram/.test(x.pfad)));
  // Systempartitionen sind da, aber als system:true markiert
  for (const p of ['/dev/nvme0n1p1', '/dev/nvme0n1p3', '/dev/nvme0n1p4']) assert.equal(nachPfad[p].system, true, p);
  // Externe: Stick (vfat), WD-Platte (ntfs + exfat), Altplatte (unbekanntes fs → fs null)
  assert.equal(nachPfad['/dev/sdb1'].system, false);
  assert.equal(nachPfad['/dev/sdb1'].fs, 'vfat');
  assert.equal(nachPfad['/dev/sdb1'].kennung, 'uuid:u-stick');
  assert.equal(nachPfad['/dev/sdc1'].fs, 'ntfs');
  assert.equal(nachPfad['/dev/sdc2'].fs, 'exfat');
  assert.equal(nachPfad['/dev/sdc1'].platte, '/dev/sdc');
  assert.equal(nachPfad['/dev/sdd'].fs, null, 'unbekanntes reiserfs → fs null (nur formatierbar)');
  assert.equal(nachPfad['/dev/sdd'].kennung, 'uuid:u-unknown');
  // genau die erwarteten externen Einträge
  assert.deepEqual(g.filter((x) => !x.system).map((x) => x.pfad).sort(), ['/dev/sdb1', '/dev/sdc1', '/dev/sdc2', '/dev/sdd']);
});

test('erkennen: Systemplatten-Erkennung über Label und Einhängepunkt', () => {
  assert.equal(plattenIstSystem({ children: [{ label: 'FAHNAS-DATEN' }] }), true);
  assert.equal(plattenIstSystem({ mountpoint: '/' }), true);
  assert.equal(plattenIstSystem({ children: [{ mountpoint: '/var/log' }] }), true);
  assert.equal(plattenIstSystem({ children: [{ mountpoint: '/data' }] }), true);
  // externe Laufwerke hängen unter /data/shares/<name> – das darf NICHT als Systemplatte gelten
  assert.equal(plattenIstSystem({ label: 'STICK', children: [{ label: 'STICK', mountpoint: '/data/shares/stick' }] }), false);
  assert.equal(plattenIstSystem({ label: 'STICK', children: [{ label: 'STICK', mountpoint: null }] }), false);
});

test('erkennen: Kennung UUID > PARTUUID > SERIAL+PARTN', () => {
  assert.equal(kennungVon({ uuid: 'A', partuuid: 'B', serial: 'C', partn: 2 }), 'uuid:A');
  assert.equal(kennungVon({ partuuid: 'B', serial: 'C', partn: 2 }), 'partuuid:B');
  assert.equal(kennungVon({ serial: 'C', partn: 2 }), 'serial:C:2');
  assert.equal(kennungVon({ serial: 'C' }), 'serial:C:0');
  assert.equal(kennungVon({}), null);
});

test('erkennen: Namensbildung aus Label, sonst Anschluss+Modell, Kollision → Suffix', () => {
  assert.equal(nameVorschlag({ label: 'Backup Platte!' }), 'backup-platte');
  assert.equal(nameVorschlag({ label: 'MEINE  DATEN__' }), 'meine-daten');
  assert.equal(nameVorschlag({ label: '', modell: 'Samsung T7', tran: 'usb' }), 'usb-samsung-t7');
  assert.equal(nameVorschlag({ label: '', modell: '', tran: 'usb' }), 'usb-laufwerk');
  assert.equal(nameVorschlag({ label: 'Fotos' }, new Set(['fotos'])), 'fotos-2');
  assert.equal(nameVorschlag({ label: 'Fotos' }, new Set(['fotos', 'fotos-2'])), 'fotos-3');
  assert.ok(NAME_MUSTER.test(nameVorschlag({ label: '///' })));
  assert.ok(nameVorschlag({ label: 'x'.repeat(80) }).length <= 32);
});

test('einhaengen: Soll-Argumentlisten je Dateisystem (§12)', () => {
  const gid = 980;
  assert.deepEqual(einhaengeVersuche('exfat', '/dev/sdb1', '/data/shares/stick', { gid }),
    [['mount', '-t', 'exfat', '-o', 'noatime,nofail,x-fahnas,uid=root,gid=980,umask=007', '/dev/sdb1', '/data/shares/stick']]);
  assert.deepEqual(einhaengeVersuche('vfat', '/dev/sdb1', '/z', { gid }),
    [['mount', '-t', 'vfat', '-o', 'noatime,nofail,x-fahnas,uid=root,gid=980,umask=007', '/dev/sdb1', '/z']]);
  assert.deepEqual(einhaengeVersuche('ext4', '/dev/sdc1', '/z', { gid }),
    [['mount', '-t', 'ext4', '-o', 'noatime,nofail,x-fahnas', '/dev/sdc1', '/z']]);
  assert.deepEqual(einhaengeVersuche('btrfs', '/dev/sdc1', '/z', { gid, nur_lesen: true }),
    [['mount', '-t', 'btrfs', '-o', 'noatime,nofail,x-fahnas,ro', '/dev/sdc1', '/z']]);
  assert.deepEqual(einhaengeVersuche('hfsplus', '/dev/sdc1', '/z', { gid }),
    [['mount', '-t', 'hfsplus', '-o', 'noatime,nofail,x-fahnas,ro', '/dev/sdc1', '/z']], 'hfsplus immer nur lesend');
  assert.deepEqual(einhaengeVersuche('reiserfs', '/dev/sdd', '/z', { gid }), [], 'unbekanntes fs → kein Versuch');
  assert.equal(istPosix('ext4'), true);
  assert.equal(istPosix('ntfs'), false);
  assert.deepEqual(basisOptionen(), ['noatime', 'nofail', 'x-fahnas']);
});

test('einhaengen: ntfs zuerst ntfs3 mit windows_names, Rückfall ntfs-3g', () => {
  const gid = 980;
  const v = einhaengeVersuche('ntfs', '/dev/sdc1', '/z', { gid });
  assert.equal(v.length, 2);
  assert.deepEqual(v[0], ['mount', '-t', 'ntfs3', '-o', 'noatime,nofail,x-fahnas,uid=root,gid=980,umask=007,windows_names', '/dev/sdc1', '/z']);
  assert.deepEqual(v[1], ['mount', '-t', 'ntfs-3g', '-o', 'noatime,nofail,x-fahnas,uid=root,gid=980,umask=007', '/dev/sdc1', '/z']);
});

test('ueberwachung: udev-Zeilenparser', () => {
  assert.deepEqual(parseUdevZeile('UDEV  [1234.5] add      /devices/pci/block/sdb/sdb1 (block)'), { aktion: 'add', geraet: 'sdb1' });
  assert.deepEqual(parseUdevZeile('KERNEL[9.9] remove   /devices/x/block/sdc (block)'), { aktion: 'remove', geraet: 'sdc' });
  assert.deepEqual(parseUdevZeile('UDEV  [1.0] change   /devices/x/block/sdb (block)'), { aktion: 'change', geraet: 'sdb' });
  assert.equal(parseUdevZeile('monitor will print the received events'), null);
  assert.equal(parseUdevZeile(''), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------------------------------------------
test('laufwerke.liste: Systemplatte grau, externe nutzbar, bekannt/automatisch aus laufwerke.json', async () => {
  const u = await bau();
  try {
    await u.konfig.speichern('laufwerke.json', { geraete: [{ kennung: 'uuid:u-stick', name: 'stick', fs: 'vfat', automatisch: true, freigabe: false, optionen: { nur_lesen: false } }] });
    const liste = await u.admin('laufwerke.liste', {});
    const stick = liste.find((x) => x.pfad === '/dev/sdb1');
    assert.equal(stick.bekannt, true); assert.equal(stick.automatisch, true); assert.equal(stick.name, 'stick'); assert.equal(stick.system, false); assert.equal(stick.tran, 'usb');
    const sys = liste.find((x) => x.pfad === '/dev/nvme0n1p3');
    assert.equal(sys.system, true); assert.equal(sys.bekannt, false);
    const wd = liste.find((x) => x.pfad === '/dev/sdc1');
    assert.equal(wd.bekannt, false); assert.equal(wd.fs, 'ntfs');
    assert.throws(() => u.reg.vorbereiten('laufwerke.einhaengen', { pfad: '/dev/sdb1' }, { nutzer: 'x', rolle: 'nutzer', ip: '-' }), (e) => e.code === 'E_RECHTE');
  } finally { await u.aufraeumen(); }
});

test('laufwerke.einhaengen: exfat einhängen, laufwerke.json, Sicherungen (System/schon eingehängt/kein fs)', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'media');
    const e = await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media' });
    assert.equal(e.einhaengepunkt, ziel); assert.equal(e.fs, 'exfat'); assert.equal(e.freigabe, false);
    assert.ok(u.st.mounts.has(ziel), 'ist eingehängt');
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'mount' && a.includes('exfat') && a[a.length - 1] === ziel));
    const konf = await u.konfig.laden('laufwerke.json');
    assert.equal(konf.geraete[0].kennung, 'uuid:u-media'); assert.equal(konf.geraete[0].name, 'media'); assert.equal(konf.geraete[0].automatisch, true);
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'system' && x.art === 'laufwerk' && x.zustand === 'eingehaengt'));
    // Systemplatte, schon eingehängt, kein Dateisystem
    await assert.rejects(u.admin('laufwerke.einhaengen', { pfad: '/dev/nvme0n1p4' }), (er) => er.code === 'E_RECHTE');
    await assert.rejects(u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2' }), (er) => er.code === 'E_BELEGT');
    await assert.rejects(u.admin('laufwerke.einhaengen', { pfad: '/dev/sdd' }), (er) => er.code === 'E_PARAMS');
    await assert.rejects(u.admin('laufwerke.einhaengen', { pfad: '/dev/gibtsnicht' }), (er) => er.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('laufwerke.einhaengen: POSIX-Dateisystem bekommt Rechte-Rundgang, Fremd-fs nicht', async () => {
  const u = await bau({
    lsblk: { blockdevices: [platte('sde', { tran: 'usb', serial: 'E1', children: [teil('sde1', { path: '/dev/sde1', fstype: 'ext4', label: 'DATEN', uuid: 'u-ext', partn: 1 })] })] },
  });
  try {
    const ziel = path.join(u.pfade.shares, 'daten');
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sde1', name: 'daten' });
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'chown' && a[1] === 'root:fahnas-nutzer' && a[2] === ziel), 'chown auf POSIX-Wurzel');
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'chmod' && a[1] === '2770' && a[2] === ziel));
  } finally { await u.aufraeumen(); }
});

test('laufwerke.einhaengen: ntfs3 scheitert → Rückfall ntfs-3g, trotzdem eingehängt', async () => {
  const u = await bau();
  try {
    u.st.regeln.push((p, a) => (p === 'mount' && a.includes('ntfs3')) ? { code: 1, stderr: 'ntfs3: kein Kernel-Treiber' } : null);
    const ziel = path.join(u.pfade.shares, 'win');
    const e = await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc1', name: 'win' });
    assert.equal(e.einhaengepunkt, ziel);
    const mounts = u.st.aufrufe.filter((a) => a[0] === 'mount');
    assert.ok(mounts.some((a) => a.includes('ntfs3')), 'ntfs3 versucht');
    assert.ok(mounts.some((a) => a.includes('ntfs-3g')), 'ntfs-3g als Rückfall');
    assert.ok(u.st.mounts.has(ziel));
  } finally { await u.aufraeumen(); }
});

test('laufwerke.einhaengen freigabe:true + Aushängen: extern-Freigabe, EBUSY meldet Prozesse', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'media');
    const e = await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media', freigabe: true });
    assert.equal(e.freigabe, true);
    const shares = await u.konfig.laden('shares.json');
    const s = shares.freigaben.find((f) => f.name === 'media');
    assert.equal(s.extern, true); assert.equal(s.pfad, ziel);
    assert.ok(await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8').then((t) => t.includes(`path = ${ziel}`)));
    // Aushängen bei belegtem Laufwerk → E_BELEGT mit Prozessliste, Freigabe bleibt
    u.st.regeln.push((p, a) => (p === 'umount' && a[a.length - 1] === ziel) ? { code: 32, stderr: 'umount: target is busy' } : null);
    u.st.fuser = 'kernel mount /data/shares/media:\n 1234 c bash';
    await assert.rejects(u.admin('laufwerke.aushaengen', { kennung: 'uuid:u-media' }), (er) => er.code === 'E_BELEGT' && /1234/.test(er.details.prozesse));
    assert.ok((await u.konfig.laden('shares.json')).freigaben.some((f) => f.name === 'media'), 'Freigabe bleibt in shares.json');
    // jetzt erfolgreich aushängen → available=no, Freigabe bleibt
    u.st.regeln.length = 0;
    await u.admin('laufwerke.aushaengen', { kennung: 'uuid:u-media' });
    assert.ok(!u.st.mounts.has(ziel), 'ausgehängt');
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8')).includes('available = no'), 'nicht eingehängt → available=no');
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'smbcontrol' && a.includes('close-share')));
  } finally { await u.aufraeumen(); }
});

test('laufwerke.aushaengen vergessen: Eintrag weg, Strom abschalten (udisksctl)', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'stick');
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdb1', name: 'stick' });
    await u.admin('laufwerke.aushaengen', { kennung: 'uuid:u-stick', vergessen: true });
    assert.deepEqual((await u.konfig.laden('laufwerke.json')).geraete, [], 'vergessen → aus laufwerke.json');
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'udisksctl' && a[1] === 'power-off' && a[3] === '/dev/sdb'), 'Strom auf der Platte, nicht der Partition');
    assert.ok(!u.st.mounts.has(ziel));
  } finally { await u.aufraeumen(); }
});

test('laufwerke.apply: bekannte, angeschlossene Geräte mit automatisch:true werden eingehängt (Auto-Einhängen)', async () => {
  const u = await bau();
  try {
    await u.konfig.speichern('laufwerke.json', { geraete: [
      { kennung: 'uuid:u-stick', name: 'stick', fs: 'vfat', automatisch: true, freigabe: false, optionen: { nur_lesen: false } },
      { kennung: 'uuid:u-media', name: 'media', fs: 'exfat', automatisch: false, freigabe: false, optionen: {} },
      { kennung: 'uuid:weg', name: 'weg', fs: 'ext4', automatisch: true, freigabe: false, optionen: {} }, // nicht angeschlossen
    ] });
    const r = await u.system('laufwerke.apply', {});
    assert.deepEqual(r.eingehaengt, ['stick'], 'nur das angeschlossene automatisch:true');
    assert.ok(u.st.mounts.has(path.join(u.pfade.shares, 'stick')));
    assert.ok(!u.st.mounts.has(path.join(u.pfade.shares, 'media')), 'automatisch:false bleibt aus');
    assert.equal(r.ueberwachung, false, 'Überwachung im Test unterdrückt (FAHNAS_UEBERWACHUNG=0)');
    assert.throws(() => u.reg.vorbereiten('laufwerke.apply', {}, ADMIN), (e) => e.code === 'E_RECHTE', 'apply nur System');
  } finally { await u.aufraeumen(); }
});

test('laufwerke.formatieren: Sicherungen (Bestätigung, System, eingehängt) und mkfs je fs', async () => {
  const u = await bau();
  try {
    // Bestätigung muss dem Gerätepfad gleichen
    await assert.rejects(u.admin('laufwerke.formatieren', { pfad: '/dev/sdb1', fs: 'exfat', label: 'NEU', bestaetigung: '/dev/sdb' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'bestaetigung');
    // Systemplatte
    await assert.rejects(u.admin('laufwerke.formatieren', { pfad: '/dev/nvme0n1p4', fs: 'btrfs', label: 'X', bestaetigung: '/dev/nvme0n1p4' }), (e) => e.code === 'E_RECHTE');
    // eingehängt
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdb1', name: 'stick' });
    await assert.rejects(u.admin('laufwerke.formatieren', { pfad: '/dev/sdb1', fs: 'exfat', label: 'X', bestaetigung: '/dev/sdb1' }), (e) => e.code === 'E_BELEGT');
    // erfolgreich: nicht eingehängtes Fremdlaufwerk
    const r = await u.admin('laufwerke.formatieren', { pfad: '/dev/sdc1', fs: 'ext4', label: 'Neu Platte', bestaetigung: '/dev/sdc1' });
    assert.equal(r.formatiert, true);
    assert.ok(u.st.aufrufe.some((a) => a.join(' ') === 'mkfs.ext4 -F -L Neu Platte /dev/sdc1'));
    await assert.rejects(u.admin('laufwerke.formatieren', { pfad: '/dev/sdc2', fs: 'ext2', label: 'X', bestaetigung: '/dev/sdc2' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'fs', 'ext2 ist kein erlaubtes Zielformat');
  } finally { await u.aufraeumen(); }
});

test('laufwerke.smart: NVMe-Auswertung (Lebensdauer/Medienfehler → warnung)', async () => {
  const u = await bau();
  try {
    u.st.smart = { model_name: 'WD Elements', temperature: { current: 41 }, nvme_smart_health_information_log: { percentage_used: 95, media_errors: 3, critical_warning: 0 }, smart_status: { passed: true } };
    const r = await u.admin('laufwerke.smart', { pfad: '/dev/sdc1' });
    assert.equal(r.geraet, '/dev/sdc', 'S.M.A.R.T. auf der Platte, nicht der Partition');
    assert.equal(r.zustand, 'warnung'); assert.equal(r.temperatur, 41);
    assert.ok(r.details.gruende.some((g) => /Lebensdauer/.test(g)) && r.details.gruende.some((g) => /Medienfehler/.test(g)));
  } finally { await u.aufraeumen(); }
});

test('samba-Renderer: extern-Freigabe available=no wenn nicht eingehängt, available=yes wenn eingehängt', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'usbdisk');
    const share = { name: 'usbdisk', extern: true, pfad: ziel, schreiben: ['chef'], lesen: [], papierkorb: false };
    // nicht eingehängt → available = no
    await samba.rendern(u.werkzeuge, [share]);
    let conf = await fs.readFile(path.join(u.pfade.samba, 'usbdisk.conf'), 'utf8');
    assert.ok(conf.includes('available = no'), 'nicht eingehängt → available=no');
    assert.ok(conf.includes('valid users = chef'), 'Rechte bleiben erhalten');
    // eingehängt → keine available=no-Zeile
    u.st.mounts.add(ziel);
    await samba.rendern(u.werkzeuge, [share]);
    conf = await fs.readFile(path.join(u.pfade.samba, 'usbdisk.conf'), 'utf8');
    assert.ok(!conf.includes('available = no'), 'eingehängt → available bleibt (yes)');
    assert.ok(conf.includes('valid users = chef'));
  } finally { await u.aufraeumen(); }
});

test('snapshots: Zeitplan und Liste überspringen externe Freigaben', async () => {
  const u = await bau();
  try {
    await fs.mkdir(path.join(u.pfade.shares, 'medien'), { recursive: true });
    await fs.mkdir(path.join(u.pfade.shares, 'usb'), { recursive: true });
    await u.konfig.speichern('shares.json', { freigaben: [
      { name: 'medien', schreiben: ['chef'], lesen: [] },
      { name: 'usb', extern: true, pfad: path.join(u.pfade.shares, 'usb'), schreiben: ['chef'], lesen: [] },
    ] });
    await u.konfig.speichern('snapshots.json', { plaene: [
      { ziel: 'medien', zeitplan: { stuendlich: true }, behalten: { stuendlich: 3 } },
      { ziel: 'usb', zeitplan: { stuendlich: true }, behalten: { stuendlich: 3 } },
    ] });
    snapTest.setzeJetzt(() => new Date('2026-09-25T10:00:00.000Z'));
    const r = await snapTest.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.freigabe), ['medien'], 'nur die interne Freigabe bekommt einen Schnappschuss');
    // snapshots.liste für die externe Freigabe ist leer
    const liste = await u.admin('snapshots.liste', { ziel: 'usb' });
    assert.deepEqual(liste, []);
    const l2 = await u.admin('snapshots.liste', { ziel: 'medien' });
    assert.equal(l2.length, 1);
  } finally { snapTest.setzeJetzt(null); snapTest.stoppen(); await u.aufraeumen(); }
});

test('Pakete: user-data und erststart.sh führen dieselben Laufwerks-Pakete (ntfs-3g exfatprogs …)', async () => {
  const nötig = ['ntfs-3g', 'exfatprogs', 'dosfstools', 'e2fsprogs', 'xfsprogs', 'hfsprogs', 'udisks2'];
  const userData = await fs.readFile(path.join(WURZEL, 'iso', 'nocloud', 'user-data'), 'utf8');
  const erststart = await fs.readFile(path.join(WURZEL, 'iso', 'payload', 'erststart.sh'), 'utf8');
  const m = /^PAKETE="([^"]+)"/m.exec(erststart);
  assert.ok(m, 'PAKETE="…" in erststart.sh');
  const erstPakete = new Set(m[1].trim().split(/\s+/));
  const udPakete = new Set([...userData.matchAll(/^\s*-\s+([A-Za-z0-9][A-Za-z0-9.+-]*)\s*$/gm)].map((x) => x[1]));
  for (const p of nötig) {
    assert.ok(erstPakete.has(p), `erststart.sh enthält ${p}`);
    assert.ok(udPakete.has(p), `user-data enthält ${p}`);
  }
});

test('Laufwerk freigeben (Betreiber-Fund 26.09.): der freigebende Admin bekommt Schreibrecht – sonst schaltet Samba die Freigabe ab (leeres valid users)', async () => {
  const u = await bau();
  try {
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media', freigabe: true });
    const s = (await u.konfig.laden('shares.json')).freigaben.find((f) => f.name === 'media');
    assert.deepEqual(s.schreiben, [ADMIN.nutzer], 'Admin, der freigibt, darf schreiben');
    const conf = await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8');
    assert.ok(!conf.includes('available = no'), 'eingehängt und mit Berechtigtem → verfügbar (kein available = no)');
    assert.match(conf, new RegExp(`valid users = .*${ADMIN.nutzer}`));
    const l = (await u.admin('laufwerke.liste', {})).find((g) => g.name === 'media');
    assert.equal(l.freigabe_ohne_rechte, false);
  } finally { await u.aufraeumen(); }
});

test('Laufwerk: manuelles Wiedereinhängen einer bestehenden Freigabe schreibt Samba neu (wieder verfügbar) statt still bei available=no zu bleiben', async () => {
  const u = await bau();
  try {
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media', freigabe: true });
    await u.admin('laufwerke.aushaengen', { kennung: 'uuid:u-media' });
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8')).includes('available = no'));
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', freigabe: true });
    assert.ok(!(await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8')).includes('available = no'), 'nach dem Wiedereinhängen wieder verfügbar');
  } finally { await u.aufraeumen(); }
});

test('Laufwerk: Freigabe nachträglich einschalten gibt dem Admin Schreibrecht; Freigabe ohne Berechtigte wird in der Liste gemeldet', async () => {
  const u = await bau();
  try {
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media', freigabe: false });
    await u.admin('laufwerke.aendern', { kennung: 'uuid:u-media', freigabe: true });
    const s = (await u.konfig.laden('shares.json')).freigaben.find((f) => f.name === 'media');
    assert.deepEqual(s.schreiben, [ADMIN.nutzer]);
    // Altbestand (vor 0.2.10 angelegt): Freigabe ohne Berechtigte → Liste meldet es, damit die Oberfläche warnen kann
    await u.konfig.aendern('shares.json', (d) => { d.freigaben.find((f) => f.name === 'media').schreiben = []; return d; });
    const l = (await u.admin('laufwerke.liste', {})).find((g) => g.name === 'media');
    assert.equal(l.freigabe_ohne_rechte, true);
  } finally { await u.aufraeumen(); }
});

test('samba-Renderer: exFAT/FAT (keine erweiterten Attribute) ohne fruit/streams_xattr – sonst scheitern Finder-Metadaten (SMB-Probe 26.09.)', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'stick');
    const share = { name: 'stick', extern: true, pfad: ziel, schreiben: ['chef'], lesen: [], papierkorb: false };
    u.st.mounts.add(ziel); u.st.mountFs.set(ziel, 'exfat');
    await samba.rendern(u.werkzeuge, [share]);
    let conf = await fs.readFile(path.join(u.pfade.samba, 'stick.conf'), 'utf8');
    assert.ok(!/streams_xattr|fruit/.test(conf.split('\n').find((z) => z.includes('vfs objects')) || 'fruit'), `keine Streams über xattr: ${conf}`);
    assert.match(conf, /ea support = no/); assert.match(conf, /store dos attributes = no/);
    // DOS-Attribute nicht auf Unix-Rechte abbilden: sonst chmod auf root-eigene exFAT-Dateien → ACCESS_DENIED beim Löschen
    for (const m of ['map archive', 'map hidden', 'map system', 'map readonly']) assert.match(conf, new RegExp(`${m} = no`), m);
    for (const [fsTyp, ohne] of [['vfat', true], ['ntfs3', false], ['ext4', false], ['fuseblk', false]]) {
      u.st.mountFs.set(ziel, fsTyp);
      await samba.rendern(u.werkzeuge, [share]);
      conf = await fs.readFile(path.join(u.pfade.samba, 'stick.conf'), 'utf8');
      assert.equal(/ea support = no/.test(conf), ohne, fsTyp);
      assert.equal(/vfs objects = fruit streams_xattr/.test(conf), !ohne, fsTyp);
    }
    // interne Freigaben unverändert mit fruit/streams_xattr
    assert.match(samba.freigabeText({ name: 'medien', schreiben: ['chef'] }), /vfs objects = fruit streams_xattr/);
  } finally { await u.aufraeumen(); }
});

test('freigaben.liste: externe Freigabe meldet Belegung + Größe aus df (Betreiber-Fund 09.10.: „0 B belegt“); nicht eingehängt → null ohne df', async () => {
  const u = await bau();
  try {
    const ziel = path.join(u.pfade.shares, 'usb');
    await fs.mkdir(ziel, { recursive: true });
    await u.konfig.speichern('shares.json', { freigaben: [{ name: 'usb', extern: true, pfad: ziel, schreiben: ['chef'], lesen: [] }] });
    // nicht eingehängt: df sähe die Datenpartition darunter → keine Zahlen, kein df-Aufruf
    let [f] = await u.admin('freigaben.liste', {});
    assert.equal(f.eingehaengt, false);
    assert.equal(f.belegt, null); assert.equal(f.kapazitaet, null);
    assert.ok(!u.st.aufrufe.some((a) => a[0] === 'df'), 'kein df für ein nicht eingehängtes Laufwerk');
    // eingehängt: df -B1 --output=size,avail (Schein-System: 1 GB groß, 900 MB frei)
    u.st.mounts.add(ziel);
    [f] = await u.admin('freigaben.liste', {});
    assert.equal(f.eingehaengt, true);
    assert.equal(f.kapazitaet, 1_000_000_000);
    assert.equal(f.belegt, 100_000_000);
    assert.deepEqual(u.st.aufrufe.find((a) => a[0] === 'df'), ['df', '-B1', '--output=size,avail', '--', ziel]);
    // df scheitert (hängendes Gerät, Zeitlimit) → null statt Listenfehler
    u.st.regeln.push((programm) => (programm === 'df' ? { code: 1, stderr: 'Zeitüberschreitung' } : null));
    [f] = await u.admin('freigaben.liste', {});
    assert.equal(f.belegt, null); assert.equal(f.kapazitaet, null);
  } finally { await u.aufraeumen(); }
});

test('Laufwerk ohne Aushängen abgezogen (Betreiber-Fund 09.10., /data/shares/256gb): tote Einhängung wird ausgehängt, Freigabe auf „nicht verfügbar“ – angesteckte bleiben', async () => {
  const u = await bau();
  try {
    // findmnt -rn -o TARGET,SOURCE: alle Einhängungen aus dem Schein-System (Quelle = Gerät des letzten mount-Aufrufs)
    u.st.regeln.push((prog, args, _o, st) => {
      if (prog !== 'findmnt' || args[0] !== '-rn') return null;
      const zeilen = ['/data /dev/nvme0n1p4', `${u.pfade.shares} /dev/nvme0n1p4[/@shares]`];
      for (const ziel of st.mounts) { const m = [...st.aufrufe].reverse().find((a) => a[0] === 'mount' && a[a.length - 1] === ziel); zeilen.push(`${ziel} ${m ? m[m.length - 2] : '?'}`); }
      return { code: 0, stdout: zeilen.join('\n') + '\n' };
    });
    // test -b <gerät>: Gerätedatei gibt es nur für Geräte, die lsblk kennt – außer der verschlüsselten, von Hand eingehängten
    const geraetDa = (st, p) => p === '/dev/mapper/tresor' || JSON.stringify(st.lsblk).includes(`"${p}"`);
    u.st.regeln.push((prog, args, _o, st) => (prog === 'test' && args[0] === '-b' ? { code: geraetDa(st, args[1]) ? 0 : 1 } : null));
    const media = path.join(u.pfade.shares, 'media'); const stick = path.join(u.pfade.shares, 'stick');
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdc2', name: 'media' });
    await u.admin('laufwerke.einhaengen', { pfad: '/dev/sdb1', name: 'stick' });
    await u.konfig.speichern('shares.json', { freigaben: [{ name: 'media', extern: true, pfad: media, schreiben: ['chef'], lesen: [] }] });
    const tresor = path.join(u.pfade.shares, 'tresor'); u.st.mounts.add(tresor); u.st.aufrufe.push(['mount', '/dev/mapper/tresor', tresor]); // von Hand, lsblk führt es nicht
    await laufwerke.abgleich(u.werkzeuge); // Ausgangsstand merken – alles angesteckt, nichts auszuhängen
    assert.ok(!u.st.aufrufe.some((a) => a[0] === 'umount'), 'nichts ausgehängt, solange alles angesteckt ist');

    // WD-Platte (sdc) abziehen, ohne auszuhängen: lsblk kennt sie nicht mehr, die Einhängung bleibt stehen
    u.st.lsblk.blockdevices = u.st.lsblk.blockdevices.filter((d) => d.name !== 'sdc');
    u.ereignisse.length = 0;
    await laufwerke.abgleich(u.werkzeuge);
    assert.ok(u.st.aufrufe.some((a) => a[0] === 'umount' && a[1] === '-l' && a[2] === media), 'tote Einhängung (lazy) ausgehängt');
    assert.ok(!u.st.mounts.has(media));
    assert.ok(u.st.mounts.has(stick) && !u.st.aufrufe.some((a) => a[0] === 'umount' && a.includes(stick)), 'der angesteckte Stick bleibt');
    assert.ok(!u.st.aufrufe.some((a) => a[0] === 'umount' && (a.includes('/data') || a.includes(u.pfade.shares))), 'Datenpartition nie');
    assert.ok(u.st.mounts.has(tresor), 'Gerätedatei noch da (z. B. /dev/mapper) → bleibt eingehängt');
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'system' && x.zustand === 'ausgehaengt' && x.geraet && x.geraet.name === 'media' && x.geraet.grund === 'abgezogen'));
    const conf = await fs.readFile(path.join(u.pfade.samba, 'media.conf'), 'utf8');
    assert.ok(conf.includes('available = no'), 'Samba bietet die Freigabe nicht mehr an');
    // zweiter Abgleich: nichts mehr zu tun
    const n = u.st.aufrufe.filter((a) => a[0] === 'umount').length;
    await laufwerke.abgleich(u.werkzeuge);
    assert.equal(u.st.aufrufe.filter((a) => a[0] === 'umount').length, n);

    // lsblk liefert nichts (Lesefehler): lieber nichts aushängen als alles
    u.st.lsblk = { blockdevices: [] };
    await laufwerke.abgleich(u.werkzeuge);
    assert.ok(u.st.mounts.has(stick), 'leere Geräteliste hängt nichts aus');
  } finally { await u.aufraeumen(); }
});
