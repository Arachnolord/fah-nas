// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// TLS-Zertifikat des Web-Dienstes: liegt in /data/config/web/tls/{cert.pem,key.pem}. Fehlt es, wird ein
// selbstsigniertes Zertifikat (EC prime256v1, 10 Jahre, SAN Hostname + .local + IPs) über openssl erzeugt.
// Schlüssel 0600. Später ersetzt Teilprojekt 4 die Dateien durch ein Tailscale-Zertifikat.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ausfuehren, existiert } from '../gemeinsam/system.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

const HOSTNAME_ERLAUBT = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,62})$/;

/** Bereinigter Hostname (nur Label-Zeichen), Rückfall „fahnas“. */
export function hostnameBereinigt(name = os.hostname()) {
  const kurz = String(name || '').split('.')[0];
  return HOSTNAME_ERLAUBT.test(kurz) ? kurz : 'fahnas';
}

/** Alle nicht-internen IP-Adressen (IPv4 und globale IPv6) für den SAN-Eintrag. */
export function netzAdressen(schnittstellen) {
  if (schnittstellen === undefined) { try { schnittstellen = os.networkInterfaces(); } catch { schnittstellen = {}; } } // z. B. ohne AF_NETLINK in der Sandbox
  const aus = [];
  for (const liste of Object.values(schnittstellen || {})) {
    for (const e of liste || []) {
      if (e.internal) continue;
      if (e.family === 'IPv6' || e.family === 6) { if (/^fe80:/i.test(e.address)) continue; aus.push(e.address.split('%')[0]); } else aus.push(e.address);
    }
  }
  return [...new Set(aus)];
}

/** Argumentliste für openssl (getrennt, damit Tests sie prüfen können). */
export function opensslArgumente({ hostname, ips = [], tage = 3650, schluessel, zertifikat }) {
  const san = [`DNS:${hostname}`, `DNS:${hostname}.local`, ...ips.map((ip) => `IP:${ip}`)].join(',');
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(tage),
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=${san}`, '-keyout', schluessel, '-out', zertifikat];
}

/**
 * Stellt sicher, dass cert.pem und key.pem in `ordner` liegen; erzeugt sie sonst.
 * @returns {Promise<{cert:Buffer, key:Buffer, neu:boolean}>}
 */
export async function zertifikatSicherstellen(ordner, { hostname = hostnameBereinigt(), ips = netzAdressen(), tage = 3650 } = {}) {
  const zertifikat = path.join(ordner, 'cert.pem');
  const schluessel = path.join(ordner, 'key.pem');
  let neu = false;
  if (!(await existiert(zertifikat)) || !(await existiert(schluessel))) {
    await fs.mkdir(ordner, { recursive: true, mode: 0o700 });
    const host = hostnameBereinigt(hostname);
    const sichereIps = ips.filter((ip) => /^[0-9a-fA-F.:]+$/.test(ip));
    await ausfuehren('openssl', opensslArgumente({ hostname: host, ips: sichereIps, tage, schluessel, zertifikat }), { zeitlimit_ms: 60_000 });
    if (!(await existiert(zertifikat)) || !(await existiert(schluessel))) {
      throw new FahnasFehler('E_SYSTEM', 'openssl hat kein Zertifikat erzeugt', { befehl: 'openssl req' });
    }
    neu = true;
  }
  try { await fs.chmod(schluessel, 0o600); } catch { /* fremdes Dateisystem */ }
  try { await fs.chmod(zertifikat, 0o644); } catch { /* egal */ }
  const [cert, key] = await Promise.all([fs.readFile(zertifikat), fs.readFile(schluessel)]);
  return { cert, key, neu };
}
