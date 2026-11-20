// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigener STUN/TURN-Dienst (Plan 03, RFC 8489/8656 Teilmenge, nur UDP/IPv4): Binding für alle, Zuteilungen (Allocate,
// Refresh) nur mit zeitlich begrenzten Zugangsdaten (Langzeit-Schlüssel aus dem HMAC-Passwort), Nonce mit Zeitstempel,
// höchstens 6 Zuteilungen je Identität und so viele wie Relay-Ports (49160–49200). Läuft im Web-Prozess; protokolliert
// nur Start, Stopp und Fehler – nie einzelne Pakete.

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  METHODE, KLASSE, ATTR, istStun, istKanalDaten, nachrichtLesen, attr, alleAttr, integritaetPruefen, fingerprintPruefen, nachrichtBauen, adresseLesen,
  adresseKodieren, fehlerKodieren, zahl32, langzeitSchluessel, kanalDatenLesen, kanalDatenBauen,
} from './stun.js';
import { passwortFuer, usernameLesen, REALM, GUELTIG_S } from './zugang.js';
import { istPrivat, ipNormal } from '../../agent/helfer/netzadressen.js';

export const SOFTWARE = 'FAH-NAS';
export const ZEITEN = Object.freeze({ lebensdauer_s: 600, max_lebensdauer_s: 3600, erlaubnis_s: 300, kanal_s: 600, nonce_s: 600, takt_ms: 30_000 });
export const JE_IDENTITAET = 6;
/** Erlaubnisse: höchstens 8 Gegenstellen je CreatePermission, 128 je Zuteilung (sonst wüchse der Speicher; Prüfbericht Plan 03, I1). */
export const ERLAUBNISSE = Object.freeze({ je_anfrage: 8, je_zuteilung: 128 });

const BEKANNT = new Set(Object.values(ATTR));
const AUTH_METHODEN = new Set([METHODE.allocate, METHODE.refresh, METHODE.create_permission, METHODE.channel_bind]);
const GRUND = Object.freeze({
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 420: 'Unknown Attribute', 437: 'Allocation Mismatch', 438: 'Stale Nonce',
  440: 'Address Family not Supported', 441: 'Wrong Credentials', 442: 'Unsupported Transport Protocol', 443: 'Peer Address Family Mismatch',
  486: 'Allocation Quota Reached', 508: 'Insufficient Capacity',
});

// Gegenstellen, an die das Relay nie weiterleitet: „dieses Netz“, Loopback, private Netze (Heimnetz – sonst hätte jeder
// Gast UDP-Zugang ins LAN und zu den Diensten des NAS), CGNAT, Link-Local, Multicast, reserviert/Broadcast; IPv6
// unspezifiziert, Loopback, Multicast. Einzige Ausnahme im Dienst: die NAS-IP im Relay-Portbereich (Relay zu Relay).
const GESPERRT = new net.BlockList();
for (const [netz, praefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) GESPERRT.addSubnet(netz, praefix, 'ipv4');
GESPERRT.addAddress('::', 'ipv6'); GESPERRT.addAddress('::1', 'ipv6'); GESPERRT.addSubnet('ff00::', 8, 'ipv6');
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');

/** Darf das Relay an diese Adresse weiterleiten? `loopback` (nur Tests) erlaubt 127.0.0.0/8. */
export function gegenstelleErlaubt(ip, { loopback = false } = {}) {
  const a = ipNormal(ip);
  if (!a) return false;
  const art = net.isIP(a) === 4 ? 'ipv4' : 'ipv6';
  if (loopback && art === 'ipv4' && LOOPBACK.check(a, 'ipv4')) return true;
  return !GESPERRT.check(a, art);
}

/** Kommt die Adresse von außerhalb des Heimnetzes? */
export function istExtern(ip) { return !istPrivat(ip); }

/** Eigene Adressen des Rechners (alle Schnittstellen). */
function eigeneAdressen() {
  const aus = new Set();
  try { for (const liste of Object.values(os.networkInterfaces())) for (const a of liste || []) { const n = ipNormal(a.address); if (n) aus.add(n); } } catch { /* ohne */ }
  return aus;
}

/** UDP senden, ohne je zu werfen: Port 0 oder ein ungültiges Ziel würfe synchron im message-Behandler – und beendete den Web-Dienst. */
function sicherSenden(socket, buf, port, ip) {
  if (!socket || !Number.isInteger(port) || port <= 0 || port > 65535) return;
  try { socket.send(buf, port, ip); } catch { /* ungültiges Ziel oder Socket zu */ }
}

export class TurnDienst extends EventEmitter {
  constructor({ port = 3478, relayVon = 49160, relayBis = 49200, realm = REALM, geheimnis, relayIp, protokoll = null, loopbackErlauben = false, jetzt = () => Date.now() } = {}) {
    super();
    this.portWunsch = port; this.relayVon = relayVon; this.relayBis = relayBis; this.realm = realm; this.geheimnis = geheimnis; this.relayIp = relayIp;
    this.protokoll = protokoll; this.loopbackErlauben = loopbackErlauben; this.jetzt = jetzt;
    this.socket = null; this.port = null; this.takt = null; this.extern_zuletzt = null;
    this.zuteilungen = new Map(); // '<ip>:<port>' des Klienten → Zuteilung
    this.inArbeit = new Set(); // Klienten, deren Allocate gerade einen Relay-Port bindet
    this.reserviert = new Set(); // Relay-Ports, die gerade gebunden werden
    this.nonceSchluessel = crypto.randomBytes(32);
    this.eigene = eigeneAdressen();
    this.entzogen = new Map(); // wer → Sekunde des Entzugs: bis dahin ausgegebene Zugänge gelten nicht mehr
  }

  /**
   * Zugang entziehen (Gast entfernt, Nutzer gesperrt/gelöscht; Prüfbericht Plan 03, I6): Zuteilungen sofort schließen,
   * bis jetzt ausgegebene Zugänge abweisen. Danach ausgegebene gelten wieder (z. B. neu angelegtes Konto).
   */
  zugangEntziehen(wer, ab = this.jetzt()) {
    this.entzogen.set(wer, Math.floor(ab / 1000));
    for (const [k, z] of this.zuteilungen) if (z.wer === wer) { this._schliessen(z); this.zuteilungen.delete(k); }
  }

  /**
   * Darf das Relay an ip:port senden bzw. von dort annehmen? Nie Port 0; die NAS-IP nur im Relay-Portbereich (Relay zu
   * Relay), andere eigene Adressen nie; sonst gegenstelleErlaubt (öffentliche Adressen). Tests erlauben Loopback.
   */
  _zielErlaubt(ip, port) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
    const a = ipNormal(ip);
    if (!a) return false;
    if (this.loopbackErlauben && net.isIP(a) === 4 && LOOPBACK.check(a, 'ipv4')) return true;
    if (a === this.relayIp) return port >= this.relayVon && port <= this.relayBis;
    if (this.eigene.has(a)) return false;
    return gegenstelleErlaubt(a);
  }

  /** Startet den Dienst; gibt den tatsächlichen Port zurück. Belegter Port → Fehler mit code 'EADDRINUSE'. */
  async starten() {
    if (this.socket) return this.port;
    this.nonceSchluessel = crypto.randomBytes(32);
    const s = dgram.createSocket('udp4');
    try {
      await new Promise((ok, nein) => {
        s.once('error', nein);
        s.bind(this.portWunsch, '0.0.0.0', () => { s.removeListener('error', nein); ok(); });
      });
    } catch (e) {
      try { s.close(); } catch { /* schon zu */ }
      this.protokoll?.eintrag?.('turn', { ereignis: 'fehler', code: e && e.code });
      throw e;
    }
    s.on('error', (e) => this.protokoll?.eintrag?.('turn', { ereignis: 'fehler', code: e && e.code }));
    s.on('message', (buf, rinfo) => this._eingang(buf, rinfo));
    this.socket = s; this.port = s.address().port;
    this.takt = setInterval(() => this.aufraeumen(), ZEITEN.takt_ms); this.takt.unref?.();
    this.protokoll?.eintrag?.('turn', { ereignis: 'start', port: this.port });
    return this.port;
  }

  async stoppen() {
    if (this.takt) { clearInterval(this.takt); this.takt = null; }
    for (const z of this.zuteilungen.values()) this._schliessen(z);
    this.zuteilungen.clear();
    const s = this.socket; this.socket = null;
    if (!s) return;
    await new Promise((ok) => { try { s.close(ok); } catch { ok(); } });
    this.protokoll?.eintrag?.('turn', { ereignis: 'stopp' });
  }

  stand() { return { aktiv: !!this.socket, port: this.port, zuteilungen: this.zuteilungen.size, extern_zuletzt: this.extern_zuletzt }; }

  /** Abgelaufene Zuteilungen (samt Relay-Socket), Erlaubnisse und Kanäle entfernen. */
  aufraeumen(jetzt = this.jetzt()) {
    for (const [wer, ab] of this.entzogen) if (Math.floor(jetzt / 1000) - ab > GUELTIG_S) this.entzogen.delete(wer);
    for (const [k, z] of this.zuteilungen) {
      if (z.ablauf <= jetzt) { this._schliessen(z); this.zuteilungen.delete(k); continue; }
      for (const [ip, ab] of z.erlaubnisse) if (ab <= jetzt) z.erlaubnisse.delete(ip);
      for (const [nr, kanal] of z.kanaele) if (kanal.ablauf <= jetzt) { z.kanaele.delete(nr); z.kanalVon.delete(`${kanal.ip}:${kanal.port}`); }
    }
  }

  _schliessen(z) { try { z.socket.close(); } catch { /* schon zu */ } }

  _eingang(buf, rinfo) {
    // Quellport 0 (gefälschte Pakete) nie beantworten; nichts im Pfad darf werfen – sonst stürzte der Web-Dienst ab
    if (!rinfo || !Number.isInteger(rinfo.port) || rinfo.port <= 0) return;
    try {
      if (istStun(buf)) {
        let n;
        try { n = nachrichtLesen(buf); } catch { return; }
        if (fingerprintPruefen(n) === false) return;
        if (n.klasse === KLASSE.anfrage) this._anfrage(n, rinfo);
        else if (n.klasse === KLASSE.hinweis) this._hinweis(n, rinfo);
        return;
      }
      if (istKanalDaten(buf)) this._kanalDaten(buf, rinfo);
    } catch (e) {
      this.protokoll?.eintrag?.('turn', { ereignis: 'fehler', code: (e && e.code) || 'eingang' });
    }
  }

  _an(ziel, buf) { sicherSenden(this.socket, buf, ziel.port, ziel.ip); }

  _erlaubt(z, ip, jetzt = this.jetzt()) { const ab = z.erlaubnisse.get(ip); return !!ab && ab > jetzt; }

  /** XOR-PEER-ADDRESS lesen und filtern: → {ip, port} oder Fehlercode (400 kaputt, 443 IPv6, 403 gesperrt). */
  _gegenstelle(wert, transaktion) {
    let p;
    try { p = adresseLesen(wert, transaktion); } catch { return 400; }
    if (p.familie !== 4) return 443;
    if (!Number.isInteger(p.port) || p.port <= 0) return 400;
    if (!this._zielErlaubt(p.ip, p.port)) return 403;
    return { ip: p.ip, port: p.port };
  }

  /** Send-Indication vom Klienten → Gegenstelle (nur mit gültiger Erlaubnis; Indications werden nie beantwortet). */
  _hinweis(n, rinfo) {
    if (n.methode !== METHODE.send) return;
    const z = this.zuteilungen.get(`${rinfo.address}:${rinfo.port}`);
    const peer = attr(n, ATTR.xor_peer_address); const daten = attr(n, ATTR.data);
    if (!z || !peer || !daten) return;
    const p = this._gegenstelle(peer, n.transaktion);
    if (typeof p === 'number' || !this._erlaubt(z, p.ip)) return;
    sicherSenden(z.socket, daten, p.port, p.ip);
  }

  /** ChannelData vom Klienten → Gegenstelle des Kanals. */
  _kanalDaten(buf, rinfo) {
    const z = this.zuteilungen.get(`${rinfo.address}:${rinfo.port}`);
    const kd = z ? kanalDatenLesen(buf) : null;
    if (!kd) return;
    const jetzt = this.jetzt();
    const k = z.kanaele.get(kd.kanal);
    if (!k || k.ablauf <= jetzt || !this._erlaubt(z, k.ip, jetzt)) return;
    sicherSenden(z.socket, kd.daten, k.port, k.ip);
  }

  /** Paket einer Gegenstelle am Relay-Port → als ChannelData (Kanal gebunden) oder Data-Indication an den Klienten. */
  _relayEingang(z, buf, r) {
    if (!r || !this._zielErlaubt(r.address, r.port)) return; // Port 0, Heimnetz, NAS außerhalb des Relay-Bereichs
    const jetzt = this.jetzt();
    if (z.ablauf <= jetzt || !this._erlaubt(z, r.address, jetzt)) return;
    const nr = z.kanalVon.get(`${r.address}:${r.port}`);
    const k = nr !== undefined ? z.kanaele.get(nr) : null;
    if (k && k.ablauf > jetzt) { this._an(z.quelle, kanalDatenBauen(nr, buf)); return; }
    const tx = crypto.randomBytes(12);
    this._an(z.quelle, nachrichtBauen({ methode: METHODE.data, klasse: KLASSE.hinweis, transaktion: tx, fingerprint: false,
      attribute: [[ATTR.xor_peer_address, adresseKodieren({ ip: r.address, port: r.port }, tx)], [ATTR.data, buf]] }));
  }

  _erlaubnis(n, rinfo, z, auth) {
    const werte = alleAttr(n, ATTR.xor_peer_address);
    if (!werte.length || werte.length > ERLAUBNISSE.je_anfrage) { this._fehler(n, rinfo, 400, { schluessel: auth.schluessel }); return; }
    const peers = werte.map((w) => this._gegenstelle(w, n.transaktion));
    const fehler = peers.find((p) => typeof p === 'number');
    if (fehler) { this._fehler(n, rinfo, fehler, { schluessel: auth.schluessel }); return; }
    const jetzt = this.jetzt();
    if (!this._platzFuerErlaubnisse(z, peers.map((p) => p.ip), jetzt)) { this._fehler(n, rinfo, 508, { schluessel: auth.schluessel }); return; }
    const ab = jetzt + ZEITEN.erlaubnis_s * 1000;
    for (const p of peers) z.erlaubnisse.set(p.ip, ab);
    this._erfolg(n, rinfo, [], auth.schluessel);
  }

  /** Passen die neuen IPs noch unter die Obergrenze je Zuteilung? Abgelaufene Erlaubnisse zählen nicht. */
  _platzFuerErlaubnisse(z, ips, jetzt) {
    for (const [ip, ab] of z.erlaubnisse) if (ab <= jetzt) z.erlaubnisse.delete(ip);
    const neu = new Set(ips.filter((ip) => !z.erlaubnisse.has(ip)));
    return z.erlaubnisse.size + neu.size <= ERLAUBNISSE.je_zuteilung;
  }

  _kanal(n, rinfo, z, auth) {
    const fehler = (code) => this._fehler(n, rinfo, code, { schluessel: auth.schluessel });
    const nrWert = attr(n, ATTR.channel_number); const peer = attr(n, ATTR.xor_peer_address);
    if (!nrWert || nrWert.length !== 4 || !peer) { fehler(400); return; }
    const nr = nrWert.readUInt16BE(0);
    if (nr < 0x4000 || nr > 0x7FFE) { fehler(400); return; }
    const p = this._gegenstelle(peer, n.transaktion);
    if (typeof p === 'number') { fehler(p); return; }
    const jetzt = this.jetzt();
    const schl = `${p.ip}:${p.port}`;
    for (const [k, v] of z.kanaele) if (v.ablauf <= jetzt) { z.kanaele.delete(k); z.kanalVon.delete(`${v.ip}:${v.port}`); }
    const alt = z.kanaele.get(nr);
    if (alt && (alt.ip !== p.ip || alt.port !== p.port)) { fehler(400); return; }
    const altNr = z.kanalVon.get(schl);
    if (altNr !== undefined && altNr !== nr) { fehler(400); return; }
    if (!this._platzFuerErlaubnisse(z, [p.ip], jetzt)) { fehler(508); return; }
    z.kanaele.set(nr, { ip: p.ip, port: p.port, ablauf: jetzt + ZEITEN.kanal_s * 1000 });
    z.kanalVon.set(schl, nr);
    z.erlaubnisse.set(p.ip, jetzt + ZEITEN.erlaubnis_s * 1000);
    this._erfolg(n, rinfo, [], auth.schluessel);
  }

  _senden(rinfo, buf) { sicherSenden(this.socket, buf, rinfo.port, rinfo.address); }

  _erfolg(n, rinfo, attribute, schluessel = null) {
    const b = nachrichtBauen({ methode: n.methode, klasse: KLASSE.erfolg, transaktion: n.transaktion, attribute: [...attribute, [ATTR.software, Buffer.from(SOFTWARE)]], schluessel });
    this._senden(rinfo, b);
    return b;
  }

  _fehler(n, rinfo, code, { schluessel = null, extra = [] } = {}) {
    const b = nachrichtBauen({ methode: n.methode, klasse: KLASSE.fehler, transaktion: n.transaktion, attribute: [[ATTR.error_code, fehlerKodieren(code, GRUND[code] || '')], ...extra], schluessel });
    this._senden(rinfo, b);
    return null;
  }

  _nonce() {
    const ts = Math.floor(this.jetzt()).toString(16);
    return `${ts}-${crypto.createHmac('sha256', this.nonceSchluessel).update(ts).digest('base64url').slice(0, 22)}`;
  }

  /** 'gut' | 'alt' (älter als 600 s) | 'falsch' (nicht von diesem Dienst). */
  _nonceStand(nonce) {
    const m = /^([0-9a-f]{1,13})-([A-Za-z0-9_-]{22})$/.exec(nonce);
    if (!m) return 'falsch';
    const soll = Buffer.from(crypto.createHmac('sha256', this.nonceSchluessel).update(m[1]).digest('base64url').slice(0, 22));
    if (!crypto.timingSafeEqual(soll, Buffer.from(m[2]))) return 'falsch';
    return this.jetzt() - parseInt(m[1], 16) > ZEITEN.nonce_s * 1000 ? 'alt' : 'gut';
  }

  _abweisen(n, rinfo, code = 401) {
    return this._fehler(n, rinfo, code, { extra: [[ATTR.realm, Buffer.from(this.realm)], [ATTR.nonce, Buffer.from(this._nonce())]] });
  }

  /** Langzeit-Zugang prüfen (bei jeder Anfrage): → {username, wer, schluessel} oder null (Fehler ist gesendet). */
  _pruefen(n, rinfo) {
    const u = attr(n, ATTR.username); const realm = attr(n, ATTR.realm); const nonce = attr(n, ATTR.nonce);
    if (n.mi === null || !u || !realm || !nonce) return this._abweisen(n, rinfo);
    const nonceStand = this._nonceStand(nonce.toString());
    if (nonceStand === 'falsch' || realm.toString() !== this.realm) return this._abweisen(n, rinfo);
    const username = u.toString('utf8');
    const info = usernameLesen(username);
    if (!info || info.ablauf_s * 1000 <= this.jetzt()) return this._abweisen(n, rinfo);
    const entzogen = this.entzogen.get(info.wer);
    if (entzogen !== undefined && info.ablauf_s - GUELTIG_S <= entzogen) return this._abweisen(n, rinfo);
    const schluessel = langzeitSchluessel(username, this.realm, passwortFuer(this.geheimnis, username));
    if (!integritaetPruefen(n, schluessel)) return this._abweisen(n, rinfo);
    if (nonceStand === 'alt') return this._abweisen(n, rinfo, 438);
    return { username, wer: info.wer, schluessel };
  }

  _anfrage(n, rinfo) {
    if (n.methode === METHODE.binding) {
      this._erfolg(n, rinfo, [[ATTR.xor_mapped_address, adresseKodieren({ ip: rinfo.address, port: rinfo.port }, n.transaktion)]]);
      return;
    }
    if (!AUTH_METHODEN.has(n.methode)) { this._fehler(n, rinfo, 400); return; }
    const auth = this._pruefen(n, rinfo);
    if (!auth) return;
    if (n.methode === METHODE.allocate) { this._allocate(n, rinfo, auth).catch((e) => this.protokoll?.eintrag?.('turn', { ereignis: 'fehler', code: e && e.code })); return; }
    const z = this.zuteilungen.get(`${rinfo.address}:${rinfo.port}`);
    if (!z) { this._fehler(n, rinfo, 437, { schluessel: auth.schluessel }); return; }
    if (z.username !== auth.username) { this._fehler(n, rinfo, 441, { schluessel: auth.schluessel }); return; }
    if (n.methode === METHODE.refresh) this._refresh(n, rinfo, z, auth);
    else if (n.methode === METHODE.create_permission) this._erlaubnis(n, rinfo, z, auth);
    else this._kanal(n, rinfo, z, auth);
  }

  static lebensdauer(n) {
    const lt = attr(n, ATTR.lifetime);
    const angefragt = lt && lt.length === 4 ? lt.readUInt32BE(0) : null;
    return { angefragt, sekunden: Math.min(ZEITEN.max_lebensdauer_s, Math.max(ZEITEN.lebensdauer_s, angefragt ?? ZEITEN.lebensdauer_s)) };
  }

  async _allocate(n, rinfo, auth) {
    const quelle = `${rinfo.address}:${rinfo.port}`;
    const schluessel = auth.schluessel;
    const vorhanden = this.zuteilungen.get(quelle);
    if (vorhanden) {
      if (vorhanden.transaktion.equals(n.transaktion)) this._senden(rinfo, vorhanden.antwort);
      else this._fehler(n, rinfo, 437, { schluessel });
      return;
    }
    if (this.inArbeit.has(quelle)) return; // Wiederholung, während der Relay-Port gebunden wird
    const unbekannt = n.attribute.filter((a) => (a.typ < 0x8000 && !BEKANNT.has(a.typ)) || a.typ === ATTR.even_port || a.typ === ATTR.reservation_token).map((a) => a.typ);
    if (unbekannt.length) {
      const w = Buffer.alloc(unbekannt.length * 2); unbekannt.forEach((t, i) => w.writeUInt16BE(t, i * 2));
      this._fehler(n, rinfo, 420, { schluessel, extra: [[ATTR.unknown_attributes, w]] });
      return;
    }
    const familie = attr(n, ATTR.requested_address_family);
    if (familie && familie[0] !== 0x01) { this._fehler(n, rinfo, 440, { schluessel }); return; }
    const transport = attr(n, ATTR.requested_transport);
    if (!transport) { this._fehler(n, rinfo, 400, { schluessel }); return; }
    if (transport[0] !== 17) { this._fehler(n, rinfo, 442, { schluessel }); return; }
    if ([...this.zuteilungen.values()].filter((z) => z.wer === auth.wer).length >= JE_IDENTITAET) { this._fehler(n, rinfo, 486, { schluessel }); return; }
    this.inArbeit.add(quelle);
    let relay;
    try { relay = await this._relayBinden(); } finally { this.inArbeit.delete(quelle); }
    if (!relay) { this._fehler(n, rinfo, 508, { schluessel }); return; }
    if (!this.socket) { try { relay.socket.close(); } catch { /* zu */ } return; } // inzwischen gestoppt
    const jetzt = this.jetzt();
    const { sekunden } = TurnDienst.lebensdauer(n);
    const z = {
      quelle: { ip: rinfo.address, port: rinfo.port }, username: auth.username, wer: auth.wer, schluessel, transaktion: Buffer.from(n.transaktion),
      relayPort: relay.port, socket: relay.socket, ablauf: jetzt + sekunden * 1000,
      erlaubnisse: new Map(), kanaele: new Map(), kanalVon: new Map(), antwort: null,
    };
    z.antwort = this._erfolg(n, rinfo, [
      [ATTR.xor_relayed_address, adresseKodieren({ ip: this.relayIp, port: relay.port }, n.transaktion)],
      [ATTR.lifetime, zahl32(sekunden)],
      [ATTR.xor_mapped_address, adresseKodieren({ ip: rinfo.address, port: rinfo.port }, n.transaktion)],
    ], schluessel);
    this.zuteilungen.set(quelle, z);
    relay.socket.on('message', (buf, r) => { try { this._relayEingang(z, buf, r); } catch (e) { this.protokoll?.eintrag?.('turn', { ereignis: 'fehler', code: (e && e.code) || 'relay' }); } });
    const extern = istExtern(rinfo.address);
    if (extern) this.extern_zuletzt = new Date(jetzt).toISOString();
    this.emit('zuteilung', { wer: auth.wer, quelle: rinfo.address, extern });
  }

  /** Freien Relay-Port binden: Zufallsstart im Bereich, dann der Reihe nach; keiner frei → null. */
  async _relayBinden() {
    const anzahl = this.relayBis - this.relayVon + 1;
    const belegt = new Set([...this.zuteilungen.values()].map((z) => z.relayPort));
    const start = crypto.randomInt(anzahl);
    for (let i = 0; i < anzahl; i++) {
      const port = this.relayVon + ((start + i) % anzahl);
      if (belegt.has(port) || this.reserviert.has(port)) continue;
      this.reserviert.add(port);
      const s = dgram.createSocket('udp4');
      try {
        await new Promise((ok, nein) => { s.once('error', nein); s.bind(port, '0.0.0.0', () => { s.removeListener('error', nein); ok(); }); });
        s.on('error', () => { /* einzelne Sendefehler ignorieren */ });
        return { port, socket: s };
      } catch {
        try { s.close(); } catch { /* zu */ }
      } finally { this.reserviert.delete(port); }
    }
    return null;
  }

  _refresh(n, rinfo, z, auth) {
    const { angefragt, sekunden } = TurnDienst.lebensdauer(n);
    if (angefragt === 0) {
      this._schliessen(z);
      this.zuteilungen.delete(`${rinfo.address}:${rinfo.port}`);
      this._erfolg(n, rinfo, [[ATTR.lifetime, zahl32(0)]], auth.schluessel);
      return;
    }
    z.ablauf = this.jetzt() + sekunden * 1000;
    this._erfolg(n, rinfo, [[ATTR.lifetime, zahl32(sekunden)]], auth.schluessel);
  }
}
