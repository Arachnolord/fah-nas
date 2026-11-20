// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/aktionen/apps.js mit nachgespieltem Docker (compose pull/up/down/ps/logs/config, docker ps/
// stats/image inspect, ss, nft, curl, du, cp, mv): Katalog (eingebaut, Import, Unraid-Feed), Vorschau/Konflikte,
// Installieren (Dateien, Befehlsfolge, Spiegel, Firewall, Aufräumen bei Fehler, Risiko-Bestätigung), Liste mit
// CPU/RAM und Zwischenspeicher, Details, Steuern, Protokoll, Ändern (Geheimnisse bleiben), Aktualisieren (Digest,
// Sicherung < 5 GiB), Löschen behalten/löschen, apply/Autostart, apps.ports, Firewall-Renderer liest den Spiegel,
// Hilfen in docker.js (JSON-Zeilen, Speicher, Ports, Zustand, Fortschrittslauf über starten).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { registriere } from '../../src/agent/aktionen/apps.js';
import { yamlLesen, einsetzen } from '../../src/agent/apps/compose.js';
import { Docker, jsonZeilen, speicherParsen, portsParsen, labelsParsen, zustandZusammenfassen } from '../../src/agent/apps/docker.js';
import { rendereFirewall, appPortsLesen, nftText } from '../../src/agent/render/firewall.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const KATALOG = path.join(HIER, '..', 'daten', 'katalog');
const UNRAID = path.join(HIER, '..', 'daten', 'unraid');
const K = { chef: { nutzer: 'chef', rolle: 'admin', ip: '-' }, anna: { nutzer: 'anna', rolle: 'nutzer', ip: '-' }, system: { nutzer: 'system', rolle: 'system', ip: '-' } };
const ok = { code: 0, stdout: '', stderr: '' };

function envLesen(text) { const aus = {}; for (const z of String(text).split('\n')) { const m = /^([A-Z][A-Z0-9_]*)='(.*)'$/.exec(z.trim()); if (m) aus[m[1]] = m[2]; } return aus; }

/** Nachgespieltes Docker: Container je Projekt im Speicher, Compose-Dateien werden wirklich gelesen. */
function scheinDocker() {
  const st = {
    container: new Map(), images: new Map(), labels: new Map(), befehle: [], ssPorts: ['22/tcp', '443/tcp', '445/tcp', '5353/udp'], buildx: true, bauFehler: null,
    pullFehler: null, kaputt: null, curl: null, duGroesse: 1024 * 1024, logs: ['2026-09-25T12:00:00Z hallo', '2026-09-25T12:00:01Z welt'], statsCpu: 1.5, dockerDa: true,
  };
  const digestVon = (image) => st.images.get(image) || null;
  async function composeLesen(args) {
    const f = args[args.indexOf('-f') + 1]; const e = args[args.indexOf('--env-file') + 1];
    const text = await fs.readFile(f, 'utf8');
    const env = envLesen(await fs.readFile(e, 'utf8').catch(() => ''));
    return { doc: yamlLesen(einsetzen(text, env)), projekt: args[args.indexOf('-p') + 1] };
  }
  const portsVon = (d) => (Array.isArray(d.ports) ? d.ports : []).map((p) => { const m = /^(\d+):(\d+)(?:\/(udp))?$/.exec(String(p)); return m ? { port: Number(m[1]), ziel: Number(m[2]), protokoll: m[3] || 'tcp' } : null; }).filter(Boolean);
  async function roh(prog, args, opt) {
    if (st.kaputt) { const f = st.kaputt(prog, args); if (f) return { code: f.code ?? 1, stdout: '', stderr: f.stderr || 'erzwungener Fehler' }; }
    if (prog === 'docker' && args[0] === 'compose') {
      assert.deepEqual(args.slice(1, 5), ['--ansi', 'never', '--progress', 'plain']);
      assert.ok(args.includes('-p') && args.includes('-f') && args.includes('--env-file'), 'compose immer mit -p/-f/--env-file');
      const sub = args[args.indexOf('--env-file') + 2];
      const rest = args.slice(args.indexOf('--env-file') + 3);
      const { doc, projekt } = await composeLesen(args);
      const liste = st.container.get(projekt) || [];
      switch (sub) {
        case 'config': {
          if (rest.includes('--images')) return { ...ok, stdout: Object.values(doc.services).map((d) => d.image).join('\n') + '\n' };
          return ok;
        }
        case 'pull': {
          let err = ''; let code = 0;
          for (const [n, d] of Object.entries(doc.services)) {
            err += ` ${n} Pulling \n`;
            const fehler = st.pullFehler && st.pullFehler(d.image);
            if (fehler) { err += ` ${n} Error ${fehler}\n`; if (!rest.includes('--ignore-pull-failures')) { code = 1; err += `Error response from daemon: ${fehler}\n`; } continue; }
            err += `  abc123 Pull complete\n ${n} Pulled \n`;
            if (!st.images.has(d.image)) st.images.set(d.image, `sha256:${crypto.createHash('sha256').update(d.image).digest('hex').slice(0, 12)}`);
          }
          return { code, stdout: '', stderr: err };
        }
        case 'up': {
          assert.ok(rest.includes('-d'), 'up immer mit -d');
          let err = '';
          const neu = [];
          for (const [n, d] of Object.entries(doc.services)) {
            if (!st.images.has(d.image)) { if (st.pullFehler && st.pullFehler(d.image)) return { code: 1, stdout: '', stderr: `Error response from daemon: pull access denied for ${d.image}\n` }; st.images.set(d.image, `sha256:${crypto.createHash('sha256').update(d.image).digest('hex').slice(0, 12)}`); }
            const alt = liste.find((c) => c.dienst === n);
            const c = alt || { id: crypto.randomBytes(32).toString('hex'), name: `${projekt}-${n}-1`, dienst: n, projekt };
            c.image = d.image; c.zustand = 'running'; c.ports = portsVon(d); c.exitcode = 0; c.health = d.healthcheck ? 'healthy' : '';
            err += ` Container ${c.name}  ${alt ? 'Recreate' : 'Created'}\n Container ${c.name}  Started\n`;
            neu.push(c);
          }
          st.container.set(projekt, neu);
          return { ...ok, stderr: err };
        }
        case 'down': st.container.delete(projekt); return { ...ok, stderr: ` Network ${projekt}_default  Removed\n` };
        case 'stop': for (const c of liste) { c.zustand = 'exited'; c.exitcode = 137; } return ok;
        case 'start': for (const c of liste) { c.zustand = 'running'; c.exitcode = 0; } return ok;
        case 'restart': for (const c of liste) c.zustand = 'running'; return ok;
        case 'ps': {
          assert.ok(rest.includes('-a') && rest.includes('json'));
          return { ...ok, stdout: liste.map((c) => JSON.stringify({ ID: c.id.slice(0, 12), Name: c.name, Service: c.dienst, State: c.zustand, Health: c.health, ExitCode: c.exitcode, Image: c.image, Status: c.zustand === 'running' ? 'Up 5 seconds' : 'Exited (137) 1 second ago', Publishers: c.zustand === 'running' ? c.ports.flatMap((p) => [{ URL: '0.0.0.0', TargetPort: p.ziel, PublishedPort: p.port, Protocol: p.protokoll }, { URL: '::', TargetPort: p.ziel, PublishedPort: p.port, Protocol: p.protokoll }]) : [] })).join('\n') + '\n' };
        }
        case 'logs': {
          assert.deepEqual(rest.slice(0, 4), ['--no-color', '--timestamps', '--tail', rest[3]]);
          const dienst = rest[4];
          return { ...ok, stdout: st.logs.slice(-Number(rest[3])).map((z) => `${dienst || 'app'}-1  | ${z}`).join('\n') + '\n' };
        }
        default: return { code: 1, stdout: '', stderr: `unbekannt: compose ${sub}` };
      }
    }
    if (prog === 'docker') {
      if (args[0] === 'version') return st.dockerDa ? { ...ok, stdout: '29.1.3\n' } : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      if (args[0] === 'ps') {
        const alle = [...st.container.values()].flat();
        return { ...ok, stdout: alle.map((c) => JSON.stringify({ ID: c.id, Names: c.name, Image: c.image, State: c.zustand, Status: 'Up', Labels: `com.docker.compose.project=${c.projekt},com.docker.compose.service=${c.dienst}`, Ports: c.zustand === 'running' ? c.ports.map((p) => `0.0.0.0:${p.port}->${p.ziel}/${p.protokoll}, [::]:${p.port}->${p.ziel}/${p.protokoll}`).join(', ') : '' })).join('\n') + '\n' };
      }
      if (args[0] === 'stats') {
        const alle = [...st.container.values()].flat().filter((c) => c.zustand === 'running');
        return { ...ok, stdout: alle.map((c) => JSON.stringify({ Container: c.id, ID: c.id.slice(0, 12), Name: c.name, CPUPerc: `${st.statsCpu}%`, MemUsage: '10MiB / 7.246GiB', MemPerc: '0.13%' })).join('\n') + '\n' };
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        const d = digestVon(args[4]);
        if (!d) return { code: 1, stdout: '', stderr: 'No such image' };
        if (args[3] === '{{.Size}}') return { ...ok, stdout: '100000000\n' };
        const label = /index \.Config\.Labels "([^"]+)"/.exec(args[3]);
        if (label) { const l = (st.labels.get(args[4]) || {})[label[1]]; return { ...ok, stdout: `${l === undefined ? '<no value>' : l}\n` }; }
        // lokal gebaute Images haben keinen RepoDigest → nur die Image-ID
        return { ...ok, stdout: st.labels.has(args[4]) ? `[]|${d}\n` : `["${args[4].split(':')[0]}@${d}"]|sha256:id-${d.slice(7)}\n` };
      }
      if (args[0] === 'buildx' && args[1] === 'version') return st.buildx ? { ...ok, stdout: 'github.com/docker/buildx 0.30.1\n' } : { code: 1, stdout: '', stderr: "docker: unknown command: docker buildx" };
      if (args[0] === 'build') {
        if (st.bauFehler) return { code: 1, stdout: '', stderr: st.bauFehler };
        const image = args[args.indexOf('-t') + 1];
        const labels = {}; args.forEach((a, i) => { if (a === '--label') { const [k, ...v] = args[i + 1].split('='); labels[k] = v.join('='); } });
        await fs.access(path.join(args[args.length - 1], 'Dockerfile'));
        st.images.set(image, `sha256:bau${crypto.createHash('sha256').update(image + JSON.stringify(labels) + st.befehle.length).digest('hex').slice(0, 12)}`);
        st.labels.set(image, labels);
        return { ...ok, stderr: '#1 [internal] load build definition\n#5 [1/3] FROM node:24-alpine\n#6 [2/3] RUN npm ci\n#7 [3/3] COPY src/ ./src/\n#8 DONE 0.1s\n' };
      }
      if (args[0] === 'rm') { for (const l of st.container.values()) for (let i = l.length - 1; i >= 0; i--) if (args.includes(l[i].id)) l.splice(i, 1); return ok; }
      if (args[0] === 'image' && args[1] === 'rm') {
        const image = args[2];
        if (!st.images.has(image)) return { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${image}` };
        if ([...st.container.values()].flat().some((c) => c.image === image)) return { code: 1, stdout: '', stderr: `Error response from daemon: conflict: unable to remove repository reference "${image}" - container is using its referenced image` };
        st.images.delete(image); st.labels.delete(image); return { ...ok, stdout: `Untagged: ${image}\n` };
      }
      if (args[0] === 'image' && args[1] === 'prune') return { ...ok, stdout: 'Deleted Images:\ndeleted: sha256:alt\n\nTotal reclaimed space: 1.5MB\n' };
      if (args[0] === 'builder' && args[1] === 'prune') return { ...ok, stdout: 'Total:\t2MB\n' };
      return { code: 1, stdout: '', stderr: `unbekannt: docker ${args.join(' ')}` };
    }
    if (prog === 'ss') return { ...ok, stdout: st.ssPorts.map((p) => { const [adr, proto] = p.split('/'); return `${proto} ${proto === 'udp' ? 'UNCONN' : 'LISTEN'} 0 4096 ${adr.includes(':') ? adr : `0.0.0.0:${adr}`} 0.0.0.0:*`; }).join('\n') + '\n' };
    if (prog === 'ip' && args.join(' ') === '-4 route get 1.1.1.1') return { ...ok, stdout: '1.1.1.1 via 192.168.1.1 dev eno1 src 192.168.1.29 uid 0 \n    cache \n' };
    if (prog === 'nft') return ok;
    if (prog === 'curl') { const url = args[args.length - 1]; const ziel = args[args.indexOf('-o') + 1]; const antwort = st.curl ? await st.curl(url) : null; if (antwort === null || antwort === undefined) return { code: 6, stdout: '', stderr: 'curl: (6) Could not resolve host' }; await fs.writeFile(ziel, antwort); return ok; }
    if (prog === 'du') return { ...ok, stdout: `${st.duGroesse}\t${args[args.length - 1]}\n` };
    if (prog === 'cp') { await fs.cp(args[args.length - 2], args[args.length - 1], { recursive: true }); return ok; }
    if (prog === 'mv') { await fs.rename(args[args.length - 2], args[args.length - 1]); return ok; }
    return ok;
  }
  st.ausfuehren = async (prog, args = [], opt = {}) => {
    st.befehle.push([prog, ...args]);
    const r = await roh(prog, args, opt);
    if (!(opt.erlaubteCodes || [0]).includes(r.code)) throw new FahnasFehler('E_SYSTEM', `Befehl ${prog} schlug fehl`, { befehl: [prog, ...args].join(' '), code: r.code, ausgabe: r.stderr || r.stdout });
    return r;
  };
  st.zeilen = () => st.befehle.map((b) => b.join(' '));
  st.leeren = () => { st.befehle.length = 0; };
  st.compose = (sub) => st.befehle.filter((b) => b[0] === 'docker' && b[1] === 'compose' && b[b.indexOf('--env-file') + 2] === sub).map((b) => b.slice(b.indexOf('--env-file') + 2));
  return st;
}

async function umgebung({ katalog = KATALOG } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-apps-'));
  const pfade = { apps: path.join(w, 'data', 'apps'), shares: path.join(w, 'data', 'shares'), konfig: path.join(w, 'config'), katalog, backup: path.join(w, 'data', 'backup'), nft: path.join(w, 'nft', 'fahnas.nft'), run: path.join(w, 'run') };
  for (const p of Object.values(pfade)) if (p !== katalog) await fs.mkdir(p === pfade.nft ? path.dirname(p) : p, { recursive: true });
  await fs.mkdir(path.join(pfade.shares, 'medien', 'kuma'), { recursive: true });
  const konfig = new Konfig(pfade.konfig); await konfig.sicherstellen();
  const docker = scheinDocker();
  const ereignisse = [];
  const werkzeuge = { konfig, system: { ausfuehren: (...a) => docker.ausfuehren(...a) }, pfade, ereignis: (art, d) => ereignisse.push({ ereignis: art, ...d }), konfigGeaendert: (b) => ereignisse.push({ ereignis: 'konfig', bereich: b }), audit: { eintrag() {} } };
  const reg = new Register(); registriere(reg, werkzeuge);
  const verlauf = [];
  async function auf(name, params, kontext = K.chef) {
    const { aktion, params: p } = reg.vorbereiten(name, params, kontext);
    return aktion.ausfuehren(p, kontext, werkzeuge, { fortschritt: (a, m) => verlauf.push([a, m]), abgebrochen: () => false });
  }
  return { w, pfade, konfig, docker, ereignisse, reg, auf, verlauf, aufraeumen: () => fs.rm(w, { recursive: true, force: true }) };
}

const KUMA = { katalog_id: 'test-uptime-kuma', name: 'kuma', werte: { PORT_WEB: 3010, ADMIN_TOKEN: 'tok-1', PROTOKOLLSTUFE: 'debug' } };

test('Katalog: eingebaute Vorlagen, Suche/Filter, Eintrag, Import (XML) als eigene Vorlage, Löschen, Rollen, Fehler', async () => {
  const u = await umgebung();
  try {
    // Katalog nur für Admins (Plan 07, 0.21.0): Nicht-Admins installieren nichts
    assert.throws(() => u.reg.vorbereiten('apps.katalog.liste', {}, K.anna), (e2) => e2.code === 'E_RECHTE');
    const l = await u.auf('apps.katalog.liste', {}, K.chef);
    assert.equal(l.gesamt, 2); assert.deepEqual(l.eintraege.map((e) => e.id), ['test-nginx', 'test-uptime-kuma']);
    assert.equal(l.eintraege[0].compose, undefined, 'Liste ohne compose'); assert.equal(l.eintraege[1].felder_anzahl, 5); assert.equal(l.eintraege[1].geheimnisse, 1);
    assert.deepEqual(l.kategorien, ['Überwachung', 'Werkzeuge']); assert.deepEqual(l.quellen, { eingebaut: 2, unraid: 0, eigen: 0 }); assert.equal(l.unraid_geladen, null); assert.deepEqual(l.installiert, []);
    assert.equal((await u.auf('apps.katalog.liste', { suche: 'uptime kuma' })).gesamt, 1);
    assert.equal((await u.auf('apps.katalog.liste', { kategorie: 'Werkzeuge' })).eintraege[0].id, 'test-nginx');
    assert.equal((await u.auf('apps.katalog.liste', { suche: 'gibtsnicht' })).gesamt, 0);
    assert.throws(() => u.reg.vorbereiten('apps.katalog.eintrag', { id: 'test-uptime-kuma' }, K.anna), (e2) => e2.code === 'E_RECHTE');
    const e = await u.auf('apps.katalog.eintrag', { id: 'test-uptime-kuma' }, K.chef);
    assert.ok(e.compose.includes('louislam/uptime-kuma:1')); assert.equal(e.felder.length, 5); assert.deepEqual(e.installiert, []);
    await assert.rejects(u.auf('apps.katalog.eintrag', { id: 'nix' }), (e2) => e2.code === 'E_NICHT_GEFUNDEN');
    assert.throws(() => u.reg.vorbereiten('apps.katalog.eintrag', { id: 'Groß Klein' }, K.chef), (e2) => e2.code === 'E_PARAMS');
    // Import
    const xml = await fs.readFile(path.join(UNRAID, 'selfhosters-dozzle.xml'), 'utf8');
    assert.throws(() => u.reg.vorbereiten('apps.katalog.importieren', { xml }, K.anna), (e2) => e2.code === 'E_RECHTE');
    const imp = await u.auf('apps.katalog.importieren', { xml });
    assert.equal(imp.id, 'eigen-dozzle'); assert.equal(imp.quelle, 'eigen'); assert.equal(imp.felder.length, 8);
    assert.ok(await fs.stat(path.join(u.pfade.apps, '_katalog', 'eigen', 'eigen-dozzle.json')));
    const l2 = await u.auf('apps.katalog.liste', { quelle: 'eigen' });
    assert.deepEqual(l2.eintraege.map((x) => x.id), ['eigen-dozzle']); assert.equal(l2.quellen.eigen, 1);
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'konfig' && x.bereich === 'apps'));
    await assert.rejects(u.auf('apps.katalog.importieren', {}), (e2) => e2.code === 'E_PARAMS');
    await assert.rejects(u.auf('apps.katalog.importieren', { xml, url: 'https://x/y.xml' }), (e2) => e2.code === 'E_PARAMS');
    await assert.rejects(u.auf('apps.katalog.importieren', { xml: '<Plugin/>' }), (e2) => e2.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('apps.katalog.importieren', { url: 'http://unsicher/x.xml' }, K.chef), (e2) => e2.code === 'E_PARAMS');
    // Import per URL (curl nachgespielt)
    u.docker.curl = (url) => (url.endsWith('nginx.xml') ? fs.readFile(path.join(UNRAID, 'linuxserver-nginx.xml'), 'utf8') : null);
    const imp2 = await u.auf('apps.katalog.importieren', { url: 'https://example.org/nginx.xml' });
    assert.equal(imp2.id, 'eigen-nginx'); assert.equal(imp2.herkunft.vorlage_url, 'https://example.org/nginx.xml');
    await assert.rejects(u.auf('apps.katalog.importieren', { url: 'https://example.org/fehlt.xml' }), (e2) => e2.code === 'E_SYSTEM');
    assert.deepEqual(await u.auf('apps.katalog.loeschen', { id: 'eigen-nginx' }), { id: 'eigen-nginx', geloescht: true });
    await assert.rejects(u.auf('apps.katalog.loeschen', { id: 'test-nginx' }), (e2) => e2.code === 'E_NICHT_GEFUNDEN', 'eingebaute Vorlagen sind nicht löschbar');
    assert.equal((await u.auf('apps.katalog.liste', {})).gesamt, 3);
  } finally { await u.aufraeumen(); }
});

test('Katalog: Unraid-Feed laden (curl → übersetzen → Zwischenspeicher), Liste zeigt Unraid-Vorlagen, Fehler ohne Netz', async () => {
  const u = await umgebung();
  try {
    u.docker.curl = (url) => (url.includes('applicationFeed') ? fs.readFile(path.join(UNRAID, 'feed-ausschnitt.json'), 'utf8') : null);
    const r = await u.auf('apps.katalog.unraid_laden', {});
    assert.equal(r.anzahl, 6); assert.equal(r.feed_stand, '2026-09-25 08:10'); assert.equal(r.uebersprungen.plugin, 1); assert.ok(r.zeit);
    const c = u.docker.befehle.find((b) => b[0] === 'curl');
    assert.deepEqual(c.slice(0, 7), ['curl', '-fsSL', '--max-time', '300', '--retry', '2', '-A']); assert.equal(c.at(-1), 'https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json');
    const datei = JSON.parse(await fs.readFile(path.join(u.pfade.apps, '_katalog', 'unraid-feed.json'), 'utf8'));
    assert.equal(datei.anzahl, 6); assert.equal(datei.eintraege[0].id, 'unraid-dozzle');
    assert.ok(!(await fs.readdir(path.join(u.pfade.apps, '_katalog'))).some((n) => n.includes('.roh.')), 'Rohdatei weggeräumt');
    const l = await u.auf('apps.katalog.liste', { quelle: 'unraid' }, K.chef);
    assert.equal(l.gesamt, 6); assert.equal(l.unraid_anzahl, 6); assert.ok(l.unraid_geladen);
    assert.equal((await u.auf('apps.katalog.liste', {})).gesamt, 8);
    assert.equal((await u.auf('apps.katalog.liste', { suche: 'docker log' })).eintraege[0].id, 'unraid-dozzle');
    assert.equal((await u.auf('apps.katalog.eintrag', { id: 'unraid-vaultwarden' })).felder.length, 6);
    assert.ok(u.verlauf.some(([a, m]) => a === 0.6 && /übersetzt/.test(m)));
    u.docker.curl = () => null;
    await assert.rejects(u.auf('apps.katalog.unraid_laden', {}), (e) => e.code === 'E_SYSTEM' && /Internetverbindung/.test(e.message));
    u.docker.curl = () => '{"kaputt":1}';
    await assert.rejects(u.auf('apps.katalog.unraid_laden', {}), (e) => e.code === 'E_SYSTEM' && /nicht lesbar/.test(e.message));
    assert.equal((await u.auf('apps.katalog.liste', { quelle: 'unraid' })).gesamt, 6, 'alter Zwischenspeicher bleibt');
  } finally { await u.aufraeumen(); }
});

test('pruefen: Vorschau maskiert, Port-Konflikte (ss, Container, andere Apps), Risiken, name_frei; Installieren mit Konflikt/Risiko lehnt ab, ohne Spuren', async () => {
  const u = await umgebung();
  try {
    u.docker.ssPorts.push('3010/tcp');
    const v = await u.auf('apps.pruefen', KUMA);
    assert.ok(v.compose.includes('"3010:3001"') && v.compose.includes('ADMIN_TOKEN=********'));
    assert.deepEqual(v.port_konflikte, [{ feld: 'PORT_WEB', port: 3010, protokoll: 'tcp', belegt_von: 'Dienst auf dem NAS', app: null, vorschlag: 3011 }]);
    u.docker.ssPorts.push('3011/tcp');
    assert.equal((await u.auf('apps.pruefen', KUMA)).port_konflikte[0].vorschlag, 3012, 'Vorschlag = nächster freier Port');
    assert.deepEqual(v.riskant, []); assert.equal(v.name_frei, true); assert.equal(v.webui, 'http://{HOST}:3010'); assert.equal(v.felder.length, 5);
    await assert.rejects(u.auf('apps.installieren', KUMA), (e) => e.code === 'E_BELEGT' && e.details.feld === 'PORT_WEB' && e.details.port_konflikte.length === 1);
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'kuma')), 'nichts angelegt');
    assert.ok(!u.docker.zeilen().some((z) => /compose/.test(z)), 'kein docker compose bei Konflikt');
    // Risiko ohne Bestätigung
    const xml = await fs.readFile(path.join(UNRAID, 'selfhosters-dozzle.xml'), 'utf8');
    await u.auf('apps.katalog.importieren', { xml });
    const vd = await u.auf('apps.pruefen', { katalog_id: 'eigen-dozzle', name: 'dozzle', werte: {} });
    assert.deepEqual(vd.riskant.map((r) => r.art), ['docker_sock']); assert.deepEqual(vd.port_konflikte, []);
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'eigen-dozzle', name: 'dozzle', werte: {} }), (e) => e.code === 'E_RECHTE' && e.details.feld === 'bestaetigt_riskant' && e.details.noetig.includes('docker_sock'));
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'dozzle')));
    // Schema
    for (const p of [{ ...KUMA, name: 'Kuma' }, { ...KUMA, name: 'k' }, { ...KUMA, name: '_katalog' }, { ...KUMA, werte: [] }, { ...KUMA, bestaetigt_riskant: ['Privileged!'] }]) assert.throws(() => u.reg.vorbereiten('apps.installieren', p, K.chef), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('apps.installieren', KUMA, K.anna), (e) => e.code === 'E_RECHTE');
    assert.throws(() => u.reg.vorbereiten('apps.pruefen', KUMA, K.anna), (e) => e.code === 'E_RECHTE');
  } finally { await u.aufraeumen(); }
});

test('installieren: Dateien (compose mit Platzhaltern, .env 0600, daten/), Befehlsfolge, Spiegel, Firewall-Port, Ereignis, Zustand; doppelter Name', async () => {
  const u = await umgebung();
  try {
    const r = await u.auf('apps.installieren', KUMA);
    assert.equal(r.name, 'kuma'); assert.equal(r.zustand, 'running'); assert.equal(r.webui, 'http://{HOST}:3010'); assert.deepEqual(r.ports, [{ port: 3010, protokoll: 'tcp', dienst: 'app', ziel: 3001, feld: 'PORT_WEB' }]); assert.deepEqual(r.warnungen, []); assert.deepEqual(r.risiken, []);
    const ordner = path.join(u.pfade.apps, 'kuma');
    const compose = await fs.readFile(path.join(ordner, 'compose.yml'), 'utf8');
    assert.ok(compose.includes('"${PORT_WEB}:3001"') && !compose.includes('3010'), 'keine Werte im YAML');
    const env = await fs.readFile(path.join(ordner, '.env'), 'utf8');
    assert.ok(env.includes("PORT_WEB='3010'") && env.includes("ADMIN_TOKEN='tok-1'") && env.includes(`PFAD_DATEN='${path.join(ordner, 'daten')}'`) && env.includes("PROTOKOLLSTUFE='debug'") && env.includes("RAHMEN_ERLAUBEN='0'"));
    assert.equal((await fs.stat(path.join(ordner, '.env'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(ordner, 'compose.yml'))).mode & 0o777, 0o640);
    assert.ok((await fs.stat(path.join(ordner, 'daten'))).isDirectory());
    const spiegel = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8'));
    assert.equal(spiegel.katalog_id, 'test-uptime-kuma'); assert.equal(spiegel.autostart, true); assert.deepEqual(spiegel.geheimnisse, ['ADMIN_TOKEN']);
    assert.equal(spiegel.werte.ADMIN_TOKEN, undefined, 'Geheimnis nicht im Spiegel'); assert.equal(spiegel.eingabe.ADMIN_TOKEN, undefined); assert.equal(spiegel.eingabe.PORT_WEB, 3010);
    assert.deepEqual(spiegel.version.images, { 'louislam/uptime-kuma:1': 'sha256:' + crypto.createHash('sha256').update('louislam/uptime-kuma:1').digest('hex').slice(0, 12) });
    assert.equal(spiegel.vorlage.compose, compose, 'Vorlage steckt im Spiegel (apply braucht keinen Katalog)');
    assert.ok(JSON.parse(await fs.readFile(path.join(ordner, 'app.json'), 'utf8')).name === 'kuma', 'Kopie im App-Ordner');
    // Befehlsfolge
    const c = u.docker.compose;
    assert.deepEqual(c('config').map((x) => x.join(' ')), ['config -q']);
    assert.deepEqual(c('pull').map((x) => x.join(' ')), ['pull --ignore-pull-failures']);
    assert.deepEqual(c('up').map((x) => x.join(' ')), ['up -d --remove-orphans']);
    assert.equal(c('ps').length, 1);
    assert.ok(u.docker.befehle.every((b) => !(b[0] === 'docker' && b[1] === 'compose') || b.includes('fahnas-kuma')), 'Projektname fahnas-<name>');
    assert.ok(u.docker.zeilen().some((z) => z.startsWith(`docker image inspect --format {{json .RepoDigests}}|{{.Id}} louislam/uptime-kuma:1`)));
    const nft = u.docker.zeilen().filter((z) => z.startsWith('nft '));
    assert.deepEqual(nft, [`nft -c -f ${u.pfade.nft}.neu`, `nft -f ${u.pfade.nft}`]);
    assert.ok((await fs.readFile(u.pfade.nft, 'utf8')).includes('tcp dport 3010 accept comment "App kuma"'));
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'konfig' && x.bereich === 'apps'));
    assert.ok(u.verlauf.some(([, m]) => /Images werden geladen/.test(m || '')) && u.verlauf.at(-1)[0] === 1);
    // doppelt
    await assert.rejects(u.auf('apps.installieren', KUMA), (e) => e.code === 'E_EXISTIERT');
    await fs.mkdir(path.join(u.pfade.apps, 'fremd'));
    await assert.rejects(u.auf('apps.installieren', { ...KUMA, name: 'fremd' }), (e) => e.code === 'E_EXISTIERT' && /Ordner/.test(e.message));
    // zweite App mit gleichem Port → Konflikt gegen die erste App (auch wenn deren Container läuft)
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'test-nginx', name: 'web', werte: { PORT_WEB: 3010 } }), (e) => e.code === 'E_BELEGT' && /App kuma/.test(e.message) && e.details.port_konflikte[0].app === 'kuma' && e.details.port_konflikte[0].vorschlag === 3011);
    // Katalog zeigt die Installation
    assert.deepEqual((await u.auf('apps.katalog.eintrag', { id: 'test-uptime-kuma' })).installiert, ['kuma']);
    assert.deepEqual((await u.auf('apps.katalog.liste', {})).installiert, [{ name: 'kuma', katalog_id: 'test-uptime-kuma' }]);
  } finally { await u.aufraeumen(); }
});

test('installieren: Fehler beim Start → Container weg, Ordner weg, kein Spiegel; Image-Fehler beim pull nur Warnung; riskant mit Bestätigung; Freigabe-Pfad muss existieren', async () => {
  const u = await umgebung();
  try {
    u.docker.kaputt = (p, a) => (p === 'docker' && a[0] === 'compose' && a.includes('up') ? { code: 1, stderr: 'Error response from daemon: port is already allocated' } : null);
    await assert.rejects(u.auf('apps.installieren', KUMA), (e) => e.code === 'E_SYSTEM' && /nicht gestartet werden/.test(e.message) && /already allocated/.test(e.details.ausgabe));
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'kuma')), 'Ordner weggeräumt');
    await assert.rejects(fs.stat(path.join(u.pfade.konfig, 'apps', 'kuma')), 'kein Spiegel');
    assert.equal(u.docker.compose('down').length, 1, 'down zum Aufräumen');
    assert.deepEqual(await u.auf('apps.liste', {}, K.anna), []);
    u.docker.kaputt = null; u.docker.leeren();
    // pull scheitert (lokal gebautes Image o. Ä.) → Warnung, up entscheidet
    u.docker.pullFehler = (image) => (image.includes('uptime') ? 'Get "https://registry-1.docker.io/v2/": dial tcp: lookup failed' : null);
    u.docker.images.set('louislam/uptime-kuma:1', 'sha256:lokal000000');
    const r = await u.auf('apps.installieren', KUMA);
    assert.equal(r.zustand, 'running'); assert.equal(r.warnungen.length, 1); assert.match(r.warnungen[0], /Image nicht geladen: app: Get/);
    u.docker.pullFehler = null;
    // riskant mit Bestätigung
    const xml = await fs.readFile(path.join(UNRAID, 'selfhosters-dozzle.xml'), 'utf8');
    await u.auf('apps.katalog.importieren', { xml });
    const d = await u.auf('apps.installieren', { katalog_id: 'eigen-dozzle', name: 'dozzle', werte: { PORT_8080: 8085 }, bestaetigt_riskant: ['docker_sock'] });
    assert.deepEqual(d.risiken, ['docker_sock']); assert.equal(d.zustand, 'running');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'dozzle', 'app.json'), 'utf8')).bestaetigt_riskant, ['docker_sock']);
    // Pfad in einer Freigabe: vorhanden ok, fehlend E_NICHT_GEFUNDEN
    const n = await u.auf('apps.installieren', { katalog_id: 'test-nginx', name: 'web', werte: { PORT_WEB: 8090, PFAD_HTML: path.join(u.pfade.shares, 'medien', 'kuma') } });
    assert.equal(n.zustand, 'running');
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'test-nginx', name: 'web2', werte: { PORT_WEB: 8091, PFAD_HTML: path.join(u.pfade.shares, 'medien', 'fehlt') } }), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.feld === 'PFAD_HTML');
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'web2')));
    assert.equal((await u.auf('apps.liste', {})).length, 3);
    const nft = await fs.readFile(u.pfade.nft, 'utf8');
    assert.ok(nft.includes('tcp dport 3010 accept comment "App kuma"') && nft.includes('tcp dport 8085 accept comment "App dozzle"') && nft.includes('tcp dport 8090 accept comment "App web"'));
    assert.deepEqual((await u.auf('apps.ports', {}, K.system)).map((p) => `${p.port}/${p.protokoll}:${p.app}`), ['8085/tcp:dozzle', '3010/tcp:kuma', '8090/tcp:web']);
    assert.throws(() => u.reg.vorbereiten('apps.ports', {}, K.chef), (e) => e.code === 'E_RECHTE', 'apps.ports nur system');
  } finally { await u.aufraeumen(); }
});

test('liste/details/steuern/protokoll: Zustand aus docker ps, CPU/RAM aus stats (10 s Zwischenspeicher), Geheimnisse nur als Namen, stopp/start, Protokollzeilen', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    u.docker.leeren();
    const l = await u.auf('apps.liste', {}, K.chef);
    assert.equal(l.length, 1);
    const a = l[0];
    assert.equal(a.name, 'kuma'); assert.equal(a.titel, 'Uptime Kuma (Test)'); assert.equal(a.zustand, 'running'); assert.equal(a.gesundheit, null); assert.equal(a.webui, 'http://{HOST}:3010');
    assert.equal(a.cpu_prozent, 1.5); assert.equal(a.ram_bytes, 10 * 1024 * 1024); assert.equal(a.autostart, true); assert.equal(a.container, 1); assert.equal(a.quelle, 'eingebaut');
    assert.deepEqual(u.docker.zeilen(), ['docker ps -a --no-trunc --format json', 'docker stats --no-stream --format json']);
    u.docker.leeren();
    await u.auf('apps.liste', {}, K.chef);
    assert.deepEqual(u.docker.zeilen(), [], 'Zwischenspeicher: kein zweiter docker-Aufruf innerhalb von 10 s');
    // Plan 07: Nicht-Admins sehen die App erst, wenn ein Admin sie freigibt – dann ohne Admin-Felder
    await u.konfig.speichern('users.json', { nutzer: [{ name: 'anna', rolle: 'nutzer', gruppen: [] }], gruppen: [] });
    assert.deepEqual(await u.auf('apps.liste', {}, K.anna), []);
    await u.auf('apps.sichtbarkeit', { name: 'kuma', sichtbar_fuer: ['anna'] });
    const fuerAnna = await u.auf('apps.liste', {}, K.anna);
    assert.equal(fuerAnna.length, 1); assert.equal(fuerAnna[0].quelle, undefined); assert.equal(fuerAnna[0].sichtbar_fuer, undefined);
    // Details
    assert.throws(() => u.reg.vorbereiten('apps.details', { name: 'kuma' }, K.anna), (e) => e.code === 'E_RECHTE');
    const d = await u.auf('apps.details', { name: 'kuma' }, K.chef);
    assert.equal(d.werte.PORT_WEB, 3010); assert.equal(d.werte.ADMIN_TOKEN, undefined); assert.deepEqual(d.geheimnisse, ['ADMIN_TOKEN']);
    assert.equal(d.container.length, 1); assert.equal(d.container[0].dienst, 'app'); assert.equal(d.container[0].zustand, 'running'); assert.deepEqual(d.container[0].ports, [{ port: 3010, protokoll: 'tcp', ziel: 3001 }]);
    assert.ok(d.compose.includes('${PORT_WEB}')); assert.equal(d.felder.length, 5); assert.equal(d.zustand, 'running');
    assert.ok(!JSON.stringify(d).includes('tok-1'), 'Geheimnis nirgends in den Details');
    await assert.rejects(u.auf('apps.details', { name: 'nix' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    // Steuern
    assert.throws(() => u.reg.vorbereiten('apps.steuern', { name: 'kuma', aktion: 'stopp' }, K.anna), (e) => e.code === 'E_RECHTE');
    u.docker.leeren();
    const s = await u.auf('apps.steuern', { name: 'kuma', aktion: 'stopp' });
    assert.equal(s.zustand, 'exited'); assert.deepEqual(u.docker.compose('stop').map((x) => x.join(' ')), ['stop']);
    assert.equal((await u.auf('apps.liste', {}))[0].zustand, 'exited', 'Zwischenspeicher wird nach Steuern geleert');
    assert.equal((await u.auf('apps.liste', {}))[0].cpu_prozent, null);
    const s2 = await u.auf('apps.steuern', { name: 'kuma', aktion: 'start' });
    assert.equal(s2.zustand, 'running'); assert.equal(u.docker.compose('up').length, 1, 'start = up -d (legt fehlende Container an)');
    assert.equal((await u.auf('apps.steuern', { name: 'kuma', aktion: 'neustart' })).zustand, 'running');
    assert.equal(u.docker.compose('restart').length, 1);
    // Protokoll
    u.docker.leeren();
    assert.throws(() => u.reg.vorbereiten('apps.protokoll', { name: 'kuma', zeilen: 1 }, K.anna), (e) => e.code === 'E_RECHTE');
    const p = await u.auf('apps.protokoll', { name: 'kuma', zeilen: 1 }, K.chef);
    assert.deepEqual(p.zeilen, ['app-1  | 2026-09-25T12:00:01Z welt']); assert.deepEqual(p.dienste, ['app']); assert.equal(p.dienst, null);
    assert.deepEqual(u.docker.compose('logs').map((x) => x.join(' ')), ['logs --no-color --timestamps --tail 1']);
    assert.equal((await u.auf('apps.protokoll', { name: 'kuma', dienst: 'app' })).zeilen.length, 2);
    await assert.rejects(u.auf('apps.protokoll', { name: 'kuma', dienst: 'db' }), (e) => e.code === 'E_NICHT_GEFUNDEN' && e.details.feld === 'dienst');
    assert.throws(() => u.reg.vorbereiten('apps.protokoll', { name: 'kuma', zeilen: 0 }, K.chef), (e) => e.code === 'E_PARAMS');
    // Docker weg → Liste mit unbekannt, kein Fehler
    u.docker.kaputt = (prog) => (prog === 'docker' ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : null);
    u.docker.leeren();
    // der letzte erfolgreiche Steuerbefehl hat den Zwischenspeicher geleert; jetzt scheitert docker → Liste meldet „unbekannt“, kein Fehler
    await assert.rejects(u.auf('apps.steuern', { name: 'kuma', aktion: 'stopp' }), (e) => e.code === 'E_SYSTEM');
    const l3 = await u.auf('apps.liste', {});
    assert.equal(l3[0].zustand, 'unbekannt'); assert.equal(l3[0].cpu_prozent, null);
  } finally { await u.aufraeumen(); }
});

test('pruefen im Einstellungsdialog: eigene Ports der installierten App sind kein Konflikt (docker-proxy lauscht als „Dienst auf dem NAS“), fremde schon', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    u.docker.ssPorts.push('3010/tcp', '3012/tcp'); // 3010 = eigener Port (docker-proxy), 3012 = fremder Dienst
    assert.deepEqual((await u.auf('apps.pruefen', KUMA)).port_konflikte, []);
    const v = await u.auf('apps.pruefen', { ...KUMA, werte: { ...KUMA.werte, PORT_WEB: 3012 } });
    assert.deepEqual(v.port_konflikte.map((x) => `${x.port}/${x.belegt_von}`), ['3012/Dienst auf dem NAS']);
    // neue App unter anderem Namen: der Port der installierten App bleibt belegt
    const n = await u.auf('apps.pruefen', { ...KUMA, name: 'kuma2' });
    assert.deepEqual(n.port_konflikte.map((x) => `${x.port}/${x.belegt_von}`), ['3010/App kuma']);
  } finally { await u.aufraeumen(); }
});

test('aendern: neue Werte → .env neu, Container erneuert, Firewall folgt, Geheimnis bleibt aus .env; nur Autostart; Fehler → alte Dateien zurück', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    u.docker.leeren(); u.verlauf.length = 0;
    const r = await u.auf('apps.aendern', { name: 'kuma', werte: { PORT_WEB: 3011, PROTOKOLLSTUFE: 'warn' } });
    assert.equal(r.neu_gestartet, true); assert.equal(r.zustand, 'running'); assert.equal(r.webui, 'http://{HOST}:3011'); assert.equal(r.autostart, true);
    const env = await fs.readFile(path.join(u.pfade.apps, 'kuma', '.env'), 'utf8');
    assert.ok(env.includes("PORT_WEB='3011'") && env.includes("PROTOKOLLSTUFE='warn'") && env.includes("ADMIN_TOKEN='tok-1'"), 'Geheimnis aus der alten .env übernommen');
    assert.deepEqual(u.docker.compose('up').map((x) => x.join(' ')), ['up -d --remove-orphans']);
    const nft = await fs.readFile(u.pfade.nft, 'utf8');
    assert.ok(nft.includes('tcp dport 3011') && !nft.includes('dport 3010'));
    const spiegel = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8'));
    assert.equal(spiegel.eingabe.PORT_WEB, 3011); assert.equal(spiegel.eingabe.PROTOKOLLSTUFE, 'warn'); assert.equal(spiegel.eingabe.ADMIN_TOKEN, undefined); assert.equal(spiegel.ports[0].port, 3011);
    // Geheimnis ändern
    await u.auf('apps.aendern', { name: 'kuma', werte: { ADMIN_TOKEN: 'tok-2' } });
    assert.ok((await fs.readFile(path.join(u.pfade.apps, 'kuma', '.env'), 'utf8')).includes("ADMIN_TOKEN='tok-2'"));
    // eigener Port ist kein Konflikt, fremder schon
    u.docker.ssPorts.push('3011/tcp', '3012/tcp');
    await u.auf('apps.aendern', { name: 'kuma', werte: { PORT_WEB: 3011 } });
    await assert.rejects(u.auf('apps.aendern', { name: 'kuma', werte: { PORT_WEB: 3012 } }), (e) => e.code === 'E_BELEGT');
    // nur Autostart
    u.docker.leeren();
    const a = await u.auf('apps.aendern', { name: 'kuma', autostart: false });
    assert.equal(a.autostart, false); assert.equal(a.neu_gestartet, false); assert.equal(u.docker.compose('up').length, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8')).autostart, false);
    await assert.rejects(u.auf('apps.aendern', { name: 'kuma' }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.auf('apps.aendern', { name: 'kuma', werte: { PORT_WEB: 99999 } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'PORT_WEB');
    // up scheitert → alte Dateien zurück, alte Container wieder hoch
    u.docker.kaputt = (p, a2) => (p === 'docker' && a2.includes('up') && u.docker.compose('up').length === 1 ? { code: 1, stderr: 'kaputt' } : null);
    u.docker.leeren();
    await assert.rejects(u.auf('apps.aendern', { name: 'kuma', werte: { PORT_WEB: 3013 } }), (e) => e.code === 'E_SYSTEM');
    assert.ok((await fs.readFile(path.join(u.pfade.apps, 'kuma', '.env'), 'utf8')).includes("PORT_WEB='3011'"), 'alte .env zurück');
    assert.equal(u.docker.compose('up').length, 2, 'zweites up mit dem alten Stand');
    assert.equal(JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8')).ports[0].port, 3011);
  } finally { await u.aufraeumen(); }
});

test('aktualisieren: Digest-Vergleich (unverändert → kein up), geändert → Sicherung per cp --reflink + up, Grenze 5 GiB, höchstens 2 Sicherungen', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    await fs.writeFile(path.join(u.pfade.apps, 'kuma', 'daten', 'kuma.db'), 'daten');
    u.docker.leeren();
    const r1 = await u.auf('apps.aktualisieren', { name: 'kuma' });
    assert.equal(r1.neustart, false); assert.deepEqual(r1.geaendert, []); assert.ok(r1.warnungen.some((w) => /keine neueren Images/.test(w)));
    assert.deepEqual(u.docker.compose('pull').map((x) => x.join(' ')), ['pull'], 'ohne --ignore-pull-failures');
    assert.equal(u.docker.compose('up').length, 0);
    assert.ok(r1.sicherung && r1.sicherung.startsWith(path.join(u.pfade.apps, 'kuma', 'daten.vor-update-')));
    assert.ok(u.docker.zeilen().some((z) => z.startsWith(`cp --reflink=auto -a -- ${path.join(u.pfade.apps, 'kuma', 'daten')} `)));
    assert.ok(u.docker.zeilen().some((z) => z === `du -s -B1 -- ${path.join(u.pfade.apps, 'kuma', 'daten')}`));
    assert.equal(await fs.readFile(path.join(r1.sicherung, 'kuma.db'), 'utf8'), 'daten');
    // neues Image → up, Version im Spiegel
    u.docker.leeren();
    const digestNeu = () => { u.docker.images.set('louislam/uptime-kuma:1', 'sha256:neu' + Date.now()); };
    u.docker.pullFehler = null;
    const altPull = u.docker.ausfuehren;
    u.docker.ausfuehren = async (p, a, o) => { const r = await altPull(p, a, o); if (p === 'docker' && a.includes('pull')) digestNeu(); return r; };
    const alt = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8')).version.images['louislam/uptime-kuma:1'];
    const r2 = await u.auf('apps.aktualisieren', { name: 'kuma' });
    assert.equal(r2.neustart, true); assert.deepEqual(r2.geaendert, ['louislam/uptime-kuma:1']); assert.equal(r2.alt['louislam/uptime-kuma:1'], alt); assert.notEqual(r2.neu['louislam/uptime-kuma:1'], alt);
    assert.match(r2.hinweis, /Rückweg/);
    assert.equal(u.docker.compose('up').length, 1);
    const spiegel = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8'));
    assert.equal(spiegel.version.images['louislam/uptime-kuma:1'], r2.neu['louislam/uptime-kuma:1']); assert.equal(spiegel.sicherungen.length, 2);
    // dritte Sicherung → älteste weg
    await new Promise((r) => setTimeout(r, 1100));
    const r3 = await u.auf('apps.aktualisieren', { name: 'kuma' });
    const s3 = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'kuma', 'app.json'), 'utf8')).sicherungen;
    assert.equal(s3.length, 2); assert.equal(s3[1].ordner, r3.sicherung);
    await assert.rejects(fs.stat(r1.sicherung), 'älteste Sicherung gelöscht');
    // zu groß → keine Sicherung, Hinweis
    u.docker.duGroesse = 6 * 1024 ** 3; u.docker.leeren();
    const r4 = await u.auf('apps.aktualisieren', { name: 'kuma' });
    assert.equal(r4.sicherung, null); assert.ok(r4.warnungen.some((w) => /Grenze 5 GiB/.test(w))); assert.ok(!u.docker.zeilen().some((z) => z.startsWith('cp ')));
    // pull scheitert → E_SYSTEM
    u.docker.pullFehler = () => 'manifest unknown';
    await assert.rejects(u.auf('apps.aktualisieren', { name: 'kuma' }), (e) => e.code === 'E_SYSTEM' && /Herunterladen/.test(e.message));
  } finally { await u.aufraeumen(); }
});

test('loeschen: behalten → Ordner nach backup/apps-geloescht, Spiegel weg, Firewall ohne Port; loeschen → Ordner weg, down --volumes bei benannten Volumes', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    await u.auf('apps.installieren', { katalog_id: 'test-nginx', name: 'web', werte: { PORT_WEB: 8090 } });
    u.docker.leeren();
    const r = await u.auf('apps.loeschen', { name: 'kuma', daten: 'behalten' });
    assert.equal(r.daten, 'behalten'); assert.ok(r.aufbewahrt.startsWith(path.join(u.pfade.backup, 'apps-geloescht', 'kuma-')));
    assert.ok((await fs.stat(path.join(r.aufbewahrt, '.env'))).isFile());
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'kuma')));
    await assert.rejects(fs.stat(path.join(u.pfade.konfig, 'apps', 'kuma')));
    assert.deepEqual(u.docker.compose('down').map((x) => x.join(' ')), ['down --remove-orphans']);
    assert.ok(u.docker.zeilen().some((z) => z.startsWith('mv -- ')));
    const nft = await fs.readFile(u.pfade.nft, 'utf8');
    assert.ok(!nft.includes('dport 3010') && nft.includes('tcp dport 8090 accept comment "App web"'));
    assert.deepEqual((await u.auf('apps.liste', {})).map((a) => a.name), ['web']);
    await assert.rejects(u.auf('apps.loeschen', { name: 'kuma', daten: 'behalten' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    // loeschen mit benannten Volumes → --volumes
    await fs.mkdir(path.join(u.pfade.apps, '_katalog', 'eigen'), { recursive: true });
    await fs.writeFile(path.join(u.pfade.apps, '_katalog', 'eigen', 'eigen-db.json'), JSON.stringify({ id: 'eigen-db', name: 'DB', compose: 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    restart: always\nvolumes:\n  dbdata: {}\n', felder: [] }));
    await u.auf('apps.installieren', { katalog_id: 'eigen-db', name: 'db', werte: {} });
    u.docker.leeren();
    const r2 = await u.auf('apps.loeschen', { name: 'db', daten: 'loeschen' });
    assert.equal(r2.aufbewahrt, null);
    assert.deepEqual(u.docker.compose('down').map((x) => x.join(' ')), ['down --remove-orphans --volumes']);
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'db')));
    // Compose-Datei fehlt → Container direkt entfernen
    await fs.unlink(path.join(u.pfade.apps, 'web', 'compose.yml'));
    u.docker.leeren();
    await u.auf('apps.loeschen', { name: 'web', daten: 'loeschen' });
    assert.equal(u.docker.compose('down').length, 0); assert.ok(u.docker.zeilen().some((z) => z.startsWith('docker rm -f ')));
    assert.deepEqual(await u.auf('apps.liste', {}), []);
    assert.ok(!(await fs.readFile(u.pfade.nft, 'utf8')).includes('App '));
  } finally { await u.aufraeumen(); }
});

test('apply: fehlende compose.yml/.env aus dem Spiegel neu gerendert (Geheimnis fehlt → Warnung), Autostart startet, ohne Docker nur Warnung; Sperre E_BELEGT', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    await u.auf('apps.installieren', { katalog_id: 'test-nginx', name: 'web', werte: { PORT_WEB: 8090 }, autostart: false });
    await fs.rm(path.join(u.pfade.apps, 'kuma'), { recursive: true }); // wie nach einer Neuinstallation ohne @apps
    u.docker.leeren();
    const r = await u.auf('apps.apply', {}, K.system);
    assert.equal(r.apps, 2); assert.deepEqual(r.gerendert, ['kuma']); assert.deepEqual(r.gestartet, ['kuma']); assert.deepEqual(r.fehler, []);
    assert.equal(r.warnungen.length, 0, 'optionales Geheimnis fehlt still (leer)');
    const env = await fs.readFile(path.join(u.pfade.apps, 'kuma', '.env'), 'utf8');
    assert.ok(env.includes("PORT_WEB='3010'") && env.includes("ADMIN_TOKEN=''"));
    assert.ok((await fs.readFile(path.join(u.pfade.apps, 'kuma', 'compose.yml'), 'utf8')).includes('uptime-kuma'));
    assert.deepEqual(u.docker.compose('up').length, 1, 'nur die App mit Autostart');
    assert.equal(u.docker.zeilen()[0], 'docker version --format {{.Server.Version}}');
    // Pflicht-Geheimnis verloren → Platzhalter + Warnung
    await fs.mkdir(path.join(u.pfade.apps, '_katalog', 'eigen'), { recursive: true });
    await fs.writeFile(path.join(u.pfade.apps, '_katalog', 'eigen', 'eigen-geheim.json'), JSON.stringify({ id: 'eigen-geheim', name: 'G', compose: 'services:\n  a:\n    image: x:1\n    environment:\n      - "PW=${PW}"\n    restart: always\n', felder: [{ name: 'PW', art: 'geheimnis', pflicht: true }] }));
    await u.auf('apps.installieren', { katalog_id: 'eigen-geheim', name: 'geheim', werte: { PW: 'sehr' } });
    await fs.unlink(path.join(u.pfade.apps, 'geheim', '.env'));
    const r2 = await u.auf('apps.apply', {}, K.system);
    assert.deepEqual(r2.gerendert, ['geheim']); assert.ok(r2.warnungen.some((x) => /Geheimnis PW fehlt/.test(x)));
    assert.ok((await fs.readFile(path.join(u.pfade.apps, 'geheim', '.env'), 'utf8')).includes("PW='BITTE-NEU-SETZEN'"));
    // ohne Docker
    u.docker.dockerDa = false; u.docker.leeren();
    const r3 = await u.auf('apps.apply', {}, K.system);
    assert.deepEqual(r3.gestartet, []); assert.ok(r3.warnungen.some((x) => /Docker ist nicht erreichbar/.test(x))); assert.equal(u.docker.compose('up').length, 0);
    assert.throws(() => u.reg.vorbereiten('apps.apply', {}, K.chef), (e) => e.code === 'E_RECHTE');
    // Sperre: zwei Vorgänge an derselben App
    u.docker.dockerDa = true;
    const eins = u.auf('apps.aktualisieren', { name: 'kuma' });
    await assert.rejects(u.auf('apps.steuern', { name: 'kuma', aktion: 'stopp' }), (e) => e.code === 'E_BELEGT');
    await eins;
  } finally { await u.aufraeumen(); }
});

test('installieren: Vorlage mit verfuegbar:false (nur lokal baubar) → ohne Image E_NICHT_GEFUNDEN, mit Image ohne pull', async () => {
  const u = await umgebung();
  try {
    await fs.mkdir(path.join(u.pfade.apps, '_katalog', 'eigen'), { recursive: true });
    await fs.writeFile(path.join(u.pfade.apps, '_katalog', 'eigen', 'eigen-fah.json'), JSON.stringify({ id: 'eigen-fah', name: 'FAH-App', verfuegbar: false, risiko: ['x'], dokumentation: 'https://doku/fah', compose: 'services:\n  a:\n    image: fah/sicherung:1\n    ports:\n      - "${PORT_WEB}:8060"\n    restart: unless-stopped\n', felder: [{ name: 'PORT_WEB', art: 'port', standard: 8060 }] }));
    const e = await u.auf('apps.katalog.eintrag', { id: 'eigen-fah' });
    assert.equal(e.verfuegbar, false); assert.deepEqual(e.risiko, ['x']); assert.equal(e.dokumentation, 'https://doku/fah');
    assert.equal((await u.auf('apps.katalog.liste', { quelle: 'eigen' })).eintraege[0].verfuegbar, false, 'Liste reicht verfuegbar durch');
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'eigen-fah', name: 'fah', werte: {} }), (x) => x.code === 'E_NICHT_GEFUNDEN' && /lokal gebaut/.test(x.message) && x.details.image === 'fah/sicherung:1');
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'fah')));
    u.docker.images.set('fah/sicherung:1', 'sha256:lokal');
    u.docker.leeren();
    const r = await u.auf('apps.installieren', { katalog_id: 'eigen-fah', name: 'fah', werte: {} });
    assert.equal(r.zustand, 'running'); assert.equal(u.docker.compose('pull').length, 0, 'kein pull für lokale Images'); assert.equal(u.docker.compose('up').length, 1);
  } finally { await u.aufraeumen(); }
});

test('firewall: appPortsLesen aus dem Spiegel; rendereFirewall ohne zusatzPorts (system.js-Weg) behält App-Ports, mit [] entfernt sie; Kern-Ports nicht doppelt', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    await fs.mkdir(path.join(u.pfade.konfig, 'apps', 'kaputt'), { recursive: true }); await fs.writeFile(path.join(u.pfade.konfig, 'apps', 'kaputt', 'app.json'), '{');
    await fs.mkdir(path.join(u.pfade.konfig, 'apps', 'web'), { recursive: true }); await fs.writeFile(path.join(u.pfade.konfig, 'apps', 'web', 'app.json'), JSON.stringify({ name: 'web', ports: [{ port: 445, protokoll: 'tcp' }, { port: 51820, protokoll: 'udp' }, { port: 70000 }, { port: 3010, protokoll: 'tcp' }] }));
    assert.deepEqual(await appPortsLesen(u.pfade.konfig), [{ proto: 'tcp', port: 3010, kommentar: 'App kuma' }, { proto: 'udp', port: 51820, kommentar: 'App web' }]);
    assert.deepEqual(await appPortsLesen(path.join(u.w, 'gibtsnicht')), []);
    const r = await rendereFirewall({ ssh: false }, { system: { ausfuehren: u.docker.ausfuehren }, konfigOrdner: u.pfade.konfig, pfad: u.pfade.nft });
    assert.deepEqual(r.zusatz, [{ proto: 'tcp', port: 3010, kommentar: 'App kuma' }, { proto: 'udp', port: 51820, kommentar: 'App web' }]);
    const text = await fs.readFile(u.pfade.nft, 'utf8');
    assert.ok(text.includes('tcp dport 3010 accept comment "App kuma"') && text.includes('udp dport 51820 accept comment "App web"') && text.includes('# SSH (22/tcp) ist ausgeschaltet'));
    assert.equal(text, nftText({ ssh: false, zusatz: r.zusatz }));
    const r2 = await rendereFirewall({ ssh: true, zusatz: [{ proto: 'tcp', port: 9443, kommentar: 'VM' }] }, { system: { ausfuehren: u.docker.ausfuehren }, zusatzPorts: [], pfad: u.pfade.nft });
    assert.deepEqual(r2.zusatz, [{ proto: 'tcp', port: 9443, kommentar: 'VM' }]);
    assert.ok(!(await fs.readFile(u.pfade.nft, 'utf8')).includes('App '));
  } finally { await u.aufraeumen(); }
});

test('docker.js: JSON-Zeilen/Array, Speicher, Ports, Labels, Zustand; composeMitZeilen über starten (Zeilen live, Exit ≠ 0 → E_SYSTEM, Fortschritt beim pull)', async () => {
  assert.deepEqual(jsonZeilen('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]); assert.deepEqual(jsonZeilen('[{"a":1}]'), [{ a: 1 }]); assert.deepEqual(jsonZeilen('  '), []); assert.deepEqual(jsonZeilen('WARNING: x\n{"a":3}'), [{ a: 3 }]);
  assert.equal(speicherParsen('476KiB / 7.246GiB'), 487424); assert.equal(speicherParsen('1.5GiB / 8GiB'), Math.round(1.5 * 1024 ** 3)); assert.equal(speicherParsen('12MB / 1GB'), 12_000_000); assert.equal(speicherParsen('0B / 0B'), 0); assert.equal(speicherParsen('x'), null);
  assert.deepEqual(portsParsen('0.0.0.0:18081->80/tcp, [::]:18081->80/tcp, 0.0.0.0:53->53/udp, 9000-9001->9000-9001/tcp'), [{ port: 18081, protokoll: 'tcp' }, { port: 53, protokoll: 'udp' }, { port: 9000, protokoll: 'tcp' }, { port: 9001, protokoll: 'tcp' }]);
  assert.deepEqual(portsParsen(''), []); assert.deepEqual(portsParsen('80/tcp'), [], 'nicht veröffentlicht');
  assert.deepEqual(labelsParsen('a=1,com.docker.compose.project=fahnas-x,b=c=d'), { a: '1', 'com.docker.compose.project': 'fahnas-x', b: 'c=d' });
  assert.deepEqual(zustandZusammenfassen([]), { zustand: 'fehlt', gesundheit: null });
  assert.deepEqual(zustandZusammenfassen([{ zustand: 'running', gesundheit: 'healthy' }, { zustand: 'running', gesundheit: 'starting' }]), { zustand: 'running', gesundheit: 'starting' });
  assert.deepEqual(zustandZusammenfassen([{ zustand: 'running' }, { zustand: 'exited' }]), { zustand: 'teilweise', gesundheit: null });
  assert.deepEqual(zustandZusammenfassen([{ zustand: 'exited' }, { zustand: 'created' }]), { zustand: 'exited', gesundheit: null });
  assert.deepEqual(zustandZusammenfassen([{ zustand: 'restarting' }, { zustand: 'running' }]), { zustand: 'restarting', gesundheit: null });
  assert.deepEqual(zustandZusammenfassen([{ zustand: 'running', gesundheit: 'unhealthy' }]), { zustand: 'running', gesundheit: 'unhealthy' });
  // starten-Weg
  const aufrufe = [];
  function kindBauen(zeilen, code) {
    const k = new EventEmitter(); k.stdout = new PassThrough(); k.stderr = new PassThrough(); k.kill = () => {};
    setTimeout(() => { for (const z of zeilen) k.stderr.write(z + '\n'); k.stderr.end(); k.stdout.end(); setTimeout(() => k.emit('close', code), 5); }, 5);
    return k;
  }
  let naechstes = { zeilen: [' web Pulling ', '  abc Downloading', ' web Pulled ', ' db Pulling ', ' db Error manifest unknown'], code: 0 };
  const sys = { ausfuehren: async () => ok, starten: (p, a, o) => { aufrufe.push([p, ...a]); assert.equal(o.env.DOCKER_CLI_HINTS, 'false'); return kindBauen(naechstes.zeilen, naechstes.code); } };
  const d = new Docker(sys);
  const app = { name: 'x', composeDatei: '/tmp/c.yml', envDatei: '/tmp/.env' };
  const fort = [];
  const r = await d.pull(app, [{ name: 'web' }, { name: 'db' }], { ignorieren: true, fortschritt: (a, m) => fort.push([Math.round(a * 100) / 100, m]) });
  assert.deepEqual(r.fehler, ['db: manifest unknown']);
  assert.deepEqual(aufrufe[0], ['docker', 'compose', '--ansi', 'never', '--progress', 'plain', '-p', 'fahnas-x', '-f', '/tmp/c.yml', '--env-file', '/tmp/.env', 'pull', '--ignore-pull-failures']);
  assert.equal(fort[0][1], 'Image für „web“ wird geladen'); assert.ok(fort.at(-1)[0] >= 0.9, 'beide Dienste fertig');
  assert.ok(fort.some(([a]) => a > 0 && a < 0.5), 'Zwischenstand nach der ersten Schicht');
  naechstes = { zeilen: ['Error response from daemon: kaputt'], code: 1 };
  await assert.rejects(d.up(app), (e) => e.code === 'E_SYSTEM' && /kaputt/.test(e.message) && e.details.befehl.includes('up -d --remove-orphans'));
  // ohne starten: Rückfall über ausfuehren mit Zeilen am Ende
  const sys2 = { ausfuehren: async (p, a) => ({ code: 0, stdout: '', stderr: ' web Pulling \n web Pulled \n' }) };
  const r2 = await new Docker(sys2).pull(app, [{ name: 'web' }], { fortschritt: (a) => fort.push([a]) });
  assert.deepEqual(r2.fehler, []); assert.ok(fort.at(-1)[0] >= 0.9);
});

// ---------------------------------------------------------------------------------------------------------------
// FAH-Apps aus dem mitgelieferten Quellcode bauen, Host-Netz-Ports in der Firewall (Mini-PC 25.09.)
// ---------------------------------------------------------------------------------------------------------------
async function bauKatalog({ quelle = true, sha = 'a'.repeat(64) } = {}) {
  const k = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-bauk-'));
  await fs.writeFile(path.join(k, 'fah-probe.json'), JSON.stringify({
    id: 'fah-probe', name: 'FAH-Probe', beschreibung: 'Probe-App zum Bauen aus dem Quellcode.', kategorie: 'Werkzeuge', quelle: 'eingebaut',
    bauen: { release_zip: 'fah-probe_release.zip' }, webui: 'http://{HOST}:{PORT_WEB}',
    compose: 'services:\n  probe:\n    image: fah-probe:latest\n    restart: unless-stopped\n    ports:\n      - "${PORT_WEB}:8080"\n',
    felder: [{ name: 'PORT_WEB', art: 'port', standard: 18080, beschriftung: 'Port', erklaerung: 'Port der Probe.' }],
  }));
  await fs.writeFile(path.join(k, 'fah-dns.json'), JSON.stringify({
    id: 'fah-dns', name: 'FAH-DNS', quelle: 'eingebaut', webui: 'http://{HOST}:{PORT_WEB}',
    compose: 'services:\n  dns:\n    image: dns:1\n    restart: unless-stopped\n    network_mode: host\n    environment:\n      - DNS_BIND=${ADRESSE}\n      - DNS_PORT=${PORT_DNS}\n      - WEB_PORT=${PORT_WEB}\n      - GATEWAY=${GW}\n',
    felder: [
      { name: 'PORT_DNS', art: 'port', standard: 53, protokoll: 'tcp+udp', adresse_feld: 'ADRESSE' },
      { name: 'PORT_WEB', art: 'port', standard: 8053 },
      { name: 'ADRESSE', art: 'variable', standard: '{NAS_IP}', pflicht: true },
      { name: 'GW', art: 'variable', standard: '{NAS_GATEWAY}', pflicht: true },
    ],
  }));
  if (quelle) {
    await fs.mkdir(path.join(k, 'quellen', 'fah-probe'), { recursive: true });
    await fs.writeFile(path.join(k, 'quellen', 'fah-probe', 'Dockerfile'), 'FROM alpine:3\n');
    await fs.writeFile(path.join(k, 'quellen', 'fah-probe.json'), JSON.stringify({ zip: 'fah-probe_release.zip', sha256: sha, version: '1.2.3' }));
  }
  return k;
}

test('bauen: ohne Quellcode nicht verfügbar (klare Meldung, keine Spuren); mit Quellcode → docker build mit Labels, kein pull, Start; zweite Installation baut nicht erneut', async () => {
  const ohne = await bauKatalog({ quelle: false });
  const u0 = await umgebung({ katalog: ohne });
  try {
    const e = await u0.auf('apps.katalog.eintrag', { id: 'fah-probe' });
    assert.equal(e.verfuegbar, false); assert.equal(e.bauen.kontext, null);
    await assert.rejects(u0.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} }), (x) => x.code === 'E_NICHT_GEFUNDEN' && /Quellcode/.test(x.message) && /FAH-NAS aktualisieren/.test(x.message));
    await assert.rejects(fs.stat(path.join(u0.pfade.apps, 'probe')));
    assert.equal(u0.docker.zeilen().filter((z) => z.startsWith('docker build ')).length, 0);
  } finally { await u0.aufraeumen(); await fs.rm(ohne, { recursive: true, force: true }); }

  const k = await bauKatalog();
  const u = await umgebung({ katalog: k });
  try {
    const e = await u.auf('apps.katalog.eintrag', { id: 'fah-probe' });
    assert.equal(e.verfuegbar, true); assert.equal(e.bauen.image, 'fah-probe:latest'); assert.equal(e.bauen.quelle, 'a'.repeat(64)); assert.equal(e.bauen.version, '1.2.3');
    assert.equal((await u.auf('apps.katalog.liste', { suche: 'probe' })).eintraege[0].verfuegbar, true);
    const r = await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    assert.equal(r.zustand, 'running');
    const bau = u.docker.befehle.filter((b) => b[0] === 'docker' && b[1] === 'build');
    assert.equal(bau.length, 1);
    assert.deepEqual(bau[0].slice(0, 5), ['docker', 'build', '--pull', '-t', 'fah-probe:latest']);
    assert.ok(bau[0].includes(`fahnas.quelle=${'a'.repeat(64)}`) && bau[0].includes('fahnas.katalog=fah-probe') && bau[0].includes('fahnas.version=1.2.3'));
    assert.ok(bau[0].includes('--progress'), 'mit buildx: --progress plain');
    assert.equal(bau[0][bau[0].length - 1], path.join(k, 'quellen', 'fah-probe'));
    assert.equal(u.docker.compose('pull').length, 0, 'kein pull für das gebaute Image');
    assert.equal(u.docker.compose('up').length, 1);
    assert.ok(u.verlauf.some(([, m]) => /Schritt 2\/3/.test(m || '')), 'Baufortschritt kommt in der Aufgabe an');
    const satz = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'probe', 'app.json'), 'utf8'));
    assert.deepEqual(satz.vorlage.bauen, { dienst: 'probe', image: 'fah-probe:latest' });
    // zweite Installation derselben Vorlage: Image stammt schon aus dieser Quelle → kein Bau
    u.docker.leeren();
    await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe2', werte: { PORT_WEB: 18081 } });
    assert.equal(u.docker.zeilen().filter((z) => z.startsWith('docker build ')).length, 0);
    // alter Builder ohne buildx: kein --progress
    u.docker.buildx = false; u.docker.labels.delete('fah-probe:latest'); u.docker.leeren();
    const d2 = new Docker({ ausfuehren: (...a) => u.docker.ausfuehren(...a) });
    await d2.bauen('fah-probe:latest', path.join(k, 'quellen', 'fah-probe'), { labels: { a: 'b' } });
    assert.ok(!u.docker.befehle.find((b) => b[1] === 'build').includes('--progress'));
    // Baufehler → E_SYSTEM mit Ausgabe, keine halbe App
    u.docker.bauFehler = 'npm ERR! network'; u.docker.labels.clear(); u.docker.images.delete('fah-probe:latest');
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe3', werte: { PORT_WEB: 18082 } }), (x) => x.code === 'E_SYSTEM' && /konnte nicht gebaut werden/.test(x.message));
    await assert.rejects(fs.stat(path.join(u.pfade.apps, 'probe3')));
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('bauen: aktualisieren baut nur neu, wenn das Programm neueren Quellcode mitbringt (Label fahnas.quelle), dann Container erneuert; kein pull', async () => {
  const k = await bauKatalog();
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    u.docker.leeren();
    const r1 = await u.auf('apps.aktualisieren', { name: 'probe' });
    assert.equal(u.docker.zeilen().filter((z) => z.startsWith('docker build ')).length, 0);
    assert.equal(u.docker.compose('pull').length, 0, 'kein pull für FAH-Apps');
    assert.equal(r1.neustart, false); assert.ok(r1.warnungen.some((x) => /schon aus dem Quellcode/.test(x)));
    // FAH-NAS-Update bringt neuen Quellcode (andere Prüfsumme) – neuer Agent liest den Katalog neu
    await fs.writeFile(path.join(k, 'quellen', 'fah-probe.json'), JSON.stringify({ zip: 'fah-probe_release.zip', sha256: 'b'.repeat(64), version: '1.2.4' }));
    const u2 = { ...u };
    const reg2 = new Register(); registriere(reg2, { konfig: u.konfig, system: { ausfuehren: (...a) => u.docker.ausfuehren(...a) }, pfade: u.pfade, ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} } });
    u2.auf = async (name, params, kontext = K.chef) => { const { aktion, params: p } = reg2.vorbereiten(name, params, kontext); return aktion.ausfuehren(p, kontext, {}, { fortschritt() {}, abgebrochen: () => false }); };
    u.docker.leeren();
    const r2 = await u2.auf('apps.aktualisieren', { name: 'probe' });
    const bau = u.docker.befehle.filter((b) => b[1] === 'build');
    assert.equal(bau.length, 1); assert.ok(bau[0].includes(`fahnas.quelle=${'b'.repeat(64)}`));
    assert.equal(r2.neustart, true); assert.deepEqual(r2.geaendert, ['fah-probe:latest']);
    assert.equal(u.docker.compose('pull').length, 0);
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('Host-Netz: NAS-Adresse/Gateway vorbelegt, Ports tcp+udp in Firewall und Satz, Konflikt nur bei überlappender Adresse (resolved auf 127.0.0.53 stört nicht)', async () => {
  const k = await bauKatalog({ quelle: false });
  const u = await umgebung({ katalog: k });
  try {
    u.docker.ssPorts.push('127.0.0.53%lo:53/udp', '127.0.0.53%lo:53/tcp', '192.168.122.1:53/udp');
    const e = await u.auf('apps.katalog.eintrag', { id: 'fah-dns' });
    assert.equal(e.felder.find((f) => f.name === 'ADRESSE').standard, '192.168.1.29');
    assert.equal(e.felder.find((f) => f.name === 'GW').standard, '192.168.1.1');
    const v = await u.auf('apps.pruefen', { katalog_id: 'fah-dns', name: 'dns', werte: {} });
    assert.deepEqual(v.port_konflikte, []);
    assert.deepEqual(v.ports.map((p) => `${p.port}/${p.protokoll}`), ['53/tcp', '53/udp', '8053/tcp']);
    // an 0.0.0.0 gebunden → Konflikt mit resolved
    const v0 = await u.auf('apps.pruefen', { katalog_id: 'fah-dns', name: 'dns', werte: { ADRESSE: '0.0.0.0' } });
    assert.ok(v0.port_konflikte.some((x) => x.port === 53 && x.feld === 'PORT_DNS'));
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'fah-dns', name: 'dns', werte: { ADRESSE: '0.0.0.0' }, bestaetigt_riskant: ['network_host'] }), (x) => x.code === 'E_BELEGT');
    const r = await u.auf('apps.installieren', { katalog_id: 'fah-dns', name: 'dns', werte: {}, bestaetigt_riskant: ['network_host'] });
    assert.deepEqual(r.ports.map((p) => `${p.port}/${p.protokoll}`), ['53/tcp', '53/udp', '8053/tcp']);
    const env = envLesen(await fs.readFile(path.join(u.pfade.apps, 'dns', '.env'), 'utf8'));
    assert.equal(env.ADRESSE, '192.168.1.29'); assert.equal(env.GW, '192.168.1.1');
    const nft = await fs.readFile(u.pfade.nft, 'utf8');
    for (const t of ['tcp dport 53 accept comment "App dns"', 'udp dport 53 accept comment "App dns"', 'tcp dport 8053 accept comment "App dns"']) assert.ok(nft.includes(t), `Firewall: ${t}`);
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('apply: Host-Netz-App von vor 0.2.3 (Satz ohne Ports) bekommt ihre Ports nachgetragen – Firewall folgt (Home Assistant 8123)', async () => {
  const k = await bauKatalog({ quelle: false });
  await fs.writeFile(path.join(k, 'ha.json'), JSON.stringify({ id: 'ha', name: 'HA', quelle: 'eingebaut', webui: 'http://{HOST}:8123', host_ports: [{ port: 8123, protokoll: 'tcp' }, { port: 5683, protokoll: 'udp' }], compose: 'services:\n  ha:\n    image: ha:1\n    restart: unless-stopped\n    network_mode: host\n', felder: [] }));
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'ha', name: 'ha', werte: {}, bestaetigt_riskant: ['network_host'] });
    // Zustand wie auf dem Mini-PC: Satz ohne Ports, Vorlagen-Kopie ohne host_ports
    await u.konfig.aendern('apps/ha/app.json', (d) => ({ ...d, ports: [], vorlage: { ...d.vorlage, host_ports: undefined } }), null);
    assert.deepEqual(await appPortsLesen(u.pfade.konfig), []);
    const r = await u.auf('apps.apply', {}, K.system);
    assert.ok(r.warnungen.some((x) => /8123\/tcp/.test(x) && /5683\/udp/.test(x)));
    assert.deepEqual((await appPortsLesen(u.pfade.konfig)).map((p) => `${p.port}/${p.proto}`), ['5683/udp', '8123/tcp']);
    const r2 = await u.auf('apps.apply', {}, K.system);
    assert.ok(!r2.warnungen.some((x) => /Host-Netz-Ports/.test(x)), 'zweiter Lauf trägt nichts mehr nach');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('Prüfung 0.2.3: aendern prüft eine geänderte Lauschadresse (0.0.0.0 kollidiert mit resolved), gleiche Adresse bleibt frei', async () => {
  const k = await bauKatalog({ quelle: false });
  const u = await umgebung({ katalog: k });
  try {
    u.docker.ssPorts.push('127.0.0.53%lo:53/udp', '127.0.0.53%lo:53/tcp');
    await u.auf('apps.installieren', { katalog_id: 'fah-dns', name: 'dns', werte: {}, bestaetigt_riskant: ['network_host'] });
    u.docker.ssPorts.push('192.168.1.29:53/udp', '192.168.1.29:53/tcp'); // die App selbst lauscht jetzt
    await assert.rejects(u.auf('apps.aendern', { name: 'dns', werte: { ADRESSE: '0.0.0.0' } }), (x) => x.code === 'E_BELEGT' && /53/.test(x.message));
    assert.equal(envLesen(await fs.readFile(path.join(u.pfade.apps, 'dns', '.env'), 'utf8')).ADRESSE, '192.168.1.29', '.env unverändert');
    const r = await u.auf('apps.aendern', { name: 'dns', werte: { PORT_WEB: 8054 } });
    assert.ok(r.ports.some((p) => p.port === 8054), 'gleiche Adresse: eigener Port 53 ist kein Konflikt');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('Prüfung 0.2.3: apply frischt die Vorlagen-Kopie auf (53/udp für alte FAH-Adblock-Sätze), aendern behält Katalog-host_ports', async () => {
  const k = await bauKatalog({ quelle: false });
  await fs.writeFile(path.join(k, 'ha.json'), JSON.stringify({ id: 'ha', name: 'HA', quelle: 'eingebaut', webui: 'http://{HOST}:8123', host_ports: [{ port: 5683, protokoll: 'udp' }], compose: 'services:\n  ha:\n    image: ha:1\n    restart: unless-stopped\n    network_mode: host\n    environment:\n      - TZ=${TZ}\n', felder: [{ name: 'TZ', art: 'variable', standard: 'Europe/Berlin' }] }));
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'fah-dns', name: 'dns', werte: {}, bestaetigt_riskant: ['network_host'] });
    await u.auf('apps.installieren', { katalog_id: 'ha', name: 'ha', werte: {}, bestaetigt_riskant: ['network_host'] });
    // Satz wie von vor 0.2.3: PORT_DNS nur tcp, keine Ports, keine host_ports in der Kopie
    await u.konfig.aendern('apps/dns/app.json', (d) => ({ ...d, ports: [], vorlage: { ...d.vorlage, felder: d.vorlage.felder.map((f) => (f.name === 'PORT_DNS' ? { ...f, protokoll: 'tcp', adresse_feld: undefined } : f)) } }), null);
    await u.konfig.aendern('apps/ha/app.json', (d) => { const v = { ...d.vorlage }; delete v.host_ports; return { ...d, ports: [], vorlage: v }; }, null);
    await u.auf('apps.apply', {}, K.system);
    const ports = (await appPortsLesen(u.pfade.konfig)).map((p) => `${p.port}/${p.proto}`).sort();
    assert.deepEqual(ports, ['5683/udp', '53/tcp', '53/udp', '8053/tcp', '8123/tcp'].sort());
    const satz = JSON.parse(await fs.readFile(path.join(u.pfade.konfig, 'apps', 'dns', 'app.json'), 'utf8'));
    assert.equal(satz.vorlage.felder.find((f) => f.name === 'PORT_DNS').protokoll, 'tcp+udp');
    assert.ok(satz.ports.find((p) => p.port === 53 && p.protokoll === 'udp').adresse === '192.168.1.29');
    await u.auf('apps.aendern', { name: 'ha', werte: { TZ: 'Europe/Vienna' } });
    assert.deepEqual((await appPortsLesen(u.pfade.konfig)).filter((p) => p.kommentar === 'App ha').map((p) => `${p.port}/${p.proto}`).sort(), ['5683/udp', '8123/tcp'], 'host_ports bleiben nach aendern');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('Prüfung 0.2.3: aktualisieren baut auch für Sätze ohne bauen (vor 0.2.3); Label ohne Katalogvorlage → klare Meldung vor der Sicherung; apply baut fehlendes Image', async () => {
  const k = await bauKatalog();
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    u.docker.pullFehler = (image) => (/^fah-/.test(image) ? 'pull access denied' : null);
    // (a) Satz wie vor 0.2.3 (ohne bauen), Image ohne Label (von Hand gebaut)
    await u.konfig.aendern('apps/probe/app.json', (d) => { const v = { ...d.vorlage }; delete v.bauen; return { ...d, vorlage: v }; }, null);
    u.docker.labels.set('fah-probe:latest', {}); u.docker.leeren();
    const r = await u.auf('apps.aktualisieren', { name: 'probe' });
    assert.equal(u.docker.befehle.filter((b) => b[1] === 'build').length, 1, 'gebaut statt gepullt');
    assert.equal(u.docker.compose('pull').length, 0);
    assert.equal(r.neustart, true);
    // (b) Vorlage aus dem Katalog verschwunden, Image trägt fahnas.katalog → Meldung, keine Sicherung
    await fs.rm(path.join(k, 'fah-probe.json'));
    const reg2 = new Register(); registriere(reg2, { konfig: u.konfig, system: { ausfuehren: (...a) => u.docker.ausfuehren(...a) }, pfade: u.pfade, ereignis() {}, konfigGeaendert() {}, audit: { eintrag() {} } });
    const auf2 = async (name, params, kontext = K.chef) => { const { aktion, params: p } = reg2.vorbereiten(name, params, kontext); return aktion.ausfuehren(p, kontext, {}, { fortschritt() {}, abgebrochen: () => false }); };
    const vorher = (await fs.readdir(path.join(u.pfade.apps, 'probe'))).filter((n) => n.startsWith('daten.vor-update')).length;
    await assert.rejects(auf2('apps.aktualisieren', { name: 'probe' }), (x) => x.code === 'E_NICHT_GEFUNDEN' && /nicht mehr/.test(x.message));
    assert.equal((await fs.readdir(path.join(u.pfade.apps, 'probe'))).filter((n) => n.startsWith('daten.vor-update')).length, vorher, 'keine Sicherung angelegt');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }

  const k2 = await bauKatalog();
  const u2 = await umgebung({ katalog: k2 });
  try {
    await u2.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    u2.docker.images.delete('fah-probe:latest'); u2.docker.labels.delete('fah-probe:latest');
    u2.docker.pullFehler = (image) => (/^fah-/.test(image) ? 'pull access denied' : null);
    u2.docker.leeren();
    const r = await u2.auf('apps.apply', {}, K.system);
    assert.deepEqual(r.fehler, []); assert.deepEqual(r.gestartet, ['probe']);
    assert.ok(r.warnungen.some((x) => /neu gebaut/.test(x)));
    assert.equal(u2.docker.befehle.filter((b) => b[1] === 'build').length, 1);
  } finally { await u2.aufraeumen(); await fs.rm(k2, { recursive: true, force: true }); }
});

test('steuern start: fehlendes FAH-Image (Wechsel des Docker-Speichers, Mini-PC 09.10.) wird aus dem Quellcode gebaut statt gepullt; vorhandenes nicht', async () => {
  const k = await bauKatalog();
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    await u.auf('apps.steuern', { name: 'probe', aktion: 'stopp' });
    u.docker.images.delete('fah-probe:latest'); u.docker.labels.delete('fah-probe:latest');
    u.docker.pullFehler = (image) => (/^fah-/.test(image) ? 'pull access denied' : null);
    u.docker.leeren();
    const r = await u.auf('apps.steuern', { name: 'probe', aktion: 'start' });
    assert.equal(r.aktion, 'start');
    assert.equal(u.docker.befehle.filter((b) => b[1] === 'build').length, 1, 'gebaut');
    assert.ok(u.docker.compose('up').length >= 1, 'danach gestartet');
    u.docker.leeren();
    await u.auf('apps.steuern', { name: 'probe', aktion: 'start' });
    assert.equal(u.docker.befehle.filter((b) => b[1] === 'build').length, 0, 'Image da → nicht erneut gebaut');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('loeschen räumt Images ab (nur unbenutzte), aktualisieren entfernt alte Fassungen und Bau-Zwischenspeicher', async () => {
  const u = await umgebung();
  try {
    await u.auf('apps.installieren', KUMA);
    await u.auf('apps.installieren', { ...KUMA, name: 'kuma2', werte: { ...KUMA.werte, PORT_WEB: 3020 } }); // gleiches Image
    const image = [...u.docker.images.keys()][0];
    u.docker.leeren();
    const a = await u.auf('apps.aktualisieren', { name: 'kuma' });
    assert.ok(u.docker.befehle.some((b) => b.join(' ') === 'docker image prune -f'), 'unbenannte Images weg');
    assert.ok(u.docker.befehle.some((b) => b.join(' ') === 'docker builder prune -f --filter until=168h'), 'alter Bau-Zwischenspeicher weg');
    assert.equal(a.frei_bytes, 3500000);
    // kuma löschen: Image bleibt, weil kuma2 es noch benutzt
    const r1 = await u.auf('apps.loeschen', { name: 'kuma', daten: 'loeschen' });
    assert.deepEqual(r1.images_entfernt, []); assert.ok(u.docker.images.has(image));
    // kuma2 löschen: jetzt benutzt es niemand mehr → weg, Größe zählt mit
    const r2 = await u.auf('apps.loeschen', { name: 'kuma2', daten: 'loeschen' });
    assert.deepEqual(r2.images_entfernt, [image]); assert.ok(!u.docker.images.has(image));
    assert.equal(r2.frei_bytes, 100000000 + 3500000);
  } finally { await u.aufraeumen(); }
});

test('Einstellungen ändern übernimmt bei eingebauten Vorlagen Compose und neue Felder aus dem Katalog (FAH-Proxy 0.6.17: Ports 80/443 im Haus)', async () => {
  const k = await bauKatalog();
  const u = await umgebung({ katalog: k });
  try {
    await u.auf('apps.installieren', { katalog_id: 'fah-probe', name: 'probe', werte: {} });
    // FAH-NAS-Update bringt eine Vorlage mit neuem Port-Feld
    const datei = path.join(k, 'fah-probe.json');
    const v = JSON.parse(await fs.readFile(datei, 'utf8'));
    v.compose = v.compose.replace('      - "${PORT_WEB}:8080"\n', '      - "${PORT_WEB}:8080"\n      - "${PORT_INTERN}:8443"\n');
    v.felder.push({ name: 'PORT_INTERN', art: 'port', standard: 18443, beschriftung: 'Port im Haus' });
    await fs.writeFile(datei, JSON.stringify(v));
    const r = await u.auf('apps.aendern', { name: 'probe', werte: {} });
    assert.ok(r.ports.some((p) => p.port === 18443), 'neuer Port aus der Katalog-Vorlage');
    assert.ok((await fs.readFile(path.join(u.pfade.apps, 'probe', 'compose.yml'), 'utf8')).includes(':8443'));
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});

test('Katalog: Vorlagen „nur Bestand“ (eigene FAH-Apps) erscheinen nicht und lassen sich nicht neu installieren', async () => {
  const k = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-bestand-'));
  await fs.writeFile(path.join(k, 'fah-bestand.json'), JSON.stringify({ id: 'fah-bestand', name: 'FAH-Bestand', beschreibung: 'Test.', kategorie: 'Werkzeuge', symbol: 'https://x/y.svg', quelle: 'eingebaut', nur_bestand: true, compose: 'services:\n  a:\n    image: x:1\n    restart: always\n', felder: [] }));
  await fs.writeFile(path.join(k, 'offen.json'), JSON.stringify({ id: 'offen', name: 'Offen', beschreibung: 'Test.', kategorie: 'Werkzeuge', symbol: 'https://x/y.svg', quelle: 'eingebaut', compose: 'services:\n  a:\n    image: x:1\n    restart: always\n', felder: [] }));
  const u = await umgebung({ katalog: k });
  try {
    const l = await u.auf('apps.katalog.liste', {});
    assert.deepEqual(l.eintraege.map((e) => e.id), ['offen'], 'Bestands-Vorlage nicht in der Auswahl');
    await assert.rejects(u.auf('apps.installieren', { katalog_id: 'fah-bestand', name: 'bestand', werte: {} }), (e) => e.code === 'E_PARAMS' && /per ZIP/.test(e.message));
    assert.equal((await u.auf('apps.katalog.eintrag', { id: 'fah-bestand' })).id, 'fah-bestand', 'für schon installierte Apps weiter lesbar');
  } finally { await u.aufraeumen(); await fs.rm(k, { recursive: true, force: true }); }
});
