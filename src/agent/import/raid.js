// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// RAIDs übernommener Volumes (UGOS & Co.) verwalten: Zustand aus /sys lesen (ohne mdadm-Aufruf), Mitglieder zerlegen.
// UGOS legt die Daten-RAIDs auf Partition 2 jeder Platte an (Partition 1 = eigenes System) – beim Ersetzen bekommt die
// neue Platte deshalb zuerst die Partitionstabelle einer gesunden Platte (sgdisk --replicate, neue GUIDs), dann wird die
// passende Partition aufgenommen. Ein RAID1 mit nur einer Platte (UGOS-„Basis“) lässt sich so zum Spiegel erweitern.

import fs from 'node:fs/promises';
import path from 'node:path';

/** /dev/sda2 → {platte:'/dev/sda', nr:2}; /dev/nvme0n1p2 → {platte:'/dev/nvme0n1', nr:2}; ganze Platte → nr null. */
export function mitgliedZerlegen(geraet) {
  const g = String(geraet || '');
  let m = /^(\/dev\/(?:nvme\d+n\d+|mmcblk\d+|loop\d+))p(\d+)$/.exec(g);
  if (m) return { platte: m[1], nr: Number(m[2]) };
  m = /^(\/dev\/[a-z]+)(\d+)$/.exec(g);
  if (m) return { platte: m[1], nr: Number(m[2]) };
  return { platte: g, nr: null };
}

/** Partition Nummer `nr` einer Platte: /dev/sdb + 2 → /dev/sdb2, /dev/nvme1n1 + 2 → /dev/nvme1n1p2. */
export function partitionPfad(platte, nr) {
  return /\d$/.test(platte) ? `${platte}p${nr}` : `${platte}${nr}`;
}

async function lies(datei) { return String(await fs.readFile(datei, 'utf8').catch(() => '')).trim(); }

/**
 * Zustand eines md-RAIDs aus /sys/block/<md>/md: Stufe, Soll-/Ist-Platten, Mitglieder mit Zustand, laufender Abgleich.
 * → {md, stufe, platten_soll, degraded, sync, fortschritt (0–1|null), mitglieder:[{geraet, zustand:'ok'|'defekt'|'ersatz'|'aufbau'}]}
 */
export async function raidDetails(md, sysBlock = '/sys/block') {
  const name = path.basename(String(md || ''));
  const d = path.join(sysBlock, name, 'md');
  const stufe = await lies(path.join(d, 'level'));
  if (!stufe) return null;
  const mitglieder = [];
  for (const e of (await fs.readdir(d).catch(() => [])).filter((x) => x.startsWith('dev-')).sort()) {
    const z = await lies(path.join(d, e, 'state'));
    const zustand = /faulty/.test(z) ? 'defekt' : /spare/.test(z) ? (/in_sync/.test(z) ? 'ok' : 'aufbau') : /in_sync/.test(z) ? 'ok' : 'aufbau';
    mitglieder.push({ geraet: `/dev/${e.slice(4)}`, zustand });
  }
  const sync = (await lies(path.join(d, 'sync_action'))) || 'idle';
  const fertig = await lies(path.join(d, 'sync_completed'));
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(fertig);
  const deg = await lies(path.join(d, 'degraded'));
  return {
    md: `/dev/${name}`, stufe, platten_soll: Number(await lies(path.join(d, 'raid_disks'))) || null,
    degraded: deg !== '' && deg !== '0',
    sync, fortschritt: m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null, mitglieder,
  };
}

/** Gegen Datenverlust: Platten mit Spuren eines RAIDs, LVM, ZFS oder verschlüsselter Daten nie als Ersatz nehmen. */
const FREMD = /^(linux_raid_member|lvm2_member|zfs_member|crypto_LUKS|ddf_raid_member|isw_raid_member|LVM2_member)$/;

/** Trägt die Platte `name` (lsblk -J, mit FSTYPE) irgendwo Spuren eines anderen Speichers? → Beschreibung oder null. */
export function fremdeSpuren(lsblkJson, name) {
  const d = (lsblkJson?.blockdevices || []).find((x) => x && x.name === name);
  if (!d) return null;
  const alle = (x) => [x, ...(Array.isArray(x.children) ? x.children.flatMap((k) => (k ? alle(k) : [])) : [])];
  const fund = alle(d).find((x) => FREMD.test(String(x.fstype || '')));
  return fund ? `${fund.name}: ${fund.fstype}` : null;
}

/**
 * Was beim Ersetzen zu tun ist (aus raidDetails). `alt` = Mitglied, das raus soll (optional).
 * → {modus:'hinzufuegen'|'tauschen'|'spiegel', quelle:{platte,nr}, alt:geraet|null, platten_neu}
 * hinzufuegen = RAID ist beeinträchtigt, Platte fehlt schon; tauschen = defektes Mitglied raus, neues rein;
 * spiegel = vollständiges RAID 1 um eine Platte erweitern (UGOS-„Basis“ mit einer Platte → Spiegel).
 * Eine funktionierende Platte wird nie getauscht (sonst wäre das RAID während des Neuaufbaus ohne Reserve).
 */
export function ersatzPlan(d, { alt = null } = {}) {
  if (!d) throw new Error('RAID nicht gefunden');
  if (!/^raid(1|4|5|6|10)$/.test(d.stufe)) throw new Error(`${String(d.stufe).toUpperCase()} hat keine Ausfallsicherheit – hier lässt sich keine Platte ersetzen`);
  if (d.sync && d.sync !== 'idle') throw new Error(`Das RAID arbeitet gerade (${d.sync}) – bitte warten, bis es fertig ist`);
  let altM = null;
  if (alt) {
    altM = d.mitglieder.find((m) => m.geraet === alt);
    if (!altM) throw new Error(`${alt} gehört nicht zu diesem RAID`);
    if (altM.zustand === 'ok') throw new Error(`${alt} funktioniert – eine gesunde Platte tauscht FAH-NAS nicht (das RAID wäre sonst während des Neuaufbaus ohne Reserve)`);
  }
  const gesund = d.mitglieder.filter((m) => m.zustand === 'ok' && m.geraet !== alt);
  if (!gesund.length) throw new Error('Keine gesunde Platte mehr im RAID – ersetzen ist so nicht möglich');
  const quelle = mitgliedZerlegen(gesund[0].geraet);
  if (altM) return { modus: 'tauschen', quelle, alt: altM.geraet, platten_neu: d.platten_soll };
  if (d.degraded) return { modus: 'hinzufuegen', quelle, alt: null, platten_neu: d.platten_soll };
  if (d.stufe !== 'raid1') throw new Error('Das RAID ist vollständig – ersetzen geht erst, wenn eine Platte ausgefallen ist');
  return { modus: 'spiegel', quelle, alt: null, platten_neu: (d.platten_soll || gesund.length) + 1 };
}
