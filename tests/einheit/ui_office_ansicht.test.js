// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Office“ (Plan 04 Aufgabe 13): Routen, Startseite mit Listen und Einstellungen (Standardordner, fällige
// Karten aufs Handy), „Neu“-Dialog, Rahmen (Status, Anwesende, Umbenennen, Freigeben, Außenänderung → Kopie sichern,
// Schnappschuss-Hinweis) und das Öffnen eines Dokuments mit Editor-Modul. DOM-Attrappe, Schein-ctx und -Verbindung.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const ID = 'oAAAAAAAAAAAAAAAA';
const ID2 = 'oBBBBBBBBBBBBBBBB';
let dom; let app; let start; let rahmen; let ansicht;
const ticks = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const dialogJetzt = () => document.body.querySelectorAll('dialog').at(-1) || null;
const aendern = (feld, wert) => { feld.value = wert; feld.dispatchEvent(new Event('change', { bubbles: true })); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  start = await import(pathToFileURL(path.join(PUBLIC, 'office', 'start.js')).href);
  rahmen = await import(pathToFileURL(path.join(PUBLIC, 'office', 'rahmen.js')).href);
  ansicht = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'office.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { for (const d of document.body.querySelectorAll('dialog')) d.remove(); document.body.textContent = ''; });

/** Schein-ctx: api(aktion, params) über `antworten` (Funktion oder Wert), Aufrufe und Meldungen werden mitgeschrieben. */
function ctxBauen(antworten = {}, mehr = {}) {
  const aufrufe = []; const meldungen = []; const fehler = []; const ziele = []; const titel = [];
  return {
    aufrufe, meldungen, fehler, ziele, titel,
    nutzer: { name: 'anna', rolle: 'nutzer' }, rolle: 'nutzer', t: app.t, el: app.el, symbol: app.symbol, format: app.format, hashFuer: app.hashFuer,
    dialog: app.dialog, eingabe: app.eingabe, bestaetigen: app.bestaetigen, fehlerText: (e) => (e && e.message) || String(e && e.code),
    melden: (text, art) => { meldungen.push([text, art]); }, zeigeFehler: (e) => { fehler.push(e); },
    navigiere: (h) => { ziele.push(h); }, setzeTitel: (x) => { titel.push(x); },
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (!(aktion in antworten)) throw new Error(`unerwartet: ${aktion}`);
      const a = antworten[aktion];
      return typeof a === 'function' ? a(params) : structuredClone(a);
    },
    ...mehr,
  };
}

function scheinSitzung(dok = {}, mehr = {}) {
  const hoerer = new Map();
  return {
    dok: { id: ID, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', besitzer: 'anna', recht: 'bearbeiten', schnappschuesse: true, ...dok },
    recht: dok.recht || 'bearbeiten', status: 'gespeichert', fehler: null, kid: 'k1', anwesend: [], daten: { spalten: [] }, ...mehr,
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    emit(art, x) { for (const fn of [...(hoerer.get(art) || [])]) fn(x); },
    hoererZahl() { let n = 0; for (const s of hoerer.values()) n += s.size; return n; },
  };
}

const LISTE = {
  zuletzt: [{ id: ID, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', besitzer: 'anna', besitzer_name: 'Anna', geaendert: '2026-10-18T10:00:00.000Z', recht: 'bearbeiten', geteilt: true }],
  meine: [
    { id: ID, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', besitzer: 'anna', besitzer_name: 'Anna', geaendert: '2026-10-18T10:00:00.000Z', recht: 'bearbeiten', geteilt: true },
    { id: ID2, art: 'tabelle', name: 'Budget', freigabe: 'team', pfad: 'Budget.fahtab', besitzer: 'anna', besitzer_name: 'Anna', geaendert: '2026-10-17T10:00:00.000Z', recht: 'bearbeiten', geteilt: false },
  ],
  fuer_mich: [],
};

test('routeAuswerten', () => {
  const { routeAuswerten } = ansicht;
  assert.deepEqual(routeAuswerten([]), { art: 'start' });
  assert.deepEqual(routeAuswerten(['neu', 'board']), { art: 'neu', dokArt: 'board' });
  assert.deepEqual(routeAuswerten(['oeffnen', 'team', 'Projekte', 'Sprint.fahboard']), { art: 'oeffnen', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard' });
  assert.deepEqual(routeAuswerten(['d', ID]), { art: 'dok', id: ID });
  assert.deepEqual(routeAuswerten(['neu', 'praesentation']), { art: 'start' });
  assert.deepEqual(routeAuswerten(['oeffnen', 'team']), { art: 'start' });
  assert.deepEqual(routeAuswerten(['d', 'kaputt']), { art: 'start' });
  assert.deepEqual(routeAuswerten(undefined), { art: 'start' });
  assert.equal(ansicht.default.id, 'office'); assert.equal(ansicht.default.symbol, 'office'); assert.equal(ansicht.default.rolle, 'nutzer');
  assert.equal(ansicht.default.titel((k) => k), 'office.titel');
});

test('geteiltText und statusText', () => {
  assert.equal(rahmen.geteiltText({ privat: true, geteilt_mit: [] }, (k) => k), 'office.privat');
  assert.equal(rahmen.geteiltText({ privat: false, geteilt_mit: [{ anzeigename: 'Anna A.' }, { anzeigename: 'Ben' }] }, (k, w) => `${k}:${w.namen}`), 'office.geteilt_mit:Anna A., Ben');
  assert.equal(rahmen.statusText('gespeichert', (k) => k), 'office.status_gespeichert');
  assert.equal(rahmen.statusText('speichert', (k) => k), 'office.status_speichert');
  assert.equal(rahmen.statusText('offline', (k) => k), 'office.status_offline');
  assert.equal(rahmen.statusText('fehler', (k, w) => `${k}:${w.fehler}`, 'Platte voll'), 'office.status_fehler:Platte voll');
});

test('listeAufbereiten und einstellungNormal', () => {
  assert.deepEqual(start.listeAufbereiten([...LISTE.meine, { id: 'kaputt', art: 'board' }, null, { id: ID, art: 'praesentation' }]), [
    { id: ID, art: 'board', name: 'Sprint', ort: 'team/Projekte', geaendert: '2026-10-18T10:00:00.000Z', geteilt: true },
    { id: ID2, art: 'tabelle', name: 'Budget', ort: 'team', geaendert: '2026-10-17T10:00:00.000Z', geteilt: false },
  ]);
  assert.deepEqual(start.listeAufbereiten(null), []);
  assert.deepEqual(start.einstellungNormal(null), { standardordner: null, faellig_push: true });
  assert.deepEqual(start.einstellungNormal({ standardordner: { freigabe: 'team', pfad: 'Projekte' }, faellig_push: false }), { standardordner: { freigabe: 'team', pfad: 'Projekte' }, faellig_push: false });
  assert.deepEqual(start.einstellungNormal({ standardordner: { freigabe: '' }, faellig_push: 'nein' }), { standardordner: null, faellig_push: true });
  assert.deepEqual(start.einstellungNormal({ standardordner: { freigabe: 'team' } }), { standardordner: { freigabe: 'team', pfad: '' }, faellig_push: true });
});

test('neuDialog: Standardordner vorbelegt; ohne Standardordner Pflichtwahl; „merken“ speichert die Einstellung', async () => {
  const ctx = ctxBauen({
    'nutzer.einstellungen.lesen': { bereich: 'office', wert: null },
    'freigaben.liste': [{ name: 'privat' }, { name: 'team' }],
    'dateien.liste': (p) => ({ freigabe: p.freigabe, schreiben: p.freigabe === 'team', eintraege: [] }),
    'office.anlegen': (p) => { if (p.name === 'Doppelt') throw Object.assign(new Error('Existiert bereits'), { code: 'E_EXISTIERT' }); return { id: ID, art: p.art, name: p.name }; },
    'nutzer.einstellungen.setzen': (p) => ({ bereich: 'office', wert: p.wert }),
  });
  const wahlen = [];
  const p = start.neuDialog(ctx, 'board', { ordnerWahl: async (c, o) => { wahlen.push(o); return { freigabe: 'team', pfad: 'Projekte' }; } });
  await ticks();
  assert.equal(wahlen.length, 1, 'ohne Standardordner zuerst die Ordnerwahl');
  assert.equal(wahlen[0].nurSchreibbar, true);
  assert.deepEqual(wahlen[0].start, { freigabe: 'team', pfad: '' }, 'vorgeschlagen: erste Freigabe mit Schreibrecht');
  const d = dialogJetzt();
  assert.match(d.querySelector('.of-neu-ziel').textContent, /team\/Projekte/);
  assert.equal(d.querySelector('.of-neu-name').value, 'office.neu_board');
  assert.equal(d.querySelector('.of-neu-merken-zeile').hidden, false);
  assert.equal(d.querySelector('.of-neu-merken').checked, true, 'beim ersten Mal vorgeschlagen');
  d.querySelector('.of-neu-name').value = 'Doppelt';
  d.querySelector('.of-neu-anlegen').click();
  await ticks();
  assert.equal(dialogJetzt(), d, 'Dialog bleibt offen');
  assert.equal(d.querySelector('.of-neu-fehler').hidden, false);
  assert.equal(d.querySelector('.of-neu-fehler').textContent, 'office.name_vergeben');
  d.querySelector('.of-neu-name').value = '../x';
  d.querySelector('.of-neu-anlegen').click();
  await ticks();
  assert.equal(d.querySelector('.of-neu-fehler').textContent, 'office.name_ungueltig');
  d.querySelector('.of-neu-name').value = ' Sprint ';
  d.querySelector('.of-neu-anlegen').click();
  assert.deepEqual(await p, { id: ID });
  assert.equal(dialogJetzt(), null);
  const anlegen = ctx.aufrufe.filter(([a]) => a === 'office.anlegen');
  assert.deepEqual(anlegen.at(-1), ['office.anlegen', { art: 'board', freigabe: 'team', ordner: 'Projekte', name: 'Sprint' }]);
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'nutzer.einstellungen.setzen'), ['nutzer.einstellungen.setzen', { name: 'anna', bereich: 'office', wert: { standardordner: { freigabe: 'team', pfad: 'Projekte' } } }]);

  // mit Standardordner: keine Pflichtwahl, „merken“ erst nach „Ändern“ und dann nicht vorgehakt
  const roh = { standardordner: { freigabe: 'team', pfad: 'Projekte' }, faellig_push: false };
  const ctx2 = ctxBauen({ 'nutzer.einstellungen.lesen': { bereich: 'office', wert: roh }, 'office.anlegen': (x) => ({ id: ID2, name: x.name }), 'nutzer.einstellungen.setzen': (x) => x });
  const wahlen2 = [];
  const p2 = start.neuDialog(ctx2, 'dokument', { ordnerWahl: async (c, o) => { wahlen2.push(o); return { freigabe: 'team', pfad: 'Archiv' }; } });
  await ticks();
  assert.equal(wahlen2.length, 0);
  const d2 = dialogJetzt();
  assert.match(d2.querySelector('.of-neu-ziel').textContent, /team\/Projekte/);
  assert.equal(d2.querySelector('.of-neu-merken-zeile').hidden, true);
  d2.querySelector('.of-neu-aendern').click();
  await ticks();
  assert.deepEqual(wahlen2[0].start, { freigabe: 'team', pfad: 'Projekte' });
  assert.match(d2.querySelector('.of-neu-ziel').textContent, /team\/Archiv/);
  assert.equal(d2.querySelector('.of-neu-merken-zeile').hidden, false);
  assert.equal(d2.querySelector('.of-neu-merken').checked, false);
  d2.querySelector('.of-neu-merken').checked = true;
  d2.querySelector('.of-neu-anlegen').click();
  assert.deepEqual(await p2, { id: ID2 });
  assert.deepEqual(ctx2.aufrufe.find(([a]) => a === 'nutzer.einstellungen.setzen')[1].wert, { standardordner: { freigabe: 'team', pfad: 'Archiv' }, faellig_push: false }, 'andere Einstellungen bleiben');

  // Abbruch der Pflichtwahl und im Dialog → null
  const ctx3 = ctxBauen({ 'nutzer.einstellungen.lesen': { wert: null }, 'freigaben.liste': [] });
  assert.equal(await start.neuDialog(ctx3, 'tabelle', { ordnerWahl: async () => null }), null);
  const p4 = start.neuDialog(ctx2, 'tabelle', { ordnerWahl: async () => null });
  await ticks();
  dialogJetzt().querySelector('.of-neu-abbrechen').click();
  assert.equal(await p4, null);
});

test('Startseite listet Zuletzt/Meine/Für mich; Klick führt zu #/office/d/<id>; Einstellungen mit Erklärung', async () => {
  const ctx = ctxBauen({
    'office.liste': LISTE,
    'nutzer.einstellungen.lesen': { bereich: 'office', wert: { standardordner: { freigabe: 'team', pfad: 'Projekte' }, eigen: 1 } },
    'nutzer.einstellungen.setzen': (p) => p,
  });
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  await start.startseite(behaelter, ctx);
  assert.deepEqual(behaelter.querySelectorAll('.of-neu-knopf').map((a) => a.getAttribute('href')), ['#/office/neu/dokument', '#/office/neu/tabelle', '#/office/neu/board']);
  assert.deepEqual(behaelter.querySelectorAll('.of-liste').map((l) => l.dataset.liste), ['zuletzt', 'meine', 'fuer_mich']);
  const eintraege = (k) => behaelter.querySelectorAll(`.of-liste[data-liste="${k}"] .of-eintrag`);
  assert.equal(eintraege('zuletzt').length, 1);
  assert.equal(eintraege('meine').length, 2);
  assert.equal(eintraege('zuletzt')[0].getAttribute('href'), `#/office/d/${ID}`);
  assert.equal(eintraege('meine')[1].getAttribute('href'), `#/office/d/${ID2}`);
  assert.match(eintraege('meine')[1].querySelector('.of-eintrag-name').textContent, /Budget/);
  assert.equal(eintraege('meine')[0].querySelector('.of-eintrag-ort').textContent, 'team/Projekte');
  assert.ok(eintraege('meine')[0].querySelector('.of-geteilt-marke'), 'geteilt sichtbar');
  assert.equal(eintraege('meine')[1].querySelector('.of-geteilt-marke'), null);
  assert.equal(behaelter.querySelector('.of-liste[data-liste="fuer_mich"] .leer').textContent, 'office.leer_fuer_mich');

  // Einstellungen: Standardordner und fällige Karten (Prüferhinweis 6) mit Erklärungen
  const karte = behaelter.querySelector('.of-einstellungen');
  assert.match(karte.querySelector('.of-standardordner').textContent, /team\/Projekte/);
  const texte = karte.querySelectorAll('.erklaerung').map((p) => p.textContent);
  assert.ok(texte.includes('office.standardordner_erklaerung')); assert.ok(texte.includes('office.faellig_push_erklaerung'));
  const push = karte.querySelector('.of-faellig-push');
  assert.equal(push.checked, true, 'Standard: an');
  push.checked = false; push.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.deepEqual(ctx.aufrufe.at(-1), ['nutzer.einstellungen.setzen', { name: 'anna', bereich: 'office', wert: { standardordner: { freigabe: 'team', pfad: 'Projekte' }, eigen: 1, faellig_push: false } }]);
  karte.querySelector('.of-standardordner-weg').click();
  await ticks();
  assert.deepEqual(ctx.aufrufe.at(-1)[1].wert, { standardordner: null, eigen: 1, faellig_push: false });
  assert.equal(karte.querySelector('.of-standardordner').textContent, 'office.standardordner_keiner');
  assert.equal(karte.querySelector('.of-standardordner-weg').hidden, true);

  // Liste nicht ladbar → Fehlertext statt Listen
  const ctx2 = ctxBauen({ 'office.liste': () => { throw new Error('Agent weg'); }, 'nutzer.einstellungen.lesen': { wert: null } });
  const b2 = document.createElement('div');
  await start.startseite(b2, ctx2);
  assert.equal(b2.querySelector('.of-listen .feld-fehler').textContent, 'Agent weg');
});

test('Freigeben-Dialog nur für den Besitzer; Änderung ruft office.freigeben', async () => {
  let freigaben = { ben: 'lesen' };
  const antworten = {
    'office.freigaben': () => ({ besitzer: 'anna', freigaben: { ...freigaben }, geteilt_mit: Object.keys(freigaben).map((n) => ({ name: n, anzeigename: n === 'ben' ? 'Ben' : 'Cara', recht: freigaben[n], ueber: 'office' })), privat: !Object.keys(freigaben).length }),
    'office.personen': [{ name: 'ben', anzeigename: 'Ben' }, { name: 'cara', anzeigename: 'Cara' }],
    'office.freigeben': (p) => { if (p.recht === 'keins') delete freigaben[p.nutzer]; else freigaben[p.nutzer] = p.recht; return { freigaben }; },
  };
  const ctx = ctxBauen(antworten);
  const sitzung = scheinSitzung();
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const r = rahmen.rahmenBauen(behaelter, { ctx, sitzung });
  await ticks();
  assert.equal(behaelter.querySelector('.of-geteilt').textContent, 'office.geteilt_mit:Ben');
  behaelter.querySelector('.of-teilen').click();
  await ticks();
  let d = dialogJetzt();
  const erkl = d.querySelectorAll('.erklaerung').map((p) => p.textContent);
  assert.ok(erkl.includes('office.freigabe_erklaerung')); assert.ok(erkl.includes('office.privat_erklaerung'));
  assert.equal(d.querySelector('.of-geteilt-text').textContent, 'office.geteilt_mit:Ben');
  const zeile = () => d.querySelector('.of-freigabe-zeile[data-nutzer="ben"]');
  assert.equal(zeile().querySelector('.of-freigabe-recht').value, 'lesen');
  assert.deepEqual(d.querySelectorAll('.of-person option').map((o) => o.value), ['cara'], 'schon Freigegebene stehen nicht zur Wahl');
  aendern(zeile().querySelector('.of-freigabe-recht'), 'bearbeiten');
  await ticks();
  assert.deepEqual(ctx.aufrufe.filter(([a]) => a === 'office.freigeben').at(-1), ['office.freigeben', { id: ID, nutzer: 'ben', recht: 'bearbeiten' }]);
  d = dialogJetzt();
  d.querySelector('.of-person').value = 'cara';
  d.querySelector('.of-hinzufuegen').click();
  await ticks();
  assert.deepEqual(ctx.aufrufe.filter(([a]) => a === 'office.freigeben').at(-1), ['office.freigeben', { id: ID, nutzer: 'cara', recht: 'lesen' }]);
  assert.ok(d.querySelector('.of-freigabe-zeile[data-nutzer="cara"]'), 'neu gezeichnet');
  zeile().querySelector('.of-entfernen').click();
  await ticks();
  assert.deepEqual(ctx.aufrufe.filter(([a]) => a === 'office.freigeben').at(-1), ['office.freigeben', { id: ID, nutzer: 'ben', recht: 'keins' }]);
  assert.equal(behaelter.querySelector('.of-geteilt').textContent, 'office.geteilt_mit:Cara', 'Kopfzeile folgt');
  d.querySelector('.of-freigaben-schliessen').click();
  r.entfernen();
  assert.equal(sitzung.hoererZahl(), 0, 'entfernen meldet alle Hörer ab');

  // Nicht-Besitzer: nur „Geteilt mit …“ und die Erklärung, nichts zum Ändern
  const ctxBen = ctxBauen(antworten, { nutzer: { name: 'ben', rolle: 'nutzer' } });
  const b2 = document.createElement('div'); document.body.appendChild(b2);
  rahmen.rahmenBauen(b2, { ctx: ctxBen, sitzung: scheinSitzung() });
  await ticks();
  b2.querySelector('.of-teilen').click();
  await ticks();
  const d2 = dialogJetzt();
  assert.equal(d2.querySelector('.of-geteilt-text').textContent, 'office.geteilt_mit:Cara');
  assert.equal(d2.querySelectorAll('select').length, 0);
  assert.equal(d2.querySelector('.of-hinzufuegen'), null);
  assert.ok(d2.querySelectorAll('.erklaerung').map((p) => p.textContent).includes('office.privat_erklaerung'));
  assert.equal(ctxBen.aufrufe.filter(([a]) => a === 'office.personen').length, 0);
});

test('Rahmen: Anwesende mit Avatar-Bild im Ring ihrer Farbe; Freigeben-Dialog mit Bildern (0.22.0)', async () => {
  const av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
  av.avatareSetzen({ ben: 'abcdef012345' });
  try {
    const antworten = {
      'office.freigaben': () => ({ besitzer: 'anna', freigaben: { ben: 'lesen' }, geteilt_mit: [{ name: 'ben', anzeigename: 'Ben', recht: 'lesen', ueber: 'office' }], privat: false }),
      'office.personen': [{ name: 'ben', anzeigename: 'Ben' }],
    };
    const ctx = ctxBauen(antworten);
    const sitzung = scheinSitzung();
    const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
    rahmen.rahmenBauen(behaelter, { ctx, sitzung });
    await ticks();
    sitzung.anwesend = [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#e11d48' }, { kid: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2563eb' }, { kid: 'k3', nutzer: 'cara', name: 'Cara', farbe: '#16a34a' }];
    sitzung.emit('anwesend', sitzung.anwesend);
    const kreise = behaelter.querySelectorAll('.of-anwesend li');
    assert.equal(kreise[0].getAttribute('title'), 'Ben'); assert.equal(kreise[0].style.getPropertyValue('--farbe'), '#2563eb');
    assert.equal(kreise[0].querySelector('.avatar img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
    const cara = kreise[1].querySelector('.avatar');
    assert.equal(cara.textContent, 'C'); assert.equal(cara.style.getPropertyValue('--avatar-farbe'), '#16a34a', 'ohne Bild: Buchstabe in der Sitzungsfarbe');
    behaelter.querySelector('.of-teilen').click(); await ticks();
    const zeile = dialogJetzt().querySelector('.of-freigabe-zeile[data-nutzer="ben"]');
    assert.equal(zeile.querySelector('.avatar img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
  } finally { av.avatareSetzen({}); }
});

test('Rahmen: Status, Anwesende, Nur lesen, Umbenennen, Export', async () => {
  const ctx = ctxBauen({ 'office.freigaben': { besitzer: 'anna', freigaben: {}, geteilt_mit: [], privat: true }, 'office.umbenennen': (p) => ({ id: p.id, name: p.name }) });
  const sitzung = scheinSitzung();
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const r = rahmen.rahmenBauen(behaelter, { ctx, sitzung });
  await ticks();
  assert.equal(r.element.parentNode, behaelter);
  assert.ok(r.inhalt && r.element.querySelector('.of-inhalt') === r.inhalt);
  assert.equal(behaelter.querySelector('.of-titel').textContent, 'Sprint');
  assert.equal(behaelter.querySelector('.of-geteilt').textContent, 'office.privat');
  assert.equal(behaelter.querySelector('.of-status').textContent, 'office.status_gespeichert');
  sitzung.status = 'fehler'; sitzung.fehler = { code: 'E_PLATZ', meldung: 'Platte voll' };
  sitzung.emit('status', 'fehler');
  assert.equal(behaelter.querySelector('.of-status').textContent, 'office.status_fehler:Platte voll');
  assert.equal(behaelter.querySelector('.of-status').dataset.status, 'fehler');

  sitzung.anwesend = [{ kid: 'k1', nutzer: 'anna', name: 'Anna', farbe: '#e11d48' }, { kid: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2563eb' }];
  sitzung.emit('anwesend', sitzung.anwesend);
  const kreise = behaelter.querySelectorAll('.of-anwesend li');
  assert.equal(kreise.length, 1, 'ich selbst zähle nicht');
  assert.equal(kreise[0].textContent, 'B'); assert.equal(kreise[0].getAttribute('title'), 'Ben');
  assert.equal(kreise[0].style.getPropertyValue('--farbe'), '#2563eb');

  assert.equal(behaelter.querySelector('.of-umbenennen').hidden, false);
  assert.equal(behaelter.querySelector('.of-nurlesen').hidden, true);
  behaelter.querySelector('.of-umbenennen').click();
  await ticks();
  const feld = dialogJetzt().querySelector('input');
  assert.equal(feld.value, 'Sprint');
  feld.value = 'Sprint 2';
  dialogJetzt().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await ticks();
  assert.deepEqual(ctx.aufrufe.at(-1), ['office.umbenennen', { id: ID, name: 'Sprint 2' }]);
  sitzung.dok.name = 'Sprint 2';
  sitzung.emit('umbenannt', { name: 'Sprint 2', pfad: 'Projekte/Sprint 2.fahboard' });
  assert.equal(behaelter.querySelector('.of-titel').textContent, 'Sprint 2');
  assert.equal(ctx.titel.at(-1), 'Sprint 2');

  sitzung.recht = 'lesen'; sitzung.dok.recht = 'lesen';
  sitzung.emit('recht', { recht: 'lesen' });
  assert.equal(behaelter.querySelector('.of-umbenennen').hidden, true);
  assert.equal(behaelter.querySelector('.of-nurlesen').hidden, false);

  assert.equal(behaelter.querySelector('.of-export').hidden, true, 'ohne Editor kein Export');
  const exporte = [];
  r.setzeEditor({ exportformate: [{ id: 'md', titel: 'Markdown' }], exportieren: async (id) => { exporte.push(id); return { name: 'Sprint.md', blob: new Blob(['# Sprint']) }; } });
  assert.equal(behaelter.querySelector('.of-export').hidden, false);
  behaelter.querySelector('.of-export').click();
  await ticks();
  dialogJetzt().querySelector('.of-export-format[data-format="md"]').click();
  await ticks();
  assert.deepEqual(exporte, ['md']);
  r.setzeEditor({ exportformate: [], exportieren: async () => null });
  assert.equal(behaelter.querySelector('.of-export').hidden, true);
});

test('Außenänderung: Kopie „meine Fassung“ nur mit eigenen Änderungen; gelöscht → Startseite', async () => {
  const ctx = ctxBauen({
    'office.freigaben': { besitzer: 'anna', freigaben: {}, geteilt_mit: [], privat: true },
    'office.anlegen': (p) => ({ id: ID2, name: p.name }),
    'office.import_setzen': { version: 1 },
  });
  const sitzung = scheinSitzung();
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  rahmen.rahmenBauen(behaelter, { ctx, sitzung });
  await ticks();
  const meine = { spalten: [{ id: 'todo00', titel: 'Meins' }] };
  sitzung.emit('extern', { eigeneUngesichert: true, daten: meine });
  const d = dialogJetzt();
  assert.ok(d, 'Dialog bei eigenen Änderungen');
  assert.equal(d.querySelector('.dialog-titel').textContent, 'office.extern_titel');
  d.querySelector('.of-kopie').click();
  await ticks();
  const anlegen = ctx.aufrufe.find(([a]) => a === 'office.anlegen')[1];
  assert.equal(anlegen.art, 'board'); assert.equal(anlegen.freigabe, 'team'); assert.equal(anlegen.ordner, 'Projekte'); assert.equal(anlegen.beide, true);
  assert.match(anlegen.name, /^Sprint \(office\.meine_fassung:\d{4}-\d\d-\d\d \d\d-\d\d\)$/);
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'office.import_setzen')[1], { id: ID2, daten: meine });
  assert.equal(d.querySelector('.of-kopie-oeffnen').getAttribute('href'), `#/office/d/${ID2}`, 'Meldung mit Link zur Kopie');
  d.querySelector('.of-kopie-oeffnen').click();
  assert.equal(dialogJetzt(), null);

  sitzung.emit('extern', { eigeneUngesichert: false, daten: meine });
  assert.equal(dialogJetzt(), null, 'ohne eigene Änderungen kein Dialog');
  assert.deepEqual(ctx.meldungen.at(-1), ['office.extern_neu_geladen', 'info']);
  sitzung.emit('neu_laden', { grund: 'zu_alt', eigeneUngesichert: true, daten: meine });
  assert.ok(dialogJetzt().querySelector('.of-kopie'), 'auch nach einem Neuladen');
  dialogJetzt().querySelector('.of-neu-laden').click();
  sitzung.emit('neu_laden', { grund: 'geloescht', eigeneUngesichert: false, daten: meine });
  assert.deepEqual(ctx.meldungen.at(-1), ['office.geloescht_meldung', 'warnung']);
  assert.equal(ctx.ziele.at(-1), '#/office');
  sitzung.emit('fehler', { code: 'E_RECHTE', meldung: 'Kein Zugriff mehr' });
  assert.equal(ctx.fehler.at(-1).code, 'E_RECHTE');
  assert.equal(ctx.ziele.length, 2);
});

test('Schnappschuss-Hinweis einmal je Dokument', () => {
  const speicher = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; })();
  assert.equal(rahmen.hinweisNoetig({ id: 'o1', schnappschuesse: false }, speicher), true);
  assert.equal(speicher.m.has('fahnas.office.hinweis.o1'), true);
  assert.equal(rahmen.hinweisNoetig({ id: 'o1', schnappschuesse: false }, speicher), false);
  assert.equal(rahmen.hinweisNoetig({ id: 'o2', schnappschuesse: true }, speicher), false);
  assert.equal(rahmen.hinweisNoetig({ id: 'o3', schnappschuesse: false }, { getItem() { throw new Error('gesperrt'); }, setItem() {} }), true, 'ohne Speicher lieber zeigen');
  // im Rahmen: sichtbar mit Text, Schließen blendet aus
  const b = document.createElement('div'); document.body.appendChild(b);
  try { localStorage.clear(); } catch { /* egal */ }
  rahmen.rahmenBauen(b, { ctx: ctxBauen({ 'office.freigaben': { privat: true, geteilt_mit: [] } }), sitzung: scheinSitzung({ id: 'oCCCCCCCCCCCCCCCC', schnappschuesse: false }) });
  const h = b.querySelector('.of-hinweis');
  assert.equal(h.hidden, false); assert.match(h.textContent, /office\.hinweis_schnappschuesse/);
  h.querySelector('.of-hinweis-weg').click();
  assert.equal(h.hidden, true);
});

test('Ansicht: Dokument öffnen bindet Rahmen und Editor ein; neu_geladen bindet neu; Startseite schließt die Sitzung', async () => {
  const hoerer = new Map();
  const v = {
    status: 'verbunden', gesendet: [],
    starten() {}, stoppen() {},
    senden(o) { this.gesendet.push(structuredClone(o)); return true; },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    ausloesen(art, o) { for (const fn of [...(hoerer.get(art) || [])]) fn(o); },
    letzte(art) { return this.gesendet.findLast((n) => n.art === art); },
  };
  const geoeffnet = (anfrage) => ({ art: 'geoeffnet', anfrage, kid: 'k1', anwesend: [], dok: { id: ID, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Projekte/Sprint.fahboard', recht: 'bearbeiten', besitzer: 'anna', version: 1, daten: { spalten: [], karten: {}, etiketten: {} }, schnappschuesse: true } });
  const editor = [];
  const modul = {
    editorEinbinden: async (beh, { sitzung, recht }) => {
      editor.push(['ein', recht, sitzung.dok.id]);
      beh.appendChild(app.el('p', { class: 'test-editor', text: 'Editor' }));
      return { verlassen: () => editor.push(['weg']), exportformate: [], exportieren: async () => null };
    },
  };
  const ersetzt = [];
  const altReplace = location.replace; location.replace = (h) => { ersetzt.push(h); };
  try {
    const ctx = ctxBauen({ 'office.freigaben': { privat: true, geteilt_mit: [] }, 'office.liste': { zuletzt: [], meine: [], fuer_mich: [] }, 'nutzer.einstellungen.lesen': { wert: null } }, {
      route: { id: 'office', teile: ['oeffnen', 'team', 'Projekte', 'Sprint.fahboard'] },
      _officeVerbindung: v, _editorLaden: async (art) => { assert.equal(art, 'board'); return modul; },
    });
    const wurzel = app.el('section', { class: 'ansicht ansicht-office' }); document.body.appendChild(wurzel);
    const p = ansicht.default.einbinden(wurzel, ctx);
    await ticks();
    assert.deepEqual(v.letzte('oeffnen').ref, { freigabe: 'team', pfad: 'Projekte/Sprint.fahboard' });
    v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage));
    await p; await ticks();
    assert.deepEqual(ersetzt, [`#/office/d/${ID}`], 'Hash ohne neuen Verlaufseintrag ersetzt');
    assert.ok(wurzel.querySelector('.of-rahmen')); assert.ok(wurzel.querySelector('.of-inhalt .test-editor'));
    assert.deepEqual(editor, [['ein', 'bearbeiten', ID]]);
    assert.equal(ctx.titel.at(-1), 'Sprint');
    // derselbe Hash danach (location.replace) → nichts Neues
    await ansicht.default.navigieren({ id: 'office', teile: ['d', ID] }, ctx);
    assert.equal(v.gesendet.filter((n) => n.art === 'oeffnen').length, 1);
    // Außenänderung → die Sitzung öffnet neu → Editor neu eingebunden
    v.ausloesen('extern', { art: 'extern', dok: ID });
    v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage));
    await ticks();
    assert.deepEqual(editor, [['ein', 'bearbeiten', ID], ['weg'], ['ein', 'bearbeiten', ID]]);
    assert.equal(wurzel.querySelectorAll('.test-editor').length, 1);
    // zur Startseite → Editor verlassen, Sitzung schließt
    await ansicht.default.navigieren({ id: 'office', teile: [] }, ctx);
    await ticks();
    assert.deepEqual(editor.at(-1), ['weg']);
    assert.deepEqual(v.letzte('schliessen'), { art: 'schliessen', dok: ID });
    assert.ok(wurzel.querySelector('.of-start')); assert.equal(wurzel.querySelector('.of-rahmen'), null);
    // unbekannte Art des Editors → Hinweis
    const ctx2 = { ...ctx, route: { id: 'office', teile: ['d', ID] }, _editorLaden: async () => { throw new Error('fehlt'); } };
    const p2 = ansicht.default.navigieren(ctx2.route, ctx2);
    await ticks();
    v.ausloesen('geoeffnet', geoeffnet(v.letzte('oeffnen').anfrage));
    await p2; await ticks();
    assert.equal(wurzel.querySelector('.of-art-fehlt').textContent, 'office.art_fehlt');
    ansicht.default.verlassen();
    await ticks();
    assert.equal(v.gesendet.filter((n) => n.art === 'schliessen').length, 2);
  } finally { location.replace = altReplace; }
});

test('Prüfbericht Plan 04, I6: Dokument verschwunden – mit eigenen Änderungen Kopie anbieten, danach Startseite', async () => {
  const ctx = ctxBauen({ 'office.freigaben': { privat: true, geteilt_mit: [] }, 'office.anlegen': (p) => ({ id: ID2, name: p.name }), 'office.import_setzen': { version: 1 } });
  const sitzung = scheinSitzung();
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  rahmen.rahmenBauen(behaelter, { ctx, sitzung });
  await ticks();
  sitzung.emit('neu_laden', { grund: 'verschoben', eigeneUngesichert: true, daten: { meins: 1 } });
  const d = dialogJetzt();
  assert.equal(d.querySelector('.dialog-titel').textContent, 'office.verschwunden_titel');
  d.querySelector('.of-kopie').click();
  await ticks();
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'office.import_setzen')[1], { id: ID2, daten: { meins: 1 } });
  d.querySelector('.dialog-schliessen').click();
  assert.equal(ctx.ziele.at(-1), '#/office', 'danach zur Startseite');
  sitzung.emit('neu_laden', { grund: 'verschoben', eigeneUngesichert: false });
  assert.deepEqual(ctx.meldungen.at(-1), ['office.verschoben_meldung', 'warnung']);
});

test('Prüfbericht Plan 04, I8: Verlassen mit Ausstehendem meldet „wird nachgereicht“', async () => {
  const hoerer = new Map();
  const v = {
    status: 'verbunden', gesendet: [], starten() {}, stoppen() {},
    senden(o) { this.gesendet.push(structuredClone(o)); return true; },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    ausloesen(art, o) { for (const fn of [...(hoerer.get(art) || [])]) fn(o); },
    letzte(art) { return this.gesendet.findLast((n) => n.art === art); },
  };
  const ctx = ctxBauen({ 'office.freigaben': { privat: true, geteilt_mit: [] }, 'office.liste': { zuletzt: [], meine: [], fuer_mich: [] }, 'nutzer.einstellungen.lesen': { wert: null } }, {
    route: { id: 'office', teile: ['d', ID] }, _officeVerbindung: v, _editorLaden: async () => ({ editorEinbinden: async () => ({ verlassen() {}, exportformate: [], exportieren: async () => null }) }),
  });
  const wurzel = app.el('section'); document.body.appendChild(wurzel);
  const p = ansicht.default.einbinden(wurzel, ctx);
  await ticks();
  v.ausloesen('geoeffnet', { art: 'geoeffnet', anfrage: v.letzte('oeffnen').anfrage, kid: 'k1', anwesend: [], dok: { id: ID, art: 'board', name: 'Sprint', freigabe: 'team', pfad: 'Sprint.fahboard', recht: 'bearbeiten', besitzer: 'anna', version: 1, daten: { spalten: [{ id: 'todo00', titel: 'A', pos: 'i' }], karten: {}, etiketten: {} }, schnappschuesse: true } });
  await p; await ticks();
  // eine eigene Op unterwegs, dann zur Startseite
  const { sitzungOeffnen } = await import(pathToFileURL(path.join(PUBLIC, 'office', 'sitzung.js')).href);
  const s = await sitzungOeffnen({ ref: { id: ID }, ctx, verbindung: v });
  s.lokal({ typ: 'spalte_setzen', id: 'todo00', titel: 'B' });
  await ansicht.default.navigieren({ id: 'office', teile: [] }, ctx);
  await ticks();
  assert.ok(ctx.meldungen.some(([text]) => text === 'office.wird_nachgereicht'));
  assert.equal(v.letzte('schliessen'), undefined, 'noch nicht abgemeldet');
  ansicht.default.verlassen();
});
