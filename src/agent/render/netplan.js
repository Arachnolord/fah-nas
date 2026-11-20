// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Renderer für das Netz: schreibt /etc/netplan/90-fahnas.yaml (DHCP oder statische Adresse) als Text mit
// korrektem Einrücken, prüft alle Werte (IPv4/CIDR, DNS-Adressen), dann netplan generate + netplan apply.
// Schnittstellen werden über „ip -j link“ erkannt (im Test ersetzbar).

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

/** Feste DNS-Rückfälle bei DHCP – zusätzlich zu den Servern aus dem DHCP (Betreiber-Vorgabe). */
export const DNS_RUECKFALL = Object.freeze(['1.1.1.1', '8.8.8.8']);

export const DATEINAME = '90-fahnas.yaml';
const SCHNITTSTELLE_MUSTER = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,14}$/;

/** Ordner der netplan-Dateien, per FAHNAS_NETPLAN umbiegbar (Tests). */
export function netplanOrdner() { return process.env.FAHNAS_NETPLAN || '/etc/netplan'; }
export function netplanPfad() { return path.join(netplanOrdner(), DATEINAME); }

function pruefeIPv4(wert, feld) {
  if (typeof wert !== 'string' || net.isIPv4(wert) !== true) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“ ist keine gültige IPv4-Adresse (z. B. 192.168.1.10)`, { feld });
  }
  return wert;
}

/** Prüft „Adresse/Präfix“ (z. B. 192.168.1.50/24). */
export function pruefeCidr(wert, feld = 'netz.adresse') {
  if (typeof wert !== 'string' || !wert.includes('/')) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“ muss Adresse/Präfix sein (z. B. 192.168.1.10/24)`, { feld });
  }
  const [adresse, praefix] = wert.split('/');
  pruefeIPv4(adresse, feld);
  if (!/^\d{1,2}$/.test(praefix) || Number(praefix) < 1 || Number(praefix) > 32) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“: Präfix muss zwischen 1 und 32 liegen`, { feld });
  }
  return `${adresse}/${Number(praefix)}`;
}

/** Prüft eine DNS-Adresse (IPv4 oder IPv6). */
export function pruefeDns(wert, feld = 'netz.dns') {
  if (typeof wert !== 'string' || net.isIP(wert) === 0) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“: ${JSON.stringify(wert)} ist keine gültige IP-Adresse`, { feld });
  }
  return wert;
}

export function pruefeSchnittstelle(wert, feld = 'netz.schnittstelle') {
  if (typeof wert !== 'string' || !SCHNITTSTELLE_MUSTER.test(wert)) {
    throw new FahnasFehler('E_PARAMS', 'Schnittstellenname ungültig (z. B. enp1s0, eth0)', { feld });
  }
  return wert;
}

/**
 * Prüft die Netz-Einstellung aus system.json und gibt sie bereinigt zurück.
 * { modus:"dhcp"|"statisch", schnittstelle?, adresse?, gateway?, dns:[] }
 */
export function pruefeNetz(netz) {
  if (!netz || typeof netz !== 'object') throw new FahnasFehler('E_PARAMS', 'Netz-Einstellung fehlt', { feld: 'netz' });
  const modus = netz.modus ?? 'dhcp';
  if (!['dhcp', 'statisch'].includes(modus)) throw new FahnasFehler('E_PARAMS', 'Netz-Modus muss „dhcp“ oder „statisch“ sein', { feld: 'netz.modus' });
  const aus = { modus, schnittstelle: null, adresse: null, gateway: null, dns: [] };
  if (netz.schnittstelle !== undefined && netz.schnittstelle !== null && netz.schnittstelle !== '') aus.schnittstelle = pruefeSchnittstelle(netz.schnittstelle);
  if (Array.isArray(netz.dns)) aus.dns = netz.dns.filter((d) => d !== '' && d !== null && d !== undefined).map((d) => pruefeDns(d));
  else if (netz.dns !== undefined && netz.dns !== null) throw new FahnasFehler('E_PARAMS', 'DNS muss eine Liste sein', { feld: 'netz.dns' });
  if (aus.dns.length > 3) throw new FahnasFehler('E_PARAMS', 'Höchstens 3 DNS-Server', { feld: 'netz.dns' });
  if (modus === 'statisch') {
    if (!aus.schnittstelle) throw new FahnasFehler('E_PARAMS', 'Für eine feste Adresse musst du die Schnittstelle wählen', { feld: 'netz.schnittstelle' });
    aus.adresse = pruefeCidr(netz.adresse);
    if (netz.gateway !== undefined && netz.gateway !== null && netz.gateway !== '') aus.gateway = pruefeIPv4(netz.gateway, 'netz.gateway');
  }
  return aus;
}

/** Erzeugt den YAML-Text (zwei Leerzeichen je Ebene, nur Textbausteine – kein YAML-Paket nötig). */
export function netplanText(netzRoh) {
  const netz = pruefeNetz(netzRoh);
  const z = [];
  z.push('# Erzeugt von FAH-NAS – nicht von Hand ändern, Änderungen über die Oberfläche (System → Netz).');
  z.push('network:');
  z.push('  version: 2');
  z.push('  renderer: networkd');
  z.push('  ethernets:');
  if (netz.modus === 'dhcp') {
    if (netz.schnittstelle) {
      z.push(`    ${netz.schnittstelle}:`);
    } else {
      z.push('    fahnas-alle:');
      z.push('      match:');
      z.push('        name: "e*"');
    }
    z.push('      dhcp4: true');
    if (netz.dns.length) {
      z.push('      dhcp4-overrides:');
      z.push('        use-dns: false');
      z.push('      nameservers:');
      z.push('        addresses:');
      for (const d of netz.dns) z.push(`          - ${d}`);
    } else {
      // wie im Installer: DNS aus DHCP plus feste Rückfälle (Betreiber-Vorgabe 1.1.1.1 und 8.8.8.8)
      z.push('      nameservers:');
      z.push('        addresses:');
      for (const d of DNS_RUECKFALL) z.push(`          - ${d}`);
    }
  } else {
    z.push(`    ${netz.schnittstelle}:`);
    z.push('      dhcp4: false');
    z.push('      addresses:');
    z.push(`        - ${netz.adresse}`);
    if (netz.gateway) {
      z.push('      routes:');
      z.push('        - to: default');
      z.push(`          via: ${netz.gateway}`);
    }
    if (netz.dns.length) {
      z.push('      nameservers:');
      z.push('        addresses:');
      for (const d of netz.dns) z.push(`          - ${d}`);
    }
  }
  return z.join('\n') + '\n';
}

/**
 * Schreibt die netplan-Datei (0600, netplan verlangt das) und wendet sie an. Bei Fehlern bleibt die alte Datei
 * stehen und es fliegt E_RENDER mit der Ausgabe von netplan.
 * @returns {Promise<{pfad:string, geaendert:boolean}>}
 */
export async function rendereNetplan(netzRoh, o) {
  const text = netplanText(netzRoh);
  const pfad = o.pfad || netplanPfad();
  let alt = null;
  try { alt = await fs.readFile(pfad, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw FahnasFehler.aus(e); }
  if (alt === text && !o.erzwingen) return { pfad, geaendert: false };
  const tmp = `${pfad}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(pfad), { recursive: true });
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, pfad);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* egal */ }
    throw new FahnasFehler('E_RENDER', 'netplan-Datei konnte nicht geschrieben werden', { ausgabe: e.message });
  }
  try {
    await o.system.ausfuehren('netplan', ['generate']);
    await o.system.ausfuehren('netplan', ['apply']);
  } catch (e) {
    // alte Datei zurücklegen, damit das System in einem bekannten Zustand bleibt
    if (alt !== null) { try { await fs.writeFile(pfad, alt, { mode: 0o600 }); } catch { /* egal */ } } else { try { await fs.unlink(pfad); } catch { /* egal */ } }
    throw new FahnasFehler('E_RENDER', 'netplan hat die Netz-Einstellung abgelehnt', { ausgabe: e.details?.ausgabe || e.message });
  }
  return { pfad, geaendert: true };
}

/**
 * Erkennt Netzwerkschnittstellen über „ip -j link“ (JSON). Loopback und virtuelle Geräte (Docker, veth, Bridges,
 * Tailscale) werden ausgeblendet.
 * @returns {Promise<Array<{name:string, mac:string|null, zustand:"oben"|"unten"}>>}
 */
export async function schnittstellen(o) {
  let stdout;
  try { ({ stdout } = await o.system.ausfuehren('ip', ['-j', 'link'])); } catch (e) {
    throw new FahnasFehler('E_SYSTEM', 'Schnittstellen konnten nicht gelesen werden', { befehl: 'ip -j link', ausgabe: e.details?.ausgabe || e.message });
  }
  let liste;
  try { liste = JSON.parse(stdout || '[]'); } catch { throw new FahnasFehler('E_SYSTEM', 'Ausgabe von „ip -j link“ unlesbar', { befehl: 'ip -j link' }); }
  if (!Array.isArray(liste)) return [];
  return liste
    .filter((e) => e && typeof e.ifname === 'string' && e.link_type !== 'loopback' && e.ifname !== 'lo')
    .filter((e) => !/^(veth|docker|br-|virbr|tailscale|vnet|zt|wg|lxc|dummy)/.test(e.ifname))
    .map((e) => ({ name: e.ifname, mac: e.address || null, zustand: e.operstate === 'UP' ? 'oben' : 'unten' }));
}
