// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „tabelle“ (Plan 06 Aufgabe 8): leere Mappe, Zellen setzen (Standardwerte nicht gespeichert), Zeilen und
// Spalten einfügen/löschen samt Metadaten und Formeln aller Blätter, Blatt-Ops, Sortier-Schnappschuss, unbekannte
// Blätter, Prüfung der Ops, keine Mutation, Umkehrung jeder Op-Art und Prüfung ganzer Mappen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D0, BEISPIELE, tiefFrieren, mappe } from './sync_tab_beispiele.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const modul = await import(pathToFileURL(path.join(SYNC, 'typen', 'tabelle.js')).href);
const { tabelle, LEER_F, F_FELDER, OP_TYPEN, invertieren, datenPruefen, blattVon } = modul;
const { SyncFehler } = await import(pathToFileURL(path.join(SYNC, 'fehler.js')).href);

const A = (d, op) => tabelle.anwenden(d, op);

test('leer', () => {
  assert.deepEqual(tabelle.leer(), { blaetter: [{ id: 'blatt1', name: 'Tabelle1', pos: 'i', zellen: {}, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } }] });
  assert.equal(modul.default, tabelle); assert.equal(tabelle.name, 'tabelle');
  assert.deepEqual([...F_FELDER], ['fett', 'kursiv', 'farbe', 'hinter', 'ausr', 'zahl']);
  assert.deepEqual(LEER_F, { fett: null, kursiv: null, farbe: null, hinter: null, ausr: null, zahl: null });
  assert.ok(OP_TYPEN.includes('noop') && OP_TYPEN.includes('sortieren'));
  assert.deepEqual(new Set(BEISPIELE.map((op) => op.typ)), new Set(OP_TYPEN), 'BEISPIELE decken jede Op-Art ab');
  assert.equal(blattVon(D0(), 'blatt2').name, 'Daten'); assert.equal(blattVon(D0(), 'wegweg'), null);
});
test('zelle: Felder setzen, null entfernt, Standardwerte nicht gespeichert, leere Zelle verschwindet', () => {
  let d = A(D0(), { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: null }); assert.equal(d.blaetter[0].zellen.A1, undefined);
  d = A(d, { typ: 'zelle', blatt: 'blatt1', zelle: 'B5', f: { fett: false, zahl: 'standard', ausr: 'mitte' } });
  assert.deepEqual(d.blaetter[0].zellen.B5, { f: { ausr: 'mitte' } });
});
test('Zeilen einfügen/löschen verschieben Zellen, Metadaten und Formeln aller Blätter', () => {
  let d = A(A(D0(), { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 }), { typ: 'noop' });
  assert.deepEqual(Object.keys(d.blaetter[0].zellen).sort(), ['A2', 'A3', 'A4', 'B6']);
  assert.equal(d.blaetter[0].zellen.A4.w, '=SUM(A2:A3)'); assert.equal(d.blaetter[1].zellen.A1.w, '=[blatt1]!A4*2');
  d = A(D0(), { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 1, anzahl: 1 });
  assert.deepEqual([d.blaetter[0].zellen.A1.w, d.blaetter[0].zellen.A2.w, d.blaetter[1].zellen.A1.w], ['2', '=SUM(A1:A1)', '=[blatt1]!A2*2']);
});
test('Spalten einfügen/löschen samt Breiten', () => {
  let d = A(D0(), { typ: 'spalte_breite', blatt: 'blatt1', spalte: 2, breite: 140 });
  d = A(d, { typ: 'spalten_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 2 });
  assert.deepEqual([d.blaetter[0].spalten, d.blaetter[0].zellen.C3.w], [{ D: { breite: 140 } }, '=SUM(C1:C2)']);
  d = A(d, { typ: 'spalten_loeschen', blatt: 'blatt1', ab: 4, anzahl: 1 }); assert.deepEqual(d.blaetter[0].spalten, {});
});
test('Blätter: neu, umbenennen, verschieben, löschen; letztes Blatt weg → Standardblatt', () => {
  let d = A(D0(), { typ: 'blatt_verschieben', blatt: 'blatt2', pos: 'a' }); assert.deepEqual(d.blaetter.map((b) => b.id), ['blatt2', 'blatt1']);
  d = A(d, { typ: 'blatt_umbenennen', blatt: 'blatt2', name: 'Neu' }); assert.equal(d.blaetter[0].name, 'Neu');
  d = A(A(d, { typ: 'blatt_loeschen', blatt: 'blatt1' }), { typ: 'blatt_loeschen', blatt: 'blatt2' }); assert.deepEqual(d, tabelle.leer());
});
test('sortieren schreibt den Schnappschuss', () => {
  const d = A(D0(), { typ: 'sortieren', blatt: 'blatt1', bereich: 'A1:A2', spalte: 1, absteigend: true, zellen: { A1: { w: '2', f: LEER_F }, A2: { w: '1', f: LEER_F } } });
  assert.deepEqual([d.blaetter[0].zellen.A1, d.blaetter[0].zellen.A2], [{ w: '2' }, { w: '1' }]);
});
test('Ops auf unbekannte Blätter ändern nichts', () => {
  for (const op of [{ typ: 'zelle', blatt: 'wegweg', zelle: 'A1', w: '1' }, { typ: 'zeilen_loeschen', blatt: 'wegweg', ab: 1, anzahl: 1 }, { typ: 'blatt_umbenennen', blatt: 'wegweg', name: 'x' }])
    assert.deepEqual(A(D0(), op), D0());
});
test('pruefen: Formen und Grenzen → SyncFehler E_PARAMS', () => {
  for (const op of [{ typ: 'xyz' }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A0', w: '1' }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: 'x'.repeat(32768) },
    { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '=' + '1'.repeat(8192) }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', f: { farbe: 'red' } },
    { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', f: { boese: 1 } }, { typ: 'zellen', blatt: 'blatt1', werte: {} }, { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 0, anzahl: 1 },
    { typ: 'spalten_loeschen', blatt: 'blatt1', ab: 1, anzahl: 1025 }, { typ: 'blatt_neu', blatt: { id: 'x', name: 'a', pos: 'i' } }, { typ: 'blatt_umbenennen', blatt: 'blatt1', name: 'a/b' },
    { typ: 'spalte_breite', blatt: 'blatt1', spalte: 1, breite: 5 }, { typ: 'fixieren', blatt: 'blatt1', zeilen: 2 }, { typ: 'blatt_verschieben', blatt: 'blatt1', pos: 'A' },
    { typ: 'sortieren', blatt: 'blatt1', bereich: 'A1:A2', spalte: 3, absteigend: false, zellen: {} }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1', x: 1 }])
    assert.throws(() => tabelle.pruefen(op), (e) => e instanceof SyncFehler && e.code === 'E_PARAMS', JSON.stringify(op).slice(0, 80));
  for (const op of BEISPIELE) assert.doesNotThrow(() => tabelle.pruefen(op), op.typ);
});
test('anwenden mutiert nicht', () => { const d = tiefFrieren(D0()); for (const op of BEISPIELE) assert.doesNotThrow(() => A(d, op), op.typ); });
test('invertieren stellt für jede Op-Art den Stand wieder her', () => {
  for (const op of BEISPIELE) {
    const d = D0(); const inv = invertieren(d, op);
    assert.deepEqual(inv.reduce((x, o) => A(x, o), A(d, op)), d, op.typ);
    for (const o of inv) assert.doesNotThrow(() => tabelle.pruefen(o), `Umkehrung von ${op.typ} ist gültig`);
  }
});
test('Blatt löschen: Bezüge darauf werden #REF!, Standardblatt nach rest, Umkehrung holt alles zurück (Aufgabe 10)', () => {
  const x = A(D0(), { typ: 'blatt_loeschen', blatt: 'blatt1', rest: ['blatt2'] });
  assert.deepEqual([x.blaetter.map((b) => b.id), x.blaetter[0].zellen.A1.w], [['blatt2'], '=#REF!*2']);
  const zwei = mappe({ x00001: { A1: '1' }, y00001: { B1: '=[x00001]!A1' } });
  const y = A(zwei, { typ: 'blatt_loeschen', blatt: 'x00001', rest: [] }); // der Auslöser kannte kein anderes Blatt
  assert.deepEqual([y.blaetter.map((b) => b.id), y.blaetter[1].zellen.B1.w], [['blatt1', 'y00001'], '=#REF!']);
  /** Umkehrung anwenden; ein zurückgeholtes blatt1 trägt eine neue Kennung – für den Vergleich heißt sie wieder blatt1. */
  const zurueck = (d, op) => {
    const inv = invertieren(d, op);
    for (const o of inv) assert.doesNotThrow(() => tabelle.pruefen(o), JSON.stringify(o).slice(0, 80));
    const r = inv.reduce(A, A(d, op));
    const neu = r.blaetter.find((b) => !d.blaetter.some((a) => a.id === b.id))?.id;
    return { neu, daten: neu ? JSON.parse(JSON.stringify(r).replaceAll(`[${neu}]!`, '[blatt1]!').replaceAll(`"id":"${neu}"`, '"id":"blatt1"')) : r };
  };
  const alt = A(mappe({ blatt1: { A1: '1', B2: '=A1+[blatt1]!A1' }, y00001: { C3: '=[blatt1]!B2' } }), { typ: 'blatt_umbenennen', blatt: 'blatt1', name: 'Alt' });
  for (const [d, op, umbenannt] of [[D0(), { typ: 'blatt_loeschen', blatt: 'blatt2', rest: ['blatt1'] }, false], [D0(), { typ: 'blatt_loeschen', blatt: 'blatt1', rest: ['blatt2'] }, true],
    [zwei, { typ: 'blatt_loeschen', blatt: 'x00001', rest: [] }, false], [alt, { typ: 'blatt_loeschen', blatt: 'blatt1', rest: ['y00001'] }, true],
    [mappe({ blatt1: { A1: '1' } }), { typ: 'blatt_loeschen', blatt: 'blatt1', rest: [] }, true]]) {
    const r = zurueck(d, op);
    assert.equal(Boolean(r.neu), umbenannt, JSON.stringify(op));
    assert.deepEqual(r.daten, d, JSON.stringify(op));
  }
  assert.throws(() => tabelle.pruefen({ typ: 'blatt_loeschen', blatt: 'blatt1' }), (e) => e.code === 'E_PARAMS', 'rest ist Pflicht');
  assert.throws(() => tabelle.pruefen({ typ: 'blatt_loeschen', blatt: 'blatt1', rest: ['blatt1'] }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => tabelle.pruefen({ typ: 'blatt_neu', blatt: { id: 'blatt1', name: 'Alt', pos: 'i' } }), (e) => e.code === 'E_PARAMS', 'blatt1 nur als Standardblatt');
  assert.doesNotThrow(() => tabelle.pruefen({ typ: 'blatt_neu', blatt: tabelle.leer().blaetter[0] }));
});
test('datenPruefen', () => { assert.doesNotThrow(() => datenPruefen(D0())); assert.throws(() => datenPruefen({ blaetter: [] }), (e) => e.code === 'E_PARAMS'); });
