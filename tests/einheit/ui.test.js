// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests der Oberfläche (Teil E) ohne Browser: Syntax aller public-Skripte, Sprachschlüssel, JSON-Dateien,
// index.html ohne Inline-Skript/-Stil, Stilvariablen/-klassen laut Schnittstellen §8, Rahmen-Helfer mit DOM-Attrappe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.resolve(HIER, '..', '..');
const PUBLIC = path.join(WURZEL, 'public');
const SPRACHE = path.join(PUBLIC, 'sprache', 'de');
const TEIL_E_SPRACHE = ['gemeinsam', 'dashboard', 'dateien'];
const TEIL_E_JS = new Set(['app.js', 'api.js', 'sprache.js', 'ansichten/index.js', 'ansichten/dashboard.js', 'ansichten/dateien.js', 'ansichten/weltkarte.js']);
const KOPF = 'Erdacht und programmiert von Fabian Hammer';

async function dateienUnter(ordner, endungen) {
  const aus = [];
  async function lauf(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await lauf(p);
      else if (endungen.some((x) => e.name.endsWith(x))) aus.push(p);
    }
  }
  await lauf(ordner);
  return aus.sort();
}

function nodeCheck(datei) {
  return new Promise((ok) => {
    execFile(process.execPath, ['--check', datei], { timeout: 20_000 }, (fehler, _stdout, stderr) => ok({ ok: !fehler, stderr: String(stderr || (fehler && fehler.message) || '') }));
  });
}

/** Sucht alle t(…)-Aufrufe und liefert feste Schlüssel sowie Vorsilben von Vorlagen (t(`a.b_${x}`)). Kommentare zählen nicht. */
export function tSchluessel(quelleRoh) {
  const quelle = quelleRoh.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fest = new Set(); const vorsilben = new Set();
  const re = /(?<![A-Za-z0-9_$])t\(/g;
  let m;
  while ((m = re.exec(quelle))) {
    let i = m.index + m[0].length; let tiefe = 0; let arg = '';
    for (; i < quelle.length; i++) {
      const c = quelle[i];
      if (c === '(' || c === '[' || c === '{') tiefe++;
      else if (c === ')' || c === ']' || c === '}') { if (tiefe === 0) break; tiefe--; }
      else if (c === ',' && tiefe === 0) break;
      arg += c;
    }
    // Nur Texte der Form bereich.schluessel zählen – 'admin' in t(x === 'admin' ? 'a.b' : 'a.c') ist kein Schlüssel.
    for (const q of arg.matchAll(/(['"])([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\1/g)) fest.add(q[2]);
    for (const q of arg.matchAll(/`([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]*)\$\{/g)) if (q[1]) vorsilben.add(q[1]);
    for (const q of arg.matchAll(/`([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)`/g)) fest.add(q[1]);
  }
  return { fest: [...fest], vorsilben: [...vorsilben] };
}

async function sprachTexte() {
  const { mischen } = await import(pathToFileURL(path.join(PUBLIC, 'sprache.js')).href);
  const teile = [];
  for (const d of (await fs.readdir(SPRACHE)).filter((n) => n.endsWith('.json')).sort()) {
    teile.push({ bereich: d.replace(/\.json$/, ''), daten: JSON.parse(await fs.readFile(path.join(SPRACHE, d), 'utf8')) });
  }
  return { ...mischen(teile), bereiche: teile.map((x) => x.bereich) };
}

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe (nur so viel, wie el(), symbol() und die Helfer brauchen)
// ---------------------------------------------------------------------------------------------------------------------

class AttrappeNode { constructor() { this.parentNode = null; this.childNodes = []; } get isConnected() { return false; } }
class AttrappeText extends AttrappeNode { constructor(text) { super(); this.nodeType = 3; this.textContent = String(text); } }
class AttrappeElement extends AttrappeNode {
  constructor(tag, ns) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.namespaceURI = ns || null; this.attribute = new Map(); this.dataset = {}; this.hoerer = new Map();
    this.style = { eigenschaften: {}, setProperty(k, v) { this.eigenschaften[k] = v; } };
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
  get firstElementChild() { return this.children[0] || null; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { this.childNodes = v === '' ? [] : [new AttrappeText(v)]; }
  appendChild(k) { k.parentNode = this; this.childNodes.push(k); return k; }
  removeChild(k) { this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  removeAttribute(k) { this.attribute.delete(k); }
  hasAttribute(k) { return this.attribute.has(k); }
  addEventListener(art, fn) { if (!this.hoerer.has(art)) this.hoerer.set(art, []); this.hoerer.get(art).push(fn); }
  removeEventListener() {}
  dispatch(art, ev = {}) { for (const fn of this.hoerer.get(art) || []) fn({ type: art, target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() { this.fokussiert = true; }
  matches() { return false; }
}

function domAttrappe() {
  const documentElement = new AttrappeElement('html');
  const body = new AttrappeElement('body');
  const head = new AttrappeElement('head');
  const dokument = {
    documentElement, body, head, cookie: 'fahnas_csrf=abc123; andere=x', title: '',
    createElement: (tag) => new AttrappeElement(tag),
    createElementNS: (ns, tag) => new AttrappeElement(tag, ns),
    createTextNode: (text) => new AttrappeText(text),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.Node = AttrappeNode;
  globalThis.document = dokument;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', href: 'http://nas.local/', origin: 'http://nas.local', replace() {} };
  const speicher = new Map();
  globalThis.localStorage = { getItem: (k) => (speicher.has(k) ? speicher.get(k) : null), setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  return dokument;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1) Syntax aller public/**/*.js
// ---------------------------------------------------------------------------------------------------------------------

test('ui: alle public/**/*.js sind syntaktisch gültig (node --check) und tragen den Urheber-Kopf', async () => {
  const skripte = await dateienUnter(PUBLIC, ['.js']);
  assert.ok(skripte.length >= 6, 'mindestens die sechs Skripte von Teil E');
  for (const s of skripte) {
    const r = await nodeCheck(s);
    assert.ok(r.ok, `Syntaxfehler in ${path.relative(WURZEL, s)}:\n${r.stderr}`);
    const kopf = (await fs.readFile(s, 'utf8')).split('\n').slice(0, 5).join('\n');
    assert.ok(kopf.includes(KOPF), `Urheber-Kopf fehlt in ${path.relative(WURZEL, s)}`);
  }
  for (const d of [...await dateienUnter(PUBLIC, ['.css', '.html', '.svg'])]) {
    const kopf = (await fs.readFile(d, 'utf8')).split('\n').slice(0, 8).join('\n');
    assert.ok(kopf.includes(KOPF), `Urheber-Kopf fehlt in ${path.relative(WURZEL, d)}`);
  }
});

test('ui: Rahmen, Ansichten und Helfer lassen sich in einer DOM-Attrappe importieren; Ansichten-Vertrag §8', async (t) => {
  domAttrappe();
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  for (const name of ['el', 'symbol', 't', 'format', 'parseRoute', 'hashFuer', 'melden', 'bestaetigen', 'dialog', 'eingabe', 'zeigeFehler', 'aufgabeVerfolgen', 'starten', 'setzeDesign']) {
    assert.ok(name in app, `app.js exportiert ${name}`);
  }
  const { ANSICHTEN } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'index.js')).href);
  assert.ok(Array.isArray(ANSICHTEN) && ANSICHTEN.length >= 2);
  const ids = new Set();
  for (const a of ANSICHTEN) {
    assert.match(a.id, /^[a-z][a-z0-9_-]*$/); assert.match(a.datei, /\.js$/); assert.ok(['nutzer', 'admin'].includes(a.rolle)); assert.equal(typeof a.reihenfolge, 'number');
    assert.ok(!ids.has(a.id), `Ansicht ${a.id} doppelt`); ids.add(a.id);
  }
  for (const id of ['dashboard', 'dateien']) {
    const eintrag = ANSICHTEN.find((a) => a.id === id);
    assert.ok(eintrag, `Ansicht ${id} registriert`);
    const m = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', eintrag.datei)).href);
    const an = m.default;
    assert.equal(an.id, id); assert.equal(typeof an.titel, 'function'); assert.equal(typeof an.symbol, 'string');
    assert.ok(['nutzer', 'admin'].includes(an.rolle)); assert.equal(typeof an.einbinden, 'function');
    if (an.verlassen) assert.equal(typeof an.verlassen, 'function');
    await fs.access(path.join(PUBLIC, 'ansichten', `${id}.css`));
  }
  // Fremde (F) Ansichten: nur melden
  for (const a of ANSICHTEN.filter((x) => !['dashboard', 'dateien'].includes(x.id))) {
    try { await fs.access(path.join(PUBLIC, 'ansichten', a.datei)); } catch { t.diagnostic(`Hinweis: Ansicht ${a.id} (${a.datei}) fehlt noch – gehört zu Teil F`); }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2) + 3) Sprache
// ---------------------------------------------------------------------------------------------------------------------

test('ui: Sprachdateien sind gültiges JSON, flach, ohne doppelte Schlüssel (in einer Datei und über Dateien hinweg)', async () => {
  const dateien = (await fs.readdir(SPRACHE)).filter((n) => n.endsWith('.json')).sort();
  for (const b of TEIL_E_SPRACHE) assert.ok(dateien.includes(`${b}.json`), `${b}.json fehlt`);
  const teile = [];
  for (const d of dateien) {
    const text = await fs.readFile(path.join(SPRACHE, d), 'utf8');
    let daten;
    try { daten = JSON.parse(text); } catch (e) { assert.fail(`${d}: ungültiges JSON – ${e.message}`); }
    assert.ok(daten && typeof daten === 'object' && !Array.isArray(daten), `${d}: Objekt erwartet`);
    const flachAlle = Object.values(daten).every((v) => typeof v === 'string' || Array.isArray(v));
    if (flachAlle) {
      const roh = [...text.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)].map((m) => m[1]);
      assert.equal(roh.length, Object.keys(daten).length, `${d}: doppelter Schlüssel innerhalb der Datei (${roh.filter((k, i) => roh.indexOf(k) !== i).join(', ')})`);
    }
    for (const [k, v] of Object.entries(daten)) {
      // Erlaubt: "bereich.schluessel" (vollständig, Teil E) oder "schluessel" (bekommt den Dateinamen als Vorsilbe, Teil F)
      assert.match(k, /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/, `${d}: Schlüssel „${k}“ hat ein ungültiges Format`);
      if (typeof v === 'string') { assert.ok(v.trim().length > 0, `${d}: „${k}“ ist leer`); assert.ok(!/\\u00|Ã/.test(v), `${d}: „${k}“ hat kaputte Umlaute`); }
    }
    teile.push({ bereich: d.replace(/\.json$/, ''), daten });
  }
  const { mischen, flach } = await import(pathToFileURL(path.join(PUBLIC, 'sprache.js')).href);
  const { texte, doppelte } = mischen(teile);
  assert.deepEqual(doppelte, [], `Doppelte Schlüssel über Dateien hinweg: ${doppelte.map((x) => `${x.schluessel} (${x.bereiche.join(', ')})`).join('; ')}`);
  assert.deepEqual(flach({ a: { b: 'x', c: { d: 'y' } }, e: 'z' }), { 'a.b': 'x', 'a.c.d': 'y', e: 'z' });
  // Vorsilbenregel: ohne Punkt → Dateiname davor (Teil F); mit Punkt → unverändert (Teil E)
  const m = mischen([{ bereich: 'anmeldung', daten: { titel: 'A', 'sonst.voll': 'B' } }]);
  assert.equal(m.texte['anmeldung.titel'], 'A'); assert.equal(m.texte['sonst.voll'], 'B'); assert.equal(m.texte.titel, undefined);
  for (const k of Object.keys(texte)) assert.ok(k.includes('.'), `gemischter Schlüssel ohne Bereich: ${k}`);
});

test('ui: alle t("…")-Schlüssel aus public/**/*.js existieren in der gemischten Sprachdatei (F: nur melden)', async (t) => {
  const { texte } = await sprachTexte();
  const schluessel = Object.keys(texte);
  const skripte = await dateienUnter(PUBLIC, ['.js']);
  const fehlendE = []; const fehlendF = [];
  let gezaehlt = 0;
  for (const s of skripte) {
    const rel = path.relative(PUBLIC, s).split(path.sep).join('/');
    const { fest, vorsilben } = tSchluessel(await fs.readFile(s, 'utf8'));
    const ziel = TEIL_E_JS.has(rel) ? fehlendE : fehlendF;
    for (const k of fest) { gezaehlt++; if (!(k in texte)) ziel.push(`${rel}: ${k}`); }
    for (const v of vorsilben) { gezaehlt++; if (!schluessel.some((k) => k.startsWith(v))) ziel.push(`${rel}: Vorsilbe ${v}…`); }
  }
  assert.ok(gezaehlt > 150, `es wurden nur ${gezaehlt} Schlüssel gefunden – Scanner kaputt?`);
  assert.deepEqual(fehlendE, [], `Fehlende Sprachschlüssel (Teil E):\n${fehlendE.join('\n')}`);
  if (fehlendF.length) t.diagnostic(`Hinweis (Teil F), fehlende Schlüssel: ${fehlendF.join('; ')}`);
  // Navigation und Fehlercodes vollständig
  const { ANSICHTEN } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'index.js')).href);
  for (const a of ANSICHTEN) assert.ok(`navigation.${a.id}` in texte, `navigation.${a.id} fehlt`);
  for (const code of ['E_PARAMS', 'E_RECHTE', 'E_ANMELDUNG', 'E_TOTP', 'E_BREMSE', 'E_CSRF', 'E_NICHT_GEFUNDEN', 'E_EXISTIERT', 'E_BELEGT', 'E_KONFIG', 'E_RENDER', 'E_SYSTEM', 'E_PLATZ', 'E_AGENT', 'E_TICKET', 'E_ABGEBROCHEN', 'E_GEAENDERT', 'E_UNBEKANNT']) {
    assert.ok(`fehler.${code}` in texte, `fehler.${code} fehlt`);
  }
  for (const s of ['wartet', 'laeuft', 'fertig', 'fehler', 'abgebrochen']) assert.ok(`aufgabe.status_${s}` in texte);
  for (const d of ['samba', 'docker', 'libvirt', 'avahi', 'ssh']) assert.ok(`dashboard.dienst.${d}` in texte);
});

test('ui: t() ersetzt Platzhalter, meldet fehlende Schlüssel, mischen() erkennt Dopplungen', async () => {
  const { erzeugeT, mischen } = await import(pathToFileURL(path.join(PUBLIC, 'sprache.js')).href);
  const t = erzeugeT({ 'a.hallo': 'Hallo {name}, du hast {n} Dateien', 'a.liste': ['eins', 'zwei'] });
  assert.equal(t('a.hallo', { name: 'Fabian', n: 3 }), 'Hallo Fabian, du hast 3 Dateien');
  assert.equal(t('a.hallo', { name: 'X' }), 'Hallo X, du hast {n} Dateien');
  assert.equal(t('a.liste'), 'eins\nzwei');
  const tp = erzeugeT({ 'a.p': '{n} {n|Eintrag|Einträge} verschoben.' });
  assert.equal(tp('a.p', { n: 1 }), '1 Eintrag verschoben.'); assert.equal(tp('a.p', { n: 3 }), '3 Einträge verschoben.'); assert.equal(tp('a.p', { n: 0 }), '0 Einträge verschoben.');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(t('fehlt.x'), 'fehlt.x'); } finally { console.warn = warn; }
  assert.ok(t.fehlend.has('fehlt.x')); assert.equal(t.hat('a.hallo'), true); assert.equal(t.hat('nix'), false);
  const { texte, doppelte } = mischen([{ bereich: 'gemeinsam', daten: { 'x.a': '1' } }, { bereich: 'dashboard', daten: { 'x.a': '2', 'x.b': '3' } }]);
  assert.equal(texte['x.a'], '1'); assert.equal(texte['x.b'], '3');
  assert.deepEqual(doppelte, [{ schluessel: 'x.a', bereiche: ['gemeinsam', 'dashboard'] }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4) index.html
// ---------------------------------------------------------------------------------------------------------------------

test('ui: index.html ohne Inline-Skript/-Stil/-Handler, lädt app.js als Modul, Stil und Manifest', async () => {
  const html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="de">/);
  const skripte = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(skripte.length >= 1, 'ein script-Tag');
  for (const [, attrs, inhalt] of skripte) {
    assert.ok(/\bsrc=/.test(attrs), 'jedes script hat src (kein Inline-Skript)');
    assert.equal(inhalt.trim(), '', 'kein Inline-Skript-Inhalt');
    assert.match(attrs, /type="module"/);
  }
  assert.ok(skripte.some(([, attrs]) => /src="[^"]*app\.js"/.test(attrs)), 'app.js wird geladen');
  assert.ok(!/<style\b/i.test(html), 'kein <style>');
  assert.ok(!/\sstyle="/i.test(html), 'kein style-Attribut');
  assert.ok(!/\son[a-z]+="/i.test(html), 'kein Inline-Event-Handler');
  assert.ok(!/javascript:/i.test(html), 'kein javascript:-Link');
  assert.match(html, /<link rel="stylesheet" href="[^"]*stil\.css">/);
  assert.match(html, /<link rel="manifest" href="[^"]*manifest\.webmanifest">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  for (const id of ['app', 'kopfzeile', 'navigation', 'inhalt', 'toasts', 'zustandsleiste']) assert.ok(html.includes(`id="${id}"`), `#${id} vorhanden`);
  const manifest = JSON.parse(await fs.readFile(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'FAH-NAS'); assert.ok(Array.isArray(manifest.icons) && manifest.icons.length);
  const svg = await fs.readFile(path.join(PUBLIC, 'symbole.svg'), 'utf8');
  for (const s of ['dashboard', 'dateien', 'freigaben', 'nutzer', 'snapshots', 'system', 'ordner', 'datei', 'hochladen', 'herunterladen', 'loeschen', 'papierkorb', 'warnung', 'fehler', 'erfolg', 'info', 'schliessen', 'abmelden', 'design-hell', 'design-dunkel', 'design-auto', 'cpu', 'ram', 'platte', 'netz', 'temperatur', 'welt']) {
    assert.ok(svg.includes(`id="symbol-${s}"`), `Symbol ${s} fehlt in symbole.svg`);
  }
  assert.ok(!/<script/i.test(svg), 'SVG ohne Skript');
});

// ---------------------------------------------------------------------------------------------------------------------
// 5) Stil
// ---------------------------------------------------------------------------------------------------------------------

test('ui: stil.css enthält Variablen und Basisklassen aus §8 für hell und dunkel', async () => {
  const css = await fs.readFile(path.join(PUBLIC, 'stil.css'), 'utf8');
  for (const v of ['--fahnas-hintergrund', '--fahnas-flaeche', '--fahnas-text', '--fahnas-akzent', '--fahnas-gefahr', '--fahnas-rand']) {
    const treffer = css.match(new RegExp(`${v}\\s*:`, 'g')) || [];
    assert.ok(treffer.length >= 3, `${v} muss für :root, prefers-color-scheme und [data-design="dunkel"] definiert sein (gefunden: ${treffer.length})`);
  }
  assert.ok((css.match(/--fahnas-radius\s*:/g) || []).length >= 1, '--fahnas-radius definiert');
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /:root:not\(\[data-design="hell"\]\)/);
  assert.match(css, /:root\[data-design="dunkel"\]/);
  assert.match(css, /--fahnas-radius:\s*12px/);
  assert.match(css, /--fahnas-abstand:\s*16px/);
  assert.match(css, /system-ui/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /--fahnas-akzent:\s*#0b7272/, 'Akzent hell: 5,7:1 auf Weiß (WCAG AA, R3-Fund 10)');
  for (const v of ['--fahnas-akzent-auf-hell', '--fahnas-gefahr-text', '--fahnas-gefahr-dunkel']) {
    assert.ok(((css.match(new RegExp(`${v}\\s*:`, 'g')) || []).length) >= 3, `${v} muss für hell, prefers-color-scheme und [data-design="dunkel"] definiert sein`);
  }
  for (const k of ['karte', 'knopf', 'knopf-gefahr', 'knopf-zweit', 'feld', 'erklaerung', 'schalter', 'tabelle', 'hinweis', 'hinweis-info', 'hinweis-warnung', 'hinweis-fehler', 'leer', 'kachel', 'fortschritt', 'dialog', 'toast', 'zustandsleiste', 'navigation', 'kopfzeile', 'plakette']) {
    assert.ok(new RegExp(`\\.${k}(?![a-zA-Z0-9_-])`).test(css), `Klasse .${k} fehlt in stil.css`);
  }
  assert.match(css, /@media \(max-width: 719px\)[\s\S]*data-label/, 'Tabelle wird auf dem Handy zur Kartenliste (data-label)');
  assert.match(css, /@media \(min-width: 720px\)/); assert.match(css, /@media \(min-width: 1100px\)/);
  for (const a of ['dashboard', 'dateien']) {
    const ac = await fs.readFile(path.join(PUBLIC, 'ansichten', `${a}.css`), 'utf8');
    assert.ok(ac.includes(`.${a}-`), `${a}.css nutzt die Vorsilbe .${a}-`);
    assert.ok(ac.includes('var(--fahnas-'), `${a}.css nutzt die Stilvariablen`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 6) Helfer des Rahmens
// ---------------------------------------------------------------------------------------------------------------------

test('ui: el() baut DOM sicher (textContent, Ereignisse, dataset, style-Variablen, SVG)', async () => {
  domAttrappe();
  const { el, symbol } = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  let geklickt = 0;
  const k = el('div', { class: 'karte', 'aria-label': 'x', dataset: { id: 7 }, hidden: false, onclick: () => geklickt++, style: { '--anteil': '40%' } }, ['<b>böse</b>', el('span', { text: 'a' }), null, false, ['b', 3]]);
  assert.equal(k.className, 'karte'); assert.equal(k.getAttribute('aria-label'), 'x'); assert.equal(k.dataset.id, '7');
  assert.equal(k.hidden, undefined, 'hidden=false setzt nichts');
  assert.equal(k.style.eigenschaften['--anteil'], '40%');
  assert.equal(k.childNodes.length, 4);
  assert.equal(k.childNodes[0].textContent, '<b>böse</b>', 'Nutzerdaten bleiben Text');
  assert.equal(k.childNodes[0].nodeType, 3);
  k.dispatch('click'); assert.equal(geklickt, 1);
  const c = el('input', { type: 'checkbox', checked: true, disabled: true, value: 'v' });
  assert.equal(c.checked, true); assert.equal(c.disabled, true); assert.equal(c.value, 'v');
  const b = el('button', { disabled: false }, 'Text');
  assert.equal(b.disabled, undefined); assert.equal(b.textContent, 'Text');
  const s = symbol('ordner', 'klein');
  assert.equal(s.tagName, 'SVG'); assert.equal(s.namespaceURI, 'http://www.w3.org/2000/svg'); assert.equal(s.getAttribute('class'), 'symbol klein');
  assert.match(s.childNodes[0].getAttribute('href'), /symbole\.svg#symbol-ordner$/);
  const ohneAttrs = el('p', 'nur Text');
  assert.equal(ohneAttrs.textContent, 'nur Text');
});

test('ui: Routing (parseRoute/hashFuer) und Formatierung (Größe, Zeit, Dauer, Prozent)', async () => {
  domAttrappe();
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  const { parseRoute, hashFuer, format } = app;
  assert.deepEqual(parseRoute('#/dashboard'), { id: 'dashboard', teile: [] });
  assert.deepEqual(parseRoute('#/dateien/medien/Urlaub%202026/Bild%201.jpg'), { id: 'dateien', teile: ['medien', 'Urlaub 2026', 'Bild 1.jpg'] });
  assert.deepEqual(parseRoute('#/dateien/medien/%3Apapierkorb'), { id: 'dateien', teile: ['medien', ':papierkorb'] });
  assert.deepEqual(parseRoute(''), { id: '', teile: [] });
  assert.deepEqual(parseRoute('#/../x'), { id: '', teile: ['x'] });
  assert.equal(hashFuer('dateien', 'medien', 'Urlaub 2026/Bild 1.jpg'), '#/dateien/medien/Urlaub%202026/Bild%201.jpg');
  assert.equal(hashFuer('dateien', 'medien', ''), '#/dateien/medien');
  assert.equal(hashFuer('dashboard'), '#/dashboard');
  const zurueck = parseRoute(hashFuer('dateien', 'a b', 'c/d#e?f'));
  assert.deepEqual(zurueck.teile, ['a b', 'c', 'd#e?f']);
  app._test.setzeT(Object.assign((k, w) => `${k}${w ? ':' + JSON.stringify(w) : ''}`, { hat: () => true }));
  // binär (1024er-Schritte) → Einheiten KiB/MiB/GiB, wie der Agent rechnet (groesse_gb × 1024³)
  assert.equal(format.groesse(0), '0 B'); assert.equal(format.groesse(1536), '1,5 KiB'); assert.equal(format.groesse(5 * 1024 ** 3), '5,0 GiB'); assert.equal(format.groesse(12 * 1024 ** 3), '12 GiB');
  assert.equal(format.groesse(123456789), '118 MiB'); assert.equal(format.groesse(null), '–');
  assert.equal(format.groesse(500 * 1024 ** 3), '500 GiB', 'Kontingent 500 erscheint als 500 GiB, nicht 466 GB');
  assert.equal(format.prozent(42.4), '42 %'); assert.equal(format.prozent(undefined), '–');
  assert.equal(format.rate(2048), '2,0 KiB/s'); assert.equal(format.rate(25 * 1024 * 1024), '25 MiB/s');
  assert.equal(format.zeit(new Date(Date.now() - 20_000).toISOString()), 'zeit.gerade');
  assert.equal(format.zeit(new Date(Date.now() - 3 * 60_000).toISOString()), 'zeit.vor_minuten:{"n":3}');
  assert.equal(format.zeit(new Date(Date.now() - 5 * 3600_000).toISOString()), 'zeit.vor_stunden:{"n":5}');
  assert.match(format.zeit('2026-01-02T10:00:00Z'), /2026/);
  assert.equal(format.zeit('kaputt'), 'kaputt'); assert.equal(format.zeit(null), '–');
  assert.equal(format.dauer(90061), 'zeit.tage_kurz:{"n":1} zeit.stunden_kurz:{"n":1} zeit.minuten_kurz:{"n":1}');
  assert.equal(format.dauer(120), 'zeit.minuten_kurz:{"n":2}');
});

test('ui: api.js – Antwortauswertung, Fehlercodes, CSRF-Cookie, Download-URL, Aktionsnamen', async () => {
  domAttrappe();
  const api = await import(pathToFileURL(path.join(PUBLIC, 'api.js')).href);
  api.setzeTexte((code) => `T:${code}`);
  assert.deepEqual(api.antwortAuswerten(200, JSON.stringify({ ok: true, ergebnis: { a: 1 } })), { ergebnis: { a: 1 } });
  assert.deepEqual(api.antwortAuswerten(200, JSON.stringify({ ok: true })), { ergebnis: null });
  assert.deepEqual(api.antwortAuswerten(200, JSON.stringify({ ok: true, aufgabe: 't-1' })), { ergebnis: { aufgabe: 't-1' } }, 'Aufgaben-Antwort des Web-Dienstes wird zu {aufgabe}');
  const f1 = api.antwortAuswerten(400, JSON.stringify({ ok: false, fehler: { code: 'E_PARAMS', meldung: 'Name fehlt', details: { feld: 'name' } } })).fehler;
  assert.ok(f1 instanceof api.ApiFehler); assert.equal(f1.code, 'E_PARAMS'); assert.equal(f1.meldung, 'Name fehlt'); assert.equal(f1.details.feld, 'name'); assert.equal(f1.status, 400);
  const f2 = api.antwortAuswerten(401, '').fehler; assert.equal(f2.code, 'E_ANMELDUNG'); assert.equal(f2.status, 401); assert.equal(f2.message, 'T:E_ANMELDUNG');
  assert.equal(api.antwortAuswerten(403, 'nein').fehler.code, 'E_RECHTE');
  assert.equal(api.antwortAuswerten(404, '<html>').fehler.code, 'E_NICHT_GEFUNDEN');
  // Eine nackte 413 kommt nie vom Web-Dienst (der antwortet mit JSON), sondern von einem Proxy davor (z. B. Nginx Proxy
  // Manager, client_max_body_size) – das ist KEIN voller Speicher.
  const f413 = api.antwortAuswerten(413, '<html>413 Request Entity Too Large</html>').fehler;
  assert.equal(f413.code, 'E_PARAMS'); assert.equal(f413.message, 'T:PROXY_ZU_GROSS'); assert.equal(f413.status, 413);
  assert.equal(api.antwortAuswerten(413, JSON.stringify({ ok: false, fehler: { code: 'E_PARAMS', meldung: 'Anfrage ist zu groß' } })).fehler.message, 'Anfrage ist zu groß', 'JSON-Fehler des Web-Dienstes bleibt');
  assert.equal(api.antwortAuswerten(500, 'kaputt').fehler.code, 'E_UNBEKANNT');
  assert.equal(api.antwortAuswerten(200, JSON.stringify({ ok: false, fehler: { code: 'E_AGENT' } })).fehler.message, 'T:E_AGENT');
  assert.equal(api.csrfToken(), 'abc123');
  assert.equal(api.downloadUrl('medien', 'Urlaub 2026/Bild&1.jpg'), '/api/dateien/herunterladen?freigabe=medien&pfad=Urlaub%202026%2FBild%261.jpg');
  assert.equal(api.downloadUrl('medien', 'ordner', true), '/api/dateien/herunterladen?freigabe=medien&pfad=ordner&zip=1');
  assert.equal(api.downloadUrl('medien', 'a.pdf', false, true), '/api/dateien/herunterladen?freigabe=medien&pfad=a.pdf&anzeigen=1');
  await assert.rejects(api.api('böse; rm -rf', {}), (e) => e.code === 'E_PARAMS');
  await assert.rejects(api.api('system.status; x', {}), (e) => e.code === 'E_PARAMS');
  // fetch-Attrappe: POST setzt CSRF-Kopf und JSON-Body, GET nicht
  const aufrufe = [];
  globalThis.fetch = async (url, o) => { aufrufe.push({ url, o }); return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, ergebnis: 'ja' }) }; };
  try {
    assert.equal(await api.api('system.status', { a: 1 }), 'ja');
    assert.equal(aufrufe[0].url, '/api/agent/system.status'); assert.equal(aufrufe[0].o.method, 'POST');
    assert.equal(aufrufe[0].o.headers['X-FAHNAS-CSRF'], 'abc123'); assert.equal(aufrufe[0].o.body, JSON.stringify({ a: 1 })); assert.equal(aufrufe[0].o.credentials, 'same-origin');
    assert.equal(await api.get('/api/ich'), 'ja');
    assert.equal(aufrufe[1].o.method, 'GET'); assert.equal(aufrufe[1].o.headers['X-FAHNAS-CSRF'], undefined);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.get('/api/ich'), (e) => e.code === 'E_UNBEKANNT' && e.details.grund === 'netz' && e.message === 'T:NETZ');
  } finally { delete globalThis.fetch; }
  // SSE ohne EventSource (Node): on/off funktioniert, starten() ist harmlos
  const sse = api.sseVerbinden('/api/ereignisse');
  let bekommen = null; const ab = sse.on('messwerte', (d) => { bekommen = d; });
  sse.starten(); assert.equal(sse.zustand, 'geschlossen'); ab(); sse.schliessen(); assert.equal(bekommen, null);
});

test('ui: Dashboard – Messwerte verschiedener Formen werden normalisiert, Kurve zeichnet in Canvas-Attrappe', async () => {
  domAttrappe();
  const { normalisiere, zeichneKurve } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  const a = normalisiere({ zeit: 't', cpu: { prozent: 12.5 }, ram: { gesamt: 1000, belegt: 250 }, platten: [{ pfad: '/', gesamt: 100, frei: 40 }, { pfad: '/data', label: 'FAHNAS-DATEN', gesamt: 1000, frei: 100, prozent: 90 }], netz: { rx_bs: 1000, tx_bs: 20 }, temperatur: { cpu: 55, nvme: 40 } });
  assert.equal(a.cpu, 12.5); assert.equal(a.ramProzent, 25); assert.equal(a.ramBelegt, 250); assert.equal(a.rx, 1000); assert.equal(a.tx, 20); assert.equal(a.temp, 55);
  assert.equal(a.platten[0].prozent, 60); assert.equal(a.platten[0].belegt, 60); assert.equal(a.platten[1].prozent, 90);
  const b = normalisiere({ cpu: 33, ram: { gesamt: 8, frei: 2 }, netz: { rx: 5, tx: 6 }, temperatur: 61, platten: { system: { gesamt: 10, belegt: 5 } } });
  assert.equal(b.cpu, 33); assert.equal(b.ramProzent, 75); assert.equal(b.ramBelegt, 6); assert.equal(b.temp, 61); assert.equal(b.platten[0].pfad, 'system'); assert.equal(b.platten[0].prozent, 50);
  const c = normalisiere({ temperatur: [{ name: 'a', wert: 40 }, { name: 'b', wert: 70 }] });
  assert.equal(c.temp, 70); assert.equal(c.cpu, null); assert.equal(c.rx, null);
  assert.equal(normalisiere(null), null);
  // Canvas-Attrappe
  const befehle = [];
  const g = new Proxy({}, { get: (_z, k) => (k === 'setTransform' || typeof k !== 'string') ? () => {} : (...args) => { befehle.push(k); return undefined; }, set: () => true });
  const canvas = { clientWidth: 300, clientHeight: 72, width: 0, height: 0, getContext: () => g };
  zeichneKurve(canvas, [{ werte: [10, null, 20, 30] }], 100);
  assert.equal(canvas.width, 300); assert.equal(canvas.height, 72);
  assert.ok(befehle.includes('clearRect') && befehle.includes('stroke') && befehle.includes('fill'));
  zeichneKurve(canvas, [{ werte: [] }, { werte: [1, 2, 3] }], null); // leere Reihe stürzt nicht
  zeichneKurve(null, []);
});

test('ui: Dateien – Art-Erkennung, Sortierung (Ordner zuerst, natürlich), Pfade', async () => {
  domAttrappe();
  const { artVon, sortiere, verbinde } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href);
  assert.equal(artVon({ name: 'x', art: 'ordner' }), 'ordner');
  assert.equal(artVon({ name: 'Foto.JPG', art: 'datei' }), 'bild');
  assert.equal(artVon({ name: 'x.bin', art: 'datei', mime: 'image/png' }), 'bild');
  assert.equal(artVon({ name: 'film.mkv', art: 'datei' }), 'video');
  assert.equal(artVon({ name: 'lied.flac', art: 'datei' }), 'audio');
  assert.equal(artVon({ name: 'notizen.md', art: 'datei' }), 'text');
  assert.equal(artVon({ name: 'daten', art: 'datei', mime: 'application/json' }), 'text');
  assert.equal(artVon({ name: 'Rechnung.pdf', art: 'datei' }), 'pdf');
  assert.equal(artVon({ name: 'sicherung.tar.gz', art: 'datei' }), 'archiv');
  assert.equal(artVon({ name: 'irgendwas.xyz', art: 'datei' }), 'datei');
  const liste = [
    { name: 'b.txt', art: 'datei', groesse: 10, geaendert: '2026-01-02T00:00:00Z' },
    { name: 'Datei 10.txt', art: 'datei', groesse: 5, geaendert: '2026-01-03T00:00:00Z' },
    { name: 'Datei 2.txt', art: 'datei', groesse: 30, geaendert: '2026-01-01T00:00:00Z' },
    { name: 'zz', art: 'ordner', geaendert: '2026-01-04T00:00:00Z' },
    { name: 'Aa', art: 'ordner', geaendert: '2026-01-05T00:00:00Z' },
  ];
  assert.deepEqual(sortiere(liste, 'name', true).map((e) => e.name), ['Aa', 'zz', 'b.txt', 'Datei 2.txt', 'Datei 10.txt']);
  assert.deepEqual(sortiere(liste, 'name', false).map((e) => e.name), ['zz', 'Aa', 'Datei 10.txt', 'Datei 2.txt', 'b.txt']);
  assert.deepEqual(sortiere(liste, 'groesse', true).map((e) => e.name), ['Aa', 'zz', 'Datei 10.txt', 'b.txt', 'Datei 2.txt']);
  assert.deepEqual(sortiere(liste, 'geaendert', false).map((e) => e.name), ['Aa', 'zz', 'Datei 10.txt', 'b.txt', 'Datei 2.txt']);
  assert.deepEqual(liste.map((e) => e.name), ['b.txt', 'Datei 10.txt', 'Datei 2.txt', 'zz', 'Aa'], 'Eingabe bleibt unverändert');
  assert.equal(verbinde('', 'a'), 'a'); assert.equal(verbinde('a/b', 'c'), 'a/b/c');
});

test('ui: Rahmen-Meldungen und Dialoge arbeiten mit der DOM-Attrappe (melden, bestaetigen, dialog)', async () => {
  const dok = domAttrappe();
  const toasts = new AttrappeElement('div');
  dok.getElementById = (id) => (id === 'toasts' ? toasts : null);
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT(Object.assign((k) => k, { hat: (k) => k.startsWith('fehler.') }));
  const m = app.melden('Hallo <script>', 'erfolg', 0);
  assert.equal(toasts.children.length, 1);
  assert.ok(toasts.children[0].className.includes('toast-erfolg'));
  assert.equal(toasts.children[0].children[1].textContent, 'Hallo <script>');
  m.schliessen(); assert.equal(toasts.children.length, 0);
  app.melden('a', 'unbekannt', 0); assert.ok(toasts.children[0].className.includes('toast-info'));
  for (let i = 0; i < 6; i++) app.melden(`t${i}`, 'info', 0);
  assert.ok(toasts.children.length <= 4, 'höchstens vier Toasts');
  // dialog: nutzt <dialog>; in der Attrappe kein showModal → open-Attribut
  const d = app.dialog([app.el('p', { text: 'Inhalt' })], { titel: 'Titel' });
  assert.equal(dok.body.children.at(-1), d.element); assert.equal(d.element.getAttribute('open'), '');
  assert.equal(d.koerper.textContent, 'Inhalt');
  d.schliessen(); assert.ok(!dok.body.children.includes(d.element));
  // bestaetigen: OK-Knopf löst true aus
  const p = app.bestaetigen('Sicher?', { gefahr: true });
  const dlg = dok.body.children.at(-1);
  const knoepfe = dlg.children[1].children[1].children;
  assert.equal(knoepfe.length, 2); assert.ok(knoepfe[1].className.includes('knopf-gefahr'));
  knoepfe[1].dispatch('click');
  assert.equal(await p, true);
  const p2 = app.bestaetigen('Sicher?');
  dok.body.children.at(-1).children[1].children[1].children[0].dispatch('click');
  assert.equal(await p2, false);
  assert.equal(app.fehlerText({ code: 'E_PLATZ', message: 'E_PLATZ' }), 'fehler.E_PLATZ');
  assert.equal(app.fehlerText({ code: 'E_PARAMS', message: 'Name fehlt' }), 'Name fehlt');
  assert.equal(app.fehlerText({ code: 'E_UNBEKANNT', message: 'x', details: { grund: 'netz' } }), 'fehler.netz');
  assert.equal(app.fehlerText('Text'), 'Text');
});

// ---------------------------------------------------------------------------------------------------------------------
// Bedienung (12.10.2026): Navigationsgruppen, System-Reiter, Suche, Handlungsbedarf, Sicherungs-Assistent, Agent-Texte
// ---------------------------------------------------------------------------------------------------------------------

test('Bedienung: jede Ansicht außer der Übersicht hat eine Navigationsgruppe; System-Reiter decken alle Karten ab', async () => {
  domAttrappe();
  const { ANSICHTEN, GRUPPEN } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'index.js')).href);
  for (const a of ANSICHTEN) {
    if (a.id === 'dashboard') assert.equal(a.gruppe, undefined);
    else assert.ok(GRUPPEN.includes(a.gruppe), `${a.id} ohne Gruppe`);
  }
  const sys = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'system.js')).href);
  const karten = sys.SYSTEM_REITER.flatMap((r) => r.karten);
  assert.equal(new Set(karten).size, karten.length, 'keine Karte doppelt');
  const quelle = await fs.readFile(path.join(PUBLIC, 'ansichten', 'system.js'), 'utf8');
  for (const m of quelle.matchAll(/markiert\('([a-z]+)'/g)) assert.ok(karten.includes(m[1]), `Karte ${m[1]} in keinem Reiter`);
  assert.equal(sys.reiterVon('vpn'), 'zugriff'); assert.equal(sys.reiterVon('wartung'), 'wartung'); assert.equal(sys.reiterVon('quatsch'), 'grundlagen'); assert.equal(sys.reiterVon(null), 'grundlagen');
});

test('Bedienung: Suche – Umlaute/ß gleich, Stichwörter finden Einstellungen, Titelanfang vor Stichwort, Admin-Karten nur für Admins', async () => {
  domAttrappe();
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT(Object.assign((k) => k, { hat: () => true }));
  const s = await import(pathToFileURL(path.join(PUBLIC, 'suche.js')).href);
  assert.equal(s.normieren('Schnappschüsse Größe'), 'schnappschuesse groesse');
  const ansichten = ['dashboard', 'laufwerke', 'apps', 'spiegelung', 'system'].map((id) => ({ id }));
  const feste = s.festeEintraege({ ansichten, admin: true, seitenText: (id) => `Seite ${id}` });
  const ziele = feste.map((e) => e.ziel);
  for (const z of ['#/system/vpn', '#/system/protokolle', '#/laufwerke/raid', '#/apps/katalog', '#/spiegelung/neu']) assert.ok(ziele.includes(z), z);
  assert.equal(s.suchen(feste, 'wireguard')[0].ziel, '#/system/vpn');
  assert.equal(s.suchen(feste, 'usv')[0].ziel, '#/system/energie');
  assert.ok(s.suchen(feste, 'glas')[0].aktion === 'darstellung');
  const eintraege = [{ titel: 'private', art: 'freigabe' }, { titel: 'Medien', stichworte: 'private filme', art: 'freigabe' }, { titel: 'WLAN-QR', stichworte: 'qrwifi', art: 'app' }];
  assert.deepEqual(s.suchen(eintraege, 'priv').map((e) => e.titel), ['private', 'Medien'], 'Titelanfang vor Stichwort');
  assert.deepEqual(s.suchen(eintraege, 'wlan qr').map((e) => e.titel), ['WLAN-QR'], 'alle Wörter müssen passen');
  assert.deepEqual(s.suchen(eintraege, 'nichtda'), []);
  const nutzer = s.festeEintraege({ ansichten: [{ id: 'dashboard' }, { id: 'apps' }], admin: false });
  assert.ok(!nutzer.some((e) => String(e.ziel || '').startsWith('#/system')), 'Nutzer sehen keine Systemkarten');
});

test('Bedienung: Handlungsbedarf – Fehler vor Warnungen vor Hinweisen, je Zeile ein Sprungziel; nichts zu tun → leer', async () => {
  domAttrappe();
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT(Object.assign((k, w) => `${k}${w ? ':' + JSON.stringify(w) : ''}`, { hat: () => true }));
  const d = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  assert.deepEqual(d.handlungsbedarf({}), []);
  assert.deepEqual(d.handlungsbedarf({ status: { datenpartition_prozent: 40 }, apps: [{ name: 'a', zustand: 'running' }], raid: { verbuende: [{ name: 'daten', zustand: 'ok' }] }, hinweise: { smart: [], updates: { anzahl: 0, sicherheit: 0 }, benachrichtigungen: true } }), []);
  const l = d.handlungsbedarf({
    status: { datenpartition_prozent: 91 },
    raid: { verbuende: [{ name: 'daten', zustand: 'beeintraechtigt' }] },
    laufwerke: [{ kennung: 'uuid:1', name: '1500gb', eingehaengt: true, belegt: 95, frei: 5, platte: '/dev/sdc' }, { kennung: 'uuid:efi', label: 'VTOYEFI', eingehaengt: false, bekannt: false, platte: '/dev/sdc' }, { kennung: 'serial:X', modell: 'WD Red', eingehaengt: false, bekannt: false, platte: '/dev/sdd' }, { system: true, eingehaengt: true, belegt: 99, frei: 1 }],
    apps: [{ name: 'qrwifi', titel: 'WLAN-QR', zustand: 'restarting' }, { name: 'x', zustand: 'exited' }, { name: 'p', zustand: 'running', portkonflikt: true }],
    spiegelung: { auftraege: [{ id: 's-1', name: 'USB', aktiv: true, zustand: { letzter: { ergebnis: 'fehler' } } }, { id: 's-2', name: 'Aus', aktiv: false, zustand: { letzter: { ergebnis: 'fehler' } } }] },
    vms: { vms: [{ name: 'win', autostart: true, zustand: 'aus' }, { name: 'test', autostart: false, zustand: 'aus' }] },
    vpn: { status: { aktiv: true, laeuft: true }, lesen: { selbsttest: { gesamt: 'fehler' } } },
    energie: { usv_aktiv: true, usv: { akku: true, ladung: 80 } },
    hinweise: { smart: [{ geraet: '/dev/sda', modell: 'WD', zustand: 'warnung', grund: 'x' }], updates: { anzahl: 5, sicherheit: 2 }, benachrichtigungen: false },
  });
  const stufen = l.map((x) => x.stufe);
  assert.deepEqual(stufen, [...stufen].sort((a, b) => ['fehler', 'warnung', 'hinweis'].indexOf(a) - ['fehler', 'warnung', 'hinweis'].indexOf(b)));
  const nachId = Object.fromEntries(l.map((x) => [x.id, x]));
  assert.equal(nachId['raid-daten'].ziel, '#/laufwerke/raid'); assert.equal(nachId['raid-daten'].stufe, 'fehler');
  assert.equal(nachId['daten-voll'].stufe, 'warnung');
  assert.equal(nachId['lw-uuid:1'].ziel, '#/laufwerke');
  assert.equal(nachId['neu-serial:X'].ziel, '#/laufwerke/ziel/serial:X'); assert.equal(nachId['neu-serial:X'].stufe, 'hinweis');
  assert.equal(nachId['neu-uuid:efi'], undefined, 'weitere Partition einer bekannten Platte ist keine neue Platte');
  assert.equal(nachId['app-qrwifi'].ziel, '#/apps/ziel/qrwifi'); assert.equal(nachId['app-p'].stufe, 'warnung'); assert.equal(nachId['app-x'], undefined, 'absichtlich gestoppt ist kein Problem');
  assert.equal(nachId['sp-s-1'].ziel, '#/spiegelung/ziel/s-1'); assert.equal(nachId['sp-s-2'], undefined, 'pausierte Spiegelung zählt nicht');
  assert.equal(nachId['vm-win'].ziel, '#/vms/ziel/win'); assert.equal(nachId['vm-test'], undefined);
  assert.equal(nachId.vpn.stufe, 'warnung'); assert.equal(nachId.usv.stufe, 'fehler');
  assert.equal(nachId['smart-/dev/sda'].ziel, '#/system/smart'); assert.equal(nachId.updates.stufe, 'warnung'); assert.equal(nachId.benachrichtigungen.ziel, '#/system/benachrichtigungen');
  assert.equal(l.filter((x) => x.id.startsWith('lw-')).length, 1, 'Systemplatte zählt dort nicht');
});

test('Bedienung: Sicherungs-Assistent baut den Auftrag (täglich/wöchentlich/bei Änderungen, Zielordner FAH-NAS/<Quelle>)', async () => {
  domAttrappe();
  const a = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'sicherung-assistent.js')).href);
  assert.equal(a.zielOrdner({ freigabe: 'private', pfad: '' }), 'FAH-NAS/private');
  assert.equal(a.zielOrdner({ freigabe: 'private', pfad: 'fah-sicherung' }), 'FAH-NAS/private/fah-sicherung');
  const t1 = a.auftragAus({ quelle: { freigabe: 'private', pfad: '' }, ziel: { freigabe: '1500gb' }, wann: 'taeglich', uhrzeit: '02:30' });
  assert.deepEqual(t1, { name: 'Sicherung private', art: 'sicherung', aktiv: true, quelle: { freigabe: 'private', pfad: '' }, ziel: { freigabe: '1500gb', pfad: 'FAH-NAS/private' }, richtung: 'einseitig', versionen_tage: 30, ausloeser: 'zeitplan', tage: [0, 1, 2, 3, 4, 5, 6], zeiten: ['02:30'] });
  const t2 = a.auftragAus({ quelle: { freigabe: 'p', pfad: '' }, ziel: { zugang: 'z-0123456789', freigabe: 'backup', pfad: 'FAH-NAS/p' }, wann: 'woechentlich', tag: 6, uhrzeit: '04:00' });
  assert.deepEqual([t2.ziel, t2.tage, t2.zeiten], [{ zugang: 'z-0123456789', freigabe: 'backup', pfad: 'FAH-NAS/p' }, [6], ['04:00']]);
  const t3 = a.auftragAus({ quelle: { freigabe: 'p' }, ziel: { freigabe: 'x' }, wann: 'aenderung' });
  assert.deepEqual([t3.ausloeser, t3.tage, t3.zeiten, t3.wartezeit_min], ['aenderung', [], [], 5]);
  assert.deepEqual(a.SCHNAPPSCHUSS_VORSCHLAG.behalten, { stuendlich: 0, taeglich: 14, woechentlich: 8 });
  // Der Agent nimmt den Auftrag so an
  const { auftragNormal } = await import(pathToFileURL(path.join(WURZEL, 'src', 'agent', 'spiegelung', 'regeln.js')).href);
  for (const x of [t1, t2, t3]) assert.doesNotThrow(() => auftragNormal(x, { id: 's-test' }));
});

test('Bedienung: Agent-Meldungen auf Englisch – genaue Texte, Muster mit Platzhaltern, Unbekanntes bleibt', async () => {
  const at = await import(pathToFileURL(path.join(PUBLIC, 'agent-text.js')).href);
  const t = at.tabelleAufbauen([['Abgebrochen', 'Cancelled'], ['Freigabe „{1}“ gibt es schon', 'Share “{1}” already exists'], ['{1} von {2} kopiert', '{2}: {1} copied'], ['kaputt', '']]);
  assert.equal(at.agentText('Abgebrochen', t), 'Cancelled');
  assert.equal(at.agentText('Freigabe „medien“ gibt es schon', t), 'Share “medien” already exists');
  assert.equal(at.agentText('3 von 10 kopiert', t), '10: 3 copied', 'Platzhalter dürfen die Reihenfolge wechseln');
  assert.equal(at.agentText('Völlig neuer Text', t), 'Völlig neuer Text');
  assert.equal(at.agentText('kaputt', t), 'kaputt', 'leere Übersetzung wird ignoriert');
  assert.equal(at.agentText('Abgebrochen'), 'Abgebrochen', 'ohne geladene Tabelle (Deutsch) unverändert');
  // Die mitgelieferte Tabelle: gültig, Platzhalter vollständig, deckt typische Meldungen ab
  const paare = JSON.parse(await fs.readFile(path.join(PUBLIC, 'sprache', 'agent-en.json'), 'utf8'));
  assert.ok(paare.length > 500);
  for (const [de, en] of paare) assert.deepEqual((en.match(/\{\d+\}/g) || []).sort(), (de.match(/\{\d+\}/g) || []).sort(), de);
  const echt = at.tabelleAufbauen(paare);
  assert.notEqual(at.agentText('Zur Sicherheit bitte den Namen des Verbunds zur Bestätigung eintippen', echt), 'Zur Sicherheit bitte den Namen des Verbunds zur Bestätigung eintippen');
});

test('Bedienung: „Verstanden“ – Hinweis bleibt weg bis der Text sich ändert, Fehler 24 h, Behobenes fällt aus der Liste', async () => {
  domAttrappe();
  const d = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  const jetzt = 1_000_000;
  const updates = { id: 'updates', stufe: 'hinweis', text: '2 Updates verfügbar' };
  const raid = { id: 'raid-daten', stufe: 'fehler', text: 'RAID beeinträchtigt' };
  const usv = { id: 'usv', stufe: 'warnung', text: 'USV nicht erreichbar' };
  let q = d.hbQuittieren({}, updates, [updates, raid], jetzt);
  q = d.hbQuittieren(q, raid, [updates, raid], jetzt);
  assert.deepEqual(q.updates, { text: '2 Updates verfügbar' }); assert.equal(q['raid-daten'].bis, jetzt + 24 * 3600_000);
  assert.deepEqual(d.hbFiltern([updates, raid, usv], q, jetzt + 1000), { sichtbar: [usv], versteckt: 2 });
  assert.deepEqual(d.hbFiltern([{ ...updates, text: '5 Updates verfügbar' }], q, jetzt).sichtbar.length, 1, 'mehr Updates → wieder sichtbar');
  assert.equal(d.hbFiltern([raid], q, jetzt + 25 * 3600_000).sichtbar.length, 1, 'Fehler meldet sich nach 24 h wieder');
  const q2 = d.hbQuittieren(q, usv, [usv], jetzt);
  assert.deepEqual(Object.keys(q2), ['usv'], 'behobene Einträge fallen heraus – kommen sie wieder, erscheinen sie');
});

test('Kacheln: Prozessor mit Hersteller, Kernen/Threads und Auslastung je Kern; Systemplatte mit Hersteller (12.10.2026)', async () => {
  domAttrappe();
  const app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT(Object.assign((k, w) => `${k}${w ? ':' + JSON.stringify(w) : ''}`, { hat: () => true }));
  const d = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dashboard.js')).href);
  const m = d.normalisiere({ cpu: { prozent: 50, kerne: 4, je_kern: [10, 90, 50, null], modell: 'Core i5-6500T @ 2.50GHz', hersteller: 'Intel', kerne_physisch: 4, threads: 4 } });
  assert.deepEqual(m.cpuInfo.jeKern, [10, 90, 50, null]);
  assert.equal(d.cpuZeile(m.cpuInfo), 'dashboard.cpu_kerne:{"name":"Intel Core i5-6500T @ 2.50GHz","kerne":4}');
  assert.match(d.cpuZeile({ modell: 'Intel Core i7-8700', hersteller: 'Intel', kerne: 6, threads: 12 }), /cpu_kerne_threads.*"name":"Intel Core i7-8700".*"threads":12/);
  assert.equal(d.cpuZeile({}), '');
  assert.match(d.platteZeile({ modell: 'SSD 850 EVO 2TB', hersteller: 'Samsung', groesse: 2e12, art: 'ssd' }), /^Samsung SSD 850 EVO 2TB · .* SSD$/);
  assert.equal(d.platteZeile(null), '');
  const sys = await import(pathToFileURL(path.join(WURZEL, 'src', 'web', 'messwerte.js')).href);
  assert.deepEqual(sys.kernZeiten('cpu  10 0 10 80 0 0 0 0\ncpu0 5 0 5 40 0\ncpu1 5 0 5 40 0\nintr 1\n').map((k) => k.gesamt), [50, 50]);
  const info = sys.prozessorInfo('processor : 0\nphysical id : 0\ncore id : 0\nprocessor : 1\nphysical id : 0\ncore id : 1\nprocessor : 2\nphysical id : 0\ncore id : 0\n');
  assert.equal(info.kerne, 2, 'zwei physische Kerne (Hyper-Threading zählt nicht doppelt)');
  const hs = await import(pathToFileURL(path.join(WURZEL, 'src', 'agent', 'aktionen', 'system.js')).href);
  assert.deepEqual(['SSD 850 EVO 2TB', 'WDC WD40EFRX', 'ST8000VN004', 'CT1000MX500SSD1', 'Unbekannt X'].map((x) => hs.herstellerAusModell(x, 'ATA')), ['Samsung', 'Western Digital', 'Seagate', 'Crucial', '']);
});
