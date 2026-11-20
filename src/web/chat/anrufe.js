// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anruf-Signalisierung im Web-Dienst (Plan 03): Die Medien laufen Browser-zu-Browser (WebRTC); hier laufen nur die
// anruf.*-Nachrichten über den Chat-WebSocket – Beitreten, Verlassen, SDP/ICE weiterreichen (nur zwischen
// Teilnehmenden), Medienstand, Klingeln/Ablehnen in Direktnachrichten. Anrufe stehen nur im Speicher; Beginn, Ende und
// Verpasst meldet der Dienst dem Agenten (Notiz im Verlauf, Handy-Meldung). Höchstens 6 Teilnehmende je Anruf.

import crypto from 'node:crypto';
import { gastKontext } from '../api/anmelden.js';
import { gastSichtName } from './identitaet.js';

export const MAX_TEILNEHMER = 6;
/** Bremse gegen Notiz-/Meldungsflut: höchstens 3 neue Anrufe je Identität und Raum in 60 s; allein unter 10 s keine Notiz. */
export const NEU_JE_MINUTE = 3;
export const KURZ_ALLEIN_S = 10;
export const KLINGEL_MS = 45_000;
export const TEILNEHMER_MUSTER = /^p[A-Za-z0-9_-]{12}$/;
export const SIGNAL_MAX = 65_536;
const SDP_MAX = 60_000;
const RAUM = /^(r[A-Za-z0-9_-]{16}|d[A-Za-z0-9_-]{20})$/;
const BREMSE = Object.freeze({ anzahl: 200, fenster_ms: 10_000 });
const STANDARD_UHR = Object.freeze({ setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) });

const schluesselVon = (id) => (id.art === 'gast' ? `g:${id.gast}` : `n:${id.nutzer}`);
const nameVon = (id) => (id.art === 'gast' ? id.name : (id.anzeigename ?? id.nutzer));

/** Signal-Daten prüfen und auf die erlaubte Form bringen (beschreibung und/oder kandidat) – sonst null. */
function signalDaten(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const schluessel = Object.keys(d);
  if (!schluessel.length || schluessel.some((k) => k !== 'beschreibung' && k !== 'kandidat')) return null;
  const aus = {};
  if ('beschreibung' in d) {
    const b = d.beschreibung;
    if (!b || typeof b !== 'object' || !['offer', 'answer'].includes(b.type) || typeof b.sdp !== 'string' || b.sdp.length > SDP_MAX) return null;
    aus.beschreibung = { type: b.type, sdp: b.sdp };
  }
  if ('kandidat' in d) {
    const k = d.kandidat;
    if (k !== null && (typeof k !== 'object' || Array.isArray(k))) return null;
    aus.kandidat = k;
  }
  return JSON.stringify(aus).length <= SIGNAL_MAX ? aus : null;
}

export class Anrufe {
  constructor({ chat, agent, uhr = STANDARD_UHR, jetzt = () => Date.now(), protokoll = null }) {
    this.chat = chat; this.agent = agent; this.uhr = uhr; this.jetzt = jetzt; this.protokoll = protokoll;
    this.anrufe = new Map(); // raum → Anruf
    this.bremsen = new Map(); // Verbindung → {zeiten, gemeldet}
    this.getrennt = new WeakSet(); // Verbindungen, die schon zu sind (Beitritt nach dem Agent-Rundweg verwerfen)
    this.neueAnrufe = new Map(); // '<schluessel>|<raum>' → Zeitpunkte neu begonnener Anrufe (Bremse gegen Notiz-/Meldungsflut)
    this.gestoppt = false;
    this._ab = [];
    this._beiEreignis = (e) => this._ereignis(e);
  }

  einhaengen() {
    const h = (art, fn) => this.chat.handler(art, (v, n) => (this._gebremst(v, n) ? undefined : fn(v, n || {})));
    h('anruf.beitreten', (v, n) => this.beitreten(v, n));
    h('anruf.verlassen', (v, n) => this.verlassen(v, n));
    h('anruf.signal', (v, n) => this.signal(v, n));
    h('anruf.medien', (v, n) => this.medien(v, n));
    h('anruf.ablehnen', (v, n) => this.ablehnen(v, n));
    h('anruf.abfragen', (v) => this.abfragen(v));
    this._ab.push(this.chat.beiTrennung((v) => this.trennen(v)));
    this.agent.on('ereignis', this._beiEreignis);
  }

  stoppen() {
    this.gestoppt = true;
    for (const a of this.anrufe.values()) if (a.klingelTimer) { this.uhr.clearTimeout(a.klingelTimer); a.klingelTimer = null; }
    this.agent.off?.('ereignis', this._beiEreignis);
  }

  /** Laufender Anruf eines Raums (öffentliche Form) oder null. */
  laufend(raum) {
    const a = this.anrufe.get(raum);
    if (!a) return null;
    return { raum, beginn: new Date(a.beginn).toISOString(), teilnehmer: [...a.teilnehmer.values()].map((t) => this._oeffentlich(t, null)) };
  }

  // ---- Hilfen ----------------------------------------------------------------------------------------------------

  _gebremst(v, n) {
    const jetzt = this.jetzt();
    let b = this.bremsen.get(v);
    if (!b) { b = { zeiten: [], gemeldet: false }; this.bremsen.set(v, b); }
    b.zeiten = b.zeiten.filter((t) => jetzt - t < BREMSE.fenster_ms);
    if (b.zeiten.length >= BREMSE.anzahl) {
      if (!b.gemeldet) { b.gemeldet = true; this._fehler(v, n && n.raum, 'E_BREMSE', 'Zu viele Anruf-Nachrichten – bitte kurz warten'); }
      return true;
    }
    b.gemeldet = false;
    b.zeiten.push(jetzt);
    return false;
  }

  _fehler(v, raum, code, meldung) {
    v.ws.senden({ art: 'anruf.fehler', raum: typeof raum === 'string' ? raum : null, fehler: { code, meldung } });
  }

  _oeffentlich(t, fuer) {
    // Gäste (Schlüssel „g:…“) sehen NAS-Mitglieder ohne Anzeigenamen als „Mitglied“, nie mit Login-Namen. Mitglieder
    // bekommen für Mitglieder den Login-Namen dazu – daran hängt das Avatar-Bild der Kachel (0.22.0).
    const fuerGast = typeof fuer === 'string' && fuer.startsWith('g:');
    const o = { id: t.id, name: fuerGast ? t.gastname : t.name, gast: t.gast, medien: { ...t.medien }, ich: t.schluessel === fuer };
    if (!fuerGast && !t.gast && t.identitaet && typeof t.identitaet.nutzer === 'string') o.nutzer = t.identitaet.nutzer;
    return o;
  }

  _verbindungen(a) {
    const vs = [];
    for (const n of a.empfaenger.nutzer) vs.push(...this.chat.verteiler.fuerNutzer(n));
    for (const g of a.empfaenger.gaeste) vs.push(...this.chat.verteiler.fuerGast(g));
    return vs;
  }

  _standAn(v, a, beendet = false) {
    const fuer = schluesselVon(v.identitaet);
    v.ws.senden({
      art: 'anruf.stand', raum: a.raum,
      teilnehmer: beendet ? [] : [...a.teilnehmer.values()].map((t) => this._oeffentlich(t, fuer)),
      beginn: beendet ? null : new Date(a.beginn).toISOString(),
    });
  }

  _standAnAlle(a, beendet = false) { for (const v of this._verbindungen(a)) this._standAn(v, a, beendet); }

  /** Meldung an den Agenten (Beginn/Ende/Verpasst) – Fehler landen im Protokoll, nie beim Aufrufer. */
  _agent(a, identitaet, p) {
    if (this.gestoppt) return;
    const gast = identitaet.art === 'gast';
    const params = { ...(gast ? { ausweis: identitaet.ausweis } : {}), raum: a.raum, ...p };
    const kontext = gast ? gastKontext('-') : { nutzer: identitaet.nutzer, rolle: identitaet.rolle, ip: '-' };
    try {
      Promise.resolve(this.agent.aktion(gast ? 'chat.gast.anruf' : 'chat.anruf', params, kontext))
        .catch((e) => this.protokoll?.eintrag?.('anruf', { fehler: (e && (e.code || e.message)) || 'unbekannt' }));
    } catch (e) { this.protokoll?.eintrag?.('anruf', { fehler: (e && (e.code || e.message)) || 'unbekannt' }); }
  }

  /** Teilnahme entfernen; war es die letzte, endet der Anruf. */
  _entfernen(a, t, wer) {
    a.teilnehmer.delete(t.id);
    a.letzter = wer;
    if (!a.teilnehmer.size) this._ende(a, wer); else this._standAnAlle(a);
  }

  _ende(a, wer) {
    if (this.anrufe.get(a.raum) !== a) return;
    if (a.klingelTimer) { this.uhr.clearTimeout(a.klingelTimer); a.klingelTimer = null; }
    this.anrufe.delete(a.raum);
    if (a.dm && !a.angenommen) {
      if (a.abgelehnt) this._agent(a, a.starter, { art: 'ende', video: a.video, dauer_s: 0 });
      else this._agent(a, a.starter, { art: 'verpasst', video: a.video, aktiv: [] }); // verpasst immer melden (nur „stumm“ zählt)
    } else {
      const dauer = Math.max(0, Math.round((this.jetzt() - a.beginn) / 1000));
      // Allein und kürzer als 10 s: keine Notiz – sonst ergäbe jedes Beitreten+Verlassen eine Systemzeile (Prüfbericht Plan 03, I5)
      if (a.mitAnderen || a.dm || dauer >= KURZ_ALLEIN_S) this._agent(a, wer, { art: 'ende', video: a.video, dauer_s: dauer });
    }
    this._standAnAlle(a, true);
  }

  _teilnahmeVon(a, v) { return [...a.teilnehmer.values()].find((t) => t.v === v) || null; }

  /** Höchstens NEU_JE_MINUTE neue Anrufe je Identität und Raum in 60 s. */
  _neuGebremst(schl, raum) {
    const k = `${schl}|${raum}`; const jetzt = this.jetzt();
    const zeiten = (this.neueAnrufe.get(k) || []).filter((t) => jetzt - t < 60_000);
    if (zeiten.length >= NEU_JE_MINUTE) { this.neueAnrufe.set(k, zeiten); return true; }
    zeiten.push(jetzt); this.neueAnrufe.set(k, zeiten);
    if (this.neueAnrufe.size > 5000) for (const [kk, z] of this.neueAnrufe) if (!z.some((t) => jetzt - t < 60_000)) this.neueAnrufe.delete(kk);
    return false;
  }

  // ---- Nachrichten vom Browser -----------------------------------------------------------------------------------

  async beitreten(v, n) {
    const raum = n.raum;
    if (typeof raum !== 'string' || !RAUM.test(raum) || (n.video !== undefined && typeof n.video !== 'boolean')) { this._fehler(v, raum, 'E_PARAMS', 'Ungültiger Anruf'); return; }
    let an;
    try { an = await this.chat.empfaenger(v.identitaet, raum); } catch (e) {
      this._fehler(v, raum, (e && e.code) || 'E_AGENT', (e && (e.meldung || e.message)) || 'Der Raum ist gerade nicht erreichbar');
      return;
    }
    // Während des Agent-Rundwegs getrennt? Dann nicht mehr eintragen – sonst bliebe ein Geister-Teilnehmer (Prüfbericht Plan 03, I2)
    if (this.gestoppt || this.getrennt.has(v)) return;
    const schl = schluesselVon(v.identitaet);
    let a = this.anrufe.get(raum);
    const neu = !a;
    if (a) {
      const alt = [...a.teilnehmer.values()].find((t) => t.schluessel === schl);
      if (alt) {
        a.teilnehmer.delete(alt.id);
        if (alt.v !== v) alt.v.ws.senden({ art: 'anruf.ende', raum, grund: 'ersetzt' });
      } else if (a.teilnehmer.size >= MAX_TEILNEHMER) { this._fehler(v, raum, 'E_BELEGT', 'Anruf ist voll (höchstens 6)'); return; }
    } else {
      if (this._neuGebremst(schl, raum)) { this._fehler(v, raum, 'E_BREMSE', 'Zu viele neue Anrufe – bitte kurz warten'); return; }
      a = { raum, dm: raum.startsWith('d'), beginn: this.jetzt(), video: n.video === true, empfaenger: null, teilnehmer: new Map(), klingelTimer: null, angenommen: false, abgelehnt: false, starter: v.identitaet, letzter: v.identitaet, mitAnderen: false };
      this.anrufe.set(raum, a);
    }
    a.empfaenger = { nutzer: [...((an && an.nutzer) || [])], gaeste: [...((an && an.gaeste) || [])] };
    const bisher = [...a.teilnehmer.values()].map((t) => this._oeffentlich(t, schl));
    const t = {
      id: `p${crypto.randomBytes(9).toString('base64url')}`, schluessel: schl, v, name: nameVon(v.identitaet), gastname: gastSichtName(v.identitaet), gast: v.identitaet.art === 'gast',
      medien: { audio: true, video: n.video === true, bildschirm: false }, identitaet: v.identitaet,
    };
    a.teilnehmer.set(t.id, t);
    if (a.teilnehmer.size >= 2) a.mitAnderen = true;
    a.letzter = v.identitaet;
    v.ws.senden({ art: 'anruf.beigetreten', raum, id: t.id, teilnehmer: bisher });
    if (a.dm && !neu && !a.angenommen && schl !== schluesselVon(a.starter)) {
      a.angenommen = true;
      if (a.klingelTimer) { this.uhr.clearTimeout(a.klingelTimer); a.klingelTimer = null; }
    }
    this._standAnAlle(a);
    if (!neu) return;
    // nur gerade sichtbare Chats unterdrücken die Meldung – ein offener Hintergrund-Tab nicht (Prüfbericht Plan 03, I4)
    this._agent(a, v.identitaet, { art: 'beginn', video: a.video, aktiv: this.chat.verteiler.aktive() });
    if (a.dm) {
      for (const nutzer of a.empfaenger.nutzer) {
        if (`n:${nutzer}` === schl) continue;
        for (const x of this.chat.verteiler.fuerNutzer(nutzer)) x.ws.senden({ art: 'anruf.klingelt', raum, von_name: t.name, video: a.video });
      }
      a.klingelTimer = this.uhr.setTimeout(() => this._keineAntwort(a), KLINGEL_MS);
    }
  }

  _keineAntwort(a) {
    a.klingelTimer = null;
    if (this.anrufe.get(a.raum) !== a || a.angenommen) return;
    for (const t of a.teilnehmer.values()) t.v.ws.senden({ art: 'anruf.ende', raum: a.raum, grund: 'keine_antwort' });
    a.teilnehmer.clear();
    this._ende(a, a.starter);
  }

  verlassen(v, n) {
    const a = this.anrufe.get(n.raum);
    const t = a && this._teilnahmeVon(a, v);
    if (t) this._entfernen(a, t, v.identitaet);
  }

  signal(v, n) {
    const raum = n.raum;
    const a = this.anrufe.get(raum);
    const ich = a && this._teilnahmeVon(a, v);
    if (!ich) { this._fehler(v, raum, 'E_RECHTE', 'Du bist nicht in diesem Anruf'); return; }
    const daten = signalDaten(n.daten);
    if (!daten) { this._fehler(v, raum, 'E_PARAMS', 'Ungültiges Signal'); return; }
    const ziel = typeof n.an === 'string' && TEILNEHMER_MUSTER.test(n.an) ? a.teilnehmer.get(n.an) : null;
    if (!ziel) return; // nicht (mehr) im Anruf: still verwerfen
    ziel.v.ws.senden({ art: 'anruf.signal', raum, von: ich.id, daten });
  }

  medien(v, n) {
    const a = this.anrufe.get(n.raum);
    const t = a && this._teilnahmeVon(a, v);
    if (!t) return;
    t.medien = { audio: n.audio === true, video: n.video === true, bildschirm: n.bildschirm === true };
    this._standAnAlle(a);
  }

  /** Nur in Direktnachrichten, nur der Angerufene, nur solange niemand angenommen hat. */
  ablehnen(v, n) {
    const a = this.anrufe.get(n.raum);
    if (!a || !a.dm || a.angenommen || schluesselVon(v.identitaet) === schluesselVon(a.starter)) return;
    if (!a.empfaenger.nutzer.includes(v.identitaet.nutzer)) return;
    a.abgelehnt = true;
    const name = nameVon(v.identitaet);
    for (const t of a.teilnehmer.values()) {
      t.v.ws.senden({ art: 'anruf.abgelehnt', raum: a.raum, von_name: name });
      t.v.ws.senden({ art: 'anruf.ende', raum: a.raum, grund: 'abgelehnt' });
    }
    a.teilnehmer.clear();
    this._ende(a, a.starter);
  }

  /** Startzustand: für jeden laufenden Anruf in einem Raum des Fragenden ein anruf.stand. */
  abfragen(v) {
    const id = v.identitaet;
    for (const a of this.anrufe.values()) {
      const darf = id.art === 'gast' ? a.empfaenger.gaeste.includes(id.gast) : a.empfaenger.nutzer.includes(id.nutzer);
      if (darf) this._standAn(v, a);
    }
  }

  /** Verbindung weg = alle ihre Teilnahmen verlassen. */
  trennen(v) {
    this.getrennt.add(v);
    this.bremsen.delete(v);
    for (const a of [...this.anrufe.values()]) {
      const t = this._teilnahmeVon(a, v);
      if (t) this._entfernen(a, t, v.identitaet);
    }
  }

  // ---- Ereignisse des Agenten ------------------------------------------------------------------------------------

  _ereignis(e) {
    if (!e || e.ereignis !== 'chat') return;
    const a = this.anrufe.get(e.raum);
    if (!a) return;
    let weg = [];
    if (e.art === 'raum_weg') {
      const nutzer = (e.an && Array.isArray(e.an.nutzer)) ? e.an.nutzer : [];
      a.empfaenger.nutzer = a.empfaenger.nutzer.filter((x) => !nutzer.includes(x));
      weg = [...a.teilnehmer.values()].filter((t) => t.identitaet.art === 'nutzer' && nutzer.includes(t.identitaet.nutzer));
      if (e.an && Array.isArray(e.an.gaeste) && e.an.gaeste.length) {
        a.empfaenger.gaeste = a.empfaenger.gaeste.filter((x) => !e.an.gaeste.includes(x));
        weg.push(...[...a.teilnehmer.values()].filter((t) => t.identitaet.art === 'gast' && e.an.gaeste.includes(t.identitaet.gast)));
      }
    } else if (e.art === 'gast_entfernt' && e.daten && e.daten.gast) {
      a.empfaenger.gaeste = a.empfaenger.gaeste.filter((x) => x !== e.daten.gast);
      weg = [...a.teilnehmer.values()].filter((t) => t.identitaet.art === 'gast' && t.identitaet.gast === e.daten.gast);
    } else return;
    for (const t of weg) {
      t.v.ws.senden({ art: 'anruf.ende', raum: a.raum, grund: 'entfernt' });
      this._entfernen(a, t, t.identitaet);
      if (this.anrufe.get(a.raum) !== a) break;
    }
  }
}
