// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatare in der Ansicht „Nutzer“ (0.22.0): „Mein Konto“ zeigt das eigene Bild (oder den Anfangsbuchstaben) mit
// „Bild wählen“/„Entfernen“; das gewählte Foto wird quadratisch aus der Mitte auf 256 px gebracht und als
// nutzer.avatar.setzen geschickt. Admins sehen die Bilder in der Nutzerliste und setzen sie im Bearbeiten-Dialog.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const imp = (...teile) => import(pathToFileURL(path.join(PUBLIC, ...teile)).href);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8, 1)]);
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

let dom; let av; let ansicht; let gezeichnet;
before(async () => {
  dom = domAttrappe();
  await imp('app.js');
  av = await imp('avatar.js');
  ansicht = (await imp('ansichten', 'nutzer.js')).default;
  // Bildumwandlung im Browser nachstellen: Foto 400 × 300, Leinwand liefert WebP (nur im Test)
  globalThis.createImageBitmap = async () => ({ width: 400, height: 300, close() {} });
  const erzeugen = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    if (String(tag).toLowerCase() !== 'canvas') return erzeugen(tag, ...rest);
    return { width: 0, height: 0, getContext: () => ({ drawImage: (...a) => { gezeichnet = a; } }), toBlob: (fertig, typ) => fertig(new Blob([WEBP], { type: typ })) };
  };
});
after(() => { delete globalThis.createImageBitmap; dom.aufraeumen(); });
afterEach(() => { ansicht.verlassen(); av.avatareSetzen({}); document.body.textContent = ''; });

function ctxBauen({ rolle = 'admin', versionen = {} } = {}) {
  const aufrufe = []; const meldungen = [];
  let stand = { ...versionen };
  return {
    aufrufe, meldungen,
    nutzer: { name: 'fabian', anzeigename: 'Fabian', rolle, totp: false },
    t: (k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k),
    route: { id: 'nutzer', teile: [] },
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion === 'nutzer.liste') return [{ name: 'fabian', anzeigename: 'Fabian', rolle: 'admin', gruppen: [], avatar: stand.fabian || null }, { name: 'anna', anzeigename: 'Anna', rolle: 'nutzer', gruppen: [], avatar: stand.anna || null }];
      if (aktion === 'nutzer.gruppen') return [];
      if (aktion === 'nutzer.avatare') return { ...stand };
      if (aktion === 'nutzer.avatar.setzen') { stand = { ...stand, [params.name]: 'aaaaaa000000' }; return { v: 'aaaaaa000000' }; }
      if (aktion === 'nutzer.avatar.loeschen') { const { [params.name]: _weg, ...rest } = stand; stand = rest; return { name: params.name }; }
      return {};
    },
    get: async () => ({}), post: async () => ({}),
    melden: (text, art) => meldungen.push([text, art]),
    bestaetigen: async () => true,
  };
}
const knopfMit = (wurzel, text) => [...wurzel.querySelectorAll('button')].find((b) => b.textContent === text) || null;
async function einbinden(ctx) {
  const wurzel = document.createElement('div'); document.body.appendChild(wurzel);
  await ansicht.einbinden(wurzel, ctx); await ticks();
  return wurzel;
}
async function dateiWaehlen(block) {
  const eingabe = block.querySelector('input[type="file"]');
  assert.ok(eingabe, 'Dateiwahl im Block');
  assert.equal(eingabe.getAttribute('accept'), 'image/*');
  eingabe.files = [new Blob([Buffer.from('foto')], { type: 'image/jpeg' })];
  eingabe.dispatchEvent(new Event('change'));
  await ticks();
}

test('Mein Konto: Anfangsbuchstabe ohne Bild; Foto wählen → quadratisch aus der Mitte, als WebP gespeichert', async () => {
  const ctx = ctxBauen({ rolle: 'nutzer' });
  const wurzel = await einbinden(ctx);
  const block = wurzel.querySelector('.nu-avatar-block');
  assert.ok(block, 'Profilbild-Block in „Mein Konto“');
  const k = block.querySelector('.avatar');
  assert.equal(k.getAttribute('data-avatar'), 'fabian'); assert.equal(k.textContent, 'F');
  assert.ok(block.querySelector('.erklaerung'), 'kurze Erklärung');
  assert.ok(knopfMit(block, 'nutzer.avatar_waehlen'));
  assert.equal(knopfMit(block, 'nutzer.avatar_entfernen'), null, 'ohne Bild nichts zu entfernen');
  await dateiWaehlen(block);
  assert.deepEqual(gezeichnet.slice(1), [50, 0, 300, 300, 0, 0, 256, 256], 'Mitte des Fotos auf 256 × 256');
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'nutzer.avatar.setzen'), ['nutzer.avatar.setzen', { name: 'fabian', daten: WEBP.toString('base64') }]);
  assert.deepEqual(ctx.meldungen.at(-1), ['nutzer.avatar_gespeichert', 'erfolg']);
  const neu = wurzel.querySelector('.nu-avatar-block');
  assert.equal(neu.querySelector('.avatar img').getAttribute('src'), '/api/avatar/fabian?v=aaaaaa000000', 'gleich sichtbar, ohne auf das Ereignis zu warten');
  assert.ok(knopfMit(neu, 'nutzer.avatar_aendern') && knopfMit(neu, 'nutzer.avatar_entfernen'));
});

test('Mein Konto: Bild entfernen; unlesbare Datei → verständliche Meldung, nichts gespeichert', async () => {
  const ctx = ctxBauen({ rolle: 'nutzer', versionen: { fabian: 'bbbbbb000000' } });
  av.avatareSetzen({ fabian: 'bbbbbb000000' });
  const wurzel = await einbinden(ctx);
  knopfMit(wurzel.querySelector('.nu-avatar-block'), 'nutzer.avatar_entfernen').click(); await ticks();
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'nutzer.avatar.loeschen'), ['nutzer.avatar.loeschen', { name: 'fabian' }]);
  assert.equal(wurzel.querySelector('.nu-avatar-block .avatar').textContent, 'F');
  globalThis.createImageBitmap = async () => { throw new Error('HEIC'); };
  try {
    await dateiWaehlen(wurzel.querySelector('.nu-avatar-block'));
    assert.deepEqual(ctx.meldungen.at(-1), ['nutzer.avatar_unlesbar', 'fehler']);
    assert.equal(ctx.aufrufe.filter(([a]) => a === 'nutzer.avatar.setzen').length, 0);
  } finally { globalThis.createImageBitmap = async () => ({ width: 400, height: 300, close() {} }); }
});

test('Admin: Bilder in der Nutzerliste; im Bearbeiten-Dialog das Bild eines anderen setzen', async () => {
  const ctx = ctxBauen({ versionen: { anna: 'cccccc000000' } });
  av.avatareSetzen({ anna: 'cccccc000000' });
  const wurzel = await einbinden(ctx);
  const zeilen = [...wurzel.querySelectorAll('.nu-tabelle .avatar')];
  assert.deepEqual(zeilen.map((x) => x.getAttribute('data-avatar')), ['fabian', 'anna']);
  assert.equal(zeilen[1].querySelector('img').getAttribute('src'), '/api/avatar/anna?v=cccccc000000');
  const annaZeile = [...wurzel.querySelectorAll('.nu-tabelle tr')].find((z) => z.dataset.suchziel === 'anna');
  knopfMit(annaZeile, 'nutzer.bearbeiten').click(); await ticks();
  const dialog = [...document.body.querySelectorAll('.nu-avatar-block')].find((b) => b.querySelector('.avatar').getAttribute('data-avatar') === 'anna');
  assert.ok(dialog, 'Profilbild im Bearbeiten-Dialog');
  await dateiWaehlen(dialog);
  assert.deepEqual(ctx.aufrufe.find(([a]) => a === 'nutzer.avatar.setzen'), ['nutzer.avatar.setzen', { name: 'anna', daten: WEBP.toString('base64') }]);
});
