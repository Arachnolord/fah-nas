// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anruf-Signalisierung im Web-Dienst (Plan 03, Aufgabe 8) mit Schein-Chat ohne Sockets: Beitreten, Stand je Empfänger,
// Signal nur zwischen Teilnehmenden, Grenzen, Doppelbeitritt, Trennen, Klingeln/Annehmen/Ablehnen/Verpasst in DMs,
// Gäste, Entfernen, Abfragen, Medien, Bremse.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Anrufe, TEILNEHMER_MUSTER } from '../../src/web/chat/anrufe.js';

const R = 'rAAAAAAAAAAAAAAAA';
const D = 'dBBBBBBBBBBBBBBBBBBBB';
const G = ['gAAAAAAAAAAAAAAA1', 'gAAAAAAAAAAAAAAA2', 'gAAAAAAAAAAAAAAA3', 'gAAAAAAAAAAAAAAA4'];
const ANDERER = 'rZZZZZZZZZZZZZZZZ';
const anna = { art: 'nutzer', nutzer: 'anna', rolle: 'nutzer', anzeigename: 'Anna A.', sitzungId: 's1' };
const ben = { art: 'nutzer', nutzer: 'ben', rolle: 'nutzer', anzeigename: 'Ben', sitzungId: 's2' };
const cara = { art: 'nutzer', nutzer: 'cara', rolle: 'nutzer', anzeigename: 'Cara', sitzungId: 's3' };
const dora = { art: 'nutzer', nutzer: 'dora', rolle: 'nutzer', anzeigename: 'Dora', sitzungId: 's4' };
const gast = (i, name = `Gast${i}`) => ({ art: 'gast', gast: G[i], raum: R, raum_name: 'Team', name, ausweis: { id: G[i], geheimnis: 'x'.repeat(43) } });

let verbindungen; let haken; let trennung; let agent; let anrufe; let uhr;
const RAEUME = { [R]: { nutzer: ['anna', 'ben', 'cara'], gaeste: G }, [D]: { nutzer: ['anna', 'ben'], gaeste: [] } };

beforeEach(() => {
  verbindungen = []; haken = new Map(); trennung = new Set(); uhr = 0;
  const chat = {
    handler: (art, fn) => haken.set(art, fn),
    beiTrennung: (fn) => { trennung.add(fn); return () => trennung.delete(fn); },
    verteiler: {
      fuerNutzer: (n) => verbindungen.filter((v) => v.identitaet.art === 'nutzer' && v.identitaet.nutzer === n),
      fuerGast: (g) => verbindungen.filter((v) => v.identitaet.art === 'gast' && v.identitaet.gast === g),
      online: () => [...new Set(verbindungen.filter((v) => v.identitaet.art === 'nutzer').map((v) => v.identitaet.nutzer))].sort(),
      aktive: () => [...new Set(verbindungen.filter((v) => v.identitaet.art === 'nutzer' && v.sichtbar).map((v) => v.identitaet.nutzer))].sort(),
    },
    empfaenger: async (id, raum) => {
      const r = RAEUME[raum];
      const darf = r && (id.art === 'nutzer' ? r.nutzer.includes(id.nutzer) : r.gaeste.includes(id.gast) && id.raum === raum);
      if (!darf) throw Object.assign(new Error('Diesen Raum gibt es nicht'), { code: 'E_NICHT_GEFUNDEN', meldung: 'Diesen Raum gibt es nicht' });
      return { nutzer: [...r.nutzer], gaeste: [...r.gaeste] };
    },
  };
  agent = Object.assign(new EventEmitter(), { aufrufe: [], async aktion(a, p, k) { this.aufrufe.push({ a, p, k }); return { benachrichtigt: [] }; } });
  anrufe = new Anrufe({ chat, agent, jetzt: () => uhr });
  anrufe.einhaengen();
});

function verbinden(identitaet) {
  const v = { id: crypto.randomUUID(), identitaet, ws: { gesendet: [], senden(o) { this.gesendet.push(o); return true; } } };
  verbindungen.push(v);
  return v;
}
const schicken = (v, n) => haken.get(n.art)(v, n);
const trennen = (v) => { verbindungen.splice(verbindungen.indexOf(v), 1); for (const fn of trennung) fn(v); };
const letzte = (v, art) => v.ws.gesendet.findLast((m) => m.art === art);
const alle = (v, art) => v.ws.gesendet.filter((m) => m.art === art);
const meineId = (v) => letzte(v, 'anruf.beigetreten').id;
const agentArt = (art) => agent.aufrufe.filter((x) => x.p.art === art);

test('beitreten: beigetreten an den Neuen, stand an alle Mitglieder mit ich, beginn an den Agenten', async () => {
  const a = verbinden(anna); verbinden(ben); const c = verbinden(cara);
  await schicken(a, { art: 'anruf.beitreten', raum: R, video: true });
  const bei = letzte(a, 'anruf.beigetreten');
  assert.match(bei.id, TEILNEHMER_MUSTER); assert.deepEqual(bei.teilnehmer, []); assert.equal(bei.raum, R);
  const stC = letzte(c, 'anruf.stand');
  assert.deepEqual(stC.teilnehmer, [{ id: bei.id, name: 'Anna A.', gast: false, medien: { audio: true, video: true, bildschirm: false }, ich: false, nutzer: 'anna' }], 'Mitglieder sehen den Login-Namen (Avatar, 0.22.0)');
  assert.equal(typeof stC.beginn, 'string');
  assert.equal(letzte(a, 'anruf.stand').teilnehmer[0].ich, true);
  assert.deepEqual(agent.aufrufe[0], { a: 'chat.anruf', p: { raum: R, art: 'beginn', video: true, aktiv: [] }, k: { nutzer: 'anna', rolle: 'nutzer', ip: '-' } }, 'nur gerade sichtbare Chats unterdrücken die Meldung (Prüfbericht Plan 03, I4)');
  const b2 = verbinden(ben);
  await schicken(b2, { art: 'anruf.beitreten', raum: R });
  assert.deepEqual(letzte(b2, 'anruf.beigetreten').teilnehmer.map((t) => t.name), ['Anna A.'], 'der Neue erfährt, wer schon da ist');
  assert.equal(agentArt('beginn').length, 1, 'beginn nur einmal je Anruf');
});

test('Gäste sehen Teilnehmer ohne Anzeigenamen als „Mitglied“, nie mit Login-Namen (Befund 11 aus Plan 02)', async () => {
  const otto = { art: 'nutzer', nutzer: 'anna', rolle: 'nutzer', anzeigename: 'anna', gastname: 'Mitglied', sitzungId: 's9' };
  const o = verbinden(otto); const g = verbinden(gast(0)); const b = verbinden(ben);
  await schicken(o, { art: 'anruf.beitreten', raum: R, video: false });
  assert.equal(letzte(g, 'anruf.stand').teilnehmer[0].name, 'Mitglied');
  assert.equal(letzte(b, 'anruf.stand').teilnehmer[0].name, 'anna', 'Mitglieder sehen den Namen');
  await schicken(g, { art: 'anruf.beitreten', raum: R, video: false });
  assert.equal(letzte(g, 'anruf.beigetreten').teilnehmer[0].name, 'Mitglied');
});

test('Signal nur zwischen Teilnehmenden; an muss aktuelle ID sein; Form wird geprüft', async () => {
  const a = verbinden(anna); const b = verbinden(ben); const c = verbinden(cara);
  await schicken(a, { art: 'anruf.beitreten', raum: R }); await schicken(b, { art: 'anruf.beitreten', raum: R });
  const aid = meineId(a); const bid = meineId(b);
  await schicken(c, { art: 'anruf.signal', raum: R, an: aid, daten: { kandidat: null } });
  assert.equal(letzte(c, 'anruf.fehler').fehler.code, 'E_RECHTE'); assert.equal(letzte(c, 'anruf.fehler').raum, R);
  assert.equal(alle(a, 'anruf.signal').length, 0);
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { beschreibung: { type: 'offer', sdp: 'v=0' } } });
  assert.deepEqual(letzte(b, 'anruf.signal'), { art: 'anruf.signal', raum: R, von: aid, daten: { beschreibung: { type: 'offer', sdp: 'v=0' } } });
  await schicken(a, { art: 'anruf.signal', raum: R, an: 'pAAAAAAAAAAAA', daten: { kandidat: null } });
  assert.equal(alle(a, 'anruf.fehler').length, 0, 'unbekanntes Ziel → still');
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { x: 1 } });
  assert.equal(letzte(a, 'anruf.fehler').fehler.code, 'E_PARAMS');
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { beschreibung: { type: 'offer', sdp: 'x'.repeat(60_001) } } });
  assert.equal(alle(a, 'anruf.fehler').length, 2);
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { beschreibung: { type: 'quatsch', sdp: 'v=0' } } });
  assert.equal(alle(a, 'anruf.fehler').length, 3);
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { kandidat: null } });
  assert.deepEqual(letzte(b, 'anruf.signal').daten, { kandidat: null });
  await schicken(a, { art: 'anruf.signal', raum: R, an: bid, daten: { kandidat: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal(letzte(b, 'anruf.signal').daten.kandidat.sdpMid, '0');
  assert.equal(alle(b, 'anruf.signal').length, 3);
});

test('Verbindung reißt während des Beitritts ab (Agent-Rundweg) → kein Geister-Teilnehmer (Prüfbericht Plan 03, I2)', async () => {
  const g = verbinden(gast(0)); const c = verbinden(cara);
  const schicht = schicken(g, { art: 'anruf.beitreten', raum: R, video: false }); // empfaenger() läuft noch
  trennen(g);
  await schicht;
  assert.equal(letzte(c, 'anruf.stand'), undefined, 'niemand sieht einen laufenden Anruf');
  assert.equal(agentArt('beginn').length, 0, 'kein Beginn, kein Push');
  await schicken(c, { art: 'anruf.beitreten', raum: R, video: false });
  assert.deepEqual(letzte(c, 'anruf.beigetreten').teilnehmer, [], 'kein Geist im Anruf');
});

test('Missbrauch: kurzer Raum-Anruf allein ohne Notiz; mehr als 3 neue Anrufe je Minute → E_BREMSE (Prüfbericht Plan 03, I5)', async () => {
  const a = verbinden(anna); const b = verbinden(ben);
  for (let i = 0; i < 3; i++) {
    await schicken(a, { art: 'anruf.beitreten', raum: R, video: false });
    uhr += 2000;
    await schicken(a, { art: 'anruf.verlassen', raum: R });
  }
  assert.equal(agentArt('ende').length, 0, 'allein und kurz: keine Notiz');
  await schicken(a, { art: 'anruf.beitreten', raum: R, video: false });
  assert.equal(letzte(a, 'anruf.fehler').fehler.code, 'E_BREMSE');
  uhr += 61_000;
  await schicken(a, { art: 'anruf.beitreten', raum: R, video: false });
  await schicken(b, { art: 'anruf.beitreten', raum: R, video: false });
  uhr += 3000;
  await schicken(a, { art: 'anruf.verlassen', raum: R }); await schicken(b, { art: 'anruf.verlassen', raum: R });
  assert.equal(agentArt('ende').length, 1, 'mit Gegenüber gibt es die Notiz');
  await schicken(a, { art: 'anruf.beitreten', raum: R, video: false });
  uhr += 15_000;
  await schicken(a, { art: 'anruf.verlassen', raum: R });
  assert.equal(agentArt('ende').length, 2, 'allein, aber länger als 10 s: Notiz');
});

test('7. Teilnehmer → E_BELEGT; Doppelbeitritt ersetzt die alte Teilnahme', async () => {
  const vs = [anna, ben, cara, gast(0), gast(1), gast(2)].map(verbinden);
  for (const v of vs) await schicken(v, { art: 'anruf.beitreten', raum: R });
  const g4 = verbinden(gast(3));
  await schicken(g4, { art: 'anruf.beitreten', raum: R });
  assert.deepEqual(letzte(g4, 'anruf.fehler'), { art: 'anruf.fehler', raum: R, fehler: { code: 'E_BELEGT', meldung: 'Anruf ist voll (höchstens 6)' } });
  const alteId = meineId(vs[0]);
  const a2 = verbinden(anna);
  await schicken(a2, { art: 'anruf.beitreten', raum: R });
  assert.deepEqual(letzte(vs[0], 'anruf.ende'), { art: 'anruf.ende', raum: R, grund: 'ersetzt' });
  assert.equal(anrufe.laufend(R).teilnehmer.length, 6);
  assert.notEqual(meineId(a2), alteId);
  assert.equal(anrufe.laufend(R).teilnehmer.filter((t) => t.name === 'Anna A.').length, 1);
});

test('Verbindung weg = verlassen; der Letzte beendet mit Dauer genau einmal', async () => {
  const a = verbinden(anna); const b = verbinden(ben); const c = verbinden(cara);
  await schicken(a, { art: 'anruf.beitreten', raum: R, video: true }); await schicken(b, { art: 'anruf.beitreten', raum: R, video: true });
  uhr = 125_000;
  trennen(a);
  assert.deepEqual(letzte(c, 'anruf.stand').teilnehmer.map((t) => t.name), ['Ben']);
  trennen(b);
  const ende = letzte(c, 'anruf.stand');
  assert.deepEqual([ende.teilnehmer, ende.beginn], [[], null]);
  assert.deepEqual(agentArt('ende'), [{ a: 'chat.anruf', p: { raum: R, art: 'ende', video: true, dauer_s: 125 }, k: { nutzer: 'ben', rolle: 'nutzer', ip: '-' } }]);
  assert.equal(anrufe.laufend(R), null);
  const anzahl = c.ws.gesendet.length;
  await schicken(c, { art: 'anruf.verlassen', raum: R });
  assert.equal(c.ws.gesendet.length, anzahl, 'verlassen ohne Teilnahme → keine Antwort');
});

test('DM: klingelt bei allen Geräten des anderen; 45 s ohne Annahme → keine_antwort + verpasst', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = verbinden(anna); const b1 = verbinden(ben); const b2 = verbinden(ben);
  await schicken(a, { art: 'anruf.beitreten', raum: D, video: false });
  for (const b of [b1, b2]) assert.deepEqual(letzte(b, 'anruf.klingelt'), { art: 'anruf.klingelt', raum: D, von_name: 'Anna A.', video: false });
  assert.equal(alle(a, 'anruf.klingelt').length, 0);
  t.mock.timers.tick(44_999);
  assert.equal(alle(a, 'anruf.ende').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(letzte(a, 'anruf.ende'), { art: 'anruf.ende', raum: D, grund: 'keine_antwort' });
  assert.deepEqual(letzte(b1, 'anruf.stand').teilnehmer, []);
  assert.equal(agentArt('verpasst').length, 1);
  assert.deepEqual(agentArt('verpasst')[0].p.aktiv, [], 'verpasst immer melden – auch wenn Tabs offen sind (Prüfbericht Plan 03, I4)');
  assert.deepEqual(agentArt('verpasst')[0].p, { raum: D, art: 'verpasst', video: false, aktiv: [] });
  assert.equal(agentArt('verpasst')[0].k.nutzer, 'anna');
  assert.equal(agentArt('ende').length, 0);
});

test('DM: Annehmen stoppt das Klingeln, Ablehnen beendet ohne verpasst, Auflegen vorher = verpasst', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = verbinden(anna); const b1 = verbinden(ben);
  // (1) angenommen
  await schicken(a, { art: 'anruf.beitreten', raum: D }); await schicken(b1, { art: 'anruf.beitreten', raum: D });
  t.mock.timers.tick(60_000);
  assert.equal(agentArt('verpasst').length, 0);
  uhr = 30_000;
  await schicken(a, { art: 'anruf.verlassen', raum: D }); await schicken(b1, { art: 'anruf.verlassen', raum: D });
  assert.deepEqual(agentArt('ende').map((x) => x.p), [{ raum: D, art: 'ende', video: false, dauer_s: 30 }]);
  // (2) abgelehnt
  await schicken(a, { art: 'anruf.beitreten', raum: D });
  await schicken(b1, { art: 'anruf.ablehnen', raum: D });
  assert.deepEqual(letzte(a, 'anruf.abgelehnt'), { art: 'anruf.abgelehnt', raum: D, von_name: 'Ben' });
  assert.deepEqual(letzte(a, 'anruf.ende'), { art: 'anruf.ende', raum: D, grund: 'abgelehnt' });
  assert.deepEqual(agentArt('ende').at(-1).p, { raum: D, art: 'ende', video: false, dauer_s: 0 });
  assert.equal(agentArt('ende').at(-1).k.nutzer, 'anna');
  t.mock.timers.tick(60_000);
  assert.equal(agentArt('verpasst').length, 0);
  // (3) Anrufer legt vorher auf
  await schicken(a, { art: 'anruf.beitreten', raum: D });
  await schicken(a, { art: 'anruf.verlassen', raum: D });
  assert.equal(agentArt('verpasst').length, 1);
  t.mock.timers.tick(60_000);
  assert.equal(agentArt('verpasst').length, 1, 'kein zweites verpasst durch den Timer');
  // (4) Ablehnen im Raum wirkt nicht
  const c = verbinden(cara);
  await schicken(a, { art: 'anruf.beitreten', raum: R });
  await schicken(c, { art: 'anruf.ablehnen', raum: R });
  assert.equal(anrufe.laufend(R).teilnehmer.length, 1);
  assert.equal(alle(a, 'anruf.abgelehnt').length, 1);
});

test('Gast: Agent über chat.gast.anruf mit Ausweis; fremder Raum → E_NICHT_GEFUNDEN', async () => {
  const g = verbinden(gast(0, 'Gustav')); const a = verbinden(anna);
  await schicken(g, { art: 'anruf.beitreten', raum: R });
  assert.deepEqual(agent.aufrufe[0], { a: 'chat.gast.anruf', p: { ausweis: { id: G[0], geheimnis: 'x'.repeat(43) }, raum: R, art: 'beginn', video: false, aktiv: [] }, k: { nutzer: 'web', rolle: 'gast', ip: '-' } }); // aktiv = sichtbare Chats (I4)
  await schicken(g, { art: 'anruf.beitreten', raum: D });
  assert.equal(letzte(g, 'anruf.fehler').fehler.code, 'E_NICHT_GEFUNDEN');
  await schicken(a, { art: 'anruf.beitreten', raum: R });
  const st = letzte(g, 'anruf.stand');
  assert.deepEqual(st.teilnehmer.map((x) => Object.keys(x).sort()), [['gast', 'ich', 'id', 'medien', 'name'], ['gast', 'ich', 'id', 'medien', 'name']]);
  assert.deepEqual(st.teilnehmer.map((x) => [x.name, x.gast, x.ich]), [['Gustav', true, true], ['Anna A.', false, false]]);
  await schicken(g, { art: 'anruf.beitreten', raum: ANDERER });
  assert.equal(letzte(g, 'anruf.fehler').fehler.code, 'E_NICHT_GEFUNDEN');
  await schicken(g, { art: 'anruf.beitreten', raum: 'kaputt' });
  assert.equal(letzte(g, 'anruf.fehler').fehler.code, 'E_PARAMS');
});

test('raum_weg/gast_entfernt entfernen; abfragen liefert laufende; medien aktualisiert; Bremse', async () => {
  const a = verbinden(anna); const b = verbinden(ben); const c = verbinden(cara); const g = verbinden(gast(0)); const d = verbinden(dora);
  for (const v of [a, b, g]) await schicken(v, { art: 'anruf.beitreten', raum: R });
  agent.emit('ereignis', { ereignis: 'chat', raum: R, art: 'raum_weg', daten: { raum: R }, an: { nutzer: ['ben'], gaeste: [] } });
  assert.deepEqual(letzte(b, 'anruf.ende'), { art: 'anruf.ende', raum: R, grund: 'entfernt' });
  assert.deepEqual(letzte(c, 'anruf.stand').teilnehmer.map((t) => t.name), ['Anna A.', 'Gast0']);
  agent.emit('ereignis', { ereignis: 'chat', raum: R, art: 'gast_entfernt', daten: { gast: G[0] }, an: { nutzer: ['anna', 'cara'], gaeste: [] } });
  assert.deepEqual(letzte(g, 'anruf.ende'), { art: 'anruf.ende', raum: R, grund: 'entfernt' });
  assert.deepEqual(letzte(c, 'anruf.stand').teilnehmer.map((t) => t.name), ['Anna A.']);
  const vorherC = alle(c, 'anruf.stand').length;
  await schicken(c, { art: 'anruf.abfragen' });
  assert.equal(alle(c, 'anruf.stand').length, vorherC + 1);
  await schicken(d, { art: 'anruf.abfragen' });
  assert.equal(d.ws.gesendet.length, 0, 'Nicht-Mitglied bekommt nichts');
  await schicken(a, { art: 'anruf.medien', raum: R, audio: false, video: true, bildschirm: true });
  assert.deepEqual(letzte(c, 'anruf.stand').teilnehmer[0].medien, { audio: false, video: true, bildschirm: true });
  for (let i = 0; i < 205; i++) await schicken(c, { art: 'anruf.abfragen' });
  assert.equal(alle(c, 'anruf.fehler').filter((f) => f.fehler.code === 'E_BREMSE').length, 1);
});

test('stoppen: keine Agent-Aufrufe mehr beim Trennen', async () => {
  const a = verbinden(anna);
  await schicken(a, { art: 'anruf.beitreten', raum: R });
  const vorher = agent.aufrufe.length;
  anrufe.stoppen();
  trennen(a);
  assert.equal(agent.aufrufe.length, vorher);
});
