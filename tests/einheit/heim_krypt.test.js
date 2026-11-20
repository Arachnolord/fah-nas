// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests persönliche Ordner (Speicherplatz je Nutzer) und verschlüsselte Freigaben (gocryptfs) gegen das Schein-System:
// Unterlaufwerk + Besitzer + Grenze, Samba [homes], Aufbewahren nach dem Löschen; Anlegen mit Passwort, Entsperren
// (falsches Passwort), Sperren, Schlüssel merken, Samba aus solange gesperrt, Löschen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as nutzer from '../../src/agent/aktionen/nutzer.js';
import * as freigaben from '../../src/agent/aktionen/freigaben.js';
import * as heim from '../../src/agent/aktionen/heim.js';
import { werkzeugeBauen, scheinsystem } from './nutzer_scheinsystem.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const PW = 'sehr-geheim-123';

/** Schein für gocryptfs/findmnt/fusermount über dem Nutzer-Schein. */
function schein() {
  const s = scheinsystem();
  const basis = s.ausfuehren;
  const eingehaengt = new Set();
  const pw = { richtig: null };
  s.eingehaengt = eingehaengt;
  s.ausfuehren = async (programm, args = [], opt = {}) => {
    const ok = (stdout = '') => { s.befehle.push({ programm, args: [...args] }); return { code: 0, stdout, stderr: '' }; };
    if (programm === 'dpkg-query') return ok('install ok installed');
    if (programm === 'systemd-run') { s.befehle.push({ programm, args: [...args] }); const i = args.indexOf('gocryptfs'); return s.ausfuehren('gocryptfs', args.slice(i + 1), opt); }
    if (programm === 'gocryptfs') {
      const passfile = args[args.indexOf('-passfile') + 1];
      const gegeben = (await fs.readFile(passfile, 'utf8')).trim();
      if (args.includes('-init')) { pw.richtig = gegeben; await fs.writeFile(path.join(args[args.length - 1], 'gocryptfs.conf'), '{}'); return ok(); }
      if (gegeben !== pw.richtig) { s.befehle.push({ programm, args: [...args] }); throw new FahnasFehler('E_SYSTEM', 'Befehl gocryptfs schlug fehl', { code: 12, ausgabe: 'Password incorrect.' }); }
      eingehaengt.add(args[args.length - 1]); return ok();
    }
    if (programm === 'findmnt') { const z = args[args.length - 1]; if (eingehaengt.has(z)) return ok(args.includes('TARGET,FSTYPE') ? `${z} fuse.gocryptfs\n` : `${z}\n`); s.befehle.push({ programm, args: [...args] }); if ((opt.erlaubteCodes || [0]).includes(1)) return { code: 1, stdout: '', stderr: '' }; throw new FahnasFehler('E_SYSTEM', 'findmnt', { code: 1 }); }
    if (programm === 'umount' && eingehaengt.has(args[args.length - 1])) { // gesperrt: der entschlüsselte Inhalt verschwindet aus dem Einhängepunkt
      const z = args[args.length - 1]; eingehaengt.delete(z);
      for (const n of await fs.readdir(z).catch(() => [])) await fs.rm(path.join(z, n), { recursive: true, force: true });
      return ok();
    }
    if (programm === 'chattr') return ok();
    return basis(programm, args, opt);
  };
  return s;
}

async function grundlage() {
  const scheins = schein();
  const u = await werkzeugeBauen({ scheins, module: [nutzer, freigaben, heim] });
  await u.system('nutzer.anlegen', { name: 'chef', passwort: PW, rolle: 'admin' });
  await u.admin('nutzer.anlegen', { name: 'anna', passwort: PW, rolle: 'nutzer' });
  scheins.leeren();
  return u;
}

test('heim: persönlicher Ordner – Unterlaufwerk, nur der Nutzer, Grenze, Samba [homes], Liste, Aufbewahren nach dem Löschen', async () => {
  const u = await grundlage();
  try {
    const r = await u.admin('heim.setzen', { name: 'anna', aktiv: true, groesse_gb: 5 });
    const pfad = path.join(u.pfade.daten, 'homes', 'anna');
    assert.equal(r.pfad, pfad); assert.equal(r.groesse_gb, 5);
    const z = u.scheins.zeilen();
    assert.ok(z.includes(`btrfs subvolume create ${pfad}`)); assert.ok(z.includes(`chown anna:fahnas-nutzer ${pfad}`)); assert.ok(z.includes(`chmod 0700 ${pfad}`));
    assert.ok(z.some((x) => x.startsWith('btrfs qgroup limit 5368709120') && x.endsWith(pfad)), 'Grenze 5 GiB');
    const homes = await fs.readFile(path.join(u.pfade.samba, 'homes.conf'), 'utf8');
    assert.match(homes, /^\[homes\]/); assert.match(homes, new RegExp(`path = ${path.join(u.pfade.daten, 'homes')}/%S`)); assert.match(homes, /valid users = %S/);
    assert.ok((await fs.readFile(path.join(u.pfade.samba, 'alle.conf'), 'utf8')).includes('homes.conf'));
    const l = await u.admin('heim.liste', {});
    assert.deepEqual(l.map((x) => [x.name, x.aktiv, x.groesse_gb]), [['chef', false, null], ['anna', true, 5]]);
    await assert.rejects(u.als('anna')('heim.setzen', { name: 'anna', aktiv: true }), (e) => e.code === 'E_RECHTE');
    // Löschen des Nutzers → Ordner wandert in die Sicherung
    await fs.mkdir(pfad, { recursive: true }); await fs.writeFile(path.join(pfad, 'notiz.txt'), 'x');
    await u.admin('nutzer.loeschen', { name: 'anna', dateien: 'behalten' });
    await assert.rejects(fs.stat(pfad));
    const geloescht = await fs.readdir(path.join(u.pfade.backup, 'geloescht'));
    assert.ok(geloescht.some((n) => n.startsWith('anna-persoenlich-')));
    // ohne aktive persönliche Ordner verschwindet [homes]
    await freigaben._test.belegungWarten?.();
    await u.system('freigaben.apply', {});
    await assert.rejects(fs.stat(path.join(u.pfade.samba, 'homes.conf')));
  } finally { await u.aufraeumen(); }
});

test('krypt: verschlüsselte Freigabe – anlegen (Passwort-Regeln), entsperrt nutzbar, sperren → Samba aus, falsches Passwort, Schlüssel merken, löschen', async () => {
  const u = await grundlage();
  try {
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'tresor', verschluesselt: true, passwort: 'kurz' }), (e) => e.details.feld === 'passwort');
    await assert.rejects(u.admin('freigaben.anlegen', { name: 'tresor', verschluesselt: true, extern: true, passwort: PW }), (e) => e.details.feld === 'verschluesselt');
    const f = await u.admin('freigaben.anlegen', { name: 'tresor', verschluesselt: true, passwort: PW, schreiben: ['chef'], groesse_gb: 10 });
    const klar = path.join(u.pfade.shares, 'tresor'); const geheim = path.join(u.pfade.daten, '.krypt', 'tresor');
    assert.deepEqual([f.verschluesselt, f.entsperrt, f.groesse_gb, f.schluessel_gespeichert], [true, true, null, false]);
    const z = u.scheins.zeilen();
    assert.ok(z.includes(`btrfs subvolume create ${geheim}`));
    assert.ok(z.some((x) => x.startsWith('gocryptfs -q -init -passfile ') && x.endsWith(geheim)));
    assert.ok(z.some((x) => x.startsWith('gocryptfs -q -allow_other -acl -passfile ') && x.endsWith(`${geheim} ${klar}`)));
    assert.ok(z.some((x) => x.startsWith('systemd-run --scope --unit=fahnas-krypt-tresor-')), 'gocryptfs in eigener Einheit (übersteht Agent-Neustart)');
    assert.ok(!z.some((x) => x.includes(PW)), 'Passwort nie auf der Befehlszeile');
    assert.equal((await fs.readdir(path.join(u.pfade.run))).filter((n) => n.startsWith('krypt-')).length, 0, 'Passdatei wieder weg');
    assert.match(await fs.readFile(path.join(u.pfade.samba, 'tresor.conf'), 'utf8'), /path = /);
    const json = (await u.konfig.laden('shares.json')).freigaben.find((x) => x.name === 'tresor');
    assert.equal(json.verschluesselt, true); assert.equal(json.passwort, undefined, 'Passwort wird nicht gespeichert');
    // Sperren → Samba „available = no“
    const g = await u.admin('freigaben.sperren', { name: 'tresor' });
    assert.equal(g.entsperrt, false);
    assert.match(await fs.readFile(path.join(u.pfade.samba, 'tresor.conf'), 'utf8'), /available = no/);
    // Falsches Passwort
    await assert.rejects(u.admin('freigaben.entsperren', { name: 'tresor', passwort: 'falsch-falsch' }), (e) => e.details.feld === 'passwort' && /stimmt nicht/.test(e.message));
    // Richtiges Passwort + Schlüssel merken (0600)
    const e = await u.admin('freigaben.entsperren', { name: 'tresor', passwort: PW, merken: true });
    assert.deepEqual([e.entsperrt, e.schluessel_gespeichert], [true, true]);
    const sch = path.join(u.pfade.konfig, 'krypt', 'tresor.schluessel');
    assert.equal((await fs.stat(sch)).mode & 0o777, 0o600);
    // Start: gesperrt + gespeicherter Schlüssel → entsperrt automatisch
    u.scheins.eingehaengt.clear();
    await u.system('freigaben.apply', {});
    assert.ok(u.scheins.eingehaengt.has(klar), 'automatisch entsperrt');
    // nicht verschlüsselte Freigabe: kein Entsperren
    await u.admin('freigaben.anlegen', { name: 'normal' });
    await assert.rejects(u.admin('freigaben.sperren', { name: 'normal' }), (er) => er.code === 'E_PARAMS');
    // Löschen räumt Geheimdaten, Einhängepunkt und Schlüssel
    u.scheins.leeren();
    await u.admin('freigaben.loeschen', { name: 'tresor', daten: 'loeschen' });
    assert.ok(u.scheins.zeilen().includes(`btrfs subvolume delete ${geheim}`));
    await assert.rejects(fs.stat(sch)); await assert.rejects(fs.stat(klar));
  } finally { await u.aufraeumen(); }
});
