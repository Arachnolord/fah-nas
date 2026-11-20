// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „tabelle“ (Plan 06 Aufgabe 9): Transformation nach Jupiter-Art – Zelle gegen Struktur (Adressen und
// Formeln wandern), Struktur gegen Struktur, Felder „spätere gewinnt“, Ops auf gelöschte Blätter, TP1 für alle Paare
// der Beispiele, zusammensetzen, istNoop, Auswahl, Typ-Register und der Server (OffenesDokument).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D0, BEISPIELE, tp1 } from './sync_tab_beispiele.js';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { tabelle } = await import(pathToFileURL(path.join(SYNC, 'typen', 'tabelle.js')).href);
const { TYPEN } = await import(pathToFileURL(path.join(SYNC, 'typen', 'index.js')).href);

const T = (op, gegen, seite) => tabelle.transformiere(op, gegen, seite);
const META = Object.freeze({ id: 'oAAAAAAAAAAAAAAAA', art: 'tabelle', name: 'Mappe', freigabe: 'team', pfad: 'Mappe.fahtab', besitzer: 'anna' });

const Z = (typ, ab, anzahl, blatt = 'blatt1') => ({ typ, blatt, ab, anzahl });
test('Zelle gegen Struktur: Adresse und Formel wandern, Gelöschtes wird Noop', () => {
  assert.deepEqual(T({ typ: 'zelle', blatt: 'blatt1', zelle: 'A5', w: '=SUM(A1:A4)' }, Z('zeilen_einfuegen', 3, 1), 'rechts'), { typ: 'zelle', blatt: 'blatt1', zelle: 'A6', w: '=SUM(A1:A5)' });
  assert.equal(tabelle.istNoop(T({ typ: 'zelle', blatt: 'blatt1', zelle: 'A3', w: '1' }, Z('zeilen_loeschen', 3, 1), 'rechts')), true);
  assert.deepEqual(T({ typ: 'zelle', blatt: 'blatt2', zelle: 'A1', w: '=[blatt1]!B2' }, Z('spalten_einfuegen', 1, 1), 'links'), { typ: 'zelle', blatt: 'blatt2', zelle: 'A1', w: '=[blatt1]!C2' });
});
test('Struktur gegen Struktur', () => {
  assert.equal(tabelle.istNoop(T(Z('zeilen_einfuegen', 5, 1), Z('zeilen_loeschen', 3, 4), 'rechts')), true);
  // Ruling Aufgabe 9: Einfügen direkt am Rand des gleichzeitig gelöschten Bereichs (Zeile 3 bzw. 7) verliert wie innen
  assert.equal(tabelle.istNoop(T(Z('zeilen_einfuegen', 3, 1), Z('zeilen_loeschen', 3, 4), 'rechts')), true);
  assert.equal(tabelle.istNoop(T(Z('zeilen_einfuegen', 7, 1), Z('zeilen_loeschen', 3, 4), 'links')), true);
  assert.deepEqual([T(Z('zeilen_einfuegen', 2, 1), Z('zeilen_loeschen', 3, 4), 'rechts'), T(Z('zeilen_einfuegen', 8, 1), Z('zeilen_loeschen', 3, 4), 'rechts')], [Z('zeilen_einfuegen', 2, 1), Z('zeilen_einfuegen', 4, 1)]);
  assert.deepEqual([T(Z('zeilen_loeschen', 3, 4), Z('zeilen_einfuegen', 3, 1), 'rechts'), T(Z('zeilen_loeschen', 3, 4), Z('zeilen_einfuegen', 7, 2), 'links'), T(Z('zeilen_loeschen', 3, 4), Z('zeilen_einfuegen', 8, 1), 'rechts'), T(Z('zeilen_loeschen', 3, 4), Z('zeilen_einfuegen', 2, 1), 'rechts')],
    [Z('zeilen_loeschen', 3, 5), Z('zeilen_loeschen', 3, 6), Z('zeilen_loeschen', 3, 4), Z('zeilen_loeschen', 4, 4)]);
  assert.deepEqual(T(Z('zeilen_loeschen', 3, 4), Z('zeilen_einfuegen', 5, 2), 'rechts'), Z('zeilen_loeschen', 3, 6));
  assert.deepEqual(T(Z('zeilen_loeschen', 1, 10), Z('zeilen_loeschen', 4, 2), 'rechts'), Z('zeilen_loeschen', 1, 8));
  assert.deepEqual([T(Z('zeilen_einfuegen', 5, 1), Z('zeilen_einfuegen', 5, 2), 'links'), T(Z('zeilen_einfuegen', 5, 1), Z('zeilen_einfuegen', 5, 2), 'rechts')], [Z('zeilen_einfuegen', 5, 1), Z('zeilen_einfuegen', 7, 1)]);
  assert.deepEqual(T(Z('spalten_loeschen', 2, 1), Z('zeilen_einfuegen', 1, 3), 'rechts'), Z('spalten_loeschen', 2, 1));
});
test('Zelle gegen Zelle: letzte gewinnt je Feld', () => {
  const a = { typ: 'zelle', blatt: 'blatt1', zelle: 'B2', w: 'a', f: { fett: true, farbe: '#b42318' } }; const b = { typ: 'zellen', blatt: 'blatt1', werte: { B2: { f: { fett: null } }, C3: { w: 'x' } } };
  assert.deepEqual(T(a, b, 'links'), { typ: 'zelle', blatt: 'blatt1', zelle: 'B2', w: 'a', f: { farbe: '#b42318' } }); assert.deepEqual(T(a, b, 'rechts'), a);
});
test('Ops auf gelöschtes Blatt → Noop; Blatt-Felder letzte gewinnt', () => {
  for (const op of [{ typ: 'zelle', blatt: 'blatt2', zelle: 'A1', w: '1' }, Z('zeilen_einfuegen', 1, 1, 'blatt2'), { typ: 'blatt_umbenennen', blatt: 'blatt2', name: 'X' }, { typ: 'fixieren', blatt: 'blatt2', zeilen: 1 }])
    assert.equal(tabelle.istNoop(T(op, { typ: 'blatt_loeschen', blatt: 'blatt2' }, 'rechts')), true, op.typ);
  assert.equal(tabelle.istNoop(T({ typ: 'blatt_umbenennen', blatt: 'blatt2', name: 'X' }, { typ: 'blatt_umbenennen', blatt: 'blatt2', name: 'Y' }, 'links')), true);
});
test('TP1 für alle Paare der Beispiele', () => { for (const a of BEISPIELE) for (const b of BEISPIELE) tp1(D0(), a, b); });
test('TP1 Struktur gegen Struktur: Bereiche mit jedem Anfang und Ende an jedem Rand (vollständig)', () => {
  const A = (d, op) => tabelle.anwenden(d, op);
  for (const achse of ['zeilen', 'spalten']) {
    const ref = (i) => (achse === 'zeilen' ? `A${i}` : `${'ABCDEFGH'[i - 1]}1`);
    const ganz = (i) => (achse === 'zeilen' ? String(i) : 'ABCDEFGH'[i - 1]);
    const teile = [], fremd = [];
    for (let v = 1; v <= 7; v++) {
      teile.push(ref(v)); fremd.push(`[blatt1]!${ref(v)}`);
      for (let b = v; b <= 7; b++) {
        teile.push(`SUM(${ref(v)}:${ref(b)})`, `SUM(${ganz(v)}:${ganz(b)})`);
        fremd.push(`SUM([blatt1]!${ref(v)}:${ref(b)})`, `SUM([blatt1]!${ganz(v)}:${ganz(b)})`);
      }
    }
    const werte = { T20: { w: `=${teile.join('+')}` } };
    for (let i = 1; i <= 8; i++) werte[ref(i)] = { w: String(i) };
    const d = A(A(tabelle.leer(), { typ: 'zellen', blatt: 'blatt1', werte }), { typ: 'blatt_neu', blatt: { id: 'blatt2', name: 'F', pos: 'r', zellen: { A1: { w: `=${fremd.join('+')}` } } } });
    const ops = [];
    for (const art of ['einfuegen', 'loeschen']) for (let ab = 1; ab <= 6; ab++) for (let anzahl = 1; anzahl <= 3; anzahl++) ops.push({ typ: `${achse}_${art}`, blatt: 'blatt1', ab, anzahl });
    for (const a of ops) for (const b of ops) tp1(d, a, b);
  }
});
test('Neues Blatt gegen Struktur: Formeln der Nutzlast wandern wie gespeicherte', () => {
  const neu = { typ: 'blatt_neu', blatt: { id: 'blatt3', name: 'Neu', pos: 'z', zellen: { A1: { w: '=[blatt1]!A2*3' }, B1: { w: '=A1+1' } } } };
  assert.deepEqual(T(neu, Z('zeilen_einfuegen', 1, 1), 'rechts').blatt.zellen, { A1: { w: '=[blatt1]!A3*3' }, B1: { w: '=A1+1' } });
  assert.equal(T(neu, Z('zeilen_einfuegen', 1, 1, 'blatt2'), 'links'), neu);
  const zurueck = { typ: 'blatt_neu', blatt: { id: 'blatt1', name: 'Alt', pos: 'i', zellen: { A2: { w: '=A1' } }, zeilen: { 2: { hoehe: 30 } } } };
  assert.deepEqual(T(zurueck, Z('zeilen_einfuegen', 1, 2), 'rechts').blatt, { id: 'blatt1', name: 'Alt', pos: 'i', zellen: { A4: { w: '=A3' } }, zeilen: { 4: { hoehe: 30 } } });
});
test('zusammensetzen und istNoop', () => {
  assert.deepEqual(tabelle.zusammensetzen({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1' }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '2' }),
    { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: '1' }, A2: { w: '2' } } });
  assert.deepEqual(tabelle.zusammensetzen({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1', f: { fett: true } }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '2' }),
    { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: '2', f: { fett: true } } } });
  assert.equal(tabelle.zusammensetzen({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1' }, { typ: 'zelle', blatt: 'blatt2', zelle: 'A1', w: '1' }), null);
  assert.equal(tabelle.zusammensetzen(Z('zeilen_einfuegen', 1, 1), Z('zeilen_einfuegen', 1, 1)), null);
  assert.deepEqual([tabelle.istNoop({ typ: 'noop' }), tabelle.istNoop({ typ: 'zellen', blatt: 'blatt1', werte: {} }), tabelle.istNoop({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: null })], [true, true, false]);
});
test('auswahlTransformieren', () => {
  const aw = { blatt: 'blatt1', von: 'B2', bis: 'C4' };
  assert.deepEqual(tabelle.auswahlTransformieren(aw, Z('zeilen_loeschen', 3, 1), false), { blatt: 'blatt1', von: 'B2', bis: 'C3' });
  assert.deepEqual(tabelle.auswahlTransformieren(aw, Z('zeilen_loeschen', 2, 3), false), { blatt: 'blatt1', von: 'B2', bis: 'C2' });
  assert.deepEqual(tabelle.auswahlTransformieren(aw, Z('spalten_einfuegen', 1, 1), true), { blatt: 'blatt1', von: 'C2', bis: 'D4' });
  assert.equal(tabelle.auswahlTransformieren(aw, { typ: 'blatt_loeschen', blatt: 'blatt1' }, false), null);
});
test('Register und Server', () => {
  assert.equal(TYPEN.tabelle, tabelle);
  const s = new OffenesDokument({ meta: META, typ: tabelle, version: 0, daten: null, stand: 'S0' });
  s.opAnnehmen({ basis: 0, cid: 'a-1', op: { typ: 'zelle', blatt: 'blatt1', zelle: 'A5', w: '=SUM(A1:A4)' }, nutzer: 'anna' });
  s.opAnnehmen({ basis: 0, cid: 'b-1', op: Z('zeilen_einfuegen', 3, 1), nutzer: 'ben' });
  assert.deepEqual([s.version, s.daten.blaetter[0].zellen.A6.w], [2, '=SUM(A1:A5)']);
});

test('Server: zu viel nachzurechnen (große Zell-Op gegen viele Struktur-Ops seit ihrer Basis) → neu laden statt blockieren (Prüfbericht I1)', () => {
  const s = new OffenesDokument({ meta: META, typ: tabelle, version: 0, daten: D0(), stand: 'S0' });
  for (let i = 1; i <= 10; i++) s.opAnnehmen({ basis: i - 1, cid: `s-${i}`, op: { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 }, nutzer: 'anna' });
  const werte = {}; for (let i = 1; i <= 50000; i++) werte[`C${i}`] = { w: `=A${i}+B${i}` };
  const t0 = performance.now();
  assert.throws(() => s.opAnnehmen({ basis: 0, cid: 'gross-alt', op: { typ: 'zellen', blatt: 'blatt1', werte }, nutzer: 'ben' }), (e) => e.code === 'E_GEAENDERT');
  assert.ok(performance.now() - t0 < 1000, 'ohne erst alles durchzurechnen');
  assert.equal(s.version, 10, 'nichts angewandt');
  // dieselbe Op auf aktuellem Stand und eine kleine auf altem Stand gehen durch
  assert.equal(s.opAnnehmen({ basis: 10, cid: 'gross-neu', op: { typ: 'zellen', blatt: 'blatt1', werte }, nutzer: 'ben' }).v, 11);
  assert.equal(s.opAnnehmen({ basis: 0, cid: 'klein-alt', op: { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: 'x' }, nutzer: 'ben' }).v, 12);
});

test('Server-Verlauf: Gespeichertes höchstens verlauf_zeichen JSON-Zeichen, Ungespeichertes nie gekürzt (Prüfbericht Plan 06)', () => {
  const s = new OffenesDokument({ meta: META, typ: tabelle, version: 0, daten: D0(), stand: 'S0', verlauf_zeichen: 50_000 });
  for (let i = 1; i <= 10; i++) s.opAnnehmen({ basis: i - 1, cid: `c-${i}`, op: { typ: 'zelle', blatt: 'blatt1', zelle: `A${i}`, w: 'x'.repeat(10_000) }, nutzer: 'anna' });
  assert.equal(s.verlauf.length, 10, 'Ungespeichertes bleibt');
  s.gespeichert(10, 'S1');
  assert.deepEqual(s.verlauf.map((e) => e.v), [7, 8, 9, 10]);
  assert.equal(s.opsSeit(5), null, 'so alte Stände laden neu');
  assert.deepEqual(Object.keys(s.verlauf[0]).sort(), ['cid', 'op', 'v']);
  // ein geladener Verlauf zählt mit
  const t = new OffenesDokument({ meta: META, typ: tabelle, version: 10, daten: s.daten, stand: 'S1', verlauf: s.verlauf, verlauf_zeichen: 25_000 });
  t.gespeichert(10, 'S1');
  assert.deepEqual(t.verlauf.map((e) => e.v), [9, 10]);
});
