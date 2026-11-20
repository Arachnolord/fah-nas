// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Renderer für den Rechnernamen: hostnamectl set-hostname + Pflege der Zeile „127.0.1.1 <name>“ in /etc/hosts.
// Idempotent: nur wenn sich etwas unterscheidet, wird geschrieben bzw. hostnamectl gerufen.

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const HOSTNAME_MUSTER = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Prüft einen Rechnernamen (RFC 1123, ein Label, max. 63 Zeichen). */
export function pruefeHostname(name) {
  if (typeof name !== 'string' || !HOSTNAME_MUSTER.test(name)) {
    throw new FahnasFehler('E_PARAMS', 'Rechnername: 1–63 Zeichen aus a-z, 0-9 und -, nicht mit - beginnen oder enden', { feld: 'hostname' });
  }
  return name.toLowerCase();
}

/** Standardpfad der hosts-Datei, in Tests per FAHNAS_HOSTS umbiegbar. */
export function hostsPfad() { return process.env.FAHNAS_HOSTS || '/etc/hosts'; }

/**
 * Erzeugt den neuen Text der hosts-Datei: die Zeile 127.0.1.1 wird ersetzt oder hinter 127.0.0.1 eingefügt.
 * Gibt {text, geaendert} zurück.
 */
export function hostsText(alt, hostname) {
  const neu = `127.0.1.1\t${hostname}`;
  const zeilen = (alt ?? '').split('\n');
  let gefunden = false;
  const aus = zeilen.map((z) => {
    if (/^\s*127\.0\.1\.1\s/.test(z)) {
      gefunden = true;
      return neu;
    }
    return z;
  });
  if (!gefunden) {
    const i = aus.findIndex((z) => /^\s*127\.0\.0\.1\s/.test(z));
    if (i >= 0) aus.splice(i + 1, 0, neu); else aus.unshift(neu);
  }
  let text = aus.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return { text, geaendert: text !== (alt ?? '') };
}

/**
 * Setzt den Rechnernamen im System.
 * @param {string} hostname
 * @param {{system:object, hosts?:string, aktuell?:string}} o  system = Kapselung (ausfuehren), hosts = Pfad der hosts-Datei
 * @returns {Promise<{hostname:string, geaendert:boolean}>}
 */
export async function rendereHostname(hostname, o) {
  const name = pruefeHostname(hostname);
  const aktuell = (o.aktuell ?? os.hostname()).split('.')[0].toLowerCase();
  let geaendert = false;
  if (aktuell !== name) {
    try {
      await o.system.ausfuehren('hostnamectl', ['set-hostname', name]);
    } catch (e) {
      throw new FahnasFehler('E_RENDER', 'Rechnername konnte nicht gesetzt werden', { ausgabe: e.details?.ausgabe || e.message });
    }
    geaendert = true;
  }
  const pfad = o.hosts || hostsPfad();
  let alt = null;
  try { alt = await fs.readFile(pfad, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw FahnasFehler.aus(e); }
  const { text, geaendert: hostsGeaendert } = hostsText(alt ?? '127.0.0.1\tlocalhost\n', name);
  if (hostsGeaendert || alt === null) {
    try {
      await fs.mkdir(path.dirname(pfad), { recursive: true });
      const tmp = `${pfad}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, { mode: 0o644 });
      await fs.rename(tmp, pfad);
    } catch (e) {
      throw new FahnasFehler('E_RENDER', 'hosts-Datei konnte nicht geschrieben werden', { ausgabe: e.message });
    }
    geaendert = true;
  }
  return { hostname: name, geaendert };
}
