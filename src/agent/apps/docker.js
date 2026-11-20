// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Docker-Anbindung für Apps: docker compose (pull/up/down/start/stop/restart/ps/logs/config) und docker (ps, stats,
// image inspect) – ausschließlich über werkzeuge.system.ausfuehren/starten mit Argumentlisten, Ausgaben als JSON
// (--format json, eine Zeile je Objekt). Container/Stats werden 10 s zwischengespeichert (apps.liste).

import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const CACHE_MS = 10_000;
export const PROJEKT_VORSILBE = 'fahnas-';
const UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME || '/root', DOCKER_CLI_HINTS: 'false' });
const ZEIT_LANG = 30 * 60 * 1000;
const ZEIT_KURZ = 120_000;

export function projektName(name) { return `${PROJEKT_VORSILBE}${name}`; }

/** Lauschadresse aus ss normieren: „127.0.0.53%lo“ → „127.0.0.53“, „[::]“ → „*“, „0.0.0.0“/„*“ → „*“. */
export function adresseNormieren(a) {
  let s = String(a || '').trim().replace(/%[^\]]*$/, '').replace(/%[^\]]*\]$/, ']');
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return !s || s === '*' || s === '0.0.0.0' || s === '::' ? '*' : s;
}

/** Kollidiert ein Dienst, der an `adresse` lauschen will („*“/leer = alle), mit den belegten Adressen? */
export function adressenKollidieren(adresse, belegt) {
  const a = adresseNormieren(adresse);
  const liste = (belegt || []).map(adresseNormieren);
  if (!liste.length) return false;
  if (a === '*') return true;
  return liste.includes('*') || liste.includes(a);
}

/**
 * Feste Compose-Argumente einer App (Projektname, Datei, Umgebungsdatei). ZIP-Apps: Projekt und Compose-Dateien so, wie
 * die mitgelieferte manage.sh sie angelegt hat (aus den Container-Labels); .env liest compose selbst aus dem Ordner.
 */
export function composeArgs(app) {
  // Anpassungen aus dem App-Editor (fahnas.anpassung.yml, Ports/Pfade/Variablen mit !override) kommen bei JEDEM Aufruf
  // zuletzt dazu – so gelten sie beim Start, Neustart, Aktualisieren und Löschen gleichermaßen
  const anpassung = app.anpassungDatei ? ['-f', app.anpassungDatei] : [];
  if (app.art === 'zip') return ['compose', '--ansi', 'never', '--progress', 'plain', '-p', app.projekt, '--project-directory', app.projektOrdner || app.ordner, ...(app.composeDateien || []).flatMap((f) => ['-f', f]), ...anpassung];
  return ['compose', '--ansi', 'never', '--progress', 'plain', '-p', projektName(app.name), '-f', app.composeDatei, '--env-file', app.envDatei, ...anpassung];
}

function ausgabe(e) { return (e && e.details && e.details.ausgabe) || (e && e.message) || ''; }
function dockerFehler(text, e, befehl) { return new FahnasFehler('E_SYSTEM', `${text}: ${String(ausgabe(e)).trim().split('\n').slice(-3).join(' ').slice(0, 600)}`, { befehl, ausgabe: String(ausgabe(e)).slice(-4000), code: e && e.details && e.details.code }); }

/** JSON-Zeilen (eine je Objekt) oder ein JSON-Array einlesen. */
export function jsonZeilen(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t[0] === '[') { try { const a = JSON.parse(t); return Array.isArray(a) ? a : [a]; } catch { /* zeilenweise */ } }
  const aus = [];
  for (const z of t.split('\n')) { const s = z.trim(); if (!s || s[0] !== '{') continue; try { aus.push(JSON.parse(s)); } catch { /* keine JSON-Zeile */ } }
  return aus;
}

/** „476KiB / 7.246GiB“ → Bytes des ersten Teils. */
export function speicherParsen(text) {
  const m = /^\s*([\d.]+)\s*([KMGTP]?i?B)/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]); const e = m[2].toLowerCase();
  const faktor = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, pb: 1000 ** 5 }[e];
  return Number.isFinite(n) && faktor ? Math.round(n * faktor) : null;
}

/**
 * `docker system df --format '{{json .}}'` (eine JSON-Zeile je Art) → {images, container, volumes, cache}, je
 * {anzahl, aktiv, bytes, frei_bytes} (frei_bytes = „Reclaimable“ laut Docker); fehlende Arten bleiben null.
 */
export function systemDfParsen(text) {
  const art = { images: 'images', containers: 'container', 'local volumes': 'volumes', 'build cache': 'cache' };
  const aus = { images: null, container: null, volumes: null, cache: null };
  for (const z of String(text || '').split('\n')) {
    let o; try { o = JSON.parse(z); } catch { continue; }
    const k = o && art[String(o.Type || '').toLowerCase()];
    if (!k) continue;
    aus[k] = { anzahl: Number(o.TotalCount) || 0, aktiv: Number(o.Active) || 0, bytes: speicherParsen(o.Size) ?? 0, frei_bytes: speicherParsen(o.Reclaimable) ?? 0 };
  }
  return aus;
}

/** „0.0.0.0:18081->80/tcp, [::]:18081->80/tcp“ → [{port, protokoll}] (Host-Seite, eindeutig). */
export function portsParsen(text) {
  const aus = new Map();
  for (const m of String(text || '').matchAll(/(?:^|,\s*)(?:[^\s,]*?:)?(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp|sctp)/g)) {
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= b && p - a < 1000; p++) aus.set(`${p}/${m[3]}`, { port: p, protokoll: m[3] });
  }
  return [...aus.values()];
}

/** Labels-Zeichenkette „k=v,k=v“ → Objekt. */
export function labelsParsen(text) {
  const aus = {};
  for (const teil of String(text || '').split(',')) { const i = teil.indexOf('='); if (i > 0) aus[teil.slice(0, i).trim()] = teil.slice(i + 1); }
  return aus;
}

/** Zustand einer App aus ihren Containern: laufen alle → running; keiner → exited/fehlt; sonst teilweise/restarting. */
export function zustandZusammenfassen(container) {
  if (!container.length) return { zustand: 'fehlt', gesundheit: null };
  const z = container.map((c) => String(c.zustand || '').toLowerCase());
  const g = container.map((c) => String(c.gesundheit || '').toLowerCase()).filter(Boolean);
  const gesundheit = g.includes('unhealthy') ? 'unhealthy' : g.includes('starting') ? 'starting' : g.includes('healthy') ? 'healthy' : null;
  if (z.some((x) => x === 'restarting')) return { zustand: 'restarting', gesundheit };
  if (z.every((x) => x === 'running')) return { zustand: 'running', gesundheit };
  if (z.every((x) => x !== 'running')) return { zustand: z.includes('paused') ? 'paused' : z.includes('dead') ? 'dead' : z.every((x) => x === 'created') ? 'created' : 'exited', gesundheit };
  return { zustand: 'teilweise', gesundheit };
}

/** Container aus `docker compose ps -a --format json` normieren. */
function containerNormieren(o) {
  return {
    id: String(o.ID || o.Id || ''), name: String(o.Name || o.Names || ''), dienst: String(o.Service || (labelsParsen(o.Labels)['com.docker.compose.service'] || '')),
    zustand: String(o.State || '').toLowerCase(), gesundheit: o.Health ? String(o.Health).toLowerCase() : null, status: String(o.Status || ''),
    image: String(o.Image || ''), exitcode: typeof o.ExitCode === 'number' ? o.ExitCode : null,
    ports: Array.isArray(o.Publishers) && o.Publishers.length
      ? [...new Map(o.Publishers.filter((p) => p.PublishedPort).map((p) => [`${p.PublishedPort}/${p.Protocol}`, { port: Number(p.PublishedPort), protokoll: p.Protocol || 'tcp', ziel: Number(p.TargetPort) || null }])).values()]
      : portsParsen(o.Ports),
  };
}

export class Docker {
  constructor(system) {
    this.system = system;
    this._container = null; this._stats = null;
  }

  leeren() { this._container = null; this._stats = null; }

  async _docker(args, { zeitlimit_ms = ZEIT_KURZ, erlaubteCodes, eingabe } = {}) {
    return this.system.ausfuehren('docker', args, { umgebung: UMGEBUNG, zeitlimit_ms, erlaubteCodes, eingabe });
  }

  /** Ist Docker erreichbar? (docker version -f) */
  async verfuegbar() {
    try { await this._docker(['version', '--format', '{{.Server.Version}}'], { zeitlimit_ms: 15_000 }); return true; } catch { return false; }
  }

  /** compose <unterbefehl> … ohne Fortschritt. */
  async compose(app, args, { zeitlimit_ms = ZEIT_KURZ, text = 'docker compose schlug fehl' } = {}) {
    const alle = [...composeArgs(app), ...args];
    try { return await this._docker(alle, { zeitlimit_ms }); } catch (e) { throw dockerFehler(text, e, `docker ${alle.join(' ')}`); }
  }

  /**
   * compose <unterbefehl> mit Zeilen-Rückruf (Fortschritt) über system.starten; fehlt `starten`, läuft es über
   * ausfuehren und die Zeilen kommen am Ende. Wirft E_SYSTEM bei Exit ≠ 0 (erlaubteCodes ausgenommen).
   */
  async composeMitZeilen(app, args, o = {}) {
    return this.dockerMitZeilen([...composeArgs(app), ...args], { text: 'docker compose schlug fehl', ...o });
  }

  /** docker <args> mit Zeilen-Rückruf (siehe composeMitZeilen). */
  async dockerMitZeilen(alle, { beiZeile, zeitlimit_ms = ZEIT_LANG, text = 'docker schlug fehl', abgebrochen } = {}) {
    if (typeof this.system.starten !== 'function') {
      const r = await this._docker(alle, { zeitlimit_ms, erlaubteCodes: [0, 1, 2, 17, 18, 130] }).catch((e) => { throw dockerFehler(text, e, `docker ${alle.join(' ')}`); });
      for (const z of `${r.stdout}\n${r.stderr}`.split('\n')) if (z.trim() && beiZeile) beiZeile(z);
      if (r.code !== 0) throw new FahnasFehler('E_SYSTEM', `${text}: ${String(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 600)}`, { befehl: `docker ${alle.join(' ')}`, ausgabe: String(r.stderr || r.stdout).slice(-4000), code: r.code });
      return { code: 0, ausgabe: `${r.stdout}\n${r.stderr}` };
    }
    return new Promise((ok, nein) => {
      const kind = this.system.starten('docker', alle, { env: UMGEBUNG, stdio: ['ignore', 'pipe', 'pipe'] });
      let aus = ''; let puffer = ''; let fertig = false; let getoetet = false;
      const zeile = (z) => { if (z.trim()) { aus += z + '\n'; if (aus.length > 200_000) aus = aus.slice(-100_000); if (beiZeile) { try { beiZeile(z); } catch { /* egal */ } } } };
      const daten = (d) => { puffer += d; let i; while ((i = puffer.indexOf('\n')) >= 0) { zeile(puffer.slice(0, i).replace(/\r$/, '')); puffer = puffer.slice(i + 1); } };
      kind.stdout.setEncoding('utf8'); kind.stdout.on('data', daten);
      kind.stderr.setEncoding('utf8'); kind.stderr.on('data', daten);
      const timer = setTimeout(() => { getoetet = true; try { kind.kill('SIGTERM'); } catch { /* egal */ } }, zeitlimit_ms); timer.unref();
      const waechter = setInterval(() => { if (abgebrochen && abgebrochen()) { getoetet = true; try { kind.kill('SIGTERM'); } catch { /* egal */ } } }, 500); waechter.unref();
      const ende = (code, fehlerText) => {
        if (fertig) return; fertig = true; clearTimeout(timer); clearInterval(waechter);
        if (puffer.trim()) zeile(puffer);
        if (fehlerText) return nein(new FahnasFehler('E_SYSTEM', `${text}: ${fehlerText}`, { befehl: `docker ${alle.join(' ')}`, ausgabe: aus.slice(-4000) }));
        if (getoetet) return nein(new FahnasFehler(abgebrochen && abgebrochen() ? 'E_ABGEBROCHEN' : 'E_SYSTEM', abgebrochen && abgebrochen() ? 'Abgebrochen' : `${text}: Zeitüberschreitung`, { befehl: `docker ${alle.join(' ')}`, ausgabe: aus.slice(-4000) }));
        if (code !== 0) return nein(new FahnasFehler('E_SYSTEM', `${text}: ${aus.trim().split('\n').slice(-3).join(' ').slice(0, 600)}`, { befehl: `docker ${alle.join(' ')}`, ausgabe: aus.slice(-4000), code }));
        ok({ code: 0, ausgabe: aus });
      };
      kind.on('error', (e) => ende(-1, e.message));
      kind.on('close', (code) => ende(code));
    });
  }

  /** compose pull mit Fortschritt: Dienste „Pulled“/„Pulling“ zählen. `ignorieren` = --ignore-pull-failures (lokale Images). */
  async pull(app, dienste, { fortschritt, ignorieren = false, abgebrochen } = {}) {
    const gesamt = Math.max(1, dienste.length);
    const fertigDienste = new Set(); const fehler = []; let schichten = 0;
    const r = await this.composeMitZeilen(app, ['pull', ...(ignorieren ? ['--ignore-pull-failures'] : [])], {
      abgebrochen, text: 'Das Herunterladen der Images schlug fehl',
      beiZeile: (z) => {
        const m = /^\s*(\S+)\s+(Pulled|Pulling|Error|Warning|Skipped)\b(.*)$/.exec(z);
        if (m && (m[2] === 'Pulled' || m[2] === 'Skipped')) fertigDienste.add(m[1]);
        else if (m && m[2] === 'Error') { fertigDienste.add(m[1]); fehler.push(`${m[1]}: ${m[3].trim().slice(0, 300)}`); }
        else if (/\b(Downloading|Extracting|Download complete|Pull complete|Waiting|Verifying)\b/.test(z)) schichten++;
        if (fortschritt) fortschritt(Math.min(0.95, fertigDienste.size / gesamt + Math.min(0.9 / gesamt, schichten * 0.01)), m && m[2] === 'Pulling' ? `Image für „${m[1]}“ wird geladen` : undefined);
      },
    });
    return { ausgabe: r.ausgabe, fehler };
  }

  up(app, { abgebrochen, fortschritt, bauen = false } = {}) {
    return this.composeMitZeilen(app, ['up', '-d', '--remove-orphans', ...(bauen ? ['--build'] : [])], { abgebrochen, text: 'Die App konnte nicht gestartet werden', beiZeile: (z) => { const m = /Container\s+(\S+)\s+(Started|Created|Healthy|Running)/.exec(z); if (m && fortschritt) fortschritt(undefined, `${m[1]} ${m[2] === 'Started' || m[2] === 'Running' ? 'gestartet' : m[2] === 'Created' ? 'angelegt' : 'gesund'}`); } });
  }
  down(app, { volumes = false } = {}) { return this.compose(app, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])], { text: 'Die App konnte nicht entfernt werden', zeitlimit_ms: 10 * 60 * 1000 }); }
  start(app) { return this.compose(app, ['start'], { text: 'Die App konnte nicht gestartet werden' }); }
  stop(app) { return this.compose(app, ['stop'], { text: 'Die App konnte nicht gestoppt werden', zeitlimit_ms: 5 * 60 * 1000 }); }
  restart(app) { return this.compose(app, ['restart'], { text: 'Die App konnte nicht neu gestartet werden', zeitlimit_ms: 5 * 60 * 1000 }); }

  /** Container der App (auch gestoppte). */
  async ps(app) {
    const r = await this.compose(app, ['ps', '-a', '--format', 'json'], { text: 'Der Zustand der App ließ sich nicht lesen' });
    return jsonZeilen(r.stdout).map(containerNormieren);
  }

  /** Protokollzeilen (tail), ohne Farben, mit Zeitstempeln; optional nur ein Dienst. */
  async logs(app, { zeilen = 200, dienst } = {}) {
    const r = await this.compose(app, ['logs', '--no-color', '--timestamps', '--tail', String(zeilen), ...(dienst ? [dienst] : [])], { text: 'Das Protokoll ließ sich nicht lesen' });
    return `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`.split('\n').map((z) => z.replace(/\r$/, '')).filter((z) => z.trim());
  }

  /** Images der Compose-Datei (docker compose config --images). */
  async images(app) {
    const r = await this.compose(app, ['config', '--images'], { text: 'Die Compose-Datei ließ sich nicht auswerten' });
    return [...new Set(String(r.stdout).split('\n').map((z) => z.trim()).filter(Boolean))];
  }

  /**
   * Images einer entfernten App löschen – `docker image rm` OHNE -f: Images, die noch ein Container (auch einer anderen App)
   * benutzt, bleiben stehen. Fehler zählen nicht (benutzt oder schon weg).
   * @returns {Promise<{entfernt:string[], bytes:number}>} bytes = Größe laut `image inspect` vor dem Löschen (geteilte Schichten voll gezählt)
   */
  async imagesEntfernen(images) {
    const entfernt = []; let bytes = 0;
    for (const i of [...new Set(images)].filter(Boolean)) {
      let groesse = 0;
      try { groesse = Number(String((await this._docker(['image', 'inspect', '--format', '{{.Size}}', i], { zeitlimit_ms: 30_000 })).stdout).trim()) || 0; } catch { continue; } // nicht (mehr) da
      try { await this._docker(['image', 'rm', i], { zeitlimit_ms: 120_000 }); entfernt.push(i); bytes += groesse; } catch { /* noch benutzt */ }
    }
    this.leeren();
    return { entfernt, bytes };
  }

  /**
   * Datenmüll weg, den niemand per Oberfläche sieht: unbenannte Images (alte Versionen nach Aktualisieren/Neubau) und
   * Bau-Zwischenspeicher, der älter als 7 Tage ist. Benannte Images und alles, was ein Container benutzt, bleibt.
   * `cacheAlle` (Knopf „Aufräumen“ der Kachel Docker-Speicher): den ganzen Bau-Zwischenspeicher, nicht nur den alten.
   * @returns {Promise<number>} freigegebene Bytes (Summe aus „Total reclaimed space“ / „Total: …“)
   */
  async aufraeumen({ cacheAlle = false } = {}) {
    let frei = 0;
    for (const args of [['image', 'prune', '-f'], cacheAlle ? ['builder', 'prune', '-f'] : ['builder', 'prune', '-f', '--filter', 'until=168h']]) {
      try {
        const r = await this._docker(args, { zeitlimit_ms: 600_000 });
        const m = /(?:Total reclaimed space|Total):\s*([\d.]+\s*[KMGTP]?i?B)/i.exec(String(r.stdout));
        if (m) frei += speicherParsen(m[1]) || 0;
      } catch (e) { process.stderr.write(`[apps] docker ${args.slice(0, 2).join(' ')}: ${e.message}\n`); }
    }
    this.leeren();
    return frei;
  }

  /**
   * Wirksame Einstellungen (docker compose config --format json) – mit oder ohne die Anpassungen des App-Editors.
   * @returns {Promise<object>} {services:{…}} wie von compose aufgelöst (Ports, Volumes, environment …)
   */
  async configJson(app, { ohneAnpassung = false } = {}) {
    const a = ohneAnpassung ? { ...app, anpassungDatei: null } : app;
    let r;
    try { r = await this._docker([...composeArgs(a), 'config', '--format', 'json'], { zeitlimit_ms: 60_000 }); } catch (e) {
      throw new FahnasFehler('E_PARAMS', `docker compose kann die Einstellungen nicht lesen: ${String(ausgabe(e)).trim().split('\n').slice(-2).join(' ').slice(0, 500)}`, { ausgabe: String(ausgabe(e)).slice(-4000) });
    }
    try { return JSON.parse(String(r.stdout)); } catch { throw new FahnasFehler('E_SYSTEM', 'docker compose lieferte unlesbare Einstellungen'); }
  }

  /** Compose-Datei prüfen (docker compose config -q) → wirft E_PARAMS mit der Ausgabe von compose. */
  async pruefen(app) {
    try { await this._docker([...composeArgs(app), 'config', '-q']); } catch (e) {
      throw new FahnasFehler('E_PARAMS', `docker compose lehnt die Vorlage ab: ${String(ausgabe(e)).trim().split('\n').slice(-2).join(' ').slice(0, 500)}`, { feld: 'compose', ausgabe: String(ausgabe(e)).slice(-4000) });
    }
  }

  /** Kennung eines lokalen Images: RepoDigest (registry-Digest), sonst Image-ID; null, wenn nicht vorhanden. */
  async digest(image) {
    try {
      const r = await this._docker(['image', 'inspect', '--format', '{{json .RepoDigests}}|{{.Id}}', image]);
      const [dig, id] = String(r.stdout).trim().split('|');
      let liste = []; try { liste = JSON.parse(dig); } catch { /* egal */ }
      return (Array.isArray(liste) && liste.length ? String(liste[0]).split('@').pop() : null) || id || null;
    } catch { return null; }
  }

  /** RepoDigests des lokalen Images (Array, leer bei lokal gebauten) oder null, wenn es das Image nicht gibt. */
  async repoDigests(image) {
    let r;
    try { r = await this._docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', image], { zeitlimit_ms: 30_000 }); } catch { return null; }
    try { const l = JSON.parse(String(r.stdout).trim()); return Array.isArray(l) ? l : []; } catch { return []; }
  }

  /**
   * Belegung durch Docker (Kachel „Docker-Speicher“): `docker system df` je Art, Docker-Wurzel und die Größe der
   * Container-Protokolle (*-json.log). Wirft nur, wenn `docker system df` scheitert.
   * @returns {Promise<{images, container, volumes, cache, logs:number|null, wurzel:string|null}>}
   */
  async speicher() {
    const r = await this._docker(['system', 'df', '--format', '{{json .}}'], { zeitlimit_ms: 120_000 });
    const aus = { ...systemDfParsen(r.stdout), logs: null, wurzel: null };
    try { aus.wurzel = String((await this._docker(['info', '--format', '{{.DockerRootDir}}'], { zeitlimit_ms: 15_000 })).stdout).trim() || null; } catch { /* egal */ }
    if (aus.wurzel) {
      try {
        const f = await this.system.ausfuehren('find', [`${aus.wurzel}/containers`, '-name', '*-json.log', '-printf', '%s\n'], { erlaubteCodes: [0, 1], zeitlimit_ms: 30_000 });
        aus.logs = String(f.stdout).split('\n').reduce((s, z) => s + (Number(z) || 0), 0);
      } catch { /* find fehlt */ }
    }
    return aus;
  }

  /** Ist das buildx-Plugin da? (Ubuntu-Paket docker-buildx; ohne läuft docker build mit dem alten Builder) */
  async buildxDa() {
    if (this._buildx !== undefined) return this._buildx;
    try { await this._docker(['buildx', 'version'], { zeitlimit_ms: 15_000 }); this._buildx = true; } catch { this._buildx = false; }
    return this._buildx;
  }

  /** Wert eines Labels am lokalen Image; null, wenn Image oder Label fehlen. */
  async imageLabel(image, label) {
    try {
      const r = await this._docker(['image', 'inspect', '--format', `{{ index .Config.Labels ${JSON.stringify(label)} }}`, image]);
      const v = String(r.stdout).trim();
      return v && v !== '<no value>' ? v : null;
    } catch { return null; }
  }

  /**
   * Image aus einem Build-Kontext bauen (FAH-Apps: Quellcode liegt im Programm unter katalog/quellen/<id>/).
   * `labels` landen am Image (fahnas.quelle = Prüfsumme der Quelle → Aktualisieren erkennt, ob neu gebaut werden muss).
   * Fortschritt aus „#5 [2/6] RUN …“ (BuildKit) bzw. „Step 2/6 : RUN …“ (alter Builder).
   */
  async bauen(image, kontext, { labels = {}, fortschritt, abgebrochen, zeitlimit_ms = ZEIT_LANG } = {}) {
    const args = ['build', '--pull', '-t', image];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    if (await this.buildxDa()) args.push('--progress', 'plain');
    args.push(kontext);
    let schritt = 0; let gesamt = 0;
    const r = await this.dockerMitZeilen(args, {
      abgebrochen, zeitlimit_ms, text: `Das Image ${image} konnte nicht gebaut werden`,
      beiZeile: (z) => {
        const m = /^#\d+ \[(?:[^\]]*\s)?(\d+)\/(\d+)\]\s*(.*)$/.exec(z) || /^Step (\d+)\/(\d+) : (.*)$/.exec(z);
        if (!m) return;
        const n = Number(m[1]); const g = Number(m[2]);
        if (!(g > 0) || n < schritt) return;
        schritt = n; gesamt = g;
        if (fortschritt) fortschritt(Math.min(0.98, n / g), `Image ${image} wird gebaut: Schritt ${n}/${g} – ${String(m[3] || '').slice(0, 80)}`);
      },
    });
    this.leeren();
    return { ausgabe: r.ausgabe, schritte: gesamt };
  }

  /** Alle Container des Systems (docker ps -a), 10 s zwischengespeichert: [{id, name, projekt, dienst, zustand, status, ports, image}]. */
  async containerAlle() {
    if (this._container && Date.now() - this._container.zeit < CACHE_MS) return this._container.liste;
    const r = await this._docker(['ps', '-a', '--no-trunc', '--format', 'json']).catch((e) => { throw dockerFehler('Docker antwortet nicht', e, 'docker ps -a'); });
    const liste = jsonZeilen(r.stdout).map((o) => {
      const l = labelsParsen(o.Labels);
      return { id: String(o.ID || ''), name: String(o.Names || o.Name || ''), projekt: l['com.docker.compose.project'] || null, dienst: l['com.docker.compose.service'] || null, zustand: String(o.State || '').toLowerCase(), status: String(o.Status || ''), ports: portsParsen(o.Ports), image: String(o.Image || '') };
    });
    this._container = { zeit: Date.now(), liste };
    return liste;
  }

  /** CPU/RAM aller laufenden Container (docker stats --no-stream), 10 s zwischengespeichert: Map id → {cpu_prozent, ram_bytes}. */
  async statsAlle() {
    if (this._stats && Date.now() - this._stats.zeit < CACHE_MS) return this._stats.karte;
    const karte = new Map();
    try {
      const r = await this._docker(['stats', '--no-stream', '--format', 'json'], { zeitlimit_ms: 30_000 });
      for (const o of jsonZeilen(r.stdout)) {
        const e = { cpu_prozent: Number(String(o.CPUPerc || '0').replace('%', '')) || 0, ram_bytes: speicherParsen(o.MemUsage) };
        for (const k of [o.Container, o.ID, o.Name]) if (k) karte.set(String(k), e);
      }
    } catch (e) { process.stderr.write(`[apps] docker stats: ${e.message}\n`); }
    this._stats = { zeit: Date.now(), karte };
    return karte;
  }

  /**
   * Belegte Host-Ports: ss -ltnuH (alles, was lauscht) + docker ps (auch gestoppte Container mit Veröffentlichung).
   * @returns {Promise<Map<string, string>>} „port/proto“ → Beschreibung („Dienst auf dem NAS“ | „Container <name>“)
   */
  async belegtePorts() {
    const aus = new Map();
    for (const [k, v] of await this.belegtePortsMitAdressen()) aus.set(k, v.text);
    return aus;
  }

  /**
   * Wie belegtePorts, zusätzlich die Lauschadressen je Port („*“ = alle Adressen, auch für Container-Veröffentlichungen).
   * Auf FAH-NAS lauschen systemd-resolved (127.0.0.53/127.0.0.54) und libvirt-dnsmasq (192.168.122.1) auf Port 53 –
   * ein DNS-Dienst, der nur an die LAN-Adresse des NAS bindet, kollidiert damit nicht.
   * @returns {Promise<Map<string, {text:string, adressen:string[]}>>}
   */
  async belegtePortsMitAdressen() {
    const aus = new Map();
    const dazu = (k, text, adresse) => { const e = aus.get(k) || { text, adressen: [] }; if (!e.adressen.includes(adresse)) e.adressen.push(adresse); aus.set(k, e); };
    try {
      const r = await this.system.ausfuehren('ss', ['-ltnuH'], { erlaubteCodes: [0, 1], zeitlimit_ms: 15_000 });
      for (const z of String(r.stdout).split('\n')) {
        const t = z.trim().split(/\s+/);
        if (t.length < 5) continue;
        const proto = t[0].toLowerCase().startsWith('udp') ? 'udp' : 'tcp';
        const m = /^(.*):(\d+)$/.exec(t[4]);
        if (m) dazu(`${m[2]}/${proto}`, 'Dienst auf dem NAS', adresseNormieren(m[1]));
      }
    } catch (e) { process.stderr.write(`[apps] ss: ${e.message}\n`); }
    try {
      for (const c of await this.containerAlle()) for (const p of c.ports) dazu(`${p.port}/${p.protokoll}`, aus.has(`${p.port}/${p.protokoll}`) ? aus.get(`${p.port}/${p.protokoll}`).text : `Container ${c.name}`, '*');
    } catch { /* schon gemeldet */ }
    return aus;
  }
}
