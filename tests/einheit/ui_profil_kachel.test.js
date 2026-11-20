// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übersichts-Kachel „Profil“ (0.22.0, Neuerung Avatare – jede Neuerung bekommt eine Kachel): eigenes Bild (oder
// Anfangsbuchstabe), Name, Rolle und der Weg zu „Mein Konto“, wo das Bild geändert wird.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let dashboard; let raster; let av;
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  dashboard = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  raster = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard-raster.js')).href);
  av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
});
after(() => dom.aufraeumen());

const ctxBauen = (nutzer) => ({
  rolle: nutzer.rolle, nutzer, get: async () => ({ links: [], orte: {} }), sse: { on() { return () => {}; } },
  hashFuer: app.hashFuer, melden() {}, fehlerText: (e) => (e && e.message) || 'Fehler', bestaetigen: async () => true, dialog: () => ({ schliessen() {} }),
  api: async (aktion) => (aktion === 'apps.liste' || aktion === 'agent.aufgaben' || aktion === 'laufwerke.liste' ? [] : {}),
});

test('Standardgröße 3×4', () => { assert.deepEqual(raster.STANDARD_GROESSE.profil, [3, 4]); });

test('Kachel: eigenes Bild, Name, Rolle und Link zu „Mein Konto“; ohne Bild der Anfangsbuchstabe', async () => {
  av.avatareSetzen({ anna: 'abcdef012345' });
  try {
    const wurzel = document.createElement('main'); document.body.appendChild(wurzel);
    await dashboard.default.einbinden(wurzel, ctxBauen({ name: 'anna', anzeigename: 'Anna Berg', rolle: 'admin' }));
    await ticks();
    const k = wurzel.querySelector('[data-kachel="profil"]');
    assert.ok(k, 'Kachel da');
    assert.equal(k.querySelector('.avatar img').getAttribute('src'), '/api/avatar/anna?v=abcdef012345');
    assert.equal(k.querySelector('.dashboard-profil-name').textContent, 'Anna Berg');
    assert.equal(k.querySelector('.kachel-neben').textContent, 'dashboard.profil_admin');
    const link = k.querySelector('.kachel-fuss a');
    assert.equal(link.getAttribute('href'), '#/nutzer'); assert.equal(link.textContent, 'dashboard.profil_link');
    dashboard.default.verlassen?.();
    av.avatareSetzen({});
    const w2 = document.createElement('main'); document.body.appendChild(w2);
    await dashboard.default.einbinden(w2, ctxBauen({ name: 'ben', anzeigename: 'Ben', rolle: 'nutzer' }));
    await ticks();
    const k2 = w2.querySelector('[data-kachel="profil"]');
    assert.equal(k2.querySelector('.avatar').textContent, 'B');
    assert.equal(k2.querySelector('.kachel-neben').textContent, 'dashboard.profil_nutzer');
    dashboard.default.verlassen?.();
  } finally { av.avatareSetzen({}); }
});
