// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil C: Kommandozeile tools/fahnas (Hilfe, Startcode, issue, Export ohne Agent, totp-entfernen und
// sitzungen-beenden gegen einen Schein-Agenten, update mit Unit-Erneuerung und Rücktausch) und tools/build_release.sh.
// systemctl wird über FAHNAS_SYSTEMCTL durch ein protokollierendes Skript ersetzt (system.befehl hat einen festen PATH),
// der Agent durch einen kleinen NDJSON-Server auf FAHNAS_RUN/agent.sock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Konfig } from '../../src/gemeinsam/konfig.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(WURZEL, 'tools', 'fahnas');

function laufen(programm, args, env = {}) {
  return new Promise((ok) => {
    execFile(programm, args, { env: { ...process.env, ...env }, timeout: 30_000 }, (e, stdout, stderr) => ok({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/** Schein-Agent: NDJSON über Unix-Socket; antwortet je Aktion aus `antworten` (Wert oder {fehler}) und merkt sich die Anfragen. */
async function scheinAgent(sockPfad, antworten) {
  const anfragen = []; const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    let rest = '';
    s.on('data', (d) => {
      rest += d.toString('utf8');
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const z = rest.slice(0, i); rest = rest.slice(i + 1);
        if (!z.trim()) continue;
        const n = JSON.parse(z); anfragen.push(n);
        const a = typeof antworten === 'function' ? antworten(n) : antworten[n.aktion];
        if (a && a.fehler) s.write(JSON.stringify({ id: n.id, ok: false, fehler: a.fehler }) + '\n');
        else s.write(JSON.stringify({ id: n.id, ok: true, ergebnis: a === undefined ? null : a }) + '\n');
      }
    });
  });
  await fs.mkdir(path.dirname(sockPfad), { recursive: true });
  await new Promise((ok, nein) => { server.once('error', nein); server.listen(sockPfad, ok); });
  return { anfragen, schliessen: () => new Promise((ok) => { for (const s of sockets) s.destroy(); server.close(() => ok()); }) };
}

/** Schein-systemctl: Shell-Skript, das seine Argumente zeilenweise protokolliert und 0 liefert. */
async function scheinSystemctl(ordner) {
  const log = path.join(ordner, 'systemctl.log');
  const skript = path.join(ordner, 'systemctl');
  await fs.writeFile(skript, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  return { skript, log, aufrufe: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

async function schreibe(dateien) {
  for (const [p, inhalt] of Object.entries(dateien)) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, inhalt); }
}

/** Baut ein Release-Archiv (tar.gz + .sha256 wie build_release.sh) aus einem Ordner. */
async function releaseBauen(quelle, ziel) {
  const t = await laufen('tar', ['-C', quelle, '-czf', ziel, '.']);
  assert.equal(t.code, 0, t.stderr);
  const summe = createHash('sha256').update(await fs.readFile(ziel)).digest('hex');
  await fs.writeFile(`${ziel}.sha256`, `${summe}  ${path.basename(ziel)}\n`);
}

test('fahnas hilfe: deutsche Hilfe, Exit 0; ohne Befehl Exit 2; unbekannter Befehl Exit 2; Prototyp-Namen sind keine Befehle', async () => {
  const h = await laufen(CLI, ['hilfe']);
  assert.equal(h.code, 0);
  for (const wort of ['status', 'apply', 'startcode', 'issue', 'export', 'import', 'update', 'passwort', 'totp-entfernen', 'sitzungen-beenden', 'aktionen']) assert.ok(h.stdout.includes(wort), wort);
  assert.equal((await laufen(CLI, [])).code, 2);
  const u = await laufen(CLI, ['gibtsnicht']);
  assert.equal(u.code, 2); assert.match(u.stderr, /Unbekannter Befehl/);
  const p = await laufen(CLI, ['toString']);
  assert.equal(p.code, 2, 'Object.prototype-Namen sind keine Unterbefehle');
});

test('fahnas startcode: 8 Zeichen ohne 0/O/1/I, Datei 0600, --zeigen zeigt ihn, fehlend → Fehler; Konsolenhinweis wird mitgeschrieben', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-'));
  const startcode = path.join(w, 'etc', 'startcode');
  try {
    const env = { FAHNAS_STARTCODE: startcode, FAHNAS_CONFIG: path.join(w, 'config'), FAHNAS_ISSUE_D: path.join(w, 'issue.d'), FAHNAS_MOTD_D: path.join(w, 'motd.d') };
    const fehlt = await laufen(CLI, ['startcode', '--zeigen'], env);
    assert.equal(fehlt.code, 1); assert.match(fehlt.stderr, /Kein Startcode/);
    const r = await laufen(CLI, ['startcode'], env);
    assert.equal(r.code, 0, r.stderr);
    const m = /Startcode für die Ersteinrichtung:\s+([A-Z2-9]{8})/.exec(r.stdout);
    assert.ok(m, r.stdout);
    assert.ok(!/[01OI]/.test(m[1]), 'verwechselbare Zeichen ausgeschlossen');
    const inhalt = await fs.readFile(startcode, 'utf8');
    assert.equal(inhalt, `${m[1]}\n`);
    assert.equal(((await fs.stat(startcode)).mode & 0o777), 0o600);
    assert.match(r.stdout, /Konsolenhinweis \(issue\/motd\) aktualisiert/);
    assert.ok((await fs.readFile(path.join(w, 'issue.d', 'fahnas.issue'), 'utf8')).includes(`Startcode: ${m[1]}`), 'issue-Datei zeigt den frischen Code');
    const z = await laufen(CLI, ['startcode', '--zeigen'], env);
    assert.equal(z.code, 0); assert.equal(z.stdout.trim(), `Startcode: ${m[1]}`);
    const r2 = await laufen(CLI, ['startcode'], env);
    assert.notEqual(/([A-Z2-9]{8})\n/.exec(await fs.readFile(startcode, 'utf8'))[1], m[1], 'neuer Aufruf → neuer Code (praktisch immer)');
    assert.equal(r2.code, 0);
    // ohne Schreibrecht auf die Hinweis-Ordner bleibt startcode trotzdem erfolgreich (Entwicklungsrechner)
    const r3 = await laufen(CLI, ['startcode'], { ...env, FAHNAS_ISSUE_D: '/nonexistent-root-only/issue.d', FAHNAS_MOTD_D: '/nonexistent-root-only/motd.d' });
    assert.equal(r3.code, 0, r3.stderr);
    assert.ok(!/Konsolenhinweis/.test(r3.stdout));
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('fahnas issue: issue.d mit \\4 und Rechnername, motd.d; Startcode nur, solange die Datei existiert', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-issue-'));
  try {
    const startcode = path.join(w, 'etc', 'startcode');
    await schreibe({ [startcode]: 'ABCDEFGH\n' });
    const env = { FAHNAS_STARTCODE: startcode, FAHNAS_CONFIG: path.join(w, 'config'), FAHNAS_ISSUE_D: path.join(w, 'issue.d'), FAHNAS_MOTD_D: path.join(w, 'motd.d') };
    const r = await laufen(CLI, ['issue'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Konsolenhinweis geschrieben: .*fahnas\.issue, .*motd\.d\/fahnas \(mit Startcode\)/);
    const issue = await fs.readFile(path.join(w, 'issue.d', 'fahnas.issue'), 'utf8');
    const motd = await fs.readFile(path.join(w, 'motd.d', 'fahnas'), 'utf8');
    const host = os.hostname().split('.')[0];
    assert.ok(issue.includes('https://\\4'), 'agetty-Escape \\4 für die aktuelle IPv4');
    assert.ok(issue.includes(`https://${host}.local`), 'Rechnername.local');
    assert.ok(issue.includes('Startcode: ABCDEFGH (nur bis zur Ersteinrichtung)'));
    assert.ok(motd.includes(`https://${host}.local`) && motd.includes('Startcode: ABCDEFGH'));
    assert.ok(!motd.includes('\\4'), 'motd kennt keine agetty-Escapes');
    assert.ok(issue.includes('sudo fahnas status'));
    // Startcode verbraucht (Agent löscht die Datei nach der Ersteinrichtung) → Hinweis ohne Code
    await fs.rm(startcode);
    const r2 = await laufen(CLI, ['issue'], env);
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /\(ohne Startcode\)/);
    const issue2 = await fs.readFile(path.join(w, 'issue.d', 'fahnas.issue'), 'utf8');
    assert.ok(!issue2.includes('Startcode:'), 'kein verbrauchter Code mehr auf tty1');
    assert.ok(issue2.includes('Ersteinrichtung abgeschlossen'));
    assert.ok(!(await fs.readFile(path.join(w, 'motd.d', 'fahnas'), 'utf8')).includes('Startcode:'));
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('fahnas totp-entfernen: ruft nutzer.totp.entfernen {name} OHNE Passwort mit Kontext konsole/admin; ungültiger Name Exit 2; Agent-Fehler Exit 1', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-totp-'));
  const run = path.join(w, 'run');
  const agent = await scheinAgent(path.join(run, 'agent.sock'), (n) => (n.params.name === 'niemand' ? { fehler: { code: 'E_NICHT_GEFUNDEN', meldung: 'Nutzer „niemand“ gibt es nicht' } } : { name: n.params.name, totp: false }));
  try {
    const env = { FAHNAS_RUN: run, FAHNAS_CONFIG: path.join(w, 'config') };
    const r = await laufen(CLI, ['totp-entfernen', 'anna'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Zwei-Faktor-Anmeldung für anna entfernt/);
    assert.equal(agent.anfragen.length, 1);
    assert.equal(agent.anfragen[0].aktion, 'nutzer.totp.entfernen');
    assert.deepEqual(agent.anfragen[0].params, { name: 'anna' }, 'kein passwort im Aufruf – die Konsole ist die Vertrauensgrundlage');
    assert.deepEqual(agent.anfragen[0].kontext, { nutzer: 'konsole', rolle: 'admin', ip: '-' });
    const f = await laufen(CLI, ['totp-entfernen', 'Ungültig!'], env);
    assert.equal(f.code, 2); assert.match(f.stderr, /Nutzername fehlt oder ungültig/);
    const n = await laufen(CLI, ['totp-entfernen', 'niemand'], env);
    assert.equal(n.code, 1); assert.match(n.stderr, /gibt es nicht \[E_NICHT_GEFUNDEN\]/);
  } finally { await agent.schliessen(); await fs.rm(w, { recursive: true, force: true }); }
});

test('fahnas sitzungen-beenden: hält den Web-Dienst an, entfernt nur die Sitzungen des Nutzers, startet ihn wieder; ohne systemctl nur die Datei', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-sitz-'));
  try {
    const konfig = path.join(w, 'config');
    const datei = path.join(konfig, 'web', 'sitzungen.json');
    const sitzung = (nutzer) => ({ nutzer, rolle: 'nutzer', anzeigename: nutzer, erstellt: '2026-09-25T10:00:00.000Z', zuletzt: '2026-09-25T10:00:00.000Z', ablauf: '2036-01-01T00:00:00.000Z', bleiben: false, ip: '10.0.0.5', totp_offen: false, totp: false, csrf: 'x' });
    await schreibe({ [datei]: JSON.stringify({ sitzungen: { id_anna_1: sitzung('anna'), id_bert_1: sitzung('bert'), id_anna_2: sitzung('anna') } }, null, 2) });
    await fs.chmod(datei, 0o600);
    const sc = await scheinSystemctl(w);
    const env = { FAHNAS_CONFIG: konfig, FAHNAS_SYSTEMCTL: sc.skript, FAHNAS_RUN: path.join(w, 'run') };
    const r = await laufen(CLI, ['sitzungen-beenden', 'anna'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 Sitzung\(en\) von anna beendet/);
    const d = JSON.parse(await fs.readFile(datei, 'utf8'));
    assert.deepEqual(Object.keys(d.sitzungen), ['id_bert_1'], 'nur berts Sitzung bleibt');
    assert.equal((await fs.stat(datei)).mode & 0o777, 0o600);
    assert.deepEqual(await sc.aufrufe(), ['stop fahnas-web', 'start fahnas-web'], 'erst anhalten (Web schreibt beim Stopp sein Speicherbild), dann ändern, dann starten');
    const r2 = await laufen(CLI, ['sitzungen-beenden', 'anna'], env);
    assert.equal(r2.code, 0); assert.match(r2.stdout, /0 Sitzung\(en\) von anna beendet/);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(datei, 'utf8')).sitzungen), ['id_bert_1']);
    // ohne systemctl (Container): Hinweis, Datei wird trotzdem bereinigt
    const r3 = await laufen(CLI, ['sitzungen-beenden', 'bert'], { ...env, FAHNAS_SYSTEMCTL: path.join(w, 'gibt-es-nicht', 'systemctl') });
    assert.equal(r3.code, 0, r3.stderr);
    assert.match(r3.stdout, /Hinweis: Web-Dienst nicht angehalten/);
    assert.match(r3.stdout, /1 Sitzung\(en\) von bert beendet/);
    assert.deepEqual(JSON.parse(await fs.readFile(datei, 'utf8')).sitzungen, {});
    const f = await laufen(CLI, ['sitzungen-beenden'], env);
    assert.equal(f.code, 2);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

/** Gemeinsamer Aufbau für die update-Tests: altes Programm 0.0.1 mit Unit A, installierte Units A/X, Release 0.0.2 mit B/X/T. */
async function updateUmgebung(w) {
  const programm = path.join(w, 'opt', 'fahnas'); const systemd = path.join(w, 'etc', 'systemd', 'system'); const rel = path.join(w, 'rel');
  await schreibe({
    [path.join(programm, 'BUILD_VERSION')]: '0.0.1\n', [path.join(programm, 'src', 'agent', 'agent.js')]: '// alt\n', [path.join(programm, 'tools', 'fahnas')]: '#!/bin/sh\n',
    [path.join(programm, 'systemd', 'fahnas-web.service')]: '[Service]\nA\n',
    [path.join(systemd, 'fahnas-web.service')]: '[Service]\nA\n', [path.join(systemd, 'fahnas-agent.service')]: '[Service]\nX\n',
    [path.join(rel, 'BUILD_VERSION')]: '0.0.2\n', [path.join(rel, 'src', 'agent', 'agent.js')]: '// neu\n', [path.join(rel, 'tools', 'fahnas')]: '#!/bin/sh\n',
    [path.join(rel, 'systemd', 'fahnas-web.service')]: '[Service]\nB\n', [path.join(rel, 'systemd', 'fahnas-agent.service')]: '[Service]\nX\n', [path.join(rel, 'systemd', 'fahnas.target')]: '[Unit]\nT\n',
    [path.join(rel, 'systemd', 'notizen.txt')]: 'keine Unit\n',
  });
  const archiv = path.join(w, 'fahnas_release.tar.gz');
  await releaseBauen(rel, archiv);
  const sc = await scheinSystemctl(w);
  const env = { FAHNAS_PROGRAMM: programm, FAHNAS_SYSTEMD: systemd, FAHNAS_SYSTEMCTL: sc.skript, FAHNAS_RUN: path.join(w, 'run'), FAHNAS_CONFIG: path.join(w, 'config') };
  return { programm, systemd, archiv, sc, env };
}

test('fahnas update: erneuert nur geänderte/neue Units, sichert alte Fassung, daemon-reload vor dem Restart, Gesundheitsprüfung über den Agenten', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-upd-'));
  const u = await updateUmgebung(w);
  const agent = await scheinAgent(path.join(w, 'run', 'agent.sock'), { 'system.status': { version: '0.0.2', hostname: 'nas', kernel: '6.17', laufzeit_s: 5, dienste: { samba: 'aktiv' }, platten: [], datenpartition_prozent: null } });
  try {
    const r = await laufen(CLI, ['update', u.archiv], { ...u.env, FAHNAS_GESUNDHEIT_MS: '8000' });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Prüfsumme in Ordnung/);
    assert.match(r.stdout, /Update 0\.0\.1 → 0\.0\.2/);
    assert.match(r.stdout, /systemd-Units erneuert: fahnas-web\.service, fahnas\.target \(daemon-reload; alte Fassung unter .*fahnas\.alt\/systemd\.installiert\)/);
    assert.match(r.stdout, /Update erfolgreich: Version 0\.0\.2 läuft/);
    assert.equal(await fs.readFile(path.join(u.systemd, 'fahnas-web.service'), 'utf8'), '[Service]\nB\n');
    assert.equal(await fs.readFile(path.join(u.systemd, 'fahnas.target'), 'utf8'), '[Unit]\nT\n');
    assert.equal(await fs.readFile(path.join(u.systemd, 'fahnas-agent.service'), 'utf8'), '[Service]\nX\n', 'unveränderte Unit bleibt');
    await assert.rejects(fs.access(path.join(u.systemd, 'notizen.txt')), 'nur *.service/target/timer/socket/path werden installiert');
    const sicherung = `${u.programm}.alt/systemd.installiert`;
    assert.equal(await fs.readFile(path.join(sicherung, 'fahnas-web.service'), 'utf8'), '[Service]\nA\n', 'alte Fassung gesichert');
    assert.deepEqual((await fs.readdir(sicherung)).sort(), ['fahnas-web.service'], 'neue Units haben keine alte Fassung, unveränderte werden nicht gesichert');
    assert.deepEqual(await u.sc.aufrufe(), ['daemon-reload', 'restart fahnas-agent fahnas-web'], 'daemon-reload VOR dem Restart');
    assert.equal((await fs.readFile(path.join(u.programm, 'BUILD_VERSION'), 'utf8')).trim(), '0.0.2');
    assert.equal((await fs.readFile(`${u.programm}.alt/BUILD_VERSION`, 'utf8')).trim(), '0.0.1');
    assert.ok(agent.anfragen.some((a) => a.aktion === 'system.status'), 'Gesundheitsprüfung fragt system.status');
  } finally { await agent.schliessen(); await fs.rm(w, { recursive: true, force: true }); }
});

test('fahnas update: antwortet der Agent nicht, werden Programm UND Units zurückgetauscht (daemon-reload erneut), Exit 1', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-upd2-'));
  const u = await updateUmgebung(w);
  try {
    const r = await laufen(CLI, ['update', u.archiv], { ...u.env, FAHNAS_GESUNDHEIT_MS: '1500' });   // kein Agent → Rücktausch nach ~2 s
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Rücktausch: Steuerdienst antwortet nicht/);
    assert.match(r.stderr, /Update fehlgeschlagen, alter Stand läuft wieder/);
    assert.equal(await fs.readFile(path.join(u.systemd, 'fahnas-web.service'), 'utf8'), '[Service]\nA\n', 'geänderte Unit zurückgespielt');
    await assert.rejects(fs.access(path.join(u.systemd, 'fahnas.target')), 'neu hinzugekommene Unit wieder entfernt');
    assert.equal(await fs.readFile(path.join(u.systemd, 'fahnas-agent.service'), 'utf8'), '[Service]\nX\n');
    assert.equal((await fs.readFile(path.join(u.programm, 'BUILD_VERSION'), 'utf8')).trim(), '0.0.1', 'altes Programm läuft wieder');
    assert.equal((await fs.readFile(`${u.programm}.fehlgeschlagen/BUILD_VERSION`, 'utf8')).trim(), '0.0.2');
    await assert.rejects(fs.access(path.join(u.programm, 'systemd.installiert')), 'keine Sicherungsreste im zurückgetauschten Programm');
    assert.deepEqual(await u.sc.aufrufe(), ['daemon-reload', 'restart fahnas-agent fahnas-web', 'daemon-reload', 'restart fahnas-agent fahnas-web']);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('fahnas export: schreibt ein tar aus der Konfiguration ohne laufenden Agenten; --mit-geheimnissen behält Hashes', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-cli-exp-'));
  try {
    const konfig = new Konfig(path.join(w, 'config'));
    await konfig.sicherstellen();
    await konfig.speichern('users.json', { nutzer: [{ name: 'fabian', rolle: 'admin', hash: 'scrypt$x' }], gruppen: [] });
    const env = { FAHNAS_CONFIG: konfig.ordner, FAHNAS_RUN: path.join(w, 'run') };
    const ohne = await laufen(CLI, ['export', path.join(w, 'ohne.tar')], env);
    assert.equal(ohne.code, 0, ohne.stderr); assert.match(ohne.stdout, /Export geschrieben/);
    const ordner = path.join(w, 'ohne'); await fs.mkdir(ordner);
    const t1 = await laufen('tar', ['-C', ordner, '-xf', path.join(w, 'ohne.tar')]);
    assert.equal(t1.code, 0, t1.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, 'users.json'), 'utf8')).nutzer[0].hash, undefined);
    assert.equal((await fs.readdir(path.join(konfig.ordner, 'eingang'))).length, 0, 'Zwischendatei im Eingang wird aufgeräumt');
    const mit = await laufen(CLI, ['export', w, '--mit-geheimnissen'], env);
    assert.equal(mit.code, 0, mit.stderr);
    const datei = (await fs.readdir(w)).find((n) => /^fahnas-export-.+\.tar$/.test(n));
    assert.ok(datei, 'Zielordner → Standard-Dateiname');
    const ordner2 = path.join(w, 'mit'); await fs.mkdir(ordner2);
    await laufen('tar', ['-C', ordner2, '-xf', path.join(w, datei)]);
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner2, 'users.json'), 'utf8')).nutzer[0].hash, 'scrypt$x');
    const fehlt = await laufen(CLI, ['export'], env);
    assert.equal(fehlt.code, 2);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

/**
 * Mini-Release-ZIPs für alle Katalog-Vorlagen mit bauen.release_zip (statt der echten aus ~/claude/NEUE ZIPs): Dockerfile
 * mit COPY, dazu Dinge, die NICHT ins NAS-Programm dürfen (memory.md, README.md, manage.sh). Eine ZIP mit Oberordner.
 */
async function miniZips(ordner) {
  const katalog = path.join(WURZEL, 'katalog');
  const liste = [];
  for (const n of (await fs.readdir(katalog)).filter((x) => x.endsWith('.json'))) {
    const v = JSON.parse(await fs.readFile(path.join(katalog, n), 'utf8'));
    if (v.bauen && v.bauen.release_zip) liste.push({ id: v.id, zip: v.bauen.release_zip });
  }
  for (const [i, e] of liste.entries()) {
    const quelle = path.join(ordner, `q-${e.id}`);
    const wurzel = i === 0 ? path.join(quelle, 'oberordner') : quelle;
    await fs.mkdir(path.join(wurzel, 'src'), { recursive: true });
    await fs.writeFile(path.join(wurzel, 'Dockerfile'), 'FROM alpine:3\nCOPY src/ /app/src/\nCOPY \\\n  BUILD_VERSION /app/\n');
    await fs.writeFile(path.join(wurzel, 'src', 'start.js'), 'console.log(1)\n');
    await fs.writeFile(path.join(wurzel, 'BUILD_VERSION'), `1.${i}\n`);
    await fs.writeFile(path.join(wurzel, 'memory.md'), 'NAS 192.168.1.23, SSH 2222\n');
    await fs.writeFile(path.join(wurzel, 'README.md'), 'example.org\n');
    await fs.writeFile(path.join(wurzel, 'manage.sh'), '#!/bin/sh\n');
    const r = await laufen('sh', ['-c', `cd "${quelle}" && zip -qr "${path.join(ordner, e.zip)}" .`]);
    assert.equal(r.code, 0, r.stderr);
  }
  return liste;
}

test('build_release.sh: App-Quellen aus den Release-ZIPs – nur Build-Kontext (COPY), ohne memory.md/README, Oberordner aufgelöst, Arbeitsbaum unberührt', async (t) => {
  if ((await laufen('sh', ['-c', 'command -v zip && command -v unzip'])).code !== 0) return t.skip('zip/unzip fehlen');
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-appquellen-'));
  try {
    const zips = path.join(w, 'zips'); await fs.mkdir(zips);
    const liste = await miniZips(zips);
    assert.ok(liste.length >= 5, 'fünf FAH-Apps mit bauen.release_zip');
    // --ohne-geo-holen: Tests laden nichts aus dem Internet und schreiben nichts nach geo/ im Arbeitsbaum
    const r = await laufen('bash', [path.join(WURZEL, 'tools', 'build_release.sh'), '--ausgabe', w, '--ohne-geo-holen'], { FAHNAS_APP_ZIPS: zips });
    assert.equal(r.code, 0, r.stderr);
    const tar = (await laufen('tar', ['-tzf', path.join(w, 'fahnas_release.tar.gz')])).stdout.split('\n');
    for (const { id } of liste) {
      for (const soll of [`katalog/quellen/${id}/Dockerfile`, `katalog/quellen/${id}/src/start.js`, `katalog/quellen/${id}/BUILD_VERSION`, `katalog/quellen/${id}.json`]) assert.ok(tar.includes(soll), `fehlt: ${soll}`);
      for (const weg of ['memory.md', 'README.md', 'manage.sh', 'oberordner']) assert.ok(!tar.some((z) => z.startsWith(`katalog/quellen/${id}/${weg}`)), `${id}: ${weg} darf nicht ins Programm`);
    }
    const ziel = path.join(w, 'x'); await fs.mkdir(ziel);
    await laufen('tar', ['-C', ziel, '-xzf', path.join(w, 'fahnas_release.tar.gz')]);
    const meta = JSON.parse(await fs.readFile(path.join(ziel, 'katalog', 'quellen', `${liste[0].id}.json`), 'utf8'));
    const { createHash } = await import('node:crypto');
    assert.equal(meta.sha256, createHash('sha256').update(await fs.readFile(path.join(zips, liste[0].zip))).digest('hex'));
    assert.equal(meta.version, '1.0'); assert.equal(meta.zip, liste[0].zip);
    await assert.rejects(fs.stat(path.join(WURZEL, 'katalog', 'quellen')), 'Arbeitsbaum bleibt ohne katalog/quellen');
    // fehlendes ZIP → Abbruch mit Meldung, Arbeitsbaum weiter unberührt
    await fs.rm(path.join(zips, liste[1].zip));
    const f = await laufen('bash', [path.join(WURZEL, 'tools', 'build_release.sh'), '--ausgabe', path.join(w, 'fehl'), '--ohne-geo-holen'], { FAHNAS_APP_ZIPS: zips });
    assert.notEqual(f.code, 0); assert.match(f.stderr, /Release-ZIP für .* fehlt/);
    await assert.rejects(fs.stat(path.join(WURZEL, 'katalog', 'quellen')));
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('build_release.sh: baut tar.gz + sha256 + Kopie; Inhalt ohne .DS_Store, mit BUILD_VERSION und tools/fahnas ausführbar', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-release-'));
  try {
    const r = await laufen('bash', [path.join(WURZEL, 'tools', 'build_release.sh'), '--ausgabe', w, '--ohne-app-quellen', '--ohne-geo-holen']);
    assert.equal(r.code, 0, r.stderr);
    const version = (await fs.readFile(path.join(WURZEL, 'BUILD_VERSION'), 'utf8')).trim();
    const dateien = (await fs.readdir(w)).sort();
    assert.deepEqual(dateien, [`fahnas_release-${version}.tar.gz`, `fahnas_release-${version}.tar.gz.sha256`, 'fahnas_release.tar.gz', 'fahnas_release.tar.gz.sha256']);
    const summe = await fs.readFile(path.join(w, 'fahnas_release.tar.gz.sha256'), 'utf8');
    assert.match(summe, /^[0-9a-f]{64} {2}fahnas_release\.tar\.gz\n$/);
    const { createHash } = await import('node:crypto');
    const ist = createHash('sha256').update(await fs.readFile(path.join(w, 'fahnas_release.tar.gz'))).digest('hex');
    assert.equal(summe.slice(0, 64), ist);
    const liste = await laufen('tar', ['-tzvf', path.join(w, 'fahnas_release.tar.gz')]);
    assert.equal(liste.code, 0);
    for (const soll of ['BUILD_VERSION', 'package.json', 'src/agent/agent.js', 'src/agent/aktionen/system.js', 'tools/fahnas', 'tools/build_release.sh']) assert.ok(liste.stdout.includes(soll), `fehlt: ${soll}`);
    assert.ok(!liste.stdout.includes('.DS_Store') && !liste.stdout.includes('/._'), 'keine macOS-Metadaten');
    assert.ok(!liste.stdout.includes('katalog/quellen'), '--ohne-app-quellen: keine App-Quellen');
    assert.ok(liste.stdout.includes('LICENSE-HINWEIS.md'), 'Namensnennung DB-IP/Natural Earth reist mit');
    // geo/: alles, was im Arbeitsbaum liegt (laender.json aus dem Git, Länder-DB falls schon geholt) – ohne Temp-Reste
    const geo = (await fs.readdir(path.join(WURZEL, 'geo')).catch(() => [])).filter((n) => !n.endsWith('.tmp') && n !== '.DS_Store');
    for (const n of geo) assert.ok(liste.stdout.includes(`geo/${n}`), `fehlt: geo/${n}`);
    assert.ok(!/geo\/.*\.tmp/.test(liste.stdout), 'keine Temp-Dateien aus geo/');
    const cliZeile = liste.stdout.split('\n').find((z) => / tools\/fahnas$/.test(z));
    assert.match(cliZeile, /^-rwxr-xr-x/, 'tools/fahnas muss ausführbar sein');
    assert.match(cliZeile, / (0|root)[ /](0|root|wheel) /, 'Besitzer root normiert');
    // entpacken und Version lesen wie „fahnas update“
    const ziel = path.join(w, 'neu'); await fs.mkdir(ziel);
    const x = await laufen('tar', ['-C', ziel, '--no-same-owner', '-xzf', path.join(w, 'fahnas_release.tar.gz')]);
    assert.equal(x.code, 0, x.stderr);
    assert.equal((await fs.readFile(path.join(ziel, 'BUILD_VERSION'), 'utf8')).trim(), version);
    const h = await laufen(path.join(ziel, 'tools', 'fahnas'), ['hilfe']);
    assert.equal(h.code, 0, 'entpackte Kommandozeile läuft (ESM ohne Endung über package.json)');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});
