// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// „Im Chat teilen …“ aus dem Dateimanager (Plan 02, Aufgabe 19): Raum wählen, Begleittext, aus_nas → senden in dieser
// Reihenfolge; Abbrechen ohne Kopie; Fehler beim Kopieren → keine Nachricht.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const R = 'rAAAAAAAAAAAAAAAA';
const D = 'dBBBBBBBBBBBBBBBBBBBB';
const A = 'aCCCCCCCCCCCCCCCC';
let dom; let app; let teilen;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 8; i++) await warte(); };

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  teilen = await import(pathToFileURL(path.join(PUBLIC, 'chat', 'teilen-dialog.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { for (const d of document.body.querySelectorAll('dialog')) d.remove(); });

function verbindungBauen({ ausNasFehler = null } = {}) {
  const aufrufe = [];
  return {
    aufrufe, starten() {},
    aufrufen: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion === 'chat.uebersicht') return { raeume: [{ id: R, art: 'raum', name: 'Team', letzte: null }, { id: D, art: 'dm', name: 'Ben', letzte: null }] };
      if (aktion === 'chat.anhang.aus_nas') { if (ausNasFehler) throw ausNasFehler; return { anhang: { id: A, name: 'a.jpg' } }; }
      if (aktion === 'chat.senden') return { nachricht: { id: 'n1', text: params.text } };
      throw new Error(`unerwartet: ${aktion}`);
    },
  };
}
function ctxBauen() {
  const meldungen = []; const fehler = [];
  return { meldungen, fehler, dialog: app.dialog, melden: (text, art) => { meldungen.push([text, art]); return null; }, zeigeFehler: (e) => fehler.push(e), fehlerText: (e) => e.message };
}
const dialogJetzt = () => document.body.querySelector('dialog');

test('Raum wählen, Text, Senden: uebersicht → aus_nas → senden mit genauen Parametern', async () => {
  const verbindung = verbindungBauen(); const ctx = ctxBauen();
  const p = teilen.imChatTeilen(ctx, { freigabe: 'team', pfad: 'Bilder/a.jpg' }, { verbindung });
  await ticks();
  const senden = dialogJetzt().querySelector('.chat-teilen-senden');
  assert.equal(senden.disabled, true, 'ohne Raum kein Senden');
  assert.equal(dialogJetzt().querySelectorAll('.chat-teilen-raum').length, 2);
  dialogJetzt().querySelector(`.chat-teilen-raum[data-raum="${D}"]`).click();
  assert.equal(senden.disabled, false);
  dialogJetzt().querySelector('.chat-teilen-text').value = 'Schau mal';
  senden.click();
  assert.deepEqual(await p, { raum: D, nachricht: { id: 'n1', text: 'Schau mal' } });
  assert.deepEqual(verbindung.aufrufe, [
    ['chat.uebersicht', {}],
    ['chat.anhang.aus_nas', { raum: D, freigabe: 'team', pfad: 'Bilder/a.jpg' }],
    ['chat.senden', { raum: D, text: 'Schau mal', anhaenge: [A] }],
  ]);
  assert.deepEqual(ctx.meldungen.at(-1), ['chat.geteilt:Ben', 'erfolg']);
});

test('Abbrechen → null, nichts kopiert', async () => {
  const verbindung = verbindungBauen(); const ctx = ctxBauen();
  const p = teilen.imChatTeilen(ctx, { freigabe: 'team', pfad: 'a.jpg' }, { verbindung });
  await ticks();
  dialogJetzt().querySelector(`.chat-teilen-raum[data-raum="${R}"]`).click();
  dialogJetzt().querySelector('.chat-teilen-abbrechen').click();
  assert.equal(await p, null);
  assert.deepEqual(verbindung.aufrufe.map(([a]) => a), ['chat.uebersicht']);
});

test('Fehler beim Kopieren (zu groß) → Fehler gezeigt, keine Nachricht, Dialog bleibt', async () => {
  const f = Object.assign(new Error('Die Datei ist größer als erlaubt'), { code: 'E_PARAMS', details: { feld: 'groesse', max: 1024 } });
  const verbindung = verbindungBauen({ ausNasFehler: f }); const ctx = ctxBauen();
  const p = teilen.imChatTeilen(ctx, { freigabe: 'team', pfad: 'gross.iso' }, { verbindung });
  await ticks();
  dialogJetzt().querySelector(`.chat-teilen-raum[data-raum="${R}"]`).click();
  dialogJetzt().querySelector('.chat-teilen-senden').click();
  await ticks();
  assert.equal(ctx.fehler.length, 1);
  assert.ok(!verbindung.aufrufe.some(([a]) => a === 'chat.senden'));
  assert.ok(dialogJetzt(), 'Dialog bleibt offen');
  dialogJetzt().querySelector('.chat-teilen-abbrechen').click();
  assert.equal(await p, null);
});
