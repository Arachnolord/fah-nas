// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Namenskonflikte (Betreiber-Fund 26.09.: Hochladen überschrieb vorhandene Dateien ohne Rückfrage, ein abgebrochener
// Upload zerstörte das Original). Dateihelfer direkt im Prozess gegen echte Dateien in tmp: Hochladen über eine
// versteckte Zwischendatei (fehler/ersetzen/beide), alte Version in den Papierkorb, Verwerfen lässt das Ziel unberührt,
// vorhanden-Prüfung, Kopieren/Verschieben mit ersetzen/beide, Wiederherstellen neben eine belegte Stelle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ausfuehrenOp, UPLOAD_PRAEFIX, nameTeilen, freierName } from '../../src/agent/helfer/dateihelfer.js';

async function freigabe() {
  const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-konflikt-')));
  await fs.mkdir(path.join(w, 'ordner'));
  return w;
}
const lies = (w, rel) => fs.readFile(path.join(w, rel), 'utf8');
async function da(p) { try { await fs.lstat(p); return true; } catch { return false; } }

/** Wie der Datenkanal: pruefe_schreiben → Daten in die Zwischendatei → upload_abschliessen. */
async function hochladen(w, rel, inhalt, bei_vorhanden, papierkorb = true) {
  const ziel = await ausfuehrenOp('pruefe_schreiben', { wurzel: w, pfad: rel, bei_vorhanden });
  assert.ok(path.basename(ziel.tmp).startsWith(UPLOAD_PRAEFIX), 'Zwischendatei trägt das Präfix');
  assert.equal(path.dirname(ziel.tmp), path.dirname(ziel.pfad), 'Zwischendatei liegt im Zielordner (rename bleibt im Dateisystem)');
  await fs.writeFile(ziel.tmp, inhalt);
  return ausfuehrenOp('upload_abschliessen', { wurzel: w, pfad: rel, tmp: ziel.tmp, bei_vorhanden, papierkorb, nutzer: 'fabian' });
}

test('Namen: Endung erkennen, nächster freier Name wie im Finder', async () => {
  assert.deepEqual(nameTeilen('Bericht.pdf'), ['Bericht', '.pdf']);
  assert.deepEqual(nameTeilen('archiv.tar.gz'), ['archiv', '.tar.gz']);
  assert.deepEqual(nameTeilen('.bashrc'), ['.bashrc', '']);
  assert.deepEqual(nameTeilen('ohne'), ['ohne', '']);
  assert.deepEqual(nameTeilen('Notiz. Final'), ['Notiz. Final', '']);
  const w = await freigabe();
  try {
    assert.equal(await freierName(w, 'Bericht.pdf'), 'Bericht (1).pdf');
    await fs.writeFile(path.join(w, 'Bericht (1).pdf'), '');
    assert.equal(await freierName(w, 'Bericht.pdf'), 'Bericht (2).pdf');
    assert.equal(await freierName(w, 'Bericht (1).pdf'), 'Bericht (2).pdf', '„(1)“ zählt weiter statt „(1) (1)“');
    assert.equal(await freierName(w, 'Bericht.pdf', new Set(['Bericht (2).pdf'])), 'Bericht (3).pdf', 'schon verplante Namen zählen');
    assert.equal(await freierName(w, 'archiv.tar.gz'), 'archiv (1).tar.gz');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Hochladen ohne Angabe überschreibt nie: E_EXISTIERT schon bei der Prüfung und beim Abschluss (Wettlauf)', async () => {
  const w = await freigabe();
  try {
    await fs.writeFile(path.join(w, 'ordner/a.txt'), 'alt');
    await assert.rejects(ausfuehrenOp('pruefe_schreiben', { wurzel: w, pfad: 'ordner/a.txt' }), (e) => e.code === 'E_EXISTIERT' && e.details.name === 'a.txt');
    // Name frei bei der Prüfung, inzwischen belegt → Abschluss lehnt ab, Zwischendatei weg, Ziel unverändert
    const ziel = await ausfuehrenOp('pruefe_schreiben', { wurzel: w, pfad: 'ordner/b.txt', bei_vorhanden: 'fehler' });
    await fs.writeFile(ziel.tmp, 'neu');
    await fs.writeFile(path.join(w, 'ordner/b.txt'), 'dazwischen');
    await assert.rejects(ausfuehrenOp('upload_abschliessen', { wurzel: w, pfad: 'ordner/b.txt', tmp: ziel.tmp, bei_vorhanden: 'fehler' }), (e) => e.code === 'E_EXISTIERT');
    assert.equal(await lies(w, 'ordner/b.txt'), 'dazwischen');
    assert.equal(await da(ziel.tmp), false, 'Zwischendatei aufgeräumt');
    // freier Name: landet unter dem Namen
    const r = await hochladen(w, 'ordner/c.txt', 'frisch', 'fehler');
    assert.deepEqual(r, { pfad: 'ordner/c.txt', name: 'c.txt', ersetzt: false, umbenannt: false, papierkorb: null });
    assert.equal(await lies(w, 'ordner/c.txt'), 'frisch');
    assert.deepEqual((await fs.readdir(path.join(w, 'ordner'))).sort(), ['a.txt', 'b.txt', 'c.txt'], 'keine Reste');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Hochladen „ersetzen“: alte Version im Papierkorb (Grund „ersetzt“), wiederherstellbar neben die neue', async () => {
  const w = await freigabe();
  try {
    await fs.writeFile(path.join(w, 'ordner/a.txt'), 'alt');
    const r = await hochladen(w, 'ordner/a.txt', 'neu', 'ersetzen');
    assert.equal(r.ersetzt, true); assert.equal(r.name, 'a.txt'); assert.ok(r.papierkorb);
    assert.equal(await lies(w, 'ordner/a.txt'), 'neu');
    const korb = await ausfuehrenOp('papierkorb_liste', { wurzel: w });
    assert.equal(korb.length, 1);
    assert.equal(korb[0].id, r.papierkorb); assert.equal(korb[0].nutzer, 'fabian');
    assert.deepEqual(korb[0].eintraege, [{ pfad: 'ordner/a.txt', name: 'a.txt', art: 'datei', groesse: 3 }]);
    assert.equal((JSON.parse(await fs.readFile(path.join(w, '.papierkorb', r.papierkorb, 'papierkorb.json'), 'utf8'))).grund, 'ersetzt');
    assert.equal(await lies(w, `.papierkorb/${r.papierkorb}/ordner/a.txt`), 'alt');
    // Wiederherstellen: der Platz ist von der neuen Version belegt → „a (1).txt“ daneben, nichts überschrieben
    const wh = await ausfuehrenOp('papierkorb_wiederherstellen', { wurzel: w, eintraege: [{ id: r.papierkorb }] });
    assert.deepEqual(wh.wiederhergestellt, ['ordner/a (1).txt']);
    assert.deepEqual(wh.umbenannt, [{ pfad: 'ordner/a.txt', neu: 'ordner/a (1).txt' }]);
    assert.deepEqual(wh.uebersprungen, []);
    assert.equal(await lies(w, 'ordner/a.txt'), 'neu');
    assert.equal(await lies(w, 'ordner/a (1).txt'), 'alt');
    // Ordner am Ziel lässt sich nicht durch eine Datei ersetzen
    await fs.mkdir(path.join(w, 'ordner/sub'));
    await assert.rejects(ausfuehrenOp('pruefe_schreiben', { wurzel: w, pfad: 'ordner/sub', bei_vorhanden: 'ersetzen' }), (e) => e.code === 'E_EXISTIERT');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Hochladen „ersetzen“ ohne Papierkorb ersetzt direkt; „beide“ nummeriert (auch neben einen Ordner)', async () => {
  const w = await freigabe();
  try {
    await fs.writeFile(path.join(w, 'ordner/a.txt'), 'alt');
    const r = await hochladen(w, 'ordner/a.txt', 'neu', 'ersetzen', false);
    assert.deepEqual(r, { pfad: 'ordner/a.txt', name: 'a.txt', ersetzt: true, umbenannt: false, papierkorb: null });
    assert.equal(await lies(w, 'ordner/a.txt'), 'neu');
    assert.equal(await da(path.join(w, '.papierkorb')), false);
    const b1 = await hochladen(w, 'ordner/a.txt', 'zweite', 'beide');
    assert.deepEqual(b1, { pfad: 'ordner/a (1).txt', name: 'a (1).txt', ersetzt: false, umbenannt: true, papierkorb: null });
    const b2 = await hochladen(w, 'ordner/a.txt', 'dritte', 'beide');
    assert.equal(b2.name, 'a (2).txt');
    assert.equal(await lies(w, 'ordner/a.txt'), 'neu', 'Original unberührt');
    assert.equal(await lies(w, 'ordner/a (1).txt'), 'zweite');
    await fs.mkdir(path.join(w, 'ordner/x'));
    assert.equal((await hochladen(w, 'ordner/x', 'datei', 'beide')).name, 'x (1)');
    const frei = await hochladen(w, 'ordner/neu.txt', 'n', 'beide');
    assert.equal(frei.umbenannt, false, 'freier Name bleibt bei „beide“ unverändert');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Abgebrochener Upload: verwerfen löscht nur die Zwischendatei – das Original bleibt vollständig', async () => {
  const w = await freigabe();
  try {
    await fs.writeFile(path.join(w, 'ordner/wichtig.bin'), 'original');
    const ziel = await ausfuehrenOp('pruefe_schreiben', { wurzel: w, pfad: 'ordner/wichtig.bin', bei_vorhanden: 'ersetzen' });
    await fs.writeFile(ziel.tmp, 'halb');
    assert.equal(await lies(w, 'ordner/wichtig.bin'), 'original', 'während des Uploads unberührt');
    const liste = await ausfuehrenOp('liste', { wurzel: w, pfad: 'ordner', versteckte: true });
    assert.deepEqual(liste.eintraege.map((e) => e.name), ['wichtig.bin'], 'Zwischendatei ist nie sichtbar');
    assert.deepEqual(await ausfuehrenOp('upload_verwerfen', { wurzel: w, pfad: 'ordner/wichtig.bin', tmp: ziel.tmp }), { verworfen: true });
    assert.equal(await lies(w, 'ordner/wichtig.bin'), 'original');
    assert.equal(await da(ziel.tmp), false);
    // Nur echte Zwischendateien im Zielordner werden angefasst
    await assert.rejects(ausfuehrenOp('upload_verwerfen', { wurzel: w, pfad: 'ordner/wichtig.bin', tmp: path.join(w, 'ordner/wichtig.bin') }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(ausfuehrenOp('upload_verwerfen', { wurzel: w, pfad: 'ordner/wichtig.bin', tmp: path.join(w, `${UPLOAD_PRAEFIX}abc`) }), (e) => e.code === 'E_PARAMS');
    assert.equal(await lies(w, 'ordner/wichtig.bin'), 'original');
    // Liegengebliebene Zwischendatei (> 1 Tag) räumt die Liste weg, frische bleibt
    const alt = path.join(w, 'ordner', `${UPLOAD_PRAEFIX}alt`); const frisch = path.join(w, 'ordner', `${UPLOAD_PRAEFIX}frisch`);
    await fs.writeFile(alt, 'x'); await fs.writeFile(frisch, 'x');
    const vorZweiTagen = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await fs.utimes(alt, vorZweiTagen, vorZweiTagen);
    await ausfuehrenOp('liste', { wurzel: w, pfad: 'ordner' });
    assert.equal(await da(alt), false); assert.equal(await da(frisch), true);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('vorhanden: meldet nur existierende Namen, auch in Unterordnern; fehlende Zwischenordner = frei', async () => {
  const w = await freigabe();
  try {
    await fs.mkdir(path.join(w, 'ordner/allinone/src'), { recursive: true });
    await fs.writeFile(path.join(w, 'ordner/allinone/src/a.py'), '12345');
    await fs.writeFile(path.join(w, 'ordner/top.txt'), 'x');
    const r = await ausfuehrenOp('vorhanden', { wurzel: w, pfad: 'ordner', namen: ['top.txt', 'allinone/src/a.py', 'allinone/src/b.py', 'gibtsnicht/x.txt', 'allinone'] });
    assert.deepEqual(r.vorhanden.map((v) => [v.name, v.art, v.groesse]), [['top.txt', 'datei', 1], ['allinone/src/a.py', 'datei', 5], ['allinone', 'ordner', null]]);
    assert.ok(r.vorhanden.every((v) => typeof v.geaendert === 'string'));
    await assert.rejects(ausfuehrenOp('vorhanden', { wurzel: w, pfad: 'ordner', namen: ['../../etc/passwd'] }), (e) => e.code === 'E_PARAMS' || e.code === 'E_RECHTE');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Kopieren/Verschieben: ohne Angabe E_EXISTIERT, „ersetzen“ legt Vorhandenes in den Papierkorb, „beide“ nummeriert', async () => {
  const w = await freigabe();
  try {
    await fs.mkdir(path.join(w, 'ziel'));
    await fs.writeFile(path.join(w, 'ordner/a.txt'), 'quelle-a'); await fs.writeFile(path.join(w, 'ordner/b.txt'), 'quelle-b');
    await fs.writeFile(path.join(w, 'ziel/a.txt'), 'ziel-a'); await fs.writeFile(path.join(w, 'ziel/b.txt'), 'ziel-b');
    const basis = { wurzel: w, ziel_wurzel: w, ziel_pfad: 'ziel', quellen: ['ordner/a.txt', 'ordner/b.txt'], nutzer: 'fabian' };
    await assert.rejects(ausfuehrenOp('kopieren', basis), (e) => e.code === 'E_EXISTIERT');
    assert.equal(await lies(w, 'ziel/a.txt'), 'ziel-a', 'nichts halb passiert');
    const r = await ausfuehrenOp('kopieren', { ...basis, ersetzen: ['a.txt'], beide: ['b.txt'] });
    assert.deepEqual(r.uebertragen, [{ von: 'ordner/a.txt', nach: 'ziel/a.txt' }, { von: 'ordner/b.txt', nach: 'ziel/b (1).txt' }]);
    assert.equal(r.ersetzt, 1); assert.ok(r.papierkorb);
    assert.equal(await lies(w, 'ziel/a.txt'), 'quelle-a');
    assert.equal(await lies(w, 'ziel/b.txt'), 'ziel-b');
    assert.equal(await lies(w, 'ziel/b (1).txt'), 'quelle-b');
    assert.equal(await lies(w, `.papierkorb/${r.papierkorb}/ziel/a.txt`), 'ziel-a', 'ersetzte Version im Papierkorb');
    // Verschieben mit ersetzen, Zielfreigabe ohne Papierkorb → Vorhandenes weg
    await fs.writeFile(path.join(w, 'ordner/c.txt'), 'quelle-c'); await fs.writeFile(path.join(w, 'ziel/c.txt'), 'ziel-c');
    const v = await ausfuehrenOp('verschieben', { ...basis, quellen: ['ordner/c.txt'], ersetzen: ['c.txt'], papierkorb: false });
    assert.equal(v.papierkorb, null); assert.equal(await lies(w, 'ziel/c.txt'), 'quelle-c'); assert.equal(await da(path.join(w, 'ordner/c.txt')), false);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Kopieren am selben Ort nur mit „beide“ (Duplikat); Ersetzen durch eigenen Inhalt wird abgewiesen', async () => {
  const w = await freigabe();
  try {
    await fs.writeFile(path.join(w, 'ordner/a.txt'), 'a');
    const basis = { wurzel: w, ziel_wurzel: w, ziel_pfad: 'ordner', quellen: ['ordner/a.txt'] };
    await assert.rejects(ausfuehrenOp('kopieren', basis), (e) => e.code === 'E_PARAMS');
    await assert.rejects(ausfuehrenOp('kopieren', { ...basis, ersetzen: ['a.txt'] }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(ausfuehrenOp('verschieben', { ...basis, beide: ['a.txt'] }), (e) => e.code === 'E_PARAMS');
    const r = await ausfuehrenOp('kopieren', { ...basis, beide: ['a.txt'] });
    assert.deepEqual(r.uebertragen, [{ von: 'ordner/a.txt', nach: 'ordner/a (1).txt' }]);
    // Ordner mit Unterordner gleichen Namens: p/y/z/y nach p verschieben und p/y ersetzen würde die Quelle wegwerfen
    await fs.mkdir(path.join(w, 'p/y/z/y'), { recursive: true });
    await assert.rejects(ausfuehrenOp('verschieben', { wurzel: w, ziel_wurzel: w, ziel_pfad: 'p', quellen: ['p/y/z/y'], ersetzen: ['y'] }), (e) => e.code === 'E_PARAMS');
    assert.equal(await da(path.join(w, 'p/y/z/y')), true);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});
