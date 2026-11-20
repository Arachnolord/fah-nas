// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Register der offenen Office-Dokumente im Web-Dienst (Plan 04): je Dokument ein OffenesDokument mit seinen Klienten
// (Anwesenheit mit Farbe), automatisches Speichern über den Agenten (1500 ms nach der letzten Op, spätestens 5000 ms
// nach der ersten ungespeicherten; letzter Klient weg → sofort), Kontext des letzten Autors bzw. anderer Bearbeiter,
// Änderungen von außen (E_GEAENDERT beim Speichern, Prüfung alle 30 s) → neu laden und „extern“ an alle, Wiederaufnahme
// über den Verlauf der Datei (auch nach einem Neustart), Entladen 30 s nach dem letzten Klienten.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { OffenesDokument } from './dokument.js';
import { TYPEN } from '../../../public/gemeinsam/sync/typen/index.js';

export const SPEICHERN_RUHE_MS = 1500;
export const SPEICHERN_MAX_MS = 5000;
export const ENTLADEN_MS = 30_000;
export const EXTERN_PRUEFEN_MS = 30_000;
export const FEHLER_WIEDERHOLEN_MS = 10_000;
/** Anwesenheitsfarben in fester Reihenfolge; ein neuer Klient bekommt die erste freie. */
export const ANWESEND_FARBEN = Object.freeze(['#d14b4b', '#2f7fd1', '#2f9e5b', '#b5651d', '#8a4fd1', '#c2407f', '#13877f', '#6b7280']);
/** Höchstens so viele Verlaufszeilen gehen mit einem Speichern zur Datei (die Datei behält ebenso viele). */
const VERLAUF_MAX = 500;

const STANDARD_UHR = Object.freeze({
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t), jetzt: () => Date.now(),
});
const unref = (t) => { t?.unref?.(); return t; };
/** Fehler „Bündel nicht mehr am Ort / im Papierkorb“ (nicht: nur kein Recht). */
const verschwunden = (f) => !!(f && f.code === 'E_NICHT_GEFUNDEN' && f.details && (f.details.office === 'verschoben' || f.details.office === 'geloescht'));

export class DokumentRegister {
  constructor({ agent, typen = TYPEN, uhr = STANDARD_UHR, protokoll = null }) {
    this.agent = agent; this.typen = typen; this.uhr = uhr; this.protokoll = protokoll;
    this.offen = new Map(); // id → Eintrag {dok, klienten, …}
    this.gestoppt = false;
    this.annahmeGestoppt = false; // V15: während des Abschlusses keine neuen Ops (die Klienten reichen sie nach dem Neustart nach)
  }

  // ---- Laden und Klienten -----------------------------------------------------------------------------------------

  _refParams(ref) { return ref && ref.id ? { id: ref.id } : { freigabe: ref.freigabe, pfad: ref.pfad }; }

  _offenAmOrt(ref) {
    if (!ref || ref.id) return this.offen.get(ref && ref.id) || null;
    for (const e of this.offen.values()) if (e.dok.meta.freigabe === ref.freigabe && e.dok.meta.pfad === ref.pfad) return e;
    return null;
  }

  _dokumentAus(l) {
    const typ = this.typen[l.art];
    if (!typ) throw new FahnasFehler('E_PARAMS', 'Diese Office-Art lässt sich hier noch nicht öffnen', { feld: 'art' });
    const meta = { id: l.id, art: l.art, name: l.name, freigabe: l.freigabe, pfad: l.pfad, besitzer: l.besitzer, schnappschuesse: !!l.schnappschuesse };
    return new OffenesDokument({ meta, typ, version: l.version, daten: l.daten, stand: l.stand, verlauf: l.verlauf || [] });
  }

  _aufnehmen(l) {
    const e = {
      dok: this._dokumentAus(l), klienten: new Map(), ersteUngespeichert: null, ersteNachSpeichern: null, zeitgeber: null, speichertGerade: null,
      nochmal: false, letzterAutor: null, entladen: null, wiederholen: null, aussen: null, aussenLaeuft: false,
    };
    this.offen.set(l.id, e);
    e.aussen = unref(this.uhr.setInterval(() => { this._aussenPruefen(e).catch(() => {}); }, EXTERN_PRUEFEN_MS));
    return e;
  }

  /** Klient anmelden (lädt das Dokument bei Bedarf über den Agenten) → {dok, recht, farbe, anwesend}. */
  async oeffnen(ref, klient) {
    let e = this._offenAmOrt(ref);
    let recht;
    if (e) {
      // Entladen schon jetzt aufheben: sonst könnte es während der Rechte-Abfrage zuschlagen
      const war = e;
      if (war.entladen) { this.uhr.clearTimeout(war.entladen); war.entladen = null; }
      let r;
      try { r = await this.agent.aktion('office.recht', { ...this._refParams(ref), merken: true }, klient.kontext); } catch (f) {
        if (!war.klienten.size && this.offen.get(war.dok.meta.id) === war) this._entladenPlanen(war);
        throw f;
      }
      recht = r.recht;
      e = this.offen.get(r.id);
      if (!e) { // inzwischen doch entladen: frisch laden
        const l = await this.agent.aktion('office.laden', { id: r.id }, klient.kontext);
        e = this.offen.get(l.id) || this._aufnehmen(l);
        recht = l.recht;
      }
    } else {
      const l = await this.agent.aktion('office.laden', this._refParams(ref), klient.kontext);
      e = this.offen.get(l.id) || this._aufnehmen(l); // gleichzeitig von einem anderen geladen: dessen Stand gilt
      recht = l.recht;
    }
    if (e.entladen) { this.uhr.clearTimeout(e.entladen); e.entladen = null; }
    const belegt = new Set([...e.klienten.values()].map((k) => k.farbe));
    const farbe = ANWESEND_FARBEN.find((f) => !belegt.has(f)) || ANWESEND_FARBEN[e.klienten.size % ANWESEND_FARBEN.length];
    Object.assign(klient, { recht, farbe });
    e.klienten.set(klient.kid, klient);
    const anwesend = this._anwesend(e, klient.kid); // der Neue bekommt die Liste mit „geoeffnet“
    return { dok: e.dok, recht, farbe, anwesend };
  }

  _liste(e) { return [...e.klienten.values()].map((k) => ({ kid: k.kid, nutzer: k.kontext.nutzer, name: k.name, farbe: k.farbe })); }

  _anwesend(e, ausser = null) {
    const liste = this._liste(e);
    this._anAlle(e, { art: 'anwesend', dok: e.dok.meta.id, liste }, ausser);
    return liste;
  }

  _anAlle(e, nachricht, ausser = null) {
    for (const k of e.klienten.values()) if (k.kid !== ausser) { try { k.senden(nachricht); } catch { /* Verbindung zu */ } }
  }

  /** Klient abmelden; der letzte löst sofortiges Speichern und nach 30 s das Entladen aus. */
  schliessen(id, kid) {
    const e = this.offen.get(id);
    if (!e || !e.klienten.delete(kid)) return;
    if (e.klienten.size) { this._anwesend(e); return; }
    if (e.dok.ungespeichert().length) this.speichern(id).catch(() => {});
    this._entladenPlanen(e);
  }

  _entladenPlanen(e) {
    if (e.entladen) this.uhr.clearTimeout(e.entladen);
    e.entladen = unref(this.uhr.setTimeout(() => {
      e.entladen = null;
      if (e.klienten.size) return;
      if (e.dok.ungespeichert().length || e.speichertGerade) { this._entladenPlanen(e); return; } // erst sichern
      this._entladen(e);
    }, ENTLADEN_MS));
  }

  _entladen(e) {
    for (const t of [e.zeitgeber, e.entladen, e.wiederholen]) if (t) this.uhr.clearTimeout(t);
    if (e.aussen) this.uhr.clearInterval(e.aussen);
    e.zeitgeber = e.entladen = e.wiederholen = e.aussen = null;
    if (this.offen.get(e.dok.meta.id) === e) this.offen.delete(e.dok.meta.id);
  }

  // ---- Ops und Auswahl --------------------------------------------------------------------------------------------

  /** Op eines Klienten einordnen und an alle verteilen; Fehler gehen mit cid nur an ihn. */
  op(id, kid, { basis, cid, op } = {}) {
    const e = this.offen.get(id); const k = e && e.klienten.get(kid);
    if (!k) return false; // nicht (mehr) angemeldet – der Dienst antwortet mit Fehler
    if (typeof cid !== 'string' || !cid || cid.length > 64) { k.senden({ art: 'fehler', dok: id, cid, fehler: { code: 'E_PARAMS', meldung: 'Kennung der Änderung ungültig' } }); return true; }
    if (this.annahmeGestoppt) return true; // Abschluss läuft: nicht anwenden, nicht bestätigen
    if (k.recht !== 'bearbeiten') { k.senden({ art: 'fehler', dok: id, cid, fehler: { code: 'E_RECHTE', meldung: 'Du darfst dieses Dokument nur lesen' } }); return true; }
    let r;
    try { r = e.dok.opAnnehmen({ basis, cid, op, nutzer: k.kontext.nutzer }); } catch (f) {
      if (f.code === 'E_GEAENDERT') { k.senden({ art: 'neu_laden', dok: id, grund: 'zu_alt' }); return true; }
      k.senden({ art: 'fehler', dok: id, cid, fehler: { code: f.code || 'E_PARAMS', meldung: f.message } });
      return true;
    }
    const nachricht = { art: 'op', dok: id, version: r.v, von: kid, cid: r.cid, op: r.op };
    if (r.doppelt) { k.senden(nachricht); return true; }
    e.letzterAutor = k.kontext;
    this._anAlle(e, nachricht);
    this._planen(e);
    return true;
  }

  /** Auswahl (Cursor, offene Karte) an alle anderen. */
  auswahl(id, kid, { version, auswahl } = {}) {
    const e = this.offen.get(id); const k = e && e.klienten.get(kid);
    if (!k) return;
    this._anAlle(e, { art: 'auswahl', dok: id, von: kid, nutzer: k.kontext.nutzer, name: k.name, farbe: k.farbe, version, auswahl }, kid);
  }

  // ---- Speichern --------------------------------------------------------------------------------------------------

  _planen(e) {
    const jetzt = this.uhr.jetzt();
    if (e.speichertGerade) { e.nochmal = true; e.ersteNachSpeichern ??= jetzt; return; }
    e.ersteUngespeichert ??= jetzt;
    if (e.wiederholen) return; // nach einem Fehler kommt der nächste Versuch ohnehin
    if (e.zeitgeber) this.uhr.clearTimeout(e.zeitgeber);
    const warte = Math.min(SPEICHERN_RUHE_MS, Math.max(0, e.ersteUngespeichert + SPEICHERN_MAX_MS - jetzt));
    e.zeitgeber = unref(this.uhr.setTimeout(() => { e.zeitgeber = null; this.speichern(e.dok.meta.id).catch(() => {}); }, warte));
  }

  /** Kontexte zum Speichern: letzter Autor, dann die übrigen verbundenen Bearbeiter (je Nutzer einmal). */
  _kontexte(e) {
    const aus = []; const gesehen = new Set();
    const nimm = (k) => { if (k && !gesehen.has(k.nutzer)) { gesehen.add(k.nutzer); aus.push(k); } };
    nimm(e.letzterAutor);
    for (const k of e.klienten.values()) if (k.recht === 'bearbeiten') nimm(k.kontext);
    return aus;
  }

  /** Ungespeichertes jetzt über den Agenten schreiben (läuft schon ein Speichern, folgt danach ein weiteres). */
  async speichern(id) {
    const e = this.offen.get(id);
    if (!e) return;
    if (e.speichertGerade) { e.nochmal = true; return e.speichertGerade; }
    if (e.zeitgeber) { this.uhr.clearTimeout(e.zeitgeber); e.zeitgeber = null; }
    if (e.wiederholen) { this.uhr.clearTimeout(e.wiederholen); e.wiederholen = null; }
    const offen = e.dok.ungespeichert();
    if (!offen.length) return;
    e.speichertGerade = this._speichernLauf(e, offen).finally(() => {
      e.speichertGerade = null;
      if (this.offen.get(id) !== e || this.gestoppt) return;
      e.nochmal = false;
      if (e.dok.ungespeichert().length && !e.wiederholen) {
        e.ersteUngespeichert = e.ersteNachSpeichern ?? this.uhr.jetzt(); e.ersteNachSpeichern = null;
        this._planen(e);
      } else e.ersteNachSpeichern = null;
    });
    return e.speichertGerade;
  }

  async _speichernLauf(e, offen) {
    const id = e.dok.meta.id; const version = e.dok.version; const daten = e.dok.daten;
    const ops = offen.slice(-VERLAUF_MAX).map(({ v, op, cid }) => ({ v, op, cid }));
    let fehler = null; let rechtFehlt = false;
    try {
      for (const kontext of this._kontexte(e)) {
        try {
          const r = await this.agent.aktion('office.speichern', { id, version, daten, ops, stand: e.dok.stand }, kontext);
          if (this.offen.get(id) !== e) return;
          e.dok.gespeichert(version, r.stand);
          e.ersteUngespeichert = null;
          this._anAlle(e, { art: 'gespeichert', dok: id, version, zeit: new Date(this.uhr.jetzt()).toISOString() });
          return;
        } catch (f) {
          fehler = f;
          if (verschwunden(f)) { this._verschwunden(e); return; }
          // kein Recht (mehr) für diesen Bearbeiter: der nächste versucht es, die Rechte aller werden danach neu geprüft
          if (f && (f.code === 'E_RECHTE' || f.code === 'E_NICHT_GEFUNDEN')) { rechtFehlt = true; continue; }
          if (f && f.code === 'E_GEAENDERT') { await this._extern(e, kontext); return; }
          break;
        }
      }
    } finally {
      if (rechtFehlt && this.offen.get(id) === e) this.rechtePruefen(id).catch(() => {});
    }
    if (this.offen.get(id) !== e) return;
    this._anAlle(e, { art: 'speicherfehler', dok: id, fehler: { code: (fehler && fehler.code) || 'E_RECHTE', meldung: (fehler && (fehler.meldung || fehler.message)) || 'Niemand mit Schreibrecht ist mehr da' } });
    this.protokoll?.eintrag?.('office', { fehler: 'speichern', dok: id, code: fehler && fehler.code });
    e.wiederholen = unref(this.uhr.setTimeout(() => { e.wiederholen = null; this.speichern(id).catch(() => {}); }, FEHLER_WIEDERHOLEN_MS));
  }

  /** Datei wurde außerhalb geändert: frisch laden (Ungespeichertes verwerfen) und „extern“ an alle. */
  async _extern(e, kontext) {
    const id = e.dok.meta.id;
    try {
      const l = await this.agent.aktion('office.laden', { id }, kontext);
      if (this.offen.get(id) !== e) return;
      e.dok = this._dokumentAus({ ...l, verlauf: [] });
      e.ersteUngespeichert = null; e.ersteNachSpeichern = null; e.nochmal = false;
      if (e.zeitgeber) { this.uhr.clearTimeout(e.zeitgeber); e.zeitgeber = null; }
    } catch (f) {
      this.protokoll?.eintrag?.('office', { fehler: 'extern_laden', dok: id, code: f && f.code });
    }
    this._anAlle(e, { art: 'extern', dok: id });
  }

  /** Alle 30 s, solange Klienten da sind und kein Speichern läuft: Stand der Datei vergleichen. */
  async _aussenPruefen(e) {
    if (e.aussenLaeuft || e.speichertGerade || !e.klienten.size || this.offen.get(e.dok.meta.id) !== e) return;
    const erster = e.klienten.values().next().value;
    e.aussenLaeuft = true;
    try {
      const r = await this.agent.aktion('office.recht', { id: e.dok.meta.id }, erster.kontext);
      if (!e.speichertGerade && r && r.stand && r.stand !== e.dok.stand && this.offen.get(e.dok.meta.id) === e) await this._extern(e, erster.kontext);
    } catch (f) {
      if (verschwunden(f) && this.offen.get(e.dok.meta.id) === e) this._verschwunden(e); // sonst: nächster Takt
    } finally { e.aussenLaeuft = false; }
  }

  /**
   * V15: keine neuen Ops mehr annehmen (die Klienten reichen sie nach dem Neustart nach) und alles Ungespeicherte
   * schreiben – auch, was während eines laufenden Speicherns kam; ein Fehler beendet die Versuche für dieses Dokument.
   */
  async alleSpeichern() {
    this.annahmeGestoppt = true;
    await Promise.all([...this.offen.values()].map(async (e) => {
      const id = e.dok.meta.id;
      if (e.wiederholen) { this.uhr.clearTimeout(e.wiederholen); e.wiederholen = null; }
      for (let i = 0; i < 50 && this.offen.get(id) === e; i++) {
        if (e.speichertGerade) { await e.speichertGerade.catch(() => {}); continue; }
        if (!e.dok.ungespeichert().length) return;
        await this.speichern(id).catch(() => {});
        if (e.wiederholen) return;
      }
    }));
  }

  /** Office-Freigaben oder Nutzer/Freigaben geändert: Rechte aller Klienten in allen offenen Dokumenten neu prüfen. */
  async alleRechtePruefen() {
    await Promise.all([...this.offen.keys()].map((id) => this.rechtePruefen(id).catch(() => {})));
  }

  /** Bündel liegt nicht mehr am bekannten Ort (verschoben/gelöscht, etwa per SMB): alle laden neu, Dokument entladen. */
  _verschwunden(e) {
    const id = e.dok.meta.id;
    this._anAlle(e, { art: 'neu_laden', dok: id, grund: 'verschoben' });
    this.protokoll?.eintrag?.('office', { fehler: 'verschwunden', dok: id });
    e.klienten.clear();
    this._entladen(e);
  }

  // ---- Wiederaufnahme ---------------------------------------------------------------------------------------------

  /** Nach einem Abbruch (auch nach Neustart): verpasste Ops oder Neuladen. */
  async wiederaufnehmen(ref, version, klient) {
    const { dok } = await this.oeffnen(ref, klient);
    const id = dok.meta.id;
    const ops = Number.isInteger(version) && version <= dok.version ? dok.opsSeit(version) : undefined;
    if (ops === undefined || ops === null) {
      this.schliessen(id, klient.kid); // der Klient öffnet neu
      return { art: 'neu_laden', dok: id, grund: ops === null ? 'zu_alt' : 'version' };
    }
    return { art: 'wiederaufgenommen', dok: id, kid: klient.kid, version: dok.version, ops: ops.map(({ v, op, cid }) => ({ v, op, cid })) };
  }

  // ---- Ereignisse des Agenten -------------------------------------------------------------------------------------

  /** Office-Freigaben geändert: Recht jedes Klienten neu prüfen; ohne Recht wird das Dokument für ihn geschlossen. */
  async rechtePruefen(id) {
    const e = this.offen.get(id);
    if (!e) return;
    for (const k of [...e.klienten.values()]) {
      let recht = null;
      try { recht = (await this.agent.aktion('office.recht', { id }, k.kontext)).recht; } catch { recht = null; }
      if (!recht) {
        try { k.senden({ art: 'fehler', dok: id, fehler: { code: 'E_RECHTE', meldung: 'Du hast keinen Zugriff mehr auf dieses Dokument' } }); } catch { /* zu */ }
        this.schliessen(id, k.kid);
      } else if (recht !== k.recht) {
        k.recht = recht;
        try { k.senden({ art: 'recht', dok: id, recht }); } catch { /* zu */ }
      }
    }
  }

  /**
   * Dokument umbenannt oder verschoben (Dateimanager, office.umbenennen). Liegt es jetzt in einer anderen Freigabe,
   * werden zuerst die Rechte geprüft – wer nichts mehr darf, erfährt den neuen Ort nicht.
   */
  async pfadGeaendert(id, { name, pfad, freigabe } = {}) {
    const e = this.offen.get(id);
    if (!e) return;
    const andereFreigabe = freigabe !== undefined && freigabe !== e.dok.meta.freigabe;
    Object.assign(e.dok.meta, { ...(name !== undefined ? { name } : {}), ...(pfad !== undefined ? { pfad } : {}), ...(freigabe !== undefined ? { freigabe } : {}) });
    if (andereFreigabe) await this.rechtePruefen(id).catch(() => {});
    if (this.offen.get(id) !== e) return;
    this._anAlle(e, { art: 'umbenannt', dok: id, name: e.dok.meta.name, pfad: e.dok.meta.pfad });
  }

  /** Dokument liegt im Papierkorb: alle laden neu (und erfahren es dabei), das Dokument wird entladen. */
  geloescht(id) {
    const e = this.offen.get(id);
    if (!e) return;
    this._anAlle(e, { art: 'neu_laden', dok: id, grund: 'geloescht' });
    e.klienten.clear();
    this._entladen(e);
  }

  stoppen() {
    this.gestoppt = true;
    for (const e of [...this.offen.values()]) this._entladen(e);
  }
}
