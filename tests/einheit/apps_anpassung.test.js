// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests App-Editor (Betreiber 12.10.2026): wirksame Einstellungen lesen, Eingaben prüfen, Anpassungsdatei bauen (echt
// gegen docker compose config, wenn verfügbar), Ports für die Firewall, ZIP ohne manage.sh (Compose oder Dockerfile).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { einstellungenAusConfig, anpassungPruefen, anpassungYaml, portsAusDiensten, composeAusDockerfile, istGeheim } from '../../src/agent/apps/anpassung.js';
import { inhaltFinden, zipAuswerten } from '../../src/agent/apps/zip.js';

const APP = '/data/apps/qrwifi';
const SHARES = '/data/shares';
const CONFIG = {
  services: {
    web: {
      image: 'nginx:1', ports: [{ mode: 'ingress', target: 8080, published: '8088', protocol: 'tcp' }],
      volumes: [{ type: 'bind', source: '/', target: '/quellen', read_only: true, bind: { propagation: 'rslave', create_host_path: true } }, { type: 'volume', source: 'cache', target: '/cache', volume: {} }],
      environment: { TZ: 'Europe/Berlin', DB_PASSWORD: 'geh$$eim', LEER: null },
    },
  },
};

test('anpassung: wirksame Einstellungen lesen – Geheimnisse verdeckt, $$ → $', () => {
  const [d] = einstellungenAusConfig(CONFIG);
  assert.deepEqual(d.ports, [{ host: 8088, container: 8080, protokoll: 'tcp', adresse: '' }]);
  assert.deepEqual(d.pfade.map((p) => [p.art, p.host, p.container, p.nur_lesen]), [['ordner', '/', '/quellen', true], ['volume', 'cache', '/cache', false]]);
  assert.deepEqual(d.variablen.find((v) => v.name === 'DB_PASSWORD'), { name: 'DB_PASSWORD', wert: '', geheim: true });
  assert.equal(einstellungenAusConfig(CONFIG, { geheimnisseZeigen: true })[0].variablen.find((v) => v.name === 'DB_PASSWORD').wert, 'geh$eim');
  assert.ok(istGeheim('API_KEY') && istGeheim('admin_password') && !istGeheim('TZ'));
});

test('anpassung: Eingaben prüfen – Ports, unveränderte Einhängung erlaubt, neue nur App-Ordner/Freigaben, Geheimnis leer = unverändert', () => {
  const original = einstellungenAusConfig(CONFIG, { geheimnisseZeigen: true });
  const ctx = { original, aktuell: original, appOrdner: APP, shares: SHARES };
  const basis = (aend = {}) => [{ name: 'web', ports: [{ host: 9099, container: 8080, protokoll: 'tcp' }], pfade: [{ art: 'ordner', host: '/', container: '/quellen', nur_lesen: true }, { art: 'volume', host: 'cache', container: '/cache' }], variablen: [{ name: 'TZ', wert: 'Europe/Berlin' }, { name: 'DB_PASSWORD', wert: '' }], ...aend }];
  const [d] = anpassungPruefen(basis(), ctx);
  assert.equal(d.ports[0].host, 9099);
  assert.equal(d.variablen.find((v) => v.name === 'DB_PASSWORD').wert, 'geh$eim', 'leeres Geheimnis bleibt');
  const rel = anpassungPruefen(basis({ pfade: [{ art: 'ordner', host: 'daten/neu', container: '/daten' }] }), ctx)[0];
  assert.equal(rel.pfade[0].host, `${APP}/daten/neu`, 'relativ → im App-Ordner');
  assert.equal(anpassungPruefen(basis({ pfade: [{ art: 'ordner', host: '/data/shares/medien/filme', container: '/filme' }] }), ctx)[0].pfade[0].host, '/data/shares/medien/filme');
  assert.throws(() => anpassungPruefen(basis({ pfade: [{ art: 'ordner', host: '/etc', container: '/x' }] }), ctx), /App-Ordner|Freigaben/);
  assert.throws(() => anpassungPruefen(basis({ ports: [{ host: 0, container: 1 }] }), ctx), /ungültig/);
  assert.throws(() => anpassungPruefen(basis({ ports: [{ host: 9099, container: 1 }, { host: 9099, container: 2 }] }), ctx), /doppelt/);
  assert.throws(() => anpassungPruefen(basis({ variablen: [{ name: '1X', wert: 'a' }] }), ctx), /ungültig/);
  assert.throws(() => anpassungPruefen(basis({ pfade: [{ art: 'volume', host: 'fremd', container: '/x' }] }), ctx), /gehört nicht/);
  assert.throws(() => anpassungPruefen([{ name: 'gibtsnicht', ports: [] }], ctx), /Unbekannter Dienst/);
  assert.deepEqual(portsAusDiensten([d]), [{ port: 9099, protokoll: 'tcp', ziel: 8080, dienst: 'web' }]);
});

test('anpassung: Anpassungsdatei – !override, $ verdoppelt, bind-Optionen bleiben; echt mit docker compose config', async (t) => {
  const original = einstellungenAusConfig(CONFIG, { geheimnisseZeigen: true });
  const d = anpassungPruefen([{ name: 'web', ports: [{ host: 9099, container: 8080, protokoll: 'tcp' }], pfade: [{ art: 'ordner', host: '/', container: '/quellen', nur_lesen: true }], variablen: [{ name: 'A', wert: 'x$y' }] }], { original, aktuell: original, appOrdner: APP, shares: SHARES });
  const yaml = anpassungYaml(d, CONFIG);
  assert.match(yaml, /ports: !override \[/); assert.match(yaml, /environment: !override \{"A":"x\$\$y"\}/);
  assert.match(yaml, /"propagation":"rslave"/, 'rslave der Original-Einhängung bleibt');
  if (process.platform !== 'linux' || !(await system.existiert('/usr/bin/docker'))) { t.diagnostic('docker fehlt – nur Textprüfung'); return; }
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-anpassung-'));
  try {
    await fs.writeFile(path.join(w, 'compose.yml'), 'services:\n  web:\n    image: busybox\n    ports: ["8088:8080"]\n    environment: {TZ: Europe/Berlin}\n    volumes: ["/:/quellen:ro,rslave"]\n');
    await fs.writeFile(path.join(w, 'o.yml'), yaml);
    const r = await system.ausfuehren('docker', ['compose', '-p', 'probe', '-f', path.join(w, 'compose.yml'), '-f', path.join(w, 'o.yml'), 'config', '--format', 'json']);
    const s = JSON.parse(r.stdout).services.web;
    assert.deepEqual(s.ports.map((p) => p.published), ['9099'], 'Port ersetzt, nicht ergänzt');
    assert.deepEqual(Object.keys(s.environment), ['A'], 'Variablen ersetzt');
    assert.equal(s.volumes[0].bind.propagation, 'rslave');
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('ZIP ohne manage.sh: Compose oder Dockerfile finden, auch eine Ebene tiefer; Compose aus Dockerfile', async (t) => {
  const i1 = inhaltFinden(['app/main.py', 'docker-compose.yaml', 'Dockerfile', 'README.md']);
  assert.equal(i1.manage, null); assert.equal(i1.compose, 'docker-compose.yaml'); assert.equal(i1.ordner, null); assert.equal(i1.dockerfile, true);
  const i2 = inhaltFinden(['qrwifi/Dockerfile', 'qrwifi/app/main.py', '__MACOSX/qrwifi/._Dockerfile']);
  assert.equal(i2.ordner, 'qrwifi'); assert.equal(i2.compose, null); assert.equal(i2.dockerfile, true);
  const c = composeAusDockerfile('FROM python:3\nEXPOSE 8080\nEXPOSE 53/udp 9000\n', 'app');
  assert.match(c, /build: \./); assert.match(c, /"8080:8080"/); assert.match(c, /"53:53\/udp"/); assert.match(c, /"9000:9000"/);
  assert.doesNotMatch(composeAusDockerfile('FROM x\n', 'app'), /ports/);
  if (!(await system.existiert('/usr/bin/zip'))) { t.diagnostic('zip fehlt – Auswertung echter ZIPs übersprungen'); return; }
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-zipprobe-'));
  try {
    await fs.mkdir(path.join(w, 'q', 'app'), { recursive: true });
    await fs.writeFile(path.join(w, 'q', 'Dockerfile'), 'FROM python:3.12-slim\nEXPOSE 8080\n');
    await fs.writeFile(path.join(w, 'q', 'docker-compose.yaml'), 'services:\n  wifi-qr:\n    build: .\n    ports:\n      - "8088:8080"\n');
    await fs.writeFile(path.join(w, 'q', 'app', 'main.py'), 'print(1)\n');
    await system.ausfuehren('zip', ['-r', '-q', path.join(w, 'qrwifi.zip'), '.'], { cwd: path.join(w, 'q') });
    const a = await zipAuswerten(system, path.join(w, 'qrwifi.zip'), 'qrwifi.zip');
    assert.equal(a.ohne_skript, true); assert.equal(a.manage, null); assert.equal(a.compose_datei, 'docker-compose.yaml');
    assert.ok(!a.risiken.some((r) => r.art === 'skript'), 'kein Skript-Risiko ohne manage.sh');
    assert.equal(a.name_vorschlag, 'qrwifi');
    await fs.rm(path.join(w, 'q', 'docker-compose.yaml'));
    await system.ausfuehren('zip', ['-r', '-q', path.join(w, 'nur-dockerfile.zip'), '.'], { cwd: path.join(w, 'q') });
    const b = await zipAuswerten(system, path.join(w, 'nur-dockerfile.zip'), 'nur-dockerfile.zip');
    assert.match(b.compose, /"8080:8080"/); assert.ok(b.warnungen.some((x) => /nur ein Dockerfile/.test(x)));
    await fs.writeFile(path.join(w, 'leer.txt'), 'x');
    await system.ausfuehren('zip', ['-q', path.join(w, 'leer.zip'), 'leer.txt'], { cwd: w });
    await assert.rejects(zipAuswerten(system, path.join(w, 'leer.zip'), 'leer.zip'), /weder eine manage\.sh noch/);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('Pfade wie im Dateimanager (Betreiber 12.10.2026): „private/x“, „/private/x“, UNC und smb:// zeigen in die Freigabe', async () => {
  const { pfadDeuten, pfadPruefen } = await import('../../src/agent/apps/compose.js');
  const o = { appOrdner: '/data/apps/fah-downloader', shares: '/data/shares', freigaben: ['private', '1500gb'] };
  for (const e of ['private/fah-downloader', '/private/fah-downloader', '\\\\fahnas\\private\\fah-downloader', '//fahnas/private/fah-downloader', 'smb://fahnas/private/fah-downloader', '/data/shares/private/fah-downloader']) {
    assert.equal(pfadPruefen(e, { name: 'f', beschriftung: 'NAS-Ordner' }, o), '/data/shares/private/fah-downloader', e);
  }
  assert.equal(pfadPruefen('downloads', { name: 'f', beschriftung: 'NAS-Ordner' }, o), '/data/apps/fah-downloader/downloads', 'sonst relativ zum App-Ordner');
  assert.equal(pfadDeuten('/volume1', o), '/volume1');
  assert.throws(() => pfadPruefen('/volume1', { name: 'f', beschriftung: 'NAS-Ordner' }, o), /kurz private\/ordner/);
  const original = einstellungenAusConfig({ services: { app: { image: 'x', volumes: [{ type: 'bind', source: '/data/apps/fah-downloader/config', target: '/config' }] } } }, { geheimnisseZeigen: true });
  const [d] = anpassungPruefen([{ name: 'app', ports: [], variablen: [], pfade: [{ art: 'ordner', host: '/private/fah-downloader', container: '/downloads' }] }], { original, aktuell: original, appOrdner: o.appOrdner, shares: o.shares, freigaben: o.freigaben });
  assert.equal(d.pfade[0].host, '/data/shares/private/fah-downloader');
});
