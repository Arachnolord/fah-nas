// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office im Dateimanager (Plan 04 Aufgabe 15): Import von .docx/.xlsx/.csv als Kopie (anlegen → Uploads → verknüpfen →
// import_setzen → öffnen), Fehler des Typmoduls ohne angelegtes Dokument, Zielordner ohne Schreibrecht, Bündel öffnen
// das Office, und die Ordnerwahl mit Dateien (V8-Ergänzung) für „Anhang aus dem NAS“.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let imp; let dateien; let ow;
const ticks = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const dialogJetzt = () => document.body.querySelectorAll('dialog').at(-1) || null;
const B = new Blob(['PNG']);

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  imp = await import(pathToFileURL(path.join(PUBLIC, 'office', 'import.js')).href);
  dateien = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href);
  ow = await import(pathToFileURL(path.join(PUBLIC, 'ordnerwahl.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { for (const d of document.body.querySelectorAll('dialog')) d.remove(); });

function ctxBauen(antworten = {}) {
  const ctx = {
    aufrufe: [], meldungen: [], navigiert: null, geladen: [],
    t: app.t, hashFuer: app.hashFuer, dialog: app.dialog, fehlerText: (e) => (e && e.message) || String(e),
    melden: (text, art, dauer) => { ctx.meldungen.push([text, art, dauer]); },
    zeigeFehler: (e) => { ctx.meldungen.push([e && e.message, 'fehler']); },
    navigiere: (h) => { ctx.navigiert = h; },
    ladeBlob: async (freigabe, pfad, max) => { ctx.geladen.push([freigabe, pfad, max]); return new Blob(['DOCX']); },
    api: async (aktion, params) => {
      ctx.aufrufe.push([aktion, params]);
      if (aktion in antworten) { const a = antworten[aktion]; return typeof a === 'function' ? a(params) : structuredClone(a); }
      if (aktion === 'office.anlegen') return { id: 'oNEU', art: params.art, name: params.name };
      if (aktion === 'office.import_setzen') return { version: 1 };
      throw new Error(`unerwartet: ${aktion}`);
    },
  };
  return ctx;
}
const MODUL = () => ({
  importieren: async () => ({ daten: { x: 1 }, dateien: [{ schluessel: 'bild1', name: 'a.png', blob: B }], fehlte: ['2 Diagramme'] }),
  verknuepfen: (d, karte) => ({ ...d, bild: karte.get('bild1') }),
});

test('artFuerImport und officeArt', () => {
  assert.deepEqual(['a.docx', 'b.XLSX', 'c.csv', 'd.pdf', 'e.doc', ''].map(imp.artFuerImport), ['dokument', 'tabelle', 'tabelle', null, null, null]);
  assert.deepEqual(['x.fahboard', 'y.fahdoc', 'z.FAHTAB', 'w.txt'].map(dateien.officeArt), ['board', 'dokument', 'tabelle', null]);
  assert.equal(dateien.artVon({ name: 'Sprint.fahboard', art: 'ordner' }), 'office');
  assert.equal(dateien.artVon({ name: 'Sprint.fahboard', art: 'datei' }), 'datei');
  assert.equal(dateien.artVon({ name: 'Projekte', art: 'ordner' }), 'ordner');
});

test('Import: anlegen (beide) → Uploads → verknuepfen → import_setzen → öffnen; fehlte wird gemeldet', async () => {
  const ctx = ctxBauen();
  const hochgeladen = [];
  const r = await imp.importAblauf(ctx, { freigabe: 'team', pfad: 'Berichte/Q3.docx', name: 'Q3.docx', schreibbar: true }, {
    modulLaden: async (art) => { assert.equal(art, 'dokument'); return MODUL(); },
    hochladen: async (url, blob) => { hochgeladen.push([url, blob]); return { datei: 'abcdefghijkl-a.png', name: 'a.png' }; },
  });
  assert.deepEqual(ctx.aufrufe, [
    ['office.anlegen', { art: 'dokument', freigabe: 'team', ordner: 'Berichte', name: 'Q3', beide: true }],
    ['office.import_setzen', { id: 'oNEU', daten: { x: 1, bild: 'abcdefghijkl-a.png' } }],
  ]);
  assert.deepEqual(ctx.geladen, [['team', 'Berichte/Q3.docx', 200 * 1024 * 1024]]);
  assert.deepEqual(hochgeladen, [['/api/office/hochladen?id=oNEU&name=a.png', B]]);
  assert.equal(r.id, 'oNEU'); assert.equal(ctx.navigiert, '#/office/d/oNEU');
  assert.match(ctx.meldungen[0][0], /2 Diagramme/); assert.equal(ctx.meldungen[0][1], 'warnung'); assert.equal(ctx.meldungen[0][2], 10000);

  // Quelle in der Wurzel der Freigabe, ohne fehlte: keine Meldung
  const ctx2 = ctxBauen();
  await imp.importAblauf(ctx2, { freigabe: 'team', pfad: 'Liste.csv', name: 'Liste.csv', schreibbar: true }, { modulLaden: async (art) => { assert.equal(art, 'tabelle'); return { importieren: async () => ({ daten: { b: [] }, dateien: [], fehlte: [] }), verknuepfen: (d) => d }; } });
  assert.deepEqual(ctx2.aufrufe[0], ['office.anlegen', { art: 'tabelle', freigabe: 'team', ordner: '', name: 'Liste', beide: true }]);
  assert.equal(ctx2.meldungen.length, 0);
});

test('Typmodul fehlt → Hinweis „noch nicht verfügbar“, nichts angelegt; kaputte Datei → Meldung 10 s, nichts angelegt', async () => {
  const ctx = ctxBauen();
  assert.equal(await imp.importAblauf(ctx, { freigabe: 'team', pfad: 'Q3.docx', name: 'Q3.docx', schreibbar: true }, { modulLaden: async () => { throw new Error('fehlt'); } }), null);
  assert.deepEqual(ctx.aufrufe, []);
  assert.deepEqual(ctx.meldungen, [['office.import_nicht_verfuegbar', 'warnung', undefined]]);
  assert.deepEqual(ctx.geladen, [], 'ohne Typmodul wird nichts heruntergeladen');

  // Prüferhinweis 3: importieren wirft (kaputte/zu große Datei) → übersetzte Meldung 10 s, null, kein office.anlegen
  const ctx2 = ctxBauen();
  const kaputt = { importieren: async () => { throw new Error('Die Datei ist beschädigt.'); }, verknuepfen: (d) => d };
  assert.equal(await imp.importAblauf(ctx2, { freigabe: 'team', pfad: 'Q3.docx', name: 'Q3.docx', schreibbar: true }, { modulLaden: async () => kaputt }), null);
  assert.deepEqual(ctx2.aufrufe, []);
  assert.deepEqual(ctx2.meldungen, [['Die Datei ist beschädigt.', 'fehler', 10000]]);

  // Schritt nach anlegen scheitert → leeres Dokument bleibt, Meldung sagt es, kein Öffnen
  const ctx3 = ctxBauen({ 'office.import_setzen': () => { throw new Error('Platte voll'); } });
  assert.equal(await imp.importAblauf(ctx3, { freigabe: 'team', pfad: 'Q3.docx', name: 'Q3.docx', schreibbar: true }, { modulLaden: async () => MODUL(), hochladen: async () => ({ datei: 'abcdefghijkl-a.png', name: 'a.png' }) }), null);
  assert.equal(ctx3.navigiert, null);
  assert.match(ctx3.meldungen.at(-1)[0], /^office\.import_abgebrochen:Q3,Platte voll$/);
});

test('ohne Schreibrecht im Quellordner → Ordnerwahl; Abbruch → null', async () => {
  const ctx = ctxBauen();
  const wahlen = [];
  const r = await imp.importAblauf(ctx, { freigabe: 'archiv', pfad: 'alt/Q3.xlsx', name: 'Q3.xlsx', schreibbar: false }, { modulLaden: async () => MODUL(), ordnerWahl: async (c, o) => { wahlen.push(o); return null; } });
  assert.equal(r, null);
  assert.equal(wahlen.length, 1); assert.equal(wahlen[0].nurSchreibbar, true); assert.equal(wahlen[0].titel, 'office.import_ordner');
  assert.deepEqual(ctx.aufrufe, []);
  const r2 = await imp.importAblauf(ctx, { freigabe: 'archiv', pfad: 'alt/Q3.xlsx', name: 'Q3.xlsx', schreibbar: false }, { modulLaden: async () => MODUL(), hochladen: async () => ({ datei: 'abcdefghijkl-a.png', name: 'a.png' }), ordnerWahl: async () => ({ freigabe: 'team', pfad: 'Neu' }) });
  assert.equal(r2.id, 'oNEU');
  assert.deepEqual(ctx.aufrufe[0], ['office.anlegen', { art: 'tabelle', freigabe: 'team', ordner: 'Neu', name: 'Q3', beide: true }]);
});

test('Dateimanager: Bündel öffnet das Office, .docx/.xlsx/.csv fragen nach Import', async () => {
  localStorage.setItem('fahnas_dateien_modus', 'liste');
  const eintraege = [
    { name: 'Sprint.fahboard', art: 'ordner', geaendert: '2026-10-18T10:00:00.000Z' },
    { name: 'Q3.docx', art: 'datei', groesse: 1000, geaendert: '2026-10-18T10:00:00.000Z' },
    { name: 'Liste.csv', art: 'datei', groesse: 10, geaendert: '2026-10-18T10:00:00.000Z' },
  ];
  const ctx = ctxBauen({ 'freigaben.liste': [{ name: 'team', papierkorb: true }], 'dateien.liste': { eintraege, schreiben: true, papierkorb: true } });
  const streng = ctx.api; ctx.api = async (a, p) => { try { return await streng(a, p); } catch { return {}; } }; // Ordnergrößen u. Ä. sind hier egal
  Object.assign(ctx, { rolle: 'nutzer', route: { id: 'dateien', teile: ['team', 'Projekte'] }, sse: { on() { return () => {}; } }, setzeTitel() {}, downloadUrl: () => '#', vorschauUrl: () => '#', bestaetigen: async () => false, eingabe: async () => null });
  const wurzel = document.createElement('main'); document.body.appendChild(wurzel);
  await dateien.default.einbinden(wurzel, ctx);
  await ticks();
  const zeile = (name) => wurzel.querySelector(`tr[data-name="${name}"]`);
  assert.ok(zeile('Sprint.fahboard').querySelector('.dateien-eintrag-name svg use').getAttribute('href').endsWith('#symbol-board'), 'Symbol der Art');
  zeile('Sprint.fahboard').dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
  assert.equal(ctx.navigiert, '#/office/oeffnen/team/Projekte/Sprint.fahboard');

  zeile('Q3.docx').dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
  let d = dialogJetzt();
  assert.ok(d, 'Importfrage offen');
  assert.ok(d.querySelectorAll('.erklaerung').map((p) => p.textContent).includes('dateien.office_import_erklaerung'));
  assert.equal(d.querySelector('.dateien-office-importieren').textContent, 'dateien.office_importieren');
  assert.equal(d.querySelector('.dateien-office-herunterladen').textContent, 'dateien.herunterladen');
  assert.equal(d.querySelector('.dateien-als-text'), null);
  d.querySelector('.dialog-schliessen').click();

  zeile('Liste.csv').dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
  d = dialogJetzt();
  assert.equal(d.querySelector('.dateien-office-importieren').textContent, 'dateien.office_importieren');
  assert.equal(d.querySelector('.dateien-als-text').textContent, 'dateien.als_text_bearbeiten');
  assert.equal(d.querySelector('.dateien-office-herunterladen'), null);
  d.querySelector('.dialog-schliessen').click();
  dateien.default.verlassen?.();
});

test('Ordnerwahl mit dateien:true liefert eine Datei; Ordner gewählt → OK deaktiviert', async () => {
  const baum = {
    'team\n': { schreiben: false, eintraege: [{ name: 'Bilder', art: 'ordner' }, { name: 'plan.pdf', art: 'datei' }, { name: 'Sprint.fahboard', art: 'ordner' }] },
    'team\nBilder': { schreiben: false, eintraege: [{ name: 'a.png', art: 'datei' }] },
  };
  const ctx = { dialog: app.dialog, fehlerText: (e) => e.message, api: async (aktion, p) => {
    if (aktion === 'freigaben.liste') return [{ name: 'team' }];
    if (aktion === 'dateien.liste') return { freigabe: p.freigabe, ...baum[`${p.freigabe}\n${p.pfad}`] };
    throw new Error(`unerwartet: ${aktion}`);
  } };
  const zeilen = () => dialogJetzt().querySelectorAll('.dateien-baum-zeile');
  const zeile = (name) => zeilen().find((z) => z.querySelector('.dateien-baum-name').textContent === name);
  const ok = () => dialogJetzt().querySelector('.ordnerwahl-ok');
  const p = ow.ordnerWaehlen(ctx, { titel: 'Datei wählen', dateien: true, nurSchreibbar: true });
  await ticks();
  zeile('team').querySelector('.dateien-baum-auf').click();
  await ticks();
  assert.deepEqual(zeilen().map((z) => z.querySelector('.dateien-baum-name').textContent), ['team', 'Bilder', 'Sprint.fahboard', 'plan.pdf']);
  assert.equal(zeile('Sprint.fahboard').querySelector('.dateien-baum-auf'), null, 'Bündel nicht aufklappbar');
  assert.equal(zeile('Sprint.fahboard').getAttribute('aria-disabled'), 'true');
  zeile('Sprint.fahboard').click(); await ticks();
  assert.equal(ok().disabled, true, 'Bündel ist keine Datei');
  zeile('Bilder').click(); await ticks();
  assert.equal(ok().disabled, true, 'Ordner gewählt → OK aus');
  zeile('plan.pdf').click(); await ticks();
  assert.equal(ok().disabled, false, 'Datei gewählt – nurSchreibbar gilt hier nicht');
  zeile('Bilder').querySelector('.dateien-baum-auf').click(); await ticks();
  zeile('a.png').click(); await ticks();
  ok().click();
  assert.deepEqual(await p, { freigabe: 'team', pfad: 'Bilder/a.png' });

  // ohne dateien: Bündel erscheinen, lassen sich aber weder aufklappen noch wählen; Dateien fehlen
  const baum2 = { 'team\n': { schreiben: true, eintraege: [{ name: 'Bilder', art: 'ordner' }, { name: 'plan.pdf', art: 'datei' }, { name: 'Sprint.fahboard', art: 'ordner' }] }, 'team\nBilder': { schreiben: true, eintraege: [] } };
  const ctx2 = { ...ctx, api: async (aktion, q) => (aktion === 'freigaben.liste' ? [{ name: 'team' }] : { freigabe: q.freigabe, ...baum2[`${q.freigabe}\n${q.pfad}`] }) };
  const p2 = ow.ordnerWaehlen(ctx2, { titel: 'Ziel' });
  await ticks();
  zeile('team').querySelector('.dateien-baum-auf').click(); await ticks();
  assert.deepEqual(zeilen().map((z) => z.querySelector('.dateien-baum-name').textContent), ['team', 'Bilder', 'Sprint.fahboard']);
  zeile('Sprint.fahboard').click(); await ticks();
  assert.equal(ok().disabled, true);
  zeile('Bilder').click(); await ticks();
  assert.equal(ok().disabled, false);
  ok().click();
  assert.deepEqual(await p2, { freigabe: 'team', pfad: 'Bilder' });
});
