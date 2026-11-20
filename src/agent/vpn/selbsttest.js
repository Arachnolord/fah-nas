// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// VPN-Selbsttest (Betreiber 12.10.2026: „selbsttest für freigegebene Ports … wenn blockiert genaue Info, was zu tun ist“).
// Bausteine ohne festen Systemzugriff (alles wird hineingereicht, damit die Einheitstests ohne Internet laufen):
// öffentliche IP, DNS von außen (DNS über HTTPS – der Heim-DNS kennt oft eine interne Antwort), Anschlussart aus
// tracepath (doppeltes NAT, Carrier-NAT, DS-Lite), Router-Erkennung über den Titel der Startseite, Test von außen über
// check-host.net (UDP-Pakete aus mehreren Ländern; das NAS merkt sich die Absender im nft-Set vpn_quellen) und die
// passende Anleitung für die Portweiterleitung.

import http from 'node:http';
import https from 'node:https';
import { ipZahl, istPrivat, istCgnat, istDsLite } from './wireguard.js';

const ZEIT_MS = 8000;

async function textHolen(holen, url, kopf = {}) {
  const r = await holen(url, { headers: kopf, signal: AbortSignal.timeout(ZEIT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Öffentliche IPv4 des Anschlusses (drei Dienste nacheinander) oder null. */
export async function oeffentlicheIp(holen) {
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://v4.ident.me']) {
    try { const t = (await textHolen(holen, url)).trim(); if (ipZahl(t) !== null) return t; } catch { /* nächster */ }
  }
  return null;
}

/** Hat der Anschluss IPv6 nach außen? (Hinweis bei DS-Lite) */
export async function oeffentlicheIp6(holen) {
  try { const t = (await textHolen(holen, 'https://api6.ipify.org')).trim(); return /^[0-9a-f:]+$/i.test(t) && t.includes(':') ? t : null; } catch { return null; }
}

/** A-Einträge so, wie ein Gerät unterwegs sie sieht (DNS über HTTPS; Cloudflare, dann Google). null = nicht ermittelbar. */
export async function dnsVonAussen(holen, name) {
  for (const url of [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`]) {
    try {
      const j = JSON.parse(await textHolen(holen, url, { Accept: 'application/dns-json' }));
      return (Array.isArray(j.Answer) ? j.Answer : []).filter((a) => a && a.type === 1 && ipZahl(a.data) !== null).map((a) => a.data);
    } catch { /* nächster */ }
  }
  return null;
}

/** tracepath-Ausgabe → Liste der Zwischenstationen [{nr, ip}] (je Nummer die erste Antwort). */
export function traceParsen(text) {
  const hops = new Map();
  for (const z of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\??:\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(z);
    if (m && !hops.has(Number(m[1]))) hops.set(Number(m[1]), m[2]);
  }
  return [...hops.entries()].sort((a, b) => a[0] - b[0]).map(([nr, ip]) => ({ nr, ip }));
}

/**
 * Anschlussart aus den Zwischenstationen: direkt (nach dem eigenen Router kommt gleich das Internet), doppelnat (ein
 * weiterer Router mit privater Adresse), cgnat (100.64.0.0/10 beim Anbieter), dslite (192.0.0.0/29), unbekannt.
 */
export function anschlussBewerten(hops, gateway) {
  const nach = hops.filter((h) => h.ip !== gateway && h.nr > 0);
  if (!hops.length) return { art: 'unbekannt' };
  let zweiter = null;
  for (const h of nach) {
    if (istDsLite(h.ip)) return { art: 'dslite', zweiter };
    if (istCgnat(h.ip)) return { art: 'cgnat', zweiter };
    if (istPrivat(h.ip)) { if (!zweiter) zweiter = h.ip; continue; }
    return { art: zweiter ? 'doppelnat' : 'direkt', zweiter, erste_oeffentliche: h.ip };
  }
  return { art: 'unbekannt', zweiter };
}

/** Titel der Startseite eines Routers (http, dann https ohne Zertifikatsprüfung – Router haben eigene Zertifikate). */
export function titelHolen(ip, zeit_ms = 3000) {
  const versuch = (modul, url) => new Promise((ok) => {
    const req = modul.get(url, { timeout: zeit_ms, rejectUnauthorized: false, headers: { 'User-Agent': 'FAH-NAS' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !url.startsWith('https')) { res.resume(); ok({ weiter: res.headers.location }); return; }
      let daten = ''; res.setEncoding('utf8');
      res.on('data', (s) => { daten += s; if (daten.length > 65536) req.destroy(); });
      res.on('end', () => ok({ text: daten })); res.on('error', () => ok({ text: daten }));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => ok(null));
  });
  return (async () => {
    let r = await versuch(http, `http://${ip}/`);
    if (!r || r.weiter || !r.text) r = (await versuch(https, `https://${ip}/`)) || r;
    const t = r && r.text ? /<title[^>]*>([^<]{0,200})<\/title>/i.exec(r.text) : null;
    return t ? t[1].trim() : (r && r.text ? r.text.slice(0, 2000) : '');
  })();
}

const ROUTER = [
  ['unifi', /unifi|ubiquiti/i, 'UniFi'], ['fritzbox', /fritz!?\s*box|avm/i, 'FRITZ!Box'], ['speedport', /speedport/i, 'Speedport'],
  ['vodafone', /vodafone|connectbox|connect box/i, 'Vodafone-Router'], ['openwrt', /openwrt|luci/i, 'OpenWrt'], ['opnsense', /opnsense/i, 'OPNsense'],
  ['pfsense', /pfsense/i, 'pfSense'], ['mikrotik', /mikrotik|routeros|webfig/i, 'MikroTik'], ['tplink', /tp-?link|archer|deco/i, 'TP-Link'],
  ['asus', /asus/i, 'ASUS'], ['netgear', /netgear|orbi/i, 'NETGEAR'], ['telekom', /telekom|digitalisierungsbox/i, 'Telekom-Router'],
];

/** Routertyp aus dem Seitentitel → {art, name} oder {art:null}. */
export function routerAusTitel(titel) {
  for (const [art, muster, name] of ROUTER) if (muster.test(String(titel || ''))) return { art, name };
  return { art: null, name: null };
}

/** Schritt-für-Schritt-Anleitung für die Portweiterleitung im erkannten Router. */
export function weiterleitungsAnleitung({ art, routerIp, port, nasIp }) {
  const ziel = `Protokoll UDP, externer Port ${port} → ${nasIp}, interner Port ${port}`;
  switch (art) {
    case 'unifi': return `UniFi Network öffnen (https://${routerIp} oder unifi.ui.com) → Einstellungen → Routing bzw. Policy Engine → Port Forwarding → „Erstellen“: Name „FAH-NAS VPN“, WAN-Port ${port}, Weiterleitungs-IP ${nasIp}, Weiterleitungs-Port ${port}, Protokoll UDP → Speichern.`;
    case 'fritzbox': return `FRITZ!Box öffnen (http://fritz.box) → Internet → Freigaben → Portfreigaben → „Gerät für Freigaben hinzufügen“ → Gerät mit ${nasIp} wählen → „Neue Freigabe“ → Portfreigabe: Protokoll UDP, Port an Gerät ${port} bis ${port}, Port extern gewünscht ${port} → OK → Übernehmen.`;
    case 'speedport': return `Speedport öffnen (http://speedport.ip) → Internet → Portfreischaltung → Port-Umleitungen → neue Regel: ${ziel} → Speichern.`;
    case 'vodafone': return `Router öffnen (http://${routerIp}) → Einstellungen → Sicherheit → Port-Weiterleitung → Hinzufügen: lokale IP ${nasIp}, Protokoll UDP, externer und lokaler Port ${port} → Übernehmen.`;
    case 'openwrt': return `LuCI öffnen (http://${routerIp}) → Netzwerk → Firewall → Portweiterleitungen → Hinzufügen: Protokoll UDP, externe Zone wan, externer Port ${port}, interne IP ${nasIp}, interner Port ${port} → Speichern & Anwenden.`;
    case 'opnsense': return `OPNsense öffnen (https://${routerIp}) → Firewall → NAT → Portweiterleitung → +: Schnittstelle WAN, Protokoll UDP, Ziel „WAN-Adresse“, Zielport ${port}, Weiterleitungsziel ${nasIp}, Port ${port}, Filterregel automatisch → Speichern → Änderungen anwenden.`;
    case 'pfsense': return `pfSense öffnen (https://${routerIp}) → Firewall → NAT → Port Forward → Add: Interface WAN, Protocol UDP, Destination „WAN address“, Port ${port}, Redirect target IP ${nasIp}, Port ${port} → Save → Apply Changes.`;
    case 'mikrotik': return `WinBox/WebFig (http://${routerIp}) → IP → Firewall → NAT → +: Chain dstnat, Protocol udp, Dst. Port ${port}, In. Interface = WAN, Action dst-nat, To Addresses ${nasIp}, To Ports ${port} → OK.`;
    case 'telekom': return `Router-Oberfläche öffnen (http://${routerIp}) → Netzwerk bzw. Internet → Portweiterleitung → neue Regel: ${ziel}.`;
    default: return `Router-Oberfläche öffnen (http://${routerIp}) und eine Portweiterleitung anlegen (heißt je nach Gerät auch „Portfreigabe“, „Port Forwarding“ oder „Virtueller Server“): ${ziel}.`;
  }
}

/** Anleitung für den vorderen Router bei doppeltem NAT (Ziel ist der eigene Router, nicht das NAS). */
export function vorneAnleitung({ art, ip, port }) {
  if (art === 'fritzbox') return `FRITZ!Box öffnen (http://fritz.box) → Internet → Freigaben → Portfreigaben → „Gerät für Freigaben hinzufügen“ → deinen Router auswählen → „Neue Freigabe“ → Portfreigabe: Protokoll UDP, Port ${port} bis ${port} – oder für deinen Router „Exposed Host“ aktivieren → OK → Übernehmen.`;
  return `Im vorderen Router (http://${ip}) eine Portweiterleitung UDP ${port} auf die WAN-Adresse deines Routers anlegen – oder deinen Router dort als „Exposed Host“ bzw. DMZ eintragen.`;
}

/** Absender im nft-Set vpn_quellen (JSON von „nft -j list set inet fahnas vpn_quellen“). */
export function quellenParsen(json) {
  const aus = new Set();
  try {
    for (const o of JSON.parse(json).nftables || []) {
      for (const e of (o.set && o.set.elem) || []) {
        const v = typeof e === 'string' ? e : e && e.elem ? e.elem.val : null;
        if (typeof v === 'string' && ipZahl(v) !== null) aus.add(v);
      }
    }
  } catch { /* leer */ }
  return aus;
}

/**
 * Test von außen über check-host.net: drei Prüfknoten senden UDP an ip:port. Danach zeigt das nft-Set, ob die Pakete am
 * NAS ankamen (WireGuard selbst antwortet auf fremde Pakete nie – deshalb zählt die Ankunft, nicht die Antwort).
 * @returns {Promise<{zustand:'ok'|'blockiert'|'unbekannt', knoten:Array<{ort,ip}>, angekommen:Array, fehler?:string}>}
 */
export async function aussenTest({ holen, ip, port, quellenLesen, warten = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const vorher = await quellenLesen();
  let j;
  try { j = JSON.parse(await textHolen(holen, `https://check-host.net/check-udp?host=${ip}:${port}&max_nodes=3`, { Accept: 'application/json' })); } catch (e) { return { zustand: 'unbekannt', knoten: [], angekommen: [], fehler: `Prüfdienst check-host.net nicht erreichbar (${e.message})` }; }
  if (!j || j.ok !== 1 || !j.request_id || !j.nodes) return { zustand: 'unbekannt', knoten: [], angekommen: [], fehler: 'Prüfdienst check-host.net hat den Auftrag abgelehnt (zu viele Tests? In einigen Minuten erneut versuchen)' };
  const knoten = Object.values(j.nodes).map((n) => ({ ort: [n[2], n[1]].filter(Boolean).join(', '), ip: n[3] }));
  for (let i = 0; i < 8; i++) {
    await warten(2500);
    try { const r = JSON.parse(await textHolen(holen, `https://check-host.net/check-result/${encodeURIComponent(j.request_id)}`, { Accept: 'application/json' })); if (r && Object.values(r).every((v) => v !== null)) break; } catch { /* weiter warten */ }
  }
  await warten(1000);
  const nachher = await quellenLesen();
  const neu = [...nachher].filter((q) => !vorher.has(q) && !istPrivat(q));
  const angekommen = knoten.filter((k) => nachher.has(k.ip));
  return { zustand: angekommen.length || neu.length ? 'ok' : 'blockiert', knoten, angekommen: angekommen.length ? angekommen : neu.map((q) => ({ ort: q, ip: q })) };
}
