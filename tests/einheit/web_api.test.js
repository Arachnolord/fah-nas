// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Web-API Ende-zu-Ende gegen die Attrappe: /api/agent (Weiterreichen, Sperren, Status-Abbildung, Fehlerdetails
// je Rolle), Herunterladen/Hochladen/Link über den Datenkanal (Kopf {ticket, nutzer}, Tickets je Sitzung), statische
// Dateien + Kopfzeilen, SSE (Rolle aus der Sitzung), Umleitung (nur bekannte Hosts), Protokoll-Rotation, vertraute Proxys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmp, warte, standardAttrappe, dienstStarten, Browser, anfrage, rohAnfrage, rohKopf } from './web_hilfen.js';
import { umleitungsServer, CSP, DETAILS_VERWEIS, PERMISSIONS_POLICY } from '../../src/web/server.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

async function webProtokoll(webOrdner) {
  const dateien = (await fs.readdir(webOrdner)).filter((d) => /^web-\d{4}-\d{2}\.log$/.test(d));
  let text = '';
  for (const d of dateien) text += await fs.readFile(path.join(webOrdner, d), 'utf8');
  return text;
}

test('/api/agent: params + kontext 1:1, Aufgabe → {aufgabe}, system/gast-Aktionen gesperrt, unbekannt 404, Name geprüft', async () => {
  const a = await standardAttrappe(await tmp());
  a.aktion('chat.anruf', { rolle: 'nutzer', fn: () => ({}) });
  a.aktion('office.speichern', { rolle: 'nutzer', fn: () => ({}) });
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('tina', 'tina1234'); await b.post('/api/anmelden/totp', { code: '123456' });
    const echo = await b.post('/api/agent/test.echo', { a: 1, liste: [1, 2], tief: { x: 'ü' } });
    assert.equal(echo.status, 200);
    assert.deepEqual(echo.json, { ok: true, ergebnis: { params: { a: 1, liste: [1, 2], tief: { x: 'ü' } }, kontext: { nutzer: 'tina', rolle: 'nutzer', ip: '127.0.0.1' } } });
    const leer = await b.post('/api/agent/test.echo');
    assert.deepEqual(leer.json.ergebnis.params, {});
    const aufgabe = await b.post('/api/agent/test.aufgabe', {});
    assert.deepEqual(aufgabe.json, { ok: true, aufgabe: 't-test1' });
    const admin = await b.post('/api/agent/test.admin', {});
    assert.equal(admin.status, 403); assert.equal(admin.json.fehler.code, 'E_RECHTE');
    const system = await b.post('/api/agent/test.system', {});
    assert.equal(system.status, 403); assert.equal(system.json.fehler.code, 'E_RECHTE');
    const gast = await b.post('/api/agent/system.ersteinrichtung', { startcode: 'x', admin: {} });
    assert.equal(gast.status, 403);
    assert.equal(a.anfragen.filter((x) => x.aktion === 'test.system' || x.aktion === 'system.ersteinrichtung').length, 0, 'gesperrte Aktionen erreichen den Agenten nie');
    // Anruf-Notizen/-Meldungen entstehen nur aus echten Anrufen des Web-Dienstes (Prüfbericht Plan 03, I5)
    const anruf = await b.post('/api/agent/chat.anruf', { raum: 'rAAAAAAAAAAAAAAAA', art: 'verpasst' });
    assert.equal(anruf.status, 403); assert.equal(anruf.json.fehler.code, 'E_RECHTE');
    assert.equal(a.anfragen.filter((x) => x.aktion === 'chat.anruf').length, 0);
    // Office-Dokumente schreibt nur der Web-Dienst selbst (geprüfte Ops) – nie direkt über die API (Prüfbericht Plan 04, I5)
    const speichern = await b.post('/api/agent/office.speichern', { id: 'oAAAAAAAAAAAAAAAA', version: 1, daten: {}, ops: [] });
    assert.equal(speichern.status, 403); assert.equal(a.anfragen.filter((x) => x.aktion === 'office.speichern').length, 0);
    const unbekannt = await b.post('/api/agent/test.gibtsnicht', {});
    assert.equal(unbekannt.status, 404); assert.equal(unbekannt.json.fehler.code, 'E_NICHT_GEFUNDEN');
    const schlecht = await b.post('/api/agent/Test.Echo', {});
    assert.equal(schlecht.status, 400); assert.equal(schlecht.json.fehler.code, 'E_PARAMS');
    assert.equal((await b.post('/api/agent/test', {})).status, 400);
    // Aktionsliste nur einmal geholt
    assert.equal(a.anfragen.filter((x) => x.aktion === 'agent.aktionen').length, 1);
    // Body kein Objekt / kein JSON
    const arr = await b.anfrage('POST', '/api/agent/test.echo', { body: '[1,2]', kopf: { 'content-type': 'application/json' } });
    assert.equal(arr.status, 400);
    const kaputt = await b.anfrage('POST', '/api/agent/test.echo', { body: '{kaputt' });
    assert.equal(kaputt.status, 400);
    // zu groß (Content-Length > 1 MB) → 400 sofort, bevor der Body gelesen wurde (Client schickt nur 64 KB und wartet)
    const gross = await new Promise((ok, nein) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/agent/test.echo', headers: { ...b.kopf({}, 'POST'), 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 10) } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => { req.destroy(); ok({ status: res.statusCode, json: JSON.parse(text) }); });
      });
      req.on('error', nein);
      req.write(Buffer.alloc(64 * 1024, 0x20));
      setTimeout(() => nein(new Error('keine Antwort auf zu großen Body')), 3000).unref();
    });
    assert.equal(gross.status, 400); assert.equal(gross.json.fehler.code, 'E_PARAMS');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('fehlercodes des Agenten → HTTP-Status', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const erwartet = { E_PARAMS: 400, E_RECHTE: 403, E_NICHT_GEFUNDEN: 404, E_EXISTIERT: 409, E_BELEGT: 409, E_PLATZ: 507, E_BREMSE: 429, E_TICKET: 410, E_KONFIG: 500, E_RENDER: 500, E_SYSTEM: 500, E_UNBEKANNT: 500 };
    for (const [code, status] of Object.entries(erwartet)) {
      const r = await b.post('/api/agent/test.fehler', { code, meldung: `Test ${code}` });
      assert.equal(r.status, status, code);
      assert.deepEqual(r.json, { ok: false, fehler: { code, meldung: `Test ${code}`, details: { feld: 'x' } } });
    }
    // Verbindungsabriss zum Agenten MITTEN in einer Anfrage → die laufende Anfrage endet sauber mit 503 E_AGENT
    const haengt = b.post('/api/agent/test.haengt', {});
    await warte(80);
    assert.equal(a.anfragen.filter((x) => x.aktion === 'test.haengt').length, 1, 'Anfrage liegt beim Agenten');
    await a.stoppen(); await warte(30);
    const abriss = await haengt;
    assert.equal(abriss.status, 503); assert.equal(abriss.json.fehler.code, 'E_AGENT');
    assert.equal(dienst.agent.offen.size, 0, 'keine offene Anfrage bleibt hängen');
    // Agent weg → 503 E_AGENT
    const r = await b.post('/api/agent/test.echo', {});
    assert.equal(r.status, 503); assert.equal(r.json.fehler.code, 'E_AGENT');
    // unbekannter API-Pfad → 404 JSON, falsche Methode → 405
    const p = await b.get('/api/gibtsnicht');
    assert.equal(p.status, 404); assert.equal(p.json.fehler.code, 'E_NICHT_GEFUNDEN');
    assert.equal((await b.get('/api/abmelden')).status, 405);
    assert.equal((await b.anfrage('DELETE', '/api/ich')).status, 405);
  } finally { await dienst.stoppen(); }
});

test('herunterladen: Bytes 1:1 mit Kopfzeilen; ZIP ohne Content-Length; Fehlerzeile des Agenten → JSON-Fehler vor den Kopfzeilen', async () => {
  const a = await standardAttrappe(await tmp());
  const inhalt = crypto.randomBytes(300_000);
  a.dateien.set('medien/urlaub/bild ü "1".txt', inhalt);
  a.dateien.set('medien/fehlerdatei.json', Buffer.from('{"fehler":{"code":"E_PARAMS","meldung":"nur Inhalt"}}\n{"zweite":1}\n'));
  a.dateien.set('medien/leer.txt', Buffer.alloc(0));
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const r = await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=' + encodeURIComponent('urlaub/bild ü "1".txt'));
    assert.equal(r.status, 200);
    assert.equal(r.kopf['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.kopf['content-length'], String(inhalt.length));
    assert.equal(r.kopf['content-disposition'], `attachment; filename="bild _ _1_.txt"; filename*=UTF-8''bild%20%C3%BC%20_1_.txt`);
    assert.equal(r.kopf['x-content-type-options'], 'nosniff');
    assert.equal(r.kopf['cache-control'], 'no-store');
    assert.ok(r.body.equals(inhalt), 'Bytes 1:1');
    const t = a.anfragen.filter((x) => x.aktion === 'dateien.ticket').at(-1);
    assert.deepEqual(t.params, { freigabe: 'medien', pfad: 'urlaub/bild ü "1".txt', art: 'lesen' });
    assert.equal(t.kontext.nutzer, 'fabian');
    // Datenkanal-Kopf {ticket, nutzer} mit dem Sitzungsnutzer (§3, Fund 3)
    assert.equal(a.datenKoepfe.length, 1);
    assert.deepEqual(Object.keys(a.datenKoepfe[0]).sort(), ['nutzer', 'ticket']);
    assert.equal(a.datenKoepfe[0].nutzer, 'fabian'); assert.match(a.datenKoepfe[0].ticket, /^k-[A-Za-z0-9_-]+$/);
    // anzeigen=1 → inline
    const inl = await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=leer.txt&anzeigen=1');
    assert.equal(inl.status, 200); assert.match(inl.kopf['content-disposition'], /^inline;/); assert.equal(inl.body.length, 0);
    // ZIP
    const z = await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=urlaub&zip=1');
    assert.equal(z.status, 200); assert.equal(z.kopf['content-type'], 'application/zip'); assert.equal(z.kopf['content-length'], undefined);
    assert.ok(z.body.toString('latin1').startsWith('PK'));
    assert.equal(a.anfragen.filter((x) => x.aktion === 'dateien.ticket').at(-1).params.art, 'zip');
    // Fehlerzeile (Datei fehlt) → 404 JSON
    const f = await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=gibtsnicht.txt');
    assert.equal(f.status, 404); assert.equal(f.json.fehler.code, 'E_NICHT_GEFUNDEN');
    // Datei, die wie eine Fehlerzeile beginnt, aber Inhalt ist → als Datei geliefert
    const j = await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=fehlerdatei.json');
    assert.equal(j.status, 200); assert.ok(j.body.equals(a.dateien.get('medien/fehlerdatei.json')));
    // ungültige Parameter
    assert.equal((await b.get('/api/dateien/herunterladen?freigabe=Medien&pfad=x')).status, 400);
    assert.equal((await b.get('/api/dateien/herunterladen?freigabe=medien&pfad=../etc')).status, 400);
    // ohne Sitzung 401
    assert.equal((await anfrage(port, 'GET', '/api/dateien/herunterladen?freigabe=medien&pfad=leer.txt')).status, 401);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('herunterladen: Client bricht ab → Datenkanal-Socket wird geschlossen', async () => {
  const a = await standardAttrappe(await tmp());
  a.dateien.set('medien/gross.bin', crypto.randomBytes(2_000_000));
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    await new Promise((ok, nein) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/dateien/herunterladen?freigabe=medien&pfad=gross.bin', headers: b.kopf() }, (res) => {
        res.once('data', () => { req.destroy(); ok(); });
      });
      req.on('error', () => ok()); req.end();
      setTimeout(() => nein(new Error('keine Daten')), 3000).unref();
    });
    await warte(100);
    assert.equal(a.datenVerbindungen, 1);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('hochladen: Body 1:1 in den Datenkanal, Ticket mit groesse; ohne Content-Length 400; Fehler des Agenten; Rückfall ohne Antwortzeile', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const daten = crypto.randomBytes(250_000);
    const r = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=' + encodeURIComponent('ordner/unter') + '&name=' + encodeURIComponent('neu ü.bin'), { body: daten, kopf: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, ergebnis: { freigabe: 'medien', pfad: 'ordner/unter/neu ü.bin', name: 'neu ü.bin', groesse: daten.length } });
    assert.ok(a.geschrieben.get('medien/ordner/unter/neu ü.bin').equals(daten), 'Bytes 1:1 geschrieben');
    const t = a.anfragen.filter((x) => x.aktion === 'dateien.ticket').at(-1);
    assert.deepEqual(t.params, { freigabe: 'medien', pfad: 'ordner/unter/neu ü.bin', art: 'schreiben', groesse: daten.length, bei_vorhanden: 'fehler' }, 'ohne Angabe: nie überschreiben');
    assert.equal(t.kontext.nutzer, 'fabian');
    assert.deepEqual(a.datenKoepfe.at(-1), { ticket: a.datenKoepfe.at(-1).ticket, nutzer: 'fabian' }, 'Kopf {ticket, nutzer}');
    // leere Datei
    const leer = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=leer.txt', { body: Buffer.alloc(0) });
    assert.equal(leer.status, 200); assert.equal(a.geschrieben.get('medien/leer.txt').length, 0);
    // chunked (ohne Content-Length) → 400, kein Ticket geholt
    const vorher = a.anfragen.length;
    const ch = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=x.bin', { body: Buffer.alloc(10), kopf: { 'transfer-encoding': 'chunked' } });
    assert.equal(ch.status, 400); assert.equal(ch.json.fehler.details.feld, 'Content-Length');
    assert.equal(a.anfragen.length, vorher);
    // ungültiger Name / Pfadflucht
    assert.equal((await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=a%2Fb', { body: Buffer.alloc(1) })).status, 400);
    assert.equal((await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=..&name=a', { body: Buffer.alloc(1) })).status, 400);
    // CSRF nötig
    const ohne = await anfrage(port, 'POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=b.bin', { kopf: { cookie: b.kopf().cookie }, body: Buffer.alloc(3) });
    assert.equal(ohne.status, 403);
    // „Beide behalten“: der Agent meldet den tatsächlichen Namen, die Antwort gibt ihn weiter
    a.schreibAntwort = { ok: true, ergebnis: { pfad: 'doppelt (1).txt', name: 'doppelt (1).txt', ersetzt: false, umbenannt: true, papierkorb: null } };
    const beide = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=doppelt.txt&bei_vorhanden=beide', { body: Buffer.alloc(4) });
    assert.equal(beide.status, 200);
    assert.deepEqual(beide.json.ergebnis, { freigabe: 'medien', pfad: 'doppelt (1).txt', name: 'doppelt (1).txt', groesse: 4, ersetzt: false, umbenannt: true, papierkorb: null });
    assert.equal(a.anfragen.filter((x) => x.aktion === 'dateien.ticket').at(-1).params.bei_vorhanden, 'beide');
    a.schreibAntwort = undefined;
    // Agent meldet Fehler nach dem Schreiben (z. B. Platz)
    a.schreibAntwort = { fehler: { code: 'E_PLATZ', meldung: 'Kein Platz mehr' } };
    const voll = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=voll.bin', { body: Buffer.alloc(100) });
    assert.equal(voll.status, 507); assert.equal(voll.json.fehler.code, 'E_PLATZ');
    a.schreibAntwort = undefined;
    // Keine Antwortzeile (Halbschluss-Problem) → Rückfall über dateien.info: Größe passt → 200
    a.ohneAntwort = true;
    const ohneAntwort = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=still.bin', { body: Buffer.alloc(777, 1) });
    assert.equal(ohneAntwort.status, 200);
    assert.ok(a.anfragen.some((x) => x.aktion === 'dateien.info' && x.params.pfad === 'still.bin'));
    // … Größe passt nicht → 503
    a.aktionen.get('dateien.info').fn = () => ({ groesse: 1 });
    const kaputt = await b.anfrage('POST', '/api/dateien/hochladen?freigabe=medien&pfad=&name=kaputt.bin', { body: Buffer.alloc(50, 1) });
    assert.equal(kaputt.status, 503); assert.equal(kaputt.json.fehler.code, 'E_AGENT');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('link: ?herunterladen=1 streamt wie früher mit dem Link-Ersteller im Datenkanal-Kopf; unbekannt/ungültig → 404; ohne Ersteller → 503', async () => {
  const a = await standardAttrappe(await tmp());
  const pdf = crypto.randomBytes(5000);
  a.dateien.set('doku/rechnung.pdf', pdf);
  a.links.set('abcdefgh12345678', { freigabe: 'doku', pfad: 'rechnung.pdf', nutzer: 'tina' });
  a.links.set('ohneersteller123', { freigabe: 'doku', pfad: 'rechnung.pdf', nutzer: 'tina', ohneNutzer: true });
  const { dienst, port } = await dienstStarten(a);
  try {
    const r = await anfrage(port, 'GET', '/link/abcdefgh12345678?herunterladen=1');
    assert.equal(r.status, 200); assert.equal(r.kopf['content-type'], 'application/pdf');
    assert.match(r.kopf['content-disposition'], /attachment; filename="rechnung\.pdf"/);
    assert.equal(r.kopf['x-robots-tag'], 'noindex, nofollow');
    assert.ok(r.body.equals(pdf));
    const pruef = a.anfragen.find((x) => x.aktion === 'dateien.link.pruefen');
    assert.deepEqual(pruef.params, { token: 'abcdefgh12345678' }); assert.equal(pruef.kontext.rolle, 'gast');
    // Kopf {ticket, nutzer}: nutzer = Link-Ersteller aus dem Ergebnis von dateien.link.pruefen, nicht „web“/„gast“
    assert.equal(a.datenKoepfe.length, 1);
    assert.equal(a.datenKoepfe[0].nutzer, 'tina'); assert.match(a.datenKoepfe[0].ticket, /^k-/);
    assert.equal((await anfrage(port, 'GET', '/link/gibtsnicht1234?herunterladen=1')).status, 404);
    assert.equal((await anfrage(port, 'GET', '/link/kurz?herunterladen=1')).status, 404);
    // Agent liefert keinen Ersteller → kein Datenkanal, 503 mit klarer Meldung (kein Raten eines Nutzers)
    const oh = await anfrage(port, 'GET', '/link/ohneersteller123?herunterladen=1');
    assert.equal(oh.status, 503); assert.equal(oh.json.fehler.code, 'E_AGENT'); assert.match(oh.json.fehler.meldung, /Link-Ersteller/);
    assert.equal(a.datenKoepfe.length, 1);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('link: Linkseite (HTML-Hülle), liste ohne Kontonamen, datei/zip/vorschau im Namen des Erstellers, Zugriffe in /api/links', async () => {
  const a = await standardAttrappe(await tmp());
  a.dateien.set('medien/urlaub/strand.jpg', Buffer.from('jpg-inhalt'));
  a.dateien.set('medien/urlaub/tag1/film.mp4', Buffer.from('mp4-inhalt'));
  a.links.set('ordnerlink123456', { freigabe: 'medien', pfad: 'urlaub', art: 'ordner', nutzer: 'tina', ablauf: null });
  const { dienst, port } = await dienstStarten(a, { system: { vertraute_proxys: ['127.0.0.1'] } });
  try {
    const seite = await anfrage(port, 'GET', '/link/ordnerlink123456', { kopf: { 'x-forwarded-for': '203.0.113.5' } });
    assert.equal(seite.status, 200); assert.match(seite.kopf['content-type'], /^text\/html/);
    const html = seite.body.toString();
    assert.match(html, /<title>urlaub – FAH-NAS<\/title>/); assert.match(html, /src="\/teilen\.js"/); assert.match(html, /noindex/);
    assert.equal(seite.kopf['x-robots-tag'], 'noindex, nofollow');
    const liste = await anfrage(port, 'GET', '/link/ordnerlink123456/liste?pfad=');
    assert.equal(liste.status, 200); assert.equal(liste.json.ergebnis.art, 'ordner');
    assert.deepEqual(liste.json.ergebnis.eintraege.map((e) => [e.name, e.art]), [['strand.jpg', 'datei'], ['tag1', 'ordner']]);
    assert.equal(liste.json.ergebnis.nutzer, undefined, 'Kontoname des Erstellers bleibt intern');
    assert.equal((await anfrage(port, 'GET', '/link/ordnerlink123456/liste?pfad=tag1')).json.ergebnis.eintraege[0].name, 'film.mp4');
    const oeffnen = a.anfragen.filter((x) => x.aktion === 'dateien.link.oeffnen');
    assert.ok(oeffnen.every((x) => x.kontext.rolle === 'gast'));
    // Ansehen im Browser: inline, Video-Spulen (Range), Kopf {ticket, nutzer=tina}
    const ansehen = await anfrage(port, 'GET', '/link/ordnerlink123456/datei?pfad=tag1%2Ffilm.mp4&anzeigen=1');
    assert.equal(ansehen.status, 200); assert.match(ansehen.kopf['content-disposition'], /^inline/); assert.equal(ansehen.body.toString(), 'mp4-inhalt');
    assert.equal(a.datenKoepfe.at(-1).nutzer, 'tina');
    const runter = await anfrage(port, 'GET', '/link/ordnerlink123456/datei?pfad=strand.jpg');
    assert.match(runter.kopf['content-disposition'], /^attachment; filename="strand\.jpg"/);
    const zip = await anfrage(port, 'GET', '/link/ordnerlink123456/zip?pfad=tag1');
    assert.equal(zip.status, 200); assert.equal(zip.kopf['content-type'], 'application/zip'); assert.match(zip.kopf['content-disposition'], /tag1\.zip/);
    const bild = await anfrage(port, 'GET', '/link/ordnerlink123456/vorschau?pfad=strand.jpg&groesse=256');
    assert.equal(bild.status, 200); assert.equal(bild.kopf['content-type'], 'image/webp'); assert.equal(bild.body.toString(), 'RIFFbild');
    assert.equal((await anfrage(port, 'GET', '/link/ordnerlink123456/vorschau?pfad=strand.jpg&groesse=77')).status, 400);
    assert.equal((await anfrage(port, 'GET', '/link/ordnerlink123456/liste?pfad=gibtsnicht')).status, 404);

    // Kachel: Admin sieht den Link von tina mit Aufrufen, wer gerade zugreift (IP über den vertrauten Proxy) und Ort
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const links = await b.get('/api/links');
    assert.equal(links.status, 200);
    const l = links.json.ergebnis.links.find((x) => x.token === 'ordnerlink123456');
    assert.ok(l, 'Link in der Liste'); assert.equal(l.ablauf, null); assert.equal(l.nutzer, 'tina');
    assert.equal(l.zugriffe.aufrufe, 4, 'Seite + Ansehen + Herunterladen + ZIP (Liste/Vorschau zählen nicht)');
    assert.deepEqual(l.zugriffe.zuletzt.ip, '127.0.0.1');
    assert.deepEqual(l.zugriffe.aktiv.map((x) => x.ip).sort(), ['127.0.0.1', '203.0.113.5']);
    assert.deepEqual(links.json.ergebnis.orte['203.0.113.5'], { stadt: 'Musterstadt', land: 'DE', land_name: 'Deutschland' });
    assert.equal((await anfrage(port, 'GET', '/api/links')).status, 401, 'nur mit Sitzung');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('link: ungültige Tokens → 404-Seite ohne Skript; Durchprobieren bremst die IP (429)', async () => {
  const a = await standardAttrappe(await tmp());
  a.dateien.set('doku/x.pdf', Buffer.from('x'));
  a.links.set('richtiglink12345', { freigabe: 'doku', pfad: 'x.pdf', nutzer: 'fabian' });
  const { dienst, port } = await dienstStarten(a);
  try {
    const tot = await anfrage(port, 'GET', '/link/gibtsnichtABCDEF');
    assert.equal(tot.status, 404); assert.match(tot.kopf['content-type'], /^text\/html/);
    assert.match(tot.body.toString(), /ungültig oder abgelaufen/); assert.doesNotMatch(tot.body.toString(), /teilen\.js/);
    for (let i = 0; i < 4; i++) assert.equal((await anfrage(port, 'GET', `/link/falsch${i}ABCDEFGHIJ/liste`)).status, 404);
    const gebremst = await anfrage(port, 'GET', '/link/richtiglink12345/liste');
    assert.equal(gebremst.status, 429, 'nach 5 Fehlversuchen ist die IP gesperrt – auch für gültige Links');
    assert.equal(gebremst.json.fehler.code, 'E_BREMSE');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('link: Adresse für Freigabelinks wird nur über einen vertrauten Proxy gelernt und wandert mit der Domain', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { system: { vertraute_proxys: ['127.0.0.1'] } });
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    assert.equal((await b.get('/api/ich', { host: '192.168.1.29:8443' })).json.ergebnis.zugang.link_basis, null, 'IP lernt nichts');
    assert.equal((await b.get('/api/ich', { host: 'fahnas.local' })).json.ergebnis.zugang.link_basis, null, '.local lernt nichts');
    const ich = await b.get('/api/ich', { host: 'fah-nas.example.org', 'x-forwarded-for': '203.0.113.5', 'x-forwarded-proto': 'https' });
    assert.equal(ich.json.ergebnis.zugang.link_basis, 'https://fah-nas.example.org');
    assert.equal((await b.get('/api/ich', { host: '192.168.1.29:8443' })).json.ergebnis.zugang.link_basis, 'https://fah-nas.example.org', 'bleibt bei Aufruf per IP');
    const neu = await b.get('/api/ich', { host: 'teilen.example.net', 'x-forwarded-host': 'teilen.example.net' });
    assert.equal(neu.json.ergebnis.zugang.link_basis, 'https://teilen.example.net', 'Domainwechsel wandert mit');
  } finally { await dienst.stoppen(); await a.stoppen(); }
  // ohne vertrauten Proxy: Host-Kopf eines beliebigen Clients wird nie übernommen
  const a2 = await standardAttrappe(await tmp());
  const { dienst: d2, port: p2 } = await dienstStarten(a2);
  try {
    const b = new Browser(p2); await b.anmelden('fabian', 'geheim123');
    assert.equal((await b.get('/api/ich', { host: 'boese.example.com' })).json.ergebnis.zugang.link_basis, null);
  } finally { await d2.stoppen(); await a2.stoppen(); }
});

test('agent-download/agent-upload: Tickets nur für die eigene Sitzung (fremd → 404, Ticket bleibt dem Besitzer), Kopf {ticket, nutzer}, Body 1:1, Metadaten, ungültige Tickets', async () => {
  const a = await standardAttrappe(await tmp());
  a.exportInhalt = Buffer.from('GEHEIMER KONFIG-EXPORT MIT HASHES');
  const { dienst, port, webOrdner } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const b2 = new Browser(port); await b2.anmelden('fabian', 'geheim123'); // zweite Sitzung desselben Nutzers
    const t = new Browser(port); await t.anmelden('tina', 'tina1234'); await t.post('/api/anmelden/totp', { code: '123456' });
    // Export: Aktion liefert Ticket (an die Sitzung des Admins gebunden)
    const ex = await b.post('/api/agent/system.export', { mit_geheimnissen: true });
    assert.equal(ex.status, 200); const ticket = ex.json.ergebnis.ticket; assert.ok(ticket);
    // Prüfbericht R1, Fund 3 (p8): fremde Sitzung (andere Nutzerin) → 404, kein Datenkanal, Ticket bleibt dem Besitzer
    const fremd = await t.get(`/api/agent-download?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(fremd.status, 404); assert.equal(fremd.json.fehler.code, 'E_NICHT_GEFUNDEN');
    assert.ok(!fremd.text.includes('GEHEIMER'));
    // andere Sitzung DESSELBEN Nutzers → ebenfalls 404 (Bindung an die Sitzung, nicht nur an den Nutzer)
    const andere = await b2.get(`/api/agent-download?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(andere.status, 404);
    assert.equal(a.datenVerbindungen, 0, 'kein Datenkanal geöffnet');
    // Besitzer lädt → 200 mit gemerkten Kopfzeilen; Datenkanal-Kopf {ticket, nutzer}
    const d = await b.get(`/api/agent-download?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(d.status, 200);
    assert.equal(d.kopf['content-type'], 'application/zstd');
    assert.match(d.kopf['content-disposition'], /^attachment; filename="fahnas-konfig-geheim\.tar\.zst"/);
    assert.equal(d.kopf['content-length'], String(a.exportInhalt.length));
    assert.ok(d.body.equals(a.exportInhalt));
    assert.deepEqual(a.datenKoepfe.at(-1), { ticket, nutzer: 'fabian' });
    // zweiter Abruf durch den Besitzer: Merker verbraucht → 404 (das Agent-Ticket ist ohnehin einmalig)
    const nochmal = await b.get(`/api/agent-download?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(nochmal.status, 404);
    // Ticket ohne Metadaten (Ergebnis nur {ticket}): Dateiname/MIME aus der Anfrage, sonst Rückfall
    const roh = (await b.post('/api/agent/test.ticket_roh', {})).json.ergebnis.ticket;
    const r = await b.get(`/api/agent-download?ticket=${roh}&dateiname=${encodeURIComponent('bericht ü.txt')}&mime=text/plain`);
    assert.equal(r.status, 200); assert.equal(r.kopf['content-type'], 'text/plain'); assert.match(r.kopf['content-disposition'], /filename\*=UTF-8''bericht%20%C3%BC\.txt/); assert.equal(r.text, 'roh');
    const roh2 = (await b.post('/api/agent/test.ticket_roh', {})).json.ergebnis.ticket;
    const r2 = await b.get(`/api/agent-download?ticket=${roh2}&mime=<kaputt>`);
    assert.equal(r2.kopf['content-type'], 'application/octet-stream'); assert.match(r2.kopf['content-disposition'], /filename="download"/);
    // gemerkte Metadaten gewinnen gegen die Anfrage (der Browser kann den Dateinamen nicht umbiegen)
    const ex2 = await b.post('/api/agent/system.export', { mit_geheimnissen: false });
    const d2 = await b.get(`/api/agent-download?ticket=${encodeURIComponent(ex2.json.ergebnis.ticket)}&dateiname=boese.exe&mime=text/html`);
    assert.equal(d2.kopf['content-type'], 'application/zstd'); assert.match(d2.kopf['content-disposition'], /filename="fahnas-konfig\.tar\.zst"/);
    // Ticket, das nie über /api/agent dieser Sitzung kam (direkt beim Agenten angelegt, gültig!) → 404
    const direkt = a.ticketAnlegen({ nutzer: 'fabian', art: 'lesen', inhalt: Buffer.from('x') });
    assert.equal((await b.get(`/api/agent-download?ticket=${direkt}`)).status, 404);
    assert.ok(a.tickets.has(direkt), 'beim Agenten unangetastet');
    assert.equal((await b.get('/api/agent-download?ticket=kurz')).status, 400);
    assert.equal((await anfrage(port, 'GET', `/api/agent-download?ticket=${direkt}`)).status, 401, 'Sitzung nötig');
    // Import: Ticket holen; tina versucht, das Schreib-Ticket (uid 0) des Admins zu füllen → 404, nichts kommt an
    const daten = crypto.randomBytes(120_000);
    const tk = await b.post('/api/agent/system.import.ticket', { dateiname: 'sicherung.tar.zst', groesse: daten.length });
    assert.equal(tk.status, 200);
    const boese = await t.anfrage('POST', `/api/agent-upload?ticket=${encodeURIComponent(tk.json.ergebnis.ticket)}`, { body: Buffer.from('BOESE'), kopf: { 'content-type': 'application/octet-stream' } });
    assert.equal(boese.status, 404); assert.equal(boese.json.fehler.code, 'E_NICHT_GEFUNDEN');
    assert.equal(a.geschrieben.get('eingang/sicherung.tar.zst'), undefined, 'nichts beim Agenten angekommen');
    // Besitzer lädt hoch (CSRF nötig), Attrappe speichert 1:1
    const up = await b.anfrage('POST', `/api/agent-upload?ticket=${encodeURIComponent(tk.json.ergebnis.ticket)}`, { body: daten, kopf: { 'content-type': 'application/octet-stream' } });
    assert.equal(up.status, 200); assert.deepEqual(up.json, { ok: true, ergebnis: { groesse: daten.length, bestaetigt: true } });
    assert.ok(a.geschrieben.get('eingang/sicherung.tar.zst').equals(daten));
    assert.deepEqual(a.datenKoepfe.at(-1), { ticket: tk.json.ergebnis.ticket, nutzer: 'fabian' });
    const roh3 = (await b.post('/api/agent/test.ticket_roh', {})).json.ergebnis.ticket;
    const ohneCsrf = await anfrage(port, 'POST', `/api/agent-upload?ticket=${roh3}`, { kopf: { cookie: b.kopf().cookie }, body: Buffer.alloc(3) });
    assert.equal(ohneCsrf.status, 403);
    const chunked = await b.anfrage('POST', `/api/agent-upload?ticket=${roh3}`, { body: Buffer.alloc(3), kopf: { 'transfer-encoding': 'chunked' } });
    assert.equal(chunked.status, 400);
    assert.equal((await b.get(`/api/agent-download?ticket=${roh3}`)).status, 200, 'abgelehnte Anfragen verbrauchen das Ticket nicht');
    // Nutzer darf system.import.ticket nicht (Agent: E_RECHTE)
    assert.equal((await t.post('/api/agent/system.import.ticket', { dateiname: 'x', groesse: 1 })).status, 403);
    // dem Web-Dienst unbekanntes Ticket beim Hochladen → 404 (erreicht den Datenkanal nicht)
    const weg = await b.anfrage('POST', '/api/agent-upload?ticket=abgelaufen12345678', { body: Buffer.alloc(5) });
    assert.equal(weg.status, 404); assert.equal(weg.json.fehler.code, 'E_NICHT_GEFUNDEN');
    // beim Agenten abgelaufen, Web-Merker kennt es noch → Fehlerzeile des Datenkanals → 410 E_TICKET
    const tk3 = await b.post('/api/agent/system.import.ticket', { dateiname: 'alt.tar', groesse: 3 });
    a.tickets.delete(tk3.json.ergebnis.ticket);
    const abgelaufen = await b.anfrage('POST', `/api/agent-upload?ticket=${encodeURIComponent(tk3.json.ergebnis.ticket)}`, { body: Buffer.alloc(3) });
    assert.equal(abgelaufen.status, 410); assert.equal(abgelaufen.json.fehler.code, 'E_TICKET');
    // Agent lehnt den Nutzer im Kopf ab (Ticket gehört jemand anderem) → 410 E_TICKET, nichts geschrieben
    const tk4 = await b.post('/api/agent/system.import.ticket', { dateiname: 'fremd.tar', groesse: 3 });
    a.tickets.get(tk4.json.ergebnis.ticket).nutzer = 'jemand';
    const fremdAgent = await b.anfrage('POST', `/api/agent-upload?ticket=${encodeURIComponent(tk4.json.ergebnis.ticket)}`, { body: Buffer.alloc(3) });
    assert.equal(fremdAgent.status, 410); assert.equal(a.geschrieben.get('eingang/fremd.tar'), undefined);
    // ohne Antwortzeile (Grundlagen-Halbschluss, D1): 200 mit bestaetigt:false
    a.ohneAntwort = true;
    const tk2 = await b.post('/api/agent/system.import.ticket', { dateiname: 'still.tar.zst', groesse: 10 });
    const up2 = await b.anfrage('POST', `/api/agent-upload?ticket=${encodeURIComponent(tk2.json.ergebnis.ticket)}`, { body: Buffer.alloc(10, 7) });
    assert.equal(up2.status, 200); assert.deepEqual(up2.json.ergebnis, { groesse: 10, bestaetigt: false });
    assert.ok(a.geschrieben.get('eingang/still.tar.zst').equals(Buffer.alloc(10, 7)));
    // Web-Protokoll: fremde Zugriffe stehen als ticket_fremd drin, das Ticket geschwärzt
    await warte(150);
    const log = await webProtokoll(webOrdner);
    assert.match(log, /ticket_fremd \{"nutzer":"tina","ip":"127\.0\.0\.1","weg":"agent-download","ticket":"\*\*\*"\}/);
    assert.match(log, /ticket_fremd \{"nutzer":"tina","ip":"127\.0\.0\.1","weg":"agent-upload"/);
    assert.ok(!log.includes(ticket), 'Ticketzeichenkette steht nicht im Protokoll');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('statisch: index.html no-store + CSP, ETag/304, MIME, Pfadflucht/versteckt → 404 HTML', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const i = await anfrage(port, 'GET', '/');
    assert.equal(i.status, 200);
    assert.equal(i.kopf['content-type'], 'text/html; charset=utf-8');
    assert.equal(i.kopf['cache-control'], 'no-store');
    assert.equal(i.kopf['content-security-policy'], CSP);
    assert.match(i.kopf['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(i.kopf['x-content-type-options'], 'nosniff');
    assert.equal(i.kopf['referrer-policy'], 'no-referrer');
    assert.equal(i.kopf['permissions-policy'], PERMISSIONS_POLICY);
    assert.match(i.kopf['permissions-policy'], /camera=\(self\), microphone=\(self\), display-capture=\(self\)/);
    assert.match(i.kopf['permissions-policy'], /geolocation=\(\)/);
    assert.equal(i.kopf['strict-transport-security'], undefined, 'HSTS nur mit FAHNAS_HSTS=1');
    assert.match(i.text, /FAH-NAS/);
    assert.equal((await anfrage(port, 'GET', '/index.html')).status, 200);
    const js = await anfrage(port, 'GET', '/app.js');
    assert.equal(js.kopf['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.kopf['cache-control'], 'no-cache', 'immer nachfragen – nach einem Update sofort die neue Oberfläche (0.4.2)');
    assert.match(js.kopf.etag, /^"[A-Za-z0-9_-]{22}"$/);
    const nochmal = await anfrage(port, 'GET', '/app.js', { kopf: { 'if-none-match': js.kopf.etag } });
    assert.equal(nochmal.status, 304); assert.equal(nochmal.body.length, 0);
    assert.equal((await anfrage(port, 'GET', '/stil.css')).kopf['content-type'], 'text/css; charset=utf-8');
    assert.equal((await anfrage(port, 'GET', '/ansichten/dashboard.js')).status, 200);
    // Vertrag §5: /public/* zeigt auf denselben Ordner (index.html verweist auf /public/app.js usw.)
    const pub = await anfrage(port, 'GET', '/public/app.js');
    assert.equal(pub.status, 200); assert.equal(pub.kopf.etag, js.kopf.etag);
    assert.equal((await anfrage(port, 'GET', '/public/ansichten/dashboard.js')).status, 200);
    assert.equal((await anfrage(port, 'GET', '/public/index.html')).kopf['cache-control'], 'no-store');
    for (const p of ['/public/../package.json', '/public/.versteckt', '/public', '/public/']) assert.equal((await anfrage(port, 'GET', p)).status, 404, p);
    const kopf = await anfrage(port, 'HEAD', '/app.js');
    assert.equal(kopf.status, 200); assert.equal(kopf.body.length, 0); assert.equal(kopf.kopf['content-length'], js.kopf['content-length']);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/ansichten/../../package.json', '/.versteckt', '/%00', '/ansichten/', '/gibtsnicht.js', '/a\\b']) {
      const r = await anfrage(port, 'GET', p);
      assert.equal(r.status, 404, p);
      assert.equal(r.kopf['content-type'], 'text/html; charset=utf-8', p);
      assert.match(r.text, /404/);
    }
    assert.equal((await anfrage(port, 'POST', '/app.js', { body: 'x' })).status, 405);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

function sseLesen(port, kopf, bedingung, zeit_ms = 3000) {
  return new Promise((ok, nein) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ereignisse', headers: kopf }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); return nein(new Error(`Status ${res.statusCode}`)); }
      res.on('data', (d) => { text += d; if (bedingung(text)) { req.destroy(); ok({ text, kopf: res.headers }); } });
      res.on('end', () => ok({ text, kopf: res.headers }));
    });
    req.on('error', () => ok({ text }));
    req.end();
    setTimeout(() => { req.destroy(); nein(new Error('SSE: Bedingung nicht erfüllt: ' + text.slice(0, 500))); }, zeit_ms).unref();
  });
}

function sseEreignisse(text) {
  return text.split('\n\n').filter((b) => b.includes('event:')).map((b) => {
    const art = /event: (.+)/.exec(b)[1]; const daten = /data: (.+)/.exec(b);
    return { art, daten: daten ? JSON.parse(daten[1]) : null };
  });
}

test('sse: messwerte jede Sekunde (hier 50 ms), Agent-Ereignisse gefiltert, Verlauf, Abmelden schließt den Strom', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { heartbeat_ms: 100 });
  try {
    const admin = new Browser(port); await admin.anmelden('fabian', 'geheim123');
    const tina = new Browser(port); await tina.anmelden('tina', 'tina1234'); await tina.post('/api/anmelden/totp', { code: '123456' });
    const m = await sseLesen(port, admin.kopf(), (t) => (t.match(/event: messwerte/g) || []).length >= 2);
    assert.equal(m.kopf['content-type'], 'text/event-stream; charset=utf-8');
    const er = sseEreignisse(m.text);
    assert.equal(er[0].art, 'agent'); assert.deepEqual(er[0].daten, { zustand: 'verbunden' });
    const mw = er.find((e) => e.art === 'messwerte').daten;
    for (const f of ['zeit', 'cpu', 'ram', 'platten', 'netz', 'temperatur', 'laufzeit_s']) assert.ok(f in mw, f);
    assert.ok(typeof mw.cpu.prozent === 'number' && mw.ram.gesamt > 0 && Array.isArray(mw.platten));
    // Ereignisse des Agenten: konfig an alle, aufgabe nur an Besitzer/Admin, Heartbeat
    const versprechenAdmin = sseLesen(port, admin.kopf(), (t) => t.includes('"aufgabe":"t-9"') && t.includes('"aufgabe":"t-8"') && t.includes('event: konfig') && t.includes('event: system') && t.includes(': heartbeat'));
    const versprechenTina = sseLesen(port, tina.kopf(), (t) => t.includes('event: konfig') && t.includes('"aufgabe":"t-8"'));
    await warte(80);
    a.ereignis({ ereignis: 'konfig', bereich: 'freigaben' });
    a.ereignis({ ereignis: 'aufgabe', aufgabe: 't-9', nutzer: 'fabian', status: 'fertig' });
    a.ereignis({ ereignis: 'aufgabe', aufgabe: 't-8', nutzer: 'tina', status: 'laeuft' });
    a.ereignis({ ereignis: 'system', art: 'platte_voll', daten: { prozent: 96 } });
    const [ta, tt] = await Promise.all([versprechenAdmin, versprechenTina]);
    const ea = sseEreignisse(ta.text); const et = sseEreignisse(tt.text);
    assert.ok(ea.some((e) => e.art === 'konfig' && e.daten.bereich === 'freigaben'));
    assert.ok(ea.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-9'));
    assert.ok(ea.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-8'), 'Admin sieht fremde Aufgaben');
    assert.ok(ea.some((e) => e.art === 'system' && e.daten.art === 'platte_voll'));
    assert.ok(et.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-8'));
    assert.ok(!et.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-9'), 'Nutzer sieht keine fremden Aufgaben');
    // Verlauf
    const v = await admin.get('/api/messwerte/verlauf');
    assert.equal(v.status, 200); assert.ok(Array.isArray(v.json.ergebnis) && v.json.ergebnis.length >= 2);
    assert.ok(v.json.ergebnis.length <= 600);
    // Abmelden schließt offene Ströme dieser Sitzung
    const strom = new Promise((ok) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/ereignisse', headers: tina.kopf() }, (res) => { res.on('end', () => ok('ende')); res.resume(); });
      req.on('error', () => ok('fehler')); req.end();
    });
    await warte(80);
    assert.equal(dienst.ereignisse.verbindungen.size, 1);
    await tina.post('/api/abmelden', {});
    assert.equal(await Promise.race([strom, warte(2000).then(() => 'zeit')]), 'ende');
    assert.equal(dienst.ereignisse.verbindungen.size, 0);
    assert.equal((await anfrage(port, 'GET', '/api/ereignisse')).status, 401);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('sse: Rolle wird beim Senden aus der Sitzung gelesen (Herabstufung wirkt sofort); Fehlerdetails von Aufgaben nur für Admins ungekürzt', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { heartbeat_ms: 100 });
  try {
    const admin = new Browser(port); await admin.anmelden('fabian', 'geheim123');
    const tina = new Browser(port); await tina.anmelden('tina', 'tina1234'); await tina.post('/api/anmelden/totp', { code: '123456' });
    const interna = { feld: 'x', befehl: ['rm', '-r', '/data/x'], pfad: '/data/x' };
    // Ströme öffnen, DANN den Admin herabstufen (wie nutzer.aendern es täte) – ohne Neuverbinden
    const stromAdmin = sseLesen(port, admin.kopf(), (t) => t.includes('"ende":1'));
    const stromTina = sseLesen(port, tina.kopf(), (t) => t.includes('"ende":1'));
    await warte(80);
    dienst.sitzungen.aktualisiereNutzer('fabian', { rolle: 'nutzer' });
    a.ereignis({ ereignis: 'aufgabe', aufgabe: 't-1', nutzer: 'tina', status: 'fehler', fehler: { code: 'E_SYSTEM', meldung: 'kaputt', details: interna } });
    a.ereignis({ ereignis: 'aufgabe', aufgabe: 't-2', nutzer: 'fabian', status: 'fertig' });
    a.ereignis({ ereignis: 'konfig', bereich: 'x', ende: 1 });
    const [ta, tt] = await Promise.all([stromAdmin, stromTina]);
    const ea = sseEreignisse(ta.text); const et = sseEreignisse(tt.text);
    assert.ok(!ea.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-1'), 'herabgestufter Ex-Admin sieht fremde Aufgaben nicht mehr');
    assert.ok(ea.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-2'), 'eigene Aufgaben weiterhin');
    assert.ok(ea.some((e) => e.art === 'konfig'));
    const t1 = et.find((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-1');
    assert.ok(t1, 'Besitzerin sieht ihre Aufgabe');
    assert.deepEqual(t1.daten.fehler, { code: 'E_SYSTEM', meldung: 'kaputt', details: { feld: 'x', protokoll: DETAILS_VERWEIS } }, 'Details für Nicht-Admins gekürzt');
    assert.ok(!tt.text.includes('/data/x'));
    assert.ok(!et.some((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-2'));
    // wieder Admin → volle Details fremder Aufgaben, ohne neu zu verbinden nötig zu sein
    const stromAdmin2 = sseLesen(port, admin.kopf(), (t) => t.includes('"ende":2'));
    await warte(80);
    dienst.sitzungen.aktualisiereNutzer('fabian', { rolle: 'admin' });
    a.ereignis({ ereignis: 'aufgabe', aufgabe: 't-3', nutzer: 'tina', status: 'fehler', fehler: { code: 'E_SYSTEM', meldung: 'k', details: interna } });
    a.ereignis({ ereignis: 'konfig', bereich: 'y', ende: 2 });
    const ea2 = sseEreignisse((await stromAdmin2).text);
    const t3 = ea2.find((e) => e.art === 'aufgabe' && e.daten.aufgabe === 't-3');
    assert.ok(t3); assert.deepEqual(t3.daten.fehler.details, interna, 'Admin bekommt alles');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('umleitung http → https: nur bekannte Hosts bleiben (Hostname, .local, erlaubte, erreichte IP); fremde Hosts → erreichte Adresse (keine offene Umleitung); Port fällt bei 443 weg', async () => {
  const s443 = umleitungsServer({ zielPort: 443, hostname: 'testbox', erlaubteHosts: ['mein-nas', 'böse;x', 42] });
  const s8443 = umleitungsServer({ zielPort: 8443, hostname: 'testbox' });
  await new Promise((ok) => s443.listen(0, ok)); await new Promise((ok) => s8443.listen(0, ok));
  try {
    const p1 = s443.address().port; const p2 = s8443.address().port;
    // bekannte Hosts: eigener Name, .local, erlaubte Zusatznamen (+ .local), localhost, erreichte IP
    const r = await anfrage(p1, 'GET', '/dateien?x=1&y=%C3%BC', { kopf: { host: `testbox:${p1}` } });
    assert.equal(r.status, 301); assert.equal(r.kopf.location, 'https://testbox/dateien?x=1&y=%C3%BC');
    assert.equal(r.kopf['x-content-type-options'], 'nosniff');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: 'testbox.local' } })).kopf.location, 'https://testbox.local/a');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: 'TESTBOX.local:80' } })).kopf.location, 'https://TESTBOX.local/a', 'Groß-/Kleinschreibung egal');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: 'mein-nas' } })).kopf.location, 'https://mein-nas/a');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: 'mein-nas.local' } })).kopf.location, 'https://mein-nas.local/a');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: 'localhost:8080' } })).kopf.location, 'https://localhost/a');
    assert.equal((await anfrage(p1, 'GET', '/a', { kopf: { host: `127.0.0.1:${p1}` } })).kopf.location, 'https://127.0.0.1/a', 'die IP, unter der uns der Client erreicht hat');
    const r2 = await anfrage(p2, 'GET', '/', { kopf: { host: '127.0.0.1' } });
    assert.equal(r2.kopf.location, 'https://127.0.0.1:8443/', 'anderer HTTPS-Port wird angehängt');
    // fremde Hosts (offene Umleitung, Prüfbericht R1 Fund 15 d) → Adresse, unter der der Client uns erreicht hat
    for (const host of ['nas.local', 'boese.example', '192.168.1.50', '[fd00::1]:80', 'testbox.evil.example', 'mein-nas.example']) {
      assert.equal((await anfrage(p1, 'GET', '/pfad', { kopf: { host } })).kopf.location, 'https://127.0.0.1/pfad', host);
    }
    const r4 = await rohAnfrage(p1, 'POST /api/anmelden HTTP/1.1\r\nHost: böse host;x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    assert.match(r4, /^HTTP\/1\.1 301/);
    assert.equal(rohKopf(r4, 'Location'), 'https://127.0.0.1/api/anmelden', 'ungültiger Host → erreichte Adresse');
    const r5 = await rohAnfrage(p1, 'GET / HTTP/1.0\r\n\r\n');
    assert.equal(rohKopf(r5, 'Location'), 'https://127.0.0.1/', 'ohne Host → erreichte Adresse');
    const r6 = await rohAnfrage(p1, 'GET /x HTTP/1.1\r\nHost: testbox\r\nConnection: close\r\n\r\n');
    assert.equal(rohKopf(r6, 'Location'), 'https://testbox/x');
  } finally {
    await new Promise((ok) => s443.close(ok)); await new Promise((ok) => s8443.close(ok));
  }
});

test('fehlerdetails: Nicht-Admins bekommen nur Whitelist-Felder + Verweis, Admins alles; der Rest steht im Web-Protokoll', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port, webOrdner } = await dienstStarten(a);
  try {
    const admin = new Browser(port); await admin.anmelden('fabian', 'geheim123');
    const tina = new Browser(port); await tina.anmelden('tina', 'tina1234'); await tina.post('/api/anmelden/totp', { code: '123456' });
    const interna = { feld: 'pfad', befehl: ['rm', '-r', '/data/shares/medien/x'], ausgabe: 'rm: cannot remove', pfad: '/data/shares/medien/x', grund: 'ENOENT' };
    const ra = await admin.post('/api/agent/test.fehler_details', {});
    assert.equal(ra.status, 500); assert.deepEqual(ra.json.fehler, { code: 'E_SYSTEM', meldung: 'Befehl fehlgeschlagen', details: interna }, 'Admin sieht alles');
    const rt = await tina.post('/api/agent/test.fehler_details', {});
    assert.equal(rt.status, 500);
    assert.deepEqual(rt.json.fehler, { code: 'E_SYSTEM', meldung: 'Befehl fehlgeschlagen', details: { feld: 'pfad', protokoll: DETAILS_VERWEIS } }, 'Nutzer: code + meldung + Whitelist + Verweis');
    assert.ok(!rt.text.includes('/data/shares') && !rt.text.includes('rm: cannot'), 'keine Interna an Nicht-Admins');
    // nur Whitelist-Felder → unverändert, ohne Verweis
    const rb = await tina.post('/api/agent/test.fehler', { code: 'E_PARAMS' });
    assert.deepEqual(rb.json.fehler.details, { feld: 'x' });
    const rr = await tina.post('/api/agent/test.admin', {});
    assert.deepEqual(rr.json.fehler.details, { aktion: 'test.admin', noetig: 'admin' });
    // Gast (ohne Sitzung): Fehler ohne details bleiben ohne details
    const g = await anfrage(port, 'GET', '/api/ich');
    assert.equal(g.status, 401); assert.equal(g.json.fehler.details, undefined);
    // Web-Protokoll hält die weggelassenen Angaben für den Admin fest
    await warte(150);
    const log = await webProtokoll(webOrdner);
    const zeile = log.split('\n').find((z) => z.includes(' fehler_details '));
    assert.ok(zeile, 'fehler_details im Protokoll');
    const eintrag = JSON.parse(zeile.slice(zeile.indexOf('{')));
    assert.equal(eintrag.fehlerart, 'E_SYSTEM'); assert.equal(eintrag.nutzer, 'tina'); assert.equal(eintrag.rolle, 'nutzer'); assert.equal(eintrag.pfad, '/api/agent/test.fehler_details');
    assert.deepEqual(eintrag.details, { befehl: interna.befehl, ausgabe: interna.ausgabe, pfad: interna.pfad, grund: interna.grund });
    assert.equal(log.split('\n').filter((z) => z.includes(' fehler_details ')).length, 1, 'für den Admin wird nichts weggelassen, also nichts protokolliert');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('webprotokoll: Rotation läuft im Betrieb (Timer), nicht nur beim Start', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, webOrdner } = await dienstStarten(a, { rotation_ms: 60 });
  try {
    await fs.writeFile(path.join(webOrdner, 'web-2020-01.log'), 'alt\n');
    await warte(250);
    assert.ok(!(await fs.readdir(webOrdner)).includes('web-2020-01.log'), 'alter Monat wurde im Betrieb gelöscht');
    assert.ok(dienst.rotationTimer, 'Timer läuft');
  } finally { await dienst.stoppen(); await a.stoppen(); }
  assert.equal(dienst.rotationTimer, null, 'Timer beim Stoppen entfernt');
});

test('vertraute proxys: X-Forwarded-For nur von eingetragenen Adressen; Bremse und Kontext-IP folgen der Client-IP', async () => {
  // ohne vertraute Proxys: X-Forwarded-For wird ignoriert
  const a = await standardAttrappe(await tmp());
  const ohne = await dienstStarten(a);
  try {
    const b = new Browser(ohne.port); await b.anmelden('fabian', 'geheim123');
    const e = await b.post('/api/agent/test.echo', {}, { 'x-forwarded-for': '203.0.113.5' });
    assert.equal(e.json.ergebnis.kontext.ip, '127.0.0.1');
  } finally { await ohne.dienst.stoppen(); }
  // mit 127.0.0.1 (und einem IPv6-Netz) als vertrautem Proxy
  const mit = await dienstStarten(a, { system: { vertraute_proxys: ['127.0.0.1', 'fd00::/8', 'quatsch'], sprache: 'de', design: 'dunkel' } });
  try {
    const b = new Browser(mit.port); await b.anmelden('fabian', 'geheim123');
    assert.equal((await b.get('/api/ich')).json.ergebnis.design, 'dunkel', 'system.json wird lesend benutzt');
    const e = await b.post('/api/agent/test.echo', {}, { 'x-forwarded-for': '203.0.113.5' });
    assert.equal(e.json.ergebnis.kontext.ip, '203.0.113.5');
    const kette = await b.post('/api/agent/test.echo', {}, { 'x-forwarded-for': '198.51.100.7, fd00::9, 127.0.0.1' });
    assert.equal(kette.json.ergebnis.kontext.ip, '198.51.100.7', 'von rechts der erste nicht vertraute Eintrag');
    const kaputt = await b.post('/api/agent/test.echo', {}, { 'x-forwarded-for': 'kein-ip' });
    assert.equal(kaputt.json.ergebnis.kontext.ip, '127.0.0.1');
    // Bremse je weitergeleiteter IP (Heimnetz-Adressen; aus dem Internet gilt der Anmeldeschutz): 5 Fehler von A sperren A, nicht B
    for (let i = 0; i < 5; i++) {
      const r = await anfrage(mit.port, 'POST', '/api/anmelden', { kopf: { 'x-forwarded-for': '10.9.8.5' }, body: { name: `n${i}x`, passwort: 'falsch' } });
      assert.equal(r.status, 401);
    }
    const gesperrt = await anfrage(mit.port, 'POST', '/api/anmelden', { kopf: { 'x-forwarded-for': '10.9.8.5' }, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(gesperrt.status, 429);
    const frei = await anfrage(mit.port, 'POST', '/api/anmelden', { kopf: { 'x-forwarded-for': '10.9.8.6' }, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(frei.status, 200);
    assert.ok(mit.dienst.bremse.eintraege.ip['10.9.8.5']);
    assert.equal(mit.dienst.bremse.eintraege.ip['127.0.0.1'], undefined);
  } finally { await mit.dienst.stoppen(); await a.stoppen(); }
});

test('/api/ich: zugang – über einen Reverse-Proxy (X-Forwarded-For/X-Real-IP/Forwarded) mit der Adresse des NAS, direkt ohne', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const direkt = (await b.get('/api/ich')).json.ergebnis.zugang;
    assert.deepEqual(direkt, { ueber_proxy: false, nas_adresse: '127.0.0.1', link_basis: null }, 'Zieladresse der Verbindung, IPv4-Abbild ohne ::ffff:');
    for (const kopf of [{ 'X-Forwarded-For': '192.168.1.79' }, { 'X-Real-IP': '192.168.1.79' }, { Forwarded: 'for=192.168.1.79;proto=https' }]) {
      const z = (await b.get('/api/ich', kopf)).json.ergebnis.zugang;
      assert.deepEqual(z, { ueber_proxy: true, nas_adresse: '127.0.0.1', link_basis: null }, JSON.stringify(kopf));
    }
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('/api/dateien/vorschau: Bildantwort aus dateien.vorschau (Bytes, MIME, 7 Tage Cache, CSP), Parameterprüfung, Fehler als JSON, nur mit Sitzung', async () => {
  const a = await standardAttrappe(await tmp());
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3, 255]);
  a.aktion('dateien.vorschau', { rolle: 'nutzer', fn: ({ freigabe, pfad, groesse }) => {
    if (pfad === 'kaputt.jpg') throw new FahnasFehler('E_SYSTEM', 'Vorschaubild konnte nicht erzeugt werden', { ausgabe: 'geheim', hinweis: 'Hinweis' });
    if (pfad === 'leer.jpg') return { mime: 'image/webp', daten: '' };
    if (pfad === 'boese.jpg') return { mime: 'text/html', daten: bytes.toString('base64') };
    return { mime: 'image/webp', daten: bytes.toString('base64'), groesse, aus_cache: false, freigabe };
  } });
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('tina', 'tina1234'); await b.post('/api/anmelden/totp', { code: '123456' });
    const r = await b.get('/api/dateien/vorschau?freigabe=medien&pfad=urlaub%2Fstrand.jpg&groesse=512&v=123-4');
    assert.equal(r.status, 200);
    assert.equal(r.kopf['content-type'], 'image/webp');
    assert.equal(r.kopf['content-length'], String(bytes.length));
    assert.equal(r.kopf['cache-control'], 'private, max-age=604800, immutable');
    assert.equal(r.kopf['content-disposition'], 'inline');
    assert.match(r.kopf['content-security-policy'], /default-src 'none'/);
    assert.equal(r.kopf['x-content-type-options'], 'nosniff');
    assert.ok(r.body.equals(bytes), 'Bytes 1:1');
    const ausgeloest = a.anfragen.find((x) => x.aktion === 'dateien.vorschau');
    assert.deepEqual(ausgeloest.params, { freigabe: 'medien', pfad: 'urlaub/strand.jpg', groesse: 512 });
    assert.equal(ausgeloest.kontext.nutzer, 'tina');
    // Standardgröße 256 ohne groesse=
    assert.equal((await b.get('/api/dateien/vorschau?freigabe=medien&pfad=a.jpg')).status, 200);
    assert.equal(a.anfragen.filter((x) => x.aktion === 'dateien.vorschau').pop().params.groesse, 256);
    // Parameterfehler kommen vor dem Agenten
    const n = a.anfragen.filter((x) => x.aktion === 'dateien.vorschau').length;
    for (const q of ['freigabe=medien&pfad=a.jpg&groesse=300', 'freigabe=medien&pfad=&groesse=256', 'freigabe=medien&groesse=256', 'freigabe=Medien!&pfad=a.jpg', 'freigabe=medien&pfad=..%2Fa.jpg']) {
      const f = await b.get(`/api/dateien/vorschau?${q}`);
      assert.equal(f.status, 400, q); assert.equal(f.json.fehler.code, 'E_PARAMS', q);
    }
    assert.equal(a.anfragen.filter((x) => x.aktion === 'dateien.vorschau').length, n);
    // Fehler des Agenten → JSON; Interna (ausgabe) nicht an Nutzer, hinweis schon
    const k = await b.get('/api/dateien/vorschau?freigabe=medien&pfad=kaputt.jpg');
    assert.ok(k.status >= 500); assert.equal(k.json.fehler.code, 'E_SYSTEM'); assert.equal(k.json.fehler.details.ausgabe, undefined); assert.equal(k.json.fehler.details.hinweis, 'Hinweis');
    const leer = await b.get('/api/dateien/vorschau?freigabe=medien&pfad=leer.jpg');
    assert.equal(leer.json.fehler.code, 'E_AGENT');
    const boese = await b.get('/api/dateien/vorschau?freigabe=medien&pfad=boese.jpg');
    assert.equal(boese.status, 200); assert.equal(boese.kopf['content-type'], 'image/jpeg', 'fremder MIME-Typ wird nicht übernommen');
    // ohne Sitzung
    const ohne = await anfrage(port, 'GET', '/api/dateien/vorschau?freigabe=medien&pfad=a.jpg');
    assert.equal(ohne.status, 401);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('web: bereichAusRange – Spulen in Videos (ein Bereich, offen, Suffix, unerfüllbar, ungeeignet)', async () => {
  const { bereichAusRange } = await import('../../src/web/api/dateien.js');
  assert.deepEqual(bereichAusRange('bytes=0-', 1000), { start: 0, ende: 999 });
  assert.deepEqual(bereichAusRange('bytes=100-199', 1000), { start: 100, ende: 199 });
  assert.deepEqual(bereichAusRange('bytes=900-5000', 1000), { start: 900, ende: 999 }, 'Ende über die Größe → abgeschnitten');
  assert.deepEqual(bereichAusRange('bytes=-100', 1000), { start: 900, ende: 999 });
  assert.deepEqual(bereichAusRange('bytes=1000-', 1000), { unerfuellbar: true });
  assert.deepEqual(bereichAusRange('bytes=-0', 1000), { unerfuellbar: true });
  assert.equal(bereichAusRange('bytes=0-1,5-6', 1000), null, 'mehrere Bereiche → ganze Datei');
  assert.equal(bereichAusRange('bytes=200-100', 1000), null);
  assert.equal(bereichAusRange(undefined, 1000), null);
  assert.equal(bereichAusRange('items=0-1', 1000), null);
});
