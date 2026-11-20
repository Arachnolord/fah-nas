// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Hilfsschicht zum Web-Dienst: fetch mit CSRF-Kopf, einheitliche Fehlerobjekte, Server-Sent Events,
// Hochladen mit Fortschritt (XMLHttpRequest). Keine Texte hier – Meldungen kommen über `setzeTexte`.

/** Fehler der Web-API. `code` ist einer aus docs/schnittstellen.md §6, `meldung` deutsch. */
export class ApiFehler extends Error {
  constructor(code, meldung, details, status = 0) {
    super(meldung || code || 'E_UNBEKANNT');
    this.name = 'ApiFehler';
    this.code = code || 'E_UNBEKANNT';
    this.details = details;
    this.status = status;
  }

  get meldung() { return this.message; }

  toJSON() { return { code: this.code, meldung: this.message, details: this.details, status: this.status }; }
}

// Übersetzer für Standard-Meldungen (wird vom Rahmen nach dem Laden der Sprache gesetzt).
let texte = (code) => code;
/** @param {(code:string, details?:object)=>string} fn */
export function setzeTexte(fn) { texte = typeof fn === 'function' ? fn : texte; }

/** Liest das CSRF-Token aus dem Cookie `fahnas_csrf`. */
export function csrfToken() {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)fahnas_csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** Wandelt eine beliebige Antwort (Text + Status) in Ergebnis oder ApiFehler um. */
export function antwortAuswerten(status, text) {
  let daten = null;
  if (text) { try { daten = JSON.parse(text); } catch { daten = null; } }
  if (daten && daten.ok === true) {
    // Aufgaben: der Web-Dienst antwortet {ok:true, aufgabe:"t-…"} – die Oberfläche bekommt einheitlich {aufgabe}.
    if (daten.aufgabe !== undefined && daten.ergebnis === undefined) return { ergebnis: { aufgabe: daten.aufgabe } };
    return { ergebnis: daten.ergebnis === undefined ? null : daten.ergebnis };
  }
  if (daten && daten.ok === false && daten.fehler) {
    const f = daten.fehler;
    return { fehler: new ApiFehler(f.code, f.meldung || texte(f.code, f.details), f.details, status) };
  }
  if (status === 401) return { fehler: new ApiFehler('E_ANMELDUNG', texte('E_ANMELDUNG'), undefined, 401) };
  if (status === 403) return { fehler: new ApiFehler('E_RECHTE', texte('E_RECHTE'), undefined, 403) };
  if (status === 404) return { fehler: new ApiFehler('E_NICHT_GEFUNDEN', texte('E_NICHT_GEFUNDEN'), undefined, 404) };
  // Nackte 413 = ein Proxy davor (z. B. Nginx Proxy Manager, client_max_body_size) hat die Datei abgewiesen – der
  // Web-Dienst selbst antwortet immer mit JSON. Kein voller Speicher, deshalb eigene Meldung.
  if (status === 413) return { fehler: new ApiFehler('E_PARAMS', texte('PROXY_ZU_GROSS'), { status: 413, grund: 'proxy' }, 413) };
  if (status < 200 || status >= 300) return { fehler: new ApiFehler('E_UNBEKANNT', texte('E_UNBEKANNT', { status }), { status }, status) };
  return { ergebnis: daten && daten.ergebnis !== undefined ? daten.ergebnis : daten };
}

let letzter = null;
/** Letzter Fehler einer Anfrage (für „Was tun?“): {code, meldung, details, zeit, pfad} | null. */
export function letzterFehler() { return letzter; }

async function anfrage(methode, pfad, body) {
  const kopf = { Accept: 'application/json' };
  const optionen = { method: methode, headers: kopf, credentials: 'same-origin', cache: 'no-store' };
  if (methode !== 'GET') {
    kopf['Content-Type'] = 'application/json';
    kopf['X-FAHNAS-CSRF'] = csrfToken();
    optionen.body = JSON.stringify(body ?? {});
  }
  let antwort;
  try { antwort = await fetch(pfad, optionen); } catch (e) {
    const f = new ApiFehler('E_UNBEKANNT', texte('NETZ'), { grund: 'netz', fehler: String((e && e.message) || e) }, 0);
    letzter = { code: f.code, meldung: f.message, details: f.details, zeit: Date.now(), pfad };
    throw f;
  }
  const text = await antwort.text();
  const { ergebnis, fehler } = antwortAuswerten(antwort.status, text);
  if (fehler) { letzter = { code: fehler.code, meldung: fehler.message, details: fehler.details, zeit: Date.now(), pfad }; throw fehler; }
  return ergebnis;
}

/** GET /api/… → ergebnis */
export function get(pfad) { return anfrage('GET', pfad); }
/** POST /api/… mit JSON-Body → ergebnis */
export function post(pfad, body) { return anfrage('POST', pfad, body); }
/** Agent-Aktion: POST /api/agent/<aktion> mit params als Body. Aufgaben liefern {aufgabe}. */
export function api(aktion, params) {
  if (typeof aktion !== 'string' || !/^[a-z]+(\.[a-z_]+)+$/.test(aktion)) {
    return Promise.reject(new ApiFehler('E_PARAMS', texte('E_PARAMS'), { feld: 'aktion' }));
  }
  return post(`/api/agent/${aktion}`, params ?? {});
}

function kodiert(w) { return encodeURIComponent(w == null ? '' : String(w)); }

/** URL zum Herunterladen (Datei) bzw. als ZIP (Ordner). `anzeigen` = inline statt attachment (Vorschau). Cookies laufen mit. */
export function downloadUrl(freigabe, pfad, zip = false, anzeigen = false) {
  return `/api/dateien/herunterladen?freigabe=${kodiert(freigabe)}&pfad=${kodiert(pfad)}${zip ? '&zip=1' : ''}${anzeigen ? '&anzeigen=1' : ''}`;
}

/**
 * URL eines Vorschaubilds (Kachelansicht): `groesse` 128|256|512, `version` = Änderungszeit + Größe der Datei (aus der
 * Liste) – so bleibt das Bild lange im Browser-Cache und wechselt trotzdem mit der Datei. Cookies laufen mit.
 */
export function vorschauUrl(freigabe, pfad, groesse = 256, version = '') {
  return `/api/dateien/vorschau?freigabe=${kodiert(freigabe)}&pfad=${kodiert(pfad)}&groesse=${kodiert(groesse)}${version ? `&v=${kodiert(version)}` : ''}`;
}

/**
 * Lädt eine Datei hoch. Gibt {fertig: Promise, abbrechen()} zurück; `beiFortschritt(geladen, gesamt)` je Schritt.
 * `beiVorhanden`: 'fehler' (Standard – nie überschreiben), 'ersetzen' (alte Version → Papierkorb) oder 'beide'
 * („Name (n).ext“). `fertig` liefert {pfad, name, ersetzt, umbenannt} mit dem tatsächlichen Namen.
 * @param {{freigabe:string, pfad:string, name:string, datei:Blob, beiVorhanden?:string, beiFortschritt?:Function}} o
 */
export function hochladen({ freigabe, pfad, name, datei, beiVorhanden, beiFortschritt }) {
  const xhr = new XMLHttpRequest();
  const fertig = new Promise((ok, nein) => {
    const url = `/api/dateien/hochladen?freigabe=${kodiert(freigabe)}&pfad=${kodiert(pfad)}&name=${kodiert(name)}${beiVorhanden ? `&bei_vorhanden=${kodiert(beiVorhanden)}` : ''}`;
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-FAHNAS-CSRF', csrfToken());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => { if (beiFortschritt) beiFortschritt(e.loaded, e.lengthComputable ? e.total : (datei && datei.size) || 0); };
    }
    xhr.onload = () => {
      const { ergebnis, fehler } = antwortAuswerten(xhr.status, xhr.responseText);
      if (fehler) nein(fehler); else ok(ergebnis);
    };
    xhr.onerror = () => nein(new ApiFehler('E_UNBEKANNT', texte('NETZ'), { grund: 'netz' }, 0));
    xhr.onabort = () => nein(new ApiFehler('E_ABGEBROCHEN', texte('E_ABGEBROCHEN'), undefined, 0));
    xhr.ontimeout = () => nein(new ApiFehler('E_UNBEKANNT', texte('NETZ'), { grund: 'zeit' }, 0));
    try { xhr.send(datei); } catch (e) { nein(new ApiFehler('E_UNBEKANNT', texte('NETZ'), { grund: String(e && e.message) }, 0)); }
  });
  return { fertig, abbrechen: () => { try { xhr.abort(); } catch { /* egal */ } } };
}

/**
 * Lädt eine Datei als Blob (für Vorschauen). `maxBytes` schützt vor riesigen Downloads.
 */
export async function ladeBlob(freigabe, pfad, maxBytes = Infinity) {
  let antwort;
  try { antwort = await fetch(downloadUrl(freigabe, pfad), { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
    throw new ApiFehler('E_UNBEKANNT', texte('NETZ'), { grund: 'netz', fehler: String((e && e.message) || e) }, 0);
  }
  if (!antwort.ok) {
    const text = await antwort.text().catch(() => '');
    const { fehler } = antwortAuswerten(antwort.status, text);
    throw fehler || new ApiFehler('E_UNBEKANNT', texte('E_UNBEKANNT'), { status: antwort.status }, antwort.status);
  }
  const laenge = Number(antwort.headers.get('content-length') || 0);
  if (laenge && laenge > maxBytes) throw new ApiFehler('E_PLATZ', texte('ZU_GROSS'), { groesse: laenge, max: maxBytes }, 0);
  const blob = await antwort.blob();
  if (blob.size > maxBytes) throw new ApiFehler('E_PLATZ', texte('ZU_GROSS'), { groesse: blob.size, max: maxBytes }, 0);
  return blob;
}

export const SSE_ARTEN = Object.freeze(['messwerte', 'aufgabe', 'konfig', 'system', 'agent']);

/**
 * Dauerhafte SSE-Verbindung zu /api/ereignisse. `on(art, fn)` gibt eine Abmeldefunktion zurück.
 * Zusätzliche Kunst-Ereignisart `verbindung` mit {zustand:"offen"|"getrennt"} für den Rahmen.
 */
export function sseVerbinden(pfad = '/api/ereignisse') {
  const hoerer = new Map();
  let quelle = null;
  let zustand = 'geschlossen';
  let wartezeit = 2000;
  let timer = null;
  let gestoppt = false;

  function melde(art, daten) {
    const menge = hoerer.get(art);
    if (!menge) return;
    for (const fn of [...menge]) { try { fn(daten, art); } catch (e) { if (typeof console !== 'undefined') console.error('[sse]', art, e); } }
  }

  function parse(text) { try { return JSON.parse(text); } catch { return text; } }

  function oeffnen() {
    if (gestoppt || typeof EventSource === 'undefined') return;
    try { quelle = new EventSource(pfad, { withCredentials: true }); } catch { quelle = null; return; }
    for (const art of SSE_ARTEN) {
      quelle.addEventListener(art, (ev) => melde(art, parse(ev.data)));
    }
    quelle.onmessage = (ev) => {
      const d = parse(ev.data);
      const art = d && typeof d === 'object' ? (d.ereignis || d.art) : null;
      if (art) melde(art, d);
    };
    quelle.onopen = () => { zustand = 'offen'; wartezeit = 2000; melde('verbindung', { zustand: 'offen' }); };
    quelle.onerror = () => {
      const war = zustand;
      zustand = 'getrennt';
      if (war !== 'getrennt') melde('verbindung', { zustand: 'getrennt' });
      // Der Browser verbindet selbst neu; ist die Quelle endgültig zu (z. B. HTTP-Fehler), versuchen wir es später erneut.
      if (quelle && quelle.readyState === 2 && !gestoppt) {
        clearTimeout(timer);
        timer = setTimeout(() => { wartezeit = Math.min(30000, wartezeit * 2); oeffnen(); }, wartezeit);
      }
    };
  }

  return {
    on(art, fn) {
      if (!hoerer.has(art)) hoerer.set(art, new Set());
      hoerer.get(art).add(fn);
      return () => { const m = hoerer.get(art); if (m) { m.delete(fn); if (!m.size) hoerer.delete(art); } };
    },
    starten() { if (!quelle) oeffnen(); return this; },
    schliessen() { gestoppt = true; clearTimeout(timer); if (quelle) { quelle.close(); quelle = null; } zustand = 'geschlossen'; },
    get zustand() { return zustand; },
  };
}
