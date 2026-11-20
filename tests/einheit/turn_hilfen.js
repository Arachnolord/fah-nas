// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Testhilfen für den TURN-Dienst: ein UDP-Klient, der STUN-Anfragen stellt (inkl. 401-Tanz und Langzeit-Schlüssel),
// und eine Gegenstelle („Peer“) auf 127.0.0.1, die Pakete vom Relay empfängt und zurückschickt.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { KLASSE, ATTR, METHODE, nachrichtBauen, nachrichtLesen, attr, adresseLesen, langzeitSchluessel, istStun, zahl32 } from '../../src/web/turn/stun.js';

export const GEHEIM = Buffer.alloc(32, 7);

async function binden() {
  const s = dgram.createSocket('udp4');
  await new Promise((ok) => s.bind(0, '127.0.0.1', ok));
  return s;
}

/** Klient gegen den TURN-Dienst auf 127.0.0.1:port. */
export async function turnKlient(port) {
  const s = await binden();
  const eingang = []; const warter = [];
  s.on('message', (buf) => {
    const i = warter.findIndex((w) => w.pruef(buf));
    if (i >= 0) { const [w] = warter.splice(i, 1); clearTimeout(w.t); w.ok(buf); } else eingang.push(buf);
  });
  const naechste = (pruef = () => true, ms = 2000) => new Promise((ok, nein) => {
    const i = eingang.findIndex(pruef);
    if (i >= 0) { ok(eingang.splice(i, 1)[0]); return; }
    const w = { pruef, ok, t: setTimeout(() => { warter.splice(warter.indexOf(w), 1); nein(new Error('keine Antwort')); }, ms) };
    warter.push(w);
  });
  const senden = (buf) => new Promise((ok) => s.send(buf, port, '127.0.0.1', () => ok()));
  const aufloesen = (attribute, tx) => attribute.map(([typ, w]) => [typ, typeof w === 'function' ? w(tx) : w]);
  async function anfrage(methode, attribute = [], { schluessel = null, transaktion = crypto.randomBytes(12) } = {}) {
    await senden(nachrichtBauen({ methode, klasse: KLASSE.anfrage, transaktion, attribute: aufloesen(attribute, transaktion), schluessel }));
    return nachrichtLesen(await naechste((b) => istStun(b) && b.subarray(8, 20).equals(transaktion)));
  }
  async function authAnfrage(methode, attribute, sitzung, { transaktion } = {}) {
    return anfrage(methode, [...attribute, [ATTR.username, Buffer.from(sitzung.zugang.username)], [ATTR.realm, Buffer.from(sitzung.realm)], [ATTR.nonce, Buffer.from(sitzung.nonce)]],
      { schluessel: sitzung.schluessel, transaktion });
  }
  async function allocate(zugang, { transport = 17, lifetime } = {}) {
    const basis = [[ATTR.requested_transport, Buffer.from([transport, 0, 0, 0])], ...(lifetime !== undefined ? [[ATTR.lifetime, zahl32(lifetime)]] : [])];
    const erste = await anfrage(METHODE.allocate, basis);
    const realm = attr(erste, ATTR.realm).toString(); const nonce = attr(erste, ATTR.nonce).toString();
    const sitzung = { zugang, realm, nonce, schluessel: langzeitSchluessel(zugang.username, realm, zugang.credential) };
    const antwort = await authAnfrage(METHODE.allocate, basis, sitzung);
    const r = attr(antwort, ATTR.xor_relayed_address);
    const relay = r ? adresseLesen(r, antwort.transaktion) : null;
    return { ...sitzung, antwort, relay: relay ? { ip: relay.ip, port: relay.port } : null };
  }
  function hinweis(methode, attribute) {
    const tx = crypto.randomBytes(12);
    s.send(nachrichtBauen({ methode, klasse: KLASSE.hinweis, transaktion: tx, attribute: aufloesen(attribute, tx) }), port, '127.0.0.1');
  }
  return { adresse: { ip: '127.0.0.1', port: s.address().port }, senden, naechste, anfrage, allocate, authAnfrage, hinweis, schliessen: () => new Promise((ok) => s.close(ok)) };
}

/** Gegenstelle auf 127.0.0.1: empfangen(ms) → {daten, von} oder null (nichts angekommen). */
export async function gegenstelle() {
  const s = await binden();
  const eingang = []; let warter = null;
  s.on('message', (daten, r) => { const p = { daten, von: { ip: r.address, port: r.port } }; if (warter) { const w = warter; warter = null; clearTimeout(w.t); w.ok(p); } else eingang.push(p); });
  return {
    adresse: { ip: '127.0.0.1', port: s.address().port },
    empfangen: (ms = 300) => new Promise((ok) => {
      if (eingang.length) { ok(eingang.shift()); return; }
      warter = { ok, t: setTimeout(() => { warter = null; ok(null); }, ms) };
    }),
    senden: (buf, { ip, port }) => new Promise((ok) => s.send(buf, port, ip, () => ok())),
    schliessen: () => new Promise((ok) => s.close(ok)),
  };
}
