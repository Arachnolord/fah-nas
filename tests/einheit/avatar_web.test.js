// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatare im Web-Dienst (0.22.0): GET /api/avatar/:name?v= liefert das Bild aus nutzer.avatar.lesen – nur mit voller
// Sitzung, nie als Dokument ausführbar; mit passender Version darf der Browser es lange behalten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardAttrappe, dienstStarten, tmp, Browser } from './web_hilfen.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

async function umgebung() {
  const a = await standardAttrappe(await tmp());
  a.aktion('nutzer.avatar.lesen', { rolle: 'nutzer', fn: ({ name }, kontext) => {
    a.letzterKontext = kontext;
    if (name !== 'anna') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Für diesen Nutzer ist kein Bild hinterlegt', { feld: 'name' });
    return { mime: 'image/png', v: 'abcdef012345', daten: PNG.toString('base64') };
  } });
  const d = await dienstStarten(a);
  return { a, ...d };
}

test('avatar: Bild mit Sitzung, lange im Browser nur mit passender Version, nie ausführbar', async () => {
  const { a, dienst, port } = await umgebung();
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const r = await b.get('/api/avatar/anna?v=abcdef012345');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, PNG);
    assert.equal(r.kopf['content-type'], 'image/png');
    assert.equal(r.kopf['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(r.kopf['x-content-type-options'], 'nosniff');
    assert.match(r.kopf['content-security-policy'], /default-src 'none'; sandbox/);
    assert.equal(a.letzterKontext.nutzer, 'fabian', 'der Agent prüft mit den Rechten der Sitzung');
    const alt = await b.get('/api/avatar/anna?v=000000000000');
    assert.equal(alt.status, 200);
    assert.equal(alt.kopf['cache-control'], 'private, no-cache', 'alte Version: Bild kommt, aber nur kurz');
    assert.equal((await b.get('/api/avatar/anna')).kopf['cache-control'], 'private, no-cache');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('avatar: ohne Sitzung 401, ohne Bild 404, ungültiger Name 400', async () => {
  const { a, dienst, port } = await umgebung();
  try {
    assert.equal((await new Browser(port).get('/api/avatar/anna?v=abcdef012345')).status, 401);
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const ohne = await b.get('/api/avatar/ben');
    assert.equal(ohne.status, 404); assert.equal(ohne.json.fehler.code, 'E_NICHT_GEFUNDEN');
    assert.equal((await b.get('/api/avatar/Anna')).status, 400);
    assert.equal((await b.get('/api/avatar/..%2Fusers.json')).status, 400);
    assert.equal(a.anfragen.filter((x) => x.aktion === 'nutzer.avatar.lesen').length, 1, 'ungültige Namen erreichen den Agenten nicht');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});
