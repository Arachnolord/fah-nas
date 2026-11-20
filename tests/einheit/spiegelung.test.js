// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Spiegelung: Regeln (Prüfen, Planzeitpunkte, Befehlszeilen, Auswertung, Papierkorb), echte Läufe mit rsync und
// unison in Testordnern (nur Linux mit beiden Werkzeugen), Aktionen speichern/liste/verlauf/loeschen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import {
  relPfad, verschachtelt, zeitenNormal, tageNormal, auftragNormal, artVon, ordnerNameNormal, freigabeFernNormal, faelligerZeitpunkt, naechsterZeitpunkt, stempel, papierkorbAlt,
  rsyncArgumente, unisonArgumente, rsyncStatistik, rsyncFortschritt, unisonStatistik, vorschauZusammenfassen, ausnahmeMuster, FAT_FS,
} from '../../src/agent/spiegelung/regeln.js';
import { laufen, papierkorbAufraeumen, istNichtAngeschlossen, ausnahmenVor1980 } from '../../src/agent/spiegelung/abgleich.js';
import { registriere, anstossen, unisonOrdner, waechterAbgleichen, _test } from '../../src/agent/aktionen/spiegelung.js';
import { Waechter } from '../../src/agent/spiegelung/waechter.js';
import { EventEmitter } from 'node:events';

const BASIS = { name: 'Test', quelle: { freigabe: 'private', pfad: 'a' }, ziel: { freigabe: 'usb', pfad: 'b' }, richtung: 'einseitig', ausloeser: 'zeitplan', tage: [1, 3], zeiten: ['05:00'] };

test('spiegelung: Pfade und Verschachtelung', () => {
  assert.equal(relPfad('/fah-sicherung/'), 'fah-sicherung');
  assert.equal(relPfad(' a // b '), 'a/b');
  assert.equal(relPfad(''), '');
  assert.throws(() => relPfad('a/../b'), /nicht erlaubt/);
  assert.throws(() => relPfad('a\u0000b'), /unerlaubte/);
  const s = (freigabe, pfad) => ({ freigabe, pfad });
  assert.ok(verschachtelt(s('x', 'a'), s('x', 'a')));
  assert.ok(verschachtelt(s('x', 'a'), s('x', 'a/b')));
  assert.ok(verschachtelt(s('x', ''), s('x', 'a')));
  assert.ok(!verschachtelt(s('x', 'a'), s('x', 'ab')));
  assert.ok(!verschachtelt(s('x', 'a'), s('y', 'a')));
});

test('spiegelung: Auftrag normalisieren und prüfen', () => {
  const a = auftragNormal({ ...BASIS, zeiten: ['5:00', '17:30', '05:00'], tage: [0, 1, 1] }, { id: 's-abcdef', jetzt: new Date('2026-10-11T10:00:00Z') });
  assert.deepEqual(a.zeiten, ['05:00', '17:30']);
  assert.deepEqual(a.tage, [1, 0], 'Montag zuerst, Sonntag zuletzt');
  assert.equal(a.wartezeit_min, 2); assert.equal(a.aktiv, true); assert.equal(a.erstellt, '2026-10-11T10:00:00.000Z');
  assert.throws(() => auftragNormal({ ...BASIS, ziel: { freigabe: 'private', pfad: 'a/x' } }, { id: 's-abcdef' }), /ineinander/);
  assert.throws(() => auftragNormal({ ...BASIS, tage: [] }, { id: 's-abcdef' }), /Wochentag/);
  assert.throws(() => auftragNormal({ ...BASIS, zeiten: ['25:00'] }, { id: 's-abcdef' }), /ungültig/);
  assert.throws(() => auftragNormal({ ...BASIS, richtung: 'quer' }, { id: 's-abcdef' }), /Richtung/);
  assert.throws(() => auftragNormal({ ...BASIS, name: ' ' }, { id: 's-abcdef' }), /Namen/);
  assert.throws(() => auftragNormal({ ...BASIS, ausloeser: 'aenderung', wartezeit_min: 0 }, { id: 's-abcdef' }), /Wartezeit/);
  const hand = auftragNormal({ ...BASIS, ausloeser: 'hand', tage: [], zeiten: [] }, { id: 's-abcdef' });
  assert.equal(hand.ausloeser, 'hand');
  assert.deepEqual(zeitenNormal([]), []); assert.deepEqual(tageNormal([6, 0]), [6, 0]);
});

test('spiegelung: Art Sicherung oder Spiegelung (09.11.2026) – Bestand, Vorgabe, nur einseitig als Sicherung', () => {
  // Bestand ohne Feld: nur das Assistenten-Ziel FAH-NAS/<Quelle> ist eine Sicherung, alles andere kam über „Neue Spiegelung“
  assert.equal(artVon({ richtung: 'einseitig', ziel: { freigabe: '1500gb', pfad: 'Projekte' } }), 'spiegelung');
  assert.equal(artVon({ richtung: 'einseitig', ziel: { freigabe: '1500gb', pfad: 'FAH-NAS/private' } }), 'sicherung');
  assert.equal(artVon({ richtung: 'einseitig', ziel: { freigabe: '1500gb', pfad: 'FAH-NASx' } }), 'spiegelung');
  assert.equal(artVon({ richtung: 'beidseitig', ziel: { freigabe: 'x', pfad: 'FAH-NAS/p' } }), 'spiegelung');
  assert.equal(artVon({ art: 'sicherung', richtung: 'einseitig', ziel: { freigabe: 'x', pfad: 'y' } }), 'sicherung');
  assert.equal(auftragNormal(BASIS, { id: 's-abcdef' }).art, 'spiegelung');
  assert.equal(auftragNormal({ ...BASIS, ziel: { freigabe: 'usb', pfad: 'FAH-NAS/private/a' } }, { id: 's-abcdef' }).art, 'sicherung');
  assert.equal(auftragNormal({ ...BASIS, richtung: 'beidseitig' }, { id: 's-abcdef' }).art, 'spiegelung');
  assert.equal(auftragNormal({ ...BASIS, art: 'sicherung' }, { id: 's-abcdef' }).art, 'sicherung');
  // Bearbeiten ohne Feld behält die gespeicherte Art
  const vorher = auftragNormal({ ...BASIS, art: 'sicherung' }, { id: 's-abcdef' });
  assert.equal(auftragNormal(BASIS, { id: 's-abcdef', vorher }).art, 'sicherung');
  assert.throws(() => auftragNormal({ ...BASIS, art: 'sicherung', richtung: 'beidseitig' }, { id: 's-abcdef' }), /nur in eine Richtung/);
  assert.throws(() => auftragNormal({ ...BASIS, art: 'kopie' }, { id: 's-abcdef' }), /Art/);
});

test('spiegelung: Name für einen neuen Ordner in der Ordnerwahl', () => {
  assert.equal(ordnerNameNormal('  Backups 2026 '), 'Backups 2026');
  assert.equal(ordnerNameNormal('Fotos – Ä'), 'Fotos – Ä');
  for (const falsch of ['@Archiv', '#recycle', '', '   ', 'a/b', 'a\\b', '..', '.', '.versteckt', 'ende.', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\u0000b', 'x'.repeat(256)]) {
    assert.throws(() => ordnerNameNormal(falsch), undefined, JSON.stringify(falsch));
  }
});

test('spiegelung/fern: Freigabenamen mit Komma gehen nicht an mount.cifs (Prüfbericht 09.11.2026)', () => {
  assert.equal(freigabeFernNormal('1TB'), '1TB');
  assert.equal(freigabeFernNormal('Docker Projekte'), 'Docker Projekte');
  for (const falsch of ['daten,mfsymlinks', 'a/b', '', 'x'.repeat(81), 'a:b']) assert.throws(() => freigabeFernNormal(falsch), /Freigabe/, falsch);
  assert.deepEqual(smbFreigabenParsen('Disk|Backups|\nDisk|daten,vers=1.0|böse\nDisk|IPC$|'), [{ name: 'Backups', kommentar: '' }]);
});

test('spiegelung: Planzeitpunkte – fällig, nachholen höchstens 24 h, nächster Lauf', () => {
  const a = { ausloeser: 'zeitplan', tage: [0, 1, 2, 3, 4, 5, 6], zeiten: ['05:00', '17:00'] };
  const jetzt = new Date(2026, 9, 11, 5, 0, 20); // Ortszeit So 11.10. 05:00:20
  const f = faelligerZeitpunkt(a, jetzt, null);
  assert.equal(f, new Date(2026, 9, 11, 5, 0, 0).getTime());
  assert.equal(faelligerZeitpunkt(a, jetzt, f), null, 'schon bedient');
  // NAS war aus: um 12:00 ist 05:00 der jüngste verpasste Zeitpunkt → einmal nachholen
  assert.equal(faelligerZeitpunkt(a, new Date(2026, 9, 11, 12, 0, 0), new Date(2026, 9, 10, 17, 0, 0).getTime()), new Date(2026, 9, 11, 5, 0, 0).getTime());
  // nur Montag: am Sonntag nichts fällig
  assert.equal(faelligerZeitpunkt({ ...a, tage: [1] }, jetzt, null), null);
  assert.equal(naechsterZeitpunkt(a, jetzt), new Date(2026, 9, 11, 17, 0, 0).getTime());
  assert.equal(naechsterZeitpunkt({ ...a, tage: [1] }, jetzt), new Date(2026, 9, 12, 5, 0, 0).getTime());
  assert.equal(naechsterZeitpunkt({ ausloeser: 'hand' }, jetzt), null);
});

test('spiegelung: Stempel und Papierkorb-Auswahl (30 Tage)', () => {
  assert.equal(stempel(new Date(2026, 9, 11, 5, 3, 9)), '2026-10-11_050309');
  const jetzt = new Date(2026, 9, 11, 12, 0, 0);
  assert.deepEqual(papierkorbAlt(['2026-09-10_050000', '2026-09-12_050000', 'fremd', '2026-10-11_050000'], jetzt), ['2026-09-10_050000']);
});

test('spiegelung: Befehlszeilen für rsync und unison', () => {
  const r = rsyncArgumente({ quelle: '/q', ziel: '/z/', einfach: true, vorschau: false, papierkorbOrdner: '/z/.fah-papierkorb/x' });
  assert.deepEqual(r.slice(0, 2), ['-rt', '--modify-window=2']);
  assert.ok(r.includes('--delete') && r.includes('--backup') && r.includes('--backup-dir=/z/.fah-papierkorb/x'));
  assert.ok(r.includes('--exclude=/.fah-papierkorb/') && r.includes('--exclude=/.papierkorb/'));
  assert.deepEqual(r.slice(-2), ['/q/', '/z/']);
  const p = rsyncArgumente({ quelle: '/q', ziel: '/z', einfach: false, vorschau: true, papierkorbOrdner: '/z/.fah-papierkorb/x' });
  assert.deepEqual(p.slice(0, 2), ['-aH', '--numeric-ids']);
  assert.ok(p.includes('--dry-run') && p.includes('--itemize-changes') && !p.includes('--info=progress2'));
  const u = unisonArgumente({ a: '/a', b: '/b', fat: true, papierkorbOrdner: '/b/.fah-papierkorb/x' });
  assert.deepEqual(u.slice(0, 2), ['/a', '/b']);
  for (const x of ['-batch', '-auto', '-copyonconflict', '-fat', '-ignorelocks']) assert.ok(u.includes(x), x);
  assert.equal(u[u.indexOf('-prefer') + 1], 'newer');
  assert.equal(u[u.indexOf('-backupdir') + 1], '/b/.fah-papierkorb/x');
  assert.equal(u[u.indexOf('-backup') + 1], 'Name *');
});

test('spiegelung: Ausgaben auswerten', () => {
  const stats = 'Number of files: 1,234 (reg: 1,000, dir: 234)\nNumber of created files: 12\nNumber of deleted files: 3\nNumber of regular files transferred: 15\nTotal file size: 9,999,999 bytes\nTotal transferred file size: 123,456 bytes\n';
  assert.deepEqual(rsyncStatistik(stats), { dateien: 1234, neu: 12, geloescht: 3, uebertragen: 15, bytes_gesamt: 9999999, bytes_uebertragen: 123456 });
  assert.equal(rsyncFortschritt('    1,234,567  45%   12.34MB/s    0:00:10 (xfr#3, to-chk=0/10)'), 0.45);
  assert.equal(rsyncFortschritt('sending incremental file list'), null);
  assert.deepEqual(unisonStatistik('Synchronization complete at 11:34:01  (3 items transferred, 1 skipped, 0 failed)'), { uebertragen: 3, uebersprungen: 1, fehlgeschlagen: 0 });
  const v = vorschauZusammenfassen(['cd+++++++++ neu/', '>f+++++++++ neu/a.txt', '>f.st...... alt.txt', '*deleting   weg.txt', 'sent 1 bytes']);
  assert.equal(v.neu, 1); assert.equal(v.geaendert, 1); assert.equal(v.geloescht, 1); assert.equal(v.ordner_neu, 1);
  assert.deepEqual(v.zeilen, ['+ neu/a.txt', '~ alt.txt', '− weg.txt']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Echte Läufe (Linux mit rsync + unison)
// ---------------------------------------------------------------------------------------------------------------------

async function werkzeugeDa() { return process.platform === 'linux' && await system.existiert('/usr/bin/rsync') && await system.existiert('/usr/bin/unison'); }

async function umgebung({ extern = [] } = {}) {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-spiegel-'));
  const shares = path.join(wurzel, 'shares'); const konfigOrdner = path.join(wurzel, 'konfig');
  for (const n of ['private', 'usb']) await fs.mkdir(path.join(shares, n), { recursive: true });
  const konfig = new Konfig(konfigOrdner); await konfig.sicherstellen();
  await konfig.speichern('shares.json', { freigaben: [{ name: 'private' }, { name: 'usb', extern: extern.includes('usb') }] });
  const ereignisse = [];
  const w = { konfig, system, pfade: { shares, konfig: konfigOrdner }, ereignis: (art, d) => ereignisse.push({ art, ...d }), konfigGeaendert: () => {} };
  return { wurzel, shares, w, ereignisse, aufraeumen: () => fs.rm(wurzel, { recursive: true, force: true }) };
}

test('spiegelung: einseitig mit rsync – Kopie, Papierkorb, Leer-Schutz, Vorschau', async (t) => {
  if (!await werkzeugeDa()) { t.skip('rsync/unison fehlen (nur auf dem NAS)'); return; }
  const u = await umgebung();
  try {
    const q = path.join(u.shares, 'private', 'a'); const z = path.join(u.shares, 'usb', 'b');
    await fs.mkdir(path.join(q, 'sub'), { recursive: true });
    await fs.writeFile(path.join(q, 'sub', 'x.txt'), 'eins'); await fs.writeFile(path.join(q, 'y.txt'), 'zwei');
    await fs.mkdir(path.join(u.shares, 'private', '.papierkorb'), { recursive: true });
    const a = auftragNormal({ ...BASIS, ausloeser: 'hand' }, { id: 's-test01' });
    const v = await laufen(u.w, a, { vorschau: true, unisonOrdner: path.join(u.wurzel, 'uni') });
    assert.equal(v.vorschau.neu, 2);
    await assert.rejects(fs.access(z), 'Vorschau legt nichts an');
    const r1 = await laufen(u.w, a, { unisonOrdner: path.join(u.wurzel, 'uni'), jetzt: new Date(2026, 9, 11, 5, 0, 0) });
    assert.equal(r1.ergebnis, 'ok');
    assert.equal(await fs.readFile(path.join(z, 'sub', 'x.txt'), 'utf8'), 'eins');
    // Löschen + Ändern in der Quelle → altes Ziel landet im Papierkorb
    await fs.rm(path.join(q, 'sub', 'x.txt')); await fs.writeFile(path.join(q, 'y.txt'), 'zwei-neu');
    const r2 = await laufen(u.w, a, { unisonOrdner: path.join(u.wurzel, 'uni'), jetzt: new Date(2026, 9, 12, 5, 0, 0) });
    assert.equal(r2.zahlen.geloescht, 1);
    assert.equal(await fs.readFile(path.join(z, 'y.txt'), 'utf8'), 'zwei-neu');
    // Genau ein Papierkorb je Freigabe: in der Wurzel, Pfade relativ zur Freigabe wie im Dateimanager
    const wurzelZiel = path.join(u.shares, a.ziel.freigabe);
    const vorgang = path.join(wurzelZiel, '.papierkorb', 'spiegelung-s-test01-2026-10-12_050000');
    const korb = path.join(vorgang, path.relative(wurzelZiel, z));
    assert.equal(await fs.readFile(path.join(korb, 'sub', 'x.txt'), 'utf8'), 'eins');
    assert.equal(await fs.readFile(path.join(korb, 'y.txt'), 'utf8'), 'zwei');
    await assert.rejects(fs.access(path.join(z, '.fah-papierkorb')), 'kein Papierkorb mehr im Zielordner');
    const info = JSON.parse(await fs.readFile(path.join(vorgang, 'papierkorb.json'), 'utf8'));
    assert.equal(info.grund, 'spiegelung');
    assert.match(info.nutzer, /^Spiegelung: /);
    assert.deepEqual(info.eintraege.map((e) => e.pfad).sort(), [
      path.join(path.relative(wurzelZiel, z), 'sub', 'x.txt'), path.join(path.relative(wurzelZiel, z), 'y.txt')].sort());
    // Lauf ohne Änderung hinterlässt keinen leeren Vorgang
    await laufen(u.w, a, { unisonOrdner: path.join(u.wurzel, 'uni'), jetzt: new Date(2026, 9, 13, 5, 0, 0) });
    await assert.rejects(fs.access(path.join(wurzelZiel, '.papierkorb', 'spiegelung-s-test01-2026-10-13_050000')));
    // Papierkorb nach 30 Tagen leeren
    assert.deepEqual(await papierkorbAufraeumen(u.w, a, new Date(2026, 10, 20)), ['2026-10-12_050000']);
    // Leer-Schutz: Quelle leer, Ziel voll → Abbruch, Ziel bleibt
    await fs.rm(q, { recursive: true }); await fs.mkdir(q);
    await assert.rejects(laufen(u.w, a, { unisonOrdner: path.join(u.wurzel, 'uni') }), /Quelle ist leer/);
    assert.equal(await fs.readFile(path.join(z, 'y.txt'), 'utf8'), 'zwei-neu');
  } finally { await u.aufraeumen(); }
});

test('spiegelung: beidseitig mit unison – beide Richtungen, Konflikt, Papierkorb', async (t) => {
  if (!await werkzeugeDa()) { t.skip('rsync/unison fehlen (nur auf dem NAS)'); return; }
  const u = await umgebung();
  try {
    const q = path.join(u.shares, 'private', 'a'); const z = path.join(u.shares, 'usb', 'b');
    await fs.mkdir(q, { recursive: true }); await fs.mkdir(z, { recursive: true });
    await fs.writeFile(path.join(q, 'y.txt'), 'zwei'); await fs.writeFile(path.join(z, 'z.txt'), 'drei');
    const a = auftragNormal({ ...BASIS, richtung: 'beidseitig', ausloeser: 'hand' }, { id: 's-test02' });
    const uni = path.join(u.wurzel, 'uni');
    assert.equal((await laufen(u.w, a, { unisonOrdner: uni, jetzt: new Date(2026, 9, 11, 5, 0, 0) })).ergebnis, 'ok');
    assert.equal(await fs.readFile(path.join(q, 'z.txt'), 'utf8'), 'drei');
    assert.equal(await fs.readFile(path.join(z, 'y.txt'), 'utf8'), 'zwei');
    await fs.writeFile(path.join(q, 'y.txt'), 'zwei-A');
    const spaeter = new Date(Date.now() + 5000);
    await fs.writeFile(path.join(z, 'y.txt'), 'zwei-B'); await fs.utimes(path.join(z, 'y.txt'), spaeter, spaeter);
    await fs.rm(path.join(z, 'z.txt'));
    await laufen(u.w, a, { unisonOrdner: uni, jetzt: new Date(2026, 9, 12, 5, 0, 0) });
    assert.equal(await fs.readFile(path.join(q, 'y.txt'), 'utf8'), 'zwei-B', 'neuere Fassung gewinnt');
    const namen = await fs.readdir(q);
    assert.ok(namen.some((n) => /^y \(conflict_on_.*\)\.txt$/.test(n)), `Konfliktkopie fehlt: ${namen}`);
    await assert.rejects(fs.access(path.join(q, 'z.txt')), 'Löschung wandert mit');
    const zw = path.join(u.shares, a.ziel.freigabe);
    assert.equal(await fs.readFile(path.join(zw, '.papierkorb', 'spiegelung-s-test02-2026-10-12_050000', path.relative(zw, z), 'z.txt'), 'utf8'), 'drei');
  } finally { await u.aufraeumen(); }
});

test('spiegelung: externes Laufwerk nicht eingehängt → übersprungen (nachholen)', async () => {
  const u = await umgebung({ extern: ['usb'] });
  try {
    const a = auftragNormal({ ...BASIS, ausloeser: 'hand' }, { id: 's-test03' });
    await fs.mkdir(path.join(u.shares, 'private', 'a'), { recursive: true });
    const e = await laufen(u.w, a, { unisonOrdner: path.join(u.wurzel, 'uni') }).then(() => null, (x) => x);
    assert.ok(istNichtAngeschlossen(e), `erwartet „nicht angeschlossen“, bekam ${e && e.message}`);
    await assert.rejects(fs.access(path.join(u.shares, 'usb', 'b')), 'nichts ins leere Einhängeverzeichnis geschrieben');
  } finally { await u.aufraeumen(); }
});

test('spiegelung: Aktionen speichern, liste, starten, verlauf, loeschen', async (t) => {
  const u = await umgebung();
  try {
    const reg = new Register(); registriere(reg, u.w);
    const k = { nutzer: 'chef', rolle: 'admin', ip: '-' };
    const rufe = async (name, params) => { const { aktion, params: p } = reg.vorbereiten(name, params, k); return aktion.ausfuehren(p, k, u.w); };
    await assert.rejects(rufe('spiegelung.speichern', { ...BASIS, quelle: { freigabe: 'gibtsnicht', pfad: '' } }), /gibt es nicht/);
    const a = await rufe('spiegelung.speichern', { ...BASIS, ausloeser: 'hand' });
    assert.match(a.id, /^s-[a-f0-9]{10}$/);
    let l = await rufe('spiegelung.liste', {});
    assert.equal(l.auftraege.length, 1); assert.equal(l.auftraege[0].zustand.laeuft, false);
    const b = await rufe('spiegelung.speichern', { ...BASIS, id: a.id, name: 'Neu', ausloeser: 'hand' });
    assert.equal(b.erstellt, a.erstellt); assert.equal(b.name, 'Neu');
    if (await werkzeugeDa()) {
      await fs.mkdir(path.join(u.shares, 'private', 'a'), { recursive: true });
      await fs.writeFile(path.join(u.shares, 'private', 'a', 'd.txt'), 'x');
      assert.deepEqual(await rufe('spiegelung.starten', { id: a.id }), { gestartet: true });
      assert.deepEqual(anstossen(u.w, b, 'hand'), { gestartet: false, nochmal: true }, 'zweiter Anstoß stapelt nicht');
      for (let i = 0; i < 100 && _test.lauf.size; i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 100 && _test.lauf.size; i++) await new Promise((r) => setTimeout(r, 100)); // Nachlauf
      const v = await rufe('spiegelung.verlauf', { id: a.id });
      assert.ok(v.laeufe.length >= 1); assert.equal(v.laeufe.at(-1).ergebnis, 'ok');
      l = await rufe('spiegelung.liste', {});
      assert.equal(l.auftraege[0].zustand.letzter.ergebnis, 'ok');
      assert.ok(u.ereignisse.some((e) => e.art === 'spiegelung' && e.zustand === 'fertig'));
    }
    await fs.mkdir(unisonOrdner(u.w, a.id), { recursive: true });
    await fs.writeFile(path.join(unisonOrdner(u.w, a.id), 'ar123'), 'alt');
    await rufe('spiegelung.speichern', { ...BASIS, id: a.id, name: 'Neu', ausloeser: 'hand', ziel: { freigabe: 'usb', pfad: 'anders' } });
    await assert.rejects(fs.access(unisonOrdner(u.w, a.id)), 'Ordnerwechsel verwirft das unison-Archiv');
    await fs.mkdir(unisonOrdner(u.w, a.id), { recursive: true });
    assert.deepEqual(await rufe('spiegelung.loeschen', { id: a.id }), { geloescht: true });
    await assert.rejects(fs.access(unisonOrdner(u.w, a.id)), 'Löschen verwirft das unison-Archiv');
    assert.equal((await rufe('spiegelung.liste', {})).auftraege.length, 0);
  } finally { await u.aufraeumen(); }
});

test('spiegelung: Wächter fasst Änderungen zusammen und verwirft keine (auch nicht direkt nach einem Lauf)', async () => {
  const kinder = [];
  const schein = { starten: (prog, args) => { const k = new EventEmitter(); k.stdout = new EventEmitter(); k.stderr = new EventEmitter(); k.args = [prog, ...args]; k.kill = () => k.emit('close', null, 'SIGTERM'); kinder.push(k); return k; } };
  let ausgeloest = 0;
  const wa = new Waechter({ system: schein, pfade: ['/a', '/b'], wartezeit_ms: 60, ausloesen: () => { ausgeloest++; } });
  wa.starten();
  assert.equal(kinder.length, 1);
  assert.deepEqual(kinder[0].args.slice(-3), ['--', '/a', '/b']);
  assert.ok(kinder[0].args.includes('-r') && kinder[0].args.includes('-m'));
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) { kinder[0].stdout.emit('data', Buffer.from('/a/x\n')); await warte(10); }
  assert.equal(ausgeloest, 0, 'während der Änderungen noch nicht');
  await warte(120);
  assert.equal(ausgeloest, 1, 'fünf Änderungen → ein Lauf');
  // Eigene Pfade (Papierkorb, unison-Temp) zählen nie – sonst Lauf jede Minute (Praxistest-Fund 11.10.)
  kinder[0].stdout.emit('data', Buffer.from('/b/.fah-papierkorb\n/b/.fah-papierkorb/2026-10-11_120000/y.txt\n/a/.unison.y.txt.123.unison.tmp\n/a/.papierk'));
  kinder[0].stdout.emit('data', Buffer.from('orb/z\n'));
  await warte(120);
  assert.equal(ausgeloest, 1, 'eigene Pfade lösen nichts aus (auch über Datenblöcke hinweg zerteilt)');
  // Änderung unmittelbar nach dem Lauf (Praxistest-Fund 11.10.) → wird nicht verworfen
  kinder[0].stdout.emit('data', Buffer.from('/a/w.txt\n'));
  await warte(120);
  assert.equal(ausgeloest, 2);
  assert.equal(wa.zustand().aktiv, true);
  wa.stoppen();
  assert.equal(wa.zustand().aktiv, false);
  kinder[0].stdout.emit('data', Buffer.from('/a/y\n'));
  await warte(120);
  assert.equal(ausgeloest, 2, 'gestoppt → nichts mehr');
});

test('spiegelung: gleichzeitige Wächter-Abgleiche legen nur EINEN Wächter an (Start + Speichern)', async () => {
  const u = await umgebung();
  let gestartet = 0;
  u.w.system = { ...system, starten: () => { gestartet++; const k = new EventEmitter(); k.stdout = new EventEmitter(); k.stderr = new EventEmitter(); k.kill = () => k.emit('close', null, 'SIGTERM'); return k; } };
  try {
    const reg = new Register(); registriere(reg, u.w);
    const k = { nutzer: 'chef', rolle: 'admin', ip: '-' };
    const { aktion, params } = reg.vorbereiten('spiegelung.speichern', { ...BASIS, ausloeser: 'aenderung', tage: [], zeiten: [] }, k);
    const a = await Promise.all([aktion.ausfuehren(params, k, u.w), waechterAbgleichen(u.w), waechterAbgleichen(u.w)]).then((r) => r[0]);
    await waechterAbgleichen(u.w);
    assert.equal(gestartet, 1, 'genau ein inotifywait');
    assert.ok(_test.waechter.has(a.id));
    const { aktion: loe, params: lp } = reg.vorbereiten('spiegelung.loeschen', { id: a.id }, k);
    await loe.ausfuehren(lp, k, u.w);
    assert.ok(!_test.waechter.has(a.id), 'Löschen stoppt den Wächter');
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Andere NAS (SMB) – 12.10.2026
// ---------------------------------------------------------------------------------------------------------------------
import {
  seiteNormal, zugangNormal, zugangAnsicht, zugangsdatei, mountArgumente, mountFehlerDeuten, smbFreigabenParsen,
} from '../../src/agent/spiegelung/regeln.js';

test('spiegelung/fern: Seiten mit Verbindung, Verschachtelung je Ort, Auslöser-Regel', () => {
  assert.deepEqual(seiteNormal({ zugang: 'z-0123456789', freigabe: 'Back ups', pfad: '/a/' }, 'ziel'), { zugang: 'z-0123456789', freigabe: 'Back ups', pfad: 'a' });
  assert.throws(() => seiteNormal({ zugang: 'z-0123456789', freigabe: 'a/b' }, 'ziel'), /Freigabe/);
  assert.throws(() => seiteNormal({ zugang: 'boese', freigabe: 'x' }, 'ziel'), /Verbindung/);
  assert.throws(() => seiteNormal({ freigabe: 'Back ups' }, 'ziel'), /Freigabe/, 'lokale Freigaben bleiben streng');
  assert.ok(!verschachtelt({ freigabe: 'private', pfad: '' }, { zugang: 'z-0123456789', freigabe: 'private', pfad: '' }), 'anderer Ort → nie ineinander');
  assert.ok(verschachtelt({ zugang: 'z-0123456789', freigabe: 'B', pfad: 'a' }, { zugang: 'z-0123456789', freigabe: 'B', pfad: 'a/b' }));
  const fern = { zugang: 'z-0123456789', freigabe: 'Backups', pfad: 'x' };
  assert.throws(() => auftragNormal({ ...BASIS, quelle: fern, ausloeser: 'aenderung' }, { id: 's-x' }), /Quelle auf diesem NAS/);
  assert.equal(auftragNormal({ ...BASIS, ziel: fern, ausloeser: 'aenderung', tage: [], zeiten: [] }, { id: 's-x' }).ausloeser, 'aenderung', 'fremdes Ziel, lokale Quelle → Wächter auf der Quelle');
  assert.equal(auftragNormal({ ...BASIS, quelle: fern, richtung: 'beidseitig', ausloeser: 'aenderung', tage: [], zeiten: [] }, { id: 's-x' }).ausloeser, 'aenderung', 'beidseitig mit lokalem Ziel');
});

test('spiegelung/fern: Verbindungen, Zugangsdatei, mount-Argumente, Fehler deuten, Freigabenliste', () => {
  const z = zugangNormal({ name: 'UGREEN', adresse: ' \\\\192.168.1.23\\ ', benutzer: 'fabian', passwort: 'a=b#c' }, { id: 'z-0123456789', jetzt: new Date('2026-10-12T08:00:00Z') });
  assert.equal(z.adresse, '192.168.1.23');
  assert.equal(zugangNormal({ name: 'UGREEN', adresse: '192.168.1.23', benutzer: 'fabian', passwort: '' }, { id: z.id, vorher: z }).passwort, 'a=b#c', 'leeres Passwort = unverändert');
  assert.throws(() => zugangNormal({ name: 'X', adresse: '192.168.1.23', benutzer: 'fabian', passwort: '' }, { id: z.id }), /Passwort/);
  assert.throws(() => zugangNormal({ name: 'X', adresse: 'a b', benutzer: 'fabian', passwort: 'p' }, { id: z.id }), /Adresse/);
  const ansicht = zugangAnsicht(z, 2);
  assert.ok(!('passwort' in ansicht)); assert.equal(ansicht.passwort_gesetzt, true); assert.equal(ansicht.benutzt, 2);
  assert.equal(zugangsdatei(z), 'username=fabian\npassword=a=b#c\n');
  assert.equal(zugangsdatei({ benutzer: 'WG\\fabian', passwort: 'x' }), 'username=fabian\npassword=x\ndomain=WG\n');
  const m = mountArgumente({ adresse: '192.168.1.23', freigabe: 'Back ups', ziel: '/run/x', zugangsdatei: '/run/c', nurLesen: true });
  assert.deepEqual(m.slice(0, 4), ['-t', 'cifs', '//192.168.1.23/Back ups', '/run/x']);
  assert.match(m[5], /^credentials=\/run\/c,uid=0,gid=0,.*,ro$/);
  // Ohne closetimeo=0 schließt der Kernel verzögert, das überschreibt die von rsync gesetzte Zeit (30.10.2026: 582 GB Papierkorb)
  assert.match(m[5], /(^|,)closetimeo=0(,|$)/);
  assert.ok(!m.join(' ').includes('a=b#c'), 'Passwort nie auf der Befehlszeile');
  assert.equal(mountFehlerDeuten('mount error(13): Permission denied').art, 'anmeldung');
  assert.equal(mountFehlerDeuten('mount error(112): Host is down').art, 'nicht_erreichbar');
  assert.equal(mountFehlerDeuten('mount error(2): No such file or directory').art, 'freigabe');
  assert.deepEqual(smbFreigabenParsen('Disk|Backups|\nDisk|IPC$|IPC\nPrinter|p|\nDisk|Arbeit|Daten\n').map((f) => f.name), ['Arbeit', 'Backups']);
});

test('spiegelung/fern: Verbindungs-Aktionen – ohne Passwort zurück, Datei 0600, Löschen gesperrt solange benutzt', async () => {
  const u = await umgebung();
  try {
    const reg = new Register(); registriere(reg, u.w);
    const k = { nutzer: 'chef', rolle: 'admin', ip: '-' };
    const rufe = async (name, params) => { const { aktion, params: p } = reg.vorbereiten(name, params, k); return aktion.ausfuehren(p, k, u.w); };
    const z = await rufe('spiegelung.zugang.speichern', { name: 'UGREEN', adresse: '192.168.1.23', benutzer: 'fabian', passwort: 'geheim' });
    assert.match(z.id, /^z-[a-f0-9]{10}$/); assert.ok(!('passwort' in z));
    const st = await fs.stat(path.join(u.w.pfade.konfig, 'spiegelung-zugaenge.json'));
    assert.equal(st.mode & 0o777, 0o600, 'Zugangsdaten nur für root lesbar');
    const s = await rufe('spiegelung.speichern', { ...BASIS, ausloeser: 'hand', tage: [], zeiten: [], ziel: { zugang: z.id, freigabe: 'Backups', pfad: 'test' } });
    assert.equal(s.ziel.zugang, z.id);
    const l = await rufe('spiegelung.liste', {});
    assert.deepEqual(l.zugaenge, [{ id: z.id, name: 'UGREEN', adresse: '192.168.1.23' }]);
    assert.equal((await rufe('spiegelung.zugaenge', {}))[0].benutzt, 1);
    await assert.rejects(rufe('spiegelung.zugang.loeschen', { id: z.id }), /noch benutzt/);
    await assert.rejects(rufe('spiegelung.speichern', { ...BASIS, ausloeser: 'hand', tage: [], zeiten: [], ziel: { zugang: 'z-ffffffffff', freigabe: 'B', pfad: '' } }), /gibt es nicht/);
    await rufe('spiegelung.loeschen', { id: s.id });
    assert.deepEqual(await rufe('spiegelung.zugang.loeschen', { id: z.id }), { geloescht: true });
  } finally { await u.aufraeumen(); }
});

test('spiegelung: Ältere Stände – Aufbewahrung je Auftrag, Stände auflisten, durchblättern, zurückholen (vorhandenes bleibt)', async () => {
  const u = await umgebung();
  try {
    const reg = new Register(); registriere(reg, u.w);
    const k = { nutzer: 'chef', rolle: 'admin', ip: '-' };
    const rufe = async (name, params) => { const { aktion, params: p } = reg.vorbereiten(name, params, k); return aktion.ausfuehren(p, k, u.w); };
    await assert.rejects(rufe('spiegelung.speichern', { ...BASIS, ausloeser: 'hand', versionen_tage: 12 }), (e) => e.details.feld === 'versionen_tage');
    const a = await rufe('spiegelung.speichern', { ...BASIS, ausloeser: 'hand', versionen_tage: 90 });
    assert.equal(a.versionen_tage, 90);
    const b = await rufe('spiegelung.speichern', { ...BASIS, id: a.id, name: 'Neu', ausloeser: 'hand' });
    assert.equal(b.versionen_tage, 90, 'Bearbeiten ohne Feld behält die Aufbewahrung');
    // Ziel = usb/<pfad aus BASIS>; dort zwei Stände anlegen
    const zielVoll = path.join(u.shares, a.ziel.freigabe, a.ziel.pfad || '');
    const korbWurzel = path.join(u.shares, a.ziel.freigabe, '.papierkorb');
    const standOrdner = (st, id = a.id) => path.join(korbWurzel, `spiegelung-${id}-${st}`, a.ziel.pfad || '');
    const st1 = standOrdner('2026-10-01_030000'); const st2 = standOrdner('2026-10-10_030000');
    await fs.mkdir(path.join(st1, 'fotos'), { recursive: true }); await fs.writeFile(path.join(st1, 'fotos', 'bild.jpg'), 'alt');
    await fs.mkdir(st2, { recursive: true }); await fs.writeFile(path.join(st2, 'liste.txt'), 'v1');
    await fs.mkdir(path.join(korbWurzel, 'kein-stand'), { recursive: true });
    await fs.mkdir(standOrdner('2026-10-05_030000', 's-anderer00'), { recursive: true });
    const v = await rufe('spiegelung.versionen', { id: a.id });
    assert.deepEqual(v.staende.map((s) => s.stand), ['2026-10-10_030000', '2026-10-01_030000']); assert.equal(v.tage, 90);
    const inhalt = await rufe('spiegelung.versionen.inhalt', { id: a.id, stand: '2026-10-01_030000', pfad: 'fotos' });
    assert.deepEqual(inhalt.eintraege.map((e) => [e.name, e.ordner]), [['bild.jpg', false]]);
    await assert.rejects(rufe('spiegelung.versionen.inhalt', { id: a.id, stand: '2026-10-01_030000', pfad: '../..' }), (e) => e.code === 'E_PARAMS');
    // Zurückholen: Quelle hat die Datei nicht → gleicher Name; hat sie → Name mit Stand
    const quelleVoll = path.join(u.shares, a.quelle.freigabe, a.quelle.pfad || '');
    const r1 = await rufe('spiegelung.versionen.zurueckholen', { id: a.id, stand: '2026-10-01_030000', pfad: 'fotos/bild.jpg' });
    assert.equal(r1.ziel, path.join(a.quelle.pfad || '', 'fotos', 'bild.jpg'));
    assert.equal(await fs.readFile(path.join(quelleVoll, 'fotos', 'bild.jpg'), 'utf8'), 'alt');
    await fs.writeFile(path.join(quelleVoll, 'liste.txt'), 'v2');
    const r2 = await rufe('spiegelung.versionen.zurueckholen', { id: a.id, stand: '2026-10-10_030000', pfad: 'liste.txt' });
    assert.match(r2.ziel, /liste \(Stand 2026-10-10 03\.00\)\.txt$/);
    assert.equal(await fs.readFile(path.join(quelleVoll, 'liste.txt'), 'utf8'), 'v2', 'vorhandene Datei bleibt');
  } finally { await u.aufraeumen(); }
});

test('spiegelung/korb: je Freigabe ein Papierkorb – Aufräumen, Altlasten, externe Laufwerke', async () => {
  const { korbAufraeumen, externeKoerbeAufraeumen, korbOrte } = await import('../../src/agent/spiegelung/korb.js');
  const u = await umgebung();
  try {
    const wurzel = path.join(u.shares, 'usb');
    const korb = path.join(wurzel, '.papierkorb');
    const seite = { wurzel, voll: path.join(wurzel, 'sicherung', 'fotos') };
    assert.equal(korbOrte(seite, 's-aaa', '2026-10-01_030000').inhalt, path.join(korb, 'spiegelung-s-aaa-2026-10-01_030000', 'sicherung', 'fotos'));
    assert.equal(korbOrte({ wurzel, voll: wurzel }, 's-aaa', '2026-10-01_030000').inhalt, path.join(korb, 'spiegelung-s-aaa-2026-10-01_030000'));
    const leg = async (name) => { await fs.mkdir(path.join(korb, name), { recursive: true }); await fs.writeFile(path.join(korb, name, 'a.txt'), 'x'); };
    await leg('spiegelung-s-aaa-2026-09-01_030000');   // alt, dieser Auftrag → weg
    await leg('spiegelung-s-aaa-2026-10-29_030000');   // jung → bleibt
    await leg('spiegelung-s-bbb-2026-09-01_030000');   // alt, fremder Auftrag → bleibt
    await leg('2026-09-01T03-00-00-000Z');             // Dateimanager → bleibt
    // Altlast: .fah-papierkorb im Zielordner wird abgeräumt, sobald nichts Junges mehr drin liegt
    const alt = path.join(seite.voll, '.fah-papierkorb');
    await fs.mkdir(path.join(alt, '2026-09-01_030000'), { recursive: true });
    const a = { id: 's-aaa', versionen_tage: 30 };
    assert.deepEqual((await korbAufraeumen(seite, a, new Date(2026, 9, 30))).sort(), ['2026-09-01_030000', '2026-09-01_030000']);
    await assert.rejects(fs.access(alt), 'leerer alter Papierkorb ist weg');
    assert.deepEqual((await fs.readdir(korb)).sort(), ['2026-09-01T03-00-00-000Z', 'spiegelung-s-aaa-2026-10-29_030000', 'spiegelung-s-bbb-2026-09-01_030000']);
    // Externe Laufwerke: alles älter als 30 Tage läuft ab, auch per SMB Gelöschtes; Aufträge, die es nicht mehr gibt, ebenso
    await fs.mkdir(path.join(korb, 'samba', 'ordner'), { recursive: true });
    await fs.writeFile(path.join(korb, 'samba', 'ordner', 'alt.txt'), 'x'); await fs.writeFile(path.join(korb, 'samba', 'neu.txt'), 'x');
    const lange = new Date(2026, 8, 1); await fs.utimes(path.join(korb, 'samba', 'ordner', 'alt.txt'), lange, lange);
    const geraete = { freigaben: [{ name: 'usb', extern: true }, { name: 'private', extern: false }] };
    await fs.mkdir(path.join(u.shares, 'private', '.papierkorb', '2026-09-01T03-00-00-000Z'), { recursive: true });
    const weg = await externeKoerbeAufraeumen({ pfade: u.w.pfade, konfig: { laden: async () => geraete }, system: { ausfuehren: async () => ({ code: 0, stdout: 'usb' }) } },
      { auftraege: [{ id: 's-aaa' }] }, new Date(2026, 9, 30), { eingehaengt: async () => true });
    assert.ok(weg.includes('2026-09-01T03-00-00-000Z') && weg.includes('spiegelung-s-bbb-2026-09-01_030000'), String(weg));
    assert.deepEqual((await fs.readdir(korb)).sort(), ['samba', 'spiegelung-s-aaa-2026-10-29_030000']);
    assert.deepEqual(await fs.readdir(path.join(korb, 'samba')), ['neu.txt'], 'leere Ordner verschwinden mit');
    await fs.access(path.join(u.shares, 'private', '.papierkorb', '2026-09-01T03-00-00-000Z')); // interne Freigabe unverändert
  } finally { await u.aufraeumen(); }
});

test('spiegelung: Dateien vor 1980 gehen auf exFAT nicht jedes Mal neu durch den Papierkorb', async (t) => {
  assert.equal(ausnahmeMuster('a/b.txt'), '/a/b.txt');
  assert.equal(ausnahmeMuster('a [1]/b*.txt'), '/a \\[1\\]/b\\*.txt');
  assert.ok(rsyncArgumente({ quelle: '/q', ziel: '/z', einfach: true, papierkorbOrdner: '/k', ausnahmenDatei: '/tmp/a' }).includes('--exclude-from=/tmp/a'));
  assert.ok(!rsyncArgumente({ quelle: '/q', ziel: '/z', einfach: true, papierkorbOrdner: '/k' }).some((x) => x.startsWith('--exclude-from')));
  assert.ok(FAT_FS.has('exfat') && FAT_FS.has('vfat') && !FAT_FS.has('ntfs') && !FAT_FS.has('cifs'));
  if (!await werkzeugeDa()) { t.skip('GNU find fehlt (nur auf dem NAS)'); return; }
  const u = await umgebung();
  try {
    const q = path.join(u.wurzel, 'q'); const z = path.join(u.wurzel, 'z');
    await fs.mkdir(path.join(q, 'App [1]'), { recursive: true }); await fs.mkdir(path.join(z, 'App [1]'), { recursive: true });
    const alt = new Date(1979, 11, 31);
    for (const [n, inhalt] of [['App [1]/gleich.txt', 'abc'], ['geaendert.txt', 'abc'], ['fehlt.txt', 'abc']]) { await fs.writeFile(path.join(q, n), inhalt); await fs.utimes(path.join(q, n), alt, alt); }
    await fs.writeFile(path.join(q, 'neu.txt'), 'abc');
    await fs.writeFile(path.join(z, 'App [1]', 'gleich.txt'), 'abc'); await fs.writeFile(path.join(z, 'geaendert.txt'), 'andere Länge');
    const datei = await ausnahmenVor1980(u.w, q, z);
    assert.equal(await fs.readFile(datei, 'utf8'), '/App \\[1\\]/gleich.txt\n', 'nur vorhanden + gleiche Größe');
    await fs.rm(datei);
    await fs.rm(path.join(z, 'App [1]', 'gleich.txt'));
    assert.equal(await ausnahmenVor1980(u.w, q, z), null);
  } finally { await u.aufraeumen(); }
});
