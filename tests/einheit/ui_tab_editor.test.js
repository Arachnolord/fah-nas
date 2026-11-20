// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Tabelle (Plan 06 Aufgabe 18): Editor-Kern – das virtualisierte Raster zeichnet nur den sichtbaren Ausschnitt
// (fixierte erste Zeile in eigener angehefteter Ebene, Formate als Klassen und Farbvariablen), Eingabe in der Zelle und
// der Bearbeitungszeile (deutsche Formeln, ein Formelfehler hält das Bearbeiten offen), der Rechner nach eigenen und
// fremden Änderungen, fremde Auswahl mit Name und Farbe, eigene Auswahl höchstens alle 150 ms an die Sitzung, Handy
// (Tippen wählt, zweites Tippen bearbeitet oben), nur lesen mit Rechtewechsel, Rückgängig, Zwischenablage (TSV und
// eigener Typ), Export xlsx/csv und Aufräumen beim Verlassen.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';
import { mappe, scheinSitzung, editorTesten, zelleText, clipboardAttrappe } from './tab_hilfen.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);

let dom; let tabelle; let editorEinbinden; let _test; let MIME_XLSX;
const offen = [];
before(async () => {
  dom = domAttrappe();
  globalThis.requestAnimationFrame = undefined; // Rückfall des Editors: sofort zeichnen
  const app = await imp('app.js');
  app._test.setzeT((k) => k);
  ({ tabelle } = await imp('gemeinsam', 'sync', 'typen', 'tabelle.js'));
  ({ editorEinbinden, _test } = await imp('office', 'tabelle', 'editor.js'));
  ({ MIME_XLSX } = await imp('office', 'tabelle', 'xlsx.js'));
});
after(() => dom.aufraeumen());
afterEach(() => {
  for (const e of offen.splice(0)) { try { e.verlassen(); } catch { /* schon verlassen */ } }
  document.body.textContent = '';
  document.activeElement = null;
});

const schein = (daten, recht) => scheinSitzung(tabelle, daten, recht);
const einbinden = async (s, ctx) => { const x = await editorTesten(editorEinbinden, s, ctx); offen.push(x.editor); return x; };

test('zeichnet nur sichtbare Zellen', async () => {
  const z = {}; for (let i = 1; i <= 5000; i++) z[`A${i}`] = String(i);
  const { wurzel } = await einbinden(schein(mappe({ blatt1: z })));
  assert.equal(wurzel.querySelectorAll('.ot-zelle').length, 243); // 27 Zeilen × 9 Spalten bei Rückfallgröße 600 × 800
  // Aufbau laut Plan: Leiste, Bearbeitungszeile, Raster, Fokusfalle, Reiter; Köpfe sind keine Zellen
  assert.ok(wurzel.querySelector('.ot-leiste[role="toolbar"]'));
  assert.ok(wurzel.querySelector('.ot-zeile .ot-adresse') && wurzel.querySelector('.ot-zeile input.ot-formel'));
  assert.equal(wurzel.querySelector('.ot-formel').getAttribute('aria-label'), 'office.tab_formel');
  assert.ok(wurzel.querySelector('.ot-raster[role="grid"][tabindex="0"]'));
  assert.ok(wurzel.querySelector('textarea.ot-fokus') && wurzel.querySelector('.ot-reiter'));
  assert.equal(wurzel.querySelectorAll('.ot-kopf-spalte').length, 9);
  assert.equal(wurzel.querySelectorAll('.ot-kopf-zeile').length, 27);
  assert.deepEqual([zelleText(wurzel, 'A27'), zelleText(wurzel, 'A28')], ['27', null]);
  // nach dem Bildlauf (Zeile 1001 oben): 2 Zeilen Puffer davor, 25 sichtbare, 2 danach – Zellen aus dem Vorrat
  const vorher = new Set(wurzel.querySelectorAll('.ot-zelle'));
  const raster = wurzel.querySelector('.ot-raster'); raster.scrollTop = 24 * 1000; _test.ed.neuZeichnen();
  const nachher = wurzel.querySelectorAll('.ot-zelle');
  assert.equal(nachher.length, 29 * 9);
  assert.equal(nachher.filter((x) => vorher.has(x)).length, 243, 'alle alten Zellelemente wiederverwendet');
  assert.deepEqual([zelleText(wurzel, 'A27'), zelleText(wurzel, 'A998'), zelleText(wurzel, 'A999'), zelleText(wurzel, 'A1027'), zelleText(wurzel, 'A1028')], [null, null, '999', '1027', null]);
});

test('Formate: Klassen, Farben als Variablen, Ausrichtung nach Werttyp; fixierte erste Zeile in eigener Ebene', async () => {
  const d = mappe({ blatt1: { A1: ['Kopf', { fett: true, kursiv: true, farbe: '#b42318', hinter: '#fff3a3' }], B1: '12', C1: 'TRUE', D1: '=1/0', E1: ['x', { ausr: 'rechts' }], A2: ['0.5', { zahl: 'prozent' }] } });
  d.blaetter[0].fixiert = { zeilen: 1 };
  const { wurzel } = await einbinden(schein(d));
  const zelle = (adr) => wurzel.querySelector(`.ot-zelle[data-adr="${adr}"]`);
  assert.deepEqual(['ot-fett', 'ot-kursiv', 'ot-ausr-links'].map((k) => zelle('A1').classList.contains(k)), [true, true, true]);
  assert.deepEqual([zelle('A1').style.getPropertyValue('--zf'), zelle('A1').style.getPropertyValue('--zh')], ['#b42318', '#fff3a3']);
  assert.deepEqual(['B1', 'C1', 'D1', 'E1'].map((a) => ['links', 'mitte', 'rechts'].find((r) => zelle(a).classList.contains(`ot-ausr-${r}`))), ['rechts', 'mitte', 'mitte', 'rechts']);
  assert.deepEqual([zelleText(wurzel, 'C1'), zelleText(wurzel, 'D1'), zelleText(wurzel, 'A2')], ['WAHR', '#DIV/0!', '50,00 %']);
  assert.equal(zelle('B2').style.getPropertyValue('--zf'), '');
  // erste Zeile fixiert: sie liegt in der angehefteten Ebene, die übrigen im Körper
  assert.ok(wurzel.querySelector('.ot-fixzeile .ot-zelle[data-adr="A1"]'));
  assert.equal(wurzel.querySelector('.ot-koerper .ot-zelle[data-adr="A1"]'), null);
  assert.ok(wurzel.querySelector('.ot-koerper .ot-zelle[data-adr="A2"]'));
  assert.equal(wurzel.querySelector('.ot-fixzeile').hidden, false);
});

test('Tippen, Enter: zelle-Op, Auswahl rutscht nach unten, Rechner zeigt Ergebnis', async () => {
  const s = schein(mappe({ blatt1: { A2: '2', A3: '=A1+A2' } })); const { wurzel, taste, tippen } = await einbinden(s);
  tippen('1.234,5'); taste('Enter');
  assert.deepEqual(s.ops, [{ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '1234.5' }]);
  assert.deepEqual(_test.ed.aw.kopf, { z: 2, s: 1 }); assert.equal(zelleText(wurzel, 'A3'), '1236,5');
  // Tab übernimmt und geht nach rechts, Esc verwirft
  tippen('7'); taste('Tab'); assert.deepEqual(s.ops.at(-1), { typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: '7' }); assert.deepEqual(_test.ed.aw.kopf, { z: 2, s: 2 });
  tippen('weg'); taste('Escape'); assert.equal(s.ops.length, 2); assert.equal(_test.ed.bearbeitet, false);
  assert.equal(zelleText(wurzel, 'A3'), '1241,5');
});

test('F2 zeigt die Formel deutsch; Formelfehler lässt das Bearbeiten offen', async () => {
  const s = schein(mappe({ blatt1: { A1: '1', A2: '2', A3: '=SUM(A1:A2)' } })); const { wurzel, taste, klick, tippen } = await einbinden(s);
  klick('A3'); taste('F2'); assert.equal(wurzel.querySelector('.ot-formel').value, '=SUMME(A1:A2)');
  assert.deepEqual([_test.ed.bearbeitet, _test.ed.bearbeitOrt], [true, 'zelle']);
  assert.equal(wurzel.querySelector('.ot-zelleingabe').value, '=SUMME(A1:A2)');
  klick('B1'); tippen('=1+'); taste('Enter'); assert.equal(s.ops.length, 0); assert.equal(s.meldungen.at(-1)[0], 'office.tab_formel_fehler'); assert.equal(_test.ed.bearbeitet, true);
  assert.equal(s.meldungen.at(-1)[1], 'fehler');
  // die Bearbeitungszeile zeigt denselben Text wie das Feld in der Zelle
  assert.equal(wurzel.querySelector('.ot-formel').value, '=1+');
});

test('fremde Änderung rechnet nach, fremde Auswahl mit Name und Farbe', async () => {
  const s = schein(mappe({ blatt1: { A1: '1', A2: '2', A3: '=A1+A2' } })); const { wurzel } = await einbinden(s);
  s.fremd({ typ: 'zelle', blatt: 'blatt1', zelle: 'A1', w: '5' }); assert.equal(zelleText(wurzel, 'A3'), '7');
  s.emit('auswahl', { von: 'k2', name: 'Ben', farbe: '#2f7fd1', auswahl: { blatt: 'blatt1', von: 'B2', bis: 'C3' } });
  const f = wurzel.querySelector('.ot-fremd'); assert.equal(f.textContent, 'Ben'); assert.equal(f.style.getPropertyValue('--farbe'), '#2f7fd1');
  // eine fremde Zeile davor verschiebt die eigene Auswahl; wer geht, verliert seinen Rahmen
  _test.ed.auswahlSetzen({ blatt: 'blatt1', anker: { z: 3, s: 1 }, kopf: { z: 3, s: 1 } });
  s.fremd({ typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 2 });
  assert.deepEqual(_test.ed.aw.anker, { z: 5, s: 1 }); assert.equal(zelleText(wurzel, 'A5'), '7');
  s.emit('anwesend', [{ kid: 'k1' }]); assert.equal(wurzel.querySelector('.ot-fremd'), null);
});

test('fremde Auswahl: Namensschild nur 3 s nach jeder Bewegung, der Rahmen bleibt (Bedienprobe 0.21.1)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const s = schein(mappe({ blatt1: { B1: 'Wert' } })); const { wurzel } = await einbinden(s);
  const ben = (zelle) => s.emit('auswahl', { von: 'k2', name: 'Ben', farbe: '#2f7fd1', auswahl: { blatt: 'blatt1', von: zelle, bis: zelle } });
  ben('B2');
  assert.equal(wurzel.querySelector('.ot-fremd-name')?.textContent, 'Ben');
  t.mock.timers.tick(2999); assert.ok(wurzel.querySelector('.ot-fremd-name'), 'kurz nach der Bewegung noch da');
  t.mock.timers.tick(1);
  assert.ok(wurzel.querySelector('.ot-fremd'), 'der Rahmen in Bens Farbe bleibt');
  assert.ok(!wurzel.querySelector('.ot-fremd-name'), 'das Schild verdeckt B1 nicht mehr');
  ben('B2'); // dieselbe Auswahl noch einmal (z. B. nach einer Neuverbindung) bringt das Schild nicht zurück
  assert.ok(!wurzel.querySelector('.ot-fremd-name'));
  ben('B3');
  assert.equal(wurzel.querySelector('.ot-fremd-name')?.textContent, 'Ben', 'jede Bewegung zeigt es wieder');
});

test('eigene Auswahl geht höchstens alle 150 ms an die Sitzung', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const s = schein(mappe({ blatt1: {} })); const { klick } = await einbinden(s);
  assert.deepEqual(s.auswahlen, [{ blatt: 'blatt1', von: 'A1', bis: 'A1' }]);
  klick('B2'); klick('C3', { shiftKey: true });
  assert.equal(s.auswahlen.length, 1, 'innerhalb von 150 ms nichts');
  t.mock.timers.tick(150);
  assert.deepEqual(s.auswahlen.at(-1), { blatt: 'blatt1', von: 'B2', bis: 'C3' });
  assert.equal(s.auswahlen.length, 2);
});

test('Handy: Tippen wählt, zweites Tippen bearbeitet in der Bearbeitungszeile oben', async () => {
  const s = schein(mappe({ blatt1: {} })); const { wurzel, zeiger } = await einbinden(s);
  zeiger('B2', 'touch'); assert.deepEqual(_test.ed.aw.kopf, { z: 2, s: 2 }); assert.equal(_test.ed.bearbeitet, false);
  zeiger('B2', 'touch'); assert.deepEqual([_test.ed.bearbeitet, _test.ed.bearbeitOrt], [true, 'zeile']);
  assert.equal(document.activeElement, wurzel.querySelector('.ot-formel'));
  assert.equal(wurzel.querySelector('.ot-zelleingabe').hidden, true, 'auf dem Handy kein Feld in der Zelle');
});

test('nur lesen: keine Ops, Bearbeitungszeile schreibgeschützt; Rechtewechsel schaltet um', async () => {
  const s = schein(mappe({ blatt1: { A1: '1' } }), 'lesen'); const { wurzel, taste, tippen } = await einbinden(s);
  tippen('x'); taste('Enter'); taste('Delete'); assert.equal(s.ops.length, 0); assert.equal(wurzel.querySelector('.ot-formel').readOnly, true);
  assert.ok(wurzel.classList.contains('ot-nur-lesen'));
  assert.deepEqual(_test.ed.aw.kopf, { z: 2, s: 1 }, 'wählen geht auch beim Lesen');
  s.emit('recht', { recht: 'bearbeiten' }); assert.equal(wurzel.querySelector('.ot-formel').readOnly, false);
  assert.equal(wurzel.classList.contains('ot-nur-lesen'), false);
  taste('Delete'); assert.equal(s.ops.length, 0, 'A2 ist leer');
  taste('ArrowUp'); taste('Delete'); assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: null } } });
});

test('Strg+Z nimmt die eigene Eingabe zurück', async () => {
  const s = schein(mappe({ blatt1: { A1: 'alt' } })); const { tippen, taste } = await einbinden(s);
  tippen('neu'); taste('Enter'); taste('z', { ctrlKey: true });
  assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: 'alt' } } });
  taste('y', { ctrlKey: true }); assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A1: { w: 'neu' } } });
});

test('Rückgängig ganz oder gar nicht: passt ein Teil nach fremden Änderungen nicht mehr, geht nichts hinaus (Prüfbericht I2)', async () => {
  const s = schein(mappe({ blatt1: { A5: 'x', A100000: '=A6' } })); const { taste } = await einbinden(s);
  _test.ed.aendern({ typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 5, anzahl: 1 });
  // fremd: eine Zeile ganz oben – der Rückgängig-Schritt rückt mit, sein Zellteil läge jetzt hinter Zeile 100 000
  s.fremd({ typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 });
  const vorher = s.ops.length;
  taste('z', { ctrlKey: true });
  assert.equal(s.ops.length, vorher, 'kein Teil des Schritts gesendet');
  assert.deepEqual(s.meldungen.at(-1), ['office.tab_rueckgaengig_geht_nicht', 'warnung']);
  assert.equal(_test.ed.verlauf.kannZurueck, true);
});

test('Filter wandert mit: Spalte davor eingefügt, Filterspalte gelöscht (Prüfbericht I4)', async () => {
  const s = schein(mappe({ blatt1: { A1: 'Name', B1: 'Ort', A2: 'a', B2: 'Bern', A3: 'b', B3: 'Ulm', A4: 'c', B4: 'Rom' } }));
  const { wurzel } = await einbinden(s);
  _test.ed.filterSetzen('blatt1', { spalte: 2, erlaubt: new Set(['Bern', 'Ulm']) });
  assert.deepEqual(['A2', 'A3', 'A4'].map((a) => zelleText(wurzel, a)), ['a', 'b', null]);
  s.fremd({ typ: 'spalten_einfuegen', blatt: 'blatt1', ab: 1, anzahl: 1 });
  assert.equal(_test.ed.filter.get('blatt1').spalte, 3);
  assert.deepEqual(['B2', 'B3', 'B4'].map((a) => zelleText(wurzel, a)), ['a', 'b', null]);
  _test.ed.aendern({ typ: 'spalten_loeschen', blatt: 'blatt1', ab: 3, anzahl: 1 });
  assert.equal(_test.ed.filter.has('blatt1'), false);
  assert.equal(zelleText(wurzel, 'B4'), 'c');
});

test('Filter als Schnappschuss: neue und geänderte Zeilen bleiben sichtbar, bis er neu gesetzt wird (Prüfbericht I4)', async () => {
  const s = schein(mappe({ blatt1: { A1: 'Ort', A2: 'Bern', A3: 'Rom', A4: 'Ulm' } }));
  const { wurzel } = await einbinden(s);
  _test.ed.filterSetzen('blatt1', { spalte: 1, erlaubt: new Set(['Bern', 'Ulm']) });
  assert.deepEqual(['A2', 'A3', 'A4'].map((a) => zelleText(wurzel, a)), ['Bern', null, 'Ulm']);
  _test.ed.aendern({ typ: 'zelle', blatt: 'blatt1', zelle: 'B5', w: 'neu' }); // neue Zeile, Filterspalte noch leer
  _test.ed.aendern({ typ: 'zelle', blatt: 'blatt1', zelle: 'A2', w: 'Paris' }); // Wert in der Filterspalte geändert
  assert.deepEqual([zelleText(wurzel, 'B5'), zelleText(wurzel, 'A2')], ['neu', 'Paris']);
  s.fremd({ typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 2, anzahl: 1 }); // die ausgeblendete Zeile wandert mit
  assert.deepEqual(['A3', 'A4', 'A5', 'B6'].map((a) => zelleText(wurzel, a)), ['Paris', null, 'Ulm', 'neu']);
  _test.ed.filterSetzen('blatt1', { spalte: 1, erlaubt: new Set(['Bern', 'Ulm']) }); // neu gesetzt: jetzt gilt der neue Stand
  assert.deepEqual(['A3', 'A4', 'A5', 'B6'].map((a) => zelleText(wurzel, a)), [null, null, 'Ulm', null]);
});

test('eigene Änderung durch gleichzeitiges Löschen weggefallen: Meldung (Prüfbericht I6)', async () => {
  const s = schein(mappe({ blatt1: { A1: '1' } })); await einbinden(s);
  s.emit('verworfen', { ops: [{ typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 3, anzahl: 1 }, { typ: 'zelle', blatt: 'blatt1', zelle: 'A3', w: 'neu' }] });
  assert.deepEqual(s.meldungen, [['office.tab_weggefallen', 'warnung']]);
  // eine eigene Löschung, die die fremde schon erledigt hat, ist nicht verloren: keine Meldung
  s.emit('verworfen', { ops: [{ typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 3, anzahl: 1 }] });
  assert.equal(s.meldungen.length, 1);
});

test('Zwischenablage: copy schreibt TSV und internes Format, paste fügt TSV ein', async () => {
  const s = schein(mappe({ blatt1: { A1: '2', B1: '=A1*2' } })); const { wurzel, klick, ereignis } = await einbinden(s);
  klick('A1'); klick('B1', { shiftKey: true }); const cd = clipboardAttrappe(); ereignis('copy', { clipboardData: cd });
  assert.deepEqual([cd.daten['text/plain'], JSON.parse(cd.daten['application/x-fah-tabelle']).quelle], ['2\t4\r\n', { z: 1, s: 1 }]);
  klick('A5'); ereignis('paste', { clipboardData: clipboardAttrappe({ 'text/plain': 'x\ty' }) });
  assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A5: { w: 'x' }, B5: { w: 'y' } } });
  // das interne Format geht vor: die Formel wandert relativ mit
  klick('A7'); ereignis('paste', { clipboardData: cd });
  assert.equal(s.ops.at(-1).werte.B7.w, '=A7*2');
  // Ausschneiden leert sofort
  klick('A5'); klick('B5', { shiftKey: true }); const cd2 = clipboardAttrappe(); const ev = ereignis('cut', { clipboardData: cd2 });
  assert.equal(ev.defaultPrevented, true); assert.equal(cd2.daten['text/plain'], 'x\ty\r\n');
  assert.deepEqual(s.ops.at(-1), { typ: 'zellen', blatt: 'blatt1', werte: { A5: { w: null }, B5: { w: null } } });
  assert.equal(wurzel.querySelector('.ot-adresse').textContent, 'A5:B5');
});

test('Export: xlsx und csv', async () => {
  const { editor } = await einbinden(schein(mappe({ blatt1: { A1: 'Ä', B1: '1.5' } })));
  assert.deepEqual(editor.exportformate.map((f) => f.id), ['xlsx', 'csv']);
  assert.deepEqual(editor.exportformate.map((f) => f.titel), ['office.tab_export_xlsx', 'office.tab_export_csv']);
  const x = await editor.exportieren('xlsx'); assert.deepEqual([x.name, x.blob.type], ['Budget.xlsx', MIME_XLSX]);
  const c = await editor.exportieren('csv'); assert.equal(c.name, 'Budget.csv'); assert.equal(c.blob.type, 'text/csv;charset=utf-8');
  // Blob.text() verschluckt die BOM (UTF-8-Dekodieren) – daher die Bytes mit ignoreBOM lesen
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await c.blob.arrayBuffer()), '﻿Ä;1,5\r\n');
  // mehrere Blätter: der Name nennt das aktuelle Blatt
  const zwei = await einbinden(schein(mappe({ blatt1: { A1: '1' }, blatt2: { A1: '2' } })));
  assert.equal((await zwei.editor.exportieren('csv')).name, 'Budget - Tabelle1.csv');
  await assert.rejects(zwei.editor.exportieren('pdf'), /kein_export/);
});

test('verlassen meldet Hörer ab und stoppt den 60-s-Takt', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = schein(mappe({ blatt1: { A1: '=JETZT()' } })); const { behaelter, editor } = await einbinden(s);
  let neu = 0; const rechner = _test.ed.rechner; const echt = rechner.volatileNeu.bind(rechner);
  rechner.volatileNeu = (d) => { neu++; return echt(d); };
  t.mock.timers.tick(60_000); assert.equal(neu, 1, 'der Takt rechnet HEUTE/JETZT neu');
  assert.ok(s.hoererZahl() > 0);
  editor.verlassen();
  assert.equal(s.hoererZahl(), 0); assert.equal(behaelter.querySelector('.ot-editor'), null);
  t.mock.timers.tick(180_000); assert.equal(neu, 1);
});
