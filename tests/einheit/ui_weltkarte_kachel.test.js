// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kachel „Weltkarte“ der Übersicht (nur Admins) und Einstellungskarte „Standort und Verbindungen“ (System) ohne
// Browser: echte Ansichten gegen eine DOM-Attrappe, das Karten-Modul (weltkarte.js) wird über den Test-Haken der
// Übersicht durch eine Attrappe ersetzt, die jeden Aufruf mitschreibt. Geprüft: Umschalter und gespeicherte Richtung,
// Wettlauf beim schnellen Umschalten, Listen (10 + „alle zeigen“), Klick-Filter, Abfrage nur bei sichtbarem Tab und
// sichtbarer Kachel, Aufräumen in verlassen, Hinweise ohne Ausnahme, Standardgröße (4 Spalten, doppelt hoch),
// Einstellungsfelder mit Erklärtext und Feldprüfung. Ergebnisform von netz.verbindungen: Spec §4.6.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HIER, '..', '..', 'public');
const SPRACHE = path.join(PUBLIC, 'sprache', 'de');

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe (data-*-Attribute spiegeln sich wie im Browser in dataset)
// ---------------------------------------------------------------------------------------------------------------------

let dokument = null;
class Knoten {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get isConnected() { let k = this; while (k) { if (k === dokument.body) return true; k = k.parentNode; } return false; }
}
class TextKnoten extends Knoten { constructor(t) { super(); this.nodeType = 3; this.textContent = String(t); } }
const datenName = (a) => a.slice(5).replace(/-([a-z])/g, (_, b) => b.toUpperCase());
/** Wie im Browser: Wird der fokussierte Knoten (oder ein Vorfahr) aus dem Baum genommen – auch beim Verschieben per
 * insertBefore/appendChild –, fällt der Fokus auf body zurück. */
function fokusVerlieren(k) {
  const aktiv = dokument && dokument.activeElement;
  if (aktiv && typeof k.contains === 'function' && k.contains(aktiv)) dokument.activeElement = dokument.body;
}
class Element extends Knoten {
  constructor(tag, ns) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.namespaceURI = ns || null; this.attribute = new Map(); this.dataset = {}; this.hoerer = {};
    this.style = { werte: {}, setProperty(k, v) { this.werte[k] = v; } };
    this.classList = {
      add: (...k) => this.setAttribute('class', [...new Set([...this.klassen(), ...k])].join(' ')),
      remove: (...k) => this.setAttribute('class', this.klassen().filter((x) => !k.includes(x)).join(' ')),
      toggle: (k, an) => { const hat = this.klassen().includes(k); const soll = an === undefined ? !hat : !!an; if (soll && !hat) this.classList.add(k); if (!soll && hat) this.classList.remove(k); return soll; },
      contains: (k) => this.klassen().includes(k),
    };
  }
  klassen() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { for (const k of this.childNodes) { fokusVerlieren(k); k.parentNode = null; } this.childNodes = v === '' ? [] : [new TextKnoten(v)]; }
  contains(k) { for (let x = k; x; x = x.parentNode) if (x === this) return true; return false; }
  appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; this.childNodes.push(k); return k; }
  append(...kinder) { for (const k of kinder) this.appendChild(typeof k === 'string' ? new TextKnoten(k) : k); }
  insertBefore(neu, ref) {
    if (neu.parentNode) neu.parentNode.removeChild(neu);
    neu.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(neu); else this.childNodes.splice(i, 0, neu);
    return neu;
  }
  removeChild(k) { fokusVerlieren(k); this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); p.removeChild(this); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); if (k.startsWith('data-')) this.dataset[datenName(k)] = String(v); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  hasAttribute(k) { return this.attribute.has(k); }
  removeAttribute(k) { this.attribute.delete(k); if (k.startsWith('data-')) delete this.dataset[datenName(k)]; }
  addEventListener(art, fn) { (this.hoerer[art] ||= []).push(fn); }
  removeEventListener(art, fn) { this.hoerer[art] = (this.hoerer[art] || []).filter((x) => x !== fn); }
  ausloesen(art, ev = {}) { for (const fn of this.hoerer[art] || []) fn({ type: art, target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  click() { this.ausloesen('click'); }
  alle() { const aus = []; for (const k of this.children) aus.push(k, ...k.alle()); return aus; }
  /** Nur einfache Klassen-Selektoren (.a oder .a.b) – mehr brauchen die Ansichten hier nicht. */
  querySelectorAll(s) { const kl = /^(\.[a-zA-Z0-9_-]+)+$/.test(s) ? s.slice(1).split('.') : null; return kl ? this.alle().filter((k) => kl.every((c) => k.classList.contains(c))) : []; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  closest() { return null; }
  focus() { this.fokussiert = true; if (this.isConnected) dokument.activeElement = this; }
}

function dom() {
  const hoerer = {};
  dokument = {
    documentElement: new Element('html'), body: new Element('body'), head: new Element('head'), cookie: '', title: '', hidden: false,
    createElement: (t) => new Element(t), createElementNS: (ns, t) => new Element(t, ns), createTextNode: (t) => new TextKnoten(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(art, fn) { (hoerer[art] ||= []).push(fn); },
    removeEventListener(art, fn) { hoerer[art] = (hoerer[art] || []).filter((x) => x !== fn); },
    ausloesen(art) { for (const fn of hoerer[art] || []) fn({ type: art }); },
    hoererAnzahl(art) { return (hoerer[art] || []).length; },
  };
  dokument.documentElement.appendChild(dokument.body);
  dokument.activeElement = dokument.body;
  globalThis.Node = Knoten;
  globalThis.HTMLFormElement = class {};
  globalThis.document = dokument;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', href: 'http://nas.local/', origin: 'http://nas.local', replace() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  return dokument;
}

/** IntersectionObserver-Attrappe: der Test meldet „Kachel im Bild / nicht im Bild“ selbst. */
const beobachter = [];
globalThis.IntersectionObserver = class {
  constructor(fn) { this.fn = fn; this.ziele = []; this.getrennt = false; beobachter.push(this); }
  observe(z) { this.ziele.push(z); }
  unobserve() {}
  disconnect() { this.getrennt = true; }
  melden(imBild) { this.fn(this.ziele.map((target) => ({ target, isIntersecting: imBild }))); }
};

// ---------------------------------------------------------------------------------------------------------------------
// Hilfen: Ergebnisse im Format von netz.verbindungen (Spec §4.6), API- und Karten-Attrappe
// ---------------------------------------------------------------------------------------------------------------------

const abarbeiten = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const ort = (land, land_name, stadt, lat, lon) => ({ land, land_name, stadt, lat, lon, genau: stadt ? 'stadt' : 'land' });
const gegenstelle = (ip, lokal, weiteres = {}) => ({
  ip, privat: false, anycast: false, ort: null, anzahl: 1, bytes: 1000, erst: '2026-09-26T09:30:00.000Z', zuletzt: '2026-09-26T09:59:00.000Z',
  lokal: lokal.map((name) => ({ name, art: name === 'FAH-NAS' ? 'host' : name === 'SMB' ? 'dienst' : 'app', anzahl: 1 })), ...weiteres,
});

function ergebnis(richtung, teile = {}) {
  const aus = [
    gegenstelle('140.82.121.4', ['FAH-NAS', 'it-tools'], { ort: ort('US', 'USA', 'San Francisco', 37.7, -122.4), anzahl: 3, bytes: 49134 }),
    gegenstelle('151.101.1.69', ['it-tools'], { ort: ort('DE', 'Deutschland', 'Frankfurt am Main', 50.1, 8.7), anzahl: 1, bytes: 1200 }),
    gegenstelle('192.168.1.1', ['FAH-NAS'], { privat: true, anzahl: 2, bytes: 440 }),
    gegenstelle('9.9.9.9', ['FAH-NAS'], { anycast: true, anzahl: 1, bytes: 300 }),
  ];
  const ein = [gegenstelle('192.168.1.79', ['SMB'], { privat: true, anzahl: 4, bytes: 129000 })];
  const gegen = teile.gegenstellen || (richtung === 'aus' ? aus : ein);
  return {
    richtung, zeit: '2026-09-26T10:00:00.000Z', fenster_s: 3600, aufzeichnung: true,
    werkzeug: { ok: true, hinweis: null }, geo: { quelle: 'stadt', stand: '2026-09', hinweis: null },
    heimat: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' },
    summe: { anzahl: gegen.reduce((s, g) => s + g.anzahl, 0), bytes: gegen.reduce((s, g) => s + g.bytes, 0), gegenstellen: gegen.length },
    gegenstellen: gegen,
    lokal: teile.lokal || (richtung === 'aus'
      ? [{ name: 'FAH-NAS', art: 'host', anzahl: 4, bytes: 5000 }, { name: 'it-tools', art: 'app', anzahl: 2, bytes: 2400 }]
      : [{ name: 'SMB', art: 'dienst', anzahl: 4, bytes: 129000 }]),
    ...Object.fromEntries(Object.entries(teile).filter(([k]) => !['gegenstellen', 'lokal'].includes(k))),
  };
}

/** Karten-Attrappe mit der Schnittstelle aus Spec §4.8; jede erzeugte Karte landet in `karten`. */
const karten = [];
let kartenLaderAufrufe = 0;
let kartenLaderFehler = null;
async function kartenLader() {
  kartenLaderAufrufe++;
  if (kartenLaderFehler) throw kartenLaderFehler;
  return {
    erzeugeWeltkarte(behaelter, optionen) {
      const k = {
        behaelter, optionen, daten: [], filter: [], pausen: [], groessen: 0, zerstoert: false,
        setzeDaten(e, o) { this.daten.push({ e, o }); }, setzeFilter(n) { this.filter.push(n); }, groesse() { this.groessen++; },
        pausieren(b) { this.pausen.push(b); }, zerstoeren() { this.zerstoert = true; },
      };
      karten.push(k);
      return k;
    },
  };
}

const meldungen = [];
function apiAttrappe({ gespeichert = null, antworten = null, uebersicht = null, laufwerke = null, status = null } = {}) {
  const aufrufe = [];
  const api = async (aktion, params = {}) => {
    aufrufe.push({ aktion, params: structuredClone(params) });
    switch (aktion) {
      case 'nutzer.einstellungen.lesen': return { bereich: params.bereich, wert: params.bereich === 'weltkarte' && gespeichert ? { richtung: gespeichert } : params.bereich === 'uebersicht' ? uebersicht : null };
      case 'nutzer.einstellungen.setzen': return { bereich: params.bereich, wert: params.wert ?? null };
      case 'netz.verbindungen': return antworten ? antworten(params) : ergebnis(params.richtung);
      case 'system.protokoll': return { eintraege: [], gesamt: 0 };
      case 'laufwerke.liste': return typeof laufwerke === 'function' ? laufwerke() : (laufwerke ?? []);
      case 'system.status': return status ?? {};
      case 'apps.liste': case 'agent.aufgaben': return [];
      default: return {};
    }
  };
  return { api, aufrufe };
}

dom();
mock.timers.enable({ apis: ['setInterval'] });
const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
app._test.setzeT(Object.assign((k, p) => (p ? `${k}${JSON.stringify(p)}` : k), { hat: () => false }));
const dashModul = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
const dash = dashModul.default;
dashModul._test.setzeKartenLader(kartenLader);

async function einbinden({ rolle = 'admin', gespeichert = null, antworten = null, uebersicht = null, laufwerke = null, status = null } = {}) {
  const wurzel = dokument.createElement('main');
  dokument.body.appendChild(wurzel);
  const a = apiAttrappe({ gespeichert, antworten, uebersicht, laufwerke, status });
  const ctx = {
    rolle, nutzer: { name: 'chef', rolle }, api: a.api, get: async () => [], sse: { on() { return () => {}; } },
    hashFuer: (...x) => `#/${x.join('/')}`, melden: (text, art) => meldungen.push({ text, art }), fehlerText: (e) => (e && e.message) || 'Fehler',
    bestaetigen: async () => true, dialog: () => ({ schliessen() {} }),
  };
  await dash.einbinden(wurzel, ctx);
  await abarbeiten();
  return { wurzel, ctx, aufrufe: a.aufrufe };
}
function verlassen(wurzel) { dash.verlassen(); wurzel.remove(); }

const kachelVon = (wurzel) => wurzel.alle().find((k) => k.dataset.kachel === 'weltkarte') || null;
const richtungsKnopf = (k, r) => k.alle().find((x) => x.tagName === 'BUTTON' && x.dataset.richtung === r);
const verbindungsAufrufe = (aufrufe) => aufrufe.filter((x) => x.aktion === 'netz.verbindungen');
const liste = (k, art) => k.querySelector(`.dashboard-wk-liste-${art}`);
const ipsIn = (k) => liste(k, 'fern').alle().filter((x) => x.classList.contains('dashboard-wk-ip')).map((x) => x.textContent);
const lokalKnopf = (k, name) => liste(k, 'lokal').alle().find((x) => x.tagName === 'BUTTON' && x.dataset.name === name);
const mehrKnopf = (k, art) => k.alle().find((x) => x.tagName === 'BUTTON' && x.classList.contains('dashboard-wk-mehr') && x.dataset.liste === art);
const letzteKarte = () => karten[karten.length - 1];

// ---------------------------------------------------------------------------------------------------------------------
// Übersicht: Kachel
// ---------------------------------------------------------------------------------------------------------------------

test('Weltkarte: Rolle nutzer bekommt keine Kachel, keine Abfrage und kein Karten-Modul', async () => {
  const vorher = kartenLaderAufrufe;
  const { wurzel, aufrufe } = await einbinden({ rolle: 'nutzer' });
  try {
    assert.equal(kachelVon(wurzel), null, 'keine Kachel weltkarte');
    assert.deepEqual(verbindungsAufrufe(aufrufe), [], 'kein netz.verbindungen');
    assert.ok(!aufrufe.some((x) => x.aktion === 'nutzer.einstellungen.lesen' && x.params.bereich === 'weltkarte'), 'Richtung wird nicht gelesen');
    assert.equal(kartenLaderAufrufe, vorher, 'weltkarte.js wird für Nutzer nicht geladen');
    assert.ok(!dashModul._test.standardKacheln().some((k) => k.id === 'weltkarte'));
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Admin – Kachel mit Umschalter, Standard „Ausgehend“, erste Abfrage, Karte bekommt die Daten', async () => {
  const { wurzel, aufrufe } = await einbinden();
  try {
    const k = kachelVon(wurzel);
    assert.ok(k, 'Kachel weltkarte vorhanden');
    assert.equal(k.style.gridColumn, '1 / span 12', 'volle Breite im 12er-Raster'); assert.equal(k.style.gridRow.split('span ')[1], '10', '10 Zeilen hoch');
    const ein = richtungsKnopf(k, 'ein'); const aus = richtungsKnopf(k, 'aus');
    assert.ok(ein && aus, 'zwei Umschaltknöpfe');
    assert.equal(ein.textContent, 'dashboard.weltkarte_eingehend'); assert.equal(aus.textContent, 'dashboard.weltkarte_ausgehend');
    assert.equal(aus.getAttribute('aria-pressed'), 'true'); assert.equal(ein.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(verbindungsAufrufe(aufrufe).map((x) => x.params), [{ richtung: 'aus' }]);
    const karte = letzteKarte();
    assert.ok(karte && k.alle().includes(karte.behaelter), 'Karte sitzt in der Kachel');
    assert.equal(typeof karte.optionen.t, 'function'); assert.equal(karte.optionen.bewegungReduziert, false);
    // kein eigener Lader: der Standard-Lader des Karten-Moduls holt welt.json einmal je Seite (Prüfbericht 26.09., Fund 9)
    assert.equal(karte.optionen.holeWelt, undefined);
    assert.equal(karte.daten.length, 1); assert.equal(karte.daten[0].e.richtung, 'aus'); assert.deepEqual(karte.daten[0].o, { filter: null });
    assert.deepEqual(ipsIn(k).sort(), ['192.168.1.1', '140.82.121.4', '151.101.1.69', '9.9.9.9']);
    const texte = liste(k, 'fern').textContent;
    assert.ok(texte.includes('San Francisco') && texte.includes('USA'), 'Ort mit Stadt und Land');
    assert.ok(texte.includes('\u{1F1FA}\u{1F1F8}'), 'Flagge aus Regional-Indicator-Zeichen');
    assert.ok(texte.includes('dashboard.weltkarte_heimnetz'), 'private Gegenstelle als Heimnetz');
    assert.ok(texte.includes('dashboard.weltkarte_anycast'), 'Anycast ohne Ort');
    assert.equal(k.querySelector('.dashboard-wk-titel-lokal').textContent, 'dashboard.weltkarte_absender');
    assert.equal(k.querySelector('.dashboard-wk-titel-fern').textContent, 'dashboard.weltkarte_ziele');
  } finally { verlassen(wurzel); }
  assert.equal(letzteKarte().zerstoert, true, 'verlassen räumt die Karte ab');
});

test('Weltkarte: gespeicherte Richtung „ein“ wird beim Laden übernommen', async () => {
  const { wurzel, aufrufe } = await einbinden({ gespeichert: 'ein' });
  try {
    const k = kachelVon(wurzel);
    assert.equal(richtungsKnopf(k, 'ein').getAttribute('aria-pressed'), 'true');
    assert.equal(richtungsKnopf(k, 'aus').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(verbindungsAufrufe(aufrufe).map((x) => x.params.richtung), ['ein'], 'erste Abfrage schon mit der gespeicherten Richtung');
    assert.equal(k.querySelector('.dashboard-wk-titel-lokal').textContent, 'dashboard.weltkarte_dienste');
    assert.equal(k.querySelector('.dashboard-wk-titel-fern').textContent, 'dashboard.weltkarte_quellen');
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Klick „Eingehend“ speichert die Richtung und fragt sofort ab', async () => {
  const { wurzel, aufrufe } = await einbinden();
  try {
    const k = kachelVon(wurzel);
    aufrufe.length = 0;
    richtungsKnopf(k, 'ein').click();
    await abarbeiten();
    assert.deepEqual(aufrufe.find((x) => x.aktion === 'nutzer.einstellungen.setzen').params, { name: 'chef', bereich: 'weltkarte', wert: { richtung: 'ein' } });
    assert.deepEqual(verbindungsAufrufe(aufrufe).map((x) => x.params), [{ richtung: 'ein' }]);
    assert.equal(richtungsKnopf(k, 'ein').getAttribute('aria-pressed'), 'true');
    assert.equal(richtungsKnopf(k, 'aus').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(ipsIn(k), ['192.168.1.79']);
    assert.equal(letzteKarte().daten.at(-1).e.richtung, 'ein');
    // gleicher Knopf noch einmal: nichts passiert
    aufrufe.length = 0;
    richtungsKnopf(k, 'ein').click(); await abarbeiten();
    assert.deepEqual(aufrufe, []);
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Umschalten leert die Karte sofort (Platzhalter der neuen Richtung, Standort bleibt); scheitert die Abfrage, bleiben keine alten Bögen', async () => {
  const warn = console.warn; console.warn = () => {};
  const antworten = (p) => { if (p.richtung === 'ein') throw Object.assign(new Error('Zeitlimit'), { code: 'E_ZEIT' }); return ergebnis(p.richtung); };
  const { wurzel } = await einbinden({ antworten });
  try {
    const k = kachelVon(wurzel);
    const karte = letzteKarte();
    assert.equal(karte.daten.length, 1);
    richtungsKnopf(k, 'ein').click();
    // sofort, ohne auf die Abfrage zu warten
    const platzhalter = karte.daten.at(-1);
    assert.equal(karte.daten.length, 2, 'Karte bekommt sofort einen Platzhalter');
    assert.equal(platzhalter.e.richtung, 'ein');
    assert.deepEqual(platzhalter.e.gegenstellen, [], 'keine Gegenstellen der alten Richtung');
    assert.deepEqual(platzhalter.e.heimat, ergebnis('aus').heimat, 'Standort bleibt');
    assert.deepEqual(platzhalter.o, { filter: null, laedt: true });
    await abarbeiten();
    assert.equal(karte.daten.length, 2, 'Abfrage gescheitert: kein weiteres setzeDaten – die Karte bleibt leer');
    assert.ok(k.querySelector('.dashboard-wk-hinweise').textContent.includes('dashboard.weltkarte_fehler'), 'Fehlerhinweis der Kachel');
    assert.deepEqual(ipsIn(k), [], 'auch die Liste zeigt nichts von der alten Richtung');
  } finally { verlassen(wurzel); console.warn = warn; }
});

test('Weltkarte: Wettlauf – eine verspätete Antwort der alten Richtung wird verworfen', async () => {
  let ausFreigeben = null;
  const antworten = (p) => (p.richtung === 'aus' ? new Promise((ok) => { ausFreigeben = ok; }) : ergebnis('ein'));
  const { wurzel } = await einbinden({ antworten });
  try {
    const k = kachelVon(wurzel);
    assert.ok(ausFreigeben, 'Abfrage „aus“ hängt noch');
    richtungsKnopf(k, 'ein').click();
    await abarbeiten();
    assert.deepEqual(ipsIn(k), ['192.168.1.79']);
    ausFreigeben(ergebnis('aus'));
    await abarbeiten();
    assert.deepEqual(ipsIn(k), ['192.168.1.79'], 'Liste zeigt weiter die Daten von „ein“');
    assert.deepEqual(letzteKarte().daten.map((d) => d.e.richtung), ['ein', 'ein'], 'die Karte hat die alte Antwort nie bekommen (Platzhalter + Daten von „ein“)');
    assert.deepEqual(letzteKarte().daten.map((d) => !!d.o.laedt), [true, false]);
    assert.equal(richtungsKnopf(k, 'ein').getAttribute('aria-pressed'), 'true');
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Listen zeigen höchstens 10 Einträge, „alle zeigen“ klappt auf und wieder zu', async () => {
  const viele = Array.from({ length: 15 }, (_, i) => gegenstelle(`203.0.113.${i + 1}`, ['FAH-NAS'], { ort: ort('NL', 'Niederlande', null, 52.1, 5.3), anzahl: 20 - i }));
  const vieleLokal = Array.from({ length: 12 }, (_, i) => ({ name: `app-${i + 1}`, art: 'app', anzahl: 12 - i, bytes: 100 }));
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: viele, lokal: vieleLokal }) });
  try {
    const k = kachelVon(wurzel);
    assert.equal(liste(k, 'fern').children.length, 10);
    assert.equal(liste(k, 'lokal').children.length, 10);
    assert.equal(ipsIn(k)[0], '203.0.113.1', 'die meisten Verbindungen zuerst');
    const mehr = mehrKnopf(k, 'fern');
    assert.ok(mehr && !mehr.hidden, 'Knopf „alle zeigen“');
    assert.equal(mehr.textContent, 'dashboard.weltkarte_alle_zeigen{"n":15}');
    assert.equal(mehr.getAttribute('aria-expanded'), 'false');
    mehr.click();
    assert.equal(liste(k, 'fern').children.length, 15);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weniger');
    assert.equal(mehrKnopf(k, 'fern').getAttribute('aria-expanded'), 'true');
    assert.equal(liste(k, 'lokal').children.length, 10, 'die andere Liste bleibt zu');
    mehrKnopf(k, 'fern').click();
    assert.equal(liste(k, 'fern').children.length, 10);
    mehrKnopf(k, 'lokal').click();
    assert.equal(liste(k, 'lokal').children.length, 12);
    const text = liste(k, 'fern').textContent;
    assert.ok(text.includes('Niederlande') && !text.includes('null'), 'Ort ohne Stadt zeigt nur das Land');
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Klick auf einen Absender filtert Karte und Liste, zweiter Klick hebt den Filter auf', async () => {
  const { wurzel } = await einbinden();
  try {
    const k = kachelVon(wurzel);
    const karte = letzteKarte();
    lokalKnopf(k, 'it-tools').click();
    assert.deepEqual(karte.filter, ['it-tools']);
    assert.equal(lokalKnopf(k, 'it-tools').getAttribute('aria-pressed'), 'true');
    assert.equal(lokalKnopf(k, 'FAH-NAS').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(ipsIn(k).sort(), ['140.82.121.4', '151.101.1.69'], 'Liste zeigt nur Gegenstellen dieses Absenders');
    lokalKnopf(k, 'it-tools').click();
    assert.deepEqual(karte.filter, ['it-tools', null]);
    assert.equal(lokalKnopf(k, 'it-tools').getAttribute('aria-pressed'), 'false');
    assert.equal(ipsIn(k).length, 4);
    // Filter überlebt eine Aktualisierung, solange es den Absender noch gibt; neue Daten tragen ihn mit
    lokalKnopf(k, 'FAH-NAS').click();
    mock.timers.tick(5000); await abarbeiten();
    assert.deepEqual(karte.daten.at(-1).o, { filter: 'FAH-NAS' });
    assert.equal(lokalKnopf(k, 'FAH-NAS').getAttribute('aria-pressed'), 'true');
    // Umschalten der Richtung hebt den Filter auf (Absender ≠ Dienste)
    richtungsKnopf(k, 'ein').click(); await abarbeiten();
    assert.equal(karte.filter.at(-1), null);
    assert.deepEqual(karte.daten.at(-1).o, { filter: null });
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Listen bauen nur bei echter Änderung neu – Fokus eines Filterknopfs bleibt über die 5-s-Abfrage und nach Enter (Prüfbericht 26.09.)', async () => {
  let runde = 0;
  let itToolsVorn = false;
  const antworten = (p) => {
    runde++;
    return ergebnis(p.richtung, { lokal: [
      { name: 'FAH-NAS', art: 'host', anzahl: 4 + runde, bytes: 5000 * runde },
      { name: 'it-tools', art: 'app', anzahl: itToolsVorn ? 100 : 2, bytes: 2400 },
    ] });
  };
  const { wurzel } = await einbinden({ antworten });
  try {
    const k = kachelVon(wurzel);
    const knopf = lokalKnopf(k, 'it-tools');
    const fernVorher = liste(k, 'fern').children.slice();
    knopf.focus();
    assert.equal(dokument.activeElement, knopf);
    mock.timers.tick(5000); await abarbeiten();
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(runde, 3, 'zwei weitere Abfragen');
    assert.equal(dokument.activeElement, knopf, 'Fokus bleibt über zwei Abfragen auf demselben Knopf');
    assert.equal(lokalKnopf(k, 'it-tools'), knopf, 'Knopf wird wiederverwendet');
    assert.ok(lokalKnopf(k, 'FAH-NAS').textContent.includes('{"n":7}'), `geänderte Zahl steht im selben Knopf: ${lokalKnopf(k, 'FAH-NAS').textContent}`);
    assert.deepEqual(liste(k, 'fern').children, fernVorher, 'unveränderte Gegenstellen behalten ihre Knoten');
    // Enter auf einem Knopf löst click aus: Filter an – der Knopf bleibt derselbe und behält den Fokus
    knopf.click();
    assert.equal(knopf.getAttribute('aria-pressed'), 'true');
    assert.equal(lokalKnopf(k, 'it-tools'), knopf);
    assert.equal(dokument.activeElement, knopf, 'Fokus bleibt nach Enter auf dem Filter');
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(dokument.activeElement, knopf, 'Fokus bleibt auch mit Filter über die Abfrage');
    // Reihenfolge ändert sich (it-tools rückt nach vorn): der Knopf muss wandern – der Fokus wird zurückgeholt
    itToolsVorn = true;
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(liste(k, 'lokal').children[0].children[0].dataset.name, 'it-tools', 'neue Reihenfolge');
    assert.equal(dokument.activeElement.dataset.name, 'it-tools', 'Fokus liegt wieder auf dem gleichnamigen Knopf');
    // Zweites Enter hebt den Filter auf, Fokus bleibt
    dokument.activeElement.click();
    assert.equal(lokalKnopf(k, 'it-tools').getAttribute('aria-pressed'), 'false');
    assert.equal(dokument.activeElement.dataset.name, 'it-tools');
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Abfrage alle 5 s nur bei sichtbarem Tab und sichtbarer Kachel, in verlassen gestoppt', async () => {
  const { wurzel, aufrufe } = await einbinden();
  const zahl = () => verbindungsAufrufe(aufrufe).length;
  try {
    assert.equal(zahl(), 1);
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(zahl(), 2, 'nach 5 s neu abgefragt');
    dokument.hidden = true; dokument.ausloesen('visibilitychange');
    mock.timers.tick(5000); await abarbeiten();
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(zahl(), 2, 'versteckter Tab → keine Abfrage');
    assert.equal(letzteKarte().pausen.at(-1), true, 'Karte pausiert bei verstecktem Tab');
    dokument.hidden = false; dokument.ausloesen('visibilitychange'); await abarbeiten();
    assert.equal(zahl(), 3, 'Tab wieder sichtbar → sofort abfragen');
    assert.equal(letzteKarte().pausen.at(-1), false);
    // Kachel rollt aus dem Bild
    const io = beobachter.at(-1);
    assert.ok(io && io.ziele.includes(kachelVon(wurzel)), 'IntersectionObserver beobachtet die Kachel');
    io.melden(false);
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(zahl(), 3, 'Kachel nicht im Bild → keine Abfrage');
    io.melden(true); await abarbeiten();
    assert.equal(zahl(), 4, 'wieder im Bild → sofort');
  } finally { verlassen(wurzel); }
  assert.equal(beobachter.at(-1).getrennt, true, 'IntersectionObserver getrennt');
  assert.equal(dokument.hoererAnzahl('visibilitychange'), 0, 'visibilitychange-Hörer entfernt');
  const vorher = zahl();
  mock.timers.tick(30_000); await abarbeiten();
  assert.equal(zahl(), vorher, 'nach verlassen keine Abfragen mehr');
});

test('Weltkarte: keine zweite Abfrage, solange die vorige derselben Richtung noch läuft', async () => {
  let offen = 0;
  const antworten = (p) => { offen++; return new Promise(() => {}); };
  const { wurzel, aufrufe } = await einbinden({ antworten });
  try {
    mock.timers.tick(5000); await abarbeiten();
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(verbindungsAufrufe(aufrufe).length, 1, 'hängende Abfrage wird nicht gestapelt');
    assert.equal(offen, 1);
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Standardplatz volle Breite 12 × 10 Felder; übrige Kacheln mit ihren Standardgrößen', async () => {
  const { wurzel } = await einbinden();
  try {
    assert.ok(dashModul._test.standardKacheln().includes('weltkarte'));
    const w = dashModul._test.wirksamesLayout();
    const von = (id) => w.kacheln.find((x) => x.id === id);
    assert.equal(von('weltkarte').b, 12); assert.equal(von('weltkarte').h, 10);
    for (const id of ['cpu', 'ram', 'netz', 'system', 'apps', 'vms']) assert.equal(von(id).b, 3, id);
    assert.equal(von('aufgaben').b, 6); assert.equal(von('ereignisse').b, 6);
    assert.equal(kachelVon(wurzel).style.gridColumn, '1 / span 12', 'Layout setzt die Zellen');
  } finally { verlassen(wurzel); }
});

test('Weltkarte: Hinweise – nur Heimnetz, Ortsdaten-Quelle, Namensnennung, Aufzeichnung aus, Abfragefehler, Karte fehlt', async () => {
  // Eingehend nur aus dem Heimnetz
  let r = await einbinden({ gespeichert: 'ein' });
  try {
    const k = kachelVon(r.wurzel);
    assert.ok(k.querySelector('.dashboard-wk-hinweise').textContent.includes('dashboard.weltkarte_nur_heimnetz'));
    const hinweisVorher = k.querySelector('.dashboard-wk-hinweise').children[0];
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(k.querySelector('.dashboard-wk-hinweise').children[0], hinweisVorher, 'gleicher Hinweis wird nicht neu aufgebaut (aria-live liest ihn nicht alle 5 s vor)');
    const fuss = k.querySelector('.dashboard-wk-fuss').textContent;
    assert.ok(fuss.includes('dashboard.weltkarte_quelle_stadt{"stand":"2026-09"}'), fuss);
    assert.ok(fuss.includes('dashboard.weltkarte_namensnennung'), 'Namensnennung DB-IP/Natural Earth sichtbar');
    assert.ok(fuss.includes('dashboard.weltkarte_stand'), 'Stand der Daten');
    richtungsKnopf(k, 'aus').click(); await abarbeiten();
    assert.ok(!k.querySelector('.dashboard-wk-hinweise').textContent.includes('nur_heimnetz'), 'ausgehend mit öffentlichen Zielen: kein Heimnetz-Hinweis');
  } finally { verlassen(r.wurzel); }
  // Nur Länder, Aufzeichnung aus
  r = await einbinden({ antworten: (p) => ergebnis(p.richtung, { geo: { quelle: 'land', stand: null, hinweis: 'Download fehlgeschlagen' }, aufzeichnung: false, gegenstellen: [], lokal: [], heimat: null }) });
  try {
    const k = kachelVon(r.wurzel);
    const fuss = k.querySelector('.dashboard-wk-fuss').textContent;
    assert.ok(fuss.includes('dashboard.weltkarte_quelle_land') && fuss.includes('Download fehlgeschlagen'), fuss);
    assert.ok(liste(k, 'fern').textContent.includes('dashboard.weltkarte_aufzeichnung_aus'));
    assert.equal(liste(k, 'lokal').textContent, '–', 'der Hinweis steht nur einmal, die zweite Liste zeigt einen Strich');
    assert.equal(letzteKarte().daten.at(-1).e.aufzeichnung, false, 'Karte bekommt die Daten trotzdem (zeigt ihren eigenen Hinweis)');
  } finally { verlassen(r.wurzel); }
  // Keine Ortsdaten, leere Listen
  r = await einbinden({ antworten: (p) => ergebnis(p.richtung, { geo: { quelle: 'keine', stand: null, hinweis: null }, gegenstellen: [], lokal: [] }) });
  try {
    const k = kachelVon(r.wurzel);
    assert.ok(k.querySelector('.dashboard-wk-fuss').textContent.includes('dashboard.weltkarte_quelle_keine'));
    assert.ok(liste(k, 'fern').textContent.includes('dashboard.weltkarte_keine'));
    assert.ok(liste(k, 'lokal').textContent.includes('dashboard.weltkarte_keine'));
  } finally { verlassen(r.wurzel); }
  // Aktion scheitert (z. B. älterer Agent) → Hinweis, keine Ausnahme
  r = await einbinden({ antworten: () => { throw Object.assign(new Error('Aktion unbekannt'), { code: 'E_NICHT_GEFUNDEN' }); } });
  try {
    const k = kachelVon(r.wurzel);
    assert.ok(k.querySelector('.dashboard-wk-hinweise').textContent.includes('dashboard.weltkarte_fehler{"grund":"Aktion unbekannt"}'));
    assert.equal(letzteKarte().daten.length, 0, 'ohne Ergebnis kein setzeDaten');
  } finally { verlassen(r.wurzel); }
  // Karten-Modul lässt sich nicht laden → Hinweis, Listen funktionieren trotzdem
  kartenLaderFehler = new Error('Modul fehlt');
  const warn = console.warn; console.warn = () => {};
  const anzahlKarten = karten.length;
  try {
    r = await einbinden();
    const k = kachelVon(r.wurzel);
    assert.ok(k.querySelector('.dashboard-wk-hinweise').textContent.includes('dashboard.weltkarte_karte_fehlt'));
    assert.equal(ipsIn(k).length, 4);
    assert.equal(karten.length, anzahlKarten);
    verlassen(r.wurzel);
  } finally { kartenLaderFehler = null; console.warn = warn; }
});

test('Weltkarte: eine werfende Karte stört Listen und Umschalter nicht', async () => {
  const warn = console.warn; console.warn = () => {};
  const { wurzel } = await einbinden();
  try {
    const karte = letzteKarte();
    karte.setzeDaten = () => { throw new Error('kaputt'); };
    karte.setzeFilter = () => { throw new Error('kaputt'); };
    const k = kachelVon(wurzel);
    richtungsKnopf(k, 'ein').click(); await abarbeiten();
    assert.deepEqual(ipsIn(k), ['192.168.1.79']);
    lokalKnopf(k, 'SMB').click();
    assert.equal(lokalKnopf(k, 'SMB').getAttribute('aria-pressed'), 'true');
  } finally { verlassen(wurzel); console.warn = warn; }
});

test('Weltkarte: Quelltext lädt weltkarte.js nur dynamisch; Modul hat die Schnittstelle aus §4.8; Symbol welt vorhanden', async () => {
  const quelle = await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.js'), 'utf8');
  assert.match(quelle, /import\('\.\/weltkarte\.js'\)/, 'dynamischer Import');
  assert.ok(!/from\s+'\.\/weltkarte\.js'/.test(quelle), 'kein statischer Import');
  assert.match(quelle, /kachel\('weltkarte', 'welt'/);
  assert.ok(!/welt\.json/.test(quelle.replace(/^\s*\/\/.*$/gm, '')), 'dashboard.js lädt welt.json nicht selbst (sonst je Ansichtswechsel ein Abruf)');
  const m = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'weltkarte.js')).href);
  for (const n of ['erzeugeWeltkarte', 'projektion', 'dekodiereWelt']) assert.equal(typeof m[n], 'function', n);
  const svg = await fs.readFile(path.join(PUBLIC, 'symbole.svg'), 'utf8');
  assert.match(svg, /<symbol id="symbol-welt" viewBox="0 0 24 24"/);
});

test('Weltkarte: alle Sprachschlüssel der Kachel existieren (dashboard.json) – auch die aus dem Plan', async () => {
  const texte = JSON.parse(await fs.readFile(path.join(SPRACHE, 'dashboard.json'), 'utf8'));
  const quelle = (await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.js'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const benutzt = new Set([...quelle.matchAll(/'(dashboard\.weltkarte[a-z0-9_]*)'/g)].map((x) => x[1]));
  assert.ok(benutzt.size >= 20, `nur ${benutzt.size} Schlüssel gefunden`);
  for (const k of benutzt) assert.ok(Object.hasOwn(texte, k), `dashboard.json: ${k} fehlt`);
  for (const s of ['', '_eingehend', '_ausgehend', '_gegenstellen', '_absender', '_dienste', '_alle_zeigen', '_weniger', '_keine', '_nur_heimnetz', '_quelle_stadt', '_quelle_land', '_quelle_keine', '_namensnennung', '_stand', '_datenmenge']) {
    assert.ok(Object.hasOwn(texte, `dashboard.weltkarte${s}`), `dashboard.weltkarte${s} fehlt`);
    assert.ok(benutzt.has(`dashboard.weltkarte${s}`), `dashboard.weltkarte${s} wird nicht benutzt`);
  }
  assert.equal(texte['dashboard.weltkarte_namensnennung'], 'IP-Geolokalisierung: DB-IP.com (CC BY 4.0) · Karte: Natural Earth');
  for (const [k, v] of Object.entries(texte)) if (k.startsWith('dashboard.weltkarte')) assert.ok(!/Upload|Download/.test(v), `${k}: kein Denglisch: ${v}`);
});

test('Weltkarte: Karte füllt zusätzliche Kachelhöhe (Flex-Kette bis zur Kartenfläche), ohne Zusatz bleibt das Seitenverhältnis (Prüfbericht 26.09.)', async () => {
  // Struktur: Kachel (Flex-Spalte) → Inhalt (wächst) → Karte (Flex-Spalte) → .wk (wächst) → .wk-flaeche (streckt sich)
  const { wurzel } = await einbinden();
  try {
    const k = kachelVon(wurzel);
    const inhalt = k.querySelector('.dashboard-wk-inhalt');
    assert.ok(inhalt && inhalt.parentNode === k, 'Inhalt direkt in der Kachel');
    assert.deepEqual(inhalt.children.map((x) => x.className), ['dashboard-wk-karte', 'dashboard-wk-seite']);
    assert.equal(letzteKarte().behaelter, k.querySelector('.dashboard-wk-karte'), 'die Karte hängt im wachsenden Behälter');
  } finally { verlassen(wurzel); }
  const stil = await fs.readFile(path.join(PUBLIC, 'stil.css'), 'utf8');
  assert.match(stil, /\.kachel \{[^}]*display: flex; flex-direction: column;/, 'Kachel ist eine Flex-Spalte');
  const css = (await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const regel = (sel, von = css) => { const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(von); assert.ok(m, `Regel ${sel} fehlt`); return m[1]; };
  // Zusatzhöhe geht an die Kartenzeile (auto), nicht an die Listen (max-content)
  assert.match(regel('.dashboard-wk-inhalt'), /flex: 1 1 auto/);
  // min-content statt auto als Untergrenze: die Karte schneidet ab (overflow hidden → automatische Mindesthöhe 0), sonst
  // verteilt das Raster die Mindesthöhe kürzerer Listen hälftig auf beide Zeilen (Chrome-Messung: +88 px Leerraum)
  assert.match(regel('.dashboard-wk-inhalt'), /grid-template-rows: minmax\(min-content, auto\) max-content/);
  assert.match(regel('.dashboard-wk-karte'), /align-self: stretch/);
  assert.match(regel('.dashboard-wk-karte'), /display: flex; flex-direction: column/);
  assert.match(regel('.dashboard-wk-karte > .wk'), /flex: 1 1 auto/);
  // Breite Kachel: Listen rechts über beide Zeilen – höhere Listen strecken die Karte nicht (Zeile 2 nimmt den Überhang)
  const breit = /@container \(min-width: 720px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(breit, 'Container-Abfrage fehlt');
  assert.match(regel('.dashboard-wk-seite', breit[1]), /grid-column: 2; grid-row: 1 \/ span 2/);
  assert.match(regel('.dashboard-wk-karte', breit[1]), /grid-column: 1; grid-row: 1/);
  assert.match(regel('.dashboard-wk-inhalt', breit[1]), /row-gap: 0/);
  // Kartenmodul: Flächenzeile wächst (1fr), die Fläche streckt sich; das SVG bleibt proportional (meet, im Modul)
  // Mindesthöhe 150 px an der Zeile; die Fläche füllt ihre Zeile (min-height 100 % schlägt max-height) – die Obergrenze
  // 72vh gilt so nur für die Höhe aus dem Seitenverhältnis, nicht für ausdrücklich höher gezogene Kacheln (sonst leeres Band)
  assert.match(regel('.wk'), /grid-template-rows: minmax\(150px, 1fr\) auto/);
  assert.match(regel('.wk-flaeche'), /min-height: 100%/);
  assert.match(regel('.wk-flaeche'), /max-height: 72vh/);
  const handy = /@media \(max-width: 719px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf('.wk {')));
  assert.match(regel('.wk', handy[1]), /grid-template-rows: minmax\(150px, 1fr\) auto auto/, 'Handy: Hinweise und Legende unter der Fläche');
  const modul = await fs.readFile(path.join(PUBLIC, 'ansichten', 'weltkarte.js'), 'utf8');
  assert.match(modul, /preserveAspectRatio: 'xMidYMid meet'/);
});

// Kontrastrechner nach WCAG 2.x wie in tests/einheit/ui_fixes.test.js (dort nicht importierbar: der Import würde dessen
// Tests in diesem Lauf mitregistrieren)
const hexZuRgb = (hex) => { const h = String(hex).replace('#', ''); const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; const n = parseInt(v, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const leuchtdichte = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const kontrast = (a, b) => { const l1 = leuchtdichte(hexZuRgb(a)); const l2 = leuchtdichte(hexZuRgb(b)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
function farbVariablen(css, start) {
  const i = css.indexOf(start); assert.ok(i >= 0, `Block „${start}“ fehlt in stil.css`);
  const aus = {};
  for (const m of css.slice(i, css.indexOf('}', i)).matchAll(/(--fahnas-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) aus[m[1]] = m[2];
  return aus;
}

test('Weltkarte: Umschalter – gedrückter Zustand deutlich (Fläche ≥ 3:1 gegen ungedrückt und dessen Hover, Text ≥ 4,5:1), hell und dunkel (Prüfbericht 26.09., WCAG 1.4.11)', async () => {
  const stil = await fs.readFile(path.join(PUBLIC, 'stil.css'), 'utf8');
  const css = await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8');
  const regel = /\.dashboard-wk-umschalter \.knopf\[aria-pressed="true"\] \{([^}]*)\}/.exec(css);
  assert.ok(regel, 'Regel für den gedrückten Umschalter fehlt');
  const variable = (eigenschaft) => { const m = new RegExp(`(?:^|;)\\s*${eigenschaft}:\\s*var\\((--fahnas-[a-z0-9-]+)\\)`).exec(regel[1]); assert.ok(m, `${eigenschaft} ohne var(--fahnas-…)`); return m[1]; };
  const flaecheGedrueckt = variable('background'); const text = variable('color');
  const ungedrueckt = /\.knopf-zweit \{[^}]*background: var\((--fahnas-[a-z0-9-]+)\)/.exec(stil)[1];
  const ungedruecktHover = /\.knopf-zweit:hover \{[^}]*background: var\((--fahnas-[a-z0-9-]+)\)/.exec(stil)[1];
  for (const [name, satz] of [['hell', farbVariablen(stil, ':root {')], ['dunkel', farbVariablen(stil, ':root[data-design="dunkel"] {')]]) {
    for (const [a, b, min, wo] of [[flaecheGedrueckt, ungedrueckt, 3, 'gedrückt ↔ ungedrückt'], [flaecheGedrueckt, ungedruecktHover, 3, 'gedrückt ↔ ungedrückt mit Zeiger darüber'], [text, flaecheGedrueckt, 4.5, 'Text auf gedrückt']]) {
      const k = kontrast(satz[a], satz[b]);
      assert.ok(k >= min, `${name}: ${wo} – ${a} ${satz[a]} / ${b} ${satz[b]} nur ${k.toFixed(2)}:1`);
    }
  }
  // Mit dem Zeiger darüber bleibt der gedrückte Knopf gedrückt (nicht die helle Hover-Fläche von .knopf-zweit)
  assert.match(css, /\.dashboard-wk-umschalter \.knopf\[aria-pressed="true"\]:hover \{[^}]*background: var\(--fahnas-akzent-dunkel\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// System: Karte „Standort und Verbindungen“
// ---------------------------------------------------------------------------------------------------------------------

const systemModul = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'system.js')).href);

async function systemEinbinden({ konfig = {}, geo = { quelle: 'stadt', stand: '2026-09', hinweis: null }, verbindungenFehler = false } = {}) {
  const wurzel = dokument.createElement('main');
  dokument.body.appendChild(wurzel);
  const aufrufe = [];
  const ctx = {
    rolle: 'admin', nutzer: { name: 'chef', rolle: 'admin' }, t: (k) => k, sse: { on() {} }, melden: (text, art) => meldungen.push({ text, art }),
    api: async (aktion, params = {}) => {
      aufrufe.push({ aktion, params: structuredClone(params) });
      if (aktion === 'system.lesen') return { hostname: 'fahnas', standort: { lat: null, lon: null, name: '' }, verbindungen: { aufzeichnen: true }, geo: { stadt_laden: true }, vertraute_proxys: [], ...konfig };
      if (aktion === 'system.setzen') return params.aenderungen;
      if (aktion === 'netz.verbindungen') { if (verbindungenFehler) throw Object.assign(new Error('fehlt'), { code: 'E_NICHT_GEFUNDEN' }); return { ...ergebnis(params.richtung), geo }; }
      if (aktion === 'system.protokoll') return { eintraege: [], gesamt: 0 };
      return {};
    },
  };
  await systemModul.default.einbinden(wurzel, ctx);
  await abarbeiten();
  const karte = wurzel.alle().find((k) => k.classList.contains('sy-standort'));
  const feldMit = (klasse) => karte.alle().find((k) => k.classList.contains(klasse));
  return {
    wurzel, aufrufe, karte,
    breite: feldMit('sy-standort-breite'), laenge: feldMit('sy-standort-laenge'), name: feldMit('sy-standort-name'),
    aufzeichnen: feldMit('sy-verbindungen-aufzeichnen'), stadtLaden: feldMit('sy-geo-stadt-laden'), proxys: feldMit('sy-proxys'),
    form: karte.alle().find((k) => k.tagName === 'FORM'),
    fehler: () => karte.alle().find((k) => k.classList.contains('vw-formfehler')),
    setzen: () => aufrufe.filter((x) => x.aktion === 'system.setzen'),
    verlassen() { systemModul.default.verlassen(); wurzel.remove(); },
  };
}

test('System: Karte „Standort und Verbindungen“ – Felder mit Beschriftung und Erklärtext, vorbelegt aus system.json', async () => {
  const s = await systemEinbinden({ konfig: { standort: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' }, verbindungen: { aufzeichnen: false }, geo: { stadt_laden: true }, vertraute_proxys: ['192.168.1.23', '192.168.48.0/20'] } });
  try {
    assert.ok(s.karte, 'Karte vorhanden');
    assert.equal(s.karte.children[0].textContent, 'system.standort_titel');
    assert.ok(s.karte.textContent.includes('system.standort_erklaerung'), 'Einleitung der Karte');
    const erwartet = [[s.breite, 'system.standort_breite'], [s.laenge, 'system.standort_laenge'], [s.name, 'system.standort_name'],
      [s.aufzeichnen, 'system.verbindungen_aufzeichnen'], [s.stadtLaden, 'system.geo_stadt_laden'], [s.proxys, 'system.proxys']];
    for (const [eingabe, schluessel] of erwartet) {
      assert.ok(eingabe, `${schluessel}: Eingabe fehlt`);
      const huelle = eingabe.parentNode;
      const texte = huelle.children.map((k) => k.textContent);
      assert.ok(texte.includes(schluessel), `${schluessel}: Beschriftung fehlt (${texte.join(' | ')})`);
      const erkl = huelle.children.find((k) => k.classList.contains('erklaerung'));
      assert.ok(erkl && erkl.textContent === `${schluessel}_erklaerung`, `${schluessel}: Erklärtext fehlt`);
    }
    assert.equal(s.breite.value, '48.6284'); assert.equal(s.laenge.value, '11.7989'); assert.equal(s.name.value, 'Sandelzhausen');
    assert.equal(s.aufzeichnen.checked, false); assert.equal(s.stadtLaden.checked, true);
    assert.equal(s.proxys.value, '192.168.1.23\n192.168.48.0/20');
    assert.equal(s.aufzeichnen.getAttribute('type') ?? s.aufzeichnen.type, 'checkbox');
    const stand = s.karte.alle().find((k) => k.classList.contains('sy-geo-stand'));
    assert.ok(stand && stand.textContent === 'system.geo_stand_stadt', 'Stand der Ortsdaten sichtbar');
    assert.ok(s.aufrufe.some((x) => x.aktion === 'netz.verbindungen'), 'Stand kommt aus netz.verbindungen (geo)');
  } finally { s.verlassen(); }
});

test('System: Speichern schickt standort, verbindungen, geo und vertraute_proxys an system.setzen', async () => {
  const s = await systemEinbinden();
  try {
    s.breite.value = '48,6284'; s.laenge.value = ' 11.7989 '; s.name.value = '  Sandelzhausen ';
    s.stadtLaden.checked = false;
    s.proxys.value = '192.168.1.23\n\n192.168.48.0/20, fd00::/8\n';
    s.form.ausloesen('submit'); await abarbeiten();
    assert.deepEqual(s.setzen().map((x) => x.params), [{ aenderungen: {
      standort: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' },
      verbindungen: { aufzeichnen: true },
      geo: { stadt_laden: false },
      vertraute_proxys: ['192.168.1.23', '192.168.48.0/20', 'fd00::/8'],
    } }]);
    assert.ok(meldungen.some((m) => m.art === 'erfolg'), 'Erfolgsmeldung');
    // beide Koordinaten leer → Standort gelöscht
    s.breite.value = ''; s.laenge.value = ''; s.name.value = '';
    s.form.ausloesen('submit'); await abarbeiten();
    assert.deepEqual(s.setzen().at(-1).params.aenderungen.standort, { lat: null, lon: null, name: '' });
  } finally { s.verlassen(); }
});

test('System: Feldprüfung – Breite 95, nur eine Koordinate, zu langer Name, ungültiger Proxy → Feldfehler, kein Aufruf', async () => {
  const s = await systemEinbinden({ verbindungenFehler: true });
  try {
    assert.ok(!s.karte.alle().some((k) => k.classList.contains('sy-geo-stand') && !k.hidden && k.textContent), 'ohne Antwort kein Stand – aber keine Ausnahme');
    const faelle = [
      [() => { s.breite.value = '95'; s.laenge.value = '11'; }, 'system.standort_breite_fehler', s.breite],
      [() => { s.breite.value = '-90.5'; s.laenge.value = '11'; }, 'system.standort_breite_fehler', s.breite],
      [() => { s.breite.value = 'Norden'; s.laenge.value = '11'; }, 'system.standort_breite_fehler', s.breite],
      [() => { s.breite.value = '48'; s.laenge.value = '181'; }, 'system.standort_laenge_fehler', s.laenge],
      [() => { s.breite.value = '48'; s.laenge.value = ''; }, 'system.standort_paar_fehler', s.laenge],
      [() => { s.breite.value = ''; s.laenge.value = '11'; }, 'system.standort_paar_fehler', s.breite],
      [() => { s.breite.value = '48'; s.laenge.value = '11'; s.name.value = 'x'.repeat(65); }, 'system.standort_name_fehler', s.name],
      [() => { s.name.value = 'Ort\u0007'; }, 'system.standort_name_fehler', s.name],
      [() => { s.name.value = 'Sandelzhausen'; s.proxys.value = '192.168.1.23\nkein-proxy'; }, 'system.proxys_fehler', s.proxys],
      [() => { s.proxys.value = '192.168.1.23/33'; }, 'system.proxys_fehler', s.proxys],
      [() => { s.proxys.value = Array.from({ length: 51 }, (_, i) => `10.0.${i}.1`).join('\n'); }, 'system.proxys_zuviele', s.proxys],
    ];
    for (const [vorbereiten, schluessel, feld] of faelle) {
      vorbereiten();
      s.form.ausloesen('submit'); await abarbeiten();
      assert.equal(s.fehler().textContent, schluessel);
      assert.equal(s.fehler().hidden, false);
      assert.equal(feld.getAttribute('aria-invalid'), 'true', `${schluessel}: Feld markiert`);
      assert.deepEqual(s.setzen(), [], `${schluessel}: kein system.setzen`);
    }
  } finally { s.verlassen(); }
});

test('System: reine Helfer standortAus/proxysAus', () => {
  const { standortAus, proxysAus } = systemModul;
  assert.deepEqual(standortAus('48,6284', '11.7989', ' Ort '), { standort: { lat: 48.6284, lon: 11.7989, name: 'Ort' } });
  assert.deepEqual(standortAus('', ' ', ''), { standort: { lat: null, lon: null, name: '' } });
  assert.deepEqual(standortAus('-90', '180', ''), { standort: { lat: -90, lon: 180, name: '' } });
  assert.equal(standortAus('90.0001', '0', '').fehler, 'breite');
  assert.equal(standortAus('0', '-180.1', '').fehler, 'laenge');
  assert.equal(standortAus('1e1', '0', '').fehler, 'breite', 'nur Dezimalzahlen, kein Exponent');
  assert.deepEqual(standortAus('\u221233,9', '+18.4', 'Kapstadt').standort, { lat: -33.9, lon: 18.4, name: 'Kapstadt' }, 'typografisches Minus und Plus');
  assert.equal(standortAus('0x10', '0', '').fehler, 'breite', 'keine Hex-Zahlen');
  assert.equal(standortAus('Infinity', '0', '').fehler, 'breite');
  assert.equal(standortAus('1', '', '').fehler, 'paar');
  assert.equal(standortAus('1', '2', 'x'.repeat(65)).fehler, 'name');
  assert.deepEqual(proxysAus(' 192.168.1.23 \n192.168.48.0/20;2001:db8::1\n::1/128 '), { liste: ['192.168.1.23', '192.168.48.0/20', '2001:db8::1', '::1/128'] });
  assert.deepEqual(proxysAus(''), { liste: [] });
  assert.deepEqual(proxysAus('192.168.1.23\n192.168.1.23'), { liste: ['192.168.1.23'] }, 'doppelte Einträge nur einmal');
  assert.deepEqual(proxysAus('256.1.1.1'), { fehler: 'eintrag', wert: '256.1.1.1' });
  assert.deepEqual(proxysAus('2001:db8::/129'), { fehler: 'eintrag', wert: '2001:db8::/129' });
  assert.deepEqual(proxysAus('fe80::1%eth0'), { fehler: 'eintrag', wert: 'fe80::1%eth0' });
  assert.equal(proxysAus(Array.from({ length: 51 }, (_, i) => `10.0.${i}.1`).join('\n')).fehler, 'zuviele');
});

test('System: alle Sprachschlüssel der neuen Karte existieren in system.json (mit Erklärtexten)', async () => {
  const texte = JSON.parse(await fs.readFile(path.join(SPRACHE, 'system.json'), 'utf8'));
  for (const k of ['standort_titel', 'standort_erklaerung', 'standort_breite', 'standort_breite_erklaerung', 'standort_breite_fehler', 'standort_laenge', 'standort_laenge_erklaerung',
    'standort_laenge_fehler', 'standort_paar_fehler', 'standort_name', 'standort_name_erklaerung', 'standort_name_fehler', 'verbindungen_aufzeichnen', 'verbindungen_aufzeichnen_erklaerung',
    'geo_stadt_laden', 'geo_stadt_laden_erklaerung', 'geo_stand_stadt', 'geo_stand_land', 'geo_stand_keine', 'proxys', 'proxys_erklaerung', 'proxys_fehler', 'proxys_zuviele', 'standort_gespeichert']) {
    assert.ok(Object.hasOwn(texte, k), `system.json: ${k} fehlt`);
  }
  assert.match(texte.geo_stadt_laden, /DB-IP City Lite, ca\. 60 MB/);
});


// ---------------------------------------------------------------------------------------------------------------------
// Rasterplatzierung (Betreiber 09.10.: „wie bei einem Salesforce-Dashboard frei verschieben“): 12 Spalten, Zeilen zu
// 40 px, Kacheln {x, y, b, h}; Lücken bleiben, Zusammenstöße schieben nach unten. Logik in dashboard-raster.js.
// ---------------------------------------------------------------------------------------------------------------------

// Attrappe für diesen Abschnitt erweitern: closest (ein Klassen-Selektor), Fokus, Maße (Raster 1376 px breit →
// 12 Spalten à 100 px + 16 px Abstand = 116 px je Spalte, 56 px je Zeile), Ereignisse am document (Esc beim Ziehen)
const Proto = Object.getPrototypeOf(dokument.createElement('div'));
Proto.closest = function (sel) { const kl = sel.startsWith('.') && !sel.includes(',') ? sel.slice(1) : null; let x = this; while (x && x.nodeType === 1) { if (kl && x.classList.contains(kl)) return x; x = x.parentNode; } return null; };
Proto.focus = function () { dokument.activeElement = this; };
Proto.getBoundingClientRect = function () {
  const istRaster = this.classList && this.classList.contains('dashboard-raster');
  const w = istRaster ? 1376 : 250; const h = this.classList && this.classList.contains('dashboard-kachel') ? 300 : 20;
  return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
};
const dokHoerer = {};
{ const add = dokument.addEventListener; const rem = dokument.removeEventListener;
  dokument.addEventListener = function (art, fn, o) { (dokHoerer[art] ||= []).push(fn); return add.call(this, art, fn, o); };
  dokument.removeEventListener = function (art, fn, o) { dokHoerer[art] = (dokHoerer[art] || []).filter((x) => x !== fn); return rem.call(this, art, fn, o); }; }
const amDokument = (art, ev) => { for (const fn of [...(dokHoerer[art] || [])]) fn({ type: art, preventDefault() {}, ...ev }); };
const RASTER = { display: 'grid', columnGap: '16px', rowGap: '16px', getPropertyValue: (n) => ({ '--dashboard-abstand': '16px', '--dashboard-zeile': '40px' })[n] || '' };

const raster = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard-raster.js')).href);
const kachelMitId = (wurzel, id) => wurzel.alle().find((k) => k.dataset && k.dataset.kachel === id) || null;
const zellen = (wurzel, id) => kachelMitId(wurzel, id).dataset.zellen;
const gespeicherteLayouts = (aufrufe) => aufrufe.filter((x) => x.aktion === 'nutzer.einstellungen.setzen' && x.params.bereich === 'uebersicht').map((x) => x.params.wert);
const speichernAbwarten = async () => { await new Promise((r) => setTimeout(r, 600)); await abarbeiten(); }; // Speichern über echten setTimeout (500 ms)
const anpassen = async (wurzel) => { wurzel.alle().find((x) => x.tagName === 'BUTTON' && x.textContent === 'dashboard.anpassen').ausloesen('click'); await abarbeiten(); };
const rasterVon = (wurzel) => wurzel.querySelector('.dashboard-raster');
/** Zeigerereignis wie im Browser: am Raster (Delegation), Ziel = das gegriffene Element. */
const zeiger = (wurzel, ziel, art, x, y, extra = {}) => rasterVon(wurzel).ausloesen(art, { target: ziel, clientX: x, clientY: y, pointerId: 1, button: 0, ...extra });
const kopfVon = (wurzel, id) => kachelMitId(wurzel, id).querySelector('.kachel-kopf');
const mitRasterStil = async (fn) => { const alt = globalThis.getComputedStyle; globalThis.getComputedStyle = () => RASTER; try { return await fn(); } finally { globalThis.getComputedStyle = alt; } };

test('Raster: Zusammenstoß schiebt nach unten, Lücken bleiben; Fließ-Anordnung; Einrasten beim Ziehen; Umrechnung alter Pixelhöhen', () => {
  const { kollisionenAufloesen, flussPlatzieren, zellenNachZiehen, zeilenAusPx, kachelSetzen, lesereihenfolge, ueberlappt } = raster;
  const a = { id: 'a', x: 0, y: 0, b: 6, h: 4 }; const b = { id: 'b', x: 6, y: 0, b: 6, h: 4 }; const c = { id: 'c', x: 0, y: 10, b: 3, h: 2 };
  // b auf a legen: a rutscht unter b, c (weit unten, frei) bleibt – die Lücke darüber bleibt auch
  const l = kachelSetzen([a, b, c], 'b', { x: 0, y: 0 });
  assert.deepEqual(l.find((e) => e.id === 'b'), { id: 'b', x: 0, y: 0, b: 6, h: 4 });
  assert.deepEqual(l.find((e) => e.id === 'a'), { id: 'a', x: 0, y: 4, b: 6, h: 4 });
  assert.deepEqual(l.find((e) => e.id === 'c'), c, 'nichts rutscht von selbst hoch');
  // Kette: a rutscht auf c → c rutscht weiter
  const kette = kachelSetzen([a, { ...b, x: 0, y: 8 }, { ...c, y: 9 }], 'a', { y: 7 });
  assert.ok(!kette.some((p, i) => kette.some((q, j) => i < j && ueberlappt(p, q))), 'keine Überlappung');
  assert.deepEqual(kette.map((e) => e.y), [7, 11, 15]);
  assert.deepEqual(kollisionenAufloesen([a, { ...a, id: 'z' }]).map((e) => e.y), [0, 4], 'doppelt gelegte Kacheln werden getrennt');
  // Fließ-Anordnung wie das alte Raster
  assert.deepEqual(flussPlatzieren([{ id: 'x', b: 12, h: 4 }, { id: 'y', b: 3, h: 5 }, { id: 'z', b: 9, h: 2 }, { id: 'w', b: 3, h: 3 }]).map((e) => [e.id, e.x, e.y]),
    [['x', 0, 0], ['y', 0, 4], ['z', 3, 4], ['w', 0, 9]]);
  // Einrasten: ab einer halben Zelle, bleibt im Raster; Größe 2–12 bis zum rechten Rand, Höhe 2–40
  const s = { x: 116, y: 56 };
  assert.deepEqual(zellenNachZiehen({ id: 'k', x: 3, y: 2, b: 3, h: 4 }, { dx: 240, dy: 60, schritt: s, art: 'bewegen' }), { id: 'k', x: 5, y: 3, b: 3, h: 4 });
  assert.deepEqual(zellenNachZiehen({ id: 'k', x: 3, y: 2, b: 3, h: 4 }, { dx: 50, dy: -20, schritt: s, art: 'bewegen' }), { id: 'k', x: 3, y: 2, b: 3, h: 4 }, 'unter einer halben Zelle');
  assert.deepEqual(zellenNachZiehen({ id: 'k', x: 3, y: 2, b: 3, h: 4 }, { dx: 5000, dy: -5000, schritt: s, art: 'bewegen' }), { id: 'k', x: 9, y: 0, b: 3, h: 4 }, 'Rand');
  assert.deepEqual(zellenNachZiehen({ id: 'k', x: 8, y: 2, b: 3, h: 4 }, { dx: 5000, dy: 5000, schritt: s, art: 'groesse' }), { id: 'k', x: 8, y: 2, b: 4, h: 40 }, 'Größe bis zum rechten Rand, höchstens 40 Zeilen');
  assert.deepEqual(zellenNachZiehen({ id: 'k', x: 8, y: 2, b: 3, h: 4 }, { dx: -5000, dy: -5000, schritt: s, art: 'groesse' }), { id: 'k', x: 8, y: 2, b: 2, h: 2 }, 'mindestens 2 × 2');
  // alte Pixelhöhen (v3) → Zeilen (40 px + 16 px Abstand): mindestens so hoch wie vorher
  assert.equal(zeilenAusPx(280), 6); assert.equal(zeilenAusPx(600), 11); assert.equal(zeilenAusPx(40), 2);
  assert.deepEqual(lesereihenfolge([{ id: 'u', x: 6, y: 4 }, { id: 'o', x: 9, y: 0 }, { id: 'l', x: 0, y: 4 }]), ['o', 'l', 'u']);
});

test('Raster: altes Layout des Betreibers (v3, Screenshot 09.10.) wird zeilenweise übernommen; neue Kacheln unten, ausgeblendete bleiben weg', () => {
  const ids = ['cpu', 'ram', 'platte', 'netz', 'temperatur', 'system', 'dienste', 'aufgaben', 'ereignisse', 'weltkarte', 'apps', 'laufwerke', 'vms'];
  const alt = { version: 3, kacheln: [
    { id: 'system', breite: 4, hoehe_px: 0 }, { id: 'cpu', breite: 1, hoehe_px: 280 }, { id: 'ram', breite: 1, hoehe_px: 280 }, { id: 'temperatur', breite: 1, hoehe_px: 280 },
    { id: 'netz', breite: 1, hoehe_px: 280 }, { id: 'platte', breite: 1, hoehe_px: 600 }, { id: 'laufwerke', breite: 1, hoehe_px: 600 }, { id: 'apps', breite: 1, hoehe_px: 360 },
    { id: 'vms', breite: 1, hoehe_px: 240 }], ausgeblendet: ['ereignisse'] };
  const w = raster.layoutAufloesen(alt, ids);
  const von = (id) => w.kacheln.find((e) => e.id === id);
  assert.deepEqual(von('system'), { id: 'system', x: 0, y: 0, b: 12, h: 4 });
  assert.deepEqual(['cpu', 'ram', 'temperatur', 'netz'].map((id) => [von(id).x, von(id).y, von(id).b, von(id).h]), [[0, 4, 3, 6], [3, 4, 3, 6], [6, 4, 3, 6], [9, 4, 3, 6]]);
  assert.deepEqual(['platte', 'laufwerke', 'apps', 'vms'].map((id) => [von(id).x, von(id).y, von(id).h]), [[0, 10, 11], [3, 10, 11], [6, 10, 7], [9, 10, 5]]);
  // nicht im Layout: aufgaben, dienste, weltkarte → unten angehängt; ereignisse ausgeblendet
  assert.deepEqual(w.ausgeblendet, ['ereignisse']);
  assert.ok(['dienste', 'aufgaben', 'weltkarte'].every((id) => von(id).y >= 21), 'neue Kacheln unter allem');
  assert.equal(von('weltkarte').b, 12);
  assert.ok(!w.kacheln.some((p, i) => w.kacheln.some((q, j) => i < j && raster.ueberlappt(p, q))));
  // Speicherform v4 → wieder gelesen identisch
  const v4 = raster.layoutSpeicherform(w);
  assert.equal(v4.version, 4);
  assert.deepEqual(raster.layoutAufloesen(v4, ids), w);
  // Standard (kein Layout): Weltkarte volle Breite 12 × 10, alles ohne Überlappung
  const std = raster.layoutAufloesen(null, ids);
  assert.deepEqual(std.kacheln.find((e) => e.id === 'weltkarte'), { id: 'weltkarte', x: 0, y: std.kacheln.find((e) => e.id === 'weltkarte').y, b: 12, h: 10 });
  assert.deepEqual(std.kacheln.find((e) => e.id === 'cpu'), { id: 'cpu', x: 0, y: 0, b: 3, h: 4 });
});

test('Raster: neue Systemübersicht erscheint in einem gespeicherten Layout oben, alles andere rutscht um ihre Höhe nach unten', () => {
  const ids = ['cpu', 'ram', 'systemleiste', 'uhr'];
  const w = raster.layoutAufloesen({ version: 4, kacheln: [{ id: 'cpu', x: 0, y: 0, b: 3, h: 4 }, { id: 'ram', x: 3, y: 0, b: 3, h: 4 }], ausgeblendet: [] }, ids);
  const von = (id) => w.kacheln.find((e) => e.id === id);
  assert.deepEqual(von('systemleiste'), { id: 'systemleiste', x: 0, y: 0, b: 12, h: 3 });
  assert.deepEqual([von('cpu').y, von('ram').y], [3, 3]);
  assert.ok(von('uhr').y >= 7, 'andere neue Kacheln weiter unten');
  // ausgeblendet bleibt ausgeblendet, gespeichert bleibt am Platz
  assert.deepEqual(raster.layoutAufloesen({ version: 4, kacheln: [{ id: 'cpu', x: 0, y: 0, b: 3, h: 4 }], ausgeblendet: ['systemleiste'] }, ids).ausgeblendet, ['systemleiste']);
  assert.deepEqual(raster.layoutAufloesen({ version: 4, kacheln: [{ id: 'systemleiste', x: 0, y: 8, b: 12, h: 3 }], ausgeblendet: [] }, ids).kacheln[0], { id: 'systemleiste', x: 0, y: 8, b: 12, h: 3 });
  // ohne gespeichertes Layout: Standard, Systemübersicht als erste Kachel volle Breite
  assert.deepEqual(raster.layoutAufloesen(null, ['systemleiste', 'cpu']).kacheln, [{ id: 'systemleiste', x: 0, y: 0, b: 12, h: 3 }, { id: 'cpu', x: 0, y: 3, b: 3, h: 4 }]);
});

test('Raster in der Übersicht: Zellen per grid-column/grid-row, DOM in Lesereihenfolge; Anpassen: Kachel anwählbar, „6 × 4 Felder“, ✕ lässt eine Lücke', async () => {
  const uebersicht = { version: 4, kacheln: [{ id: 'ram', x: 6, y: 0, b: 6, h: 4 }, { id: 'cpu', x: 0, y: 0, b: 6, h: 4 }, { id: 'netz', x: 0, y: 4, b: 3, h: 4 }], ausgeblendet: ['systemleiste'] }; // Systemübersicht hier aus (eigener Test)
  const { wurzel, aufrufe } = await einbinden({ uebersicht });
  try {
    const cpu = kachelMitId(wurzel, 'cpu');
    assert.equal(cpu.style.gridColumn, '1 / span 6'); assert.equal(cpu.style.gridRow, '1 / span 4');
    assert.equal(kachelMitId(wurzel, 'ram').style.gridColumn, '7 / span 6');
    const sichtbar = rasterVon(wurzel).children.filter((k) => !k.hidden && k.dataset.kachel).map((k) => k.dataset.kachel);
    assert.deepEqual(sichtbar.slice(0, 3), ['cpu', 'ram', 'netz'], 'Lesereihenfolge im DOM');
    assert.equal(cpu.getAttribute('tabindex'), null, 'außerhalb von „Anpassen“ nicht anwählbar');
    await anpassen(wurzel);
    const k = kachelMitId(wurzel, 'cpu');
    assert.equal(k.getAttribute('tabindex'), '0'); assert.equal(k.getAttribute('aria-describedby'), 'dashboard-tastatur-hilfe');
    assert.ok(k.querySelector('.kachel-kopf').classList.contains('kachel-greifbar'));
    assert.equal(k.querySelector('.kachel-werkzeug-groesse').textContent, 'dashboard.groesse_zellen{"b":6,"h":4}');
    assert.ok(k.querySelector('.kachel-griff-ecke'), 'Ecke zum Größe-Ziehen');
    k.alle().find((x) => x.tagName === 'BUTTON' && x.getAttribute('aria-label') === 'dashboard.ausblenden').ausloesen('click'); await abarbeiten();
    assert.equal(kachelMitId(wurzel, 'cpu').hidden, true);
    assert.equal(zellen(wurzel, 'netz'), '0,4,3,4', 'Lücke bleibt – nichts rutscht hoch');
    await speichernAbwarten();
    const g = gespeicherteLayouts(aufrufe).pop();
    assert.equal(g.version, 4); assert.ok(g.ausgeblendet.includes('cpu'));
    assert.deepEqual(g.kacheln.find((e) => e.id === 'netz'), { id: 'netz', x: 0, y: 4, b: 3, h: 4 });
  } finally { verlassen(wurzel); }
});

test('Raster: Kachel am Kopf ziehen – Schattenrahmen am Ziel, andere rutschen live nach unten, Loslassen speichert; Esc bricht ab', async () => {
  const uebersicht = { version: 4, kacheln: [{ id: 'cpu', x: 0, y: 0, b: 3, h: 4 }, { id: 'ram', x: 3, y: 0, b: 3, h: 4 }, { id: 'netz', x: 6, y: 0, b: 3, h: 4 }], ausgeblendet: ['systemleiste'] }; // Systemübersicht hier aus (eigener Test)
  const { wurzel, aufrufe } = await einbinden({ uebersicht });
  try {
    await mitRasterStil(async () => {
      await anpassen(wurzel);
      // cpu um 3 Spalten nach rechts (348 px = 3 × 116) auf ram
      zeiger(wurzel, kopfVon(wurzel, 'cpu'), 'pointerdown', 100, 100);
      assert.ok(kachelMitId(wurzel, 'cpu').classList.contains('wird-bewegt'));
      zeiger(wurzel, kopfVon(wurzel, 'cpu'), 'pointermove', 448, 100);
      assert.equal(kachelMitId(wurzel, 'cpu').style.transform, 'translate(348px, 0px)', 'Kachel folgt dem Zeiger');
      const ph = rasterVon(wurzel).querySelector('.dashboard-platzhalter');
      assert.ok(ph, 'Schattenrahmen'); assert.equal(ph.style.gridColumn, '4 / span 3'); assert.equal(ph.style.gridRow, '1 / span 4');
      assert.equal(zellen(wurzel, 'ram'), '3,4,3,4', 'ram rutscht live unter das Ziel');
      assert.equal(zellen(wurzel, 'netz'), '6,0,3,4', 'netz bleibt');
      zeiger(wurzel, kopfVon(wurzel, 'cpu'), 'pointerup', 448, 100); await abarbeiten();
      assert.equal(zellen(wurzel, 'cpu'), '3,0,3,4'); assert.equal(zellen(wurzel, 'ram'), '3,4,3,4');
      assert.ok(!rasterVon(wurzel).querySelector('.dashboard-platzhalter'), 'Schattenrahmen weg');
      assert.equal(kachelMitId(wurzel, 'cpu').style.transform, '');
      await speichernAbwarten();
      assert.deepEqual(gespeicherteLayouts(aufrufe).pop().kacheln.find((e) => e.id === 'ram'), { id: 'ram', x: 3, y: 4, b: 3, h: 4 });
      // Esc mitten im Ziehen: alles zurück, nichts gespeichert
      const vorher = gespeicherteLayouts(aufrufe).length;
      zeiger(wurzel, kopfVon(wurzel, 'netz'), 'pointerdown', 700, 100);
      zeiger(wurzel, kopfVon(wurzel, 'netz'), 'pointermove', 400, 100);
      assert.equal(zellen(wurzel, 'cpu'), '3,4,3,4', 'cpu weicht live aus');
      amDokument('keydown', { key: 'Escape' }); await abarbeiten();
      assert.equal(zellen(wurzel, 'netz'), '6,0,3,4'); assert.equal(zellen(wurzel, 'cpu'), '3,0,3,4', 'zurück am Startplatz');
      assert.ok(!kachelMitId(wurzel, 'netz').classList.contains('wird-bewegt'));
      zeiger(wurzel, kopfVon(wurzel, 'netz'), 'pointerup', 400, 100); await speichernAbwarten();
      assert.equal(gespeicherteLayouts(aufrufe).length, vorher, 'nichts gespeichert');
      // fremder Zeiger und Knöpfe im Kopf starten nichts
      zeiger(wurzel, kopfVon(wurzel, 'netz'), 'pointerdown', 700, 100, { button: 2 });
      assert.ok(!kachelMitId(wurzel, 'netz').classList.contains('wird-bewegt'), 'rechte Maustaste');
    });
  } finally { verlassen(wurzel); }
});

test('Raster: Größe an der Ecke ziehen (rastet in Feldern ein, Anzeige „b × h Felder“) und per Tastatur verschieben/ändern, Ansage, Fokus bleibt', async () => {
  const uebersicht = { version: 4, kacheln: [{ id: 'cpu', x: 0, y: 0, b: 3, h: 4 }, { id: 'ram', x: 3, y: 0, b: 3, h: 4 }], ausgeblendet: ['systemleiste'] }; // Systemübersicht hier aus (eigener Test)
  const { wurzel, aufrufe } = await einbinden({ uebersicht });
  try {
    await mitRasterStil(async () => {
      await anpassen(wurzel);
      const ecke = kachelMitId(wurzel, 'cpu').querySelector('.kachel-griff-ecke');
      zeiger(wurzel, ecke, 'pointerdown', 300, 200);
      zeiger(wurzel, ecke, 'pointermove', 300 + 116, 200 + 2 * 56);
      assert.equal(zellen(wurzel, 'cpu'), '0,0,4,6', 'eine Spalte breiter, zwei Zeilen höher');
      assert.equal(zellen(wurzel, 'ram'), '3,6,3,4', 'ram weicht nach unten aus');
      assert.equal(kachelMitId(wurzel, 'cpu').querySelector('.kachel-werkzeug-groesse').textContent, 'dashboard.groesse_zellen{"b":4,"h":6}');
      zeiger(wurzel, ecke, 'pointerup', 416, 312); await abarbeiten();
      assert.equal(zellen(wurzel, 'cpu'), '0,0,4,6');
    });
    // Tastatur an der angewählten Kachel
    const k = kachelMitId(wurzel, 'ram'); k.focus();
    rasterVon(wurzel).ausloesen('keydown', { target: k, key: 'ArrowRight' }); await abarbeiten();
    assert.equal(zellen(wurzel, 'ram'), '4,6,3,4');
    rasterVon(wurzel).ausloesen('keydown', { target: kachelMitId(wurzel, 'ram'), key: 'ArrowUp' }); await abarbeiten();
    assert.equal(zellen(wurzel, 'ram'), '4,5,3,4', 'nach oben – cpu (0–3) liegt nicht im Weg');
    rasterVon(wurzel).ausloesen('keydown', { target: kachelMitId(wurzel, 'ram'), key: 'ArrowDown', shiftKey: true }); await abarbeiten();
    assert.equal(zellen(wurzel, 'ram'), '4,5,3,5', 'Umschalt: eine Zeile höher');
    assert.equal(dokument.activeElement, kachelMitId(wurzel, 'ram'), 'Fokus bleibt an der Kachel');
    const ansage = wurzel.alle().find((x) => x.classList.contains('nur-lesen') && x.getAttribute('aria-live') === 'polite');
    assert.ok(ansage.textContent.startsWith('dashboard.position_ansage') && ansage.textContent.includes('"x":5'), ansage.textContent);
    await speichernAbwarten();
    assert.deepEqual(gespeicherteLayouts(aufrufe).pop().kacheln.find((e) => e.id === 'ram'), { id: 'ram', x: 4, y: 5, b: 3, h: 5 });
  } finally { verlassen(wurzel); }
});

test('Raster: CSS – 12 Spalten ab 900 px, Zeilen 40 px, feste Kachelhöhe mit Rollen, schmal untereinander; Punkte und Schattenrahmen beim Anpassen; Texte', async () => {
  const fsm = await import('node:fs/promises');
  const css = await fsm.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8');
  assert.match(css, /\.dashboard-raster \{[^}]*--dashboard-zeile: 40px[^}]*display: flex; flex-direction: column/);
  assert.match(css, /@media \(min-width: 900px\) \{\s*\.dashboard-raster \{ display: grid; grid-template-columns: repeat\(12, minmax\(0, 1fr\)\); grid-auto-rows: var\(--dashboard-zeile\); \}/);
  assert.match(css, /\.dashboard-raster > \.dashboard-kachel \{ min-height: 0; overflow: auto; \}/);
  assert.match(css, /\.dashboard-platzhalter \{[^}]*dashed/);
  assert.match(css, /\.dashboard-raster\.bearbeiten \{[^}]*radial-gradient/);
  assert.match(css, /\.kachel-griff \{[^}]*touch-action: none/);
  assert.match(css, /\.dashboard-laufwerke \{[^}]*flex-direction: column/, 'Laufwerke in der Karte untereinander');
  assert.doesNotMatch(css, /kachel-b\d|dashboard-breit|kachel-griff-rechts|--dashboard-einheit/, 'alte Spalten-/Zeilenklassen weg');
  const texte = JSON.parse(await fsm.readFile(path.join(PUBLIC, 'sprache', 'de', 'dashboard.json'), 'utf8'));
  for (const k of ['dashboard.groesse_zellen', 'dashboard.kachel_greifen', 'dashboard.kachel_rolle', 'dashboard.tastatur_hilfe', 'dashboard.position_ansage', 'dashboard.groesse_ziehen', 'dashboard.anpassen_hinweis']) assert.ok(texte[k], k);
  for (const k of ['dashboard.hoehe_px', 'dashboard.breite_n', 'dashboard.nach_vorn']) assert.ok(!(k in texte), `${k} weg`);
});

test('Übersicht nutzt die ganze Bildschirmbreite (Betreiber 26.09.: „wieso gehen die Widgets nicht bis zum Bildschirmrand“)', async () => {
  const fsm = await import('node:fs/promises');
  const stil = await fsm.readFile(path.join(PUBLIC, 'stil.css'), 'utf8');
  assert.match(stil, /\.ansicht \{ max-width: 1280px; margin: 0 auto; \}/, 'andere Ansichten bleiben begrenzt');
  const css = await fsm.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8');
  assert.match(css, /\.ansicht\.ansicht-dashboard \{ max-width: none; \}/, 'Übersicht ohne Höchstbreite');
});

// ---------------------------------------------------------------------------------------------------------------------
// Karte und Listen gleich groß (Betreiber 26.09.: „Weltkarte und Verbindungen sollten die gleiche Größe haben – so ist
// die Weltkarte zu klein“): breit teilen sich Karte und Listen die Breite 3 : 1, die Listenspalte ist genau so hoch wie
// die Karte (contain: size), jede Liste zeigt so viele Zeilen, wie hineinpassen – der Rest hinter „+N weitere · alle
// zeigen“ (kein innerer Rollbalken). „Alle zeigen“ hebt die Bindung auf, „Weniger zeigen“ stellt sie wieder her.
// ---------------------------------------------------------------------------------------------------------------------

/** Breite Kachel: die Container-Abfrage setzt --wk-gebunden: 1 an der Listenspalte (hier per getComputedStyle-Attrappe). */
const stilBreit = (breit) => (el) => ({
  ...RASTER,
  getPropertyValue: (n) => (n === '--wk-gebunden' && el && el.classList && el.classList.contains('dashboard-wk-seite') ? (breit ? '1' : '0') : RASTER.getPropertyValue(n)),
});
/** Listen-Unterkanten (px) und Zeilen zu je 40 px: sichtbare Zeile i endet bei 40 · (i + 1). */
function listenMasse(unten) {
  const alt = Proto.getBoundingClientRect;
  const rechteck = (b) => ({ x: 0, y: 0, left: 0, top: 0, width: 250, height: b, right: 250, bottom: b });
  Proto.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('dashboard-wk-liste')) return rechteck(this.classList.contains('dashboard-wk-liste-fern') ? unten.fern : unten.lokal);
    const ul = this.parentNode;
    if (this.tagName === 'LI' && ul && ul.classList && ul.classList.contains('dashboard-wk-liste')) {
      const sichtbar = ul.children.filter((z) => !z.classList.contains('dashboard-wk-weg'));
      const i = sichtbar.indexOf(this);
      return rechteck(i < 0 ? 0 : 40 * (i + 1));
    }
    return alt.call(this);
  };
  return () => { Proto.getBoundingClientRect = alt; };
}
const sichtbareZeilen = (k, art) => liste(k, art).children.filter((z) => !z.classList.contains('dashboard-wk-weg'));
const vieleFern = (n) => Array.from({ length: n }, (_, i) => gegenstelle(`203.0.113.${i + 1}`, ['FAH-NAS'], { ort: ort('NL', 'Niederlande', null, 52.1, 5.3), anzahl: 1000 - i }));
const vieleLokal = (n) => Array.from({ length: n }, (_, i) => ({ name: `app-${i + 1}`, art: 'app', anzahl: 100 - i, bytes: 100 }));

test('Weltkarte breit: Listenspalte bündig mit der Karte – so viele Zeilen, wie hineinpassen, Rest hinter „+N weitere · alle zeigen“', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  const zurueck = listenMasse({ fern: 200, lokal: 100 });
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(30), lokal: vieleLokal(12) }) });
  try {
    const k = kachelVon(wurzel);
    const seite = k.querySelector('.dashboard-wk-seite');
    assert.ok(seite.classList.contains('gebunden'), 'Spalte gebunden');
    assert.equal(liste(k, 'fern').children.length, 30, 'alle 30 vorbereitet (höchstens 60)');
    assert.equal(sichtbareZeilen(k, 'fern').length, 5, '200 px / 40 px = 5 Zeilen');
    assert.equal(sichtbareZeilen(k, 'fern')[0].textContent.includes('203.0.113.1'), true, 'die meisten Verbindungen zuerst');
    const ersteZeile = sichtbareZeilen(k, 'fern')[0];
    assert.equal(ersteZeile.querySelector('.dashboard-wk-ort').title, 'Niederlande', 'voller Ort im Tooltip (einzeilig gekürzt)');
    assert.equal(ersteZeile.querySelector('.dashboard-wk-ip').title, '203.0.113.1');
    assert.equal(lokalKnopf(k, 'app-1').querySelector('.dashboard-wk-lokal-name').title, 'app-1');
    assert.equal(mehrKnopf(k, 'fern').hidden, false);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weitere{"n":25}');
    assert.equal(mehrKnopf(k, 'fern').getAttribute('aria-expanded'), 'false');
    assert.equal(sichtbareZeilen(k, 'lokal').length, 2);
    assert.equal(mehrKnopf(k, 'lokal').textContent, 'dashboard.weltkarte_weitere{"n":10}');

    // „alle zeigen“ hebt die Bindung auf: diese Liste ganz, die andere wie schmal (10 + „Alle 12 zeigen“)
    mehrKnopf(k, 'fern').click();
    assert.ok(!seite.classList.contains('gebunden'), 'Bindung aufgehoben');
    assert.equal(sichtbareZeilen(k, 'fern').length, 30);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weniger');
    assert.equal(mehrKnopf(k, 'fern').getAttribute('aria-expanded'), 'true');
    assert.equal(liste(k, 'lokal').children.length, 10); assert.equal(sichtbareZeilen(k, 'lokal').length, 10);
    assert.equal(mehrKnopf(k, 'lokal').textContent, 'dashboard.weltkarte_alle_zeigen{"n":12}');

    // „Weniger zeigen“ bindet wieder
    mehrKnopf(k, 'fern').click();
    assert.ok(seite.classList.contains('gebunden'));
    assert.equal(sichtbareZeilen(k, 'fern').length, 5);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weitere{"n":25}');
    assert.equal(sichtbareZeilen(k, 'lokal').length, 2);
  } finally { zurueck(); globalThis.getComputedStyle = altStil; verlassen(wurzel); }
});

test('Weltkarte breit: passt alles hinein, gibt es keinen Knopf; mehr als 60 Einträge zählen trotzdem voll mit', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  const zurueck = listenMasse({ fern: 200, lokal: 100 });
  let anzahl = 3;
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(anzahl), lokal: vieleLokal(1) }) });
  try {
    const k = kachelVon(wurzel);
    assert.equal(sichtbareZeilen(k, 'fern').length, 3);
    assert.equal(mehrKnopf(k, 'fern').hidden, true, 'alles passt – kein Knopf');
    assert.equal(mehrKnopf(k, 'lokal').hidden, true);
    // 100 Gegenstellen: 60 vorbereitet, 5 sichtbar → 95 weitere
    anzahl = 100;
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(liste(k, 'fern').children.length, 60);
    assert.equal(sichtbareZeilen(k, 'fern').length, 5);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weitere{"n":95}');
  } finally { zurueck(); globalThis.getComputedStyle = altStil; verlassen(wurzel); }
});

test('Weltkarte breit: wird die Karte höher (Kachel gezogen, Fenster breiter), passt die Spalte sich an (ResizeObserver)', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  const masse = { fern: 200, lokal: 100 };
  const zurueck = listenMasse(masse);
  const altRO = globalThis.ResizeObserver; const ros = [];
  globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; this.ziele = []; ros.push(this); } observe(z) { this.ziele.push(z); } unobserve() {} disconnect() { this.ziele = []; } };
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(30), lokal: vieleLokal(2) }) });
  try {
    const k = kachelVon(wurzel);
    assert.equal(sichtbareZeilen(k, 'fern').length, 5);
    const inhalt = k.querySelector('.dashboard-wk-inhalt');
    const ro = ros.find((r) => r.ziele.includes(inhalt));
    assert.ok(ro, 'Inhalt der Weltkarte wird beobachtet (Breite entscheidet über breit/schmal)');
    masse.fern = 400;
    ro.fn([{ target: inhalt }]);
    await new Promise((r) => setTimeout(r, 30)); await abarbeiten();
    assert.equal(sichtbareZeilen(k, 'fern').length, 10, '400 px / 40 px = 10 Zeilen');
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weitere{"n":20}');
    // schmal geworden (Listen unter der Karte): 10 Einträge, „Alle 30 zeigen“, keine Bindung
    globalThis.getComputedStyle = stilBreit(false);
    ro.fn([{ target: inhalt }]);
    await new Promise((r) => setTimeout(r, 30)); await abarbeiten();
    assert.ok(!k.querySelector('.dashboard-wk-seite').classList.contains('gebunden'));
    assert.equal(liste(k, 'fern').children.length, 10); assert.equal(sichtbareZeilen(k, 'fern').length, 10);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_alle_zeigen{"n":30}');
  } finally { zurueck(); globalThis.getComputedStyle = altStil; globalThis.ResizeObserver = altRO; verlassen(wurzel); }
});

test('Weltkarte breit: CSS – Karte : Listen = 3 : 1, gebundene Spalte ohne Eigenhöhe (contain: size), ausgeblendete Zeilen weg', async () => {
  const css = (await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const breit = /@container \(min-width: 720px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(breit, 'Container-Abfrage fehlt');
  assert.match(breit[1], /\.dashboard-wk-inhalt \{[^}]*grid-template-columns: minmax\(0, 3fr\) minmax\(250px, 1fr\)/);
  assert.match(breit[1], /\.dashboard-wk-seite \{[^}]*--wk-gebunden: 1/);
  assert.match(breit[1], /\.dashboard-wk-seite\.gebunden \{[^}]*contain: size[^}]*align-self: stretch/);
  assert.match(breit[1], /\.dashboard-wk-seite\.gebunden \.dashboard-wk-liste \{[^}]*min-height: 0; overflow: hidden/);
  // Listen oben, Leerraum darunter (Bedienprobe 2560 px: mit 1fr stand „Absender“ ganz unten, dazwischen ein Loch):
  // Gegenstellen natürliche Höhe und schrumpfen allein, Absender/Dienste höchstens 40 % und schrumpfen nie
  assert.match(breit[1], /\.dashboard-wk-seite\.gebunden > \.dashboard-wk-block-fern \{ flex: 0 1 auto; \}/);
  assert.match(breit[1], /\.dashboard-wk-seite\.gebunden > \.dashboard-wk-block-lokal \{ flex: 0 0 auto; max-height: 30%; \}/);
  // kompakt: Ort/IP/Name einzeilig mit Auslassung (voller Text im title), damit neben der Karte Zeilen Platz haben
  assert.match(breit[1], /\.dashboard-wk-seite\.gebunden \.dashboard-wk-ort, \.dashboard-wk-seite\.gebunden \.dashboard-wk-ip,\s*\.dashboard-wk-seite\.gebunden \.dashboard-wk-lokal-name \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(css, /\.dashboard-wk-seite \{[^}]*--wk-gebunden: 0/, 'schmal: nicht gebunden');
  assert.match(css, /\.dashboard-wk-weg \{ display: none !important; \}/);
  const texte = JSON.parse(await fs.readFile(path.join(SPRACHE, 'dashboard.json'), 'utf8'));
  assert.match(texte['dashboard.weltkarte_weitere'], /^\+\{n\} weitere · alle zeigen$/);
});

test('Weltkarte breit (Prüfbericht 26.09.): höchstens 10 Einträge – nach „alle zeigen“ bleibt „Weniger zeigen“, die Bindung lässt sich wiederherstellen', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  const zurueck = listenMasse({ fern: 200, lokal: 100 });
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(8), lokal: vieleLokal(1) }) });
  try {
    const k = kachelVon(wurzel);
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weitere{"n":3}');
    mehrKnopf(k, 'fern').click();
    assert.ok(!k.querySelector('.dashboard-wk-seite').classList.contains('gebunden'));
    assert.equal(sichtbareZeilen(k, 'fern').length, 8);
    assert.equal(mehrKnopf(k, 'fern').hidden, false, '„Weniger zeigen“ bleibt sichtbar');
    assert.equal(mehrKnopf(k, 'fern').textContent, 'dashboard.weltkarte_weniger');
    mehrKnopf(k, 'fern').click();
    assert.ok(k.querySelector('.dashboard-wk-seite').classList.contains('gebunden'), 'wieder gebunden');
  } finally { zurueck(); globalThis.getComputedStyle = altStil; verlassen(wurzel); }
});

test('Weltkarte breit (Prüfbericht 26.09.): Karten-Modul fehlt → keine Bindung an den 180-px-Platzhalter', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  kartenLaderFehler = new Error('weltkarte.js fehlt');
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(30), lokal: vieleLokal(3) }) });
  try {
    const k = kachelVon(wurzel);
    await abarbeiten();
    assert.ok(!k.querySelector('.dashboard-wk-seite').classList.contains('gebunden'));
    assert.equal(sichtbareZeilen(k, 'fern').length, 10, 'wie schmal: 10 + „alle zeigen“');
  } finally { kartenLaderFehler = null; globalThis.getComputedStyle = altStil; verlassen(wurzel); }
});

test('Weltkarte (Prüfbericht 26.09.): der aktive Filter steht oben (nie ausgeblendet); fällt ein fokussierter Knopf heraus, geht der Fokus an „+N weitere“', async () => {
  const altStil = globalThis.getComputedStyle; globalThis.getComputedStyle = stilBreit(true);
  const zurueck = listenMasse({ fern: 200, lokal: 100 });
  let lokal = vieleLokal(12);
  const { wurzel } = await einbinden({ antworten: (p) => ergebnis(p.richtung, { gegenstellen: vieleFern(5), lokal }) });
  try {
    const k = kachelVon(wurzel);
    mehrKnopf(k, 'lokal').click();                 // aufklappen, app-12 als Filter wählen, wieder zuklappen
    lokalKnopf(k, 'app-12').click();
    mehrKnopf(k, 'lokal').click();
    assert.ok(k.querySelector('.dashboard-wk-seite').classList.contains('gebunden'));
    assert.equal(sichtbareZeilen(k, 'lokal')[0].querySelector('.dashboard-wk-lokal').dataset.name, 'app-12', 'aktiver Filter oben und sichtbar');
    assert.equal(lokalKnopf(k, 'app-12').getAttribute('aria-pressed'), 'true');
    lokalKnopf(k, 'app-12').click();               // Filter aus
    // Fokus auf app-2 (sichtbar), beim nächsten Abgleich rutscht app-2 ans Ende → ausgeblendet → Fokus an den Knopf
    lokalKnopf(k, 'app-2').focus();
    lokal = [...vieleLokal(12)].map((l) => (l.name === 'app-2' ? { ...l, anzahl: 0 } : l));
    mock.timers.tick(5000); await abarbeiten();
    assert.ok(lokalKnopf(k, 'app-2').parentNode.classList.contains('dashboard-wk-weg'), 'app-2 ausgeblendet');
    assert.equal(dokument.activeElement, mehrKnopf(k, 'lokal'), 'Fokus auf „+N weitere“');
  } finally { zurueck(); globalThis.getComputedStyle = altStil; verlassen(wurzel); }
});

test('Router-Wettlauf nach der Anmeldung (Bedienprobe 26.09.): zweimal eingebunden ohne verlassen, erste Antwort verspätet → Weltkarte lädt trotzdem', async () => {
  let freigeben = null;
  const erste = await einbinden({ antworten: (p) => new Promise((ok) => { freigeben = () => ok(ergebnis(p.richtung)); }) });
  assert.ok(freigeben, 'erste Abfrage läuft noch');
  const zweite = await einbinden();                       // ohne verlassen – wie zwei gleichzeitige route()-Aufrufe
  try {
    freigeben(); await abarbeiten();                     // verspätete Antwort der ersten Einbindung
    mock.timers.tick(5000); await abarbeiten();          // nächster Takt
    const k = kachelVon(zweite.wurzel);
    assert.deepEqual(ipsIn(k).sort(), ['192.168.1.1', '140.82.121.4', '151.101.1.69', '9.9.9.9'], 'Daten angekommen, nicht „Wird geladen“');
    const n = verbindungsAufrufe(zweite.aufrufe).length;
    mock.timers.tick(5000); await abarbeiten();
    assert.equal(verbindungsAufrufe(zweite.aufrufe).length, n + 1, 'genau ein Takt (kein doppelter Timer der ersten Einbindung)');
  } finally { verlassen(zweite.wurzel); erste.wurzel.remove(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Übersicht: externe Laufwerke in EINER Karte (Betreiber 09.10.: „in einer Dashboard-Karte wäre schöner und aufgeräumter“)
// ---------------------------------------------------------------------------------------------------------------------

test('Übersicht: Karte „Externe Laufwerke“ listet jedes eingehängte Laufwerk mit Belegung und folgt dem An- und Abstecken selbst', async () => {
  let geraete = [
    { pfad: '/dev/sda4', kennung: 'uuid:daten', name: null, system: true, eingehaengt: true, belegt: 4e10, frei: 1.4e11 },
    { pfad: '/dev/sdb1', kennung: 'uuid:A', name: 'ventoy', label: 'Ventoy', system: false, eingehaengt: true, belegt: 24e9, frei: 8e9, groesse: 32e9 },
    { pfad: '/dev/sdb2', kennung: 'uuid:B', name: null, label: 'VTOYEFI', system: false, eingehaengt: false, belegt: null, frei: null, groesse: 3e7 },
    { pfad: '/dev/sdd3', kennung: 'uuid:C', name: '1500gb', system: false, eingehaengt: true, belegt: 152e10, frei: 8e10 },
  ];
  const { wurzel } = await einbinden({ laufwerke: () => ({ geraete }) });
  try {
    const raster = wurzel.querySelector('.dashboard-raster');
    assert.ok(!raster.children.some((k) => String(k.dataset.kachel).startsWith('laufwerk:')), 'keine eigene Kachel je Laufwerk');
    const karte = raster.children.find((k) => k.dataset.kachel === 'laufwerke');
    assert.equal(karte.querySelector('.kachel-titel').textContent, 'dashboard.laufwerke');
    const zeilen = () => karte.querySelectorAll('.dashboard-laufwerk');
    assert.deepEqual(zeilen().map((z) => z.dataset.laufwerk), ['uuid:A', 'uuid:C'], 'nur eingehängte externe Laufwerke, keine Systempartition');
    const [ventoy, gross] = zeilen();
    assert.equal(ventoy.querySelector('.dashboard-laufwerk-name').textContent, 'ventoy');
    assert.equal(ventoy.querySelector('.dashboard-laufwerk-prozent').textContent, '75 %');
    assert.equal(ventoy.querySelector('.fortschritt').getAttribute('aria-valuenow'), '75');
    assert.match(ventoy.querySelector('.dashboard-laufwerk-neben').textContent, /^dashboard\.frei_von\{/);
    assert.equal(gross.querySelector('.dashboard-laufwerk-prozent').textContent, '95 %');
    assert.ok(gross.querySelector('.fortschritt').classList.contains('gefahr'), 'volles Laufwerk rot');
    assert.ok(karte.classList.contains('gefahr'), 'die Karte färbt sich nach dem vollsten Laufwerk');
    // Abstecken: beim nächsten Abgleich (30 s) verschwindet die Zeile, die Karte bleibt
    geraete = geraete.filter((g) => g.kennung !== 'uuid:C');
    mock.timers.tick(30_000); await abarbeiten();
    assert.deepEqual(zeilen().map((z) => z.dataset.laufwerk), ['uuid:A']);
    assert.ok(!karte.classList.contains('gefahr'));
    // Alles abgesteckt: Liste ausgeblendet, Hinweistext
    geraete = geraete.filter((g) => g.system);
    mock.timers.tick(30_000); await abarbeiten();
    assert.equal(zeilen().length, 0);
    assert.equal(karte.querySelector('.dashboard-laufwerke').hidden, true);
    assert.equal(karte.querySelector('.kachel-neben').textContent, 'dashboard.laufwerke_keine');
  } finally { verlassen(wurzel); }
});

test('Übersicht: „Interne Festplatte“ ist EINE Karte mit Gesamtbelegung, System- und Datenteil; altes Layout (System-/Datenplatte) wird übernommen', async () => {
  const GiB = 1024 ** 3;
  const status = { platten: [{ pfad: '/', name: 'system', gesamt: 48 * GiB, frei: 36 * GiB }, { pfad: '/data', name: 'daten', gesamt: 180 * GiB, frei: 9 * GiB }] };
  // gespeichert wie beim Betreiber: System oben, CPU, RAM, Systemplatte, Datenplatte, Netz … (Datenplatte schmal, Systemplatte breit 2)
  const uebersicht = { version: 3, kacheln: [{ id: 'system', breite: 4 }, { id: 'cpu', breite: 1 }, { id: 'ram', breite: 1 }, { id: 'systemplatte', breite: 2, hoehe_px: 0 }, { id: 'datenplatte', breite: 1 }, { id: 'netz', breite: 1 }], ausgeblendet: ['systemleiste'] }; // Systemübersicht hier aus (eigener Test)
  const { wurzel } = await einbinden({ uebersicht, status });
  try {
    const raster = wurzel.querySelector('.dashboard-raster');
    const sichtbar = raster.children.filter((k) => !k.hidden).map((k) => k.dataset.kachel);
    assert.ok(!sichtbar.includes('systemplatte') && !sichtbar.includes('datenplatte'), 'keine getrennten Kacheln mehr');
    assert.deepEqual(sichtbar.slice(0, 5), ['system', 'cpu', 'ram', 'platte', 'netz'], 'Karte sitzt am Platz der Systemplatte');
    const karte = raster.children.find((k) => k.dataset.kachel === 'platte');
    assert.ok(karte.style.gridColumn.endsWith('span 6'), 'Breite der Systemplatte übernommen (2 von 4 → 6 von 12)');
    assert.equal(karte.querySelector('.kachel-titel').textContent, 'dashboard.platte');
    assert.equal(karte.querySelector('.kachel-wert').textContent, '80 %', '(12 + 171) von 228 GiB belegt');
    const teile = karte.querySelectorAll('.dashboard-laufwerk');
    assert.deepEqual(teile.map((z) => z.dataset.teil), ['system', 'daten']);
    assert.equal(teile[0].querySelector('.dashboard-laufwerk-prozent').textContent, '25 %');
    assert.equal(teile[1].querySelector('.dashboard-laufwerk-prozent').textContent, '95 %');
    assert.ok(teile[1].querySelector('.fortschritt').classList.contains('gefahr'));
    assert.ok(karte.classList.contains('gefahr'), 'die Karte färbt sich nach der volleren Partition');
  } finally { verlassen(wurzel); }
  // reine Umsetzung: beide ausgeblendet → Karte ausgeblendet; eine sichtbar → Karte sichtbar
  assert.deepEqual(dashModul.layoutMigrieren({ version: 3, kacheln: [{ id: 'cpu', breite: 1 }], ausgeblendet: ['systemplatte', 'datenplatte'] }).ausgeblendet, ['platte']);
  const m = dashModul.layoutMigrieren({ version: 3, kacheln: [{ id: 'datenplatte', breite: 3 }], ausgeblendet: ['systemplatte'] });
  assert.deepEqual(m, { version: 3, kacheln: [{ id: 'platte', breite: 3 }], ausgeblendet: [] });
});
