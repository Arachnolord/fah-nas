// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Prüfprotokoll: eine JSON-Zeile je Aktion in /data/config/protokoll/audit-JJJJ-MM.jsonl. Passwörter geschwärzt.
// Monatsdateien älter als die Aufbewahrung (system.json → aufbewahrung.protokoll_monate) räumt `aufraeumen` weg;
// gelesen wird zeilenweise (Stream), nicht die ganze Datei auf einmal.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { PFADE } from '../gemeinsam/pfade.js';

const GEHEIM = /passw|geheim|secret|token|hash|code$/i;
/** Parameter länger als das landen gekürzt im Protokoll (Pfadlisten mit 1000 Einträgen würden sonst Megabyte je Zeile kosten). */
export const PARAMS_MAX_ZEICHEN = 8192;
const DATEI_MUSTER = /^audit-(\d{4})-(\d{2})\.jsonl$/;

export function schwaerzen(obj, tiefe = 0) {
  if (tiefe > 6 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((e) => schwaerzen(e, tiefe + 1));
  const aus = {};
  for (const [k, v] of Object.entries(obj)) aus[k] = GEHEIM.test(k) ? '***' : schwaerzen(v, tiefe + 1);
  return aus;
}

/** Kürzt zu große Parameter auf eine Zusammenfassung (Feldnamen, Listenlängen). */
export function parameterKuerzen(params) {
  const text = JSON.stringify(params);
  if (text === undefined || text.length <= PARAMS_MAX_ZEICHEN) return params;
  const felder = {};
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) felder[k] = `[${v.length} Einträge]`;
      else if (typeof v === 'string') felder[k] = v.length > 200 ? `${v.slice(0, 200)}… (${v.length} Zeichen)` : v;
      else if (v && typeof v === 'object') felder[k] = '{…}';
      else felder[k] = v;
    }
  }
  return { _gekuerzt: true, zeichen: text.length, felder };
}

export class Audit {
  constructor(ordner = PFADE.protokoll) { this.ordner = ordner; this.kette = Promise.resolve(); }

  datei(zeit = new Date()) {
    const jm = zeit.toISOString().slice(0, 7);
    return path.join(this.ordner, `audit-${jm}.jsonl`);
  }

  /** Schreibt einen Eintrag (asynchron, in Reihenfolge). Fehler beim Schreiben werden auf stderr gemeldet, nie geworfen. */
  eintrag({ nutzer, ip, aktion, params, ok, fehler, dauer_ms, aufgabe }) {
    const zeit = new Date();
    const zeile = JSON.stringify({
      zeit: zeit.toISOString(), nutzer: nutzer || '-', ip: ip || '-', aktion, params: parameterKuerzen(schwaerzen(params ?? {})),
      ok: !!ok, fehler: fehler ? { code: fehler.code, meldung: fehler.meldung ?? fehler.message } : undefined, dauer_ms, aufgabe,
    }) + '\n';
    this.kette = this.kette.then(async () => {
      await fs.mkdir(this.ordner, { recursive: true, mode: 0o750 });
      await fs.appendFile(this.datei(zeit), zeile, { mode: 0o640 });
    }).catch((e) => { process.stderr.write(`[audit] ${e.message}\n`); });
    return this.kette;
  }

  async _dateien() {
    try { return (await fs.readdir(this.ordner)).filter((d) => DATEI_MUSTER.test(d)).sort().reverse(); } catch { return []; }
  }

  /** Liest Einträge (neueste zuerst) mit einfachen Filtern und Seitenumbruch – zeilenweise, nicht alles auf einmal. */
  async lesen({ von, bis, nutzer, aktion, seite = 1, je_seite = 100 } = {}) {
    const dateien = await this._dateien();
    if (!dateien.length) return { eintraege: [], gesamt: 0 };
    const alle = [];
    for (const d of dateien) {
      const monat = d.slice(6, 13);
      if (von && monat < von.slice(0, 7)) continue;
      if (bis && monat > bis.slice(0, 7)) continue;
      const rl = readline.createInterface({ input: createReadStream(path.join(this.ordner, d), 'utf8'), crlfDelay: Infinity });
      try {
        for await (const z of rl) {
          if (!z) continue;
          let e; try { e = JSON.parse(z); } catch { continue; }
          if (von && e.zeit < von) continue;
          if (bis && e.zeit > bis) continue;
          if (nutzer && e.nutzer !== nutzer) continue;
          if (aktion && !String(e.aktion).startsWith(aktion)) continue;
          alle.push(e);
        }
      } finally { rl.close(); }
    }
    alle.sort((a, b) => (a.zeit < b.zeit ? 1 : -1));
    const start = (Math.max(1, seite) - 1) * je_seite;
    return { eintraege: alle.slice(start, start + je_seite), gesamt: alle.length };
  }

  /**
   * Löscht Monatsdateien, die älter als `monate` sind (der laufende Monat zählt als 1). Gibt die gelöschten
   * Dateinamen zurück; Fehler werden nicht geworfen, sondern übersprungen.
   */
  async aufraeumen(monate = 12, jetzt = new Date()) {
    const n = Number.isInteger(monate) && monate >= 1 ? monate : 12;
    // Grenze = erster Monat, der noch bleibt (n Monate zurück inkl. dem laufenden)
    const grenze = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - (n - 1), 1));
    const grenzeText = grenze.toISOString().slice(0, 7);
    const weg = [];
    for (const d of await this._dateien()) {
      const m = DATEI_MUSTER.exec(d);
      if (!m || `${m[1]}-${m[2]}` >= grenzeText) continue;
      try { await fs.unlink(path.join(this.ordner, d)); weg.push(d); } catch (e) { process.stderr.write(`[audit] ${d} nicht löschbar: ${e.message}\n`); }
    }
    return weg;
  }
}
