// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests des Datenkanals (echter Unix-Socket in tmp, echte cat/dd-Kindprozesse ohne uid/gid): Nutzer-Bindung der
// Tickets (Kopf {ticket, nutzer}), Hochladen mit Antwortzeile, vorzeitig endendes dd ohne EPIPE-Absturz (P3),
// Herunterladen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Datenkanal } from '../../src/agent/datenkanal.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-dk-')); }

/** Verbindet, schickt den Kopf und optional Daten; sammelt, was der Agent zurückschreibt. */
function kanal(sockPfad, kopf, { daten = null, ende = true } = {}) {
  return new Promise((ok, nein) => {
    const s = net.createConnection(sockPfad);
    const teile = []; let fehler = null;
    s.on('error', (e) => { fehler = e; });
    s.on('data', (d) => teile.push(d));
    s.on('close', () => ok({ antwort: Buffer.concat(teile), fehler }));
    s.on('connect', async () => {
      s.write(JSON.stringify(kopf) + '\n');
      if (daten) {
        for (const block of daten) {
          if (!s.write(block)) await new Promise((r) => s.once('drain', r)).catch(() => {});
          if (s.destroyed) break;
        }
      }
      if (ende) s.end();
    });
    setTimeout(() => nein(new Error('Zeitlimit')), 8000).unref();
  });
}

function zeile(buf) { const t = buf.toString('utf8'); const i = t.indexOf('\n'); return JSON.parse(i >= 0 ? t.slice(0, i) : t); }

test('datenkanal: Ticket ist an den Nutzer gebunden – falscher/fehlender Nutzer → E_TICKET, Ticket bleibt für den Inhaber gültig; danach verbraucht', async () => {
  const d = await tmp();
  const dk = new Datenkanal(path.join(d, 'daten.sock'));
  await dk.starten();
  try {
    await fs.writeFile(path.join(d, 'quelle.txt'), 'hallo welt');
    const ids = { uid: process.getuid(), gid: process.getgid() };
    const t = dk.ticket({ nutzer: 'lisa', ...ids, art: 'lesen', pfad: path.join(d, 'quelle.txt'), dateiname: 'quelle.txt' });
    assert.match(t.ticket, /^k-[A-Za-z0-9_-]{16}[A-Za-z0-9_-]{16}$/);
    const fremd = await kanal(dk.socketPfad, { ticket: t.ticket, nutzer: 'tina' });
    assert.equal(zeile(fremd.antwort).fehler.code, 'E_TICKET');
    const ohne = await kanal(dk.socketPfad, { ticket: t.ticket });
    assert.equal(zeile(ohne.antwort).fehler.code, 'E_TICKET');
    const kaputt = await kanal(dk.socketPfad, 'kein json');
    assert.equal(zeile(kaputt.antwort).fehler.code, 'E_PARAMS');
    const eigen = await kanal(dk.socketPfad, { ticket: t.ticket, nutzer: 'lisa' });
    assert.equal(eigen.antwort.toString('utf8'), 'hallo welt', 'rechtmäßiger Inhaber bekommt die Datei');
    const nochmal = await kanal(dk.socketPfad, { ticket: t.ticket, nutzer: 'lisa' });
    assert.equal(zeile(nochmal.antwort).fehler.code, 'E_TICKET', 'einmalig');
    assert.throws(() => dk.einloesen('k-gibtsnicht', 'lisa'), (e) => e.code === 'E_TICKET');
  } finally { await dk.stoppen(); await fs.rm(d, { recursive: true, force: true }); }
});

test('datenkanal: Hochladen schreibt die Datei und antwortet {ok:true}; dd endet vorzeitig (Zielordner fehlt) → Fehlerzeile statt EPIPE-Absturz (P3)', async () => {
  const d = await tmp();
  const dk = new Datenkanal(path.join(d, 'daten.sock'));
  await dk.starten();
  let abgestuerzt = null;
  const waechter = (e) => { abgestuerzt = e; };
  process.on('uncaughtException', waechter);
  try {
    const ids = { uid: process.getuid(), gid: process.getgid() };
    // 1) Erfolg
    const t1 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, 'ziel.bin'), dateiname: 'ziel.bin' });
    const inhalt = Buffer.alloc(3 * 1024 * 1024, 7);
    const ok = await kanal(dk.socketPfad, { ticket: t1.ticket, nutzer: 'lisa' }, { daten: [inhalt.subarray(0, 1024), inhalt.subarray(1024)] });
    assert.deepEqual(zeile(ok.antwort), { ok: true });
    assert.ok((await fs.readFile(path.join(d, 'ziel.bin'))).equals(inhalt));
    // 2) dd stirbt sofort (Elternordner fehlt), Web schickt trotzdem 64 MB weiter
    const t2 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, 'gibt-es-nicht', 'ziel.bin'), dateiname: 'ziel.bin' });
    const block = Buffer.alloc(1024 * 1024, 65);
    const r = await kanal(dk.socketPfad, { ticket: t2.ticket, nutzer: 'lisa' }, { daten: Array.from({ length: 64 }, () => block) });
    const antwort = r.antwort.toString('utf8');
    assert.ok(antwort.startsWith('{"fehler"'), `Fehlerzeile erwartet, bekam: ${antwort.slice(0, 80)}`);
    assert.equal(zeile(r.antwort).fehler.code, 'E_SYSTEM');
    await new Promise((x) => setTimeout(x, 200));
    assert.equal(abgestuerzt, null, `Agent-Prozess darf nicht abstürzen: ${abgestuerzt && abgestuerzt.message}`);
  } finally { process.off('uncaughtException', waechter); await dk.stoppen(); await fs.rm(d, { recursive: true, force: true }); }
});

test('datenkanal: abschluss() nach dem Schreiben – Ergebnis in der Antwortzeile, Fehler als Fehlerzeile, Abbruch verwirft', async () => {
  const d = await tmp();
  const dk = new Datenkanal(path.join(d, 'daten.sock'));
  await dk.starten();
  try {
    const ids = { uid: process.getuid(), gid: process.getgid() };
    const aufrufe = [];
    // 1) Erfolg: abschluss(true) liefert den tatsächlichen Namen
    const t1 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, '.tmp1'), dateiname: 'a.txt', abschluss: async (erfolg) => { aufrufe.push(['t1', erfolg, await fs.readFile(path.join(d, '.tmp1'), 'utf8')]); return { name: 'a (1).txt' }; } });
    const ok = await kanal(dk.socketPfad, { ticket: t1.ticket, nutzer: 'lisa' }, { daten: [Buffer.from('hallo')] });
    assert.deepEqual(zeile(ok.antwort), { ok: true, ergebnis: { name: 'a (1).txt' } });
    assert.deepEqual(aufrufe, [['t1', true, 'hallo']], 'abschluss sieht die vollständigen Daten');
    // 2) abschluss wirft (z. B. Name inzwischen belegt) → Fehlerzeile
    const t2 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, '.tmp2'), dateiname: 'b.txt', abschluss: async () => { throw new FahnasFehler('E_EXISTIERT', '„b.txt“ gibt es hier schon'); } });
    const belegt = await kanal(dk.socketPfad, { ticket: t2.ticket, nutzer: 'lisa' }, { daten: [Buffer.from('x')] });
    assert.equal(zeile(belegt.antwort).fehler.code, 'E_EXISTIERT');
    // 3) dd scheitert (Ordner fehlt) → abschluss(false), genau einmal
    const t3 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, 'fehlt', '.tmp3'), dateiname: 'c.txt', abschluss: async (erfolg) => { aufrufe.push(['t3', erfolg]); } });
    const kaputt = await kanal(dk.socketPfad, { ticket: t3.ticket, nutzer: 'lisa' }, { daten: [Buffer.alloc(1024)] });
    assert.equal(zeile(kaputt.antwort).fehler.code, 'E_SYSTEM');
    assert.deepEqual(aufrufe.filter((a) => a[0] === 't3'), [['t3', false]]);
    // 4) Hochlader bricht mitten im Senden ab → dd wird beendet, abschluss(false)
    const t4 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, '.tmp4'), dateiname: 'd.bin', groesse: 1024 * 1024, abschluss: async (erfolg) => { aufrufe.push(['t4', erfolg]); } });
    await new Promise((ok) => {
      const s = net.createConnection(dk.socketPfad);
      s.on('error', () => {});
      s.on('connect', () => { s.write(JSON.stringify({ ticket: t4.ticket, nutzer: 'lisa' }) + '\n'); s.write(Buffer.alloc(64 * 1024)); setTimeout(() => { s.destroy(); ok(); }, 50); });
    });
    for (let i = 0; i < 50 && !aufrufe.some((a) => a[0] === 't4'); i++) await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(aufrufe.filter((a) => a[0] === 't4'), [['t4', false]], 'Abbruch (EOF vor der angekündigten Größe) verwirft die Zwischendatei');
    // 5) Verbindung endet sauber, aber zu wenig Daten → E_ABGEBROCHEN statt {ok:true}
    const t5 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, '.tmp5'), dateiname: 'e.bin', groesse: 10, abschluss: async (erfolg) => { aufrufe.push(['t5', erfolg]); } });
    const kurz = await kanal(dk.socketPfad, { ticket: t5.ticket, nutzer: 'lisa' }, { daten: [Buffer.alloc(4)] });
    assert.equal(zeile(kurz.antwort).fehler.code, 'E_ABGEBROCHEN');
    assert.deepEqual(zeile(kurz.antwort).fehler.details, { erwartet: 10, empfangen: 4 });
    assert.deepEqual(aufrufe.filter((a) => a[0] === 't5'), [['t5', false]]);
    // 6) genau die angekündigte Größe → Erfolg
    const t6 = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: path.join(d, '.tmp6'), dateiname: 'f.bin', groesse: 4, abschluss: async (erfolg) => { aufrufe.push(['t6', erfolg]); } });
    assert.deepEqual(zeile((await kanal(dk.socketPfad, { ticket: t6.ticket, nutzer: 'lisa' }, { daten: [Buffer.alloc(4)] })).antwort), { ok: true });
    assert.deepEqual(aufrufe.filter((a) => a[0] === 't6'), [['t6', true]]);
  } finally { await dk.stoppen(); await fs.rm(d, { recursive: true, force: true }); }
});

test('datenkanal: mehr Daten als angekündigt → abgeschnitten (höchstens ein Block zu viel auf der Platte), verworfen, Fehlerzeile', async () => {
  const d = await tmp();
  const dk = new Datenkanal(path.join(d, 'daten.sock'));
  await dk.starten();
  try {
    const ids = { uid: process.getuid(), gid: process.getgid() };
    const ziel = path.join(d, '.tmp');
    const gesehen = [];
    const t = dk.ticket({ nutzer: 'lisa', ...ids, art: 'schreiben', pfad: ziel, dateiname: 'x.bin', groesse: 1024, abschluss: async (erfolg) => {
      let groesse = null; try { groesse = (await fs.stat(ziel)).size; } catch { /* weg */ }
      gesehen.push([erfolg, groesse]);
      await fs.rm(ziel, { force: true });
    } });
    const r = await kanal(dk.socketPfad, { ticket: t.ticket, nutzer: 'lisa' }, { daten: Array.from({ length: 64 }, () => Buffer.alloc(128 * 1024)) });
    assert.equal(zeile(r.antwort).fehler.code, 'E_ABGEBROCHEN');
    assert.equal(gesehen.length, 1); assert.equal(gesehen[0][0], false);
    assert.ok(gesehen[0][1] <= 1024 + 256 * 1024, `auf der Platte höchstens ein Block mehr (war ${gesehen[0][1]})`);
  } finally { await dk.stoppen(); await fs.rm(d, { recursive: true, force: true }); }
});

test('datenkanal: Bereich (HTTP-Range, Spulen in Videos) liefert genau den Abschnitt; ungültiger Bereich → Fehler statt ganzer Datei', async (t) => {
  if (process.platform !== 'linux') { t.skip('dd iflag=skip_bytes gibt es nur mit GNU coreutils'); return; }
  const d = await tmp();
  const dk = new Datenkanal(path.join(d, 'daten.sock'));
  await dk.starten();
  try {
    const inhalt = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    await fs.writeFile(path.join(d, 'film.mkv'), inhalt);
    const ids = { uid: process.getuid(), gid: process.getgid() };
    const neu = () => dk.ticket({ nutzer: 'lisa', ...ids, art: 'lesen', pfad: path.join(d, 'film.mkv'), dateiname: 'film.mkv', groesse: inhalt.length });
    const mitte = await kanal(dk.socketPfad, { ticket: neu().ticket, nutzer: 'lisa', bereich: { start: 123_456, laenge: 70_000 } });
    assert.ok(mitte.antwort.equals(inhalt.subarray(123_456, 193_456)), 'genau der Abschnitt');
    const ende = await kanal(dk.socketPfad, { ticket: neu().ticket, nutzer: 'lisa', bereich: { start: 299_990, laenge: 10 } });
    assert.ok(ende.antwort.equals(inhalt.subarray(299_990)));
    const falsch = await kanal(dk.socketPfad, { ticket: neu().ticket, nutzer: 'lisa', bereich: { start: 299_990, laenge: 11 } });
    assert.equal(zeile(falsch.antwort).fehler.code, 'E_PARAMS', 'über das Ende hinaus → Fehler, nicht die ganze Datei');
    const ganz = await kanal(dk.socketPfad, { ticket: neu().ticket, nutzer: 'lisa' });
    assert.ok(ganz.antwort.equals(inhalt), 'ohne Bereich wie bisher die ganze Datei');
  } finally { await dk.stoppen(); await fs.rm(d, { recursive: true, force: true }); }
});
