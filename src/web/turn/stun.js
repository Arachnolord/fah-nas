// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// STUN-Nachrichten lesen und bauen (RFC 8489, Teilmenge für den eigenen STUN/TURN-Dienst, Plan 03): Kopf mit Magic
// Cookie, Attribute mit Padding, MESSAGE-INTEGRITY (HMAC-SHA1, Kurz- und Langzeit-Schlüssel), FINGERPRINT (CRC-32),
// XOR-Adressen (IPv4/IPv6), ERROR-CODE und ChannelData (RFC 8656). Keine Fremdpakete.

import crypto from 'node:crypto';
import { ipNormal } from '../../agent/helfer/netzadressen.js';

export const MAGIC = 0x2112A442;
export const METHODE = Object.freeze({ binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, create_permission: 0x008, channel_bind: 0x009 });
export const KLASSE = Object.freeze({ anfrage: 0, hinweis: 1, erfolg: 2, fehler: 3 });
export const ATTR = Object.freeze({
  mapped_address: 0x0001, username: 0x0006, message_integrity: 0x0008, error_code: 0x0009, unknown_attributes: 0x000A, channel_number: 0x000C,
  lifetime: 0x000D, xor_peer_address: 0x0012, data: 0x0013, realm: 0x0014, nonce: 0x0015, xor_relayed_address: 0x0016,
  requested_address_family: 0x0017, even_port: 0x0018, requested_transport: 0x0019, dont_fragment: 0x001A, xor_mapped_address: 0x0020,
  reservation_token: 0x0022, priority: 0x0024, use_candidate: 0x0025, software: 0x8022, fingerprint: 0x8028, ice_controlled: 0x8029,
  ice_controlling: 0x802A,
});
const FINGERPRINT_XOR = 0x5354554e;

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, wie in FINGERPRINT) – eigene Tabelle. */
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABELLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Methode + Klasse → 14-Bit-Nachrichtentyp (Klassenbits C0/C1 zwischen den Methodenbits). */
export function typKodieren(m, k) {
  return (m & 0x000F) | ((k & 1) << 4) | ((m & 0x0070) << 1) | ((k & 2) << 7) | ((m & 0x0F80) << 2);
}

export function typLesen(typ) {
  return {
    methode: (typ & 0x000F) | ((typ >> 1) & 0x0070) | ((typ >> 2) & 0x0F80),
    klasse: ((typ >> 4) & 1) | ((typ >> 7) & 2),
  };
}

/** Sieht wie eine vollständige STUN-Nachricht aus (Kopf, Länge, Magic Cookie)? */
export function istStun(buf) {
  if (!buf || buf.length < 20 || (buf[0] & 0xC0) !== 0) return false;
  const laenge = buf.readUInt16BE(2);
  return laenge % 4 === 0 && laenge + 20 === buf.length && buf.readUInt32BE(4) === MAGIC;
}

/** ChannelData (Kanalnummer 0x4000–0x7FFF im ersten Wort)? */
export function istKanalDaten(buf) { return !!buf && buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x7F; }

const auf4 = (n) => (n + 3) & ~3;

/** Nachricht zerlegen; Attribute nach MESSAGE-INTEGRITY zählen nur, wenn es FINGERPRINT ist. Kaputt → Error('stun_kaputt'). */
export function nachrichtLesen(buf) {
  if (!buf || buf.length < 20 || (buf[0] & 0xC0) !== 0) throw new Error('stun_kaputt');
  const laenge = buf.readUInt16BE(2);
  if (laenge % 4 !== 0 || 20 + laenge > buf.length || buf.readUInt32BE(4) !== MAGIC) throw new Error('stun_kaputt');
  const roh = buf.subarray(0, 20 + laenge);
  const { methode, klasse } = typLesen(roh.readUInt16BE(0));
  const attribute = []; let mi = null; let fp = null;
  let pos = 20;
  while (pos < roh.length) {
    if (pos + 4 > roh.length) throw new Error('stun_kaputt');
    const typ = roh.readUInt16BE(pos); const len = roh.readUInt16BE(pos + 2);
    if (pos + 4 + len > roh.length) throw new Error('stun_kaputt');
    const wert = roh.subarray(pos + 4, pos + 4 + len);
    if (fp === null && (mi === null || typ === ATTR.fingerprint)) {
      if (typ === ATTR.message_integrity) mi = pos;
      if (typ === ATTR.fingerprint) fp = pos;
      attribute.push({ typ, wert });
    }
    pos += 4 + auf4(len);
  }
  return { methode, klasse, transaktion: roh.subarray(8, 20), attribute, mi, fp, roh };
}

export function attr(nachricht, typ) { const a = nachricht.attribute.find((x) => x.typ === typ); return a ? a.wert : null; }
export function alleAttr(nachricht, typ) { return nachricht.attribute.filter((x) => x.typ === typ).map((x) => x.wert); }

function hmac(schluessel, daten) { return crypto.createHmac('sha1', schluessel).update(daten).digest(); }

/** MESSAGE-INTEGRITY prüfen (zeitkonstant); ohne das Attribut → false. */
export function integritaetPruefen(nachricht, schluessel) {
  const { mi, roh } = nachricht;
  if (mi === null || mi + 24 > roh.length || roh.readUInt16BE(mi + 2) !== 20) return false;
  const kopie = Buffer.from(roh.subarray(0, mi));
  kopie.writeUInt16BE(mi + 24 - 20, 2);
  return crypto.timingSafeEqual(hmac(schluessel, kopie), roh.subarray(mi + 4, mi + 24));
}

/** FINGERPRINT prüfen; ohne das Attribut → null. */
export function fingerprintPruefen(nachricht) {
  const { fp, roh } = nachricht;
  if (fp === null) return null;
  if (fp + 8 > roh.length || roh.readUInt16BE(fp + 2) !== 4) return false;
  return ((crc32(roh.subarray(0, fp)) ^ FINGERPRINT_XOR) >>> 0) === roh.readUInt32BE(fp + 4);
}

function attributKodieren(typ, wert, fuellung) {
  const b = Buffer.alloc(4 + auf4(wert.length), fuellung);
  b.writeUInt16BE(typ, 0); b.writeUInt16BE(wert.length, 2); wert.copy(b, 4);
  return b;
}

/** Nachricht bauen; mit `schluessel` folgt MESSAGE-INTEGRITY, mit `fingerprint` FINGERPRINT (Padding mit `fuellung`). */
export function nachrichtBauen({ methode, klasse, transaktion, attribute = [], schluessel = null, fingerprint = true, fuellung = 0 }) {
  const kopf = Buffer.alloc(20);
  kopf.writeUInt16BE(typKodieren(methode, klasse), 0);
  kopf.writeUInt32BE(MAGIC, 4);
  Buffer.from(transaktion).copy(kopf, 8, 0, 12);
  let teile = Buffer.concat([kopf, ...attribute.map(([typ, wert]) => attributKodieren(typ, Buffer.from(wert), fuellung))]);
  if (schluessel) {
    teile.writeUInt16BE(teile.length - 20 + 24, 2);
    teile = Buffer.concat([teile, attributKodieren(ATTR.message_integrity, hmac(schluessel, teile), 0)]);
  }
  if (fingerprint) {
    teile.writeUInt16BE(teile.length - 20 + 8, 2);
    const wert = Buffer.alloc(4); wert.writeUInt32BE((crc32(teile) ^ FINGERPRINT_XOR) >>> 0, 0);
    teile = Buffer.concat([teile, attributKodieren(ATTR.fingerprint, wert, 0)]);
  }
  teile.writeUInt16BE(teile.length - 20, 2);
  return teile;
}

function xorMaske(transaktion) { const m = Buffer.alloc(16); m.writeUInt32BE(MAGIC, 0); Buffer.from(transaktion).copy(m, 4, 0, 12); return m; }

/** (XOR-)Adresse lesen → {familie: 4|6, ip, port}; IPv6 in kanonischer Kurzform. */
export function adresseLesen(wert, transaktion, { xor = true } = {}) {
  if (!wert || wert.length < 8) throw new Error('stun_kaputt');
  const familie = wert[1] === 0x01 ? 4 : wert[1] === 0x02 ? 6 : 0;
  if (!familie || wert.length !== (familie === 4 ? 8 : 20)) throw new Error('stun_kaputt');
  const port = wert.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0);
  const maske = xorMaske(transaktion);
  const roh = Buffer.from(wert.subarray(4));
  if (xor) for (let i = 0; i < roh.length; i++) roh[i] ^= maske[i];
  if (familie === 4) return { familie, ip: [...roh].join('.'), port };
  const gruppen = []; for (let i = 0; i < 16; i += 2) gruppen.push(roh.readUInt16BE(i).toString(16));
  return { familie, ip: ipNormal(gruppen.join(':')), port };
}

/** Adresse als (XOR-)Attributwert kodieren. */
export function adresseKodieren({ ip, port }, transaktion, { xor = true } = {}) {
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const b = Buffer.alloc(v4 ? 8 : 20);
  b[1] = v4 ? 0x01 : 0x02;
  b.writeUInt16BE((port ^ (xor ? MAGIC >>> 16 : 0)) & 0xFFFF, 2);
  if (v4) ip.split('.').forEach((x, i) => { b[4 + i] = Number(x); });
  else {
    const voll = new URL(`http://[${ip}]/`).hostname.slice(1, -1); // kanonisch, dann ausschreiben
    const [links, rechts = ''] = voll.split('::');
    const l = links ? links.split(':') : []; const r = rechts ? rechts.split(':') : [];
    const gruppen = voll.includes('::') ? [...l, ...Array(8 - l.length - r.length).fill('0'), ...r] : l;
    gruppen.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), 4 + i * 2));
  }
  if (xor) { const m = xorMaske(transaktion); for (let i = 4; i < b.length; i++) b[i] ^= m[i - 4]; }
  return b;
}

export function fehlerKodieren(code, grund) {
  const text = Buffer.from(String(grund || ''), 'utf8');
  const b = Buffer.alloc(4 + text.length);
  b[2] = Math.floor(code / 100) & 0x07; b[3] = code % 100; text.copy(b, 4);
  return b;
}

export function fehlerLesen(wert) {
  if (!wert || wert.length < 4) return { code: 0, grund: '' };
  return { code: (wert[2] & 0x07) * 100 + wert[3], grund: wert.subarray(4).toString('utf8') };
}

export function zahl32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

export function kanalNummerKodieren(n) { const b = Buffer.alloc(4); b.writeUInt16BE(n, 0); return b; }

/** ChannelData zerlegen; Längenfeld größer als der Rest → null. */
export function kanalDatenLesen(buf) {
  if (!istKanalDaten(buf)) return null;
  const len = buf.readUInt16BE(2);
  if (4 + len > buf.length) return null;
  return { kanal: buf.readUInt16BE(0), daten: buf.subarray(4, 4 + len) };
}

/** ChannelData bauen (über UDP ohne Padding). */
export function kanalDatenBauen(kanal, daten) {
  const b = Buffer.alloc(4 + daten.length);
  b.writeUInt16BE(kanal, 0); b.writeUInt16BE(daten.length, 2); Buffer.from(daten).copy(b, 4);
  return b;
}

/** Langzeit-Schlüssel MD5(username:realm:passwort). */
export function langzeitSchluessel(username, realm, passwort) {
  return crypto.createHash('md5').update(`${username}:${realm}:${passwort}`, 'utf8').digest();
}
