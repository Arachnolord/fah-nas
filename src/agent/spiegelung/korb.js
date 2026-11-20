// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung – Papierkorb. Je Freigabe (und je Laufwerk) gibt es genau einen: `.papierkorb` in der Wurzel, derselbe wie im
// Dateimanager. Ein Lauf legt dort einen Vorgang an (`spiegelung-<Auftrag>-<Stempel>`), die Pfade darin gelten ab der Wurzel
// der Freigabe – so bringt „Wiederherstellen“ die Dateien an ihren Platz zurück.

import fs from 'node:fs/promises';
import path from 'node:path';
import { einhaengung } from '../render/samba.js';
import { GRUPPE_NUTZER } from '../render/linuxnutzer.js';
import { PAPIERKORB, PAPIERKORB_TAGE, papierkorbAlt } from './regeln.js';

export const KORB = '.papierkorb';
const KORB_INFO = 'papierkorb.json';
const SAMBA_KORB = 'samba';
const MAX_EINTRAEGE = 1000;
const VORGANG = /^spiegelung-(s-[a-z0-9]+)-(\d{4}-\d{2}-\d{2}_\d{6})$/;
const DATEIMANAGER = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z(-\d+)?$/;

/** Orte eines Laufs. `seite` = {wurzel, voll}. `inhalt` ist der Zielordner im Vorgang, dorthin sichert rsync/unison. */
export function korbOrte(seite, id, stand) {
  const vorgang = path.join(seite.wurzel, KORB, `spiegelung-${id}-${stand}`);
  const rel = path.relative(seite.wurzel, seite.voll);
  return { vorgang, rel, inhalt: rel ? path.join(vorgang, rel) : vorgang };
}

/** Stände eines Auftrags aus den Namen im Papierkorb, neueste zuerst. */
export function korbStaende(namen, id) {
  return namen.map((n) => VORGANG.exec(n)).filter((m) => m && m[1] === id).map((m) => m[2]).sort().reverse();
}

async function dateienSammeln(ordner, rel = '', aus = []) {
  for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
    if (aus.length > MAX_EINTRAEGE) return aus;
    const p = path.join(ordner, e.name); const r = path.join(rel, e.name);
    if (e.isDirectory()) await dateienSammeln(p, r, aus);
    else { const st = await fs.lstat(p); aus.push({ pfad: r, name: e.name, art: st.isSymbolicLink() ? 'link' : 'datei', groesse: st.isFile() ? st.size : null }); }
  }
  return aus;
}

/**
 * Lauf abschließen: Hat er nichts abgelegt, verschwindet der Vorgang wieder. Sonst bekommt er die Beschreibung, die der
 * Dateimanager im Papierkorb anzeigt. Bei sehr vielen Dateien steht dort je oberster Ordner eine Zeile.
 */
export async function korbAbschliessen({ vorgang, inhalt, rel }, auftrag, jetzt, { system = null, extern = false } = {}) {
  let dateien;
  try { dateien = await dateienSammeln(inhalt); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!dateien.length) {
    for (let d = inhalt; d === vorgang || d.startsWith(`${vorgang}/`); d = path.dirname(d)) {
      try { await fs.rmdir(d); } catch { break; }
    }
    return false;
  }
  if (dateien.length > MAX_EINTRAEGE) {
    dateien = (await fs.readdir(inhalt, { withFileTypes: true })).map((e) => ({ pfad: e.name, name: e.name, art: e.isDirectory() ? 'ordner' : 'datei', groesse: null }));
  }
  const eintraege = dateien.map((d) => ({ ...d, pfad: rel ? path.join(rel, d.pfad) : d.pfad }));
  const info = { herkunft: rel, nutzer: `Spiegelung: ${auftrag.name || auftrag.id}`, zeit: jetzt.toISOString(), grund: 'spiegelung', eintraege };
  await fs.writeFile(path.join(vorgang, KORB_INFO), `${JSON.stringify(info, null, 2)}\n`);
  // Interne Freigaben: rsync läuft als root, Nutzer sollen den Vorgang im Dateimanager trotzdem zurückholen können
  if (!extern && system) {
    try {
      await system.ausfuehren('chgrp', ['-R', GRUPPE_NUTZER, vorgang]);
      await system.ausfuehren('chmod', ['-R', 'g+rwX', vorgang]);
    } catch { /* Anzeigen geht weiter, nur das Zurückholen bräuchte dann einen Admin */ }
  }
  return true;
}

/** Abgelaufene Stände dieses Auftrags löschen, dazu Altlasten im Zielordner (`.fah-papierkorb`). Gibt die Stände zurück. */
export async function korbAufraeumen(seite, auftrag, jetzt = new Date(), protokoll = null) {
  const tage = auftrag.versionen_tage || PAPIERKORB_TAGE;
  const korb = path.join(seite.wurzel, KORB);
  const staende = korbStaende(await fs.readdir(korb).catch(() => []), auftrag.id);
  const weg = papierkorbAlt(staende, jetzt, tage);
  for (const s of weg) await fs.rm(path.join(korb, `spiegelung-${auftrag.id}-${s}`), { recursive: true, force: true });
  const alt = path.join(seite.voll, PAPIERKORB);
  const altWeg = papierkorbAlt(await fs.readdir(alt).catch(() => []), jetzt, tage);
  for (const s of altWeg) await fs.rm(path.join(alt, s), { recursive: true, force: true });
  await fs.rmdir(alt).catch(() => {}); // noch junge Stände: erst beim nächsten Aufräumen
  const alle = [...weg, ...altWeg];
  if (alle.length && protokoll) protokoll.push(`Papierkorb: ${alle.length} Stände älter als ${tage} Tage gelöscht (${alle.join(', ')})`);
  return alle;
}

async function sambaAblaufen(ordner, grenze, weg, oberster = true) {
  let leer = true;
  for (const e of await fs.readdir(ordner, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(ordner, e.name);
    if (e.isDirectory()) { if (await sambaAblaufen(p, grenze, weg, false)) continue; leer = false; continue; }
    if ((await fs.lstat(p)).mtimeMs < grenze) { await fs.rm(p, { force: true }); weg.push(e.name); } else leer = false;
  }
  if (leer && !oberster) { await fs.rmdir(ordner).catch(() => {}); return true; }
  return false;
}

/**
 * Externe Laufwerke: alles im Papierkorb läuft nach 30 Tagen ab, sonst fräße er die Platte unbemerkt voll. Stände laufender
 * Aufträge bleiben außen vor, für sie gilt deren eigene Frist. Interne Freigaben behalten ihren Papierkorb, bis jemand leert.
 */
export async function externeKoerbeAufraeumen(w, daten, jetzt = new Date(), { eingehaengt = null } = {}) {
  const grenze = jetzt.getTime() - PAPIERKORB_TAGE * 86_400_000;
  const auftraege = new Set((daten?.auftraege || []).map((a) => a.id));
  const freigaben = (await w.konfig.laden('shares.json', { freigaben: [] }))?.freigaben || [];
  const weg = [];
  for (const f of freigaben) {
    if (!f?.extern) continue;
    const wurzel = path.join(w.pfade.shares, f.name);
    const da = eingehaengt ? await eingehaengt(wurzel) : (await einhaengung(w.system, wurzel)).eingehaengt;
    if (!da) continue;
    const korb = path.join(wurzel, KORB);
    for (const n of await fs.readdir(korb).catch(() => [])) {
      if (n === SAMBA_KORB) { await sambaAblaufen(path.join(korb, n), grenze, weg); continue; }
      const v = VORGANG.exec(n); const d = DATEIMANAGER.exec(n);
      const abgelaufen = v
        ? !auftraege.has(v[1]) && papierkorbAlt([v[2]], jetzt, PAPIERKORB_TAGE).length > 0
        : !!d && Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]) < grenze;
      if (abgelaufen) { await fs.rm(path.join(korb, n), { recursive: true, force: true }); weg.push(n); }
    }
  }
  return weg;
}
