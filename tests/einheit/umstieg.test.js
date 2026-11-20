// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Umstieg von UGOS (0.24.0): Erkennung fremder Volumes (RAID → LVM → btrfs/ext4), Namensvorschläge, UGOS-Rechte (ugacl),
// Besitzer-Zuordnung über den Namen, Formular → Auftrag; Gehäuse: LED-Protokoll (Prüfsumme), LED-Soll, Lüfterkurve und ein
// nachgebauter IT8613E (Super-I/O + Umgebungs-Controller) samt Takt, BIOS-Rückgabe und Stillstand-Alarm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as er from '../../src/agent/import/erkennen.js';
import * as u from '../../src/agent/hardware/ugreen.js';
import * as hw from '../../src/agent/aktionen/hardware.js';
import { auftragBauen } from '../../public/ansichten/import-karte.js';

const GIB = 1024 ** 3;
const teil = (name, kinder = [], extra = {}) => ({ name, path: `/dev/${name}`, type: 'part', size: 900 * GIB, fstype: 'linux_raid_member', children: kinder, ...extra });
const platte = (name, kinder, extra = {}) => ({ name, path: `/dev/${name}`, type: 'disk', size: 1000 * GIB, model: 'HUH721010ALN600', serial: `S-${name}`, tran: 'sata', children: kinder, ...extra });
const lvm = (name, fs, uuid, mountpoint = null) => ({ name, path: `/dev/mapper/${name}`, type: 'lvm', size: 900 * GIB, fstype: fs, uuid, mountpoint });
const md = (name, kinder, type = 'raid1') => ({ name, path: `/dev/${name}`, type, size: 900 * GIB, fstype: 'LVM2_member', children: kinder });

function ugosLsblk() {
  const v1 = lvm('ug_2A0B29_1738415346_pool1-volume1', 'ext4', 'b537b01d-0000-4736-bfe7-000000000001');
  const v2 = lvm('ug_2A0B29_1738415369_pool2-volume1', 'btrfs', 'da694a20-0000-4794-ab74-000000000002');
  return { blockdevices: [
    platte('sda', [teil('sda1', [], { fstype: null }), teil('sda2', [md('md1', [v1])])]),
    platte('sdb', [teil('sdb1', [], { fstype: null }), teil('sdb2', [md('md1', [v1])])]),
    platte('sdc', [teil('sdc2', [md('md2', [v2])])]), platte('sdd', [teil('sdd2', [md('md2', [v2])])]),
    platte('nvme2n1', [{ name: 'nvme2n1p2', path: '/dev/nvme2n1p2', type: 'part', fstype: 'btrfs', label: 'FAHNAS-SYSTEM', uuid: 'sys', mountpoint: '/' },
      { name: 'nvme2n1p4', path: '/dev/nvme2n1p4', type: 'part', fstype: 'btrfs', label: 'FAHNAS-DATEN', uuid: 'daten', mountpoint: '/data' }], { tran: 'nvme' }),
    platte('sde', [{ name: 'sde1', path: '/dev/sde1', type: 'part', fstype: 'ext4', uuid: 'usb-ext4' }], { tran: 'usb' }),
  ] };
}

test('Erkennung: UGOS-Stapel RAID1 → LVM → ext4/btrfs, je Volume einmal mit beiden Platten; System und USB bleiben draußen', () => {
  const v = er.volumesAusLsblk(ugosLsblk());
  assert.equal(v.length, 2);
  const [a, b] = v;
  assert.equal(a.fstype, 'ext4'); assert.equal(a.art, 'lvm'); assert.deepEqual(a.lvm, { vg: 'ug_2A0B29_1738415346_pool1', lv: 'volume1' });
  assert.equal(a.raid.stufe, 'raid1'); assert.deepEqual(a.platten.map((p) => p.geraet), ['/dev/sda', '/dev/sdb']);
  assert.equal(b.fstype, 'btrfs'); assert.equal(b.importiert, false);
  // eigener Verbund wird ausgeschlossen, schon übernommenes Volume ist markiert, anderswo eingehängtes bleibt draußen
  assert.equal(er.volumesAusLsblk(ugosLsblk(), { ausschliessen: new Set([a.uuid]) }).length, 1);
  const json = ugosLsblk(); json.blockdevices[2].children[0].children[0].children[0].mountpoint = '/data/import/da694a200000';
  assert.equal(er.volumesAusLsblk(json).find((x) => x.fstype === 'btrfs').importiert, true);
  json.blockdevices[2].children[0].children[0].children[0].mountpoint = '/mnt/irgendwo';
  assert.equal(er.volumesAusLsblk(json).length, 1);
  assert.deepEqual(er.lvmName('vg--a-lv--b'), { vg: 'vg-a', lv: 'lv-b' });
});

test('Ordner, Herkunft und Freigabenamen', () => {
  assert.equal(er.ordnerArt('Arbeit'), 'freigabe'); assert.equal(er.ordnerArt('@home'), 'heim'); assert.equal(er.ordnerArt('@appstore'), 'intern');
  assert.equal(er.ordnerArt('lost+found'), 'intern'); assert.equal(er.ordnerArt('#recycle'), 'intern');
  assert.equal(er.herkunftVon({ vg: 'ug_2A0B29_1738415346_pool1' }), 'UGOS'); assert.equal(er.herkunftVon({ ordner: ['@eaDir', 'homes'] }), 'Synology'); assert.equal(er.herkunftVon({}), null);
  const belegt = new Set(['private']);
  assert.equal(er.freigabenameVorschlag('Arbeit', belegt), 'arbeit');
  assert.equal(er.freigabenameVorschlag('docker', belegt), 'docker-alt');
  assert.equal(er.freigabenameVorschlag('Strandhotel Löchnerhaus', belegt), 'strandhotel-lochnerhaus');
  assert.equal(er.freigabenameVorschlag('Größe & Maß', belegt), 'grosse-mass');
  belegt.add('sabnzbd');
  assert.equal(er.freigabenameVorschlag('sabNZBd', belegt), 'sabnzbd-2');
  assert.match(er.freigabenameVorschlag('@@@'), /^[a-z0-9]/);
});

/** UGOS-ACL wie unter UGOS (system.ugacl_self): Version 1, Einträge [art, maske, vererbung, id, 0]. */
function ugacl(eintraege) {
  const b = Buffer.alloc(4 + 20 * eintraege.length);
  b.writeUInt32LE(1, 0);
  eintraege.forEach(([art, maske, id], i) => { const o = 4 + 20 * i; b.writeUInt32LE(art, o); b.writeUInt32LE(maske, o + 4); b.writeUInt32LE(6, o + 8); b.writeUInt32LE(id >>> 0, o + 12); });
  return b.toString('base64');
}
const EXPORT = {
  nutzer: [{ name: 'fabian', uid: 1000 }, { name: 'uwe', uid: 1001 }, { name: 'lisa', uid: 1002 }, { name: 'alex', uid: 1003 }],
  gruppen: [{ name: 'admin', gid: 10, mitglieder: ['fabian'] }, { name: 'familie', gid: 1010, mitglieder: ['lisa', 'alex'] }],
};
const FAHNAS = { nutzer: [{ name: 'fabian', rolle: 'admin', uid: 1001 }, { name: 'uwe', rolle: 'nutzer', uid: 1002 }, { name: 'lisa', rolle: 'nutzer', uid: 1003 }, { name: 'gast', rolle: 'nutzer', uid: 1004 }], gruppen: [] };

test('UGOS-Rechte: lesen/schreiben je Nutzer über den Namen, Admins und Admin-Gruppe entfallen, „Jeder“, fehlende Konten', () => {
  const b64 = ugacl([[5, 0x37cf, 1001], [6, 0x1c5, 1002], [6, 0x37cf, 1000], [10, 0x37cf, 10], [6, 0x37cf, 1005], [5, 0x37cf, 1003]]);
  const l = er.ugaclLesen(b64);
  assert.deepEqual(l.eintraege.map((e) => [e.art, e.recht]), [['nutzer', 'schreiben'], ['nutzer', 'lesen'], ['nutzer', 'schreiben'], ['gruppe', 'schreiben'], ['nutzer', 'schreiben'], ['nutzer', 'schreiben']]);
  const r = er.rechteVorschlag(b64, EXPORT, FAHNAS);
  assert.deepEqual(r.schreiben, ['uwe']); assert.deepEqual(r.lesen, ['lisa']);
  assert.ok(r.hinweise.some((h) => /uid 1005/.test(h)), 'gelöschtes Konto ohne Namen wird gemeldet');
  assert.ok(r.hinweise.some((h) => /„alex“ gibt es auf FAH-NAS noch nicht/.test(h)));
  // „Jeder“ → alle FAH-NAS-Nutzer (ohne Admins); Gruppe ohne FAH-NAS-Gegenstück → ihre Mitglieder
  const jeder = er.rechteVorschlag(ugacl([[34, 0x37cf, 0xffffffff]]), EXPORT, FAHNAS);
  assert.deepEqual(jeder.schreiben, ['gast', 'lisa', 'uwe']);
  const gruppe = er.rechteVorschlag(ugacl([[10, 0x1c5, 1010]]), EXPORT, FAHNAS);
  assert.deepEqual(gruppe.lesen, ['lisa']);
  assert.deepEqual(er.rechteVorschlag(ugacl([[10, 0x1c5, 1010]]), EXPORT, { ...FAHNAS, gruppen: [{ name: 'familie' }] }).lesen, ['@familie']);
  // ohne UGOS-Rechte: nur Admins
  assert.deepEqual(er.rechteVorschlag(null, EXPORT, FAHNAS), { lesen: [], schreiben: [], hinweise: ['keine UGOS-Rechte gefunden – nur Admins'] });
  assert.equal(er.ugaclLesen('kaputt'), null);
});

test('Besitzer: alte uid → FAH-NAS-Konto gleichen NAMENS (andere uid egal), sonst root; Formular → Auftrag', () => {
  const b = er.besitzerVorschlag([0, 1000, 1001, 1003, 1000], [{ name: 'fabian', uid: 1000 }, { name: 'uwe', uid: 1001 }, { name: 'alex', uid: 1003 }], FAHNAS.nutzer);
  assert.deepEqual(b, [{ uid: 1000, alt_name: 'fabian', vorschlag: 'fabian' }, { uid: 1001, alt_name: 'uwe', vorschlag: 'uwe' }, { uid: 1003, alt_name: 'alex', vorschlag: 'root' }]);
  const formular = [{ uuid: 'u1', ordner: [
    { ordner: 'Arbeit', name: 'arbeit', gewaehlt: true, lesen: new Set(['lisa']), schreiben: new Set(['uwe']) },
    { ordner: '@home', name: 'home-alt', gewaehlt: false, lesen: new Set(), schreiben: new Set() },
  ] }];
  const { params, fehler } = auftragBauen(formular, { 1000: 'fabian' }, new Set(['private']));
  assert.deepEqual(fehler, []);
  assert.deepEqual(params, { volumes: [{ uuid: 'u1', ordner: [{ ordner: 'Arbeit', name: 'arbeit', lesen: ['lisa'], schreiben: ['uwe'], papierkorb: true }] }], besitzer: { 1000: 'fabian' } });
  formular[0].ordner[1].gewaehlt = true; formular[0].ordner[1].name = 'arbeit';
  assert.equal(auftragBauen(formular, {}, new Set()).fehler[0].grund, 'doppelt');
  formular[0].ordner[1].name = 'Docker';
  assert.equal(auftragBauen(formular, {}, new Set()).fehler[0].grund, 'ungueltig');
  formular[0].ordner[1].name = 'docker';
  assert.equal(auftragBauen(formular, {}, new Set()).fehler[0].grund, 'belegt');
});

// ---------------------------------------------------------------------------------------------------------------
// Gehäuse
// ---------------------------------------------------------------------------------------------------------------
test('LED-Protokoll: 12 Bytes mit Prüfsumme wie das Original, Status lesen, Soll aus dem Gerätezustand', () => {
  // power an: Summe 0xa0+0x01+0x03+0x01 = 0xa5, erstes Byte danach = LED-Nummer
  assert.deepEqual(u.ledBefehl(0, 3, [1]), [0x00, 0xa0, 0x01, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0xa5]);
  assert.deepEqual(u.ledBefehl(2, 2, [255, 0, 0]), [0x02, 0xa0, 0x01, 0x00, 0x00, 0x02, 0xff, 0x00, 0x00, 0x00, 0x01, 0xa2]);
  const blink = u.ledBefehle(1, { an: true, farbe: [255, 255, 255], helligkeit: 64, blinken: [100, 100] });
  assert.equal(blink.length, 3); assert.deepEqual(blink[2].slice(5, 10), [4, 0x00, 0xc8, 0x00, 0x64]);
  assert.deepEqual(u.ledBefehle(3, { an: false }), [u.ledBefehl(3, 3, [0])]);
  const status = [1, 63, 255, 255, 255, 0x09, 0x60, 0x07, 0xd0]; const s = status.reduce((a, x) => a + x, 0);
  assert.deepEqual(u.ledStatusLesen([...status, s >> 8, s & 0xff]), { modus: 'an', helligkeit: 63, farbe: [255, 255, 255], an_ms: 2000, aus_ms: 400 });
  assert.equal(u.ledStatusLesen([...status, 0, 0]), null);
  assert.deepEqual(u.i2cAusgabeLesen('0x01 0x3f 0xff\n'), [1, 63, 255]);
  const soll = u.ledSoll({ netz: { verbunden: true, verkehr: true }, platten: [{ vorhanden: true, aktiv: true }, null, { vorhanden: true, fehler: true }] }, { an: true, helligkeit: 50, aktivitaet: true });
  assert.equal(soll.betrieb.an, true); assert.deepEqual(soll.netz.blinken, [100, 100]);
  assert.deepEqual(soll.platte1.blinken, [60, 60]); assert.equal(soll.platte2.an, false); assert.deepEqual(soll.platte3.farbe, [255, 0, 0]);
  assert.equal(u.ledSoll({ platten: [{ vorhanden: true }] }, { an: false }).platte1.an, false);
  assert.equal(u.ledNummer('platte4'), 5); assert.equal(u.modellVon('DXP4800 Plus').name, 'UGREEN DXP4800 Plus'); assert.equal(u.modellVon('Default string'), null);
});

test('Lüfterkurve: Minimum, Platten/NVMe/CPU, unlesbare CPU → 100 %, langsam herunter', () => {
  assert.equal(u.zielTastgrad({ cpu: 40, platten: [30] }, 'leise'), u.MIN_TASTGRAD);
  assert.equal(u.zielTastgrad({ cpu: 40, platten: [50] }, 'leise'), 255);
  assert.ok(u.zielTastgrad({ cpu: 40, platten: [43] }, 'normal') > u.zielTastgrad({ cpu: 40, platten: [43] }, 'leise'));
  assert.equal(u.zielTastgrad({ cpu: null, platten: [30] }, 'leise'), 255);
  assert.equal(u.zielTastgrad({ cpu: 40, platten: [], nvme: [80] }, 'leise'), 255);
  assert.equal(u.zielTastgrad({ cpu: 40, platten: [30] }, 'normal', 200), 190, 'höchstens 10 je Takt nach unten');
});

/** Nachgebauter IT8613E: Super-I/O an 0x2e (Eintrittsfolge 87 01 55 55, LDN 4 = EC, Basis 0x0a30), EC-Register. */
function chip({ rpm = { 2: 1500 }, basis = 0x0a30 } = {}) {
  const ec = new Uint8Array(256);
  ec[0x0c] = 0x00; // Zähler noch 8 Bit – der Treiber schaltet auf 16 Bit
  for (const [i, ctrl] of [[0, 0x80], [1, 0x80], [2, 0x80], [3, 0x80], [4, 0x80]]) ec[u.REG.pwmCtrl[i]] = ctrl | 0x01;
  for (let i = 0; i < 5; i++) { ec[u.REG.pwmDuty[i]] = 0x99; ec[u.REG.fanLo[i]] = 0xff; ec[u.REG.fanHi[i]] = 0xff; }
  const setzeRpm = (i, r) => { const z = r ? Math.round(1_350_000 / (2 * r)) : 0xffff; ec[u.REG.fanLo[i]] = z & 0xff; ec[u.REG.fanHi[i]] = z >> 8; };
  for (const [i, r] of Object.entries(rpm)) setzeRpm(Number(i), r);
  let folge = []; let konfig = false; let index = 0; let ldn = 0; let adresse = 0;
  const ldnRegs = { 4: { 0x30: 1, 0x60: basis >> 8, 0x61: basis & 0xff } };
  return {
    ec, setzeRpm, konfig: () => konfig,
    outb(port, v) {
      if (port === 0x2e) {
        if (!konfig) { folge = [...folge, v].slice(-4); if (folge.join() === [0x87, 0x01, 0x55, 0x55].join()) konfig = true; return; }
        index = v; return;
      }
      if (port === 0x2f && konfig) { if (index === 0x07) ldn = v; else if (index === 0x02 && v === 0x02) { konfig = false; folge = []; } return; }
      if (port === basis + 5) { adresse = v; return; }
      if (port === basis + 6) { ec[adresse] = v; }
    },
    inb(port) {
      if (port === 0x2f && konfig) { if (index === 0x20) return 0x86; if (index === 0x21) return 0x13; return ldnRegs[ldn]?.[index] ?? 0; }
      if (port === basis + 6) return ec[adresse];
      return 0xff;
    },
    schliessen() {},
  };
}

test('IT8613E: finden, Drehzahl 16 Bit, Handbetrieb mit Tastgrad, BIOS-Zustand zurück', () => {
  const c = chip({ rpm: { 2: 1500 } });
  const f = u.superIoFinden(c);
  assert.deepEqual(f, { sio: 0x2e, chip: 0x8613, basis: 0x0a30 });
  assert.equal(c.konfig(), false, 'Konfigurationsmodus wieder verlassen');
  const e = u.ec(c, f.basis);
  u.sechzehnBit(e); assert.equal(c.ec[0x0c] & 0x07, 0x07);
  assert.equal(u.drehzahl(e, 2), 1500); assert.equal(u.drehzahl(e, 0), 0);
  const alt = u.pwmLesen(e, 2);
  u.pwmSetzen(e, 2, 120);
  assert.equal(c.ec[0x17] & 0x80, 0, 'Handbetrieb'); assert.equal(c.ec[0x17] & 0x7f, 0x01, 'Temperaturzuordnung bleibt'); assert.equal(c.ec[0x73], 120);
  u.pwmZurueck(e, 2, alt);
  assert.equal(c.ec[0x17], alt.ctrl); assert.equal(c.ec[0x73], alt.duty);
  assert.equal(u.superIoFinden({ outb() {}, inb: () => 0xff }), null, 'kein Chip → null');
});

test('Gehäuse-Bereich: Erkennung über DMI, Lüftertakt nach Temperatur, Stillstand → 100 % + Meldung, LEDs nur bei Wechsel, Stopp gibt ans BIOS zurück', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-gehaeuse-'));
  try {
    const q = hw._test.quellen;
    Object.assign(q, { dmi: path.join(w, 'dmi'), hwmon: path.join(w, 'hwmon'), sysBlock: path.join(w, 'block'), sysNet: path.join(w, 'net'), i2c: path.join(w, 'i2c'), route: path.join(w, 'route'), lockdown: path.join(w, 'lockdown') });
    q.bios = () => path.join(w, 'run', 'luefter-bios.json');
    await fs.writeFile(q.dmi, 'DXP4800 Plus\n');
    await fs.writeFile(q.lockdown, '[none] integrity confidentiality\n');
    for (const [n, name, t] of [['hwmon0', 'coretemp', 45000], ['hwmon1', 'drivetemp', 36000], ['hwmon2', 'nvme', 48000]]) {
      await fs.mkdir(path.join(q.hwmon, n), { recursive: true });
      await fs.writeFile(path.join(q.hwmon, n, 'name'), `${name}\n`); await fs.writeFile(path.join(q.hwmon, n, 'temp1_input'), `${t}\n`);
    }
    await fs.mkdir(path.join(q.i2c, 'i2c-0', 'device'), { recursive: true }); await fs.writeFile(path.join(q.i2c, 'i2c-0', 'device', 'name'), 'SMBus I801 adapter at 0000:00:1f.4\n');
    // Platte sdb im Schacht 1 (ata1), Netz eth0 mit Standardroute
    await fs.mkdir(path.join(w, 'devices', 'ata1', 'host0', 'block', 'sdb'), { recursive: true });
    await fs.mkdir(q.sysBlock, { recursive: true });
    await fs.symlink(path.join(w, 'devices', 'ata1', 'host0', 'block', 'sdb'), path.join(q.sysBlock, 'sdb'));
    await fs.writeFile(path.join(w, 'devices', 'ata1', 'host0', 'block', 'sdb', 'stat'), '1 0 100 0 1 0 200 0 0 0 0\n');
    await fs.mkdir(path.join(q.sysNet, 'eth0', 'statistics'), { recursive: true });
    await fs.writeFile(path.join(q.sysNet, 'eth0', 'carrier'), '1\n');
    for (const d of ['rx_bytes', 'tx_bytes']) await fs.writeFile(path.join(q.sysNet, 'eth0', 'statistics', d), '1000\n');
    await fs.writeFile(q.route, 'Iface\tDestination\tGateway\neth0\t00000000\t0100000A\n');
    const status = [1, 63, 255, 255, 255, 0x09, 0x60, 0x07, 0xd0]; const s = status.reduce((a, x) => a + x, 0);
    const befehle = []; const meldungen = [];
    const werkzeuge = {
      konfig: { laden: async () => null, aendern: async () => {} },
      system: { async ausfuehren(prog, args) {
        befehle.push([prog, ...args]);
        if (prog === 'dpkg-query') return { code: 0, stdout: 'install ok installed', stderr: '' };
        if (prog === 'i2cget') return { code: 0, stdout: [...status, s >> 8, s & 0xff].map((x) => `0x${x.toString(16)}`).join(' '), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      } },
      intern: async (a, p) => { meldungen.push([a, p]); return {}; },
    };
    const c = chip({ rpm: { 2: 1400 } });
    await hw.starten(werkzeuge, { ioFabrik: () => c });
    await hw._test.z.ledsBereit;
    const st = hw._test.status();
    assert.equal(st.modell, 'UGREEN DXP4800 Plus');
    assert.equal(st.luefter.verfuegbar, true); assert.deepEqual(st.luefter.kanaele.map((k) => k.nr), [3]);
    assert.equal(c.ec[0x73], u.MODI.normal.cpu[0][1], 'kühl → unterster Wert der Kurve (Modus Normal)'); assert.equal(c.ec[0x17] & 0x80, 0);
    assert.ok(JSON.parse(await fs.readFile(q.bios(), 'utf8')).kanaele[2], 'BIOS-Zustand gesichert');
    assert.equal(st.leds.verfuegbar, true);
    // heiße Platte → mehr Tastgrad
    await fs.writeFile(path.join(q.hwmon, 'hwmon1', 'temp1_input'), '47000\n');
    await hw.luefterTakt(werkzeuge);
    assert.ok(c.ec[0x73] > 150);
    // Lüfter steht (3 Takte) → 100 % + Meldung
    c.setzeRpm(2, 0);
    for (let i = 0; i < 3; i++) await hw.luefterTakt(werkzeuge);
    assert.equal(c.ec[0x73], 255);
    assert.ok(meldungen.some(([a, p]) => a === 'benachrichtigungen.senden' && /steht/.test(p.titel)));
    // LEDs: erster Takt sendet alles, zweiter ohne Änderung nichts, Zugriff → Schacht-LED blinkt
    befehle.length = 0;
    await hw.ledTakt(werkzeuge, 1_000);
    const ersterTakt = befehle.filter((b) => b[0] === 'i2cset').length;
    assert.ok(ersterTakt >= 6, `${ersterTakt} Befehle`);
    befehle.length = 0;
    await hw.ledTakt(werkzeuge, 1_100);
    assert.equal(befehle.filter((b) => b[0] === 'i2cset').length, 0, 'ohne Wechsel kein Befehl');
    await fs.writeFile(path.join(w, 'devices', 'ata1', 'host0', 'block', 'sdb', 'stat'), '1 0 900 0 1 0 200 0 0 0 0\n');
    await hw.ledTakt(werkzeuge, 1_200);
    const blink = befehle.filter((b) => b[0] === 'i2cset' && b[4] === '0x02' && b[10] === '0x04');
    assert.equal(blink.length, 1, 'Schacht 1 (LED 2) blinkt bei Zugriff');
    // Stopp: BIOS-Zustand zurück
    hw.stoppen();
    assert.equal(c.ec[0x17] & 0x80, 0x80, 'Automatik des BIOS wieder an');
    assert.equal(c.ec[0x73], 0x99);
  } finally { hw.stoppen(); await fs.rm(w, { recursive: true, force: true }); }
});
