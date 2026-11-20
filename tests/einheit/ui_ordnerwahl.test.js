// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Ordnerwahl (V8, Plan 02 Aufgabe 14): Baum über alle Freigaben, Schreibrecht je Knoten aus dateien.liste,
// gesperrte Ordner ausgegraut, OK nur für schreibbare Ziele, Abbrechen → null.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let ow;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 6; i++) await warte(); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  ow = await import(pathToFileURL(path.join(PUBLIC, 'ordnerwahl.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { for (const d of document.body.querySelectorAll('dialog')) d.remove(); });

/** Schein-ctx: Freigaben team (schreibbar, Unterordner Bilder) und lesen (nur lesen, Unterordner Archiv). */
function ctxBauen() {
  const aufrufe = [];
  const baum = {
    'team\n': { schreiben: true, eintraege: [{ name: 'Bilder', art: 'ordner' }, { name: 'a.txt', art: 'datei' }] },
    'team\nBilder': { schreiben: true, eintraege: [] },
    'lesen\n': { schreiben: false, eintraege: [{ name: 'Archiv', art: 'ordner' }] },
    'lesen\nArchiv': { schreiben: false, eintraege: [] },
  };
  return {
    aufrufe, dialog: app.dialog, fehlerText: (e) => e.message,
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion === 'freigaben.liste') return [{ name: 'team' }, { name: 'lesen' }];
      if (aktion === 'dateien.liste') return { freigabe: params.freigabe, ...baum[`${params.freigabe}\n${params.pfad}`] };
      throw new Error(`unerwartet: ${aktion}`);
    },
  };
}
const dialogJetzt = () => document.body.querySelector('dialog');
const zeilen = () => dialogJetzt().querySelectorAll('.dateien-baum-zeile');
const zeile = (name) => zeilen().find((z) => z.querySelector('.dateien-baum-name').textContent === name);
const okKnopf = () => dialogJetzt().querySelector('.ordnerwahl-ok');

test('wählt einen schreibbaren Ordner und liefert {freigabe, pfad}', async () => {
  const ctx = ctxBauen();
  const p = ow.ordnerWaehlen(ctx, { titel: 'Ziel wählen', erklaerung: 'Wohin?', okText: 'Speichern' });
  await ticks();
  assert.deepEqual(ctx.aufrufe[0], ['freigaben.liste', {}], 'ohne mit_system');
  assert.deepEqual(zeilen().map((z) => z.querySelector('.dateien-baum-name').textContent), ['team', 'lesen']);
  assert.equal(okKnopf().disabled, true, 'nichts gewählt → OK aus');
  assert.equal(okKnopf().textContent, 'Speichern');
  zeile('team').querySelector('.dateien-baum-auf').click();
  await ticks();
  assert.ok(zeile('Bilder'), 'Unterordner nach dem Aufklappen da');
  assert.equal(zeilen().length, 3, 'Dateien erscheinen nicht im Baum');
  zeile('Bilder').click();
  await ticks();
  assert.equal(zeile('Bilder').getAttribute('aria-selected'), 'true');
  assert.equal(okKnopf().disabled, false);
  assert.match(dialogJetzt().querySelector('.dateien-ziel').textContent, /team\/Bilder/);
  okKnopf().click();
  assert.deepEqual(await p, { freigabe: 'team', pfad: 'Bilder' });
});

test('nicht schreibbarer Ordner ist gesperrt, OK deaktiviert', async () => {
  const ctx = ctxBauen();
  const p = ow.ordnerWaehlen(ctx, { titel: 'Ziel' });
  await ticks();
  zeile('team').click(); await ticks();
  assert.equal(okKnopf().disabled, false);
  zeile('lesen').click(); await ticks();
  assert.equal(zeile('lesen').getAttribute('aria-disabled'), 'true');
  assert.ok(zeile('lesen').classList.contains('ordnerwahl-gesperrt'));
  assert.equal(okKnopf().disabled, true);
  assert.match(dialogJetzt().querySelector('.ordnerwahl-hinweis').textContent, /dateien\.ordner_gesperrt/);
  okKnopf().click();
  assert.ok(dialogJetzt(), 'gesperrtes OK schließt nicht');
  // Aufklappen merkt das Schreibrecht der Kinder nicht vorab, wohl aber das des aufgeklappten Knotens
  zeile('lesen').querySelector('.dateien-baum-auf').click(); await ticks();
  zeile('Archiv').click(); await ticks();
  assert.equal(okKnopf().disabled, true);
  assert.equal(ctx.aufrufe.filter(([a, x]) => a === 'dateien.liste' && x.freigabe === 'lesen' && x.pfad === '').length, 1, 'Ergebnis je Knoten gemerkt');
  zeile('team').click(); await ticks();
  assert.equal(okKnopf().disabled, false);
  assert.equal(dialogJetzt().querySelector('.ordnerwahl-hinweis').hidden, true);
  dialogJetzt().querySelector('.ordnerwahl-abbrechen').click();
  assert.equal(await p, null);
});

test('ohne nurSchreibbar zählt nur die Wahl; start wählt die Freigabe vor', async () => {
  const ctx = ctxBauen();
  const p = ow.ordnerWaehlen(ctx, { titel: 'Ziel', nurSchreibbar: false, start: { freigabe: 'lesen', pfad: '' } });
  await ticks();
  assert.equal(zeile('lesen').getAttribute('aria-selected'), 'true');
  assert.equal(okKnopf().disabled, false);
  assert.equal(ctx.aufrufe.filter(([a]) => a === 'dateien.liste').length, 0, 'keine Prüfung nötig');
  okKnopf().click();
  assert.deepEqual(await p, { freigabe: 'lesen', pfad: '' });
});

test('Abbrechen → null', async () => {
  const ctx = ctxBauen();
  const p = ow.ordnerWaehlen(ctx, { titel: 'Ziel' });
  await ticks();
  zeile('team').click(); await ticks();
  dialogJetzt().querySelector('.ordnerwahl-abbrechen').click();
  assert.equal(await p, null);
});

test('mitSystem fragt Systemfreigaben mit an (Dateimanager für Admins)', async () => {
  const ctx = ctxBauen();
  const p = ow.ordnerWaehlen(ctx, { titel: 'Ziel', mitSystem: true });
  await ticks();
  assert.deepEqual(ctx.aufrufe[0], ['freigaben.liste', { mit_system: true }]);
  dialogJetzt().querySelector('.ordnerwahl-abbrechen').click();
  assert.equal(await p, null);
});

test('schreibbarAus', () => {
  assert.equal(ow.schreibbarAus({ schreiben: false }), false);
  assert.equal(ow.schreibbarAus({ schreiben: true }), true);
  assert.equal(ow.schreibbarAus({}), true);
});
