// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Apps aus FAH-Git (Betreiber 26.10.2026: „in FAH-NAS bei Apps ‚aus FAH-Git bauen‘, in den Admin-Einstellungen die Verbindung
// zu FAH-Git inkl. Token – nur 1× ein Token für alle Projekte“). Ein nachgestelltes FAH-Git (node:http) liefert Status,
// Baum, Projekt und Archiv; Docker ist eine Attrappe für den Compose-Weg (build + up), echte ZIPs über zip/unzip.

process.env.FAHNAS_UEBERWACHUNG = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { ausfuehren as echtAusfuehren } from '../../src/gemeinsam/system.js';
import { registriere } from '../../src/agent/aktionen/apps.js';
import { adresseNormieren, projekteFlach } from '../../src/agent/apps/fahgit.js';
import { projektName } from '../../src/agent/apps/docker.js';

const K = { chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, anna: { nutzer: 'anna', rolle: 'nutzer', ip: '-' } };
const TOKEN = 'fgit_abcdefghijklmnopqrstuvwxyz012345';
const PROJEKT = projektName('demo');
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const COMPOSE = 'services:\n  web:\n    build: .\n    ports:\n      - "18080:80"\n';
const MANAGE = '#!/usr/bin/env bash\necho "gebaut"\n';

/** ZIP wie `git archive --prefix=<slug>/`: alles in einem Projektordner. */
async function archivBauen(ziel, slug, version, art = 'compose') {
  const q = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-fgq-'));
  const d = path.join(q, slug);
  await fs.mkdir(d, { recursive: true });
  if (art === 'tief') {
    await fs.mkdir(path.join(d, 'extracted', 'dienst'), { recursive: true });
    await fs.writeFile(path.join(d, 'extracted', 'manage.sh'), MANAGE, { mode: 0o755 });
    await fs.writeFile(path.join(d, 'extracted', 'dienst', 'Dockerfile'), 'FROM nginx:alpine\n');
  } else {
    await fs.writeFile(path.join(d, 'docker-compose.yml'), COMPOSE);
    await fs.writeFile(path.join(d, 'Dockerfile'), 'FROM nginx:alpine\n');
    if (art === 'manage') await fs.writeFile(path.join(d, 'manage.sh'), MANAGE, { mode: 0o755 });
  }
  await fs.writeFile(path.join(d, 'VERSION'), `${version}\n`);
  await echtAusfuehren('zip', ['-q', '-r', ziel, slug], { cwd: q });
  await fs.rm(q, { recursive: true, force: true });
  return ziel;
}

/** Nachgestelltes FAH-Git: nur lesende Endpunkte, Bearer-Schlüssel Pflicht. */
async function fahgitServer(w) {
  const st = { kopf: SHA1, art: 'compose', abrufe: [] };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    st.abrufe.push(`${req.method} ${u.pathname}`);
    const json = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    if (u.pathname === '/api/status') return json(200, { version: '1.4.0', nutzer: ok ? { name: 'nas', anzeige: 'NAS', admin: false } : null });
    if (!ok) return json(401, { fehler: 'Bitte anmelden' });
    if (req.method !== 'GET') return json(403, { fehler: 'nur lesen' });
    if (u.pathname === '/api/baum') {
      return json(200, { ordner: [{ pfad: 'eigene-projekte', slug: 'eigene-projekte', name: 'Eigene Projekte', projekte: [], ordner: [
        { pfad: 'eigene-projekte/docker', slug: 'docker', name: 'Docker', ordner: [], projekte: [{ pfad: 'eigene-projekte/docker/demo', slug: 'demo', name: 'Demo', beschreibung: 'Probe' }] },
      ] }], projekte: [{ pfad: 'lose', slug: 'lose', name: 'Lose' }] });
    }
    if (u.pathname === '/api/projekt') {
      if (u.searchParams.get('pfad') !== 'eigene-projekte/docker/demo') return json(404, { fehler: 'Projekt nicht gefunden' });
      return json(200, { pfad: 'eigene-projekte/docker/demo', slug: 'demo', name: 'Demo', leer: false, standard: 'main',
        zweige: [{ name: 'main', sha: st.kopf, datum: '2026-10-26T08:00:00Z', betreff: st.kopf === SHA1 ? 'Version 1.0' : 'Version 2.0', autor: 'F' }, { name: 'test', sha: SHA1, betreff: 'alt' }] });
    }
    if (u.pathname === '/api/archiv') {
      const ref = u.searchParams.get('ref');
      if (ref !== SHA1 && ref !== SHA2) return json(404, { fehler: 'Commit unbekannt' });
      const datei = await archivBauen(path.join(w, `a-${st.abrufe.length}.zip`), 'demo', ref === SHA1 ? '1.0' : '2.0', st.art);
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(await fs.readFile(datei));
      return undefined;
    }
    return json(404, { fehler: 'unbekannt' });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  st.adresse = `http://127.0.0.1:${server.address().port}`;
  st.schliessen = () => new Promise((ok) => server.close(ok));
  return st;
}

/** Docker-Attrappe für den Compose-Weg: config liefert die Ports der Compose-Datei, up merkt sich laufende Projekte. */
function scheinSystem() {
  const st = { befehle: [], laufend: new Map(), manage: new Map() };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  async function roh(prog, args, opt) {
    if (prog === 'unzip' || prog === 'zip') return echtAusfuehren(prog, args, { ...opt, erlaubteCodes: [0, 1, 9, 11] });
    if (prog === 'cp') return echtAusfuehren(prog, args, opt);
    if (prog === 'bash') {
      st.manage.set(opt.cwd, (await fs.readFile(path.join(opt.cwd, 'VERSION'), 'utf8')).trim());
      return ok('gebaut\n');
    }
    if (prog === 'docker') {
      if (args[0] === 'version') return ok('29.1.3\n');
      if (args[0] === 'compose') {
        const projekt = args[args.indexOf('-p') + 1];
        const dateien = args.flatMap((a, i) => (args[i - 1] === '-f' ? [a] : []));
        if (args.includes('config') && args.includes('--format')) {
          const text = await fs.readFile(dateien[0], 'utf8');
          const m = /"(\d+):(\d+)"/.exec(text);
          return ok(JSON.stringify({ services: { web: { build: { context: '.' }, ports: m ? [{ published: m[1], target: Number(m[2]), protocol: 'tcp' }] : [] } } }));
        }
        if (args.includes('config')) return ok();
        if (args.includes('up')) { st.laufend.set(projekt, { version: (await fs.readFile(path.join(path.dirname(dateien[0]), 'VERSION'), 'utf8')).trim() }); return ok('gebaut\n'); }
        if (args.includes('ps')) return ok(st.laufend.has(projekt) ? `${JSON.stringify({ ID: 'abc123', Name: `${projekt}-web-1`, Service: 'web', State: 'running', Image: `${projekt}-web`, Status: 'Up', Publishers: [] })}\n` : '');
        if (args.includes('down')) { st.laufend.delete(projekt); return ok(); }
        return ok();
      }
      if (args[0] === 'ps' && args.includes('-q')) {
        const ordner = args[args.indexOf('--filter') + 1].replace('label=com.docker.compose.project.working_dir=', '');
        return ok(st.manage.has(ordner) ? `${Buffer.from(ordner).toString('hex').padEnd(64, '0').slice(0, 64)}\n` : '');
      }
      if (args[0] === 'inspect') {
        const ordner = Buffer.from(args[1].replace(/(00)+$/, ''), 'hex').toString();
        return ok(JSON.stringify([{ Id: args[1], Name: '/demo-web', State: { Status: 'running' }, Config: { Image: 'demo-web', Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': ordner, 'com.docker.compose.project.config_files': path.join(ordner, 'docker-compose.yml') } }, HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '18080' }] } } }]));
      }
      if (args[0] === 'ps') return ok('');
      return ok();
    }
    return ok();
  }
  st.ausfuehren = async (prog, args = [], opt = {}) => {
    st.befehle.push([prog, ...args]);
    const r = await roh(prog, args, opt);
    if (!(opt.erlaubteCodes || [0]).includes(r.code)) throw new FahnasFehler('E_SYSTEM', `Befehl ${prog} schlug fehl`, { code: r.code });
    return r;
  };
  st.starten = (prog, args = [], opt = {}) => {
    st.befehle.push([prog, ...args]);
    const kind = new EventEmitter();
    kind.stdout = new PassThrough(); kind.stderr = new PassThrough(); kind.kill = () => true;
    roh(prog, args, opt).then((r) => { kind.stdout.end(r.stdout || ''); kind.stderr.end(r.stderr || ''); setImmediate(() => kind.emit('close', r.code)); }, (e) => kind.emit('error', e));
    return kind;
  };
  return st;
}

async function umgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-fahgit-'));
  const pfade = { apps: path.join(w, 'data', 'apps'), shares: path.join(w, 'data', 'shares'), konfig: path.join(w, 'config'), katalog: path.join(w, 'katalog'), backup: path.join(w, 'data', 'backup'), nft: path.join(w, 'nft', 'fahnas.nft'), run: path.join(w, 'run') };
  for (const p of Object.values(pfade)) await fs.mkdir(p === pfade.nft ? path.dirname(p) : p, { recursive: true });
  const konfig = new Konfig(pfade.konfig); await konfig.sicherstellen();
  const system = scheinSystem();
  const eingestellt = [];
  const werkzeuge = { konfig, system, pfade, ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} }, datenkanal: null, aufgaben: { einstellen: (a) => { eingestellt.push(a); return `a${eingestellt.length}`; } } };
  const reg = new Register(); registriere(reg, werkzeuge);
  const fg = await fahgitServer(w);
  async function auf(name, params, kontext = K.chef) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    return aktion.ausfuehren(p, kontext, werkzeuge, { fortschritt() {}, abgebrochen: () => false });
  }
  return { w, pfade, konfig, system, fg, auf, eingestellt, aufraeumen: async () => { await fg.schliessen(); await fs.rm(w, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------------------------------------------------

test('FAH-Git: Adresse normieren, Baum flach', () => {
  assert.equal(adresseNormieren(' http://nas.local:3300/ '), 'http://nas.local:3300');
  assert.equal(adresseNormieren('https://git.example.org/basis'), 'https://git.example.org/basis');
  for (const falsch of ['', 'nas.local:3300', 'ftp://x', 'http://x/<a>']) assert.throws(() => adresseNormieren(falsch), /Adresse/);
  const flach = projekteFlach({ projekte: [{ pfad: 'a', slug: 'a', name: 'A' }], ordner: [{ name: 'O', projekte: [{ pfad: 'o/b', slug: 'b', name: 'B' }], ordner: [{ name: 'U', projekte: [{ pfad: 'o/u/c', slug: 'c' }], ordner: [] }] }] });
  assert.deepEqual(flach.map((p) => [p.pfad, p.ordner]), [['a', ''], ['o/b', 'O'], ['o/u/c', 'O / U']]);
});

test('FAH-Git: Verbindung speichern (nur Admins, erst prüfen dann speichern, Schlüssel nur für root lesbar und nie in Antworten)', async () => {
  const u = await umgebung();
  try {
    assert.deepEqual(await u.auf('fahgit.verbindung', {}), { eingerichtet: false, adresse: '', schluessel_anfang: '', geprueft: null });
    await assert.rejects(u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN }, K.anna), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: 'geheim' }), (e) => e.code === 'E_PARAMS' && /fgit_/.test(e.message));
    await assert.rejects(u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: 'fgit_falschfalschfalschfalschfalsch' }), (e) => e.code === 'E_RECHTE');
    assert.equal(await u.konfig.laden('fahgit.json', null), null, 'falscher Schlüssel wird nicht gespeichert');
    await assert.rejects(u.auf('fahgit.verbindung.speichern', { adresse: 'http://127.0.0.1:9', token: TOKEN }), (e) => e.code === 'E_SYSTEM' && /nicht erreichbar/.test(e.message));
    const v = await u.auf('fahgit.verbindung.speichern', { adresse: `${u.fg.adresse}/`, token: TOKEN });
    assert.equal(v.eingerichtet, true); assert.equal(v.adresse, u.fg.adresse); assert.equal(v.schluessel_anfang, 'fgit_abcd…');
    assert.equal(v.geprueft.nutzer, 'nas'); assert.equal(v.geprueft.version, '1.4.0');
    assert.ok(!JSON.stringify(v).includes(TOKEN), 'Schlüssel nie in der Antwort');
    assert.equal((await fs.stat(path.join(u.pfade.konfig, 'fahgit.json'))).mode & 0o777, 0o600);
    // leerer Schlüssel beim Ändern = bisheriger bleibt
    const v2 = await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: '' });
    assert.equal(v2.eingerichtet, true);
    assert.equal((await u.konfig.laden('fahgit.json')).token, TOKEN);
    assert.equal((await u.auf('fahgit.verbindung.pruefen', {})).geprueft.ok, true);
    // Projekte für die Auswahl
    const p = await u.auf('fahgit.projekte', {});
    assert.deepEqual(p.map((x) => [x.pfad, x.ordner]), [['lose', ''], ['eigene-projekte/docker/demo', 'Eigene Projekte / Docker']]);
    assert.equal((await u.auf('fahgit.zweige', { pfad: 'eigene-projekte/docker/demo' })).standard, 'main');
    await assert.rejects(u.auf('fahgit.zweige', { pfad: 'gibt/es/nicht' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    await u.auf('fahgit.verbindung.loeschen', {});
    await assert.rejects(u.auf('fahgit.projekte', {}), (e) => e.code === 'E_PARAMS' && /Noch keine Verbindung/.test(e.message));
  } finally { await u.aufraeumen(); }
});

test('FAH-Git: Projekt ohne manage.sh: holen → prüfen (Compose) → installieren → Stand → neuer Commit → aktualisieren, automatisch per Takt', async () => {
  const u = await umgebung();
  try {
    await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN });
    await assert.rejects(u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: 'gibtsnicht' }), (e) => e.code === 'E_NICHT_GEFUNDEN' && /Zweig/.test(e.message));
    const pr = await u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: '' });
    assert.match(pr.kennung, /^z[0-9a-f]{16}$/);
    assert.equal(pr.name_vorschlag, 'demo'); assert.equal(pr.manage, null, 'keine manage.sh im Projekt');
    assert.ok(!pr.riskant.some((r) => r.kennung === 'skript'));
    assert.deepEqual({ ...pr.fahgit, datum: undefined }, { pfad: 'eigene-projekte/docker/demo', name: 'Demo', zweig: 'main', commit: SHA1, betreff: 'Version 1.0', datum: undefined });
    assert.deepEqual(pr.installiert_als, []);

    const r = await u.auf('apps.zip.installieren', { kennung: pr.kennung, name: 'demo', titel: 'Demo', fahgit_auto: false });
    assert.equal(r.zustand === 'laeuft' || r.zustand === 'running' || typeof r.zustand === 'string', true);
    assert.ok(!u.system.befehle.some((b) => b[0] === 'bash'), 'ohne manage.sh läuft auch keine');
    assert.equal(u.system.laufend.get(PROJEKT).version, '1.0');
    const satz = await u.konfig.laden('apps/demo/app.json');
    assert.equal(satz.kategorie, 'FAH-Git'); assert.equal(satz.fahgit.commit, SHA1); assert.equal(satz.fahgit.auto, false);
    const liste = await u.auf('apps.liste', {});
    assert.equal(liste.find((a) => a.name === 'demo').fahgit.zweig, 'main');
    assert.equal((await u.auf('fahgit.projekte', {})).find((x) => x.pfad === 'eigene-projekte/docker/demo').app, 'demo', 'Projektliste zeigt die gebaute App');
    assert.deepEqual((await u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo' })).installiert_als, ['demo']);

    // gleicher Commit → nichts zu tun
    assert.equal((await u.auf('apps.fahgit.aktualisieren', { name: 'demo' })).gleich, true);
    let stand = await u.auf('apps.fahgit.stand', { frisch: true });
    assert.equal(stand.apps[0].neuer, false);

    // neuer Commit in FAH-Git
    u.fg.kopf = SHA2;
    stand = await u.auf('apps.fahgit.stand', { frisch: true });
    assert.equal(stand.apps[0].neuer, true); assert.equal(stand.apps[0].neu_betreff, 'Version 2.0');
    const a = await u.auf('apps.fahgit.aktualisieren', { name: 'demo' });
    assert.equal(a.gleich, false); assert.equal(a.commit, SHA2);
    assert.equal(u.system.laufend.get(PROJEKT).version, '2.0', 'neu gebaut');
    assert.equal((await u.konfig.laden('apps/demo/app.json')).fahgit.commit, SHA2);

    // Einstellungen: automatisch an, Zweig wechseln (unbekannter Zweig abgelehnt)
    await assert.rejects(u.auf('apps.fahgit.einstellen', { name: 'demo', zweig: 'nix' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    assert.equal((await u.auf('apps.fahgit.einstellen', { name: 'demo', auto: true })).fahgit.auto, true);
    // Takt: neuer Commit + automatisch → Aufgabe wird eingestellt
    const { starten, stoppen } = await import('../../src/agent/aktionen/apps.js');
    assert.equal(typeof starten, 'function'); await stoppen();
    u.fg.kopf = SHA1; // „neuer“ Stand aus Sicht der App (SHA2 eingespielt)
    const takt = (await import('../../src/agent/aktionen/apps.js'))._fahgitTakt();
    await takt();
    assert.equal(u.eingestellt.length, 1); assert.equal(u.eingestellt[0].aktion, 'apps.fahgit.aktualisieren');
    await u.eingestellt[0].arbeit({ fortschritt() {}, abgebrochen: () => false });
    assert.equal(u.system.laufend.get(PROJEKT).version, '1.0');
    // Nicht-Admins sehen die Herkunft nicht
    assert.equal((await u.auf('apps.liste', {}, K.anna)).length, 0);
  } finally { await u.aufraeumen(); }
});

test('FAH-Git: manage.sh hat Vorrang vor Compose – Installieren und Aktualisieren laufen über sie, ohne ZIP-Argument', async () => {
  const u = await umgebung();
  try {
    await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN });
    u.fg.art = 'manage';
    const pr = await u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: '' });
    assert.equal(pr.manage, 'demo/manage.sh');
    assert.ok(pr.riskant.some((r) => r.kennung === 'skript'), 'Skript muss bestätigt werden');
    await u.auf('apps.zip.installieren', { kennung: pr.kennung, name: 'demo', titel: 'Demo', bestaetigt_riskant: ['skript'] });
    const ordner = path.join(u.pfade.apps, 'demo');
    assert.deepEqual(u.system.befehle.filter((b) => b[0] === 'bash').map((b) => b.slice(1)), [['manage.sh', 'update']]);
    assert.equal(u.system.manage.get(ordner), '1.0');
    assert.ok(!(await fs.readdir(ordner)).some((n) => n.endsWith('.zip')), 'keine Git-ZIP im App-Ordner: sie hat einen Projektordner als oberste Ebene');
    const satz = await u.konfig.laden('apps/demo/app.json');
    assert.notEqual(satz.zip.ohne_skript, true);
    // Update: neue Dateien liegen im Ordner, eigene Dateien bleiben, manage.sh ohne ZIP
    await fs.writeFile(path.join(ordner, '.env'), 'GEHEIM=1\n');
    u.fg.kopf = SHA2;
    assert.equal((await u.auf('apps.fahgit.aktualisieren', { name: 'demo' })).gleich, false);
    assert.deepEqual(u.system.befehle.filter((b) => b[0] === 'bash').map((b) => b.slice(1)), [['manage.sh', 'update'], ['manage.sh', 'update']]);
    assert.equal(u.system.manage.get(ordner), '2.0');
    assert.equal(await fs.readFile(path.join(ordner, '.env'), 'utf8'), 'GEHEIM=1\n');
    assert.ok(!(await fs.readdir(ordner)).includes('demo'), 'kein Projektordner im App-Ordner');
  } finally { await u.aufraeumen(); }
});

test('Protokoll: Ausgabe der Installation ist abrufbar, dort meldet die manage.sh Adresse und Einrichtungscode', async () => {
  const u = await umgebung();
  try {
    await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN });
    u.fg.art = 'manage';
    const pr = await u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: '' });
    await u.auf('apps.zip.installieren', { kennung: pr.kennung, name: 'demo', titel: 'Demo', bestaetigt_riskant: ['skript'] });
    await fs.writeFile(path.join(u.pfade.apps, 'demo', 'fahnas-install.log'), 'eins\nzwei\nEinrichtungscode: ABCD-EFGH\n');
    assert.equal((await u.auf('apps.protokoll', { name: 'demo', zeilen: 2 })).installation_vorhanden, true);
    const i = await u.auf('apps.protokoll', { name: 'demo', zeilen: 2, installation: true });
    assert.deepEqual(i.zeilen, ['zwei', 'Einrichtungscode: ABCD-EFGH']);
    assert.equal(i.installation, true);
    await fs.rm(path.join(u.pfade.apps, 'demo', 'fahnas-install.log'));
    assert.equal((await u.auf('apps.protokoll', { name: 'demo', zeilen: 2 })).installation_vorhanden, false);
    await assert.rejects(u.auf('apps.protokoll', { name: 'demo', installation: true }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  } finally { await u.aufraeumen(); }
});

test('FAH-Git: schon per Compose gebaute App bleibt dabei, auch wenn das Projekt inzwischen eine manage.sh hat', async () => {
  const u = await umgebung();
  try {
    await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN });
    const pr = await u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: '' });
    await u.auf('apps.zip.installieren', { kennung: pr.kennung, name: 'demo', titel: 'Demo' });
    u.fg.art = 'manage'; u.fg.kopf = SHA2;
    await u.auf('apps.fahgit.aktualisieren', { name: 'demo' });
    assert.ok(!u.system.befehle.some((b) => b[0] === 'bash'), 'bestehender Weg ändert sich nicht');
    assert.equal(u.system.laufend.get(PROJEKT).version, '2.0');
    assert.equal((await u.konfig.laden('apps/demo/app.json')).zip.ohne_skript, true);
  } finally { await u.aufraeumen(); }
});

test('FAH-Git: manage.sh zu tief im Projekt → klare Meldung statt einer unbrauchbaren App', async () => {
  const u = await umgebung();
  try {
    await u.auf('fahgit.verbindung.speichern', { adresse: u.fg.adresse, token: TOKEN });
    u.fg.art = 'tief';
    await assert.rejects(u.auf('apps.fahgit.holen', { pfad: 'eigene-projekte/docker/demo', zweig: '' }), (e) => e.code === 'E_PARAMS' && /manage\.sh liegt in .*extracted/.test(e.message));
  } finally { await u.aufraeumen(); }
});
