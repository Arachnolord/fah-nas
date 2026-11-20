// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Umstieg-Ausbau (0.25.0): Unterordner-Rechte aus UGOS → Ordnerrechte, alter Pfad /volumeN, RAID übernommener Volumes
// (Zustand aus /sys, Ersatzplan, fremde Platten), Docker-Übernahme (alte Ablage lesen, Projekte, Volumes, Zusatzdatei)
// und Speicherorte (Docker/Apps/VMs auf übernommenem Volume).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as er from '../../src/agent/import/erkennen.js';
import * as raid from '../../src/agent/import/raid.js';
import * as ue from '../../src/agent/apps/uebernahme.js';
import * as so from '../../src/agent/import/speicherorte.js';

function ugacl(eintraege) {
  const b = Buffer.alloc(4 + 20 * eintraege.length);
  b.writeUInt32LE(1, 0);
  eintraege.forEach(([art, maske, id], i) => { const o = 4 + 20 * i; b.writeUInt32LE(art, o); b.writeUInt32LE(maske, o + 4); b.writeUInt32LE(6, o + 8); b.writeUInt32LE(id >>> 0, o + 12); });
  return b.toString('base64');
}
const RW = 0x37cf; const RO = 0x1c5;
const EXPORT = {
  nutzer: [{ name: 'fabian', uid: 1000 }, { name: 'conny', uid: 1006 }, { name: 'media', uid: 1007 }, { name: 'uwe', uid: 1001 }],
  gruppen: [{ name: 'admin', gid: 10, mitglieder: ['fabian'] }, { name: 'team', gid: 1010, mitglieder: ['conny', 'media'] }],
};
const FAHNAS = {
  nutzer: [{ name: 'fabian', rolle: 'admin', uid: 1000 }, { name: 'conny', rolle: 'nutzer', uid: 1001, gruppen: ['team'] }, { name: 'media', rolle: 'nutzer', uid: 1002, gruppen: ['team'] }, { name: 'uwe', rolle: 'nutzer', uid: 1003 }],
  gruppen: [{ name: 'team' }],
};
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-ausbau-'));

test('Unterordner-Rechte: vollständige UGOS-Liste → nur Einschränkungen als Ordnerrechte, mehr Rechte → Hinweis', () => {
  const freigabe = { lesen: [], schreiben: ['conny', 'media'] };
  const unter = [
    { pfad: 'UgreenNAS', ugacl: ugacl([[10, RW, 10]]) },                         // nur Admins → conny und media: keiner
    { pfad: 'NPM', ugacl: ugacl([[5, RW, 1006], [6, RO, 1007]]) },               // media nur lesen
    { pfad: 'Fremd', ugacl: ugacl([[5, RW, 1006], [5, RW, 1007], [5, RW, 1001]]) }, // uwe hätte mehr als in der Freigabe
  ];
  const r = er.ordnerrechteVorschlag(freigabe, unter, EXPORT, FAHNAS);
  assert.deepEqual(r.regeln, [
    { pfad: 'UgreenNAS', regeln: { conny: 'keiner', media: 'keiner' } },
    { pfad: 'NPM', regeln: { media: 'lesen' } },
  ]);
  assert.ok(r.hinweise.some((h) => /Fremd: „uwe“ hätte hier mehr Rechte/.test(h)));
  // Gruppe in der Freigabe, im Unterordner nur ein Mitglied persönlich → Gruppenregel + Hinweis auf das Mitglied
  const g = er.ordnerrechteVorschlag({ lesen: [], schreiben: ['@team'] }, [{ pfad: 'Chef', ugacl: ugacl([[5, RW, 1006]]) }], EXPORT, FAHNAS);
  assert.deepEqual(g.regeln, [{ pfad: 'Chef', regeln: { '@team': 'keiner' } }]);
  assert.ok(g.hinweise.some((h) => /Regel für @team trifft auch „conny“/.test(h)));
  assert.deepEqual(er.ordnerrechteVorschlag(freigabe, [], EXPORT, FAHNAS), { regeln: [], hinweise: [] });
});

test('Alter Pfad: aus dem Export, sonst aus dem UGOS-Namen pool<N>', () => {
  assert.equal(er.alterPfadVorschlag({ vg: 'ug_2A0B29_1738538044_pool3', lv: 'volume1' }), '/volume3');
  assert.equal(er.alterPfadVorschlag({ vg: 'ug_2A0B29_1738538044_pool3', lv: 'volume1' }, '/volume7'), '/volume7');
  assert.equal(er.alterPfadVorschlag({ vg: 'vg1000', lv: 'lv' }), null);
  assert.equal(er.alterPfadVorschlag({}, '/etc'), null);
});

test('RAID übernommener Volumes: Zustand aus /sys, Mitglieder, Ersatzplan, fremde Platten', async () => {
  assert.deepEqual(raid.mitgliedZerlegen('/dev/sda2'), { platte: '/dev/sda', nr: 2 });
  assert.deepEqual(raid.mitgliedZerlegen('/dev/nvme1n1p2'), { platte: '/dev/nvme1n1', nr: 2 });
  assert.deepEqual(raid.mitgliedZerlegen('/dev/sdb'), { platte: '/dev/sdb', nr: null });
  assert.equal(raid.partitionPfad('/dev/sdc', 2), '/dev/sdc2'); assert.equal(raid.partitionPfad('/dev/nvme2n1', 2), '/dev/nvme2n1p2');
  const sys = await tmp();
  try {
    const md = path.join(sys, 'md1', 'md');
    const schreib = async (d, t) => { await fs.mkdir(path.dirname(path.join(md, d)), { recursive: true }); await fs.writeFile(path.join(md, d), `${t}\n`); };
    await schreib('level', 'raid1'); await schreib('raid_disks', '2'); await schreib('degraded', '1'); await schreib('sync_action', 'idle'); await schreib('sync_completed', 'none');
    await schreib('dev-sda2/state', 'in_sync'); await schreib('dev-sdb2/state', 'faulty');
    const d = await raid.raidDetails('/dev/md1', sys);
    assert.deepEqual(d, { md: '/dev/md1', stufe: 'raid1', platten_soll: 2, degraded: true, sync: 'idle', fortschritt: null, mitglieder: [{ geraet: '/dev/sda2', zustand: 'ok' }, { geraet: '/dev/sdb2', zustand: 'defekt' }] });
    assert.equal(await raid.raidDetails('/dev/md9', sys), null);
    // defekte Platte tauschen; die gesunde gibt die Aufteilung vor
    assert.deepEqual(raid.ersatzPlan(d, { alt: '/dev/sdb2' }), { modus: 'tauschen', quelle: { platte: '/dev/sda', nr: 2 }, alt: '/dev/sdb2', platten_neu: 2 });
    assert.throws(() => raid.ersatzPlan(d, { alt: '/dev/sda2' }), /funktioniert/);
    assert.throws(() => raid.ersatzPlan(d, { alt: '/dev/sdx2' }), /gehört nicht/);
    // Platte schon gezogen → hinzufügen; vollständiges RAID 1 mit einer Platte → Spiegel
    assert.equal(raid.ersatzPlan({ ...d, mitglieder: [d.mitglieder[0]] }).modus, 'hinzufuegen');
    const basis = { md: '/dev/md3', stufe: 'raid1', platten_soll: 1, degraded: false, sync: 'idle', mitglieder: [{ geraet: '/dev/nvme1n1p2', zustand: 'ok' }] };
    assert.deepEqual(raid.ersatzPlan(basis), { modus: 'spiegel', quelle: { platte: '/dev/nvme1n1', nr: 2 }, alt: null, platten_neu: 2 });
    assert.throws(() => raid.ersatzPlan({ ...basis, sync: 'recover' }), /arbeitet gerade/);
    assert.throws(() => raid.ersatzPlan({ ...basis, stufe: 'raid0' }), /keine Ausfallsicherheit/);
    assert.throws(() => raid.ersatzPlan({ ...basis, stufe: 'raid5', platten_soll: 3 }), /vollständig/);
    assert.throws(() => raid.ersatzPlan({ ...d, mitglieder: [{ geraet: '/dev/sdb2', zustand: 'defekt' }] }, { alt: '/dev/sdb2' }), /Keine gesunde Platte/);
  } finally { await fs.rm(sys, { recursive: true, force: true }); }
  const json = { blockdevices: [
    { name: 'sdc', children: [{ name: 'sdc1', fstype: 'ntfs' }] },
    { name: 'sdd', children: [{ name: 'sdd2', fstype: 'linux_raid_member' }] },
    { name: 'sde', children: [{ name: 'sde1', fstype: 'LVM2_member' }] },
  ] };
  assert.equal(raid.fremdeSpuren(json, 'sdc'), null);
  assert.equal(raid.fremdeSpuren(json, 'sdd'), 'sdd2: linux_raid_member');
  assert.equal(raid.fremdeSpuren(json, 'sde'), 'sde1: LVM2_member');
});

/** Docker-Ablage wie unter UGOS: containers/<id>/config.v2.json + hostconfig.json, volumes/<name>/_data. */
async function ablageBauen(wurzel) {
  const ablage = path.join(wurzel, '@docker');
  const id = (n) => n.toString(16).padStart(64, '0');
  const anonym = 'a'.repeat(64);
  const c = async (n, cfg, host) => {
    const d = path.join(ablage, 'containers', id(n));
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'config.v2.json'), JSON.stringify(cfg));
    await fs.writeFile(path.join(d, 'hostconfig.json'), JSON.stringify(host));
  };
  const labels = (projekt, dienst) => ({ 'com.docker.compose.project': projekt, 'com.docker.compose.service': dienst, 'com.docker.compose.project.working_dir': `/volume3/docker/${projekt}`, 'com.docker.compose.project.config_files': `/volume3/docker/${projekt}/docker-compose.yml` });
  await c(1, { ID: id(1), Name: '/unifi-db', State: { Running: false }, HasBeenManuallyStopped: false,
    Config: { Image: 'mongo:7', Labels: labels('unifi', 'unifi-db'), Env: ['PUID=1000', 'PGID=10', 'TZ=Europe/Berlin'] },
    MountPoints: { '/data/db': { Type: 'bind', Source: '/volume3/docker/unifi/db', Destination: '/data/db' }, '/data/configdb': { Type: 'volume', Name: anonym, Destination: '/data/configdb', Driver: 'local' } } },
  { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'unifi_default' });
  await c(2, { ID: id(2), Name: '/ausleuchter-db', State: { Running: true }, Config: { Image: 'postgres:16', Labels: labels('fah-ausleuchter', 'db'), Env: [] },
    MountPoints: { '/var/lib/postgresql/data': { Type: 'volume', Name: 'fah-ausleuchter_datenbank', Destination: '/var/lib/postgresql/data', Driver: 'local' }, '/plaene': { Type: 'bind', Source: '/volume1/medien/plaene', Destination: '/plaene' } } },
  { RestartPolicy: { Name: 'no' }, NetworkMode: 'host', Devices: [{ PathOnHost: '/dev/dri' }] });
  await c(3, { ID: id(3), Name: '/einzeln', State: { Running: true }, Config: { Image: 'alpine', Labels: {} }, MountPoints: {} }, {});
  await fs.mkdir(path.join(ablage, 'containers', 'kaputt'), { recursive: true });
  await fs.mkdir(path.join(ablage, 'volumes', anonym, '_data'), { recursive: true });
  await fs.mkdir(path.join(ablage, 'volumes', 'fah-ausleuchter_datenbank', '_data'), { recursive: true });
  return { ablage, anonym };
}

test('Docker-Übernahme: alte Ablage lesen, Projekte bündeln, Volumes und alte Pfade erkennen', async () => {
  const w = await tmp();
  try {
    assert.equal(await ue.ablageFinden(w), null);
    const { ablage, anonym } = await ablageBauen(w);
    assert.equal(await ue.ablageFinden(w), ablage);
    const container = await ue.containerLesen(ablage);
    assert.equal(container.length, 3);
    const { projekte, einzeln } = ue.projekteBilden(container);
    assert.deepEqual(einzeln.map((e) => e.name), ['einzeln']);
    assert.deepEqual(projekte.map((p) => p.projekt), ['fah-ausleuchter', 'unifi']);
    const [aus, uni] = projekte;
    assert.deepEqual(uni.volumes, [{ name: anonym, anonym: true, treiber: 'local', dienste: [{ dienst: 'unifi-db', ziel: '/data/configdb' }] }]);
    assert.equal(uni.autostart, true, 'unless-stopped und nicht von Hand gestoppt'); assert.equal(uni.laeuft, false);
    assert.deepEqual(uni.alte_pfade, ['/volume3']); assert.deepEqual(uni.konten, { 'unifi-db.PUID': '1000', 'unifi-db.PGID': '10' });
    assert.deepEqual(aus.alte_pfade, ['/volume1', '/volume3']); assert.equal(aus.autostart, false); assert.equal(aus.laeuft, true);
    assert.ok(aus.warnungen.some((x) => /Host-Netz/.test(x))); assert.ok(aus.warnungen.some((x) => /\/dev\/dri/.test(x)));
    // Namen, Labels, Zusatzdatei
    assert.equal(ue.neuerVolumeName('unifi', uni.volumes[0]), `unifi_fahnas_${'a'.repeat(12)}`);
    assert.equal(ue.neuerVolumeName('x', { name: 'fah-chr-cache', anonym: false }), 'fah-chr-cache');
    assert.deepEqual(ue.volumeLabels('fah-ausleuchter', 'fah-ausleuchter_datenbank'), { 'com.docker.compose.project': 'fah-ausleuchter', 'com.docker.compose.volume': 'datenbank' });
    assert.deepEqual(ue.volumeLabels('x', 'fah-chr-cache'), {});
    const yaml = ue.uebernahmeYaml([{ dienst: 'unifi-db', ziel: '/data/configdb', name: 'unifi_fahnas_aaaaaaaaaaaa' }]);
    assert.equal(yaml, [
      '# Von FAH-NAS bei der Docker-Übernahme angelegt: frühere anonyme Volumes mit ihren übernommenen Daten.',
      'services:', '  "unifi-db":', '    volumes:', '      - type: volume', '        source: "unifi_fahnas_aaaaaaaaaaaa"', '        target: "/data/configdb"',
      'volumes:', '  "unifi_fahnas_aaaaaaaaaaaa":', '    external: true', ''].join('\n'));
    assert.equal(ue.uebernahmeYaml([]), null);
    assert.equal(ue.uebernahmeYaml([{ dienst: 'x', ziel: '/a', name: 'böse name' }]), null, 'ungültige Volume-Namen fallen weg');
    assert.deepEqual(ue.kontenHinweise(uni.konten, { 1000: 1001 }), ['unifi-db.PUID=1000: diese Dateien gehören auf FAH-NAS jetzt uid 1001 – ggf. in der Compose-Datei anpassen']);
    assert.deepEqual(ue.kontenHinweise(uni.konten, { 1000: 1000 }), []);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Speicherorte: Pfade, Normierung, Drop-in, Bereitstellen hängt Volume und Bind ein (nur wo nötig)', async () => {
  const P = { daten: '/data', importe: '/data/import', apps: '/data/apps', vms: '/data/vms' };
  assert.equal(so.zielPfad(P, 'docker'), '/var/lib/docker'); assert.equal(so.systemOrt(P, 'docker'), '/data/@docker');
  assert.equal(so.volumeOrt(P, 'b537b01d-17c4-4736-bfe7-b5abed09fd0d', 'apps'), path.join('/data/import', er.kurzVon('b537b01d-17c4-4736-bfe7-b5abed09fd0d'), '@fahnas', 'apps'));
  assert.deepEqual(so.normieren({ docker: { volume: 'b537b01d-17c4', seit: 'x' }, apps: { volume: '../böse' }, vms: null }), { docker: { volume: 'b537b01d-17c4', seit: 'x' }, apps: null, vms: null });
  assert.match(so.dropinText(), /Requires=fahnas-speicherorte\.service\nAfter=fahnas-speicherorte\.service/);
  const w = await tmp();
  try {
    const uuid = 'da694a20-c3a7-4794-ab74-de1bfce5fbd3';
    const pf = { daten: w, importe: path.join(w, 'import'), apps: path.join(w, 'apps'), vms: path.join(w, 'vms'), docker: path.join(w, 'docker') };
    await fs.mkdir(so.volumeOrt(pf, uuid, 'apps'), { recursive: true });
    const befehle = [];
    const system = { ausfuehren: async (prog, args) => { befehle.push([prog, ...args]); if (prog === 'findmnt') return { code: 0, stdout: `${so.volumePfad(pf, uuid)}\n`, stderr: '' }; return { code: 0, stdout: '', stderr: '' }; } };
    const leer = await so.bereitstellen({ system, pfade: pf, orte: so.normieren({}), volumes: [] });
    assert.deepEqual(leer, { fehler: [], gebunden: [] }); assert.equal(befehle.length, 0, 'ohne Einstellung nichts tun');
    const r = await so.bereitstellen({ system, pfade: pf, orte: so.normieren({ apps: { volume: uuid }, vms: { volume: '11111111-2222' } }), volumes: [{ uuid }] });
    assert.deepEqual(r.gebunden, ['apps']);
    assert.ok(r.fehler.some((f) => /vms: Volume 11111111-2222 ist nicht \(mehr\) übernommen/.test(f)));
    assert.deepEqual(befehle.find((b) => b[0] === 'mount'), ['mount', '--bind', so.volumeOrt(pf, uuid, 'apps'), pf.apps]);
    assert.equal(await so.zeigtAuf(pf.apps, so.volumeOrt(pf, uuid, 'apps')), false);
    assert.equal(await so.zeigtAuf(so.volumeOrt(pf, uuid, 'apps'), so.volumeOrt(pf, uuid, 'apps')), true);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Oberfläche: Auftrag mit altem Pfad, App-Daten, Ordnerrechten, persönlichen Ordnern; Docker-Auftrag', async () => {
  const { auftragBauen, ordnerrechteKurz } = await import('../../public/ansichten/import-karte.js');
  const { sperrgrund, uebernahmeAuftrag } = await import('../../public/ansichten/apps-uebernahme.js');
  const OR = [{ pfad: 'UgreenNAS', regeln: { anna: 'keiner' } }];
  const formular = [{ uuid: 'u1', alter_pfad: '/volume3', alterPfadAn: true, heime: [{ ordner: '@home/anna', nutzer: 'anna', gewaehlt: true }, { ordner: '@home/lisa', nutzer: '', gewaehlt: true }], ordner: [
    { ordner: 'docker', name: 'docker-alt', gewaehlt: true, lesen: new Set(), schreiben: new Set(), rechte_lassen: true, ordnerrechte: OR, ordnerrechteAn: true },
    { ordner: 'Backups', name: 'backups', gewaehlt: true, lesen: new Set(), schreiben: new Set(['anna']), rechte_lassen: false, ordnerrechte: OR, ordnerrechteAn: true },
    { ordner: 'Medien', name: 'medien', gewaehlt: true, lesen: new Set(), schreiben: new Set(), rechte_lassen: false, ordnerrechte: OR, ordnerrechteAn: false },
  ] }, { uuid: 'u2', alter_pfad: '/volume4', alterPfadAn: false, heime: [], ordner: [] }];
  const { params, fehler } = auftragBauen(formular, {}, new Set());
  assert.deepEqual(fehler, []);
  assert.deepEqual(params.volumes, [{ uuid: 'u1', alter_pfad: '/volume3', heime: [{ ordner: '@home/anna', nutzer: 'anna' }], ordner: [
    { ordner: 'docker', name: 'docker-alt', lesen: [], schreiben: [], papierkorb: false, rechte_lassen: true },
    { ordner: 'Backups', name: 'backups', lesen: [], schreiben: ['anna'], papierkorb: true, ordnerrechte: OR },
    { ordner: 'Medien', name: 'medien', lesen: [], schreiben: [], papierkorb: true },
  ] }], 'Volume ohne Auswahl fällt weg, abgewählte Ordnerrechte auch');
  formular[0].heime[1].nutzer = 'anna';
  assert.equal(auftragBauen(formular, {}, new Set()).fehler[0].grund, 'heim_doppelt');
  formular[0].heime[1].gewaehlt = false; formular[0].alter_pfad = '/etc';
  assert.equal(auftragBauen(formular, {}, new Set()).fehler[0].grund, 'alter_pfad');
  const t = (k) => ({ 'laufwerke.import_or_keiner': 'kein Zugriff', 'laufwerke.import_or_lesen': 'nur lesen' })[k] || k;
  assert.equal(ordnerrechteKurz([{ pfad: 'A', regeln: { anna: 'keiner', '@team': 'lesen' } }, { pfad: 'B', regeln: { bert: 'lesen' } }], t), 'A: anna kein Zugriff, @team nur lesen · B: bert nur lesen');
  // Docker-Übernahme
  assert.equal(sperrgrund({ dateien: ['/volume3/x/c.yml'], fehlende_pfade: [], dateien_da: true }), null);
  assert.equal(sperrgrund({ dateien: ['/volume3/x/c.yml'], fehlende_pfade: ['/volume1'], dateien_da: true }), 'ue_pfad_fehlt');
  assert.equal(sperrgrund({ dateien: [], fehlende_pfade: [] }), 'ue_keine_compose');
  assert.equal(sperrgrund({ schon_uebernommen: 'x', dateien: ['a'] }), 'ue_schon');
  const z = [{ projekt: 'unifi', name: 'unifi', gewaehlt: true, autostart: true, leer: new Set(['v1']) }, { projekt: 'plex', name: 'plex', gewaehlt: false, autostart: true, leer: new Set() }];
  assert.deepEqual(uebernahmeAuftrag(z, new Set()), { projekte: [{ projekt: 'unifi', name: 'unifi', autostart: true, leer: ['v1'] }], fehler: [] });
  assert.equal(uebernahmeAuftrag(z, new Set(['unifi'])).fehler[0].grund, 'ue_name_belegt');
  z[0].name = 'Unifi Neu';
  assert.equal(uebernahmeAuftrag(z, new Set()).fehler[0].grund, 'ue_name_ungueltig');
});

test('Erkennung: Volume mit mehreren Einhängepunkten (alter Pfad + /data/import) bleibt „übernommen“', () => {
  const lv = (mp, mps) => ({ blockdevices: [{ name: 'sda', path: '/dev/sda', type: 'disk', size: 1e12, tran: 'sata', children: [{ name: 'sda2', type: 'part', fstype: 'linux_raid_member', children: [
    { name: 'md1', path: '/dev/md1', type: 'raid1', fstype: 'LVM2_member', children: [{ name: 'ug_X_1_pool1-volume1', path: '/dev/mapper/ug_X_1_pool1-volume1', type: 'lvm', fstype: 'btrfs', uuid: 'u-1', size: 1e12, mountpoint: mp, mountpoints: mps }] }] }] }] });
  assert.equal(er.volumesAusLsblk(lv('/volume1', ['/volume1', '/data/import/u1', '/data/shares/arbeit']))[0]?.importiert, true);
  assert.equal(er.volumesAusLsblk(lv('/mnt/x', ['/mnt/x'])).length, 0, 'nur anderswo eingehängt → nicht anfassen');
  assert.equal(er.volumesAusLsblk(lv(null, [null]))[0]?.importiert, false);
});

test('Volume-Namen: alter Pfad statt des UGOS-Einheitsnamens „volume1“, dazu das Plattenmodell', () => {
  const v = { herkunft: 'UGOS', lvm: { vg: 'ug_2A0B29_1738538044_pool3', lv: 'volume1' }, geraet: '/dev/mapper/x', platten: [{ modell: null }, { modell: 'Samsung SSD 980 1TB' }] };
  assert.equal(er.volumeName(v, '/volume3'), 'UGOS volume3 · Samsung SSD 980 1TB');
  assert.equal(er.volumeName(v, er.alterPfadVorschlag(v.lvm)), 'UGOS volume3 · Samsung SSD 980 1TB');
  assert.equal(er.volumeName({ ...v, platten: [] }, null), 'UGOS volume1');
  assert.equal(er.volumeName({ geraet: '/dev/sdb1' }), 'sdb1');
});

test('Watchdog: Treiber-Watchdog aus /sys lesen; Skript schaltet einen IT8613E-Watchdog ohne Treiber aus', async () => {
  const hw = await import('../../src/agent/aktionen/hardware.js');
  const w = await tmp();
  try {
    await fs.mkdir(path.join(w, 'watchdog0')); await fs.mkdir(path.join(w, 'watchdog1'));
    await fs.writeFile(path.join(w, 'watchdog0', 'identity'), 'iTCO_wdt\n');
    assert.equal(await hw.watchdogLesen(w), null);
    for (const [d, t] of [['identity', 'IT87 WDT'], ['state', 'active'], ['timeout', '178']]) await fs.writeFile(path.join(w, 'watchdog1', d), `${t}\n`);
    assert.deepEqual(await hw.watchdogLesen(w), { geraet: 'watchdog1', zustand: 'active', sekunden: 178 });
    assert.match(hw.WATCHDOG_CONF, /RuntimeWatchdogSec=3min/);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
  // Python-Skript gegen einen nachgebauten Super-I/O (Index/Daten 0x2e/0x2f, LDN 7, Watchdog 178 s an)
  const { execFileSync } = await import('node:child_process');
  const prog = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('wd', 'tools/watchdog_halten.py'); wd = importlib.util.module_from_spec(spec); spec.loader.exec_module(wd)
class Chip:
    def __init__(s): s.idx = 0; s.ldn = 0; s.reg = {0x20: 0x86, 0x21: 0x13}; s.wdt = {0x72: 0x80, 0x73: 178, 0x74: 0}; s.cfg = False; s.schluessel = []
    def outb(s, p, v):
        if p in (0x2e, 0x4e) and not s.cfg:
            s.schluessel = (s.schluessel + [v])[-4:]
            if p == 0x2e and s.schluessel == [0x87, 0x01, 0x55, 0x55]: s.cfg = True
            return
        if p == 0x2e: s.idx = v; return
        if p == 0x2f:
            if s.idx == 0x07: s.ldn = v
            elif s.idx == 0x02 and v & 0x02: s.cfg = False
            elif s.ldn == 7 and s.idx in s.wdt: s.wdt[s.idx] = v
    def inb(s, p):
        if not s.cfg: return 0xff
        if s.idx in s.reg: return s.reg[s.idx]
        return s.wdt.get(s.idx, 0) if s.ldn == 7 else 0
c = Chip(); erst = wd.chip_watchdog(c, ausschalten=False); dann = wd.chip_watchdog(c, ausschalten=True); zuletzt = wd.chip_watchdog(c, ausschalten=False)
print(json.dumps([erst, dann, zuletzt, c.cfg]))
`;
  const aus = JSON.parse(execFileSync('python3', ['-c', prog], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  assert.deepEqual(aus, [[true, 178, false], [true, 178, true], [false, 0, false], false], 'erkannt (178 s), ausgeschaltet, danach aus; Konfigurationsmodus verlassen');
});
