// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Renderer für die Firewall (nftables): schreibt /etc/nftables.d/fahnas.nft mit der Tabelle „inet fahnas“,
// prüft sie mit „nft -c -f“ und lädt sie mit „nft -f“. Seit 12.10.2026 dauerhaft AUS (Betreiber: „die Firewall darf
// NIEMALS Dienste und Apps von FAH-NAS blockieren … deaktiviere sie dauerhaft“): eingehend wird nichts blockiert, ufw
// wird ausgeschaltet. Die Tabelle bleibt nur für das NAS-VPN (Selbsttest-Merker, Weiterleitung, NAT).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { firewallAngaben } from '../vpn/wireguard.js';
import { firewallPorts as protokollPorts } from '../protokolle/regeln.js';

/** Pfad der Regeldatei, per FAHNAS_NFT umbiegbar (Tests). */
export function nftPfad() { return process.env.FAHNAS_NFT || '/etc/nftables.d/fahnas.nft'; }

/** Ports, die der Kern ohnehin öffnet – App-Ports darauf werden nicht doppelt eingetragen. */
const KERN_PORTS = new Set(['8443/tcp', '445/tcp', '22/tcp', '5353/udp']); // 80/443 gehören Apps (FAH-Proxy)

/**
 * App-Ports aus dem Konfigurationsspiegel <konfig>/apps/<name>/app.json (Feld `ports:[{port, protokoll}]`) –
 * so überleben die Regeln der Apps jedes Rendern durch system.js (SSH-Schalter, system.apply), ohne dass system.js
 * die Apps kennen muss. Fehlende Ordner/Dateien ergeben eine leere Liste; kaputte Dateien werden übersprungen.
 * @returns {Promise<Array<{proto:"tcp"|"udp", port:number, kommentar:string}>>}
 */
export async function appPortsLesen(konfigOrdner = PFADE.konfig) {
  const ordner = path.join(konfigOrdner, 'apps');
  let namen = [];
  try { namen = (await fs.readdir(ordner)).sort(); } catch { return []; }
  const aus = [];
  for (const n of namen) {
    let d;
    try { d = JSON.parse(await fs.readFile(path.join(ordner, n, 'app.json'), 'utf8')); } catch { continue; }
    for (const p of Array.isArray(d && d.ports) ? d.ports : []) {
      const port = Number(p && p.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      aus.push({ proto: p.protokoll === 'udp' ? 'udp' : 'tcp', port, kommentar: `App ${d.name || n}` });
    }
  }
  return zusatzZusammenfuehren([], aus);
}

/**
 * VPN-Angaben aus <konfig>/vpn.json (WireGuard-Server, Ausbau Oktober 2026) – wie die App-Ports liest der Renderer sie
 * selbst, damit jedes Rendern (SSH-Schalter, system.apply, Apps) die VPN-Regeln behält. Fehlt die Datei oder ist das VPN
 * aus → null.
 */
export async function vpnLesen(konfigOrdner = PFADE.konfig) {
  try { return firewallAngaben(JSON.parse(await fs.readFile(path.join(konfigOrdner, 'vpn.json'), 'utf8'))); } catch { return null; }
}

/** Ports der Protokolle NFS/WebDAV/DLNA aus <konfig>/protokolle.json (fehlt die Datei → keine). */
/** SMB an? (protokolle.json smb.aktiv, Standard an) */
export async function smbLesen(konfigOrdner = PFADE.konfig) {
  try { const j = JSON.parse(await fs.readFile(path.join(konfigOrdner, 'protokolle.json'), 'utf8')); return !(j && j.smb && j.smb.aktiv === false); } catch { return true; }
}

/** SSH-Port aus system.json (Standard 22) – nur für die Übersicht der Regeln, die Firewall sperrt nichts. */
export async function sshPortLesen(konfigOrdner = PFADE.konfig) {
  try { const j = JSON.parse(await fs.readFile(path.join(konfigOrdner, 'system.json'), 'utf8')); return Number.isInteger(j?.ssh_port) ? j.ssh_port : 22; } catch { return 22; }
}

export async function protokollPortsLesen(konfigOrdner = PFADE.konfig) {
  try { return protokollPorts(JSON.parse(await fs.readFile(path.join(konfigOrdner, 'protokolle.json'), 'utf8'))); } catch { return []; }
}

/**
 * Grundregelwerk älterer Installationen (/etc/nftables.conf aus dem Erststart, gilt ab Systemstart) entschärfen:
 * „policy drop“ → „policy accept“, „ct state invalid drop“ weg. Gibt true zurück, wenn etwas geändert wurde.
 */
export async function grundregelwerkEntschaerfen(datei = process.env.FAHNAS_NFT_GRUND || '/etc/nftables.conf') {
  let alt;
  try { alt = await fs.readFile(datei, 'utf8'); } catch { return false; }
  const neu = alt.replace(/(type filter hook input priority (?:0|filter);) policy drop;/g, '$1 policy accept;').replace(/\n[ \t]*ct state invalid drop[^\n]*/g, '');
  if (neu === alt) return false;
  await fs.writeFile(`${datei}.neu`, neu, { mode: 0o644 });
  await fs.rename(`${datei}.neu`, datei);
  return true;
}

/** Ubuntus eigene Firewall (ufw) darf nichts blockieren – ist sie an, wird sie ausgeschaltet (system.apply beim Start). */
export async function ufwAus(system) {
  try { const u = await system.ausfuehren('ufw', ['status'], { erlaubteCodes: [0, 1] }); if (/Status:\s*active/i.test(String(u.stdout))) { await system.ausfuehren('ufw', ['--force', 'disable']); return true; } } catch { /* ufw nicht installiert */ }
  return false;
}

const nftName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '');
const ipListe = (l) => `{ ${l.join(', ')} }`;

/** Vereinigt Zusatzports (Duplikate und Kern-Ports fallen weg; Liste sortiert nach Port). */
export function zusatzZusammenfuehren(...listen) {
  const karte = new Map();
  for (const l of listen) for (const e of Array.isArray(l) ? l : []) {
    if (!e) continue;
    const proto = e.proto === 'udp' || e.protokoll === 'udp' ? 'udp' : 'tcp';
    const port = Number(e.port);
    const k = `${port}/${proto}`;
    if (!Number.isInteger(port) || KERN_PORTS.has(k) || karte.has(k)) continue;
    karte.set(k, { proto, port, kommentar: e.kommentar || (e.app ? `App ${e.app}` : '') });
  }
  return [...karte.values()].sort((a, b) => a.port - b.port || (a.proto < b.proto ? -1 : 1));
}

/**
 * Erzeugt den Regeltext.
 * @param {{ssh:boolean, zusatz?:Array<{proto:"tcp"|"udp", port:number, kommentar?:string}>}} o
 */
export function nftText(o = {}) {
  const vpn = o.vpn || null;
  const ssh = o.ssh !== false;
  const z = [];
  z.push('#!/usr/sbin/nft -f');
  z.push('# Erzeugt von FAH-NAS – nicht von Hand ändern. Eingebunden aus /etc/nftables.conf.');
  z.push('# Firewall dauerhaft aus (Betreiber 12.10.2026): eingehend wird nichts blockiert. Nur NAS-VPN: Selbsttest, Weiterleitung, NAT.');
  z.push('');
  z.push('table inet fahnas');
  z.push('flush table inet fahnas');
  z.push('');
  z.push('table inet fahnas {');
  z.push('  # Absender am VPN-Port der letzten 30 Minuten (Selbsttest „von außen erreichbar?“); Definition nie ändern.');
  z.push('  set vpn_quellen { type ipv4_addr; size 1024; flags dynamic,timeout; timeout 30m; }');
  z.push('');
  z.push('  chain input {');
  // Betreiber 12.10.2026: „die in ubuntu laufende firewall darf NIEMALS dienste und apps von fah-nas blockieren“ →
  // „deaktiviere sie doch einfach dauerhaft“: policy accept, keine drop-Regel. Die Port-Regeln unten bleiben nur als
  // Übersicht stehen (sperren nichts); der Selbsttest-Merker des NAS-VPN braucht die Tabelle weiter.
  z.push('    type filter hook input priority 0; policy accept;');
  z.push('    # Firewall dauerhaft aus – eingehend wird nichts blockiert (Schutz übernimmt der Router). Die Regeln sind nur eine Übersicht.');
  z.push('');
  z.push('    iif "lo" accept comment "Loopback"');
  z.push('    ct state established,related accept comment "Antworten auf eigene Verbindungen"');
  z.push('    meta l4proto icmp accept comment "Ping, Pfad-MTU"');
  z.push('    meta l4proto ipv6-icmp accept comment "IPv6-Nachbarschaft"');
  z.push('    ip protocol igmp accept comment "IGMP: Multicast-Mitgliedschaft (mDNS hinter Switches mit IGMP-Snooping)"');
  z.push('    iifname "virbr*" accept comment "libvirt-Bruecke: DHCP, DNS, TFTP fuer VMs"');
  z.push('');
  z.push('    tcp dport 8443 accept comment "Weboberflaeche"');
  if (o.smb !== false) z.push('    tcp dport 445 accept comment "SMB2/3 (Freigaben, Time Machine)"');
  else z.push('    # SMB (445/tcp) ist ausgeschaltet – einschalten unter System → Zugriff & Sicherheit → Protokolle');
  const sshPort = Number.isInteger(o.ssh_port) && o.ssh_port > 0 && o.ssh_port < 65536 ? o.ssh_port : 22;
  if (ssh) z.push(`    tcp dport ${sshPort} accept comment "SSH (in der Oberflaeche abschaltbar)"`);
  else z.push(`    # SSH (${sshPort}/tcp) ist ausgeschaltet – einschalten unter System → Dienste`);
  z.push('    udp dport 5353 accept comment "Avahi/mDNS (Bonjour-Ankuendigung)"');
  if (vpn) {
    const port = Number(vpn.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FahnasFehler('E_PARAMS', `VPN-Port ${vpn.port} ungültig`, { feld: 'port' });
    z.push('');
    z.push(`    udp dport ${port} meta nfproto ipv4 add @vpn_quellen { ip saddr } comment "VPN-Selbsttest: Absender merken"`);
    z.push(`    udp dport ${port} accept comment "WireGuard-VPN"`);
    z.push(`    iifname "${nftName(vpn.schnittstelle)}" accept comment "VPN-Geraete erreichen das NAS"`);
  }
  z.push('');
  z.push('    # NetBIOS (137/138/udp, 139/tcp) bleibt zu: FAH-NAS spricht nur SMB2/3.');
  const zusatz = Array.isArray(o.zusatz) ? o.zusatz : [];
  if (zusatz.length) {
    z.push('');
    z.push('    # Erweiterungen (Apps, VMs, Fernzugriff)');
    for (const e of zusatz) {
      const proto = e.proto === 'udp' ? 'udp' : 'tcp';
      const port = Number(e.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FahnasFehler('E_PARAMS', `Firewall-Port ${e.port} ungültig`, { feld: 'zusatz' });
      const k = e.kommentar ? ` comment "${String(e.kommentar).replace(/["\\\n\r]/g, '')}"` : '';
      z.push(`    ${proto} dport ${port} accept${k}`);
    }
  } else {
    z.push('    # Erweiterungen für Apps (Teilprojekt 2), VMs (3) und Fernzugriff (4) werden hier ergänzt.');
  }
  z.push('  }');
  if (vpn) {
    const wg = nftName(vpn.schnittstelle);
    const netz = String(vpn.netz).replace(/[^0-9./]/g, '');
    const lan = (vpn.lan || []).map((n) => String(n).replace(/[^0-9./]/g, '')).filter(Boolean);
    const heim = (vpn.heimnetz || []).map((ip) => String(ip).replace(/[^0-9.]/g, '')).filter(Boolean);
    const alles = (vpn.alles || []).map((ip) => String(ip).replace(/[^0-9.]/g, '')).filter(Boolean);
    z.push('');
    z.push('  # WireGuard-VPN: Weiterleitung nur fuer VPN-Geraete; policy accept, damit Docker/libvirt unberuehrt bleiben.');
    z.push('  chain forward {');
    z.push('    type filter hook forward priority 0; policy accept;');
    z.push(`    iifname "${wg}" ct status dnat accept comment "VPN -> App-Ports des NAS"`);
    if (heim.length && lan.length) z.push(`    iifname "${wg}" ip saddr ${ipListe(heim)} ip daddr ${ipListe(lan)} accept comment "Zugriff: NAS + Heimnetz"`);
    if (alles.length) z.push(`    iifname "${wg}" ip saddr ${ipListe(alles)} accept comment "Zugriff: alles (auch Internet)"`);
    z.push(`    iifname "${wg}" drop comment "sonst nichts aus dem VPN weiterleiten"`);
    z.push(`    oifname "${wg}" ct state established,related accept`);
    z.push(`    oifname "${wg}" drop comment "keine neuen Verbindungen zu VPN-Geraeten"`);
    z.push('  }');
    z.push('');
    z.push('  chain postrouting {');
    z.push('    type nat hook postrouting priority srcnat; policy accept;');
    z.push(`    ip saddr ${netz} oifname != "${wg}" masquerade comment "VPN-Geraete erscheinen im Netz als das NAS"`);
    z.push('  }');
  }
  z.push('}');
  return z.join('\n') + '\n';
}

/**
 * Schreibt die Regeldatei, prüft sie mit nft -c -f, lädt sie mit nft -f. Schlägt die Prüfung fehl, bleibt die
 * alte Datei stehen (E_RENDER mit Ausgabe).
 *
 * App-Ports (Teilprojekt 2): ohne `zusatzPorts` liest der Renderer sie selbst aus dem Konfigurationsspiegel
 * (`appPortsLesen(konfigOrdner)`) – so bleiben sie bei jedem Aufruf aus system.js (SSH-Schalter, system.apply)
 * erhalten. apps.js übergibt nach Änderungen die frische Liste als `zusatzPorts: [{port, protokoll, app}]`
 * (gewinnt gegen den Spiegel; `[]` = keine App-Ports). `o.zusatz` (VMs, Fernzugriff) wird immer dazugenommen.
 * @returns {Promise<{pfad:string, geaendert:boolean, zusatz:Array}>}
 */
export async function rendereFirewall(o, { system, pfad, erzwingen, zusatzPorts, konfigOrdner } = {}) {
  const apps = Array.isArray(zusatzPorts) ? zusatzPorts : await appPortsLesen(konfigOrdner);
  const zusatz = zusatzZusammenfuehren(o && o.zusatz, apps, await protokollPortsLesen(konfigOrdner));
  const vpn = o && 'vpn' in o ? o.vpn : await vpnLesen(konfigOrdner);
  const smb = o && 'smb' in o ? o.smb : await smbLesen(konfigOrdner);
  const ssh_port = o && 'ssh_port' in o ? o.ssh_port : await sshPortLesen(konfigOrdner);
  const text = nftText({ ...(o || {}), zusatz, vpn, smb, ssh_port });
  const ziel = pfad || nftPfad();
  let alt = null;
  try { alt = await fs.readFile(ziel, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw FahnasFehler.aus(e); }
  const neu = `${ziel}.neu`;
  try {
    await fs.mkdir(path.dirname(ziel), { recursive: true });
    await fs.writeFile(neu, text, { mode: 0o644 });
  } catch (e) {
    throw new FahnasFehler('E_RENDER', 'Firewall-Regeln konnten nicht geschrieben werden', { ausgabe: e.message });
  }
  try {
    await system.ausfuehren('nft', ['-c', '-f', neu]);
  } catch (e) {
    try { await fs.unlink(neu); } catch { /* egal */ }
    throw new FahnasFehler('E_RENDER', 'nft hat die Firewall-Regeln abgelehnt', { ausgabe: e.details?.ausgabe || e.message });
  }
  if (alt === text && !erzwingen) {
    try { await fs.unlink(neu); } catch { /* egal */ }
    // Datei unverändert – trotzdem laden, damit der laufende Kern den Stand hat (idempotent)
    try { await system.ausfuehren('nft', ['-f', ziel]); } catch (e) {
      throw new FahnasFehler('E_RENDER', 'Firewall-Regeln konnten nicht geladen werden', { ausgabe: e.details?.ausgabe || e.message });
    }
    return { pfad: ziel, geaendert: false, zusatz };
  }
  await fs.rename(neu, ziel);
  try {
    await system.ausfuehren('nft', ['-f', ziel]);
  } catch (e) {
    if (alt !== null) { try { await fs.writeFile(ziel, alt, { mode: 0o644 }); } catch { /* egal */ } }
    throw new FahnasFehler('E_RENDER', 'Firewall-Regeln konnten nicht geladen werden', { ausgabe: e.details?.ausgabe || e.message });
  }
  return { pfad: ziel, geaendert: true, zusatz };
}
