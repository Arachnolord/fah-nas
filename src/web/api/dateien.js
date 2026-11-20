// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rohdaten über den Datenkanal: GET /api/dateien/herunterladen (Datei oder ZIP eines Ordners), POST
// /api/dateien/hochladen (Body = Datei), GET /api/dateien/vorschau (Vorschaubild aus dateien.vorschau, base64 →
// Bildantwort mit langer Browser-Cachezeit; die URL trägt Änderungszeit + Größe der Datei und verfällt so mit ihr),
// GET /link/<token> (öffentliche Linkseite ohne Sitzung, Unterwege liste/datei/zip/vorschau) sowie die
// generischen Ticket-Wege GET /api/agent-download?ticket= und POST /api/agent-upload?ticket= (z. B. Export/Import).
// Der Web-Dienst holt ein Ticket beim Agenten und reicht die Bytes 1:1 durch – ohne sie zu puffern.
// Tickets sind an den Nutzer gebunden (Prüfbericht R1, Fund 3): der Datenkanal-Kopf lautet {ticket, nutzer} mit dem
// Sitzungsnutzer (bei /link dem Link-Ersteller aus dateien.link.pruefen), und die generischen Wege nehmen nur
// Tickets an, die in DERSELBEN Sitzung aus einem Aktionsergebnis kamen (fremd/unbekannt → 404).

import net from 'node:net';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { relativerPfad, pruefeDateiname, pruefeFreigabename } from '../../gemeinsam/pfade.js';
import { json } from '../server.js';
import { gastKontext, agentVerweigert } from './anmelden.js';
import { linkSchluessel } from '../links.js';

const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const TICKET = /^[A-Za-z0-9_-]{8,128}$/;
const FEHLER_KOPF = '{"fehler"';
const MAX_PRUEFPUFFER = 8192;
const TICKET_MERKEN_MS = 90_000; // Tickets gelten 60 s (§3); etwas länger merken reicht
const VORSCHAU_GROESSEN = new Set([128, 256, 512]);
const VORSCHAU_STANDARD = 256;
const VORSCHAU_CACHE_S = 7 * 24 * 3600; // die URL enthält Änderungszeit + Größe der Datei → darf lange im Browser bleiben
const VORSCHAU_MIME = /^image\/(webp|jpeg|png)$/;

/** Content-Disposition mit ASCII-Rückfall und RFC-5987-Name. */
export function dispositionsKopf(art, dateiname) {
  const name = String(dateiname || 'datei').replace(/[\r\n"\\/\u0000-\u001f]/g, '_').slice(0, 200);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const kodiert = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${art}; filename="${ascii}"; filename*=UTF-8''${kodiert}`;
}

/** Erkennt die Fehlerzeile des Agenten (§3): genau eine JSON-Zeile {"fehler":{code, meldung}} – sonst null. */
export function fehlerZeile(text) {
  const t = text.trim();
  if (!t.startsWith(FEHLER_KOPF) || t.includes('\n')) return null;
  try {
    const o = JSON.parse(t);
    if (o && o.fehler && typeof o.fehler.code === 'string') return new FahnasFehler(o.fehler.code, o.fehler.meldung || 'Fehler beim Zugriff auf die Datei', o.fehler.details);
  } catch { /* keine Fehlerzeile */ }
  return null;
}

/**
 * Öffnet den Datenkanal für ein Ticket und schickt EINE Kopfzeile {ticket, nutzer} (§3). Der Agent vergleicht
 * `nutzer` mit dem Nutzer, für den das Ticket angelegt wurde. Gibt den Socket (Duplex) zurück.
 */
export function datenkanalOeffnen(socketPfad, { ticket, nutzer, bereich = null }) {
  if (typeof ticket !== 'string' || !ticket) return Promise.reject(new FahnasFehler('E_TICKET', 'Ticket fehlt'));
  if (typeof nutzer !== 'string' || !nutzer) return Promise.reject(new FahnasFehler('E_AGENT', 'Kein Nutzer für den Datenkanal bekannt'));
  return new Promise((ok, nein) => {
    const s = net.createConnection(socketPfad);
    s.once('connect', () => { s.write(JSON.stringify(bereich ? { ticket, nutzer, bereich } : { ticket, nutzer }) + '\n'); ok(s); });
    s.once('error', (e) => nein(new FahnasFehler('E_AGENT', 'Datenkanal nicht erreichbar', { grund: e.message })));
  });
}

/**
 * Merkt sich Tickets aus Aktionsergebnissen (z. B. system.export, system.import.ticket) JE SITZUNG samt Metadaten
 * (dateiname, mime, groesse, art), damit /api/agent-download passende Kopfzeilen setzt und nur die eigene Sitzung
 * das Ticket einlösen kann.
 */
/**
 * HTTP-Range (ein Bereich) gegen die Dateigröße auswerten – zum Spulen in Videos (Betreiber 12.10.2026).
 * @returns {null|{start:number, ende:number}|{unerfuellbar:true}} null = kein/ungeeigneter Kopf → ganze Datei
 */
export function bereichAusRange(kopf, groesse) {
  if (typeof kopf !== 'string' || !Number.isFinite(groesse) || groesse < 0) return null;
  const m = /^bytes=(\d{0,18})-(\d{0,18})$/.exec(kopf.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // mehrere Bereiche o. Ä. → einfach die ganze Datei
  let start; let ende;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || groesse === 0) return { unerfuellbar: true };
    start = Math.max(0, groesse - n); ende = groesse - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== '' && Number(m[2]) < start) return null;
    ende = m[2] === '' ? groesse - 1 : Math.min(Number(m[2]), groesse - 1);
  }
  if (start >= groesse) return { unerfuellbar: true };
  return { start, ende };
}

export class Ticketmerker {
  constructor() { this.alle = new Map(); }
  merken(ergebnis, sitzung, nutzer) {
    if (!ergebnis || typeof ergebnis !== 'object' || typeof ergebnis.ticket !== 'string' || typeof sitzung !== 'string' || !sitzung) return;
    this.aufraeumen();
    this.alle.set(ergebnis.ticket, { sitzung, nutzer, dateiname: ergebnis.dateiname, mime: ergebnis.mime, groesse: ergebnis.groesse, art: ergebnis.art, bis: Date.now() + TICKET_MERKEN_MS });
  }
  /** Holt (und verbraucht) ein Ticket – nur für die Sitzung, die es bekommen hat. Fremd/unbekannt/abgelaufen → null; ein fremder Zugriff verbraucht nichts. */
  hole(ticket, sitzung) {
    const t = this.alle.get(ticket);
    if (!t) return null;
    if (t.bis <= Date.now()) { this.alle.delete(ticket); return null; }
    if (typeof sitzung !== 'string' || t.sitzung !== sitzung) return null;
    this.alle.delete(ticket);
    return t;
  }
  aufraeumen() { const jetzt = Date.now(); for (const [k, v] of this.alle) if (v.bis <= jetzt) this.alle.delete(k); if (this.alle.size > 1000) this.alle.clear(); }
}

/** HTML-Text ohne Markup (Titel der Linkseite). */
function html(text) { return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Hülle der Linkseite. `fehler` = 'ungueltig' | 'fehler' | null – dann ohne Skript, nur die Meldung (de/en). */
export function linkSeiteHtml(titel, fehler = null) {
  const kopf = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${html(titel || 'FAH-NAS')} – FAH-NAS</title>
<link rel="icon" href="/symbole.svg" type="image/svg+xml">
<link rel="stylesheet" href="/teilen.css">
</head>
<body>`;
  if (fehler) {
    const [de, en] = fehler === 'ungueltig'
      ? ['Dieser Link ist ungültig oder abgelaufen.', 'This link is invalid or has expired.']
      : ['Der Inhalt ist gerade nicht erreichbar. Bitte versuche es später noch einmal.', 'The content is currently unavailable. Please try again later.'];
    return `${kopf}
<main class="teilen-leer"><div class="teilen-meldung"><svg class="teilen-meldung-symbol" aria-hidden="true"><use href="/symbole.svg#symbol-link"></use></svg><p>${de}</p><p class="teilen-schwach" lang="en">${en}</p></div></main>
</body>
</html>
`;
  }
  return `${kopf}
<main id="teilen" class="teilen" aria-live="polite"></main>
<script type="module" src="/teilen.js"></script>
</body>
</html>
`;
}

export class DateienApi {
  constructor({ agent, protokoll, tickets = new Ticketmerker(), bremse = null, zugriffe = null }) { this.agent = agent; this.protokoll = protokoll; this.tickets = tickets; this.bremse = bremse; this.zugriffe = zugriffe; }

  /** Datenkanal zum Agenten (Socket-Pfad aus dem AgentClient), Kopf {ticket, nutzer}. */
  _kanal(ticket, nutzer, bereich = null) { return datenkanalOeffnen(this.agent.datenSocket, { ticket, nutzer, bereich }); }

  /** Ticket aus dem Merker für diese Sitzung – fremd/unbekannt → 404, ohne das Ticket des Besitzers zu verbrauchen. */
  _eigenesTicket(ctx, ticket, weg) {
    if (!ticket || !TICKET.test(ticket)) throw new FahnasFehler('E_PARAMS', 'Ticket fehlt oder ist ungültig', { feld: 'ticket' });
    const gemerkt = this.tickets.hole(ticket, ctx.sitzung ? ctx.sitzung.id : null);
    if (!gemerkt) {
      this.protokoll.eintrag('ticket_fremd', { nutzer: ctx.kontext.nutzer, ip: ctx.ip, weg, ticket: '***' });
      throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Ticket gehört nicht zu deiner Sitzung oder ist abgelaufen');
    }
    return gemerkt;
  }

  /**
   * Streamt ein Lese-/ZIP-Ticket als HTTP-Antwort. Bevor Kopfzeilen gesendet werden, wird geprüft, ob der Agent
   * statt Daten eine Fehlerzeile schickt (beginnt mit {"fehler" und endet mit Socket-Ende).
   * `nutzer` = Nutzer, für den das Ticket angelegt wurde (Sitzungsnutzer bzw. Link-Ersteller).
   */
  async herunterladen(ctx, ticket, { zip = false, anzeigen = false, nutzer, range = null, cache = 'no-store' } = {}) {
    const { res } = ctx;
    const g = Number(ticket.groesse);
    const groesseBekannt = !zip && ticket.groesse !== undefined && ticket.groesse !== null && Number.isFinite(g) && g >= 0;
    // Range (Spulen in Videos/Audio, fortgesetzte Downloads): nur bei einzelnen Dateien mit bekannter Größe
    const bereich = groesseBekannt && range ? bereichAusRange(range, g) : null;
    if (bereich && bereich.unerfuellbar) { res.writeHead(416, { 'Content-Range': `bytes */${g}`, 'Accept-Ranges': 'bytes' }); res.end(); return; }
    const sock = await this._kanal(ticket.ticket, nutzer, bereich ? { start: bereich.start, laenge: bereich.ende - bereich.start + 1 } : null);
    return new Promise((fertig, fehler) => {
      let erledigt = false;
      const ende = (e) => { if (erledigt) return; erledigt = true; if (e) fehler(e); else fertig(); };
      let puffer = []; let pufferLaenge = 0; let entschieden = false;
      const kopfSenden = () => {
        const kopf = {
          'Content-Type': zip ? 'application/zip' : (typeof ticket.mime === 'string' && ticket.mime ? ticket.mime : 'application/octet-stream'),
          'Content-Disposition': dispositionsKopf(anzeigen ? 'inline' : 'attachment', ticket.dateiname),
          'Cache-Control': cache,
        };
        // Vorschau im eigenen Rahmen (PDF): die Seite selbst darf die Antwort einbetten, fremde Seiten nicht.
        if (anzeigen) {
          // Aktive Inhalte (HTML, SVG, XML, Skripte) niemals als Dokument im eigenen Ursprung anzeigen (XSS) → als Text.
          if (/html|xml|svg|javascript|ecmascript/i.test(String(kopf['Content-Type']))) kopf['Content-Type'] = 'text/plain; charset=utf-8';
          kopf['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'self'";
          kopf['X-Frame-Options'] = 'SAMEORIGIN';
        }
        if (groesseBekannt) kopf['Accept-Ranges'] = 'bytes';
        if (bereich) {
          kopf['Content-Range'] = `bytes ${bereich.start}-${bereich.ende}/${g}`;
          kopf['Content-Length'] = String(bereich.ende - bereich.start + 1);
          res.writeHead(206, kopf);
          return;
        }
        if (groesseBekannt) kopf['Content-Length'] = String(g);
        res.writeHead(200, kopf);
      };
      const dateiEntscheiden = () => {
        entschieden = true;
        kopfSenden();
        for (const t of puffer) res.write(t);
        puffer = [];
      };
      res.on('close', () => { if (!res.writableFinished && !erledigt) { sock.destroy(); ende(); } });
      sock.on('data', (teil) => {
        if (erledigt) return;
        if (entschieden) {
          if (!res.write(teil)) { sock.pause(); res.once('drain', () => sock.resume()); }
          return;
        }
        puffer.push(teil); pufferLaenge += teil.length;
        const kopf = Buffer.concat(puffer).subarray(0, FEHLER_KOPF.length).toString('latin1');
        if (pufferLaenge < FEHLER_KOPF.length) { if (!FEHLER_KOPF.startsWith(kopf)) dateiEntscheiden(); return; }
        if (kopf !== FEHLER_KOPF || pufferLaenge > MAX_PRUEFPUFFER) dateiEntscheiden();
      });
      sock.on('end', () => {
        if (erledigt) return;
        if (!entschieden) {
          if (pufferLaenge > 0) {
            const f = fehlerZeile(Buffer.concat(puffer).toString('utf8'));
            if (f) return ende(f);
          }
          dateiEntscheiden();
        }
        res.end();
        ende();
      });
      sock.on('error', (e) => {
        if (erledigt) return;
        if (!res.headersSent) return ende(new FahnasFehler('E_AGENT', 'Der Datenkanal wurde unterbrochen', { grund: e.message }));
        res.destroy(); ende();
      });
    });
  }

  /**
   * Schickt den Anfragetext 1:1 in den Datenkanal (Ticket „schreiben“) und liest die Antwortzeile des Agenten.
   * @returns {Promise<{ok:boolean, bestaetigt:boolean}>} ok=false nur, wenn der Agent eine Fehlerzeile schickte (wird geworfen)
   */
  async _hochladenStrom(ctx, ticket, nutzer) {
    const { req } = ctx;
    const sock = await this._kanal(ticket, nutzer);
    let komplett = false; let abgebrochen = false;
    const antwort = new Promise((ok, nein) => {
      let text = ''; let zu = false;
      sock.on('data', (d) => { text += d.toString('utf8'); if (text.length > 65536) sock.destroy(); });
      sock.on('end', () => { if (!zu) { zu = true; ok(text); } });
      sock.on('close', () => { if (!zu) { zu = true; ok(text); } });
      sock.on('error', (e) => { if (!zu) { zu = true; if (komplett) ok(text); else nein(new FahnasFehler('E_AGENT', 'Der Datenkanal wurde unterbrochen', { grund: e.message })); } });
    });
    req.on('end', () => { komplett = true; });
    req.on('error', () => {});
    req.on('close', () => { if (!komplett) { abgebrochen = true; sock.destroy(); } });
    req.pipe(sock);
    const text = await antwort;
    if (abgebrochen) throw new FahnasFehler('E_ABGEBROCHEN', 'Das Hochladen wurde abgebrochen');
    const zeile = text.trim().split('\n').pop();
    let obj = null;
    if (zeile) { try { obj = JSON.parse(zeile); } catch { obj = null; } }
    if (obj && obj.fehler && typeof obj.fehler.code === 'string') throw new FahnasFehler(obj.fehler.code, obj.fehler.meldung || 'Schreiben fehlgeschlagen', obj.fehler.details);
    return { ok: true, bestaetigt: !!(obj && obj.ok === true), ergebnis: obj && obj.ok === true && obj.ergebnis && typeof obj.ergebnis === 'object' ? obj.ergebnis : null };
  }

  /**
   * POST /api/dateien/hochladen?freigabe=&pfad=&name=[&bei_vorhanden=fehler|ersetzen|beide] – Body 1:1 in den Datenkanal
   * (Content-Length Pflicht). Ohne bei_vorhanden wird nichts überschrieben (E_EXISTIERT). Antwort mit dem tatsächlichen
   * Namen (bei „beide“ ggf. „Name (n).ext“) und ob eine vorhandene Datei ersetzt wurde.
   */
  async hochladen(ctx) {
    const { req, res, query, kontext } = ctx;
    const freigabe = pruefeFreigabename(query.get('freigabe'));
    const ordner = relativerPfad(query.get('pfad') || '');
    const name = pruefeDateiname(query.get('name'));
    const beiVorhanden = query.get('bei_vorhanden') || 'fehler';
    const groesse = inhaltslaenge(req);
    const pfad = ordner ? `${ordner}/${name}` : name;
    const ticket = await this.agent.aktion('dateien.ticket', { freigabe, pfad, art: 'schreiben', groesse, bei_vorhanden: beiVorhanden }, kontext);
    const { bestaetigt, ergebnis } = await this._hochladenStrom(ctx, ticket.ticket, kontext.nutzer);
    if (ergebnis && typeof ergebnis.pfad === 'string') {
      json(res, 200, { ok: true, ergebnis: { freigabe, pfad: ergebnis.pfad, name: ergebnis.name, groesse, ersetzt: !!ergebnis.ersetzt, umbenannt: !!ergebnis.umbenannt, papierkorb: ergebnis.papierkorb || null } });
      return;
    }
    if (!bestaetigt) {
      // Keine Antwortzeile (Halbschluss auf dem Datenkanal, siehe docs/abweichungen.md D1) → Datei nachprüfen
      let info = null;
      try { info = await this.agent.aktion('dateien.info', { freigabe, pfad }, kontext); } catch { info = null; }
      if (!info || Number(info.groesse) !== groesse) {
        throw new FahnasFehler('E_AGENT', 'Keine Rückmeldung vom Datenkanal – bitte prüfe, ob die Datei vollständig angekommen ist', { pfad });
      }
      this.protokoll.eintrag('hochladen_ohne_antwort', { nutzer: kontext.nutzer, freigabe, pfad, groesse });
    }
    json(res, 200, { ok: true, ergebnis: { freigabe, pfad, name, groesse } });
  }

  /**
   * GET /api/dateien/vorschau?freigabe=&pfad=&groesse=128|256|512[&v=…] – Vorschaubild (Bild/Video) aus `dateien.vorschau`
   * als Bildantwort. `v` (Änderungszeit + Größe aus der Liste) wird nicht ausgewertet; es macht die URL je Dateistand
   * eindeutig, deshalb darf der Browser die Antwort 7 Tage behalten. Fehler kommen als JSON (das <img> zeigt dann das Symbol).
   */
  async vorschau(ctx) {
    const { res, query, kontext } = ctx;
    const freigabe = pruefeFreigabename(query.get('freigabe'));
    const pfad = relativerPfad(query.get('pfad') || '');
    if (!pfad) throw new FahnasFehler('E_PARAMS', 'Pfad fehlt', { feld: 'pfad' });
    const roh = query.get('groesse');
    const groesse = roh === null || roh === '' ? VORSCHAU_STANDARD : Number(roh);
    if (!VORSCHAU_GROESSEN.has(groesse)) throw new FahnasFehler('E_PARAMS', 'Größe muss 128, 256 oder 512 sein', { feld: 'groesse' });
    if (res.destroyed || ctx.req.destroyed) return; // Browser hat die Kachel schon verworfen – den Agenten nicht mehr bemühen
    const erg = await this.agent.aktion('dateien.vorschau', { freigabe, pfad, groesse }, kontext);
    if (res.destroyed) return;
    if (!erg || typeof erg.daten !== 'string' || !erg.daten) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte kein Vorschaubild');
    const daten = Buffer.from(erg.daten, 'base64');
    if (!daten.length) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte ein leeres Vorschaubild');
    const mime = typeof erg.mime === 'string' && VORSCHAU_MIME.test(erg.mime) ? erg.mime : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': mime, 'Content-Length': String(daten.length),
      'Cache-Control': `private, max-age=${VORSCHAU_CACHE_S}, immutable`,
      'Content-Disposition': 'inline',
      // nie als Dokument im eigenen Ursprung ausführbar, nur als Bild einbettbar
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(daten);
  }

  /** POST /api/agent-upload?ticket= – Body 1:1 in ein Schreib-Ticket, das eine Aktion DIESER Sitzung (z. B. system.import.ticket) geliefert hat. */
  async ticketHochladen(ctx) {
    const { req, res, query, kontext } = ctx;
    const ticket = query.get('ticket');
    if (!ticket || !TICKET.test(ticket)) throw new FahnasFehler('E_PARAMS', 'Ticket fehlt oder ist ungültig', { feld: 'ticket' });
    const groesse = inhaltslaenge(req); // vor dem Verbrauchen des Merker-Eintrags prüfen
    this._eigenesTicket(ctx, ticket, 'agent-upload');
    const { bestaetigt } = await this._hochladenStrom(ctx, ticket, kontext.nutzer);
    // Ohne Antwortzeile (D1) lässt sich das Ziel hier nicht nachprüfen; die folgende Aktion (z. B. system.import)
    // prüft das Archiv selbst. Wir melden ehrlich bestaetigt:false.
    if (!bestaetigt) this.protokoll.eintrag('hochladen_ohne_antwort', { nutzer: kontext.nutzer, ticket: '***', groesse });
    json(res, 200, { ok: true, ergebnis: { groesse, bestaetigt } });
  }

  /** GET /api/agent-download?ticket=[&dateiname=&mime=&anzeigen=1] – Lese-Ticket aus einem Aktionsergebnis DIESER Sitzung streamen. */
  async ticketHerunterladen(ctx) {
    const { query, kontext } = ctx;
    const ticket = query.get('ticket');
    const gemerkt = this._eigenesTicket(ctx, ticket, 'agent-download');
    const dateiname = gemerkt.dateiname || query.get('dateiname') || 'download';
    const mimeAnfrage = query.get('mime');
    const mime = gemerkt.mime || (mimeAnfrage && /^[\w.+-]+\/[\w.+-]+(; ?charset=[\w-]+)?$/.test(mimeAnfrage) ? mimeAnfrage : undefined);
    await this.herunterladen(ctx, { ticket, dateiname: pruefeDateiname(dateiname, 'dateiname'), mime, groesse: gemerkt.groesse }, { zip: gemerkt.art === 'zip', anzeigen: query.get('anzeigen') === '1', nutzer: kontext.nutzer });
  }

  routen(router) {
    router.add('GET', '/api/dateien/herunterladen', { sitzung: 'voll' }, async (ctx) => {
      const { query, kontext } = ctx;
      const freigabe = pruefeFreigabename(query.get('freigabe'));
      const pfad = relativerPfad(query.get('pfad') || '');
      const zip = query.get('zip') === '1';
      const ticket = await this.agent.aktion('dateien.ticket', { freigabe, pfad, art: zip ? 'zip' : 'lesen' }, kontext);
      await this.herunterladen(ctx, ticket, { zip, anzeigen: query.get('anzeigen') === '1', nutzer: kontext.nutzer, range: zip ? null : ctx.req.headers.range });
    });

    router.add('GET', '/api/dateien/vorschau', { sitzung: 'voll' }, (ctx) => this.vorschau(ctx));
    router.add('POST', '/api/dateien/hochladen', { sitzung: 'voll', csrf: true }, (ctx) => this.hochladen(ctx));
    router.add('GET', '/api/agent-download', { sitzung: 'voll' }, (ctx) => this.ticketHerunterladen(ctx));
    router.add('POST', '/api/agent-upload', { sitzung: 'voll', csrf: true }, (ctx) => this.ticketHochladen(ctx));

    // Kachel „Freigabelinks“: eigene Links (Admin: alle) mit Zugriffen (wer gerade zugreift, zuletzt, Aufrufe) und Orten
    router.add('GET', '/api/links', { sitzung: 'voll' }, async (ctx) => {
      const roh = await this.agent.aktion('dateien.link.liste', {}, ctx.kontext);
      const leer = { aufrufe: 0, zuletzt: null, aktiv: [] };
      const links = (Array.isArray(roh) ? roh : []).map((l) => ({ ...l, zugriffe: this.zugriffe ? this.zugriffe.stand(l.token) : leer }));
      const ips = [...new Set(links.flatMap((l) => [...l.zugriffe.aktiv.map((a) => a.ip), l.zugriffe.zuletzt && l.zugriffe.zuletzt.ip]).filter((ip) => ip && ip !== '-'))].slice(0, 100);
      let orte = {};
      if (ips.length) { try { orte = (await this.agent.aktion('netz.orte', { ips }, ctx.kontext)) || {}; } catch { orte = {}; } }
      json(ctx.res, 200, { ok: true, ergebnis: { links, orte } });
    });

    // ---- Freigabelinks (öffentlich, ohne Sitzung) ------------------------------------------------------------------
    // GET /link/<token> = Linkseite (Ordner durchblättern, Dateien ansehen; public/teilen.js). ?herunterladen=1 = wie früher
    // direkt herunterladen (Datei bzw. ZIP des Ordners). Unterwege: liste (JSON), datei (?anzeigen=1, Range), zip, vorschau.
    router.add('GET', '/link/:token', { sitzung: 'keine' }, (ctx) => {
      if (ctx.query.get('herunterladen') === '1' || ctx.query.get('anzeigen') === '1') return this._linkDirekt(ctx);
      return this._linkSeite(ctx);
    });
    router.add('GET', '/link/:token/liste', { sitzung: 'keine' }, async (ctx) => {
      const erg = await this._linkAgent(ctx, { pfad: ctx.query.get('pfad') || '', was: 'liste' });
      this.zugriffe?.treffer(ctx.params.token, ctx.ip);
      const { nutzer: _ersteller, ...oeffentlich } = erg || {}; // der Kontoname des Erstellers bleibt intern
      json(ctx.res, 200, { ok: true, ergebnis: oeffentlich }, { 'X-Robots-Tag': 'noindex, nofollow' });
    });
    router.add('GET', '/link/:token/datei', { sitzung: 'keine' }, async (ctx) => {
      const { query, req } = ctx;
      const anzeigen = query.get('anzeigen') === '1';
      const range = req.headers.range;
      const ticket = await this._linkAgent(ctx, { pfad: query.get('pfad') || '', was: 'lesen' });
      // Spulen im Video schickt viele Range-Anfragen – als Aufruf zählt nur der Anfang
      const aufruf = !range || /^bytes=0-/.test(String(range));
      await this._linkStrom(ctx, ticket, { zip: false, anzeigen, range, aufruf, was: anzeigen ? 'ansehen' : 'herunterladen' });
    });
    router.add('GET', '/link/:token/zip', { sitzung: 'keine' }, async (ctx) => {
      const ticket = await this._linkAgent(ctx, { pfad: ctx.query.get('pfad') || '', was: 'zip' });
      await this._linkStrom(ctx, ticket, { zip: true, aufruf: true, was: 'zip' });
    });
    router.add('GET', '/link/:token/vorschau', { sitzung: 'keine' }, async (ctx) => {
      const { res, query } = ctx;
      const roh = query.get('groesse');
      const groesse = roh === null || roh === '' ? VORSCHAU_STANDARD : Number(roh);
      if (!VORSCHAU_GROESSEN.has(groesse)) throw new FahnasFehler('E_PARAMS', 'Größe muss 128, 256 oder 512 sein', { feld: 'groesse' });
      if (res.destroyed || ctx.req.destroyed) return;
      const erg = await this._linkAgent(ctx, { pfad: query.get('pfad') || '', was: 'vorschau', groesse });
      this.zugriffe?.treffer(ctx.params.token, ctx.ip);
      if (res.destroyed) return;
      const daten = Buffer.from(erg && typeof erg.daten === 'string' ? erg.daten : '', 'base64');
      if (!daten.length) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte kein Vorschaubild');
      const mime = typeof erg.mime === 'string' && VORSCHAU_MIME.test(erg.mime) ? erg.mime : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': mime, 'Content-Length': String(daten.length), 'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(daten);
    });
  }

  /**
   * Agent-Aufruf für einen Link (Rolle gast). Vorher die Bremse: wer Tokens durchprobiert, wird wie beim Anmelden
   * ausgebremst (unbekannte/abgelaufene Links zählen als Fehlversuch der IP). Fehler innerhalb eines gültigen Links
   * (Datei fehlt …) zählen nicht.
   */
  async _linkAgent(ctx, params) {
    const { ip } = ctx;
    const token = ctx.params.token;
    if (!TOKEN.test(token)) { this.bremse?.fehler(ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen', { link: 'ungueltig' }); }
    this.bremse?.pruefen(ip, '');
    try {
      return await this.agent.aktion('dateien.link.oeffnen', { token, ...params }, gastKontext(ip));
    } catch (e) {
      if (e.code === 'E_NICHT_GEFUNDEN' && e.details && e.details.link === 'ungueltig') {
        this.bremse?.fehler(ip, '');
        throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen', { link: 'ungueltig' });
      }
      if (e.code === 'E_RECHTE' && /Ersteller/.test(e.message || '')) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link gilt nicht mehr', { link: 'ungueltig' });
      if (e.code === 'E_RECHTE') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden');
      throw e;
    }
  }

  /** Datei/ZIP eines Links streamen; der Download zählt als „läuft gerade“, bis er fertig oder abgebrochen ist. */
  async _linkStrom(ctx, ticket, { zip, anzeigen = false, range = null, aufruf = false, was }) {
    const nutzer = ticket && typeof ticket.nutzer === 'string' && ticket.nutzer ? ticket.nutzer : null;
    if (!nutzer || typeof ticket.ticket !== 'string') {
      this.protokoll.eintrag('link_ohne_nutzer', { ip: ctx.ip });
      throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte keinen Link-Ersteller – der Download ist derzeit nicht möglich');
    }
    const griff = this.zugriffe ? this.zugriffe.treffer(ctx.params.token, ctx.ip, { aufruf, laufend: true }) : { ende() {} };
    if (aufruf) this.protokoll.eintrag('link_zugriff', { ip: ctx.ip, link: linkSchluessel(ctx.params.token), was, datei: ticket.dateiname });
    ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      await this.herunterladen(ctx, ticket, { zip, anzeigen, nutzer, range: zip ? null : range });
    } finally { griff.ende(); }
  }

  /** Alter Weg: Link direkt herunterladen (Datei bzw. ZIP des Ordners), für Skripte und vor 0.19 verschickte Links mit ?herunterladen=1. */
  async _linkDirekt(ctx) {
    const { params, query, ip } = ctx;
    if (!TOKEN.test(params.token)) { this.bremse?.fehler(ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen'); }
    this.bremse?.pruefen(ip, '');
    let erg;
    try {
      erg = await this.agent.aktion('dateien.link.pruefen', { token: params.token }, gastKontext(ip));
    } catch (e) {
      if (e.code === 'E_NICHT_GEFUNDEN' || e.code === 'E_TICKET' || e.code === 'E_PARAMS') { this.bremse?.fehler(ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen'); }
      throw agentVerweigert(e, 'dateien.link.pruefen', this.protokoll);
    }
    // Der Link-Ersteller (Feld `nutzer`, docs/abweichungen.md D4/B) ist der Nutzer im Datenkanal-Kopf.
    const nutzer = erg && typeof erg.nutzer === 'string' && erg.nutzer ? erg.nutzer : null;
    if (!nutzer) {
      this.protokoll.eintrag('link_ohne_nutzer', { ip });
      throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte keinen Link-Ersteller – der Download ist derzeit nicht möglich');
    }
    let ticket;
    if (typeof erg.ticket === 'string') {
      ticket = erg;
    } else if (typeof erg.freigabe === 'string') {
      // Rückfall: der Agent liefert nur die Beschreibung des Links → Ticket im Namen des Link-Erstellers holen
      ticket = await this.agent.aktion('dateien.ticket', { freigabe: erg.freigabe, pfad: erg.pfad || '', art: erg.art === 'zip' ? 'zip' : 'lesen' }, { nutzer, rolle: erg.rolle === 'admin' ? 'admin' : 'nutzer', ip });
      ticket.art = erg.art;
    } else {
      throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte kein Ticket für diesen Link');
    }
    const zip = erg.art === 'zip' || ticket.art === 'zip' || (typeof ticket.mime === 'string' && ticket.mime.startsWith('application/zip'));
    await this._linkStrom(ctx, { ...ticket, nutzer }, { zip, anzeigen: query.get('anzeigen') === '1', range: ctx.req.headers.range, aufruf: true, was: 'herunterladen' });
  }

  /**
   * Linkseite: kleine HTML-Hülle, den Inhalt baut public/teilen.js aus /link/<token>/liste. Ein ungültiger Link bekommt
   * gleich hier 404 (ohne Hülle mit Skript), damit Suchmaschinen und Vorschau-Bots nichts Brauchbares sehen.
   */
  async _linkSeite(ctx) {
    const { res } = ctx;
    let erg = null; let fehler = null;
    try { erg = await this._linkAgent(ctx, { pfad: '', was: 'liste' }); } catch (e) { fehler = e; }
    if (fehler && fehler.code === 'E_BREMSE') throw fehler;
    const titel = erg ? String(erg.name || 'FAH-NAS') : null;
    if (erg) {
      this.zugriffe?.treffer(ctx.params.token, ctx.ip, { aufruf: true });
      this.protokoll.eintrag('link_zugriff', { ip: ctx.ip, link: linkSchluessel(ctx.params.token), was: 'seite' });
    }
    const art = !fehler ? null : (fehler.code === 'E_NICHT_GEFUNDEN' ? 'ungueltig' : 'fehler');
    const seite = linkSeiteHtml(titel, art);
    res.writeHead(art === 'ungueltig' ? 404 : art ? 503 : 200, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(seite), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    });
    res.end(seite);
  }
}

/** Content-Length als Zahl; fehlt sie (chunked), E_PARAMS – der Agent braucht die Größe für die Kontingentprüfung. */
export function inhaltslaenge(req) {
  const cl = req.headers['content-length'];
  if (cl === undefined || !/^\d{1,18}$/.test(cl)) throw new FahnasFehler('E_PARAMS', 'Content-Length fehlt – die Größe der Datei muss bekannt sein', { feld: 'Content-Length' });
  return Number(cl);
}
