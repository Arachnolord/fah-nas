// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// WebSocket-Testklient (RFC 6455) ohne npm-Pakete: eigene Köpfe (Cookie, Origin), rohe Rahmen, Fragmente,
// Antwort auf Ping abschaltbar (Totmann-Tests). Für Chat- und Office-Tests gemeinsam.

import http from 'node:http';
import crypto from 'node:crypto';

/** Maskierter Rahmen vom Klienten. */
export function maskiert(daten, opcode = 1, fin = true) {
  const n = daten.length; const maske = crypto.randomBytes(4);
  let kopf;
  if (n < 126) kopf = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]);
  else if (n < 65536) { kopf = Buffer.alloc(4); kopf[0] = (fin ? 0x80 : 0) | opcode; kopf[1] = 0x80 | 126; kopf.writeUInt16BE(n, 2); }
  else { kopf = Buffer.alloc(10); kopf[0] = (fin ? 0x80 : 0) | opcode; kopf[1] = 0x80 | 127; kopf.writeBigUInt64BE(BigInt(n), 2); }
  const nutz = Buffer.alloc(n);
  for (let i = 0; i < n; i++) nutz[i] = daten[i] ^ maske[i & 3];
  return Buffer.concat([kopf, maske, nutz]);
}

/** Unmaskierte Rahmen vom Server lesen → {rahmen:[{fin, opcode, daten}], rest}. */
export function serverRahmenLesen(puffer) {
  const rahmen = []; let i = 0;
  for (;;) {
    if (puffer.length - i < 2) break;
    const b0 = puffer[i]; const b1 = puffer[i + 1];
    let laenge = b1 & 0x7f; let p = i + 2;
    if (laenge === 126) { if (puffer.length - p < 2) break; laenge = puffer.readUInt16BE(p); p += 2; }
    else if (laenge === 127) { if (puffer.length - p < 8) break; laenge = Number(puffer.readBigUInt64BE(p)); p += 8; }
    if (puffer.length - p < laenge) break;
    rahmen.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, daten: Buffer.from(puffer.subarray(p, p + laenge)) });
    i = p + laenge;
  }
  return { rahmen, rest: puffer.subarray(i) };
}

/**
 * Verbindet sich mit ws://127.0.0.1:<port><pfad>. Ergebnis {status, kopf, senden(obj), sendeRoh(buf),
 * naechste(pruef, ms) → nächste passende JSON-Nachricht, alle, zu: Promise<{code}>, schliessen(), socket}.
 * Bei Ablehnung (kein 101) nur {status, kopf}.
 */
export function wsVerbinden(port, pfad, { cookie = '', origin, pong = true } = {}) {
  return new Promise((ok, nein) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: pfad,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Host: `127.0.0.1:${port}`, ...(origin === null ? {} : { Origin: origin ?? `http://127.0.0.1:${port}` }), ...(cookie ? { Cookie: cookie } : {}) },
    });
    req.on('response', (res) => { res.resume(); ok({ status: res.statusCode, kopf: res.headers }); });
    req.on('error', nein);
    req.on('upgrade', (res, socket, kopf) => {
      const alle = []; const wartende = [];
      let puffer = Buffer.from(kopf || Buffer.alloc(0));
      let zuLoesen; const zu = new Promise((r) => { zuLoesen = r; });
      let geschlossen = false;
      const beenden = (code) => { if (geschlossen) return; geschlossen = true; zuLoesen({ code }); for (const w of wartende.splice(0)) w.nein(new Error(`Verbindung zu (${code})`)); };
      const zustellen = (obj) => {
        alle.push(obj);
        const i = wartende.findIndex((w) => w.pruef(obj));
        if (i >= 0) { const [w] = wartende.splice(i, 1); w.gelesen.add(obj); w.ok(obj); }
      };
      const lesen = (d) => {
        puffer = Buffer.concat([puffer, d]);
        const r = serverRahmenLesen(puffer); puffer = Buffer.from(r.rest);
        for (const f of r.rahmen) {
          if (f.opcode === 1) { try { zustellen(JSON.parse(f.daten.toString('utf8'))); } catch { /* kein JSON */ } }
          else if (f.opcode === 8) beenden(f.daten.length >= 2 ? f.daten.readUInt16BE(0) : 1005);
          else if (f.opcode === 9 && pong) socket.write(maskiert(f.daten, 0xa));
        }
      };
      socket.on('data', lesen);
      socket.on('close', () => beenden(1006));
      socket.on('error', () => {});
      if (puffer.length) { const d = puffer; puffer = Buffer.alloc(0); lesen(d); }
      const verbraucht = new Set();
      ok({
        status: res.statusCode, kopf: res.headers, alle, zu, socket,
        senden: (obj) => socket.write(maskiert(Buffer.from(JSON.stringify(obj)))),
        sendeRoh: (buf) => socket.write(buf),
        naechste(pruef = () => true, ms = 2000) {
          const vorhanden = alle.find((o) => !verbraucht.has(o) && pruef(o));
          if (vorhanden) { verbraucht.add(vorhanden); return Promise.resolve(vorhanden); }
          return new Promise((r, n) => {
            const t = setTimeout(() => { const i = wartende.indexOf(w); if (i >= 0) wartende.splice(i, 1); n(new Error('keine passende Nachricht')); }, ms);
            const w = { pruef, gelesen: verbraucht, ok: (o) => { clearTimeout(t); r(o); }, nein: (e) => { clearTimeout(t); n(e); } };
            wartende.push(w);
          });
        },
        schliessen() { try { socket.end(maskiert(Buffer.from([0x03, 0xe8]), 8)); } catch { /* egal */ } },
      });
    });
    req.end();
  });
}
