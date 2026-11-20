// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/aktionen/nutzer.js: Schema, Rollen, Befehlsfolgen (useradd/chpasswd/smbpasswd mit stdin),
// scrypt-Hash, Anmeldeprüfung, Sperren, letzter Admin, Gruppen, TOTP-Ablauf, Wiederherstellungscodes, apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import * as totp from '../../src/agent/totp.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';
import { dmId } from '../../src/agent/chat/ablage.js';
import { namenErsetzen, umbenennungenLaden } from '../../src/agent/helfer/umbenennungen.js';

const MODULE = [nutzer, freigaben];
const PW = 'sehr-geheim-123';

async function chefAnlegen(u) {
  // erster Admin kommt „von außen“ (Ersteinrichtung) – hier über die Systemrolle
  return u.system('nutzer.anlegen', { name: 'chef', anzeigename: 'Der Chef', passwort: PW, rolle: 'admin' });
}

test('nutzer: Schema lehnt ungültige Eingaben ab, Rollen werden geprüft', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'Anna', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'name');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: 'kurz', rolle: 'nutzer' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: 'mit\nzeilenumbruch', rolle: 'nutzer' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'gott' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'rolle');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', hash: 'x' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['Familie'] }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'root', passwort: PW, rolle: 'admin' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.gruppe.anlegen', { name: 'sudo' }), (e) => e.code === 'E_PARAMS');
    // Rollen
    const anna = u.als('anna');
    await assert.rejects(anna('nutzer.liste', {}), (e) => e.code === 'E_RECHTE');
    await assert.rejects(anna('nutzer.anlegen', { name: 'x', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_RECHTE');
    // nutzer.pruefen ist eine Gast-Aktion (Web-Login ohne Sitzung) – liefert für Unbekannte nur {ok:false}
    assert.deepEqual(await anna('nutzer.pruefen', { name: 'x', passwort: PW }), { ok: false });
    await assert.rejects(anna('nutzer.apply', {}), (e) => e.code === 'E_RECHTE', 'system-Aktion nicht für Nutzer');
    await assert.rejects(u.admin('nutzer.apply', {}), (e) => e.code === 'E_RECHTE');
    assert.equal(u.scheins.befehle.length, 0, 'kein Systembefehl bei abgelehnten Eingaben');
  } finally { await u.aufraeumen(); }
});

test('nutzer: anlegen erzeugt Gruppen, Linux-Konto, Passwörter über stdin und scrypt-Hash (Datei 0600)', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    const e = await chefAnlegen(u);
    assert.equal(e.name, 'chef'); assert.equal(e.rolle, 'admin'); assert.equal(e.uid, 1001); assert.equal(e.totp, false); assert.equal(e.uebernommen, false);
    assert.equal(e.hash, undefined, 'kein Hash nach außen');
    const z = u.scheins.zeilen();
    assert.deepEqual(z, [
      'getent passwd chef',
      'getent group fahnas-nutzer', 'groupadd -r fahnas-nutzer',
      'getent group fahnas-admin', 'groupadd -r fahnas-admin',
      'useradd -M -s /usr/sbin/nologin -G fahnas-nutzer,fahnas-admin chef',
      'getent passwd chef',
      'getent passwd chef', 'usermod -s /bin/bash chef', // Admin bekommt eine Anmeldeshell (Root-Wrapper, adminroot.js)
      'chpasswd',
      'smbpasswd -a -s chef',
    ]);
    const chp = u.scheins.befehle.find((b) => b.programm === 'chpasswd');
    assert.equal(chp.eingabe, `chef:${PW}\n`);
    const smb = u.scheins.befehle.find((b) => b.programm === 'smbpasswd');
    assert.equal(smb.eingabe, `${PW}\n${PW}\n`);
    assert.ok(!u.scheins.befehle.some((b) => b.args.some((a) => a.includes(PW))), 'Passwort nie als Argument');
    const datei = await u.konfig.laden('users.json');
    assert.equal(datei.nutzer.length, 1);
    assert.match(datei.nutzer[0].hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await totp.hashPruefen(PW, datei.nutzer[0].hash), true);
    const st = await fs.stat(path.join(u.pfade.konfig, 'users.json'));
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'konfig' && x.bereich === 'nutzer'));

    // zweiter Nutzer: Gruppen existieren schon → kein groupadd mehr
    u.scheins.leeren();
    await u.admin('nutzer.anlegen', { name: 'anna', anzeigename: 'Anna', passwort: PW, rolle: 'nutzer' });
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('groupadd')));
    assert.ok(u.scheins.zeilen().includes('useradd -M -s /usr/sbin/nologin -G fahnas-nutzer anna'));
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_EXISTIERT');
    const liste = await u.admin('nutzer.liste', {});
    assert.deepEqual(liste.map((n) => n.name), ['chef', 'anna']);
    assert.ok(liste.every((n) => n.hash === undefined));
  } finally { await u.aufraeumen(); }
});

test('nutzer: vorhandenes Linux-Konto (Installer-Benutzer) wird übernommen, Systemkonten nie', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    u.scheins.gruppen.set('sudo', 27);
    u.scheins.passwd.set('fabian', { uid: 1000, gid: 1000, gruppen: new Set(['sudo']), gesperrt: false });
    u.scheins.passwd.set('postfix', { uid: 105, gid: 105, gruppen: new Set(), gesperrt: false });
    const e = await u.system('nutzer.anlegen', { name: 'fabian', passwort: PW, rolle: 'admin' });
    assert.equal(e.uebernommen, true); assert.equal(e.uid, 1000);
    const z = u.scheins.zeilen();
    assert.ok(!z.some((x) => x.startsWith('useradd')), 'kein useradd');
    assert.ok(z.includes('usermod -aG fahnas-nutzer,fahnas-admin fabian'));
    assert.ok(z.includes('chpasswd') && z.includes('smbpasswd -a -s fabian'));
    assert.ok(u.scheins.passwd.get('fabian').gruppen.has('sudo'), 'fremde Gruppe bleibt');
    await assert.rejects(u.system('nutzer.anlegen', { name: 'postfix', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_EXISTIERT', 'Systemkonto uid < 1000');
    await assert.rejects(u.system('nutzer.anlegen', { name: 'www-data', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_PARAMS', 'reservierter Name');
  } finally { await u.aufraeumen(); }
});

test('nutzer: pruefen – richtig, falsch, unbekannt, gesperrt; unbekannte Nutzer kosten die gleiche Rechenzeit', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    { const r = await u.system('nutzer.pruefen', { name: 'chef', passwort: PW }); assert.equal(typeof r.anzeigename, 'string'); delete r.anzeigename; assert.deepEqual(r, { ok: true, rolle: 'admin', totp_noetig: false, totp: false }); }
    const nachher = (await u.admin('nutzer.liste', {}))[0];
    assert.ok(nachher.letzte_anmeldung && !Number.isNaN(Date.parse(nachher.letzte_anmeldung)));
    const t0 = process.hrtime.bigint();
    assert.deepEqual(await u.system('nutzer.pruefen', { name: 'chef', passwort: 'falsch-falsch' }), { ok: false });
    const bekannt = Number(process.hrtime.bigint() - t0);
    const t1 = process.hrtime.bigint();
    assert.deepEqual(await u.system('nutzer.pruefen', { name: 'niemand', passwort: 'falsch-falsch' }), { ok: false });
    const unbekannt = Number(process.hrtime.bigint() - t1);
    assert.ok(unbekannt > bekannt * 0.3, `unbekannter Nutzer zu schnell: ${unbekannt / 1e6} ms vs ${bekannt / 1e6} ms`);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    await u.admin('nutzer.aendern', { name: 'anna', gesperrt: true });
    assert.deepEqual(await u.system('nutzer.pruefen', { name: 'anna', passwort: PW }), { ok: false });
    // Umlaute: NFC/NFD gleich behandelt
    await u.admin('nutzer.anlegen', { name: 'oemer', passwort: 'Überraschung99', rolle: 'nutzer' });
    assert.equal((await u.system('nutzer.pruefen', { name: 'oemer', passwort: 'Überraschung99' })).ok, true);
  } finally { await u.aufraeumen(); }
});

test('nutzer: passwort – eigenes mit altem Passwort, fremdes verboten, Admin ohne altes', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    const anna = u.als('anna');
    await assert.rejects(anna('nutzer.passwort', { name: 'chef', passwort: 'neu-neu-neu-1' }), (e) => e.code === 'E_RECHTE');
    await assert.rejects(anna('nutzer.passwort', { name: 'anna', passwort: 'neu-neu-neu-1' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'altes_passwort');
    await assert.rejects(anna('nutzer.passwort', { name: 'anna', passwort: 'neu-neu-neu-1', altes_passwort: 'falsch' }), (e) => e.code === 'E_ANMELDUNG');
    u.scheins.leeren();
    await anna('nutzer.passwort', { name: 'anna', passwort: 'neu-neu-neu-1', altes_passwort: PW });
    assert.deepEqual(u.scheins.zeilen(), ['chpasswd', 'smbpasswd -a -s anna']);
    assert.equal(u.scheins.befehle[0].eingabe, 'anna:neu-neu-neu-1\n');
    assert.equal((await u.system('nutzer.pruefen', { name: 'anna', passwort: 'neu-neu-neu-1' })).ok, true);
    assert.equal((await u.system('nutzer.pruefen', { name: 'anna', passwort: PW })).ok, false);
    await u.admin('nutzer.passwort', { name: 'anna', passwort: 'vom-admin-gesetzt' });
    assert.equal((await u.system('nutzer.pruefen', { name: 'anna', passwort: 'vom-admin-gesetzt' })).ok, true);
    assert.equal(u.scheins.samba.get('anna').passwort, 'vom-admin-gesetzt');
  } finally { await u.aufraeumen(); }
});

test('nutzer: aendern – Rolle pflegt fahnas-admin, Sperren/Entsperren, letzter Admin, Selbstsperre', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    await assert.rejects(u.admin('nutzer.aendern', { name: 'chef', rolle: 'nutzer' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'rolle');
    await assert.rejects(u.admin('nutzer.aendern', { name: 'chef', gesperrt: true }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'gesperrt');
    u.scheins.leeren();
    const e = await u.admin('nutzer.aendern', { name: 'anna', rolle: 'admin', anzeigename: 'Anna A.' });
    assert.equal(e.rolle, 'admin'); assert.equal(e.anzeigename, 'Anna A.');
    assert.deepEqual(u.scheins.zeilen(), ['id -nG anna', 'usermod -aG fahnas-admin anna', 'getent passwd anna', 'usermod -s /bin/bash anna']);
    // jetzt darf der Chef herabgestuft werden
    u.scheins.leeren();
    await u.admin('nutzer.aendern', { name: 'chef', rolle: 'nutzer' });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG chef', 'gpasswd -d chef fahnas-admin', 'getent passwd chef', 'usermod -s /usr/sbin/nologin chef']);
    // anna ist jetzt einziger Admin → nicht sperrbar, chef (Nutzer) schon
    await assert.rejects(u.admin('nutzer.aendern', { name: 'anna', gesperrt: true }), (e) => e.code === 'E_PARAMS');
    u.scheins.leeren();
    await u.als('anna', 'admin')('nutzer.aendern', { name: 'chef', gesperrt: true });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG chef', 'getent passwd chef', 'usermod -L chef', 'smbpasswd -d chef']);
    assert.equal(u.scheins.samba.get('chef').aktiv, false);
    u.scheins.leeren();
    await u.als('anna', 'admin')('nutzer.aendern', { name: 'chef', gesperrt: false });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG chef', 'getent passwd chef', 'usermod -U chef', 'smbpasswd -e chef']);
    await assert.rejects(u.als('anna', 'admin')('nutzer.aendern', { name: 'anna', gesperrt: true }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.aendern', { name: 'niemand', gesperrt: true }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    // Sperre schon gesetzt → keine Befehle mehr (idempotent)
    u.scheins.leeren();
    await u.als('anna', 'admin')('nutzer.aendern', { name: 'chef', gesperrt: false });
    assert.deepEqual(u.scheins.zeilen(), []);
  } finally { await u.aufraeumen(); }
});

test('nutzer: loeschen – letzter Admin und Selbst verboten; Dateien, Samba, Linux, Freigaben bereinigt', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    await u.admin('freigaben.anlegen', { name: 'medien', lesen: ['anna'], schreiben: ['chef'], papierkorb: false });
    await assert.rejects(u.admin('nutzer.loeschen', { name: 'chef', dateien: 'behalten' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('nutzer.loeschen', { name: 'anna', dateien: 'alles' }), (e) => e.code === 'E_PARAMS');
    await u.admin('nutzer.aendern', { name: 'anna', rolle: 'admin' });
    await assert.rejects(u.als('anna', 'admin')('nutzer.loeschen', { name: 'anna', dateien: 'behalten' }), (e) => e.code === 'E_PARAMS', 'nicht selbst');
    // Chat (Prüfbericht Plan 02, Befund 5): ein Raum mit anna – nach dem Löschen ist sie nicht mehr Mitglied
    u.pfade.chat = path.join(u.pfade.daten, 'chat');
    const raumDatei = path.join(u.pfade.chat, 'raeume', 'rAAAAAAAAAAAAAAAA', 'raum.json');
    await fs.mkdir(path.dirname(raumDatei), { recursive: true });
    await fs.writeFile(raumDatei, JSON.stringify({ schema: 1, id: 'rAAAAAAAAAAAAAAAA', art: 'raum', name: 'Team', verwalter: ['chef'], mitglieder: { chef: { seit: '2026-10-18T08:00:00.000Z' }, anna: { seit: '2026-10-18T08:00:00.000Z' } }, gaeste: {}, einladungen: [] }));
    u.scheins.leeren();
    const r = await u.admin('nutzer.loeschen', { name: 'anna', dateien: 'loeschen' });
    assert.deepEqual(r, { name: 'anna', dateien: 'loeschen' });
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(raumDatei, 'utf8')).mitglieder), ['chef'], 'anna aus dem Chat-Raum ausgetragen');
    const z = u.scheins.zeilen();
    assert.equal(z[0], `find ${u.pfade.shares} -xdev -uid 1002 -delete`);
    assert.equal(z[1], 'smbpasswd -x anna');
    assert.equal(z[2], 'getent passwd anna');
    assert.equal(z[3], 'pkill -KILL -u anna', 'offene Sitzungen (SFTP/SMB) vorher beenden');
    assert.equal(z[4], 'userdel anna');
    assert.ok(!u.scheins.passwd.has('anna') && !u.scheins.samba.has('anna'));
    assert.deepEqual((await u.admin('nutzer.liste', {})).map((n) => n.name), ['chef']);
    const shares = await u.konfig.laden('shares.json');
    assert.deepEqual(shares.freigaben[0].lesen, []);
    assert.ok(z.some((x) => x.startsWith('setfacl')), 'ACL der Freigabe neu gesetzt');
    const conf = await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8');
    assert.ok(!conf.includes('anna'));
    // Dateien behalten → kein find
    await u.admin('nutzer.anlegen', { name: 'bert', passwort: PW, rolle: 'nutzer' });
    u.scheins.leeren();
    await u.admin('nutzer.loeschen', { name: 'bert', dateien: 'behalten' });
    assert.ok(!u.scheins.zeilen().some((x) => x.startsWith('find')));
  } finally { await u.aufraeumen(); }
});

test('nutzer: umbenennen – Linux/Samba (Passwort und Sperre bleiben), Ordner, Freigaben, Chat-DM, Office, Links; Prüfungen', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'mmustermann', anzeigename: 'Max', passwort: PW, rolle: 'nutzer' });
    await u.admin('freigaben.anlegen', { name: 'medien', lesen: ['mmustermann'], schreiben: ['chef'], papierkorb: false });
    const umb = (neu, kontext = u.ADMIN) => u.rufen('nutzer.umbenennen', { name: 'mmustermann', neu }, kontext);
    await assert.rejects(umb('mmustermann'), (e) => e.code === 'E_PARAMS', 'gleicher Name');
    await assert.rejects(umb('chef'), (e) => e.code === 'E_EXISTIERT');
    await assert.rejects(umb('root'), (e) => e.code === 'E_PARAMS', 'reserviert');
    await assert.rejects(umb('medien'), (e) => e.code === 'E_EXISTIERT', 'Freigabe gleichen Namens verdeckte [homes]');
    await assert.rejects(umb('m..w'), (e) => e.code === 'E_PARAMS');
    await assert.rejects(umb('m.mustermann', { nutzer: 'mmustermann', rolle: 'nutzer', ip: '-' }), (e) => e.code === 'E_RECHTE');
    await u.admin('nutzer.aendern', { name: 'mmustermann', gesperrt: true });
    const vorher = { ...u.scheins.passwd.get('mmustermann') }; const nt = u.scheins.samba.get('mmustermann').nt;
    // persönlicher Ordner, Chat-DM mit Verlauf und Anhang, Office, Freigabelink, Stumm-Liste, Avatar
    const heim = path.join(u.pfade.daten, 'homes');
    await fs.mkdir(path.join(heim, 'mmustermann'), { recursive: true }); await fs.writeFile(path.join(heim, 'mmustermann', 'notiz.txt'), 'x');
    u.pfade.chat = path.join(u.pfade.daten, 'chat');
    const dm = dmId('chef', 'mmustermann');
    const raum = (id) => path.join(u.pfade.chat, 'raeume', id);
    await fs.mkdir(path.join(raum(dm), 'verlauf'), { recursive: true });
    await fs.writeFile(path.join(raum(dm), 'raum.json'), JSON.stringify({ schema: 1, id: dm, art: 'dm', name: '', verwalter: [], ersteller: 'mmustermann', mitglieder: { chef: { seit: '2026-10-18T08:00:00.000Z', ungelesen: 0 }, mmustermann: { seit: '2026-10-18T08:00:00.000Z', ungelesen: 2 } }, gaeste: {}, einladungen: [], letzte: { von: 'mmustermann', zeit: '2026-10-18T09:00:00.000Z' } }));
    await fs.writeFile(path.join(raum(dm), 'verlauf', '2026-10.ndjson'), [{ t: 'n', id: 'n0000000001aaaaaa', von: 'mmustermann', text: 'Hallo', zeit: '2026-10-18T09:00:00.000Z' }, { t: 'r', id: 'n0000000001aaaaaa', von: 'chef', emoji: '👍' }, { t: 's', wer: 'mmustermann', art: 'eintritt' }].map((z) => JSON.stringify(z)).join('\n') + '\n');
    await fs.mkdir(path.join(u.pfade.chat, 'anhaenge', dm), { recursive: true });
    await fs.writeFile(path.join(u.pfade.chat, 'anhaenge', dm, 'aAAAAAAAAAAAAAAAA.json'), JSON.stringify({ id: 'aAAAAAAAAAAAAAAAA', von: 'mmustermann' }));
    await u.konfig.speichern('office.json', { version: 1, dokumente: { oAAAAAAAAAAAAAAAA: { id: 'oAAAAAAAAAAAAAAAA', art: 'board', besitzer: 'mmustermann', freigaben: { mmustermann: 'bearbeiten', chef: 'lesen' } }, oBBBBBBBBBBBBBBBB: { id: 'oBBBBBBBBBBBBBBBB', art: 'dokument', besitzer: 'chef', freigaben: { mmustermann: 'lesen' } } }, zuletzt: { mmustermann: [{ id: 'oAAAAAAAAAAAAAAAA', zeit: '2026-10-18T09:00:00.000Z' }] } });
    await u.konfig.speichern('links.json', [{ token: 'T'.repeat(32), freigabe: 'medien', pfad: 'a.txt', nutzer: 'mmustermann', erstellt: '2026-10-18T09:00:00.000Z', ablauf: null }]);
    await u.admin('nutzer.einstellungen.setzen', { name: 'chef', bereich: 'chat', wert: { stumm: [dm] } });
    await fs.mkdir(path.join(u.pfade.konfig, 'avatare'), { recursive: true }); await fs.writeFile(path.join(u.pfade.konfig, 'avatare', 'mmustermann'), 'bild');
    u.scheins.leeren();
    const r = await umb('m.mustermann');
    assert.equal(r.name, 'm.mustermann'); assert.equal(r.alt, 'mmustermann'); assert.equal(r.uid, vorher.uid);
    // Linux: gleiche uid, eigene Gruppe mit; Samba: alter Eintrag vor usermod weg, gleicher NT-Hash, Sperre bleibt
    assert.ok(!u.scheins.passwd.has('mmustermann') && u.scheins.passwd.get('m.mustermann').uid === vorher.uid);
    assert.ok(u.scheins.gruppen.has('m.mustermann') && !u.scheins.gruppen.has('mmustermann'));
    const z = u.scheins.zeilen();
    assert.ok(z.indexOf('smbpasswd -x mmustermann') >= 0 && z.indexOf('smbpasswd -x mmustermann') < z.indexOf('usermod -l m.mustermann -d /home/m.mustermann mmustermann'), z.join('\n'));
    assert.ok(z.includes('groupmod -n m.mustermann mmustermann') && z.includes(`pdbedit -u m.mustermann --set-nt-hash ${nt}`));
    assert.ok(!u.scheins.samba.has('mmustermann'));
    assert.equal(u.scheins.samba.get('m.mustermann').nt, nt); assert.equal(u.scheins.samba.get('m.mustermann').aktiv, false);
    // Web-Anmeldung mit dem bisherigen Passwort (Sperre aufheben)
    await u.admin('nutzer.aendern', { name: 'm.mustermann', gesperrt: false });
    assert.equal((await u.system('nutzer.pruefen', { name: 'm.mustermann', passwort: PW })).ok, true);
    assert.equal(await fs.readFile(path.join(heim, 'm.mustermann', 'notiz.txt'), 'utf8'), 'x');
    await assert.rejects(fs.access(path.join(heim, 'mmustermann')));
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben[0].lesen, ['m.mustermann']);
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'medien.conf'), 'utf8')).includes('m.mustermann'));
    assert.equal(await fs.readFile(path.join(u.pfade.konfig, 'avatare', 'm.mustermann'), 'utf8'), 'bild');
    // Chat: DM zieht an die neue Kennung, Verlauf/Anhang/Lesestand folgen
    const neuDm = dmId('chef', 'm.mustermann');
    await assert.rejects(fs.access(raum(dm)));
    const rj = JSON.parse(await fs.readFile(path.join(raum(neuDm), 'raum.json'), 'utf8'));
    assert.equal(rj.id, neuDm); assert.deepEqual(Object.keys(rj.mitglieder).sort(), ['chef', 'm.mustermann']);
    assert.equal(rj.mitglieder['m.mustermann'].ungelesen, 2); assert.equal(rj.ersteller, 'm.mustermann'); assert.equal(rj.letzte.von, 'm.mustermann');
    const zeilen = (await fs.readFile(path.join(raum(neuDm), 'verlauf', '2026-10.ndjson'), 'utf8')).trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(zeilen.map((x) => x.von || x.wer), ['m.mustermann', 'chef', 'm.mustermann']);
    assert.equal(JSON.parse(await fs.readFile(path.join(u.pfade.chat, 'anhaenge', neuDm, 'aAAAAAAAAAAAAAAAA.json'), 'utf8')).von, 'm.mustermann');
    const users = await u.konfig.laden('users.json');
    assert.deepEqual(users.nutzer.find((n) => n.name === 'chef').einstellungen.chat.stumm, [neuDm]);
    assert.deepEqual(users.umbenennungen.map((x) => [x.alt, x.neu]), [['mmustermann', 'm.mustermann']]);
    // Office: Besitz, Freigaben, Zuletzt; Inhalte übersetzt beim Laden
    const of = await u.konfig.laden('office.json');
    assert.equal(of.dokumente.oAAAAAAAAAAAAAAAA.besitzer, 'm.mustermann');
    assert.deepEqual(of.dokumente.oAAAAAAAAAAAAAAAA.freigaben, { 'm.mustermann': 'bearbeiten', chef: 'lesen' });
    assert.deepEqual(of.dokumente.oBBBBBBBBBBBBBBBB.freigaben, { 'm.mustermann': 'lesen' });
    assert.ok(of.zuletzt['m.mustermann'] && !of.zuletzt.mmustermann);
    const karte = namenErsetzen({ karten: { k1: { zustaendig: ['mmustermann', 'chef'], ersteller: 'mmustermann', kommentare: [{ wer: 'mmustermann', text: 'mmustermann bleibt im Text' }] } } }, await umbenennungenLaden(u.werkzeuge));
    assert.deepEqual(karte.karten.k1, { zustaendig: ['m.mustermann', 'chef'], ersteller: 'm.mustermann', kommentare: [{ wer: 'm.mustermann', text: 'mmustermann bleibt im Text' }] });
    assert.equal((await u.konfig.laden('links.json'))[0].nutzer, 'm.mustermann');
    // zurück und weiter: Ketten aufgelöst; ein neuer Nutzer mit altem Namen erbt keine Übersetzung
    await u.admin('nutzer.umbenennen', { name: 'm.mustermann', neu: 'max' });
    assert.deepEqual((await u.konfig.laden('users.json')).umbenennungen.map((x) => [x.alt, x.neu]), [['mmustermann', 'max'], ['m.mustermann', 'max']]);
    await u.admin('nutzer.anlegen', { name: 'mmustermann', passwort: PW, rolle: 'nutzer' });
    assert.deepEqual((await u.konfig.laden('users.json')).umbenennungen.map((x) => x.alt), ['m.mustermann']);
    await assert.rejects(u.admin('nutzer.umbenennen', { name: 'gibtsnicht', neu: 'x1' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('nutzer: umbenennen – schlägt usermod fehl, bleibt alles beim Alten (Samba-Eintrag kommt zurück)', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    const nt = u.scheins.samba.get('anna').nt;
    u.scheins.fehlschlag = (prog, args) => (prog === 'usermod' && args[0] === '-l' ? { code: 8, stderr: 'usermod: user anna is currently used by process 4711' } : null);
    await assert.rejects(u.admin('nutzer.umbenennen', { name: 'anna', neu: 'a.neu' }), (e) => e.code === 'E_SYSTEM');
    u.scheins.fehlschlag = null;
    assert.ok(u.scheins.passwd.has('anna') && !u.scheins.passwd.has('a.neu'));
    assert.equal(u.scheins.samba.get('anna').nt, nt);
    assert.deepEqual((await u.admin('nutzer.liste', {})).map((n) => n.name).sort(), ['anna', 'chef']);
  } finally { await u.aufraeumen(); }
});

test('nutzer: gruppen – anlegen, zuweisen, Mitglieder, löschen räumt Nutzer und Freigaben auf', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await assert.rejects(u.admin('nutzer.gruppe.anlegen', { name: 'chef' }), (e) => e.code === 'E_EXISTIERT');
    u.scheins.gruppen.set('docker', 998);
    await assert.rejects(u.admin('nutzer.gruppe.anlegen', { name: 'docker' }), (e) => e.code === 'E_PARAMS', 'reservierte Systemgruppe');
    u.scheins.gruppen.set('fremd', 999);
    await assert.rejects(u.admin('nutzer.gruppe.anlegen', { name: 'fremd' }), (e) => e.code === 'E_EXISTIERT');
    u.scheins.leeren();
    assert.deepEqual(await u.admin('nutzer.gruppe.anlegen', { name: 'familie' }), { name: 'familie', mitglieder: [] });
    assert.deepEqual(u.scheins.zeilen(), ['getent group familie', 'getent group familie', 'groupadd familie']);
    await assert.rejects(u.admin('nutzer.gruppe.anlegen', { name: 'familie' }), (e) => e.code === 'E_EXISTIERT');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'familie', passwort: PW, rolle: 'nutzer' }), (e) => e.code === 'E_EXISTIERT');
    await assert.rejects(u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['gibtsnicht'] }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['familie'] });
    assert.ok(u.scheins.zeilen().includes('useradd -M -s /usr/sbin/nologin -G fahnas-nutzer,familie anna'));
    u.scheins.leeren();
    await u.admin('nutzer.aendern', { name: 'chef', gruppen: ['familie'] });
    assert.deepEqual(u.scheins.zeilen(), ['getent group familie', 'id -nG chef', 'usermod -aG familie chef', 'getent passwd chef']);
    assert.deepEqual(await u.admin('nutzer.gruppen', {}), [{ name: 'familie', mitglieder: ['chef', 'anna'] }]);
    u.scheins.leeren();
    await u.admin('nutzer.aendern', { name: 'chef', gruppen: [] });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG chef', 'gpasswd -d chef familie', 'getent passwd chef']);
    await u.admin('freigaben.anlegen', { name: 'fotos', lesen: ['@familie'], schreiben: ['chef'], papierkorb: false });
    u.scheins.leeren();
    await u.admin('nutzer.gruppe.loeschen', { name: 'familie' });
    assert.ok(u.scheins.zeilen().includes('groupdel familie'));
    assert.deepEqual((await u.admin('nutzer.liste', {})).find((n) => n.name === 'anna').gruppen, []);
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben[0].lesen, []);
    assert.ok(!(await fs.readFile(path.join(u.pfade.samba, 'fotos.conf'), 'utf8')).includes('@familie'));
    await assert.rejects(u.admin('nutzer.gruppe.loeschen', { name: 'familie' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('nutzer: TOTP – einrichten, bestätigen, prüfen, Replay, Wiederherstellungscode einmalig, entfernen', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    await u.konfig.aendern('system.json', (s) => { s.hostname = 'box'; });
    const anna = u.als('anna');
    await assert.rejects(anna('nutzer.totp.einrichten', { name: 'chef', passwort: PW }), (e) => e.code === 'E_RECHTE');
    await assert.rejects(anna('nutzer.totp.bestaetigen', { name: 'anna', code: '123456' }), (e) => e.code === 'E_TOTP');
    // Einrichten verlangt das eigene Passwort (R1 Fund 10) – ohne oder falsch: nichts wird angelegt
    await assert.rejects(anna('nutzer.totp.einrichten', { name: 'anna' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    await assert.rejects(anna('nutzer.totp.einrichten', { name: 'anna', passwort: 'falsch' }), (e) => e.code === 'E_ANMELDUNG');
    assert.equal((await u.konfig.laden('users.json')).nutzer.find((n) => n.name === 'anna').totp_ausstehend, undefined);
    const { geheimnis, uri } = await anna('nutzer.totp.einrichten', { name: 'anna', passwort: PW });
    assert.match(geheimnis, /^[A-Z2-7]{32}$/);
    assert.equal(uri, `otpauth://totp/FAH-NAS:anna@box?secret=${geheimnis}&issuer=FAH-NAS&algorithm=SHA1&digits=6&period=30`);
    assert.equal((await u.system('nutzer.pruefen', { name: 'anna', passwort: PW })).totp_noetig, false, 'noch nicht scharf');
    await assert.rejects(anna('nutzer.totp.bestaetigen', { name: 'anna', code: '000000' }), (e) => e.code === 'E_TOTP');
    const code = totp.totp(geheimnis);
    const { wiederherstellungscodes } = await anna('nutzer.totp.bestaetigen', { name: 'anna', code });
    assert.equal(wiederherstellungscodes.length, 8);
    const gespeichert = (await u.konfig.laden('users.json')).nutzer.find((n) => n.name === 'anna');
    assert.equal(gespeichert.totp.geheimnis, geheimnis);
    assert.equal(gespeichert.totp_ausstehend, undefined);
    assert.ok(gespeichert.totp.wiederherstellung.every((h) => h.startsWith('scrypt$')), 'Codes nur als Hash');
    { const r = await u.system('nutzer.pruefen', { name: 'anna', passwort: PW }); delete r.anzeigename; assert.deepEqual(r, { ok: true, rolle: 'nutzer', totp_noetig: true, totp: true }); }
    assert.equal((await u.admin('nutzer.liste', {})).find((n) => n.name === 'anna').totp, true);
    // derselbe Code wie bei der Bestätigung → Replay abgelehnt; nächster Schritt geht
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code }), { ok: false });
    const naechster = totp.totp(geheimnis, Date.now() / 1000 + 30);
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code: naechster }), { ok: true });
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code: naechster }), { ok: false }, 'zweimal derselbe Code');
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code: '999999' }), { ok: false });
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'chef', code: '123456' }), { ok: false }, 'ohne TOTP');
    // Wiederherstellungscode: einmal ja, zweites Mal nein
    const wc = wiederherstellungscodes[2];
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code: wc.toUpperCase() }), { ok: true, wiederherstellung: true, verbleibend: 7 });
    assert.deepEqual(await u.system('nutzer.totp.pruefen', { name: 'anna', code: wc }), { ok: false });
    assert.equal((await u.konfig.laden('users.json')).nutzer.find((n) => n.name === 'anna').totp.wiederherstellung.length, 7);
    // aktive 2FA: Neueinrichtung tauscht das Geheimnis NUR mit Passwort (P15 – gestohlene Sitzung kann es nicht)
    await assert.rejects(anna('nutzer.totp.einrichten', { name: 'anna' }), (e) => e.code === 'E_PARAMS');
    assert.equal((await u.konfig.laden('users.json')).nutzer.find((n) => n.name === 'anna').totp.geheimnis, geheimnis, 'Geheimnis unverändert');
    // entfernen: ohne Passwort, falsches Passwort, dann richtig
    await assert.rejects(anna('nutzer.totp.entfernen', { name: 'anna' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    await assert.rejects(anna('nutzer.totp.entfernen', { name: 'anna', passwort: 'falsch' }), (e) => e.code === 'E_ANMELDUNG');
    assert.deepEqual(await anna('nutzer.totp.entfernen', { name: 'anna', passwort: PW }), { name: 'anna', totp: false });
    assert.equal((await u.system('nutzer.pruefen', { name: 'anna', passwort: PW })).totp_noetig, false);
    // Admin darf für andere entfernen – mit dem eigenen Passwort
    await anna('nutzer.totp.einrichten', { name: 'anna', passwort: PW });
    await assert.rejects(u.admin('nutzer.totp.entfernen', { name: 'anna', passwort: 'falsch' }), (e) => e.code === 'E_ANMELDUNG');
    await u.admin('nutzer.totp.entfernen', { name: 'anna', passwort: PW });
    assert.equal((await u.konfig.laden('users.json')).nutzer.find((n) => n.name === 'anna').totp_ausstehend, undefined);
    // Notfallweg (R1 Fund 13): die Konsole (Kommandozeile als root) entfernt 2FA ohne Passwort
    const e2 = await anna('nutzer.totp.einrichten', { name: 'anna', passwort: PW });
    await anna('nutzer.totp.bestaetigen', { name: 'anna', code: totp.totp(e2.geheimnis) });
    assert.equal((await u.admin('nutzer.liste', {})).find((n) => n.name === 'anna').totp, true);
    const konsole = (aktion, params) => u.rufen(aktion, params, { nutzer: 'konsole', rolle: 'admin', ip: '-' });
    assert.deepEqual(await konsole('nutzer.totp.entfernen', { name: 'anna' }), { name: 'anna', totp: false });
    assert.equal((await u.admin('nutzer.liste', {})).find((n) => n.name === 'anna').totp, false);
  } finally { await u.aufraeumen(); }
});

test('nutzer: kein Lost Update – Login (letzte_anmeldung) parallel zu nutzer.anlegen verliert keinen Nutzer (P1b)', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    const anlegen = u.admin('nutzer.anlegen', { name: 'bert', passwort: PW, rolle: 'nutzer' });
    await new Promise((r) => setTimeout(r, 40)); // Login startet mitten im Anlegen (scrypt läuft ~50–100 ms)
    const login = u.system('nutzer.pruefen', { name: 'anna', passwort: PW });
    const [a, l] = await Promise.all([anlegen, login]);
    assert.equal(a.name, 'bert'); assert.equal(l.ok, true);
    const users = await u.konfig.laden('users.json');
    assert.deepEqual(users.nutzer.map((n) => n.name).sort(), ['anna', 'bert', 'chef']);
    assert.ok(users.nutzer.find((n) => n.name === 'anna').letzte_anmeldung, 'letzte_anmeldung geschrieben');
    // fünf parallele Anlagen: alle fünf sind danach da
    await Promise.all(['c1', 'c2', 'c3', 'c4', 'c5'].map((n) => u.admin('nutzer.anlegen', { name: n, passwort: PW, rolle: 'nutzer' })));
    assert.equal((await u.konfig.laden('users.json')).nutzer.length, 8);
    assert.equal(((await fs.stat(path.join(u.pfade.konfig, 'users.json'))).mode & 0o777), 0o600);
  } finally { await u.aufraeumen(); }
});

test('nutzer: gesperrter Admin verliert fahnas-admin und die Anmeldeshell, Entsperren gibt beides zurück', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'admin' });
    assert.equal(u.scheins.passwd.get('anna').shell, '/bin/bash');
    u.scheins.leeren();
    await u.admin('nutzer.aendern', { name: 'anna', gesperrt: true });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG anna', 'gpasswd -d anna fahnas-admin', 'getent passwd anna', 'usermod -s /usr/sbin/nologin anna', 'usermod -L anna', 'smbpasswd -d anna']);
    u.scheins.leeren();
    await u.admin('nutzer.aendern', { name: 'anna', gesperrt: false });
    assert.deepEqual(u.scheins.zeilen(), ['id -nG anna', 'usermod -aG fahnas-admin anna', 'getent passwd anna', 'usermod -s /bin/bash anna', 'usermod -U anna', 'smbpasswd -e anna']);
  } finally { await u.aufraeumen(); }
});

test('nutzer: apply baut nach „Neuinstallation“ alles mit alten uids wieder auf; zweiter Lauf nur Prüfungen', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.gruppe.anlegen', { name: 'familie' });
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['familie'] });
    await u.admin('nutzer.anlegen', { name: 'bert', passwort: PW, rolle: 'nutzer' });
    await u.admin('nutzer.aendern', { name: 'bert', gesperrt: true });
    const uids = Object.fromEntries((await u.admin('nutzer.liste', {})).map((n) => [n.name, n.uid]));
    // Neuinstallation: Systempartition weg (Linux-Konten, Gruppen), Samba-Datenbank liegt auf der Datenpartition
    u.scheins.passwd.clear(); u.scheins.gruppen.clear(); u.scheins.passwoerter.clear(); u.scheins.naechsteUid = 1001; u.scheins.naechsteGid = 1001;
    u.scheins.passwd.set('eindringling', { uid: uids.bert, gid: uids.bert, gruppen: new Set(), gesperrt: false }); // uid von bert vergeben
    u.scheins.leeren();
    const r = await u.system('nutzer.apply', {});
    assert.deepEqual(r.gruppen_angelegt, ['fahnas-nutzer', 'fahnas-admin', 'familie']);
    assert.deepEqual(r.angelegt, ['chef', 'anna', 'bert']);
    const z = u.scheins.zeilen();
    assert.ok(z.includes(`useradd -M -s /usr/sbin/nologin -G fahnas-nutzer,fahnas-admin -u ${uids.chef} chef`));
    assert.ok(z.includes(`useradd -M -s /usr/sbin/nologin -G fahnas-nutzer,familie -u ${uids.anna} anna`));
    assert.ok(z.includes(`useradd -M -s /usr/sbin/nologin -G fahnas-nutzer -u ${uids.bert} bert`), 'erst mit alter uid …');
    assert.ok(z.includes('useradd -M -s /usr/sbin/nologin -G fahnas-nutzer bert'), '… dann ohne, weil vergeben');
    assert.ok(r.warnungen.some((w) => w.includes('bert') && w.includes('uid')));
    assert.ok(!z.some((x) => x.startsWith('chpasswd') || x.startsWith('smbpasswd -a')), 'Passwörter kann apply nicht setzen');
    assert.ok(!z.some((x) => x.startsWith('smbpasswd -d')), 'bert ist in Samba schon gesperrt');
    assert.equal(u.scheins.passwd.get('chef').uid, uids.chef);
    assert.notEqual((await u.admin('nutzer.liste', {})).find((n) => n.name === 'bert').uid, uids.bert, 'neue uid gespeichert');
    // Samba-Konto fehlt → Warnung statt Fehler
    u.scheins.samba.delete('anna');
    u.scheins.leeren();
    const r2 = await u.system('nutzer.apply', {});
    assert.ok(r2.warnungen.some((w) => w.includes('anna') && w.includes('Samba')));
    assert.deepEqual(r2.angelegt, []); assert.deepEqual(r2.angepasst, []);
    const nurPruefungen = u.scheins.zeilen().every((x) => /^(getent |id -nG |pdbedit -L -v)/.test(x));
    assert.ok(nurPruefungen, `zweiter Lauf soll nur prüfen: ${u.scheins.zeilen().join(' | ')}`);
    // Sperre in Samba von Hand aufgehoben → apply stellt sie wieder her
    u.scheins.samba.get('bert').aktiv = true;
    u.scheins.leeren();
    const r3 = await u.system('nutzer.apply', {});
    assert.deepEqual(r3.angepasst, ['bert']);
    assert.ok(u.scheins.zeilen().includes('smbpasswd -d bert'));
  } finally { await u.aufraeumen(); }
});

test('nutzer: einstellungen – eigener Bereich lesen/setzen/löschen, fremde nur Admin, Größe begrenzt', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    const anna = u.als('anna');
    assert.deepEqual(await anna('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'uebersicht' }), { bereich: 'uebersicht', wert: null });
    const layout = { kacheln: [{ id: 'cpu', breite: 2 }, { id: 'ram', breite: 1 }] };
    assert.deepEqual(await anna('nutzer.einstellungen.setzen', { name: 'anna', bereich: 'uebersicht', wert: layout }), { bereich: 'uebersicht', wert: layout });
    assert.deepEqual((await anna('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'uebersicht' })).wert, layout);
    await assert.rejects(anna('nutzer.einstellungen.lesen', { name: 'chef', bereich: 'uebersicht' }), (e) => e.code === 'E_RECHTE');
    assert.deepEqual((await u.admin('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'uebersicht' })).wert, layout);
    await assert.rejects(anna('nutzer.einstellungen.setzen', { name: 'anna', bereich: 'Uebersicht', wert: {} }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(anna('nutzer.einstellungen.setzen', { name: 'anna', bereich: 'gross', wert: { t: 'x'.repeat(33 * 1024) } }), (e) => e.code === 'E_PARAMS');
    // Bereich „weltkarte“ (Richtung der Weltkarte in der Übersicht) liegt unabhängig neben „uebersicht“
    assert.deepEqual(await anna('nutzer.einstellungen.setzen', { name: 'anna', bereich: 'weltkarte', wert: { richtung: 'ein' } }), { bereich: 'weltkarte', wert: { richtung: 'ein' } });
    assert.deepEqual((await anna('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'weltkarte' })).wert, { richtung: 'ein' });
    assert.deepEqual((await anna('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'uebersicht' })).wert, layout, 'Kachel-Anordnung bleibt');
    assert.deepEqual(await anna('nutzer.einstellungen.setzen', { name: 'anna', bereich: 'uebersicht' }), { bereich: 'uebersicht', wert: null });
    assert.deepEqual((await anna('nutzer.einstellungen.lesen', { name: 'anna', bereich: 'weltkarte' })).wert, { richtung: 'ein' }, 'Löschen der Anordnung lässt die Richtung stehen');
    // Hashes bleiben unangetastet, Liste zeigt keine Einstellungen
    const liste = await u.admin('nutzer.liste', {});
    assert.ok(liste.every((n) => n.hash === undefined && n.einstellungen === undefined));
  } finally { await u.aufraeumen(); }
});

test('nutzer: loeschen und gruppe.loeschen entfernen den Namen aus „sichtbar für“ der Apps (Abschlussprüfung Plan 07, Befund 4)', async () => {
  const u = await werkzeugeBauen({ module: MODULE });
  try {
    await chefAnlegen(u);
    await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
    await u.admin('nutzer.gruppe.anlegen', { name: 'familie' });
    await u.konfig.speichern('apps/gitea/app.json', { name: 'gitea', titel: 'Gitea', sichtbar_fuer: ['@familie', 'anna', 'chef'] });
    await u.konfig.speichern('apps/jelly/app.json', { name: 'jelly', titel: 'Jelly', sichtbar_fuer: ['chef'] });
    await u.admin('nutzer.loeschen', { name: 'anna', dateien: 'behalten' });
    assert.deepEqual((await u.konfig.laden('apps/gitea/app.json')).sichtbar_fuer, ['@familie', 'chef']);
    await u.admin('nutzer.gruppe.loeschen', { name: 'familie' });
    assert.deepEqual((await u.konfig.laden('apps/gitea/app.json')).sichtbar_fuer, ['chef']);
    assert.deepEqual((await u.konfig.laden('apps/jelly/app.json')).sichtbar_fuer, ['chef'], 'andere Apps unberührt');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'apps'));
  } finally { await u.aufraeumen(); }
});
