// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil C: Bereich system (Status, Einstellungen, Dienste, Updates, S.M.A.R.T., apply, Ersteinrichtung)
// und die Renderer netplan, firewall, hostname. Alle Systembefehle sind ersetzt; Dateisystem in os.tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig, STANDARD } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { Audit } from '../../src/agent/audit.js';
import { Aufgaben } from '../../src/agent/aufgaben.js';
import { Datenkanal } from '../../src/agent/datenkanal.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { registriere, aptSimulationParsen, paketBereich, smartAuswerten, hdparmWert, dienstZustand, plattenLesen, zeitkonstantGleich, DIENSTE, _test, versionVergleich, programmZustand, PROGRAMM_UNIT } from '../../src/agent/aktionen/system.js';
import { netplanText, pruefeNetz, rendereNetplan, schnittstellen, netplanPfad } from '../../src/agent/render/netplan.js';
import { nftText, rendereFirewall, nftPfad } from '../../src/agent/render/firewall.js';
import { hostsText, rendereHostname, pruefeHostname } from '../../src/agent/render/hostname.js';

const ADMIN = { nutzer: 'fabian', rolle: 'admin', ip: '1.2.3.4' };
const NUTZER = { nutzer: 'lisa', rolle: 'nutzer', ip: '1.2.3.5' };
const GAST = { nutzer: 'gast', rolle: 'gast', ip: '1.2.3.6' };

/** Baut eine Testumgebung: Konfig in tmp, ersetzte Befehle, Register mit Bereich system, Werkzeuge wie im Agenten. */
async function umgebung({ antworten = {}, intern = {} } = {}) {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-sys-'));
  const konfigOrdner = path.join(w, 'config');
  const konfig = new Konfig(konfigOrdner);
  await konfig.sicherstellen();
  process.env.FAHNAS_NETPLAN = path.join(w, 'netplan');
  process.env.FAHNAS_NFT = path.join(w, 'nft', 'fahnas.nft');
  process.env.FAHNAS_NFT_GRUND = path.join(w, 'nftables.conf'); // nie das echte /etc/nftables.conf
  process.env.FAHNAS_HOSTS = path.join(w, 'hosts');
  process.env.FAHNAS_SUDOERS_ADMIN = path.join(w, 'sudoers.d', 'fahnas-admin');
  process.env.FAHNAS_SSHD_ADMIN = path.join(w, 'sshd_config.d', 'fahnas-admin.conf');
  process.env.FAHNAS_ADMIN_WRAPPER = path.join(w, 'lib', 'admin-als-root');
  process.env.FAHNAS_SSHD_PORT = path.join(w, 'sshd_config.d', 'fahnas-port.conf');
  process.env.FAHNAS_SSH_SOCKET = path.join(w, 'ssh.socket.d', 'fahnas-port.conf');
  const befehle = [];
  system._test.setzeBefehl(async (programm, args, o = {}) => {
    befehle.push({ programm, args, eingabe: o.eingabe, umgebung: o.umgebung, erlaubteCodes: o.erlaubteCodes });
    const h = antworten[programm];
    if (typeof h === 'function') return h(args, o);
    return { code: 0, stdout: '', stderr: '' };
  });
  const interne = []; const ereignisse = []; const fortschritte = [];
  const reg = new Register();
  const SYSTEM = { nutzer: 'system', rolle: 'system', ip: '-' };
  const werkzeuge = {
    konfig, system, audit: new Audit(path.join(konfigOrdner, 'protokoll')), aufgaben: new Aufgaben(() => {}, 2),
    pfade: { konfig: konfigOrdner, startcode: path.join(w, 'startcode'), run: w },
    datenkanal: new Datenkanal(path.join(w, 'd.sock')),
    ereignis: (art, d) => ereignisse.push({ ereignis: art, ...d }),
    konfigGeaendert: (bereich) => ereignisse.push({ ereignis: 'konfig', bereich }),
    intern: async (aktion, params) => {
      interne.push({ aktion, params });
      if (aktion in intern) { const r = intern[aktion]; return { ergebnis: typeof r === 'function' ? await r(params) : r }; }
      if (reg.aktionen.has(aktion)) { const v = reg.vorbereiten(aktion, params, SYSTEM); return { ergebnis: await v.aktion.ausfuehren(v.params, SYSTEM, werkzeuge) }; }
      throw new FahnasFehler('E_NICHT_GEFUNDEN', `Unbekannte Aktion „${aktion}“`, { aktion });
    },
    version: () => '9.9.9',
  };
  registriere(reg, werkzeuge);
  const griff = { id: 't-test', fortschritt: (a, m) => fortschritte.push({ a, m }), abgebrochen: () => false };
  const rufe = async (name, params = {}, kontext = ADMIN) => {
    const v = reg.vorbereiten(name, params, kontext);
    return v.aktion.ausfuehren(v.params, kontext, werkzeuge, griff);
  };
  const aufraeumen = async () => { system._test.setzeBefehl(null); _test.bremseZuruecksetzen(); await fs.rm(w, { recursive: true, force: true }); };
  return { w, konfig, konfigOrdner, befehle, interne, ereignisse, fortschritte, reg, werkzeuge, rufe, aufraeumen };
}

const aufrufe = (befehle, programm) => befehle.filter((b) => b.programm === programm).map((b) => b.args);
const SYSTEMCTL_STATUS = { smbd: 'active', docker: 'inactive', libvirtd: 'failed', 'avahi-daemon': 'active', ssh: 'active' };
const systemctlAntwort = (args) => {
  if (args[0] === 'is-active') { const z = SYSTEMCTL_STATUS[args[1]] || 'unknown'; return { code: z === 'active' ? 0 : 3, stdout: `${z}\n`, stderr: '' }; }
  return { code: 0, stdout: '', stderr: '' };
};

// ---------------------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------------------

test('system.status: Version, Dienste (aktiv/inaktiv/fehler), Platten, Ersteinrichtung; Rolle nutzer reicht, gast nicht', async () => {
  const u = await umgebung({ antworten: { systemctl: systemctlAntwort } });
  try {
    const s = await u.rufe('system.status', {}, NUTZER);
    assert.equal(s.version, '9.9.9');
    assert.equal(s.hostname, os.hostname().split('.')[0]);
    assert.ok(s.laufzeit_s > 0 && Number.isInteger(s.laufzeit_s));
    assert.equal(s.kernel, os.release());
    assert.deepEqual(s.dienste, { samba: 'aktiv', docker: 'inaktiv', libvirt: 'fehler', avahi: 'aktiv', ssh: 'aktiv' });
    assert.deepEqual(aufrufe(u.befehle, 'systemctl').map((a) => a[1]).sort(), Object.values(DIENSTE).sort());
    assert.ok(s.platten.some((p) => p.pfad === '/' && p.label === 'System' && p.gesamt > 0 && p.frei >= 0));
    assert.ok(s.platten.some((p) => p.pfad === path.dirname(u.konfigOrdner) && p.label === 'Daten'));
    assert.ok(Number.isInteger(s.datenpartition_prozent) && s.datenpartition_prozent >= 0 && s.datenpartition_prozent <= 100);
    assert.equal(s.ersteinrichtung_noetig, true);
    await u.konfig.aendern('users.json', (d) => { d.nutzer.push({ name: 'fabian', rolle: 'admin' }); });
    assert.equal((await u.rufe('system.status')).ersteinrichtung_noetig, false);
    assert.throws(() => u.reg.vorbereiten('system.status', {}, GAST), (e) => e.code === 'E_RECHTE');
  } finally { await u.aufraeumen(); }
});

test('befehl: maxBuffer wählbar (conntrack-Tabellen bis 64 MiB), ohne Angabe bleibt es bei 32 MiB', async () => {
  const MiB = 1024 * 1024;
  const nullen = (n) => ['/bin/sh', ['-c', `head -c ${n} /dev/zero`]];
  await assert.rejects(system.befehl(...nullen(5000), { maxBuffer: 4096 }), (e) => e.code === 'E_SYSTEM', 'eigene Grenze greift');
  assert.equal((await system.befehl(...nullen(5000), { maxBuffer: 8192 })).stdout.length, 5000);
  await assert.rejects(system.befehl(...nullen(33 * MiB)), (e) => e.code === 'E_SYSTEM', 'Standard 32 MiB');
  assert.equal((await system.befehl(...nullen(33 * MiB), { maxBuffer: 64 * MiB })).stdout.length, 33 * MiB);
});

test('dienstZustand: systemctl-Ausgaben und Fehler werden abgebildet', async () => {
  const sys = { ausfuehren: async (_p, args) => ({ code: 0, stdout: args[1] === 'a' ? 'active\n' : args[1] === 'f' ? 'failed\n' : 'inactive\n', stderr: '' }) };
  assert.equal(await dienstZustand(sys, 'a'), 'aktiv');
  assert.equal(await dienstZustand(sys, 'f'), 'fehler');
  assert.equal(await dienstZustand(sys, 'x'), 'inaktiv');
  assert.equal(await dienstZustand({ ausfuehren: async () => { throw new Error('kaputt'); } }, 'a'), 'fehler');
});

test('plattenLesen: statfs für echte Pfade, Rückfall df -B1 für fremde, fehlende Pfade werden ausgelassen', async () => {
  const dfAufrufe = [];
  const sys = { ausfuehren: async (p, args) => { dfAufrufe.push(args); if (args[2] === '/nirgendwo') return { code: 0, stdout: '        Size       Avail\n 1000  400\n', stderr: '' }; throw new FahnasFehler('E_SYSTEM', 'df fehlgeschlagen'); } };
  const p = await plattenLesen(sys, [{ pfad: os.tmpdir(), label: 'T' }, { pfad: '/nirgendwo', label: 'N' }, { pfad: '/auch/nicht', label: 'X' }]);
  assert.equal(p.length, 2);
  assert.ok(p[0].gesamt > 0 && p[0].label === 'T');
  assert.deepEqual(p[1], { pfad: '/nirgendwo', label: 'N', gesamt: 1000, frei: 400 });
  assert.deepEqual(dfAufrufe[0], ['-B1', '--output=size,avail', '/nirgendwo']);
});

// ---------------------------------------------------------------------------------------------------------------
// netplan
// ---------------------------------------------------------------------------------------------------------------

test('netplan: YAML-Text für DHCP (mit und ohne Schnittstelle) und statisch', () => {
  const dhcp = netplanText({ modus: 'dhcp', schnittstelle: 'enp1s0' });
  // DHCP: DNS aus DHCP plus feste Rückfälle 1.1.1.1/8.8.8.8 (wie im Installer)
  assert.match(dhcp, /^network:\n {2}version: 2\n {2}renderer: networkd\n {2}ethernets:\n {4}enp1s0:\n {6}dhcp4: true\n {6}nameservers:\n {8}addresses:\n {10}- 1\.1\.1\.1\n {10}- 8\.8\.8\.8\n$/m);
  const alle = netplanText({ modus: 'dhcp' });
  assert.ok(alle.includes('    fahnas-alle:\n      match:\n        name: "e*"\n      dhcp4: true\n      nameservers:\n        addresses:\n          - 1.1.1.1\n          - 8.8.8.8\n'));
  const statisch = netplanText({ modus: 'statisch', schnittstelle: 'enp1s0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['192.168.1.23', '1.1.1.1'] });
  const soll = [
    'network:', '  version: 2', '  renderer: networkd', '  ethernets:', '    enp1s0:', '      dhcp4: false', '      addresses:', '        - 192.168.1.50/24',
    '      routes:', '        - to: default', '          via: 192.168.1.1', '      nameservers:', '        addresses:', '          - 192.168.1.23', '          - 1.1.1.1',
  ].join('\n') + '\n';
  assert.ok(statisch.endsWith(soll), `Text:\n${statisch}`);
  assert.ok(statisch.startsWith('# Erzeugt von FAH-NAS'));
  const ohneGateway = netplanText({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/16' });
  assert.ok(!ohneGateway.includes('routes:') && !ohneGateway.includes('nameservers:'));
  const dhcpDns = netplanText({ modus: 'dhcp', schnittstelle: 'eth0', dns: ['9.9.9.9'] });
  assert.ok(dhcpDns.includes('dhcp4-overrides:\n        use-dns: false') && dhcpDns.includes('- 9.9.9.9'));
});

test('netplan: ungültige Werte werden abgelehnt (E_PARAMS mit Feld)', () => {
  const f = (netz, feld) => assert.throws(() => pruefeNetz(netz), (e) => e.code === 'E_PARAMS' && e.details.feld === feld, JSON.stringify(netz));
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.50' }, 'netz.adresse');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.256/24' }, 'netz.adresse');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/33' }, 'netz.adresse');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/0' }, 'netz.adresse');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/24', gateway: 'abc' }, 'netz.gateway');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/24', gateway: 'fe80::1' }, 'netz.gateway');
  f({ modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.5/24', dns: ['1.2.3'] }, 'netz.dns');
  f({ modus: 'statisch', adresse: '192.168.1.5/24' }, 'netz.schnittstelle');
  f({ modus: 'statisch', schnittstelle: 'eth0; rm -rf /', adresse: '192.168.1.5/24' }, 'netz.schnittstelle');
  f({ modus: 'bridge' }, 'netz.modus');
  f({ modus: 'dhcp', dns: '1.1.1.1' }, 'netz.dns');
  f({ modus: 'dhcp', dns: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'] }, 'netz.dns');
  // IPv6-DNS ist erlaubt, DHCP räumt statische Reste weg
  assert.deepEqual(pruefeNetz({ modus: 'dhcp', schnittstelle: 'eth0', adresse: '192.168.1.5/24', gateway: '192.168.1.1', dns: ['2606:4700:4700::1111'] }),
    { modus: 'dhcp', schnittstelle: 'eth0', adresse: null, gateway: null, dns: ['2606:4700:4700::1111'] });
});

test('rendereNetplan: schreibt 0600, ruft generate+apply, ist idempotent, stellt bei Fehler die alte Datei wieder her', async () => {
  const u = await umgebung();
  try {
    const netz = { modus: 'statisch', schnittstelle: 'enp1s0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['192.168.1.23'] };
    const r = await rendereNetplan(netz, { system });
    assert.equal(r.pfad, netplanPfad());
    assert.equal(r.geaendert, true);
    const st = await fs.stat(r.pfad);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(r.pfad, 'utf8'), netplanText(netz));
    assert.deepEqual(aufrufe(u.befehle, 'netplan'), [['generate'], ['apply']]);
    u.befehle.length = 0;
    assert.equal((await rendereNetplan(netz, { system })).geaendert, false);
    assert.equal(aufrufe(u.befehle, 'netplan').length, 0);
    // Fehler bei apply → E_RENDER, alte Datei bleibt
    system._test.setzeBefehl(async (p, args) => { if (p === 'netplan' && args[0] === 'apply') throw new FahnasFehler('E_SYSTEM', 'netplan schlug fehl', { ausgabe: 'Invalid YAML' }); return { code: 0, stdout: '', stderr: '' }; });
    await assert.rejects(rendereNetplan({ ...netz, adresse: '192.168.1.60/24' }, { system }), (e) => e.code === 'E_RENDER' && /Invalid YAML/.test(e.details.ausgabe));
    assert.equal(await fs.readFile(r.pfad, 'utf8'), netplanText(netz));
  } finally { await u.aufraeumen(); }
});

test('schnittstellen: ip -j link wird gelesen, lo und virtuelle Geräte fliegen raus', async () => {
  const json = JSON.stringify([
    { ifname: 'lo', link_type: 'loopback', operstate: 'UNKNOWN' },
    { ifname: 'enp1s0', link_type: 'ether', address: 'aa:bb:cc:dd:ee:ff', operstate: 'UP' },
    { ifname: 'docker0', link_type: 'ether', address: '02:42:00:00:00:01', operstate: 'DOWN' },
    { ifname: 'veth1234', link_type: 'ether', operstate: 'UP' },
    { ifname: 'wlp2s0', link_type: 'ether', address: '11:22:33:44:55:66', operstate: 'DOWN' },
  ]);
  const liste = await schnittstellen({ system: { ausfuehren: async (p, args) => { assert.deepEqual([p, ...args], ['ip', '-j', 'link']); return { code: 0, stdout: json, stderr: '' }; } } });
  assert.deepEqual(liste, [{ name: 'enp1s0', mac: 'aa:bb:cc:dd:ee:ff', zustand: 'oben' }, { name: 'wlp2s0', mac: '11:22:33:44:55:66', zustand: 'unten' }]);
  await assert.rejects(schnittstellen({ system: { ausfuehren: async () => ({ code: 0, stdout: 'kein json', stderr: '' }) } }), (e) => e.code === 'E_SYSTEM');
});

// ---------------------------------------------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------------------------------------------

test('firewall: nftables-Text – dauerhaft aus (policy accept, kein drop), Port-Übersicht mit/ohne SSH und SMB, Zusatzports', () => {
  const mit = nftText({ ssh: true });
  assert.ok(mit.includes('table inet fahnas\nflush table inet fahnas\n'));
  // Firewall dauerhaft aus (Betreiber 12.10.2026): policy accept, keine drop-Regel in der Eingangskette
  assert.ok(mit.includes('type filter hook input priority 0; policy accept;'));
  for (const t of [mit, nftText({ ssh: false, smb: false })]) assert.ok(!/drop/.test(t.slice(t.indexOf('chain input'), t.indexOf('\n  }', t.indexOf('chain input')))), 'nichts wird blockiert');
  assert.ok(mit.includes('iif "lo" accept'));
  assert.ok(mit.includes('ct state established,related accept'));
  assert.ok(mit.includes('meta l4proto icmp accept') && mit.includes('meta l4proto ipv6-icmp accept'));
  assert.ok(mit.includes('tcp dport 8443 accept') && mit.includes('tcp dport 445 accept'));
  assert.ok(mit.includes('tcp dport 22 accept'));
  assert.ok(mit.includes('udp dport 5353 accept'));
  assert.ok(!/dport (137|138|139)\b.*accept/.test(mit));
  const ohneSmb = nftText({ ssh: false, smb: false });
  assert.ok(!/dport 445 accept/.test(ohneSmb) && /SMB \(445\/tcp\) ist ausgeschaltet/.test(ohneSmb), 'SMB aus → 445 zu (12.10.2026)');
  assert.ok(/dport 445 accept/.test(nftText({ ssh: false })), 'Standard: SMB an');
  const ohne = nftText({ ssh: false });
  assert.ok(!/^\s*tcp dport 22 accept/m.test(ohne), 'SSH-Regel darf nicht aktiv sein');
  assert.ok(ohne.includes('# SSH (22/tcp) ist ausgeschaltet'));
  const zusatz = nftText({ ssh: true, zusatz: [{ proto: 'tcp', port: 8096, kommentar: 'Jellyfin "App"' }, { proto: 'udp', port: 51820 }] });
  assert.ok(zusatz.includes('tcp dport 8096 accept comment "Jellyfin App"') && zusatz.includes('udp dport 51820 accept'));
  assert.throws(() => nftText({ ssh: true, zusatz: [{ proto: 'tcp', port: 70000 }] }), (e) => e.code === 'E_PARAMS');
});

test('rendereFirewall: prüft mit nft -c -f, lädt mit nft -f; Ablehnung → E_RENDER und alte Datei bleibt', async () => {
  const u = await umgebung();
  try {
    const r = await rendereFirewall({ ssh: true }, { system });
    assert.equal(r.pfad, nftPfad());
    assert.equal(r.geaendert, true);
    assert.equal(await fs.readFile(r.pfad, 'utf8'), nftText({ ssh: true }));
    assert.deepEqual(aufrufe(u.befehle, 'nft'), [['-c', '-f', `${r.pfad}.neu`], ['-f', r.pfad]]);
    u.befehle.length = 0;
    // unverändert: trotzdem laden (idempotent), aber geaendert=false
    const r2 = await rendereFirewall({ ssh: true }, { system });
    assert.equal(r2.geaendert, false);
    assert.deepEqual(aufrufe(u.befehle, 'nft'), [['-c', '-f', `${r.pfad}.neu`], ['-f', r.pfad]]);
    // Ablehnung durch nft -c
    system._test.setzeBefehl(async (p, args) => { if (p === 'nft' && args[0] === '-c') throw new FahnasFehler('E_SYSTEM', 'nft', { ausgabe: 'Error: syntax error, unexpected accept' }); return { code: 0, stdout: '', stderr: '' }; });
    await assert.rejects(rendereFirewall({ ssh: false }, { system }), (e) => e.code === 'E_RENDER' && /syntax error/.test(e.details.ausgabe));
    assert.equal(await fs.readFile(r.pfad, 'utf8'), nftText({ ssh: true }));
    await assert.rejects(fs.access(`${r.pfad}.neu`));
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Hostname
// ---------------------------------------------------------------------------------------------------------------

test('hostname: Prüfung, hosts-Zeile ersetzen/einfügen, hostnamectl nur bei Änderung', async () => {
  assert.equal(pruefeHostname('Fah-NAS'), 'fah-nas');
  for (const schlecht of ['', '-a', 'a-', 'a_b', 'a.b', 'x'.repeat(64), 'ä']) assert.throws(() => pruefeHostname(schlecht), (e) => e.code === 'E_PARAMS', schlecht);
  assert.deepEqual(hostsText('127.0.0.1\tlocalhost\n127.0.1.1\talt\n::1 ip6\n', 'neu'), { text: '127.0.0.1\tlocalhost\n127.0.1.1\tneu\n::1 ip6\n', geaendert: true });
  assert.deepEqual(hostsText('127.0.0.1 localhost\n::1 ip6\n', 'box'), { text: '127.0.0.1 localhost\n127.0.1.1\tbox\n::1 ip6\n', geaendert: true });
  assert.equal(hostsText('127.0.1.1\tbox\n', 'box').geaendert, false);
  const u = await umgebung();
  try {
    await fs.writeFile(process.env.FAHNAS_HOSTS, '127.0.0.1\tlocalhost\n127.0.1.1\tubuntu\n');
    const r = await rendereHostname('fahnas', { system, aktuell: 'ubuntu' });
    assert.deepEqual(r, { hostname: 'fahnas', geaendert: true });
    assert.deepEqual(aufrufe(u.befehle, 'hostnamectl'), [['set-hostname', 'fahnas']]);
    assert.equal(await fs.readFile(process.env.FAHNAS_HOSTS, 'utf8'), '127.0.0.1\tlocalhost\n127.0.1.1\tfahnas\n');
    u.befehle.length = 0;
    assert.equal((await rendereHostname('fahnas', { system, aktuell: 'fahnas.local' })).geaendert, false);
    assert.equal(u.befehle.length, 0);
    system._test.setzeBefehl(async () => { throw new FahnasFehler('E_SYSTEM', 'hostnamectl', { ausgabe: 'Could not set hostname' }); });
    await assert.rejects(rendereHostname('anders', { system, aktuell: 'fahnas' }), (e) => e.code === 'E_RENDER');
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// apt / smart / hdparm
// ---------------------------------------------------------------------------------------------------------------

const APT_SIM = `NOTE: This is only a simulation!
Reading package lists...
Inst libc6 [2.39-0ubuntu8] (2.39-0ubuntu8.3 Ubuntu:26.04/resolute-updates, Ubuntu:26.04/resolute-security [amd64])
Inst nodejs [22.14.0+dfsg-1] (22.14.0+dfsg-2 Ubuntu:26.04/resolute-updates [amd64])
Inst neues-paket (1.0-1 Ubuntu:26.04/resolute [amd64])
Remv altes-paket [0.9-1]
Conf libc6 (2.39-0ubuntu8.3 Ubuntu:26.04/resolute-updates [amd64])
Conf nodejs (22.14.0+dfsg-2 Ubuntu:26.04/resolute-updates [amd64])
`;

test('aptSimulationParsen: Inst/Remv-Zeilen, Sicherheitsupdates, Neuinstallation ohne alte Version', () => {
  const r = aptSimulationParsen(APT_SIM);
  assert.equal(r.anzahl, 3);
  assert.equal(r.sicherheit, 1);
  assert.deepEqual(r.pakete[0], { name: 'libc6', alt: '2.39-0ubuntu8', neu: '2.39-0ubuntu8.3', sicherheit: true, bereich: null });
  assert.deepEqual(r.pakete[1], { name: 'nodejs', alt: '22.14.0+dfsg-1', neu: '22.14.0+dfsg-2', sicherheit: false, bereich: 'FAH-NAS' });
  assert.deepEqual(r.pakete[2], { name: 'neues-paket', alt: null, neu: '1.0-1', sicherheit: false, bereich: null });
  assert.equal(paketBereich('wireguard-tools'), 'VPN'); assert.equal(paketBereich('libvirt-daemon-system'), 'VMs'); assert.equal(paketBereich('qemu-system-x86'), 'VMs');
  assert.equal(paketBereich('nut-server'), 'USV'); assert.equal(paketBereich('docker.io'), 'Apps'); assert.equal(paketBereich('linux-image-7.0.0-40-generic'), 'Kernel');
  assert.deepEqual(r.entfernt, [{ name: 'altes-paket', alt: '0.9-1' }]);
  assert.deepEqual(aptSimulationParsen(''), { anzahl: 0, pakete: [], sicherheit: 0, entfernt: [] });
});

const SMART_SATA = (reallocated = 0, passed = true) => ({
  device: { name: '/dev/sda', type: 'sat' }, model_name: 'WDC WD40EFRX', serial_number: 'WD-123', firmware_version: '82.00A82', user_capacity: { bytes: 4000787030016 },
  smart_status: { passed }, power_on_time: { hours: 12345 }, temperature: { current: 34 },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', raw: { value: reallocated } }, { id: 9, name: 'Power_On_Hours', raw: { value: 12345 } },
    { id: 194, name: 'Temperature_Celsius', raw: { value: 34 } }, { id: 197, name: 'Current_Pending_Sector', raw: { value: 0 } }, { id: 198, name: 'Offline_Uncorrectable', raw: { value: 0 } },
  ] },
});
const SMART_NVME = (media_errors = 0, used = 3, critical = 0) => ({
  device: { name: '/dev/nvme0n1', type: 'nvme' }, model_name: 'Samsung SSD 980 PRO 1TB', serial_number: 'S5GX', smart_status: { passed: true, nvme: { value: critical } },
  power_on_time: { hours: 800 }, temperature: { current: 41 },
  nvme_smart_health_information_log: { critical_warning: critical, temperature: 41, percentage_used: used, media_errors, power_on_hours: 800 },
});

test('smartAuswerten: SATA ok/warnung/fehler, NVMe ok/warnung/fehler, nicht lesbar', () => {
  const ok = smartAuswerten('/dev/sda', SMART_SATA(), 0);
  assert.equal(ok.zustand, 'ok'); assert.equal(ok.modell, 'WDC WD40EFRX'); assert.equal(ok.temperatur, 34); assert.equal(ok.stunden, 12345);
  assert.equal(ok.details.typ, 'sata'); assert.equal(ok.details.reallocated_sector_ct, 0); assert.equal(ok.details.seriennummer, 'WD-123');
  const warn = smartAuswerten('/dev/sda', SMART_SATA(7), 0);
  assert.equal(warn.zustand, 'warnung'); assert.ok(warn.details.gruende.some((g) => /Reallocated_Sector_Ct = 7/.test(g)));
  const fehl = smartAuswerten('/dev/sda', SMART_SATA(0, false), 8);
  assert.equal(fehl.zustand, 'fehler');
  const nvmeOk = smartAuswerten('/dev/nvme0n1', SMART_NVME(), 0);
  assert.equal(nvmeOk.zustand, 'ok'); assert.equal(nvmeOk.details.typ, 'nvme'); assert.equal(nvmeOk.details.verbraucht_prozent, 3); assert.equal(nvmeOk.temperatur, 41); assert.equal(nvmeOk.stunden, 800);
  assert.equal(smartAuswerten('/dev/nvme0n1', SMART_NVME(2), 0).zustand, 'warnung');
  assert.equal(smartAuswerten('/dev/nvme0n1', SMART_NVME(0, 95), 0).zustand, 'warnung');
  assert.equal(smartAuswerten('/dev/nvme0n1', SMART_NVME(0, 3, 4), 0).zustand, 'fehler');
  const kaputt = smartAuswerten('/dev/sdb', null, 2, 'USB-Stick');
  assert.equal(kaputt.zustand, 'unbekannt'); assert.equal(kaputt.modell, 'USB-Stick'); assert.ok(kaputt.details.hinweis);
  const offen = smartAuswerten('/dev/sdb', { smartctl: { exit_status: 2, messages: [{ severity: 'error', string: 'Unable to detect device type' }] }, device: { name: '/dev/sdb' } }, 2);
  assert.equal(offen.zustand, 'unbekannt'); assert.match(offen.details.smartctl, /Unable to detect/); assert.match(offen.details.hinweis, /Keine S.M.A.R.T.-Werte/);
  // Mini-PC 09.10.: USB-Stick hinter unbekannter Brücke = keine Werte, keine Warnung
  const stick = smartAuswerten('/dev/sdc', { smartctl: { exit_status: 1, messages: [{ severity: 'error', string: '/dev/sdc: Unknown USB bridge [0x090c:0x1000 (0x1100)]' }] } }, 1, 'Flash Drive');
  assert.equal(stick.zustand, 'unbekannt'); assert.match(stick.details.hinweis, /USB-Adapter/);
});

test('hdparmWert: Minuten → hdparm -S', () => {
  assert.equal(hdparmWert(0), 0); assert.equal(hdparmWert(5), 60); assert.equal(hdparmWert(10), 120); assert.equal(hdparmWert(20), 240);
  assert.equal(hdparmWert(30), 241); assert.equal(hdparmWert(60), 242); assert.equal(hdparmWert(330), 251); assert.equal(hdparmWert(-3), 0);
});

test('system.smart: lsblk-Platten (ohne loop) → smartctl -j -H -A je Platte, alle Exit-Codes erlaubt', async () => {
  const lsblk = { blockdevices: [{ name: 'sda', type: 'disk', rota: true, model: 'WDC WD40EFRX' }, { name: 'nvme0n1', type: 'disk', rota: false, model: 'Samsung 980' }, { name: 'loop0', type: 'loop', rota: false, model: null }, { name: 'sr0', type: 'rom', rota: true, model: 'DVD' }] };
  const u = await umgebung({ antworten: {
    lsblk: () => ({ code: 0, stdout: JSON.stringify(lsblk), stderr: '' }),
    smartctl: (args) => ({ code: args[3] === '/dev/sda' ? 0 : 0, stdout: JSON.stringify(args[3] === '/dev/sda' ? SMART_SATA(1) : SMART_NVME()), stderr: '' }),
  } });
  try {
    const r = await u.rufe('system.smart');
    assert.deepEqual(aufrufe(u.befehle, 'lsblk'), [['-J', '-d', '-o', 'NAME,TYPE,ROTA,MODEL']]);
    assert.deepEqual(aufrufe(u.befehle, 'smartctl'), [['-j', '-H', '-A', '/dev/sda'], ['-j', '-H', '-A', '/dev/nvme0n1']]);
    assert.ok(u.befehle.filter((b) => b.programm === 'smartctl').every((b) => b.erlaubteCodes.includes(8) && b.erlaubteCodes.includes(255)));
    assert.equal(r.length, 2);
    assert.equal(r[0].geraet, '/dev/sda'); assert.equal(r[0].zustand, 'warnung'); assert.equal(r[0].rotierend, true);
    assert.equal(r[1].geraet, '/dev/nvme0n1'); assert.equal(r[1].zustand, 'ok'); assert.equal(r[1].rotierend, false);
    assert.throws(() => u.reg.vorbereiten('system.smart', {}, NUTZER), (e) => e.code === 'E_RECHTE');
  } finally { await u.aufraeumen(); }
});

test('system.hinweise: SMART nur von wachen Platten (-n standby), Updates aus den Paketlisten (ohne apt-get update), 6 h zwischengespeichert', async () => {
  const sys = await import('../../src/agent/aktionen/system.js');
  sys._hinweise.stand = null; sys._hinweise.zeit = 0;
  const lsblk = { blockdevices: [{ name: 'sda', type: 'disk', rota: true, model: 'WDC WD40EFRX' }, { name: 'sdb', type: 'disk', rota: true, model: 'Seagate' }, { name: 'nvme0n1', type: 'disk', rota: false, model: 'Samsung 980' }] };
  const u = await umgebung({ antworten: {
    lsblk: () => ({ code: 0, stdout: JSON.stringify(lsblk), stderr: '' }),
    smartctl: (args) => {
      const g = args[args.length - 1];
      if (g === '/dev/sdb') return { code: 2, stdout: JSON.stringify({ smartctl: { exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)' }] } }), stderr: '' };
      return { code: 0, stdout: JSON.stringify(g === '/dev/sda' ? SMART_SATA(4) : SMART_NVME()), stderr: '' };
    },
    'apt-get': (args) => ({ code: 0, stdout: args[0] === '-s' ? APT_SIM : '', stderr: '' }),
  } });
  try {
    const r = await u.rufe('system.hinweise');
    assert.deepEqual(aufrufe(u.befehle, 'smartctl').map((a) => a.slice(0, 5)), [['-j', '-H', '-A', '-n', 'standby'], ['-j', '-H', '-A', '-n', 'standby'], ['-j', '-H', '-A', '-n', 'standby']]);
    assert.deepEqual(r.smart.map((x) => [x.geraet, x.zustand]), [['/dev/sda', 'warnung']], 'schlafende sdb nicht geweckt, NVMe in Ordnung');
    assert.ok(r.smart[0].grund);
    assert.deepEqual(aufrufe(u.befehle, 'apt-get'), [['-s', 'dist-upgrade']], 'kein apt-get update');
    assert.ok(r.updates.anzahl > 0); assert.equal(typeof r.updates.sicherheit, 'number');
    assert.equal(r.benachrichtigungen, false);
    await u.konfig.speichern('benachrichtigungen.json', { version: 1, ntfy: { aktiv: true } });
    const zahl = u.befehle.length;
    const r2 = await u.rufe('system.hinweise');
    assert.equal(u.befehle.length, zahl, 'zwischengespeichert – keine neuen Befehle');
    assert.equal(r2.benachrichtigungen, true, 'Benachrichtigungen werden jedes Mal frisch gelesen');
    await u.rufe('system.hinweise', { neu: true });
    assert.ok(u.befehle.length > zahl, 'neu:true prüft sofort');
    assert.throws(() => u.reg.vorbereiten('system.hinweise', {}, NUTZER), (e) => e.code === 'E_RECHTE');
  } finally { await u.aufraeumen(); sys._hinweise.stand = null; }
});

// ---------------------------------------------------------------------------------------------------------------
// Einstellungen und Dienste
// ---------------------------------------------------------------------------------------------------------------

test('system.lesen/system.setzen: Hostname, Zeitzone, Netz, SSH, Proxys, Platten-Ruhe werden geprüft, gerendert und gespeichert', async () => {
  const lsblk = { blockdevices: [{ name: 'sda', type: 'disk', rota: '1', model: 'HDD' }, { name: 'nvme0n1', type: 'disk', rota: '0', model: 'SSD' }] };
  const u = await umgebung({ antworten: { lsblk: () => ({ code: 0, stdout: JSON.stringify(lsblk), stderr: '' }) } });
  try {
    const alt = await u.rufe('system.lesen');
    assert.equal(alt.hostname, 'fahnas'); assert.equal(alt.ssh, true); assert.equal(alt.netz.modus, 'dhcp');
    assert.throws(() => u.reg.vorbereiten('system.lesen', {}, NUTZER), (e) => e.code === 'E_RECHTE');
    // nur speichern: sprache/design
    const r0 = await u.rufe('system.setzen', { aenderungen: { sprache: 'en', design: 'dunkel' } });
    assert.equal(r0.sprache, 'en'); assert.deepEqual(r0._gerendert, []); assert.equal(u.befehle.length, 0);
    // Hostname
    const r1 = await u.rufe('system.setzen', { aenderungen: { hostname: 'Speicher-1' } });
    assert.equal(r1.hostname, 'speicher-1');
    assert.deepEqual(aufrufe(u.befehle, 'hostnamectl'), [['set-hostname', 'speicher-1']]);
    assert.match(await fs.readFile(process.env.FAHNAS_HOSTS, 'utf8'), /127\.0\.1\.1\tspeicher-1/);
    assert.equal((await u.konfig.laden('system.json')).hostname, 'speicher-1');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'system'));
    // Zeitzone: gültig und ungültig (ungültig darf nichts speichern)
    await u.rufe('system.setzen', { aenderungen: { zeitzone: 'Europe/Vienna' } });
    assert.deepEqual(aufrufe(u.befehle, 'timedatectl'), [['set-timezone', 'Europe/Vienna']]);
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { zeitzone: 'Mars/Olympus' } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'zeitzone');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { zeitzone: '../../etc/passwd' } }), (e) => e.code === 'E_PARAMS');
    assert.equal((await u.konfig.laden('system.json')).zeitzone, 'Europe/Vienna');
    // Netz statisch → netplan-Datei
    const r2 = await u.rufe('system.setzen', { aenderungen: { netz: { modus: 'statisch', schnittstelle: 'enp1s0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['192.168.1.23'] } } });
    assert.deepEqual(r2.netz, { modus: 'statisch', schnittstelle: 'enp1s0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['192.168.1.23'] });
    assert.ok((await fs.readFile(netplanPfad(), 'utf8')).includes('- 192.168.1.50/24'));
    assert.deepEqual(aufrufe(u.befehle, 'netplan'), [['generate'], ['apply']]);
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { netz: { adresse: '999.1.1.1/24' } } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'netz.adresse');
    // Teiländerung ohne modus mischt über den Bestand (statisch bleibt, nur DNS neu)
    const r2b = await u.rufe('system.setzen', { aenderungen: { netz: { dns: ['1.1.1.1'] } } });
    assert.deepEqual(r2b.netz, { modus: 'statisch', schnittstelle: 'enp1s0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['1.1.1.1'] });
    // zurück auf DHCP („Automatisch“, R3 Fund 2): Adresse, Gateway, Schnittstelle und DNS werden wirklich geleert –
    // auch wenn die Oberfläche null-Werte schickt (die Schema-Prüfung lässt sie aus)
    const r3 = await u.rufe('system.setzen', { aenderungen: { netz: { modus: 'dhcp', schnittstelle: null, adresse: null, gateway: null, dns: [] } } });
    assert.deepEqual(r3.netz, { modus: 'dhcp', schnittstelle: null, adresse: null, gateway: null, dns: [] });
    assert.deepEqual((await u.konfig.laden('system.json')).netz, { modus: 'dhcp', schnittstelle: null, adresse: null, gateway: null, dns: [] });
    // DHCP auf einer bestimmten Karte mit eigenem DNS bleibt möglich
    const r3b = await u.rufe('system.setzen', { aenderungen: { netz: { modus: 'dhcp', schnittstelle: 'enp1s0', dns: ['192.168.1.23'] } } });
    assert.deepEqual(r3b.netz, { modus: 'dhcp', schnittstelle: 'enp1s0', adresse: null, gateway: null, dns: ['192.168.1.23'] });
    // statisch verlangt Schnittstelle und Adresse – kein stilles Auffüllen aus dem Bestand
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { netz: { modus: 'statisch', adresse: '192.168.1.50/24' } } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'netz.schnittstelle');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { netz: { modus: 'statisch', schnittstelle: 'enp1s0' } } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'netz.adresse');
    assert.equal((await u.konfig.laden('system.json')).netz.modus, 'dhcp', 'abgelehnte Änderung wird nicht gespeichert');
    // SSH aus → Firewall ohne 22 + disable --now ssh
    u.befehle.length = 0;
    const r4 = await u.rufe('system.setzen', { aenderungen: { ssh: false } });
    assert.equal(r4.ssh, false);
    assert.ok(!/^\s*tcp dport 22 accept/m.test(await fs.readFile(nftPfad(), 'utf8')));
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['disable', '--now', 'ssh.socket', 'ssh.service']]);
    assert.deepEqual(r4._gerendert, ['firewall', 'ssh']);
    // vertraute Proxys
    const r5 = await u.rufe('system.setzen', { aenderungen: { vertraute_proxys: ['192.168.1.5', '192.168.48.0/20', '2001:db8::/32'] } });
    assert.deepEqual(r5.vertraute_proxys, ['192.168.1.5', '192.168.48.0/20', '2001:db8::/32']);
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { vertraute_proxys: ['192.168.1.0/33'] } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'vertraute_proxys');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { vertraute_proxys: ['npm'] } }), (e) => e.code === 'E_PARAMS');
    // Platten-Ruhe nur auf rotierende Platten
    u.befehle.length = 0;
    const r6 = await u.rufe('system.setzen', { aenderungen: { energie: { platten_ruhe_min: 10 } } });
    assert.equal(r6.energie.platten_ruhe_min, 10);
    assert.deepEqual(aufrufe(u.befehle, 'hdparm'), [['-S', '120', '/dev/sda']]);
    // unbekanntes Feld, falscher Typ
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { schmuggel: 1 } }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { hostname: 'a b' } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'hostname');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { design: 'neon' } }), (e) => e.code === 'E_PARAMS');
    // Render-Fehler → nichts gespeichert
    system._test.setzeBefehl(async (p) => { if (p === 'hostnamectl') throw new FahnasFehler('E_SYSTEM', 'nein', { ausgabe: 'nein' }); return { code: 0, stdout: '', stderr: '' }; });
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { hostname: 'kaputt' } }), (e) => e.code === 'E_RENDER');
    assert.equal((await u.konfig.laden('system.json')).hostname, 'speicher-1');
  } finally { await u.aufraeumen(); }
});

test('system.setzen: Standort (beide oder keiner, Bereich, Name), Aufzeichnung der Verbindungen, Ortsdaten-Schalter; STANDARD kennt die Felder', async () => {
  assert.deepEqual(STANDARD['system.json'].standort, { lat: null, lon: null, name: '' });
  assert.deepEqual(STANDARD['system.json'].verbindungen, { aufzeichnen: true });
  assert.deepEqual(STANDARD['system.json'].geo, { stadt_laden: true });
  const u = await umgebung();
  try {
    const alt = await u.rufe('system.lesen');
    assert.deepEqual([alt.standort, alt.verbindungen, alt.geo], [{ lat: null, lon: null, name: '' }, { aufzeichnen: true }, { stadt_laden: true }]);
    // ältere system.json ohne die neuen Felder → Standardwerte beim Lesen und beim Mischen
    await u.konfig.aendern('system.json', (s) => { delete s.standort; delete s.verbindungen; delete s.geo; });
    assert.deepEqual((await u.rufe('system.lesen')).verbindungen, { aufzeichnen: true });
    const r1 = await u.rufe('system.setzen', { aenderungen: { standort: { lat: 48.6284, lon: 11.7989, name: ' Sandelzhausen ' } } });
    assert.deepEqual(r1.standort, { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' });
    assert.deepEqual([r1.verbindungen, r1.geo], [{ aufzeichnen: true }, { stadt_laden: true }]);
    assert.deepEqual(r1._gerendert, []);
    assert.equal(u.befehle.length, 0, 'nichts ins System zu rendern');
    assert.deepEqual((await u.konfig.laden('system.json')).standort, { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' });
    const fehler = (standort, feld) => assert.rejects(u.rufe('system.setzen', { aenderungen: { standort } }),
      (e) => e.code === 'E_PARAMS' && e.details.feld === feld, JSON.stringify(standort));
    await fehler({ lat: 95, lon: 10 }, 'aenderungen.standort.lat');
    await fehler({ lat: -90.5, lon: 10 }, 'aenderungen.standort.lat');
    await fehler({ lat: 48, lon: -181 }, 'aenderungen.standort.lon');
    await fehler({ lat: 48 }, 'standort.lon');
    await fehler({ lon: 11, name: 'nur Länge' }, 'standort.lat');
    await fehler({ lat: '48', lon: '11' }, 'aenderungen.standort.lat');
    await fehler({ lat: 48, lon: 11, name: 'x'.repeat(65) }, 'aenderungen.standort.name');
    await fehler({ lat: 48, lon: 11, name: 'Zeile\nUmbruch' }, 'aenderungen.standort.name');
    await fehler({ lat: 48, lon: 11, hoehe: 400 }, 'aenderungen.standort.hoehe');
    assert.deepEqual((await u.konfig.laden('system.json')).standort, { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' }, 'abgelehnte Änderungen speichern nichts');
    // Ränder sind erlaubt
    assert.deepEqual((await u.rufe('system.setzen', { aenderungen: { standort: { lat: -90, lon: 180 } } })).standort, { lat: -90, lon: 180, name: '' });
    // beide null → Standort gelöscht (komplett ersetzt, auch der Name)
    const r2 = await u.rufe('system.setzen', { aenderungen: { standort: { lat: null, lon: null } } });
    assert.deepEqual(r2.standort, { lat: null, lon: null, name: '' });
    // Schalter werden flach gemischt
    const r3 = await u.rufe('system.setzen', { aenderungen: { verbindungen: { aufzeichnen: false } } });
    assert.deepEqual([r3.verbindungen, r3.geo], [{ aufzeichnen: false }, { stadt_laden: true }]);
    const r4 = await u.rufe('system.setzen', { aenderungen: { geo: { stadt_laden: false } } });
    assert.deepEqual([r4.verbindungen, r4.geo], [{ aufzeichnen: false }, { stadt_laden: false }]);
    assert.deepEqual((await u.konfig.laden('system.json')).geo, { stadt_laden: false });
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { verbindungen: { aufzeichnen: 'ja' } } }), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { geo: { stadt_laden: true, adresse: 'https://beispiel.de' } } }), (e) => e.code === 'E_PARAMS');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'system'));
    assert.equal(u.reg.hole('system.protokoll').lesend, true, 'Prüfprotokoll lesen schreibt selbst keine Zeile');
  } finally { await u.aufraeumen(); }
});

test('system.dienst: feste Abbildung auf Units, Antwort mit echtem Zustand (is-active), SSH aus/an pflegt Firewall und system.json', async () => {
  const zustand = { smbd: 'active', docker: 'active', ssh: 'active' };
  const u = await umgebung({ antworten: { systemctl: (args) => (args[0] === 'is-active' ? { code: zustand[args[1]] === 'active' ? 0 : 3, stdout: `${zustand[args[1]] || 'inactive'}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }) } });
  const nurSchaltend = (b) => b.filter((a) => a[0] !== 'is-active');
  try {
    // R3 Fund 11: zustand ist der echte Zustand nach der Aktion (aktiv|inaktiv|fehler), der Wunsch steht in `angefordert`
    assert.deepEqual(await u.rufe('system.dienst', { dienst: 'samba', zustand: 'neustart' }), { dienst: 'samba', zustand: 'aktiv', angefordert: 'neustart', unit: 'smbd' });
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['restart', 'smbd'], ['is-active', 'smbd']]);
    u.befehle.length = 0;
    zustand.docker = 'inactive';
    assert.deepEqual(await u.rufe('system.dienst', { dienst: 'docker', zustand: 'aus' }), { dienst: 'docker', zustand: 'inaktiv', angefordert: 'aus', unit: 'docker' });
    assert.deepEqual(nurSchaltend(aufrufe(u.befehle, 'systemctl')), [['disable', '--now', 'docker']]);
    zustand.docker = 'failed';
    assert.equal((await u.rufe('system.dienst', { dienst: 'docker', zustand: 'an' })).zustand, 'fehler');
    u.befehle.length = 0;
    zustand.ssh = 'inactive';
    assert.equal((await u.rufe('system.dienst', { dienst: 'ssh', zustand: 'aus' })).zustand, 'inaktiv');
    assert.deepEqual(nurSchaltend(aufrufe(u.befehle, 'systemctl')), [['disable', '--now', 'ssh.socket', 'ssh.service']]);
    assert.equal(aufrufe(u.befehle, 'nft').length, 2);
    assert.ok(!/^\s*tcp dport 22 accept/m.test(await fs.readFile(nftPfad(), 'utf8')));
    assert.equal((await u.konfig.laden('system.json')).ssh, false);
    u.befehle.length = 0;
    zustand.ssh = 'active';
    assert.equal((await u.rufe('system.dienst', { dienst: 'ssh', zustand: 'an' })).zustand, 'aktiv');
    assert.deepEqual(nurSchaltend(aufrufe(u.befehle, 'systemctl')), [['enable', '--now', 'ssh.socket', 'ssh.service']]);
    assert.ok(/^\s*tcp dport 22 accept/m.test(await fs.readFile(nftPfad(), 'utf8')));
    assert.equal((await u.konfig.laden('system.json')).ssh, true);
    assert.throws(() => u.reg.vorbereiten('system.dienst', { dienst: 'nginx', zustand: 'an' }, ADMIN), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('system.dienst', { dienst: 'ssh', zustand: 'kaputt' }, ADMIN), (e) => e.code === 'E_PARAMS');
    system._test.setzeBefehl(async (p) => { if (p === 'systemctl') throw new FahnasFehler('E_SYSTEM', 'x', { ausgabe: 'Unit not found' }); return { code: 0, stdout: '', stderr: '' }; });
    await assert.rejects(u.rufe('system.dienst', { dienst: 'libvirt', zustand: 'an' }), (e) => e.code === 'E_SYSTEM' && /libvirt/.test(e.message) && /Unit not found/.test(e.details.ausgabe));
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------------------------

test('system.updates.pruefen: apt-get update (noninteractive) + Simulation parsen; Fehler → E_SYSTEM', async () => {
  const u = await umgebung({ antworten: { 'apt-get': (args) => ({ code: 0, stdout: args[0] === '-s' ? APT_SIM : 'Hit: …', stderr: '' }) } });
  try {
    const r = await u.rufe('system.updates.pruefen');
    assert.equal(r.anzahl, 3); assert.equal(r.sicherheit, 1); assert.equal(r.pakete[0].name, 'libc6'); assert.ok(r.geprueft);
    assert.deepEqual(aufrufe(u.befehle, 'apt-get'), [['update'], ['-s', 'dist-upgrade']]);
    assert.ok(u.befehle.filter((b) => b.programm === 'apt-get').every((b) => b.umgebung.DEBIAN_FRONTEND === 'noninteractive' && b.umgebung.PATH));
    assert.ok(u.fortschritte.some((f) => f.a === 1 && /3 Updates/.test(f.m)));
    assert.ok(u.reg.hole('system.updates.pruefen').aufgabe);
    system._test.setzeBefehl(async () => { throw new FahnasFehler('E_SYSTEM', 'apt', { ausgabe: 'Could not resolve archive.ubuntu.com' }); });
    await assert.rejects(u.rufe('system.updates.pruefen'), (e) => e.code === 'E_SYSTEM' && /Internet/.test(e.message));
  } finally { await u.aufraeumen(); }
});

/** Falsches Kind für system.starten: gibt Zeilen aus und endet mit code. */
function falschesKind(zeilen, code, verzoegerung = 2) {
  const kind = new EventEmitter();
  kind.stdout = new PassThrough(); kind.stderr = new PassThrough(); kind.kill = () => {};
  setTimeout(() => { for (const z of zeilen) kind.stdout.write(`${z}\n`); kind.stdout.end(); kind.stderr.end(); setTimeout(() => kind.emit('close', code), verzoegerung); }, verzoegerung);
  return kind;
}

test('system.updates.einspielen: snapper pre → apt-get dist-upgrade (Fortschritt je Zeile) → snapper post → autoremove', async () => {
  let snapperNr = 41;
  const u = await umgebung({ antworten: {
    snapper: () => ({ code: 0, stdout: `${++snapperNr}\n`, stderr: '' }),
    'apt-get': (args) => ({ code: 0, stdout: args[0] === '-s' ? APT_SIM : '', stderr: '' }),
  } });
  const gestartet = [];
  u.werkzeuge.system = { ...system, starten: (p, args, o) => { gestartet.push({ p, args, env: o.env }); return falschesKind(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `Unpacking paket${i}` : `Preparing ${i}`)), 0); } };
  try {
    const r = await u.rufe('system.updates.einspielen');
    assert.deepEqual(aufrufe(u.befehle, 'snapper'), [
      ['-c', 'root', 'create', '-t', 'pre', '-p', '-d', 'FAH-NAS Update', '--cleanup-algorithm', 'number'],
      ['-c', 'root', 'create', '-t', 'post', '-p', '-d', 'FAH-NAS Update', '--cleanup-algorithm', 'number', '--pre-number', '42'],
    ]);
    assert.equal(gestartet.length, 1);
    assert.deepEqual(gestartet[0].args, ['-y', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'dist-upgrade']);
    assert.equal(gestartet[0].env.DEBIAN_FRONTEND, 'noninteractive');
    assert.deepEqual(aufrufe(u.befehle, 'apt-get'), [['-s', 'dist-upgrade'], ['autoremove', '-y']]);
    assert.equal(r.schnappschuss_vor, 42); assert.equal(r.schnappschuss_nach, 43); assert.equal(r.anzahl, 3);
    assert.deepEqual(r.eingespielt, ['libc6', 'nodejs', 'neues-paket']); assert.equal(typeof r.neustart_noetig, 'boolean'); assert.equal(r.autoremove, true);
    const mitte = u.fortschritte.filter((f) => f.a > 0.1 && f.a < 0.85);
    assert.ok(mitte.length >= 3, 'Fortschritt aus Zeilen erwartet');
    assert.ok(mitte.every((f, i, a) => i === 0 || f.a >= a[i - 1].a), 'Fortschritt steigt monoton');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'system' && e.art === 'update_fertig'));
  } finally { await u.aufraeumen(); }
});

test('system.updates.einspielen: apt-Fehler → Post-Schnappschuss trotzdem, E_SYSTEM mit Ausgabe; snapper pre-Fehler → Abbruch ohne apt', async () => {
  let snapperNr = 10;
  const u = await umgebung({ antworten: { snapper: () => ({ code: 0, stdout: `${++snapperNr}\n`, stderr: '' }), 'apt-get': () => ({ code: 0, stdout: APT_SIM, stderr: '' }) } });
  const gestartet = [];
  u.werkzeuge.system = { ...system, starten: (p, args) => { gestartet.push(args); return falschesKind(['Err:1 http://…', 'E: Unable to fetch some archives'], 100); } };
  try {
    await assert.rejects(u.rufe('system.updates.einspielen'), (e) => e.code === 'E_SYSTEM' && /Unable to fetch/.test(e.details.ausgabe) && e.details.schnappschuss_vor === 11 && e.details.schnappschuss_nach === 12 && e.details.code === 100);
    assert.equal(aufrufe(u.befehle, 'snapper').length, 2);
    assert.ok(!aufrufe(u.befehle, 'apt-get').some((a) => a[0] === 'autoremove'));
    // snapper pre schlägt fehl
    u.befehle.length = 0; gestartet.length = 0;
    system._test.setzeBefehl(async (p) => { if (p === 'snapper') throw new FahnasFehler('E_SYSTEM', 'snapper', { ausgabe: 'Unknown config' }); return { code: 0, stdout: '', stderr: '' }; });
    await assert.rejects(u.rufe('system.updates.einspielen'), (e) => e.code === 'E_SYSTEM' && /Schnappschuss/.test(e.message));
    assert.equal(gestartet.length, 0);
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Neustart, Protokoll, Schnittstellen
// ---------------------------------------------------------------------------------------------------------------

test('system.neustart/herunterfahren: Antwort sofort, systemctl verzögert, Ereignis', async () => {
  const u = await umgebung();
  _test.verzoegerung_ms = 10;
  try {
    assert.deepEqual(await u.rufe('system.neustart'), { geplant: true, in_s: 0.01 });
    assert.equal(aufrufe(u.befehle, 'systemctl').length, 0, 'noch nicht ausgeführt');
    await _test.letzteVerzoegerung;
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['reboot']]);
    await u.rufe('system.herunterfahren');
    await _test.letzteVerzoegerung;
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['reboot'], ['poweroff']]);
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'system' && e.art === 'neustart') && u.ereignisse.some((e) => e.art === 'herunterfahren'));
    assert.throws(() => u.reg.vorbereiten('system.neustart', {}, NUTZER), (e) => e.code === 'E_RECHTE');
  } finally { _test.verzoegerung_ms = 2000; await u.aufraeumen(); }
});

test('system.protokoll: liest das Prüfprotokoll mit Filter und Seiten', async () => {
  const u = await umgebung();
  try {
    await u.werkzeuge.audit.eintrag({ nutzer: 'fabian', ip: '1.1.1.1', aktion: 'freigaben.anlegen', params: { name: 'medien', passwort: 'x' }, ok: true, dauer_ms: 3 });
    await u.werkzeuge.audit.eintrag({ nutzer: 'lisa', ip: '1.1.1.2', aktion: 'system.setzen', params: {}, ok: false, fehler: { code: 'E_RECHTE', meldung: 'nein' }, dauer_ms: 1 });
    const alle = await u.rufe('system.protokoll', {});
    assert.equal(alle.gesamt, 2);
    const nurSystem = await u.rufe('system.protokoll', { aktion: 'system.', je_seite: 10, seite: 1 });
    assert.equal(nurSystem.gesamt, 1); assert.equal(nurSystem.eintraege[0].nutzer, 'lisa');
    assert.equal((await u.rufe('system.protokoll', { nutzer: 'fabian' })).eintraege[0].params.passwort, '***');
    assert.throws(() => u.reg.vorbereiten('system.protokoll', { je_seite: 5000 }, ADMIN), (e) => e.code === 'E_PARAMS');
  } finally { await u.aufraeumen(); }
});

test('system.schnittstellen: Aktion liefert die erkannten Schnittstellen', async () => {
  const u = await umgebung({ antworten: { ip: () => ({ code: 0, stdout: JSON.stringify([{ ifname: 'lo', link_type: 'loopback' }, { ifname: 'eno1', link_type: 'ether', address: '00:11', operstate: 'UP' }]), stderr: '' }) } });
  try {
    assert.deepEqual(await u.rufe('system.schnittstellen'), [{ name: 'eno1', mac: '00:11', zustand: 'oben' }]);
  } finally { await u.aufraeumen(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Ersteinrichtung
// ---------------------------------------------------------------------------------------------------------------

test('system.ersteinrichtung: ohne Startcode E_KONFIG mit Hinweis, richtig → Admin über nutzer.anlegen, Datei gelöscht, danach gesperrt', async () => {
  const angelegt = [];
  const u = await umgebung({ intern: { 'nutzer.anlegen': async (p) => { angelegt.push(p); await u.konfig.aendern('users.json', (d) => { d.nutzer.push({ name: p.name, rolle: p.rolle, hash: 'x' }); }); return { name: p.name, uid: 1001 }; } } });
  try {
    assert.deepEqual(await u.rufe('system.ersteinrichtung.status', {}, GAST), { noetig: true, startcode_vorhanden: false, hostname: os.hostname().split('.')[0] });
    const admin = { name: 'fabian', passwort: 'geheim123', anzeigename: 'Fabian' };
    await assert.rejects(u.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin }, GAST), (e) => e.code === 'E_KONFIG' && /fahnas startcode/.test(e.message));
    await fs.writeFile(u.werkzeuge.pfade.startcode, 'ABCD2345\n', { mode: 0o600 });
    assert.equal((await u.rufe('system.ersteinrichtung.status', {}, GAST)).startcode_vorhanden, true);
    const r = await u.rufe('system.ersteinrichtung', { startcode: ' abcd2345 ', admin }, GAST);
    assert.deepEqual(r, { ok: true, name: 'fabian', direkt: false, uebernommen: false });
    assert.deepEqual(angelegt, [{ name: 'fabian', passwort: 'geheim123', anzeigename: 'Fabian', rolle: 'admin' }]);
    await assert.rejects(fs.access(u.werkzeuge.pfade.startcode), 'Startcode-Datei muss weg sein');
    assert.ok(u.befehle.some((b) => /tools\/fahnas$/.test(b.programm) && b.args[0] === 'issue'), 'Konsolenanzeige wird aufgeräumt (fahnas issue)');
    assert.ok(u.ereignisse.some((e) => e.ereignis === 'konfig' && e.bereich === 'nutzer'));
    assert.equal((await u.rufe('system.ersteinrichtung.status', {}, GAST)).noetig, false);
    await fs.writeFile(u.werkzeuge.pfade.startcode, 'ABCD2345\n');
    await assert.rejects(u.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin }, GAST), (e) => e.code === 'E_RECHTE');
    // Schema: Passwort zu kurz, Name ungültig
    assert.throws(() => u.reg.vorbereiten('system.ersteinrichtung', { startcode: 'x', admin: { name: 'fabian', passwort: 'kurz' } }, GAST), (e) => e.code === 'E_PARAMS');
    assert.throws(() => u.reg.vorbereiten('system.ersteinrichtung', { startcode: 'x', admin: { name: 'Root', passwort: 'geheim123' } }, GAST), (e) => e.code === 'E_PARAMS');
  } finally { await u.aufraeumen(); }
});

test('system.ersteinrichtung: falscher Startcode zählt, nach 5 Fehlversuchen 10 Minuten Sperre (auch für den richtigen Code)', async () => {
  const u = await umgebung({ intern: { 'nutzer.anlegen': async () => ({}) } });
  try {
    await fs.writeFile(u.werkzeuge.pfade.startcode, 'ABCD2345\n');
    const admin = { name: 'fabian', passwort: 'geheim123' };
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(u.rufe('system.ersteinrichtung', { startcode: 'FALSCH00', admin }, GAST), (e) => e.code === 'E_ANMELDUNG' && e.details.verbleibend === 5 - i, `Versuch ${i}`);
    }
    await assert.rejects(u.rufe('system.ersteinrichtung', { startcode: 'FALSCH00', admin }, GAST), (e) => e.code === 'E_BREMSE' && e.details.warte_s === 600);
    await assert.rejects(u.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin }, GAST), (e) => e.code === 'E_BREMSE' && e.details.warte_s > 0 && e.details.warte_s <= 600);
    assert.equal(u.interne.length, 0, 'nutzer.anlegen darf nie gerufen worden sein');
    await fs.access(u.werkzeuge.pfade.startcode);
    // Sperre abgelaufen (Zeit vorstellen) → richtig geht wieder
    _test.bremse.sperre_bis = Date.now() - 1;
    assert.equal((await u.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin }, GAST)).ok, true);
  } finally { await u.aufraeumen(); }
});

test('system.ersteinrichtung: E_EXISTIERT aus nutzer.anlegen wird durchgereicht (kein Rückfall – R1 Fund 7); Rückfall nur ohne Bereich nutzer, nie für Systemkonten', async () => {
  // Bereich nutzer meldet E_EXISTIERT (Systemkonto, Gruppenname) → durchreichen, KEIN chpasswd/smbpasswd
  const u0 = await umgebung({
    antworten: { getent: (args) => ({ code: args[1] === 'syslog' ? 0 : 2, stdout: args[1] === 'syslog' ? 'syslog:x:104:110::/home/syslog:/usr/sbin/nologin\n' : '', stderr: '' }) },
    intern: { 'nutzer.anlegen': async () => { throw new FahnasFehler('E_EXISTIERT', '„syslog“ ist ein Systemkonto und kann kein NAS-Nutzer werden', { feld: 'name' }); } },
  });
  try {
    await fs.writeFile(u0.werkzeuge.pfade.startcode, 'ABCD2345\n');
    await assert.rejects(u0.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin: { name: 'syslog', passwort: 'geheim123' } }, GAST), (e) => e.code === 'E_EXISTIERT');
    assert.ok(!u0.befehle.some((b) => ['chpasswd', 'smbpasswd', 'usermod', 'useradd'].includes(b.programm)), 'Systemkonto wird nie angefasst');
    assert.deepEqual((await u0.konfig.laden('users.json')).nutzer, []);
    await fs.access(u0.werkzeuge.pfade.startcode, undefined, 'Startcode bleibt für den nächsten Versuch');
  } finally { await u0.aufraeumen(); }
  // Bereich nutzer fehlt + Linux-Nutzer ist ein Systemkonto (uid 104, P9) → Rückfall lehnt ab
  const u1 = await umgebung({ antworten: { getent: (args) => ({ code: args[1] === 'syslog' ? 0 : 2, stdout: args[1] === 'syslog' ? 'syslog:x:104:110::/home/syslog:/usr/sbin/nologin\n' : '', stderr: '' }) } });
  try {
    await fs.writeFile(u1.werkzeuge.pfade.startcode, 'ABCD2345\n');
    await assert.rejects(u1.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin: { name: 'syslog', passwort: 'geheim123' } }, GAST), (e) => e.code === 'E_EXISTIERT' && /Systemkonto/.test(e.message));
    await assert.rejects(u1.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin: { name: 'nobody', passwort: 'geheim123' } }, GAST), (e) => e.code === 'E_PARAMS');
    assert.ok(!u1.befehle.some((b) => ['chpasswd', 'smbpasswd', 'usermod', 'useradd'].includes(b.programm)), 'Systemkonto bekommt weder Passwort noch Samba-Konto noch Gruppe');
    assert.deepEqual((await u1.konfig.laden('users.json')).nutzer, []);
  } finally { await u1.aufraeumen(); }
  // Bereich nutzer fehlt + Installer-Nutzer (uid 1000) → Rückfall übernimmt ihn (chpasswd/smbpasswd über stdin)
  const u = await umgebung({
    antworten: { getent: (args) => ({ code: args[1] === 'fabian' ? 0 : 2, stdout: args[1] === 'fabian' ? 'fabian:x:1000:1000:Fabian:/home/benutzer:/bin/bash\n' : '', stderr: '' }) },
  });
  try {
    await fs.writeFile(u.werkzeuge.pfade.startcode, 'ABCD2345\n');
    const r = await u.rufe('system.ersteinrichtung', { startcode: 'ABCD2345', admin: { name: 'fabian', passwort: 'geheim123', anzeigename: 'Fabian' } }, GAST);
    assert.deepEqual(r, { ok: true, name: 'fabian', direkt: true, uebernommen: false });
    assert.deepEqual(u.interne.map((i) => i.aktion), ['nutzer.anlegen'], 'Rückfall erst nach E_NICHT_GEFUNDEN des Bereichs');
    const chpasswd = u.befehle.find((b) => b.programm === 'chpasswd');
    assert.deepEqual(chpasswd.args, []); assert.equal(chpasswd.eingabe, 'fabian:geheim123\n');
    const smb = u.befehle.find((b) => b.programm === 'smbpasswd');
    assert.deepEqual(smb.args, ['-a', '-s', 'fabian']); assert.equal(smb.eingabe, 'geheim123\ngeheim123\n');
    assert.ok(!u.befehle.some((b) => b.args.includes('geheim123')), 'Passwort nie als Argument');
    assert.ok(!u.befehle.some((b) => b.programm === 'useradd'), 'vorhandener Nutzer wird übernommen, nicht neu angelegt');
    assert.ok(u.befehle.some((b) => b.programm === 'usermod' && b.args[1] === 'fahnas-admin'));
    const users = await u.konfig.laden('users.json');
    assert.equal(users.nutzer.length, 1);
    assert.equal(users.nutzer[0].name, 'fabian'); assert.equal(users.nutzer[0].rolle, 'admin'); assert.equal(users.nutzer[0].uid, 1000); assert.equal(users.nutzer[0].anzeigename, 'Fabian');
    assert.match(users.nutzer[0].hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(((await fs.stat(path.join(u.konfigOrdner, 'users.json'))).mode & 0o777), 0o600);
    await assert.rejects(fs.access(u.werkzeuge.pfade.startcode));
    // R2 Fund 14: nach Erfolg räumt „fahnas issue“ die Konsolenanzeige auf (Fehler egal)
    const issue = u.befehle.find((b) => /tools\/fahnas$/.test(b.programm));
    assert.ok(issue, 'fahnas issue wurde gerufen'); assert.deepEqual(issue.args, ['issue']);
  } finally { await u.aufraeumen(); }
  // Bereich nutzer fehlt ganz → ebenfalls Rückfall, neuer Linux-Nutzer wird angelegt
  const u2 = await umgebung({ antworten: { getent: (args) => ({ code: 2, stdout: '', stderr: '' }) } });
  try {
    await fs.writeFile(u2.werkzeuge.pfade.startcode, 'ZZZZ9999\n');
    // getent liefert nach useradd eine Zeile
    let angelegt = false;
    system._test.setzeBefehl(async (p, args, o = {}) => { u2.befehle.push({ programm: p, args, eingabe: o.eingabe }); if (p === 'useradd') angelegt = true; if (p === 'getent') return { code: angelegt ? 0 : 2, stdout: angelegt ? 'neu:x:1001:1001::/nonexistent:/usr/sbin/nologin\n' : '', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; });
    const r = await u2.rufe('system.ersteinrichtung', { startcode: 'ZZZZ9999', admin: { name: 'neu', passwort: 'geheim123' } }, GAST);
    assert.equal(r.direkt, true);
    assert.deepEqual(u2.interne.map((i) => i.aktion), ['nutzer.anlegen']);
    assert.deepEqual(u2.befehle.find((b) => b.programm === 'useradd').args, ['-M', '-s', '/bin/bash', 'neu']);
    assert.equal((await u2.konfig.laden('users.json')).nutzer[0].uid, 1001);
  } finally { await u2.aufraeumen(); }
});

test('zeitkonstantGleich vergleicht unabhängig von der Länge', () => {
  assert.equal(zeitkonstantGleich('ABCD2345', 'ABCD2345'), true);
  assert.equal(zeitkonstantGleich('ABCD2345', 'ABCD234'), false);
  assert.equal(zeitkonstantGleich('', 'x'), false);
});

// ---------------------------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------------------------

test('system.apply: ruft nutzer/freigaben/snapshots in Reihenfolge, überspringt fehlende Bereiche, fängt Fehler, rendert eigene Teile', async () => {
  const u = await umgebung({ intern: {
    'nutzer.apply': async () => ({ ok: true }),
    'snapshots.apply': async () => { throw new FahnasFehler('E_SYSTEM', 'snapper fehlt', { befehl: 'snapper' }); },
  } });
  try {
    assert.throws(() => u.reg.vorbereiten('system.apply', {}, ADMIN), (e) => e.code === 'E_RECHTE', 'nur Systemrolle');
    const r = await u.rufe('system.apply', {}, { nutzer: 'system', rolle: 'system', ip: '-' });
    assert.deepEqual(u.interne.map((i) => i.aktion), ['nutzer.apply', 'raid.apply', 'importe.apply', 'speicherorte.apply', 'heim.apply', 'freigaben.apply', 'snapshots.apply', 'apps.apply', 'laufwerke.apply', 'vpn.apply', 'energie.apply', 'protokolle.apply', 'wartung.apply']);
    assert.deepEqual(r.gerendert, ['nutzer.apply', 'hostname', 'zeitzone', 'firewall', 'ssh', 'admin_root']);
    assert.deepEqual(r.uebersprungen, ['raid.apply', 'importe.apply', 'speicherorte.apply', 'heim.apply', 'freigaben.apply', 'apps.apply', 'laufwerke.apply', 'vpn.apply', 'energie.apply', 'protokolle.apply', 'wartung.apply', 'netplan', 'ssh_port', 'platten_ruhe']);
    assert.equal(r.fehler.length, 1); assert.equal(r.fehler[0].schritt, 'snapshots.apply'); assert.equal(r.fehler[0].code, 'E_SYSTEM');
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['enable', '--now', 'ssh.socket', 'ssh.service'], ['reload', 'ssh.service']], 'Admin-Regel einmal neu geladen');
    assert.deepEqual(aufrufe(u.befehle, 'visudo').length, 1);
    assert.deepEqual(aufrufe(u.befehle, 'timedatectl'), [['set-timezone', 'Europe/Berlin']]);
    assert.equal(aufrufe(u.befehle, 'nft').length, 2);
    assert.equal(aufrufe(u.befehle, 'netplan').length, 0, 'DHCP ohne Datei → netplan nicht angefasst');
    await fs.access(nftPfad());
    // statisches Netz, SSH aus, Platten-Ruhe → alles gerendert; Render-Fehler eines Schritts stoppt die anderen nicht
    await u.konfig.aendern('system.json', (s) => { s.netz = { modus: 'statisch', schnittstelle: 'eth0', adresse: '192.168.1.50/24', gateway: '192.168.1.1', dns: [] }; s.ssh = false; s.energie.platten_ruhe_min = 30; });
    u.befehle.length = 0;
    system._test.setzeBefehl(async (p, args) => {
      u.befehle.push({ programm: p, args });
      if (p === 'lsblk') return { code: 0, stdout: JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk', rota: true, model: 'HDD' }] }), stderr: '' };
      if (p === 'netplan' && args[0] === 'apply') throw new FahnasFehler('E_SYSTEM', 'netplan', { ausgabe: 'kaputt' });
      return { code: 0, stdout: '', stderr: '' };
    });
    const r2 = await u.rufe('system.apply', {}, { nutzer: 'system', rolle: 'system', ip: '-' });
    assert.ok(r2.fehler.some((f) => f.schritt === 'netplan' && f.code === 'E_RENDER'));
    assert.ok(r2.gerendert.includes('firewall') && r2.gerendert.includes('ssh') && r2.gerendert.includes('platten_ruhe'));
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['disable', '--now', 'ssh.socket', 'ssh.service']]);
    assert.deepEqual(aufrufe(u.befehle, 'hdparm'), [['-S', '241', '/dev/sda']]);
    assert.ok(!/^\s*tcp dport 22 accept/m.test(await fs.readFile(nftPfad(), 'utf8')));
  } finally { await u.aufraeumen(); }
});

test('system.setzen: eigener SSH-Port wird geprüft, umgestellt und in der Firewall-Übersicht genannt', async () => {
  const u = await umgebung();
  try {
    assert.equal((await u.rufe('system.lesen')).ssh_port, 22);
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { ssh_port: 8443 } }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'ssh_port');
    assert.equal((await u.konfig.laden('system.json')).ssh_port, 22, 'ungültig: nichts gespeichert');
    const r = await u.rufe('system.setzen', { aenderungen: { ssh_port: 2222 } });
    assert.equal(r.ssh_port, 2222);
    assert.deepEqual(r._gerendert, ['firewall', 'ssh_port']);
    assert.deepEqual(aufrufe(u.befehle, 'systemctl'), [['daemon-reload'], ['try-restart', 'ssh.socket'], ['try-restart', 'ssh.service']]);
    assert.match(await fs.readFile(process.env.FAHNAS_SSH_SOCKET, 'utf8'), /ListenStream=0\.0\.0\.0:2222/);
    assert.match(await fs.readFile(nftPfad(), 'utf8'), /tcp dport 2222 accept/);
    assert.equal((await u.konfig.laden('system.json')).ssh_port, 2222);
  } finally { await u.aufraeumen(); }
});

test('Register: alle Aktionen des Bereichs system sind mit den Rollen aus dem Vertrag registriert', async () => {
  const u = await umgebung();
  try {
    const soll = {
      'system.status': 'nutzer', 'system.lesen': 'admin', 'system.setzen': 'admin', 'system.dienst': 'admin', 'system.updates.pruefen': 'admin', 'system.updates.einspielen': 'admin',
      'system.smart': 'admin', 'system.neustart': 'admin', 'system.herunterfahren': 'admin', 'system.protokoll': 'admin', 'system.export': 'admin', 'system.import': 'admin',
      'system.import.ticket': 'admin', 'system.apply': 'system', 'system.ersteinrichtung.status': 'gast', 'system.ersteinrichtung': 'gast', 'system.schnittstellen': 'admin',
      'system.programm.ticket': 'admin', 'system.programm.pruefen': 'admin', 'system.programm.einspielen': 'admin', 'system.programm.status': 'admin',
    };
    for (const [name, rolle] of Object.entries(soll)) assert.equal(u.reg.hole(name).rolle, rolle, name);
    for (const a of ['system.updates.pruefen', 'system.updates.einspielen', 'system.import']) assert.equal(u.reg.hole(a).aufgabe, true, a);
    assert.equal(u.reg.hole('system.export').aufgabe, false);
  } finally { await u.aufraeumen(); }
});

test('versionVergleich und programmZustand', () => {
  assert.equal(versionVergleich('0.6.13', '0.6.12'), 1); assert.equal(versionVergleich('0.6.9', '0.6.10'), -1);
  assert.equal(versionVergleich('1.0.0', '1.0.0'), 0); assert.equal(versionVergleich('0.10.0', '0.9.99'), 1);
  assert.equal(programmZustand({ unitAktiv: true, log: '' }), 'laeuft');
  assert.equal(programmZustand({ unitAktiv: false, log: 'Update erfolgreich\nFAHNAS_ENDE 0\n' }), 'erfolg');
  assert.equal(programmZustand({ unitAktiv: false, log: 'Fehler: Prüfsumme\nFAHNAS_ENDE 1\n' }), 'fehler');
  assert.equal(programmZustand({ unitAktiv: false, log: 'Prüfsumme in Ordnung.\n' }), 'abgebrochen');
});

test('system.programm: Ticket (nur .tar.gz), Prüfen (Release? Version), Einspielen als eigene Unit, Status aus dem Protokoll', async () => {
  let unit = 'inactive';
  let liste = 'src/\nsrc/agent/\nsrc/agent/agent.js\nkatalog/quellen/fah-proxy/BUILD_VERSION\nBUILD_VERSION\n';
  const u = await umgebung({ antworten: {
    tar: (args) => ({ code: 0, stdout: args[0] === '-tzf' ? liste : args[2] === 'BUILD_VERSION' ? '9.9.10\n' : '0.8.6\n', stderr: '' }),
    systemctl: (args) => (args[0] === 'is-active' ? { code: unit === 'active' ? 0 : 3, stdout: `${unit}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }),
  } });
  try {
    assert.deepEqual(await u.rufe('system.programm.status'), { zustand: 'keins', version: '9.9.9' });
    await assert.rejects(u.rufe('system.programm.ticket', { dateiname: 'fah-nas.iso', groesse: 10 }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'dateiname');
    assert.throws(() => u.reg.vorbereiten('system.programm.ticket', { dateiname: 'a.tar.gz', groesse: 10 }, NUTZER), (e) => e.code === 'E_RECHTE');
    const tk = await u.rufe('system.programm.ticket', { dateiname: 'fahnas_release.tar.gz', groesse: 12 });
    assert.match(tk.kennung, /^programm-\d{8}-\d{6}-[0-9a-f]{6}$/); assert.ok(tk.ticket);
    const datei = path.join(u.konfigOrdner, 'eingang', `${tk.kennung}.tar.gz`);
    await fs.writeFile(datei, 'unvollständig');
    await assert.rejects(u.rufe('system.programm.pruefen', { kennung: tk.kennung }), (e) => e.code === 'E_ABGEBROCHEN');
    await fs.writeFile(datei, '123456789012');
    await assert.rejects(u.rufe('system.programm.pruefen', { kennung: tk.kennung }, { ...ADMIN, nutzer: 'anna' }), (e) => e.code === 'E_RECHTE');
    const r = await u.rufe('system.programm.pruefen', { kennung: tk.kennung });
    assert.deepEqual({ neu: r.version_neu, alt: r.version_alt, vergleich: r.vergleich, datei: r.dateiname }, { neu: '9.9.10', alt: '9.9.9', vergleich: 'neuer', datei: 'fahnas_release.tar.gz' });
    // kein Release → klare Meldung
    liste = 'irgendwas/\nBUILD_VERSION\n';
    await assert.rejects(u.rufe('system.programm.pruefen', { kennung: tk.kennung }), (e) => e.code === 'E_PARAMS' && /kein FAH-NAS-Release/.test(e.message));
    liste = 'src/agent/agent.js\nBUILD_VERSION\n';
    // laufende Aufgabe → erst warten
    const echteAufgaben = u.werkzeuge.aufgaben;
    u.werkzeuge.aufgaben = { liste: () => [{ id: 't-1', aktion: 'apps.installieren', status: 'laeuft' }] };
    await assert.rejects(u.rufe('system.programm.einspielen', { kennung: tk.kennung }), (e) => e.code === 'E_BELEGT' && /apps.installieren/.test(e.message));
    u.werkzeuge.aufgaben = echteAufgaben;
    // Einspielen: Prüfsumme daneben, Status, systemd-run mit eigener Unit
    const e = await u.rufe('system.programm.einspielen', { kennung: tk.kennung });
    assert.deepEqual(e, { gestartet: true, von: '9.9.9', nach: '9.9.10' });
    const sha = (await fs.readFile(`${datei}.sha256`, 'utf8')).split(/\s+/);
    assert.match(sha[0], /^[0-9a-f]{64}$/); assert.equal(sha[1], path.basename(datei));
    const lauf = aufrufe(u.befehle, 'systemd-run');
    assert.equal(lauf.length, 1);
    assert.ok(lauf[0].includes(`--unit=${PROGRAMM_UNIT}`) && lauf[0].includes('--collect'));
    assert.ok(lauf[0].includes(`--property=StandardOutput=truncate:${path.join(u.konfigOrdner, 'programm-update.log')}`));
    assert.deepEqual(lauf[0].slice(-2), [path.join('/opt/fahnas', 'tools', 'fahnas'), datei]);
    assert.ok(u.ereignisse.some((x) => x.ereignis === 'system' && x.art === 'programm_update'));
    await assert.rejects(u.rufe('system.programm.pruefen', { kennung: tk.kennung }), (x) => x.code === 'E_NICHT_GEFUNDEN', 'Kennung verbraucht');
    // Status: läuft → erfolgreich / fehlgeschlagen
    unit = 'active';
    assert.equal((await u.rufe('system.programm.status')).zustand, 'laeuft');
    await assert.rejects(u.rufe('system.programm.einspielen', { kennung: tk.kennung }), (x) => x.code === 'E_BELEGT');
    unit = 'inactive';
    await fs.writeFile(path.join(u.konfigOrdner, 'programm-update.log'), 'Prüfsumme in Ordnung.\nUpdate erfolgreich: Version 9.9.10 läuft.\nFAHNAS_ENDE 0\n');
    const s = await u.rufe('system.programm.status');
    assert.equal(s.zustand, 'erfolg'); assert.equal(s.von, '9.9.9'); assert.equal(s.nach, '9.9.10'); assert.equal(s.nutzer, 'fabian');
    assert.deepEqual(s.ausgabe, ['Prüfsumme in Ordnung.', 'Update erfolgreich: Version 9.9.10 läuft.']);
    await fs.writeFile(path.join(u.konfigOrdner, 'programm-update.log'), 'Fehler: Update fehlgeschlagen, alter Stand läuft wieder.\nFAHNAS_ENDE 1\n');
    assert.equal((await u.rufe('system.programm.status')).zustand, 'fehler');
    assert.equal(u.reg.hole('system.programm.status').lesend, true);
  } finally { await u.aufraeumen(); }
});

test('system.setzen docker_freigabe: speichert, rendert danach Samba (freigaben.apply); scheitert das, bleibt der Schalter aus', async () => {
  let kaputt = false;
  const u = await umgebung({ intern: { 'freigaben.apply': () => { if (kaputt) throw new FahnasFehler('E_RENDER', 'Samba lehnt ab'); return { samba_geaendert: true }; } } });
  try {
    assert.equal(STANDARD['system.json'].docker_freigabe, false);
    const r = await u.rufe('system.setzen', { aenderungen: { docker_freigabe: true } });
    assert.equal(r.docker_freigabe, true); assert.ok(r._gerendert.includes('samba'));
    assert.deepEqual(u.interne.map((x) => x.aktion), ['freigaben.apply']);
    await u.rufe('system.setzen', { aenderungen: { docker_freigabe: true } });
    assert.equal(u.interne.length, 1, 'unverändert → kein erneutes Rendern');
    kaputt = true;
    await assert.rejects(u.rufe('system.setzen', { aenderungen: { docker_freigabe: false } }), (e) => e.code === 'E_RENDER' && e.details.feld === 'docker_freigabe');
    assert.equal((await u.konfig.laden('system.json')).docker_freigabe, true, 'Schalter zurückgedreht');
  } finally { await u.aufraeumen(); }
});
