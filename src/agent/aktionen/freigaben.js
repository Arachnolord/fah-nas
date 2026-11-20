// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „freigaben.*“: shares.json ist die Wahrheit; daraus werden btrfs-Unterlaufwerke, Rechte (2770 +
// ACLs), Kontingente (qgroup), Papierkorb-Ordner sowie die Samba-Includes und die Avahi-Ankündigung gerendert.
// freigaben.apply (Rolle system) rendert idempotent alles – es fragt erst (getfacl, qgroup show) und setzt nur,
// was abweicht. Jede Freigabe in der Liste nennt ihren Speicherort (Datenplatte mit Gerät und Modell, externes Laufwerk,
// Speicherverbund).

import fs from 'node:fs/promises';
import path from 'node:path';
import { R } from '../../gemeinsam/schema.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import * as samba from '../render/samba.js';
import { GRUPPE_NUTZER, GRUPPE_ADMIN } from '../render/linuxnutzer.js';
import { dockerAnsicht } from './dateien.js';
import * as krypt from '../freigaben/krypt.js';
import { nasNetz } from '../helfer/netzadressen.js';
import { lsblkRoh, findmntText } from './laufwerke.js';
import { MD_PFAD } from '../raid/regeln.js';
import { relativerPfad, sicherAufloesen } from '../../gemeinsam/pfade.js';
import * as ordnerrechte from '../freigaben/ordnerrechte.js';
import { bereichAbgleichen } from '../freigaben/ordnerrechte-abgleich.js';
import { freigabeLoesen } from '../import/einhaengen.js';

const DATEI = 'shares.json';
const NUTZER_DATEI = 'users.json';
const PAPIERKORB = '.papierkorb';
// Namen, die Samba selbst belegt oder die mit unseren Dateien kollidieren würden
const RESERVIERT = new Set(['global', 'homes', 'printers', 'print$', 'ipc$', 'alle', 'docker']); // docker = System-Freigabe des App-Ordners
const GB = 1024 ** 3;
/** Belegung ohne Kontingent: du-Ergebnis so lange zwischenspeichern; danach im Hintergrund erneuern. */
export const BELEGUNG_FRISCH_MS = 5 * 60 * 1000;
const BELEGUNG_ZEITLIMIT_MS = 10 * 60 * 1000;

const S = Object.freeze({
  beschreibung: { typ: 'string', max: 200, muster: samba.MUSTER_WERT, hinweis: 'Beschreibung darf keine Zeilenumbrüche oder Anführungszeichen enthalten' },
  groesse_gb: { typ: 'integer', min: 0, max: 1_000_000 },
  daten: { typ: 'string', pflicht: true, werte: ['behalten', 'loeschen'] },
});

// --- Konfiguration ---------------------------------------------------------

function normieren(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.freigaben)) return { ...(d && typeof d === 'object' ? d : {}), freigaben: [] };
  return d;
}

async function ladenFreigaben(konfig) { return normieren(await konfig.laden(DATEI)); }

/**
 * Lesen-Ändern-Schreiben von shares.json unter der Sperre der Datei (kein Lost Update zwischen zwei Admin-Aktionen
 * oder mit dem Aufräumen beim Nutzer-Löschen). `fn(daten)` verändert `daten.freigaben` in place oder setzt es neu
 * und liefert das Ergebnis der Aktion; wirft fn, wird nichts geschrieben.
 */
async function aendernFreigaben(konfig, fn) {
  let ergebnis;
  await konfig.aendern(DATEI, async (roh) => {
    const daten = normieren(roh);
    ergebnis = await fn(daten);
    return daten;
  });
  return ergebnis;
}

async function ladenNutzer(konfig) {
  const d = await konfig.laden(NUTZER_DATEI);
  return { nutzer: Array.isArray(d?.nutzer) ? d.nutzer : [], gruppen: Array.isArray(d?.gruppen) ? d.gruppen : [] };
}

function finde(daten, name) { return daten.freigaben.find((f) => f.name === name) || null; }

function pfade(werkzeuge) {
  const p = samba.pfadeVon(werkzeuge);
  const w = (werkzeuge && werkzeuge.pfade) || {};
  // `daten` = Wurzel des btrfs-Pools (subvolid=5) für „btrfs quota enable“; PFADE kennt sie nicht → Elternordner der Freigaben
  return { ...p, snapshots: w.snapshots || PFADE.snapshots, backup: w.backup || PFADE.backup, daten: w.daten || path.dirname(p.shares) };
}

function pfadVon(werkzeuge, name) { return path.join(pfade(werkzeuge).shares, name); }

/** Prüft, dass alle Einträge in lesen/schreiben bekannte Nutzer oder @Gruppen sind. */
function kontenPruefen(liste, nutzerdaten, feld) {
  for (const k of liste) {
    if (k.startsWith('@')) {
      if (!nutzerdaten.gruppen.some((g) => g.name === k.slice(1))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Gruppe „${k.slice(1)}“ gibt es nicht`, { feld, wert: k });
    } else if (!nutzerdaten.nutzer.some((n) => n.name === k)) {
      throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${k}“ gibt es nicht`, { feld, wert: k });
    }
  }
  return [...new Set(liste)];
}

function eintragNormieren(f) {
  const aus = { ...f };
  aus.lesen = [...new Set(aus.lesen || [])];
  aus.schreiben = [...new Set(aus.schreiben || [])];
  aus.beschreibung = aus.beschreibung || '';
  aus.gaeste = !!aus.gaeste; aus.versteckt = !!aus.versteckt;
  aus.extern = !!aus.extern; // externes Laufwerk (§12): kein Unterlaufwerk, keine ACL/Quota/Schnappschüsse
  aus.verbund = !aus.extern && !!aus.verbund; // RAID-Verbund (12.10.2026): eigenes btrfs am Einhängepunkt, Rechte per ACL, ohne Kontingent
  // verschlüsselt (12.10.2026, gocryptfs): Einhängepunkt zeigt die entschlüsselten Daten, gesperrt leer; ohne Kontingent/Schnappschüsse
  aus.verschluesselt = !aus.extern && !aus.verbund && !!aus.verschluesselt;
  // übernommen (19.10.2026, Umstieg von UGOS & Co.): Ordner eines fremden Volumes, per Bind-Mount am Einhängepunkt
  const imp = !aus.extern && !aus.verbund && !aus.verschluesselt && aus.importiert && typeof aus.importiert === 'object' ? aus.importiert : null;
  if (imp && typeof imp.volume === 'string' && typeof imp.ordner === 'string') {
    aus.importiert = { volume: imp.volume, ordner: imp.ordner, schnappschuesse: !!imp.schnappschuesse, ...(imp.herkunft ? { herkunft: String(imp.herkunft) } : {}), ...(imp.rechte_lassen ? { rechte_lassen: true } : {}) };
  } else delete aus.importiert;
  delete aus.passwort; delete aus.merken;
  // externe Laufwerke haben kein Time Machine/Quota – die Rechte kommen aus den Einhängeoptionen; ihr Papierkorb gilt für das ganze Laufwerk
  aus.timemachine = aus.extern ? false : !!aus.timemachine;
  aus.papierkorb = samba.hatPapierkorb(aus); // Time Machine räumt selbst auf – ein Papierkorb würde die Platte füllen
  aus.groesse_gb = (!aus.extern && !aus.verbund && !aus.verschluesselt && !aus.importiert && Number.isInteger(aus.groesse_gb) && aus.groesse_gb > 0) ? aus.groesse_gb : null;
  if (!aus.verbund) delete aus.verbund;
  if (!aus.verschluesselt) delete aus.verschluesselt;
  // Ordnerrechte (19.10.2026): nur wo die Platte Dateirechte kennt – nicht auf externen Laufwerken
  const regeln = aus.extern ? [] : ordnerrechte.regelnNormieren(aus.ordnerrechte);
  if (regeln.length) aus.ordnerrechte = regeln; else delete aus.ordnerrechte;
  return aus;
}

// --- Rechte (chown/chmod/ACL) ----------------------------------------------

function rechteText(schreibend) { return schreibend ? 'rwx' : 'r-x'; }

/**
 * Soll-ACL als Zeilen für setfacl --set-file (Zugriff + default). Unbekannte Konten werden ausgelassen.
 * Die Gruppe fahnas-admin bekommt immer rwx: der Dateihelfer läuft mit der uid des Admins – „admin darf alles“
 * gilt sonst nur im Agenten, nicht auf der Platte (E_RECHTE im Dateimanager für Admins ohne eigenen Eintrag).
 */
export function aclZeilen(f, nutzerdaten) {
  const nutzer = new Set(nutzerdaten.nutzer.map((n) => n.name));
  const gruppen = new Set(nutzerdaten.gruppen.map((g) => g.name));
  const rechte = new Map(); // "user:name" | "group:name" → rwx/r-x
  for (const k of f.lesen || []) rechte.set(k.startsWith('@') ? `group:${k.slice(1)}` : `user:${k}`, 'r-x');
  for (const k of f.schreiben || []) rechte.set(k.startsWith('@') ? `group:${k.slice(1)}` : `user:${k}`, 'rwx');
  if (f.gaeste) rechte.set(`user:${samba.GASTKONTO}`, 'rwx');
  const zugriff = ['user::rwx', 'group::---', 'other::---', 'mask::rwx', `group:${GRUPPE_ADMIN}:rwx`];
  for (const [schluessel, r] of [...rechte.entries()].sort()) {
    const [art, name] = schluessel.split(':');
    if (art === 'user' && name !== samba.GASTKONTO && !nutzer.has(name)) continue;
    if (art === 'group' && name !== GRUPPE_ADMIN && !gruppen.has(name)) continue;
    if (schluessel === `group:${GRUPPE_ADMIN}`) continue; // steht schon fest drin
    zugriff.push(`${schluessel}:${r}`);
  }
  return [...zugriff, ...zugriff.map((z) => `default:${z}`)];
}

/** Liest Besitzer, Gruppe, Sonderbits und ACL-Einträge (getfacl -p). */
export async function aclLesen(system, pfad) {
  const r = await system.ausfuehren('getfacl', ['-p', pfad], { erlaubteCodes: [0, 1] });
  if (r.code !== 0) return null;
  const aus = { besitzer: '', gruppe: '', flags: '---', eintraege: [] };
  for (const roh of r.stdout.split('\n')) {
    const zeile = roh.trim();
    if (!zeile) continue;
    let m;
    if ((m = /^# owner:\s*(\S+)/.exec(zeile))) aus.besitzer = m[1];
    else if ((m = /^# group:\s*(\S+)/.exec(zeile))) aus.gruppe = m[1];
    else if ((m = /^# flags:\s*(\S+)/.exec(zeile))) aus.flags = m[1];
    else if (!zeile.startsWith('#')) aus.eintraege.push(zeile.replace(/\s*#effective:.*$/, ''));
  }
  return aus;
}

/** Setzt Besitzer, 2770 und ACL – aber nur, wenn der Bestand abweicht. Gibt true zurück, wenn geschrieben wurde. */
export async function rechteAngleichen(werkzeuge, f, nutzerdaten) {
  const { system } = werkzeuge;
  const pfad = pfadVon(werkzeuge, f.name);
  const soll = aclZeilen(f, nutzerdaten);
  const ist = await aclLesen(system, pfad);
  const gleich = ist && ist.besitzer === 'root' && ist.gruppe === GRUPPE_NUTZER && ist.flags[1] === 's'
    && [...ist.eintraege].sort().join('\n') === [...soll].sort().join('\n');
  if (gleich) return false;
  await system.ausfuehren('chown', [`root:${GRUPPE_NUTZER}`, pfad]);
  await system.ausfuehren('chmod', ['2770', pfad]);
  await system.ausfuehren('setfacl', ['--set-file=-', pfad], { eingabe: soll.join('\n') + '\n' });
  return true;
}

// --- Ordnerrechte (19.10.2026) ---------------------------------------------

/**
 * Soll-Geber für die Bereiche einer Freigabe: rel → {ordner, datei, dateiX, eingeschraenktUids}. Maßgeblich ist der tiefste
 * Regelpfad über rel (er umfasst alle Regeln darüber); ohne Regel gelten die Rechte der Freigabe (Zurücksetzen).
 */
export function ordnerrechteSoll(f, nutzerdaten) {
  const basis = aclZeilen(f, nutzerdaten).filter((z) => !z.startsWith('default:'));
  const regeln = ordnerrechte.regelnNormieren(f.ordnerrechte);
  const uids = new Map(nutzerdaten.nutzer.filter((n) => Number.isInteger(Number(n.uid)) && n.uid !== null).map((n) => [n.name, Number(n.uid)]));
  const vorrat = new Map();
  return (rel) => {
    let schluessel = '';
    for (const r of regeln) if (ordnerrechte.unter(rel, r.pfad) && r.pfad.length > schluessel.length) schluessel = r.pfad;
    if (!vorrat.has(schluessel)) {
      const acl = ordnerrechte.bereichAcl(basis, f, nutzerdaten, schluessel, { gastkonto: samba.GASTKONTO });
      vorrat.set(schluessel, { ...acl, eingeschraenktUids: new Set([...acl.eingeschraenkt].map((n) => uids.get(n)).filter((u) => Number.isInteger(u) && u > 0)) });
    }
    return vorrat.get(schluessel);
  };
}

// Abgleiche laufen nacheinander (Regel speichern, stündlicher Lauf, Nutzeränderung), nie zwei gleichzeitig.
let abgleichKette = Promise.resolve();
let letzterAbgleich = null; // {zeit, gruendlich, geprueft, geaendert, besitz, fehlt:[{freigabe,pfad}], fehler}
function nacheinander(fn) { const lauf = abgleichKette.then(fn, fn); abgleichKette = lauf.catch(() => {}); return lauf; }

/** Pfade, die nicht unter einem anderen der Liste liegen (der gründliche Lauf nimmt verschachtelte Bereiche mit). */
function oberste(pfade) { return pfade.filter((p) => !pfade.some((q) => q !== p && ordnerrechte.unter(p, q))); }

/**
 * Ordnerrechte einer Freigabe auf die Platte bringen. Ohne `gruendlich` nur die Wurzel jedes Bereichs prüfen (weicht sie
 * ab, wird der Bereich ganz abgeglichen); `pfade` = nur diese Bereiche (z. B. nach dem Entfernen einer Regel: dann gelten
 * dort wieder die Rechte darüber). → [{pfad, fehlt, geprueft, geaendert, besitz, gruendlich}]
 */
export async function ordnerrechteAngleichen(werkzeuge, f, nutzerdaten, { gruendlich = false, pfade = null, besitzKarte = null, abgebrochen, fortschritt } = {}) {
  if (f.extern) return [];
  const regeln = ordnerrechte.regelnNormieren(f.ordnerrechte);
  const ziele = pfade ? (pfade.includes('') ? [''] : oberste([...new Set(pfade)])) : (gruendlich ? oberste(regeln.map((r) => r.pfad)) : regeln.map((r) => r.pfad));
  if (!ziele.length) return [];
  const sollFuer = ordnerrechteSoll(f, nutzerdaten);
  const abgleich = werkzeuge.ordnerrechteAbgleich || bereichAbgleichen; // Tests: ohne /proc und root
  return nacheinander(async () => {
    const aus = [];
    for (const start of ziele) {
      const r = await abgleich(werkzeuge.system, { wurzel: pfadVon(werkzeuge, f.name), start, sollFuer, nurWurzel: !gruendlich && !pfade, besitzKarte, abgebrochen, fortschritt });
      aus.push({ pfad: start, ...r });
    }
    return aus;
  });
}

/**
 * Rechte der Freigabe auf ALLE vorhandenen Dateien übertragen (Übernahme aus einem anderen NAS, Rechteänderung an einer
 * übernommenen Freigabe, Knopf „Rechte auf vorhandene Dateien übertragen“). Ordnerrechte bleiben dabei bestehen.
 * `besitzKarte`: Map alte uid → neue uid. Nicht bei externen Laufwerken (keine Dateirechte).
 */
export async function rechteAnwenden(werkzeuge, name, { besitzKarte = null, abgebrochen, fortschritt, erzwingen = false } = {}) {
  const daten = await ladenFreigaben(werkzeuge.konfig);
  const roh = finde(daten, name);
  if (!roh) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${name}“ gibt es nicht`, { feld: 'name' });
  const f = eintragNormieren(roh);
  if (f.extern) throw new FahnasFehler('E_PARAMS', 'Externe Laufwerke kennen keine Dateirechte', { feld: 'name' });
  // App-Daten vom alten NAS (Datenbanken & Co. prüfen ihren Besitzer): Rechte und Besitzer bleiben, außer ausdrücklich gewollt
  if (f.importiert?.rechte_lassen && !erzwingen) throw new FahnasFehler('E_PARAMS', 'In dieser Freigabe bleiben Rechte und Besitzer unverändert (App-Daten vom alten NAS)', { feld: 'name' });
  if ((f.verbund || f.importiert) && !(await samba.eingehaengt(werkzeuge.system, pfadVon(werkzeuge, f.name)))) throw new FahnasFehler('E_BELEGT', 'Die Freigabe ist nicht eingehängt', { feld: 'name' });
  if (f.verschluesselt && !(await krypt.entsperrt(werkzeuge, f.name))) throw new FahnasFehler('E_BELEGT', 'Die Freigabe ist gesperrt', { feld: 'name' });
  const nutzerdaten = await ladenNutzer(werkzeuge.konfig);
  await rechteAngleichen(werkzeuge, f, nutzerdaten);
  const [erg] = await ordnerrechteAngleichen(werkzeuge, f, nutzerdaten, { pfade: [''], besitzKarte, abgebrochen, fortschritt });
  return { name: f.name, geprueft: erg?.geprueft || 0, geaendert: erg?.geaendert || 0, besitz: erg?.besitz || 0 };
}

/**
 * Freigabe für einen übernommenen Ordner anlegen (importe.uebernehmen). Der Ordner muss schon unter /data/shares/<name>
 * eingehängt sein. Prüft Name und Konten wie freigaben.anlegen, rendert Rechte und Samba.
 */
export async function freigabeImportieren(werkzeuge, { name, beschreibung = '', lesen = [], schreiben = [], papierkorb = true, importiert, ordnerrechte: regelListe = [] }) {
  pruefeFreigabenameIntern(name);
  const eintrag = await aendernFreigaben(werkzeuge.konfig, async (daten) => {
    if (finde(daten, name)) throw new FahnasFehler('E_EXISTIERT', `Freigabe „${name}“ gibt es schon`, { feld: 'name', wert: name });
    const nutzerdaten = await ladenNutzer(werkzeuge.konfig);
    const e = eintragNormieren({
      name, beschreibung, gaeste: false, versteckt: false, papierkorb, timemachine: false,
      lesen: kontenPruefen(lesen, nutzerdaten, 'lesen'), schreiben: kontenPruefen(schreiben, nutzerdaten, 'schreiben'),
      importiert, pfad: pfadVon(werkzeuge, name), erstellt: new Date().toISOString(),
      ordnerrechte: importRegeln(regelListe, nutzerdaten),
    });
    const neu = [...daten.freigaben, e];
    await freigabeInsSystem(werkzeuge, e, nutzerdaten);
    await samba.rendern(werkzeuge, neu);
    daten.freigaben = neu;
    return e;
  });
  werkzeuge.konfigGeaendert?.('freigaben');
  return eintrag;
}

/** Ordnerrechte aus der Übernahme (UGOS-Unterordner) prüfen: Pfade relativ, ohne „..“, Konten wie bei setzen. */
function importRegeln(liste, nutzerdaten) {
  if (!Array.isArray(liste) || !liste.length) return undefined;
  if (liste.length > ordnerrechte.MAX_REGELN) throw new FahnasFehler('E_PARAMS', `Höchstens ${ordnerrechte.MAX_REGELN} Ordner mit Rechten je Freigabe`, { feld: 'ordnerrechte' });
  return liste.map((r) => {
    const rel = String(r?.pfad || '').replace(/^\/+|\/+$/g, '');
    if (!rel || rel.split('/').some((t) => !t || t === '.' || t === '..') || rel.includes('\0')) throw new FahnasFehler('E_PARAMS', `Ordnerpfad „${r?.pfad}“ ungültig`, { feld: 'ordnerrechte' });
    return { pfad: rel, regeln: ordnerrechte.regelnPruefen(r.regeln, nutzerdaten) };
  });
}

function pruefeFreigabenameIntern(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new FahnasFehler('E_PARAMS', `Freigabename „${name}“ ungültig (klein, 1–32 Zeichen aus a-z, 0-9, - und _)`, { feld: 'name', wert: name });
  if (RESERVIERT.has(name)) throw new FahnasFehler('E_PARAMS', `„${name}“ ist ein reservierter Name`, { feld: 'name', wert: name });
}

function abgleichMerken(ergebnisse, gruendlich, fehler = null) {
  const summe = (k) => ergebnisse.reduce((s, e) => s + (Number(e[k]) || 0), 0);
  letzterAbgleich = {
    zeit: new Date().toISOString(), gruendlich, geprueft: summe('geprueft'), geaendert: summe('geaendert'), besitz: summe('besitz'),
    fehlt: ergebnisse.filter((e) => e.fehlt).map((e) => ({ freigabe: e.freigabe, pfad: e.pfad })), fehler,
  };
}

// --- Kontingent (btrfs qgroup) ---------------------------------------------

/** Liest Belegung und Grenze des Unterlaufwerks: {aktiv, belegt, limit} (Bytes; limit null = unbegrenzt). */
export async function kontingentZeigen(system, pfad) {
  const r = await system.ausfuehren('btrfs', ['qgroup', 'show', '-r', '-f', '--raw', pfad], { erlaubteCodes: [0, 1] });
  if (r.code !== 0 || /quotas? not enabled|can't list qgroups/i.test(`${r.stderr}\n${r.stdout}`)) return { aktiv: false, belegt: null, limit: null };
  for (const zeile of r.stdout.split('\n')) {
    const t = zeile.trim().split(/\s+/);
    if (!/^\d+\/\d+$/.test(t[0])) continue;
    const belegt = Number(t[1]);
    const max = t[3];
    return { aktiv: true, belegt: Number.isFinite(belegt) ? belegt : null, limit: max === undefined || max === 'none' ? null : Number(max) };
  }
  return { aktiv: true, belegt: null, limit: null };
}

/** Unterlaufwerks-ID (für qgroup create 0/<id>) aus `btrfs subvolume show`. */
async function unterlaufwerkId(system, pfad) {
  const r = await system.ausfuehren('btrfs', ['subvolume', 'show', pfad]);
  const m = /Subvolume ID:\s*(\d+)/.exec(r.stdout);
  if (!m) throw new FahnasFehler('E_SYSTEM', 'Unterlaufwerks-ID nicht lesbar', { ausgabe: r.stdout.slice(0, 500) });
  return m[1];
}

/** Setzt die Grenze aus groesse_gb (qgroup limit), schaltet Quoten bei Bedarf einmalig ein. */
export async function kontingentAngleichen(werkzeuge, f) { return kontingentPfadAngleichen(werkzeuge, pfadVon(werkzeuge, f.name), f.groesse_gb); }

/** Kontingent für ein beliebiges Unterlaufwerk (auch persönliche Ordner, 12.10.2026). */
export async function kontingentPfadAngleichen(werkzeuge, pfad, groesseGb) {
  const { system } = werkzeuge;
  const soll = groesseGb ? groesseGb * GB : null;
  let ist = await kontingentZeigen(system, pfad);
  if (!ist.aktiv) {
    if (soll === null) return false;
    await system.ausfuehren('btrfs', ['quota', 'enable', pfade(werkzeuge).daten]);
    ist = await kontingentZeigen(system, pfad);
    if (!ist.aktiv) {
      throw new FahnasFehler('E_SYSTEM', 'Kontingente lassen sich auf diesem Dateisystem nicht einschalten (btrfs quota enable blieb ohne Wirkung – Kernel ohne Quoten-Unterstützung?)', { pool: pfade(werkzeuge).daten, hinweis: 'Freigabe ohne Kontingent (groesse_gb 0) anlegen' });
    }
  }
  if (ist.aktiv && ist.limit === soll) return false;
  const grenze = soll === null ? 'none' : String(soll);
  try {
    await system.ausfuehren('btrfs', ['qgroup', 'limit', grenze, pfad]);
  } catch (e) {
    // „No such process“: die Level-0-Gruppe des Unterlaufwerks ist direkt nach quota enable noch nicht da → einmal nachlegen
    if (!/No such process|ENOENT/i.test(String(e?.details?.ausgabe || ''))) throw e;
    await system.ausfuehren('btrfs', ['quota', 'enable', pfade(werkzeuge).daten]);
    await system.ausfuehren('btrfs', ['qgroup', 'create', '0/' + (await unterlaufwerkId(system, pfad)), pfade(werkzeuge).daten], { erlaubteCodes: [0, 1] });
    await system.ausfuehren('btrfs', ['qgroup', 'limit', grenze, pfad]);
  }
  return true;
}

// Belegung ohne Kontingent: du über Terabyte dauert Minuten und darf die Freigabenliste nicht aufhalten.
const belegungCache = new Map(); // pfad → {wert, zeit}
const belegungLaeuft = new Map(); // pfad → Promise
export const _test = {
  belegungLeeren() { belegungCache.clear(); belegungLaeuft.clear(); },
  belegungWarten() { return Promise.all([...belegungLaeuft.values()]); },
  belegungSetzen(pfad, wert, zeit = Date.now()) { belegungCache.set(pfad, { wert, zeit }); },
  speicherortLeeren() { datenplatteVorrat = null; },
  speicherortVeralten() { if (datenplatteVorrat) datenplatteVorrat.zeit = 0; },
};

/**
 * Startet (höchstens einmal je Freigabe gleichzeitig) einen Hintergrundlauf `nice -n 19 ionice -c 3 du -s -B1 <pfad>`,
 * merkt sich das Ergebnis und meldet danach `{ereignis:"konfig", bereich:"freigaben"}`, damit die Oberfläche die
 * Liste neu lädt. Fehler und Zeitüberschreitung werden nur auf stderr gemeldet – nie zum Listenfehler.
 */
function belegungNachladen(werkzeuge, pfad) {
  if (belegungLaeuft.has(pfad)) return belegungLaeuft.get(pfad);
  const lauf = (async () => {
    try {
      const r = await werkzeuge.system.ausfuehren('nice', ['-n', '19', 'ionice', '-c', '3', 'du', '-s', '-B1', '--', pfad], { erlaubteCodes: [0, 1], zeitlimit_ms: BELEGUNG_ZEITLIMIT_MS });
      const n = Number(String(r.stdout).trim().split(/\s+/)[0]);
      if (!Number.isFinite(n)) return;
      belegungCache.set(pfad, { wert: n, zeit: Date.now() });
      try { werkzeuge.konfigGeaendert?.('freigaben'); } catch { /* nie werfen */ }
    } catch (e) {
      process.stderr.write(`[freigaben] Belegung von ${pfad} nicht ermittelbar: ${e.message}\n`);
    } finally { belegungLaeuft.delete(pfad); }
  })();
  belegungLaeuft.set(pfad, lauf);
  return lauf;
}

/**
 * Belegung in Bytes: aus dem Kontingent (qgroup), wenn Quoten aktiv sind – sonst aus dem Zwischenspeicher
 * (höchstens 5 Minuten alt; älter → wird im Hintergrund erneuert) oder `null`, wenn noch nichts bekannt ist.
 * Die Liste wartet nie auf du.
 */
export async function belegung(werkzeuge, f) {
  const { system } = werkzeuge;
  const pfad = pfadVon(werkzeuge, f.name);
  const q = await kontingentZeigen(system, pfad);
  if (q.aktiv && q.belegt !== null) return q.belegt;
  const c = belegungCache.get(pfad);
  if (!c || Date.now() - c.zeit > BELEGUNG_FRISCH_MS) belegungNachladen(werkzeuge, pfad);
  return c ? c.wert : null;
}

// --- Speicherort (Betreiber 18.10.2026: „wo sehe ich, wo neue Freigaben erstellt wurden (auf welcher Festplatte)“) -----

/** So lange gilt das ermittelte Gerät/Modell der Datenplatte – sonst startete jede Freigabenliste findmnt und lsblk. */
export const SPEICHERORT_FRISCH_MS = 10 * 60 * 1000;
let datenplatteVorrat = null; // {schluessel: Freigaben-Ordner, zeit, lauf: Promise<{geraet, platte, modell}>}

/** Gerät des Freigaben-Ordners (findmnt -T), Platte und Modell dazu (lsblk wie bei den Laufwerken); Unbekanntes bleibt null. */
async function datenplatteErmitteln(system, shares) {
  const aus = { geraet: null, platte: null, modell: null };
  try {
    const r = await system.ausfuehren('findmnt', ['-rn', '-o', 'SOURCE', '-T', shares], { erlaubteCodes: [0, 1], zeitlimit_ms: 5000 });
    // btrfs nennt das Unterlaufwerk mit: „/dev/sda4[/@shares]“ → /dev/sda4
    const quelle = findmntText(String(r.stdout || '').trim().split(/\s+/)[0] || '').replace(/\[.*\]$/, '');
    if (!/^\/dev\/\S+$/.test(quelle)) return aus; // tmpfs, overlay … – kein Blockgerät, keine Platte
    aus.geraet = quelle;
  } catch { return aus; }
  try {
    const g = (await lsblkRoh(system)).find((x) => x.pfad === aus.geraet);
    if (g) { aus.platte = g.platte || null; aus.modell = g.modell || null; }
  } catch { /* lsblk fehlt oder scheitert – Gerät ohne Modell */ }
  return aus;
}

/**
 * Datenplatte unter dem Freigaben-Ordner: {geraet, platte, modell} (unbekannt → null). Höchstens ein Lauf je
 * SPEICHERORT_FRISCH_MS – gleichzeitige Listen teilen ihn, auch ein Fehlschlag wird gemerkt. Wirft nie.
 */
export async function datenplatte(werkzeuge) {
  const shares = pfade(werkzeuge).shares;
  const jetzt = Date.now();
  if (!datenplatteVorrat || datenplatteVorrat.schluessel !== shares || jetzt - datenplatteVorrat.zeit > SPEICHERORT_FRISCH_MS) {
    datenplatteVorrat = { schluessel: shares, zeit: jetzt, lauf: datenplatteErmitteln(werkzeuge.system, shares) };
  }
  return { ...(await datenplatteVorrat.lauf) };
}

/** Eintrag einer Konfigurationsdatei mit diesem Namen – beschädigte oder fehlende Datei → null (nie ein Listenfehler). */
async function eintragAus(konfig, datei, liste, name) {
  try {
    const d = await konfig.laden(datei, null);
    return (Array.isArray(d?.[liste]) ? d[liste] : []).find((x) => x && x.name === name) || null;
  } catch { return null; }
}

/**
 * Speicherort einer Freigabe: {art, geraet, platte, modell} – normal und verschlüsselt (Daten in <daten>/.krypt/<name>) auf
 * der Datenplatte; extern mit Bezeichnung und Modell aus laufwerke.json (so zeigt es die Laufwerke-Ansicht), Speicherverbund
 * mit Stufe und Platten aus raid.json – beides ohne Prozess.
 */
export async function speicherortVon(werkzeuge, f) {
  if (f.extern) {
    const e = await eintragAus(werkzeuge.konfig, 'laufwerke.json', 'geraete', f.name);
    return { art: 'extern', geraet: null, platte: null, modell: e?.modell || null, label: e?.label || null };
  }
  if (f.verbund) {
    const v = await eintragAus(werkzeuge.konfig, 'raid.json', 'verbuende', f.name);
    const platten = (Array.isArray(v?.platten) ? v.platten : []).filter((p) => p && typeof p === 'object').map((p) => ({ name: p.name || null, modell: p.modell || null }));
    return { art: 'verbund', geraet: v ? MD_PFAD(f.name) : null, platte: null, modell: null, stufe: v?.stufe || null, platten };
  }
  if (f.importiert) {
    const imp = await werkzeuge.konfig.laden('importe.json', null).catch(() => null);
    const v = (imp?.volumes || []).find((x) => x.uuid === f.importiert.volume);
    return { art: 'import', geraet: v?.geraet || null, platte: null, modell: null, herkunft: v?.herkunft || f.importiert.herkunft || null,
      bezeichnung: v?.bezeichnung || null, stufe: v?.raid?.stufe || null, platten: (v?.platten || []).map((x) => ({ name: x.geraet, modell: x.modell || null })) };
  }
  return { art: f.verschluesselt ? 'verschluesselt' : 'datenplatte', ...(await datenplatte(werkzeuge)) };
}

// --- Unterlaufwerk, Papierkorb, Schnappschüsse -----------------------------

async function existiert(p) { try { await fs.access(p); return true; } catch { return false; } }

async function papierkorbSicherstellen(werkzeuge, f) {
  const pfad = path.join(pfadVon(werkzeuge, f.name), PAPIERKORB);
  if (await existiert(pfad)) return false;
  await fs.mkdir(pfad, { mode: 0o770 });
  await werkzeuge.system.ausfuehren('chown', [`root:${GRUPPE_NUTZER}`, pfad]);
  await werkzeuge.system.ausfuehren('chmod', ['0770', pfad]);
  return true;
}

async function schnappschuesseZaehlen(werkzeuge, name) {
  try { return (await fs.readdir(path.join(pfade(werkzeuge).snapshots, name))).length; } catch { return 0; }
}

/**
 * Rendert eine Freigabe ins Dateisystem: Unterlaufwerk anlegen (falls fehlt), Rechte, Papierkorb, Kontingent.
 * @returns {Promise<{angelegt:boolean, rechte:boolean, kontingent:boolean}>}
 */
export async function freigabeInsSystem(werkzeuge, f, nutzerdaten) {
  // Externe Laufwerke bringen ihr eigenes Dateisystem mit (bereits eingehängt); kein Unterlaufwerk/ACL/Quota/Papierkorb.
  if (f.extern) return { angelegt: false, rechte: false, kontingent: false, extern: true };
  const pfad = pfadVon(werkzeuge, f.name);
  if (f.verschluesselt) {
    // gesperrt: nichts anfassen (Einhängepunkt ist leer und unveränderlich); entsperrt: Rechte + Papierkorb wie intern
    if (!(await krypt.entsperrt(werkzeuge, f.name))) return { angelegt: false, rechte: false, kontingent: false, verschluesselt: true, entsperrt: false };
    const rechte = await rechteAngleichen(werkzeuge, f, nutzerdaten);
    if (f.papierkorb) await papierkorbSicherstellen(werkzeuge, f);
    await ordnerrechteSchnell(werkzeuge, f, nutzerdaten);
    return { angelegt: false, rechte, kontingent: false, verschluesselt: true, entsperrt: true };
  }
  if (f.importiert) {
    // übernommener Ordner: nur wenn eingehängt (importe.apply hängt ein); nie ein Unterlaufwerk anlegen, kein Kontingent
    if (!(await samba.eingehaengt(werkzeuge.system, pfad))) return { angelegt: false, rechte: false, kontingent: false, importiert: true, eingehaengt: false };
    const rechte = await rechteAngleichen(werkzeuge, f, nutzerdaten);
    if (f.papierkorb) await papierkorbSicherstellen(werkzeuge, f);
    await ordnerrechteSchnell(werkzeuge, f, nutzerdaten);
    return { angelegt: false, rechte, kontingent: false, importiert: true };
  }
  if (f.verbund) {
    // RAID-Verbund: nur wenn er eingehängt ist (sonst nichts anfassen – darunter liegt der leere, gesperrte Einhängepunkt)
    if (!(await samba.eingehaengt(werkzeuge.system, pfad))) return { angelegt: false, rechte: false, kontingent: false, verbund: true, eingehaengt: false };
    const rechte = await rechteAngleichen(werkzeuge, f, nutzerdaten);
    if (f.papierkorb) await papierkorbSicherstellen(werkzeuge, f);
    await ordnerrechteSchnell(werkzeuge, f, nutzerdaten);
    return { angelegt: false, rechte, kontingent: false, verbund: true };
  }
  let angelegt = false;
  if (!(await existiert(pfad))) {
    await fs.mkdir(path.dirname(pfad), { recursive: true });
    await werkzeuge.system.ausfuehren('btrfs', ['subvolume', 'create', pfad]);
    angelegt = true;
  }
  const rechte = await rechteAngleichen(werkzeuge, f, nutzerdaten);
  if (f.papierkorb) await papierkorbSicherstellen(werkzeuge, f);
  const kontingent = await kontingentAngleichen(werkzeuge, f);
  await ordnerrechteSchnell(werkzeuge, f, nutzerdaten);
  return { angelegt, rechte, kontingent };
}

/** Schneller Ordnerrechte-Abgleich beim Rendern (nur Bereichswurzeln) – ein Fehler hält das Rendern der Freigabe nicht auf. */
async function ordnerrechteSchnell(werkzeuge, f, nutzerdaten) {
  if (!ordnerrechte.regelnNormieren(f.ordnerrechte).length) return;
  try { await ordnerrechteAngleichen(werkzeuge, f, nutzerdaten); } catch (e) {
    process.stderr.write(`[freigaben] Ordnerrechte in ${f.name}: ${e.message}\n`);
  }
}

/** Rendert alle Freigaben (Dateisystem + Samba + Avahi). */
export async function alleRendern(werkzeuge, freigaben, nutzerdaten) {
  const ergebnis = { freigaben: [], samba: null };
  for (const f of freigaben) ergebnis.freigaben.push({ name: f.name, ...(await freigabeInsSystem(werkzeuge, f, nutzerdaten)) });
  ergebnis.samba = await samba.rendern(werkzeuge, freigaben);
  return ergebnis;
}

async function unterlaufwerkEntfernen(werkzeuge, name) {
  const { system } = werkzeuge;
  const pf = pfade(werkzeuge);
  const schnappOrdner = path.join(pf.snapshots, name);
  if (await existiert(schnappOrdner)) {
    for (const s of (await fs.readdir(schnappOrdner)).sort()) {
      await system.ausfuehren('btrfs', ['subvolume', 'delete', path.join(schnappOrdner, s)]);
    }
    await fs.rm(schnappOrdner, { recursive: true, force: true });
  }
  const pfad = pfadVon(werkzeuge, name);
  if (await existiert(pfad)) await system.ausfuehren('btrfs', ['subvolume', 'delete', pfad]);
}

async function unterlaufwerkAufbewahren(werkzeuge, name) {
  const pfad = pfadVon(werkzeuge, name);
  if (!(await existiert(pfad))) return null;
  const zeit = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const zielOrdner = path.join(pfade(werkzeuge).backup, 'geloescht');
  await fs.mkdir(zielOrdner, { recursive: true, mode: 0o750 });
  const ziel = path.join(zielOrdner, `${name}-${zeit}`);
  await werkzeuge.system.ausfuehren('mv', [pfad, ziel]);
  return ziel;
}

// --- Sichtbarkeit und Ansicht ----------------------------------------------

function sichtbar(f, kontext, nutzerdaten) {
  if (kontext.rolle === 'admin' || kontext.rolle === 'system') return true;
  if (f.gaeste) return true;
  const ich = nutzerdaten.nutzer.find((n) => n.name === kontext.nutzer);
  const meineGruppen = new Set((ich?.gruppen || []).map((g) => `@${g}`));
  return [...(f.lesen || []), ...(f.schreiben || [])].some((k) => k === kontext.nutzer || meineGruppen.has(k));
}

/**
 * Platz eines eingehängten externen Laufwerks per df: {gesamt, frei} in Bytes oder null. Kurzes Zeitlimit und nie ein
 * Listenfehler – ein hängendes USB-Gerät darf die Freigabenliste nicht aufhalten.
 */
async function externerPlatz(system, pfad) {
  try {
    const r = await system.ausfuehren('df', ['-B1', '--output=size,avail', '--', pfad], { zeitlimit_ms: 5000 });
    const t = String(r.stdout).trim().split('\n').pop().trim().split(/\s+/);
    const gesamt = Number(t[0]); const frei = Number(t[1]);
    return Number.isFinite(gesamt) && Number.isFinite(frei) && gesamt > 0 ? { gesamt, frei } : null;
  } catch { return null; }
}

async function ansicht(werkzeuge, f) {
  const speicherort = await speicherortVon(werkzeuge, f);
  if (f.verschluesselt) {
    const entsperrt = await krypt.entsperrt(werkzeuge, f.name);
    return {
      name: f.name, beschreibung: f.beschreibung || '', pfad: pfadVon(werkzeuge, f.name), gaeste: !!f.gaeste, lesen: f.lesen || [], schreiben: f.schreiben || [],
      papierkorb: !!f.papierkorb, timemachine: !!f.timemachine, groesse_gb: null, belegt: null, kapazitaet: null, versteckt: !!f.versteckt, schnappschuesse: 0,
      erstellt: f.erstellt || null, extern: false, verschluesselt: true, entsperrt, schluessel_gespeichert: await krypt.schluesselGespeichert(werkzeuge, f.name), speicherort,
    };
  }
  if (f.importiert) {
    const pfad = pfadVon(werkzeuge, f.name);
    const eingehaengt = await samba.eingehaengt(werkzeuge.system, pfad);
    const platz = eingehaengt ? await externerPlatz(werkzeuge.system, pfad) : null;
    return {
      name: f.name, beschreibung: f.beschreibung || '', pfad, gaeste: !!f.gaeste, lesen: f.lesen || [], schreiben: f.schreiben || [],
      papierkorb: !!f.papierkorb, timemachine: !!f.timemachine, groesse_gb: null, belegt: platz ? platz.gesamt - platz.frei : null, kapazitaet: platz ? platz.gesamt : null,
      versteckt: !!f.versteckt, schnappschuesse: f.importiert.schnappschuesse ? await schnappschuesseZaehlen(werkzeuge, f.name) : 0, erstellt: f.erstellt || null,
      extern: false, importiert: { ordner: f.importiert.ordner, herkunft: f.importiert.herkunft || null, schnappschuesse: f.importiert.schnappschuesse, rechte_lassen: !!f.importiert.rechte_lassen }, eingehaengt, speicherort,
    };
  }
  if (f.verbund) {
    const pfad = pfadVon(werkzeuge, f.name);
    const eingehaengt = await samba.eingehaengt(werkzeuge.system, pfad);
    const platz = eingehaengt ? await externerPlatz(werkzeuge.system, pfad) : null;
    return {
      name: f.name, beschreibung: f.beschreibung || '', pfad, gaeste: !!f.gaeste, lesen: f.lesen || [], schreiben: f.schreiben || [],
      papierkorb: !!f.papierkorb, timemachine: !!f.timemachine, groesse_gb: null, belegt: platz ? platz.gesamt - platz.frei : null, kapazitaet: platz ? platz.gesamt : null,
      versteckt: !!f.versteckt, schnappschuesse: await schnappschuesseZaehlen(werkzeuge, f.name), erstellt: f.erstellt || null, extern: false, verbund: true, eingehaengt, speicherort,
    };
  }
  if (f.extern) {
    // externe Laufwerke: keine qgroup/du-Belegung (das würde auf Fremd-Dateisystemen scheitern oder ewig dauern),
    // sondern df des eingehängten Dateisystems. Nicht eingehängt → null (df zeigte sonst die Datenpartition darunter).
    const pfad = pfadVon(werkzeuge, f.name);
    const eingehaengt = await samba.eingehaengt(werkzeuge.system, pfad);
    const platz = eingehaengt ? await externerPlatz(werkzeuge.system, pfad) : null;
    return {
      name: f.name, beschreibung: f.beschreibung || '', pfad, gaeste: !!f.gaeste,
      lesen: f.lesen || [], schreiben: f.schreiben || [], papierkorb: true, timemachine: false,
      groesse_gb: null, belegt: platz ? platz.gesamt - platz.frei : null, kapazitaet: platz ? platz.gesamt : null, versteckt: !!f.versteckt,
      schnappschuesse: await schnappschuesseZaehlen(werkzeuge, f.name), erstellt: f.erstellt || null,
      extern: true, eingehaengt, speicherort,
    };
  }
  return {
    name: f.name, beschreibung: f.beschreibung || '', pfad: pfadVon(werkzeuge, f.name), gaeste: !!f.gaeste,
    lesen: f.lesen || [], schreiben: f.schreiben || [], papierkorb: !!f.papierkorb, timemachine: !!f.timemachine,
    groesse_gb: f.groesse_gb ?? null, belegt: await belegung(werkzeuge, f), versteckt: !!f.versteckt,
    schnappschuesse: await schnappschuesseZaehlen(werkzeuge, f.name), erstellt: f.erstellt || null, extern: false, speicherort,
  };
}

// --- Hilfen für nutzer.js ---------------------------------------------------

async function kontoAusFreigabenEntfernen(werkzeuge, konto) {
  const { konfig } = werkzeuge;
  const geaendert = await aendernFreigaben(konfig, async (daten) => {
    let anders = false;
    for (const f of daten.freigaben) {
      for (const feld of ['lesen', 'schreiben']) {
        const vorher = f[feld] || [];
        const nachher = vorher.filter((k) => k !== konto);
        if (nachher.length !== vorher.length) { f[feld] = nachher; anders = true; }
      }
      const regeln = ordnerrechte.kontoOhne(f.ordnerrechte, konto);
      if (regeln) { if (regeln.length) f.ordnerrechte = regeln; else delete f.ordnerrechte; anders = true; }
    }
    if (!anders) return false;
    const nutzerdaten = await ladenNutzer(konfig);
    await alleRendern(werkzeuge, daten.freigaben, nutzerdaten);
    return true;
  });
  if (geaendert) werkzeuge.konfigGeaendert?.('freigaben');
  return geaendert;
}

/** Umbenannter Nutzer: Rechte (lesen/schreiben, Ordnerrechte) gehen auf den neuen Namen über; rendert neu. */
export async function nutzerInFreigabenUmbenennen(werkzeuge, alt, neu) {
  const { konfig } = werkzeuge;
  const geaendert = await aendernFreigaben(konfig, async (daten) => {
    let anders = false;
    for (const f of daten.freigaben) {
      for (const feld of ['lesen', 'schreiben']) {
        if (!(f[feld] || []).includes(alt)) continue;
        f[feld] = [...new Set(f[feld].map((k) => (k === alt ? neu : k)))]; anders = true;
      }
      const regeln = ordnerrechte.kontoUmbenannt(f.ordnerrechte, alt, neu);
      if (regeln) { f.ordnerrechte = regeln; anders = true; }
    }
    if (!anders) return false;
    await alleRendern(werkzeuge, daten.freigaben, await ladenNutzer(konfig));
    return true;
  });
  if (geaendert) werkzeuge.konfigGeaendert?.('freigaben');
  return geaendert;
}

/** Nimmt einen gelöschten Nutzer aus allen Freigaben und rendert neu. */
export function nutzerAusFreigabenEntfernen(werkzeuge, name) { return kontoAusFreigabenEntfernen(werkzeuge, name); }
/** Nimmt eine gelöschte Gruppe (@name) aus allen Freigaben und rendert neu. */
export function gruppeAusFreigabenEntfernen(werkzeuge, name) { return kontoAusFreigabenEntfernen(werkzeuge, `@${name}`); }

// --- Registrierung -----------------------------------------------------------

export function registriere(reg, werkzeuge) {
  const { konfig } = werkzeuge;

  reg.aktion('freigaben.liste', {
    rolle: 'nutzer', schema: { mit_system: { typ: 'boolean', standard: false } },
    beschreibung: 'Alle für dich sichtbaren Freigaben (mit_system: zusätzlich die System-Freigabe „docker“ für Admins – nur der Dateimanager)',
    ausfuehren: async (p, kontext) => {
      const daten = await ladenFreigaben(konfig);
      const nutzerdaten = await ladenNutzer(konfig);
      const aus = [];
      for (const f of daten.freigaben) {
        if (!sichtbar(f, kontext, nutzerdaten)) continue;
        const a = await ansicht(werkzeuge, f);
        // Ordnerrechte nur für Admins (Nutzer sehen ihre Sperren in der Dateiliste)
        if (kontext.rolle === 'admin' && !f.extern) a.ordnerrechte = ordnerrechte.regelnNormieren(f.ordnerrechte);
        aus.push(a);
      }
      if (p.mit_system) { const d = await dockerAnsicht(werkzeuge, kontext); if (d) aus.push(d); }
      return aus;
    },
  });

  reg.aktion('freigaben.speicherort', {
    rolle: 'admin', schema: {}, lesend: true,
    beschreibung: 'Wo neue Freigaben entstehen: Gerät und Modell der Datenplatte unter dem Freigaben-Ordner (Dialog „Neue Freigabe“)',
    ausfuehren: async () => ({ art: 'datenplatte', ...(await datenplatte(werkzeuge)), pfad: pfade(werkzeuge).shares }),
  });

  reg.aktion('freigaben.anlegen', {
    rolle: 'admin', beschreibung: 'Neue Freigabe anlegen (btrfs-Unterlaufwerk, Rechte, Samba) oder ein externes Laufwerk anbieten',
    schema: {
      name: R.freigabename, beschreibung: { ...S.beschreibung, standard: '' }, gaeste: { typ: 'boolean', standard: false },
      lesen: { ...R.liste_namen, standard: [] }, schreiben: { ...R.liste_namen, standard: [] },
      papierkorb: { typ: 'boolean', standard: true }, timemachine: { typ: 'boolean', standard: false },
      groesse_gb: S.groesse_gb, versteckt: { typ: 'boolean', standard: false },
      // §12: extern = ein bereits eingehängtes externes Laufwerk (kein Unterlaufwerk); pfad muss der Einhängepunkt sein
      extern: { typ: 'boolean', standard: false }, pfad: { typ: 'string', max: 4096 },
      // RAID-Verbund (12.10.2026, nur intern über raid.anlegen): eingehängtes btrfs am Einhängepunkt der Freigabe
      verbund: { typ: 'boolean', standard: false },
      // verschlüsselt (gocryptfs): Passwort zum Entsperren; merken = Schlüssel auf dem NAS speichern (entsperrt beim Start)
      verschluesselt: { typ: 'boolean', standard: false }, passwort: { typ: 'string', max: 256 }, merken: { typ: 'boolean', standard: false },
    },
    ausfuehren: async (p) => {
      if (RESERVIERT.has(p.name)) throw new FahnasFehler('E_PARAMS', `„${p.name}“ ist ein reservierter Name`, { feld: 'name' });
      if (p.verschluesselt && (p.extern || p.verbund)) throw new FahnasFehler('E_PARAMS', 'Verschlüsseln geht nur bei normalen Freigaben', { feld: 'verschluesselt' });
      if (p.verschluesselt) krypt.passwortPruefen(p.passwort);
      if (p.verbund && p.extern) throw new FahnasFehler('E_PARAMS', 'Eine Freigabe ist entweder ein externes Laufwerk oder ein Verbund', { feld: 'verbund' });
      if (p.pfad !== undefined && !p.extern && !p.verbund) throw new FahnasFehler('E_PARAMS', 'Ein „pfad“ ist nur bei einem externen Laufwerk (extern:true) erlaubt', { feld: 'pfad' });
      const f = await aendernFreigaben(konfig, async (daten) => {
        if (finde(daten, p.name)) throw new FahnasFehler('E_EXISTIERT', `Freigabe „${p.name}“ gibt es schon`, { feld: 'name' });
        const zielPfad = pfadVon(werkzeuge, p.name);
        const nutzerdaten = await ladenNutzer(konfig);
        let eintrag;
        if (p.verbund) {
          if (!(await samba.eingehaengt(werkzeuge.system, zielPfad))) throw new FahnasFehler('E_BELEGT', 'Der Speicherverbund ist nicht eingehängt', { feld: 'pfad' });
          eintrag = eintragNormieren({
            name: p.name, beschreibung: p.beschreibung, gaeste: p.gaeste, versteckt: p.versteckt, papierkorb: p.papierkorb, timemachine: p.timemachine,
            lesen: kontenPruefen(p.lesen, nutzerdaten, 'lesen'), schreiben: kontenPruefen(p.schreiben, nutzerdaten, 'schreiben'),
            verbund: true, pfad: zielPfad, erstellt: new Date().toISOString(),
          });
        } else if (p.extern) {
          // pfad muss der Einhängepunkt der Freigabe sein und dort muss ein Laufwerk hängen (§12)
          if (p.pfad && path.resolve(p.pfad) !== path.resolve(zielPfad)) throw new FahnasFehler('E_PARAMS', 'Der Pfad eines externen Laufwerks muss der Einhängepunkt der Freigabe sein', { feld: 'pfad', wert: zielPfad });
          if (!(await samba.eingehaengt(werkzeuge.system, zielPfad))) throw new FahnasFehler('E_BELEGT', 'Unter diesem Namen ist kein Laufwerk eingehängt – erst das Laufwerk einhängen', { feld: 'pfad' });
          eintrag = eintragNormieren({
            name: p.name, beschreibung: p.beschreibung, gaeste: p.gaeste, versteckt: p.versteckt,
            lesen: kontenPruefen(p.lesen, nutzerdaten, 'lesen'), schreiben: kontenPruefen(p.schreiben, nutzerdaten, 'schreiben'),
            extern: true, pfad: zielPfad, erstellt: new Date().toISOString(),
          });
        } else {
          if (await existiert(zielPfad)) throw new FahnasFehler('E_EXISTIERT', `Auf der Platte gibt es unter ${zielPfad} schon einen Ordner`, { feld: 'name' });
          eintrag = eintragNormieren({
            ...p, lesen: kontenPruefen(p.lesen, nutzerdaten, 'lesen'), schreiben: kontenPruefen(p.schreiben, nutzerdaten, 'schreiben'),
            pfad: zielPfad, erstellt: new Date().toISOString(),
          });
        }
        const neu = [...daten.freigaben, eintrag];
        let angelegt = false;
        try {
          if (eintrag.verschluesselt) await krypt.anlegen(werkzeuge, p.name, p.passwort, !!p.merken);
          angelegt = (await freigabeInsSystem(werkzeuge, eintrag, nutzerdaten)).angelegt;
          await samba.rendern(werkzeuge, neu);
        } catch (e) {
          // Rendern schlug fehl → Konfiguration nicht übernehmen, frisch angelegtes Unterlaufwerk wieder weg
          if (eintrag.verschluesselt) await krypt.loeschen(werkzeuge, p.name).catch(() => {});
          if (angelegt) { try { await werkzeuge.system.ausfuehren('btrfs', ['subvolume', 'delete', pfadVon(werkzeuge, p.name)]); } catch { /* egal */ } }
          throw e;
        }
        daten.freigaben = neu;
        return eintrag;
      });
      werkzeuge.konfigGeaendert?.('freigaben');
      return ansicht(werkzeuge, f);
    },
  });

  reg.aktion('freigaben.aendern', {
    rolle: 'admin', beschreibung: 'Freigabe ändern (Rechte, Gäste, Papierkorb, Time Machine, Kontingent)',
    schema: {
      name: R.freigabename, beschreibung: S.beschreibung, gaeste: { typ: 'boolean' }, lesen: R.liste_namen, schreiben: R.liste_namen,
      papierkorb: { typ: 'boolean' }, timemachine: { typ: 'boolean' }, groesse_gb: S.groesse_gb, versteckt: { typ: 'boolean' },
    },
    ausfuehren: async (p) => {
      let rechteAnders = false;
      const f = await aendernFreigaben(konfig, async (daten) => {
        const alt = finde(daten, p.name);
        if (!alt) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${p.name}“ gibt es nicht`, { feld: 'name' });
        const nutzerdaten = await ladenNutzer(konfig);
        const { name, ...aenderungen } = p;
        if (aenderungen.lesen) aenderungen.lesen = kontenPruefen(aenderungen.lesen, nutzerdaten, 'lesen');
        if (aenderungen.schreiben) aenderungen.schreiben = kontenPruefen(aenderungen.schreiben, nutzerdaten, 'schreiben');
        const eintrag = eintragNormieren({ ...alt, ...aenderungen, name });
        const neu = daten.freigaben.map((x) => (x.name === name ? eintrag : x));
        await freigabeInsSystem(werkzeuge, eintrag, nutzerdaten);
        await samba.rendern(werkzeuge, neu);
        daten.freigaben = neu;
        rechteAnders = eintrag.importiert && !eintrag.importiert.rechte_lassen && JSON.stringify([alt.lesen, alt.schreiben, !!alt.gaeste]) !== JSON.stringify([eintrag.lesen, eintrag.schreiben, eintrag.gaeste]);
        return eintrag;
      });
      werkzeuge.konfigGeaendert?.('freigaben');
      // Übernommene Freigabe: die vorhandenen Dateien tragen noch die Rechte von der Übernahme → im Hintergrund nachziehen
      if (rechteAnders) { try { Promise.resolve(werkzeuge.intern?.('freigaben.rechte.anwenden', { name: f.name })).catch((e) => process.stderr.write(`[freigaben] Rechte nachziehen: ${e && e.message}\n`)); } catch { /* Test */ } }
      return ansicht(werkzeuge, f);
    },
  });

  reg.aktion('freigaben.loeschen', {
    rolle: 'admin', beschreibung: 'Freigabe löschen – Daten behalten (nach backup/geloescht verschieben) oder löschen',
    schema: { name: R.freigabename, daten: S.daten, mitVerbund: { typ: 'boolean', standard: false } }, // mitVerbund: nur raid.loeschen (Daten bleiben unberührt)
    ausfuehren: async (p) => {
      const aufbewahrt = await aendernFreigaben(konfig, async (daten) => {
        const alt = finde(daten, p.name);
        if (!alt) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (alt.verbund && !p.mitVerbund) throw new FahnasFehler('E_PARAMS', 'Diese Freigabe ist ein Speicherverbund (RAID) – bitte unter Laufwerke → Speicherverbünde löschen', { feld: 'name' });
        const neu = daten.freigaben.filter((x) => x.name !== p.name);
        // erst Samba ohne die Freigabe (prüfbar, umkehrbar), dann die Platte, dann die Konfiguration
        await samba.rendern(werkzeuge, neu);
        let ziel = null;
        // Externe Laufwerke bringen ein fremdes, evtl. noch eingehängtes Dateisystem mit: NICHTS am Dateisystem
        // anfassen (kein Unterlaufwerk zum Verschieben/Löschen) – nur den Eintrag und die Samba-Freigabe entfernen.
        if (alt.verschluesselt) ziel = await krypt.loeschen(werkzeuge, p.name, { behalten: p.daten === 'behalten', backup: pfade(werkzeuge).backup });
        else if (alt.importiert) await freigabeLoesen(werkzeuge, p.name); // übernommener Ordner: nur aushängen, die Daten bleiben auf dem Volume
        else if (!alt.extern && !alt.verbund) {
          if (p.daten === 'behalten') ziel = await unterlaufwerkAufbewahren(werkzeuge, p.name);
          else await unterlaufwerkEntfernen(werkzeuge, p.name);
        }
        belegungCache.delete(pfadVon(werkzeuge, p.name));
        daten.freigaben = neu;
        return ziel;
      });
      werkzeuge.konfigGeaendert?.('freigaben');
      return { name: p.name, daten: p.daten, aufbewahrt };
    },
  });

  reg.aktion('freigaben.verbindung', {
    rolle: 'nutzer', beschreibung: 'Adresse und Anleitung zum Verbinden (Mac, Windows, Linux)',
    schema: { name: R.freigabename },
    ausfuehren: async (p, kontext) => {
      const daten = await ladenFreigaben(konfig);
      const f = finde(daten, p.name);
      if (!f) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${p.name}“ gibt es nicht`, { feld: 'name' });
      const nutzerdaten = await ladenNutzer(konfig);
      if (!sichtbar(f, kontext, nutzerdaten)) throw new FahnasFehler('E_RECHTE', 'Auf diese Freigabe hast du keinen Zugriff');
      const sys = await konfig.laden('system.json');
      const host = (sys && sys.hostname) || 'fahnas';
      // IP statt Name (Betreiber 16.10.2026: Zugriff per Domain): „.local“ geht nur im Heimnetz, nicht über VPN, und die
      // Internet-Domain zeigt auf den Reverse-Proxy (SMB ist von außen zu). Die IP geht zu Hause UND über VPN.
      const { ip } = await nasNetz(werkzeuge.system).catch(() => ({ ip: null }));
      const smbLokal = `smb://${host}.local/${f.name}`;
      const smb = ip ? `smb://${ip}/${f.name}` : smbLokal;
      const ziel = ip || host;
      return {
        smb, smb_lokal: smbLokal, ip,
        hinweise: {
          mac: `Finder → Gehe zu → Mit Server verbinden (⌘K), Adresse ${smb} eingeben und mit deinem NAS-Nutzer anmelden. Das geht zu Hause und über VPN – über die Internet-Domain nicht, dort ist SMB aus Sicherheitsgründen gesperrt.${ip ? ` Im Heimnetz geht auch ${smbLokal}.` : ''}`,
          windows: `Explorer → Adresszeile: \\\\${ziel}\\${f.name} (zu Hause auch \\\\${host}\\${f.name}); als Nutzer „${host}\\deinname“ anmelden.`,
          linux: `Dateimanager → Adresse ${smb} öffnen, oder: sudo mount -t cifs //${ziel}/${f.name} /mnt/${f.name} -o user=deinname,uid=$(id -u)`,
        },
      };
    },
  });

  // ---- Verschlüsselte Freigaben: entsperren / sperren --------------------------------------------------------------
  async function kryptHolen(name) {
    const f = finde(await ladenFreigaben(konfig), name);
    if (!f) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${name}“ gibt es nicht`, { feld: 'name' });
    if (!f.verschluesselt) throw new FahnasFehler('E_PARAMS', 'Diese Freigabe ist nicht verschlüsselt', { feld: 'name' });
    return eintragNormieren(f);
  }
  async function nachKrypt() {
    const daten = await ladenFreigaben(konfig);
    await alleRendern(werkzeuge, daten.freigaben.map(eintragNormieren), await ladenNutzer(konfig));
    werkzeuge.konfigGeaendert?.('freigaben');
  }
  reg.aktion('freigaben.entsperren', {
    rolle: 'admin', beschreibung: 'Verschlüsselte Freigabe mit dem Passwort entsperren (optional Schlüssel für den Start speichern)',
    schema: { name: R.freigabename, passwort: { typ: 'string', pflicht: true, max: 256 }, merken: { typ: 'boolean' } },
    ausfuehren: async (p) => {
      const f = await kryptHolen(p.name);
      await krypt.entsperren(werkzeuge, f.name, p.passwort, p.merken === undefined ? null : p.merken);
      await nachKrypt();
      return ansicht(werkzeuge, f);
    },
  });
  reg.aktion('freigaben.sperren', {
    rolle: 'admin', beschreibung: 'Verschlüsselte Freigabe sperren (Daten nur noch verschlüsselt auf der Platte)',
    schema: { name: R.freigabename, vergessen: { typ: 'boolean', standard: false } },
    ausfuehren: async (p) => {
      const f = await kryptHolen(p.name);
      await krypt.sperren(werkzeuge, f.name);
      if (p.vergessen) await fs.rm(krypt.kryptPfade(werkzeuge, f.name).schluessel, { force: true });
      await nachKrypt();
      return ansicht(werkzeuge, f);
    },
  });

  // ---- Ordnerrechte (Betreiber 19.10.2026): Ordner einer Freigabe für Nutzer/Gruppen sperren oder auf „nur lesen“ ----
  /** Ist die Freigabe gerade benutzbar (verschlüsselt: entsperrt, Verbund: eingehängt)? */
  async function verfuegbar(f) {
    if (f.verschluesselt) return krypt.entsperrt(werkzeuge, f.name);
    if (f.verbund) return samba.eingehaengt(werkzeuge.system, pfadVon(werkzeuge, f.name));
    return true;
  }

  reg.aktion('freigaben.ordnerrechte.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Alle Ordner mit eigenen Rechten (für Übersicht und Kachel)',
    ausfuehren: async () => {
      const daten = await ladenFreigaben(konfig);
      const aus = [];
      for (const roh of daten.freigaben) {
        const f = eintragNormieren(roh);
        if (!f.ordnerrechte) continue;
        const da = await verfuegbar(f);
        for (const r of f.ordnerrechte) {
          let vorhanden = null; // null = Freigabe gerade gesperrt/nicht eingehängt
          if (da) vorhanden = await fs.lstat(path.join(pfadVon(werkzeuge, f.name), r.pfad)).then((st) => st.isDirectory(), () => false);
          aus.push({ freigabe: f.name, pfad: r.pfad, regeln: r.regeln, vorhanden });
        }
      }
      return { ordnerrechte: aus, letzter_abgleich: letzterAbgleich };
    },
  });

  reg.aktion('freigaben.ordnerrechte.lesen', {
    rolle: 'admin', lesend: true, schema: { freigabe: R.freigabename, pfad: R.pfad },
    beschreibung: 'Ordnerrechte eines Ordners: eigene Regeln, geerbte Einschränkungen und wer überhaupt Zugriff hat',
    ausfuehren: async (p) => {
      const roh = finde(await ladenFreigaben(konfig), p.freigabe);
      if (!roh) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${p.freigabe}“ gibt es nicht`, { feld: 'freigabe' });
      const f = eintragNormieren(roh);
      if (f.extern) throw new FahnasFehler('E_PARAMS', 'Externe Laufwerke kennen keine Dateirechte – Ordnerrechte gehen hier nicht', { feld: 'freigabe' });
      const rel = relativerPfad(p.pfad);
      if (!rel) throw new FahnasFehler('E_PARAMS', 'Für die ganze Freigabe gelten die Rechte unter Freigaben → Bearbeiten', { feld: 'pfad' });
      const nutzerdaten = await ladenNutzer(konfig);
      const regeln = (f.ordnerrechte || []).find((r) => r.pfad === rel)?.regeln || {};
      const geerbt = {};
      for (const r of f.ordnerrechte || []) {
        if (r.pfad === rel || !ordnerrechte.unter(rel, r.pfad)) continue;
        for (const [konto, stufe] of Object.entries(r.regeln)) {
          if (!geerbt[konto] || ordnerrechte.strenger(geerbt[konto].stufe, stufe) !== geerbt[konto].stufe) geerbt[konto] = { stufe, von: r.pfad };
        }
      }
      const listenRecht = (konto) => ((f.schreiben || []).includes(konto) ? 'schreiben' : (f.lesen || []).includes(konto) ? 'lesen' : null);
      const nichtAdmins = nutzerdaten.nutzer.filter((n) => n.rolle !== 'admin');
      const konten = [];
      for (const g of nutzerdaten.gruppen) {
        const konto = `@${g.name}`;
        const mitglieder = nichtAdmins.filter((n) => ordnerrechte.gruppenVon(nutzerdaten, n.name).has(g.name)).map((n) => n.name);
        const relevant = listenRecht(konto) || regeln[konto] || geerbt[konto] || mitglieder.some((m) => ordnerrechte.freigabeRecht(f, nutzerdaten, m));
        if (relevant) konten.push({ konto, art: 'gruppe', recht: listenRecht(konto), mitglieder });
      }
      for (const n of nichtAdmins) {
        const recht = ordnerrechte.freigabeRecht(f, nutzerdaten, n.name);
        if (recht || regeln[n.name] || geerbt[n.name]) konten.push({ konto: n.name, art: 'nutzer', anzeigename: n.anzeigename || '', recht });
      }
      return {
        freigabe: f.name, pfad: rel, regeln, geerbt, konten, gaeste: !!f.gaeste,
        admins: nutzerdaten.nutzer.filter((n) => n.rolle === 'admin').map((n) => n.name),
        darunter: (f.ordnerrechte || []).filter((r) => r.pfad !== rel && ordnerrechte.unter(r.pfad, rel)).map((r) => r.pfad),
      };
    },
  });

  reg.aktion('freigaben.ordnerrechte.setzen', {
    rolle: 'admin', aufgabe: true, schema: { freigabe: R.freigabename, pfad: { ...R.pfad, pflicht: true }, regeln: { typ: 'object', pflicht: true } },
    beschreibung: 'Ordnerrechte eines Ordners setzen ({konto: "lesen"|"keiner"}, leer = wie Freigabe) und auf die Platte bringen',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const rel = relativerPfad(p.pfad);
      if (!rel) throw new FahnasFehler('E_PARAMS', 'Für die ganze Freigabe gelten die Rechte unter Freigaben → Bearbeiten', { feld: 'pfad' });
      if (rel.split('/')[0] === PAPIERKORB) throw new FahnasFehler('E_PARAMS', 'Im Papierkorb gibt es keine Ordnerrechte', { feld: 'pfad' });
      const nutzerdaten = await ladenNutzer(konfig);
      const regeln = ordnerrechte.regelnPruefen(p.regeln, nutzerdaten);
      const f = await aendernFreigaben(konfig, async (daten) => {
        const alt = finde(daten, p.freigabe);
        if (!alt) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${p.freigabe}“ gibt es nicht`, { feld: 'freigabe' });
        const e = eintragNormieren(alt);
        if (e.extern) throw new FahnasFehler('E_PARAMS', 'Externe Laufwerke kennen keine Dateirechte – Ordnerrechte gehen hier nicht', { feld: 'freigabe' });
        if (!(await verfuegbar(e))) throw new FahnasFehler('E_BELEGT', 'Die Freigabe ist gerade gesperrt bzw. nicht eingehängt', { feld: 'freigabe' });
        if (Object.keys(regeln).length) {
          const abs = await sicherAufloesen(pfadVon(werkzeuge, e.name), rel);
          const st = await fs.lstat(abs).catch(() => null);
          if (!st || !st.isDirectory()) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Ordner nicht gefunden', { feld: 'pfad' });
        }
        const liste = (e.ordnerrechte || []).filter((r) => r.pfad !== rel);
        if (Object.keys(regeln).length) liste.push({ pfad: rel, regeln });
        if (liste.length > ordnerrechte.MAX_REGELN) throw new FahnasFehler('E_PARAMS', `Höchstens ${ordnerrechte.MAX_REGELN} Ordner mit eigenen Rechten je Freigabe`, { feld: 'pfad' });
        alt.ordnerrechte = ordnerrechte.regelnNormieren(liste);
        if (!alt.ordnerrechte.length) delete alt.ordnerrechte;
        return eintragNormieren(alt);
      });
      werkzeuge.konfigGeaendert?.('freigaben');
      aufgabe?.fortschritt(0.05, 'Rechte auf der Platte setzen');
      let gemeldet = 0;
      const [erg] = await ordnerrechteAngleichen(werkzeuge, f, nutzerdaten, {
        pfade: [rel], abgebrochen: () => !!aufgabe?.abgebrochen(),
        fortschritt: (n) => { if (n - gemeldet >= 200) { gemeldet = n; aufgabe?.fortschritt(0.5, `${n} Einträge geprüft`); } },
      });
      if (erg) abgleichMerken([{ freigabe: f.name, ...erg }], true);
      return { freigabe: f.name, pfad: rel, regeln, geprueft: erg?.geprueft || 0, geaendert: erg?.geaendert || 0, fehlt: !!erg?.fehlt };
    },
  });

  reg.aktion('freigaben.rechte.anwenden', {
    rolle: 'admin', aufgabe: true, schema: { name: R.freigabename, erzwingen: { typ: 'boolean', standard: false } },
    beschreibung: 'Rechte der Freigabe auf alle vorhandenen Dateien und Ordner übertragen (Ordnerrechte bleiben)',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      aufgabe?.fortschritt(0.02, 'Rechte werden übertragen');
      let gemeldet = 0;
      return rechteAnwenden(werkzeuge, p.name, {
        erzwingen: !!p.erzwingen,
        abgebrochen: () => !!aufgabe?.abgebrochen(),
        fortschritt: (n) => { if (n - gemeldet >= 500) { gemeldet = n; aufgabe?.fortschritt(0.5, `${n} Einträge geprüft`); } },
      });
    },
  });

  reg.aktion('freigaben.ordnerrechte.apply', {
    rolle: 'system', schema: { gruendlich: { typ: 'boolean', standard: false }, freigabe: { typ: 'string', max: 64 }, pfade: { typ: 'array', max: 1000, elemente: { typ: 'string', max: 4096 } } },
    beschreibung: 'Ordnerrechte auf die Platte bringen (schnell: nur Bereichswurzeln; gründlich: alles; pfade: nur Bereiche um diese Pfade)',
    ausfuehren: async (p) => {
      const daten = await ladenFreigaben(konfig);
      const nutzerdaten = await ladenNutzer(konfig);
      const alle = []; let fehler = null;
      for (const roh of daten.freigaben) {
        const f = eintragNormieren(roh);
        if ((p.freigabe && f.name !== p.freigabe) || !f.ordnerrechte) continue;
        if (!(await verfuegbar(f))) continue;
        let pfade = null;
        if (p.pfade) {
          const qs = p.pfade.map((q) => relativerPfad(q));
          pfade = f.ordnerrechte.map((r) => r.pfad).filter((z) => qs.some((q) => ordnerrechte.unter(q, z) || ordnerrechte.unter(z, q)));
          if (!pfade.length) continue;
        }
        try {
          for (const e of await ordnerrechteAngleichen(werkzeuge, f, nutzerdaten, { gruendlich: !!p.gruendlich, pfade })) alle.push({ freigabe: f.name, ...e });
        } catch (e) { fehler = e.message; process.stderr.write(`[freigaben] Ordnerrechte in ${f.name}: ${e.message}\n`); }
      }
      if (!p.pfade && !p.freigabe) abgleichMerken(alle, !!p.gruendlich, fehler);
      return { bereiche: alle.length, geaendert: alle.reduce((s, e) => s + (e.geaendert || 0), 0), fehlt: alle.filter((e) => e.fehlt).length, fehler };
    },
  });

  reg.aktion('freigaben.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Alle Freigaben idempotent ins System rendern',
    ausfuehren: async () => {
      const daten = await ladenFreigaben(konfig);
      const nutzerdaten = await ladenNutzer(konfig);
      const freigaben = daten.freigaben.map(eintragNormieren);
      // verschlüsselte Freigaben mit gespeichertem Schlüssel beim Start entsperren
      for (const f of freigaben.filter((x) => x.verschluesselt)) { try { await krypt.automatisch(werkzeuge, f.name); } catch (e) { process.stderr.write(`[freigaben] ${f.name} nicht entsperrt: ${e.message}\n`); } }
      const r = await alleRendern(werkzeuge, freigaben, nutzerdaten);
      return {
        freigaben: r.freigaben.length, angelegt: r.freigaben.filter((x) => x.angelegt).map((x) => x.name),
        rechte_gesetzt: r.freigaben.filter((x) => x.rechte).map((x) => x.name), samba_geaendert: r.samba.geaendert,
      };
    },
  });
}

// Stündlich gründlich: Dateien, die per SMB in einen eingeschränkten Ordner verschoben wurden, behalten sonst ihre alten
// Rechte (Verschieben ändert keine ACL). Erster Lauf zwei Minuten nach dem Start.
let ersterLauf = null; let stundenTakt = null;
export function starten(w) {
  const lauf = () => { w.intern('freigaben.ordnerrechte.apply', { gruendlich: true }).catch((e) => process.stderr.write(`[freigaben] Ordnerrechte (stündlich): ${e && e.message}\n`)); };
  ersterLauf = setTimeout(lauf, 2 * 60_000); ersterLauf.unref?.();
  stundenTakt = setInterval(lauf, 60 * 60_000); stundenTakt.unref?.();
}
export function stoppen() { clearTimeout(ersterLauf); clearInterval(stundenTakt); ersterLauf = null; stundenTakt = null; }
