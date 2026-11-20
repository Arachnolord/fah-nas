// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übernommene Volumes einhängen: das Volume einmal unter /data/import/<kurz> (root 0700), jeder übernommene Ordner per
// Bind-Mount als Freigabe unter /data/shares/<name>; auf btrfs-Unterlaufwerken zusätzlich die Schnappschuss-Ablage
// <volume>/@fahnas-schnappschuesse/<name> unter /data/.snapshots/<name> (gleiches Dateisystem → btrfs-Schnappschüsse gehen).
// Leere Einhängepunkte sind unveränderlich (chattr +i), damit bei fehlendem Volume nichts auf der Systemplatte landet.
// Bind-Quellen werden ohne Verknüpfungen geöffnet (ordnerGriff) – nichts landet versehentlich außerhalb des Volumes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { eingehaengt } from '../render/samba.js';
import { ansichtenLoesen } from '../aktionen/protokolle.js';
import { ordnerGriff, griffPfad } from '../freigaben/ordnerrechte-abgleich.js';
import { kurzVon } from './erkennen.js';

export const SCHNAPP_ORDNER = '@fahnas-schnappschuesse';
const OPTIONEN = 'noatime';

const p = (w) => w.pfade || PFADE;
export function importWurzel(w) { return p(w).importe || PFADE.importe; }
export function volumePfad(w, uuid) { return path.join(importWurzel(w), kurzVon(uuid)); }
const sharesPfad = (w) => p(w).shares || PFADE.shares;
const snapPfad = (w) => p(w).snapshots || PFADE.snapshots;

/** RAIDs zusammensetzen und LVM aktivieren (beides darf „nichts zu tun“ melden). */
export async function speicherAktivieren(w) {
  try { await w.system.ausfuehren('mdadm', ['--assemble', '--scan'], { erlaubteCodes: [0, 1, 2], zeitlimit_ms: 120_000 }); } catch { /* kein mdadm/nichts zu tun */ }
  try { await w.system.ausfuehren('vgchange', ['-ay'], { erlaubteCodes: [0, 5], zeitlimit_ms: 120_000 }); } catch { /* kein LVM */ }
}

/** Leeren Einhängepunkt anlegen und sperren (wie beim Verbund). */
async function punktAnlegen(w, ziel, modus = 0o755) {
  await fs.mkdir(ziel, { recursive: true, mode: modus });
  try { await w.system.ausfuehren('chattr', ['+i', ziel]); } catch { /* Dateisystem ohne Attribute */ }
}

async function punktEntfernen(w, ziel) {
  if (await eingehaengt(w.system, ziel)) return;
  try { await w.system.ausfuehren('chattr', ['-i', ziel]); } catch { /* egal */ }
  await fs.rmdir(ziel).catch(() => {});
}

/** Volume (lesend + schreibend) unter /data/import/<kurz> einhängen. Gibt den Pfad zurück. */
export async function volumeEinhaengen(w, uuid) {
  const ziel = volumePfad(w, uuid);
  if (await eingehaengt(w.system, ziel)) return ziel;
  await fs.mkdir(importWurzel(w), { recursive: true, mode: 0o700 });
  await fs.chmod(importWurzel(w), 0o700).catch(() => {});
  await punktAnlegen(w, ziel, 0o700);
  await w.system.ausfuehren('mount', ['-o', OPTIONEN, `UUID=${uuid}`, ziel], { zeitlimit_ms: 180_000 });
  return ziel;
}

/** Volume nur lesend unter /run/fahnas/import-probe/<kurz> einhängen (Suche). → {pfad, loesen()} */
export async function probeEinhaengen(w, uuid, fstype) {
  const ziel = path.join(p(w).run || PFADE.run, 'import-probe', kurzVon(uuid));
  await fs.mkdir(ziel, { recursive: true, mode: 0o700 });
  // xfs ohne Log-Wiedergabe, ext4/btrfs schlicht nur lesend (sauber ausgehängte Volumes brauchen keine Wiedergabe)
  const optionen = fstype === 'xfs' ? 'ro,norecovery' : 'ro';
  await w.system.ausfuehren('mount', ['-o', optionen, `UUID=${uuid}`, ziel], { zeitlimit_ms: 120_000 });
  return {
    pfad: ziel,
    loesen: async () => {
      try { await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 60_000 }); } catch { await w.system.ausfuehren('umount', ['-l', ziel]).catch(() => {}); }
      await fs.rmdir(ziel).catch(() => {});
    },
  };
}

/**
 * Übernommenen Ordner als Freigabe einhängen: Bind-Mount <volume>/<ordner> → /data/shares/<name>; mit `schnappschuesse`
 * zusätzlich die Ablage <volume>/@fahnas-schnappschuesse/<name> → /data/.snapshots/<name>.
 */
export async function ordnerEinhaengen(w, uuid, ordner, name, { schnappschuesse = false } = {}) {
  if (!ordner || ordner.includes('/') || ordner === '.' || ordner === '..') throw new FahnasFehler('E_PARAMS', 'Ordnername ungültig', { feld: 'ordner' });
  const vol = volumePfad(w, uuid);
  const ziel = path.join(sharesPfad(w), name);
  if (!(await eingehaengt(w.system, ziel))) {
    const fh = await ordnerGriff(vol, ordner);
    if (!fh) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Ordner „${ordner}“ fehlt auf dem Volume`, { feld: 'ordner', wert: ordner });
    try {
      await punktAnlegen(w, ziel);
      await w.system.ausfuehren('mount', ['--no-canonicalize', '--bind', griffPfad(fh), ziel]);
    } finally { await fh.close().catch(() => {}); }
  }
  if (!schnappschuesse) return;
  const ablage = path.join(snapPfad(w), name);
  if (await eingehaengt(w.system, ablage)) return;
  const basis = path.join(vol, SCHNAPP_ORDNER);
  try { await fs.lstat(basis); } catch { await w.system.ausfuehren('btrfs', ['subvolume', 'create', basis]); await fs.chmod(basis, 0o700).catch(() => {}); }
  await fs.mkdir(path.join(basis, name), { recursive: true, mode: 0o755 });
  const fh = await ordnerGriff(vol, `${SCHNAPP_ORDNER}/${name}`);
  if (!fh) throw new FahnasFehler('E_SYSTEM', 'Schnappschuss-Ablage auf dem Volume ist kein echter Ordner', { feld: 'ordner' });
  try {
    await fs.mkdir(snapPfad(w), { recursive: true, mode: 0o751 });
    await punktAnlegen(w, ablage);
    await w.system.ausfuehren('mount', ['--no-canonicalize', '--bind', griffPfad(fh), ablage]);
  } finally { await fh.close().catch(() => {}); }
}

/** Freigabe eines übernommenen Ordners lösen (Daten bleiben auf dem Volume): Ansichten, Schnappschuss-Ablage, Ordner. */
export async function freigabeLoesen(w, name) {
  for (const ziel of [path.join(snapPfad(w), name), path.join(sharesPfad(w), name)]) {
    try { await ansichtenLoesen(w, ziel); } catch { /* keine Ansichten */ }
    if (await eingehaengt(w.system, ziel)) await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 60_000 });
    await punktEntfernen(w, ziel);
  }
}

/** Alter Pfad eines Volumes (UGOS: /volume1 …) – damit Compose-Dateien und Skripte vom alten NAS unverändert laufen. */
export const ALTER_PFAD = /^\/volume\d{1,2}$/;
const altWurzel = (w) => p(w).alteWurzel || '/';
export function alterPfadZiel(w, alterPfad) { return path.join(altWurzel(w), alterPfad); }

/** Volume zusätzlich unter seinem alten Pfad bereitstellen (Bind-Mount, Einhängepunkt gesperrt). */
export async function alterPfadEinhaengen(w, uuid, alterPfad) {
  if (!ALTER_PFAD.test(String(alterPfad || ''))) throw new FahnasFehler('E_PARAMS', `Alter Pfad „${alterPfad}“ ungültig (erlaubt: /volume1 … /volume99)`, { feld: 'alter_pfad' });
  const ziel = alterPfadZiel(w, alterPfad);
  if (await eingehaengt(w.system, ziel)) return ziel;
  const da = await fs.readdir(ziel).catch(() => null);
  if (da && da.length) throw new FahnasFehler('E_BELEGT', `Unter ${alterPfad} liegen schon Dateien – der alte Pfad wird nicht darübergelegt`, { feld: 'alter_pfad' });
  await punktAnlegen(w, ziel);
  await w.system.ausfuehren('mount', ['--bind', volumePfad(w, uuid), ziel]);
  return ziel;
}

export async function alterPfadLoesen(w, alterPfad) {
  if (!ALTER_PFAD.test(String(alterPfad || ''))) return;
  const ziel = alterPfadZiel(w, alterPfad);
  if (await eingehaengt(w.system, ziel)) await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 60_000 });
  await punktEntfernen(w, ziel);
}

/** Gültiger Quellordner eines persönlichen Ordners auf dem alten Volume: „@home/<name>“ (UGOS) oder „homes/<name>“. */
export const HEIM_QUELLE = /^(?:@home|homes)\/[^/\0]{1,255}$/;

/**
 * Persönlichen Ordner vom alten NAS an den FAH-NAS-Platz binden: <volume>/@home/<name> → <daten>/homes/<name>. Nie
 * verschieben, nie kopieren – die Daten bleiben, wo sie sind. Liegen am Platz schon Dateien, wird nichts darübergelegt.
 */
export async function heimEinhaengen(w, quelle, ziel) {
  const rel = String(quelle?.ordner || '');
  if (!HEIM_QUELLE.test(rel) || rel.split('/').some((t) => t === '.' || t === '..')) throw new FahnasFehler('E_PARAMS', `Quellordner „${rel}“ ungültig`, { feld: 'ordner' });
  if (await eingehaengt(w.system, ziel)) return;
  const vol = volumePfad(w, quelle.volume);
  if (!(await eingehaengt(w.system, vol))) throw new FahnasFehler('E_BELEGT', 'Das Volume des alten NAS ist nicht eingehängt', { feld: 'volume' });
  const da = await fs.readdir(ziel).catch(() => null);
  if (da && da.length) throw new FahnasFehler('E_BELEGT', `Am Platz ${ziel} liegen schon Dateien – der alte Ordner wird nicht darübergelegt`, { feld: 'ordner' });
  const fh = await ordnerGriff(vol, rel);
  if (!fh) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Ordner „${rel}“ fehlt auf dem Volume`, { feld: 'ordner', wert: rel });
  try {
    await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o755 });
    await punktAnlegen(w, ziel, 0o700);
    await w.system.ausfuehren('mount', ['--no-canonicalize', '--bind', griffPfad(fh), ziel]);
  } finally { await fh.close().catch(() => {}); }
}

/** Gebundenen persönlichen Ordner lösen (Daten bleiben auf dem alten Volume). */
export async function heimLoesen(w, ziel) {
  if (await eingehaengt(w.system, ziel)) await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 60_000 });
  await punktEntfernen(w, ziel);
}

/** Leeren (gesperrten) Einhängepunkt entfernen – nur, wenn er wirklich leer ist. */
export async function leererPunktWeg(w, ziel) {
  const da = await fs.readdir(ziel).catch(() => null);
  if (!da || da.length) return false;
  await punktEntfernen(w, ziel);
  return true;
}

/** Volume aushängen (nur, wenn keine Freigabe mehr darauf zeigt – prüft der Aufrufer). */
export async function volumeAushaengen(w, uuid) {
  const ziel = volumePfad(w, uuid);
  if (await eingehaengt(w.system, ziel)) await w.system.ausfuehren('umount', [ziel], { zeitlimit_ms: 120_000 });
  await punktEntfernen(w, ziel);
}
