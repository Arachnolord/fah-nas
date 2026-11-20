// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Delta-Kern (Plan 05 Aufgabe 1): anwenden, zusammensetzen, transformieren, invertieren und Positionen nach
// Quill-Semantik, Embeds über ein Register. Die Gesetze (Konvergenz, Zusammensetzen, Umkehren) prüfen 200 Zufalls-Seeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { registriereEmbed, opLaenge, laenge, basisLaenge, normalisieren, teil, gleich, anwenden, zusammensetzen, transformiere, invertieren, positionTransformieren } =
  await import(pathToFileURL(path.join(SYNC, 'delta.js')).href);
const { SyncFehler } = await import(pathToFileURL(path.join(SYNC, 'fehler.js')).href);

const ZAEHLER = { anwenden: (w, o) => w + o, transformiere: (a) => a, zusammensetzen: (a, b) => a + b, invertieren: (o) => -o };
registriereEmbed('zaehler', ZAEHLER);

test('anwenden: einfügen, löschen, formatieren, Attribut entfernen', () => {
  const dok = [{ insert: 'Hallo Welt\n' }];
  assert.deepEqual(anwenden(dok, [{ retain: 6 }, { delete: 4 }, { insert: 'NAS' }]), [{ insert: 'Hallo NAS\n' }]);
  assert.deepEqual(anwenden(dok, [{ retain: 5, attributes: { fett: true } }]), [{ insert: 'Hallo', attributes: { fett: true } }, { insert: ' Welt\n' }]);
  assert.deepEqual(anwenden([{ insert: 'ab', attributes: { fett: true } }, { insert: '\n' }], [{ retain: 1, attributes: { fett: null } }]),
    [{ insert: 'a' }, { insert: 'b', attributes: { fett: true } }, { insert: '\n' }]);
  assert.deepEqual(dok, [{ insert: 'Hallo Welt\n' }], 'Eingabe bleibt unverändert');
});

test('anwenden: zu lange Op → SyncFehler E_PARAMS', () => {
  assert.throws(() => anwenden([{ insert: 'ab\n' }], [{ retain: 4 }, { insert: 'x' }]), (e) => e instanceof SyncFehler && e.code === 'E_PARAMS');
  assert.throws(() => anwenden([{ insert: 'ab\n' }], [{ delete: 4 }]), (e) => e instanceof SyncFehler && e.code === 'E_PARAMS');
});

test('transformiere: Gleichstand beim Einfügen – links vorn, rechts dahinter', () => {
  assert.deepEqual(transformiere([{ insert: 'A' }], [{ insert: 'B' }], 'links'), [{ insert: 'A' }]);
  assert.deepEqual(transformiere([{ insert: 'A' }], [{ insert: 'B' }], 'rechts'), [{ retain: 1 }, { insert: 'A' }]);
});

test('transformiere: Attribute – die später ankommende Op gewinnt', () => {
  const a = [{ retain: 3, attributes: { fett: true, farbe: 'rot' } }]; const b = [{ retain: 2, attributes: { fett: null } }];
  assert.deepEqual(transformiere(a, b, 'links'), [{ retain: 2, attributes: { farbe: 'rot' } }, { retain: 1, attributes: { fett: true, farbe: 'rot' } }]);
  assert.deepEqual(transformiere(a, b, 'rechts'), a);
});

test('transformiere: Löschen gegen Einfügen und Löschen', () => {
  assert.deepEqual(transformiere([{ retain: 1 }, { delete: 3 }], [{ retain: 2 }, { insert: 'X' }], 'rechts'), [{ retain: 1 }, { delete: 1 }, { retain: 1 }, { delete: 2 }]);
  assert.deepEqual(transformiere([{ delete: 2 }], [{ delete: 3 }], 'links'), []);
});

test('zusammensetzen und invertieren', () => {
  assert.deepEqual(zusammensetzen([{ insert: 'A' }], [{ retain: 1 }, { insert: 'B' }]), [{ insert: 'AB' }]);
  assert.deepEqual(zusammensetzen([{ retain: 2, attributes: { fett: true } }], [{ retain: 2, attributes: { fett: null } }]), [{ retain: 2, attributes: { fett: null } }]);
  const basis = [{ insert: 'Hallo', attributes: { fett: true } }, { insert: '\n' }];
  const aend = [{ retain: 2, attributes: { fett: null, farbe: 'rot' } }, { delete: 2 }, { insert: 'X' }];
  assert.deepEqual(invertieren(aend, basis), [{ retain: 2, attributes: { fett: true, farbe: null } }, { insert: 'll', attributes: { fett: true } }, { delete: 1 }]);
  assert.deepEqual(anwenden(anwenden(basis, aend), invertieren(aend, basis)), basis);
});

test('Embeds über das Register', () => {
  registriereEmbed('zaehler', ZAEHLER);
  const dok = [{ insert: { zaehler: 1 } }, { insert: '\n' }];
  assert.deepEqual(anwenden(dok, [{ retain: { zaehler: 2 } }]), [{ insert: { zaehler: 3 } }, { insert: '\n' }]);
  assert.deepEqual(zusammensetzen([{ retain: { zaehler: 2 } }], [{ retain: { zaehler: 5 } }]), [{ retain: { zaehler: 7 } }]);
  assert.deepEqual(transformiere([{ retain: { zaehler: 2 } }], [{ delete: 1 }], 'rechts'), []);
  assert.deepEqual(invertieren([{ retain: { zaehler: 2 } }], dok), [{ retain: { zaehler: -2 } }]);
  assert.throws(() => anwenden([{ insert: 'a\n' }], [{ retain: { zaehler: 1 } }]), (e) => e.code === 'E_PARAMS'); // Embed-Op auf Text
  assert.throws(() => anwenden(dok, [{ retain: { unbekannt: 1 } }]), (e) => e.code === 'E_PARAMS');
});

test('positionTransformieren: eigen schiebt mit, fremd bleibt davor', () => {
  assert.equal(positionTransformieren(2, [{ retain: 2 }, { insert: 'xy' }], true), 4);
  assert.equal(positionTransformieren(2, [{ retain: 2 }, { insert: 'xy' }], false), 2);
  assert.equal(positionTransformieren(5, [{ delete: 3 }], false), 2);
});

test('Hilfen: Längen, normalisieren, teil, gleich', () => {
  assert.equal(opLaenge({ insert: 'abc' }), 3); assert.equal(opLaenge({ insert: { zaehler: 1 } }), 1);
  assert.equal(opLaenge({ retain: { zaehler: 1 } }), 1); assert.equal(opLaenge({ retain: 4 }), 4); assert.equal(opLaenge({ delete: 2 }), 2);
  assert.equal(laenge([{ insert: 'ab' }, { insert: { zaehler: 1 } }, { insert: '\n' }]), 4);
  assert.equal(basisLaenge([{ retain: 2 }, { insert: 'xyz' }, { delete: 3 }, { retain: { zaehler: 1 } }]), 6);
  assert.deepEqual(normalisieren([{ delete: 1 }, { insert: 'a' }, { insert: 'b', attributes: { fett: null } }, { retain: 0 }, { insert: '' }, { delete: 2 }, { retain: 3 }]),
    [{ insert: 'ab' }, { delete: 3 }]);
  assert.deepEqual(normalisieren([{ retain: 2, attributes: {} }, { retain: 1 }, { retain: 1, attributes: { fett: null } }]), [{ retain: 3 }, { retain: 1, attributes: { fett: null } }]);
  assert.deepEqual(teil([{ insert: 'Hallo', attributes: { fett: true } }, { insert: { zaehler: 2 } }, { insert: 'Welt\n' }], 3, 7),
    [{ insert: 'lo', attributes: { fett: true } }, { insert: { zaehler: 2 } }, { insert: 'W' }]);
  assert.equal(gleich({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(gleich({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(gleich(undefined, undefined), true);
});

// ---- Gesetze mit Zufall ---------------------------------------------------------------------------------------------

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wahl = (rng, liste) => liste[Math.floor(rng() * liste.length)];
function zufallsAttribute(rng, mitNull) {
  const a = {};
  if (rng() < 0.3) a.fett = mitNull && rng() < 0.4 ? null : true;
  if (rng() < 0.3) a.farbe = wahl(rng, mitNull ? ['rot', 'blau', null] : ['rot', 'blau']);
  return Object.keys(a).length ? a : undefined;
}
const mit = (op, attributes) => (attributes ? { ...op, attributes } : op);

/** Dokument 0–30 Zeichen aus 'ab\n' und Zähler-Embeds, endet mit '\n'. */
function zufallsDok(rng) {
  const ops = [];
  const n = Math.floor(rng() * 31);
  for (let i = 0; i < n; i++) {
    const a = zufallsAttribute(rng, false);
    ops.push(rng() < 0.1 ? mit({ insert: { zaehler: Math.floor(rng() * 5) } }, a) : mit({ insert: wahl(rng, ['a', 'b', '\n']) }, a));
  }
  ops.push({ insert: '\n' });
  return normalisieren(ops);
}

/** Je Zeichen bzw. Embed ein Element (für Embed-retain an der richtigen Stelle). */
function elemente(dok) {
  const aus = [];
  for (const op of dok) {
    if (typeof op.insert === 'string') for (let i = 0; i < op.insert.length; i++) aus.push({ embed: false });
    else aus.push({ embed: true });
  }
  return aus;
}

/** Zufällige Änderung gegen `dok` (das abschließende '\n' bleibt stehen). */
function zufallsAenderung(rng, dok) {
  const el = elemente(dok);
  const ende = el.length - 1;
  const ops = [];
  let i = 0;
  while (i < ende && ops.length < 40) {
    const r = rng();
    if (r < 0.15) { ops.push(rng() < 0.15 ? { insert: { zaehler: 1 + Math.floor(rng() * 3) } } : mit({ insert: wahl(rng, ['x', 'y', 'xy', '\n']) }, zufallsAttribute(rng, false))); continue; }
    if (r < 0.3) { const n = 1 + Math.floor(rng() * Math.min(3, ende - i)); ops.push({ delete: n }); i += n; continue; }
    if (el[i].embed && rng() < 0.5) { ops.push(mit({ retain: { zaehler: 1 + Math.floor(rng() * 3) } }, zufallsAttribute(rng, true))); i += 1; continue; }
    const n = 1 + Math.floor(rng() * Math.min(4, ende - i));
    ops.push(mit({ retain: n }, zufallsAttribute(rng, true))); i += n;
  }
  if (rng() < 0.3) ops.push({ insert: 'z' });
  return ops;
}

function zufall(seed) {
  const rng = mulberry32(seed);
  const dok = zufallsDok(rng);
  return { rng, dok, a: zufallsAenderung(rng, dok), b: zufallsAenderung(rng, dok) };
}

for (let seed = 1; seed <= 200; seed++) {
  test(`Gesetze seed ${seed}`, () => {
    const { rng, dok, a, b } = zufall(seed);
    assert.deepEqual(anwenden(anwenden(dok, a), transformiere(b, a, 'rechts')), anwenden(anwenden(dok, b), transformiere(a, b, 'links')));
    const c = zufallsAenderung(rng, anwenden(dok, a)); // Änderung gegen den Stand nach a
    assert.deepEqual(anwenden(anwenden(dok, a), c), anwenden(dok, zusammensetzen(a, c)));
    assert.deepEqual(anwenden(anwenden(dok, a), invertieren(a, dok)), dok);
  });
}

test('Prüfbericht I-5: lange Op gegen langen Verlauf bleibt schnell (Server-Stand)', () => {
  const lang = [];
  for (let i = 0; i < 30_000; i++) lang.push({ insert: 'a', attributes: { fett: true } }, { insert: 'b' }); // 60 000 Teil-Ops
  const verlauf = Array.from({ length: 500 }, (_, i) => (i ? [{ retain: i }, { insert: 'x' }] : [{ insert: 'x' }]));
  const t0 = performance.now();
  let o = lang;
  for (const v of verlauf) o = transformiere(o, v, 'rechts');
  let dok = [{ insert: '\n' }];
  for (const v of verlauf) dok = anwenden(dok, v);
  dok = anwenden(dok, o);
  const dauer = performance.now() - t0;
  assert.ok(dauer < 3000, `${Math.round(dauer)} ms`);
  const text = dok.map((op) => op.insert).join('');
  assert.equal(text.length, 60_000 + 500 + 1);
  assert.equal(text.slice(0, 500), 'x'.repeat(500), 'die frühere Einfügung steht vorn');
  assert.equal(laenge(zusammensetzen(lang, [{ retain: 3 }, { delete: 1 }])), 59_999);
});
