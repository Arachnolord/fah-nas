// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests WireGuard-VPN (Betreiber 12.10.2026): Schlüssel, Netze, Konfigurationen, wg-Dump, Firewall-Regeln, Paket-
// Nachinstallation, Aktionen mit Schein-System und der Selbsttest (öffentliche IP, DynDNS, Anschlussart, Router-Anleitung,
// Test von außen) ohne Internet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-vpn-'));
process.env.FAHNAS_CONFIG = path.join(wurzel, 'konfig');
process.env.FAHNAS_NFT = path.join(wurzel, 'fahnas.nft');
process.env.FAHNAS_WG_KONF = path.join(wurzel, 'wireguard', 'wg-fahnas.conf');
process.env.FAHNAS_SYSCTL_VPN = path.join(wurzel, '90-fahnas-vpn.conf');

const wg = await import('../../src/agent/vpn/wireguard.js');
const st = await import('../../src/agent/vpn/selbsttest.js');
const { nftText } = await import('../../src/agent/render/firewall.js');
const { paketeSicherstellen, installationsArgumente } = await import('../../src/agent/helfer/pakete.js');
const vpn = await import('../../src/agent/aktionen/vpn.js');
const { Konfig } = await import('../../src/gemeinsam/konfig.js');

test.after(() => fs.rm(wurzel, { recursive: true, force: true }));

const ROUTEN = [{ dst: 'default', gateway: '192.168.1.1', dev: 'eno1', protocol: 'dhcp', prefsrc: '192.168.1.29' }, { dst: '192.168.1.0/24', dev: 'eno1', protocol: 'kernel', scope: 'link', prefsrc: '192.168.1.29' },
  { dst: '192.168.1.1', dev: 'eno1', protocol: 'dhcp', scope: 'link', prefsrc: '192.168.1.29' }, { dst: '172.17.0.0/16', dev: 'docker0', protocol: 'kernel', scope: 'link', prefsrc: '172.17.0.1' },
  { dst: '172.18.0.0/16', dev: 'br-92e446b47f79', protocol: 'kernel', scope: 'link', prefsrc: '172.18.0.1' }, { dst: '192.168.122.0/24', dev: 'virbr0', protocol: 'kernel', scope: 'link', prefsrc: '192.168.122.1' }];
const TRACE_DIREKT = ' 1?: [LOCALHOST]                      pmtu 1500\n 1:  192.168.1.1                                             0.304ms \n 1:  192.168.1.1                                             0.287ms \n 2:  203.0.113.20                                        17.734ms \n 3:  203.0.113.21                                        12.972ms \n     Too many hops: pmtu 1500\n';

test('vpn: Schlüssel wie wg genkey/pubkey (und gegen wg selbst, falls installiert)', () => {
  const k = wg.schluesselpaar();
  assert.ok(wg.istSchluessel(k.privat) && wg.istSchluessel(k.oeffentlich));
  assert.equal(wg.oeffentlichAus(k.privat), k.oeffentlich);
  assert.ok(wg.istSchluessel(wg.vorabSchluessel()));
  assert.notEqual(wg.schluesselpaar().privat, k.privat);
  assert.throws(() => wg.oeffentlichAus('kurz'), (e) => e.code === 'E_PARAMS');
  let wgDa = true; try { execFileSync('wg', ['--version'], { stdio: 'ignore' }); } catch { wgDa = false; }
  if (wgDa) assert.equal(execFileSync('wg', ['pubkey'], { input: `${k.privat}\n` }).toString().trim(), k.oeffentlich, 'wg pubkey stimmt überein');
});

test('vpn: Netze, Adressen, Eingaben', () => {
  assert.equal(wg.cidr('10.149.27.9/24').text, '10.149.27.0/24');
  assert.equal(wg.serverIp('10.149.27.0/24'), '10.149.27.1');
  assert.equal(wg.naechsteIp('10.149.27.0/24', ['10.149.27.1', '10.149.27.2']), '10.149.27.3');
  assert.equal(wg.netzPruefen('10.149.27.0/24', ['192.168.1.0/24', '172.17.0.0/16']), '10.149.27.0/24');
  assert.throws(() => wg.netzPruefen('10.0.0.0/16', ['192.168.1.0/24']), /überschneidet sich mit 192\.168\.1\.0\/24/);
  assert.throws(() => wg.netzPruefen('8.8.8.0/24'), /privates Netz/);
  assert.throws(() => wg.netzPruefen('10.1.0.0/8'), /Präfix/);
  assert.throws(() => wg.naechsteIp('10.1.1.0/30', ['10.1.1.1', '10.1.1.2']), /keine Adresse mehr frei/);
  assert.equal(wg.adressePruefen(' example.org '), 'example.org');
  assert.equal(wg.adressePruefen('203.0.113.20'), '203.0.113.20');
  assert.throws(() => wg.adressePruefen('http://x'), (e) => e.details.feld === 'adresse');
  assert.equal(wg.dnsPruefen('192.168.1.29; 1.1.1.1'), '192.168.1.29, 1.1.1.1');
  assert.throws(() => wg.dnsPruefen('dns.google'), (e) => e.details.feld === 'dns');
  assert.equal(wg.namePruefen(' Fabians iPhone '), 'Fabians iPhone');
  assert.throws(() => wg.namePruefen('a/b'), (e) => e.details.feld === 'name');
  assert.equal(wg.dateiname('Fabians iPhone 15'), 'NAS-Fabians-iPh.conf');
  assert.ok(wg.istCgnat('100.70.1.1') && wg.istDsLite('192.0.0.1') && wg.istPrivat('192.168.178.1') && !wg.istPrivat('203.0.113.20'));
  const u = vpn.routenAuswerten(ROUTEN);
  assert.deepEqual(u.lan, ['192.168.1.0/24']); assert.equal(u.nasIp, '192.168.1.29'); assert.equal(u.gateway, '192.168.1.1');
  assert.ok(u.belegt.includes('172.17.0.0/16') && u.belegt.includes('192.168.122.0/24') && u.belegt.includes('192.168.1.0/24'));
});

test('vpn: Server- und Gerätekonfiguration, Zugriff, DNS', () => {
  const c = { ...structuredClone(wg.STANDARD), port: 51821, server: wg.schluesselpaar(), lan_netze: ['192.168.1.0/24'], nas_ip: '192.168.1.29' };
  const g = { name: 'iPhone', ip: '10.149.27.2', zugriff: 'nas', ...wg.schluesselpaar(), psk: wg.vorabSchluessel() };
  c.geraete = [g];
  const s = wg.serverKonfig(c);
  assert.match(s, /^Address = 10\.149\.27\.1\/24$/m); assert.match(s, /^ListenPort = 51821$/m);
  assert.ok(s.includes(`PublicKey = ${g.oeffentlich}`) && s.includes('AllowedIPs = 10.149.27.2/32') && !s.includes(g.privat));
  const k = wg.geraetKonfig(c, g, { endpunkt: 'example.org', dns: '192.168.1.29' });
  assert.ok(k.includes(`PrivateKey = ${g.privat}`) && k.includes(`PublicKey = ${c.server.oeffentlich}`) && !k.includes(c.server.privat));
  assert.match(k, /^AllowedIPs = 10\.149\.27\.0\/24, 192\.168\.1\.29\/32$/m);
  assert.match(k, /^Endpoint = example\.org:51821$/m); assert.match(k, /^DNS = 192\.168\.1\.29$/m); assert.match(k, /^PersistentKeepalive = 25$/m);
  assert.deepEqual(wg.geraetZiele(c, 'heimnetz'), ['10.149.27.0/24', '192.168.1.0/24']);
  assert.deepEqual(wg.geraetZiele(c, 'alles'), ['0.0.0.0/0', '::/0']);
  assert.equal(wg.geraetDns(c, 'nas', { nasDns: true }), '192.168.1.29');
  assert.equal(wg.geraetDns(c, 'nas', { nasDns: false, dnsServer: ['192.168.1.1'] }), '', 'nur NAS ohne DNS auf dem NAS → kein DNS');
  assert.equal(wg.geraetDns(c, 'heimnetz', { dnsServer: ['127.0.0.53', '192.168.1.1', '1.1.1.1'] }), '192.168.1.1', 'Heimnetz: nur DNS im LAN');
  assert.equal(wg.geraetDns(c, 'alles', { dnsServer: ['192.168.1.1', '1.1.1.1', '8.8.8.8'] }), '192.168.1.1, 1.1.1.1');
  assert.equal(wg.geraetDns({ ...c, dns: '9.9.9.9' }, 'nas', { nasDns: true }), '9.9.9.9', 'eigene Angabe gewinnt');
});

test('vpn: wg show dump auswerten', () => {
  const jetzt = Date.parse('2026-10-12T12:00:00Z');
  const d = `PRIV\tPUB\t51821\toff\nAAA=\tPSK\t198.51.100.40:61234\t10.149.27.2/32\t${jetzt / 1000 - 30}\t1000\t2000\t25\nBBB=\tPSK\t(none)\t10.149.27.3/32\t0\t0\t0\t25\n`;
  const r = wg.dumpParsen(d, jetzt);
  assert.equal(r.port, 51821);
  assert.deepEqual(r.geraete[0], { oeffentlich: 'AAA=', endpunkt: '198.51.100.40:61234', handshake: new Date(jetzt - 30_000).toISOString(), verbunden: true, rx: 1000, tx: 2000 });
  assert.equal(r.geraete[1].verbunden, false); assert.equal(r.geraete[1].endpunkt, null); assert.equal(r.geraete[1].handshake, null);
  assert.deepEqual(wg.dumpParsen(''), { port: null, geraete: [] });
});

test('vpn: Firewall – Port, Schnittstelle, Weiterleitung je Zugriff, NAT; ohne VPN keine forward-Kette', () => {
  const c = { ...structuredClone(wg.STANDARD), aktiv: true, lan_netze: ['192.168.1.0/24'], geraete: [{ id: 'a', ip: '10.149.27.2', zugriff: 'nas' }, { id: 'b', ip: '10.149.27.3', zugriff: 'heimnetz' }, { id: 'c', ip: '10.149.27.4', zugriff: 'alles' }] };
  const f = wg.firewallAngaben(c);
  assert.deepEqual(f, { schnittstelle: 'wg-fahnas', port: 51821, netz: '10.149.27.0/24', heimnetz: ['10.149.27.3'], alles: ['10.149.27.4'], lan: ['192.168.1.0/24'] });
  assert.equal(wg.firewallAngaben({ ...c, aktiv: false }), null);
  const n = nftText({ ssh: true, vpn: f });
  for (const z of ['udp dport 51821 accept', 'udp dport 51821 meta nfproto ipv4 add @vpn_quellen { ip saddr }', 'iifname "wg-fahnas" accept', 'type filter hook forward priority 0; policy accept;',
    'iifname "wg-fahnas" ct status dnat accept', 'iifname "wg-fahnas" ip saddr { 10.149.27.3 } ip daddr { 192.168.1.0/24 } accept', 'iifname "wg-fahnas" ip saddr { 10.149.27.4 } accept',
    'iifname "wg-fahnas" drop', 'oifname "wg-fahnas" ct state established,related accept', 'ip saddr 10.149.27.0/24 oifname != "wg-fahnas" masquerade']) assert.ok(n.includes(z), z);
  assert.ok(n.indexOf('set vpn_quellen') < n.indexOf('chain input'), 'Set vor der Kette definiert');
  const ohne = nftText({ ssh: true });
  assert.ok(!/hook forward|masquerade|wg-fahnas/.test(ohne), 'ohne VPN keine Weiterleitung');
  assert.ok(ohne.includes('set vpn_quellen'), 'Set immer gleich definiert (Neuladen ohne Fehler)');
  // nur „nas“-Geräte: keine Weiterleitungsregeln außer dnat/drop
  const nurNas = nftText({ ssh: true, vpn: wg.firewallAngaben({ ...c, geraete: [c.geraete[0]] }) });
  assert.ok(!nurNas.includes('ip daddr {') && nurNas.includes('iifname "wg-fahnas" drop'));
  for (const k of [...n.matchAll(/comment "([^"]*)"/g)].map((m) => m[1])) assert.match(k, /^[\x20-\x7e]{1,120}$/, `nft-Kommentar ASCII: ${k}`);
});

test('vpn: Pakete nachinstallieren (systemd-run --wait), Fehler verständlich', async () => {
  let da = false; const aufrufe = [];
  const system = { ausfuehren: async (p, a) => {
    aufrufe.push([p, ...a]);
    if (p === 'dpkg-query') return { stdout: da || a[2] === 'qrencode' ? 'install ok installed' : 'unknown ok not-installed' };
    if (p === 'systemd-run') { da = true; return { stdout: '' }; }
    throw new Error(p);
  } };
  const meldungen = [];
  assert.deepEqual(await paketeSicherstellen(system, ['wireguard-tools', 'qrencode'], { fortschritt: (t) => meldungen.push(t) }), ['wireguard-tools']);
  const run = aufrufe.find((x) => x[0] === 'systemd-run');
  assert.ok(run.includes('--wait') && run.includes('--collect') && run.at(-1).includes('install wireguard-tools') && !run.at(-1).includes('qrencode'));
  assert.match(meldungen[0], /wireguard-tools/);
  assert.deepEqual(await paketeSicherstellen(system, ['wireguard-tools']), [], 'schon da → nichts zu tun');
  assert.ok(installationsArgumente(['a1'], 'u').at(-1).includes('apt-get -o DPkg::Lock::Timeout=300 -q update &&'));
  const kaputt = { ausfuehren: async (p) => { if (p === 'dpkg-query') return { stdout: '' }; throw Object.assign(new Error('E: Unable to fetch'), { details: { ausgabe: 'E: Unable to fetch' } }); } };
  await assert.rejects(paketeSicherstellen(kaputt, ['nut-client'], { zweck: 'die USV' }), (e) => e.code === 'E_SYSTEM' && /die USV/.test(e.message) && /Internet/.test(e.message));
  await assert.rejects(paketeSicherstellen(kaputt, ['a; rm -rf /']), (e) => e.code === 'E_PARAMS');
});

test('vpn: Selbsttest-Bausteine – tracepath, Anschlussart, Router, Anleitung, nft-Set', () => {
  const hops = st.traceParsen(TRACE_DIREKT);
  assert.deepEqual(hops, [{ nr: 1, ip: '192.168.1.1' }, { nr: 2, ip: '203.0.113.20' }, { nr: 3, ip: '203.0.113.21' }]);
  assert.equal(st.anschlussBewerten(hops, '192.168.1.1').art, 'direkt');
  assert.deepEqual(st.anschlussBewerten([{ nr: 1, ip: '192.168.1.1' }, { nr: 2, ip: '192.168.178.1' }, { nr: 3, ip: '84.1.1.1' }], '192.168.1.1'), { art: 'doppelnat', zweiter: '192.168.178.1', erste_oeffentliche: '84.1.1.1' });
  assert.equal(st.anschlussBewerten([{ nr: 1, ip: '192.168.178.1' }, { nr: 2, ip: '100.72.0.1' }], '192.168.178.1').art, 'cgnat');
  assert.equal(st.anschlussBewerten([{ nr: 1, ip: '192.168.178.1' }, { nr: 2, ip: '192.0.0.1' }], '192.168.178.1').art, 'dslite');
  assert.equal(st.anschlussBewerten([], '192.168.1.1').art, 'unbekannt');
  assert.deepEqual(st.routerAusTitel('UniFi OS'), { art: 'unifi', name: 'UniFi' });
  assert.equal(st.routerAusTitel('FRITZ!Box').art, 'fritzbox');
  assert.equal(st.routerAusTitel('irgendwas').art, null);
  for (const art of ['unifi', 'fritzbox', 'speedport', 'vodafone', 'openwrt', 'opnsense', 'pfsense', 'mikrotik', 'telekom', null]) {
    const a = st.weiterleitungsAnleitung({ art, routerIp: '192.168.1.1', port: 51821, nasIp: '192.168.1.29' });
    assert.ok(a.includes('51821') && a.includes('192.168.1.29') && /UDP|udp/.test(a), `Anleitung ${art}`);
  }
  const j1 = JSON.stringify({ nftables: [{ metainfo: {} }, { set: { name: 'vpn_quellen', elem: [{ elem: { val: '198.51.100.41', timeout: 1800, expires: 1700 } }, '198.51.100.42'] } }] });
  assert.deepEqual([...st.quellenParsen(j1)], ['198.51.100.41', '198.51.100.42']);
  assert.equal(st.quellenParsen('kaputt').size, 0);
});

/** Schein-Internet für den Selbsttest. */
function scheinNetz({ ip = '203.0.113.20', dns = ['203.0.113.20'], kommtAn = true, checkHost = true } = {}) {
  const zustand = { quellen: new Set(['192.168.1.5']) };
  const antwort = (text, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => text });
  const holen = async (url) => {
    if (url.startsWith('https://api.ipify.org')) return ip ? antwort(ip) : Promise.reject(new Error('offline'));
    if (url.includes('icanhazip') || url.includes('ident.me') || url.includes('api6.')) return Promise.reject(new Error('offline'));
    if (url.startsWith('https://cloudflare-dns.com')) return antwort(JSON.stringify({ Status: 0, Answer: dns.map((d) => ({ type: 1, data: d })) }));
    if (url.startsWith('https://check-host.net/check-udp')) {
      if (!checkHost) return Promise.reject(new Error('ECONNREFUSED'));
      if (kommtAn) { zustand.quellen.add('198.51.100.41'); zustand.quellen.add('198.51.100.42'); }
      return antwort(JSON.stringify({ ok: 1, request_id: 'r1', nodes: { 'de4.node.check-host.net': ['de', 'Germany', 'Frankfurt', '198.51.100.41', 'AS1'], 'se1.node.check-host.net': ['se', 'Sweden', 'Stockholm', '198.51.100.42', 'AS2'] } }));
    }
    if (url.startsWith('https://check-host.net/check-result')) return antwort(JSON.stringify({ 'de4.node.check-host.net': [{ timeout: 1 }], 'se1.node.check-host.net': [{ timeout: 1 }] }));
    throw new Error(`unerwartet: ${url}`);
  };
  return { holen, zustand };
}

/** Schein-System für die Aktionen. */
function scheinSystem(netz, { trace = TRACE_DIREKT } = {}) {
  const s = { laeuft: false, aufrufe: [], dump: '' };
  s.ausfuehren = async (p, a, o = {}) => {
    s.aufrufe.push([p, ...a]);
    if (p === 'dpkg-query') return { stdout: 'install ok installed' };
    if (p === 'ip') return { stdout: JSON.stringify(ROUTEN) };
    if (p === 'ss') return { stdout: 'UNCONN 0      0         192.168.1.29:53 0.0.0.0:*\nUNCONN 0      0      127.0.0.53%lo:53 0.0.0.0:*\n' };
    if (p === 'nft' && a[0] === '-j') return { stdout: JSON.stringify({ nftables: [{ set: { elem: [...netz.zustand.quellen] } }] }) };
    if (p === 'nft' && a[0] === 'list') return { stdout: await fs.readFile(process.env.FAHNAS_NFT, 'utf8') };
    if (p === 'nft') return { stdout: '' };
    if (p === 'systemctl') { if (a[0] === 'restart') s.laeuft = true; if (a[0] === 'disable') s.laeuft = false; return { stdout: '' }; }
    if (p === 'wg' && a[0] === 'show') { if (!s.laeuft) throw new Error('Unable to access interface'); return { stdout: `PRIV\tPUB\t51821\toff\n${s.dump}` }; }
    if (p === 'wg-quick') return { stdout: '[Interface]\nPrivateKey = x\n' };
    if (p === 'wg' && a[0] === 'syncconf') return { stdout: '' };
    if (p === 'qrencode') return { stdout: `<svg>${o.eingabe.length}</svg>` };
    if (p === 'sysctl') return { stdout: '' };
    if (p === 'tracepath') return { stdout: trace };
    throw new Error(`unerwartet: ${p} ${a.join(' ')}`);
  };
  return s;
}

async function aufbau(opt = {}) {
  await fs.rm(process.env.FAHNAS_CONFIG, { recursive: true, force: true });
  const konfig = new Konfig(process.env.FAHNAS_CONFIG); await konfig.sicherstellen();
  const netz = scheinNetz(opt);
  const system = scheinSystem(netz, opt);
  const gemeldet = [];
  const w = { konfig, system, konfigGeaendert: () => {}, intern: async (a, p) => { gemeldet.push({ a, p }); return { ergebnis: null }; } };
  const aktionen = {};
  vpn.registriere({ aktion: (n, d) => { aktionen[n] = d; } }, w);
  const rufe = (n, p = {}) => aktionen[n].ausfuehren(p, {}, w, { fortschritt: () => {} });
  return { w, system, netz, rufe, gemeldet };
}

test('vpn: Aktionen – einschalten, Gerät mit QR, Zugriff ändern, Status, Netz gesperrt, löschen, ausschalten', async () => {
  const { w, system, rufe } = await aufbau();
  const r = await rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  assert.equal(r.aktiv, true); assert.equal(r.laeuft, true); assert.equal(r.server_ip, '10.149.27.1');
  assert.ok(system.aufrufe.some((x) => x.join(' ') === 'systemctl enable wg-quick@wg-fahnas') && system.aufrufe.some((x) => x.join(' ') === 'systemctl restart wg-quick@wg-fahnas'));
  assert.equal((await fs.stat(w.konfig.pfad('vpn.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(process.env.FAHNAS_WG_KONF)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(process.env.FAHNAS_NFT, 'utf8'), /udp dport 51821 accept/);
  assert.match(await fs.readFile(process.env.FAHNAS_SYSCTL_VPN, 'utf8'), /net\.ipv4\.ip_forward = 1/);

  const k = await rufe('vpn.geraet.anlegen', { name: 'iPhone', zugriff: 'heimnetz' });
  assert.equal(k.ip, '10.149.27.2'); assert.equal(k.dateiname, 'NAS-iPhone.conf');
  assert.match(k.text, /^AllowedIPs = 10\.149\.27\.0\/24, 192\.168\.1\.0\/24$/m); assert.match(k.text, /^DNS = 192\.168\.1\.29$/m, 'DNS läuft auf dem NAS');
  assert.match(k.text, /^Endpoint = example\.org:51821$/m); assert.match(k.qr_svg, /^<svg>/);
  assert.ok(system.aufrufe.some((x) => x[0] === 'wg' && x[1] === 'syncconf'), 'laufender Dienst: Geräte ohne Neustart nachladen');
  assert.match(await fs.readFile(process.env.FAHNAS_WG_KONF, 'utf8'), /# iPhone\n\[Peer\]/);
  assert.match(await fs.readFile(process.env.FAHNAS_NFT, 'utf8'), /ip saddr \{ 10\.149\.27\.2 \} ip daddr \{ 192\.168\.1\.0\/24 \} accept/);
  await assert.rejects(rufe('vpn.geraet.anlegen', { name: 'iphone' }), (e) => e.code === 'E_EXISTIERT');

  const k2 = await rufe('vpn.geraet.aendern', { id: k.id, zugriff: 'alles' });
  assert.match(k2.text, /^AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m);
  assert.match(await fs.readFile(process.env.FAHNAS_NFT, 'utf8'), /ip saddr \{ 10\.149\.27\.2 \} accept/);

  const l = await rufe('vpn.lesen');
  const roh = await w.konfig.laden('vpn.json');
  const text = JSON.stringify(l);
  assert.ok(!text.includes(roh.server.privat) && !text.includes(roh.geraete[0].privat) && !text.includes(roh.geraete[0].psk), 'keine Geheimnisse an die Oberfläche');
  assert.equal(l.geraete.length, 1); assert.deepEqual(l.pakete_fehlen, []);

  system.dump = `${roh.geraete[0].oeffentlich}\tPSK\t198.51.100.40:5000\t10.149.27.2/32\t${Math.floor(Date.now() / 1000) - 20}\t10\t20\t25\n`;
  const s = await rufe('vpn.status');
  assert.equal(s.geraete[0].verbunden, true); assert.equal(s.geraete[0].endpunkt, '198.51.100.40:5000');

  await assert.rejects(rufe('vpn.speichern', { netz: '10.150.0.0/24' }), (e) => e.code === 'E_PARAMS' && /keine Geräte/.test(e.message));
  await assert.rejects(rufe('vpn.speichern', { port: 53 }), (e) => e.details.feld === 'port');
  const p2 = await rufe('vpn.speichern', { port: 51900 });
  assert.match(p2.hinweis, /neu einlesen/);

  await rufe('vpn.geraet.loeschen', { id: k.id });
  assert.ok(!(await fs.readFile(process.env.FAHNAS_WG_KONF, 'utf8')).includes('[Peer]'));
  await assert.rejects(rufe('vpn.geraet.loeschen', { id: k.id }), (e) => e.code === 'E_NICHT_GEFUNDEN');

  const aus = await rufe('vpn.speichern', { aktiv: false });
  assert.equal(aus.aktiv, false); assert.equal(aus.laeuft, false);
  assert.ok(!(await fs.readFile(process.env.FAHNAS_NFT, 'utf8')).includes('wg-fahnas'), 'Regeln weg');
});

test('vpn: Selbsttest – alles gut, Port gesperrt (UniFi-Anleitung), doppeltes NAT (FRITZ!Box), DynDNS falsch, Prüfdienst weg', async () => {
  const unifi = async () => 'UniFi OS';
  let u = await aufbau();
  await u.rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  let e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: unifi, warten: async () => {} });
  const zu = (x, s) => x.schritte.find((y) => y.schritt === s);
  assert.equal(zu(e, 'dienst').zustand, 'ok'); assert.equal(zu(e, 'firewall').zustand, 'ok');
  assert.equal(zu(e, 'adresse').zustand, 'ok'); assert.equal(zu(e, 'anschluss').zustand, 'ok'); assert.match(zu(e, 'anschluss').text, /UniFi/);
  assert.equal(zu(e, 'aussen').zustand, 'ok'); assert.match(zu(e, 'aussen').text, /Frankfurt/);
  assert.equal(zu(e, 'nas_ip').zustand, 'info', 'Tipp feste Adresse');
  assert.equal(e.gesamt, 'ok');

  u = await aufbau({ kommtAn: false });
  await u.rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: unifi, warten: async () => {} });
  const a = zu(e, 'aussen');
  assert.equal(a.zustand, 'fehler'); assert.match(a.titel, /UDP 51821 ist von außen gesperrt/);
  assert.match(a.tun, /UniFi Network/); assert.match(a.tun, /WAN-Port 51821/); assert.match(a.tun, /Weiterleitungs-IP 192\.168\.1\.29/); assert.match(a.tun, /Protokoll UDP/);
  assert.equal(e.gesamt, 'fehler');

  u = await aufbau({ kommtAn: false, trace: ' 1:  192.168.1.1  0.3ms\n 2:  192.168.178.1  1.0ms\n 3:  84.1.1.1  9ms\n' });
  await u.rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: async (ip) => (ip === '192.168.178.1' ? 'FRITZ!Box' : 'UniFi OS'), warten: async () => {} });
  assert.equal(zu(e, 'anschluss').zustand, 'warnung'); assert.match(zu(e, 'anschluss').text, /FRITZ!Box/);
  assert.match(zu(e, 'aussen').tun, /vorderen Router \(FRITZ!Box\)/); assert.match(zu(e, 'aussen').tun, /Exposed Host/); assert.match(zu(e, 'aussen').tun, /Danach in deinem Router \(UniFi\)/);

  u = await aufbau({ dns: ['1.2.3.4'], checkHost: false });
  await u.rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: unifi, warten: async () => {} });
  assert.equal(zu(e, 'adresse').zustand, 'fehler'); assert.match(zu(e, 'adresse').text, /1\.2\.3\.4/);
  assert.equal(zu(e, 'aussen').zustand, 'info'); assert.match(zu(e, 'aussen').text, /check-host\.net nicht erreichbar/);

  u = await aufbau({ ip: null });
  await u.rufe('vpn.speichern', { aktiv: true, adresse: '' });
  e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: unifi, warten: async () => {} });
  assert.equal(zu(e, 'oeffentlich').zustand, 'fehler'); assert.equal(e.gesamt, 'fehler');

  u = await aufbau();
  e = await vpn.selbsttest(u.w, () => {}, { holen: u.netz.holen, titelHolen: unifi, warten: async () => {} });
  assert.equal(zu(e, 'dienst').titel, 'VPN ist ausgeschaltet'); assert.equal(e.schritte.length, 1);
});

test('vpn: Takt meldet neue Verbindung und Ausfall (einmal)', async () => {
  const u = await aufbau();
  await u.rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  await u.rufe('vpn.geraet.anlegen', { name: 'Laptop' });
  const roh = await u.w.konfig.laden('vpn.json');
  await vpn.taktPruefen(u.w);
  assert.equal(u.gemeldet.length, 0, 'beim ersten Takt keine Meldung');
  u.system.dump = `${roh.geraete[0].oeffentlich}\tPSK\t198.51.100.40:5000\t10.149.27.2/32\t${Math.floor(Date.now() / 1000) - 5}\t10\t20\t25\n`;
  await vpn.taktPruefen(u.w);
  assert.equal(u.gemeldet.length, 1); assert.equal(u.gemeldet[0].a, 'benachrichtigungen.senden'); assert.match(u.gemeldet[0].p.titel, /„Laptop“ verbunden/);
  await vpn.taktPruefen(u.w);
  assert.equal(u.gemeldet.length, 1, 'bleibt verbunden → keine weitere Meldung');
  u.system.laeuft = false;
  await vpn.taktPruefen(u.w); await vpn.taktPruefen(u.w); await vpn.taktPruefen(u.w);
  assert.equal(u.gemeldet.length, 2); assert.equal(u.gemeldet[1].p.stufe, 'fehler');
});

test('vpn: scheitert das Anwenden (z. B. AppArmor), bleibt kein halbes Gerät zurück; syncconf liest aus dem WireGuard-Ordner', async () => {
  const { w, system, rufe } = await aufbau();
  await rufe('vpn.speichern', { aktiv: true, adresse: 'example.org' });
  const echt = system.ausfuehren;
  system.ausfuehren = async (p, a, o) => { if (p === 'wg' && a[0] === 'syncconf') throw new Error('fopen: Permission denied'); return echt(p, a, o); };
  await assert.rejects(rufe('vpn.geraet.anlegen', { name: 'Handy' }));
  assert.equal((await w.konfig.laden('vpn.json')).geraete.length, 0, 'zurückgenommen');
  system.ausfuehren = echt;
  await rufe('vpn.geraet.anlegen', { name: 'Handy' });
  assert.ok(system.aufrufe.some((x) => x.join(' ') === `wg syncconf wg-fahnas ${path.join(path.dirname(process.env.FAHNAS_WG_KONF), '.wg-fahnas.abgleich')}`), 'Datei im erlaubten Ordner');
  await assert.rejects(fs.access(path.join(path.dirname(process.env.FAHNAS_WG_KONF), '.wg-fahnas.abgleich')), 'danach weg');
});
