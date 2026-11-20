// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Anhänge (Plan 02, Aufgabe 7): Upload-Ticket als root in .teil, Binden an Nachrichten, Löschen, Aufräumen,
// Lesen/Vorschau, „Auf dem NAS speichern“ als Nutzer (V10) und „Im Chat teilen“ aus einer Freigabe.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chatUmgebung } from './chat_hilfen.js';
import { _test as ablageTest } from '../../src/agent/chat/ablage.js';
import { _test as raeumeTest } from '../../src/agent/chat/raeume.js';
import { _test as verlaufTest } from '../../src/agent/chat/verlauf.js';
import { aufraeumen } from '../../src/agent/chat/anhaenge.js';

let e; let raum;
beforeEach(async () => {
  ablageTest.zuruecksetzen(); raeumeTest.zuruecksetzen(); verlaufTest.zuruecksetzen();
  e = await chatUmgebung();
  ({ raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] }));
});
afterEach(async () => { await e.aufraeumen(); });
const ordner = () => path.join(e.chat, 'anhaenge', raum);

/** Lädt eine Datei als `nutzer` hoch und gibt das Abschluss-Ergebnis zurück. */
async function hochladen(nutzer = 'anna', name = 'foto.jpg', inhalt = Buffer.from('hallo')) {
  await e.als(nutzer)('chat.anhang.ticket', { raum, name, groesse: inhalt.length });
  return e.ticketAbschliessen(e.tickets.length - 1, inhalt);
}

test('Ticket schreibt als root in .teil, Abschluss benennt um und legt Metadaten an', async () => {
  await e.als('anna')('chat.anhang.ticket', { raum, name: 'foto.jpg', groesse: 5 });
  const d = e.tickets.at(-1);
  assert.deepEqual([d.uid, d.gid, d.art, d.nutzer, d.groesse], [0, 0, 'schreiben', 'anna', 5]);
  assert.ok(d.pfad.startsWith(ordner()) && d.pfad.endsWith('.teil'));
  const erg = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('hallo'));
  assert.match(erg.id, /^a[A-Za-z0-9_-]{16}$/); assert.equal(erg.mime, 'image/jpeg');
  const meta = JSON.parse(await fs.readFile(path.join(ordner(), `${erg.id}.json`), 'utf8'));
  assert.deepEqual([meta.von, meta.nachricht, meta.groesse], ['anna', null, 5]);
  assert.equal((await fs.stat(path.join(ordner(), erg.id))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(ordner(), `${erg.id}.json`))).mode & 0o777, 0o600);
});

test('abgebrochener Upload hinterlässt nichts', async () => {
  await e.als('anna')('chat.anhang.ticket', { raum, name: 'x.bin', groesse: 3 });
  const d = e.tickets.at(-1);
  await fs.writeFile(d.pfad, 'ab');
  await d.abschluss(false);
  assert.deepEqual(await fs.readdir(ordner()), []);
});

test('Grenzen: Größe über max_anhang_mb, Name mit Pfad, nur Mitglieder', async () => {
  await e.als('chef', 'admin')('chat.einstellungen.setzen', { max_anhang_mb: 1 });
  await assert.rejects(e.als('anna')('chat.anhang.ticket', { raum, name: 'gross.bin', groesse: 1048577 }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'groesse' && f.details.max === 1048576);
  await assert.rejects(e.als('anna')('chat.anhang.ticket', { raum, name: '../x', groesse: 1 }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('cara')('chat.anhang.ticket', { raum, name: 'x', groesse: 1 }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Platzschutz: Anhänge nur, wenn nach der Reserve (5 %, mind. 2 GiB) genug frei bleibt (Prüfbericht Plan 02, Befund 6)', async () => {
  const echt = e.w.system.ausfuehren;
  let frei = 6_000_000_000;
  e.w.system.ausfuehren = async (prog, args, opt) => (prog === 'df' ? { code: 0, stdout: `1B-blocks Avail\n100000000000 ${frei}\n`, stderr: '' } : echt(prog, args, opt));
  try {
    await assert.rejects(e.als('anna')('chat.anhang.ticket', { raum, name: 'gross.bin', groesse: 1_500_000_000 }), (f) => f.code === 'E_PLATZ' && f.details.frei === 1_000_000_000 && f.details.noetig === 1_500_000_000);
    const n = e.tickets.length;
    await e.als('anna')('chat.anhang.ticket', { raum, name: 'klein.bin', groesse: 500_000_000 });
    assert.equal(e.tickets.length, n + 1);
    await fs.writeFile(path.join(e.shares, 'team', 'plan.pdf'), 'PDF');
    frei = 5_000_000_002;
    await assert.rejects(e.als('anna')('chat.anhang.aus_nas', { raum, freigabe: 'team', pfad: 'plan.pdf' }), (f) => f.code === 'E_PLATZ');
  } finally { e.w.system.ausfuehren = echt; }
});

test('senden bindet nur eigene, ungebundene Anhänge desselben Raums', async () => {
  const a = await hochladen('anna');
  await assert.rejects(e.als('ben')('chat.senden', { raum, anhaenge: [a.id] }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'anhaenge');
  const { nachricht } = await e.als('anna')('chat.senden', { raum, anhaenge: [a.id] });
  assert.deepEqual(nachricht.anhaenge, [{ id: a.id, name: 'foto.jpg', groesse: 5, mime: 'image/jpeg', bild: true, video: false }]);
  assert.equal(JSON.parse(await fs.readFile(path.join(ordner(), `${a.id}.json`), 'utf8')).nachricht, nachricht.id);
  await assert.rejects(e.als('anna')('chat.senden', { raum, anhaenge: [a.id] }), (f) => f.code === 'E_PARAMS');
  const b = await hochladen('anna', 'b.txt');
  await assert.rejects(e.als('anna')('chat.senden', { raum, anhaenge: [b.id, b.id] }), (f) => f.code === 'E_PARAMS');
  // nur Anhang, ohne Text: Übersicht zeigt das Büroklammer-Zeichen mit Dateinamen
  const r = JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8'));
  assert.equal(r.letzte.kurz, '📎 foto.jpg');
});

test('Nachricht löschen löscht die Anhangdateien', async () => {
  const a = await hochladen('anna');
  const { nachricht } = await e.als('anna')('chat.senden', { raum, text: 'mit Bild', anhaenge: [a.id] });
  await e.als('anna')('chat.loeschen', { raum, nachricht: nachricht.id });
  assert.deepEqual(await fs.readdir(ordner()), []);
});

test('aufraeumen: ungebunden > 24 h und .teil > 24 h weg, jüngere und gebundene bleiben', async () => {
  const alt = await hochladen('anna', 'alt.txt');
  const jung = await hochladen('anna', 'jung.txt');
  const gebunden = await hochladen('anna', 'gebunden.txt');
  await e.als('anna')('chat.senden', { raum, anhaenge: [gebunden.id] });
  const metaPfad = path.join(ordner(), `${alt.id}.json`);
  const meta = JSON.parse(await fs.readFile(metaPfad, 'utf8'));
  meta.zeit = new Date(Date.now() - 25 * 3600_000).toISOString();
  await fs.writeFile(metaPfad, JSON.stringify(meta));
  const teil = path.join(ordner(), 'aXXXXXXXXXXXXXXXX.teil');
  await fs.writeFile(teil, 'rest');
  const vor25h = new Date(Date.now() - 25 * 3600_000);
  await fs.utimes(teil, vor25h, vor25h);
  assert.deepEqual(await aufraeumen(e.w, Date.now()), { geloescht: 2 });
  const rest = await fs.readdir(ordner());
  assert.ok(!rest.includes(alt.id) && !rest.includes(`${alt.id}.json`) && !rest.includes('aXXXXXXXXXXXXXXXX.teil'));
  assert.ok(rest.includes(jung.id) && rest.includes(gebunden.id));
});

test('lesen: Ticket als root für den Leser, Vorschau über vorschauFuer; fremder Raum → E_NICHT_GEFUNDEN', async () => {
  const a = await hochladen('anna');
  await e.als('anna')('chat.senden', { raum, anhaenge: [a.id] });
  let gesehen = null;
  e.w.vorschau = { holen: async (o) => { gesehen = o; return { mime: 'image/webp', daten: Buffer.from('v'), ausCache: false }; } };
  await e.als('ben')('chat.anhang.lesen', { raum, anhang: a.id });
  const d = e.tickets.at(-1);
  assert.deepEqual([d.uid, d.gid, d.art, d.nutzer, d.dateiname], [0, 0, 'lesen', 'ben', 'foto.jpg']);
  assert.deepEqual(await e.als('ben')('chat.anhang.lesen', { raum, anhang: a.id, vorschau: 256 }), { mime: 'image/webp', daten: 'dg==' });
  assert.equal(gesehen.abgeschottet, true, 'Gast-Dateien nie als root durch ffmpeg (Prüfbericht Plan 02, Befund 1)');
  assert.equal(gesehen.ids, undefined);
  assert.equal(gesehen.groesse, 256);
  const { raum: anderer } = await e.als('anna')('chat.raum.anlegen', { name: 'Anders' });
  await assert.rejects(e.als('anna')('chat.anhang.lesen', { raum: anderer, anhang: a.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.als('cara')('chat.anhang.lesen', { raum, anhang: a.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('lesen: ungebundener Anhang nur für den Hochladenden', async () => {
  const a = await hochladen('anna');
  await e.als('anna')('chat.anhang.lesen', { raum, anhang: a.id });
  await assert.rejects(e.als('ben')('chat.anhang.lesen', { raum, anhang: a.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('speichern als Nutzer in die Freigabe (V10), ohne Schreibrecht E_RECHTE und keine Datei, ../ → E_PARAMS', async () => {
  const a = await hochladen('anna');
  await e.als('anna')('chat.senden', { raum, anhaenge: [a.id] });
  const id = a.id;
  const r = await e.als('anna')('chat.anhang.speichern', { raum, anhang: id, freigabe: 'team', ordner: '' });
  assert.deepEqual(r, { freigabe: 'team', pfad: 'foto.jpg', name: 'foto.jpg' });
  assert.equal(await fs.readFile(path.join(e.shares, 'team', 'foto.jpg'), 'utf8'), 'hallo');
  await assert.rejects(e.als('anna')('chat.anhang.speichern', { raum, anhang: id, freigabe: 'lesen', ordner: '' }), (f) => f.code === 'E_RECHTE');
  assert.deepEqual(await fs.readdir(path.join(e.shares, 'lesen')), []);
  await assert.rejects(e.als('anna')('chat.anhang.speichern', { raum, anhang: id, freigabe: 'team', ordner: '../..' }), (f) => f.code === 'E_PARAMS');
  await assert.rejects(e.als('anna')('chat.anhang.speichern', { raum, anhang: id, freigabe: 'geheim', ordner: '' }), (f) => f.code === 'E_RECHTE');
  await fs.mkdir(path.join(e.shares, 'team', 'Unterordner'));
  const r2 = await e.als('ben')('chat.anhang.speichern', { raum, anhang: id, freigabe: 'team', ordner: 'Unterordner' });
  assert.deepEqual(r2, { freigabe: 'team', pfad: 'Unterordner/foto.jpg', name: 'foto.jpg' });
});

test('aus_nas: nur lesbare Dateien, Ordner → E_PARAMS, Ergebnis ist ungebundener Anhang', async () => {
  await fs.writeFile(path.join(e.shares, 'team', 'plan.pdf'), '%PDF-1.4 test');
  const r = await e.als('anna')('chat.anhang.aus_nas', { raum, freigabe: 'team', pfad: 'plan.pdf' });
  assert.deepEqual([r.anhang.name, r.anhang.groesse, r.anhang.mime], ['plan.pdf', 13, 'application/pdf']);
  assert.equal(await fs.readFile(path.join(ordner(), r.anhang.id), 'utf8'), '%PDF-1.4 test');
  assert.equal(JSON.parse(await fs.readFile(path.join(ordner(), `${r.anhang.id}.json`), 'utf8')).nachricht, null);
  await e.als('anna')('chat.raum.mitglieder', { raum, hinzu: ['cara'] });
  await assert.rejects(e.als('cara')('chat.anhang.aus_nas', { raum, freigabe: 'team', pfad: 'plan.pdf' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('anna')('chat.anhang.aus_nas', { raum, freigabe: 'team', pfad: '' }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'pfad');
});
