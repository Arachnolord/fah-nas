// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// App-Katalog: eingebaute Vorlagen (<programm>/katalog/*.json), eigene Importe (<apps>/_katalog/eigen/<id>.json)
// und der übersetzte Unraid-Feed (<apps>/_katalog/unraid-feed.json). Alles wird geprüft (vorlagePruefen) und nach
// Datei-Änderungszeit zwischengespeichert; Suche/Filter/Seiten für die Oberfläche.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { vorlagePruefen } from './compose.js';

export const FEED_DATEI = 'unraid-feed.json';
export const EIGEN_ORDNER = 'eigen';
/** Build-Kontexte der FAH-Apps im Programm: <programm>/katalog/quellen/<id>/ (+ <id>.json: zip, sha256, version). */
export const QUELLEN_ORDNER = 'quellen';
const JE_SEITE_STANDARD = 50;
const JE_SEITE_MAX = 500;

async function statOderNull(p) { try { return await fs.stat(p); } catch { return null; } }

/** Alle *.json eines Ordners als [{datei, daten}]; unlesbare Dateien landen in `warnungen`. */
export async function jsonDateienLesen(ordner) {
  const aus = { eintraege: [], warnungen: [], stempel: '' };
  let namen = [];
  try { namen = (await fs.readdir(ordner)).filter((n) => n.endsWith('.json')).sort(); } catch (e) { if (e.code !== 'ENOENT') aus.warnungen.push(`${ordner}: ${e.message}`); return aus; }
  const stempel = [];
  for (const n of namen) {
    const p = path.join(ordner, n);
    try {
      const st = await fs.stat(p);
      stempel.push(`${n}:${st.mtimeMs}:${st.size}`);
      aus.eintraege.push({ datei: p, daten: JSON.parse(await fs.readFile(p, 'utf8')) });
    } catch (e) { aus.warnungen.push(`${p}: ${e.message}`); }
  }
  aus.stempel = stempel.join('|');
  return aus;
}

/** Datei(en) mit einer Vorlage oder einer Liste von Vorlagen → geprüfte Vorlagen mit fester Quelle. */
function vorlagenAus(dateien, quelle, warnungen) {
  const aus = [];
  for (const { datei, daten } of dateien) {
    const liste = Array.isArray(daten) ? daten : (daten && Array.isArray(daten.vorlagen) ? daten.vorlagen : [daten]);
    liste.forEach((v, i) => {
      try { aus.push({ ...vorlagePruefen(v, { quelle }), datei }); } catch (e) { warnungen.push(`${datei}${liste.length > 1 ? ` [${i}]` : ''}: ${e.message}`); }
    });
  }
  return aus;
}

/** Kurzform für Listen: ohne compose/felder (die Oberfläche holt sie mit apps.katalog.eintrag). */
export function kurz(v) {
  const { compose, felder, datei, ...rest } = v; // eslint-disable-line no-unused-vars
  return { ...rest, felder_anzahl: Array.isArray(felder) ? felder.length : 0, geheimnisse: Array.isArray(felder) ? felder.filter((f) => f.art === 'geheimnis').length : 0 };
}

function passt(v, woerter) {
  if (!woerter.length) return true;
  const text = `${v.id}\n${v.name}\n${v.beschreibung}\n${v.kategorie}\n${(v.herkunft && v.herkunft.repository) || ''}`.toLowerCase();
  return woerter.every((w) => text.includes(w));
}

/** Suche/Filter/Seiten über eine Liste von Vorlagen. Treffer im Namen zuerst, dann Beliebtheit, dann Name. */
export function suchen(alle, { suche, kategorie, quelle, seite = 1, je_seite = JE_SEITE_STANDARD } = {}) {
  const woerter = String(suche || '').toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
  const gefiltert = alle.filter((v) => (!kategorie || v.kategorie === kategorie) && (!quelle || v.quelle === quelle) && passt(v, woerter));
  const rang = (v) => (woerter.length && woerter.every((w) => v.name.toLowerCase().includes(w)) ? 0 : 1);
  // Eigene Apps des Betreibers (id fah-…) stehen immer vorn (Betreiber-Vorgabe 25.09.2026)
  const eigen = (v) => (/^fah-/.test(String(v.id || '')) ? 0 : 1);
  gefiltert.sort((a, b) => rang(a) - rang(b) || eigen(a) - eigen(b) || (a.quelle === 'eingebaut' ? 0 : 1) - (b.quelle === 'eingebaut' ? 0 : 1) || (b.beliebtheit || 0) - (a.beliebtheit || 0) || a.name.localeCompare(b.name, 'de'));
  const js = Math.min(JE_SEITE_MAX, Math.max(1, Number(je_seite) || JE_SEITE_STANDARD));
  const s = Math.max(1, Number(seite) || 1);
  const kategorien = [...new Set(alle.filter((v) => !quelle || v.quelle === quelle).map((v) => v.kategorie))].sort((a, b) => a.localeCompare(b, 'de'));
  const quellen = { eingebaut: 0, unraid: 0, eigen: 0 };
  for (const v of alle) quellen[v.quelle] = (quellen[v.quelle] || 0) + 1;
  return { eintraege: gefiltert.slice((s - 1) * js, s * js).map(kurz), gesamt: gefiltert.length, seite: s, je_seite: js, kategorien, quellen };
}

/**
 * Katalog mit Zwischenspeicher: `alle()` liefert eingebaute + eigene + Unraid-Vorlagen (Kennungen eindeutig; bei
 * Kollision gewinnt eingebaut vor eigen vor unraid), `eintrag(id)` die vollständige Vorlage.
 */
export class Katalog {
  /** @param {{eingebaut:string, katalogOrdner:string}} pfade  eingebaut = <programm>/katalog, katalogOrdner = <apps>/_katalog */
  constructor(pfade) {
    this.pfade = pfade;
    this._eingebaut = null; this._eigen = null; this._unraid = null;
  }

  get eigenOrdner() { return path.join(this.pfade.katalogOrdner, EIGEN_ORDNER); }
  get feedDatei() { return path.join(this.pfade.katalogOrdner, FEED_DATEI); }

  async _ordner(cacheName, ordner, quelle) {
    const c = this[cacheName];
    const gelesen = await jsonDateienLesen(ordner);
    if (c && c.stempel === gelesen.stempel) return c;
    const warnungen = [...gelesen.warnungen];
    const neu = { stempel: gelesen.stempel, vorlagen: vorlagenAus(gelesen.eintraege, quelle, warnungen), warnungen };
    for (const w of warnungen) if (!(c && c.warnungen.includes(w))) process.stderr.write(`[apps] Katalog ${quelle}: ${w}\n`);
    this[cacheName] = neu;
    return neu;
  }

  async eingebaut() {
    const e = await this._ordner('_eingebaut', this.pfade.eingebaut, 'eingebaut');
    if (!e.quellenGeprueft) {
      for (const v of e.vorlagen) if (v.bauen) await this._quelleAufloesen(v);
      e.quellenGeprueft = true;
    }
    return e;
  }

  /**
   * FAH-App (bauen): liegt der Quellcode im Programm (build_release.sh packt ihn aus dem finalen Release-ZIP dorthin),
   * ist die Vorlage installierbar – FAH-NAS baut das Image beim Installieren selbst. `quelle` = Prüfsumme des ZIPs
   * (wird Image-Label fahnas.quelle; Aktualisieren baut neu, wenn sie sich ändert).
   */
  async _quelleAufloesen(v) {
    const kontext = path.join(this.pfade.eingebaut, QUELLEN_ORDNER, v.id);
    const st = await statOderNull(path.join(kontext, 'Dockerfile'));
    if (!st) { v.bauen = { ...v.bauen, kontext: null }; v.verfuegbar = false; return; }
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(path.join(this.pfade.eingebaut, QUELLEN_ORDNER, `${v.id}.json`), 'utf8')) || {}; } catch { /* ohne Metadaten */ }
    const sha = typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256) ? meta.sha256 : `dockerfile-${Math.round(st.mtimeMs)}`;
    v.bauen = { ...v.bauen, kontext, quelle: sha, version: typeof meta.version === 'string' ? meta.version.slice(0, 40) : null };
    v.verfuegbar = true;
  }
  async eigen() { return this._ordner('_eigen', this.eigenOrdner, 'eigen'); }

  /** Unraid-Feed aus dem Zwischenspeicher (Datei: {geladen, quelle, anzahl, eintraege}). */
  async unraid() {
    const st = await statOderNull(this.feedDatei);
    if (!st) { this._unraid = { stempel: '', vorlagen: [], geladen: null, warnungen: [] }; return this._unraid; }
    const stempel = `${st.mtimeMs}:${st.size}`;
    if (this._unraid && this._unraid.stempel === stempel) return this._unraid;
    let vorlagen = []; let geladen = null; const warnungen = [];
    try {
      const d = JSON.parse(await fs.readFile(this.feedDatei, 'utf8'));
      geladen = d.geladen || null;
      for (const v of Array.isArray(d.eintraege) ? d.eintraege : []) {
        try { vorlagen.push(vorlagePruefen(v, { quelle: 'unraid' })); } catch { /* einzelner kaputter Eintrag */ }
      }
    } catch (e) { warnungen.push(`Unraid-Feed nicht lesbar: ${e.message}`); process.stderr.write(`[apps] ${warnungen[0]}\n`); }
    this._unraid = { stempel, vorlagen, geladen, warnungen };
    return this._unraid;
  }

  /** Alle Vorlagen (Kennung eindeutig). */
  async alle() {
    const [e, g, u] = await Promise.all([this.eingebaut(), this.eigen(), this.unraid()]);
    const aus = new Map();
    for (const v of [...e.vorlagen, ...g.vorlagen, ...u.vorlagen]) if (!aus.has(v.id)) aus.set(v.id, v);
    return [...aus.values()];
  }

  async eintrag(id) {
    const v = (await this.alle()).find((x) => x.id === id);
    if (!v) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die Vorlage „${id}“ gibt es nicht im Katalog`, { feld: 'katalog_id' });
    return v;
  }

  /** Eigene Vorlage speichern (quelle eigen; Kennung eigen-…). Gibt die geprüfte Vorlage zurück. */
  async eigeneSpeichern(vorlage) {
    const v = vorlagePruefen({ ...vorlage, id: vorlage.id.startsWith('eigen-') ? vorlage.id : `eigen-${vorlage.id.replace(/^unraid-/, '')}` }, { quelle: 'eigen' });
    await fs.mkdir(this.eigenOrdner, { recursive: true, mode: 0o750 });
    const p = path.join(this.eigenOrdner, `${v.id}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o640 });
    await fs.rename(tmp, p);
    this._eigen = null;
    return v;
  }

  async eigeneLoeschen(id) {
    const v = (await this.eigen()).vorlagen.find((x) => x.id === id);
    if (!v) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die eigene Vorlage „${id}“ gibt es nicht`, { feld: 'id' });
    await fs.unlink(v.datei);
    this._eigen = null;
    return { id, geloescht: true };
  }

  /** Übersetzten Feed als Zwischenspeicher schreiben. */
  async feedSpeichern({ eintraege, geladen, quelle }) {
    await fs.mkdir(this.pfade.katalogOrdner, { recursive: true, mode: 0o750 });
    const tmp = `${this.feedDatei}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ geladen: geladen || new Date().toISOString(), quelle, anzahl: eintraege.length, eintraege }), { mode: 0o640 });
    await fs.rename(tmp, this.feedDatei);
    this._unraid = null;
  }
}
