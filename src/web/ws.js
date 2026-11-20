// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigenes WebSocket nach RFC 6455 ohne npm-Pakete (V6): Rahmen lesen/schreiben (vorher in konsole.js), ein
// JSON-WebSocket für Chat und Office (Fragmente zusammensetzen, Ping/Totmann, Rückstau-Grenze, Close-Codes) und ein
// Verteiler, der das „upgrade“-Ereignis des Servers je Pfad an den richtigen Behandler gibt.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_RAHMEN = 16 * 1024 * 1024;

export const annahmeSchluessel = (key) => crypto.createHash('sha1').update(String(key) + GUID).digest('base64');

/** Rahmen vom Server an den Browser (unmaskiert, immer FIN). */
export function rahmen(daten, opcode = 2) {
  const n = daten.length;
  let kopf;
  if (n < 126) kopf = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { kopf = Buffer.alloc(4); kopf[0] = 0x80 | opcode; kopf[1] = 126; kopf.writeUInt16BE(n, 2); }
  else { kopf = Buffer.alloc(10); kopf[0] = 0x80 | opcode; kopf[1] = 127; kopf.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([kopf, daten]);
}

/**
 * Liest Rahmen vom Browser (maskiert, Pflicht laut RFC) → {rahmen[], rest, noetig}; wirft bei unmaskiert, > max und bei
 * Kontrollrahmen über 125 Byte oder ohne FIN (RFC 6455 §5.5). `noetig` = Bytes ab `rest`, die der nächste Rahmen braucht.
 */
export function rahmenLesen(puffer, max = MAX_RAHMEN) {
  const aus = [];
  let i = 0; let noetig = 2;
  for (;;) {
    if (puffer.length - i < 2) { noetig = 2; break; }
    const b0 = puffer[i]; const b1 = puffer[i + 1];
    const maskiert = (b1 & 0x80) !== 0;
    if (!maskiert) throw new Error('unmaskierter Rahmen vom Browser');
    let laenge = b1 & 0x7f; let p = i + 2;
    if (laenge === 126) { if (puffer.length - p < 2) { noetig = 4; break; } laenge = puffer.readUInt16BE(p); p += 2; }
    else if (laenge === 127) { if (puffer.length - p < 8) { noetig = 10; break; } const l = puffer.readBigUInt64BE(p); if (l > BigInt(max)) throw new Error('Rahmen zu groß'); laenge = Number(l); p += 8; }
    if (laenge > max) throw new Error('Rahmen zu groß');
    if ((b0 & 0x08) && (laenge > 125 || !(b0 & 0x80))) throw new Error('Kontrollrahmen ungültig');
    if (puffer.length - p < 4 + laenge) { noetig = p - i + 4 + laenge; break; }
    const maske = puffer.subarray(p, p + 4); p += 4;
    const nutz = Buffer.alloc(laenge);
    for (let k = 0; k < laenge; k++) nutz[k] = puffer[p + k] ^ maske[k & 3];
    aus.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, daten: nutz });
    i = p + laenge;
  }
  return { rahmen: aus, rest: puffer.subarray(i), noetig };
}

/** Upgrade ablehnen: rohe HTTP-Antwort auf den Socket, dann zu. */
export function upgradeAblehnen(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* egal */ }
}

/** Gleiche Herkunft (Schutz vor Cross-Site-WebSocket-Übernahme): Origin-Host === Host. */
export function herkunftGleich(req) {
  try { return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

/** Verteiler für das „upgrade“-Ereignis: Pfad → Behandler; unbekannter Pfad → 404. */
export function upgradeVerteiler(routen) {
  return (req, socket, kopf) => {
    socket.on('error', () => {});
    let pfad;
    try { pfad = new URL(req.url, 'http://fahnas').pathname; } catch { upgradeAblehnen(socket, 400, 'Bad Request'); return; }
    const behandler = routen.get(pfad);
    if (!behandler) { upgradeAblehnen(socket, 404, 'Not Found'); return; }
    Promise.resolve().then(() => behandler(req, socket, kopf)).catch(() => upgradeAblehnen(socket, 500, 'Internal Server Error'));
  };
}

/**
 * Eine JSON-WebSocket-Verbindung. Ereignisse: 'nachricht' (Objekt mit `art`), 'zu' ({code, grund}, genau einmal).
 * Totmann: alle `ping_ms` ein Ping; zwei verpasste Pongs → zu (1006, 'totmann'). Zu großer Rückstand → 1013.
 */
export class WsVerbindung extends EventEmitter {
  constructor(socket, { max_nachricht = 1024 * 1024, max_rueckstand = 4 * 1024 * 1024, ping_ms = 25_000 } = {}) {
    super();
    this.socket = socket; this.max_nachricht = max_nachricht; this.max_rueckstand = max_rueckstand;
    // Eingang: ein wachsender Puffer (Kapazität verdoppelt sich) – Stücke werden einmal hineinkopiert, geparst wird erst,
    // wenn der nächste Rahmen vollständig sein kann (`_noetig`). Sonst kostete ein Rahmen in 1-Byte-Stücken quadratisch.
    this._puffer = Buffer.allocUnsafe(4096); this._fuell = 0; this._noetig = 2;
    this._teile = null; this._teilLaenge = 0; this._zu = false; this._verpasst = 0;
    socket.on('data', (d) => this._daten(d));
    socket.on('close', () => this._beendet(1006, 'getrennt'));
    socket.on('end', () => this._beendet(1006, 'getrennt'));
    socket.on('error', () => {});
    if (ping_ms > 0) { this._ping = setInterval(() => this._pingen(), ping_ms); this._ping.unref?.(); }
  }

  get offen() { return !this._zu && !this.socket.destroyed; }

  _pingen() {
    if (this._zu) return;
    if (this._verpasst >= 2) { this._beendet(1006, 'totmann'); this.socket.destroy(); return; }
    this._verpasst++;
    try { this.socket.write(rahmen(Buffer.alloc(0), 0x9)); } catch { /* egal */ }
  }

  _beendet(code, grund) {
    if (this._zu) return;
    this._zu = true;
    if (this._ping) clearInterval(this._ping);
    this.emit('zu', { code, grund });
  }

  _daten(d) {
    if (this._zu) return;
    const gesamt = this._fuell + d.length;
    if (gesamt > this._puffer.length) {
      const neu = Buffer.allocUnsafe(Math.max(gesamt, this._puffer.length * 2));
      this._puffer.copy(neu, 0, 0, this._fuell); this._puffer = neu;
    }
    d.copy(this._puffer, this._fuell); this._fuell = gesamt;
    if (this._fuell < this._noetig) return;
    let r;
    try { r = rahmenLesen(this._puffer.subarray(0, this._fuell), this.max_nachricht); } catch (e) { this.schliessen(/zu groß/.test(e.message) ? 1009 : 1002, 'rahmen'); return; }
    const rest = r.rest.length;
    if (rest && rest < this._fuell) this._puffer.copy(this._puffer, 0, this._fuell - rest, this._fuell);
    this._fuell = rest; this._noetig = r.noetig;
    if (this._puffer.length > 65536 && this._fuell <= 4096) { const klein = Buffer.allocUnsafe(4096); this._puffer.copy(klein, 0, 0, this._fuell); this._puffer = klein; }
    for (const f of r.rahmen) {
      if (this._zu) return;
      switch (f.opcode) {
        case 0x8: {
          const code = f.daten.length >= 2 ? f.daten.readUInt16BE(0) : 1000;
          this.schliessen(code >= 1000 && code < 5000 ? code : 1000);
          return;
        }
        case 0x9:
          // Pong nur, solange der Empfänger mitliest – sonst wüchse der Sendepuffer mit jedem Ping (Prüfbericht Plan 02, Befund 7)
          if (this.socket.writableLength > this.max_rueckstand) { this.schliessen(1013, 'rueckstand'); return; }
          try { this.socket.write(rahmen(f.daten, 0xa)); } catch { /* egal */ }
          break;
        case 0xa: this._verpasst = 0; break;
        case 0x1:
          if (this._teile) { this.schliessen(1002, 'fragment'); return; }
          if (f.fin) this._text(f.daten); else { this._teile = [f.daten]; this._teilLaenge = f.daten.length; }
          break;
        case 0x0:
          if (!this._teile) { this.schliessen(1002, 'fragment'); return; }
          this._teile.push(f.daten); this._teilLaenge += f.daten.length;
          if (this._teilLaenge > this.max_nachricht) { this.schliessen(1009, 'zu_gross'); return; }
          if (f.fin) { const ganz = Buffer.concat(this._teile); this._teile = null; this._teilLaenge = 0; this._text(ganz); }
          break;
        case 0x2: this.schliessen(1003, 'binaer'); return;
        default: this.schliessen(1002, 'opcode'); return;
      }
    }
  }

  _text(buf) {
    let obj;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      obj = JSON.parse(text);
    } catch { this.schliessen(1007, 'json'); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.art !== 'string') { this.schliessen(1007, 'art'); return; }
    this.emit('nachricht', obj);
  }

  /** JSON-Nachricht senden; false, wenn zu oder der Empfänger zu langsam ist (dann 1013). */
  senden(obj) {
    if (!this.offen) return false;
    if (this.socket.writableLength > this.max_rueckstand) { this.schliessen(1013, 'rueckstand'); return false; }
    try { this.socket.write(rahmen(Buffer.from(JSON.stringify(obj)), 0x1)); } catch { return false; }
    return true;
  }

  /** Close-Rahmen mit Code und Grund (≤ 123 Byte), danach zu; nach 1 s hart. */
  schliessen(code = 1000, grund = '') {
    if (this._zu) return;
    const g = Buffer.from(String(grund || '')).subarray(0, 123);
    const nutz = Buffer.alloc(2 + g.length); nutz.writeUInt16BE(code, 0); g.copy(nutz, 2);
    try { this.socket.end(rahmen(nutz, 0x8)); } catch { /* egal */ }
    setTimeout(() => { try { this.socket.destroy(); } catch { /* egal */ } }, 1000).unref?.();
    this._beendet(code, grund);
  }
}

/** Handschlag (101) und Verbindung; ohne Upgrade-Kopf oder Schlüssel → 400 und null. */
export function wsAnnehmen(req, socket, kopf, optionen = {}) {
  socket.on('error', () => {});
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) { upgradeAblehnen(socket, 400, 'Bad Request'); return null; }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${annahmeSchluessel(req.headers['sec-websocket-key'])}`, '', ''].join('\r\n'));
  socket.setNoDelay?.(true);
  const v = new WsVerbindung(socket, optionen);
  if (kopf && kopf.length) { const k = Buffer.from(kopf); queueMicrotask(() => v._daten(k)); } // erst nachdem der Aufrufer zuhört
  return v;
}
