// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für den Bereich „netz“ (Weltkarte): Aktion netz.verbindungen über den echten Agenten (Rollen, Schema,
// Vertragsform §4.6, kein Prüfprotokoll bei Erfolg), Standort/Aufzeichnung/Ortsdaten aus system.json ohne Neustart,
// Flag „lesend“ im Register, Start-Haken des Agenten und Rückfall ohne Geo-Modul. Sammler und Geo sind Attrappen
// (netz._test.setze); alle Systembefehle sind ersetzt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { PFADE } from '../../src/gemeinsam/pfade.js';
import { Agent } from '../../src/agent/agent.js';
import { Register } from '../../src/agent/register.js';
import * as netz from '../../src/agent/aktionen/netz.js';

const ADMIN = { nutzer: 'fabian', rolle: 'admin', ip: '192.168.1.79' };
const NUTZER = { nutzer: 'lisa', rolle: 'nutzer', ip: '192.168.1.80' };
const SCHLUESSEL = ['aufzeichnung', 'fenster_s', 'gegenstellen', 'geo', 'heimat', 'lokal', 'richtung', 'summe', 'werkzeug', 'zeit'];
const ORT = { land: 'DE', land_name: 'Deutschland', stadt: 'Frankfurt am Main', lat: 50.11, lon: 8.68, genau: 'stadt' };
const GEGENSTELLEN = [
  { ip: '140.82.121.4', privat: false, anycast: false, ort: ORT, anzahl: 2, bytes: 1000, erst: '2026-09-26T09:30:00.000Z', zuletzt: '2026-09-26T10:00:00.000Z', lokal: [{ name: 'FAH-NAS', art: 'host', anzahl: 2 }] },
  { ip: '192.168.1.1', privat: true, anycast: false, ort: null, anzahl: 1, bytes: 234, erst: '2026-09-26T09:40:00.000Z', zuletzt: '2026-09-26T09:59:50.000Z', lokal: [{ name: 'FAH-NAS', art: 'host', anzahl: 1 }] },
];

function sammlerAttrappe() {
  const a = { optionen: null, gestartet: 0, gestoppt: 0, verworfen: 0, proben: 0, aufzeichnung: true, werkzeug: { ok: true, hinweis: null } };
  a.starten = async () => { a.gestartet++; };
  a.stoppen = async () => { a.gestoppt++; };
  a.verwerfen = () => { a.verworfen++; };
  a.probe = async () => { a.proben++; return true; };
  a.werkzeugStatus = () => ({ ...a.werkzeug });
  a.ergebnis = (richtung) => ({
    richtung, zeit: '2026-09-26T10:00:00.000Z', fenster_s: 3600, aufzeichnung: a.aufzeichnung, werkzeug: { ...a.werkzeug },
    geo: { quelle: 'falsch' }, heimat: 'falsch', schmuggel: 'fliegt raus',
    summe: { anzahl: 3, bytes: 1234, gegenstellen: 2 },
    gegenstellen: structuredClone(GEGENSTELLEN),
    lokal: [{ name: 'FAH-NAS', art: 'host', anzahl: 3, bytes: 1234 }],
  });
  return a;
}

function geoAttrappe() {
  const g = { optionen: null, gestartet: 0, gestoppt: 0, aktualisiert: 0 };
  g.starten = async () => { g.gestartet++; };
  g.aktualisieren = async () => { g.aktualisiert++; return g.status(); };
  g.stoppen = async () => { g.gestoppt++; };
  g.suche = (ip) => (ip === '140.82.121.4' ? { ...ORT } : null);
  g.status = () => ({ quelle: 'stadt', stand: '2026-09', hinweis: null });
  return g;
}

/** Echter Agent (ohne Socket und ohne Hintergrunddienste) mit Konfiguration in tmp und Attrappen für Sammler und Geo. */
async function umgebung() {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-netz-'));
  const befehle = [];
  system._test.setzeBefehl(async (p, a) => { befehle.push([p, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  const agent = new Agent({ konfigOrdner: path.join(w, 'config'), socketPfad: path.join(w, 'a.sock'), datenSocket: path.join(w, 'd.sock'), hintergrund: false });
  await agent.konfig.sicherstellen();
  await agent.konfig.speichern('users.json', { nutzer: [{ name: 'fabian', rolle: 'admin', gesperrt: false }, { name: 'lisa', rolle: 'nutzer', gesperrt: false }], gruppen: [] });
  const s = sammlerAttrappe();
  const g = geoAttrappe();
  netz._test.setze({ sammler: (o) => { s.optionen = o; return s; }, geo: (o) => { g.optionen = o; return g; } });
  await agent.aktionenLaden();
  const rufe = async (name, params = {}, k = ADMIN) => (await agent.ausfuehren(name, params, k)).ergebnis;
  const protokoll = async () => { await agent.audit.kette; return (await agent.audit.lesen({})).eintraege; };
  const aufraeumen = async () => {
    await netz._test.zuruecksetzen();
    await agent.audit.kette; // Prüfprotokoll-Zeilen fertig schreiben lassen, sonst räumt rm einen Ordner im Schreiben
    system._test.setzeBefehl(null);
    await fs.rm(w, { recursive: true, force: true });
  };
  return { w, agent, s, g, befehle, rufe, protokoll, aufraeumen };
}

test('netz.verbindungen: nur Admins (E_RECHTE), richtung nur ein/aus (E_PARAMS), Ergebnis in Vertragsform §4.6', async () => {
  const u = await umgebung();
  try {
    await assert.rejects(u.agent.ausfuehren('netz.verbindungen', { richtung: 'aus' }, NUTZER), (e) => e.code === 'E_RECHTE');
    await assert.rejects(u.rufe('netz.verbindungen', { richtung: 'quer' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'richtung');
    await assert.rejects(u.rufe('netz.verbindungen', {}), (e) => e.code === 'E_PARAMS');
    await assert.rejects(u.rufe('netz.verbindungen', { richtung: 'aus', mehr: 1 }), (e) => e.code === 'E_PARAMS');
    const e = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.deepEqual(Object.keys(e).sort(), SCHLUESSEL);
    assert.equal(e.richtung, 'aus');
    assert.equal(e.zeit, '2026-09-26T10:00:00.000Z');
    assert.equal(e.fenster_s, 3600);
    assert.equal(e.aufzeichnung, true);
    assert.deepEqual(e.werkzeug, { ok: true, hinweis: null });
    assert.deepEqual(e.geo, { quelle: 'keine', stand: null, hinweis: 'Die Ortsdaten werden gerade geladen.' }, 'vor dem Start ist die Geo-Verwaltung noch nicht da');
    assert.equal(e.heimat, null, 'ohne Standort keine Heimat');
    assert.deepEqual(e.summe, { anzahl: 3, bytes: 1234, gegenstellen: 2 });
    assert.deepEqual(e.gegenstellen, GEGENSTELLEN);
    assert.deepEqual(e.lokal, [{ name: 'FAH-NAS', art: 'host', anzahl: 3, bytes: 1234 }]);
    assert.equal((await u.rufe('netz.verbindungen', { richtung: 'ein' })).richtung, 'ein');
    // Werkzeug-Hinweis wird durchgereicht; Geo-Status nach dem Start aus der Geo-Verwaltung
    u.s.werkzeug = { ok: false, hinweis: 'conntrack fehlt' };
    await netz.starten(u.agent.werkzeuge);
    const e2 = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.deepEqual(e2.werkzeug, { ok: false, hinweis: 'conntrack fehlt' });
    // gekürzte Tabelle: ok bleibt true, Hinweis und gekuerzt:true kommen durch (nur echtes true, sonst fehlt das Feld)
    u.s.werkzeug = { ok: true, hinweis: 'Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet', gekuerzt: true };
    assert.deepEqual((await u.rufe('netz.verbindungen', { richtung: 'aus' })).werkzeug,
      { ok: true, hinweis: 'Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet', gekuerzt: true });
    u.s.werkzeug = { ok: true, hinweis: 'IPv6-Verbindungen gerade nicht lesbar.', gekuerzt: 'ja' };
    assert.deepEqual((await u.rufe('netz.verbindungen', { richtung: 'aus' })).werkzeug, { ok: true, hinweis: 'IPv6-Verbindungen gerade nicht lesbar.' });
    assert.deepEqual(e2.geo, { quelle: 'stadt', stand: '2026-09', hinweis: null });
    // höchstens 500 Gegenstellen, auch wenn ein Sammler mehr liefert
    const viele = Array.from({ length: 700 }, (_, i) => ({ ...GEGENSTELLEN[0], ip: `20.0.${i >> 8}.${i & 255}` }));
    const alt = u.s.ergebnis;
    u.s.ergebnis = (r) => ({ ...alt(r), gegenstellen: viele });
    assert.equal((await u.rufe('netz.verbindungen', { richtung: 'aus' })).gegenstellen.length, 500);
  } finally { await u.aufraeumen(); }
});

test('netz.verbindungen: Heimat aus system.json.standort; Aufzeichnung und Ortsdaten-Schalter greifen ohne Neustart', async () => {
  const u = await umgebung();
  try {
    await u.rufe('system.setzen', { aenderungen: { standort: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' } } });
    assert.deepEqual((await u.rufe('netz.verbindungen', { richtung: 'aus' })).heimat, { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' });
    assert.deepEqual(u.s.optionen.standortHolen(), { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' }, 'Sammler sieht denselben Standort');
    await u.rufe('system.setzen', { aenderungen: { standort: { lat: null, lon: null, name: 'Sandelzhausen' } } });
    assert.equal((await u.rufe('netz.verbindungen', { richtung: 'aus' })).heimat, null, 'ohne Koordinaten keine Heimat');
    // Aufzeichnung: der Sammler bekommt die Einstellung über aufzeichnenHolen (liest system.json bei jeder Probe)
    assert.equal(await u.s.optionen.aufzeichnenHolen(), true);
    await netz.starten(u.agent.werkzeuge);
    assert.equal(u.g.optionen.stadtLaden(), true);
    await u.rufe('system.setzen', { aenderungen: { verbindungen: { aufzeichnen: false }, geo: { stadt_laden: false } } });
    assert.equal(await u.s.optionen.aufzeichnenHolen(), false, 'ohne Neustart wirksam');
    assert.equal(u.g.optionen.stadtLaden(), false, 'Ortsdaten-Schalter ohne Neustart wirksam');
    const aus = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.equal(aus.aufzeichnung, false);
    assert.deepEqual([aus.gegenstellen, aus.lokal, aus.summe], [[], [], { anzahl: 0, bytes: 0, gegenstellen: 0 }]);
    assert.ok(u.s.verworfen >= 1, 'gesammelte Daten werden sofort verworfen');
    // wieder an: Daten des Sammlers; war der Sammler noch aus, stößt die Abfrage sofort eine Probe an
    u.s.aufzeichnung = false;
    await u.rufe('system.setzen', { aenderungen: { verbindungen: { aufzeichnen: true } } });
    const an = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.equal(an.aufzeichnung, true);
    await new Promise((r) => setImmediate(r));
    assert.ok(u.s.proben >= 1, 'sofortige Probe nach dem Einschalten');
    assert.equal(u.g.optionen.stadtLaden(), false, 'geo.stadt_laden bleibt, wenn nur verbindungen geändert wird');
    // Ortsdaten wieder einschalten → sofort laden (nicht erst bei der nächsten 6-h-Prüfung)
    const vorher = u.g.aktualisiert;
    await u.rufe('system.setzen', { aenderungen: { geo: { stadt_laden: true } } });
    await u.rufe('netz.verbindungen', { richtung: 'aus' });
    await new Promise((r) => setImmediate(r));
    assert.equal(u.g.aktualisiert, vorher + 1, 'Einschalten stößt genau eine Aktualisierung an');
    await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.equal(u.g.aktualisiert, vorher + 1, 'keine weitere ohne erneuten Wechsel');
    // system.json verschwindet → Standardwerte (aufzeichnen an)
    await fs.rm(path.join(u.w, 'config', 'system.json'));
    assert.equal(await u.s.optionen.aufzeichnenHolen(), true);
  } finally { await u.aufraeumen(); }
});

test('Prüfprotokoll: erfolgreiches netz.verbindungen und system.protokoll ohne Zeile, Fehlschläge und andere Aktionen mit Zeile', async () => {
  const u = await umgebung();
  try {
    await u.rufe('netz.verbindungen', { richtung: 'aus' });
    await u.rufe('netz.verbindungen', { richtung: 'ein' });
    await u.rufe('system.protokoll', {});
    assert.deepEqual(await u.protokoll(), [], 'lesende Abfragen der Übersicht füllen das Prüfprotokoll nicht');
    await assert.rejects(u.rufe('netz.verbindungen', { richtung: 'quer' }));
    await assert.rejects(u.agent.ausfuehren('netz.verbindungen', { richtung: 'aus' }, NUTZER));
    await assert.rejects(u.rufe('system.protokoll', { je_seite: 5000 }));
    await u.rufe('system.lesen', {});
    const zeilen = (await u.protokoll()).map((z) => `${z.aktion}:${z.ok}`).sort();
    assert.deepEqual(zeilen, ['netz.verbindungen:false', 'netz.verbindungen:false', 'system.lesen:true', 'system.protokoll:false']);
  } finally { await u.aufraeumen(); }
});

test('Register: Flag „lesend“ wird übernommen (Standard false)', () => {
  const reg = new Register();
  reg.aktion('test.lesen', { rolle: 'admin', schema: {}, lesend: true, ausfuehren: async () => 1 });
  reg.aktion('test.schreiben', { rolle: 'admin', schema: {}, ausfuehren: async () => 1 });
  assert.equal(reg.hole('test.lesen').lesend, true);
  assert.equal(reg.hole('test.schreiben').lesend, false);
});

test('Start-Haken: netz.starten startet Sammler und Geo (Fehler nur protokolliert), netz.stoppen hält beide an', async () => {
  const u = await umgebung();
  try {
    await netz.starten(u.agent.werkzeuge);
    assert.equal(u.s.gestartet, 1);
    assert.equal(u.g.gestartet, 1);
    assert.deepEqual(u.g.optionen.pfade, { mit: PFADE.geoMit, daten: PFADE.geo });
    assert.equal(typeof u.g.optionen.protokoll, 'function');
    // Sammler nutzt die Geo-Verwaltung über eine Hülle (Orte ab dem Start, vorher null)
    assert.deepEqual(await u.s.optionen.geo.suche('140.82.121.4'), ORT);
    assert.deepEqual(u.s.optionen.geo.status(), { quelle: 'stadt', stand: '2026-09', hinweis: null });
    assert.equal(u.s.optionen.system, u.agent.werkzeuge.system);
    await netz.stoppen();
    assert.equal(u.s.gestoppt, 1);
    assert.equal(u.g.gestoppt, 1);
    assert.equal(await u.s.optionen.geo.suche('140.82.121.4'), null, 'nach dem Stopp keine Orte mehr');
    // Fehler beim Start von Geo und Sammler: kein Wurf, Aktion arbeitet weiter
    netz._test.setze({
      sammler: () => ({ ...sammlerAttrappe(), starten: async () => { throw new Error('Sammler kaputt'); } }),
      geo: () => ({ starten: async () => { throw new Error('Geo kaputt'); }, status: () => ({ quelle: 'land', stand: null, hinweis: 'Nur Länder' }), suche: () => null }),
    });
    await netz.starten(u.agent.werkzeuge);
    const e = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.deepEqual(e.geo, { quelle: 'land', stand: null, hinweis: 'Nur Länder' });
  } finally { await u.aufraeumen(); }
});

test('ohne Geo-Modul: Aktion arbeitet ohne Orte weiter (quelle keine, Hinweis), Sammler-Hülle liefert null', async () => {
  const u = await umgebung();
  try {
    netz._test.setze({ geo: null, geoModul: '../helfer/gibt-es-nicht.js' });
    await netz.starten(u.agent.werkzeuge);
    const e = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.equal(e.geo.quelle, 'keine');
    assert.equal(e.geo.stand, null);
    assert.match(e.geo.hinweis, /Ortsdaten/);
    assert.equal(await u.s.optionen.geo.suche('140.82.121.4'), null);
    assert.equal(e.gegenstellen.length, 2);
  } finally { await u.aufraeumen(); }
});

test('netz.verbindungen mit dem echten Sammler (ohne Start-Haken): leere, gültige Antwort; Probe liest conntrack', async () => {
  const u = await umgebung();
  try {
    netz._test.setze({ sammler: null });
    const leer = await u.rufe('netz.verbindungen', { richtung: 'ein' });
    assert.deepEqual(Object.keys(leer).sort(), SCHLUESSEL);
    assert.deepEqual([leer.gegenstellen, leer.lokal, leer.summe], [[], [], { anzahl: 0, bytes: 0, gegenstellen: 0 }]);
    assert.ok(await netz._test.zustand.sammler.probe());
    assert.ok(u.befehle.some((b) => b[0] === 'conntrack' && b[1] === '-L'));
    const e = await u.rufe('netz.verbindungen', { richtung: 'aus' });
    assert.deepEqual(e.werkzeug, { ok: true, hinweis: null });
  } finally { await u.aufraeumen(); }
});

test('Agent: Start-Haken der Bereiche (starten/stoppen, Fehler einzeln), nur mit „hintergrund“', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-netz-agent-'));
  try {
    const opt = { konfigOrdner: path.join(w, 'config'), socketPfad: path.join(w, 'a.sock'), datenSocket: path.join(w, 'd.sock') };
    assert.equal(new Agent(opt).hintergrund, true, 'Standard: Hintergrunddienste an (Betrieb)');
    assert.equal(new Agent({ ...opt, hintergrund: false }).hintergrund, false);
    const agent = new Agent(opt);
    const aufrufe = [];
    agent.bereichsModule = [
      { name: 'a', modul: { starten: async (werkzeuge) => { aufrufe.push(`a:${werkzeuge === agent.werkzeuge}`); }, stoppen: async () => { aufrufe.push('a:stopp'); } } },
      { name: 'b', modul: { starten: async () => { throw new Error('b kaputt'); }, stoppen: () => { throw new Error('b stopp kaputt'); } } },
      { name: 'c', modul: { registriere() {} } },
    ];
    await agent.bereicheStarten();
    await agent.bereicheStoppen();
    assert.deepEqual(aufrufe, ['a:true', 'a:stopp']);
    // aktionenLaden merkt sich die Bereichsmodule (inkl. netz mit starten/stoppen)
    const b = new Agent({ ...opt, hintergrund: false });
    await b.aktionenLaden();
    const netzModul = b.bereichsModule.find((m) => m.name === 'netz');
    assert.ok(netzModul && typeof netzModul.modul.starten === 'function' && typeof netzModul.modul.stoppen === 'function');
    assert.ok(b.register.aktionen.has('netz.verbindungen'));
    assert.equal(b.register.hole('netz.verbindungen').lesend, true);
    assert.equal(b.register.hole('system.protokoll').lesend, true);
    assert.equal(b.register.hole('netz.verbindungen').rolle, 'admin');
  } finally { await netz._test.zuruecksetzen(); await fs.rm(w, { recursive: true, force: true }); }
});
