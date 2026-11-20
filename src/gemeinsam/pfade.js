// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zentrale Pfade (per Umgebung überschreibbar) und sichere Pfadauflösung innerhalb erlaubter Wurzeln.

import path from 'node:path';
import fs from 'node:fs/promises';
import { FahnasFehler } from './fehler.js';

const u = process.env;
export const PFADE = Object.freeze({
  konfig: u.FAHNAS_CONFIG || '/data/config',
  run: u.FAHNAS_RUN || '/run/fahnas',
  shares: u.FAHNAS_SHARES || '/data/shares',
  snapshots: u.FAHNAS_SNAPSHOTS || '/data/.snapshots',
  samba: u.FAHNAS_SAMBA || '/etc/samba/fahnas',
  apps: u.FAHNAS_APPS || '/data/apps',
  vms: u.FAHNAS_VMS || '/data/vms',
  backup: u.FAHNAS_BACKUP || '/data/backup',
  programm: u.FAHNAS_PROGRAMM || '/opt/fahnas',
  get katalog() { return u.FAHNAS_KATALOG || path.join(this.programm, 'katalog'); },
  geo: u.FAHNAS_GEO || '/data/geo',                                          // monatlich geladene Stadt-Ortsdaten (kein Export)
  vorschau: u.FAHNAS_VORSCHAU || '/data/vorschau',                             // Vorschaubilder des Dateimanagers (Zwischenspeicher, kein Export)
  chat: u.FAHNAS_CHAT || '/data/chat',                                          // Chat-Speicher (Räume, Verläufe, Anhänge; root 0700, kein Export)
  get geoMit() { return u.FAHNAS_GEO_MIT || path.join(this.programm, 'geo'); }, // mitgelieferte Länder-Ortsdaten + laender.json
  startcode: u.FAHNAS_STARTCODE || '/etc/fahnas/startcode',
  daten: u.FAHNAS_DATEN || '/data',
  importe: u.FAHNAS_IMPORT || '/data/import',                                  // übernommene Volumes eines anderen NAS (root 0700)
  avahi: u.FAHNAS_AVAHI || '/etc/avahi/services',
  snapper: u.FAHNAS_SNAPPER || '/etc/snapper/configs',
  snapperDefault: u.FAHNAS_SNAPPER_DEFAULT || '/etc/default/snapper',
  grubCfg: u.FAHNAS_GRUB_CFG || '/boot/grub/grub.cfg',
  netplan: u.FAHNAS_NETPLAN || '/etc/netplan',
  nft: u.FAHNAS_NFT || '/etc/nftables.d/fahnas.nft',
  get agentSocket() { return path.join(this.run, 'agent.sock'); },
  get datenSocket() { return path.join(this.run, 'daten.sock'); },
  get protokoll() { return path.join(this.konfig, 'protokoll'); },
  get web() { return path.join(this.konfig, 'web'); },
});

const NAME_FREIGABE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Prüft einen Freigabenamen (klein, ohne Sonderzeichen). */
export function pruefeFreigabename(name) {
  if (typeof name !== 'string' || !NAME_FREIGABE.test(name)) {
    throw new FahnasFehler('E_PARAMS', 'Freigabename darf nur a-z, 0-9, - und _ enthalten (max. 32 Zeichen)', { feld: 'name' });
  }
  return name;
}

/**
 * Normalisiert einen relativen Pfad innerhalb einer Freigabe: kein absoluter Pfad, kein "..", keine Steuerzeichen.
 * Gibt den bereinigten relativen Pfad zurück ("" = Wurzel der Freigabe).
 */
export function relativerPfad(p) {
  if (p === undefined || p === null) return '';
  if (typeof p !== 'string') throw new FahnasFehler('E_PARAMS', 'Pfad muss Text sein', { feld: 'pfad' });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) throw new FahnasFehler('E_PARAMS', 'Pfad enthält Steuerzeichen', { feld: 'pfad' });
  const teile = p.split('/').filter((t) => t !== '' && t !== '.');
  if (teile.some((t) => t === '..')) throw new FahnasFehler('E_PARAMS', 'Pfad darf nicht aus der Freigabe hinausführen', { feld: 'pfad' });
  return teile.join('/');
}

/**
 * Löst `rel` unterhalb von `wurzel` auf und stellt sicher, dass das ECHTE Ziel (nach Symlinks) innerhalb der Wurzel
 * liegt. Existiert das Ziel noch nicht (z. B. beim Anlegen), wird der längste existierende Elternteil geprüft.
 * @returns {Promise<string>} absoluter Pfad
 */
export async function sicherAufloesen(wurzel, rel) {
  const r = relativerPfad(rel);
  const wurzelEcht = await fs.realpath(wurzel);
  const ziel = path.join(wurzelEcht, r);
  // längsten existierenden Elternteil per realpath prüfen
  let pruef = ziel;
  let rest = [];
  for (;;) {
    try {
      const echt = await fs.realpath(pruef);
      const echtZiel = path.join(echt, ...rest);
      if (echtZiel !== wurzelEcht && !echtZiel.startsWith(wurzelEcht + path.sep)) {
        throw new FahnasFehler('E_RECHTE', 'Pfad zeigt aus der Freigabe hinaus', { feld: 'pfad' });
      }
      return echtZiel;
    } catch (e) {
      if (e instanceof FahnasFehler) throw e;
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw FahnasFehler.aus(e);
      const eltern = path.dirname(pruef);
      if (eltern === pruef) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Wurzel nicht gefunden');
      rest.unshift(path.basename(pruef));
      pruef = eltern;
    }
  }
}

/** Prüft einen einzelnen Datei-/Ordnernamen (kein Pfadtrenner, nicht "." oder ".."). */
export function pruefeDateiname(name, feld = 'name') {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    throw new FahnasFehler('E_PARAMS', 'Name fehlt oder ist zu lang', { feld });
  }
  // eslint-disable-next-line no-control-regex
  if (name === '.' || name === '..' || /[\/\u0000-\u001f]/.test(name)) {
    throw new FahnasFehler('E_PARAMS', 'Name enthält unerlaubte Zeichen', { feld });
  }
  return name;
}
