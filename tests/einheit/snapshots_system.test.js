// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests System-Rückrollen (Umbenenn-Ansatz): snapshots.system.standard (Befehlsfolge, snapper-Sicherung, Zurückdrehen
// bei Fehlern in Schritt 3/4, Prüfung von fstab/grub.cfg im neuen @, Reste-Begrenzung, Schutz der laufenden Wurzel),
// snapshots.system.zurueck (Rücktausch + Zurückdrehen), snapshots.system.reste / rest_loeschen, Sperre gegen
// parallele Läufe, Rest einer alten Einhängung. Die Poolwurzel ist ein Ordner unter <run>/sysroot; btrfs/mv/mount/
// findmnt/snapper werden nachgespielt und alle Aufrufe festgehalten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { registriere, _test, RESTE_BEHALTEN, REST_NAME } from '../../src/agent/aktionen/snapshots.js';

const K = { chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, fabian: { nutzer: 'fabian', rolle: 'nutzer', ip: '-' } };
const FSTAB = 'UUID=aaaa-sys  /  btrfs  subvol=@,compress=zstd:1,noatime  0  0\nUUID=aaaa-sys  /.snapshots  btrfs  subvol=@snapshots,compress=zstd:1,noatime  0  0\n';
const GRUB = "menuentry 'Ubuntu' {\n\tlinux /@/boot/vmlinuz root=UUID=aaaa-sys ro rootflags=subvol=@ quiet\n}\n";
const ok = { code: 0, stdout: '', stderr: '' };
const ALT_20 = '@_alt_2026-09-20T03-00-00'; const ALT_21 = '@_alt_2026-09-21T03-00-00'; const KAPUTT_22 = '@_kaputt_2026-09-22T03-00-00';

async function lesbar(p) { try { await fs.access(p); return true; } catch { return false; } }
async function marker(p) { try { return await fs.readFile(path.join(p, 'etc/marker'), 'utf8'); } catch { return null; } }

/** Legt einen „Wurzelstand“ (Ordner mit fstab, grub.cfg, Markierung) an. */
async function stand(ordner, markierung, { fstab = FSTAB, grub = GRUB } = {}) {
  await fs.mkdir(path.join(ordner, 'etc'), { recursive: true });
  await fs.mkdir(path.join(ordner, 'boot/grub'), { recursive: true });
  await fs.writeFile(path.join(ordner, 'etc/marker'), markierung);
  if (fstab !== null) await fs.writeFile(path.join(ordner, 'etc/fstab'), fstab);
  if (grub !== null) await fs.writeFile(path.join(ordner, 'boot/grub/grub.cfg'), grub);
}

/**
 * Testumgebung: <w>/run/sysroot spielt die Poolwurzel (subvolid=5) der Systempartition. `zustand` steuert die
 * laufende Wurzel (findmnt), das Gerät, Fehler (`scheitern`), die snapper-Nummer, alte btrfs-progs ohne --recursive
 * und einen Rest einer alten Einhängung.
 */
async function umgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-b-sys-'));
  const run = path.join(w, 'run'); const sysroot = path.join(run, 'sysroot');
  await stand(path.join(sysroot, '@'), 'alt');
  await stand(path.join(sysroot, '@snapshots/7/snapshot'), 'sieben');
  await stand(path.join(sysroot, '@snapshots/3/snapshot'), 'drei', { fstab: 'UUID=x / btrfs compress=zstd:1 0 0\n', grub: null });
  const zustand = { wurzel: '@', geraet: '/dev/sda3', scheitern: null, snapperNr: 41, alteProgs: false, sysrootBelegt: false };
  const aufrufe = []; const ereignisse = [];
  const inSysroot = (p) => (p.startsWith('/.snapshots/') ? path.join(sysroot, '@snapshots', p.slice('/.snapshots/'.length)) : p);
  const sys = {
    async ausfuehren(prog, args, opt = {}) {
      aufrufe.push([prog, ...args]);
      if (zustand.scheitern && zustand.scheitern(prog, args)) throw new FahnasFehler('E_SYSTEM', 'kaputt', { befehl: [prog, ...args].join(' '), ausgabe: 'Testfehler' });
      if (prog === 'findmnt' && args.at(-1) === '/') return { ...ok, stdout: `${zustand.geraet}${zustand.wurzel ? `[/${zustand.wurzel}]` : ''}\n` };
      if (prog === 'findmnt') { assert.ok((opt.erlaubteCodes || []).includes(1), 'findmnt auf den Mountpunkt muss Code 1 erlauben'); return zustand.sysrootBelegt ? { ...ok, stdout: `${zustand.geraet}\n` } : { code: 1, stdout: '', stderr: '' }; }
      if (prog === 'mount' || prog === 'umount') return ok;
      if (prog === 'btrfs' && args[1] === 'show') { if (await lesbar(inSysroot(args[2]))) return { ...ok, stdout: `${args[2]}\n\tFlags:\t\t\treadonly\n` }; throw new FahnasFehler('E_SYSTEM', 'nicht da', { befehl: 'btrfs subvolume show', ausgabe: 'ERROR: not a subvolume' }); }
      if (prog === 'btrfs' && args[1] === 'snapshot') { await fs.cp(inSysroot(args[2]), args[3], { recursive: true }); return ok; }
      if (prog === 'btrfs' && args[1] === 'delete') {
        if (zustand.alteProgs && args.includes('--recursive')) throw new FahnasFehler('E_SYSTEM', 'alt', { befehl: 'btrfs', ausgabe: "btrfs subvolume delete: unrecognized option '--recursive'" });
        await fs.rm(args.at(-1), { recursive: true, force: true }); return ok;
      }
      if (prog === 'mv') { await fs.rename(args[1], args[2]); return ok; }
      if (prog === 'snapper') return { ...ok, stdout: `${zustand.snapperNr}\n` };
      return ok;
    },
  };
  const werkzeuge = { system: sys, pfade: { run, shares: path.join(w, 'shares'), snapshots: path.join(w, 'snapshots'), konfig: path.join(w, 'config') }, konfigGeaendert: (b) => ereignisse.push({ ereignis: 'konfig', bereich: b }), ereignis: (art, d) => ereignisse.push({ ereignis: art, ...d }) };
  const reg = new Register(); registriere(reg, werkzeuge);
  async function auf(name, params, kontext) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    return aktion.ausfuehren(p, kontext, werkzeuge, { fortschritt() {}, abgebrochen: () => false });
  }
  return { w, sysroot, at: path.join(sysroot, '@'), zustand, aufrufe, ereignisse, reg, auf };
}

const SNAP7 = '/.snapshots/7/snapshot';
const ALT_25 = '@_alt_2026-09-25T12-00-00';

test('system.standard: Befehlsfolge des Umbenenn-Ansatzes, snapper-Sicherung, Reste, Rechte, unbekannte Kennung', async () => {
  const u = await umgebung();
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    assert.throws(() => u.reg.vorbereiten('snapshots.system.standard', { id: '7' }, K.fabian), (e) => e.code === 'E_RECHTE');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.standard', { id: 'abc' }, K.chef), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('snapshots.system.standard', { id: '8' }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.deepEqual(u.aufrufe, [['btrfs', 'subvolume', 'show', '/.snapshots/8/snapshot']], 'ohne Schnappschuss wird nichts eingehängt');

    u.aufrufe.length = 0;
    const s = await u.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.equal(s.neustart_noetig, true); assert.equal(s.alt, ALT_25); assert.equal(s.quelle, '7'); assert.equal(s.id, '7'); assert.equal(s.sicherheit, '41');
    assert.deepEqual(s.warnungen, []); assert.deepEqual(s.geloeschte_reste, []);
    assert.match(s.hinweis, /@_alt_2026-09-25T12-00-00/); assert.match(s.hinweis, /Neustart/);
    assert.equal(s.unterlaufwerk, undefined, 'kein set-default-Ergebnisfeld mehr');
    assert.deepEqual(u.aufrufe, [
      ['btrfs', 'subvolume', 'show', SNAP7],
      ['findmnt', '-n', '-o', 'SOURCE', '/'],
      ['findmnt', '-n', '-o', 'SOURCE', u.sysroot],
      ['mount', '-t', 'btrfs', '-o', 'subvolid=5', '/dev/sda3', u.sysroot],
      ['snapper', '-c', 'root', 'create', '-t', 'single', '-d', 'Vor Rückrollen auf 7 (FAH-NAS)', '--print-number'],
      ['mv', '-T', u.at, path.join(u.sysroot, ALT_25)],
      ['btrfs', 'subvolume', 'snapshot', SNAP7, u.at],
      ['umount', u.sysroot],
    ]);
    assert.ok(!u.aufrufe.some((a) => a[0] === 'update-grub' || a.includes('set-default')), 'weder update-grub noch set-default');
    assert.equal(await marker(u.at), 'sieben', '@ ist jetzt die Kopie des Schnappschusses');
    assert.equal(await marker(path.join(u.sysroot, ALT_25)), 'alt', 'der alte Stand liegt als Rest');
    assert.equal(await marker(path.join(u.sysroot, '@snapshots/7/snapshot')), 'sieben', 'Quelle unverändert');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'snapshots'));
    const st = await fs.stat(u.sysroot); assert.equal(st.mode & 0o777, 0o700, 'privater Mountpunkt');

    // gleiche Sekunde noch einmal → Restname rückt eine Sekunde weiter; Reste jetzt 2 → nichts gelöscht
    u.aufrufe.length = 0;
    const s2 = await u.auf('snapshots.system.standard', { id: '3' }, K.chef);
    assert.equal(s2.alt, '@_alt_2026-09-25T12-00-01'); assert.deepEqual(s2.geloeschte_reste, []);
    assert.ok(!u.aufrufe.some((a) => a[1] === 'subvolume' && a[2] === 'delete'));
    // Schnappschuss 3 hat eine fstab ohne subvol=@ und keine grub.cfg → zwei Warnungen, kein Abbruch
    assert.equal(s2.warnungen.length, 2); assert.match(s2.warnungen[0], /subvol=@/); assert.match(s2.warnungen[1], /grub\.cfg/);
    assert.equal(await marker(u.at), 'drei');
  } finally { _test.setzeJetzt(null); }
});

test('system.standard: Fehler in Schritt 4 (Kopie) → mv zurück; Fehler in Schritt 3 und bei snapper → nichts geändert', async () => {
  const u = await umgebung();
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    // Schritt 4 scheitert: die Umbenennung wird zurückgedreht, sysroot wieder ausgehängt
    u.zustand.scheitern = (prog, args) => prog === 'btrfs' && args[1] === 'snapshot';
    await assert.rejects(u.auf('snapshots.system.standard', { id: '7' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'kopie' && /wiederhergestellt/.test(e.message) && e.details.ausgabe === 'Testfehler');
    assert.deepEqual(u.aufrufe.slice(5), [
      ['mv', '-T', u.at, path.join(u.sysroot, ALT_25)],
      ['btrfs', 'subvolume', 'snapshot', SNAP7, u.at],
      ['mv', '-T', path.join(u.sysroot, ALT_25), u.at],
      ['umount', u.sysroot],
    ]);
    assert.equal(await marker(u.at), 'alt'); assert.ok(!(await lesbar(path.join(u.sysroot, ALT_25))));

    // Schritt 3 scheitert (mv): kein Zurückdrehen nötig, kein Schnappschuss
    u.aufrufe.length = 0; u.zustand.scheitern = (prog) => prog === 'mv';
    await assert.rejects(u.auf('snapshots.system.standard', { id: '7' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'umbenennen');
    assert.deepEqual(u.aufrufe.slice(5).map((a) => a[0]), ['mv', 'umount']);
    assert.equal(await marker(u.at), 'alt');

    // snapper scheitert: vor jeder Änderung Schluss
    u.aufrufe.length = 0; u.zustand.scheitern = (prog) => prog === 'snapper';
    await assert.rejects(u.auf('snapshots.system.standard', { id: '7' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'sicherheit');
    assert.deepEqual(u.aufrufe.slice(4).map((a) => a[0]), ['snapper', 'umount']);
    assert.equal(await marker(u.at), 'alt');

    // Gerät nicht ermittelbar → E_SYSTEM, kein mount
    u.aufrufe.length = 0; u.zustand.scheitern = null; u.zustand.geraet = 'tmpfs'; u.zustand.wurzel = '';
    await assert.rejects(u.auf('snapshots.system.standard', { id: '7' }, K.chef), (e) => e.code === 'E_SYSTEM' && /Gerät/.test(e.message));
    assert.ok(!u.aufrufe.some((a) => a[0] === 'mount'));
    // Layout ohne @ → E_SYSTEM, wieder ausgehängt
    u.zustand.geraet = '/dev/sda3'; u.zustand.wurzel = '@';
    await fs.rename(u.at, path.join(u.sysroot, 'root'));
    u.aufrufe.length = 0;
    await assert.rejects(u.auf('snapshots.system.standard', { id: '7' }, K.chef), (e) => e.code === 'E_SYSTEM' && /Layout/.test(e.message));
    assert.deepEqual(u.aufrufe.at(-1), ['umount', u.sysroot]);
  } finally { _test.setzeJetzt(null); }
});

test('system.standard: Reste-Begrenzung (neueste 2 bleiben, rekursiv löschen, Rückfall ohne --recursive), laufende Wurzel bleibt', async () => {
  const u = await umgebung();
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    for (const n of [ALT_20, ALT_21, KAPUTT_22]) await stand(path.join(u.sysroot, n), n);
    await fs.writeFile(path.join(u.sysroot, '@_alt_kein-rest.txt'), 'x'); // falsches Muster → ignoriert
    assert.equal(RESTE_BEHALTEN, 2);
    const s = await u.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.deepEqual(s.geloeschte_reste, [ALT_21, ALT_20], 'älteste zuerst über die Grenze hinaus');
    assert.deepEqual(u.aufrufe.filter((a) => a[2] === 'delete'), [
      ['btrfs', 'subvolume', 'delete', '--recursive', path.join(u.sysroot, ALT_21)],
      ['btrfs', 'subvolume', 'delete', '--recursive', path.join(u.sysroot, ALT_20)],
    ]);
    assert.deepEqual((await fs.readdir(u.sysroot)).filter((n) => REST_NAME.test(n)).sort(), [ALT_25, KAPUTT_22].sort());
    assert.deepEqual(s.warnungen, []);

    // alte btrfs-progs kennen --recursive nicht → zweiter Versuch ohne
    _test.setzeJetzt(() => new Date('2026-09-25T13:00:00.000Z'));
    u.zustand.alteProgs = true; u.aufrufe.length = 0;
    const s2 = await u.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.deepEqual(s2.geloeschte_reste, [KAPUTT_22]);
    assert.deepEqual(u.aufrufe.filter((a) => a[2] === 'delete'), [
      ['btrfs', 'subvolume', 'delete', '--recursive', path.join(u.sysroot, KAPUTT_22)],
      ['btrfs', 'subvolume', 'delete', path.join(u.sysroot, KAPUTT_22)],
    ]);
    u.zustand.alteProgs = false;

    // Löschen scheitert → Warnung, Ergebnis trotzdem erfolgreich (das eigentliche Rückrollen ist fertig)
    _test.setzeJetzt(() => new Date('2026-09-25T14:00:00.000Z'));
    u.zustand.scheitern = (prog, args) => prog === 'btrfs' && args[1] === 'delete';
    const s3 = await u.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.equal(s3.neustart_noetig, true); assert.deepEqual(s3.geloeschte_reste, []);
    assert.equal(s3.warnungen.length, 1); assert.match(s3.warnungen[0], /konnte nicht gelöscht werden/);
    u.zustand.scheitern = null;

    // Läuft das System (ohne Neustart) aus einem Rest, ist dieser die laufende Wurzel: kein snapper, nie löschen
    const u2 = await umgebung();
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    for (const n of [ALT_20, ALT_21, KAPUTT_22]) await stand(path.join(u2.sysroot, n), n);
    u2.zustand.wurzel = ALT_20;
    const r = await u2.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.equal(r.sicherheit, null);
    assert.ok(!u2.aufrufe.some((a) => a[0] === 'snapper'), 'kein snapper-Schnappschuss eines fremden Stands');
    assert.deepEqual(r.geloeschte_reste, [ALT_21]);
    assert.ok(await lesbar(path.join(u2.sysroot, ALT_20)), 'laufende Wurzel bleibt');
    assert.ok(r.warnungen.some((t) => /laufende Wurzel ist „@_alt_2026-09-20T03-00-00“/.test(t)));
    assert.ok(r.warnungen.some((t) => /bleibt stehen/.test(t)));
  } finally { _test.setzeJetzt(null); }
});

test('system.zurueck: Rücktausch @ → @_kaputt_<zeit>, Rest → @; Zurückdrehen bei Fehler; Rest gibt es nicht', async () => {
  const u = await umgebung();
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    await u.auf('snapshots.system.standard', { id: '7' }, K.chef);
    assert.equal(await marker(u.at), 'sieben');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.zurueck', { name: '@' }, K.chef), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.zurueck', { name: '../etc' }, K.chef), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.zurueck', { name: ALT_25 }, K.fabian), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.auf('snapshots.system.zurueck', { name: ALT_20 }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');

    // Nach dem Neustart in den neuen Stand: laufende Wurzel ist @, der Rücktausch macht sie zu @_kaputt_<zeit>
    _test.setzeJetzt(() => new Date('2026-09-25T12:30:00.000Z'));
    u.aufrufe.length = 0;
    const z = await u.auf('snapshots.system.zurueck', { name: ALT_25 }, K.chef);
    const KAPUTT = '@_kaputt_2026-09-25T12-30-00';
    assert.equal(z.alt, ALT_25); assert.equal(z.kaputt, KAPUTT); assert.equal(z.neustart_noetig, true); assert.deepEqual(z.warnungen, []);
    assert.match(z.hinweis, /Neustart/);
    assert.deepEqual(u.aufrufe, [
      ['findmnt', '-n', '-o', 'SOURCE', '/'],
      ['findmnt', '-n', '-o', 'SOURCE', u.sysroot],
      ['mount', '-t', 'btrfs', '-o', 'subvolid=5', '/dev/sda3', u.sysroot],
      ['mv', '-T', u.at, path.join(u.sysroot, KAPUTT)],
      ['mv', '-T', path.join(u.sysroot, ALT_25), u.at],
      ['umount', u.sysroot],
    ]);
    assert.equal(await marker(u.at), 'alt'); assert.equal(await marker(path.join(u.sysroot, KAPUTT)), 'sieben');
    assert.ok(!(await lesbar(path.join(u.sysroot, ALT_25))));

    // Fehler beim zweiten mv → erstes mv zurückgedreht
    _test.setzeJetzt(() => new Date('2026-09-25T12:45:00.000Z'));
    u.aufrufe.length = 0; u.zustand.scheitern = (prog, args) => prog === 'mv' && args[1] === path.join(u.sysroot, KAPUTT);
    await assert.rejects(u.auf('snapshots.system.zurueck', { name: KAPUTT }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'tausch' && /wiederhergestellt/.test(e.message));
    const K45 = '@_kaputt_2026-09-25T12-45-00';
    assert.deepEqual(u.aufrufe.slice(3), [
      ['mv', '-T', u.at, path.join(u.sysroot, K45)],
      ['mv', '-T', path.join(u.sysroot, KAPUTT), u.at],
      ['mv', '-T', path.join(u.sysroot, K45), u.at],
      ['umount', u.sysroot],
    ]);
    assert.equal(await marker(u.at), 'alt'); assert.equal(await marker(path.join(u.sysroot, KAPUTT)), 'sieben');
    u.zustand.scheitern = null;

    // Rückgängig OHNE Neustart: laufende Wurzel ist der Rest selbst → danach heißt sie wieder @, Reste-Grenze schützt sie nicht mehr nötig
    const u2 = await umgebung();
    _test.setzeJetzt(() => new Date('2026-09-25T12:00:00.000Z'));
    await u2.auf('snapshots.system.standard', { id: '7' }, K.chef);
    u2.zustand.wurzel = ALT_25;
    for (const n of [ALT_20, ALT_21]) await stand(path.join(u2.sysroot, n), n);
    _test.setzeJetzt(() => new Date('2026-09-25T12:10:00.000Z'));
    const z2 = await u2.auf('snapshots.system.zurueck', { name: ALT_25 }, K.chef);
    assert.equal(await marker(u2.at), 'alt');
    assert.deepEqual(z2.geloeschte_reste, [ALT_20], 'Reste: @_kaputt_12-10 (neu), @_alt_21 bleiben, @_alt_20 weg');
  } finally { _test.setzeJetzt(null); }
});

test('system.reste / rest_loeschen: Liste mit Zeit und laufender Wurzel, gezieltes Löschen, Sperre, alte Einhängung', async () => {
  const u = await umgebung();
  try {
    for (const n of [ALT_20, KAPUTT_22]) await stand(path.join(u.sysroot, n), n);
    await fs.writeFile(path.join(u.sysroot, ALT_21), 'Datei, kein Ordner');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.reste', {}, K.fabian), (e) => e.code === 'E_RECHTE');
    const r = await u.auf('snapshots.system.reste', {}, K.chef);
    assert.deepEqual(r, { wurzel: '@', behalten: 2, reste: [
      { name: KAPUTT_22, art: 'kaputt', zeit: '2026-09-22T03:00:00.000Z', laufend: false },
      { name: ALT_20, art: 'alt', zeit: '2026-09-20T03:00:00.000Z', laufend: false },
    ] });
    assert.deepEqual(u.aufrufe.map((a) => a[0]), ['findmnt', 'findmnt', 'mount', 'umount']);

    // Rest einer alten Einhängung wird zuerst gelöst
    u.zustand.sysrootBelegt = true; u.aufrufe.length = 0;
    await u.auf('snapshots.system.reste', {}, K.chef);
    assert.deepEqual(u.aufrufe.map((a) => a[0]), ['findmnt', 'findmnt', 'umount', 'mount', 'umount']);
    u.zustand.sysrootBelegt = false;

    // laufende Wurzel ist ein Rest → markiert, nicht löschbar
    u.zustand.wurzel = ALT_20;
    const r2 = await u.auf('snapshots.system.reste', {}, K.chef);
    assert.equal(r2.wurzel, ALT_20); assert.deepEqual(r2.reste.map((x) => [x.name, x.laufend]), [[KAPUTT_22, false], [ALT_20, true]]);
    await assert.rejects(u.auf('snapshots.system.rest_loeschen', { name: ALT_20 }, K.chef), (e) => e.code === 'E_BELEGT');
    assert.ok(await lesbar(path.join(u.sysroot, ALT_20)));
    u.zustand.wurzel = '@';

    assert.throws(() => u.reg.vorbereiten('snapshots.system.rest_loeschen', { name: '@' }, K.chef), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('snapshots.system.rest_loeschen', { name: '@snapshots' }, K.chef), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('snapshots.system.rest_loeschen', { name: '@_alt_2026-01-01T00-00-00' }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    u.aufrufe.length = 0;
    assert.deepEqual(await u.auf('snapshots.system.rest_loeschen', { name: KAPUTT_22 }, K.chef), { name: KAPUTT_22, geloescht: true });
    assert.deepEqual(u.aufrufe.slice(3), [['btrfs', 'subvolume', 'delete', '--recursive', path.join(u.sysroot, KAPUTT_22)], ['umount', u.sysroot]]);
    assert.ok(!(await lesbar(path.join(u.sysroot, KAPUTT_22))));
    assert.ok(await lesbar(u.at) && await lesbar(path.join(u.sysroot, '@snapshots/7/snapshot')));

    // Sperre: zwei Läufe zugleich → der zweite bekommt E_BELEGT, der erste läuft durch
    const erster = u.auf('snapshots.system.reste', {}, K.chef);
    await assert.rejects(u.auf('snapshots.system.reste', {}, K.chef), (e) => e.code === 'E_BELEGT');
    assert.equal((await erster).wurzel, '@');
    assert.equal((await u.auf('snapshots.system.reste', {}, K.chef)).reste.length, 1, 'Sperre wieder frei');
  } finally { _test.setzeJetzt(null); }
});
