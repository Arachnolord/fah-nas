// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konfigurationsablage: JSON-Dateien unter /data/config, atomar geschrieben (tmp + fsync + rename),
// mit Standardwerten geladen. Die Konfiguration ist die Wahrheit – das System wird daraus gerendert.
//
// Nebenläufigkeit: je Datei gibt es EINE Kette. `speichern` und `aendern` reihen sich dort ein; `aendern` lädt
// INNERHALB der Kette (Lesen-Ändern-Schreiben unter derselben Sperre), damit zwei gleichzeitige Änderungen
// derselben Datei sich nicht gegenseitig überschreiben (kein „Lost Update“ – z. B. Login schreibt
// letzte_anmeldung, während der Admin einen Nutzer anlegt). Module benutzen deshalb für alles, was liest und
// zurückschreibt, `aendern` statt `laden` + `speichern`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from './pfade.js';
import { FahnasFehler } from './fehler.js';

export const SCHEMA_VERSION = 1;

/** Dateien mit Geheimnissen (Hashes, TOTP, Download-Tokens) liest nur root – gilt für speichern UND aendern. */
export const MODUS = Object.freeze({ 'users.json': 0o600, 'links.json': 0o600, 'spiegelung-zugaenge.json': 0o600, 'benachrichtigungen.json': 0o600, 'vpn.json': 0o600, 'energie.json': 0o600, 'chat.json': 0o600, 'office.json': 0o600, 'fahgit.json': 0o600 }); // Zugangsdaten anderer NAS (Spiegelung)

/** Rückgabewert für `aendern`-Funktionen: „nichts geändert“ → es wird nicht geschrieben. */
export const UNVERAENDERT = Symbol('unveraendert');

export const STANDARD = Object.freeze({
  'system.json': {
    hostname: 'fahnas',
    zeitzone: 'Europe/Berlin',
    sprache: 'de',
    design: 'auto',
    netz: { modus: 'dhcp', schnittstelle: null, adresse: null, gateway: null, dns: [] },
    energie: { platten_ruhe_min: 0, zeitplan: [] },
    aufbewahrung: { protokoll_monate: 12 },
    vertraute_proxys: [],
    ssh: true,
    // SSH-Port (Betreiber 11.11.2026: eigener Port statt 22 möglich, System → Dienste); 22 = Ubuntus Standard
    ssh_port: 22,
    // Samba-Freigabe „docker“ = App-Ordner /data/apps zum Anpassen von Hand (nur Admins, Zugriff als root)
    docker_freigabe: false,
    // Weltkarte (Übersicht): Standort des NAS für die Bögen, Verbindungen aufzeichnen (nur im Arbeitsspeicher, 1 h),
    // Stadt-Ortsdaten (DB-IP City Lite) monatlich laden – aus: nur die mitgelieferte Länder-Datenbank
    standort: { lat: null, lon: null, name: '' },
    verbindungen: { aufzeichnen: true },
    geo: { stadt_laden: true },
    // Anmeldeschutz (16.10.2026): Anmelden aus dem Internet nur aus diesen Ländern (ISO-Kürzel; leer = alle). Heimnetz/VPN immer.
    anmeldeschutz: { laender: ['DE'] },
    version: SCHEMA_VERSION,
  },
  'users.json': { nutzer: [], gruppen: [] },
  'shares.json': { freigaben: [] },
  'snapshots.json': {
    plaene: [
      { ziel: 'system', zeitplan: { stuendlich: false, taeglich: true, woechentlich: true }, behalten: { stuendlich: 0, taeglich: 7, woechentlich: 4, pre_post: 10 } },
    ],
  },
  'version.json': { schema: SCHEMA_VERSION },
});

export class Konfig {
  constructor(ordner = PFADE.konfig) {
    this.ordner = ordner;
    this.sperren = new Map(); // je Datei eine Kette, damit Lesen-Ändern-Schreiben nacheinander läuft
  }

  pfad(name) {
    if (!/^[a-z0-9_./-]+\.json$/i.test(name) || name.includes('..')) throw new FahnasFehler('E_KONFIG', 'Ungültiger Konfigurationsname', { name });
    return path.join(this.ordner, name);
  }

  async sicherstellen() {
    await fs.mkdir(this.ordner, { recursive: true, mode: 0o750 });
    for (const unter of ['protokoll', 'web', 'apps', 'vms', 'eingang']) {
      await fs.mkdir(path.join(this.ordner, unter), { recursive: true, mode: 0o750 });
    }
    for (const [name, standard] of Object.entries(STANDARD)) {
      try { await fs.access(this.pfad(name)); } catch { await this.speichern(name, standard); }
    }
  }

  /** Lädt eine JSON-Datei; fehlt sie, gilt `standard` (bzw. der eingebaute Standard). Bei kaputtem JSON: E_KONFIG. */
  async laden(name, standard) {
    const p = this.pfad(name);
    let text;
    try { text = await fs.readFile(p, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(standard !== undefined ? standard : (STANDARD[name] ?? null));
      throw FahnasFehler.aus(e);
    }
    try { return JSON.parse(text); } catch {
      throw new FahnasFehler('E_KONFIG', `Konfigurationsdatei ${name} ist beschädigt`, { name });
    }
  }

  /** Reiht `arbeit` in die Kette der Datei ein; ein Fehler in der Arbeit bricht die Kette nicht ab. */
  _inKette(name, arbeit) {
    const vorher = this.sperren.get(name) || Promise.resolve();
    const lauf = vorher.catch(() => {}).then(arbeit);
    this.sperren.set(name, lauf);
    return lauf;
  }

  /** Roher atomarer Schreibvorgang – nur innerhalb der Kette aufrufen. */
  async _schreiben(p, daten, modus) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    // Eine liegen gebliebene tmp-Datei (Absturz) darf ihren alten Modus nicht weitervererben: weg damit, dann exklusiv anlegen.
    try { await fs.unlink(tmp); } catch { /* nicht da */ }
    const fh = await fs.open(tmp, 'wx', modus);
    try {
      await fh.writeFile(JSON.stringify(daten, null, 2) + '\n', 'utf8');
      await fh.sync();
    } finally { await fh.close(); }
    await fs.rename(tmp, p);
  }

  /**
   * Schreibt atomar: <name>.tmp → fsync → rename. Rechte laut MODUS-Tabelle (Geheimnisse 0600), sonst 0640
   * (root:fahnas – der Web-Dienst darf system.json lesen).
   */
  async speichern(name, daten, modus = MODUS[name] ?? 0o640) {
    const p = this.pfad(name);
    try { await this._inKette(name, () => this._schreiben(p, daten, modus)); } catch (e) { throw FahnasFehler.aus(e); }
  }

  /**
   * Lesen-Ändern-Schreiben in EINEM Zug unter der Sperre der Datei: `aendern(daten)` gibt die neuen Daten zurück
   * (oder verändert in place). Wirft die Änderungsfunktion, wird nichts geschrieben und der Fehler weitergereicht;
   * gibt sie `UNVERAENDERT` zurück, wird ebenfalls nicht geschrieben. Rückgabe: die (geschriebenen) Daten.
   */
  async aendern(name, aendern, standard, modus) {
    const p = this.pfad(name);
    return this._inKette(name, async () => {
      const daten = await this.laden(name, standard);
      const r = await aendern(daten);
      if (r === UNVERAENDERT) return daten;
      const neu = r ?? daten;
      try { await this._schreiben(p, neu, modus ?? MODUS[name] ?? 0o640); } catch (e) { throw FahnasFehler.aus(e); }
      return neu;
    });
  }
}
