// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil C: Export/Import Ende-zu-Ende in tmp (tar läuft echt über den Befehls-Ersatz), Verschlüsselung
// hin und zurück, falsches Passwort, Aufräumen, Unterschiede, Übernahme + apply, Aktionen system.export/import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig, SCHEMA_VERSION } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { Audit } from '../../src/agent/audit.js';
import { Aufgaben } from '../../src/agent/aufgaben.js';
import { Datenkanal } from '../../src/agent/datenkanal.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { registriere } from '../../src/agent/aktionen/system.js';
import {
  exportErzeugen, verschluesseln, entschluesseln, bereinigeNutzer, aufraeumen, importEntpacken, importAnwenden, unterschiede, MAGIC, KOPF_LAENGE,
  archivMitgliederPruefen,
} from '../../src/agent/export.js';

const ADMIN = { nutzer: 'fabian', rolle: 'admin', ip: '1.2.3.4' };

/** Befehls-Ersatz: tar läuft echt (über den unersetzten Original-Befehl), alles andere wird aufgezeichnet und gelingt. */
function befehleErsetzen(befehle) {
  system._test.setzeBefehl(async (programm, args, o = {}) => {
    befehle.push({ programm, args });
    if (programm === 'tar') return system.befehl('tar', args, o);
    return { code: 0, stdout: '', stderr: '' };
  });
}

/** Legt eine gefüllte Konfiguration an (Nutzer mit Hash/TOTP, Freigaben, App, Web-Zustand, Eingang). */
const AVATAR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function konfigAnlegen(wurzel, variante = 'a') {
  const ordner = path.join(wurzel, `config-${variante}`);
  const k = new Konfig(ordner);
  await k.sicherstellen();
  if (variante === 'a') {
    await k.speichern('system.json', { ...(await k.laden('system.json')), hostname: 'nas-a', zeitzone: 'Europe/Berlin' });
    await k.speichern('users.json', { nutzer: [
      { name: 'fabian', anzeigename: 'Fabian', rolle: 'admin', uid: 1000, gruppen: [], hash: 'scrypt$32768$8$1$c2FsegBB$aGFzaA==', totp: 'JBSWY3DPEHPK3PXP', wiederherstellung: ['h1', 'h2'], gesperrt: false, erstellt: '2026-09-25T00:00:00.000Z' },
      { name: 'lisa', anzeigename: 'Lisa', rolle: 'nutzer', uid: 1001, gruppen: [], hash: 'scrypt$32768$8$1$c2FsegBB$bGlzYQ==', gesperrt: false, erstellt: '2026-09-25T00:00:00.000Z' },
    ], gruppen: [{ name: 'familie', mitglieder: ['fabian', 'lisa'] }] });
    await k.speichern('shares.json', { freigaben: [{ name: 'medien', beschreibung: 'Filme', pfad: '/data/shares/medien', gaeste: false, lesen: ['lisa'], schreiben: ['fabian'], papierkorb: true, timemachine: false }, { name: 'tm', timemachine: true, groesse_gb: 500 }] });
    await fs.mkdir(path.join(ordner, 'apps', 'jellyfin'), { recursive: true });
    await fs.writeFile(path.join(ordner, 'apps', 'jellyfin', 'app.json'), '{"name":"jellyfin"}\n');
    await fs.mkdir(path.join(ordner, 'avatare'), { recursive: true }); // Avatar (0.22.0) reist mit der Konfiguration
    await fs.writeFile(path.join(ordner, 'avatare', 'fabian'), AVATAR);
  } else {
    await k.speichern('system.json', { ...(await k.laden('system.json')), hostname: 'nas-b' });
    await k.speichern('users.json', { nutzer: [
      { name: 'fabian', anzeigename: 'Fabian H.', rolle: 'admin', uid: 1000, gruppen: [], hash: 'scrypt$anders', gesperrt: false, erstellt: '2026-09-25T00:00:00.000Z' },
      { name: 'tom', anzeigename: 'Tom', rolle: 'nutzer', uid: 1002, gruppen: [], hash: 'scrypt$tom', gesperrt: false, erstellt: '2026-09-25T00:00:00.000Z' },
    ], gruppen: [] });
    await k.speichern('shares.json', { freigaben: [{ name: 'medien', beschreibung: 'Filme', pfad: '/data/shares/medien', gaeste: true, lesen: [], schreiben: ['fabian'], papierkorb: true, timemachine: false }, { name: 'fotos' }] });
  }
  await fs.mkdir(path.join(ordner, 'web', 'tls'), { recursive: true });
  // Samba-Passwortdatenbank (NT-Hashes, SID) und Download-Tokens: Geheimnisse, die ohne Geheimnisse nicht mit dürfen
  await fs.mkdir(path.join(ordner, 'samba'), { recursive: true });
  await fs.writeFile(path.join(ordner, 'samba', 'passdb.tdb'), 'NT-HASHES\n');
  await fs.writeFile(path.join(ordner, 'samba', 'secrets.tdb'), 'SID\n');
  await k.speichern('links.json', [{ token: 'TOKEN-GEHEIM', freigabe: 'medien', pfad: 'x', nutzer: 'lisa', ablauf: '2999-01-01T00:00:00.000Z' }]);
  await k.speichern('aufgaben.json', [{ id: 't-1', status: 'fertig' }]);
  await fs.writeFile(path.join(ordner, 'web', 'sitzungen.json'), '{"sitzungen":[]}\n');
  await fs.writeFile(path.join(ordner, 'web', 'bremse.json'), '{}\n');
  await fs.writeFile(path.join(ordner, 'web', 'tls', 'schluessel.pem'), 'GEHEIMER SCHLUESSEL\n');
  await fs.writeFile(path.join(ordner, 'web', 'einstellungen.json'), '{"x":1}\n');
  await fs.writeFile(path.join(ordner, 'protokoll', 'audit-2026-09.jsonl'), '{"zeit":"2026-09-25T00:00:00.000Z"}\n');
  await fs.writeFile(path.join(ordner, 'eingang', 'alt.tar'), 'alt');
  return { ordner, konfig: k };
}

async function tarListe(datei) {
  const { stdout } = await system.befehl('tar', ['-tf', datei]);
  return stdout.split('\n').filter(Boolean).map((z) => z.replace(/^\.\//, '')).filter((z) => z && z !== '.' && z !== './').map((z) => z.replace(/\/$/, '')).sort();
}

async function tarDateiLesen(datei, mitglied) {
  const ziel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-tarlesen-'));
  try {
    await system.befehl('tar', ['-C', ziel, '-xf', datei, `./${mitglied}`]);
    return await fs.readFile(path.join(ziel, mitglied), 'utf8');
  } finally { await fs.rm(ziel, { recursive: true, force: true }); }
}

/** Werkzeuge + Register wie im Agenten, für die Aktionen system.export / system.import.ticket / system.import. */
function werkzeugeBauen(konfig, wurzel, intern = {}) {
  const interne = []; const ereignisse = []; const fortschritte = [];
  const reg = new Register();
  const werkzeuge = {
    konfig, system, audit: new Audit(path.join(konfig.ordner, 'protokoll')), aufgaben: new Aufgaben(() => {}, 2),
    pfade: { konfig: konfig.ordner, startcode: path.join(wurzel, 'startcode') }, datenkanal: new Datenkanal(path.join(wurzel, 'd.sock')),
    ereignis: (art, d) => ereignisse.push({ ereignis: art, ...d }), konfigGeaendert: (b) => ereignisse.push({ ereignis: 'konfig', bereich: b }),
    intern: async (aktion, params) => {
      interne.push({ aktion, params });
      if (aktion in intern) return { ergebnis: await intern[aktion](params) };
      throw new FahnasFehler('E_NICHT_GEFUNDEN', `Unbekannte Aktion „${aktion}“`, { aktion });
    },
    version: () => '1.0.0',
  };
  registriere(reg, werkzeuge);
  const rufe = async (name, params = {}, kontext = ADMIN) => {
    const v = reg.vorbereiten(name, params, kontext);
    return v.aktion.ausfuehren(v.params, kontext, werkzeuge, { id: 't-x', fortschritt: (a, m) => fortschritte.push({ a, m }), abgebrochen: () => false });
  };
  return { reg, werkzeuge, rufe, interne, ereignisse, fortschritte };
}

// ---------------------------------------------------------------------------------------------------------------

test('bereinigeNutzer entfernt Hash, TOTP und Wiederherstellungscodes, lässt den Rest', () => {
  const b = bereinigeNutzer({ nutzer: [{ name: 'a', rolle: 'admin', hash: 'h', totp: 't', wiederherstellung: ['x'], wiederherstellungscodes: ['y'], uid: 1 }], gruppen: [{ name: 'g' }] });
  assert.deepEqual(b, { nutzer: [{ name: 'a', rolle: 'admin', uid: 1 }], gruppen: [{ name: 'g' }] });
  assert.deepEqual(bereinigeNutzer(null), { nutzer: [], gruppen: [] });
});

test('exportErzeugen: mit Geheimnissen → tar ohne Sitzungen/Bremse/Eingang, Hash bleibt; ohne → users.json bereinigt und kein TLS-Schlüssel', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-exp-'));
  const befehle = []; befehleErsetzen(befehle);
  try {
    const { ordner } = await konfigAnlegen(w, 'a');
    const mit = await exportErzeugen({ konfigOrdner: ordner, mit_geheimnissen: true, system, hostname: 'nas-a.local' });
    assert.ok(mit.pfad.startsWith(path.join(ordner, 'eingang', 'export-')) && mit.pfad.endsWith('.tar'));
    assert.match(mit.dateiname, /^fahnas-export-nas-a-\d{8}\.tar$/);
    assert.equal(mit.verschluesselt, false);
    assert.ok(mit.groesse > 1000);
    assert.equal(((await fs.stat(mit.pfad)).mode & 0o777), 0o600);
    const tarAufruf = befehle.find((b) => b.programm === 'tar');
    assert.deepEqual(tarAufruf.args, ['-C', ordner, '--exclude=web/sitzungen.json', '--exclude=web/bremse.json', '--exclude=eingang', '--exclude=aufgaben.json', '--exclude=benachrichtigungen-persoenlich.json', '--exclude=web/turn.json', '-cf', mit.pfad, '.']);
    const liste = await tarListe(mit.pfad);
    for (const soll of ['system.json', 'users.json', 'shares.json', 'snapshots.json', 'version.json', 'apps/jellyfin/app.json', 'web/tls/schluessel.pem', 'web/einstellungen.json', 'protokoll/audit-2026-09.jsonl', 'samba/passdb.tdb', 'links.json']) assert.ok(liste.includes(soll), `fehlt: ${soll}`);
    for (const nicht of ['web/sitzungen.json', 'web/bremse.json', 'eingang', 'eingang/alt.tar', 'aufgaben.json']) assert.ok(!liste.includes(nicht), `darf nicht drin sein: ${nicht}`);
    assert.ok(!liste.some((e) => e.startsWith('eingang')));
    const users = JSON.parse(await tarDateiLesen(mit.pfad, 'users.json'));
    assert.equal(users.nutzer[0].hash, 'scrypt$32768$8$1$c2FsegBB$aGFzaA==');
    assert.equal(users.nutzer[0].totp, 'JBSWY3DPEHPK3PXP');

    // ohne Geheimnisse
    befehle.length = 0;
    const ohne = await exportErzeugen({ konfigOrdner: ordner, mit_geheimnissen: false, system, hostname: 'nas-a' });
    const tarOhne = befehle.find((b) => b.programm === 'tar');
    assert.notEqual(tarOhne.args[1], ordner, 'tar läuft aus einer bereinigten Kopie');
    assert.deepEqual(tarOhne.args.slice(2), ['--exclude=web/sitzungen.json', '--exclude=web/bremse.json', '--exclude=eingang', '--exclude=aufgaben.json', '--exclude=benachrichtigungen-persoenlich.json', '--exclude=web/turn.json', '-cf', ohne.pfad, '.']);
    await assert.rejects(fs.access(tarOhne.args[1]), 'Zwischenordner muss aufgeräumt sein');
    const listeOhne = await tarListe(ohne.pfad);
    assert.ok(listeOhne.includes('users.json') && listeOhne.includes('apps/jellyfin/app.json') && listeOhne.includes('web/einstellungen.json'));
    assert.ok(!listeOhne.some((e) => e.startsWith('web/tls')), 'TLS-Schlüssel darf ohne Geheimnisse nicht mit');
    assert.ok(!listeOhne.includes('web/sitzungen.json'));
    // Negativliste (R1 Fund 2): Samba-Passwortdatenbank und Download-Tokens sind Geheimnisse
    for (const nicht of ['samba', 'samba/passdb.tdb', 'samba/secrets.tdb', 'links.json', 'aufgaben.json']) assert.ok(!listeOhne.includes(nicht), `darf ohne Geheimnisse nicht drin sein: ${nicht}`);
    assert.ok(!listeOhne.some((e) => e.startsWith('samba')));
    const usersOhne = JSON.parse(await tarDateiLesen(ohne.pfad, 'users.json'));
    assert.equal(usersOhne.nutzer.length, 2);
    for (const n of usersOhne.nutzer) { assert.equal(n.hash, undefined); assert.equal(n.totp, undefined); assert.equal(n.wiederherstellung, undefined); }
    assert.equal(usersOhne.nutzer[0].anzeigename, 'Fabian');
    assert.deepEqual(usersOhne.gruppen, [{ name: 'familie', mitglieder: ['fabian', 'lisa'] }]);
    // Original unangetastet
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, 'users.json'), 'utf8')).nutzer[0].hash, 'scrypt$32768$8$1$c2FsegBB$aGFzaA==');
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});

test('Verschlüsselung: Format FAHNAS1+Salz+IV+Tag+Daten, hin und zurück identisch, falsches Passwort und Manipulation abgelehnt', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-krypto-'));
  try {
    const klar = path.join(w, 'klar.bin'); const geheim = path.join(w, 'geheim.fahnas'); const zurueck = path.join(w, 'zurueck.bin');
    const daten = Buffer.concat([Buffer.from('FAH-NAS Testdaten '), (await import('node:crypto')).randomBytes(300_000)]);
    await fs.writeFile(klar, daten);
    await verschluesseln(klar, geheim, 'sehr-geheim-1');
    const roh = await fs.readFile(geheim);
    assert.ok(roh.subarray(0, 7).equals(MAGIC));
    assert.equal(roh.length, KOPF_LAENGE + daten.length, 'GCM: Daten gleich lang, Kopf 51 Byte');
    assert.ok(!roh.subarray(35, 51).equals(Buffer.alloc(16)), 'Tag muss nachträglich eingetragen sein');
    assert.ok(!roh.subarray(KOPF_LAENGE, KOPF_LAENGE + 18).equals(daten.subarray(0, 18)), 'Inhalt darf nicht im Klartext stehen');
    await entschluesseln(geheim, zurueck, 'sehr-geheim-1');
    assert.ok((await fs.readFile(zurueck)).equals(daten));
    await assert.rejects(entschluesseln(geheim, path.join(w, 'falsch.bin'), 'falsches-passwort'), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    await assert.rejects(fs.access(path.join(w, 'falsch.bin')), 'bei falschem Passwort bleibt keine halbe Datei liegen');
    await assert.rejects(entschluesseln(geheim, zurueck, ''), (e) => e.code === 'E_PARAMS');
    // Manipulation: ein Byte kippen
    roh[KOPF_LAENGE + 100] ^= 0xff;
    await fs.writeFile(geheim, roh);
    await assert.rejects(entschluesseln(geheim, zurueck, 'sehr-geheim-1'), (e) => e.code === 'E_PARAMS');
    await fs.writeFile(path.join(w, 'kein.fahnas'), 'nur text');
    await assert.rejects(entschluesseln(path.join(w, 'kein.fahnas'), zurueck, 'sehr-geheim-1'), (e) => e.code === 'E_PARAMS' && /keine verschlüsselte/.test(e.message));
    await assert.rejects(verschluesseln(klar, geheim, 'kurz'), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    // zwei Läufe → verschiedenes Salz/IV
    await verschluesseln(klar, path.join(w, 'g2.fahnas'), 'sehr-geheim-1');
    assert.ok(!(await fs.readFile(path.join(w, 'g2.fahnas'))).subarray(7, 35).equals(roh.subarray(7, 35)));
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('exportErzeugen mit Passwort: .tar.fahnas, Klartext-tar verschwindet, entschlüsselt wieder ein gültiges tar', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-exp2-'));
  befehleErsetzen([]);
  try {
    const { ordner } = await konfigAnlegen(w, 'a');
    const e = await exportErzeugen({ konfigOrdner: ordner, mit_geheimnissen: true, passwort: 'export-passwort', system, hostname: 'nas-a' });
    assert.ok(e.pfad.endsWith('.tar.fahnas')); assert.equal(e.verschluesselt, true);
    assert.match(e.dateiname, /\.tar\.fahnas$/);
    const eingang = await fs.readdir(path.join(ordner, 'eingang'));
    assert.ok(!eingang.some((n) => n.startsWith('export-') && n.endsWith('.tar')), 'Klartext-Archiv darf nicht liegen bleiben');
    const tar = path.join(w, 'ent.tar');
    await entschluesseln(e.pfad, tar, 'export-passwort');
    assert.ok((await tarListe(tar)).includes('users.json'));
    await assert.rejects(exportErzeugen({ konfigOrdner: ordner, passwort: 'kurz', system }), (e2) => e2.code === 'E_PARAMS');
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});

test('aufraeumen: Dateien im Eingang älter als eine Stunde verschwinden, frische bleiben, Ordner bleiben', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-eingang-'));
  try {
    const alt = path.join(w, 'export-alt.tar'); const frisch = path.join(w, 'export-frisch.tar'); const ordner = path.join(w, 'unterordner');
    await fs.writeFile(alt, 'a'); await fs.writeFile(frisch, 'b'); await fs.mkdir(ordner);
    const vor2h = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(alt, vor2h, vor2h);
    assert.deepEqual(await aufraeumen(w), ['export-alt.tar']);
    assert.deepEqual((await fs.readdir(w)).sort(), ['export-frisch.tar', 'unterordner']);
    assert.deepEqual(await aufraeumen(path.join(w, 'gibtsnicht')), []);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('unterschiede: Nutzer/Gruppen/Freigaben hinzu/weg/geändert, System-Felder, Hinweise bei fehlenden Hashes', () => {
  const jetzt = { system: { hostname: 'b', zeitzone: 'Europe/Berlin', version: 1 }, users: { nutzer: [{ name: 'fabian', rolle: 'admin' }, { name: 'tom' }], gruppen: [] }, shares: { freigaben: [{ name: 'medien', gaeste: true }, { name: 'fotos' }] }, snapshots: { plaene: [] } };
  const archiv = { system: { hostname: 'a', zeitzone: 'Europe/Berlin', version: 1 }, users: { nutzer: [{ name: 'fabian', rolle: 'admin' }, { name: 'lisa' }], gruppen: [{ name: 'familie' }] }, shares: { freigaben: [{ name: 'medien', gaeste: false }, { name: 'tm' }] }, snapshots: { plaene: [{ ziel: 'system' }] } };
  const d = unterschiede(jetzt, archiv);
  assert.deepEqual(d.nutzer, { hinzu: ['lisa'], weg: ['tom'], geaendert: [] });
  assert.deepEqual(d.gruppen, { hinzu: ['familie'], weg: [], geaendert: [] });
  assert.deepEqual(d.freigaben, { hinzu: ['tm'], weg: ['fotos'], geaendert: ['medien'] });
  assert.deepEqual(d.system, ['hostname']);
  assert.equal(d.snapshots, true);
  assert.ok(d.hinweise.some((h) => /fabian, lisa/.test(h)), 'Hinweis auf fehlende Passwörter');
  const d2 = unterschiede(jetzt, { ...archiv, users: null, shares: null });
  assert.ok(d2.hinweise.some((h) => /users\.json/.test(h)) && d2.hinweise.some((h) => /shares\.json/.test(h)));
});

test('importEntpacken/importAnwenden: Archiv prüfen (Schema), Dateien atomar übernehmen, web/ und protokoll/ bleiben', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-imp-'));
  befehleErsetzen([]);
  try {
    const a = await konfigAnlegen(w, 'a');
    const b = await konfigAnlegen(w, 'b');
    const e = await exportErzeugen({ konfigOrdner: a.ordner, mit_geheimnissen: true, system });
    const archiv = await importEntpacken({ datei: e.pfad, system });
    try {
      assert.equal(archiv.version.schema, SCHEMA_VERSION);
      assert.equal(archiv.system.hostname, 'nas-a');
      assert.equal(archiv.users.nutzer.length, 2);
      const uebernommen = await importAnwenden({ inhalt: archiv.inhalt, konfigOrdner: b.ordner });
      assert.deepEqual(uebernommen, ['system.json', 'users.json', 'shares.json', 'snapshots.json', 'links.json', 'apps/', 'vms/', 'avatare/']);
    } finally { await fs.rm(archiv.ordner, { recursive: true, force: true }); }
    assert.equal((await b.konfig.laden('system.json')).hostname, 'nas-a');
    assert.deepEqual((await b.konfig.laden('users.json')).nutzer.map((n) => n.name), ['fabian', 'lisa']);
    assert.equal(await fs.readFile(path.join(b.ordner, 'apps', 'jellyfin', 'app.json'), 'utf8'), '{"name":"jellyfin"}\n');
    assert.deepEqual(await fs.readFile(path.join(b.ordner, 'avatare', 'fabian')), AVATAR, 'Avatare kommen mit dem Import zurück');
    assert.equal(await fs.readFile(path.join(b.ordner, 'web', 'tls', 'schluessel.pem'), 'utf8'), 'GEHEIMER SCHLUESSEL\n', 'web/ darf der Import nicht anfassen');
    assert.equal((await fs.readdir(b.ordner)).filter((n) => n.endsWith('.tmp')).length, 0);
    // Schema zu neu
    const zuNeu = path.join(w, 'zuneu'); await fs.mkdir(zuNeu);
    await fs.writeFile(path.join(zuNeu, 'version.json'), JSON.stringify({ schema: SCHEMA_VERSION + 5 }));
    await fs.writeFile(path.join(zuNeu, 'system.json'), '{}');
    await system.befehl('tar', ['-C', zuNeu, '-cf', path.join(w, 'zuneu.tar'), '.']);
    await assert.rejects(importEntpacken({ datei: path.join(w, 'zuneu.tar'), system }), (f) => f.code === 'E_KONFIG' && /neueren/.test(f.message));
    // kein FAH-NAS-Archiv (ohne version.json) und Schrott
    const leer = path.join(w, 'leer'); await fs.mkdir(leer); await fs.writeFile(path.join(leer, 'x.txt'), 'x');
    await system.befehl('tar', ['-C', leer, '-cf', path.join(w, 'leer.tar'), '.']);
    await assert.rejects(importEntpacken({ datei: path.join(w, 'leer.tar'), system }), (f) => f.code === 'E_KONFIG' && /version\.json/.test(f.message));
    await fs.writeFile(path.join(w, 'schrott.tar'), 'das ist kein tar');
    await assert.rejects(importEntpacken({ datei: path.join(w, 'schrott.tar'), system }), (f) => f.code === 'E_PARAMS');
    const reste = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('fahnas-import-'));
    assert.equal(reste.length, 0, 'Zwischenordner müssen weg sein');
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});

test('Import lehnt Archive mit Symlinks, Hardlinks, „..“ und absoluten Pfaden ab; importAnwenden übernimmt nie Verknüpfungen (R1 Fund 8)', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-imp-sym-'));
  const befehle = []; befehleErsetzen(befehle);
  try {
    // 1) Archiv mit Symlink apps -> fremder Ordner und Datei-Symlink in vms/
    const fremd = path.join(w, 'fremd'); await fs.mkdir(fremd); await fs.writeFile(path.join(fremd, 'shadow'), 'root:$6$...\n');
    const q1 = path.join(w, 'q1'); await fs.mkdir(path.join(q1, 'vms', 'vm1'), { recursive: true });
    await fs.writeFile(path.join(q1, 'version.json'), JSON.stringify({ schema: SCHEMA_VERSION }));
    await fs.symlink(fremd, path.join(q1, 'apps'));
    await fs.symlink(path.join(fremd, 'shadow'), path.join(q1, 'vms', 'vm1', 'config.json'));
    await system.befehl('tar', ['-C', q1, '-cf', path.join(w, 'symlink.tar'), '.']);
    await assert.rejects(importEntpacken({ datei: path.join(w, 'symlink.tar'), system }), (f) => f.code === 'E_PARAMS' && /Verknüpfungen/.test(f.message) && f.details.gruende.some((g) => /Symbolische/.test(g)));
    assert.ok(!befehle.some((b) => b.programm === 'tar' && b.args.includes('-xf')), 'nichts entpackt, bevor die Liste geprüft ist');
    // 2) Hardlink
    const q2 = path.join(w, 'q2'); await fs.mkdir(q2);
    await fs.writeFile(path.join(q2, 'version.json'), JSON.stringify({ schema: SCHEMA_VERSION }));
    await fs.writeFile(path.join(q2, 'a.json'), '{}'); await fs.link(path.join(q2, 'a.json'), path.join(q2, 'b.json'));
    await system.befehl('tar', ['-C', q2, '-cf', path.join(w, 'hardlink.tar'), '.']);
    await assert.rejects(importEntpacken({ datei: path.join(w, 'hardlink.tar'), system }), (f) => f.code === 'E_PARAMS' && f.details.gruende.some((g) => /Harte/.test(g)));
    // 3) Namen: „..“ und absolut (Prüfung der Listen-Auswertung direkt, weil tar solche Namen beim Packen normal bereinigt)
    assert.throws(() => archivMitgliederPruefen('-rw-r--r-- 0 root root 3 2026-09-25 10:00 ../etc/passwd\n', '../etc/passwd\n'), (f) => f.code === 'E_PARAMS' && f.details.gruende.some((g) => /hinaus/.test(g)));
    assert.throws(() => archivMitgliederPruefen('-rw-r--r-- 0 root root 3 2026-09-25 10:00 /etc/passwd\n', '/etc/passwd\n'), (f) => f.code === 'E_PARAMS' && f.details.gruende.some((g) => /Absoluter/.test(g)));
    assert.throws(() => archivMitgliederPruefen('lrwxrwxrwx root/root 0 2026-09-25 10:00 ./apps -> /etc\n', './apps\n'), (f) => f.details.gruende.some((g) => /Symbolische/.test(g)), 'GNU-tar-Format');
    archivMitgliederPruefen('drwxr-xr-x 0 root root 0 2026-09-25 10:00 ./\n-rw-r--r-- 0 root root 3 2026-09-25 10:00 ./a.json\n', './\n./a.json\n');
    // 4) Entpacken ohne Besitzer-/Rechteübernahme
    const q3 = path.join(w, 'q3'); await fs.mkdir(q3);
    await fs.writeFile(path.join(q3, 'version.json'), JSON.stringify({ schema: SCHEMA_VERSION }));
    await system.befehl('tar', ['-C', q3, '-cf', path.join(w, 'gut.tar'), '.']);
    const archiv = await importEntpacken({ datei: path.join(w, 'gut.tar'), system });
    await fs.rm(archiv.ordner, { recursive: true, force: true });
    const x = befehle.find((b) => b.programm === 'tar' && b.args.includes('-xf'));
    assert.ok(x.args.includes('--no-same-owner') && x.args.includes('--no-same-permissions'), x.args.join(' '));
    // 5) importAnwenden mit von Hand präpariertem Zwischenordner (wie P6): Symlink → E_PARAMS, Ziel unangetastet
    const konfig = path.join(w, 'konfig'); await fs.mkdir(path.join(konfig, 'apps', 'alt'), { recursive: true });
    await assert.rejects(importAnwenden({ inhalt: q1, konfigOrdner: konfig }), (f) => f.code === 'E_PARAMS');
    assert.ok(!(await fs.lstat(path.join(konfig, 'apps'))).isSymbolicLink());
    await fs.access(path.join(konfig, 'apps', 'alt'));
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});

test('Aktionen: system.export gibt Ticket (root liest), system.import.ticket + system.import Ende-zu-Ende mit Unterschieden, Übernahme und apply', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-akt-'));
  befehleErsetzen([]);
  try {
    const a = await konfigAnlegen(w, 'a');
    const b = await konfigAnlegen(w, 'b');
    const A = werkzeugeBauen(a.konfig, path.join(w, 'A'));
    const applyErgebnis = { gerendert: ['nutzer.apply'], uebersprungen: [], fehler: [] };
    const B = werkzeugeBauen(b.konfig, path.join(w, 'B'), { 'system.apply': async () => applyErgebnis });
    // Export auf A
    const t = await A.rufe('system.export', { mit_geheimnissen: true });
    assert.match(t.ticket, /^k-/); assert.match(t.dateiname, /^fahnas-export-.+-\d{8}\.tar$/); assert.equal(t.mime, 'application/x-tar'); assert.ok(t.groesse > 0);
    // Ticket ist an den Nutzer gebunden (R1 Fund 3): fremder oder fehlender Nutzer → E_TICKET, Ticket bleibt für den Inhaber gültig
    assert.throws(() => A.werkzeuge.datenkanal.einloesen(t.ticket, 'lisa'), (e) => e.code === 'E_TICKET');
    assert.throws(() => A.werkzeuge.datenkanal.einloesen(t.ticket), (e) => e.code === 'E_TICKET');
    const ticket = A.werkzeuge.datenkanal.einloesen(t.ticket, 'fabian');
    assert.equal(ticket.uid, 0); assert.equal(ticket.gid, 0); assert.equal(ticket.art, 'lesen'); assert.equal(ticket.nutzer, 'fabian');
    assert.throws(() => A.werkzeuge.datenkanal.einloesen(t.ticket, 'fabian'), (e) => e.code === 'E_TICKET', 'einmalig');
    await fs.access(ticket.pfad);
    assert.throws(() => A.reg.vorbereiten('system.export', {}, { nutzer: 'lisa', rolle: 'nutzer', ip: '-' }), (e) => e.code === 'E_RECHTE');
    // Ticket für den Upload auf B, „Upload“ = Datei an die Ticket-Stelle kopieren (wie es der Datenkanal als root täte)
    const it = await B.rufe('system.import.ticket', { dateiname: 'fahnas-export-nas-a-20260925.tar', groesse: t.groesse });
    assert.match(it.dateiname, /^import-.+\.tar$/);
    const schreib = B.werkzeuge.datenkanal.einloesen(it.ticket, 'fabian');
    assert.equal(schreib.art, 'schreiben'); assert.equal(schreib.uid, 0); assert.equal(schreib.pfad, path.join(b.ordner, 'eingang', it.dateiname));
    await fs.copyFile(ticket.pfad, schreib.pfad);
    await assert.rejects(B.rufe('system.import.ticket', { dateiname: '../boese.tar' }), (e) => e.code === 'E_PARAMS');
    // Import nur aus Tickets desselben Admins (R1 Fund 3, Punkt 4)
    await assert.rejects(B.rufe('system.import', { ticket: it.ticket }, { nutzer: 'zweiter', rolle: 'admin', ip: '-' }), (e) => e.code === 'E_RECHTE' && /anderer Admin/.test(e.message));
    // Nur Unterschiede
    const r1 = await B.rufe('system.import', { ticket: it.ticket });
    assert.equal(r1.angewendet, false); assert.equal(r1.dateiname, it.dateiname); assert.equal(r1.schema, SCHEMA_VERSION);
    assert.deepEqual(r1.unterschiede.nutzer, { hinzu: ['lisa'], weg: ['tom'], geaendert: ['fabian'] });
    assert.deepEqual(r1.unterschiede.freigaben, { hinzu: ['tm'], weg: ['fotos'], geaendert: ['medien'] });
    assert.deepEqual(r1.unterschiede.gruppen.hinzu, ['familie']);
    assert.ok(r1.unterschiede.system.includes('hostname'));
    assert.equal(B.interne.length, 0, 'ohne anwenden kein apply');
    assert.equal((await b.konfig.laden('system.json')).hostname, 'nas-b', 'ohne anwenden nichts geändert');
    await fs.access(schreib.pfad, undefined, 'Datei bleibt für den zweiten Schritt liegen');
    // Ticket ist verbraucht → Dateiname geht weiterhin
    await assert.rejects(B.rufe('system.import', { ticket: it.ticket }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(B.rufe('system.import', { dateiname: 'gibtsnicht.tar' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await assert.rejects(B.rufe('system.import', {}), (e) => e.code === 'E_PARAMS');
    // Übernehmen
    const r2 = await B.rufe('system.import', { dateiname: it.dateiname, anwenden: true });
    assert.equal(r2.angewendet, true);
    assert.deepEqual(r2.uebernommen, ['system.json', 'users.json', 'shares.json', 'snapshots.json', 'links.json', 'apps/', 'vms/', 'avatare/']);
    assert.deepEqual(r2.apply, applyErgebnis);
    assert.deepEqual(B.interne.map((i) => i.aktion), ['system.apply']);
    assert.equal((await b.konfig.laden('system.json')).hostname, 'nas-a');
    assert.deepEqual((await b.konfig.laden('users.json')).nutzer.map((n) => n.name), ['fabian', 'lisa']);
    assert.equal((await b.konfig.laden('users.json')).nutzer[0].hash, 'scrypt$32768$8$1$c2FsegBB$aGFzaA==');
    assert.deepEqual((await b.konfig.laden('shares.json')).freigaben.map((f) => f.name), ['medien', 'tm']);
    await fs.access(path.join(b.ordner, 'apps', 'jellyfin', 'app.json'));
    assert.equal(await fs.readFile(path.join(b.ordner, 'web', 'sitzungen.json'), 'utf8'), '{"sitzungen":[]}\n');
    // Rechte nach dem Import: Geheimnisse 0600 (MODUS-Tabelle), Rest 0640 (R1 Fund 11)
    assert.equal(((await fs.stat(path.join(b.ordner, 'users.json'))).mode & 0o777), 0o600);
    assert.equal(((await fs.stat(path.join(b.ordner, 'links.json'))).mode & 0o777), 0o600);
    assert.equal(((await fs.stat(path.join(b.ordner, 'system.json'))).mode & 0o777), 0o640);
    await assert.rejects(fs.access(schreib.pfad), 'hochgeladene Datei ist nach der Übernahme weg');
    for (const bereich of ['system', 'nutzer', 'freigaben', 'snapshots']) assert.ok(B.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === bereich), bereich);
    assert.ok(B.fortschritte.some((f) => f.a === 1));
    assert.ok(B.reg.hole('system.import').aufgabe);
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});

test('Aktionen: verschlüsselter Export → Import mit falschem Passwort (Datei bleibt) und richtigem Passwort', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-akt2-'));
  befehleErsetzen([]);
  try {
    const a = await konfigAnlegen(w, 'a');
    const b = await konfigAnlegen(w, 'b');
    const A = werkzeugeBauen(a.konfig, path.join(w, 'A'));
    const B = werkzeugeBauen(b.konfig, path.join(w, 'B'), { 'system.apply': async () => ({ gerendert: [], uebersprungen: [], fehler: [] }) });
    const t = await A.rufe('system.export', { mit_geheimnissen: false, passwort: 'export-passwort' });
    assert.ok(t.dateiname.endsWith('.tar.fahnas')); assert.equal(t.verschluesselt, true); assert.equal(t.mime, 'application/octet-stream');
    const quelle = A.werkzeuge.datenkanal.einloesen(t.ticket, 'fabian').pfad;
    const it = await B.rufe('system.import.ticket', { dateiname: t.dateiname });
    assert.ok(it.dateiname.endsWith('.tar.fahnas'));
    const ziel = B.werkzeuge.datenkanal.einloesen(it.ticket, 'fabian').pfad;
    await fs.copyFile(quelle, ziel);
    await assert.rejects(B.rufe('system.import', { ticket: it.ticket }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'passwort');
    await assert.rejects(B.rufe('system.import', { dateiname: it.dateiname, passwort: 'falsch-falsch' }), (e) => e.code === 'E_PARAMS' && /Passwort falsch/.test(e.message));
    await fs.access(ziel, undefined, 'bei falschem Passwort bleibt die Datei zum erneuten Versuch');
    const r = await B.rufe('system.import', { dateiname: it.dateiname, passwort: 'export-passwort', anwenden: true });
    assert.equal(r.angewendet, true);
    assert.ok(r.unterschiede.hinweise.some((h) => /Ohne Passwort im Archiv/.test(h)));
    const users = await b.konfig.laden('users.json');
    assert.deepEqual(users.nutzer.map((n) => n.name), ['fabian', 'lisa']);
    assert.equal(users.nutzer[0].hash, undefined, 'Export ohne Geheimnisse bringt keine Hashes mit');
  } finally { system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true }); }
});
