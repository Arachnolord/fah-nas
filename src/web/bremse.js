// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldebremse je IP und je Nutzername: nach 5 Fehlern 30 s Sperre, je weiterer Sperre verdoppelt bis 30 min.
// Erfolg setzt zurück. Zustand in /data/config/web/bremse.json. Optionen `datei` und `stufen` (feste Sperrdauern je Stufe, die
// letzte gilt weiter) für die strengere Bremse der Anmeldung aus dem Internet (src/web/anmeldeschutz.js: 3 Fehler → 1 h, dann 24 h).
// Laufende Versuche werden VOR dem Agent-Aufruf
// reserviert (`beginnen`), damit gleichzeitig abgeschickte Anfragen nicht alle an der Zählung vorbeikommen.
// Außerdem: Client-IP-Ermittlung mit X-Forwarded-For nur von vertrauten Proxys (IP oder CIDR, IPv4 und IPv6 über
// node:net BlockList).

import net from 'node:net';
import { Konfig } from '../gemeinsam/konfig.js';
import { PFADE } from '../gemeinsam/pfade.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export const FEHLER_GRENZE = 5;
export const SPERRE_START_MS = 30_000;
export const SPERRE_MAX_MS = 30 * 60 * 1000;
const MAX_EINTRAEGE = 10_000;
const DATEI = 'bremse.json';

function normName(name) { return String(name ?? '').trim().toLowerCase().slice(0, 64) || '-'; }

export class Bremse {
  constructor(ordner = PFADE.web, { grenze = FEHLER_GRENZE, start_ms = SPERRE_START_MS, max_ms = SPERRE_MAX_MS, datei = DATEI, stufen = null } = {}) {
    this.konfig = new Konfig(ordner);
    this.grenze = grenze; this.start_ms = start_ms; this.datei = datei;
    this.stufen = Array.isArray(stufen) && stufen.length ? stufen : null;
    this.max_ms = this.stufen ? Math.max(...this.stufen) : max_ms;
    this.eintraege = { ip: {}, nutzer: {} };
    this.laufend = { ip: new Map(), nutzer: new Map() }; // reservierte, noch offene Versuche (nur im Speicher)
    this.schreibTimer = null; this.schreibKette = Promise.resolve();
  }

  async laden() {
    try {
      const d = await this.konfig.laden(this.datei, { ip: {}, nutzer: {} });
      if (d && typeof d === 'object') this.eintraege = { ip: d.ip || {}, nutzer: d.nutzer || {} };
    } catch { this.eintraege = { ip: {}, nutzer: {} }; }
    this.aufraeumen();
  }

  _planeSpeichern() {
    if (this.schreibTimer) return;
    this.schreibTimer = setTimeout(() => { this.schreibTimer = null; this.schreibKette = this.schreibKette.then(() => this.konfig.speichern(this.datei, this.eintraege, 0o600)).catch((e) => process.stderr.write(`[web] Bremse speichern: ${e.message}\n`)); }, 200);
    this.schreibTimer.unref();
  }

  /** Sperrdauer der Stufe: feste Liste (`stufen`) oder Start × 2^Stufe bis zur Höchstdauer. */
  dauer(stufe) {
    if (this.stufen) return this.stufen[Math.min(stufe, this.stufen.length - 1)];
    return Math.min(this.max_ms, this.start_ms * 2 ** stufe);
  }

  /** Gerade gesperrte IPs (für die Übersicht): [{ip, bis}] – neueste Sperre zuerst. */
  sperren(jetzt = Date.now()) {
    return Object.entries(this.eintraege.ip).filter(([, e]) => e.bis > jetzt).map(([ip, e]) => ({ ip, bis: e.bis, stufe: e.stufe })).sort((a, b) => b.bis - a.bis);
  }

  /** Wirft E_BREMSE (details.warte_s), wenn IP oder Name gerade gesperrt sind. */
  pruefen(ip, name) {
    const jetzt = Date.now();
    for (const e of [this.eintraege.ip[ip], this.eintraege.nutzer[normName(name)]]) {
      if (e && e.bis > jetzt) {
        const warte_s = Math.ceil((e.bis - jetzt) / 1000);
        throw new FahnasFehler('E_BREMSE', `Zu viele Fehlversuche – bitte warte ${warte_s} Sekunden`, { warte_s });
      }
    }
  }

  /** Gesperrt? Gibt Restsekunden oder 0 zurück (ohne zu werfen). */
  gesperrt(ip, name) {
    try { this.pruefen(ip, name); return 0; } catch (e) { return e.details.warte_s; }
  }

  /**
   * Reserviert einen Versuch VOR dem Agent-Aufruf: wirft E_BREMSE, wenn IP oder Name gesperrt sind ODER wenn
   * bisherige Fehler + gerade laufende Versuche die Grenze erreichen. So kommen N gleichzeitig abgeschickte
   * Anfragen nicht alle bis zur Passwort-/Code-Prüfung (Prüfbericht R1, Fund 4). Gibt `{ende()}` zurück –
   * `ende()` MUSS in jedem Fall (finally) aufgerufen werden; `erfolg`/`fehler` zählen wie bisher.
   */
  beginnen(ip, name) {
    this.pruefen(ip, name);
    const n = normName(name);
    const paare = [[this.eintraege.ip, this.laufend.ip, ip], [this.eintraege.nutzer, this.laufend.nutzer, n]];
    for (const [tabelle, laufend, schluessel] of paare) {
      if (!schluessel) continue;
      const e = tabelle[schluessel];
      const fehler = e ? e.fehler : 0;
      const offen = laufend.get(schluessel) || 0;
      if (fehler + offen >= this.grenze) {
        // Sperre, die folgt, wenn die laufenden Versuche scheitern (wie `fehler` sie berechnen würde)
        const dauer = this.dauer(e ? e.stufe : 0);
        const warte_s = Math.max(1, Math.ceil(dauer / 1000));
        throw new FahnasFehler('E_BREMSE', `Zu viele gleichzeitige Versuche – bitte warte ${warte_s} Sekunden`, { warte_s });
      }
    }
    for (const [, laufend, schluessel] of paare) if (schluessel) laufend.set(schluessel, (laufend.get(schluessel) || 0) + 1);
    let offen = true;
    return {
      ende: () => {
        if (!offen) return; offen = false;
        for (const [, laufend, schluessel] of paare) {
          if (!schluessel) continue;
          const z = (laufend.get(schluessel) || 1) - 1;
          if (z <= 0) laufend.delete(schluessel); else laufend.set(schluessel, z);
        }
      },
    };
  }

  /** Zahl der gerade reservierten Versuche für IP bzw. Name (für Tests/Diagnose). */
  offen(ip, name) { return { ip: this.laufend.ip.get(ip) || 0, nutzer: this.laufend.nutzer.get(normName(name)) || 0 }; }

  /** Zählt einen Fehlversuch für IP und Name; ab der Grenze beginnt (bzw. verlängert sich) die Sperre. */
  fehler(ip, name) {
    const jetzt = Date.now();
    let sperre = 0;
    for (const [tabelle, schluessel] of [[this.eintraege.ip, ip], [this.eintraege.nutzer, normName(name)]]) {
      if (!schluessel) continue;
      const e = tabelle[schluessel] || (tabelle[schluessel] = { fehler: 0, stufe: 0, bis: 0, zeit: 0 });
      e.fehler++; e.zeit = jetzt;
      if (e.fehler >= this.grenze) {
        const dauer = this.dauer(e.stufe);
        e.stufe++; e.fehler = 0; e.bis = jetzt + dauer;
        sperre = Math.max(sperre, dauer);
      }
    }
    this.aufraeumen();
    this._planeSpeichern();
    return sperre;
  }

  /** Erfolg: Zähler und Sperren für IP und Name löschen. */
  erfolg(ip, name) {
    delete this.eintraege.ip[ip];
    delete this.eintraege.nutzer[normName(name)];
    this._planeSpeichern();
  }

  /** Entfernt Einträge, die länger als die Höchstsperre ruhen; begrenzt die Größe. */
  aufraeumen() {
    const jetzt = Date.now();
    for (const tabelle of [this.eintraege.ip, this.eintraege.nutzer]) {
      for (const [k, e] of Object.entries(tabelle)) if (e.bis < jetzt && jetzt - e.zeit > this.max_ms) delete tabelle[k];
      const schluessel = Object.keys(tabelle);
      if (schluessel.length > MAX_EINTRAEGE) {
        schluessel.sort((a, b) => tabelle[a].zeit - tabelle[b].zeit);
        for (const k of schluessel.slice(0, schluessel.length - MAX_EINTRAEGE)) delete tabelle[k];
      }
    }
  }

  async stoppen() {
    if (this.schreibTimer) { clearTimeout(this.schreibTimer); this.schreibTimer = null; }
    await this.schreibKette.catch(() => {});
    try { await this.konfig.speichern(this.datei, this.eintraege, 0o600); } catch (e) { process.stderr.write(`[web] Bremse speichern: ${e.message}\n`); }
  }
}

/** IPv4-in-IPv6 (::ffff:1.2.3.4) auf IPv4 zurückführen, Zonen-Anhang (%eth0) entfernen. */
export function ipNormal(ip) {
  if (typeof ip !== 'string') return '';
  let a = ip.trim();
  if (a.startsWith('[') && a.includes(']')) a = a.slice(1, a.indexOf(']'));
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) a = m[1];
  const z = a.indexOf('%');
  if (z > 0) a = a.slice(0, z);
  return net.isIP(a) ? a : '';
}

/**
 * Baut aus `system.json.vertraute_proxys` (IPs oder CIDR, IPv4/IPv6) eine BlockList. Ungültige Einträge werden
 * übersprungen. Leere Liste → null (X-Forwarded-For wird dann nie beachtet).
 */
export function proxyListe(eintraege) {
  if (!Array.isArray(eintraege) || eintraege.length === 0) return null;
  const liste = new net.BlockList();
  let n = 0;
  for (const roh of eintraege) {
    if (typeof roh !== 'string') continue;
    const [adr, praefix] = roh.trim().split('/');
    const ip = ipNormal(adr);
    if (!ip) continue;
    const familie = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    try {
      if (praefix !== undefined) liste.addSubnet(ip, Number(praefix), familie); else liste.addAddress(ip, familie);
      n++;
    } catch { /* ungültiger Präfix – überspringen */ }
  }
  return n ? liste : null;
}

export function vertraut(liste, ip) {
  if (!liste || !ip) return false;
  try { return liste.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4'); } catch { return false; }
}

/**
 * Client-IP: aus dem Socket; X-Forwarded-For nur, wenn die Socket-IP ein vertrauter Proxy ist. In der Kette wird
 * von rechts nach links der erste Eintrag genommen, der kein vertrauter Proxy ist.
 */
export function clientIp(req, liste) {
  const socketIp = ipNormal(req.socket && req.socket.remoteAddress) || '-';
  if (!liste || !vertraut(liste, socketIp)) return socketIp;
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return socketIp;
  const kette = String(xff).split(',').map((t) => ipNormal(t)).filter(Boolean);
  for (let i = kette.length - 1; i >= 0; i--) if (!vertraut(liste, kette[i])) return kette[i];
  return kette[0] || socketIp;
}
