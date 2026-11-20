// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sync-Klient (Browser) und offenes Dokument (Server) nach Jupiter-Art (Plan 04, Aufgabe 8, V12): eine Op unterwegs,
// Puffer mit Zusammensetzen, fremde Ops gegen Unbestätigtes transformiert, Wiederaufnahme nach Abbruch; der Server
// ordnet zentral, transformiert gegen den Verlauf seit der Basis, erkennt Doppel und behält Ungespeichertes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { board } = await import(pathToFileURL(path.join(SYNC, 'typen', 'board.js')).href);
const { SyncKlient } = await import(pathToFileURL(path.join(SYNC, 'klient.js')).href);

const SETZ = (id, felder) => ({ typ: 'karte_setzen', id, felder });
const KARTE = { id: 'k1aaaa', spalte: 'todo00', pos: 'i', titel: 'Start', erstellt: '2026-10-18T08:00:00.000Z', ersteller: 'anna' };
const MIT_KARTE = board.anwenden(board.leer(), { typ: 'karte_neu', karte: KARTE });
const META = { id: 'oAAAAAAAAAAAAAAAA', art: 'board', name: 'Plan', freigabe: 'team', pfad: 'Plan.fahboard', besitzer: 'anna', schnappschuesse: false };
let aus;
beforeEach(() => { aus = []; });
const klient = (daten = MIT_KARTE, version = 0) => new SyncKlient({ typ: board, version, daten, senden: (m) => aus.push(m), cidVorsilbe: 'x' });

test('lokal sendet einmal, puffert danach und setzt zusammen', () => {
  const k = klient(board.leer());
  const ereignisse = []; k.on('aenderung', (e) => ereignisse.push(e)); k.on('bestaetigt', (e) => ereignisse.push(['b', e.version]));
  k.lokal(SETZ('k1aaaa', { titel: 'a' })); k.lokal(SETZ('k1aaaa', { titel: 'b' })); k.lokal(SETZ('k1aaaa', { titel: 'c' }));
  assert.equal(aus.length, 1); assert.deepEqual([aus[0].art, aus[0].basis, aus[0].cid], ['op', 0, 'x-1']); assert.equal(k.ausstehend, 2);
  k.empfangen({ art: 'op', version: 1, cid: 'x-1', op: aus[0].op });
  assert.deepEqual([aus[1].basis, aus[1].cid, aus[1].op.felder.titel], [1, 'x-2', 'c']);
  assert.equal(k.version, 1); assert.equal(k.ausstehend, 1);
  assert.deepEqual(ereignisse.at(-1), ['b', 1]);
  assert.equal(ereignisse.filter((e) => e.lokal).length, 3);
  assert.throws(() => k.lokal({ typ: 'karte_setzen', id: 'k1aaaa', felder: { boese: 1 } }), (e) => e.code === 'E_PARAMS', 'lokal prüft');
});

test('fremde Op wird gegen Unbestätigtes transformiert', () => {
  const k = klient();
  const aenderungen = []; k.on('aenderung', (e) => { if (!e.lokal) aenderungen.push(e.op); });
  k.lokal(SETZ('k1aaaa', { titel: 'mein' }));
  k.lokal(SETZ('k1aaaa', { faellig: '2026-10-20' }));
  k.empfangen({ art: 'op', version: 1, cid: 'y-1', op: SETZ('k1aaaa', { titel: 'fremd', faellig: null, archiviert: true }) });
  assert.equal(k.daten.karten.k1aaaa.titel, 'mein', 'eigene (spätere) gewinnt');
  assert.equal(k.daten.karten.k1aaaa.faellig, '2026-10-20');
  assert.equal(k.daten.karten.k1aaaa.archiviert, true, 'fremdes Feld kommt an');
  assert.deepEqual(aenderungen, [SETZ('k1aaaa', { archiviert: true })], 'nur der nicht überdeckte Teil wird angewandt');
  assert.equal(k.version, 1);
  k.empfangen({ art: 'op', version: 2, cid: 'x-1', op: aus[0].op });
  assert.deepEqual([aus[1].basis, aus[1].op], [2, SETZ('k1aaaa', { faellig: '2026-10-20' })]);
  assert.equal(k.daten.karten.k1aaaa.titel, 'mein');
});

test('Klient und Server kommen zum selben Ergebnis (zwei Klienten, gleichzeitige Ops)', () => {
  const server = new OffenesDokument({ meta: META, typ: board, version: 0, daten: MIT_KARTE, stand: 'S0' });
  const postfach = { a: [], b: [] };
  const a = new SyncKlient({ typ: board, version: 0, daten: MIT_KARTE, senden: (m) => postfach.a.push(m), cidVorsilbe: 'a' });
  const b = new SyncKlient({ typ: board, version: 0, daten: MIT_KARTE, senden: (m) => postfach.b.push(m), cidVorsilbe: 'b' });
  const ausliefern = (eintrag) => { for (const k of [a, b]) k.empfangen({ art: 'op', version: eintrag.v, cid: eintrag.cid, op: eintrag.op }); };
  a.lokal(SETZ('k1aaaa', { titel: 'A1' })); a.lokal({ typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'm' });
  b.lokal(SETZ('k1aaaa', { titel: 'B1', beschreibung: 'b' })); b.lokal({ typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'fertig', pos: 'c' });
  // Server bekommt b zuerst, dann a – Auslieferung in Server-Reihenfolge, Puffer fließen nach
  for (let runde = 0; runde < 6; runde++) {
    for (const wer of ['b', 'a']) {
      const m = postfach[wer].shift();
      if (m) ausliefern(server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: wer === 'a' ? 'anna' : 'ben' }));
    }
  }
  assert.equal(a.ausstehend, 0); assert.equal(b.ausstehend, 0);
  assert.deepEqual(a.daten, server.daten); assert.deepEqual(b.daten, server.daten);
  assert.deepEqual([a.version, b.version], [server.version, server.version]);
});

test('wiederaufgenommen: eigene cid im Verlauf zählt als Bestätigung, Rest wird neu gesendet', () => {
  const k = klient();
  k.lokal(SETZ('k1aaaa', { titel: 'mein' })); k.lokal(SETZ('k1aaaa', { beschreibung: 'puffer' }));
  k.wiederaufnehmen();
  assert.deepEqual(aus.at(-1), { art: 'wiederaufnehmen', version: 0 });
  k.empfangen({ art: 'wiederaufgenommen', kid: 'k9', version: 2, ops: [{ v: 1, op: SETZ('k1aaaa', { titel: 'fremd', archiviert: true }), cid: 'y-1' }, { v: 2, op: SETZ('k1aaaa', { titel: 'mein' }), cid: 'x-1' }] });
  assert.equal(k.version, 2);
  assert.deepEqual([aus.at(-1).art, aus.at(-1).basis, aus.at(-1).cid, aus.at(-1).op], ['op', 2, 'x-2', SETZ('k1aaaa', { beschreibung: 'puffer' })], 'Puffer folgt der Bestätigung');
  assert.equal(aus.filter((m) => m.cid === 'x-2').length, 1, 'nachrückende Op nur einmal gesendet');
  assert.deepEqual([k.daten.karten.k1aaaa.titel, k.daten.karten.k1aaaa.archiviert], ['mein', true]);
  // Server hatte die eigene Op nicht: sie geht mit gleicher cid und neuer Basis noch einmal hinaus
  aus = [];
  const k2 = klient();
  k2.lokal(SETZ('k1aaaa', { titel: 'nochmal' }));
  k2.wiederaufnehmen();
  k2.empfangen({ art: 'wiederaufgenommen', kid: 'k9', version: 1, ops: [{ v: 1, op: SETZ('k1aaaa', { beschreibung: 'x' }), cid: 'y-1' }] });
  assert.deepEqual([aus.at(-1).art, aus.at(-1).basis, aus.at(-1).cid], ['op', 1, 'x-1']);
  // Fehler zur eigenen Op oder neu_laden vom Server → neu_laden
  const k3 = klient(); const gruende = []; k3.on('neu_laden', (e) => gruende.push(e.grund));
  k3.lokal(SETZ('k1aaaa', { titel: 'x' }));
  k3.empfangen({ art: 'fehler', cid: 'x-1', fehler: { code: 'E_RECHTE', meldung: 'nein' } });
  k3.empfangen({ art: 'neu_laden', grund: 'zu_alt' });
  assert.deepEqual(gruende, ['fehler', 'zu_alt']);
});

test('doppelte Bestätigung nach Wiederaufnahme wird nicht ein zweites Mal angewandt', () => {
  const k = klient();
  k.wiederaufnehmen();
  k.lokal(SETZ('k1aaaa', { titel: 'X' })); // nach dem Wiederverbinden gesendet
  k.empfangen({ art: 'wiederaufgenommen', version: 1, ops: [{ v: 1, op: SETZ('k1aaaa', { beschreibung: 'F' }), cid: 'y-1' }] });
  k.empfangen({ art: 'op', version: 2, cid: 'x-1', op: SETZ('k1aaaa', { titel: 'X' }) });
  k.empfangen({ art: 'op', version: 3, cid: 'y-2', op: SETZ('k1aaaa', { titel: 'Y' }) });
  k.empfangen({ art: 'op', version: 2, cid: 'x-1', op: SETZ('k1aaaa', { titel: 'X' }) }); // Antwort des Servers auf das vorsorgliche zweite Senden
  assert.deepEqual([k.daten.karten.k1aaaa.titel, k.version, k.ausstehend], ['Y', 3, 0]);
});

test('Server: opAnnehmen transformiert gegen Verlauf seit basis, zählt hoch, erkennt Doppel', () => {
  const d = new OffenesDokument({ meta: META, typ: board, version: 0, daten: null, stand: 'S0' });
  assert.deepEqual(d.daten, board.leer(), 'null → typ.leer()');
  d.opAnnehmen({ basis: 0, cid: 'a-1', op: SETZ('k1aaaa', { titel: 'A' }), nutzer: 'anna' });
  const r = d.opAnnehmen({ basis: 0, cid: 'b-1', op: SETZ('k1aaaa', { titel: 'B', faellig: null }), nutzer: 'ben' });
  assert.deepEqual([r.v, r.doppelt], [2, false]);
  assert.deepEqual(d.opAnnehmen({ basis: 0, cid: 'a-1', op: SETZ('k1aaaa', { titel: 'A' }), nutzer: 'anna' }), { v: 1, op: SETZ('k1aaaa', { titel: 'A' }), cid: 'a-1', doppelt: true });
  assert.throws(() => d.opAnnehmen({ basis: 5, cid: 'c', op: SETZ('k1aaaa', {}), nutzer: 'anna' }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => d.opAnnehmen({ basis: -1, cid: 'c', op: SETZ('k1aaaa', { titel: 'x' }), nutzer: 'anna' }), (e) => e.code === 'E_PARAMS');
  const s = new OffenesDokument({ meta: META, typ: board, version: 0, daten: MIT_KARTE, stand: 'S0' });
  s.opAnnehmen({ basis: 0, cid: 'a-1', op: SETZ('k1aaaa', { titel: 'A' }), nutzer: 'anna' });
  const spaet = s.opAnnehmen({ basis: 0, cid: 'b-1', op: SETZ('k1aaaa', { titel: 'B' }), nutzer: 'ben' });
  assert.deepEqual(spaet.op, SETZ('k1aaaa', { titel: 'B' }), 'spätere gewinnt');
  assert.equal(s.daten.karten.k1aaaa.titel, 'B');
  assert.equal(d.meta, META);
});

test('opsSeit: zu alt → null; ungespeichert/gespeichert', () => {
  const d = new OffenesDokument({ meta: META, typ: board, version: 0, daten: MIT_KARTE, stand: 'S0', verlauf_max: 3 });
  for (let i = 1; i <= 5; i++) d.opAnnehmen({ basis: i - 1, cid: `a-${i}`, op: SETZ('k1aaaa', { titel: `T${i}` }), nutzer: 'anna' });
  assert.equal(d.ungespeichert().length, 5, 'Ungespeichertes bleibt trotz verlauf_max');
  assert.equal(d.opsSeit(0).length, 5);
  d.gespeichert(5, 'S1');
  assert.deepEqual([d.ungespeichert().length, d.stand], [0, 'S1']);
  assert.equal(d.opsSeit(0), null, 'zu alt');
  assert.deepEqual(d.opsSeit(3).map((e) => e.v), [4, 5]);
  assert.deepEqual(d.opsSeit(5), []);
  assert.throws(() => d.opAnnehmen({ basis: 1, cid: 'z-1', op: SETZ('k1aaaa', { titel: 'alt' }), nutzer: 'anna' }), (e) => e.code === 'E_GEAENDERT');
  const geladen = new OffenesDokument({ meta: META, typ: board, version: 7, daten: MIT_KARTE, stand: 'S7', verlauf: [{ v: 6, op: SETZ('k1aaaa', { titel: 'x' }), cid: 'q-1' }, { v: 7, op: SETZ('k1aaaa', { titel: 'y' }), cid: 'q-2' }] });
  assert.deepEqual(geladen.opsSeit(5).map((e) => e.v), [6, 7]); assert.equal(geladen.opsSeit(4), null); assert.equal(geladen.ungespeichert().length, 0);
});

test('autorPruefen und pruefen werden vom Server gerufen', () => {
  const d = new OffenesDokument({ meta: META, typ: board, version: 0, daten: MIT_KARTE, stand: 'S0' });
  assert.throws(() => d.opAnnehmen({ basis: 0, cid: 'a-1', op: { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: 'c1aaaa', wer: 'ben', name: 'Ben', zeit: '2026-10-18T09:00:00.000Z', text: 'x' } }, nutzer: 'anna' }), (e) => e.code === 'E_RECHTE');
  assert.throws(() => d.opAnnehmen({ basis: 0, cid: 'a-2', op: { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'x'.repeat(201) } }, nutzer: 'anna' }), (e) => e.code === 'E_PARAMS');
  assert.equal(d.version, 0, 'nichts angenommen');
});

test('Puffer: durch fremde Ops leer gewordene Änderungen werden nicht gesendet (Plan 05 A4)', () => {
  const k = klient();
  k.lokal(SETZ('k1aaaa', { titel: 'eins' }));                     // unterwegs
  k.lokal({ typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'i' }); // im Puffer
  // jemand anderes löscht die Karte: die Op im Puffer wird zum noop
  k.empfangen({ art: 'op', version: 1, cid: 'fremd-1', op: { typ: 'karte_loeschen', id: 'k1aaaa' } });
  assert.equal(aus.length, 1);
  k.empfangen({ art: 'op', version: 2, cid: 'x-1', op: { typ: 'noop' } }); // Bestätigung der ersten (vom Server zum noop transformiert)
  assert.equal(aus.length, 1, 'noop aus dem Puffer wird nicht gesendet');
  assert.equal(k.ausstehend, 0);
  // Wiederaufnahme: eine unterwegs leer gewordene Op wird nicht erneut gesendet, sondern verworfen
  const k2 = klient(MIT_KARTE, 0);
  k2.lokal(SETZ('k1aaaa', { titel: 'zwei' }));
  const vorher = aus.length;
  k2.empfangen({ art: 'wiederaufgenommen', version: 1, ops: [{ v: 1, op: { typ: 'karte_loeschen', id: 'k1aaaa' }, cid: 'fremd-2' }] });
  assert.equal(aus.length, vorher, 'nichts erneut gesendet');
  assert.equal(k2.ausstehend, 0);
  // lokal mit einer Op ohne Wirkung sendet nichts
  const k3 = klient();
  k3.lokal({ typ: 'noop' });
  assert.equal(k3.ausstehend, 0);
});

test('fremde Op macht eigene Änderungen wirkungslos: ein Ereignis „verworfen“ mit den ursprünglichen Ops (Prüfbericht Plan 06, I6)', () => {
  const k = klient();
  const weg = []; k.on('verworfen', (e) => weg.push(e));
  const eins = SETZ('k1aaaa', { titel: 'eins' }), zwei = { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'i' };
  k.lokal(eins); k.lokal(zwei);
  k.empfangen({ art: 'op', version: 1, cid: 'fremd-1', op: SETZ('k1aaaa', { titel: 'x' }) });
  assert.deepEqual(weg, [], 'nichts verworfen, solange die eigenen Ops wirken');
  k.empfangen({ art: 'op', version: 2, cid: 'fremd-2', op: { typ: 'karte_loeschen', id: 'k1aaaa' } });
  assert.deepEqual(weg, [{ ops: [eins, zwei] }]);
});
