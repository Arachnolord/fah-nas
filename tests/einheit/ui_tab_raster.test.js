// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle: Rasterlogik (Plan 06 Aufgabe 15) – Maße mit Präfixsummen (eigene Höhen, versteckte Zeilen), der
// sichtbare Bereich mit Puffer, Maße aus einem Blatt, Auswahl bewegen wie Excel (Rand, Erweitern, Springen), Umwandlung
// in die Sync-Auswahl und Tasten → Befehle. Ohne DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const TABELLE = path.join(HIER, '..', '..', 'public', 'office', 'tabelle');
const { Masse, sichtbarerBereich, masseAusBlatt } = await import(pathToFileURL(path.join(TABELLE, 'masse.js')).href);
const { auswahlNeu, bereichVon, alsSyncAuswahl, ausSyncAuswahl, bewegen, tasteZuBefehl } = await import(pathToFileURL(path.join(TABELLE, 'auswahl.js')).href);

test('Masse: Präfixsummen, eigene Höhen, versteckte Zeilen', () => {
  const m = new Masse({ standard: 24, eigene: new Map([[3, 40]]), versteckt: new Set([5]), anzahl: 10 });
  assert.deepEqual([m.position(1), m.position(4), m.position(6), m.index(100), m.summe], [0, 88, 112, 4, 232]);
});
test('sichtbarerBereich mit Puffer', () => {
  const zeilen = new Masse({ standard: 24, eigene: new Map([[3, 40]]), versteckt: new Set([5]), anzahl: 100 }); const spalten = new Masse({ standard: 100, anzahl: 26 });
  assert.deepEqual(sichtbarerBereich({ oben: 100, links: 0, hoehe: 200, breite: 300, zeilen, spalten }), { z1: 2, z2: 15, s1: 1, s2: 4 });
  assert.deepEqual(sichtbarerBereich({ oben: 0, links: 0, hoehe: 600, breite: 800, zeilen: new Masse({ standard: 24, anzahl: 100 }), spalten }), { z1: 1, z2: 27, s1: 1, s2: 9 });
});
test('masseAusBlatt: Mindestgröße, belegte + 50 Zeilen / + 10 Spalten, eigene Maße, versteckte Zeilen, Ränder', () => {
  const blatt = { id: 'blatt1', zellen: { A1: { w: '1' }, C200: { w: 'x' } }, spalten: { B: { breite: 150 } }, zeilen: { 2: { hoehe: 40 } } };
  const { zeilen, spalten } = masseAusBlatt(blatt, { versteckt: new Set([3]) });
  assert.deepEqual([zeilen.anzahl, spalten.anzahl, zeilen.position(4), spalten.position(3), zeilen.index(70)], [250, 26, 64, 250, 4]);
  const gross = masseAusBlatt({ zellen: { AMJ100000: { w: '1' } }, spalten: {}, zeilen: {} });
  assert.deepEqual([gross.zeilen.anzahl, gross.spalten.anzahl], [100000, 1024]);
  const m = new Masse({ standard: 10, versteckt: new Set([9, 10]), anzahl: 10 });
  assert.deepEqual([m.index(-5), m.index(1000), m.index(m.summe - 1)], [1, 8, 8], 'vor dem Anfang → 1, dahinter → letzte sichtbare');
});
test('bewegen: Rand, Erweitern, Springen wie Excel', () => {
  const aw = auswahlNeu('blatt1', 2, 2);
  assert.deepEqual(bewegen(aw, 'runter').kopf, { z: 3, s: 2 }); assert.deepEqual(bewegen(auswahlNeu('blatt1', 1, 1), 'links').kopf, { z: 1, s: 1 });
  const e = bewegen(aw, 'hoch', { erweitern: true }); assert.deepEqual([e.anker, e.kopf], [{ z: 2, s: 2 }, { z: 1, s: 2 }]);
  const belegt = (z, s) => s === 1 && (z <= 5 || z === 9);
  assert.deepEqual(bewegen(auswahlNeu('blatt1', 1, 1), 'runter', { springen: true, belegt }).kopf, { z: 5, s: 1 });
  assert.deepEqual(bewegen(auswahlNeu('blatt1', 5, 1), 'runter', { springen: true, belegt }).kopf, { z: 9, s: 1 });
  assert.deepEqual(bewegen(auswahlNeu('blatt1', 9, 1), 'runter', { springen: true, belegt }).kopf, { z: 100000, s: 1 });
});
test('Sync-Auswahl hin und zurück', () => {
  const aw = bewegen(auswahlNeu('blatt1', 4, 3), 'hoch', { erweitern: true });
  assert.deepEqual(alsSyncAuswahl(aw), { blatt: 'blatt1', von: 'C3', bis: 'C4' }); assert.deepEqual(bereichVon(ausSyncAuswahl({ blatt: 'blatt1', von: 'C3', bis: 'C4' })), { z1: 3, s1: 3, z2: 4, s2: 3 });
});
test('tasteZuBefehl', () => {
  const T = (e, bearbeitet = false) => tasteZuBefehl({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, ...e }, { bearbeitet });
  assert.deepEqual([T({ key: 'ArrowDown' }), T({ key: 'ArrowUp', shiftKey: true }), T({ key: 'ArrowRight', ctrlKey: true })],
    [{ befehl: 'bewegen', richtung: 'runter', erweitern: false, springen: false }, { befehl: 'bewegen', richtung: 'hoch', erweitern: true, springen: false }, { befehl: 'bewegen', richtung: 'rechts', erweitern: false, springen: true }]);
  assert.deepEqual([T({ key: 'Tab', shiftKey: true }), T({ key: 'Enter' }), T({ key: 'F2' }), T({ key: 'Delete' }), T({ key: 'Backspace' }), T({ key: 'x' })],
    [{ befehl: 'tab', zurueck: true }, { befehl: 'enter', zurueck: false }, { befehl: 'bearbeiten' }, { befehl: 'leeren' }, { befehl: 'leeren' }, { befehl: 'tippen' }]);
  assert.deepEqual([T({ key: 'z', metaKey: true }), T({ key: 'y', ctrlKey: true }), T({ key: 'z', ctrlKey: true, shiftKey: true }), T({ key: 'd', ctrlKey: true }), T({ key: 'b', ctrlKey: true }), T({ key: 'i', metaKey: true }), T({ key: 'a', ctrlKey: true })],
    [{ befehl: 'zurueck' }, { befehl: 'vor' }, { befehl: 'vor' }, { befehl: 'ausfuellen' }, { befehl: 'fett' }, { befehl: 'kursiv' }, { befehl: 'alles' }]);
  assert.deepEqual([T({ key: 'c', ctrlKey: true }), T({ key: 'v', metaKey: true }), T({ key: 'x', ctrlKey: true })], [null, null, null]); // laufen über copy/cut/paste
  assert.deepEqual([T({ key: 'ArrowLeft' }, true), T({ key: 'Enter', shiftKey: true }, true), T({ key: 'Escape' }, true), T({ key: 'Tab' }, true)],
    [null, { befehl: 'enter', zurueck: true }, { befehl: 'abbrechen' }, { befehl: 'tab', zurueck: false }]);
  // Großbuchstabe bei gedrückter Umschalttaste, AltGr (Strg+Alt) tippt Zeichen wie @, Cmd+Wahl ist kein Tippen
  assert.deepEqual([T({ key: 'Z', ctrlKey: true, shiftKey: true }), T({ key: '@', ctrlKey: true, altKey: true }), T({ key: 'Ω', metaKey: true, altKey: true })], [{ befehl: 'vor' }, { befehl: 'tippen' }, null]);
});
test('bewegen: ohne Erweitern ab der aktiven Zelle (Anker), mit Erweitern und Springen ab dem Kopf', () => {
  const aw = bewegen(bewegen(auswahlNeu('blatt1', 2, 2), 'runter', { erweitern: true }), 'runter', { erweitern: true });
  assert.deepEqual(bewegen(aw, 'rechts'), { blatt: 'blatt1', anker: { z: 2, s: 3 }, kopf: { z: 2, s: 3 } });
  const belegt = (z, s) => s === 2 && z <= 6;
  assert.deepEqual(bewegen(aw, 'runter', { erweitern: true, springen: true, belegt }), { blatt: 'blatt1', anker: { z: 2, s: 2 }, kopf: { z: 6, s: 2 } });
  assert.deepEqual(bewegen(auswahlNeu('blatt1', 3, 1024), 'rechts').kopf, { z: 3, s: 1024 }, 'rechter Rand');
  assert.equal(ausSyncAuswahl(null), null); assert.equal(ausSyncAuswahl({ blatt: 'blatt1', von: 'x', bis: 'A1' }), null);
});
