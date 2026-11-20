// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle: Rückgängig und Wiederholen (Plan 06 Aufgabe 17) – Review Focus 2 (eine spätere fremde Änderung
// gewinnt gegen Rückgängig; Zeile löschen, fremd tippt darunter, Rückgängig holt die Zeile an die richtige Stelle),
// Wiederholen, höchstens 100 Schritte, neue eigene Op leert Wiederholen, Noops werden nicht gemerkt; dazu alle Op-Arten
// zurück und wieder sowie ein Schritt, den eine fremde Struktur-Op mitverschiebt. Ohne DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D0, BEISPIELE, mappe, werteVon } from './sync_tab_beispiele.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const { tabelle, invertieren } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);
const { TabVerlauf } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'tabelle', 'verlauf.js')).href);

const A = (d, op) => tabelle.anwenden(d, op);

test('Review Focus 2a: fremde spätere Änderung gewinnt gegen Rückgängig', () => {
  const v = new TabVerlauf(); let d = D0();
  const mein = { typ: 'zelle', blatt: 'blatt1', zelle: 'B2', w: 'anna' }; v.eigene(d, mein); d = A(d, mein);
  const fremd = { typ: 'zelle', blatt: 'blatt1', zelle: 'B2', w: 'ben' }; v.fremde(fremd); d = A(d, fremd);
  const ops = v.rueckgaengig(d); assert.deepEqual(ops, []); assert.equal(ops.reduce(A, d).blaetter[0].zellen.B2.w, 'ben'); assert.equal(v.kannZurueck, false);
});
test('Review Focus 2b: Zeile löschen, fremd tippt darunter, Rückgängig', () => {
  const v = new TabVerlauf(); let d = mappe({ blatt1: { A1: '1', A2: '2', A3: 'drei', A4: '=A3&"!"' } });
  const del = { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 3, anzahl: 1 }; v.eigene(d, del); d = A(d, del);
  const fremd = { typ: 'zelle', blatt: 'blatt1', zelle: 'A10', w: 'ben' }; v.fremde(fremd); d = A(d, fremd);
  d = v.rueckgaengig(d).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A1: '1', A2: '2', A3: 'drei', A4: '=A3&"!"', A11: 'ben' });
  d = v.wiederholen(d).reduce(A, d); assert.deepEqual(werteVon(d, 'blatt1'), { A1: '1', A2: '2', A3: '=#REF!&"!"', A10: 'ben' });
});
test('neue eigene Op leert Wiederholen; höchstens 100 Schritte; Noops werden nicht gemerkt', () => {
  const v = new TabVerlauf(); let d = D0();
  for (let i = 0; i < 105; i++) { const op = { typ: 'zelle', blatt: 'blatt1', zelle: 'C1', w: String(i) }; v.eigene(d, op); d = A(d, op); }
  let n = 0; while (v.kannZurueck) { d = v.rueckgaengig(d).reduce(A, d); n++; } assert.equal(n, 100);
  v.eigene(d, { typ: 'zelle', blatt: 'blatt1', zelle: 'C1', w: 'x' }); assert.equal(v.kannVor, false);
  v.eigene(d, { typ: 'noop' }); /* zählt nicht */
});
test('ohne fremde Änderungen: alles zurück ergibt den Anfang, alles wieder das Ende (alle Op-Arten nacheinander)', () => {
  const v = new TabVerlauf(); let d = D0(); const anfang = d;
  for (const op of BEISPIELE) { v.eigene(d, op); d = A(d, op); }
  const ende = d;
  while (v.kannZurueck) d = v.rueckgaengig(d).reduce(A, d);
  assert.deepEqual(d, anfang);
  while (v.kannVor) d = v.wiederholen(d).reduce(A, d);
  assert.deepEqual(d, ende);
});
test('eine fremde Struktur-Op verschiebt den Rückgängig-Schritt mit', () => {
  const v = new TabVerlauf(); let d = D0();
  const mein = { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: 'neu' }; v.eigene(d, mein); d = A(d, mein);
  const fremd = { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 }; v.fremde(fremd); d = A(d, fremd);
  d = v.rueckgaengig(d).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A2: '1', A3: '2', A4: '=SUM(A2:A3)' });
  assert.equal(v.kannVor, true); assert.equal(v.wiederholen(d).reduce(A, d).blaetter[0].zellen.A3.w, 'neu');
});

// ---- Prüfbericht I2: Rückgängig großer Änderungen in sendbaren Stücken, ganz oder gar nicht ----------------------------
const OP_MAX = 7_340_032;
const byte = (op) => Buffer.byteLength(JSON.stringify(op));
function grossesBlatt(spalten = 'ABCDEFGHIJ') {
  const z = {};
  for (let i = 1; i <= 6000; i++) for (const c of spalten) z[`${c}${i}`] = `Kunde ${i} ${c} – Musterstraße 12, 12345 Musterstadt, Tel. 0000 0000 0000`;
  return z;
}

test('Umkehrung großer Zeilen-Löschung: jedes Stück unter 7 340 032 Byte, zusammen wieder der alte Stand (Prüfbericht I2)', () => {
  const d = mappe({ blatt1: grossesBlatt() });
  const del = { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 1, anzahl: 6000 };
  const inv = invertieren(d, del);
  for (const op of inv) assert.ok(byte(op) <= OP_MAX, `${op.typ} mit ${byte(op)} Byte`);
  // große Objekte nur als ja/nein vergleichen – die Fehlermeldung von assert.deepEqual braucht dafür Minuten
  assert.ok(isDeepStrictEqual(werteVon(inv.reduce(A, A(d, del)), 'blatt1'), werteVon(d, 'blatt1')), 'alter Stand nicht wieder da');
});

test('Umkehrung eines gelöschten großen Blatts: leeres Blatt plus Zellen in Stücken (Prüfbericht I2)', () => {
  const d = mappe({ blatt1: { A1: '=[gross1]!A1' }, gross1: grossesBlatt('ABCDEFGHIJKLMNO') });
  const del = { typ: 'blatt_loeschen', blatt: 'gross1', rest: ['blatt1'] };
  const inv = invertieren(d, del);
  for (const op of inv) assert.ok(byte(op) <= OP_MAX, `${op.typ} mit ${byte(op)} Byte`);
  const zurueck = inv.reduce(A, A(d, del));
  assert.ok(isDeepStrictEqual(werteVon(zurueck, 'gross1'), werteVon(d, 'gross1')), 'Blatt nicht wieder da');
  assert.deepEqual(werteVon(zurueck, 'blatt1'), { A1: '=[gross1]!A1' });
});

test('zusammensetzen hält die Bytegrenze: zwei große Stücke bleiben getrennt, kleine werden eins (Prüfbericht I2)', () => {
  const stueck = (ab) => { const w = {}; for (let i = 0; i < 25000; i++) w[`B${ab + i}`] = { w: 'x'.repeat(150) }; return { typ: 'zellen', blatt: 'blatt1', werte: w }; };
  assert.ok(tabelle.zusammensetzen(stueck(1), stueck(25001)) === null, 'zwei große Stücke zu einem zusammengesetzt');
  assert.deepEqual(tabelle.zusammensetzen({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1' }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '2' }),
    { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: '1' }, A2: { w: '2' } } });
});

test('Rückgängig/Wiederholen ganz oder gar nicht: lehnt die Prüfung den Schritt ab, bleibt er liegen (Prüfbericht I2)', () => {
  const v = new TabVerlauf(); let d = D0();
  const op = { typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: 'x' }; v.eigene(d, op); d = A(d, op);
  assert.equal(v.rueckgaengig(d, () => false), false);
  assert.equal(v.kannZurueck, true);
  const ops = v.rueckgaengig(d, (liste) => Array.isArray(liste) && liste.length === 1);
  assert.equal(ops.length, 1); d = ops.reduce(A, d);
  assert.equal(v.wiederholen(d, () => false), false);
  assert.equal(v.kannVor, true);
  assert.equal(v.wiederholen(d).reduce(A, d).blaetter[0].zellen.A1.w, 'x');
});

// ---- Prüfbericht I3: Rückgängig nimmt nie mit, was andere inzwischen geschrieben oder eingefügt haben -------------------
test('eigene Zeile eingefügt, fremd tippt hinein, Strg+Z: die fremde Eingabe bleibt (Prüfbericht I3)', () => {
  const v = new TabVerlauf(); let d = mappe({ blatt1: { A4: 'vier', A5: 'fünf' } });
  const ein = { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 5, anzahl: 1 }; v.eigene(d, ein); d = A(d, ein);
  const fremd = { typ: 'zelle', blatt: 'blatt1', zelle: 'A5', w: 'von ben' }; v.fremde(fremd); d = A(d, fremd);
  d = (v.rueckgaengig(d) || []).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A4: 'vier', A5: 'von ben', A6: 'fünf' });
});

test('fremde Zeile mitten in den eigenen eingefügten Zeilen: Strg+Z löscht sie nicht mit (Prüfbericht I3)', () => {
  const v = new TabVerlauf(); let d = mappe({ blatt1: { A4: 'vier', A5: 'fünf' } });
  const ein = { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 5, anzahl: 3 }; v.eigene(d, ein); d = A(d, ein);
  for (const fremd of [{ typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 6, anzahl: 1 }, { typ: 'zelle', blatt: 'blatt1', zelle: 'B6', w: 'ben' }]) { v.fremde(fremd); d = A(d, fremd); }
  d = (v.rueckgaengig(d) || []).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A4: 'vier', B6: 'ben', A9: 'fünf' });
});

test('eigenes neues Blatt, fremd schreibt hinein, Strg+Z: das Blatt bleibt (Prüfbericht I3)', () => {
  const v = new TabVerlauf(); let d = D0();
  const neu = { typ: 'blatt_neu', blatt: { id: 'neu001', name: 'Neu', pos: 'z' } }; v.eigene(d, neu); d = A(d, neu);
  const fremd = { typ: 'zelle', blatt: 'neu001', zelle: 'A1', w: 'ben' }; v.fremde(fremd); d = A(d, fremd);
  d = (v.rueckgaengig(d) || []).reduce(A, d);
  assert.deepEqual(werteVon(d, 'neu001'), { A1: 'ben' });
});

test('Wiederholen eines Löschens, nachdem fremd in die zurückgeholte Zeile schrieb: die fremde Eingabe bleibt (Prüfbericht I3)', () => {
  const v = new TabVerlauf(); let d = mappe({ blatt1: { A2: 'zwei', A3: 'drei', A4: 'vier' } });
  const del = { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 3, anzahl: 1 }; v.eigene(d, del); d = A(d, del);
  d = v.rueckgaengig(d).reduce(A, d);
  const fremd = { typ: 'zelle', blatt: 'blatt1', zelle: 'B3', w: 'ben' }; v.fremde(fremd); d = A(d, fremd);
  d = (v.wiederholen(d) || []).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A2: 'zwei', A3: 'drei', B3: 'ben', A4: 'vier' });
});

test('Fremdes außerhalb der eigenen Zeilen: Strg+Z nimmt das Einfügen weiter zurück, ältere Schritte bleiben (Prüfbericht I3)', () => {
  const v = new TabVerlauf(); let d = mappe({ blatt1: { A1: 'eins' } });
  const alt = { typ: 'zelle', blatt: 'blatt1', zelle: 'C1', w: 'alt' }; v.eigene(d, alt); d = A(d, alt);
  const ein = { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 }; v.eigene(d, ein); d = A(d, ein);
  const fremd = { typ: 'zelle', blatt: 'blatt1', zelle: 'A20', w: 'ben' }; v.fremde(fremd); d = A(d, fremd);
  d = v.rueckgaengig(d).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A1: 'eins', C1: 'alt', A19: 'ben' });
  d = v.rueckgaengig(d).reduce(A, d);
  assert.deepEqual(werteVon(d, 'blatt1'), { A1: 'eins', A19: 'ben' });
});
