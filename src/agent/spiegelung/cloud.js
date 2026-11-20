// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung mit Cloud-Speichern über rclone (Ausbau Oktober 2026): S3 (Amazon, Hetzner, Wasabi, MinIO …), Backblaze B2,
// WebDAV/Nextcloud und SFTP – alles ohne OAuth (das bräuchte eine Anmeldung im Browser auf dem NAS). Einseitig in beide
// Richtungen (NAS → Cloud als Sicherung, Cloud → NAS). Zugangsdaten nur in einer kurzlebigen 0600-rclone.conf.
// Wie bei rsync: Leer-Schutz, Papierkorb (--backup-dir .fah-papierkorb/<Stempel>, 30 Tage), Vorschau (--dry-run).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import { PAPIERKORB, papierkorbAlt, stempel } from './regeln.js';
import { korbOrte, korbAbschliessen, korbAufraeumen } from './korb.js';

export const ANBIETER = Object.freeze(['s3', 'b2', 'webdav', 'sftp']);
const RCLONE_SCHLUESSEL = Buffer.from('9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638', 'hex');
const UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/root' });
const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
const STEUER = /[\u0000-\u001f\u007f]/;

/** Wie „rclone obscure“: AES-256-CTR mit rclones festem Schlüssel, zufälligem IV, Base64-URL ohne Füllung. */
export function obscure(klartext, iv = crypto.randomBytes(16)) {
  const c = crypto.createCipheriv('aes-256-ctr', RCLONE_SCHLUESSEL, iv);
  return Buffer.concat([iv, c.update(Buffer.from(String(klartext), 'utf8')), c.final()]).toString('base64url');
}
export function reveal(text) {
  const b = Buffer.from(String(text), 'base64url');
  const d = crypto.createDecipheriv('aes-256-ctr', RCLONE_SCHLUESSEL, b.subarray(0, 16));
  return Buffer.concat([d.update(b.subarray(16)), d.final()]).toString('utf8');
}

const text = (v, max = 256) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

/**
 * Cloud-Verbindung prüfen/normalisieren. Geheimnisse (schluessel/passwort) leer = unverändert (aus `vorher`).
 * @returns {{art:'cloud', anbieter, adresse, benutzer, endpunkt?, region?, hersteller?, port?, schluessel_id?, schluessel?, passwort?}}
 */
export function cloudNormal(e, vorher = null) {
  const anbieter = ANBIETER.includes(e.anbieter) ? e.anbieter : null;
  if (!anbieter) throw fehler('Bitte den Cloud-Anbieter wählen', 'anbieter');
  const alt = vorher && vorher.art === 'cloud' && vorher.anbieter === anbieter ? vorher : {};
  const geheim = (feld) => { const v = typeof e[feld] === 'string' ? e[feld] : ''; return v || alt[feld] || ''; };
  const z = { art: 'cloud', anbieter };
  if (anbieter === 's3') {
    z.endpunkt = text(e.endpunkt, 260).replace(/\/+$/, '');
    if (z.endpunkt && !/^https?:\/\/[^\s/]+/.test(z.endpunkt)) throw fehler('Endpunkt bitte mit https:// angeben (leer = Amazon S3)', 'endpunkt');
    z.region = text(e.region, 40);
    z.schluessel_id = text(e.schluessel_id, 128); z.schluessel = geheim('schluessel');
    if (!z.schluessel_id) throw fehler('Zugriffsschlüssel (Access Key ID) fehlt', 'schluessel_id');
    if (!z.schluessel) throw fehler('Geheimer Schlüssel (Secret Access Key) fehlt', 'schluessel');
    z.adresse = z.endpunkt ? z.endpunkt.replace(/^https?:\/\//, '') : 'Amazon S3'; z.benutzer = z.schluessel_id;
  } else if (anbieter === 'b2') {
    z.schluessel_id = text(e.schluessel_id, 128); z.schluessel = geheim('schluessel');
    if (!z.schluessel_id || !z.schluessel) throw fehler('Backblaze: keyID und applicationKey eintragen', 'schluessel_id');
    z.adresse = 'Backblaze B2'; z.benutzer = z.schluessel_id;
  } else if (anbieter === 'webdav') {
    z.endpunkt = text(e.endpunkt, 500).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(z.endpunkt)) throw fehler('WebDAV-Adresse bitte vollständig angeben, z. B. https://cloud.example.de/remote.php/dav/files/NAME', 'endpunkt');
    z.hersteller = ['nextcloud', 'owncloud', 'other'].includes(e.hersteller) ? e.hersteller : 'other';
    z.benutzer = text(e.benutzer, 128); z.passwort = geheim('passwort');
    if (!z.benutzer || !z.passwort) throw fehler('WebDAV: Benutzer und Passwort (bei Nextcloud ein App-Passwort) eintragen', 'benutzer');
    z.adresse = z.endpunkt.replace(/^https?:\/\//, '').split('/')[0];
  } else {
    z.adresse = text(e.adresse, 253);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(z.adresse)) throw fehler('SFTP: Adresse des Servers, z. B. backup.example.de', 'adresse');
    z.port = Number(e.port) || 22;
    if (!Number.isInteger(z.port) || z.port < 1 || z.port > 65535) throw fehler('SFTP: Port 1–65535', 'port');
    z.benutzer = text(e.benutzer, 64); z.passwort = geheim('passwort');
    if (!z.benutzer || !z.passwort) throw fehler('SFTP: Benutzer und Passwort eintragen', 'benutzer');
  }
  for (const [k, v] of Object.entries(z)) if (typeof v === 'string' && (STEUER.test(v) || /[\n\r]/.test(v))) throw fehler('Unerlaubte Zeichen', k);
  return z;
}

/** Cloud-Verbindung samt Name, Kennung und Zeitstempeln (gespeicherte Form). */
export function cloudZugangNormal(e, { id, jetzt = new Date(), vorher = null } = {}) {
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name || name.length > 40 || STEUER.test(name)) throw fehler('Name: 1–40 Zeichen, keine Steuerzeichen', 'name');
  const zeit = jetzt.toISOString();
  return { id, name, ...cloudNormal(e, vorher), erstellt: vorher?.erstellt || zeit, geaendert: zeit };
}

/** Wohin muss das NAS für diese Verbindung kommen? (für „nachholen, sobald erreichbar“) */
export function cloudHost(z) {
  if (z.anbieter === 'sftp') return { host: z.adresse, port: z.port || 22 };
  if (z.anbieter === 'b2') return { host: 'api.backblazeb2.com', port: 443 };
  const url = z.endpunkt || 'https://s3.amazonaws.com';
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443) }; } catch { return { host: 's3.amazonaws.com', port: 443 }; }
}

/** Inhalt der rclone.conf für eine Verbindung (Abschnitt [fern]). */
export function rcloneKonfig(z, verschleiern = obscure) {
  const zeilen = ['[fern]'];
  const setze = (k, v) => { if (v !== undefined && v !== null && v !== '') zeilen.push(`${k} = ${v}`); };
  if (z.anbieter === 's3') { setze('type', 's3'); setze('provider', z.endpunkt ? 'Other' : 'AWS'); setze('env_auth', 'false'); setze('access_key_id', z.schluessel_id); setze('secret_access_key', z.schluessel); setze('endpoint', z.endpunkt); setze('region', z.region); }
  else if (z.anbieter === 'b2') { setze('type', 'b2'); setze('account', z.schluessel_id); setze('key', z.schluessel); }
  else if (z.anbieter === 'webdav') { setze('type', 'webdav'); setze('url', z.endpunkt); setze('vendor', z.hersteller); setze('user', z.benutzer); setze('pass', verschleiern(z.passwort)); }
  else { setze('type', 'sftp'); setze('host', z.adresse); setze('port', z.port); setze('user', z.benutzer); setze('pass', verschleiern(z.passwort)); setze('shell_type', 'none'); setze('disable_hashcheck', 'true'); }
  return zeilen.join('\n') + '\n';
}

/** Ziel „fern:freigabe/pfad“ (Freigabe = Bucket bei S3/B2, oberster Ordner bei WebDAV/SFTP). */
export const fernPfad = (freigabe, pfad = '') => `fern:${[freigabe, pfad].filter(Boolean).join('/')}`;

/** rclone-Fehlertext deuten: Netz weg (→ nachholen), Anmeldung, nicht gefunden, sonst Text. */
export function cloudFehlerDeuten(t) {
  const s = String(t || '');
  if (/no such host|dial tcp|i\/o timeout|connection refused|network is unreachable|TLS handshake timeout|temporary failure in name resolution/i.test(s)) return { art: 'nicht_erreichbar' };
  if (/401|403|InvalidAccessKeyId|SignatureDoesNotMatch|unauthorized|Unauthorized|bad_auth_token|permission denied|unable to authenticate|AccessDenied/i.test(s)) return { art: 'anmeldung' };
  if (/directory not found|NoSuchBucket|object not found|404/i.test(s)) return { art: 'fehlt' };
  return { art: 'sonst', text: s.trim().split('\n').filter(Boolean).pop()?.replace(/^.*?(ERROR|NOTICE|Failed to [^:]+):\s*/, '').slice(0, 220) || 'unbekannter Fehler' };
}

export function cloudFehler(z, t) {
  const d = cloudFehlerDeuten(t);
  if (d.art === 'nicht_erreichbar') return new FahnasFehler('E_NICHT_GEFUNDEN', `Cloud „${z.name}“ ist nicht erreichbar – der Lauf wird nachgeholt`, { grund: 'nicht_eingehaengt', zugang: z.id });
  if (d.art === 'anmeldung') return new FahnasFehler('E_RECHTE', `Anmeldung bei „${z.name}“ abgelehnt – Schlüssel, Benutzer oder Passwort prüfen`, { zugang: z.id });
  if (d.art === 'fehlt') return new FahnasFehler('E_NICHT_GEFUNDEN', `Bucket bzw. Ordner gibt es bei „${z.name}“ nicht`, { zugang: z.id });
  return new FahnasFehler('E_SYSTEM', `Cloud „${z.name}“: ${d.text}`, { zugang: z.id });
}

const GROESSE = /([\d.]+)\s*(B|[KMGTP]i?B)\s*\/\s*([\d.]+)\s*(B|[KMGTP]i?B),\s*(\d{1,3})%/;
const FAKTOR = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

/** Fortschritt aus der einzeiligen Statistik („NOTICE:   12 MiB / 40 MiB, 30%, 6 MiB/s, ETA 4s“) → 0..1 oder null. */
export function rcloneFortschritt(zeile) {
  const m = GROESSE.exec(String(zeile || ''));
  return m && /NOTICE:|Transferred:/.test(zeile) ? Math.min(1, Number(m[5]) / 100) : null;
}

/**
 * Zahlen eines Laufs aus den INFO-Zeilen (-v) und der letzten Statistikzeile: übertragen = „Copied (…)“, gelöscht =
 * „Deleted“ bzw. „Moved into backup dir“ ohne die ersetzten Dateien (die wandern vorher ebenfalls in den Papierkorb).
 */
export function rcloneStatistik(zeilen, letzteStatistik = '') {
  const l = Array.isArray(zeilen) ? zeilen : String(zeilen || '').split('\n');
  const zaehle = (re) => l.filter((z) => re.test(z)).length;
  const kopiert = zaehle(/: Copied \((new|replaced existing)\)/);
  const ersetzt = zaehle(/: Copied \(replaced existing\)/);
  const gesichert = zaehle(/: Moved into backup dir/);
  const geloescht = zaehle(/: Deleted$/) + Math.max(0, gesichert - ersetzt);
  const m = GROESSE.exec(String(letzteStatistik || ''));
  return { uebertragen: kopiert, geloescht, neu: kopiert - ersetzt, bytes_uebertragen: m ? Math.round(Number(m[1]) * (FAKTOR[m[2]] || 1)) : 0 };
}

/** Vorschau aus --dry-run (NOTICE: name: Skipped copy/delete as --dry-run is set). */
export function rcloneVorschau(zeilen, max = 300) {
  const aus = { neu: 0, geaendert: 0, geloescht: 0, ordner_neu: 0, zeilen: [] };
  for (const z of zeilen) {
    const m = /NOTICE:\s+(.+?):\s+Skipped (copy|update|delete|remove directory|make directory) as --dry-run/.exec(z);
    if (!m) continue;
    if (m[2] === 'delete') { aus.geloescht++; if (aus.zeilen.length < max) aus.zeilen.push(`− ${m[1]}`); }
    else if (m[2] === 'copy') { aus.neu++; if (aus.zeilen.length < max) aus.zeilen.push(`+ ${m[1]}`); }
    else if (m[2] === 'update') { aus.geaendert++; if (aus.zeilen.length < max) aus.zeilen.push(`~ ${m[1]}`); }
    else if (m[2] === 'make directory') aus.ordner_neu++;
  }
  return aus;
}

/** rclone mit kurzlebiger 0600-Konfiguration ausführen. */
export async function mitRclone(w, z, arbeit) {
  await paketeSicherstellen(w.system, ['rclone'], { zweck: 'Cloud-Spiegelungen' });
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-rclone-'));
  const konf = path.join(ordner, 'rclone.conf');
  await fs.writeFile(konf, rcloneKonfig(z), { mode: 0o600 });
  try { return await arbeit(konf); } finally { await fs.rm(ordner, { recursive: true, force: true }); }
}

async function rclone(w, konf, args, o = {}) {
  return w.system.ausfuehren('rclone', ['--config', konf, ...args], { umgebung: UMGEBUNG, zeitlimit_ms: 60_000, ...o });
}

/** Oberste Ebene (Buckets bzw. Ordner) – „Verbindung prüfen“. */
export async function cloudFreigaben(w, z) {
  return mitRclone(w, z, async (konf) => {
    try {
      const r = await rclone(w, konf, ['lsf', '--dirs-only', '--max-depth', '1', 'fern:'], { zeitlimit_ms: 45_000 });
      return String(r.stdout || '').split('\n').map((x) => x.replace(/\/$/, '').trim()).filter((x) => x && !x.startsWith('.')).map((name) => ({ name, kommentar: '' }));
    } catch (e) { const f = FahnasFehler.aus(e); throw cloudFehler(z, `${f.details?.ausgabe || ''} ${f.message}`); }
  });
}

/** Unterordner für die Ordnerwahl. */
export async function cloudOrdner(w, z, freigabe, rel) {
  return mitRclone(w, z, async (konf) => {
    try {
      const r = await rclone(w, konf, ['lsf', '--dirs-only', '--max-depth', '1', fernPfad(freigabe, rel)], { zeitlimit_ms: 45_000 });
      return String(r.stdout || '').split('\n').map((x) => x.replace(/\/$/, '').trim()).filter((x) => x && !x.startsWith('.') && !x.startsWith('@')).sort((a, b) => a.localeCompare(b, 'de'));
    } catch (e) { const f = FahnasFehler.aus(e); throw cloudFehler(z, `${f.details?.ausgabe || ''} ${f.message}`); }
  });
}

/** Neuen Ordner anlegen (Ordnerwahl). Bei S3/B2 gibt es leere Ordner nicht – dort entsteht er beim ersten Lauf. */
export async function cloudOrdnerAnlegen(w, z, freigabe, rel, name) {
  return mitRclone(w, z, async (konf) => {
    try { await rclone(w, konf, ['mkdir', fernPfad(freigabe, rel ? `${rel}/${name}` : name)], { zeitlimit_ms: 45_000 }); } catch (e) { const f = FahnasFehler.aus(e); throw cloudFehler(z, `${f.details?.ausgabe || ''} ${f.message}`); }
  });
}

/**
 * Ein Cloud-Lauf (einseitig). `ort(seite)` liefert für lokale Seiten den aufgelösten Pfad ({voll, anzeige}).
 * `starten` = Prozess mit Zeilen (wie bei rsync). Rückgabe wie laufen(): {ergebnis, meldung, zahlen, protokoll, vorschau?}.
 */
export async function laufenCloud(w, auftrag, z, { lokal, vorschau = false, melde = () => {}, abgebrochen = () => false, prozess, jetzt = new Date() }) {
  if (auftrag.richtung !== 'einseitig') throw new FahnasFehler('E_PARAMS', 'Mit Cloud-Speichern geht nur „einseitig“', { feld: 'richtung' });
  const nachCloud = !!auftrag.ziel.zugang;
  const cloudSeite = nachCloud ? auftrag.ziel : auftrag.quelle;
  const fern = fernPfad(cloudSeite.freigabe, cloudSeite.pfad);
  const anzeigeCloud = `${z.name}: ${cloudSeite.freigabe}${cloudSeite.pfad ? `/${cloudSeite.pfad}` : ''}`;
  return mitRclone(w, z, async (konf) => {
    const leer = async (ort) => {
      if (!ort.startsWith('fern:')) { try { return !(await fs.readdir(ort)).some((n) => n !== PAPIERKORB && n !== '.papierkorb'); } catch { return true; } }
      try { const r = await rclone(w, konf, ['lsf', '--max-depth', '1', ort], { zeitlimit_ms: 60_000 }); return !String(r.stdout).split('\n').some((n) => n.trim() && !n.startsWith(PAPIERKORB)); } catch (e) {
        const f = FahnasFehler.aus(e); const d = cloudFehlerDeuten(`${f.details?.ausgabe || ''} ${f.message}`);
        if (d.art === 'fehlt') return true; throw cloudFehler(z, `${f.details?.ausgabe || ''} ${f.message}`);
      }
    };
    const quelle = nachCloud ? lokal.voll : fern;
    const ziel = nachCloud ? fern : lokal.voll;
    if (!nachCloud && !vorschau) await fs.mkdir(ziel, { recursive: true });
    if (await leer(quelle) && !(await leer(ziel))) throw new FahnasFehler('E_SYSTEM', 'Die Quelle ist leer, das Ziel aber nicht – zum Schutz vor Datenverlust abgebrochen. Ist die Quelle richtig gewählt?', { grund: 'quelle_leer' });
    const st = stempel(jetzt);
    // Die Cloud hat keine Freigaben: dort bleibt der Ordner im Ziel. Lokal gilt der Papierkorb der Freigabe.
    const korb = !nachCloud && lokal.wurzel ? korbOrte(lokal, auftrag.id, st) : null;
    const papierkorb = korb ? korb.inhalt : nachCloud ? `${fern}/${PAPIERKORB}/${st}` : path.join(ziel, PAPIERKORB, st);
    const kopf = `Einseitig: ${nachCloud ? lokal.anzeige : anzeigeCloud} → ${nachCloud ? anzeigeCloud : lokal.anzeige} (rclone)`;
    const args = ['--config', konf, 'sync', quelle, ziel, '--exclude', `/${PAPIERKORB}/**`, '--exclude', '/.papierkorb/**', '--stats', '2s', '--stats-one-line', '--stats-log-level', 'NOTICE', '-v', '--retries', '3', '--low-level-retries', '10'];
    if (vorschau) args.push('--dry-run'); else args.push('--backup-dir', papierkorb);
    melde(0, vorschau ? 'Vorschau wird berechnet …' : 'Dateien werden verglichen …');
    let letzte = 0; let letzteStatistik = '';
    const r = await prozess('rclone', args, {
      umgebung: UMGEBUNG, abgebrochen,
      beiZeile: vorschau ? null : (zeile) => { const p = rcloneFortschritt(zeile); if (p === null) return false; letzteStatistik = zeile; if (Date.now() - letzte > 1000) { letzte = Date.now(); melde(p, `${Math.round(p * 100)} %`); } return true; },
    });
    if (abgebrochen()) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
    const zahlen = rcloneStatistik(r.zeilen, letzteStatistik);
    if (r.code !== 0) {
      const f = cloudFehler(z, r.zeilen.slice(-12).join('\n'));
      if (f.details?.grund === 'nicht_eingehaengt' || f.code === 'E_RECHTE') throw f;
      throw new FahnasFehler('E_SYSTEM', `Abgleich fehlgeschlagen (rclone ${r.code}): ${f.message.replace(/^Cloud „[^“]*“: /, '')}`, { ausgabe: r.zeilen.slice(-8).join('\n'), protokoll: [kopf, ...r.zeilen] });
    }
    if (vorschau) return { ergebnis: 'ok', meldung: '', zahlen, vorschau: rcloneVorschau(r.zeilen), protokoll: [kopf] };
    // Papierkorb: Stempel-Ordner älter als 30 Tage löschen
    const protokoll = [kopf, ...r.zeilen];
    try {
      if (korb) {
        await korbAbschliessen(korb, auftrag, jetzt, { system: w.system, extern: lokal.extern });
        await korbAufraeumen(lokal, auftrag, jetzt, protokoll);
      } else if (nachCloud) {
        const l = await rclone(w, konf, ['lsf', '--dirs-only', `${fern}/${PAPIERKORB}`], { erlaubteCodes: [0, 3] });
        for (const n of papierkorbAlt(String(l.stdout).split('\n').map((x) => x.replace(/\/$/, '').trim()).filter(Boolean), jetzt, auftrag.versionen_tage || 30)) {
          await rclone(w, konf, ['purge', `${fern}/${PAPIERKORB}/${n}`], { zeitlimit_ms: 600_000 }); protokoll.push(`Papierkorb: ${n} gelöscht (älter als ${auftrag.versionen_tage || 30} Tage)`);
        }
      } else {
        const ordner = path.join(ziel, PAPIERKORB);
        for (const n of papierkorbAlt(await fs.readdir(ordner).catch(() => []), jetzt, auftrag.versionen_tage || 30)) { await fs.rm(path.join(ordner, n), { recursive: true, force: true }); protokoll.push(`Papierkorb: ${n} gelöscht (älter als 30 Tage)`); }
      }
    } catch { /* Aufräumen ist nicht kritisch */ }
    return { ergebnis: 'ok', meldung: '', zahlen, protokoll };
  });
}
