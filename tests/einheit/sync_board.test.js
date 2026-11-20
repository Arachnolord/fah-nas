// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „board“ des Sync-Motors (Plan 04, Aufgabe 7, V12): anwenden ohne Mutation, Transformation (TP1: beide
// Reihenfolgen ergeben dasselbe), Löschen gewinnt, Felder „spätere gewinnt“, zusammensetzen, Prüfung der Ops, Autor,
// Bruchindex „zwischen“, Auswahl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { board, ETIKETT_FARBEN, OP_TYPEN, zwischen, sortiert } = await import(pathToFileURL(path.join(SYNC, 'typen', 'board.js')).href);
const { TYPEN } = await import(pathToFileURL(path.join(SYNC, 'typen', 'index.js')).href);
const { SyncFehler } = await import(pathToFileURL(path.join(SYNC, 'fehler.js')).href);
const konst = await import(pathToFileURL(path.join(SYNC, 'konstanten.js')).href);
const office = await import(pathToFileURL(path.join(HIER, '..', '..', 'src', 'gemeinsam', 'office.js')).href);

const T = (a, b, s) => board.transformiere(a, b, s);
const A = (d, op) => board.anwenden(d, op);
/** TP1: beide Reihenfolgen ergeben dieselben Daten. */
function tp1(d, a, b) { assert.deepEqual(A(A(d, a), T(b, a, 'rechts')), A(A(d, b), T(a, b, 'links')), `${a.typ} ↔ ${b.typ}`); }

const KARTE = Object.freeze({ id: 'k1aaaa', spalte: 'todo00', pos: 'i', titel: 'Erste', beschreibung: '', zustaendig: [], faellig: null, etiketten: [], checkliste: [], kommentare: [], anhaenge: [], archiviert: false, erstellt: '2026-10-18T08:00:00.000Z', ersteller: 'anna' });
const KOMM = Object.freeze({ id: 'c1aaaa', wer: 'anna', name: 'Anna', zeit: '2026-10-18T09:00:00.000Z', text: 'Hallo' });
const BOARD = A(A(board.leer(), { typ: 'karte_neu', karte: KARTE }), { typ: 'karte_neu', karte: { ...KARTE, id: 'k2aaaa', pos: 'r', titel: 'Zweite' } });

test('leer, Typ-Register, Konstanten, Farben, Op-Typen', () => {
  assert.deepEqual(board.leer(), { spalten: [{ id: 'todo00', titel: 'Zu erledigen', pos: 'i' }, { id: 'doing0', titel: 'In Arbeit', pos: 'r' }, { id: 'fertig', titel: 'Erledigt', pos: 'v' }], karten: {}, etiketten: {} });
  assert.equal(TYPEN.board, board); assert.equal(board.name, 'board');
  assert.deepEqual([...ETIKETT_FARBEN], ['rot', 'orange', 'gelb', 'gruen', 'tuerkis', 'blau', 'lila', 'grau']);
  assert.equal(OP_TYPEN.length, 13); assert.ok(OP_TYPEN.includes('noop'));
  assert.equal(konst.DATEI_MUSTER.source, office.DATEI_MUSTER.source, 'gleiches Muster wie src/gemeinsam/office.js');
  assert.equal(konst.DATEI_MAX_BYTES, office.DATEI_MAX_BYTES);
});

test('karte_setzen: spätere gewinnt je Feld (TP1)', () => {
  const a = { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'A', faellig: '2026-10-20' } };
  const b = { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'B' } };
  assert.deepEqual(T(a, b, 'links'), { typ: 'karte_setzen', id: 'k1aaaa', felder: { faellig: '2026-10-20' } });
  assert.deepEqual(T(a, b, 'rechts'), a);
  tp1(BOARD, a, b); assert.equal(A(A(BOARD, b), T(a, b, 'links')).karten.k1aaaa.titel, 'B');
  assert.equal(board.istNoop(T({ typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'A' } }, b, 'links')), true, 'leer → noop');
});

test('Ops auf gelöschte Karten werden Noops', () => {
  for (const op of [{ typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'x' } }, { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'm' }, { typ: 'kommentar', karte: 'k1aaaa', kommentar: KOMM },
    { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', text: 'x', pos: 'i', neu: true } }, { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'AAAAAAAAAAAA-a.pdf', name: 'a.pdf', groesse: 1, mime: 'application/pdf' } }]) {
    assert.equal(board.istNoop(T(op, { typ: 'karte_loeschen', id: 'k1aaaa' }, 'rechts')), true, op.typ);
    assert.equal(board.istNoop(T(op, { typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa'] }, 'links')), true, op.typ);
    tp1(BOARD, op, { typ: 'karte_loeschen', id: 'k1aaaa' });
  }
  assert.equal(A(BOARD, { typ: 'karte_setzen', id: 'kXXXXX', felder: { titel: 'x' } }), BOARD, 'fehlende Karte: unverändert');
});

test('Spalte löschen: aufgeführte Karten weg (auch wenn gleichzeitig verschoben), neue Karte bleibt verwaist', () => {
  const del = { typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa'] };
  const mv = { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'm' };
  assert.equal(board.istNoop(T(mv, del, 'rechts')), true); tp1(BOARD, del, mv);
  const neu = { typ: 'karte_neu', karte: { ...KARTE, id: 'k9aaaa', spalte: 'todo00' } };
  tp1(BOARD, del, neu);
  assert.equal(A(A(BOARD, del), neu).karten.k9aaaa.spalte, 'todo00'); // Daten behalten die Spalte; die Ansicht zeigt sie in der ersten (Aufgabe 14)
  assert.deepEqual(A(BOARD, del).spalten.map((s) => s.id), ['doing0', 'fertig']);
  assert.ok(!A(BOARD, del).karten.k1aaaa && A(BOARD, del).karten.k2aaaa, 'nur aufgeführte Karten weg');
  for (const op of [{ typ: 'spalte_setzen', id: 'todo00', titel: 'Neu' }, { typ: 'spalte_verschieben', id: 'todo00', pos: 'z' }]) {
    assert.equal(board.istNoop(T(op, del, 'rechts')), true, op.typ); tp1(BOARD, op, del);
  }
  tp1(BOARD, del, { typ: 'spalte_loeschen', id: 'todo00', karten: ['k2aaaa'] });
  tp1(BOARD, { typ: 'karte_verschieben', id: 'k2aaaa', spalte: 'todo00', pos: 'z' }, del);
});

test('Verschieben: spätere gewinnt; Spalten bleiben nach (pos, id) sortiert', () => {
  const a = { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'm' };
  const b = { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'fertig', pos: 'c' };
  assert.equal(board.istNoop(T(a, b, 'links')), true); assert.deepEqual(T(a, b, 'rechts'), a); tp1(BOARD, a, b);
  const sa = { typ: 'spalte_verschieben', id: 'fertig', pos: '0' };
  tp1(BOARD, sa, { typ: 'spalte_verschieben', id: 'fertig', pos: 'z' });
  assert.deepEqual(A(BOARD, sa).spalten.map((s) => s.id), ['fertig', 'todo00', 'doing0']);
  tp1(BOARD, { typ: 'spalte_setzen', id: 'doing0', titel: 'A' }, { typ: 'spalte_setzen', id: 'doing0', titel: 'B' });
  tp1(BOARD, a, { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'Neu' } });
  const neu = { typ: 'spalte_neu', spalte: { id: 's9aaaa', titel: 'Später', pos: 'x' } };
  tp1(BOARD, neu, sa);
  assert.deepEqual(sortiert([{ id: 'b', pos: 'i' }, { id: 'a', pos: 'i' }, { id: 'c', pos: '0' }]).map((x) => x.id), ['c', 'a', 'b']);
});

test('Kommentare und Checkliste konvergieren in der Reihenfolge', () => {
  const k1 = { typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, id: 'bbbbbb' } };
  const k2 = { typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, id: 'aaaaaa', wer: 'ben', name: 'Ben' } };
  tp1(BOARD, k1, k2);
  assert.deepEqual(A(A(BOARD, k1), k2).karten.k1aaaa.kommentare.map((k) => k.id), ['aaaaaa', 'bbbbbb'], 'gleiche Zeit → nach id');
  const p1 = { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', text: 'Eins', pos: 'm', neu: true } };
  const p2 = { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p2aaaa', text: 'Zwei', pos: 'c', neu: true } };
  tp1(BOARD, p1, p2);
  const mit = A(A(BOARD, p1), p2);
  assert.deepEqual(mit.karten.k1aaaa.checkliste, [{ id: 'p2aaaa', text: 'Zwei', erledigt: false, pos: 'c' }, { id: 'p1aaaa', text: 'Eins', erledigt: false, pos: 'm' }]);
  const weg = { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', weg: true } };
  const text = { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', text: 'Geändert', erledigt: true } };
  assert.equal(board.istNoop(T(text, weg, 'rechts')), true, 'weg gewinnt');
  tp1(mit, weg, text); tp1(mit, text, weg);
  assert.equal(A(A(mit, weg), T(text, weg, 'rechts')).karten.k1aaaa.checkliste.length, 1);
  const t2 = { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', erledigt: false, text: 'B' } };
  tp1(mit, text, t2);
  assert.deepEqual(A(mit, { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'pXXXXX', text: 'x' } }), mit, 'ohne neu auf fehlende ID → nichts');
});

test('kommentar weg nur für den eigenen', () => {
  const mit = A(BOARD, { typ: 'kommentar', karte: 'k1aaaa', kommentar: KOMM });
  assert.deepEqual(A(mit, { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: 'c1aaaa', wer: 'ben', weg: true } }), mit);
  assert.deepEqual(A(mit, { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: 'c1aaaa', wer: 'anna', weg: true } }).karten.k1aaaa.kommentare, []);
});

test('Etiketten und Anhänge: setzen je Feld, Löschen gewinnt, Anhänge nach Name', () => {
  const e1 = { typ: 'etikett', id: 'e1aaaa', etikett: { name: 'Wichtig', farbe: 'rot' } };
  const e2 = { typ: 'etikett', id: 'e1aaaa', etikett: { farbe: 'blau' } };
  tp1(BOARD, e1, e2);
  assert.deepEqual(A(A(BOARD, e1), T(e2, e1, 'rechts')).etiketten.e1aaaa, { name: 'Wichtig', farbe: 'blau' });
  const ew = { typ: 'etikett', id: 'e1aaaa', etikett: { weg: true } };
  const mitE = A(BOARD, e1);
  assert.equal(board.istNoop(T(e2, ew, 'links')), true); tp1(mitE, ew, e2);
  const zuweisen = { typ: 'karte_setzen', id: 'k1aaaa', felder: { etiketten: ['e1aaaa'] } };
  tp1(mitE, ew, zuweisen);
  const an1 = { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'BBBBBBBBBBBB-z.pdf', name: 'z.pdf', groesse: 1, mime: 'application/pdf' } };
  const an2 = { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'AAAAAAAAAAAA-a.pdf', name: 'a.pdf', groesse: 2, mime: 'application/pdf' } };
  tp1(BOARD, an1, an2);
  assert.deepEqual(A(A(BOARD, an1), an2).karten.k1aaaa.anhaenge.map((x) => x.name), ['a.pdf', 'z.pdf']);
  const anWeg = { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'BBBBBBBBBBBB-z.pdf', weg: true } };
  tp1(A(BOARD, an1), anWeg, an1);
});

test('zusammensetzen', () => {
  assert.deepEqual(board.zusammensetzen({ typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'a' } }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'b', archiviert: true } }),
    { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'b', archiviert: true } });
  assert.equal(board.zusammensetzen({ typ: 'karte_neu', karte: KARTE }, { typ: 'karte_loeschen', id: KARTE.id }), null);
  assert.equal(board.zusammensetzen({ typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'a' } }, { typ: 'karte_setzen', id: 'k2aaaa', felder: { titel: 'b' } }), null);
  assert.deepEqual(board.zusammensetzen({ typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'a' }, { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'fertig', pos: 'b' }),
    { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'fertig', pos: 'b' });
});

test('pruefen: Grenzen, Muster, unbekannte Typen und Felder → SyncFehler E_PARAMS', () => {
  for (const op of [{ typ: 'xyz' }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'x'.repeat(201) } }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { boese: 1 } },
    { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'A' }, { typ: 'etikett', id: 'e1aaaa', etikett: { name: 'x', farbe: 'pink' } },
    { typ: 'karte_setzen', id: 'k1aaaa', felder: { faellig: '18.10.2026' } }, { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: '../x', name: 'x', groesse: 1, mime: 'a/b' } },
    { typ: 'karte_setzen', id: 'k!', felder: { titel: 'x' } }, { typ: 'karte_setzen', id: 'k1aaaa', felder: {} }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { zustaendig: Array.from({ length: 51 }, (_, i) => `n${String(i).padStart(2, '0')}`) } },
    { typ: 'karte_setzen', id: 'k1aaaa', felder: { beschreibung: 'x'.repeat(20001) } }, { typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, text: '' } },
    { typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, text: 'x'.repeat(5001) } }, { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', text: 'x'.repeat(501), pos: 'i', neu: true } },
    { typ: 'spalte_setzen', id: 'todo00', titel: 'x'.repeat(81) }, { typ: 'etikett', id: 'e1aaaa', etikett: { name: 'x'.repeat(41), farbe: 'rot' } },
    { typ: 'karte_neu', karte: { ...KARTE, boese: 1 } }, { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'AAAAAAAAAAAA-a.pdf', name: 'a.pdf', groesse: 104857601, mime: 'application/pdf' } },
    { typ: 'karte_setzen', id: 'k1aaaa', felder: { etiketten: Array.from({ length: 21 }, (_, i) => `e${String(i).padStart(5, '0')}`) } }, null, 'karte', { typ: 'noop', x: 1 }])
    assert.throws(() => board.pruefen(op), (e) => e instanceof SyncFehler && e.code === 'E_PARAMS', JSON.stringify(op));
  for (const op of [{ typ: 'noop' }, { typ: 'karte_neu', karte: KARTE }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { faellig: null, archiviert: true, zustaendig: ['anna'] } },
    { typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa'] }, { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: 'c1aaaa', wer: 'anna', weg: true } },
    { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', erledigt: true } }, { typ: 'etikett', id: 'e1aaaa', etikett: { weg: true } }])
    assert.doesNotThrow(() => board.pruefen(op), JSON.stringify(op));
});

test('autorPruefen: Kommentar und neue Karte nur im eigenen Namen', () => {
  assert.throws(() => board.autorPruefen({ typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, wer: 'ben' } }, 'anna'), (e) => e.code === 'E_RECHTE');
  assert.throws(() => board.autorPruefen({ typ: 'karte_neu', karte: { ...KARTE, ersteller: 'ben' } }, 'anna'), (e) => e.code === 'E_RECHTE');
  assert.doesNotThrow(() => board.autorPruefen({ typ: 'karte_neu', karte: { ...KARTE, ersteller: 'anna' } }, 'anna'));
  assert.doesNotThrow(() => board.autorPruefen({ typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'x' } }, 'anna'));
});

test('zwischen: Reihenfolge und Grenzen', () => {
  assert.equal(zwischen(), 'i'); assert.equal(zwischen('i'), 'r'); assert.equal(zwischen(null, 'i'), '9'); assert.equal(zwischen('a', 'b'), 'ai');
  for (const [a, b] of [['a', 'a5'], ['a', 'a1'], ['0i', '1'], ['zz', null], [null, '01']]) { const m = zwischen(a, b); assert.ok((a === null || a < m) && (b === null || m < b), `${a} < ${m} < ${b}`); }
  assert.equal(zwischen('m', 'm') > 'm', true); // gleich → dahinter
});

test('auswahlTransformieren: gelöschte Karte → keine Auswahl', () => {
  assert.deepEqual(board.auswahlTransformieren({ karte: 'k1aaaa' }, { typ: 'karte_loeschen', id: 'k1aaaa' }, false), { karte: null });
  assert.deepEqual(board.auswahlTransformieren({ karte: 'k1aaaa' }, { typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa'] }, false), { karte: null });
  assert.deepEqual(board.auswahlTransformieren({ karte: 'k2aaaa' }, { typ: 'karte_loeschen', id: 'k1aaaa' }, false), { karte: 'k2aaaa' });
});

test('anwenden mutiert nicht', () => {
  const tief = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) tief(v); } return o; };
  let d = tief(structuredClone(A(A(BOARD, { typ: 'kommentar', karte: 'k1aaaa', kommentar: KOMM }), { typ: 'etikett', id: 'e1aaaa', etikett: { name: 'E', farbe: 'rot' } })));
  const ops = [
    { typ: 'karte_neu', karte: { ...KARTE, id: 'k3aaaa' } }, { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'x', zustaendig: ['anna'] } },
    { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'm' }, { typ: 'spalte_neu', spalte: { id: 's9aaaa', titel: 'X', pos: 'x' } },
    { typ: 'spalte_setzen', id: 'doing0', titel: 'Y' }, { typ: 'spalte_verschieben', id: 'doing0', pos: '0' },
    { typ: 'kommentar', karte: 'k1aaaa', kommentar: { ...KOMM, id: 'c2aaaa' } }, { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: 'c1aaaa', wer: 'anna', weg: true } },
    { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', text: 'x', pos: 'i', neu: true } }, { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: 'p1aaaa', erledigt: true } },
    { typ: 'etikett', id: 'e1aaaa', etikett: { farbe: 'blau' } }, { typ: 'etikett', id: 'e2aaaa', etikett: { name: 'F', farbe: 'gelb' } }, { typ: 'etikett', id: 'e1aaaa', etikett: { weg: true } },
    { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'AAAAAAAAAAAA-a.pdf', name: 'a.pdf', groesse: 1, mime: 'application/pdf' } },
    { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'AAAAAAAAAAAA-a.pdf', weg: true } }, { typ: 'karte_loeschen', id: 'k2aaaa' },
    { typ: 'spalte_loeschen', id: 'fertig', karten: [] }, { typ: 'noop' },
  ];
  for (const op of ops) { assert.doesNotThrow(() => { d = tief(A(d, op)); }, op.typ); }
  assert.deepEqual(new Set(ops.map((o) => o.typ)), new Set(OP_TYPEN), 'alle Op-Typen geprüft');
});

test('Prüfbericht Plan 04, I5: karte_neu nur mit eigenen Kommentaren, keine „weg“-Einträge', () => {
  const karte = (kommentare) => ({ typ: 'karte_neu', karte: { id: 'k7aaaa', spalte: 'todo00', pos: 'i', titel: 'x', erstellt: '2026-10-18T08:00:00.000Z', ersteller: 'anna', kommentare } });
  const c = (wer) => ({ id: 'c1aaaa', wer, name: 'Anna A.', zeit: '2026-10-18T08:00:00.000Z', text: 'hi' });
  assert.throws(() => board.autorPruefen(karte([c('ben')]), 'anna'), (e) => e.code === 'E_RECHTE');
  assert.doesNotThrow(() => board.autorPruefen(karte([c('anna')]), 'anna'));
  assert.throws(() => board.pruefen(karte([{ id: 'c1aaaa', wer: 'anna', weg: true }])), (e) => e.code === 'E_PARAMS');
});
