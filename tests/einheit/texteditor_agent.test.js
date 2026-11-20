// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Texteditor, Agent-Seite (Plan 01, Aufgabe 4): dateien.text.speichern + Dateihelfer-Op text_schreiben –
// atomar als der Nutzer, mtime/Größe-Prüfung (E_GEAENDERT), exklusives Anlegen, Rechte, keine Inhalte im Protokoll.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { registriere } from '../../src/agent/aktionen/dateien.js';
import { UPLOAD_PRAEFIX } from '../../src/agent/helfer/dateihelfer.js';

const NUTZER = [{ name: 'anna', rolle: 'nutzer', uid: 1001, gruppen: [] }];
const FREIGABEN = [
  { name: 'daten', gaeste: false, lesen: [], schreiben: ['anna'], papierkorb: true },
  { name: 'nurlesen', gaeste: false, lesen: ['anna'], schreiben: [], papierkorb: true },
];
const ANNA = { nutzer: 'anna', rolle: 'nutzer', ip: '-' };

let w; let shares; let reg; let werkzeuge;

/** Umgebung nach dem Muster von dateien.test.js: echte Konfig, echter Helfer-Kindprozess, aber ohne uid/gid-Wechsel. */
before(async () => {
  w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-b-texteditor-'));
  shares = path.join(w, 'shares');
  const konfig = new Konfig(path.join(w, 'config'));
  await konfig.sicherstellen();
  await konfig.speichern('shares.json', { freigaben: FREIGABEN });
  await konfig.speichern('users.json', { nutzer: NUTZER, gruppen: [] });
  for (const f of FREIGABEN) await fs.mkdir(path.join(shares, f.name), { recursive: true });
  const sys = {
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) {
        assert.ok(opt.uid !== undefined && opt.gid !== undefined, 'Helfer muss mit uid/gid gestartet werden');
        return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined });
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    starten(prog, args, opt = {}) { return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined }); },
    async nutzerIds(name) { const n = NUTZER.find((x) => x.name === name); if (!n) throw new Error(`kein Nutzer ${name}`); return { uid: n.uid, gid: 100 }; },
  };
  werkzeuge = {
    konfig, system: sys, pfade: { shares, snapshots: path.join(w, 'snapshots'), konfig: konfig.ordner },
    datenkanal: { ticket() { throw new Error('kein Ticket erwartet'); } },
    ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} }, aufgaben: null,
  };
  reg = new Register(); registriere(reg, werkzeuge);
});

after(async () => { await fs.rm(w, { recursive: true, force: true }); });

async function rufe(kontext, name, params) {
  const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
  return aktion.ausfuehren(p, kontext, werkzeuge);
}

test('speichert als Nutzer und meldet neuen Stand', async () => {
  const datei = path.join(shares, 'daten', 'a.md');
  await fs.writeFile(datei, '# alt\n');
  const st = await fs.stat(datei);
  const r = await rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'a.md', inhalt: '# neu\n', erwartet: { geaendert: st.mtime.toISOString(), groesse: st.size } });
  assert.equal(await fs.readFile(datei, 'utf8'), '# neu\n');
  assert.equal(r.groesse, 6);
  assert.equal(r.name, 'a.md');
  assert.equal(r.pfad, 'a.md');
  assert.equal(r.geaendert, (await fs.stat(datei)).mtime.toISOString());
});

test('veraltete Größe → E_GEAENDERT mit Stand der Platte, Datei unverändert', async () => {
  const datei = path.join(shares, 'daten', 'b.txt');
  await fs.writeFile(datei, 'von SMB geändert');
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'b.txt', inhalt: 'meins', erwartet: { geaendert: '2020-01-01T00:00:00.000Z', groesse: 3 } }),
    (e) => e.code === 'E_GEAENDERT' && e.details.groesse === Buffer.byteLength('von SMB geändert') && typeof e.details.geaendert === 'string');
  assert.equal(await fs.readFile(datei, 'utf8'), 'von SMB geändert');
});

test('ohne erwartet wird überschrieben (Konflikt-Antwort „Trotzdem überschreiben“)', async () => {
  const datei = path.join(shares, 'daten', 'ueber.txt');
  await fs.writeFile(datei, 'alt');
  await rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'ueber.txt', inhalt: 'neu' });
  assert.equal(await fs.readFile(datei, 'utf8'), 'neu');
});

test('neu:true legt exklusiv an, vorhandene Datei → E_EXISTIERT', async () => {
  const r = await rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'kopie.md', inhalt: 'kopiert', neu: true });
  assert.equal(r.name, 'kopie.md');
  assert.equal(await fs.readFile(path.join(shares, 'daten', 'kopie.md'), 'utf8'), 'kopiert');
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'kopie.md', inhalt: 'nochmal', neu: true }),
    (e) => e.code === 'E_EXISTIERT' && e.details.name === 'kopie.md');
  assert.equal(await fs.readFile(path.join(shares, 'daten', 'kopie.md'), 'utf8'), 'kopiert');
});

test('fehlende Datei ohne neu → E_NICHT_GEFUNDEN', async () => {
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'gibtsnicht.txt', inhalt: 'a' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
});

test('Rechte und Pfade', async () => {
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'nurlesen', pfad: 'x.txt', inhalt: 'a', neu: true }), (e) => e.code === 'E_RECHTE');
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: '../x.txt', inhalt: 'a', neu: true }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: '.papierkorb/x.txt', inhalt: 'a', neu: true }), (e) => ['E_PARAMS', 'E_RECHTE'].includes(e.code));
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: '', inhalt: 'a', neu: true }), (e) => e.code === 'E_PARAMS');
  await fs.mkdir(path.join(shares, 'daten', 'ordner'));
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'ordner', inhalt: 'a' }), (e) => e.code === 'E_PARAMS');
});

test('Rechte-Bits bleiben, CRLF und BOM byte-genau', async () => {
  const p = path.join(shares, 'daten', 'c.txt');
  await fs.writeFile(p, 'x'); await fs.chmod(p, 0o640);
  await rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'c.txt', inhalt: '﻿a\r\nb\r\n' });
  assert.equal((await fs.stat(p)).mode & 0o777, 0o640);
  assert.deepEqual([...await fs.readFile(p)], [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]);
});

test('zu groß → E_PARAMS feld inhalt', async () => {
  await assert.rejects(rufe(ANNA, 'dateien.text.speichern', { freigabe: 'daten', pfad: 'gross.txt', inhalt: 'ä'.repeat(1_100_000), neu: true }),
    (e) => e.code === 'E_PARAMS' && e.details.feld === 'inhalt');
  await assert.rejects(fs.access(path.join(shares, 'daten', 'gross.txt')));
});

test('Prüfprotokoll bekommt keinen Inhalt', () => {
  const def = reg.hole('dateien.text.speichern');
  assert.deepEqual(def.audit({ freigabe: 'daten', pfad: 'a.md', inhalt: 'GEHEIM', neu: false }), { freigabe: 'daten', pfad: 'a.md', neu: false });
});

test('keine Zwischendateien bleiben liegen, auch nach Fehlern', async () => {
  const reste = (await fs.readdir(path.join(shares, 'daten'))).filter((n) => n.startsWith(UPLOAD_PRAEFIX));
  assert.deepEqual(reste, []);
});
