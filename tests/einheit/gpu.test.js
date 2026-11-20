// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Grafikkarte für Apps (Ausbau Oktober 2026): lspci/nvidia-smi/docker inspect auswerten, GPU-Art eines Dienstes,
// Compose-Überschreibung (Intel/AMD, NVIDIA, zurück auf keine), Anpassungsdatei, Erkennung mit Schein-/sys und – wenn
// Docker da ist – echte Prüfung der Anpassungsdatei mit „docker compose config“.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lspciParsen, nvidiaSmiParsen, gpuNutzer, gpuAusDienst, gruppenIds, gpuUeberschreibung, NVIDIA_SKRIPT } from '../../src/agent/helfer/gpu.js';
import { einstellungenAusConfig, anpassungPruefen, anpassungYaml } from '../../src/agent/apps/anpassung.js';
import { gpuLesen } from '../../src/agent/aktionen/gpu.js';

const LSPCI = '0000:00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "Skylake-S GT1 [HD Graphics 510] [1902]" -r06 -p00 "Hewlett-Packard Company [103c]" "Device [8056]"\n'
  + '0000:00:1f.3 "Audio device [0403]" "Intel Corporation [8086]" "Sunrise Point-H HD Audio [a170]" -r31 -p00 "Hewlett-Packard Company [103c]" "Device [8056]"\n'
  + '0000:01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GP104 [GeForce GTX 1070] [1b81]" -ra1 -p00 "ASUSTeK Computer Inc. [1043]" "Device [8599]"\n';

test('gpu: lspci, nvidia-smi, docker inspect, Gruppen', () => {
  const k = lspciParsen(LSPCI);
  assert.equal(k.length, 2, 'nur Klasse 03xx');
  assert.deepEqual(k[0], { adresse: '0000:00:02.0', hersteller: 'intel', hersteller_name: 'Intel', modell: 'Skylake-S GT1 [HD Graphics 510]', klasse: 'VGA compatible controller' });
  assert.equal(k[1].hersteller, 'nvidia'); assert.equal(k[1].modell, 'GP104 [GeForce GTX 1070]');
  assert.deepEqual(nvidiaSmiParsen('NVIDIA GeForce GTX 1070, 580.95.05, 8192, 512, 7, 41\n')[0], { name: 'NVIDIA GeForce GTX 1070', treiber: '580.95.05', speicher_mb: 8192, speicher_belegt_mb: 512, auslastung: 7, temperatur: 41 });
  const n = gpuNutzer([
    { Name: '/jellyfin', State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': 'fahnas-jellyfin' } }, HostConfig: { Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri' }] } },
    { Name: '/ollama', State: { Running: false }, Config: { Labels: {} }, HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] } },
    { Name: '/fah-downloader', HostConfig: { Devices: [{ PathOnHost: '/dev/fuse' }] } },
  ]);
  assert.deepEqual(n, [{ container: 'jellyfin', app: 'jellyfin', art: 'dri', laeuft: true }, { container: 'ollama', app: 'ollama', art: 'nvidia', laeuft: false }]);
  assert.deepEqual(gruppenIds('root:x:0:\nvideo:x:44:\nrender:x:991:\n'), { video: '44', render: '991' });
});

test('gpu: GPU-Art eines Dienstes und Überschreibungen (fremde Geräte/Gruppen bleiben)', () => {
  assert.equal(gpuAusDienst({ devices: [{ source: '/dev/dri', target: '/dev/dri' }] }), 'dri');
  assert.equal(gpuAusDienst({ devices: ['/dev/dri/renderD128:/dev/dri/renderD128'] }), 'dri');
  assert.equal(gpuAusDienst({ deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: -1, capabilities: ['gpu'] }] } } } }), 'nvidia');
  assert.equal(gpuAusDienst({ runtime: 'nvidia' }), 'nvidia');
  assert.equal(gpuAusDienst({ devices: [{ source: '/dev/fuse' }] }), 'keine');
  const orig = { devices: [{ source: '/dev/fuse', target: '/dev/fuse', permissions: 'rwm' }], group_add: ['1000'], deploy: { resources: { limits: { memory: '1073741824' } } } };
  const dri = gpuUeberschreibung('dri', orig, { gids: { render: '991', video: '44' }, kfd: true });
  assert.deepEqual(dri.devices.map((d) => d.source), ['/dev/fuse', '/dev/dri', '/dev/kfd']);
  assert.deepEqual(dri.group_add, ['1000', '991', '44']);
  assert.equal(dri.deploy, undefined, 'ohne NVIDIA kein deploy anfassen');
  const nv = gpuUeberschreibung('nvidia', orig, {});
  assert.deepEqual(nv.devices.map((d) => d.source), ['/dev/fuse']);
  assert.equal(nv.deploy.resources.limits.memory, '1073741824', 'Grenzen bleiben');
  assert.deepEqual(nv.deploy.resources.reservations.devices, [{ driver: 'nvidia', count: 'all', capabilities: ['gpu', 'compute', 'utility', 'video'] }]);
  const zurueck = gpuUeberschreibung('keine', { ...orig, devices: [...orig.devices, { source: '/dev/dri', target: '/dev/dri' }], group_add: ['1000', '991'], deploy: nv.deploy }, { gids: { render: '991' } });
  assert.deepEqual(zurueck.devices.map((d) => d.source), ['/dev/fuse']); assert.deepEqual(zurueck.group_add, ['1000']);
  assert.deepEqual(zurueck.deploy.resources.reservations.devices, [], 'NVIDIA-Reservierung entfernt');
  assert.match(NVIDIA_SKRIPT, /ubuntu-drivers install/); assert.match(NVIDIA_SKRIPT, /nvidia-ctk runtime configure --runtime=docker/); assert.match(NVIDIA_SKRIPT, /signed-by=/);
});

const CONFIG = { services: { jellyfin: { image: 'jellyfin/jellyfin:10.11', ports: [{ target: 8096, published: '8096', protocol: 'tcp' }], volumes: [{ type: 'bind', source: '/data/apps/jellyfin/config', target: '/config' }], environment: { TZ: 'Europe/Berlin' } } } };

test('gpu: Editor – Wahl übernehmen, Anpassungsdatei nur bei Änderung', () => {
  const original = einstellungenAusConfig(CONFIG, { geheimnisseZeigen: true });
  assert.equal(original[0].gpu, 'keine');
  const ctx = { original, aktuell: original, appOrdner: '/data/apps/jellyfin', shares: '/data/shares' };
  const eingabe = (gpu) => [{ name: 'jellyfin', ports: original[0].ports, pfade: original[0].pfade, variablen: original[0].variablen, ...(gpu ? { gpu } : {}) }];
  assert.equal(anpassungPruefen(eingabe(), ctx)[0].gpu, 'keine', 'ohne Angabe bleibt der Stand');
  assert.equal(anpassungPruefen(eingabe('quatsch'), ctx)[0].gpu, 'keine');
  const d = anpassungPruefen(eingabe('dri'), ctx);
  const y = anpassungYaml(d, CONFIG, { gids: { render: '991', video: '44' } });
  assert.match(y, /devices: !override \[\{"source":"\/dev\/dri","target":"\/dev\/dri","permissions":"rwm"\}\]/);
  assert.match(y, /group_add: !override \["991","44"\]/);
  assert.ok(!/deploy:/.test(y));
  assert.ok(!/devices:/.test(anpassungYaml(anpassungPruefen(eingabe('keine'), ctx), CONFIG)), 'unverändert → keine Geräte-Zeilen');
  assert.match(anpassungYaml(anpassungPruefen(eingabe('nvidia'), ctx), CONFIG), /deploy: !override \{"resources":\{"reservations":\{"devices":\[\{"driver":"nvidia","count":"all"/);
});

test('gpu: Erkennung mit Schein-/sys und -/dev', async () => {
  const w0 = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-gpu-'));
  try {
    const sys = path.join(w0, 'sys'); const dev = path.join(w0, 'dev');
    const pci = path.join(sys, 'devices', 'pci0000:00', '0000:00:02.0');
    await fs.mkdir(pci, { recursive: true }); await fs.mkdir(path.join(sys, 'class', 'drm', 'card1'), { recursive: true });
    await fs.mkdir(path.join(sys, 'bus', 'pci', 'devices'), { recursive: true }); await fs.mkdir(path.join(sys, 'bus', 'pci', 'drivers', 'i915'), { recursive: true });
    await fs.symlink(pci, path.join(sys, 'class', 'drm', 'card1', 'device'));
    await fs.symlink(pci, path.join(sys, 'bus', 'pci', 'devices', '0000:00:02.0'));
    await fs.symlink(path.join(sys, 'bus', 'pci', 'drivers', 'i915'), path.join(pci, 'driver'));
    await fs.writeFile(path.join(sys, 'class', 'drm', 'card1', 'gt_cur_freq_mhz'), '350\n'); await fs.writeFile(path.join(sys, 'class', 'drm', 'card1', 'gt_RP0_freq_mhz'), '950\n');
    await fs.mkdir(path.join(dev, 'dri'), { recursive: true }); await fs.writeFile(path.join(dev, 'dri', 'card1'), ''); await fs.writeFile(path.join(dev, 'dri', 'renderD128'), '');
    process.env.FAHNAS_SYS = sys; process.env.FAHNAS_DEV = dev;
    const system = { ausfuehren: async (p, a) => {
      if (p === 'lspci') return { stdout: LSPCI.split('\n')[0] };
      if (p === 'docker' && a[0] === 'info') return { stdout: '{"runc":{}}' };
      if (p === 'docker' && a[0] === 'ps') return { stdout: 'abc\n' };
      if (p === 'docker' && a[0] === 'inspect') return { stdout: JSON.stringify([{ Name: '/jellyfin', State: { Running: true }, HostConfig: { Devices: [{ PathOnHost: '/dev/dri' }] } }]) };
      throw new Error(p);
    } };
    const g = await gpuLesen({ system });
    assert.equal(g.karten[0].treiber, 'i915'); assert.deepEqual(g.karten[0].takt, { aktuell: 350, max: 950 });
    assert.deepEqual(g.dri, { vorhanden: true, geraete: ['card1', 'renderD128'], kfd: false });
    assert.equal(g.nvidia.karte, false); assert.equal(g.nvidia.bereit, false);
    assert.deepEqual(g.apps.map((a) => a.app), ['jellyfin']);
  } finally { delete process.env.FAHNAS_SYS; delete process.env.FAHNAS_DEV; await fs.rm(w0, { recursive: true, force: true }); }
});

test('gpu: docker compose akzeptiert die Anpassungsdatei (echt, wenn Docker da ist)', async (t) => {
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); } catch { t.skip('docker compose fehlt'); return; }
  const w0 = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-gpu-compose-'));
  try {
    await fs.writeFile(path.join(w0, 'compose.yml'), 'services:\n  jellyfin:\n    image: jellyfin/jellyfin:10.11\n    ports: ["8096:8096"]\n    devices: ["/dev/fuse:/dev/fuse"]\n    deploy:\n      resources:\n        limits:\n          memory: 1g\n');
    const roh = JSON.parse(execFileSync('docker', ['compose', '-f', 'compose.yml', 'config', '--format', 'json'], { cwd: w0 }).toString());
    for (const [gpu, erwartet] of [['dri', 'dri'], ['nvidia', 'nvidia']]) {
      const original = einstellungenAusConfig(roh, { geheimnisseZeigen: true });
      const d = anpassungPruefen([{ ...original[0], gpu }], { original, aktuell: original, appOrdner: w0, shares: '/data/shares' });
      await fs.writeFile(path.join(w0, 'anpassung.yml'), anpassungYaml(d, roh, { gids: { render: '991', video: '44' } }));
      const neu = JSON.parse(execFileSync('docker', ['compose', '-f', 'compose.yml', '-f', 'anpassung.yml', 'config', '--format', 'json'], { cwd: w0 }).toString());
      const s = neu.services.jellyfin;
      assert.equal(gpuAusDienst(s), erwartet, `compose liest ${gpu}`);
      assert.ok(s.devices.some((x) => x.source === '/dev/fuse'), 'fremdes Gerät bleibt');
      if (gpu === 'nvidia') assert.ok(s.deploy.resources.limits.memory, 'Speichergrenze bleibt');
      else assert.deepEqual(s.group_add, ['991', '44']);
    }
  } finally { await fs.rm(w0, { recursive: true, force: true }); }
});
