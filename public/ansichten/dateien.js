// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dateimanager: Freigaben als Einstieg, Ordneransicht mit Brotkrumen, Liste/Kacheln, Sortierung, Mehrfachauswahl,
// Hoch-/Herunterladen, Ordner anlegen, Umbenennen, Verschieben/Kopieren (Zielwahl), Löschen in den Papierkorb,
// Papierkorb, Vorschau (Bild/Text/PDF/Video/Audio), Freigabelinks, Info. Kacheln zeigen für Bilder und Videos ein
// Vorschaubild (GET /api/dateien/vorschau, Symbol als Rückfall) und lassen sich per Schieberegler in sechs Stufen
// skalieren (je Gerät gemerkt). Routen: #/dateien, #/dateien/<freigabe>/<pfad>,
// #/dateien/<freigabe>/:papierkorb

import { el, t, symbol, format } from '../app.js';
import { BILD, VIDEO, dateiVersion, darstellungAendern } from '../tapeten.js';
import { linkAdresse } from '../links.js';
import { texteditorOeffnen } from '../texteditor.js';
import { ordnerWaehlen } from '../ordnerwahl.js';
import { artFuerImport, importAblauf } from '../office/import.js';
import { ordnerrechteDialog, gesperrtHinweis } from '../ordnerrechte.js';
import * as favoriten from '../favoriten.js';

const MAX_TEXT_VORSCHAU = 1024 * 1024;
const MAX_BILD_VORSCHAU = 64 * 1024 * 1024;
const MAX_PDF_VORSCHAU = 64 * 1024 * 1024;
const PARALLELE_UPLOADS = 2;
/** Automatische Wiederholung bei vorübergehenden Fehlern (Betreiber 12.10.2026): bis zu 3 neue Versuche, je nach 10 s. */
export const UPLOAD_WIEDERHOLUNGEN = 3;
export const UPLOAD_WIEDERHOLEN_MS = 10_000;

/** Lohnt ein neuer Versuch? Nur bei Netz-/Zeitfehlern, getrenntem Steuerdienst oder Serverfehlern – nie bei Namenskonflikt,
 *  fehlenden Rechten, vollem Speicher oder Abbruch (das ändert ein zweiter Versuch nicht). */
export function uploadVoruebergehend(e) {
  if (!e || e.code === 'E_ABGEBROCHEN') return false;
  const grund = e.details && e.details.grund;
  if (grund === 'netz' || grund === 'zeit') return true;
  if (e.code === 'E_AGENT') return true;
  return e.code === 'E_UNBEKANNT' && Number(e.status) >= 500;
}
const UPLOAD_TAFEL_SCHLIESSEN_MS = 5000; // nach dem letzten Upload: Erfolgreiche verschwinden, ohne Fehler schließt die Tafel
const MAX_TAFEL_ZEILEN = 30;
const PAPIERKORB_MARKE = ':papierkorb';
const MODUS_SCHLUESSEL = 'fahnas_dateien_modus';
const SORT_SCHLUESSEL = 'fahnas_dateien_sortierung';
const KACHEL_SCHLUESSEL = 'fahnas_dateien_kachelgroesse';
/** Mindestbreite einer Kachel je Stufe (px); Stufe 2 entspricht der bisherigen Kachelansicht (160 px auf dem Desktop). */
export const KACHEL_STUFEN = Object.freeze([96, 128, 160, 200, 260, 340]);
const KACHEL_STANDARD = 2;
/** Vorschaubild-Größen, die der Agent liefert (dateien.vorschau). */
export const VORSCHAU_GROESSEN = Object.freeze([128, 256, 512]);
const KACHEL_HINWEIS_SCHLUESSEL = 'fahnas_dateien_kachelgroesse_hinweis';
const KACHEL_NEUZEICHNEN_MS = 150; // Reglerbewegung bündeln: erst nach einer kurzen Ruhe die Kacheln mit schärferen Bildern neu zeichnen
/** Dateiendungen, für die der Agent Vorschaubilder erzeugt (gleiche Liste wie VORSCHAU_MUSTER in src/agent/aktionen/dateien.js). */
export const VORSCHAU_MUSTER = Object.freeze({
  bild: /\.(png|jpe?g|jpe|gif|webp|bmp|avif|tiff?|heic|heif|jxl|dng|cr2|nef|arw)$/i,
  video: /\.(mp4|m4v|webm|mov|ogv|mkv|avi|mts|m2ts|ts|wmv|flv|3gp|mpe?g)$/i,
});

const MUSTER = {
  bild: /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i,
  video: /\.(mp4|m4v|webm|mov|ogv|mkv)$/i,
  audio: /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|aiff?)$/i,
  text: /\.(txt|md|markdown|json|js|mjs|cjs|ts|css|html?|xml|ya?ml|csv|tsv|log|ini|conf|cfg|sh|bash|zsh|py|rb|go|rs|java|c|h|cpp|toml|env|sql|nfo|srt|vtt)$/i,
  pdf: /\.pdf$/i,
  archiv: /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst|iso|dmg)$/i,
  office: /\.(fahdoc|fahtab|fahboard)$/i, // Office-Bündel (Ordner)
};

/** Art eines Office-Bündels nach seiner Endung: 'dokument' | 'tabelle' | 'board' | null. */
export function officeArt(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.fahdoc')) return 'dokument';
  if (n.endsWith('.fahtab')) return 'tabelle';
  if (n.endsWith('.fahboard')) return 'board';
  return null;
}

/** Grobe Art eines Eintrags für Symbol und Vorschau. */
export function artVon(e) {
  if (!e) return 'datei';
  if (e.art === 'ordner') return MUSTER.office.test(String(e.name || '')) ? 'office' : 'ordner';
  const mime = String(e.mime || '');
  const name = String(e.name || '');
  if (mime.startsWith('image/') || MUSTER.bild.test(name)) return 'bild';
  if (mime.startsWith('video/') || MUSTER.video.test(name)) return 'video';
  if (mime.startsWith('audio/') || MUSTER.audio.test(name)) return 'audio';
  if (mime === 'application/pdf' || MUSTER.pdf.test(name)) return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || MUSTER.text.test(name)) return 'text';
  if (MUSTER.archiv.test(name) || /zip|tar|compressed|x-7z|x-rar/.test(mime)) return 'archiv';
  return 'datei';
}

/** Sortiert Einträge: Ordner zuerst, dann nach Feld (name|groesse|geaendert) auf-/absteigend. */
/**
 * Wiedergabeliste ab einer Datei: alle Dateien derselben Art (nur Audio bzw. nur Video) in der angezeigten Reihenfolge.
 * Gibt {dateien, pos} zurück; pos = Stelle der angeklickten Datei (Ordner-Durchhören ohne jedes Lied anzuklicken).
 */
export function wiedergabeliste(liste, start) {
  const art = artVon(start);
  const dateien = (liste || []).filter((x) => x && x.art !== 'ordner' && artVon(x) === art);
  const pos = dateien.findIndex((x) => x.name === start.name);
  return pos < 0 ? { dateien: [start], pos: 0 } : { dateien, pos };
}

export function sortiere(liste, feld = 'name', aufsteigend = true) {
  const r = aufsteigend ? 1 : -1;
  const vergleichName = (a, b) => String(a.name).localeCompare(String(b.name), 'de', { numeric: true, sensitivity: 'base' });
  return [...liste].sort((a, b) => {
    const ao = a.art === 'ordner' ? 0 : 1; const bo = b.art === 'ordner' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    let v = 0;
    if (feld === 'groesse') v = (a.art === 'ordner' && b.art === 'ordner') ? 0 : (Number(a.groesse) || 0) - (Number(b.groesse) || 0);
    else if (feld === 'geaendert') v = String(a.geaendert || '').localeCompare(String(b.geaendert || ''));
    if (v === 0) return vergleichName(a, b) * (feld === 'name' ? r : 1);
    return v * r;
  });
}

export function verbinde(pfad, name) { return pfad ? `${pfad}/${name}` : name; }

/**
 * Kleinste Vorschaubild-Größe, die eine Kachel der Stufe auf diesem Bildschirm scharf füllt: Kacheln dehnen sich im
 * Raster bis etwa 1,4 × Mindestbreite, hochauflösende Bildschirme brauchen das Vielfache (Pixelverhältnis, höchstens 3).
 */
export function vorschauGroesseFuer(stufe, pixelVerhaeltnis = 1) {
  const i = Math.max(0, Math.min(KACHEL_STUFEN.length - 1, Number(stufe) || 0));
  const dpr = Math.max(1, Math.min(3, Number(pixelVerhaeltnis) || 1));
  const noetig = KACHEL_STUFEN[i] * 1.4 * dpr;
  return VORSCHAU_GROESSEN.find((g) => g >= noetig) || VORSCHAU_GROESSEN[VORSCHAU_GROESSEN.length - 1];
}

/** Art für das Vorschaubild nach der Endung – 'bild' | 'video' | null (SVG/ICO u. a. bekommen keins, der Agent lehnte sie ab). */
export function vorschauArtVon(e) {
  if (!e || e.art === 'ordner') return null;
  const name = String(e.name || '');
  if (VORSCHAU_MUSTER.bild.test(name)) return 'bild';
  if (VORSCHAU_MUSTER.video.test(name)) return 'video';
  return null;
}

/** Versionskennung eines Eintrags für die Vorschau-URL (Browser-Cache): Änderungszeit + Größe. */
export function vorschauVersion(e) { const z = Date.parse(e && e.geaendert); return `${Number.isFinite(z) ? z : 0}-${Number(e && e.groesse) || 0}`; }

/**
 * Rechte aus dem Ergebnis von dateien.liste: `schreiben` (darf der Nutzer hier schreiben) und `papierkorb` (Freigabe hat
 * einen) schalten Hochladen, Neuer Ordner, Umbenennen, Verschieben, Löschen, Ablage und den Papierkorb-Knopf. Fehlt ein
 * Feld, gilt: schreiben erlaubt (der Agent lehnt notfalls ab), Papierkorb laut freigaben.liste.
 */
export function rechteAus(ergebnis, freigabeInfo) {
  const schreiben = !(ergebnis && ergebnis.schreiben === false);
  const papierkorb = ergebnis && typeof ergebnis.papierkorb === 'boolean' ? ergebnis.papierkorb : !(freigabeInfo && freigabeInfo.papierkorb === false);
  return { schreiben, papierkorb };
}

// ---------------------------------------------------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------------------------------------------------

let ctx = null;
let wurzel = null;
let freigabe = null;
let pfad = '';
let papierkorb = false;
let modus = 'liste';
let sortierung = { feld: 'name', auf: true };
let kachelStufe = KACHEL_STANDARD;
let kachelTimer = null;
const letzteVorschau = new Map(); // Kennung → zuletzt geladene Vorschau-URL: beim Größenwechsel bleibt das alte Bild, bis das schärfere da ist
let eintraege = [];
let auswahl = new Set();
let letzterIndex = -1;
let ladeNummer = 0;
let freigabenCache = null;
let rechte = { schreiben: true, papierkorb: true, freigabe: null };
let dateiEingabe = null;
const uploads = [];
let uploadTafel = null;
let uploadLaeuft = 0;
let uploadSitzung = 0; // zählt beim Abmelden hoch: Upload-Abläufe der alten Sitzung dürfen die neue nicht mehr berühren
let neuladenTimer = null;
const knoten = {};

function ladeEinstellungen() {
  try { const m = localStorage.getItem(MODUS_SCHLUESSEL); if (m === 'liste' || m === 'kacheln') modus = m; } catch { /* egal */ }
  try { const s = JSON.parse(localStorage.getItem(SORT_SCHLUESSEL) || 'null'); if (s && ['name', 'groesse', 'geaendert'].includes(s.feld)) sortierung = { feld: s.feld, auf: s.auf !== false }; } catch { /* egal */ }
  try { const roh = localStorage.getItem(KACHEL_SCHLUESSEL); const k = roh === null || roh === '' ? NaN : Number(roh); if (Number.isInteger(k) && k >= 0 && k < KACHEL_STUFEN.length) kachelStufe = k; } catch { /* egal */ }
}
function merkeEinstellungen() {
  try { localStorage.setItem(MODUS_SCHLUESSEL, modus); localStorage.setItem(SORT_SCHLUESSEL, JSON.stringify(sortierung)); localStorage.setItem(KACHEL_SCHLUESSEL, String(kachelStufe)); } catch { /* egal */ }
}
function vorschauGroesse() { return vorschauGroesseFuer(kachelStufe, typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1); }

function vollerPfad(e) { return verbinde(pfad, e.name); }

/** Bild/Video, das als Hintergrund taugt (gleiche Endungen wie die Tapeten-Auswahl). */
export function alsTapeteTauglich(e) { return !!(e && e.art === 'datei' && typeof e.name === 'string' && (BILD.test(e.name) || VIDEO.test(e.name))); }

/**
 * „Als Hintergrund einstellen“ (Betreiber 16.10.2026: „bei medien wäre es schön wenn man diese als wallpaper einstellen
 * könnte“): Tapete direkt aus der Freigabe (gelesen mit den Rechten des Nutzers), Hintergrund auf „Tapete“.
 */
async function alsHintergrund(e) {
  const tapete = { quelle: 'ordner', freigabe, pfad: vollerPfad(e), art: VIDEO.test(e.name) ? 'video' : 'bild', v: dateiVersion(e) };
  try {
    await darstellungAendern(ctx.nutzer.name, { hintergrund: 'tapete', tapete });
    ctx.melden(t('dateien.als_hintergrund_fertig', { name: e.name }), 'erfolg');
  } catch (f) { ctx.zeigeFehler(f); }
}
/** Auswahl-Kennung eines Eintrags: im Ordner der Name, im Papierkorb Vorgang+Pfad (Namen können sich doppeln). */
function kennung(e) { return e._schluessel ?? e.name; }
function ausgewaehlte() { return eintraege.filter((e) => auswahl.has(kennung(e))); }
function freigabeInfo() { return freigabenCache ? freigabenCache.find((f) => f.name === freigabe) : null; }
/** Ordnerrechte einstellbar? Nur Admins, nicht auf externen Laufwerken und nicht im App-Ordner (docker). */
function ordnerrechteMoeglich() {
  if (!ctx || ctx.rolle !== 'admin' || papierkorb) return false;
  const f = freigabeInfo();
  return !(f && (f.extern || f.system));
}

// ---------------------------------------------------------------------------------------------------------------------
// Freigaben (Einstieg)
// ---------------------------------------------------------------------------------------------------------------------

async function zeigeFreigaben() {
  const nummer = ++ladeNummer;
  wurzel.textContent = '';
  wurzel.appendChild(el('div', { class: 'ansicht-kopf' }, [el('h1', { text: t('dateien.titel') }), el('p', { class: 'schwach klein', text: t('dateien.freigaben_hinweis') })]));
  const behaelter = el('div', { class: 'dateien-freigaben' }, [el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')])]);
  wurzel.appendChild(behaelter);
  uploadTafelAnhaengen();
  let liste;
  try { liste = await ctx.api('freigaben.liste', { mit_system: ctx.rolle === 'admin' }); } catch (e) {
    if (nummer !== ladeNummer) return;
    behaelter.textContent = '';
    behaelter.appendChild(el('div', { class: 'leer' }, [symbol('warnung', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.freigaben_fehler') }), el('p', { class: 'leer-text', text: ctx.fehlerText(e) }), el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => zeigeFreigaben() }, t('rahmen.erneut'))]));
    return;
  }
  if (nummer !== ladeNummer) return;
  freigabenCache = Array.isArray(liste) ? liste : (liste && liste.freigaben) || [];
  behaelter.textContent = '';
  const sichtbar = freigabenCache.filter((f) => f && f.name);
  if (!sichtbar.length) {
    behaelter.appendChild(el('div', { class: 'leer' }, [symbol('freigaben', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.keine_freigaben') }), el('p', { class: 'leer-text', text: t(ctx.rolle === 'admin' ? 'dateien.keine_freigaben_admin' : 'dateien.keine_freigaben_nutzer') })]));
    return;
  }
  for (const f of sichtbar) {
    // Grenze: Kontingent der Freigabe, bei externen Laufwerken die Größe des Dateisystems (kapazitaet)
    const gesamt = f.groesse_gb ? Number(f.groesse_gb) * 1024 ** 3 : (Number(f.kapazitaet) > 0 ? Number(f.kapazitaet) : null);
    // null heißt „noch unbekannt“ – Number(null) wäre 0 und zeigte fälschlich „0 B belegt“
    const belegt = f.belegt != null && Number.isFinite(Number(f.belegt)) ? Number(f.belegt) : null;
    const prozent = gesamt && belegt != null ? Math.min(100, (belegt / gesamt) * 100) : null;
    const merkmale = [];
    if (f.gaeste) merkmale.push(el('span', { class: 'plakette', text: t('dateien.merkmal_gaeste') }));
    if (f.papierkorb) merkmale.push(el('span', { class: 'plakette', text: t('dateien.merkmal_papierkorb') }));
    if (f.timemachine) merkmale.push(el('span', { class: 'plakette', text: t('dateien.merkmal_timemachine') }));
    if (f.versteckt) merkmale.push(el('span', { class: 'plakette', text: t('dateien.merkmal_versteckt') }));
    if (f.system) merkmale.push(el('span', { class: 'plakette plakette-warnung', text: t('dateien.merkmal_system') }));
    behaelter.appendChild(el('a', { class: 'kachel dateien-freigabe', href: ctx.hashFuer('dateien', f.name) }, [
      el('div', { class: 'dateien-freigabe-kopf' }, [symbol(f.system ? 'apps' : 'freigaben'), el('span', { class: 'dateien-freigabe-name', text: f.name })]),
      f.beschreibung ? el('p', { class: 'dateien-freigabe-beschreibung', text: f.beschreibung }) : null,
      prozent != null ? balken(prozent) : null,
      el('p', { class: 'kachel-neben', text: belegt != null ? (gesamt ? t('dateien.belegt_von', { belegt: format.groesse(belegt), gesamt: format.groesse(gesamt) }) : t('dateien.belegt', { belegt: format.groesse(belegt) })) : '' }),
      merkmale.length ? el('div', { class: 'dateien-freigabe-merkmale' }, merkmale) : null,
    ]));
  }
}

function balken(prozent) {
  const p = Math.max(0, Math.min(100, prozent));
  return el('div', { class: `fortschritt${p >= 95 ? ' gefahr' : p >= 85 ? ' warnung' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)) }, [el('div', { class: 'fortschritt-balken', style: { '--anteil': `${p}%` } })]);
}

async function freigabenNachladen() {
  if (freigabenCache) return;
  try { const l = await ctx.api('freigaben.liste', { mit_system: ctx.rolle === 'admin' }); freigabenCache = Array.isArray(l) ? l : (l && l.freigaben) || []; } catch { freigabenCache = null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ordneransicht
// ---------------------------------------------------------------------------------------------------------------------

function brotkrumen() {
  const teile = pfad ? pfad.split('/') : [];
  const liste = el('ol', { class: 'brotkrumen', 'aria-label': t('dateien.pfad') });
  const glied = (text, href, aktuell, symbolName) => el('li', {}, [
    symbolName ? symbol(symbolName, 'klein') : null,
    aktuell ? el('span', { 'aria-current': 'page', text }) : el('a', { href, text }),
    aktuell ? null : symbol('weiter', 'klein'),
  ]);
  liste.appendChild(glied(t('dateien.titel'), ctx.hashFuer('dateien'), false, 'dateien'));
  const wurzelAktuell = !teile.length && !papierkorb;
  liste.appendChild(glied(freigabe, ctx.hashFuer('dateien', freigabe), wurzelAktuell));
  if (papierkorb) { liste.appendChild(glied(t('dateien.papierkorb'), '', true, 'papierkorb')); return liste; }
  let sichtbar = teile.map((name, i) => ({ name, i }));
  if (teile.length > 3) sichtbar = [sichtbar[0], { name: '…', i: -1 }, ...sichtbar.slice(-2)];
  for (const { name, i } of sichtbar) {
    if (i < 0) { liste.appendChild(el('li', {}, [el('span', { text: '…' }), symbol('weiter', 'klein')])); continue; }
    const aktuell = i === teile.length - 1;
    liste.appendChild(glied(name, ctx.hashFuer('dateien', freigabe, teile.slice(0, i + 1).join('/')), aktuell));
  }
  return liste;
}

/** Stern neben den Brotkrumen: gefüllt = dieser Ordner ist Favorit (Navigation „Favoriten“, Übersicht). */
function sternSetzen() {
  const k = knoten.sternKnopf; if (!k) return;
  const an = favoriten.ist(freigabe, pfad);
  const text = t(an ? 'dateien.favorit_weg' : 'dateien.favorit_hinzu');
  k.title = text; k.setAttribute('aria-label', text); k.setAttribute('aria-pressed', an ? 'true' : 'false');
  k.classList.toggle('aktiv', an);
  k.textContent = ''; k.appendChild(symbol(an ? 'stern-voll' : 'stern'));
}

async function favoritUmschalten(f, p) {
  try {
    const name = p ? p.split('/').pop() : f;
    const an = await favoriten.umschalten(f, p);
    ctx.melden(t(an ? 'dateien.favorit_hinzugefuegt' : 'dateien.favorit_entfernt', { name }), 'erfolg');
  } catch (e) {
    if (e && e.code === 'E_ZU_VIELE') ctx.melden(t('dateien.favorit_zu_viele', { n: favoriten.MAX }), 'fehler'); else ctx.zeigeFehler(e);
  }
  sternSetzen();
}

async function favoritenMehrere(ordner, an) {
  try {
    const n = await favoriten.setzen(ordner.map((e) => ({ freigabe, pfad: vollerPfad(e) })), an);
    ctx.melden(t(an ? 'dateien.favoriten_hinzugefuegt' : 'dateien.favoriten_entfernt', { n }), 'erfolg');
  } catch (e) {
    if (e && e.code === 'E_ZU_VIELE') ctx.melden(t('dateien.favorit_zu_viele', { n: favoriten.MAX }), 'fehler'); else ctx.zeigeFehler(e);
  }
  zeigeAuswahlleiste();
  sternSetzen();
}

function werkzeugKnopf(symbolName, text, onclick, extra = {}) {
  return el('button', { class: `knopf knopf-zweit ${extra.class || ''}`.trim(), type: 'button', title: text, 'aria-label': text, onclick, disabled: extra.disabled }, [symbol(symbolName), el('span', { class: 'knopf-text', text })]);
}

function baueLeiste() {
  const leiste = el('div', { class: 'dateien-leiste' });
  const zurueck = pfad ? ctx.hashFuer('dateien', freigabe, pfad.split('/').slice(0, -1).join('/')) : ctx.hashFuer('dateien');
  knoten.sternKnopf = papierkorb ? null : el('button', { class: 'knopf-symbol dateien-stern', type: 'button', onclick: () => favoritUmschalten(freigabe, pfad) });
  sternSetzen();
  leiste.appendChild(el('div', { class: 'dateien-leiste-oben' }, [
    el('a', { class: 'knopf-symbol', href: papierkorb ? ctx.hashFuer('dateien', freigabe) : zurueck, title: t('dateien.zurueck'), 'aria-label': t('dateien.zurueck') }, [symbol('zurueck')]),
    brotkrumen(),
    knoten.sternKnopf,
  ]));
  const werkzeuge = el('div', { class: 'dateien-werkzeuge' });
  if (!papierkorb) {
    knoten.hochladenKnopf = werkzeugKnopf('hochladen', t('dateien.hochladen'), () => hochladenWaehlen());
    knoten.ordnerHochladenKnopf = werkzeugKnopf('hochladen', t('dateien.ordner_hochladen'), () => ordnerHochladenWaehlen());
    knoten.ordnerKnopf = werkzeugKnopf('neuer-ordner', t('dateien.neuer_ordner'), () => neuerOrdner());
    knoten.papierkorbKnopf = werkzeugKnopf('papierkorb', t('dateien.papierkorb'), () => ctx.navigiere(ctx.hashFuer('dateien', freigabe, PAPIERKORB_MARKE)));
    werkzeuge.appendChild(knoten.hochladenKnopf);
    werkzeuge.appendChild(knoten.ordnerHochladenKnopf);
    werkzeuge.appendChild(knoten.ordnerKnopf);
    werkzeuge.appendChild(knoten.papierkorbKnopf);
    // Ordnerrechte des geöffneten Ordners (nur Admins, nicht in der Freigabe-Wurzel – dort gelten die Freigabe-Rechte)
    if (pfad && ordnerrechteMoeglich()) werkzeuge.appendChild(werkzeugKnopf('schloss', t('dateien.ordnerrechte'), () => ordnerrechteDialog(ctx, { freigabe, pfad, name: pfad.split('/').pop(), nachher: () => ladeListe() })));
    rechteAnwenden();
    const rechts = el('div', { class: 'dateien-werkzeuge-rechts' });
    const auswahlFeld = el('select', { class: 'eingabe eingabe-klein', 'aria-label': t('dateien.sortieren_nach'), onchange: (ev) => { sortierung.feld = ev.target.value; merkeEinstellungen(); zeigeListe(); } }, [
      el('option', { value: 'name', text: t('dateien.spalte_name'), selected: sortierung.feld === 'name' }),
      el('option', { value: 'groesse', text: t('dateien.spalte_groesse'), selected: sortierung.feld === 'groesse' }),
      el('option', { value: 'geaendert', text: t('dateien.spalte_geaendert'), selected: sortierung.feld === 'geaendert' }),
    ]);
    const richtung = el('button', { class: 'knopf-symbol', type: 'button', title: t(sortierung.auf ? 'dateien.aufsteigend' : 'dateien.absteigend'), 'aria-label': t(sortierung.auf ? 'dateien.aufsteigend' : 'dateien.absteigend'), onclick: () => { sortierung.auf = !sortierung.auf; merkeEinstellungen(); richtung.title = t(sortierung.auf ? 'dateien.aufsteigend' : 'dateien.absteigend'); richtung.setAttribute('aria-label', richtung.title); richtung.textContent = ''; richtung.appendChild(symbol(sortierung.auf ? 'hoch' : 'sortierung')); zeigeListe(); } }, [symbol(sortierung.auf ? 'hoch' : 'sortierung')]);
    rechts.appendChild(el('span', { class: 'dateien-sortierung' }, [auswahlFeld, richtung]));
    const listeKnopf = el('button', { class: `knopf-symbol${modus === 'liste' ? ' aktiv' : ''}`, type: 'button', title: t('dateien.ansicht_liste'), 'aria-label': t('dateien.ansicht_liste'), 'aria-pressed': modus === 'liste' ? 'true' : 'false', onclick: () => setzeModus('liste') }, [symbol('liste')]);
    const kachelKnopf = el('button', { class: `knopf-symbol${modus === 'kacheln' ? ' aktiv' : ''}`, type: 'button', title: t('dateien.ansicht_kacheln'), 'aria-label': t('dateien.ansicht_kacheln'), 'aria-pressed': modus === 'kacheln' ? 'true' : 'false', onclick: () => setzeModus('kacheln') }, [symbol('kacheln')]);
    knoten.listeKnopf = listeKnopf; knoten.kachelKnopf = kachelKnopf;
    rechts.appendChild(listeKnopf); rechts.appendChild(kachelKnopf);
    knoten.kachelgroesse = baueKachelgroesse();
    rechts.appendChild(knoten.kachelgroesse);
    werkzeuge.appendChild(rechts);
  } else {
    werkzeuge.appendChild(werkzeugKnopf('wiederherstellen', t('dateien.wiederherstellen'), () => wiederherstellen(ausgewaehlte()), { class: 'dateien-knopf-wiederherstellen', disabled: true }));
    werkzeuge.appendChild(werkzeugKnopf('loeschen', t('dateien.papierkorb_leeren'), () => papierkorbLeeren(), { class: 'knopf-gefahr' }));
  }
  leiste.appendChild(werkzeuge);
  knoten.auswahlleiste = el('div', { class: 'dateien-auswahlleiste', hidden: true });
  leiste.appendChild(knoten.auswahlleiste);
  return leiste;
}

/** Knöpfe nach den Rechten aus dateien.liste schalten (Nur-Lese-Nutzer sehen keine Schreibaktionen, ohne Papierkorb keinen Papierkorb-Knopf). */
function rechteAnwenden() {
  if (knoten.hochladenKnopf) knoten.hochladenKnopf.hidden = !rechte.schreiben;
  if (knoten.ordnerHochladenKnopf) knoten.ordnerHochladenKnopf.hidden = !rechte.schreiben;
  if (knoten.ordnerKnopf) knoten.ordnerKnopf.hidden = !rechte.schreiben;
  if (knoten.papierkorbKnopf) knoten.papierkorbKnopf.hidden = !rechte.papierkorb;
  if (knoten.bereich) knoten.bereich.classList.toggle('dateien-nur-lesen', !rechte.schreiben);
}

function setzeModus(m) {
  modus = m; merkeEinstellungen();
  if (knoten.listeKnopf) { knoten.listeKnopf.classList.toggle('aktiv', m === 'liste'); knoten.listeKnopf.setAttribute('aria-pressed', m === 'liste' ? 'true' : 'false'); }
  if (knoten.kachelKnopf) { knoten.kachelKnopf.classList.toggle('aktiv', m === 'kacheln'); knoten.kachelKnopf.setAttribute('aria-pressed', m === 'kacheln' ? 'true' : 'false'); }
  if (knoten.kachelgroesse) knoten.kachelgroesse.hidden = m !== 'kacheln';
  zeigeListe();
}

/**
 * Schieberegler für die Kachelgröße – nur in der Kachelansicht sichtbar. Kleiner = mehr Dateien auf einmal, größer =
 * mehr vom Bild; Erklärung als Tooltip und für Vorlesehilfen (aria-valuetext), gemerkt je Gerät (localStorage).
 */
function baueKachelgroesse() {
  const max = KACHEL_STUFEN.length - 1;
  const stufenText = () => t('dateien.kachelgroesse_stufe', { n: kachelStufe + 1, max: max + 1 });
  const regler = el('input', { type: 'range', class: 'dateien-kachelgroesse-regler', min: '0', max: String(max), step: '1', value: String(kachelStufe), 'aria-label': t('dateien.kachelgroesse'), 'aria-valuetext': stufenText(), 'aria-describedby': 'dateien-kachelgroesse-erklaerung', title: t('dateien.kachelgroesse_erklaerung') });
  regler.addEventListener('input', () => { setzeKachelgroesse(Number(regler.value)); regler.setAttribute('aria-valuetext', stufenText()); kachelHinweisEinmal(); });
  return el('label', { class: 'dateien-kachelgroesse', hidden: modus !== 'kacheln', title: t('dateien.kachelgroesse_erklaerung') }, [
    symbol('kacheln', 'klein'), el('span', { class: 'nur-lesen', text: t('dateien.kachelgroesse') }), regler,
    // Erklärung für Vorlesehilfen (title-Tooltips gibt es auf dem Handy nicht); sichtbar einmalig als Hinweis beim ersten Verstellen
    el('span', { id: 'dateien-kachelgroesse-erklaerung', class: 'nur-lesen', text: t('dateien.kachelgroesse_erklaerung') }),
  ]);
}

/** Beim ersten Verstellen je Gerät einmal erklären, was der Regler tut (Betreiber-Vorgabe „Info bei jeder Einstellung“). */
function kachelHinweisEinmal() {
  let gezeigt = false;
  try { gezeigt = localStorage.getItem(KACHEL_HINWEIS_SCHLUESSEL) === '1'; } catch { /* egal */ }
  if (gezeigt || !ctx || typeof ctx.melden !== 'function') return;
  try { localStorage.setItem(KACHEL_HINWEIS_SCHLUESSEL, '1'); } catch { /* egal */ }
  ctx.melden(t('dateien.kachelgroesse_erklaerung'), 'info', 8000);
}

function setzeKachelgroesse(stufe) {
  const neu = Math.max(0, Math.min(KACHEL_STUFEN.length - 1, Number(stufe) || 0));
  if (neu === kachelStufe) return;
  const vorher = vorschauGroesse();
  kachelStufe = neu; merkeEinstellungen();
  if (knoten.raster) knoten.raster.style.setProperty('--dateien-kachel-min', `${KACHEL_STUFEN[kachelStufe]}px`);
  // Größere Kacheln brauchen ein schärferes Vorschaubild → nach kurzer Ruhe neu zeichnen (die alten Bilder bleiben stehen,
  // bis die schärferen geladen sind – siehe kachelBild); beim Ziehen über mehrere Stufen nur einmal
  if (modus === 'kacheln' && vorschauGroesse() !== vorher) {
    clearTimeout(kachelTimer);
    kachelTimer = setTimeout(() => { kachelTimer = null; if (knoten.bereich && modus === 'kacheln') zeigeListe(); }, KACHEL_NEUZEICHNEN_MS);
  }
}

async function zeigeOrdner() {
  const nummer = ++ladeNummer;
  wurzel.textContent = '';
  auswahl = new Set(); letzterIndex = -1;
  // Rechte gelten je Freigabe – bei einer anderen Freigabe bis zur Antwort von dateien.liste wieder mit Vollansicht starten
  if (rechte.freigabe !== freigabe) rechte = { schreiben: true, papierkorb: true, freigabe };
  wurzel.appendChild(baueLeiste());
  const bereich = el('div', { class: 'dateien-bereich', 'data-ablage-text': t('dateien.ablage_hinweis'), tabindex: '-1' });
  knoten.bereich = bereich;
  wurzel.appendChild(bereich);
  ablageEinrichten(bereich);
  bereich.addEventListener('keydown', tastatur);
  bereich.appendChild(el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')]));
  uploadTafelAnhaengen();
  ctx.setzeTitel(`${freigabe}${pfad ? '/' + pfad : ''} – ${t('dateien.titel')}`);
  freigabenNachladen();
  await ladeListe(nummer);
}

async function ladeListe(nummer = ++ladeNummer) {
  let ergebnis;
  try { ergebnis = await ctx.api('dateien.liste', { freigabe, pfad }); } catch (e) {
    if (nummer !== ladeNummer || !knoten.bereich) return;
    knoten.bereich.textContent = '';
    const zurueck = pfad ? ctx.hashFuer('dateien', freigabe, pfad.split('/').slice(0, -1).join('/')) : ctx.hashFuer('dateien');
    if (e && e.details && e.details.gesperrt) {
      // direkt aufgerufener gesperrter Ordner (Lesezeichen, alter Link): gleiche Meldung wie beim Klick
      knoten.bereich.appendChild(el('div', { class: 'leer' }, [symbol('schloss', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.nicht_freigegeben') }), el('p', { class: 'leer-text', text: t('dateien.nicht_freigegeben_text', { name: pfad.split('/').pop() }) }), el('div', { class: 'knopf-reihe' }, [el('a', { class: 'knopf knopf-zweit', href: zurueck }, t('dateien.zurueck'))])]));
      return;
    }
    knoten.bereich.appendChild(el('div', { class: 'leer' }, [symbol('warnung', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.liste_fehler') }), el('p', { class: 'leer-text', text: ctx.fehlerText(e) }), el('div', { class: 'knopf-reihe' }, [el('a', { class: 'knopf knopf-zweit', href: zurueck }, t('dateien.zurueck')), el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => ladeListe() }, t('rahmen.erneut'))])]));
    return;
  }
  if (nummer !== ladeNummer) return;
  const liste = Array.isArray(ergebnis) ? ergebnis : (ergebnis && ergebnis.eintraege) || [];
  eintraege = liste.filter((e) => e && typeof e.name === 'string');
  rechte = { ...rechteAus(Array.isArray(ergebnis) ? null : ergebnis, freigabeInfo()), freigabe };
  rechteAnwenden();
  for (const n of [...auswahl]) if (!eintraege.some((e) => kennung(e) === n)) auswahl.delete(n);
  ordnerGroessen.clear();
  zeigeListe();
  ordnerGroessenLaden(nummer);
}

// ---- Ordnergrößen (Betreiber 15.10.2026: „bei ext. festplatten sieht man die ordnergröße nicht“) --------------------
// Nach dem Laden rechnet der Agent je Ordnerzeile die Größe aus (dateien.ordnergroesse, mit den Rechten des Nutzers,
// höchstens 20 s je Ordner); zwei Anfragen gleichzeitig, die Zelle füllt sich, sobald der Wert da ist.
const ordnerGroessen = new Map(); // Name → {groesse, dateien, ordner, vollstaendig} | {fehler:true}

/** Text der Größenzelle eines Ordners: „…“ (rechnet), „–“ (unlesbar), sonst Größe, bei Abbruch mit „≥“. */
export function ordnerGroesseText(r, fmt = format.groesse) {
  if (!r) return '…';
  if (r.fehler || typeof r.groesse !== 'number') return '–';
  return `${r.vollstaendig === false ? '≥ ' : ''}${fmt(r.groesse)}`;
}

function ordnerGroesseZelle(td, r) {
  td.textContent = ordnerGroesseText(r);
  if (r && !r.fehler && typeof r.groesse === 'number') td.title = t(r.vollstaendig === false ? 'dateien.ordner_inhalt_teil' : 'dateien.ordner_inhalt', { dateien: r.dateien, ordner: r.ordner });
  else td.removeAttribute('title');
}

function ordnerGroessenLaden(nummer) {
  if (papierkorb) return;
  const fg = freigabe; const basis = pfad;
  const namen = eintraege.filter((e) => e.art === 'ordner' && !e.gesperrt).map((e) => e.name);
  let i = 0;
  const arbeiter = async () => {
    while (i < namen.length && nummer === ladeNummer) {
      const name = namen[i++];
      let r;
      try { r = await ctx.api('dateien.ordnergroesse', { freigabe: fg, pfad: verbinde(basis, name) }); } catch { r = { fehler: true }; }
      if (nummer !== ladeNummer || !knoten.bereich) return;
      ordnerGroessen.set(name, r);
      const zeile = [...knoten.bereich.querySelectorAll('tr[data-name]')].find((z) => z.dataset.name === name);
      const td = zeile && zeile.querySelector('.dateien-groesse');
      if (td) ordnerGroesseZelle(td, r);
    }
  };
  arbeiter(); arbeiter();
}

function sichtbareEintraege() { return sortiere(eintraege, sortierung.feld, sortierung.auf); }

function zeigeListe() {
  const b = knoten.bereich; if (!b) return;
  b.textContent = '';
  const liste = sichtbareEintraege();
  if (!liste.length) {
    b.appendChild(el('div', { class: 'leer' }, [symbol('ordner', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.leer') }), el('p', { class: 'leer-text', text: t('dateien.leer_hinweis') })]));
    zeigeAuswahlleiste(); return;
  }
  b.appendChild(modus === 'kacheln' ? baueKacheln(liste) : baueTabelle(liste));
  zeigeAuswahlleiste();
}

function zeileKlick(ev, e, index, liste) {
  if (ev.shiftKey && letzterIndex >= 0) {
    ev.preventDefault();
    const [von, bis] = [Math.min(letzterIndex, index), Math.max(letzterIndex, index)];
    for (let i = von; i <= bis; i++) auswahl.add(kennung(liste[i]));
    zeigeListe(); fokusAuf(index); return;
  }
  if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); umschalten(kennung(e)); letzterIndex = index; zeigeListe(); fokusAuf(index); return; }
  letzterIndex = index;
  oeffnen(e);
}

function umschalten(name) { if (auswahl.has(name)) auswahl.delete(name); else auswahl.add(name); }

function fokusAuf(index) {
  const b = knoten.bereich; if (!b) return;
  const ziele = b.querySelectorAll('[data-index]');
  const z = ziele[index]; if (z) { for (const x of ziele) x.tabIndex = -1; z.tabIndex = 0; z.focus(); }
}

function wahlKasten(e, index, liste) {
  // Nur der Klick trägt shiftKey – das change-Ereignis nicht. Die Liste wird danach neu gezeichnet (Zustand = Wahrheit).
  return el('input', { type: 'checkbox', checked: auswahl.has(kennung(e)), 'aria-label': t('dateien.auswaehlen', { name: e.name }), onclick: (ev) => {
    ev.stopPropagation();
    if (ev.shiftKey && letzterIndex >= 0) { const [von, bis] = [Math.min(letzterIndex, index), Math.max(letzterIndex, index)]; for (let i = von; i <= bis; i++) auswahl.add(kennung(liste[i])); }
    else umschalten(kennung(e));
    letzterIndex = index;
    (papierkorb ? zeigePapierkorbListe : zeigeListe)();
    fokusAuf(index);
  } });
}

function eintragSymbol(e) {
  if (e && e.gesperrt) return symbol('schloss');
  const art = artVon(e);
  if (art === 'office') return symbol(officeArt(e.name));
  return symbol(art === 'ordner' ? 'ordner' : art === 'bild' ? 'bild' : art === 'video' ? 'video' : art === 'audio' ? 'audio' : art === 'pdf' ? 'pdf' : art === 'text' ? 'text' : art === 'archiv' ? 'archiv' : 'datei');
}

function baueTabelle(liste) {
  const alle = liste.length > 0 && liste.every((e) => auswahl.has(kennung(e)));
  const kopfKasten = el('input', { type: 'checkbox', checked: alle, 'aria-label': t('dateien.alle_auswaehlen'), onchange: () => { if (alle) auswahl.clear(); else for (const e of liste) auswahl.add(kennung(e)); zeigeListe(); } });
  const sortKopf = (feld, text) => {
    const aktiv = sortierung.feld === feld;
    return el('th', { scope: 'col', 'aria-sort': aktiv ? (sortierung.auf ? 'ascending' : 'descending') : undefined, class: feld === 'groesse' ? 'zahl' : undefined }, [
      el('button', { type: 'button', onclick: () => { if (aktiv) sortierung.auf = !sortierung.auf; else { sortierung.feld = feld; sortierung.auf = true; } merkeEinstellungen(); const s = wurzel.querySelector('.dateien-sortierung select'); if (s) s.value = sortierung.feld; zeigeListe(); } }, [text, aktiv ? symbol(sortierung.auf ? 'hoch' : 'sortierung') : null]),
    ]);
  };
  const tabelle = el('table', { class: 'tabelle tabelle-karten dateien-tabelle dateien-tabelle-ordner' }, [
    el('thead', {}, [el('tr', {}, [el('th', { class: 'dateien-spalte-wahl', scope: 'col' }, [kopfKasten]), sortKopf('name', t('dateien.spalte_name')), sortKopf('groesse', t('dateien.spalte_groesse')), sortKopf('geaendert', t('dateien.spalte_geaendert')), el('th', { scope: 'col', class: 'schmal' }, [el('span', { class: 'nur-lesen', text: t('dateien.aktionen') })])])]),
  ]);
  const koerper = el('tbody', { role: 'listbox', 'aria-multiselectable': 'true' });
  liste.forEach((e, index) => {
    const ordner = e.art === 'ordner';
    const zeile = el('tr', { class: `${ordner ? 'ordner' : 'datei'}${e.gesperrt ? ' gesperrt' : ''}`, 'aria-selected': auswahl.has(kennung(e)) ? 'true' : 'false', 'data-index': index, 'data-name': e.name, tabindex: index === 0 ? '0' : '-1', ondblclick: (ev) => { ev.preventDefault(); oeffnen(e); } }, [
      el('td', { class: 'dateien-wahl' }, [wahlKasten(e, index, liste)]),
      el('td', { class: 'dateien-name', 'data-label': t('dateien.spalte_name') }, [el('span', { class: `dateien-eintrag-name ${ordner ? 'ordner' : ''}` }, [eintragSymbol(e), el('button', { type: 'button', class: 'dateien-eintrag-text', onclick: (ev) => zeileKlick(ev, e, index, liste) }, e.name), ...ordnerrechtMarken(e)])]),
      (() => { const td = el('td', { class: 'dateien-groesse zahl', 'data-label': t('dateien.spalte_groesse'), text: ordner ? '' : format.groesse(e.groesse) }); if (ordner) ordnerGroesseZelle(td, papierkorb || e.gesperrt ? { fehler: true } : ordnerGroessen.get(e.name)); return td; })(),
      el('td', { class: 'dateien-datum', 'data-label': t('dateien.spalte_geaendert'), title: format.zeitGenau(e.geaendert), text: format.zeit(e.geaendert) }),
      el('td', { class: 'dateien-aktionen' }, [el('button', { class: 'knopf-symbol', type: 'button', title: t('dateien.aktionen'), 'aria-label': t('dateien.aktionen_fuer', { name: e.name }), onclick: (ev) => { ev.stopPropagation(); aktionenMenue(e); } }, [symbol('menue')])]),
    ]);
    zeile.addEventListener('click', (ev) => { if (ev.target.closest('button, input, a')) return; if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { zeileKlick(ev, e, index, liste); return; } letzterIndex = index; umschalten(kennung(e)); zeigeListe(); fokusAuf(index); });
    koerper.appendChild(zeile);
  });
  tabelle.appendChild(koerper);
  return tabelle;
}

/**
 * Bildfeld einer Kachel: immer das Symbol der Art; Bilder und Videos (Endungen laut VORSCHAU_MUSTER) laden darüber ein
 * Vorschaubild vom Agenten (lazy, Fehler → das Symbol bleibt). Ein Bild aus dem Browser-Cache gilt sofort als geladen (kein
 * Flackern beim Neuzeichnen); beim Größenwechsel bleibt das zuletzt geladene Bild stehen, das schärfere wird vorgeladen und
 * dann getauscht. Videos bekommen ein Abspiel-Zeichen. Im Papierkorb gibt es keine Vorschau.
 */
function kachelBild(e, groesse) {
  const art = artVon(e);
  const feld = el('div', { class: `dateien-kachel-bild art-${art}` }, [eintragSymbol(e)]);
  const vArt = vorschauArtVon(e);
  if (vArt && !papierkorb && ctx && typeof ctx.vorschauUrl === 'function') {
    const kenn = `${freigabe}/${vollerPfad(e)}|${vorschauVersion(e)}`;
    const neu = ctx.vorschauUrl(freigabe, vollerPfad(e), groesse, vorschauVersion(e));
    const alt = letzteVorschau.get(kenn);
    const bild = el('img', { class: 'dateien-kachel-vorschau', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    bild.addEventListener('load', () => { feld.classList.add('geladen'); if (letzteVorschau.size > 5000) letzteVorschau.clear(); letzteVorschau.set(kenn, bild.getAttribute('src')); });
    bild.addEventListener('error', () => { bild.remove(); feld.classList.remove('geladen'); });
    if (alt && alt !== neu && typeof Image === 'function') {
      bild.setAttribute('src', alt); // liegt im Browser-Cache → sofort sichtbar
      const lader = new Image();
      lader.addEventListener('load', () => { if (bild.isConnected) bild.setAttribute('src', neu); });
      lader.src = neu;
    } else {
      bild.setAttribute('src', neu);
    }
    feld.appendChild(bild);
    if (bild.complete && bild.naturalWidth > 0) feld.classList.add('geladen'); // Cache-Treffer: das load-Ereignis käme erst nach dem nächsten Bild
    if (vArt === 'video') feld.appendChild(el('span', { class: 'dateien-kachel-abspielen', 'aria-hidden': 'true' }, [symbol('video', 'klein')]));
  }
  return feld;
}

function baueKacheln(liste) {
  const raster = el('div', { class: 'dateien-kacheln', role: 'listbox', 'aria-multiselectable': 'true', style: { '--dateien-kachel-min': `${KACHEL_STUFEN[kachelStufe]}px` } });
  knoten.raster = raster;
  const groesse = vorschauGroesse();
  liste.forEach((e, index) => {
    const ordner = e.art === 'ordner';
    const kachel = el('div', { class: `dateien-kachel ${ordner ? 'ordner' : ''}${e.gesperrt ? ' gesperrt' : ''}`, role: 'option', 'aria-selected': auswahl.has(kennung(e)) ? 'true' : 'false', 'data-index': index, 'data-name': e.name, tabindex: index === 0 ? '0' : '-1', title: e.name, ondblclick: (ev) => { ev.preventDefault(); oeffnen(e); } }, [
      wahlKasten(e, index, liste),
      kachelBild(e, groesse),
      el('span', { class: 'dateien-kachel-name', text: e.name }),
      el('span', { class: 'dateien-kachel-neben', text: ordner ? format.zeit(e.geaendert) : format.groesse(e.groesse) }, ordnerrechtMarken(e)),
    ]);
    kachel.addEventListener('click', (ev) => { if (ev.target.closest('input')) return; zeileKlick(ev, e, index, liste); });
    kachel.addEventListener('contextmenu', (ev) => { ev.preventDefault(); aktionenMenue(e); });
    raster.appendChild(kachel);
  });
  return raster;
}

function zeigeAuswahlleiste() {
  const l = knoten.auswahlleiste; if (!l) return;
  const gewaehlt = ausgewaehlte();
  if (papierkorb) {
    const k = wurzel.querySelector('.dateien-knopf-wiederherstellen'); if (k) k.disabled = !gewaehlt.length;
  }
  if (!gewaehlt.length) { l.hidden = true; l.textContent = ''; return; }
  l.hidden = false; l.textContent = '';
  l.appendChild(el('span', { class: 'dateien-auswahl-text', text: t('dateien.ausgewaehlt', { n: gewaehlt.length }) }));
  if (papierkorb) {
    l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => wiederherstellen(gewaehlt) }, [symbol('wiederherstellen'), t('dateien.wiederherstellen')]));
  } else {
    const einer = gewaehlt.length === 1 ? gewaehlt[0] : null;
    l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => herunterladen(gewaehlt) }, [symbol('herunterladen'), t('dateien.herunterladen')]));
    // Verschieben/Umbenennen/Löschen ändern die Quelle → nur mit Schreibrecht; Kopieren liest nur (Ziel prüft der Agent)
    if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => verschiebenKopieren('verschieben', gewaehlt) }, [symbol('verschieben'), t('dateien.verschieben')]));
    l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => verschiebenKopieren('kopieren', gewaehlt) }, [symbol('kopieren'), t('dateien.kopieren')]));
    // Einer → normal umbenennen; mehrere → fortlaufend „Name (01)“, „Name (02)“ … (Betreiber 12.10.2026)
    if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => (einer ? umbenennen(einer) : umbenennenSerie()) }, [symbol('umbenennen'), t('dateien.umbenennen')]));
    // Markierte Ordner (einer oder mehrere) zu den Favoriten bzw. heraus, wenn alle schon Favoriten sind
    const ordnerGewaehlt = gewaehlt.filter((x) => x.art === 'ordner');
    if (ordnerGewaehlt.length) {
      const alleSchon = ordnerGewaehlt.every((x) => favoriten.ist(freigabe, vollerPfad(x)));
      l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => favoritenMehrere(ordnerGewaehlt, !alleSchon) },
        [symbol(alleSchon ? 'stern-voll' : 'stern'), t(alleSchon ? 'dateien.favorit_weg_kurz' : 'dateien.favorit_hinzu_kurz')]));
    }
    if (einer && alsTapeteTauglich(einer)) l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', title: t('dateien.als_hintergrund_titel'), onclick: () => alsHintergrund(einer) }, [symbol('darstellung'), t('dateien.als_hintergrund')]));
    if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit knopf-gefahr', type: 'button', onclick: () => loeschen(gewaehlt) }, [symbol('loeschen'), t('dateien.loeschen')]));
  }
  l.appendChild(el('button', { class: 'knopf-symbol', type: 'button', title: t('dateien.auswahl_aufheben'), 'aria-label': t('dateien.auswahl_aufheben'), onclick: () => { auswahl.clear(); zeigeListe(); } }, [symbol('schliessen')]));
}

function tastatur(ev) {
  const liste = sichtbareEintraege();
  if (!liste.length) return;
  const ziel = ev.target.closest('[data-index]');
  const index = ziel ? Number(ziel.dataset.index) : -1;
  const e = index >= 0 ? liste[index] : null;
  if (ev.target.matches('input, select, textarea') && !['Escape'].includes(ev.key)) return;
  switch (ev.key) {
    case 'ArrowDown': case 'ArrowRight': ev.preventDefault(); if (ev.shiftKey && e) { auswahl.add(kennung(e)); if (liste[index + 1]) auswahl.add(kennung(liste[index + 1])); zeigeListe(); } fokusAuf(Math.min(liste.length - 1, index + 1)); break;
    case 'ArrowUp': case 'ArrowLeft': ev.preventDefault(); if (ev.shiftKey && e) { auswahl.add(kennung(e)); if (liste[index - 1]) auswahl.add(kennung(liste[index - 1])); zeigeListe(); } fokusAuf(Math.max(0, index - 1)); break;
    case 'Home': ev.preventDefault(); fokusAuf(0); break;
    case 'End': ev.preventDefault(); fokusAuf(liste.length - 1); break;
    case 'Enter': if (e) { ev.preventDefault(); if (papierkorb) wiederherstellen([e]); else oeffnen(e); } break;
    case ' ': if (e) { ev.preventDefault(); umschalten(kennung(e)); letzterIndex = index; zeigeListe(); fokusAuf(index); } break;
    case 'Delete': case 'Backspace': {
      if (ev.key === 'Backspace' && !(ev.metaKey || ev.ctrlKey)) return;
      const ziele = ausgewaehlte().length ? ausgewaehlte() : (e ? [e] : []);
      if (ziele.length && !papierkorb && rechte.schreiben) { ev.preventDefault(); loeschen(ziele); }
      break;
    }
    case 'Escape': if (auswahl.size) { ev.preventDefault(); auswahl.clear(); zeigeListe(); fokusAuf(Math.max(0, index)); } break;
    case 'a': case 'A': if (ev.metaKey || ev.ctrlKey) { ev.preventDefault(); for (const x of liste) auswahl.add(kennung(x)); zeigeListe(); fokusAuf(Math.max(0, index)); } break;
    case 'F2': if (e && !papierkorb && rechte.schreiben) { ev.preventDefault(); umbenennen(e); } break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------------------------------------------------

/** Kleine Marken hinter dem Namen: „Nur lesen“ für Nutzer, Schloss für Admins bei Ordnern mit eigenen Rechten. */
function ordnerrechtMarken(e) {
  const aus = [];
  if (e.nur_lesen) aus.push(el('span', { class: 'plakette dateien-marke', title: t('dateien.nur_lesen_titel'), text: t('dateien.nur_lesen') }));
  if (e.ordnerrecht) aus.push(el('span', { class: 'dateien-marke dateien-marke-schloss', title: t('dateien.ordnerrecht_titel'), 'aria-label': t('dateien.ordnerrecht_titel'), role: 'img' }, [symbol('schloss', 'klein')]));
  return aus;
}

function oeffnen(e) {
  if (e.gesperrt) { gesperrtHinweis(ctx, e.name); return; }
  const art = artVon(e);
  // Office-Bündel öffnen das Office (im Papierkorb bleiben sie Ordner); .docx/.xlsx/.csv fragen nach dem Import
  if (art === 'office' && !papierkorb) { ctx.navigiere(ctx.hashFuer('office', 'oeffnen', freigabe, vollerPfad(e))); return; }
  if (e.art === 'ordner') { ctx.navigiere(ctx.hashFuer('dateien', freigabe, vollerPfad(e))); return; }
  if (artFuerImport(e.name) && !papierkorb) { importFrage(e); return; }
  if (['bild', 'text', 'pdf', 'video', 'audio'].includes(art)) vorschau(e); else herunterladen([e]);
}

/** „Im Office öffnen (Kopie importieren)“ – das Original bleibt; daneben „Als Text bearbeiten“ (.csv) bzw. „Herunterladen“. */
function importFrage(e) {
  const csv = /\.csv$/i.test(e.name);
  const quelle = { freigabe, pfad: vollerPfad(e), name: e.name, schreibbar: rechte.schreiben !== false };
  const d = ctx.dialog([
    el('p', { class: 'erklaerung', text: t('dateien.office_import_erklaerung') }),
    el('div', { class: 'dialog-knoepfe' }, [
      csv
        ? el('button', { class: 'knopf knopf-zweit dateien-als-text', type: 'button', onclick: () => { d.schliessen(); vorschau(e); } }, t('dateien.als_text_bearbeiten'))
        : el('button', { class: 'knopf knopf-zweit dateien-office-herunterladen', type: 'button', onclick: () => { d.schliessen(); herunterladen([e]); } }, t('dateien.herunterladen')),
      el('button', { class: 'knopf dateien-office-importieren', type: 'button', onclick: async () => {
        d.schliessen();
        try { await importAblauf(ctx, quelle); } catch (f) { ctx.zeigeFehler(f); }
      } }, t('dateien.office_importieren')),
    ]),
  ], { titel: e.name });
}

function herunterladen(liste) {
  let i = 0;
  const naechste = () => {
    if (i >= liste.length) return;
    const e = liste[i++];
    const a = el('a', { href: ctx.downloadUrl(freigabe, vollerPfad(e), e.art === 'ordner'), download: e.art === 'ordner' ? `${e.name}.zip` : e.name, rel: 'noopener' });
    a.hidden = true; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    if (i < liste.length) setTimeout(naechste, 600);
  };
  naechste();
  if (liste.length > 1) ctx.melden(t('dateien.herunterladen_gestartet', { n: liste.length }), 'info');
}

function pruefeName(w) {
  if (!w) return t('rahmen.eingabe_leer');
  if (w === '.' || w === '..' || /[\/\\\u0000-\u001f]/.test(w)) return t('dateien.name_ungueltig');
  if (w.length > 255) return t('dateien.name_zu_lang');
  if (eintraege.some((e) => e.name === w)) return t('dateien.name_vergeben');
  return null;
}

async function neuerOrdner() {
  const name = await ctx.eingabe({ titel: t('dateien.neuer_ordner'), beschriftung: t('dateien.ordnername'), erklaerung: t('dateien.ordnername_erklaerung'), ok: t('dateien.anlegen'), pruefen: pruefeName });
  if (!name) return;
  try { await ctx.api('dateien.ordner', { freigabe, pfad, name }); ctx.melden(t('dateien.ordner_angelegt', { name }), 'erfolg'); await ladeListe(); } catch (e) { ctx.zeigeFehler(e); }
}

const DOPPEL_ENDUNG = /(\.tar\.(?:gz|bz2|xz|zst|lz4))$/i;
const BUENDEL_ENDUNG = /\.(fahdoc|fahtab|fahboard)$/i; // Office-Bündel sind Ordner, behalten aber ihre Endung (src/gemeinsam/office.js)

/** Endung (Ordner: keine, außer Office-Bündel; „.tar.gz“ als eine; „.env“ ohne). Gleiche Regel wie der Dateihelfer (src/agent/helfer/dateihelfer.js). */
export function endungVon(name, ordner = false) {
  if (ordner) { const b = BUENDEL_ENDUNG.exec(name); return b && b.index > 0 ? b[0] : ''; }
  const doppel = DOPPEL_ENDUNG.exec(name);
  if (doppel && doppel.index > 0) return doppel[1];
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

/** Neue Namen einer Serie: [{alt, ordner}] + basis → [{alt, neu}] – „basis (01).endung“, mindestens zweistellig. */
export function serienNamen(eintraege, basis) {
  const breite = Math.max(2, String(eintraege.length).length);
  return eintraege.map((e, i) => ({ alt: e.alt, neu: `${basis} (${String(i + 1).padStart(breite, '0')})${endungVon(e.alt, e.ordner)}` }));
}

/** Mehrere markierte Einträge fortlaufend umbenennen – Reihenfolge wie in der Liste angezeigt, Vorschau live. */
function umbenennenSerie() {
  const reihe = sichtbareEintraege().filter((e) => auswahl.has(kennung(e)));
  if (reihe.length < 2) return;
  const quellen = reihe.map((e) => ({ alt: e.name, ordner: e.art === 'ordner' }));
  const eingabe = el('input', { class: 'eingabe', type: 'text', maxlength: '200', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'dateien-serie-erklaerung' });
  const vorschau = el('ul', { class: 'dateien-serie-vorschau', role: 'list' });
  const fehler = el('p', { class: 'hinweis hinweis-fehler', role: 'alert', hidden: true });
  const okKnopf = el('button', { class: 'knopf', type: 'button', disabled: true }, t('dateien.umbenennen'));
  const zeigen = () => {
    const b = eingabe.value.trim();
    vorschau.textContent = ''; fehler.hidden = true;
    const ungueltig = !b ? null : (b === '.' || b === '..' || /[\/\\\u0000-\u001f]/.test(b) ? t('dateien.name_ungueltig') : null);
    okKnopf.disabled = !b || !!ungueltig;
    if (ungueltig) { fehler.textContent = ungueltig; fehler.hidden = false; return; }
    if (!b) return;
    const namen = serienNamen(quellen, b);
    for (const z of namen.slice(0, 5)) vorschau.appendChild(el('li', {}, [el('span', { class: 'schwach', text: z.alt }), ' → ', el('strong', { text: z.neu })]));
    if (namen.length > 5) vorschau.appendChild(el('li', { class: 'schwach', text: t('dateien.serie_weitere', { n: namen.length - 5 }) }));
  };
  eingabe.addEventListener('input', zeigen);
  const ausfuehren = async () => {
    const basis = eingabe.value.trim();
    if (!basis || okKnopf.disabled) return;
    okKnopf.disabled = true;
    try {
      const r = await ctx.api('dateien.umbenennen_serie', { freigabe, pfad, namen: quellen.map((q) => q.alt), basis });
      d.schliessen();
      ctx.melden(t('dateien.serie_ok', { n: (r && r.anzahl) || quellen.length }), 'erfolg');
      auswahl.clear();
      await ladeListe();
    } catch (f) { fehler.textContent = ctx.fehlerText(f); fehler.hidden = false; okKnopf.disabled = false; }
  };
  eingabe.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ausfuehren(); } });
  okKnopf.addEventListener('click', ausfuehren);
  const d = ctx.dialog([
    el('label', { class: 'feld-beschriftung', for: 'dateien-serie-name', text: t('dateien.serie_name') }),
    Object.assign(eingabe, { id: 'dateien-serie-name' }),
    el('p', { class: 'erklaerung', id: 'dateien-serie-erklaerung', text: t('dateien.serie_erklaerung', { n: quellen.length }) }),
    vorschau, fehler,
    el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')), okKnopf]),
  ], { titel: t('dateien.serie_titel', { n: quellen.length }) });
  try { eingabe.focus(); } catch { /* egal */ }
}

async function umbenennen(e) {
  const neu = await ctx.eingabe({ titel: t('dateien.umbenennen'), beschriftung: t('dateien.neuer_name'), erklaerung: t('dateien.neuer_name_erklaerung'), wert: e.name, auswaehlen: true, ok: t('dateien.umbenennen'), pruefen: (w) => (w === e.name ? t('dateien.name_gleich') : pruefeName(w)) });
  if (!neu) return;
  try { await ctx.api('dateien.umbenennen', { freigabe, pfad: vollerPfad(e), neuer_name: neu }); ctx.melden(t('dateien.umbenannt', { alt: e.name, neu }), 'erfolg'); auswahl.delete(kennung(e)); await ladeListe(); } catch (f) { ctx.zeigeFehler(f); }
}

async function loeschen(liste) {
  if (!liste.length) return;
  const mitPapierkorb = rechte.papierkorb;
  const text = liste.length === 1 ? t(mitPapierkorb ? 'dateien.loeschen_frage_eins' : 'dateien.loeschen_endgueltig_eins', { name: liste[0].name }) : t(mitPapierkorb ? 'dateien.loeschen_frage' : 'dateien.loeschen_endgueltig', { n: liste.length });
  if (!(await ctx.bestaetigen(text, { titel: t('dateien.loeschen'), ok: t('dateien.loeschen'), gefahr: true }))) return;
  try {
    await ctx.api('dateien.loeschen', { freigabe, pfade: liste.map(vollerPfad) });
    ctx.melden(t(mitPapierkorb ? 'dateien.geloescht_papierkorb' : 'dateien.geloescht', { n: liste.length }), 'erfolg');
    for (const e of liste) auswahl.delete(kennung(e));
    await ladeListe();
  } catch (e) { ctx.zeigeFehler(e); }
}

async function verschiebenKopieren(art, liste) {
  if (!liste.length) return;
  const ziel = await zielWaehlen(art === 'verschieben' ? t('dateien.verschieben_nach', { n: liste.length }) : t('dateien.kopieren_nach', { n: liste.length }), art);
  if (!ziel) return;
  if (art === 'verschieben' && ziel.freigabe === freigabe && ziel.pfad === pfad) { ctx.melden(t('dateien.ziel_gleich'), 'info'); return; }
  // Namen, die es am Ziel schon gibt: je Konflikt fragen (Ersetzen / Beide behalten / Überspringen)
  const ersetzen = []; const beide = [];
  try {
    const vorhanden = await vorhandeneNamen(ziel.freigabe, ziel.pfad, liste.map((e) => e.name));
    if (vorhanden.size) {
      const gleicherOrt = ziel.freigabe === freigabe && ziel.pfad === pfad; // Kopie am selben Ort: nur „Beide behalten“
      const konflikte = liste.filter((e) => vorhanden.has(e.name)).map((e) => ({
        name: e.name, eintrag: e, vorhanden: vorhanden.get(e.name), neu: { art: e.art, groesse: e.groesse, geaendert: e.geaendert },
        erlaubt: gleicherOrt ? ['beide', 'ueberspringen'] : ['ersetzen', 'beide', 'ueberspringen'],
      }));
      const entscheidungen = await konflikteEntscheiden(konflikte, (k, rest) => konfliktFrage(k, rest, { papierkorb: papierkorbIn(ziel.freigabe), art }));
      if (!entscheidungen) return;
      const auslassen = new Set();
      for (const k of konflikte) {
        const wahl = entscheidungen.get(k);
        if (wahl === 'ersetzen') ersetzen.push(k.name); else if (wahl === 'beide') beide.push(k.name); else auslassen.add(k.eintrag);
      }
      liste = liste.filter((e) => !auslassen.has(e));
      if (!liste.length) { ctx.melden(t('dateien.alles_uebersprungen'), 'info'); return; }
    }
  } catch (e) { ctx.zeigeFehler(e); return; }
  try {
    const antwort = await ctx.api(`dateien.${art}`, { freigabe, quellen: liste.map(vollerPfad), ziel_freigabe: ziel.freigabe, ziel_pfad: ziel.pfad, ersetzen, beide });
    const id = antwort && antwort.aufgabe;
    if (!id) { ctx.melden(t(`dateien.${art}_fertig`, { n: liste.length }), 'erfolg'); await ladeListe(); return; }
    const toast = ctx.melden(t(`dateien.${art}_laeuft`, { n: liste.length }), 'info', 0);
    const textKnoten = toast && toast.element.querySelector('.toast-text');
    try {
      await ctx.aufgabe(id, (e) => { if (textKnoten && e.status === 'laeuft') textKnoten.textContent = `${t(`dateien.${art}_laeuft`, { n: liste.length })} ${Math.round((e.fortschritt || 0) * 100)} %${e.meldung ? ' – ' + e.meldung : ''}`; });
      if (toast) toast.schliessen();
      ctx.melden(t(`dateien.${art}_fertig`, { n: liste.length }), 'erfolg');
    } catch (f) { if (toast) toast.schliessen(); ctx.zeigeFehler(f); }
    for (const e of liste) auswahl.delete(kennung(e));
    await ladeListe();
  } catch (e) { ctx.zeigeFehler(e); }
}

/** Zielwahl für Verschieben/Kopieren über die gemeinsame Ordnerwahl (V8); nur Ziele mit Schreibrecht. Promise<{freigabe, pfad}|null>. */
function zielWaehlen(titel, art) {
  return ordnerWaehlen(ctx, {
    titel,
    erklaerung: t(art === 'verschieben' ? 'dateien.verschieben_erklaerung' : 'dateien.kopieren_erklaerung'),
    okText: t(art === 'verschieben' ? 'dateien.verschieben' : 'dateien.kopieren'),
    nurSchreibbar: true, start: { freigabe, pfad: '' }, mitSystem: ctx.rolle === 'admin',
  });
}

function aktionenMenue(e) {
  if (e.gesperrt) { gesperrtHinweis(ctx, e.name); return; }
  const ordner = e.art === 'ordner';
  const eintrag = (symbolName, text, fn, klasse = '') => el('button', { class: `knopf knopf-zweit ${klasse}`.trim(), type: 'button', onclick: () => { d.schliessen(); fn(); } }, [symbol(symbolName), text]);
  const liste = el('div', { class: 'knopf-reihe dateien-menue' });
  if (papierkorb) {
    liste.appendChild(eintrag('wiederherstellen', t('dateien.wiederherstellen'), () => wiederherstellen([e])));
  } else {
    liste.appendChild(eintrag(ordner ? 'ordner' : 'suchen', ordner ? t('dateien.oeffnen') : t('dateien.vorschau'), () => oeffnen(e)));
    liste.appendChild(eintrag('herunterladen', ordner ? t('dateien.herunterladen_zip') : t('dateien.herunterladen'), () => herunterladen([e])));
    if (rechte.schreiben) liste.appendChild(eintrag('umbenennen', t('dateien.umbenennen'), () => umbenennen(e)));
    if (rechte.schreiben) liste.appendChild(eintrag('verschieben', t('dateien.verschieben'), () => verschiebenKopieren('verschieben', [e])));
    liste.appendChild(eintrag('kopieren', t('dateien.kopieren'), () => verschiebenKopieren('kopieren', [e])));
    liste.appendChild(eintrag('link', t('dateien.freigabelink'), () => linkDialog(e)));
    if (!ordner) liste.appendChild(eintrag('chat', t('dateien.im_chat_teilen'), () => imChatTeilenStarten(e)));
    liste.appendChild(eintrag('info', t('dateien.info'), () => infoDialog(e)));
    if (ordner && ordnerrechteMoeglich()) liste.appendChild(eintrag('schloss', t('dateien.ordnerrechte_menue'), () => ordnerrechteDialog(ctx, { freigabe, pfad: vollerPfad(e), name: e.name, nachher: () => ladeListe() })));
    if (ordner) {
      const an = favoriten.ist(freigabe, vollerPfad(e));
      liste.appendChild(eintrag(an ? 'stern-voll' : 'stern', t(an ? 'dateien.favorit_weg' : 'dateien.favorit_hinzu'), () => favoritUmschalten(freigabe, vollerPfad(e))));
    }
    if (alsTapeteTauglich(e)) liste.appendChild(eintrag('darstellung', t('dateien.als_hintergrund'), () => alsHintergrund(e)));
    if (rechte.schreiben) liste.appendChild(eintrag('loeschen', t('dateien.loeschen'), () => loeschen([e]), 'knopf-gefahr'));
  }
  const d = ctx.dialog([el('p', { class: 'schwach klein abschneiden', text: vollerPfad(e) }), liste], { titel: e.name, klasse: 'dateien-menue-dialog' });
}

// ---------------------------------------------------------------------------------------------------------------------
// Vorschau, Info, Freigabelink
// ---------------------------------------------------------------------------------------------------------------------

async function vorschau(e) {
  const art = artVon(e);
  // Textdateien öffnen sich im Editor (Plan 01): bearbeitbar mit Schreibrecht, Speichern beim Schließen
  if (art === 'text' && Number(e.groesse) <= MAX_TEXT_VORSCHAU) {
    try {
      await texteditorOeffnen(ctx, { freigabe, pfad: vollerPfad(e), eintrag: e, schreibbar: rechte.schreiben !== false && !papierkorb, nachSpeichern: () => ladeListe() });
    } catch (f) { ctx.zeigeFehler(f); }
    return;
  }
  const behaelter = el('div', { class: 'dateien-vorschau' }, [el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')])]);
  const objektUrls = [];
  let cspHoerer = null;
  const fuss = el('div', { class: 'dateien-vorschau-fuss' }, [
    el('a', { class: 'knopf knopf-zweit', href: ctx.downloadUrl(freigabe, vollerPfad(e)), download: e.name }, [symbol('herunterladen'), t('dateien.herunterladen')]),
    el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => { d.schliessen(); infoDialog(e); } }, [symbol('info'), t('dateien.info')]),
    alsTapeteTauglich(e) ? el('button', { class: 'knopf knopf-zweit', type: 'button', title: t('dateien.als_hintergrund_titel'), onclick: () => alsHintergrund(e) }, [symbol('darstellung'), t('dateien.als_hintergrund')]) : null,
  ]);
  const d = ctx.dialog([behaelter, fuss], { titel: e.name, breit: true, beimSchliessen: () => { for (const u of objektUrls) URL.revokeObjectURL(u); if (cspHoerer) document.removeEventListener('securitypolicyviolation', cspHoerer); for (const m of behaelter.querySelectorAll('video, audio')) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch { /* egal */ } } medienSitzung(null); } });
  const zeigeFehler = (fehler, hinweis) => { behaelter.textContent = ''; behaelter.appendChild(el('div', { class: 'leer' }, [symbol('warnung', 'gross'), el('p', { class: 'leer-titel', text: hinweis || t('dateien.vorschau_fehler') }), fehler ? el('p', { class: 'leer-text', text: ctx.fehlerText(fehler) }) : null])); };
  try {
    if (art === 'bild') {
      const blob = await ctx.ladeBlob(freigabe, vollerPfad(e), MAX_BILD_VORSCHAU);
      const url = URL.createObjectURL(blob); objektUrls.push(url);
      behaelter.textContent = '';
      behaelter.appendChild(el('img', { src: url, alt: e.name }));
      behaelter.appendChild(el('p', { class: 'schwach klein', text: `${format.groesse(blob.size)}${blob.type ? ' · ' + blob.type : ''}` }));
    } else if (art === 'text') {
      if (Number(e.groesse) > MAX_TEXT_VORSCHAU) { zeigeFehler(null, t('dateien.text_zu_gross', { max: format.groesse(MAX_TEXT_VORSCHAU) })); return; }
      const blob = await ctx.ladeBlob(freigabe, vollerPfad(e), MAX_TEXT_VORSCHAU);
      const text = await blob.text();
      behaelter.textContent = '';
      behaelter.appendChild(el('pre', { tabindex: '0', text }));
    } else if (art === 'pdf') {
      // Gleiche Herkunft mit anzeigen=1 (Content-Disposition inline) – erlaubt durch object-src 'self' (Rückfall der CSP
      // auf default-src). Ein blob: wäre durch die CSP des Web-Dienstes gesperrt. Trägt die Download-Antwort selbst
      // „frame-ancestors 'none'“, darf der Browser sie nicht einbetten – dann gleich Hinweis + Download statt leerem Rahmen.
      if (Number(e.groesse) > MAX_PDF_VORSCHAU) { zeigeFehler(null, t('dateien.text_zu_gross', { max: format.groesse(MAX_PDF_VORSCHAU) })); return; }
      const url = ctx.downloadUrl(freigabe, vollerPfad(e), false, true);
      if (!(await einbettbar(url))) { zeigeFehler(null, t('dateien.pdf_csp')); return; }
      behaelter.textContent = '';
      const objekt = el('object', { data: url, type: 'application/pdf', 'aria-label': e.name }, [el('div', { class: 'leer' }, [symbol('pdf', 'gross'), el('p', { class: 'leer-text', text: t('dateien.pdf_nicht_anzeigbar') })])]);
      let blockiert = false;
      cspHoerer = (ev) => { if (!blockiert && /object-src|default-src|frame-src|child-src|plugin-types/.test(ev.violatedDirective || '')) { blockiert = true; zeigeFehler(null, t('dateien.pdf_csp')); } };
      document.addEventListener('securitypolicyviolation', cspHoerer);
      behaelter.appendChild(objekt);
    } else if (art === 'video' || art === 'audio') {
      behaelter.textContent = '';
      medienListe(e, art, behaelter, fuss, d, zeigeFehler);
    } else {
      zeigeFehler(null, t('dateien.keine_vorschau'));
    }
  } catch (f) { zeigeFehler(f); }
}

/**
 * Audio/Video als Wiedergabeliste (Betreiber 23.11.): ab der angeklickten Datei laufen alle weiteren Medien derselben Art
 * im Ordner (angezeigte Reihenfolge) von selbst weiter. Zurück/Weiter-Knöpfe, Zähler „3 / 12“, Titel und Download folgen
 * der laufenden Datei; nicht abspielbare Dateien werden übersprungen. Sperrbildschirm/Medientasten über die Media Session.
 */
function medienListe(start, art, behaelter, fuss, d, zeigeFehler) {
  const { dateien, pos: anfang } = wiedergabeliste(sichtbareEintraege(), start);
  let pos = anfang;
  let fehlerInFolge = 0;
  const medium = el(art, { controls: true, preload: 'metadata', 'aria-label': start.name });
  const titel = d.element.querySelector('.dialog-titel');
  const download = fuss.querySelector('a[download]');
  const zaehler = el('span', { class: 'dateien-medien-zaehler schwach klein' });
  const zurueck = el('button', { class: 'knopf knopf-zweit', type: 'button', title: t('dateien.medien_zurueck'), 'aria-label': t('dateien.medien_zurueck'), onclick: () => wechseln(pos - 1) }, [t('dateien.medien_zurueck_kurz')]);
  const weiter = el('button', { class: 'knopf knopf-zweit', type: 'button', title: t('dateien.medien_weiter'), 'aria-label': t('dateien.medien_weiter'), onclick: () => wechseln(pos + 1) }, [t('dateien.medien_weiter_kurz')]);
  const leiste = dateien.length > 1 ? el('div', { class: 'dateien-medien-leiste' }, [zurueck, zaehler, weiter]) : null;
  const ordner = pfad ? pfad.split('/').filter(Boolean).pop() : freigabe;
  function wechseln(neu, { spielen = true } = {}) {
    if (neu < 0 || neu >= dateien.length) return;
    pos = neu;
    const x = dateien[pos];
    medium.src = ctx.downloadUrl(freigabe, vollerPfad(x));
    medium.setAttribute('aria-label', x.name);
    if (titel) titel.textContent = x.name;
    if (download) { download.href = ctx.downloadUrl(freigabe, vollerPfad(x)); download.setAttribute('download', x.name); }
    zaehler.textContent = `${pos + 1} / ${dateien.length}`;
    zurueck.disabled = pos === 0; weiter.disabled = pos === dateien.length - 1;
    medienSitzung({ titel: x.name, ordner, zurueck: pos > 0 ? () => wechseln(pos - 1) : null, weiter: pos < dateien.length - 1 ? () => wechseln(pos + 1) : null });
    if (spielen) medium.play().catch(() => { /* Autoplay verboten – Nutzer klickt */ });
  }
  medium.addEventListener('ended', () => { fehlerInFolge = 0; wechseln(pos + 1); });
  medium.addEventListener('playing', () => { fehlerInFolge = 0; });
  medium.addEventListener('error', () => {
    if (!medium.getAttribute('src')) return;                             // beim Schließen geleert
    if (dateien.length === 1) { zeigeFehler(null, t('dateien.medium_fehler')); return; }
    fehlerInFolge += 1;                                                  // Liste: Player bleibt, Zurück/Weiter gehen weiter
    if (pos < dateien.length - 1 && fehlerInFolge < dateien.length) { ctx.melden(`${dateien[pos].name}: ${t('dateien.medium_uebersprungen')}`, 'warnung', 3000); wechseln(pos + 1); }
    else ctx.melden(`${dateien[pos].name}: ${t('dateien.medium_fehler')}`, 'warnung', 5000);
  });
  behaelter.appendChild(medium);
  if (leiste) fuss.insertBefore(leiste, fuss.firstChild);
  wechseln(pos);
}

/** Medientasten/Sperrbildschirm (Handy, Kopfhörer): Titel und Vor/Zurück; null = alles lösen. */
function medienSitzung(info) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  if (!ms) return;
  try {
    ms.metadata = info && typeof MediaMetadata === 'function' ? new MediaMetadata({ title: info.titel, album: info.ordner || '' }) : null;
    ms.setActionHandler('previoustrack', info && info.zurueck ? info.zurueck : null);
    ms.setActionHandler('nexttrack', info && info.weiter ? info.weiter : null);
  } catch { /* ältere Browser */ }
}

/**
 * Prüft nur die Antwortköpfe einer Download-URL: verbietet deren CSP (frame-ancestors) das Einbetten in die eigene
 * Seite, lohnt kein <object>. Der Körper wird sofort abgebrochen.
 */
async function einbettbar(url) {
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return true;
  const ab = new AbortController();
  try {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ab.signal });
    const csp = r.headers.get('content-security-policy') || '';
    ab.abort();
    if (!r.ok) return true;
    const m = /frame-ancestors\s+([^;]+)/i.exec(csp);
    if (!m) return true;
    const quellen = m[1].trim().toLowerCase();
    return quellen.includes("'self'") || quellen.includes('*') || quellen.includes(location.host.toLowerCase());
  } catch { ab.abort(); return true; }
}

async function infoDialog(e) {
  const behaelter = el('dl', { class: 'dateien-info' });
  const d = ctx.dialog([el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')])], { titel: t('dateien.info_titel', { name: e.name }) });
  let info;
  try { info = await ctx.api('dateien.info', { freigabe, pfad: vollerPfad(e) }); } catch (f) { d.koerper.textContent = ''; d.koerper.appendChild(el('p', { class: 'feld-fehler', text: ctx.fehlerText(f) })); return; }
  const zeile = (k, v) => { if (v === undefined || v === null || v === '') return; behaelter.appendChild(el('dt', { text: k })); behaelter.appendChild(typeof Node !== 'undefined' && v instanceof Node ? el('dd', {}, [v]) : el('dd', { text: String(v) })); };
  zeile(t('dateien.info_name'), info.name || e.name);
  // vollständiger Pfad auf dem NAS (zum Eintragen in Apps/Spiegelung/VMs) samt Kopierknopf; Rückfall: Freigabe/Pfad
  const voll = info.pfad_voll || `${freigabe}/${vollerPfad(e)}`;
  const kopieren = el('button', { class: 'knopf knopf-zweit knopf-klein dateien-info-kopieren', type: 'button', title: t('dateien.kopieren'), 'aria-label': t('dateien.kopieren'), onclick: async () => {
    try { await navigator.clipboard.writeText(voll); ctx.melden(`${voll} ✓`, 'erfolg'); } catch { /* ohne Zwischenablage (http) bleibt der Text markierbar */ }
  } }, [symbol('kopieren')]);
  zeile(t('dateien.info_pfad'), el('span', { class: 'dateien-info-pfad' }, [el('code', { text: voll }), kopieren]));
  zeile(t('dateien.info_art'), t.hat(`dateien.art_${info.art || e.art}`) ? t(`dateien.art_${info.art || e.art}`) : (info.art || e.art));
  zeile(t('dateien.info_mime'), info.mime);
  zeile(t('dateien.spalte_groesse'), info.groesse != null ? `${format.groesse(info.groesse)} (${format.zahl(info.groesse)} B)` : undefined);
  zeile(t('dateien.spalte_geaendert'), info.geaendert ? format.zeitGenau(info.geaendert) : undefined);
  zeile(t('dateien.info_erstellt'), info.erstellt ? format.zeitGenau(info.erstellt) : undefined);
  zeile(t('dateien.info_rechte'), info.rechte);
  const b = info.besitzer;
  zeile(t('dateien.info_besitzer'), b && typeof b === 'object' ? [b.name ?? b.uid, b.gruppe ?? b.gid].filter((x) => x !== undefined && x !== null).join(':') : b);
  if (info.bild && info.bild.breite) zeile(t('dateien.info_bild'), `${info.bild.breite} × ${info.bild.hoehe}`);
  d.koerper.textContent = '';
  d.koerper.appendChild(behaelter);
}

async function kopiereText(text) {
  try { await navigator.clipboard.writeText(text); ctx.melden(t('dateien.kopiert'), 'erfolg', 2500); return true; } catch {
    const feld = el('input', { class: 'eingabe', value: text, readOnly: true });
    ctx.dialog([el('p', { class: 'erklaerung', text: t('dateien.kopieren_manuell') }), feld], { titel: t('dateien.freigabelink') });
    feld.focus(); feld.select();
    return false;
  }
}

/** „Im Chat teilen …“: Dialog erst bei Bedarf laden (der Chat ist ein eigener Baustein). */
async function imChatTeilenStarten(e) {
  try {
    const m = await import('../chat/teilen-dialog.js');
    await m.imChatTeilen(ctx, { freigabe, pfad: vollerPfad(e) });
  } catch (f) { ctx.zeigeFehler(f); }
}

async function linkDialog(e) {
  const gueltig = el('select', { class: 'eingabe' }, [
    el('option', { value: '1', text: t('dateien.gueltig_1h') }),
    el('option', { value: '24', text: t('dateien.gueltig_24h'), selected: true }),
    el('option', { value: '168', text: t('dateien.gueltig_7d') }),
    el('option', { value: '720', text: t('dateien.gueltig_30d') }),
    el('option', { value: '0', text: t('dateien.gueltig_dauerhaft') }),
  ]);
  const ergebnis = el('div', { class: 'dateien-link-ergebnis' });
  const listeKnoten = el('ul', { class: 'dateien-links' });
  const anlegen = el('button', { class: 'knopf', type: 'button', onclick: async () => {
    anlegen.disabled = true;
    try {
      const r = await ctx.api('dateien.link.anlegen', { freigabe, pfad: vollerPfad(e), gueltig_h: Number(gueltig.value) });
      const url = linkAdresse(ctx.zugang, r);
      ergebnis.textContent = '';
      ergebnis.appendChild(el('div', { class: 'hinweis hinweis-info' }, [symbol('link'), el('div', {}, [el('p', { text: t('dateien.link_angelegt') }), el('p', { class: 'dateien-link-url', text: url }), el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => kopiereText(url) }, [symbol('kopieren'), t('dateien.kopieren_link')])])]));
      ctx.melden(t('dateien.link_angelegt'), 'erfolg');
      await ladeLinks();
    } catch (f) { ctx.zeigeFehler(f); } finally { anlegen.disabled = false; }
  } }, [symbol('link'), t('dateien.link_anlegen')]);
  async function ladeLinks() {
    listeKnoten.textContent = '';
    let links;
    try { links = await ctx.api('dateien.link.liste', {}); } catch (f) { listeKnoten.appendChild(el('li', { class: 'schwach klein', text: ctx.fehlerText(f) })); return; }
    const alle = Array.isArray(links) ? links : (links && links.links) || [];
    if (!alle.length) { listeKnoten.appendChild(el('li', { class: 'schwach klein', text: t('dateien.keine_links') })); return; }
    for (const l of alle) {
      const url = linkAdresse(ctx.zugang, l);
      listeKnoten.appendChild(el('li', { class: 'dateien-link' }, [
        el('span', { class: 'abschneiden', text: `${l.freigabe || freigabe}/${l.pfad || ''}` }),
        el('button', { class: 'knopf-symbol', type: 'button', title: t('dateien.kopieren_link'), 'aria-label': t('dateien.kopieren_link'), onclick: () => kopiereText(url) }, [symbol('kopieren')]),
        el('button', { class: 'knopf-symbol', type: 'button', title: t('dateien.link_loeschen'), 'aria-label': t('dateien.link_loeschen'), onclick: async () => { try { await ctx.api('dateien.link.loeschen', { token: l.token }); ctx.melden(t('dateien.link_geloescht'), 'erfolg'); await ladeLinks(); } catch (f) { ctx.zeigeFehler(f); } } }, [symbol('loeschen')]),
        el('span', { class: 'dateien-link-url', text: url }),
        el('span', { class: 'schwach klein', text: l.ablauf ? t('dateien.gueltig_bis', { zeit: format.zeitGenau(l.ablauf) }) : t('dateien.gueltig_dauerhaft_kurz') }),
      ]));
    }
  }
  ctx.dialog([
    el('p', { class: 'erklaerung', text: t('dateien.link_erklaerung') }),
    el('div', { class: 'dateien-link-neu' }, [el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('dateien.gueltigkeit') }), gueltig, el('p', { class: 'erklaerung', text: t('dateien.gueltigkeit_erklaerung') })]), anlegen]),
    ergebnis,
    el('h3', { text: t('dateien.meine_links') }),
    listeKnoten,
  ], { titel: t('dateien.freigabelink_fuer', { name: e.name }) });
  await ladeLinks();
}

// ---------------------------------------------------------------------------------------------------------------------
// Papierkorb
// ---------------------------------------------------------------------------------------------------------------------

function papierkorbKennung(e) { return e.id ?? e.eintrag ?? e.kennung ?? e.pfad ?? e.name; }

async function zeigePapierkorb() {
  const nummer = ++ladeNummer;
  wurzel.textContent = '';
  auswahl = new Set(); letzterIndex = -1; eintraege = [];
  wurzel.appendChild(baueLeiste());
  wurzel.appendChild(el('div', { class: 'hinweis hinweis-info dateien-papierkorb-hinweis' }, [symbol('info'), el('p', { text: t((freigabenCache || []).find((f) => f.name === freigabe)?.extern ? 'dateien.papierkorb_erklaerung_extern' : 'dateien.papierkorb_erklaerung') })]));
  const bereich = el('div', { class: 'dateien-bereich', tabindex: '-1' });
  knoten.bereich = bereich; wurzel.appendChild(bereich);
  bereich.addEventListener('keydown', tastatur);
  bereich.appendChild(el('div', { class: 'laden' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')]));
  ctx.setzeTitel(`${t('dateien.papierkorb')} – ${freigabe}`);
  await ladePapierkorb(nummer);
}

async function ladePapierkorb(nummer = ++ladeNummer) {
  let r;
  try { r = await ctx.api('dateien.papierkorb.liste', { freigabe }); } catch (e) {
    if (nummer !== ladeNummer || !knoten.bereich) return;
    knoten.bereich.textContent = '';
    knoten.bereich.appendChild(el('div', { class: 'leer' }, [symbol('warnung', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.papierkorb_fehler') }), el('p', { class: 'leer-text', text: ctx.fehlerText(e) })]));
    return;
  }
  if (nummer !== ladeNummer) return;
  // Der Agent liefert Löschvorgänge: [{id, quelle, zeit, nutzer, herkunft, eintraege:[{pfad, name, art, groesse}]}].
  // Die Oberfläche zeigt jede Datei als Zeile; Wiederherstellen schickt {id, pfad} je Zeile.
  const vorgaenge = Array.isArray(r) ? r : (r && r.eintraege) || [];
  eintraege = [];
  for (const [vi, v] of vorgaenge.entries()) {
    const id = String(v.id ?? papierkorbKennung(v) ?? vi);
    const unter = Array.isArray(v.eintraege) && v.eintraege.length ? v.eintraege : [{ pfad: v.pfad, name: v.name, art: v.art, groesse: v.groesse }];
    for (const [ei, e] of unter.entries()) {
      const relPfad = e.pfad != null ? String(e.pfad) : '';
      const name = e.name || (relPfad ? relPfad.split('/').pop() : `#${ei + 1}`);
      // Der genaue Ordner steht im Pfad; die Angabe des Vorgangs nur, wenn der Eintrag selbst keinen hat
      const herkunft = relPfad.includes('/') ? relPfad.slice(0, relPfad.lastIndexOf('/')) : String(v.herkunft ?? '');
      eintraege.push({ name, art: e.art || 'datei', groesse: e.groesse, herkunft: herkunft || '/', von: v.grund === 'spiegelung' ? v.nutzer : '', geloescht: v.zeit || v.geloescht, nutzer: v.nutzer, quelle: v.quelle, grund: v.grund, geaendert: v.zeit || v.geloescht, _id: id, _pfad: relPfad, _schluessel: `${id}\u0000${relPfad || name}` });
    }
  }
  for (const n of [...auswahl]) if (!eintraege.some((e) => kennung(e) === n)) auswahl.delete(n);
  zeigePapierkorbListe();
}

function zeigePapierkorbListe() {
  const b = knoten.bereich; if (!b) return;
  b.textContent = '';
  const liste = sortiere(eintraege, 'geaendert', false);
  if (!liste.length) { b.appendChild(el('div', { class: 'leer' }, [symbol('papierkorb', 'gross'), el('p', { class: 'leer-titel', text: t('dateien.papierkorb_leer') })])); zeigeAuswahlleiste(); return; }
  const alle = liste.every((e) => auswahl.has(kennung(e)));
  const tabelle = el('table', { class: 'tabelle tabelle-karten dateien-tabelle dateien-tabelle-papierkorb' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { class: 'dateien-spalte-wahl', scope: 'col' }, [el('input', { type: 'checkbox', checked: alle, 'aria-label': t('dateien.alle_auswaehlen'), onchange: () => { if (alle) auswahl.clear(); else for (const e of liste) auswahl.add(kennung(e)); zeigePapierkorbListe(); } })]),
      el('th', { scope: 'col', text: t('dateien.spalte_name') }), el('th', { scope: 'col', text: t('dateien.spalte_herkunft') }), el('th', { scope: 'col', class: 'zahl', text: t('dateien.spalte_groesse') }), el('th', { scope: 'col', text: t('dateien.spalte_geloescht') }), el('th', { scope: 'col', class: 'schmal' }, [el('span', { class: 'nur-lesen', text: t('dateien.aktionen') })]),
    ])]),
  ]);
  const koerper = el('tbody');
  liste.forEach((e, index) => {
    const geloescht = e.geloescht || e.zeit || e.geaendert;
    const zeile = el('tr', { 'aria-selected': auswahl.has(kennung(e)) ? 'true' : 'false', 'data-index': index, tabindex: index === 0 ? '0' : '-1' }, [
      el('td', { class: 'dateien-wahl' }, [wahlKasten(e, index, liste)]),
      el('td', { class: 'dateien-name', 'data-label': t('dateien.spalte_name') }, [el('span', { class: `dateien-eintrag-name ${e.art === 'ordner' ? 'ordner' : ''}` }, [eintragSymbol(e), el('span', { class: 'dateien-eintrag-text', text: e.name }), e.grund === 'ersetzt' ? el('span', { class: 'plakette', title: t('dateien.grund_ersetzt_erklaerung'), text: t('dateien.grund_ersetzt') }) : null])]),
      el('td', { class: 'schwach dateien-herkunft', 'data-label': t('dateien.spalte_herkunft'), text: e.von ? `${e.herkunft || '/'} · ${e.von}` : e.herkunft || '/' }),
      el('td', { class: 'dateien-groesse zahl', 'data-label': t('dateien.spalte_groesse'), text: e.art === 'ordner' ? '–' : format.groesse(e.groesse) }),
      el('td', { class: 'dateien-datum', 'data-label': t('dateien.spalte_geloescht'), title: format.zeitGenau(geloescht), text: format.zeit(geloescht) }),
      el('td', { class: 'dateien-aktionen' }, [el('button', { class: 'knopf-symbol', type: 'button', title: t('dateien.wiederherstellen'), 'aria-label': t('dateien.wiederherstellen_fuer', { name: e.name }), onclick: (ev) => { ev.stopPropagation(); wiederherstellen([e]); } }, [symbol('wiederherstellen')])]),
    ]);
    zeile.addEventListener('click', (ev) => { if (ev.target.closest('button, input, a')) return; letzterIndex = index; umschalten(kennung(e)); zeigePapierkorbListe(); fokusAuf(index); });
    koerper.appendChild(zeile);
  });
  tabelle.appendChild(koerper);
  b.appendChild(tabelle);
  zeigeAuswahlleiste();
}

async function wiederherstellen(liste) {
  if (!liste.length) return;
  try {
    const ergebnis = await ctx.api('dateien.papierkorb.wiederherstellen', { freigabe, eintraege: liste.map((e) => (e._pfad ? { id: e._id, pfad: e._pfad } : { id: e._id })) });
    const uebersprungen = ergebnis && Array.isArray(ergebnis.uebersprungen) ? ergebnis.uebersprungen : [];
    const umbenannt = ergebnis && Array.isArray(ergebnis.umbenannt) ? ergebnis.umbenannt : [];
    if (uebersprungen.length) ctx.melden(t('dateien.wiederhergestellt_teilweise', { n: liste.length - uebersprungen.length, u: uebersprungen.length, grund: uebersprungen[0].grund || '' }), 'warnung', 9000);
    else ctx.melden(t('dateien.wiederhergestellt', { n: liste.length }), 'erfolg');
    // Ursprünglicher Ort war belegt (z. B. neue Version einer ersetzten Datei) → daneben als „Name (n)“ zurückgelegt
    if (umbenannt.length) ctx.melden(t('dateien.wiederhergestellt_umbenannt', { n: umbenannt.length, neu: String(umbenannt[0].neu || '').split('/').pop() }), 'info', 9000);
    for (const e of liste) auswahl.delete(kennung(e));
    await ladePapierkorb();
  } catch (e) { ctx.zeigeFehler(e); }
}

async function papierkorbLeeren() {
  if (!(await ctx.bestaetigen(t('dateien.papierkorb_leeren_frage', { freigabe }), { titel: t('dateien.papierkorb_leeren'), ok: t('dateien.papierkorb_leeren'), gefahr: true }))) return;
  try { await ctx.api('dateien.papierkorb.leeren', { freigabe }); ctx.melden(t('dateien.papierkorb_geleert'), 'erfolg'); await ladePapierkorb(); } catch (e) { ctx.zeigeFehler(e); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hochladen: Auswahl, Ablage (Drag & Drop, auch Ordner), Warteschlange mit Fortschritt
// ---------------------------------------------------------------------------------------------------------------------

function hochladenWaehlen() {
  if (!dateiEingabe) {
    dateiEingabe = el('input', { type: 'file', multiple: true, class: 'nur-lesen', 'aria-hidden': 'true', tabindex: '-1' });
    dateiEingabe.addEventListener('change', () => { const dateien = [...(dateiEingabe.files || [])].map((f) => ({ datei: f, relativ: '' })); dateiEingabe.value = ''; einreihen(dateien, freigabe, pfad); });
    document.body.appendChild(dateiEingabe);
  }
  dateiEingabe.click();
}

/** Ganzen Ordner hochladen: <input webkitdirectory> liefert Dateien mit relativem Pfad; Ordner werden vorab angelegt. */
let ordnerEingabe = null;
function ordnerHochladenWaehlen() {
  if (!ordnerEingabe) {
    ordnerEingabe = el('input', { type: 'file', multiple: true, webkitdirectory: '', class: 'nur-lesen', 'aria-hidden': 'true', tabindex: '-1' });
    ordnerEingabe.addEventListener('change', () => {
      const dateien = [...(ordnerEingabe.files || [])];
      ordnerEingabe.value = '';
      const liste = []; const ordner = new Set();
      for (const f of dateien) {
        const teile = String(f.webkitRelativePath || f.name).split('/').filter(Boolean);
        teile.pop();
        for (let i = 1; i <= teile.length; i++) ordner.add(teile.slice(0, i).join('/'));
        liste.push({ datei: f, relativ: teile.join('/') });
      }
      const ordnerEintraege = [...ordner].sort((a, b) => a.split('/').length - b.split('/').length).map((relativ) => ({ ordner: true, relativ }));
      einreihen([...ordnerEintraege, ...liste], freigabe, pfad);
    });
    document.body.appendChild(ordnerEingabe);
  }
  ordnerEingabe.click();
}

function ablageEinrichten(bereich) {
  let tiefe = 0;
  // Ohne Schreibrecht nimmt die Ablage nichts an (der Browser zeigt dann seinen „verboten“-Zeiger)
  const hatDateien = (ev) => rechte.schreiben && ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files');
  bereich.addEventListener('dragenter', (ev) => { if (!hatDateien(ev)) return; ev.preventDefault(); tiefe++; bereich.classList.add('ablage-aktiv'); });
  bereich.addEventListener('dragover', (ev) => { if (!hatDateien(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
  bereich.addEventListener('dragleave', () => { tiefe = Math.max(0, tiefe - 1); if (!tiefe) bereich.classList.remove('ablage-aktiv'); });
  bereich.addEventListener('drop', async (ev) => {
    if (!hatDateien(ev)) return;
    ev.preventDefault(); tiefe = 0; bereich.classList.remove('ablage-aktiv');
    const zielFreigabe = freigabe; const zielPfad = pfad;
    const gesammelt = await sammleAblage(ev.dataTransfer);
    einreihen(gesammelt, zielFreigabe, zielPfad);
  });
}

/** Liest DataTransfer (auch Ordner über webkitGetAsEntry) zu [{datei, relativ}]. */
async function sammleAblage(dt) {
  const aus = [];
  const items = dt.items ? [...dt.items] : [];
  const eintraege = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (eintraege.some(Boolean)) {
    for (const eintrag of eintraege) { if (eintrag) await leseEintrag(eintrag, '', aus); }
    if (aus.length) return aus;
  }
  for (const f of [...(dt.files || [])]) aus.push({ datei: f, relativ: '' });
  return aus;
}

function leseEintrag(eintrag, relativ, aus) {
  return new Promise((ok) => {
    if (eintrag.isFile) { eintrag.file((f) => { aus.push({ datei: f, relativ }); ok(); }, () => ok()); return; }
    if (!eintrag.isDirectory) { ok(); return; }
    const leser = eintrag.createReader(); const unter = verbinde(relativ, eintrag.name);
    aus.push({ ordner: true, relativ: unter });
    const lese = () => leser.readEntries(async (liste) => {
      if (!liste.length) { ok(); return; }
      for (const e of liste) await leseEintrag(e, unter, aus);
      lese();
    }, () => ok());
    lese();
  });
}

async function einreihen(liste, zielFreigabe, zielPfad) {
  const dateien = liste.filter((x) => x.datei);
  const ordner = liste.filter((x) => x.ordner).map((x) => x.relativ);
  if (!dateien.length && !ordner.length) return;
  const sitzung = uploadSitzung;
  const neu = dateien.map(({ datei, relativ }) => ({ id: `u-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: verbinde(relativ, datei.name), datei, relativ, freigabe: zielFreigabe, pfad: zielPfad, groesse: datei.size, geladen: 0, status: 'wartet', bei: 'fehler' }));
  let entscheidungen;
  try { entscheidungen = await uploadKonflikte(neu); } catch (e) { ctx.zeigeFehler(e); return; }
  if (!entscheidungen || sitzung !== uploadSitzung) return; // abgebrochen oder inzwischen abgemeldet
  const bleiben = neu.filter((u) => entscheidungen.get(u) !== 'ueberspringen');
  const uebersprungen = neu.length - bleiben.length;
  if (uebersprungen) ctx.melden(t('dateien.uebersprungen', { n: uebersprungen }), 'info');
  if (!bleiben.length && dateien.length) return; // alles übersprungen: auch keine Ordner anlegen
  for (const u of bleiben) u.bei = entscheidungen.get(u) || 'fehler';
  neuerStapel();
  for (const o of ordner) uploads.push({ id: `u-${Date.now()}-${Math.random().toString(36).slice(2)}`, ordner: true, name: o, freigabe: zielFreigabe, pfad: zielPfad, status: 'wartet' });
  for (const u of bleiben) uploads.push(u);
  uploadTafelZeigen();
  naechsterUpload();
}

// ---------------------------------------------------------------------------------------------------------------------
// Namenskonflikte: Rückfrage vor Hochladen, Kopieren und Verschieben (Ersetzen / Beide behalten / Überspringen)
// ---------------------------------------------------------------------------------------------------------------------
const VORHANDEN_JE_ANFRAGE = 1000;
const KONFLIKT_WAHLEN = ['ersetzen', 'beide', 'ueberspringen'];

/** Welche Namen (relativ zu zielPfad, auch mit Unterordnern) gibt es am Ziel schon? Map name → {art, groesse, geaendert}. */
async function vorhandeneNamen(zielFreigabe, zielPfad, namen) {
  const aus = new Map();
  for (let i = 0; i < namen.length; i += VORHANDEN_JE_ANFRAGE) {
    const r = await ctx.api('dateien.vorhanden', { freigabe: zielFreigabe, pfad: zielPfad, namen: namen.slice(i, i + VORHANDEN_JE_ANFRAGE) });
    for (const v of (r && Array.isArray(r.vorhanden) ? r.vorhanden : [])) aus.set(v.name, v);
  }
  return aus;
}

/** Hat die Freigabe einen Papierkorb? (bestimmt, ob „Ersetzen“ die alte Version aufhebt) */
function papierkorbIn(name) {
  if (name === freigabe) return rechte.papierkorb !== false;
  const f = freigabenCache ? freigabenCache.find((x) => x.name === name) : null;
  return !(f && f.papierkorb === false);
}

/**
 * Geht die Konflikte der Reihe nach durch. `frage(konflikt, rest)` → {wahl, fuerAlle} | null (= alles abbrechen).
 * „Für alle übrigen“ gilt nur für Konflikte, die diese Wahl erlauben (z. B. kann eine Datei keinen Ordner ersetzen) –
 * die anderen werden weiter einzeln gefragt. Ergebnis: Map konflikt → 'ersetzen'|'beide'|'ueberspringen', oder null.
 */
export async function konflikteEntscheiden(konflikte, frage) {
  const aus = new Map();
  let fuerAlle = null;
  for (const [i, k] of konflikte.entries()) {
    const erlaubt = k.erlaubt || KONFLIKT_WAHLEN;
    if (fuerAlle && erlaubt.includes(fuerAlle)) { aus.set(k, fuerAlle); continue; }
    const antwort = await frage(k, konflikte.length - i - 1);
    if (!antwort || !erlaubt.includes(antwort.wahl)) return null;
    aus.set(k, antwort.wahl);
    if (antwort.fuerAlle) fuerAlle = antwort.wahl;
  }
  return aus;
}

/** Vorschlag für „Beide behalten“ wie im Agenten: „Bericht.pdf“ → „Bericht (1).pdf“, „Bild (2).png“ → „Bild (3).png“. */
export function nummerierterName(name) {
  const m = /^(.+?)((?:\.tar)?\.[^.\s]{1,12})$/i.exec(name);
  const [stamm, endung] = m ? [m[1], m[2]] : [name, ''];
  const n = /^(.*\S) \((\d{1,6})\)$/.exec(stamm);
  return n ? `${n[1]} (${Number(n[2]) + 1})${endung}` : `${stamm} (1)${endung}`;
}

/**
 * Upload-Einträge {name, datei, freigabe, pfad} gegen das Ziel prüfen und bei Konflikten fragen.
 * Map eintrag → 'fehler' (Name frei – der Agent überschreibt dann trotzdem nie) | 'ersetzen' | 'beide' | 'ueberspringen';
 * null = abgebrochen.
 */
async function uploadKonflikte(eintraege) {
  const aus = new Map(eintraege.map((u) => [u, 'fehler']));
  const gruppen = new Map();
  for (const u of eintraege) { const s = `${u.freigabe}\n${u.pfad}`; if (!gruppen.has(s)) gruppen.set(s, []); gruppen.get(s).push(u); }
  const konflikte = [];
  for (const liste of gruppen.values()) {
    const vorhanden = await vorhandeneNamen(liste[0].freigabe, liste[0].pfad, liste.map((u) => u.name));
    for (const u of liste) {
      const v = vorhanden.get(u.name);
      if (!v) continue;
      const neuGeaendert = u.datei && u.datei.lastModified ? new Date(u.datei.lastModified).toISOString() : null;
      konflikte.push({ name: u.name, eintrag: u, vorhanden: v, neu: { art: 'datei', groesse: u.groesse, geaendert: neuGeaendert }, erlaubt: v.art === 'ordner' ? ['beide', 'ueberspringen'] : KONFLIKT_WAHLEN });
    }
  }
  if (!konflikte.length) return aus;
  const entscheidungen = await konflikteEntscheiden(konflikte, (k, rest) => konfliktFrage(k, rest, { papierkorb: papierkorbIn(k.eintrag.freigabe), art: 'hochladen' }));
  if (!entscheidungen) return null;
  for (const k of konflikte) aus.set(k.eintrag, entscheidungen.get(k));
  return aus;
}

function konfliktBeschreibung(info) {
  if (!info) return '';
  if (info.art === 'ordner') return t('dateien.konflikt_ist_ordner');
  const teile = [];
  if (info.groesse != null) teile.push(format.groesse(info.groesse));
  if (info.geaendert) teile.push(t('dateien.konflikt_geaendert', { zeit: format.zeit(info.geaendert) }));
  return teile.join(' · ');
}

/** Dialog für EINEN Konflikt. Promise<{wahl, fuerAlle}|null> (null = Schließen/Abbrechen = ganzen Vorgang abbrechen). */
function konfliktFrage(k, rest, { papierkorb: korbAn = true, art = 'hochladen' } = {}) {
  return new Promise((aufloesen) => {
    let ergebnis = null;
    const erlaubt = k.erlaubt || KONFLIKT_WAHLEN;
    const kurzName = String(k.name).split('/').pop();
    const fuerAlle = rest > 0 ? el('input', { type: 'checkbox' }) : null;
    const waehle = (wahl) => { ergebnis = { wahl, fuerAlle: !!(fuerAlle && fuerAlle.checked) }; d.schliessen(); };
    const erklaerungen = {
      ersetzen: t(korbAn ? 'dateien.konflikt_ersetzen_erklaerung' : 'dateien.konflikt_ersetzen_ohne_korb'),
      beide: t('dateien.konflikt_beide_erklaerung', { name: nummerierterName(kurzName) }),
      ueberspringen: t(`dateien.konflikt_ueberspringen_${art === 'hochladen' ? 'hochladen' : 'uebertragen'}`),
    };
    const wahlen = KONFLIKT_WAHLEN.filter((w) => erlaubt.includes(w)).map((w) => el('button', { class: `dateien-konflikt-wahl${w === 'ersetzen' && !korbAn ? ' gefahr' : ''}`, type: 'button', dataset: { wahl: w }, onclick: () => waehle(w) }, [
      el('span', { class: 'dateien-konflikt-wahl-titel', text: t(`dateien.konflikt_${w}`) }),
      el('span', { class: 'erklaerung', text: erklaerungen[w] }),
    ]));
    const d = ctx.dialog([
      el('p', { class: 'dialog-text', text: t(k.vorhanden && k.vorhanden.art === 'ordner' ? 'dateien.konflikt_text_ordner' : 'dateien.konflikt_text') }),
      k.name !== kurzName ? el('p', { class: 'schwach klein dateien-konflikt-pfad', text: k.name }) : null,
      el('dl', { class: 'dateien-konflikt-vergleich' }, [
        el('dt', { text: t('dateien.konflikt_vorhanden') }), el('dd', { text: konfliktBeschreibung(k.vorhanden) }),
        el('dt', { text: t('dateien.konflikt_neu') }), el('dd', { text: konfliktBeschreibung(k.neu) }),
      ]),
      el('div', { class: 'dateien-konflikt-wahlen' }, wahlen),
      fuerAlle ? el('label', { class: 'dateien-konflikt-alle' }, [fuerAlle, el('span', { text: t('dateien.konflikt_fuer_alle', { n: rest }) })]) : null,
      el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t(art === 'hochladen' ? 'dateien.konflikt_abbrechen_hochladen' : 'dateien.konflikt_abbrechen'))]),
    ], { titel: t('dateien.konflikt_titel', { name: kurzName }), klasse: 'dateien-konflikt', festhalten: true, beimSchliessen: () => aufloesen(ergebnis) });
    const erste = d.koerper.querySelector('.dateien-konflikt-wahl');
    if (erste && typeof erste.focus === 'function') erste.focus();
  });
}

/**
 * Beginnt ein neuer Stapel (nichts wartet oder läuft mehr – neue Auswahl oder „Erneut versuchen“), fliegen alte
 * „fertig“/„abgebrochen“-Zeilen raus (Fehler bleiben bis „Erneut versuchen“ oder X), damit Tafel und Erfolgsmeldung nur
 * den neuen Stapel zählen. Läuft noch etwas, gehört der Nachschub zum laufenden Stapel.
 */
function neuerStapel() {
  if (uploads.some((u) => u.status === 'wartet' || u.status === 'laeuft')) return;
  clearTimeout(uploadAufraeumTimer);
  for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].status === 'fertig' || uploads[i].status === 'abgebrochen') uploads.splice(i, 1);
}

// Die Tafel hängt am body, damit laufende Uploads auch beim Ansichtenwechsel sichtbar bleiben. Sichtbar ist sie nur,
// solange `uploads` etwas zu zeigen hat – eine geschlossene Tafel darf ein Ordnerwechsel nicht wieder anhängen.
function uploadTafelAnhaengen() { if (uploadTafel && uploads.length && !uploadTafel.isConnected) document.body.appendChild(uploadTafel); }

/**
 * Einen Upload abbrechen. Wartende sofort; laufende über ihren Abbruch – und per Merker `abbruch`, der auch greift,
 * solange der Upload noch seinen Zielordner anlegt (dann gibt es noch kein `abbrechen`).
 */
function uploadAbbrechen(u) {
  if (u.status === 'wartet') u.status = 'abgebrochen';
  else if (u.status === 'laeuft') { u.abbruch = true; if (u.abbrechen) u.abbrechen(); }
}
const abgebrochenFehler = () => Object.assign(new Error('abgebrochen'), { code: 'E_ABGEBROCHEN' });

/**
 * Einträge der Tafel: alle Dateien plus fehlgeschlagene Ordner (sonst stünde ein Fehler ohne Zeile da). Gibt es keine
 * Datei (z. B. ein leerer Ordner wurde abgelegt), zeigen die gerade angelegten Ordner, was passiert.
 */
function tafelEintraege() {
  const sichtbar = uploads.filter((x) => !x.ordner || x.status === 'fehler');
  return sichtbar.length ? sichtbar : uploads.filter((x) => x.status === 'wartet' || x.status === 'laeuft');
}

/**
 * Zeilen der Tafel: laufende und fehlgeschlagene immer (nie verdrängt); bis MAX_TAFEL_ZEILEN aufgefüllt mit den
 * nächsten wartenden, dann den zuletzt fertigen. Reihenfolge wie in der Warteschlange.
 */
function tafelZeilen(eintraege) {
  if (eintraege.length <= MAX_TAFEL_ZEILEN) return eintraege;
  const auswahl = new Set(eintraege.filter((x) => x.status === 'laeuft' || x.status === 'fehler'));
  const nimm = (liste) => { for (const x of liste) { if (auswahl.size >= MAX_TAFEL_ZEILEN) return; auswahl.add(x); } };
  nimm(eintraege.filter((x) => x.status === 'wartet'));
  nimm(eintraege.filter((x) => x.status === 'fertig' || x.status === 'abgebrochen').reverse());
  return eintraege.filter((x) => auswahl.has(x));
}

/** Tafel endgültig schließen: Liste leeren, Aufräum-Zeitgeber stoppen, Knoten verwerfen (der nächste Stapel baut neu). */
function uploadTafelSchliessen() {
  uploads.length = 0;
  clearTimeout(uploadAufraeumTimer);
  if (uploadTafel) { uploadTafel.remove(); uploadTafel = null; }
}

function uploadTafelZeigen() {
  const laufend = uploads.some((u) => u.status === 'wartet' || u.status === 'laeuft');
  const eintraege = tafelEintraege();
  // Nichts zu zeigen (nach dem Abmelden verworfen, oder nur fertig angelegte Ordner eines leeren Ordners): schließen
  if (!uploads.length || (!eintraege.length && !laufend)) { uploadTafelSchliessen(); return; }
  if (!uploadTafel) {
    uploadTafel = el('aside', { class: 'karte dateien-uploads', 'aria-live': 'polite', 'aria-label': t('dateien.hochladen_tafel') });
  }
  uploadTafelAnhaengen();
  uploadTafel.textContent = '';
  const fertig = uploads.filter((u) => !u.ordner && u.status === 'fertig').length;
  const alleFertig = !laufend;
  const mitFehlern = alleFertig && uploads.some((u) => u.status === 'fehler');
  // Kopf: Titel + X in einer Zeile; Sammelknöpfe darunter (sonst drückt „Alle fehlgeschlagenen erneut versuchen“ den
  // Titel auf drei Zeilen und ragt aus der Tafel). „Alle abbrechen“ nur, solange etwas wartet oder läuft.
  uploadTafel.appendChild(el('div', { class: 'dateien-uploads-kopf' }, [
    el('h2', { text: t('dateien.hochladen_stand', { fertig, gesamt: eintraege.length }) }), // gesamt = Einträge wie die Zeilen
    alleFertig ? el('button', { class: 'knopf-symbol', type: 'button', title: t('rahmen.schliessen'), 'aria-label': t('rahmen.schliessen'), onclick: () => uploadTafelSchliessen() }, [symbol('schliessen')]) : null,
  ]));
  if (laufend || mitFehlern) {
    uploadTafel.appendChild(el('div', { class: 'dateien-uploads-aktionen' }, [
      laufend ? el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => { for (const u of uploads) uploadAbbrechen(u); uploadTafelZeigen(); } }, t('dateien.alle_abbrechen')) : null,
      mitFehlern ? el('button', { class: 'knopf knopf-klein', type: 'button', onclick: () => uploadWiederholen(uploads.filter((u) => u.status === 'fehler')) }, t('dateien.alle_erneut')) : null,
    ]));
  }
  const zeilen = tafelZeilen(eintraege);
  for (const u of zeilen) {
    const prozent = u.groesse ? Math.round((u.geladen / u.groesse) * 100) : (u.status === 'fertig' ? 100 : 0);
    const name = u.ordner ? `${u.name}/` : u.name;
    uploadTafel.appendChild(el('div', { class: `dateien-upload ${u.status}`, dataset: { upload: u.id } }, [
      el('span', { class: 'dateien-upload-name', title: name, text: name }),
      u.status === 'wartet' || u.status === 'laeuft' ? el('button', { class: 'knopf-symbol', type: 'button', title: t('rahmen.abbrechen'), 'aria-label': t('rahmen.abbrechen'), onclick: () => { uploadAbbrechen(u); uploadTafelZeigen(); } }, [symbol('schliessen')])
        : u.status === 'fehler' ? el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => uploadWiederholen([u]) }, t('dateien.erneut_versuchen'))
        : el('span', { class: `plakette ${u.status === 'fertig' ? 'plakette-erfolg' : ''}`, text: t(`dateien.upload_${u.status}`) }),
      el('div', { class: `fortschritt${u.status === 'fehler' ? ' gefahr' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(prozent) }, [el('div', { class: 'fortschritt-balken', style: { '--anteil': `${u.status === 'fertig' ? 100 : prozent}%` } })]),
      el('span', { class: 'dateien-upload-status', text: u.status === 'fehler' ? (u.fehler || '') : u.ordner ? '' : u.status === 'laeuft' ? `${format.groesse(u.geladen)} / ${format.groesse(u.groesse)} · ${prozent} %` : u.hinweis ? `${format.groesse(u.groesse)} · ${u.hinweis}` : format.groesse(u.groesse) }),
    ]));
  }
  const verborgen = eintraege.length - zeilen.length;
  if (verborgen > 0) uploadTafel.appendChild(el('p', { class: 'dateien-uploads-weitere schwach klein', text: t('dateien.hochladen_weitere', { n: verborgen }) }));
}

/**
 * Fehlgeschlagene Uploads neu einreihen (Fortschritt zurücksetzen). Scheiterten sie am Namen (inzwischen vorhanden),
 * wird vorher erneut gefragt; „Überspringen“ nimmt sie aus der Tafel.
 */
async function uploadWiederholen(liste) {
  const sitzung = uploadSitzung;
  const konflikt = liste.filter((u) => !u.ordner && u.fehlerCode === 'E_EXISTIERT');
  if (konflikt.length) {
    let entscheidungen;
    try { entscheidungen = await uploadKonflikte(konflikt); } catch (e) { ctx.zeigeFehler(e); return; }
    if (!entscheidungen || sitzung !== uploadSitzung) return;
    for (const u of konflikt) {
      const wahl = entscheidungen.get(u);
      if (wahl === 'ueberspringen') { const i = uploads.indexOf(u); if (i >= 0) uploads.splice(i, 1); liste = liste.filter((x) => x !== u); } else u.bei = wahl || 'fehler';
    }
  }
  neuerStapel();
  for (const u of liste) { u.status = 'wartet'; u.geladen = 0; u.fehler = ''; u.fehlerCode = null; u.hinweis = ''; u.abbrechen = null; u.abbruch = false; u.versuch = 0; u.nichtVor = 0; }
  uploadTafelZeigen(); naechsterUpload();
}

/**
 * Nach dem letzten Upload: Erfolgreiche und abgebrochene Einträge verschwinden nach 5 s von selbst; bleibt nichts
 * übrig, schließt sich die Tafel. Fehlgeschlagene bleiben mit „Erneut versuchen“ stehen (Betreiber-Vorgabe).
 */
let uploadAufraeumTimer = null;
function uploadTafelSpaeterAufraeumen() {
  clearTimeout(uploadAufraeumTimer);
  uploadAufraeumTimer = setTimeout(() => {
    if (uploads.some((x) => x.status === 'wartet' || x.status === 'laeuft')) return; // inzwischen geht es weiter
    for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].status !== 'fehler') uploads.splice(i, 1);
    if (!uploads.length) { uploadTafelSchliessen(); return; }
    uploadTafelZeigen();
  }, UPLOAD_TAFEL_SCHLIESSEN_MS);
}

const angelegteOrdner = new Set(); // nur für den laufenden Stapel (spart dateien.ordner je Datei)
async function ordnerSicherstellen(zielFreigabe, zielPfad, relativ, u = null) {
  if (!relativ) return;
  const teile = relativ.split('/');
  let aktuell = zielPfad;
  for (const teil of teile) {
    const schluessel = `${zielFreigabe}:${verbinde(aktuell, teil)}`;
    if (!angelegteOrdner.has(schluessel)) {
      if (u && u.abbruch) throw abgebrochenFehler(); // abgebrochen/abgemeldet: keine weitere Ebene mehr anlegen
      try { await ctx.api('dateien.ordner', { freigabe: zielFreigabe, pfad: aktuell, name: teil }); } catch (e) { if (!e || e.code !== 'E_EXISTIERT') throw e; }
      angelegteOrdner.add(schluessel);
      // Ein zuvor gescheiterter Ordner-Eintrag desselben Ordners ist damit erledigt (sonst bliebe ein toter Fehler stehen)
      let erledigt = false;
      for (const x of uploads) if (x.ordner && x.status === 'fehler' && `${x.freigabe}:${verbinde(x.pfad, x.name)}` === schluessel) { x.status = 'fertig'; x.fehler = ''; erledigt = true; }
      if (erledigt) uploadTafelZeigen();
    }
    aktuell = verbinde(aktuell, teil);
  }
}

async function naechsterUpload() {
  let gestartet = false;
  while (uploadLaeuft < PARALLELE_UPLOADS) {
    const u = uploads.find((x) => x.status === 'wartet' && !(x.nichtVor > Date.now()));
    if (!u) break;
    u.status = 'laeuft'; uploadLaeuft++; gestartet = true;
    const sitzung = uploadSitzung;
    (async () => {
      try {
        if (u.ordner) { await ordnerSicherstellen(u.freigabe, u.pfad, u.name, u); if (u.abbruch) throw abgebrochenFehler(); u.status = 'fertig'; return; }
        if (u.relativ) await ordnerSicherstellen(u.freigabe, u.pfad, u.relativ, u);
        if (u.abbruch) throw abgebrochenFehler(); // während der Ordneranlage abgebrochen (auch beim Abmelden)
        const lauf = ctx.hochladen({ freigabe: u.freigabe, pfad: verbinde(u.pfad, u.relativ), name: u.datei.name, datei: u.datei, beiVorhanden: u.bei || 'fehler', beiFortschritt: (g) => { u.geladen = g; uploadFortschrittZeigen(u); } });
        u.abbrechen = lauf.abbrechen;
        const erg = await lauf.fertig;
        u.geladen = u.groesse; u.status = 'fertig';
        u.hinweis = erg && erg.umbenannt ? t('dateien.upload_als', { name: erg.name }) : erg && erg.ersetzt ? t('dateien.upload_ersetzt') : '';
      } catch (e) {
        if (u.ordner && !u.abbruch && angelegteOrdner.has(`${u.freigabe}:${verbinde(u.pfad, u.name)}`)) {
          u.status = 'fertig'; // gescheitert, aber inzwischen von einer Datei desselben Stapels angelegt
        } else if (!u.ordner && !u.abbruch && uploadVoruebergehend(e) && (u.versuch || 0) < UPLOAD_WIEDERHOLUNGEN) {
          // Vorübergehender Fehler: nach 10 s automatisch neu versuchen (bleibt „wartet“, damit der Stapel nicht endet)
          u.versuch = (u.versuch || 0) + 1;
          u.status = 'wartet'; u.geladen = 0; u.nichtVor = Date.now() + UPLOAD_WIEDERHOLEN_MS;
          u.hinweis = t('dateien.upload_neuer_versuch', { n: u.versuch, von: UPLOAD_WIEDERHOLUNGEN });
          setTimeout(() => { if (sitzung === uploadSitzung) { u.nichtVor = 0; naechsterUpload(); } }, UPLOAD_WIEDERHOLEN_MS);
        } else {
          // Abgebrochen (auch nach dem Abmelden, wenn die Anfrage dann mit 401 scheitert) meldet keinen Fehler
          u.status = u.abbruch || (e && e.code === 'E_ABGEBROCHEN') ? 'abgebrochen' : 'fehler';
          u.fehler = u.versuch ? t('dateien.upload_nach_versuchen', { grund: ctx.fehlerText(e), n: u.versuch }) : ctx.fehlerText(e); u.fehlerCode = e && e.code;
          if (u.status === 'fehler') ctx.melden(t('dateien.upload_fehlgeschlagen', { name: u.name, grund: u.fehler }), 'fehler');
        }
      } finally {
        // Nach dem Abmelden zurückgekehrt (z. B. hängende Ordneranlage): Plätze, Tafel und Meldungen gehören schon der
        // neuen Sitzung – nichts mehr anfassen (sitzungEnde hat uploadLaeuft bereits auf 0 gesetzt).
        if (sitzung !== uploadSitzung) return;
        uploadLaeuft--;
        uploadTafelZeigen();
        if (wurzel && u.freigabe === freigabe && u.pfad === pfad && !papierkorb) neuladenSpaeter();
        if (!uploads.some((x) => x.status === 'wartet' || x.status === 'laeuft')) {
          // Stapel zu Ende: angelegte Ordner nicht über den Stapel hinaus merken – sie können bis zum nächsten Hochladen
          // gelöscht werden, und der Agent nimmt Dateien nur in einen vorhandenen Ordner an.
          angelegteOrdner.clear();
          const fertige = uploads.filter((x) => !x.ordner && x.status === 'fertig').length;
          if (fertige) ctx.melden(t('dateien.uploads_fertig', { n: fertige }), 'erfolg');
          uploadTafelSpaeterAufraeumen();
        }
        naechsterUpload();
      }
    })();
  }
  if (gestartet) uploadTafelZeigen(); // Zeilen der gestarteten Uploads auf „läuft“ (und bei vielen Dateien sichtbar)
}

function uploadFortschrittZeigen(u) {
  if (!uploadTafel) return;
  const zeile = [...uploadTafel.querySelectorAll('.dateien-upload')].find((z) => z.dataset.upload === u.id); if (!zeile) return;
  const prozent = u.groesse ? Math.round((u.geladen / u.groesse) * 100) : 0;
  const balkenKnoten = zeile.querySelector('.fortschritt'); if (balkenKnoten) { balkenKnoten.setAttribute('aria-valuenow', String(prozent)); balkenKnoten.firstElementChild.style.setProperty('--anteil', `${prozent}%`); }
  const status = zeile.querySelector('.dateien-upload-status'); if (status) status.textContent = `${format.groesse(u.geladen)} / ${format.groesse(u.groesse)} · ${prozent} %`;
}

function neuladenSpaeter() { clearTimeout(neuladenTimer); neuladenTimer = setTimeout(() => { if (wurzel && freigabe && !papierkorb) ladeListe(); }, 400); }

// ---------------------------------------------------------------------------------------------------------------------
// Ansicht
// ---------------------------------------------------------------------------------------------------------------------

function routeAnwenden(route) {
  const teile = route && Array.isArray(route.teile) ? route.teile : [];
  const neueFreigabe = teile[0] || null;
  const neuerPapierkorb = teile[1] === PAPIERKORB_MARKE;
  const neuerPfad = neuerPapierkorb ? '' : teile.slice(1).filter((s) => s !== '.' && s !== '..').join('/');
  freigabe = neueFreigabe; pfad = neuerPfad; papierkorb = neuerPapierkorb;
  if (!freigabe) { ctx.setzeTitel(t('dateien.titel')); return zeigeFreigaben(); }
  if (papierkorb) return zeigePapierkorb();
  return zeigeOrdner();
}

let favoritenAbmelden = null;   // Stern folgt Änderungen aus Navigation/Übersicht/anderem Ordnermenü

export default {
  id: 'dateien',
  symbol: 'dateien',
  rolle: 'nutzer',
  titel() { return t('dateien.titel'); },

  async einbinden(w, c) {
    wurzel = w; ctx = c;
    ladeEinstellungen();
    if (!favoritenAbmelden) favoritenAbmelden = favoriten.beiAenderung(() => sternSetzen());
    ctx.sse.on('konfig', (e) => { if (!e || !e.bereich || e.bereich === 'freigaben') { freigabenCache = null; if (!freigabe && wurzel) zeigeFreigaben(); } });
    await routeAnwenden(ctx.route);
  },

  async navigieren(route) { await routeAnwenden(route); },

  verlassen() {
    if (favoritenAbmelden) { favoritenAbmelden(); favoritenAbmelden = null; }
    ladeNummer++;
    clearTimeout(neuladenTimer); clearTimeout(kachelTimer); kachelTimer = null;
    // ctx bleibt absichtlich erhalten: laufende Uploads melden noch über ctx.melden/ctx.fehlerText.
    wurzel = null; freigabe = null; pfad = ''; papierkorb = false; eintraege = []; auswahl = new Set();
    for (const k of Object.keys(knoten)) delete knoten[k];
    // Laufende und fehlgeschlagene Uploads bleiben sichtbar (Tafel am body, auch in anderen Ansichten) – Fehler bis
    // „Erneut versuchen“ oder X; nur eine erledigte Tafel schließt beim Verlassen sofort.
    if (!uploads.some((u) => u.status === 'wartet' || u.status === 'laeuft' || u.status === 'fehler')) uploadTafelSchliessen();
  },

  /** Abmelden/Sitzung abgelaufen: Uploads abbrechen und vergessen – der nächste Nutzer im selben Tab sieht nichts davon. */
  sitzungEnde() {
    for (const u of uploads) uploadAbbrechen(u);
    uploadSitzung++; uploadLaeuft = 0;
    uploadTafelSchliessen();
    freigabenCache = null; angelegteOrdner.clear();
  },
};
