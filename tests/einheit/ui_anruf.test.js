// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// WebRTC-Anruf im Browser (Plan 03, Aufgabe 11) mit Schein-RTCPeerConnection und Schein-Mediengeräten: Perfect
// Negotiation (höflich/unhöflich), Vollvermaschung (eine Verbindung je Teilnehmer), ICE-Neustart, Stummschalten,
// Rückfall ohne Kamera, Ende und Fehler.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { istHoeflich, angebotIgnorieren, abgleich, medienVorgaben, Anruf } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'chat', 'anruf.js')).href);
const ticks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

class ScheinSpur {
  constructor(kind) { this.kind = kind; this.enabled = true; this.gestoppt = false; this.hoerer = {}; }
  stop() { this.gestoppt = true; }
  addEventListener(art, fn) { this.hoerer[art] = fn; }
}
function scheinStrom(spuren) {
  return { spuren, getTracks: () => [...spuren], getAudioTracks: () => spuren.filter((s) => s.kind === 'audio'), getVideoTracks: () => spuren.filter((s) => s.kind === 'video'), addTrack(s) { spuren.push(s); }, removeTrack(s) { spuren.splice(spuren.indexOf(s), 1); } };
}
class ScheinPeer {
  static instanzen = [];
  constructor(konfig) {
    this.konfig = konfig; this.sender = []; this.signalingState = 'stable'; this.iceConnectionState = 'new';
    this.localDescription = null; this.remoteDescription = null; this.kandidaten = []; this.neustarts = 0; this.geschlossen = false;
    ScheinPeer.instanzen.push(this);
  }
  addTrack(spur) { const s = { track: spur, async replaceTrack(t) { this.track = t; } }; this.sender.push(s); return s; }
  getSenders() { return this.sender; }
  async setLocalDescription(d) {
    const type = (d && d.type) || (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
    this.localDescription = { type, sdp: `sdp-${type}`, toJSON() { return { type: this.type, sdp: this.sdp }; } };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(k) { this.kandidaten.push(k); }
  restartIce() { this.neustarts++; }
  close() { this.geschlossen = true; }
}
function scheinMedien(verweigern = () => false) {
  return {
    aufrufe: [],
    async getUserMedia(c) {
      this.aufrufe.push(c);
      if (verweigern(c)) throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      return scheinStrom([...(c.audio ? [new ScheinSpur('audio')] : []), ...(c.video ? [new ScheinSpur('video')] : [])]);
    },
    async getDisplayMedia() { return scheinStrom([new ScheinSpur('video')]); },
    async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'm1', label: 'Headset' }, { kind: 'videoinput', deviceId: 'k1', label: '' }, { kind: 'audiooutput', deviceId: 'l1', label: 'Lautsprecher' }]; },
  };
}
function scheinVerbindung() {
  const hoerer = new Map();
  return {
    gesendet: [],
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    senden(o) { this.gesendet.push(o); return true; },
    ausloesen(art, n) { for (const fn of [...(hoerer.get(art) || [])]) fn(n); },
    hoererAnzahl: () => [...hoerer.values()].reduce((s, x) => s + x.size, 0),
  };
}
const MEDIEN = { audio: true, video: false, bildschirm: false };
beforeEach(() => { ScheinPeer.instanzen = []; });

test('istHoeflich und angebotIgnorieren', () => {
  assert.equal(istHoeflich('pB', 'pA'), true); assert.equal(istHoeflich('pA', 'pB'), false);
  const f = (hoeflich, erstelltAngebot, signalZustand, typ) => angebotIgnorieren({ hoeflich, erstelltAngebot, signalZustand, typ });
  assert.equal(f(false, true, 'stable', 'offer'), true); assert.equal(f(true, true, 'stable', 'offer'), false);
  assert.equal(f(false, false, 'have-local-offer', 'offer'), true); assert.equal(f(false, false, 'stable', 'offer'), false);
  assert.equal(f(false, true, 'have-local-offer', 'answer'), false);
});

test('abgleich und medienVorgaben', () => {
  assert.deepEqual(abgleich(['p1', 'p2'], [{ id: 'p2' }, { id: 'p3' }, { id: 'pich' }], 'pich'), { neu: ['p3'], weg: ['p1'] });
  assert.deepEqual(medienVorgaben({ video: true }), { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  assert.deepEqual(medienVorgaben({ video: false, mikrofonId: 'm1' }), { audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'm1' } }, video: false });
  assert.deepEqual(medienVorgaben({ video: true, kameraId: 'k1' }).video.deviceId, { exact: 'k1' });
});

test('Ablauf: beitreten, je Teilnehmer eine Verbindung, Stand schließt, failed → restartIce, Stummschalten, verlassen', async () => {
  const v = scheinVerbindung(); const medien = scheinMedien();
  const anruf = new Anruf({ raum: 'R', verbindung: v, iceServer: [{ urls: ['stun:x:3478'] }], medien, PeerKlasse: ScheinPeer });
  assert.equal(await anruf.starten({ video: true }), true);
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.beitreten', raum: 'R', video: true });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pB', teilnehmer: [{ id: 'pA', name: 'Ben', gast: false, medien: MEDIEN, ich: false }] });
  assert.equal(anruf.eigeneId, 'pB');
  assert.equal(ScheinPeer.instanzen.length, 1);
  const pc = ScheinPeer.instanzen[0];
  assert.deepEqual(pc.konfig, { iceServers: [{ urls: ['stun:x:3478'] }] });
  assert.equal(pc.sender.length, 2);
  await pc.onnegotiationneeded();
  assert.deepEqual(v.gesendet.findLast((m) => m.art === 'anruf.signal'), { art: 'anruf.signal', raum: 'R', an: 'pA', daten: { beschreibung: { type: 'offer', sdp: 'sdp-offer' } } });
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pA', daten: { beschreibung: { type: 'answer', sdp: 'sdp-a' } } });
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pA', daten: { kandidat: { candidate: 'c1', sdpMid: '0' } } });
  await ticks();
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'sdp-a' });
  assert.deepEqual(pc.kandidaten, [{ candidate: 'c1', sdpMid: '0' }]);
  pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'c2' }) } });
  assert.deepEqual(v.gesendet.at(-1).daten, { kandidat: { candidate: 'c2' } });
  pc.iceConnectionState = 'failed'; pc.oniceconnectionstatechange();
  assert.equal(pc.neustarts, 1);
  const stroeme = []; anruf.on('strom', (s) => stroeme.push(s));
  const fremd = scheinStrom([new ScheinSpur('audio')]);
  pc.ontrack({ track: fremd.spuren[0], streams: [fremd] });
  assert.deepEqual(stroeme, [{ id: 'pA', strom: fremd }]); assert.equal(anruf.teilnehmer.get('pA').strom, fremd);
  anruf.mikrofon(false);
  assert.equal(anruf.lokalerStrom.getAudioTracks()[0].enabled, false);
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.medien', raum: 'R', audio: false, video: true, bildschirm: false });
  assert.deepEqual(anruf.medienStand, { audio: false, video: true, bildschirm: false });
  const teilnehmerEv = []; anruf.on('teilnehmer', (m) => teilnehmerEv.push([...m.keys()]));
  v.ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'pB', name: 'Anna', gast: false, medien: MEDIEN, ich: true }], beginn: 'x' });
  assert.equal(pc.geschlossen, true); assert.deepEqual(teilnehmerEv.at(-1), []);
  const vorher = v.gesendet.length;
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'X', von: 'pA', daten: { kandidat: null } });
  await ticks();
  assert.equal(ScheinPeer.instanzen.length, 1); assert.equal(v.gesendet.length, vorher);
  const spuren = anruf.lokalerStrom.getTracks();
  const enden = []; anruf.on('ende', (e) => enden.push(e));
  anruf.verlassen();
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.verlassen', raum: 'R' });
  assert.ok(spuren.every((s) => s.gestoppt));
  assert.deepEqual(enden, [{ grund: 'verlassen' }]);
  assert.equal(v.hoererAnzahl(), 0, 'keine Hörer mehr an der Verbindung');
});

test('eigenerName kommt aus dem Stand (ich: true) – für die eigene Kachel (Bedienprobe 0.21.1)', async () => {
  const v = scheinVerbindung();
  const anruf = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
  await anruf.starten({ video: false });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pA', teilnehmer: [] });
  assert.equal(anruf.eigenerName, '');
  v.ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'pA', name: 'Anna', gast: false, medien: MEDIEN, ich: true }], beginn: 'x' });
  assert.equal(anruf.eigenerName, 'Anna');
  assert.equal(anruf.eigenerNutzer, '', 'ohne Login-Namen (Gast-Sicht) kein Bild');
  assert.equal(anruf.teilnehmer.size, 0, 'die eigene Person bleibt aus der Liste der anderen');
  v.ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'pA', name: 'Anna', nutzer: 'anna', gast: false, medien: MEDIEN, ich: true }, { id: 'pC', name: 'Cara', nutzer: 'cara', gast: false, medien: MEDIEN, ich: false }], beginn: 'x' });
  assert.equal(anruf.eigenerNutzer, 'anna', 'Login-Name fürs eigene Avatar-Bild (0.22.0)');
  assert.equal(anruf.teilnehmer.get('pC').nutzer, 'cara');
  anruf.verlassen();
});

test('Bestehende Teilnehmer: Angebot einer bekannten ID → Verbindung + Antwort; unbekannte ID verworfen; Kollision (unhöflich) ignoriert', async () => {
  const v = scheinVerbindung();
  const anruf = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
  await anruf.starten({ video: false });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pA', teilnehmer: [] });
  assert.equal(ScheinPeer.instanzen.length, 0);
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pZ', daten: { beschreibung: { type: 'offer', sdp: 'x' } } });
  await ticks();
  assert.equal(ScheinPeer.instanzen.length, 0, 'unbekannte ID');
  v.ausloesen('anruf.stand', { art: 'anruf.stand', raum: 'R', teilnehmer: [{ id: 'pA', name: 'Anna', gast: false, medien: MEDIEN, ich: true }, { id: 'pC', name: 'Cara', gast: false, medien: MEDIEN, ich: false }], beginn: 'x' });
  assert.equal(ScheinPeer.instanzen.length, 0, 'der Neue verbindet sich selbst');
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pC', daten: { beschreibung: { type: 'offer', sdp: 'angebot' } } });
  await ticks();
  const pc = ScheinPeer.instanzen[0];
  assert.equal(pc.sender.length, 1, 'eigene Spuren hinzugefügt');
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'angebot' });
  assert.deepEqual(v.gesendet.findLast((m) => m.art === 'anruf.signal'), { art: 'anruf.signal', raum: 'R', an: 'pC', daten: { beschreibung: { type: 'answer', sdp: 'sdp-answer' } } });
  // pA < pC → pA ist unhöflich: ein kollidierendes Angebot wird ignoriert, Kandidaten-Fehler danach ebenso
  pc.signalingState = 'have-local-offer';
  pc.addIceCandidate = async () => { throw new Error('kaputt'); };
  const fehler = []; anruf.on('fehler', (f) => fehler.push(f));
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pC', daten: { beschreibung: { type: 'offer', sdp: 'kollision' } } });
  v.ausloesen('anruf.signal', { art: 'anruf.signal', raum: 'R', von: 'pC', daten: { kandidat: { candidate: 'zu-kollision' } } });
  await ticks();
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'angebot' }, 'Kollision ignoriert');
  assert.deepEqual(fehler, [], 'Kandidaten-Fehler zum ignorierten Angebot bleibt still');
  anruf.verlassen();
});

test('getUserMedia verweigert: Video fällt auf Audio zurück, ohne Mikrofon Fehler kein_zugriff', async () => {
  const v = scheinVerbindung(); const medien = scheinMedien((c) => !!c.video);
  const anruf = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien, PeerKlasse: ScheinPeer });
  assert.equal(await anruf.starten({ video: true }), true);
  assert.equal(medien.aufrufe.length, 2); assert.equal(medien.aufrufe[1].video, false);
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.beitreten', raum: 'R', video: false });
  assert.deepEqual(anruf.medienStand, { audio: true, video: false, bildschirm: false });
  anruf.verlassen();
  const v2 = scheinVerbindung();
  const ohne = new Anruf({ raum: 'R', verbindung: v2, iceServer: [], medien: scheinMedien(() => true), PeerKlasse: ScheinPeer });
  const fehler = []; ohne.on('fehler', (f) => fehler.push(f));
  assert.equal(await ohne.starten({ video: false }), false);
  assert.equal(fehler[0].code, 'kein_zugriff');
  assert.deepEqual(v2.gesendet, [], 'kein Beitritt');
});

test('anruf.ende ersetzt / anruf.fehler E_BELEGT → Ereignis ende mit grund, alles geschlossen', async () => {
  const v = scheinVerbindung();
  const a = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
  await a.starten({ video: true });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pB', teilnehmer: [{ id: 'pA', name: 'Ben', gast: false, medien: MEDIEN, ich: false }] });
  const enden = []; a.on('ende', (e) => enden.push(e));
  const spuren = a.lokalerStrom.getTracks();
  v.ausloesen('anruf.ende', { art: 'anruf.ende', raum: 'R', grund: 'ersetzt' });
  assert.deepEqual(enden, [{ grund: 'ersetzt' }]);
  assert.equal(ScheinPeer.instanzen[0].geschlossen, true); assert.ok(spuren.every((s) => s.gestoppt));
  assert.equal(v.gesendet.filter((m) => m.art === 'anruf.verlassen').length, 0, 'der Server hat schon beendet');
  const v2 = scheinVerbindung();
  const b = new Anruf({ raum: 'R', verbindung: v2, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
  await b.starten({ video: false });
  const enden2 = []; b.on('ende', (e) => enden2.push(e));
  v2.ausloesen('anruf.fehler', { art: 'anruf.fehler', raum: 'R', fehler: { code: 'E_BELEGT', meldung: 'Anruf ist voll (höchstens 6)' } });
  assert.deepEqual(enden2, [{ grund: 'voll' }]);
  assert.ok(b.lokalerStrom === null || b.lokalerStrom.getTracks().every((s) => s.gestoppt));
});

test('Auflegen während der Gerätefreigabe: kein Beitritt, Spuren gestoppt (Prüfbericht Plan 03, I3)', async () => {
  const v = scheinVerbindung();
  let freigeben;
  const medien = scheinMedien();
  const echt = medien.getUserMedia.bind(medien);
  medien.getUserMedia = (c) => new Promise((ok) => { freigeben = () => ok(echt(c)); });
  const a = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien, PeerKlasse: ScheinPeer });
  const lauf = a.starten({ video: true });
  await ticks();
  a.verlassen();
  freigeben();
  assert.equal(await lauf, false);
  assert.equal(v.gesendet.filter((m) => m.art === 'anruf.beitreten').length, 0, 'kein Beitritt');
  assert.equal(a.lokalerStrom, null);
  assert.equal(v.hoererAnzahl(), 0, 'keine Hörer');
});

test('Fehler vor dem Beitritt (E_AGENT, E_PARAMS, E_NICHT_GEFUNDEN) beenden mit passendem Grund und stoppen das Mikrofon (Prüfbericht Plan 03, M2)', async () => {
  for (const [code, grund] of [['E_AGENT', 'fehler'], ['E_PARAMS', 'fehler'], ['E_NICHT_GEFUNDEN', 'kein_raum'], ['E_RECHTE', 'kein_raum'], ['E_BELEGT', 'voll']]) {
    const v = scheinVerbindung();
    const a = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
    await a.starten({ video: false });
    const spuren = a.lokalerStrom.getTracks();
    const enden = []; a.on('ende', (e) => enden.push(e));
    v.ausloesen('anruf.fehler', { art: 'anruf.fehler', raum: 'R', fehler: { code, meldung: 'x' } });
    assert.deepEqual(enden, [{ grund }], code);
    assert.ok(spuren.every((s) => s.gestoppt), code);
  }
  // nach dem Beitritt beendet ein Fehler (z. B. ein abgewiesenes Signal) den Anruf nicht
  const v = scheinVerbindung();
  const a = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien: scheinMedien(), PeerKlasse: ScheinPeer });
  await a.starten({ video: false });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pB', teilnehmer: [] });
  const enden = []; a.on('ende', (e) => enden.push(e));
  v.ausloesen('anruf.fehler', { art: 'anruf.fehler', raum: 'R', fehler: { code: 'E_PARAMS', meldung: 'x' } });
  assert.deepEqual(enden, []);
});

test('Bildschirm teilen ersetzt die Video-Spur und gibt sie zurück; Kamera einschalten ohne Spur holt eine', async () => {
  const v = scheinVerbindung(); const medien = scheinMedien();
  const a = new Anruf({ raum: 'R', verbindung: v, iceServer: [], medien, PeerKlasse: ScheinPeer });
  await a.starten({ video: false });
  v.ausloesen('anruf.beigetreten', { art: 'anruf.beigetreten', raum: 'R', id: 'pB', teilnehmer: [{ id: 'pA', name: 'Ben', gast: false, medien: MEDIEN, ich: false }] });
  const pc = ScheinPeer.instanzen[0];
  assert.equal(pc.sender.length, 1);
  await a.kamera(true);
  assert.equal(pc.sender.length, 2, 'Kamera-Spur hinzugefügt');
  const kamera = pc.sender[1].track;
  assert.deepEqual(v.gesendet.at(-1), { art: 'anruf.medien', raum: 'R', audio: true, video: true, bildschirm: false });
  await a.bildschirm(true);
  const schirm = pc.sender[1].track;
  assert.notEqual(schirm, kamera); assert.equal(pc.sender.length, 2, 'ersetzt statt hinzugefügt');
  assert.equal(v.gesendet.at(-1).bildschirm, true);
  schirm.hoerer.ended();
  await ticks();
  assert.equal(pc.sender[1].track, kamera, 'Kamera zurück');
  assert.equal(schirm.gestoppt, true);
  assert.equal(v.gesendet.at(-1).bildschirm, false);
  assert.deepEqual(await Anruf.geraete(medien), { mikrofone: [{ id: 'm1', name: 'Headset' }], kameras: [{ id: 'k1', name: 'Kamera 1' }] });
  a.verlassen();
});
