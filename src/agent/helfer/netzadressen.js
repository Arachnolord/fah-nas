// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// IP-Adressen für die Weltkarte: einheitliche Schreibweise, private/interne Netze (bekommen keinen Ort, die Karte
// bündelt sie als „Heimnetz“) und bekannte Anycast-Adressen (liegen überall zugleich – kein sinnvoller Ort).
// Dazu die eigene Adresse des NAS im Heimnetz (Apps: {NAS_IP}/{NAS_GATEWAY}, Freigaben: smb://<IP>/<name>).

import net from 'node:net';
import os from 'node:os';

/**
 * Einheitliche Schreibweise: IPv4 wie gehabt, IPv4-Abbild (::ffff:a.b.c.d) → IPv4, Zonen-ID weg, IPv6 kanonisch
 * verkürzt und klein. Kein gültiges IP → null.
 */
export function ipNormal(ip) {
  if (typeof ip !== 'string') return null;
  let a = ip.trim();
  const zone = a.indexOf('%'); if (zone >= 0) a = a.slice(0, zone);
  const abbild = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (abbild) a = abbild[1];
  const art = net.isIP(a);
  if (art === 4) return a;
  if (art !== 6) return null;
  const kanonisch = new URL(`http://[${a}]/`).hostname.slice(1, -1); // WHATWG: RFC-5952-Kurzform, klein
  const abbild2 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(kanonisch); // ::ffff:808:808 → 8.8.8.8
  if (abbild2) {
    const h = parseInt(abbild2[1], 16); const l = parseInt(abbild2[2], 16);
    return `${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`;
  }
  return kanonisch;
}

const PRIVAT = new net.BlockList();
for (const [netz, praefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVAT.addSubnet(netz, praefix, 'ipv4');
for (const [netz, praefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVAT.addSubnet(netz, praefix, 'ipv6');

/** Privat/intern (RFC1918, CGNAT/VPN 100.64/10, Loopback, Link-Local, Multicast, reserviert, ULA). Unsinn → false. */
export function istPrivat(ip) {
  const a = ipNormal(ip);
  if (!a) return false;
  return PRIVAT.check(a, net.isIP(a) === 4 ? 'ipv4' : 'ipv6');
}

/** Öffentliche DNS-Anycast-Adressen (Cloudflare, Google, Quad9, Cisco OpenDNS, AdGuard). */
export const ANYCAST = new Set(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222',
  '208.67.220.220', '94.140.14.14', '94.140.15.15', '2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888',
  '2001:4860:4860::8844', '2620:fe::fe', '2620:fe::9']);

export function istAnycast(ip) {
  const a = ipNormal(ip);
  return !!a && ANYCAST.has(a);
}

/**
 * Netz des NAS: Quelladresse und Router der Standardroute (`ip -4 route get 1.1.1.1`), Rückfall: erste IPv4 einer
 * echten Schnittstelle (ohne Docker-, Brücken-, VM- und VPN-Schnittstellen).
 * @param {{ausfuehren: Function}} system
 * @returns {Promise<{ip:string|null, gateway:string|null}>}
 */
export async function nasNetz(system) {
  const aus = { ip: null, gateway: null };
  try {
    const r = await system.ausfuehren('ip', ['-4', 'route', 'get', '1.1.1.1'], { zeitlimit_ms: 5000 });
    const src = /\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(String(r.stdout));
    const via = /\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(String(r.stdout));
    if (src) aus.ip = src[1];
    if (via) aus.gateway = via[1];
  } catch { /* Rückfall unten */ }
  if (!aus.ip) {
    for (const [n, liste] of Object.entries(os.networkInterfaces())) {
      if (/^(lo|docker|br-|veth|virbr|tun|wg)/.test(n)) continue;
      const a = (liste || []).find((x) => x.family === 'IPv4' && !x.internal);
      if (a) { aus.ip = a.address; break; }
    }
  }
  return aus;
}
