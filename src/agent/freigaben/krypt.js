// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Verschlüsselte Freigaben (Betreiber 12.10.2026: „mach alle 8 punkte“ – Punkt 7). Technik: gocryptfs. Die Daten liegen
// verschlüsselt in einem eigenen btrfs-Unterlaufwerk <daten>/.krypt/<name>; entsperrt erscheinen sie entschlüsselt am
// Einhängepunkt der Freigabe (<shares>/<name>, im gesperrten Zustand leer und unveränderlich). Nach einem Neustart ist die
// Freigabe gesperrt – außer der Schlüssel wurde bewusst auf dem NAS gespeichert (<konfig>/krypt/<name>.schluessel, 0600).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import { ansichtenLoesen } from '../aktionen/protokolle.js';
import * as samba from '../render/samba.js';

export const MIN_LAENGE = 8;

/** Pfade einer verschlüsselten Freigabe. */
export function kryptPfade(werkzeuge, name) {
  const w = (werkzeuge && werkzeuge.pfade) || {};
  const shares = w.shares || PFADE.shares;
  const daten = w.daten || path.dirname(shares);
  const konfig = (werkzeuge && werkzeuge.konfig && werkzeuge.konfig.ordner) || PFADE.konfig;
  return {
    geheim: path.join(daten, '.krypt', name), klar: path.join(shares, name),
    schluessel: path.join(konfig, 'krypt', `${name}.schluessel`), lauf: w.run || PFADE.run || '/run/fahnas',
  };
}

export function passwortPruefen(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_LAENGE) throw new FahnasFehler('E_PARAMS', `Das Passwort braucht mindestens ${MIN_LAENGE} Zeichen`, { feld: 'passwort' });
  if (pw.length > 256 || /[\r\n]/.test(pw)) throw new FahnasFehler('E_PARAMS', 'Das Passwort darf keinen Zeilenumbruch enthalten und höchstens 256 Zeichen lang sein', { feld: 'passwort' });
}

/** Passwort kurz in eine 0600-Datei im Laufzeitordner (tmpfs) schreiben – nie auf die Befehlszeile. */
async function mitPassdatei(p, passwort, fn) {
  await fs.mkdir(p.lauf, { recursive: true, mode: 0o700 });
  const datei = path.join(p.lauf, `krypt-${crypto.randomBytes(6).toString('hex')}`);
  await fs.writeFile(datei, `${passwort}\n`, { mode: 0o600 });
  try { return await fn(datei); } finally { await fs.rm(datei, { force: true }); }
}

/**
 * Entsperrt? Eine abgerissene Einhängung („Transport endpoint is not connected“, z. B. nach hartem Beenden von gocryptfs)
 * wird gelöst und zählt als gesperrt.
 */
export async function entsperrt(werkzeuge, name) {
  const p = kryptPfade(werkzeuge, name);
  if (!(await samba.eingehaengt(werkzeuge.system, p.klar))) return false;
  try { await fs.stat(p.klar); return true; } catch (e) {
    if (e && e.code === 'ENOTCONN') { try { await werkzeuge.system.ausfuehren('umount', ['-l', p.klar]); } catch { /* egal */ } return false; }
    return true;
  }
}

async function einhaengen(werkzeuge, p, passdatei) {
  try {
    // eigene systemd-Einheit: sonst beendet ein Neustart des Agenten (KillMode=mixed, also auch jedes Update) gocryptfs mit
    await werkzeuge.system.ausfuehren('systemd-run', ['--scope', `--unit=fahnas-krypt-${path.basename(p.klar)}-${crypto.randomBytes(3).toString('hex')}`, '--collect', '--quiet',
      'gocryptfs', '-q', '-allow_other', '-acl', '-passfile', passdatei, p.geheim, p.klar], { zeitlimit_ms: 60_000 });
  } catch (e) {
    const f = FahnasFehler.aus(e);
    if (f.details?.code === 12 || /password incorrect|Password incorrect/i.test(String(f.details?.ausgabe || ''))) throw new FahnasFehler('E_PARAMS', 'Das Passwort stimmt nicht', { feld: 'passwort' });
    throw new FahnasFehler('E_SYSTEM', `Freigabe ließ sich nicht entsperren: ${String(f.details?.ausgabe || f.message).trim().split('\n').pop()}`, { ausgabe: f.details?.ausgabe });
  }
}

async function schluesselMerken(p, passwort, merken) {
  if (merken) { await fs.mkdir(path.dirname(p.schluessel), { recursive: true, mode: 0o700 }); await fs.writeFile(p.schluessel, `${passwort}\n`, { mode: 0o600 }); await fs.chmod(p.schluessel, 0o600); }
  else await fs.rm(p.schluessel, { force: true });
}

/** Neu anlegen: Unterlaufwerk für die verschlüsselten Daten, gocryptfs -init, Einhängepunkt sperren, entsperren. */
export async function anlegen(werkzeuge, name, passwort, merken = false) {
  passwortPruefen(passwort);
  await paketeSicherstellen(werkzeuge.system, ['gocryptfs'], { zweck: 'verschlüsselte Freigaben' });
  const p = kryptPfade(werkzeuge, name);
  await fs.mkdir(path.dirname(p.geheim), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(p.geheim), 0o700).catch(() => {});
  await werkzeuge.system.ausfuehren('btrfs', ['subvolume', 'create', p.geheim]);
  await fs.chmod(p.geheim, 0o700).catch(() => {});
  await mitPassdatei(p, passwort, (datei) => werkzeuge.system.ausfuehren('gocryptfs', ['-q', '-init', '-passfile', datei, p.geheim], { zeitlimit_ms: 120_000 }));
  await fs.mkdir(p.klar, { recursive: true, mode: 0o755 });
  try { await werkzeuge.system.ausfuehren('chattr', ['+i', p.klar]); } catch { /* ohne Attribute */ }
  await mitPassdatei(p, passwort, (datei) => einhaengen(werkzeuge, p, datei));
  await schluesselMerken(p, passwort, merken);
}

/** Entsperren mit Passwort (optional Schlüssel für den automatischen Start merken/vergessen). */
export async function entsperren(werkzeuge, name, passwort, merken = null) {
  const p = kryptPfade(werkzeuge, name);
  if (!(await entsperrt(werkzeuge, name))) await mitPassdatei(p, passwort, (datei) => einhaengen(werkzeuge, p, datei));
  if (merken !== null) await schluesselMerken(p, passwort, merken);
}

/** Beim Start: mit gespeichertem Schlüssel entsperren (sonst bleibt die Freigabe gesperrt). */
export async function automatisch(werkzeuge, name) {
  const p = kryptPfade(werkzeuge, name);
  if (await entsperrt(werkzeuge, name)) return true;
  try { await fs.access(p.schluessel); } catch { return false; }
  await einhaengen(werkzeuge, p, p.schluessel);
  return true;
}

export async function schluesselGespeichert(werkzeuge, name) { try { await fs.access(kryptPfade(werkzeuge, name).schluessel); return true; } catch { return false; } }

/** Sperren: Ansichten lösen, aushängen (belegt → Fehler). */
export async function sperren(werkzeuge, name, { lazy = false } = {}) {
  const p = kryptPfade(werkzeuge, name);
  if (!(await entsperrt(werkzeuge, name))) return false;
  try { await werkzeuge.system.ausfuehren('smbcontrol', ['all', 'close-share', name], { erlaubteCodes: [0, 1, 255] }); } catch { /* smbd aus */ }
  await ansichtenLoesen(werkzeuge, p.klar);
  // root: umount statt fusermount (fusermount -u scheitert als root mit „Permission denied“); gocryptfs endet danach selbst
  try { await werkzeuge.system.ausfuehren('umount', [...(lazy ? ['-l'] : []), p.klar], { zeitlimit_ms: 60_000 }); } catch (e) {
    throw new FahnasFehler('E_BELEGT', 'Die Freigabe wird noch benutzt (offene Dateien, App oder Rechner) – bitte schließen und erneut sperren', { ausgabe: FahnasFehler.aus(e).details?.ausgabe });
  }
  return true;
}

/** Löschen: sperren, verschlüsselte Daten löschen oder (behalten) in den Sicherungsordner verschieben, Reste weg. */
export async function loeschen(werkzeuge, name, { behalten = false, backup = null } = {}) {
  const p = kryptPfade(werkzeuge, name);
  await sperren(werkzeuge, name, { lazy: true }).catch(() => {});
  let aufbewahrt = null;
  try {
    if (behalten && backup) {
      await fs.mkdir(path.join(backup, 'geloescht'), { recursive: true });
      aufbewahrt = path.join(backup, 'geloescht', `${name}-verschluesselt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await werkzeuge.system.ausfuehren('mv', [p.geheim, aufbewahrt]);
    } else await werkzeuge.system.ausfuehren('btrfs', ['subvolume', 'delete', p.geheim]);
  } catch { /* nichts angelegt */ }
  try { await werkzeuge.system.ausfuehren('chattr', ['-i', p.klar]); } catch { /* egal */ }
  try { await fs.rmdir(p.klar); } catch { /* weg */ }
  await fs.rm(p.schluessel, { force: true });
  return aufbewahrt;
}
