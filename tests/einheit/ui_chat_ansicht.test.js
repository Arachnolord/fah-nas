// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Ansicht (Plan 02, Aufgabe 17): Routen, Raumliste, Einladungsadressen, Einstellungen, Einbinden mit
// Schein-Verbindung (Verlauf laden, gelesen melden, Senden, Ereignisse), Admin-Karten.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, alsText } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const R = 'rAAAAAAAAAAAAAAAA';
const D = 'dBBBBBBBBBBBBBBBBBBBB';
let dom; let app; let chat; let liste; let dialoge; let einst; let erw;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 8; i++) await warte(); };

before(async () => {
  dom = domAttrappe();
  globalThis.HTMLElement.prototype.getContext = () => ({ fillRect() {}, fillStyle: '' });
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  chat = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'chat.js')).href);
  liste = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'raumliste.js')).href);
  dialoge = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'raum-dialoge.js')).href);
  einst = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'einstellungen.js')).href);
  erw = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'erweiterungen.js')).href);
});
after(() => { delete globalThis.HTMLElement.prototype.getContext; dom.aufraeumen(); });
afterEach(() => { try { chat.default.verlassen(); } catch { /* nicht eingebunden */ } document.body.textContent = ''; });

const zeit = (min) => new Date(2026, 9, 18, 10, min).toISOString();
const UEBERSICHT = {
  raeume: [
    { id: R, art: 'raum', name: 'Team', beschreibung: 'Alles zum Projekt', mitglieder: [{ name: 'anna', anzeigename: 'Anna' }, { name: 'ben', anzeigename: 'Ben' }], gaeste: [{ id: 'gX', name: 'Gustav' }], ungelesen: 2, letzte: { id: 'n2', zeit: zeit(1), kurz: 'Hallo', von_name: 'Ben' }, verwalter: true, verwaltende: ['anna'], stumm: false },
    { id: D, art: 'dm', name: 'Ben', beschreibung: '', mitglieder: [{ name: 'anna', anzeigename: 'Anna' }, { name: 'ben', anzeigename: 'Ben' }], gaeste: [], ungelesen: 0, letzte: null, verwalter: false, verwaltende: [], stumm: false },
  ],
};
const VERLAUF = {
  nachrichten: [
    { id: 'n1', zeit: zeit(0), von: 'anna', von_name: 'Anna', gast: false, text: 'Hi', anhaenge: [], reaktionen: {} },
    { id: 'n2', zeit: zeit(1), von: 'ben', von_name: 'Ben', gast: false, text: 'Hallo', anhaenge: [{ id: 'aAAAAAAAAAAAAAAAA', name: 'plan.pdf', groesse: 10, mime: 'application/pdf', bild: false, video: false }], reaktionen: {} },
  ],
  mehr: false, gelesen: { anna: null, ben: 'n2' },
};

/** Schein-Verbindung: zeichnet Aufrufe auf, Ereignisse per ausloesen(art, obj). */
function scheinVerbindung(antworten = {}) {
  const aufrufe = []; const hoerer = new Map();
  return {
    aufrufe, status: 'verbunden', starten() {}, stoppen() {}, senden: () => true,
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    ausloesen(art, obj) { for (const fn of hoerer.get(art) || []) fn(obj); },
    aufrufen: async (aktion, params = {}) => {
      aufrufe.push([aktion, params]);
      if (antworten[aktion]) return antworten[aktion](params);
      if (aktion === 'chat.uebersicht') return structuredClone(UEBERSICHT);
      if (aktion === 'chat.verlauf') return structuredClone(VERLAUF);
      if (aktion === 'chat.personen') return { personen: [{ name: 'anna', anzeigename: 'Anna' }, { name: 'ben', anzeigename: 'Ben' }, { name: 'cara', anzeigename: 'cara' }] };
      if (aktion === 'chat.senden') return { nachricht: { id: 'n3', zeit: zeit(2), von: 'anna', von_name: 'Anna', text: params.text, anhaenge: [], reaktionen: {} } };
      return {};
    },
  };
}

function ctxBauen({ rolle = 'nutzer', verbindung = scheinVerbindung(), api = {} } = {}) {
  const apiAufrufe = []; const meldungen = []; const fehler = []; const ziele = [];
  const ctx = {
    apiAufrufe, meldungen, fehler, ziele,
    nutzer: { name: 'anna', rolle }, rolle, zugang: null, route: { id: 'chat', teile: [] },
    t: (k) => k, el: app.el, symbol: app.symbol, format: app.format, hashFuer: app.hashFuer,
    navigiere: (h) => ziele.push(h), melden: (text, art) => meldungen.push([text, art]), zeigeFehler: (e) => fehler.push(e), fehlerText: (e) => e.message,
    bestaetigen: async () => true, dialog: app.dialog, setzeTitel() {},
    api: async (aktion, params) => {
      apiAufrufe.push([aktion, params]);
      if (api[aktion]) return api[aktion](params);
      if (aktion === 'nutzer.einstellungen.lesen') return { bereich: params.bereich, wert: null };
      if (aktion === 'benachrichtigungen.persoenlich_info') return { server: 'https://ntfy.sh' };
      if (aktion === 'chat.einstellungen.lesen') return { max_anhang_mb: 2048, turn: { aktiv: true, port: 3478 } };
      if (aktion === 'chat.raum.alle') return [{ id: R, name: 'Team', mitglieder_anzahl: 2, gaeste_anzahl: 1, ersteller: 'anna', letzte_zeit: null }];
      return {};
    },
    _chatVerbindung: verbindung,
  };
  return ctx;
}

test('routeAuswerten', () => {
  assert.deepEqual(chat.routeAuswerten([]), { art: 'liste' });
  assert.deepEqual(chat.routeAuswerten([R]), { art: 'raum', raum: R });
  assert.deepEqual(chat.routeAuswerten([D]), { art: 'raum', raum: D });
  assert.deepEqual(chat.routeAuswerten(['einstellungen']), { art: 'einstellungen' });
  assert.deepEqual(chat.routeAuswerten(['einladung', 'T'.repeat(43)]), { art: 'einladung', token: 'T'.repeat(43) });
  assert.deepEqual(chat.routeAuswerten(['einladung', 'kurz']), { art: 'liste' });
  assert.deepEqual(chat.routeAuswerten(['<b>']), { art: 'liste' });
});

test('raeumeOrdnen: Räume und DMs getrennt, neueste zuerst, ohne Nachricht nach Name', () => {
  const r = liste.raeumeOrdnen([
    { id: 'r1', art: 'raum', name: 'Zeta', letzte: null }, { id: 'r2', art: 'raum', name: 'Alpha', letzte: null },
    { id: 'r3', art: 'raum', name: 'Mitte', letzte: { zeit: zeit(5) } }, { id: 'd1', art: 'dm', name: 'Ben', letzte: { zeit: zeit(1) } },
    { id: 'd2', art: 'dm', name: 'Cara', letzte: { zeit: zeit(9) } },
  ]);
  assert.deepEqual(r.raeume.map((x) => x.id), ['r3', 'r2', 'r1']);
  assert.deepEqual(r.dms.map((x) => x.id), ['d2', 'd1']);
});

test('einladungsAdresse und qrTauglich', () => {
  assert.equal(dialoge.einladungsAdresse({ link_basis: 'https://nas.example' }, 'T'.repeat(43), 'https://192.168.1.29:8443'), `https://nas.example/einladung/${'T'.repeat(43)}`);
  assert.equal(dialoge.einladungsAdresse(null, 'abc', 'https://192.168.1.29:8443'), 'https://192.168.1.29:8443/einladung/abc');
  assert.equal(dialoge.einladungsAdresse({ link_basis: 'javascript:alert(1)' }, 'abc', 'https://nas.local'), 'https://nas.local/einladung/abc', 'nur http(s)-Basen');
  assert.equal(dialoge.qrTauglich('x'.repeat(213)), true); assert.equal(dialoge.qrTauglich('x'.repeat(214)), false);
  assert.deepEqual(dialoge.GUELTIGKEITEN, [1, 24, 168, 720, 0]);
});

test('einstellungenNormal füllt Standardwerte', () => {
  assert.deepEqual(einst.einstellungenNormal(null), { standardordner: null, ton: true, browser: false, stumm: [] });
  assert.deepEqual(einst.einstellungenNormal({ standardordner: { freigabe: 'team', pfad: 'Chat' }, ton: false, browser: true, stumm: ['r1', 5] }),
    { standardordner: { freigabe: 'team', pfad: 'Chat' }, ton: false, browser: true, stumm: ['r1'] });
});

test('erweiterungHinzu: nur bekannte Arten', () => {
  const fn = () => null;
  erw.erweiterungHinzu('raumKopf', fn);
  assert.ok(erw.erweiterungen.raumKopf.includes(fn));
  assert.throws(() => erw.erweiterungHinzu('quatsch', fn));
  erw.erweiterungen.raumKopf.splice(erw.erweiterungen.raumKopf.indexOf(fn), 1);
});

test('Ansicht einbinden: Liste, Raum öffnen lädt Verlauf und setzt gelesen; Senden; Ereignisse', async () => {
  const v = scheinVerbindung();
  const ctx = ctxBauen({ verbindung: v });
  const wurzel = document.createElement('section'); document.body.appendChild(wurzel);
  await chat.default.einbinden(wurzel, ctx);
  await ticks();
  assert.equal(wurzel.querySelectorAll('.chat-raum-eintrag').length, 2);
  assert.match(alsText(wurzel.querySelector(`.chat-raum-eintrag[data-raum="${R}"]`)), /Team/);
  assert.equal(wurzel.querySelector('.chat').getAttribute('data-modus'), 'liste');
  ctx.route = { id: 'chat', teile: [R] };
  await chat.default.navigieren(ctx.route, ctx);
  await ticks();
  assert.equal(wurzel.querySelector('.chat').getAttribute('data-modus'), 'raum');
  assert.deepEqual(v.aufrufe.find(([a]) => a === 'chat.verlauf'), ['chat.verlauf', { raum: R, anzahl: 50 }]);
  assert.deepEqual(v.aufrufe.find(([a]) => a === 'chat.gelesen'), ['chat.gelesen', { raum: R, bis: 'n2' }]);
  assert.match(alsText(wurzel.querySelector('.chat-raumkopf')), /Team/);
  assert.ok(wurzel.querySelector('[data-id="n2"]'));
  assert.ok(wurzel.querySelector('.chat-anhang select'), 'Anhang mit Auswahl');
  assert.ok(wurzel.querySelector('.chat-raumkopf-einladen'), 'Verwalter sieht „Einladen“');
  // Senden
  const feld = wurzel.querySelector('textarea');
  feld.value = 'Neu da';
  feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }));
  await ticks();
  assert.deepEqual(v.aufrufe.find(([a]) => a === 'chat.senden')[1], { raum: R, text: 'Neu da', antwort: null, anhaenge: [] });
  assert.ok(wurzel.querySelector('[data-id="n3"]'), 'eigene Nachricht erscheint sofort');
  // Ereignis aus einem anderen Raum ändert den offenen Verlauf nicht
  v.ausloesen('chat', { art: 'chat', raum: D, ereignis: 'nachricht', daten: { id: 'n9', zeit: zeit(3), von: 'ben', von_name: 'Ben', text: 'woanders', anhaenge: [], reaktionen: {} } });
  assert.equal(wurzel.querySelector('[data-id="n9"]'), null);
  v.ausloesen('chat', { art: 'chat', raum: R, ereignis: 'geloescht', daten: { id: 'n1' } });
  assert.match(alsText(wurzel.querySelector('[data-id="n1"]')), /chat\.geloescht/);
  v.ausloesen('tippt', { art: 'tippt', raum: R, wer: 'ben', name: 'Ben' });
  assert.match(alsText(wurzel), /chat\.tippt/);
});

test('Wiederverbinden mit mehr als einer Seite Neuem: keine stille Lücke, gelesen nur bis zum Sichtbaren (Befund 9)', async () => {
  let verlaufAufrufe = 0;
  const neu = { nachrichten: [{ id: 'n8', zeit: zeit(8), von: 'ben', von_name: 'Ben', gast: false, text: 'neu8', anhaenge: [], reaktionen: {} }, { id: 'n9', zeit: zeit(9), von: 'ben', von_name: 'Ben', gast: false, text: 'neu9', anhaenge: [], reaktionen: {} }], mehr: true, gelesen: {} };
  const v = scheinVerbindung({ 'chat.verlauf': () => (++verlaufAufrufe === 1 ? structuredClone(VERLAUF) : structuredClone(neu)) });
  const ctx = ctxBauen({ verbindung: v });
  const wurzel = document.createElement('section'); document.body.appendChild(wurzel);
  ctx.route = { id: 'chat', teile: [R] };
  await chat.default.einbinden(wurzel, ctx);
  await ticks();
  assert.ok(wurzel.querySelector('[data-id="n1"]'));
  v.ausloesen('wieder', {});
  await ticks();
  assert.equal(wurzel.querySelector('[data-id="n1"]'), null, 'alte Liste ersetzt – die Lücke wird über „Ältere laden“ geschlossen');
  assert.ok(wurzel.querySelector('[data-id="n9"]'));
});

test('Avatare: DM in der Liste mit dem Bild des Partners, Mitglieder und Personenwahl mit Bild (0.22.0)', async () => {
  const av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
  av.avatareSetzen({ ben: 'abcdef012345' });
  try {
    const v = scheinVerbindung();
    const ctx = ctxBauen({ verbindung: v });
    const wurzel = document.createElement('section'); document.body.appendChild(wurzel);
    await chat.default.einbinden(wurzel, ctx); await ticks();
    const dm = wurzel.querySelector(`.chat-raum-eintrag[data-raum="${D}"] .chat-raum-zeichen .avatar`);
    assert.equal(dm.getAttribute('data-avatar'), 'ben', 'Bild der anderen Person, nicht das eigene');
    assert.equal(dm.querySelector('img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
    assert.equal(wurzel.querySelector(`.chat-raum-eintrag[data-raum="${R}"] .chat-raum-zeichen .avatar`), null, 'Räume behalten ihr Symbol');
    const raum = structuredClone(UEBERSICHT.raeume[0]);
    dialoge.mitgliederDialog(ctx, { ich: 'anna', aufrufen: async () => ({}), aktualisieren: async () => {}, raum: () => raum, zurListe() {} }, raum);
    const zeilen = [...document.querySelectorAll('.chat-mitglied')];
    assert.deepEqual(zeilen.map((z) => z.querySelector('.avatar').getAttribute('data-avatar')), ['anna', 'ben', null], 'Gäste ohne Login-Namen');
    assert.equal(zeilen[2].querySelector('.avatar').textContent, 'G');
    dialoge.dmDialog(ctx, { ich: 'anna', aufrufen: v.aufrufen, personen: async () => [{ name: 'ben', anzeigename: 'Ben' }], aktualisieren: async () => {}, oeffnen() {} });
    await ticks();
    const person = [...document.querySelectorAll('.chat-person-knopf')].find((k) => /Ben/.test(k.textContent));
    assert.equal(person.querySelector('.avatar img').getAttribute('src'), '/api/avatar/ben?v=abcdef012345');
  } finally { av.avatareSetzen({}); }
});

test('Gast entfernen fragt nach und bietet an, den Einladungslink mitzulöschen (Befund 10)', async () => {
  const aufrufe = [];
  const raum = structuredClone(UEBERSICHT.raeume[0]);
  const v = { ich: 'anna', aufrufen: async (a, p) => { aufrufe.push([a, p]); return {}; }, aktualisieren: async () => {}, raum: () => raum, zurListe() {} };
  const ctx = ctxBauen();
  const d = dialoge.mitgliederDialog(ctx, v, raum);
  const knopf = [...document.querySelectorAll('.chat-mitglied')].find((x) => /Gustav/.test(x.textContent)).querySelector('button');
  knopf.click();
  await ticks();
  assert.equal(aufrufe.length, 0, 'erst nachfragen');
  const frage = [...document.querySelectorAll('dialog')].at(-1);
  const haken = frage.querySelector('input[type="checkbox"]');
  assert.equal(haken.checked, true, 'Link sperren ist vorgewählt');
  assert.ok(frage.querySelector('.erklaerung'), 'Einstellung erklärt sich');
  frage.querySelector('.knopf-gefahr').click();
  await ticks();
  assert.deepEqual(aufrufe[0], ['chat.gast.entfernen', { raum: R, gast: 'gX', link_sperren: true }]);
  d.schliessen();
});

test('DM: kein „Einladen“, Einladung per Link öffnet den Raum', async () => {
  const v = scheinVerbindung({ 'chat.einladung.annehmen': () => ({ raum: R }) });
  const ctx = ctxBauen({ verbindung: v });
  const wurzel = document.createElement('section'); document.body.appendChild(wurzel);
  ctx.route = { id: 'chat', teile: [D] };
  await chat.default.einbinden(wurzel, ctx);
  await ticks();
  assert.equal(wurzel.querySelector('.chat-raumkopf-einladen'), null);
  ctx.route = { id: 'chat', teile: ['einladung', 'T'.repeat(43)] };
  await chat.default.navigieren(ctx.route, ctx);
  await ticks();
  assert.deepEqual(v.aufrufe.find(([a]) => a === 'chat.einladung.annehmen')[1], { token: 'T'.repeat(43) });
  assert.equal(ctx.ziele.at(-1), `#/chat/${R}`);
});

test('geschlossene DM (Konto gelöscht): Verlauf lesbar, statt Eingabe ein Hinweis', async () => {
  const uebersicht = structuredClone(UEBERSICHT);
  Object.assign(uebersicht.raeume[1], { geschlossen: true, mitglieder: [{ name: 'anna', anzeigename: 'Anna' }] });
  const v = scheinVerbindung({ 'chat.uebersicht': () => structuredClone(uebersicht) });
  const ctx = ctxBauen({ verbindung: v });
  const wurzel = document.createElement('section'); document.body.appendChild(wurzel);
  ctx.route = { id: 'chat', teile: [D] };
  await chat.default.einbinden(wurzel, ctx);
  await ticks();
  assert.ok(wurzel.querySelector('[data-id="n1"]'), 'Verlauf da');
  assert.equal(wurzel.querySelector('textarea'), null, 'keine Eingabe');
  assert.match(alsText(wurzel.querySelector('.chat-eingabe-behaelter')), /chat\.dm_geschlossen/);
});

test('Admin sieht „Räume verwalten“ und „Maximale Größe“, Nutzer nicht', async () => {
  for (const rolle of ['admin', 'nutzer']) {
    const ctx = ctxBauen({ rolle });
    const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
    const v = { ich: 'anna', einstellungen: einst.einstellungenNormal(null), aufrufen: async () => ({}), einstellungenSpeichern: async () => {} };
    einst.einstellungenSeite(behaelter, ctx, v);
    await ticks();
    const admin = rolle === 'admin';
    assert.equal(!!behaelter.querySelector('.chat-raeume-verwalten'), admin, `${rolle}: Räume verwalten`);
    assert.equal(!!behaelter.querySelector('.chat-max-anhang'), admin, `${rolle}: Maximale Größe`);
    assert.ok(behaelter.querySelector('.handy-meldungen'), 'Handy-Meldungen für alle');
    for (const k of behaelter.querySelectorAll('.karte')) assert.ok(k.querySelector('.erklaerung'), 'jede Karte erklärt sich');
    if (admin) assert.match(alsText(behaelter.querySelector('.chat-raeume-verwalten')), /Team/);
  }
});

test('Einstellungen: Ton ausschalten speichert über v.einstellungenSpeichern', async () => {
  const ctx = ctxBauen();
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const gespeichert = [];
  const v = { ich: 'anna', einstellungen: einst.einstellungenNormal(null), aufrufen: async () => ({}), einstellungenSpeichern: async (neu) => { gespeichert.push(neu); } };
  einst.einstellungenSeite(behaelter, ctx, v);
  await ticks();
  const ton = behaelter.querySelector('.chat-ton input[type="checkbox"]');
  assert.equal(ton.checked, true);
  ton.checked = false; ton.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.deepEqual(gespeichert, [{ ton: false }]);
});
