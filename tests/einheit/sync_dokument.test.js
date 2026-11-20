// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datentyp „dokument“ (Plan 05 Aufgabe 3): Delta mit abschließendem Zeilenumbruch, Kommentare mit gleichzeitigen
// Antworten, Prüfung der Ops (Formate, Embeds, Kommentare), Autor-Prüfung, Auswahl, bild-Handler, Register und der
// Fehlerabfang im Web-Dienst (unpassende Op → E_PARAMS, nichts angewandt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const TYPEN_PFAD = path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen');
const modul = await import(pathToFileURL(path.join(TYPEN_PFAD, 'dokument.js')).href);
const { dokument, bild, deltaPruefen, dokumentPruefen } = modul;
const { DATEI_MUSTER } = await import(pathToFileURL(path.join(TYPEN_PFAD, 'dokument-attribute.js')).href);
const { TYPEN } = await import(pathToFileURL(path.join(TYPEN_PFAD, 'index.js')).href);
const { OffenesDokument } = await import(pathToFileURL(path.join(WURZEL, 'src', 'web', 'office', 'dokument.js')).href);
const { FahnasFehler } = await import(pathToFileURL(path.join(WURZEL, 'src', 'gemeinsam', 'fehler.js')).href);

const K = (text, wer = 'anna') => ({ neu: { wer, name: 'Anna A.', zeit: '2026-10-18T10:00:00.000Z', text } });
const META = { id: 'oAAAAAAAAAAAAAAAA', art: 'dokument', name: 'Bericht', freigabe: 'team', pfad: 'Bericht.fahdoc', besitzer: 'anna' };

test('leer, anwenden, Endzeichen', () => {
  assert.equal(modul.default, dokument);
  assert.deepEqual(dokument.leer(), { delta: [{ insert: '\n' }], kommentare: {} });
  assert.deepEqual(dokument.anwenden(dokument.leer(), { d: [{ insert: 'Hi' }] }).delta, [{ insert: 'Hi\n' }]);
  assert.throws(() => dokument.anwenden(dokument.leer(), { d: [{ delete: 1 }] }), (e) => e.code === 'E_PARAMS'); // letztes \n weg
  assert.throws(() => dokument.anwenden(dokument.leer(), { d: [{ retain: 1 }, { insert: 'x' }] }), (e) => e.code === 'E_PARAMS'); // hinter dem letzten \n
  const leer = dokument.leer();
  dokument.anwenden(leer, { d: [{ insert: 'A' }], k: { kom001: K('x') } });
  assert.deepEqual(leer, dokument.leer(), 'Eingabe bleibt unverändert');
});

test('Kommentar: anlegen, Antworten gleichzeitig, erledigt, löschen gewinnt', () => {
  const d0 = dokument.anwenden(dokument.leer(), { k: { kom001: K('Frage') } });
  assert.deepEqual(d0.kommentare.kom001, { wer: 'anna', name: 'Anna A.', zeit: '2026-10-18T10:00:00.000Z', text: 'Frage', erledigt: false, antworten: [] });
  const a = { k: { kom001: { antworten: { ant001: { wer: 'anna', name: 'Anna A.', zeit: '2026-10-18T10:01:00.000Z', text: 'A' } } } } };
  const b = { k: { kom001: { antworten: { ant002: { wer: 'ben', name: 'Ben', zeit: '2026-10-18T10:01:00.000Z', text: 'B' } }, erledigt: true } } };
  const links = dokument.anwenden(dokument.anwenden(d0, a), dokument.transformiere(b, a, 'rechts'));
  assert.deepEqual(links, dokument.anwenden(dokument.anwenden(d0, b), dokument.transformiere(a, b, 'links')));
  assert.deepEqual(links.kommentare.kom001.antworten.map((x) => x.id), ['ant001', 'ant002']); assert.equal(links.kommentare.kom001.erledigt, true);
  assert.deepEqual(dokument.transformiere({ k: { kom001: { erledigt: false } } }, { k: { kom001: null } }, 'rechts'), {});
  // gleichzeitig erledigt gegensätzlich: die später ankommende gewinnt
  const x = { k: { kom001: { erledigt: true } } }; const y = { k: { kom001: { erledigt: false } } };
  assert.deepEqual(dokument.anwenden(dokument.anwenden(d0, x), dokument.transformiere(y, x, 'rechts')), dokument.anwenden(dokument.anwenden(d0, y), dokument.transformiere(x, y, 'links')));
  // Antwort löschen, Kommentar löschen, Teiländerung an fehlendem Kommentar bewirkt nichts
  const mitA = dokument.anwenden(d0, a);
  assert.deepEqual(dokument.anwenden(mitA, { k: { kom001: { antworten: { ant001: null } } } }).kommentare.kom001.antworten, []);
  assert.deepEqual(dokument.anwenden(mitA, { k: { kom001: null } }).kommentare, {});
  assert.deepEqual(dokument.anwenden(dokument.leer(), { k: { kom009: { erledigt: true } } }).kommentare, {});
});

test('pruefen und autorPruefen', () => {
  for (const op of [{}, { d: [], x: 1 }, { d: [{ insert: 'a', attributes: { link: 'javascript:x' } }] }, { d: [{ insert: 'a\n', attributes: { liste: 'punkte' } }] },
    { d: [{ insert: { bild: { datei: '../x' } } }] }, { d: [{ retain: { seitenumbruch: true } }] }, { k: { kom001: K('') } }, { k: { kurz: K('x') } },
    { d: [{ insert: { seitenumbruch: true }, attributes: { fett: true } }] }, { d: [{ insert: { bild: { datei: 'abcdefghijkl-a.png' } }, attributes: { fett: true } }] },
    { d: [{ retain: { bild: { breite: 15 } } }] }, { d: [{ delete: 0 }] }, { d: [{ retain: 2, insert: 'x' }] }, { d: [{ insert: 'x'.repeat(1_000_001) }] },
    { k: { kom001: { neu: { wer: 'anna', name: 'A', zeit: 'gestern', text: 'x' } } } }, { k: { kom001: {} } }])
    assert.throws(() => dokument.pruefen(op), (e) => e.code === 'E_PARAMS', JSON.stringify(op).slice(0, 120));
  for (const op of [{ d: [{ retain: 3 }, { insert: 'a', attributes: { fett: true, link: 'https://a.de' } }] }, { d: [{ retain: 1, attributes: { ueberschrift: 2, fett: null } }] },
    { d: [{ insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } }] }, { d: [{ insert: { bild: { datei: 'abcdefghijkl-a.png', breite: 300, alt: 'Foto' } }, attributes: { link: 'https://a.de' } }] },
    { d: [{ insert: { seitenumbruch: true } }] }, { d: [{ retain: { bild: { breite: null, alt: 'neu' } } }] }, { k: { kom001: K('Hallo') } }, { k: { kom001: null } }])
    assert.doesNotThrow(() => dokument.pruefen(op), JSON.stringify(op).slice(0, 120));
  assert.throws(() => dokument.autorPruefen({ k: { kom001: K('x', 'ben') } }, 'anna'), (e) => e.code === 'E_RECHTE');
  assert.throws(() => dokument.autorPruefen({ k: { kom001: { antworten: { ant001: { wer: 'ben', name: 'B', zeit: '2026-10-18T10:00:00.000Z', text: 'x' } } } } }, 'anna'), (e) => e.code === 'E_RECHTE');
  assert.doesNotThrow(() => dokument.autorPruefen({ k: { kom001: null } }, 'anna'));
  assert.doesNotThrow(() => dokument.autorPruefen({ d: [{ insert: 'x' }] }, 'anna'));
});

test('deltaPruefen und dokumentPruefen', () => {
  assert.doesNotThrow(() => deltaPruefen([{ insert: 'Titel' }, { insert: '\n', attributes: { ueberschrift: 1 } }], { dokument: true }));
  assert.throws(() => deltaPruefen([{ insert: 'ohne Ende' }], { dokument: true }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => deltaPruefen([{ retain: 1 }, { insert: '\n' }], { dokument: true }), (e) => e.code === 'E_PARAMS');
  assert.doesNotThrow(() => dokumentPruefen({ delta: [{ insert: 'a\n' }], kommentare: { kom001: { wer: 'anna', name: 'A', zeit: '2026-10-18T10:00:00.000Z', text: 'x', erledigt: false, antworten: [] } } }));
  assert.throws(() => dokumentPruefen({ delta: [{ insert: 'a\n' }], kommentare: {}, mehr: 1 }), (e) => e.code === 'E_PARAMS');
  const tab = { id: 'tab001', zeilen: ['z00001'], spalten: ['s00001'], weg: [], zellen: { 'z00001|s00001': [{ insert: 'x' }] }, breiten: {} };
  assert.doesNotThrow(() => deltaPruefen([{ insert: { tabelle: tab } }, { insert: '\n' }], { dokument: true }));
  assert.throws(() => deltaPruefen([{ insert: { tabelle: { ...tab, boese: 1 } } }, { insert: '\n' }], { dokument: true }), (e) => e.code === 'E_PARAMS');
});

test('zusammensetzen, istNoop, auswahlTransformieren', () => {
  assert.deepEqual(dokument.zusammensetzen({ d: [{ insert: 'a' }] }, { d: [{ retain: 1 }, { insert: 'b' }] }), { d: [{ insert: 'ab' }] });
  assert.equal(dokument.zusammensetzen({ k: { kom001: null } }, { k: { kom001: { erledigt: true } } }), null);
  assert.deepEqual(dokument.zusammensetzen({ k: { kom001: K('x') } }, { k: { kom001: { erledigt: true } } }), { k: { kom001: { ...K('x'), erledigt: true } } });
  assert.equal(dokument.istNoop({ d: [{ retain: 3 }], k: {} }), true);
  assert.equal(dokument.istNoop({}), true);
  assert.equal(dokument.istNoop({ d: [{ retain: 1, attributes: { fett: true } }] }), false);
  assert.deepEqual(dokument.auswahlTransformieren({ anker: 2, kopf: 2 }, { d: [{ retain: 2 }, { insert: 'xy' }] }, true), { anker: 4, kopf: 4 });
  assert.deepEqual(dokument.auswahlTransformieren({ anker: 2, kopf: 2 }, { d: [{ retain: 2 }, { insert: 'xy' }] }, false), { anker: 2, kopf: 2 });
  assert.deepEqual(dokument.auswahlTransformieren({ anker: 1, kopf: 5 }, { d: [{ delete: 3 }] }, false), { anker: 0, kopf: 2 });
  assert.equal(dokument.auswahlTransformieren(null, { d: [{ delete: 3 }] }, false), null);
  const aus = { anker: 1, kopf: 1 };
  assert.equal(dokument.auswahlTransformieren(aus, { k: { kom001: null } }, false), aus);
});

test('Tabelle und Bild im Dokument über die Embed-Handler', () => {
  const tab = { id: 'tab001', zeilen: ['z00001'], spalten: ['s00001'], weg: [], zellen: {}, breiten: {} };
  let d = dokument.anwenden(dokument.leer(), { d: [{ insert: { tabelle: tab } }, { insert: '\n' }, { insert: { bild: { datei: 'abcdefghijkl-a.png', breite: 100 } } }] });
  d = dokument.anwenden(d, { d: [{ retain: { tabelle: [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'Hallo' }] }] } }, { retain: 1 }, { retain: { bild: { breite: 250 } } }] });
  assert.deepEqual(d.delta[0].insert.tabelle.zellen, { 'z00001|s00001': [{ insert: 'Hallo' }] });
  assert.deepEqual(d.delta[2].insert, { bild: { datei: 'abcdefghijkl-a.png', breite: 250 } });
  const leerOp = dokument.transformiere({ d: [{ retain: { tabelle: [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'X' }] }] } }] },
    { d: [{ retain: { tabelle: [{ typ: 'zelle', zeile: 'z00001', spalte: 's00001', inhalt: [{ insert: 'Y' }] }] } }] }, 'links');
  assert.equal(dokument.istNoop(leerOp), true, 'verlorene Zelle → Noop');
});

test('bild-Handler: Breite, letzte gewinnt, invertieren', () => {
  assert.deepEqual(bild.transformiere({ breite: 200 }, { breite: 300 }, 'links'), null);
  assert.deepEqual(bild.transformiere({ breite: 200, alt: 'x' }, { breite: 300 }, 'links'), { alt: 'x' });
  assert.deepEqual(bild.transformiere({ breite: 200 }, { breite: 300 }, 'rechts'), { breite: 200 });
  assert.deepEqual(bild.invertieren({ breite: 200, alt: 'x' }, { datei: 'abcdefghijkl-a.png', breite: 100 }), { breite: 100, alt: null });
  assert.deepEqual(bild.anwenden({ datei: 'abcdefghijkl-a.png', breite: 100, alt: 'a' }, { breite: null, alt: 'b' }), { datei: 'abcdefghijkl-a.png', alt: 'b' });
  assert.deepEqual(bild.zusammensetzen({ breite: 100 }, { alt: 'x' }), { breite: 100, alt: 'x' });
});

test('DATEI_MUSTER gleich der Agent-Quelle', async () => {
  const { DATEI_MUSTER: agent } = await import(pathToFileURL(path.join(WURZEL, 'src', 'gemeinsam', 'office.js')).href);
  assert.equal(DATEI_MUSTER.source, agent.source);
});

test('Server: unpassende Op → E_PARAMS, nichts angewandt', () => {
  const s = new OffenesDokument({ meta: META, typ: dokument, version: 0, daten: null, stand: 'S0' });
  assert.throws(() => s.opAnnehmen({ basis: 0, cid: 'x-1', op: { d: [{ retain: 50 }, { insert: 'x' }] }, nutzer: 'anna' }), (e) => e instanceof FahnasFehler && e.code === 'E_PARAMS');
  assert.deepEqual([s.version, s.daten, s.verlauf.length], [0, dokument.leer(), 0]);
  const r = s.opAnnehmen({ basis: 0, cid: 'x-2', op: { d: [{ insert: 'Hallo' }] }, nutzer: 'anna' });
  assert.equal(r.v, 1);
  // gleichzeitige Op auf altem Stand: wird transformiert; passt sie danach nicht, bleibt alles wie es war
  assert.throws(() => s.opAnnehmen({ basis: 0, cid: 'x-3', op: { d: [{ retain: 2 }, { delete: 1 }] }, nutzer: 'anna' }), (e) => e instanceof FahnasFehler && e.code === 'E_PARAMS');
  assert.deepEqual([s.version, s.daten.delta], [1, [{ insert: 'Hallo\n' }]]);
});

test('TYPEN enthält dokument', () => { assert.equal(TYPEN.dokument, dokument); assert.ok(TYPEN.board); });
