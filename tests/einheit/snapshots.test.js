// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil B – Schnappschüsse: btrfs-Befehlsfolgen (erzeugen, löschen, zurückrollen, zurückdrehen bei Fehler),
// snapper (JSON + Tabelle, Konfigurationstext, Timer), Startmenü-Parsing, Standard-Unterlaufwerk, Zeitplan mit
// gestellter Uhr, Aufbewahrung, 95-%-Sperre, durchsuchen/zurückholen über den Dateihelfer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { registriere as regDateien } from '../../src/agent/aktionen/dateien.js';
import { registriere, _test, letzteFaelligkeit, snapperTabelleParsen, snapperJsonParsen, startmenueParsen, ID_FREIGABE } from '../../src/agent/aktionen/snapshots.js';
import { snapperKonfigText, rendereSnapper, anzahlBehalten, AUFRAEUMEN_TEXT } from '../../src/agent/render/snapper.js';

const NUTZER = [{ name: 'fabian', rolle: 'nutzer', uid: 1001, gruppen: [] }, { name: 'lisa', rolle: 'nutzer', uid: 1002, gruppen: [] }, { name: 'chef', rolle: 'admin', uid: 1000, gruppen: [] }];
const FREIGABEN = [{ name: 'medien', gaeste: false, lesen: ['lisa'], schreiben: ['fabian'], papierkorb: true }, { name: 'doks', gaeste: false, lesen: [], schreiben: ['fabian'], papierkorb: true }];
const K = { fabian: { nutzer: 'fabian', rolle: 'nutzer', ip: '-' }, lisa: { nutzer: 'lisa', rolle: 'nutzer', ip: '-' }, chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, system: { nutzer: 'system', rolle: 'system', ip: '-' } };

/**
 * Testumgebung. Der Befehlsersatz spielt btrfs nach: `snapshot` legt den Zielordner an, `delete` entfernt ihn,
 * `mv -T` benennt um; df meldet `belegt` Prozent. Alles wird in `aufrufe` festgehalten.
 */
async function umgebung({ befehle } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-b-snap-'));
  const shares = path.join(w, 'shares'); const snapshots = path.join(w, 'snapshots');
  const konfig = new Konfig(path.join(w, 'config'));
  await konfig.sicherstellen();
  await konfig.speichern('shares.json', { freigaben: FREIGABEN });
  await konfig.speichern('users.json', { nutzer: NUTZER, gruppen: [] });
  for (const f of FREIGABEN) await fs.mkdir(path.join(shares, f.name), { recursive: true });
  await fs.mkdir(snapshots, { recursive: true });
  const zustand = { belegt: 50 };
  const aufrufe = []; const ereignisse = [];
  const sys = {
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined });
      aufrufe.push([prog, ...args]);
      if (befehle) { const r = await befehle(prog, args, opt); if (r !== undefined) return r; }
      if (prog === 'df') return { code: 0, stdout: `  1B-blocks   Avail\n10000 ${10000 - zustand.belegt * 100}\n`, stderr: '' };
      if (prog === 'btrfs' && args[0] === 'subvolume' && args[1] === 'snapshot') { await fs.mkdir(args.at(-1), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; }
      if (prog === 'btrfs' && args[0] === 'subvolume' && args[1] === 'delete') { await fs.rm(args[2], { recursive: true, force: true }); return { code: 0, stdout: '', stderr: '' }; }
      if (prog === 'mv') { await fs.rename(args[1], args[2]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
    starten(prog, args, opt = {}) { return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined }); },
    async nutzerIds(name) { const n = NUTZER.find((x) => x.name === name); if (!n) throw new Error(`kein Nutzer ${name}`); return { uid: n.uid, gid: 100 }; },
  };
  const werkzeuge = {
    konfig, system: sys, pfade: { shares, snapshots, konfig: konfig.ordner },
    datenkanal: { ticket: (d) => ({ ticket: 'k', dateiname: d.dateiname }) },
    ereignis: (art, daten) => ereignisse.push({ ereignis: art, ...daten }), konfigGeaendert: (b) => ereignisse.push({ ereignis: 'konfig', bereich: b }),
    audit: { eintrag() {} }, aufgaben: null,
  };
  const reg = new Register(); regDateien(reg, werkzeuge); registriere(reg, werkzeuge);
  async function auf(name, params, kontext) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    const griff = { fortschritte: [], fortschritt(a, m) { griff.fortschritte.push([a, m]); }, abgebrochen: () => false };
    const ergebnis = await aktion.ausfuehren(p, kontext, werkzeuge, griff);
    return { ergebnis, griff };
  }
  return { w, shares, snapshots, konfig, werkzeuge, reg, auf, aufrufe, ereignisse, zustand };
}

async function lesbar(p) { try { await fs.access(p); return true; } catch { return false; } }
const nurBtrfsMv = (aufrufe) => aufrufe.filter((a) => a[0] === 'btrfs' || a[0] === 'mv');

test('snapshots: erzeugen/liste/löschen einer Freigabe – btrfs-Befehle, Begleitdatei, Rechte', async () => {
  const u = await umgebung();
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T08:30:00.000Z'));
    await assert.rejects(u.auf('snapshots.erzeugen', { ziel: 'gibtsnicht' }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.throws(() => u.reg.vorbereiten('snapshots.erzeugen', { ziel: 'medien' }, K.fabian), (e) => e.code === 'E_RECHTE');
    const { ergebnis: m } = await u.auf('snapshots.erzeugen', { ziel: 'medien', beschreibung: 'Vor dem Aufräumen' }, K.chef);
    assert.equal(m.id, '2026-09-25T08-30-00-manuell'); assert.equal(m.art, 'manuell'); assert.equal(m.nutzer, 'chef');
    assert.deepEqual(nurBtrfsMv(u.aufrufe), [['btrfs', 'subvolume', 'snapshot', '-r', path.join(u.shares, 'medien'), path.join(u.snapshots, 'medien', m.id)]]);
    assert.ok(await lesbar(path.join(u.snapshots, 'medien', `${m.id}.json`)));
    // gleiche Sekunde → Kennung rückt eine Sekunde weiter
    const { ergebnis: m2 } = await u.auf('snapshots.erzeugen', { ziel: 'medien' }, K.chef);
    assert.equal(m2.id, '2026-09-25T08-30-01-manuell'); assert.equal(m2.zeit, '2026-09-25T08:30:00.000Z');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'snapshots'));

    const { ergebnis: liste } = await u.auf('snapshots.liste', { ziel: 'medien' }, K.lisa);
    assert.deepEqual(liste.map((s) => s.id), [m2.id, m.id], 'neueste zuerst');
    assert.equal(liste[1].beschreibung, 'Vor dem Aufräumen');
    await assert.rejects(u.auf('snapshots.liste', { ziel: 'doks' }, K.lisa), (e) => e.code === 'E_RECHTE');
    assert.deepEqual((await u.auf('snapshots.liste', { ziel: 'doks' }, K.chef)).ergebnis, []);
    // Schnappschuss ohne Begleitdatei: Zeit/Art aus dem Namen, btrfs subvolume show liefert die genaue Zeit
    await fs.mkdir(path.join(u.snapshots, 'medien', '2026-09-24T01-02-03-plan'));
    await fs.writeFile(path.join(u.snapshots, 'medien', '2026-01-01T00-00-00.json'), '{}'); // verwaist
    const u2 = u.aufrufe.length;
    const { ergebnis: liste2 } = await u.auf('snapshots.liste', { ziel: 'medien' }, K.chef);
    const alt = liste2.find((s) => s.id === '2026-09-24T01-02-03-plan');
    assert.equal(alt.art, 'zeitplan'); assert.equal(alt.zeit, '2026-09-24T01:02:03.000Z');
    assert.deepEqual(u.aufrufe.slice(u2).map((a) => a.slice(0, 3)), [['btrfs', 'subvolume', 'show']], 'nur für Einträge ohne Begleitdatei');
    assert.ok(!(await lesbar(path.join(u.snapshots, 'medien', '2026-01-01T00-00-00.json'))), 'verwaiste Begleitdatei entfernt');

    await assert.rejects(u.auf('snapshots.loeschen', { ziel: 'medien', id: 'nix' }, K.chef), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('snapshots.loeschen', { ziel: 'medien', id: '2026-01-01T00-00-00' }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    const vor = u.aufrufe.length;
    assert.deepEqual((await u.auf('snapshots.loeschen', { ziel: 'medien', id: m.id }, K.chef)).ergebnis, { id: m.id, geloescht: true });
    assert.deepEqual(u.aufrufe.slice(vor), [['btrfs', 'subvolume', 'delete', path.join(u.snapshots, 'medien', m.id)]]);
    assert.ok(!(await lesbar(path.join(u.snapshots, 'medien', `${m.id}.json`))));
    assert.ok(ID_FREIGABE.test('2026-09-25T08-30-00-sicherheit') && !ID_FREIGABE.test('2026-09-25T08-30-00-x'));
  } finally { _test.setzeJetzt(null); }
});

test('snapshots: 95-%-Sperre für manuelle Schnappschüsse', async () => {
  const u = await umgebung();
  u.zustand.belegt = 96;
  await assert.rejects(u.auf('snapshots.erzeugen', { ziel: 'medien' }, K.chef), (e) => e.code === 'E_PLATZ' && e.details.prozent === 96);
  assert.ok(!u.aufrufe.some((a) => a[0] === 'btrfs'));
  u.zustand.belegt = 94;
  await u.auf('snapshots.erzeugen', { ziel: 'medien' }, K.chef);
  assert.ok(u.aufrufe.some((a) => a[0] === 'btrfs'));
});

test('snapshots: Zeitplan mit gestellter Uhr – Fälligkeit, Aufbewahrung, Zustand, Platte voll', async () => {
  const u = await umgebung();
  try {
    // Fälligkeiten (Ortszeit)
    const mi = new Date(2026, 8, 23, 2, 59); assert.equal(mi.getDay(), 3, 'Mittwoch');
    assert.equal(letzteFaelligkeit(mi, 'stuendlich').getTime(), new Date(2026, 8, 23, 2, 0).getTime());
    assert.equal(letzteFaelligkeit(mi, 'taeglich').getTime(), new Date(2026, 8, 22, 3, 0).getTime());
    assert.equal(letzteFaelligkeit(mi, 'woechentlich').getTime(), new Date(2026, 8, 20, 3, 30).getTime());
    assert.equal(letzteFaelligkeit(new Date(2026, 8, 27, 3, 29), 'woechentlich').getTime(), new Date(2026, 8, 20, 3, 30).getTime());
    // monatlich (0.32.0): am 1. um 04:00; vor 04:00 am 1. gilt noch der Vormonat
    assert.equal(letzteFaelligkeit(mi, 'monatlich').getTime(), new Date(2026, 8, 1, 4, 0).getTime());
    assert.equal(letzteFaelligkeit(new Date(2026, 9, 1, 3, 59), 'monatlich').getTime(), new Date(2026, 8, 1, 4, 0).getTime());
    assert.equal(letzteFaelligkeit(new Date(2026, 0, 1, 2, 0), 'monatlich').getTime(), new Date(2025, 11, 1, 4, 0).getTime(), 'Jahreswechsel');
    assert.equal(letzteFaelligkeit(new Date(2026, 8, 27, 3, 30), 'woechentlich').getTime(), new Date(2026, 8, 27, 3, 30).getTime());

    await u.konfig.speichern('snapshots.json', { plaene: [
      { ziel: 'system', zeitplan: { taeglich: true }, behalten: { taeglich: 7 } },
      { ziel: 'medien', zeitplan: { stuendlich: true, taeglich: true, woechentlich: true }, behalten: { stuendlich: 2, taeglich: 1, woechentlich: 1 } },
      { ziel: 'geloescht', zeitplan: { stuendlich: true }, behalten: {} },
    ] });
    // manueller Schnappschuss darf nie automatisch verschwinden
    _test.setzeJetzt(() => new Date(2026, 8, 1, 12, 0));
    await u.auf('snapshots.erzeugen', { ziel: 'medien', beschreibung: 'manuell' }, K.chef);

    let jetzt = mi; _test.setzeJetzt(() => jetzt);
    let r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.takt), ['stuendlich', 'taeglich', 'woechentlich'], 'Nachholen: alles fällig, nie gelaufen');
    assert.deepEqual(r.geloescht, []);
    assert.ok(r.angelegt.every((a) => a.freigabe === 'medien' && a.id.endsWith('-plan')));
    const z1 = await u.konfig.laden('snapshots_zustand.json');
    assert.equal(z1.letzte.medien.stuendlich, mi.toISOString()); assert.equal(z1.letzte.geloescht, undefined, 'Plan ohne Freigabe wird ignoriert');

    jetzt = new Date(2026, 8, 23, 3, 0); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.takt), ['stuendlich', 'taeglich']);
    assert.equal(r.geloescht.length, 1, 'taeglich behalten 1 → der ältere Tagesstand weg');
    jetzt = new Date(2026, 8, 23, 3, 1); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt, []); assert.deepEqual(r.geloescht, []);
    jetzt = new Date(2026, 8, 23, 4, 0); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.takt), ['stuendlich']);
    assert.equal(r.geloescht.length, 1, 'stuendlich behalten 2 → ältester Stundenstand weg');
    jetzt = new Date(2026, 8, 27, 3, 30); assert.equal(jetzt.getDay(), 0, 'Sonntag'); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.takt), ['stuendlich', 'taeglich', 'woechentlich']);
    assert.equal(r.geloescht.length, 3, 'je Takt einer über der Grenze');

    const liste = (await u.auf('snapshots.liste', { ziel: 'medien' }, K.chef)).ergebnis;
    assert.equal(liste.filter((s) => s.art === 'manuell').length, 1, 'manueller bleibt');
    assert.equal(liste.filter((s) => s.takt === 'stuendlich').length, 2);
    assert.equal(liste.filter((s) => s.takt === 'taeglich').length, 1);
    assert.equal(liste.filter((s) => s.takt === 'woechentlich').length, 1);
    for (const s of liste) assert.ok(await lesbar(path.join(u.snapshots, 'medien', s.id)));
    assert.equal((await fs.readdir(path.join(u.snapshots, 'medien'))).filter((n) => !n.endsWith('.json')).length, 5);
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'snapshots'));

    // Platte voll: keine neuen, Ereignis nur einmal je Stunde; Aufbewahrung läuft weiter
    u.zustand.belegt = 97; const ereignisseVor = u.ereignisse.length; const btrfsVor = u.aufrufe.filter((a) => a[0] === 'btrfs').length;
    jetzt = new Date(2026, 8, 27, 4, 0); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt, []); assert.equal(r.platte_voll, true);
    const voll = u.ereignisse.slice(ereignisseVor).filter((e) => e.ereignis === 'system' && e.art === 'platte_voll');
    assert.equal(voll.length, 1); assert.equal(voll[0].daten.prozent, 97);
    jetzt = new Date(2026, 8, 27, 4, 30); r = await _test.tick(u.werkzeuge);
    assert.equal(u.ereignisse.slice(ereignisseVor).filter((e) => e.art === 'platte_voll').length, 1, 'nicht erneut gemeldet');
    jetzt = new Date(2026, 8, 27, 5, 1); r = await _test.tick(u.werkzeuge);
    assert.equal(u.ereignisse.slice(ereignisseVor).filter((e) => e.art === 'platte_voll').length, 2, 'nach einer Stunde erneut');
    assert.equal(u.aufrufe.filter((a) => a[0] === 'btrfs').length, btrfsVor, 'kein btrfs-Aufruf bei voller Platte');
    u.zustand.belegt = 50;
    jetzt = new Date(2026, 8, 27, 5, 2); r = await _test.tick(u.werkzeuge);
    assert.deepEqual(r.angelegt.map((a) => a.takt), ['stuendlich'], 'nach Platzschaffen holt der Takt nach');
    assert.equal(anzahlBehalten('stuendlich', { stuendlich: 0 }), 24); assert.equal(anzahlBehalten('taeglich', { taeglich: 3 }), 3);
  } finally { _test.setzeJetzt(null); _test.stoppen(); }
});

test('snapshots: zurückrollen – Befehlsfolge, Sicherheits-Schnappschuss, Zurückdrehen bei Fehler', async () => {
  let scheitern = null;
  const u = await umgebung({ befehle: (prog, args) => { if (scheitern && scheitern(prog, args)) throw new FahnasFehler('E_SYSTEM', 'kaputt', { befehl: [prog, ...args].join(' '), ausgabe: 'Testfehler' }); } });
  const pfad = path.join(u.shares, 'medien'); const snapOrdner = path.join(u.snapshots, 'medien');
  const snap = path.join(snapOrdner, '2026-09-20T03-00-00-plan');
  await fs.mkdir(snap, { recursive: true });
  try {
    _test.setzeJetzt(() => new Date('2026-09-25T09:00:00.000Z'));
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00' }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.throws(() => u.reg.vorbereiten('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.fabian), (e) => e.code === 'E_RECHTE');

    const { ergebnis, griff } = await u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef);
    const sicherheit = path.join(snapOrdner, '2026-09-25T09-00-00-sicherheit');
    assert.equal(ergebnis.sicherheit, '2026-09-25T09-00-00-sicherheit');
    assert.deepEqual(nurBtrfsMv(u.aufrufe), [
      ['btrfs', 'subvolume', 'snapshot', '-r', pfad, sicherheit],
      ['btrfs', 'subvolume', 'snapshot', snap, `${pfad}.neu`],
      ['mv', '-T', pfad, `${pfad}.alt`],
      ['mv', '-T', `${pfad}.neu`, pfad],
      ['btrfs', 'subvolume', 'delete', `${pfad}.alt`],
    ]);
    assert.ok(griff.fortschritte.at(-1)[0] === 1);
    assert.ok(await lesbar(pfad) && !(await lesbar(`${pfad}.neu`)) && !(await lesbar(`${pfad}.alt`)));
    assert.ok(await lesbar(`${sicherheit}.json`));

    // Fehler beim zweiten mv → Zurückdrehen: mv alt→pfad, delete neu; Sicherheits-Schnappschuss bleibt
    u.aufrufe.length = 0;
    _test.setzeJetzt(() => new Date('2026-09-25T09:05:00.000Z'));
    scheitern = (prog, args) => prog === 'mv' && args[1] === `${pfad}.neu`;
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'tausch_neu' && /wiederhergestellt/.test(e.message));
    const s2 = path.join(snapOrdner, '2026-09-25T09-05-00-sicherheit');
    assert.deepEqual(nurBtrfsMv(u.aufrufe), [
      ['btrfs', 'subvolume', 'snapshot', '-r', pfad, s2],
      ['btrfs', 'subvolume', 'snapshot', snap, `${pfad}.neu`],
      ['mv', '-T', pfad, `${pfad}.alt`],
      ['mv', '-T', `${pfad}.neu`, pfad],
      ['mv', '-T', `${pfad}.alt`, pfad],
      ['btrfs', 'subvolume', 'delete', `${pfad}.neu`],
    ]);
    assert.ok(await lesbar(pfad) && !(await lesbar(`${pfad}.neu`)) && !(await lesbar(`${pfad}.alt`)));
    assert.ok(await lesbar(s2));

    // Fehler beim Löschen des alten Stands → alles zurück in umgekehrter Reihenfolge
    u.aufrufe.length = 0;
    _test.setzeJetzt(() => new Date('2026-09-25T09:10:00.000Z'));
    scheitern = (prog, args) => prog === 'btrfs' && args[1] === 'delete' && args[2] === `${pfad}.alt`;
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'altes_loeschen');
    assert.deepEqual(nurBtrfsMv(u.aufrufe).slice(4), [
      ['btrfs', 'subvolume', 'delete', `${pfad}.alt`],
      ['mv', '-T', pfad, `${pfad}.neu`],
      ['mv', '-T', `${pfad}.alt`, pfad],
      ['btrfs', 'subvolume', 'delete', `${pfad}.neu`],
    ]);
    assert.ok(await lesbar(pfad) && !(await lesbar(`${pfad}.neu`)) && !(await lesbar(`${pfad}.alt`)));

    // Fehler beim Sicherheits-Schnappschuss → nichts weiter passiert
    u.aufrufe.length = 0; scheitern = (prog, args) => prog === 'btrfs' && args.includes('-r');
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef), (e) => e.code === 'E_SYSTEM' && e.details.stufe === 'sicherheit');
    assert.equal(nurBtrfsMv(u.aufrufe).length, 1);
    // Reste eines abgebrochenen Laufs → E_BELEGT statt blind weitermachen
    scheitern = null; await fs.mkdir(`${pfad}.alt`);
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef), (e) => e.code === 'E_BELEGT');
    await fs.rmdir(`${pfad}.alt`);
    u.zustand.belegt = 99;
    await assert.rejects(u.auf('snapshots.zurueckrollen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan' }, K.chef), (e) => e.code === 'E_PLATZ');
  } finally { _test.setzeJetzt(null); }
});

test('snapshots: durchsuchen und zurückholen aus einem Schnappschuss (Helfer als Kindprozess)', async () => {
  const u = await umgebung();
  const snap = path.join(u.snapshots, 'medien', '2026-09-20T03-00-00-plan');
  await fs.mkdir(path.join(snap, 'fotos/urlaub'), { recursive: true });
  await fs.writeFile(path.join(snap, 'fotos/urlaub/strand.jpg'), 'alt');
  await fs.writeFile(path.join(snap, 'liste.txt'), 'einkauf');
  await fs.mkdir(path.join(snap, '.papierkorb/x'), { recursive: true });
  const wurzel = path.join(u.shares, 'medien');
  await fs.mkdir(path.join(wurzel, 'fotos'), { recursive: true });

  const { ergebnis: d } = await u.auf('snapshots.durchsuchen', { ziel: 'medien', id: '2026-09-20T03-00-00-plan', pfad: '' }, K.lisa);
  assert.deepEqual(d.eintraege.map((e) => e.name), ['fotos', 'liste.txt']); assert.equal(d.nur_lesen, true); assert.equal(d.id, '2026-09-20T03-00-00-plan');
  await assert.rejects(u.auf('snapshots.durchsuchen', { ziel: 'medien', id: '2026-09-20T03-00-00-plan', pfad: '.papierkorb' }, K.lisa), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.auf('snapshots.durchsuchen', { ziel: 'medien', id: '2026-09-21T03-00-00-plan', pfad: '' }, K.lisa), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(u.auf('snapshots.durchsuchen', { ziel: 'system', id: '5', pfad: '' }, K.chef), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.auf('snapshots.durchsuchen', { ziel: 'doks', id: '2026-09-20T03-00-00-plan', pfad: '' }, K.lisa), (e) => e.code === 'E_RECHTE');

  await assert.rejects(u.auf('snapshots.zurueckholen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan', pfade: ['liste.txt'], ziel_pfad: '' }, K.lisa), (e) => e.code === 'E_RECHTE', 'zurückholen braucht Schreibrecht');
  const { ergebnis: z, griff } = await u.auf('snapshots.zurueckholen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan', pfade: ['fotos/urlaub', 'liste.txt'], ziel_pfad: 'fotos' }, K.fabian);
  assert.deepEqual(z.uebertragen, [{ von: 'fotos/urlaub', nach: 'fotos/urlaub' }, { von: 'liste.txt', nach: 'fotos/liste.txt' }]);
  assert.equal(z.bytes, 10); assert.ok(griff.fortschritte.length >= 2);
  assert.equal(await fs.readFile(path.join(wurzel, 'fotos/urlaub/strand.jpg'), 'utf8'), 'alt');
  await fs.writeFile(path.join(wurzel, 'fotos/urlaub/strand.jpg'), 'neu');
  await assert.rejects(u.auf('snapshots.zurueckholen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan', pfade: ['fotos/urlaub'], ziel_pfad: 'fotos' }, K.fabian), (e) => e.code === 'E_EXISTIERT');
  await u.auf('snapshots.zurueckholen', { freigabe: 'medien', id: '2026-09-20T03-00-00-plan', pfade: ['fotos/urlaub'], ziel_pfad: 'fotos', ueberschreiben: true }, K.fabian);
  assert.equal(await fs.readFile(path.join(wurzel, 'fotos/urlaub/strand.jpg'), 'utf8'), 'alt', 'überschreiben stellt den alten Stand wieder her');
  assert.ok(!(await lesbar(path.join(snap, 'fotos/urlaub/strand.jpg.tmp'))));
});

test('snapshots: System – snapper JSON und Tabelle, erzeugen, löschen', async () => {
  let json = true;
  const u = await umgebung({ befehle: (prog, args) => {
    if (prog !== 'snapper') return undefined;
    if (args[0] === '--jsonout') return json ? { code: 0, stdout: JSON.stringify({ root: [{ number: 0, type: 'single', date: '', description: 'current' }, { number: 3, type: 'pre', date: '2026-09-25 10:00:00', description: 'apt', cleanup: 'number', 'used-space': 1234 }, { number: 4, type: 'post', 'pre-number': 3, date: '2026-09-25 10:05:00', description: 'apt', cleanup: 'number' }, { number: 7, type: 'single', date: '2026-09-25 11:00:00', description: 'timeline', cleanup: 'timeline' }, { number: 9, type: 'single', date: '2026-09-25 12:00:00', description: 'Vor Umbau', cleanup: '' }] }), stderr: '' } : { code: 1, stdout: '', stderr: 'unknown option' };
    if (args.includes('--columns')) return { code: 0, stdout: ' # | Date                | Type   | Description\n---+---------------------+--------+------------\n0  |                     | single | current\n3* | 2026-09-25 10:00:00 | pre    | apt\n4+ | 2026-09-25 10:05:00 | post   | apt\n7  | 2026-09-25 11:00:00 | single | timeline\n', stderr: '' };
    if (args.includes('create')) return { code: 0, stdout: '12\n', stderr: '' };
    return undefined;
  } });
  const { ergebnis: l } = await u.auf('snapshots.liste', { ziel: 'system' }, K.lisa);
  assert.deepEqual(l.map((s) => [s.id, s.art]), [['3', 'pre'], ['4', 'post'], ['7', 'zeitplan'], ['9', 'manuell']]);
  assert.equal(l[0].groesse, 1234); assert.equal(l[1].pre, '3'); assert.equal(l[0].zeit, new Date('2026-09-25T10:00:00').toISOString());
  json = false; u.aufrufe.length = 0;
  const { ergebnis: l2 } = await u.auf('snapshots.liste', { ziel: 'system' }, K.chef);
  assert.deepEqual(l2.map((s) => [s.id, s.art, s.beschreibung]), [['3', 'pre', 'apt'], ['4', 'post', 'apt'], ['7', 'zeitplan', 'timeline']]);
  assert.deepEqual(u.aufrufe.map((a) => a.join(' ')), ['snapper --jsonout -c root list', 'snapper -c root list --columns number,date,type,description']);
  assert.deepEqual(snapperTabelleParsen('kein tabellentext'), []);
  assert.throws(() => snapperJsonParsen('{"x":1}'));

  u.aufrufe.length = 0;
  const { ergebnis: e } = await u.auf('snapshots.erzeugen', { ziel: 'system', beschreibung: 'Vor Umbau' }, K.chef);
  assert.equal(e.id, '12'); assert.equal(e.art, 'manuell');
  assert.deepEqual(u.aufrufe, [['snapper', '-c', 'root', 'create', '-d', 'Vor Umbau', '--print-number']]);
  u.aufrufe.length = 0;
  assert.deepEqual((await u.auf('snapshots.loeschen', { ziel: 'system', id: '12' }, K.chef)).ergebnis, { id: '12', geloescht: true });
  assert.deepEqual(u.aufrufe, [['snapper', '-c', 'root', 'delete', '12']]);
  await assert.rejects(u.auf('snapshots.loeschen', { ziel: 'system', id: '2026-09-20T03-00-00-plan' }, K.chef), (e2) => e2.code === 'E_PARAMS');
});

// Die System-Rückrollen (snapshots.system.standard/zurueck/reste/rest_loeschen) prüft tests/einheit/snapshots_system.test.js.
test('snapshots: Startmenü (grub-btrfs) parsen – Einträge und Hinweis „nur lesend“', async () => {
  const u = await umgebung();
  const grub = path.join(u.w, 'grub.cfg');
  await fs.writeFile(grub, [
    "menuentry 'Ubuntu' --class ubuntu {", '\tlinux /boot/vmlinuz root=UUID=x ro', '}',
    "submenu 'Ubuntu snapshots' {",
    "\tsubmenu '2026-09-25 11:00:00 | @/.snapshots/7/snapshot | single | timeline' {",
    "\t\tmenuentry 'Ubuntu 26.04 (snapshot 7)' {", '\t\t\tlinux /@/.snapshots/7/snapshot/boot/vmlinuz root=UUID=x rootflags=subvol="@/.snapshots/7/snapshot"', '\t\t}', '\t}',
    "\tsubmenu '2026-09-25 10:00:00 | @/.snapshots/3/snapshot | pre | apt' {", "\t\tmenuentry 'x' { linux /@/.snapshots/3/snapshot/boot/vmlinuz rootflags=subvol=\"@/.snapshots/3/snapshot\" }", '\t}',
    '}', '',
  ].join('\n'));
  const alt = process.env.FAHNAS_GRUB_CFG;
  process.env.FAHNAS_GRUB_CFG = grub;
  try {
    const { ergebnis: r } = await u.auf('snapshots.system.startmenue', {}, K.chef);
    const m = r.eintraege;
    assert.deepEqual(m.map((e) => [e.id, e.art, e.beschreibung]), [['7', 'zeitplan', 'timeline'], ['3', 'pre', 'apt']]);
    assert.equal(m[0].zeit, new Date('2026-09-25T11:00:00').toISOString());
    assert.equal(r.experimentell, true);
    assert.match(r.hinweis, /nur lesend/); assert.match(r.hinweis, /snapshots\.system\.standard/);
    assert.throws(() => u.reg.vorbereiten('snapshots.system.startmenue', {}, K.fabian), (e) => e.code === 'E_RECHTE');
    process.env.FAHNAS_GRUB_CFG = path.join(u.w, 'fehlt.cfg');
    await assert.rejects(u.auf('snapshots.system.startmenue', {}, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.deepEqual(startmenueParsen('nix'), []);
  } finally { if (alt === undefined) delete process.env.FAHNAS_GRUB_CFG; else process.env.FAHNAS_GRUB_CFG = alt; }
});

test('snapper: Konfigurationstext, Rendern idempotent, Timer, stündliches Aufräumen, SNAPPER_CONFIGS, plan.setzen/apply', async () => {
  const u = await umgebung();
  const ordner = path.join(u.w, 'snapper'); const standard = path.join(u.w, 'default-snapper'); const systemd = path.join(u.w, 'systemd');
  await fs.writeFile(standard, '## Pfad\nSNAPPER_CONFIGS=""\n');
  const alt = [process.env.FAHNAS_SNAPPER, process.env.FAHNAS_SNAPPER_DEFAULT, process.env.FAHNAS_SYSTEMD];
  process.env.FAHNAS_SNAPPER = ordner; process.env.FAHNAS_SNAPPER_DEFAULT = standard; process.env.FAHNAS_SYSTEMD = systemd;
  try {
    const t = snapperKonfigText({ ziel: 'system', zeitplan: { stuendlich: false, taeglich: true, woechentlich: true }, behalten: { stuendlich: 0, taeglich: 7, woechentlich: 4, pre_post: 12 } });
    for (const z of ['SUBVOLUME="/"', 'TIMELINE_CREATE="yes"', 'TIMELINE_LIMIT_HOURLY="0"', 'TIMELINE_LIMIT_DAILY="7"', 'TIMELINE_LIMIT_WEEKLY="4"', 'NUMBER_LIMIT="12"', 'NUMBER_LIMIT_IMPORTANT="12"', 'TIMELINE_CLEANUP="yes"']) assert.ok(t.includes(z + '\n'), z);
    assert.ok(t.startsWith('# Erzeugt von FAH-NAS'));
    const t0 = snapperKonfigText(null);
    assert.ok(t0.includes('TIMELINE_CREATE="no"') && t0.includes('NUMBER_LIMIT="10"'));
    assert.ok(snapperKonfigText({ zeitplan: { stuendlich: true }, behalten: {} }).includes('TIMELINE_LIMIT_HOURLY="24"'), '0/fehlend → Standard');
    const tm = snapperKonfigText({ zeitplan: { monatlich: true }, behalten: { monatlich: 6 } });
    assert.ok(tm.includes('TIMELINE_CREATE="yes"\n') && tm.includes('TIMELINE_LIMIT_MONTHLY="6"\n') && tm.includes('TIMELINE_LIMIT_DAILY="0"\n'), 'nur monatlich');
    assert.ok(t.includes('TIMELINE_LIMIT_MONTHLY="0"\n'), 'monatlich aus → 0');

    const r1 = await rendereSnapper({ zeitplan: { taeglich: true }, behalten: { taeglich: 5 } }, { system: u.werkzeuge.system });
    assert.equal(r1.datei, path.join(ordner, 'root')); assert.equal(r1.geaendert, true); assert.equal(r1.timer, true);
    assert.ok((await fs.readFile(r1.datei, 'utf8')).includes('TIMELINE_LIMIT_DAILY="5"'));
    assert.equal(await fs.readFile(standard, 'utf8'), '## Pfad\nSNAPPER_CONFIGS="root"\n');
    assert.equal(r1.aufraeumen, true);
    assert.equal(await fs.readFile(path.join(systemd, 'snapper-cleanup.timer.d', 'fahnas-stuendlich.conf'), 'utf8'), AUFRAEUMEN_TEXT);
    assert.ok(AUFRAEUMEN_TEXT.includes('OnBootSec=\nOnUnitActiveSec=\nOnBootSec=10m\nOnCalendar=*-*-* *:30:00\n'), 'Auslöser zurücksetzen, dann fester Stundentakt + nach dem Start');
    assert.ok(!/OnUnitActiveSec=1h/.test(AUFRAEUMEN_TEXT), 'kein „1 h nach dem letzten Lauf“ mehr – nach einem Neustart gibt es keinen');
    assert.deepEqual(u.aufrufe.filter((a) => a[0] === 'systemctl'), [['systemctl', 'daemon-reload'], ['systemctl', 'enable', '--now', 'snapper-timeline.timer', 'snapper-cleanup.timer'], ['systemctl', 'restart', 'snapper-cleanup.timer']]);
    u.aufrufe.length = 0;
    const r2 = await rendereSnapper({ zeitplan: { taeglich: true }, behalten: { taeglich: 5 } }, { system: u.werkzeuge.system });
    assert.equal(r2.geaendert, false, 'zweiter Lauf ändert nichts');
    assert.equal(r2.aufraeumen, false);
    assert.deepEqual(u.aufrufe.filter((a) => a[0] === 'systemctl'), [['systemctl', 'enable', '--now', 'snapper-timeline.timer', 'snapper-cleanup.timer']], 'ohne Änderung kein Neuladen');
    assert.equal((await fs.readdir(ordner)).filter((n) => n.endsWith('.tmp')).length, 0);

    // plan.setzen: speichert, rendert, startet den Takt
    u.aufrufe.length = 0;
    assert.throws(() => u.reg.vorbereiten('snapshots.plan.setzen', { ziel: 'system', zeitplan: { taeglich: true }, behalten: { taeglich: -1 } }, K.chef), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('snapshots.plan.setzen', { ziel: 'nix', zeitplan: {}, behalten: {} }, K.chef), (e) => e.code === 'E_NICHT_GEFUNDEN');
    const { ergebnis: p } = await u.auf('snapshots.plan.setzen', { ziel: 'system', zeitplan: { stuendlich: true, taeglich: true }, behalten: { stuendlich: 6, taeglich: 3 } }, K.chef);
    assert.deepEqual(p.plan, { ziel: 'system', zeitplan: { stuendlich: true, taeglich: true, woechentlich: false, monatlich: false }, behalten: { stuendlich: 6, taeglich: 3, woechentlich: 0, monatlich: 0, pre_post: 0 } });
    assert.deepEqual(p.gerendert, [path.join(ordner, 'root')]);
    assert.ok((await fs.readFile(path.join(ordner, 'root'), 'utf8')).includes('TIMELINE_LIMIT_HOURLY="6"'));
    assert.ok(_test.laeuft(), 'Minutentakt läuft');
    const gespeichert = await u.konfig.laden('snapshots.json');
    assert.equal(gespeichert.plaene.length, 1); assert.equal(gespeichert.plaene[0].behalten.taeglich, 3);
    assert.deepEqual((await u.auf('snapshots.plan.lesen', {}, K.chef)).ergebnis, gespeichert);
    // Plan für Freigabe: apply legt bei Fälligkeit sofort an (Uhr gestellt)
    _test.setzeJetzt(() => new Date(2026, 8, 25, 10, 0));
    await u.auf('snapshots.plan.setzen', { ziel: 'medien', zeitplan: { stuendlich: true }, behalten: { stuendlich: 3 } }, K.chef);
    assert.equal((await u.konfig.laden('snapshots.json')).plaene.length, 2);
    assert.ok(u.aufrufe.some((a) => a[0] === 'btrfs' && a[1] === 'subvolume' && a[2] === 'snapshot' && a.at(-1).endsWith('-plan')));
    assert.throws(() => u.reg.vorbereiten('snapshots.apply', {}, K.chef), (e) => e.code === 'E_RECHTE');
    const { ergebnis: a } = await u.auf('snapshots.apply', {}, K.system);
    assert.deepEqual(a.gerendert, [path.join(ordner, 'root')]); assert.equal(a.zeitplan, 'aktiv'); assert.deepEqual(a.angelegt, []);
  } finally {
    _test.stoppen(); _test.setzeJetzt(null);
    for (const [i, n] of ['FAHNAS_SNAPPER', 'FAHNAS_SNAPPER_DEFAULT', 'FAHNAS_SYSTEMD'].entries()) { if (alt[i] === undefined) delete process.env[n]; else process.env[n] = alt[i]; }
  }
});
