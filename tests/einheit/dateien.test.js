// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil B – Dateien: Rechte, Pfadflucht, Dateihelfer Ende-zu-Ende als echter Kindprozess (ohne uid/gid),
// Papierkorb (eigener + Samba), Tickets mit Datenkanal-Attrappe, Links mit Ablauf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { Register } from '../../src/agent/register.js';
import { registriere, freigabeRechte, plattenPlatz, kontingentFrei, gruppenVon, vorschauArt, linksGueltig } from '../../src/agent/aktionen/dateien.js';
import { mimeVon, ausfuehrenOp } from '../../src/agent/helfer/dateihelfer.js';

const NUTZER = [
  { name: 'fabian', rolle: 'nutzer', uid: 1001, gruppen: [] },
  { name: 'lisa', rolle: 'nutzer', uid: 1002, gruppen: [] },
  { name: 'tom', rolle: 'nutzer', uid: 1003, gruppen: ['familie'] },
  { name: 'fremd', rolle: 'nutzer', uid: 1004, gruppen: [] },
  { name: 'chef', rolle: 'admin', uid: 1000, gruppen: [] },
];
const FREIGABEN = [
  { name: 'medien', gaeste: false, lesen: ['lisa', '@familie'], schreiben: ['fabian'], papierkorb: true },
  { name: 'offen', gaeste: true, lesen: [], schreiben: [], papierkorb: true },
  { name: 'direkt', gaeste: false, lesen: [], schreiben: ['fabian'], papierkorb: false },
  { name: 'geheim', gaeste: false, lesen: [], schreiben: [], papierkorb: true },
];
const K = {
  fabian: { nutzer: 'fabian', rolle: 'nutzer', ip: '-' }, lisa: { nutzer: 'lisa', rolle: 'nutzer', ip: '-' },
  tom: { nutzer: 'tom', rolle: 'nutzer', ip: '-' }, fremd: { nutzer: 'fremd', rolle: 'nutzer', ip: '-' },
  chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, gast: { nutzer: 'web', rolle: 'gast', ip: '1.2.3.4' },
};

/** Testumgebung: tmp-Ordner, Konfig, Werkzeuge mit ersetztem System (Helfer läuft echt, aber ohne uid/gid). */
async function umgebung({ befehle } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-b-dateien-'));
  const shares = path.join(w, 'shares'); const snapshots = path.join(w, 'snapshots');
  const konfig = new Konfig(path.join(w, 'config'));
  await konfig.sicherstellen();
  await konfig.speichern('shares.json', { freigaben: FREIGABEN });
  await konfig.speichern('users.json', { nutzer: NUTZER, gruppen: [] });
  for (const f of FREIGABEN) await fs.mkdir(path.join(shares, f.name), { recursive: true });
  await fs.mkdir(snapshots, { recursive: true });
  const aufrufe = []; const tickets = []; const ereignisse = [];
  const sys = {
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) {
        assert.ok(opt.uid !== undefined && opt.gid !== undefined, 'Helfer muss mit uid/gid gestartet werden');
        return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined });
      }
      aufrufe.push([prog, ...args]);
      if (befehle) { const r = await befehle(prog, args, opt); if (r !== undefined) return r; }
      return { code: 0, stdout: '', stderr: '' };
    },
    starten(prog, args, opt = {}) {
      assert.ok(opt.uid !== undefined && opt.gid !== undefined, 'Helfer (Strom) muss mit uid/gid gestartet werden');
      return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined });
    },
    async nutzerIds(name) { const n = NUTZER.find((x) => x.name === name); if (!n) throw new Error(`kein Nutzer ${name}`); return { uid: n.uid, gid: 100 }; },
  };
  const werkzeuge = {
    konfig, system: sys, pfade: { shares, snapshots, konfig: konfig.ordner },
    datenkanal: { ticket(d) { tickets.push(d); return { ticket: 'k-test', dateiname: d.dateiname, groesse: d.groesse, mime: d.mime || 'application/octet-stream' }; } },
    ereignis: (art, daten) => ereignisse.push({ ereignis: art, ...daten }), konfigGeaendert: (b) => ereignisse.push({ ereignis: 'konfig', bereich: b }),
    audit: { eintrag() {} }, aufgaben: null,
  };
  const reg = new Register(); registriere(reg, werkzeuge);
  async function auf(name, params, kontext) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    const griff = { fortschritte: [], fortschritt(a, m) { griff.fortschritte.push([a, m]); }, abgebrochen: () => false };
    const ergebnis = await aktion.ausfuehren(p, kontext, werkzeuge, griff);
    return { ergebnis, griff };
  }
  return { w, shares, konfig, werkzeuge, reg, auf, aufrufe, tickets, ereignisse };
}

async function lesbar(p) { try { await fs.access(p); return true; } catch { return false; } }

test('dateien: Rechteprüfung nutzer / @gruppe / gast / admin', async () => {
  const u = await umgebung();
  const r = (name, k) => freigabeRechte(u.werkzeuge, name, k);
  assert.deepEqual(await r('medien', K.fabian).then((x) => [x.lesen, x.schreiben]), [true, true]);
  assert.deepEqual(await r('medien', K.lisa).then((x) => [x.lesen, x.schreiben]), [true, false]);
  assert.deepEqual(await r('medien', K.tom).then((x) => [x.lesen, x.schreiben]), [true, false], '@familie über Gruppenmitgliedschaft');
  assert.deepEqual(await r('medien', K.fremd).then((x) => [x.lesen, x.schreiben]), [false, false]);
  assert.deepEqual(await r('offen', K.fremd).then((x) => [x.lesen, x.schreiben]), [true, false], 'gaeste = lesen für jeden Angemeldeten');
  assert.deepEqual(await r('geheim', K.chef).then((x) => [x.lesen, x.schreiben]), [true, true], 'admin darf alles');
  await assert.rejects(r('gibtsnicht', K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(r('../x', K.chef), (e) => e.code === 'E_PARAMS');
  // Gruppen auch über users.json gruppen[].mitglieder
  assert.ok(gruppenVon({ nutzer: [{ name: 'a', gruppen: [] }], gruppen: [{ name: 'team', mitglieder: ['a'] }] }, 'a').has('team'));
  // Aktionen: Lesen ohne Schreibrecht, Schreiben verboten, Register prüft Rolle
  await u.auf('dateien.liste', { freigabe: 'medien' }, K.lisa);
  await assert.rejects(u.auf('dateien.ordner', { freigabe: 'medien', pfad: '', name: 'neu' }, K.lisa), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien' }, K.fremd), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'geheim' }, K.tom), (e) => e.code === 'E_RECHTE');
  assert.throws(() => u.reg.vorbereiten('dateien.liste', { freigabe: 'medien' }, { rolle: 'gast' }), (e) => e.code === 'E_RECHTE');
  assert.equal(u.reg.hole('dateien.link.pruefen').rolle, 'gast', 'Web ruft den Link ohne Sitzung auf');
  assert.equal(u.reg.hole('dateien.link.oeffnen').rolle, 'gast', 'Linkseite ohne Sitzung');
  for (const a of u.reg.liste()) if (!['dateien.link.pruefen', 'dateien.link.oeffnen'].includes(a.name)) assert.notEqual(a.rolle, 'gast', a.name);
});

test('dateien: Pfadflucht (.., Symlink, Papierkorb) wird im Agenten und im Helfer abgewiesen', async () => {
  const u = await umgebung();
  const wurzel = path.join(u.shares, 'medien');
  await fs.symlink(os.tmpdir(), path.join(wurzel, 'flucht'));
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien', pfad: '../offen' }, K.fabian), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien', pfad: 'flucht' }, K.fabian), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien', pfad: '.papierkorb' }, K.fabian), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.ordner', { freigabe: 'medien', pfad: '', name: '.papierkorb' }, K.fabian), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.ordner', { freigabe: 'medien', pfad: '', name: 'a/b' }, K.fabian), (e) => e.code === 'E_PARAMS');
  // Helfer allein (als Nutzer) prüft ebenfalls
  await assert.rejects(ausfuehrenOp('liste', { wurzel, pfad: 'flucht/x' }), (e) => e.code === 'E_RECHTE');
  await assert.rejects(ausfuehrenOp('liste', { wurzel, pfad: '.papierkorb' }), (e) => e.code === 'E_RECHTE');
  await assert.rejects(ausfuehrenOp('liste', { wurzel: 'relativ', pfad: '' }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(ausfuehrenOp('unsinn', { wurzel }), (e) => e.code === 'E_PARAMS');
});

test('dateien: Helfer Ende-zu-Ende als Kindprozess – liste, ordner, umbenennen, info, kopieren, verschieben', async () => {
  const u = await umgebung();
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'fotos/2024'), { recursive: true });
  await fs.writeFile(path.join(wurzel, 'fotos/2024/a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 0x80, 0x01, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]));
  await fs.writeFile(path.join(wurzel, 'notiz.txt'), 'hallo welt');
  await fs.writeFile(path.join(wurzel, '.versteckt'), 'x');
  await fs.mkdir(path.join(wurzel, '.papierkorb/2026-01-01T00-00-00-000Z'), { recursive: true });

  const { ergebnis: l } = await u.auf('dateien.liste', { freigabe: 'medien' }, K.fabian);
  assert.deepEqual(l.eintraege.map((e) => e.name), ['fotos', 'notiz.txt'], 'Ordner zuerst, Papierkorb und Versteckte unsichtbar');
  assert.equal(l.schreiben, true); assert.equal(l.eltern, null); assert.equal(l.papierkorb, true);
  assert.equal(l.eintraege[1].mime, 'text/plain'); assert.equal(l.eintraege[1].groesse, 10);
  const { ergebnis: lv } = await u.auf('dateien.liste', { freigabe: 'medien', versteckte: true, sortierung: 'groesse', absteigend: true }, K.lisa);
  assert.ok(lv.eintraege.some((e) => e.name === '.versteckt')); assert.ok(!lv.eintraege.some((e) => e.name === '.papierkorb'));
  assert.equal(lv.schreiben, false);
  const { ergebnis: l2 } = await u.auf('dateien.liste', { freigabe: 'medien', pfad: 'fotos/2024' }, K.fabian);
  assert.equal(l2.eltern, 'fotos'); assert.equal(l2.eintraege[0].mime, 'image/jpeg');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien', pfad: 'notiz.txt' }, K.fabian), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.liste', { freigabe: 'medien', pfad: 'nix' }, K.fabian), (e) => e.code === 'E_NICHT_GEFUNDEN');

  assert.deepEqual((await u.auf('dateien.ordner', { freigabe: 'medien', pfad: 'fotos', name: '2025' }, K.fabian)).ergebnis, { pfad: 'fotos/2025' });
  await assert.rejects(u.auf('dateien.ordner', { freigabe: 'medien', pfad: 'fotos', name: '2025' }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await assert.rejects(u.auf('dateien.ordner', { freigabe: 'medien', pfad: 'gibtsnicht', name: 'x' }, K.fabian), (e) => e.code === 'E_NICHT_GEFUNDEN');

  assert.deepEqual((await u.auf('dateien.umbenennen', { freigabe: 'medien', pfad: 'notiz.txt', neuer_name: 'lesen.md' }, K.fabian)).ergebnis, { pfad: 'lesen.md' });
  await assert.rejects(u.auf('dateien.umbenennen', { freigabe: 'medien', pfad: 'lesen.md', neuer_name: 'fotos' }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await assert.rejects(u.auf('dateien.umbenennen', { freigabe: 'medien', pfad: 'lesen.md', neuer_name: '..' }, K.fabian), (e) => e.code === 'E_PARAMS');

  const { ergebnis: info } = await u.auf('dateien.info', { freigabe: 'medien', pfad: 'fotos/2024/a.jpg' }, K.lisa);
  assert.equal(info.art, 'datei'); assert.equal(info.mime, 'image/jpeg'); assert.deepEqual(info.bild, { breite: 256, hoehe: 128 });
  assert.equal(typeof info.besitzer, 'string'); assert.equal(info.freigabe, 'medien');
  const { ergebnis: infoW } = await u.auf('dateien.info', { freigabe: 'medien' }, K.lisa);
  assert.equal(infoW.art, 'ordner'); assert.equal(infoW.name, 'medien'); assert.equal(infoW.eintraege, 3);

  // kopieren = Aufgabe mit Fortschritt aus den Helfer-Zeilen
  const k = await u.auf('dateien.kopieren', { freigabe: 'medien', quellen: ['fotos/2024'], ziel_freigabe: 'medien', ziel_pfad: 'fotos/2025' }, K.fabian);
  assert.deepEqual(k.ergebnis.uebertragen, [{ von: 'fotos/2024', nach: 'fotos/2025/2024' }]);
  assert.ok(k.griff.fortschritte.length >= 2 && k.griff.fortschritte[0][0] === 0);
  assert.ok(await lesbar(path.join(wurzel, 'fotos/2025/2024/a.jpg')));
  assert.ok(await lesbar(path.join(wurzel, 'fotos/2024/a.jpg')), 'Quelle bleibt');
  await assert.rejects(u.auf('dateien.kopieren', { freigabe: 'medien', quellen: ['fotos'], ziel_freigabe: 'medien', ziel_pfad: 'fotos/2025' }, K.fabian), (e) => e.code === 'E_PARAMS', 'Ordner in sich selbst');
  await assert.rejects(u.auf('dateien.kopieren', { freigabe: 'medien', quellen: ['fotos/2024'], ziel_freigabe: 'medien', ziel_pfad: 'fotos/2025' }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await assert.rejects(u.auf('dateien.kopieren', { freigabe: 'medien', quellen: ['fotos'], ziel_freigabe: 'medien', ziel_pfad: 'nix' }, K.fabian), (e) => e.code === 'E_NICHT_GEFUNDEN');

  // verschieben in andere Freigabe: Quelle braucht schreiben, Ziel braucht schreiben
  await assert.rejects(u.auf('dateien.verschieben', { freigabe: 'medien', quellen: ['lesen.md'], ziel_freigabe: 'offen', ziel_pfad: '' }, K.fabian), (e) => e.code === 'E_RECHTE', 'offen: kein Schreibrecht');
  await assert.rejects(u.auf('dateien.kopieren', { freigabe: 'medien', quellen: ['lesen.md'], ziel_freigabe: 'direkt', ziel_pfad: '' }, K.lisa), (e) => e.code === 'E_RECHTE', 'lisa darf in direkt nicht schreiben');
  const v = await u.auf('dateien.verschieben', { freigabe: 'medien', quellen: ['lesen.md'], ziel_freigabe: 'direkt', ziel_pfad: '' }, K.fabian);
  assert.deepEqual(v.ergebnis.uebertragen, [{ von: 'lesen.md', nach: 'lesen.md' }]);
  assert.ok(!(await lesbar(path.join(wurzel, 'lesen.md'))));
  assert.equal(await fs.readFile(path.join(u.shares, 'direkt/lesen.md'), 'utf8'), 'hallo welt');
});

test('dateien: Papierkorb an/aus, Samba-Papierkorb, wiederherstellen, leeren', async () => {
  const u = await umgebung();
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'doks/alt'), { recursive: true });
  await fs.writeFile(path.join(wurzel, 'doks/alt/brief.txt'), 'brief');
  await fs.writeFile(path.join(wurzel, 'doks/rechnung.pdf'), 'pdf');
  await fs.writeFile(path.join(wurzel, 'weg.txt'), 'weg');
  // Samba-Papierkorb (vfs_recycle keeptree): .papierkorb/samba/<pfad>
  await fs.mkdir(path.join(wurzel, '.papierkorb/samba/musik'), { recursive: true });
  await fs.writeFile(path.join(wurzel, '.papierkorb/samba/musik/lied.mp3'), 'mp3');

  await assert.rejects(u.auf('dateien.loeschen', { freigabe: 'medien', pfade: [''] }, K.fabian), (e) => e.code === 'E_PARAMS', 'Wurzel nicht löschbar');
  await assert.rejects(u.auf('dateien.loeschen', { freigabe: 'medien', pfade: ['nix'] }, K.fabian), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(u.auf('dateien.loeschen', { freigabe: 'medien', pfade: ['weg.txt'] }, K.lisa), (e) => e.code === 'E_RECHTE');

  const { ergebnis: g } = await u.auf('dateien.loeschen', { freigabe: 'medien', pfade: ['doks/alt', 'doks/rechnung.pdf'] }, K.fabian);
  assert.equal(g.geloescht, 2); assert.equal(g.endgueltig, false); assert.match(g.papierkorb, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.ok(!(await lesbar(path.join(wurzel, 'doks/alt'))));
  const korb = path.join(wurzel, '.papierkorb', g.papierkorb);
  assert.ok(await lesbar(path.join(korb, 'doks/alt/brief.txt')));
  const json = JSON.parse(await fs.readFile(path.join(korb, 'papierkorb.json'), 'utf8'));
  assert.equal(json.nutzer, 'fabian'); assert.equal(json.herkunft, 'doks'); assert.equal(json.eintraege.length, 2);
  assert.deepEqual(json.eintraege.map((e) => e.pfad), ['doks/alt', 'doks/rechnung.pdf']);
  const { ergebnis: ge } = await u.auf('dateien.loeschen', { freigabe: 'medien', pfade: ['weg.txt'], endgueltig: true }, K.fabian);
  assert.equal(ge.endgueltig, true); assert.ok(!(await lesbar(path.join(wurzel, 'weg.txt'))));

  const { ergebnis: liste } = await u.auf('dateien.papierkorb.liste', { freigabe: 'medien' }, K.lisa);
  const eigener = liste.find((e) => e.quelle === 'fahnas'); const samba = liste.find((e) => e.quelle === 'samba');
  assert.equal(eigener.id, g.papierkorb); assert.equal(eigener.eintraege.length, 2); assert.equal(eigener.herkunft, 'doks');
  assert.equal(samba.id, 'samba'); assert.equal(samba.herkunft, 'musik'); assert.equal(samba.eintraege[0].pfad, 'musik/lied.mp3');
  // Papierkorb selbst bleibt in der normalen Liste unsichtbar
  assert.ok(!(await u.auf('dateien.liste', { freigabe: 'medien', versteckte: true }, K.fabian)).ergebnis.eintraege.some((e) => e.name === '.papierkorb'));

  // Wiederherstellen: Samba mit Pfad; ist der ursprüngliche Ort belegt, kommt der Eintrag als „Name (1)“ daneben
  await fs.writeFile(path.join(wurzel, 'doks/rechnung.pdf'), 'neu');
  const { ergebnis: wh } = await u.auf('dateien.papierkorb.wiederherstellen', { freigabe: 'medien', eintraege: [{ id: g.papierkorb }, { id: 'samba', pfad: 'musik/lied.mp3' }] }, K.fabian);
  assert.deepEqual(wh.wiederhergestellt, ['doks/alt', 'doks/rechnung (1).pdf', 'musik/lied.mp3']);
  assert.deepEqual(wh.uebersprungen, []);
  assert.deepEqual(wh.umbenannt, [{ pfad: 'doks/rechnung.pdf', neu: 'doks/rechnung (1).pdf' }]);
  assert.equal(await fs.readFile(path.join(wurzel, 'doks/alt/brief.txt'), 'utf8'), 'brief');
  assert.equal(await fs.readFile(path.join(wurzel, 'musik/lied.mp3'), 'utf8'), 'mp3');
  assert.equal(await fs.readFile(path.join(wurzel, 'doks/rechnung.pdf'), 'utf8'), 'neu');
  assert.equal(await fs.readFile(path.join(wurzel, 'doks/rechnung (1).pdf'), 'utf8'), 'pdf', 'alte Version daneben statt im Papierkorb vergessen');
  assert.ok(!(await lesbar(korb)), 'Vorgang vollständig zurück → Eintrag weg');
  assert.ok(!(await lesbar(path.join(wurzel, '.papierkorb/samba/musik'))), 'leere Samba-Ordner werden entfernt');
  await assert.rejects(u.auf('dateien.papierkorb.wiederherstellen', { freigabe: 'medien', eintraege: [{ id: 'samba' }] }, K.fabian), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.papierkorb.wiederherstellen', { freigabe: 'medien', eintraege: [{ id: '../x' }] }, K.fabian), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.papierkorb.wiederherstellen', { freigabe: 'medien', eintraege: [{ id: g.papierkorb }] }, K.lisa), (e) => e.code === 'E_RECHTE');
  // Vorgang schon vollständig zurück → übersprungen mit Grund
  const { ergebnis: wh2 } = await u.auf('dateien.papierkorb.wiederherstellen', { freigabe: 'medien', eintraege: [{ id: g.papierkorb, pfad: 'doks/rechnung.pdf' }] }, K.fabian);
  assert.deepEqual(wh2.wiederhergestellt, []); assert.equal(wh2.uebersprungen.length, 1);

  // Leeren
  await u.auf('dateien.loeschen', { freigabe: 'medien', pfade: ['musik'] }, K.fabian);
  const { ergebnis: le } = await u.auf('dateien.papierkorb.leeren', { freigabe: 'medien' }, K.fabian);
  assert.equal(le.entfernt, 2, 'ein eigener Eintrag + leerer samba-Ordner'); assert.equal(le.bytes, 3);
  assert.deepEqual((await u.auf('dateien.papierkorb.liste', { freigabe: 'medien' }, K.fabian)).ergebnis, []);

  // Freigabe ohne Papierkorb → endgültig, auch ohne Flag
  await fs.writeFile(path.join(u.shares, 'direkt/x.txt'), 'x');
  const { ergebnis: d } = await u.auf('dateien.loeschen', { freigabe: 'direkt', pfade: ['x.txt'] }, K.fabian);
  assert.equal(d.endgueltig, true); assert.ok(!(await lesbar(path.join(u.shares, 'direkt/.papierkorb'))));
});

test('dateien: Ticket-Erzeugung lesen/zip/schreiben mit Kontingent und freiem Platz', async () => {
  let dfAvail = 1000; let qgroup = null;
  const u = await umgebung({
    befehle: (prog, args) => {
      if (prog === 'df') return { code: 0, stdout: `        1B-blocks     Avail\n${5000} ${dfAvail}\n`, stderr: '' };
      if (prog === 'btrfs' && args[0] === 'qgroup') return qgroup ? { code: 0, stdout: qgroup, stderr: '' } : Promise.reject(new Error('quota aus'));
      return undefined;
    },
  });
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'ordner'), { recursive: true });
  await fs.writeFile(path.join(wurzel, 'ordner/bild.png'), Buffer.alloc(300));

  const { ergebnis: t1 } = await u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/bild.png', art: 'lesen' }, K.lisa);
  assert.deepEqual(t1, { ticket: 'k-test', dateiname: 'bild.png', groesse: 300, mime: 'image/png' });
  const d1 = u.tickets.at(-1);
  assert.equal(d1.nutzer, 'lisa'); assert.equal(d1.uid, 1002); assert.equal(d1.art, 'lesen');
  assert.equal(d1.pfad, path.join(await fs.realpath(wurzel), 'ordner/bild.png'));
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner', art: 'lesen' }, K.lisa), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/bild.png', art: 'zip' }, K.lisa), (e) => e.code === 'E_PARAMS');
  const { ergebnis: tz } = await u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner', art: 'zip' }, K.lisa);
  assert.equal(tz.dateiname, 'ordner.zip'); assert.equal(tz.mime, 'application/zip'); assert.equal(u.tickets.at(-1).art, 'zip');
  assert.equal((await u.auf('dateien.ticket', { freigabe: 'medien', pfad: '', art: 'zip' }, K.lisa)).ergebnis.dateiname, 'medien.zip');

  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'neu.bin', art: 'schreiben', groesse: 10 }, K.lisa), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'neu.bin', art: 'schreiben', groesse: 2000 }, K.fabian), (e) => e.code === 'E_PLATZ');
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner', art: 'schreiben', groesse: 1 }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'nix/neu.bin', art: 'schreiben', groesse: 1 }, K.fabian), (e) => e.code === 'E_NICHT_GEFUNDEN');
  const { ergebnis: ts } = await u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/neu.mp4', art: 'schreiben', groesse: 500 }, K.fabian);
  assert.equal(ts.dateiname, 'neu.mp4'); assert.equal(ts.mime, 'video/mp4'); assert.equal(ts.groesse, 500);
  assert.equal(u.tickets.at(-1).art, 'schreiben');
  // Der Datenkanal schreibt in eine versteckte Zwischendatei im Zielordner; abschluss() legt sie als Nutzer ab
  const ts1 = u.tickets.at(-1);
  assert.equal(path.dirname(ts1.pfad), path.join(await fs.realpath(wurzel), 'ordner'));
  assert.match(path.basename(ts1.pfad), /^\.fahnas-upload-[0-9a-f]{16}$/);
  await fs.writeFile(ts1.pfad, 'video');
  assert.deepEqual(await ts1.abschluss(true), { pfad: 'ordner/neu.mp4', name: 'neu.mp4', ersetzt: false, umbenannt: false, papierkorb: null });
  assert.equal(await fs.readFile(path.join(wurzel, 'ordner/neu.mp4'), 'utf8'), 'video');
  // vorhandene Datei: ohne bei_vorhanden E_EXISTIERT; „ersetzen“ legt die alte in den Papierkorb der Freigabe
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/neu.mp4', art: 'schreiben', groesse: 5 }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/neu.mp4', art: 'schreiben', groesse: 5, bei_vorhanden: 'ersetzen' }, K.fabian);
  const ts2 = u.tickets.at(-1);
  await fs.writeFile(ts2.pfad, 'neuer');
  const erg2 = await ts2.abschluss(true);
  assert.equal(erg2.ersetzt, true); assert.ok(erg2.papierkorb);
  assert.equal(await fs.readFile(path.join(wurzel, '.papierkorb', erg2.papierkorb, 'ordner/neu.mp4'), 'utf8'), 'video');
  // abgebrochen: abschluss(false) verwirft nur die Zwischendatei
  await u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/neu.mp4', art: 'schreiben', groesse: 5, bei_vorhanden: 'ersetzen' }, K.fabian);
  const ts3 = u.tickets.at(-1);
  await fs.writeFile(ts3.pfad, 'ha');
  await ts3.abschluss(false);
  assert.equal(await lesbar(ts3.pfad), false);
  assert.equal(await fs.readFile(path.join(wurzel, 'ordner/neu.mp4'), 'utf8'), 'neuer');
  // Freigabe ohne Papierkorb: ersetzt direkt
  await fs.writeFile(path.join(u.shares, 'direkt', 'd.txt'), 'alt');
  await u.auf('dateien.ticket', { freigabe: 'direkt', pfad: 'd.txt', art: 'schreiben', groesse: 3, bei_vorhanden: 'ersetzen' }, K.fabian);
  const ts4 = u.tickets.at(-1); await fs.writeFile(ts4.pfad, 'neu');
  assert.equal((await ts4.abschluss(true)).papierkorb, null);
  assert.equal(await lesbar(path.join(u.shares, 'direkt', '.papierkorb')), false);
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/x', art: 'schreiben', bei_vorhanden: 'drueber' }, K.fabian), (e) => e.code === 'E_PARAMS');
  // dateien.vorhanden: Leserecht genügt
  const { ergebnis: vh } = await u.auf('dateien.vorhanden', { freigabe: 'medien', pfad: 'ordner', namen: ['neu.mp4', 'fehlt.mp4'] }, K.lisa);
  assert.deepEqual(vh.vorhanden.map((v) => v.name), ['neu.mp4']);
  await assert.rejects(u.auf('dateien.vorhanden', { freigabe: 'geheim', pfad: '', namen: ['x'] }, K.lisa), (e) => e.code === 'E_RECHTE');
  assert.ok(u.aufrufe.some((a) => a[0] === 'df' && a.includes('-B1') && a.at(-1) === wurzel));
  // Kontingent (qgroup) deckelt zusätzlich, wenn groesse_gb gesetzt ist
  await u.konfig.aendern('shares.json', (d) => { d.freigaben[0].groesse_gb = 1; });
  qgroup = 'qgroupid   rfer   excl   max_rfer   max_excl\n--------   ----   ----   --------   --------\n0/257      900    900    1000       none\n';
  await assert.rejects(u.auf('dateien.ticket', { freigabe: 'medien', pfad: 'ordner/anders.mp4', art: 'schreiben', groesse: 200 }, K.fabian), (e) => e.code === 'E_PLATZ');
  assert.equal(await kontingentFrei(u.werkzeuge.system, wurzel), 100);
  qgroup = null;
  assert.equal(await kontingentFrei(u.werkzeuge.system, wurzel), null);
  assert.deepEqual(await plattenPlatz(u.werkzeuge.system, wurzel), { gesamt: 5000, frei: 1000, prozent: 80 });
  assert.equal(mimeVon('Foto.JPG'), 'image/jpeg'); assert.equal(mimeVon('ohne'), 'application/octet-stream');
});

test('dateien: Links anlegen, einlösen (system), Ablauf, löschen', async () => {
  const u = await umgebung();
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'ordner'), { recursive: true });
  await fs.writeFile(path.join(wurzel, 'ordner/doc.pdf'), 'pdf!');
  const { ergebnis: l1 } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'ordner/doc.pdf', gueltig_h: 2 }, K.lisa);
  assert.match(l1.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(l1.url, `/link/${l1.token}`); assert.equal(l1.dateiname, 'doc.pdf');
  assert.ok(Date.parse(l1.ablauf) - Date.now() > 1.9 * 3_600_000);
  const { ergebnis: l2 } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'ordner', gueltig_h: 1 }, K.fabian);
  assert.equal(l2.dateiname, 'ordner.zip'); assert.equal(l2.art, 'ordner');
  assert.equal(((await fs.stat(path.join(u.konfig.ordner, 'links.json'))).mode & 0o777), 0o600, 'Download-Tokens nur für root lesbar (R1 Fund 11)');
  // kein Lost Update: fünf Links gleichzeitig anlegen → alle fünf sind da
  await Promise.all([1, 2, 3, 4, 5].map(() => u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'ordner/doc.pdf', gueltig_h: 1 }, K.lisa)));
  assert.equal((await u.konfig.laden('links.json', [])).length, 7);
  await u.konfig.aendern('links.json', (liste) => liste.filter((l) => [l1.token, l2.token].includes(l.token)), []);
  await assert.rejects(u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'ordner', gueltig_h: 1 }, K.fremd), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'nix', gueltig_h: 1 }, K.lisa), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.throws(() => u.reg.vorbereiten('dateien.link.anlegen', { freigabe: 'medien', pfad: 'ordner', gueltig_h: -1 }, K.lisa), (e) => e.code === 'E_PARAMS');

  assert.deepEqual((await u.auf('dateien.link.liste', {}, K.lisa)).ergebnis.map((l) => l.token), [l1.token], 'nur eigene');
  assert.equal((await u.auf('dateien.link.liste', {}, K.chef)).ergebnis.length, 2, 'admin sieht alle');

  const { ergebnis: t } = await u.auf('dateien.link.pruefen', { token: l1.token }, K.gast);
  assert.equal(t.ticket, 'k-test'); assert.equal(t.dateiname, 'doc.pdf'); assert.equal(t.mime, 'application/pdf'); assert.equal(t.groesse, 4);
  assert.equal(u.tickets.at(-1).nutzer, 'lisa'); assert.equal(u.tickets.at(-1).uid, 1002); assert.equal(u.tickets.at(-1).art, 'lesen');
  const { ergebnis: t2 } = await u.auf('dateien.link.pruefen', { token: l2.token }, K.gast);
  assert.equal(t2.dateiname, 'ordner.zip'); assert.equal(u.tickets.at(-1).art, 'zip');
  await assert.rejects(u.auf('dateien.link.pruefen', { token: 'x'.repeat(43) }, K.gast), (e) => e.code === 'E_NICHT_GEFUNDEN');

  // Ersteller verliert Recht → Link tot
  await u.konfig.aendern('shares.json', (d) => { d.freigaben[0].lesen = ['@familie']; });
  await assert.rejects(u.auf('dateien.link.pruefen', { token: l1.token }, K.gast), (e) => e.code === 'E_RECHTE');
  await u.konfig.aendern('shares.json', (d) => { d.freigaben[0].lesen = ['lisa', '@familie']; });

  // Ablauf: abgelaufene werden beim Lesen entfernt
  await u.konfig.aendern('links.json', (liste) => { liste.find((l) => l.token === l1.token).ablauf = new Date(Date.now() - 1000).toISOString(); }, []);
  await assert.rejects(u.auf('dateien.link.pruefen', { token: l1.token }, K.gast), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.deepEqual((await u.konfig.laden('links.json', [])).map((l) => l.token), [l2.token]);

  await assert.rejects(u.auf('dateien.link.loeschen', { token: l2.token }, K.lisa), (e) => e.code === 'E_RECHTE');
  assert.deepEqual((await u.auf('dateien.link.loeschen', { token: l2.token }, K.fabian)).ergebnis, { geloescht: true });
  await assert.rejects(u.auf('dateien.link.loeschen', { token: l2.token }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.deepEqual(await u.konfig.laden('links.json', []), []);
});

test('dateien: dauerhafte Links (gueltig_h 0) bleiben, bis sie gelöscht werden; Ansicht mit Name', async () => {
  const u = await umgebung();
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'urlaub'), { recursive: true });
  const { ergebnis: l } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'urlaub', gueltig_h: 0 }, K.fabian);
  assert.equal(l.ablauf, null); assert.equal(l.name, 'urlaub'); assert.equal(l.art, 'ordner');
  assert.equal((await u.konfig.laden('links.json', []))[0].ablauf, null);
  // Jahre später noch gültig (Uhr vorstellen), auch beim Aufräumen abgelaufener Links
  assert.equal(linksGueltig(await u.konfig.laden('links.json', []), Date.now() + 10 * 365 * 24 * 3_600_000).length, 1);
  const { ergebnis: kurz } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'urlaub', gueltig_h: 1 }, K.fabian);
  assert.deepEqual(linksGueltig(await u.konfig.laden('links.json', []), Date.now() + 2 * 3_600_000).map((x) => x.token), [l.token]);
  assert.ok(Date.parse(kurz.ablauf) > Date.now());
  const { ergebnis: ganz } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: '', gueltig_h: 0 }, K.fabian);
  assert.equal(ganz.name, 'medien', 'ganze Freigabe → Name der Freigabe');
  assert.deepEqual((await u.auf('dateien.link.loeschen', { token: l.token }, K.fabian)).ergebnis, { geloescht: true });
  await assert.rejects(u.auf('dateien.link.oeffnen', { token: l.token, was: 'liste' }, K.gast), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.link === 'ungueltig');
});

test('dateien.link.oeffnen: Ordner durchblättern, Dateien/ZIP/Vorschau nur innerhalb des geteilten Ziels', async () => {
  const u = await umgebung();
  const vorschauen = [];
  u.werkzeuge.vorschau = { async holen(o) { vorschauen.push(o); return { mime: 'image/webp', daten: Buffer.from('RIFFx'), ausCache: false }; } };
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'urlaub/tag1'), { recursive: true });
  await fs.mkdir(path.join(wurzel, 'urlaub/.versteckt'), { recursive: true });
  await fs.mkdir(path.join(wurzel, 'privat'), { recursive: true });
  await fs.writeFile(path.join(wurzel, 'urlaub/strand.jpg'), 'jpg!');
  await fs.writeFile(path.join(wurzel, 'urlaub/tag1/film.mp4'), 'mp4!!');
  await fs.writeFile(path.join(wurzel, 'urlaub/.versteckt/x.txt'), 'x');
  await fs.writeFile(path.join(wurzel, 'urlaub/.DS_Store'), 'x');
  await fs.writeFile(path.join(wurzel, 'privat/geheim.txt'), 'geheim');
  await fs.symlink('../privat', path.join(wurzel, 'urlaub/abkuerzung')); // zeigt innerhalb der Freigabe aus dem geteilten Ordner
  await fs.writeFile(path.join(wurzel, 'brief.pdf'), 'pdf!');
  const { ergebnis: l } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'urlaub', gueltig_h: 0 }, K.lisa);
  const auf = (p) => u.auf('dateien.link.oeffnen', { token: l.token, ...p }, K.gast).then((r) => r.ergebnis);

  const wurzelListe = await auf({ was: 'liste' });
  assert.equal(wurzelListe.art, 'ordner'); assert.equal(wurzelListe.name, 'urlaub'); assert.equal(wurzelListe.pfad, ''); assert.equal(wurzelListe.eltern, null);
  assert.equal(wurzelListe.ablauf, null); assert.equal(wurzelListe.nutzer, 'lisa');
  assert.deepEqual(wurzelListe.eintraege.map((e) => [e.name, e.art, e.vorschau]), [['tag1', 'ordner', false], ['strand.jpg', 'datei', true]], 'ohne Versteckte und ohne Verknüpfungen');
  assert.equal(wurzelListe.eintraege[1].mime, 'image/jpeg');
  const unter = await auf({ was: 'liste', pfad: 'tag1' });
  assert.deepEqual(unter.eintraege.map((e) => e.name), ['film.mp4']); assert.equal(unter.eltern, '');
  const datei = await auf({ was: 'liste', pfad: 'tag1/film.mp4' });
  assert.equal(datei.art, 'datei'); assert.equal(datei.eintrag.groesse, 5); assert.equal(datei.eintrag.vorschau, true); assert.equal(datei.eltern, 'tag1');

  // Lesen/ZIP als Link-Ersteller (lisa), nie außerhalb des geteilten Ordners
  const t = await auf({ was: 'lesen', pfad: 'tag1/film.mp4' });
  assert.equal(t.nutzer, 'lisa'); assert.equal(t.art, 'lesen'); assert.equal(u.tickets.at(-1).nutzer, 'lisa'); assert.equal(u.tickets.at(-1).pfad, path.join(await fs.realpath(wurzel), 'urlaub/tag1/film.mp4'));
  const z = await auf({ was: 'zip', pfad: 'tag1' });
  assert.equal(z.art, 'zip'); assert.equal(u.tickets.at(-1).dateiname, 'tag1.zip');
  await assert.rejects(auf({ was: 'zip', pfad: 'strand.jpg' }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(auf({ was: 'lesen', pfad: 'tag1' }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(auf({ was: 'liste', pfad: '../privat' }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(auf({ was: 'lesen', pfad: 'abkuerzung/geheim.txt' }), (e) => e.code === 'E_RECHTE', 'Verknüpfung aus dem geteilten Ordner');
  await assert.rejects(auf({ was: 'liste', pfad: '.versteckt' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(auf({ was: 'lesen', pfad: '.DS_Store' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(auf({ was: 'liste', pfad: 'gibtsnicht' }), (e) => e.code === 'E_NICHT_GEFUNDEN' && !(e.details && e.details.link));

  // Vorschau mit der Kennung des Erstellers
  const v = await auf({ was: 'vorschau', pfad: 'strand.jpg', groesse: 512 });
  assert.equal(v.mime, 'image/webp'); assert.equal(Buffer.from(v.daten, 'base64').toString(), 'RIFFx');
  assert.equal(vorschauen.at(-1).ids.uid, 1002); assert.equal(vorschauen.at(-1).groesse, 512);
  await assert.rejects(auf({ was: 'vorschau', pfad: 'tag1' }), (e) => e.code === 'E_PARAMS');

  // Datei-Link: nur die Datei selbst, keine Unterpfade
  const { ergebnis: ld } = await u.auf('dateien.link.anlegen', { freigabe: 'medien', pfad: 'brief.pdf', gueltig_h: 24 }, K.fabian);
  const d = (await u.auf('dateien.link.oeffnen', { token: ld.token, was: 'liste' }, K.gast)).ergebnis;
  assert.equal(d.art, 'datei'); assert.equal(d.eintrag.name, 'brief.pdf'); assert.equal(d.pfad, ''); assert.ok(d.ablauf);
  await assert.rejects(u.auf('dateien.link.oeffnen', { token: ld.token, was: 'lesen', pfad: 'x' }, K.gast), (e) => e.code === 'E_NICHT_GEFUNDEN');

  // Unbekannter Token → markiert für die Bremse; Ersteller ohne Recht → Link tot
  await assert.rejects(u.auf('dateien.link.oeffnen', { token: 'y'.repeat(43), was: 'liste' }, K.gast), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.link === 'ungueltig');
  await u.konfig.aendern('shares.json', (x) => { x.freigaben[0].lesen = ['@familie']; });
  await assert.rejects(auf({ was: 'liste' }), (e) => e.code === 'E_RECHTE');
});

test('dateien.vorschau: Rechte der Freigabe, Art nach Endung, Aufruf des Vorschau-Helfers mit Nutzerkennung, base64-Antwort', async () => {
  const u = await umgebung();
  const aufrufe = [];
  u.werkzeuge.vorschau = { async holen(o) { aufrufe.push(o); return { mime: 'image/webp', daten: Buffer.from('RIFFx'), ausCache: false }; } };
  await fs.mkdir(path.join(u.shares, 'medien', 'urlaub'), { recursive: true });
  await fs.writeFile(path.join(u.shares, 'medien', 'urlaub', 'strand.JPG'), 'x');
  const { ergebnis } = await u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'urlaub/strand.JPG', groesse: 512 }, K.lisa);
  assert.deepEqual(ergebnis, { mime: 'image/webp', daten: Buffer.from('RIFFx').toString('base64'), groesse: 512, aus_cache: false });
  assert.equal(aufrufe.length, 1);
  assert.equal(aufrufe[0].abs, path.join(await fs.realpath(u.shares), 'medien', 'urlaub', 'strand.JPG'));
  assert.deepEqual(aufrufe[0].ids, { uid: 1002, gid: 100, gruppen: [] });
  assert.equal(aufrufe[0].art, 'bild'); assert.equal(aufrufe[0].groesse, 512);
  // Standardgröße 256, Video nach Endung
  await fs.writeFile(path.join(u.shares, 'medien', 'film.mkv'), 'x');
  const v = await u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'film.mkv' }, K.fabian);
  assert.equal(v.ergebnis.groesse, 256); assert.equal(aufrufe[1].art, 'video'); assert.equal(aufrufe[1].groesse, 256);
  // keine Vorschau für andere Arten, ungültige Größe, fremder Nutzer, Papierkorb, Pfadflucht – der Helfer wird nie gerufen
  await fs.writeFile(path.join(u.shares, 'medien', 'notiz.txt'), 'x');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'notiz.txt' }, K.lisa), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'film.mkv', groesse: 300 }, K.lisa), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'film.mkv' }, K.fremd), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'geheim', pfad: 'film.mkv' }, K.lisa), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: '.papierkorb/x.jpg' }, K.lisa), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: '../x.jpg' }, K.lisa), (e) => e.code === 'E_PARAMS');
  assert.equal(aufrufe.length, 2);
  // Fehler des Helfers gehen 1:1 durch
  u.werkzeuge.vorschau = { async holen() { throw new FahnasFehler('E_RECHTE', 'Du darfst diese Datei nicht lesen'); } };
  await assert.rejects(u.auf('dateien.vorschau', { freigabe: 'medien', pfad: 'film.mkv' }, K.lisa), (e) => e.code === 'E_RECHTE');
  // Art nach Endung
  assert.equal(vorschauArt('a/b/Foto.HEIC'), 'bild'); assert.equal(vorschauArt('clip.MOV'), 'video'); assert.equal(vorschauArt('bild.webp'), 'bild');
  assert.equal(vorschauArt('x.pdf'), null); assert.equal(vorschauArt('jpg'), null); assert.equal(vorschauArt(''), null); assert.equal(vorschauArt('lied.mp3'), null);
  await fs.rm(u.w, { recursive: true, force: true });
});
