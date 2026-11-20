// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „snapshots.*“: Schnappschüsse der Freigaben (btrfs, nur lesbar, unter /data/.snapshots/<freigabe>/<id>)
// und des Systems (snapper, Konfiguration „root“, /.snapshots/<nr>/snapshot). Interner Minutentakt für die Pläne
// der Freigaben (stündlich :00, täglich 03:00, wöchentlich Sonntag 03:30, Ortszeit) mit Aufbewahrung und
// Platzbremse ab 95 % Belegung der Datenpartition. snapshots.apply rendert snapper und startet den Takt.
// System-Rückrollen (snapshots.system.standard/zurueck/reste/rest_loeschen) tauschen das Unterlaufwerk „@“ der
// Systempartition aus (Umbenenn-Ansatz, Ablauf im Kommentar über der Sektion „System-Rückrollen“).

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE, pruefeFreigabename } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { R } from '../../gemeinsam/schema.js';
import { freigabeHolen, helfer, helferStrom, pfadVorpruefen, plattenPlatz, ordnerZugriff, ordnerrechteMarkieren, ordnerrechteAngleichenUm } from './dateien.js';
import { rendereSnapper, anzahlBehalten } from '../render/snapper.js';

export const ID_FREIGABE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-(manuell|plan|sicherheit))?$/;
const ID_SYSTEM = /^\d{1,9}$/;
export const TAKTE = Object.freeze(['stuendlich', 'taeglich', 'woechentlich', 'monatlich']);
export const PLATTE_VOLL_PROZENT = 95;
const ZUSTAND_DATEI = 'snapshots_zustand.json';
const TAKT_MS = 60_000;
const PLATTE_VOLL_MELDEN_MS = 3_600_000;

// Uhr und Takt sind gekapselt, damit Tests die Zeit stellen und den Takt anhalten können.
const uhr = { jetzt: () => new Date() };
const takt = { timer: null, laeuft: false };

export const _test = {
  setzeJetzt(fn) { uhr.jetzt = fn || (() => new Date()); },
  stoppen() { taktStoppen(); },
  tick(werkzeuge) { return zeitplanTick(werkzeuge); },
  laeuft() { return takt.timer !== null; },
};

function pfadeVon(w) { return w.pfade || PFADE; }
async function existiert(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Kennung aus der Zeit (UTC, ohne Doppelpunkte): 2026-09-25T08-30-00 */
export function idAusZeit(d) { return d.toISOString().slice(0, 19).replace(/:/g, '-'); }
/** Zeitstempel „2026-09-25T08-30-00“ zurück in ISO-UTC. */
function zeitAusStempel(t) { return `${t.slice(0, 10)}T${t.slice(11, 13)}:${t.slice(14, 16)}:${t.slice(17, 19)}.000Z`; }
function zeitAusId(id) {
  const m = ID_FREIGABE.exec(id);
  return m ? zeitAusStempel(m[1]) : null;
}

/**
 * Stufenweiser Ablauf mit Rückdrehen: `stufe(name, fn)` führt fn aus; schlägt es fehl, laufen alle bisher in `rueck`
 * eingetragenen Gegenmaßnahmen in umgekehrter Reihenfolge, danach E_SYSTEM mit `details.stufe`.
 */
function rueckdreher(fehlertext) {
  const rueck = [];
  const zurueckdrehen = async () => {
    for (const f of rueck.splice(0).reverse()) { try { await f(); } catch (e) { process.stderr.write(`[snapshots] Zurückdrehen: ${e.message}\n`); } }
  };
  const stufe = async (bezeichnung, f) => {
    try { return await f(); } catch (e) {
      await zurueckdrehen();
      const d = (e && e.details) || {};
      throw new FahnasFehler('E_SYSTEM', `${fehlertext} (Stufe „${bezeichnung}“) – der bisherige Stand ist wiederhergestellt`, { stufe: bezeichnung, befehl: d.befehl, ausgabe: d.ausgabe || String(e && e.message) });
    }
  };
  return { stufe, rueck };
}
function artAusId(id) {
  const m = ID_FREIGABE.exec(id);
  const s = m && m[2];
  return s === 'plan' ? 'zeitplan' : s === 'sicherheit' ? 'sicherheit' : 'manuell';
}
function pruefeId(id) {
  if (typeof id !== 'string' || !ID_FREIGABE.test(id)) throw new FahnasFehler('E_PARAMS', 'Schnappschuss-Kennung ungültig', { feld: 'id' });
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Freigaben (btrfs)
// ---------------------------------------------------------------------------------------------------------------
async function metaLesen(ordner, id) {
  try { return JSON.parse(await fs.readFile(path.join(ordner, `${id}.json`), 'utf8')); } catch { return {}; }
}

/** Liste der Schnappschüsse einer Freigabe (neueste zuerst) aus Verzeichnis + Begleitdatei; optional btrfs-Details. */
export async function freigabeSchnappschuesse(w, name, { mitBtrfs = false } = {}) {
  const ordner = path.join(pfadeVon(w).snapshots, name);
  let namen = [];
  try { namen = await fs.readdir(ordner); } catch (e) { if (e.code !== 'ENOENT') throw FahnasFehler.aus(e); }
  const aus = [];
  const vorhanden = new Set(namen);
  for (const n of namen) {
    if (!ID_FREIGABE.test(n)) {
      // verwaiste Begleitdatei (Schnappschuss von Hand gelöscht) → weg damit
      if (n.endsWith('.json') && ID_FREIGABE.test(n.slice(0, -5)) && !vorhanden.has(n.slice(0, -5))) { try { await fs.unlink(path.join(ordner, n)); } catch { /* egal */ } }
      continue;
    }
    let st;
    try { st = await fs.lstat(path.join(ordner, n)); } catch { continue; }
    if (!st.isDirectory()) continue;
    const meta = await metaLesen(ordner, n);
    const e = { id: n, zeit: meta.zeit || zeitAusId(n), art: meta.art || artAusId(n), beschreibung: meta.beschreibung || '', nutzer: meta.nutzer ?? null };
    if (meta.takt) e.takt = meta.takt;
    if (mitBtrfs && !meta.zeit) {
      try {
        const { stdout } = await w.system.ausfuehren('btrfs', ['subvolume', 'show', path.join(ordner, n)], { erlaubteCodes: [0, 1] });
        const m = /^\s*Creation time:\s*(.+)$/m.exec(String(stdout));
        if (m) { const d = new Date(m[1].trim().replace(' ', 'T')); if (!Number.isNaN(d.getTime())) e.zeit = d.toISOString(); }
      } catch { /* btrfs nicht da (Entwicklung) – Zeit aus dem Namen genügt */ }
    }
    aus.push(e);
  }
  aus.sort((a, b) => (a.zeit < b.zeit ? 1 : a.zeit > b.zeit ? -1 : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)));
  return aus;
}

/** Belegung der Datenpartition; bei df-Fehler wird NICHT gesperrt (gemeldet auf stderr). */
async function platteVoll(w) {
  try {
    const p = await plattenPlatz(w.system, pfadeVon(w).shares);
    return { voll: p.prozent >= PLATTE_VOLL_PROZENT, prozent: p.prozent, gesamt: p.gesamt, frei: p.frei };
  } catch (e) { process.stderr.write(`[snapshots] Belegung nicht ermittelbar: ${e.message}\n`); return { voll: false, prozent: null }; }
}

/**
 * Legt einen nur lesbaren Schnappschuss der Freigabe an: btrfs subvolume snapshot -r <shares>/<name> <snapshots>/<name>/<id>
 * plus Begleitdatei <id>.json {id, zeit, art, takt?, beschreibung, nutzer}. Kennungs-Kollision (z. B. stündlich und
 * täglich in derselben Sekunde) → Sekunde hochzählen.
 */
export async function freigabeSchnappschussAnlegen(w, name, { art, takt: taktName, beschreibung, nutzer, zeit } = {}) {
  const p = pfadeVon(w);
  const quelle = path.join(p.shares, name);
  const ordner = path.join(p.snapshots, name);
  await fs.mkdir(ordner, { recursive: true, mode: 0o755 });
  // Wurzel /data/.snapshots muss für Nutzer durchquerbar sein (0751); die Schnappschüsse selbst tragen die Freigabe-Rechte.
  try { const st = await fs.stat(p.snapshots); if ((st.mode & 0o001) === 0) await fs.chmod(p.snapshots, (st.mode & 0o7777) | 0o001); } catch { /* fremdes Dateisystem/Test */ }
  const suffix = art === 'zeitplan' ? '-plan' : art === 'sicherheit' ? '-sicherheit' : '-manuell';
  const z = zeit || uhr.jetzt();
  let t = new Date(z.getTime()); let id;
  for (;;) { id = idAusZeit(t) + suffix; if (!(await existiert(path.join(ordner, id)))) break; t = new Date(t.getTime() + 1000); }
  const ziel = path.join(ordner, id);
  await w.system.ausfuehren('btrfs', ['subvolume', 'snapshot', '-r', quelle, ziel]);
  const meta = { id, zeit: z.toISOString(), art: art || 'manuell', beschreibung: beschreibung || '', nutzer: nutzer || null };
  if (taktName) meta.takt = taktName;
  try { await fs.writeFile(`${ziel}.json`, JSON.stringify(meta, null, 2) + '\n', { mode: 0o640 }); } catch (e) { process.stderr.write(`[snapshots] Begleitdatei: ${e.message}\n`); }
  return meta;
}

export async function freigabeSchnappschussLoeschen(w, name, id) {
  pruefeId(id);
  const ordner = path.join(pfadeVon(w).snapshots, name);
  const ziel = path.join(ordner, id);
  if (!(await existiert(ziel))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Schnappschuss ${id} gibt es nicht`, { feld: 'id' });
  await w.system.ausfuehren('btrfs', ['subvolume', 'delete', ziel]);
  try { await fs.unlink(`${ziel}.json`); } catch { /* keine Begleitdatei */ }
  return { id, geloescht: true };
}

/** Löscht die ältesten Zeitplan-Schnappschüsse je Takt über „behalten“ hinaus. Manuelle und Sicherheits-Stände nie. */
export async function aufbewahrungAnwenden(w, name, plan) {
  const liste = await freigabeSchnappschuesse(w, name);
  const geloescht = [];
  for (const t of TAKTE) {
    const n = anzahlBehalten(t, plan.behalten);
    const eigene = liste.filter((s) => s.art === 'zeitplan' && s.takt === t);
    for (const s of eigene.slice(n)) {
      try { await freigabeSchnappschussLoeschen(w, name, s.id); geloescht.push(s.id); } catch (e) { process.stderr.write(`[snapshots] Aufräumen ${name}/${s.id}: ${e.message}\n`); }
    }
  }
  return geloescht;
}

// ---------------------------------------------------------------------------------------------------------------
// Zeitplan (Ortszeit des Systems)
// ---------------------------------------------------------------------------------------------------------------
/** Letzter fälliger Zeitpunkt eines Takts vor/bei `jetzt`: stündlich :00, täglich 03:00, wöchentlich Sonntag 03:30,
 * monatlich am 1. um 04:00 (seit 0.32.0). */
export function letzteFaelligkeit(jetzt, t) {
  const g = new Date(jetzt.getTime());
  if (t === 'stuendlich') { g.setMinutes(0, 0, 0); return g; }
  if (t === 'taeglich') { g.setHours(3, 0, 0, 0); if (g > jetzt) g.setDate(g.getDate() - 1); return g; }
  if (t === 'monatlich') { g.setDate(1); g.setHours(4, 0, 0, 0); if (g > jetzt) g.setMonth(g.getMonth() - 1); return g; }
  g.setHours(3, 30, 0, 0);
  g.setDate(g.getDate() - g.getDay());
  if (g > jetzt) g.setDate(g.getDate() - 7);
  return g;
}

/** Nächster Termin eines Takts nach `jetzt` (Gegenstück zu letzteFaelligkeit; der Minutentakt legt ihn dann an). */
export function naechsteFaelligkeit(jetzt, t) {
  const g = letzteFaelligkeit(jetzt, t);
  if (t === 'stuendlich') g.setHours(g.getHours() + 1);
  else if (t === 'taeglich') g.setDate(g.getDate() + 1);
  else if (t === 'monatlich') g.setMonth(g.getMonth() + 1);
  else g.setDate(g.getDate() + 7);
  return g;
}

/** Frühester nächster Termin eines Plans ({zeitplan:{stuendlich,taeglich,woechentlich,monatlich}}) oder null ohne Zeitplan. */
export function naechsterTermin(plan, jetzt) {
  const z = plan && plan.zeitplan ? TAKTE.filter((t) => plan.zeitplan[t]).map((t) => naechsteFaelligkeit(jetzt, t).getTime()) : [];
  return z.length ? new Date(Math.min(...z)).toISOString() : null;
}

function platteVollMelden(w, zustand, voll, jetzt) {
  const zuletzt = zustand.platte_voll_gemeldet ? Date.parse(zustand.platte_voll_gemeldet) : 0;
  if (jetzt.getTime() - zuletzt < PLATTE_VOLL_MELDEN_MS) return;
  zustand.platte_voll_gemeldet = jetzt.toISOString();
  try { w.ereignis('system', { art: 'platte_voll', daten: { prozent: voll.prozent, gesamt: voll.gesamt, frei: voll.frei, hinweis: 'Ab 95 % Belegung werden keine Schnappschüsse mehr angelegt' } }); } catch { /* nie werfen */ }
}

/** Ein Durchlauf des Zeitplans: fällige Schnappschüsse anlegen, Aufbewahrung anwenden, Zustand speichern. */
export async function zeitplanTick(w) {
  if (takt.laeuft) return { uebersprungen: true, angelegt: [], geloescht: [] };
  takt.laeuft = true;
  try {
    const jetzt = uhr.jetzt();
    const sn = await w.konfig.laden('snapshots.json');
    const plaene = (sn?.plaene || []).filter((p) => p && typeof p.ziel === 'string' && p.ziel !== 'system');
    const angelegt = []; const geloescht = [];
    if (!plaene.length) return { angelegt, geloescht };
    const shares = await w.konfig.laden('shares.json');
    const namen = new Set((shares?.freigaben || []).map((f) => f.name));
    // externe Laufwerke (§12) und RAID-Verbünde (eigenes Dateisystem, Schnappschüsse liegen auf der Datenpartition)
    // bekommen keine btrfs-Schnappschüsse – im Zeitplan überspringen
    const externNamen = new Set();
    for (const f of shares?.freigaben || []) if (await ohneSchnappschuesse(w, f)) externNamen.add(f.name);
    const zustand = await w.konfig.laden(ZUSTAND_DATEI, { letzte: {} });
    if (!zustand.letzte || typeof zustand.letzte !== 'object') zustand.letzte = {};
    let voll = null;
    for (const plan of plaene) {
      if (!namen.has(plan.ziel) || externNamen.has(plan.ziel)) continue;
      const l = zustand.letzte[plan.ziel] || (zustand.letzte[plan.ziel] = {});
      for (const t of TAKTE) {
        if (!plan.zeitplan || !plan.zeitplan[t]) continue;
        const grenze = letzteFaelligkeit(jetzt, t);
        if (l[t] && new Date(l[t]) >= grenze) continue;
        if (voll === null) voll = await platteVoll(w);
        if (voll.voll) { platteVollMelden(w, zustand, voll, jetzt); continue; }
        try {
          const m = await freigabeSchnappschussAnlegen(w, plan.ziel, { art: 'zeitplan', takt: t, beschreibung: `Zeitplan ${t}`, zeit: jetzt });
          l[t] = jetzt.toISOString();
          angelegt.push({ freigabe: plan.ziel, takt: t, id: m.id });
        } catch (e) { process.stderr.write(`[snapshots] ${plan.ziel}/${t}: ${e.message}\n`); }
      }
      try { for (const id of await aufbewahrungAnwenden(w, plan.ziel, plan)) geloescht.push({ freigabe: plan.ziel, id }); } catch (e) { process.stderr.write(`[snapshots] Aufbewahrung ${plan.ziel}: ${e.message}\n`); }
    }
    zustand.letzter_lauf = jetzt.toISOString();
    // unter der Sperre der Datei zusammenführen – nichts überschreiben, was zwischenzeitlich geschrieben wurde
    await w.konfig.aendern(ZUSTAND_DATEI, (d) => ({
      ...(d && typeof d === 'object' ? d : {}),
      letzte: { ...((d && d.letzte) || {}), ...zustand.letzte },
      letzter_lauf: zustand.letzter_lauf,
      ...(zustand.platte_voll_gemeldet ? { platte_voll_gemeldet: zustand.platte_voll_gemeldet } : {}),
    }), { letzte: {} });
    if ((angelegt.length || geloescht.length) && typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
    return { angelegt, geloescht, platte_voll: voll ? voll.voll : false };
  } finally { takt.laeuft = false; }
}

function taktStoppen() { if (takt.timer) { clearInterval(takt.timer); takt.timer = null; } }
function taktStarten(w) {
  taktStoppen();
  takt.timer = setInterval(() => { zeitplanTick(w).catch((e) => process.stderr.write(`[snapshots] Zeitplan: ${e.message}\n`)); }, TAKT_MS);
  takt.timer.unref();
}

/** snapshots.apply: snapper rendern, Minutentakt (neu) starten, einen Durchlauf sofort. */
async function anwenden(w) {
  const sn = await w.konfig.laden('snapshots.json');
  const planSystem = (sn?.plaene || []).find((p) => p && p.ziel === 'system') || null;
  const gerendert = [];
  let renderFehler = null;
  try { const r = await rendereSnapper(planSystem, { system: w.system }); gerendert.push(r.datei); } catch (e) {
    renderFehler = e instanceof FahnasFehler ? e : new FahnasFehler('E_RENDER', 'snapper-Konfiguration konnte nicht geschrieben werden', { ausgabe: String(e.message) });
  }
  taktStarten(w);
  const lauf = await zeitplanTick(w);
  if (renderFehler) throw renderFehler;
  return { gerendert, zeitplan: 'aktiv', angelegt: lauf.angelegt, geloescht: lauf.geloescht };
}

// ---------------------------------------------------------------------------------------------------------------
// System (snapper)
// ---------------------------------------------------------------------------------------------------------------
function systemArt(typ, beschreibung, cleanup) {
  if (typ === 'pre') return 'pre';
  if (typ === 'post') return 'post';
  if (cleanup === 'timeline' || /^timeline$/i.test(beschreibung || '')) return 'zeitplan';
  return 'manuell';
}
function zeitParsen(t) {
  if (!t) return null;
  const s = String(t).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Tabellenausgabe von `snapper list --columns number,date,type,description` einlesen (robust gegen Markierungen). */
export function snapperTabelleParsen(text) {
  const aus = [];
  for (const zeile of String(text).split('\n')) {
    if (!zeile.includes('|')) continue;
    const t = zeile.split('|').map((x) => x.trim());
    if (t.length < 4) continue;
    const nummer = t[0].replace(/[^\d]/g, '');
    if (!nummer || nummer === '0') continue; // Kopf, Trenner, „current“
    aus.push({ id: nummer, zeit: zeitParsen(t[1]), art: systemArt(t[2], t[3]), beschreibung: t[3] || '' });
  }
  return aus;
}

/** JSON-Ausgabe von `snapper --jsonout list` einlesen. */
export function snapperJsonParsen(text) {
  const j = JSON.parse(text);
  const liste = Array.isArray(j) ? j : (Array.isArray(j.root) ? j.root : Object.values(j).find(Array.isArray));
  if (!Array.isArray(liste)) throw new Error('kein Feld');
  return liste.filter((s) => Number(s.number) !== 0).map((s) => {
    const e = { id: String(s.number), zeit: zeitParsen(s.date), art: systemArt(s.type, s.description, s.cleanup), beschreibung: s.description || '' };
    if (typeof s['used-space'] === 'number') e.groesse = s['used-space'];
    if (s['pre-number'] !== undefined && s['pre-number'] !== null) e.pre = String(s['pre-number']);
    return e;
  });
}

async function systemListe(w) {
  // 1. JSON-Ausgabe (neuere snapper-Versionen), 2. Tabellenausgabe
  try {
    const r = await w.system.ausfuehren('snapper', ['--jsonout', '-c', 'root', 'list'], { erlaubteCodes: [0, 1, 2] });
    if (r.code === 0) return snapperJsonParsen(r.stdout);
  } catch { /* weiter mit Tabelle */ }
  const r = await w.system.ausfuehren('snapper', ['-c', 'root', 'list', '--columns', 'number,date,type,description']);
  return snapperTabelleParsen(r.stdout);
}

/** Einträge von grub-btrfs aus grub.cfg: Zeilen `submenu '…| @/.snapshots/12/snapshot | …'` bzw. rootflags=subvol=… */
export function startmenueParsen(text) {
  const aus = new Map();
  const titelMuster = /^\s*(?:submenu|menuentry)\s+(['"])(.*?)\1/;
  let letzterTitel = null;
  for (const zeile of String(text).split('\n')) {
    const tm = titelMuster.exec(zeile);
    if (tm) letzterTitel = tm[2];
    const m = /\.snapshots\/(\d+)\/snapshot/.exec(zeile);
    if (!m) continue;
    const id = m[1];
    if (aus.has(id)) continue;
    const titel = tm ? tm[2] : (letzterTitel || zeile.trim());
    const teile = titel.split('|').map((x) => x.trim());
    const e = { id, titel };
    if (teile.length >= 3) { e.zeit = zeitParsen(teile[0]); e.art = systemArt(teile[2], teile[3]); e.beschreibung = teile[3] || ''; }
    aus.set(id, e);
  }
  return [...aus.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// System-Rückrollen (Umbenenn-Ansatz für das Ubuntu-@-Layout)
// ---------------------------------------------------------------------------------------------------------------
/*
 * Warum nicht „btrfs subvolume set-default“: Ubuntus /etc/grub.d/10_linux schreibt für eine btrfs-Wurzel immer
 * rootflags=subvol=<Pfad der laufenden Wurzel> in die Kernelzeile (rootsubvol aus make_system_path_relative_to_its_root /),
 * und die fstab aus iso/payload/partitionen.sh hängt / mit subvol=@ ein – beides gewinnt gegen das Standard-
 * Unterlaufwerk. Zuverlässig startet nur, was unter dem NAMEN „@“ liegt. Deshalb tauschen wir das Unterlaufwerk @
 * aus; GRUB-Skripte, fstab und Kernelzeile bleiben unberührt.
 *
 * Ablauf snapshots.system.standard {id}:
 *  0. /.snapshots/<id>/snapshot muss existieren (btrfs subvolume show). snapper-Schnappschüsse liegen im eigenen
 *     Unterlaufwerk @snapshots (auf /.snapshots eingehängt), sind nur lesbar und überleben das Umbenennen von @.
 *  1. Gerät der Wurzel aus `findmnt -n -o SOURCE /` (z. B. /dev/nvme0n1p3[/@] → Gerät + Name der laufenden Wurzel);
 *     Poolwurzel (subvolid=5) nach <run>/sysroot einhängen (privater Mountpunkt 0700; ein Rest einer früheren
 *     Einhängung wird vorher gelöst).
 *  2. Sicherheits-Schnappschuss des laufenden Stands als snapper-Eintrag: snapper -c root create -t single
 *     -d "Vor Rückrollen auf <id> (FAH-NAS)" – nur wenn die laufende Wurzel wirklich @ ist (nach einem Start aus dem
 *     Startmenü wäre es ein Schnappschuss des Schnappschusses). Ohne Cleanup-Algorithmus, bleibt also stehen.
 *  3. mv -T sysroot/@ sysroot/@_alt_<zeit>   – der Rückweg. Die laufende Wurzel bleibt eingehängt: der Kernel hält
 *     Unterlaufwerke über ihre ID, nicht über den Namen.
 *  4. btrfs subvolume snapshot /.snapshots/<id>/snapshot sysroot/@   – beschreibbare Kopie unter dem Namen @.
 *  5. Prüfen im neuen @: /etc/fstab hängt / mit subvol=@ ein, /boot/grub/grub.cfg trägt rootflags=subvol=@ – der
 *     Schnappschuss der alten Wurzel enthält beides; @log und @snapshots bleiben eigene Unterlaufwerke und werden
 *     laut fstab wieder eingehängt. Abweichungen sind Warnungen, kein Abbruch.
 *  6. Reste begrenzen: höchstens RESTE_BEHALTEN Unterlaufwerke @_alt_<zeit> und @_kaputt_<zeit> bleiben (die neuesten); ältere
 *     werden gelöscht (rekursiv – systemd legt z. B. /var/lib/machines als Unterlaufwerk an). Die laufende Wurzel nie.
 *  7. umount sysroot – immer, auch nach Fehlern.
 *  KEIN update-grub: es liefe im ALTEN Stand (jetzt @_alt_<zeit>) und schriebe dessen grub.cfg mit rootflags=subvol=
 *  @_alt_<zeit>; GRUB liest aber /@/boot/grub/grub.cfg des neuen Stands, der Kernel, initrd und Menü aus seiner
 *  eigenen Zeit mitbringt. grub-btrfsd erneuert die Schnappschuss-Einträge nach dem Neustart.
 *  Fehler in 2–4 → bereits gemachte Umbenennungen zurückdrehen, E_SYSTEM mit details.stufe; Fehler in 6/7 → Warnung.
 *
 * snapshots.system.zurueck {name}: Rücktausch – mv @ → @_kaputt_<zeit>, mv <name> → @ (Schritte 1, 3, 5–7).
 * snapshots.system.reste / rest_loeschen {name}: Reste ansehen bzw. gezielt löschen (nie die laufende Wurzel).
 * Alle vier laufen nacheinander (E_BELEGT), damit sich zwei Läufe nicht den Mountpunkt wegziehen.
 */
export const RESTE_BEHALTEN = 2;
export const REST_NAME = /^@_(alt|kaputt)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/;
const STARTMENUE_HINWEIS = 'Ein Start aus dem Startmenü (grub-btrfs) ist nur lesend und experimentell – zum Nachsehen, nicht zum Arbeiten. Dauerhaft wird ein Stand nur über „Beim nächsten Start verwenden“ (snapshots.system.standard) und einen Neustart.';
const systemLauf = { aktiv: false };

async function mitSystemLauf(f) {
  if (systemLauf.aktiv) throw new FahnasFehler('E_BELEGT', 'Ein System-Rückrollen läuft gerade – bitte kurz warten');
  systemLauf.aktiv = true;
  try { return await f(); } finally { systemLauf.aktiv = false; }
}

/** Gerät und Name der laufenden Wurzel aus `findmnt -n -o SOURCE /` („/dev/sda3[/@]“ → Gerät /dev/sda3, Wurzel „@“). */
async function wurzelQuelle(sys) {
  const r = await sys.ausfuehren('findmnt', ['-n', '-o', 'SOURCE', '/']);
  const zeile = String(r.stdout).split('\n')[0].trim();
  const m = /^(\/dev\/\S+?)(?:\[(\/[^\]]*)\])?$/.exec(zeile);
  if (!m) throw new FahnasFehler('E_SYSTEM', 'Das Gerät der Systempartition ließ sich nicht ermitteln', { befehl: 'findmnt -n -o SOURCE /', ausgabe: zeile });
  return { geraet: m[1], wurzel: (m[2] || '').replace(/^\/+/, '') };
}

/** Poolwurzel (subvolid=5) der Systempartition privat einhängen, `arbeit({sysroot, wurzel, warnungen})` ausführen, immer aushängen. */
async function mitPoolwurzel(w, arbeit) {
  const sys = w.system;
  const sysroot = path.join(pfadeVon(w).run || PFADE.run, 'sysroot');
  const q = await wurzelQuelle(sys);
  await fs.mkdir(sysroot, { recursive: true, mode: 0o700 });
  try { await fs.chmod(sysroot, 0o700); } catch { /* fremdes Dateisystem – unkritisch, der Mount bringt eigene Rechte */ }
  const belegt = await sys.ausfuehren('findmnt', ['-n', '-o', 'SOURCE', sysroot], { erlaubteCodes: [0, 1] });
  if (belegt.code === 0 && String(belegt.stdout).trim()) await sys.ausfuehren('umount', [sysroot]); // Rest eines abgebrochenen Laufs
  await sys.ausfuehren('mount', ['-t', 'btrfs', '-o', 'subvolid=5', q.geraet, sysroot]);
  const warnungen = [];
  try { return await arbeit({ sysroot, geraet: q.geraet, wurzel: q.wurzel, warnungen }); } finally {
    try { await sys.ausfuehren('umount', [sysroot]); } catch (e) { process.stderr.write(`[snapshots] ${sysroot} aushängen: ${e.message}\n`); warnungen.push(`${sysroot} konnte nicht ausgehängt werden`); }
  }
}

async function lesenOderNull(p) { try { return await fs.readFile(p, 'utf8'); } catch { return null; } }

/** Reste @_alt_<zeit> und @_kaputt_<zeit> in der Poolwurzel, neueste zuerst; `laufend` markiert die eingehängte Wurzel. */
async function systemReste(sysroot, wurzel) {
  const aus = [];
  for (const n of await fs.readdir(sysroot)) {
    const m = REST_NAME.exec(n);
    if (!m) continue;
    let st; try { st = await fs.lstat(path.join(sysroot, n)); } catch { continue; }
    if (!st.isDirectory()) continue;
    aus.push({ name: n, art: m[1], zeit: zeitAusStempel(m[2]), laufend: n === wurzel });
  }
  aus.sort((a, b) => (a.zeit < b.zeit ? 1 : a.zeit > b.zeit ? -1 : (a.name < b.name ? 1 : -1)));
  return aus;
}

/** Löscht ein Unterlaufwerk samt verschachtelten (btrfs-progs `--recursive`); kennt btrfs die Option nicht, ohne. */
async function unterlaufwerkLoeschen(sys, pfad) {
  try { await sys.ausfuehren('btrfs', ['subvolume', 'delete', '--recursive', pfad]); } catch (e) {
    if (!/unknown option|unrecognized option|invalid option/i.test(String(e?.details?.ausgabe || ''))) throw e;
    await sys.ausfuehren('btrfs', ['subvolume', 'delete', pfad]);
  }
}

/** Höchstens RESTE_BEHALTEN Reste (die neuesten) bleiben; `laufend` (die eingehängte Wurzel) nie löschen. Fehler → Warnung. */
async function resteBegrenzen(sys, sysroot, laufend, warnungen) {
  const geloescht = [];
  for (const r of (await systemReste(sysroot, laufend)).slice(RESTE_BEHALTEN)) {
    if (r.laufend) { warnungen.push(`${r.name} ist die laufende Wurzel und bleibt stehen`); continue; }
    try { await unterlaufwerkLoeschen(sys, path.join(sysroot, r.name)); geloescht.push(r.name); } catch (e) { warnungen.push(`Rest ${r.name} konnte nicht gelöscht werden: ${e?.details?.ausgabe || e.message}`); }
  }
  return geloescht;
}

/** Freier Name @_<art>_<zeit>; Kollision in derselben Sekunde → Sekunde hochzählen. */
async function freierRestName(sysroot, art) {
  for (let t = uhr.jetzt(); ; t = new Date(t.getTime() + 1000)) {
    const n = `@_${art}_${idAusZeit(t)}`;
    if (!(await existiert(path.join(sysroot, n)))) return n;
  }
}

/** fstab und grub.cfg des (neuen) @ ansehen – nur Warnungen, der Schnappschuss der alten Wurzel enthält beides. */
async function neuesAtPruefen(at, warnungen) {
  const fstab = await lesenOderNull(path.join(at, 'etc/fstab'));
  if (fstab === null) warnungen.push('Im wiederhergestellten Stand fehlt /etc/fstab');
  else if (!/^\s*[^#\s]\S*\s+\/\s+btrfs\s+(?:\S*,)?subvol=@(?:,|\s|$)/m.test(fstab)) warnungen.push('Die fstab des wiederhergestellten Stands hängt / nicht mit subvol=@ ein – bitte vor dem Neustart prüfen');
  const grub = await lesenOderNull(path.join(at, 'boot/grub/grub.cfg'));
  if (grub === null) warnungen.push('Im wiederhergestellten Stand fehlt /boot/grub/grub.cfg');
  else if (!/rootflags=subvol=["']?@(?=["'\s]|$)/m.test(grub)) warnungen.push('Das Startmenü des wiederhergestellten Stands trägt kein rootflags=subvol=@ – bitte vor dem Neustart prüfen');
}

function layoutFehler(sysroot) { return new FahnasFehler('E_SYSTEM', 'Unerwartetes Layout: auf der Systempartition gibt es kein Unterlaufwerk „@“ – nichts geändert', { sysroot }); }

/** snapshots.system.standard – Schritte 0–7 aus dem Kommentar oben. */
async function systemStandard(w, id) {
  const sys = w.system;
  const snap = `/.snapshots/${id}/snapshot`;
  try { await sys.ausfuehren('btrfs', ['subvolume', 'show', snap]); } catch (e) {
    throw new FahnasFehler('E_NICHT_GEFUNDEN', `System-Schnappschuss ${id} wurde nicht gefunden`, e && e.details);
  }
  return mitSystemLauf(() => mitPoolwurzel(w, async ({ sysroot, wurzel, warnungen }) => {
    const at = path.join(sysroot, '@');
    if (!(await existiert(at))) throw layoutFehler(sysroot);
    const altName = await freierRestName(sysroot, 'alt');
    const alt = path.join(sysroot, altName);
    const { stufe, rueck } = rueckdreher('System-Rückrollen fehlgeschlagen');
    let sicherheit = null;
    if (wurzel === '@') {
      sicherheit = await stufe('sicherheit', async () => {
        const r = await sys.ausfuehren('snapper', ['-c', 'root', 'create', '-t', 'single', '-d', `Vor Rückrollen auf ${id} (FAH-NAS)`, '--print-number']);
        return String(r.stdout).trim().replace(/[^\d]/g, '') || null;
      });
    } else warnungen.push(`Die laufende Wurzel ist „${wurzel || 'Top-Level'}“, nicht „@“ – kein snapper-Sicherheits-Schnappschuss; der bisherige Stand @ bleibt als ${altName} erhalten`);
    await stufe('umbenennen', async () => { await sys.ausfuehren('mv', ['-T', at, alt]); rueck.push(() => sys.ausfuehren('mv', ['-T', alt, at])); });
    await stufe('kopie', async () => { await sys.ausfuehren('btrfs', ['subvolume', 'snapshot', snap, at]); rueck.push(() => unterlaufwerkLoeschen(sys, at)); });
    await neuesAtPruefen(at, warnungen);
    const laufend = wurzel === '@' ? altName : wurzel; // die eingehängte Wurzel heißt jetzt @_alt_<zeit>
    const geloeschte_reste = await resteBegrenzen(sys, sysroot, laufend, warnungen);
    if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
    return {
      id, quelle: id, alt: altName, sicherheit, neustart_noetig: true, geloeschte_reste, warnungen,
      hinweis: `Der Stand ${id} liegt jetzt als „@“ auf der Systempartition; der bisherige Stand heißt ${altName} (Rückweg: snapshots.system.zurueck). Der Wechsel wird mit dem nächsten Neustart wirksam – starte jetzt neu (System → Neustart).`,
    };
  }));
}

/** snapshots.system.zurueck – Rücktausch: @ → @_kaputt_<zeit>, <name> → @. */
async function systemZurueck(w, name) {
  const sys = w.system;
  return mitSystemLauf(() => mitPoolwurzel(w, async ({ sysroot, wurzel, warnungen }) => {
    const quelle = path.join(sysroot, name);
    if (!(await existiert(quelle))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Den Rest ${name} gibt es nicht`, { feld: 'name' });
    const at = path.join(sysroot, '@');
    if (!(await existiert(at))) throw layoutFehler(sysroot);
    const kaputtName = await freierRestName(sysroot, 'kaputt');
    const kaputt = path.join(sysroot, kaputtName);
    const { stufe, rueck } = rueckdreher('Rücktausch fehlgeschlagen');
    await stufe('umbenennen', async () => { await sys.ausfuehren('mv', ['-T', at, kaputt]); rueck.push(() => sys.ausfuehren('mv', ['-T', kaputt, at])); });
    await stufe('tausch', async () => { await sys.ausfuehren('mv', ['-T', quelle, at]); rueck.push(() => sys.ausfuehren('mv', ['-T', at, quelle])); });
    await neuesAtPruefen(at, warnungen);
    const laufend = wurzel === '@' ? kaputtName : (wurzel === name ? '@' : wurzel);
    const geloeschte_reste = await resteBegrenzen(sys, sysroot, laufend, warnungen);
    if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
    return {
      alt: name, kaputt: kaputtName, neustart_noetig: true, geloeschte_reste, warnungen,
      hinweis: `${name} liegt wieder als „@“ auf der Systempartition; der verworfene Stand heißt ${kaputtName}. Der Wechsel wird mit dem nächsten Neustart wirksam – starte jetzt neu (System → Neustart).`,
    };
  }));
}

/** snapshots.system.rest_loeschen – einen Rest gezielt löschen (nie die laufende Wurzel). */
async function systemRestLoeschen(w, name) {
  return mitSystemLauf(() => mitPoolwurzel(w, async ({ sysroot, wurzel }) => {
    const pfad = path.join(sysroot, name);
    if (!(await existiert(pfad))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Den Rest ${name} gibt es nicht`, { feld: 'name' });
    if (name === wurzel) throw new FahnasFehler('E_BELEGT', `${name} ist die laufende Wurzel – erst neu starten, dann löschen`, { feld: 'name' });
    await unterlaufwerkLoeschen(w.system, pfad);
    return { name, geloescht: true };
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Zurückrollen einer Freigabe
// ---------------------------------------------------------------------------------------------------------------
/**
 * 1) Sicherheits-Schnappschuss des aktuellen Stands (bleibt immer stehen), 2) beschreibbares Unterlaufwerk aus dem
 * Schnappschuss nach <pfad>.neu, 3) mv <pfad> <pfad>.alt && mv <pfad>.neu <pfad> (Samba lässt sich nicht kurz
 * pausieren, offene Handles zeigen weiter auf .alt), 4) altes Unterlaufwerk löschen. Rechte/ACLs stecken im
 * Schnappschuss. Fehler auf jeder Stufe → bisherige Schritte in umgekehrter Reihenfolge zurückdrehen, E_SYSTEM.
 */
async function zurueckrollen(w, name, id, kontext, aufgabe) {
  pruefeId(id);
  const p = pfadeVon(w);
  const pfad = path.join(p.shares, name);
  const snap = path.join(p.snapshots, name, id);
  const neu = `${pfad}.neu`; const alt = `${pfad}.alt`;
  if (!(await existiert(snap))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Schnappschuss ${id} gibt es nicht`, { feld: 'id' });
  if ((await existiert(neu)) || (await existiert(alt))) {
    throw new FahnasFehler('E_BELEGT', `Ein früheres Zurückrollen wurde nicht sauber beendet – bitte ${neu} bzw. ${alt} von Hand prüfen`, { pfad: neu });
  }
  const voll = await platteVoll(w);
  if (voll.voll) throw new FahnasFehler('E_PLATZ', `Die Datenpartition ist zu ${voll.prozent} % voll – erst Platz schaffen`, { prozent: voll.prozent });
  const sys = w.system;
  const { stufe, rueck } = rueckdreher('Zurückrollen fehlgeschlagen');
  aufgabe.fortschritt(0.05, 'Sicherheits-Schnappschuss wird angelegt');
  const sicherheit = await stufe('sicherheit', () => freigabeSchnappschussAnlegen(w, name, { art: 'sicherheit', beschreibung: `Vor Zurückrollen auf ${id}`, nutzer: kontext.nutzer }));
  aufgabe.fortschritt(0.3, 'Beschreibbare Kopie des Schnappschusses wird angelegt');
  await stufe('kopie', async () => { await sys.ausfuehren('btrfs', ['subvolume', 'snapshot', snap, neu]); rueck.push(() => sys.ausfuehren('btrfs', ['subvolume', 'delete', neu])); });
  aufgabe.fortschritt(0.6, 'Freigabe wird getauscht');
  await stufe('tausch_alt', async () => { await sys.ausfuehren('mv', ['-T', pfad, alt]); rueck.push(() => sys.ausfuehren('mv', ['-T', alt, pfad])); });
  await stufe('tausch_neu', async () => { await sys.ausfuehren('mv', ['-T', neu, pfad]); rueck.push(() => sys.ausfuehren('mv', ['-T', pfad, neu])); });
  aufgabe.fortschritt(0.85, 'Alter Stand wird entfernt');
  await stufe('altes_loeschen', () => sys.ausfuehren('btrfs', ['subvolume', 'delete', alt]));
  aufgabe.fortschritt(1, 'Fertig');
  if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
  // Der alte Stand bringt die Rechte von damals mit – Ordnerrechte von heute wieder durchsetzen
  try { await w.intern('freigaben.ordnerrechte.apply', { freigabe: name, gruendlich: true }); } catch (e) { process.stderr.write(`[snapshots] Ordnerrechte nach Zurückrollen: ${e && e.message}\n`); }
  return { freigabe: name, id, sicherheit: sicherheit.id };
}

// ---------------------------------------------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------------------------------------------
const S_ZIEL = { typ: 'string', pflicht: true, max: 64, muster: /^(system|[a-z0-9][a-z0-9_-]{0,31})$/, hinweis: 'Ziel ist „system“ oder ein Freigabename' };
const S_ID = { typ: 'string', pflicht: true, max: 64, muster: /^[A-Za-z0-9_-]+$/, hinweis: 'Kennung ungültig' };
const S_ID_SYSTEM = { typ: 'string', pflicht: true, max: 9, muster: ID_SYSTEM, hinweis: 'System-Schnappschüsse haben eine Nummer als Kennung' };
const S_REST = { typ: 'string', pflicht: true, max: 40, muster: REST_NAME, hinweis: 'Ein Rest heißt @_alt_<Zeit> oder @_kaputt_<Zeit>' };
const S_ZEITPLAN = { typ: 'object', pflicht: true, felder: { stuendlich: { typ: 'boolean', standard: false }, taeglich: { typ: 'boolean', standard: false }, woechentlich: { typ: 'boolean', standard: false }, monatlich: { typ: 'boolean', standard: false } } };
const S_BEHALTEN = { typ: 'object', pflicht: true, felder: { stuendlich: { typ: 'integer', min: 0, max: 10000, standard: 0 }, taeglich: { typ: 'integer', min: 0, max: 10000, standard: 0 }, woechentlich: { typ: 'integer', min: 0, max: 10000, standard: 0 }, monatlich: { typ: 'integer', min: 0, max: 10000, standard: 0 }, pre_post: { typ: 'integer', min: 0, max: 10000, standard: 0 } } };

/** Verbund mit Aufbau 2 (Unterlaufwerke daten/schnappschuesse) kann Schnappschüsse – ältere Verbünde nicht. */
async function verbundMitSchnappschuessen(w, name) {
  const raid = (await w.konfig.laden('raid.json', null)) || {};
  return (raid.verbuende || []).some((v) => v.name === name && v.layout === 2);
}
// übernommene Ordner: nur btrfs-Unterlaufwerke (Ablage @fahnas-schnappschuesse auf demselben Volume, import/einhaengen.js)
async function ohneSchnappschuesse(w, f) { return !!f && (f.extern || f.verschluesselt || (f.importiert && !f.importiert.schnappschuesse) || (f.verbund && !(await verbundMitSchnappschuessen(w, f.name)))); }

async function freigabeExistiert(w, name) {
  pruefeFreigabename(name);
  const shares = await w.konfig.laden('shares.json');
  const f = (shares?.freigaben || []).find((x) => x.name === name);
  if (!f) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Die Freigabe „${name}“ gibt es nicht`, { feld: 'ziel' });
  return f;
}

export function registriere(reg) {
  reg.aktion('snapshots.liste', {
    rolle: 'nutzer', beschreibung: 'Schnappschüsse eines Ziels (system oder Freigabe)',
    schema: { ziel: S_ZIEL },
    ausfuehren: async (p, k, w) => {
      if (p.ziel === 'system') return systemListe(w);
      const r = await freigabeHolen(w, p.ziel, k);
      if (await ohneSchnappschuesse(w, r.freigabe)) return []; // externe Laufwerke (§12) und alte RAID-Verbünde haben keine Schnappschüsse
      return freigabeSchnappschuesse(w, p.ziel, { mitBtrfs: true });
    },
  });

  reg.aktion('snapshots.erzeugen', {
    rolle: 'admin', beschreibung: 'Schnappschuss jetzt anlegen',
    schema: { ziel: S_ZIEL, beschreibung: R.text(200) },
    ausfuehren: async (p, k, w) => {
      if (p.ziel === 'system') {
        const beschreibung = p.beschreibung || 'Manuell (FAH-NAS)';
        const r = await w.system.ausfuehren('snapper', ['-c', 'root', 'create', '-d', beschreibung, '--print-number']);
        const id = String(r.stdout).trim().replace(/[^\d]/g, '');
        return { id, zeit: uhr.jetzt().toISOString(), art: 'manuell', beschreibung };
      }
      const fg = await freigabeExistiert(w, p.ziel);
      if (await ohneSchnappschuesse(w, fg)) throw new FahnasFehler('E_PARAMS', fg.verbund ? 'Dieser Speicherverbund wurde vor 0.15 angelegt und hat noch keinen Platz für Schnappschüsse' : fg.verschluesselt ? 'Verschlüsselte Freigaben haben keine Schnappschüsse' : fg.importiert ? 'Dieser übernommene Ordner liegt nicht auf btrfs (oder ist kein Unterlaufwerk) – Schnappschüsse gehen hier nicht' : 'Externe Laufwerke haben keine Schnappschüsse', { feld: 'ziel' });
      const voll = fg.verbund || fg.importiert ? { voll: false } : await platteVoll(w); // Verbund/übernommen: eigenes Dateisystem
      if (voll.voll) throw new FahnasFehler('E_PLATZ', `Die Datenpartition ist zu ${voll.prozent} % voll – es werden keine Schnappschüsse mehr angelegt`, { prozent: voll.prozent });
      const m = await freigabeSchnappschussAnlegen(w, p.ziel, { art: 'manuell', beschreibung: p.beschreibung, nutzer: k.nutzer });
      if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
      return m;
    },
  });

  reg.aktion('snapshots.loeschen', {
    rolle: 'admin', beschreibung: 'Schnappschuss löschen',
    schema: { ziel: S_ZIEL, id: S_ID },
    ausfuehren: async (p, _k, w) => {
      if (p.ziel === 'system') {
        if (!ID_SYSTEM.test(p.id)) throw new FahnasFehler('E_PARAMS', 'System-Schnappschüsse haben eine Nummer als Kennung', { feld: 'id' });
        await w.system.ausfuehren('snapper', ['-c', 'root', 'delete', p.id]);
        return { id: p.id, geloescht: true };
      }
      await freigabeExistiert(w, p.ziel);
      const r = await freigabeSchnappschussLoeschen(w, p.ziel, p.id);
      if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
      return r;
    },
  });

  reg.aktion('snapshots.durchsuchen', {
    rolle: 'nutzer', beschreibung: 'Ordnerinhalt aus einem Schnappschuss einer Freigabe (nur lesen)',
    schema: { ziel: S_ZIEL, id: S_ID, pfad: R.pfad, sortierung: { typ: 'string', werte: ['name', 'groesse', 'geaendert', 'art'] }, absteigend: R.ja_nein, versteckte: R.ja_nein },
    ausfuehren: async (p, k, w) => {
      if (p.ziel === 'system') throw new FahnasFehler('E_PARAMS', 'System-Schnappschüsse lassen sich hier nicht durchsuchen', { feld: 'ziel' });
      const r = await freigabeHolen(w, p.ziel, k);
      pruefeId(p.id);
      const wurzel = path.join(pfadeVon(w).snapshots, p.ziel, p.id);
      if (!(await existiert(wurzel))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Schnappschuss ${p.id} gibt es nicht`, { feld: 'id' });
      const { rel } = await pfadVorpruefen(wurzel, p.pfad);
      // Ordnerrechte gelten nach heutigem Stand – ältere Schnappschüsse tragen auf der Platte noch die alten Rechte
      ordnerZugriff(r, rel);
      const aus = await helfer(w, k, 'snapshot_liste', { wurzel, pfad: rel, sortierung: p.sortierung, absteigend: !!p.absteigend, versteckte: !!p.versteckte });
      return { ...aus, eintraege: ordnerrechteMarkieren(aus.eintraege, r, rel), ziel: p.ziel, id: p.id, nur_lesen: true };
    },
  });

  reg.aktion('snapshots.zurueckholen', {
    rolle: 'nutzer', aufgabe: true, beschreibung: 'Dateien/Ordner aus einem Schnappschuss in die Freigabe kopieren',
    schema: { freigabe: R.freigabename, id: S_ID, pfade: { typ: 'array', pflicht: true, max: 1000, elemente: { typ: 'string', max: 4096 } }, ziel_pfad: R.pfad, ueberschreiben: R.ja_nein },
    ausfuehren: async (p, k, w, aufgabe) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      pruefeId(p.id);
      const wurzel = path.join(pfadeVon(w).snapshots, p.freigabe, p.id);
      if (!(await existiert(wurzel))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Schnappschuss ${p.id} gibt es nicht`, { feld: 'id' });
      const quellen = [];
      for (const q of p.pfade) quellen.push((await pfadVorpruefen(wurzel, q, 'pfade')).rel);
      for (const q of quellen) ordnerZugriff(r, q, false, 'pfade');
      const { rel: zielRel } = await pfadVorpruefen(r.wurzel, p.ziel_pfad, 'ziel_pfad');
      ordnerZugriff(r, zielRel, true, 'ziel_pfad');
      aufgabe.fortschritt(0, 'Zurückholen beginnt');
      const aus = await helferStrom(w, k, 'snapshot_zurueckholen', { wurzel, quellen, ziel_wurzel: r.wurzel, ziel_pfad: zielRel, ueberschreiben: !!p.ueberschreiben }, aufgabe);
      await ordnerrechteAngleichenUm(w, p.freigabe, [zielRel]);
      return { ...aus, anzahl: aus.uebertragen.length, freigabe: p.freigabe, id: p.id };
    },
  });

  reg.aktion('snapshots.zurueckrollen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Freigabe komplett auf einen Schnappschuss zurücksetzen (mit Sicherheits-Schnappschuss)',
    schema: { freigabe: R.freigabename, id: S_ID },
    ausfuehren: async (p, k, w, aufgabe) => {
      const f = await freigabeExistiert(w, p.freigabe);
      if (f.verbund || f.importiert) throw new FahnasFehler('E_PARAMS', `Bei ${f.verbund ? 'einem Speicherverbund' : 'einem übernommenen Ordner'} bitte einzelne Dateien oder Ordner zurückholen – das Zurücksetzen der ganzen Freigabe geht dort nicht`, { feld: 'freigabe' });
      return zurueckrollen(w, p.freigabe, p.id, k, aufgabe);
    },
  });

  reg.aktion('snapshots.system.startmenue', {
    rolle: 'admin', beschreibung: 'Schnappschuss-Einträge im Startmenü (grub-btrfs)',
    schema: {},
    ausfuehren: async () => {
      const datei = process.env.FAHNAS_GRUB_CFG || '/boot/grub/grub.cfg';
      let text;
      try { text = await fs.readFile(datei, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Das Startmenü (grub.cfg) wurde nicht gefunden', { datei });
        throw FahnasFehler.aus(e);
      }
      return { eintraege: startmenueParsen(text), experimentell: true, hinweis: STARTMENUE_HINWEIS };
    },
  });

  reg.aktion('snapshots.system.standard', {
    rolle: 'admin', beschreibung: 'Einen System-Schnappschuss zum dauerhaften Stand machen (Unterlaufwerk @ austauschen, Neustart nötig)',
    schema: { id: S_ID_SYSTEM },
    ausfuehren: async (p, _k, w) => systemStandard(w, p.id),
  });

  reg.aktion('snapshots.system.reste', {
    rolle: 'admin', beschreibung: 'Reste früherer System-Rückrollen (@_alt_<zeit> und @_kaputt_<zeit>) auf der Systempartition',
    schema: {},
    ausfuehren: async (_p, _k, w) => mitSystemLauf(() => mitPoolwurzel(w, async ({ sysroot, wurzel }) => ({ reste: await systemReste(sysroot, wurzel), wurzel, behalten: RESTE_BEHALTEN }))),
  });

  reg.aktion('snapshots.system.rest_loeschen', {
    rolle: 'admin', beschreibung: 'Einen Rest eines System-Rückrollens löschen (nie die laufende Wurzel)',
    schema: { name: S_REST },
    ausfuehren: async (p, _k, w) => systemRestLoeschen(w, p.name),
  });

  reg.aktion('snapshots.system.zurueck', {
    rolle: 'admin', beschreibung: 'System-Rückrollen rückgängig machen: Rest wieder zu @, aktuelles @ wird @_kaputt_<zeit> (Neustart nötig)',
    schema: { name: S_REST },
    ausfuehren: async (p, _k, w) => systemZurueck(w, p.name),
  });

  reg.aktion('snapshots.plan.lesen', {
    rolle: 'admin', beschreibung: 'Zeitpläne und Aufbewahrung lesen',
    schema: {},
    ausfuehren: async (_p, _k, w) => w.konfig.laden('snapshots.json'),
  });

  reg.aktion('snapshots.uebersicht', {
    rolle: 'admin', lesend: true, schema: {},
    beschreibung: 'Kachel „Schnappschüsse“: je Ziel (System + Freigaben mit Schnappschüssen) Anzahl, letzter und nächster laut Zeitplan',
    ausfuehren: async (_p, _k, w) => {
      const jetzt = uhr.jetzt();
      const plaene = new Map(((await w.konfig.laden('snapshots.json', {}))?.plaene || []).filter((x) => x && x.ziel).map((x) => [x.ziel, x]));
      const ziele = [];
      const eintrag = (ziel, liste) => {
        const letzter = liste.reduce((m, x) => (x.zeit && (!m || x.zeit > m) ? x.zeit : m), null);
        ziele.push({ ziel, anzahl: liste.length, letzter, naechster: naechsterTermin(plaene.get(ziel), jetzt) });
      };
      try { eintrag('system', await systemListe(w)); } catch { ziele.push({ ziel: 'system', anzahl: null, letzter: null, naechster: null, fehler: true }); }
      const shares = await w.konfig.laden('shares.json');
      for (const f of shares?.freigaben || []) {
        if (await ohneSchnappschuesse(w, f)) continue;
        try { eintrag(f.name, await freigabeSchnappschuesse(w, f.name)); } catch { ziele.push({ ziel: f.name, anzahl: null, letzter: null, naechster: null, fehler: true }); }
      }
      return { ziele };
    },
  });

  reg.aktion('snapshots.plan.setzen', {
    rolle: 'admin', beschreibung: 'Zeitplan und Aufbewahrung für ein Ziel setzen (rendert snapper / startet den Takt neu)',
    schema: { ziel: S_ZIEL, zeitplan: S_ZEITPLAN, behalten: S_BEHALTEN },
    ausfuehren: async (p, _k, w) => {
      if (p.ziel !== 'system') await freigabeExistiert(w, p.ziel);
      const eintrag = { ziel: p.ziel, zeitplan: p.zeitplan, behalten: p.behalten };
      await w.konfig.aendern('snapshots.json', (d) => {
        if (!Array.isArray(d.plaene)) d.plaene = [];
        const i = d.plaene.findIndex((x) => x && x.ziel === p.ziel);
        if (i >= 0) d.plaene[i] = eintrag; else d.plaene.push(eintrag);
      });
      const r = await anwenden(w);
      if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('snapshots');
      return { plan: eintrag, gerendert: r.gerendert };
    },
  });

  reg.aktion('snapshots.apply', {
    rolle: 'system', beschreibung: 'snapper rendern und internen Zeitplan starten (beim Start des Agenten und nach Planänderungen)',
    schema: {},
    ausfuehren: async (_p, _k, w) => anwenden(w),
  });
}
