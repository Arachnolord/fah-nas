// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// TURN-Steuerung im Web-Dienst (Plan 03, Aufgabe 7): Start nach chat.turn_info, Neustart bei geänderten
// Chat-Einstellungen, Fehlerzustände, ICE-Zugänge je Identität mit Zwischenspeicher, Merken von Zugriffen von außen.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmp } from './web_hilfen.js';
import { TurnSteuerung } from '../../src/web/turn/steuerung.js';
import { geheimnisLaden, passwortFuer } from '../../src/web/turn/zugang.js';

let info; let agent; let ordner; let uhr;
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
/** Wartet (höchstens 1 s), bis fn() wahr ist – Dateizugriffe brauchen mehr als ein paar Ereignisrunden. */
const bis = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); } };

class Schein extends EventEmitter {
  static instanzen = []; static fehler = null;
  constructor(optionen) { super(); this.optionen = optionen; this.gestartet = false; this.gestoppt = false; Schein.instanzen.push(this); }
  async starten() { if (Schein.fehler) throw Schein.fehler; this.gestartet = true; return this.optionen.port; }
  async stoppen() { this.gestoppt = true; }
  zugangEntziehen(wer, ab) { (this.entzogen ||= []).push([wer, ab]); }
  stand() { return { aktiv: this.gestartet && !this.gestoppt, port: this.optionen.port, zuteilungen: 2, extern_zuletzt: null }; }
}
class ScheinAgent extends EventEmitter {
  constructor() { super(); this.verbunden = true; this.turnInfoAufrufe = 0; this.ausfall = false; }
  async aktion(name, params, kontext) {
    assert.equal(name, 'chat.turn_info'); assert.deepEqual(params, {}); assert.equal(kontext.rolle, 'gast');
    this.turnInfoAufrufe++;
    if (this.ausfall) throw Object.assign(new Error('weg'), { code: 'E_AGENT' });
    return { ...info };
  }
}

beforeEach(async () => {
  info = { lan_ip: '192.168.1.29', aktiv: true, port: 3478 };
  agent = new ScheinAgent(); ordner = await tmp(); uhr = 1_800_000_000_000;
  Schein.instanzen = []; Schein.fehler = null;
});

test('sperren: entzieht dem laufenden Dienst den Zugang und gibt ihn an einen neu gestarteten weiter (Prüfbericht Plan 03, I6)', async () => {
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein, jetzt: () => uhr }); await s.starten();
  s.sperren('gast-gAAAAAAAAAAAAAAAA');
  assert.deepEqual(Schein.instanzen[0].entzogen, [['gast-gAAAAAAAAAAAAAAAA', uhr]]);
  info = { ...info, port: 3479 }; await s.neuLaden(); await ruhe();
  assert.deepEqual(Schein.instanzen.at(-1).entzogen, [['gast-gAAAAAAAAAAAAAAAA', uhr]], 'nach dem Neustart weiter gesperrt');
  await s.stoppen();
});

test('startet mit LAN-IP, Port und Geheimnis; Standard-Relaybereich', async () => {
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await s.starten();
  assert.equal(Schein.instanzen.length, 1);
  const o = Schein.instanzen[0].optionen;
  assert.deepEqual([o.port, o.relayIp, o.relayVon, o.relayBis, o.realm, o.geheimnis.length], [3478, '192.168.1.29', 49160, 49200, 'fah-nas', 32]);
  assert.deepEqual(s.stand(), { aktiv: true, port: 3478, lan_ip: '192.168.1.29', zuteilungen: 2, extern_zuletzt: null, fehler: null });
  await s.stoppen();
  assert.equal(Schein.instanzen[0].gestoppt, true);
});

test('konfig chat: neuer Port → Neustart, gleicher Stand → kein Neustart, aus → Stopp', async () => {
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await s.starten();
  info = { ...info, port: 3479 };
  agent.emit('ereignis', { ereignis: 'konfig', bereich: 'chat' }); await ruhe();
  assert.equal(Schein.instanzen.length, 2); assert.equal(Schein.instanzen[1].optionen.port, 3479); assert.equal(Schein.instanzen[0].gestoppt, true);
  agent.emit('ereignis', { ereignis: 'konfig', bereich: 'chat' }); await ruhe();
  agent.emit('ereignis', { ereignis: 'konfig', bereich: 'system' }); await ruhe();
  assert.equal(Schein.instanzen.length, 2, 'unverändert → kein Neustart');
  info = { ...info, aktiv: false };
  agent.emit('ereignis', { ereignis: 'konfig', bereich: 'chat' }); await ruhe();
  assert.equal(Schein.instanzen[1].gestoppt, true);
  assert.equal(s.stand().aktiv, false); assert.equal(s.stand().fehler, null);
  await s.stoppen();
});

test('keine LAN-IP → fehler keine_lan_ip; Port belegt → port_belegt; Agent fehlt → wartet auf verbunden', async () => {
  info = { ...info, lan_ip: null };
  const a = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await a.starten();
  assert.equal(a.stand().fehler, 'keine_lan_ip'); assert.equal(a.stand().aktiv, false); assert.equal(Schein.instanzen.length, 0);
  await a.stoppen();
  info = { ...info, lan_ip: '192.168.1.29' };
  Schein.fehler = Object.assign(new Error('belegt'), { code: 'EADDRINUSE' });
  const b = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await b.starten();
  assert.equal(b.stand().fehler, 'port_belegt'); assert.equal(b.stand().aktiv, false);
  await b.stoppen();
  Schein.fehler = null; agent.ausfall = true;
  const c = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await c.starten();
  assert.equal(c.stand().fehler, 'agent'); assert.equal(c.stand().aktiv, false);
  agent.ausfall = false; agent.emit('verbunden'); await ruhe();
  assert.equal(c.stand().aktiv, true); assert.equal(c.stand().fehler, null);
  await c.stoppen();
});

test('ice: Zugangsdaten je Identität, Domain aus linkAdresse, 300 s Zwischenspeicher', async () => {
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein, linkAdresse: { wert: 'https://nas.example' }, jetzt: () => uhr }); await s.starten();
  const r = await s.ice({ art: 'nutzer', nutzer: 'anna' });
  assert.equal(r.ice_server[0].urls.length, 4); assert.match(r.ice_server[0].username, /^\d+:anna$/);
  assert.deepEqual(r.ice_server[0].urls, ['stun:192.168.1.29:3478', 'turn:192.168.1.29:3478?transport=udp', 'stun:nas.example:3478', 'turn:nas.example:3478?transport=udp']);
  assert.equal(r.ice_server[0].credential, passwortFuer((await geheimnisLaden(ordner)).geheimnis, r.ice_server[0].username));
  assert.equal(r.gueltig_bis, new Date((Math.floor(uhr / 1000) + 43_200) * 1000).toISOString());
  const g = await s.ice({ art: 'gast', gast: 'gAAAAAAAAAAAAAAAA' });
  assert.match(g.ice_server[0].username, /^\d+:gast-gAAAAAAAAAAAAAAAA$/);
  assert.equal(agent.turnInfoAufrufe, 1);
  uhr += 300_001; await s.ice({ art: 'nutzer', nutzer: 'anna' }); assert.equal(agent.turnInfoAufrufe, 2);
  await s.stoppen();
});

test('ice bei ausgeschaltetem TURN → leere Liste', async () => {
  info = { ...info, aktiv: false };
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await s.starten();
  assert.deepEqual(await s.ice({ art: 'nutzer', nutzer: 'anna' }), { ice_server: [], gueltig_bis: null });
  await s.stoppen();
});

test('extern_zuletzt aus dem zuteilung-Ereignis, höchstens alle 600 s in turn.json', async () => {
  const s = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein, jetzt: () => uhr }); await s.starten();
  const datei = async () => JSON.parse(await fs.readFile(path.join(ordner, 'turn.json'), 'utf8')).extern_zuletzt;
  const warteAuf = (wert) => bis(async () => (await datei()) === wert);
  const t0 = new Date(uhr).toISOString();
  Schein.instanzen[0].emit('zuteilung', { wer: 'anna', quelle: '8.8.8.8', extern: true }); await ruhe();
  await warteAuf(t0);
  assert.equal(s.stand().extern_zuletzt, t0); assert.equal(await datei(), t0);
  uhr += 60_000;
  Schein.instanzen[0].emit('zuteilung', { wer: 'anna', quelle: '8.8.8.8', extern: true }); await ruhe();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.stand().extern_zuletzt, new Date(uhr).toISOString()); assert.equal(await datei(), t0, 'höchstens alle 600 s geschrieben');
  Schein.instanzen[0].emit('zuteilung', { wer: 'ben', quelle: '192.168.1.7', extern: false }); await ruhe();
  assert.equal(s.stand().extern_zuletzt, new Date(uhr).toISOString(), 'aus dem Heimnetz zählt nicht');
  uhr += 600_000;
  Schein.instanzen[0].emit('zuteilung', { wer: 'anna', quelle: '8.8.8.8', extern: true }); await warteAuf(new Date(uhr).toISOString());
  assert.equal(await datei(), new Date(uhr).toISOString());
  await s.stoppen();
  const neu = new TurnSteuerung({ agent, ordner, TurnKlasse: Schein }); await neu.starten();
  assert.equal(neu.stand().extern_zuletzt, new Date(uhr).toISOString(), 'gemerkter Wert nach Neustart');
  await neu.stoppen();
});
