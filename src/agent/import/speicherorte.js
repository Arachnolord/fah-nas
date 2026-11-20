// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Speicherorte (Betreiber 19.10.2026): Docker, Apps und VMs wahlweise auf einem übernommenen Volume statt auf der
// Systemplatte (UGREEN: Docker-Images ~200 GB passen nicht auf die 128-GB-Systemplatte, gehören auf die Samsung 980).
// Die Pfade bleiben gleich (/var/lib/docker, /data/apps, /data/vms) – darüber liegt ein Bind-Mount auf
// <volume>/@fahnas/<bereich>. Der Systemstand (/data/@docker …) bleibt darunter unangetastet (Rückweg).
// Beim Start hängt fahnas-speicherorte.service (speicherorte-start.js) alles ein, BEVOR Docker/libvirt starten; fehlt
// das Volume, starten sie nicht (docker.service Requires=) – so landet nie etwas aus Versehen auf der Systemplatte.

import fs from 'node:fs/promises';
import path from 'node:path';
import { kurzVon } from './erkennen.js';

export const BEREICHE = Object.freeze(['docker', 'apps', 'vms']);
export const DATEI = 'speicherorte.json';
export const UMZUG_MARKE = '.fahnas-umzug';
export const UNIT = 'fahnas-speicherorte.service';
/** Dienste, die vor dem Bereich warten (Drop-in mit Requires/After). */
export const DIENSTE = Object.freeze({ docker: ['docker.service'], apps: ['docker.service'], vms: ['libvirtd.service'] });

export function zielPfad(pfade, bereich) {
  if (bereich === 'docker') return pfade.docker || '/var/lib/docker';
  if (bereich === 'apps') return pfade.apps || '/data/apps';
  if (bereich === 'vms') return pfade.vms || '/data/vms';
  throw new Error(`Unbekannter Bereich ${bereich}`);
}
/** Stand auf der Systemplatte: Unterlaufwerk @<bereich> im Top-Level der Datenpartition (/data). */
export function systemOrt(pfade, bereich) { return path.join(pfade.daten || '/data', `@${bereich}`); }
export function volumePfad(pfade, uuid) { return path.join(pfade.importe || '/data/import', kurzVon(uuid)); }
export function volumeOrt(pfade, uuid, bereich) { return path.join(volumePfad(pfade, uuid), '@fahnas', bereich); }

/** speicherorte.json → {docker:{volume,seit}|null, apps:…, vms:…} */
export function normieren(d) {
  const aus = {};
  for (const b of BEREICHE) {
    const e = d && d[b];
    aus[b] = e && typeof e.volume === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(e.volume) ? { volume: e.volume, seit: e.seit || null } : null;
  }
  return aus;
}

/** Zeigt `ziel` gerade den Ordner `quelle` (gleiches Gerät, gleicher Inode)? */
export async function zeigtAuf(ziel, quelle) {
  try {
    const [a, b] = await Promise.all([fs.stat(ziel), fs.stat(quelle)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

/** Unit-Text für den Start (die Unit liegt im Programm unter systemd/, hier nur für Drop-ins). */
export function dropinText() {
  return [
    '# Von FAH-NAS (Speicherorte) angelegt: erst den Speicher auf dem übernommenen Volume einhängen.',
    '# Fehlt das Volume, startet dieser Dienst nicht – nichts landet aus Versehen auf der Systemplatte.',
    '[Unit]',
    `Requires=${UNIT}`,
    `After=${UNIT}`,
    '',
  ].join('\n');
}

/**
 * Alles einhängen, was speicherorte.json verlangt: RAID/LVM zusammensetzen, Volume einhängen, Bind-Mount je Bereich.
 * `system.ausfuehren`, `pfade`, `orte` (normiert), `volumes` (importe.json). → {fehler:[], gebunden:[]}
 */
export async function bereitstellen({ system, pfade, orte, volumes, wartenMs = 90_000 }) {
  const aus = { fehler: [], gebunden: [] };
  const noetig = BEREICHE.filter((b) => orte[b]);
  if (!noetig.length) return aus;
  try { await system.ausfuehren('mdadm', ['--assemble', '--scan'], { erlaubteCodes: [0, 1, 2], zeitlimit_ms: 120_000 }); } catch { /* nichts zu tun */ }
  try { await system.ausfuehren('vgchange', ['-ay'], { erlaubteCodes: [0, 5], zeitlimit_ms: 120_000 }); } catch { /* kein LVM */ }
  for (const b of noetig) {
    const uuid = orte[b].volume;
    const vol = (volumes || []).find((v) => v.uuid === uuid);
    const ziel = zielPfad(pfade, b);
    const quelle = volumeOrt(pfade, uuid, b);
    try {
      if (!vol) throw new Error(`Volume ${uuid} ist nicht (mehr) übernommen`);
      const vp = volumePfad(pfade, uuid);
      if (!(await eingehaengtPfad(system, vp))) {
        const bis = Date.now() + wartenMs;
        while (!(await fs.access(`/dev/disk/by-uuid/${uuid}`).then(() => true, () => false))) {
          if (Date.now() > bis) throw new Error(`Volume ${uuid} erscheint nicht (Platten gesteckt?)`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        await fs.mkdir(vp, { recursive: true, mode: 0o700 });
        await system.ausfuehren('mount', ['-o', 'noatime', `UUID=${uuid}`, vp], { zeitlimit_ms: 180_000 });
      }
      if (await zeigtAuf(ziel, quelle)) continue;
      const st = await fs.lstat(quelle).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error(`${quelle} fehlt auf dem Volume`);
      await fs.mkdir(ziel, { recursive: true });
      await system.ausfuehren('mount', ['--bind', quelle, ziel]);
      aus.gebunden.push(b);
    } catch (e) { aus.fehler.push(`${b}: ${e.message}`); }
  }
  return aus;
}

async function eingehaengtPfad(system, pfad) {
  try {
    const r = await system.ausfuehren('findmnt', ['-n', '-o', 'TARGET', '--mountpoint', pfad], { erlaubteCodes: [0, 1], zeitlimit_ms: 10_000 });
    return String(r.stdout).trim().split('\n').includes(pfad);
  } catch { return false; }
}
