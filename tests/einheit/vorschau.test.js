// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Vorschaubilder (src/agent/helfer/vorschau.js): ffmpeg-Argumente, Zwischenspeicher mit Leseprobe (head -c 1) als
// Nutzer, Video-Rückfall ohne Sprung, JPEG-Rückfall ohne libwebp, Fehlergedächtnis, Parallelität, Nachinstallation,
// Aufräumen. ffmpeg wird durch ein Schein-Kind ersetzt (system.starten), Befehle durch eine Attrappe (system.ausfuehren).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fsSync from 'node:fs';
import { Vorschau, ffmpegArgumente, ffmpegBefehl, schluessel, laufen, GROESSEN, INSTALLATIONS_UNIT, HINWEIS_INSTALLATION, MAX_SPEICHER_BYTES } from '../../src/agent/helfer/vorschau.js';

const IDS = { uid: 1001, gid: 100, gruppen: [980] };

/** Schein-Kindprozess: schreibt stdout/stderr und schließt (asynchron); `haengt` schließt erst bei kill oder frei(). */
function scheinKind({ stdout = Buffer.alloc(0), stderr = '', code = 0, haengt = false } = {}) {
  const k = new EventEmitter();
  k.stdout = new PassThrough(); k.stderr = new PassThrough();
  k.getötet = null;
  k.frei = () => { k.stdout.end(stdout); k.stderr.end(stderr); setImmediate(() => k.emit('close', code, null)); };
  k.kill = (sig) => { k.getötet = sig; setImmediate(() => k.emit('close', null, sig)); };
  if (!haengt) setImmediate(k.frei);
  return k;
}

/** Umgebung: tmp-Ordner, Attrappe für starten/ausfuehren, steuerbare Uhr. */
async function umgebung({ ffmpegDa = true, laeufe = [], unlesbar = new Set(), unit = 'inactive' } = {}) {
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-vorschau-'));
  const starts = []; const befehle = []; const kinder = [];
  let uhr = 1_700_000_000_000;
  const system = {
    starten(programm, args, opt) {
      starts.push({ programm, args, opt });
      const n = laeufe.length ? laeufe.shift() : {};
      const k = scheinKind(n); kinder.push(k); return k;
    },
    async ausfuehren(programm, args, opt = {}) {
      befehle.push({ programm, args, opt });
      if (programm === 'head') {
        assert.deepEqual(args.slice(0, 3), ['-c', '1', '--']); assert.ok(Number.isInteger(opt.uid) && Number.isInteger(opt.gid), 'Leseprobe läuft als Nutzer');
        if (unlesbar.has(args[3])) return { code: 1, stdout: '', stderr: `head: cannot open '${args[3]}' for reading: Permission denied` };
        let st = null; try { st = fsSync.statSync(args[3]); } catch { /* fehlt */ }
        if (!st) return { code: 1, stdout: '', stderr: `head: cannot open '${args[3]}' for reading: No such file or directory` };
        if (st.isDirectory()) return { code: 1, stdout: '', stderr: `head: error reading '${args[3]}': Is a directory` };
        return { code: 0, stdout: '', stderr: '' };
      }
      if (programm === 'ffmpeg') { if (!ffmpegDa) throw new Error('ENOENT ffmpeg'); return { code: 0, stdout: 'ffmpeg version 8.0.1', stderr: '' }; }
      if (programm === 'systemctl') return { code: 0, stdout: `${unit}\n`, stderr: '' };
      if (programm === 'systemd-run') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const meldungen = [];
  const v = new Vorschau({ system, ordner, protokoll: (t) => meldungen.push(t), jetzt: () => uhr });
  const datei = path.join(ordner, 'foto.jpg');
  await fs.writeFile(datei, Buffer.from('JPEGDATEN'));
  const video = path.join(ordner, 'film.mp4');
  await fs.writeFile(video, Buffer.from('MP4DATEN'));
  return { v, ordner, system, starts, befehle, kinder, meldungen, datei, video, unlesbar, vor: (ms) => { uhr += ms; }, setzeFfmpeg: (da) => { ffmpegDa = da; }, setzeUnit: (z) => { unit = z; } };
}

test('vorschau: ffmpeg-Argumente – Einzelbild, Deckelung ohne Vergrößern, Sprung nur bei Video, WebP oder JPEG', () => {
  const b = ffmpegArgumente({ abs: '/x/a.png', groesse: 256, art: 'bild' });
  assert.deepEqual(b.slice(0, 6), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1']);
  assert.ok(!b.includes('-ss'));
  assert.ok(b.includes('-frames:v') && b[b.indexOf('-frames:v') + 1] === '1');
  assert.equal(b[b.indexOf('-vf') + 1], 'scale=w=min(iw\\,256):h=min(ih\\,256):force_original_aspect_ratio=decrease:force_divisible_by=2');
  assert.ok(b.includes('libwebp') && b.includes('webp') && b[b.length - 1] === 'pipe:1');
  const vd = ffmpegArgumente({ abs: '/x/v.mp4', groesse: 128, art: 'video', stelle: 3 });
  assert.ok(vd.indexOf('-ss') >= 0 && vd.indexOf('-ss') < vd.indexOf('-i') && vd[vd.indexOf('-ss') + 1] === '3', 'Sprung VOR -i (schnell)');
  const v0 = ffmpegArgumente({ abs: '/x/v.mp4', groesse: 128, art: 'video', stelle: null });
  assert.ok(!v0.includes('-ss'));
  const j = ffmpegArgumente({ abs: '/x/a.png', groesse: 512, art: 'bild', encoder: 'mjpeg' });
  assert.ok(j.includes('mjpeg') && j.includes('image2pipe') && !j.includes('libwebp'));
  for (const g of GROESSEN) assert.ok(Number.isInteger(g));
});

test('vorschau: Erlaubnislisten – nur Datei-Protokoll und bekannte Bild-/Video-Formate, vor -i', () => {
  const p = ffmpegArgumente({ abs: '/x/a.jpg', groesse: 128, art: 'bild' });
  const i = p.indexOf('-i');
  assert.ok(p.indexOf('-protocol_whitelist') >= 0 && p.indexOf('-protocol_whitelist') < i); assert.equal(p[p.indexOf('-protocol_whitelist') + 1], 'file');
  const formate = p[p.indexOf('-format_whitelist') + 1].split(',');
  assert.ok(p.indexOf('-format_whitelist') < i);
  for (const f of ['image2', 'jpeg_pipe', 'png_pipe', 'webp_pipe', 'gif', 'mov', 'matroska', 'mpegts', 'avi']) assert.ok(formate.includes(f), f);
  for (const f of ['hls', 'concat', 'dash', 'lavfi']) assert.ok(!formate.includes(f), f);
  const d = ffmpegArgumente({ abs: null, groesse: 128, art: 'video', stelle: 3, ueberDeskriptor: true });
  assert.equal(d[d.indexOf('-i') + 1], 'fd:'); assert.equal(d[d.indexOf('-protocol_whitelist') + 1], 'fd');
});

test('vorschau: abgeschottet (Chat-Speicher gehört root) – Datei als Deskriptor, ffmpeg als nobody, keine Leseprobe, keine Deskriptor-Leichen', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.from('RIFFbild') }, { stdout: Buffer.alloc(0) }, { stdout: Buffer.from('RIFFvideo') }] });
  const offen = () => fsSync.readdirSync('/proc/self/fd').length;
  const vorher = offen();
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', abgeschottet: true });
  assert.equal(r.daten.toString(), 'RIFFbild');
  const s = u.starts[0];
  assert.deepEqual([s.opt.uid, s.opt.gid, s.opt.gruppen], [65534, 65534, []], 'ffmpeg als nobody');
  assert.equal(typeof s.opt.stdio[0], 'number', 'Datei kommt als Deskriptor (stdin)');
  assert.deepEqual(s.opt.stdio.slice(1), ['pipe', 'pipe']);
  assert.ok(!s.args.includes(u.datei), 'ffmpeg bekommt keinen Pfad');
  assert.equal(s.args[s.args.indexOf('-i') + 1], 'fd:');
  assert.equal(u.befehle.filter((b) => b.programm === 'head').length, 0, 'keine Leseprobe – der Agent hat das Recht schon geprüft');
  const v = await u.v.holen({ abs: u.video, groesse: 128, art: 'video', abgeschottet: true });
  assert.equal(v.daten.toString(), 'RIFFvideo');
  assert.deepEqual(u.starts.slice(1).map((x) => [x.opt.uid, typeof x.opt.stdio[0], x.args.includes('-ss')]), [[65534, 'number', true], [65534, 'number', false]], 'Sprung, dann ab Anfang – je ein eigener Deskriptor');
  assert.equal(offen(), vorher, 'alle Deskriptoren wieder zu');
  const t = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', abgeschottet: true });
  assert.equal(t.ausCache, true);
  await assert.rejects(u.v.holen({ abs: path.join(u.ordner, 'fehlt.jpg'), groesse: 256, art: 'bild', abgeschottet: true }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  assert.equal(offen(), vorher);
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Schlüssel hängt an Pfad, Änderungszeit, Größe und Zielgröße', () => {
  const st = { mtimeMs: 1000.4, size: 5 };
  const a = schluessel('/a', st, 256);
  assert.equal(a, schluessel('/a', { mtimeMs: 1000.2, size: 5 }, 256), 'Millisekunden gerundet');
  assert.notEqual(a, schluessel('/b', st, 256)); assert.notEqual(a, schluessel('/a', { mtimeMs: 2000, size: 5 }, 256));
  assert.notEqual(a, schluessel('/a', { mtimeMs: 1000, size: 6 }, 256)); assert.notEqual(a, schluessel('/a', st, 512));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('vorschau: erzeugen als Nutzer (nice + ffmpeg über system.starten mit uid/gid/gruppen), dann Treffer aus dem Zwischenspeicher mit Leserechtprüfung', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.from('RIFFwebp') }] });
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r.mime, 'image/webp'); assert.equal(r.daten.toString(), 'RIFFwebp'); assert.equal(r.ausCache, false);
  assert.equal(u.starts.length, 1);
  const s = u.starts[0];
  assert.equal(s.programm, 'nice'); assert.deepEqual(s.args.slice(0, 5), ['-n', '10', 'prlimit', `--as=${MAX_SPEICHER_BYTES}`, 'ffmpeg'], 'Kette nice → prlimit (Speicherdeckel) → ffmpeg');
  assert.deepEqual(ffmpegBefehl({ abs: '/x.jpg', groesse: 128, art: 'bild' }).slice(0, 5), s.args.slice(0, 5));
  assert.ok(s.args.includes(u.datei) && s.args.includes('libwebp'));
  assert.deepEqual([s.opt.uid, s.opt.gid, s.opt.gruppen], [1001, 100, [980]]);
  assert.deepEqual(s.opt.stdio, ['ignore', 'pipe', 'pipe']);
  // Leserecht wurde als Nutzer geprüft (head -c 1 = echtes open), ffmpeg vorher einmal gesucht
  assert.equal(u.befehle.filter((b) => b.programm === 'head').length, 1);
  assert.equal(u.befehle.filter((b) => b.programm === 'ffmpeg').length, 1);
  // Zwischenspeicher: <ordner>/<xx>/<key>.webp, 0600
  const st = await fs.stat(u.datei);
  const key = schluessel(u.datei, st, 256);
  const cache = path.join(u.ordner, key.slice(0, 2), `${key}.webp`);
  const cst = await fs.stat(cache);
  assert.equal(cst.mode & 0o777, 0o600);
  assert.equal((await fs.readFile(cache)).toString(), 'RIFFwebp');
  // zweiter Aufruf: kein ffmpeg, aber erneut die Leseprobe
  const r2 = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r2.ausCache, true); assert.equal(r2.daten.toString(), 'RIFFwebp');
  assert.equal(u.starts.length, 1);
  assert.equal(u.befehle.filter((b) => b.programm === 'head').length, 2);
  // andere Größe = anderer Schlüssel → neu erzeugen
  u.system.starten = (p, a, o) => { u.starts.push({ programm: p, args: a, opt: o }); return scheinKind({ stdout: Buffer.from('RIFF512') }); };
  const r3 = await u.v.holen({ abs: u.datei, groesse: 512, art: 'bild', ids: IDS });
  assert.equal(r3.ausCache, false); assert.equal(u.starts.length, 2);
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: ohne Leserecht E_RECHTE – auch bei vorhandenem Treffer eines anderen Nutzers, ffmpeg läuft dann nie', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.from('RIFFwebp') }] });
  await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }); // Nutzer A füllt den Speicher
  u.befehle.length = 0;
  const gesperrt = await umgebung({ unlesbar: new Set([u.datei]) });
  const v2 = new Vorschau({ system: gesperrt.system, ordner: u.ordner, protokoll: () => {}, jetzt: () => 1 });
  await assert.rejects(v2.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: { uid: 1002, gid: 100, gruppen: [] } }), (e) => e.code === 'E_RECHTE');
  assert.equal(gesperrt.starts.length, 0, 'kein ffmpeg für einen Nutzer ohne Leserecht');
  await assert.rejects(v2.holen({ abs: u.datei, groesse: 512, art: 'bild', ids: { uid: 1002, gid: 100, gruppen: [] } }), (e) => e.code === 'E_RECHTE');
  assert.equal(gesperrt.starts.length, 0);
  await fs.rm(u.ordner, { recursive: true, force: true }); await fs.rm(gesperrt.ordner, { recursive: true, force: true });
});

test('vorschau: Parameterprüfung – Größe, Art, fehlende Datei, Ordner, Nutzerkennung', async () => {
  const u = await umgebung();
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 300, art: 'bild', ids: IDS }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'groesse');
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'audio', ids: IDS }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.v.holen({ abs: path.join(u.ordner, 'fehlt.jpg'), groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(u.v.holen({ abs: u.ordner, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_PARAMS');
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: null }), (e) => e.code === 'E_UNBEKANNT');
  assert.equal(u.starts.length, 0);
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Video – Sprung auf Sekunde 3 liefert nichts (kurzes Video) → zweiter Lauf ab Anfang', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.alloc(0), code: 0 }, { stdout: Buffer.from('RIFFbild') }] });
  const r = await u.v.holen({ abs: u.video, groesse: 256, art: 'video', ids: IDS });
  assert.equal(r.daten.toString(), 'RIFFbild');
  assert.equal(u.starts.length, 2);
  assert.ok(u.starts[0].args.includes('-ss') && u.starts[0].args[u.starts[0].args.indexOf('-ss') + 1] === '3');
  assert.ok(!u.starts[1].args.includes('-ss'));
  // Video, das schon beim Sprung klappt: nur ein Lauf
  const u2 = await umgebung({ laeufe: [{ stdout: Buffer.from('RIFFsofort') }] });
  await u2.v.holen({ abs: u2.video, groesse: 128, art: 'video', ids: IDS });
  assert.equal(u2.starts.length, 1);
  await fs.rm(u.ordner, { recursive: true, force: true }); await fs.rm(u2.ordner, { recursive: true, force: true });
});

test('vorschau: ffmpeg ohne libwebp → JPEG-Rückfall (mjpeg), gemerkt für alle weiteren Bilder', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.alloc(0), stderr: "Unknown encoder 'libwebp'", code: 1 }, { stdout: Buffer.from('\xff\xd8jpeg', 'latin1') }, { stdout: Buffer.from('\xff\xd8zwei', 'latin1') }] });
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(u.starts.length, 2);
  assert.ok(u.starts[0].args.includes('libwebp') && u.starts[1].args.includes('mjpeg'));
  const st = await fs.stat(u.datei);
  assert.ok(await fs.stat(path.join(u.ordner, schluessel(u.datei, st, 256).slice(0, 2), `${schluessel(u.datei, st, 256)}.jpg`)));
  assert.ok(u.meldungen.some((m) => /ohne libwebp/.test(m)));
  const r2 = await u.v.holen({ abs: u.video, groesse: 256, art: 'video', ids: IDS });
  assert.equal(r2.mime, 'image/jpeg'); assert.equal(u.starts.length, 3); assert.ok(u.starts[2].args.includes('mjpeg'));
  // Treffer aus dem Speicher liefert wieder JPEG
  const r3 = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r3.mime, 'image/jpeg'); assert.equal(r3.ausCache, true);
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Fehler von ffmpeg → E_SYSTEM mit Ausgabe, 10 min gemerkt (kein erneuter Lauf), danach neuer Versuch; Permission denied → E_RECHTE', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.alloc(0), stderr: 'Invalid data found when processing input', code: 1 }, { stdout: Buffer.from('RIFFspaeter') }] });
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM' && /Invalid data/.test(e.details.ausgabe));
  assert.equal(u.starts.length, 1);
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  assert.equal(u.starts.length, 1, 'gemerkter Fehler – ffmpeg läuft nicht erneut');
  u.vor(11 * 60_000);
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r.daten.toString(), 'RIFFspaeter'); assert.equal(u.starts.length, 2);
  // geänderte Datei = neuer Schlüssel → Fehler gilt nicht mehr
  const u2 = await umgebung({ laeufe: [{ stdout: Buffer.alloc(0), stderr: 'x: Permission denied', code: 1 }] });
  await assert.rejects(u2.v.holen({ abs: u2.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_RECHTE');
  await fs.rm(u.ordner, { recursive: true, force: true }); await fs.rm(u2.ordner, { recursive: true, force: true });
});

test('vorschau: höchstens zwei ffmpeg-Läufe gleichzeitig, weitere warten', async () => {
  const u = await umgebung({ laeufe: [{ haengt: true, stdout: Buffer.from('A') }, { haengt: true, stdout: Buffer.from('B') }, { haengt: true, stdout: Buffer.from('C') }] });
  const dateien = [];
  for (const n of ['1.jpg', '2.jpg', '3.jpg']) { const p = path.join(u.ordner, n); await fs.writeFile(p, n); dateien.push(p); }
  const laeufe = dateien.map((p) => u.v.holen({ abs: p, groesse: 128, art: 'bild', ids: IDS }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(u.starts.length, 2, 'dritter Lauf wartet');
  u.kinder[0].frei();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(u.starts.length, 3, 'nach dem ersten Ende startet der dritte');
  u.kinder[1].frei(); u.kinder[2].frei();
  const erg = await Promise.all(laeufe);
  assert.deepEqual(erg.map((e) => e.daten.toString()).sort(), ['A', 'B', 'C']);
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: laufen() – Zeitlimit tötet den Prozess (SIGKILL), zu große Ausgabe ebenso, Startfehler landet im Ergebnis', async (t) => {
  // Der Wecker in laufen() ist unref() (im Agenten halten andere Griffe die Schleife wach); hier hält ein Platzhalter sie offen
  const wach = setInterval(() => {}, 1000); t.after(() => clearInterval(wach));
  const k = scheinKind({ haengt: true });
  const r = await laufen({ starten: () => k }, 'ffmpeg', [], { ids: IDS, zeitlimit_ms: 30 });
  assert.equal(r.abgebrochen, true); assert.equal(k.getötet, 'SIGKILL');
  const gross = scheinKind({ haengt: true });
  const lauf = laufen({ starten: () => gross }, 'ffmpeg', [], { ids: IDS, zeitlimit_ms: 5000, maxBytes: 10 });
  gross.stdout.write(Buffer.alloc(11));
  const r2 = await lauf;
  assert.equal(r2.zuGross, true); assert.equal(gross.getötet, 'SIGKILL'); assert.equal(r2.stdout.length, 0);
  const r3 = await laufen({ starten: () => { throw new Error('ENOENT'); } }, 'ffmpeg', [], { ids: IDS, zeitlimit_ms: 100 });
  assert.equal(r3.startFehler, 'ENOENT');
});

test('vorschau: ffmpeg fehlt → E_SYSTEM mit Hinweis, Nachinstallation als Unit (install → update → install), höchstens alle 30 s geprüft', async () => {
  const u = await umgebung({ ffmpegDa: false });
  await u.v.starten();
  const unitStarts = () => u.befehle.filter((b) => b.programm === 'systemd-run');
  assert.equal(unitStarts().length, 1);
  assert.ok(unitStarts()[0].args.includes(`--unit=${INSTALLATIONS_UNIT}`) && unitStarts()[0].args.includes('install') && unitStarts()[0].args.includes('ffmpeg'));
  assert.equal(unitStarts()[0].opt.umgebung.DEBIAN_FRONTEND, 'noninteractive');
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM' && e.details.hinweis === HINWEIS_INSTALLATION);
  assert.equal(u.starts.length, 0, 'kein ffmpeg-Start ohne ffmpeg');
  const ffmpegPruefungen = () => u.befehle.filter((b) => b.programm === 'ffmpeg').length;
  const n = ffmpegPruefungen();
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  assert.equal(ffmpegPruefungen(), n, 'innerhalb von 30 s keine erneute Prüfung');
  // Unit fertig, ffmpeg fehlt weiterhin → nächster Schritt: apt-get update
  u.vor(31_000);
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  assert.equal(unitStarts().length, 2); assert.ok(unitStarts()[1].args.includes('update'));
  // Unit läuft noch → warten, kein neuer Start
  u.setzeUnit('active'); u.vor(31_000);
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  assert.equal(unitStarts().length, 2);
  // Unit fertig und ffmpeg jetzt da → Vorschau läuft
  u.setzeUnit('inactive'); u.setzeFfmpeg(true); u.vor(31_000);
  u.system.starten = (p, a, o) => { u.starts.push({ programm: p, args: a, opt: o }); return scheinKind({ stdout: Buffer.from('RIFFda') }); };
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r.daten.toString(), 'RIFFda');
  assert.equal(u.v.zustand().ffmpeg, true);
  assert.ok(u.meldungen.some((m) => /nachinstalliert|jetzt vorhanden/.test(m)));
  u.v.stoppen();
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: ohne systemd (systemd-run scheitert) endet die Nachinstallation mit Hinweis; „already“ heißt warten', async () => {
  const u = await umgebung({ ffmpegDa: false });
  u.system.ausfuehren = async (p, a, o) => { u.befehle.push({ programm: p, args: a, opt: o }); if (p === 'ffmpeg') throw new Error('fehlt'); if (p === 'systemd-run') throw Object.assign(new Error('x'), { details: { ausgabe: 'Failed to connect to bus' } }); return { code: 0, stdout: '', stderr: '' }; };
  await u.v.starten();
  assert.ok(u.meldungen.some((m) => /systemd-run scheiterte/.test(m)));
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => /nicht nachinstallieren/.test(e.details.hinweis));
  u.vor(31_000);
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  assert.equal(u.befehle.filter((b) => b.programm === 'systemd-run').length, 1, 'nach dem Ende kein weiterer Versuch');
  const u2 = await umgebung({ ffmpegDa: false, unit: 'active' });
  u2.system.ausfuehren = async (p, a, o) => { u2.befehle.push({ programm: p, args: a, opt: o }); if (p === 'ffmpeg') throw new Error('fehlt'); if (p === 'systemd-run') throw Object.assign(new Error('x'), { details: { ausgabe: `Unit ${INSTALLATIONS_UNIT}.service already exists.` } }); if (p === 'systemctl') return { code: 0, stdout: 'active\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; };
  await u2.v.starten();
  assert.ok(u2.meldungen.some((m) => /läuft bereits/.test(m)));
  u2.v.stoppen(); u.v.stoppen();
  await fs.rm(u.ordner, { recursive: true, force: true }); await fs.rm(u2.ordner, { recursive: true, force: true });
});

test('vorschau: aufräumen – alte Bilder und liegengebliebene Zwischendateien weg, über der Obergrenze die ältesten zuerst', async () => {
  const u = await umgebung();
  const jetzt = 1_700_000_000_000;
  const lege = async (name, bytes, alterTage) => {
    const p = path.join(u.ordner, name.slice(0, 2), name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.alloc(bytes));
    const z = new Date(jetzt - alterTage * 86_400_000);
    await fs.utimes(p, z, z);
    return p;
  };
  const alt = await lege('aa' + '1'.repeat(62) + '.webp', 100, 200);
  const tmp = await lege('bb' + '2'.repeat(62) + '.webp.1.abcd.tmp', 100, 1);
  const a = await lege('cc' + '3'.repeat(62) + '.webp', 600, 10);
  const b = await lege('dd' + '4'.repeat(62) + '.jpg', 600, 5);
  const c = await lege('ee' + '5'.repeat(62) + '.webp', 600, 1);
  await fs.writeFile(path.join(u.ordner, 'fremd.txt'), 'bleibt');
  const r = await u.v.aufraeumen({ maxBytes: 1500, maxAlterMs: 180 * 86_400_000 });
  const da = async (p) => { try { await fs.stat(p); return true; } catch { return false; } };
  assert.equal(await da(alt), false, '200 Tage alt → weg');
  assert.equal(await da(tmp), false, 'Zwischendatei älter als 1 h → weg');
  assert.equal(await da(a), false, 'Obergrenze 1500: 1800 B belegt → ältestes (a) weg, Ziel 75 % = 1125 → auch b weg');
  assert.equal(await da(b), false);
  assert.equal(await da(c), true);
  assert.equal(r.geloescht, 4); assert.equal(r.belegt, 600);
  assert.ok(await da(path.join(u.ordner, 'fremd.txt')));
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Leseprobe kommt vor allem anderen – ohne Leserecht weder Existenz (404), Ordner noch gemerkter ffmpeg-Fehler sichtbar', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.alloc(0), stderr: 'Invalid data found when processing input', code: 1 }] });
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_SYSTEM');
  // derselbe Schlüssel, aber ein Nutzer ohne Leserecht: E_RECHTE statt des gemerkten Fehlers, ohne fs.stat-Antworten
  const fehlt = path.join(u.ordner, 'fehlt.jpg');
  u.unlesbar.add(u.datei); u.unlesbar.add(fehlt); u.unlesbar.add(u.ordner);
  await assert.rejects(u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: { uid: 1002, gid: 100, gruppen: [] } }), (e) => e.code === 'E_RECHTE');
  await assert.rejects(u.v.holen({ abs: fehlt, groesse: 256, art: 'bild', ids: { uid: 1002, gid: 100, gruppen: [] } }), (e) => e.code === 'E_RECHTE', 'kein Existenz-Orakel');
  await assert.rejects(u.v.holen({ abs: u.ordner, groesse: 256, art: 'bild', ids: { uid: 1002, gid: 100, gruppen: [] } }), (e) => e.code === 'E_RECHTE');
  assert.equal(u.starts.length, 1, 'ffmpeg lief nur für den berechtigten Nutzer');
  // head-Fehlertexte: fehlende Datei → E_NICHT_GEFUNDEN, Ordner → E_PARAMS (beide nur, wenn der Nutzer den Ordner betreten darf)
  u.unlesbar.clear();
  await assert.rejects(u.v.holen({ abs: fehlt, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(u.v.holen({ abs: u.ordner, groesse: 256, art: 'bild', ids: IDS }), (e) => e.code === 'E_PARAMS');
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Semaphor übergibt den Platz direkt – ein Neuankömmling zwischen Freigabe und Aufwachen bekommt keinen dritten Lauf', async () => {
  const u = await umgebung();
  await u.v._platz(); await u.v._platz();
  let cGestartet = false; const c = u.v._platz().then(() => { cGestartet = true; });
  assert.equal(u.v.laufend, 2); assert.equal(u.v.warteschlange.length, 1);
  u.v._frei();                      // A fertig → Platz geht an C
  let dGestartet = false; const d = u.v._platz().then(() => { dGestartet = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(cGestartet, true); assert.equal(dGestartet, false, 'D wartet, obwohl es sich zwischen _frei und der Fortsetzung von C meldete');
  assert.equal(u.v.laufend, 2);
  u.v._frei(); await d; assert.equal(dGestartet, true); assert.equal(u.v.laufend, 2);
  u.v._frei(); u.v._frei(); assert.equal(u.v.laufend, 0); assert.equal(u.v.warteschlange.length, 0);
  await c;
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: Zwischenspeicher – Schreibfehler hinterlässt keine Zwischendatei, Belegung wird mitgeführt und stößt über der Grenze das Aufräumen an', async () => {
  const u = await umgebung({ laeufe: [{ stdout: Buffer.from('RIFFa') }, { stdout: Buffer.from('RIFFb') }] });
  const st = await fs.stat(u.datei);
  const key = schluessel(u.datei, st, 256);
  const ziel = path.join(u.ordner, key.slice(0, 2), `${key}.webp`);
  await fs.mkdir(ziel, { recursive: true }); // Ziel ist ein Ordner → rename scheitert
  const r = await u.v.holen({ abs: u.datei, groesse: 256, art: 'bild', ids: IDS });
  assert.equal(r.daten.toString(), 'RIFFa', 'Antwort trotz Cache-Fehler');
  const reste = (await fs.readdir(path.dirname(ziel))).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(reste, [], 'keine .tmp-Leiche');
  assert.ok(u.meldungen.some((m) => /nicht beschreibbar/.test(m)));
  await fs.rm(ziel, { recursive: true, force: true });
  // Belegung: ab bekannter Belegung zählt jeder Treffer mit; über der Grenze läuft aufraeumen genau einmal
  let laeufe = 0;
  u.v.aufraeumen = async () => { laeufe++; u.v.belegt = 0; return { geloescht: 0, bytes: 0, belegt: 0 }; };
  u.v.belegt = 100; u.v.cacheMaxBytes = 102;
  await u.v.holen({ abs: u.video, groesse: 256, art: 'video', ids: IDS });
  await new Promise((r) => setImmediate(r));
  assert.equal(laeufe, 1, 'Aufräumen angestoßen (100 + 5 > 102)');
  await fs.rm(u.ordner, { recursive: true, force: true });
});

test('vorschau: gleichzeitige erste Anfragen teilen sich die ffmpeg-Prüfung – keine scheitert, ffmpeg -version läuft einmal (Bedienprobe 28.09.)', async () => {
  const laeufe = Array.from({ length: 6 }, (_, i) => ({ stdout: Buffer.from('RIFF' + i) }));
  const u = await umgebung({ laeufe });
  // ffmpeg-Prüfung künstlich langsam: so kommen alle sechs Anfragen während der ersten Prüfung an
  const alt = u.system.ausfuehren;
  u.system.ausfuehren = async (p, a, o) => { if (p === 'ffmpeg') await new Promise((r) => setTimeout(r, 40)); return alt(p, a, o); };
  const dateien = [];
  for (let i = 0; i < 6; i++) { const p = path.join(u.ordner, `b${i}.jpg`); await fs.writeFile(p, 'x'); dateien.push(p); }
  const erg = await Promise.all(dateien.map((p) => u.v.holen({ abs: p, groesse: 128, art: 'bild', ids: IDS })));
  assert.deepEqual(erg.map((e) => e.daten.toString()).sort(), ['RIFF0', 'RIFF1', 'RIFF2', 'RIFF3', 'RIFF4', 'RIFF5']);
  assert.equal(u.befehle.filter((b) => b.programm === 'ffmpeg').length, 1, 'eine gemeinsame Prüfung');
  await fs.rm(u.ordner, { recursive: true, force: true });
});
