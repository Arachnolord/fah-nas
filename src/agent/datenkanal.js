// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datenkanal: Rohdaten (Herunter-/Hochladen) über einen zweiten Unix-Socket, ausgeführt als der anfragende
// Linux-Nutzer. Der Web-Dienst holt zuerst ein Ticket (dateien.ticket), dann öffnet er diesen Kanal und schickt
// EINE Kopfzeile {"ticket":"…","nutzer":"…"}. Das Ticket ist an den Nutzer gebunden (§3): Ticket und Nutzer müssen
// zusammenpassen, sonst E_TICKET – ein Inhaber der Zeichenkette allein kommt nicht an fremde Daten.

import net from 'node:net';
import fs from 'node:fs/promises';
import { starten } from '../gemeinsam/system.js';
import { kennung, sende } from '../gemeinsam/protokoll.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export const TICKET_GUELTIG_MS = 60_000;

/** Bereich aus dem Kanal-Kopf prüfen: {start ≥ 0, laenge ≥ 1}, innerhalb der Dateigröße (falls bekannt) – sonst null (ganze Datei). */
export function bereichPruefen(b, groesse) {
  if (!b || typeof b !== 'object') return null;
  const { start, laenge } = b;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(laenge) || start < 0 || laenge < 1) return null;
  if (Number.isFinite(Number(groesse)) && groesse !== null && groesse !== undefined && start + laenge > Number(groesse)) return null;
  return { start, laenge };
}

export class Datenkanal {
  constructor(socketPfad, gruppeGid) {
    this.socketPfad = socketPfad; this.gruppeGid = gruppeGid; this.tickets = new Map(); this.server = null;
  }

  /**
   * Erzeugt ein einmaliges Ticket.
   * @param {{nutzer:string, uid:number, gid:number, gruppen?:number[], art:'lesen'|'schreiben'|'zip', pfad:string, dateiname:string, groesse?:number, mime?:string, abschluss?:Function}} d
   * `abschluss(erfolg)` (nur schreiben): läuft, nachdem dd fertig ist – erfolg=true legt die Zwischendatei ab (Ergebnis
   * geht als `ergebnis` in die Antwortzeile, ein Fehler wird zur Fehlerzeile), erfolg=false räumt sie weg.
   */
  ticket(d) {
    for (const k of ['nutzer', 'uid', 'gid', 'art', 'pfad', 'dateiname']) if (d[k] === undefined) throw new FahnasFehler('E_UNBEKANNT', `Ticket ohne ${k}`);
    if (!['lesen', 'schreiben', 'zip', 'tcp'].includes(d.art)) throw new FahnasFehler('E_PARAMS', 'Ticket-Art ungültig');
    // „tcp“ (VM-Konsole): nur zu Diensten auf diesem Rechner (VNC lauscht auf 127.0.0.1)
    if (d.art === 'tcp' && (d.host !== '127.0.0.1' || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535)) throw new FahnasFehler('E_PARAMS', 'TCP-Ticket nur zu 127.0.0.1');
    const t = kennung('k-') + kennung('');
    this.tickets.set(t, { ...d, ablauf: Date.now() + TICKET_GUELTIG_MS });
    this._aufraeumen();
    return { ticket: t, dateiname: d.dateiname, groesse: d.groesse, mime: d.mime || 'application/octet-stream' };
  }

  _aufraeumen() { const jetzt = Date.now(); for (const [k, v] of this.tickets) if (v.ablauf < jetzt) this.tickets.delete(k); }

  /**
   * Löst ein Ticket ein (einmalig). `nutzer` ist Pflicht und muss dem Nutzer entsprechen, für den das Ticket
   * angelegt wurde (Web: Sitzungsnutzer; bei /link der Link-Ersteller). Ein fremdes Ticket wird dabei NICHT
   * verbraucht – der rechtmäßige Inhaber kann es weiter einlösen.
   */
  einloesen(ticket, nutzer) {
    this._aufraeumen();
    if (typeof nutzer !== 'string' || !nutzer) throw new FahnasFehler('E_TICKET', 'Ticket ohne Nutzerangabe');
    const t = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (!t || t.nutzer !== nutzer) throw new FahnasFehler('E_TICKET', 'Ticket ungültig oder abgelaufen');
    this.tickets.delete(ticket);
    return t;
  }

  async starten() {
    try { await fs.unlink(this.socketPfad); } catch { /* nicht da */ }
    // allowHalfOpen: der Web-Dienst schließt nach dem Hochladen seine Schreibseite; die Antwortzeile {ok:true} muss trotzdem noch raus.
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this._verbindung(socket));
    await new Promise((ok, nein) => this.server.listen(this.socketPfad, (e) => (e ? nein(e) : ok())));
    await fs.chmod(this.socketPfad, 0o660);
    if (this.gruppeGid !== undefined && process.getuid && process.getuid() === 0) { try { await fs.chown(this.socketPfad, 0, this.gruppeGid); } catch { /* Gruppe fehlt (Entwicklung) */ } }
  }

  _verbindung(socket) {
    let puffer = Buffer.alloc(0);
    const beiDaten = (teil) => {
      puffer = Buffer.concat([puffer, teil]);
      const i = puffer.indexOf(0x0a);
      if (i < 0) { if (puffer.length > 4096) { socket.destroy(); } return; }
      socket.removeListener('data', beiDaten);
      socket.pause();
      const kopf = puffer.subarray(0, i).toString('utf8');
      const rest = puffer.subarray(i + 1);
      // Fehler vor dem Start: EINE Fehlerzeile, Schreibseite zu – und den Rest der Sendung verwerfen (resume ohne
      // Leser), sonst bliebe ein Hochlader, der noch Daten schickt, ewig auf „drain“ hängen (halb offene Verbindung).
      const ablehnen = (f) => { sende(socket, { fehler: f.toJSON() }); socket.end(); socket.resume(); };
      let anfrage;
      try { anfrage = JSON.parse(kopf); } catch { return ablehnen(new FahnasFehler('E_PARAMS', 'Ungültiger Kopf')); }
      if (!anfrage || typeof anfrage !== 'object') return ablehnen(new FahnasFehler('E_PARAMS', 'Ungültiger Kopf'));
      let t;
      try { t = this.einloesen(anfrage.ticket, anfrage.nutzer); } catch (e) { return ablehnen(FahnasFehler.aus(e)); }
      this._uebertragen(socket, t, rest, anfrage.bereich).catch((e) => { try { sende(socket, { fehler: FahnasFehler.aus(e).toJSON() }); } catch { /* egal */ } socket.destroy(); });
    };
    socket.on('data', beiDaten);
    socket.on('error', () => {});
  }

  /** „tcp“: nach dem Verbinden EINE Zeile {ok:true}, danach rohe Bytes in beide Richtungen (VNC für noVNC). */
  _tcp(socket, t, rest) {
    return new Promise((fertig) => {
      const ziel = net.connect({ host: t.host, port: t.port });
      let verbunden = false; let ende = false;
      const zu = () => { if (ende) return; ende = true; try { ziel.destroy(); } catch { /* egal */ } try { socket.destroy(); } catch { /* egal */ } fertig(); };
      ziel.once('connect', () => {
        verbunden = true;
        sende(socket, { ok: true });
        if (rest.length) ziel.write(rest);
        socket.pipe(ziel); ziel.pipe(socket);
        socket.resume();
      });
      ziel.on('error', (e) => {
        if (!verbunden) { try { sende(socket, { fehler: new FahnasFehler('E_SYSTEM', 'Konsole nicht erreichbar – läuft die VM?', { ausgabe: e.message }).toJSON() }); socket.end(); } catch { /* egal */ } }
        zu();
      });
      ziel.on('close', zu); socket.on('close', zu); socket.on('error', zu);
    });
  }

  async _uebertragen(socket, t, rest, bereichRoh = null) {
    if (t.art === 'tcp') return this._tcp(socket, t, rest);
    const gemeinsam = { uid: t.uid, gid: t.gid, gruppen: t.gruppen || [] }; // Zusatzgruppen: siehe gemeinsam/system.js startArgumente
    let kind;
    let stdinFehler = null;
    let empfangen = 0;
    let zuViel = false;
    if (t.art === 'lesen') {
      // Bereich (HTTP-Range, Spulen in Videos): nur diesen Abschnitt lesen – weiterhin als der Nutzer des Tickets
      const b = bereichPruefen(bereichRoh, t.groesse);
      if (bereichRoh && !b) { sende(socket, { fehler: new FahnasFehler('E_PARAMS', 'Ungültiger Bereich').toJSON() }); socket.end(); return; }
      kind = b
        ? starten('dd', [`if=${t.pfad}`, 'bs=256K', 'iflag=skip_bytes,count_bytes', `skip=${b.start}`, `count=${b.laenge}`, 'status=none'], { ...gemeinsam, stdio: ['ignore', 'pipe', 'pipe'] })
        : starten('cat', ['--', t.pfad], { ...gemeinsam, stdio: ['ignore', 'pipe', 'pipe'] });
      kind.stdout.pipe(socket);
    } else if (t.art === 'zip') {
      kind = starten('zip', ['-r', '-q', '-', '.'], { ...gemeinsam, cwd: t.pfad, stdio: ['ignore', 'pipe', 'pipe'] });
      kind.stdout.pipe(socket);
    } else {
      kind = starten('dd', [`of=${t.pfad}`, 'status=none', 'bs=1M'], { ...gemeinsam, stdio: ['pipe', 'ignore', 'pipe'] });
      // Endet dd vorzeitig (Zielordner weg, ENOSPC, Kontingent, SIGTERM), liefert der nächste Schreibvorgang EPIPE als
      // 'error' auf stdin. Ohne Listener wäre das eine uncaughtException – und der ganze Root-Agent stürbe. Deshalb:
      // Fehler merken, Socket vom Kind trennen, Rest verwerfen; die Antwort kommt geordnet bei 'close'.
      kind.stdin.on('error', (e) => { stdinFehler = stdinFehler || e; try { socket.unpipe(kind.stdin); } catch { /* egal */ } socket.resume(); });
      // Bytes zählen: Ein abgebrochener Hochlader schließt die Verbindung wie ein fertiger (EOF) – dd endet dann mit 0.
      // Nur wenn genau die angekündigte Größe ankam, gilt die Übertragung als vollständig (sonst wird verworfen).
      // Mehr als angekündigt: sofort nichts mehr schreiben (dd läuft als root bzw. Nutzer – die Platte darf nicht volllaufen),
      // dd beenden; der Abschluss verwirft die Zwischendatei (Prüfbericht Plan 02, Befund 6).
      const grenze = t.groesse === undefined || t.groesse === null || !Number.isFinite(Number(t.groesse)) ? null : Number(t.groesse);
      const abschneiden = () => { zuViel = true; try { socket.unpipe(kind.stdin); } catch { /* egal */ } try { kind.stdin.end(); } catch { /* schon zu */ } };
      empfangen = rest.length;
      socket.on('data', (d) => { empfangen += d.length; if (grenze !== null && empfangen > grenze && !zuViel) abschneiden(); });
      if (grenze !== null && rest.length > grenze) abschneiden();
      else {
        if (rest.length) kind.stdin.write(rest);
        socket.pipe(kind.stdin);
      }
      socket.on('end', () => { try { kind.stdin.end(); } catch { /* schon zu */ } });
    }
    socket.resume();
    let fehlertext = '';
    kind.stderr.on('data', (d) => { fehlertext += d; });
    // abschluss höchstens einmal (error und close können beide kommen); Fehler beim Verwerfen sind nur Aufräumen
    let abgeschlossen = null;
    const abschliessen = (erfolg) => {
      if (!abgeschlossen) abgeschlossen = t.abschluss ? Promise.resolve().then(() => t.abschluss(erfolg)) : Promise.resolve(undefined);
      return abgeschlossen;
    };
    kind.on('error', (e) => {
      if (t.art === 'schreiben') { try { socket.unpipe(kind.stdin); } catch { /* egal */ } abschliessen(false).catch(() => {}); }
      sende(socket, { fehler: new FahnasFehler('E_SYSTEM', 'Übertragung konnte nicht gestartet werden', { ausgabe: e.message }).toJSON() });
      socket.destroy();
    });
    kind.on('close', async (code) => {
      if (t.art === 'schreiben') {
        try { socket.unpipe(kind.stdin); } catch { /* egal */ }
        // Erfolg/Misserfolg als eine Zeile zurück, dann schließen
        const vollstaendig = t.groesse === undefined || t.groesse === null || empfangen === t.groesse;
        if (code === 0 && !stdinFehler && vollstaendig) {
          let antwort = { ok: true };
          try { const ergebnis = await abschliessen(true); if (ergebnis !== undefined) antwort.ergebnis = ergebnis; } catch (e) { antwort = { fehler: FahnasFehler.aus(e).toJSON() }; }
          sende(socket, antwort);
        } else {
          await abschliessen(false).catch(() => {});
          const platz = /No space left|Disk quota exceeded/i.test(fehlertext);
          const f = code === 0 && !stdinFehler && !vollstaendig
            ? new FahnasFehler('E_ABGEBROCHEN', 'Die Übertragung war unvollständig – es wurde nichts übernommen', { erwartet: t.groesse, empfangen })
            : platz
            ? new FahnasFehler('E_PLATZ', 'Kein Platz mehr in der Freigabe', { ausgabe: fehlertext.slice(0, 2000) })
            : new FahnasFehler('E_SYSTEM', 'Schreiben fehlgeschlagen', { ausgabe: (fehlertext || (stdinFehler && stdinFehler.message) || `Exit ${code}`).slice(0, 2000) });
          sende(socket, { fehler: f.toJSON() });
        }
        if (zuViel) { socket.end(); setImmediate(() => socket.destroy()); } // den Rest nicht weiter annehmen
        else socket.end();
      } else if (code !== 0) {
        socket.destroy(new Error(fehlertext || `Exit ${code}`));
      } else {
        socket.end();
      }
    });
    socket.on('close', () => { if (kind.exitCode === null && kind.signalCode === null) { try { kind.kill('SIGTERM'); } catch { /* weg */ } } });
  }

  async stoppen() { if (this.server) await new Promise((ok) => this.server.close(() => ok())); }
}
