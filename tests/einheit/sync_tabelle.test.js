// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dokument-Attribute und Tabellen-Embed (Plan 05 Aufgabe 2): Zellen „letzte gewinnt“, Zeilen/Spalten mit Grabsteinen,
// Umkehren für Rückgängig, Prüfung von Werten und Ops, Links und Farben. 100 Zufalls-Seeds prüfen TP1 der Tabellen-Ops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const TYPEN = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'typen');
const { tabelle, TABELLEN_OPS, tabelleWertPruefen, tabellenOpsPruefen, sichtbareZeilen, sichtbareSpalten, zellKey } = await import(pathToFileURL(path.join(TYPEN, 'dokument-tabelle.js')).href);
const { FARBEN, HINTERGRUENDE, ID_MUSTER, DATEI_MUSTER, INLINE_ATTRIBUTE, ZEILEN_ATTRIBUTE, linkErlaubt, attributePruefen, neueId, farbeNormal } =
  await import(pathToFileURL(path.join(TYPEN, 'dokument-attribute.js')).href);
const KONST = await import(pathToFileURL(path.join(TYPEN, '..', 'konstanten.js')).href);

const W0 = Object.freeze({ id: 'tab001', zeilen: ['z00001', 'z00002'], spalten: ['s00001', 's00002'], weg: [], zellen: { 'z00001|s00001': [{ insert: 'a' }] }, breiten: {} });
const A = (w, l) => tabelle.anwenden(w, l);
const T = (a, b, s) => tabelle.transformiere(a, b, s);
function tp1(w, a, b) {
  assert.deepEqual(A(A(w, a), T(b, a, 'rechts')), A(A(w, b), T(a, b, 'links')), `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
}

test('Zelle: letzte Änderung gewinnt; eine Zelle in einer gleichzeitig gelöschten Zeile bleibt (versteckt) erhalten', () => {
  const a = [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'X' }] }];
  const b = [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'Y' }] }];
  assert.deepEqual(T(a, b, 'links'), []); assert.deepEqual(T(a, b, 'rechts'), a); tp1(W0, a, b);
  assert.deepEqual(T(a, [{ typ: 'zeile_loeschen', id: 'z00001' }], 'rechts'), a, 'Löschen versteckt nur – die Eingabe geht nicht verloren');
  tp1(W0, a, [{ typ: 'zeile_loeschen', id: 'z00001' }]);
  assert.deepEqual(A(A(W0, [{ typ: 'zeile_loeschen', id: 'z00001' }]), a).zellen['z00001|s00001'], [{ insert: 'X' }]);
  assert.deepEqual(A(W0, [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [] }]).zellen, {}, 'leerer Inhalt löscht die Zelle');
  assert.deepEqual(W0.zellen, { 'z00001|s00001': [{ insert: 'a' }] }, 'Eingabe bleibt unverändert');
});

test('Zeilen nach derselben Zeile einfügen konvergiert, Grabstein behält die Lage', () => {
  const a = [{ typ: 'zeile_einfuegen', nach: 'z00001', id: 'neuAAA' }]; const b = [{ typ: 'zeile_einfuegen', nach: 'z00001', id: 'neuBBB' }];
  assert.deepEqual(T(b, a, 'rechts'), [{ typ: 'zeile_einfuegen', nach: 'neuAAA', id: 'neuBBB' }]);
  tp1(W0, a, b); assert.deepEqual(A(A(W0, a), T(b, a, 'rechts')).zeilen, ['z00001', 'neuAAA', 'neuBBB', 'z00002']);
  const del = [{ typ: 'zeile_loeschen', id: 'z00001' }];
  tp1(W0, del, a);
  const w = A(A(W0, del), T(a, del, 'rechts'));
  assert.deepEqual([w.weg, sichtbareZeilen(w)], [['z00001'], ['neuAAA', 'z00002']]);
  assert.deepEqual(w.zellen['z00001|s00001'], [{ insert: 'a' }], 'Löschen versteckt nur, der Inhalt bleibt für „zurück“');
  assert.deepEqual(A(W0, [{ typ: 'zeile_einfuegen', nach: null, id: 'oben01' }, { typ: 'zeile_einfuegen', nach: 'gibtsnicht', id: 'unten1' }]).zeilen, ['oben01', 'z00001', 'z00002', 'unten1']);
  assert.deepEqual(sichtbareSpalten(A(W0, [{ typ: 'spalte_loeschen', id: 's00001' }])), ['s00002']);
  assert.equal(zellKey('z00001', 's00002'), 'z00001|s00002');
});

test('gleichzeitig löschen und Löschen rückgängig machen konvergiert', () => {
  const a = [{ typ: 'zeile_loeschen', id: 'z00001' }];
  const b = [{ typ: 'zeile_loeschen', id: 'z00001' }, { typ: 'zeile_zurueck', id: 'z00001', zellen: { s00001: [{ insert: 'a' }] } }];
  tp1(W0, a, b); tp1(W0, b, a); tp1(W0, b, b);
  assert.deepEqual(sichtbareZeilen(A(A(W0, a), T(b, a, 'rechts'))), ['z00001', 'z00002'], 'die spätere Op (hier zurück) gewinnt');
  // Prüfbericht I-4: zurück auf einer noch sichtbaren Zeile gegen Löschen bzw. gegen eine Zelle
  const zurueck = [{ typ: 'zeile_zurueck', id: 'z00001' }];
  tp1(W0, zurueck, a); tp1(W0, a, zurueck);
  tp1(W0, [{ typ: 'zeile_zurueck', id: 'z00001', zellen: { s00001: [{ insert: 'alt' }] } }], [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'neu' }] }]);
  assert.deepEqual(A(W0, [{ typ: 'zeile_zurueck', id: 'z00001', zellen: { s00001: [{ insert: 'alt' }] } }]), W0, 'zurück macht nur sichtbar');
  // beide löschen, beide machen rückgängig, ben löscht erneut: alle Reihenfolgen gleich
  const anna = [{ typ: 'zeile_loeschen', id: 'z00001' }, { typ: 'zeile_zurueck', id: 'z00001' }];
  const ben = [{ typ: 'zeile_loeschen', id: 'z00001' }, { typ: 'zeile_zurueck', id: 'z00001' }, { typ: 'zeile_loeschen', id: 'z00001' }];
  tp1(W0, anna, ben); tp1(W0, ben, anna);
});

test('invertieren: einfügen↔löschen, löschen→zurück, Breite', () => {
  const ops = [{ typ: 'zeile_loeschen', id: 'z00001' }, { typ: 'breite', spalte: 's00002', px: 120 }];
  const inv = tabelle.invertieren(ops, W0);
  assert.deepEqual(inv, [{ typ: 'breite', spalte: 's00002', px: null }, { typ: 'zeile_zurueck', id: 'z00001' }]);
  assert.deepEqual(A(A(W0, ops), inv), W0);
  const w1 = A(W0, [{ typ: 'breite', spalte: 's00001', px: 300 }]);
  const sp = [{ typ: 'spalte_loeschen', id: 's00001' }];
  assert.deepEqual(tabelle.invertieren(sp, w1), [{ typ: 'spalte_zurueck', id: 's00001' }]);
  assert.deepEqual(A(w1, sp).breiten, { s00001: 300 }, 'die Breite bleibt beim Verstecken');
  assert.deepEqual(A(A(w1, sp), tabelle.invertieren(sp, w1)), w1);
  assert.deepEqual(tabelle.invertieren([{ typ: 'zeile_einfuegen', nach: 'z00001', id: 'neuAAA' }], W0), [{ typ: 'zeile_loeschen', id: 'neuAAA' }]);
  assert.deepEqual(tabelle.invertieren([{ typ: 'zeile_loeschen', id: 'z00009' }, { typ: 'breite', spalte: 's00001', px: null }], W0), [], 'was nichts bewirkt, fällt weg');
  assert.deepEqual(tabelle.zusammensetzen([{ typ: 'zeile_loeschen', id: 'z00001' }], [{ typ: 'breite', spalte: 's00002', px: 80 }]),
    [{ typ: 'zeile_loeschen', id: 'z00001' }, { typ: 'breite', spalte: 's00002', px: 80 }]);
});

test('Prüfen: Muster, Typen, Grenzen', () => {
  assert.equal(TABELLEN_OPS.length, 8);
  for (const l of [[{ typ: 'xyz' }], [{ typ: 'zelle', zeile: 'z1', spalte: 's00001', inhalt: [] }], [{ typ: 'breite', spalte: 's00001', px: 39 }],
    [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: { bild: {} } }] }], [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'x'.repeat(20001) }] }],
    [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'x\n' }] }], [{ typ: 'zeile_loeschen', id: 'z00001', mehr: 1 }],
    [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'x', attributes: { liste: 'punkte' } }] }], Array.from({ length: 1001 }, () => ({ typ: 'zeile_loeschen', id: 'z00001' }))])
    assert.throws(() => tabellenOpsPruefen(l), (e) => e.code === 'E_PARAMS', JSON.stringify(l).slice(0, 80));
  assert.doesNotThrow(() => tabellenOpsPruefen([{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'x', attributes: { fett: true, link: 'https://a.de' } }] },
    { typ: 'spalte_zurueck', id: 's00001', zellen: { z00001: [{ insert: 'a' }] }, breite: 120 }, { typ: 'breite', spalte: 's00001', px: null }]));
  assert.throws(() => tabelleWertPruefen({ ...W0, boese: 1 }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => tabelleWertPruefen({ ...W0, weg: ['zzzzzz'] }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => tabelleWertPruefen({ ...W0, zellen: { 'z00009|s00001': [{ insert: 'a' }] } }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => tabelleWertPruefen({ ...W0, breiten: { s00001: 3000 } }), (e) => e.code === 'E_PARAMS');
  assert.doesNotThrow(() => tabelleWertPruefen(W0));
});

test('Attribute: Links, Farben, Zeilenwerte', () => {
  assert.deepEqual(['https://a.de', 'mailto:x@y.de', 'javascript:alert(1)', 'https://a b', ' http://a.de', 'ftp://x'].map(linkErlaubt), [true, true, false, false, false, false]);
  assert.equal(linkErlaubt(`https://a.de/${'x'.repeat(2040)}`), false);
  assert.deepEqual(['rgb(180, 35, 24)', '#abc', 'rot', 'pink'].map((w) => farbeNormal(w)), ['rot', '#aabbcc', 'rot', null]);
  assert.equal(farbeNormal('#FFF3A3', HINTERGRUENDE), 'gelb');
  assert.equal(FARBEN.rot, '#b42318'); assert.equal(HINTERGRUENDE.rosa, '#fbd3e4');
  assert.throws(() => attributePruefen({ ueberschrift: 4 }, { zeile: true }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => attributePruefen({ ausrichtung: 'links' }, { zeile: true }), (e) => e.code === 'E_PARAMS'); // Standard wird nicht gespeichert
  assert.doesNotThrow(() => attributePruefen({ fett: null }, { mitNull: true }));
  assert.throws(() => attributePruefen({ fett: null }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => attributePruefen({ ueberschrift: 1 }), (e) => e.code === 'E_PARAMS', 'Zeilenformat nur auf Zeilen');
  assert.throws(() => attributePruefen({ farbe: '#ABCDEF' }), (e) => e.code === 'E_PARAMS', 'eigene Farben klein');
  assert.doesNotThrow(() => attributePruefen({ ueberschrift: 2, liste: 'aufgabe', erledigt: true, einzug: 8, ausrichtung: 'block', zitat: true }, { zeile: true }));
  assert.doesNotThrow(() => attributePruefen({ farbe: '#abcdef', hintergrund: 'rosa', kommentar: 'kom001', code: true }));
  assert.ok(INLINE_ATTRIBUTE.includes('link') && ZEILEN_ATTRIBUTE.includes('einzug'));
  assert.match(neueId(), /^[A-Za-z0-9_-]{8}$/); assert.ok(ID_MUSTER.test(neueId()));
  assert.equal(DATEI_MUSTER, KONST.DATEI_MUSTER, 'eine Quelle (konstanten.js)');
});

// ---- TP1 mit Zufall ------------------------------------------------------------------------------------------------

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wahl = (rng, l) => l[Math.floor(rng() * l.length)];
const W3 = Object.freeze({
  id: 'tab003', zeilen: ['zeile1', 'zeile2', 'zeile3'], spalten: ['spal01', 'spal02', 'spal03'], weg: [],
  zellen: { 'zeile1|spal01': [{ insert: 'a' }], 'zeile2|spal02': [{ insert: 'b', attributes: { fett: true } }], 'zeile3|spal03': [{ insert: 'c' }] }, breiten: { spal01: 100 },
});

/** 1–4 Ops gegen den Zwischenstand der eigenen Liste – auch auf versteckten Zeilen/Spalten, zurück für jede Kennung (Prüfbericht I-4). */
function zufallsListe(rng, w, kennung) {
  const ops = [];
  let stand = w; let n = 0;
  const geloescht = [];
  const anzahl = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < 40 && ops.length < anzahl; i++) {
    const zeilen = rng() < 0.5 ? sichtbareZeilen(stand) : stand.zeilen; const spalten = rng() < 0.5 ? sichtbareSpalten(stand) : stand.spalten;
    const typ = wahl(rng, TABELLEN_OPS);
    let op = null;
    if (typ === 'zelle' && zeilen.length && spalten.length) op = { typ, zeile: wahl(rng, zeilen), spalte: wahl(rng, spalten), inhalt: rng() < 0.2 ? [] : [{ insert: `${kennung}${i}` }] };
    if (typ === 'zeile_einfuegen' || typ === 'spalte_einfuegen') {
      const alle = typ === 'zeile_einfuegen' ? stand.zeilen : stand.spalten;
      op = { typ, nach: rng() < 0.2 ? null : wahl(rng, alle), id: `${kennung}neu${++n}`.padEnd(6, '0') };
    }
    if (typ === 'zeile_loeschen' && zeilen.length) op = { typ, id: wahl(rng, zeilen) };
    if (typ === 'spalte_loeschen' && spalten.length) op = { typ, id: wahl(rng, spalten) };
    if (typ === 'zeile_zurueck' || typ === 'spalte_zurueck') {
      const g = geloescht.find((x) => x.typ === typ);
      if (g && rng() < 0.5) { op = g; geloescht.splice(geloescht.indexOf(g), 1); } else op = { typ, id: wahl(rng, typ === 'zeile_zurueck' ? stand.zeilen : stand.spalten) };
    }
    if (typ === 'breite' && spalten.length) op = { typ, spalte: wahl(rng, spalten), px: rng() < 0.3 ? null : 40 + Math.floor(rng() * 400) };
    if (!op) continue;
    if (op.typ === 'zeile_loeschen' || op.typ === 'spalte_loeschen') geloescht.push(...tabelle.invertieren([op], stand));
    tabellenOpsPruefen([op]);
    stand = tabelle.anwenden(stand, [op]);
    ops.push(op);
  }
  return ops;
}

for (let seed = 1; seed <= 300; seed++) {
  test(`Tabellen-TP1 seed ${seed}`, () => {
    const rng = mulberry32(seed);
    const a = zufallsListe(rng, W3, 'a'); const b = zufallsListe(rng, W3, 'b');
    tp1(W3, a, b);
    tp1(W3, b, a);
    // Rückgängig: Liste und Umkehrung ergeben den sichtbaren Ausgangsstand (Grabsteine eingefügter Zeilen/Spalten bleiben)
    const w = tabelle.anwenden(W3, a);
    const zurueck = tabelle.anwenden(w, tabelle.invertieren(a, W3));
    assert.deepEqual([sichtbareZeilen(zurueck), sichtbareSpalten(zurueck), zurueck.zellen, zurueck.breiten], [sichtbareZeilen(W3), sichtbareSpalten(W3), W3.zellen, W3.breiten]);
  });
}
