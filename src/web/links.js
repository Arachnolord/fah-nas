// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Freigabelinks im Web-Dienst (Betreiber 16.10.2026: „Widget, was per Link freigegeben wurde, inkl. Gültigkeit und wer
// gerade zugreift (IP)“):
//  - LinkZugriffe: je Link, wer gerade zugreift (IP, seit, letzte Anfrage, laufender Download), wann zuletzt und wie oft
//    der Link aufgerufen wurde. „Gerade“ = Anfrage in den letzten 5 Minuten oder ein Download läuft noch. Die IPs der
//    letzten 24 h liegen nur im Speicher; „zuletzt“ und die Zahl der Aufrufe überleben einen Neustart
//    (/data/config/web/link-zugriffe.json, 0600). Schlüssel ist ein Hash des Tokens – der Token selbst landet nie hier.
//  - OeffentlicheAdresse: die Adresse für Freigabelinks. Gelernt aus dem Aufruf der Oberfläche über einen vertrauten
//    Reverse-Proxy (Host = öffentliche Domain). Nichts ist fest eingetragen – wechselt die Domain, wandert sie mit.

import crypto from 'node:crypto';
import net from 'node:net';
import { Konfig } from '../gemeinsam/konfig.js';

export const AKTIV_MS = 5 * 60_000;
const IPS_HALTEN_MS = 24 * 3600_000;
const MAX_IPS = 50;
const MAX_LINKS = 2000;
const SPEICHERN_MS = 5000;
const DATEI = 'link-zugriffe.json';
const ADRESS_DATEI = 'link-adresse.json';

/** Schlüssel eines Links in den Zugriffsdaten: kurzer Hash, damit kein einlösbarer Token auf der Platte liegt. */
export function linkSchluessel(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);
}

export class LinkZugriffe {
  constructor(ordner, { jetzt = () => Date.now() } = {}) {
    this.konfig = new Konfig(ordner);
    this.jetzt = jetzt;
    this.links = new Map(); // schluessel → {aufrufe, zuletzt:{zeit, ip}|null, ips: Map ip → {seit, letzte, laufend}}
    this.timer = null; this.kette = Promise.resolve();
  }

  async laden() {
    let d = null;
    try { d = await this.konfig.laden(DATEI, {}); } catch { d = null; }
    for (const [k, v] of Object.entries(d && typeof d === 'object' ? d : {})) {
      if (!v || typeof v !== 'object') continue;
      const zuletzt = v.zuletzt && typeof v.zuletzt.zeit === 'number' ? { zeit: v.zuletzt.zeit, ip: String(v.zuletzt.ip || '') } : null;
      this.links.set(k, { aufrufe: Number(v.aufrufe) || 0, zuletzt, ips: new Map() });
    }
  }

  _eintrag(schluessel) {
    let e = this.links.get(schluessel);
    if (!e) {
      if (this.links.size >= MAX_LINKS) this._kuerzen();
      e = { aufrufe: 0, zuletzt: null, ips: new Map() };
      this.links.set(schluessel, e);
    }
    return e;
  }

  /** Älteste Einträge (nach „zuletzt“) entfernen, bis wieder Platz ist. */
  _kuerzen() {
    const sortiert = [...this.links.entries()].sort((a, b) => (a[1].zuletzt?.zeit || 0) - (b[1].zuletzt?.zeit || 0));
    for (const [k] of sortiert.slice(0, Math.max(1, this.links.size - MAX_LINKS + 1))) this.links.delete(k);
  }

  /**
   * Anfrage auf einen gültigen Link. `aufruf`: zählt als Aufruf (Seite geöffnet, Download gestartet); `laufend`: ein
   * Download beginnt – der Rückgabewert `ende()` MUSS aufgerufen werden, wenn er vorbei ist.
   */
  treffer(token, ip, { aufruf = false, laufend = false } = {}) {
    const jetzt = this.jetzt();
    const e = this._eintrag(linkSchluessel(token));
    const adresse = String(ip || '-');
    let i = e.ips.get(adresse);
    if (!i) {
      if (e.ips.size >= MAX_IPS) {
        const aeltester = [...e.ips.entries()].filter(([, x]) => !x.laufend).sort((a, b) => a[1].letzte - b[1].letzte)[0];
        if (aeltester) e.ips.delete(aeltester[0]);
      }
      i = { seit: jetzt, letzte: jetzt, laufend: 0 };
      e.ips.set(adresse, i);
    }
    // nach einer Pause (> 5 min) beginnt ein neuer Besuch
    if (!i.laufend && jetzt - i.letzte > AKTIV_MS) i.seit = jetzt;
    i.letzte = jetzt;
    if (aufruf) { e.aufrufe++; e.zuletzt = { zeit: jetzt, ip: adresse }; this._planeSpeichern(); }
    if (!laufend) return { ende() {} };
    i.laufend++;
    let offen = true;
    return {
      ende: () => {
        if (!offen) return; offen = false;
        i.laufend = Math.max(0, i.laufend - 1);
        i.letzte = this.jetzt();
      },
    };
  }

  /** Stand eines Links für die Kachel: Aufrufe, zuletzt, wer gerade zugreift (neueste zuerst). */
  stand(token) {
    const e = this.links.get(linkSchluessel(token));
    if (!e) return { aufrufe: 0, zuletzt: null, aktiv: [] };
    const jetzt = this.jetzt();
    for (const [ip, i] of e.ips) if (!i.laufend && jetzt - i.letzte > IPS_HALTEN_MS) e.ips.delete(ip);
    const aktiv = [...e.ips.entries()]
      .filter(([, i]) => i.laufend > 0 || jetzt - i.letzte <= AKTIV_MS)
      .map(([ip, i]) => ({ ip, seit: new Date(i.seit).toISOString(), letzte: new Date(i.letzte).toISOString(), laeuft: i.laufend > 0 }))
      .sort((a, b) => (a.letzte < b.letzte ? 1 : -1));
    return { aufrufe: e.aufrufe, zuletzt: e.zuletzt ? { zeit: new Date(e.zuletzt.zeit).toISOString(), ip: e.zuletzt.ip } : null, aktiv };
  }

  _planeSpeichern() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this._speichern(); }, SPEICHERN_MS);
    this.timer.unref?.();
  }

  _speichern() {
    const d = {};
    for (const [k, e] of this.links) if (e.aufrufe || e.zuletzt) d[k] = { aufrufe: e.aufrufe, zuletzt: e.zuletzt };
    this.kette = this.kette.then(() => this.konfig.speichern(DATEI, d, 0o600)).catch((e) => process.stderr.write(`[web] Link-Zugriffe speichern: ${e.message}\n`));
    return this.kette;
  }

  async stoppen() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this._speichern(); }
    await this.kette;
  }
}

const HOST_MUSTER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
const NUR_INTERN = /(?:^|\.)(?:local|lan|home|internal|localdomain|intranet|fritz\.box)(?::\d+)?$/;

/** Öffentlicher Hostname (Domain mit Punkt, keine IP, kein .local/.lan …) aus einem Host-Kopf – sonst null. */
export function oeffentlicherHost(roh) {
  const host = String(roh || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_MUSTER.test(host) || NUR_INTERN.test(host)) return null;
  const ohnePort = host.replace(/:\d+$/, '');
  if (net.isIP(ohnePort) || /^[\d.]+$/.test(ohnePort)) return null;
  return host;
}

export class OeffentlicheAdresse {
  constructor(ordner) { this.konfig = new Konfig(ordner); this.wert = null; }

  async laden() {
    try {
      const d = await this.konfig.laden(ADRESS_DATEI, null);
      this.wert = d && typeof d.adresse === 'string' && /^https?:\/\/[^/\s]+$/.test(d.adresse) ? d.adresse : null;
    } catch { this.wert = null; }
  }

  /**
   * Aus einer Anfrage über einen VERTRAUTEN Proxy lernen (nur dann sind Host/X-Forwarded-Host die Adresse, unter der
   * Fremde den NAS erreichen). Gibt die (neue) Adresse zurück oder null.
   */
  lernen(req, vertraut) {
    if (!vertraut || !req || !req.headers) return null;
    const k = req.headers;
    const host = oeffentlicherHost(String(k['x-forwarded-host'] || k.host || '').split(',')[0]);
    if (!host) return null;
    const proto = String(k['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'http' ? 'http' : 'https';
    const adresse = `${proto}://${host.replace(proto === 'https' ? /:443$/ : /:80$/, '')}`;
    if (adresse !== this.wert) {
      this.wert = adresse;
      this.konfig.speichern(ADRESS_DATEI, { adresse, gelernt: new Date().toISOString() }, 0o600).catch((e) => process.stderr.write(`[web] Link-Adresse speichern: ${e.message}\n`));
    }
    return adresse;
  }
}
