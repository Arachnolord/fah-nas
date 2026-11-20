// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bausteine des Web-Dienstes einzeln: Sitzungen, Bremse, Proxy-Liste/Client-IP, CSRF/Herkunft, statisches
// Pfadauflösen, Messwerte-Parser + Rückfälle, TLS-Erzeugung (openssl-Argumente), Web-Protokoll, Router, JSON-Lesen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { tmp, warte } from './web_hilfen.js';
import { Sitzungen, VERWAIST_MS } from '../../src/web/sitzungen.js';
import { Bremse, proxyListe, clientIp, ipNormal } from '../../src/web/bremse.js';
import { csrfPruefen, herkunftPruefen, gleich, csrfToken } from '../../src/web/csrf.js';
import { Statisch } from '../../src/web/statisch.js';
import { Messwerte, cpuZeiten, ramWerte, netzSummen } from '../../src/web/messwerte.js';
import { zertifikatSicherstellen, opensslArgumente, hostnameBereinigt, netzAdressen } from '../../src/web/tls.js';
import { WebProtokoll } from '../../src/web/webprotokoll.js';
import { Router, leseJson, httpStatus, detailsFuerRolle, DETAILS_VERWEIS } from '../../src/web/server.js';
import { aufgabeFuerNutzer } from '../../src/web/sse.js';
import * as system from '../../src/gemeinsam/system.js';

const req = (kopf = {}, socketIp = '127.0.0.1') => ({ headers: kopf, socket: { remoteAddress: socketIp } });

test('sitzungen: Geräte – gleiches Gerät ersetzt, Altsitzungen ohne Gerät nach 30 Tagen ohne Nutzung verwaist, auch bei „nie“', async (tk) => {
  tk.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const s = new Sitzungen(await tmp());
  await s.laden();
  await s.abmeldenSetzen('fabian', 0);
  const beendet = []; s.on('beendet', (e) => beendet.push(e.grund));
  const a = s.anlegen({ nutzer: 'fabian', rolle: 'admin', geraet: 'g'.repeat(32) });
  const b = s.anlegen({ nutzer: 'fabian', rolle: 'admin', geraet: 'g'.repeat(32) });
  assert.equal(s.hole(a.id), null); assert.ok(s.hole(b.id)); assert.deepEqual(beendet, ['ersetzt']);
  const alt = s.anlegen({ nutzer: 'fabian', rolle: 'admin' });
  const altGenutzt = s.anlegen({ nutzer: 'fabian', rolle: 'admin' });
  assert.equal(s.geraetBinden(b.id, 'h'.repeat(32)), false, 'vorhandenes Gerät bleibt');
  tk.mock.timers.tick(VERWAIST_MS - 1000);
  s.hole(altGenutzt.id); s.hole(b.id);
  tk.mock.timers.tick(2000);
  assert.equal(s.bereinigen(), 1);
  assert.equal(s.hole(alt.id), null, 'unbenutzte Altsitzung weg');
  assert.ok(s.hole(altGenutzt.id) && s.hole(b.id), 'benutzte bleiben – mit Gerät gilt weiter „nie“');
  tk.mock.timers.tick(VERWAIST_MS * 3);
  assert.equal(s.bereinigen(), 1, 'nur die ohne Gerät');
  assert.ok(s.hole(b.id));
  await s.stoppen();
});

test('sitzungen: anlegen, holen (gleitend), bleiben, ablaufen, löschen, je Nutzer, Kennungen, speichern/laden', async (tk) => {
  // Gemockte Uhr statt echter Wartezeiten: unter Last (parallele Testläufe) rissen 2 × 120 ms gegen 200 ms Ablauf
  tk.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const w = await tmp();
  const s = new Sitzungen(w, { ablauf_ms: 200, bleiben_ms: 5000 });
  await s.laden();
  const a = s.anlegen({ nutzer: 'fabian', rolle: 'admin', anzeigename: 'F', ip: '1.2.3.4' });
  assert.equal(a.id.length, 43); assert.ok(a.csrf.length >= 32); assert.equal(a.totp_offen, false);
  const b = s.anlegen({ nutzer: 'fabian', rolle: 'admin', bleiben: true, totp_offen: true });
  const t = s.anlegen({ nutzer: 'tina', rolle: 'nutzer' });
  assert.equal(s.hole(a.id).nutzer, 'fabian');
  assert.equal(s.hole('kurz'), null); assert.equal(s.hole('x'.repeat(43)), null);
  assert.equal(s.liste().length, 3); assert.equal(s.liste('tina').length, 1);
  assert.ok(!('csrf' in s.liste()[0]) && s.liste()[0].kennung.length === 10);
  assert.equal(s.idZuKennung(a.id.slice(0, 10)), a.id); assert.equal(s.idZuKennung(a.id.slice(0, 10), 'tina'), null);
  s.aktualisieren(b.id, { totp_offen: false, rolle: 'nutzer' });
  assert.equal(s.hole(b.id).totp_offen, false); assert.equal(s.hole(b.id).rolle, 'nutzer');
  assert.equal(s.aktualisiereNutzer('fabian', { anzeigename: 'Neu' }), 2);
  assert.equal(s.rolleVon(a.id), 'admin'); assert.equal(s.rolleVon(b.id), 'nutzer'); assert.equal(s.rolleVon('gibtsnicht'), null);
  tk.mock.timers.tick(120); assert.ok(s.hole(a.id), 'Zugriff verlängert');
  tk.mock.timers.tick(120); assert.ok(s.hole(a.id));
  tk.mock.timers.tick(250);
  assert.equal(s.hole(a.id), null, 'ohne Zugriff abgelaufen');
  assert.ok(s.hole(b.id), '„bleiben“ hält länger');
  assert.equal(s.bereinigen(), 1, 'tina abgelaufen');
  assert.equal(s.loescheNutzer('fabian', undefined), 1);
  const c = s.anlegen({ nutzer: 'c', rolle: 'nutzer' });
  await s.stoppen();
  const st = await fs.stat(path.join(w, 'sitzungen.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const s2 = new Sitzungen(w, { ablauf_ms: 200, bleiben_ms: 5000 });
  await s2.laden();
  assert.equal(s2.alle.size, 1); assert.equal(s2.hole(c.id).nutzer, 'c');
  assert.equal(s2.hole(c.id).csrf, c.csrf, 'CSRF-Token bleibt über Neustart');
  const beendet = [];
  s2.on('beendet', (e) => beendet.push(e));
  s2.loeschen(c.id);
  assert.deepEqual(beendet, [{ id: c.id, nutzer: 'c', grund: 'abgemeldet' }]);
  await s2.stoppen();
});

test('bremse: 5 Fehler sperren, Sperre verdoppelt bis zum Deckel, Erfolg setzt zurück, je Name über IPs hinweg, speichern', async () => {
  const w = await tmp();
  const b = new Bremse(w, { start_ms: 100, max_ms: 350 });
  await b.laden();
  for (let i = 0; i < 4; i++) { b.fehler('10.0.0.1', 'fabian'); assert.equal(b.gesperrt('10.0.0.1', 'fabian'), 0); }
  assert.equal(b.fehler('10.0.0.1', 'Fabian '), 100, '5. Fehler sperrt 100 ms (Name normalisiert)');
  assert.throws(() => b.pruefen('10.0.0.1', 'x'), (e) => e.code === 'E_BREMSE' && e.details.warte_s === 1 && /warte/.test(e.message));
  assert.throws(() => b.pruefen('10.0.0.2', 'fabian'), (e) => e.code === 'E_BREMSE', 'auch der Name ist gesperrt');
  assert.equal(b.gesperrt('10.0.0.2', 'tina'), 0);
  await warte(120);
  assert.equal(b.gesperrt('10.0.0.1', 'fabian'), 0, 'abgelaufen');
  for (let i = 0; i < 4; i++) b.fehler('10.0.0.1', 'fabian');
  assert.equal(b.fehler('10.0.0.1', 'fabian'), 200, 'zweite Sperre doppelt');
  await warte(220);
  for (let i = 0; i < 4; i++) b.fehler('10.0.0.1', 'fabian');
  assert.equal(b.fehler('10.0.0.1', 'fabian'), 350, 'Deckel');
  b.erfolg('10.0.0.1', 'fabian');
  assert.equal(b.gesperrt('10.0.0.1', 'fabian'), 0);
  assert.equal(b.eintraege.ip['10.0.0.1'], undefined);
  // Name-Sperre über verschiedene IPs (verteiltes Raten)
  for (let i = 0; i < 5; i++) b.fehler(`10.0.1.${i}`, 'admin');
  assert.throws(() => b.pruefen('10.0.9.9', 'admin'), (e) => e.code === 'E_BREMSE');
  assert.equal(b.gesperrt('10.0.9.9', 'anderer'), 0);
  await b.stoppen();
  const st = await fs.stat(path.join(w, 'bremse.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const b2 = new Bremse(w, { start_ms: 100, max_ms: 350 });
  await b2.laden();
  assert.ok(b2.eintraege.nutzer.admin.bis > 0);
});

test('bremse.beginnen: reserviert laufende Versuche je IP und Name, Fehler + laufende ≥ Grenze → E_BREMSE, ende() gibt frei (idempotent)', async () => {
  const w = await tmp();
  const b = new Bremse(w, { start_ms: 100, max_ms: 350 });
  await b.laden();
  const v = [];
  for (let i = 0; i < 5; i++) v.push(b.beginnen('10.0.0.1', 'fabian'));
  assert.throws(() => b.beginnen('10.0.0.1', 'fabian'), (e) => e.code === 'E_BREMSE' && e.details.warte_s === 1 && /gleichzeitig/.test(e.message), '6. gleichzeitiger Versuch');
  assert.throws(() => b.beginnen('10.0.0.2', 'Fabian '), (e) => e.code === 'E_BREMSE', 'Name zählt über IPs (normalisiert)');
  assert.throws(() => b.beginnen('10.0.0.1', 'tina'), (e) => e.code === 'E_BREMSE', 'IP zählt über Namen');
  assert.equal(b.gesperrt('10.0.0.1', 'fabian'), 0, 'Reservierung ist keine Sperre');
  assert.deepEqual(b.offen('10.0.0.1', 'fabian'), { ip: 5, nutzer: 5 });
  assert.deepEqual(b.offen('10.0.0.9', 'tina'), { ip: 0, nutzer: 0 });
  v[0].ende(); v[0].ende(); // idempotent
  assert.deepEqual(b.offen('10.0.0.1', 'fabian'), { ip: 4, nutzer: 4 });
  const v6 = b.beginnen('10.0.0.1', 'fabian');
  assert.throws(() => b.beginnen('10.0.0.1', 'fabian'), (e) => e.code === 'E_BREMSE');
  for (const x of [...v.slice(1), v6]) x.ende();
  assert.deepEqual(b.offen('10.0.0.1', 'fabian'), { ip: 0, nutzer: 0 });
  assert.equal(b.eintraege.ip['10.0.0.1'], undefined, 'Reservierungen werden nicht als Fehler gespeichert');
  // 3 Fehler + 2 laufende = Grenze → der dritte laufende wird abgewiesen
  for (let i = 0; i < 3; i++) b.fehler('10.0.0.1', 'fabian');
  const r1 = b.beginnen('10.0.0.1', 'fabian'); const r2 = b.beginnen('10.0.0.1', 'fabian');
  assert.throws(() => b.beginnen('10.0.0.1', 'fabian'), (e) => e.code === 'E_BREMSE');
  b.fehler('10.0.0.1', 'fabian'); r1.ende(); b.fehler('10.0.0.1', 'fabian'); r2.ende();
  assert.throws(() => b.beginnen('10.0.0.1', 'fabian'), (e) => e.code === 'E_BREMSE' && /warte/.test(e.message), 'jetzt echte Sperre');
  // nach der Sperre: warte_s der Reservierungs-Ablehnung folgt der nächsten Sperrstufe
  await warte(120);
  const s = []; for (let i = 0; i < 5; i++) s.push(b.beginnen('10.0.0.1', 'fabian'));
  assert.throws(() => b.beginnen('10.0.0.1', 'fabian'), (e) => e.details.warte_s === 1, 'Stufe 1 → 200 ms → 1 s aufgerundet');
  for (const x of s) x.ende();
  b.erfolg('10.0.0.1', 'fabian');
  assert.doesNotThrow(() => b.beginnen('10.0.0.1', 'fabian').ende());
  await b.stoppen();
  const gespeichert = JSON.parse(await fs.readFile(path.join(w, 'bremse.json'), 'utf8'));
  assert.equal(gespeichert.laufend, undefined, 'laufende Versuche liegen nur im Speicher');
});

test('detailsFuerRolle/aufgabeFuerNutzer: Admin alles, sonst Whitelist + Verweis; Nicht-Objekte werden ersetzt', () => {
  const interna = { feld: 'name', befehl: ['rm'], ausgabe: 'stderr', pfad: '/data/x', grund: 'ENOENT', warte_s: 3 };
  assert.deepEqual(detailsFuerRolle(interna, 'admin'), { details: interna, entfernt: null });
  assert.deepEqual(detailsFuerRolle(undefined, 'nutzer'), { details: undefined, entfernt: null });
  assert.deepEqual(detailsFuerRolle({ feld: 'x', warte_s: 1, verbleibend: 2, noetig: 'admin', frei: 5, max: 1, min: 0, aktion: 'a' }, 'gast').entfernt, null, 'nur Whitelist → unverändert');
  const n = detailsFuerRolle(interna, 'nutzer');
  assert.deepEqual(n.details, { feld: 'name', warte_s: 3, protokoll: DETAILS_VERWEIS });
  assert.deepEqual(n.entfernt, { befehl: ['rm'], ausgabe: 'stderr', pfad: '/data/x', grund: 'ENOENT' });
  assert.deepEqual(detailsFuerRolle(interna, undefined).details, n.details, 'ohne Rolle wie Gast');
  assert.deepEqual(detailsFuerRolle('roher Text', 'nutzer'), { details: { protokoll: DETAILS_VERWEIS }, entfernt: 'roher Text' });
  assert.deepEqual(detailsFuerRolle(['a'], 'nutzer').entfernt, ['a']);
  assert.deepEqual(detailsFuerRolle(null, 'nutzer'), { details: { protokoll: DETAILS_VERWEIS }, entfernt: null });
  const ev = { aufgabe: 't-1', nutzer: 'tina', status: 'fehler', fehler: { code: 'E_SYSTEM', meldung: 'k', details: interna } };
  assert.deepEqual(aufgabeFuerNutzer(ev), { ...ev, fehler: { code: 'E_SYSTEM', meldung: 'k', details: { feld: 'name', warte_s: 3, protokoll: DETAILS_VERWEIS } } });
  assert.deepEqual(ev.fehler.details, interna, 'Original unverändert');
  const ohne = { aufgabe: 't-2', status: 'fertig', ergebnis: { x: 1 } };
  assert.equal(aufgabeFuerNutzer(ohne), ohne);
  assert.equal(aufgabeFuerNutzer({ fehler: { code: 'E_X', meldung: 'm' } }).fehler.details, undefined);
});

test('proxyListe/clientIp: IPv4, CIDR, IPv6, ::ffff:, Kette von rechts, ungültige Einträge', () => {
  assert.equal(proxyListe([]), null); assert.equal(proxyListe(['quatsch', 42]), null);
  const l = proxyListe(['192.168.1.23', '192.168.48.0/20', 'fd00::/8', '::ffff:172.16.0.1', 'kaputt', '1.2.3.4/99']);
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, '192.168.1.23'), l), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, '::ffff:192.168.50.7'), l), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, 'fd00::1234'), l), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, '172.16.0.1'), l), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, '192.168.1.24'), l), '192.168.1.24', 'nicht vertraut → Socket-IP');
  assert.equal(clientIp(req({}, '192.168.1.23'), l), '192.168.1.23', 'ohne Kopfzeile Socket-IP');
  assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9, 192.168.48.1' }, '192.168.1.23'), l), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '192.168.1.23, 192.168.48.1' }, '192.168.1.23'), l), '192.168.1.23', 'alle vertraut → erster');
  assert.equal(clientIp(req({ 'x-forwarded-for': 'kein-ip, <script>' }, '192.168.1.23'), l), '192.168.1.23');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, '192.168.1.23'), null), '192.168.1.23', 'ohne Liste nie XFF');
  assert.equal(clientIp({ headers: {}, socket: {} }, l), '-');
  assert.equal(ipNormal('::ffff:1.2.3.4'), '1.2.3.4'); assert.equal(ipNormal('fe80::1%en0'), 'fe80::1'); assert.equal(ipNormal('[::1]'), '::1'); assert.equal(ipNormal('x'), '');
});

test('csrf: Token-Vergleich zeitkonstant, Prüfung gegen Cookie + Sitzung, Herkunftsprüfung', () => {
  const tok = csrfToken(); assert.equal(tok.length, 32);
  assert.ok(gleich('abc', 'abc')); assert.ok(!gleich('abc', 'abd')); assert.ok(!gleich('abc', 'ab')); assert.ok(!gleich('', '')); assert.ok(!gleich(undefined, 'x'));
  const s = { csrf: tok };
  assert.doesNotThrow(() => csrfPruefen(req({ cookie: `a=1; fahnas_csrf=${tok}`, 'x-fahnas-csrf': tok }), s));
  assert.throws(() => csrfPruefen(req({ cookie: `fahnas_csrf=${tok}` }), s), (e) => e.code === 'E_CSRF');
  assert.throws(() => csrfPruefen(req({ 'x-fahnas-csrf': tok }), s), (e) => e.code === 'E_CSRF');
  assert.throws(() => csrfPruefen(req({ cookie: 'fahnas_csrf=abc', 'x-fahnas-csrf': 'abc' }), s), (e) => e.code === 'E_CSRF', 'passt nicht zur Sitzung');
  assert.throws(() => csrfPruefen(req({ cookie: `fahnas_csrf=${tok}`, 'x-fahnas-csrf': tok }), null), (e) => e.code === 'E_CSRF');
  assert.doesNotThrow(() => herkunftPruefen(req({ 'sec-fetch-site': 'same-origin' })));
  assert.doesNotThrow(() => herkunftPruefen(req({ 'sec-fetch-site': 'none' })));
  assert.throws(() => herkunftPruefen(req({ 'sec-fetch-site': 'cross-site' })), (e) => e.code === 'E_CSRF');
  assert.throws(() => herkunftPruefen(req({ 'sec-fetch-site': 'same-site' })), (e) => e.code === 'E_CSRF');
  assert.doesNotThrow(() => herkunftPruefen(req({ origin: 'https://nas.local', host: 'nas.local' })));
  assert.doesNotThrow(() => herkunftPruefen(req({ origin: 'https://NAS.local:8443', host: 'nas.local:8443' })));
  assert.throws(() => herkunftPruefen(req({ origin: 'https://boese.example', host: 'nas.local' })), (e) => e.code === 'E_CSRF');
  assert.throws(() => herkunftPruefen(req({ origin: 'null', host: 'nas.local' })), (e) => e.code === 'E_CSRF');
  assert.throws(() => herkunftPruefen(req({ origin: '::kaputt', host: 'nas.local' })), (e) => e.code === 'E_CSRF');
  assert.doesNotThrow(() => herkunftPruefen(req({ host: 'nas.local' })), 'kein Browser (curl) → erlaubt');
});

test('statisch: Pfadauflösung erlaubt nur echte Dateien unterhalb der Wurzel', async () => {
  const w = await tmp();
  const s = new Statisch(w);
  assert.equal(s.aufloesen('/'), path.join(w, 'index.html'));
  assert.equal(s.aufloesen(''), path.join(w, 'index.html'));
  assert.equal(s.aufloesen('/ansichten/dashboard.js'), path.join(w, 'ansichten', 'dashboard.js'));
  assert.equal(s.aufloesen('/a%20b.css'), path.join(w, 'a b.css'));
  for (const p of ['/../x', '/a/../../x', '/%2e%2e/x', '/.git/config', '/a/.env', '/a\\b', '/%00', '/%zz', '/./x', '/..']) assert.equal(s.aufloesen(p), null, p);
  assert.equal(s.aufloesen('/ansichten/'), path.join(w, 'ansichten'), 'Ordner löst auf, wird aber in bedienen() zu 404 (keine Datei)');
});

test('messwerte: Parser für /proc, Differenzen über zwei Messungen, Temperatur-Quellen, Rückfälle ohne /proc', async () => {
  assert.deepEqual(cpuZeiten('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n'), { gesamt: 1000, leer: 850 });
  const os = cpuZeiten(null); assert.ok(os.gesamt > 0 && os.leer >= 0);
  assert.deepEqual(ramWerte('MemTotal:       16000000 kB\nMemFree:  1 kB\nMemAvailable:    4000000 kB\n'), { gesamt: 16000000 * 1024, verfuegbar: 4000000 * 1024, prozent: 75 });
  assert.ok(ramWerte(null).gesamt > 0);
  const netdev = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n  wlan0:  500 5 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n';
  assert.deepEqual(netzSummen(netdev), { rx: 1500, tx: 2100 });
  assert.equal(netzSummen(null), null); assert.equal(netzSummen('a\nb\n'), null);

  // künstliches /proc und /sys
  const w = await tmp();
  const proc = path.join(w, 'proc'); const sys = path.join(w, 'sys');
  await fs.mkdir(path.join(proc, 'net'), { recursive: true });
  await fs.mkdir(path.join(sys, 'class', 'thermal', 'thermal_zone0'), { recursive: true });
  await fs.mkdir(path.join(sys, 'class', 'thermal', 'thermal_zone1'), { recursive: true });
  await fs.writeFile(path.join(proc, 'stat'), 'cpu  100 0 50 800 50 0 0 0 0 0\n');
  await fs.writeFile(path.join(proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
  await fs.writeFile(path.join(proc, 'net', 'dev'), netdev);
  await fs.writeFile(path.join(sys, 'class', 'thermal', 'thermal_zone0', 'type'), 'acpitz\n');
  await fs.writeFile(path.join(sys, 'class', 'thermal', 'thermal_zone0', 'temp'), '27800\n');
  await fs.writeFile(path.join(sys, 'class', 'thermal', 'thermal_zone1', 'type'), 'x86_pkg_temp\n');
  await fs.writeFile(path.join(sys, 'class', 'thermal', 'thermal_zone1', 'temp'), '45500\n');
  const m = new Messwerte({ proc, sys, platten: [{ pfad: w, name: 'test' }, { pfad: path.join(w, 'gibtsnicht'), name: 'weg' }], groesse: 3 });
  const m1 = await m.messen();
  assert.equal(m1.cpu.prozent, 0, 'erste Messung ohne Differenz');
  assert.equal(m1.temperatur, 45.5, 'x86_pkg_temp bevorzugt');
  assert.deepEqual(m1.ram, { gesamt: 1024000, verfuegbar: 512000, prozent: 50 });
  assert.equal(m1.platten.length, 1); assert.equal(m1.platten[0].name, 'test'); assert.ok(m1.platten[0].gesamt > 0 && m1.platten[0].frei >= 0);
  assert.equal(m1.netz.verfuegbar, true);
  await warte(60);
  await fs.writeFile(path.join(proc, 'stat'), 'cpu  400 0 100 1000 100 0 0 0 0 0\n'); // Δgesamt 600, Δleer 250 → 58,3 %
  await fs.writeFile(path.join(proc, 'net', 'dev'), netdev.replace('1000 10', '61000 10'));
  const m2 = await m.messen();
  assert.equal(m2.cpu.prozent, 58.3);
  assert.ok(m2.netz.rx_bs > 100_000, `rx_bs ${m2.netz.rx_bs}`);
  await m.messen(); await m.messen();
  assert.equal(m.verlauf().length, 3, 'Ringpuffer begrenzt');
  // hwmon-Rückfall
  const w2 = await tmp();
  await fs.mkdir(path.join(w2, 'sys', 'class', 'hwmon', 'hwmon2'), { recursive: true });
  await fs.writeFile(path.join(w2, 'sys', 'class', 'hwmon', 'hwmon2', 'temp1_input'), '39000');
  const mh = new Messwerte({ proc: path.join(w2, 'proc'), sys: path.join(w2, 'sys'), platten: [] });
  assert.equal((await mh.messen()).temperatur, 39);
  // gar nichts da (macOS): keine Ausnahme, Rückfälle
  const mo = new Messwerte({ proc: '/gibts/nicht/proc', sys: '/gibts/nicht/sys', platten: [{ pfad: '/', name: 'system' }, { pfad: '/data', name: 'daten' }] });
  const mm = await mo.messen();
  assert.equal(mm.temperatur, null); assert.ok(mm.ram.gesamt > 0); assert.equal(mm.netz.verfuegbar, false); assert.ok(mm.laufzeit_s > 0);
  assert.ok(mm.platten.some((p) => p.pfad === '/'));
  // starten/stoppen mit Timer
  mo.starten(); await warte(30); mo.stoppen();
});

test('tls: openssl-Argumentliste und Dateien; vorhandenes Zertifikat wird nicht neu erzeugt', async () => {
  const w = await tmp();
  const aufrufe = [];
  system._test.setzeBefehl(async (programm, argumente) => {
    aufrufe.push({ programm, argumente });
    const key = argumente[argumente.indexOf('-keyout') + 1]; const cert = argumente[argumente.indexOf('-out') + 1];
    await fs.writeFile(key, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n', { mode: 0o644 });
    await fs.writeFile(cert, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    const ordner = path.join(w, 'tls');
    const r = await zertifikatSicherstellen(ordner, { hostname: 'nas', ips: ['192.168.1.50', 'fd00::5', 'böse;rm'] });
    assert.equal(r.neu, true);
    assert.equal(aufrufe.length, 1); assert.equal(aufrufe[0].programm, 'openssl');
    assert.deepEqual(aufrufe[0].argumente, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '3650',
      '-subj', '/CN=nas', '-addext', 'subjectAltName=DNS:nas,DNS:nas.local,IP:192.168.1.50,IP:fd00::5', '-keyout', path.join(ordner, 'key.pem'), '-out', path.join(ordner, 'cert.pem')]);
    assert.equal((await fs.stat(path.join(ordner, 'key.pem'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(ordner)).mode & 0o777, 0o700);
    assert.match(r.key.toString(), /PRIVATE KEY/); assert.match(r.cert.toString(), /CERTIFICATE/);
    const r2 = await zertifikatSicherstellen(ordner, { hostname: 'nas', ips: [] });
    assert.equal(r2.neu, false); assert.equal(aufrufe.length, 1, 'kein zweiter openssl-Aufruf');
    assert.deepEqual(opensslArgumente({ hostname: 'x', ips: [], schluessel: 'k', zertifikat: 'c' }).slice(-4), ['-keyout', 'k', '-out', 'c']);
    assert.equal(hostnameBereinigt('mein-nas.fritz.box'), 'mein-nas'); assert.equal(hostnameBereinigt('-böse'), 'fahnas'); assert.equal(hostnameBereinigt(''), 'fahnas');
    assert.deepEqual(netzAdressen({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: 'fe80::1%en0', family: 'IPv6', internal: false }, { address: '2001:db8::5', family: 'IPv6', internal: false }] }), ['192.168.1.5', '2001:db8::5']);
    // openssl schlägt fehl → E_SYSTEM
    system._test.setzeBefehl(async () => ({ code: 0, stdout: '', stderr: '' }));
    await assert.rejects(zertifikatSicherstellen(path.join(w, 'tls2'), { hostname: 'nas', ips: [] }), (e) => e.code === 'E_SYSTEM');
  } finally { system._test.setzeBefehl(null); }
});

test('webprotokoll: Zeilen je Monat, Geheimnisse geschwärzt, Rotation löscht alte Monate', async () => {
  const w = await tmp();
  const zeilen = [];
  const p = new WebProtokoll(w, { aufbewahrung_monate: 2, ausgabe: (z) => zeilen.push(z) });
  await p.eintrag('anmeldung_fehler', { name: 'fabian', passwort: 'geheim', csrf: 'x', ip: '1.2.3.4' });
  await p.eintrag('start', { port: 443 });
  const datei = p.datei();
  assert.match(path.basename(datei), /^web-\d{4}-\d{2}\.log$/);
  const text = await fs.readFile(datei, 'utf8');
  assert.equal(text.trim().split('\n').length, 2);
  assert.match(text, /anmeldung_fehler \{"name":"fabian","passwort":"\*\*\*","csrf":"\*\*\*","ip":"1.2.3.4"\}/);
  assert.equal((await fs.stat(datei)).mode & 0o777, 0o600);
  assert.equal(zeilen.length, 2);
  // Startcode/TOTP-Code werden geschwärzt, der Fehlercode (Schlüssel fehlerart) bleibt lesbar (R1 Fund 15 h)
  await p.eintrag('ersteinrichtung_fehler', { startcode: 'ABCD', code: '123456', fehlerart: 'E_ANMELDUNG', wiederherstellungscode: 'x' });
  assert.match(zeilen[2], /\{"startcode":"\*\*\*","code":"\*\*\*","fehlerart":"E_ANMELDUNG","wiederherstellungscode":"\*\*\*"\}/);
  await fs.writeFile(path.join(w, 'web-2020-01.log'), 'alt\n');
  await fs.writeFile(path.join(w, 'web-2020-02.log'), 'alt\n');
  const heute = new Date(); heute.setUTCMonth(heute.getUTCMonth() - 1, 1);
  await fs.writeFile(path.join(w, `web-${heute.toISOString().slice(0, 7)}.log`), 'vormonat\n');
  assert.equal(await p.rotieren(), 2);
  const rest = (await fs.readdir(w)).filter((d) => d.startsWith('web-')).sort();
  assert.equal(rest.length, 2, 'aktueller Monat + Vormonat bleiben');
  await p.stoppen();
});

test('router + leseJson + httpStatus', async () => {
  const r = new Router();
  r.add('GET', '/api/ich', {}, () => {});
  r.add('POST', '/api/agent/:aktion', { csrf: true }, () => {});
  r.add('GET', '/link/:token', { sitzung: 'keine' }, () => {});
  assert.equal(r.finde('GET', '/api/ich').route.optionen.csrf, false);
  assert.equal(r.finde('HEAD', '/api/ich').route.methode, 'GET');
  assert.deepEqual(r.finde('POST', '/api/agent/freigaben.liste').params, { aktion: 'freigaben.liste' });
  assert.deepEqual(r.finde('GET', '/link/a%20b/').params, { token: 'a b' });
  assert.equal(r.finde('GET', '/api/agent/x').methodeFalsch, true, 'Pfad bekannt, Methode falsch → 405');
  assert.equal(r.finde('GET', '/api/agent/x/y'), null);
  assert.equal(r.finde('GET', '/api/nix'), null);
  assert.equal(r.finde('POST', '/api/ich').methodeFalsch, true);
  assert.equal(r.finde('GET', '/link/%zz'), null);
  const koerper = (text, kopf = {}) => Object.assign(Readable.from([Buffer.from(text)]), { headers: kopf });
  assert.deepEqual(await leseJson(koerper('{"a":1}')), { a: 1 });
  assert.deepEqual(await leseJson(koerper('')), {});
  await assert.rejects(leseJson(koerper('[1]')), (e) => e.code === 'E_PARAMS');
  await assert.rejects(leseJson(koerper('{kaputt')), (e) => e.code === 'E_PARAMS');
  await assert.rejects(leseJson(koerper('{}', { 'content-length': '9999999' })), (e) => e.code === 'E_PARAMS');
  await assert.rejects(leseJson(Object.assign(Readable.from([Buffer.alloc(20)]), { headers: {}, destroy() { this.push(null); return this; } }), 10), (e) => e.code === 'E_PARAMS');
  assert.equal(httpStatus('E_PARAMS'), 400); assert.equal(httpStatus('E_AGENT'), 503); assert.equal(httpStatus('E_PLATZ'), 507); assert.equal(httpStatus('E_RENDER'), 500); assert.equal(httpStatus('quatsch'), 500);
  void http;
});

test('Konto-Anzeige: zählt Geräte statt Sitzungen – je Gerät einmal, 30 Tage, die eigene immer', async () => {
  const { geraeteZaehlen } = await import('../../public/ansichten/nutzer.js');
  const jetzt = Date.parse('2026-10-20T12:00:00Z');
  const vor = (tage) => new Date(jetzt - tage * 86_400_000).toISOString();
  assert.equal(geraeteZaehlen([
    { aktuell: true, geraet: 'a', zuletzt: vor(0) }, { geraet: 'a', zuletzt: vor(1) }, { geraet: 'b', zuletzt: vor(29) },
    { geraet: 'c', zuletzt: vor(31) }, { kennung: 'alt1', zuletzt: vor(0) }, { kennung: 'alt2', zuletzt: vor(2) },
  ], jetzt), 2);
  assert.equal(geraeteZaehlen([{ aktuell: true, kennung: 'alt', zuletzt: vor(0) }], jetzt), 1, 'eigene Altsitzung zählt');
  assert.equal(geraeteZaehlen([], jetzt), 0);
});
