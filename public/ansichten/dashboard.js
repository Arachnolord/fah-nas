// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dashboard: CPU, RAM, Platten, Netz, Temperatur (aus dem Ringpuffer + SSE „messwerte“), System, Dienste,
// letzte Ereignisse (admin), laufende Aufgaben, Kacheln „Apps“ (apps.liste) und „Laufwerke“ (laufwerke.liste) mit
// echten Zahlen (Teil B2), Platz für VMs, Weltkarte der Verbindungen (admin, netz.verbindungen, §13). Kurven ohne
// Bibliothek auf Canvas; die Karte kommt aus ./weltkarte.js und wird erst für Admins nachgeladen.

import { el, t, symbol, format, gebiet } from '../app.js';
import { agentText } from '../agent-text.js';
import { aktuelleDarstellung, gleicheTapete, tapeteUrl, wirksamerZoom } from '../darstellung.js';
import { abmeldenKurz, abmeldenText } from '../abmelden.js';
import { alleLaden as tapetenLaden, vorschauAdresse, nachbar as tapetenNachbar, auswahlForm, darstellungAendern } from '../tapeten.js';
import { appHost, webuiAufloesen } from './apps.js';
import { linkAdresse } from '../links.js';
import { chatVerbindung } from '../chat/verbindung.js';
import { erweiterungenBauen } from '../chat/erweiterungen.js';
import '../chat/anruf-erweiterungen.js'; // laufende Anrufe auf der Chat-Kachel (Plan 03)
import { avatarKnoten } from '../avatar.js';
import * as favoriten from '../favoriten.js';
import { regelnKurz } from '../ordnerrechte.js';
import { standardGroesse, layoutAufloesen, layoutSpeicherform, zellenNachZiehen, kachelSetzen, lesereihenfolge, unterkante, SPALTEN, ZEILE_PX } from './dashboard-raster.js';

const MAX_PUNKTE = 600;          // 10 Minuten bei 1 Messwert je Sekunde
const WARNUNG_AB = 85;           // Prozent Plattenbelegung
const GEFAHR_AB = 95;
const TEMP_WARM = 70;
const TEMP_HEISS = 85;
const AUFGABE_ENDE = new Set(['fertig', 'fehler', 'abgebrochen']);

let ctx = null;
let wurzel = null;
let laufNummer = 0;
let statusTimer = null;
let aufraeumTimer = null;
let beobachter = null;
let status = null;
let letzterMesswert = null;
const reihen = { cpu: [], ram: [], rx: [], tx: [], temp: [] };
const knoten = {};
const aufgaben = new Map();
let appsStand = null;        // {gesamt, laufend, gestoppt, fehlerhaft} | null (noch nicht geladen) | 'fehler'
let laufwerkeStand = null;   // {gesamt, extern, eingehaengt} | null | 'fehler'
let externStand = null;      // [{id, titel, gesamt, frei, belegt, prozent}] je eingehängtem externem Laufwerk | null
const VPN_GESAMT_TEXT = Object.freeze({ ok: 'system.vpn_gesamt_ok', warnung: 'system.vpn_gesamt_warnung', fehler: 'system.vpn_gesamt_fehler' });
let vmStand = null;        // VMs: vms.liste | null | 'fehler' (nur admin)
let raidStand = null;      // Speicherverbünde: raid.liste | null | 'fehler' (nur admin)
let wartungStand = null;   // Wartung: wartung.lesen | null | 'fehler' (nur admin)
let protoStand = null;     // Protokolle: protokolle.lesen | null | 'fehler' (nur admin)
let energieStand = null;   // Energie: energie.status | null | 'fehler' (nur admin)
let gpuStand = null;       // Grafikkarte: gpu.lesen | null | 'fehler' (nur admin)
let tapetenStand = null;   // Tapete: {liste, ordnerFehler, ordnerSchluessel} | null (alle Nutzer)
let vpnStand = null;       // VPN: {aktiv, laeuft, geraete, test} aus vpn.status + vpn.lesen | null | 'fehler' (nur admin)
let meldungenStand = null;  // letzte Benachrichtigungen (benachrichtigungen.verlauf) | null | 'fehler' (nur admin)
let roh = {};               // Rohdaten für „Handlungsbedarf“ (Listen mit Namen): apps, laufwerke, spiegelung, vms, raid, vpn, proto, energie, hinweise
let hinweiseZeit = 0;
let quittiert = {};          // Handlungsbedarf „Verstanden“: {id: {text, bis?}} je Nutzer (nutzer.einstellungen, Bereich „handlungsbedarf“)
const HB_BEREICH = 'handlungsbedarf';
const HB_FEHLER_RUHE_MS = 24 * 60 * 60 * 1000;
let spiegelStand = null;     // {gesamt, fehler, laeuft, zeilen:[…]} aus spiegelung.liste | null | 'fehler' (nur admin)
let freigabenStand = null;   // freigaben.liste (nur die für den Nutzer sichtbaren) | null | 'fehler'
let snapStand = null;        // snapshots.uebersicht | null | 'fehler' (nur admin)
let verbStand = null;        // {agent: system.verbindungen, web: /api/sitzungen} | null | 'fehler' (nur admin)
let chatUebersicht = null;   // chat.uebersicht {raeume} | null | 'fehler'
let officeStand = null;      // {liste: office.liste, faellig: office.faellig} | null | 'fehler'
let chatAb = null; let chatTimer = null; // Hörer auf Chat-Ereignisse (entprellt neu laden)
let linksStand = null;       // {links, orte} aus /api/links (eigene Links, Admin: alle) | null | 'fehler'
let schutzStand = null;      // Anmeldeschutz: /api/anmeldeschutz | null | 'fehler' (nur admin)
let ordnerrechteStand = null; // Ordnerrechte: freigaben.ordnerrechte.liste | null | 'fehler' (nur admin)
let fahgitStand = null;       // Apps aus FAH-Git: apps.fahgit.stand {verbunden, apps[]} | null | 'fehler' (nur admin)
let gehaeuseStand = null;     // Gehäuse (UGREEN): hardware.status | null | 'fehler' (nur admin)
let importeStand = null;      // Übernommener Speicher: importe.liste | null | 'fehler' (nur admin)
let orteStand = null;         // Speicherorte Docker/Apps/VMs: speicherorte.liste | null | 'fehler' (nur admin)
let dockerStand = null;      // apps.docker_speicher | null | 'fehler' (nur admin)
let updatesStand = null;     // apps.updates | null | 'fehler' (nur admin)
let dockerAufgabe = null;    // Aufgaben-ID des laufenden „Aufräumen“
let uhrTimer = null;
let zuletztGeladen = {};     // Kachel → Zeitpunkt der letzten Abfrage (seltene Kacheln höchstens alle 2 min)
const SELTEN_MS = 120_000;
const WEB_AKTIV_MS = 15 * 60_000; // Web-Sitzung zählt als verbunden, wenn sie in den letzten 15 min etwas tat

// ---------------------------------------------------------------------------------------------------------------------
// Apps und Laufwerke: Zusammenfassungen aus apps.liste / laufwerke.liste (Formen aus §11/§12, tolerant gelesen)
// ---------------------------------------------------------------------------------------------------------------------

function listeVon(r, ...schluessel) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') for (const k of [...schluessel, 'eintraege', 'liste']) if (Array.isArray(r[k])) return r[k];
  return [];
}

/** Stufe einer App: fehler (dead/fehler/unhealthy/restarting), laeuft (running) oder sonst gestoppt. */
function appStufe(a) {
  const z = String(a.zustand || '').toLowerCase(); const g = String(a.gesundheit || '').toLowerCase();
  if (['dead', 'fehler', 'error', 'failed', 'restarting'].includes(z) || (g === 'unhealthy' && ['running', 'laeuft', 'aktiv'].includes(z))) return 'fehler';
  if (['running', 'laeuft', 'aktiv', 'up'].includes(z)) return 'laeuft';
  return 'gestoppt';
}

/** Zählt Apps nach Zustand: laufend (running), fehlerhaft (dead/fehler/unhealthy/restarting), sonst gestoppt. */
export function appsZusammenfassung(liste) {
  const apps = listeVon(liste, 'apps').filter((a) => a && typeof a === 'object');
  const aus = { gesamt: apps.length, laufend: 0, gestoppt: 0, fehlerhaft: 0, portkonflikt: 0 };
  for (const a of apps) {
    if (a.portkonflikt) aus.portkonflikt++; // App konnte wegen eines belegten Ports nicht starten (Hinweis + Link in den Editor)
    const st = appStufe(a);
    if (st === 'fehler') aus.fehlerhaft++; else if (st === 'laeuft') aus.laufend++; else aus.gestoppt++;
  }
  return aus;
}

/** Je App eine Zeile {name, titel, stufe} für die Kachel (Betreiber 15.10.2026): Fehler zuerst, dann laufende, dann gestoppte, je nach Titel. */
export function appsZeilen(liste) {
  const rang = { fehler: 0, laeuft: 1, gestoppt: 2 };
  return listeVon(liste, 'apps').filter((a) => a && typeof a === 'object')
    .map((a) => ({ name: String(a.name || ''), titel: String(a.titel || a.name || ''), stufe: appStufe(a), portkonflikt: !!a.portkonflikt, symbol: typeof a.symbol === 'string' ? a.symbol : '', webui: typeof a.webui === 'string' ? a.webui : '', update: !!a.update }))
    .sort((x, y) => rang[x.stufe] - rang[y.stufe] || x.titel.localeCompare(y.titel, 'de'));
}

/**
 * Spiegelungen zusammenfassen (spiegelung.liste, §14): Anzahl, wie viele zuletzt fehlschlugen, wie viele gerade laufen,
 * je Spiegelung eine Zeile {id, name, aktiv, laeuft, fortschritt, ergebnis, zeit}.
 */
export function spiegelungZusammenfassung(r) {
  const liste = listeVon(r, 'auftraege').filter((a) => a && typeof a === 'object');
  const aus = { gesamt: liste.length, fehler: 0, laeuft: 0, sicherungen: 0, spiegelungen: 0, zeilen: [] };
  for (const a of liste) {
    const z = a.zustand || {}; const l = z.letzter || null;
    // Art (09.11.2026): Sicherung oder Spiegelung; der Agent liefert sie mit, Rückfall: nur Assistenten-Ziel „FAH-NAS/…“ = Sicherung
    const zp = a.ziel && typeof a.ziel.pfad === 'string' ? a.ziel.pfad : '';
    const art = a.art === 'sicherung' || a.art === 'spiegelung' ? a.art : (a.richtung !== 'beidseitig' && (zp === 'FAH-NAS' || zp.startsWith('FAH-NAS/')) ? 'sicherung' : 'spiegelung');
    if (art === 'sicherung') aus.sicherungen++; else aus.spiegelungen++;
    if (z.laeuft) aus.laeuft++;
    if (l && l.ergebnis === 'fehler') aus.fehler++;
    aus.zeilen.push({ id: a.id, art, name: String(a.name || a.id), aktiv: a.aktiv !== false, laeuft: !!z.laeuft, fortschritt: z.fortschritt ?? null, ergebnis: l ? l.ergebnis : null, zeit: l ? (l.ende || l.beginn) : null });
  }
  return aus;
}

/** Freigaben-Kachel (wie Unraid „Shares“): je Freigabe belegt, Grenze (Kontingent × 1024³ bzw. Größe des Laufwerks), Prozent. */
export function freigabenZeilen(liste) {
  return listeVon(liste, 'freigaben').filter((f) => f && typeof f === 'object' && f.name)
    .map((f) => {
      const belegt = zahl(f.belegt);
      const grenze = Number(f.groesse_gb) > 0 ? Number(f.groesse_gb) * 1024 ** 3 : (zahl(f.kapazitaet) > 0 ? zahl(f.kapazitaet) : null);
      return { name: String(f.name), belegt, grenze, prozent: belegt != null && grenze ? Math.min(100, (belegt / grenze) * 100) : null, gesperrt: !!(f.verschluesselt && !f.entsperrt) };
    })
    .sort((a, b) => (b.belegt ?? -1) - (a.belegt ?? -1) || a.name.localeCompare(b.name, 'de'));
}

/**
 * Verbindungen-Kachel: eine Zeile je Zugriff {art: web|smb|ssh|webdav|nfs, nutzer, adresse, info} aus system.verbindungen
 * (`agent`) und /api/sitzungen (`web`; nur Sitzungen, die in den letzten 15 min etwas taten) plus offene SMB-Dateien.
 */
export function verbindungenZeilen(agent, web, jetzt = Date.now()) {
  const zeilen = [];
  for (const s of Array.isArray(web) ? web : []) {
    if (!s || jetzt - Date.parse(s.zuletzt) > WEB_AKTIV_MS) continue;
    zeilen.push({ art: 'web', nutzer: s.nutzer || '', adresse: s.ip && s.ip !== '-' ? s.ip : '', info: '', du: !!s.aktuell });
  }
  const a = agent && typeof agent === 'object' ? agent : {};
  for (const s of (a.smb && a.smb.sitzungen) || []) zeilen.push({ art: 'smb', nutzer: s.nutzer || '', adresse: s.rechner && s.rechner !== s.adresse ? s.rechner : (s.adresse || ''), info: (s.freigaben || []).join(', ') });
  for (const s of a.ssh || []) zeilen.push({ art: 'ssh', nutzer: s.nutzer || '', adresse: s.adresse || '', info: '' });
  for (const s of a.webdav || []) zeilen.push({ art: 'webdav', nutzer: '', adresse: s.adresse || '', info: s.anzahl > 1 ? `×${s.anzahl}` : '' });
  for (const s of a.nfs || []) zeilen.push({ art: 'nfs', nutzer: '', adresse: s.adresse || '', info: '' });
  return { zeilen, dateien: (a.smb && Array.isArray(a.smb.dateien)) ? a.smb.dateien : [] };
}

/**
 * Freigabelinks-Kachel (Betreiber 16.10.2026: „was per Link freigegeben wurde inkl. Gültigkeit und wer gerade zugreift (IP)“):
 * je Link Name, Ziel, Gültigkeit (null = dauerhaft), wer gerade zugreift (IP, Ort, lädt gerade) und wann zuletzt.
 * Links mit Zugriff stehen oben, sonst die neuesten zuerst. `r` = Ergebnis von GET /api/links {links, orte}.
 */
export function linksZeilen(r) {
  const links = r && Array.isArray(r.links) ? r.links : [];
  const orte = r && r.orte && typeof r.orte === 'object' ? r.orte : {};
  const ort = (ip) => { const o = ip ? orte[ip] : null; return o ? [o.stadt, o.land].filter(Boolean).join(', ') : ''; };
  const zeilen = links.filter((l) => l && typeof l.token === 'string').map((l) => {
    const z = l.zugriffe && typeof l.zugriffe === 'object' ? l.zugriffe : {};
    const aktiv = (Array.isArray(z.aktiv) ? z.aktiv : []).filter((a) => a && a.ip).map((a) => ({ ip: String(a.ip), ort: ort(a.ip), laeuft: !!a.laeuft, seit: a.seit || null }));
    const zuletzt = z.zuletzt && z.zuletzt.zeit ? { zeit: z.zuletzt.zeit, ip: String(z.zuletzt.ip || ''), ort: ort(z.zuletzt.ip) } : null;
    const ziel = [l.freigabe, l.pfad].filter(Boolean).join('/');
    return { token: l.token, url: l.url || '', name: String(l.name || (l.pfad ? String(l.pfad).split('/').pop() : l.freigabe) || ''), ziel, art: l.art === 'ordner' ? 'ordner' : 'datei', nutzer: l.nutzer || '', erstellt: l.erstellt || '', ablauf: l.ablauf || null, aufrufe: Number(z.aufrufe) || 0, zuletzt, aktiv };
  }).sort((a, b) => (b.aktiv.length > 0) - (a.aktiv.length > 0) || String(b.erstellt).localeCompare(String(a.erstellt)));
  return { zeilen, aktiv: zeilen.reduce((n, z) => n + z.aktiv.length, 0) };
}

/** Chat-Kachel: Räume mit Ungelesenem zuerst (meiste oben), dann die neuesten; höchstens 8 Zeilen, Summe über alle. */
export function chatZeilen(uebersicht) {
  const raeume = uebersicht && Array.isArray(uebersicht.raeume) ? uebersicht.raeume : [];
  const anzahl = (r) => (Number.isFinite(r.ungelesen) && r.ungelesen > 0 ? r.ungelesen : 0);
  const zeit = (r) => (r.letzte && r.letzte.zeit) || '';
  const sortiert = raeume.filter((r) => r && r.id).sort((a, b) => anzahl(b) - anzahl(a) || zeit(b).localeCompare(zeit(a)));
  return {
    zeilen: sortiert.slice(0, 8).map((r) => ({ id: r.id, name: String(r.name || ''), art: r.art === 'dm' ? 'dm' : 'raum', ungelesen: anzahl(r), letzte: r.letzte || null, stumm: !!r.stumm })),
    summe: raeume.reduce((n, r) => n + (r ? anzahl(r) : 0), 0),
  };
}

/**
 * Office-Kachel: höchstens 5 zuletzt bearbeitete Dokumente und höchstens 5 meiner fälligen Board-Karten (überfällige
 * zuerst, dann nach Datum); `anzahl_faellig` zählt alle fälligen Karten.
 */
export function officeZeilen(liste, faelligeKarten) {
  const zuletzt = (liste && Array.isArray(liste.zuletzt) ? liste.zuletzt : []).filter((d) => d && d.id).slice(0, 5)
    .map((d) => ({ id: d.id, art: d.art, name: String(d.name || ''), geaendert: d.geaendert || null }));
  const alle = (faelligeKarten && Array.isArray(faelligeKarten.karten) ? faelligeKarten.karten : []).filter((k) => k && k.karte_id);
  const karten = [...alle].sort((a, b) => (b.ueberfaellig === true) - (a.ueberfaellig === true) || String(a.faellig || '').localeCompare(String(b.faellig || '')))
    .slice(0, 5).map((k) => ({ board_id: k.board_id, board_name: String(k.board_name || ''), karte_id: k.karte_id, titel: String(k.titel || ''), faellig: k.faellig || null, ueberfaellig: k.ueberfaellig === true }));
  return { zuletzt, karten, anzahl_faellig: alle.length };
}

/** Docker-Speicher-Kachel: Zeilen je Art (nur vorhandene) und die Summe. */
export function dockerZeilen(d) {
  const x = d && typeof d === 'object' ? d : {};
  const zeilen = [];
  for (const art of ['images', 'container', 'volumes', 'cache']) if (x[art]) zeilen.push({ art, anzahl: x[art].anzahl, aktiv: x[art].aktiv, bytes: x[art].bytes || 0 });
  if (zahl(x.logs) != null) zeilen.push({ art: 'logs', anzahl: null, aktiv: null, bytes: x.logs });
  return { zeilen, summe: zeilen.reduce((s, z) => s + (z.bytes || 0), 0) };
}

/** Updates-Kachel: App-Updates (apps.updates) + Ubuntu (system.hinweise.updates) → {anzahl, apps:[…], ubuntu:{anzahl, sicherheit}|null}. */
export function updatesZusammenfassung(apps, hinweise) {
  const liste = apps && Array.isArray(apps.apps) ? apps.apps.filter((a) => a.stand === 'update') : [];
  const u = hinweise && hinweise.updates && typeof hinweise.updates === 'object' ? { anzahl: Number(hinweise.updates.anzahl) || 0, sicherheit: Number(hinweise.updates.sicherheit) || 0 } : null;
  return { anzahl: liste.length + (u ? u.anzahl : 0), apps: liste, ubuntu: u, unbekannt: apps && Array.isArray(apps.apps) ? apps.apps.filter((a) => a.stand === 'unbekannt').length : 0 };
}

/** Termin in der Zukunft kurz: „heute 15:00“, „morgen 03:00“, sonst Datum + Uhrzeit. */
export function termin(iso, jetzt = new Date()) {
  if (!iso) return '–';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  let uhr; try { uhr = d.toLocaleTimeString(gebiet(), { hour: '2-digit', minute: '2-digit' }); } catch { uhr = d.toISOString().slice(11, 16); }
  const tag = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const morgen = new Date(jetzt.getTime()); morgen.setDate(morgen.getDate() + 1);
  if (tag(d) === tag(jetzt)) return t('dashboard.termin_heute', { uhr });
  if (tag(d) === tag(morgen)) return t('dashboard.termin_morgen', { uhr });
  return format.zeitGenau(d);
}

const HB_STUFEN = Object.freeze({ fehler: 0, warnung: 1, hinweis: 2 });
const APP_FEHLER = new Set(['dead', 'fehler', 'error', 'failed', 'restarting']);

/**
 * „Handlungsbedarf“ (Betreiber 12.10.2026): alle Stände zu einer Liste [{id, stufe: fehler|warnung|hinweis, text, ziel}],
 * je Zeile ein Sprungziel für „Beheben“. Leer = alles in Ordnung. `q` = Rohdaten {status, raid, laufwerke, apps, spiegelung,
 * vms, vpn:{status, lesen}, proto, energie, hinweise}; fehlende Teile werden übergangen.
 */
export function handlungsbedarf(q = {}, hash = (...x) => `#/${x.join('/')}`) {
  const aus = [];
  const neu = (id, stufe, schluessel, werte, ziel) => aus.push({ id, stufe, text: t(`dashboard.${schluessel}`, werte), ziel });
  for (const v of listeVon(q.raid, 'verbuende')) {
    if (v.zustand === 'ausgefallen' || v.zustand === 'fehlt') neu(`raid-${v.name}`, 'fehler', 'hb_raid_aus', { name: v.name }, hash('laufwerke', 'raid'));
    else if (v.zustand === 'beeintraechtigt') neu(`raid-${v.name}`, 'fehler', 'hb_raid_beeintraechtigt', { name: v.name }, hash('laufwerke', 'raid'));
  }
  const dp = zahl(q.status && q.status.datenpartition_prozent);
  if (dp != null && dp >= 85) neu('daten-voll', dp >= 95 ? 'fehler' : 'warnung', 'hb_daten_voll', { prozent: Math.round(dp) }, hash('freigaben'));
  const lwListe = listeVon(q.laufwerke, 'geraete', 'laufwerke');
  // „neu“ nur, wenn keine Partition derselben Platte bekannt oder eingehängt ist (Ventoy-Stick: EFI-Teil bleibt still)
  const vertraut = new Set(lwListe.filter((g) => g && g.platte && (g.bekannt || g.eingehaengt)).map((g) => g.platte));
  for (const g of lwListe) {
    if (!g || g.system) continue;
    const name = g.name || g.label || g.modell || g.pfad || '?';
    if (g.eingehaengt) {
      const belegt = zahl(g.belegt); const frei = zahl(g.frei);
      const prozent = belegt != null && frei != null && belegt + frei > 0 ? (belegt / (belegt + frei)) * 100 : null;
      if (prozent != null && prozent >= 90) neu(`lw-${g.kennung || g.pfad}`, 'warnung', 'hb_laufwerk_voll', { name, prozent: Math.round(prozent) }, hash('laufwerke'));
    } else if (!g.bekannt && g.kennung && !(g.platte && vertraut.has(g.platte))) neu(`neu-${g.kennung}`, 'hinweis', 'hb_neue_platte', { name }, hash('laufwerke', 'ziel', g.kennung));
  }
  for (const a of listeVon(q.apps, 'apps')) {
    const z = String(a.zustand || '').toLowerCase(); const gs = String(a.gesundheit || '').toLowerCase();
    const name = a.titel || a.name;
    if (APP_FEHLER.has(z) || (gs === 'unhealthy' && ['running', 'laeuft', 'aktiv'].includes(z))) neu(`app-${a.name}`, 'fehler', 'hb_app_fehler', { name }, hash('apps', 'ziel', a.name));
    else if (a.portkonflikt) neu(`app-${a.name}`, 'warnung', 'hb_app_port', { name }, hash('apps', 'ziel', a.name));
  }
  for (const s of listeVon(q.spiegelung, 'auftraege')) {
    const l = s.zustand && s.zustand.letzter;
    if (s.aktiv !== false && l && l.ergebnis === 'fehler' && !(s.zustand && s.zustand.laeuft)) neu(`sp-${s.id}`, 'fehler', 'hb_spiegelung', { name: s.name || s.id }, hash('spiegelung', 'ziel', String(s.id)));
  }
  for (const v of listeVon(q.vms, 'vms')) {
    if (v.zustand === 'fehler' || (v.autostart && v.zustand === 'aus')) neu(`vm-${v.name}`, 'warnung', 'hb_vm', { name: v.titel || v.name }, hash('vms', 'ziel', v.name));
  }
  const vs = q.vpn && q.vpn.status;
  if (vs && vs.aktiv && !vs.laeuft) neu('vpn', 'fehler', 'hb_vpn_aus', {}, hash('system', 'vpn'));
  else if (vs && vs.aktiv && q.vpn.lesen && q.vpn.lesen.selbsttest && q.vpn.lesen.selbsttest.gesamt === 'fehler') neu('vpn', 'warnung', 'hb_vpn_test', {}, hash('system', 'vpn'));
  if (q.proto && protokolleZusammenfassung(q.proto).gestoert) neu('proto', 'warnung', 'hb_protokolle', {}, hash('system', 'protokolle'));
  const e = q.energie;
  if (e && e.usv_aktiv && e.usv && e.usv.akku) neu('usv', 'fehler', 'hb_usv_akku', { ladung: e.usv.ladung ?? '?' }, hash('system', 'energie'));
  else if (e && e.usv_aktiv && e.usv && e.usv.fehler) neu('usv', 'warnung', 'hb_usv_fehler', {}, hash('system', 'energie'));
  const h = q.hinweise;
  if (h) {
    for (const p of Array.isArray(h.smart) ? h.smart : []) neu(`smart-${p.geraet}`, p.zustand === 'fehler' ? 'fehler' : 'warnung', 'hb_smart', { platte: p.modell ? `${p.modell} (${p.geraet})` : p.geraet, grund: p.grund || '' }, hash('system', 'smart'));
    if (h.updates && h.updates.sicherheit > 0) neu('updates', 'warnung', 'hb_updates_sicherheit', { n: h.updates.anzahl, s: h.updates.sicherheit }, hash('system', 'updates'));
    else if (h.updates && h.updates.anzahl > 0) neu('updates', 'hinweis', 'hb_updates', { n: h.updates.anzahl }, hash('system', 'updates'));
    if (h.benachrichtigungen === false) neu('benachrichtigungen', 'hinweis', 'hb_benachrichtigungen', {}, hash('system', 'benachrichtigungen'));
    // Sicherheits-Check und Ergebnisse der automatischen Prüfungen (wartung.sicherheit)
    for (const s of Array.isArray(h.sicherheit) ? h.sicherheit : []) if (s && s.id && HB_STUFEN[s.stufe] !== undefined) neu(s.id, s.stufe, s.schluessel, s.werte || {}, hash(...(Array.isArray(s.ziel) ? s.ziel : ['dashboard'])));
  }
  return aus.sort((a, b) => HB_STUFEN[a.stufe] - HB_STUFEN[b.stufe]);
}

/**
 * „Verstanden“ (Betreiber 12.10.2026): quittierte Einträge ausblenden. Hinweis/Warnung bleibt weg, bis sich der Text ändert
 * (z. B. 2 → 5 Updates); ein Fehler meldet sich nach 24 h wieder, solange er besteht. Liefert {sichtbar, versteckt}.
 */
export function hbFiltern(liste, q = {}, jetzt = Date.now()) {
  const sichtbar = []; let versteckt = 0;
  for (const x of liste) {
    const e = q[x.id];
    if (e && e.text === x.text && (!e.bis || jetzt < e.bis)) versteckt += 1; else sichtbar.push(x);
  }
  return { sichtbar, versteckt };
}
/** Eintrag quittieren; Einträge, die es nicht mehr gibt (behoben), fallen aus der Liste – kommen sie wieder, erscheinen sie. */
export function hbQuittieren(q, x, aktuell, jetzt = Date.now()) {
  const ids = new Set(aktuell.map((y) => y.id));
  const neu = Object.fromEntries(Object.entries(q || {}).filter(([id]) => ids.has(id)));
  neu[x.id] = x.stufe === 'fehler' ? { text: x.text, bis: jetzt + HB_FEHLER_RUHE_MS } : { text: x.text };
  return neu;
}

/** Zählt Laufwerke: extern (nicht Teil der Systemplatte) und davon eingehängt. */
export function laufwerkeZusammenfassung(liste) {
  const geraete = listeVon(liste, 'geraete', 'laufwerke').filter((g) => g && typeof g === 'object');
  const extern = geraete.filter((g) => !g.system);
  return { gesamt: geraete.length, extern: extern.length, eingehaengt: extern.filter((g) => !!g.eingehaengt).length };
}

/**
 * Eingehängte externe Laufwerke für die Liste der Laufwerks-Kachel: [{id, titel, gesamt, frei, belegt, prozent}].
 * Gesamt = belegt + frei (wie df „Use%“), sonst die Partitionsgröße.
 */
export function externePlatten(liste) {
  const geraete = listeVon(liste, 'geraete', 'laufwerke').filter((g) => g && typeof g === 'object' && !g.system && g.eingehaengt);
  return geraete.map((g) => {
    const belegt = zahl(g.belegt); const frei = zahl(g.frei);
    const gesamt = belegt != null && frei != null ? belegt + frei : zahl(g.groesse);
    const prozent = gesamt && belegt != null ? (belegt / gesamt) * 100 : null;
    return { id: String(g.kennung || g.pfad || ''), titel: g.name || g.label || g.modell || g.pfad || '', gesamt, frei, belegt, prozent };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Messwerte: verschiedene Formen des Web-Dienstes auf eine gemeinsame bringen
// ---------------------------------------------------------------------------------------------------------------------

function zahl(v) { return typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null); }

function platteAus(p, schluessel) {
  if (!p || typeof p !== 'object') return null;
  const gesamt = zahl(p.gesamt) ?? zahl(p.groesse) ?? zahl(p.total);
  let frei = zahl(p.frei) ?? zahl(p.verfuegbar);
  let belegt = zahl(p.belegt) ?? zahl(p.benutzt) ?? zahl(p.verwendet);
  if (belegt == null && gesamt != null && frei != null) belegt = gesamt - frei;
  if (frei == null && gesamt != null && belegt != null) frei = gesamt - belegt;
  let prozent = zahl(p.prozent);
  if (prozent == null && gesamt && belegt != null) prozent = (belegt / gesamt) * 100;
  return { pfad: p.pfad || p.mount || schluessel || '', label: p.label || p.name || '', gesamt, frei, belegt, prozent };
}

/** Bringt einen Messwert in die Form {zeit, cpu, ramProzent, ramGesamt, ramBelegt, platten:[…], rx, tx, temp}. */
export function normalisiere(m) {
  if (!m || typeof m !== 'object') return null;
  const cpu = zahl(m.cpu) ?? zahl(m.cpu?.prozent) ?? zahl(m.cpu?.gesamt) ?? zahl(m.cpu?.last);
  const ramGesamt = zahl(m.ram?.gesamt) ?? zahl(m.ram?.total);
  let ramBelegt = zahl(m.ram?.belegt) ?? zahl(m.ram?.benutzt) ?? zahl(m.ram?.verwendet);
  const ramFrei = zahl(m.ram?.frei) ?? zahl(m.ram?.verfuegbar);
  if (ramBelegt == null && ramGesamt != null && ramFrei != null) ramBelegt = ramGesamt - ramFrei;
  let ramProzent = zahl(m.ram?.prozent) ?? zahl(m.ram);
  if (ramProzent == null && ramGesamt && ramBelegt != null) ramProzent = (ramBelegt / ramGesamt) * 100;
  const netz = m.netz && typeof m.netz === 'object' ? m.netz : {};
  const rx = zahl(netz.rx_bs) ?? zahl(netz.rx) ?? zahl(netz.empfangen_bs) ?? zahl(netz.empfangen) ?? zahl(netz.rein);
  const tx = zahl(netz.tx_bs) ?? zahl(netz.tx) ?? zahl(netz.gesendet_bs) ?? zahl(netz.gesendet) ?? zahl(netz.raus);
  let temp = zahl(m.temperatur);
  if (temp == null && m.temperatur && typeof m.temperatur === 'object') {
    const tObj = m.temperatur;
    temp = zahl(tObj.cpu) ?? zahl(tObj.max) ?? zahl(tObj.wert);
    if (temp == null) {
      const werte = (Array.isArray(tObj) ? tObj.map((x) => zahl(x?.wert) ?? zahl(x?.temperatur) ?? zahl(x)) : Object.values(tObj).map((x) => zahl(x) ?? zahl(x?.wert))).filter((x) => x != null);
      temp = werte.length ? Math.max(...werte) : null;
    }
  }
  let platten = [];
  if (Array.isArray(m.platten)) platten = m.platten.map((p) => platteAus(p)).filter(Boolean);
  else if (m.platten && typeof m.platten === 'object') platten = Object.entries(m.platten).map(([k, p]) => platteAus(p, k)).filter(Boolean);
  const c = m.cpu && typeof m.cpu === 'object' ? m.cpu : {};
  const cpuInfo = { modell: c.modell || '', hersteller: c.hersteller || '', kerne: zahl(c.kerne_physisch) ?? zahl(c.kerne), threads: zahl(c.threads) ?? zahl(c.kerne), jeKern: Array.isArray(c.je_kern) ? c.je_kern.map(zahl) : [] };
  return { zeit: m.zeit || new Date().toISOString(), cpu, cpuInfo, ramProzent, ramGesamt, ramBelegt, platten, rx, tx, temp };
}

/** Zeile unter dem CPU-Wert: Hersteller/Modell · Kerne/Threads (Betreiber 12.10.2026). */
export function cpuZeile(info) {
  if (!info || !info.modell) return '';
  const name = info.hersteller && !info.modell.toLowerCase().startsWith(info.hersteller.toLowerCase()) ? `${info.hersteller} ${info.modell}` : info.modell;
  return info.kerne && info.threads && info.threads !== info.kerne ? t('dashboard.cpu_kerne_threads', { name, kerne: info.kerne, threads: info.threads }) : t('dashboard.cpu_kerne', { name, kerne: info.kerne || info.threads || '?' });
}
/** Zeile der Systemplatte: Hersteller Modell · Größe Art. */
export function platteZeile(sp) {
  if (!sp || !sp.modell) return '';
  const name = sp.hersteller && !sp.modell.toLowerCase().startsWith(sp.hersteller.toLowerCase()) ? `${sp.hersteller} ${sp.modell}` : sp.modell;
  return `${name} · ${sp.groesse ? `${format.groesse(sp.groesse)} ` : ''}${({ hdd: 'HDD', ssd: 'SSD', nvme: 'NVMe-SSD' })[sp.art] || ''}`.trim();
}

function istSystemplatte(p) { return p.pfad === '/' || /^system$/i.test(p.label) || /system/i.test(p.pfad); }
function istDatenplatte(p) { return p.pfad === '/data' || /daten/i.test(p.label) || /^\/data\/?$/.test(p.pfad); }

function findePlatte(art) {
  const quellen = [];
  if (letzterMesswert && letzterMesswert.platten.length) quellen.push(letzterMesswert.platten);
  if (status && Array.isArray(status.platten)) quellen.push(status.platten.map((p) => platteAus(p)).filter(Boolean));
  for (const liste of quellen) {
    const p = liste.find(art === 'system' ? istSystemplatte : istDatenplatte);
    if (p) return p;
  }
  if (art === 'daten' && status && zahl(status.datenpartition_prozent) != null) return { pfad: '/data', prozent: status.datenpartition_prozent, gesamt: null, frei: null };
  const erste = quellen[0];
  if (erste && erste.length) return erste[art === 'system' ? 0 : Math.min(1, erste.length - 1)];
  return null;
}

function punkt(reihe, wert) {
  reihe.push(wert == null ? null : wert);
  while (reihe.length > MAX_PUNKTE) reihe.shift();
}

// ---------------------------------------------------------------------------------------------------------------------
// Kurven auf Canvas
// ---------------------------------------------------------------------------------------------------------------------

function cssFarbe(name, rueckfall) {
  try { const w = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return w || rueckfall; } catch { return rueckfall; }
}

/** Zeichnet eine oder zwei Reihen (Werte, null = Lücke) als Fläche + Linie. max = feste Obergrenze oder null (automatisch). */
export function zeichneKurve(canvas, serien, max = null) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const b = canvas.clientWidth || 300; const h = canvas.clientHeight || 72;
  const bw = Math.max(1, Math.round(b * dpr)); const hw = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== hw) { canvas.width = bw; canvas.height = hw; }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, b, h);
  const rand = cssFarbe('--fahnas-rand', '#d9dee3');
  g.strokeStyle = rand; g.lineWidth = 1; g.globalAlpha = 0.7;
  for (const y of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(0, Math.round(h * y) + 0.5); g.lineTo(b, Math.round(h * y) + 0.5); g.stroke(); }
  g.globalAlpha = 1;
  let obergrenze = max;
  if (obergrenze == null) {
    let m = 0;
    for (const s of serien) for (const w of s.werte) if (w != null && w > m) m = w;
    obergrenze = m > 0 ? m * 1.15 : 1;
  }
  const schritt = b / (MAX_PUNKTE - 1);
  const oben = 4; const nutz = h - oben - 2;
  for (const s of serien) {
    const farbe = s.farbe || cssFarbe('--fahnas-akzent', '#0e8a8a');
    const werte = s.werte; const n = werte.length;
    const xVon = (i) => b - (n - 1 - i) * schritt;
    const yVon = (w) => oben + nutz - Math.min(1, Math.max(0, w / obergrenze)) * nutz;
    // Fläche
    g.beginPath(); let offen = false; let start = null;
    for (let i = 0; i < n; i++) {
      const w = werte[i];
      if (w == null) { if (offen) { g.lineTo(xVon(i - 1), h); g.lineTo(start, h); g.closePath(); offen = false; } continue; }
      if (!offen) { start = xVon(i); g.moveTo(start, h); g.lineTo(start, yVon(w)); offen = true; } else g.lineTo(xVon(i), yVon(w));
    }
    if (offen) { g.lineTo(xVon(n - 1), h); g.lineTo(start, h); g.closePath(); }
    g.fillStyle = farbe; g.globalAlpha = 0.14; g.fill(); g.globalAlpha = 1;
    // Linie
    g.beginPath(); offen = false;
    for (let i = 0; i < n; i++) {
      const w = werte[i];
      if (w == null) { offen = false; continue; }
      if (!offen) { g.moveTo(xVon(i), yVon(w)); offen = true; } else g.lineTo(xVon(i), yVon(w));
    }
    g.strokeStyle = farbe; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Kacheln
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Kachel mit Kopf (Symbol + Titel, optional `kopf` rechts daneben, z. B. ein Umschalter). Platz und Größe im Raster
 * kommen aus dem Layout (Standardgrößen in ./dashboard-raster.js).
 */
function kachel(id, symbolName, titel, kinder, klasse = '', { kopf = null } = {}) {
  const k = el('article', { class: `kachel dashboard-kachel${klasse ? ' ' + klasse : ''}`, 'data-kachel': id, 'aria-labelledby': `kachel-${id}-titel` }, [
    el('div', { class: 'kachel-kopf' }, [symbol(symbolName), el('h2', { class: 'kachel-titel', id: `kachel-${id}-titel`, text: titel }), kopf]),
    kinder,
  ]);
  return k;
}

function favoritenZeigen() {
  if (!knoten.faListe || !ctx) return;
  const f = favoriten.alle();
  knoten.faWert.textContent = t('dashboard.favoriten_wert', { n: f.length });
  knoten.faNeben.textContent = f.length ? '' : t('dashboard.favoriten_leer');
  knoten.faNeben.hidden = !!f.length;
  knoten.faListe.textContent = '';
  knoten.faListe.hidden = !f.length;
  for (const x of f) {
    knoten.faListe.appendChild(el('li', { class: 'dashboard-favorit' }, [
      el('a', { class: 'dashboard-favorit-link', href: ctx.hashFuer('dateien', x.freigabe, x.pfad), title: favoriten.ort(x) }, [
        symbol('ordner'), el('span', { class: 'dashboard-favorit-name', text: favoriten.anzeigeName(x) }),
      ]),
      el('span', { class: 'dashboard-favorit-ort', text: favoriten.ort(x) }),
    ]));
  }
}

let favoritenAbmelden = null;

function balken(prozent, klasse = '') {
  const p = prozent == null ? 0 : Math.max(0, Math.min(100, prozent));
  const stufe = prozent == null ? '' : prozent >= GEFAHR_AB ? ' gefahr' : prozent >= WARNUNG_AB ? ' warnung' : '';
  return el('div', { class: `fortschritt${stufe}${klasse ? ' ' + klasse : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)) }, [el('div', { class: 'fortschritt-balken', style: { '--anteil': `${p}%` } })]);
}

function setzeBalken(b, prozent) {
  if (!b) return;
  const p = prozent == null ? 0 : Math.max(0, Math.min(100, prozent));
  b.classList.toggle('warnung', prozent != null && prozent >= WARNUNG_AB && prozent < GEFAHR_AB);
  b.classList.toggle('gefahr', prozent != null && prozent >= GEFAHR_AB);
  b.setAttribute('aria-valuenow', String(Math.round(p)));
  const innen = b.firstElementChild; if (innen) innen.style.setProperty('--anteil', `${p}%`);
}

function stufeSetzen(k, prozent) {
  if (!k) return;
  k.classList.toggle('warnung', prozent != null && prozent >= WARNUNG_AB && prozent < GEFAHR_AB);
  k.classList.toggle('gefahr', prozent != null && prozent >= GEFAHR_AB);
}

function baueOberflaeche() {
  wurzel.textContent = '';
  knoten.kopfKnoepfe = el('div', { class: 'ansicht-werkzeuge dashboard-kopf-knoepfe' });
  wurzel.appendChild(el('div', { class: 'ansicht-kopf' }, [
    el('div', {}, [
      el('h1', { text: t('dashboard.titel') }),
      el('p', { class: 'schwach klein dashboard-untertitel', text: t('dashboard.untertitel') }),
    ]),
    knoten.kopfKnoepfe,
  ]));
  knoten.anpassenHinweis = el('p', { class: 'hinweis hinweis-info dashboard-anpassen-hinweis', hidden: true, text: t('dashboard.anpassen_hinweis') });
  knoten.anpassenAnsage = el('p', { class: 'nur-lesen', 'aria-live': 'polite' }); // neuer Platz/neue Größe für Bildschirmleser
  wurzel.appendChild(knoten.anpassenAnsage);
  wurzel.appendChild(el('p', { class: 'nur-lesen', id: 'dashboard-tastatur-hilfe', text: t('dashboard.tastatur_hilfe') }));
  wurzel.appendChild(knoten.anpassenHinweis);
  knoten.hinweisPlatteText = el('p', { text: '' });
  knoten.hinweisPlatte = el('div', { class: 'hinweis hinweis-warnung', hidden: true }, [symbol('warnung'), knoten.hinweisPlatteText]);
  wurzel.appendChild(knoten.hinweisPlatte);
  // Handlungsbedarf (nur Admins: nur sie können beheben) – ganz oben, nicht verschiebbar
  knoten.hb = null; knoten.hbListe = null; knoten.hbZeigen = null;
  if (ctx.rolle === 'admin') {
    knoten.hbListe = el('ul', { class: 'hb-liste', role: 'list' });
    knoten.hbKopf = el('h2', { class: 'hb-titel', text: t('dashboard.hb_titel') });
    knoten.hb = el('section', { class: 'karte hb hb-laden', 'aria-labelledby': 'hb-titel-id' }, [el('div', { class: 'hb-kopf' }, [symbol('aufgaben'), knoten.hbKopf]), knoten.hbListe]);
    knoten.hbKopf.id = 'hb-titel-id';
    wurzel.appendChild(knoten.hb);
  }

  const raster = el('div', { class: 'dashboard-raster' });
  wurzel.appendChild(raster);
  knoten.raster = raster;
  ziehenEinrichten(raster);

  // Systemübersicht (Betreiber 16.10.2026: „system widget … CPU, GPU, RAM und netzwerk zusammen … volle breite aber geringe
  // höhe sowie ohne scrollbalken“ – „nicht den home bildschirm überladen müssen mit widgets nur um mir die wichtigsten
  // infos anzeigen zu lassen“): je Bereich Wert, kleine Kurve bzw. Balken und eine Zeile; dazu die Datenpartition. GPU nur
  // für Admins (gpu.lesen). Feste Höhe, nichts rollt: Texte kürzen mit „…“. In der Kopfzeile rechts Name, Version, Kernel
  // und Laufzeit aus der Kachel „System“ (Betreiber 16.10.2026: „das muss hier noch mit rein“).
  const slTeil = (id, sym, titel, unten) => {
    const z = { wert: el('span', { class: 'dashboard-sl-wert', text: '–' }), neben: el('span', { class: 'dashboard-sl-neben', text: '' }) };
    z.element = el('div', { class: 'dashboard-sl-teil', 'data-teil': id }, [
      el('div', { class: 'dashboard-sl-kopf' }, [symbol(sym, 'klein'), el('span', { class: 'dashboard-sl-name', text: titel }), z.wert]), unten, z.neben]);
    return z;
  };
  knoten.slCpuKurve = el('canvas', { class: 'dashboard-sl-kurve', 'aria-label': t('dashboard.cpu_kurve'), role: 'img' });
  knoten.slRamKurve = el('canvas', { class: 'dashboard-sl-kurve', 'aria-label': t('dashboard.sl_ram_kurve'), role: 'img' });
  knoten.slNetzKurve = el('canvas', { class: 'dashboard-sl-kurve', 'aria-label': t('dashboard.netz_kurve'), role: 'img' });
  knoten.slGpuBalken = balken(null, 'dashboard-sl-balken');
  knoten.slSpeicherBalken = balken(null, 'dashboard-sl-balken');
  knoten.slCpu = slTeil('cpu', 'cpu', t('dashboard.sl_cpu'), knoten.slCpuKurve);
  knoten.slGpu = ctx.rolle === 'admin' ? slTeil('gpu', 'gpu', t('dashboard.sl_gpu'), el('div', { class: 'dashboard-sl-balkenfeld' }, [knoten.slGpuBalken])) : null;
  knoten.slRam = slTeil('ram', 'ram', t('dashboard.sl_ram'), knoten.slRamKurve);
  knoten.slNetz = slTeil('netz', 'netz', t('dashboard.sl_netz'), knoten.slNetzKurve);
  knoten.slSpeicher = slTeil('speicher', 'platte', t('dashboard.sl_speicher'), el('div', { class: 'dashboard-sl-balkenfeld' }, [knoten.slSpeicherBalken]));
  knoten.slSystem = el('span', { class: 'dashboard-sl-system' });
  raster.appendChild(kachel('systemleiste', 'system', t('dashboard.systemleiste'), [el('div', { class: 'dashboard-sl' },
    [knoten.slCpu.element, knoten.slGpu && knoten.slGpu.element, knoten.slRam.element, knoten.slNetz.element, knoten.slSpeicher.element].filter(Boolean))], 'dashboard-sl-kachel', { kopf: knoten.slSystem }));

  // CPU
  knoten.cpuWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.cpuInfo = el('p', { class: 'kachel-neben dashboard-cpu-info', text: '' });
  knoten.cpuKerne = el('ul', { class: 'dashboard-kerne', role: 'list', 'aria-label': t('dashboard.cpu_je_kern') });
  knoten.cpuKurve = el('canvas', { class: 'dashboard-kurve', 'aria-label': t('dashboard.cpu_kurve'), role: 'img' });
  raster.appendChild(kachel('cpu', 'cpu', t('dashboard.cpu'), [knoten.cpuWert, knoten.cpuInfo, knoten.cpuKerne, knoten.cpuKurve, el('p', { class: 'kachel-fuss', text: t('dashboard.zeitraum') })]));

  // RAM
  knoten.ramWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.ramNeben = el('p', { class: 'kachel-neben', text: '' });
  knoten.ramBalken = balken(null);
  raster.appendChild(kachel('ram', 'ram', t('dashboard.ram'), [knoten.ramWert, knoten.ramBalken, knoten.ramNeben]));

  // Interne Festplatte (Betreiber 09.10.: eine Karte) – Gesamtbelegung, darunter System- und Datenpartition
  knoten.platteWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.platteModell = el('p', { class: 'kachel-neben dashboard-platte-modell', text: '' });
  knoten.platteNeben = el('p', { class: 'kachel-neben', text: '' });
  const teil = (art) => {
    const z = { prozent: el('span', { class: 'dashboard-laufwerk-prozent', text: '–' }), balken: balken(null), neben: el('p', { class: 'dashboard-laufwerk-neben', text: '' }) };
    z.element = el('li', { class: 'dashboard-laufwerk', 'data-teil': art }, [
      el('div', { class: 'dashboard-laufwerk-kopf' }, [el('span', { class: 'dashboard-laufwerk-name', text: t(`dashboard.platte_${art}`) }), z.prozent]), z.balken, z.neben]);
    return z;
  };
  knoten.platteSys = teil('system'); knoten.platteDat = teil('daten');
  knoten.platteKachel = kachel('platte', 'platte', t('dashboard.platte'), [knoten.platteWert, knoten.platteModell, knoten.platteNeben,
    el('ul', { class: 'dashboard-laufwerke dashboard-platte-teile', role: 'list' }, [knoten.platteSys.element, knoten.platteDat.element])]);
  raster.appendChild(knoten.platteKachel);

  // Netz
  knoten.netzWert = el('div', { class: 'kachel-wert dashboard-netz-wert' }, [
    el('span', { class: 'dashboard-netz-rx' }, [symbol('herunterladen', 'klein'), el('span', { text: '–' })]),
    el('span', { class: 'dashboard-netz-tx' }, [symbol('hochladen', 'klein'), el('span', { text: '–' })]),
  ]);
  knoten.netzKurve = el('canvas', { class: 'dashboard-kurve', 'aria-label': t('dashboard.netz_kurve'), role: 'img' });
  raster.appendChild(kachel('netz', 'netz', t('dashboard.netz'), [knoten.netzWert, knoten.netzKurve, el('p', { class: 'kachel-fuss' }, [
    el('span', { class: 'dashboard-legende dashboard-legende-rx', text: t('dashboard.netz_rx') }), ' ',
    el('span', { class: 'dashboard-legende dashboard-legende-tx', text: t('dashboard.netz_tx') }),
  ])]));

  // Temperatur
  knoten.tempWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.tempNeben = el('p', { class: 'kachel-neben', text: '' });
  knoten.tempKachel = kachel('temperatur', 'temperatur', t('dashboard.temperatur'), [knoten.tempWert, knoten.tempNeben]);
  raster.appendChild(knoten.tempKachel);

  // System
  knoten.systemListe = el('dl', { class: 'dashboard-liste' });
  raster.appendChild(kachel('system', 'uhr', t('dashboard.system'), [knoten.systemListe]));

  // Dienste
  knoten.dienste = el('ul', { class: 'dashboard-dienste', role: 'list' });
  raster.appendChild(kachel('dienste', 'dienste', t('dashboard.dienste'), [knoten.dienste]));

  // Aufgaben
  knoten.aufgaben = el('div', { class: 'dashboard-aufgaben' });
  raster.appendChild(kachel('aufgaben', 'aufgaben', t('dashboard.aufgaben'), [knoten.aufgaben]));

  // Tapete (alle Nutzer, Betreiber 15.10.2026) – aktuelle Tapete, Vor/Zurück durch Sammlung + Ordner, Darstellung öffnen
  knoten.tpBild = el('div', { class: 'dashboard-tapete-bild', 'aria-hidden': 'true' });
  knoten.tpName = el('p', { class: 'kachel-neben dashboard-tapete-name', text: t('rahmen.laden') });
  knoten.tpZurueck = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: t('dashboard.tapete_vorige'), 'aria-label': t('dashboard.tapete_vorige'), onclick: () => tapeteWechseln(-1) }, '◀');
  knoten.tpWeiter = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: t('dashboard.tapete_naechste'), 'aria-label': t('dashboard.tapete_naechste'), onclick: () => tapeteWechseln(1) }, '▶');
  raster.appendChild(kachel('tapete', 'darstellung', t('dashboard.tapete'), [knoten.tpBild, knoten.tpName,
    el('div', { class: 'knopf-reihe dashboard-tapete-knoepfe' }, [knoten.tpZurueck, knoten.tpWeiter,
      el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: async () => { const m = await import('../darstellung-fenster.js'); if (ctx && ctx.nutzer) m.oeffnen(ctx.nutzer.name); } }, t('dashboard.tapete_aendern'))])]));

  // Ereignisse (nur admin)
  if (ctx.rolle === 'admin') {
    knoten.ereignisse = el('div', { class: 'dashboard-ereignisse' });
    raster.appendChild(kachel('ereignisse', 'protokoll', t('dashboard.ereignisse'), [knoten.ereignisse]));
  }

  // Weltkarte (nur admin) – Standard volle Breite, doppelte Höhe; das Karten-Modul lädt erst jetzt
  if (ctx.rolle === 'admin') {
    raster.appendChild(baueWeltkarte());
    wkKarteLaden();
  }

  // Apps – echte Zahlen aus apps.liste
  knoten.appsWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.appsNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.appsListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
  knoten.appsKachel = kachel('apps', 'apps', t('dashboard.apps'), [knoten.appsWert, knoten.appsNeben, knoten.appsListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('apps'), text: t('dashboard.apps_link') })])]);
  raster.appendChild(knoten.appsKachel);

  // Freigaben (alle Nutzer, nur sichtbare) – Belegung je Freigabe wie Unraid „Shares“ (freigaben.liste)
  knoten.fgWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.fgNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.fgListe = el('ul', { class: 'dashboard-laufwerke', role: 'list', hidden: true });
  knoten.fgKachel = kachel('freigaben', 'freigaben', t('dashboard.freigaben'), [knoten.fgWert, knoten.fgNeben, knoten.fgListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('freigaben'), text: t('dashboard.freigaben_link') })])]);
  raster.appendChild(knoten.fgKachel);

  // Freigabelinks (alle Nutzer: eigene Links, Admin: alle) – Gültigkeit, wer gerade zugreift (IP + Ort), zuletzt (/api/links)
  knoten.lkWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.lkNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.lkListe = el('ul', { class: 'dashboard-spiegelung dashboard-links', role: 'list', hidden: true });
  knoten.lkKachel = kachel('links', 'link', t('dashboard.links'), [knoten.lkWert, knoten.lkNeben, knoten.lkListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('dateien'), text: t('dashboard.links_link') })])]);
  raster.appendChild(knoten.lkKachel);

  // Favoriten (alle Nutzer) – in „Dateien“ mit Stern markierte Ordner, Klick öffnet den Ordner (favoriten.js)
  knoten.faWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.faNeben = el('p', { class: 'kachel-neben' });
  knoten.faListe = el('ul', { class: 'dashboard-spiegelung dashboard-favoriten', role: 'list', hidden: true });
  knoten.faKachel = kachel('favoriten', 'stern', t('dashboard.favoriten'), [knoten.faWert, knoten.faNeben, knoten.faListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('dateien'), text: t('dashboard.favoriten_link') })])]);
  raster.appendChild(knoten.faKachel);
  favoritenZeigen();

  // Chat (alle Nutzer) – ungelesene Nachrichten je Raum (chat.uebersicht), Klick öffnet den Raum
  knoten.chWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.chNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.chListe = el('ul', { class: 'dashboard-spiegelung dashboard-chat', role: 'list', hidden: true });
  knoten.chExtra = el('div', { class: 'dashboard-chat-extra' });
  knoten.chKachel = kachel('chat', 'chat', t('dashboard.chat'), [knoten.chWert, knoten.chNeben, knoten.chListe, knoten.chExtra, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('chat'), text: t('dashboard.chat_link') })])]);
  raster.appendChild(knoten.chKachel);

  // Office (alle Nutzer) – zuletzt bearbeitet und meine fälligen Karten (office.liste, office.faellig)
  knoten.ofWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.ofNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.ofZuletztTitel = el('p', { class: 'dashboard-office-titel', text: t('dashboard.office_zuletzt'), hidden: true });
  knoten.ofZuletzt = el('ul', { class: 'dashboard-spiegelung dashboard-office', role: 'list', hidden: true });
  knoten.ofKartenTitel = el('p', { class: 'dashboard-office-titel', text: t('dashboard.office_karten'), hidden: true });
  knoten.ofKarten = el('ul', { class: 'dashboard-spiegelung dashboard-office-karten', role: 'list', hidden: true });
  knoten.ofKachel = kachel('office', 'office', t('dashboard.office'), [knoten.ofWert, knoten.ofNeben, knoten.ofZuletztTitel, knoten.ofZuletzt, knoten.ofKartenTitel, knoten.ofKarten, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('office'), text: t('dashboard.office_link') })])]);
  raster.appendChild(knoten.ofKachel);

  // Uhr (alle Nutzer) – Uhrzeit und Datum dieses Geräts, jede Sekunde
  knoten.uhrZeit = el('div', { class: 'kachel-wert dashboard-uhr-zeit', text: '–' });
  knoten.uhrDatum = el('p', { class: 'kachel-neben dashboard-uhr-datum', text: '' });
  raster.appendChild(kachel('uhr', 'uhr', t('dashboard.uhr'), [knoten.uhrZeit, knoten.uhrDatum]));

  // Anmeldung (alle Nutzer, Betreiber 16.10.2026) – eigene Zeit bis zur automatischen Abmeldung, ändern in „Mein Konto“
  const abm = ctx.nutzer && ctx.nutzer.abmelden !== undefined ? ctx.nutzer.abmelden : null;
  raster.appendChild(kachel('anmeldung', 'anmeldung', t('dashboard.anmeldung'), [
    el('div', { class: 'kachel-wert', text: abmeldenKurz(t, abm) }),
    el('p', { class: 'kachel-neben', text: abmeldenText(t, abm) }),
    el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('nutzer'), text: t('dashboard.anmeldung_link') })])]));

  // Profil (alle Nutzer, 0.22.0 – Avatare): eigenes Bild oder Anfangsbuchstabe, Name, Rolle; das Bild ändert man in „Mein Konto“
  const ich = ctx.nutzer && typeof ctx.nutzer === 'object' ? ctx.nutzer : {};
  raster.appendChild(kachel('profil', 'nutzer', t('dashboard.profil'), [
    el('div', { class: 'dashboard-profil' }, [
      avatarKnoten({ name: ich.name || '', anzeige: ich.anzeigename || ich.name || '', groesse: 56 }),
      el('div', { class: 'dashboard-profil-text' }, [
        el('div', { class: 'kachel-wert dashboard-profil-name', text: ich.anzeigename || ich.name || '' }),
        el('p', { class: 'kachel-neben', text: t(ich.rolle === 'admin' ? 'dashboard.profil_admin' : 'dashboard.profil_nutzer') }),
      ]),
    ]),
    el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('nutzer'), text: t('dashboard.profil_link') })])]));

  // Externe Laufwerke – Zusammenfassung und je eingehängtem Laufwerk eine Zeile mit Belegung (laufwerke.liste)
  knoten.lwWert = el('div', { class: 'kachel-wert', text: '–' });
  knoten.lwNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
  knoten.lwListe = el('ul', { class: 'dashboard-laufwerke', role: 'list' });
  knoten.lwKachel = kachel('laufwerke', 'laufwerke', t('dashboard.laufwerke'), [knoten.lwWert, knoten.lwNeben, knoten.lwListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('laufwerke'), text: t('dashboard.laufwerke_link') })])]);
  raster.appendChild(knoten.lwKachel);

  // VMs – laufende/alle, je VM Zustand und Adresse (vms.liste, nur admin)
  if (ctx.rolle === 'admin') {
    knoten.vmWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.vmNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.vmListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.vmKachel = kachel('vms', 'vms', t('dashboard.vms'), [knoten.vmWert, knoten.vmNeben, knoten.vmListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('vms'), text: t('dashboard.vms_link') })])]);
    raster.appendChild(knoten.vmKachel);

    // Speicherverbünde (RAID) – Zustand je Verbund, Wiederaufbau in Prozent (raid.liste)
    knoten.rdWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.rdNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.rdListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.rdKachel = kachel('raid', 'laufwerke', t('dashboard.raid'), [knoten.rdWert, knoten.rdNeben, knoten.rdListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('laufwerke', 'raid'), text: t('dashboard.raid_link') })])]);
    raster.appendChild(knoten.rdKachel);

    // Wartung & Sicherheit – Sicherheits-Check, letzte Plattentests, automatische Updates (wartung.lesen + system.hinweise)
    knoten.wtWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.wtNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.wtListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.wtKachel = kachel('wartung', 'system', t('dashboard.wartung'), [knoten.wtWert, knoten.wtNeben, knoten.wtListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'pruefungen'), text: t('dashboard.wartung_link') })])]);
    raster.appendChild(knoten.wtKachel);
  }

  // Spiegelung (nur admin) – Zustand je Spiegelung aus spiegelung.liste, Fortschritt live per Ereignis „spiegelung“
  if (ctx.rolle === 'admin') {
    knoten.spWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.spNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.spListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.spLink = el('a', { href: ctx.hashFuer('spiegelung'), text: t('dashboard.spiegelung_link') });
    knoten.spKachel = kachel('spiegelung', 'spiegelung', t('dashboard.spiegelung'), [knoten.spWert, knoten.spNeben, knoten.spListe, el('p', { class: 'kachel-fuss' }, [knoten.spLink])]);
    raster.appendChild(knoten.spKachel);

    // Meldungen – letzte Benachrichtigungen (E-Mail/ntfy), live per Ereignis „benachrichtigung“
    knoten.mlWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.mlNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.mlListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.mlKachel = kachel('meldungen', 'warnung', t('dashboard.meldungen'), [knoten.mlWert, knoten.mlNeben, knoten.mlListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'benachrichtigungen'), text: t('dashboard.meldungen_link') })])]);
    raster.appendChild(knoten.mlKachel);

    // VPN – verbundene Geräte und Ergebnis des letzten Selbsttests (vpn.status, vpn.lesen)
    knoten.vpWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.vpNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.vpListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.vpKachel = kachel('vpn', 'vpn', t('dashboard.vpn'), [knoten.vpWert, knoten.vpNeben, knoten.vpListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'vpn'), text: t('dashboard.vpn_link') })])]);
    raster.appendChild(knoten.vpKachel);

    // Grafikkarte – Modell, Takt (Intel) bzw. Auslastung (NVIDIA/AMD) und die Apps, die sie nutzen (gpu.lesen)
    knoten.gpWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.gpNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.gpListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.gpKachel = kachel('gpu', 'gpu', t('dashboard.gpu'), [knoten.gpWert, knoten.gpNeben, knoten.gpListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'grafikkarte'), text: t('dashboard.gpu_link') })])]);
    raster.appendChild(knoten.gpKachel);

    // Energie – USV-Zustand, nächstes Aus-/Einschalten, Wake-on-LAN (energie.status)
    knoten.enWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.enNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.enListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.enKachel = kachel('energie', 'energie', t('dashboard.energie'), [knoten.enWert, knoten.enNeben, knoten.enListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'energie'), text: t('dashboard.energie_link') })])]);
    raster.appendChild(knoten.enKachel);

    // Protokolle – welche zusätzlich zu SMB laufen (protokolle.lesen)
    knoten.prWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.prNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.prListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.prKachel = kachel('protokolle', 'netz', t('dashboard.protokolle'), [knoten.prWert, knoten.prNeben, knoten.prListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'protokolle'), text: t('dashboard.protokolle_link') })])]);
    raster.appendChild(knoten.prKachel);

    // Schnappschüsse – je Ziel Anzahl, letzter, nächster laut Zeitplan (snapshots.uebersicht)
    knoten.snWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.snNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.snListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.snKachel = kachel('schnappschuesse', 'snapshots', t('dashboard.snap'), [knoten.snWert, knoten.snNeben, knoten.snListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('snapshots'), text: t('dashboard.snap_link') })])]);
    raster.appendChild(knoten.snKachel);

    // Verbindungen – wer gerade zugreift: Web, SMB (mit offenen Dateien), SSH/SFTP, WebDAV, NFS (system.verbindungen + /api/sitzungen)
    knoten.vbWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.vbNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.vbListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.vbDateien = el('ul', { class: 'dashboard-spiegelung dashboard-verb-dateien', role: 'list', hidden: true, 'aria-label': t('dashboard.verb_dateien') });
    knoten.vbKachel = kachel('verbindungen', 'nutzer', t('dashboard.verb'), [knoten.vbWert, knoten.vbNeben, knoten.vbListe, knoten.vbDateien, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('nutzer'), text: t('dashboard.verb_link') })])]);
    raster.appendChild(knoten.vbKachel);

    // Docker-Speicher – Images, Container, Volumes, Bau-Zwischenspeicher, Protokolle; „Aufräumen“ (apps.docker_speicher)
    knoten.dkWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.dkNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.dkListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.dkKnopf = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: t('dashboard.docker_aufraeumen_titel'), onclick: dockerAufraeumen }, t('dashboard.docker_aufraeumen'));
    knoten.dkKachel = kachel('docker', 'archiv', t('dashboard.docker'), [knoten.dkWert, knoten.dkNeben, knoten.dkListe, el('p', { class: 'kachel-fuss dashboard-fuss-knopf' }, [knoten.dkKnopf, el('a', { href: ctx.hashFuer('apps'), text: t('dashboard.apps_link') })])]);
    raster.appendChild(knoten.dkKachel);

    // Updates – FAH-NAS-Version, Ubuntu-Pakete, Apps mit neuerem Image (apps.updates + system.hinweise)
    knoten.upWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.upNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.upListe = el('ul', { class: 'dashboard-spiegelung', role: 'list' });
    knoten.upKnopf = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: t('dashboard.updates_pruefen_titel'), onclick: updatesPruefen }, t('dashboard.updates_pruefen'));
    // Anmeldeschutz – Zugriffe aus dem Internet: Sperren, Fehlversuche, letzte Anmeldungen (/api/anmeldeschutz, 16.10.2026)
    knoten.asWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.asNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.asListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.asKachel = kachel('anmeldeschutz', 'anmeldung', t('dashboard.schutz'), [knoten.asWert, knoten.asNeben, knoten.asListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'anmeldeschutz'), text: t('dashboard.schutz_link') })])]);
    raster.appendChild(knoten.asKachel);

    // Ordnerrechte – Ordner mit eigenen Rechten, fehlende Ordner, letzter Abgleich (freigaben.ordnerrechte.liste, 19.10.2026)
    knoten.orWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.orNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.orListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.orKachel = kachel('ordnerrechte', 'schloss', t('dashboard.ordnerrechte'), [knoten.orWert, knoten.orNeben, knoten.orListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('freigaben'), text: t('dashboard.ordnerrechte_link') })])]);
    raster.appendChild(knoten.orKachel);

    // Apps aus FAH-Git – gebaute Projekte, ob ein neuer Commit wartet, automatisch ja/nein (apps.fahgit.stand, 26.10.2026)
    knoten.fgWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.fgNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.fgListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.fgLink = el('a', { href: ctx.hashFuer('apps', 'fahgit'), text: t('dashboard.fahgit_link') });
    knoten.fgKachel = kachel('fahgit', 'apps', t('dashboard.fahgit'), [knoten.fgWert, knoten.fgNeben, knoten.fgListe, el('p', { class: 'kachel-fuss' }, [knoten.fgLink])]);
    raster.appendChild(knoten.fgKachel);

    // Gehäuse – Lüfter (Drehzahl, Modus), Temperaturen, LEDs bei UGREEN-Geräten (hardware.status, 19.10.2026)
    knoten.ghWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.ghNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.ghListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.ghKachel = kachel('gehaeuse', 'temperatur', t('dashboard.gehaeuse'), [knoten.ghWert, knoten.ghNeben, knoten.ghListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('system', 'gehaeuse'), text: t('dashboard.gehaeuse_link') })])]);
    raster.appendChild(knoten.ghKachel);

    // Übernommener Speicher – Volumes eines anderen NAS, RAID-Zustand, Freigaben (importe.liste, 19.10.2026)
    knoten.imWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.imNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.imListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.imKachel = kachel('importe', 'laufwerke', t('dashboard.importe'), [knoten.imWert, knoten.imNeben, knoten.imListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('laufwerke', 'import'), text: t('dashboard.importe_link') })])]);
    raster.appendChild(knoten.imKachel);

    // Speicherorte – wo Docker, App-Ordner und VMs liegen (Systemplatte oder übernommenes Volume), mit Platz (19.10.2026)
    knoten.soWert = el('div', { class: 'kachel-wert', text: '–' });
    knoten.soNeben = el('p', { class: 'kachel-neben', text: t('rahmen.laden') });
    knoten.soListe = el('ul', { class: 'dashboard-spiegelung', role: 'list', hidden: true });
    knoten.soKachel = kachel('speicherorte', 'laufwerke', t('dashboard.speicherorte'), [knoten.soWert, knoten.soNeben, knoten.soListe, el('p', { class: 'kachel-fuss' }, [el('a', { href: ctx.hashFuer('laufwerke', 'speicherorte'), text: t('dashboard.speicherorte_link') })])]);
    raster.appendChild(knoten.soKachel);

    knoten.upKachel = kachel('updates', 'herunterladen', t('dashboard.updates'), [knoten.upWert, knoten.upNeben, knoten.upListe, el('p', { class: 'kachel-fuss dashboard-fuss-knopf' }, [knoten.upKnopf, el('a', { href: ctx.hashFuer('system', 'updates'), text: t('dashboard.updates_link') })])]);
    raster.appendChild(knoten.upKachel);
  }

  zeigeAufgaben(); zeigeTapete();
  zeigeApps(); zeigeLaufwerke(); zeigeSpiegelung(); zeigeMeldungen(); zeigeVpn(); zeigeGpu(); zeigeEnergie(); zeigeProtokolle(); zeigeVms(); zeigeRaid(); zeigeWartung();
  zeigeFreigaben(); zeigeUhr(); zeigeSnaps(); zeigeVerbindungen(); zeigeDocker(); zeigeUpdates(); zeigeLinks(); zeigeChat(); zeigeOffice(); zeigeSchutz(); zeigeOrdnerrechte(); zeigeGehaeuse(); zeigeImporte();
  if (knoten.ereignisse) zeigeEreignisse(null);
  zeigeWeltkarte();
  standardKacheln = [...raster.children].map((k) => k.dataset.kachel).filter(Boolean);
  layoutAnwenden();
}

// ---------------------------------------------------------------------------------------------------------------------
// Kachel „Tapete“: zeigt die gewählte Tapete; Vor/Zurück blättert durch eigene Sammlung + Tapeten-Ordner (tapeten.js)
// ---------------------------------------------------------------------------------------------------------------------

const ordnerSchluessel = (d) => (d.tapetenordner ? `${d.tapetenordner.freigabe}/${d.tapetenordner.pfad}` : '');

async function ladeTapeten() {
  const d = aktuelleDarstellung();
  try {
    const r = await tapetenLaden(d);
    if (!ctx) return;
    tapetenStand = { liste: [...r.eigene, ...r.ordner], ordnerFehler: r.ordnerFehler, ordnerSchluessel: ordnerSchluessel(d) };
  } catch { tapetenStand = { liste: [], ordnerFehler: null, ordnerSchluessel: ordnerSchluessel(d) }; }
  zeigeTapete();
}

function zeigeTapete() {
  if (!knoten.tpBild) return;
  const d = aktuelleDarstellung();
  const liste = tapetenStand ? tapetenStand.liste : [];
  const tp = d.tapete;
  const eintrag = tp && liste.find((x) => gleicheTapete(x, tp));
  knoten.tpBild.textContent = '';
  if (tp) {
    const adresse = vorschauAdresse(tp, 512);
    if (adresse) knoten.tpBild.appendChild(el('img', { src: adresse, alt: '', decoding: 'async' }));
    else { const v = el('video', { src: `${tapeteUrl(tp)}#t=0.5`, preload: 'metadata', muted: '', playsinline: '' }); v.muted = true; knoten.tpBild.appendChild(v); }
  } else knoten.tpBild.appendChild(el('span', { class: 'schwach', text: t('dashboard.tapete_keine') }));
  const name = eintrag ? eintrag.name : tp && tp.quelle === 'ordner' ? tp.pfad.split('/').pop() : '';
  const position = eintrag ? t('dashboard.tapete_position', { n: liste.indexOf(eintrag) + 1, gesamt: liste.length }) : '';
  knoten.tpName.textContent = !tapetenStand ? t('rahmen.laden')
    : !liste.length ? t('dashboard.tapete_leer')
      : [name, position, tp && wirksamerZoom(d) !== 100 ? t('dashboard.tapete_zoom', { n: d.zoom }) : '', tp && d.hintergrund !== 'tapete' ? t('dashboard.tapete_aus') : ''].filter(Boolean).join(' · ') || t('dashboard.tapete_anzahl', { n: liste.length });
  knoten.tpZurueck.disabled = liste.length < 1; knoten.tpWeiter.disabled = liste.length < 1;
}

async function tapeteWechseln(richtung) {
  const liste = tapetenStand ? tapetenStand.liste : [];
  const ziel = tapetenNachbar(liste, aktuelleDarstellung().tapete, richtung);
  if (!ziel || !ctx || !ctx.nutzer) return;
  try { await darstellungAendern(ctx.nutzer.name, { hintergrund: 'tapete', tapete: auswahlForm(ziel) }); }
  catch (e) { if (ctx) ctx.melden(t('dashboard.tapete_fehler', { grund: ctx.fehlerText(e) }), 'fehler'); }
  zeigeTapete();
}

/** Darstellung wurde geändert (Fenster oder andere Kachel): Ordner gewechselt → neu laden, sonst nur anzeigen. */
function darstellungGeaendert() {
  if (!ctx) return;
  if (!tapetenStand || tapetenStand.ordnerSchluessel !== ordnerSchluessel(aktuelleDarstellung())) ladeTapeten(); else zeigeTapete();
}

// ---------------------------------------------------------------------------------------------------------------------
// Rasterplatzierung (Betreiber 09.10.: „wie bei einem Salesforce-Dashboard frei verschieben“): 12 Spalten, Zeilen zu
// 40 px, jede Kachel {x, y, b, h} in Zellen (Logik in ./dashboard-raster.js). „Anpassen“: Kachel am Kopf greifen und
// ziehen (Schattenrahmen zeigt das Ziel, andere rutschen live nach unten, Lücken bleiben), Größe an der Ecke ziehen;
// Tastatur: Kachel anwählen, Pfeile verschieben, Umschalt + Pfeile ändern die Größe, Esc bricht ein Ziehen ab.
// Je Nutzer gespeichert (nutzer.einstellungen, Bereich „uebersicht“, Layout-Version 4; ältere werden umgerechnet).
// Alle Kacheln bleiben im DOM (in Lesereihenfolge); ausgeblendete tragen `hidden`. Schmale Bildschirme: untereinander
// in Lesereihenfolge (CSS order), Höhe nach Inhalt, kein Ziehen.
// ---------------------------------------------------------------------------------------------------------------------

const LAYOUT_BEREICH = 'uebersicht';
let standardKacheln = [];     // Kennungen in Aufbau-Reihenfolge
let layout = null;            // gespeicherte Form (v4 {version, kacheln:[{id,x,y,b,h}], ausgeblendet}) | null = Standard
let bearbeiten = false;
let speicherTimer = null;
let zug = null;               // laufendes Ziehen {art, id, k, start, jetzt, w, liste, x, y, scrollY, schritt, zeiger}

function wirksamesLayout() { return layoutAufloesen(layout, standardKacheln); }

function kachelElement(id) { return knoten.raster ? [...knoten.raster.children].find((x) => x.dataset.kachel === id) || null : null; }

/** Zellen per CSSOM an die Kachel (grid-column/-row); `reihe` = Platz in der Lesereihenfolge (CSS order am Handy). */
function zellenAnwenden(k, e, reihe) {
  k.style.gridColumn = `${e.x + 1} / span ${e.b}`;
  k.style.gridRow = `${e.y + 1} / span ${e.h}`;
  if (reihe !== undefined && reihe >= 0) k.style.order = String(reihe);
  k.dataset.zellen = `${e.x},${e.y},${e.b},${e.h}`;
  const g = kindMit(k, 'kachel-werkzeug');
  const text = g && kindMit(g, 'kachel-werkzeug-groesse');
  if (text) text.textContent = t('dashboard.groesse_zellen', { b: e.b, h: e.h });
}

function layoutAnwenden(w = null) {
  const raster = knoten.raster; if (!raster) return;
  zugBeenden(false); // ein Neuaufbau mitten im Ziehen bricht es sauber ab
  const fokus = fokusMerken();
  const wirksam = w || wirksamesLayout();
  const reihe = lesereihenfolge(wirksam.kacheln);
  for (const id of reihe) {
    const k = kachelElement(id); const e = wirksam.kacheln.find((x) => x.id === id);
    if (!k || !e) continue;
    k.hidden = false;
    raster.appendChild(k); // DOM in Lesereihenfolge: Tab-Reihenfolge und Bildschirmleser folgen dem Raster
    zellenAnwenden(k, e, reihe.indexOf(id));
    werkzeugSetzen(k, e);
  }
  for (const id of wirksam.ausgeblendet) { const k = kachelElement(id); if (k) { k.hidden = true; werkzeugSetzen(k, null); } }
  raster.classList.toggle('bearbeiten', bearbeiten);
  kopfKnoepfeZeigen();
  if (knoten.anpassenHinweis) knoten.anpassenHinweis.hidden = !bearbeiten;
  zeigeMesswerte();
  wkSichtbarkeitGeaendert(); // ausgeblendete Weltkarte fragt nicht ab, wieder eingeblendete sofort
  fokusWiederherstellen(fokus);
}

/** Direktes Kindelement mit dieser Klasse (ohne :scope-Selektor). */
function kindMit(k, klasse) { return [...k.children].find((x) => x.classList.contains(klasse)) || null; }

function werkzeugSetzen(k, e) {
  const alt = kindMit(k, 'kachel-werkzeug'); if (alt) alt.remove();
  for (const g of [...k.children].filter((x) => x.classList.contains('kachel-griff'))) g.remove();
  const kopf = kindMit(k, 'kachel-kopf');
  k.classList.remove('wird-bewegt', 'groesse-ziehen');
  if (!bearbeiten || !e) {
    for (const a of ['tabindex', 'aria-roledescription', 'aria-describedby']) k.removeAttribute(a);
    if (kopf) { kopf.classList.remove('kachel-greifbar'); kopf.removeAttribute('title'); }
    return;
  }
  k.setAttribute('tabindex', '0');
  k.setAttribute('aria-roledescription', t('dashboard.kachel_rolle'));
  k.setAttribute('aria-describedby', 'dashboard-tastatur-hilfe');
  if (kopf) { kopf.classList.add('kachel-greifbar'); kopf.setAttribute('title', t('dashboard.kachel_greifen')); }
  k.appendChild(el('div', { class: 'kachel-werkzeug', role: 'toolbar', 'aria-label': t('dashboard.anpassen') }, [
    el('span', { class: 'kachel-werkzeug-groesse', text: t('dashboard.groesse_zellen', { b: e.b, h: e.h }) }),
    el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', title: t('dashboard.ausblenden'), 'aria-label': t('dashboard.ausblenden'), onclick: (ev) => { ev.stopPropagation(); ausblenden(e.id); } }, '✕'),
  ]));
  k.appendChild(el('div', { class: 'kachel-griff kachel-griff-ecke', title: t('dashboard.groesse_ziehen'), 'aria-hidden': 'true', 'data-art': 'ecke' }));
}

// --- Ziehen (Zeiger: Maus, Stift, Touch) ------------------------------------------------------------------------------
/** Pixel je Zelle (Spalte bzw. Zeile inklusive Abstand) aus dem berechneten Stil des Rasters. */
function zellSchritt() {
  const r = knoten.raster;
  let breite = 1200; let abstandX = 16; let abstandY = 16;
  try { breite = r.getBoundingClientRect().width || breite; } catch { /* Standard */ }
  try { const cs = getComputedStyle(r); abstandX = parseFloat(cs.columnGap) || abstandX; abstandY = parseFloat(cs.rowGap) || abstandX; } catch { /* Standard */ }
  return { x: (breite - abstandX * (SPALTEN - 1)) / SPALTEN + abstandX, y: ZEILE_PX + abstandY };
}

function rasterAktiv() {
  try { return getComputedStyle(knoten.raster).display === 'grid'; } catch { return true; }
}

function platzhalterZeigen(e) {
  let p = knoten.platzhalter;
  if (!p) { p = el('div', { class: 'dashboard-platzhalter', 'aria-hidden': 'true' }); knoten.platzhalter = p; }
  if (p.parentNode !== knoten.raster) knoten.raster.appendChild(p);
  p.style.gridColumn = `${e.x + 1} / span ${e.b}`;
  p.style.gridRow = `${e.y + 1} / span ${e.h}`;
}
function platzhalterEntfernen() { if (knoten.platzhalter) knoten.platzhalter.remove(); }

function seitenScroll() { return typeof window !== 'undefined' && Number.isFinite(window.scrollY) ? window.scrollY : 0; }

function zugStarten(ev, k, art) {
  if (zug || !bearbeiten || !rasterAktiv() || (ev.button !== undefined && ev.button !== 0)) return;
  const w = wirksamesLayout(); const e = w.kacheln.find((x) => x.id === k.dataset.kachel); if (!e) return;
  ev.preventDefault();
  try { if (ev.target && ev.target.setPointerCapture && ev.pointerId !== undefined) ev.target.setPointerCapture(ev.pointerId); } catch { /* egal */ }
  zug = { art, id: e.id, k, start: { ...e }, jetzt: { ...e }, w, liste: w.kacheln, x: ev.clientX, y: ev.clientY, scrollY: seitenScroll(), schritt: zellSchritt(), zeiger: ev.pointerId };
  k.classList.add(art === 'bewegen' ? 'wird-bewegt' : 'groesse-ziehen');
  platzhalterZeigen(e);
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', escBeimZiehen, true);
}

function zugBewegen(ev) {
  if (!zug || (ev.pointerId !== undefined && zug.zeiger !== undefined && ev.pointerId !== zug.zeiger)) return;
  ev.preventDefault();
  // am oberen/unteren Fensterrand mitrollen (Ziehen über lange Übersichten)
  if (typeof window !== 'undefined' && typeof window.scrollBy === 'function' && window.innerHeight) {
    if (ev.clientY > window.innerHeight - 48) window.scrollBy(0, 24); else if (ev.clientY < 48) window.scrollBy(0, -24);
  }
  const dx = ev.clientX - zug.x; const dy = ev.clientY - zug.y + (seitenScroll() - zug.scrollY);
  if (zug.art === 'bewegen') zug.k.style.transform = `translate(${dx}px, ${dy}px)`;
  const ziel = zellenNachZiehen(zug.start, { dx, dy, schritt: zug.schritt, art: zug.art === 'bewegen' ? 'bewegen' : 'groesse' });
  if (ziel.x === zug.jetzt.x && ziel.y === zug.jetzt.y && ziel.b === zug.jetzt.b && ziel.h === zug.jetzt.h) return;
  zug.jetzt = ziel;
  zug.liste = kachelSetzen(zug.w.kacheln, zug.id, ziel);
  for (const e of zug.liste) {
    const k = kachelElement(e.id); if (!k) continue;
    if (e.id === zug.id && zug.art === 'bewegen') { const g = kindMit(k, 'kachel-werkzeug'); const tx = g && kindMit(g, 'kachel-werkzeug-groesse'); if (tx) tx.textContent = t('dashboard.groesse_zellen', { b: e.b, h: e.h }); continue; }
    zellenAnwenden(k, e);
  }
  platzhalterZeigen(ziel);
}

function escBeimZiehen(ev) { if (ev.key === 'Escape' && zug) { ev.preventDefault(); zugBeenden(false); } }

/** Laufenden Zug beenden: übernehmen (Loslassen) oder alles an den Startplatz zurück (Esc, Abbruch, Neuaufbau). */
function zugBeenden(uebernehmenJa) {
  if (!zug) return;
  const z = zug; zug = null;
  if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', escBeimZiehen, true);
  z.k.classList.remove('wird-bewegt', 'groesse-ziehen'); z.k.style.transform = '';
  platzhalterEntfernen();
  const geaendert = z.jetzt.x !== z.start.x || z.jetzt.y !== z.start.y || z.jetzt.b !== z.start.b || z.jetzt.h !== z.start.h;
  if (uebernehmenJa && geaendert) { uebernehmen({ kacheln: z.liste, ausgeblendet: z.w.ausgeblendet }); platzAnsagen(z.id); return; }
  for (const e of z.w.kacheln) { const k = kachelElement(e.id); if (k) zellenAnwenden(k, e); }
}

function ziehenEinrichten(raster) {
  raster.addEventListener('pointerdown', (ev) => {
    if (!bearbeiten || zug) return;
    const ziel = ev.target;
    if (!ziel || typeof ziel.closest !== 'function') return;
    const k = ziel.closest('.dashboard-kachel'); if (!k || k.parentNode !== raster) return;
    if (ziel.closest('.kachel-griff-ecke')) { zugStarten(ev, k, 'groesse'); return; }
    if (ziel.closest('button, a, input, select, textarea, [role="button"], .kachel-werkzeug')) return; // Knöpfe im Kopf bleiben bedienbar
    if (ziel.closest('.kachel-kopf')) zugStarten(ev, k, 'bewegen');
  });
  raster.addEventListener('pointermove', zugBewegen);
  raster.addEventListener('pointerup', (ev) => { if (zug && (ev.pointerId === undefined || zug.zeiger === undefined || ev.pointerId === zug.zeiger)) zugBeenden(true); });
  raster.addEventListener('pointercancel', () => zugBeenden(false));
  raster.addEventListener('keydown', tasteAnKachel);
}

// --- Tastatur ---------------------------------------------------------------------------------------------------------
const PFEILE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Angewählte Kachel: Pfeile verschieben um eine Zelle, Umschalt + Pfeile ändern Breite/Höhe um eine Zelle. */
function tasteAnKachel(ev) {
  if (!bearbeiten || zug) return;
  const k = ev.target;
  if (!k || !k.classList || !k.classList.contains('dashboard-kachel') || !k.dataset.kachel) return;
  const d = PFEILE[ev.key]; if (!d) return;
  ev.preventDefault();
  const w = wirksamesLayout(); const e = w.kacheln.find((x) => x.id === k.dataset.kachel); if (!e) return;
  const ziel = zellenNachZiehen(e, { dx: d[0], dy: d[1], schritt: { x: 1, y: 1 }, art: ev.shiftKey ? 'groesse' : 'bewegen' });
  if (ziel.x === e.x && ziel.y === e.y && ziel.b === e.b && ziel.h === e.h) return;
  uebernehmen({ kacheln: kachelSetzen(w.kacheln, e.id, ziel), ausgeblendet: w.ausgeblendet });
  platzAnsagen(e.id);
}

/** Neuen Platz für Bildschirmleser ansagen. */
function platzAnsagen(id) {
  const e = wirksamesLayout().kacheln.find((x) => x.id === id);
  if (!e || !knoten.anpassenAnsage) return;
  knoten.anpassenAnsage.textContent = t('dashboard.position_ansage', { titel: kachelTitel(id), x: e.x + 1, y: e.y + 1, b: e.b, h: e.h });
}

// --- Fokus über den Neuaufbau retten (Kacheln werden in Lesereihenfolge neu eingehängt) --------------------------------
function fokusMerken() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  const k = a && typeof a.closest === 'function' ? a.closest('.dashboard-kachel') : null;
  if (!k || !knoten.raster || k.parentNode !== knoten.raster) return null;
  if (a === k) return { id: k.dataset.kachel, kachel: true };
  if (a.closest('.kachel-werkzeug')) return { id: k.dataset.kachel, label: a.getAttribute('aria-label') };
  return null;
}
function fokusWiederherstellen(f) {
  if (!f || !knoten.raster) return;
  const k = kachelElement(f.id); if (!k) return;
  let ziel = null;
  if (f.kachel) ziel = k.getAttribute('tabindex') !== null ? k : null;
  else {
    const leiste = kindMit(k, 'kachel-werkzeug');
    const knoepfe = leiste ? [...leiste.children].filter((x) => x.tagName === 'BUTTON') : [];
    ziel = knoepfe.find((x) => x.getAttribute('aria-label') === f.label && !x.disabled) || knoepfe.find((x) => !x.disabled) || null;
  }
  try { if (ziel && ziel.focus) ziel.focus({ preventScroll: true }); } catch { /* egal */ }
}

// --- Änderungen übernehmen, ausblenden, hinzufügen, speichern ---------------------------------------------------------
function uebernehmen(w) { layout = layoutSpeicherform(w); layoutAnwenden(); speichernSpaeter(); }

function ausblenden(id) {
  const w = wirksamesLayout();
  uebernehmen({ kacheln: w.kacheln.filter((x) => x.id !== id), ausgeblendet: [...new Set([...w.ausgeblendet, id])] }); // Lücke bleibt
}
function hinzufuegen(id) {
  const w = wirksamesLayout(); if (!standardKacheln.includes(id)) return;
  uebernehmen({ kacheln: [...w.kacheln, { id, x: 0, y: unterkante(w.kacheln), ...standardGroesse(id) }], ausgeblendet: w.ausgeblendet.filter((x) => x !== id) });
}

function kachelTitel(id) {
  const k = kachelElement(id);
  const h = k && k.querySelector('.kachel-titel'); return h ? h.textContent : id;
}

function hinzufuegenDialog() {
  const w = wirksamesLayout();
  const d = ctx.dialog([
    w.ausgeblendet.length
      ? el('ul', { class: 'dashboard-hinzufuegen-liste' }, w.ausgeblendet.map((id) => el('li', {}, [
        el('span', { text: kachelTitel(id) }),
        el('button', { class: 'knopf knopf-klein', type: 'button', onclick: () => { hinzufuegen(id); d.schliessen(); } }, t('dashboard.hinzufuegen_knopf')),
      ])))
      : el('p', { class: 'erklaerung', text: t('dashboard.hinzufuegen_leer') }),
  ], { titel: t('dashboard.kachel_hinzufuegen') });
}

async function standardWiederherstellen() {
  if (!(await ctx.bestaetigen(t('dashboard.standard_frage')))) return;
  layout = null; layoutAnwenden();
  clearTimeout(speicherTimer);
  try { await ctx.api('nutzer.einstellungen.setzen', { name: ctx.nutzer.name, bereich: LAYOUT_BEREICH }); } catch (e) { ctx.melden(t('dashboard.layout_speichern_fehler', { grund: ctx.fehlerText(e) }), 'fehler'); }
}

function speichernSpaeter() {
  clearTimeout(speicherTimer);
  const wert = layout; const name = ctx && ctx.nutzer && ctx.nutzer.name;
  if (!name) return;
  speicherTimer = setTimeout(async () => {
    try { await ctx.api('nutzer.einstellungen.setzen', { name, bereich: LAYOUT_BEREICH, wert }); }
    catch (e) { if (ctx) ctx.melden(t('dashboard.layout_speichern_fehler', { grund: ctx.fehlerText(e) }), 'fehler'); }
  }, 500);
}

async function ladeLayout() {
  const name = ctx && ctx.nutzer && ctx.nutzer.name; if (!name) return;
  try {
    const r = await ctx.api('nutzer.einstellungen.lesen', { name, bereich: LAYOUT_BEREICH });
    const wert = r && r.wert;
    layout = wert && typeof wert === 'object' && Array.isArray(wert.kacheln) ? layoutMigrieren(wert) : null;
  } catch { layout = null; } // ältere Agenten ohne Einstellungen → Standard
  layoutAnwenden();
}

/**
 * Gespeicherte Layouts von vor 0.5.0: „systemplatte“ und „datenplatte“ sind jetzt eine Karte „platte“ – sie übernimmt
 * Platz und Größe der ersten der beiden; ausgeblendet ist sie nur, wenn beide ausgeblendet waren. (Die Umrechnung in
 * Rasterzellen macht layoutAufloesen.)
 */
export function layoutMigrieren(l) {
  const alt = new Set(['systemplatte', 'datenplatte']);
  const kacheln = Array.isArray(l.kacheln) ? l.kacheln : [];
  if (!kacheln.some((k) => k && alt.has(k.id)) && !(l.ausgeblendet || []).some((id) => alt.has(id))) return l;
  const neu = []; let gesetzt = kacheln.some((k) => k && k.id === 'platte');
  for (const k of kacheln) {
    if (!k || !alt.has(k.id)) { neu.push(k); continue; }
    if (!gesetzt) { neu.push({ ...k, id: 'platte' }); gesetzt = true; }
  }
  const aus = (l.ausgeblendet || []).filter((id) => !alt.has(id));
  if (!gesetzt && (l.ausgeblendet || []).filter((id) => alt.has(id)).length === 2) aus.push('platte');
  return { ...l, kacheln: neu, ausgeblendet: aus };
}

function kopfKnoepfeZeigen() {
  const k = knoten.kopfKnoepfe; if (!k) return;
  k.textContent = '';
  if (!bearbeiten) {
    k.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => { bearbeiten = true; layoutAnwenden(); } }, t('dashboard.anpassen')));
    return;
  }
  k.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: hinzufuegenDialog }, t('dashboard.kachel_hinzufuegen')));
  k.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: standardWiederherstellen }, t('dashboard.standard_wiederherstellen')));
  k.appendChild(el('button', { class: 'knopf', type: 'button', onclick: () => { bearbeiten = false; layoutAnwenden(); } }, t('dashboard.anpassen_fertig')));
}

function zeigeApps() {
  if (!knoten.appsWert) return;
  const s = appsStand;
  if (s === null) { knoten.appsWert.textContent = '–'; knoten.appsNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.appsWert.textContent = '–'; knoten.appsNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.appsKachel.classList.remove('warnung'); return; }
  knoten.appsWert.textContent = t('dashboard.apps_wert', { n: s.gesamt });
  knoten.appsNeben.textContent = s.gesamt ? t('dashboard.apps_zusammenfassung', { laufend: s.laufend, gestoppt: s.gestoppt, fehlerhaft: s.fehlerhaft }) : t(ctx && ctx.rolle !== 'admin' ? 'dashboard.apps_keine_fuer_dich' : 'dashboard.apps_keine');
  if (s.portkonflikt) knoten.appsNeben.textContent += ` · ${t('dashboard.apps_portkonflikt', { n: s.portkonflikt })}`;
  // Fehlerhafte/ungesunde Apps färben die Kachel orange (Hinweis), nicht rot – die Datenplatte bleibt die einzige rote Kachel
  knoten.appsKachel.classList.toggle('warnung', s.fehlerhaft > 0 || s.portkonflikt > 0);
  const zeilen = s.zeilen || [];
  knoten.appsListe.textContent = '';
  knoten.appsListe.hidden = !zeilen.length;
  // Wie ZimaOS/CasaOS: Klick auf den Namen öffnet die App; Admins starten/stoppen direkt wie bei Unraid
  const admin = ctx.rolle === 'admin';
  const host = appHost(ctx.zugang, typeof location !== 'undefined' ? location.hostname : '');
  for (const z of zeilen) {
    const stand = t(APP_STAND[z.stufe]);
    const url = z.stufe !== 'gestoppt' ? webuiAufloesen(z.webui, host) : '';
    const titel = url
      ? el('a', { class: 'dashboard-app-titel', href: url, target: '_blank', rel: 'noopener noreferrer', title: t('dashboard.apps_oeffnen', { name: z.titel }), text: z.titel })
      : el('span', { class: 'dashboard-app-titel', text: z.titel });
    const kinder = [el('span', { class: 'dashboard-app-punkt', title: stand, 'aria-hidden': 'true', text: z.stufe === 'gestoppt' ? '○' : '●' }), appBild(z.symbol), titel];
    if (z.update) kinder.push(el('a', { class: 'dashboard-app-update', href: ctx.hashFuer('apps'), title: t('dashboard.apps_update_titel'), text: t('dashboard.apps_update') }));
    if (admin) {
      const knoepfe = el('span', { class: 'dashboard-app-knoepfe' });
      for (const aktion of z.stufe === 'gestoppt' ? ['start'] : ['neustart', 'stopp']) {
        const [zeichen, schluessel] = APP_STEUERN[aktion];
        const k = el('button', { class: 'knopf knopf-zweit knopf-klein dashboard-app-knopf', type: 'button', title: t(schluessel, { name: z.titel }), 'aria-label': t(schluessel, { name: z.titel }), onclick: () => appSteuern(z, aktion, k) }, zeichen);
        knoepfe.appendChild(k);
      }
      kinder.push(el('span', { class: 'nur-lesen', text: stand }), knoepfe);
    } else kinder.push(el('span', { class: 'dashboard-spiegel-stand', text: stand }));
    knoten.appsListe.appendChild(el('li', { class: `dashboard-app dashboard-app-${z.stufe}`, 'data-app': z.name }, kinder));
  }
}

const APP_STAND = Object.freeze({ laeuft: 'dashboard.apps_laeuft', gestoppt: 'dashboard.apps_gestoppt', fehler: 'dashboard.apps_fehler' });
const APP_STEUERN = Object.freeze({ start: ['▶', 'dashboard.apps_start'], neustart: ['↻', 'dashboard.apps_neustart'], stopp: ['■', 'dashboard.apps_stopp'] });

/** Kleines App-Symbol (Quell-URL der Vorlage); fehlt es oder lädt es nicht, bleibt nur der Punkt davor. */
function appBild(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const img = el('img', { class: 'dashboard-app-bild', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: '18', height: '18' });
  img.addEventListener('error', () => img.remove());
  return img;
}

async function appSteuern(z, aktion, knopf) {
  const c = ctx; if (!c) return;
  if (aktion === 'stopp' && !(await c.bestaetigen(t('dashboard.apps_stopp_frage', { name: z.titel })))) return;
  knopf.disabled = true;
  try { await c.api('apps.steuern', { name: z.name, aktion }); }
  catch (e) { if (ctx === c) c.melden(t('dashboard.apps_steuern_fehler', { name: z.titel, grund: c.fehlerText(e) }), 'fehler'); }
  if (ctx === c) ladeApps(); else knopf.disabled = false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kacheln Freigaben, Uhr, Schnappschüsse, Verbindungen, Docker-Speicher, Updates (Betreiber 15.10.2026: „alles bauen“)
// ---------------------------------------------------------------------------------------------------------------------

function zeigeFreigaben() {
  if (!knoten.fgWert) return;
  const s = freigabenStand;
  if (s === null) { knoten.fgWert.textContent = '–'; knoten.fgNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.fgWert.textContent = '–'; knoten.fgNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.fgWert.textContent = t('dashboard.freigaben_wert', { n: s.length });
  const summe = s.reduce((x, f) => x + (f.belegt || 0), 0);
  knoten.fgNeben.textContent = s.length ? t('dashboard.freigaben_summe', { belegt: format.groesse(summe) }) : t('dashboard.freigaben_keine');
  knoten.fgListe.textContent = '';
  knoten.fgListe.hidden = !s.length;
  for (const f of s) {
    const neben = f.gesperrt ? t('dashboard.freigaben_gesperrt') : f.belegt == null ? t('dashboard.freigaben_wird_gemessen')
      : f.grenze ? t('dashboard.frei_von', { frei: format.groesse(Math.max(0, f.grenze - f.belegt)), gesamt: format.groesse(f.grenze) }) : '';
    knoten.fgListe.appendChild(el('li', { class: 'dashboard-laufwerk', 'data-freigabe': f.name }, [
      el('div', { class: 'dashboard-laufwerk-kopf' }, [
        el('a', { class: 'dashboard-laufwerk-name', href: ctx.hashFuer('dateien', f.name), text: f.name }),
        el('span', { class: 'dashboard-laufwerk-prozent', text: f.belegt == null ? '–' : format.groesse(f.belegt) }),
      ]),
      f.prozent != null ? balken(f.prozent) : null,
      neben ? el('p', { class: 'dashboard-laufwerk-neben', text: neben }) : null,
    ]));
  }
}

async function ladeFreigaben() {
  const c = ctx; if (!c) return;
  try { const r = await c.api('freigaben.liste', {}); freigabenStand = freigabenZeilen(r); } catch (e) { freigabenStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] freigaben.liste:', e.message); }
  if (wurzel && ctx === c) zeigeFreigaben();
}

function zeigeUhr() {
  if (!knoten.uhrZeit) return;
  const d = new Date();
  try {
    knoten.uhrZeit.textContent = d.toLocaleTimeString(gebiet(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    knoten.uhrDatum.textContent = d.toLocaleDateString(gebiet(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch { knoten.uhrZeit.textContent = d.toTimeString().slice(0, 8); knoten.uhrDatum.textContent = d.toDateString(); }
}

/** Seltene Kacheln: höchstens alle 2 min neu fragen (außer `neu`). */
function faellig(id, neu) {
  if (!neu && zuletztGeladen[id] && Date.now() - zuletztGeladen[id] < SELTEN_MS) return false;
  zuletztGeladen[id] = Date.now(); return true;
}

function zeigeSnaps() {
  if (!knoten.snWert) return;
  const s = snapStand;
  if (s === null) { knoten.snWert.textContent = '–'; knoten.snNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.snWert.textContent = '–'; knoten.snNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  const ziele = Array.isArray(s.ziele) ? s.ziele : [];
  knoten.snWert.textContent = t('dashboard.snap_wert', { n: ziele.reduce((x, z) => x + (z.anzahl || 0), 0) });
  const kommend = ziele.filter((z) => z.naechster).sort((a, b) => (a.naechster < b.naechster ? -1 : 1))[0];
  knoten.snNeben.textContent = kommend ? t('dashboard.snap_naechster', { wann: termin(kommend.naechster), ziel: snapZiel(kommend.ziel) }) : t('dashboard.snap_kein_plan');
  knoten.snListe.textContent = '';
  for (const z of ziele) {
    knoten.snListe.appendChild(el('li', { class: `dashboard-spiegel${z.fehler ? ' dashboard-spiegel-fehler' : ''}`, 'data-ziel': z.ziel, title: z.naechster ? t('dashboard.snap_naechster_titel', { wann: termin(z.naechster) }) : '' }, [
      el('span', { class: 'dashboard-spiegel-name', text: z.anzahl == null ? snapZiel(z.ziel) : `${snapZiel(z.ziel)} · ${format.zahl(z.anzahl)}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: z.fehler ? t('dashboard.nicht_verfuegbar') : z.letzter ? format.zeit(z.letzter) : t('dashboard.snap_keiner') }),
    ]));
  }
}
function snapZiel(ziel) { return ziel === 'system' ? t('dashboard.snap_system') : ziel; }

async function ladeSnaps(neu = false) {
  const c = ctx; if (!c || c.rolle !== 'admin' || !faellig('snap', neu)) return;
  try { snapStand = await c.api('snapshots.uebersicht', {}); } catch (e) { snapStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] snapshots.uebersicht:', e.message); }
  if (wurzel && ctx === c) zeigeSnaps();
}

const VERB_ART = Object.freeze({ web: 'dashboard.verb_web', smb: 'dashboard.verb_smb', ssh: 'dashboard.verb_ssh', webdav: 'dashboard.verb_webdav', nfs: 'dashboard.verb_nfs' });

function zeigeVerbindungen() {
  if (!knoten.vbWert) return;
  const s = verbStand;
  if (s === null) { knoten.vbWert.textContent = '–'; knoten.vbNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.vbWert.textContent = '–'; knoten.vbNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  const { zeilen, dateien } = verbindungenZeilen(s.agent, s.web);
  knoten.vbWert.textContent = t('dashboard.verb_wert', { n: zeilen.length });
  knoten.vbNeben.textContent = dateien.length ? t('dashboard.verb_offen', { n: dateien.length }) : (s.agent && !s.agent.smb ? t('dashboard.verb_ohne_smb') : '');
  knoten.vbListe.textContent = '';
  knoten.vbListe.hidden = !zeilen.length;
  for (const z of zeilen) {
    const name = `${t(VERB_ART[z.art])}${z.nutzer ? ` · ${z.nutzer}` : ''}${z.du ? ` ${t('dashboard.verb_du')}` : ''}`;
    knoten.vbListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-verb-${z.art}`, title: z.info || '' }, [
      el('span', { class: 'dashboard-spiegel-name', text: name }),
      el('span', { class: 'dashboard-spiegel-stand', text: [z.adresse, z.art === 'webdav' ? z.info : ''].filter(Boolean).join(' ') }),
    ]));
  }
  knoten.vbDateien.textContent = '';
  knoten.vbDateien.hidden = !dateien.length;
  for (const d of dateien.slice(0, 5)) {
    knoten.vbDateien.appendChild(el('li', { class: 'dashboard-spiegel', title: `${d.freigabe}/${d.datei}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${d.freigabe}/${d.datei}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: d.nutzer || '' }),
    ]));
  }
}

async function ladeVerbindungen() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try {
    const [agent, web] = await Promise.all([c.api('system.verbindungen', {}), c.get('/api/sitzungen').catch(() => [])]);
    verbStand = { agent, web: Array.isArray(web) ? web : [] };
  } catch (e) { verbStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] system.verbindungen:', e.message); }
  if (wurzel && ctx === c) zeigeVerbindungen();
}

async function linkKopieren(text) {
  try { await navigator.clipboard.writeText(text); ctx.melden(t('dashboard.links_kopiert'), 'erfolg', 2500); } catch {
    const feld = el('input', { class: 'eingabe', value: text, readOnly: true });
    ctx.dialog([el('p', { class: 'erklaerung', text: t('dashboard.links_kopieren_manuell') }), feld], { titel: t('dashboard.links') });
    feld.focus(); feld.select();
  }
}

async function linkLoeschen(z, knopf) {
  const c = ctx; if (!c) return;
  if (!(await c.bestaetigen(t('dashboard.links_loeschen_frage', { name: z.name }), { titel: t('dashboard.links_loeschen'), ok: t('dashboard.links_loeschen'), gefahr: true }))) return;
  knopf.disabled = true;
  try { await c.api('dateien.link.loeschen', { token: z.token }); c.melden(t('dashboard.links_geloescht', { name: z.name }), 'erfolg'); } catch (e) { c.zeigeFehler(e); }
  await ladeLinks();
}

function zeigeLinks() {
  if (!knoten.lkWert) return;
  const s = linksStand;
  if (s === null) { knoten.lkWert.textContent = '–'; knoten.lkNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.lkWert.textContent = '–'; knoten.lkNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.lkListe.hidden = true; return; }
  const { zeilen, aktiv } = linksZeilen(s);
  knoten.lkWert.textContent = t('dashboard.links_wert', { n: zeilen.length });
  knoten.lkNeben.textContent = !zeilen.length ? t('dashboard.links_keine') : aktiv ? t('dashboard.links_aktiv', { n: aktiv }) : t('dashboard.links_ruhig');
  knoten.lkListe.textContent = '';
  knoten.lkListe.hidden = !zeilen.length;
  for (const z of zeilen) {
    const adresse = linkAdresse(ctx.zugang, z);
    const wer = ctx.rolle === 'admin' && z.nutzer && z.nutzer !== (ctx.nutzer && ctx.nutzer.name) ? ` · ${t('dashboard.links_von', { nutzer: z.nutzer })}` : '';
    const loeschen = el('button', { class: 'knopf knopf-zweit knopf-klein dashboard-app-knopf', type: 'button', title: t('dashboard.links_loeschen_titel', { name: z.name }), 'aria-label': t('dashboard.links_loeschen_titel', { name: z.name }) }, [symbol('loeschen')]);
    loeschen.addEventListener('click', () => linkLoeschen(z, loeschen));
    const kopf = el('div', { class: 'dashboard-app' }, [
      el('span', { class: `dashboard-app-punkt dashboard-link-punkt${z.aktiv.length ? ' aktiv' : ''}`, 'aria-hidden': 'true', text: z.aktiv.length ? '●' : '○' }),
      el('a', { class: 'dashboard-app-titel', href: adresse, target: '_blank', rel: 'noopener noreferrer', title: `${z.ziel}${wer}`, text: z.name }),
      el('span', { class: 'dashboard-spiegel-stand', title: z.ablauf ? format.zeitGenau(z.ablauf) : '', text: z.ablauf ? t('dashboard.links_bis', { zeit: format.zeit(z.ablauf) }) : t('dashboard.links_dauerhaft') }),
      el('span', { class: 'dashboard-app-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit knopf-klein dashboard-app-knopf', type: 'button', title: t('dashboard.links_kopieren', { name: z.name }), 'aria-label': t('dashboard.links_kopieren', { name: z.name }), onclick: () => linkKopieren(adresse) }, [symbol('kopieren')]),
        loeschen,
      ]),
    ]);
    const unter = el('ul', { class: 'dashboard-link-zugriffe', role: 'list' });
    for (const a of z.aktiv) {
      unter.appendChild(el('li', { class: 'dashboard-link-aktiv', title: a.seit ? t('dashboard.links_seit', { zeit: format.zeitGenau(a.seit) }) : '' }, [
        el('span', { class: 'dashboard-spiegel-name', text: [a.ip, a.ort].filter(Boolean).join(' · ') }),
        el('span', { class: 'dashboard-spiegel-stand', text: a.laeuft ? t('dashboard.links_laedt') : t('dashboard.links_schaut') }),
      ]));
    }
    if (!z.aktiv.length) {
      unter.appendChild(el('li', { class: 'schwach' }, [el('span', { class: 'dashboard-spiegel-name', text: z.zuletzt
        ? t('dashboard.links_zuletzt', { wann: format.zeit(z.zuletzt.zeit), wer: [z.zuletzt.ip, z.zuletzt.ort].filter(Boolean).join(' · ') })
        : t('dashboard.links_nie') })]));
    }
    knoten.lkListe.appendChild(el('li', { class: 'dashboard-link', 'data-link': z.token.slice(0, 8) }, [kopf, unter]));
  }
}

function zeigeSchutz() {
  if (!knoten.asWert) return;
  const s = schutzStand;
  if (s === null) { knoten.asWert.textContent = '–'; knoten.asNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.asWert.textContent = '–'; knoten.asNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.asListe.hidden = true; return; }
  const sperren = Array.isArray(s.sperren) ? s.sperren : [];
  const letzte = Array.isArray(s.letzte) ? s.letzte : [];
  knoten.asWert.textContent = sperren.length ? t('dashboard.schutz_gesperrt', { n: sperren.length }) : t('dashboard.schutz_aktiv');
  knoten.asNeben.textContent = t('dashboard.schutz_neben', { fehler: s.fehler_24h || 0, land: s.land_24h || 0, laender: (s.laender || []).join(', ') || t('dashboard.schutz_alle_laender') });
  knoten.asListe.textContent = '';
  for (const g of sperren.slice(0, 4)) {
    knoten.asListe.appendChild(el('li', { class: 'dashboard-spiegel dashboard-spiegel-fehler', title: t('dashboard.schutz_bis', { zeit: format.zeitGenau(g.bis) }) }, [
      el('span', { class: 'dashboard-spiegel-name', text: [g.ip, g.ort].filter(Boolean).join(' · ') }),
      el('span', { class: 'dashboard-spiegel-stand', text: t('dashboard.schutz_bis', { zeit: format.zeit(g.bis) }) }),
    ]));
  }
  for (const a of letzte.slice(0, 3)) {
    knoten.asListe.appendChild(el('li', { class: 'dashboard-spiegel', title: format.zeitGenau(a.zeit) }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${a.nutzer} · ${[a.ip, a.ort].filter(Boolean).join(' · ')}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: format.zeit(a.zeit) }),
    ]));
  }
  if (!sperren.length && !letzte.length) knoten.asListe.appendChild(el('li', { class: 'schwach' }, [el('span', { class: 'dashboard-spiegel-name', text: t('dashboard.schutz_keine') })]));
  knoten.asListe.hidden = false;
}

/** Zeilen der Kachel „Ordnerrechte“: fehlende Ordner zuerst, dann nach Freigabe/Pfad; höchstens `max`. */
export function ordnerrechteZeilen(stand, max = 5) {
  const liste = stand && Array.isArray(stand.ordnerrechte) ? stand.ordnerrechte : [];
  return [...liste].sort((a, b) => (a.vorhanden === false) !== (b.vorhanden === false) ? (a.vorhanden === false ? -1 : 1) : `${a.freigabe}/${a.pfad}`.localeCompare(`${b.freigabe}/${b.pfad}`, 'de')).slice(0, max);
}

function zeigeOrdnerrechte() {
  if (!knoten.orWert) return;
  const s = ordnerrechteStand;
  if (s === null) { knoten.orWert.textContent = '–'; knoten.orNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.orWert.textContent = '–'; knoten.orNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.orListe.hidden = true; return; }
  const alle = Array.isArray(s.ordnerrechte) ? s.ordnerrechte : [];
  const a = s.letzter_abgleich;
  knoten.orWert.textContent = t('dashboard.ordnerrechte_wert', { n: alle.length });
  knoten.orNeben.textContent = alle.length
    ? t('dashboard.ordnerrechte_neben', { freigaben: new Set(alle.map((x) => x.freigabe)).size, stand: a && a.zeit ? t('dashboard.ordnerrechte_geprueft', { zeit: format.zeit(a.zeit) }) : t('dashboard.ordnerrechte_ungeprueft') })
    : t('dashboard.ordnerrechte_keine');
  knoten.orListe.textContent = '';
  const fehlt = alle.filter((x) => x.vorhanden === false).length;
  if (fehlt) knoten.orListe.appendChild(el('li', { class: 'dashboard-spiegel dashboard-spiegel-fehler' }, [el('span', { class: 'dashboard-spiegel-name', text: t('dashboard.ordnerrechte_fehlt', { n: fehlt }) })]));
  if (a && a.fehler) knoten.orListe.appendChild(el('li', { class: 'dashboard-spiegel dashboard-spiegel-fehler' }, [el('span', { class: 'dashboard-spiegel-name', text: t('dashboard.ordnerrechte_fehler', { fehler: a.fehler }) })]));
  for (const z of ordnerrechteZeilen(s)) {
    knoten.orListe.appendChild(el('li', { class: `dashboard-spiegel${z.vorhanden === false ? ' dashboard-spiegel-fehler' : ''}`, title: regelnKurz(z.regeln) }, [
      el('a', { class: 'dashboard-spiegel-name', href: ctx.hashFuer('dateien', z.freigabe, z.pfad), text: `${z.freigabe}/${z.pfad}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: z.vorhanden === false ? t('freigaben.ordnerrechte_fehlt') : regelnKurz(z.regeln) }),
    ]));
  }
  knoten.orListe.hidden = !knoten.orListe.childNodes.length;
}

function zeigeFahgit() {
  if (!knoten.fgWert) return;
  const s = fahgitStand;
  if (s === null) { knoten.fgWert.textContent = '–'; knoten.fgNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.fgWert.textContent = '–'; knoten.fgNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.fgListe.hidden = true; return; }
  const alle = Array.isArray(s.apps) ? s.apps : [];
  const neu = alle.filter((a) => a.neuer).length;
  knoten.fgWert.textContent = t('dashboard.fahgit_wert', { n: alle.length });
  if (!s.verbunden) {
    knoten.fgNeben.textContent = t('dashboard.fahgit_keine_verbindung');
    knoten.fgLink.href = ctx.hashFuer('system', 'fahgit'); knoten.fgLink.textContent = t('dashboard.fahgit_verbindung_link');
  } else {
    knoten.fgNeben.textContent = !alle.length ? t('dashboard.fahgit_keine') : (neu ? t('dashboard.fahgit_neben_neu', { n: neu }) : t('dashboard.fahgit_neben_aktuell'));
    knoten.fgLink.href = ctx.hashFuer('apps', 'fahgit'); knoten.fgLink.textContent = t('dashboard.fahgit_link');
  }
  knoten.fgListe.textContent = '';
  for (const a of alle.slice(0, 6)) {
    const zustand = a.fehler ? 'fehler' : (a.neuer ? 'laeuft' : 'ok');
    const stand = a.fehler ? a.fehler : (a.neuer ? t('dashboard.fahgit_zeile_neu', { commit: String(a.neu || '').slice(0, 7) }) : `${a.zweig} @ ${String(a.commit || '').slice(0, 7)}${a.auto ? ` · ${t('dashboard.fahgit_zeile_auto')}` : ''}`);
    knoten.fgListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${zustand}`, title: `${a.pfad} – ${a.betreff || ''}` }, [
      el('a', { class: 'dashboard-spiegel-name', href: ctx.hashFuer('apps', 'ziel', a.name), text: a.titel || a.name }),
      el('span', { class: 'dashboard-spiegel-stand', text: stand }),
    ]));
  }
  knoten.fgListe.hidden = !knoten.fgListe.childNodes.length;
}

async function ladeFahgit() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { fahgitStand = await c.api('apps.fahgit.stand', {}); } catch (e) { fahgitStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] apps.fahgit.stand:', e.message); }
  if (wurzel && ctx === c) zeigeFahgit();
}

function zeigeGehaeuse() {
  if (!knoten.ghWert) return;
  const s = gehaeuseStand;
  if (s === null) { knoten.ghWert.textContent = '–'; knoten.ghNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.ghWert.textContent = '–'; knoten.ghNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.ghListe.hidden = true; return; }
  if (!s.modell) { knoten.ghWert.textContent = '–'; knoten.ghNeben.textContent = t('dashboard.gehaeuse_keines'); knoten.ghListe.hidden = true; return; }
  const f = s.luefter || {};
  const k = (f.kanaele || [])[0];
  knoten.ghWert.textContent = k && k.rpm != null ? t('dashboard.gehaeuse_wert', { rpm: k.rpm }) : '–';
  knoten.ghNeben.textContent = [s.modell, f.verfuegbar ? t(`dashboard.gehaeuse_modus_${f.modus || 'normal'}`) : t('dashboard.gehaeuse_bios')].join(' · ');
  knoten.ghListe.textContent = '';
  const tt = f.temperaturen || {};
  const zeile = (name, wert, fehler = false) => el('li', { class: `dashboard-spiegel${fehler ? ' dashboard-spiegel-fehler' : ''}` }, [el('span', { class: 'dashboard-spiegel-name', text: name }), el('span', { class: 'dashboard-spiegel-stand', text: wert })]);
  for (const x of f.kanaele || []) if (x.steht) knoten.ghListe.appendChild(zeile(t('dashboard.gehaeuse_steht', { nr: x.nr }), '100 %', true));
  if (Number.isFinite(tt.cpu)) knoten.ghListe.appendChild(zeile(t('dashboard.gehaeuse_cpu'), `${Math.round(tt.cpu)} °C`));
  if ((tt.platten || []).length) knoten.ghListe.appendChild(zeile(t('dashboard.gehaeuse_platten'), `${Math.round(Math.max(...tt.platten))} °C`));
  if ((tt.nvme || []).length) knoten.ghListe.appendChild(zeile(t('dashboard.gehaeuse_nvme'), `${Math.round(Math.max(...tt.nvme))} °C`));
  knoten.ghListe.appendChild(zeile(t('dashboard.gehaeuse_leds'), !s.leds?.verfuegbar ? t('dashboard.gehaeuse_leds_nicht') : s.leds.an ? `${s.leds.helligkeit} %` : t('dashboard.gehaeuse_leds_aus')));
  knoten.ghListe.hidden = false;
}

async function ladeGehaeuse() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { gehaeuseStand = await c.api('hardware.status', {}); } catch (e) { gehaeuseStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] hardware.status:', e.message); }
  if (wurzel && ctx === c) zeigeGehaeuse();
}

function zeigeImporte() {
  if (!knoten.imWert) return;
  const s = importeStand;
  if (s === null) { knoten.imWert.textContent = '–'; knoten.imNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.imWert.textContent = '–'; knoten.imNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.imListe.hidden = true; return; }
  const v = s.volumes || [];
  knoten.imWert.textContent = t('dashboard.importe_wert', { n: v.length });
  knoten.imNeben.textContent = v.length ? t('dashboard.importe_neben', { freigaben: v.reduce((n, x) => n + (x.freigaben || []).length, 0) }) : t('dashboard.importe_keine');
  knoten.imListe.textContent = '';
  for (const x of v.slice(0, 5)) {
    const defekt = x.raid?.degraded || (x.raid?.mitglieder || []).some((m) => m.zustand === 'defekt');
    const schlecht = !x.vorhanden || !x.eingehaengt || defekt;
    const arbeitet = x.raid && x.raid.sync && x.raid.sync !== 'idle';
    const stand = !x.vorhanden ? t('dashboard.importe_fehlt') : !x.eingehaengt ? t('dashboard.importe_aus')
      : arbeitet ? t('dashboard.importe_raid_arbeitet', { prozent: x.raid.fortschritt != null ? Math.floor(x.raid.fortschritt * 100) : '?' })
        : defekt ? t('dashboard.importe_raid_schlecht') : x.raid ? t('dashboard.importe_raid_ok', { stufe: String(x.raid.stufe || '').replace(/^raid/, 'RAID ') }) : t('dashboard.importe_ok');
    knoten.imListe.appendChild(el('li', { class: `dashboard-spiegel${schlecht ? ' dashboard-spiegel-fehler' : ''}`, title: (x.freigaben || []).map((f) => f.name).join(', ') }, [
      el('span', { class: 'dashboard-spiegel-name', text: x.bezeichnung || x.uuid }), el('span', { class: 'dashboard-spiegel-stand', text: stand }),
    ]));
  }
  knoten.imListe.hidden = !v.length;
}

function zeigeOrte() {
  if (!knoten.soWert) return;
  const s = orteStand;
  if (s === null) { knoten.soWert.textContent = '–'; knoten.soNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.soWert.textContent = '–'; knoten.soNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.soListe.hidden = true; return; }
  const b = s.bereiche || [];
  const aufVolume = b.filter((x) => x.ort === 'volume');
  knoten.soWert.textContent = aufVolume.length ? t('dashboard.speicherorte_wert_volume', { n: aufVolume.length }) : t('dashboard.speicherorte_wert_system');
  knoten.soNeben.textContent = s.system && Number.isFinite(s.system.frei) ? t('dashboard.speicherorte_neben', { frei: format.groesse(s.system.frei) }) : '';
  knoten.soListe.textContent = '';
  for (const x of b) {
    const schlecht = x.ort === 'volume' && !x.aktiv;
    const ort = x.ort === 'volume' ? (x.bezeichnung || x.volume) : t('dashboard.speicherorte_system');
    knoten.soListe.appendChild(el('li', { class: `dashboard-spiegel${schlecht ? ' dashboard-spiegel-fehler' : ''}`, title: x.pfad }, [
      el('span', { class: 'dashboard-spiegel-name', text: t(`dashboard.speicherorte_${x.bereich}`) }),
      el('span', { class: 'dashboard-spiegel-stand', text: schlecht ? t('dashboard.speicherorte_fehlt') : x.platz && Number.isFinite(x.platz.frei) ? `${ort} · ${format.groesse(x.platz.frei)}` : ort }),
    ]));
  }
  knoten.soListe.hidden = !b.length;
}

async function ladeOrte() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { orteStand = await c.api('speicherorte.liste', {}); } catch (e) { orteStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] speicherorte.liste:', e.message); }
  if (wurzel && ctx === c) zeigeOrte();
}

async function ladeImporte() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { importeStand = await c.api('importe.liste', {}); } catch (e) { importeStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] importe.liste:', e.message); }
  if (wurzel && ctx === c) zeigeImporte();
}

async function ladeOrdnerrechte() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { ordnerrechteStand = await c.api('freigaben.ordnerrechte.liste', {}); } catch (e) { ordnerrechteStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] freigaben.ordnerrechte.liste:', e.message); }
  if (wurzel && ctx === c) zeigeOrdnerrechte();
}

async function ladeSchutz() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  try { schutzStand = await c.get('/api/anmeldeschutz'); } catch (e) { schutzStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] /api/anmeldeschutz:', e.message); }
  if (wurzel && ctx === c) zeigeSchutz();
}

function zeigeChat() {
  if (!knoten.chWert) return;
  const s = chatUebersicht;
  if (s === null) { knoten.chWert.textContent = '–'; knoten.chNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.chWert.textContent = '–'; knoten.chNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.chListe.hidden = true; return; }
  const { zeilen, summe } = chatZeilen(s);
  knoten.chWert.textContent = t('dashboard.chat_wert', { n: summe });
  knoten.chNeben.textContent = !zeilen.length ? t('dashboard.chat_leer') : summe ? '' : t('dashboard.chat_keine');
  knoten.chNeben.hidden = !knoten.chNeben.textContent;
  knoten.chListe.textContent = '';
  knoten.chListe.hidden = !zeilen.length;
  for (const z of zeilen) {
    knoten.chListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-chat-zeile${z.ungelesen ? ' ungelesen' : ''}` }, [
      el('a', { class: 'dashboard-spiegel-name', href: ctx.hashFuer('chat', z.id), text: `${z.art === 'dm' ? '@ ' : '# '}${z.name}${z.stumm ? ' 🔕' : ''}` }),
      z.ungelesen ? el('span', { class: 'dashboard-chat-zahl', 'aria-label': t('navigation.abzeichen', { n: z.ungelesen }), text: z.ungelesen > 99 ? '99+' : String(z.ungelesen) }) : null,
      el('span', { class: 'dashboard-spiegel-stand', title: z.letzte ? format.zeitGenau(z.letzte.zeit) : '', text: z.letzte ? format.zeit(z.letzte.zeit) : '' }),
    ]));
  }
  knoten.chExtra.textContent = '';
  for (const k of erweiterungenBauen('kachel', s)) knoten.chExtra.appendChild(k);
}

function zeigeOffice() {
  if (!knoten.ofWert) return;
  const s = officeStand;
  const listenAus = () => { for (const k of [knoten.ofZuletztTitel, knoten.ofZuletzt, knoten.ofKartenTitel, knoten.ofKarten]) k.hidden = true; };
  if (s === null) { knoten.ofWert.textContent = '–'; knoten.ofNeben.textContent = t('rahmen.laden'); knoten.ofNeben.hidden = false; listenAus(); return; }
  if (s === 'fehler') { knoten.ofWert.textContent = '–'; knoten.ofNeben.textContent = t('dashboard.nicht_verfuegbar'); knoten.ofNeben.hidden = false; listenAus(); return; }
  const { zuletzt, karten, anzahl_faellig: n } = officeZeilen(s.liste, s.faellig);
  knoten.ofWert.textContent = t('dashboard.office_faellig_wert', { n });
  knoten.ofNeben.textContent = !zuletzt.length && !karten.length ? t('dashboard.office_leer') : '';
  knoten.ofNeben.hidden = !knoten.ofNeben.textContent;
  knoten.ofZuletzt.textContent = '';
  knoten.ofZuletzt.hidden = knoten.ofZuletztTitel.hidden = !zuletzt.length;
  for (const d of zuletzt) {
    knoten.ofZuletzt.appendChild(el('li', { class: 'dashboard-spiegel dashboard-office-zeile' }, [
      symbol(['dokument', 'tabelle', 'board'].includes(d.art) ? d.art : 'office'),
      el('a', { class: 'dashboard-spiegel-name', href: ctx.hashFuer('office', 'd', d.id), text: d.name }),
      el('span', { class: 'dashboard-spiegel-stand', title: d.geaendert ? format.zeitGenau(d.geaendert) : '', text: d.geaendert ? format.zeit(d.geaendert) : '' }),
    ]));
  }
  knoten.ofKarten.textContent = '';
  knoten.ofKarten.hidden = knoten.ofKartenTitel.hidden = !karten.length;
  for (const k of karten) {
    knoten.ofKarten.appendChild(el('li', { class: `dashboard-spiegel dashboard-office-karte${k.ueberfaellig ? ' warnung' : ''}` }, [
      el('a', { class: 'dashboard-spiegel-name', href: ctx.hashFuer('office', 'd', k.board_id), text: k.titel || '–' }),
      el('span', { class: 'dashboard-spiegel-info', text: k.board_name }),
      el('span', { class: 'dashboard-spiegel-stand', text: k.faellig ? datumKurz(k.faellig) : '' }),
    ]));
  }
}

/** „JJJJ-MM-TT“ kurz in der Sprache der Oberfläche. */
function datumKurz(datum) {
  const d = new Date(`${datum}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(datum);
  try { return d.toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit' }); } catch { return String(datum); }
}

async function ladeOffice(neu = false) {
  const c = ctx; if (!c || !faellig('office', neu)) return;
  try {
    const [liste, karten] = await Promise.all([c.api('office.liste', {}), c.api('office.faellig', {})]);
    officeStand = { liste: liste && typeof liste === 'object' ? liste : {}, faellig: karten && typeof karten === 'object' ? karten : { karten: [] } };
  } catch (e) { officeStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] office:', e.message); }
  if (wurzel && ctx === c) zeigeOffice();
}

async function ladeChat() {
  const c = ctx; if (!c) return;
  try { const r = await c.api('chat.uebersicht', {}); chatUebersicht = r && typeof r === 'object' ? r : { raeume: [] }; } catch (e) { chatUebersicht = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] chat.uebersicht:', e.message); }
  if (wurzel && ctx === c) zeigeChat();
}

async function ladeLinks() {
  const c = ctx; if (!c) return;
  try { const r = await c.get('/api/links'); linksStand = r && typeof r === 'object' ? r : { links: [], orte: {} }; } catch (e) { linksStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] /api/links:', e.message); }
  if (wurzel && ctx === c) zeigeLinks();
}

const DOCKER_ART = Object.freeze({ images: 'dashboard.docker_images', container: 'dashboard.docker_container', volumes: 'dashboard.docker_volumes', cache: 'dashboard.docker_cache', logs: 'dashboard.docker_logs' });

function zeigeDocker() {
  if (!knoten.dkWert) return;
  const s = dockerStand;
  knoten.dkKnopf.disabled = !!dockerAufgabe || s === null || s === 'fehler';
  if (s === null) { knoten.dkWert.textContent = '–'; knoten.dkNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.dkWert.textContent = '–'; knoten.dkNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  const { zeilen, summe } = dockerZeilen(s);
  knoten.dkWert.textContent = format.groesse(summe);
  knoten.dkNeben.textContent = dockerAufgabe ? t('dashboard.docker_raeumt') : (s.wurzel ? t('dashboard.docker_wurzel', { pfad: s.wurzel }) : '');
  knoten.dkListe.textContent = '';
  for (const z of zeilen) {
    const zusatz = z.art === 'container' ? t('dashboard.docker_laufen', { n: z.aktiv, gesamt: z.anzahl }) : z.anzahl != null ? format.zahl(z.anzahl) : '';
    knoten.dkListe.appendChild(el('li', { class: 'dashboard-spiegel', 'data-art': z.art }, [
      el('span', { class: 'dashboard-spiegel-name', text: zusatz ? `${t(DOCKER_ART[z.art])} · ${zusatz}` : t(DOCKER_ART[z.art]) }),
      el('span', { class: 'dashboard-spiegel-stand', text: format.groesse(z.bytes) }),
    ]));
  }
}

async function ladeDocker(neu = false) {
  const c = ctx; if (!c || c.rolle !== 'admin' || !faellig('docker', neu)) return;
  try { dockerStand = await c.api('apps.docker_speicher', neu ? { neu: true } : {}); } catch (e) { dockerStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] apps.docker_speicher:', e.message); }
  if (wurzel && ctx === c) zeigeDocker();
}

async function dockerAufraeumen() {
  const c = ctx; if (!c || dockerAufgabe) return;
  if (!(await c.bestaetigen(t('dashboard.docker_aufraeumen_frage')))) return;
  try {
    const r = await c.api('apps.docker_aufraeumen', {});
    dockerAufgabe = r && r.aufgabe ? String(r.aufgabe) : null;
    if (!dockerAufgabe) { c.melden(t('dashboard.docker_frei', { groesse: format.groesse((r && r.frei_bytes) || 0) }), 'erfolg'); ladeDocker(true); }
  } catch (e) { c.melden(t('dashboard.docker_aufraeumen_fehler', { grund: c.fehlerText(e) }), 'fehler'); }
  if (ctx === c) zeigeDocker();
}

/** Aufgaben-Ereignis des „Aufräumen“ abschließen: Meldung mit freigegebenem Platz, Belegung neu messen. */
function dockerAufgabeEnde(e) {
  const id = e && (e.aufgabe ?? e.id);
  if (!dockerAufgabe || String(id) !== dockerAufgabe || !AUFGABE_ENDE.has(e.status)) return;
  dockerAufgabe = null;
  if (e.status === 'fertig') ctx.melden(t('dashboard.docker_frei', { groesse: format.groesse((e.ergebnis && e.ergebnis.frei_bytes) || 0) }), 'erfolg');
  else if (e.status === 'fehler') ctx.melden(t('dashboard.docker_aufraeumen_fehler', { grund: ctx.fehlerText(e.fehler || e) }), 'fehler');
  ladeDocker(true);
}

function zeigeUpdates() {
  if (!knoten.upWert) return;
  const s = updatesStand;
  if (s === null) { knoten.upWert.textContent = '–'; knoten.upNeben.textContent = t('rahmen.laden'); return; }
  const z = updatesZusammenfassung(s === 'fehler' ? null : s, roh.hinweise);
  knoten.upWert.textContent = z.anzahl ? t('dashboard.updates_wert', { n: z.anzahl }) : t('dashboard.updates_aktuell');
  knoten.upNeben.textContent = s === 'fehler' ? t('dashboard.updates_apps_fehler')
    : s.laeuft ? t('dashboard.updates_laeuft') : s.geprueft ? t('dashboard.updates_geprueft', { wann: format.zeit(s.geprueft) }) : t('dashboard.updates_nie');
  knoten.upKnopf.disabled = s !== 'fehler' && !!s.laeuft;
  knoten.upKachel.classList.toggle('warnung', !!(z.ubuntu && z.ubuntu.sicherheit));
  const l = knoten.upListe; l.textContent = '';
  const zeile = (name, stand, klasse = '', href = null) => l.appendChild(el('li', { class: `dashboard-spiegel${klasse}` }, [
    href ? el('a', { class: 'dashboard-spiegel-name', href, text: name }) : el('span', { class: 'dashboard-spiegel-name', text: name }),
    el('span', { class: 'dashboard-spiegel-stand', text: stand }),
  ]));
  zeile(t('dashboard.updates_fahnas'), status && status.version ? status.version : '–');
  if (z.ubuntu) zeile(t('dashboard.updates_ubuntu'), z.ubuntu.anzahl ? (z.ubuntu.sicherheit ? t('dashboard.updates_pakete_sicherheit', { n: z.ubuntu.anzahl, s: z.ubuntu.sicherheit }) : t('dashboard.updates_pakete', { n: z.ubuntu.anzahl })) : t('dashboard.updates_ok'), z.ubuntu.anzahl ? ' dashboard-spiegel-laeuft' : '', ctx.hashFuer('system', 'updates'));
  if (s !== 'fehler') {
    for (const a of z.apps) zeile(`⬆ ${a.titel}`, t('dashboard.updates_bereit'), ' dashboard-spiegel-laeuft', ctx.hashFuer('apps'));
    if (!z.apps.length) zeile(t('dashboard.updates_apps'), z.unbekannt ? t('dashboard.updates_apps_unbekannt', { n: z.unbekannt }) : t('dashboard.updates_ok'));
  }
}

async function ladeUpdates(neu = false) {
  const c = ctx; if (!c || c.rolle !== 'admin' || !faellig('updates', neu)) return;
  try { updatesStand = await c.api('apps.updates', {}); } catch (e) { updatesStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] apps.updates:', e.message); }
  if (wurzel && ctx === c) zeigeUpdates();
}

async function updatesPruefen() {
  const c = ctx; if (!c) return;
  knoten.upKnopf.disabled = true;
  if (updatesStand && updatesStand !== 'fehler') { updatesStand = { ...updatesStand, laeuft: true }; zeigeUpdates(); }
  try {
    const [apps] = await Promise.all([c.api('apps.updates', { pruefen: true }), ladeHinweise(true)]);
    updatesStand = apps; zuletztGeladen.updates = Date.now();
  } catch (e) { if (ctx === c) c.melden(t('dashboard.updates_fehler', { grund: c.fehlerText(e) }), 'fehler'); }
  if (wurzel && ctx === c) zeigeUpdates();
}

function zeigeLaufwerke() {
  if (!knoten.lwWert) return;
  const s = laufwerkeStand;
  if (s === null) { knoten.lwWert.textContent = '–'; knoten.lwNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') {
    knoten.lwWert.textContent = '–'; knoten.lwNeben.textContent = t('dashboard.nicht_verfuegbar');
    // Liste mit den letzten Werten stehen lassen – ein kurzer Aussetzer des Agenten soll nicht flackern
    return;
  }
  knoten.lwWert.textContent = t('dashboard.laufwerke_wert', { n: s.eingehaengt });
  knoten.lwNeben.textContent = s.extern ? t('dashboard.laufwerke_zusammenfassung', { extern: s.extern, eingehaengt: s.eingehaengt }) : t('dashboard.laufwerke_keine');
  zeigeLaufwerksListe();
}

/** Eine Zeile je eingehängtem externem Laufwerk: Name, Prozent, Balken, „X von Y frei“; die Kachel färbt das vollste. */
function zeigeLaufwerksListe() {
  const liste = knoten.lwListe; if (!liste) return;
  const platten = Array.isArray(externStand) ? externStand : [];
  liste.textContent = '';
  liste.hidden = !platten.length;
  for (const p of platten) {
    liste.appendChild(el('li', { class: 'dashboard-laufwerk', 'data-laufwerk': p.id }, [
      el('div', { class: 'dashboard-laufwerk-kopf' }, [
        el('span', { class: 'dashboard-laufwerk-name', text: p.titel }),
        el('span', { class: 'dashboard-laufwerk-prozent', text: p.prozent == null ? '–' : format.prozent(p.prozent) }),
      ]),
      balken(p.prozent),
      el('p', { class: 'dashboard-laufwerk-neben', text: p.gesamt != null && p.frei != null ? t('dashboard.frei_von', { frei: format.groesse(p.frei), gesamt: format.groesse(p.gesamt) }) : '' }),
    ]));
  }
  const voll = platten.reduce((m, p) => (p.prozent != null && p.prozent > m ? p.prozent : m), -1);
  stufeSetzen(knoten.lwKachel, voll >= 0 ? voll : null);
}

function zeigeSpiegelung() {
  if (!knoten.spWert) return;
  const s = spiegelStand;
  if (s === null) { knoten.spWert.textContent = '–'; knoten.spNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.spWert.textContent = '–'; knoten.spNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  // Art auf einen Blick (09.11.2026): „5 Sicherungen“, „2 Spiegelungen“ oder „3 Sicherungen · 1 Spiegelung“
  knoten.spWert.textContent = s.sicherungen && s.spiegelungen ? t('dashboard.spiegelung_wert_arten', { s: s.sicherungen, p: s.spiegelungen })
    : (s.sicherungen ? t('dashboard.spiegelung_wert_sicherungen', { n: s.sicherungen }) : t('dashboard.spiegelung_wert', { n: s.gesamt }));
  if (knoten.spLink) { knoten.spLink.href = ctx.hashFuer(...(s.gesamt ? ['spiegelung'] : ['spiegelung', 'neu'])); knoten.spLink.textContent = t(s.gesamt ? 'dashboard.spiegelung_link' : 'dashboard.spiegelung_erste'); }
  knoten.spNeben.textContent = !s.gesamt ? t('dashboard.spiegelung_keine')
    : (s.laeuft ? t('dashboard.spiegelung_laeuft', { n: s.laeuft }) : (s.fehler ? t('dashboard.spiegelung_fehler', { n: s.fehler }) : t('dashboard.spiegelung_alle_ok')));
  knoten.spListe.textContent = '';
  knoten.spListe.hidden = !s.zeilen.length;
  for (const z of s.zeilen) {
    let stand;
    if (z.laeuft) stand = z.fortschritt != null ? `⟳ ${format.prozent(Math.round(z.fortschritt * 100))}` : '⟳';
    else if (!z.aktiv) stand = t('dashboard.spiegelung_pausiert');
    else if (!z.ergebnis) stand = t('dashboard.spiegelung_nie');
    else stand = `${format.zeit(z.zeit)} ${z.ergebnis === 'ok' ? '✓' : (z.ergebnis === 'fehler' ? '✗' : '⚠')}`;
    knoten.spListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${z.laeuft ? 'laeuft' : (z.ergebnis || 'nie')}`, 'data-spiegelung': z.id }, [
      el('span', { class: 'dashboard-spiegel-name', title: t(z.art === 'sicherung' ? 'dashboard.spiegelung_art_sicherung' : 'dashboard.spiegelung_art_spiegelung') }, [symbol(z.art === 'sicherung' ? 'sicherung' : 'spiegelung', `dashboard-spiegel-art dashboard-spiegel-art-${z.art}`), z.name]),
      el('span', { class: 'dashboard-spiegel-stand', text: stand }),
    ]));
  }
  // Fehler färben die Kachel orange (Hinweis) – wie bei den Apps
  knoten.spKachel.classList.toggle('warnung', s.fehler > 0);
}

/** Fortschritts-Ereignis „spiegelung“ ohne neue Abfrage einarbeiten; Laufende → neu laden. */
function spiegelungEreignis(d) {
  if (!d || !d.id) return;
  if (d.zustand === 'laeuft' && spiegelStand && spiegelStand !== 'fehler') {
    const z = spiegelStand.zeilen.find((x) => x.id === d.id);
    if (z) {
      if (!z.laeuft) { z.laeuft = true; spiegelStand.laeuft++; }
      z.fortschritt = d.fortschritt ?? null;
      zeigeSpiegelung();
      return;
    }
  }
  ladeSpiegelung();
}

/** Letzte Meldungen: Anzahl Warnungen/Fehler der letzten 24 h und die fünf neuesten Zeilen. */
export function meldungenZusammenfassung(liste, jetzt = Date.now()) {
  const l = Array.isArray(liste) ? liste.filter((m) => m && m.zeit) : [];
  const tag = l.filter((m) => jetzt - Date.parse(m.zeit) < 86_400_000);
  return { gesamt24: tag.length, probleme24: tag.filter((m) => m.stufe === 'warnung' || m.stufe === 'fehler').length, zeilen: l.slice(0, 5) };
}

function zeigeMeldungen() {
  if (!knoten.mlWert) return;
  const s = meldungenStand;
  if (s === null) { knoten.mlWert.textContent = '–'; knoten.mlNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.mlWert.textContent = '–'; knoten.mlNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.mlWert.textContent = t('dashboard.meldungen_wert', { n: s.gesamt24 });
  knoten.mlNeben.textContent = s.zeilen.length ? (s.probleme24 ? t('dashboard.meldungen_probleme', { n: s.probleme24 }) : t('dashboard.meldungen_ruhig')) : t('dashboard.meldungen_keine');
  knoten.mlListe.textContent = '';
  knoten.mlListe.hidden = !s.zeilen.length;
  for (const m of s.zeilen) {
    knoten.mlListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${m.stufe === 'fehler' ? 'fehler' : 'ok'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${m.stufe === 'fehler' ? '✗' : m.stufe === 'warnung' ? '⚠' : 'ℹ'} ${agentText(m.titel)}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: format.zeit(m.zeit) }),
    ]));
  }
  knoten.mlKachel.classList.toggle('warnung', s.probleme24 > 0);
}

async function ladeMeldungen() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('benachrichtigungen.verlauf', {}); } catch (e) { if (!meldungenStand) meldungenStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] benachrichtigungen.verlauf:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) meldungenStand = meldungenZusammenfassung(r);
  zeigeMeldungen();
}

/** VM-Kachel: laufende von allen, je VM eine Zeile. */
export function vmsZusammenfassung(r) {
  const vms = Array.isArray(r && r.vms) ? r.vms : [];
  return { verfuegbar: !(r && r.verfuegbar === false), laufen: vms.filter((v) => v.zustand === 'laeuft').length, gesamt: vms.length, abgestuerzt: vms.filter((v) => v.zustand === 'fehler' || (v.autostart && v.zustand === 'aus')).length, zeilen: vms.slice(0, 5) };
}

function zeigeVms() {
  if (!knoten.vmWert) return;
  const s = vmStand;
  if (s === null) { knoten.vmWert.textContent = '–'; knoten.vmNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler' || !s.verfuegbar) { knoten.vmWert.textContent = '–'; knoten.vmNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.vmWert.textContent = t('dashboard.vms_wert', { n: s.laufen, gesamt: s.gesamt });
  knoten.vmNeben.textContent = s.gesamt ? (s.abgestuerzt ? t('dashboard.vms_probleme', { n: s.abgestuerzt }) : '') : t('dashboard.vms_keine');
  knoten.vmKachel.classList.toggle('warnung', s.abgestuerzt > 0);
  knoten.vmListe.textContent = '';
  knoten.vmListe.hidden = !s.zeilen.length;
  for (const v of s.zeilen) {
    const ok = v.zustand === 'laeuft';
    knoten.vmListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${ok ? 'ok' : v.zustand === 'fehler' ? 'fehler' : 'nie'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${ok ? '●' : '○'} ${v.name}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: v.ip || (ok ? '' : t('dashboard.vms_aus')) }),
    ]));
  }
}

async function ladeVms() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('vms.liste', {}); } catch (e) { if (!vmStand) vmStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] vms.liste:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) { roh.vms = r; vmStand = vmsZusammenfassung(r); zeigeHandlungsbedarf(); }
  zeigeVms();
}

/** RAID-Kachel: Verbünde mit Zustand; Warnung, sobald einer nicht in Ordnung ist. */
export function raidZusammenfassung(r) {
  const v = Array.isArray(r && r.verbuende) ? r.verbuende : [];
  const ok = v.filter((x) => x.zustand === 'ok').length;
  return { gesamt: v.length, ok, gestoert: v.filter((x) => !['ok', 'wiederaufbau', 'umbau'].includes(x.zustand)).length, zeilen: v.map((x) => ({ name: x.name, stufe: x.stufe, zustand: x.zustand, fortschritt: x.fortschritt || null, platz: x.platz || null })) };
}

const RAID_ZUSTAND = Object.freeze({ ok: 'dashboard.raid_z_ok', wiederaufbau: 'dashboard.raid_z_wiederaufbau', beeintraechtigt: 'dashboard.raid_z_beeintraechtigt', ausgefallen: 'dashboard.raid_z_ausgefallen', fehlt: 'dashboard.raid_z_fehlt', umbau: 'dashboard.raid_z_umbau' });

function zeigeRaid() {
  if (!knoten.rdWert) return;
  const s = raidStand;
  if (s === null) { knoten.rdWert.textContent = '–'; knoten.rdNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.rdWert.textContent = '–'; knoten.rdNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.rdWert.textContent = s.gesamt ? t('dashboard.raid_wert', { n: s.ok, gesamt: s.gesamt }) : '0';
  knoten.rdNeben.textContent = s.gesamt ? (s.gestoert ? t('dashboard.raid_probleme', { n: s.gestoert }) : '') : t('dashboard.raid_keine');
  knoten.rdKachel.classList.toggle('warnung', s.gestoert > 0);
  knoten.rdListe.textContent = '';
  knoten.rdListe.hidden = !s.zeilen.length;
  for (const v of s.zeilen) {
    const f = v.fortschritt;
    const stand = v.zustand === 'wiederaufbau' && f ? t('dashboard.raid_z_wiederaufbau_prozent', { prozent: Math.round(f.prozent) })
      : v.zustand === 'umbau' && f ? t('dashboard.raid_z_umbau_prozent', { prozent: Math.round(f.prozent) })
      : v.zustand === 'ok' && f ? t('dashboard.raid_abgleich', { prozent: Math.round(f.prozent) })
        : v.zustand === 'ok' && v.platz && v.platz.gesamt ? `${format.groesse(v.platz.gesamt - v.platz.frei)} / ${format.groesse(v.platz.gesamt)}` : t(RAID_ZUSTAND[v.zustand] || RAID_ZUSTAND.fehlt);
    knoten.rdListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${v.zustand === 'ok' ? 'ok' : v.zustand === 'wiederaufbau' ? 'laeuft' : 'fehler'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${v.zustand === 'ok' ? '●' : v.zustand === 'wiederaufbau' ? '◐' : '✗'} ${v.name} (${String(v.stufe || '').toUpperCase().replace('RAID', 'RAID ')})` }),
      el('span', { class: 'dashboard-spiegel-stand', text: stand }),
    ]));
  }
}

async function ladeRaid() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('raid.liste', {}); } catch (e) { if (!raidStand) raidStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] raid.liste:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) { roh.raid = r; raidStand = raidZusammenfassung(r); zeigeHandlungsbedarf(); }
  zeigeRaid();
}

/** Protokoll-Kachel: aktive Protokolle mit Dienstzustand. */
export function protokolleZusammenfassung(c) {
  const z = (c && c.zustand) || {};
  const zeilen = c && c.smb && c.smb.aktiv === false ? [] : [['SMB', z.smb || 'active']];
  if (c && c.sftp && c.sftp.aktiv) zeilen.push(['SFTP', z.sftp]);
  if (c && c.webdav && c.webdav.aktiv) zeilen.push([`WebDAV :${c.webdav.port}`, z.webdav]);
  if (c && c.nfs && c.nfs.aktiv) zeilen.push([`NFS (${(c.nfs.freigaben || []).length})`, z.nfs]);
  if (c && c.dlna && c.dlna.aktiv) zeilen.push([`DLNA „${c.dlna.name}“`, z.dlna]);
  return { zeilen, zusatz: zeilen.filter(([n]) => n !== 'SMB').length, gestoert: zeilen.some(([, s]) => s && s !== 'active') };
}

function zeigeProtokolle() {
  if (!knoten.prWert) return;
  const s = protoStand;
  if (s === null) { knoten.prWert.textContent = '–'; knoten.prNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.prWert.textContent = '–'; knoten.prNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.prWert.textContent = t('dashboard.protokolle_wert', { n: s.zeilen.length });
  knoten.prNeben.textContent = !s.zeilen.length ? t('dashboard.protokolle_alle_aus') : s.zusatz ? '' : t('dashboard.protokolle_keine');
  knoten.prKachel.classList.toggle('warnung', s.gestoert);
  knoten.prListe.textContent = '';
  for (const [name, zustand] of s.zeilen) {
    knoten.prListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${zustand === 'active' ? 'ok' : 'fehler'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${zustand === 'active' ? '●' : '✗'} ${name}` }),
    ]));
  }
}

async function ladeProtokolle() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('protokolle.lesen', {}); } catch (e) { if (!protoStand) protoStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] protokolle.lesen:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) { roh.proto = r; protoStand = protokolleZusammenfassung(r); zeigeHandlungsbedarf(); }
  zeigeProtokolle();
}

function zeigeEnergie() {
  if (!knoten.enWert) return;
  const s = energieStand;
  if (s === null) { knoten.enWert.textContent = '–'; knoten.enNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.enWert.textContent = '–'; knoten.enNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  const u = s.usv_aktiv && s.usv && !s.usv.fehler ? s.usv : null;
  knoten.enWert.textContent = !s.usv_aktiv ? t('dashboard.energie_usv_keine') : !u ? '–' : u.akku ? t('dashboard.energie_usv_akku') : t('dashboard.energie_usv_netz');
  knoten.enNeben.textContent = u && u.ladung !== null && u.ladung !== undefined ? t('dashboard.energie_ladung', { wert: u.ladung }) : (s.usv_aktiv && s.usv && s.usv.fehler ? s.usv.fehler : '');
  knoten.enKachel.classList.toggle('warnung', !!(u && u.akku) || !!(s.usv_aktiv && s.usv && s.usv.fehler));
  knoten.enListe.textContent = '';
  const zeilen = [];
  if (s.naechstes_aus) zeilen.push([t('dashboard.energie_aus', { zeit: format.zeit(s.naechstes_aus) }), 'nie']);
  if (s.naechstes_an) zeilen.push([t('dashboard.energie_an', { zeit: format.zeit(s.naechstes_an) }), 'ok']);
  if (!s.naechstes_aus) zeilen.push([t('dashboard.energie_kein_plan'), 'nie']);
  zeilen.push([t('dashboard.energie_wol', { zustand: t(s.wol ? 'dashboard.energie_wol_an' : 'dashboard.energie_wol_aus') }), s.wol ? 'ok' : 'nie']);
  for (const [text, art] of zeilen) knoten.enListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${art}` }, [el('span', { class: 'dashboard-spiegel-name', text })]));
}

async function ladeEnergie() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('energie.status', {}); } catch (e) { if (!energieStand) energieStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] energie.status:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) { roh.energie = r; energieStand = r; zeigeHandlungsbedarf(); }
  zeigeEnergie();
}

/** GPU-Kachel: Wert (Auslastung oder Takt), Modell, Apps. */
export function gpuZusammenfassung(g) {
  const karten = Array.isArray(g && g.karten) ? g.karten : [];
  const smi = (g && g.nvidia && Array.isArray(g.nvidia.smi) && g.nvidia.smi[0]) || null;
  const k = karten.find((x) => x.hersteller === 'nvidia') || karten[0] || null;
  let wert = null;
  if (smi && smi.auslastung !== null) wert = { art: 'last', zahl: smi.auslastung };
  else if (k && k.auslastung !== null && k.auslastung !== undefined) wert = { art: 'last', zahl: k.auslastung };
  else if (k && k.takt) wert = { art: 'takt', zahl: k.takt.aktuell, max: k.takt.max };
  return { modell: k ? `${k.hersteller_name} ${k.modell}`.trim() : null, wert, apps: Array.isArray(g && g.apps) ? g.apps : [], nvidiaOffen: !!(g && g.nvidia && g.nvidia.karte && !g.nvidia.bereit) };
}

/** Systemübersicht: CPU, RAM, Netz aus den Messwerten (jede Sekunde), GPU aus gpu.lesen (alle 30 s). */
function zeigeSystemleiste() {
  if (!knoten.slCpu || !letzterMesswert) return;
  const m = letzterMesswert;
  knoten.slCpu.wert.textContent = m.cpu == null ? '–' : format.prozent(m.cpu);
  knoten.slCpu.neben.textContent = [m.temp == null ? '' : `${format.zahl(m.temp, 0)} °C`, cpuZeile(m.cpuInfo)].filter(Boolean).join(' · ');
  zeichneKurve(knoten.slCpuKurve, [{ werte: reihen.cpu }], 100);
  knoten.slRam.wert.textContent = m.ramProzent == null ? '–' : format.prozent(m.ramProzent);
  knoten.slRam.neben.textContent = m.ramGesamt != null && m.ramBelegt != null ? t('dashboard.belegt_von', { belegt: format.groesse(m.ramBelegt), gesamt: format.groesse(m.ramGesamt) }) : '';
  zeichneKurve(knoten.slRamKurve, [{ werte: reihen.ram }], 100);
  knoten.slNetz.wert.textContent = `↓ ${m.rx == null ? '–' : format.rate(m.rx)}`;
  knoten.slNetz.neben.textContent = t('dashboard.sl_netz_tx', { rate: m.tx == null ? '–' : format.rate(m.tx) });
  zeichneKurve(knoten.slNetzKurve, [
    { werte: reihen.rx, farbe: cssFarbe('--fahnas-akzent', '#0e8a8a') },
    { werte: reihen.tx, farbe: cssFarbe('--fahnas-warnung', '#b26a00') },
  ], null);
  const dat = findePlatte('daten');
  knoten.slSpeicher.wert.textContent = dat && dat.prozent != null ? format.prozent(dat.prozent) : '–';
  knoten.slSpeicher.neben.textContent = dat && dat.gesamt != null && dat.frei != null ? t('dashboard.frei_von', { frei: format.groesse(dat.frei), gesamt: format.groesse(dat.gesamt) }) : t('dashboard.platte_unbekannt');
  setzeBalken(knoten.slSpeicherBalken, dat ? dat.prozent : null);
}

function zeigeSystemleisteGpu() {
  const z = knoten.slGpu; if (!z) return;
  const s = gpuStand;
  const anteil = s && typeof s === 'object' && s.wert ? (s.wert.art === 'last' ? s.wert.zahl : s.wert.max ? (100 * s.wert.zahl) / s.wert.max : null) : null;
  setzeBalken(knoten.slGpuBalken, anteil);
  if (s === null) { z.wert.textContent = '–'; z.neben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { z.wert.textContent = '–'; z.neben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  if (!s.modell) { z.wert.textContent = '–'; z.neben.textContent = t('dashboard.gpu_keine'); return; }
  z.wert.textContent = !s.wert ? '–' : s.wert.art === 'last' ? format.prozent(s.wert.zahl) : t('dashboard.sl_gpu_takt', { aktuell: s.wert.zahl });
  z.neben.textContent = s.wert && s.wert.art === 'takt' && s.wert.max ? t('dashboard.sl_gpu_max', { modell: s.modell, max: s.wert.max }) : s.modell;
}

function zeigeGpu() {
  zeigeSystemleisteGpu();
  if (!knoten.gpWert) return;
  const s = gpuStand;
  if (s === null) { knoten.gpWert.textContent = '–'; knoten.gpNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.gpWert.textContent = '–'; knoten.gpNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  if (!s.modell) { knoten.gpWert.textContent = '–'; knoten.gpNeben.textContent = t('dashboard.gpu_keine'); knoten.gpListe.hidden = true; return; }
  knoten.gpWert.textContent = !s.wert ? '–' : s.wert.art === 'last' ? format.prozent(s.wert.zahl) : t('dashboard.gpu_takt', { aktuell: s.wert.zahl, max: s.wert.max });
  knoten.gpNeben.textContent = `${s.modell}${s.nvidiaOffen ? ` – ${t('dashboard.gpu_nvidia_offen')}` : ''}`;
  knoten.gpListe.textContent = '';
  knoten.gpListe.hidden = false;
  if (!s.apps.length) knoten.gpListe.appendChild(el('li', { class: 'dashboard-spiegel dashboard-spiegel-nie' }, [el('span', { class: 'dashboard-spiegel-name', text: t('dashboard.gpu_apps_keine') })]));
  for (const a of s.apps.slice(0, 5)) {
    knoten.gpListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${a.laeuft ? 'ok' : 'nie'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${a.laeuft ? '●' : '○'} ${a.app}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: a.art === 'nvidia' ? 'NVIDIA' : 'Intel/AMD' }),
    ]));
  }
  knoten.gpKachel.classList.toggle('warnung', s.nvidiaOffen);
}

async function ladeGpu() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('gpu.lesen', {}); } catch (e) { if (!gpuStand) gpuStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] gpu.lesen:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) gpuStand = gpuZusammenfassung(r);
  zeigeGpu();
}

/** VPN-Kachel: Zusammenfassung aus vpn.status (Geräte) und vpn.lesen (Selbsttest). */
export function vpnZusammenfassung(status, lesen) {
  const geraete = Array.isArray(status && status.geraete) ? status.geraete : [];
  return { aktiv: !!(status && status.aktiv), laeuft: !!(status && status.laeuft), gesamt: geraete.length, verbunden: geraete.filter((g) => g.verbunden).length,
    zeilen: geraete.slice(0, 5), test: lesen && lesen.selbsttest ? lesen.selbsttest.gesamt : null };
}

function zeigeVpn() {
  if (!knoten.vpWert) return;
  const s = vpnStand;
  if (s === null) { knoten.vpWert.textContent = '–'; knoten.vpNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.vpWert.textContent = '–'; knoten.vpNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  knoten.vpListe.textContent = '';
  knoten.vpKachel.classList.toggle('warnung', s.aktiv && (!s.laeuft || s.test === 'fehler'));
  if (!s.aktiv) { knoten.vpWert.textContent = t('dashboard.vpn_aus'); knoten.vpNeben.textContent = t('dashboard.vpn_aus_neben'); knoten.vpListe.hidden = true; return; }
  knoten.vpWert.textContent = t('dashboard.vpn_wert', { n: s.verbunden, gesamt: s.gesamt });
  const teile = [];
  if (!s.laeuft) teile.push(t('dashboard.vpn_laeuft_nicht')); else if (!s.gesamt) teile.push(t('dashboard.vpn_keine'));
  if (s.test) teile.push(t('dashboard.vpn_test', { ergebnis: t(VPN_GESAMT_TEXT[s.test] || VPN_GESAMT_TEXT.fehler) }));
  knoten.vpNeben.textContent = teile.join(' ');
  knoten.vpListe.hidden = !s.zeilen.length;
  for (const g of s.zeilen) {
    knoten.vpListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${g.verbunden ? 'ok' : 'nie'}` }, [
      el('span', { class: 'dashboard-spiegel-name', text: `${g.verbunden ? '●' : '○'} ${g.name}` }),
      el('span', { class: 'dashboard-spiegel-stand', text: g.handshake ? format.zeit(g.handshake) : '–' }),
    ]));
  }
}

async function ladeVpn() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let st = null; let le = null;
  try { [st, le] = await Promise.all([c.api('vpn.status', {}), c.api('vpn.lesen', {})]); } catch (e) { if (!vpnStand) vpnStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] vpn:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (st !== null) { roh.vpn = { status: st, lesen: le }; vpnStand = vpnZusammenfassung(st, le); zeigeHandlungsbedarf(); }
  zeigeVpn();
}

async function ladeSpiegelung() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('spiegelung.liste', {}); } catch (e) { if (!spiegelStand) spiegelStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] spiegelung.liste:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) { roh.spiegelung = r; spiegelStand = spiegelungZusammenfassung(r); zeigeHandlungsbedarf(); }
  zeigeSpiegelung();
}

async function ladeApps() {
  const c = ctx; if (!c) return;
  try { const r = await c.api('apps.liste', {}); roh.apps = r; appsStand = { ...appsZusammenfassung(r), zeilen: appsZeilen(r) }; } catch (e) { appsStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] apps.liste:', e.message); }
  if (wurzel && ctx === c) { zeigeApps(); zeigeHandlungsbedarf(); }
}

async function ladeLaufwerke() {
  const c = ctx; if (!c) return;
  let liste = null;
  try { liste = await c.api('laufwerke.liste', {}); } catch (e) { laufwerkeStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] laufwerke.liste:', e.message); }
  if (!wurzel || ctx !== c) return;
  // Fehler (z. B. Agent kurz weg): Laufwerks-Kacheln bleiben mit den letzten Werten stehen
  if (liste !== null) { roh.laufwerke = liste; laufwerkeStand = laufwerkeZusammenfassung(liste); externStand = externePlatten(liste); }
  zeigeLaufwerke(); zeigeHandlungsbedarf();
}

// ---------------------------------------------------------------------------------------------------------------------
// Weltkarte (nur Admins): Verbindungen des NAS eingehend oder ausgehend aus netz.verbindungen (schnittstellen.md §13).
// Die Kachel hält Umschalter, Listen, Hinweise und die Abfrage (alle 5 s, nur bei sichtbarer Kachel und sichtbarem
// Tab); gezeichnet wird vom Karten-Modul ./weltkarte.js, das erst beim Aufbau für einen Admin nachgeladen wird.
// Die Richtung merkt sich jeder Nutzer (nutzer.einstellungen, Bereich „weltkarte“, {richtung}).
// ---------------------------------------------------------------------------------------------------------------------

const WK_BEREICH = 'weltkarte';
const WK_TAKT_MS = 5000;
const WK_LISTE_KURZ = 10;              // je Liste zunächst 10 Einträge, „alle zeigen“ klappt den Rest auf
const WK_LISTE_GEBUNDEN = 60;          // neben der Karte: so viele Einträge vorbereiten, wie höchstens hineinpassen können
const WK_RICHTUNGEN = ['ein', 'aus'];
const WK_STILLE_FEHLER = ['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'];
const KARTEN_MODUL = () => import('./weltkarte.js');
let kartenLader = KARTEN_MODUL;        // Tests setzen eine Attrappe (_test.setzeKartenLader)

function wkLeer() {
  return {
    richtung: 'aus', gewaehlt: false, ergebnis: null, fehler: null, filter: null, offen: { fern: false, lokal: false },
    karte: null, karteFehlt: false, laeuft: null, takt: null, io: null, ro: null, hoerer: null, imBild: true, sichtbar: true,
    einpassenGeplant: false,
  };
}
const wk = { ...wkLeer(), nr: 0 }; // nr zählt über alle Einbindungen weiter – alte Antworten passen nie zu einer neuen Abfrage

/** Flagge als Emoji aus zwei Regional-Indicator-Zeichen ('DE' → 🇩🇪); ohne gültigen Ländercode ''. */
export function flagge(land) {
  const code = String(land || '');
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
}

/** Liest ein Ergebnis von netz.verbindungen tolerant (Form §4.6): fehlende Listen werden leer, fehlende Blöcke neutral. */
export function verbindungenLesen(r) {
  const e = r && typeof r === 'object' ? r : {};
  const liste = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
  return {
    ...e,
    aufzeichnung: e.aufzeichnung !== false,
    werkzeug: e.werkzeug && typeof e.werkzeug === 'object' ? e.werkzeug : { ok: true, hinweis: null },
    geo: e.geo && typeof e.geo === 'object' ? e.geo : { quelle: 'keine', stand: null, hinweis: null },
    gegenstellen: liste(e.gegenstellen),
    lokal: liste(e.lokal),
  };
}

/** Meiste Verbindungen zuerst, dann Datenmenge, dann Name/IP – stabile Reihenfolge trotz Aktualisierung alle 5 s. */
function nachAnzahl(a, b) {
  return (Number(b.anzahl) || 0) - (Number(a.anzahl) || 0) || (Number(b.bytes) || 0) - (Number(a.bytes) || 0) || String(a.ip || a.name || '').localeCompare(String(b.ip || b.name || ''));
}

function uhrzeit(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try { return d.toLocaleTimeString(gebiet(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return d.toISOString(); }
}

function bewegungReduziert() {
  try { return typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function baueWeltkarte() {
  const richtungsKnopf = (richtung, text) => el('button', { class: 'knopf knopf-zweit knopf-klein dashboard-wk-richtung', type: 'button', 'data-richtung': richtung, 'aria-pressed': 'false', onclick: () => richtungWaehlen(richtung) }, text);
  const mehrKnopf = (art) => el('button', { class: 'knopf knopf-zweit knopf-klein dashboard-wk-mehr', type: 'button', 'data-liste': art, 'aria-expanded': 'false', hidden: true, onclick: () => { wk.offen[art] = !wk.offen[art]; wkListenZeigen(); } });
  knoten.wkEin = richtungsKnopf('ein', t('dashboard.weltkarte_eingehend'));
  knoten.wkAus = richtungsKnopf('aus', t('dashboard.weltkarte_ausgehend'));
  knoten.wkHinweise = el('div', { class: 'dashboard-wk-hinweise', 'aria-live': 'polite' });
  knoten.wkKarte = el('div', { class: 'dashboard-wk-karte' });
  knoten.wkSumme = el('p', { class: 'kachel-neben dashboard-wk-summe' });
  knoten.wkTitelFern = el('h3', { class: 'dashboard-wk-titel dashboard-wk-titel-fern' });
  knoten.wkListeFern = el('ul', { class: 'dashboard-wk-liste dashboard-wk-liste-fern', role: 'list', 'aria-label': t('dashboard.weltkarte_gegenstellen') });
  knoten.wkMehrFern = mehrKnopf('fern');
  knoten.wkTitelLokal = el('h3', { class: 'dashboard-wk-titel dashboard-wk-titel-lokal' });
  knoten.wkListeLokal = el('ul', { class: 'dashboard-wk-liste dashboard-wk-liste-lokal', role: 'list' });
  knoten.wkMehrLokal = mehrKnopf('lokal');
  knoten.wkFuss = el('p', { class: 'kachel-fuss dashboard-wk-fuss' });
  knoten.wkSeite = el('div', { class: 'dashboard-wk-seite' }, [
    knoten.wkSumme,
    el('section', { class: 'dashboard-wk-block dashboard-wk-block-fern' }, [knoten.wkTitelFern, knoten.wkListeFern, knoten.wkMehrFern]),
    el('section', { class: 'dashboard-wk-block dashboard-wk-block-lokal' }, [knoten.wkTitelLokal, knoten.wkListeLokal, knoten.wkMehrLokal]),
  ]);
  knoten.wkInhalt = el('div', { class: 'dashboard-wk-inhalt' }, [knoten.wkKarte, knoten.wkSeite]);
  knoten.wkKachel = kachel('weltkarte', 'welt', t('dashboard.weltkarte'), [
    knoten.wkHinweise,
    knoten.wkInhalt,
    knoten.wkFuss,
  ], 'dashboard-wk', {
    kopf: el('div', { class: 'dashboard-wk-umschalter', role: 'group', 'aria-label': t('dashboard.weltkarte_richtung') }, [knoten.wkEin, knoten.wkAus]),
  });
  return knoten.wkKachel;
}

/** Ruft eine Methode der Karte; ein Fehler im Karten-Modul darf Listen und Umschalter nicht mitreißen. */
function wkKarteRufen(fn) {
  if (!wk.karte) return;
  try { fn(wk.karte); } catch (e) { console.warn('[dashboard] Weltkarte:', e && e.message); }
}

function wkKarteLaden() {
  const lauf = laufNummer; const behaelter = knoten.wkKarte;
  Promise.resolve().then(() => kartenLader()).then((m) => {
    if (lauf !== laufNummer || knoten.wkKarte !== behaelter) return; // inzwischen verlassen
    // Umrisse lädt das Modul selbst (Standard-Lader: einmal je Seite) – ein eigener Lader hier holte sie bei jedem
    // Ansichtswechsel neu, und der Länderpfad-Zwischenspeicher griff nie (Prüfbericht 26.09.)
    wk.karte = m.erzeugeWeltkarte(behaelter, { t: (k, w) => t(k, w), bewegungReduziert: bewegungReduziert() });
    if (wk.ergebnis) wkKarteRufen((k) => k.setzeDaten(wk.ergebnis, { filter: wk.filter }));
    if (!wkSichtbar()) wkKarteRufen((k) => k.pausieren(true));
  }).catch((e) => {
    if (lauf !== laufNummer) return;
    wk.karte = null; wk.karteFehlt = true;
    console.warn('[dashboard] weltkarte.js:', e && e.message);
    wkHinweiseZeigen();
    wkListenZeigen(); // ohne Karte keine Bindung an den Platzhalter
  });
}

/** Sichtbar = Kachel eingeblendet, im Bild (IntersectionObserver, falls vorhanden) und Tab nicht versteckt. */
function wkSichtbar() {
  const k = knoten.wkKachel;
  return !!k && !k.hidden && wk.imBild && !(typeof document !== 'undefined' && document.hidden);
}

/** Wechsel sichtbar ↔ unsichtbar: Karte pausieren bzw. fortsetzen, beim Sichtbarwerden sofort frische Daten holen. */
function wkSichtbarkeitGeaendert() {
  if (!knoten.wkKachel) return;
  const jetzt = wkSichtbar();
  if (jetzt === wk.sichtbar) return;
  wk.sichtbar = jetzt;
  wkKarteRufen((k) => k.pausieren(!jetzt));
  if (jetzt) wkLaden();
}

function wkLadenWennSichtbar() { if (knoten.wkKachel && wkSichtbar()) wkLaden(); }

/**
 * Fragt netz.verbindungen für die aktuelle Richtung ab. Läuft für dieselbe Richtung schon eine Abfrage, kommt keine
 * zweite dazu. Jede Abfrage bekommt eine Nummer; nur die Antwort der jüngsten zählt – eine verspätete Antwort der
 * alten Richtung nach schnellem Umschalten wird verworfen.
 */
async function wkLaden() {
  const c = ctx; if (!c || !knoten.wkKachel) return;
  const richtung = wk.richtung;
  if (wk.laeuft && wk.laeuft.richtung === richtung) return;
  const nr = ++wk.nr;
  wk.laeuft = { nr, richtung };
  let ergebnis = null; let fehler = null;
  try { ergebnis = verbindungenLesen(await c.api('netz.verbindungen', { richtung })); } catch (e) { fehler = e || new Error('?'); }
  if (ctx !== c || nr !== wk.nr) {
    // verworfen (inzwischen neu eingebunden oder neuere Abfrage): die Sperre trotzdem lösen, sonst fragte diese
    // Richtung nie wieder ab – dauerhaft „Wird geladen“ (Bedienprobe 26.09.)
    if (wk.laeuft && wk.laeuft.nr === nr) wk.laeuft = null;
    return;
  }
  wk.laeuft = null;
  if (fehler) {
    wk.fehler = fehler;
    if (!WK_STILLE_FEHLER.includes(fehler.code)) console.warn('[dashboard] netz.verbindungen:', fehler.message);
  } else {
    wk.fehler = null; wk.ergebnis = ergebnis;
    // Filter nur behalten, solange es den Absender/Dienst noch gibt
    if (wk.filter && !ergebnis.lokal.some((l) => l.name === wk.filter)) { wk.filter = null; wkKarteRufen((k) => k.setzeFilter(null)); }
    wkKarteRufen((k) => k.setzeDaten(ergebnis, { filter: wk.filter }));
  }
  zeigeWeltkarte();
}

/** Beim Einbinden: gespeicherte Richtung lesen (Standard „aus“), dann die erste Abfrage – ohne auf sie zu warten. */
async function wkStarten() {
  const c = ctx; if (!c || !knoten.wkKachel) return;
  const name = c.nutzer && c.nutzer.name;
  if (name) {
    try {
      const r = await c.api('nutzer.einstellungen.lesen', { name, bereich: WK_BEREICH });
      const w = r && r.wert;
      // hat der Nutzer inzwischen schon selbst umgeschaltet, gewinnt sein Klick
      if (ctx === c && !wk.gewaehlt && w && WK_RICHTUNGEN.includes(w.richtung)) wk.richtung = w.richtung;
    } catch { /* ältere Agenten ohne Einstellungen → Standard */ }
  }
  if (ctx !== c) return;
  zeigeWeltkarte();
  if (!wk.gewaehlt) wkLadenWennSichtbar();
}

function richtungWaehlen(richtung) {
  if (!WK_RICHTUNGEN.includes(richtung) || richtung === wk.richtung || !ctx) return;
  const heimat = wk.ergebnis && wk.ergebnis.heimat ? wk.ergebnis.heimat : null;
  wk.richtung = richtung; wk.gewaehlt = true;
  wk.ergebnis = null; wk.fehler = null; wk.offen = { fern: false, lokal: false };
  // Absender (aus) und Dienste (ein) sind verschiedene Listen – ein Filter gilt nur in seiner Richtung
  if (wk.filter) { wk.filter = null; wkKarteRufen((k) => k.setzeFilter(null)); }
  // Karte sofort leeren (Platzhalter der neuen Richtung, Standort bleibt, abgedunkelt): bis die Antwort da ist – oder
  // wenn sie scheitert – stehen keine Bögen der alten Richtung unter dem neuen Umschalter
  wkKarteRufen((k) => k.setzeDaten({ richtung, zeit: new Date().toISOString(), heimat, gegenstellen: [], lokal: [] }, { filter: null, laedt: true }));
  zeigeWeltkarte();
  wkRichtungSpeichern(richtung);
  wkLaden();
}

async function wkRichtungSpeichern(richtung) {
  const c = ctx; const name = c && c.nutzer && c.nutzer.name; if (!name) return;
  try { await c.api('nutzer.einstellungen.setzen', { name, bereich: WK_BEREICH, wert: { richtung } }); }
  catch (e) { if (ctx === c) c.melden(t('dashboard.weltkarte_speichern_fehler', { grund: c.fehlerText(e) }), 'fehler'); }
}

function wkFilterSetzen(name) {
  wk.filter = name || null;
  wkKarteRufen((k) => k.setzeFilter(wk.filter));
  wkListenZeigen();
}

function zeigeWeltkarte() {
  if (!knoten.wkKachel) return;
  knoten.wkEin.setAttribute('aria-pressed', wk.richtung === 'ein' ? 'true' : 'false');
  knoten.wkAus.setAttribute('aria-pressed', wk.richtung === 'aus' ? 'true' : 'false');
  const aus = wk.richtung === 'aus';
  knoten.wkTitelFern.textContent = t(aus ? 'dashboard.weltkarte_ziele' : 'dashboard.weltkarte_quellen');
  knoten.wkTitelLokal.textContent = t(aus ? 'dashboard.weltkarte_absender' : 'dashboard.weltkarte_dienste');
  wkHinweiseZeigen(); wkListenZeigen(); wkFussZeigen();
}

/**
 * Hinweise der Kachel. Kein Standort, Aufzeichnung aus und fehlendes conntrack zeigt die Karte selbst (weltkarte.js,
 * .wk-hinweis); hier stehen Abfragefehler, fehlendes Karten-Modul und „eingehend nur Heimnetz“.
 */
function wkHinweiseZeigen() {
  const b = knoten.wkHinweise; if (!b) return;
  const liste = [];
  if (wk.fehler) liste.push(['warnung', t('dashboard.weltkarte_fehler', { grund: ctx && typeof ctx.fehlerText === 'function' ? ctx.fehlerText(wk.fehler) : String(wk.fehler.message || '') })]);
  if (wk.karteFehlt) liste.push(['warnung', t('dashboard.weltkarte_karte_fehlt')]);
  const e = wk.ergebnis;
  // NPM auf der UGREEN lässt nur Heimnetz + VPN durch: eingehend gibt es dann nur private Gegenstellen – das ist so gewollt
  if (e && e.aufzeichnung && wk.richtung === 'ein' && e.gegenstellen.length && e.gegenstellen.every((g) => g.privat)) liste.push(['info', t('dashboard.weltkarte_nur_heimnetz')]);
  // nur bei echter Änderung neu aufbauen – der Bereich ist aria-live und soll nicht alle 5 s neu vorgelesen werden
  const stand = JSON.stringify(liste);
  if (b.dataset.stand === stand) return;
  b.dataset.stand = stand;
  b.textContent = '';
  for (const [art, text] of liste) b.appendChild(el('div', { class: `hinweis hinweis-${art}` }, [symbol(art === 'warnung' ? 'warnung' : 'info'), el('p', { text })]));
}

function wkOrtText(g) {
  if (g.privat) return t('dashboard.weltkarte_heimnetz');
  if (g.anycast) return t('dashboard.weltkarte_anycast');
  const o = g.ort && typeof g.ort === 'object' ? g.ort : null;
  const text = o ? [o.stadt, o.land_name || o.land].filter(Boolean).join(', ') : '';
  return text || t('dashboard.weltkarte_ort_unbekannt');
}

/**
 * Listeneinträge als {schluessel, werte, bauen, setzen}: `werte` sind alle angezeigten Angaben (ihre JSON-Form ist die
 * Signatur), `bauen` legt das Gerüst einmal an, `setzen` schreibt die Werte hinein. So lassen sich Knoten je IP bzw.
 * Name wiederverwenden und nur bei echter Änderung anfassen.
 */
const WK_FERN = {
  schluessel: (g) => String(g.ip || ''),
  werte: (g) => ({
    privat: !!g.privat, flagge: g.privat || g.anycast || !g.ort ? '' : flagge(g.ort.land), ort: wkOrtText(g),
    anzahl: t('dashboard.weltkarte_anzahl', { n: Number(g.anzahl) || 0 }), menge: format.groesse(Number(g.bytes) || 0), ip: String(g.ip || ''),
  }),
  bauen: () => el('li', { class: 'dashboard-wk-eintrag' }, [
    el('span', { class: 'dashboard-wk-flagge', 'aria-hidden': 'true' }),
    el('span', { class: 'dashboard-wk-ort' }),
    el('span', { class: 'dashboard-wk-zahl' }, [el('span'), el('span', { class: 'dashboard-wk-menge', title: t('dashboard.weltkarte_datenmenge') })]),
    el('span', { class: 'dashboard-wk-ip mono' }),
  ]),
  setzen(li, w) {
    const [flaggeK, ort, zahl, ip] = li.children; const [anzahl, menge] = zahl.children;
    li.classList.toggle('dashboard-wk-privat', w.privat);
    flaggeK.textContent = w.flagge; ort.textContent = w.ort; anzahl.textContent = w.anzahl; menge.textContent = w.menge; ip.textContent = w.ip;
    ort.title = w.ort; ip.title = w.ip; // neben der Karte einzeilig gekürzt – der volle Text im Tooltip
  },
};

const WK_LOKAL = {
  schluessel: (l) => String(l.name || ''),
  werte: (l) => ({ name: String(l.name || ''), aktiv: wk.filter === l.name, zahl: `${t('dashboard.weltkarte_anzahl', { n: Number(l.anzahl) || 0 })} · ${format.groesse(Number(l.bytes) || 0)}` }),
  // Der Knopf bleibt über Aktualisierungen derselbe – ob er den Filter setzt oder aufhebt, entscheidet erst der Klick
  bauen: (l) => el('li', {}, [el('button', { class: 'dashboard-wk-lokal', type: 'button', 'data-name': String(l.name || ''), title: t('dashboard.weltkarte_filter'), onclick: () => wkFilterSetzen(wk.filter === l.name ? null : l.name) }, [
    el('span', { class: 'dashboard-wk-lokal-name' }),
    el('span', { class: 'dashboard-wk-zahl' }),
  ])]),
  setzen(li, w) {
    const knopf = li.firstElementChild; const [name, zahl] = knopf.children;
    knopf.setAttribute('aria-pressed', w.aktiv ? 'true' : 'false');
    name.textContent = w.name; zahl.textContent = w.zahl; name.title = w.name;
  },
};

/** Letzter Stand je Liste: {leer: Text der Leer-Zeile | null, knoten: Map schluessel → {signatur, li}}. */
const wkListenStand = new WeakMap();

/**
 * Füllt eine Liste: höchstens 10 Einträge ohne inneren Rollbalken, der Knopf darunter klappt alle auf und wieder zu.
 * Baut nur bei echter Änderung neu (Prüfbericht 26.09.): Knoten je IP bzw. Name bleiben stehen, geänderte Werte werden
 * an Ort und Stelle gesetzt, verschoben wird nur, was die Reihenfolge verlangt. Muss ein fokussierter Knopf dabei
 * wandern (der Browser nimmt ihm den Fokus), bekommt er ihn zurück – Tastaturnutzer verlieren ihren Platz weder alle 5 s
 * noch nach Enter auf einem Filter.
 */
function wkListeFuellen(ul, mehr, art, eintraege, eintrag, leerText, gebunden = false) {
  const offen = wk.offen[art];
  const grenze = offen ? Infinity : gebunden ? WK_LISTE_GEBUNDEN : WK_LISTE_KURZ;
  if (!gebunden) { // gebunden setzt wkEinpassen den Knopf („+N weitere“), erst wenn feststeht, was hineinpasst
    mehr.hidden = !offen && eintraege.length <= WK_LISTE_KURZ; // aufgeklappt immer „Weniger zeigen“ – so kommt die Bindung zurück
    const mehrText = offen ? t('dashboard.weltkarte_weniger') : t('dashboard.weltkarte_alle_zeigen', { n: eintraege.length });
    if (mehr.textContent !== mehrText) mehr.textContent = mehrText;
    mehr.setAttribute('aria-expanded', offen ? 'true' : 'false');
  }
  const alt = wkListenStand.get(ul) || { leer: null, knoten: new Map() };
  if (!eintraege.length) {
    if (alt.leer !== leerText || ul.children.length !== 1) { ul.textContent = ''; ul.appendChild(el('li', { class: 'dashboard-wk-leer schwach klein', text: leerText })); }
    wkListenStand.set(ul, { leer: leerText, knoten: new Map() });
    return;
  }
  const aktiv = typeof document !== 'undefined' ? document.activeElement : null;
  const fokusDrin = !!aktiv && aktiv !== ul && typeof ul.contains === 'function' && ul.contains(aktiv);
  const fokusName = fokusDrin && aktiv.dataset ? aktiv.dataset.name : undefined;
  if (alt.leer !== null) ul.textContent = ''; // Leer-Zeile weg
  const knoten = new Map(); const reihe = [];
  for (const x of eintraege.slice(0, grenze)) {
    let s = eintrag.schluessel(x); while (knoten.has(s)) s += '\u0000'; // doppelte Schlüssel bleiben getrennte Zeilen
    const w = eintrag.werte(x); const signatur = JSON.stringify(w);
    let k = alt.knoten.get(s);
    if (!k) k = { signatur: null, li: eintrag.bauen(x) };
    if (k.signatur !== signatur) { eintrag.setzen(k.li, w); k.signatur = signatur; }
    knoten.set(s, k); reihe.push(k.li);
  }
  for (const [s, k] of alt.knoten) if (!knoten.has(s)) k.li.remove();
  for (let i = 0; i < reihe.length; i++) if (ul.children[i] !== reihe[i]) ul.insertBefore(reihe[i], ul.children[i] || null);
  wkListenStand.set(ul, { leer: null, knoten });
  if (fokusDrin && document.activeElement !== aktiv) {
    const ziel = aktiv.isConnected && ul.contains(aktiv) ? aktiv
      : fokusName !== undefined ? [...ul.querySelectorAll('.dashboard-wk-lokal')].find((b) => b.dataset.name === fokusName) : null;
    if (ziel && typeof ziel.focus === 'function') { try { ziel.focus({ preventScroll: true }); } catch { /* egal */ } }
  }
}

/**
 * Listen neben der Karte sind bündig mit ihr (Betreiber 26.09.: „Weltkarte und Verbindungen sollten die gleiche Größe
 * haben“): breit (Container-Abfrage setzt --wk-gebunden: 1) übernimmt die Spalte die Kartenhöhe (contain: size), jede
 * Liste zeigt so viele Zeilen, wie hineinpassen, der Rest steckt hinter „+N weitere · alle zeigen“ – ohne inneren
 * Rollbalken. „Alle zeigen“ hebt die Bindung auf. Schmal (Listen unter der Karte) bleibt es bei 10 Einträgen.
 */
function wkGebunden() {
  const seite = knoten.wkSeite;
  // ohne Karten-Modul gäbe nur der 180-px-Platzhalter die Höhe vor – dann lieber wie schmal
  if (!seite || wk.offen.fern || wk.offen.lokal || wk.karteFehlt || typeof getComputedStyle !== 'function') return false;
  try { return getComputedStyle(seite).getPropertyValue('--wk-gebunden').trim() === '1'; } catch { return false; }
}

/**
 * Blendet die Zeilen aus, die unter die Unterkante der (gebundenen) Liste ragen; der Knopf zählt sie mit den nicht
 * vorbereiteten Einträgen zusammen. Der Knopf braucht selbst Platz: erst zeigen, dann einpassen.
 */
function wkEinpassen(ul, mehr, gesamt) {
  const zeilen = [...ul.children];
  for (const z of zeilen) z.classList.remove('dashboard-wk-weg');
  if (!gesamt) { mehr.hidden = true; return; }
  mehr.hidden = false;
  const unten = ul.getBoundingClientRect().bottom + 0.5;
  let weg = 0;
  for (const z of zeilen) if (weg || z.getBoundingClientRect().bottom > unten) { z.classList.add('dashboard-wk-weg'); weg++; }
  const n = gesamt - zeilen.length + weg;
  if (n <= 0) { mehr.hidden = true; return; } // alles passt – ohne Knopf erst recht
  const text = t('dashboard.weltkarte_weitere', { n });
  if (mehr.textContent !== text) mehr.textContent = text;
  mehr.setAttribute('aria-expanded', 'false');
  // Tastatur: lag der Fokus in einer jetzt ausgeblendeten Zeile, geht er an den Knopf (sonst fiele er auf die Seite zurück)
  const aktiv = typeof document !== 'undefined' ? document.activeElement : null;
  if (aktiv && aktiv !== ul && ul.contains(aktiv) && zeilen.some((z) => z.classList.contains('dashboard-wk-weg') && z.contains(aktiv))) {
    try { mehr.focus({ preventScroll: true }); } catch { /* egal */ }
  }
}

/** Größenänderung (Karte höher, Kachel breiter/schmaler): im nächsten Bild neu einpassen, nie mehrfach je Bild. */
function wkEinpassenPlanen() {
  if (wk.einpassenGeplant) return;
  wk.einpassenGeplant = true;
  const los = () => { wk.einpassenGeplant = false; wkListenZeigen(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(los); else setTimeout(los, 0);
}

function wkListenZeigen() {
  if (!knoten.wkListeFern) return;
  const e = wk.ergebnis;
  const gebunden = wkGebunden();
  knoten.wkSeite.classList.toggle('gebunden', gebunden);
  const leerText = !e ? t(wk.fehler ? 'dashboard.nicht_verfuegbar' : 'rahmen.laden') : !e.aufzeichnung ? t('dashboard.weltkarte_aufzeichnung_aus') : t('dashboard.weltkarte_keine');
  // Mit Filter nur die Gegenstellen des gewählten Absenders bzw. Dienstes
  const fern = e ? e.gegenstellen.filter((g) => !wk.filter || (Array.isArray(g.lokal) && g.lokal.some((l) => l && l.name === wk.filter))).sort(nachAnzahl) : [];
  wkListeFuellen(knoten.wkListeFern, knoten.wkMehrFern, 'fern', fern, WK_FERN, leerText, gebunden);
  // „Aufzeichnung ausgeschaltet“ genügt einmal (in der ersten Liste) – die zweite zeigt dann nur einen Strich
  const lokal = e ? [...e.lokal].sort(nachAnzahl) : [];
  // der gewählte Filter steht oben – er darf nie hinter „+N weitere“ oder der 10er-Grenze verschwinden
  const aktivIndex = wk.filter ? lokal.findIndex((l) => l.name === wk.filter) : -1;
  if (aktivIndex > 0) lokal.unshift(...lokal.splice(aktivIndex, 1));
  wkListeFuellen(knoten.wkListeLokal, knoten.wkMehrLokal, 'lokal', lokal, WK_LOKAL, e && !e.aufzeichnung ? '–' : leerText, gebunden);
  const s = e && e.summe && typeof e.summe === 'object' ? e.summe : null;
  knoten.wkSumme.textContent = s && e.gegenstellen.length ? t('dashboard.weltkarte_summe', { gegenstellen: Number(s.gegenstellen) || 0, anzahl: Number(s.anzahl) || 0, menge: format.groesse(Number(s.bytes) || 0) }) : '';
  knoten.wkSumme.hidden = !knoten.wkSumme.textContent;
  if (gebunden) {
    // Absender/Dienste zuerst: ihr Block ist höchstens 40 % hoch und schrumpft nach dem Einpassen auf seine Zeilen –
    // was frei wird, bekommen die Gegenstellen
    wkEinpassen(knoten.wkListeLokal, knoten.wkMehrLokal, lokal.length);
    wkEinpassen(knoten.wkListeFern, knoten.wkMehrFern, fern.length);
  } else {
    for (const ul of [knoten.wkListeFern, knoten.wkListeLokal]) for (const z of ul.children) z.classList.remove('dashboard-wk-weg');
  }
}

/** Fuß: Stand der Daten, Herkunft der Ortsdaten (Städte/Länder/keine) und die Namensnennung (immer sichtbar). */
function wkFussZeigen() {
  const f = knoten.wkFuss; if (!f) return;
  f.textContent = '';
  const e = wk.ergebnis;
  const teile = [];
  if (e && e.zeit) teile.push(t('dashboard.weltkarte_stand', { zeit: uhrzeit(e.zeit) }));
  if (e) {
    const g = e.geo;
    teile.push(g.quelle === 'stadt' ? t('dashboard.weltkarte_quelle_stadt', { stand: g.stand || '–' }) : g.quelle === 'land' ? t('dashboard.weltkarte_quelle_land') : t('dashboard.weltkarte_quelle_keine'));
    if (g.hinweis) teile.push(String(g.hinweis));
  }
  teile.push(t('dashboard.weltkarte_namensnennung'));
  for (const text of teile) f.appendChild(el('span', { text }));
}

/** Nach dem Einbinden: Takt, Sichtbarkeit (Tab + IntersectionObserver) und Größenänderung der Karte beobachten. */
function wkBeobachten() {
  if (!knoten.wkKachel) return;
  wk.takt = setInterval(wkLadenWennSichtbar, WK_TAKT_MS);
  wk.hoerer = () => wkSichtbarkeitGeaendert();
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', wk.hoerer);
  if (typeof IntersectionObserver === 'function') {
    wk.io = new IntersectionObserver((eintraege) => {
      const letzter = eintraege[eintraege.length - 1];
      if (letzter) { wk.imBild = !!letzter.isIntersecting; wkSichtbarkeitGeaendert(); }
    }, { rootMargin: '100px' });
    wk.io.observe(knoten.wkKachel);
  }
  if (typeof ResizeObserver === 'function') {
    // Karte: Maßstab nachführen; Karte und Inhalt: Listen neu einpassen (Kartenhöhe = Spaltenhöhe, Breite = breit/schmal)
    wk.ro = new ResizeObserver(() => { wkKarteRufen((k) => k.groesse()); wkEinpassenPlanen(); });
    wk.ro.observe(knoten.wkKarte);
    wk.ro.observe(knoten.wkInhalt);
  }
}

function wkAufraeumen() {
  clearInterval(wk.takt);
  if (wk.io) wk.io.disconnect();
  if (wk.ro) wk.ro.disconnect();
  if (wk.hoerer && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', wk.hoerer);
  wkKarteRufen((k) => k.zerstoeren());
  Object.assign(wk, wkLeer());
}

// ---------------------------------------------------------------------------------------------------------------------
// Aktualisierung
// ---------------------------------------------------------------------------------------------------------------------

function messwertUebernehmen(roh, zeichnen = true) {
  const m = normalisiere(roh);
  if (!m) return;
  letzterMesswert = m;
  punkt(reihen.cpu, m.cpu); punkt(reihen.ram, m.ramProzent); punkt(reihen.rx, m.rx); punkt(reihen.tx, m.tx); punkt(reihen.temp, m.temp);
  if (zeichnen) zeigeMesswerte();
}

function zeigeMesswerte() {
  if (!wurzel || !letzterMesswert || !knoten.cpuWert) return;
  const m = letzterMesswert;
  knoten.cpuWert.textContent = m.cpu == null ? '–' : format.prozent(m.cpu);
  if (knoten.cpuInfo) knoten.cpuInfo.textContent = cpuZeile(m.cpuInfo);
  if (knoten.cpuKerne && m.cpuInfo) {
    // je Kern ein dünner Balken (Kern 1 … n), bei vielen Kernen zweispaltig
    const kerne = m.cpuInfo.jeKern;
    if (knoten.cpuKerne.children.length !== kerne.length) {
      knoten.cpuKerne.textContent = '';
      knoten.cpuKerne.classList.toggle('dashboard-kerne-viele', kerne.length > 8);
      kerne.forEach((_, i) => knoten.cpuKerne.appendChild(el('li', { class: 'dashboard-kern' }, [el('span', { class: 'dashboard-kern-name', text: t('dashboard.cpu_kern', { n: i + 1 }) }), el('span', { class: 'dashboard-kern-balken' }, [el('span', { class: 'dashboard-kern-fuellung' })]), el('span', { class: 'dashboard-kern-wert', text: '–' })])));
    }
    kerne.forEach((p, i) => {
      const li = knoten.cpuKerne.children[i]; if (!li) return;
      const v = p == null ? null : Math.max(0, Math.min(100, p));
      li.querySelector('.dashboard-kern-fuellung').style.width = `${v ?? 0}%`;
      li.querySelector('.dashboard-kern-wert').textContent = v == null ? '–' : `${Math.round(v)} %`;
      li.classList.toggle('hoch', v != null && v >= 90);
    });
  }
  zeichneKurve(knoten.cpuKurve, [{ werte: reihen.cpu }], 100);

  knoten.ramWert.textContent = m.ramProzent == null ? '–' : format.prozent(m.ramProzent);
  knoten.ramNeben.textContent = m.ramGesamt != null && m.ramBelegt != null ? t('dashboard.belegt_von', { belegt: format.groesse(m.ramBelegt), gesamt: format.groesse(m.ramGesamt) }) : '';
  setzeBalken(knoten.ramBalken, m.ramProzent);

  zeigePlatten();

  const rxSpan = knoten.netzWert.querySelector('.dashboard-netz-rx span'); const txSpan = knoten.netzWert.querySelector('.dashboard-netz-tx span');
  if (rxSpan) rxSpan.textContent = m.rx == null ? '–' : format.rate(m.rx);
  if (txSpan) txSpan.textContent = m.tx == null ? '–' : format.rate(m.tx);
  zeichneKurve(knoten.netzKurve, [
    { werte: reihen.rx, farbe: cssFarbe('--fahnas-akzent', '#0e8a8a') },
    { werte: reihen.tx, farbe: cssFarbe('--fahnas-warnung', '#b26a00') },
  ], null);

  zeigeSystemleiste();

  if (m.temp == null) { knoten.tempWert.textContent = '–'; knoten.tempNeben.textContent = t('dashboard.temperatur_unbekannt'); }
  else {
    knoten.tempWert.textContent = `${format.zahl(m.temp, 0)} °C`;
    const stufe = m.temp >= TEMP_HEISS ? 'heiss' : m.temp >= TEMP_WARM ? 'warm' : 'normal';
    knoten.tempNeben.textContent = t(`dashboard.temperatur_${stufe}`);
    knoten.tempKachel.classList.toggle('warnung', stufe === 'warm');
    knoten.tempKachel.classList.toggle('gefahr', stufe === 'heiss');
  }
}

function zeigePlatten() {
  const sys = findePlatte('system'); const dat = findePlatte('daten');
  for (const [p, z] of [[sys, knoten.platteSys], [dat, knoten.platteDat]]) {
    if (!p) { z.prozent.textContent = '–'; z.neben.textContent = t('dashboard.platte_unbekannt'); setzeBalken(z.balken, null); continue; }
    z.prozent.textContent = p.prozent == null ? '–' : format.prozent(p.prozent);
    z.neben.textContent = p.gesamt != null && p.frei != null ? t('dashboard.frei_von', { frei: format.groesse(p.frei), gesamt: format.groesse(p.gesamt) }) : (p.pfad || '');
    setzeBalken(z.balken, p.prozent);
  }
  // Gesamt über beide Partitionen; die Karte färbt sich nach der volleren
  const beide = [sys, dat].filter((p) => p && p.gesamt != null && p.frei != null);
  const gesamt = beide.reduce((s, p) => s + p.gesamt, 0); const frei = beide.reduce((s, p) => s + p.frei, 0);
  knoten.platteWert.textContent = beide.length && gesamt > 0 ? format.prozent(((gesamt - frei) / gesamt) * 100) : '–';
  knoten.platteNeben.textContent = beide.length && gesamt > 0 ? t('dashboard.frei_von', { frei: format.groesse(frei), gesamt: format.groesse(gesamt) }) : '';
  if (knoten.platteModell) knoten.platteModell.textContent = platteZeile(status && status.systemplatte);
  const voll = [sys, dat].reduce((m, p) => (p && p.prozent != null && p.prozent > m ? p.prozent : m), -1);
  stufeSetzen(knoten.platteKachel, voll >= 0 ? voll : null);
  if (dat && dat.prozent != null && dat.prozent >= WARNUNG_AB && !knoten.hb) { // Admins: steht im Handlungsbedarf
    knoten.hinweisPlatte.hidden = false;
    knoten.hinweisPlatteText.textContent = t(dat.prozent >= GEFAHR_AB ? 'dashboard.platte_kritisch' : 'dashboard.platte_warnung', { prozent: format.prozent(dat.prozent) });
  } else knoten.hinweisPlatte.hidden = true;
}

/** Kachel „Wartung & Sicherheit“: Sicherheitspunkte, letzte Selbsttests, automatische Updates. */
export function wartungZusammenfassung(w, sicherheit = []) {
  const smart = Object.values((w && w.smart) || {});
  const fertig = smart.filter((x) => x.ende);
  return {
    punkte: (Array.isArray(sicherheit) ? sicherheit : []).filter((x) => x.stufe !== 'hinweis').length,
    tests_ok: fertig.filter((x) => x.bestanden).length, tests_fehler: fertig.filter((x) => x.bestanden === false).length, tests_laufen: smart.filter((x) => !x.ende).length,
    auto: !!(w && w.auto_updates && w.auto_updates.aktiv), letzter: w && w.updates ? w.updates.letzter_lauf : null, neustart: !!(w && w.updates && w.updates.neustart_noetig),
    naechste: w ? w.naechste_pruefung : null,
  };
}

function zeigeWartung() {
  if (!knoten.wtWert) return;
  const s = wartungStand;
  if (s === null) { knoten.wtWert.textContent = '–'; knoten.wtNeben.textContent = t('rahmen.laden'); return; }
  if (s === 'fehler') { knoten.wtWert.textContent = '–'; knoten.wtNeben.textContent = t('dashboard.nicht_verfuegbar'); return; }
  const z = wartungZusammenfassung(s, roh.hinweise && roh.hinweise.sicherheit);
  knoten.wtWert.textContent = z.punkte ? t('dashboard.wartung_punkte', { n: z.punkte }) : t('dashboard.wartung_sicher');
  knoten.wtNeben.textContent = z.naechste ? t('dashboard.wartung_naechste', { zeit: format.zeit(z.naechste.zeit) }) : t('dashboard.wartung_aus');
  knoten.wtKachel.classList.toggle('warnung', z.punkte > 0 || z.tests_fehler > 0);
  knoten.wtListe.textContent = '';
  const zeilen = [
    [z.tests_fehler ? 'fehler' : 'ok', z.tests_ok || z.tests_fehler || z.tests_laufen ? t('dashboard.wartung_tests', { ok: z.tests_ok, fehler: z.tests_fehler, laufen: z.tests_laufen }) : t('dashboard.wartung_tests_keine')],
    [z.auto ? 'ok' : 'fehler', t(z.auto ? 'dashboard.wartung_auto_an' : 'dashboard.wartung_auto_aus')],
  ];
  if (z.letzter && z.letzter.zeit) zeilen.push(['nie', t('dashboard.wartung_letzter', { zeit: format.zeit(z.letzter.zeit) })]);
  if (z.neustart) zeilen.push(['fehler', t('dashboard.wartung_neustart')]);
  for (const [art, text] of zeilen) knoten.wtListe.appendChild(el('li', { class: `dashboard-spiegel dashboard-spiegel-${art}` }, [el('span', { class: 'dashboard-spiegel-name', text: `${art === 'ok' ? '●' : art === 'fehler' ? '✗' : '○'} ${text}` })]));
}

async function ladeWartung() {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  let r = null;
  try { r = await c.api('wartung.lesen', {}); } catch (e) { if (!wartungStand) wartungStand = 'fehler'; if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] wartung.lesen:', e.message); }
  if (!wurzel || ctx !== c) return;
  if (r !== null) wartungStand = r;
  zeigeWartung();
}

/** Handlungsbedarf neu zeichnen (nach jedem Laden – billig, nur Rohdaten). */
function zeigeHandlungsbedarf() {
  if (!knoten.hb) return;
  const alle = handlungsbedarf({ ...roh, status }, (...x) => ctx.hashFuer(...x));
  const { sichtbar: liste, versteckt } = hbFiltern(alle, quittiert);
  const geladen = status !== null && roh.apps !== undefined;
  knoten.hb.classList.toggle('hb-laden', !geladen);
  knoten.hb.classList.toggle('hb-ok', geladen && !liste.length);
  knoten.hb.classList.toggle('hb-fehler', liste.some((x) => x.stufe === 'fehler'));
  knoten.hbListe.textContent = '';
  if (!geladen) { knoten.hbKopf.textContent = t('dashboard.hb_titel'); knoten.hbListe.appendChild(el('li', { class: 'hb-zeile hb-leer', text: t('rahmen.laden') })); return; }
  knoten.hbKopf.textContent = liste.length ? t('dashboard.hb_titel_n', { n: liste.length }) : t('dashboard.hb_alles_ok');
  knoten.hb.classList.toggle('hb-ok', !liste.length);
  if (knoten.hbZeigen) knoten.hbZeigen.remove();
  knoten.hbZeigen = versteckt ? el('button', { class: 'hb-quittiert', type: 'button', text: t('dashboard.hb_quittiert', { n: versteckt }), onclick: () => quittiertSpeichern({}) }) : null;
  if (knoten.hbZeigen) knoten.hbKopf.after(knoten.hbZeigen);
  for (const x of liste) {
    knoten.hbListe.appendChild(el('li', { class: `hb-zeile hb-${x.stufe}` }, [
      symbol(x.stufe === 'hinweis' ? 'info' : x.stufe === 'fehler' ? 'fehler' : 'warnung'),
      el('span', { class: 'hb-text', text: x.text }),
      el('button', { class: 'knopf knopf-zweit knopf-klein hb-verstanden', type: 'button', title: t(x.stufe === 'fehler' ? 'dashboard.hb_verstanden_fehler' : 'dashboard.hb_verstanden_titel'),
        onclick: () => quittiertSpeichern(hbQuittieren(quittiert, x, alle)) }, t('dashboard.hb_verstanden')),
      el('a', { class: 'knopf knopf-klein hb-beheben', href: x.ziel, text: t(x.stufe === 'hinweis' ? 'dashboard.hb_ansehen' : 'dashboard.hb_beheben') }),
    ]));
  }
}

/** Quittierte Einträge des Nutzers laden/speichern (persönlich, wie das Layout). */
async function quittiertLaden() {
  const c = ctx; if (!c || c.rolle !== 'admin' || !c.nutzer) return;
  try { const r = await c.api('nutzer.einstellungen.lesen', { name: c.nutzer.name, bereich: HB_BEREICH }); quittiert = (r && r.wert && r.wert.quittiert) || {}; } catch { quittiert = {}; }
  if (wurzel && ctx === c) zeigeHandlungsbedarf();
}
async function quittiertSpeichern(neu) {
  const c = ctx; if (!c || !c.nutzer) return;
  quittiert = neu; zeigeHandlungsbedarf();
  try { await c.api('nutzer.einstellungen.setzen', { name: c.nutzer.name, bereich: HB_BEREICH, wert: { quittiert: neu } }); } catch (e) { c.melden?.(c.fehlerText ? c.fehlerText(e) : String(e && e.message), 'fehler'); }
}

async function ladeHinweise(neu = false) {
  const c = ctx; if (!c || c.rolle !== 'admin') return;
  if (!neu && roh.hinweise && Date.now() - hinweiseZeit < 5 * 60_000) return;
  try { roh.hinweise = await c.api('system.hinweise', neu ? { neu: true } : {}); hinweiseZeit = Date.now(); } catch (e) { if (e && !['E_AGENT', 'E_NICHT_GEFUNDEN', 'E_RECHTE'].includes(e.code)) console.warn('[dashboard] system.hinweise:', e.message); }
  if (wurzel && ctx === c) { zeigeHandlungsbedarf(); zeigeWartung(); zeigeUpdates(); }
}

function zeigeStatus() {
  const l = knoten.systemListe; l.textContent = '';
  const zeile = (beschriftung, wert) => { l.appendChild(el('dt', { text: beschriftung })); l.appendChild(el('dd', { text: wert == null || wert === '' ? '–' : String(wert) })); };
  if (!status) { l.appendChild(el('p', { class: 'schwach klein', text: t('dashboard.status_fehlt') })); }
  else {
    zeile(t('dashboard.hostname'), status.hostname);
    zeile(t('dashboard.version'), status.version);
    zeile(t('dashboard.kernel'), status.kernel);
    zeile(t('dashboard.laufzeit'), status.laufzeit_s != null ? format.dauer(status.laufzeit_s) : null);
  }
  if (knoten.slSystem) {
    // Systemübersicht, Kopfzeile: „fahnas · Version 0.18.0 · Kernel … · Läuft seit …“ (Beschriftung gedämpft)
    const s = knoten.slSystem; s.textContent = '';
    const teile = status ? [[null, status.hostname], [t('dashboard.version'), status.version], [t('dashboard.kernel'), status.kernel],
      [t('dashboard.laufzeit'), status.laufzeit_s != null ? format.dauer(status.laufzeit_s) : null]].filter(([, w]) => w != null && w !== '') : [];
    teile.forEach(([b, w], i) => {
      if (i) s.append(el('span', { class: 'dashboard-sl-trenner', 'aria-hidden': 'true', text: ' · ' }));
      if (b) s.append(el('span', { class: 'dashboard-sl-beschriftung', text: `${b} ` }));
      s.append(el('span', { class: 'dashboard-sl-angabe', text: String(w) }));
    });
    s.title = s.textContent;
  }
  const d = knoten.dienste; d.textContent = '';
  const dienste = status && status.dienste && typeof status.dienste === 'object' ? status.dienste : null;
  const namen = ['samba', 'docker', 'libvirt', 'avahi', 'ssh'];
  if (!dienste) d.appendChild(el('li', { class: 'schwach klein', text: t('dashboard.status_fehlt') }));
  else {
    for (const n of namen.concat(Object.keys(dienste).filter((k) => !namen.includes(k)))) {
      const z = dienste[n]; if (z === undefined) continue;
      const zustand = z === 'aktiv' || z === true ? 'aktiv' : z === 'fehler' ? 'fehler' : 'inaktiv';
      d.appendChild(el('li', { class: 'dashboard-dienst' }, [
        el('span', { class: `ampel ampel-${zustand}`, 'aria-hidden': 'true' }),
        el('span', { class: 'dashboard-dienst-name', text: t.hat(`dashboard.dienst.${n}`) ? t(`dashboard.dienst.${n}`) : n }),
        el('span', { class: `plakette plakette-${zustand === 'aktiv' ? 'erfolg' : zustand === 'fehler' ? 'gefahr' : ''}`, text: t(`dashboard.zustand_${zustand}`) }),
      ]));
    }
  }
  zeigePlatten();
}

async function ladeStatus() {
  const c = ctx; if (!c) return;
  try { status = await c.api('system.status', {}); } catch (e) { if (!status) status = null; if (e && e.code !== 'E_AGENT') console.warn('[dashboard] system.status:', e.message); }
  if (wurzel && ctx === c) { zeigeStatus(); zeigeHandlungsbedarf(); zeigeUpdates(); }
}

function aufgabeTitel(a) {
  const s = `aufgabe.aktion.${a.aktion}`;
  return t.hat(s) ? t(s) : (a.aktion || t('dashboard.aufgabe'));
}

/** Laufende Aufgaben kompakt (Betreiber 12.10.2026): eine Zeile je Aufgabe – Name, letzte Meldung, Zeit, Zustand – darunter
 *  ein dünner Balken; fertige Aufgaben verschwinden nach 20 Sekunden. */
const AUFGABE_SICHTBAR_MS = 20_000;
function zeigeAufgaben() {
  const b = knoten.aufgaben; if (!b) return;
  b.textContent = '';
  const jetzt = Date.now();
  const liste = [...aufgaben.values()].filter((a) => !AUFGABE_ENDE.has(a.status) || (a._gesehen && jetzt - a._gesehen < AUFGABE_SICHTBAR_MS))
    .sort((x, y) => (String(x.gestartet || '') < String(y.gestartet || '') ? 1 : -1)).slice(0, 12);
  if (!liste.length) { b.appendChild(el('div', { class: 'leer leer-kompakt' }, [symbol('aufgaben', 'gross'), el('p', { class: 'leer-text', text: t('dashboard.keine_aufgaben') })])); return; }
  for (const a of liste) {
    const laeuft = !AUFGABE_ENDE.has(a.status);
    const prozent = Math.round((Number(a.fortschritt) || 0) * 100);
    const zustandText = a.status === 'laeuft' ? `${prozent} %` : t(`aufgabe.status_${a.status}`);
    const zustandKlasse = a.status === 'fertig' ? 'erfolg' : a.status === 'fehler' ? 'gefahr' : a.status === 'laeuft' ? 'akzent' : '';
    const meldung = agentText(a.meldung || (a.fehler && a.fehler.meldung) || '');
    b.appendChild(el('div', { class: `dashboard-aufgabe zustand-${a.status}`, title: [aufgabeTitel(a), meldung, a.nutzer].filter(Boolean).join(' · ') }, [
      el('div', { class: 'dashboard-aufgabe-kopf' }, [
        el('span', { class: 'dashboard-aufgabe-titel', text: aufgabeTitel(a) }),
        el('span', { class: 'dashboard-aufgabe-meldung', text: meldung }),
        el('span', { class: 'dashboard-aufgabe-zeit', text: a.gestartet ? format.zeit(a.gestartet) : '' }),
        el('span', { class: `dashboard-aufgabe-zustand ${zustandKlasse}`, text: zustandText }),
        laeuft ? el('button', { class: 'knopf-symbol dashboard-aufgabe-abbrechen', type: 'button', title: t('aufgabe.abbrechen_kurz'), 'aria-label': t('aufgabe.abbrechen_kurz'), onclick: () => abbrechen(a.id) }, [symbol('schliessen')]) : null,
      ]),
      el('div', { class: `fortschritt duenn${a.status === 'laeuft' && !a.fortschritt ? ' unbestimmt' : ''}${a.status === 'fehler' ? ' gefahr' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(prozent) }, [el('div', { class: 'fortschritt-balken', style: { '--anteil': `${a.status === 'fertig' ? 100 : prozent}%` } })]),
    ]));
  }
}

async function abbrechen(id) {
  if (!(await ctx.bestaetigen(t('dashboard.abbrechen_frage'), { titel: t('dashboard.abbrechen'), ok: t('dashboard.abbrechen'), gefahr: true }))) return;
  try { await ctx.api('agent.aufgabe_abbrechen', { id }); ctx.melden(t('dashboard.abbruch_gesendet'), 'info'); } catch (e) { ctx.zeigeFehler(e); }
}

function aufgabeUebernehmen(e) {
  if (!e || typeof e !== 'object') return;
  const id = e.aufgabe ?? e.id; if (!id) return;
  const alt = aufgaben.get(id) || {};
  const neu = { ...alt, ...e, id };
  delete neu.ereignis;
  if (AUFGABE_ENDE.has(neu.status) && !alt._gesehen) neu._gesehen = Date.now();
  aufgaben.set(id, neu);
  dockerAufgabeEnde(neu);
  if (aufgaben.size > 100) { const beendete = [...aufgaben.values()].filter((a) => AUFGABE_ENDE.has(a.status)).sort((x, y) => (x._gesehen || 0) - (y._gesehen || 0)); while (aufgaben.size > 100 && beendete.length) aufgaben.delete(beendete.shift().id); }
  zeigeAufgaben();
}

async function ladeAufgaben() {
  const c = ctx; if (!c) return;
  try {
    const liste = await c.api('agent.aufgaben', {});
    if (Array.isArray(liste)) for (const a of liste) { if (AUFGABE_ENDE.has(a.status)) continue; aufgaben.set(a.id, { ...a }); }
  } catch (e) { console.warn('[dashboard] agent.aufgaben:', e.message); }
  if (ctx === c) zeigeAufgaben();
}

function zeigeEreignisse(daten, fehler) {
  const b = knoten.ereignisse; if (!b) return;
  b.textContent = '';
  if (fehler) { b.appendChild(el('p', { class: 'schwach klein', text: ctx.fehlerText(fehler) })); return; }
  if (!daten) { b.appendChild(el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')])); return; }
  const eintraege = Array.isArray(daten) ? daten : (daten.eintraege || []);
  if (!eintraege.length) { b.appendChild(el('div', { class: 'leer leer-kompakt' }, [symbol('protokoll', 'gross'), el('p', { class: 'leer-text', text: t('dashboard.keine_ereignisse') })])); return; }
  const liste = el('ul', { class: 'dashboard-ereignis-liste', role: 'list' });
  for (const e of eintraege.slice(0, 8)) {
    liste.appendChild(el('li', { class: 'dashboard-ereignis' }, [
      el('span', { class: `ampel ${e.ok === false ? 'ampel-fehler' : 'ampel-aktiv'}`, 'aria-hidden': 'true' }),
      el('span', { class: 'dashboard-ereignis-aktion mono', text: e.aktion || '–' }),
      el('span', { class: 'dashboard-ereignis-neben schwach klein', text: [e.nutzer, e.fehler && e.fehler.meldung ? agentText(e.fehler.meldung) : null, format.zeit(e.zeit)].filter(Boolean).join(' · ') }),
    ]));
  }
  b.appendChild(liste);
  b.appendChild(el('p', { class: 'klein' }, [el('a', { href: ctx.hashFuer('system', 'protokoll'), text: t('dashboard.alle_ereignisse') })]));
}

async function ladeEreignisse() {
  const c = ctx; if (!c || !knoten.ereignisse) return;
  try { const d = await c.api('system.protokoll', { seite: 1, je_seite: 8 }); if (ctx === c) zeigeEreignisse(d); } catch (e) { if (ctx === c) zeigeEreignisse(null, e); }
}

async function ladeVerlauf() {
  const c = ctx; if (!c) return;
  try {
    const v = await c.get('/api/messwerte/verlauf');
    const liste = Array.isArray(v) ? v : (v && (v.messwerte || v.verlauf || v.punkte || v.werte)) || [];
    for (const k of Object.keys(reihen)) reihen[k].length = 0;
    for (const m of liste.slice(-MAX_PUNKTE)) messwertUebernehmen(m, false);
  } catch (e) { console.warn('[dashboard] Verlauf:', e.message); }
  if (ctx === c) zeigeMesswerte();
}

// ---------------------------------------------------------------------------------------------------------------------
// Ansicht
// ---------------------------------------------------------------------------------------------------------------------

export default {
  id: 'dashboard',
  symbol: 'dashboard',
  rolle: 'nutzer',
  titel() { return t('dashboard.titel'); },

  async einbinden(w, c) {
    if (wurzel) this.verlassen(); // noch eingebunden (zwei gleichzeitige Routenwechsel): Timer/Beobachter nicht doppeln
    const lauf = ++laufNummer;
    wurzel = w; ctx = c;
    baueOberflaeche();
    favoritenAbmelden = favoriten.beiAenderung(() => favoritenZeigen());
    ctx.sse.on('messwerte', (m) => messwertUebernehmen(m, true));
    ctx.sse.on('aufgabe', (e) => aufgabeUebernehmen(e));
    ctx.sse.on('konfig', (e) => {
      const b = e && e.bereich;
      if (!b || b === 'system') { ladeStatus(); wkLadenWennSichtbar(); } // Standort/Aufzeichnung geändert → Karte gleich neu
      if (!b || b === 'apps') { ladeApps(); ladeUpdates(true); ladeDocker(); ladeFahgit(); }
      if (!b || b === 'freigaben') { ladeFreigaben(); ladeSnaps(true); ladeOrdnerrechte(); ladeImporte(); }
      if (b === 'importe') { ladeImporte(); ladeOrte(); }
      if (b === 'speicherorte') ladeOrte();
      if (b === 'hardware') ladeGehaeuse();
      if (b === 'snapshots') ladeSnaps(true);
      if (!b || b === 'laufwerke' || b === 'freigaben') ladeLaufwerke();
      if (!b || b === 'spiegelung') ladeSpiegelung();
      if (!b || b === 'vpn') ladeVpn();
      if (!b || b === 'gpu' || b === 'apps') ladeGpu();
      if (!b || b === 'energie') ladeEnergie();
      if (!b || b === 'protokolle') ladeProtokolle();
      if (!b || b === 'vms') ladeVms();
      if (!b || b === 'raid' || b === 'freigaben') ladeRaid();
      if (b === 'benachrichtigungen') { roh.hinweise = null; ladeHinweise(true); }
      if (b === 'wartung' || b === 'nutzer' || b === 'freigaben') { hinweiseZeit = 0; ladeHinweise(); ladeWartung(); }
    });
    ctx.sse.on('spiegelung', (d) => spiegelungEreignis(d));
    document.addEventListener('fahnas-darstellung', darstellungGeaendert);
    ctx.sse.on('benachrichtigung', () => ladeMeldungen());
    ctx.sse.on('system', (d) => { ladeStatus(); if (!d || !d.art || d.art === 'laufwerk') ladeLaufwerke(); });
    ctx.sse.on('agent', (d) => { const z = typeof d === 'string' ? d : d && d.zustand; if (z === 'verbunden') { ladeStatus(); ladeAufgaben(); ladeApps(); ladeLaufwerke(); ladeSpiegelung(); wkLadenWennSichtbar(); } });
    uhrTimer = setInterval(zeigeUhr, 1000);
    await Promise.all([ladeLayout(), ladeVerlauf(), ladeStatus(), ladeAufgaben(), ladeEreignisse(), ladeApps(), ladeLaufwerke(), ladeSpiegelung(), ladeMeldungen(), ladeVpn(), ladeGpu(), ladeEnergie(), ladeProtokolle(), ladeVms(), ladeRaid(), ladeHinweise(), quittiertLaden(), ladeWartung(), ladeTapeten(), wkStarten(),
      ladeFreigaben(), ladeSnaps(), ladeVerbindungen(), ladeDocker(), ladeUpdates(), ladeLinks(), ladeChat(), ladeOffice(true), ladeSchutz(), ladeOrdnerrechte(), ladeFahgit(), ladeGehaeuse(), ladeImporte(), ladeOrte()]);
    if (lauf !== laufNummer || !wurzel) return; // inzwischen verlassen – keine Timer auf toter Ansicht
    statusTimer = setInterval(() => { if (!ctx) return; ladeStatus(); ladeApps(); ladeLaufwerke(); ladeFreigaben(); ladeLinks(); ladeChat(); ladeOffice(); if (ctx.rolle === 'admin') { ladeEreignisse(); ladeSpiegelung(); ladeVpn(); ladeGpu(); ladeEnergie(); ladeProtokolle(); ladeVms(); ladeRaid(); ladeHinweise(); ladeWartung(); ladeVerbindungen(); ladeSnaps(); ladeDocker(); ladeUpdates(); ladeSchutz(); ladeOrdnerrechte(); ladeFahgit(); ladeGehaeuse(); ladeImporte(); ladeOrte(); } }, 30_000);
    aufraeumTimer = setInterval(zeigeAufgaben, 15_000);
    // Chat: neue Nachrichten kommen über die gemeinsame Verbindung – höchstens einmal je Sekunde neu laden
    chatAb = chatVerbindung().on('chat', () => { if (chatTimer) return; chatTimer = setTimeout(() => { chatTimer = null; ladeChat(); }, 1000); });
    wkBeobachten();
    if (typeof ResizeObserver === 'function') {
      beobachter = new ResizeObserver(() => zeigeMesswerte());
      beobachter.observe(knoten.cpuKurve); beobachter.observe(knoten.netzKurve);
      for (const k of [knoten.slCpuKurve, knoten.slRamKurve, knoten.slNetzKurve]) if (k) beobachter.observe(k);
    }
  },

  verlassen() {
    if (favoritenAbmelden) { favoritenAbmelden(); favoritenAbmelden = null; }
    laufNummer++;
    clearInterval(statusTimer); clearInterval(aufraeumTimer); clearInterval(uhrTimer); statusTimer = null; aufraeumTimer = null; uhrTimer = null;
    if (beobachter) { beobachter.disconnect(); beobachter = null; }
    wkAufraeumen();
    document.removeEventListener('fahnas-darstellung', darstellungGeaendert);
    wurzel = null; ctx = null; tapetenStand = null;
    appsStand = null; laufwerkeStand = null; externStand = null; spiegelStand = null; meldungenStand = null; vpnStand = null; gpuStand = null; energieStand = null; protoStand = null; vmStand = null; raidStand = null; wartungStand = null; roh = {}; hinweiseZeit = 0; quittiert = {};
    if (chatAb) { chatAb(); chatAb = null; }
    clearTimeout(chatTimer); chatTimer = null; chatUebersicht = null; officeStand = null;
    freigabenStand = null; snapStand = null; verbStand = null; linksStand = null; schutzStand = null; ordnerrechteStand = null; fahgitStand = null; gehaeuseStand = null; importeStand = null; orteStand = null; dockerStand = null; updatesStand = null; dockerAufgabe = null; zuletztGeladen = {};
    zugBeenden(false);
    bearbeiten = false; clearTimeout(speicherTimer); speicherTimer = null; layout = null; standardKacheln = []; knoten.platzhalter = null;
    for (const k of Object.keys(knoten)) delete knoten[k];
  },
};

/** Nur für Tests: Karten-Modul ersetzen (null = wieder ./weltkarte.js) und die Standardgrößen der Kacheln lesen. */
export const _test = {
  setzeKartenLader(fn) { kartenLader = typeof fn === 'function' ? fn : KARTEN_MODUL; },
  standardKacheln: () => [...standardKacheln],
  wirksamesLayout: () => wirksamesLayout(),
};
