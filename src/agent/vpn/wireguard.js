// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// WireGuard-VPN-Server (Betreiber 12.10.2026) – reine Funktionen ohne Systemzugriff:
// Schlüssel (X25519 aus node:crypto, kein „wg genkey“ nötig), Netze/Adressen, Server- und Gerätekonfiguration,
// Auswertung von „wg show <if> dump“ und die Firewall-Angaben für den nft-Renderer.
// Zugriff je Gerät: „nas“ = nur das NAS, „heimnetz“ = NAS + eigenes LAN, „alles“ = auch Internet über das NAS.

import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const SCHNITTSTELLE = 'wg-fahnas';
export const ZUGRIFF = Object.freeze(['nas', 'heimnetz', 'alles']);
export const STANDARD_PORT = 51821;               // 51820 belegt oft schon der Router (UniFi-/FritzBox-WireGuard)
export const STANDARD_NETZ = '10.149.27.0/24';    // ungewöhnlich – kollidiert kaum mit Heim-, Hotel- oder Docker-Netzen
export const VERBUNDEN_MS = 3 * 60_000;           // WireGuard erneuert den Handshake alle 2 Minuten

export const STANDARD = Object.freeze({
  version: 1, aktiv: false, port: STANDARD_PORT, netz: STANDARD_NETZ, adresse: '', dns: '',
  server: { privat: '', oeffentlich: '' }, lan_netze: [], nas_ip: '', geraete: [], selbsttest: null,
});

// ---- Schlüssel --------------------------------------------------------------------------------------------------
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Neues Schlüsselpaar (Base64 wie bei „wg genkey | wg pubkey“). */
export function schluesselpaar() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { privat: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), oeffentlich: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
}

/** Öffentlicher Schlüssel zu einem privaten (wie „wg pubkey“). */
export function oeffentlichAus(privat) {
  const roh = Buffer.from(String(privat), 'base64');
  if (roh.length !== 32) throw new FahnasFehler('E_PARAMS', 'WireGuard-Schlüssel ungültig');
  const k = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, roh]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(k).export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

/** Vorab geteilter Schlüssel (zusätzliche Schutzschicht je Gerät). */
export const vorabSchluessel = () => crypto.randomBytes(32).toString('base64');

export const istSchluessel = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(s);

// ---- Adressen ---------------------------------------------------------------------------------------------------
export function ipZahl(ip) {
  const t = String(ip).split('.');
  if (t.length !== 4 || t.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return t.reduce((s, x) => s * 256 + Number(x), 0);
}
export const zahlIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** CIDR → {basis, praefix, erste, letzte} (Zahlen) oder null. */
export function cidr(text) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const ip = ipZahl(m[1]); const praefix = Number(m[2]);
  if (ip === null || praefix > 32) return null;
  const groesse = 2 ** (32 - praefix);
  const basis = Math.floor(ip / groesse) * groesse;
  return { basis, praefix, erste: basis, letzte: basis + groesse - 1, text: `${zahlIp(basis)}/${praefix}` };
}

export const imNetz = (ip, netz) => { const n = typeof netz === 'string' ? cidr(netz) : netz; const z = ipZahl(ip); return !!n && z !== null && z >= n.erste && z <= n.letzte; };
export const ueberschneiden = (a, b) => { const x = cidr(a); const y = cidr(b); return !!x && !!y && x.erste <= y.letzte && y.erste <= x.letzte; };

const PRIVAT = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const istPrivat = (ip) => PRIVAT.some((n) => imNetz(ip, n));
export const istCgnat = (ip) => imNetz(ip, '100.64.0.0/10');
export const istDsLite = (ip) => imNetz(ip, '192.0.0.0/29');

/**
 * VPN-Netz prüfen: privat, /16–/29, keine Überschneidung mit Netzen des NAS (LAN, Docker, libvirt).
 * @returns {string} normierte Schreibweise
 */
export function netzPruefen(text, belegt = []) {
  const n = cidr(text);
  if (!n || n.praefix < 16 || n.praefix > 29) throw new FahnasFehler('E_PARAMS', 'VPN-Netz bitte als z. B. 10.149.27.0/24 angeben (Präfix /16 bis /29)', { feld: 'netz' });
  if (!PRIVAT.some((p) => imNetz(zahlIp(n.erste), p) && imNetz(zahlIp(n.letzte), p))) throw new FahnasFehler('E_PARAMS', 'VPN-Netz muss ein privates Netz sein (10.x, 172.16–31.x oder 192.168.x)', { feld: 'netz' });
  const kollision = belegt.find((b) => ueberschneiden(n.text, b));
  if (kollision) throw new FahnasFehler('E_PARAMS', `VPN-Netz überschneidet sich mit ${kollision}, das das NAS schon nutzt – bitte ein anderes wählen`, { feld: 'netz' });
  return n.text;
}

export const serverIp = (netz) => zahlIp(cidr(netz).erste + 1);

/** Nächste freie Geräteadresse (ab .2). */
export function naechsteIp(netz, belegt) {
  const n = cidr(netz); const frei = new Set(belegt);
  for (let z = n.erste + 2; z < n.letzte; z++) { const ip = zahlIp(z); if (!frei.has(ip)) return ip; }
  throw new FahnasFehler('E_PARAMS', 'Im VPN-Netz ist keine Adresse mehr frei', { feld: 'netz' });
}

/** Adresse von außen: Hostname oder IPv4 (ohne Port). */
export function adressePruefen(text) {
  const a = String(text || '').trim().toLowerCase();
  if (!a) return '';
  if (ipZahl(a) !== null) return a;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(a)) throw new FahnasFehler('E_PARAMS', 'Adresse von außen: bitte einen Namen wie meinname.dyndns.org oder eine IPv4-Adresse eintragen', { feld: 'adresse' });
  return a;
}

/** DNS-Liste (nur IPv4, höchstens drei). */
export function dnsPruefen(text) {
  const l = String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  if (l.length > 3 || l.some((x) => ipZahl(x) === null)) throw new FahnasFehler('E_PARAMS', 'DNS-Server bitte als IPv4-Adressen, durch Komma getrennt (höchstens drei)', { feld: 'dns' });
  return l.join(', ');
}

export function namePruefen(text) {
  const n = String(text || '').trim();
  if (!/^[\p{L}\p{N} ._-]{1,32}$/u.test(n)) throw new FahnasFehler('E_PARAMS', 'Gerätename: 1–32 Zeichen aus Buchstaben, Ziffern, Leerzeichen, . _ -', { feld: 'name' });
  return n;
}

/** Dateiname für die .conf (iOS/Android übernehmen ihn als Tunnelnamen; Linux erlaubt höchstens 15 Zeichen). */
export function dateiname(name) {
  const s = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'Geraet';
  return `NAS-${s}`.slice(0, 15) + '.conf';
}

// ---- Konfigurationen --------------------------------------------------------------------------------------------
/** Ziele, die das Gerät durch den Tunnel schickt (AllowedIPs auf dem Gerät). */
export function geraetZiele(c, zugriff) {
  const netz = cidr(c.netz).text;
  if (zugriff === 'alles') return ['0.0.0.0/0', '::/0'];
  if (zugriff === 'heimnetz') return [netz, ...(c.lan_netze || [])];
  return [netz, ...(c.nas_ip ? [`${c.nas_ip}/32`] : [])];
}

/** DNS für ein Gerät: eigene Angabe, sonst DNS auf dem NAS, sonst (bei Heimnetz/alles) die DNS-Server des NAS. */
export function geraetDns(c, zugriff, { nasDns = false, dnsServer = [] } = {}) {
  if (c.dns) return c.dns;
  if (nasDns && c.nas_ip) return c.nas_ip;
  if (zugriff === 'nas') return '';
  const erreichbar = dnsServer.filter((d) => ipZahl(d) !== null && !/^127\./.test(d) && (zugriff === 'alles' || (c.lan_netze || []).some((n) => imNetz(d, n))));
  return erreichbar.slice(0, 2).join(', ');
}

export function serverKonfig(c) {
  const z = ['# Erzeugt von FAH-NAS – nicht von Hand ändern (System → VPN).', '[Interface]', `Address = ${serverIp(c.netz)}/${cidr(c.netz).praefix}`, `ListenPort = ${c.port}`, `PrivateKey = ${c.server.privat}`, ''];
  for (const g of c.geraete) z.push(`# ${String(g.name).replace(/[\r\n]/g, ' ')}`, '[Peer]', `PublicKey = ${g.oeffentlich}`, `PresharedKey = ${g.psk}`, `AllowedIPs = ${g.ip}/32`, '');
  return z.join('\n');
}

export function geraetKonfig(c, g, { endpunkt, dns }) {
  const z = ['[Interface]', `# ${String(g.name).replace(/[\r\n]/g, ' ')} – FAH-NAS`, `PrivateKey = ${g.privat}`, `Address = ${g.ip}/32`];
  if (dns) z.push(`DNS = ${dns}`);
  z.push('', '[Peer]', `PublicKey = ${c.server.oeffentlich}`, `PresharedKey = ${g.psk}`, `AllowedIPs = ${geraetZiele(c, g.zugriff).join(', ')}`, `Endpoint = ${endpunkt}:${c.port}`, 'PersistentKeepalive = 25', '');
  return z.join('\n');
}

/** „wg show <if> dump“: erste Zeile = Schnittstelle, dann je Gerät eine Zeile (Tabs). */
export function dumpParsen(text, jetzt = Date.now()) {
  const zeilen = String(text || '').trim().split('\n').filter(Boolean);
  if (!zeilen.length) return { port: null, geraete: [] };
  const kopf = zeilen[0].split('\t');
  const geraete = zeilen.slice(1).map((z) => {
    const t = z.split('\t');
    const hs = Number(t[4]) * 1000;
    return { oeffentlich: t[0], endpunkt: t[2] === '(none)' ? null : t[2], handshake: hs > 0 ? new Date(hs).toISOString() : null, verbunden: hs > 0 && jetzt - hs < VERBUNDEN_MS, rx: Number(t[5]) || 0, tx: Number(t[6]) || 0 };
  });
  return { port: Number(kopf[2]) || null, geraete };
}

/** Angaben für den Firewall-Renderer (oder null, wenn das VPN aus ist). */
export function firewallAngaben(c) {
  if (!c || !c.aktiv || !cidr(c.netz)) return null;
  const je = (z) => (c.geraete || []).filter((g) => g.zugriff === z).map((g) => g.ip).filter((ip) => ipZahl(ip) !== null);
  return { schnittstelle: SCHNITTSTELLE, port: Number(c.port), netz: cidr(c.netz).text, heimnetz: je('heimnetz'), alles: je('alles'), lan: (c.lan_netze || []).filter((n) => cidr(n)) };
}
