// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Unraid-Importer: Community-Applications-Vorlagen (XML, Format v1 und v2) und der Anwendungs-Feed
// (applicationFeed.json) werden in Katalog-Vorlagen (Compose + Felder) übersetzt.
//   Repository → image, Network bridge/host, Privileged, WebUI [IP]/[PORT:x] → {HOST}/{PORT_x}, Icon, Overview,
//   Category, je <Config Type="Port|Path|Variable|Device|Label"> ein Feld bzw. fester Eintrag, ExtraParams (nur
//   bekannte Schalter), PostArgs verworfen (Hinweis). Eigener XML-Leser ohne Fremdpaket.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { NAME_FELD, vorlagePruefen } from './compose.js';

export const FEED_URL = 'https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json';
const DOCKER_SOCK = /^\/(var\/)?run\/docker\.sock$/;

// ---------------------------------------------------------------------------------------------------------------
// XML-Leser (Teilmenge: Elemente, Attribute, Text, CDATA, Kommentare, Entitäten)
// ---------------------------------------------------------------------------------------------------------------
function xmlFehler(text, pos) { return new FahnasFehler('E_PARAMS', `XML-Vorlage ungültig: ${text}`, { feld: 'xml', position: pos }); }

export function entitaeten(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g, (g, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e];
  });
}

/** Liest XML in einen Baum {name, attribute, kinder, text}. `text` = direkter Text (ohne Kinder), getrimmt. */
export function xmlLesen(text) {
  if (typeof text !== 'string') throw xmlFehler('Text erwartet');
  const s = text.replace(/^﻿/, '');
  let i = 0;
  const wurzel = { name: '#dok', attribute: {}, kinder: [], textTeile: [] };
  const stapel = [wurzel];
  const oben = () => stapel[stapel.length - 1];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { oben().textTeile.push(s.slice(i)); break; }
    if (lt > i) oben().textTeile.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); if (e < 0) throw xmlFehler('Kommentar nicht geschlossen', lt); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); if (e < 0) throw xmlFehler('CDATA nicht geschlossen', lt); oben().textTeile.push({ roh: s.slice(lt + 9, e) }); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); if (e < 0) throw xmlFehler('Verarbeitungsanweisung nicht geschlossen', lt); i = e + 2; continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); if (e < 0) throw xmlFehler('Deklaration nicht geschlossen', lt); i = e + 1; continue; }
    const gt = tagEnde(s, lt);
    if (gt < 0) throw xmlFehler('Tag nicht geschlossen', lt);
    const innen = s.slice(lt + 1, gt);
    if (innen.startsWith('/')) {
      const name = innen.slice(1).trim();
      const el = oben();
      if (el === wurzel || el.name !== name) throw xmlFehler(`schließendes </${name}> passt nicht zu <${el.name}>`, lt);
      stapel.pop();
      i = gt + 1; continue;
    }
    const selbst = innen.endsWith('/');
    const kopf = selbst ? innen.slice(0, -1) : innen;
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(kopf.trim());
    if (!m) throw xmlFehler('Elementname fehlt', lt);
    const el = { name: m[1], attribute: attributeLesen(m[2], lt), kinder: [], textTeile: [] };
    oben().kinder.push(el);
    if (!selbst) stapel.push(el);
    i = gt + 1;
  }
  if (stapel.length !== 1) throw xmlFehler(`Element <${oben().name}> nicht geschlossen`);
  const fertig = (el) => {
    el.text = el.textTeile.map((t) => (typeof t === 'string' ? entitaeten(t) : t.roh)).join('').trim();
    delete el.textTeile;
    el.kinder.forEach(fertig);
    return el;
  };
  fertig(wurzel);
  const dok = wurzel.kinder.find((k) => k.name);
  if (!dok) throw xmlFehler('kein Wurzelelement');
  return dok;
}

/** Ende eines Tags („>“ außerhalb von Attribut-Anführungszeichen). */
function tagEnde(s, von) {
  let q = null;
  for (let i = von + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

function attributeLesen(text, pos) {
  const aus = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) aus[m[1]] = entitaeten(m[3] !== undefined ? m[3] : m[4]);
  if (text.replace(re, '').trim()) throw xmlFehler('Attribute nicht lesbar', pos);
  return aus;
}

function kind(el, name) { return el.kinder.find((k) => k.name === name) || null; }
function kinder(el, name) { return el.kinder.filter((k) => k.name === name); }
function textVon(el, name) { const k = kind(el, name); return k ? k.text : ''; }

// ---------------------------------------------------------------------------------------------------------------
// Normierte Form (aus XML oder Feed)
// ---------------------------------------------------------------------------------------------------------------
/** XML → normierte Vorlagendaten (Format v2 mit <Config>, v1 mit <Networking>/<Data>/<Environment>). */
export function datenAusXml(text) {
  const wurzel = xmlLesen(text);
  if (wurzel.name !== 'Container') throw new FahnasFehler('E_PARAMS', `Keine Unraid-Vorlage: Wurzelelement ist <${wurzel.name}>, erwartet <Container>`, { feld: 'xml' });
  const d = {};
  for (const n of ['Name', 'Repository', 'Registry', 'Network', 'Privileged', 'Overview', 'Description', 'Category', 'WebUI', 'Icon', 'ExtraParams', 'PostArgs', 'Project', 'Support', 'TemplateURL', 'Requires', 'Shell', 'Date', 'DonateLink', 'ReadMe', 'GitHub']) {
    const t = textVon(wurzel, n); if (t) d[n] = t;
  }
  d.Config = kinder(wurzel, 'Config').map((c) => ({ attr: { ...c.attribute }, value: c.text }));
  const netz = kind(wurzel, 'Networking');
  if (netz) {
    d.Networking = { Mode: textVon(netz, 'Mode'), Publish: [] };
    const pub = kind(netz, 'Publish');
    if (pub) d.Networking.Publish = kinder(pub, 'Port').map((p) => ({ HostPort: textVon(p, 'HostPort'), ContainerPort: textVon(p, 'ContainerPort'), Protocol: textVon(p, 'Protocol') }));
  }
  const data = kind(wurzel, 'Data');
  if (data) d.Data = kinder(data, 'Volume').map((v) => ({ HostDir: textVon(v, 'HostDir'), ContainerDir: textVon(v, 'ContainerDir'), Mode: textVon(v, 'Mode') }));
  const env = kind(wurzel, 'Environment');
  if (env) d.Environment = kinder(env, 'Variable').map((v) => ({ Name: textVon(v, 'Name'), Value: textVon(v, 'Value') }));
  return d;
}

function alsListe(x) { if (x === undefined || x === null || x === '') return []; return Array.isArray(x) ? x : [x]; }

/** Feed-Eintrag (applicationFeed.json → applist[]) → normierte Vorlagendaten. */
export function datenAusFeed(e) {
  const d = {};
  for (const n of ['Name', 'Repository', 'Registry', 'Network', 'Privileged', 'Overview', 'Description', 'Category', 'WebUI', 'Icon', 'ExtraParams', 'PostArgs', 'Project', 'Support', 'TemplateURL', 'Requires', 'Date']) {
    if (typeof e[n] === 'string' && e[n].trim()) d[n] = e[n].trim(); else if (typeof e[n] === 'boolean' || typeof e[n] === 'number') d[n] = String(e[n]);
  }
  if (Array.isArray(e.CategoryList)) d.CategoryList = e.CategoryList.map(String);
  d.Config = alsListe(e.Config).filter((c) => c && typeof c === 'object').map((c) => ({ attr: { ...(c['@attributes'] || c.attr || {}) }, value: typeof c.value === 'string' ? c.value : (typeof c.value === 'number' ? String(c.value) : '') }));
  if (e.Networking && typeof e.Networking === 'object') {
    d.Networking = { Mode: String(e.Networking.Mode || ''), Publish: alsListe(e.Networking.Publish && e.Networking.Publish.Port).map((p) => ({ HostPort: String(p.HostPort ?? ''), ContainerPort: String(p.ContainerPort ?? ''), Protocol: String(p.Protocol ?? '') })) };
  }
  if (e.Data && typeof e.Data === 'object') d.Data = alsListe(e.Data.Volume).map((v) => ({ HostDir: String(v.HostDir ?? ''), ContainerDir: String(v.ContainerDir ?? ''), Mode: String(v.Mode ?? '') }));
  if (e.Environment && typeof e.Environment === 'object') d.Environment = alsListe(e.Environment.Variable).map((v) => ({ Name: String(v.Name ?? ''), Value: String(v.Value ?? '') }));
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Übersetzung in eine Katalog-Vorlage
// ---------------------------------------------------------------------------------------------------------------
const KATEGORIEN = {
  tools: 'Werkzeuge', utilities: 'Werkzeuge', utility: 'Werkzeuge', productivity: 'Produktivität', productivitytools: 'Produktivität',
  mediaapp: 'Medien', mediaapplication: 'Medien', mediaserver: 'Medienserver', mediamanager: 'Medien', downloaders: 'Downloads',
  backup: 'Sicherung', cloud: 'Cloud', homeautomation: 'Smart Home', home: 'Smart Home', automation: 'Automatisierung',
  network: 'Netzwerk', networktools: 'Netzwerk', security: 'Sicherheit', gameservers: 'Spieleserver', game: 'Spieleserver',
  ai: 'KI', crypto: 'Krypto', currency: 'Krypto', drivers: 'Treiber', development: 'Entwicklung', database: 'Datenbanken', databases: 'Datenbanken',
  monitoring: 'Überwachung', monitoringlogging: 'Überwachung', status: 'Überwachung', other: 'Sonstiges', storage: 'Speicher', social: 'Soziales',
  finance: 'Finanzen', blog: 'Webseiten', webservers: 'Webserver', webserver: 'Webserver', servers: 'Server', system: 'System', private: 'Sonstiges',
  selfhosted: 'Sonstiges', plugins: 'Sonstiges',
};

/** Unraid-Kategorie („Tools:Utilities“, „MediaApp-Video“, Liste) → deutsche Hauptkategorie. */
export function kategorieUebersetzen(kat, liste) {
  const erste = Array.isArray(liste) && liste.length ? String(liste[0]) : String(kat || '');
  const kopf = erste.split(/[:\-;\s]/)[0].toLowerCase();
  return KATEGORIEN[kopf] || 'Sonstiges';
}

/** URL-/Namens-Slug (a-z0-9-). */
export function slug(s, max = 60) {
  return String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'app';
}

function feldName(basis, vergeben) {
  let n = String(basis).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  if (!/^[A-Z]/.test(n)) n = `VAR_${n}`;
  if (!NAME_FELD.test(n)) n = 'VAR';
  let k = n; let z = 2;
  while (vergeben.has(k)) k = `${n}_${z++}`;
  vergeben.add(k);
  return k;
}

/** YAML-Zeichenkette in doppelten Anführungszeichen; `$` wird für compose als `$$` maskiert (kein Platzhalter). */
function zq(s) { return JSON.stringify(String(s).replace(/\$/g, '$$$$')); }
/** Wie zq, aber unsere Platzhalter ${FELD} bleiben Platzhalter. */
function zqMitPlatzhaltern(s) { return JSON.stringify(String(s)).replace(/\$(?!\{[A-Z][A-Z0-9_]*\})/g, '$$$$'); }

/** Standardpfad für ein Pfad-Feld: Unraid-Vorgaben (/mnt/user/…) werden zu daten/<zielname>. */
function pfadStandard(ziel, vorgabe) {
  const v = String(vorgabe || '').trim();
  if (v && !v.startsWith('/mnt/') && !v.startsWith('/')) return v; // schon relativ
  const basis = String(ziel || '').replace(/\/+$/, '').split('/').pop() || 'wurzel';
  return `daten/${slug(basis, 40)}`;
}

/** ExtraParams (docker-run-Schalter) tokenisieren (Anführungszeichen beachten). */
export function extraParamsZerlegen(text) {
  const aus = []; let akt = ''; let q = null; let offen = false;
  for (const c of String(text || '')) {
    if (q) { if (c === q) q = null; else akt += c; offen = true; continue; }
    if (c === '"' || c === "'") { q = c; offen = true; continue; }
    if (/\s/.test(c)) { if (offen) { aus.push(akt); akt = ''; offen = false; } continue; }
    akt += c; offen = true;
  }
  if (offen) aus.push(akt);
  return aus;
}

/** Bekannte docker-run-Schalter → Compose-Dienst-Einträge; Unbekanntes als Hinweis. */
export function extraParamsUebersetzen(text) {
  const t = extraParamsZerlegen(text);
  const d = { environment: [], cap_add: [], cap_drop: [], devices: [], sysctls: [], dns: [], tmpfs: [], security_opt: [], labels: [], extra_hosts: [], group_add: [] };
  const hinweise = [];
  const MIT_WERT = new Set(['--restart', '-e', '--env', '--cap-add', '--cap-drop', '--device', '--sysctl', '--shm-size', '--hostname', '-h', '--stop-timeout', '--dns', '--user', '-u', '--tmpfs', '--memory', '-m', '--cpus', '--runtime', '--security-opt', '--label', '-l', '--entrypoint', '--mac-address', '--add-host', '--group-add', '--pid', '--network', '--net', '--gpus', '--log-opt', '--log-driver', '--ulimit', '--ip', '--ip6', '--health-cmd', '--health-interval', '--health-retries', '--health-timeout', '--health-start-period', '--cpu-shares', '--memory-swap', '--name', '--volume', '-v', '--publish', '-p', '--workdir', '-w', '--platform', '--cgroup-parent', '--device-cgroup-rule', '--storage-opt', '--link', '--expose', '--domainname', '--env-file', '--label-file', '--ipc', '--uts', '--userns', '--mount', '--oom-score-adj', '--pids-limit', '--cpuset-cpus', '--memory-reservation', '--blkio-weight', '--kernel-memory', '--attach', '-a', '--cidfile', '--detach-keys', '--isolation', '--stop-signal', '--sig-proxy', '--volumes-from', '--annotation', '--cgroupns', '--dns-option', '--dns-search', '--restart-policy']);
  for (let i = 0; i < t.length; i++) {
    let s = t[i]; let w = null;
    const eq = s.indexOf('=');
    if (s.startsWith('--') && eq > 0) { w = s.slice(eq + 1); s = s.slice(0, eq); }
    else if (MIT_WERT.has(s) && i + 1 < t.length) { w = t[++i]; }
    switch (s) {
      case '--restart': if (/^(no|always|on-failure|unless-stopped)(:\d+)?$/.test(w || '')) d.restart = w; else hinweise.push(`--restart ${w}: unbekannte Regel, unless-stopped verwendet`); break;
      case '-e': case '--env': if (w && /^[A-Za-z_][A-Za-z0-9_.-]*=/.test(w)) d.environment.push(w); else hinweise.push(`Umgebungsvariable „${w}“ ohne Wert übersprungen`); break;
      case '--cap-add': if (w) d.cap_add.push(w.toUpperCase().replace(/^CAP_/, '')); break;
      case '--cap-drop': if (w) d.cap_drop.push(w.toUpperCase().replace(/^CAP_/, '')); break;
      case '--device': if (w) d.devices.push(w); break;
      case '--sysctl': if (w && w.includes('=')) d.sysctls.push(w); break;
      case '--shm-size': if (w) d.shm_size = w; break;
      case '--hostname': case '-h': if (w) d.hostname = w; break;
      case '--stop-timeout': if (w && /^\d+$/.test(w)) d.stop_grace_period = `${w}s`; break;
      case '--dns': if (w) d.dns.push(w); break;
      case '--user': case '-u': if (w) d.user = w; break;
      case '--read-only': d.read_only = true; break;
      case '--tmpfs': if (w) d.tmpfs.push(w); break;
      case '--memory': case '-m': if (w) d.mem_limit = w; break;
      case '--cpus': if (w) d.cpus = w; break;
      case '--runtime': if (w) d.runtime = w; break;
      case '--security-opt': if (w) d.security_opt.push(w); break;
      case '--label': case '-l': if (w) d.labels.push(w); break;
      case '--entrypoint': if (w) d.entrypoint = w; break;
      case '--mac-address': if (w) d.mac_address = w; break;
      case '--add-host': if (w) d.extra_hosts.push(w); break;
      case '--group-add': if (w) d.group_add.push(w); break;
      case '--init': d.init = true; break;
      case '--privileged': d.privileged = true; break;
      case '--pid': if (w === 'host') d.pid = 'host'; else hinweise.push(`--pid ${w} übersprungen`); break;
      case '--no-healthcheck': d.healthcheck_aus = true; break;
      case '--network': case '--net': hinweise.push(`Netzwerk „${w}“ aus ExtraParams wird nicht übernommen (Netzwerkmodus kommt aus <Network>)`); break;
      case '--gpus': case '--log-opt': case '--log-driver': case '--ulimit': case '--ip': case '--ip6': case '--cpu-shares': case '--memory-swap': case '--name': case '--volume': case '-v': case '--publish': case '-p': case '--platform': case '--cgroup-parent': case '--device-cgroup-rule': case '--storage-opt': case '--link': case '--expose': case '--domainname': case '--workdir': case '-w':
      case '--health-cmd': case '--health-interval': case '--health-retries': case '--health-timeout': case '--health-start-period':
        hinweise.push(`ExtraParams: „${s}${w !== null ? ` ${w}` : ''}“ wird nicht übernommen`); break;
      default: hinweise.push(`ExtraParams: „${s}${w !== null ? ` ${w}` : ''}“ unbekannt – ignoriert`);
    }
  }
  return { dienst: d, hinweise };
}

/**
 * Normierte Unraid-Daten → Katalog-Vorlage (geprüft mit vorlagePruefen). `optionen.quelle_url` wird als Herkunft vermerkt.
 */
export function vorlageAusUnraid(d, { quelle_url, id } = {}) {
  const name = String(d.Name || '').trim();
  if (!name) throw new FahnasFehler('E_PARAMS', 'Unraid-Vorlage ohne <Name>', { feld: 'xml' });
  const image = String(d.Repository || '').trim();
  if (!image || /\s/.test(image) || /:\/\//.test(image) || !/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(image)) throw new FahnasFehler('E_PARAMS', `Unraid-Vorlage „${name}“: <Repository> fehlt oder ist kein Image-Name`, { feld: 'xml', wert: image });
  const hinweise = [];
  const felder = []; const vergeben = new Set();
  const dienst = { image, ports: [], volumes: [], environment: [], devices: [], labels: [], cap_add: [], sysctls: [], security_opt: [] };
  const portFeldJeZiel = new Map(); // "8080/tcp" → Feldname
  let netz = String(d.Network || (d.Networking && d.Networking.Mode) || 'bridge').trim().toLowerCase();
  if (netz !== 'bridge' && netz !== 'host' && netz !== 'none') { hinweise.push(`Netzwerk „${netz}“ (eigenes Unraid-Netz) wird als bridge übernommen`); netz = 'bridge'; }
  const privilegiert = /^true$/i.test(String(d.Privileged || ''));

  const portFeld = (hostPort, containerPort, proto, beschriftung, erklaerung, pflicht) => {
    const p = proto === 'udp' ? 'udp' : 'tcp';
    const ziel = Number(String(containerPort).trim());
    if (!Number.isInteger(ziel) || ziel < 1 || ziel > 65535) { hinweise.push(`Port „${containerPort}“ unverständlich – übersprungen`); return; }
    const f = { name: feldName(`PORT_${ziel}${p === 'udp' ? '_UDP' : ''}`, vergeben), art: 'port', beschriftung: beschriftung || `Port ${ziel}${p === 'udp' ? ' (UDP)' : ''}`, erklaerung: erklaerung || `Port auf dem NAS, der auf Port ${ziel}/${p} im Container zeigt.`, protokoll: p, container: ziel, pflicht: true };
    const h = Number(String(hostPort || '').trim());
    f.standard = Number.isInteger(h) && h >= 1 && h <= 65535 ? h : ziel;
    felder.push(f); portFeldJeZiel.set(`${ziel}/${p}`, f.name);
    if (netz !== 'host') dienst.ports.push(`\${${f.name}}:${ziel}${p === 'udp' ? '/udp' : ''}`);
    else hinweise.push(`Netzwerkmodus host: Port ${ziel}/${p} wird nicht veröffentlicht (Feld ${f.name} nur zur Anzeige)`);
    return f;
  };
  const pfadFeld = (ziel, vorgabe, modus, beschriftung, erklaerung, pflicht) => {
    const z = String(ziel || '').trim();
    if (!z.startsWith('/')) { hinweise.push(`Pfad-Ziel „${z}“ unverständlich – übersprungen`); return; }
    const quelle = String(vorgabe || '').trim();
    if (DOCKER_SOCK.test(z) || DOCKER_SOCK.test(quelle)) { dienst.volumes.push(`/var/run/docker.sock:${z}${modus === 'ro' ? ':ro' : ''}`); return; }
    const f = { name: feldName(`PFAD_${z.replace(/^\/+/, '').replace(/\//g, '_') || 'WURZEL'}`, vergeben), art: 'pfad', beschriftung: beschriftung || `Ordner für ${z}`, erklaerung: erklaerung || `Ordner auf dem NAS, der im Container unter ${z} erscheint. Relativ = im App-Ordner, oder eine Freigabe (/data/shares/…).`, container: z, nur_lesen: modus === 'ro', pflicht: true, standard: pfadStandard(z, quelle) };
    felder.push(f);
    dienst.volumes.push(`\${${f.name}}:${z}${modus === 'ro' ? ':ro' : ''}`);
    return f;
  };
  const variablenFeld = (schluessel, vorgabe, beschriftung, erklaerung, pflicht, maskiert) => {
    const k = String(schluessel || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) { hinweise.push(`Variable „${k}“ hat keinen gültigen Namen – übersprungen`); return; }
    const v = String(vorgabe ?? '');
    const f = { name: feldName(k, vergeben), beschriftung: beschriftung || k, erklaerung: erklaerung || `Umgebungsvariable ${k} der App.`, pflicht: !!pflicht };
    if (maskiert) { f.art = 'geheimnis'; if (v) f.standard = v; }
    else if (/^[^|\s]+(\|[^|\s]+)+$/.test(v) && v.length < 200) { f.art = 'auswahl'; f.werte = v.split('|'); f.standard = f.werte[0]; }
    else { f.art = 'variable'; if (v !== '') f.standard = v; }
    felder.push(f);
    dienst.environment.push({ schluessel: k, feld: f.name });
    return f;
  };

  // v2: <Config>
  for (const c of d.Config || []) {
    const a = c.attr || {};
    const typ = String(a.Type || '').toLowerCase();
    const wert = (c.value !== undefined && c.value !== '' ? c.value : a.Default) ?? '';
    const pflicht = /^true$/i.test(String(a.Required || ''));
    const beschriftung = String(a.Name || '').trim();
    const erklaerung = String(a.Description || '').trim();
    if (typ === 'port') portFeld(wert, a.Target, String(a.Mode || 'tcp').toLowerCase(), beschriftung, erklaerung, pflicht);
    else if (typ === 'path') pfadFeld(a.Target, wert, String(a.Mode || 'rw').toLowerCase(), beschriftung, erklaerung, pflicht);
    else if (typ === 'variable') variablenFeld(a.Target, wert, beschriftung, erklaerung, pflicht, /^true$/i.test(String(a.Mask || '')));
    else if (typ === 'device') { const w = String(wert).trim(); if (w && !w.endsWith('/')) dienst.devices.push(w); else hinweise.push(`Gerät „${beschriftung || a.Target}“ ohne Pfad – bitte nach der Installation ergänzen`); }
    else if (typ === 'label') { const k = String(a.Target || '').trim(); if (k) dienst.labels.push(`${k}=${wert}`); }
    else hinweise.push(`Config-Typ „${a.Type}“ (${beschriftung}) unbekannt – übersprungen`);
  }
  // v1: <Networking>/<Data>/<Environment>
  for (const p of (d.Networking && d.Networking.Publish) || []) portFeld(p.HostPort, p.ContainerPort, String(p.Protocol || 'tcp').toLowerCase());
  for (const v of d.Data || []) pfadFeld(v.ContainerDir, v.HostDir, String(v.Mode || 'rw').toLowerCase());
  for (const v of d.Environment || []) variablenFeld(v.Name, v.Value, v.Name, '', false, /pass|secret|token|key/i.test(String(v.Name)));

  // ExtraParams
  const ep = extraParamsUebersetzen(d.ExtraParams);
  hinweise.push(...ep.hinweise);
  if (d.PostArgs && String(d.PostArgs).trim()) hinweise.push(`PostArgs „${String(d.PostArgs).trim().slice(0, 200)}“ werden nicht übernommen – bei Bedarf als command in der Vorlage ergänzen`);
  if (d.Requires && String(d.Requires).trim()) hinweise.push(`Voraussetzung laut Vorlage: ${String(d.Requires).replace(/\s+/g, ' ').trim().slice(0, 500)}`);
  if (privilegiert) hinweise.push('Die Vorlage verlangt privilegierten Betrieb – Installation nur mit Bestätigung');

  // Compose-Text
  const z = [];
  z.push('services:');
  z.push('  app:');
  z.push(`    image: ${zq(image)}`);
  z.push(`    container_name: fahnas-${slug(name, 40)}`);
  z.push(`    restart: ${ep.dienst.restart || 'unless-stopped'}`);
  if (netz === 'host') z.push('    network_mode: host');
  else if (netz === 'none') z.push('    network_mode: none');
  if (privilegiert || ep.dienst.privileged) z.push('    privileged: true');
  if (ep.dienst.pid) z.push(`    pid: ${ep.dienst.pid}`);
  for (const k of ['hostname', 'user', 'shm_size', 'stop_grace_period', 'mem_limit', 'cpus', 'runtime', 'entrypoint', 'mac_address']) if (ep.dienst[k] !== undefined) z.push(`    ${k}: ${zq(ep.dienst[k])}`);
  if (ep.dienst.read_only) z.push('    read_only: true');
  if (ep.dienst.init) z.push('    init: true');
  if (ep.dienst.healthcheck_aus) { z.push('    healthcheck:'); z.push('      disable: true'); }
  if (dienst.ports.length) { z.push('    ports:'); for (const p of dienst.ports) z.push(`      - ${zqMitPlatzhaltern(p)}`); }
  if (dienst.volumes.length) { z.push('    volumes:'); for (const v of dienst.volumes) z.push(`      - ${zqMitPlatzhaltern(v)}`); }
  const umgebung = [...dienst.environment.map((e) => ({ text: `${e.schluessel}=\${${e.feld}}` })), ...ep.dienst.environment.map((e) => ({ text: e, fest: true }))];
  if (umgebung.length) { z.push('    environment:'); for (const e of umgebung) z.push(`      - ${e.fest ? zq(e.text) : zqMitPlatzhaltern(e.text)}`); }
  const devices = [...dienst.devices, ...ep.dienst.devices];
  if (devices.length) { z.push('    devices:'); for (const x of devices) z.push(`      - ${zq(x)}`); }
  const labels = [...dienst.labels, ...ep.dienst.labels];
  if (labels.length) { z.push('    labels:'); for (const x of labels) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.cap_add.length) { z.push('    cap_add:'); for (const x of ep.dienst.cap_add) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.cap_drop.length) { z.push('    cap_drop:'); for (const x of ep.dienst.cap_drop) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.sysctls.length) { z.push('    sysctls:'); for (const x of ep.dienst.sysctls) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.security_opt.length) { z.push('    security_opt:'); for (const x of ep.dienst.security_opt) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.dns.length) { z.push('    dns:'); for (const x of ep.dienst.dns) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.tmpfs.length) { z.push('    tmpfs:'); for (const x of ep.dienst.tmpfs) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.extra_hosts.length) { z.push('    extra_hosts:'); for (const x of ep.dienst.extra_hosts) z.push(`      - ${zq(x)}`); }
  if (ep.dienst.group_add.length) { z.push('    group_add:'); for (const x of ep.dienst.group_add) z.push(`      - ${zq(x)}`); }
  const compose = z.join('\n') + '\n';

  // WebUI: [IP] → {HOST}, [PORT:8080] → {PORT_8080} (Feld) bzw. Standard
  let webui = String(d.WebUI || '').trim();
  if (webui) {
    webui = webui.replace(/\[IP\]/g, '{HOST}').replace(/\[PORT:(\d+)\]/g, (g, p) => {
      const f = portFeldJeZiel.get(`${p}/tcp`);
      if (f) return `{${f}}`;
      const fp = felder.find((x) => x.art === 'port' && String(x.container) === p);
      return fp ? `{${fp.name}}` : p;
    });
    if (!/^https?:\/\//i.test(webui)) webui = '';
  }
  const beschreibung = String(d.Overview || d.Description || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, 4000);
  const vorlage = {
    id: id || `unraid-${slug(name)}`, name, beschreibung, kategorie: kategorieUebersetzen(d.Category, d.CategoryList), symbol: d.Icon || '', quelle: 'unraid',
    webui, compose, felder, hinweise,
    herkunft: { art: 'unraid', vorlage_url: quelle_url || d.TemplateURL || '', repository: image, registry: d.Registry || '', projekt: d.Project || '', support: d.Support || '', datum: d.Date || '' },
  };
  return vorlagePruefen(vorlage, { quelle: 'unraid' });
}

/** XML-Text → Katalog-Vorlage. */
export function vorlageAusXml(text, optionen = {}) { return vorlageAusUnraid(datenAusXml(text), optionen); }

/**
 * Feed (applicationFeed.json) → Vorlagen. Plugins, Sprachpakete, Deprecated, Blacklist und Einträge ohne Repository fallen weg.
 * @returns {{eintraege:object[], anzahl:number, uebersprungen:object, geladen:string|null}}
 */
export function feedParsen(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const liste = Array.isArray(d && d.applist) ? d.applist : (Array.isArray(d) ? d : null);
  if (!liste) throw new FahnasFehler('E_PARAMS', 'Der Unraid-Feed hat nicht die erwartete Form (applist fehlt)', { feld: 'feed' });
  const ueb = { plugin: 0, sprache: 0, deprecated: 0, blacklist: 0, ohne_repository: 0, fehlerhaft: 0 };
  const eintraege = []; const ids = new Set();
  for (const e of liste) {
    if (!e || typeof e !== 'object') continue;
    if (e.Plugin || e.PluginURL) { ueb.plugin++; continue; }
    if (e.Language || e.LanguagePack) { ueb.sprache++; continue; }
    if (e.Deprecated) { ueb.deprecated++; continue; }
    if (e.Blacklist || e.CABlacklist) { ueb.blacklist++; continue; }
    if (typeof e.Repository !== 'string' || !e.Repository.trim()) { ueb.ohne_repository++; continue; }
    try {
      const daten = datenAusFeed(e);
      let id = `unraid-${slug(daten.Name || '')}`;
      if (ids.has(id)) id = `${id}-${slug(String(e.Repository).split('/').slice(-2).join('-'), 30)}`;
      let z = 2; const basis = id;
      while (ids.has(id)) id = `${basis}-${z++}`;
      const v = vorlageAusUnraid(daten, { id, quelle_url: e.TemplateURL });
      if (typeof e.downloads === 'number') v.beliebtheit = e.downloads;
      if (typeof e.trending === 'number') v.trend = e.trending;
      ids.add(v.id);
      eintraege.push(v);
    } catch { ueb.fehlerhaft++; }
  }
  return { eintraege, anzahl: eintraege.length, uebersprungen: ueb, geladen: typeof d.last_updated === 'string' ? d.last_updated : null };
}
