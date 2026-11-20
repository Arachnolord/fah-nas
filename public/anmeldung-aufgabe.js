// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Web-Worker der Bot-Bremse (Anmeldung aus dem Internet, src/web/anmeldeschutz.js): sucht die kleinste Zahl n, für die
// SHA-256("<aufgabe>:<n>") mit `bits` Null-Bits beginnt. Eigenes SHA-256 für genau einen 64-Byte-Block (Aufgabe + Zahl
// sind höchstens 55 Byte) – um ein Vielfaches schneller als crypto.subtle je Versuch. Läuft im Hintergrund, die Seite
// bleibt bedienbar.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);
const block = new Uint8Array(64);

/** Erstes 32-Bit-Wort von SHA-256 über block[0..laenge) (laenge ≤ 55, Rest wird hier aufgefüllt). */
function erstesWort(laenge) {
  block[laenge] = 0x80;
  block.fill(0, laenge + 1, 56);
  const bits = laenge * 8;
  block[56] = 0; block[57] = 0; block[58] = 0; block[59] = 0;
  block[60] = (bits >>> 24) & 255; block[61] = (bits >>> 16) & 255; block[62] = (bits >>> 8) & 255; block[63] = bits & 255;
  for (let i = 0; i < 16; i++) W[i] = (block[4 * i] << 24) | (block[4 * i + 1] << 16) | (block[4 * i + 2] << 8) | block[4 * i + 3];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15]; const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = 0x6a09e667; let b = 0xbb67ae85; let c = 0x3c6ef372; let d = 0xa54ff53a;
  let e = 0x510e527f; let f = 0x9b05688c; let g = 0x1f83d9ab; let h = 0x5be0cd19;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  return (0x6a09e667 + a) >>> 0;
}

/** Lösung suchen. Gibt die Zahl als Text zurück. */
export function loesen(aufgabe, bits) {
  const praefix = new TextEncoder().encode(`${aufgabe}:`);
  if (praefix.length + 12 > 55) throw new Error('Aufgabe zu lang');
  block.set(praefix, 0);
  const maske = bits >= 32 ? 0xffffffff : (~(0xffffffff >>> bits)) >>> 0;
  for (let n = 0; n < 1e12; n++) {
    const z = String(n);
    let l = praefix.length;
    for (let i = 0; i < z.length; i++) block[l++] = z.charCodeAt(i);
    if (((erstesWort(l) & maske) >>> 0) === 0) return z;
  }
  throw new Error('keine Lösung');
}

// Als Worker: {aufgabe, bits} → {loesung} bzw. {fehler}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev) => {
    try { self.postMessage({ loesung: loesen(String(ev.data.aufgabe), Number(ev.data.bits)) }); } catch (e) { self.postMessage({ fehler: String(e && e.message) }); }
  };
}
