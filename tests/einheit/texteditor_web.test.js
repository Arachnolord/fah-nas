// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Texteditor, Web-Seite (Plan 01): V2 große JSON-Anfragen für einzelne Aktionen, V5 Fehlercode E_GEAENDERT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, standardAttrappe, dienstStarten, Browser } from './web_hilfen.js';
import { GROSSE_AKTIONEN } from '../../src/web/api/agent.js';
import { httpStatus, detailsFuerRolle } from '../../src/web/server.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { fehlerFuerRolle } from '../../src/agent/agent.js';

test('dateien.text.speichern darf bis 8 MiB JSON senden, andere Aktionen nur 1 MiB', async () => {
  assert.equal(GROSSE_AKTIONEN['dateien.text.speichern'], 8 * 1024 * 1024);
  const a = await standardAttrappe(await tmp());
  a.aktion('dateien.text.speichern', { rolle: 'nutzer', fn: (p) => ({ laenge: p.inhalt.length }) });
  const { dienst, port } = await dienstStarten(a);
  try {
    const b = new Browser(port); await b.anmelden('fabian', 'geheim123');
    const gross = 'x'.repeat(1.5 * 1024 * 1024);
    const r1 = await b.post('/api/agent/dateien.text.speichern', { freigabe: 'f', pfad: 'a.txt', inhalt: gross });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.ergebnis.laenge, gross.length);
    const r2 = await b.post('/api/agent/test.echo', { a: gross });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.fehler.code, 'E_PARAMS');
  } finally { await dienst.stoppen(); await a.stoppen(); }
});

test('E_GEAENDERT: eigener Code, HTTP 409, Details für Nutzer sichtbar', () => {
  const f = new FahnasFehler('E_GEAENDERT', 'Datei wurde geändert', { geaendert: '2026-10-18T10:00:00.000Z', groesse: 12, befehl: 'x' });
  assert.equal(f.code, 'E_GEAENDERT');
  assert.equal(httpStatus('E_GEAENDERT'), 409);
  const { details } = detailsFuerRolle(f.details, 'nutzer');
  assert.equal(details.geaendert, '2026-10-18T10:00:00.000Z');
  assert.equal(details.groesse, 12);
  assert.equal('befehl' in details, false);
  // auch der Agent reicht beide Felder an Nicht-Admins durch
  const vomAgent = fehlerFuerRolle(f.toJSON(), 'nutzer');
  assert.equal(vomAgent.details.geaendert, '2026-10-18T10:00:00.000Z');
  assert.equal(vomAgent.details.groesse, 12);
});
