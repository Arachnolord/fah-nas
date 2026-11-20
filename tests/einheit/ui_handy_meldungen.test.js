// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Persönliche Handy-Meldungen in der Oberfläche (V9, Plan 02 Aufgabe 15): ntfy-Thema, Karte mit Schalter, QR-Adresse
// und Testmeldung; system-zusatz.js nutzt dieselbe Themen-Funktion.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let ntfy; let hm;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 6; i++) await warte(); };

before(async () => {
  dom = domAttrappe();
  // Canvas mit 2D-Kontext für den QR-Code
  globalThis.HTMLElement.prototype.getContext = () => ({ fillRect() {}, fillStyle: '' });
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  ntfy = await import(pathToFileURL(path.join(PUBLIC, 'ntfy.js')).href);
  hm = await import(pathToFileURL(path.join(PUBLIC, 'handy-meldungen.js')).href);
});
after(() => { delete globalThis.HTMLElement.prototype.getContext; dom.aufraeumen(); });
afterEach(() => { document.body.textContent = ''; });

function ctxBauen({ wert = null, gesendet = true, setzenFehler = null } = {}) {
  const aufrufe = []; const meldungen = []; const fehler = [];
  return {
    aufrufe, meldungen, fehler, nutzer: { name: 'anna', rolle: 'nutzer' },
    melden: (text, art) => meldungen.push([text, art]), zeigeFehler: (e) => fehler.push(e), fehlerText: (e) => e.message,
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion === 'nutzer.einstellungen.lesen') return { bereich: params.bereich, wert };
      if (aktion === 'benachrichtigungen.persoenlich_info') return { server: 'https://ntfy.example' };
      if (aktion === 'nutzer.einstellungen.setzen') { if (setzenFehler) throw setzenFehler; return { bereich: params.bereich, wert: params.wert }; }
      if (aktion === 'benachrichtigungen.persoenlich_test') return { gesendet };
      throw new Error(`unerwartet: ${aktion}`);
    },
  };
}
const schalter = (k) => k.querySelector('input[type="checkbox"]');
const umschalten = (k, an) => { const s = schalter(k); s.checked = an; s.dispatchEvent(new Event('change', { bubbles: true })); };

test('ntfyThemaNeu: fah-nas- und 12 gut lesbare Zeichen, jedes Mal anders', () => {
  const a = ntfy.ntfyThemaNeu(); const b = ntfy.ntfyThemaNeu();
  assert.match(a, /^fah-nas-[a-km-np-z2-9]{12}$/);
  assert.notEqual(a, b);
});

test('system-zusatz.js reicht dieselbe ntfyThemaNeu weiter', async () => {
  const sz = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'system-zusatz.js')).href);
  assert.equal(sz.ntfyThemaNeu, ntfy.ntfyThemaNeu);
});

test('Karte: aus, Einschalten speichert {aktiv:true, thema} und zeigt QR-Adresse', async () => {
  const ctx = ctxBauen();
  const k = hm.karteHandyMeldungen(ctx); document.body.appendChild(k);
  await ticks();
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'nutzer.einstellungen.lesen')[1], { name: 'anna', bereich: 'benachrichtigung' });
  assert.equal(schalter(k).checked, false);
  assert.match(k.querySelector('.erklaerung').textContent, /chat\.handy_erklaerung/);
  assert.equal(k.querySelector('.handy-qr').hidden, true);
  umschalten(k, true); await ticks();
  const gesetzt = ctx.aufrufe.find(([a]) => a === 'nutzer.einstellungen.setzen')[1];
  assert.equal(gesetzt.name, 'anna'); assert.equal(gesetzt.bereich, 'benachrichtigung');
  assert.equal(gesetzt.wert.aktiv, true); assert.match(gesetzt.wert.thema, /^fah-nas-[a-km-np-z2-9]{12}$/);
  assert.equal(k.querySelector('.handy-qr').hidden, false);
  assert.equal(k.querySelector('.handy-adresse').textContent, `https://ntfy.example/${gesetzt.wert.thema}`);
  assert.ok(k.querySelector('canvas').width > 0, 'QR gezeichnet');
  umschalten(k, false); await ticks();
  const zweites = ctx.aufrufe.filter(([a]) => a === 'nutzer.einstellungen.setzen')[1][1];
  assert.deepEqual(zweites.wert, { aktiv: false, thema: gesetzt.wert.thema }, 'Thema bleibt beim Ausschalten erhalten');
  assert.equal(k.querySelector('.handy-qr').hidden, true);
});

test('Karte: vorhandenes Thema, Testmeldung gesendet bzw. nicht gesendet', async () => {
  const ctx = ctxBauen({ wert: { aktiv: true, thema: 'fah-nas-abcdefghijkm' } });
  const k = hm.karteHandyMeldungen(ctx); document.body.appendChild(k);
  await ticks();
  assert.equal(schalter(k).checked, true);
  assert.equal(k.querySelector('.handy-adresse').textContent, 'https://ntfy.example/fah-nas-abcdefghijkm');
  k.querySelector('.handy-test').click(); await ticks();
  assert.ok(ctx.aufrufe.some(([a]) => a === 'benachrichtigungen.persoenlich_test'));
  assert.deepEqual(ctx.meldungen.at(-1), ['chat.handy_test_ok', 'erfolg']);
  const ctx2 = ctxBauen({ wert: { aktiv: true, thema: 'fah-nas-abcdefghijkm' }, gesendet: false });
  const k2 = hm.karteHandyMeldungen(ctx2); document.body.appendChild(k2);
  await ticks();
  k2.querySelector('.handy-test').click(); await ticks();
  assert.deepEqual(ctx2.meldungen.at(-1), ['chat.handy_test_nicht', 'warnung']);
});

test('Karte: Speichern scheitert → Schalter springt zurück, Fehler angezeigt', async () => {
  const ctx = ctxBauen({ setzenFehler: new Error('kaputt') });
  const k = hm.karteHandyMeldungen(ctx); document.body.appendChild(k);
  await ticks();
  umschalten(k, true); await ticks();
  assert.equal(schalter(k).checked, false);
  assert.equal(ctx.fehler.length, 1);
  assert.equal(k.querySelector('.handy-qr').hidden, true);
});
