// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Weltkarten-Modul public/ansichten/weltkarte.js ohne Browser: Projektion (Natural Earth I), Dekodierung von
// welt.json (§4.4), Rendern gegen eine DOM-Attrappe (Bögen, Punkte, Standort mit Heimnetz-Zahl, Hinweise), Filter,
// Flüge nur ohne reduzierte Bewegung, Leistungsgrenzen (12 fließende Bögen, 8 Pulse, 12 Flüge je Aktualisierung,
// keine Dauer-rAF-Schleife, Pause außerhalb des Bildschirms/bei verstecktem Tab), Zoom am Zeiger, Tooltip,
// Sprachschlüssel, Stile (nur Farbvariablen → hell und dunkel), Quelltext-Verbote (CSP) und – sobald Task 3 sie
// geliefert hat – die echte public/karte/welt.json (gültig, ≤ 400 KB).

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HIER, '..', '..', 'public');
const QUELLE = path.join(PUBLIC, 'ansichten', 'weltkarte.js');

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe (wie ui_upload_tafel.test.js, ergänzt um Ereignis-Aufstieg, SVG-Pfadmessung, Maße, rAF-Warteschlange,
// IntersectionObserver und steuerbares matchMedia)
// ---------------------------------------------------------------------------------------------------------------------

let dokument = null;
class Knoten {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get isConnected() { let k = this; while (k) { if (k === dokument.body) return true; k = k.parentNode; } return false; }
}
class TextKnoten extends Knoten { constructor(t) { super(); this.nodeType = 3; this.textContent = String(t); } }
class Element extends Knoten {
  constructor(tag, ns) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.namespaceURI = ns || null; this.attribute = new Map(); this.dataset = {}; this.hoerer = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
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
  get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { for (const k of this.childNodes) k.parentNode = null; this.childNodes = v === '' ? [] : [new TextKnoten(v)]; }
  appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; this.childNodes.push(k); return k; }
  insertBefore(k, ref) {
    if (k.parentNode) k.parentNode.removeChild(k);
    k.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(k); else this.childNodes.splice(i, 0, k);
    return k;
  }
  removeChild(k) { this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  hasAttribute(k) { return this.attribute.has(k); }
  removeAttribute(k) { this.attribute.delete(k); }
  addEventListener(art, fn, opt) { (this.hoerer[art] ||= []).push({ fn, opt }); }
  removeEventListener(art, fn) { this.hoerer[art] = (this.hoerer[art] || []).filter((h) => h.fn !== fn); }
  /** Ereignis auslösen; steigt wie im Browser zu den Eltern auf. Liefert das Ereignis (defaultPrevented prüfbar). */
  ausloesen(art, ev = {}) {
    const e = { type: art, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    for (let k = this; k; k = k.parentNode) for (const h of [...(k.hoerer?.[art] || [])]) h.fn.call(k, e);
    return e;
  }
  click() { return this.ausloesen('click'); }
  alle() { const aus = []; for (const k of this.children) { aus.push(k, ...k.alle()); } return aus; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { const kl = s.startsWith('.') ? s.slice(1).split('.') : null; return kl ? this.alle().filter((k) => kl.every((c) => k.classList.contains(c))) : this.alle().filter((k) => k.tagName === s.toUpperCase()); }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 }; }
  getTotalLength() { return 100; }
  getPointAtLength() { return { x: 0, y: 0 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const dokHoerer = {};
let bewegungAus = false;
const rafWarteschlange = new Map();
let rafNummer = 0;
let rafZeit = 1000;
const io = [];

function dom() {
  dokument = {
    documentElement: new Element('html'), body: new Element('body'), head: new Element('head'), cookie: '', title: '', hidden: false,
    createElement: (t) => new Element(t), createElementNS: (ns, t) => new Element(t, ns), createTextNode: (t) => new TextKnoten(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(art, fn) { (dokHoerer[art] ||= []).push(fn); },
    removeEventListener(art, fn) { dokHoerer[art] = (dokHoerer[art] || []).filter((f) => f !== fn); },
  };
  dokument.documentElement.appendChild(dokument.body);
  globalThis.Node = Knoten;
  globalThis.HTMLFormElement = class {};
  globalThis.document = dokument;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', href: 'http://nas.local/', origin: 'http://nas.local', replace() {} };
  const speicher = new Map();
  globalThis.localStorage = { getItem: (k) => (speicher.has(k) ? speicher.get(k) : null), setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
  globalThis.matchMedia = (q) => ({ matches: /reduced-motion/.test(q) ? bewegungAus : false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => { rafWarteschlange.set(++rafNummer, fn); return rafNummer; };
  globalThis.cancelAnimationFrame = (id) => { rafWarteschlange.delete(id); };
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.ziele = []; this.getrennt = false; io.push(this); }
    observe(z) { this.ziele.push(z); }
    unobserve() {}
    disconnect() { this.getrennt = true; }
  };
  return dokument;
}

/** Ein Bild (Frame) weiterschalten: alle wartenden rAF-Rückrufe mit fortlaufender Zeit ausführen. */
function bild(ms = 16) { rafZeit += ms; const f = [...rafWarteschlange.values()]; rafWarteschlange.clear(); for (const fn of f) fn(rafZeit); }
/** Bilder abspielen, bis keine rAF-Rückrufe mehr warten (höchstens `max`). */
function bilderBisRuhe(max = 2000) { let n = 0; while (rafWarteschlange.size && n < max) { bild(); n++; } return n; }
/** Sichtbarkeit der Karte im Bildschirm melden (IntersectionObserver-Attrappe). */
function imBild(sichtbar) { for (const b of io) if (!b.getrennt) b.cb(b.ziele.map((z) => ({ target: z, isIntersecting: sichtbar }))); }
function tabVersteckt(versteckt) { dokument.hidden = versteckt; for (const fn of [...(dokHoerer.visibilitychange || [])]) fn({ type: 'visibilitychange' }); }

const abarbeiten = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------------------------------------------------
// Testdaten: kleine Welt (Format §4.4) und Ergebnisse (Form §4.6)
// ---------------------------------------------------------------------------------------------------------------------

const WELT = {
  v: 1, quelle: 'Test', q: 100,
  laender: [
    { iso: 'DE', name: 'Deutschland', p: [1040, 5120], r: [[600, 4750, 900, 0, 0, 700, -900, 0]] },
    { iso: 'US', name: 'Vereinigte Staaten', p: [-9800, 3900], r: [[-12400, 2500, 5700, 0, 0, 2400, -5700, 0], [-10000, 3000, 100, 0, 0, 100, -100, 0]] },
  ],
};

const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MV = { land: 'US', land_name: 'Vereinigte Staaten', stadt: 'Mountain View', lat: 37.4, lon: -122.1, genau: 'stadt' };
const FFM = { land: 'DE', land_name: 'Deutschland', stadt: 'Frankfurt am Main', lat: 50.11, lon: 8.68, genau: 'stadt' };

/** Gegenstelle: `vor` = wie lange vor T0 zuletzt gesehen (negativ = danach), lokal = [[name, art, anzahl], …]. */
function gs(ip, ort, { anzahl = 1, bytes = 1000, vor = 30_000, lokal = [['FAH-NAS', 'host', 1]], privat = false, anycast = false } = {}) {
  return { ip, privat, anycast, ort, anzahl, bytes, erst: iso(T0 - Math.max(vor, 0) - 60_000), zuletzt: iso(T0 - vor), lokal: lokal.map(([name, art, n]) => ({ name, art, anzahl: n })) };
}
function ergebnis(gegenstellen, mehr = {}) {
  return {
    richtung: 'aus', zeit: iso(T0), fenster_s: 3600, aufzeichnung: true, werkzeug: { ok: true, hinweis: null },
    geo: { quelle: 'stadt', stand: '2026-09', hinweis: null }, heimat: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' },
    summe: { anzahl: gegenstellen.reduce((s, g) => s + g.anzahl, 0), bytes: 0, gegenstellen: gegenstellen.length },
    gegenstellen, lokal: [], ...mehr,
  };
}
/** Grundfall aus dem Plan: 3 Gegenstellen, zwei davon an einem Ort (Mountain View), eine privat. */
const DREI = () => [
  gs('142.250.1.1', MV, { anzahl: 3, bytes: 5000, lokal: [['FAH-NAS', 'host', 2], ['it-tools', 'app', 1]] }),
  gs('142.250.1.2', MV, { anzahl: 1, bytes: 800 }),
  gs('192.168.1.1', null, { privat: true, anzahl: 2 }),
];

// ---------------------------------------------------------------------------------------------------------------------
// Modul laden (nach der DOM-Attrappe, wie im Browser eine Instanz)
// ---------------------------------------------------------------------------------------------------------------------

dom();
mock.timers.enable({ apis: ['setTimeout'] });
const t = (k, p) => (p ? `${k}${JSON.stringify(p)}` : k);
(await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href))._test.setzeT(t);
const wk = await import(pathToFileURL(QUELLE).href);

const offen = [];
/** Karte in einem frischen Behälter anlegen und die Welt laden lassen. */
async function karte(optionen = {}) {
  const behaelter = dokument.createElement('div');
  dokument.body.appendChild(behaelter);
  const k = wk.erzeugeWeltkarte(behaelter, { t, bewegungReduziert: false, holeWelt: async () => WELT, ...optionen });
  offen.push(k);
  await abarbeiten();
  return { behaelter, k, wurzel: behaelter.firstElementChild };
}
/** Nach jedem Test: Karten abbauen, Zeitgeber und rAF leeren, Zustand der Attrappe zurücksetzen. */
function aufraeumen() {
  for (const k of offen.splice(0)) k.zerstoeren();
  mock.timers.tick(60_000);
  rafWarteschlange.clear();
  bewegungAus = false; dokument.hidden = false;
}
afterEach(aufraeumen);

const zahl = (w, s) => w.querySelectorAll(s).length;
const massstab = (w) => { const m = /scale\(([\d.]+)\)/.exec(w.querySelector('.wk-welt').getAttribute('transform') || ''); return m ? Number(m[1]) : 1; };
const hinweise = (w) => w.querySelectorAll('.wk-hinweis').map((h) => h.textContent);

// ---------------------------------------------------------------------------------------------------------------------
// Reine Funktionen
// ---------------------------------------------------------------------------------------------------------------------

test('projektion: Natural Earth I an bekannten Punkten, Norden positiv, symmetrisch', () => {
  const [x0, y0] = wk.projektion(0, 0);
  assert.ok(Math.abs(x0) < 1e-9 && Math.abs(y0) < 1e-9, 'Ursprung');
  assert.ok(Math.abs(wk.projektion(180, 0)[0] - 2.7361) < 0.001, `x(180°) = ${wk.projektion(180, 0)[0]}`);
  assert.ok(Math.abs(wk.projektion(0, 90)[1] - 1.4217) < 0.001, `y(90°) = ${wk.projektion(0, 90)[1]}`);
  assert.ok(wk.projektion(0, 45)[1] > 0 && wk.projektion(0, -45)[1] < 0, 'Norden positiv');
  const [xa, ya] = wk.projektion(-120, -30); const [xb, yb] = wk.projektion(120, 30);
  assert.ok(Math.abs(xa + xb) < 1e-12 && Math.abs(ya + yb) < 1e-12, 'punktsymmetrisch');
  assert.ok(wk.projektion(180, 60)[0] < wk.projektion(180, 0)[0], 'Meridiane laufen zu den Polen zusammen');
});

test('dekodiereWelt: kehrt die Differenzkodierung um, Punkt in Grad, mehrere Ringe', () => {
  const welt = wk.dekodiereWelt({ v: 1, q: 100, laender: [{ iso: 'XX', name: 'Testland', p: [1040, 5120], r: [[1000, 5000, 10, 0, 0, 10, -10, 0], [0, 0, 5, 0, 0, 5, -5, 0]] }] });
  assert.equal(welt.length, 1);
  assert.equal(welt[0].iso, 'XX'); assert.equal(welt[0].name, 'Testland');
  assert.deepEqual(welt[0].p, [10.4, 51.2]);
  assert.deepEqual(welt[0].ringe[0], [[10, 50], [10.1, 50], [10.1, 50.1], [10, 50.1]]);
  assert.deepEqual(welt[0].ringe[1], [[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05]]);
  // q fehlt → 100; kaputte Ringe (ungerade Länge, < 3 Punkte) fallen weg statt die Karte zu sprengen
  const w2 = wk.dekodiereWelt({ laender: [{ iso: 'YY', name: 'Y', p: [0, 0], r: [[1, 2, 3], [0, 0, 1, 1], [0, 0, 100, 0, 0, 100]] }] });
  assert.equal(w2[0].ringe.length, 1);
  assert.throws(() => wk.dekodiereWelt(null), /Karte/);
  assert.throws(() => wk.dekodiereWelt({ laender: 'x' }), /Karte/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------------------------------------------------

test('Aufbau: Wurzel .wk mit SVG (viewBox 1000 × H), Gradnetz, Ländern, Ticker (aria-live off), Zoomknöpfen, Tooltip', async () => {
  const { wurzel } = await karte();
  assert.ok(wurzel.classList.contains('wk'));
  const svg = wurzel.querySelector('.wk-svg');
  assert.ok(svg && svg.tagName === 'SVG');
  const [, , b, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  assert.equal(b, 1000); assert.ok(h > 380 && h < 480, `Höhe ${h}`);
  assert.equal(svg.getAttribute('role'), 'img'); assert.equal(svg.getAttribute('aria-label'), 'dashboard.karte_titel');
  assert.equal(zahl(wurzel, '.wk-land'), 2, 'zwei Länder');
  const de = wurzel.querySelectorAll('.wk-land').find((l) => l.getAttribute('data-iso') === 'DE');
  assert.match(de.getAttribute('d'), /^M[\d.]+,[\d.]+L.*Z$/);
  assert.ok(wurzel.querySelector('.wk-gradnetz').getAttribute('d').length > 100, 'Gradnetz gezeichnet');
  assert.equal(wurzel.querySelector('.wk-laender').getAttribute('fill-rule'), 'evenodd');
  // Ticker rein visuell (die Listen der Kachel tragen dieselbe Information) – keine Daueransagen alle paar Sekunden
  const ticker = wurzel.querySelector('.wk-ticker');
  assert.equal(ticker.getAttribute('aria-live'), 'off');
  assert.equal(ticker.getAttribute('role'), 'log', 'mit Rolle, damit das aria-label erlaubt ist');
  assert.equal(ticker.getAttribute('aria-label'), 'dashboard.karte_neu');
  const knoepfe = wurzel.querySelector('.wk-zoom').children;
  assert.deepEqual(knoepfe.map((k) => k.getAttribute('aria-label')), ['dashboard.karte_zoom_rein', 'dashboard.karte_zoom_raus', 'dashboard.karte_zoom_zurueck']);
  assert.equal(wurzel.querySelector('.wk-tip').hidden, true);
  assert.equal(zahl(wurzel, '.wk-laden'), 0, 'Ladehinweis nach dem Laden weg');
  assert.deepEqual(hinweise(wurzel), [], 'ohne Daten noch kein Hinweis');
});

test('setzeDaten: 3 Gegenstellen (2 an einem Ort, 1 privat) → 1 Bogen, 1 Punkt, Standort mit Heimnetz-Zahl 1, aktives Land', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  assert.equal(zahl(wurzel, '.wk-bogen'), 1);
  assert.equal(zahl(wurzel, '.wk-punkt'), 1);
  const heim = wurzel.querySelector('.wk-heim');
  assert.ok(heim, 'Standortmarke');
  assert.equal(heim.querySelector('.wk-heim-zahl').textContent, '1');
  // Zahl steht unter der Standortmarke (links oben liegt bei einem NAS in Mitteleuropa meist Frankfurt/Amsterdam)
  assert.ok(Number(heim.querySelector('.wk-heim-zahl').getAttribute('y')) > Number(heim.querySelector('.wk-heim-punkt').getAttribute('cy')) + 5);
  assert.ok(Math.abs(Number(heim.querySelector('.wk-heim-zahl').getAttribute('x')) - Number(heim.querySelector('.wk-heim-punkt').getAttribute('cx'))) < 0.06, 'mittig');
  const punkt = wurzel.querySelector('.wk-punkt');
  // r = 3 + min(9, √n·1,6) bei Maßstab 1 (n = 4 Verbindungen)
  assert.ok(Math.abs(Number(punkt.getAttribute('r')) - (3 + Math.sqrt(4) * 1.6)) < 0.01);
  // Bogen: quadratische Bézier Standort → Ort, Kontrollpunkt über der Mitte (kleineres y)
  const d = wurzel.querySelector('.wk-bogen').getAttribute('d');
  const m = /^M([\d.-]+),([\d.-]+) Q([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)$/.exec(d);
  assert.ok(m, d);
  const [x1, y1, cx, cy, x2, y2] = m.slice(1).map(Number);
  const hp = heim.querySelector('.wk-heim-punkt');
  assert.ok(Math.abs(x1 - Number(hp.getAttribute('cx'))) < 0.11 && Math.abs(y1 - Number(hp.getAttribute('cy'))) < 0.11, 'Bogen beginnt am Standort');
  assert.ok(Math.abs(x2 - Number(punkt.getAttribute('cx'))) < 0.11, 'Bogen endet am Ort');
  assert.ok(Math.abs(cx - (x1 + x2) / 2) < 0.11, 'Kontrollpunkt mittig');
  const laenge = Math.hypot(x2 - x1, y2 - y1);
  assert.ok(Math.abs(cy - ((y1 + y2) / 2 - laenge * 0.25)) < 0.2, 'Kontrollpunkt 25 % der Strecke über der Mitte');
  const us = wurzel.querySelectorAll('.wk-land').find((l) => l.getAttribute('data-iso') === 'US');
  const de = wurzel.querySelectorAll('.wk-land').find((l) => l.getAttribute('data-iso') === 'DE');
  assert.ok(us.classList.contains('aktiv') && !de.classList.contains('aktiv'), 'nur das Land mit Verbindungen ist aktiv');
  assert.ok(Number(us.getAttribute('fill-opacity')) > 0);
  assert.deepEqual(hinweise(wurzel), [], 'alles vorhanden → kein Hinweis');
  // Namen: Standortname und Ortsname mit Kollisionsprüfung
  const namen = wurzel.querySelectorAll('.wk-name').map((n) => n.textContent);
  assert.ok(namen.includes('Sandelzhausen') && namen.includes('Mountain View'), namen.join(', '));
  // Wiederholter Aufruf mit denselben Daten ändert die Zahl der Elemente nicht (Wiederverwendung statt Neuaufbau)
  const alterPunkt = wurzel.querySelector('.wk-punkt');
  k.setzeDaten(ergebnis(DREI()));
  assert.equal(zahl(wurzel, '.wk-punkt'), 1); assert.equal(wurzel.querySelector('.wk-punkt'), alterPunkt, 'Punkt wiederverwendet');
});

test('Hinweise: kein Standort, Aufzeichnung aus, Werkzeug fehlt, keine Ortsdaten, leer – keine Ausnahme bei Unsinn', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI(), { heimat: null }));
  assert.equal(zahl(wurzel, '.wk-bogen'), 0, 'ohne Standort keine Bögen');
  assert.equal(zahl(wurzel, '.wk-punkt'), 1, 'Punkte bleiben');
  assert.equal(zahl(wurzel, '.wk-heim'), 0);
  assert.ok(hinweise(wurzel).some((h) => h.startsWith('dashboard.karte_kein_standort')), hinweise(wurzel).join(' | '));
  k.setzeDaten(ergebnis([], { aufzeichnung: false }));
  assert.deepEqual(hinweise(wurzel), ['dashboard.karte_aus']);
  assert.equal(zahl(wurzel, '.wk-punkt') + zahl(wurzel, '.wk-bogen'), 0);
  k.setzeDaten(ergebnis(DREI(), { werkzeug: { ok: false, hinweis: 'conntrack wird gerade installiert …' } }));
  assert.ok(hinweise(wurzel).includes('conntrack wird gerade installiert …'), hinweise(wurzel).join(' | '));
  k.setzeDaten(ergebnis([], { werkzeug: { ok: false, hinweis: null } }));
  assert.ok(hinweise(wurzel).includes('dashboard.karte_werkzeug'));
  // Werkzeug läuft, meldet aber etwas (Tabelle gekürzt, eine Familie nicht lesbar): Hinweis auch bei ok:true – als Info
  const gekuerzt = 'Verbindungstabelle sehr groß – nur die ersten 30 000 Einträge ausgewertet';
  k.setzeDaten(ergebnis(DREI(), { werkzeug: { ok: true, hinweis: gekuerzt, gekuerzt: true } }));
  assert.deepEqual(hinweise(wurzel), [gekuerzt]);
  assert.ok(wurzel.querySelector('.wk-hinweis').classList.contains('wk-hinweis-info'), 'Info, keine Warnung');
  k.setzeDaten(ergebnis([], { werkzeug: { ok: true, hinweis: 'IPv6-Verbindungen gerade nicht lesbar.' } }));
  assert.deepEqual(hinweise(wurzel), ['IPv6-Verbindungen gerade nicht lesbar.'], 'Hinweis ersetzt „leer“ (die Leere kann am Hinweis liegen)');
  k.setzeDaten(ergebnis([gs('142.250.1.1', null)], { geo: { quelle: 'keine', stand: null, hinweis: 'x' } }));
  assert.ok(hinweise(wurzel).includes('dashboard.karte_keine_ortsdaten'));
  k.setzeDaten(ergebnis([]));
  assert.deepEqual(hinweise(wurzel), ['dashboard.karte_leer']);
  for (const unsinn of [null, undefined, 'x', 42, { gegenstellen: 'nein' }, { gegenstellen: [null, { ip: 1, ort: { lat: 'a' } }] }]) {
    assert.doesNotThrow(() => k.setzeDaten(unsinn), `setzeDaten(${JSON.stringify(unsinn)})`);
  }
  // Anycast/ohne Ort: nicht auf der Karte, aber in der Legende gezählt
  k.setzeDaten(ergebnis([gs('1.1.1.1', null, { anycast: true }), gs('142.250.1.1', MV)]));
  assert.equal(zahl(wurzel, '.wk-punkt'), 1);
  assert.ok(wurzel.querySelector('.wk-legende').textContent.includes('dashboard.karte_ohne_ort{"n":1}'));
});

test('Kartendaten nicht ladbar → Hinweis, Punkte trotzdem; Daten vor dem Laden werden danach gezeichnet', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const { wurzel, k } = await karte({ holeWelt: async () => { throw new Error('404'); } });
    k.setzeDaten(ergebnis(DREI()));
    assert.ok(hinweise(wurzel).includes('dashboard.karte_fehler_karte'));
    assert.equal(zahl(wurzel, '.wk-land'), 0);
    assert.equal(zahl(wurzel, '.wk-punkt'), 1, 'Punkte und Bögen auch ohne Umrisse');
    assert.equal(zahl(wurzel, '.wk-laden'), 0);
  } finally { console.warn = warn; }
  let freigeben;
  const { wurzel, k } = await karte({ holeWelt: () => new Promise((ok) => { freigeben = ok; }) });
  assert.equal(zahl(wurzel, '.wk-laden'), 1, 'Ladehinweis');
  assert.equal(wurzel.querySelector('.wk-laden').textContent, 'dashboard.karte_laden');
  k.setzeDaten(ergebnis(DREI()));
  freigeben(WELT); await abarbeiten();
  assert.equal(zahl(wurzel, '.wk-laden'), 0);
  assert.equal(zahl(wurzel, '.wk-land'), 2);
  assert.equal(zahl(wurzel, '.wk-punkt'), 1);
  assert.equal(zahl(wurzel, '.wk-bogen'), 1);
});

test('Standard-Lader: welt.json nur einmal je Seite (über mehrere Karten), nach Fehler neuer Versuch, Länderpfade aus dem Zwischenspeicher (Prüfbericht 26.09.)', async () => {
  const altFetch = globalThis.fetch; const warn = console.warn;
  let abrufe = 0; let scheitern = true; let dekodiert = 0; const urls = [];
  const json = { v: 1, q: 100, get laender() { dekodiert++; return WELT.laender; } }; // dekodiereWelt liest laender zweimal
  globalThis.fetch = async (url) => { abrufe++; urls.push(String(url)); return scheitern ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => json }; };
  console.warn = () => {};
  try {
    const a = await karte({ holeWelt: undefined });
    assert.ok(hinweise(a.wurzel).includes('dashboard.karte_fehler_karte'), 'erster Abruf scheitert → Hinweis');
    scheitern = false;
    const b = await karte({ holeWelt: undefined });
    const c = await karte({ holeWelt: undefined });
    assert.equal(abrufe, 2, 'ein gescheiterter und genau ein erfolgreicher Abruf – die dritte Karte (Ansichtswechsel) lädt nicht neu');
    assert.ok(urls.every((u) => u.endsWith('/karte/welt.json')), urls.join(', '));
    assert.equal(zahl(b.wurzel, '.wk-land'), 2); assert.equal(zahl(c.wurzel, '.wk-land'), 2);
    assert.equal(dekodiert, 2, 'Länderpfade nur einmal berechnet (Zwischenspeicher je Weltdatei)');
  } finally { globalThis.fetch = altFetch; console.warn = warn; }
});

test('Tooltip: Punkt zeigt Flagge, Land, Stadt, Anzahl, IPs, Absender; positioniert per CSSOM; Zeiger weg → versteckt', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  const tip = wurzel.querySelector('.wk-tip');
  wurzel.querySelector('.wk-punkt').ausloesen('pointermove', { clientX: 200, clientY: 120, pointerType: 'mouse' });
  assert.equal(tip.hidden, false);
  const text = tip.textContent;
  for (const teil of ['🇺🇸', 'Vereinigte Staaten', 'Mountain View', 'dashboard.karte_verbindungen{"n":4}', '142.250.1.1', '142.250.1.2', 'FAH-NAS', 'it-tools']) assert.ok(text.includes(teil), `${teil} fehlt in „${text}“`);
  assert.equal(typeof tip.style.left, 'string'); assert.match(tip.style.left, /px$/); assert.equal(tip.getAttribute('style'), null);
  wurzel.querySelector('.wk-svg').ausloesen('pointerleave', {});
  assert.equal(tip.hidden, true);
  // Standort: Heimnetz mit Anzahl
  wurzel.querySelector('.wk-heim-punkt').ausloesen('pointermove', { clientX: 500, clientY: 100, pointerType: 'mouse' });
  assert.ok(tip.textContent.includes('Sandelzhausen') && tip.textContent.includes('192.168.1.1'), tip.textContent);
  // Aktives Land
  const us = wurzel.querySelectorAll('.wk-land').find((l) => l.getAttribute('data-iso') === 'US');
  us.ausloesen('pointermove', { clientX: 100, clientY: 150, pointerType: 'mouse' });
  assert.ok(tip.textContent.includes('Vereinigte Staaten') && tip.textContent.includes('dashboard.karte_verbindungen{"n":4}'), tip.textContent);
  // Handy: Tippen auf den Punkt zeigt den Tooltip ebenfalls
  wurzel.querySelector('.wk-svg').ausloesen('pointerleave', {});
  wurzel.querySelector('.wk-punkt').ausloesen('click', { clientX: 200, clientY: 120 });
  assert.equal(tip.hidden, false);
});

test('Tooltip auf schmaler Fläche (Handy): höchstens 2 IPs + „weitere“, 2 Absender, nicht über den Zoomknöpfen (Prüfbericht 26.09.)', async () => {
  const { wurzel, k } = await karte();
  const neun = Array.from({ length: 9 }, (_, i) => gs(`142.250.2.${i + 1}`, MV, { lokal: [[`app-${i % 5}`, 'app', 1]] }));
  k.setzeDaten(ergebnis(neun));
  const flaeche = wurzel.querySelector('.wk-flaeche');
  const rechteck = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  // 360 × 170 px wie am Handy, Zoomknöpfe als Reihe unten rechts (3 × 34 px)
  flaeche.getBoundingClientRect = rechteck(0, 0, 360, 170);
  wurzel.querySelector('.wk-svg').getBoundingClientRect = rechteck(0, 0, 360, 170);
  const zoom = wurzel.querySelector('.wk-zoom');
  zoom.getBoundingClientRect = rechteck(244, 130, 110, 34);
  k.groesse();
  const tip = wurzel.querySelector('.wk-tip');
  wurzel.querySelector('.wk-punkt').ausloesen('click', { clientX: 300, clientY: 140 });
  assert.equal(tip.hidden, false);
  const ips = tip.querySelector('.wk-tip-ips').textContent;
  assert.equal(ips, '142.250.2.1, 142.250.2.2 dashboard.karte_weitere{"n":7}', ips);
  assert.equal(tip.querySelectorAll('.wk-tip-zeile').length, 2, 'höchstens 2 Absender-Zeilen');
  // Lage (Rückfallmaße 220 × 90): innerhalb der Fläche und ohne Überlappung mit den Zoomknöpfen
  const l = parseFloat(tip.style.left); const o = parseFloat(tip.style.top); const bw = 220; const bh = 90;
  assert.ok(l >= 4 && o >= 4 && l + bw <= 356 && o + bh <= 166, `in der Fläche: ${l},${o}`);
  const ueber = l < 354 && l + bw > 244 && o < 164 && o + bh > 130;
  assert.ok(!ueber, `Tooltip liegt über den Zoomknöpfen: ${l},${o}`);
  // Breite Fläche: wie bisher bis zu 5 IPs
  flaeche.getBoundingClientRect = rechteck(0, 0, 1000, 500);
  wurzel.querySelector('.wk-svg').getBoundingClientRect = rechteck(0, 0, 1000, 500);
  k.groesse();
  wurzel.querySelector('.wk-punkt').ausloesen('pointermove', { clientX: 200, clientY: 120, pointerType: 'mouse' });
  assert.match(tip.querySelector('.wk-tip-ips').textContent, /142\.250\.2\.5 dashboard\.karte_weitere\{"n":4\}$/);
});

test('Filter: setzeFilter(name) lässt nur Orte mit diesem Absender voll sichtbar (.wk-geist), null hebt auf', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis([...DREI(), gs('5.9.1.1', FFM, { anzahl: 2 })]));
  assert.equal(zahl(wurzel, '.wk-punktg'), 2);
  k.setzeFilter('it-tools');
  const geist = (schluessel) => wurzel.querySelectorAll('.wk-punktg').find((g) => g.getAttribute('data-ort') === schluessel).classList.contains('wk-geist');
  const mvSchluessel = wurzel.querySelectorAll('.wk-punktg').map((g) => g.getAttribute('data-ort')).find((s) => s.startsWith('37.4'));
  const ffmSchluessel = wurzel.querySelectorAll('.wk-punktg').map((g) => g.getAttribute('data-ort')).find((s) => s.startsWith('50.1'));
  assert.equal(geist(mvSchluessel), false, 'Mountain View hat it-tools');
  assert.equal(geist(ffmSchluessel), true, 'Frankfurt nur FAH-NAS → blass');
  assert.ok(wurzel.classList.contains('gefiltert'));
  assert.equal(wurzel.querySelector('.wk-heim-zahl'), null, 'Heimnetz-Gerät gehört nicht zu it-tools');
  const bogenMv = wurzel.querySelectorAll('.wk-bogeng').find((g) => g.getAttribute('data-ort') === mvSchluessel);
  assert.ok(!bogenMv.classList.contains('wk-geist'));
  k.setzeFilter(null);
  assert.equal(geist(ffmSchluessel), false);
  assert.ok(!wurzel.classList.contains('gefiltert'));
  // setzeDaten mit filter-Option setzt ihn mit
  k.setzeDaten(ergebnis([...DREI(), gs('5.9.1.1', FFM, { anzahl: 2 })]), { filter: 'it-tools' });
  assert.equal(geist(ffmSchluessel), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live: Flüge, Ticker, Leistung
// ---------------------------------------------------------------------------------------------------------------------

const NEU = () => gs('5.9.1.1', FFM, { vor: -5_000, anzahl: 2, lokal: [['it-tools', 'app', 2]] });
const zweite = (mehr = {}) => ergebnis([...DREI(), NEU()], { zeit: iso(T0 + 10_000), ...mehr });

test('Flüge: neue Gegenstelle nach der vorigen Zeit → genau 1 Flug + 1 Tickereintrag; erster Aufruf ohne Flug', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'erster Stand: nichts fliegt');
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 0);
  k.setzeDaten(zweite());
  assert.equal(zahl(wurzel, '.wk-flug'), 1);
  const eintraege = wurzel.querySelectorAll('.wk-ticker-eintrag');
  assert.equal(eintraege.length, 1);
  assert.ok(eintraege[0].textContent.includes('dashboard.karte_flug_aus') && eintraege[0].textContent.includes('Frankfurt am Main') && eintraege[0].textContent.includes('it-tools'), eintraege[0].textContent);
  // ausgehend: Flug startet am Standort
  const spur = wurzel.querySelector('.wk-flug-spur').getAttribute('d');
  const hp = wurzel.querySelector('.wk-heim-punkt');
  assert.ok(spur.startsWith(`M${Number(hp.getAttribute('cx')).toFixed(1)},${Number(hp.getAttribute('cy')).toFixed(1)}`), spur);
  // Dieselben Daten nochmal: nichts Neues → kein weiterer Flug
  k.setzeDaten(zweite({ zeit: iso(T0 + 20_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 1);
  // Gegenstelle taucht wieder in der Liste auf (fiel z. B. aus den 500 neuesten), war aber seit dem letzten Stand nicht
  // aktiv (zuletzt vor der vorigen Zeit) → keine neue Verbindung, kein Flug, kein Tickereintrag
  k.setzeDaten(ergebnis([...DREI(), NEU(), gs('5.9.9.9', FFM, { vor: 5_000 })], { zeit: iso(T0 + 30_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 1);
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 1);
  // Flug läuft per rAF ab und wird entfernt; danach wartet kein rAF mehr (keine Dauerschleife)
  const n = bilderBisRuhe();
  assert.ok(n > 5 && n < 400, `Bilder: ${n}`);
  assert.equal(rafWarteschlange.size, 0);
  mock.timers.tick(2000);
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'Flug nach dem Ende entfernt');
  // Ticker blendet nach 9 s aus (650 ms Ausblenden; die Attrappe stellt die Uhr vor dem Rückruf vor → zweiter Tick)
  mock.timers.tick(8000);
  assert.ok(wurzel.querySelector('.wk-ticker-eintrag').classList.contains('weg'));
  mock.timers.tick(700);
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 0);
});

test('Flüge eingehend: starten am Ort und enden am Standort; Richtungswechsel löst keine Flüge aus', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI(), { richtung: 'ein' }));
  k.setzeDaten(zweite({ richtung: 'ein' }));
  assert.equal(zahl(wurzel, '.wk-flug'), 1);
  const hp = wurzel.querySelector('.wk-heim-punkt');
  assert.ok(wurzel.querySelector('.wk-flug-spur').getAttribute('d').endsWith(`${Number(hp.getAttribute('cx')).toFixed(1)},${Number(hp.getAttribute('cy')).toFixed(1)}`));
  assert.ok(wurzel.querySelector('.wk-ticker-eintrag').textContent.includes('dashboard.karte_flug_ein'));
  assert.ok(wurzel.classList.contains('wk-ein'));
  bilderBisRuhe(); mock.timers.tick(20_000); mock.timers.tick(1000);
  k.setzeDaten(zweite({ richtung: 'aus', zeit: iso(T0 + 30_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'Umschalten ist keine neue Verbindung');
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 0);
  assert.ok(wurzel.classList.contains('wk-aus'));
});

test('Richtungswechsel sofort (ohne zu warten): Ticker und laufende Flüge der alten Richtung verschwinden (Bedienprobe 26.09.)', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI(), { richtung: 'ein' }));
  k.setzeDaten(zweite({ richtung: 'ein' }));
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 1); assert.equal(zahl(wurzel, '.wk-flug'), 1);
  k.setzeDaten(zweite({ richtung: 'aus', zeit: iso(T0 + 2_000) }));
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 0, 'kein „Heimnetz → Web“ mehr in der Ausgehend-Ansicht');
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'Flüge der alten Richtung abgebrochen');
});

test('setzeDaten(…, {laedt:true}): Karte sofort leer, Standort bleibt, abgedunkelt ohne „leer“-Hinweis; nächste echte Daten ohne Flüge (Prüfbericht 26.09.)', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI(), { richtung: 'ein' }));
  k.setzeDaten(zweite({ richtung: 'ein' }));
  assert.equal(zahl(wurzel, '.wk-bogen'), 2); assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 1); assert.equal(zahl(wurzel, '.wk-flug'), 1);
  // Umschalten: Platzhalter der neuen Richtung – keine Gegenstellen, Standort beibehalten
  k.setzeDaten({ richtung: 'aus', heimat: ergebnis([]).heimat, gegenstellen: [] }, { filter: null, laedt: true });
  assert.equal(zahl(wurzel, '.wk-bogen') + zahl(wurzel, '.wk-punkt'), 0, 'keine alten Bögen und Punkte');
  assert.ok(wurzel.querySelector('.wk-heim-punkt'), 'Standort bleibt');
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag') + zahl(wurzel, '.wk-flug'), 0, 'Ticker und Flüge der alten Richtung weg');
  assert.ok(wurzel.classList.contains('wk-laedt'), 'abgedunkelt');
  assert.equal(wurzel.querySelector('.wk-flaeche').getAttribute('aria-busy'), 'true');
  assert.deepEqual(hinweise(wurzel), [], 'kein „In der letzten Stunde keine Verbindungen“, solange geladen wird');
  assert.ok(wurzel.classList.contains('wk-aus'));
  // Echte Daten der neuen Richtung: gelten als erster Stand (nichts fliegt), Abdunkeln endet
  k.setzeDaten(zweite({ richtung: 'aus', zeit: iso(T0 + 20_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'erste echte Daten nach dem Umschalten lösen keine Flüge aus');
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 0);
  assert.equal(zahl(wurzel, '.wk-bogen'), 2);
  assert.ok(!wurzel.classList.contains('wk-laedt'));
  assert.equal(wurzel.querySelector('.wk-flaeche').getAttribute('aria-busy'), null);
  // Platzhalter ohne Standort: kein „kein Standort“-Hinweis, nur abgedunkelt
  k.setzeDaten({ richtung: 'ein', heimat: null, gegenstellen: [] }, { laedt: true });
  assert.deepEqual(hinweise(wurzel), []);
});

test('Bewegung reduziert (Option oder prefers-reduced-motion): 0 Flüge, kein Fließen, kein Puls – Ticker trotzdem', async () => {
  for (const art of ['option', 'medien']) {
    if (art === 'medien') bewegungAus = true;
    const { wurzel, k } = await karte(art === 'option' ? { bewegungReduziert: true } : { bewegungReduziert: undefined });
    k.setzeDaten(ergebnis(DREI()));
    k.setzeDaten(zweite());
    assert.equal(zahl(wurzel, '.wk-flug'), 0, art);
    assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 1, art);
    assert.equal(zahl(wurzel, '.wk-fluss'), 0, art);
    assert.equal(zahl(wurzel, '.wk-puls'), 0, art);
    assert.equal(rafWarteschlange.size, 0, `${art}: kein rAF`);
    aufraeumen();
  }
});

test('Leistung: höchstens 12 fließende Bögen, 8 Pulse, 12 Flüge je Aktualisierung (gestaffelt), 4 Tickereinträge', async () => {
  const { wurzel, k } = await karte();
  const orte = (n, vor) => Array.from({ length: n }, (_, i) => gs(`203.0.113.${i + 1}`, { land: 'US', land_name: 'Vereinigte Staaten', stadt: `Ort ${i}`, lat: 30 + i, lon: -100 + i, genau: 'stadt' }, { vor }));
  k.setzeDaten(ergebnis(orte(20, 10_000)));
  assert.equal(zahl(wurzel, '.wk-bogen'), 20);
  assert.equal(zahl(wurzel, '.wk-fluss'), 12);
  assert.equal(zahl(wurzel, '.wk-puls'), 8);
  assert.equal(zahl(wurzel, '.wk-punkt'), 20);
  // 20 neue Orte → sofort 1 Flug, die übrigen gestaffelt; insgesamt 12
  const neu = [...orte(20, 10_000), ...Array.from({ length: 20 }, (_, i) => gs(`198.51.100.${i + 1}`, { land: 'DE', land_name: 'Deutschland', stadt: `Stadt ${i}`, lat: 40 + i, lon: 5 + i, genau: 'stadt' }, { vor: -5000 }))];
  k.setzeDaten(ergebnis(neu, { zeit: iso(T0 + 10_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 1, 'erster Flug sofort');
  mock.timers.tick(3000);
  assert.equal(zahl(wurzel, '.wk-flug'), 12);
  assert.ok(zahl(wurzel, '.wk-ticker-eintrag') <= 4);
  assert.ok(zahl(wurzel, '.wk-fluss') <= 12 && zahl(wurzel, '.wk-puls') <= 8);
});

test('Pause: außerhalb des Bildschirms, versteckter Tab oder pausieren(true) → keine Flüge, Klasse pausiert, rAF steht', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  k.setzeDaten(zweite());
  assert.equal(zahl(wurzel, '.wk-flug'), 1);
  imBild(false);
  assert.ok(wurzel.classList.contains('pausiert'));
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'laufende Flüge entfernt');
  bild(); assert.equal(rafWarteschlange.size, 0, 'rAF-Schleife endet');
  k.setzeDaten(ergebnis([...DREI(), NEU(), gs('5.9.1.2', FFM, { vor: -15_000 })], { zeit: iso(T0 + 20_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'kein Flug im Hintergrund');
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 2, 'Ticker läuft weiter');
  imBild(true);
  assert.ok(!wurzel.classList.contains('pausiert'));
  tabVersteckt(true);
  assert.ok(wurzel.classList.contains('pausiert'));
  tabVersteckt(false);
  assert.ok(!wurzel.classList.contains('pausiert'));
  k.pausieren(true);
  assert.ok(wurzel.classList.contains('pausiert'));
  k.setzeDaten(ergebnis([...DREI(), NEU(), gs('5.9.1.2', FFM, { vor: -15_000 }), gs('5.9.1.3', MV, { vor: -25_000 })], { zeit: iso(T0 + 30_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 0);
  assert.equal(zahl(wurzel, '.wk-ticker-eintrag'), 3, 'neue Gegenstelle erkannt, nur nicht geflogen');
  k.pausieren(false);
  assert.ok(!wurzel.classList.contains('pausiert'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------------------------------------------------

test('Zoom: Mausrad am Zeiger vergrößert, Punktgrößen bleiben gleich (r ÷ Maßstab); ganz heraus rollt die Seite', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  const svg = wurzel.querySelector('.wk-svg');
  const hoerer = svg.hoerer.wheel || [];
  assert.ok(hoerer.length && hoerer[0].opt && hoerer[0].opt.passive === false, 'wheel mit passive:false');
  const raus = svg.ausloesen('wheel', { deltaY: 100, deltaMode: 0, clientX: 500, clientY: 250 });
  assert.equal(raus.defaultPrevented, false, 'bei Maßstab 1 herausrollen → Seite rollt');
  assert.equal(massstab(wurzel), 1);
  const punkt = wurzel.querySelector('.wk-punkt');
  const r0 = Number(punkt.getAttribute('r'));
  const heimR0 = Number(wurzel.querySelector('.wk-heim-punkt').getAttribute('r'));
  const rein = svg.ausloesen('wheel', { deltaY: -300, deltaMode: 0, clientX: Number(punkt.getAttribute('cx')), clientY: Number(punkt.getAttribute('cy')) + 36 });
  assert.equal(rein.defaultPrevented, true);
  const k1 = massstab(wurzel);
  assert.ok(k1 > 1, `Maßstab ${k1}`);
  assert.ok(Math.abs(Number(punkt.getAttribute('r')) - r0 / k1) < 0.01, 'Radius durch den Maßstab geteilt');
  assert.ok(Math.abs(Number(wurzel.querySelector('.wk-heim-punkt').getAttribute('r')) * k1 - heimR0) < 0.01, 'Standortmarke bleibt gleich groß');
  // Grenze 20: weiter hineinrollen bei 20 → Seite rollt
  for (let i = 0; i < 40; i++) svg.ausloesen('wheel', { deltaY: -500, deltaMode: 0, clientX: 500, clientY: 250 });
  assert.ok(Math.abs(massstab(wurzel) - 20) < 1e-6, `Maßstab ${massstab(wurzel)}`);
  assert.equal(svg.ausloesen('wheel', { deltaY: -100, deltaMode: 0, clientX: 500, clientY: 250 }).defaultPrevented, false);
});

test('Zoom: Knöpfe + − ⟲, Doppelklick, Ziehen mit der Maus; Touch zieht nicht (Seite bleibt rollbar)', async () => {
  const { wurzel, k } = await karte({ bewegungReduziert: true });
  k.setzeDaten(ergebnis(DREI()));
  const [plus, minus, zurueck] = wurzel.querySelector('.wk-zoom').children;
  plus.click();
  assert.ok(Math.abs(massstab(wurzel) - 2) < 1e-6);
  plus.click();
  assert.ok(Math.abs(massstab(wurzel) - 4) < 1e-6);
  minus.click();
  assert.ok(Math.abs(massstab(wurzel) - 2) < 1e-6);
  zurueck.click();
  assert.equal(massstab(wurzel), 1);
  const svg = wurzel.querySelector('.wk-svg');
  svg.ausloesen('dblclick', { clientX: 300, clientY: 200 });
  assert.ok(Math.abs(massstab(wurzel) - 2) < 1e-6, 'Doppelklick zoomt hinein');
  const vorher = wurzel.querySelector('.wk-welt').getAttribute('transform');
  svg.ausloesen('pointerdown', { pointerType: 'touch', button: 0, clientX: 300, clientY: 200, pointerId: 1 });
  svg.ausloesen('pointermove', { pointerType: 'touch', clientX: 200, clientY: 150, pointerId: 1 });
  svg.ausloesen('pointerup', { pointerType: 'touch', pointerId: 1 });
  assert.equal(wurzel.querySelector('.wk-welt').getAttribute('transform'), vorher, 'Touch verschiebt nicht');
  svg.ausloesen('pointerdown', { pointerType: 'mouse', button: 0, clientX: 300, clientY: 200, pointerId: 2 });
  svg.ausloesen('pointermove', { pointerType: 'mouse', clientX: 250, clientY: 180, pointerId: 2 });
  svg.ausloesen('pointerup', { pointerType: 'mouse', pointerId: 2 });
  assert.notEqual(wurzel.querySelector('.wk-welt').getAttribute('transform'), vorher, 'Maus verschiebt');
  // Mit Bewegung: Knopf-Zoom läuft kurz animiert und endet (keine Dauerschleife)
  const b = await karte();
  b.k.setzeDaten(ergebnis(DREI()));
  b.wurzel.querySelector('.wk-zoom').children[0].click();
  const n = bilderBisRuhe();
  assert.ok(n > 0 && n < 100, `Bilder: ${n}`);
  assert.ok(Math.abs(massstab(b.wurzel) - 2) < 1e-6);
});

test('Tastatur: Kartenfläche fokussierbar (tabindex 0, aria-label), Pfeiltasten verschieben, + − zoomen, 0 zeigt alles; Knopf/Taste zoomt um den Standort (Prüfbericht 26.09.)', async () => {
  const { wurzel, k } = await karte({ bewegungReduziert: true });
  k.setzeDaten(ergebnis(DREI()));
  const flaeche = wurzel.querySelector('.wk-flaeche');
  assert.equal(flaeche.getAttribute('tabindex'), '0');
  assert.equal(flaeche.getAttribute('role'), 'group');
  assert.equal(flaeche.getAttribute('aria-label'), 'dashboard.karte_tastatur');
  const lage = () => { const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(wurzel.querySelector('.wk-welt').getAttribute('transform')); return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) }; };
  const heimAmSchirm = () => { const z = lage(); const p = wurzel.querySelector('.wk-heim-punkt'); return [Number(p.getAttribute('cx')) * z.k + z.x, Number(p.getAttribute('cy')) * z.k + z.y]; };
  const nah = (a, b, wo) => assert.ok(Math.abs(a[0] - b[0]) < 0.2 && Math.abs(a[1] - b[1]) < 0.2, `${wo}: ${a} ≠ ${b}`);
  const taste = (key, extra = {}) => flaeche.ausloesen('keydown', { key, ...extra });
  const heim0 = heimAmSchirm();
  // ganze Welt: Pfeile verschieben nichts – die Seite darf rollen
  assert.equal(taste('ArrowRight').defaultPrevented, false);
  // + zoomt um den Standort: er bleibt an seinem Platz (vorher schob „+“ ihn aus dem Bild)
  assert.equal(taste('+').defaultPrevented, true);
  assert.equal(lage().k, 2); nah(heimAmSchirm(), heim0, '1. Schritt');
  taste('+'); assert.equal(lage().k, 4); nah(heimAmSchirm(), heim0, '2. Schritt – Standort bleibt im Bild');
  // Pfeiltasten verschieben den Ausschnitt (rechts = weiter nach Osten → Inhalt wandert nach links)
  const vor = lage();
  assert.equal(taste('ArrowRight').defaultPrevented, true);
  assert.ok(lage().x < vor.x, 'ArrowRight');
  taste('ArrowLeft'); assert.ok(Math.abs(lage().x - vor.x) < 0.01, 'ArrowLeft zurück');
  taste('ArrowDown'); assert.ok(lage().y < vor.y, 'ArrowDown');
  taste('ArrowUp'); assert.ok(Math.abs(lage().y - vor.y) < 0.01, 'ArrowUp zurück');
  taste('-'); assert.equal(lage().k, 2);
  taste('0'); assert.deepEqual(lage(), { x: 0, y: 0, k: 1 });
  // Strg/Cmd + „+“ gehört dem Browser (Seitenzoom), andere Tasten ebenso
  assert.equal(taste('+', { ctrlKey: true }).defaultPrevented, false); assert.equal(lage().k, 1);
  assert.equal(taste('+', { metaKey: true }).defaultPrevented, false);
  assert.equal(taste('a').defaultPrevented, false);
  // Knopf „+“ ebenso um den Standort
  wurzel.querySelector('.wk-zoom').children[0].click();
  assert.equal(lage().k, 2); nah(heimAmSchirm(), heim0, 'Knopf');
  // Standort aus dem Bild geschoben → wieder um die Mitte
  wurzel.querySelector('.wk-zoom').children[2].click();
  for (let i = 0; i < 3; i++) taste('+');
  for (let i = 0; i < 8; i++) taste('ArrowLeft');
  const [hx] = heimAmSchirm(); assert.ok(hx > 1000, `Standort rechts außerhalb: ${hx}`);
  const z1 = lage(); taste('+'); const z2 = lage();
  // Mitte (500, H/2) bleibt fest: (500 − x) / k gleich
  assert.ok(Math.abs((500 - z1.x) / z1.k - (500 - z2.x) / z2.k) < 0.05, 'ohne Standort im Bild zoomt die Taste um die Mitte');
  // ohne Standort: Mitte
  k.setzeDaten(ergebnis(DREI(), { heimat: null }));
  taste('0'); taste('+');
  assert.ok(Math.abs((500 - lage().x) / 2 - 500) < 0.05);
});

test('Zoom-Animation: der feste Punkt (Standort) bleibt in jedem Bild an seinem Platz, nicht nur am Ende', async () => {
  const { wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  const heimAmSchirm = () => {
    const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(wurzel.querySelector('.wk-welt').getAttribute('transform'));
    const p = wurzel.querySelector('.wk-heim-punkt');
    return [Number(p.getAttribute('cx')) * Number(m[3]) + Number(m[1]), Number(p.getAttribute('cy')) * Number(m[3]) + Number(m[2])];
  };
  const heim0 = heimAmSchirm();
  wurzel.querySelector('.wk-zoom').children[0].click();
  let bilder = 0;
  while (rafWarteschlange.size && bilder < 100) {
    bild(40); bilder++;
    const [x, y] = heimAmSchirm();
    assert.ok(Math.abs(x - heim0[0]) < 0.5 && Math.abs(y - heim0[1]) < 0.5, `Bild ${bilder}: Standort wandert (${x.toFixed(1)}, ${y.toFixed(1)} statt ${heim0.map((v) => v.toFixed(1))})`);
  }
  assert.ok(bilder > 2, `Animation lief über ${bilder} Bilder`);
  assert.ok(Math.abs(massstab(wurzel) - 2) < 1e-6);
});

test('groesse() und zerstoeren(): Beschriftungen passen sich der Breite an; danach alles abgebaut und still', async () => {
  const { behaelter, wurzel, k } = await karte();
  k.setzeDaten(ergebnis(DREI()));
  const fs1 = Number(wurzel.querySelector('.wk-name').getAttribute('font-size'));
  const flaeche = wurzel.querySelector('.wk-flaeche');
  flaeche.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 180, right: 400, bottom: 180 });
  wurzel.querySelector('.wk-svg').getBoundingClientRect = flaeche.getBoundingClientRect;
  k.groesse();
  const fs2 = Number(wurzel.querySelector('.wk-name').getAttribute('font-size'));
  assert.ok(fs2 > fs1, `schmale Karte → größere Schrift in Karteneinheiten (${fs1} → ${fs2})`);
  const beobachter = io[io.length - 1];
  k.zerstoeren();
  assert.equal(behaelter.children.length, 0, 'Wurzel entfernt');
  assert.ok(beobachter.getrennt, 'IntersectionObserver getrennt');
  assert.equal((dokHoerer.visibilitychange || []).length, 0, 'visibilitychange abgemeldet');
  assert.doesNotThrow(() => { k.setzeDaten(zweite()); k.setzeFilter('x'); k.groesse(); k.pausieren(false); k.zerstoeren(); });
  assert.equal(rafWarteschlange.size, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Quelltext, Sprache, Stil, echte Kartendaten
// ---------------------------------------------------------------------------------------------------------------------

test('Quelltext-Verbote: kein innerHTML, kein style-Attribut, kein style: in el(), kein eval; Urheber-Kopf', async () => {
  const q = await fs.readFile(QUELLE, 'utf8');
  assert.ok(q.includes('Erdacht und programmiert von Fabian Hammer'));
  assert.ok(!/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/.test(q), 'innerHTML o. ä.');
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(q), 'style-Attribut');
  assert.ok(!/\bstyle\s*:/.test(q), 'style: in el()-Aufruf');
  assert.ok(!/\beval\(|new Function\(/.test(q), 'eval');
  assert.ok(!/\bd3\b|topojson/.test(q), 'keine Fremdbibliothek');
});

test('Sprachschlüssel: jeder t(\'dashboard.karte_…\') aus weltkarte.js steht in dashboard.json, Umlaute intakt', async () => {
  const q = (await fs.readFile(QUELLE, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const texte = JSON.parse(await fs.readFile(path.join(PUBLIC, 'sprache', 'de', 'dashboard.json'), 'utf8'));
  const benutzt = new Set([...q.matchAll(/'(dashboard\.karte_[a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(benutzt.size >= 15, `nur ${benutzt.size} Schlüssel`);
  for (const k of benutzt) assert.ok(Object.hasOwn(texte, k), `${k} fehlt in dashboard.json`);
  assert.ok(!/\bt\(\s*`/.test(q), 'kein dynamischer Schlüssel');
  for (const [k, v] of Object.entries(texte).filter(([k]) => k.startsWith('dashboard.karte_'))) {
    assert.ok(v.trim() && !/\\u00|Ã/.test(v), `${k}: leer oder kaputte Umlaute`);
    assert.ok(!/\bUpload|\bDownload|\bFlow|\bTooltip/.test(v), `${k}: Denglisch`);
  }
  assert.match(texte['dashboard.karte_verbindungen'], /\{n\|Verbindung\|Verbindungen\}/);
});

test('Stil: Abschnitt „Weltkarte – Karte“ am Ende von dashboard.css, nur Farbvariablen (hell + dunkel), Pause, reduzierte Bewegung', async () => {
  const css = await fs.readFile(path.join(PUBLIC, 'ansichten', 'dashboard.css'), 'utf8');
  const i = css.indexOf('/* Weltkarte – Karte */');
  assert.ok(i > 0, 'Abschnitt fehlt');
  const teil = css.slice(i);
  for (const k of ['.wk ', '.wk-svg', '.wk-tip', '.wk-ticker', '.wk-zoom', '.wk-hinweis', '.wk-land', '.wk-bogen', '.wk-fluss', '.wk-punkt', '.wk-puls', '.wk-heim', '.wk-flug', '.wk-geist', '.wk-name']) {
    assert.ok(teil.includes(k), `${k} fehlt`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(teil.replace(/\/\*[\s\S]*?\*\//g, '')), 'nur var(--fahnas-…) – sonst stimmt hell/dunkel nicht');
  assert.match(teil, /var\(--fahnas-erfolg\)/, 'Standort/Filter grün');
  assert.match(teil, /\.wk\.pausiert[^{]*\{[^}]*animation-play-state:\s*paused/);
  assert.match(teil, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(teil, /@keyframes wk-fluss/);
  assert.match(teil, /stroke-dasharray:\s*\.1 15\.9/);
  assert.match(teil, /@media \(max-width: 719px\)/, 'Handy-Regel');
  assert.match(teil, /\.wk\.wk-laedt \.wk-svg \{[^}]*opacity:/, 'Platzhalter beim Umschalten abgedunkelt');
  // Tooltip passt in die Kartenfläche (rollt notfalls), Zoomknöpfe liegen darüber
  assert.match(teil, /\.wk-tip \{[^}]*max-height: calc\(100% - \d+px\)[^}]*overflow: auto/);
  const z = (sel) => Number((new RegExp(`\\${sel} \\{[^}]*z-index: (\\d+)`).exec(teil) || [])[1]);
  assert.ok(z('.wk-zoom') > z('.wk-tip'), `z-index Zoom ${z('.wk-zoom')} ≤ Tooltip ${z('.wk-tip')}`);
  // Fokusrahmen der Kartenfläche innen (die Kachel schneidet außen ab)
  assert.match(teil, /\.wk-flaeche:focus-visible \{[^}]*outline: 2px solid var\(--fahnas-fokus\)[^}]*outline-offset: -\d+px/);
});

test('public/karte/welt.json (von Task 3): gültig, ≤ 400 KB, dekodierbar', async (tk) => {
  const datei = path.join(PUBLIC, 'karte', 'welt.json');
  let roh;
  try { roh = await fs.readFile(datei); } catch { tk.skip('public/karte/welt.json fehlt noch (Task 3)'); return; }
  assert.ok(roh.length <= 400_000, `${roh.length} Byte`);
  const json = JSON.parse(roh.toString('utf8'));
  assert.equal(json.v, 1);
  const welt = wk.dekodiereWelt(json);
  assert.ok(welt.length >= 170, `${welt.length} Länder`);
  const de = welt.find((l) => l.iso === 'DE');
  assert.ok(de && de.p[1] > 47 && de.p[1] < 55 && de.p[0] > 6 && de.p[0] < 15);
  for (const l of welt) for (const r of l.ringe) for (const [lon, lat] of r) assert.ok(Math.abs(lon) <= 180.001 && Math.abs(lat) <= 90.001, `${l.iso}: ${lon},${lat}`);
});

test('Richtungswechsel: geplante (verzögerte) Flüge der alten Richtung starten danach nicht mehr (Prüfbericht 26.09.)', async () => {
  const { wurzel, k } = await karte();
  const ortBei = (stadt, lat, lon) => ({ ...MV, stadt, lat, lon });
  k.setzeDaten(ergebnis([], { richtung: 'ein' }));
  k.setzeDaten(ergebnis([
    gs('198.51.100.1', ortBei('A', 10, 10), { vor: -500 }), gs('198.51.100.2', ortBei('B', 20, 40), { vor: -500 }),
    gs('198.51.100.3', ortBei('C', -10, 80), { vor: -500 }), gs('198.51.100.4', ortBei('D', 40, -60), { vor: -500 }),
  ], { richtung: 'ein', zeit: iso(T0 + 1_000) }));
  assert.equal(zahl(wurzel, '.wk-flug'), 1, 'der erste fliegt sofort, drei sind geplant');
  k.setzeDaten({ richtung: 'aus', zeit: iso(T0 + 1_500), heimat: { lat: 48.6284, lon: 11.7989, name: 'Sandelzhausen' }, gegenstellen: [], lokal: [] }, { filter: null, laedt: true });
  mock.timers.tick(3000);
  assert.equal(zahl(wurzel, '.wk-flug'), 0, 'keine Flüge der alten Richtung auf der leeren Karte');
});
