// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests: eigene App aus einer Compose-Datei (src/agent/apps/eigene.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vorlageAusCompose, yamlSchreiben } from '../../src/agent/apps/eigene.js';
import { rendern, yamlLesen } from '../../src/agent/apps/compose.js';

const WURZELN = { appOrdner: '/data/apps/test', shares: '/data/shares', host: 'nas' };
const werteAus = (v, extra = {}) => ({ ...Object.fromEntries(v.felder.map((f) => [f.name, f.standard === '' ? 'geheim12345' : f.standard])), ...extra });

test('eigene Compose: Ports und relative Pfade werden Felder, docker.sock bleibt mit Risiko, WebUI aus dem ersten Port', () => {
  const v = vorlageAusCompose(`services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "3001:3001"
      - 127.0.0.1:5353:53/udp
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
`, { titel: 'Mein Kuma' });
  assert.equal(v.id, 'eigen-mein-kuma'); assert.equal(v.quelle, 'eigen'); assert.equal(v.name, 'Mein Kuma');
  assert.deepEqual(v.felder.map((f) => [f.name, f.art, f.standard]), [
    ['PORT_KUMA_3001', 'port', 3001], ['PORT_KUMA_53_UDP', 'port', 5353], ['PFAD_KUMA_DATA', 'pfad', 'daten/data'],
  ]);
  assert.match(v.compose, /"\$\{PORT_KUMA_3001\}:3001"/);
  assert.match(v.compose, /"127\.0\.0\.1:\$\{PORT_KUMA_53_UDP\}:53\/udp"/);
  assert.equal(v.webui, 'http://{HOST}:{PORT_KUMA_3001}');
  const g = rendern(v, werteAus(v), WURZELN);
  assert.deepEqual(g.ports.map((p) => `${p.port}/${p.protokoll}`).sort(), ['3001/tcp', '5353/udp']);
  assert.deepEqual(g.risiken.map((r) => r.art), ['docker_sock']);
  assert.equal(g.webui, 'http://nas:3001');
});

test('eigene Compose: ${VAR:-standard}, Pfad-Variablen, Geheimnisse, lange Syntax, fremde absolute Pfade', () => {
  const v = vorlageAusCompose(`version: "3.8"
name: immich
services:
  server:
    image: ghcr.io/immich-app/immich-server:\${IMMICH_VERSION:-release}
    ports:
      - target: 2283
        published: 2283
    volumes:
      - \${UPLOAD_LOCATION}:/usr/src/app/upload
      - type: bind
        source: /mnt/user/appdata/immich
        target: /config
        read_only: true
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
volumes:
  model-cache:
`);
  const f = Object.fromEntries(v.felder.map((x) => [x.name, x]));
  assert.equal(f.IMMICH_VERSION.art, 'variable'); assert.equal(f.IMMICH_VERSION.standard, 'release');
  assert.equal(f.UPLOAD_LOCATION.art, 'pfad'); assert.equal(f.UPLOAD_LOCATION.standard, 'daten/upload');
  assert.equal(f.DB_PASSWORD.art, 'geheimnis'); assert.equal(f.DB_PASSWORD.pflicht, true);
  assert.equal(f.PFAD_SERVER_CONFIG.standard, 'daten/immich'); assert.equal(f.PFAD_SERVER_CONFIG.nur_lesen, true);
  assert.ok(v.hinweise.some((h) => h.includes('/mnt/user/appdata/immich')));
  assert.ok(!/^name:/m.test(v.compose) && !/^version:/m.test(v.compose), 'Projektname/Version entfernt');
  const g = rendern(v, werteAus(v), WURZELN);
  assert.deepEqual(g.ports.map((p) => p.port), [2283]);
  assert.ok(g.binds.every((b) => b.quelle.startsWith('/data/apps/test/')));
});

test('eigene Compose: klare Fehler für build, env_file, configs, $VAR und leere Dateien', () => {
  const fehler = (text, muster) => assert.throws(() => vorlageAusCompose(text), (e) => e.code === 'E_PARAMS' && muster.test(e.message));
  fehler('', /Compose-Datei/);
  fehler('services:\n  a:\n    build: .\n', /build/);
  fehler('services:\n  a:\n    image: x\n    env_file: .env\n', /env_file/);
  fehler('services:\n  a:\n    image: x\n    configs:\n      - c\n', /configs/);
  fehler('services:\n  a:\n    image: x\n    environment:\n      A: $HOME\n', /\$\{NAME\}/);
  fehler('secrets:\n  s: {}\nservices:\n  a:\n    image: x\n', /secrets/);
});

test('yamlSchreiben: Ausgabe ist wieder lesbar (Rundreise)', () => {
  const doc = { services: { a: { image: 'x:1', ports: ['1:2'], environment: { A: 'mit "Zitat" und ${X}', B: 5, C: true }, volumes: [{ type: 'bind', source: '/data/shares/f', target: '/f' }], leer: [], nix: {} } }, volumes: { v: null } };
  assert.deepEqual(yamlLesen(yamlSchreiben(doc)), doc);
});
