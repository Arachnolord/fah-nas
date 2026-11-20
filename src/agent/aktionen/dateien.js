// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „dateien.*“: Dateimanager über die Freigaben. Der Agent prüft Freigabe-Recht und Pfad, startet dann den
// Dateihelfer (src/agent/helfer/dateihelfer.js) als Kindprozess MIT UID/GID DES NUTZERS – so gelten Dateirechte
// und ACLs automatisch, nichts läuft als root. Tickets für den Datenkanal, zeitbegrenzte Freigabelinks.
// Vorschaubilder (dateien.vorschau) erzeugt src/agent/helfer/vorschau.js mit ffmpeg – ebenfalls als Nutzer.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PFADE, relativerPfad, pruefeFreigabename, sicherAufloesen } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { R } from '../../gemeinsam/schema.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { PAPIERKORB, BEI_VORHANDEN, TEXT_MAX_BYTES } from '../helfer/dateihelfer.js';
import { Vorschau, GROESSEN as VORSCHAU_GROESSEN, STANDARD_GROESSE as VORSCHAU_STANDARD } from '../helfer/vorschau.js';
import { nachfuehren } from '../office/index.js';
import { hatPapierkorb } from '../render/samba.js';
import { gruppenVon, bereicheFuer, sperrePruefen, stufeAn, regelnNormieren, regelnUmziehen, regelnOhne, unter } from '../freigaben/ordnerrechte.js';

export { gruppenVon };

const HIER = path.dirname(fileURLToPath(import.meta.url));
export const HELFER_PFAD = path.join(HIER, '..', 'helfer', 'dateihelfer.js');
const LINKS_DATEI = 'links.json';
const ABBRUCH_HART_MS = 15_000;

// ---------------------------------------------------------------------------------------------------------------
// Rechte
// ---------------------------------------------------------------------------------------------------------------
function pfadeVon(w) { return w.pfade || PFADE; }

/**
 * System-Freigabe „docker“ = App-Ordner (/data/apps, Schalter system.json docker_freigabe, Betreiber 12.10.: „nicht nur als
 * SMB-Freigabe, sondern auch unter Dateien“). Nur für Admins; die App-Ordner gehören root bzw. den Container-Nutzern, deshalb
 * arbeitet der Dateihelfer dort als root – genau wie Samba mit „force user = root“. Kein Papierkorb, keine Download-Links.
 */
export const DOCKER_FREIGABE = 'docker';

async function dockerAn(werkzeuge) {
  try { return !!(await werkzeuge.konfig.laden('system.json'))?.docker_freigabe; } catch { return false; }
}

/** Ansicht der System-Freigabe „docker“ für freigaben.liste ({mit_system:true}, nur Admins) – null, wenn abgeschaltet. */
export async function dockerAnsicht(werkzeuge, kontext) {
  if (kontext.rolle !== 'admin' || !await dockerAn(werkzeuge)) return null;
  return {
    name: DOCKER_FREIGABE, beschreibung: 'App-Ordner (Docker) – Daten und Einstellungen aller Apps, nur für Admins',
    pfad: pfadeVon(werkzeuge).apps, gaeste: false, lesen: [], schreiben: [], papierkorb: false, timemachine: false,
    groesse_gb: null, belegt: null, versteckt: false, schnappschuesse: 0, erstellt: null, extern: false, system: true,
  };
}

/** uid/gid/Gruppen für den Dateihelfer: in der System-Freigabe „docker“ als root (nur Admins), sonst als der Nutzer selbst. */
export async function idsFuer(werkzeuge, kontext, ...wurzeln) {
  const apps = pfadeVon(werkzeuge).apps;
  if (kontext.rolle === 'admin' && wurzeln.some((w) => w === apps)) return { uid: 0, gid: 0, gruppen: [] };
  return werkzeuge.system.nutzerIds(kontext.nutzer);
}

/**
 * Ermittelt Freigabe, Wurzelpfad und die Rechte des anfragenden Nutzers.
 * admin darf alles; sonst: schreiben-Liste → lesen+schreiben, lesen-Liste oder gaeste → lesen. Einträge „@gruppe“
 * gelten über die Gruppenmitgliedschaft aus users.json. „gaeste“ heißt hier: jeder angemeldete Nutzer darf lesen.
 * `bereiche` = Ordnerrechte des Nutzers [{pfad, stufe: 'lesen'|'keiner'}] (Admins: keine), `regelpfade` = alle Ordner mit
 * eigenen Rechten (Markierung für Admins).
 */
export async function freigabeRechte(werkzeuge, name, kontext) {
  pruefeFreigabename(name);
  if (name === DOCKER_FREIGABE) {
    if (kontext.rolle !== 'admin' || !await dockerAn(werkzeuge)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die Freigabe „${name}“ gibt es nicht`, { feld: 'freigabe' });
    return { freigabe: { name, papierkorb: false, system: true }, wurzel: pfadeVon(werkzeuge).apps, lesen: true, schreiben: true };
  }
  const shares = await werkzeuge.konfig.laden('shares.json');
  const roh = (shares?.freigaben || []).find((x) => x.name === name);
  if (!roh) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die Freigabe „${name}“ gibt es nicht`, { feld: 'freigabe' });
  const f = { ...roh, papierkorb: hatPapierkorb(roh) };
  const wurzel = path.join(pfadeVon(werkzeuge).shares, name);
  const regelpfade = f.extern ? [] : regelnNormieren(f.ordnerrechte).map((r) => r.pfad);
  if (kontext.rolle === 'admin') return { freigabe: f, wurzel, lesen: true, schreiben: true, bereiche: [], regelpfade };
  const users = await werkzeuge.konfig.laden('users.json');
  const gruppen = gruppenVon(users, kontext.nutzer);
  const drin = (liste) => (Array.isArray(liste) ? liste : []).some((e) => e === kontext.nutzer || (typeof e === 'string' && e.startsWith('@') && gruppen.has(e.slice(1))));
  const schreiben = drin(f.schreiben);
  const lesen = schreiben || drin(f.lesen) || f.gaeste === true;
  return { freigabe: f, wurzel, lesen, schreiben, bereiche: f.extern ? [] : bereicheFuer(f, users, kontext.nutzer), regelpfade: [] };
}

/** Ordnerrechte für eine Aktion an `rel` prüfen (kein Zugriff → E_RECHTE gesperrt, nur lesen + schreiben → E_RECHTE). */
export function ordnerZugriff(r, rel, schreiben = false, feld = 'pfad') { sperrePruefen(r.bereiche, rel, schreiben, feld); }

/**
 * Ordnerzeilen der Liste markieren: `gesperrt` (kein Zugriff – bleibt sichtbar, Klick zeigt „Nicht für dich freigegeben“),
 * `nur_lesen`, für Admins `ordnerrecht` (der Ordner hat eigene Rechte).
 */
export function ordnerrechteMarkieren(eintraege, r, rel) {
  if (!Array.isArray(eintraege)) return eintraege;
  const regel = new Set(r.regelpfade || []);
  if (!regel.size && !(r.bereiche || []).length) return eintraege;
  return eintraege.map((e) => {
    if (!e || e.art !== 'ordner') return e;
    const voll = rel ? `${rel}/${e.name}` : e.name;
    const stufe = stufeAn(r.bereiche, voll);
    const aus = { ...e };
    if (stufe === 'keiner') aus.gesperrt = true;
    else if (stufe === 'lesen') aus.nur_lesen = true;
    if (regel.has(voll)) aus.ordnerrecht = true;
    return aus;
  });
}

/** shares.json einer Freigabe ändern: fn(liste) → neue Regelliste oder null (nichts geändert). */
async function regelnAendern(w, name, fn) {
  let anders = false;
  try {
    await w.konfig.aendern('shares.json', (roh) => {
      const f = (roh?.freigaben || []).find((x) => x.name === name);
      if (!f || !f.ordnerrechte) return UNVERAENDERT;
      const neu = fn(f.ordnerrechte);
      if (!neu) return UNVERAENDERT;
      if (neu.length) f.ordnerrechte = neu; else delete f.ordnerrechte;
      anders = true;
      return roh;
    });
  } catch (e) { process.stderr.write(`[dateien] Ordnerrechte nachführen (${name}): ${e.message}\n`); }
  if (anders) w.konfigGeaendert?.('freigaben');
}

/** Umbenannt/verschoben (innerhalb der Freigabe): Regelpfade wandern mit (die Rechte auf der Platte tun es ohnehin). */
async function ordnerrechteNachziehen(w, name, paare) {
  const echte = (paare || []).filter((x) => x && x.von && x.nach && x.von !== x.nach);
  if (!echte.length) return;
  await regelnAendern(w, name, (liste) => {
    let aktuell = liste; let anders = false;
    for (const { von, nach } of echte) { const neu = regelnUmziehen(aktuell, von, nach); if (neu) { aktuell = neu; anders = true; } }
    return anders ? aktuell : null;
  });
}

/** Gelöscht oder in eine andere Freigabe verschoben: Regeln darunter fallen weg. */
async function ordnerrechteEntfernen(w, name, pfade) {
  const echte = (pfade || []).filter(Boolean);
  if (echte.length) await regelnAendern(w, name, (liste) => regelnOhne(liste, echte));
}

/** Nach Verschieben/Kopieren/Zurückholen in einen eingeschränkten Bereich: dort die Rechte angleichen (Hintergrund). */
export async function ordnerrechteAngleichenUm(w, name, pfade) {
  try {
    const shares = await w.konfig.laden('shares.json');
    const f = (shares?.freigaben || []).find((x) => x.name === name);
    const regeln = f && !f.extern ? regelnNormieren(f.ordnerrechte) : [];
    if (!regeln.some((r) => pfade.some((q) => unter(q, r.pfad) || unter(r.pfad, q)))) return;
    await w.intern('freigaben.ordnerrechte.apply', { freigabe: name, pfade });
  } catch (e) { process.stderr.write(`[dateien] Ordnerrechte angleichen (${name}): ${e && e.message}\n`); }
}

/** Wie freigabeRechte, wirft aber E_RECHTE, wenn das nötige Recht fehlt. */
export async function freigabeHolen(werkzeuge, name, kontext, schreiben = false) {
  const r = await freigabeRechte(werkzeuge, name, kontext);
  if (!r.lesen) throw new FahnasFehler('E_RECHTE', `Du hast keinen Zugriff auf die Freigabe „${name}“`, { freigabe: name });
  if (schreiben && !r.schreiben) throw new FahnasFehler('E_RECHTE', `Du darfst in der Freigabe „${name}“ nicht schreiben`, { freigabe: name });
  return r;
}

/** Vorprüfung im Agenten: relativer Pfad, Papierkorb gesperrt, Symlink-Flucht. Der Helfer prüft als Nutzer erneut. */
export async function pfadVorpruefen(wurzel, p, feld = 'pfad') {
  const rel = relativerPfad(p);
  if (rel.split('/')[0] === PAPIERKORB) throw new FahnasFehler('E_RECHTE', 'Der Papierkorb ist nur über die Papierkorb-Funktionen erreichbar', { feld });
  const abs = await sicherAufloesen(wurzel, rel);
  return { rel, abs };
}

// ---------------------------------------------------------------------------------------------------------------
// Helfer-Aufruf (als Nutzer)
// ---------------------------------------------------------------------------------------------------------------
function ergebnisAuswerten({ stdout, stderr, code }, op) {
  let letzte = null;
  for (const z of String(stdout || '').split('\n')) {
    if (!z.trim()) continue;
    try { const o = JSON.parse(z); if (o.ok !== undefined || o.fehler) letzte = o; } catch { /* keine JSON-Zeile */ }
  }
  if (!letzte) {
    throw new FahnasFehler('E_SYSTEM', 'Der Dateihelfer lieferte kein Ergebnis', { befehl: `dateihelfer ${op}`, code, ausgabe: String(stderr || '').slice(0, 2000) });
  }
  if (letzte.fehler) throw new FahnasFehler(letzte.fehler.code, letzte.fehler.meldung, letzte.fehler.details);
  return letzte.ergebnis;
}

// ---------------------------------------------------------------------------------------------------------------
// Ordnergrößen-Zwischenspeicher (Betreiber 19.10.2026: „Überordner zeigt 0 B, wenn darin nur ein Unterordner mit Dateien
// liegt“ – beim Ordner-Upload lud die Liste nach dem ersten Eintrag neu, die 0 B des noch leeren Ordners blieben 2 min
// stehen). Jetzt: nur teure Läufe (≥ 1 s) werden gemerkt, und jede schreibende Helfer-Operation in einer Freigabe
// vergisst deren Werte und zählt ihren Stand hoch – ein Lauf, der über eine Änderung hinweg rechnete, wird nicht gemerkt.
// ---------------------------------------------------------------------------------------------------------------
const groessenCache = new Map(); // nutzer\0wurzel\0rel → {zeit, wert}
const groessenStand = new Map(); // wurzel → Zähler
export const GROESSE_MERKEN_AB_MS = 1000;
const LESE_OPS = new Set(['liste', 'ordnergroesse', 'info', 'vorhanden', 'papierkorb_liste', 'snapshot_liste', 'snapshot_info', 'office_lesen', 'pruefe_schreiben']);

/** Gemerkte Ordnergrößen dieser Freigaben verwerfen (nach jeder Änderung darin). */
export function ordnergroessenVeraltet(...wurzeln) {
  for (const w of wurzeln) {
    if (!w) continue;
    groessenStand.set(w, (groessenStand.get(w) || 0) + 1);
    for (const k of [...groessenCache.keys()]) if (k.split('\u0000')[1] === w) groessenCache.delete(k);
  }
}

/** Kurze Operation: Helfer über system.ausfuehren (gepuffert), eine Ergebniszeile. */
export async function helfer(werkzeuge, kontext, op, params, optionen = {}) {
  const { uid, gid, gruppen } = await idsFuer(werkzeuge, kontext, params?.wurzel, params?.ziel_wurzel);
  try {
    const r = await werkzeuge.system.ausfuehren(process.execPath, [HELFER_PFAD, op], {
      uid, gid, gruppen, eingabe: JSON.stringify({ op, params }) + '\n', erlaubteCodes: [0, 1, 2], ...optionen,
    });
    return ergebnisAuswerten(r, op);
  } finally {
    if (!LESE_OPS.has(op)) ordnergroessenVeraltet(params?.wurzel, params?.ziel_wurzel);
  }
}

/** Lange Operation: Helfer über system.starten, Fortschrittszeilen laufen live in die Aufgabe, Abbruch per SIGTERM. */
export async function helferStrom(werkzeuge, kontext, op, params, aufgabe) {
  const { uid, gid, gruppen } = await idsFuer(werkzeuge, kontext, params?.wurzel, params?.ziel_wurzel);
  const kind = werkzeuge.system.starten(process.execPath, [HELFER_PFAD, op], { uid, gid, gruppen, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((ok, nein) => {
    let puffer = ''; let ergebnis = null; let stderr = ''; let abgebrochen = false; let hart = null;
    const verarbeite = (zeile) => {
      let o; try { o = JSON.parse(zeile); } catch { return; }
      if (o.fortschritt !== undefined && aufgabe) aufgabe.fortschritt(o.fortschritt, o.meldung);
      if (o.ok !== undefined || o.fehler) ergebnis = o;
    };
    kind.stdout.setEncoding('utf8');
    kind.stdout.on('data', (d) => {
      puffer += d;
      let i;
      while ((i = puffer.indexOf('\n')) >= 0) { const z = puffer.slice(0, i); puffer = puffer.slice(i + 1); if (z.trim()) verarbeite(z); }
    });
    kind.stderr.setEncoding('utf8');
    kind.stderr.on('data', (d) => { stderr += d; });
    const waechter = setInterval(() => {
      if (!abgebrochen && aufgabe && aufgabe.abgebrochen()) {
        abgebrochen = true; kind.kill('SIGTERM');
        hart = setTimeout(() => { try { kind.kill('SIGKILL'); } catch { /* schon weg */ } }, ABBRUCH_HART_MS); hart.unref();
      }
    }, 500);
    waechter.unref();
    const aufraeumen = () => { clearInterval(waechter); if (hart) clearTimeout(hart); };
    kind.on('error', (e) => { aufraeumen(); nein(new FahnasFehler('E_SYSTEM', 'Der Dateihelfer konnte nicht gestartet werden', { befehl: `dateihelfer ${op}`, ausgabe: e.message })); });
    kind.on('close', (code) => {
      aufraeumen();
      if (puffer.trim()) verarbeite(puffer);
      if (abgebrochen && !(ergebnis && ergebnis.ok)) return nein(new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen'));
      if (!LESE_OPS.has(op)) ordnergroessenVeraltet(params?.wurzel, params?.ziel_wurzel);
      try { ok(ergebnisAuswerten({ stdout: ergebnis ? JSON.stringify(ergebnis) : '', stderr, code }, op)); } catch (e) { nein(e); }
    });
    kind.stdin.on('error', () => { /* Helfer schon weg – close liefert den Fehler */ });
    kind.stdin.end(JSON.stringify({ op, params }) + '\n');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Platz und Kontingent
// ---------------------------------------------------------------------------------------------------------------
/** Belegung des Dateisystems unter `pfad` per df (ersetzbar). */
export async function plattenPlatz(system, pfad) {
  const { stdout } = await system.ausfuehren('df', ['-B1', '--output=size,avail', '--', pfad]);
  const zeilen = String(stdout).trim().split('\n');
  const t = zeilen[zeilen.length - 1].trim().split(/\s+/);
  const gesamt = Number(t[0]); const frei = Number(t[1]);
  if (!Number.isFinite(gesamt) || !Number.isFinite(frei) || gesamt <= 0) {
    throw new FahnasFehler('E_SYSTEM', 'Die Ausgabe von df war unverständlich', { befehl: 'df', ausgabe: String(stdout).slice(0, 500) });
  }
  return { gesamt, frei, prozent: Math.round(((gesamt - frei) / gesamt) * 100) };
}

/** Freier Platz laut btrfs-Kontingent (qgroup) der Freigabe; null, wenn kein Kontingent gesetzt oder Quoten aus. */
export async function kontingentFrei(system, wurzel) {
  try {
    const { stdout } = await system.ausfuehren('btrfs', ['qgroup', 'show', '-reF', '--raw', '--', wurzel]);
    const zeilen = String(stdout).split('\n').map((z) => z.trim()).filter((z) => /^\d+\/\d+\s/.test(z));
    if (!zeilen.length) return null;
    const t = zeilen[zeilen.length - 1].split(/\s+/); // qgroupid rfer excl max_rfer max_excl
    const rfer = Number(t[1]); const max = Number(t[3]);
    if (!Number.isFinite(rfer) || !Number.isFinite(max) || t[3] === 'none') return null;
    return Math.max(0, max - rfer);
  } catch { return null; }
}

export async function freierPlatz(system, wurzel, freigabe) {
  const df = await plattenPlatz(system, wurzel);
  let frei = df.frei;
  if (freigabe && freigabe.groesse_gb) {
    const k = await kontingentFrei(system, wurzel);
    if (k !== null) frei = Math.min(frei, k);
  }
  return frei;
}

// ---------------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------------
/** Nur die gültigen Links (abgelaufene fliegen raus). `ablauf: null` = dauerhaft, bis der Link gelöscht wird. */
export function linksGueltig(roh, jetzt = Date.now()) {
  const liste = Array.isArray(roh) ? roh : [];
  return liste.filter((l) => l && typeof l.token === 'string' && (l.ablauf === null || Date.parse(l.ablauf) > jetzt));
}

/**
 * Lesen-Ändern-Schreiben von links.json unter der Sperre der Datei (0600 laut MODUS-Tabelle). `fn(liste)` bekommt die
 * gültigen Links, verändert die Liste in place und liefert das Ergebnis; UNVERAENDERT von fn = nichts schreiben.
 */
async function linksAendern(werkzeuge, fn) {
  let ergebnis;
  await werkzeuge.konfig.aendern(LINKS_DATEI, async (roh) => {
    const liste = linksGueltig(roh);
    const abgelaufen = (Array.isArray(roh) ? roh.length : 0) !== liste.length;
    const r = await fn(liste);
    if (r === UNVERAENDERT && !abgelaufen) return UNVERAENDERT;
    ergebnis = r === UNVERAENDERT ? undefined : r;
    return liste;
  }, []);
  return ergebnis;
}

/** Umbenannter Nutzer: seine Freigabelinks gehören dem neuen Namen (sie werden als Ersteller eingelöst). */
export function linksNutzerUmbenennen(werkzeuge, alt, neu) {
  return linksAendern(werkzeuge, (liste) => {
    let n = 0;
    for (const l of liste) if (l.nutzer === alt) { l.nutzer = neu; n++; }
    return n ? n : UNVERAENDERT;
  });
}

/** Nur lesen (Ablauf prüfen, abgelaufene bei Gelegenheit entfernen – unter der Sperre, ohne Lost Update). */
async function linksLaden(werkzeuge) {
  const roh = await werkzeuge.konfig.laden(LINKS_DATEI, []);
  const gueltig = linksGueltig(roh);
  if (gueltig.length !== (Array.isArray(roh) ? roh.length : 0)) await linksAendern(werkzeuge, () => UNVERAENDERT);
  return gueltig;
}

/** Anzeigename des Linkziels: letzter Teil des Pfads, bei der ganzen Freigabe deren Name. */
function linkName(l) { return l.pfad ? path.posix.basename(l.pfad) : l.freigabe; }

function linkAnsicht(l) { return { token: l.token, url: `/link/${l.token}`, freigabe: l.freigabe, pfad: l.pfad, name: linkName(l), dateiname: l.dateiname, art: l.art, nutzer: l.nutzer, erstellt: l.erstellt, ablauf: l.ablauf ?? null }; }

/**
 * Link einlösen (ohne Sitzung): gültiger Link + Kontext und Rechte des Erstellers. Unbekannt/abgelaufen → E_NICHT_GEFUNDEN
 * mit `details.link = 'ungueltig'` (der Web-Dienst zählt das für die Bremse gegen Durchprobieren).
 */
async function linkEinloesen(w, token) {
  const l = (await linksLaden(w)).find((x) => x.token === token);
  if (!l) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieser Link ist ungültig oder abgelaufen', { link: 'ungueltig' });
  const users = await w.konfig.laden('users.json');
  const n = (users?.nutzer || []).find((x) => x.name === l.nutzer);
  if (!n || n.gesperrt) throw new FahnasFehler('E_RECHTE', 'Der Ersteller des Links ist nicht mehr berechtigt');
  const kontext = { nutzer: n.name, rolle: n.rolle === 'admin' ? 'admin' : 'nutzer', ip: '-' };
  const r = await freigabeHolen(w, l.freigabe, kontext);
  return { l, kontext, r };
}

/**
 * Pfad innerhalb eines Links (relativ zum geteilten Ordner): keine versteckten Teile, nicht aus dem geteilten Ordner
 * hinaus – auch nicht über Verknüpfungen, die innerhalb der Freigabe woandershin zeigen. Bei Datei-Links nur „“.
 */
async function linkPfad(r, l, unter) {
  const sub = relativerPfad(unter || '');
  if (sub && l.art !== 'ordner') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
  if (sub.split('/').some((t) => t.startsWith('.'))) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
  const { abs: linkWurzel } = await pfadVorpruefen(r.wurzel, l.pfad);
  if (sub) await sicherAufloesen(linkWurzel, sub);
  const rel = [l.pfad, sub].filter(Boolean).join('/');
  await pfadVorpruefen(r.wurzel, rel);
  ordnerZugriff(r, rel); // Ordnerrechte des Erstellers gelten auch für seine Links
  return { sub, rel };
}

function elternVon(sub) { return sub ? (sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '') : null; }

async function besitzerName(werkzeuge, uid) {
  const users = await werkzeuge.konfig.laden('users.json');
  const n = (users?.nutzer || []).find((x) => Number(x.uid) === Number(uid));
  return n ? n.name : (uid === 0 ? 'root' : `uid ${uid}`);
}

/** Ticket zum Lesen (Datei) oder Zippen (Ordner) für einen bereits berechtigten Pfad. */
async function leseTicket(werkzeuge, kontext, r, rel, artWunsch) {
  const { abs } = await pfadVorpruefen(r.wurzel, rel);
  const ids = await idsFuer(werkzeuge, kontext, r.wurzel);
  const info = await helfer(werkzeuge, kontext, 'info', { wurzel: r.wurzel, pfad: rel });
  const art = artWunsch || (info.art === 'ordner' ? 'zip' : 'lesen');
  if (art === 'lesen' && info.art !== 'datei') throw new FahnasFehler('E_PARAMS', 'Zum Herunterladen muss der Pfad eine Datei sein (Ordner: art „zip“)', { feld: 'pfad' });
  if (art === 'zip' && info.art !== 'ordner') throw new FahnasFehler('E_PARAMS', 'Als ZIP lässt sich nur ein Ordner herunterladen', { feld: 'pfad' });
  if (art === 'zip') {
    const name = (rel ? path.basename(rel) : r.freigabe.name) + '.zip';
    return werkzeuge.datenkanal.ticket({ nutzer: kontext.nutzer, uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen, art: 'zip', pfad: abs, dateiname: name, mime: 'application/zip' });
  }
  return werkzeuge.datenkanal.ticket({ nutzer: kontext.nutzer, uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen, art: 'lesen', pfad: abs, dateiname: info.name, groesse: info.groesse, mime: info.mime });
}

// ---------------------------------------------------------------------------------------------------------------
// Vorschaubilder
// ---------------------------------------------------------------------------------------------------------------
const VORSCHAU_MUSTER = Object.freeze({
  bild: /\.(png|jpe?g|jpe|gif|webp|bmp|avif|tiff?|heic|heif|jxl|dng|cr2|nef|arw)$/i,
  video: /\.(mp4|m4v|webm|mov|ogv|mkv|avi|mts|m2ts|ts|wmv|flv|3gp|mpe?g)$/i,
});

/** Art eines Pfads für das Vorschaubild anhand der Endung: 'bild' | 'video' | null (keine Vorschau). */
export function vorschauArt(rel) {
  const name = path.basename(String(rel || ''));
  if (VORSCHAU_MUSTER.bild.test(name)) return 'bild';
  if (VORSCHAU_MUSTER.video.test(name)) return 'video';
  return null;
}

let vorschau = null;
/** Vorschau-Instanz: aus den Werkzeugen (Tests) oder einmalig aus den Pfaden gebaut. */
export function vorschauFuer(w) {
  if (w.vorschau) return w.vorschau;
  if (!vorschau) vorschau = new Vorschau({ system: w.system, ordner: pfadeVon(w).vorschau || PFADE.vorschau });
  return vorschau;
}

/** Start-Haken des Agenten: Zwischenspeicher anlegen, ffmpeg prüfen/nachinstallieren, Aufräumen planen. */
export async function starten(w) { await vorschauFuer(w).starten(); }
export async function stoppen() { if (vorschau) vorschau.stoppen(); }

// ---------------------------------------------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------------------------------------------
const S_SORT = { typ: 'string', werte: ['name', 'groesse', 'geaendert', 'art'] };
const S_PFADLISTE = { typ: 'array', pflicht: true, max: 1000, elemente: { typ: 'string', max: 4096 } };
const S_TOKEN = { typ: 'string', pflicht: true, min: 16, max: 128, muster: /^[A-Za-z0-9_-]+$/, hinweis: 'Token ungültig' };

export function registriere(reg) {
  reg.aktion('dateien.liste', {
    rolle: 'nutzer', beschreibung: 'Ordnerinhalt einer Freigabe',
    schema: { freigabe: R.freigabename, pfad: R.pfad, sortierung: S_SORT, absteigend: R.ja_nein, versteckte: R.ja_nein },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      const aus = await helfer(w, k, 'liste', { wurzel: r.wurzel, pfad: rel, sortierung: p.sortierung, absteigend: !!p.absteigend, versteckte: !!p.versteckte });
      const hier = stufeAn(r.bereiche, rel);
      return {
        ...aus, eintraege: ordnerrechteMarkieren(aus.eintraege, r, rel), freigabe: p.freigabe,
        schreiben: r.schreiben && hier !== 'lesen', nur_lesen_ordner: hier === 'lesen', papierkorb: r.freigabe.papierkorb !== false,
      };
    },
  });

  // Ordnergröße für die Spalte „Größe“ der Dateiliste; teure Läufe kurz zwischengespeichert (siehe groessenCache)
  reg.aktion('dateien.ordnergroesse', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Größe eines Ordners samt Unterordnern (für die Dateiliste)', // lesend: je Ordnerzeile ein Aufruf
    schema: { freigabe: R.freigabename, pfad: R.pfad },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      const schluessel = `${k.nutzer}\u0000${r.wurzel}\u0000${rel}`;
      const jetzt = Date.now();
      const alt = groessenCache.get(schluessel);
      if (alt && jetzt - alt.zeit < 120_000) return alt.wert;
      const stand = groessenStand.get(r.wurzel) || 0;
      const wert = await helfer(w, k, 'ordnergroesse', { wurzel: r.wurzel, pfad: rel, zeitlimit_ms: 20_000 }, { zeitlimit_ms: 40_000 });
      if (Date.now() - jetzt >= GROESSE_MERKEN_AB_MS && (groessenStand.get(r.wurzel) || 0) === stand) {
        if (groessenCache.size > 2000) groessenCache.clear();
        groessenCache.set(schluessel, { zeit: jetzt, wert });
      }
      return wert;
    },
  });

  reg.aktion('dateien.ordner', {
    rolle: 'nutzer', beschreibung: 'Ordner anlegen',
    schema: { freigabe: R.freigabename, pfad: R.pfad, name: { typ: 'string', pflicht: true, max: 255 } },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel, true);
      return helfer(w, k, 'ordner', { wurzel: r.wurzel, pfad: rel, name: p.name });
    },
  });

  reg.aktion('dateien.umbenennen', {
    rolle: 'nutzer', beschreibung: 'Datei oder Ordner umbenennen',
    schema: { freigabe: R.freigabename, pfad: { typ: 'string', pflicht: true, max: 4096 }, neuer_name: { typ: 'string', pflicht: true, max: 255 } },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel, true);
      const aus = await helfer(w, k, 'umbenennen', { wurzel: r.wurzel, pfad: rel, neuer_name: p.neuer_name });
      await nachfuehren(w, { art: 'umbenannt', freigabe: p.freigabe, von: rel, nach: aus.pfad });
      await ordnerrechteNachziehen(w, p.freigabe, [{ von: rel, nach: aus.pfad }]);
      return aus;
    },
  });

  reg.aktion('dateien.umbenennen_serie', {
    rolle: 'nutzer', beschreibung: 'Mehrere Einträge eines Ordners fortlaufend umbenennen: „Name (01).endung“, „Name (02).endung“ …',
    schema: {
      freigabe: R.freigabename, pfad: R.pfad, basis: { typ: 'string', pflicht: true, max: 200 },
      namen: { typ: 'array', pflicht: true, max: 1000, elemente: { typ: 'string', max: 255 } },
    },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      const voll = (n) => (rel ? `${rel}/${n}` : n);
      for (const n of p.namen) ordnerZugriff(r, voll(n), true, 'namen');
      const aus = await helfer(w, k, 'umbenennen_serie', { wurzel: r.wurzel, pfad: rel, namen: p.namen, basis: p.basis });
      const paare = (aus.umbenannt || []).map((z) => ({ von: voll(z.alt), nach: voll(z.neu) }));
      await nachfuehren(w, { art: 'verschoben', freigabe: p.freigabe, nach_freigabe: p.freigabe, paare });
      await ordnerrechteNachziehen(w, p.freigabe, paare);
      return aus;
    },
  });

  const uebertragung = (op, quelleSchreiben) => async (p, k, w, aufgabe) => {
    const quelle = await freigabeHolen(w, p.freigabe, k, quelleSchreiben);
    const ziel = await freigabeHolen(w, p.ziel_freigabe, k, true);
    const quellen = [];
    for (const q of p.quellen) quellen.push((await pfadVorpruefen(quelle.wurzel, q, 'quellen')).rel);
    for (const q of quellen) ordnerZugriff(quelle, q, quelleSchreiben, 'quellen');
    const { rel: zielRel } = await pfadVorpruefen(ziel.wurzel, p.ziel_pfad, 'ziel_pfad');
    ordnerZugriff(ziel, zielRel, true, 'ziel_pfad');
    aufgabe.fortschritt(0, op === 'kopieren' ? 'Kopieren beginnt' : 'Verschieben beginnt');
    const aus = await helferStrom(w, k, op, {
      wurzel: quelle.wurzel, quellen, ziel_wurzel: ziel.wurzel, ziel_pfad: zielRel, ueberschreiben: !!p.ueberschreiben,
      ersetzen: p.ersetzen || [], beide: p.beide || [], papierkorb: ziel.freigabe.papierkorb !== false, nutzer: k.nutzer,
    }, aufgabe);
    if (op === 'verschieben') {
      await nachfuehren(w, { art: 'verschoben', freigabe: p.freigabe, nach_freigabe: p.ziel_freigabe, paare: aus.uebertragen });
      if (p.freigabe === p.ziel_freigabe) await ordnerrechteNachziehen(w, p.freigabe, aus.uebertragen || []);
      else await ordnerrechteEntfernen(w, p.freigabe, (aus.uebertragen || []).map((x) => x.von));
    }
    // Verschobenes behält seine alten Rechte – liegt das Ziel in einem eingeschränkten Bereich, dort angleichen
    await ordnerrechteAngleichenUm(w, p.ziel_freigabe, [zielRel]);
    return { ...aus, anzahl: aus.uebertragen.length, freigabe: p.freigabe, ziel_freigabe: p.ziel_freigabe };
  };
  // ersetzen/beide: Namen (wie am Ziel), für die der Nutzer bei einem Konflikt „Ersetzen“ bzw. „Beide behalten“ gewählt hat
  const S_NAMEN = { typ: 'array', max: 1000, elemente: { typ: 'string', max: 255 } };
  const S_UEBERTRAGUNG = { freigabe: R.freigabename, quellen: S_PFADLISTE, ziel_freigabe: R.freigabename, ziel_pfad: R.pfad, ueberschreiben: R.ja_nein, ersetzen: S_NAMEN, beide: S_NAMEN };
  reg.aktion('dateien.verschieben', { rolle: 'nutzer', aufgabe: true, beschreibung: 'Dateien/Ordner verschieben (auch in eine andere Freigabe)', schema: S_UEBERTRAGUNG, ausfuehren: uebertragung('verschieben', true) });
  reg.aktion('dateien.kopieren', { rolle: 'nutzer', aufgabe: true, beschreibung: 'Dateien/Ordner kopieren (auch in eine andere Freigabe)', schema: S_UEBERTRAGUNG, ausfuehren: uebertragung('kopieren', false) });

  reg.aktion('dateien.loeschen', {
    rolle: 'nutzer', beschreibung: 'In den Papierkorb legen oder endgültig löschen',
    schema: { freigabe: R.freigabename, pfade: S_PFADLISTE, endgueltig: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const pfade = [];
      for (const q of p.pfade) pfade.push((await pfadVorpruefen(r.wurzel, q, 'pfade')).rel);
      for (const q of pfade) ordnerZugriff(r, q, true, 'pfade');
      const endgueltig = !!p.endgueltig || r.freigabe.papierkorb === false;
      const aus = await helfer(w, k, 'loeschen', { wurzel: r.wurzel, pfade, endgueltig, nutzer: k.nutzer }, { zeitlimit_ms: 0 });
      await nachfuehren(w, { art: 'geloescht', freigabe: p.freigabe, pfade, endgueltig: typeof aus.endgueltig === 'boolean' ? aus.endgueltig : endgueltig });
      await ordnerrechteEntfernen(w, p.freigabe, pfade);
      return aus;
    },
  });

  reg.aktion('dateien.papierkorb.liste', {
    rolle: 'nutzer', beschreibung: 'Inhalt des Papierkorbs (eigener und Samba-Papierkorb)',
    schema: { freigabe: R.freigabename },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      return helfer(w, k, 'papierkorb_liste', { wurzel: r.wurzel });
    },
  });

  reg.aktion('dateien.papierkorb.wiederherstellen', {
    rolle: 'nutzer', beschreibung: 'Einträge aus dem Papierkorb an den ursprünglichen Ort zurücklegen',
    schema: {
      freigabe: R.freigabename,
      eintraege: { typ: 'array', pflicht: true, max: 500, elemente: { typ: 'object', felder: { id: { typ: 'string', pflicht: true, max: 255 }, pfad: { typ: 'string', max: 4096 } } } },
    },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const aus = await helfer(w, k, 'papierkorb_wiederherstellen', { wurzel: r.wurzel, eintraege: p.eintraege }, { zeitlimit_ms: 0 });
      await nachfuehren(w, { art: 'wiederhergestellt', freigabe: p.freigabe, pfade: aus.wiederhergestellt || [], umbenannt: aus.umbenannt || [] });
      return aus;
    },
  });

  reg.aktion('dateien.papierkorb.leeren', {
    rolle: 'nutzer', beschreibung: 'Papierkorb der Freigabe endgültig leeren',
    schema: { freigabe: R.freigabename },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const aus = await helfer(w, k, 'papierkorb_leeren', { wurzel: r.wurzel }, { zeitlimit_ms: 0 });
      await nachfuehren(w, { art: 'korb_geleert', freigabe: p.freigabe });
      return aus;
    },
  });

  reg.aktion('dateien.info', {
    rolle: 'nutzer', beschreibung: 'Eigenschaften einer Datei oder eines Ordners',
    schema: { freigabe: R.freigabename, pfad: R.pfad },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      const info = await helfer(w, k, 'info', { wurzel: r.wurzel, pfad: rel });
      const besitzer = info.besitzer && typeof info.besitzer.uid === 'number' ? await besitzerName(w, info.besitzer.uid) : String(info.besitzer);
      if (rel === '') info.name = p.freigabe;
      // vollständiger Pfad auf dem NAS (Betreiber 12.10.2026: zum Eintragen in Apps, Spiegelung, VMs …)
      return { ...info, besitzer, freigabe: p.freigabe, pfad_voll: rel ? `${String(r.wurzel).replace(/\/+$/, '')}/${rel}` : String(r.wurzel) };
    },
  });

  // Texteditor (Plan 01): Textdatei atomar als der Nutzer speichern; erwartet = Stand beim Öffnen (sonst E_GEAENDERT),
  // neu = exklusiv anlegen (Kopie bei Konflikt). Der Inhalt kommt nie ins Prüfprotokoll.
  reg.aktion('dateien.text.speichern', {
    rolle: 'nutzer', beschreibung: 'Textdatei aus dem Editor speichern (atomar, mit Konfliktprüfung)',
    audit: (p) => ({ freigabe: p.freigabe, pfad: p.pfad, neu: p.neu }),
    schema: {
      freigabe: R.freigabename, pfad: { typ: 'string', pflicht: true, max: 4096 },
      inhalt: { typ: 'string', max: TEXT_MAX_BYTES, standard: '' },
      erwartet: { typ: 'object', felder: { geaendert: { typ: 'string', pflicht: true, max: 40 }, groesse: { typ: 'integer', pflicht: true, min: 0 } } },
      neu: { typ: 'boolean', standard: false },
    },
    ausfuehren: async (p, k, w) => {
      if (Buffer.byteLength(p.inhalt, 'utf8') > TEXT_MAX_BYTES) throw new FahnasFehler('E_PARAMS', 'Die Datei wäre größer als 2 MiB', { feld: 'inhalt', max: TEXT_MAX_BYTES });
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      if (rel === '') throw new FahnasFehler('E_PARAMS', 'Dateiname fehlt', { feld: 'pfad' });
      ordnerZugriff(r, rel, true);
      return helfer(w, k, 'text_schreiben', { wurzel: r.wurzel, pfad: rel, inhalt: p.inhalt, erwartet: p.erwartet ?? null, neu: p.neu });
    },
  });

  reg.aktion('dateien.vorschau', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Vorschaubild einer Bild- oder Videodatei (WebP/JPEG, base64) für die Kachelansicht', // lesend: jede Kachel fragt – kein Eintrag je Abruf im Prüfprotokoll
    schema: { freigabe: R.freigabename, pfad: { typ: 'string', pflicht: true, max: 4096 }, groesse: { typ: 'integer', werte: [...VORSCHAU_GROESSEN], standard: VORSCHAU_STANDARD } },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      const { rel, abs } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      const art = vorschauArt(rel);
      if (!art) throw new FahnasFehler('E_PARAMS', 'Für diese Dateiart gibt es kein Vorschaubild', { feld: 'pfad' });
      const ids = await idsFuer(w, k, r.wurzel);
      const v = await vorschauFuer(w).holen({ abs, groesse: p.groesse || VORSCHAU_STANDARD, art, ids: { uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen || [] } });
      return { mime: v.mime, daten: v.daten.toString('base64'), groesse: p.groesse || VORSCHAU_STANDARD, aus_cache: v.ausCache };
    },
  });

  reg.aktion('dateien.ticket', {
    rolle: 'nutzer', beschreibung: 'Ticket für den Datenkanal (herunterladen, hochladen, ZIP)',
    schema: {
      freigabe: R.freigabename, pfad: R.pfad, art: { typ: 'string', pflicht: true, werte: ['lesen', 'schreiben', 'zip'] }, groesse: { typ: 'integer', min: 0 },
      bei_vorhanden: { typ: 'string', werte: BEI_VORHANDEN, standard: 'fehler' },
    },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k, p.art === 'schreiben');
      const rel = relativerPfad(p.pfad);
      ordnerZugriff(r, rel, p.art === 'schreiben');
      if (p.art !== 'schreiben') return leseTicket(w, k, r, rel, p.art);
      await pfadVorpruefen(r.wurzel, rel);
      const ids = await idsFuer(w, k, r.wurzel);
      const beiVorhanden = p.bei_vorhanden || 'fehler';
      const ziel = await helfer(w, k, 'pruefe_schreiben', { wurzel: r.wurzel, pfad: rel, bei_vorhanden: beiVorhanden });
      const frei = await freierPlatz(w.system, r.wurzel, r.freigabe);
      if (p.groesse !== undefined && frei !== null && p.groesse > frei) {
        throw new FahnasFehler('E_PLATZ', 'Nicht genug freier Platz in der Freigabe', { noetig: p.groesse, frei });
      }
      // Der Datenkanal schreibt in die Zwischendatei; erst danach legt der Helfer (als Nutzer) sie ab bzw. verwirft sie.
      const abschluss = (erfolg) => (erfolg
        ? helfer(w, k, 'upload_abschliessen', { wurzel: r.wurzel, pfad: rel, tmp: ziel.tmp, bei_vorhanden: beiVorhanden, papierkorb: r.freigabe.papierkorb !== false, nutzer: k.nutzer }, { zeitlimit_ms: 0 })
        : helfer(w, k, 'upload_verwerfen', { wurzel: r.wurzel, pfad: rel, tmp: ziel.tmp }));
      return w.datenkanal.ticket({ nutzer: k.nutzer, uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen, art: 'schreiben', pfad: ziel.tmp, dateiname: ziel.dateiname, groesse: p.groesse, mime: ziel.mime, abschluss });
    },
  });

  reg.aktion('dateien.vorhanden', {
    rolle: 'nutzer', beschreibung: 'Welche Namen gibt es im Ordner schon? (Rückfrage vor Hochladen/Kopieren/Verschieben)',
    schema: { freigabe: R.freigabename, pfad: R.pfad, namen: S_PFADLISTE },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      return helfer(w, k, 'vorhanden', { wurzel: r.wurzel, pfad: rel, namen: p.namen }, { zeitlimit_ms: 0 });
    },
  });

  reg.aktion('dateien.link.anlegen', {
    rolle: 'nutzer', beschreibung: 'Freigabelink erzeugen (gueltig_h 0 = dauerhaft, bis er gelöscht wird)',
    schema: { freigabe: R.freigabename, pfad: R.pfad, gueltig_h: { typ: 'integer', pflicht: true, min: 0, max: 8760 } },
    ausfuehren: async (p, k, w) => {
      const r = await freigabeHolen(w, p.freigabe, k);
      if (r.freigabe.system) throw new FahnasFehler('E_RECHTE', 'Aus dem App-Ordner gibt es keine Download-Links – dort liegen Zugangsdaten der Apps', { feld: 'freigabe' });
      const { rel } = await pfadVorpruefen(r.wurzel, p.pfad);
      ordnerZugriff(r, rel);
      const info = await helfer(w, k, 'info', { wurzel: r.wurzel, pfad: rel });
      if (info.art !== 'datei' && info.art !== 'ordner') throw new FahnasFehler('E_PARAMS', 'Links gibt es nur für Dateien und Ordner', { feld: 'pfad' });
      const jetzt = new Date();
      const link = {
        token: crypto.randomBytes(32).toString('base64url'), freigabe: p.freigabe, pfad: rel, nutzer: k.nutzer,
        dateiname: info.art === 'ordner' ? `${rel ? info.name : p.freigabe}.zip` : info.name, art: info.art,
        erstellt: jetzt.toISOString(), ablauf: p.gueltig_h === 0 ? null : new Date(jetzt.getTime() + p.gueltig_h * 3_600_000).toISOString(),
      };
      await linksAendern(w, (liste) => { liste.push(link); return true; });
      return linkAnsicht(link);
    },
  });

  reg.aktion('dateien.link.liste', {
    rolle: 'nutzer', beschreibung: 'Eigene Download-Links (admin: alle)',
    schema: {},
    ausfuehren: async (_p, k, w) => (await linksLaden(w)).filter((l) => k.rolle === 'admin' || l.nutzer === k.nutzer).map(linkAnsicht),
  });

  reg.aktion('dateien.link.loeschen', {
    rolle: 'nutzer', beschreibung: 'Download-Link zurückziehen',
    schema: { token: S_TOKEN },
    ausfuehren: async (p, k, w) => {
      await linksAendern(w, (liste) => {
        const i = liste.findIndex((x) => x.token === p.token);
        if (i < 0) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Link gibt es nicht (mehr)');
        if (k.rolle !== 'admin' && liste[i].nutzer !== k.nutzer) throw new FahnasFehler('E_RECHTE', 'Das ist nicht dein Link');
        liste.splice(i, 1);
        return true;
      });
      return { geloescht: true };
    },
  });

  // Rolle „gast“ statt „system“ (Vertrag §4): der Agent lehnt die Systemrolle über den Socket grundsätzlich ab, der
  // Web-Dienst ruft diese Aktion aber ohne Sitzung auf (GET /link/<token>?herunterladen=1). Der Token selbst ist das Geheimnis.
  reg.aktion('dateien.link.pruefen', {
    rolle: 'gast', beschreibung: 'Link einlösen: liefert ein Lese-Ticket im Namen des Link-Erstellers (für GET /link/<token>)',
    schema: { token: S_TOKEN },
    ausfuehren: async (p, _k, w) => {
      const { l, kontext, r } = await linkEinloesen(w, p.token);
      const art = l.art === 'ordner' ? 'zip' : 'lesen';
      const ticket = await leseTicket(w, kontext, r, l.pfad, art);
      return { ...ticket, art, freigabe: l.freigabe, pfad: l.pfad, nutzer: l.nutzer, ablauf: l.ablauf ?? null };
    },
  });

  // Öffentliche Linkseite (Betreiber 16.10.2026: „Freigabelink soll das Ziel öffnen und nicht als ZIP herunterladen“):
  // Ordner durchblättern, Dateien ansehen/herunterladen, Vorschaubilder, ZIP nur auf Wunsch – immer nur innerhalb des
  // geteilten Ziels und mit den Rechten des Erstellers. „lesend“: jede Kachel fragt ein Vorschaubild an – kein Eintrag je
  // Abruf im Prüfprotokoll; der Web-Dienst protokolliert Seitenaufrufe und Downloads selbst.
  reg.aktion('dateien.link.oeffnen', {
    rolle: 'gast', lesend: true, beschreibung: 'Freigabelink öffnen: Ordnerinhalt, Datei, ZIP oder Vorschaubild – nur innerhalb des geteilten Ziels',
    schema: {
      token: S_TOKEN, pfad: R.pfad, was: { typ: 'string', pflicht: true, werte: ['liste', 'lesen', 'zip', 'vorschau'] },
      groesse: { typ: 'integer', werte: [...VORSCHAU_GROESSEN], standard: VORSCHAU_STANDARD },
    },
    ausfuehren: async (p, _k, w) => {
      const { l, kontext, r } = await linkEinloesen(w, p.token);
      const { sub, rel } = await linkPfad(r, l, p.pfad);
      const kopf = { name: linkName(l), art_link: l.art, ablauf: l.ablauf ?? null, nutzer: l.nutzer };
      if (p.was === 'liste') {
        const info = await helfer(w, kontext, 'info', { wurzel: r.wurzel, pfad: rel });
        if (info.art === 'datei') {
          return { ...kopf, art: 'datei', pfad: sub, eltern: elternVon(sub), eintrag: { name: info.name, art: 'datei', groesse: info.groesse, geaendert: info.geaendert, mime: info.mime, vorschau: !!vorschauArt(rel) } };
        }
        if (info.art !== 'ordner') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Datei oder Ordner nicht gefunden', { feld: 'pfad' });
        const aus = await helfer(w, kontext, 'liste', { wurzel: r.wurzel, pfad: rel, sortierung: 'name', absteigend: false, versteckte: false });
        const eintraege = (aus.eintraege || []).filter((e) => (e.art === 'ordner' || e.art === 'datei') && stufeAn(r.bereiche, `${rel ? `${rel}/` : ''}${e.name}`) !== 'keiner')
          .map((e) => ({ name: e.name, art: e.art, groesse: e.groesse, geaendert: e.geaendert, mime: e.mime, vorschau: e.art === 'datei' && !!vorschauArt(e.name) }));
        return { ...kopf, art: 'ordner', pfad: sub, eltern: elternVon(sub), eintraege };
      }
      if (p.was === 'vorschau') {
        const art = vorschauArt(rel);
        if (!art) throw new FahnasFehler('E_PARAMS', 'Für diese Dateiart gibt es kein Vorschaubild', { feld: 'pfad' });
        const { abs } = await pfadVorpruefen(r.wurzel, rel);
        const ids = await idsFuer(w, kontext, r.wurzel);
        const v = await vorschauFuer(w).holen({ abs, groesse: p.groesse || VORSCHAU_STANDARD, art, ids: { uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen || [] } });
        return { mime: v.mime, daten: v.daten.toString('base64'), groesse: p.groesse || VORSCHAU_STANDARD };
      }
      const art = p.was === 'zip' ? 'zip' : 'lesen';
      const ticket = await leseTicket(w, kontext, r, rel, art);
      return { ...ticket, art, nutzer: l.nutzer };
    },
  });
}
