// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Sitzung im Browser (V18): ein geöffnetes Dokument über die Office-Verbindung. Sie hält den Sync-Klienten (V12),
// schickt eigene Ops mit `dok`, führt fremde Auswahl gegen spätere Ops nach, nimmt nach einem Abbruch wieder auf und
// öffnet neu, wenn der Server es verlangt (Außenänderung, zu alter Stand, abgelehnte Op). Je Tab und Dokument gibt es
// höchstens eine Sitzung; „beforeunload“ warnt, solange eigene Ops unbestätigt sind. Kein Import aus app.js – die
// Ordnerwahl wird erst beim Gebrauch geladen.

import { SyncKlient } from '../gemeinsam/sync/klient.js';
import { SyncFehler } from '../gemeinsam/sync/fehler.js';
import { TYPEN } from '../gemeinsam/sync/typen/index.js';
import { ApiFehler, antwortAuswerten, csrfToken } from '../api.js';
import { officeVerbindung } from './verbindung.js';

export const OEFFNEN_MS = 20_000;
export const SCHLIESSEN_MS = 30_000;
const NAME_MAX = 200;
const NACHRICHTEN = Object.freeze(['op', 'wiederaufgenommen', 'fehler', 'auswahl', 'anwesend', 'gespeichert', 'speicherfehler', 'extern', 'neu_laden', 'recht', 'umbenannt']);

const ALLE = new Set();          // offene Sitzungen des Tabs (für beforeunload)
const REGISTER = new WeakMap();  // Verbindung → {sitzungen: Map<id, OfficeSitzung>, oeffnend: Map<schluessel, Promise>}
let anfrageZaehler = 0;

const tx = (ctx, k, w) => (ctx && typeof ctx.t === 'function' ? ctx.t(k, w) : k);
const ordnerWahlStandard = (ctx, o) => import('../ordnerwahl.js').then((m) => m.ordnerWaehlen(ctx, o));

/** Speicherstatus der Kopfzeile: offline vor Fehler vor „speichert“. */
export function statusAus({ verbunden, ausstehend, ungespeichert, fehler }) {
  if (!verbunden) return 'offline';
  if (fehler) return 'fehler';
  if (ausstehend > 0 || ungespeichert) return 'speichert';
  return 'gespeichert';
}

/** true, solange irgendeine Sitzung des Tabs unbestätigte eigene Ops hat. */
export function etwasAusstehend() {
  for (const s of ALLE) if (s.ausstehend > 0) return true;
  return false;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (ev) => {
    if (!etwasAusstehend()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

/** Hochladen per XMLHttpRequest (Sitzungs-Cookie + CSRF-Kopf) → Ergebnis des Web-Dienstes ({datei, name}). */
export function xhrHochladen(url, datei, { beiFortschritt } = {}) {
  return new Promise((ok, nein) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-FAHNAS-CSRF', csrfToken());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    if (xhr.upload && beiFortschritt) xhr.upload.onprogress = (e) => beiFortschritt(e.loaded, e.lengthComputable ? e.total : (datei && datei.size) || 0);
    xhr.onload = () => {
      const { ergebnis, fehler } = antwortAuswerten(xhr.status, xhr.responseText);
      if (fehler) nein(fehler); else ok(ergebnis);
    };
    xhr.onerror = () => nein(new ApiFehler('E_UNBEKANNT', '', { grund: 'netz' }, 0));
    xhr.onabort = () => nein(new ApiFehler('E_ABGEBROCHEN', '', undefined, 0));
    try { xhr.send(datei); } catch (e) { nein(new ApiFehler('E_UNBEKANNT', '', { grund: String(e && e.message) }, 0)); }
  });
}

function registerFuer(verbindung) {
  let r = REGISTER.get(verbindung);
  if (!r) { r = { sitzungen: new Map(), oeffnend: new Map() }; REGISTER.set(verbindung, r); }
  return r;
}

/** Ohne offene und öffnende Sitzungen braucht der Tab keine Office-Leitung. */
function ruhePruefen(verbindung, reg) {
  if (reg.sitzungen.size || reg.oeffnend.size) return;
  if (typeof verbindung.stoppen === 'function') verbindung.stoppen();
}

/** „oeffnen“ schicken (nach jedem Verbinden erneut, solange keine Antwort da ist) und auf geoeffnet/fehler warten. */
function oeffnenAnfragen(verbindung, ref) {
  return new Promise((ok, nein) => {
    const anfrage = `a${++anfrageZaehler}`;
    const ab = [];
    let fertig = false;
    const ende = (fn) => {
      if (fertig) return;
      fertig = true; clearTimeout(timer);
      for (const x of ab) x();
      fn();
    };
    const schicken = () => verbindung.senden({ art: 'oeffnen', anfrage, ref });
    ab.push(verbindung.on('geoeffnet', (n) => { if (n && n.anfrage === anfrage) ende(() => ok(n)); }));
    ab.push(verbindung.on('fehler', (n) => {
      if (!n || n.anfrage !== anfrage) return;
      const f = n.fehler || {};
      ende(() => nein(new SyncFehler(f.code || 'E_UNBEKANNT', f.meldung, f.details)));
    }));
    ab.push(verbindung.on('status', (s) => { if (s === 'verbunden') schicken(); }));
    const timer = setTimeout(() => ende(() => nein(new SyncFehler('E_AGENT'))), OEFFNEN_MS);
    schicken();
  });
}

/**
 * Dokument öffnen: `ref` = {id} oder {freigabe, pfad}. Ein zweites Öffnen desselben Dokuments im Tab gibt dieselbe
 * Sitzung zurück (und hebt ein laufendes Schließen auf). Fehler: Code des Servers, E_AGENT nach 20 s ohne Antwort,
 * E_PARAMS für eine Dokumentart ohne Typ.
 */
export async function sitzungOeffnen({ ref, ctx, verbindung = officeVerbindung(), typen = TYPEN, hochladen = xhrHochladen, ordnerWahl = ordnerWahlStandard } = {}) {
  const reg = registerFuer(verbindung);
  const vorhanden = ref && typeof ref.id === 'string' ? reg.sitzungen.get(ref.id) : null;
  if (vorhanden) { vorhanden._wiederbeleben(); return vorhanden; }
  const schluessel = ref && typeof ref.id === 'string' ? `id\n${ref.id}` : `ort\n${ref && ref.freigabe}\n${ref && ref.pfad}`;
  if (reg.oeffnend.has(schluessel)) return reg.oeffnend.get(schluessel);
  const laeuft = (async () => {
    if (typeof verbindung.starten === 'function') verbindung.starten();
    const n = await oeffnenAnfragen(verbindung, ref);
    const schon = reg.sitzungen.get(n.dok.id);
    if (schon) { schon.kid = n.kid; schon._wiederbeleben(); return schon; } // über einen anderen Weg schon offen
    if (!typen[n.dok.art]) {
      verbindung.senden({ art: 'schliessen', dok: n.dok.id });
      throw new SyncFehler('E_PARAMS', undefined, { art: n.dok.art });
    }
    const s = new OfficeSitzung({ verbindung, typen, ctx, hochladen, ordnerWahl, register: reg });
    s._setzen(n);
    reg.sitzungen.set(s.dok.id, s);
    ALLE.add(s);
    return s;
  })();
  reg.oeffnend.set(schluessel, laeuft);
  try { return await laeuft; } finally {
    if (reg.oeffnend.get(schluessel) === laeuft) reg.oeffnend.delete(schluessel);
    ruhePruefen(verbindung, reg);
  }
}

export class OfficeSitzung {
  constructor({ verbindung, typen, ctx, hochladen, ordnerWahl, register }) {
    this.verbindung = verbindung; this.typen = typen; this.ctx = ctx; this.hochladen = hochladen; this.ordnerWahl = ordnerWahl;
    this._register = register;
    this.dok = null; this.kid = null; this.recht = null; this.anwesend = []; this.fehler = null;
    this.klient = null; this.typ = null;
    this.gespeichertVersion = 0; this.eigeneBestaetigtBis = 0;
    this.fremdeAuswahl = new Map(); // von → {von, nutzer, name, farbe, auswahl}
    this.hoerer = new Map();
    this._status = null; this._neuLaden = null; this._laedt = false;
    this._schliessenGewuenscht = false; this._zu = false;
    this._wartende = new Set(); this._klientAb = [];
    this._ab = NACHRICHTEN.map((art) => verbindung.on(art, (n) => {
      if (n && this.dok && n.dok === this.dok.id && n.anfrage === undefined) this._nachricht(n);
    }));
    this._ab.push(verbindung.on('status', () => this._statusNeu()));
    this._ab.push(verbindung.on('wieder', () => this._wieder()));
    // abgemeldet: diese Sitzung kann nichts mehr senden – beenden (sonst warteten Schließen und beforeunload ewig)
    this._ab.push(verbindung.on('beendet', () => { this.fehler = { code: 'E_ANMELDUNG' }; this._statusNeu(); this._melden('fehler', this.fehler); this._beenden(); }));
  }

  get daten() { return this.klient ? this.klient.daten : null; }
  get version() { return this.klient ? this.klient.version : 0; }
  get ausstehend() { return this.klient ? this.klient.ausstehend : 0; }
  get status() { return this._status; }
  /** Eigene Änderungen, die noch nicht in der Datei stehen: unbestätigt oder nach dem letzten Speichern bestätigt. */
  get eigeneUngesichert() { return this.ausstehend > 0 || this.eigeneBestaetigtBis > this.gespeichertVersion; }

  /** Hörer: aenderung, auswahl, anwesend, status, extern, neu_laden, neu_geladen, recht, umbenannt, fehler. */
  on(art, fn) {
    if (!this.hoerer.has(art)) this.hoerer.set(art, new Set());
    this.hoerer.get(art).add(fn);
    return () => { this.hoerer.get(art)?.delete(fn); };
  }

  _melden(art, daten) { for (const fn of [...(this.hoerer.get(art) || [])]) { try { fn(daten); } catch (e) { console.error(e); } } }

  /** Eigene Änderung: nur mit Recht „bearbeiten“ und nicht, solange das Dokument neu geladen wird. */
  lokal(op) {
    if (this._zu) throw new SyncFehler('E_NICHT_GEFUNDEN');
    if (this.recht !== 'bearbeiten') throw new SyncFehler('E_RECHTE');
    if (this._neuLaden) throw new SyncFehler('E_AGENT');
    this.klient.lokal(op);
    this._statusNeu();
  }

  auswahlSenden(auswahl) {
    if (this._zu) return;
    this.verbindung.senden({ art: 'auswahl', dok: this.dok.id, version: this.version, auswahl });
  }

  dateiUrl(datei) { return `/api/office/datei?id=${encodeURIComponent(this.dok.id)}&datei=${encodeURIComponent(datei)}`; }

  /** Datei (File/Blob mit name) ins Bündel hochladen → {datei, name}. */
  dateiHochladen(datei, optionen = {}) {
    return this.hochladen(`/api/office/hochladen?id=${encodeURIComponent(this.dok.id)}&name=${encodeURIComponent(datei.name)}`, datei, optionen);
  }

  /** Datei aus dem NAS wählen und ins Bündel kopieren → {datei, name}; Abbruch → null. */
  async dateiAusNas() {
    const wahl = await this.ordnerWahl(this.ctx, {
      titel: tx(this.ctx, 'office.aus_nas_titel'), erklaerung: tx(this.ctx, 'office.aus_nas_erklaerung'), okText: tx(this.ctx, 'office.aus_nas_ok'),
      dateien: true, nurSchreibbar: false,
    });
    if (!wahl) return null;
    return this.ctx.api('office.datei_kopieren', { id: this.dok.id, freigabe: wahl.freigabe, pfad: wahl.pfad });
  }

  /**
   * Abmelden, sobald nichts mehr aussteht – ohne Zeitgrenze, damit offline Getipptes nach dem Wiederverbinden noch
   * nachgereicht wird (Prüfbericht Plan 04, I8); bis dahin warnt beforeunload. Ein erneutes Öffnen hebt das Schließen auf.
   */
  async schliessen() {
    if (this._zu) return;
    this._schliessenGewuenscht = true;
    while (this.ausstehend > 0 && this._schliessenGewuenscht && !this._zu) await this._warten(SCHLIESSEN_MS);
    if (!this._schliessenGewuenscht || this._zu) return;
    this.verbindung.senden({ art: 'schliessen', dok: this.dok.id });
    this._beenden();
  }

  _wiederbeleben() { this._schliessenGewuenscht = false; }

  _warten(ms) {
    return new Promise((ok) => {
      const eintrag = { ok: () => { clearTimeout(eintrag.timer); this._wartende.delete(eintrag); ok(); }, timer: null };
      eintrag.timer = setTimeout(eintrag.ok, ms);
      this._wartende.add(eintrag);
    });
  }

  _ausstehendPruefen() { if (this.ausstehend === 0) for (const e of [...this._wartende]) e.ok(); }

  _beenden() {
    if (this._zu) return;
    this._zu = true;
    for (const ab of [...this._ab, ...this._klientAb]) ab();
    this._ab = []; this._klientAb = [];
    for (const e of [...this._wartende]) e.ok();
    if (this._register.sitzungen.get(this.dok.id) === this) this._register.sitzungen.delete(this.dok.id);
    ALLE.delete(this);
    ruhePruefen(this.verbindung, this._register);
  }

  /** Stand aus „geoeffnet“ übernehmen: neuer Sync-Klient, gespeichert = geladene Version. */
  _setzen(n) {
    const { daten, version, ...dok } = n.dok;
    this.typ = this.typen[dok.art];
    this.dok = dok; this.kid = n.kid; this.recht = dok.recht;
    this.anwesend = Array.isArray(n.anwesend) ? n.anwesend : [];
    this.gespeichertVersion = version; this.eigeneBestaetigtBis = 0; this.fehler = null; this._neuLaden = null;
    this.fremdeAuswahl.clear();
    for (const ab of this._klientAb) ab();
    const klient = new SyncKlient({ typ: this.typ, version, daten, senden: (m) => this._senden(m) });
    this.klient = klient;
    this._klientAb = [
      klient.on('aenderung', (e) => { this._auswahlNachfuehren(e.op); this._melden('aenderung', e); this._statusNeu(); }),
      klient.on('bestaetigt', ({ version: v }) => { this.eigeneBestaetigtBis = v; this._statusNeu(); this._ausstehendPruefen(); }),
      klient.on('neu_laden', ({ grund }) => this._neuLadenNoetig(grund)),
      klient.on('verworfen', (e) => this._melden('verworfen', e)),
    ];
    this._statusNeu();
    this._ausstehendPruefen();
  }

  _senden(m) {
    if (this._zu) return false;
    const n = { ...m, dok: this.dok.id };
    if (m.art === 'wiederaufnehmen') n.ref = { id: this.dok.id };
    return this.verbindung.senden(n);
  }

  _nachricht(n) {
    if (this._zu) return;
    switch (n.art) {
      case 'op':
      case 'wiederaufgenommen':
        if (this._neuLaden) return; // der alte Stand ist überholt, das neue Öffnen läuft
        if (n.art === 'wiederaufgenommen' && typeof n.kid === 'string') this.kid = n.kid;
        this.klient.empfangen(n);
        this._statusNeu();
        return;
      case 'fehler': {
        if (n.cid !== undefined) { this.klient.empfangen(n); return; }
        this.fehler = n.fehler || { code: 'E_UNBEKANNT' };
        this._statusNeu();
        this._melden('fehler', this.fehler);
        // kein Zugriff mehr bzw. Dokument weg: der Server hat die Sitzung schon abgemeldet
        if (this.fehler.code === 'E_RECHTE' || this.fehler.code === 'E_NICHT_GEFUNDEN') this._beenden();
        return;
      }
      case 'auswahl': this._fremdeAuswahlSetzen(n); return;
      case 'anwesend': this._anwesendSetzen(n.liste); return;
      case 'gespeichert':
        if (Number.isInteger(n.version) && n.version > this.gespeichertVersion) this.gespeichertVersion = n.version;
        this.fehler = null;
        this._statusNeu();
        return;
      case 'speicherfehler':
        this.fehler = n.fehler || { code: 'E_UNBEKANNT' };
        this._statusNeu();
        return;
      case 'extern':
        this._melden('extern', { eigeneUngesichert: this.eigeneUngesichert, daten: this.daten });
        this._neuOeffnen('extern');
        return;
      case 'neu_laden': this._neuLadenNoetig(n.grund || 'neu_laden'); return;
      case 'recht':
        this.recht = n.recht; this.dok.recht = n.recht;
        this._melden('recht', { recht: n.recht });
        return;
      case 'umbenannt':
        this.dok.name = n.name; this.dok.pfad = n.pfad;
        this._melden('umbenannt', { name: n.name, pfad: n.pfad });
        return;
      default:
    }
  }

  _fremdeAuswahlSetzen(n) {
    if (n.von === this.kid) return;
    const e = { von: n.von, nutzer: n.nutzer, name: n.name, farbe: n.farbe, auswahl: n.auswahl ?? null };
    if (e.auswahl) this.fremdeAuswahl.set(n.von, e); else this.fremdeAuswahl.delete(n.von);
    this._melden('auswahl', { ...e });
  }

  /** Fremde Auswahl gegen eine angewandte Op (eigene wie fremde) nachführen; geändert → erneutes 'auswahl'. */
  _auswahlNachfuehren(op) {
    if (!op || typeof this.typ.auswahlTransformieren !== 'function') return;
    for (const e of this.fremdeAuswahl.values()) {
      const neu = this.typ.auswahlTransformieren(e.auswahl, op);
      if (neu === e.auswahl) continue;
      e.auswahl = neu;
      this._melden('auswahl', { ...e });
    }
  }

  _anwesendSetzen(liste) {
    this.anwesend = Array.isArray(liste) ? liste : [];
    const da = new Set(this.anwesend.map((x) => x.kid));
    for (const [von, e] of [...this.fremdeAuswahl]) {
      if (da.has(von)) continue;
      this.fremdeAuswahl.delete(von);
      this._melden('auswahl', { ...e, auswahl: null });
    }
    this._melden('anwesend', this.anwesend);
  }

  _neuLadenNoetig(grund) {
    this._melden('neu_laden', { grund, eigeneUngesichert: this.eigeneUngesichert, daten: this.daten });
    // gelöscht bzw. nicht mehr am bekannten Ort: neu öffnen ginge nicht – die Sitzung endet (Kopie bietet der Rahmen an)
    if (grund === 'geloescht' || grund === 'verschoben') { this._beenden(); return; }
    this._neuOeffnen(grund);
  }

  /** Neu öffnen (eigener Stand wird verworfen); scheitert es, versucht es das nächste Wiederverbinden erneut. */
  async _neuOeffnen(grund) {
    this._neuLaden = grund;
    if (this._laedt) return;
    this._laedt = true;
    try {
      const n = await oeffnenAnfragen(this.verbindung, { id: this.dok.id });
      if (this._zu) { this.verbindung.senden({ art: 'schliessen', dok: n.dok.id }); return; }
      if (!this.typen[n.dok.art]) throw new SyncFehler('E_PARAMS', undefined, { art: n.dok.art });
      this._setzen(n);
      this._melden('neu_geladen', { grund });
      this._melden('anwesend', this.anwesend);
    } catch (e) {
      if (this._zu) return;
      this.fehler = { code: (e && e.code) || 'E_UNBEKANNT', ...(e && e.message ? { meldung: e.message } : {}) };
      this._statusNeu();
      this._melden('fehler', this.fehler);
    } finally { this._laedt = false; }
  }

  _wieder() {
    if (this._zu) return;
    if (this._neuLaden) { this._neuOeffnen(this._neuLaden); return; }
    this.klient.wiederaufnehmen();
  }

  _statusNeu() {
    if (!this.klient) return;
    const s = statusAus({ verbunden: this.verbindung.status === 'verbunden', ausstehend: this.ausstehend, ungespeichert: this.version > this.gespeichertVersion, fehler: this.fehler });
    if (s === this._status) return;
    this._status = s;
    this._melden('status', s);
  }
}

/**
 * Eigene Fassung als neues Dokument neben dem Original sichern: „<Name> (meine Fassung JJJJ-MM-TT HH-MM)“ (Ortszeit,
 * höchstens 200 Zeichen) im Elternordner, danach die Daten setzen → {id, name}. Darf man dort nicht schreiben (oder gibt
 * es den Ordner nicht mehr), wird ein Ordner gewählt; Abbruch → null (Prüfbericht Plan 04, I7).
 */
export async function kopieSichern(ctx, sitzung, jetzt = new Date(), daten = sitzung.daten, { ordnerWahl = ordnerWahlStandard } = {}) {
  const zwei = (z) => String(z).padStart(2, '0');
  const zeit = `${jetzt.getFullYear()}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())} ${zwei(jetzt.getHours())}-${zwei(jetzt.getMinutes())}`;
  const zusatz = ` (${typeof ctx.t === 'function' ? ctx.t('office.meine_fassung', { zeit }) : `meine Fassung ${zeit}`})`;
  let stamm = '';
  for (const z of String(sitzung.dok.name || '')) { if (stamm.length + z.length + zusatz.length > NAME_MAX) break; stamm += z; }
  const pfad = String(sitzung.dok.pfad || '');
  const ordner = pfad.includes('/') ? pfad.slice(0, pfad.lastIndexOf('/')) : '';
  const anlegen = (freigabe, wo) => ctx.api('office.anlegen', { art: sitzung.dok.art, freigabe, ordner: wo, name: `${stamm.trimEnd()}${zusatz}`, beide: true });
  let r;
  try { r = await anlegen(sitzung.dok.freigabe, ordner); } catch (f) {
    if (!f || (f.code !== 'E_RECHTE' && f.code !== 'E_NICHT_GEFUNDEN')) throw f;
    const ziel = await ordnerWahl(ctx, { titel: tx(ctx, 'office.kopie_ordner'), erklaerung: tx(ctx, 'office.kopie_ordner_erklaerung'), okText: tx(ctx, 'office.ordner_ok'), nurSchreibbar: true });
    if (!ziel) return null;
    r = await anlegen(ziel.freigabe, ziel.pfad || '');
  }
  await ctx.api('office.import_setzen', { id: r.id, daten });
  return { id: r.id, name: r.name };
}
