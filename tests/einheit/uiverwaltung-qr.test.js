// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests des QR-Encoders (public/ansichten/nutzer.qr.js): Norm-Tabellen, Format-/Versionsbits, feste Module, und ein
// UNABHÄNGIGER Rückwärts-Leser: Funktionsmodule selbst bestimmen, Maske entfernen, Zickzack lesen, entschachteln,
// Reed-Solomon-Syndrome prüfen, Bitstrom zurück in Text wandeln. Das Raster wird als Text sichtbar gemacht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const QR = pathToFileURL(path.join(HIER, '..', '..', 'public', 'ansichten', 'nutzer.qr.js')).href;

// --- eigener, unabhängiger GF(256)-Kern für die Syndromprüfung -------------------------------------------------
const EXP2 = []; const LOG2 = [];
(function () { let x = 1; for (let i = 0; i < 255; i++) { EXP2[i] = x; LOG2[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } })();
const mul2 = (a, b) => (a === 0 || b === 0 ? 0 : EXP2[(LOG2[a] + LOG2[b]) % 255]);
function syndrom(codewoerter, i) { let r = 0; const a = EXP2[i]; for (const c of codewoerter) r = mul2(r, a) ^ c; return r; }

// Norm-Tabellen (unabhängig hier noch einmal notiert)
const AUSRICHTUNG = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const BLOECKE = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };

/** Ist (x,y) ein Funktionsmodul? (eigene Herleitung aus der Norm) */
function istFunktion(x, y, version) {
  const g = version * 4 + 17;
  if ((x <= 8 && y <= 8) || (x >= g - 8 && y <= 8) || (x <= 8 && y >= g - 8)) return true; // Sucher + Trenner + Formatbereich + dunkles Modul
  if (x === 6 || y === 6) return true; // Taktmuster
  if (version >= 7 && ((x >= g - 11 && x <= g - 9 && y <= 5) || (y >= g - 11 && y <= g - 9 && x <= 5))) return true; // Versionsinfo
  for (const cy of AUSRICHTUNG[version]) for (const cx of AUSRICHTUNG[version]) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === g - 7) || (cx === g - 7 && cy === 6)) continue;
    if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
  }
  return false;
}

const MASKE = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Liest die 15 Formatbits (Kopie 1) und prüft die BCH-Eigenschaft; gibt {maske, stufe} zurück */
function formatLesen(m, g) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits[i] = m[i][8];
  bits[6] = m[7][8]; bits[7] = m[8][8]; bits[8] = m[8][7];
  for (let i = 9; i < 15; i++) bits[i] = m[8][14 - i];
  let wert = 0; for (let i = 0; i < 15; i++) wert |= bits[i] << i;
  // zweite Kopie muss identisch sein
  const bits2 = [];
  for (let i = 0; i < 8; i++) bits2[i] = m[8][g - 1 - i];
  for (let i = 8; i < 15; i++) bits2[i] = m[g - 15 + i][8];
  let wert2 = 0; for (let i = 0; i < 15; i++) wert2 |= bits2[i] << i;
  assert.equal(wert2, wert, 'zweite Formatkopie weicht ab');
  // BCH(15,5): (wert ^ 0x5412) muss ohne Rest durch 0x537 teilbar sein
  let rest = wert ^ 0x5412;
  for (let i = 14; i >= 10; i--) if (rest & (1 << i)) rest ^= 0x537 << (i - 10);
  assert.equal(rest, 0, 'Formatbits bestehen die BCH-Prüfung nicht');
  const daten = (wert ^ 0x5412) >> 10;
  return { maske: daten & 7, stufe: ['M', 'L', 'H', 'Q'][daten >> 3], wert };
}

/** Rückwärts: Matrix → Text (wirft bei jedem Verstoß) */
function dekodieren(qr) {
  const g = qr.groesse; const v = qr.version; const m = qr.module;
  const f = formatLesen(m, g);
  assert.equal(f.stufe, 'M'); assert.equal(f.maske, qr.maske); assert.equal(f.wert, qr.format);
  // Maske entfernen
  const klar = m.map((z, y) => Array.from(z, (b, x) => (istFunktion(x, y, v) ? b : b ^ (MASKE[f.maske](x, y) ? 1 : 0))));
  // Zickzack lesen
  const bits = [];
  for (let rechts = g - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts = 5;
    for (let s = 0; s < g; s++) for (let j = 0; j < 2; j++) {
      const x = rechts - j; const y = ((rechts + 1) & 2) === 0 ? g - 1 - s : s;
      if (!istFunktion(x, y, v)) bits.push(klar[y][x]);
    }
  }
  const [ec, gruppen] = BLOECKE[v];
  const anzahlBloecke = gruppen.reduce((s, [n]) => s + n, 0);
  const datenGesamt = gruppen.reduce((s, [n, l]) => s + n * l, 0);
  const gesamt = datenGesamt + ec * anzahlBloecke;
  assert.ok(bits.length >= gesamt * 8, `zu wenige Datenmodule: ${bits.length} < ${gesamt * 8}`);
  const rest = bits.length - gesamt * 8;
  assert.equal(rest, [0, 7, 7, 7, 7, 7, 0, 0, 0, 0][v - 1], 'Restbits passen nicht zur Version');
  const woerter = [];
  for (let i = 0; i < gesamt; i++) woerter.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
  // entschachteln
  const laengen = []; for (const [n, l] of gruppen) for (let i = 0; i < n; i++) laengen.push(l);
  const bloecke = laengen.map(() => ({ daten: [], ec: [] }));
  let pos = 0;
  const maxL = Math.max(...laengen);
  for (let i = 0; i < maxL; i++) for (let b = 0; b < bloecke.length; b++) if (i < laengen[b]) bloecke[b].daten.push(woerter[pos++]);
  for (let i = 0; i < ec; i++) for (let b = 0; b < bloecke.length; b++) bloecke[b].ec.push(woerter[pos++]);
  assert.equal(pos, gesamt);
  // Reed-Solomon: alle Syndrome müssen 0 sein
  for (const [i, b] of bloecke.entries()) for (let s = 0; s < ec; s++) assert.equal(syndrom([...b.daten, ...b.ec], s), 0, `Block ${i}: Syndrom ${s} ≠ 0`);
  // Bitstrom auswerten
  const datenbits = [];
  for (const b of bloecke) for (const w of b.daten) for (let i = 7; i >= 0; i--) datenbits.push((w >> i) & 1);
  let p = 0; const lies = (n) => { let w = 0; for (let i = 0; i < n; i++) w = (w << 1) | datenbits[p++]; return w; };
  assert.equal(lies(4), 0b0100, 'Modus ist nicht Byte');
  const laenge = lies(v <= 9 ? 8 : 16);
  const bytes = new Uint8Array(laenge); for (let i = 0; i < laenge; i++) bytes[i] = lies(8);
  // Abschluss + Füllbytes prüfen
  const restBits = datenbits.length - p;
  if (restBits >= 4) assert.equal(lies(4), 0, 'Abschluss 0000 fehlt');
  while (datenbits.length - p >= 8 && (datenbits.length - p) % 8 !== 0) lies(1);
  let fuell = 0;
  while (datenbits.length - p >= 8) { const w = lies(8); assert.equal(w, fuell % 2 === 0 ? 0xec : 0x11, 'Füllbyte falsch'); fuell++; }
  return new TextDecoder().decode(bytes);
}

test('Norm-Tabellen: Gesamt-Codewörter, Byte-Kapazität, Format- und Versionsbits', async () => {
  const q = await import(QR);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(q.gesamtCodewoerter), [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(q.kapazitaetBytes), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  assert.equal(q.formatBits('M', 0), 0b101010000010010);
  assert.equal(q.formatBits('L', 0), 0b111011111000100);
  assert.equal(q.formatBits('M', 5), 0b100000011001110);
  assert.equal(q.versionBits(7), 0x07c94); assert.equal(q.versionBits(8), 0x085bc); assert.equal(q.versionBits(9), 0x09a99); assert.equal(q.versionBits(10), 0x0a4d3);
  assert.equal(q.versionWaehlen(14), 1); assert.equal(q.versionWaehlen(15), 2); assert.equal(q.versionWaehlen(213), 10);
  assert.throws(() => q.versionWaehlen(214), /zu lang/);
  // Generatorpolynom für 7 EC-Codewörter (Norm-Beispiel): x^7 + α^87 x^6 + α^229 x^5 + α^146 x^4 + α^149 x^3 + α^238 x^2 + α^102 x + α^21
  const g7 = q.generatorpolynom(7);
  assert.deepEqual(g7, [1, 87, 229, 146, 149, 238, 102, 21].map((e, i) => (i === 0 ? 1 : EXP2[e])));
});

test('QR „Hallo“: Version 1, 21×21, feste Module (Sucher, Takt, dunkles Modul), Raster sichtbar, Rückwärts-Leser liefert den Text', async (tk) => {
  const q = await import(QR);
  const qr = q.qrErzeugen('Hallo');
  assert.equal(qr.version, 1); assert.equal(qr.groesse, 21);
  assert.equal(qr.module.length, 21); for (const z of qr.module) assert.equal(z.length, 21);
  const m = qr.module;
  // Sucher oben links: Zeile 0 dunkel, Zeile 1 nur Rand dunkel, Zeile 7 (Trenner) hell
  assert.deepEqual(Array.from(m[0].slice(0, 8)), [1, 1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(Array.from(m[1].slice(0, 8)), [1, 0, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(m[3].slice(0, 8)), [1, 0, 1, 1, 1, 0, 1, 0]);
  assert.deepEqual(Array.from(m[7].slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  // Sucher oben rechts und unten links
  assert.deepEqual(Array.from(m[0].slice(13, 21)), [0, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(m[20].slice(0, 8)), [1, 1, 1, 1, 1, 1, 1, 0]);
  // Taktmuster Zeile 6 / Spalte 6, Spalten 8..12 abwechselnd beginnend dunkel
  assert.deepEqual(Array.from(m[6].slice(8, 13)), [1, 0, 1, 0, 1]);
  assert.deepEqual([8, 9, 10, 11, 12].map((y) => m[y][6]), [1, 0, 1, 0, 1]);
  // dunkles Modul bei (Zeile 4·V+9 = 13, Spalte 8)
  assert.equal(m[13][8], 1);
  const raster = q.qrAlsText(qr);
  tk.diagnostic(`QR „Hallo“ (Version ${qr.version}, Maske ${qr.maske}, Format ${qr.format.toString(2).padStart(15, '0')}):\n${raster}`);
  assert.equal(raster.split('\n').length, 21);
  assert.equal(dekodieren(qr), 'Hallo');
});

test('QR otpauth-URI (Version 7 mit Versionsinfo und Ausrichtungsmustern): alle Masken dekodieren korrekt', async (tk) => {
  const q = await import(QR);
  const uri = 'otpauth://totp/FAH-NAS:fabian?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=FAH-NAS&algorithm=SHA1&digits=6&period=30';
  const qr = q.qrErzeugen(uri);
  assert.equal(qr.version, 7); assert.equal(qr.groesse, 45);
  // Versionsinfo 7 = 0x07C94: Bit i liegt bei (x = g-11 + i%3, y = i/3)
  for (let i = 0; i < 18; i++) assert.equal(qr.module[Math.floor(i / 3)][45 - 11 + (i % 3)], (0x07c94 >> i) & 1, `Versionsbit ${i}`);
  // Ausrichtungsmuster bei (22,22): Mitte dunkel, Ring hell, Rand dunkel
  assert.equal(qr.module[22][22], 1); assert.equal(qr.module[21][22], 0); assert.equal(qr.module[20][22], 1);
  tk.diagnostic(`QR otpauth (Version ${qr.version}, ${qr.groesse}×${qr.groesse}, Maske ${qr.maske}):\n${q.qrAlsText(qr, '#', '.')}`);
  assert.equal(dekodieren(qr), uri);
  for (let maske = 0; maske < 8; maske++) {
    const x = q.qrErzeugen(uri, { maske });
    assert.equal(x.maske, maske);
    assert.equal(dekodieren(x), uri, `Maske ${maske}`);
  }
});

test('QR Version 10 (16-Bit-Zähler, ungleich lange Blöcke) und UTF-8-Umlaute', async () => {
  const q = await import(QR);
  const lang = 'Ä'.repeat(10) + 'x'.repeat(190); // 10·2 + 190 = 210 Byte → Version 10
  const qr = q.qrErzeugen(lang);
  assert.equal(qr.version, 10); assert.equal(qr.groesse, 57);
  assert.equal(dekodieren(qr), lang);
  const mittel = q.qrErzeugen('Grüße aus Musterstadt – FAH-NAS 2026 ✓');
  assert.ok(mittel.version >= 2 && mittel.version <= 4);
  assert.equal(dekodieren(mittel), 'Grüße aus Musterstadt – FAH-NAS 2026 ✓');
});

test('Strafpunkte: Maskenwahl nimmt die günstigste Maske', async () => {
  const q = await import(QR);
  const text = 'FAH-NAS';
  const frei = q.qrErzeugen(text);
  for (let m = 0; m < 8; m++) {
    const x = q.qrErzeugen(text, { maske: m });
    assert.ok(q.strafpunkte(frei.module, frei.groesse) <= q.strafpunkte(x.module, x.groesse), `Maske ${m} wäre günstiger`);
  }
});
