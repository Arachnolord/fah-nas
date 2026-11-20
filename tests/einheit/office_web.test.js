// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office im Web-Dienst (Plan 04, Aufgabe 11, V12/V15): WebSocket /api/office/ws (Sitzung, gleiche Herkunft, höchstens
// 10 je Nutzer), öffnen/Ops/Rechte über den Agenten, Abschluss-Haken speichert vor dem Stopp, Datei-Endpunkte für Bilder
// und Anhänge, Office-Ereignisse nie über SSE.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp, warte, standardAttrappe, dienstStarten, Browser, anfrage, sseLesen } from './web_hilfen.js';
import { wsVerbinden } from './ws_hilfen.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { WS_PFAD, MAX_NACHRICHT, MAX_SOCKETS, ANWESEND_FARBEN } from '../../src/web/office/index.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { board } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'typen', 'board.js')).href);
const ID = 'oAAAAAAAAAAAAAAAA';
const SETZ = { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'Neu' } };
let a; let dienst; let port; let speicher;

beforeEach(async () => {
  a = await standardAttrappe(await tmp());
  speicher = { version: 0, daten: null, stand: 'S0', verlauf: [], rechte: { fabian: 'bearbeiten', tina: 'bearbeiten' } };
  const recht = (k) => { const r = speicher.rechte[k.nutzer]; if (!r) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Dokument gibt es nicht'); return r; };
  a.aktion('office.laden', (p, k) => ({ id: ID, art: 'board', name: 'Plan', freigabe: 'team', pfad: 'Plan.fahboard', besitzer: 'fabian', recht: recht(k), version: speicher.version, daten: speicher.daten, stand: speicher.stand, verlauf: [...speicher.verlauf], schnappschuesse: false }));
  a.aktion('office.recht', (p, k) => ({ id: ID, recht: recht(k), stand: speicher.stand }));
  a.aktion('office.speichern', (p, k) => {
    if (speicher.weg) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Das Dokument liegt nicht mehr an seinem Ort', { office: 'verschoben' });
    if (recht(k) !== 'bearbeiten') throw new FahnasFehler('E_RECHTE', 'Du darfst dieses Dokument nur lesen');
    Object.assign(speicher, { version: p.version, daten: p.daten, stand: `S${p.version}`, verlauf: [...speicher.verlauf, ...p.ops] });
    return { stand: speicher.stand };
  });
  a.aktion('office.datei_ticket', (p, k) => {
    if (p.name.includes('/')) throw new FahnasFehler('E_PARAMS', 'Name enthält unerlaubte Zeichen', { feld: 'name' });
    return { ticket: a.ticketAnlegen({ nutzer: k.nutzer, art: 'schreiben', pfad: 'x', antwort: { ok: true, ergebnis: { datei: `abcdefghijkl-${p.name}`, name: p.name } } }), dateiname: p.name, groesse: p.groesse };
  });
  a.aktion('office.datei_lesen', (p, k) => {
    recht(k);
    return { ticket: a.ticketAnlegen({ nutzer: k.nutzer, art: 'lesen', inhalt: Buffer.from('BILD') }), dateiname: p.datei.slice(13), groesse: 4, mime: 'image/png' };
  });
  ({ dienst, port } = await dienstStarten(a, { heartbeat_ms: 50 }));
});
afterEach(async () => { await dienst.stoppen(); await a.stoppen(); });

async function socket(name = 'fabian', pw = 'geheim123') {
  const b = new Browser(port); await b.anmelden(name, pw);
  if (name === 'tina') await b.post('/api/anmelden/totp', { code: '123456' });
  const c = await wsVerbinden(port, WS_PFAD, { cookie: b.kopf().cookie });
  return { b, c };
}
/** POST ohne Content-Length (chunked). */
function chunked(pfad, kopf) {
  return new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pfad, headers: { ...kopf, 'transfer-encoding': 'chunked' } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(t) }));
    });
    req.write('abc'); req.end();
  });
}
async function oeffnen(c, anfrage = 'a1') {
  c.senden({ art: 'oeffnen', anfrage, ref: { id: ID } });
  return c.naechste((m) => m.art === 'geoeffnet' || (m.art === 'fehler' && m.anfrage === anfrage));
}

test('Konstanten', () => {
  assert.deepEqual([WS_PFAD, MAX_NACHRICHT, MAX_SOCKETS], ['/api/office/ws', 8 * 1024 * 1024, 10]);
  assert.equal(ANWESEND_FARBEN.length, 8);
});

test('Upgrade: ohne Sitzung 401, fremde Herkunft 403, offene 2FA 401, Sitzung 101', async () => {
  assert.equal((await wsVerbinden(port, WS_PFAD)).status, 401);
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  assert.equal((await wsVerbinden(port, WS_PFAD, { cookie: b.kopf().cookie, origin: 'https://boese.example' })).status, 403);
  const c = await wsVerbinden(port, WS_PFAD, { cookie: b.kopf().cookie });
  assert.equal(c.status, 101);
  c.schliessen();
});

test('offene 2FA (Zugriff aus dem Internet) → 401', async () => {
  await dienst.stoppen(); await a.stoppen();
  a = await standardAttrappe(await tmp());
  ({ dienst, port } = await dienstStarten(a, { anmeldeschutz: { extern: () => true } }));
  const t = new Browser(port); await t.anmelden('tina', 'tina1234');
  assert.equal((await wsVerbinden(port, WS_PFAD, { cookie: t.kopf().cookie })).status, 401);
});

test('oeffnen → geoeffnet mit Daten, Recht, Anwesenden; op wird an alle verteilt', async () => {
  const { c: c1 } = await socket(); const { c: c2 } = await socket('tina', 'tina1234');
  const g = await oeffnen(c1);
  assert.deepEqual([g.anfrage, g.dok.id, g.dok.recht, g.dok.version, g.dok.schnappschuesse, g.anwesend.length], ['a1', ID, 'bearbeiten', 0, false, 1]);
  assert.deepEqual(g.dok.daten, board.leer());
  assert.equal(g.anwesend[0].farbe, ANWESEND_FARBEN[0]);
  const g2 = await oeffnen(c2, 'b1');
  assert.equal(g2.anwesend.length, 2);
  assert.equal((await c1.naechste((m) => m.art === 'anwesend')).liste.length, 2, 'Anwesende erfahren vom Neuen');
  c1.senden({ art: 'op', dok: ID, basis: 0, cid: 'x-1', op: SETZ });
  assert.deepEqual(await c2.naechste((m) => m.art === 'op'), { art: 'op', dok: ID, version: 1, von: g.kid, cid: 'x-1', op: SETZ });
  assert.deepEqual(await c1.naechste((m) => m.art === 'op'), { art: 'op', dok: ID, version: 1, von: g.kid, cid: 'x-1', op: SETZ }, 'Bestätigung an den Absender');
  c1.senden({ art: 'auswahl', dok: ID, version: 1, auswahl: { karte: 'k1aaaa' } });
  assert.equal((await c2.naechste((m) => m.art === 'auswahl')).auswahl.karte, 'k1aaaa');
  c1.senden({ art: 'sichtbar', ja: true });
  c1.senden({ art: 'unbekannt' });
  assert.equal((await c1.naechste((m) => m.art === 'fehler')).fehler.code, 'E_PARAMS');
  c1.senden({ art: 'auswahl', dok: ID, version: 1, auswahl: { karte: null } });
  assert.equal((await c2.naechste((m) => m.art === 'auswahl' && m.auswahl.karte === null)).von, g.kid, 'Socket bleibt nach Fehler offen');
  c1.senden({ art: 'oeffnen', anfrage: 'z', ref: { id: 'kaputt' } });
  assert.equal((await c1.naechste((m) => m.art === 'fehler' && m.anfrage === 'z')).fehler.code, 'E_PARAMS');
});

test('Lese-Recht und Entzug im offenen Dokument', async () => {
  speicher.rechte.tina = 'lesen';
  const { c: c1 } = await socket(); const { c: c2 } = await socket('tina', 'tina1234');
  await oeffnen(c1); const g2 = await oeffnen(c2, 'b1');
  assert.equal(g2.dok.recht, 'lesen');
  c2.senden({ art: 'op', dok: ID, basis: 0, cid: 'b-1', op: SETZ });
  assert.deepEqual(await c2.naechste((m) => m.art === 'fehler'), { art: 'fehler', dok: ID, cid: 'b-1', fehler: { code: 'E_RECHTE', meldung: 'Du darfst dieses Dokument nur lesen' } });
  speicher.rechte.tina = 'bearbeiten';
  a.ereignis({ ereignis: 'office', art: 'rechte', id: ID });
  assert.deepEqual(await c2.naechste((m) => m.art === 'recht'), { art: 'recht', dok: ID, recht: 'bearbeiten' });
  speicher.rechte.tina = undefined;
  a.ereignis({ ereignis: 'office', art: 'rechte', id: ID });
  assert.equal((await c2.naechste((m) => m.art === 'fehler' && !m.cid)).fehler.code, 'E_RECHTE');
  c1.senden({ art: 'op', dok: ID, basis: 0, cid: 'x-1', op: SETZ });
  await c1.naechste((m) => m.art === 'op');
  assert.equal(await c2.naechste((m) => m.art === 'op', 200).catch(() => null), null, 'keine weiteren Ops');
  a.ereignis({ ereignis: 'office', art: 'pfad', id: ID, freigabe: 'team', pfad: 'Neu/Q4.fahboard', name: 'Q4' });
  assert.deepEqual(await c1.naechste((m) => m.art === 'umbenannt'), { art: 'umbenannt', dok: ID, name: 'Q4', pfad: 'Neu/Q4.fahboard' });
  a.ereignis({ ereignis: 'office', art: 'geloescht', id: ID });
  assert.deepEqual(await c1.naechste((m) => m.art === 'neu_laden'), { art: 'neu_laden', dok: ID, grund: 'geloescht' });
});

test('Abschluss-Haken speichert vor agent.stoppen (V15); TURN ist danach aus', async () => {
  const { c: c1 } = await socket();
  await oeffnen(c1);
  c1.senden({ art: 'op', dok: ID, basis: 0, cid: 'x-1', op: SETZ }); await c1.naechste((m) => m.art === 'op');
  const zu = c1.zu; await dienst.stoppen();
  assert.equal(a.anfragen.filter((x) => x.aktion === 'office.speichern').length, 1);
  assert.equal(a.anfragen.find((x) => x.aktion === 'office.speichern').params.ops[0].cid, 'x-1');
  assert.equal((await zu).code, 1001);
  assert.equal(dienst.turn.stand().aktiv, false, 'Plan-03-Stopp bleibt');
});

test('Wiederaufnehmen über den Socket: verpasste Ops bzw. neu_laden', async () => {
  const { c: c1 } = await socket(); const { c: c2 } = await socket('tina', 'tina1234');
  await oeffnen(c1); await oeffnen(c2, 'b1');
  c1.senden({ art: 'op', dok: ID, basis: 0, cid: 'x-1', op: SETZ }); await c2.naechste((m) => m.art === 'op');
  c2.schliessen();
  const { c: c3 } = await socket('tina', 'tina1234');
  c3.senden({ art: 'wiederaufnehmen', dok: ID, ref: { id: ID }, version: 0 });
  const w = await c3.naechste((m) => m.art === 'wiederaufgenommen');
  assert.deepEqual([w.dok, w.version, w.ops.map((o) => o.cid)], [ID, 1, ['x-1']]);
  c3.senden({ art: 'op', dok: ID, basis: 1, cid: 't-1', op: { typ: 'karte_setzen', id: 'k1aaaa', felder: { archiviert: true } } });
  assert.equal((await c1.naechste((m) => m.art === 'op' && m.cid === 't-1')).von, w.kid, 'neue kid gilt');
  c3.senden({ art: 'wiederaufnehmen', dok: ID, ref: { id: ID }, version: 9 });
  assert.deepEqual(await c3.naechste((m) => m.art === 'neu_laden'), { art: 'neu_laden', dok: ID, grund: 'version' });
});

test('Hochladen: Content-Length Pflicht, Ticket mit Sitzungsnutzer, {datei, name}; Name mit ../ → 400 E_PARAMS', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const ohne = await chunked(`/api/office/hochladen?id=${ID}&name=a.txt`, b.kopf({}, 'POST'));
  assert.equal(ohne.status, 400); assert.equal(ohne.json.fehler.details.feld, 'Content-Length');
  const r = await b.anfrage('POST', `/api/office/hochladen?id=${ID}&name=a.txt`, { body: 'hallo' });
  assert.equal(r.status, 200); assert.deepEqual(r.json.ergebnis, { datei: 'abcdefghijkl-a.txt', name: 'a.txt' });
  assert.equal(a.datenKoepfe.at(-1).nutzer, 'fabian');
  const boese = await b.anfrage('POST', `/api/office/hochladen?id=${ID}&name=${encodeURIComponent('../x')}`, { body: 'x' });
  assert.equal(boese.status, 400); assert.equal(boese.json.fehler.code, 'E_PARAMS');
  assert.equal((await b.anfrage('POST', `/api/office/hochladen?id=kaputt&name=a.txt`, { body: 'x' })).status, 400);
  assert.equal((await anfrage(port, 'POST', `/api/office/hochladen?id=${ID}&name=a.txt`, { body: 'x' })).status, 401);
});

test('Datei lesen: inline, immutable, ohne Sitzung 401, ohne Recht 404', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const r = await b.anfrage('GET', `/api/office/datei?id=${ID}&datei=abcdefghijkl-bild.png`);
  assert.equal(r.status, 200); assert.equal(r.text, 'BILD');
  assert.equal(r.kopf['cache-control'], 'private, max-age=31536000, immutable');
  assert.match(r.kopf['content-disposition'], /^inline/);
  assert.equal((await anfrage(port, 'GET', `/api/office/datei?id=${ID}&datei=abcdefghijkl-bild.png`)).status, 401);
  assert.equal((await b.anfrage('GET', `/api/office/datei?id=${ID}&datei=../inhalt.json`)).status, 400);
  speicher.rechte.fabian = undefined;
  assert.equal((await b.anfrage('GET', `/api/office/datei?id=${ID}&datei=abcdefghijkl-bild.png`)).status, 404);
});

test('Office-Ereignisse nie über SSE', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const strom = sseLesen(port, b.kopf(), (t) => t.includes('"bereich":"ende"'));
  await warte(80);
  a.ereignis({ ereignis: 'office', art: 'rechte', id: ID });
  a.ereignis({ ereignis: 'konfig', bereich: 'ende' });
  const { text } = await strom;
  assert.ok(!text.includes(ID)); assert.ok(!/event: office/.test(text));
});

test('elf Sockets desselben Nutzers → 429; sichtbar wird still ignoriert', async () => {
  const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
  const offen = [];
  for (let i = 0; i < MAX_SOCKETS; i++) { const c = await wsVerbinden(port, WS_PFAD, { cookie: b.kopf().cookie }); assert.equal(c.status, 101); offen.push(c); }
  assert.equal((await wsVerbinden(port, WS_PFAD, { cookie: b.kopf().cookie })).status, 429);
  offen[0].senden({ art: 'sichtbar', ja: true });
  assert.equal(await offen[0].naechste(() => true, 200).catch(() => null), null, 'keine Antwort auf sichtbar');
  for (const c of offen) c.schliessen();
});

test('Prüfbericht I1/I9: Freigaben geändert → Rechte offener Dokumente neu; nach dem Verschwinden meldet eine Op E_NICHT_GEFUNDEN mit cid', async () => {
  const { c: c1 } = await socket(); const { c: c2 } = await socket('tina', 'tina1234');
  await oeffnen(c1); await oeffnen(c2, 'b1');
  speicher.rechte.tina = undefined;
  a.ereignis({ ereignis: 'konfig', bereich: 'freigaben' });
  assert.equal((await c2.naechste((m) => m.art === 'fehler' && !m.cid)).fehler.code, 'E_RECHTE');
  speicher.rechte.tina = 'bearbeiten';
  a.ereignis({ ereignis: 'konfig', bereich: 'nutzer' }); // ändert nichts mehr für tina (abgemeldet)
  // Bündel verschwindet beim Speichern → neu_laden; eine weitere Op bekommt eine Antwort statt still zu verschwinden
  speicher.weg = true;
  c1.senden({ art: 'op', dok: ID, basis: 0, cid: 'x-1', op: SETZ });
  assert.deepEqual(await c1.naechste((m) => m.art === 'neu_laden', 4000), { art: 'neu_laden', dok: ID, grund: 'verschoben' });
  c1.senden({ art: 'op', dok: ID, basis: 1, cid: 'x-2', op: SETZ });
  const f = await c1.naechste((m) => m.art === 'fehler' && m.cid === 'x-2');
  assert.equal(f.fehler.code, 'E_NICHT_GEFUNDEN');
});
