// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Speicherort von Freigaben (Zusatzauftrag Z1, 0.21.0 – Betreiber 18.10.2026: „wo sehe ich, wo neue Freigaben
// erstellt wurden (auf welcher Festplatte)“): Gerät und Modell der Datenplatte aus findmnt + lsblk (Ausgabeform vom
// Mini-PC), Zwischenspeicher, kein Modell, Befehl schlägt fehl; Feld `speicherort` in freigaben.liste je Art
// (Datenplatte, verschlüsselt, extern aus laufwerke.json, Verbund aus raid.json) und die Aktion freigaben.speicherort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import { werkzeugeBauen, scheinsystem } from './nutzer_scheinsystem.js';

// `lsblk -J -b -o …` vom Mini-PC (18.10.2026, gekürzt): /data = sda4 (btrfs) auf „Samsung SSD 840“ (SATA),
// extern sdb „SSD 850 EVO 2TB“ (USB), dazu Schleifen- und zram-Geräte, die nie gemeint sind.
function teil(name, platte, extra) {
  return { name, path: `/dev/${name}`, type: 'part', size: 1073741824, fstype: null, label: null, uuid: null, partuuid: null, model: null, serial: null, tran: null, rm: false, ro: false, mountpoint: null, pkname: platte, partn: Number(name.replace(/^\D+/, '')), fsavail: null, fsused: null, ...extra };
}
function lsblkMiniPc({ modellSda = 'Samsung SSD 840' } = {}) {
  return { blockdevices: [
    { name: 'loop0', path: '/dev/loop0', type: 'loop', size: 70049792, fstype: 'squashfs', label: null, uuid: null, partuuid: null, model: null, serial: null, tran: null, rm: false, ro: true, mountpoint: '/snap/core24/1643', pkname: null, partn: null, fsavail: 0, fsused: 70123520 },
    { name: 'sda', path: '/dev/sda', type: 'disk', size: 256060514304, fstype: null, label: null, uuid: null, partuuid: null, model: modellSda, serial: 'S1ATNSAD852055R', tran: 'sata', rm: false, ro: false, mountpoint: null, pkname: null, partn: null, fsavail: null, fsused: null, children: [
      teil('sda1', 'sda', { fstype: 'vfat', label: 'FAHNAS-EFI', uuid: '3FD0-CE06', mountpoint: '/boot/efi' }),
      teil('sda2', 'sda', { size: 8589934592, fstype: 'swap', label: 'FAHNAS-SWAP', mountpoint: '[SWAP]' }),
      teil('sda3', 'sda', { size: 51539607552, fstype: 'btrfs', label: 'FAHNAS-SYSTEM', mountpoint: '/var/log' }),
      teil('sda4', 'sda', { size: 194854780928, fstype: 'btrfs', label: 'FAHNAS-DATEN', uuid: '56735f6e-ea3d-4630-acf6-6619063cd2fa', mountpoint: '/data', fsavail: 100905656320, fsused: 92992299008 }),
    ] },
    { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 2000398934016, fstype: null, label: null, uuid: null, partuuid: null, model: 'SSD 850 EVO 2TB', serial: 'D2B008E11D02', tran: 'usb', rm: false, ro: false, mountpoint: null, pkname: null, partn: null, fsavail: null, fsused: null, children: [
      teil('sdb1', 'sdb', { size: 389751595008, fstype: 'exfat', label: 'Ventoy', uuid: '4E21-0000', mountpoint: '/run/fahnas-ansicht/fabian/ventoy2' }),
      teil('sdb3', 'sdb', { size: 1610610638848, fstype: 'exfat', label: '1500GB', uuid: '1C3C-B7C7', mountpoint: '/run/fahnas-ansicht/fabian/1500gb' }),
    ] },
    { name: 'zram0', path: '/dev/zram0', type: 'disk', size: 16444948480, fstype: 'swap', label: null, uuid: null, partuuid: null, model: null, serial: null, tran: null, rm: false, ro: false, mountpoint: '[SWAP]', pkname: null, partn: null, fsavail: null, fsused: null },
  ] };
}
// `findmnt -rn -o SOURCE -T /data/shares` auf dem Mini-PC: btrfs-Unterlaufwerk mit Pfad in Klammern
const FINDMNT_MINIPC = '/dev/sda4[/@shares]\n';

/** Kleines Schein-System nur für findmnt/lsblk: antworten[programm] = {code, stdout} | {werfen} | (args) => … */
function scheinWerkzeuge(antworten, shares = '/data/shares') {
  const aufrufe = [];
  const system = {
    async ausfuehren(programm, args = [], opt = {}) {
      aufrufe.push([programm, ...args].join(' '));
      const a = antworten[programm];
      const r = typeof a === 'function' ? a(args) : a;
      if (!r) return { code: 0, stdout: '', stderr: '' };
      if (r.werfen) throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { befehl: [programm, ...args].join(' '), ausgabe: r.werfen });
      if (!(opt.erlaubteCodes || [0]).includes(r.code ?? 0)) throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { code: r.code, ausgabe: r.stderr || '' });
      return { code: r.code ?? 0, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
  };
  return { werkzeuge: { system, pfade: { shares } }, aufrufe };
}

const MINIPC = () => ({ findmnt: { stdout: FINDMNT_MINIPC }, lsblk: { stdout: JSON.stringify(lsblkMiniPc()) } });

test('Datenplatte: Gerät aus findmnt, Platte und Modell aus lsblk (Ausgabeform vom Mini-PC)', async () => {
  freigaben._test.speicherortLeeren();
  const { werkzeuge, aufrufe } = scheinWerkzeuge(MINIPC());
  assert.deepEqual(await freigaben.datenplatte(werkzeuge), { geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840' });
  assert.equal(aufrufe[0], 'findmnt -rn -o SOURCE -T /data/shares', 'Gerät des Freigaben-Ordners (-T: auch wenn er kein eigener Einhängepunkt ist)');
  assert.match(aufrufe[1], /^lsblk -J -b -o \S*MODEL/, 'dieselbe lsblk-Auswertung wie bei den Laufwerken');
  assert.equal(aufrufe.length, 2);
});

test('Datenplatte: zwischengespeichert – weitere Listen starten keine Prozesse, nach Ablauf wird neu ermittelt', async () => {
  freigaben._test.speicherortLeeren();
  const { werkzeuge, aufrufe } = scheinWerkzeuge(MINIPC());
  // gleichzeitige Anfragen bei leerem Zwischenspeicher: trotzdem nur ein Lauf
  const [a, b, c] = await Promise.all([freigaben.datenplatte(werkzeuge), freigaben.datenplatte(werkzeuge), freigaben.datenplatte(werkzeuge)]);
  assert.deepEqual([a.modell, b.modell, c.modell], ['Samsung SSD 840', 'Samsung SSD 840', 'Samsung SSD 840']);
  assert.equal(aufrufe.length, 2, 'findmnt + lsblk genau einmal');
  a.modell = 'verändert';
  assert.equal((await freigaben.datenplatte(werkzeuge)).modell, 'Samsung SSD 840', 'Aufrufer bekommen Kopien');
  assert.equal(aufrufe.length, 2);
  assert.ok(freigaben.SPEICHERORT_FRISCH_MS >= 60_000, 'mindestens eine Minute gültig');
  freigaben._test.speicherortVeralten();
  await freigaben.datenplatte(werkzeuge);
  assert.equal(aufrufe.length, 4, 'nach Ablauf frisch ermittelt');
  // anderer Freigaben-Ordner (Tests, Umgebung) → eigener Lauf
  const anders = scheinWerkzeuge(MINIPC(), '/srv/shares');
  await freigaben.datenplatte(anders.werkzeuge);
  assert.equal(anders.aufrufe[0], 'findmnt -rn -o SOURCE -T /srv/shares');
});

test('Datenplatte: lsblk kennt kein Modell → modell null (Oberfläche zeigt „Datenplatte“ ohne Klammer)', async () => {
  for (const modellSda of [null, '   ']) {
    freigaben._test.speicherortLeeren();
    const { werkzeuge } = scheinWerkzeuge({ findmnt: { stdout: FINDMNT_MINIPC }, lsblk: { stdout: JSON.stringify(lsblkMiniPc({ modellSda })) } });
    assert.deepEqual(await freigaben.datenplatte(werkzeuge), { geraet: '/dev/sda4', platte: '/dev/sda', modell: null }, String(modellSda));
  }
  // Gerät, das lsblk nicht als Partition/Platte führt (z. B. LVM) → Gerät ja, Modell unbekannt
  freigaben._test.speicherortLeeren();
  const { werkzeuge } = scheinWerkzeuge({ findmnt: { stdout: '/dev/mapper/vg-daten\n' }, lsblk: { stdout: JSON.stringify(lsblkMiniPc()) } });
  assert.deepEqual(await freigaben.datenplatte(werkzeuge), { geraet: '/dev/mapper/vg-daten', platte: null, modell: null });
});

test('Datenplatte: Befehl schlägt fehl → nie ein Fehler, nur unbekannte Werte (und kein lsblk ohne Gerät)', async () => {
  const LEER = { geraet: null, platte: null, modell: null };
  const faelle = [
    ['findmnt findet nichts (Code 1)', { findmnt: { code: 1, stdout: '' } }, LEER, 1],
    ['findmnt fehlt/scheitert', { findmnt: { werfen: 'findmnt: not found' } }, LEER, 1],
    ['findmnt liefert kein Blockgerät (tmpfs)', { findmnt: { stdout: 'tmpfs\n' } }, LEER, 1],
    ['lsblk scheitert', { findmnt: { stdout: FINDMNT_MINIPC }, lsblk: { werfen: 'lsblk kaputt' } }, { geraet: '/dev/sda4', platte: null, modell: null }, 2],
    ['lsblk liefert kein JSON', { findmnt: { stdout: FINDMNT_MINIPC }, lsblk: { stdout: 'kaputt' } }, { geraet: '/dev/sda4', platte: null, modell: null }, 2],
  ];
  for (const [name, antworten, erwartet, anzahl] of faelle) {
    freigaben._test.speicherortLeeren();
    const { werkzeuge, aufrufe } = scheinWerkzeuge(antworten);
    assert.deepEqual(await freigaben.datenplatte(werkzeuge), erwartet, name);
    assert.equal(aufrufe.length, anzahl, `${name}: Aufrufe ${aufrufe.join(' | ')}`);
    // auch der Fehlschlag wird zwischengespeichert – die nächste Liste startet keinen Prozess
    await freigaben.datenplatte(werkzeuge);
    assert.equal(aufrufe.length, anzahl, `${name}: zwischengespeichert`);
  }
});

// ---- über die Aktionen (Schein-System des Freigaben-Tests) ------------------------------------------------------------

/** Schein-System des Freigaben-Tests plus findmnt (-T → Datenplatte, sonst „nicht eingehängt“) und lsblk. */
function freigabenSchein(antworten = MINIPC()) {
  const s = scheinsystem();
  const basis = s.ausfuehren;
  s.antworten = antworten;
  s.gruppen.set('fahnas-nutzer', 990); s.gruppen.set('fahnas-admin', 991); // für setfacl beim Anlegen
  s.ausfuehren = async (programm, args = [], opt = {}) => {
    let r = null;
    if (programm === 'findmnt') r = args.includes('-T') ? s.antworten.findmnt : { code: 1, stdout: '' };
    else if (programm === 'lsblk') r = s.antworten.lsblk;
    if (!r) return basis(programm, args, opt);
    s.befehle.push({ programm, args: [...args] });
    if (r.werfen) throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { ausgabe: r.werfen });
    if (!(opt.erlaubteCodes || [0]).includes(r.code ?? 0)) throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { code: r.code });
    return { code: r.code ?? 0, stdout: r.stdout || '', stderr: '' };
  };
  return s;
}

async function mitFreigaben(antworten) {
  freigaben._test.speicherortLeeren();
  const scheins = freigabenSchein(antworten);
  const u = await werkzeugeBauen({ scheins, module: [freigaben] });
  const p = (n) => path.join(u.pfade.shares, n);
  for (const n of ['medien', 'tresor', '1500gb', 'pool', 'usb']) await fs.mkdir(p(n), { recursive: true });
  await u.konfig.speichern('shares.json', { freigaben: [
    { name: 'medien', beschreibung: 'Filme', pfad: p('medien'), lesen: ['anna'], schreiben: ['chef'], papierkorb: true },
    { name: 'tresor', pfad: p('tresor'), lesen: [], schreiben: ['chef'], verschluesselt: true },
    { name: '1500gb', beschreibung: 'Externes Laufwerk (1500GB)', pfad: p('1500gb'), lesen: [], schreiben: ['chef'], extern: true },
    { name: 'pool', beschreibung: 'Speicherverbund RAID1', pfad: p('pool'), lesen: [], schreiben: ['chef'], verbund: true },
    { name: 'usb', pfad: p('usb'), lesen: [], schreiben: ['chef'], extern: true },
  ] });
  await u.konfig.speichern('laufwerke.json', { geraete: [
    { kennung: 'uuid:1C3C-B7C7', name: '1500gb', fs: 'exfat', label: '1500GB', modell: 'SSD 850 EVO 2TB', groesse: 1610610638848, automatisch: true, freigabe: true },
  ] });
  await u.konfig.speichern('raid.json', { version: 1, verbuende: [
    { name: 'pool', stufe: 'raid1', platten: [{ name: 'sdc', pfad: '/dev/sdc', groesse: 4e12, modell: 'WDC WD40EFRX', seriennummer: 'A' }, { name: 'sdd', pfad: '/dev/sdd', groesse: 4e12, modell: 'WDC WD40EFRX', seriennummer: 'B' }] },
  ] });
  scheins.leeren();
  return u;
}

const datenplatteZeilen = (u) => u.scheins.zeilen().filter((z) => z.startsWith('findmnt -rn -o SOURCE -T') || z.startsWith('lsblk'));

test('freigaben.liste: jede Freigabe trägt ihren Speicherort – Datenplatte, verschlüsselt, extern (laufwerke.json), Verbund (raid.json)', async () => {
  const u = await mitFreigaben();
  try {
    const liste = await u.admin('freigaben.liste', {});
    const ort = Object.fromEntries(liste.map((f) => [f.name, f.speicherort]));
    assert.deepEqual(ort.medien, { art: 'datenplatte', geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840' });
    assert.deepEqual(ort.tresor, { art: 'verschluesselt', geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840' }, 'verschlüsselte Daten liegen auf der Datenplatte');
    assert.deepEqual(ort['1500gb'], { art: 'extern', geraet: null, platte: null, modell: 'SSD 850 EVO 2TB', label: '1500GB' }, 'wie in der Laufwerke-Ansicht: Bezeichnung + Modell');
    assert.deepEqual(ort.usb, { art: 'extern', geraet: null, platte: null, modell: null, label: null }, 'ohne Eintrag in laufwerke.json: nur „externes Laufwerk“');
    assert.deepEqual(ort.pool, { art: 'verbund', geraet: '/dev/md/fahnas-pool', platte: null, modell: null, stufe: 'raid1', platten: [{ name: 'sdc', modell: 'WDC WD40EFRX' }, { name: 'sdd', modell: 'WDC WD40EFRX' }] });
    // fünf Freigaben, aber findmnt + lsblk für die Datenplatte nur einmal; extern/Verbund ganz ohne Prozess
    assert.deepEqual(datenplatteZeilen(u).map((z) => z.split(' ')[0]), ['findmnt', 'lsblk']);
    u.scheins.leeren();
    await u.admin('freigaben.liste', {});
    const nurAnna = await u.als('anna')('freigaben.liste', {});
    assert.deepEqual(nurAnna.map((f) => [f.name, f.speicherort.modell]), [['medien', 'Samsung SSD 840']], 'auch Nutzer sehen den Speicherort ihrer Freigaben');
    assert.deepEqual(datenplatteZeilen(u), [], 'weitere Listen: aus dem Zwischenspeicher');
  } finally { await u.aufraeumen(); }
});

test('freigaben.liste: Speicherort nicht ermittelbar (findmnt/lsblk scheitern, Konfiguration fehlt) → Liste kommt trotzdem, Werte null', async () => {
  const u = await mitFreigaben({ findmnt: { werfen: 'findmnt fehlt' }, lsblk: { werfen: 'lsblk fehlt' } });
  try {
    await fs.unlink(path.join(u.pfade.konfig, 'raid.json'));
    await fs.writeFile(path.join(u.pfade.konfig, 'laufwerke.json'), '{kaputt');
    const liste = await u.admin('freigaben.liste', {});
    assert.equal(liste.length, 5);
    const ort = Object.fromEntries(liste.map((f) => [f.name, f.speicherort]));
    assert.deepEqual(ort.medien, { art: 'datenplatte', geraet: null, platte: null, modell: null });
    assert.deepEqual(ort.tresor, { art: 'verschluesselt', geraet: null, platte: null, modell: null });
    assert.deepEqual(ort['1500gb'], { art: 'extern', geraet: null, platte: null, modell: null, label: null }, 'beschädigte laufwerke.json → kein Listenfehler');
    assert.deepEqual(ort.pool, { art: 'verbund', geraet: null, platte: null, modell: null, stufe: null, platten: [] });
  } finally { await u.aufraeumen(); }
});

test('freigaben.speicherort (admin): wo neue Freigaben entstehen – Datenplatte unter dem Freigaben-Ordner; nutzer darf nicht', async () => {
  const u = await mitFreigaben();
  try {
    assert.deepEqual(await u.admin('freigaben.speicherort', {}), { art: 'datenplatte', geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840', pfad: u.pfade.shares });
    await assert.rejects(u.als('anna')('freigaben.speicherort', {}), (e) => e.code === 'E_RECHTE');
    // derselbe Zwischenspeicher wie die Liste
    u.scheins.leeren();
    await u.admin('freigaben.liste', {});
    await u.admin('freigaben.speicherort', {});
    assert.deepEqual(datenplatteZeilen(u), []);
  } finally { await u.aufraeumen(); }
});

test('freigaben.anlegen: das Ergebnis nennt den Speicherort der neuen Freigabe', async () => {
  const u = await mitFreigaben();
  try {
    const f = await u.admin('freigaben.anlegen', { name: 'neu', schreiben: [] });
    assert.deepEqual(f.speicherort, { art: 'datenplatte', geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840' });
    assert.equal(f.pfad, path.join(u.pfade.shares, 'neu'));
  } finally { await u.aufraeumen(); }
});
