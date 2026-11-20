// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Anmeldung/Sitzung: richtig, falsch, Bremse, CSRF, Ablauf, TOTP-Stufe, Abmelden, Sitzungen beenden,
// Nachwirkungen von Nutzeränderungen, Ersteinrichtung, Web-Protokoll, Sitzungen überleben einen Neustart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmp, warte, standardAttrappe, dienstStarten, Browser, anfrage } from './web_hilfen.js';
import { WebDienst } from '../../src/web/web.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

async function webProtokoll(webOrdner) {
  const dateien = (await fs.readdir(webOrdner)).filter((d) => /^web-\d{4}-\d{2}\.log$/.test(d));
  let text = '';
  for (const d of dateien) text += await fs.readFile(path.join(webOrdner, d), 'utf8');
  return text;
}

test('anmelden: richtig → Cookies + /api/ich; Kontext (nutzer, rolle, ip) kommt aus der Sitzung', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port);
    const r = await b.anmelden('Fabian', 'geheim123');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true); assert.equal(r.json.totp_noetig, false);
    const sitzungCookie = r.setCookie.find((c) => c.startsWith('fahnas_sitzung='));
    const csrfCookie = r.setCookie.find((c) => c.startsWith('fahnas_csrf='));
    assert.ok(sitzungCookie && /HttpOnly/.test(sitzungCookie) && /SameSite=Lax/.test(sitzungCookie) && /Path=\//.test(sitzungCookie));
    assert.ok(!/Secure/.test(sitzungCookie), 'ohne TLS kein Secure');
    assert.ok(!/Max-Age/.test(sitzungCookie), 'ohne „bleiben“ ein Browser-Sitzungs-Cookie');
    assert.ok(csrfCookie && !/HttpOnly/.test(csrfCookie));
    assert.equal(b.glas.get('fahnas_sitzung').length, 43, '32 Byte base64url');

    const ich = await b.get('/api/ich');
    assert.equal(ich.status, 200);
    assert.deepEqual(ich.json.ergebnis, { name: 'fabian', anzeigename: 'Fabian H.', rolle: 'admin', totp: false, sprache: 'de', design: 'auto', zugang: { ueber_proxy: false, nas_adresse: '127.0.0.1', link_basis: null }, abmelden: null });
    assert.equal(ich.kopf['cache-control'], 'no-store');

    const echo = await b.post('/api/agent/test.echo', { hallo: 'welt', zahl: 5 });
    assert.equal(echo.status, 200);
    assert.deepEqual(echo.json.ergebnis.params, { hallo: 'welt', zahl: 5 });
    assert.deepEqual(echo.json.ergebnis.kontext, { nutzer: 'fabian', rolle: 'admin', ip: '127.0.0.1' });
    // der Agent bekam nutzer.pruefen mit Rolle gast, nie mit Passwort im Kontext
    const pruef = a.anfragen.find((x) => x.aktion === 'nutzer.pruefen');
    assert.deepEqual(pruef.kontext, { nutzer: 'web', rolle: 'gast', ip: '127.0.0.1' });
    assert.deepEqual(pruef.params, { name: 'fabian', passwort: 'geheim123' });

    // angemeldet bleiben → dauerhaftes Cookie (400 Tage); die Sitzung selbst endet nach 30 Tagen ohne Bedienung (Server)
    const b2 = new Browser(port);
    const r2 = await b2.anmelden('fabian', 'geheim123', true);
    assert.ok(r2.setCookie.find((c) => c.startsWith('fahnas_sitzung=') && /Max-Age=34560000/.test(c)));
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('anmelden: falsch → 401; nach 5 Fehlern Bremse 429 mit warte_s; auch richtiges Passwort ist dann gesperrt', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port, webOrdner } = await dienstStarten(a);
  try {
    const b = new Browser(port);
    for (let i = 0; i < 4; i++) {
      const r = await b.anmelden('fabian', 'falsch');
      assert.equal(r.status, 401); assert.equal(r.json.fehler.code, 'E_ANMELDUNG');
      assert.equal(r.setCookie.length, 0);
    }
    const r5 = await b.anmelden('fabian', 'falsch');
    assert.equal(r5.status, 401);
    const r6 = await b.anmelden('fabian', 'geheim123');
    assert.equal(r6.status, 429); assert.equal(r6.json.fehler.code, 'E_BREMSE');
    assert.ok(r6.json.fehler.details.warte_s >= 1 && r6.json.fehler.details.warte_s <= 30);
    // gesperrte Versuche erreichen den Agenten nicht
    assert.equal(a.anfragen.filter((x) => x.aktion === 'nutzer.pruefen').length, 5);
    // unbekannter Nutzer / ungültiger Name zählt ebenfalls, ohne den Agenten zu fragen
    const r7 = await b.anmelden('../etc', 'x');
    assert.equal(r7.status, 429);
    // Zustand liegt auf der Platte
    await warte(300);
    const bremse = JSON.parse(await fs.readFile(path.join(webOrdner, 'bremse.json'), 'utf8'));
    assert.ok(bremse.ip['127.0.0.1'] && bremse.ip['127.0.0.1'].bis > Date.now());
    assert.ok(bremse.nutzer.fabian);
    // Web-Protokoll hat die Fehlversuche, der Agent nicht
    const protokolle = (await fs.readdir(webOrdner)).filter((d) => /^web-\d{4}-\d{2}\.log$/.test(d));
    assert.equal(protokolle.length, 1);
    const text = await fs.readFile(path.join(webOrdner, protokolle[0]), 'utf8');
    assert.ok(text.includes('anmeldung_fehler'));
    assert.ok(!text.includes('falsch"'), 'Passwörter stehen nicht im Protokoll');
    // Bremse lösen (Erfolg setzt zurück) → Anmeldung geht wieder
    dienst.bremse.erfolg('127.0.0.1', 'fabian'); dienst.bremse.erfolg('127.0.0.1', '../etc');
    const r8 = await b.anmelden('fabian', 'geheim123');
    assert.equal(r8.status, 200);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('csrf: schreibende Anfragen ohne/mit falschem Header → 403 E_CSRF; Anmelden von fremder Herkunft → 403', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port);
    await b.anmelden('fabian', 'geheim123');
    const ohne = await anfrage(port, 'POST', '/api/agent/test.echo', { kopf: { cookie: b.kopf().cookie }, body: {} });
    assert.equal(ohne.status, 403); assert.equal(ohne.json.fehler.code, 'E_CSRF');
    const falsch = await anfrage(port, 'POST', '/api/agent/test.echo', { kopf: { cookie: b.kopf().cookie, 'x-fahnas-csrf': 'x'.repeat(32) }, body: {} });
    assert.equal(falsch.status, 403);
    // Header passt zum Cookie, aber nicht zur Sitzung (gefälschtes Cookie-Paar)
    const gefaelscht = await anfrage(port, 'POST', '/api/agent/test.echo', { kopf: { cookie: `fahnas_sitzung=${b.glas.get('fahnas_sitzung')}; fahnas_csrf=abc`, 'x-fahnas-csrf': 'abc' }, body: {} });
    assert.equal(gefaelscht.status, 403);
    const richtig = await b.post('/api/agent/test.echo', {});
    assert.equal(richtig.status, 200);
    assert.equal(a.anfragen.filter((x) => x.aktion === 'test.echo').length, 1, 'abgelehnte Anfragen erreichen den Agenten nicht');
    // GET braucht kein CSRF
    assert.equal((await b.get('/api/ich')).status, 200);
    // Herkunft ohne Sitzung
    const fremd = await anfrage(port, 'POST', '/api/anmelden', { kopf: { origin: 'https://boese.example' }, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(fremd.status, 403); assert.equal(fremd.json.fehler.code, 'E_CSRF');
    const cross = await anfrage(port, 'POST', '/api/anmelden', { kopf: { 'sec-fetch-site': 'cross-site' }, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(cross.status, 403);
    const eigen = await anfrage(port, 'POST', '/api/anmelden', { kopf: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` }, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(eigen.status, 200);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('sitzung läuft ab (gleitend) → 401 E_ANMELDUNG; Bereinigung entfernt sie aus dem Speicher', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { sitzungen: { ablauf_ms: 300, bereinigung_ms: 100 } });
  try {
    const b = new Browser(port);
    await b.anmelden('fabian', 'geheim123');
    assert.equal((await b.get('/api/ich')).status, 200);
    await warte(200);
    assert.equal((await b.get('/api/ich')).status, 200, 'Zugriff verlängert gleitend');
    await warte(450);
    const r = await b.get('/api/ich');
    assert.equal(r.status, 401); assert.equal(r.json.fehler.code, 'E_ANMELDUNG');
    assert.equal(dienst.sitzungen.alle.size, 0);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('automatisch abmelden: eigene Zeit gilt sofort für alle eigenen Sitzungen, „nie“ hält, Standard wie bisher, übersteht Neustart', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port, webOrdner } = await dienstStarten(a, { sitzungen: { ablauf_ms: 300, bereinigung_ms: 100 } });
  try {
    const b = new Browser(port); const anders = new Browser(port);
    await b.anmelden('fabian', 'geheim123'); await anders.anmelden('fabian', 'geheim123');
    assert.equal((await b.post('/api/sitzung/abmelden', { minuten: 7 })).status, 400, 'nur die angebotenen Stufen');
    const r = await b.post('/api/sitzung/abmelden', { minuten: 0 });
    assert.equal(r.status, 200); assert.equal(r.json.ergebnis.abmelden, 0);
    assert.ok(r.setCookie.find((c) => c.startsWith('fahnas_sitzung=') && /Max-Age=34560000/.test(c)), 'eigene Zeit → Cookie überlebt den Browserstart');
    assert.equal((await b.get('/api/ich')).json.ergebnis.abmelden, 0);
    await warte(500);
    assert.equal((await b.get('/api/ich')).status, 200, '„nie“: kein Ablauf nach Standardzeit');
    assert.equal((await anders.get('/api/ich')).status, 200, 'gilt auch für die anderen Geräte');
    const datei = JSON.parse(await fs.readFile(path.join(webOrdner, 'abmelden.json'), 'utf8'));
    assert.deepEqual(datei.nutzer, { fabian: 0 });
    assert.equal(dienst.sitzungen.abmeldenVon('fabian'), 0);
    await dienst.sitzungen.laden(); // erneutes Laden behält die Wahl
    assert.equal(dienst.sitzungen.abmeldenVon('fabian'), 0);
    // zurück auf Standard → wieder die Standardzeit (hier 300 ms) und Browser-Sitzungs-Cookie
    const s = await b.post('/api/sitzung/abmelden', { minuten: null });
    assert.equal(s.json.ergebnis.abmelden, null);
    assert.ok(s.setCookie.find((c) => c.startsWith('fahnas_sitzung=') && !/Max-Age/.test(c)));
    await warte(500);
    assert.equal((await b.get('/api/ich')).status, 401);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('totp: offene Stufe sperrt die API (401 E_TOTP), falscher Code zählt in die Bremse, richtiger Code öffnet', async () => {
  const a = await standardAttrappe(await tmp());
  // Zweiter Faktor gilt nur von außen (16.10.2026) → Zugriff „aus dem Internet“, ohne Ländersperre
  const { dienst, port } = await dienstStarten(a, { anmeldeschutz: { extern: () => true }, system: { anmeldeschutz: { laender: [] } } });
  try {
    const b = new Browser(port);
    const r = await b.anmelden('tina', 'tina1234');
    assert.equal(r.status, 200); assert.equal(r.json.totp_noetig, true);
    const ich = await b.get('/api/ich');
    assert.equal(ich.status, 401); assert.equal(ich.json.fehler.code, 'E_TOTP');
    const agent = await b.post('/api/agent/test.echo', {});
    assert.equal(agent.status, 401); assert.equal(agent.json.fehler.code, 'E_TOTP');
    const sse = await b.get('/api/ereignisse');
    assert.equal(sse.status, 401);
    const falsch = await b.post('/api/anmelden/totp', { code: '000000' });
    assert.equal(falsch.status, 401); assert.equal(falsch.json.fehler.code, 'E_TOTP');
    assert.ok(dienst.schutz.bremse.eintraege.nutzer['@internet:tina'].fehler === 1, 'aus dem Internet zählt die strenge Bremse');
    const richtig = await b.post('/api/anmelden/totp', { code: '123 456' });
    assert.equal(richtig.status, 200);
    const ich2 = await b.get('/api/ich');
    assert.equal(ich2.status, 200); assert.equal(ich2.json.ergebnis.totp, true); assert.equal(ich2.json.ergebnis.rolle, 'nutzer');
    const pruef = a.anfragen.filter((x) => x.aktion === 'nutzer.totp.pruefen').at(-1);
    assert.deepEqual(pruef.params, { name: 'tina', code: '123456' }); assert.equal(pruef.kontext.rolle, 'gast');
    // Abmelden ist auch mit offener Stufe erlaubt (eigene Sitzung)
    const b2 = new Browser(port); await b2.anmelden('tina', 'tina1234');
    assert.equal((await b2.post('/api/abmelden', {})).status, 200);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('abmelden löscht Sitzung und Cookies; /api/ich danach 401; Sitzungen anderer Geräte beenden', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); const b2 = new Browser(port); const t = new Browser(port);
    await b.anmelden('fabian', 'geheim123'); await b2.anmelden('fabian', 'geheim123'); await t.anmelden('tina', 'tina1234');
    await t.post('/api/anmelden/totp', { code: '123456' });
    const liste = await b.get('/api/sitzungen');
    assert.equal(liste.json.ergebnis.length, 3, 'Admin sieht alle');
    assert.equal(liste.json.ergebnis.filter((s) => s.aktuell).length, 1);
    assert.ok(liste.json.ergebnis.every((s) => s.kennung.length === 10), 'keine vollen IDs');
    const eigene = await t.get('/api/sitzungen');
    assert.equal(eigene.json.ergebnis.length, 1, 'Nutzer nur eigene');
    const verboten = await t.post('/api/sitzungen/beenden', { nutzer: 'fabian' });
    assert.equal(verboten.status, 403);
    const andere = await b.post('/api/sitzungen/beenden', { alle_anderen: true });
    assert.equal(andere.json.ergebnis.beendet, 1);
    assert.equal((await b2.get('/api/ich')).status, 401);
    assert.equal((await b.get('/api/ich')).status, 200);
    const tina = await b.post('/api/sitzungen/beenden', { nutzer: 'tina' });
    assert.equal(tina.json.ergebnis.beendet, 1);
    assert.equal((await t.get('/api/ich')).status, 401);
    const ab = await b.post('/api/abmelden', {});
    assert.equal(ab.status, 200);
    assert.ok(ab.setCookie.some((c) => c.startsWith('fahnas_sitzung=;') && /Max-Age=0/.test(c)));
    assert.equal(b.glas.has('fahnas_sitzung'), false);
    assert.equal((await b.get('/api/ich')).status, 401);
    assert.equal(dienst.sitzungen.alle.size, 0);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('Geräte: neue Anmeldung am selben Gerät ersetzt die alte, Geräte-Cookie überlebt das Abmelden, alte Sitzung ohne Gerät wird gebunden', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port);
    const r1 = await b.anmelden('fabian', 'geheim123');
    assert.ok(r1.setCookie.some((c) => /^fahnas_geraet=[A-Za-z0-9_-]{32}; /.test(c) && /HttpOnly/.test(c) && /Max-Age=34560000/.test(c)));
    const geraet = b.glas.get('fahnas_geraet');
    const alt = b.glas.get('fahnas_sitzung');
    for (let i = 0; i < 4; i++) await b.anmelden('fabian', 'geheim123'); // z. B. nach Cookie-Verlust oder Neuanmeldung
    assert.equal(dienst.sitzungen.liste('fabian').length, 1, 'je Gerät eine Sitzung');
    assert.equal(b.glas.get('fahnas_geraet'), geraet, 'Gerät bleibt dasselbe');
    assert.equal(dienst.sitzungen.hole(alt), null, 'alte Sitzung beendet');
    // anderer Nutzer am selben Gerät verdrängt fabian nicht
    const t = new Browser(port); t.glas.set('fahnas_geraet', geraet);
    await t.anmelden('tina', 'tina1234');
    assert.equal(dienst.sitzungen.liste('fabian').length, 1);
    // zweites Gerät zählt extra; Liste trägt nur einen kurzen Fingerabdruck des Geräts
    const b2 = new Browser(port); await b2.anmelden('fabian', 'geheim123');
    const liste = (await b.get('/api/sitzungen')).json.ergebnis.filter((s) => s.nutzer === 'fabian');
    assert.equal(liste.length, 2); assert.equal(new Set(liste.map((s) => s.geraet)).size, 2);
    assert.ok(liste.every((s) => s.geraet.length === 10 && !s.geraet.includes(geraet.slice(0, 10))));
    // Abmelden löscht das Geräte-Cookie nicht – die nächste Anmeldung ist wieder dasselbe Gerät
    await b.post('/api/abmelden', {});
    assert.equal(b.glas.get('fahnas_geraet'), geraet);
    // Sitzung von vor der Änderung (ohne Gerät): /api/ich bindet sie an das Gerät des Browsers
    const s = dienst.sitzungen.anlegen({ nutzer: 'fabian', rolle: 'admin' });
    const c = new Browser(port); c.glas.set('fahnas_sitzung', s.id); c.glas.set('fahnas_geraet', geraet);
    assert.equal((await c.get('/api/ich')).status, 200);
    assert.equal(dienst.sitzungen.alle.get(s.id).geraet, geraet);
    await c.anmelden('fabian', 'geheim123');
    assert.equal(dienst.sitzungen.hole(s.id), null, 'gebundene Altsitzung wird beim nächsten Anmelden ersetzt');
    // kaputtes Geräte-Cookie → neue Kennung
    const k = new Browser(port); k.glas.set('fahnas_geraet', 'x;y');
    await k.anmelden('fabian', 'geheim123');
    assert.match(k.glas.get('fahnas_geraet'), /^[A-Za-z0-9_-]{32}$/);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('nachwirkung: Admin ändert Rolle/Sperre/Passwort über /api/agent → Sitzungen des Nutzers folgen sofort', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const admin = new Browser(port); const tina = new Browser(port);
    await admin.anmelden('fabian', 'geheim123');
    await tina.anmelden('tina', 'tina1234'); await tina.post('/api/anmelden/totp', { code: '123456' });
    assert.equal((await tina.post('/api/agent/test.admin', {})).status, 403);
    assert.equal((await admin.post('/api/agent/nutzer.aendern', { name: 'tina', rolle: 'admin', anzeigename: 'Tina T.' })).status, 200);
    const ich = await tina.get('/api/ich');
    assert.equal(ich.json.ergebnis.rolle, 'admin'); assert.equal(ich.json.ergebnis.anzeigename, 'Tina T.');
    assert.equal((await tina.post('/api/agent/test.admin', {})).status, 200);
    // Passwort durch Admin gesetzt → Tinas Sitzungen enden
    assert.equal((await admin.post('/api/agent/nutzer.passwort', { name: 'tina', passwort: 'neuneuneu' })).status, 200);
    assert.equal((await tina.get('/api/ich')).status, 401);
    // eigenes Passwort → nur andere Sitzungen enden
    const admin2 = new Browser(port); await admin2.anmelden('fabian', 'geheim123');
    await admin.post('/api/agent/nutzer.passwort', { name: 'fabian', passwort: 'geheim456', altes_passwort: 'geheim123' });
    assert.equal((await admin.get('/api/ich')).status, 200);
    assert.equal((await admin2.get('/api/ich')).status, 401);
    // Sperre und Löschen
    const t2 = new Browser(port); await t2.anmelden('tina', 'neuneuneu'); await t2.post('/api/anmelden/totp', { code: '123456' });
    await admin.post('/api/agent/nutzer.aendern', { name: 'tina', gesperrt: true });
    assert.equal((await t2.get('/api/ich')).status, 401);
    const t3 = new Browser(port); await t3.anmelden('tina', 'neuneuneu'); await t3.post('/api/anmelden/totp', { code: '123456' });
    await admin.post('/api/agent/nutzer.loeschen', { name: 'tina', dateien: 'behalten' });
    assert.equal((await t3.get('/api/ich')).status, 401);
    assert.equal(dienst.sitzungen.liste('tina').length, 0);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('nachwirkung: umbenennen beendet alle Sitzungen des alten Namens; Abmelde-Zeit und Hintergrundbilder ziehen mit', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    const admin = new Browser(port); const tina = new Browser(port);
    await admin.anmelden('fabian', 'geheim123');
    await tina.anmelden('tina', 'tina1234'); await tina.post('/api/anmelden/totp', { code: '123456' });
    await tina.post('/api/sitzung/abmelden', { minuten: 0 });
    const tapete = dienst.hintergrund.basis('tina');
    await fs.mkdir(tapete, { recursive: true }); await fs.writeFile(path.join(tapete, 'namen.json'), '{}');
    assert.equal((await admin.post('/api/agent/nutzer.umbenennen', { name: 'tina', neu: 't.neu' })).status, 200);
    assert.equal((await tina.get('/api/ich')).status, 401, 'alte Sitzung beendet');
    assert.equal(dienst.sitzungen.liste('tina').length, 0);
    assert.equal((await admin.get('/api/ich')).status, 200, 'die des Admins bleibt');
    await warte(50);
    assert.equal(dienst.sitzungen.abmeldenVon('t.neu'), 0); assert.equal(dienst.sitzungen.abmeldenVon('tina'), null);
    await fs.access(path.join(dienst.hintergrund.basis('t.neu'), 'namen.json'));
    await assert.rejects(fs.access(tapete));
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('ersteinrichtung: Status, falscher Startcode (gebremst), richtiger legt Admin an und meldet direkt an (angemeldet:true, Cookies gesetzt); danach 409', async () => {
  const a = await standardAttrappe(await tmp());
  a.ersteinrichtungNoetig = true;
  const { dienst, port, webOrdner } = await dienstStarten(a);
  try {
    const b = new Browser(port);
    assert.deepEqual((await b.get('/api/ersteinrichtung')).json.ergebnis, { noetig: true });
    const kurz = await b.post('/api/ersteinrichtung', { startcode: 'ABCD1234', name: 'chef', passwort: 'kurz' });
    assert.equal(kurz.status, 400); assert.equal(kurz.json.fehler.details.feld, 'passwort');
    const falsch = await b.post('/api/ersteinrichtung', { startcode: 'FALSCH00', name: 'chef', passwort: 'sehrgeheim1' });
    assert.equal(falsch.status, 401); assert.equal(falsch.json.fehler.code, 'E_ANMELDUNG');
    assert.deepEqual(falsch.json.fehler.details, { feld: 'startcode', verbleibend: 4 }, 'details des Agenten (verbleibend) werden durchgereicht');
    assert.equal(dienst.bremse.eintraege.nutzer['@ersteinrichtung'].fehler, 1);
    const ok = await b.post('/api/ersteinrichtung', { startcode: 'ABCD1234', name: 'Chef', passwort: 'sehrgeheim1', anzeigename: 'Der Chef' });
    assert.equal(ok.status, 200);
    // Antwortform (R3 Fund 14, dokumentiert in §5): angemeldet:true heißt, Sitzungs- und CSRF-Cookie sind gesetzt – kein zweites /api/anmelden
    assert.deepEqual(ok.json.ergebnis, { angelegt: true, angemeldet: true, name: 'chef', rolle: 'admin', totp_noetig: false, uebernommen: false });
    assert.ok(ok.setCookie.some((c) => c.startsWith('fahnas_sitzung=')) && ok.setCookie.some((c) => c.startsWith('fahnas_csrf=')));
    const ich = await b.get('/api/ich');
    assert.equal(ich.status, 200); assert.equal(ich.json.ergebnis.name, 'chef'); assert.equal(ich.json.ergebnis.rolle, 'admin'); assert.equal(ich.json.ergebnis.anzeigename, 'Der Chef');
    assert.equal((await b.post('/api/agent/test.echo', {})).status, 200, 'CSRF-Cookie aus der Ersteinrichtung taugt für schreibende Anfragen');
    assert.equal(dienst.sitzungen.liste('chef').length, 1, 'genau EINE Sitzung');
    assert.deepEqual((await b.get('/api/ersteinrichtung')).json.ergebnis, { noetig: false });
    const einr = a.anfragen.filter((x) => x.aktion === 'system.ersteinrichtung').at(-1);
    assert.deepEqual(einr.params, { startcode: 'ABCD1234', admin: { name: 'chef', passwort: 'sehrgeheim1', anzeigename: 'Der Chef' } });
    assert.equal(einr.kontext.rolle, 'gast');
    // nach Abschluss: 409 E_EXISTIERT mit Klartext statt 503 „Steuerdienst erlaubt nicht“ (R1 Fund 15 g) – auch wenn der Agent E_RECHTE meldet
    const nochmal = await new Browser(port).post('/api/ersteinrichtung', { startcode: 'ABCD1234', name: 'zweiter', passwort: 'sehrgeheim1' });
    assert.equal(nochmal.status, 409); assert.equal(nochmal.json.fehler.code, 'E_EXISTIERT'); assert.match(nochmal.json.fehler.meldung, /abgeschlossen/);
    a.aktionen.get('system.ersteinrichtung').fn = () => { throw new FahnasFehler('E_RECHTE', 'Die Ersteinrichtung ist bereits abgeschlossen – bitte melde dich an'); };
    const rechte = await new Browser(port).post('/api/ersteinrichtung', { startcode: 'ABCD1234', name: 'zweiter', passwort: 'sehrgeheim1' });
    assert.equal(rechte.status, 409); assert.equal(rechte.json.fehler.code, 'E_EXISTIERT');
    assert.equal(dienst.bremse.eintraege.nutzer['@ersteinrichtung'], undefined, 'Wiederholung nach Abschluss zählt nicht als Fehlversuch');
    // E_RECHTE, obwohl noch nötig (Register-Rolle falsch, D2) → weiter 503 mit Hinweis
    a.ersteinrichtungNoetig = true;
    const verweigert = await new Browser(port).post('/api/ersteinrichtung', { startcode: 'ABCD1234', name: 'zweiter', passwort: 'sehrgeheim1' });
    assert.equal(verweigert.status, 503); assert.match(verweigert.json.fehler.meldung, /system\.ersteinrichtung/);
    // Web-Protokoll: Fehlercode lesbar (Schlüssel fehlerart, nicht „code“ → sonst geschwärzt, R1 Fund 15 h)
    await warte(150);
    const log = await webProtokoll(webOrdner);
    assert.match(log, /ersteinrichtung_fehler \{"ip":"127\.0\.0\.1","fehlerart":"E_ANMELDUNG","sperre_ms":0\}/);
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('bremse reserviert Versuche VOR dem Agent-Aufruf: gleichzeitige Fehlversuche (Passwort, TOTP, Startcode) erreichen den Agenten höchstens 5-mal (R1 Fund 4)', async () => {
  const a = await standardAttrappe(await tmp());
  a.ersteinrichtungNoetig = true;
  // Prüfungen künstlich langsam wie echtes scrypt
  for (const name of ['nutzer.pruefen', 'nutzer.totp.pruefen', 'system.ersteinrichtung']) {
    const alt = a.aktionen.get(name).fn;
    a.aktionen.get(name).fn = async (p, k, x) => { await warte(120); return alt(p, k, x); };
  }
  let aussen = false; // TOTP gilt nur von außen → für den TOTP-Teil „aus dem Internet“ (strenge Bremse: 3 Versuche)
  const { dienst, port } = await dienstStarten(a, { anmeldeschutz: { extern: () => aussen }, system: { anmeldeschutz: { laender: [] } } });
  const N = 40;
  const zaehle = (liste) => liste.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  try {
    // Passwort (p2): 40 gleichzeitige falsche Passwörter
    const pw = await Promise.all(Array.from({ length: N }, (_, i) => anfrage(port, 'POST', '/api/anmelden', { body: { name: 'fabian', passwort: `falsch${i}` } })));
    assert.deepEqual(zaehle(pw), { 401: 5, 429: 35 });
    assert.equal(a.anfragen.filter((x) => x.aktion === 'nutzer.pruefen').length, 5, 'nur 5 Passwortprüfungen beim Agenten');
    const ueberzaehlig = pw.find((r) => r.status === 429);
    assert.equal(ueberzaehlig.json.fehler.code, 'E_BREMSE'); assert.ok(ueberzaehlig.json.fehler.details.warte_s >= 1);
    // danach ist die Sperre scharf (auch mit richtigem Passwort), keine Reservierung hängt
    const gesperrt = await anfrage(port, 'POST', '/api/anmelden', { body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(gesperrt.status, 429);
    assert.deepEqual(dienst.bremse.offen('127.0.0.1', 'fabian'), { ip: 0, nutzer: 0 });
    dienst.bremse.erfolg('127.0.0.1', 'fabian');
    // TOTP / Wiederherstellungscode (p2b): tina anmelden, dann 40 gleichzeitige falsche Codes
    const t = new Browser(port);
    aussen = true;
    assert.equal((await t.anmelden('tina', 'tina1234')).json.totp_noetig, true);
    a.anfragen.length = 0;
    const totp = await Promise.all(Array.from({ length: N }, (_, i) => t.post('/api/anmelden/totp', { code: String(100000 + i) })));
    assert.deepEqual(zaehle(totp), { 401: 3, 429: 37 });
    assert.equal(a.anfragen.filter((x) => x.aktion === 'nutzer.totp.pruefen').length, 3, 'nur 3 TOTP-Prüfungen beim Agenten');
    assert.equal((await t.post('/api/anmelden/totp', { code: '123456' })).status, 429, 'Sperre gilt auch für den richtigen Code');
    assert.deepEqual(dienst.schutz.bremse.offen('127.0.0.1', '@internet:tina'), { ip: 0, nutzer: 0 });
    dienst.schutz.bremse.erfolg('127.0.0.1', '@internet:tina');
    aussen = false;
    // Ersteinrichtung: 40 gleichzeitige falsche Startcodes
    a.anfragen.length = 0;
    const st = await Promise.all(Array.from({ length: N }, (_, i) => anfrage(port, 'POST', '/api/ersteinrichtung', { body: { startcode: `FALSCH${i}`, name: 'chef', passwort: 'sehrgeheim1' } })));
    assert.deepEqual(zaehle(st), { 401: 5, 429: 35 });
    assert.equal(a.anfragen.filter((x) => x.aktion === 'system.ersteinrichtung').length, 5, 'nur 5 Startcode-Prüfungen beim Agenten');
    assert.deepEqual(dienst.bremse.offen('127.0.0.1', '@ersteinrichtung'), { ip: 0, nutzer: 0 });
    dienst.bremse.erfolg('127.0.0.1', '@ersteinrichtung');
    // Agent-Fehler (kein Fehlversuch) gibt die Reservierung frei
    a.aktionen.get('nutzer.pruefen').fn = () => { throw new FahnasFehler('E_SYSTEM', 'kaputt'); };
    const kaputt = await anfrage(port, 'POST', '/api/anmelden', { body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(kaputt.status, 500);
    assert.deepEqual(dienst.bremse.offen('127.0.0.1', 'fabian'), { ip: 0, nutzer: 0 });
    assert.equal(dienst.bremse.eintraege.nutzer.fabian, undefined, 'kein Fehlversuch gezählt');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('sitzungen überleben einen Neustart des Web-Dienstes (sitzungen.json, 0600)', async () => {
  const a = await standardAttrappe(await tmp());
  const erste = await dienstStarten(a);
  const b = new Browser(erste.port);
  try {
    await b.anmelden('fabian', 'geheim123');
    assert.equal((await b.get('/api/ich')).status, 200);
  } finally { await erste.dienst.stoppen(); }
  const st = await fs.stat(path.join(erste.webOrdner, 'sitzungen.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const daten = JSON.parse(await fs.readFile(path.join(erste.webOrdner, 'sitzungen.json'), 'utf8'));
  assert.equal(Object.keys(daten.sitzungen).length, 1);
  const s = Object.values(daten.sitzungen)[0];
  for (const feld of ['nutzer', 'rolle', 'erstellt', 'zuletzt', 'ablauf', 'bleiben', 'ip', 'totp_offen']) assert.ok(feld in s, `Feld ${feld}`);
  const zweiter = new WebDienst({ konfigOrdner: erste.konfigOrdner, webOrdner: erste.webOrdner, publicOrdner: erste.publicOrdner, agentSocket: a.socketPfad, datenSocket: a.datenPfad, port: 0, httpPort: null, ohneTls: true, hostname: 'testbox', messwerte: { intervall_ms: 50 } });
  try {
    const { port } = await zweiter.starten();
    await zweiter.agentBereit(3000);
    b.port = port;
    const ich = await b.get('/api/ich');
    assert.equal(ich.status, 200); assert.equal(ich.json.ergebnis.name, 'fabian');
    assert.equal((await b.post('/api/agent/test.echo', {})).status, 200, 'CSRF-Token bleibt gültig');
  } finally { await zweiter.stoppen(); await a.stoppen(); }
});

test('agent nicht erreichbar → 503 E_AGENT ohne Bremse; verweigerte Gast-Aktion → 503 mit Hinweis', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a);
  try {
    await a.stoppen();
    await warte(50);
    const b = new Browser(port);
    const r = await b.anmelden('fabian', 'geheim123');
    assert.equal(r.status, 503); assert.equal(r.json.fehler.code, 'E_AGENT');
    assert.equal(dienst.bremse.gesperrt('127.0.0.1', 'fabian'), 0);
    assert.equal(Object.keys(dienst.bremse.eintraege.ip).length, 0, 'Agent-Ausfall zählt nicht als Fehlversuch');
  } finally { await dienst.stoppen(); }
  // Attrappe, die nutzer.pruefen nur für „system“ anbietet (wie im Vertrag notiert) → verständlicher Fehler
  const a2 = await standardAttrappe(await tmp());
  a2.aktionen.get('nutzer.pruefen').rolle = 'system';
  const zwei = await dienstStarten(a2);
  try {
    const r = await new Browser(zwei.port).anmelden('fabian', 'geheim123');
    assert.equal(r.status, 503); assert.equal(r.json.fehler.code, 'E_AGENT');
    assert.match(r.json.fehler.meldung, /nutzer\.pruefen/);
  } finally { await zwei.dienst.stoppen(); await a2.stoppen(); }
});

test('Anmeldeschutz: 2FA nur von außen, Sitzung von zu Hause verlangt draußen den Code; Land, Rechenaufgabe, strenge Bremse, Meldungen', async () => {
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { system: { vertraute_proxys: ['127.0.0.1'] } });
  const aussenDE = { 'x-forwarded-for': '203.0.113.5' }; const aussenUS = { 'x-forwarded-for': '198.51.100.7' };
  a.landVon['203.0.113.9'] = 'DE';
  try {
    // Zu Hause: kein zweiter Faktor, keine Aufgabe
    const heim = new Browser(port);
    assert.deepEqual((await heim.get('/api/anmelden/aufgabe')).json.ergebnis, { noetig: false });
    const r = await heim.anmelden('tina', 'tina1234', true);
    assert.equal(r.status, 200); assert.equal(r.json.totp_noetig, false, 'zu Hause ohne Code');
    assert.equal((await heim.get('/api/ich')).status, 200);
    // dieselbe Sitzung taucht aus dem Internet auf → jetzt Code nötig, danach wieder offen
    const draussen = await heim.get('/api/ich', aussenDE);
    assert.equal(draussen.status, 401); assert.equal(draussen.json.fehler.code, 'E_TOTP');
    assert.equal((await heim.post('/api/anmelden/totp', { code: '123456' }, aussenDE)).status, 200);
    assert.equal((await heim.get('/api/ich', aussenDE)).status, 200);

    // Aus dem Internet: ohne Lösung der Aufgabe → 400; Land US → 403 schon bei der Aufgabe
    const ohne = await anfrage(port, 'POST', '/api/anmelden', { kopf: aussenDE, body: { name: 'fabian', passwort: 'geheim123' } });
    assert.equal(ohne.status, 400); assert.equal(ohne.json.fehler.details.feld, 'aufgabe');
    const us = (await anfrage(port, 'GET', '/api/anmelden/aufgabe', { kopf: aussenUS })).json.ergebnis;
    assert.equal(us.land_gesperrt, true); assert.deepEqual(us.laender, ['DE']);
    const usLogin = await new Browser(port).anmelden('fabian', 'geheim123', false, aussenUS);
    assert.equal(usLogin.status, 403); assert.match(usLogin.json.fehler.meldung, /nur aus diesen Ländern: DE/);
    // Aufgabe ist an die IP gebunden und einmalig
    const auf = (await anfrage(port, 'GET', '/api/anmelden/aufgabe', { kopf: aussenDE })).json.ergebnis;
    assert.equal(auf.bits, 6); assert.ok(auf.aufgabe.length + 13 <= 55, 'passt in einen SHA-256-Block');
    const { loesen } = await import('../../public/anmeldung-aufgabe.js');
    const loesung = loesen(auf.aufgabe, auf.bits);
    const fremdeIp = await anfrage(port, 'POST', '/api/anmelden', { kopf: { 'x-forwarded-for': '203.0.113.9' }, body: { name: 'fabian', passwort: 'geheim123', aufgabe: auf.aufgabe, loesung } });
    assert.equal(fremdeIp.status, 400, 'Aufgabe einer anderen IP');
    const ok = await anfrage(port, 'POST', '/api/anmelden', { kopf: aussenDE, body: { name: 'fabian', passwort: 'geheim123', aufgabe: auf.aufgabe, loesung } });
    assert.equal(ok.status, 200);
    const nochmal = await anfrage(port, 'POST', '/api/anmelden', { kopf: aussenDE, body: { name: 'fabian', passwort: 'geheim123', aufgabe: auf.aufgabe, loesung } });
    assert.equal(nochmal.status, 400, 'Aufgabe nur einmal');
    await warte(30);
    assert.deepEqual(a.meldungen.at(-1), { art: 'erfolg', nutzer: 'fabian', ip: '203.0.113.5', ort: 'Musterstadt, DE' });
    // tina von außen braucht den Code
    assert.equal((await new Browser(port).anmelden('tina', 'tina1234', false, aussenDE)).json.totp_noetig, true);

    // Strenge Bremse: 3 falsche Passwörter → 1 h Sperre (auch für das richtige), Meldung; zu Hause bleibt frei
    const bot = new Browser(port);
    for (let i = 0; i < 3; i++) assert.equal((await bot.anmelden('fabian', `falsch${i}`, false, aussenDE)).status, 401);
    const gesperrt = await bot.anmelden('fabian', 'geheim123', false, aussenDE);
    assert.equal(gesperrt.status, 429); assert.ok(gesperrt.json.fehler.details.warte_s > 3500, 'eine Stunde');
    assert.ok((await anfrage(port, 'GET', '/api/anmelden/aufgabe', { kopf: aussenDE })).json.ergebnis.warte_s > 3500);
    await warte(30);
    assert.equal(a.meldungen.at(-1).art, 'sperre'); assert.equal(a.meldungen.at(-1).minuten, 60); assert.equal(a.meldungen.at(-1).nutzer, 'fabian');
    assert.equal((await new Browser(port).anmelden('fabian', 'geheim123')).status, 200, 'zu Hause nicht betroffen');
    // zweite Sperre derselben IP: 24 h
    dienst.schutz.bremse.eintraege.ip['203.0.113.5'].bis = Date.now() - 1;
    dienst.schutz.bremse.eintraege.nutzer['@internet:fabian'].bis = Date.now() - 1;
    for (let i = 0; i < 3; i++) await bot.anmelden('fabian', `falsch${i}`, false, aussenDE);
    assert.ok(dienst.schutz.bremse.eintraege.ip['203.0.113.5'].bis - Date.now() > 23 * 3_600_000, 'zweite Sperre 24 h');

    // Übersicht für Kachel/Karte (Admin)
    const admin = new Browser(port); await admin.anmelden('fabian', 'geheim123');
    const u = (await admin.get('/api/anmeldeschutz')).json.ergebnis;
    assert.deepEqual(u.laender, ['DE']); assert.equal(u.sperren[0].ip, '203.0.113.5'); assert.equal(u.sperren[0].ort, 'Musterstadt, DE');
    assert.ok(u.fehler_24h >= 6); assert.ok(u.land_24h >= 2); assert.deepEqual(u.letzte.map((x) => x.nutzer), ['tina', 'fabian']);
    assert.equal((await heim.get('/api/anmeldeschutz')).status, 403, 'nur Admins');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

