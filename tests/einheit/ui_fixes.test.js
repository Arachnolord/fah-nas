// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests zu den Funden der Prüfung R3 (Oberfläche ↔ Web-API ↔ Agent, Bedienbarkeit), behoben von Fixer FX3:
// Kontraste der Stilvariablen (WCAG AA, eigener Kontrastrechner), Kartentabellen mit data-label auf dem Handy,
// GiB-Rechnung durchgängig, Netz-/Energie-/DNS-/Schnittstellen-Regeln gegen das Agenten-Schema, Dienst-Zustand,
// Update-Ergebnis mit Paketliste, Import-Dateifilter, Zurückholen mit `ueberschreiben` und Schreibrecht, Aufbewahrung
// 0 = Standard, Rechte im Dateimanager, Ersteinrichtung ohne zweite Anmeldung, kein „null“-Text, Sprache ohne
// Denglisch, Berührungsziele. Läuft ohne Browser (DOM-Attrappe nur so groß wie nötig).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.resolve(HIER, '..', '..');
const PUBLIC = path.join(WURZEL, 'public');
const lesen = (...p) => fs.readFile(path.join(PUBLIC, ...p), 'utf8');
const modul = (...p) => import(pathToFileURL(path.join(PUBLIC, ...p)).href);
const quelle = (...p) => import(pathToFileURL(path.join(WURZEL, 'src', ...p)).href);
const json = async (...p) => JSON.parse(await lesen(...p));

// ---------------------------------------------------------------------------------------------------------------------
// Kontrastrechner nach WCAG 2.x (relative Leuchtdichte, sRGB)
// ---------------------------------------------------------------------------------------------------------------------

export function hexZuRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function leuchtdichte([r, g, b]) {
  const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function kontrast(vorne, hinten) {
  const l1 = leuchtdichte(hexZuRgb(vorne)); const l2 = leuchtdichte(hexZuRgb(hinten));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Alle --fahnas-Farbvariablen eines Blocks (Beginn `start` bis zur ersten schließenden Klammer) */
function variablen(css, start) {
  const i = css.indexOf(start);
  assert.ok(i >= 0, `Block „${start}“ fehlt in stil.css`);
  const block = css.slice(i, css.indexOf('}', i));
  const aus = {};
  for (const m of block.matchAll(/(--fahnas-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) aus[m[1]] = m[2];
  return aus;
}

// Textfarbe auf Hintergrundfarbe – jede Paarung, die in stil.css als Text vorkommt, muss ≥ 4,5:1 erreichen
const KONTRAST_PAARE = [
  ['--fahnas-akzent-text', '--fahnas-akzent', 'Knopf-Text auf Akzent („Speichern“)'],
  ['--fahnas-akzent-text', '--fahnas-akzent-dunkel', 'Knopf-Text auf Akzent (hover)'],
  ['--fahnas-gefahr-text', '--fahnas-gefahr', 'Gefahr-Knopf („Löschen“, „Aus“, „Neu starten“)'],
  ['--fahnas-gefahr-text', '--fahnas-gefahr-dunkel', 'Gefahr-Knopf (hover)'],
  ['--fahnas-akzent', '--fahnas-flaeche', 'Akzent-Text/Links auf Fläche'],
  ['--fahnas-akzent', '--fahnas-hintergrund', 'Akzent-Text auf Hintergrund'],
  ['--fahnas-akzent-auf-hell', '--fahnas-akzent-hell', 'Plakette „ADMIN“, aktiver Navigationspunkt (Desktop)'],
  ['--fahnas-akzent-auf-hell', '--fahnas-flaeche', 'aktiver Navigationspunkt (Handy)'],
  ['--fahnas-text', '--fahnas-flaeche', 'Text auf Fläche'],
  ['--fahnas-text', '--fahnas-hintergrund', 'Text auf Hintergrund'],
  ['--fahnas-text', '--fahnas-flaeche-2', 'Text auf Fläche 2'],
  ['--fahnas-text', '--fahnas-akzent-hell', 'Hinweis info'],
  ['--fahnas-text', '--fahnas-warnung-hell', 'Hinweis Warnung'],
  ['--fahnas-text', '--fahnas-gefahr-hell', 'Hinweis Fehler'],
  ['--fahnas-text-schwach', '--fahnas-flaeche', 'Erklärtexte'],
  ['--fahnas-text-schwach', '--fahnas-flaeche-2', 'Plakette neutral'],
  ['--fahnas-text-schwach', '--fahnas-hintergrund', 'schwacher Text auf Hintergrund'],
  ['--fahnas-erfolg', '--fahnas-erfolg-hell', 'Plakette „aktiv“/Erfolg'],
  ['--fahnas-warnung', '--fahnas-warnung-hell', 'Plakette Warnung („Gäste“)'],
  ['--fahnas-gefahr', '--fahnas-gefahr-hell', 'Plakette Gefahr'],
  ['--fahnas-erfolg', '--fahnas-flaeche', 'Erfolgstext'],
  ['--fahnas-warnung', '--fahnas-flaeche', 'Warntext (Kachel)'],
  ['--fahnas-gefahr', '--fahnas-flaeche', 'Fehlertext (.feld-fehler, .vw-rot)'],
  ['--fahnas-hintergrund', '--fahnas-text', 'Toast'],
];

test('Fund 10 – Kontraste: alle Textpaarungen der Stilvariablen erreichen WCAG AA (≥ 4,5:1) in hell und dunkel; beide Dunkel-Blöcke gleich', async () => {
  const css = await lesen('stil.css');
  const hell = variablen(css, ':root {');
  const dunkelMedia = variablen(css, ':root:not([data-design="hell"]) {');
  const dunkel = variablen(css, ':root[data-design="dunkel"] {');
  assert.deepEqual(dunkelMedia, dunkel, 'prefers-color-scheme-Block und [data-design="dunkel"] müssen dieselben Farben tragen');
  // Rechner-Selbsttest mit bekannten Werten
  assert.equal(Math.round(kontrast('#ffffff', '#000000') * 10) / 10, 21);
  assert.ok(Math.abs(kontrast('#ffffff', '#ef6b6b') - 3.01) < 0.05, 'alter Gefahr-Knopf dunkel: 3,0:1 (R3-Messung)');
  assert.ok(Math.abs(kontrast('#0e8a8a', '#ffffff') - 4.18) < 0.05, 'alter Akzent hell auf Weiß: 4,2:1 (R3-Messung)');
  for (const [name, satz] of [['hell', hell], ['dunkel', dunkel]]) {
    for (const [vorne, hinten, wo] of KONTRAST_PAARE) {
      assert.ok(satz[vorne], `${name}: ${vorne} fehlt`); assert.ok(satz[hinten], `${name}: ${hinten} fehlt`);
      const k = kontrast(satz[vorne], satz[hinten]);
      assert.ok(k >= 4.5, `${name}: ${wo} – ${vorne} ${satz[vorne]} auf ${hinten} ${satz[hinten]} nur ${k.toFixed(2)}:1`);
    }
  }
  // Die Regeln nutzen die neuen Variablen (keine feste weiße Schrift mehr auf Gefahr)
  assert.match(css, /\.knopf-gefahr \{ background: var\(--fahnas-gefahr\); color: var\(--fahnas-gefahr-text\); \}/);
  assert.match(css, /\.knopf-gefahr:hover \{ background: var\(--fahnas-gefahr-dunkel\)/);
  assert.match(css, /\.toast-fehler \{ background: var\(--fahnas-gefahr\); color: var\(--fahnas-gefahr-text\); \}/);
  assert.match(css, /\.kopf-rolle \{[^}]*color: var\(--fahnas-akzent-auf-hell\)/);
  assert.match(css, /\.navigation-eintrag\[aria-current="page"\] \{ color: var\(--fahnas-akzent-auf-hell\)/);
  assert.match(css, /\.plakette-akzent \{[^}]*color: var\(--fahnas-akzent-auf-hell\)/);
  // Plakette mindestens 12 px (0,8rem bei 15px Grundschrift)
  const rolle = /\.kopf-rolle \{[^}]*font-size: ([0-9.]+)rem/.exec(css);
  assert.ok(rolle && Number(rolle[1]) * 15 >= 12, `.kopf-rolle zu klein: ${rolle && rolle[1]}rem`);
});

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe (nur so viel, wie el()/anhaengen()/tabelle() und der Rahmen beim Import brauchen)
// ---------------------------------------------------------------------------------------------------------------------

class Knoten { constructor() { this.childNodes = []; this.parentNode = null; } get isConnected() { return false; } }
class TextKnoten extends Knoten { constructor(t) { super(); this.nodeType = 3; this.textContent = String(t); } }
class Element extends Knoten {
  constructor(tag, ns) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.namespaceURI = ns || null; this.attribute = new Map(); this.dataset = {}; this.hoerer = {};
    this.style = { setProperty() {} };
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
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { this.childNodes = v === '' ? [] : [new TextKnoten(v)]; }
  appendChild(k) { k.parentNode = this; this.childNodes.push(k); return k; }
  removeChild(k) { this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  hasAttribute(k) { return this.attribute.has(k); }
  removeAttribute(k) { this.attribute.delete(k); }
  addEventListener(art, fn) { (this.hoerer[art] ||= []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
}
function dom() {
  const dokument = {
    documentElement: new Element('html'), body: new Element('body'), head: new Element('head'), cookie: '', title: '',
    createElement: (t) => new Element(t), createElementNS: (ns, t) => new Element(t, ns), createTextNode: (t) => new TextKnoten(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  };
  globalThis.Node = Knoten;
  globalThis.HTMLFormElement = class {};
  globalThis.document = dokument;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', href: 'http://nas.local/', origin: 'http://nas.local', replace() {} };
  const speicher = new Map();
  globalThis.localStorage = { getItem: (k) => (speicher.has(k) ? speicher.get(k) : null), setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  return dokument;
}

test('Fund 9 – Tabellen werden Kartentabellen (.tabelle-karten) mit data-label je Zelle aus der Spaltenüberschrift; eigene data-label bleiben; Aktionen umbrechend', async () => {
  dom();
  const h = await modul('ansichten', 'verwaltung-hilfen.js');
  const tab = h.tabelle([{ text: 'Name' }, { text: 'Rolle' }, { text: 'Aktionen' }], [], { klasse: 'nu-tabelle' });
  assert.ok(tab.tabelle.classList.contains('tabelle-karten'), 'Standard: Kartentabelle');
  assert.ok(tab.tabelle.classList.contains('nu-tabelle'));
  const eigene = h.el('td', { klasse: 'vw-aktionen' }); eigene.dataset.label = 'Eigen';
  const tr = h.tabellenzeile(tab.koerper, ['fabian', '', eigene]);
  const tds = tr.children;
  assert.equal(tds.length, 3);
  assert.equal(tds[0].dataset.label, 'Name'); assert.equal(tds[1].dataset.label, 'Rolle'); assert.equal(tds[2].dataset.label, 'Eigen');
  assert.equal(tds[1].childNodes.length, 0, 'leere Zelle bekommt keinen leeren Textknoten – td:empty blendet sie auf dem Handy aus');
  const ohne = h.tabelle([{ text: 'A' }], [], { karten: false });
  assert.ok(!ohne.tabelle.classList.contains('tabelle-karten'));
  const css = await lesen('ansichten', 'verwaltung-hilfen.css');
  const handy = css.slice(css.indexOf('@media (max-width: 719px)'));
  assert.match(handy, /\.vw-tabelle\.tabelle-karten td \{ white-space: normal/, 'nowrap der Ansichten wird auf dem Handy aufgehoben');
  assert.match(handy, /\.vw-tabelle\.tabelle-karten td\.vw-aktionen \{ display: flex; flex-wrap: wrap/);
  assert.match(handy, /\.vw-tabelle\.tabelle-karten td:empty \{ display: none; \}/);
  for (const [datei, klasse] of [['nutzer.js', 'nu-tabelle'], ['snapshots.js', 'sn-tabelle'], ['system.js', 'sy-protokoll'], ['system.js', 'sy-smart']]) {
    assert.ok((await lesen('ansichten', datei)).includes(`klasse: '${klasse}'`), `${datei}: Tabelle ${klasse} über tabelle() gebaut`);
  }
});

test('Fund 5 – Rolle nutzer: keine „null“-Textknoten – Ansichten hängen ihre Karten über anhaengen() an (überspringt null/leer)', async () => {
  dom();
  const h = await modul('ansichten', 'verwaltung-hilfen.js');
  const w = h.el('div');
  h.anhaengen(w, [h.el('p', { text: 'a' }), null, undefined, false, '', h.el('p', { text: 'b' })]);
  assert.equal(w.childNodes.length, 2);
  assert.ok(!w.textContent.includes('null'));
  for (const d of ['nutzer.js', 'snapshots.js']) {
    const q = (await lesen('ansichten', d)).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/wurzel\.append\(/.test(q), `${d}: wurzel.append(null) würde den Text „null“ schreiben`);
    assert.ok(/anhaengen\(wurzel, \[/.test(q), `${d}: nutzt anhaengen()`);
  }
});

test('Fund 6 – GiB durchgängig: Rahmen und Verwaltungsformatierer rechnen binär (KiB/MiB/GiB), Freigabe-Kontingent = groesse_gb × 1024³', async () => {
  dom();
  const app = await modul('app.js');
  app._test.setzeT(Object.assign((k) => k, { hat: () => true }));
  assert.equal(app.format.groesse(500 * 1024 ** 3), '500 GiB');
  assert.equal(app.format.groesse(1536), '1,5 KiB');
  const h = await modul('ansichten', 'verwaltung-hilfen.js');
  assert.equal(h.GIB, 1024 ** 3);
  assert.equal(h.groesseFormat(500 * 1024 ** 3), '500 GiB'); assert.equal(h.groesseFormat(1536), '1,5 KiB'); assert.equal(h.groesseFormat(1000), '1000 B');
  const fg = await modul('ansichten', 'freigaben.js');
  assert.equal(fg.kontingentBytes(500), 500 * 1024 ** 3); assert.equal(fg.kontingentBytes(0), 0); assert.equal(fg.kontingentBytes(null), 0); assert.equal(fg.kontingentBytes('12'), 12 * 1024 ** 3);
  assert.equal(h.groesseFormat(fg.kontingentBytes(500)), '500 GiB', 'Freigabekarte zeigt „von 500 GiB“ – nicht mehr „466 GB“');
  assert.equal(app.format.groesse(fg.kontingentBytes(500)), '500 GiB', 'Dateien-Ansicht (Rahmen-Formatierer) zeigt denselben Wert');
  const texte = await json('sprache', 'de', 'freigaben.json');
  assert.match(texte.kontingent, /GiB/); assert.match(texte.kontingent_erklaerung, /1024/);
  for (const d of [['app.js'], ['ansichten', 'verwaltung-hilfen.js'], ['ansichten', 'freigaben.js'], ['ansichten', 'dateien.js'], ['ansichten', 'dashboard.js']]) {
    const q = await lesen(...d);
    assert.ok(!/\b1e9\b|1000 \*\* 3/.test(q), `${d.join('/')}: keine 10⁹-Rechnung`);
    assert.ok(!/'GB'|"GB"/.test(q), `${d.join('/')}: keine Einheit „GB“`);
  }
});

test('Funde 2/3/7/11/13/16/18/20 – system.js: Netz-Parameter ohne null, Schnittstelle ≤ 15, DNS ≤ 3, Platten-Ruhe ≤ 330, Import-Filter, Dienst-Zustand, eingespielt-Liste, kein .feld am Eingabeelement', async () => {
  const s = await modul('ansichten', 'system.js');
  // Netz: Automatisch/DHCP → nur modus, schnittstelle (''), dns; keine null-Werte (fielen in pruefe() weg, alte Werte blieben)
  const dhcp = s.netzParams({ modus: 'dhcp', schnittstelle: null, adresse: '192.168.1.50/24', gateway: null, dns: [] });
  assert.deepEqual(dhcp, { modus: 'dhcp', schnittstelle: '', dns: [] });
  const statisch = s.netzParams({ modus: 'statisch', schnittstelle: ' enp1s0 ', adresse: '192.168.1.50/24', gateway: '', dns: ['192.168.1.1', ' 1.1.1.1 '] });
  assert.deepEqual(statisch, { modus: 'statisch', schnittstelle: 'enp1s0', dns: ['192.168.1.1', '1.1.1.1'], adresse: '192.168.1.50/24', gateway: '' });
  for (const p of [dhcp, statisch]) assert.ok(!Object.values(p).includes(null) && !Object.values(p).includes(undefined), 'kein null/undefined');
  // Gegen das echte Agenten-Schema (system.setzen): alle gesendeten Felder überleben pruefe()
  const { Register } = await quelle('agent', 'register.js');
  const reg = new Register();
  const werkzeuge = { konfig: {}, system: {}, pfade: {}, konfigGeaendert() {}, ereignis() {}, intern() {}, version: () => '0' };
  (await quelle('agent', 'aktionen', 'system.js')).registriere(reg, werkzeuge);
  const admin = { nutzer: 'fabian', rolle: 'admin', ip: '-' };
  for (const netz of [dhcp, statisch]) {
    const { params } = reg.vorbereiten('system.setzen', { aenderungen: { netz: structuredClone(netz) } }, admin);
    assert.deepEqual(Object.keys(params.aenderungen.netz).sort(), Object.keys(netz).sort(), 'kein Netz-Feld geht in pruefe() verloren');
  }
  assert.doesNotThrow(() => reg.vorbereiten('system.setzen', { aenderungen: { energie: { platten_ruhe_min: s.MAX_PLATTEN_RUHE, zeitplan: [] } } }, admin), 'Oberflächen-Maximum wird vom Agenten akzeptiert');
  assert.throws(() => reg.vorbereiten('system.setzen', { aenderungen: { energie: { platten_ruhe_min: s.MAX_PLATTEN_RUHE + 1, zeitplan: [] } } }, admin), /zu groß/, 'darüber lehnt der Agent ab – die Oberfläche lässt es nicht zu');
  assert.throws(() => reg.vorbereiten('system.setzen', { aenderungen: { netz: { modus: 'statisch', dns: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '10.0.0.1'] } } }, admin), /zu viele/);
  assert.throws(() => reg.vorbereiten('system.setzen', { aenderungen: { netz: { modus: 'statisch', schnittstelle: 'enp0s31f6-lang-name' } } }, admin), /zu lang/);
  assert.equal(s.MAX_DNS, 3); assert.equal(s.MAX_PLATTEN_RUHE, 330);
  assert.equal(s.MUSTER_SCHNITTSTELLE.test('enx00e04c6800aa'), true); assert.equal(s.MUSTER_SCHNITTSTELLE.test('enp0s31f6-lang-name'), false); assert.equal(s.MUSTER_SCHNITTSTELLE.test('eth0.100'), true); assert.equal(s.MUSTER_SCHNITTSTELLE.test(''), false);
  // Import-Filter: Export erzeugt .tar / .tar.fahnas, kein .zst
  assert.match(s.IMPORT_ACCEPT, /(^|,)\.tar\.fahnas(,|$)/); assert.match(s.IMPORT_ACCEPT, /(^|,)\.tar(,|$)/); assert.match(s.IMPORT_ACCEPT, /(^|,)\.fahnas(,|$)/); assert.ok(!/zst/.test(s.IMPORT_ACCEPT));
  // Dienst: Agent liefert künftig aktiv|inaktiv|fehler; alte Form an|aus|neustart wird zugeordnet
  assert.equal(s.dienstZustand({ zustand: 'aktiv' }, 'an'), 'aktiv'); assert.equal(s.dienstZustand({ zustand: 'inaktiv' }, 'aus'), 'inaktiv'); assert.equal(s.dienstZustand({ zustand: 'fehler' }, 'an'), 'fehler');
  assert.equal(s.dienstZustand({ zustand: 'an' }, 'an'), 'aktiv'); assert.equal(s.dienstZustand({ zustand: 'aus' }, 'aus'), 'inaktiv'); assert.equal(s.dienstZustand({ zustand: 'neustart' }, 'neustart'), 'aktiv');
  assert.equal(s.dienstZustand(null, 'aus'), 'inaktiv'); assert.equal(s.dienstZustand({}, 'an'), 'aktiv');
  // eingespielt ist eine Paketliste → Anzahl = Länge, Liste wird gezeigt; Zahl und Rückfall bleiben möglich
  assert.deepEqual(s.eingespieltAuswerten({ eingespielt: ['samba', 'linux-image-generic', 'nodejs'], anzahl: 3 }, 5), { anzahl: 3, pakete: ['samba', 'linux-image-generic', 'nodejs'] });
  assert.deepEqual(s.eingespieltAuswerten({ eingespielt: [], anzahl: 0 }, 5), { anzahl: 0, pakete: [] });
  assert.deepEqual(s.eingespieltAuswerten({ eingespielt: 3 }, 5), { anzahl: 3, pakete: [] });
  assert.deepEqual(s.eingespieltAuswerten({ anzahl: 2 }, 5), { anzahl: 2, pakete: [] });
  assert.deepEqual(s.eingespieltAuswerten(null, 5), { anzahl: 5, pakete: [] });
  assert.ok(Number.isNaN(Number(['a', 'b'])), 'Gegenprobe: Number(Liste) ist NaN – so war der alte Fehler');
  // Quelle: keine alten Grenzen, keine Wrapper-Klasse am Eingabeelement, keine erfundene Endung
  const q = await lesen('ansichten', 'system.js');
  assert.ok(!/1440/.test(q), 'kein 1440 mehr'); assert.ok(!/maxlength: 32/.test(q));
  assert.ok(!/klasse: 'feld vw-eingabe/.test(q) && !/klasse: 'feld /.test(q), 'Wrapper-Klasse .feld nur am Wrapper');
  assert.ok(!/tar\.zst/.test(q));
  assert.ok(q.includes('netzKarteErneuern()'), 'Netz-Karte wird nach der Antwort neu aufgebaut');
  assert.ok(q.includes('dnsListe.length > MAX_DNS') && q.includes('MUSTER_SCHNITTSTELLE.test(w)'), 'Prüfregeln DNS/Schnittstelle im Formular');
  const texte = await json('sprache', 'de', 'system.json');
  assert.match(texte.energie_fehler, /\{max\}/); assert.match(texte.energie_platten_erklaerung, /\{max\}/); assert.match(texte.energie_platten_erklaerung, /5,5 Stunden/);
  assert.match(texte.netz_dns_erklaerung, /höchstens drei/); assert.ok(texte.netz_dns_zuviele.includes('{max}'));
  assert.match(texte.netz_schnittstelle_erklaerung, /15 Zeichen/); assert.ok(texte.netz_schnittstelle_fehler);
  assert.match(texte.import_datei_erklaerung, /fahnas-export-….tar/); assert.match(texte.import_datei_erklaerung, /tar\.fahnas/); assert.ok(!/zst/.test(texte.import_datei_erklaerung));
  assert.ok(texte.updates_eingespielt_liste.includes('{liste}'));
});

test('Funde 1/4/17 – snapshots.js: Zurückholen sendet ueberschreiben nur mit „Vorhandene ersetzen“; Aufbewahrung 0 = Standard (24/7/4/10); Zurückholen nur mit Schreibrecht', async () => {
  const sn = await modul('ansichten', 'snapshots.js');
  const ohne = sn.zurueckholenParams({ freigabe: 'medien', id: '2026-09-25T08-30-00-plan', pfade: ['Fotos/2025/a.jpg'], zielPfad: '/Fotos/', ersetzen: false });
  assert.deepEqual(ohne, { freigabe: 'medien', id: '2026-09-25T08-30-00-plan', pfade: ['Fotos/2025/a.jpg'], ziel_pfad: 'Fotos', ueberschreiben: false });
  const mit = sn.zurueckholenParams({ freigabe: 'medien', id: 'x', pfade: ['a'], zielPfad: '', ersetzen: true });
  assert.equal(mit.ueberschreiben, true); assert.equal(mit.ziel_pfad, '');
  assert.equal(sn.zurueckholenParams({ freigabe: 'm', id: 'x', pfade: [], zielPfad: '', ersetzen: 'ja' }).ueberschreiben, false, 'nur echtes true');
  // Gegen das echte Agenten-Schema (snapshots.zurueckholen kennt ueberschreiben)
  const { Register } = await quelle('agent', 'register.js');
  const reg = new Register();
  const werkzeuge = { konfig: {}, system: {}, pfade: {}, konfigGeaendert() {}, ereignis() {}, intern() {}, version: () => '0' };
  (await quelle('agent', 'aktionen', 'snapshots.js')).registriere(reg, werkzeuge);
  const nutzer = { nutzer: 'anna', rolle: 'nutzer', ip: '-' };
  assert.equal(reg.vorbereiten('snapshots.zurueckholen', structuredClone(ohne), nutzer).params.ueberschreiben, false);
  assert.equal(reg.vorbereiten('snapshots.zurueckholen', structuredClone(mit), nutzer).params.ueberschreiben, true);
  // Aufbewahrung: Felder zeigen die wirksamen Werte; 0/fehlend = Standard des Agenten
  assert.deepEqual(sn.BEHALTEN_STANDARD, { stuendlich: 24, taeglich: 7, woechentlich: 4, monatlich: 12, pre_post: 10 });
  assert.deepEqual(sn.PLAN_STANDARD.behalten, sn.BEHALTEN_STANDARD);
  assert.deepEqual(sn.wirksamBehalten({ stuendlich: 0, taeglich: 14 }), { stuendlich: 24, taeglich: 14, woechentlich: 4, monatlich: 12, pre_post: 10 });
  // Zeitplan 0.32.0: Anzahl ↔ Frist je Takt, ältester Stand
  assert.deepEqual(sn.fristAusAnzahl('taeglich', 7), { wert: 1, einheit: 'woche' });
  assert.deepEqual(sn.fristAusAnzahl('taeglich', 30), { wert: 1, einheit: 'monat' });
  assert.deepEqual(sn.fristAusAnzahl('taeglich', 10), { wert: 10, einheit: 'tag' });
  assert.deepEqual(sn.fristAusAnzahl('woechentlich', 4), { wert: 4, einheit: 'woche' });
  assert.deepEqual(sn.fristAusAnzahl('monatlich', 12), { wert: 1, einheit: 'jahr' });
  assert.deepEqual(sn.fristAusAnzahl('stuendlich', 24), { wert: 1, einheit: 'tag' });
  assert.equal(sn.anzahlAusFrist('taeglich', 2, 'woche'), 14);
  assert.equal(sn.anzahlAusFrist('taeglich', 1, 'jahr'), 365);
  assert.equal(sn.anzahlAusFrist('woechentlich', 1, 'jahr'), 52);
  assert.equal(sn.anzahlAusFrist('monatlich', 2, 'jahr'), 24);
  assert.equal(sn.anzahlAusFrist('stuendlich', 0, 'tag'), 1, 'mindestens 1');
  assert.equal(sn.anzahlAusFrist('stuendlich', 1000, 'woche'), 1000, 'höchstens 1000');
  assert.deepEqual(sn.aeltesterStand({ taeglich: true, monatlich: true }, { taeglich: 7, monatlich: 12 }), { wert: 1, einheit: 'jahr' });
  assert.equal(sn.aeltesterStand({}, {}), null);
  assert.deepEqual(sn.wirksamBehalten(undefined), sn.BEHALTEN_STANDARD);
  assert.equal(sn.planFuer({ plaene: [{ ziel: 'medien', zeitplan: { stuendlich: true }, behalten: { stuendlich: 0 } }] }, 'medien').behalten.stuendlich, 24, 'Stündlich an + 0 → es bleiben 24 Stände, und genau das steht im Feld');
  // Schreibrecht: dateien.liste hat Vorrang (kennt Gruppen), sonst Rückfall aus freigaben.liste
  assert.equal(sn.schreibrechtAusListe({ schreiben: ['fabian'] }, 'anna'), false);
  assert.equal(sn.schreibrechtAusListe({ schreiben: ['fabian'] }, 'fabian'), true);
  assert.equal(sn.schreibrechtAusListe({ schreiben: ['@familie'] }, 'anna'), true, 'Gruppenmitgliedschaft unbekannt → anbieten, Agent entscheidet');
  assert.equal(sn.schreibrechtAusListe({ schreiben: [] }, 'anna', true), true, 'Admin immer');
  const ctxNein = { api: async (aktion) => (aktion === 'dateien.liste' ? { eintraege: [], schreiben: false, papierkorb: true } : null), nutzer: 'fabian' };
  assert.equal(await sn.schreibrechtPruefen(ctxNein, 'medien', [{ name: 'medien', schreiben: ['fabian'] }], false), false, 'dateien.liste sagt nein – auch wenn die Liste ja sagt');
  const ctxJa = { api: async () => ({ eintraege: [], schreiben: true }), nutzer: 'anna' };
  assert.equal(await sn.schreibrechtPruefen(ctxJa, 'medien', [{ name: 'medien', schreiben: ['fabian'] }], false), true);
  const ctxFehlt = { api: async () => { throw new Error('unbekannt'); }, nutzer: 'anna' };
  assert.equal(await sn.schreibrechtPruefen(ctxFehlt, 'medien', [{ name: 'medien', schreiben: ['fabian'] }], false), false);
  assert.equal(await sn.schreibrechtPruefen(ctxFehlt, 'medien', [], true), true);
  const q = await lesen('ansichten', 'snapshots.js');
  assert.ok(q.includes('holenKnopf.hidden = !ja'), 'Knopf „Zurückholen nach …“ ohne Schreibrecht ausgeblendet');
  assert.ok(q.includes("t('snapshots.zurueckholen_ersetzen')"), 'Schalter „Vorhandene ersetzen“ im Dialog');
  const texte = await json('sprache', 'de', 'snapshots.json');
  assert.ok(!/werden überschrieben/.test(texte.zurueckholen_erklaerung), 'Erklärtext verspricht kein Überschreiben mehr');
  assert.match(texte.zurueckholen_erklaerung, /bleiben unverändert/);
  for (const k of ['zurueckholen_ersetzen', 'zurueckholen_ersetzen_erklaerung', 'zurueckholen_kein_recht']) assert.ok(texte[k], `snapshots.${k} fehlt`);
  assert.match(texte.plan_behalten_erklaerung, /Frist = wie weit/); assert.ok(!/keine behalten/.test(texte.plan_behalten_erklaerung));
});

test('Fund 15 – freigaben.js: Beschreibung wird vorab wie beim Agenten geprüft (samba.MUSTER_WERT), Erklärtext nennt die Regel, Fokus bei details.feld beschreibung', async () => {
  const fg = await modul('ansichten', 'freigaben.js');
  const samba = await quelle('agent', 'render', 'samba.js');
  assert.equal(fg.MUSTER_BESCHREIBUNG.source, samba.MUSTER_WERT.source, 'gleiches Muster wie der Agent');
  assert.equal(fg.MUSTER_BESCHREIBUNG.test('Filme, Musik & Fotos "für alle"'), false);
  assert.equal(fg.MUSTER_BESCHREIBUNG.test('Zeile\nzwei'), false);
  assert.equal(fg.MUSTER_BESCHREIBUNG.test('Filme, Musik & Fotos für alle – äöü ‚so‘'), true);
  assert.equal(fg.MUSTER_BESCHREIBUNG.test(''), true);
  const q = await lesen('ansichten', 'freigaben.js');
  assert.ok(q.includes("{ eingabe: beschreibung, pruefen: (w) => (MUSTER_BESCHREIBUNG.test(w) ? null : t('freigaben.beschreibung_fehler')) }"), 'Prüfregel im Dialog');
  assert.ok(q.includes("feldName === 'beschreibung') beschreibung.focus()"), 'Fokus nach Serverfehler');
  const texte = await json('sprache', 'de', 'freigaben.json');
  assert.match(texte.beschreibung_erklaerung, /Anführungszeichen/); assert.match(texte.beschreibung_fehler, /Zeilenumbrüche/);
});

test('Funde 8/19 – dateien.js: schreiben/papierkorb aus dateien.liste schalten Knöpfe, Menü, Ablage und Tasten; Sprache ohne Downloads/Uploads', async () => {
  dom();
  const d = await modul('ansichten', 'dateien.js');
  assert.deepEqual(d.rechteAus({ eintraege: [], schreiben: false, papierkorb: false }, null), { schreiben: false, papierkorb: false });
  assert.deepEqual(d.rechteAus({ eintraege: [], schreiben: true, papierkorb: true }, { papierkorb: false }), { schreiben: true, papierkorb: true }, 'dateien.liste hat Vorrang vor freigaben.liste');
  assert.deepEqual(d.rechteAus({ eintraege: [] }, { papierkorb: false }), { schreiben: true, papierkorb: false }, 'ohne Feld: schreiben erlaubt, Papierkorb laut Freigabe');
  assert.deepEqual(d.rechteAus(null, null), { schreiben: true, papierkorb: true });
  const q = await lesen('ansichten', 'dateien.js');
  for (const s of [
    'knoten.hochladenKnopf.hidden = !rechte.schreiben', 'knoten.ordnerKnopf.hidden = !rechte.schreiben', 'knoten.papierkorbKnopf.hidden = !rechte.papierkorb',
    "if (rechte.schreiben) liste.appendChild(eintrag('umbenennen'", "if (rechte.schreiben) liste.appendChild(eintrag('verschieben'", "if (rechte.schreiben) liste.appendChild(eintrag('loeschen'",
    "if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => verschiebenKopieren('verschieben'",
    "if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => (einer ? umbenennen(einer) : umbenennenSerie())", "if (rechte.schreiben) l.appendChild(el('button', { class: 'knopf knopf-zweit knopf-gefahr'",
    'rechte.schreiben && ev.dataTransfer', "!papierkorb && rechte.schreiben) { ev.preventDefault(); loeschen(ziele); }", "case 'F2': if (e && !papierkorb && rechte.schreiben)",
    'const mitPapierkorb = rechte.papierkorb;', 'rechte = { ...rechteAus(',
  ]) assert.ok(q.includes(s), `dateien.js: „${s}“ fehlt`);
  assert.ok(!/downloads_gestartet|uploads_stand|'dateien\.uploads'/.test(q), 'alte Schlüssel weg');
  const texte = await json('sprache', 'de', 'dateien.json');
  for (const [k, v] of Object.entries(texte)) assert.ok(!/\b(Download|Upload)s?\b/.test(v), `${k}: Denglisch „${v}“`);
  assert.equal(texte['dateien.hochladen_stand'], 'Hochladen: {fertig} von {gesamt} fertig');
  const { erzeugeT } = await modul('sprache.js');
  const t = erzeugeT({ 'dateien.herunterladen_gestartet': texte['dateien.herunterladen_gestartet'] });
  assert.equal(t('dateien.herunterladen_gestartet', { n: 2 }), '2 Dateien werden heruntergeladen.');
  assert.equal(t('dateien.herunterladen_gestartet', { n: 1 }), '1 Datei wird heruntergeladen.');
});

test('Fund 14 – ersteinrichtung.js: keine zweite Anmeldung, wenn POST /api/ersteinrichtung schon angemeldet:true liefert; sonst wie bisher', async () => {
  const e = await modul('ansichten', 'ersteinrichtung.js');
  const daten = { startcode: 'AB12CD34', name: 'fabian', passwort: 'geheim123', anzeigename: 'Fabian' };
  const aufrufe = [];
  const ctx = { post: async (pfad) => { aufrufe.push(pfad); return pfad === '/api/ersteinrichtung' ? { angelegt: true, angemeldet: true } : { ok: true }; } };
  assert.deepEqual(await e.ersteinrichtungAbschliessen(ctx, daten), { angemeldet: true, zweiteAnmeldung: false, uebernommen: false });
  assert.deepEqual(aufrufe, ['/api/ersteinrichtung'], 'genau eine Sitzung');
  const aufrufe2 = [];
  const ctx2 = { post: async (pfad, body) => { aufrufe2.push([pfad, body]); return { ok: true, ergebnis: pfad === '/api/ersteinrichtung' ? { angelegt: true } : { ok: true } }; } };
  assert.deepEqual(await e.ersteinrichtungAbschliessen(ctx2, daten), { angemeldet: true, zweiteAnmeldung: true });
  assert.deepEqual(aufrufe2.map((a) => a[0]), ['/api/ersteinrichtung', '/api/anmelden']);
  assert.deepEqual(aufrufe2[1][1], { name: 'fabian', passwort: 'geheim123', angemeldet_bleiben: false });
  const ctx3 = { post: async (pfad) => { if (pfad === '/api/anmelden') throw Object.assign(new Error('Zu viele Versuche'), { code: 'E_BREMSE' }); return { angelegt: true }; } };
  assert.deepEqual(await e.ersteinrichtungAbschliessen(ctx3, daten), { angemeldet: false, zweiteAnmeldung: true });
  const q = await lesen('ansichten', 'ersteinrichtung.js');
  assert.equal((q.match(/'\/api\/anmelden'/g) || []).length, 1, 'nur ein Anmelde-Aufruf im Modul (in ersteinrichtungAbschliessen)');
});

test('Funde 12/21 – Handy-Stil: Berührungsziele ≥ 44 px im Dateimanager, kleine Knöpfe ≥ 40 px, Startmenü- und Gruppenliste umbrechend', async () => {
  const dateien = await lesen('ansichten', 'dateien.css');
  const handy = dateien.slice(dateien.indexOf('@media (max-width: 719px)'));
  assert.match(handy, /\.dateien-eintrag-name \.dateien-eintrag-text \{[^}]*min-height: 44px/);
  assert.match(handy, /\.dateien-eintrag-name \.dateien-eintrag-text \{[^}]*padding: 11px 0; margin: -11px 0/, 'Polster ohne Zeilenwachstum');
  assert.match(handy, /\.dateien-baum-auf, \.dateien-baum-platz \{ width: 44px; height: 44px; \}/);
  const stil = await lesen('stil.css');
  assert.match(stil.slice(stil.indexOf('@media (max-width: 719px)')), /\.knopf-klein \{ min-height: 40px; \}/);
  const vw = await lesen('ansichten', 'verwaltung-hilfen.css');
  assert.match(vw, /@media \(max-width: 719px\) \{ \.vw-pfadleiste \.knopf \{ min-height: 40px; \} \}/);
  const sn = await lesen('ansichten', 'snapshots.css');
  assert.match(sn, /\.sn-startmenue li \{ flex-wrap: wrap; \}/); assert.match(sn, /\.sn-startmenue li > \.vw-liste-name \{ flex: 1 1 100%/);
  const nu = await lesen('ansichten', 'nutzer.css');
  assert.match(nu, /\.nu-gruppen li \{ flex-wrap: wrap; \}/);
  assert.ok((await lesen('ansichten', 'snapshots.js')).includes("'vw-liste sn-startmenue'"));
  assert.ok((await lesen('ansichten', 'nutzer.js')).includes("'vw-liste nu-gruppen'"));
});
