// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegelung – ein Lauf: Seiten auflösen (Freigabe + Unterordner), externe Laufwerke auf Einhängung prüfen, Leer-Schutz,
// Werkzeug bei Bedarf nachinstallieren, rsync (einseitig) bzw. unison (beidseitig) mit Fortschritt/Abbruch/Protokoll
// ausführen, Papierkorb-Ordner aufräumen. Nie ins leere Einhängeverzeichnis eines abgezogenen Laufwerks schreiben.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { einhaengung } from '../render/samba.js';
import {
  PAPIERKORB, EINFACHE_FS, FAT_FS, ausnahmeMuster, rsyncArgumente, unisonArgumente, rsyncStatistik, rsyncFortschritt, unisonStatistik,
  vorschauZusammenfassen, stempel,
} from './regeln.js';
import { korbOrte, korbAbschliessen, korbAufraeumen } from './korb.js';
import { zugaengeLaden, zugangHolen, einhaengen } from './fern.js';
import { laufenCloud } from './cloud.js';

export const PROTOKOLL_ZEILEN = 400;
const UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
const PAKETE = Object.freeze({ rsync: 'rsync', unison: 'unison' });
const IGNORIERT = new Set([PAPIERKORB, '.papierkorb']);

/** Merkmal für „Laufwerk fehlt“ – der Planer holt solche Läufe nach, sobald es wieder eingehängt ist. */
export function nichtAngeschlossen(freigabe) {
  return new FahnasFehler('E_NICHT_GEFUNDEN', `Laufwerk „${freigabe}“ ist nicht angeschlossen – der Lauf wird nachgeholt, sobald es wieder da ist`, { freigabe, grund: 'nicht_eingehaengt' });
}
export function istNichtAngeschlossen(e) { return !!(e && e.details && e.details.grund === 'nicht_eingehaengt'); }

async function freigabenLaden(w) {
  const d = await w.konfig.laden('shares.json', { freigaben: [] });
  return Array.isArray(d?.freigaben) ? d.freigaben : [];
}

/** Dateisystem, auf dem `pfad` liegt (findmnt -T), z. B. exfat, btrfs. */
export async function dateisystemVon(system, pfad) {
  try {
    const r = await system.ausfuehren('findmnt', ['-n', '-o', 'FSTYPE', '-T', pfad], { erlaubteCodes: [0, 1], zeitlimit_ms: 10_000 });
    return String(r.stdout).trim().split('\n')[0] || null;
  } catch { return null; }
}

/**
 * Seite auflösen: {freigabe, pfad} → {wurzel, voll, extern, eingehaengt}. Wirft E_NICHT_GEFUNDEN für unbekannte Freigaben
 * und „nicht angeschlossen“ für ausgehängte externe Laufwerke.
 */
export async function seiteAufloesen(w, seite, freigaben = null) {
  const liste = freigaben || await freigabenLaden(w);
  const f = liste.find((x) => x && x.name === seite.freigabe);
  if (!f) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Freigabe „${seite.freigabe}“ gibt es nicht (mehr)`, { freigabe: seite.freigabe });
  const wurzel = path.join(w.pfade.shares, f.name);
  const voll = seite.pfad ? path.join(wurzel, seite.pfad) : wurzel;
  if (voll !== wurzel && !voll.startsWith(wurzel + '/')) throw new FahnasFehler('E_PARAMS', 'Ordner liegt außerhalb der Freigabe', { feld: 'pfad' });
  const extern = !!f.extern;
  // externe Laufwerke und gesperrte verschlüsselte Freigaben: nur eingehängt nutzbar
  const eingehaengt = extern || f.verschluesselt ? (await einhaengung(w.system, wurzel)).eingehaengt : true;
  return { wurzel, voll, extern, eingehaengt, freigabe: f.name, anzeige: seite.pfad ? `${f.name}/${seite.pfad}` : f.name };
}

/** Prüft nach dem Anlegen, dass der echte Pfad (Verknüpfungen aufgelöst) noch in der Freigabe liegt. */
async function innerhalbPruefen(s) {
  const [echtWurzel, echt] = await Promise.all([fs.realpath(s.wurzel), fs.realpath(s.voll)]);
  if (echt !== echtWurzel && !echt.startsWith(echtWurzel + '/')) throw new FahnasFehler('E_RECHTE', 'Der Ordner zeigt über eine Verknüpfung aus der Freigabe hinaus', { freigabe: s.freigabe });
}

async function istOrdner(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
async function hatInhalt(p) {
  try { return (await fs.readdir(p)).some((n) => !IGNORIERT.has(n)); } catch { return false; }
}

/** Werkzeug vorhanden? Sonst per apt nachinstallieren (Agent läuft als root). */
export async function werkzeugSicherstellen(w, programm, melde = () => {}) {
  for (const ort of ['/usr/bin', '/usr/local/bin', '/bin']) if (await w.system.existiert(path.join(ort, programm))) return true;
  melde(`${programm} wird installiert …`);
  await w.system.ausfuehren('apt-get', ['install', '-y', '--no-install-recommends', PAKETE[programm]], {
    zeitlimit_ms: 10 * 60_000, umgebung: { ...UMGEBUNG, DEBIAN_FRONTEND: 'noninteractive' },
  });
  return true;
}

/** Welche Werkzeuge sind da? (für die Oberfläche) */
export async function werkzeugeDa(w) {
  const da = async (p) => (await w.system.existiert(`/usr/bin/${p}`)) || (await w.system.existiert(`/bin/${p}`));
  return { rsync: await da('rsync'), unison: await da('unison') };
}

/**
 * Startet einen Prozess, liest Zeilen (\r und \n), meldet Fortschritt, bricht bei `abgebrochen()` ab.
 * @returns {Promise<{code:number, zeilen:string[]}>} zeilen = Protokoll ohne Fortschrittszeilen (gekürzt)
 */
function prozessLaufen(w, programm, argumente, { umgebung, beiZeile, abgebrochen, protokoll = [] }) {
  return new Promise((fertig, fehlschlag) => {
    let kind;
    try { kind = w.system.starten(programm, argumente, { stdio: ['ignore', 'pipe', 'pipe'], env: umgebung }); } catch (e) { fehlschlag(e); return; }
    let rest = '';
    const zeile = (z) => {
      if (!z) return;
      const istFortschritt = beiZeile ? beiZeile(z) : false;
      if (!istFortschritt) { protokoll.push(z); if (protokoll.length > PROTOKOLL_ZEILEN * 2) protokoll.splice(0, protokoll.length - PROTOKOLL_ZEILEN); }
    };
    const lesen = (puffer) => {
      rest += puffer.toString('utf8');
      const teile = rest.split(/[\r\n]/);
      rest = teile.pop();
      for (const z of teile) zeile(z.trimEnd());
    };
    kind.stdout.on('data', lesen);
    kind.stderr.on('data', lesen);
    const wache = setInterval(() => { if (abgebrochen && abgebrochen()) { try { kind.kill('SIGTERM'); } catch { /* weg */ } } }, 1000);
    kind.on('error', (e) => { clearInterval(wache); fehlschlag(new FahnasFehler('E_SYSTEM', `${programm} ließ sich nicht starten`, { grund: e.message })); });
    kind.on('close', (code, signal) => {
      clearInterval(wache);
      if (rest) zeile(rest.trimEnd());
      fertig({ code: typeof code === 'number' ? code : -1, signal, zeilen: protokoll.slice(-PROTOKOLL_ZEILEN) });
    });
  });
}

/**
 * Ein Lauf. `griff` = {fortschritt(anteil, meldung), abgebrochen()}. Gibt eine Zusammenfassung zurück:
 * {ergebnis:'ok'|'warnung', meldung, zahlen, protokoll[], vorschau?}. Fehler werfen (nichtAngeschlossen() → nachholen).
 */
export async function laufen(w, auftrag, optionen = {}) {
  // Seiten auf einem anderen NAS nur für die Dauer des Laufs einhängen (/run/fahnas/spiegelung/<id>-q|z), danach aushängen
  const eingehaengt = [];
  try {
    const seiten = {};
    const zugaenge = auftrag.quelle.zugang || auftrag.ziel.zugang ? await zugaengeLaden(w) : [];
    // Cloud-Speicher (rclone) statt Einhängen – die andere Seite liegt auf diesem NAS (oder einem per SMB)
    const cloud = [auftrag.quelle, auftrag.ziel].map((s) => (s.zugang ? zugaenge.find((z) => z.id === s.zugang) : null)).find((z) => z && z.art === 'cloud');
    if (cloud) return await cloudLaufen(w, auftrag, cloud, optionen);
    for (const [rolle, seite, kurz] of [['quelle', auftrag.quelle, 'q'], ['ziel', auftrag.ziel, 'z']]) {
      if (!seite.zugang) continue;
      optionen.griff?.fortschritt?.(0, `Verbinde mit dem anderen NAS …`);
      const z = await zugangHolen(w, seite.zugang, zugaenge);
      const e = await einhaengen(w, z, seite.freigabe, { name: `${auftrag.id}-${kurz}` });
      eingehaengt.push(e);
      const voll = seite.pfad ? path.join(e.pfad, seite.pfad) : e.pfad;
      const anzeige = `${z.name}: ${seite.freigabe}${seite.pfad ? `/${seite.pfad}` : ''}`;
      seiten[rolle] = { wurzel: e.pfad, voll, extern: true, eingehaengt: true, freigabe: seite.freigabe, anzeige, fern: true };
    }
    return await laufenEingehaengt(w, auftrag, optionen, seiten);
  } finally {
    for (const e of eingehaengt.reverse()) await e.aushaengen();
  }
}

/** Cloud-Lauf: lokale Seite auflösen (mit Leer-/Einhängeschutz wie sonst), dann rclone. */
async function cloudLaufen(w, auftrag, z, { vorschau = false, griff = null, jetzt = new Date() } = {}) {
  const melde = (anteil, text) => { try { griff?.fortschritt?.(anteil, text); } catch { /* egal */ } };
  const abgebrochen = () => !!griff?.abgebrochen?.();
  const lokaleSeite = auftrag.ziel.zugang ? auftrag.quelle : auftrag.ziel;
  if (lokaleSeite.zugang) throw new FahnasFehler('E_PARAMS', 'Eine Seite einer Cloud-Spiegelung muss auf diesem NAS liegen', { feld: 'quelle' });
  const lokal = await seiteAufloesen(w, lokaleSeite);
  if (!lokal.eingehaengt) throw nichtAngeschlossen(lokal.freigabe);
  if (auftrag.ziel.zugang && !await istOrdner(lokal.voll)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Der Quellordner „${lokal.anzeige}“ fehlt`, { freigabe: lokal.freigabe });
  if (await istOrdner(lokal.voll)) await innerhalbPruefen(lokal);
  return laufenCloud(w, auftrag, z, { lokal, vorschau, melde, abgebrochen, jetzt, prozess: (p, a, o) => prozessLaufen(w, p, a, o) });
}

async function laufenEingehaengt(w, auftrag, { vorschau = false, griff = null, unisonOrdner, jetzt = new Date() } = {}, seiten = {}) {
  const melde = (anteil, text) => { try { griff?.fortschritt?.(anteil, text); } catch { /* egal */ } };
  const abgebrochen = () => !!griff?.abgebrochen?.();
  const freigaben = await freigabenLaden(w);
  const quelle = seiten.quelle || await seiteAufloesen(w, auftrag.quelle, freigaben);
  const ziel = seiten.ziel || await seiteAufloesen(w, auftrag.ziel, freigaben);
  for (const s of [quelle, ziel]) if (!s.eingehaengt) throw nichtAngeschlossen(s.freigabe);
  const beidseitig = auftrag.richtung === 'beidseitig';

  // Ordner: einseitig muss die Quelle existieren; Ziel (und bei beidseitig auch die Quelle) wird angelegt.
  if (!await istOrdner(quelle.voll)) {
    if (!beidseitig) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Der Quellordner „${auftrag.quelle.freigabe}/${auftrag.quelle.pfad}“ fehlt`, { freigabe: auftrag.quelle.freigabe });
    if (!vorschau) await fs.mkdir(quelle.voll, { recursive: true });
  }
  if (!vorschau) await fs.mkdir(ziel.voll, { recursive: true });
  for (const s of [quelle, ziel]) if (await istOrdner(s.voll)) await innerhalbPruefen(s);

  // Leer-Schutz (einseitig): leere Quelle würde im Ziel alles löschen – wahrscheinlicher ist ein Fehler (Platte, Pfad).
  if (!beidseitig && !await hatInhalt(quelle.voll) && await hatInhalt(ziel.voll)) {
    throw new FahnasFehler('E_SYSTEM', 'Die Quelle ist leer, das Ziel aber nicht – zum Schutz vor Datenverlust abgebrochen. Ist die Quelle richtig gewählt?', { freigabe: auftrag.quelle.freigabe, grund: 'quelle_leer' });
  }

  const fsZiel = await dateisystemVon(w.system, await istOrdner(ziel.voll) ? ziel.voll : ziel.wurzel);
  const fsQuelle = await dateisystemVon(w.system, quelle.voll);
  const einfach = EINFACHE_FS.has(fsZiel);
  const st = stempel(jetzt);
  const korb = korbOrte(ziel, auftrag.id, st);
  const papierkorbOrdner = korb.inhalt;
  const protokoll = [];
  const kopf = `${beidseitig ? 'Beidseitig' : 'Einseitig'}: ${quelle.anzeige} ${beidseitig ? '↔' : '→'} ${ziel.anzeige} (Ziel-Dateisystem ${fsZiel || '?'}${einfach ? ', ohne Besitzer/Rechte/Verknüpfungen' : ''})`;
  protokoll.push(kopf);

  if (!beidseitig) {
    await werkzeugSicherstellen(w, 'rsync', (t) => melde(0, t));
    melde(0, vorschau ? 'Vorschau wird berechnet …' : 'Dateiliste wird erstellt …');
    let letzte = 0;
    const ausnahmenDatei = FAT_FS.has(fsZiel) && await istOrdner(ziel.voll) ? await ausnahmenVor1980(w, quelle.voll, ziel.voll) : null;
    const r = await prozessLaufen(w, 'rsync', rsyncArgumente({ quelle: quelle.voll, ziel: ziel.voll, einfach, vorschau, papierkorbOrdner, ausnahmenDatei }), {
      umgebung: UMGEBUNG, abgebrochen, protokoll,
      beiZeile: vorschau ? null : (z) => {
        const p = rsyncFortschritt(z);
        if (p === null) return false;
        if (Date.now() - letzte > 1000) { letzte = Date.now(); melde(p, `${Math.round(p * 100)} %`); }
        return true;
      },
    });
    if (ausnahmenDatei) await fs.rm(ausnahmenDatei, { force: true });
    if (!vorschau) await korbAbschliessen(korb, auftrag, jetzt, { system: w.system, extern: ziel.extern });
    if (abgebrochen()) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
    const zahlen = rsyncStatistik(r.zeilen.join('\n'));
    if (vorschau) {
      const v = vorschauZusammenfassen(r.zeilen);
      if (r.code !== 0 && r.code !== 24) throw new FahnasFehler('E_SYSTEM', `Vorschau fehlgeschlagen (rsync ${r.code})`, { ausgabe: r.zeilen.slice(-8).join('\n') });
      return { ergebnis: 'ok', meldung: '', zahlen, vorschau: v, protokoll: [kopf] };
    }
    if (r.code === 0 || r.code === 24 || r.code === 23) await korbAufraeumen(ziel, auftrag, jetzt, r.zeilen);
    if (r.code === 0) return { ergebnis: 'ok', meldung: '', zahlen, protokoll: r.zeilen };
    if (r.code === 24) return { ergebnis: 'warnung', meldung: 'Einige Dateien verschwanden während des Abgleichs aus der Quelle', zahlen, protokoll: r.zeilen };
    if (r.code === 23) return { ergebnis: 'warnung', meldung: 'Einige Dateien oder Eigenschaften ließen sich nicht übertragen – Details im Protokoll', zahlen, protokoll: r.zeilen };
    throw new FahnasFehler('E_SYSTEM', `Abgleich fehlgeschlagen (rsync ${r.code}${r.code === 11 ? ': Ziel voll oder nicht beschreibbar' : ''})`, { ausgabe: r.zeilen.slice(-8).join('\n'), protokoll: r.zeilen });
  }

  if (vorschau) throw new FahnasFehler('E_PARAMS', 'Eine Vorschau gibt es nur bei einseitigen Spiegelungen', { feld: 'vorschau' });
  await werkzeugSicherstellen(w, 'unison', (t) => melde(0, t));
  await fs.mkdir(papierkorbOrdner, { recursive: true });
  await fs.mkdir(unisonOrdner, { recursive: true });
  melde(0, 'Beide Seiten werden verglichen …');
  const fat = einfach || EINFACHE_FS.has(fsQuelle);
  let gezaehlt = 0;
  const r = await prozessLaufen(w, 'unison', unisonArgumente({ a: quelle.voll, b: ziel.voll, fat, papierkorbOrdner }), {
    umgebung: { ...UMGEBUNG, UNISON: unisonOrdner, HOME: unisonOrdner }, abgebrochen, protokoll,
    beiZeile: (z) => { if (/^\[(BGN|END)\]|^(Copying|Deleting|Updating)/.test(z)) { gezaehlt++; if (gezaehlt % 20 === 0) melde(0, `${gezaehlt} Änderungen übertragen …`); } return false; },
  });
  await korbAbschliessen(korb, auftrag, jetzt, { system: w.system, extern: ziel.extern });
  if (abgebrochen()) throw new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen');
  const zahlen = unisonStatistik(r.zeilen.join('\n'));
  if (r.code <= 2) await korbAufraeumen(ziel, auftrag, jetzt, r.zeilen);
  if (r.code === 0) return { ergebnis: 'ok', meldung: '', zahlen, protokoll: r.zeilen };
  if (r.code === 1 || r.code === 2) return { ergebnis: 'warnung', meldung: 'Einige Dateien wurden übersprungen oder konnten nicht übertragen werden – Details im Protokoll', zahlen, protokoll: r.zeilen };
  const grosseLoeschung = r.zeilen.some((z) => /confirmbigdel|all the files/i.test(z));
  throw new FahnasFehler('E_SYSTEM', grosseLoeschung
    ? 'Eine Seite ist komplett leer – zum Schutz vor Datenverlust abgebrochen. Ist das Laufwerk richtig angeschlossen?'
    : `Abgleich fehlgeschlagen (unison ${r.code})`, { ausgabe: r.zeilen.slice(-8).join('\n'), protokoll: r.zeilen });
}

/**
 * FAT/exFAT speichern keine Zeiten vor 1980: Solche Dateien stimmen nie überein und liefen sonst bei jedem Lauf neu durch den
 * Papierkorb. Liegen sie im Ziel schon in gleicher Größe, nimmt die zurückgegebene Ausnahmen-Datei sie aus dem Lauf heraus.
 * Der Aufrufer löscht die Datei; null = keine solche Datei.
 */
export async function ausnahmenVor1980(w, quelle, ziel) {
  const r = await w.system.ausfuehren('find', [quelle, '-type', 'f', '!', '-newermt', '1980-01-02', '-printf', '%P\\0'], { erlaubteCodes: [0, 1], zeitlimit_ms: 300_000 });
  const gleich = [];
  for (const rel of String(r.stdout).split('\0').filter((x) => x && !x.includes('\n'))) {
    const [a, b] = await Promise.all([fs.stat(path.join(quelle, rel)), fs.stat(path.join(ziel, rel)).catch(() => null)]);
    if (b && a.size === b.size) gleich.push(ausnahmeMuster(rel));
  }
  if (!gleich.length) return null;
  const datei = path.join(os.tmpdir(), `fahnas-ausnahmen-${crypto.randomUUID()}`);
  await fs.writeFile(datei, `${gleich.join('\n')}\n`, { mode: 0o600 });
  return datei;
}

/** Papierkorb im Ziel aufräumen (täglicher Planer, nur Ziele auf diesem NAS – fremde räumt jeder Lauf selbst auf). */
export async function papierkorbAufraeumen(w, auftrag, jetzt = new Date()) {
  if (auftrag.ziel.zugang) return []; // anderes NAS oder Cloud: räumt jeder Lauf selbst auf
  let ziel;
  try { ziel = await seiteAufloesen(w, auftrag.ziel); } catch { return []; }
  if (!ziel.eingehaengt) return [];
  return korbAufraeumen(ziel, auftrag, jetzt);
}
