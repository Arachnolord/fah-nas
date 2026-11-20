// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// App-Sichtbarkeit, Oberfläche (Plan 07, Aufgabe 2): Nicht-Admins ohne Katalog/Protokoll mit eigenem Leerhinweis;
// Admins sehen „Sichtbar für …“ und speichern die Auswahl über apps.sichtbarkeit.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let ansicht; let modul; let app;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 8; i++) await warte(); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  modul = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'apps.js')).href);
  ansicht = modul.default;
});
after(() => dom.aufraeumen());
let wurzel = null;
afterEach(() => { try { ansicht.verlassen && ansicht.verlassen(); } catch { /* egal */ } for (const d of document.body.querySelectorAll('dialog')) d.remove(); if (wurzel) wurzel.remove(); });

const GITEA = { name: 'gitea', titel: 'Gitea', katalog_id: 'gitea', zustand: 'running', webui: 'http://{HOST}:3000', ports: [], autostart: true, art: 'vorlage' };

function ctxBauen(rolle, antworten) {
  const aufrufe = [];
  const t = Object.assign((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k), { hat: () => true });
  return {
    aufrufe, rolle, nutzer: { name: rolle === 'admin' ? 'fabian' : 'uwe', rolle }, zugang: {}, route: { id: 'apps', teile: [] },
    t, el: app.el, symbol: app.symbol, format: app.format, dialog: app.dialog, melden() {}, bestaetigen: async () => true,
    sse: { on: () => () => {} }, hashFuer: () => '#/apps', navigiere() {},
    api: async (aktion, params) => { aufrufe.push([aktion, params]); const a = antworten[aktion]; return typeof a === 'function' ? a(params) : a; },
  };
}

async function einbinden(ctx) {
  wurzel = document.createElement('section');
  document.body.appendChild(wurzel);
  await ansicht.einbinden(wurzel, ctx);
  await ticks();
  return wurzel;
}

test('sichtbarText / sichtbarAuswahl', () => {
  const t = (k) => k;
  assert.equal(modul.sichtbarText([], t), 'apps.sichtbar_nur_admins');
  assert.equal(modul.sichtbarText(['@familie', 'uwe'], t), '@familie, uwe');
  const a = modul.sichtbarAuswahl([{ name: 'fabian', rolle: 'admin' }, { name: 'uwe', rolle: 'nutzer' }], [{ name: 'familie' }], ['uwe']);
  assert.deepEqual(a.map((x) => [x.wert, x.gewaehlt]), [['@familie', false], ['uwe', true]]);
});

test('Nicht-Admin: kein Katalog-Reiter, kein Protokoll, Leerhinweis', async () => {
  const ctx = ctxBauen('nutzer', { 'apps.liste': [] });
  const w = await einbinden(ctx);
  assert.equal(w.querySelector('[aria-controls="ap-panel-katalog"]'), null, 'kein Katalog-Reiter');
  assert.equal(w.querySelector('#ap-panel-katalog'), null);
  assert.match(w.textContent, /apps\.keine_installiert_nutzer/);
  assert.ok(!ctx.aufrufe.some(([a]) => a.startsWith('apps.katalog')), 'Katalog wird nicht geladen');
});

test('Nicht-Admin mit freigegebener App: Öffnen ja, Protokoll nein', async () => {
  const ctx = ctxBauen('nutzer', { 'apps.liste': [GITEA] });
  const w = await einbinden(ctx);
  assert.ok(w.querySelector('.ap-oeffnen'), 'Öffnen-Knopf');
  assert.ok(!/apps\.protokoll\b/.test(w.querySelector('.ap-knoepfe').textContent), 'kein Protokoll-Knopf');
  assert.equal(w.querySelector('.ap-sichtbar'), null);
});

test('Admin: Karte zeigt „Sichtbar für“ und speichert die Auswahl', async () => {
  const ctx = ctxBauen('admin', {
    'apps.liste': [{ ...GITEA, sichtbar_fuer: [] }],
    'nutzer.liste': [{ name: 'fabian', rolle: 'admin' }, { name: 'uwe', rolle: 'nutzer' }],
    'nutzer.gruppen': [{ name: 'familie', mitglieder: ['uwe'] }],
    'apps.sichtbarkeit': (p) => p,
  });
  const w = await einbinden(ctx);
  assert.match(w.querySelector('.ap-sichtbar').textContent, /apps\.sichtbar_nur_admins/);
  w.querySelector('[data-aktion="sichtbarkeit"]').click(); await ticks();
  const dlg = [...document.body.querySelectorAll('dialog')].pop();
  assert.ok(dlg, 'Dialog offen');
  const kaesten = dlg.querySelectorAll('input[type="checkbox"]');
  assert.deepEqual(kaesten.map((k) => k.value), ['@familie', 'uwe']);
  kaesten[1].checked = true;
  dlg.querySelector('[data-aktion="sichtbar-speichern"]').click(); await ticks();
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'apps.sichtbarkeit'), ['apps.sichtbarkeit', { name: 'gitea', sichtbar_fuer: ['uwe'] }]);
});

test('Nicht-Admin unter #/apps/katalog: Liste bleibt sichtbar, kein Katalog-Aufruf (Abschlussprüfung Plan 07, Befund 5)', async () => {
  const ctx = ctxBauen('nutzer', { 'apps.liste': [GITEA] });
  ctx.route = { id: 'apps', teile: ['katalog'] };
  const w = await einbinden(ctx);
  assert.equal(w.querySelector('#ap-panel-installiert').hidden, false);
  assert.ok(w.querySelector('.ap-oeffnen'), 'die freigegebene App ist zu sehen');
  assert.ok(!ctx.aufrufe.some(([a]) => a.startsWith('apps.katalog')), 'Katalog wird nicht geladen');
});
