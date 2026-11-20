// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung – reine Regeln ohne Systemzugriff: Aufträge prüfen und normalisieren, Planzeitpunkte rechnen, Befehlszeilen
// für rsync (einseitig) und unison (beidseitig) bauen, Ausgaben auswerten, alte Papierkorb-Ordner finden.
// Entwurf: docs/superpowers/specs/2026-10-11-spiegelung-design.md

import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const RICHTUNGEN = Object.freeze(['einseitig', 'beidseitig']);
/** Art (Betreiber 09.11.2026: „besser sehen, was eine Spiegelung und was eine Sicherung ist“). Sicherung = nur einseitig. */
export const ARTEN = Object.freeze(['sicherung', 'spiegelung']);
export const AUSLOESER = Object.freeze(['zeitplan', 'aenderung', 'hand']);
export const PAPIERKORB = '.fah-papierkorb';
export const PAPIERKORB_TAGE = 30;
/** Wie lange ältere Stände (Papierkorb je Lauf) bleiben – Betreiber 12.10.2026: „Sicherung mit Versionen“. */
export const VERSIONEN_TAGE = Object.freeze([7, 30, 90, 365]);
/** Dateisysteme ohne Hardlinks/Besitzer/Verknüpfungen (findmnt-FSTYPE) – dort ohne -a abgleichen. */
export const EINFACHE_FS = Object.freeze(new Set(['exfat', 'vfat', 'msdos', 'fat', 'ntfs', 'ntfs3', 'fuseblk', 'cifs', 'smb3']));
/** Dateisysteme, die keine Zeiten vor 1980 speichern können – solche Dateien sähen sonst bei jedem Lauf geändert aus. */
export const FAT_FS = Object.freeze(new Set(['exfat', 'vfat', 'msdos', 'fat']));
export const MAX_AUFTRAEGE = 50;
export const NACHHOLEN_MS = 24 * 3_600_000;   // verpasste Planzeitpunkte höchstens so alt nachholen

const FREIGABE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ZUGANG_ID = /^z-[a-f0-9]{10}$/;
/** Freigabename auf einem anderen NAS (SMB): Leerzeichen und Großbuchstaben erlaubt, keine Pfadzeichen. */
// Ohne Komma: mount.cifs gibt die Freigabe als unc= in den Kernel-Optionsstring weiter (Prüfbericht 09.11.2026)
const FREIGABE_FERN = /^[^/\\\u0000-\u001f\u007f:*?"<>|,]{1,80}$/;
/** Freigabename auf einem anderen NAS oder in der Cloud prüfen (Ordnerwahl, Ordner anlegen). */
export function freigabeFernNormal(roh, feld = 'freigabe') {
  if (typeof roh !== 'string' || !FREIGABE_FERN.test(roh)) throw fehler('Diese Freigabe lässt sich nicht verwenden', feld);
  return roh;
}
const ADRESSE = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:]{2,45}\]?$/;
const ZEIT = /^([01]\d|2[0-3]):([0-5]\d)$/;
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;
const STEMPEL = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/;

function fehler(text, feld) { return new FahnasFehler('E_PARAMS', text, { feld }); }

/** Unterordner relativ zur Freigabe: ohne führende/abschließende „/“, kein „..“/„.“, keine Steuerzeichen. '' = Wurzel. */
export function relPfad(roh, feld = 'pfad') {
  if (roh === undefined || roh === null) return '';
  if (typeof roh !== 'string') throw fehler('Ordner muss ein Text sein', feld);
  if (roh.length > 1024) throw fehler('Ordnerpfad ist zu lang', feld);
  if (STEUERZEICHEN.test(roh) || roh.includes('\\')) throw fehler('Ordnerpfad enthält unerlaubte Zeichen', feld);
  const teile = roh.split('/').map((t) => t.trim()).filter(Boolean);
  if (teile.some((t) => t === '..' || t === '.')) throw fehler('„..“ und „.“ sind im Ordnerpfad nicht erlaubt', feld);
  return teile.join('/');
}

/**
 * Name eines neuen Ordners (Ordnerwahl, Betreiber 09.11.2026). Streng genug für SMB, exFAT/NTFS und Cloud-Speicher:
 * keine Pfadtrenner, keine unter Windows verbotenen Zeichen, kein „.“/„..“, kein Punkt vorn (versteckt) oder hinten.
 */
export function ordnerNameNormal(roh, feld = 'name') {
  const name = typeof roh === 'string' ? roh.trim() : '';
  if (!name) throw fehler('Bitte einen Ordnernamen eingeben', feld);
  if (Buffer.byteLength(name) > 255) throw fehler('Ordnername ist zu lang', feld);
  if (STEUERZEICHEN.test(name) || /[/\\:*?"<>|]/.test(name)) throw fehler('Ordnername darf diese Zeichen nicht enthalten: / \\ : * ? " < > |', feld);
  if (name.startsWith('.') || name.endsWith('.')) throw fehler('Ordnername darf nicht mit einem Punkt beginnen oder enden', feld);
  if (/^[@#]/.test(name)) throw fehler('Ordnername darf nicht mit @ oder # beginnen (solche Ordner blendet die Ordnerwahl aus)', feld);
  return name;
}

/** Seite (Quelle/Ziel) {zugang?, freigabe, pfad} prüfen. Mit `zugang` liegt sie auf einem anderen NAS (SMB). */
export function seiteNormal(roh, feld) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw fehler(`${feld}: Freigabe und Ordner fehlen`, feld);
  const zugang = typeof roh.zugang === 'string' && roh.zugang ? roh.zugang : null;
  if (zugang && !ZUGANG_ID.test(zugang)) throw fehler(`${feld}: unbekannte Verbindung`, `${feld}.zugang`);
  const freigabe = typeof roh.freigabe === 'string' ? roh.freigabe.trim() : '';
  if (!(zugang ? FREIGABE_FERN : FREIGABE).test(freigabe)) throw fehler(`${feld}: bitte eine Freigabe wählen`, `${feld}.freigabe`);
  const aus = { freigabe, pfad: relPfad(roh.pfad, `${feld}.pfad`) };
  return zugang ? { zugang, ...aus } : aus;
}

/** Liegen zwei Seiten ineinander (oder sind gleich)? Dann würde sich der Abgleich selbst kopieren. */
export function verschachtelt(a, b) {
  if ((a.zugang || '') !== (b.zugang || '')) return false;
  if (a.freigabe !== b.freigabe) return false;
  if (a.pfad === b.pfad || a.pfad === '' || b.pfad === '') return true;
  return a.pfad.startsWith(b.pfad + '/') || b.pfad.startsWith(a.pfad + '/');
}

/** Uhrzeiten „HH:MM“: gültig, eindeutig, sortiert. */
export function zeitenNormal(roh) {
  const liste = Array.isArray(roh) ? roh : [];
  if (liste.length > 24) throw fehler('Höchstens 24 Uhrzeiten', 'zeiten');
  const aus = new Set();
  for (const z of liste) {
    const t = typeof z === 'string' ? z.trim().replace(/^(\d):/, '0$1:') : '';
    if (!ZEIT.test(t)) throw fehler(`Uhrzeit „${z}“ ist ungültig (Form 05:30)`, 'zeiten');
    aus.add(t);
  }
  return [...aus].sort();
}

/** Wochentage 0 (So) – 6 (Sa): eindeutig, sortiert ab Montag. */
export function tageNormal(roh) {
  const liste = Array.isArray(roh) ? roh : [];
  const aus = new Set();
  for (const t of liste) {
    if (!Number.isInteger(t) || t < 0 || t > 6) throw fehler(`Wochentag „${t}“ ist ungültig`, 'tage');
    aus.add(t);
  }
  return [...aus].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
}

/**
 * Art eines gespeicherten Auftrags. Vor 0.29.0 gab es das Feld nicht: Sicherungen kamen nur aus dem Assistenten
 * (einseitig, Ziel „FAH-NAS/<Quelle>“), alles andere war über „Neue Spiegelung“ angelegt (Betreiber 09.11.2026).
 */
export function artVon(a) {
  if (a && ARTEN.includes(a.art)) return a.art;
  const p = (a && a.ziel && typeof a.ziel.pfad === 'string') ? a.ziel.pfad : '';
  return a && a.richtung !== 'beidseitig' && (p === 'FAH-NAS' || p.startsWith('FAH-NAS/')) ? 'sicherung' : 'spiegelung';
}

/**
 * Auftrag aus der Eingabe prüfen und normalisieren. `vorher` = gespeicherter Stand (erstellt bleibt).
 * @returns {object} gespeicherte Form (ohne Laufzustand)
 */
export function auftragNormal(e, { id, jetzt = new Date(), vorher = null } = {}) {
  if (!e || typeof e !== 'object') throw fehler('Angaben fehlen', 'name');
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name) throw fehler('Bitte einen Namen eingeben', 'name');
  if (name.length > 60 || STEUERZEICHEN.test(name)) throw fehler('Name: höchstens 60 Zeichen, keine Steuerzeichen', 'name');
  const quelle = seiteNormal(e.quelle, 'quelle');
  const ziel = seiteNormal(e.ziel, 'ziel');
  if (verschachtelt(quelle, ziel)) throw fehler('Quelle und Ziel dürfen nicht gleich sein oder ineinander liegen', 'ziel');
  const richtung = RICHTUNGEN.includes(e.richtung) ? e.richtung : null;
  if (!richtung) throw fehler('Richtung: einseitig oder beidseitig', 'richtung');
  const art = e.art ?? vorher?.art ?? artVon({ richtung, ziel });
  if (!ARTEN.includes(art)) throw fehler('Art: Sicherung oder Spiegelung', 'art');
  if (art === 'sicherung' && richtung !== 'einseitig') throw fehler('Eine Sicherung kopiert nur in eine Richtung – für beidseitig bitte „Spiegelung“ wählen', 'richtung');
  const ausloeser = AUSLOESER.includes(e.ausloeser) ? e.ausloeser : null;
  if (!ausloeser) throw fehler('Auslöser: Zeitplan, bei Änderungen oder nur von Hand', 'ausloeser');
  const tage = tageNormal(e.tage);
  const zeiten = zeitenNormal(e.zeiten);
  if (ausloeser === 'zeitplan' && !tage.length) throw fehler('Bitte mindestens einen Wochentag wählen', 'tage');
  if (ausloeser === 'zeitplan' && !zeiten.length) throw fehler('Bitte mindestens eine Uhrzeit eingeben', 'zeiten');
  // „Bei Änderungen“ sieht nur Ordner auf diesem NAS (inotify) – Änderungen auf einem anderen NAS bemerkt erst der nächste Lauf
  if (ausloeser === 'aenderung' && quelle.zugang && (richtung === 'einseitig' || ziel.zugang)) {
    throw fehler(richtung === 'einseitig'
      ? '„Bei Änderungen“ geht nur, wenn die Quelle auf diesem NAS liegt – für ein anderes NAS als Quelle bitte den Zeitplan nehmen'
      : '„Bei Änderungen“ braucht mindestens eine Seite auf diesem NAS – bitte den Zeitplan nehmen', 'ausloeser');
  }
  if (ausloeser === 'aenderung' && richtung === 'beidseitig' && ziel.zugang && quelle.zugang) throw fehler('„Bei Änderungen“ braucht mindestens eine Seite auf diesem NAS', 'ausloeser');
  const w = e.wartezeit_min === undefined || e.wartezeit_min === null ? 2 : e.wartezeit_min;
  if (!Number.isInteger(w) || w < 1 || w > 1440) throw fehler('Wartezeit: 1 bis 1440 Minuten', 'wartezeit_min');
  const v = e.versionen_tage ?? vorher?.versionen_tage ?? PAPIERKORB_TAGE; // Bearbeiten ohne Feld behält die Aufbewahrung
  if (!VERSIONEN_TAGE.includes(v)) throw fehler(`Ältere Stände: ${VERSIONEN_TAGE.join(', ')} Tage`, 'versionen_tage');
  const zeit = jetzt.toISOString();
  return {
    id, name, art, aktiv: e.aktiv !== false, quelle, ziel, richtung, ausloeser,
    tage, zeiten, wartezeit_min: w, versionen_tage: v,
    erstellt: vorher?.erstellt || zeit, geaendert: zeit,
  };
}

function zeitpunktAm(tag, zeit) {
  const [h, m] = zeit.split(':').map(Number);
  const d = new Date(tag); d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Fälliger Planzeitpunkt: der jüngste Zeitpunkt ≤ jetzt (höchstens NACHHOLEN_MS alt), der jünger ist als `bedientBis`.
 * @returns {number|null} Zeitstempel in ms
 */
export function faelligerZeitpunkt(a, jetzt, bedientBis) {
  if (!a || a.ausloeser !== 'zeitplan' || !a.tage?.length || !a.zeiten?.length) return null;
  const jetztMs = jetzt.getTime();
  let bester = null;
  for (let d = 0; d <= 1; d++) {
    const tag = new Date(jetztMs); tag.setDate(tag.getDate() - d);
    if (!a.tage.includes(tag.getDay())) continue;
    for (const z of a.zeiten) {
      const t = zeitpunktAm(tag, z).getTime();
      if (t > jetztMs || jetztMs - t > NACHHOLEN_MS) continue;
      if (bedientBis !== null && bedientBis !== undefined && t <= bedientBis) continue;
      if (bester === null || t > bester) bester = t;
    }
  }
  return bester;
}

/** Nächster Planzeitpunkt nach `jetzt` (innerhalb von 8 Tagen) oder null. */
export function naechsterZeitpunkt(a, jetzt) {
  if (!a || a.ausloeser !== 'zeitplan' || !a.tage?.length || !a.zeiten?.length) return null;
  for (let d = 0; d <= 8; d++) {
    const tag = new Date(jetzt.getTime()); tag.setDate(tag.getDate() + d);
    if (!a.tage.includes(tag.getDay())) continue;
    for (const z of a.zeiten) {
      const t = zeitpunktAm(tag, z).getTime();
      if (t > jetzt.getTime()) return t;
    }
  }
  return null;
}

/** Ortszeit-Stempel für Papierkorb-Ordner: 2026-10-11_053000. */
export function stempel(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

/** Papierkorb-Ordnernamen, die älter als `tage` sind (nur Namen im Stempel-Format). */
export function papierkorbAlt(namen, jetzt = new Date(), tage = PAPIERKORB_TAGE) {
  const grenze = jetzt.getTime() - tage * 86_400_000;
  return namen.filter((n) => {
    const m = STEMPEL.exec(n);
    if (!m) return false;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    return Number.isFinite(t) && t < grenze;
  });
}

/** Ausschlüsse an der Wurzel des Abgleichs: unser Papierkorb und der btrfs-Papierkorb der Freigabe. */
export const AUSSCHLUESSE = Object.freeze([`/${PAPIERKORB}/`, '/.papierkorb/']);

/** rsync-Ausnahme für genau diese Datei (Pfad ab Quelle). Platzhalter im Namen werden entschärft. */
export function ausnahmeMuster(rel) { return `/${rel.replace(/[\\[\]*?]/g, '\\$&')}`; }

/**
 * rsync-Argumente (einseitig). `einfach` = Ziel auf exFAT/FAT/NTFS: ohne Besitzer/Rechte/Verknüpfungen, Zeitvergleich mit
 * 2 s Toleranz (FAT speichert nur gerade Sekunden). Sonst -aH, damit Hardlink-Stände (FAH-Sicherung) Hardlinks bleiben.
 */
export function rsyncArgumente({ quelle, ziel, einfach, vorschau, papierkorbOrdner, ausnahmenDatei = null }) {
  const a = einfach ? ['-rt', '--modify-window=2'] : ['-aH', '--numeric-ids'];
  a.push('--delete', '--backup', `--backup-dir=${papierkorbOrdner}`);
  for (const x of AUSSCHLUESSE) a.push(`--exclude=${x}`);
  if (ausnahmenDatei) a.push(`--exclude-from=${ausnahmenDatei}`);
  a.push('--stats');
  if (vorschau) a.push('--dry-run', '--itemize-changes');
  else a.push('--info=progress2', '--no-inc-recursive');
  a.push(quelle.replace(/\/+$/, '') + '/', ziel.replace(/\/+$/, '') + '/');
  return a;
}

/**
 * unison-Argumente (beidseitig): ohne Rückfragen, bei Konflikt gewinnt die neuere Fassung und die andere bleibt als
 * „… (conflict_on_<datum>)“ daneben; Gelöschtes/Überschriebenes kommt in den Papierkorb-Ordner (muss existieren).
 */
export function unisonArgumente({ a, b, fat, papierkorbOrdner }) {
  return [
    a, b, '-batch', '-auto', '-prefer', 'newer', '-copyonconflict', '-times', '-perms', '0', ...(fat ? ['-fat'] : []),
    '-ignore', `Name ${PAPIERKORB}`, '-ignore', 'Path .papierkorb',
    '-backup', 'Name *', '-backuploc', 'central', '-backupdir', papierkorbOrdner,
    '-ignorelocks', '-log=false', '-ui', 'text',
  ];
}

function zahl(text, muster) {
  const m = muster.exec(text);
  return m ? Number(m[1].replace(/[,.\s]/g, '')) : 0;
}

/** rsync --stats auswerten. */
export function rsyncStatistik(text) {
  const t = String(text || '');
  return {
    dateien: zahl(t, /Number of files:\s*([\d,.]+)/),
    neu: zahl(t, /Number of created files:\s*([\d,.]+)/),
    geloescht: zahl(t, /Number of deleted files:\s*([\d,.]+)/),
    uebertragen: zahl(t, /Number of regular files transferred:\s*([\d,.]+)/),
    bytes_gesamt: zahl(t, /Total file size:\s*([\d,.]+)/),
    bytes_uebertragen: zahl(t, /Total transferred file size:\s*([\d,.]+)/),
  };
}

/** Fortschritt aus einer rsync-progress2-Zeile („ 1,234,567  45%  12.34MB/s  0:00:10 (xfr#3, to-chk=0/10)“) → 0–1 oder null. */
export function rsyncFortschritt(zeile) {
  const m = /\s(\d{1,3})%\s/.exec(` ${zeile} `);
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 0 && p <= 100 ? p / 100 : null;
}

/** unison-Abschlusszeile auswerten. */
export function unisonStatistik(text) {
  const t = String(text || '');
  const m = /\((\d+) items? transferred, (\d+) skipped, (\d+) failed\)/.exec(t);
  if (m) return { uebertragen: Number(m[1]), uebersprungen: Number(m[2]), fehlgeschlagen: Number(m[3]) };
  return { uebertragen: 0, uebersprungen: 0, fehlgeschlagen: 0 };
}

/** --itemize-changes einer Vorschau zusammenfassen: neue, geänderte, gelöschte Dateien + die ersten Zeilen. */
export function vorschauZusammenfassen(zeilen, max = 300) {
  const aus = { neu: 0, geaendert: 0, geloescht: 0, ordner_neu: 0, zeilen: [] };
  for (const z of zeilen) {
    if (z.startsWith('*deleting ')) { aus.geloescht++; aus.zeilen.length < max && aus.zeilen.push(`− ${z.slice(10).trim()}`); continue; }
    const m = /^([<>ch.*][fdLDS])([^ ]{9,10}) (.+)$/.exec(z);
    if (!m) continue;
    const [, art, flags, name] = m;
    if (art[1] === 'd') { if (flags.startsWith('+')) aus.ordner_neu++; continue; }
    if (flags.startsWith('+')) { aus.neu++; aus.zeilen.length < max && aus.zeilen.push(`+ ${name}`); }
    else { aus.geaendert++; aus.zeilen.length < max && aus.zeilen.push(`~ ${name}`); }
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Andere NAS (SMB)
// ---------------------------------------------------------------------------------------------------------------------

/** Verbindung prüfen/normalisieren. `vorher` = gespeicherter Stand (Passwort bleibt, wenn leer gelassen). */
export function zugangNormal(e, { id, jetzt = new Date(), vorher = null } = {}) {
  if (!e || typeof e !== 'object') throw fehler('Angaben fehlen', 'name');
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name || name.length > 40 || STEUERZEICHEN.test(name)) throw fehler('Name: 1–40 Zeichen, keine Steuerzeichen', 'name');
  // „\\192.168.1.23\“, „smb://nas/“ und „192.168.1.23“ meinen dasselbe
  const adresse = typeof e.adresse === 'string' ? e.adresse.trim().replace(/^smb:\/\//i, '').replace(/^[\\/]+|[\\/]+$/g, '') : '';
  if (!ADRESSE.test(adresse)) throw fehler('Adresse: IP-Adresse oder Rechnername, z. B. 192.168.1.23', 'adresse');
  const benutzer = typeof e.benutzer === 'string' ? e.benutzer.trim() : '';
  if (!benutzer || benutzer.length > 64 || /[\s\u0000-\u001f\u007f\\/:@]/.test(benutzer.replace(/^[^\\]+\\/, ''))) throw fehler('Benutzer: Name des Kontos auf dem anderen NAS', 'benutzer');
  let passwort = typeof e.passwort === 'string' ? e.passwort : '';
  if (!passwort && vorher) passwort = vorher.passwort;
  if (!passwort) throw fehler('Bitte das Passwort eingeben', 'passwort');
  if (passwort.length > 256 || /[\n\r\u0000]/.test(passwort)) throw fehler('Passwort: höchstens 256 Zeichen, keine Zeilenumbrüche', 'passwort');
  const zeit = jetzt.toISOString();
  return { id, name, adresse, benutzer, passwort, erstellt: vorher?.erstellt || zeit, geaendert: zeit };
}

/** Ansicht einer Verbindung für die Oberfläche – ohne Passwort. */
export function zugangAnsicht(z, benutzt = 0) {
  const aus = { id: z.id, name: z.name, art: z.art === 'cloud' ? 'cloud' : 'smb', adresse: z.adresse, benutzer: z.benutzer, passwort_gesetzt: !!(z.passwort || z.schluessel), benutzt };
  if (z.art === 'cloud') for (const k of ['anbieter', 'endpunkt', 'region', 'hersteller', 'port', 'schluessel_id']) if (z[k] !== undefined) aus[k] = z[k];
  return aus;
}

/** Inhalt der Zugangsdatei für mount.cifs/smbclient (credentials= bzw. -A). „DOMÄNE\\benutzer“ wird aufgeteilt. */
export function zugangsdatei(z) {
  const m = /^([^\\]+)\\(.+)$/.exec(z.benutzer);
  return `username=${m ? m[2] : z.benutzer}\npassword=${z.passwort}\n${m ? `domain=${m[1]}\n` : ''}`;
}

/**
 * mount-Argumente für eine Freigabe auf einem anderen NAS. closetimeo=0: Der Kernel schließt Dateien sonst verzögert, das
 * überschreibt die von rsync gesetzte Zeit. Jede Datei sähe beim nächsten Lauf geändert aus, und alles liefe durch den Papierkorb.
 */
export function mountArgumente({ adresse, freigabe, ziel, zugangsdatei: datei, nurLesen = false }) {
  const optionen = [`credentials=${datei}`, 'uid=0', 'gid=0', 'file_mode=0660', 'dir_mode=0770', 'iocharset=utf8', 'soft', 'nobrl', 'closetimeo=0'];
  if (nurLesen) optionen.push('ro');
  return ['-t', 'cifs', `//${adresse}/${freigabe}`, ziel, '-o', optionen.join(',')];
}

/** Fehlermeldung von mount.cifs deuten: erreichbar? Anmeldung? Freigabe? → {art, text}. */
export function mountFehlerDeuten(text) {
  const t = String(text || '');
  const code = Number((/mount error\((\d+)\)/.exec(t) || [])[1]);
  if ([111, 112, 113, 115, 101, 110].includes(code) || /Host is down|No route|timed out|Connection refused|could not resolve/i.test(t)) return { art: 'nicht_erreichbar', text: 'nicht erreichbar' };
  if (code === 13 || /Permission denied|LOGON_FAILURE/i.test(t)) return { art: 'anmeldung', text: 'Anmeldung abgelehnt – Benutzer oder Passwort falsch' };
  if (code === 2 || /No such file|BAD_NETWORK_NAME/i.test(t)) return { art: 'freigabe', text: 'Freigabe gibt es dort nicht' };
  return { art: 'sonst', text: (t.trim().split('\n').pop() || 'Einhängen fehlgeschlagen').slice(0, 200) };
}

/** Freigaben aus `smbclient -L -g` (Zeilen „Disk|Name|Kommentar“) – ohne versteckte $-Freigaben. */
export function smbFreigabenParsen(text) {
  const aus = [];
  for (const z of String(text || '').split('\n')) {
    const teile = z.split('|');
    if (teile[0] !== 'Disk' || !teile[1] || teile[1].endsWith('$') || !FREIGABE_FERN.test(teile[1])) continue;
    aus.push({ name: teile[1], kommentar: (teile[2] || '').trim() });
  }
  return aus.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
