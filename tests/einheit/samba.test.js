// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/render/samba.js: Soll-Texte je Freigabe (Gäste, Papierkorb, Time Machine), Injektion,
// globale Vorlage, alle.conf, Avahi, Rendern mit testparm-Prüfung (.neu → rename), Fehlerfall lässt alte Datei stehen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as samba from '../../src/agent/render/samba.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';

const O = { sharesPfad: '/data/shares' };

test('samba: Freigabe mit Nutzern und Gruppe – erwarteter smb.conf-Abschnitt', () => {
  const text = samba.freigabeText({ name: 'medien', beschreibung: 'Filme und Musik', lesen: ['anna', '@familie'], schreiben: ['fabian', 'anna'], papierkorb: false }, O);
  assert.equal(text, [
    '[medien]',
    '    path = /data/shares/medien',
    '    comment = Filme und Musik',
    '    browseable = yes',
    '    read only = no',
    '    valid users = anna, @familie, fabian',
    '    read list = @familie',
    '    write list = fabian, anna',
    '    guest ok = no',
    '    force group = fahnas-nutzer',
    '    create mask = 0660',
    '    directory mask = 2770',
    '    inherit permissions = yes',
    '    vfs objects = fruit streams_xattr',
    '',
  ].join('\n'));
});

test('samba: Papierkorb + Gäste + versteckt', () => {
  const text = samba.freigabeText({ name: 'tausch', gaeste: true, papierkorb: true, versteckt: true, lesen: [], schreiben: [] }, O);
  assert.equal(text, [
    '[tausch]',
    '    path = /data/shares/tausch',
    '    browseable = no',
    '    read only = no',
    '    valid users = nobody',
    '    guest ok = yes',
    '    force group = fahnas-nutzer',
    '    create mask = 0660',
    '    directory mask = 2770',
    '    inherit permissions = yes',
    '    vfs objects = fruit streams_xattr recycle',
    '    recycle:repository = .papierkorb/samba',
    '    recycle:keeptree = yes',
    '    recycle:versions = yes',
    '    recycle:touch = yes',
    '    recycle:exclude_dir = /.papierkorb',
    '',
  ].join('\n'));
});

test('samba: Time Machine mit Größenbegrenzung', () => {
  const text = samba.freigabeText({ name: 'timemachine', schreiben: ['fabian'], timemachine: true, groesse_gb: 500 }, O);
  assert.ok(text.includes('    fruit:time machine = yes\n    fruit:time machine max size = 500G\n    durable handles = yes\n    kernel oplocks = no\n    posix locking = no\n'));
  assert.ok(text.includes('    valid users = fabian\n    write list = fabian\n'));
  assert.ok(!text.includes('recycle'));
  const ohne = samba.freigabeText({ name: 'tm2', schreiben: ['fabian'], timemachine: true }, O);
  assert.ok(ohne.includes('fruit:time machine = yes') && !ohne.includes('max size'));
});

test('samba: ohne Rechte und Gäste wird die Freigabe abgeschaltet (kein leeres valid users)', () => {
  const text = samba.freigabeText({ name: 'leer', lesen: [], schreiben: [] }, O);
  assert.ok(text.includes('    available = no\n'));
  assert.ok(!text.includes('valid users'));
});

test('samba: Injektionsversuche werden abgelehnt', () => {
  const basis = { name: 'x', schreiben: ['fabian'] };
  assert.throws(() => samba.freigabeText({ ...basis, beschreibung: 'harmlos\n[global]\n    root preexec = /bin/sh' }, O), (e) => e.code === 'E_PARAMS' && e.details.feld === 'beschreibung');
  assert.throws(() => samba.freigabeText({ ...basis, beschreibung: 'mit "Anführungszeichen"' }, O), (e) => e.code === 'E_PARAMS');
  assert.throws(() => samba.freigabeText({ ...basis, beschreibung: 'Steuer\u0007zeichen' }, O), (e) => e.code === 'E_PARAMS');
  assert.throws(() => samba.freigabeText({ ...basis, name: 'Böse Freigabe' }, O), (e) => e.code === 'E_PARAMS' && e.details.feld === 'name');
  assert.throws(() => samba.freigabeText({ ...basis, name: '../etc' }, O), (e) => e.code === 'E_PARAMS');
  assert.throws(() => samba.freigabeText({ ...basis, schreiben: ['fabian\n[x]'] }, O), (e) => e.code === 'E_PARAMS' && e.details.feld === 'schreiben');
  assert.throws(() => samba.freigabeText({ ...basis, lesen: ['@'] }, O), (e) => e.code === 'E_PARAMS');
  assert.throws(() => samba.alleText([{ name: 'a\nb' }]), (e) => e.code === 'E_PARAMS');
  assert.throws(() => samba.avahiText([{ name: 'a<b', timemachine: true }]), (e) => e.code === 'E_PARAMS');
  // Apostroph ist erlaubt (kein Anführungszeichen im Sinne der smb.conf)
  assert.ok(samba.freigabeText({ ...basis, beschreibung: "Fabian's Fotos" }, O).includes("comment = Fabian's Fotos"));
});

test('samba: globale Vorlage, alle.conf und Avahi-Dienstdatei', () => {
  const g = samba.globaleVorlage({ sambaOrdner: '/etc/samba/fahnas', konfigOrdner: '/data/config' });
  for (const zeile of ['[global]', 'workgroup = WORKGROUP', 'server role = standalone server', 'map to guest = Bad User', 'security = user',
    'server min protocol = SMB2', 'vfs objects = fruit streams_xattr', 'fruit:metadata = stream', 'fruit:model = MacSamba', 'fruit:posix_rename = yes',
    'fruit:veto_appledouble = no', 'fruit:nfs_aces = no', 'fruit:wipe_intentionally_left_blank_rfork = yes', 'fruit:delete_empty_adfiles = yes',
    'log level = 1', 'private dir = /data/config/samba', 'passdb backend = tdbsam', 'include = /etc/samba/fahnas/alle.conf']) {
    assert.ok(g.includes(zeile), `fehlt: ${zeile}`);
  }
  assert.ok(!samba.globaleVorlage({ mitInclude: false }).includes('include ='));

  const alle = samba.alleText([{ name: 'medien' }, { name: 'tausch' }], { sambaOrdner: '/etc/samba/fahnas' });
  assert.equal(alle.split('\n').filter((z) => z.startsWith('include')).join('\n'), 'include = /etc/samba/fahnas/medien.conf\ninclude = /etc/samba/fahnas/tausch.conf');

  const avahi = samba.avahiText([{ name: 'medien' }, { name: 'timemachine', timemachine: true }, { name: 'tm2', timemachine: true }]);
  assert.ok(avahi.includes('<type>_smb._tcp</type>'));
  assert.ok(avahi.includes('<type>_adisk._tcp</type>'));
  assert.ok(avahi.includes('<txt-record>dk0=adVN=timemachine,adVF=0x82</txt-record>'));
  assert.ok(avahi.includes('<txt-record>dk1=adVN=tm2,adVF=0x82</txt-record>'));
  assert.ok(avahi.includes('<txt-record>sys=waMa=0,adVF=0x100</txt-record>'));
  const ohneTm = samba.avahiText([{ name: 'medien' }]);
  assert.ok(ohneTm.includes('_smb._tcp') && !ohneTm.includes('_adisk'));
});

test('samba: rendern schreibt .neu, prüft mit testparm, tauscht, lädt neu; unverändert = keine Prüfung; Fehler lässt alte Datei stehen', async () => {
  const u = await werkzeugeBauen();
  try {
    const freigaben = [{ name: 'medien', schreiben: ['fabian'], papierkorb: true }, { name: 'alt', lesen: ['fabian'] }];
    const r1 = await samba.rendern(u.werkzeuge, freigaben);
    assert.equal(r1.geaendert, true);
    assert.deepEqual(r1.dateien.sort(), ['alle.conf', 'alt.conf', 'medien.conf']);
    const medien = await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8');
    assert.equal(medien, samba.freigabeText(freigaben[0], { sharesPfad: u.pfade.shares }));
    const alle = await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8');
    assert.ok(alle.includes(`include = ${path.join(u.pfade.samba, 'medien.conf')}`));
    const zeilen = u.scheins.zeilen();
    const iTest = zeilen.findIndex((z) => z.startsWith('testparm -s --suppress-prompt '));
    const iReload = zeilen.indexOf('smbcontrol all reload-config');
    assert.ok(iTest >= 0 && iReload > iTest, 'testparm vor smbcontrol');
    assert.ok(zeilen[iTest].endsWith('.pruef.smb.conf'));
    assert.ok(u.scheins.testparmInhalte[0].includes('[global]') && u.scheins.testparmInhalte[0].includes('[medien]') && u.scheins.testparmInhalte[0].includes('[alt]'));
    assert.ok(!u.scheins.testparmInhalte[0].includes('include ='), 'Prüfdatei enthält die Abschnitte wörtlich, keine includes');
    const avahi = await fs.readFile(path.join(u.pfade.avahi, samba.AVAHI_DATEI), 'utf8');
    assert.ok(avahi.includes('_smb._tcp'));
    // keine Reste
    const dateien = await fs.readdir(u.pfade.samba);
    assert.ok(!dateien.some((d) => d.endsWith('.neu') || d.endsWith('.tmp') || d.startsWith('.pruef')), `Reste: ${dateien}`);

    // 2. Lauf unverändert → kein testparm, kein reload
    u.scheins.leeren();
    const r2 = await samba.rendern(u.werkzeuge, freigaben);
    assert.equal(r2.geaendert, false);
    assert.deepEqual(u.scheins.zeilen(), []);

    // 3. Lauf: Freigabe „alt“ weg → verwaiste Datei wird entfernt
    u.scheins.leeren();
    await samba.rendern(u.werkzeuge, [freigaben[0]]);
    assert.ok(!(await fs.readdir(u.pfade.samba)).includes('alt.conf'));
    assert.ok(u.scheins.zeilen().some((z) => z.startsWith('testparm')));

    // 4. Lauf: testparm lehnt ab → E_RENDER mit Ausgabe, alte medien.conf bleibt, keine .neu-Dateien
    u.scheins.leeren();
    u.scheins.testparmFehler = 'Error loading services.';
    const vorher = await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8');
    await assert.rejects(samba.rendern(u.werkzeuge, [{ name: 'medien', schreiben: ['fabian'], papierkorb: false }]), (e) => e.code === 'E_RENDER' && e.details.ausgabe.includes('Error loading services'));
    assert.equal(await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8'), vorher);
    const rest = await fs.readdir(u.pfade.samba);
    assert.ok(!rest.some((d) => d.endsWith('.neu') || d.startsWith('.pruef')), `Reste nach Fehler: ${rest}`);
    assert.ok(!u.scheins.zeilen().includes('smbcontrol all reload-config'));
  } finally { await u.aufraeumen(); }
});

test('samba: System-Freigabe „docker“ (App-Ordner, nur Admins, als root) folgt dem Schalter docker_freigabe in system.json', async () => {
  const text = samba.dockerFreigabeText({ appsPfad: '/data/apps' });
  for (const z of ['[docker]', '    path = /data/apps', '    valid users = @fahnas-admin', '    force user = root', '    inherit owner = yes', '    guest ok = no']) assert.ok(text.includes(`${z}\n`), z);
  const u = await werkzeugeBauen();
  try {
    u.werkzeuge.pfade.apps = '/data/apps';
    const freigaben = [{ name: 'medien', schreiben: ['fabian'] }];
    const aus = await samba.rendern(u.werkzeuge, freigaben);
    assert.ok(!aus.dateien.includes('docker.conf'), 'Standard: aus');
    await u.werkzeuge.konfig.aendern('system.json', (s) => { s.docker_freigabe = true; }, {});
    const an = await samba.rendern(u.werkzeuge, freigaben);
    assert.equal(an.geaendert, true);
    assert.equal(await fs.readFile(path.join(u.pfade.samba, 'docker.conf'), 'utf8'), text);
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8')).includes(`include = ${path.join(u.pfade.samba, 'docker.conf')}`));
    await u.werkzeuge.konfig.aendern('system.json', (s) => { s.docker_freigabe = false; }, {});
    await samba.rendern(u.werkzeuge, freigaben);
    await assert.rejects(fs.access(path.join(u.pfade.samba, 'docker.conf')), 'wieder weg');
    assert.ok(!(await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8')).includes('docker.conf'));
  } finally { await u.aufraeumen(); }
});

test('Papierkorb: externe Laufwerke haben immer einen (auch per SMB), Time Machine nie', () => {
  const extern = samba.freigabeText({ name: 'usb', extern: true, papierkorb: false, schreiben: ['chef'] });
  assert.ok(extern.includes('recycle:repository = .papierkorb/samba'));
  assert.equal(samba.hatPapierkorb({ extern: true, papierkorb: false }), true);
  assert.equal(samba.hatPapierkorb({ papierkorb: false }), false);
  assert.equal(samba.hatPapierkorb({ papierkorb: true, timemachine: true }), false);
});

