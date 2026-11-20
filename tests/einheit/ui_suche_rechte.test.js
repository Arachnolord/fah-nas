// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Suche (Abschlussprüfung Plan 07, Befunde 5 und 6): „App-Katalog“ nur für Admins; der Zwischenspeicher der Suche
// gilt nur für denselben Nutzer und wird beim Sitzungsende geleert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let suche;

before(async () => { dom = domAttrappe(); suche = await import(pathToFileURL(path.join(PUBLIC, 'suche.js')).href); });
after(() => dom.aufraeumen());

test('App-Katalog nur für Admins', () => {
  const titel = (admin) => suche.festeEintraege({ ansichten: [{ id: 'apps' }], admin }).map((e) => e.ziel);
  assert.ok(titel(true).includes('#/apps/katalog'));
  assert.ok(!titel(false).includes('#/apps/katalog'));
});

test('Zwischenspeicher passt nur zu Nutzer, Rolle und Frische', () => {
  const zs = { zeit: 1000, admin: false, nutzer: 'anna', eintraege: [{ titel: 'x' }] };
  assert.equal(suche.zwischenspeicherPasst(zs, { admin: false, nutzer: 'anna' }, 30_000), true);
  assert.equal(suche.zwischenspeicherPasst(zs, { admin: false, nutzer: 'ben' }, 30_000), false, 'anderer Nutzer');
  assert.equal(suche.zwischenspeicherPasst(zs, { admin: true, nutzer: 'anna' }, 30_000), false, 'andere Rolle');
  assert.equal(suche.zwischenspeicherPasst(zs, { admin: false, nutzer: 'anna' }, 62_000), false, 'älter als 60 s');
  suche.zwischenspeicherLeeren();
  assert.equal(suche._test.zwischenspeicher().eintraege.length, 0);
});
