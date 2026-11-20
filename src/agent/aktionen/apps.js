// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „apps.*“ (Teilprojekt 2): Katalog (eingebaut, Unraid-Feed, eigene Importe), Vorschau, Installieren,
// Liste mit Zustand/CPU/RAM, Steuern, Ändern, Aktualisieren, Löschen, Protokoll, Ports für die Firewall, apply.
//
// Ablage je App: <apps>/<name>/{app.json, compose.yml, .env (0600), daten/}. Wahrheit ist der Spiegel
// <konfig>/apps/<name>/app.json (über konfig.aendern, gesperrt); apps.apply baut daraus fehlende Dateien wieder auf
// und startet Apps mit autostart. Docker läuft nur über werkzeuge.system (Argumentlisten, JSON-Ausgaben).
//
// Firewall: nach jeder Änderung ruft dieses Modul render/firewall.js selbst mit den aktuellen App-Ports
// (zusatzPorts). system.js bleibt unverändert – der Renderer liest die App-Ports sonst aus dem Spiegel (§11).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE, pruefeDateiname } from '../../gemeinsam/pfade.js';
import { MUSTER_NUTZER_ODER_GRUPPE } from '../../gemeinsam/schema.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { rendereFirewall } from '../render/firewall.js';
import { NAME_APP, ID_KATALOG, rendern, risikenBestaetigt, webuiRendern, hostPorts, nasMarkenEinsetzen, hatNasMarke } from '../apps/compose.js';
import { Katalog, suchen } from '../apps/katalog.js';
import { Docker, zustandZusammenfassen, projektName, adressenKollidieren, adresseNormieren } from '../apps/docker.js';
import { vorlageAusXml, feedParsen, FEED_URL } from '../apps/unraid.js';
import { vorlageAusCompose } from '../apps/eigene.js';
import { zipAuswerten, zipAuspacken, zipDrueberlegen, manageAusfuehren, containerDesOrdners, webuiAusPorts, ZIP_MAX_BYTES, PROTOKOLL_DATEI } from '../apps/zip.js';
import { ANPASSUNG_DATEI, einstellungenAusConfig, anpassungPruefen, anpassungYaml, portsAusDiensten } from '../apps/anpassung.js';
import * as fahgit from '../apps/fahgit.js';
import { gruppenIds } from '../helfer/gpu.js';
import { imagePruefen } from '../apps/registry.js';
import { nasNetz as nasNetzVon } from '../helfer/netzadressen.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import { ablageFinden, containerLesen, projekteBilden, neuerVolumeName, volumeLabels, uebernahmeYaml, kontenHinweise, UEBERNAHME_DATEI } from '../apps/uebernahme.js';
import { volumePfad, alterPfadZiel } from '../import/einhaengen.js';
import { normieren as orteNormieren, zeigtAuf, zielPfad as ortZiel, volumeOrt } from '../import/speicherorte.js';
import { eingehaengt as gemountet } from '../render/samba.js';

export const KATALOG_ORDNER = '_katalog';
export const ZIP_EINGANG = '_eingang';
const ZIP_KENNUNG = /^z[0-9a-f]{16}$/;
const ZIP_EINGANG_MAX_MS = 24 * 60 * 60 * 1000;
export const DATEN_ORDNER = 'daten';
export const SICHERUNG_MAX_BYTES = 5 * 1024 ** 3;
export const SICHERUNGEN_BEHALTEN = 2;
const APP_DATEI = 'app.json';
const UPDATES_DATEI = 'apps-updates.json';          // letzter Registry-Abgleich (Kachel „Updates“, Apps → „Update bereit“)
const UPDATES_TTL_MS = 12 * 60 * 60 * 1000;          // höchstens alle 12 h von selbst fragen
const UPDATES_RUHE_MS = 30 * 60 * 1000;              // nach einem gescheiterten Abgleich so lange nicht von selbst neu
const SPEICHER_TTL_MS = 5 * 60 * 1000;               // docker system df kann bei großen Volumes dauern
const COMPOSE_DATEI = 'compose.yml';
const ENV_DATEI = '.env';
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/i;
const FAHGIT_TAKT_MS = 5 * 60 * 1000;               // Apps aus FAH-Git mit „automatisch“: so oft nach neuem Commit fragen

// Takt für automatische Updates aus FAH-Git – die Arbeit setzt registriere(), starten()/stoppen() ruft der Agent
let fahgitTakt = null;
let fahgitTimer = null;

// ---------------------------------------------------------------------------------------------------------------
// Pfade, Ablage, Spiegel
// ---------------------------------------------------------------------------------------------------------------
function pfadeVon(w) {
  const p = (w && w.pfade) || {};
  return { apps: p.apps || PFADE.apps, shares: p.shares || PFADE.shares, konfig: p.konfig || PFADE.konfig, katalog: p.katalog || PFADE.katalog, backup: p.backup || PFADE.backup, nft: p.nft };
}
function appPfade(w, name) {
  const ordner = path.join(pfadeVon(w).apps, name);
  return { name, ordner, composeDatei: path.join(ordner, COMPOSE_DATEI), envDatei: path.join(ordner, ENV_DATEI), datenOrdner: path.join(ordner, DATEN_ORDNER), appDatei: path.join(ordner, APP_DATEI) };
}
function spiegelName(name) { return `apps/${name}/${APP_DATEI}`; }

/**
 * Pfade einer installierten App aus ihrem Satz. ZIP-Apps (art „zip“) haben Projekt und Compose-Dateien der manage.sh
 * (siehe docker.js composeArgs); composeDatei zeigt auf deren erste Datei.
 */
function appPfadeVon(w, satz) {
  const grund = appPfade(w, satz.name);
  // Anpassungen aus „Bearbeiten“ (Ports/Pfade/Variablen) gelten bei jedem compose-Aufruf (docker.js composeArgs)
  const app = { ...grund, anpassungDatei: satz.anpassung ? path.join(grund.ordner, ANPASSUNG_DATEI) : null };
  if (satz.art !== 'zip') return app;
  const dateien = Array.isArray(satz.compose_dateien) ? satz.compose_dateien : [];
  // übernommene Docker-Projekte (Umstieg): Compose-Dateien und Arbeitsordner bleiben am alten Ort (projekt_ordner)
  const projektOrdner = satz.uebernommen && satz.projekt_ordner ? satz.projekt_ordner : null;
  return { ...app, art: 'zip', projekt: satz.projekt || satz.name, composeDateien: dateien, composeDatei: dateien[0] || path.join(app.ordner, 'docker-compose.yml'), envDatei: path.join(projektOrdner || app.ordner, ENV_DATEI), projektOrdner };
}
/** Compose-Projekt einer App (ZIP-Apps: wie von der manage.sh angelegt). */
function projektVon(satz) { return satz.art === 'zip' && satz.projekt ? satz.projekt : projektName(satz.name); }
async function existiert(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Namen aller Freigaben (für Pfade wie „private/ordner“ in App-Feldern). */
async function freigabeNamen(w) { try { return ((await w.konfig.laden('shares.json', { freigaben: [] }))?.freigaben || []).map((f) => f.name).filter(Boolean); } catch { return []; } }
function zeitStempel(d = new Date()) { return d.toISOString().slice(0, 19).replace(/:/g, '-'); }

/** Alle App-Sätze aus dem Spiegel (sortiert nach Name). */
async function alleApps(w) {
  const ordner = path.join(pfadeVon(w).konfig, 'apps');
  let namen = [];
  try { namen = (await fs.readdir(ordner)).filter((n) => NAME_APP.test(n)).sort(); } catch { return []; }
  const aus = [];
  for (const n of namen) {
    try { const d = await w.konfig.laden(spiegelName(n), null); if (d && d.name === n) aus.push(d); } catch (e) { process.stderr.write(`[apps] Spiegel ${n}: ${e.message}\n`); }
  }
  return aus;
}

async function appHolen(w, name) {
  const d = await w.konfig.laden(spiegelName(name), null);
  if (!d || d.name !== name) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die App „${name}“ ist nicht installiert`, { feld: 'name' });
  return d;
}

/** Satz in den Spiegel (Sperre) und als Kopie in den App-Ordner schreiben. */
async function satzSchreiben(w, satz) {
  if (!Array.isArray(satz.sichtbar_fuer)) {
    // Plan 07: wer die App sehen darf, geht beim Bearbeiten/Aktualisieren nie verloren (fehlt = nur Admins)
    let alt = null; try { alt = await w.konfig.laden(spiegelName(satz.name), null); } catch { /* neu */ }
    satz = { ...satz, sichtbar_fuer: alt && Array.isArray(alt.sichtbar_fuer) ? alt.sichtbar_fuer : [] };
  }
  await w.konfig.aendern(spiegelName(satz.name), () => satz, null);
  try { await fs.writeFile(appPfade(w, satz.name).appDatei, JSON.stringify(satz, null, 2) + '\n', { mode: 0o640 }); } catch (e) { process.stderr.write(`[apps] app.json-Kopie ${satz.name}: ${e.message}\n`); }
  return satz;
}

/**
 * Darf `kontext` die App sehen (Plan 07)? Admins immer; sonst nur, wenn `sichtbar_fuer` den Nutzer oder eine seiner
 * Gruppen (`@gruppe`) enthält. Fehlt das Feld (Apps von vor 0.21.0), sehen sie nur Admins.
 */
export function appSichtbar(app, kontext, users) {
  if (kontext && (kontext.rolle === 'admin' || kontext.rolle === 'system')) return true;
  const liste = app && Array.isArray(app.sichtbar_fuer) ? app.sichtbar_fuer : [];
  if (!liste.length || !kontext) return false;
  if (liste.includes(kontext.nutzer)) return true;
  const n = ((users && users.nutzer) || []).find((x) => x.name === kontext.nutzer);
  const gruppen = new Set([...(n && n.gruppen ? n.gruppen : []), ...((users && users.gruppen) || []).filter((g) => (g.mitglieder || []).includes(kontext.nutzer)).map((g) => g.name)]);
  return liste.some((e) => e.startsWith('@') && gruppen.has(e.slice(1)));
}

/**
 * Plan 07: einen gelöschten Nutzer (`name`) bzw. eine gelöschte Gruppe (`@name`) aus „sichtbar für“ aller Apps
 * entfernen – sonst erbte ein später gleichnamig angelegtes Konto die Apps ohne Freigabe durch einen Admin.
 */
async function kontoAusAppsEntfernen(w, eintrag) {
  let geaendert = false;
  for (const app of await alleApps(w)) {
    if (!Array.isArray(app.sichtbar_fuer) || !app.sichtbar_fuer.includes(eintrag)) continue;
    const neu = await w.konfig.aendern(spiegelName(app.name), (d) => (d && Array.isArray(d.sichtbar_fuer) ? { ...d, sichtbar_fuer: d.sichtbar_fuer.filter((x) => x !== eintrag) } : d), null);
    try { await fs.writeFile(appPfade(w, app.name).appDatei, JSON.stringify(neu, null, 2) + '\n', { mode: 0o640 }); } catch { /* Kopie im App-Ordner ist nur ein Spiegel */ }
    geaendert = true;
  }
  if (geaendert) { try { w.konfigGeaendert?.('apps'); } catch { /* nie werfen */ } }
}
export function nutzerAusAppsEntfernen(w, name) { return kontoAusAppsEntfernen(w, name); }

/** Umbenannter Nutzer: „sichtbar für“ aller Apps geht auf den neuen Namen über (Spiegel + Kopie im App-Ordner). */
export async function nutzerInAppsUmbenennen(w, alt, neu) {
  let geaendert = false;
  for (const app of await alleApps(w)) {
    if (!Array.isArray(app.sichtbar_fuer) || !app.sichtbar_fuer.includes(alt)) continue;
    const satz = await w.konfig.aendern(spiegelName(app.name), (d) => (d && Array.isArray(d.sichtbar_fuer) ? { ...d, sichtbar_fuer: [...new Set(d.sichtbar_fuer.map((x) => (x === alt ? neu : x)))] } : d), null);
    try { await fs.writeFile(appPfade(w, app.name).appDatei, JSON.stringify(satz, null, 2) + '\n', { mode: 0o640 }); } catch { /* Kopie im App-Ordner ist nur ein Spiegel */ }
    geaendert = true;
  }
  if (geaendert) { try { w.konfigGeaendert?.('apps'); } catch { /* nie werfen */ } }
}
export function gruppeAusAppsEntfernen(w, name) { return kontoAusAppsEntfernen(w, `@${name}`); }

async function satzEntfernen(w, name) {
  await fs.rm(path.join(pfadeVon(w).konfig, 'apps', name), { recursive: true, force: true });
}

/** .env lesen (NAME='wert') → Objekt; fehlt sie → {}. */
async function envLesen(datei) {
  const aus = {};
  let text; try { text = await fs.readFile(datei, 'utf8'); } catch { return aus; }
  for (const z of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)='(.*)'$/.exec(z.trim());
    if (m) aus[m[1]] = m[2];
  }
  return aus;
}

/** compose.yml (0640) und .env (0600) atomar schreiben; Bind-Mount-Ordner der App anlegen. */
async function dateienSchreiben(w, app, g) {
  await fs.mkdir(app.ordner, { recursive: true, mode: 0o750 });
  await fs.mkdir(app.datenOrdner, { recursive: true, mode: 0o777 });
  try { await fs.chmod(app.datenOrdner, 0o777); } catch { /* egal */ } // mkdir unterliegt der umask – Rechte ausdrücklich setzen
  for (const p of Object.values(g.hostPfade)) {
    // nur Ordner IM App-Ordner anlegen (Freigaben gibt es schon; fehlende Freigabe-Pfade sind ein Fehler des Nutzers)
    if (p === app.ordner || p.startsWith(app.ordner + '/')) { await fs.mkdir(p, { recursive: true, mode: 0o777 }); try { await fs.chmod(p, 0o777); } catch { /* egal */ } }
    else if (!(await existiert(p))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Der Ordner ${p} gibt es nicht – bitte erst in der Freigabe anlegen`, { feld: Object.keys(g.hostPfade).find((k) => g.hostPfade[k] === p), pfad: p });
  }
  for (const [datei, text, modus] of [[app.composeDatei, g.compose, 0o640], [app.envDatei, g.env, 0o600]]) {
    const tmp = `${datei}.${process.pid}.tmp`;
    try { await fs.unlink(tmp); } catch { /* nicht da */ }
    const fh = await fs.open(tmp, 'wx', modus);
    try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, datei);
    try { await fs.chmod(datei, modus); } catch { /* egal */ }
  }
}

/** Datensatz einer App (Spiegel) aus Vorlage + Rendering bauen. */
function satzBauen({ name, vorlage, g, eingabe, autostart, bestaetigt, alt }) {
  const jetzt = new Date().toISOString();
  return {
    name, katalog_id: vorlage.id, titel: vorlage.name, symbol: vorlage.symbol || '', kategorie: vorlage.kategorie || 'Sonstiges', webui: vorlage.webui || '',
    vorlage: { id: vorlage.id, name: vorlage.name, quelle: vorlage.quelle, beschreibung: vorlage.beschreibung || '', kategorie: vorlage.kategorie, symbol: vorlage.symbol || '', webui: vorlage.webui || '', compose: vorlage.compose, felder: vorlage.felder, herkunft: vorlage.herkunft || null, hinweise: vorlage.hinweise || [], version: vorlage.version || null, ...(vorlage.host_ports ? { host_ports: vorlage.host_ports } : {}), ...(vorlage.bauen ? { bauen: { dienst: vorlage.bauen.dienst, image: vorlage.bauen.image } } : {}) },
    eingabe, werte: g.werte, geheimnisse: Object.keys(g.geheimnisse), ports: g.ports.map((p) => ({ port: p.port, protokoll: p.protokoll, dienst: p.dienst, ziel: p.ziel ?? null, feld: p.feld || null, ...(p.adresse ? { adresse: p.adresse } : {}) })),
    dienste: g.dienste, binds: g.binds, benannte_volumes: g.benannteVolumes, risiken: g.risiken.map((r) => r.art).filter((x, i, a) => a.indexOf(x) === i), bestaetigt_riskant: bestaetigt,
    warnungen: g.warnungen, autostart: !!autostart, installiert: alt ? alt.installiert : jetzt, geaendert: jetzt, aktualisiert: alt ? alt.aktualisiert : jetzt,
    version: alt ? alt.version : { images: {} }, sicherungen: alt ? alt.sicherungen || [] : [],
    sichtbar_fuer: alt && Array.isArray(alt.sichtbar_fuer) ? alt.sichtbar_fuer : [],
  };
}

/** Eingabe ohne Geheimnisse (die stehen nur in .env). */
function eingabeOhneGeheimnisse(werte, vorlage) {
  const geheim = new Set(vorlage.felder.filter((f) => f.art === 'geheimnis').map((f) => f.name));
  const aus = {};
  for (const [k, v] of Object.entries(werte || {})) if (!geheim.has(k)) aus[k] = v;
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------------------------------------------
const S_NAME = { typ: 'string', pflicht: true, max: 31, muster: NAME_APP, hinweis: 'App-Name: klein, 2–31 Zeichen aus a-z, 0-9 und -, beginnt mit Buchstabe oder Ziffer' };
const S_ID = { typ: 'string', pflicht: true, max: 100, muster: ID_KATALOG, hinweis: 'Vorlagen-Kennung ungültig' };
const S_WERTE = { typ: 'object', standard: {} };
const S_BESTAETIGT = { typ: 'array', max: 50, elemente: { typ: 'string', max: 40, muster: /^[a-z_]+$/ } };

export async function starten() {
  if (fahgitTimer) return;
  fahgitTimer = setInterval(() => { if (fahgitTakt) fahgitTakt().catch((e) => process.stderr.write(`[apps] FAH-Git-Takt: ${e.message}\n`)); }, FAHGIT_TAKT_MS);
  fahgitTimer.unref?.();
}
export async function stoppen() { clearInterval(fahgitTimer); fahgitTimer = null; }
/** Nur für Tests: die aktuelle Takt-Arbeit (null, solange registriere() nicht lief). */
export const _fahgitTakt = () => fahgitTakt;

export function registriere(reg, werkzeuge) {
  const w = werkzeuge;
  const pf = pfadeVon(w);
  const katalog = new Katalog({ eingebaut: pf.katalog, katalogOrdner: path.join(pf.apps, KATALOG_ORDNER) });
  const docker = new Docker(w.system);
  const laufend = new Set();
  const ereignis = () => { try { w.konfigGeaendert?.('apps'); } catch { /* nie werfen */ } };

  async function mitSperre(name, fn) {
    if (laufend.has(name)) throw new FahnasFehler('E_BELEGT', `An der App „${name}“ läuft gerade ein anderer Vorgang – bitte kurz warten`, { feld: 'name', name });
    laufend.add(name);
    try { return await fn(); } finally { laufend.delete(name); }
  }

  /**
   * Netz des NAS für {NAS_IP}/{NAS_GATEWAY} in Standardwerten: Quelladresse und Router der Standardroute – z. B. die
   * Lauschadresse von FAH-Adblock (0.0.0.0:53 ginge nicht, dort lauschen schon systemd-resolved und libvirt-dnsmasq).
   * @returns {Promise<{ip:string|null, gateway:string|null}>}
   */
  async function nasNetz() { return nasNetzVon(w.system); }

  /**
   * FAH-Apps (vorlage.bauen): Image aus dem mitgelieferten Quellcode bauen, wenn es fehlt oder aus einer anderen
   * Quelle stammt (Label fahnas.quelle ≠ Prüfsumme der Quelle im Programm). Gibt true zurück, wenn gebaut wurde.
   */
  async function imageBauen(vorlage, { fortschritt, abgebrochen, erzwingen = false } = {}) {
    const b = vorlage.bauen;
    if (!b || !b.kontext) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Der Quellcode für ${b ? b.image : vorlage.id} fehlt im Programm (katalog/quellen/${vorlage.id}) – bitte FAH-NAS aktualisieren`, { feld: 'katalog_id', image: b ? b.image : null });
    const vorhanden = await docker.imageLabel(b.image, 'fahnas.quelle');
    if (!erzwingen && vorhanden && vorhanden === b.quelle) return false;
    await docker.bauen(b.image, b.kontext, { labels: { 'fahnas.quelle': b.quelle, 'fahnas.katalog': vorlage.id, ...(b.version ? { 'fahnas.version': b.version } : {}) }, fortschritt, abgebrochen });
    return true;
  }

  /** Firewall mit allen App-Ports neu rendern; Fehler werden Warnung (die App läuft schon). */
  async function firewallRendern(warnungen) {
    try {
      const sys = await w.konfig.laden('system.json');
      const ports = (await alleApps(w)).flatMap((a) => (a.ports || []).map((p) => ({ port: p.port, protokoll: p.protokoll, app: a.name })));
      const r = await rendereFirewall({ ssh: !(sys && sys.ssh === false) }, { system: w.system, zusatzPorts: ports, konfigOrdner: pf.konfig, pfad: pf.nft });
      return r;
    } catch (e) {
      const text = `Firewall nicht aktualisiert: ${e.message}`;
      warnungen.push(text); process.stderr.write(`[apps] ${text}\n`);
      return null;
    }
  }

  /**
   * Port-Konflikte: gegen lauschende Dienste, Container und andere Apps (eigene Ports der App ausgenommen).
   * Je Konflikt `{feld, port, protokoll, belegt_von, app, vorschlag}` – `vorschlag` = nächster freier Port (Oberfläche: „Vorschlag übernehmen“).
   */
  async function portKonflikte(ports, { name, eigene = [] } = {}) {
    // je Port die Lauschadressen: ein Dienst im Host-Netz, der nur an die LAN-Adresse bindet (p.adresse), kollidiert nicht
    // mit systemd-resolved (127.0.0.53) oder libvirt-dnsmasq (192.168.122.1) auf demselben Port
    const belegt = typeof docker.belegtePortsMitAdressen === 'function'
      ? await docker.belegtePortsMitAdressen()
      : new Map([...(await docker.belegtePorts())].map(([k, v]) => [k, { text: v, adressen: ['*'] }]));
    const eigen = new Map(eigene.map((p) => [`${p.port}/${p.protokoll}`, adresseNormieren(p.adresse)]));
    const andere = new Map();
    for (const a of await alleApps(w)) if (a.name !== name) for (const p of a.ports || []) andere.set(`${p.port}/${p.protokoll}`, a.name);
    const gewuenscht = new Set(ports.map((p) => `${p.port}/${p.protokoll}`));
    const frei = (k) => !belegt.has(k) && !andere.has(k) && !gewuenscht.has(k);
    const vorschlagFuer = (port, proto) => { for (let n = port + 1; n <= 65535; n++) if (frei(`${n}/${proto}`)) return n; return null; };
    const aus = [];
    for (const p of ports) {
      const k = `${p.port}/${p.protokoll}`;
      if (andere.has(k)) { aus.push({ feld: p.feld || null, port: p.port, protokoll: p.protokoll, belegt_von: `App ${andere.get(k)}`, app: andere.get(k), vorschlag: vorschlagFuer(p.port, p.protokoll) }); continue; }
      const b = belegt.get(k);
      if (eigen.has(k)) {
        // eigener Port: nur prüfen, wenn sich die Lauschadresse ändert (FAH-Adblock 192.168.1.29 → 0.0.0.0 kollidiert mit
        // systemd-resolved) – die bisherige eigene Adresse zählt dabei nicht als fremder Lauscher
        const altAdresse = eigen.get(k);
        if (altAdresse === adresseNormieren(p.adresse)) continue;
        const fremd = b ? b.adressen.filter((x) => adresseNormieren(x) !== altAdresse) : [];
        if (fremd.length && adressenKollidieren(p.adresse, fremd)) aus.push({ feld: p.feld || null, port: p.port, protokoll: p.protokoll, belegt_von: b.text, app: null, vorschlag: vorschlagFuer(p.port, p.protokoll) });
        continue;
      }
      if (b && adressenKollidieren(p.adresse, b.adressen) && !(name && b.text.startsWith(`Container ${projektName(name)}-`))) aus.push({ feld: p.feld || null, port: p.port, protokoll: p.protokoll, belegt_von: b.text, app: null, vorschlag: vorschlagFuer(p.port, p.protokoll) });
    }
    return aus;
  }

  /**
   * FAH-App ohne Image (Import auf neuem System, prune, Wechsel des Docker-Speichers): aus dem mitgelieferten Quellcode bauen
   * statt zu pullen – das Image gibt es in keiner Registry. true, wenn gebaut wurde.
   */
  async function fehlendesImageBauen(satz) {
    const bau = satz.vorlage && satz.vorlage.bauen;
    if (!bau || await docker.digest(bau.image)) return false;
    let k = null;
    try { k = await katalog.eintrag(satz.katalog_id); } catch { k = null; }
    if (!(k && k.bauen && k.bauen.image === bau.image)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Das Image ${bau.image} fehlt und die Vorlage ist nicht mehr im Katalog`, { image: bau.image });
    await imageBauen(k);
    return true;
  }

  async function zustandVon(app) {
    try { return { ...zustandZusammenfassen(await docker.ps(app)), docker: true }; } catch (e) { return { zustand: 'unbekannt', gesundheit: null, docker: false, fehler: e.message }; }
  }

  // ---- Katalog --------------------------------------------------------------------------------------------------
  reg.aktion('apps.katalog.liste', {
    rolle: 'admin', beschreibung: 'Vorlagen des App-Katalogs (Suche, Kategorie, Quelle, Seiten) – nur Admins installieren (Plan 07)',
    schema: { suche: { typ: 'string', max: 200 }, kategorie: { typ: 'string', max: 60 }, quelle: { typ: 'string', werte: ['eingebaut', 'unraid', 'eigen'] }, seite: { typ: 'integer', min: 1, max: 100000, standard: 1 }, je_seite: { typ: 'integer', min: 1, max: 500, standard: 50 } },
    ausfuehren: async (p) => {
      // eigene FAH-Apps nur noch per ZIP (Betreiber 12.10.2026) – ihre Vorlagen bleiben nur für schon installierte Apps
      const r = suchen((await katalog.alle()).filter((v) => !v.nur_bestand), p);
      const u = await katalog.unraid();
      const installiert = (await alleApps(w)).map((a) => ({ name: a.name, katalog_id: a.katalog_id }));
      return { ...r, unraid_geladen: u.geladen, unraid_zeit: u.geladen, unraid_anzahl: u.vorlagen.length, installiert };
    },
  });

  reg.aktion('apps.katalog.eintrag', {
    rolle: 'admin', beschreibung: 'Vollständige Vorlage (Compose, Felder)',
    schema: { id: S_ID },
    ausfuehren: async (p) => {
      const v = await katalog.eintrag(p.id);
      const { datei, ...rest } = v; // eslint-disable-line no-unused-vars
      if (rest.felder.some((f) => hatNasMarke(f.standard))) {
        const nas = await nasNetz();
        rest.felder = rest.felder.map((f) => (hatNasMarke(f.standard) ? { ...f, standard: nasMarkenEinsetzen(f.standard, nas) } : f));
      }
      return { ...rest, installiert: (await alleApps(w)).filter((a) => a.katalog_id === v.id).map((a) => a.name) };
    },
  });

  reg.aktion('apps.katalog.unraid_laden', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Unraid-Anwendungsfeed laden/erneuern und in Vorlagen übersetzen',
    schema: { url: { typ: 'string', max: 500, muster: HTTPS_URL, hinweis: 'Nur https-Adressen' } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const url = p.url || FEED_URL;
      const ordner = path.join(pf.apps, KATALOG_ORDNER);
      await fs.mkdir(ordner, { recursive: true, mode: 0o750 });
      const tmp = path.join(ordner, `unraid-feed.roh.${process.pid}.json`);
      aufgabe.fortschritt(0.05, 'Der Unraid-Feed wird geladen (etwa 18 MB)');
      try {
        try {
          await w.system.ausfuehren('curl', ['-fsSL', '--max-time', '300', '--retry', '2', '-A', 'FAH-NAS', '-o', tmp, url], { zeitlimit_ms: 330_000 });
        } catch (e) { throw new FahnasFehler('E_SYSTEM', 'Der Unraid-Feed konnte nicht geladen werden (Internetverbindung?)', { befehl: `curl ${url}`, ausgabe: e.details?.ausgabe || e.message }); }
        if (aufgabe.abgebrochen()) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
        aufgabe.fortschritt(0.6, 'Vorlagen werden übersetzt');
        const text = await fs.readFile(tmp, 'utf8');
        let r;
        try { r = feedParsen(text); } catch (e) { throw new FahnasFehler('E_SYSTEM', `Der Unraid-Feed ist nicht lesbar: ${e.message}`, { ausgabe: text.slice(0, 200) }); }
        aufgabe.fortschritt(0.9, `${r.anzahl} Vorlagen werden gespeichert`);
        const zeit = new Date().toISOString();
        await katalog.feedSpeichern({ eintraege: r.eintraege, geladen: zeit, quelle: url });
        ereignis();
        return { anzahl: r.anzahl, zeit, feed_stand: r.geladen, uebersprungen: r.uebersprungen };
      } finally { try { await fs.unlink(tmp); } catch { /* nicht da */ } }
    },
  });

  reg.aktion('apps.katalog.importieren', {
    rolle: 'admin', beschreibung: 'Unraid-Vorlage (XML-Text oder https-Adresse) oder eigene Compose-Datei als eigene Vorlage übernehmen',
    schema: {
      xml: { typ: 'string', max: IMPORT_MAX_BYTES }, url: { typ: 'string', max: 500, muster: HTTPS_URL, hinweis: 'Nur https-Adressen' },
      compose: { typ: 'string', max: IMPORT_MAX_BYTES }, titel: { typ: 'string', max: 100 },
    },
    ausfuehren: async (p) => {
      if (p.compose !== undefined) {
        if (p.xml || p.url) throw new FahnasFehler('E_PARAMS', 'Bitte nur eine Quelle angeben (Compose-Datei oder Unraid-Vorlage)', { feld: 'compose' });
        const v = vorlageAusCompose(p.compose, { titel: p.titel });
        const gespeichert = await katalog.eigeneSpeichern(v);
        ereignis();
        return gespeichert;
      }
      if (!p.xml === !p.url) throw new FahnasFehler('E_PARAMS', 'Bitte entweder den XML-Text oder eine Adresse angeben', { feld: p.xml ? 'url' : 'xml' });
      let text = p.xml;
      if (p.url) {
        const ordner = path.join(pf.apps, KATALOG_ORDNER);
        await fs.mkdir(ordner, { recursive: true, mode: 0o750 });
        const tmp = path.join(ordner, `import.${process.pid}.xml`);
        try {
          try { await w.system.ausfuehren('curl', ['-fsSL', '--max-time', '60', '--max-filesize', String(IMPORT_MAX_BYTES), '-A', 'FAH-NAS', '-o', tmp, p.url], { zeitlimit_ms: 70_000 }); } catch (e) { throw new FahnasFehler('E_SYSTEM', 'Die Vorlage konnte nicht geladen werden', { befehl: `curl ${p.url}`, ausgabe: e.details?.ausgabe || e.message }); }
          text = await fs.readFile(tmp, 'utf8');
        } finally { try { await fs.unlink(tmp); } catch { /* nicht da */ } }
      }
      const v = vorlageAusXml(text, { quelle_url: p.url || '' });
      const gespeichert = await katalog.eigeneSpeichern(v);
      ereignis();
      return gespeichert;
    },
  });

  reg.aktion('apps.katalog.loeschen', {
    rolle: 'admin', beschreibung: 'Eigene Vorlage löschen',
    schema: { id: S_ID },
    ausfuehren: async (p) => { const r = await katalog.eigeneLoeschen(p.id); ereignis(); return r; },
  });

  // ---- Vorschau und Installation --------------------------------------------------------------------------------
  reg.aktion('apps.pruefen', {
    rolle: 'admin', beschreibung: 'Vorschau: Compose, Warnungen, riskante Rechte, Port-Konflikte (ohne Installation)',
    schema: { katalog_id: S_ID, name: S_NAME, werte: S_WERTE },
    ausfuehren: async (p) => {
      const vorlage = await katalog.eintrag(p.katalog_id);
      const app = appPfade(w, p.name);
      const g = rendern(vorlage, p.werte, { appOrdner: app.ordner, shares: pf.shares, nas: await nasNetz(), freigaben: await freigabeNamen(w) });
      const satz = await w.konfig.laden(spiegelName(p.name), null);
      const vorhanden = (await existiert(app.ordner)) || !!satz;
      // Einstellungsdialog einer installierten App: ihre eigenen Ports (docker-proxy lauscht darauf) zählen wie bei
      // apps.aendern nicht als belegt
      const eigene = satz && satz.name === p.name && satz.katalog_id === p.katalog_id ? satz.ports || [] : [];
      return {
        compose: g.vorschau, warnungen: g.warnungen, riskant: g.risiken, port_konflikte: await portKonflikte(g.ports, { name: p.name, eigene }),
        ports: g.ports, webui: g.webui, dienste: g.dienste, binds: g.binds, name_frei: !vorhanden, felder: vorlage.felder, hinweise: vorlage.hinweise || [],
      };
    },
  });

  reg.aktion('apps.installieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'App aus einer Vorlage installieren (Dateien, Images laden, starten, Firewall)',
    schema: { katalog_id: S_ID, name: S_NAME, werte: S_WERTE, autostart: { typ: 'boolean', standard: true }, bestaetigt_riskant: { ...S_BESTAETIGT, standard: [] } },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const app = appPfade(w, p.name);
      if (await w.konfig.laden(spiegelName(p.name), null)) throw new FahnasFehler('E_EXISTIERT', `Eine App „${p.name}“ gibt es schon`, { feld: 'name' });
      if (await existiert(app.ordner)) throw new FahnasFehler('E_EXISTIERT', `Unter ${app.ordner} liegt schon ein Ordner – bitte anderen Namen wählen oder den Ordner entfernen`, { feld: 'name', pfad: app.ordner });
      const vorlage = await katalog.eintrag(p.katalog_id);
      if (vorlage.nur_bestand) throw new FahnasFehler('E_PARAMS', 'Eigene FAH-Apps werden per ZIP installiert (Apps → ZIP-App hochladen)', { feld: 'katalog_id' });
      const g = rendern(vorlage, p.werte, { appOrdner: app.ordner, shares: pf.shares, nas: await nasNetz(), freigaben: await freigabeNamen(w) });
      const bestaetigt = risikenBestaetigt(g.risiken, p.bestaetigt_riskant);
      const konflikte = await portKonflikte(g.ports, { name: p.name });
      if (konflikte.length) throw new FahnasFehler('E_BELEGT', `Port ${konflikte[0].port}/${konflikte[0].protokoll} ist schon belegt (${konflikte[0].belegt_von})`, { feld: konflikte[0].feld || 'werte', port_konflikte: konflikte });
      const warnungen = [...g.warnungen];
      // „nur lokal baubar“ (verfuegbar:false ohne mitgelieferten Quellcode): Image muss schon auf dem NAS liegen, kein pull
      if (vorlage.verfuegbar === false && !vorlage.bauen) {
        for (const d of g.dienste) if (!(await docker.digest(d.image))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Das Image ${d.image} fehlt auf dem NAS – diese App muss erst lokal gebaut werden`, { feld: 'katalog_id', image: d.image });
      }
      if (vorlage.bauen && !vorlage.bauen.kontext) await imageBauen(vorlage); // wirft E_NICHT_GEFUNDEN mit Erklärung
      aufgabe.fortschritt(0.03, 'Dateien werden angelegt');
      let angelegt = false;
      try {
        angelegt = true; // ab hier kann der Ordner existieren (auch wenn dateienSchreiben mittendrin abbricht) – bei Fehlern aufräumen
        await dateienSchreiben(w, app, g);
        await docker.pruefen(app);
        if (vorlage.bauen) {
          // FAH-App: Image aus dem Quellcode im Programm bauen (keine Registry); weitere Dienste normal laden
          aufgabe.fortschritt(0.06, `Image ${vorlage.bauen.image} wird aus dem Quellcode gebaut (einige Minuten)`);
          await imageBauen(vorlage, { abgebrochen: aufgabe.abgebrochen, fortschritt: (anteil, meldung) => aufgabe.fortschritt(0.06 + anteil * 0.7, meldung) });
          if (g.dienste.some((d) => d.image !== vorlage.bauen.image)) {
            const pull = await docker.pull(app, g.dienste.filter((d) => d.image !== vorlage.bauen.image), { ignorieren: true, abgebrochen: aufgabe.abgebrochen });
            for (const f of pull.fehler) if (!f.startsWith(`${vorlage.bauen.dienst}:`)) warnungen.push(`Image nicht geladen: ${f}`);
          }
        } else if (vorlage.verfuegbar !== false) {
          aufgabe.fortschritt(0.08, 'Images werden geladen');
          const pull = await docker.pull(app, g.dienste, { ignorieren: true, abgebrochen: aufgabe.abgebrochen, fortschritt: (anteil, meldung) => aufgabe.fortschritt(0.08 + anteil * 0.72, meldung) });
          for (const f of pull.fehler) warnungen.push(`Image nicht geladen: ${f}`);
        }
        if (aufgabe.abgebrochen()) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
        aufgabe.fortschritt(0.85, 'App wird gestartet');
        await docker.up(app, { abgebrochen: aufgabe.abgebrochen, fortschritt: (_a, m) => aufgabe.fortschritt(0.9, m) });
        docker.leeren();
        const version = { images: {} };
        for (const d of g.dienste) version.images[d.image] = await docker.digest(d.image);
        const satz = satzBauen({ name: p.name, vorlage, g, eingabe: eingabeOhneGeheimnisse(p.werte, vorlage), autostart: p.autostart, bestaetigt });
        satz.version = version;
        await satzSchreiben(w, satz);
        aufgabe.fortschritt(0.95, 'Firewall wird angepasst');
        await firewallRendern(warnungen);
        ereignis();
        const z = await zustandVon(app);
        aufgabe.fortschritt(1, 'Fertig');
        return { name: p.name, zustand: z.zustand, gesundheit: z.gesundheit, webui: webuiRendern(vorlage.webui, g.werte), ports: satz.ports, warnungen, risiken: satz.risiken };
      } catch (e) {
        // nichts Halbes stehen lassen: Container weg, Ordner weg (nur, wenn wir ihn angelegt haben)
        if (angelegt) {
          try { await docker.down(app, { volumes: g.benannteVolumes }); } catch { /* egal */ }
          try { await fs.rm(app.ordner, { recursive: true, force: true }); } catch { /* egal */ }
          await satzEntfernen(w, p.name).catch(() => {});
        }
        throw e;
      }
    }),
  });

  // ---- ZIP-Apps (Release-ZIP mit manage.sh) ---------------------------------------------------------------------
  // Ablauf: apps.zip.ticket → Hochladen über /api/agent-upload → apps.zip.pruefen → apps.zip.installieren bzw.
  // apps.zip.aktualisieren. Die ZIP wartet im Eingang <apps>/_eingang/<kennung>.zip (+ .json mit dem Originalnamen).
  const eingang = path.join(pf.apps, ZIP_EINGANG);

  async function eingangAufraeumen() {
    let namen = [];
    try { namen = await fs.readdir(eingang); } catch { return; }
    for (const n of namen) {
      try { const st = await fs.stat(path.join(eingang, n)); if (Date.now() - st.mtimeMs > ZIP_EINGANG_MAX_MS) await fs.rm(path.join(eingang, n), { force: true, recursive: true }); } catch { /* egal */ }
    }
  }

  /** ZIP im Eingang zur Kennung: {datei, meta:{dateiname, nutzer, zeit}, groesse}. */
  async function eingangHolen(kennung) {
    if (!ZIP_KENNUNG.test(String(kennung || ''))) throw new FahnasFehler('E_PARAMS', 'Kennung der hochgeladenen ZIP ungültig', { feld: 'kennung' });
    const datei = path.join(eingang, `${kennung}.zip`);
    let meta; let st;
    try { meta = JSON.parse(await fs.readFile(path.join(eingang, `${kennung}.json`), 'utf8')); st = await fs.stat(datei); } catch {
      throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Die hochgeladene ZIP ist nicht mehr da – bitte erneut hochladen', { feld: 'kennung' });
    }
    if (meta.groesse !== undefined && meta.groesse !== null && st.size !== meta.groesse) throw new FahnasFehler('E_ABGEBROCHEN', 'Die ZIP ist unvollständig angekommen – bitte erneut hochladen', { feld: 'kennung', erwartet: meta.groesse, groesse: st.size });
    return { datei, meta, groesse: st.size };
  }

  async function eingangEntfernen(kennung) {
    for (const e of ['.zip', '.json']) await fs.rm(path.join(eingang, `${kennung}${e}`), { force: true }).catch(() => {});
  }

  async function sha256Datei(datei) {
    const h = crypto.createHash('sha256');
    const fh = await fs.open(datei, 'r');
    try { for await (const teil of fh.createReadStream()) h.update(teil); } finally { await fh.close().catch(() => {}); }
    return h.digest('hex');
  }

  /** Fortschritt aus den Zeilen der manage.sh: nähert sich 0.9, Meldung = letzte Zeile (gekürzt). */
  function manageFortschritt(aufgabe, start, ende) {
    let n = 0;
    return (z) => { n++; aufgabe.fortschritt(start + (ende - start) * (1 - Math.exp(-n / 120)), z.trim().slice(0, 140)); };
  }

  /** Nach manage.sh: Container des Ordners → Projekt, Compose-Dateien, Ports, Dienste, Link; wirft, wenn nichts läuft. */
  async function zipStandLesen(app, zeilen) {
    const container = await containerDesOrdners(w.system, app.ordner);
    if (!container.length) {
      throw new FahnasFehler('E_SYSTEM', `Die manage.sh lief durch, aber aus ${app.ordner} läuft kein Container – passt die ZIP zu diesem Ordner?`, { ausgabe: (zeilen || []).slice(-40).join('\n') });
    }
    const projekt = container[0].projekt || app.name;
    const ports = new Map();
    for (const c of container) for (const p of c.ports) ports.set(`${p.port}/${p.protokoll}`, p);
    const dateien = container.find((c) => c.dateien.length)?.dateien || [];
    const dienste = [...new Map(container.filter((c) => c.dienst).map((c) => [c.dienst, { name: c.dienst, image: c.image }])).values()];
    const warnungen = [];
    if (container.some((c) => c.netz === 'host')) warnungen.push('Ein Dienst der App nutzt das Netzwerk des NAS direkt (Host-Netz) – seine Ports kennt FAH-NAS nicht und gibt sie in der Firewall nicht frei');
    if (container.some((c) => c.projekt !== projekt)) warnungen.push(`Die Container aus ${app.ordner} gehören zu mehreren Compose-Projekten – FAH-NAS steuert nur „${projekt}“`);
    const webui = container.map((c) => c.webui).find(Boolean) || webuiAusPorts([...ports.values()]);
    return { projekt, compose_dateien: dateien, ports: [...ports.values()].sort((a, b) => a.port - b.port), dienste, webui, warnungen };
  }

  /** Überschneidungen der Ports einer ZIP-App mit anderen Apps (deren Ports kennt die manage.sh nicht). */
  async function portUeberschneidungen(name, ports) {
    const aus = [];
    for (const a of await alleApps(w)) {
      if (a.name === name) continue;
      for (const p of a.ports || []) if (ports.some((x) => x.port === p.port && x.protokoll === p.protokoll)) aus.push(`Port ${p.port}/${p.protokoll} ist auch für die App „${a.name}“ eingetragen – läuft die gerade nicht, stößt sie beim nächsten Start auf diesen Port`);
    }
    return aus;
  }

  /** Die hochgeladene ZIP mit ihrem Originalnamen in den App-Ordner legen (die manage.sh sucht sie unter diesem Namen). */
  async function zipAblegen(quelle, app, dateiname) {
    const ziel = path.join(app.ordner, dateiname);
    try { await fs.rename(quelle, ziel); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fs.copyFile(quelle, ziel); await fs.rm(quelle, { force: true });
    }
    return ziel;
  }

  /**
   * ZIP ohne manage.sh (Betreiber 12.10.2026): Compose festlegen (aus der ZIP oder aus dem Dockerfile erzeugt), Ports
   * prüfen, bauen und starten – bei Portkonflikt nur bauen und nicht starten (Hinweis: unter „Bearbeiten“ Port ändern).
   */
  async function ohneSkriptStarten(app, a, name, aufgabe, { neu, alt = null }) {
    let compose;
    if (a.compose_datei) {
      const rel = a.ordner ? a.compose_datei.slice(a.ordner.length + 1) : a.compose_datei;
      compose = path.join(app.ordner, rel);
      if (/\.(example|beispiel|vorlage|sample)$/i.test(rel)) {
        const ziel = path.join(app.ordner, 'compose.yml');
        if (neu || !(await existiert(ziel))) await fs.copyFile(compose, ziel);
        compose = ziel;
      }
    } else {
      compose = path.join(app.ordner, 'compose.yml');
      if (neu || !(await existiert(compose))) await fs.writeFile(compose, a.compose, { mode: 0o640 });
    }
    const appZ = { ...app, art: 'zip', projekt: projektName(name), composeDateien: [compose], composeDatei: compose, envDatei: path.join(app.ordner, ENV_DATEI) };
    await docker.pruefen(appZ);
    const dienste = einstellungenAusConfig(await docker.configJson(appZ));
    const ports = portsAusDiensten(dienste);
    const konflikte = await portKonflikte(ports, { name, eigene: neu ? [] : ((alt && alt.ports) || []) });
    const warnungen = [];
    let portkonflikt = null;
    if (konflikte.length) {
      const k = konflikte[0];
      portkonflikt = `NAS-Port ${k.port}/${k.protokoll} ist belegt (${k.belegt_von})${k.vorschlag ? ` – frei wäre z. B. ${k.vorschlag}` : ''}`;
      warnungen.push(`${portkonflikt}. Die App ist gebaut, aber nicht gestartet: unter „Bearbeiten“ einen anderen NAS-Port eintragen und starten.`);
      aufgabe.fortschritt(0.3, 'Portkonflikt – App wird nur gebaut, nicht gestartet');
      await docker.composeMitZeilen(appZ, ['build'], { abgebrochen: aufgabe.abgebrochen, text: 'Die App konnte nicht gebaut werden', beiZeile: manageFortschritt(aufgabe, 0.3, 0.85) });
    } else {
      aufgabe.fortschritt(0.2, 'App wird gebaut und gestartet (kann einige Minuten dauern)');
      await docker.composeMitZeilen(appZ, ['up', '-d', '--build', '--remove-orphans'], { abgebrochen: aufgabe.abgebrochen, text: 'Die App konnte nicht gebaut oder gestartet werden', beiZeile: manageFortschritt(aufgabe, 0.2, 0.88) });
    }
    return {
      projekt: appZ.projekt, compose_dateien: [compose], ports, dienste: dienste.map((d) => ({ name: d.name, image: d.image })),
      webui: webuiAusPorts(ports), warnungen, portkonflikt, gestartet: !portkonflikt,
    };
  }

  /** Alte → neue NAS-Ports (gleicher Dienst, Container-Port, Protokoll) – für Link und Vorlagenwerte nach „Bearbeiten“. */
  function portAbbildung(vorher, nachher) {
    const m = new Map();
    for (const d of nachher) {
      const v = vorher.find((x) => x.name === d.name);
      if (!v) continue;
      for (const p of d.ports) {
        const alt = v.ports.find((x) => x.container === p.container && x.protokoll === p.protokoll);
        if (alt && alt.host !== p.host) m.set(alt.host, p.host);
      }
    }
    return m;
  }
  function webuiUmschreiben(webui, abbildung) {
    if (typeof webui !== 'string') return webui;
    return webui.replace(/:(\d{1,5})(?=\/|$)/, (z, n) => (abbildung.has(Number(n)) ? `:${abbildung.get(Number(n))}` : z));
  }
  /** Vorlagenwerte (Port-Felder) der neuen Belegung angleichen, damit Link und „Einstellungen“ zusammenpassen. */
  function werteUmschreiben(satz, abbildung) {
    const werte = { ...(satz.werte || {}) }; const eingabe = { ...(satz.eingabe || {}) };
    for (const f of (satz.vorlage && satz.vorlage.felder) || []) {
      if (f.art !== 'port') continue;
      for (const ziel of [werte, eingabe]) if (abbildung.has(Number(ziel[f.name]))) ziel[f.name] = abbildung.get(Number(ziel[f.name]));
    }
    return { werte, eingabe };
  }

  /** Startfehler „Port belegt“ von docker erkennen → verständliche Meldung + Port. */
  function portFehlerDeuten(e) {
    const f = FahnasFehler.aus(e);
    const text = `${f.message} ${(f.details && f.details.ausgabe) || ''}`;
    if (!/port is already allocated|address already in use/i.test(text)) return null;
    const m = /:(\d{1,5})(?:\s|:|\)|$|\D)[^\n]*?(?:already allocated|already in use)/i.exec(text) || /:(\d{1,5})/.exec(text);
    return m ? Number(m[1]) : 0;
  }

  reg.aktion('apps.zip.ticket', {
    rolle: 'admin', beschreibung: 'Ticket zum Hochladen einer App-ZIP (Release-ZIP mit manage.sh) in den Eingang',
    schema: { dateiname: { typ: 'string', pflicht: true, max: 255 }, groesse: { typ: 'integer', pflicht: true, min: 1, max: ZIP_MAX_BYTES } },
    ausfuehren: async (p, k) => {
      pruefeDateiname(p.dateiname, 'dateiname');
      if (!/\.zip$/i.test(p.dateiname)) throw new FahnasFehler('E_PARAMS', 'Bitte eine .zip-Datei wählen', { feld: 'dateiname' });
      if (!w.datenkanal) throw new FahnasFehler('E_SYSTEM', 'Datenkanal nicht verfügbar');
      await fs.mkdir(eingang, { recursive: true, mode: 0o700 });
      await eingangAufraeumen();
      const kennung = `z${crypto.randomBytes(8).toString('hex')}`;
      await fs.writeFile(path.join(eingang, `${kennung}.json`), JSON.stringify({ dateiname: p.dateiname, groesse: p.groesse, nutzer: k.nutzer, zeit: new Date().toISOString() }) + '\n', { mode: 0o600 });
      const t = w.datenkanal.ticket({ nutzer: k.nutzer, uid: 0, gid: 0, art: 'schreiben', pfad: path.join(eingang, `${kennung}.zip`), dateiname: `${kennung}.zip`, groesse: p.groesse });
      return { ticket: t.ticket, kennung };
    },
  });

  /** ZIP im Eingang prüfen (auch für „Aus FAH-Git bauen“): manage.sh, Compose, riskante Rechte, Namensvorschlag. */
  async function zipPruefen(kennung, wunschName) {
    const { datei, meta, groesse } = await eingangHolen(kennung);
    const a = await zipAuswerten(w.system, datei, meta.dateiname);
    const name = wunschName || a.name_vorschlag;
    const vorhanden = name ? (await existiert(appPfade(w, name).ordner)) || !!(await w.konfig.laden(spiegelName(name), null)) : false;
    // gleiche App schon installiert? ZIP: gleicher Namensvorschlag aus dem Dateinamen; FAH-Git: dasselbe Projekt
    const installiert = (await alleApps(w)).filter((x) => x.art === 'zip' && (meta.fahgit
      ? x.fahgit && x.fahgit.pfad === meta.fahgit.pfad
      : x.zip && x.zip.basis === a.name_vorschlag)).map((x) => x.name);
    return {
      kennung, dateiname: meta.dateiname, groesse, manage: a.manage, ordner: a.ordner, compose_datei: a.compose_datei, compose: a.compose,
      dockerfile: a.dockerfile, dateien: a.dateien, riskant: a.risiken, warnungen: a.warnungen, hinweise: [],
      name_vorschlag: a.name_vorschlag, titel_vorschlag: a.titel_vorschlag, name_frei: !vorhanden, installiert_als: installiert,
      fahgit: meta.fahgit || null,
    };
  }

  reg.aktion('apps.zip.pruefen', {
    rolle: 'admin', beschreibung: 'Hochgeladene App-ZIP prüfen: manage.sh, Compose, riskante Rechte, Namensvorschlag',
    schema: { kennung: { typ: 'string', pflicht: true, max: 40 }, name: { typ: 'string', max: 31 } },
    ausfuehren: async (p) => zipPruefen(p.kennung, p.name),
  });

  reg.aktion('apps.zip.installieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'App aus einer ZIP installieren: Ordner anlegen, manage.sh update ausführen, Ports/Firewall übernehmen',
    schema: {
      kennung: { typ: 'string', pflicht: true, max: 40 }, name: S_NAME, titel: { typ: 'string', max: 60 }, autostart: { typ: 'boolean', standard: true },
      bestaetigt_riskant: { ...S_BESTAETIGT, standard: [] }, fahgit_auto: { typ: 'boolean', standard: false },
    },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const app = appPfade(w, p.name);
      if (await w.konfig.laden(spiegelName(p.name), null)) throw new FahnasFehler('E_EXISTIERT', `Eine App „${p.name}“ gibt es schon`, { feld: 'name' });
      if (await existiert(app.ordner)) throw new FahnasFehler('E_EXISTIERT', `Unter ${app.ordner} liegt schon ein Ordner – bitte anderen Namen wählen oder den Ordner entfernen`, { feld: 'name', pfad: app.ordner });
      const { datei, meta, groesse } = await eingangHolen(p.kennung);
      aufgabe.fortschritt(0.02, 'ZIP wird geprüft');
      const a = await zipAuswerten(w.system, datei, meta.dateiname);
      const bestaetigt = risikenBestaetigt(a.risiken, p.bestaetigt_riskant);
      const sha256 = await sha256Datei(datei);
      const warnungen = [...a.warnungen];
      let zeilen = [];
      try {
        aufgabe.fortschritt(0.05, 'App-Ordner wird angelegt');
        await fs.mkdir(app.ordner, { recursive: false, mode: 0o750 });
        // wie in den Anleitungen: Inhalt entpacken (Projektordner ohne die oberste Ebene), ZIP daneben für manage.sh,
        // die sich ihre ZIP selbst suchen; dann „manage.sh update“ im App-Ordner
        aufgabe.fortschritt(0.04, 'ZIP wird entpackt');
        await zipAuspacken(w.system, datei, a.ordner, app.ordner, { mitManage: !a.ohne_skript });
        let stand;
        if (a.ohne_skript) {
          // ohne manage.sh: FAH-NAS baut und startet selbst (Portkonflikt → nur gebaut, Hinweis auf „Bearbeiten“)
          await fs.rm(datei, { force: true }).catch(() => {});
          stand = await ohneSkriptStarten(app, a, p.name, aufgabe, { neu: true });
          warnungen.push(...stand.warnungen);
        } else {
          // Aus FAH-Git: die Dateien liegen schon im Ordner, das Archiv hat den Projektordner als oberste Ebene und taugt nicht als Release-ZIP
          const abgelegt = meta.fahgit ? null : await zipAblegen(datei, app, meta.dateiname);
          aufgabe.fortschritt(0.08, 'manage.sh update läuft (bauen und starten, kann einige Minuten dauern)');
          ({ zeilen } = await manageAusfuehren(w.system, app.ordner, 'update', { beiZeile: manageFortschritt(aufgabe, 0.08, 0.88), abgebrochen: aufgabe.abgebrochen }));
          await fs.rm(abgelegt || datei, { force: true }); // nicht von der manage.sh weggesichert → nicht mehr gebraucht
          aufgabe.fortschritt(0.9, 'Container und Ports werden ermittelt');
          stand = await zipStandLesen(app, zeilen);
          warnungen.push(...stand.warnungen, ...(await portUeberschneidungen(p.name, stand.ports)));
        }
        const jetzt = new Date().toISOString();
        const titel = (p.titel || a.titel_vorschlag || p.name).trim().slice(0, 60);
        const kategorie = meta.fahgit ? 'FAH-Git' : 'ZIP-Apps';
        const satz = {
          name: p.name, art: 'zip', katalog_id: 'zip', titel, symbol: '', kategorie, webui: stand.webui,
          vorlage: { id: 'zip', name: titel, quelle: 'zip', beschreibung: '', kategorie, symbol: '', webui: stand.webui, compose: '', felder: [], hinweise: [] },
          eingabe: {}, werte: {}, geheimnisse: [], ports: stand.ports, dienste: stand.dienste, binds: [], benannte_volumes: true,
          risiken: a.risiken.map((r) => r.art).filter((x, i, l) => l.indexOf(x) === i), bestaetigt_riskant: bestaetigt, warnungen,
          autostart: !!p.autostart, installiert: jetzt, geaendert: jetzt, aktualisiert: jetzt, version: { images: {} }, sicherungen: [],
          projekt: stand.projekt, compose_dateien: stand.compose_dateien, portkonflikt: stand.portkonflikt || null,
          zip: { datei: meta.dateiname, basis: a.name_vorschlag, sha256, groesse, eingespielt: jetzt, ohne_skript: !!a.ohne_skript },
          ...(meta.fahgit ? { fahgit: { ...meta.fahgit, auto: !!p.fahgit_auto, eingespielt: jetzt } } : {}),
        };
        await satzSchreiben(w, satz);
        await eingangEntfernen(p.kennung);
        aufgabe.fortschritt(0.95, 'Firewall wird angepasst');
        await firewallRendern(warnungen);
        docker.leeren(); ereignis();
        const z = await zustandVon(appPfadeVon(w, satz));
        aufgabe.fortschritt(1, 'Fertig');
        return { name: p.name, zustand: z.zustand, gesundheit: z.gesundheit, webui: stand.webui, ports: stand.ports, warnungen, risiken: satz.risiken, portkonflikt: satz.portkonflikt, protokoll: a.ohne_skript ? null : path.join(app.ordner, PROTOKOLL_DATEI) };
      } catch (e) {
        // nichts Halbes stehen lassen: Container des Ordners weg, Protokoll in den Eingang retten, Ordner weg
        const f = FahnasFehler.aus(e);
        try {
          const reste = await containerDesOrdners(w.system, app.ordner);
          if (reste.length) await w.system.ausfuehren('docker', ['rm', '-f', '-v', ...reste.map((c) => c.id)], { zeitlimit_ms: 120_000, erlaubteCodes: [0, 1] });
        } catch { /* egal */ }
        let protokoll = null;
        try { await fs.mkdir(eingang, { recursive: true, mode: 0o700 }); protokoll = path.join(eingang, `${p.name}-fehler-${zeitStempel()}.log`); await fs.copyFile(path.join(app.ordner, PROTOKOLL_DATEI), protokoll); } catch { protokoll = null; }
        try { await fs.rm(app.ordner, { recursive: true, force: true }); } catch { /* egal */ }
        await satzEntfernen(w, p.name).catch(() => {});
        docker.leeren();
        throw new FahnasFehler(f.code, f.message, { ...(f.details || {}), ...(protokoll ? { protokoll } : {}), ausgabe: (f.details && f.details.ausgabe) || zeilen.slice(-40).join('\n') });
      }
    }),
  });

  /** Herkunft FAH-Git nach einem Update: neuer Commit aus dem Eingang, Einstellung „automatisch“ bleibt. */
  function fahgitNachUpdate(alt, meta, jetzt) {
    if (!meta.fahgit && !alt.fahgit) return {};
    return { fahgit: { ...(alt.fahgit || {}), ...(meta.fahgit || {}), auto: !!(alt.fahgit && alt.fahgit.auto), eingespielt: jetzt } };
  }

  reg.aktion('apps.zip.aktualisieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Neue ZIP in eine ZIP-App einspielen: manage.sh update erneut ausführen (Daten und .env bleiben)',
    schema: { kennung: { typ: 'string', pflicht: true, max: 40 }, name: S_NAME, bestaetigt_riskant: { ...S_BESTAETIGT, standard: [] } },
    ausfuehren: async (p, _k, _w, aufgabe) => zipAktualisieren(p, aufgabe),
  });

  async function zipAktualisieren(p, aufgabe) {
    return mitSperre(p.name, async () => {
      const alt = await appHolen(w, p.name);
      if (alt.art !== 'zip' || alt.uebernommen) throw new FahnasFehler('E_PARAMS', `Die App „${p.name}“ stammt nicht aus einer ZIP – sie wird über „Aktualisieren“ auf den neuesten Stand gebracht`, { feld: 'name' });
      const app = appPfadeVon(w, alt);
      const { datei, meta, groesse } = await eingangHolen(p.kennung);
      aufgabe.fortschritt(0.02, 'ZIP wird geprüft');
      const a = await zipAuswerten(w.system, datei, meta.dateiname, { bevorzugtCompose: !!(alt.zip && alt.zip.ohne_skript) });
      const bestaetigt = risikenBestaetigt(a.risiken, [...(alt.bestaetigt_riskant || []), ...(p.bestaetigt_riskant || [])]);
      const sha256 = await sha256Datei(datei);
      const warnungen = [...a.warnungen];
      if (a.ohne_skript) {
        // ohne manage.sh: Dateien der ZIP über den Ordner legen (Daten, .env, Anpassungen bleiben), neu bauen und starten
        aufgabe.fortschritt(0.05, 'Neue Dateien werden eingespielt');
        await zipDrueberlegen(w.system, datei, a.ordner, app.ordner);
        await eingangEntfernen(p.kennung);
        const stand = await ohneSkriptStarten(app, a, p.name, aufgabe, { neu: false, alt });
        warnungen.push(...stand.warnungen);
        const jetzt = new Date().toISOString();
        const satz = {
          ...alt, ports: stand.ports, dienste: stand.dienste, projekt: stand.projekt, compose_dateien: stand.compose_dateien,
          webui: alt.anpassung ? alt.webui : stand.webui, risiken: a.risiken.map((r) => r.art).filter((x, i, l) => l.indexOf(x) === i),
          bestaetigt_riskant: bestaetigt, warnungen, geaendert: jetzt, aktualisiert: jetzt, portkonflikt: stand.portkonflikt || null,
          zip: { datei: meta.dateiname, basis: a.name_vorschlag || (alt.zip && alt.zip.basis) || null, sha256, groesse, eingespielt: jetzt, ohne_skript: true },
          ...fahgitNachUpdate(alt, meta, jetzt),
        };
        await satzSchreiben(w, satz);
        await firewallRendern(warnungen);
        const freiBytes = await docker.aufraeumen();
        docker.leeren(); ereignis();
        const z = await zustandVon(appPfadeVon(w, satz));
        aufgabe.fortschritt(1, 'Fertig');
        return { name: p.name, zustand: z.zustand, gesundheit: z.gesundheit, webui: satz.webui, ports: satz.ports, warnungen, frei_bytes: freiBytes, gleich: !!(alt.zip && alt.zip.sha256 === sha256), portkonflikt: satz.portkonflikt };
      }
      if (alt.zip && alt.zip.basis && a.name_vorschlag && alt.zip.basis !== a.name_vorschlag) warnungen.push(`Die ZIP heißt anders als die bisherige (${alt.zip.datei} → ${meta.dateiname}) – die manage.sh findet sie nur, wenn der Name zu ihrem Suchmuster passt`);
      let abgelegt = null; let zeilen = [];
      try {
        // Aus FAH-Git: neue Dateien über den Ordner legen, die manage.sh baut dann aus dem, was dort liegt (Daten und .env bleiben)
        if (meta.fahgit || alt.fahgit) await zipDrueberlegen(w.system, datei, a.ordner, app.ordner);
        else abgelegt = await zipAblegen(datei, app, meta.dateiname);
        aufgabe.fortschritt(0.06, 'manage.sh update läuft (bauen und tauschen, kann einige Minuten dauern)');
        // ZIP-Pfad als Argument: Projektordner-Apps (FunkSichta) spielen ihn so ein, selbstentpackende nehmen ihn oder suchen selbst
        ({ zeilen } = await manageAusfuehren(w.system, app.ordner, 'update', { argumente: abgelegt ? [abgelegt] : [], beiZeile: manageFortschritt(aufgabe, 0.06, 0.88), abgebrochen: aufgabe.abgebrochen }));
        if (abgelegt) await fs.rm(abgelegt, { force: true });
      } catch (e) {
        // die bisherige Version läuft weiter (die manage.sh baut vor dem Tausch); die neue ZIP nicht liegen lassen,
        // sonst nähme ein späteres „manage.sh update“ sie ungefragt
        if (abgelegt) await fs.rm(abgelegt, { force: true }).catch(() => {});
        await eingangEntfernen(p.kennung);
        const f = FahnasFehler.aus(e);
        throw new FahnasFehler(f.code, f.message, { ...(f.details || {}), protokoll: path.join(app.ordner, PROTOKOLL_DATEI), ausgabe: (f.details && f.details.ausgabe) || zeilen.slice(-40).join('\n') });
      }
      await eingangEntfernen(p.kennung);
      aufgabe.fortschritt(0.9, 'Container und Ports werden ermittelt');
      const stand = await zipStandLesen(app, zeilen);
      warnungen.push(...stand.warnungen, ...(await portUeberschneidungen(p.name, stand.ports)));
      if (alt.anpassung) {
        // die manage.sh startet ohne die Anpassungen aus „Bearbeiten“ – mit ihnen erneuern
        aufgabe.fortschritt(0.92, 'Anpassungen aus „Bearbeiten“ werden wieder angewendet');
        await docker.up(appPfadeVon(w, { ...alt, projekt: stand.projekt, compose_dateien: stand.compose_dateien }), { abgebrochen: aufgabe.abgebrochen });
        stand.ports = alt.ports; stand.webui = alt.webui;
      }
      const jetzt = new Date().toISOString();
      const satz = {
        ...alt, webui: stand.webui, vorlage: { ...alt.vorlage, webui: stand.webui }, ports: stand.ports, dienste: stand.dienste,
        projekt: stand.projekt, compose_dateien: stand.compose_dateien, risiken: a.risiken.map((r) => r.art).filter((x, i, l) => l.indexOf(x) === i),
        bestaetigt_riskant: bestaetigt, warnungen, geaendert: jetzt, aktualisiert: jetzt,
        zip: { datei: meta.dateiname, basis: a.name_vorschlag || (alt.zip && alt.zip.basis) || null, sha256, groesse, eingespielt: jetzt },
        ...fahgitNachUpdate(alt, meta, jetzt),
      };
      await satzSchreiben(w, satz);
      aufgabe.fortschritt(0.95, 'Firewall wird angepasst');
      await firewallRendern(warnungen);
      const freiBytes = await docker.aufraeumen(); // manage.sh baut neu – die alten Fassungen sind jetzt unbenannt
      docker.leeren(); ereignis();
      const z = await zustandVon(appPfadeVon(w, satz));
      aufgabe.fortschritt(1, 'Fertig');
      return { name: p.name, zustand: z.zustand, gesundheit: z.gesundheit, webui: stand.webui, ports: stand.ports, warnungen, frei_bytes: freiBytes, gleich: !!(alt.zip && alt.zip.sha256 === sha256) };
    });
  }

  // ---- Apps aus FAH-Git (Betreiber 26.10.2026) ------------------------------------------------------------------
  // Verbindung (Adresse + EIN Zugangsschlüssel für alle Projekte) in <konfig>/fahgit.json. „Aus FAH-Git bauen“ lädt das
  // Archiv eines Commits in den ZIP-Eingang – danach gilt der bekannte Weg apps.zip.pruefen/installieren/aktualisieren
  // (Compose bzw. Dockerfile haben Vorrang vor einer manage.sh). Apps mit „automatisch“ prüft ein Takt alle 5 Minuten.
  async function fahgitVerbindung() {
    const v = await fahgit.verbindungLaden(w.konfig);
    if (!v) throw new FahnasFehler('E_PARAMS', 'Noch keine Verbindung zu FAH-Git – bitte unter System → Grundlagen → „Verbindung zu FAH-Git“ Adresse und Zugangsschlüssel eintragen', { feld: 'fahgit' });
    return v;
  }

  /** Archiv des Kopf-Commits eines Zweigs in den Eingang legen → Kennung (wie nach einem ZIP-Hochladen). */
  async function fahgitHolen(pfad, zweig, nutzer) {
    const v = await fahgitVerbindung();
    const { projekt, zweig: z } = await fahgit.kopf(v, pfad, zweig);
    await fs.mkdir(eingang, { recursive: true, mode: 0o700 });
    await eingangAufraeumen();
    const kennung = `z${crypto.randomBytes(8).toString('hex')}`;
    const groesse = await fahgit.archivLaden(v, projekt.pfad, z.sha, path.join(eingang, `${kennung}.zip`), ZIP_MAX_BYTES);
    const herkunft = { pfad: projekt.pfad, name: projekt.name, zweig: z.name, commit: z.sha, betreff: z.betreff, datum: z.datum };
    await fs.writeFile(path.join(eingang, `${kennung}.json`), JSON.stringify({ dateiname: `${projekt.slug}.zip`, groesse, nutzer, zeit: new Date().toISOString(), fahgit: herkunft }) + '\n', { mode: 0o600 });
    return kennung;
  }

  reg.aktion('fahgit.verbindung', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Verbindung zu FAH-Git (Adresse, Anfang des Zugangsschlüssels, letzte Prüfung)',
    ausfuehren: async () => fahgit.verbindungAnsicht(await w.konfig.laden(fahgit.FAHGIT_DATEI, null)),
  });

  reg.aktion('fahgit.verbindung.speichern', {
    rolle: 'admin', beschreibung: 'Verbindung zu FAH-Git speichern und prüfen (leerer Schlüssel = bisheriger bleibt)',
    schema: { adresse: { typ: 'string', pflicht: true, max: 260 }, token: { typ: 'string', max: 120, standard: '' } },
    ausfuehren: async (p) => {
      const adresse = fahgit.adresseNormieren(p.adresse);
      const token = String(p.token || '').trim();
      if (token && !fahgit.SCHLUESSEL_MUSTER.test(token)) throw new FahnasFehler('E_PARAMS', 'Das ist kein FAH-Git-Zugangsschlüssel (beginnt mit „fgit_“)', { feld: 'token' });
      const vorher = await w.konfig.laden(fahgit.FAHGIT_DATEI, null);
      const neu = { version: 1, adresse, token: token || (vorher && vorher.token) || '' };
      if (!neu.token) throw new FahnasFehler('E_PARAMS', 'Bitte einen Zugangsschlüssel aus FAH-Git eintragen', { feld: 'token' });
      // erst prüfen, dann speichern: ein Tippfehler soll die laufende Verbindung nicht ersetzen
      const stand = await fahgit.pruefen(neu);
      neu.geprueft = { zeit: new Date().toISOString(), ok: true, ...stand };
      await w.konfig.speichern(fahgit.FAHGIT_DATEI, neu);
      return fahgit.verbindungAnsicht(neu);
    },
  });

  reg.aktion('fahgit.verbindung.pruefen', {
    rolle: 'admin', schema: {}, beschreibung: 'Gespeicherte Verbindung zu FAH-Git prüfen',
    ausfuehren: async () => {
      const v = await fahgitVerbindung();
      let geprueft;
      try { geprueft = { zeit: new Date().toISOString(), ok: true, ...(await fahgit.pruefen(v)) }; } catch (e) {
        geprueft = { zeit: new Date().toISOString(), ok: false, fehler: FahnasFehler.aus(e).message };
      }
      await w.konfig.aendern(fahgit.FAHGIT_DATEI, (d) => (d && d.token ? { ...d, geprueft } : UNVERAENDERT), null);
      return fahgit.verbindungAnsicht({ ...v, geprueft });
    },
  });

  reg.aktion('fahgit.verbindung.loeschen', {
    rolle: 'admin', schema: {}, beschreibung: 'Verbindung zu FAH-Git entfernen (gebaute Apps bleiben, nur Aktualisieren aus FAH-Git geht nicht mehr)',
    ausfuehren: async () => { await w.konfig.speichern(fahgit.FAHGIT_DATEI, { version: 1, adresse: '', token: '' }); return fahgit.verbindungAnsicht(null); },
  });

  reg.aktion('fahgit.projekte', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Projekte in FAH-Git (für „Aus FAH-Git bauen“)',
    ausfuehren: async () => {
      const v = await fahgitVerbindung();
      const gebaut = new Map((await alleApps(w)).filter((a) => a.fahgit).map((a) => [a.fahgit.pfad, a.name]));
      return fahgit.projekteFlach(await fahgit.abrufen(v, '/baum')).map((p) => ({ ...p, app: gebaut.get(p.pfad) || null }));
    },
  });

  reg.aktion('fahgit.zweige', {
    rolle: 'admin', lesend: true, schema: { pfad: { typ: 'string', pflicht: true, max: 500 } }, beschreibung: 'Zweige eines FAH-Git-Projekts',
    ausfuehren: async (p) => fahgit.projekt(await fahgitVerbindung(), p.pfad),
  });

  reg.aktion('apps.fahgit.holen', {
    rolle: 'admin', beschreibung: 'Projekt aus FAH-Git holen (Kopf-Commit des Zweigs) und wie eine ZIP prüfen',
    schema: { pfad: { typ: 'string', pflicht: true, max: 500 }, zweig: { typ: 'string', max: 200, standard: '' }, name: { typ: 'string', max: 31 } },
    ausfuehren: async (p, k) => zipPruefen(await fahgitHolen(p.pfad, p.zweig, k.nutzer), p.name),
  });

  /** Neuen Stand einer FAH-Git-App holen und einspielen; ohne neuen Commit nichts tun (außer erzwungen). */
  async function fahgitAktualisieren(name, aufgabe, { erzwingen = false, nutzer = 'system' } = {}) {
    const alt = await appHolen(w, name);
    if (!alt.fahgit) throw new FahnasFehler('E_PARAMS', `Die App „${name}“ stammt nicht aus FAH-Git`, { feld: 'name' });
    aufgabe.fortschritt(0.01, 'FAH-Git wird gefragt');
    const { zweig } = await fahgit.kopf(await fahgitVerbindung(), alt.fahgit.pfad, alt.fahgit.zweig);
    if (!erzwingen && zweig.sha === alt.fahgit.commit) { aufgabe.fortschritt(1, 'Schon auf dem neuesten Stand'); return { name, gleich: true, commit: zweig.sha }; }
    aufgabe.fortschritt(0.02, `Stand ${zweig.sha.slice(0, 7)} wird aus FAH-Git geholt`);
    const kennung = await fahgitHolen(alt.fahgit.pfad, alt.fahgit.zweig, nutzer);
    const r = await zipAktualisieren({ kennung, name, bestaetigt_riskant: [] }, aufgabe);
    return { ...r, commit: zweig.sha, gleich: false };
  }

  reg.aktion('apps.fahgit.aktualisieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'App aus FAH-Git auf den neuesten Commit ihres Zweigs bringen (neu bauen und starten)',
    schema: { name: S_NAME, erzwingen: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, k, _w, aufgabe) => fahgitAktualisieren(p.name, aufgabe, { erzwingen: p.erzwingen, nutzer: k.nutzer }),
  });

  reg.aktion('apps.fahgit.einstellen', {
    rolle: 'admin', beschreibung: 'App aus FAH-Git: bei neuem Commit automatisch neu bauen ja/nein, Zweig wechseln',
    schema: { name: S_NAME, auto: { typ: 'boolean' }, zweig: { typ: 'string', max: 200 } },
    ausfuehren: async (p) => mitSperre(p.name, async () => {
      const alt = await appHolen(w, p.name);
      if (!alt.fahgit) throw new FahnasFehler('E_PARAMS', `Die App „${p.name}“ stammt nicht aus FAH-Git`, { feld: 'name' });
      const fg = { ...alt.fahgit };
      if (p.auto !== undefined) fg.auto = p.auto;
      if (p.zweig !== undefined && p.zweig && p.zweig !== fg.zweig) {
        const { zweig } = await fahgit.kopf(await fahgitVerbindung(), fg.pfad, p.zweig);
        fg.zweig = zweig.name;
      }
      await satzSchreiben(w, { ...alt, fahgit: fg, geaendert: new Date().toISOString() });
      ereignis();
      return { name: p.name, fahgit: fg };
    }),
  });

  // Stand aller FAH-Git-Apps (Kachel, Apps-Liste): kurz zwischengespeichert, damit Oberfläche und Takt FAH-Git nicht fluten
  let fahgitStandCache = { zeit: 0, daten: null };
  async function fahgitStand(frisch = false) {
    if (!frisch && fahgitStandCache.daten && Date.now() - fahgitStandCache.zeit < 60_000) return fahgitStandCache.daten;
    const apps = (await alleApps(w)).filter((a) => a.fahgit);
    const v = await fahgit.verbindungLaden(w.konfig);
    const liste = [];
    for (const a of apps) {
      const e = { name: a.name, titel: a.titel || a.name, pfad: a.fahgit.pfad, zweig: a.fahgit.zweig, commit: a.fahgit.commit, betreff: a.fahgit.betreff || '',
        eingespielt: a.fahgit.eingespielt || null, auto: !!a.fahgit.auto, neu: null, neu_betreff: '', neuer: false, fehler: null, webui: a.webui || null };
      if (!v) e.fehler = 'Keine Verbindung zu FAH-Git eingerichtet';
      else {
        try { const { zweig } = await fahgit.kopf(v, a.fahgit.pfad, a.fahgit.zweig); e.neu = zweig.sha; e.neu_betreff = zweig.betreff; e.neuer = zweig.sha !== a.fahgit.commit; } catch (x) { e.fehler = FahnasFehler.aus(x).message; }
      }
      liste.push(e);
    }
    const daten = { verbunden: !!v, apps: liste };
    fahgitStandCache = { zeit: Date.now(), daten };
    return daten;
  }

  reg.aktion('apps.fahgit.stand', {
    rolle: 'admin', lesend: true, schema: { frisch: { typ: 'boolean', standard: false } }, beschreibung: 'Apps aus FAH-Git: eingespielter und neuester Commit',
    ausfuehren: async (p) => fahgitStand(p.frisch),
  });

  // Takt: automatische Updates (nur Apps mit „automatisch“, nie zwei gleichzeitig, Fehler nur ins Protokoll)
  fahgitTakt = async () => {
    const d = await fahgitStand(true).catch(() => null);
    if (!d) return;
    for (const e of d.apps.filter((x) => x.auto && x.neuer && !x.fehler)) {
      if (laufend.has(e.name)) continue;
      const griff = { fortschritt: () => {}, abgebrochen: () => false };
      const arbeit = (g) => fahgitAktualisieren(e.name, g || griff, { nutzer: 'system' });
      if (w.aufgaben && typeof w.aufgaben.einstellen === 'function') w.aufgaben.einstellen({ aktion: 'apps.fahgit.aktualisieren', nutzer: 'system', rolle: 'system', arbeit });
      else await arbeit(griff).catch((x) => process.stderr.write(`[apps] FAH-Git-Update ${e.name}: ${x.message}\n`));
    }
  };

  // ---- Liste, Details, Steuern ----------------------------------------------------------------------------------
  reg.aktion('apps.liste', {
    rolle: 'nutzer', schema: {}, beschreibung: 'Installierte Apps mit Zustand, Gesundheit, CPU/RAM (Nicht-Admins: nur für sie freigegebene)',
    ausfuehren: async (_p, k) => {
      const admin = !!k && (k.rolle === 'admin' || k.rolle === 'system');
      let apps = await alleApps(w);
      if (!admin) {
        // vor den Docker-Abfragen filtern (Plan 07): unsichtbare Apps gibt es für Nicht-Admins nicht
        const users = await w.konfig.laden('users.json', { nutzer: [], gruppen: [] });
        apps = apps.filter((a) => appSichtbar(a, k, users));
      }
      if (!apps.length) return [];
      let container = null; let stats = new Map();
      try { container = await docker.containerAlle(); stats = await docker.statsAlle(); } catch (e) { process.stderr.write(`[apps] Liste ohne Docker: ${e.message}\n`); }
      const upd = (await w.konfig.laden(UPDATES_DATEI, null).catch(() => null)) || {};
      return apps.map((a) => {
        const eigene = container ? container.filter((c) => c.projekt === projektVon(a)) : [];
        const z = container ? zustandZusammenfassen(eigene) : { zustand: 'unbekannt', gesundheit: null };
        let cpu = null; let ram = null;
        for (const c of eigene) {
          const s = stats.get(c.id) || stats.get(c.id.slice(0, 12)) || stats.get(c.name);
          if (s) { cpu = (cpu || 0) + (s.cpu_prozent || 0); ram = (ram || 0) + (s.ram_bytes || 0); }
        }
        return {
          name: a.name, katalog_id: a.katalog_id, titel: a.titel, symbol: a.symbol || '', kategorie: a.kategorie, zustand: z.zustand, gesundheit: z.gesundheit,
          webui: webuiRendern(a.webui, a.werte || {}), ports: a.ports || [], autostart: !!a.autostart, cpu_prozent: cpu === null ? null : Math.round(cpu * 10) / 10, ram_bytes: ram,
          installiert: a.installiert, aktualisiert: a.aktualisiert, version: a.version || null, container: eigene.length, risiken: a.risiken || [], quelle: a.vorlage && a.vorlage.quelle,
          art: a.art || 'vorlage', zip: a.zip ? { datei: a.zip.datei, eingespielt: a.zip.eingespielt, groesse: a.zip.groesse, ohne_skript: !!a.zip.ohne_skript } : null,
          fahgit: a.fahgit ? { pfad: a.fahgit.pfad, name: a.fahgit.name || '', zweig: a.fahgit.zweig, commit: a.fahgit.commit, betreff: a.fahgit.betreff || '', eingespielt: a.fahgit.eingespielt || null, auto: !!a.fahgit.auto } : null,
          uebernommen: a.uebernommen ? { quelle: a.uebernommen.quelle || null, volume: a.uebernommen.volume || null, ordner: a.uebernommen.ordner || a.projekt_ordner || null, alte_pfade: a.uebernommen.alte_pfade || [], datum: a.uebernommen.datum || null } : null,
          angepasst: !!a.anpassung, portkonflikt: a.portkonflikt || null, von_hand_gestoppt: !!a.von_hand_gestoppt,
          update: !!(upd.apps && upd.apps[a.name] && upd.apps[a.name].stand === 'update'),
          sichtbar_fuer: Array.isArray(a.sichtbar_fuer) ? a.sichtbar_fuer : [],
        };
      }).map((e) => {
        if (admin) return e;
        const { sichtbar_fuer: _s, risiken: _r, quelle: _q, zip: _z, fahgit: _fg, portkonflikt: _pk, uebernommen: _u, ...rest } = e;
        return rest;
      }).sort((x, y) => x.titel.localeCompare(y.titel, 'de'));
    },
  });

  // Wer darf die App sehen? (Plan 07, Betreiber 18.10.2026) – Nutzer und @gruppen; leer = nur Admins
  reg.aktion('apps.sichtbarkeit', {
    rolle: 'admin', beschreibung: 'Festlegen, welche Nutzer und Gruppen die App sehen und öffnen dürfen',
    schema: { name: S_NAME, sichtbar_fuer: { typ: 'array', pflicht: true, max: 500, elemente: { typ: 'string', max: 32, muster: MUSTER_NUTZER_ODER_GRUPPE, hinweis: 'Nutzer- oder @Gruppenname ungültig' } } },
    ausfuehren: async (p) => mitSperre(p.name, async () => {
      const alt = await appHolen(w, p.name);
      const users = await w.konfig.laden('users.json', { nutzer: [], gruppen: [] });
      const nutzer = new Set((users.nutzer || []).map((n) => n.name));
      const gruppen = new Set((users.gruppen || []).map((g) => g.name));
      for (const e of p.sichtbar_fuer) {
        const ok = e.startsWith('@') ? gruppen.has(e.slice(1)) : nutzer.has(e);
        if (!ok) throw new FahnasFehler('E_PARAMS', `„${e}“ gibt es nicht`, { feld: 'sichtbar_fuer', wert: e });
      }
      const liste = [...new Set(p.sichtbar_fuer)].sort((a, b) => a.localeCompare(b, 'de'));
      await satzSchreiben(w, { ...alt, sichtbar_fuer: liste, geaendert: new Date().toISOString() });
      ereignis();
      return { name: p.name, sichtbar_fuer: liste };
    }),
  });

  reg.aktion('apps.details', {
    rolle: 'admin', beschreibung: 'Einstellungen, Compose, Container einer App (ohne Geheimnisse)',
    schema: { name: S_NAME },
    ausfuehren: async (p) => {
      const a = await appHolen(w, p.name);
      const app = appPfadeVon(w, a);
      let compose = a.vorlage.compose; try { compose = await fs.readFile(app.composeDatei, 'utf8'); } catch { /* aus dem Spiegel */ }
      let container = []; let dockerOk = true;
      try { container = await docker.ps(app); } catch { dockerOk = false; }
      const { eingabe, ...rest } = a;
      return { ...rest, werte: a.werte, eingabe, felder: a.vorlage.felder, compose, container, docker: dockerOk, ...zustandZusammenfassen(container), webui: webuiRendern(a.webui, a.werte || {}) };
    },
  });

  // ---- App-Updates (Registry-Abgleich wie Unraid „Update bereit“) -------------------------------------------------
  const updatesLauf = { laeuft: null, zuletzt: 0 };

  /** Alle Vorlagen-Apps prüfen (ZIP-Apps kommen mit einer neuen ZIP); geteilte Images nur einmal fragen. */
  async function updatesPruefen() {
    const ergebnis = {}; const schon = new Map();
    for (const a of (await alleApps(w)).filter((x) => x.art !== 'zip')) {
      let images = Object.keys((a.version && a.version.images) || {});
      if (!images.length) { try { images = await docker.images(appPfadeVon(w, a)); } catch { images = []; } }
      const bau = a.vorlage && a.vorlage.bauen ? a.vorlage.bauen.image : null;
      const liste = [];
      for (const i of images) {
        if (i === bau) { liste.push({ image: i, stand: 'lokal' }); continue; } // FAH-App: wird aus dem Quellcode gebaut
        if (!schon.has(i)) schon.set(i, await imagePruefen(i, { inspect: (x) => docker.repoDigests(x) }));
        liste.push(schon.get(i));
      }
      const stand = liste.some((x) => x.stand === 'update') ? 'update' : liste.some((x) => x.stand === 'fehler') ? 'unbekannt' : 'aktuell';
      ergebnis[a.name] = { stand, images: liste };
    }
    await w.konfig.speichern(UPDATES_DATEI, { geprueft: new Date().toISOString(), apps: ergebnis });
  }

  /** Nach „Aktualisieren“: die App hat jetzt die neuesten Images – „Update bereit“ sofort weg. */
  async function updatesAppErledigt(name) {
    try {
      const vorher = await w.konfig.laden(UPDATES_DATEI, null);
      if (!vorher || !vorher.apps || !vorher.apps[name]) return; // nie geprüft – nichts zu tun
      await w.konfig.aendern(UPDATES_DATEI, (d) => {
        const e = d && d.apps && d.apps[name];
        if (e) d.apps[name] = { stand: 'aktuell', images: (e.images || []).map((x) => (x.stand === 'update' ? { ...x, stand: 'aktuell' } : x)) };
      }, { apps: {} });
    } catch (e) { process.stderr.write(`[apps] Update-Stand ${name}: ${e.message}\n`); }
  }

  reg.aktion('apps.updates', {
    rolle: 'admin', lesend: true, schema: { pruefen: { typ: 'boolean', standard: false } },
    beschreibung: 'Verfügbare App-Updates: Abgleich der Image-Digests mit der Registry (von selbst höchstens alle 12 h, pruefen: jetzt)',
    ausfuehren: async (p) => {
      let d = await w.konfig.laden(UPDATES_DATEI, null);
      const alt = !d || !d.geprueft || Date.now() - Date.parse(d.geprueft) > UPDATES_TTL_MS;
      if (!updatesLauf.laeuft && (p.pruefen || (alt && Date.now() - updatesLauf.zuletzt > UPDATES_RUHE_MS))) {
        updatesLauf.zuletzt = Date.now();
        updatesLauf.laeuft = updatesPruefen().then(() => ereignis())
          .catch((e) => process.stderr.write(`[apps] Update-Prüfung: ${e.message}\n`))
          .finally(() => { updatesLauf.laeuft = null; });
      }
      if (p.pruefen && updatesLauf.laeuft) { await updatesLauf.laeuft; d = await w.konfig.laden(UPDATES_DATEI, null); }
      const titel = new Map((await alleApps(w)).map((a) => [a.name, a.titel || a.name]));
      const apps = Object.entries((d && d.apps) || {}).filter(([n]) => titel.has(n))
        .map(([name, e]) => ({ name, titel: titel.get(name), stand: e.stand, images: e.images || [] }))
        .sort((x, y) => x.titel.localeCompare(y.titel, 'de'));
      return { geprueft: (d && d.geprueft) || null, laeuft: !!updatesLauf.laeuft, anzahl: apps.filter((a) => a.stand === 'update').length, apps };
    },
  });

  // ---- Docker-Speicher -------------------------------------------------------------------------------------------
  let speicherStand = null; // {zeit, wert}
  reg.aktion('apps.docker_speicher', {
    rolle: 'admin', lesend: true, schema: { neu: { typ: 'boolean', standard: false } },
    beschreibung: 'Belegung durch Docker: Images, Container, Volumes, Bau-Zwischenspeicher, Container-Protokolle',
    ausfuehren: async (p) => {
      if (!p.neu && speicherStand && Date.now() - speicherStand.zeit < SPEICHER_TTL_MS) return speicherStand.wert;
      let wert;
      try { wert = await docker.speicher(); } catch (e) { throw new FahnasFehler('E_SYSTEM', 'Docker antwortet nicht – Belegung unbekannt', { ausgabe: String(e && e.message || e).slice(0, 2000) }); }
      wert = { ...wert, gemessen: new Date().toISOString() };
      speicherStand = { zeit: Date.now(), wert };
      return wert;
    },
  });

  reg.aktion('apps.docker_aufraeumen', {
    rolle: 'admin', aufgabe: true, schema: {},
    beschreibung: 'Ungenutztes von Docker löschen: unbenannte Images (alte Versionen) und den Bau-Zwischenspeicher – Images, die eine App benutzt, bleiben',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      aufgabe?.fortschritt(0.1, 'Alte Image-Versionen und Bau-Zwischenspeicher werden gelöscht');
      const frei = await docker.aufraeumen({ cacheAlle: true });
      speicherStand = null;
      aufgabe?.fortschritt(1, 'Fertig');
      return { frei_bytes: frei };
    },
  });

  reg.aktion('apps.steuern', {
    rolle: 'admin', beschreibung: 'App starten, stoppen oder neu starten',
    schema: { name: S_NAME, aktion: { typ: 'string', pflicht: true, werte: ['start', 'stopp', 'neustart'] } },
    ausfuehren: async (p) => mitSperre(p.name, async () => {
      const satz = await appHolen(w, p.name);
      const app = appPfadeVon(w, satz);
      try {
        if (p.aktion === 'start') { await fehlendesImageBauen(satz); await docker.up(app); } // up -d statt start: legt fehlende Container an, ist idempotent
        else if (p.aktion === 'stopp') await docker.stop(app);
        else await docker.restart(app);
      } catch (e) {
        const port = p.aktion !== 'stopp' ? portFehlerDeuten(e) : null;
        if (port === null) throw e;
        const text = `NAS-Port ${port || '?'} ist schon belegt`;
        await satzSchreiben(w, { ...satz, portkonflikt: text }); ereignis();
        throw new FahnasFehler('E_BELEGT', `${text} – die App kann so nicht starten. Unter „Bearbeiten“ einen freien NAS-Port eintragen.`, { port, feld: 'ports' });
      }
      // „von Hand gestoppt“ merken: die Benachrichtigungen melden eine gestoppte App dann nicht als abgestürzt
      const vonHand = p.aktion === 'stopp';
      if ((p.aktion !== 'stopp' && satz.portkonflikt) || !!satz.von_hand_gestoppt !== vonHand) await satzSchreiben(w, { ...satz, portkonflikt: p.aktion !== 'stopp' ? null : satz.portkonflikt || null, von_hand_gestoppt: vonHand });
      docker.leeren();
      ereignis();
      const z = await zustandVon(app);
      return { name: p.name, aktion: p.aktion, zustand: z.zustand, gesundheit: z.gesundheit };
    }),
  });

  // ---- Bearbeiten wie bei Unraid (Ports, Pfade, Variablen) – Betreiber 12.10.2026 --------------------------------------
  reg.aktion('apps.einstellungen', {
    rolle: 'admin', lesend: true, beschreibung: 'Wirksame Ports, Pfade und Variablen einer App (Geheimnisse verdeckt)',
    schema: { name: S_NAME },
    ausfuehren: async (p) => {
      const satz = await appHolen(w, p.name);
      const app = appPfadeVon(w, satz);
      const original = einstellungenAusConfig(await docker.configJson(app, { ohneAnpassung: true }));
      const dienste = satz.anpassung ? einstellungenAusConfig(await docker.configJson(app)) : original;
      let zustand = 'unbekannt'; try { zustand = (await zustandVon(app)).zustand; } catch { /* Docker weg */ }
      return {
        name: p.name, titel: satz.titel, art: satz.art || 'vorlage', angepasst: !!satz.anpassung, dienste, original,
        app_ordner: app.ordner, freigaben: pf.shares, zustand, laeuft: zustand === 'running' || zustand === 'teilweise' || zustand === 'restarting',
        autostart: !!satz.autostart, portkonflikt: satz.portkonflikt || null,
      };
    },
  });

  /**
   * Ordnerwahl für Ordnerfelder (Betreiber 12.10.2026: „Dropdown zur Ordnerwahl statt Tippen“): ohne pfad die Wurzeln
   * (App-Ordner, falls name, und alle Freigaben), sonst die Unterordner – nur im App-Ordner und unter den Freigaben.
   */
  reg.aktion('apps.ordner', {
    rolle: 'admin', lesend: true, beschreibung: 'Ordner für die Ordnerwahl (App-Ordner und Freigaben)',
    schema: { name: { typ: 'string', max: 31, muster: NAME_APP, hinweis: 'Ungültiger App-Name' }, pfad: { typ: 'string', max: 4096, standard: '' } },
    ausfuehren: async (p) => {
      const appOrdner = p.name ? appPfade(w, p.name).ordner : null;
      const shares = pf.shares.replace(/\/+$/, '');
      const freigaben = ((await w.konfig.laden('shares.json', { freigaben: [] }))?.freigaben || []).map((f) => f.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
      if (!p.pfad) {
        const wurzeln = [];
        if (appOrdner && await existiert(appOrdner)) wurzeln.push({ name: `App-Ordner (${p.name})`, pfad: appOrdner, art: 'app' });
        for (const f of freigaben) wurzeln.push({ name: f, pfad: `${shares}/${f}`, art: 'freigabe' });
        return { pfad: '', eltern: null, ordner: wurzeln };
      }
      const abs = path.posix.normalize(p.pfad);
      const imApp = appOrdner && (abs === appOrdner || abs.startsWith(appOrdner + '/'));
      const freigabeWurzel = freigaben.map((f) => `${shares}/${f}`).find((r) => abs === r || abs.startsWith(r + '/'));
      if (!imApp && !freigabeWurzel) throw new FahnasFehler('E_RECHTE', 'Ordner sind nur im App-Ordner und in den Freigaben wählbar', { feld: 'pfad' });
      let eintraege;
      try { eintraege = await fs.readdir(abs, { withFileTypes: true }); } catch { throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Ordner gibt es nicht (mehr)', { feld: 'pfad' }); }
      const ordner = eintraege.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@') && !e.name.startsWith('#'))
        .map((e) => ({ name: e.name, pfad: `${abs}/${e.name}` })).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      const wurzel = imApp ? appOrdner : freigabeWurzel;
      return { pfad: abs, eltern: abs === wurzel ? '' : path.posix.dirname(abs), ordner };
    },
  });

  /**
   * Grafikkarte im Editor (Ausbau Oktober 2026): neu gewählte GPU muss es geben – sonst startet die App nicht. Liefert die
   * Gruppen-IDs (render/video) und ob /dev/kfd (AMD-Rechenkern) da ist, für die Anpassungsdatei.
   */
  async function gpuVoraussetzungen(dienste, aktuell) {
    const vorher = new Map(aktuell.map((d) => [d.name, d.gpu]));
    const neu = dienste.filter((d) => d.gpu && d.gpu !== 'keine' && d.gpu !== vorher.get(d.name)).map((d) => d.gpu);
    if (neu.includes('dri') && !(await existiert('/dev/dri'))) throw new FahnasFehler('E_PARAMS', 'Dieses NAS hat keine Intel-/AMD-Grafik (/dev/dri fehlt)', { feld: 'gpu' });
    if (neu.includes('nvidia')) {
      let laufzeiten = {};
      try { laufzeiten = JSON.parse((await w.system.ausfuehren('docker', ['info', '--format', '{{json .Runtimes}}'])).stdout || '{}') || {}; } catch { /* unten */ }
      if (!Object.prototype.hasOwnProperty.call(laufzeiten, 'nvidia')) throw new FahnasFehler('E_PARAMS', 'NVIDIA ist für Docker noch nicht eingerichtet – unter System → Grafikkarte „NVIDIA einrichten“ wählen', { feld: 'gpu' });
    }
    let gids = {};
    try { gids = gruppenIds(await fs.readFile('/etc/group', 'utf8')); } catch { /* ohne Gruppen */ }
    return { gids, kfd: await existiert('/dev/kfd') };
  }

  const S_DIENSTE = { typ: 'array', pflicht: true, max: 50, elemente: { typ: 'object' } };
  reg.aktion('apps.einstellungen.speichern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Ports, Pfade und Variablen einer App ändern (gilt beim nächsten Start; mit neustart sofort)',
    schema: { name: S_NAME, dienste: S_DIENSTE, autostart: { typ: 'boolean' }, neustart: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const satz = await appHolen(w, p.name);
      const app = appPfadeVon(w, satz);
      aufgabe.fortschritt(0.05, 'Einstellungen werden geprüft');
      const origCfg = await docker.configJson(app, { ohneAnpassung: true });
      const original = einstellungenAusConfig(origCfg, { geheimnisseZeigen: true });
      const aktuell = satz.anpassung ? einstellungenAusConfig(await docker.configJson(app), { geheimnisseZeigen: true }) : original;
      const dienste = anpassungPruefen(p.dienste, { original, aktuell, appOrdner: app.ordner, shares: pf.shares, freigaben: await freigabeNamen(w) });
      const gpuOpt = await gpuVoraussetzungen(dienste, aktuell);
      const ports = portsAusDiensten(dienste);
      const konflikte = await portKonflikte(ports, { name: p.name, eigene: satz.ports || [] });
      if (konflikte.length) throw new FahnasFehler('E_BELEGT', `NAS-Port ${konflikte[0].port}/${konflikte[0].protokoll} ist schon belegt (${konflikte[0].belegt_von})${konflikte[0].vorschlag ? ` – frei wäre z. B. ${konflikte[0].vorschlag}` : ''}`, { feld: 'ports', port_konflikte: konflikte });
      const datei = path.join(app.ordner, ANPASSUNG_DATEI);
      const vorherDatei = await fs.readFile(datei, 'utf8').catch(() => null);
      await fs.writeFile(datei, anpassungYaml(dienste, origCfg, gpuOpt), { mode: 0o600 });
      const appNeu = { ...app, anpassungDatei: datei };
      try { await docker.pruefen(appNeu); } catch (e) {
        if (vorherDatei !== null) await fs.writeFile(datei, vorherDatei, { mode: 0o600 }); else await fs.rm(datei, { force: true });
        throw e;
      }
      const abbildung = portAbbildung(aktuell, dienste);
      const { werte, eingabe } = werteUmschreiben(satz, abbildung);
      const jetzt = new Date().toISOString();
      const neu = {
        ...satz, anpassung: { geaendert: jetzt }, ports, werte, eingabe, webui: webuiUmschreiben(satz.webui, abbildung),
        vorlage: satz.vorlage ? { ...satz.vorlage, webui: webuiUmschreiben(satz.vorlage.webui, abbildung) } : satz.vorlage,
        portkonflikt: null, geaendert: jetzt, autostart: p.autostart === undefined ? satz.autostart : p.autostart,
      };
      const warnungen = [];
      await satzSchreiben(w, neu);
      aufgabe.fortschritt(0.4, 'Firewall wird angepasst');
      await firewallRendern(warnungen);
      let neuGestartet = false;
      const z0 = await zustandVon(appNeu).catch(() => ({ zustand: 'unbekannt' }));
      if (p.neustart && ['running', 'teilweise', 'restarting', 'exited', 'created'].includes(z0.zustand)) {
        aufgabe.fortschritt(0.5, 'App wird mit den neuen Einstellungen gestartet');
        await docker.up(appNeu, { abgebrochen: aufgabe.abgebrochen, fortschritt: (_a, m) => aufgabe.fortschritt(0.8, m) });
        neuGestartet = true;
      }
      docker.leeren(); ereignis();
      const z = await zustandVon(appNeu);
      aufgabe.fortschritt(1, 'Fertig');
      return { name: p.name, neu_gestartet: neuGestartet, zustand: z.zustand, ports, webui: webuiRendern(neu.webui, neu.werte || {}), warnungen };
    }),
  });

  reg.aktion('apps.einstellungen.zuruecksetzen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Alle Anpassungen aus „Bearbeiten“ verwerfen (Original der App)',
    schema: { name: S_NAME, neustart: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const satz = await appHolen(w, p.name);
      const app = appPfadeVon(w, satz);
      const aktuell = satz.anpassung ? einstellungenAusConfig(await docker.configJson(app)) : [];
      await fs.rm(path.join(app.ordner, ANPASSUNG_DATEI), { force: true });
      const appNeu = { ...app, anpassungDatei: null };
      const original = einstellungenAusConfig(await docker.configJson(appNeu));
      const abbildung = portAbbildung(aktuell, original);
      const { werte, eingabe } = werteUmschreiben(satz, abbildung);
      const neu = {
        ...satz, anpassung: null, ports: portsAusDiensten(original), werte, eingabe, webui: webuiUmschreiben(satz.webui, abbildung),
        vorlage: satz.vorlage ? { ...satz.vorlage, webui: webuiUmschreiben(satz.vorlage.webui, abbildung) } : satz.vorlage,
        portkonflikt: null, geaendert: new Date().toISOString(),
      };
      await satzSchreiben(w, neu);
      await firewallRendern([]);
      if (p.neustart) { aufgabe.fortschritt(0.5, 'App wird mit den Original-Einstellungen gestartet'); await docker.up(appNeu, { abgebrochen: aufgabe.abgebrochen }); }
      docker.leeren(); ereignis();
      return { name: p.name, zustand: (await zustandVon(appNeu)).zustand, ports: neu.ports };
    }),
  });

  // ---- Ändern, Aktualisieren, Löschen ----------------------------------------------------------------------------
  reg.aktion('apps.aendern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Einstellungen einer App ändern (neu rendern, Container erneuern) und Autostart setzen',
    schema: { name: S_NAME, werte: { typ: 'object' }, autostart: { typ: 'boolean' }, bestaetigt_riskant: S_BESTAETIGT },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const alt = await appHolen(w, p.name);
      const app = appPfadeVon(w, alt);
      if (alt.art === 'zip' && p.werte !== undefined) throw new FahnasFehler('E_PARAMS', 'ZIP-Apps haben in FAH-NAS keine Einstellungen – die App regelt sie selbst; umschaltbar ist nur der Autostart', { feld: 'werte' });
      const vorlage = await vorlageAuffrischen(alt);
      const warnungen = [];
      if (p.werte === undefined) {
        // nur Autostart
        if (p.autostart === undefined) throw new FahnasFehler('E_PARAMS', 'Nichts zu ändern: werte oder autostart angeben', { feld: 'werte' });
        const satz = { ...alt, autostart: p.autostart, geaendert: new Date().toISOString() };
        await satzSchreiben(w, satz); ereignis();
        return { name: p.name, autostart: satz.autostart, neu_gestartet: false, zustand: (await zustandVon(app)).zustand, warnungen };
      }
      const alteGeheimnisse = await envLesen(app.envDatei);
      const geheimFelder = vorlage.felder.filter((f) => f.art === 'geheimnis').map((f) => f.name);
      const eingabe = { ...(alt.eingabe || {}), ...p.werte };
      const zumRendern = { ...eingabe };
      for (const gname of geheimFelder) if (zumRendern[gname] === undefined || zumRendern[gname] === '') { if (alteGeheimnisse[gname]) zumRendern[gname] = alteGeheimnisse[gname]; }
      const g = rendern(vorlage, zumRendern, { appOrdner: app.ordner, shares: pf.shares, nas: await nasNetz(), freigaben: await freigabeNamen(w) });
      const bestaetigt = risikenBestaetigt(g.risiken, [...(alt.bestaetigt_riskant || []), ...(p.bestaetigt_riskant || [])]);
      const konflikte = await portKonflikte(g.ports, { name: p.name, eigene: alt.ports || [] });
      if (konflikte.length) throw new FahnasFehler('E_BELEGT', `Port ${konflikte[0].port}/${konflikte[0].protokoll} ist schon belegt (${konflikte[0].belegt_von})`, { feld: konflikte[0].feld || 'werte', port_konflikte: konflikte });
      aufgabe.fortschritt(0.1, 'Dateien werden neu geschrieben');
      const alteDateien = { compose: await fs.readFile(app.composeDatei, 'utf8').catch(() => null), env: await fs.readFile(app.envDatei, 'utf8').catch(() => null) };
      await dateienSchreiben(w, app, g);
      try {
        await docker.pruefen(app);
        aufgabe.fortschritt(0.3, 'Container werden erneuert');
        await docker.up(app, { abgebrochen: aufgabe.abgebrochen, fortschritt: (_a, m) => aufgabe.fortschritt(0.6, m) });
      } catch (e) {
        // alte Dateien zurück und alte Container wieder hoch – die App soll nicht kaputt liegen bleiben
        if (alteDateien.compose !== null) { try { await fs.writeFile(app.composeDatei, alteDateien.compose, { mode: 0o640 }); await fs.writeFile(app.envDatei, alteDateien.env || '', { mode: 0o600 }); await docker.up(app); } catch { /* egal */ } }
        throw e;
      }
      docker.leeren();
      const satz = satzBauen({ name: p.name, vorlage, g, eingabe: eingabeOhneGeheimnisse(eingabe, vorlage), autostart: p.autostart === undefined ? alt.autostart : p.autostart, bestaetigt, alt });
      warnungen.push(...g.warnungen);
      await satzSchreiben(w, satz);
      aufgabe.fortschritt(0.9, 'Firewall wird angepasst');
      await firewallRendern(warnungen);
      ereignis();
      const z = await zustandVon(app);
      aufgabe.fortschritt(1, 'Fertig');
      return { name: p.name, autostart: satz.autostart, neu_gestartet: true, zustand: z.zustand, gesundheit: z.gesundheit, ports: satz.ports, webui: webuiRendern(vorlage.webui, g.werte), warnungen };
    }),
  });

  /** daten/ per Reflink sichern (< 5 GB), höchstens SICHERUNGEN_BEHALTEN Stände behalten. */
  async function datenSichern(app, satz, warnungen) {
    if (!(await existiert(app.datenOrdner))) return null;
    let groesse = null;
    try { const r = await w.system.ausfuehren('du', ['-s', '-B1', '--', app.datenOrdner], { erlaubteCodes: [0, 1], zeitlimit_ms: 600_000 }); groesse = Number(String(r.stdout).trim().split(/\s+/)[0]); } catch (e) { warnungen.push(`Größe des Datenordners nicht ermittelbar: ${e.message}`); }
    if (Number.isFinite(groesse) && groesse >= SICHERUNG_MAX_BYTES) { warnungen.push(`Datenordner ist ${Math.round(groesse / 1024 ** 3)} GiB groß – keine automatische Sicherung vor dem Update (Grenze 5 GiB); bitte vorher einen Schnappschuss der Datenpartition anlegen`); return null; }
    const ziel = path.join(app.ordner, `daten.vor-update-${zeitStempel()}`);
    await w.system.ausfuehren('cp', ['--reflink=auto', '-a', '--', app.datenOrdner, ziel], { zeitlimit_ms: 1_800_000 });
    const sicherungen = [...(satz.sicherungen || []), { ordner: ziel, zeit: new Date().toISOString(), groesse }];
    while (sicherungen.length > SICHERUNGEN_BEHALTEN) {
      const weg = sicherungen.shift();
      try { await fs.rm(weg.ordner, { recursive: true, force: true }); } catch (e) { warnungen.push(`Alte Sicherung ${weg.ordner} nicht gelöscht: ${e.message}`); }
    }
    satz.sicherungen = sicherungen;
    return ziel;
  }

  reg.aktion('apps.aktualisieren', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Images neu laden; bei Änderung Container erneuern (vorher daten/ sichern, wenn < 5 GiB)',
    schema: { name: S_NAME },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const satz = { ...(await appHolen(w, p.name)) };
      if (satz.art === 'zip' && !satz.uebernommen) throw new FahnasFehler('E_PARAMS', 'ZIP-Apps werden mit einer neuen ZIP aktualisiert („Neue ZIP einspielen“)', { feld: 'name' });
      const app = appPfadeVon(w, satz);
      if (satz.uebernommen) return uebernommenAktualisieren(satz, app, aufgabe);
      const warnungen = [];
      aufgabe.fortschritt(0.02, 'Aktueller Stand wird ermittelt');
      const images = await docker.images(app);
      const alt = {}; for (const i of images) alt[i] = await docker.digest(i);
      // FAH-App: aktuelle Vorlage (mit Quellcode-Prüfsumme) aus dem Katalog – neu bauen, wenn das Programm neueren Quellcode
      // mitbringt. Auch für Apps von vor 0.2.3 (Satz ohne bauen, Image von Hand gebaut). Geprüft VOR der Datensicherung.
      let bauVorlage = null;
      try { const k = await katalog.eintrag(satz.katalog_id); if (k.bauen && images.includes(k.bauen.image)) bauVorlage = k; } catch { /* Vorlage nicht mehr im Katalog */ }
      if (bauVorlage && !bauVorlage.bauen.kontext) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Der Quellcode für ${bauVorlage.bauen.image} fehlt im Programm (katalog/quellen/${bauVorlage.id}) – bitte FAH-NAS aktualisieren`, { image: bauVorlage.bauen.image });
      if (!bauVorlage) {
        for (const i of images) {
          const kat = await docker.imageLabel(i, 'fahnas.katalog');
          if (kat) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Das Image ${i} wurde aus dem mitgelieferten Quellcode der Vorlage „${kat}“ gebaut, die es im Katalog nicht mehr gibt – es gibt nichts zu aktualisieren`, { image: i });
        }
      }
      aufgabe.fortschritt(0.05, 'Datenordner wird gesichert');
      const sicherung = await datenSichern(app, satz, warnungen);
      if (bauVorlage) {
        aufgabe.fortschritt(0.1, `Image ${bauVorlage.bauen.image} wird geprüft`);
        const gebaut = await imageBauen(bauVorlage, { abgebrochen: aufgabe.abgebrochen, fortschritt: (anteil, meldung) => aufgabe.fortschritt(0.1 + anteil * 0.6, meldung) });
        if (!gebaut) warnungen.push(`${bauVorlage.bauen.image}: schon aus dem Quellcode dieser FAH-NAS-Version gebaut${bauVorlage.bauen.version ? ` (App-Version ${bauVorlage.bauen.version})` : ''}`);
        const fremde = images.filter((i) => i !== bauVorlage.bauen.image);
        if (fremde.length) await docker.pull(app, fremde.map((i) => ({ image: i })), { ignorieren: true, abgebrochen: aufgabe.abgebrochen });
      } else {
        aufgabe.fortschritt(0.1, 'Images werden geladen');
        await docker.pull(app, images.map((i) => ({ image: i })), { abgebrochen: aufgabe.abgebrochen, fortschritt: (anteil, meldung) => aufgabe.fortschritt(0.1 + anteil * 0.7, meldung) });
      }
      const neu = {}; for (const i of images) neu[i] = await docker.digest(i);
      const geaendert = images.filter((i) => alt[i] !== neu[i]);
      let neustart = false;
      if (geaendert.length) {
        aufgabe.fortschritt(0.85, 'Container werden mit den neuen Images erneuert');
        await docker.up(app, { abgebrochen: aufgabe.abgebrochen });
        neustart = true;
        docker.leeren();
      } else warnungen.push('Es gab keine neueren Images – die App läuft unverändert weiter');
      satz.version = { images: neu }; satz.aktualisiert = new Date().toISOString();
      await satzSchreiben(w, satz);
      aufgabe.fortschritt(0.95, 'Alte Image-Versionen werden entfernt');
      const freiBytes = await docker.aufraeumen();
      await updatesAppErledigt(p.name);
      ereignis();
      const z = await zustandVon(app);
      aufgabe.fortschritt(1, 'Fertig');
      return { name: p.name, alt, neu, geaendert, neustart, sicherung, zustand: z.zustand, gesundheit: z.gesundheit, warnungen, frei_bytes: freiBytes, hinweis: sicherung ? `Rückweg: App stoppen, ${app.datenOrdner} durch ${sicherung} ersetzen, App starten` : null };
    }),
  });

  /** Übernommenes Docker-Projekt aktualisieren: Images aus der Registry (lokal gebaute bleiben), bei Änderung erneuern. */
  async function uebernommenAktualisieren(satz, app, aufgabe) {
    const warnungen = [];
    aufgabe.fortschritt(0.05, 'Aktueller Stand wird ermittelt');
    const images = await docker.images(app);
    const alt = {}; for (const i of images) alt[i] = await docker.digest(i);
    aufgabe.fortschritt(0.1, 'Images werden geladen');
    const r = await docker.pull(app, images.map((i) => ({ image: i })), { ignorieren: true, abgebrochen: aufgabe.abgebrochen, fortschritt: (anteil, meldung) => aufgabe.fortschritt(0.1 + anteil * 0.7, meldung) });
    warnungen.push(...r.fehler.map((f) => `Nicht aus einer Registry ladbar (lokal gebaut?): ${f}`));
    const neu = {}; for (const i of images) neu[i] = await docker.digest(i);
    const geaendert = images.filter((i) => alt[i] !== neu[i]);
    if (geaendert.length) { aufgabe.fortschritt(0.85, 'Container werden mit den neuen Images erneuert'); await docker.up(app, { abgebrochen: aufgabe.abgebrochen }); docker.leeren(); } else warnungen.push('Es gab keine neueren Images – die App läuft unverändert weiter');
    const neuSatz = { ...satz, version: { images: neu }, aktualisiert: new Date().toISOString() };
    await satzSchreiben(w, neuSatz);
    const freiBytes = await docker.aufraeumen();
    await updatesAppErledigt(satz.name);
    ereignis();
    const z = await zustandVon(app);
    aufgabe.fortschritt(1, 'Fertig');
    return { name: satz.name, alt, neu, geaendert, neustart: geaendert.length > 0, sicherung: null, zustand: z.zustand, gesundheit: z.gesundheit, warnungen, frei_bytes: freiBytes, hinweis: null };
  }

  reg.aktion('apps.loeschen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'App entfernen – Daten behalten (nach backup/apps-geloescht verschieben) oder löschen',
    schema: { name: S_NAME, daten: { typ: 'string', pflicht: true, werte: ['behalten', 'loeschen'] } },
    ausfuehren: async (p, _k, _w, aufgabe) => mitSperre(p.name, async () => {
      const satz = await appHolen(w, p.name);
      const app = appPfadeVon(w, satz);
      const warnungen = [];
      // Images der App vor dem Entfernen merken – danach löschen, sofern kein anderer Container sie benutzt (kein Datenmüll)
      let images = [];
      if (await existiert(app.composeDatei)) { try { images = await docker.images(app); } catch { /* Compose passt nicht mehr */ } }
      try { images.push(...(await docker.containerAlle()).filter((c) => c.projekt === projektVon(satz)).map((c) => c.image)); } catch { /* Docker meldet sich gleich selbst */ }
      aufgabe.fortschritt(0.1, 'Container werden entfernt');
      let entfernt = false;
      if (await existiert(app.composeDatei)) {
        try { await docker.down(app, { volumes: p.daten === 'loeschen' && !!satz.benannte_volumes }); entfernt = true; } catch (e) {
          if (satz.art !== 'zip') throw e;
          warnungen.push(`docker compose down: ${e.message}`); // ZIP-App: Compose-Datei passt nicht mehr → Container direkt entfernen
        }
      }
      if (!entfernt) {
        // Compose-Datei weg: Container des Projekts direkt entfernen
        try {
          const eigene = (await docker.containerAlle()).filter((c) => c.projekt === projektVon(satz));
          if (eigene.length) await w.system.ausfuehren('docker', ['rm', '-f', ...eigene.map((c) => c.id)]);
        } catch (e) { warnungen.push(`Container nicht entfernt: ${e.message}`); }
      }
      // übernommene Docker-Projekte: frühere anonyme Volumes (extern eingebunden) nimmt „down -v“ nicht mit
      if (p.daten === 'loeschen' && satz.uebernommen) {
        for (const v of satz.uebernommen.volumes_extern || []) { try { await w.system.ausfuehren('docker', ['volume', 'rm', v], { zeitlimit_ms: 120_000 }); } catch (e) { warnungen.push(`Volume ${v} nicht entfernt: ${e.message}`); } }
      }
      docker.leeren();
      let aufbewahrt = null;
      aufgabe.fortschritt(0.6, p.daten === 'behalten' ? 'Daten werden aufbewahrt' : 'Daten werden gelöscht');
      if (await existiert(app.ordner)) {
        if (p.daten === 'behalten') {
          const zielOrdner = path.join(pf.backup, 'apps-geloescht');
          await fs.mkdir(zielOrdner, { recursive: true, mode: 0o750 });
          aufbewahrt = path.join(zielOrdner, `${p.name}-${zeitStempel()}`);
          await w.system.ausfuehren('mv', ['--', app.ordner, aufbewahrt]);
        } else await fs.rm(app.ordner, { recursive: true, force: true });
      }
      await satzEntfernen(w, p.name);
      aufgabe.fortschritt(0.85, 'Firewall wird angepasst');
      await firewallRendern(warnungen);
      aufgabe.fortschritt(0.9, 'Images werden entfernt');
      const weg = await docker.imagesEntfernen(images);
      const freiBytes = weg.bytes + await docker.aufraeumen();
      ereignis();
      aufgabe.fortschritt(1, 'Fertig');
      return { name: p.name, daten: p.daten, aufbewahrt, warnungen, images_entfernt: weg.entfernt, frei_bytes: freiBytes };
    }),
  });

  // ---- Docker-Übernahme vom alten NAS (Umstieg, Betreiber 19.10.2026) -------------------------------------------------
  // Die alte Docker-Ablage (<volume>/@docker) wird nur gelesen. Übernommen werden Compose-Projekte: Compose-Dateien und
  // Arbeitsordner bleiben, wo sie sind (über den alten Pfad /volumeN erreichbar), Volumes werden kopiert.
  async function alteAblagen() {
    const d = (await w.konfig.laden('importe.json', null)) || {};
    const aus = [];
    for (const v of Array.isArray(d.volumes) ? d.volumes : []) {
      const vp = volumePfad(w, v.uuid);
      if (!(await gemountet(w.system, vp))) continue;
      const ablage = await ablageFinden(vp);
      if (ablage) aus.push({ volume: v.uuid, bezeichnung: v.bezeichnung || v.uuid, ablage, besitz: v.besitz || {} });
    }
    return aus;
  }
  /** Pfad des alten Systems (/volumeN/…) → Pfad unter FAH-NAS (über den eingehängten alten Pfad). */
  function pfadJetzt(p) { const m = /^(\/volume\d{1,2})(\/.*)?$/.exec(String(p || '')); return m ? path.join(alterPfadZiel(w, m[1]), m[2] || '') : p; }
  async function projektPruefen(pr) {
    const fehlt = [];
    for (const a of pr.alte_pfade) if (!(await gemountet(w.system, alterPfadZiel(w, a)))) fehlt.push(a);
    let da = pr.dateien.length > 0;
    for (const d of pr.dateien) if (!(await existiert(pfadJetzt(d)))) da = false;
    return { fehlende_pfade: fehlt, dateien_da: da };
  }
  function appNameVorschlag(projekt, belegt) {
    let b = String(projekt).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
    if (b.length < 2) b = `app-${b}`.slice(0, 31);
    let n = b; let i = 2;
    while (belegt.has(n)) { const s = `-${i++}`; n = b.slice(0, 31 - s.length) + s; }
    return n;
  }
  async function groesseVon(pfad) {
    try { const r = await w.system.ausfuehren('du', ['-s', '-x', '-B1', pfad], { zeitlimit_ms: 120_000 }); const n = Number(String(r.stdout).trim().split(/\s+/)[0]); return Number.isFinite(n) ? n : null; } catch { return null; }
  }
  /** Wo Docker seine Daten ablegt und wie viel dort frei ist. → {pfad, frei, gesamt} | null */
  async function dockerPlatz() {
    try {
      const pfad = String((await w.system.ausfuehren('docker', ['info', '--format', '{{.DockerRootDir}}'], { zeitlimit_ms: 20_000 })).stdout).trim() || '/var/lib/docker';
      const t = String((await w.system.ausfuehren('df', ['-B1', '--output=size,avail', pfad], { zeitlimit_ms: 10_000 })).stdout).trim().split('\n').pop().trim().split(/\s+/);
      return { pfad, gesamt: Number(t[0]), frei: Number(t[1]) };
    } catch { return null; }
  }
  async function volumeMount(name) {
    try { return String((await w.system.ausfuehren('docker', ['volume', 'inspect', '--format', '{{.Mountpoint}}', name], { zeitlimit_ms: 30_000 })).stdout).trim() || null; } catch { return null; }
  }

  reg.aktion('apps.uebernahme.suchen', {
    rolle: 'admin', aufgabe: true, schema: {}, beschreibung: 'Docker-Ablage des alten NAS auf übernommenen Volumes lesen (ändert nichts)',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      const ablagen = await alteAblagen();
      const apps = await alleApps(w);
      const belegt = new Set(apps.map((x) => x.name));
      const schon = new Map(apps.filter((x) => x.uebernommen).map((x) => [x.projekt, x.name]));
      let laufend = []; try { laufend = await docker.containerAlle(); } catch { /* Docker aus */ }
      const aus = [];
      for (const [i, a] of ablagen.entries()) {
        aufgabe?.fortschritt(0.05 + (0.9 * i) / ablagen.length, `${a.bezeichnung}: Container lesen`);
        const { projekte, einzeln } = projekteBilden(await containerLesen(a.ablage));
        for (const pr of projekte) {
          Object.assign(pr, await projektPruefen(pr));
          pr.schon_uebernommen = schon.get(pr.projekt) || null;
          pr.laeuft_hier = !pr.schon_uebernommen && laufend.some((c) => c.projekt === pr.projekt);
          pr.name_vorschlag = pr.schon_uebernommen || appNameVorschlag(pr.projekt, belegt);
          belegt.add(pr.name_vorschlag);
          pr.hinweise = kontenHinweise(pr.konten, a.besitz);
          for (const v of pr.volumes) v.groesse = await groesseVon(path.join(a.ablage, 'volumes', v.name, '_data'));
          delete pr.container;
        }
        aus.push({ volume: a.volume, bezeichnung: a.bezeichnung, ablage: a.ablage, projekte, einzeln });
      }
      aufgabe?.fortschritt(1, 'fertig');
      const orte = orteNormieren(await w.konfig.laden('speicherorte.json', null));
      return { ablagen: aus, docker_platz: await dockerPlatz(), docker_auf_volume: !!orte.docker };
    },
  });

  /** Ein Projekt übernehmen: Volumes kopieren, Zusatzdatei für frühere anonyme Volumes, App-Satz, starten. */
  async function projektUebernehmen(a, pr, wahl, melde, aufgabe) {
    if (!pr) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Projekt „${wahl.projekt}“ gibt es in der alten Ablage nicht`);
    if (!pr.dateien.length) throw new FahnasFehler('E_PARAMS', 'Keine Compose-Datei bekannt – dieses Projekt lässt sich nicht übernehmen');
    const pruef = await projektPruefen(pr);
    if (pruef.fehlende_pfade.length) throw new FahnasFehler('E_BELEGT', `Erst den alten Pfad ${pruef.fehlende_pfade.join(', ')} einschalten (Speicher übernehmen → alter Pfad)`);
    if (!pruef.dateien_da) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Compose-Datei fehlt: ${pr.dateien.join(', ')}`);
    const apps = await alleApps(w);
    if (apps.some((x) => x.name === wahl.name)) throw new FahnasFehler('E_EXISTIERT', `Eine App „${wahl.name}“ gibt es schon`, { feld: 'name' });
    if (apps.some((x) => x.uebernommen && x.projekt === pr.projekt)) throw new FahnasFehler('E_EXISTIERT', `Das Projekt „${pr.projekt}“ ist schon übernommen`);
    if ((await docker.containerAlle()).some((c) => c.projekt === pr.projekt)) throw new FahnasFehler('E_BELEGT', `Ein Compose-Projekt „${pr.projekt}“ läuft hier schon`);
    const leer = new Set(wahl.leer || []);
    // genug Platz im Docker-Speicher? (UGREEN: 128-GB-Systemplatte – erst Docker umziehen)
    let noetig = 0;
    for (const v of pr.volumes.filter((x) => !leer.has(x.name) && (!x.treiber || x.treiber === 'local'))) noetig += (await groesseVon(path.join(a.ablage, 'volumes', v.name, '_data'))) || 0;
    const platz = await dockerPlatz();
    if (platz && Number.isFinite(platz.frei) && platz.frei < noetig * 1.05 + 1024 ** 3) {
      throw new FahnasFehler('E_PLATZ', `Zu wenig Platz im Docker-Speicher (${Math.round(platz.frei / 1e9)} GB frei, die Volumes brauchen ${Math.round(noetig / 1e9)} GB) – erst unter Laufwerke → Speicherorte Docker auf ein größeres Volume umziehen`);
    }
    const app = appPfade(w, wahl.name);
    await fs.mkdir(app.ordner, { recursive: true, mode: 0o750 });
    const kopiert = []; const extern = []; const zusatz = []; const hinweise = [];
    for (const [j, v] of pr.volumes.entries()) {
      if (v.treiber && v.treiber !== 'local') { hinweise.push(`Volume ${v.name}: Treiber „${v.treiber}“ – nicht kopiert`); continue; }
      if (leer.has(v.name)) { hinweise.push(`Volume ${v.name}: bleibt leer (so gewählt)`); continue; }
      const neu = neuerVolumeName(pr.projekt, v);
      const quelle = path.join(a.ablage, 'volumes', v.name, '_data');
      if (!(await existiert(quelle))) { hinweise.push(`Volume ${v.name}: keine Daten in der alten Ablage`); continue; }
      melde(`Volume ${neu} wird kopiert`, 0.05 + (0.6 * j) / Math.max(1, pr.volumes.length));
      let ziel = await volumeMount(neu);
      const merken = () => { if (v.anonym) { extern.push(neu); zusatz.push(...v.dienste.filter((d) => d.dienst).map((d) => ({ dienst: d.dienst, ziel: d.ziel, name: neu }))); } };
      if (ziel && (await fs.readdir(ziel).catch(() => [])).length) { hinweise.push(`Volume ${neu} gab es hier schon mit Daten – nicht überschrieben`); merken(); continue; }
      if (!ziel) {
        const labels = v.anonym ? {} : volumeLabels(pr.projekt, neu);
        await w.system.ausfuehren('docker', ['volume', 'create', ...Object.entries(labels).flatMap(([k, x]) => ['--label', `${k}=${x}`]), neu], { zeitlimit_ms: 30_000 });
        ziel = await volumeMount(neu);
        if (!ziel) throw new FahnasFehler('E_SYSTEM', `Volume ${neu} ließ sich nicht anlegen`);
      }
      // Besitzer als Zahlen, Hardlinks, ACLs und erweiterte Attribute bleiben (Datenbanken prüfen ihren Besitzer)
      await w.system.ausfuehren('rsync', ['-aHAX', '--numeric-ids', `${quelle}/`, `${ziel}/`], { zeitlimit_ms: 12 * 3600_000 });
      kopiert.push(neu); merken();
    }
    const dateien = pr.dateien.map(pfadJetzt);
    const yaml = uebernahmeYaml(zusatz);
    if (yaml) { const z = path.join(app.ordner, UEBERNAHME_DATEI); await fs.writeFile(z, yaml, { mode: 0o640 }); dateien.push(z); }
    const jetzt = new Date().toISOString();
    const titel = pr.projekt.slice(0, 60);
    const satz = {
      name: wahl.name, art: 'zip', katalog_id: 'uebernommen', titel, symbol: '', kategorie: 'Übernommen', webui: '',
      vorlage: { id: 'uebernommen', name: titel, quelle: 'uebernommen', beschreibung: '', kategorie: 'Übernommen', symbol: '', webui: '', compose: '', felder: [], hinweise: [] },
      eingabe: {}, werte: {}, geheimnisse: [], ports: [], dienste: pr.dienste.map((d) => ({ name: d, image: '' })), binds: [], benannte_volumes: true,
      risiken: [], bestaetigt_riskant: [], warnungen: [...pr.warnungen, ...hinweise],
      autostart: wahl.autostart !== undefined ? !!wahl.autostart : pr.autostart, installiert: jetzt, geaendert: jetzt, aktualisiert: jetzt, version: { images: {} }, sicherungen: [],
      projekt: pr.projekt, compose_dateien: dateien, projekt_ordner: pfadJetzt(pr.ordner || path.dirname(pr.dateien[0])), portkonflikt: null,
      uebernommen: { volume: a.volume, quelle: a.bezeichnung, ordner: pr.ordner, alte_pfade: pr.alte_pfade, datum: jetzt, volumes: kopiert, volumes_extern: extern },
    };
    await satzSchreiben(w, satz);
    melde('Images laden und starten', 0.7);
    let startFehler = null;
    if (satz.autostart) {
      try { await docker.up(appPfadeVon(w, satz), { abgebrochen: aufgabe.abgebrochen, fortschritt: (_x, m) => { if (m) melde(m, 0.85); } }); } catch (e) { startFehler = FahnasFehler.aus(e).message; }
    }
    try {
      const stand = await zipStandLesen({ ordner: satz.projekt_ordner }, []);
      Object.assign(satz, { ports: stand.ports, dienste: stand.dienste, webui: stand.webui });
      satz.warnungen.push(...(await portUeberschneidungen(wahl.name, stand.ports)));
      await satzSchreiben(w, satz);
    } catch { /* nichts gestartet – Ports kommen beim ersten Start */ }
    return { name: wahl.name, projekt: pr.projekt, kopiert, extern, hinweise: [...hinweise, ...kontenHinweise(pr.konten, a.besitz)], warnungen: pr.warnungen, gestartet: satz.autostart && !startFehler, start_fehler: startFehler };
  }

  reg.aktion('apps.uebernahme.starten', {
    rolle: 'admin', aufgabe: true,
    schema: {
      volume: { typ: 'string', pflicht: true, max: 64 },
      projekte: { typ: 'array', pflicht: true, max: 100, elemente: { typ: 'object', felder: {
        projekt: { typ: 'string', pflicht: true, max: 128 }, name: S_NAME, autostart: { typ: 'boolean' },
        leer: { typ: 'array', max: 200, elemente: { typ: 'string', max: 255 } },
      } } },
    },
    beschreibung: 'Gewählte Docker-Projekte des alten NAS übernehmen: Volumes kopieren, als App eintragen und starten (die alte Ablage bleibt unverändert)',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const a = (await alteAblagen()).find((x) => x.volume === p.volume);
      if (!a) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Auf diesem Volume ist keine Docker-Ablage (mehr) eingehängt', { feld: 'volume' });
      if (!(await docker.verfuegbar())) throw new FahnasFehler('E_SYSTEM', 'Docker läuft nicht');
      await paketeSicherstellen(w.system, ['rsync'], { zweck: 'die Docker-Übernahme' }).catch(() => {});
      const { projekte } = projekteBilden(await containerLesen(a.ablage));
      const uebernommen = []; const fehler = [];
      for (const [i, wahl] of p.projekte.entries()) {
        const anteil = 1 / p.projekte.length;
        try {
          uebernommen.push(await mitSperre(wahl.name, () => projektUebernehmen(a, projekte.find((x) => x.projekt === wahl.projekt), wahl,
            (t, f = 0) => aufgabe.fortschritt(i * anteil + anteil * f, `${wahl.projekt}: ${t}`), aufgabe)));
        } catch (e) { fehler.push({ projekt: wahl.projekt, name: wahl.name, meldung: FahnasFehler.aus(e).message }); }
      }
      const warnungen = [];
      await firewallRendern(warnungen);
      docker.leeren(); ereignis();
      aufgabe.fortschritt(1, 'Fertig');
      return { uebernommen, fehler, warnungen };
    },
  });

  // ---- Protokoll, Ports, apply ----------------------------------------------------------------------------------
  reg.aktion('apps.protokoll', {
    rolle: 'admin', beschreibung: 'Letzte Protokollzeilen der App (kein Live-Strom)',
    schema: { name: S_NAME, zeilen: { typ: 'integer', min: 1, max: 5000, standard: 200 }, dienst: { typ: 'string', max: 64, muster: /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, hinweis: 'Dienstname ungültig' }, installation: { typ: 'boolean', standard: false } },
    ausfuehren: async (p) => {
      const a = await appHolen(w, p.name);
      if (p.dienst && !(a.dienste || []).some((d) => d.name === p.dienst)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die App hat keinen Dienst „${p.dienst}“`, { feld: 'dienst' });
      const pfade = appPfadeVon(w, a);
      const dienste = (a.dienste || []).map((d) => d.name);
      // Ausgabe der manage.sh: Container-Protokolle enthalten sie nicht, dabei meldet sie dort z. B. Adresse und Einrichtungscode
      const logDatei = path.join(pfade.ordner, PROTOKOLL_DATEI);
      const installationVorhanden = await fs.access(logDatei).then(() => true, () => false);
      if (p.installation) {
        if (!installationVorhanden) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Zu dieser App gibt es keine Ausgabe der Installation');
        const zeilen = (await fs.readFile(logDatei, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-p.zeilen);
        return { name: p.name, dienst: null, installation: true, installation_vorhanden: true, zeilen, dienste };
      }
      const zeilen = await docker.logs(pfade, { zeilen: p.zeilen, dienst: p.dienst });
      return { name: p.name, dienst: p.dienst || null, installation_vorhanden: installationVorhanden, zeilen, dienste };
    },
  });

  reg.aktion('apps.ports', {
    rolle: 'system', schema: {}, beschreibung: 'Veröffentlichte Host-Ports aller Apps (für die Firewall)',
    ausfuehren: async () => (await alleApps(w)).flatMap((a) => (a.ports || []).map((p) => ({ port: p.port, protokoll: p.protokoll, app: a.name }))),
  });

  /**
   * Vorlagen-Kopie eines Satzes mit dem aktuellen Katalog auffrischen – nur die Angaben, die Ports/Firewall und das Bauen
   * steuern: host_ports, protokoll/adresse_feld gleichnamiger Port-Felder, bauen (Compose und Felder bleiben die des Satzes).
   * Ohne Katalogeintrag (Vorlage entfernt) bleibt die Kopie, wie sie ist.
   */
  async function vorlageAuffrischen(satz) {
    const alt = satz.vorlage || {};
    let k = null;
    try { k = await katalog.eintrag(satz.katalog_id); } catch { return alt; }
    if (!k || k.id !== alt.id) return alt;
    const namen = new Set((alt.felder || []).map((f) => f.name));
    const felder = (alt.felder || []).map((f) => {
      const kf = f.art === 'port' ? k.felder.find((x) => x.name === f.name && x.art === 'port') : null;
      if (!kf) return f;
      const neu = { ...f, protokoll: kf.protokoll || 'tcp' };
      if (kf.adresse_feld && namen.has(kf.adresse_feld)) neu.adresse_feld = kf.adresse_feld; else delete neu.adresse_feld;
      return neu;
    });
    const aus = { ...alt, felder };
    // eingebaute Vorlagen (FAH-Apps): Compose, Öffnen-Link und neue Felder aus dem Katalog – sonst bekäme eine installierte
    // App neue Ports einer Vorlage nie (FAH-Proxy, 0.6.17: Ports 80/443 im Haus). Greift beim nächsten „Einstellungen ändern“.
    if (k.quelle === 'eingebaut' && typeof k.compose === 'string') {
      aus.compose = k.compose;
      if (k.webui !== undefined) aus.webui = k.webui;
      for (const f of k.felder || []) if (!namen.has(f.name)) aus.felder.push(structuredClone(f));
    }
    if (k.host_ports) aus.host_ports = k.host_ports; else delete aus.host_ports;
    if (k.bauen) aus.bauen = { dienst: k.bauen.dienst, image: k.bauen.image }; else delete aus.bauen;
    return aus;
  }

  /**
   * Apps im Host-Netz, die vor 0.2.3 installiert wurden, haben keine Ports im Satz – die Firewall (policy drop) sperrte
   * sie aus. Ports aus Vorlage (aktueller Katalog, sonst Kopie im Satz) und Werten nachtragen; system.apply rendert
   * danach die Firewall aus den Sätzen.
   */
  async function hostPortsNachtragen(a, aus) {
    const v = await vorlageAuffrischen(a);
    const frisch = hostPorts(v, a.werte || {}).map((p) => ({ port: p.port, protokoll: p.protokoll, dienst: p.dienst, ziel: null, feld: p.feld || null, ...(p.adresse ? { adresse: p.adresse } : {}) }));
    const gleich = (x, p) => x.port === p.port && x.protokoll === p.protokoll;
    const alt = a.ports || [];
    const ports = [...alt.filter((x) => !frisch.some((p) => gleich(x, p))), ...frisch];
    const neu = frisch.filter((p) => !alt.some((x) => gleich(x, p)));
    if (JSON.stringify(ports) === JSON.stringify(alt) && JSON.stringify(v) === JSON.stringify(a.vorlage || {})) return;
    a.ports = ports; a.vorlage = v;
    await satzSchreiben(w, a);
    if (neu.length) aus.warnungen.push(`App ${a.name}: Host-Netz-Ports ${neu.map((p) => `${p.port}/${p.protokoll}`).join(', ')} in der Firewall freigegeben`);
  }

  reg.aktion('apps.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Fehlende App-Dateien aus dem Spiegel neu rendern, Apps mit Autostart starten',
    ausfuehren: async () => {
      const apps = await alleApps(w);
      const aus = { apps: apps.length, gerendert: [], gestartet: [], fehler: [], warnungen: [] };
      if (!apps.length) return aus;
      // App-Ordner auf einem übernommenen Volume, das gerade fehlt: nichts auf die Systemplatte darunter schreiben
      const orte = orteNormieren(await w.konfig.laden('speicherorte.json', null));
      const P = { ...PFADE, ...(w.pfade || {}), apps: pf.apps };
      if (orte.apps && !(await zeigtAuf(ortZiel(P, 'apps'), volumeOrt(P, orte.apps.volume, 'apps')))) {
        aus.warnungen.push('Der Speicherort der Apps (übernommenes Volume) ist nicht eingehängt – Apps werden nicht gestartet');
        return aus;
      }
      let neuGebaut = false;
      const dockerDa = await docker.verfuegbar();
      if (!dockerDa) aus.warnungen.push('Docker ist nicht erreichbar – Apps werden nicht gestartet');
      for (const a of apps) {
        const app = appPfadeVon(w, a);
        try {
          if (a.art === 'zip') {
            // ZIP-App: Dateien gehören der manage.sh – nichts rendern, nur starten
            if (a.autostart && dockerDa) { await docker.up(app); aus.gestartet.push(a.name); }
            continue;
          }
          await hostPortsNachtragen(a, aus);
          if (!(await existiert(app.composeDatei)) || !(await existiert(app.envDatei))) {
            const alteGeheimnisse = await envLesen(app.envDatei);
            const eingabe = { ...(a.eingabe || {}) };
            for (const gname of a.geheimnisse || []) { if (alteGeheimnisse[gname]) eingabe[gname] = alteGeheimnisse[gname]; else if (!(a.vorlage.felder.find((f) => f.name === gname) || {}).pflicht) eingabe[gname] = ''; else { eingabe[gname] = 'BITTE-NEU-SETZEN'; aus.warnungen.push(`App ${a.name}: Geheimnis ${gname} fehlt (.env verloren) – bitte in den Einstellungen neu setzen`); } }
            const g = rendern(a.vorlage, eingabe, { appOrdner: app.ordner, shares: pf.shares, nas: await nasNetz(), freigaben: await freigabeNamen(w) });
            await dateienSchreiben(w, app, g);
            aus.gerendert.push(a.name);
          }
          if (a.autostart && dockerDa) {
            if (await fehlendesImageBauen(a)) { aus.warnungen.push(`App ${a.name}: Image ${a.vorlage.bauen.image} aus dem Quellcode neu gebaut`); neuGebaut = true; }
            await docker.up(app); aus.gestartet.push(a.name);
          }
        } catch (e) {
          const f = FahnasFehler.aus(e);
          aus.fehler.push({ name: a.name, code: f.code, meldung: f.message });
          process.stderr.write(`[apps] apply ${a.name}: ${f.message}\n`);
        }
      }
      if (neuGebaut) await docker.aufraeumen(); // die alte Fassung des neu gebauten Images ist jetzt unbenannt
      docker.leeren();
      return aus;
    },
  });
}
