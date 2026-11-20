// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Darstellung je Nutzer (12.10.2026): Einstellungen normalisieren, Akzentfarben (Lesbarkeit), Tapeten-Schnittstelle
// mit echtem HTTP-Server (Hochladen, Abruf mit Range, nur eigene Datei, falscher Typ, zu groß, ohne CSRF, löschen).
// 15.10.2026: Sammlung je Nutzer, Übernahme der alten Einzeldatei, Tapete aus Freigabe-Ordner, Skalierung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normal, akzentVariablen, helligkeit, hexRgb, THEMES, AKZENTE, STANDARD, glasVariablen, tapeteUrl, wirksameSkalierung, einpassMass, wirksamerZoom, ALT_ID } from '../../public/darstellung.js';
import { ausOrdnerliste, nachbar, dateiVersion, auswahlForm } from '../../public/tapeten.js';
import { HintergrundApi, MAX_ANZAHL, anzeigename } from '../../src/web/api/hintergrund.js';
import { Router, erstelleBehandler } from '../../src/web/server.js';

test('darstellung: Glas-Look – nur echtes true schaltet ein, Transparenz begrenzt, Unschärfe sinkt mit der Durchsicht', () => {
  assert.equal(normal({ glas: 'ja' }).glas, false);
  assert.deepEqual([normal({ glas: true, transparenz: 3 }).transparenz, normal({ glas: true, transparenz: 99 }).transparenz, normal({ glas: true, transparenz: 62.4 }).transparenz], [10, 85, 62]);
  assert.deepEqual(glasVariablen(45), { '--fahnas-glas-deckung': '55%', '--fahnas-glas-unschaerfe': '10px' });
  assert.deepEqual(glasVariablen(85), { '--fahnas-glas-deckung': '15%', '--fahnas-glas-unschaerfe': '1px' }, 'klares Glas: Muster bleiben sichtbar');
  assert.equal(glasVariablen(10)['--fahnas-glas-unschaerfe'], '20px', 'Milchglas');
  assert.equal(glasVariablen(500)['--fahnas-glas-deckung'], '15%', 'nie ganz durchsichtig');
});

test('darstellung: Einstellungen normalisieren (unbekannt → Standard, Tapete nur mit Datei)', () => {
  assert.deepEqual(normal(null), { ...STANDARD });
  assert.deepEqual(normal({ theme: 'cyberpunk', akzent: 'pink', hintergrund: 'polygone', abdunkeln: 120 }), { theme: 'cyberpunk', akzent: 'pink', hintergrund: 'polygone', tapete: null, tapetenordner: null, skalierung: 'auto', zoom: 100, abdunkeln: 85, glas: false, transparenz: 45 });
  assert.equal(normal({ theme: 'quatsch' }).theme, 'auto');
  assert.equal(normal({ hintergrund: 'tapete' }).hintergrund, 'aus', 'ohne hochgeladene Tapete kein Tapeten-Hintergrund');
  assert.deepEqual(normal({ hintergrund: 'tapete', tapete: { art: 'video', v: 'mk3x9' } }).tapete, { quelle: 'eigen', id: ALT_ID, art: 'video', v: 'mk3x9' }, 'alte Form → erste Tapete der Sammlung');
  assert.equal(normal({ tapete: { art: 'video', v: '../x' } }).tapete, null);
  assert.equal(normal({ tapete: { quelle: 'eigen', id: '../../etc', art: 'bild', v: 'a1' } }).tapete, null);
  assert.deepEqual(normal({ tapete: { quelle: 'ordner', freigabe: 'medien', pfad: '/Wallpaper//nacht.mp4', art: 'video', v: 'a1' } }).tapete, { quelle: 'ordner', freigabe: 'medien', pfad: 'Wallpaper/nacht.mp4', art: 'video', v: 'a1' });
  assert.equal(normal({ tapete: { quelle: 'ordner', freigabe: 'medien', pfad: 'a/../../x.png', art: 'bild', v: 'a1' } }).tapete, null, 'kein Ausbruch aus der Freigabe');
  assert.equal(normal({ tapete: { quelle: 'ordner', freigabe: 'Medien!', pfad: 'x.png', art: 'bild', v: 'a1' } }).tapete, null);
  assert.deepEqual(normal({ tapetenordner: { freigabe: 'medien', pfad: 'Wallpaper/' } }).tapetenordner, { freigabe: 'medien', pfad: 'Wallpaper' });
  assert.deepEqual(normal({ tapetenordner: { freigabe: 'medien' } }).tapetenordner, { freigabe: 'medien', pfad: '' }, 'ganze Freigabe erlaubt');
  assert.equal(normal({ tapetenordner: { freigabe: 'medien', pfad: '..' } }).tapetenordner, null);
  assert.equal(normal({ skalierung: 'riesig' }).skalierung, 'auto');
  assert.equal(normal({ skalierung: 'fuellen' }).skalierung, 'fuellen', 'gewählte Skalierung bleibt');
  assert.equal(normal({ skalierung: 'kacheln' }).skalierung, 'kacheln');
  // Zoom (16.10.2026): 50–300 % in 5er-Schritten, Unsinn → 100
  assert.equal(normal({}).zoom, 100);
  assert.equal(normal({ zoom: 150 }).zoom, 150);
  assert.equal(normal({ zoom: 152 }).zoom, 150);
  assert.equal(normal({ zoom: 10 }).zoom, 50);
  assert.equal(normal({ zoom: 999 }).zoom, 300);
  assert.equal(normal({ zoom: 'x' }).zoom, 100);
  assert.equal(normal({ zoom: null }).zoom, 100);
  assert.equal(wirksameSkalierung('kacheln', { art: 'video' }), 'auto', 'Videos lassen sich nicht kacheln');
  // „Automatisch“ (16.10.2026): ganzes Bild, bis 5 % gestreckt, sonst Rand (unscharfe Kopie)
  const k4 = { w: 3840, h: 2160 };
  assert.deepEqual(einpassMass(k4, { w: 1440, h: 820 }), { w: 1440, h: 820, luecke: false }, '16:9 in 1,756:1 → randlos (1,2 % gestreckt)');
  assert.deepEqual(einpassMass(k4, { w: 1920, h: 1080 }), { w: 1920, h: 1080, luecke: false }, 'gleiches Seitenverhältnis');
  assert.deepEqual(einpassMass(k4, { w: 1440, h: 900 }), { w: 1440, h: 851, luecke: true }, '16:10: 5 % gestreckt, Rest oben/unten');
  assert.deepEqual(einpassMass(k4, { w: 1920, h: 960 }), { w: 1792, h: 960, luecke: true }, 'breites Fenster: Rest links/rechts');
  assert.deepEqual(einpassMass({ w: 1080, h: 1920 }, { w: 1440, h: 900 }), { w: 532, h: 900, luecke: true }, 'Hochformat');
  assert.deepEqual(einpassMass(null, { w: 800, h: 600 }), { w: 800, h: 600, luecke: false }, 'Maße unbekannt');
  // Zoom wirkt nur bei den Skalierungen nach „Automatisch“
  assert.equal(wirksamerZoom({ skalierung: 'auto', zoom: 150, tapete: { art: 'bild' } }), 100);
  assert.equal(wirksamerZoom({ skalierung: 'fuellen', zoom: 150, tapete: { art: 'bild' } }), 150);
  assert.equal(wirksamerZoom({ skalierung: 'kacheln', zoom: 150, tapete: { art: 'video' } }), 100, 'Video + Kacheln = Automatisch');
  assert.equal(wirksameSkalierung('kacheln', { art: 'bild' }), 'kacheln');
  assert.equal(tapeteUrl({ quelle: 'ordner', freigabe: 'medien', pfad: 'W p/ä.png', v: 'a1' }), '/api/dateien/herunterladen?freigabe=medien&pfad=W%20p%2F%C3%A4.png&anzeigen=1&v=a1');
  assert.equal(tapeteUrl({ quelle: 'eigen', id: 'abcdef012345', v: 'a1' }), '/api/hintergrund?id=abcdef012345&v=a1');
  assert.equal(THEMES.length, 7); assert.equal(AKZENTE.length, 10);
});

test('darstellung: Akzentfarben – Text auf dem Akzent bleibt lesbar (Kontrast ≥ 3:1)', () => {
  const kontrast = (a, b) => { const [h1, h2] = [helligkeit(hexRgb(a)), helligkeit(hexRgb(b))].sort((x, y) => y - x); return (h1 + 0.05) / (h2 + 0.05); };
  for (const a of AKZENTE.filter((x) => x.farbe)) for (const dunkel of [false, true]) {
    const v = akzentVariablen(a.farbe, dunkel);
    assert.ok(kontrast(v['--fahnas-akzent'], v['--fahnas-akzent-text']) >= 3, `${a.id} ${dunkel ? 'dunkel' : 'hell'}: Schrift auf Knopf`);
    assert.match(v['--fahnas-akzent-hell'], /^#[0-9a-f]{6}$/);
  }
  assert.equal(akzentVariablen('kein-hex', true), null);
});

test('tapeten: Ordnerliste filtert Bilder/Videos, sortiert natürlich, blättert ringsum', () => {
  const o = { freigabe: 'medien', pfad: 'Wallpaper' };
  const l = ausOrdnerliste(o, [
    { name: 'b10.jpg', art: 'datei', groesse: 5, geaendert: '2026-10-15T10:00:00Z' }, { name: 'b2.PNG', art: 'datei', groesse: 5, geaendert: '2026-10-15T10:00:00Z' },
    { name: 'nacht.webm', art: 'datei', groesse: 9 }, { name: 'liesmich.txt', art: 'datei' }, { name: 'Unterordner.jpg', art: 'ordner' },
  ]);
  assert.deepEqual(l.map((x) => [x.name, x.art, x.pfad]), [['b2.PNG', 'bild', 'Wallpaper/b2.PNG'], ['b10.jpg', 'bild', 'Wallpaper/b10.jpg'], ['nacht.webm', 'video', 'Wallpaper/nacht.webm']]);
  for (const x of l) assert.ok(normal({ tapete: auswahlForm(x) }).tapete, 'jede Ordner-Tapete übersteht normal()');
  assert.equal(ausOrdnerliste({ freigabe: 'medien', pfad: '' }, [{ name: 'a.gif', art: 'datei' }])[0].pfad, 'a.gif');
  assert.notEqual(dateiVersion({ geaendert: '2026-10-15T10:00:00Z', groesse: 5 }), dateiVersion({ geaendert: '2026-10-15T10:00:01Z', groesse: 5 }));
  assert.match(dateiVersion({}), /^[a-z0-9]{1,16}$/);
  assert.equal(nachbar(l, l[2], 1), l[0], 'nach der letzten kommt die erste');
  assert.equal(nachbar(l, l[0], -1), l[2]);
  assert.equal(nachbar(l, null, 1), l[0]);
  assert.equal(nachbar([], null, 1), null);
  assert.equal(anzeigename('C:\\bilder\\see.jpg'), 'see.jpg'); assert.equal(anzeigename(''), 'Tapete');
});

async function server() {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-tapete-'));
  const router = new Router();
  new HintergrundApi({ ordner: wurzel }).routen(router);
  const sitzungen = { a: { id: 'a', nutzer: 'anna', rolle: 'nutzer', csrf: 'ca' }, b: { id: 'b', nutzer: 'ben', rolle: 'nutzer', csrf: 'cb' } };
  const auth = { sitzungAus: async (req) => sitzungen[(/fahnas_sitzung=(\w+)/.exec(req.headers.cookie || '') || [])[1]] || null };
  const s = http.createServer(erstelleBehandler({ router, statisch: { bedienen: (q, a) => { a.writeHead(404); a.end(); } }, auth, protokoll: { eintrag: () => {} } }));
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const anfrage = (methode, pfad, { wer = 'a', typ, body, kopf = {} } = {}) => new Promise((ok, nein) => {
    const sz = sitzungen[wer];
    const q = http.request({ host: '127.0.0.1', port: s.address().port, path: pfad, method: methode, agent: false, headers: { Cookie: `fahnas_sitzung=${wer}; fahnas_csrf=${sz ? sz.csrf : 'x'}`, 'X-FAHNAS-CSRF': sz ? sz.csrf : 'x', ...(typ ? { 'Content-Type': typ } : {}), ...kopf } }, (r) => {
      const teile = []; r.on('data', (d) => teile.push(d)); r.on('end', () => ok({ status: r.statusCode, kopf: r.headers, daten: Buffer.concat(teile) }));
    });
    q.on('error', nein); q.end(body);
  });
  return { wurzel, anfrage, zu: async () => { s.close(); await fs.rm(wurzel, { recursive: true, force: true }); } };
}

test('tapete: hochladen, mit Range abrufen, nur eigene, Typ/Größe/CSRF geprüft, löschen', async () => {
  const s = await server();
  try {
    const video = Buffer.alloc(5000, 7);
    const h = await s.anfrage('POST', '/api/hintergrund', { typ: 'video/mp4', body: video });
    assert.equal(h.status, 200); const e = JSON.parse(h.daten).ergebnis;
    assert.equal(e.art, 'video'); assert.equal(e.groesse, 5000); assert.match(e.v, /^[a-z0-9]+$/);
    assert.match(e.id, /^[0-9a-f]{12}$/);
    const g = await s.anfrage('GET', `/api/hintergrund?id=${e.id}&v=${e.v}`);
    assert.equal(g.status, 200); assert.equal(g.kopf['content-type'], 'video/mp4'); assert.equal(g.daten.length, 5000); assert.match(g.kopf['cache-control'], /private/);
    const r = await s.anfrage('GET', `/api/hintergrund?id=${e.id}`, { kopf: { Range: 'bytes=100-199' } });
    assert.equal(r.status, 206); assert.equal(r.kopf['content-range'], 'bytes 100-199/5000'); assert.equal(r.daten.length, 100);
    assert.equal((await s.anfrage('GET', `/api/hintergrund?id=${e.id}`, { wer: 'b' })).status, 404, 'Ben sieht Annas Tapete nicht');
    assert.equal((await s.anfrage('GET', '/api/hintergrund?id=../../x')).status, 400);
    // zweite Tapete kommt dazu (Sammlung), Name aus dem Upload
    const b = await s.anfrage('POST', '/api/hintergrund?name=Sonnen%20see.png', { typ: 'image/png', body: Buffer.from('png') });
    const eb = JSON.parse(b.daten).ergebnis;
    assert.equal(eb.art, 'bild'); assert.equal(eb.name, 'Sonnen see.png');
    const liste = JSON.parse((await s.anfrage('GET', '/api/hintergrund/liste')).daten).ergebnis;
    assert.deepEqual(liste.eintraege.map((x) => x.id).sort(), [e.id, eb.id].sort());
    assert.equal(liste.max, MAX_ANZAHL);
    assert.equal(JSON.parse((await s.anfrage('GET', '/api/hintergrund/liste', { wer: 'b' })).daten).ergebnis.eintraege.length, 0, 'Ben hat eine eigene, leere Sammlung');
    assert.equal((await s.anfrage('POST', `/api/hintergrund/loeschen?id=${e.id}`, { wer: 'b', typ: 'application/json', body: '{}' })).status, 404, 'Ben löscht nichts von Anna');
    assert.equal((await s.anfrage('POST', `/api/hintergrund/loeschen?id=${e.id}`, { typ: 'application/json', body: '{}' })).status, 200);
    assert.deepEqual(JSON.parse((await s.anfrage('GET', '/api/hintergrund/liste')).daten).ergebnis.eintraege.map((x) => x.id), [eb.id], 'nur die eine ist weg');
    assert.equal((await s.anfrage('POST', '/api/hintergrund', { typ: 'text/html', body: Buffer.from('<script>') })).status, 400, 'nur Bild/Video');
    assert.equal((await s.anfrage('POST', '/api/hintergrund', { typ: 'video/mp4', body: Buffer.from('x'), kopf: { 'Content-Length': String(400 * 1024 * 1024) } }).catch(() => ({ status: 'abgebrochen' }))).status !== 200, true, 'zu groß');
    assert.notEqual((await s.anfrage('POST', '/api/hintergrund', { typ: 'image/png', body: Buffer.from('x'), kopf: { 'X-FAHNAS-CSRF': 'falsch' } })).status, 200, 'ohne gültiges CSRF');
    assert.equal((await s.anfrage('POST', '/api/hintergrund/loeschen', { typ: 'application/json', body: '{}' })).status, 200, 'ohne id: alle');
    assert.equal((await s.anfrage('GET', `/api/hintergrund?id=${eb.id}`)).status, 404);
  } finally { await s.zu(); }
});

test('tapete: alte Einzeldatei zieht in die Sammlung um, Höchstzahl greift', async () => {
  const s = await server();
  try {
    const api = new HintergrundApi({ ordner: s.wurzel });
    await fs.mkdir(path.join(s.wurzel, 'hintergrund'), { recursive: true });
    const alt = `${api.basis('anna')}.gif`;
    await fs.writeFile(alt, 'GIF89a');
    const zeit = new Date('2026-10-12T12:00:00Z'); await fs.utimes(alt, zeit, zeit);
    const vorher = Math.floor(zeit.getTime()).toString(36);
    const l = JSON.parse((await s.anfrage('GET', '/api/hintergrund/liste')).daten).ergebnis.eintraege;
    assert.deepEqual(l.map((x) => [x.id, x.art, x.v]), [[ALT_ID, 'bild', vorher]], 'gleiches v → alte Einstellung zeigt weiter dieselbe Tapete');
    const g = await s.anfrage('GET', `/api/hintergrund?v=${vorher}`);
    assert.equal(g.status, 200, 'alte Adresse ohne id liefert die übernommene Datei'); assert.equal(g.daten.toString(), 'GIF89a');
    for (let i = 1; i < MAX_ANZAHL; i++) await fs.writeFile(path.join(api.basis('anna'), `${String(i).padStart(12, 'a')}.png`), 'x');
    const voll = await s.anfrage('POST', '/api/hintergrund', { typ: 'image/png', body: Buffer.from('png') });
    assert.notEqual(voll.status, 200, `höchstens ${MAX_ANZAHL} eigene Tapeten`); assert.match(JSON.parse(voll.daten).fehler.meldung, /Höchstens/);
  } finally { await s.zu(); }
});
