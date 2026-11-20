// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldeschutz für Anmeldungen aus dem Internet (Betreiber 16.10.2026, nachdem die Domain für Freigabelinks öffentlich
// wurde: „bau alle vier Punkte“). Gilt nur für Adressen außerhalb von Heimnetz und VPN (öffentliche IP nach Auswertung
// der vertrauten Proxys); zu Hause und per VPN bleibt alles wie gehabt.
//  1. Strengere Bremse: 3 Fehlversuche → 1 h Sperre, danach 24 h – eigene Datei (bremse-extern.json) und eigener
//     Namensschlüssel „@internet:<name>“, damit Angriffe aus dem Internet nie das Konto für Heimnetz/VPN sperren.
//  2. Ländersperre: Anmelden nur aus den Ländern in system.json anmeldeschutz.laender (Standard DE, leer = alle); das Land
//     kommt aus den lokalen Ortsdaten des Agenten (netz.land), nichts geht nach außen. Unbekanntes Land = gesperrt.
//  3. Bot-Bremse: vor jedem Versuch löst der Browser eine Rechenaufgabe (SHA-256 mit N führenden Null-Bits, im Mittel
//     2^N Versuche; public/anmeldung-aufgabe.js). Die Aufgabe ist an die IP gebunden, signiert, 5 min gültig und einmalig.
//     Mit jedem Fehlversuch der IP wird sie schwerer.
//  4. Meldung (ntfy/E-Mail über benachrichtigungen.anmeldung): jede erfolgreiche Anmeldung aus dem Internet und jede Sperre.
// Dazu die Übersicht für die Kachel „Anmeldeschutz“ (letzte Anmeldungen aus dem Internet, Fehlversuche, Sperren).

import crypto from 'node:crypto';
import { Konfig } from '../gemeinsam/konfig.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';
import { MUSTER_NUTZERNAME } from '../gemeinsam/schema.js';
import { Bremse } from './bremse.js';
import { istPrivat } from '../agent/helfer/netzadressen.js';

export const GRENZE_EXTERN = 3;
export const STUFEN_EXTERN = Object.freeze([3_600_000, 24 * 3_600_000]);
export const BITS_BASIS = 18;           // ≈ 260 000 Hashes: am Rechner deutlich unter 1 s, am Handy etwa 1 s
const BITS_MAX = 22;
const AUFGABE_MS = 5 * 60_000;
const LAND_CACHE_MS = 3_600_000;
const DATEI = 'anmeldeschutz.json';
const MAX_LETZTE = 10;
const TAG_MS = 24 * 3_600_000;
export const NAME_EXTERN = (name) => `@internet:${String(name || '-').slice(0, 64)}`;

/** Öffentliche Adresse (nicht Heimnetz/VPN/Loopback)? Unbekannt/kaputt gilt als intern (z. B. Unix-Socket in Tests). */
export function istExtern(ip) { return typeof ip === 'string' && ip !== '-' && ip !== '' && !istPrivat(ip); }

/** Zahl der führenden Null-Bits eines Puffers. */
export function nullBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}

export class Anmeldeschutz {
  /**
   * @param {{ordner:string, agent:object, systemKonfig:()=>object, protokoll?:object, jetzt?:()=>number, bits?:number, gastKontext:(ip:string)=>object, extern?:(ip:string)=>boolean}} o
   */
  constructor({ ordner, agent, systemKonfig, protokoll = null, jetzt = () => Date.now(), bits = BITS_BASIS, gastKontext, extern = istExtern }) {
    this.agent = agent; this.systemKonfig = systemKonfig; this.protokoll = protokoll; this.jetzt = jetzt; this.bitsBasis = bits;
    this.extern = extern; // (ip) → true, wenn die Anfrage aus dem Internet kommt (Tests setzen das fest)
    this.gastKontext = gastKontext;
    this.bremse = new Bremse(ordner, { grenze: GRENZE_EXTERN, stufen: [...STUFEN_EXTERN], datei: 'bremse-extern.json' });
    this.konfig = new Konfig(ordner);
    this.geheim = crypto.randomBytes(32);
    this.benutzt = new Map();   // aufgabe → ablauf (einmalig)
    this.laender = new Map();   // ip → {land, ort, zeit}
    this.stand = { letzte: [], fehler: [], land: [] }; // erfolgreiche Anmeldungen aus dem Internet, Fehlversuche, Länder-Abweisungen (Zeitpunkte)
    this.schreibTimer = null; this.kette = Promise.resolve();
  }

  async laden() {
    await this.bremse.laden();
    try {
      const d = await this.konfig.laden(DATEI, null);
      if (d && typeof d === 'object') {
        this.stand.letzte = Array.isArray(d.letzte) ? d.letzte.slice(0, MAX_LETZTE) : [];
        this.stand.fehler = Array.isArray(d.fehler) ? d.fehler.filter(Number.isFinite) : [];
        this.stand.land = Array.isArray(d.land) ? d.land.filter(Number.isFinite) : [];
      }
    } catch { /* leer anfangen */ }
  }

  async stoppen() {
    if (this.schreibTimer) { clearTimeout(this.schreibTimer); this.schreibTimer = null; this._speichern(); }
    await this.kette;
    await this.bremse.stoppen();
  }

  _planeSpeichern() {
    if (this.schreibTimer) return;
    this.schreibTimer = setTimeout(() => { this.schreibTimer = null; this._speichern(); }, 1000);
    this.schreibTimer.unref?.();
  }

  _speichern() {
    this._kuerzen();
    this.kette = this.kette.then(() => this.konfig.speichern(DATEI, this.stand, 0o600)).catch((e) => process.stderr.write(`[web] Anmeldeschutz speichern: ${e.message}\n`));
    return this.kette;
  }

  _kuerzen() {
    const grenze = this.jetzt() - TAG_MS;
    this.stand.fehler = this.stand.fehler.filter((z) => z > grenze).slice(-2000);
    this.stand.land = this.stand.land.filter((z) => z > grenze).slice(-2000);
  }

  /** Erlaubte Länder aus system.json (Großbuchstaben); leere Liste = alle Länder. */
  erlaubteLaender() {
    const l = this.systemKonfig()?.anmeldeschutz?.laender;
    return Array.isArray(l) ? l.map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)) : ['DE'];
  }

  /** Land + Ort einer Adresse über den Agenten (1 h zwischengespeichert). Fehler → land null. */
  async ortVon(ip) {
    const jetzt = this.jetzt();
    const alt = this.laender.get(ip);
    if (alt && jetzt - alt.zeit < LAND_CACHE_MS) return alt;
    let r = null;
    try { r = await this.agent.aktion('netz.land', { ip }, this.gastKontext(ip)); } catch { r = null; }
    const aus = { land: r && typeof r.land === 'string' ? r.land.toUpperCase() : null, ort: r ? [r.stadt, r.land].filter(Boolean).join(', ') : '', zeit: jetzt, fehler: !r };
    if (this.laender.size > 5000) this.laender.clear();
    if (r) this.laender.set(ip, aus);
    return aus;
  }

  /** Wirft E_RECHTE, wenn das Land der Adresse nicht erlaubt ist (unbekannt zählt als nicht erlaubt). */
  async landPruefen(ip) {
    const erlaubt = this.erlaubteLaender();
    if (!erlaubt.length) return;
    const o = await this.ortVon(ip);
    if (o.land && erlaubt.includes(o.land)) return;
    this.stand.land.push(this.jetzt()); this._planeSpeichern();
    if (this.protokoll) this.protokoll.eintrag('anmeldung_land', { ip, land: o.land || '?' });
    throw new FahnasFehler('E_RECHTE', `Anmelden aus dem Internet geht nur aus diesen Ländern: ${erlaubt.join(', ')} – zu Hause oder per VPN ist es immer möglich`, { land: o.land || null, laender: erlaubt, grund: 'land' });
  }

  /** Schwierigkeit der Rechenaufgabe für eine IP: Basis + 1 Bit je bisherigem Fehlversuch (höchstens 22). */
  bitsFuer(ip) {
    const e = this.bremse.eintraege.ip[ip];
    return Math.min(BITS_MAX, this.bitsBasis + (e ? e.fehler + 2 * e.stufe : 0));
  }

  _signatur(kern, ip) { return crypto.createHmac('sha256', this.geheim).update(`${kern}|${ip}`).digest('base64url').slice(0, 16); }

  /** Neue Aufgabe für diese IP: „zeit.bits.zufall.signatur“ (kurz genug, dass „aufgabe:lösung“ in einen SHA-256-Block passt). */
  aufgabe(ip) {
    const bits = this.bitsFuer(ip);
    const kern = `${this.jetzt().toString(36)}.${bits.toString(36)}.${crypto.randomBytes(9).toString('base64url')}`;
    return { aufgabe: `${kern}.${this._signatur(kern, ip)}`, bits };
  }

  /** Lösung prüfen: Signatur (an die IP gebunden), Alter ≤ 5 min, einmalig, genug führende Null-Bits. Wirft E_PARAMS. */
  aufgabePruefen(ip, aufgabe, loesung) {
    const fehler = (t) => new FahnasFehler('E_PARAMS', t, { feld: 'aufgabe' });
    if (typeof aufgabe !== 'string' || aufgabe.length > 64 || typeof loesung !== 'string' || !/^\d{1,12}$/.test(loesung)) throw fehler('Die Sicherheitsprüfung fehlt – bitte die Seite neu laden');
    const teile = aufgabe.split('.');
    if (teile.length !== 4) throw fehler('Die Sicherheitsprüfung ist ungültig – bitte erneut versuchen');
    const kern = teile.slice(0, 3).join('.');
    const soll = Buffer.from(this._signatur(kern, ip)); const ist = Buffer.from(teile[3]);
    if (soll.length !== ist.length || !crypto.timingSafeEqual(soll, ist)) throw fehler('Die Sicherheitsprüfung ist ungültig – bitte erneut versuchen');
    const zeit = parseInt(teile[0], 36); const bits = parseInt(teile[1], 36);
    const jetzt = this.jetzt();
    if (!Number.isFinite(zeit) || jetzt - zeit > AUFGABE_MS || zeit - jetzt > 60_000) throw fehler('Die Sicherheitsprüfung ist abgelaufen – bitte erneut versuchen');
    for (const [a, bis] of this.benutzt) if (bis < jetzt) this.benutzt.delete(a);
    if (this.benutzt.has(aufgabe)) throw fehler('Diese Sicherheitsprüfung wurde schon benutzt – bitte erneut versuchen');
    const hash = crypto.createHash('sha256').update(`${aufgabe}:${loesung}`).digest();
    if (nullBits(hash) < bits) throw fehler('Die Sicherheitsprüfung ist nicht gelöst – bitte erneut versuchen');
    this.benutzt.set(aufgabe, zeit + AUFGABE_MS);
  }

  /** Meldung an den Agenten (ntfy/E-Mail) – nie werfen, nie warten lassen. */
  melden(daten, ip) {
    Promise.resolve().then(() => this.agent.aktion('benachrichtigungen.anmeldung', daten, this.gastKontext(ip))).catch(() => {});
  }

  /** Fehlversuch aus dem Internet zählen; beginnt dabei eine Sperre, wird sie gemeldet. */
  async fehlversuch(ip, name) {
    const sperre_ms = this.bremse.fehler(ip, NAME_EXTERN(name));
    this.stand.fehler.push(this.jetzt()); this._planeSpeichern();
    if (sperre_ms > 0) {
      const o = await this.ortVon(ip);
      this.melden({ art: 'sperre', ip, ort: o.ort, minuten: Math.round(sperre_ms / 60_000), ...(MUSTER_NUTZERNAME.test(name || '') ? { nutzer: name } : {}) }, ip);
      if (this.protokoll) this.protokoll.eintrag('anmeldung_sperre_extern', { ip, sperre_ms });
    }
    return sperre_ms;
  }

  /** Erfolgreiche Anmeldung aus dem Internet: Zähler zurück, merken, melden. */
  async erfolg(ip, name) {
    this.bremse.erfolg(ip, NAME_EXTERN(name));
    const o = await this.ortVon(ip);
    this.stand.letzte = [{ nutzer: name, ip, ort: o.ort, zeit: new Date(this.jetzt()).toISOString() }, ...this.stand.letzte].slice(0, MAX_LETZTE);
    this._planeSpeichern();
    this.melden({ art: 'erfolg', nutzer: name, ip, ort: o.ort }, ip);
  }

  /** Übersicht für die Kachel und die Einstellungskarte. */
  async uebersicht() {
    this._kuerzen();
    const sperren = [];
    for (const s of this.bremse.sperren(this.jetzt()).slice(0, 20)) sperren.push({ ip: s.ip, bis: new Date(s.bis).toISOString(), ort: (await this.ortVon(s.ip)).ort });
    return {
      laender: this.erlaubteLaender(), bits: this.bitsBasis, grenze: GRENZE_EXTERN, sperren_ms: [...STUFEN_EXTERN],
      sperren, fehler_24h: this.stand.fehler.length, land_24h: this.stand.land.length, letzte: this.stand.letzte,
    };
  }
}
