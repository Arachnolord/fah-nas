// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// TURN-Dienst (Plan 03, Aufgabe 4): Binding ohne Zugang, Allocate mit 401-Tanz und Langzeit-Schlüssel, falsche oder
// abgelaufene Zugänge, TCP, Doppel-Allocate, veraltete Nonce, Refresh, Quoten je Identität und Portbereich, Ablauf.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import crypto from 'node:crypto';
import {
  METHODE, KLASSE, ATTR, attr, adresseLesen, adresseKodieren, fingerprintPruefen, integritaetPruefen, fehlerLesen, zahl32, nachrichtLesen, istStun, istKanalDaten,
  typKodieren, kanalDatenBauen, kanalDatenLesen, kanalNummerKodieren, nachrichtBauen,
} from '../../src/web/turn/stun.js';
import { zugangsdaten } from '../../src/web/turn/zugang.js';
import { TurnDienst, istExtern, gegenstelleErlaubt } from '../../src/web/turn/turn.js';
import { GEHEIM, turnKlient, gegenstelle } from './turn_hilfen.js';

let uhr; let dienst; let port; const offen = [];
const klient = async () => { const k = await turnKlient(port); offen.push(k); return k; };
const peerStelle = async () => { const g = await gegenstelle(); offen.push(g); return g; };
const peerAttr = (adresse) => (tx) => adresseKodieren(adresse, tx);
const code = (n) => fehlerLesen(attr(n, ATTR.error_code)).code;

beforeEach(async () => {
  uhr = 1_800_000_000_000;
  dienst = new TurnDienst({ port: 0, relayVon: 47810, relayBis: 47817, geheimnis: GEHEIM, relayIp: '127.0.0.1', loopbackErlauben: true, jetzt: () => uhr });
  port = await dienst.starten();
});
afterEach(async () => { for (const k of offen.splice(0)) await k.schliessen(); await dienst.stoppen(); });

/** Wie ein echter Klient: bei 438 die neue Nonce übernehmen und die Anfrage einmal wiederholen. */
async function mitNonce(k, methode, attribute, s) {
  const n = await k.authAnfrage(methode, attribute, s);
  if (n.klasse !== KLASSE.fehler || code(n) !== 438) return n;
  s.nonce = attr(n, ATTR.nonce).toString();
  return k.authAnfrage(methode, attribute, s);
}

test('Binding: XOR-MAPPED-ADDRESS, SOFTWARE, FINGERPRINT, ohne Auth', async () => {
  const k = await klient();
  const n = await k.anfrage(METHODE.binding);
  assert.equal(n.klasse, KLASSE.erfolg); assert.equal(fingerprintPruefen(n), true);
  assert.deepEqual(adresseLesen(attr(n, ATTR.xor_mapped_address), n.transaktion), { familie: 4, ip: '127.0.0.1', port: k.adresse.port });
  assert.equal(attr(n, ATTR.software).toString(), 'FAH-NAS');
});

test('Allocate: erst 401 mit REALM+NONCE, dann Zuteilung mit Relay, LIFETIME, MI; Ereignis', async () => {
  const k = await klient();
  const ohne = await k.anfrage(METHODE.allocate, [[ATTR.requested_transport, Buffer.from([17, 0, 0, 0])]]);
  assert.equal(code(ohne), 401);
  assert.equal(attr(ohne, ATTR.realm).toString(), 'fah-nas'); assert.ok(attr(ohne, ATTR.nonce).length > 8);
  assert.equal(ohne.mi, null, 'vor der Prüfung ohne MESSAGE-INTEGRITY');
  const ev = once(dienst, 'zuteilung');
  const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  assert.equal(s.antwort.klasse, KLASSE.erfolg); assert.equal(integritaetPruefen(s.antwort, s.schluessel), true);
  assert.equal(s.relay.ip, '127.0.0.1'); assert.ok(s.relay.port >= 47810 && s.relay.port <= 47817);
  assert.equal(attr(s.antwort, ATTR.lifetime).readUInt32BE(0), 600);
  assert.deepEqual(adresseLesen(attr(s.antwort, ATTR.xor_mapped_address), s.antwort.transaktion), { familie: 4, ip: '127.0.0.1', port: k.adresse.port });
  assert.deepEqual((await ev)[0], { wer: 'anna', quelle: '127.0.0.1', extern: false });
  assert.deepEqual(dienst.stand(), { aktiv: true, port, zuteilungen: 1, extern_zuletzt: null });
});

test('Allocate: falsches credential, abgelaufener username → 401; TCP → 442; zweite Allocate → 437, gleiche Transaktion → gleiche Antwort', async () => {
  const z = zugangsdaten(GEHEIM, 'anna', uhr);
  assert.equal(code((await (await klient()).allocate({ ...z, credential: 'falsch' })).antwort), 401);
  assert.equal(code((await (await klient()).allocate(zugangsdaten(GEHEIM, 'anna', uhr - 43_201_000))).antwort), 401);
  assert.equal(code((await (await klient()).allocate(z, { transport: 6 })).antwort), 442);
  assert.equal(dienst.stand().zuteilungen, 0);
  const k = await klient();
  const s = await k.allocate(z);
  assert.equal(s.antwort.klasse, KLASSE.erfolg);
  const basis = [[ATTR.requested_transport, Buffer.from([17, 0, 0, 0])]];
  const zweite = await k.authAnfrage(METHODE.allocate, basis, s);
  assert.equal(code(zweite), 437);
  assert.equal(integritaetPruefen(zweite, s.schluessel), true, 'nach der Prüfung mit MESSAGE-INTEGRITY');
  const wieder = await k.authAnfrage(METHODE.allocate, basis, s, { transaktion: s.antwort.transaktion });
  assert.equal(wieder.klasse, KLASSE.erfolg);
  assert.ok(wieder.roh.equals(s.antwort.roh), 'gespeicherte Antwort');
});

test('Nonce veraltet nach 600 s → 438 mit neuer NONCE', async () => {
  const k = await klient();
  const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  uhr += 601_000;
  const n = await k.authAnfrage(METHODE.refresh, [[ATTR.lifetime, zahl32(600)]], s);
  assert.equal(code(n), 438);
  assert.notEqual(attr(n, ATTR.nonce).toString(), s.nonce);
  assert.equal(attr(n, ATTR.realm).toString(), 'fah-nas');
});

test('Refresh: Lebensdauer begrenzt auf 3600, 0 löscht und gibt den Port frei', async () => {
  const k = await klient();
  const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  const lang = await k.authAnfrage(METHODE.refresh, [[ATTR.lifetime, zahl32(7200)]], s);
  assert.equal(lang.klasse, KLASSE.erfolg); assert.equal(attr(lang, ATTR.lifetime).readUInt32BE(0), 3600);
  const weg = await k.authAnfrage(METHODE.refresh, [[ATTR.lifetime, zahl32(0)]], s);
  assert.equal(weg.klasse, KLASSE.erfolg); assert.equal(attr(weg, ATTR.lifetime).readUInt32BE(0), 0);
  assert.equal(dienst.stand().zuteilungen, 0);
  const probe = dgram.createSocket('udp4');
  await new Promise((ok, nein) => { probe.once('error', nein); probe.bind(s.relay.port, '127.0.0.1', ok); });
  await new Promise((ok) => probe.close(ok));
});

test('Quoten: 7. Zuteilung derselben Identität → 486; Portbereich voll → 508', async () => {
  const ergebnisse = [];
  for (let i = 0; i < 7; i++) ergebnisse.push((await (await klient()).allocate(zugangsdaten(GEHEIM, 'anna', uhr))).antwort);
  assert.equal(ergebnisse.filter((a) => a.klasse === KLASSE.erfolg).length, 6);
  assert.equal(code(ergebnisse[6]), 486);
  const klein = new TurnDienst({ port: 0, relayVon: 47820, relayBis: 47821, geheimnis: GEHEIM, relayIp: '127.0.0.1', loopbackErlauben: true, jetzt: () => uhr });
  const p2 = await klein.starten();
  try {
    const neu = async (wer) => { const k = await turnKlient(p2); offen.push(k); return (await k.allocate(zugangsdaten(GEHEIM, wer, uhr))).antwort; };
    assert.equal((await neu('anna')).klasse, KLASSE.erfolg);
    assert.equal((await neu('ben')).klasse, KLASSE.erfolg);
    assert.equal(code(await neu('cara')), 508);
  } finally { await klein.stoppen(); }
});

test('Ablauf: aufraeumen nach 601 s löscht die Zuteilung; stoppen → aktiv false', async () => {
  const k = await klient();
  const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  uhr += 601_000;
  dienst.aufraeumen();
  assert.equal(dienst.stand().zuteilungen, 0);
  assert.equal(code(await mitNonce(k, METHODE.refresh, [[ATTR.lifetime, zahl32(600)]], s)), 437);
  await dienst.stoppen();
  assert.equal(dienst.stand().aktiv, false);
});

test('Start auf belegtem Port → EADDRINUSE', async () => {
  const zweiter = new TurnDienst({ port, geheimnis: GEHEIM, relayIp: '127.0.0.1' });
  await assert.rejects(zweiter.starten(), (e) => e.code === 'EADDRINUSE');
  assert.equal(zweiter.stand().aktiv, false);
});

test('istExtern', () => { assert.equal(istExtern('192.168.1.5'), false); assert.equal(istExtern('8.8.8.8'), true); });

test('gegenstelleErlaubt: Heimnetz und Sonderadressen gesperrt, öffentliche Adressen erlaubt (Prüfbericht Plan 03, C2)', () => {
  for (const ip of ['0.0.0.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '::', '::1', 'ff02::1', 'kaputt',
    '192.168.1.29', '192.168.1.1', '192.168.1.5', '172.16.0.1', '172.31.255.254', '100.64.0.1']) assert.equal(gegenstelleErlaubt(ip), false, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(gegenstelleErlaubt(ip), true, ip);
  assert.equal(gegenstelleErlaubt('127.0.0.1', { loopback: true }), true);
  assert.equal(gegenstelleErlaubt('224.0.0.1', { loopback: true }), false);
});

test('Send-Indication → Gegenstelle; Antwort kommt als Data-Indication', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr)); const gegen = await peerStelle();
  const peer = peerAttr(gegen.adresse);
  assert.equal((await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peer]], s)).klasse, KLASSE.erfolg);
  k.hinweis(METHODE.send, [[ATTR.xor_peer_address, peer], [ATTR.data, Buffer.from('hallo')]]);
  const { daten, von } = await gegen.empfangen();
  assert.equal(daten.toString(), 'hallo'); assert.deepEqual(von, s.relay);
  await gegen.senden(Buffer.from('zurueck'), s.relay);
  const d = nachrichtLesen(await k.naechste((b) => istStun(b)));
  assert.equal(typKodieren(d.methode, d.klasse), 0x0017);
  assert.equal(attr(d, ATTR.data).toString(), 'zurueck');
  assert.deepEqual(adresseLesen(attr(d, ATTR.xor_peer_address), d.transaktion), { familie: 4, ...gegen.adresse });
});

test('ohne Erlaubnis kein Paket – in beide Richtungen; Erlaubnis läuft nach 300 s ab', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr)); const gegen = await peerStelle();
  const peer = peerAttr(gegen.adresse);
  k.hinweis(METHODE.send, [[ATTR.xor_peer_address, peer], [ATTR.data, Buffer.from('ohne')]]);
  assert.equal(await gegen.empfangen(), null, 'ohne Erlaubnis geht nichts hinaus');
  await gegen.senden(Buffer.from('rein'), s.relay);
  await assert.rejects(k.naechste(() => true, 300), 'ohne Erlaubnis kommt nichts herein');
  assert.equal((await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peer]], s)).klasse, KLASSE.erfolg);
  await gegen.senden(Buffer.from('mit'), s.relay);
  assert.equal(attr(nachrichtLesen(await k.naechste(istStun)), ATTR.data).toString(), 'mit');
  uhr += 301_000; dienst.aufraeumen();
  await gegen.senden(Buffer.from('spaet'), s.relay);
  await assert.rejects(k.naechste(() => true, 300), 'abgelaufene Erlaubnis');
  k.hinweis(METHODE.send, [[ATTR.xor_peer_address, peer], [ATTR.data, Buffer.from('spaet')]]);
  assert.equal(await gegen.empfangen(), null);
});

test('ChannelBind + ChannelData hin und zurück; ungültige Nummer → 400', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  const gegen = await peerStelle(); const andere = await peerStelle();
  const binden = (nr, g) => k.authAnfrage(METHODE.channel_bind, [[ATTR.channel_number, kanalNummerKodieren(nr)], [ATTR.xor_peer_address, peerAttr(g.adresse)]], s);
  assert.equal((await binden(0x4001, gegen)).klasse, KLASSE.erfolg);
  await k.senden(kanalDatenBauen(0x4001, Buffer.from('abc')));
  assert.equal((await gegen.empfangen()).daten.toString(), 'abc');
  await gegen.senden(Buffer.from('xyz'), s.relay);
  assert.deepEqual(kanalDatenLesen(await k.naechste(istKanalDaten)), { kanal: 0x4001, daten: Buffer.from('xyz') });
  assert.equal(code(await binden(0x3FFF, gegen)), 400);
  assert.equal(code(await binden(0x7FFF, gegen)), 400);
  assert.equal(code(await binden(0x4001, andere)), 400, 'Nummer gehört schon einer anderen Gegenstelle');
  assert.equal(code(await binden(0x4002, gegen)), 400, 'Gegenstelle hat schon eine andere Nummer');
  assert.equal((await binden(0x4001, gegen)).klasse, KLASSE.erfolg, 'gleiche Bindung erneuern');
  await k.senden(kanalDatenBauen(0x4005, Buffer.from('unbekannt')));
  assert.equal(await gegen.empfangen(), null, 'unbekannter Kanal wird verworfen');
});

test('verbotene Gegenstellen → 403, IPv6 → 443', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  const erlauben = (ip, kk = k, ss = s) => kk.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip, port: 5000 })]], ss);
  assert.equal(code(await erlauben('224.0.0.1')), 403);
  assert.equal(code(await erlauben('0.0.0.0')), 403);
  assert.equal(code(await erlauben('255.255.255.255')), 403);
  assert.equal(code(await erlauben('2001:db8::1')), 443);
  const streng = new TurnDienst({ port: 0, relayVon: 47830, relayBis: 47831, geheimnis: GEHEIM, relayIp: '127.0.0.1', jetzt: () => uhr });
  const p2 = await streng.starten();
  try {
    const k2 = await turnKlient(p2); offen.push(k2);
    const s2 = await k2.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
    const gegen = await peerStelle();
    assert.equal(code(await k2.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr(gegen.adresse)]], s2)), 403, 'NAS selbst (Loopback) gesperrt');
    k2.hinweis(METHODE.send, [[ATTR.xor_peer_address, peerAttr(gegen.adresse)], [ATTR.data, Buffer.from('angriff')]]);
    assert.equal(await gegen.empfangen(), null, 'kein Paket an 127.0.0.1');
  } finally { await streng.stoppen(); }
});

test('Port 0: eingehend verworfen, als Gegenstelle 400 – der Dienst stürzt nicht ab (Prüfbericht Plan 03, C1)', async () => {
  const tx = crypto.randomBytes(12);
  const binding = nachrichtBauen({ methode: METHODE.binding, klasse: KLASSE.anfrage, transaktion: tx, attribute: [] });
  assert.doesNotThrow(() => dienst._eingang(binding, { address: '127.0.0.1', port: 0, family: 'IPv4' }));
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  assert.equal(code(await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip: '8.8.8.8', port: 0 })]], s)), 400);
  assert.equal((await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip: '8.8.8.8', port: 5000 })]], s)).klasse, KLASSE.erfolg);
  const tx2 = crypto.randomBytes(12);
  const senden = nachrichtBauen({ methode: METHODE.send, klasse: KLASSE.hinweis, transaktion: tx2, attribute: [[ATTR.xor_peer_address, adresseKodieren({ ip: '8.8.8.8', port: 0 }, tx2)], [ATTR.data, Buffer.from('x')]] });
  assert.doesNotThrow(() => dienst._eingang(senden, { address: '127.0.0.1', port: k.adresse.port, family: 'IPv4' }));
  assert.equal(dienst.stand().aktiv, true);
});

test('Heimnetz und das NAS selbst gesperrt; Relay zu Relay nur im Relay-Portbereich (Prüfbericht Plan 03, C2)', async () => {
  const streng = new TurnDienst({ port: 0, relayVon: 47840, relayBis: 47843, geheimnis: GEHEIM, relayIp: '192.168.1.29', jetzt: () => uhr });
  const p2 = await streng.starten();
  try {
    const k2 = await turnKlient(p2); offen.push(k2);
    const s2 = await k2.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
    const erlauben = (ip, pt) => k2.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip, port: pt })]], s2);
    for (const [ip, pt] of [['192.168.1.29', 53], ['192.168.1.29', 3478], ['192.168.1.1', 5351], ['192.168.1.5', 5000], ['100.64.0.1', 5000]]) assert.equal(code(await erlauben(ip, pt)), 403, `${ip}:${pt}`);
    assert.equal((await erlauben('192.168.1.29', 47841)).klasse, KLASSE.erfolg, 'Relay zu Relay');
    assert.equal((await erlauben('8.8.8.8', 5000)).klasse, KLASSE.erfolg);
  } finally { await streng.stoppen(); }
});

test('Erlaubnisse begrenzt: höchstens 8 Gegenstellen je Anfrage, 128 je Zuteilung (Prüfbericht Plan 03, I1)', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'anna', uhr));
  const neun = Array.from({ length: 9 }, (_, i) => [ATTR.xor_peer_address, peerAttr({ ip: `8.8.0.${i + 1}`, port: 5000 })]);
  assert.equal(code(await k.authAnfrage(METHODE.create_permission, neun, s)), 400);
  for (let b = 0; b < 16; b++) {
    const acht = Array.from({ length: 8 }, (_, i) => [ATTR.xor_peer_address, peerAttr({ ip: `8.8.${b + 1}.${i + 1}`, port: 5000 })]);
    assert.equal((await k.authAnfrage(METHODE.create_permission, acht, s)).klasse, KLASSE.erfolg, `Block ${b}`);
  }
  assert.equal(code(await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip: '8.9.0.1', port: 5000 })]], s)), 508, '129. Gegenstelle');
  assert.equal((await k.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr({ ip: '8.8.1.1', port: 6000 })]], s)).klasse, KLASSE.erfolg, 'Erneuern geht');
});

test('Zugang entziehen: Zuteilungen sofort weg, vorher ausgegebene Zugänge abgewiesen, spätere gelten (Prüfbericht Plan 03, I6)', async () => {
  const k = await klient(); const s = await k.allocate(zugangsdaten(GEHEIM, 'gast-gAAAAAAAAAAAAAAAA', uhr));
  assert.ok(s.relay); assert.equal(dienst.stand().zuteilungen, 1);
  const alt = zugangsdaten(GEHEIM, 'gast-gAAAAAAAAAAAAAAAA', uhr);
  dienst.zugangEntziehen('gast-gAAAAAAAAAAAAAAAA');
  assert.equal(dienst.stand().zuteilungen, 0, 'Zuteilung geschlossen');
  const k2 = await klient(); const s2 = await k2.allocate(alt);
  assert.equal(s2.relay, null); assert.equal(code(s2.antwort), 401);
  uhr += 1000;
  const k3 = await klient(); const s3 = await k3.allocate(zugangsdaten(GEHEIM, 'gast-gAAAAAAAAAAAAAAAA', uhr));
  assert.ok(s3.relay, 'nach dem Entziehen ausgegebener Zugang gilt');
  const k4 = await klient(); assert.ok((await k4.allocate(zugangsdaten(GEHEIM, 'ben', uhr))).relay, 'andere unberührt');
});

test('Relay zu Relay auf dem NAS: zwei Zuteilungen erreichen sich', async () => {
  const a = await klient(); const b = await klient();
  const sa = await a.allocate(zugangsdaten(GEHEIM, 'anna', uhr)); const sb = await b.allocate(zugangsdaten(GEHEIM, 'ben', uhr));
  assert.equal((await a.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr(sb.relay)]], sa)).klasse, KLASSE.erfolg);
  assert.equal((await b.authAnfrage(METHODE.create_permission, [[ATTR.xor_peer_address, peerAttr(sa.relay)]], sb)).klasse, KLASSE.erfolg);
  a.hinweis(METHODE.send, [[ATTR.xor_peer_address, peerAttr(sb.relay)], [ATTR.data, Buffer.from('nachbar')]]);
  const d = nachrichtLesen(await b.naechste(istStun));
  assert.equal(attr(d, ATTR.data).toString(), 'nachbar');
  assert.deepEqual(adresseLesen(attr(d, ATTR.xor_peer_address), d.transaktion), { familie: 4, ...sa.relay });
});
