// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/aktionen/freigaben.js: Schema, Anlegen (btrfs, 2770, ACL, Papierkorb, Samba, Avahi),
// Kontingent, Sichtbarkeit je Rolle, Verbindungshinweis, Ändern, Löschen (behalten/löschen), Fehlerfall, apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';

const MODULE = [nutzer, freigaben];
const PW = 'sehr-geheim-123';

async function grundlage() {
  const u = await werkzeugeBauen({ module: MODULE });
  await u.system('nutzer.anlegen', { name: 'chef', passwort: PW, rolle: 'admin' });
  await u.admin('nutzer.gruppe.anlegen', { name: 'familie' });
  await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['familie'] });
  await u.admin('nutzer.anlegen', { name: 'bert', passwort: PW, rolle: 'nutzer' });
  u.scheins.leeren(); u.ereignisse.length = 0;
  return u;
}

test('freigaben: Schema und Prüfungen lehnen ab, ohne das System anzufassen', async () => {
  const u = await grundlage();
  try {
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'Medien' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'name');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'global' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'alle' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', beschreibung: 'x\n[global]' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'beschreibung');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', beschreibung: 'mit "Zitat"' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', lesen: ['../x'] }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', lesen: ['niemand'] }), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.feld === 'lesen');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', schreiben: ['@keine'] }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', groesse_gb: -1 }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien', fremd: 1 }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.als('anna')('freigaben.anlegen', { name: 'medien' }), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.als('anna')('freigaben.apply', {}), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.admin('freigaben.aendern', { name: 'gibtsnicht', gaeste: true }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await assert.rejects(u.admin('freigaben.loeschen', { name: 'medien', daten: 'vielleicht' }), (e) => e.code === 'E_PARAMS');
    assert.deepEqual(u.scheins.zeilen(), []);
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben, []);
  } finally { await u.aufraeumen(); }
});

test('freigaben: anlegen – Unterlaufwerk, 2770 root:fahnas-nutzer, ACLs, Papierkorb, Samba-Include, Avahi', async () => {
  const u = await grundlage();
  try {
    freigaben._test.belegungLeeren();
    const e = await u.admin('freigaben.anlegen', { name: 'medien', beschreibung: 'Filme', lesen: ['anna', '@familie'], schreiben: ['chef', 'anna'], gaeste: false });
    const pfad = path.join(u.pfade.shares, 'medien');
    assert.equal(e.name, 'medien'); assert.equal(e.pfad, pfad); assert.equal(e.papierkorb, true);
    // Belegung ohne Kontingent: die Liste wartet nicht auf du (R1 Fund 9) – erst null, der Hintergrundlauf füllt den Zwischenspeicher
    assert.equal(e.belegt, null);
    assert.deepEqual(e.lesen, ['anna', '@familie']); assert.deepEqual(e.schreiben, ['chef', 'anna']); assert.equal(e.schnappschuesse, 0);
    const z = u.scheins.zeilen();
    const erwartet = [
      `btrfs subvolume create ${pfad}`,
      `getfacl -p ${pfad}`,
      `chown root:fahnas-nutzer ${pfad}`,
      `chmod 2770 ${pfad}`,
      `setfacl --set-file=- ${pfad}`,
      `chown root:fahnas-nutzer ${path.join(pfad, '.papierkorb')}`,
      `chmod 0770 ${path.join(pfad, '.papierkorb')}`,
      `btrfs qgroup show -r -f --raw ${pfad}`,
    ];
    assert.deepEqual(z.slice(0, erwartet.length), erwartet);
    assert.ok(z.some((x) => x.startsWith('testparm -s --suppress-prompt')) && z.includes('smbcontrol all reload-config'));
    assert.ok(!z.some((x) => x.startsWith('btrfs quota')), 'ohne Kontingent keine Quoten');
    assert.ok(!z.some((x) => x.startsWith('du ')), 'du läuft nie synchron in der Liste');
    const acl = u.scheins.befehle.find((b) => b.programm === 'setfacl').eingabe.trim().split('\n');
    await freigaben._test.belegungWarten();
    assert.ok(u.scheins.zeilen().includes(`nice -n 19 ionice -c 3 du -s -B1 -- ${pfad}`), 'du nur mit nice/ionice im Hintergrund');
    // zwei Ereignisse: eines vom Anlegen, eines vom Nachladen der Belegung (damit die Oberfläche neu lädt)
    assert.ok(u.ereignisse.filter((x) => x.ereignis === 'konfig' && x.bereich === 'freigaben').length >= 2, 'Ereignis nach dem Nachladen');
    u.scheins.leeren();
    assert.equal((await u.admin('freigaben.liste', {}))[0].belegt, 4096, 'zwischengespeichert');
    assert.ok(!u.scheins.zeilen().some((x) => /\bdu\b/.test(x)), 'frischer Wert → kein neuer du-Lauf');
    freigaben._test.belegungSetzen(pfad, 4096, Date.now() - freigaben.BELEGUNG_FRISCH_MS - 1);
    assert.equal((await u.admin('freigaben.liste', {}))[0].belegt, 4096, 'alter Wert wird sofort geliefert …');
    await freigaben._test.belegungWarten();
    assert.ok(u.scheins.zeilen().some((x) => x.startsWith('nice -n 19 ionice -c 3 du')), '… und im Hintergrund erneuert');
    // du scheitert/Zeitlimit → kein Listenfehler
    u.scheins.fehlschlag = (p) => (p === 'nice' ? { code: -1, stderr: 'timeout' } : null);
    freigaben._test.belegungSetzen(pfad, 4096, 0);
    assert.equal((await u.admin('freigaben.liste', {}))[0].belegt, 4096);
    await freigaben._test.belegungWarten();
    u.scheins.fehlschlag = null;
    // Gruppe fahnas-admin immer rwx: der Dateihelfer läuft mit der uid des Admins (R1 Sammelfund f)
    assert.deepEqual(acl, [
      'user::rwx', 'group::---', 'other::---', 'mask::rwx', 'group:fahnas-admin:rwx',
      'group:familie:r-x', 'user:anna:rwx', 'user:chef:rwx',
      'default:user::rwx', 'default:group::---', 'default:other::---', 'default:mask::rwx', 'default:group:fahnas-admin:rwx',
      'default:group:familie:r-x', 'default:user:anna:rwx', 'default:user:chef:rwx',
    ]);
    assert.ok((await fs.stat(path.join(pfad, '.papierkorb'))).isDirectory());
    const conf = await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8');
    assert.ok(conf.includes(`path = ${pfad}`) && conf.includes('valid users = anna, @familie, chef') && conf.includes('read list = @familie') && conf.includes('recycle:repository'));
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8')).includes('medien.conf'));
    assert.ok((await fs.readFile(path.join(u.pfade.avahi, 'fahnas-timemachine.service'), 'utf8')).includes('_smb._tcp'));
    const gespeichert = (await u.konfig.laden('shares.json')).freigaben[0];
    assert.equal(gespeichert.name, 'medien'); assert.equal(gespeichert.groesse_gb, null); assert.ok(gespeichert.erstellt);
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'konfig' && x.bereich === 'freigaben'));
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'medien' }), (e) => e.code === 'E_EXISTIERT');
    await fs.mkdir(path.join(u.pfade.shares, 'fremd'));
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'fremd' }), (e) => e.code === 'E_EXISTIERT', 'Ordner schon auf der Platte');
    // Gäste → ACL für nobody, guest ok
    u.scheins.leeren();
    const g = await u.admin('freigaben.anlegen', { name: 'tausch', gaeste: true, papierkorb: false });
    assert.equal(g.gaeste, true);
    assert.ok(u.scheins.befehle.find((b) => b.programm === 'setfacl').eingabe.includes('user:nobody:rwx'));
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'tausch.conf'), 'utf8')).includes('guest ok = yes'));
    assert.ok(!(await fs.readdir(path.join(u.pfade.shares, 'tausch'))).includes('.papierkorb'));
  } finally { await u.aufraeumen(); }
});

test('freigaben: Kontingent – Quoten einmalig einschalten, Grenze setzen/aufheben, Belegung aus qgroup; Time Machine', async () => {
  const u = await grundlage();
  try {
    const pfad = path.join(u.pfade.shares, 'tm');
    const e = await u.admin('freigaben.anlegen', { name: 'tm', schreiben: ['chef'], timemachine: true, groesse_gb: 500 });
    assert.equal(e.timemachine, true); assert.equal(e.groesse_gb, 500); assert.equal(e.papierkorb, false, 'Time Machine ohne Papierkorb');
    const z = u.scheins.zeilen();
    const iShow = z.indexOf(`btrfs qgroup show -r -f --raw ${pfad}`);
    assert.ok(iShow >= 0);
    assert.equal(z[iShow + 1], `btrfs quota enable ${u.pfade.daten}`);
    assert.equal(z[iShow + 2], `btrfs qgroup show -r -f --raw ${pfad}`);
    assert.equal(z[iShow + 3], `btrfs qgroup limit ${500 * 1024 ** 3} ${pfad}`);
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'tm.conf'), 'utf8')).includes('fruit:time machine max size = 500G'));
    assert.ok((await fs.readFile(path.join(u.pfade.avahi, 'fahnas-timemachine.service'), 'utf8')).includes('dk0=adVN=tm,adVF=0x82'));
    // Belegung kommt aus qgroup
    u.scheins.qgroups.get(pfad).rfer = 123456789;
    assert.equal((await u.admin('freigaben.liste', {}))[0].belegt, 123456789);
    // zweite Freigabe mit Grenze: Quoten schon an → kein enable mehr
    u.scheins.leeren();
    await u.admin('freigaben.anlegen', { name: 'klein', schreiben: ['chef'], groesse_gb: 2 });
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('btrfs quota enable')));
    assert.ok(u.scheins.zeilen().includes(`btrfs qgroup limit ${2 * 1024 ** 3} ${path.join(u.pfade.shares, 'klein')}`));
    // Grenze unverändert → kein limit; Grenze aufheben → none
    u.scheins.leeren();
    await u.admin('freigaben.aendern', { name: 'klein', groesse_gb: 2 });
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('btrfs qgroup limit')));
    await u.admin('freigaben.aendern', { name: 'klein', groesse_gb: 0 });
    assert.ok(u.scheins.zeilen().includes(`btrfs qgroup limit none ${path.join(u.pfade.shares, 'klein')}`));
    assert.equal((await u.konfig.laden('shares.json')).freigaben.find((f) => f.name === 'klein').groesse_gb, null);
  } finally { await u.aufraeumen(); }
});

test('freigaben: liste je Rolle sichtbar, verbindung mit Hinweisen', async () => {
  const u = await grundlage();
  try {
    await u.admin('freigaben.anlegen', { name: 'medien', lesen: ['@familie'], schreiben: ['chef'] });
    await u.admin('freigaben.anlegen', { name: 'chefsache', schreiben: ['chef'], versteckt: true });
    await u.admin('freigaben.anlegen', { name: 'tausch', gaeste: true });
    await u.admin('freigaben.anlegen', { name: 'bert', lesen: ['bert'] });
    await fs.mkdir(path.join(u.pfade.snapshots, 'medien', '2026-09-25T10-00-00Z'), { recursive: true });
    const alle = await u.admin('freigaben.liste', {});
    assert.deepEqual(alle.map((f) => f.name), ['medien', 'chefsache', 'tausch', 'bert']);
    assert.equal(alle[0].schnappschuesse, 1);
    assert.equal(alle[1].versteckt, true);
    assert.deepEqual((await u.als('anna')('freigaben.liste', {})).map((f) => f.name), ['medien', 'tausch'], 'anna: über Gruppe + Gäste');
    assert.deepEqual((await u.als('bert')('freigaben.liste', {})).map((f) => f.name), ['tausch', 'bert']);
    await u.konfig.aendern('system.json', (s) => { s.hostname = 'box'; });
    const v = await u.als('anna')('freigaben.verbindung', { name: 'medien' });
    // IP statt .local (16.10.2026: geht zu Hause UND über VPN); ohne erkennbare IP bleibt .local
    assert.equal(v.smb_lokal, 'smb://box.local/medien');
    assert.equal(v.smb, v.ip ? `smb://${v.ip}/medien` : 'smb://box.local/medien');
    assert.ok(v.hinweise.mac.includes('⌘K') && v.hinweise.mac.includes(v.smb));
    assert.ok(v.hinweise.windows.includes(`\\\\${v.ip || 'box'}\\medien`));
    assert.ok(v.hinweise.linux.includes('cifs'));
    await assert.rejects(u.als('anna')('freigaben.verbindung', { name: 'chefsache' }), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.admin('freigaben.verbindung', { name: 'nix' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('freigaben: aendern setzt ACL und Samba neu, unveränderte Teile bleiben ohne Befehle', async () => {
  const u = await grundlage();
  try {
    await u.admin('freigaben.anlegen', { name: 'medien', lesen: ['anna'], schreiben: ['chef'], papierkorb: false });
    const pfad = path.join(u.pfade.shares, 'medien');
    u.scheins.leeren();
    const e = await u.admin('freigaben.aendern', { name: 'medien', schreiben: ['chef', 'bert'], beschreibung: 'Neu beschrieben' });
    assert.deepEqual(e.schreiben, ['chef', 'bert']); assert.equal(e.beschreibung, 'Neu beschrieben'); assert.deepEqual(e.lesen, ['anna']);
    const z = u.scheins.zeilen();
    assert.ok(z.includes(`setfacl --set-file=- ${pfad}`));
    assert.ok(u.scheins.befehle.find((b) => b.programm === 'setfacl').eingabe.includes('user:bert:rwx'));
    assert.ok(z.some((x) => x.startsWith('testparm')));
    assert.ok(!z.some((x) => x.startsWith('btrfs subvolume create')));
    const conf = await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8');
    assert.ok(conf.includes('comment = Neu beschrieben') && conf.includes('write list = chef, bert'));
    // nur Beschreibung ändern → ACL unverändert (getfacl reicht), Samba neu
    u.scheins.leeren();
    await u.admin('freigaben.aendern', { name: 'medien', beschreibung: 'Nochmal' });
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('setfacl') || x.startsWith('chown') || x.startsWith('chmod')));
    assert.ok(u.scheins.zeilen().some((x) => x.startsWith('testparm')));
    // Papierkorb an → Ordner + Rechte
    u.scheins.leeren();
    await u.admin('freigaben.aendern', { name: 'medien', papierkorb: true });
    assert.ok(u.scheins.zeilen().includes(`chmod 0770 ${path.join(pfad, '.papierkorb')}`));
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8')).includes('vfs objects = fruit streams_xattr recycle'));
    // Injektion über aendern
    await assert.rejects(u.admin('freigaben.aendern', { name: 'medien', beschreibung: 'a\r\nb' }), (e) => e.code === 'E_PARAMS');
  } finally { await u.aufraeumen(); }
});

test('freigaben: loeschen – behalten verschiebt nach backup/geloescht, loeschen räumt Schnappschüsse und Unterlaufwerk', async () => {
  const u = await grundlage();
  try {
    await u.admin('freigaben.anlegen', { name: 'alt', schreiben: ['chef'] });
    await u.admin('freigaben.anlegen', { name: 'weg', schreiben: ['chef'] });
    const schnapp = path.join(u.pfade.snapshots, 'weg');
    await fs.mkdir(path.join(schnapp, '2026-09-01T00-00-00Z'), { recursive: true });
    await fs.mkdir(path.join(schnapp, '2026-09-02T00-00-00Z'), { recursive: true });
    u.scheins.leeren();
    const r = await u.admin('freigaben.loeschen', { name: 'alt', daten: 'behalten' });
    assert.equal(r.daten, 'behalten');
    assert.match(r.aufbewahrt, new RegExp(`^${path.join(u.pfade.backup, 'geloescht', 'alt-')}\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z$`));
    assert.ok((await fs.stat(r.aufbewahrt)).isDirectory());
    assert.ok(u.scheins.zeilen().includes(`mv ${path.join(u.pfade.shares, 'alt')} ${r.aufbewahrt}`));
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('btrfs subvolume delete')));
    assert.ok(!(await fs.readdir(u.pfade.samba)).includes('alt.conf'));
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben.map((f) => f.name), ['weg']);
    u.scheins.leeren();
    const r2 = await u.admin('freigaben.loeschen', { name: 'weg', daten: 'loeschen' });
    assert.equal(r2.aufbewahrt, null);
    const z = u.scheins.zeilen();
    const loeschungen = z.filter((x) => x.startsWith('btrfs subvolume delete'));
    assert.deepEqual(loeschungen, [
      `btrfs subvolume delete ${path.join(schnapp, '2026-09-01T00-00-00Z')}`,
      `btrfs subvolume delete ${path.join(schnapp, '2026-09-02T00-00-00Z')}`,
      `btrfs subvolume delete ${path.join(u.pfade.shares, 'weg')}`,
    ]);
    await assert.rejects(fs.stat(schnapp));
    await assert.rejects(fs.stat(path.join(u.pfade.shares, 'weg')));
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben, []);
    assert.ok(!(await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8')).includes('weg.conf'));
    await assert.rejects(u.admin('freigaben.loeschen', { name: 'weg', daten: 'loeschen' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('freigaben: testparm lehnt ab → E_RENDER, Konfiguration bleibt unverändert, Unterlaufwerk wieder weg', async () => {
  const u = await grundlage();
  try {
    await u.admin('freigaben.anlegen', { name: 'ok', schreiben: ['chef'] });
    u.scheins.testparmFehler = 'Unknown parameter encountered';
    u.scheins.leeren(); u.ereignisse.length = 0;
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'kaputt', schreiben: ['chef'] }), (e) => e.code === 'E_RENDER' && e.details.ausgabe.includes('Unknown parameter'));
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben.map((f) => f.name), ['ok']);
    assert.ok(u.scheins.zeilen().includes(`btrfs subvolume delete ${path.join(u.pfade.shares, 'kaputt')}`));
    await assert.rejects(fs.stat(path.join(u.pfade.shares, 'kaputt')));
    const dateien = await fs.readdir(u.pfade.samba);
    assert.deepEqual(dateien.sort(), ['alle.conf', 'ok.conf']);
    assert.ok(!u.ereignisse.some((x) => x.bereich === 'freigaben'));
    // Fehler beim Systembefehl → E_SYSTEM mit Befehl
    u.scheins.testparmFehler = null;
    u.scheins.fehlschlag = (p, a) => (p === 'btrfs' && a[1] === 'create' ? { code: 1, stderr: 'ERROR: cannot create subvolume' } : null);
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'platte', schreiben: ['chef'] }), (e) => e.code === 'E_SYSTEM' && e.details.befehl.startsWith('btrfs subvolume create'));
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben.map((f) => f.name), ['ok']);
  } finally { await u.aufraeumen(); }
});

test('freigaben: apply ist idempotent – erster Lauf baut, zweiter Lauf fragt nur', async () => {
  const u = await grundlage();
  try {
    await u.admin('freigaben.anlegen', { name: 'medien', lesen: ['@familie'], schreiben: ['chef'], groesse_gb: 10 });
    await u.admin('freigaben.anlegen', { name: 'tm', schreiben: ['chef'], timemachine: true });
    // „Neuinstallation“: Samba-Includes, Avahi und ACLs weg, Unterlaufwerke bleiben auf der Datenpartition
    for (const d of await fs.readdir(u.pfade.samba)) await fs.unlink(path.join(u.pfade.samba, d));
    await fs.rm(u.pfade.avahi, { recursive: true, force: true });
    u.scheins.acl.clear();
    u.scheins.leeren();
    const r1 = await u.system('freigaben.apply', {});
    assert.equal(r1.freigaben, 2); assert.deepEqual(r1.angelegt, []); assert.deepEqual(r1.rechte_gesetzt, ['medien', 'tm']); assert.equal(r1.samba_geaendert, true);
    assert.ok(u.scheins.zeilen().includes(`setfacl --set-file=- ${path.join(u.pfade.shares, 'medien')}`));
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('btrfs subvolume create')));
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('btrfs qgroup limit')), 'Grenze war schon gesetzt');
    assert.deepEqual((await fs.readdir(u.pfade.samba)).sort(), ['alle.conf', 'medien.conf', 'tm.conf']);
    assert.ok((await fs.readFile(path.join(u.pfade.avahi, 'fahnas-timemachine.service'), 'utf8')).includes('adVN=tm'));
    // zweiter Lauf: nur Prüfungen
    u.scheins.leeren();
    const r2 = await u.system('freigaben.apply', {});
    assert.deepEqual(r2, { freigaben: 2, angelegt: [], rechte_gesetzt: [], samba_geaendert: false });
    const z = u.scheins.zeilen();
    assert.ok(z.length > 0);
    assert.ok(z.every((x) => /^(getfacl -p |btrfs qgroup show )/.test(x)), `nur Prüfungen erwartet: ${z.join(' | ')}`);
    // Unterlaufwerk fehlt (Platte getauscht) → wird angelegt
    await fs.rm(path.join(u.pfade.shares, 'tm'), { recursive: true });
    u.scheins.leeren();
    const r3 = await u.system('freigaben.apply', {});
    assert.deepEqual(r3.angelegt, ['tm']);
    assert.ok(u.scheins.zeilen().includes(`btrfs subvolume create ${path.join(u.pfade.shares, 'tm')}`));
  } finally { await u.aufraeumen(); }
});
