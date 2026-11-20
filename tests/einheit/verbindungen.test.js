// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/helfer/verbindungen.js (Weltkarte): conntrack-Ausgabe lesen, Verbindungen einer Richtung
// zuordnen (ein/aus, Heimnetz, Anycast, Container/Apps, VM), im 1-h-Fenster bündeln, Grenzen, Werkzeug nachinstallieren,
// Byte-Zähler einschalten. Alle Systemaufrufe, Dateien, Uhr und Ortsdaten sind Attrappen (läuft auf macOS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConntrack, klassifiziere, VerbindungsSammler, umgebungLesen, heimatAus, GRENZEN, ACCT_PROC, SYSCTL_DATEI, SYSCTL_TEXT,
} from '../../src/agent/helfer/verbindungen.js';
import { blockadeMessen } from './schleife_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const DATEN = path.join(HIER, '..', 'daten', 'conntrack');
const IPV4 = await fs.readFile(path.join(DATEN, 'ipv4.txt'), 'utf8');
const IPV6 = await fs.readFile(path.join(DATEN, 'ipv6.txt'), 'utf8');
const START = Date.parse('2026-09-26T10:00:00.000Z');
const HEIMAT = { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' };

/** Umgebung wie auf dem Mini-PC: Host 192.168.1.29 (+ IPv6 in nicht verkürzter Schreibweise), Docker-Brücke, it-tools. */
const UMGEBUNG = {
  eigene: new Set(['192.168.1.29', 'fe80::abcd', '2a02:8109:b6c0:1d00:0:0:0:29', '172.18.0.1']),
  container: new Map([['172.18.0.2', { name: 'it-tools' }]]),
  vmNetz: '192.168.122.0/24',
  appPorts: new Map([[8086, 'it-tools']]),
};

const ORTE = {
  '140.82.121.4': { land: 'DE', land_name: 'Deutschland', stadt: 'Frankfurt am Main', lat: 50.11, lon: 8.68, genau: 'stadt' },
  '151.101.1.69': { land: 'US', land_name: 'Vereinigte Staaten', stadt: 'San Francisco', lat: 37.77, lon: -122.42, genau: 'stadt' },
  '93.184.216.34': { land: 'US', land_name: 'Vereinigte Staaten', stadt: null, lat: 39.8, lon: -98.6, genau: 'land' },
  '2a00:1450:4001:82b::200e': { land: 'DE', land_name: 'Deutschland', stadt: 'Frankfurt am Main', lat: 50.11, lon: 8.68, genau: 'stadt' },
  '2a01:4f8:c0c:1234::1': { land: 'DE', land_name: 'Deutschland', stadt: 'Falkenstein', lat: 50.48, lon: 12.37, genau: 'stadt' },
};

/** Ortsdaten-Attrappe: merkt sich jede Suche; Stand umschaltbar (Monatswechsel der Datenbank). */
function geoAttrappe({ asynchron = false } = {}) {
  const g = { gefragt: [], stand: '2026-09' };
  g.suche = (ip) => { g.gefragt.push(ip); const o = ORTE[ip] ? { ...ORTE[ip] } : null; return asynchron ? Promise.resolve(o) : o; };
  g.status = () => ({ quelle: 'stadt', stand: g.stand, hinweis: null });
  return g;
}

/** Fehler wie system.befehl (E_SYSTEM, Ausgabe des Befehls in details.ausgabe). */
const systemFehler = (programm, ausgabe) => Object.assign(new Error(`Befehl ${programm} schlug fehl`), { code: 'E_SYSTEM', details: { code: 1, ausgabe } });

/**
 * system.ausfuehren-Attrappe: conntrack (--version, -L je Familie), apt-get installiert conntrack. systemd-run fehlt
 * (ENOENT → Rückfall auf apt-get im Agenten), außer `systemdRun`: dann startet es eine „Unit“ (zustand.unit =
 * 'active', bis der Test sie beendet); läuft schon eine, meldet es wie systemd „already loaded“. systemctl show liefert
 * den ActiveState der Unit.
 */
function systemAttrappe({ v4 = IPV4, v6 = IPV6, conntrackDa = true, systemdRun = false } = {}) {
  const zustand = { v4, v6, conntrackDa, systemdRun, unit: null,
    schonDa: 'Failed to start transient service unit: Unit fahnas-conntrack-installation.service was already loaded or has a fragment file.' };
  const aufrufe = [];
  const fehlt = (p) => Object.assign(new Error(`spawn ${p} ENOENT`), { code: 'ENOENT' });
  const sys = {
    zustand, aufrufe,
    ausfuehren: async (programm, args = [], o = {}) => {
      aufrufe.push({ programm, args, umgebung: o.umgebung, zeitlimit_ms: o.zeitlimit_ms, maxBuffer: o.maxBuffer });
      if (programm === 'conntrack') {
        if (!zustand.conntrackDa) throw fehlt('conntrack');
        if (args[0] === '--version') return { code: 0, stdout: 'conntrack v1.4.8 (conntrack-tools)\n', stderr: '' };
        if (args[0] === '-L') return { code: 0, stdout: args.includes('ipv6') ? zustand.v6 : zustand.v4, stderr: '' };
      }
      if (programm === 'apt-get') { if (args.includes('install')) zustand.conntrackDa = true; return { code: 0, stdout: '', stderr: '' }; }
      if (programm === 'systemd-run') {
        if (zustand.systemdRun === false) throw fehlt('systemd-run');
        if (zustand.systemdRun instanceof Error) throw zustand.systemdRun;
        if (zustand.unit) throw systemFehler('systemd-run', zustand.schonDa);
        zustand.unit = 'active';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (programm === 'systemctl' && args[0] === 'show') {
        if (typeof zustand.beimZeigen === 'function') zustand.beimZeigen();
        return { code: 0, stdout: `${zustand.unit ?? 'inactive'}\n`, stderr: '' };
      }
      throw new Error(`unerwarteter Aufruf ${programm} ${args.join(' ')}`);
    },
  };
  return sys;
}

/** Dateien-Attrappe für /proc und /etc/sysctl.d. */
function dateienAttrappe(start = { [ACCT_PROC]: '1\n', [SYSCTL_DATEI]: SYSCTL_TEXT }) {
  const inhalt = new Map(Object.entries(start));
  const geschrieben = [];
  return {
    inhalt, geschrieben,
    lesen: async (p) => { if (!inhalt.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); return inhalt.get(p); },
    schreiben: async (p, text) => { geschrieben.push([p, text]); inhalt.set(p, text); },
  };
}

function neuerSammler(o = {}) {
  let zeit = START;
  const uhr = { jetzt: () => zeit, vor: (ms) => { zeit += ms; } };
  const system = o.system ?? systemAttrappe();
  const geo = 'geo' in o ? o.geo : geoAttrappe();
  const dateien = o.dateien ?? dateienAttrappe();
  const meldungen = [];
  const umgebungAufrufe = { n: 0 };
  const s = new VerbindungsSammler({
    system, geo, jetzt: uhr.jetzt, dateien, intervall_ms: o.intervall_ms,
    umgebungHolen: async () => { umgebungAufrufe.n++; return o.umgebung ?? UMGEBUNG; },
    standortHolen: () => HEIMAT, aufzeichnenHolen: o.aufzeichnenHolen ?? (() => true), protokoll: (t) => meldungen.push(t),
  });
  return { s, uhr, system, geo, dateien, meldungen, umgebungAufrufe };
}

const zeilen = (text) => text.split('\n').filter(Boolean);
const finde = (e, ip) => e.gegenstellen.find((g) => g.ip === ip);

// ---------------------------------------------------------------------------------------------------------------
// parseConntrack
// ---------------------------------------------------------------------------------------------------------------

test('parseConntrack: orig/antwort mit Zahlen, Zustand, UNREPLIED, ICMP ohne Ports, IPv6, unbekanntes Protokoll', () => {
  const v4 = parseConntrack(IPV4);
  assert.equal(v4.length, zeilen(IPV4).length);
  assert.deepEqual(v4[0], {
    familie: 'ipv4', proto: 'tcp', zustand: 'ESTABLISHED', unbeantwortet: false,
    orig: { src: '192.168.1.29', dst: '140.82.121.4', sport: 51234, dport: 443, packets: 12, bytes: 3456 },
    antwort: { src: '140.82.121.4', dst: '192.168.1.29', sport: 443, dport: 51234, packets: 10, bytes: 45678 },
  });
  const udp = v4.find((e) => e.proto === 'udp' && e.orig.dst === '192.168.1.1');
  assert.equal(udp.zustand, null, 'UDP hat keinen Zustand');
  assert.equal(udp.antwort.bytes, 300);
  const unbeantwortet = v4.find((e) => e.orig.dst === '1.1.1.1');
  assert.equal(unbeantwortet.unbeantwortet, true);
  assert.equal(unbeantwortet.antwort.src, '1.1.1.1', 'die Antwortrichtung beginnt erst nach [UNREPLIED]');
  const icmp = v4.find((e) => e.proto === 'icmp');
  assert.deepEqual(icmp.orig, { src: '192.168.1.29', dst: '8.8.8.8', sport: null, dport: null, packets: 1, bytes: 84 });
  const dnat = v4.find((e) => e.orig.dport === 8086);
  assert.equal(dnat.zustand, 'SYN_RECV'); assert.equal(dnat.antwort.src, '172.18.0.2'); assert.equal(dnat.antwort.sport, 80);
  const igmp = v4.find((e) => e.proto === 'unknown');
  assert.ok(igmp && igmp.unbeantwortet && igmp.orig.sport === null);
  const v6 = parseConntrack(IPV6);
  assert.equal(v6.length, zeilen(IPV6).length);
  assert.equal(v6[0].familie, 'ipv6');
  assert.equal(v6[0].orig.dst, '2a00:1450:4001:82b::200e');
  assert.equal(v6.find((e) => e.proto === 'icmpv6').antwort.src, '2606:4700:4700::1111');
});

test('parseConntrack: unbekannte Zeilen, Windows-Zeilenenden, fehlende Zähler (acct aus), Zustand mit Ziffer', () => {
  const text = [
    'conntrack v1.4.8 (conntrack-tools): 3 flow entries have been shown.',
    '',
    'Müll ohne Aufbau',
    'ipv4     2 tcp      6 10 ESTABLISHED src=1.2.3.4 dst=5.6.7.8 sport=1 dport=2',          // nur eine Richtung
    'ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.29 dst=140.82.121.4 sport=1 dport=443 src=140.82.121.4 dst=192.168.1.29 sport=443 dport=1 [ASSURED] mark=0 use=1\r',
    'ipv4     2 tcp      6 119 SYN_SENT2 src=192.168.1.29 dst=140.82.121.5 sport=2 dport=443 packets=1 bytes=60 src=140.82.121.5 dst=192.168.1.29 sport=443 dport=2 packets=1 bytes=60 mark=0 use=1',
    'ipv6     10 udp      17 20 src=2a02:8109:b6c0:1d00::29 dst=2a00:1450::1 sport=5000 dport=443 packets=1 bytes=1200 src=2a00:1450::1 dst=2a02:8109:b6c0:1d00::29 sport=443 dport=5000 packets=1 bytes=1300 zone=0 mark=0 use=1',
  ].join('\n');
  const e = parseConntrack(text);
  assert.equal(e.length, 3);
  assert.deepEqual(e[0].orig, { src: '192.168.1.29', dst: '140.82.121.4', sport: 1, dport: 443, packets: 0, bytes: 0 });
  assert.equal(e[0].antwort.dport, 1, 'kein \\r im letzten Wert');
  assert.equal(e[1].zustand, 'SYN_SENT2');
  assert.equal(e[2].antwort.bytes, 1300);
  assert.deepEqual(parseConntrack(''), []);
  assert.deepEqual(parseConntrack(undefined), []);
});

// ---------------------------------------------------------------------------------------------------------------
// klassifiziere
// ---------------------------------------------------------------------------------------------------------------

test('klassifiziere: Richtung, Gegenstelle und lokale Seite für alle Beispielzeilen (IPv4)', () => {
  const [github, smb, npm, containerAus, dnat, dnsAnycast, dnsRouter, ping, loopback, resolved, hostContainer, vm, igmp] = parseConntrack(IPV4).map((e) => klassifiziere(e, UMGEBUNG));
  assert.deepEqual(github, { richtung: 'aus', fern: { ip: '140.82.121.4', port: 443 }, lokal: { name: 'FAH-NAS', art: 'host' } });
  assert.deepEqual(smb, { richtung: 'ein', fern: { ip: '192.168.1.79', port: 60522 }, lokal: { name: 'SMB', art: 'dienst' }, dienst: 445 });
  assert.deepEqual(npm, { richtung: 'ein', fern: { ip: '192.168.1.23', port: 41000 }, lokal: { name: 'Web', art: 'dienst' }, dienst: 443 });
  assert.deepEqual(containerAus, { richtung: 'aus', fern: { ip: '151.101.1.69', port: 443 }, lokal: { name: 'it-tools', art: 'app' } });
  assert.deepEqual(dnat, { richtung: 'ein', fern: { ip: '203.0.113.9', port: 55555 }, lokal: { name: 'it-tools', art: 'app' }, dienst: 8086 });
  assert.equal(dnsAnycast, null, 'UNREPLIED wird verworfen');
  assert.deepEqual(dnsRouter, { richtung: 'aus', fern: { ip: '192.168.1.1', port: 53 }, lokal: { name: 'FAH-NAS', art: 'host' } });
  assert.deepEqual(ping, { richtung: 'aus', fern: { ip: '8.8.8.8', port: null }, lokal: { name: 'FAH-NAS', art: 'host' } });
  assert.equal(loopback, null, 'Loopback');
  assert.equal(resolved, null, '127.0.0.53 (systemd-resolved) gehört zum Host');
  assert.equal(hostContainer, null, 'Host ↔ Container');
  assert.deepEqual(vm, { richtung: 'aus', fern: { ip: '93.184.216.34', port: 443 }, lokal: { name: 'VM', art: 'vm' } });
  assert.equal(igmp, null);
});

test('klassifiziere: IPv6 (Schreibweisen, Link-Local, Anycast) und Rückfälle für die lokale Seite', () => {
  const [google, ssh, anycast, mdns, web] = parseConntrack(IPV6).map((e) => klassifiziere(e, UMGEBUNG));
  assert.deepEqual(google, { richtung: 'aus', fern: { ip: '2a00:1450:4001:82b::200e', port: 443 }, lokal: { name: 'FAH-NAS', art: 'host' } },
    'eigene Adresse in nicht verkürzter Schreibweise wird erkannt');
  assert.deepEqual(ssh, { richtung: 'ein', fern: { ip: 'fe80::1', port: 50000 }, lokal: { name: 'SSH', art: 'dienst' }, dienst: 22 });
  assert.equal(anycast.richtung, 'aus'); assert.equal(anycast.fern.ip, '2606:4700:4700::1111'); assert.equal(anycast.fern.port, null);
  assert.equal(mdns, null);
  assert.deepEqual(web.lokal, { name: 'Web', art: 'dienst' });
  // Zonen-ID und Großschreibung in der Umgebung
  const u2 = { ...UMGEBUNG, eigene: new Set(['FE80::ABCD%eno1']) };
  assert.equal(klassifiziere(parseConntrack(IPV6)[1], u2).richtung, 'ein');
  // DNAT ohne eingetragenen App-Port: Name des Containers aus der Antwortrichtung
  const dnat = parseConntrack(IPV4).find((e) => e.orig.dport === 8086);
  assert.deepEqual(klassifiziere(dnat, { ...UMGEBUNG, appPorts: new Map() }).lokal, { name: 'it-tools', art: 'app' });
  // unbekannter Port ohne App → „Port N“; ICMP an den NAS → „ICMP“
  const fremd = parseConntrack('ipv4 2 tcp 6 100 ESTABLISHED src=192.168.1.50 dst=192.168.1.29 sport=4000 dport=9999 packets=1 bytes=1 src=192.168.1.29 dst=192.168.1.50 sport=9999 dport=4000 packets=1 bytes=1 mark=0 use=1')[0];
  assert.deepEqual(klassifiziere(fremd, UMGEBUNG).lokal, { name: 'Port 9999', art: 'dienst' });
  const ping = parseConntrack('ipv4 2 icmp 1 29 src=192.168.1.50 dst=192.168.1.29 type=8 code=0 id=9 packets=1 bytes=84 src=192.168.1.29 dst=192.168.1.50 type=0 code=0 id=9 packets=1 bytes=84 mark=0 use=1')[0];
  assert.deepEqual(klassifiziere(ping, UMGEBUNG).lokal, { name: 'ICMP', art: 'dienst' });
  // weitergeleiteter Fremdverkehr (weder Quelle noch Ziel eigen) und Unsinn
  const durch = parseConntrack('ipv4 2 tcp 6 100 ESTABLISHED src=192.168.1.50 dst=192.168.1.60 sport=1 dport=2 packets=1 bytes=1 src=192.168.1.60 dst=192.168.1.50 sport=2 dport=1 packets=1 bytes=1 mark=0 use=1')[0];
  assert.equal(klassifiziere(durch, UMGEBUNG), null);
  assert.equal(klassifiziere(null, UMGEBUNG), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Sammler: Aggregation, Ergebnis, Grenzen
// ---------------------------------------------------------------------------------------------------------------

test('Sammler: gleiches Tupel zählt einmal, Bytes = Höchststand je Tupel, neues Tupel zählt dazu, Ablauf nach 1 h ohne Sichtung', async () => {
  const zeile = (sport, bytes) => `ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.29 dst=140.82.121.4 sport=${sport} dport=443 packets=1 bytes=${bytes} src=140.82.121.4 dst=192.168.1.29 sport=443 dport=${sport} packets=1 bytes=1000 [ASSURED] mark=0 use=1\n`;
  const system = systemAttrappe({ v4: zeile(51234, 500), v6: '' });
  const { s, uhr } = neuerSammler({ system });
  assert.equal(await s.probe(), true);
  uhr.vor(10_000); system.zustand.v4 = zeile(51234, 900); await s.probe();
  let g = finde(s.ergebnis('aus'), '140.82.121.4');
  assert.equal(g.anzahl, 1); assert.equal(g.bytes, 1900);
  uhr.vor(10_000); system.zustand.v4 = zeile(51234, 100); await s.probe();
  assert.equal(finde(s.ergebnis('aus'), '140.82.121.4').bytes, 1900, 'Höchststand bleibt, auch wenn der Zähler neu beginnt');
  uhr.vor(10_000); system.zustand.v4 = zeile(51234, 100) + zeile(51235, 50); await s.probe();
  g = finde(s.ergebnis('aus'), '140.82.121.4');
  assert.equal(g.anzahl, 2); assert.equal(g.bytes, 1900 + 1050);
  assert.equal(g.erst, '2026-09-26T10:00:00.000Z'); assert.equal(g.zuletzt, '2026-09-26T10:00:30.000Z');
  assert.deepEqual(g.lokal, [{ name: 'FAH-NAS', art: 'host', anzahl: 2 }]);
  // 30 min lang nur noch das zweite Tupel, dann Ruhe: nach 1 h ohne Sichtung fällt erst das erste, dann alles weg
  uhr.vor(30 * 60_000); system.zustand.v4 = zeile(51235, 60); await s.probe();
  system.zustand.v4 = '';
  uhr.vor(31 * 60_000); await s.probe();
  g = finde(s.ergebnis('aus'), '140.82.121.4');
  assert.equal(g.anzahl, 1, 'das erste Tupel ist seit über 1 h nicht mehr gesehen');
  assert.equal(g.bytes, 1060);
  uhr.vor(30 * 60_000); await s.probe();
  assert.equal(s.ergebnis('aus').gegenstellen.length, 0);
  assert.deepEqual(s.ergebnis('aus').summe, { anzahl: 0, bytes: 0, gegenstellen: 0 });
  assert.deepEqual(s.statistik(), { tupel: 0, gegenstellen: 0 });
});

test('Sammler.ergebnis(aus): Vertragsform §4.6, Orte, Heimnetz privat, Anycast ohne Ort, UNREPLIED fehlt, Absender', async () => {
  const { s, geo } = neuerSammler();
  await s.probe();
  const e = s.ergebnis('aus');
  assert.deepEqual(Object.keys(e).sort(), ['aufzeichnung', 'fenster_s', 'gegenstellen', 'geo', 'heimat', 'lokal', 'richtung', 'summe', 'werkzeug', 'zeit']);
  assert.equal(e.richtung, 'aus'); assert.equal(e.zeit, '2026-09-26T10:00:00.000Z'); assert.equal(e.fenster_s, 3600);
  assert.equal(e.aufzeichnung, true);
  assert.deepEqual(e.werkzeug, { ok: true, hinweis: null });
  assert.deepEqual(e.geo, { quelle: 'stadt', stand: '2026-09', hinweis: null });
  assert.deepEqual(e.heimat, HEIMAT);
  assert.deepEqual(finde(e, '140.82.121.4'), {
    ip: '140.82.121.4', privat: false, anycast: false, ort: ORTE['140.82.121.4'], anzahl: 1, bytes: 3456 + 45678,
    erst: '2026-09-26T10:00:00.000Z', zuletzt: '2026-09-26T10:00:00.000Z', lokal: [{ name: 'FAH-NAS', art: 'host', anzahl: 1 }],
  });
  assert.deepEqual(finde(e, '192.168.1.1'), {
    ip: '192.168.1.1', privat: true, anycast: false, ort: null, anzahl: 1, bytes: 440,
    erst: '2026-09-26T10:00:00.000Z', zuletzt: '2026-09-26T10:00:00.000Z', lokal: [{ name: 'FAH-NAS', art: 'host', anzahl: 1 }],
  });
  assert.equal(finde(e, '1.1.1.1'), undefined, 'unbeantwortete DNS-Anfrage erscheint nicht');
  const anycast = finde(e, '8.8.8.8');
  assert.equal(anycast.anycast, true); assert.equal(anycast.ort, null); assert.equal(anycast.privat, false);
  assert.equal(finde(e, '2606:4700:4700::1111').anycast, true);
  assert.deepEqual(finde(e, '151.101.1.69').lokal, [{ name: 'it-tools', art: 'app', anzahl: 1 }]);
  assert.deepEqual(finde(e, '93.184.216.34').lokal, [{ name: 'VM', art: 'vm', anzahl: 1 }]);
  assert.deepEqual(finde(e, '2a00:1450:4001:82b::200e').ort, ORTE['2a00:1450:4001:82b::200e']);
  assert.equal(finde(e, '192.168.1.79'), undefined, 'eingehende Gegenstellen stehen nicht in „aus“');
  // Ortssuche nie für private und Anycast-Adressen
  for (const ip of ['192.168.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.ok(!geo.gefragt.includes(ip), ip);
  const namen = e.lokal.map((l) => `${l.art}:${l.name}`).sort();
  assert.deepEqual(namen, ['app:it-tools', 'host:FAH-NAS', 'vm:VM']);
  const host = e.lokal.find((l) => l.name === 'FAH-NAS');
  assert.equal(host.anzahl, 5); // GitHub, Router-DNS, Ping, Google IPv6, Anycast IPv6
  assert.equal(host.bytes, (3456 + 45678) + 440 + 168 + 64000 + 208);
  assert.deepEqual(e.summe, { anzahl: 7, bytes: e.gegenstellen.reduce((a, g) => a + g.bytes, 0), gegenstellen: 7 });
});

test('Sammler.ergebnis(ein): Heimnetz, DNAT auf Container, Link-Local, Dienste', async () => {
  const { s } = neuerSammler();
  await s.probe();
  const e = s.ergebnis('ein');
  assert.deepEqual(finde(e, '192.168.1.79'), {
    ip: '192.168.1.79', privat: true, anycast: false, ort: null, anzahl: 1, bytes: 129000,
    erst: '2026-09-26T10:00:00.000Z', zuletzt: '2026-09-26T10:00:00.000Z', lokal: [{ name: 'SMB', art: 'dienst', anzahl: 1 }],
  });
  assert.deepEqual(finde(e, '192.168.1.23').lokal, [{ name: 'Web', art: 'dienst', anzahl: 1 }]);
  const angreifer = finde(e, '203.0.113.9');
  assert.ok(angreifer, 'SYN_RECV ohne [UNREPLIED] zählt');
  assert.deepEqual(angreifer.lokal, [{ name: 'it-tools', art: 'app', anzahl: 1 }]);
  assert.deepEqual(finde(e, 'fe80::1').lokal, [{ name: 'SSH', art: 'dienst', anzahl: 1 }]);
  assert.equal(finde(e, 'fe80::1').privat, true);
  assert.deepEqual(finde(e, '2a01:4f8:c0c:1234::1').ort, ORTE['2a01:4f8:c0c:1234::1']);
  const dienste = Object.fromEntries(e.lokal.map((l) => [l.name, l.anzahl]));
  assert.deepEqual(dienste, { Web: 2, SMB: 1, 'it-tools': 1, SSH: 1 });
  assert.equal(e.lokal[0].name, 'Web', 'lokal nach Anzahl absteigend');
  assert.equal(e.summe.gegenstellen, 5);
});

test('Sammler: Ortssuche einmal je Gegenstelle (Zwischenspeicher), erneut nach Stand-Wechsel der Ortsdaten; asynchrone suche geht', async () => {
  const geo = geoAttrappe({ asynchron: true });
  const { s, uhr } = neuerSammler({ geo });
  await s.probe();
  assert.deepEqual(finde(s.ergebnis('aus'), '140.82.121.4').ort, ORTE['140.82.121.4']);
  const vorher = geo.gefragt.filter((ip) => ip === '140.82.121.4').length;
  assert.equal(vorher, 1);
  uhr.vor(10_000); await s.probe();
  assert.equal(geo.gefragt.filter((ip) => ip === '140.82.121.4').length, 1, 'kein zweites Mal');
  geo.stand = '2026-10';
  uhr.vor(10_000); await s.probe();
  assert.equal(geo.gefragt.filter((ip) => ip === '140.82.121.4').length, 2, 'neue Datenbank → neu suchen');
  // Ortsdaten ohne gültige Koordinaten → kein Ort
  const kaputt = { suche: () => ({ land: 'DE', lat: 'x' }), status: () => ({ quelle: 'land', stand: null, hinweis: null }) };
  const { s: s2 } = neuerSammler({ geo: kaputt });
  await s2.probe();
  assert.equal(finde(s2.ergebnis('aus'), '140.82.121.4').ort, null);
  // ohne Geo-Objekt: keine Orte, Status „keine“
  const { s: s3 } = neuerSammler({ geo: null });
  await s3.probe();
  assert.equal(finde(s3.ergebnis('aus'), '140.82.121.4').ort, null);
  assert.deepEqual(s3.ergebnis('aus').geo, { quelle: 'keine', stand: null, hinweis: null });
});

test('Grenzen: 25 000 Zeilen → Lesen + Bündeln < 1 s, höchstens 20 000 Tupel und 5 000 Gegenstellen (älteste zuerst), Ergebnis ≤ 500 nach zuletzt absteigend', async () => {
  const zeile = (i, n) => {
    const ip = `20.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
    return `ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.29 dst=${ip} sport=${10_000 + i} dport=443 packets=3 bytes=300 src=${ip} dst=192.168.1.29 sport=443 dport=${10_000 + i} packets=3 bytes=900 [ASSURED] mark=0 use=1`;
  };
  // a) 25 000 Verbindungen zu 1 000 Gegenstellen → Tupel-Grenze: die ältesten 5 000 Verbindungen fliegen
  const sysA = systemAttrappe({ v4: Array.from({ length: 25_000 }, (_, i) => zeile(i, i % 1000)).join('\n'), v6: '' });
  const a = neuerSammler({ system: sysA });
  // Rechenzeit des Prozesses statt Wanduhr: die Suite läuft parallel in vielen Prozessen, die Wanduhr misst dann die
  // Last der Nachbarn mit
  const rechenzeit = async (fn) => { const c0 = process.cpuUsage(); await fn(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; };
  let dauer = await rechenzeit(async () => assert.equal(await a.s.probe(), true));
  assert.ok(dauer < 1000, `Probe mit 25 000 Zeilen kostete ${Math.round(dauer)} ms Rechenzeit`);
  assert.deepEqual(a.s.statistik(), { tupel: GRENZEN.tupel, gegenstellen: 1000 });
  assert.equal(finde(a.s.ergebnis('aus'), '20.0.0.0').anzahl, 20, 'je Gegenstelle 25 Verbindungen, die ersten 5 sind weg');
  // b) 25 000 Verbindungen zu 7 000 Gegenstellen → Gegenstellen-Grenze: die ältesten fliegen zuerst (samt Verbindungen)
  const nB = (i) => (i < 20_000 ? i % 2000 : 2000 + (i - 20_000));
  const sysB = systemAttrappe({ v4: Array.from({ length: 25_000 }, (_, i) => zeile(i, nB(i))).join('\n'), v6: '' });
  const b = neuerSammler({ system: sysB });
  dauer = await rechenzeit(async () => assert.equal(await b.s.probe(), true));
  assert.ok(dauer < 1000, `Probe mit 25 000 Zeilen kostete ${Math.round(dauer)} ms Rechenzeit`);
  assert.equal(b.s.statistik().gegenstellen, GRENZEN.gegenstellen);
  assert.ok(b.s.statistik().tupel <= GRENZEN.tupel);
  // zweite Probe: nur 300 der jüngsten Verbindungen sind noch da → diese Gegenstellen stehen vorn
  b.uhr.vor(10_000);
  sysB.zustand.v4 = Array.from({ length: 300 }, (_, k) => zeile(20_000 + k, nB(20_000 + k))).join('\n');
  await b.s.probe();
  const e = b.s.ergebnis('aus');
  assert.equal(e.gegenstellen.length, GRENZEN.ergebnis);
  assert.equal(e.summe.gegenstellen, GRENZEN.gegenstellen);
  for (let i = 1; i < e.gegenstellen.length; i++) assert.ok(e.gegenstellen[i - 1].zuletzt >= e.gegenstellen[i].zuletzt, `Reihenfolge an Stelle ${i}`);
  assert.equal(e.gegenstellen[0].zuletzt, '2026-09-26T10:00:10.000Z');
  assert.equal(e.gegenstellen.filter((g) => g.zuletzt === '2026-09-26T10:00:10.000Z').length, 300);
  assert.equal(GRENZEN.tupel, 20_000); assert.equal(GRENZEN.gegenstellen, 5_000); assert.equal(GRENZEN.ergebnis, 500);
  // c) „älteste zuerst“ über Proben hinweg: 1 000 eingehende (t0), 1 000 eingehende (t0+10 s), 4 000 ausgehende (t0+20 s)
  // → 6 000 > 5 000: genau die 1 000 ältesten (erste Welle) fliegen
  const ein = (i, n) => {
    const ip = `30.0.${(n >> 8) & 255}.${n & 255}`;
    return `ipv4 2 tcp 6 100 ESTABLISHED src=${ip} dst=192.168.1.29 sport=${20_000 + i} dport=443 packets=1 bytes=1 src=192.168.1.29 dst=${ip} sport=443 dport=${20_000 + i} packets=1 bytes=1 mark=0 use=1`;
  };
  const sysC = systemAttrappe({ v4: Array.from({ length: 1000 }, (_, i) => ein(i, i)).join('\n'), v6: '' });
  const c = neuerSammler({ system: sysC });
  await c.s.probe();
  c.uhr.vor(10_000); sysC.zustand.v4 = Array.from({ length: 1000 }, (_, i) => ein(i, 1000 + i)).join('\n'); await c.s.probe();
  c.uhr.vor(10_000); sysC.zustand.v4 = Array.from({ length: 4000 }, (_, i) => zeile(i, i)).join('\n'); await c.s.probe();
  const eEin = c.s.ergebnis('ein');
  assert.equal(eEin.summe.gegenstellen, 1000);
  assert.ok(eEin.gegenstellen.every((g) => g.zuletzt === '2026-09-26T10:00:10.000Z'), 'nur die zweite Welle ist noch da');
  assert.equal(c.s.ergebnis('aus').summe.gegenstellen, 4000);
});

// ---------------------------------------------------------------------------------------------------------------
// Große Tabellen und Teil-Ausfälle (Prüfbericht 26.09.)
// ---------------------------------------------------------------------------------------------------------------

/** Ausgehende IPv4-Verbindung Nr. i zur Gegenstelle `ziel`. */
const aus4 = (i, ziel) => `ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.29 dst=${ziel} sport=${1024 + (i % 60_000)} dport=${443 + Math.floor(i / 60_000)} packets=3 bytes=300 src=${ziel} dst=192.168.1.29 sport=${443 + Math.floor(i / 60_000)} dport=${1024 + (i % 60_000)} packets=3 bytes=900 [ASSURED] mark=0 use=1`;
/** Halb offene IPv6-Verbindung (SYN-Flut) von lauter verschiedenen Adressen – der teuerste Fall je Zeile. */
const synV6 = (i) => {
  const a = `2a00:1450:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::${((i * 7) & 0xffff).toString(16)}`; const sp = 1024 + (i % 60_000);
  return `ipv6     10 tcp      6 58 SYN_RECV src=${a} dst=2a02:8109:b6c0:1d00::29 sport=${sp} dport=443 packets=1 bytes=60 src=2a02:8109:b6c0:1d00::29 dst=${a} sport=443 dport=${sp} packets=1 bytes=60 mark=0 use=1`;
};

test('Große Tabelle: höchstens 30 000 Zeilen je Familie und Probe, Rest verworfen; Hinweis + gekuerzt:true, sonst nicht', async () => {
  assert.equal(GRENZEN.zeilen, 30_000);
  // 30 000 Zeilen zu 20.0.0.1, danach 500 zu 20.0.0.2 → die 500 fallen weg; IPv6 (eigene Grenze) wird trotzdem gelesen
  const v4 = Array.from({ length: 30_500 }, (_, i) => aus4(i, i < 30_000 ? '20.0.0.1' : '20.0.0.2')).join('\n');
  const system = systemAttrappe({ v4, v6: IPV6 });
  const { s, uhr } = neuerSammler({ system });
  assert.equal(await s.probe(), true);
  let e = s.ergebnis('aus');
  assert.ok(finde(e, '20.0.0.1'), 'die ersten 30 000 Zeilen zählen');
  assert.equal(finde(e, '20.0.0.2'), undefined, 'der Rest wird verworfen');
  assert.ok(finde(e, '2a00:1450:4001:82b::200e'), 'IPv6 hat ihre eigene Grenze');
  assert.equal(e.werkzeug.ok, true);
  assert.equal(e.werkzeug.gekuerzt, true);
  assert.equal(e.werkzeug.hinweis, 'Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet');
  assert.deepEqual(s.werkzeugStatus(), e.werkzeug);
  // genau 30 000 Zeilen (mit Zeilenende und Leerzeilen am Schluss) sind nicht gekürzt; der Hinweis verschwindet wieder
  uhr.vor(10_000);
  system.zustand.v4 = `${Array.from({ length: 30_000 }, (_, i) => aus4(i, '20.0.0.3')).join('\n')}\n\n\r\n`;
  await s.probe();
  e = s.ergebnis('aus');
  assert.ok(finde(e, '20.0.0.3'));
  assert.deepEqual(e.werkzeug, { ok: true, hinweis: null });
  // Leerzeilen zählen nicht mit: 30 000 Einträge mit Leerzeilen dazwischen werden alle gelesen
  uhr.vor(10_000);
  system.zustand.v4 = Array.from({ length: 30_000 }, (_, i) => aus4(i, i === 29_999 ? '20.0.0.4' : '20.0.0.3')).join('\n\n');
  await s.probe();
  assert.ok(finde(s.ergebnis('aus'), '20.0.0.4'));
  assert.deepEqual(s.werkzeugStatus(), { ok: true, hinweis: null });
});

test('conntrack -L mit eigenem Ausgabepuffer (64 MiB); --version braucht keinen', async () => {
  const { s, system } = neuerSammler();
  await s.probe();
  const liste = system.aufrufe.filter((x) => x.programm === 'conntrack' && x.args[0] === '-L');
  assert.equal(liste.length, 2);
  for (const x of liste) assert.equal(x.maxBuffer, 64 * 1024 * 1024, x.args.join(' '));
});

test('Nur eine Familie nicht lesbar (z. B. Ausgabe zu groß): die andere wird ausgewertet, Hinweis nennt die Familie, Protokoll einmal', async () => {
  for (const [kaputt, heil, text, heilIp] of [['ipv4', 'ipv6', 'IPv4', '2a00:1450:4001:82b::200e'], ['ipv6', 'ipv4', 'IPv6', '140.82.121.4']]) {
    const system = systemAttrappe();
    let aus = true;
    system.ausfuehren = ((echt) => async (p, a, o) => {
      const familie = a.includes('ipv6') ? 'ipv6' : 'ipv4';
      if (aus && p === 'conntrack' && a[0] === '-L' && familie === kaputt) {
        system.aufrufe.push({ programm: p, args: a });
        throw Object.assign(new Error('Befehl conntrack schlug fehl'), { code: 'E_SYSTEM', details: { ausgabe: 'stdout maxBuffer length exceeded' } });
      }
      return echt(p, a, o);
    })(system.ausfuehren);
    const { s, uhr, meldungen } = neuerSammler({ system });
    assert.equal(await s.probe(), true, `${kaputt} kaputt, ${heil} heil → gelesen`);
    assert.ok(finde(s.ergebnis('aus'), heilIp), `${heil} ausgewertet`);
    assert.deepEqual(s.werkzeugStatus(), { ok: true, hinweis: `${text}-Verbindungen gerade nicht lesbar.` });
    uhr.vor(10_000); await s.probe();
    const zeilen = meldungen.filter((m) => m.includes(text));
    assert.equal(zeilen.length, 1, `einmal protokolliert: ${meldungen.join(' | ')}`);
    assert.match(zeilen[0], /maxBuffer/, 'Ursache steht im Protokoll');
    aus = false;
    uhr.vor(10_000); await s.probe();
    assert.deepEqual(s.werkzeugStatus(), { ok: true, hinweis: null }, 'wieder lesbar → Hinweis weg');
  }
  // gekürzt UND eine Familie kaputt → beide Hinweise
  const system = systemAttrappe({ v4: Array.from({ length: 30_001 }, (_, i) => aus4(i, '20.0.0.1')).join('\n') });
  system.ausfuehren = ((echt) => async (p, a, o) => { if (p === 'conntrack' && a.includes('ipv6')) throw new Error('kaputt'); return echt(p, a, o); })(system.ausfuehren);
  const { s } = neuerSammler({ system });
  await s.probe();
  assert.deepEqual(s.werkzeugStatus(), { ok: true, gekuerzt: true, hinweis: 'IPv6-Verbindungen gerade nicht lesbar. Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet' });
});

test('Große Tabellen (je 120 000 Zeilen IPv4 + IPv6-SYN-Flut): die Ereignisschleife steht nie länger als 200 ms', async () => {
  const v4 = Array.from({ length: 120_000 }, (_, i) => aus4(i, `${1 + (i % 200)}.${(i >> 8) & 255}.${i & 255}.${(i * 7) & 255}`)).join('\n');
  const v6 = Array.from({ length: 120_000 }, (_, i) => synV6(i)).join('\n');
  const umgebung = { ...UMGEBUNG, eigene: new Set([...UMGEBUNG.eigene, '2a02:8109:b6c0:1d00::29']) };
  const { s, uhr } = neuerSammler({ system: systemAttrappe({ v4, v6 }), umgebung });
  for (let p = 0; p < 2; p++) {
    // größte Lücke im 5-ms-Takt (setInterval), bereinigt um Verdrängung durch fremde Last (siehe schleife_hilfen.js)
    const m = await blockadeMessen(() => s.probe());
    assert.equal(m.ergebnis, true);
    assert.ok(m.luecke < 200, `Probe ${p + 1}: Ereignisschleife blockiert bis ${Math.round(m.luecke)} ms (Wanduhr ${Math.round(m.wandLuecke)} ms, Probe ${Math.round(m.rechen)} ms Rechenzeit)`);
    assert.equal(s.werkzeugStatus().gekuerzt, true);
    uhr.vor(10_000);
  }
  assert.ok(s.statistik().gegenstellen <= GRENZEN.gegenstellen);
});

test('Verdrängen bleibt billig: 30 000 Verbindungen zu einer Gegenstelle (Tupel-Grenze 20 000), mehrere Proben ohne Aufschaukeln', async () => {
  const v4 = Array.from({ length: 30_000 }, (_, i) => aus4(i, '20.0.0.1')).join('\n');
  const { s, uhr } = neuerSammler({ system: systemAttrappe({ v4, v6: '' }) });
  const zeiten = [];
  for (let p = 0; p < 4; p++) {
    const c0 = process.cpuUsage();
    assert.equal(await s.probe(), true);
    const c = process.cpuUsage(c0);
    zeiten.push(Math.round((c.user + c.system) / 1000));
    uhr.vor(10_000);
  }
  assert.ok(zeiten.every((ms) => ms < 600), `Rechenzeit je Probe: ${zeiten.join(', ')} ms`);
  assert.deepEqual(s.statistik(), { tupel: GRENZEN.tupel, gegenstellen: 1 });
  // die jüngsten 20 000 Verbindungen sind geblieben (Verdrängen von vorn = älteste zuerst)
  const e = s.ergebnis('aus');
  assert.equal(finde(e, '20.0.0.1').anzahl, GRENZEN.tupel);
});

test('Verdrängen über Proben hinweg: immer die am längsten nicht gesehenen Verbindungen, auch nach „ans Ende gewandert“', async () => {
  const ziel = (i) => `20.0.0.${Math.floor(i / 100)}`; // je Gegenstelle 100 Verbindungen → 201 Gegenstellen (< 500 im Ergebnis)
  const zeilenVon = (von, bis) => Array.from({ length: bis - von }, (_, k) => aus4(von + k, ziel(von + k)));
  // Probe 1: 20 100 Verbindungen → die ersten 100 (Gegenstelle 0) fliegen sofort
  const system = systemAttrappe({ v4: zeilenVon(0, 20_100).join('\n'), v6: '' });
  const { s, uhr } = neuerSammler({ system });
  await s.probe();
  let e = s.ergebnis('aus');
  assert.equal(finde(e, ziel(0)), undefined); assert.equal(finde(e, ziel(99)), undefined);
  assert.equal(finde(e, ziel(100)).anzahl, 100);
  // Probe 2: Verbindungen 100–199 wieder gesehen (wandern ans Ende), dann 100 neue → jetzt fliegen 200–299
  uhr.vor(10_000);
  system.zustand.v4 = [...zeilenVon(100, 200), ...Array.from({ length: 100 }, (_, k) => aus4(30_000 + k, '21.0.0.1'))].join('\n');
  await s.probe();
  e = s.ergebnis('aus');
  for (const i of [100, 150, 199]) assert.equal(finde(e, ziel(i))?.anzahl, 100, `Verbindung ${i} wurde eben gesehen und bleibt`);
  for (const i of [200, 250, 299]) assert.equal(finde(e, ziel(i)), undefined, `Verbindung ${i} war jetzt die älteste`);
  assert.equal(finde(e, ziel(300)).anzahl, 100);
  assert.equal(finde(e, '21.0.0.1').anzahl, 100);
  assert.deepEqual(s.statistik().tupel, GRENZEN.tupel);
  // nach verwerfen() fängt das Verdrängen wieder vorn an
  s.verwerfen();
  uhr.vor(10_000);
  system.zustand.v4 = zeilenVon(0, 20_001).join('\n');
  await s.probe();
  e = s.ergebnis('aus');
  assert.equal(finde(e, ziel(0)).anzahl, 99, 'nur die allererste Verbindung ist verdrängt');
});

test('Aufzeichnung wird mitten in einer großen Probe verworfen → die Probe bricht ab und füllt nichts wieder auf', async () => {
  const v4 = Array.from({ length: 30_000 }, (_, i) => aus4(i, `20.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)).join('\n');
  const { s } = neuerSammler({ system: systemAttrappe({ v4, v6: '' }) });
  const laeuft = s.probe();
  let gesehen = 0;
  for (let i = 0; i < 10_000 && gesehen === 0; i++) { await new Promise((r) => setImmediate(r)); gesehen = s.statistik().tupel; }
  assert.ok(gesehen > 0 && gesehen < GRENZEN.tupel, `die Probe arbeitet in Stücken (zuerst gesehen: ${gesehen} Tupel)`);
  s.verwerfen();
  assert.equal(await laeuft, false, 'abgebrochene Probe meldet false');
  assert.deepEqual(s.statistik(), { tupel: 0, gegenstellen: 0 });
});

// ---------------------------------------------------------------------------------------------------------------
// Werkzeug, Byte-Zähler, Aufzeichnung, Zeitgeber
// ---------------------------------------------------------------------------------------------------------------

const UNIT_START = ['--unit=fahnas-conntrack-installation', '--collect', '--quiet', '--setenv=DEBIAN_FRONTEND=noninteractive', 'apt-get', '-o', 'DPkg::Lock::Timeout=300'];
const units = (system) => system.aufrufe.filter((x) => x.programm === 'systemd-run');

test('Nachinstallation als eigene Unit (systemd-run ohne --wait): kein apt-get im Agenten, je Probe conntrack --version, übersteht stoppen()', async () => {
  const system = systemAttrappe({ conntrackDa: false, systemdRun: true });
  const { s, meldungen } = neuerSammler({ system });
  assert.equal(await s.probe(), false);
  assert.equal(units(system).length, 1);
  assert.deepEqual(units(system)[0].args, [...UNIT_START, 'install', '-y', 'conntrack']);
  assert.ok(!units(system)[0].args.includes('--wait'), 'ohne --wait: der Agent wartet nicht auf apt');
  assert.match(units(system)[0].umgebung.PATH, /\/usr\/bin/, 'systemd-run findet apt-get über PATH');
  assert.equal(system.aufrufe.filter((x) => x.programm === 'apt-get').length, 0, 'apt-get läuft nicht als Kind des Agenten');
  assert.equal(s.werkzeugStatus().ok, false);
  assert.match(s.werkzeugStatus().hinweis, /nachinstalliert/);
  assert.equal(s.installation, null, 'kein Promise, auf das jemand warten müsste');
  // weitere Proben, solange die Unit läuft: kein zweiter Start, aber jedes Mal conntrack --version
  const version = () => system.aufrufe.filter((x) => x.programm === 'conntrack' && x.args[0] === '--version').length;
  const vorher = version();
  assert.equal(await s.probe(), false);
  assert.equal(await s.probe(), false);
  assert.equal(units(system).length, 1);
  assert.equal(version(), vorher + 2);
  // Agent-Stopp mitten in der Installation (KillMode=mixed träfe sonst dpkg): stoppen wartet auf nichts, Unit bleibt
  const t0 = Date.now();
  await s.stoppen();
  assert.ok(Date.now() - t0 < 1000, 'stoppen hängt nicht an apt');
  assert.equal(system.zustand.unit, 'active', 'die Unit läuft unabhängig vom Agenten weiter');
  assert.ok(!system.aufrufe.some((x) => x.programm === 'systemctl' && x.args[0] !== 'show'), 'die Unit wird nie angehalten');
  // Unit fertig → die nächste Probe liest
  system.zustand.unit = null; system.zustand.conntrackDa = true;
  assert.equal(await s.probe(), true);
  assert.deepEqual(s.werkzeugStatus(), { ok: true, hinweis: null });
  assert.ok(meldungen.some((m) => /conntrack installiert/.test(m)), meldungen.join(' | '));
});

test('Nachinstallations-Unit läuft schon (Agent neu gestartet, apt arbeitet noch): nicht erneut starten, abwarten', async () => {
  for (const schonDa of [
    'Failed to start transient service unit: Unit fahnas-conntrack-installation.service was already loaded or has a fragment file.',
    'Failed to start transient service unit: Unit fahnas-conntrack-installation.service already exists.',
  ]) {
    const system = systemAttrappe({ conntrackDa: false, systemdRun: true });
    system.zustand.unit = 'active'; system.zustand.schonDa = schonDa; // vom vorigen Agent-Lauf
    const { s } = neuerSammler({ system });
    assert.equal(await s.probe(), false);
    assert.equal(await s.probe(), false);
    assert.equal(await s.probe(), false);
    assert.equal(units(system).length, 1, `${schonDa}: ein Startversuch, danach nur noch abwarten`);
    assert.equal(system.aufrufe.filter((x) => x.programm === 'apt-get').length, 0, 'kein Rückfall auf apt-get im Agenten');
    assert.match(s.werkzeugStatus().hinweis, /nachinstalliert/);
    system.zustand.unit = null; system.zustand.conntrackDa = true;
    assert.equal(await s.probe(), true);
    assert.equal(units(system).length, 1);
  }
});

test('Unit endet ohne conntrack: Paketlisten auffrischen (update), erneut installieren, dann Hinweis mit „dpkg --configure -a“ – kein weiterer Versuch', async () => {
  const system = systemAttrappe({ conntrackDa: false, systemdRun: true });
  const { s, meldungen } = neuerSammler({ system });
  for (let i = 0; i < 4; i++) { assert.equal(await s.probe(), false); system.zustand.unit = null; } // jede Unit endet erfolglos
  assert.deepEqual(units(system).map((x) => x.args), [
    [...UNIT_START, 'install', '-y', 'conntrack'], [...UNIT_START, 'update'], [...UNIT_START, 'install', '-y', 'conntrack'],
  ]);
  const w = s.werkzeugStatus();
  assert.equal(w.ok, false);
  assert.match(w.hinweis, /ließ sich nicht nachinstallieren/);
  assert.match(w.hinweis, /sudo dpkg --configure -a/);
  await s.probe(); await s.probe();
  assert.equal(units(system).length, 3, 'einmal je Agent-Start');
  assert.ok(meldungen.some((m) => /journalctl -u fahnas-conntrack-installation/.test(m)), meldungen.join(' | '));
  // Unit gerade fertig geworden, während die Probe nachsah: kein nächster Schritt, sofort lesen
  const sys2 = systemAttrappe({ conntrackDa: false, systemdRun: true });
  const { s: s2 } = neuerSammler({ system: sys2 });
  await s2.probe();
  sys2.zustand.beimZeigen = () => { sys2.zustand.unit = null; sys2.zustand.conntrackDa = true; };
  assert.equal(await s2.probe(), true);
  assert.equal(units(sys2).length, 1);
});

test('Werkzeug (Rückfall ohne systemd-run): conntrack fehlt → ok:false mit Hinweis, genau eine Installation im Hintergrund (auch bei mehreren Proben), danach ok', async () => {
  const system = systemAttrappe({ conntrackDa: false });
  let freigeben; const tor = new Promise((r) => { freigeben = r; });
  const echt = system.ausfuehren;
  system.ausfuehren = async (p, a, o) => { if (p === 'apt-get') await tor; return echt(p, a, o); };
  const { s } = neuerSammler({ system });
  assert.equal(await s.probe(), false);
  assert.equal(await s.probe(), false);
  const w = s.werkzeugStatus();
  assert.equal(w.ok, false); assert.match(w.hinweis, /conntrack/); assert.match(w.hinweis, /nachinstalliert/);
  assert.equal(s.ergebnis('aus').werkzeug.ok, false);
  assert.deepEqual(s.ergebnis('aus').gegenstellen, []);
  freigeben();
  assert.equal(await s.installation, true);
  const apt = system.aufrufe.filter((x) => x.programm === 'apt-get');
  assert.equal(apt.length, 1, 'genau ein apt-get-Aufruf');
  assert.ok(apt[0].args.includes('install') && apt[0].args.includes('-y') && apt[0].args.includes('conntrack'), apt[0].args.join(' '));
  assert.equal(apt[0].umgebung.DEBIAN_FRONTEND, 'noninteractive');
  assert.deepEqual(s.werkzeugStatus(), { ok: true, hinweis: null });
  assert.equal(await s.probe(), true);
  assert.ok(s.ergebnis('aus').gegenstellen.length > 0);
  assert.equal(system.aufrufe.filter((x) => x.programm === 'apt-get').length, 1);
  assert.ok(system.aufrufe.filter((x) => x.programm === 'conntrack' && x.args[0] === '-L').every((x) => x.zeitlimit_ms === 5000), 'Zeitlimit 5 s je Abfrage');
});

test('Werkzeug (Rückfall ohne systemd-run): Installation scheitert → Hinweis, kein weiterer Versuch in späteren Proben; Tabelle nicht lesbar → Hinweis', async () => {
  // systemd-run ist da, aber das System läuft nicht unter systemd → ebenfalls Rückfall
  const nichtSystemd = systemAttrappe({ conntrackDa: false, systemdRun: systemFehler('systemd-run', 'System has not been booted with systemd as init system (PID 1). Can\'t operate.') });
  const { s: s0 } = neuerSammler({ system: nichtSystemd });
  await s0.probe();
  assert.equal(await s0.installation, true);
  assert.equal(nichtSystemd.aufrufe.filter((x) => x.programm === 'apt-get').length, 1);
  const system = systemAttrappe({ conntrackDa: false });
  system.ausfuehren = ((echt) => async (p, a, o) => { if (p === 'apt-get') { system.aufrufe.push({ programm: p, args: a }); throw new Error('E: Unable to locate package conntrack'); } return echt(p, a, o); })(system.ausfuehren);
  const { s, meldungen } = neuerSammler({ system });
  await s.probe();
  assert.equal(await s.installation, false);
  assert.equal(s.werkzeugStatus().ok, false);
  assert.match(s.werkzeugStatus().hinweis, /ließ sich nicht/);
  assert.match(s.werkzeugStatus().hinweis, /sudo dpkg --configure -a/);
  assert.equal(units(system).length, 1, 'systemd-run wurde zuerst versucht');
  const anzahl = system.aufrufe.filter((x) => x.programm === 'apt-get').length;
  await s.probe(); await s.probe();
  assert.equal(system.aufrufe.filter((x) => x.programm === 'apt-get').length, anzahl, 'einmal je Agent-Start');
  assert.ok(meldungen.some((m) => /conntrack/.test(m)));
  // Werkzeug da, aber -L schlägt für beide Familien fehl
  const sys2 = systemAttrappe();
  sys2.ausfuehren = ((echt) => async (p, a, o) => { if (p === 'conntrack' && a[0] === '-L') throw new Error('Operation not permitted'); return echt(p, a, o); })(sys2.ausfuehren);
  const { s: s2 } = neuerSammler({ system: sys2 });
  assert.equal(await s2.probe(), false);
  assert.equal(s2.werkzeugStatus().ok, false);
  assert.match(s2.werkzeugStatus().hinweis, /Verbindungstabelle/);
});

test('acct: Zähler 0 → 1 und sysctl-Datei; Zähler 1 → nur die Datei; /proc-Datei fehlt noch → nächste Probe', async () => {
  const d1 = dateienAttrappe({ [ACCT_PROC]: '0\n' });
  const { s } = neuerSammler({ dateien: d1 });
  await s.probe();
  assert.deepEqual(d1.geschrieben, [[ACCT_PROC, '1\n'], [SYSCTL_DATEI, SYSCTL_TEXT]]);
  assert.match(SYSCTL_TEXT, /^net\.netfilter\.nf_conntrack_acct = 1$/m);
  assert.equal(SYSCTL_DATEI, '/etc/sysctl.d/60-fahnas-conntrack.conf');
  assert.equal(ACCT_PROC, '/proc/sys/net/netfilter/nf_conntrack_acct');
  await s.probe();
  assert.equal(d1.geschrieben.length, 2, 'nur einmal je Start');
  const d2 = dateienAttrappe({ [ACCT_PROC]: '1\n' });
  await neuerSammler({ dateien: d2 }).s.probe();
  assert.deepEqual(d2.geschrieben, [[SYSCTL_DATEI, SYSCTL_TEXT]]);
  const d3 = dateienAttrappe({});
  const { s: s3 } = neuerSammler({ dateien: d3 });
  await s3.probe();
  assert.equal(d3.geschrieben.length, 0);
  d3.inhalt.set(ACCT_PROC, '0\n');
  await s3.probe();
  assert.deepEqual(d3.geschrieben.map((x) => x[0]), [ACCT_PROC, SYSCTL_DATEI]);
});

test('aufzeichnenHolen() → false: starten sammelt nicht, Ergebnis leer mit aufzeichnung:false; an → sammelt; aus → Daten verworfen', async () => {
  let an = false;
  const { s, system } = neuerSammler({ aufzeichnenHolen: async () => an });
  await s.starten();
  try {
    assert.equal(system.aufrufe.filter((x) => x.programm === 'conntrack').length, 0, 'kein conntrack-Aufruf');
    const e = s.ergebnis('aus');
    assert.equal(e.aufzeichnung, false);
    assert.deepEqual([e.gegenstellen, e.lokal, e.summe], [[], [], { anzahl: 0, bytes: 0, gegenstellen: 0 }]);
    an = true;
    await s.probe();
    assert.equal(s.ergebnis('aus').aufzeichnung, true);
    assert.ok(s.ergebnis('aus').gegenstellen.length > 0);
    an = false;
    await s.probe();
    assert.deepEqual(s.statistik(), { tupel: 0, gegenstellen: 0 });
    assert.equal(s.ergebnis('ein').aufzeichnung, false);
    // verwerfen() leert sofort
    an = true; await s.probe(); s.verwerfen();
    assert.deepEqual(s.statistik(), { tupel: 0, gegenstellen: 0 });
  } finally { await s.stoppen(); }
});

test('Zeitgeber und Überlappungsschutz: Proben im Takt, laufende Probe blockiert die nächste, stoppen hält an', async () => {
  const system = systemAttrappe();
  let tor = null;
  const echt = system.ausfuehren;
  system.ausfuehren = async (p, a, o) => { if (tor && p === 'conntrack' && a[0] === '-L') await tor; return echt(p, a, o); };
  const { s } = neuerSammler({ system });
  let auf; tor = new Promise((r) => { auf = r; });
  const erste = s.probe();
  assert.equal(await s.probe(), false, 'zweite Probe während der ersten wird übersprungen');
  auf();
  assert.equal(await erste, true);
  tor = null;
  assert.equal(system.aufrufe.filter((x) => x.programm === 'conntrack' && x.args[0] === '-L').length, 2, 'IPv4 + IPv6 genau einmal');
  // Takt
  const { s: s2, system: sys2 } = neuerSammler({ intervall_ms: 15 });
  await s2.starten();
  await new Promise((r) => setTimeout(r, 120));
  await s2.stoppen();
  const n = sys2.aufrufe.filter((x) => x.args[0] === '-L').length;
  assert.ok(n >= 4, `mehrere Proben im Takt (${n} Abfragen)`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sys2.aufrufe.filter((x) => x.args[0] === '-L').length, n, 'nach stoppen keine Proben mehr');
  assert.deepEqual(s2.statistik(), { tupel: 0, gegenstellen: 0 }, 'stoppen verwirft die Daten');
});

test('Sammler: Umgebung (Adressen, Container, App-Ports) wird höchstens alle 60 s neu gelesen', async () => {
  const { s, uhr, umgebungAufrufe } = neuerSammler();
  await s.probe();
  uhr.vor(10_000); await s.probe();
  uhr.vor(10_000); await s.probe();
  assert.equal(umgebungAufrufe.n, 1);
  uhr.vor(45_000); await s.probe();
  assert.equal(umgebungAufrufe.n, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Umgebung und Standort
// ---------------------------------------------------------------------------------------------------------------

test('umgebungLesen: eigene Adressen, Container aus docker (Projekt ohne „fahnas-“, sonst Name), App-Ports wie die Firewall; docker fehlt → still', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-verb-'));
  try {
    await fs.mkdir(path.join(w, 'apps', 'it-tools'), { recursive: true });
    await fs.writeFile(path.join(w, 'apps', 'it-tools', 'app.json'), JSON.stringify({ name: 'it-tools', ports: [{ port: 8086, protokoll: 'tcp' }, { port: 445, protokoll: 'tcp' }] }));
    await fs.mkdir(path.join(w, 'apps', 'adblock'), { recursive: true });
    await fs.writeFile(path.join(w, 'apps', 'adblock', 'app.json'), JSON.stringify({ name: 'adblock', ports: [{ port: 8053, protokoll: 'tcp' }, { port: 53, protokoll: 'udp' }] }));
    const schnittstellen = () => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
      enp1s0: [{ address: '192.168.1.29', family: 'IPv4' }, { address: 'fe80::abcd', family: 'IPv6', scopeid: 2 }],
      'br-1234': [{ address: '172.18.0.1', family: 'IPv4' }],
    });
    const c1 = 'a'.repeat(64); const c2 = 'b'.repeat(64); const c3 = 'c'.repeat(64);
    const netze = [
      { Name: 'fahnas-it-tools_default', Id: '1'.repeat(64), Labels: { 'com.docker.compose.project': 'fahnas-it-tools' }, Containers: { [c1]: { Name: 'fahnas-it-tools-web-1', IPv4Address: '172.18.0.2/16', IPv6Address: '' } } },
      { Name: 'bridge', Id: '2'.repeat(64), Labels: {}, Containers: { [c2]: { Name: 'portainer', IPv4Address: '172.17.0.2/16', IPv6Address: 'fd00:dead::2/64' }, [c3]: { Name: 'ohne-ps', IPv4Address: '172.17.0.3/16' } } },
    ];
    const aufrufe = [];
    const system = {
      ausfuehren: async (p, a) => {
        aufrufe.push([p, ...a]);
        if (p === 'docker' && a[0] === 'network' && a[1] === 'ls') return { code: 0, stdout: `${'1'.repeat(12)}\n${'2'.repeat(12)}\n`, stderr: '' };
        if (p === 'docker' && a[0] === 'network' && a[1] === 'inspect') return { code: 0, stdout: JSON.stringify(netze), stderr: '' };
        if (p === 'docker' && a[0] === 'ps') {
          return { code: 0, stdout: [JSON.stringify({ ID: c1, Names: 'fahnas-it-tools-web-1', Labels: 'com.docker.compose.project=fahnas-it-tools,com.docker.compose.service=web' }), JSON.stringify({ ID: c2, Names: 'portainer', Labels: '' })].join('\n'), stderr: '' };
        }
        throw new Error(`unerwartet ${p} ${a.join(' ')}`);
      },
    };
    const u = await umgebungLesen({ system, konfigOrdner: w, schnittstellen });
    for (const ip of ['127.0.0.1', '::1', '192.168.1.29', 'fe80::abcd', '172.18.0.1']) assert.ok(u.eigene.has(ip), ip);
    assert.deepEqual(u.container.get('172.18.0.2'), { name: 'it-tools' });
    assert.deepEqual(u.container.get('172.17.0.2'), { name: 'portainer' });
    assert.deepEqual(u.container.get('fd00:dead::2'), { name: 'portainer' });
    assert.deepEqual(u.container.get('172.17.0.3'), { name: 'ohne-ps' }, 'ohne docker ps: Name aus dem Netz');
    assert.equal(u.vmNetz, '192.168.122.0/24');
    assert.equal(u.appPorts.get(8086), 'it-tools');
    assert.equal(u.appPorts.get(8053), 'adblock');
    assert.equal(u.appPorts.get(53), 'adblock');
    assert.ok(!u.appPorts.has(445), 'Kern-Ports bleiben Dienste des NAS');
    assert.ok(aufrufe.some((x) => x[1] === 'network' && x[2] === 'inspect' && x.length === 5), 'alle Netze in einem Aufruf');
    // docker fehlt, Spiegel fehlt → leere Listen, kein Fehler
    const u2 = await umgebungLesen({ system: { ausfuehren: async () => { throw new Error('docker fehlt'); } }, konfigOrdner: path.join(w, 'gibtsnicht'), schnittstellen });
    assert.equal(u2.container.size, 0); assert.equal(u2.appPorts.size, 0); assert.ok(u2.eigene.has('192.168.1.29'));
    // kaputtes JSON von docker → still
    const u3 = await umgebungLesen({ system: { ausfuehren: async (p, a) => ({ code: 0, stdout: a[1] === 'ls' ? 'abc123\n' : '{kaputt', stderr: '' }) }, konfigOrdner: w, schnittstellen });
    assert.equal(u3.container.size, 0);
  } finally { await fs.rm(w, { recursive: true, force: true }); }
});

test('heimatAus: nur mit gültiger Breite und Länge, Name gekürzt', () => {
  assert.deepEqual(heimatAus({ lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' }), HEIMAT);
  assert.deepEqual(heimatAus({ lat: 0, lon: 0 }), { lat: 0, lon: 0, name: '' });
  assert.equal(heimatAus({ lat: 1, lon: 2, name: 'x'.repeat(100) }).name.length, 64);
  for (const s of [null, undefined, {}, { lat: null, lon: null, name: 'x' }, { lat: 48 }, { lat: 95, lon: 10 }, { lat: 48, lon: 200 }, { lat: '48', lon: '11' }, { lat: NaN, lon: 1 }]) {
    assert.equal(heimatAus(s), null, JSON.stringify(s));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Prüfbericht 26.09. nachmittags: Protokoll ohne Verbindungsdaten, verwerfen() während conntrack -L, Speicher
// ---------------------------------------------------------------------------------------------------------------

test('Lesefehler ohne stderr (Zeitlimit): das Protokoll nennt die Ursache, nie Verbindungsdaten aus stdout', async () => {
  const system = systemAttrappe();
  system.ausfuehren = ((echt) => async (p, a, o) => {
    if (p === 'conntrack' && a[0] === '-L' && a.includes('ipv6')) {
      // system.befehl legt ohne stderr die Standardausgabe in details.ausgabe – hier eine halbe Tabelle
      throw Object.assign(new Error('Befehl conntrack: Zeitlimit überschritten'), { code: 'E_SYSTEM', details: { code: null, ausgabe: 'ipv6     10 tcp      6 431999 ESTABLISHED src=2a02:8109:b6c0:1d00::29 dst=2a00:1450:4001:82b::200e sport=51234 dport=443 packets=3 bytes=300\n' } });
    }
    return echt(p, a, o);
  })(system.ausfuehren);
  const { s, meldungen } = neuerSammler({ system });
  await s.probe();
  const zeile = meldungen.find((m) => m.includes('IPv6'));
  assert.ok(zeile, meldungen.join(' | '));
  assert.doesNotMatch(zeile, /src=|dst=|2a02:8109/, 'keine Verbindungsdaten im Journal');
  assert.match(zeile, /Zeitlimit/, 'Ursache steht drin');
});

test('verwerfen(), während conntrack -L noch läuft: die Probe füllt die Tabellen danach nicht wieder auf', async () => {
  const system = systemAttrappe();
  let freigeben; const gesperrt = new Promise((ok) => { freigeben = ok; });
  system.ausfuehren = ((echt) => async (p, a, o) => {
    if (p === 'conntrack' && a[0] === '-L') await gesperrt;
    return echt(p, a, o);
  })(system.ausfuehren);
  const { s } = neuerSammler({ system });
  const probe = s.probe();
  await new Promise((r) => setImmediate(r));
  s.verwerfen();
  freigeben();
  await probe;
  assert.deepEqual(s.statistik(), { tupel: 0, gegenstellen: 0 });
});

