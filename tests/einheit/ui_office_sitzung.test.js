// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Sitzung im Browser (V18, Plan 04 Aufgabe 12): Öffnen über den Office-WebSocket, eigene Ops mit dok, fremde
// Auswahl gegen spätere Ops nachgeführt, Wiederaufnahme nach Abbruch, Außenänderung/Neuladen mit „eigene ungesichert“,
// Kopie „meine Fassung“, Anhänge (URL, Hochladen, aus dem NAS), Schließen erst ohne Ausstehendes. Ohne DOM-Attrappe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const { statusAus, sitzungOeffnen, kopieSichern, etwasAusstehend } = await import(pathToFileURL(path.join(PUBLIC, 'office', 'sitzung.js')).href);
const { board } = await import(pathToFileURL(path.join(PUBLIC, 'gemeinsam', 'sync', 'typen', 'board.js')).href);

// setImmediate bleibt auch unter mock.timers (nur setTimeout) echt
const ticks = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const OP = Object.freeze({ typ: 'spalte_setzen', id: 'todo00', titel: 'Neu' });
const CTX = Object.freeze({ api: async () => ({}) });

/** Schein-Verbindung wie ChatVerbindung: senden nur „verbunden“, on/ausloesen je Art. */
function schein(status = 'verbunden') {
  const hoerer = new Map();
  return {
    status, gesendet: [], gestartet: 0,
    starten() { this.gestartet += 1; },
    senden(obj) { if (this.status !== 'verbunden') return false; this.gesendet.push(structuredClone(obj)); return true; },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    ausloesen(art, obj) { for (const fn of [...(hoerer.get(art) || [])]) fn(obj); },
    letzte(art) { return this.gesendet.findLast((n) => n.art === art); },
    alle(art) { return this.gesendet.filter((n) => n.art === art); },
  };
}

function geoeffnet(anfrage, dok = {}, extra = {}) {
  return {
    art: 'geoeffnet', anfrage, kid: 'k1', anwesend: [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#1' }], ...extra,
    dok: { id: 'oX', art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', recht: 'bearbeiten', besitzer: 'anna', version: 2, daten: board.leer(), schnappschuesse: false, ...dok },
  };
}

/** Öffnet oX über die Schein-Verbindung und beantwortet „oeffnen“. */
async function oeffnen(v, dok = {}, mehr = {}) {
  const p = sitzungOeffnen({ ref: { id: dok.id || 'oX' }, ctx: CTX, verbindung: v, ...mehr });
  await ticks();
  v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage, dok));
  return p;
}

test('statusAus', () => {
  assert.equal(statusAus({ verbunden: false, ausstehend: 1, ungespeichert: false, fehler: null }), 'offline');
  assert.equal(statusAus({ verbunden: true, ausstehend: 0, ungespeichert: true, fehler: null }), 'speichert');
  assert.equal(statusAus({ verbunden: true, ausstehend: 1, ungespeichert: false, fehler: null }), 'speichert');
  assert.equal(statusAus({ verbunden: true, ausstehend: 0, ungespeichert: false, fehler: null }), 'gespeichert');
  assert.equal(statusAus({ verbunden: true, ausstehend: 0, ungespeichert: true, fehler: { code: 'E_PLATZ' } }), 'fehler');
  assert.equal(statusAus({ verbunden: false, ausstehend: 0, ungespeichert: true, fehler: { code: 'E_PLATZ' } }), 'offline');
});

test('sitzungOeffnen: oeffnen mit anfrage, geoeffnet setzt dok/daten/recht; Zeitlimit 20 s → E_AGENT', async (t) => {
  const v = schein('verbinde');
  const p = sitzungOeffnen({ ref: { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard' }, ctx: CTX, verbindung: v });
  await ticks();
  assert.equal(v.gestartet, 1, 'Verbindung gestartet');
  assert.equal(v.letzte('oeffnen'), undefined, 'ohne Verbindung noch nichts gesendet');
  v.status = 'verbunden'; v.ausloesen('status', 'verbunden');
  const o = v.letzte('oeffnen');
  assert.equal(typeof o.anfrage, 'string');
  assert.deepEqual(o.ref, { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard' });
  v.ausloesen('geoeffnet', geoeffnet('fremde-anfrage', { id: 'oZ' }));
  v.ausloesen('geoeffnet', geoeffnet(o.anfrage));
  const s = await p;
  assert.equal(s.dok.id, 'oX'); assert.equal(s.dok.name, 'Sprint'); assert.equal(s.dok.besitzer, 'anna');
  assert.equal(s.dok.daten, undefined, 'Daten nur über sitzung.daten');
  assert.equal(s.recht, 'bearbeiten'); assert.equal(s.kid, 'k1'); assert.equal(s.version, 2);
  assert.deepEqual(s.daten, board.leer());
  assert.deepEqual(s.anwesend, [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#1' }]);
  assert.equal(s.status, 'gespeichert'); assert.equal(s.ausstehend, 0);
  assert.equal(await sitzungOeffnen({ ref: { id: 'oX' }, ctx: CTX, verbindung: v }), s, 'zweites Öffnen → dieselbe Sitzung');
  assert.equal(v.alle('oeffnen').length, 1);

  // Fehler des Servers zur Anfrage
  const p1 = sitzungOeffnen({ ref: { id: 'oF' }, ctx: CTX, verbindung: v });
  await ticks();
  v.ausloesen('fehler', { art: 'fehler', anfrage: v.letzte('oeffnen').anfrage, fehler: { code: 'E_RECHTE', meldung: 'Kein Zugriff' } });
  await assert.rejects(p1, (e) => e.code === 'E_RECHTE' && e.message === 'Kein Zugriff');

  // unbekannte Dokumentart → E_PARAMS, beim Server wieder abgemeldet
  const p3 = sitzungOeffnen({ ref: { id: 'oD' }, ctx: CTX, verbindung: v });
  await ticks();
  v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage, { id: 'oD', art: 'praesentation' })); // Art ohne Typ
  await assert.rejects(p3, (e) => e.code === 'E_PARAMS');
  assert.deepEqual(v.letzte('schliessen'), { art: 'schliessen', dok: 'oD' });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v2 = schein();
  const p2 = sitzungOeffnen({ ref: { id: 'oY' }, ctx: CTX, verbindung: v2 });
  await ticks();
  t.mock.timers.tick(19_999);
  await ticks();
  let fertig = false; p2.catch(() => {}).finally(() => { fertig = true; });
  await ticks();
  assert.equal(fertig, false, 'vor 20 s noch offen');
  t.mock.timers.tick(1);
  await assert.rejects(p2, (e) => e.code === 'E_AGENT');
});

test('lokal → op mit dok; fremde Auswahl wird gegen spätere Ops transformiert', async () => {
  const v = schein();
  const s = await oeffnen(v);
  const status = []; s.on('status', (x) => status.push(x));
  const aenderungen = []; s.on('aenderung', (e) => aenderungen.push(e));
  s.lokal(OP);
  const op = v.letzte('op');
  assert.equal(op.dok, 'oX'); assert.equal(op.basis, 2); assert.deepEqual(op.op, OP); assert.equal(typeof op.cid, 'string');
  assert.equal(s.daten.spalten.find((x) => x.id === 'todo00').titel, 'Neu');
  assert.equal(s.ausstehend, 1); assert.equal(s.status, 'speichert'); assert.deepEqual(status, ['speichert']);
  assert.deepEqual(aenderungen, [{ op: OP, lokal: true }]);
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k1', cid: op.cid, op: OP });
  assert.equal(s.ausstehend, 0); assert.equal(s.version, 3);

  const auswahlen = []; s.on('auswahl', (a) => auswahlen.push(a));
  v.ausloesen('auswahl', { art: 'auswahl', dok: 'oX', von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2', version: 3, auswahl: { karte: 'k1aaaa' } });
  v.ausloesen('auswahl', { art: 'auswahl', dok: 'oZ', von: 'k7', nutzer: 'ben', name: 'Ben', farbe: '#2', version: 3, auswahl: { karte: 'k1aaaa' } });
  assert.deepEqual(auswahlen, [{ von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2', auswahl: { karte: 'k1aaaa' } }], 'anderes Dokument zählt nicht');
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 4, von: 'k2', cid: 'fremd-1', op: { typ: 'karte_loeschen', id: 'k1aaaa' } });
  assert.equal(auswahlen.length, 2);
  assert.deepEqual(auswahlen[1], { von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2', auswahl: { karte: null } });
  assert.deepEqual(aenderungen[1], { op: { typ: 'karte_loeschen', id: 'k1aaaa' }, lokal: false });

  // geht die Person, verschwindet ihre Auswahl
  v.ausloesen('anwesend', { art: 'anwesend', dok: 'oX', liste: [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#1' }] });
  assert.deepEqual(auswahlen[2], { von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2', auswahl: null });
  assert.deepEqual(s.anwesend, [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#1' }]);

  s.auswahlSenden({ karte: 'k2bbbb' });
  assert.deepEqual(v.letzte('auswahl'), { art: 'auswahl', dok: 'oX', version: 4, auswahl: { karte: 'k2bbbb' } });

  const rechte = []; s.on('recht', (e) => rechte.push(e));
  v.ausloesen('recht', { art: 'recht', dok: 'oX', recht: 'lesen' });
  assert.deepEqual(rechte, [{ recht: 'lesen' }]); assert.equal(s.recht, 'lesen'); assert.equal(s.dok.recht, 'lesen');
  assert.throws(() => s.lokal(OP), (e) => e.code === 'E_RECHTE');
  assert.equal(v.alle('op').length, 1, 'nur lesen → nichts gesendet');

  const namen = []; s.on('umbenannt', (e) => namen.push(e));
  v.ausloesen('umbenannt', { art: 'umbenannt', dok: 'oX', name: 'Sprint 2', pfad: 'Projekte/Sprint 2.fahboard' });
  assert.deepEqual(namen, [{ name: 'Sprint 2', pfad: 'Projekte/Sprint 2.fahboard' }]); assert.equal(s.dok.name, 'Sprint 2');

  v.ausloesen('speicherfehler', { art: 'speicherfehler', dok: 'oX', fehler: { code: 'E_PLATZ', meldung: 'voll' } });
  assert.equal(s.status, 'fehler'); assert.deepEqual(s.fehler, { code: 'E_PLATZ', meldung: 'voll' });
  v.ausloesen('gespeichert', { art: 'gespeichert', dok: 'oX', version: 4, zeit: '2026-10-18T13:00:00.000Z' });
  assert.equal(s.status, 'gespeichert'); assert.equal(s.fehler, null);
});

test('Wiederverbinden: wiederaufnehmen mit Version; neu_laden mit eigenen Ungesicherten meldet eigeneUngesichert', async () => {
  const v = schein();
  const s = await oeffnen(v);
  s.lokal(OP);
  const alt = v.letzte('op');
  v.status = 'getrennt'; v.ausloesen('status', 'getrennt');
  assert.equal(s.status, 'offline');
  assert.equal(etwasAusstehend(), true, 'beforeunload warnt');
  v.status = 'verbunden'; v.ausloesen('status', 'verbunden'); v.ausloesen('wieder');
  assert.deepEqual(v.letzte('wiederaufnehmen'), { art: 'wiederaufnehmen', dok: 'oX', ref: { id: 'oX' }, version: 2 });
  // die Op kam beim Server nie an → mit gleicher cid noch einmal
  v.ausloesen('wiederaufgenommen', { art: 'wiederaufgenommen', dok: 'oX', kid: 'k9', version: 2, ops: [] });
  const neu = v.letzte('op');
  assert.equal(v.alle('op').length, 2); assert.equal(neu.cid, alt.cid); assert.equal(neu.dok, 'oX'); assert.equal(s.kid, 'k9');

  const ereignisse = []; s.on('neu_laden', (e) => ereignisse.push(e));
  const geladen = []; s.on('neu_geladen', (e) => geladen.push(e));
  const vorher = s.daten;
  v.ausloesen('neu_laden', { art: 'neu_laden', dok: 'oX', grund: 'zu_alt' });
  assert.equal(ereignisse.length, 1);
  assert.equal(ereignisse[0].grund, 'zu_alt'); assert.equal(ereignisse[0].eigeneUngesichert, true); assert.equal(ereignisse[0].daten, vorher);
  assert.throws(() => s.lokal(OP), (e) => e.code === 'E_AGENT', 'während des Neuladens keine Änderungen');
  const o = v.letzte('oeffnen');
  assert.deepEqual(o.ref, { id: 'oX' });
  const frisch = board.leer(); frisch.spalten[0].titel = 'Vom Server';
  v.ausloesen('geoeffnet', geoeffnet(o.anfrage, { version: 7, daten: frisch }, { kid: 'k10' }));
  await ticks();
  assert.deepEqual(geladen, [{ grund: 'zu_alt' }]);
  assert.equal(s.version, 7); assert.equal(s.ausstehend, 0); assert.equal(s.kid, 'k10'); assert.equal(s.eigeneUngesichert, false);
  assert.equal(s.daten.spalten[0].titel, 'Vom Server');
  assert.equal(etwasAusstehend(), false);
  // die Bestätigung der verworfenen Op kommt noch: sie gilt als fremd und ist schon im neuen Stand (Version ≤ 7)
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k9', cid: alt.cid, op: OP });
  assert.equal(s.daten.spalten[0].titel, 'Vom Server');

  // Dokument gelöscht: Ereignis, aber kein neues Öffnen
  const zahl = v.alle('oeffnen').length;
  v.ausloesen('neu_laden', { art: 'neu_laden', dok: 'oX', grund: 'geloescht' });
  assert.equal(ereignisse[1].grund, 'geloescht'); assert.equal(ereignisse[1].eigeneUngesichert, false);
  assert.equal(v.alle('oeffnen').length, zahl);
});

test('verworfen: wird eine eigene Op durch eine fremde wirkungslos, meldet die Sitzung es weiter (Prüfbericht Plan 06, I6)', async () => {
  const v = schein();
  const s = await oeffnen(v);
  const weg = []; s.on('verworfen', (e) => weg.push(e));
  s.lokal(OP);
  const eigene = v.letzte('op');
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k2', cid: 'fremd-1', op: { typ: 'spalte_loeschen', id: 'todo00' } });
  assert.deepEqual(weg, [{ ops: [OP] }]);
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 4, von: 'k1', cid: eigene.cid, op: { typ: 'noop' } }); // Bestätigung (beim Server noop)
  assert.equal(s.ausstehend, 0);
});

test('extern bietet Kopie nur mit eigenen ungesicherten Ops', async () => {
  const v = schein();
  const s = await oeffnen(v);
  const extern = []; s.on('extern', (e) => extern.push(e));
  s.lokal(OP);
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k1', cid: v.letzte('op').cid, op: OP });
  v.ausloesen('gespeichert', { art: 'gespeichert', dok: 'oX', version: 2, zeit: '2026-10-18T13:00:00.000Z' });
  assert.equal(s.eigeneUngesichert, true, 'bestätigt (3), aber gespeichert erst 2');
  const meine = s.daten;
  v.ausloesen('extern', { art: 'extern', dok: 'oX' });
  assert.equal(extern.length, 1); assert.equal(extern[0].eigeneUngesichert, true); assert.equal(extern[0].daten, meine);
  const o = v.letzte('oeffnen'); assert.deepEqual(o.ref, { id: 'oX' });
  v.ausloesen('geoeffnet', geoeffnet(o.anfrage, { version: 3 }));
  await ticks();
  assert.equal(s.eigeneUngesichert, false);

  s.lokal(OP);
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 4, von: 'k1', cid: v.letzte('op').cid, op: OP });
  v.ausloesen('gespeichert', { art: 'gespeichert', dok: 'oX', version: 4, zeit: '2026-10-18T13:00:05.000Z' });
  v.ausloesen('extern', { art: 'extern', dok: 'oX' });
  assert.equal(extern.length, 2); assert.equal(extern[1].eigeneUngesichert, false);
});

test('kopieSichern: office.anlegen (beide) + import_setzen mit den lokalen Daten', async () => {
  const v = schein();
  const sitzung = await oeffnen(v);
  const aufrufe = []; const ctx = { api: async (a, p) => { aufrufe.push([a, p]); return a === 'office.anlegen' ? { id: 'oNEU', name: 'Sprint (meine Fassung 2026-10-18 15-42)' } : { version: 1 }; } };
  assert.deepEqual(await kopieSichern(ctx, sitzung, new Date(2026, 9, 18, 15, 42)), { id: 'oNEU', name: 'Sprint (meine Fassung 2026-10-18 15-42)' });
  assert.deepEqual(aufrufe[0], ['office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Sprint (meine Fassung 2026-10-18 15-42)', beide: true }]);
  assert.deepEqual(aufrufe[1], ['office.import_setzen', { id: 'oNEU', daten: sitzung.daten }]);

  // eigene Daten (aus dem extern-Ereignis), Wurzelordner, Name höchstens 200 Zeichen, Übersetzung über ctx.t
  aufrufe.length = 0;
  const lang = await oeffnen(v, { id: 'oL', name: 'x'.repeat(200), pfad: `${'x'.repeat(200)}.fahboard` });
  const daten = { eigene: true };
  ctx.t = (k, w) => (k === 'office.meine_fassung' ? `my version ${w.zeit}` : k);
  await kopieSichern(ctx, lang, new Date(2026, 0, 2, 3, 4), daten);
  assert.equal(aufrufe[0][1].ordner, '');
  assert.equal(aufrufe[0][1].name, `${'x'.repeat(200 - ' (my version 2026-01-02 03-04)'.length)} (my version 2026-01-02 03-04)`);
  assert.equal(aufrufe[0][1].name.length, 200);
  assert.equal(aufrufe[1][1].daten, daten);
});

test('dateiUrl, dateiHochladen, dateiAusNas', async () => {
  const v = schein();
  const gesehen = []; const wahlen = []; let wahl = { freigabe: 'team', pfad: 'Bilder/a.png' };
  const aufrufe = [];
  const ctx = { api: async (a, p) => { aufrufe.push([a, p]); return { datei: 'abcdefghijkl-a.png', name: 'a.png' }; } };
  const p = sitzungOeffnen({
    ref: { id: 'oX' }, ctx, verbindung: v,
    hochladen: async (url, datei) => { gesehen.push([url, datei]); return { datei: 'abcdefghijkl-a.png', name: 'a.png' }; },
    ordnerWahl: async (c, o) => { wahlen.push([c, o]); return wahl; },
  });
  await ticks();
  v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage));
  const s = await p;
  assert.equal(s.dateiUrl('abcdefghijkl-a b.png'), '/api/office/datei?id=oX&datei=abcdefghijkl-a%20b.png');
  const datei = { name: 'a.png', size: 3 };
  assert.deepEqual(await s.dateiHochladen(datei), { datei: 'abcdefghijkl-a.png', name: 'a.png' });
  assert.equal(gesehen[0][0], '/api/office/hochladen?id=oX&name=a.png'); assert.equal(gesehen[0][1], datei);
  await s.dateiHochladen({ name: 'ä &b.png', size: 1 });
  assert.equal(gesehen[1][0], '/api/office/hochladen?id=oX&name=%C3%A4%20%26b.png');

  assert.deepEqual(await s.dateiAusNas(), { datei: 'abcdefghijkl-a.png', name: 'a.png' });
  assert.equal(wahlen[0][0], ctx); assert.equal(wahlen[0][1].dateien, true);
  assert.deepEqual(aufrufe, [['office.datei_kopieren', { id: 'oX', freigabe: 'team', pfad: 'Bilder/a.png' }]]);
  wahl = null;
  assert.equal(await s.dateiAusNas(), null);
  assert.equal(aufrufe.length, 1, 'Abbruch → kein Aufruf');
});

test('schliessen wartet, bis nichts mehr aussteht (ohne Zeitgrenze – Prüfbericht Plan 04, I8), dann {art:"schliessen"}', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = schein();
  const s = await oeffnen(v);
  s.lokal(OP);
  const p = s.schliessen();
  await ticks();
  assert.equal(v.letzte('schliessen'), undefined, 'wartet auf die Bestätigung');
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k1', cid: v.letzte('op').cid, op: OP });
  await p;
  assert.deepEqual(v.letzte('schliessen'), { art: 'schliessen', dok: 'oX' });
  // danach ist die Sitzung weg: erneutes Öffnen fragt den Server
  const zahl = v.alle('oeffnen').length;
  const s2 = await oeffnen(v);
  assert.notEqual(s2, s); assert.equal(v.alle('oeffnen').length, zahl + 1);

  // ohne Bestätigung bleibt die Sitzung (und die beforeunload-Warnung), auch nach Minuten – nichts wird verworfen
  s2.lokal(OP);
  const p2 = s2.schliessen();
  await ticks();
  t.mock.timers.tick(30_000); await ticks();
  t.mock.timers.tick(120_000); await ticks();
  assert.equal(v.alle('schliessen').length, 1, 'noch nicht geschlossen');
  assert.equal(etwasAusstehend(), true, 'beforeunload warnt weiter');
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k1', cid: v.letzte('op').cid, op: OP });
  await p2;
  assert.equal(v.alle('schliessen').length, 2);

  // während des Wartens erneut geöffnet → bleibt offen
  const s3 = await oeffnen(v);
  s3.lokal(OP);
  const p3 = s3.schliessen();
  assert.equal(await sitzungOeffnen({ ref: { id: 'oX' }, ctx: CTX, verbindung: v }), s3);
  v.ausloesen('op', { art: 'op', dok: 'oX', version: 3, von: 'k1', cid: v.letzte('op').cid, op: OP });
  await p3;
  assert.equal(v.alle('schliessen').length, 2, 'nicht geschlossen');
});

test('officeVerbindung: Einzelstück zu /api/office/ws, nur 4001 ist endgültig', async () => {
  const altLocation = globalThis.location;
  globalThis.location = { protocol: 'https:', host: 'nas.example:8443' };
  try {
    const { officeVerbindung } = await import(pathToFileURL(path.join(PUBLIC, 'office', 'verbindung.js')).href);
    const v = officeVerbindung();
    assert.equal(v.url, 'wss://nas.example:8443/api/office/ws');
    assert.equal(v.endgueltig.has(4001), true); assert.equal(v.endgueltig.has(4003), false);
    assert.equal(officeVerbindung(), v);
  } finally { globalThis.location = altLocation; }
});

test('Prüfbericht Plan 04, I8: abgemeldet (4001) beendet wartende Sitzungen sofort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = schein();
  const s = await oeffnen(v);
  s.lokal(OP);
  let fertig = false;
  s.schliessen().then(() => { fertig = true; });
  await ticks();
  v.status = 'beendet'; v.ausloesen('status', 'beendet'); v.ausloesen('beendet', { code: 4001 });
  await ticks();
  assert.equal(fertig, true, 'ohne auf eine Zeitgrenze zu warten');
  assert.equal(etwasAusstehend(), false);
});

test('Prüfbericht Plan 04, I6: neu_laden „verschoben“ öffnet nicht neu, sondern beendet die Sitzung', async () => {
  const v = schein();
  const s = await oeffnen(v);
  const ereignisse = []; s.on('neu_laden', (e) => ereignisse.push(e));
  s.lokal(OP);
  const zahl = v.alle('oeffnen').length;
  v.ausloesen('neu_laden', { art: 'neu_laden', dok: 'oX', grund: 'verschoben' });
  assert.equal(ereignisse[0].grund, 'verschoben'); assert.equal(ereignisse[0].eigeneUngesichert, true);
  assert.equal(v.alle('oeffnen').length, zahl, 'kein neues Öffnen');
  assert.throws(() => s.lokal(OP), (e) => e.code === 'E_NICHT_GEFUNDEN');
});

test('Prüfbericht Plan 04, I7: kopieSichern ohne Schreibrecht im Ordner → Ordner wählen; Abbruch → null', async () => {
  const v = schein();
  const sitzung = await oeffnen(v);
  let versuche = 0; const aufrufe = [];
  const ctx = { api: async (a, p) => { aufrufe.push([a, p]); if (a === 'office.anlegen' && versuche++ === 0) throw Object.assign(new Error('nein'), { code: 'E_RECHTE' }); return a === 'office.anlegen' ? { id: 'oNEU', name: p.name } : { version: 1 }; } };
  const wahlen = [];
  const r = await kopieSichern(ctx, sitzung, new Date(2026, 9, 18, 15, 42), { x: 1 }, { ordnerWahl: async (c, o) => { wahlen.push(o); return { freigabe: 'meins', pfad: 'Kopien' }; } });
  assert.deepEqual(r, { id: 'oNEU', name: 'Sprint (meine Fassung 2026-10-18 15-42)' });
  assert.equal(wahlen[0].nurSchreibbar, true);
  assert.deepEqual(aufrufe.map(([a, p]) => [a, p.freigabe, p.ordner]), [['office.anlegen', 'team', 'Projekte'], ['office.anlegen', 'meins', 'Kopien'], ['office.import_setzen', undefined, undefined]]);
  versuche = 0; aufrufe.length = 0;
  assert.equal(await kopieSichern(ctx, sitzung, new Date(), { x: 1 }, { ordnerWahl: async () => null }), null);
  assert.deepEqual(aufrufe.map(([a]) => a), ['office.anlegen'], 'nichts weiter angelegt');
  const fremd = { api: async () => { throw Object.assign(new Error('voll'), { code: 'E_PLATZ' }); } };
  await assert.rejects(kopieSichern(fremd, sitzung, new Date(), {}, { ordnerWahl: async () => { throw new Error('nicht fragen'); } }), (e) => e.code === 'E_PLATZ');
});
