// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Vorschaubilder für den Dateimanager (Kachelansicht): Bilder und Videos werden mit ffmpeg auf 128/256/512 px
// verkleinert (Video: ein Einzelbild bei Sekunde 3, kürzere Videos ab 0) und unter /data/vorschau zwischengespeichert.
// ffmpeg läuft IMMER als der anfragende Nutzer (setpriv über system.starten) – wer die Datei nicht lesen darf,
// bekommt auch kein Vorschaubild; ein Treffer im Zwischenspeicher wird vorher mit `head -c 1` als Nutzer geprüft (ein
// echtes open(2) – `test -r` übersieht ACL-Rechte, Probe 28.09. auf Ubuntu 26.04). Speicher, die nur root gehören (Chat-
// Anhänge, auch von Gästen aus dem Internet), laufen „abgeschottet“: der Agent öffnet die Datei, ffmpeg bekommt nur den
// Deskriptor als stdin (`-i fd:`, suchbar) und läuft als nobody – nie als root (Prüfbericht Plan 02, Befund 1). In
// beiden Fällen sind nur das Datei-Protokoll und bekannte Bild-/Video-Formate erlaubt.
// Der Zwischenspeicher gehört root (0700), Schlüssel = Pfad + Änderungszeit + Größe + Zielgröße + Formatversion; die Belegung wird
// mitgeführt, über 2 GiB räumt der Agent sofort auf (sonst täglich). ffmpeg läuft mit nice 10 und prlimit --as 1,5 GiB.
// Fehlt ffmpeg (Altinstallation vor 0.4.0), installiert der Agent es als eigene transiente systemd-Unit nach
// (wie conntrack in helfer/verbindungen.js); bis dahin zeigt die Oberfläche das Dateisymbol.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const GROESSEN = Object.freeze([128, 256, 512]);
export const STANDARD_GROESSE = 256;
export const ARTEN = Object.freeze(['bild', 'video']);
/** Teil des Cache-Schlüssels – hochzählen, wenn sich die ffmpeg-Parameter ändern (alte Bilder verfallen dann). */
export const FORMAT_VERSION = 1;
export const INSTALLATIONS_UNIT = 'fahnas-ffmpeg-install';

const MAX_PARALLEL = 2;                       // Mini-PC hat 2 Kerne – mehr gleichzeitige ffmpeg-Läufe bremsen Samba und Web
const MAX_AUSGABE = 4 * 1024 * 1024;          // ein 512-px-Bild ist < 200 KB; mehr ist ein Fehler
const ZEITLIMIT_MS = Object.freeze({ bild: 30_000, video: 60_000 });
const VIDEO_STELLE_S = 3;                     // Einzelbild bei Sekunde 3 (Vorspann/Schwarzbild vermeiden), sonst ab 0
const MAX_BILD_BYTES = 512 * 1024 * 1024;     // größere Bilddateien werden nicht dekodiert (RAM)
const FEHLER_MERKEN_MS = 10 * 60_000;         // gescheiterte Dateien nicht bei jedem Neuzeichnen erneut probieren
const FEHLER_MAX = 5000;
const CACHE_MAX_BYTES = 2 * 1024 ** 3;
const CACHE_ZIEL_ANTEIL = 0.75;
const CACHE_ALTER_MAX_MS = 180 * 86_400_000;
const AUFRAEUMEN_TAKT_MS = 24 * 3_600_000;
const AUFRAEUMEN_START_MS = 5 * 60_000;
const WERKZEUG_PRUEFEN_MS = 30_000;           // fehlt ffmpeg: höchstens alle 30 s nachsehen (Unit fertig?)
const NICE = '10';
/** Adressraum-Deckel je ffmpeg-Lauf (prlimit --as): eine 16000×16000-„Pixelbombe“ braucht > 1 GiB und scheitert sauber, 100-MP-Fotos, HEIC und 4K-HEVC passen (Probe 28.09.). */
export const MAX_SPEICHER_BYTES = 1536 * 1024 * 1024;

const APT_UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' });
const APT_ARGS = Object.freeze(['-o', 'DPkg::Lock::Timeout=600', '-o', 'Dpkg::Options::=--force-confold', '-q', '-y']);
const INSTALLATIONS_SCHRITTE = Object.freeze([['install', 'ffmpeg'], ['update'], ['install', 'ffmpeg']]);
const UNIT_LAEUFT = new Set(['active', 'activating', 'reloading', 'deactivating']);
const UNIT_SCHON_DA = /already exists|already loaded|already active|is already/i;
const UNIT_START_MS = 60_000;
const ABFRAGE_MS = 10_000;
export const HINWEIS_INSTALLATION = 'Vorschaubilder brauchen ffmpeg – es wird gerade nachinstalliert (Internet nötig); bis dahin zeigt der Dateimanager Symbole';
export const HINWEIS_FEHLGESCHLAGEN = `ffmpeg fehlt und ließ sich nicht nachinstallieren (Internet?). Neuer Versuch beim nächsten Start des Steuerdienstes – oder auf der Konsole: sudo apt install ffmpeg (Einzelheiten: journalctl -u ${INSTALLATIONS_UNIT})`;

const MIME = Object.freeze({ webp: 'image/webp', jpg: 'image/jpeg' });
/** Erlaubte Demuxer (Probe 18.10. mit ffmpeg 8.0.1: Bilder als *_pipe bzw. image2 über den Pfad, Videos über mov/matroska/…);
 *  keine Listen- oder Netz-Demuxer wie hls, concat, dash. */
export const FORMATE = Object.freeze(['image2', 'png_pipe', 'jpeg_pipe', 'gif', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'jpegxl_pipe', 'jpegxl_anim', 'mov', 'matroska', 'webm', 'ogg', 'avi', 'mpegts', 'asf', 'flv', 'mpeg']);
/** Kennung abgeschotteter Läufe: nobody/nogroup (Ubuntu). */
export const NIEMAND = Object.freeze({ uid: 65534, gid: 65534, gruppen: [] });

/** Cache-Schlüssel (hex) aus absolutem Pfad, Änderungszeit, Dateigröße und Zielgröße. */
export function schluessel(abs, st, groesse) {
  return crypto.createHash('sha256').update(`${abs}\0${Math.round(st.mtimeMs)}\0${st.size}\0${groesse}\0v${FORMAT_VERSION}`).digest('hex');
}

/**
 * Argumente für ffmpeg: ein Einzelbild, längste Seite ≤ groesse (kleine Bilder werden nicht vergrößert), gerade Maße.
 * Video: `stelle` (Sekunden) vor -i = schneller Sprung; null = ab Anfang. Encoder `libwebp` (Transparenz bleibt) oder
 * `mjpeg` (Rückfall, wenn ffmpeg ohne libwebp gebaut ist). Ausgabe auf stdout.
 */
export function ffmpegArgumente({ abs, groesse, art, stelle = null, encoder = 'libwebp', ueberDeskriptor = false }) {
  const g = Number(groesse);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1'];
  args.push('-protocol_whitelist', ueberDeskriptor ? 'fd' : 'file', '-format_whitelist', FORMATE.join(','));
  if (art === 'video' && stelle !== null && stelle > 0) args.push('-ss', String(stelle));
  args.push('-i', ueberDeskriptor ? 'fd:' : abs, '-an', '-sn', '-dn', '-frames:v', '1');
  args.push('-vf', `scale=w=min(iw\\,${g}):h=min(ih\\,${g}):force_original_aspect_ratio=decrease:force_divisible_by=2`);
  if (encoder === 'libwebp') args.push('-c:v', 'libwebp', '-quality', '80', '-compression_level', '4', '-f', 'webp');
  else args.push('-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe');
  args.push('pipe:1');
  return args;
}

/** Startkette hinter setpriv: nice (CPU-Vorrang für Samba/Web) → prlimit (Adressraum-Deckel) → ffmpeg. Argumente für `nice`. */
export function ffmpegBefehl(o) { return ['-n', NICE, 'prlimit', `--as=${MAX_SPEICHER_BYTES}`, 'ffmpeg', ...ffmpegArgumente(o)]; }

/** Fehlertext eines system.ausfuehren-Fehlers (details.ausgabe) oder message. */
function fehlerText(e) { return String((e && e.details && e.details.ausgabe) || (e && e.message) || e || ''); }

/**
 * Startet ein Programm über system.starten (uid/gid/gruppen → setpriv) und sammelt stdout (Buffer, bis maxBytes) und
 * stderr (Text). Zeitlimit → SIGKILL. Löst nie ab – Fehler stehen im Ergebnis.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:Buffer, stderr:string, abgebrochen:boolean, zuGross:boolean, startFehler:string|null}>}
 */
export function laufen(system, programm, argumente, { ids, zeitlimit_ms, maxBytes = MAX_AUSGABE, eingabeFd } = {}) {
  return new Promise((aufloesen) => {
    let kind;
    const teile = []; let laenge = 0; let stderr = ''; let abgebrochen = false; let zuGross = false; let fertig = false;
    const ende = (r) => { if (fertig) return; fertig = true; clearTimeout(wecker); aufloesen(r); };
    const toeten = () => { try { kind.kill('SIGKILL'); } catch { /* schon weg */ } };
    const wecker = setTimeout(() => { abgebrochen = true; toeten(); }, zeitlimit_ms || ZEITLIMIT_MS.bild);
    wecker.unref();
    try {
      kind = system.starten(programm, argumente, { uid: ids?.uid, gid: ids?.gid, gruppen: ids?.gruppen, stdio: [Number.isInteger(eingabeFd) ? eingabeFd : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return ende({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: '', abgebrochen: false, zuGross: false, startFehler: String(e && e.message) });
    }
    kind.stdout.on('data', (d) => {
      if (zuGross) return;
      laenge += d.length;
      if (laenge > maxBytes) { zuGross = true; toeten(); return; }
      teile.push(d);
    });
    kind.stderr.setEncoding('utf8');
    kind.stderr.on('data', (d) => { if (stderr.length < 16_384) stderr += d; });
    kind.on('error', (e) => ende({ code: null, signal: null, stdout: Buffer.concat(teile), stderr, abgebrochen, zuGross, startFehler: String(e && e.message) }));
    kind.on('close', (code, signal) => ende({ code, signal, stdout: zuGross ? Buffer.alloc(0) : Buffer.concat(teile), stderr, abgebrochen, zuGross, startFehler: null }));
  });
}

export class Vorschau {
  /**
   * @param {{system:object, ordner:string, protokoll?:Function, jetzt?:Function}} o
   *  system = { starten, ausfuehren } (src/gemeinsam/system.js oder Attrappe), ordner = Zwischenspeicher (root, 0700).
   */
  constructor({ system, ordner, protokoll = (t) => process.stderr.write(`[vorschau] ${t}\n`), jetzt = () => Date.now() }) {
    this.system = system; this.ordner = ordner; this.protokoll = protokoll; this.jetzt = jetzt;
    this.werkzeugDa = null;       // null = noch nicht geprüft
    this.werkzeugGeprueft = 0;
    this.werkzeugPruefung = null; // laufende Prüfung (Promise), die sich gleichzeitige Anfragen teilen
    this.webpFehlt = false;
    this.fehler = new Map();      // schluessel → {bis, fehler}
    this.laufend = 0; this.warteschlange = [];
    this.inst = null;             // Zustand der Nachinstallation
    this.cacheFehlerGemeldet = false;
    this.belegt = null;           // Bytes im Zwischenspeicher (null = noch nicht gezählt)
    this.cacheMaxBytes = CACHE_MAX_BYTES;
    this.aufraeumLauf = null;
    this._timer = null; this._startTimer = null;
    this.gestoppt = false;
  }

  /** Zwischenspeicher anlegen, ffmpeg prüfen (fehlt → Nachinstallation anstoßen), Aufräumen planen. Nie fatal. */
  async starten() {
    try { await fs.mkdir(this.ordner, { recursive: true, mode: 0o700 }); await fs.chmod(this.ordner, 0o700); } catch (e) { this.protokoll(`Zwischenspeicher ${this.ordner}: ${e && e.message}`); }
    await this._werkzeugPruefen(true);
    this._startTimer = setTimeout(() => { this.aufraeumen().catch((e) => this.protokoll(`Aufräumen: ${e && e.message}`)); }, AUFRAEUMEN_START_MS);
    this._startTimer.unref();
    this._timer = setInterval(() => { this.aufraeumen().catch((e) => this.protokoll(`Aufräumen: ${e && e.message}`)); }, AUFRAEUMEN_TAKT_MS);
    this._timer.unref();
  }

  stoppen() { this.gestoppt = true; clearTimeout(this._startTimer); clearInterval(this._timer); }

  /** Zustand für Oberfläche/Diagnose. */
  zustand() { return { ffmpeg: this.werkzeugDa === true, hinweis: this.werkzeugDa === true ? null : (this.inst && this.inst.ende ? HINWEIS_FEHLGESCHLAGEN : HINWEIS_INSTALLATION), webp: !this.webpFehlt }; }

  /**
   * Liefert das Vorschaubild (Buffer) – aus dem Zwischenspeicher oder frisch erzeugt.
   * `abgeschottet`: Datei in einem root-eigenen Speicher, dessen Rechte der Aufrufer schon geprüft hat – ffmpeg als nobody
   * mit der Datei als Deskriptor, ohne Leseprobe (dann ohne `ids`).
   * @param {{abs:string, groesse:number, art:'bild'|'video', ids?:{uid:number, gid:number, gruppen?:number[]}, abgeschottet?:boolean}} o
   * @returns {Promise<{mime:string, daten:Buffer, ausCache:boolean}>}
   */
  async holen({ abs, groesse, art, ids, abgeschottet = false }) {
    if (!GROESSEN.includes(Number(groesse))) throw new FahnasFehler('E_PARAMS', `Größe muss eine dieser sein: ${GROESSEN.join(', ')}`, { feld: 'groesse' });
    if (!ARTEN.includes(art)) throw new FahnasFehler('E_PARAMS', 'Vorschaubilder gibt es nur für Bilder und Videos', { feld: 'pfad' });
    if (!abgeschottet && (!ids || !Number.isInteger(ids.uid) || !Number.isInteger(ids.gid))) throw new FahnasFehler('E_UNBEKANNT', 'Vorschau ohne Nutzerkennung');
    // Zuerst als Nutzer öffnen: ohne Leserecht gibt es weder Existenz noch Größe noch gemerkte ffmpeg-Fehler zu erfahren
    // (Prüfbericht 28.09.: sonst Existenz-Orakel in fremden Ordnern und fremde Fehlertexte).
    if (!abgeschottet) await this._lesbar(abs, ids);
    let st;
    try { st = await fs.stat(abs); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei nicht gefunden');
      throw FahnasFehler.aus(e);
    }
    if (!st.isFile()) throw new FahnasFehler('E_PARAMS', 'Vorschaubilder gibt es nur für Dateien', { feld: 'pfad' });
    if (art === 'bild' && st.size > MAX_BILD_BYTES) throw new FahnasFehler('E_SYSTEM', 'Die Bilddatei ist zu groß für ein Vorschaubild');
    const key = schluessel(abs, st, Number(groesse));
    const gemerkt = this.fehler.get(key);
    if (gemerkt) { if (gemerkt.bis > this.jetzt()) throw gemerkt.fehler; this.fehler.delete(key); }
    // Treffer im Zwischenspeicher (ein anderer Nutzer kann ihn erzeugt haben – die Leseprobe oben gilt für jeden Nutzer)
    const treffer = await this._ausCache(key);
    if (treffer) return { ...treffer, ausCache: true };
    await this._werkzeugSicherstellen();
    await this._platz();
    try {
      const erg = await this._erzeugen({ abs, groesse: Number(groesse), art, ids: abgeschottet ? NIEMAND : ids, key, abgeschottet });
      return { ...erg, ausCache: false };
    } finally { this._frei(); }
  }

  // ---- Zwischenspeicher --------------------------------------------------------------------------------------------
  _pfad(key, endung) { return path.join(this.ordner, key.slice(0, 2), `${key}.${endung}`); }

  async _ausCache(key) {
    for (const endung of ['webp', 'jpg']) {
      try { const daten = await fs.readFile(this._pfad(key, endung)); if (daten.length) return { mime: MIME[endung], daten }; } catch { /* nicht da */ }
    }
    return null;
  }

  async _inCache(key, endung, daten) {
    const ziel = this._pfad(key, endung);
    const tmp = `${ziel}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, daten, { mode: 0o600 });
      await fs.rename(tmp, ziel);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {}); // keine Leichen bei voller Platte oder Schreibfehler
      if (!this.cacheFehlerGemeldet) { this.cacheFehlerGemeldet = true; this.protokoll(`Zwischenspeicher nicht beschreibbar (${e && e.message}) – Vorschaubilder werden jedes Mal neu erzeugt`); }
      return;
    }
    // Belegung mitführen (Startwert liefert das erste Aufräumen); über der Obergrenze sofort aufräumen, höchstens ein Lauf zugleich
    if (this.belegt !== null) {
      this.belegt += daten.length;
      if (this.belegt > this.cacheMaxBytes && !this.aufraeumLauf) {
        this.aufraeumLauf = this.aufraeumen().catch((e) => this.protokoll(`Aufräumen: ${e && e.message}`)).finally(() => { this.aufraeumLauf = null; });
      }
    }
  }

  /** Alte (> 180 Tage) und, wenn der Speicher über 2 GiB wächst, die ältesten Bilder löschen. */
  async aufraeumen({ maxBytes = this.cacheMaxBytes, maxAlterMs = CACHE_ALTER_MAX_MS } = {}) {
    const dateien = [];
    let ordner;
    try { ordner = await fs.readdir(this.ordner, { withFileTypes: true }); } catch { return { geloescht: 0, bytes: 0 }; }
    for (const d of ordner) {
      if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
      const unter = path.join(this.ordner, d.name);
      let eintraege = [];
      try { eintraege = await fs.readdir(unter); } catch { continue; }
      for (const n of eintraege) {
        const p = path.join(unter, n);
        try { const st = await fs.stat(p); if (st.isFile()) dateien.push({ p, groesse: st.size, zeit: st.mtimeMs, tmp: n.endsWith('.tmp') }); } catch { /* weg */ }
      }
    }
    const jetzt = this.jetzt();
    let geloescht = 0; let bytesWeg = 0;
    const loeschen = async (d) => { try { await fs.unlink(d.p); geloescht++; bytesWeg += d.groesse; return true; } catch { return false; } };
    let rest = [];
    for (const d of dateien) {
      if (d.tmp && jetzt - d.zeit > 3_600_000) { await loeschen(d); continue; }   // liegengebliebene Zwischendatei
      if (jetzt - d.zeit > maxAlterMs) { await loeschen(d); continue; }
      rest.push(d);
    }
    let gesamt = rest.reduce((s, d) => s + d.groesse, 0);
    if (gesamt > maxBytes) {
      rest.sort((a, b) => a.zeit - b.zeit);
      const ziel = Math.floor(maxBytes * CACHE_ZIEL_ANTEIL);
      for (const d of rest) { if (gesamt <= ziel) break; if (await loeschen(d)) gesamt -= d.groesse; }
    }
    this.belegt = gesamt;
    if (geloescht) this.protokoll(`Zwischenspeicher aufgeräumt: ${geloescht} Bilder (${Math.round(bytesWeg / 1024)} KiB) gelöscht, ${Math.round(gesamt / 1024 / 1024)} MiB belegt`);
    return { geloescht, bytes: bytesWeg, belegt: gesamt };
  }

  // ---- Rechte und Werkzeug ----------------------------------------------------------------------------------------
  /**
   * Darf der Nutzer die Datei lesen? Öffnet sie als Nutzer (setpriv, Zusatzgruppen) und liest ein Byte – sonst E_RECHTE.
   * Bewusst `head -c 1` statt `test -r`: coreutils-test prüft nur die Modus-Bits und verneint Rechte, die allein über die
   * ACL der Freigabe kommen (Nutzer in „lesen“); open(2) entscheidet wie Samba und der Dateihelfer.
   */
  async _lesbar(abs, ids) {
    let r;
    try { r = await this.system.ausfuehren('head', ['-c', '1', '--', abs], { uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen || [], erlaubteCodes: [0, 1], zeitlimit_ms: ABFRAGE_MS }); } catch (e) {
      throw new FahnasFehler('E_SYSTEM', 'Leserecht konnte nicht geprüft werden', { ausgabe: fehlerText(e).slice(0, 500) });
    }
    if (r.code !== 0) {
      const text = String(r.stderr || '');
      if (/No such file|Not a directory/i.test(text)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei nicht gefunden');
      if (/Is a directory/i.test(text)) throw new FahnasFehler('E_PARAMS', 'Vorschaubilder gibt es nur für Dateien', { feld: 'pfad' });
      throw new FahnasFehler('E_RECHTE', 'Du darfst diese Datei nicht lesen');
    }
  }

  async _ffmpegDa() {
    try { await this.system.ausfuehren('ffmpeg', ['-version'], { zeitlimit_ms: ABFRAGE_MS }); return true; } catch { return false; }
  }

  /**
   * ffmpeg prüfen; fehlt es, Nachinstallation anstoßen bzw. weiterführen. `erzwingen` übergeht die 30-s-Bremse. Gleichzeitige
   * Anfragen teilen sich EINE laufende Prüfung (Bedienprobe 28.09.: beim ersten Öffnen eines Ordners scheiterten 16 von 28
   * Kacheln, weil sie während der ersten Prüfung nur den alten Stand „fehlt“ sahen).
   */
  async _werkzeugPruefen(erzwingen = false) {
    if (this.werkzeugDa === true) return true;
    if (this.werkzeugPruefung) return this.werkzeugPruefung;
    const jetzt = this.jetzt();
    if (!erzwingen && this.werkzeugGeprueft && jetzt - this.werkzeugGeprueft < WERKZEUG_PRUEFEN_MS) return false;
    this.werkzeugGeprueft = jetzt;
    this.werkzeugPruefung = (async () => {
      if (await this._ffmpegDa()) {
        if (this.werkzeugDa === false) this.protokoll('ffmpeg ist jetzt vorhanden – Vorschaubilder verfügbar');
        this.werkzeugDa = true; return true;
      }
      this.werkzeugDa = false;
      await this._nachinstallieren();
      return this.werkzeugDa === true;
    })().finally(() => { this.werkzeugPruefung = null; });
    return this.werkzeugPruefung;
  }

  async _werkzeugSicherstellen() {
    if (await this._werkzeugPruefen()) return;
    throw new FahnasFehler('E_SYSTEM', 'ffmpeg fehlt – Vorschaubilder sind noch nicht verfügbar', { hinweis: this.zustand().hinweis });
  }

  /**
   * Nachinstallation als transiente systemd-Unit (überlebt Stopp/Neustart des Agenten). Jeder Aufruf geht höchstens einen
   * Schritt weiter: Unit läuft → warten; Unit fertig, ffmpeg fehlt → nächster Schritt (install → update → install).
   */
  async _nachinstallieren() {
    if (!this.inst) this.inst = { schritt: 0, laeuft: false, ende: false };
    const z = this.inst;
    if (z.ende) return;
    if (z.laeuft) {
      if (await this._unitLaeuft()) return;
      z.laeuft = false;
      if (await this._ffmpegDa()) { this.werkzeugDa = true; z.ende = true; this.protokoll('ffmpeg nachinstalliert – Vorschaubilder verfügbar'); return; }
      z.schritt++;
    }
    if (z.schritt >= INSTALLATIONS_SCHRITTE.length) { z.ende = true; this.protokoll(HINWEIS_FEHLGESCHLAGEN); return; }
    const schritt = INSTALLATIONS_SCHRITTE[z.schritt];
    try {
      await this.system.ausfuehren('systemd-run', [`--unit=${INSTALLATIONS_UNIT}`, '--collect', '--quiet', '--setenv=DEBIAN_FRONTEND=noninteractive', 'apt-get', ...APT_ARGS, ...schritt], { umgebung: APT_UMGEBUNG, zeitlimit_ms: UNIT_START_MS });
      z.laeuft = true;
      this.protokoll(`ffmpeg fehlt – Unit ${INSTALLATIONS_UNIT} gestartet: apt-get ${schritt.join(' ')}`);
    } catch (e) {
      if (UNIT_SCHON_DA.test(fehlerText(e))) { z.laeuft = true; this.protokoll(`ffmpeg-Nachinstallation läuft bereits (Unit ${INSTALLATIONS_UNIT}) – warte darauf`); return; }
      z.ende = true;
      this.protokoll(`ffmpeg fehlt und systemd-run scheiterte (${fehlerText(e).slice(0, 200)}) – ${HINWEIS_FEHLGESCHLAGEN}`);
    }
  }

  async _unitLaeuft() {
    try {
      const r = await this.system.ausfuehren('systemctl', ['show', '--property=ActiveState', '--value', `${INSTALLATIONS_UNIT}.service`], { zeitlimit_ms: ABFRAGE_MS });
      return UNIT_LAEUFT.has(String(r.stdout ?? '').trim());
    } catch { return false; }
  }

  // ---- Erzeugen ---------------------------------------------------------------------------------------------------
  /** Semaphor: höchstens MAX_PARALLEL Läufe; ein frei werdender Platz geht DIREKT an den nächsten Wartenden über (kein
   *  Zwischenzustand, in dem ein Neuankömmling ihn sich schnappt – Prüfbericht 28.09.: sonst drei Läufe auf zwei Plätzen). */
  _platz() {
    if (this.laufend < MAX_PARALLEL) { this.laufend++; return Promise.resolve(); }
    return new Promise((ok) => this.warteschlange.push(ok));
  }
  _frei() { const n = this.warteschlange.shift(); if (n) n(); else this.laufend--; }

  async _erzeugen({ abs, groesse, art, ids, key, abgeschottet = false }) {
    const stellen = art === 'video' ? [VIDEO_STELLE_S, null] : [null];
    let encoder = this.webpFehlt ? 'mjpeg' : 'libwebp';
    let letzter = null;
    // Abgeschottet: je Lauf ein frischer Deskriptor ab Dateianfang (ein geteilter Versatz würde den zweiten Lauf verderben)
    const lauf = async (stelle) => {
      const fh = abgeschottet ? await fs.open(abs, 'r') : null;
      try {
        return await laufen(this.system, 'nice', ffmpegBefehl({ abs, groesse, art, stelle, encoder, ueberDeskriptor: abgeschottet }), { ids, zeitlimit_ms: ZEITLIMIT_MS[art], eingabeFd: fh ? fh.fd : undefined });
      } finally { if (fh) await fh.close().catch(() => {}); }
    };
    for (let i = 0; i < stellen.length; i++) {
      const stelle = stellen[i];
      let r = await lauf(stelle);
      if (encoder === 'libwebp' && r.code !== 0 && !r.abgebrochen && /Unknown encoder|libwebp/i.test(r.stderr)) {
        this.webpFehlt = true; encoder = 'mjpeg';
        this.protokoll('ffmpeg ohne libwebp – Vorschaubilder als JPEG');
        r = await lauf(stelle);
      }
      letzter = r;
      if (r.abgebrochen) break;
      if (r.code === 0 && r.stdout.length > 0) {
        const endung = encoder === 'libwebp' ? 'webp' : 'jpg';
        await this._inCache(key, endung, r.stdout);
        return { mime: MIME[endung], daten: r.stdout };
      }
      // Video kürzer als die Sprungstelle: ffmpeg endet ohne Bild (Code 0, leer) oder mit Fehler → ab Anfang
      if (stelle === null) break;
    }
    const f = this._fehlerAus(letzter, art);
    this._fehlerMerken(key, f);
    throw f;
  }

  _fehlerAus(r, art) {
    if (!r) return new FahnasFehler('E_SYSTEM', 'Vorschaubild konnte nicht erzeugt werden');
    if (r.startFehler) return new FahnasFehler('E_SYSTEM', 'ffmpeg konnte nicht gestartet werden', { ausgabe: r.startFehler });
    if (r.abgebrochen) return new FahnasFehler('E_SYSTEM', `Vorschaubild dauerte zu lange (${art === 'video' ? 'Video' : 'Bild'} zu groß oder beschädigt)`);
    if (r.zuGross) return new FahnasFehler('E_SYSTEM', 'ffmpeg lieferte eine unerwartet große Ausgabe');
    if (/Permission denied/i.test(r.stderr)) return new FahnasFehler('E_RECHTE', 'Du darfst diese Datei nicht lesen');
    if (/Cannot alloc|out of memory|get_buffer\(\) failed/i.test(r.stderr)) return new FahnasFehler('E_SYSTEM', 'Das Bild ist zu groß für ein Vorschaubild (Speicherdeckel)');
    if (/No such file/i.test(r.stderr)) return new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei nicht gefunden');
    return new FahnasFehler('E_SYSTEM', 'Vorschaubild konnte nicht erzeugt werden (Format nicht lesbar?)', { ausgabe: String(r.stderr || `Exit ${r.code}`).slice(-800) });
  }

  _fehlerMerken(key, fehler) {
    if (this.fehler.size >= FEHLER_MAX) { const jetzt = this.jetzt(); for (const [k, v] of this.fehler) if (v.bis <= jetzt) this.fehler.delete(k); if (this.fehler.size >= FEHLER_MAX) this.fehler.clear(); }
    this.fehler.set(key, { bis: this.jetzt() + FEHLER_MERKEN_MS, fehler });
  }
}
