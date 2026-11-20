// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kurzes Protokoll des Web-Dienstes (Anmeldungen, Bremse, CSRF, Agent-Verbindung) in /data/config/web/web-JJJJ-MM.log.
// Eine Zeile je Eintrag, monatliche Dateien, alte Monate werden gelöscht (Aufbewahrung in Monaten).
// Login-Fehler landen NUR hier – der Agent sieht nutzer.pruefen ok:false selbst.
// Schlüssel, die auf „code“ enden (Startcode, TOTP-Code), werden geschwärzt – Fehlercodes deshalb als `fehlerart`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../gemeinsam/pfade.js';

const GEHEIM = /passw|geheim|secret|token|code$|csrf/i;

function schwaerzen(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const aus = {};
  for (const [k, v] of Object.entries(obj)) aus[k] = GEHEIM.test(k) ? '***' : (typeof v === 'string' ? v.slice(0, 500) : v);
  return aus;
}

export class WebProtokoll {
  constructor(ordner = PFADE.web, { aufbewahrung_monate = 12, ausgabe = null } = {}) {
    this.ordner = ordner; this.aufbewahrung_monate = aufbewahrung_monate; this.ausgabe = ausgabe;
    this.kette = Promise.resolve();
  }

  datei(zeit = new Date()) { return path.join(this.ordner, `web-${zeit.toISOString().slice(0, 7)}.log`); }

  /** Schreibt eine Zeile (asynchron, in Reihenfolge). Fehler beim Schreiben werden gemeldet, nie geworfen. */
  eintrag(art, daten = {}) {
    const zeit = new Date();
    const zeile = `${zeit.toISOString()} ${art} ${JSON.stringify(schwaerzen(daten))}\n`;
    if (this.ausgabe) { try { this.ausgabe(zeile); } catch { /* egal */ } }
    this.kette = this.kette.then(async () => {
      await fs.mkdir(this.ordner, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.datei(zeit), zeile, { mode: 0o600 });
    }).catch((e) => { process.stderr.write(`[web] Protokoll: ${e.message}\n`); });
    return this.kette;
  }

  /** Löscht Monatsdateien, die älter als die Aufbewahrung sind. */
  async rotieren() {
    let dateien = [];
    try { dateien = (await fs.readdir(this.ordner)).filter((d) => /^web-\d{4}-\d{2}\.log$/.test(d)).sort(); } catch { return 0; }
    const behalten = Math.max(1, this.aufbewahrung_monate);
    const grenze = new Date(); grenze.setUTCMonth(grenze.getUTCMonth() - behalten + 1, 1);
    const grenzMonat = grenze.toISOString().slice(0, 7);
    let n = 0;
    for (const d of dateien) {
      if (d.slice(4, 11) < grenzMonat) { try { await fs.unlink(path.join(this.ordner, d)); n++; } catch { /* egal */ } }
    }
    return n;
  }

  async stoppen() { await this.kette.catch(() => {}); }
}
