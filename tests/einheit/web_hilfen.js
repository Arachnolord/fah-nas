// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Test-Hilfen für den Web-Dienst: Attrappen-Agent (NDJSON über Unix-Socket + Datenkanal), HTTP-Client mit
// Cookie-Glas und CSRF, Start eines Web-Dienstes in einem Temp-Ordner. Keine Linux-Werkzeuge nötig.

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zeilenleser, sende, kennung } from '../../src/gemeinsam/protokoll.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { WebDienst } from '../../src/web/web.js';
import { loesen } from '../../public/anmeldung-aufgabe.js';

export const ROLLEN = { gast: 0, nutzer: 1, admin: 2, system: 3 };

export async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-web-')); }
export const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attrappe des Agenten: feste Aktionen, Rollenprüfung wie das echte Register, Datenkanal mit Tickets.
 * Der Datenkanal verlangt wie der echte Agent (Prüfbericht R1, Fund 3) den Kopf {ticket, nutzer} und vergleicht
 * `nutzer` mit dem Nutzer, für den das Ticket angelegt wurde – sonst Fehlerzeile E_TICKET.
 */
export class AgentAttrappe {
  constructor(ordner) {
    this.socketPfad = path.join(ordner, 'agent.sock');
    this.datenPfad = path.join(ordner, 'daten.sock');
    this.aktionen = new Map();
    this.anfragen = [];          // {aktion, params, kontext}
    this.tickets = new Map();    // ticket → {nutzer, art, inhalt?, pfad?, fehler?, ohneAntwort?, stueck?}
    this.geschrieben = new Map(); // pfad → Buffer
    this.datenKoepfe = [];       // empfangene Kopfzeilen des Datenkanals ({ticket, nutzer}), in Reihenfolge
    this.verbindungen = new Set();
    this.datenVerbindungen = 0;
    this.halbOffen = true;       // false = Grundlagen-Verhalten ohne allowHalfOpen (Antwortzeile geht verloren)
  }

  aktion(name, def) {
    if (typeof def === 'function') def = { rolle: 'nutzer', fn: def };
    this.aktionen.set(name, { rolle: def.rolle || 'nutzer', aufgabe: !!def.aufgabe, fn: def.fn });
  }

  ereignis(obj) { for (const s of this.verbindungen) sende(s, obj); }

  /** Ticket anlegen – wie beim echten Agenten immer an einen Nutzer gebunden. */
  ticketAnlegen(def) {
    if (!def || typeof def.nutzer !== 'string' || !def.nutzer) throw new Error('Attrappe: Ticket ohne nutzer');
    const t = kennung('k-') + kennung(''); this.tickets.set(t, def); return t;
  }

  async starten() {
    this.server = net.createServer((s) => this._steuer(s));
    await new Promise((ok, nein) => this.server.listen(this.socketPfad, (e) => (e ? nein(e) : ok())));
    this.datenServer = net.createServer({ allowHalfOpen: this.halbOffen }, (s) => this._daten(s));
    await new Promise((ok, nein) => this.datenServer.listen(this.datenPfad, (e) => (e ? nein(e) : ok())));
  }

  _steuer(socket) {
    this.verbindungen.add(socket);
    socket.on('close', () => this.verbindungen.delete(socket));
    socket.on('error', () => this.verbindungen.delete(socket));
    zeilenleser(socket, async (n) => {
      const id = n.id;
      const kontext = n.kontext || {};
      this.anfragen.push({ aktion: n.aktion, params: n.params, kontext });
      const antwort = (o) => sende(socket, { id, ...o });
      if (kontext.rolle === 'system') return antwort({ ok: false, fehler: new FahnasFehler('E_RECHTE', 'Systemrolle nur intern').toJSON() });
      if (n.aktion === 'agent.aktionen') {
        if (ROLLEN[kontext.rolle] < ROLLEN.nutzer) return antwort({ ok: false, fehler: new FahnasFehler('E_RECHTE', 'Dafür fehlt dir die Berechtigung').toJSON() });
        return antwort({ ok: true, ergebnis: [...this.aktionen].map(([name, a]) => ({ name, rolle: a.rolle, aufgabe: a.aufgabe, beschreibung: '' })) });
      }
      const a = this.aktionen.get(n.aktion);
      if (!a) return antwort({ ok: false, fehler: new FahnasFehler('E_NICHT_GEFUNDEN', `Unbekannte Aktion „${n.aktion}“`).toJSON() });
      if (!(kontext.rolle in ROLLEN) || ROLLEN[kontext.rolle] < ROLLEN[a.rolle]) return antwort({ ok: false, fehler: new FahnasFehler('E_RECHTE', 'Dafür fehlt dir die Berechtigung', { aktion: n.aktion, noetig: a.rolle }).toJSON() });
      try {
        const erg = await a.fn(n.params || {}, kontext, this);
        if (erg && typeof erg === 'object' && typeof erg.aufgabe === 'string' && Object.keys(erg).length === 1) return antwort({ ok: true, aufgabe: erg.aufgabe });
        antwort({ ok: true, ergebnis: erg === undefined ? null : erg });
      } catch (e) {
        antwort({ ok: false, fehler: FahnasFehler.aus(e).toJSON() });
      }
    }, () => socket.destroy());
  }

  _daten(socket) {
    this.datenVerbindungen++;
    let puffer = Buffer.alloc(0);
    socket.on('error', () => {});
    const beiDaten = (teil) => {
      puffer = Buffer.concat([puffer, teil]);
      const i = puffer.indexOf(0x0a);
      if (i < 0) return;
      socket.removeListener('data', beiDaten);
      let anfrage;
      try { anfrage = JSON.parse(puffer.subarray(0, i).toString('utf8')); } catch { sende(socket, { fehler: new FahnasFehler('E_PARAMS', 'Ungültiger Kopf').toJSON() }); return socket.end(); }
      this.datenKoepfe.push(anfrage);
      const rest = puffer.subarray(i + 1);
      const t = this.tickets.get(anfrage.ticket);
      this.tickets.delete(anfrage.ticket);
      if (!t) { sende(socket, { fehler: new FahnasFehler('E_TICKET', 'Ticket ungültig oder abgelaufen').toJSON() }); return socket.end(); }
      // Nutzerbindung wie im echten Datenkanal: Kopf ohne `nutzer` oder mit fremdem Nutzer → E_TICKET
      if (typeof anfrage.nutzer !== 'string' || anfrage.nutzer !== t.nutzer) { sende(socket, { fehler: new FahnasFehler('E_TICKET', 'Ticket gehört einem anderen Nutzer').toJSON() }); return socket.end(); }
      if (t.fehler) { sende(socket, { fehler: t.fehler }); return socket.end(); }
      if (t.art === 'lesen' || t.art === 'zip') {
        const inhalt = t.inhalt || Buffer.alloc(0);
        const stueck = t.stueck || 4096;
        let pos = 0;
        const weiter = () => {
          if (socket.destroyed) return;
          if (pos >= inhalt.length) return socket.end();
          const ok = socket.write(inhalt.subarray(pos, pos + stueck)); pos += stueck;
          if (ok) setImmediate(weiter); else socket.once('drain', weiter);
        };
        weiter();
        return;
      }
      // schreiben
      const teile = [rest];
      socket.on('data', (d) => teile.push(d));
      socket.on('end', () => {
        this.geschrieben.set(t.pfad, Buffer.concat(teile));
        if (t.ohneAntwort || !this.halbOffen) { socket.destroy(); return; }
        sende(socket, t.antwort || { ok: true });
        socket.end();
      });
    };
    socket.on('data', beiDaten);
  }

  async stoppen() {
    for (const s of this.verbindungen) s.destroy();
    if (this.server) await new Promise((ok) => this.server.close(() => ok()));
    if (this.datenServer) await new Promise((ok) => this.datenServer.close(() => ok()));
  }
}

/** Attrappe mit den Standard-Aktionen, die der Web-Dienst braucht, plus Testaktionen. */
export async function standardAttrappe(ordner) {
  const a = new AgentAttrappe(ordner);
  a.nutzer = {
    fabian: { passwort: 'geheim123', rolle: 'admin', anzeigename: 'Fabian H.', totp: false },
    tina: { passwort: 'tina1234', rolle: 'nutzer', anzeigename: 'Tina', totp: true, code: '123456' },
  };
  a.ersteinrichtungNoetig = false;
  a.startcode = 'ABCD1234';
  a.dateien = new Map(); // "freigabe/pfad" → Buffer
  a.links = new Map();   // token → {freigabe, pfad, nutzer} (nutzer = Link-Ersteller, Standard fabian)

  a.aktion('nutzer.pruefen', { rolle: 'gast', fn: ({ name, passwort }) => {
    const n = a.nutzer[name];
    if (!n || n.passwort !== passwort) return { ok: false };
    return { ok: true, rolle: n.rolle, totp_noetig: !!n.totp, anzeigename: n.anzeigename };
  } });
  a.aktion('nutzer.totp.pruefen', { rolle: 'gast', fn: ({ name, code }) => ({ ok: !!(a.nutzer[name] && a.nutzer[name].code === code) }) });
  a.aktion('system.ersteinrichtung.status', { rolle: 'gast', fn: () => ({ noetig: a.ersteinrichtungNoetig }) });
  a.aktion('system.ersteinrichtung', { rolle: 'gast', fn: ({ startcode, admin }) => {
    if (!a.ersteinrichtungNoetig) throw new FahnasFehler('E_EXISTIERT', 'Es gibt schon einen Admin');
    if (startcode !== a.startcode) throw new FahnasFehler('E_ANMELDUNG', 'Startcode falsch', { verbleibend: 4 });
    a.nutzer[admin.name] = { passwort: admin.passwort, rolle: 'admin', anzeigename: admin.anzeigename, totp: false };
    a.ersteinrichtungNoetig = false;
    return { ok: true };
  } });
  a.aktion('nutzer.loeschen', { rolle: 'admin', fn: ({ name }) => { delete a.nutzer[name]; return { geloescht: name }; } });
  a.aktion('nutzer.aendern', { rolle: 'admin', fn: (p) => { Object.assign(a.nutzer[p.name] || {}, p); return { ...p }; } });
  a.aktion('nutzer.umbenennen', { rolle: 'admin', fn: ({ name, neu }) => { a.nutzer[neu] = a.nutzer[name]; delete a.nutzer[name]; return { name: neu, alt: name }; } });
  a.aktion('nutzer.passwort', { rolle: 'nutzer', fn: ({ name, passwort }) => { if (a.nutzer[name]) a.nutzer[name].passwort = passwort; return { ok: true }; } });
  a.aktion('test.echo', { rolle: 'nutzer', fn: (params, kontext) => ({ params, kontext }) });
  a.aktion('test.admin', { rolle: 'admin', fn: () => 'geheim' });
  a.aktion('test.system', { rolle: 'system', fn: () => 'nie' });
  a.aktion('test.aufgabe', { rolle: 'nutzer', aufgabe: true, fn: () => ({ aufgabe: 't-test1' }) });
  a.aktion('test.fehler', { rolle: 'nutzer', fn: ({ code, meldung }) => { throw new FahnasFehler(code, meldung || 'Testfehler', { feld: 'x' }); } });
  // Fehler mit Interna (absolute Pfade, Befehlszeile, stderr) – wie E_SYSTEM aus system.befehl / dateien.*
  a.aktion('test.fehler_details', { rolle: 'nutzer', fn: () => { throw new FahnasFehler('E_SYSTEM', 'Befehl fehlgeschlagen', { feld: 'pfad', befehl: ['rm', '-r', '/data/shares/medien/x'], ausgabe: 'rm: cannot remove', pfad: '/data/shares/medien/x', grund: 'ENOENT' }); } });
  // Antwortet nie – für den Verbindungsabriss zum Agenten mitten in einer Anfrage
  a.aktion('test.haengt', { rolle: 'nutzer', fn: () => new Promise(() => {}) });
  // Ticket ohne Metadaten (nur {ticket}) – Dateiname/MIME müssen dann aus der Anfrage kommen
  a.aktion('test.ticket_roh', { rolle: 'nutzer', fn: (params, kontext) => ({ ticket: a.ticketAnlegen({ nutzer: kontext.nutzer, art: 'lesen', inhalt: Buffer.from('roh') }) }) });
  a.aktion('dateien.ticket', { rolle: 'nutzer', fn: ({ freigabe, pfad, art, groesse }, kontext) => {
    const schluessel = `${freigabe}/${pfad}`;
    const nutzer = kontext.nutzer;
    if (art === 'schreiben') return { ticket: a.ticketAnlegen({ nutzer, art, pfad: schluessel, ohneAntwort: a.ohneAntwort, antwort: a.schreibAntwort }), dateiname: path.basename(pfad), groesse, mime: 'application/octet-stream' };
    if (art === 'zip') return { ticket: a.ticketAnlegen({ nutzer, art, inhalt: Buffer.from('PK\u0003\u0004zip-attrappe') }), dateiname: `${path.basename(pfad) || freigabe}.zip`, mime: 'application/zip' };
    const inhalt = a.dateien.get(schluessel);
    if (!inhalt) return { ticket: a.ticketAnlegen({ nutzer, art, fehler: new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei nicht gefunden').toJSON() }), dateiname: path.basename(pfad), mime: 'application/octet-stream' };
    return { ticket: a.ticketAnlegen({ nutzer, art, inhalt, stueck: 1000 }), dateiname: path.basename(pfad), groesse: inhalt.length, mime: 'text/plain; charset=utf-8' };
  } });
  // Export/Import wie Teil C: Tickets ohne Freigabe-Bezug (generische Ticket-Wege des Web-Dienstes)
  a.exportInhalt = Buffer.from('export-archiv-attrappe');
  a.aktion('system.export', { rolle: 'admin', fn: ({ mit_geheimnissen }, kontext) => ({ ticket: a.ticketAnlegen({ nutzer: kontext.nutzer, art: 'lesen', inhalt: a.exportInhalt }), dateiname: `fahnas-konfig${mit_geheimnissen ? '-geheim' : ''}.tar.zst`, groesse: a.exportInhalt.length, mime: 'application/zstd' }) });
  a.aktion('system.import.ticket', { rolle: 'admin', fn: ({ dateiname, groesse }, kontext) => ({ ticket: a.ticketAnlegen({ nutzer: kontext.nutzer, art: 'schreiben', pfad: `eingang/${dateiname}`, ohneAntwort: a.ohneAntwort }), dateiname, groesse }) });
  a.aktion('dateien.info', { rolle: 'nutzer', fn: ({ freigabe, pfad }) => { const b = a.geschrieben.get(`${freigabe}/${pfad}`); if (!b) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Nicht gefunden'); return { name: path.basename(pfad), groesse: b.length }; } });
  a.aktion('dateien.link.pruefen', { rolle: 'gast', fn: ({ token }) => {
    const l = a.links.get(token);
    if (!l) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Link unbekannt');
    const inhalt = a.dateien.get(`${l.freigabe}/${l.pfad}`);
    const nutzer = l.nutzer || 'fabian';
    // Form (a) aus docs/abweichungen.md D4/B: Ticket im Namen des Link-Erstellers, `nutzer` = Ersteller
    const erg = { ticket: a.ticketAnlegen({ nutzer, art: 'lesen', inhalt }), dateiname: path.basename(l.pfad), groesse: inhalt.length, mime: 'application/pdf', art: 'lesen', freigabe: l.freigabe, pfad: l.pfad, nutzer };
    if (l.ohneNutzer) delete erg.nutzer;
    return erg;
  } });
  // Linkseite (0.19): Ordner-Links listen Einträge aus a.dateien („freigabe/pfad/…“); Unterpfade relativ zum Link
  a.aktion('dateien.link.oeffnen', { rolle: 'gast', fn: ({ token, pfad = '', was }) => {
    const l = a.links.get(token);
    if (!l) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen', { link: 'ungueltig' });
    const nutzer = l.nutzer || 'fabian';
    const voll = [l.freigabe, l.pfad, pfad].filter(Boolean).join('/');
    const kopf = { name: path.basename(l.pfad || l.freigabe), art_link: l.art || 'datei', ablauf: l.ablauf ?? null, nutzer };
    if (was === 'liste') {
      if (a.dateien.has(voll)) return { ...kopf, art: 'datei', pfad, eintrag: { name: path.basename(voll), art: 'datei', groesse: a.dateien.get(voll).length, mime: 'application/pdf', vorschau: false } };
      const praefix = `${voll}/`;
      const namen = [...new Set([...a.dateien.keys()].filter((k) => k.startsWith(praefix)).map((k) => k.slice(praefix.length).split('/')[0]))];
      if (!namen.length) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
      return { ...kopf, art: 'ordner', pfad, eintraege: namen.map((n) => ({ name: n, art: a.dateien.has(praefix + n) ? 'datei' : 'ordner', groesse: a.dateien.get(praefix + n)?.length ?? null })) };
    }
    if (was === 'vorschau') return { mime: 'image/webp', daten: Buffer.from('RIFFbild').toString('base64') };
    if (was === 'zip') return { ticket: a.ticketAnlegen({ nutzer, art: 'zip', inhalt: Buffer.from('PK\u0003\u0004zip-attrappe') }), dateiname: `${path.basename(voll)}.zip`, mime: 'application/zip', art: 'zip', nutzer };
    const inhalt = a.dateien.get(voll);
    if (!inhalt) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
    return { ticket: a.ticketAnlegen({ nutzer, art: 'lesen', inhalt, stueck: a.stueck }), dateiname: path.basename(voll), groesse: inhalt.length, mime: 'application/pdf', art: 'lesen', nutzer };
  } });
  a.aktion('dateien.link.liste', { rolle: 'nutzer', fn: (_p, kontext) => [...a.links.entries()]
    .filter(([, l]) => kontext.rolle === 'admin' || (l.nutzer || 'fabian') === kontext.nutzer)
    .map(([token, l]) => ({ token, url: `/link/${token}`, freigabe: l.freigabe, pfad: l.pfad, name: path.basename(l.pfad || l.freigabe), art: l.art || 'datei', nutzer: l.nutzer || 'fabian', ablauf: l.ablauf ?? null })) });
  a.landVon = { '203.0.113.5': 'DE', '198.51.100.7': 'US' }; // Länder für die Ländersperre der Anmeldung
  a.aktion('netz.land', { rolle: 'gast', fn: ({ ip }) => ({ ip, land: a.landVon[ip] || null, land_name: null, stadt: a.landVon[ip] === 'DE' ? 'Musterstadt' : null, geo: 'land' }) });
  a.meldungen = [];
  a.aktion('benachrichtigungen.anmeldung', { rolle: 'gast', fn: (p) => { a.meldungen.push(p); return { ok: true }; } });
  a.aktion('netz.orte', { rolle: 'nutzer', fn: ({ ips }) => Object.fromEntries(ips.map((ip) => [ip, ip === '203.0.113.5' ? { stadt: 'Musterstadt', land: 'DE', land_name: 'Deutschland' } : null])) });
  await a.starten();
  return a;
}

function setCookieLesen(liste, glas) {
  for (const c of liste || []) {
    const [paar, ...attr] = c.split(';');
    const i = paar.indexOf('=');
    const name = paar.slice(0, i).trim(); const wert = paar.slice(i + 1).trim();
    const maxAge = attr.map((x) => x.trim()).find((x) => x.toLowerCase().startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) glas.delete(name); else glas.set(name, wert);
  }
}

/** Eine HTTP-Anfrage; body: Objekt (JSON), String oder Buffer. */
export function anfrage(port, methode, pfad, { kopf = {}, body } = {}) {
  return new Promise((ok, nein) => {
    let daten = body;
    const h = { ...kopf };
    if (daten !== undefined && !Buffer.isBuffer(daten) && typeof daten !== 'string') { daten = JSON.stringify(daten); h['content-type'] = 'application/json'; }
    if (daten !== undefined && h['transfer-encoding'] === undefined) h['content-length'] = Buffer.byteLength(daten);
    let antwort = false; let fertig = false;
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: h }, (res) => {
      antwort = true;
      const teile = [];
      const abschluss = () => {
        if (fertig) return; fertig = true;
        const buf = Buffer.concat(teile);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* kein JSON */ }
        ok({ status: res.statusCode, kopf: res.headers, body: buf, text: buf.toString('utf8'), json, setCookie: res.headers['set-cookie'] || [] });
      };
      res.on('data', (t) => teile.push(t));
      res.on('end', abschluss);
      res.on('close', abschluss);
    });
    // Der Server darf die Verbindung nach einer frühen Antwort (z. B. 400 bei zu großem Body) schließen – dann
    // meldet der Client EPIPE/ECONNRESET, obwohl die Antwort schon da ist.
    req.on('error', (e) => { if (!antwort) nein(e); });
    if (daten !== undefined) req.write(daten, () => {});
    req.end();
  });
}

/** Rohe HTTP-Anfrage über einen TCP-Socket (für Kopfzeilen, die der Node-Client nicht zulässt). Gibt den Antworttext zurück. */
export function rohAnfrage(port, text) {
  return new Promise((ok, nein) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => s.write(text));
    let aus = '';
    s.on('data', (d) => { aus += d; });
    s.on('end', () => ok(aus)); s.on('close', () => ok(aus)); s.on('error', nein);
    setTimeout(() => s.destroy(), 2000).unref();
  });
}

export function rohKopf(text, name) {
  const m = new RegExp(`^${name}: (.*)$`, 'mi').exec(text);
  return m ? m[1].trim() : undefined;
}

/** Browser-Attrappe: merkt Cookies und schickt X-FAHNAS-CSRF bei schreibenden Anfragen automatisch. */
export class Browser {
  constructor(port) { this.port = port; this.glas = new Map(); }
  kopf(extra = {}, methode = 'GET') {
    const h = { ...extra };
    if (this.glas.size) h.cookie = [...this.glas].map(([k, v]) => `${k}=${v}`).join('; ');
    if (methode !== 'GET' && methode !== 'HEAD' && this.glas.has('fahnas_csrf') && h['x-fahnas-csrf'] === undefined) h['x-fahnas-csrf'] = this.glas.get('fahnas_csrf');
    return h;
  }
  async anfrage(methode, pfad, { kopf = {}, body } = {}) {
    const r = await anfrage(this.port, methode, pfad, { kopf: this.kopf(kopf, methode), body });
    setCookieLesen(r.setCookie, this.glas);
    return r;
  }
  get(pfad, kopf) { return this.anfrage('GET', pfad, { kopf }); }
  post(pfad, body, kopf) { return this.anfrage('POST', pfad, { body, kopf }); }
  /** Anmelden wie die Oberfläche: verlangt der Anmeldeschutz (Zugriff aus dem Internet) eine Rechenaufgabe, wird sie gelöst. */
  async anmelden(name, passwort, bleiben = false, kopf = {}) {
    const a = await this.get('/api/anmelden/aufgabe', kopf);
    const e = a.json && a.json.ergebnis;
    const zusatz = e && e.noetig && e.aufgabe ? { aufgabe: e.aufgabe, loesung: loesen(e.aufgabe, e.bits) } : {};
    return this.post('/api/anmelden', { name, passwort, angemeldet_bleiben: bleiben, ...zusatz }, kopf);
  }
}

/** Startet einen Web-Dienst ohne TLS auf Port 0 gegen die Attrappe. */
export async function dienstStarten(attrappe, { system, sitzungen, messwerte, heartbeat_ms, webOrdner, publicOrdner, rotation_ms, anmeldeschutz, turn } = {}) {
  const ordner = await tmp();
  const konfigOrdner = path.join(ordner, 'config');
  await fs.mkdir(konfigOrdner, { recursive: true });
  if (system) await fs.writeFile(path.join(konfigOrdner, 'system.json'), JSON.stringify(system));
  if (!publicOrdner) {
    publicOrdner = path.join(ordner, 'public');
    await fs.mkdir(path.join(publicOrdner, 'ansichten'), { recursive: true });
    await fs.writeFile(path.join(publicOrdner, 'index.html'), '<!doctype html><html lang="de"><meta charset="utf-8"><title>FAH-NAS</title><script type="module" src="/app.js"></script></html>');
    await fs.writeFile(path.join(publicOrdner, 'app.js'), 'export const version = 1;\n');
    await fs.writeFile(path.join(publicOrdner, 'stil.css'), 'body{margin:0}\n');
    await fs.writeFile(path.join(publicOrdner, '.versteckt'), 'geheim');
    await fs.writeFile(path.join(publicOrdner, 'ansichten', 'dashboard.js'), 'export default {};\n');
  }
  const dienst = new WebDienst({
    konfigOrdner, webOrdner: webOrdner || path.join(konfigOrdner, 'web'), publicOrdner,
    agentSocket: attrappe.socketPfad, datenSocket: attrappe.datenPfad,
    port: 0, httpPort: null, ohneTls: true, hostname: 'testbox',
    sitzungen, messwerte: { intervall_ms: 50, ...(messwerte || {}) }, heartbeat_ms, rotation_ms,
    // Anmeldeschutz: in Tests leichte Rechenaufgabe; `extern` setzt fest, ob 127.0.0.1 als „aus dem Internet“ gilt
    anmeldeschutz: { bits: 6, ...(anmeldeschutz || {}) },
    // TURN: in Tests freier Port und eigener Relay-Bereich (ohne chat.turn_info in der Attrappe bleibt er aus)
    turn: { portFest: 0, relayVon: 47900, relayBis: 47909, ...(turn || {}) },
  });
  const { port } = await dienst.starten();
  const bereit = await dienst.agentBereit(3000);
  if (!bereit) { await dienst.stoppen(); throw new Error('Attrappe nicht erreichbar'); }
  return { dienst, port, ordner, konfigOrdner, webOrdner: dienst.webOrdner, publicOrdner };
}

/** SSE-Strom /api/ereignisse lesen, bis `bedingung(text)` erfüllt ist (Kopie aus web_api.test.js, für weitere Tests). */
export function sseLesen(port, kopf, bedingung, zeit_ms = 3000) {
  return new Promise((ok, nein) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ereignisse', headers: kopf }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); return nein(new Error(`Status ${res.statusCode}`)); }
      res.on('data', (d) => { text += d; if (bedingung(text)) { req.destroy(); ok({ text, kopf: res.headers }); } });
      res.on('end', () => ok({ text, kopf: res.headers }));
    });
    req.on('error', () => ok({ text }));
    req.end();
    setTimeout(() => { req.destroy(); nein(new Error('SSE: Bedingung nicht erfüllt: ' + text.slice(0, 500))); }, zeit_ms).unref();
  });
}

/** SSE-Text in Ereignisse zerlegen → [{art, daten}]. */
export function sseEreignisse(text) {
  return text.split('\n\n').filter((b) => b.includes('event:')).map((b) => {
    const art = /event: (.+)/.exec(b)[1]; const daten = /data: (.+)/.exec(b);
    return { art, daten: daten ? JSON.parse(daten[1]) : null };
  });
}
