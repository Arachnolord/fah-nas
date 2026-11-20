// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rahmen der Oberfläche: Sprache, Ersteinrichtung/Anmeldung, Navigation, Routing über location.hash, Kopfzeile,
// Design-Umschalter, Zustandsleiste (Steuerdienst getrennt), Meldungen, Dialoge, Aufgabenverfolgung.
// Ansichten liegen in ./ansichten/<id>.js (Vertrag: docs/schnittstellen.md §8) und werden erst bei Bedarf geladen.

import { api, get, post, hochladen, ladeBlob, downloadUrl, vorschauUrl, sseVerbinden, setzeTexte, ApiFehler, letzterFehler } from './api.js';
import { avatareSetzen, avatarKnoten } from './avatar.js';
import { agentText, agentTexteLaden } from './agent-text.js';
import { wasTunSetzen } from './ansichten/verwaltung-hilfen.js';
import { ladeSprache, erzeugeT } from './sprache.js';
import { anwenden as darstellungAnwenden, zwischengespeichert as darstellungCache, STANDARD as DARSTELLUNG_STANDARD } from './darstellung.js';
import { ANSICHTEN, GRUPPEN } from './ansichten/index.js';
import * as favoriten from './favoriten.js';

// ---------------------------------------------------------------------------------------------------------------------
// Öffentliche Helfer (auch für Ansichten von Teil F): el, symbol, t (Live-Bindung), format
// ---------------------------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'use', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'text', 'defs', 'symbol']);
const EIGENSCHAFTEN = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'indeterminate', 'open', 'readOnly', 'multiple', 'defaultValue']);

/**
 * Baut ein DOM-Element: el('div', {class:'karte', onclick: fn, 'aria-label': 'x', dataset:{id:1}}, ['Text', kind]).
 * Nutzerdaten gehen immer als Text hinein (textContent), niemals als HTML.
 */
export function el(tag, attrs, kinder, ...weitere) {
  const knoten = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') { if (SVG_TAGS.has(tag)) knoten.setAttribute('class', v); else knoten.className = v; }
      else if (k === 'text') knoten.textContent = String(v);
      else if (k === 'dataset' && typeof v === 'object') { for (const [dk, dv] of Object.entries(v)) if (dv != null) knoten.dataset[dk] = String(dv); }
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) if (sv != null) { if (sk.startsWith('--')) knoten.style.setProperty(sk, String(sv)); else knoten.style[sk] = sv; } }
      else if (k.startsWith('on') && typeof v === 'function') knoten.addEventListener(k.slice(2).toLowerCase(), v);
      else if (EIGENSCHAFTEN.has(k)) knoten[k] = v;
      else if (k === 'href' && SVG_TAGS.has(tag)) knoten.setAttribute('href', String(v));
      else knoten.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (attrs !== undefined && attrs !== null) {
    weitere.unshift(kinder); kinder = attrs;
  }
  anhaengen(knoten, kinder);
  for (const w of weitere) anhaengen(knoten, w);
  return knoten;
}

function anhaengen(knoten, kind) {
  if (kind === undefined || kind === null || kind === false || kind === true) return;
  if (Array.isArray(kind)) { for (const k of kind) anhaengen(knoten, k); return; }
  if (kind instanceof Node) { knoten.appendChild(kind); return; }
  knoten.appendChild(document.createTextNode(String(kind)));
}

const SYMBOLE_URL = new URL('./symbole.svg', import.meta.url).href;

/** Symbol aus symbole.svg: symbol('ordner', 'gross') → <svg class="symbol gross"><use href="…#symbol-ordner"/></svg> */
export function symbol(name, klasse = '') {
  const svg = el('svg', { class: `symbol${klasse ? ' ' + klasse : ''}`, 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(el('use', { href: `${SYMBOLE_URL}#symbol-${name}` }));
  return svg;
}

/** Übersetzung – Live-Bindung: wird nach dem Laden der Sprache ersetzt; bis dahin gibt sie den Schlüssel zurück. */
export let t = Object.assign((schluessel) => schluessel, { hat: () => false, fehlend: new Set(), texte: {} });

/** Gebietsschema der Oberfläche (Zahlen, Datum): folgt der geladenen Sprache (html lang). */
export function gebiet() { return typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE'; }

const NUMMER = typeof Intl !== 'undefined' ? new Map() : null;
function zahlFormat(nachkomma) {
  if (!NUMMER) return { format: (w) => String(Math.round(w * 10 ** nachkomma) / 10 ** nachkomma) };
  const k = `${gebiet()}:${nachkomma}`;
  if (!NUMMER.has(k)) NUMMER.set(k, new Intl.NumberFormat(gebiet(), { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma }));
  return NUMMER.get(k);
}

/** Lesbare Größen, Zeiten, Dauern – alles Deutsch mit Komma. */
export const format = {
  zahl(w, nachkomma = 0) { if (w == null || !Number.isFinite(Number(w))) return '–'; return zahlFormat(nachkomma).format(Number(w)); },
  prozent(p, nachkomma = 0) { if (p == null || !Number.isFinite(Number(p))) return '–'; return `${format.zahl(p, nachkomma)} %`; },
  /** Binär (1024er-Schritte) mit den passenden Einheiten KiB/MiB/GiB – so rechnet auch der Agent (groesse_gb × 1024³). */
  groesse(bytes) {
    if (bytes == null || !Number.isFinite(Number(bytes))) return '–';
    const einheiten = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let w = Math.max(0, Number(bytes)); let i = 0;
    while (w >= 1024 && i < einheiten.length - 1) { w /= 1024; i++; }
    return `${format.zahl(w, i === 0 ? 0 : (w < 10 ? 1 : 0))} ${einheiten[i]}`;
  },
  rate(bytesJeS) {
    if (bytesJeS == null || !Number.isFinite(Number(bytesJeS))) return '–';
    return `${format.groesse(bytesJeS)}/s`;
  },
  /** Kurze relative Zeit für die letzten 24 h, sonst Datum + Uhrzeit. */
  zeit(iso) {
    if (!iso) return '–';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return t('zeit.gerade');
    if (diff >= 0 && diff < 3600) return t('zeit.vor_minuten', { n: Math.floor(diff / 60) });
    if (diff >= 0 && diff < 86400) return t('zeit.vor_stunden', { n: Math.floor(diff / 3600) });
    return format.zeitGenau(d);
  },
  zeitGenau(iso) {
    if (!iso) return '–';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleString(gebiet(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return d.toISOString(); }
  },
  /** Dauer in Sekunden → "3 T 4 Std 5 Min" */
  dauer(sekunden) {
    const s = Math.max(0, Math.floor(Number(sekunden) || 0));
    const tage = Math.floor(s / 86400); const std = Math.floor((s % 86400) / 3600); const min = Math.floor((s % 3600) / 60);
    const teile = [];
    if (tage) teile.push(t('zeit.tage_kurz', { n: tage }));
    if (std || tage) teile.push(t('zeit.stunden_kurz', { n: std }));
    teile.push(t('zeit.minuten_kurz', { n: min }));
    return teile.join(' ');
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Routing: #/ansicht/teil1/teil2 …
// ---------------------------------------------------------------------------------------------------------------------

/** Zerlegt einen Hash in {id, teile}. '#/dateien/medien/Urlaub%202026' → {id:'dateien', teile:['medien','Urlaub 2026']} */
export function parseRoute(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (h.startsWith('/')) h = h.slice(1);
  const teile = h.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const id = teile.shift() || '';
  return { id: /^[a-z][a-z0-9_-]*$/.test(id) ? id : '', teile: teile.filter((s) => s !== '') };
}

/** Baut einen Hash: hashFuer('dateien', 'medien', 'Urlaub/2026') → '#/dateien/medien/Urlaub/2026' (je Segment kodiert). */
export function hashFuer(id, ...teile) {
  const segmente = [id];
  for (const tl of teile) {
    if (tl === undefined || tl === null || tl === '') continue;
    for (const s of String(tl).split('/')) if (s !== '') segmente.push(encodeURIComponent(s));
  }
  return '#/' + segmente.join('/');
}

// ---------------------------------------------------------------------------------------------------------------------
// Zustand des Rahmens
// ---------------------------------------------------------------------------------------------------------------------

const zustand = {
  nutzer: null, hostname: '', texte: {}, sse: null, sseGestartet: false,
  ansicht: null, modul: null, abmelder: [], geladeneCss: new Set(), startetGerade: false, agentGetrennt: false,
  titelText: '', titelZaehler: 0, chatRahmen: null, chatStartet: false,
};
const module = new Map();
const knoten = {};
const DESIGN_SCHLUESSEL = 'fahnas_design';
const SPRACH_SCHLUESSEL = 'fahnas_sprache';
const SPRACHEN = ['de', 'en'];

/** Eigene Sprachwahl dieses Browsers (Knopf „DE/EN“ oben rechts) oder null. */
function ladeSprachwahl() {
  try { const w = localStorage.getItem(SPRACH_SCHLUESSEL); return SPRACHEN.includes(w) ? w : null; } catch { return null; }
}

/** Startsprache vor der Anmeldung: eigene Wahl, sonst Browsersprache (Deutsch für de-*, sonst Englisch). */
function startSprache() {
  const w = ladeSprachwahl();
  if (w) return w;
  const b = typeof navigator !== 'undefined' ? String(navigator.language || 'de') : 'de';
  return /^de\b/i.test(b) ? 'de' : 'en';
}

/**
 * Texte einer Sprache laden. Englisch liegt über Deutsch – fehlt eine Übersetzung, erscheint der deutsche Text statt
 * des rohen Schlüssels.
 */
async function spracheLaden(code) {
  const de = await ladeSprache('de');
  let texte = de.texte;
  if (code === 'en') { const en = await ladeSprache('en'); texte = { ...de.texte, ...en.texte }; }
  zustand.texte = texte; zustand.sprache = code;
  t = erzeugeT(texte);
  await agentTexteLaden(code); // Englisch: Meldungen des Agenten übersetzen
  wasTunSetzen((f, text) => wasTunOeffnen(f, text), t('fehler.was_tun'));
  setzeTexte((c, details) => {
    if (c === 'NETZ') return t('fehler.netz');
    if (c === 'ZU_GROSS') return t('fehler.zu_gross');
    if (c === 'PROXY_ZU_GROSS') return t('fehler.proxy_zu_gross');
    return t.hat(`fehler.${c}`) ? t(`fehler.${c}`) : t('fehler.E_UNBEKANNT', details);
  });
  document.documentElement.lang = code;
}

/** Sprache umschalten (Kopfleiste): merken und die Oberfläche neu laden. */
export function spracheWechseln(code) {
  if (!SPRACHEN.includes(code)) return;
  try { localStorage.setItem(SPRACH_SCHLUESSEL, code); } catch { /* privater Modus */ }
  location.reload();
}
export function aktuelleSprache() { return zustand.sprache || 'de'; }
const DESIGNS = ['auto', 'hell', 'dunkel'];

function ladeDesign() {
  try { const w = localStorage.getItem(DESIGN_SCHLUESSEL); return DESIGNS.includes(w) ? w : null; } catch { return null; }
}

/** Setzt das Design am html-Element: 'hell' | 'dunkel' | 'auto' (= Systemeinstellung). */
export function setzeDesign(wahl, merken = true) {
  const w = DESIGNS.includes(wahl) ? wahl : 'auto';
  if (w === 'auto') delete document.documentElement.dataset.design; else document.documentElement.dataset.design = w;
  if (merken) { try { localStorage.setItem(DESIGN_SCHLUESSEL, w); } catch { /* privater Modus */ } }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dunkel = w === 'dunkel' || (w === 'auto' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dunkel ? '#1c1f23' : '#0e8a8a');
  }
  return w;
}
export function aktuellesDesign() { return document.documentElement.dataset.design || 'auto'; }

// ---------------------------------------------------------------------------------------------------------------------
// Meldungen, Dialoge, Zustandsleiste
// ---------------------------------------------------------------------------------------------------------------------

/** Toast unten: art = info | erfolg | fehler | warnung, verschwindet nach `dauer` ms (Standard 5 s). */
export function melden(text, art = 'info', dauer = 5000, fehler = null) {
  const behaelter = knoten.toasts || document.getElementById('toasts');
  if (!behaelter) return null;
  const arten = ['info', 'erfolg', 'fehler', 'warnung'];
  const a = arten.includes(art) ? art : 'info';
  const toast = el('div', { class: `toast toast-${a}`, role: a === 'fehler' ? 'alert' : 'status' }, [
    symbol(a === 'erfolg' ? 'erfolg' : a === 'fehler' ? 'fehler' : a === 'warnung' ? 'warnung' : 'info'),
    el('span', { class: 'toast-text', text: String(text) }),
    a === 'fehler' ? el('button', { class: 'toast-was-tun', type: 'button', onclick: () => { weg(); wasTunOeffnen(fehler, String(text)); } }, t('fehler.was_tun')) : null,
    el('button', { class: 'toast-schliessen', type: 'button', 'aria-label': t('rahmen.schliessen'), onclick: () => weg() }, [symbol('schliessen')]),
  ]);
  if (a === 'fehler' && dauer > 0 && dauer < 10000) dauer = 10000; // Zeit für „Was tun?“
  let timer = null;
  const weg = () => { clearTimeout(timer); if (toast.parentNode) toast.parentNode.removeChild(toast); };
  behaelter.appendChild(toast);
  while (behaelter.children.length > 4) behaelter.removeChild(behaelter.firstChild);
  if (dauer > 0) timer = setTimeout(weg, dauer);
  return { schliessen: weg, element: toast };
}

/** Meldung aus einem Fehler ableiten (deutsch, für Nutzer). */
export function fehlerText(e) {
  if (!e) return t('fehler.E_UNBEKANNT');
  if (typeof e === 'string') return e;
  const code = e.code || 'E_UNBEKANNT';
  if (e.details && e.details.grund === 'netz') return t('fehler.netz');
  if (e.message && e.message !== code) return agentText(e.message);
  return t.hat(`fehler.${code}`) ? t(`fehler.${code}`) : t('fehler.E_UNBEKANNT');
}

/**
 * Fenster „Was tun?“ (Betreiber 12.10.2026: „Fehlermeldungen immer mit einem Was-tun-Knopf“): Meldung, was du tun kannst
 * (je Fehlerart), betroffenes Feld, technische Details zum Kopieren, für Admins der Weg ins Protokoll. Ohne Fehlerobjekt
 * nimmt es den letzten Fehler einer Anfrage (höchstens 60 s alt).
 */
export function wasTunOeffnen(fehler = null, text = '') {
  const letzter = letzterFehler();
  const f = fehler && typeof fehler === 'object' ? { code: fehler.code, meldung: fehler.message || fehler.meldung, details: fehler.details }
    : (letzter && Date.now() - letzter.zeit < 60_000 ? letzter : null);
  const code = (f && f.code) || 'E_UNBEKANNT';
  const netz = !!(f && f.details && f.details.grund === 'netz');
  const meldung = text || (f && agentText(f.meldung)) || t('fehler.E_UNBEKANNT');
  const hilfe = netz ? t('fehler.hilfe_netz') : t.hat(`fehler.hilfe_${code}`) ? t(`fehler.hilfe_${code}`) : t('fehler.hilfe_E_UNBEKANNT');
  const feld = f && f.details && typeof f.details.feld === 'string' ? f.details.feld : null;
  const technik = JSON.stringify({ code, meldung: f ? f.meldung : text, details: f ? f.details : undefined, zeit: new Date().toISOString(), version: zustand.version || undefined }, null, 2);
  const admin = !!(zustand.nutzer && zustand.nutzer.rolle === 'admin');
  let d = null;
  d = dialog([
    el('p', { class: 'was-tun-meldung', text: meldung }),
    el('h3', { class: 'was-tun-titel', text: t('fehler.was_tun_titel') }),
    el('p', { text: hilfe }),
    feld ? el('p', { class: 'erklaerung', text: t('fehler.hilfe_feld', { feld }) }) : null,
    el('details', { class: 'was-tun-details' }, [el('summary', { text: t('fehler.details') }), el('pre', { class: 'was-tun-technik', text: technik })]),
    el('div', { class: 'dialog-knoepfe' }, [
      admin ? el('a', { class: 'knopf knopf-zweit', href: hashFuer('system', 'protokoll'), onclick: () => d && d.schliessen() }, t('fehler.protokoll')) : null,
      el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(technik); melden(t('fehler.kopiert'), 'erfolg'); } catch { melden(t('fehler.kopieren_fehl'), 'warnung'); } } }, t('fehler.details_kopieren')),
      el('button', { class: 'knopf', type: 'button', onclick: () => d && d.schliessen() }, t('rahmen.schliessen')),
    ]),
  ], { titel: t('fehler.was_tun'), klasse: 'was-tun-dialog' });
  return d;
}

/** Zeigt einen Fehler als Toast; 401 führt zur Anmeldung, E_AGENT zeigt zusätzlich die Zustandsleiste. */
export function zeigeFehler(e) {
  if (e && e.code === 'E_ANMELDUNG' && e.status === 401 && zustand.nutzer) { zustand.nutzer = null; sitzungBeendet(); zeigeSolo('anmeldung'); return; }
  if (e && e.code === 'E_AGENT') zeigeZustand(t('rahmen.agent_getrennt'), t('rahmen.agent_hinweis'));
  if (e && e.code === 'E_ABGEBROCHEN') { melden(fehlerText(e), 'info'); return; }
  melden(fehlerText(e), 'fehler', 10000, e);
  if (typeof console !== 'undefined' && e && !(e instanceof ApiFehler)) console.error(e);
}

/**
 * Modales Fenster. `inhalt` = Node | Text | Array. Optionen: {titel, breit, klasse, beimSchliessen, festhalten,
 * vorSchliessen}. Gibt {schliessen(wert, {sofort}), element, koerper} zurück. Esc schließt (natives <dialog>).
 * vorSchliessen (V3): async (wert) → boolean – Esc, Klick daneben, X und schliessen() fragen erst den Haken; nur
 * `true` schließt (false/Ausnahme: bleibt offen), weitere Versuche während der Prüfung zählen nicht. `{sofort:true}`
 * umgeht ihn. Erzwingt der Browser das Schließen (zweites Esc ohne Klick), öffnet der Dialog wieder und fragt.
 */
export function dialog(inhalt, optionen = {}) {
  const d = el('dialog', { class: `dialog${optionen.breit ? ' dialog-breit' : ''}${optionen.klasse ? ' ' + optionen.klasse : ''}`, 'aria-labelledby': optionen.titel ? 'dialog-titel-' + (++dialogZaehler) : undefined });
  const koerper = el('div', { class: 'dialog-koerper' }, inhalt);
  const kopf = el('div', { class: 'dialog-kopf' }, [
    optionen.titel ? el('h2', { class: 'dialog-titel', id: d.getAttribute('aria-labelledby'), text: optionen.titel }) : el('span'),
    el('button', { class: 'knopf-symbol dialog-schliessen', type: 'button', 'aria-label': t('rahmen.schliessen'), onclick: () => schliessen() }, [symbol('schliessen')]),
  ]);
  d.appendChild(kopf); d.appendChild(koerper);
  let zu = false;
  let pruefend = false;
  const endgueltig = (wert) => {
    if (zu) return; zu = true;
    try { if (d.open) d.close(); } catch { /* egal */ }
    if (d.parentNode) d.parentNode.removeChild(d);
    if (optionen.beimSchliessen) { try { optionen.beimSchliessen(wert); } catch (e) { console.error(e); } }
  };
  const schliessen = (wert, { sofort = false } = {}) => {
    if (zu) return;
    if (sofort || typeof optionen.vorSchliessen !== 'function') { endgueltig(wert); return; }
    if (pruefend) return;
    pruefend = true;
    Promise.resolve().then(() => optionen.vorSchliessen(wert))
      .then((ok) => { pruefend = false; if (ok === true) endgueltig(wert); })
      .catch((e) => { pruefend = false; console.error(e); });
  };
  d.addEventListener('close', () => {
    if (zu) return;
    if (typeof optionen.vorSchliessen === 'function') {
      // vom Browser erzwungen (z. B. zweites Esc): wieder öffnen, dann wie jeder andere Versuch über den Haken
      try { if (!d.open && typeof d.showModal === 'function') d.showModal(); } catch { /* egal */ }
      schliessen();
      return;
    }
    endgueltig();
  });
  d.addEventListener('cancel', (ev) => { ev.preventDefault(); schliessen(); });
  // Klick auf den Hintergrund schließt
  d.addEventListener('click', (ev) => { if (ev.target === d && !optionen.festhalten) schliessen(); });
  document.body.appendChild(d);
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  const erstes = koerper.querySelector('input:not([type=hidden]), select, textarea, button, [tabindex]');
  if (erstes && typeof erstes.focus === 'function') { try { erstes.focus(); } catch { /* egal */ } }
  return { schliessen, element: d, koerper };
}
let dialogZaehler = 0;

/** Dialog mit Abbrechen/OK. Optionen: {titel, ok, abbrechen, gefahr}. Promise<boolean>. */
export function bestaetigen(text, optionen = {}) {
  return new Promise((aufloesen) => {
    let ergebnis = false;
    const d = dialog([
      el('p', { class: 'dialog-text', text: String(text) }),
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, optionen.abbrechen || t('rahmen.abbrechen')),
        el('button', { class: `knopf${optionen.gefahr ? ' knopf-gefahr' : ''}`, type: 'button', onclick: () => { ergebnis = true; d.schliessen(); } }, optionen.ok || t('rahmen.ok')),
      ]),
    ], { titel: optionen.titel || t('rahmen.bestaetigen'), beimSchliessen: () => aufloesen(ergebnis) });
    const ok = d.koerper.querySelector('.dialog-knoepfe .knopf:last-child');
    if (ok) ok.focus();
  });
}

/** Dialog mit einem Textfeld. Optionen: {titel, beschriftung, erklaerung, wert, ok, pruefen(wert)→Fehlertext|null}. Promise<string|null>. */
export function eingabe(optionen = {}) {
  return new Promise((aufloesen) => {
    let ergebnis = null;
    const feld = el('input', { class: 'eingabe', type: optionen.typ || 'text', value: optionen.wert ?? '', autocomplete: 'off', spellcheck: 'false', maxlength: optionen.maxlaenge || 255 });
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const abschicken = () => {
      const w = feld.value.trim();
      const f = optionen.pruefen ? optionen.pruefen(w) : (w ? null : t('rahmen.eingabe_leer'));
      if (f) { fehler.textContent = f; fehler.hidden = false; feld.focus(); return; }
      ergebnis = w; d.schliessen();
    };
    const form = el('form', { class: 'dialog-form', onsubmit: (ev) => { ev.preventDefault(); abschicken(); } }, [
      el('label', { class: 'feld' }, [
        el('span', { class: 'feld-beschriftung', text: optionen.beschriftung || '' }),
        feld,
        optionen.erklaerung ? el('p', { class: 'erklaerung', text: optionen.erklaerung }) : null,
        fehler,
      ]),
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
        el('button', { class: 'knopf', type: 'submit' }, optionen.ok || t('rahmen.ok')),
      ]),
    ]);
    const d = dialog(form, { titel: optionen.titel || '', beimSchliessen: () => aufloesen(ergebnis) });
    feld.focus();
    if (optionen.auswaehlen && feld.value) {
      const punkt = feld.value.lastIndexOf('.');
      try { feld.setSelectionRange(0, punkt > 0 ? punkt : feld.value.length); } catch { /* egal */ }
    }
  });
}

/** Zustandsleiste oben (z. B. Steuerdienst nicht erreichbar). */
export function zeigeZustand(text, hinweis) {
  const z = knoten.zustand || document.getElementById('zustandsleiste');
  if (!z) return;
  z.textContent = '';
  z.appendChild(symbol('warnung'));
  z.appendChild(el('div', { class: 'zustandsleiste-text' }, [el('strong', { text: text }), hinweis ? el('span', { class: 'zustandsleiste-hinweis', text: hinweis }) : null]));
  z.hidden = false;
}
export function versteckeZustand() { const z = knoten.zustand || document.getElementById('zustandsleiste'); if (z) { z.hidden = true; z.textContent = ''; } }

// ---------------------------------------------------------------------------------------------------------------------
// Aufgaben verfolgen
// ---------------------------------------------------------------------------------------------------------------------

const AUFGABE_ENDE = new Set(['fertig', 'fehler', 'abgebrochen']);

/** Verfolgt eine Aufgabe bis fertig/fehler/abgebrochen. `fn(ereignis)` je Fortschritt. Promise<ergebnis>. */
export function aufgabeVerfolgen(id, fn) {
  return new Promise((ok, nein) => {
    let beendet = false;
    let ab = () => {};
    const ende = (e) => {
      if (beendet) return; beendet = true; ab();
      if (e.status === 'fertig') ok(e.ergebnis);
      else nein(new ApiFehler(e.fehler?.code || 'E_ABGEBROCHEN', e.fehler?.meldung || t('aufgabe.abgebrochen'), e.fehler?.details));
    };
    const verarbeite = (e) => {
      if (!e || typeof e !== 'object') return;
      const aid = e.aufgabe ?? e.id;
      if (aid !== id) return;
      if (fn) { try { fn(e); } catch (fe) { console.error(fe); } }
      if (AUFGABE_ENDE.has(e.status)) ende(e);
    };
    if (zustand.sse) ab = zustand.sse.on('aufgabe', verarbeite);
    // Anfangszustand nachladen – falls das Ende schon vor der Anmeldung eintraf
    api('agent.aufgaben', {}).then((liste) => {
      const a = Array.isArray(liste) ? liste.find((x) => x.id === id) : null;
      if (a && !beendet) verarbeite({ ...a, aufgabe: a.id });
    }).catch(() => { /* egal, SSE liefert */ });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Ansichten laden und einbinden
// ---------------------------------------------------------------------------------------------------------------------

async function ladeModul(id, datei) {
  if (module.has(id)) return module.get(id);
  const url = new URL(`./ansichten/${datei || id + '.js'}`, import.meta.url).href;
  const m = await import(url);
  const ansicht = m.default || m;
  if (!ansicht || typeof ansicht.einbinden !== 'function') throw new Error(`Ansicht ${id}: einbinden() fehlt`);
  module.set(id, ansicht);
  return ansicht;
}

function ladeCss(id) {
  if (zustand.geladeneCss.has(id)) return Promise.resolve();
  zustand.geladeneCss.add(id);
  return new Promise((ok) => {
    const link = el('link', { rel: 'stylesheet', href: new URL(`./ansichten/${id}.css`, import.meta.url).href, 'data-ansicht': id });
    let fertig = false;
    const weiter = () => { if (!fertig) { fertig = true; ok(); } };
    link.addEventListener('load', weiter);
    link.addEventListener('error', () => { link.remove(); weiter(); });
    setTimeout(weiter, 1500);
    document.head.appendChild(link);
  });
}

function baueCtx(route) {
  const abmelder = [];
  const ctx = {
    api, get, post, hochladen, ladeBlob, downloadUrl, vorschauUrl,
    sse: { on: (art, fn) => { if (!zustand.sse) return () => {}; const ab = zustand.sse.on(art, fn); abmelder.push(ab); return ab; } },
    t, el, symbol, format,
    nutzer: zustand.nutzer, rolle: zustand.nutzer ? zustand.nutzer.rolle : 'gast', hostname: zustand.hostname,
    zugang: zustand.nutzer ? zustand.nutzer.zugang || null : null, // über Reverse-Proxy? Adresse des NAS (Apps öffnen)
    route, hashFuer, navigiere: (hash) => { location.hash = hash.startsWith('#') ? hash : hashFuer(hash); },
    melden, zeigeFehler, fehlerText, bestaetigen, eingabe, dialog,
    aufgabe: aufgabeVerfolgen,
    neuLaden: () => starten(),
    angemeldet: () => starten(),            // Anmeldung/Ersteinrichtung (Teil F) melden Erfolg → Rahmen startet neu
    designSetzen: (wahl) => setzeDesign(wahl), // Systemansicht (Teil F) setzt das Design
    systemSpracheGeaendert: () => { if (!ladeSprachwahl()) location.reload(); }, // ohne eigene Wahl gilt die Systemsprache sofort
    setzeTitel: (text) => setzeDokumentTitel(text),
  };
  return { ctx, abmelder };
}

function zaehlerText(n) { return n > 99 ? '99+' : String(n); }

function setzeDokumentTitel(text) {
  zustand.titelText = text;
  const teile = [text, zustand.hostname || 'FAH-NAS'].filter(Boolean);
  document.title = (zustand.titelZaehler ? `(${zaehlerText(zustand.titelZaehler)}) ` : '') + teile.join(' – ');
}

/** Zähler vorn im Tab-Titel (ungelesene Chat-Nachrichten); 0 entfernt ihn. */
export function titelZaehlerSetzen(n) {
  zustand.titelZaehler = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  setzeDokumentTitel(zustand.titelText);
}

/** Sitzung zu Ende (Abmelden, 401): Ansichten verwerfen ihren nutzerbezogenen Zustand (z. B. Uploads im Dateimanager). */
function sitzungBeendet() {
  stoppeChatRahmen();
  if (sucheModul) sucheModul.zwischenspeicherLeeren(); // ein anderer Nutzer im selben Tab sieht nichts vom Vorgänger
  for (const m of module.values()) { if (typeof m.sitzungEnde === 'function') { try { m.sitzungEnde(); } catch (e) { console.error(e); } } }
}

function verlasseAnsicht() {
  if (zustand.modul && typeof zustand.modul.verlassen === 'function') { try { zustand.modul.verlassen(); } catch (e) { console.error(e); } }
  for (const ab of zustand.abmelder) { try { ab(); } catch { /* egal */ } }
  zustand.abmelder = []; zustand.modul = null; zustand.ansicht = null;
}

function leerZustand(symbolName, titel, text) {
  return el('div', { class: 'leer' }, [symbol(symbolName, 'gross'), el('p', { class: 'leer-titel', text: titel }), text ? el('p', { class: 'leer-text', text }) : null]);
}

function sichtbareAnsichten() {
  const rolle = zustand.nutzer ? zustand.nutzer.rolle : 'gast';
  return [...ANSICHTEN].filter((a) => a.rolle !== 'admin' || rolle === 'admin').sort((a, b) => (a.reihenfolge || 0) - (b.reihenfolge || 0));
}

// Jeder Ansichtswechsel bekommt eine Nummer: laufen zwei gleichzeitig (z. B. Start + hashchange nach der Anmeldung),
// bindet nur der jüngste ein – sonst hätte der ältere schon verlassen, bevor das Modul stand, und beide bänden ein
let routenLauf = 0;

async function route() {
  if (!zustand.nutzer) return;
  const lauf = ++routenLauf;
  const r = parseRoute(location.hash);
  const sichtbar = sichtbareAnsichten();
  let eintrag = sichtbar.find((a) => a.id === r.id);
  if (!eintrag) {
    const bekannt = ANSICHTEN.find((a) => a.id === r.id);
    if (bekannt) { melden(t('fehler.E_RECHTE'), 'fehler'); }
    location.replace(hashFuer(sichtbar[0] ? sichtbar[0].id : 'dashboard'));
    return;
  }
  markiereNavigation(eintrag.id);
  const inhalt = knoten.inhalt;
  // gleiche Ansicht, anderer Pfad → navigieren() wenn vorhanden
  if (zustand.ansicht === eintrag.id && zustand.modul) {
    if (typeof zustand.modul.navigieren === 'function') {
      zustand.ctx.route = r;
      try { await zustand.modul.navigieren(r, zustand.ctx); } catch (e) { zeigeFehler(e); }
      return;
    }
  }
  verlasseAnsicht();
  zustand.ansicht = eintrag.id;
  inhalt.textContent = '';
  inhalt.appendChild(el('div', { class: 'laden', role: 'status' }, [el('span', { class: 'laden-kreis' }), t('rahmen.laden')]));
  let modul;
  try { modul = await ladeModul(eintrag.id, eintrag.datei); } catch (e) {
    console.warn(`[rahmen] Ansicht ${eintrag.id} nicht ladbar:`, e && e.message);
    if (lauf !== routenLauf || zustand.ansicht !== eintrag.id) return;
    inhalt.textContent = '';
    inhalt.appendChild(leerZustand('warnung', t('rahmen.ansicht_fehlt'), t('rahmen.ansicht_fehlt_text', { id: eintrag.id })));
    setzeDokumentTitel(navigationsText(eintrag.id));
    return;
  }
  if (lauf !== routenLauf || zustand.ansicht !== eintrag.id) return; // inzwischen weiter navigiert
  if (modul.rolle === 'admin' && zustand.nutzer.rolle !== 'admin') { inhalt.textContent = ''; inhalt.appendChild(leerZustand('warnung', t('fehler.E_RECHTE'))); return; }
  await ladeCss(eintrag.id);
  if (lauf !== routenLauf || zustand.ansicht !== eintrag.id) return;
  if (zustand.modul) verlasseAnsicht(); // sicherheitshalber: nie zwei Module gleichzeitig eingebunden
  zustand.ansicht = eintrag.id;
  const { ctx, abmelder } = baueCtx(r);
  zustand.ctx = ctx; zustand.abmelder = abmelder; zustand.modul = modul;
  const wurzel = el('section', { class: `ansicht ansicht-${eintrag.id}`, 'data-ansicht': eintrag.id });
  inhalt.textContent = '';
  inhalt.appendChild(wurzel);
  setzeDokumentTitel(typeof modul.titel === 'function' ? modul.titel(t) : navigationsText(eintrag.id));
  try { await modul.einbinden(wurzel, ctx); } catch (e) { zeigeFehler(e); }
  if (knoten.inhalt && typeof knoten.inhalt.focus === 'function' && !document.activeElement?.closest?.('.ansicht')) { try { knoten.inhalt.focus({ preventScroll: true }); } catch { /* egal */ } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Kopfzeile, Navigation
// ---------------------------------------------------------------------------------------------------------------------

function baueKopfzeile() {
  const k = knoten.kopf;
  k.textContent = '';
  const darstellungKnopf = el('button', { class: 'knopf-symbol kopf-darstellung', type: 'button', title: t('kopf.darstellung'), 'aria-label': t('kopf.darstellung'), onclick: async () => {
    try { const m = await import('./darstellung-fenster.js'); m.oeffnen(zustand.nutzer.name); } catch (e) { zeigeFehler(e); }
  } }, [symbol('darstellung')]);
  k.appendChild(el('a', { class: 'kopf-marke', href: hashFuer('dashboard'), 'aria-label': t('kopf.startseite') }, [
    el('img', { class: 'kopf-logo', src: SYMBOLE_URL, alt: '', width: '28', height: '28' }),
    el('span', { class: 'kopf-hostname', text: zustand.hostname || 'FAH-NAS' }),
  ]));
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  k.appendChild(el('button', { class: 'kopf-suche', type: 'button', title: t('suche.titel'), 'aria-label': t('suche.titel'), 'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K', onclick: () => sucheOeffnen() }, [
    symbol('suchen'), el('span', { class: 'kopf-suche-text', text: t('suche.knopf') }), el('kbd', { class: 'kopf-suche-taste', text: mac ? '⌘K' : 'Strg K' }),
  ]));
  k.appendChild(el('div', { class: 'kopf-rechts' }, [
    el('span', { class: 'kopf-nutzer', title: zustand.nutzer.name }, [
      avatarKnoten({ name: zustand.nutzer.name, anzeige: zustand.nutzer.anzeigename || zustand.nutzer.name, groesse: 26, klasse: 'kopf-avatar' }),
      el('span', { class: 'kopf-nutzer-name', text: zustand.nutzer.anzeigename || zustand.nutzer.name }),
      zustand.nutzer.rolle === 'admin' ? el('span', { class: 'kopf-rolle', text: t('kopf.rolle_admin') }) : null,
    ]),
    darstellungKnopf,
    el('button', { class: 'knopf-symbol kopf-abmelden', type: 'button', title: t('kopf.abmelden'), 'aria-label': t('kopf.abmelden'), onclick: abmelden }, [symbol('abmelden')]),
  ]));
}

/** Suchfenster (Strg+K / ⌘K) – Modul erst beim ersten Öffnen laden. */
let sucheOffen = null;
let sucheModul = null;
async function sucheOeffnen() {
  if (!zustand.nutzer || sucheOffen) return;
  try {
    const m = await import('./suche.js');
    sucheModul = m;
    sucheOffen = m.oeffnen({
      ansichten: sichtbareAnsichten(), admin: zustand.nutzer.rolle === 'admin', nutzer: zustand.nutzer.name, seitenText: navigationsText,
      darstellungOeffnen: async () => { const d = await import('./darstellung-fenster.js'); d.oeffnen(zustand.nutzer.name); },
    });
    sucheOffen.element.addEventListener('close', () => { sucheOffen = null; });
    const zu = sucheOffen.schliessen; sucheOffen.schliessen = (w) => { sucheOffen = null; zu(w); };
  } catch (e) { sucheOffen = null; zeigeFehler(e); }
}

async function abmelden() {
  try { await post('/api/abmelden', {}); } catch (e) { if (!(e && e.status === 401)) { zeigeFehler(e); return; } }
  zustand.nutzer = null;
  sitzungBeendet();
  favoriten.zuruecksetzen();
  if (zustand.sse) { zustand.sse.schliessen(); zustand.sse = null; zustand.sseGestartet = false; }
  melden(t('kopf.abgemeldet'), 'info');
  location.hash = '';
  zeigeSolo('anmeldung');
}

/** Symbol einer Navigationsgruppe (Handy-Leiste): das der wichtigsten Ansicht darin. */
const GRUPPEN_SYMBOL = Object.freeze({ zusammenarbeit: 'chat', speicher: 'laufwerke', daten: 'dateien', dienste: 'apps', verwaltung: 'system' });

/**
 * Navigation in Gruppen (Speicher, Daten, Dienste, Verwaltung): am Rechner Überschriften in der Seitenleiste, am Handy
 * eine Leiste mit Übersicht + Gruppen; eine Gruppe mit mehreren Punkten klappt nach oben auf.
 */
function baueNavigation() {
  const n = knoten.nav;
  n.textContent = '';
  const eintrag = (a) => el('a', { class: 'navigation-eintrag', href: hashFuer(a.id), 'data-id': a.id }, [symbol(a.id), el('span', { class: 'navigation-text', text: navigationsText(a.id) })]);
  const sichtbar = sichtbareAnsichten();
  const liste = el('ul', { class: 'navigation-liste', role: 'list' });
  for (const a of sichtbar.filter((x) => !x.gruppe)) liste.appendChild(el('li', { class: 'navigation-punkt' }, [eintrag(a)]));
  for (const g of GRUPPEN) {
    const punkte = sichtbar.filter((x) => x.gruppe === g);
    if (!punkte.length) continue;
    const titel = t(`navigation.gruppe_${g}`);
    if (punkte.length === 1) {
      // nur ein Punkt (z. B. „Mein Konto“ für Nutzer): Überschrift am Rechner, am Handy direkt der Punkt
      liste.appendChild(el('li', { class: 'navigation-gruppe navigation-gruppe-einzeln', 'data-gruppe': g }, [
        el('span', { class: 'navigation-gruppe-titel', text: titel }), eintrag(punkte[0]),
      ]));
      continue;
    }
    const unter = el('ul', { class: 'navigation-unterliste', role: 'list', id: `navigation-gruppe-${g}` }, punkte.map((a) => el('li', { class: 'navigation-punkt' }, [eintrag(a)])));
    const knopf = el('button', { type: 'button', class: 'navigation-eintrag navigation-gruppe-knopf', 'aria-expanded': 'false', 'aria-controls': `navigation-gruppe-${g}`,
      onclick: (ev) => { ev.stopPropagation(); const offen = li.classList.toggle('offen'); knopf.setAttribute('aria-expanded', offen ? 'true' : 'false'); gruppenSchliessen(li); } },
    [symbol(g === 'verwaltung' && !punkte.some((a) => a.id === 'system') ? 'nutzer' : GRUPPEN_SYMBOL[g]), el('span', { class: 'navigation-text', text: titel })]);
    const li = el('li', { class: 'navigation-gruppe', 'data-gruppe': g }, [el('span', { class: 'navigation-gruppe-titel', text: titel }), knopf, unter]);
    liste.appendChild(li);
  }
  // Favoriten direkt unter „Dateien“ (Rechner: Teil des Menübaums; Handy: im aufgeklappten Daten-Menü)
  const dateienPunkt = liste.querySelector('.navigation-eintrag[data-id="dateien"]');
  if (dateienPunkt) dateienPunkt.parentElement.after(el('li', { class: 'navigation-punkt navigation-favoriten-punkt' }, [favoritenKnoten()]));
  n.appendChild(liste);
  if (!n.dataset.favoritenGesetzt) {
    n.dataset.favoritenGesetzt = '1';
    favoriten.beiAenderung(() => favoritenAktualisieren());
  }
  if (!n.dataset.klappeGesetzt) {
    n.dataset.klappeGesetzt = '1';
    document.addEventListener('click', () => gruppenSchliessen(null));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') gruppenSchliessen(null); });
  }
  n.appendChild(el('div', { class: 'navigation-fuss' }, [el('span', { class: 'navigation-version', text: zustand.version ? t('rahmen.version', { version: zustand.version }) : '' })]));
  for (const id of abzeichen.keys()) abzeichenAnwenden(id);
}

// Favoriten-Eintrag im Menübaum: aufklappbar, beim Laden der Seite immer eingeklappt (Betreiber: „standard eingeklappt“);
// der Zustand hält nur, solange die Seite offen ist.
let favoritenOffen = false;

function favoritenKnoten() {
  const f = favoriten.alle();
  const unter = el('ul', { class: 'navigation-favoriten-liste', role: 'list', id: 'navigation-favoriten-liste', hidden: !favoritenOffen },
    f.length ? f.map((x) => el('li', {}, [el('a', { class: 'navigation-eintrag navigation-favorit', href: hashFuer('dateien', x.freigabe, x.pfad), title: favoriten.ort(x) }, [
      symbol('ordner'), el('span', { class: 'navigation-text', text: favoriten.anzeigeName(x) }),
    ])]))
      : [el('li', { class: 'navigation-favoriten-leer', text: t('navigation.favoriten_leer') })]);
  const knopf = el('button', { type: 'button', class: 'navigation-eintrag navigation-favoriten-knopf', 'aria-expanded': favoritenOffen ? 'true' : 'false', 'aria-controls': 'navigation-favoriten-liste',
    title: t(favoritenOffen ? 'navigation.favoriten_zuklappen' : 'navigation.favoriten_aufklappen'),
    onclick: (ev) => {
      ev.stopPropagation(); // Handy: das Daten-Menü bleibt offen
      favoritenOffen = !favoritenOffen;
      unter.hidden = !favoritenOffen;
      knopf.setAttribute('aria-expanded', favoritenOffen ? 'true' : 'false');
      knopf.title = t(favoritenOffen ? 'navigation.favoriten_zuklappen' : 'navigation.favoriten_aufklappen');
    } }, [
    symbol('stern'), el('span', { class: 'navigation-text', text: t('navigation.favoriten') }),
    f.length ? el('span', { class: 'navigation-favoriten-zahl', text: String(f.length) }) : null,
    symbol('weiter', 'navigation-favoriten-pfeil'),
  ]);
  return el('div', { class: 'navigation-favoriten' }, [knopf, unter]);
}

/** Nach dem Markieren/Entfernen eines Favoriten nur diesen Teil der Navigation neu bauen. */
function favoritenAktualisieren() {
  const alt = knoten.nav && knoten.nav.querySelector('.navigation-favoriten');
  if (alt) alt.replaceWith(favoritenKnoten());
}

// Ungelesen-Zahlen je Navigationspunkt (Chat); bleiben über einen Neubau der Navigation hinweg erhalten
const abzeichen = new Map();

/** Ungelesen-Abzeichen an einem Navigationspunkt; 0 entfernt es, ab 100 steht „99+“. */
export function navigationAbzeichen(id, anzahl) {
  const n = Number.isFinite(anzahl) && anzahl > 0 ? Math.floor(anzahl) : 0;
  if (n) abzeichen.set(id, n); else abzeichen.delete(id);
  abzeichenAnwenden(id);
}

function abzeichenSetzen(ziel, n) {
  let span = ziel.querySelector('.navigation-abzeichen');
  if (!n) { if (span) span.remove(); return; }
  if (!span) { span = el('span', { class: 'navigation-abzeichen' }); ziel.appendChild(span); }
  span.textContent = zaehlerText(n);
  span.setAttribute('aria-label', t('navigation.abzeichen', { n }));
}

function abzeichenAnwenden(id) {
  if (!knoten.nav) return;
  const n = abzeichen.get(id) || 0;
  for (const a of knoten.nav.querySelectorAll('.navigation-eintrag[data-id]')) {
    if (a.getAttribute('data-id') === id) abzeichenSetzen(a, n);
  }
  // Handy-Leiste: der Gruppenknopf zeigt die Summe seiner Einträge
  for (const g of knoten.nav.querySelectorAll('.navigation-gruppe')) {
    const knopf = g.querySelector('.navigation-gruppe-knopf');
    if (!knopf) continue;
    const summe = [...g.querySelectorAll('.navigation-eintrag[data-id]')].reduce((s, e) => s + (abzeichen.get(e.getAttribute('data-id')) || 0), 0);
    abzeichenSetzen(knopf, summe);
  }
}

/** Beschriftung eines Navigationspunkts; „Nutzer“ heißt für Nicht-Admins „Mein Konto“ (Ansicht von F zeigt dann nur das eigene Konto). */
function navigationsText(id) {
  if (id === 'nutzer' && zustand.nutzer && zustand.nutzer.rolle !== 'admin' && t.hat('navigation.nutzer_konto')) return t('navigation.nutzer_konto');
  return t(`navigation.${id}`);
}

function markiereNavigation(id) {
  for (const a of knoten.nav.querySelectorAll('.navigation-eintrag[data-id]')) {
    if (a.dataset.id === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  // Gruppe der aktuellen Ansicht hervorheben (Handy-Leiste), aufgeklappte Gruppen schließen
  for (const g of knoten.nav.querySelectorAll('.navigation-gruppe')) g.classList.toggle('aktiv', !!g.querySelector(`.navigation-eintrag[data-id="${id}"]`));
  gruppenSchliessen(null);
}

/** Aufgeklappte Navigationsgruppen schließen (außer `ausser`). */
function gruppenSchliessen(ausser) {
  if (!knoten.nav) return;
  for (const g of knoten.nav.querySelectorAll('.navigation-gruppe.offen')) {
    if (g === ausser) continue;
    g.classList.remove('offen');
    const k = g.querySelector('.navigation-gruppe-knopf'); if (k) k.setAttribute('aria-expanded', 'false');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Solo-Ansichten (Anmeldung, Ersteinrichtung) – ohne Navigation
// ---------------------------------------------------------------------------------------------------------------------

async function zeigeSolo(id) {
  const lauf = ++routenLauf;
  verlasseAnsicht();
  document.body.classList.add('solo');
  knoten.kopf.textContent = ''; knoten.nav.textContent = '';
  const inhalt = knoten.inhalt;
  inhalt.textContent = '';
  setzeDokumentTitel(t(`navigation.${id}`));
  let modul;
  try { modul = await ladeModul(id, `${id}.js`); } catch (e) {
    console.warn(`[rahmen] Ansicht ${id} fehlt:`, e && e.message);
    inhalt.appendChild(el('div', { class: 'solo-notfall karte' }, [
      symbol('warnung', 'gross'),
      el('h1', { text: t(`navigation.${id}`) }),
      el('p', { text: t('rahmen.ansicht_fehlt_text', { id }) }),
      el('p', { class: 'erklaerung', text: t('rahmen.notfall_hinweis') }),
      el('button', { class: 'knopf', type: 'button', onclick: () => starten() }, t('rahmen.erneut')),
    ]));
    return;
  }
  await ladeCss(id);
  if (lauf !== routenLauf) return; // inzwischen anderswohin gewechselt
  const { ctx, abmelder } = baueCtx(parseRoute(location.hash));
  zustand.ctx = ctx; zustand.abmelder = abmelder; zustand.modul = modul; zustand.ansicht = id;
  const wurzel = el('section', { class: `ansicht ansicht-${id} solo-ansicht`, 'data-ansicht': id });
  inhalt.appendChild(wurzel);
  try { await modul.einbinden(wurzel, ctx); } catch (e) { zeigeFehler(e); }
}

// ---------------------------------------------------------------------------------------------------------------------
// SSE des Rahmens
// ---------------------------------------------------------------------------------------------------------------------

/** Versionen aller Avatare (nutzer.avatare) – nicht fatal: ohne sie zeigt jede Oberfläche Anfangsbuchstaben. */
async function avatareLaden() {
  try { avatareSetzen(await api('nutzer.avatare', {})); } catch { /* ältere Agenten oder Agent weg */ }
}

function starteSse() {
  if (zustand.sseGestartet) return;
  zustand.sse = sseVerbinden('/api/ereignisse');
  zustand.sseGestartet = true;
  zustand.sse.on('agent', (d) => {
    const z = typeof d === 'string' ? d : (d && (d.zustand || d.status || d.daten?.zustand));
    if (z === 'getrennt') { zustand.agentGetrennt = true; zeigeZustand(t('rahmen.agent_getrennt'), t('rahmen.agent_hinweis')); }
    else if (z === 'verbunden') { if (zustand.agentGetrennt) melden(t('rahmen.agent_wieder'), 'erfolg'); zustand.agentGetrennt = false; versteckeZustand(); }
  });
  zustand.sse.on('verbindung', (d) => {
    if (d.zustand === 'getrennt') { zeigeZustand(t('rahmen.verbindung_getrennt'), t('rahmen.verbindung_hinweis')); }
    else if (!zustand.agentGetrennt) versteckeZustand();
  });
  // Avatare (0.22.0): ändert jemand sein Bild, tauschen alle sichtbaren Avatare
  zustand.sse.on('konfig', (e) => { const d = e && e.daten ? e.daten : e; if (!d || !d.bereich || d.bereich === 'nutzer') avatareLaden(); });
  zustand.sse.on('system', (d) => {
    if (d && d.art === 'platte_voll') melden(t('rahmen.platte_voll', { prozent: d.daten && d.daten.prozent != null ? format.prozent(d.daten.prozent) : '' }), 'warnung', 10000);
  });
  zustand.sse.starten();
}

// ---------------------------------------------------------------------------------------------------------------------
// Chat im Rahmen (Ungelesen in Navigation und Tab-Titel)
// ---------------------------------------------------------------------------------------------------------------------

let chatLauf = 0;

/** Lädt den Chat-Rahmen nach; fehlt er oder scheitert er, bleibt das still (die übrige Oberfläche läuft weiter). */
async function starteChatRahmen() {
  if (zustand.chatRahmen || zustand.chatStartet || !zustand.nutzer) return;
  zustand.chatStartet = true;
  const lauf = ++chatLauf;
  try {
    const [{ chatRahmenStarten, chatStand }, { chatVerbindung }, hinweise] = await Promise.all([import('./chat/rahmen.js'), import('./chat/verbindung.js'), import('./chat/hinweise.js')]);
    if (lauf !== chatLauf) return;
    const ich = zustand.nutzer.name;
    // Ton/Browser-Meldung: Einstellungen aus users.json (die Chat-Ansicht hält sie danach aktuell)
    api('nutzer.einstellungen.lesen', { name: ich, bereich: 'chat' }).then((e) => { if (!chatStand.einstellungen) chatStand.einstellungen = (e && e.wert) || {}; }).catch(() => {});
    const r = await chatRahmenStarten({
      verbindung: chatVerbindung(), t, nutzer: zustand.nutzer, navigationAbzeichen, titelZaehlerSetzen,
      hinweise: {
        melden: (n, raum) => hinweise.melden(n, raum, chatStand.einstellungen || {}, {
          ich, offenerRaum: zustand.ansicht === 'chat' ? chatStand.offenerRaum : null,
          text: (x) => t('chat.meldung_text', { name: x.von_name || '' }), beiKlick: (rm) => { location.hash = hashFuer('chat', rm.id); },
        }),
      },
    });
    if (lauf !== chatLauf) { r.stoppen(); return; }
    zustand.chatRahmen = r;
    // Anrufe (Plan 03): Steuerung und Klingeln für den ganzen Tab
    import('./chat/anruf-erweiterungen.js').then((m) => {
      if (lauf !== chatLauf) return;
      zustand.anrufe = m;
      m.anrufeAppStarten();
    }).catch((e) => console.warn('[rahmen] Anrufe nicht verfügbar:', e && e.message));
  } catch (e) {
    console.warn('[rahmen] Chat nicht verfügbar:', e && e.message);
  } finally {
    if (lauf === chatLauf) zustand.chatStartet = false;
  }
}

function stoppeChatRahmen() {
  chatLauf += 1;
  zustand.chatStartet = false;
  const r = zustand.chatRahmen; zustand.chatRahmen = null;
  if (r) { try { r.stoppen(); } catch (e) { console.error(e); } }
  const anrufe = zustand.anrufe; zustand.anrufe = null;
  if (anrufe) { try { anrufe.anrufeAppStoppen(); } catch (e) { console.error(e); } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------------------

let hashHoererGesetzt = false;

/** Startet (oder startet neu) die Oberfläche: Sprache → Ersteinrichtung? → Anmeldung? → Navigation + Ansicht. */
export async function starten() {
  if (zustand.startetGerade) return;
  zustand.startetGerade = true;
  try {
    knoten.app = document.getElementById('app');
    knoten.kopf = document.getElementById('kopfzeile');
    knoten.nav = document.getElementById('navigation');
    knoten.inhalt = document.getElementById('inhalt');
    knoten.toasts = document.getElementById('toasts');
    knoten.zustand = document.getElementById('zustandsleiste');
    if (!knoten.inhalt) return;
    const gemerkt = ladeDesign();
    setzeDesign(gemerkt || 'auto', false);
    // Darstellung des zuletzt hier angemeldeten Kontos sofort (vor der Anmeldung), danach die echte aus dem Konto
    const cache = darstellungCache();
    if (cache) darstellungAnwenden(cache, { setzeDesign });
    if (!Object.keys(zustand.texte).length) await spracheLaden(startSprache());
    if (!hashHoererGesetzt) {
      hashHoererGesetzt = true;
      window.addEventListener('hashchange', () => { route().catch(zeigeFehler); });
      // Suche: Strg+K (⌘K am Mac) – auch aus Eingabefeldern heraus
      document.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && String(ev.key).toLowerCase() === 'k' && zustand.nutzer && !document.body.classList.contains('solo')) { ev.preventDefault(); sucheOeffnen(); } });
      if (typeof matchMedia === 'function') { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setzeDesign(aktuellesDesign(), false)); } catch { /* alt */ } }
    }
    // 1. Ersteinrichtung nötig?
    let ers;
    try { ers = await get('/api/ersteinrichtung'); } catch (e) {
      knoten.inhalt.textContent = '';
      document.body.classList.add('solo');
      knoten.inhalt.appendChild(el('div', { class: 'solo-notfall karte' }, [
        symbol('warnung', 'gross'), el('h1', { text: t('rahmen.keine_verbindung') }), el('p', { text: fehlerText(e) }),
        el('p', { class: 'erklaerung', text: t('rahmen.keine_verbindung_hinweis') }),
        el('button', { class: 'knopf', type: 'button', onclick: () => starten() }, t('rahmen.erneut')),
      ]));
      return;
    }
    if (ers && ers.noetig) { await zeigeSolo('ersteinrichtung'); return; }
    // 2. Angemeldet?
    let ich;
    try { ich = await get('/api/ich'); } catch (e) {
      if (e && (e.status === 401 || e.code === 'E_ANMELDUNG')) { zustand.nutzer = null; sitzungBeendet(); await zeigeSolo('anmeldung'); return; }
      throw e;
    }
    zustand.nutzer = ich;
    if (!gemerkt && ich && ich.design && DESIGNS.includes(ich.design)) setzeDesign(ich.design, false);
    // persönliche Darstellung (Theme, Akzent, Hintergrund) aus dem Konto – ohne eigene Wahl: Design wie bisher
    try {
      const r = await api('nutzer.einstellungen.lesen', { name: ich.name, bereich: 'darstellung' });
      darstellungAnwenden(r && r.wert ? r.wert : { ...DARSTELLUNG_STANDARD, theme: gemerkt || (ich && ich.design) || 'auto' }, { setzeDesign });
    } catch { /* ältere Agenten ohne Bereich – Design bleibt */ }
    // ohne eigene Wahl im Browser gilt die Sprache aus System → Allgemein
    if (!ladeSprachwahl() && ich && SPRACHEN.includes(ich.sprache) && ich.sprache !== zustand.sprache) await spracheLaden(ich.sprache);
    document.body.classList.remove('solo');
    verlasseAnsicht();
    // Hostname/Version für Kopfzeile (nicht fatal)
    try { const s = await api('system.status', {}); zustand.hostname = s && s.hostname ? s.hostname : ''; zustand.version = s && s.version ? s.version : ''; } catch { /* Kopf zeigt FAH-NAS */ }
    await avatareLaden();
    await favoriten.laden(ich.name);   // Ordner-Favoriten für die Navigation (Fehler → leer)
    baueKopfzeile();
    baueNavigation();
    starteSse();
    starteChatRahmen();
    if (!location.hash || !parseRoute(location.hash).id) location.replace(hashFuer('dashboard'));
    await route();
  } catch (e) {
    zeigeFehler(e);
  } finally {
    zustand.startetGerade = false;
  }
}

/** Nur für Tests: Zugriff auf den inneren Zustand. */
export const _test = { zustand, knoten, module, sichtbareAnsichten, setzeT(fn) { t = fn; } };

// Automatischer Start im Browser (im Test gibt es kein #app)
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('app')) {
  starten();
}
