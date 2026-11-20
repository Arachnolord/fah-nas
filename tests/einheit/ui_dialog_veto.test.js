// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V3 Dialog-Veto (public/app.js dialog): `vorSchliessen` entscheidet über Esc, Klick daneben, X und schliessen();
// nur `schliessen(wert, {sofort:true})` umgeht den Haken. Schützt z. B. ungespeicherte Texte im Editor.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
let dom; let app;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const esc = (d) => d.element.dispatchEvent(new Event('cancel', { cancelable: true }));

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'app.js')).href);
  app._test.setzeT((k) => k);
});
after(() => dom.aufraeumen());

test('vorSchliessen false → bleibt offen; true → zu und beimSchliessen', async () => {
  let antwort = false; let zu = 0; let gefragt = 0;
  const d = app.dialog('x', { vorSchliessen: async () => { gefragt++; return antwort; }, beimSchliessen: () => { zu++; } });
  esc(d); await warte();
  assert.equal(d.element.open, true);
  assert.equal(zu, 0);
  assert.equal(gefragt, 1);
  antwort = true; esc(d); await warte();
  assert.equal(d.element.open, false);
  assert.equal(zu, 1);
});

test('X-Knopf, Klick daneben und schliessen() laufen über den Haken', async () => {
  let gefragt = 0;
  const d = app.dialog('x', { vorSchliessen: async () => { gefragt++; return false; } });
  d.element.querySelector('.dialog-schliessen').click(); await warte();
  d.element.dispatchEvent(Object.assign(new Event('click', { bubbles: true }), { target: d.element })); await warte();
  d.schliessen(); await warte();
  assert.equal(gefragt, 3);
  assert.equal(d.element.open, true);
  d.schliessen(undefined, { sofort: true });
});

test('Ausnahme im Haken → offen; Doppelversuch während des Hakens wird ignoriert', async () => {
  let gefragt = 0; let frei;
  const d = app.dialog('x', { vorSchliessen: () => { gefragt++; return new Promise((_ok, nein) => { frei = () => nein(new Error('kaputt')); }); } });
  const alt = console.error; console.error = () => {};
  try {
    esc(d); esc(d); await warte();
    assert.equal(gefragt, 1, 'zweiter Versuch während des laufenden Hakens zählt nicht');
    frei(); await warte();
    assert.equal(d.element.open, true);
  } finally { console.error = alt; }
  d.schliessen(undefined, { sofort: true });
});

test('schliessen(w, {sofort:true}) umgeht den Haken', async () => {
  let gefragt = 0; let wert = null;
  const d = app.dialog('x', { vorSchliessen: async () => { gefragt++; return false; }, beimSchliessen: (w) => { wert = w; } });
  d.schliessen('ok', { sofort: true });
  assert.equal(gefragt, 0);
  assert.equal(d.element.open, false);
  assert.equal(wert, 'ok');
});

test('vom Browser erzwungenes Schließen (zweites Esc) öffnet wieder und fragt den Haken', async () => {
  let gefragt = 0;
  const d = app.dialog('x', { vorSchliessen: async () => { gefragt++; return false; } });
  d.element.close(); await warte();
  assert.equal(gefragt, 1);
  assert.equal(d.element.open, true, 'Dialog ist wieder offen, nichts geht verloren');
  d.schliessen(undefined, { sofort: true });
});

test('ohne vorSchliessen unverändert: Esc schließt sofort', () => {
  let zu = 0;
  const d = app.dialog('x', { beimSchliessen: () => { zu++; } });
  esc(d);
  assert.equal(d.element.open, false);
  assert.equal(zu, 1);
});
