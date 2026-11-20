// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordnerrechte (0.23.0): Regeln (wer ist wo wie eingeschränkt), Soll-ACL je Bereich, Aktionen freigaben.ordnerrechte.*,
// Sperren in den Datei-Aktionen, Regelpfade beim Umbenennen/Löschen, Ansichten (WebDAV/DLNA) und der Ordnergrößen-Fix.
// Der Abgleich mit der Platte (root, /proc/self/fd) läuft im Integrationstest auf Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import * as or from '../../src/agent/freigaben/ordnerrechte.js';
import { getfaclParsen, gleicheAcl, sollFuerArt } from '../../src/agent/freigaben/ordnerrechte-abgleich.js';
import { registriere as dateienRegistrieren } from '../../src/agent/aktionen/dateien.js';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import { ueberAnsichten, dlnaGesperrt, mountinfoTypen, ansichtenPlan } from '../../src/agent/protokolle/regeln.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';

const USERS = {
  nutzer: [
    { name: 'chef', rolle: 'admin', uid: 1000, gruppen: ['work'] },
    { name: 'anna', rolle: 'nutzer', uid: 1001, gruppen: ['work'] },
    { name: 'bert', rolle: 'nutzer', uid: 1002, gruppen: ['work'] },
    { name: 'carl', rolle: 'nutzer', uid: 1003, gruppen: [] },
  ],
  gruppen: [{ name: 'work' }, { name: 'leer' }],
};

// ---------------------------------------------------------------------------------------------------------------
// Regeln
// ---------------------------------------------------------------------------------------------------------------
test('ordnerrechte: strengste Regel gilt, Gruppe trifft Mitglieder, Admins nie', () => {
  const f = { name: 'w', schreiben: ['@work', 'carl'], ordnerrechte: [
    { pfad: 'Kunden', regeln: { '@work': 'lesen' } },
    { pfad: 'Kunden/Zugang', regeln: { anna: 'keiner' } },
  ] };
  assert.equal(or.einschraenkung(f, USERS, 'anna', 'Kunden'), 'lesen');
  assert.equal(or.einschraenkung(f, USERS, 'anna', 'Kunden/Zugang/x.pdf'), 'keiner');
  assert.equal(or.einschraenkung(f, USERS, 'bert', 'Kunden/Zugang'), 'lesen');
  assert.equal(or.einschraenkung(f, USERS, 'carl', 'Kunden/Zugang'), null);
  assert.equal(or.einschraenkung(f, USERS, 'chef', 'Kunden/Zugang'), null, 'Admins sind nie eingeschränkt');
  assert.equal(or.einschraenkung(f, USERS, 'anna', 'Kundenliste'), null, 'Präfix ohne „/“ zählt nicht');
  assert.deepEqual(or.bereicheFuer(f, USERS, 'anna'), [{ pfad: 'Kunden', stufe: 'lesen' }, { pfad: 'Kunden/Zugang', stufe: 'keiner' }]);
  assert.equal(or.stufeAn(or.bereicheFuer(f, USERS, 'anna'), 'Kunden/Zugang/a/b'), 'keiner');
  assert.throws(() => or.sperrePruefen(or.bereicheFuer(f, USERS, 'anna'), 'Kunden/Zugang'), (e) => e.code === 'E_RECHTE' && e.details.gesperrt === true);
  assert.throws(() => or.sperrePruefen(or.bereicheFuer(f, USERS, 'bert'), 'Kunden/neu', true), (e) => e.code === 'E_RECHTE' && e.details.nur_lesen === true);
  assert.doesNotThrow(() => or.sperrePruefen(or.bereicheFuer(f, USERS, 'bert'), 'Kunden/neu', false));
  assert.equal(or.gastStufe(f, 'Kunden/Zugang'), 'keiner');
});

test('ordnerrechte: Soll-ACL – eigener user:-Eintrag je eingeschränktem Mitglied, Gruppe begrenzt, Dateien ohne x', () => {
  const f = { name: 'w', schreiben: ['@work', 'anna'], lesen: ['carl'], gaeste: true, ordnerrechte: [{ pfad: 'Geheim', regeln: { '@work': 'keiner', carl: 'lesen' } }] };
  const basis = ['user::rwx', 'group::---', 'other::---', 'mask::rwx', 'group:fahnas-admin:rwx', 'group:work:rwx', 'user:anna:rwx', 'user:carl:r-x', 'user:nobody:rwx'];
  const acl = or.bereichAcl(basis, f, USERS, 'Geheim/x', { gastkonto: 'nobody' });
  const zugriff = acl.ordner.filter((z) => !z.startsWith('default:'));
  assert.ok(zugriff.includes('user:anna:---'), 'persönliches Recht wird von der Gruppenregel übersteuert');
  assert.ok(zugriff.includes('user:bert:---'));
  assert.ok(zugriff.includes('user:carl:r-x'));
  assert.ok(zugriff.includes('group:work:---'));
  assert.ok(zugriff.includes('group:fahnas-admin:rwx'), 'Admins bleiben voll');
  assert.ok(!zugriff.some((z) => z.startsWith('user:chef:')), 'Admin bekommt keinen eigenen Eintrag');
  assert.ok(zugriff.includes('user:nobody:---'), 'Gastkonto bekommt die strengste Stufe');
  assert.ok(acl.ordner.includes('default:user:anna:---'));
  assert.ok(acl.datei.includes('user:carl:r-x') && acl.datei.includes('mask::rw-') && acl.datei.includes('user::rw-'), 'Datei wie vom Kernel geerbt: Maske ohne x');
  assert.ok(acl.dateiX.includes('user:carl:r-x'));
  assert.deepEqual([...acl.eingeschraenkt].sort(), ['anna', 'bert', 'carl']);
  // ohne greifende Regel = Rechte der Freigabe (Zurücksetzen)
  const ohne = or.bereichAcl(basis, f, USERS, 'Anderes', { gastkonto: 'nobody' });
  assert.ok(ohne.ordner.includes('user:anna:rwx') && !ohne.ordner.some((z) => z.startsWith('user:bert')));
  assert.equal(ohne.eingeschraenkt.size, 0);
});

test('ordnerrechte: Prüfen, Umziehen, Entfernen, Konto entfernen', () => {
  assert.deepEqual(or.regelnPruefen({ anna: 'keiner', '@work': 'lesen', bert: '' }, USERS), { anna: 'keiner', '@work': 'lesen' });
  assert.throws(() => or.regelnPruefen({ chef: 'keiner' }, USERS), (e) => e.code === 'E_PARAMS' && /Admin/.test(e.message));
  assert.throws(() => or.regelnPruefen({ niemand: 'keiner' }, USERS), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.throws(() => or.regelnPruefen({ '@gibtsnicht': 'lesen' }, USERS), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.throws(() => or.regelnPruefen({ anna: 'schreiben' }, USERS), (e) => e.code === 'E_PARAMS');
  const liste = [{ pfad: 'A', regeln: { anna: 'keiner' } }, { pfad: 'A/B', regeln: { bert: 'lesen' } }, { pfad: 'AB', regeln: { carl: 'lesen' } }];
  assert.deepEqual(or.regelnUmziehen(liste, 'A', 'X').map((r) => r.pfad), ['AB', 'X', 'X/B']);
  assert.equal(or.regelnUmziehen(liste, 'Q', 'X'), null);
  assert.deepEqual(or.regelnOhne(liste, ['A']).map((r) => r.pfad), ['AB']);
  assert.equal(or.regelnOhne(liste, ['C']), null);
  assert.deepEqual(or.kontoOhne(liste, 'bert').map((r) => r.pfad), ['A', 'AB'], 'leer gewordene Regel fällt weg');
});

test('ordnerrechte: getfacl lesen und vergleichen, Soll je Art', () => {
  const text = '# file: /proc/1/fd/7\n# owner: anna\n# group: fahnas-nutzer\n# flags: -s-\nuser::rwx\nuser:bert:r-x\t\t#effective:r-x\ngroup::---\nmask::rwx\nother::---\n\n# file: /proc/1/fd/8\n# owner: root\nuser::rw-\ngroup::r--\nother::r--\n\n';
  const m = getfaclParsen(text);
  assert.equal(m.get('/proc/1/fd/7').besitzer, 'anna');
  assert.deepEqual(m.get('/proc/1/fd/7').eintraege, ['user::rwx', 'user:bert:r-x', 'group::---', 'mask::rwx', 'other::---']);
  assert.ok(gleicheAcl(m.get('/proc/1/fd/7').eintraege, ['other::---', 'mask::rwx', 'group::---', 'user:bert:r-x', 'user::rwx']));
  assert.ok(!gleicheAcl(m.get('/proc/1/fd/8').eintraege, ['user::rw-']));
  const soll = { ordner: ['o'], datei: ['d'], dateiX: ['x'] };
  assert.deepEqual(sollFuerArt(soll, { isDirectory: () => true, mode: 0o40770 }), ['o']);
  assert.deepEqual(sollFuerArt(soll, { isDirectory: () => false, mode: 0o100660 }), ['d']);
  assert.deepEqual(sollFuerArt(soll, { isDirectory: () => false, mode: 0o100770 }), ['x']);
});

test('ordnerrechte: Über-Einhängungen in den Ansichten und DLNA, mountinfo mit Leerzeichen', () => {
  const shares = { freigaben: [{ name: 'w', pfad: '/data/shares/w', schreiben: ['@work', 'carl'], lesen: [], ordnerrechte: [
    { pfad: 'Kunden', regeln: { bert: 'lesen' } }, { pfad: 'Kunden/Zugang', regeln: { bert: 'keiner', carl: 'lesen' } }, { pfad: 'Privat', regeln: { anna: 'keiner' } },
  ] }] };
  const plan = ansichtenPlan(USERS, shares);
  const ueber = ueberAnsichten(USERS, shares, plan);
  assert.deepEqual(ueber.filter((u) => u.rel.startsWith('bert/')), [{ rel: 'bert/w/Kunden', art: 'lesen' }, { rel: 'bert/w/Kunden/Zugang', art: 'gesperrt' }]);
  assert.deepEqual(ueber.filter((u) => u.rel.startsWith('anna/')), [{ rel: 'anna/w/Privat', art: 'gesperrt' }]);
  assert.deepEqual(ueber.filter((u) => u.rel.startsWith('carl/')), [{ rel: 'carl/w/Kunden/Zugang', art: 'lesen' }]);
  assert.ok(!ueber.some((u) => u.rel.startsWith('chef/')), 'Admins ohne Über-Einhängung');
  assert.deepEqual(dlnaGesperrt(shares.freigaben[0]), ['Kunden/Zugang', 'Privat']);
  const info = '100 30 0:55 / /run/fahnas-ansicht/bert/w/Kunden\\040A rw,relatime shared:1 - tmpfs fahnas-gesperrt ro,size=4k\n101 30 0:30 /@shares/w /run/fahnas-ansicht/bert/w ro,relatime - btrfs /dev/sda4 rw\n';
  const m = mountinfoTypen(info, ['/run/fahnas-ansicht']);
  assert.deepEqual(m.get('/run/fahnas-ansicht/bert/w/Kunden A'), { ro: false, typ: 'tmpfs', quelle: 'fahnas-gesperrt' });
  assert.equal(m.get('/run/fahnas-ansicht/bert/w').typ, 'btrfs');
});

// ---------------------------------------------------------------------------------------------------------------
// Aktionen freigaben.ordnerrechte.* (Abgleich mit der Platte als Attrappe)
// ---------------------------------------------------------------------------------------------------------------
const PW = 'sehr-geheim-123';
async function grundlage() {
  const u = await werkzeugeBauen({ module: [nutzer, freigaben] });
  await u.system('nutzer.anlegen', { name: 'chef', passwort: PW, rolle: 'admin' });
  await u.admin('nutzer.gruppe.anlegen', { name: 'work' });
  await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer', gruppen: ['work'] });
  await u.admin('nutzer.anlegen', { name: 'bert', passwort: PW, rolle: 'nutzer', gruppen: ['work'] });
  await u.admin('freigaben.anlegen', { name: 'working', schreiben: ['@work', 'anna'] });
  await fs.mkdir(path.join(u.pfade.shares, 'working', 'Zugangsdaten'), { recursive: true });
  const abgleiche = [];
  u.werkzeuge.ordnerrechteAbgleich = async (_sys, a) => { abgleiche.push(a); return { fehlt: false, geprueft: 3, geaendert: 2, besitz: 0, gruendlich: !a.nurWurzel }; };
  u.scheins.leeren(); u.ereignisse.length = 0;
  return { u, abgleiche };
}

test('freigaben.ordnerrechte: setzen speichert, gleicht ab (gründlich ab dem Ordner), lesen/liste zeigen es', async () => {
  const { u, abgleiche } = await grundlage();
  try {
    const r = await u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'Zugangsdaten', regeln: { '@work': 'keiner' } });
    assert.equal(r.geaendert, 2);
    const f = (await u.konfig.laden('shares.json')).freigaben.find((x) => x.name === 'working');
    assert.deepEqual(f.ordnerrechte, [{ pfad: 'Zugangsdaten', regeln: { '@work': 'keiner' } }]);
    assert.equal(abgleiche.length, 1);
    assert.equal(abgleiche[0].start, 'Zugangsdaten'); assert.equal(abgleiche[0].nurWurzel, false);
    const soll = abgleiche[0].sollFuer('Zugangsdaten/x');
    assert.ok(soll.ordner.includes('user:anna:---') && soll.ordner.includes('user:bert:---'));
    assert.ok(soll.eingeschraenktUids.size === 2, 'Besitz von anna und bert geht an root');
    assert.ok(u.ereignisse.some((e) => e.bereich === 'freigaben'));

    const info = await u.admin('freigaben.ordnerrechte.lesen', { freigabe: 'working', pfad: 'Zugangsdaten' });
    assert.deepEqual(info.regeln, { '@work': 'keiner' });
    assert.deepEqual(info.admins, ['chef']);
    assert.ok(info.konten.some((k) => k.konto === '@work' && k.art === 'gruppe' && k.mitglieder.includes('anna')));
    assert.ok(info.konten.some((k) => k.konto === 'anna' && k.recht === 'schreiben'));
    const unten = await u.admin('freigaben.ordnerrechte.lesen', { freigabe: 'working', pfad: 'Zugangsdaten/Alt' });
    assert.deepEqual(unten.geerbt['@work'], { stufe: 'keiner', von: 'Zugangsdaten' });

    const liste = await u.admin('freigaben.ordnerrechte.liste', {});
    assert.deepEqual(liste.ordnerrechte, [{ freigabe: 'working', pfad: 'Zugangsdaten', regeln: { '@work': 'keiner' }, vorhanden: true }]);
    const fl = await u.admin('freigaben.liste', {});
    assert.deepEqual(fl.find((x) => x.name === 'working').ordnerrechte, [{ pfad: 'Zugangsdaten', regeln: { '@work': 'keiner' } }]);
    const flNutzer = await u.als('anna')('freigaben.liste', {});
    assert.equal(flNutzer.find((x) => x.name === 'working').ordnerrechte, undefined, 'Nutzer sehen die Regeln nicht');

    // schneller Abgleich beim Rendern (nur Wurzel), stündlicher gründlich
    abgleiche.length = 0;
    await u.system('freigaben.apply', {});
    assert.ok(abgleiche.length === 1 && abgleiche[0].nurWurzel === true);
    abgleiche.length = 0;
    const st = await u.system('freigaben.ordnerrechte.apply', { gruendlich: true });
    assert.equal(st.bereiche, 1); assert.ok(abgleiche[0].nurWurzel === false);
    assert.ok((await u.admin('freigaben.ordnerrechte.liste', {})).letzter_abgleich.gruendlich);

    // entfernen: Bereich bekommt die Rechte der Freigabe zurück
    abgleiche.length = 0;
    await u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'Zugangsdaten', regeln: {} });
    assert.equal((await u.konfig.laden('shares.json')).freigaben.find((x) => x.name === 'working').ordnerrechte, undefined);
    assert.equal(abgleiche[0].start, 'Zugangsdaten');
    const zurueck = abgleiche[0].sollFuer('Zugangsdaten');
    assert.ok(zurueck.ordner.includes('user:anna:rwx') && !zurueck.ordner.some((z) => z.startsWith('user:bert')));
  } finally { await u.aufraeumen(); }
});

test('freigaben.ordnerrechte: Ablehnungen, Gruppe/Nutzer löschen räumt Regeln auf', async () => {
  const { u } = await grundlage();
  try {
    await assert.rejects(u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: '', regeln: { anna: 'keiner' } }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'gibtsnicht', regeln: { anna: 'keiner' } }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await assert.rejects(u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'Zugangsdaten', regeln: { chef: 'keiner' } }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: '../x', regeln: { anna: 'keiner' } }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.als('anna')('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'Zugangsdaten', regeln: {} }), (e) => e.code === 'E_RECHTE');
    await u.admin('freigaben.ordnerrechte.setzen', { freigabe: 'working', pfad: 'Zugangsdaten', regeln: { bert: 'lesen', '@work': 'keiner' } });
    await u.admin('nutzer.loeschen', { name: 'bert', dateien: 'behalten' });
    assert.deepEqual((await u.konfig.laden('shares.json')).freigaben[0].ordnerrechte, [{ pfad: 'Zugangsdaten', regeln: { '@work': 'keiner' } }]);
    await u.admin('nutzer.gruppe.loeschen', { name: 'work' });
    assert.equal((await u.konfig.laden('shares.json')).freigaben[0].ordnerrechte, undefined);
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Datei-Aktionen: Sperren, Markierungen, Regelpfade, Ordnergröße
// ---------------------------------------------------------------------------------------------------------------
async function dateienUmgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-ordnerrechte-'));
  const shares = path.join(w, 'shares');
  const konfig = new Konfig(path.join(w, 'config'));
  await konfig.sicherstellen();
  await konfig.speichern('users.json', USERS);
  await konfig.speichern('shares.json', { freigaben: [{ name: 'working', schreiben: ['@work', 'carl'], lesen: [], papierkorb: false, ordnerrechte: [
    { pfad: 'Privat', regeln: { '@work': 'keiner' } }, { pfad: 'Archiv', regeln: { carl: 'lesen' } },
  ] }] });
  for (const d of ['working/Privat', 'working/Archiv', 'working/Offen/Leer']) await fs.mkdir(path.join(shares, d), { recursive: true });
  const intern = [];
  const sys = {
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined });
      return { code: 0, stdout: '', stderr: '' };
    },
    starten(prog, args, opt = {}) { return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined }); },
    async nutzerIds(name) { const n = USERS.nutzer.find((x) => x.name === name); return { uid: n.uid, gid: 100 }; },
  };
  const werkzeuge = {
    konfig, system: sys, pfade: { shares, snapshots: path.join(w, 'snap'), konfig: konfig.ordner }, audit: { eintrag() {} },
    datenkanal: { ticket: (d) => ({ ticket: 't', ...d }) }, konfigGeaendert() {}, intern: async (a, p) => { intern.push([a, p]); return {}; },
  };
  const reg = new Register(); dateienRegistrieren(reg, werkzeuge);
  const als = (n) => async (aktion, params) => {
    const kontext = { nutzer: n, rolle: n === 'chef' ? 'admin' : 'nutzer', ip: '-' };
    const { aktion: a, params: p } = reg.vorbereiten(aktion, params, kontext);
    return a.ausfuehren(p, kontext, werkzeuge, { fortschritt() {}, abgebrochen: () => false });
  };
  return { w, shares, konfig, als, intern, aufraeumen: () => fs.rm(w, { recursive: true, force: true }) };
}

test('dateien: gesperrte Ordner bleiben sichtbar, Zugriff → „Nicht für dich freigegeben“, nur lesen sperrt Schreiben', async () => {
  const u = await dateienUmgebung();
  try {
    const anna = await u.als('anna')('dateien.liste', { freigabe: 'working', pfad: '' });
    const privat = anna.eintraege.find((e) => e.name === 'Privat');
    assert.equal(privat.gesperrt, true, 'Ordner bleibt in der Liste, aber gesperrt');
    assert.equal(anna.eintraege.find((e) => e.name === 'Archiv').gesperrt, undefined);
    await assert.rejects(u.als('anna')('dateien.liste', { freigabe: 'working', pfad: 'Privat' }), (e) => e.code === 'E_RECHTE' && e.details.gesperrt === true && e.message === 'Nicht für dich freigegeben');
    await assert.rejects(u.als('anna')('dateien.ordnergroesse', { freigabe: 'working', pfad: 'Privat' }), (e) => e.details.gesperrt === true);
    await assert.rejects(u.als('anna')('dateien.ticket', { freigabe: 'working', pfad: 'Privat', art: 'zip' }), (e) => e.details.gesperrt === true);
    await assert.rejects(u.als('anna')('dateien.umbenennen', { freigabe: 'working', pfad: 'Privat', neuer_name: 'X' }), (e) => e.details.gesperrt === true);
    await assert.rejects(u.als('anna')('dateien.link.anlegen', { freigabe: 'working', pfad: 'Privat/a', gueltig_h: 1 }), (e) => e.details.gesperrt === true);

    const carl = await u.als('carl')('dateien.liste', { freigabe: 'working', pfad: '' });
    assert.equal(carl.eintraege.find((e) => e.name === 'Archiv').nur_lesen, true);
    const archiv = await u.als('carl')('dateien.liste', { freigabe: 'working', pfad: 'Archiv' });
    assert.equal(archiv.schreiben, false); assert.equal(archiv.nur_lesen_ordner, true);
    await assert.rejects(u.als('carl')('dateien.ordner', { freigabe: 'working', pfad: 'Archiv', name: 'neu' }), (e) => e.details.nur_lesen === true);
    await assert.rejects(u.als('carl')('dateien.loeschen', { freigabe: 'working', pfade: ['Archiv'] }), (e) => e.details.nur_lesen === true);
    await assert.rejects(u.als('carl')('dateien.text.speichern', { freigabe: 'working', pfad: 'Archiv/a.txt', inhalt: 'x', neu: true }), (e) => e.details.nur_lesen === true);
    await u.als('carl')('dateien.ordner', { freigabe: 'working', pfad: 'Offen', name: 'neu' }); // außerhalb geht alles

    const chef = await u.als('chef')('dateien.liste', { freigabe: 'working', pfad: '' });
    assert.equal(chef.eintraege.find((e) => e.name === 'Privat').ordnerrecht, true, 'Admins sehen, wo eigene Rechte gelten');
    assert.equal(chef.eintraege.find((e) => e.name === 'Privat').gesperrt, undefined);
    await u.als('chef')('dateien.liste', { freigabe: 'working', pfad: 'Privat' });
  } finally { await u.aufraeumen(); }
});

test('dateien: Umbenennen zieht Regelpfade mit, Verschieben in einen Bereich gleicht dort ab, Löschen entfernt Regeln', async () => {
  const u = await dateienUmgebung();
  try {
    await u.als('chef')('dateien.umbenennen', { freigabe: 'working', pfad: 'Privat', neuer_name: 'Chefsache' });
    let regeln = (await u.konfig.laden('shares.json')).freigaben[0].ordnerrechte;
    assert.deepEqual(regeln.map((r) => r.pfad), ['Archiv', 'Chefsache']);
    await u.als('chef')('dateien.verschieben', { freigabe: 'working', quellen: ['Offen/Leer'], ziel_freigabe: 'working', ziel_pfad: 'Chefsache' });
    assert.ok(u.intern.some(([a, p]) => a === 'freigaben.ordnerrechte.apply' && p.freigabe === 'working' && p.pfade[0] === 'Chefsache'));
    await u.als('chef')('dateien.loeschen', { freigabe: 'working', pfade: ['Chefsache'] });
    regeln = (await u.konfig.laden('shares.json')).freigaben[0].ordnerrechte;
    assert.deepEqual(regeln.map((r) => r.pfad), ['Archiv']);
  } finally { await u.aufraeumen(); }
});

test('dateien.ordnergroesse: nach dem Hochladen in einen Unterordner stimmt die Größe sofort (kein 0-B-Rest)', async () => {
  const u = await dateienUmgebung();
  try {
    const vorher = await u.als('bert')('dateien.ordnergroesse', { freigabe: 'working', pfad: 'Offen' });
    assert.equal(vorher.groesse, 0);
    // wie ein Ordner-Upload: Datei landet im Unterordner (der Überordner ändert sein mtime dabei nicht)
    await u.als('bert')('dateien.text.speichern', { freigabe: 'working', pfad: 'Offen/Leer/a.txt', inhalt: 'x'.repeat(1234), neu: true });
    const nachher = await u.als('bert')('dateien.ordnergroesse', { freigabe: 'working', pfad: 'Offen' });
    assert.equal(nachher.groesse, 1234);
    // auch Änderungen an der Weboberfläche vorbei (SMB) erscheinen sofort – schnelle Läufe werden nicht gemerkt
    await fs.writeFile(path.join(u.shares, 'working', 'Offen', 'Leer', 'b.bin'), Buffer.alloc(766));
    assert.equal((await u.als('bert')('dateien.ordnergroesse', { freigabe: 'working', pfad: 'Offen' })).groesse, 2000);
  } finally { await u.aufraeumen(); }
});
