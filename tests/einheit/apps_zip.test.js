// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ZIP-Apps (Betreiber 09.10.: „ZIPs wie unifi-extraktor über Apps installieren, alles stellt sich nach der inkludierten
// manage.sh ein“): echte ZIP (zip/unzip), echte Schein-manage.sh (bash), Docker als Attrappe. Die Schein-manage.sh macht,
// was die echten tun: ZIP suchen, entpacken, .env mit WEB_PORT anlegen (bleibt bei Updates), „starten“ (Merkdatei, aus der
// die Docker-Attrappe Container mit Compose-Labels baut), ZIP als .bak wegsichern.

process.env.FAHNAS_UEBERWACHUNG = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { ausfuehren as echtAusfuehren, starten as echtStarten } from '../../src/gemeinsam/system.js';
import { registriere } from '../../src/agent/aktionen/apps.js';
import { nameVorschlag, titelVorschlag, inhaltFinden, composeRisiken, webuiAusPorts } from '../../src/agent/apps/zip.js';

const K = { chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, anna: { nutzer: 'anna', rolle: 'nutzer', ip: '-' } };

const MANAGE_OK = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
case "\${1:-}" in
  update)
    zip="$(ls testapp*.zip 2>/dev/null | head -n1 || true)"
    [ -n "$zip" ] || { echo "FEHLER: Keine passende Deploy-Zip"; exit 1; }
    echo "==> Entpacke $zip"
    unzip -oq "$zip" -x manage.sh -d .
    [ -f .env ] || printf 'WEB_PORT=45913\\n' > .env
    printf '\\033[32m  ok\\033[0m gebaut\\n'
    echo "==> Container ersetzen"
    printf '{"projekt":"%s","port":%s,"version":"%s"}\\n' "$(basename "$PWD")" "$(grep '^WEB_PORT=' .env | cut -d= -f2)" "$(cat VERSION)" > .laeuft
    mv -f "$zip" "$zip.$(date +%s%N).bak"
    echo "Update abgeschlossen." ;;
  *) echo "Unbekannter Befehl"; exit 1 ;;
esac
`;
const MANAGE_KAPUTT = `#!/usr/bin/env bash
echo "==> Kompletter Neubau"
echo "ERROR: failed to solve: npm ci" >&2
echo "FEHLER: Bauen fehlgeschlagen – die bisherige Version läuft unverändert weiter." >&2
exit 3
`;
const COMPOSE = `services:
  web:
    build: .
    container_name: \${APP_NAME:-testapp}
    restart: unless-stopped
    ports:
      - "\${WEB_PORT:-45913}:80"
    volumes:
      - ./daten:/data
      - /var/run/docker.sock:/var/run/docker.sock
`;

/** ZIP bauen: dateien = {name: inhalt}; Unterordner möglich („projekt/manage.sh“). */
async function zipBauen(ziel, dateien) {
  const quelle = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-zipq-'));
  for (const [n, inhalt] of Object.entries(dateien)) {
    await fs.mkdir(path.dirname(path.join(quelle, n)), { recursive: true });
    await fs.writeFile(path.join(quelle, n), inhalt, { mode: n.endsWith('.sh') ? 0o755 : 0o644 });
  }
  await echtAusfuehren('zip', ['-q', '-r', ziel, '.'], { cwd: quelle });
  await fs.rm(quelle, { recursive: true, force: true });
  return ziel;
}

/** Docker-Attrappe: Container entstehen aus der Merkdatei .laeuft im App-Ordner (geschrieben von der Schein-manage.sh). */
function scheinSystem(pfade) {
  const st = { befehle: [], gestoppt: new Set() };
  async function laufende() {
    const aus = [];
    let namen = []; try { namen = await fs.readdir(pfade.apps); } catch { /* leer */ }
    for (const n of namen) {
      const ordner = path.join(pfade.apps, n);
      let m; try { m = JSON.parse(await fs.readFile(path.join(ordner, '.laeuft'), 'utf8')); } catch { continue; }
      aus.push({ id: Buffer.from(ordner).toString('hex').padEnd(64, '0').slice(0, 64), ordner, projekt: m.projekt, port: m.port, version: m.version, webui: m.webui || null, zustand: st.gestoppt.has(m.projekt) ? 'exited' : 'running' });
    }
    return aus;
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  async function roh(prog, args, opt) {
    if (prog === 'unzip' || prog === 'zip') return echtAusfuehren(prog, args, { ...opt, erlaubteCodes: [0, 1, 9, 11] });
    if (prog === 'docker') {
      if (args[0] === 'version') return ok('29.1.3\n');
      if (args[0] === 'ps' && args.includes('-q')) {
        const f = args[args.indexOf('--filter') + 1].replace('label=com.docker.compose.project.working_dir=', '');
        return ok((await laufende()).filter((c) => c.ordner === f).map((c) => c.id).join('\n') + '\n');
      }
      if (args[0] === 'ps') return ok((await laufende()).map((c) => JSON.stringify({ ID: c.id, Names: `${c.projekt}-web`, Image: `${c.projekt}-web`, State: c.zustand, Status: 'Up', Labels: `com.docker.compose.project=${c.projekt},com.docker.compose.service=web`, Ports: c.zustand === 'running' ? `0.0.0.0:${c.port}->80/tcp` : '' })).join('\n') + '\n');
      if (args[0] === 'inspect') {
        const alle = await laufende();
        return ok(JSON.stringify(args.slice(1).map((id) => alle.find((c) => c.id === id)).filter(Boolean).map((c) => ({
          Id: c.id, Name: `/${c.projekt}-web`, State: { Status: c.zustand },
          Config: { Image: `${c.projekt}-web`, Labels: { 'com.docker.compose.project': c.projekt, 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': c.ordner, 'com.docker.compose.project.config_files': path.join(c.ordner, 'docker-compose.yml'), ...(c.webui ? { 'fahnas.webui': c.webui } : {}) } },
          HostConfig: { NetworkMode: `${c.projekt}_default`, PortBindings: { '80/tcp': [{ HostIp: '', HostPort: String(c.port) }], '9229/tcp': [{ HostIp: '127.0.0.1', HostPort: '9229' }] } },
        }))));
      }
      if (args[0] === 'rm') { for (const c of await laufende()) if (args.includes(c.id)) await fs.rm(path.join(c.ordner, '.laeuft'), { force: true }); return ok(); }
      if (args[0] === 'stats') return ok('');
      if (args[0] === 'compose') {
        const projekt = args[args.indexOf('-p') + 1];
        const sub = args.find((a, i) => i > args.lastIndexOf('-f') + 1 && !a.startsWith('-')) || args[args.length - 1];
        const meine = (await laufende()).filter((c) => c.projekt === projekt);
        if (sub === 'ps') return ok(meine.map((c) => JSON.stringify({ ID: c.id.slice(0, 12), Name: `${c.projekt}-web`, Service: 'web', State: c.zustand, Image: `${c.projekt}-web`, Status: 'Up', Publishers: [] })).join('\n') + '\n');
        if (sub === 'stop') { st.gestoppt.add(projekt); return ok(); }
        if (sub === 'up') { st.gestoppt.delete(projekt); return ok(); }
        if (sub === 'down') { for (const c of meine) await fs.rm(path.join(c.ordner, '.laeuft'), { force: true }); return ok(); }
        if (sub === 'logs') return ok('web-1  | läuft\n');
        return ok();
      }
      return { code: 1, stdout: '', stderr: `unbekannt: docker ${args.join(' ')}` };
    }
    if (prog === 'ip') return ok('1.1.1.1 via 192.168.1.1 dev eno1 src 192.168.1.29 uid 0\n');
    return ok();
  }
  st.ausfuehren = async (prog, args = [], opt = {}) => {
    st.befehle.push([prog, ...args]);
    const r = await roh(prog, args, opt);
    if (!(opt.erlaubteCodes || [0]).includes(r.code)) throw new FahnasFehler('E_SYSTEM', `Befehl ${prog} schlug fehl`, { befehl: [prog, ...args].join(' '), code: r.code, ausgabe: r.stderr || r.stdout });
    return r;
  };
  // Echt gestartet wird NUR bash (die Schein-manage.sh). Docker über starten (Docker.dockerMitZeilen, z. B. compose up)
  // geht in die Attrappe – sonst liefe ein echtes „docker compose up“ auf dem Testrechner (am 09.10. so passiert).
  st.starten = (prog, args = [], opt = {}) => {
    if (prog === 'bash') { st.befehle.push(['starten', prog, ...args]); return echtStarten(prog, args, opt); }
    st.befehle.push([prog, ...args]);
    const kind = new EventEmitter();
    kind.stdout = new PassThrough(); kind.stderr = new PassThrough(); kind.kill = () => true;
    roh(prog, args, {}).then((r) => { kind.stdout.end(r.stdout || ''); kind.stderr.end(r.stderr || ''); setImmediate(() => kind.emit('close', r.code)); }, (e) => kind.emit('error', e));
    return kind;
  };
  return st;
}

async function umgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-zip-'));
  const pfade = { apps: path.join(w, 'data', 'apps'), shares: path.join(w, 'data', 'shares'), konfig: path.join(w, 'config'), katalog: path.join(w, 'katalog'), backup: path.join(w, 'data', 'backup'), nft: path.join(w, 'nft', 'fahnas.nft'), run: path.join(w, 'run') };
  for (const p of Object.values(pfade)) await fs.mkdir(p === pfade.nft ? path.dirname(p) : p, { recursive: true });
  const konfig = new Konfig(pfade.konfig); await konfig.sicherstellen();
  const system = scheinSystem(pfade);
  const tickets = [];
  const werkzeuge = { konfig, system, pfade, ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} }, datenkanal: { ticket(d) { tickets.push(d); return { ticket: `k-${tickets.length}`, dateiname: d.dateiname }; } } };
  const reg = new Register(); registriere(reg, werkzeuge);
  const verlauf = [];
  let abbruch = false;
  async function auf(name, params, kontext = K.chef) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    return aktion.ausfuehren(p, kontext, werkzeuge, { fortschritt: (a, m) => verlauf.push([a, m]), abgebrochen: () => abbruch });
  }
  /** Wie die Oberfläche: Ticket holen, „hochladen“ (Datei an den Ticket-Pfad kopieren), Kennung zurück. */
  async function hochladen(zipDatei, dateiname) {
    const groesse = (await fs.stat(zipDatei)).size;
    const r = await auf('apps.zip.ticket', { dateiname, groesse });
    await fs.copyFile(zipDatei, tickets[tickets.length - 1].pfad);
    return r.kennung;
  }
  return { w, pfade, konfig, system, tickets, auf, hochladen, verlauf, abbrechen: () => { abbruch = true; }, aufraeumen: () => fs.rm(w, { recursive: true, force: true }) };
}

const ZIP_DATEIEN = (version = '1.0') => ({ 'manage.sh': MANAGE_OK, 'docker-compose.yml': COMPOSE, Dockerfile: 'FROM nginx:alpine\n', VERSION: `${version}\n`, 'server/app.js': 'console.log(1)\n' });

// ---------------------------------------------------------------------------------------------------------------------

test('ZIP-Apps: Namens-/Titelvorschlag, manage.sh im Wurzel- oder Projektordner, Risiken aus der Compose-Datei, Öffnen-Link', () => {
  assert.equal(nameVorschlag('unifi-extraktor.zip'), 'unifi-extraktor');
  assert.equal(nameVorschlag('FunkSichta_release (2).zip'), 'funksichta');
  assert.equal(nameVorschlag('fah-converter (11).zip'), 'fah-converter');
  assert.equal(nameVorschlag('allinone_whitelabel_release.zip'), 'allinone-whitelabel');
  assert.equal(nameVorschlag('Ä.zip'), '');
  assert.equal(titelVorschlag('FunkSichta_release.zip'), 'FunkSichta');
  assert.deepEqual(inhaltFinden(['manage.sh', 'docker-compose.yml', 'Dockerfile', 'tools/manage.sh']).manage, 'manage.sh');
  const unter = inhaltFinden(['fah-ausleuchter/manage.sh', 'fah-ausleuchter/docker-compose.yml.example', 'fah-ausleuchter/backend/Dockerfile']);
  assert.equal(unter.manage, 'fah-ausleuchter/manage.sh'); assert.equal(unter.compose, 'fah-ausleuchter/docker-compose.yml.example'); assert.equal(unter.dockerfile, true);
  assert.equal(inhaltFinden(['a/b/manage.sh', 'README.md']).manage, null, 'tiefer als eine Ebene zählt nicht');
  assert.equal(inhaltFinden(['__MACOSX/manage.sh']).manage, null);
  const r = composeRisiken(COMPOSE);
  assert.deepEqual(r.risiken.map((x) => x.art), ['docker_sock'], './daten im App-Ordner ist harmlos, docker.sock nicht');
  assert.deepEqual(composeRisiken('services:\n  a:\n    image: x\n    privileged: true\n    network_mode: host\n    volumes:\n      - /etc/localtime:/etc/localtime:ro\n      - /srv/medien:/medien\n').risiken.map((x) => x.art), ['privileged', 'network_host', 'host_pfade']);
  assert.equal(webuiAusPorts([{ port: 9000, protokoll: 'tcp', ziel: 9000 }, { port: 45913, protokoll: 'tcp', ziel: 80 }]), 'http://{HOST}:45913/');
  assert.equal(webuiAusPorts([{ port: 8443, protokoll: 'tcp', ziel: 443 }]), 'https://{HOST}:8443/');
  assert.equal(webuiAusPorts([{ port: 53, protokoll: 'udp', ziel: 53 }]), '');
});

test('ZIP-Apps: hochladen → prüfen → installieren (manage.sh update) → Liste, Steuern, Autostart, Firewall; Rechte und Bestätigungen', async () => {
  const u = await umgebung();
  try {
    const zip = await zipBauen(path.join(u.w, 'testapp.zip'), ZIP_DATEIEN('1.0'));
    // nur Admins, nur .zip
    await assert.rejects(u.auf('apps.zip.ticket', { dateiname: 'testapp.zip', groesse: 10 }, K.anna), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.auf('apps.zip.ticket', { dateiname: 'testapp.tar', groesse: 10 }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('apps.zip.ticket', { dateiname: '../x.zip', groesse: 10 }), (e) => e.code === 'E_PARAMS');
    const kennung = await u.hochladen(zip, 'testapp.zip');
    assert.match(kennung, /^z[0-9a-f]{16}$/);
    assert.equal(u.tickets[0].uid, 0, 'Eingang schreibt root'); assert.equal(u.tickets[0].art, 'schreiben');
    await assert.rejects(u.auf('apps.zip.pruefen', { kennung: 'zffffffffffffffff' }), (e) => e.code === 'E_NICHT_GEFUNDEN');

    const pr = await u.auf('apps.zip.pruefen', { kennung });
    assert.equal(pr.manage, 'manage.sh'); assert.equal(pr.compose_datei, 'docker-compose.yml'); assert.equal(pr.dockerfile, true);
    assert.equal(pr.name_vorschlag, 'testapp'); assert.equal(pr.name_frei, true); assert.deepEqual(pr.installiert_als, []);
    assert.deepEqual(pr.riskant.map((r) => r.kennung), ['skript', 'docker_sock'], 'Skript immer, dazu docker.sock aus der Compose-Datei');
    assert.ok(pr.compose.includes('docker.sock'));

    // ohne Bestätigung: abgelehnt, die ZIP bleibt im Eingang (erneut versuchen geht)
    await assert.rejects(u.auf('apps.zip.installieren', { kennung, name: 'testapp', bestaetigt_riskant: ['skript'] }), (e) => e.code === 'E_RECHTE');
    const r = await u.auf('apps.zip.installieren', { kennung, name: 'testapp', bestaetigt_riskant: ['skript', 'docker_sock'] });
    assert.equal(r.zustand, 'running');
    assert.deepEqual(r.ports, [{ port: 45913, protokoll: 'tcp', ziel: 80, dienst: 'web' }], 'nur der veröffentlichte Port, nicht der 127.0.0.1-Port');
    assert.equal(r.webui, 'http://{HOST}:45913/');
    const ordner = path.join(u.pfade.apps, 'testapp');
    // so, wie die manage.sh es will: Skript ausführbar daneben, ZIP mit Originalnamen (danach als .bak weggesichert), .env von ihr
    assert.ok(((await fs.stat(path.join(ordner, 'manage.sh'))).mode & 0o111) !== 0, 'manage.sh ausführbar');
    assert.ok((await fs.readdir(ordner)).some((n) => /^testapp\.zip\.\d+\.bak$/.test(n)), 'die manage.sh hat die ZIP gefunden und weggesichert');
    assert.equal(await fs.readFile(path.join(ordner, '.env'), 'utf8'), 'WEB_PORT=45913\n');
    const log = await fs.readFile(path.join(ordner, 'fahnas-install.log'), 'utf8');
    assert.ok(log.includes('Update abgeschlossen.') && log.includes('  ok gebaut') && !log.includes('\x1b['), 'Protokoll vollständig, ohne Farbcodes');
    assert.ok(u.system.befehle.some((b) => b[0] === 'starten' && b[1] === 'bash' && b[2] === 'manage.sh' && b[3] === 'update'));
    assert.ok(u.verlauf.some(([, m]) => m === 'Update abgeschlossen.'), 'Zeilen der manage.sh als Fortschritt');
    assert.deepEqual(await fs.readdir(path.join(u.pfade.apps, '_eingang')), [], 'Eingang aufgeräumt');
    // Firewall gibt den Port frei
    assert.ok((await fs.readFile(u.pfade.nft, 'utf8')).includes('45913'));
    // Satz
    const satz = await u.konfig.laden('apps/testapp/app.json');
    assert.equal(satz.art, 'zip'); assert.equal(satz.projekt, 'testapp'); assert.deepEqual(satz.compose_dateien, [path.join(ordner, 'docker-compose.yml')]);
    assert.equal(satz.zip.datei, 'testapp.zip'); assert.match(satz.zip.sha256, /^[0-9a-f]{64}$/); assert.deepEqual(satz.bestaetigt_riskant, ['skript', 'docker_sock']);

    // Liste: Zustand über das Compose-Projekt der manage.sh
    const [a] = await u.auf('apps.liste', {}, K.chef);
    assert.equal(a.name, 'testapp'); assert.equal(a.art, 'zip'); assert.equal(a.zustand, 'running'); assert.equal(a.zip.datei, 'testapp.zip'); assert.equal(a.webui, 'http://{HOST}:45913/');
    // Steuern über docker compose mit Projekt/Ordner/Datei der manage.sh
    await u.auf('apps.steuern', { name: 'testapp', aktion: 'stopp' });
    const stopp = u.system.befehle.find((b) => b[0] === 'docker' && b[1] === 'compose' && b.includes('stop'));
    assert.deepEqual(stopp.slice(stopp.indexOf('-p')), ['-p', 'testapp', '--project-directory', ordner, '-f', path.join(ordner, 'docker-compose.yml'), 'stop']);
    assert.ok(!stopp.includes('--env-file'), '.env liest compose selbst aus dem Ordner');
    assert.equal((await u.auf('apps.liste', {}))[0].zustand, 'exited');
    await u.auf('apps.steuern', { name: 'testapp', aktion: 'start' });
    const up = u.system.befehle.find((b) => b[0] === 'docker' && b[1] === 'compose' && b.includes('up'));
    assert.deepEqual(up.slice(up.indexOf('-p')), ['-p', 'testapp', '--project-directory', ordner, '-f', path.join(ordner, 'docker-compose.yml'), 'up', '-d', '--remove-orphans']);
    assert.equal((await u.auf('apps.liste', {}))[0].zustand, 'running');
    // keine Einstellungen, nur Autostart; Aktualisieren läuft über eine neue ZIP
    await assert.rejects(u.auf('apps.aendern', { name: 'testapp', werte: { X: 1 } }), (e) => e.code === 'E_PARAMS');
    assert.equal((await u.auf('apps.aendern', { name: 'testapp', autostart: false })).autostart, false);
    await assert.rejects(u.auf('apps.aktualisieren', { name: 'testapp' }), (e) => e.code === 'E_PARAMS' && /neuen ZIP/.test(e.message));
    // Protokoll
    assert.deepEqual((await u.auf('apps.protokoll', { name: 'testapp' }, K.chef)).dienste, ['web']);
    // Name schon vergeben
    const k2 = await u.hochladen(zip, 'testapp.zip');
    assert.equal((await u.auf('apps.zip.pruefen', { kennung: k2 })).name_frei, false);
    assert.deepEqual((await u.auf('apps.zip.pruefen', { kennung: k2 })).installiert_als, ['testapp'], 'gleiche ZIP-App erkannt → Oberfläche bietet „neue ZIP einspielen“ an');
    await assert.rejects(u.auf('apps.zip.installieren', { kennung: k2, name: 'testapp', bestaetigt_riskant: ['skript', 'docker_sock'] }), (e) => e.code === 'E_EXISTIERT');
  } finally { await u.aufraeumen(); }
});

test('ZIP-Apps: neue ZIP einspielen (Daten und .env bleiben, Bestätigungen gelten weiter), Fehler lässt die laufende Version stehen, Löschen', async () => {
  const u = await umgebung();
  try {
    const k1 = await u.hochladen(await zipBauen(path.join(u.w, 'v1.zip'), ZIP_DATEIEN('1.0')), 'testapp.zip');
    await u.auf('apps.zip.installieren', { kennung: k1, name: 'testapp', bestaetigt_riskant: ['skript', 'docker_sock'] });
    const ordner = path.join(u.pfade.apps, 'testapp');
    await fs.mkdir(path.join(ordner, 'daten'), { recursive: true }); await fs.writeFile(path.join(ordner, 'daten', 'konten.json'), '{"admin":1}');
    await fs.writeFile(path.join(ordner, '.env'), 'WEB_PORT=45999\n'); // vom Nutzer per „manage.sh port“ geändert
    const vorher = await u.konfig.laden('apps/testapp/app.json');

    // Update ohne erneute Bestätigung (gleiche Risiken), Browser-Name „testapp (1).zip“
    const k2 = await u.hochladen(await zipBauen(path.join(u.w, 'v2.zip'), ZIP_DATEIEN('2.0')), 'testapp (1).zip');
    const r = await u.auf('apps.zip.aktualisieren', { kennung: k2, name: 'testapp' });
    assert.equal(r.zustand, 'running'); assert.equal(r.gleich, false);
    assert.deepEqual(r.ports.map((p) => p.port), [45999], 'Port aus der .env der App übernommen');
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, '.laeuft'), 'utf8')).version, '2.0');
    assert.equal(await fs.readFile(path.join(ordner, 'daten', 'konten.json'), 'utf8'), '{"admin":1}', 'Daten unberührt');
    const nachher = await u.konfig.laden('apps/testapp/app.json');
    assert.equal(nachher.zip.datei, 'testapp (1).zip'); assert.notEqual(nachher.zip.sha256, vorher.zip.sha256);
    assert.equal(nachher.installiert, vorher.installiert); assert.notEqual(nachher.aktualisiert, vorher.aktualisiert);
    assert.ok((await fs.readFile(u.pfade.nft, 'utf8')).includes('45999'));

    // Update scheitert (die ZIP passt nicht zum Suchmuster der manage.sh): Fehler mit den letzten Zeilen, die bisherige
    // Version läuft weiter, die neue ZIP bleibt nicht im Ordner liegen (sonst nähme ein späteres update sie ungefragt)
    const k3 = await u.hochladen(await zipBauen(path.join(u.w, 'v3.zip'), ZIP_DATEIEN('3.0')), 'anders.zip');
    await assert.rejects(u.auf('apps.zip.aktualisieren', { kennung: k3, name: 'testapp' }), (e) => e.code === 'E_SYSTEM' && /Keine passende Deploy-Zip/.test(e.details.ausgabe));
    await assert.rejects(fs.access(path.join(ordner, 'anders.zip')));
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, '.laeuft'), 'utf8')).version, '2.0', 'bisherige Version läuft weiter');
    assert.deepEqual((await fs.readdir(path.join(u.pfade.apps, '_eingang'))).filter((n) => n.endsWith('.zip')), [], 'Eingang leer');
    assert.equal((await u.auf('apps.liste', {}))[0].zustand, 'running');
    assert.equal((await u.konfig.laden('apps/testapp/app.json')).zip.datei, 'testapp (1).zip', 'Satz unverändert');

    // Löschen mit Daten
    await u.auf('apps.loeschen', { name: 'testapp', daten: 'loeschen' });
    const down = u.system.befehle.find((b) => b[0] === 'docker' && b[1] === 'compose' && b.includes('down'));
    assert.ok(down.includes('--volumes') && down.includes('testapp'));
    await assert.rejects(fs.access(ordner));
    assert.deepEqual(await u.auf('apps.liste', {}), []);
  } finally { await u.aufraeumen(); }
});

test('ZIP-Apps: manage.sh scheitert bei der Installation → Fehler mit den letzten Zeilen, nichts bleibt stehen, Protokoll im Eingang; ZIP ohne manage.sh', async () => {
  const u = await umgebung();
  try {
    const k = await u.hochladen(await zipBauen(path.join(u.w, 'kaputt.zip'), { 'manage.sh': MANAGE_KAPUTT, 'docker-compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "8099:80"\n', Dockerfile: 'FROM x\n' }), 'kaputt.zip');
    const pr = await u.auf('apps.zip.pruefen', { kennung: k });
    assert.deepEqual(pr.riskant.map((r) => r.kennung), ['skript']);
    await assert.rejects(u.auf('apps.zip.installieren', { kennung: k, name: 'kaputt', bestaetigt_riskant: ['skript'] }), (e) => {
      assert.equal(e.code, 'E_SYSTEM');
      assert.match(e.message, /manage\.sh update brach ab \(Code 3\)/);
      assert.ok(e.details.ausgabe.includes('failed to solve: npm ci'), 'letzte Zeilen der manage.sh in den Details');
      assert.ok(e.details.protokoll && e.details.protokoll.includes('_eingang'), 'Protokoll gerettet');
      return true;
    });
    await assert.rejects(fs.access(path.join(u.pfade.apps, 'kaputt')), 'Ordner entfernt');
    assert.equal(await u.konfig.laden('apps/kaputt/app.json', null), null);
    const gerettet = (await fs.readdir(path.join(u.pfade.apps, '_eingang'))).find((n) => n.startsWith('kaputt-fehler-'));
    assert.ok((await fs.readFile(path.join(u.pfade.apps, '_eingang', gerettet), 'utf8')).includes('Bauen fehlgeschlagen'));

    // manage.sh läuft durch, startet aber nichts aus dem Ordner
    const leer = '#!/usr/bin/env bash\necho fertig\n';
    const k2 = await u.hochladen(await zipBauen(path.join(u.w, 'leer.zip'), { 'manage.sh': leer }), 'leer.zip');
    assert.ok((await u.auf('apps.zip.pruefen', { kennung: k2 })).warnungen.some((x) => /keine Compose-Datei/.test(x)));
    await assert.rejects(u.auf('apps.zip.installieren', { kennung: k2, name: 'leer', bestaetigt_riskant: ['skript'] }), (e) => e.code === 'E_SYSTEM' && /kein Container/.test(e.message));

    // ZIP ohne manage.sh / keine ZIP
    const k3 = await u.hochladen(await zipBauen(path.join(u.w, 'ohne.zip'), { 'README.md': 'x' }), 'ohne.zip');
    // seit 12.10.2026: ohne manage.sh geht es mit Compose-Datei oder Dockerfile – nur ganz ohne beides wird abgelehnt
    await assert.rejects(u.auf('apps.zip.pruefen', { kennung: k3 }), (e) => e.code === 'E_PARAMS' && /weder eine manage\.sh noch eine Compose-Datei oder ein Dockerfile/.test(e.message));
    const unsinn = path.join(u.w, 'unsinn.zip'); await fs.writeFile(unsinn, 'kein zip');
    const k4 = await u.hochladen(unsinn, 'unsinn.zip');
    await assert.rejects(u.auf('apps.zip.pruefen', { kennung: k4 }), (e) => e.code === 'E_PARAMS' && /keine lesbare ZIP/.test(e.message));
  } finally { await u.aufraeumen(); }
});

test('ZIP-Apps mit Projektordner wie FunkSichta (Betreiber-Fund 09.10.: „tools/port_waehlen.sh: No such file“): Inhalt wird entpackt, Update bekommt den ZIP-Pfad', async () => {
  const u = await umgebung();
  try {
    // „unzip; cd projekt; bash manage.sh update“ – die manage.sh bindet tools/ ihres Ordners ein; Updates: „manage.sh update <zip>“
    const MANAGE_B = `#!/usr/bin/env bash
set -euo pipefail
WURZEL="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$WURZEL/tools/helfer.sh"
case "\${1:-}" in
  update)
    if [ -n "\${2:-}" ]; then echo "==> spiele $2 ein"; t="$(mktemp -d)"; unzip -oq "$2" -d "$t"; cp -f "$t/projekt/VERSION" "$WURZEL/VERSION"; rm -rf "$t"; fi
    [ -f "$WURZEL/.env" ] || printf 'WEB_PORT=48080\\n' > "$WURZEL/.env"
    helfer_starten ;;
  *) exit 2 ;;
esac
`;
    const HELFER = `helfer_starten() { printf '{"projekt":"%s","port":%s,"version":"%s","webui":"http://{HOST}:18181/"}\\n' "$(basename "$WURZEL")" "$(grep '^WEB_PORT=' "$WURZEL/.env" | cut -d= -f2)" "$(cat "$WURZEL/VERSION")" > "$WURZEL/.laeuft"; echo "Fertig."; }\n`;
    const dateien = (v) => ({ 'projekt/manage.sh': MANAGE_B, 'projekt/tools/helfer.sh': HELFER, 'projekt/docker-compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "${WEB_PORT:-48080}:80"\n', 'projekt/Dockerfile': 'FROM x\n', 'projekt/VERSION': `${v}\n` });
    const k1 = await u.hochladen(await zipBauen(path.join(u.w, 'fs1.zip'), dateien('1.0')), 'FunkSichta_release.zip');
    const pr = await u.auf('apps.zip.pruefen', { kennung: k1 });
    assert.equal(pr.manage, 'projekt/manage.sh'); assert.equal(pr.ordner, 'projekt'); assert.equal(pr.name_vorschlag, 'funksichta');
    const r = await u.auf('apps.zip.installieren', { kennung: k1, name: 'funksichta', bestaetigt_riskant: ['skript'] });
    assert.equal(r.zustand, 'running'); assert.deepEqual(r.ports.map((p) => p.port), [48080]);
    assert.equal(r.webui, 'http://{HOST}:18181/', 'Label fahnas.webui schlägt den Port-Vorschlag');
    const ordner = path.join(u.pfade.apps, 'funksichta');
    // Inhalt des Projektordners liegt direkt im App-Ordner (kein projekt/ darunter), manage.sh ausführbar
    assert.ok(await fs.stat(path.join(ordner, 'tools', 'helfer.sh')));
    await assert.rejects(fs.access(path.join(ordner, 'projekt')));
    assert.ok(((await fs.stat(path.join(ordner, 'manage.sh'))).mode & 0o111) !== 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, '.laeuft'), 'utf8')).version, '1.0');
    assert.ok(!(await fs.readdir(ordner)).some((n) => n.endsWith('.zip')), 'nicht gebrauchte ZIP weggeräumt');
    // Update: die manage.sh bekommt den Pfad der neuen ZIP
    const k2 = await u.hochladen(await zipBauen(path.join(u.w, 'fs2.zip'), dateien('2.0')), 'FunkSichta_release.zip');
    await u.auf('apps.zip.aktualisieren', { kennung: k2, name: 'funksichta' });
    const aufruf = u.system.befehle.filter((b) => b[0] === 'starten' && b[1] === 'bash').pop();
    assert.deepEqual(aufruf.slice(2), ['manage.sh', 'update', path.join(ordner, 'FunkSichta_release.zip')]);
    assert.equal(JSON.parse(await fs.readFile(path.join(ordner, '.laeuft'), 'utf8')).version, '2.0');
    assert.equal(await fs.readFile(path.join(ordner, '.env'), 'utf8'), 'WEB_PORT=48080\n', '.env bleibt');
    assert.ok(!(await fs.readdir(ordner)).some((n) => n.endsWith('.zip')));
    assert.ok((await fs.readFile(path.join(ordner, 'fahnas-install.log'), 'utf8')).includes(`manage.sh update ${path.join(ordner, 'FunkSichta_release.zip')}`));
  } finally { await u.aufraeumen(); }
});
