// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldung für WebDAV (rclone serve webdav --auth-proxy): liest {"user","pass"} von stdin, prüft das Passwort gegen
// users.json (derselbe Hash wie die Weboberfläche) und gibt die eigene Ansicht des Nutzers als lokales Ziel zurück.
// Falsches Passwort, gesperrtes oder unbekanntes Konto → Exit 1 (rclone lehnt die Anmeldung ab).

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../../gemeinsam/pfade.js';
import { MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';
import { hashPruefen } from '../totp.js';
import { ANSICHT_WURZEL } from './regeln.js';

/** Kern (für Tests ohne stdin): liefert die rclone-Konfiguration oder null. */
export async function anmelden(eingabe, { konfig = PFADE.konfig, wurzel = ANSICHT_WURZEL } = {}) {
  let e;
  try { e = JSON.parse(eingabe); } catch { return null; }
  const name = String(e && e.user || '');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name) && !MUSTER_NUTZERNAME.test(name) || typeof e.pass !== 'string') return null;
  let users;
  try { users = JSON.parse(await fs.readFile(path.join(konfig, 'users.json'), 'utf8')); } catch { return null; }
  const n = (users.nutzer || []).find((x) => x.name === name);
  const ok = await hashPruefen(e.pass.normalize('NFC'), n && !n.gesperrt ? n.hash : null);
  if (!ok || !n || n.gesperrt) return null;
  const ziel = path.join(wurzel, name);
  try { await fs.access(ziel); } catch { return null; }
  return { type: 'local', _root: ziel };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let daten = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (s) => { daten += s; if (daten.length > 65536) process.exit(1); });
  process.stdin.on('end', async () => {
    const r = await anmelden(daten).catch(() => null);
    if (!r) { process.stderr.write('Anmeldung abgelehnt\n'); process.exit(1); }
    process.stdout.write(JSON.stringify(r));
  });
}
