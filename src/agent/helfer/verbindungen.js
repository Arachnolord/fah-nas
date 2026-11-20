// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Verbindungs-Sammler für die Weltkarte der Übersicht: liest alle 10 s die Verbindungstabelle des Kernels
// („conntrack -L -o extended“, IPv4 und IPv6), ordnet jede Verbindung einer Richtung zu (aus = der NAS, eine App oder
// eine VM baut auf; ein = jemand spricht den NAS an), bündelt eine Stunde lang je Gegenstelle im Arbeitsspeicher und
// löst Orte über die Geo-Verwaltung auf. Nichts davon landet auf der Platte oder im Prüfprotokoll.
// Fehlt das Werkzeug conntrack (Installationen vor 0.3.0), wird es einmal je Agent-Start nachinstalliert – als eigene
// transiente Unit (systemd-run), damit ein Stopp des Agenten dpkg nicht mitten in der Arbeit beendet. Die Byte-Zähler
// je Verbindung (net.netfilter.nf_conntrack_acct) schaltet der Sammler selbst ein.
// Riesige Tabellen (SYN-Flut, Portscan): je Familie und Probe zählen höchstens 30 000 Einträge, gelesen wird in Stücken
// mit Pausen für die Ereignisschleife – der Agent bleibt ansprechbar (Prüfbericht 26.09.).
// Vertrag: docs/superpowers/specs/2026-09-26-weltkarte-design.md §3.1, §4.5, §4.6.

import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { ipNormal, istPrivat, istAnycast } from './netzadressen.js';
import { appPortsLesen } from '../render/firewall.js';
import { jsonZeilen, labelsParsen, PROJEKT_VORSILBE } from '../apps/docker.js';
import { PFADE } from '../../gemeinsam/pfade.js';

/**
 * Grenzen gegen Speicherhunger (z. B. bei einem Portscan): älteste Einträge fliegen zuerst. `zeilen` = ausgewertete
 * Einträge je Familie und Probe (der Rest der Tabelle wird verworfen, das Ergebnis sagt es mit werkzeug.gekuerzt).
 */
export const GRENZEN = Object.freeze({ tupel: 20_000, gegenstellen: 5_000, ergebnis: 500, ortCache: 10_000, zeilen: 30_000 });
export const ACCT_PROC = '/proc/sys/net/netfilter/nf_conntrack_acct';
export const SYSCTL_DATEI = '/etc/sysctl.d/60-fahnas-conntrack.conf';
/** Gleicher Text wie im Erststart (iso/payload/erststart.sh) – dann schreibt der Agent die Datei nicht erneut. */
export const SYSCTL_TEXT = '# FAH-NAS: Byte-Zähler je Verbindung für die Weltkarte (Übersicht → Weltkarte)\nnet.netfilter.nf_conntrack_acct = 1\n';
export const VM_NETZ = '192.168.122.0/24';
export const HOST_NAME = 'FAH-NAS';
/** Dienste des NAS nach Zielport (eingehend); alles andere: App mit diesem Host-Port, sonst „Port N“. */
export const DIENSTE_PORTS = new Map([[22, 'SSH'], [80, 'Web'], [443, 'Web'], [139, 'SMB'], [445, 'SMB'], [548, 'AFP'], [5353, 'mDNS']]);

const UMGEBUNG_MS = 60_000;
const ABFRAGE_MS = 5_000;
/** Ausgabepuffer für conntrack -L: ~250 Byte je Zeile, 64 MiB reichen für ~250 000 Einträge (Standard in system.js: 32 MiB). */
export const CONNTRACK_PUFFER = 64 * 1024 * 1024;
// Stückweise lesen: spätestens nach so vielen Zeilen bzw. so viel Rechenzeit bekommt die Ereignisschleife eine Runde
const STUECK_ZEILEN = 5_000;
const STUECK_MS = 20;
const freigeben = () => new Promise((weiter) => setImmediate(weiter));
const NICHT_LEER = /\S/;
// wie system.js (APT_UMGEBUNG): ohne Rückfragen, feste Sprache
const APT_UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' });
const APT_ZEITLIMIT_MS = 15 * 60 * 1000;
const APT_SPERRE = ['-o', 'DPkg::Lock::Timeout=300']; // läuft gerade ein automatisches Update, warten statt scheitern
/** Name der transienten Unit für die Nachinstallation (journalctl -u … zeigt ihre Ausgabe). */
export const INSTALLATIONS_UNIT = 'fahnas-conntrack-installation';
// Schritte als Unit, je Probe höchstens einer: installieren; bleibt das erfolglos, Paketlisten auffrischen und noch einmal
const INSTALLATIONS_SCHRITTE = Object.freeze([['install', '-y', 'conntrack'], ['update'], ['install', '-y', 'conntrack']]);
const INSTALLATIONS_VERSUCHE = 10; // Startversuche je Agent-Start (Schutz gegen eine hängende fremde Unit gleichen Namens)
const UNIT_START_MS = 30_000;
const UNIT_LAEUFT = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing']);
const UNIT_SCHON_DA = /already (?:exists|loaded|active)/i;
// wie apps/docker.js: HOME für die Docker-Konfiguration, keine Werbehinweise der CLI
const DOCKER_UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME || '/root', DOCKER_CLI_HINTS: 'false' });
const HOST = Object.freeze({ name: HOST_NAME, art: 'host' });
const VM = Object.freeze({ name: 'VM', art: 'vm' });

const HINWEIS_INSTALLATION = 'Das Werkzeug „conntrack“ fehlt – es wird gerade nachinstalliert. Die Verbindungen erscheinen danach von selbst.';
const HINWEIS_FEHLGESCHLAGEN = 'Das Werkzeug „conntrack“ fehlt und ließ sich nicht nachinstallieren (Internet?). Neuer Versuch beim nächsten Start des Steuerdienstes – oder auf der Konsole: sudo apt install conntrack (ggf. vorher sudo dpkg --configure -a)';
const HINWEIS_LESEN = 'Die Verbindungstabelle ließ sich nicht lesen (conntrack -L). Einzelheiten stehen im Protokoll des Steuerdienstes.';
const HINWEIS_GEKUERZT = 'Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet';
const FAMILIEN = Object.freeze([
  { familie: 'ipv4', name: 'IPv4', argumente: ['-L', '-o', 'extended'] },
  { familie: 'ipv6', name: 'IPv6', argumente: ['-L', '-f', 'ipv6', '-o', 'extended'] },
]);

/**
 * Kurzer Fehlertext für das Protokoll. E_SYSTEM trägt in details.ausgabe stderr – ohne stderr (z. B. Zeitlimit) aber
 * die Standardausgabe, bei conntrack also Verbindungsdaten: solche Zeilen gehören nie ins Journal (Prüfbericht 26.09.).
 */
function fehlerText(e) {
  const ausgabe = String((e && e.details && e.details.ausgabe) || '').split('\n')
    .filter((z) => z.trim() && !/\b(?:src|dst)=/.test(z)).join(' ').trim();
  return (ausgabe || String((e && e.message) || e)).slice(0, 300);
}

/**
 * Frische Kopie einer Adresse: V8 legt Teilstrings ab 13 Zeichen als Verweis auf den ganzen Text an – eine gemerkte
 * IPv6-/lange IPv4-Adresse hielte sonst das ganze conntrack-Stück im Speicher (Prüfbericht 26.09.: 4 → 123 MB in 50 min,
 * auch nach verwerfen()). Adressen sind ASCII.
 */
const frisch = (s) => (s.length < 13 ? s : Buffer.from(s, 'latin1').toString('latin1'));

const DATEIEN = Object.freeze({
  lesen: (p) => fs.readFile(p, 'utf8'),
  schreiben: (p, text) => fs.writeFile(p, text, { mode: 0o644 }),
});

// ---------------------------------------------------------------------------------------------------------------
// conntrack-Ausgabe lesen
// ---------------------------------------------------------------------------------------------------------------

// „ipv4     2 tcp      6 431999 ESTABLISHED src=… dst=… sport=… dport=… packets=… bytes=… src=… … [ASSURED] mark=0 use=1“
// Familie, L3-Nummer, Protokoll, L4-Nummer, Restzeit, [Zustand (nur TCP/SCTP/DCCP)], danach Schlüssel=Wert-Paare.
// Nur die benötigten Paare werden mit EINEM Suchlauf je Zeile gelesen (kein Zerlegen aller Wörter – 25 000 Zeilen
// sollen deutlich unter einer Sekunde bleiben, auch direkt nach dem Start ohne warmen JIT).
const KOPF = /^\s*(ipv4|ipv6)\s+\d+\s+(\S+)\s+\d+\s+\d+\s+(?:([A-Z][A-Z0-9_]*)\s+)?/;
const PAAR = /\s(?:(src|dst|sport|dport|packets|bytes)=(\S+)|(\[UNREPLIED\]))/g;

/** Eine Zeile der conntrack-Ausgabe → Eintrag oder null (unbekannt/unvollständig). */
function zeileLesen(zeile) {
  const m = KOPF.exec(zeile);
  if (!m) return null;
  let orig = null; let antwort = null; let s = null;
  let unbeantwortet = false;
  PAAR.lastIndex = m[0].length - 1; // der Kopf endet mit Leerraum – das erste Paar beginnt direkt danach
  for (let p = PAAR.exec(zeile); p; p = PAAR.exec(zeile)) {
    if (p[3]) { unbeantwortet = true; continue; }
    const k = p[1];
    if (k === 'src') {
      if (antwort) break;
      s = { src: frisch(p[2]), dst: null, sport: null, dport: null, packets: 0, bytes: 0 };
      if (orig) antwort = s; else orig = s;
    } else if (s) {
      if (k === 'dst') s.dst = frisch(p[2]);
      else { const n = Number(p[2]); if (Number.isFinite(n)) s[k] = n; }
    }
  }
  if (!orig || !antwort || !orig.dst || !antwort.dst) return null;
  return { familie: m[1], proto: m[2], zustand: m[3] ?? null, orig, antwort, unbeantwortet };
}

/**
 * Liest die Ausgabe von „conntrack -L -o extended“. Das erste „src=“ beginnt die Hinrichtung (orig), das zweite die
 * Rückrichtung (antwort); „[UNREPLIED]“ markiert Verbindungen ohne Antwort. ICMP hat keine Ports (null), ohne
 * eingeschaltete Zähler fehlen packets/bytes (0). Unbekannte oder unvollständige Zeilen werden übersprungen.
 * (Der Sammler liest stückweise über zeileLesen; diese Form ist für Tests und Messungen.)
 * @returns {Array<{familie, proto, zustand, orig, antwort, unbeantwortet}>}
 */
export function parseConntrack(text) {
  const aus = [];
  for (const zeile of String(text ?? '').split('\n')) {
    const e = zeileLesen(zeile);
    if (e) aus.push(e);
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Richtung bestimmen
// ---------------------------------------------------------------------------------------------------------------

// Die Umgebung wird je Objekt einmal in Normalform gebracht (Schreibweisen von IPv6, Zonen-ID); der Sammler erzeugt
// alle 60 s ein neues Objekt, Tests übergeben feste.
const VORBEREITET = new WeakMap();
const VM_NETZE = new Map();

function netzListe(cidr) {
  if (!cidr) return null;
  if (VM_NETZE.has(cidr)) return VM_NETZE.get(cidr);
  let liste = null;
  const [adresse, praefix] = String(cidr).split('/');
  const art = net.isIP(adresse);
  if (art && /^\d{1,3}$/.test(praefix ?? '')) {
    liste = new net.BlockList();
    try { liste.addSubnet(adresse, Number(praefix), art === 4 ? 'ipv4' : 'ipv6'); } catch { liste = null; }
  }
  VM_NETZE.set(cidr, liste);
  return liste;
}

// Normalform je Schreibweise merken: die eigene Adresse steht in fast jeder Zeile, Gegenstellen wiederholen sich
const NORMAL = new Map();
const NORMAL_MAX = 50_000;
function normal(ip) {
  let n = NORMAL.get(ip);
  if (n === undefined) {
    n = ipNormal(ip);
    if (NORMAL.size >= NORMAL_MAX) NORMAL.clear();
    NORMAL.set(ip, n);
  }
  return n;
}

function vorbereiten(u) {
  let v = VORBEREITET.get(u);
  if (v) return v;
  const eigene = new Set();
  for (const ip of u?.eigene ?? []) { const n = ipNormal(ip); if (n) eigene.add(n); }
  const container = new Map();
  for (const [ip, c] of u?.container ?? []) { const n = ipNormal(ip); if (n && c && c.name) container.set(n, { name: String(c.name), art: 'app' }); }
  v = { eigene, container, vm: netzListe(u?.vmNetz ?? VM_NETZ), appPorts: u?.appPorts instanceof Map ? u.appPorts : new Map(), zuordnung: new Map() };
  VORBEREITET.set(u, v);
  return v;
}

/** Gehört die Adresse zum NAS (Host inkl. Loopback, Container, VM-Netz)? → lokale Seite oder null (je Umgebung gemerkt). */
function eigenesGeraet(ip, v) {
  let z = v.zuordnung.get(ip);
  if (z !== undefined) return z;
  if (v.eigene.has(ip) || ip.startsWith('127.') || ip === '::1') z = HOST;
  else z = v.container.get(ip) || (v.vm && v.vm.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4') ? VM : null);
  if (v.zuordnung.size >= NORMAL_MAX) v.zuordnung.clear();
  v.zuordnung.set(ip, z);
  return z;
}

/** Eingehend an eine Host-Adresse: Dienst nach Zielport, App mit diesem Host-Port, per DNAT erreichter Container, „Port N“. */
function dienstFuer(e, v) {
  const port = e.orig.dport;
  if (port !== null && DIENSTE_PORTS.has(port)) return { name: DIENSTE_PORTS.get(port), art: 'dienst' };
  if (port !== null && v.appPorts.has(port)) return { name: String(v.appPorts.get(port)), art: 'app' };
  const weiter = normal(e.antwort.src); // DNAT: die Antwort kommt von der Adresse, an die weitergereicht wurde
  const ziel = weiter ? eigenesGeraet(weiter, v) : null;
  if (ziel && ziel !== HOST) return { name: ziel.name, art: ziel.art };
  return { name: port !== null ? `Port ${port}` : String(e.proto || '').toUpperCase() || 'Unbekannt', art: 'dienst' };
}

/**
 * Richtung einer Verbindung. Unbeantwortete, rein interne (beide Seiten eigen) und durchgeleitete (keine Seite eigen)
 * Verbindungen ergeben null.
 * @param {object} e  Eintrag aus parseConntrack
 * @param {{eigene:Set<string>, container:Map<string,{name}>, vmNetz:string, appPorts:Map<number,string>}} umgebung
 * @returns {{richtung:'ein'|'aus', fern:{ip,port}, lokal:{name,art}, dienst?:number|null}|null}
 */
export function klassifiziere(e, umgebung) {
  if (!e || e.unbeantwortet || !e.orig || !e.antwort) return null;
  const v = vorbereiten(umgebung);
  const quelle = normal(e.orig.src);
  const ziel = normal(e.orig.dst);
  if (!quelle || !ziel) return null;
  const von = eigenesGeraet(quelle, v);
  const an = eigenesGeraet(ziel, v);
  if (von && an) return null;
  if (von) return { richtung: 'aus', fern: { ip: ziel, port: e.orig.dport }, lokal: { name: von.name, art: von.art } };
  if (an) {
    const lokal = an === HOST ? dienstFuer(e, v) : { name: an.name, art: an.art };
    return { richtung: 'ein', fern: { ip: quelle, port: e.orig.sport }, lokal, dienst: e.orig.dport };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Umgebung: eigene Adressen, Container, App-Ports
// ---------------------------------------------------------------------------------------------------------------

function appName(projekt, name) {
  if (typeof projekt === 'string' && projekt) return projekt.startsWith(PROJEKT_VORSILBE) ? projekt.slice(PROJEKT_VORSILBE.length) : projekt;
  return typeof name === 'string' && name ? name.replace(/^\//, '') : null;
}

/**
 * Liest die Umgebung für `klassifiziere`: eigene Adressen aus den Netzwerkschnittstellen, Container-Adressen aus allen
 * Docker-Netzen (App-Name = Label com.docker.compose.project ohne „fahnas-“, sonst Containername) und die Host-Ports
 * der Apps aus dem Konfigurationsspiegel – über dieselbe Funktion wie die Firewall (render/firewall.js). Fehler bei
 * Docker oder dem Spiegel ergeben leere Listen (die Karte zeigt dann nur Adressen statt Namen).
 */
export async function umgebungLesen({ system, konfigOrdner = PFADE.konfig, schnittstellen = os.networkInterfaces, vmNetz = VM_NETZ } = {}) {
  const eigene = new Set();
  try {
    for (const liste of Object.values(schnittstellen() || {})) for (const a of liste || []) { const ip = ipNormal(a && a.address); if (ip) eigene.add(ip); }
  } catch { /* ohne Schnittstellen bleibt nur Loopback (eigenesGeraet) */ }
  const container = new Map();
  try {
    const ls = await system.ausfuehren('docker', ['network', 'ls', '-q'], { zeitlimit_ms: 10_000, umgebung: DOCKER_UMGEBUNG });
    const ids = String(ls.stdout || '').split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{6,64}$/i.test(s));
    if (ids.length) {
      const netze = JSON.parse((await system.ausfuehren('docker', ['network', 'inspect', ...ids], { zeitlimit_ms: 10_000, umgebung: DOCKER_UMGEBUNG })).stdout || '[]');
      // Labels stehen am Container, nicht im Netz → docker ps; fehlt es, gilt das Label des Netzes (Compose setzt beide gleich)
      const namen = new Map();
      try {
        const ps = await system.ausfuehren('docker', ['ps', '--no-trunc', '--format', '{{json .}}'], { zeitlimit_ms: 10_000, umgebung: DOCKER_UMGEBUNG });
        for (const c of jsonZeilen(ps.stdout)) {
          const n = appName(labelsParsen(c.Labels)['com.docker.compose.project'], String(c.Names || '').split(',')[0]);
          if (c.ID && n) namen.set(String(c.ID), n);
        }
      } catch { /* weiter mit den Angaben der Netze */ }
      for (const n of Array.isArray(netze) ? netze : []) {
        const projekt = n && n.Labels ? n.Labels['com.docker.compose.project'] : null;
        for (const [id, c] of Object.entries((n && n.Containers) || {})) {
          const name = namen.get(id) || appName(projekt, c && c.Name);
          if (!name) continue;
          for (const a of [c.IPv4Address, c.IPv6Address]) { const ip = ipNormal(String(a || '').split('/')[0]); if (ip) container.set(ip, { name }); }
        }
      }
    }
  } catch { /* Docker fehlt oder antwortet nicht – still weiter ohne Namen */ }
  const appPorts = new Map();
  try {
    for (const p of await appPortsLesen(konfigOrdner)) {
      const name = String(p.kommentar || '').replace(/^App /, '');
      if (name && !appPorts.has(p.port)) appPorts.set(p.port, name);
    }
  } catch { /* ohne Spiegel keine App-Namen */ }
  return { eigene, container, vmNetz, appPorts };
}

// ---------------------------------------------------------------------------------------------------------------
// Hilfen für das Ergebnis
// ---------------------------------------------------------------------------------------------------------------

/** Standort aus system.json → {lat, lon, name} oder null (beide Koordinaten nötig, im gültigen Bereich). */
export function heimatAus(standort) {
  if (!standort || typeof standort !== 'object') return null;
  const { lat, lon } = standort;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, name: typeof standort.name === 'string' ? standort.name.slice(0, 64) : '' };
}

/** Ort aus der Geo-Verwaltung auf die Vertragsform bringen; ohne gültige Koordinaten → null. */
function ortAus(r) {
  if (!r || typeof r !== 'object' || typeof r.lat !== 'number' || typeof r.lon !== 'number' || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return null;
  return {
    land: typeof r.land === 'string' ? r.land : null, land_name: typeof r.land_name === 'string' ? r.land_name : null,
    stadt: typeof r.stadt === 'string' && r.stadt ? r.stadt : null, lat: r.lat, lon: r.lon, genau: r.genau === 'stadt' ? 'stadt' : 'land',
  };
}

/** Status der Geo-Verwaltung (wirft nie). */
export function geoStatus(geo) {
  try {
    const s = geo && typeof geo.status === 'function' ? geo.status() : null;
    if (s && typeof s === 'object') {
      return { quelle: ['stadt', 'land', 'keine'].includes(s.quelle) ? s.quelle : 'keine', stand: typeof s.stand === 'string' ? s.stand : null, hinweis: typeof s.hinweis === 'string' ? s.hinweis : null };
    }
  } catch { /* unten */ }
  return { quelle: 'keine', stand: null, hinweis: null };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Liefert immer den ältesten Schlüssel einer Map (vorn in der Einfügereihenfolge) – für das Verdrängen an den Grenzen.
 * Ein frisches map.keys().next() liefe jedes Mal über alle schon gelöschten Plätze am Anfang der Hash-Tabelle (V8 räumt
 * sie erst beim nächsten Umbau weg): bei 20 000 Tupeln und ständigem Verdrängen quadratisch, Sekunden je Probe
 * (Messung 26.09.). Ein Iterator, der stehen bleibt, setzt dort fort, wo er war – alles davor ist schon verdrängt oder
 * ans Ende gewandert (neu eingefügt), und Einträge hinter ihm sieht er laut Sprachstandard ebenfalls.
 */
function aeltesterSchluessel(map) {
  let it = null;
  return () => {
    let r = it ? it.next() : { done: true };
    if (r.done) { it = map.keys(); r = it.next(); } // erschöpfte Iteratoren bleiben erschöpft → neu ansetzen
    return r.done ? undefined : r.value;
  };
}

const nachAnzahl = (a, b) => b.anzahl - a.anzahl || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------
// Sammler
// ---------------------------------------------------------------------------------------------------------------

/**
 * Sammelt Verbindungen im Arbeitsspeicher. Je Verbindung (Tupel proto|src|sport|dst|dport) merkt er erste/letzte
 * Sichtung, lokale Seite und den höchsten Byte-Stand beider Richtungen; je Gegenstelle (Richtung + Adresse) die Menge
 * ihrer Verbindungen und den Ort. Beide Tabellen sind nach letzter Sichtung geordnet (Map-Reihenfolge: berührte
 * Einträge wandern ans Ende) – Ablauf nach `fenster_ms` und die Grenzen entfernen deshalb immer von vorn.
 */
export class VerbindungsSammler {
  /**
   * @param {object} o
   * @param {{ausfuehren:Function}} o.system          werkzeuge.system (Argumentlisten, keine Shell)
   * @param {{suche:Function, status:Function}} [o.geo] Geo-Verwaltung (suche darf ein Promise liefern)
   * @param {{ordner:string}} [o.konfig]              für die App-Ports der Standard-Umgebung
   * @param {Function} [o.umgebungHolen]              () → Umgebung für klassifiziere (Standard: umgebungLesen)
   * @param {Function} [o.standortHolen]              () → {lat, lon, name}|null
   * @param {Function} [o.aufzeichnenHolen]           () → boolean|Promise<boolean> (Einstellung verbindungen.aufzeichnen)
   * @param {{lesen:Function, schreiben:Function}} [o.dateien] /proc und /etc/sysctl.d (Tests ersetzen sie)
   */
  constructor({ system, geo = null, konfig = null, jetzt = Date.now, intervall_ms = 10_000, fenster_ms = 3_600_000, umgebungHolen = null,
    standortHolen = () => null, aufzeichnenHolen = () => true, dateien = DATEIEN, protokoll = (t) => process.stderr.write(`[verbindungen] ${t}\n`) } = {}) {
    this.system = system;
    this.geo = geo;
    this.jetzt = jetzt;
    this.intervall_ms = intervall_ms ?? 10_000;
    this.fenster_ms = fenster_ms ?? 3_600_000;
    this.umgebungHolen = umgebungHolen || (() => umgebungLesen({ system, konfigOrdner: (konfig && konfig.ordner) || PFADE.konfig }));
    this.standortHolen = standortHolen;
    this.aufzeichnenHolen = aufzeichnenHolen;
    this.dateien = dateien || DATEIEN;
    this.protokoll = protokoll;
    this.aufzeichnung = true;
    this.installation = null;        // Promise<boolean> der Nachinstallation im Agenten – nur beim Rückfall ohne systemd
    this._inst = null;               // Stand der Nachinstallation (einmal je Sammler = je Agent-Start), siehe _nachinstallieren
    this._tupel = new Map();         // Schlüssel → {g, lokal, erst, zuletzt, bytes}
    this._gegen = new Map();         // Richtung|IP → {richtung, ip, privat, anycast, erst, zuletzt, tupel:Set, ort, ortStand}
    this._orte = new Map();          // IP → Ort|null (Zwischenspeicher der Ortssuche)
    this._aeltesteLeeren();
    this._ortStand = null;
    this._umgebung = null;
    this._umgebungZeit = -Infinity;
    this._werkzeug = { ok: true, hinweis: null };
    this._werkzeugDa = false;
    this._acctErledigt = false;
    this._leseFehler = false;
    this._familienFehler = { ipv4: false, ipv6: false }; // schon protokolliert (einmal je Ausfall)
    this._generation = 0;            // verwerfen()/stoppen() zählen hoch → eine laufende Probe bricht beim nächsten Stück ab
    this._timer = null;
    this._laufend = null;
  }

  werkzeugStatus() { return { ...this._werkzeug }; }

  statistik() { return { tupel: this._tupel.size, gegenstellen: this._gegen.size }; }

  /** Startet den Takt und die erste Probe. Die Einstellung „aufzeichnen“ wird in jeder Probe neu gelesen. */
  async starten() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.probe(); }, this.intervall_ms);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    await this.probe();
  }

  async stoppen() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._generation++; // eine laufende Probe hört beim nächsten Stück auf
    if (this._laufend) { try { await this._laufend; } catch { /* egal */ } }
    this.verwerfen();
  }

  /** Alle gesammelten Verbindungen vergessen (Aufzeichnung aus, Stopp); eine laufende Probe bricht ab. */
  verwerfen() {
    this._generation++;
    this._tupel.clear();
    this._gegen.clear();
    this._orte.clear();
    this._aeltesteLeeren();
  }

  /** Zeiger auf die jeweils ältesten Einträge neu ansetzen (nach dem Leeren der Tabellen). */
  _aeltesteLeeren() {
    this._aeltestesTupel = aeltesterSchluessel(this._tupel);
    this._aeltesteGegenstelle = aeltesterSchluessel(this._gegen);
    this._aeltesterOrt = aeltesterSchluessel(this._orte);
  }

  /**
   * Eine Abfrage: Einstellung prüfen, Werkzeug und Zähler sicherstellen, Tabelle lesen, bündeln, Orte auflösen.
   * Läuft noch eine Probe, wird diese übersprungen (false). Wirft nie.
   * @returns {Promise<boolean>} true, wenn gelesen wurde
   */
  async probe() {
    if (this._laufend) return false;
    this._laufend = this._probe();
    try { return await this._laufend; } catch (e) {
      this.protokoll(`Abfrage fehlgeschlagen: ${e && e.message}`);
      return false;
    } finally { this._laufend = null; }
  }

  async _probe() {
    const generation = this._generation;
    let an = true;
    try { an = (await this.aufzeichnenHolen()) !== false; } catch { an = this.aufzeichnung; }
    if (!an) { this.verwerfen(); this.aufzeichnung = false; return false; }
    this.aufzeichnung = true;
    if (!(await this._werkzeugPruefen())) return false;
    await this._acctPruefen();
    const umgebung = await this._umgebungAktuell();
    const tabellen = await Promise.all(FAMILIEN.map((f) => this._tabelle(f)));
    if (generation !== this._generation) return false; // verwerfen()/stoppen(), während conntrack -L lief
    if (tabellen.every((t) => t.fehler !== null)) {
      if (!this._leseFehler) this.protokoll(`conntrack -L schlug für IPv4 und IPv6 fehl: ${tabellen[0].fehler}`);
      this._leseFehler = true;
      for (const t of tabellen) this._familienFehler[t.familie] = true;
      this._werkzeug = { ok: false, hinweis: HINWEIS_LESEN };
      return false;
    }
    this._leseFehler = false;
    const jetzt = this.jetzt();
    const hinweise = [];
    let gekuerzt = false;
    for (const t of tabellen) {
      if (t.fehler !== null) {
        // nur diese Familie fehlt (z. B. Ausgabe größer als der Puffer): die andere trotzdem auswerten
        if (!this._familienFehler[t.familie]) this.protokoll(`${t.name}-Verbindungen nicht lesbar (conntrack -L): ${t.fehler}`);
        this._familienFehler[t.familie] = true;
        hinweise.push(`${t.name}-Verbindungen gerade nicht lesbar.`);
        continue;
      }
      this._familienFehler[t.familie] = false;
      const r = await this._tabelleAufnehmen(t.text, umgebung, jetzt, generation);
      if (r === 'abgebrochen') return false;
      if (r === 'gekuerzt') gekuerzt = true;
    }
    this._ablaufen(jetzt);
    if (gekuerzt) hinweise.push(HINWEIS_GEKUERZT);
    this._werkzeug = { ok: true, hinweis: hinweise.length ? hinweise.join(' ') : null };
    if (gekuerzt) this._werkzeug.gekuerzt = true;
    return this._orteAufloesen(generation);
  }

  /** conntrack -L einer Familie → {familie, name, text, fehler:null} bzw. {…, text:'', fehler:'Ursache'}. */
  async _tabelle({ familie, name, argumente }) {
    try {
      const r = await this.system.ausfuehren('conntrack', argumente, { zeitlimit_ms: ABFRAGE_MS, maxBuffer: CONNTRACK_PUFFER });
      return { familie, name, text: String(r.stdout ?? ''), fehler: null };
    } catch (e) { return { familie, name, text: '', fehler: fehlerText(e) }; }
  }

  /**
   * Eine conntrack-Ausgabe zeilenweise lesen und bündeln: höchstens GRENZEN.zeilen Einträge (Leerzeilen zählen nicht),
   * in Stücken – nach STUECK_ZEILEN Zeilen bzw. STUECK_MS ms bekommt die Ereignisschleife eine Runde (setImmediate),
   * damit der Agent auch bei riesigen Tabellen antwortet. Nach verwerfen()/stoppen() wird abgebrochen.
   * @returns {Promise<'fertig'|'gekuerzt'|'abgebrochen'>}
   */
  async _tabelleAufnehmen(text, umgebung, jetzt, generation) {
    const laenge = text.length;
    let pos = 0; let zeilen = 0; let imStueck = 0; let seit = performance.now();
    while (pos < laenge) {
      let ende = text.indexOf('\n', pos);
      if (ende < 0) ende = laenge;
      const zeile = text.slice(pos, ende);
      pos = ende + 1;
      if (!NICHT_LEER.test(zeile)) continue;
      if (zeilen >= GRENZEN.zeilen) return 'gekuerzt';
      zeilen++;
      const e = zeileLesen(zeile);
      if (e) this._eintrag(e, umgebung, jetzt);
      imStueck++;
      if (imStueck >= STUECK_ZEILEN || ((imStueck & 63) === 0 && performance.now() - seit > STUECK_MS)) {
        await freigeben();
        if (generation !== this._generation) return 'abgebrochen';
        imStueck = 0; seit = performance.now();
      }
    }
    return 'fertig';
  }

  async _conntrackDa() {
    try { await this.system.ausfuehren('conntrack', ['--version'], { zeitlimit_ms: ABFRAGE_MS }); return true; } catch { return false; }
  }

  /** Werkzeug vorhanden? Sonst die Nachinstallation anstoßen bzw. einen Schritt weiterführen (wartet nie auf apt). */
  async _werkzeugPruefen() {
    if (this._werkzeugDa) return true;
    if (!(await this._conntrackDa()) && !(await this._nachinstallieren())) return false;
    if (this._inst && !this._inst.direkt) this.protokoll('conntrack installiert');
    this._werkzeugDa = true;
    if (!this._leseFehler) this._werkzeug = { ok: true, hinweis: null };
    return true;
  }

  /**
   * Nachinstallation von conntrack, einmal je Agent-Start. Bevorzugt als eigene transiente Unit (systemd-run ohne
   * --wait): apt und dpkg laufen außerhalb des Agenten und überstehen dessen Stopp oder Neustart – vorher beendete
   * KillMode=mixed beim Stopp auch dpkg („dpkg was interrupted“, Prüfbericht 26.09.). Jede Probe geht höchstens einen
   * Schritt weiter: Unit läuft → abwarten; Unit beendet, conntrack fehlt → nächster Schritt (install → update → install),
   * danach Hinweis. Läuft die Unit schon (voriger Agent-Start), wird sie nicht erneut gestartet, sondern abgewartet.
   * Ohne systemd (systemd-run fehlt oder scheitert anders) wie bisher direkt im Agenten (_installieren).
   * @returns {Promise<boolean>} true, wenn conntrack inzwischen da ist (Unit eben fertig geworden)
   */
  async _nachinstallieren() {
    if (!this._inst) this._inst = { schritt: 0, laeuft: false, eigene: false, versuche: 0, ende: false, direkt: false };
    const z = this._inst;
    if (z.ende || z.direkt) return false;
    if (z.laeuft) {
      if (await this._unitLaeuft()) return false;          // apt arbeitet noch
      z.laeuft = false;
      if (await this._conntrackDa()) return true;          // zwischen den beiden Blicken fertig geworden
      if (z.eigene) z.schritt++;                           // unser Schritt blieb erfolglos → nächster
    }
    if (z.schritt >= INSTALLATIONS_SCHRITTE.length || z.versuche >= INSTALLATIONS_VERSUCHE) {
      z.ende = true;
      this.protokoll(`conntrack ließ sich nicht installieren – Einzelheiten: journalctl -u ${INSTALLATIONS_UNIT}`);
      this._werkzeug = { ok: false, hinweis: HINWEIS_FEHLGESCHLAGEN };
      return false;
    }
    const schritt = INSTALLATIONS_SCHRITTE[z.schritt];
    z.versuche++;
    this._werkzeug = { ok: false, hinweis: HINWEIS_INSTALLATION };
    try {
      await this.system.ausfuehren('systemd-run', [`--unit=${INSTALLATIONS_UNIT}`, '--collect', '--quiet', '--setenv=DEBIAN_FRONTEND=noninteractive',
        'apt-get', ...APT_SPERRE, ...schritt], { umgebung: APT_UMGEBUNG, zeitlimit_ms: UNIT_START_MS });
      z.laeuft = true; z.eigene = true;
      this.protokoll(`conntrack fehlt – Unit ${INSTALLATIONS_UNIT} gestartet: apt-get ${schritt.join(' ')}`);
    } catch (e) {
      const text = fehlerText(e);
      if (!UNIT_SCHON_DA.test(text)) {
        // kein systemd (Container, Entwicklung): wie bisher im Hintergrund des Agenten
        z.direkt = true;
        this.installation = this._installieren();
        return false;
      }
      z.laeuft = true; z.eigene = false; // läuft noch (z. B. vom vorigen Agent-Start) → abwarten, dann denselben Schritt prüfen
      if (z.versuche === 1) this.protokoll(`conntrack-Nachinstallation läuft bereits (Unit ${INSTALLATIONS_UNIT}) – warte darauf`);
    }
    return false;
  }

  /** Läuft die Unit der Nachinstallation noch? (Mit --collect verschwindet sie nach dem Ende → „inactive“.) */
  async _unitLaeuft() {
    try {
      const r = await this.system.ausfuehren('systemctl', ['show', '--property=ActiveState', '--value', `${INSTALLATIONS_UNIT}.service`], { zeitlimit_ms: ABFRAGE_MS });
      return UNIT_LAEUFT.has(String(r.stdout ?? '').trim());
    } catch { return false; }
  }

  /** Rückfall ohne systemd: apt-get direkt als Kind des Agenten (übersteht dessen Stopp nicht). */
  async _installieren() {
    this.protokoll('conntrack fehlt – wird nachinstalliert (apt-get install conntrack)');
    const apt = (args) => this.system.ausfuehren('apt-get', [...APT_SPERRE, ...args], { umgebung: APT_UMGEBUNG, zeitlimit_ms: APT_ZEITLIMIT_MS });
    try {
      try { await apt(['install', '-y', 'conntrack']); } catch {
        // häufigste Ursache: veraltete Paketlisten → einmal auffrischen und erneut
        await apt(['update']);
        await apt(['install', '-y', 'conntrack']);
      }
    } catch (e) {
      this.protokoll(`conntrack ließ sich nicht installieren: ${fehlerText(e)}`);
      this._werkzeug = { ok: false, hinweis: HINWEIS_FEHLGESCHLAGEN };
      return false;
    }
    if (!(await this._conntrackDa())) {
      this._werkzeug = { ok: false, hinweis: HINWEIS_FEHLGESCHLAGEN };
      return false;
    }
    this.protokoll('conntrack installiert');
    this._werkzeugDa = true;
    this._werkzeug = { ok: true, hinweis: null };
    return true;
  }

  /**
   * Byte-Zähler einschalten (gilt für neue Verbindungen) und dauerhaft in /etc/sysctl.d eintragen. Fehlt die /proc-Datei
   * (Modul nf_conntrack noch nicht geladen – conntrack -L lädt es), versucht es die nächste Probe erneut.
   */
  async _acctPruefen() {
    if (this._acctErledigt) return;
    let wert;
    try { wert = String(await this.dateien.lesen(ACCT_PROC)).trim(); } catch { return; }
    this._acctErledigt = true; // Schreibfehler nicht alle 10 s wiederholen
    try {
      if (wert !== '1') {
        await this.dateien.schreiben(ACCT_PROC, '1\n');
        this.protokoll('Byte-Zähler je Verbindung eingeschaltet (nf_conntrack_acct = 1) – gilt für neue Verbindungen');
      }
      let alt = null;
      try { alt = String(await this.dateien.lesen(SYSCTL_DATEI)); } catch { alt = null; }
      if (alt !== SYSCTL_TEXT) await this.dateien.schreiben(SYSCTL_DATEI, SYSCTL_TEXT);
    } catch (e) {
      this.protokoll(`Byte-Zähler (nf_conntrack_acct) nicht einschaltbar: ${e && e.message}`);
    }
  }

  async _umgebungAktuell() {
    const jetzt = this.jetzt();
    if (this._umgebung && jetzt - this._umgebungZeit < UMGEBUNG_MS) return this._umgebung;
    try { this._umgebung = await this.umgebungHolen(); } catch (e) {
      this.protokoll(`Umgebung nicht lesbar: ${e && e.message}`);
      if (!this._umgebung) this._umgebung = { eigene: new Set(), container: new Map(), vmNetz: VM_NETZ, appPorts: new Map() };
    }
    this._umgebungZeit = jetzt;
    return this._umgebung;
  }

  /** Einträge einer Probe bündeln (synchron). Öffentlich für Tests und Messungen. */
  aufnehmen(eintraege, umgebung, jetzt = this.jetzt()) {
    for (const e of eintraege) this._eintrag(e, umgebung, jetzt);
    this._ablaufen(jetzt);
  }

  /** Einen Eintrag bündeln; die Grenzen gelten sofort, nicht erst nach der Probe (Speicher bei riesigen Tabellen). */
  _eintrag(e, umgebung, jetzt) {
    const k = klassifiziere(e, umgebung);
    if (!k) return;
    const schluessel = `${e.proto}|${e.orig.src}|${e.orig.sport ?? ''}|${e.orig.dst}|${e.orig.dport ?? ''}`;
    const bytes = (e.orig.bytes || 0) + (e.antwort.bytes || 0);
    const gs = `${k.richtung}|${k.fern.ip}`;
    let t = this._tupel.get(schluessel);
    if (t && t.g !== gs) { this._tupelEntfernen(schluessel); t = undefined; } // Umgebung geändert (Container neu)
    let g = this._gegen.get(gs);
    if (g) this._gegen.delete(gs);
    else g = { richtung: k.richtung, ip: k.fern.ip, privat: istPrivat(k.fern.ip), anycast: istAnycast(k.fern.ip), erst: jetzt, zuletzt: jetzt, tupel: new Set(), ort: null, ortStand: undefined };
    g.zuletzt = jetzt;
    this._gegen.set(gs, g);
    if (t) {
      this._tupel.delete(schluessel);
      t.zuletzt = jetzt;
      t.lokal = k.lokal;
      if (bytes > t.bytes) t.bytes = bytes;
    } else {
      t = { g: gs, lokal: k.lokal, erst: jetzt, zuletzt: jetzt, bytes };
      g.tupel.add(schluessel);
    }
    this._tupel.set(schluessel, t);
    if (this._tupel.size > GRENZEN.tupel) this._tupelEntfernen(this._aeltestesTupel());
    if (this._gegen.size > GRENZEN.gegenstellen) this._gegenEntfernen(this._aeltesteGegenstelle());
  }

  _tupelEntfernen(schluessel) {
    const t = this._tupel.get(schluessel);
    if (!t) return;
    this._tupel.delete(schluessel);
    const g = this._gegen.get(t.g);
    if (!g) return;
    g.tupel.delete(schluessel);
    if (!g.tupel.size) this._gegen.delete(t.g);
  }

  _gegenEntfernen(gs) {
    const g = this._gegen.get(gs);
    if (!g) return;
    for (const k of g.tupel) this._tupel.delete(k);
    this._gegen.delete(gs);
  }

  /** Verbindungen, die seit `fenster_ms` nicht mehr gesehen wurden, fallen heraus (mit ihnen leere Gegenstellen). */
  _ablaufen(jetzt) {
    const grenze = jetzt - this.fenster_ms;
    for (const [k, t] of this._tupel) {
      if (t.zuletzt > grenze) break;
      this._tupelEntfernen(k);
    }
  }

  /**
   * Orte für neue Gegenstellen suchen; wechselt der Stand der Ortsdaten (Monats-Datenbank), alle neu. Die Suche ist
   * synchron (MMDB) – bis zu 5 000 neue Gegenstellen je Probe laufen deshalb ebenfalls in Stücken.
   * @returns {Promise<boolean>} false, wenn die Probe inzwischen verworfen wurde
   */
  async _orteAufloesen(generation = this._generation) {
    const status = geoStatus(this.geo);
    const stand = `${status.quelle}|${status.stand}`;
    if (stand !== this._ortStand) { this._orte.clear(); this._aeltesterOrt = aeltesterSchluessel(this._orte); this._ortStand = stand; }
    const suche = this.geo && typeof this.geo.suche === 'function' ? this.geo : null;
    let n = 0; let seit = performance.now();
    for (const g of this._gegen.values()) {
      if (g.ortStand === stand) continue;
      g.ort = g.privat || g.anycast || !suche ? null : await this._ort(g.ip);
      g.ortStand = stand;
      if ((++n & 63) === 0 && performance.now() - seit > STUECK_MS) {
        await freigeben();
        if (generation !== this._generation) return false;
        seit = performance.now();
      }
    }
    return generation === this._generation;
  }

  async _ort(ip) {
    if (this._orte.has(ip)) {
      const o = this._orte.get(ip);
      this._orte.delete(ip); this._orte.set(ip, o);
      return o;
    }
    let o = null;
    try { o = ortAus(await this.geo.suche(ip)); } catch { o = null; }
    this._orte.set(ip, o);
    if (this._orte.size > GRENZEN.ortCache) this._orte.delete(this._aeltesterOrt());
    return o;
  }

  /**
   * Ergebnis einer Richtung (Vertrag §4.6): höchstens 500 Gegenstellen nach letzter Sichtung absteigend, dazu die
   * Summen und die lokale Seite (aus: Absender; ein: Dienste). Ohne Aufzeichnung alles leer.
   */
  ergebnis(richtung) {
    const jetzt = this.jetzt();
    let heimat = null;
    try { heimat = heimatAus(this.standortHolen()); } catch { heimat = null; }
    const aus = {
      richtung, zeit: iso(jetzt), fenster_s: Math.round(this.fenster_ms / 1000), aufzeichnung: this.aufzeichnung,
      werkzeug: this.werkzeugStatus(), geo: geoStatus(this.geo), heimat,
      summe: { anzahl: 0, bytes: 0, gegenstellen: 0 }, gegenstellen: [], lokal: [],
    };
    if (!this.aufzeichnung) return aus;
    this._ablaufen(jetzt);
    const liste = [];
    const lokalGesamt = new Map();
    for (const g of this._gegen.values()) {
      if (g.richtung !== richtung) continue;
      let bytes = 0;
      const lokal = new Map();
      for (const k of g.tupel) {
        const t = this._tupel.get(k);
        if (!t) continue;
        bytes += t.bytes;
        const lk = `${t.lokal.art}|${t.lokal.name}`;
        const l = lokal.get(lk);
        if (l) l.anzahl++; else lokal.set(lk, { name: t.lokal.name, art: t.lokal.art, anzahl: 1 });
        const lg = lokalGesamt.get(lk);
        if (lg) { lg.anzahl++; lg.bytes += t.bytes; } else lokalGesamt.set(lk, { name: t.lokal.name, art: t.lokal.art, anzahl: 1, bytes: t.bytes });
      }
      aus.summe.anzahl += g.tupel.size;
      aus.summe.bytes += bytes;
      liste.push({ g, bytes, lokal: [...lokal.values()].sort(nachAnzahl) });
    }
    aus.summe.gegenstellen = liste.length;
    liste.sort((a, b) => b.g.zuletzt - a.g.zuletzt || b.g.tupel.size - a.g.tupel.size || (a.g.ip < b.g.ip ? -1 : a.g.ip > b.g.ip ? 1 : 0));
    aus.gegenstellen = liste.slice(0, GRENZEN.ergebnis).map(({ g, bytes, lokal }) => ({
      ip: g.ip, privat: g.privat, anycast: g.anycast, ort: g.ort ? { ...g.ort } : null, anzahl: g.tupel.size, bytes,
      erst: iso(g.erst), zuletzt: iso(g.zuletzt), lokal,
    }));
    aus.lokal = [...lokalGesamt.values()].sort(nachAnzahl);
    return aus;
  }
}
