// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/helfer/netzadressen.js: Adressen normalisieren, private/interne Netze und Anycast erkennen
// (gemeinsame Grundlage für Geo-Suche und Verbindungs-Sammler der Weltkarte).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipNormal, istPrivat, istAnycast, ANYCAST } from '../../src/agent/helfer/netzadressen.js';

test('ipNormal: IPv4-Abbild, Zonen-ID, Groß-/Kleinschreibung und Unsinn', () => {
  assert.equal(ipNormal('::ffff:192.168.1.79'), '192.168.1.79');
  assert.equal(ipNormal('::FFFF:8.8.8.8'), '8.8.8.8');
  assert.equal(ipNormal('fe80::1%eno1'), 'fe80::1');
  assert.equal(ipNormal('2A00:1450:4001:82B::200E'), '2a00:1450:4001:82b::200e');
  assert.equal(ipNormal(' 8.8.8.8 '), '8.8.8.8');
  for (const x of ['', 'kein-ip', '1.2.3', '300.1.1.1', null, undefined, 42]) assert.equal(ipNormal(x), null, String(x));
});

test('istPrivat: RFC1918, CGNAT, Loopback, Link-Local, Multicast, ULA, IPv4-Abbild – öffentliche nicht', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.254', '127.0.0.1',
    '169.254.1.1', '224.0.0.251', '239.255.255.250', '255.255.255.255', '0.0.0.0', 'fd00::1', 'fc12::1', 'fe80::1%eno1', '::1', '::',
    'ff02::fb', '::ffff:192.168.1.5']) assert.equal(istPrivat(ip), true, ip);
  for (const ip of ['172.32.0.1', '172.15.255.255', '100.128.0.1', '8.8.8.8', '140.82.121.4', '2a00:1450::1', '::ffff:8.8.8.8'])
    assert.equal(istPrivat(ip), false, ip);
  assert.equal(istPrivat('unsinn'), false, 'Unsinn gilt nicht als privat (wird vom Aufrufer verworfen)');
});

test('Anycast-Katalog: bekannte DNS-Anycast-Adressen in beiden Schreibweisen', () => {
  for (const ip of ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220',
    '94.140.14.14', '94.140.15.15', '2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888', '2001:4860:4860::8844',
    '2620:fe::fe', '::ffff:1.1.1.1', '2606:4700:4700:0:0:0:0:1111']) assert.equal(istAnycast(ip), true, ip);
  for (const ip of ['1.1.1.2', '140.82.121.4', '192.168.1.1']) assert.equal(istAnycast(ip), false, ip);
  assert.ok(ANYCAST instanceof Set && ANYCAST.size >= 15);
});
