// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „gpu.*“ (Ausbau Oktober 2026): Grafikkarten erkennen (Intel/AMD über /dev/dri, NVIDIA über Treiber +
// Container-Toolkit), Auslastung bzw. Takt für die Kachel, welche Apps sie nutzen, und NVIDIA mit einem Klick einrichten.
// Die Zuordnung zu einer App geschieht im App-Editor (apps.einstellungen.speichern, Feld „gpu“ je Dienst).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { lspciParsen, nvidiaSmiParsen, gpuNutzer, NVIDIA_SKRIPT } from '../helfer/gpu.js';

const SYS = () => process.env.FAHNAS_SYS || '/sys';
const DEV = () => process.env.FAHNAS_DEV || '/dev';
const NVIDIA_ABFRAGE = ['--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'];

async function lesenZahl(p) { try { const n = Number((await fs.readFile(p, 'utf8')).trim()); return Number.isFinite(n) ? n : null; } catch { return null; } }

/** Takt (Intel) bzw. Auslastung (AMD) je DRM-Karte, zugeordnet über die PCI-Adresse. */
async function drmWerte() {
  const aus = new Map();
  let namen = [];
  try { namen = (await fs.readdir(path.join(SYS(), 'class', 'drm'))).filter((n) => /^card\d+$/.test(n)); } catch { return aus; }
  for (const n of namen) {
    const basis = path.join(SYS(), 'class', 'drm', n);
    let adresse = null;
    try { adresse = path.basename(await fs.realpath(path.join(basis, 'device'))); } catch { continue; }
    const aktuell = await lesenZahl(path.join(basis, 'gt_cur_freq_mhz'));
    const max = (await lesenZahl(path.join(basis, 'gt_RP0_freq_mhz'))) ?? (await lesenZahl(path.join(basis, 'gt_max_freq_mhz')));
    const last = await lesenZahl(path.join(basis, 'device', 'gpu_busy_percent'));
    aus.set(adresse, { karte: n, takt: aktuell !== null && max ? { aktuell, max } : null, auslastung: last });
  }
  return aus;
}

/** Gesamtbild der Grafikkarten (wirft nie – fehlende Werkzeuge ergeben leere Felder). */
export async function gpuLesen(w) {
  const sys = w.system;
  let karten = [];
  try { karten = lspciParsen((await sys.ausfuehren('lspci', ['-mm', '-nn', '-D'])).stdout); } catch { /* lspci fehlt */ }
  const drm = await drmWerte();
  for (const k of karten) {
    try { k.treiber = path.basename(await fs.readlink(path.join(SYS(), 'bus', 'pci', 'devices', k.adresse, 'driver'))); } catch { k.treiber = null; }
    const d = drm.get(k.adresse);
    k.takt = d ? d.takt : null; k.auslastung = d ? d.auslastung : null;
  }
  let dri = [];
  try { dri = (await fs.readdir(path.join(DEV(), 'dri'))).filter((n) => /^(card|renderD)\d+$/.test(n)).sort(); } catch { /* keine */ }
  let kfd = false; try { await fs.access(path.join(DEV(), 'kfd')); kfd = true; } catch { /* nein */ }
  const nvidiaKarte = karten.some((k) => k.hersteller === 'nvidia');
  let smi = [];
  if (nvidiaKarte) { try { smi = nvidiaSmiParsen((await sys.ausfuehren('nvidia-smi', NVIDIA_ABFRAGE, { zeitlimit_ms: 15_000 })).stdout); } catch { smi = []; } }
  let toolkit = false;
  if (nvidiaKarte) { try { await sys.ausfuehren('nvidia-ctk', ['--version'], { zeitlimit_ms: 10_000 }); toolkit = true; } catch { toolkit = false; } }
  let runtimes = {};
  try { runtimes = JSON.parse((await sys.ausfuehren('docker', ['info', '--format', '{{json .Runtimes}}'], { zeitlimit_ms: 20_000 })).stdout || '{}') || {}; } catch { /* Docker fehlt */ }
  let apps = [];
  try {
    const ids = String((await sys.ausfuehren('docker', ['ps', '-aq'], { zeitlimit_ms: 20_000 })).stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (ids.length) apps = gpuNutzer(JSON.parse((await sys.ausfuehren('docker', ['inspect', ...ids], { zeitlimit_ms: 30_000 })).stdout || '[]'));
  } catch { /* egal */ }
  const nvidiaDocker = Object.prototype.hasOwnProperty.call(runtimes, 'nvidia');
  return {
    karten,
    dri: { vorhanden: dri.length > 0, geraete: dri, kfd },
    nvidia: { karte: nvidiaKarte, treiber: smi.length > 0, smi, toolkit, docker: nvidiaDocker, bereit: smi.length > 0 && nvidiaDocker },
    apps,
  };
}

export function registriere(reg, w) {
  reg.aktion('gpu.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Grafikkarten, Treiber, Auslastung und Apps mit GPU',
    ausfuehren: async () => gpuLesen(w),
  });

  reg.aktion('gpu.nvidia_einrichten', {
    rolle: 'admin', aufgabe: true, schema: {}, beschreibung: 'NVIDIA-Treiber und Container-Toolkit installieren, Docker dafür einrichten',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      const vorher = await gpuLesen(w);
      if (!vorher.nvidia.karte) throw new FahnasFehler('E_PARAMS', 'Es ist keine NVIDIA-Grafikkarte eingebaut');
      aufgabe?.fortschritt(0.1, 'Treiber und Container-Toolkit werden installiert (das dauert einige Minuten) …');
      const unit = `fahnas-nvidia-${Date.now()}`;
      try {
        await w.system.ausfuehren('systemd-run', [`--unit=${unit}`, '--wait', '--collect', '--quiet', '/bin/sh', '-c', NVIDIA_SKRIPT], { zeitlimit_ms: 45 * 60_000, umgebung: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } });
      } catch (e) {
        const f = FahnasFehler.aus(e);
        throw new FahnasFehler('E_SYSTEM', `NVIDIA-Einrichtung fehlgeschlagen – Einzelheiten: journalctl -u ${unit}`, { ausgabe: f.details?.ausgabe || f.message });
      }
      aufgabe?.fortschritt(0.95, 'Prüfen');
      const nachher = await gpuLesen(w);
      w.konfigGeaendert?.('gpu');
      return { ...nachher.nvidia, neustart_noetig: !nachher.nvidia.treiber };
    },
  });
}
