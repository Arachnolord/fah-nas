// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ein Anruf im Browser (Plan 03): WebRTC zwischen allen Teilnehmenden (Vollvermaschung, höchstens 6), ausgehandelt nach
// „Perfect Negotiation“ – wer die größere Teilnehmer-ID hat, ist höflich und gibt bei gleichzeitigen Angeboten nach.
// Die Signale laufen über die Chat-Verbindung (anruf.*). Mikrofon, Kamera, Bildschirm teilen, Gerätewahl; scheitert
// eine Verbindung (ICE „failed“), startet ICE neu. Kein Import aus app.js – die Gastseite nutzt dieselbe Klasse.

/** Höflich ist, wer die größere ID hat (bei Kollisionen nachgeben). */
export function istHoeflich(eigeneId, fremdeId) { return String(eigeneId) > String(fremdeId); }

/** Ein eintreffendes Angebot ignorieren? Nur der Unhöfliche ignoriert, und nur bei einer Kollision. */
export function angebotIgnorieren({ hoeflich, erstelltAngebot, signalZustand, typ }) {
  const kollision = typ === 'offer' && (erstelltAngebot || signalZustand !== 'stable');
  return !hoeflich && kollision;
}

/** Welche Gegenstellen kommen hinzu, welche fallen weg (ohne die eigene ID)? */
export function abgleich(bekannte, teilnehmer, eigeneId) {
  const soll = new Set((teilnehmer || []).map((t) => t.id).filter((id) => id !== eigeneId));
  const ist = new Set(bekannte);
  return { neu: [...soll].filter((id) => !ist.has(id)), weg: [...ist].filter((id) => !soll.has(id)) };
}

/** getUserMedia-Vorgaben: Echo- und Rauschunterdrückung, Video 1280×720 (ideal), optional feste Geräte. */
export function medienVorgaben({ video, mikrofonId = null, kameraId = null }) {
  const audio = { echoCancellation: true, noiseSuppression: true, ...(mikrofonId ? { deviceId: { exact: mikrofonId } } : {}) };
  return { audio, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, ...(kameraId ? { deviceId: { exact: kameraId } } : {}) } : false };
}

const beschreibungJson = (d) => (d && typeof d.toJSON === 'function' ? d.toJSON() : { type: d.type, sdp: d.sdp });
const kandidatJson = (k) => (k ? (typeof k.toJSON === 'function' ? k.toJSON() : k) : null);
/** Fehler vor dem Beitritt → Grund für 'ende' (kein_raum statt des Mikrofon-Texts; alles andere „fehler“). */
const GRUND_FEHLER = Object.freeze({ E_BELEGT: 'voll', E_NICHT_GEFUNDEN: 'kein_raum', E_RECHTE: 'kein_raum' });

export class Anruf {
  constructor({ raum, verbindung, iceServer, medien = globalThis.navigator?.mediaDevices, PeerKlasse = globalThis.RTCPeerConnection }) {
    this.raum = raum; this.verbindung = verbindung; this.iceServer = iceServer || []; this.medien = medien; this.PeerKlasse = PeerKlasse;
    this._id = null; this._teilnehmer = new Map(); this._gegen = new Map(); this._hoerer = new Map(); this._ab = [];
    this._eigenerName = ''; // so, wie die anderen mich sehen (aus dem Stand, Eintrag mit ich: true)
    this._eigenerNutzer = ''; // eigener Login-Name fürs Avatar-Bild (nur Mitglieder bekommen ihn, 0.22.0)
    this._strom = null; this._kameraSpur = null; this._bildschirmSpur = null; this._aktiv = false; this._abgebrochen = false;
    this._stand = { audio: true, video: false, bildschirm: false }; this._geraete = { mikrofonId: null, kameraId: null };
  }

  get eigeneId() { return this._id; }
  get eigenerName() { return this._eigenerName; }
  get eigenerNutzer() { return this._eigenerNutzer; }
  get teilnehmer() { return this._teilnehmer; }
  get lokalerStrom() { return this._strom; }
  get medienStand() { return { ...this._stand }; }

  on(art, fn) {
    if (!this._hoerer.has(art)) this._hoerer.set(art, new Set());
    this._hoerer.get(art).add(fn);
    return () => { this._hoerer.get(art)?.delete(fn); };
  }

  _melden(art, daten) { for (const fn of [...(this._hoerer.get(art) || [])]) { try { fn(daten); } catch (e) { console.error(e); } } }

  /** Mikrofon (und Kamera) holen, dann beitreten. Ohne Mikrofon → Ereignis fehler {code:'kein_zugriff'}, false. */
  async starten({ video = false } = {}) {
    let strom = null; let mitVideo = !!video;
    try { strom = await this.medien.getUserMedia(medienVorgaben({ video: mitVideo, ...this._geraete })); } catch {
      if (mitVideo) { mitVideo = false; try { strom = await this.medien.getUserMedia(medienVorgaben({ video: false, ...this._geraete })); } catch { strom = null; } }
    }
    // Während der Gerätefreigabe aufgelegt (Raumwechsel, Abmelden …): nichts senden, Geräte gleich wieder freigeben (Prüfbericht Plan 03, I3)
    if (this._abgebrochen) { if (strom) for (const s of strom.getTracks()) s.stop(); return false; }
    if (!strom) { this._melden('fehler', { code: 'kein_zugriff', meldung: 'Kein Zugriff auf das Mikrofon' }); return false; }
    this._strom = strom;
    this._kameraSpur = strom.getVideoTracks()[0] || null;
    this._stand = { audio: true, video: !!this._kameraSpur, bildschirm: false };
    this._melden('lokal', strom);
    const fuer = (fn) => (n) => { if (n && n.raum === this.raum) fn(n); };
    this._ab.push(
      this.verbindung.on('anruf.beigetreten', fuer((n) => this._beigetreten(n))),
      this.verbindung.on('anruf.stand', fuer((n) => this._standNeu(n))),
      this.verbindung.on('anruf.signal', fuer((n) => this._signalEingang(n))),
      this.verbindung.on('anruf.ende', fuer((n) => this._beenden(n.grund || 'ende'))),
      this.verbindung.on('anruf.abgelehnt', fuer((n) => this._melden('abgelehnt', { von_name: n.von_name }))),
      this.verbindung.on('anruf.fehler', fuer((n) => this._fehlerEingang(n))),
      this.verbindung.on('wieder', () => this._neuBeitreten()),
    );
    this._aktiv = true;
    this.verbindung.senden({ art: 'anruf.beitreten', raum: this.raum, video: this._stand.video });
    return true;
  }

  /** Auflegen: Server informieren, alles schließen. */
  verlassen() {
    if (!this._aktiv) { this._abgebrochen = true; return; } // noch in getUserMedia: starten() bricht danach ab
    this.verbindung.senden({ art: 'anruf.verlassen', raum: this.raum });
    this._beenden('verlassen');
  }

  mikrofon(an) {
    if (!this._strom) return;
    for (const s of this._strom.getAudioTracks()) s.enabled = !!an;
    this._stand.audio = !!an;
    this._medienSenden();
  }

  async kamera(an) {
    if (!this._strom) return;
    if (this._kameraSpur) {
      this._kameraSpur.enabled = !!an;
    } else if (an) {
      const s = await this.medien.getUserMedia({ video: medienVorgaben({ video: true, ...this._geraete }).video });
      this._kameraSpur = s.getVideoTracks()[0] || null;
      if (!this._kameraSpur) return;
      this._strom.addTrack(this._kameraSpur);
      if (!this._bildschirmSpur) for (const g of this._gegen.values()) await this._videoSetzen(g, this._kameraSpur);
    }
    this._stand.video = !!an && !!this._kameraSpur;
    this._medienSenden();
  }

  async bildschirm(an) {
    if (!this._strom) return;
    if (an) {
      if (this._bildschirmSpur) return;
      const s = await this.medien.getDisplayMedia({ video: true });
      const spur = s.getVideoTracks()[0];
      if (!spur) return;
      this._bildschirmSpur = spur;
      spur.addEventListener('ended', () => { this.bildschirm(false); });
      for (const g of this._gegen.values()) await this._videoSetzen(g, spur);
      this._stand.bildschirm = true;
    } else {
      const spur = this._bildschirmSpur;
      if (!spur) return;
      this._bildschirmSpur = null;
      spur.stop();
      for (const g of this._gegen.values()) await this._videoSetzen(g, this._kameraSpur || null);
      this._stand.bildschirm = false;
    }
    this._melden('lokal', this._strom);
    this._medienSenden();
  }

  /** Mikrofon und/oder Kamera wechseln (laufende Spuren werden ersetzt). */
  async geraetWechseln({ mikrofonId, kameraId }) {
    if (mikrofonId !== undefined) this._geraete.mikrofonId = mikrofonId || null;
    if (kameraId !== undefined) this._geraete.kameraId = kameraId || null;
    if (!this._strom) return;
    if (mikrofonId) {
      const s = await this.medien.getUserMedia({ audio: medienVorgaben({ video: false, ...this._geraete }).audio });
      const neu = s.getAudioTracks()[0]; const alt = this._strom.getAudioTracks()[0];
      if (neu) {
        neu.enabled = this._stand.audio;
        for (const g of this._gegen.values()) { const sender = g.pc.getSenders().find((x) => x.track === alt); if (sender) await sender.replaceTrack(neu); }
        if (alt) { this._strom.removeTrack?.(alt); alt.stop(); }
        this._strom.addTrack(neu);
      }
    }
    if (kameraId && this._kameraSpur) {
      const s = await this.medien.getUserMedia({ video: medienVorgaben({ video: true, ...this._geraete }).video });
      const neu = s.getVideoTracks()[0]; const alt = this._kameraSpur;
      if (neu) {
        neu.enabled = alt.enabled;
        this._kameraSpur = neu;
        if (!this._bildschirmSpur) for (const g of this._gegen.values()) await this._videoSetzen(g, neu);
        this._strom.removeTrack?.(alt); alt.stop();
        this._strom.addTrack(neu);
      }
    }
    this._melden('lokal', this._strom);
  }

  /** Mikrofone und Kameras des Geräts (ohne Namen → „Mikrofon n“/„Kamera n“). */
  static async geraete(medien = globalThis.navigator?.mediaDevices) {
    const liste = medien && typeof medien.enumerateDevices === 'function' ? await medien.enumerateDevices() : [];
    const art = (kind, wort) => liste.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, name: d.label || `${wort} ${i + 1}` }));
    return { mikrofone: art('audioinput', 'Mikrofon'), kameras: art('videoinput', 'Kamera') };
  }

  // ---- intern ---------------------------------------------------------------------------------------------------------

  _medienSenden() { this.verbindung.senden({ art: 'anruf.medien', raum: this.raum, ...this._stand }); }

  _spuren() {
    const s = [...this._strom.getAudioTracks()];
    const video = this._bildschirmSpur || this._kameraSpur;
    if (video) s.push(video);
    return s;
  }

  async _videoSetzen(g, spur) {
    if (g.videoSender) { await g.videoSender.replaceTrack(spur); return; }
    if (spur) g.videoSender = g.pc.addTrack(spur, this._strom);
  }

  _signal(id, daten) { this.verbindung.senden({ art: 'anruf.signal', raum: this.raum, an: id, daten }); }

  _gegenstelle(id) {
    let g = this._gegen.get(id);
    if (g) return g;
    const pc = new this.PeerKlasse({ iceServers: this.iceServer });
    g = { pc, erstelltAngebot: false, ignoriert: false, kette: Promise.resolve(), videoSender: null };
    this._gegen.set(id, g);
    for (const spur of this._spuren()) {
      const sender = pc.addTrack(spur, this._strom);
      if (spur.kind === 'video') g.videoSender = sender;
    }
    pc.onnegotiationneeded = async () => {
      try {
        g.erstelltAngebot = true;
        await pc.setLocalDescription();
        this._signal(id, { beschreibung: beschreibungJson(pc.localDescription) });
      } catch (e) { this._melden('fehler', { code: 'webrtc', meldung: e.message }); } finally { g.erstelltAngebot = false; }
    };
    pc.onicecandidate = ({ candidate }) => this._signal(id, { kandidat: kandidatJson(candidate) });
    pc.ontrack = (e) => {
      const strom = (e.streams && e.streams[0]) || (typeof MediaStream === 'function' ? new MediaStream([e.track]) : null);
      const t = this._teilnehmer.get(id);
      if (t) t.strom = strom;
      this._melden('strom', { id, strom });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
      const t = this._teilnehmer.get(id);
      if (t) t.verbindung = pc.iceConnectionState;
      this._melden('zustand', { id, zustand: pc.iceConnectionState });
    };
    return g;
  }

  async _signalVerarbeiten(id, { beschreibung, kandidat }) {
    const g = this._gegen.get(id);
    if (!g) return;
    const pc = g.pc;
    if (beschreibung) {
      g.ignoriert = angebotIgnorieren({ hoeflich: istHoeflich(this._id, id), erstelltAngebot: g.erstelltAngebot, signalZustand: pc.signalingState, typ: beschreibung.type });
      if (g.ignoriert) return;
      await pc.setRemoteDescription(beschreibung); // höflich: implizites Rollback des eigenen Angebots
      if (beschreibung.type === 'offer') {
        await pc.setLocalDescription();
        this._signal(id, { beschreibung: beschreibungJson(pc.localDescription) });
      }
    }
    if (kandidat !== undefined) {
      try { await pc.addIceCandidate(kandidat ?? undefined); } catch (e) { if (!g.ignoriert) throw e; }
    }
  }

  _teilnehmerSetzen(liste) {
    const neu = new Map();
    for (const t of liste || []) {
      if (t.id === this._id || t.ich) {
        if (typeof t.name === 'string' && t.name) this._eigenerName = t.name;
        if (typeof t.nutzer === 'string') this._eigenerNutzer = t.nutzer;
        continue;
      }
      const alt = this._teilnehmer.get(t.id);
      neu.set(t.id, { id: t.id, name: t.name, nutzer: typeof t.nutzer === 'string' ? t.nutzer : '', gast: !!t.gast, medien: t.medien || {}, strom: alt ? alt.strom : null, verbindung: alt ? alt.verbindung : 'neu' });
    }
    this._teilnehmer = neu;
    this._melden('teilnehmer', this._teilnehmer);
  }

  _beigetreten(n) {
    this._id = n.id;
    this._teilnehmerSetzen(n.teilnehmer);
    for (const id of this._teilnehmer.keys()) this._gegenstelle(id); // der Neue verbindet sich mit allen
  }

  _standNeu(n) {
    if (!this._id) return;
    const { weg } = abgleich(this._gegen.keys(), n.teilnehmer, this._id);
    for (const id of weg) { const g = this._gegen.get(id); this._gegen.delete(id); try { g.pc.close(); } catch { /* zu */ } }
    this._teilnehmerSetzen(n.teilnehmer);
  }

  _signalEingang(n) {
    if (!this._id || typeof n.von !== 'string' || !n.daten) return;
    if (!this._gegen.has(n.von)) {
      if (!this._teilnehmer.has(n.von)) return; // nicht im letzten Stand: verwerfen
      this._gegenstelle(n.von);
    }
    const g = this._gegen.get(n.von);
    g.kette = g.kette.then(() => this._signalVerarbeiten(n.von, n.daten)).catch((e) => this._melden('fehler', { code: 'webrtc', meldung: e && e.message }));
  }

  _fehlerEingang(n) {
    const code = n.fehler && n.fehler.code;
    this._melden('fehler', { code, meldung: n.fehler && n.fehler.meldung });
    // Vor dem Beitritt beendet jeder Fehler den Versuch (sonst hinge die Ebene mit offenem Mikrofon; Prüfbericht Plan 03, M2)
    if (!this._id) this._beenden(GRUND_FEHLER[code] || 'fehler');
  }

  /** Nach dem Wiederverbinden der Chat-Verbindung: Verbindungen neu aufbauen (Server kennt den alten Stand nicht mehr). */
  _neuBeitreten() {
    if (!this._aktiv) return;
    for (const g of this._gegen.values()) { try { g.pc.close(); } catch { /* zu */ } }
    this._gegen.clear(); this._teilnehmer = new Map(); this._id = null; this._eigenerName = ''; this._eigenerNutzer = '';
    this._melden('teilnehmer', this._teilnehmer);
    this.verbindung.senden({ art: 'anruf.beitreten', raum: this.raum, video: this._stand.video });
  }

  _beenden(grund) {
    if (!this._aktiv && !this._strom) return;
    this._aktiv = false;
    for (const ab of this._ab.splice(0)) { try { ab(); } catch { /* egal */ } }
    for (const g of this._gegen.values()) { try { g.pc.close(); } catch { /* zu */ } }
    this._gegen.clear();
    if (this._strom) for (const s of this._strom.getTracks()) s.stop();
    if (this._kameraSpur) this._kameraSpur.stop();
    if (this._bildschirmSpur) { this._bildschirmSpur.stop(); this._bildschirmSpur = null; }
    this._strom = null; this._kameraSpur = null;
    this._melden('ende', { grund });
  }
}
