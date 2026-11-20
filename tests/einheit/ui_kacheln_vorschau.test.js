// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kachelansicht des Dateimanagers (Betreiber-Wunsch 28.09.): Bilder und Videos zeigen ein Vorschaubild (lazy, Symbol als
// Rückfall bei Fehlern), Videos ein Abspiel-Zeichen; ein Schieberegler stellt die Kachelgröße in sechs Stufen ein (nur in
// der Kachelansicht sichtbar, je Gerät gemerkt) und fordert bei großen Kacheln schärfere Bilder an. Läuft ohne Browser:
// echte Ansicht public/ansichten/dateien.js gegen eine DOM-Attrappe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HIER, '..', '..', 'public');

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe (wie ui_upload_tafel.test.js, zusätzlich: style-Variablen, value-Eigenschaft, Tag-/Attribut-Selektoren)
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
    this.style = { werte: {}, setProperty(k, v) { this.werte[k] = String(v); } };
    this.hidden = false;
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
  get value() { return this._wert !== undefined ? this._wert : (this.getAttribute('value') ?? ''); }
  set value(v) { this._wert = String(v); }
  get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { for (const k of this.childNodes) k.parentNode = null; this.childNodes = v === '' ? [] : [new TextKnoten(v)]; }
  appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; this.childNodes.push(k); return k; }
  removeChild(k) { this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  hasAttribute(k) { return this.attribute.has(k); }
  removeAttribute(k) { this.attribute.delete(k); }
  addEventListener(art, fn) { (this.hoerer[art] ||= []).push(fn); }
  removeEventListener() {}
  ausloesen(art, ev = {}) { for (const fn of this.hoerer[art] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, closest: () => null, ...ev }); }
  click() { this.ausloesen('click'); }
  focus() {}
  closest() { return null; }
  alle() { const aus = []; for (const k of this.children) { aus.push(k, ...k.alle()); } return aus; }
  passt(s) {
    if (s.startsWith('.')) return s.slice(1).split('.').every((c) => this.classList.contains(c));
    if (s.startsWith('[') && s.endsWith(']')) return this.hasAttribute(s.slice(1, -1));
    return this.tagName === s.toUpperCase();
  }
  querySelectorAll(s) { return this.alle().filter((k) => k.passt(s.trim())); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}

function dom() {
  dokument = {
    documentElement: new Element('html'), body: new Element('body'), head: new Element('head'), cookie: '', title: '',
    createElement: (t) => new Element(t), createElementNS: (ns, t) => new Element(t, ns), createTextNode: (t) => new TextKnoten(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  };
  dokument.documentElement.appendChild(dokument.body);
  globalThis.Node = Knoten;
  globalThis.HTMLFormElement = class {};
  globalThis.document = dokument;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', href: 'http://nas.local/', origin: 'http://nas.local', replace() {} };
  const speicher = new Map();
  globalThis.localStorage = { getItem: (k) => (speicher.has(k) ? speicher.get(k) : null), setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.Image = class { constructor() { this.hoerer = {}; erzeugteImages.push(this); } addEventListener(a, f) { (this.hoerer[a] ||= []).push(f); } set src(v) { this._src = v; } get src() { return this._src; } laden() { for (const f of this.hoerer.load || []) f(); } };
  erzeugteImages.length = 0;
  return dokument;
}
const erzeugteImages = [];

const abarbeiten = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const ruhe = () => new Promise((r) => setTimeout(r, 220)); // Regler: Neuzeichnen kommt gebündelt nach 150 ms
const versteckt = (k) => k.hidden === true || k.hasAttribute('hidden');
const knopfMitTitel = (wurzel, titel) => wurzel.alle().find((k) => k.tagName === 'BUTTON' && k.getAttribute('title') === titel);

const EINTRAEGE = [
  { name: 'Urlaub 2026', art: 'ordner', geaendert: '2026-09-01T10:00:00.000Z', anzahl: 3 },
  { name: 'Strand.JPG', art: 'datei', groesse: 1_500_000, geaendert: '2026-09-02T10:00:00.000Z', mime: 'image/jpeg' },
  { name: 'clip.mkv', art: 'datei', groesse: 90_000_000, geaendert: '2026-09-03T10:00:00.000Z', mime: 'video/x-matroska' },
  { name: 'Rechnung.pdf', art: 'datei', groesse: 20_000, geaendert: '2026-09-04T10:00:00.000Z', mime: 'application/pdf' },
  { name: 'lied.flac', art: 'datei', groesse: 30_000_000, geaendert: '2026-09-05T10:00:00.000Z' },
  { name: 'logo.svg', art: 'datei', groesse: 4_000, geaendert: '2026-09-06T10:00:00.000Z', mime: 'image/svg+xml' },
  { name: 'favicon.ico', art: 'datei', groesse: 2_000, geaendert: '2026-09-07T10:00:00.000Z', mime: 'image/x-icon' },
];

let laufnummer = 0;
let app = null; let apiModul = null;
async function einbinden({ modus = 'kacheln', eintraege = EINTRAEGE, dpr = 1, stufe = null, ohneVorschauUrl = false, teile = ['medien', 'fotos'] } = {}) {
  dom();
  globalThis.devicePixelRatio = dpr;
  localStorage.setItem('fahnas_dateien_modus', modus);
  if (stufe !== null) localStorage.setItem('fahnas_dateien_kachelgroesse', String(stufe));
  if (!app) {
    app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
    apiModul = await import(pathToFileURL(path.join(PUBLIC, 'api.js')).href);
    app._test.setzeT(Object.assign((k, w) => (w ? `${k}:${JSON.stringify(w)}` : k), { hat: () => true }));
  }
  const modul = (await import(`${pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href}?n=${++laufnummer}`)).default;
  const wurzel = dokument.createElement('main');
  dokument.body.appendChild(wurzel);
  const apiAufrufe = []; const meldungen = [];
  const ctx = {
    rolle: 'nutzer', route: { id: 'dateien', teile }, sse: { on() {} },
    api: async (aktion, params) => { apiAufrufe.push({ aktion, params }); if (aktion === 'freigaben.liste') return [{ name: 'medien', papierkorb: true }]; if (aktion === 'dateien.liste') return { eintraege, schreiben: true, papierkorb: true }; return {}; },
    vorschauUrl: ohneVorschauUrl ? undefined : apiModul.vorschauUrl, downloadUrl: () => '#', hashFuer: (...t) => `#/${t.join('/')}`, navigiere() {}, setzeTitel() {},
    melden(text, art) { meldungen.push({ text, art }); }, zeigeFehler() {}, fehlerText: (e) => String(e), dialog() { return { schliessen() {}, koerper: dokument.createElement('div') }; }, bestaetigen: async () => false, eingabe: async () => null,
  };
  await modul.einbinden(wurzel, ctx);
  await abarbeiten();
  return { wurzel, modul, ctx, apiAufrufe, meldungen };
}

const raster = (wurzel) => wurzel.querySelector('.dateien-kacheln');
const bilder = (wurzel) => wurzel.querySelectorAll('.dateien-kachel-vorschau');
const groesseAus = (src) => Number(/groesse=(\d+)/.exec(src)[1]);

test('Kacheln: Bilder und Videos bekommen ein lazy geladenes Vorschaubild mit Größe 256 und Dateistand, andere Arten nur das Symbol; Video mit Abspiel-Zeichen', async () => {
  const { wurzel } = await einbinden();
  const r = raster(wurzel);
  assert.ok(r, 'Kachelraster vorhanden');
  assert.equal(r.style.werte['--dateien-kachel-min'], '160px', 'Standardstufe 2 = 160 px');
  const kacheln = r.querySelectorAll('.dateien-kachel');
  assert.equal(kacheln.length, EINTRAEGE.length);
  assert.equal(r.querySelectorAll('.dateien-kachel-bild').length, EINTRAEGE.length, 'jede Kachel hat ein Bildfeld');
  const imgs = bilder(wurzel);
  assert.equal(imgs.length, 2, 'nur Bild und Video – SVG/ICO bekommen keine Anfrage (der Agent lehnte sie ab)');
  // Sortierung nach Name ohne Groß/Klein: „clip.mkv“ vor „Strand.JPG“
  const foto = imgs.find((b) => /Strand/.test(b.getAttribute('src'))); const clip = imgs.find((b) => /clip/.test(b.getAttribute('src')));
  assert.ok(foto && clip);
  assert.equal(foto.getAttribute('src'), `/api/dateien/vorschau?freigabe=medien&pfad=fotos%2FStrand.JPG&groesse=256&v=${Date.parse('2026-09-02T10:00:00.000Z')}-1500000`);
  assert.equal(clip.getAttribute('src'), `/api/dateien/vorschau?freigabe=medien&pfad=fotos%2Fclip.mkv&groesse=256&v=${Date.parse('2026-09-03T10:00:00.000Z')}-90000000`);
  for (const b of imgs) { assert.equal(b.getAttribute('loading'), 'lazy'); assert.equal(b.getAttribute('alt'), ''); assert.equal(b.getAttribute('decoding'), 'async'); }
  const feldVon = (img) => img.parentNode;
  assert.ok(feldVon(foto).classList.contains('dateien-kachel-bild') && feldVon(foto).classList.contains('art-bild'));
  assert.ok(feldVon(clip).querySelector('.dateien-kachel-abspielen'), 'Video: Abspiel-Zeichen');
  assert.equal(feldVon(foto).querySelector('.dateien-kachel-abspielen'), null);
  // Symbol bleibt in jedem Bildfeld; nach dem Laden markiert die Klasse „geladen“ (CSS blendet das Symbol aus)
  assert.ok(feldVon(foto).querySelector('svg'), 'Symbol im Bildfeld');
  assert.equal(feldVon(foto).classList.contains('geladen'), false);
  foto.ausloesen('load');
  assert.equal(feldVon(foto).classList.contains('geladen'), true);
  // Fehler (kein ffmpeg, keine Rechte, Format unlesbar): Bild verschwindet, Symbol bleibt sichtbar
  const clipFeld = feldVon(clip);
  clip.ausloesen('error');
  assert.equal(clip.parentNode, null); assert.equal(clipFeld.classList.contains('geladen'), false);
  assert.ok(clipFeld.querySelector('svg'));
  // Ordner/PDF/Audio: Bildfeld mit Symbol, kein <img>
  const felder = r.querySelectorAll('.dateien-kachel-bild');
  assert.equal(felder.filter((f) => f.querySelector('img')).length, 1, 'nur noch das Foto trägt ein img');
  assert.ok(felder.every((f) => f.querySelector('svg')));
});

const meldungenJeWurzel = new WeakMap();
const meldungenVon = (w) => meldungenJeWurzel.get(w) || [];
test('Kacheln: Schieberegler nur in der Kachelansicht, mit Erklärung; Stufe wird gemerkt, setzt die Rasterbreite und fordert bei großen Kacheln 512-px-Bilder an', async () => {
  const { wurzel, meldungen } = await einbinden();
  meldungenJeWurzel.set(wurzel, meldungen);
  const feld = wurzel.querySelector('.dateien-kachelgroesse');
  const regler = wurzel.querySelector('.dateien-kachelgroesse-regler');
  assert.ok(feld && regler, 'Regler vorhanden');
  assert.equal(versteckt(feld), false);
  assert.equal(regler.getAttribute('type'), 'range'); assert.equal(regler.getAttribute('min'), '0'); assert.equal(regler.getAttribute('max'), '5');
  assert.equal(String(regler.value), '2');
  assert.equal(regler.getAttribute('aria-label'), 'dateien.kachelgroesse');
  assert.equal(regler.getAttribute('title'), 'dateien.kachelgroesse_erklaerung', 'Erklärung als Tooltip (Betreiber-Vorgabe: Info bei jeder Einstellung)');
  assert.equal(regler.getAttribute('aria-valuetext'), 'dateien.kachelgroesse_stufe:{"n":3,"max":6}');
  assert.equal(regler.getAttribute('aria-describedby'), 'dateien-kachelgroesse-erklaerung');
  assert.equal(wurzel.alle().find((k) => k.getAttribute('id') === 'dateien-kachelgroesse-erklaerung').textContent, 'dateien.kachelgroesse_erklaerung', 'Erklärung für Vorlesehilfen');
  // ein Bild ist geladen → beim Größenwechsel bleibt es stehen, bis das schärfere vorgeladen ist
  const foto = bilder(wurzel).find((b) => /Strand/.test(b.getAttribute('src')));
  foto.ausloesen('load');
  // größte Stufe: 340 px sofort, Bilder in 512 nach kurzer Ruhe (gebündelt); Hinweis einmal
  regler.value = '5'; regler.ausloesen('input');
  assert.equal(localStorage.getItem('fahnas_dateien_kachelgroesse'), '5');
  assert.equal(raster(wurzel).style.werte['--dateien-kachel-min'], '340px');
  assert.deepEqual(bilder(wurzel).map((b) => groesseAus(b.getAttribute('src'))), [256, 256], 'vor der Ruhe noch nicht neu gezeichnet');
  regler.value = '4'; regler.ausloesen('input'); regler.value = '5'; regler.ausloesen('input');
  await ruhe();
  const nachher = bilder(wurzel);
  const fotoNeu = nachher.find((b) => /Strand/.test(b.getAttribute('src')));
  const clipNeu = nachher.find((b) => /clip/.test(b.getAttribute('src')));
  assert.equal(groesseAus(clipNeu.getAttribute('src')), 512, 'nie geladenes Bild fragt direkt 512 an');
  assert.equal(groesseAus(fotoNeu.getAttribute('src')), 256, 'geladenes Bild bleibt (Cache), 512 wird vorgeladen');
  const lader = erzeugteImages.find((i) => /Strand/.test(i.src) && /groesse=512/.test(i.src));
  assert.ok(lader, 'Vorlader für das schärfere Bild');
  lader.laden();
  assert.equal(groesseAus(fotoNeu.getAttribute('src')), 512, 'nach dem Vorladen getauscht');
  assert.equal(regler.getAttribute('aria-valuetext'), 'dateien.kachelgroesse_stufe:{"n":6,"max":6}');
  assert.equal(meldungenVon(wurzel).length, 1, 'Erklärung einmal als Hinweis');
  assert.equal(localStorage.getItem('fahnas_dateien_kachelgroesse_hinweis'), '1');
  // zurück auf klein: 128 px, Bilder wieder 256 (liegen im Browser-Cache), kein weiterer Hinweis
  regler.value = '1'; regler.ausloesen('input'); await ruhe();
  assert.equal(raster(wurzel).style.werte['--dateien-kachel-min'], '128px');
  assert.deepEqual(bilder(wurzel).map((b) => groesseAus(b.getAttribute('src'))).sort(), [256, 256]);
  assert.equal(meldungenVon(wurzel).length, 1);
  // Listenansicht: Regler versteckt, keine Vorschaubilder; Kacheln: wieder da
  knopfMitTitel(wurzel, 'dateien.ansicht_liste').click();
  assert.equal(versteckt(feld), true);
  assert.equal(raster(wurzel), null); assert.equal(bilder(wurzel).length, 0);
  knopfMitTitel(wurzel, 'dateien.ansicht_kacheln').click();
  assert.equal(versteckt(feld), false);
  assert.equal(raster(wurzel).style.werte['--dateien-kachel-min'], '128px', 'Stufe bleibt');
  assert.equal(bilder(wurzel).length, 2);
});

test('Kacheln: gemerkte Stufe wird geladen (ungültige Werte → Standard), Listenansicht startet ohne Regler-Anzeige, hochauflösende Bildschirme bekommen 512 px', async () => {
  const a = await einbinden({ stufe: 4 });
  assert.equal(raster(a.wurzel).style.werte['--dateien-kachel-min'], '260px');
  assert.equal(String(a.wurzel.querySelector('.dateien-kachelgroesse-regler').value), '4');
  assert.deepEqual(bilder(a.wurzel).map((b) => groesseAus(b.getAttribute('src'))), [512, 512], '260 × 1,4 = 364 > 256');
  // Hinweis schon gezeigt (Gerät) → kein Toast mehr
  localStorage.setItem('fahnas_dateien_kachelgroesse_hinweis', '1');
  const reglerA = a.wurzel.querySelector('.dateien-kachelgroesse-regler'); reglerA.value = '5'; reglerA.ausloesen('input');
  assert.equal(a.meldungen.length, 0);
  const b = await einbinden({ stufe: 9 });
  assert.equal(raster(b.wurzel).style.werte['--dateien-kachel-min'], '160px');
  const leer = await einbinden({ stufe: '' });
  assert.equal(raster(leer.wurzel).style.werte['--dateien-kachel-min'], '160px', 'leerer Wert → Standard');
  assert.equal(raster(b.wurzel).style.werte['--dateien-kachel-min'], '160px');
  const c = await einbinden({ modus: 'liste' });
  assert.equal(versteckt(c.wurzel.querySelector('.dateien-kachelgroesse')), true);
  assert.equal(raster(c.wurzel), null);
  const d = await einbinden({ dpr: 2 });
  assert.deepEqual(bilder(d.wurzel).map((b) => groesseAus(b.getAttribute('src'))), [512, 512], 'Stufe 2 bei DPR 2: 160 × 1,4 × 2 = 448 → 512');
  // ohne vorschauUrl im Rahmen (älterer Rahmen): keine Bilder, keine Fehler
  const e = await einbinden({ ohneVorschauUrl: true });
  assert.equal(bilder(e.wurzel).length, 0); assert.equal(raster(e.wurzel).querySelectorAll('.dateien-kachel-bild').length, EINTRAEGE.length);
  // Freigabewurzel: Pfad ohne Unterordner
  const f = await einbinden({ teile: ['medien'] });
  assert.ok(bilder(f.wurzel).some((b) => /pfad=Strand\.JPG&/.test(b.getAttribute('src'))));
});

test('Kacheln: vorschauGroesseFuer und vorschauVersion (reine Funktionen)', async () => {
  dom();
  const m = await import(`${pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href}?n=${++laufnummer}`);
  assert.deepEqual(m.KACHEL_STUFEN, [96, 128, 160, 200, 260, 340]);
  assert.equal(m.vorschauGroesseFuer(2, 1), 256); assert.equal(m.vorschauGroesseFuer(0, 1), 256); assert.equal(m.vorschauGroesseFuer(5, 1), 512);
  assert.equal(m.vorschauGroesseFuer(2, 2), 512); assert.equal(m.vorschauGroesseFuer(5, 3), 512, 'Deckel 512');
  assert.equal(m.vorschauGroesseFuer(-3, 1), 256); assert.equal(m.vorschauGroesseFuer('x', 0), 256);
  assert.equal(m.vorschauVersion({ geaendert: '2026-09-02T10:00:00.000Z', groesse: 5 }), `${Date.parse('2026-09-02T10:00:00.000Z')}-5`);
  assert.equal(m.vorschauVersion({}), '0-0'); assert.equal(m.vorschauVersion(null), '0-0');
  // „Als Hintergrund“ nur für Bilder/Videos, die auch die Tapeten-Auswahl kennt (16.10.2026)
  for (const n of ['a.JPG', 'b.png', 'c.webp', 'd.gif', 'e.avif', 'f.mp4', 'g.WEBM']) assert.equal(m.alsTapeteTauglich({ art: 'datei', name: n }), true, n);
  for (const e of [{ art: 'datei', name: 'film.mkv' }, { art: 'datei', name: 'text.txt' }, { art: 'ordner', name: 'bilder.jpg' }, null]) assert.equal(m.alsTapeteTauglich(e), false, JSON.stringify(e));
});

test('Mehrfach-Umbenennen: Vorschau der Oberfläche rechnet wie der Dateihelfer', async () => {
  dom();
  const m = await import(`${pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href}?n=${++laufnummer}`);
  const helfer = await import(pathToFileURL(path.join(PUBLIC, '..', 'src', 'agent', 'helfer', 'dateihelfer.js')).href);
  const proben = [[{ alt: 'b.mkv' }, { alt: 'a.MP4' }, { alt: 'Ordner', ordner: true }, { alt: 'x.tar.gz' }, { alt: '.env' }, { alt: 'ohne' }, { alt: 'Plan.fahboard', ordner: true }, { alt: '.fahtab', ordner: true }], Array.from({ length: 101 }, (_, i) => ({ alt: `f${i}.jpg` }))];
  for (const p of proben) assert.deepEqual(m.serienNamen(p, '001'), helfer.serienNamen(p, '001'));
});
