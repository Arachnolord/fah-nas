// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// STUN-Codec (Plan 03, Aufgabe 2) gegen die Testvektoren aus RFC 5769 §2.1–2.4: Typkodierung, MESSAGE-INTEGRITY
// (Kurz- und Langzeit), FINGERPRINT, XOR-Adressen IPv4/IPv6, Fehlercode, ChannelData, kaputte Nachrichten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METHODE, KLASSE, ATTR, typKodieren, typLesen, istStun, istKanalDaten, nachrichtLesen, attr, integritaetPruefen, fingerprintPruefen,
  nachrichtBauen, adresseLesen, adresseKodieren, fehlerKodieren, fehlerLesen, kanalDatenLesen, kanalDatenBauen, langzeitSchluessel, crc32,
} from '../../src/web/turn/stun.js';

const T = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const ANFRAGE = T(`0001 0058 2112a442 b7e7a701 bc34d686 fa87dfae
  80220010 5354554e 20746573 7420636c 69656e74   00240004 6e0001ff   80290008 932ff9b1 51263b36
  00060009 6576746a 3a683676 59202020   00080014 9aeaa70c bfd8cb56 781ef2b5 b2d3f249 c1b571a2   80280004 e57a3bcf`);
const ANTWORT4 = T(`0101 003c 2112a442 b7e7a701 bc34d686 fa87dfae   8022000b 74657374 20766563 746f7220
  00200008 0001a147 e112a643   00080014 2b91f599 fd9e90c3 8c7489f9 2af9ba53 f06be7d7   80280004 c07d4c96`);
const ANTWORT6 = T(`0101 0048 2112a442 b7e7a701 bc34d686 fa87dfae   8022000b 74657374 20766563 746f7220
  00200014 0002a147 0113a9fa a5d3f179 bc25f4b5 bed2b9d9   00080014 a382954e 4be67bf1 1784c97c 8292c275 bfe3ed41   80280004 c8fb0b4c`);
const LANGZEIT = T(`0001 0060 2112a442 78ad3433 c6ad72c0 29da412e   00060012 e3839ee3 8388e383 aae38383 e382afe3 82b90000
  0015001c 662f2f34 39396b39 35346436 4f4c3334 6f4c3946 53547679 36347341   0014000b 6578616d 706c652e 6f726700
  00080014 f6702465 6dd64a3e 02b8e071 2e85c9a2 8ca89666`);
const KURZ = Buffer.from('VOkJxbRl1RmTxUk/WvJxBt');

test('crc32 und Typkodierung', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(typKodieren(METHODE.binding, KLASSE.erfolg), 0x0101);
  assert.equal(typKodieren(METHODE.allocate, KLASSE.fehler), 0x0113);
  assert.equal(typKodieren(METHODE.send, KLASSE.hinweis), 0x0016);
  assert.equal(typKodieren(METHODE.data, KLASSE.hinweis), 0x0017);
  assert.equal(typKodieren(METHODE.channel_bind, KLASSE.erfolg), 0x0109);
  assert.deepEqual(typLesen(0x0113), { methode: METHODE.allocate, klasse: KLASSE.fehler });
});
test('RFC 5769: Anfrage und Antworten prüfen (MESSAGE-INTEGRITY, FINGERPRINT, XOR-Adressen)', () => {
  for (const b of [ANFRAGE, ANTWORT4, ANTWORT6]) {
    const n = nachrichtLesen(b);
    assert.equal(integritaetPruefen(n, KURZ), true); assert.equal(fingerprintPruefen(n), true);
  }
  const a4 = nachrichtLesen(ANTWORT4);
  assert.deepEqual(adresseLesen(attr(a4, ATTR.xor_mapped_address), a4.transaktion), { familie: 4, ip: '192.0.2.1', port: 32853 });
  const a6 = nachrichtLesen(ANTWORT6);
  assert.deepEqual(adresseLesen(attr(a6, ATTR.xor_mapped_address), a6.transaktion), { familie: 6, ip: '2001:db8:1234:5678:11:2233:4455:6677', port: 32853 });
  assert.equal(attr(nachrichtLesen(ANFRAGE), ATTR.username).toString(), 'evtj:h6vY');
});
test('RFC 5769: Langzeit-Schlüssel', () => {
  const n = nachrichtLesen(LANGZEIT);
  assert.equal(fingerprintPruefen(n), null);
  assert.equal(integritaetPruefen(n, langzeitSchluessel('マトリックス', 'example.org', 'TheMatrIX')), true);
  assert.equal(integritaetPruefen(n, langzeitSchluessel('マトリックス', 'example.org', 'falsch')), false);
});
test('Bauen ergibt byte-genau die RFC-Nachrichten', () => {
  const tx = ANTWORT4.subarray(8, 20);
  assert.ok(nachrichtBauen({ methode: METHODE.binding, klasse: KLASSE.erfolg, transaktion: tx, fuellung: 0x20, schluessel: KURZ,
    attribute: [[ATTR.software, Buffer.from('test vector')], [ATTR.xor_mapped_address, adresseKodieren({ ip: '192.0.2.1', port: 32853 }, tx)]] }).equals(ANTWORT4));
  assert.ok(nachrichtBauen({ methode: METHODE.binding, klasse: KLASSE.anfrage, transaktion: tx, fuellung: 0x20, schluessel: KURZ,
    attribute: [[ATTR.software, Buffer.from('STUN test client')], [ATTR.priority, T('6e0001ff')], [ATTR.ice_controlled, T('932ff9b151263b36')], [ATTR.username, Buffer.from('evtj:h6vY')]] }).equals(ANFRAGE));
});
test('Verfälschung, Kaputtes, Fehlercode, ChannelData', () => {
  const b = Buffer.from(ANTWORT4); b[30] ^= 1;
  assert.equal(integritaetPruefen(nachrichtLesen(b), KURZ), false); assert.equal(fingerprintPruefen(nachrichtLesen(b)), false);
  assert.throws(() => nachrichtLesen(ANTWORT4.subarray(0, 30)), /stun_kaputt/);
  assert.equal(istStun(ANTWORT4), true); assert.equal(istStun(T('4001000461626364')), false); assert.equal(istKanalDaten(T('4001000461626364')), true);
  assert.deepEqual(fehlerLesen(fehlerKodieren(438, 'Stale Nonce')), { code: 438, grund: 'Stale Nonce' });
  assert.deepEqual(kanalDatenLesen(kanalDatenBauen(0x4001, Buffer.from('abc'))), { kanal: 0x4001, daten: Buffer.from('abc') });
  assert.equal(kanalDatenLesen(T('400100ff6162')), null);
});
