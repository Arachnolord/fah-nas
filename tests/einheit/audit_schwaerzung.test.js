// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V1 Audit-Schwärzung (Plan 01, Aufgabe 1): Aktionen mit Nachrichtentext, Dateiinhalt oder Ausweisen dürfen diese nie
// ins Prüfprotokoll schreiben – `audit: false` (Erfolg ohne Eintrag) oder `audit: (p) => {…}` (Ersatz-Parameter).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../../src/agent/agent.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

let w; let agent;
const ANNA = { nutzer: 'anna', rolle: 'nutzer', ip: '10.0.0.1' };

async function eintraege(aktion) {
  await agent.audit.kette;
  return (await agent.audit.lesen({ je_seite: 500 })).eintraege.filter((e) => e.aktion === aktion);
}

before(async () => {
  w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-a-audit-'));
  // hintergrund:false – keine Hintergrunddienste der Bereiche im Einheitstest
  agent = new Agent({ konfigOrdner: path.join(w, 'config'), socketPfad: path.join(w, 'a.sock'), datenSocket: path.join(w, 'd.sock'), hintergrund: false });
  await agent.starten();
  await agent.konfig.speichern('users.json', { nutzer: [{ name: 'anna', rolle: 'nutzer', gesperrt: false }], gruppen: [] });
});

after(async () => { await agent.stoppen(); await fs.rm(w, { recursive: true, force: true }); });

test('audit:false – Erfolg ohne Eintrag, Fehler mit leeren params', async () => {
  agent.register.aktion('test.still', { rolle: 'nutzer', audit: false, schema: { text: { typ: 'string', pflicht: true, max: 5 } }, ausfuehren: async () => 'ok' });
  await agent.ausfuehren('test.still', { text: 'hallo' }, ANNA);
  await assert.rejects(agent.ausfuehren('test.still', { text: 'viel zu lang' }, ANNA), (e) => e.code === 'E_PARAMS');
  const e = await eintraege('test.still');
  assert.equal(e.length, 1);
  assert.equal(e[0].ok, false);
  assert.deepEqual(e[0].params, {});
});

test('audit-Funktion ersetzt params bei Erfolg, Fehler und Schemafehler', async () => {
  agent.register.aktion('test.geschwaerzt', {
    rolle: 'nutzer', audit: (p) => ({ raum: p.raum }),
    schema: { raum: { typ: 'string', pflicht: true }, text: { typ: 'string', pflicht: true, max: 6 } },
    ausfuehren: async (p) => { if (p.raum === 'x') throw new FahnasFehler('E_RECHTE', 'nein'); return 1; },
  });
  await agent.ausfuehren('test.geschwaerzt', { raum: 'r1', text: 'GEHEIM' }, ANNA);
  await assert.rejects(agent.ausfuehren('test.geschwaerzt', { raum: 'x', text: 'GEHEIM' }, ANNA), (e) => e.code === 'E_RECHTE');
  await assert.rejects(agent.ausfuehren('test.geschwaerzt', { raum: 'r2', text: 'GEHEIM-ZU-LANG' }, ANNA), (e) => e.code === 'E_PARAMS');
  const e = await eintraege('test.geschwaerzt');
  assert.equal(e.length, 3);
  const roh = JSON.stringify(e);
  assert.equal(roh.includes('GEHEIM'), false, 'kein Text im Prüfprotokoll');
  assert.deepEqual(e.map((x) => x.params.raum).sort(), ['r1', 'r2', 'x']);
});

test('audit-Funktion gilt auch für Aufgaben', async () => {
  agent.register.aktion('test.aufgabe_geschwaerzt', { rolle: 'nutzer', aufgabe: true, audit: () => ({ was: 'aufgabe' }), schema: { text: { typ: 'string' } }, ausfuehren: async () => 'fertig' });
  await agent.ausfuehren('test.aufgabe_geschwaerzt', { text: 'GEHEIM' }, ANNA);
  const e = await eintraege('test.aufgabe_geschwaerzt');
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].params, { was: 'aufgabe' });
});

test('ohne audit bleibt alles wie bisher', async () => {
  agent.register.aktion('test.normal', { rolle: 'nutzer', schema: { t: { typ: 'string', pflicht: true } }, ausfuehren: async () => 1 });
  await agent.ausfuehren('test.normal', { t: 'sichtbar' }, ANNA);
  const e = await eintraege('test.normal');
  assert.equal(e.length, 1);
  assert.equal(e[0].params.t, 'sichtbar');
});

test('audit mit falschem Typ wird beim Registrieren abgelehnt', () => {
  assert.throws(() => agent.register.aktion('test.falsch', { rolle: 'nutzer', audit: 'nein', schema: {}, ausfuehren: async () => 1 }), /audit muss false oder eine Funktion sein/);
  assert.throws(() => agent.register.aktion('test.falsch', { rolle: 'nutzer', audit: true, schema: {}, ausfuehren: async () => 1 }), /audit muss false oder eine Funktion sein/);
});
