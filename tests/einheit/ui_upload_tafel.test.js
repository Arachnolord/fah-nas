// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Upload-Tafel im Dateimanager (Betreiber-Fund 26.09.): Nach erfolgreichem Hochladen schließt sich die Tafel nach 5 s
// von selbst und taucht beim Ordnerwechsel, beim Ansichtenwechsel oder nach dem Schließen per X NICHT wieder auf
// (vorher hängte jeder Ordnerwechsel die alte Tafel „15 von 15 fertig“ erneut an – nur ein Neuladen half).
// Fehlgeschlagene Uploads bleiben stehen (auch in anderen Ansichten), bis sie wiederholt oder per X geschlossen werden;
// „Alle abbrechen“ nur, solange etwas läuft; Abmelden verwirft alles (Prüfrunde 26.09.). Läuft ohne Browser: echte
// Ansicht public/ansichten/dateien.js gegen eine DOM-Attrappe, in der isConnected die Elternkette bis zum body prüft.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HIER, '..', '..', 'public');

// ---------------------------------------------------------------------------------------------------------------------
// DOM-Attrappe
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
  get firstElementChild() { return this.children[0] || null; }
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
  ausloesen(art, ev = {}) { for (const fn of this.hoerer[art] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  click() { this.ausloesen('click'); }
  alle() { const aus = []; for (const k of this.children) { aus.push(k, ...k.alle()); } return aus; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { const kl = s.startsWith('.') ? s.slice(1).split('.') : null; return kl ? this.alle().filter((k) => kl.every((c) => k.classList.contains(c))) : []; }
  closest() { return null; }
  focus() {}
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
  return dokument;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------------------------------

/** Mikroaufgaben und Promise-Ketten abarbeiten (setImmediate ist nicht gemockt). */
const abarbeiten = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const tafel = () => dokument.body.children.find((k) => k.classList.contains('dateien-uploads')) || null;
const tafelTitel = () => { const t = tafel(); const h = t && t.alle().find((k) => k.tagName === 'H2'); return h ? h.textContent : null; };
const knopfMitTitel = (wurzel, titel) => wurzel.alle().find((k) => k.tagName === 'BUTTON' && k.getAttribute('title') === titel);
const knopfMitText = (wurzel, text) => wurzel.alle().find((k) => k.tagName === 'BUTTON' && k.textContent === text);
const kopf = () => tafel().querySelector('.dateien-uploads-kopf');
const aktionen = () => tafel().querySelector('.dateien-uploads-aktionen');
const datei = (name, size = 1000) => ({ name, size });

const apiAufrufe = [];
/** Steuerung der Attrappe: dateien.ordner je Ordnername ('scheitert-einmal' | 'haengt'), laufende „langsam…“-Uploads,
 *  gestartete Uploads und Meldungen. */
const steuerung = { ordner: new Map(), haengendeOrdner: [], laeufe: new Map(), hochgeladen: [], meldungen: [], gewackelt: new Set(), vorhanden: new Map(), bei: [], dialoge: [], belegt: new Set(), netzweg: new Map() };
const fehlerMit = (code, text) => Object.assign(new Error(text), { code });

/** Ansicht wie der Rahmen einbinden; hochladen() gelingt oder scheitert je nach Dateiname („kaputt…“ scheitert). */
async function einbinden(d, route = ['private']) {
  const wurzel = dokument.createElement('main');
  dokument.body.appendChild(wurzel);
  const ctx = {
    rolle: 'admin',
    route: { id: 'dateien', teile: route },
    sse: { on() {} },
    api: async (aktion, params) => {
      apiAufrufe.push({ aktion, params });
      if (aktion === 'dateien.ordner') {
        const art = steuerung.ordner.get(params.name);
        if (art === 'scheitert-einmal') { steuerung.ordner.delete(params.name); throw fehlerMit('E_AGENT', 'Agent kurz weg'); }
        if (art === 'scheitert-dann-haengt') { steuerung.ordner.set(params.name, 'haengt'); throw fehlerMit('E_AGENT', 'Agent kurz weg'); }
        if (art === 'haengt') return new Promise((ok, nein) => steuerung.haengendeOrdner.push({ ok, nein, name: params.name }));
        return {};
      }
      if (aktion === 'dateien.vorhanden') return { vorhanden: params.namen.filter((n) => steuerung.vorhanden.has(n)).map((n) => ({ name: n, ...steuerung.vorhanden.get(n) })) };
      if (aktion === 'freigaben.liste') return [{ name: 'private', papierkorb: true }];
      if (aktion === 'dateien.liste') return { eintraege: [], schreiben: true, papierkorb: true };
      return {};
    },
    hochladen: ({ name, beiVorhanden, beiFortschritt }) => {
      steuerung.hochgeladen.push(name);
      steuerung.bei.push([name, beiVorhanden]);
      // „belegt…“ scheitert mit E_EXISTIERT, solange nicht ersetzt/beide gewählt ist (Name inzwischen vergeben)
      if (steuerung.belegt.has(name) && beiVorhanden === 'fehler') return { abbrechen() {}, fertig: Promise.reject(fehlerMit('E_EXISTIERT', `„${name}“ gibt es hier schon`)) };
      if (beiVorhanden === 'beide') return { abbrechen() {}, fertig: Promise.resolve({ name: name.replace(/\.(\w+)$/, ' (1).$1'), umbenannt: true, ersetzt: false }) };
      if (beiVorhanden === 'ersetzen') return { abbrechen() {}, fertig: Promise.resolve({ name, umbenannt: false, ersetzt: true }) };
      // „langsam…“ endet erst über steuerung.laeufe; „haengt…“ läuft, bis abgebrochen wird; „kaputt…“ scheitert
      if (name.startsWith('langsam')) {
        let ok, nein; const fertig = new Promise((a, b) => { ok = a; nein = b; });
        steuerung.laeufe.set(name, { ok, beiFortschritt });
        return { fertig, abbrechen() { nein(fehlerMit('E_ABGEBROCHEN', 'abgebrochen')); } };
      }
      if (name.startsWith('haengt')) {
        let nein; const fertig = new Promise((_, n) => { nein = n; });
        return { fertig, abbrechen() { nein(Object.assign(new Error('abgebrochen'), { code: 'E_ABGEBROCHEN' })); } };
      }
      // „netzweg…“ scheitert zweimal am Netz (dann klappt es), „netzweg-immer…“ immer – für die automatische Wiederholung
      if (name.startsWith('netzweg')) {
        const n = (steuerung.netzweg.get(name) || 0) + 1; steuerung.netzweg.set(name, n);
        if (name.startsWith('netzweg-immer') || n <= 2) return { abbrechen() {}, fertig: Promise.reject(Object.assign(new Error('Keine Verbindung'), { code: 'E_UNBEKANNT', details: { grund: 'netz' }, status: 0 })) };
        return { abbrechen() {}, fertig: Promise.resolve() };
      }
      if (name.startsWith('wackel') && !steuerung.gewackelt.has(name)) { steuerung.gewackelt.add(name); return { abbrechen() {}, fertig: Promise.reject(fehlerMit('E_NETZ', 'Netz weg')) }; }
      return { abbrechen() {}, fertig: name.startsWith('kaputt') ? Promise.reject(Object.assign(new Error('Netz weg'), { code: 'E_NETZ' })) : Promise.resolve() };
    },
    // Modaler Dialog wie app.js dialog(): hängt am body, beimSchliessen beim Schließen
    dialog: (inhalt, optionen = {}) => {
      const e = dokument.createElement('dialog'); e.setAttribute('class', `dialog ${optionen.klasse || ''}`);
      const koerper = dokument.createElement('div'); koerper.setAttribute('class', 'dialog-koerper');
      for (const k of [].concat(inhalt)) if (k) koerper.appendChild(k);
      e.appendChild(koerper); dokument.body.appendChild(e);
      let zu = false;
      const schliessen = (w) => { if (zu) return; zu = true; e.remove(); if (optionen.beimSchliessen) optionen.beimSchliessen(w); };
      steuerung.dialoge.push({ optionen, element: e });
      return { schliessen, element: e, koerper };
    },
    zeigeFehler: (e) => steuerung.meldungen.push({ text: (e && e.message) || 'Fehler', art: 'fehler' }),
    hashFuer: (...teile) => `#/${teile.join('/')}`,
    navigiere() {}, setzeTitel() {}, melden: (text, art) => steuerung.meldungen.push({ text, art }), fehlerText: (e) => (e && e.message) || 'Fehler',
  };
  await d.einbinden(wurzel, ctx);
  await abarbeiten();
  return { wurzel, ctx };
}

/** „Hochladen“ klicken und die Dateiauswahl mit `dateien` beantworten. */
async function hochladen(wurzel, dateien) {
  knopfMitTitel(wurzel, 'dateien.hochladen').click();
  const eingabe = dokument.body.children.find((k) => k.tagName === 'INPUT' && k.getAttribute('type') === 'file' && !k.hasAttribute('webkitdirectory'));
  assert.ok(eingabe, 'Dateiauswahl angelegt');
  eingabe.files = dateien;
  eingabe.ausloesen('change');
  await abarbeiten();
}

/** „Ordner hochladen“ klicken und die Auswahl mit Dateien samt webkitRelativePath beantworten. */
async function ordnerHochladen(wurzel, dateien) {
  knopfMitTitel(wurzel, 'dateien.ordner_hochladen').click();
  const eingabe = dokument.body.children.find((k) => k.tagName === 'INPUT' && k.hasAttribute('webkitdirectory'));
  assert.ok(eingabe, 'Ordnerauswahl angelegt');
  eingabe.files = dateien;
  eingabe.ausloesen('change');
  await abarbeiten();
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests (eine Modulinstanz – der Zustand der Ansicht bleibt wie im Browser über die Tests hinweg erhalten)
// ---------------------------------------------------------------------------------------------------------------------

dom();
mock.timers.enable({ apis: ['setTimeout'] });
const d = (await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href)).default;
// t() gibt den Schlüssel zurück, mit Parametern als JSON dahinter – so lassen sich Zahlen in Meldungen/Kopf nachzählen
(await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href))._test.setzeT((k, p) => (p ? `${k}${JSON.stringify(p)}` : k));
const zahlIn = (text, feld) => { const m = /\{.*\}$/.exec(text || ''); return m ? JSON.parse(m[0])[feld] : undefined; };
let { wurzel } = await einbinden(d);

test('Upload-Tafel: nach Erfolg sichtbar, schließt nach 5 s selbst – nicht früher', async () => {
  await hochladen(wurzel, [datei('a.mp3'), datei('b.mp3'), datei('c.mp3')]);
  assert.ok(tafel(), 'Tafel erscheint');
  assert.equal(zahlIn(tafelTitel(), 'gesamt'), 3);
  mock.timers.tick(4999); await abarbeiten();
  assert.ok(tafel(), 'nach 4,999 s noch sichtbar');
  mock.timers.tick(1); await abarbeiten();
  assert.equal(tafel(), null, 'nach 5 s geschlossen');
});

test('Upload-Tafel: nach dem Selbst-Schließen taucht sie beim Ordnerwechsel und Ansichtenwechsel nicht wieder auf', async () => {
  await d.navigieren({ id: 'dateien', teile: ['private', 'KI Musik'] }); await abarbeiten();
  assert.equal(tafel(), null, 'Unterordner öffnen hängt keine alte Tafel an');
  await d.navigieren({ id: 'dateien', teile: ['private'] }); await abarbeiten();
  assert.equal(tafel(), null, 'zurück zum Oberordner');
  await d.navigieren({ id: 'dateien', teile: [] }); await abarbeiten();
  assert.equal(tafel(), null, 'Freigabenübersicht');
  d.verlassen(); wurzel.remove();
  const neu = await einbinden(d);
  assert.equal(tafel(), null, 'Ansicht verlassen und neu eingebunden');
  wurzel = neu.wurzel;
});

test('Upload-Tafel: per X geschlossen bleibt sie zu – auch beim Ordnerwechsel und ohne auf den Zeitgeber zu warten', async () => {
  const w = wurzel;
  await hochladen(w, [datei('d.mp3')]);
  assert.ok(tafel());
  const schliessen = knopfMitTitel(tafel(), 'rahmen.schliessen');
  assert.ok(schliessen, 'X-Knopf, wenn alles fertig ist');
  schliessen.click(); await abarbeiten();
  assert.equal(tafel(), null, 'X schließt');
  await d.navigieren({ id: 'dateien', teile: ['private', 'KI Musik'] }); await abarbeiten();
  assert.equal(tafel(), null, 'Ordnerwechsel nach X');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null, 'späterer Zeitgeber öffnet nichts');
  await d.navigieren({ id: 'dateien', teile: ['private'] }); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Upload-Tafel: fehlgeschlagene Uploads bleiben stehen (auch über Ordnerwechsel), erfolgreiche verschwinden; X schließt endgültig', async () => {
  const w = wurzel;
  await hochladen(w, [datei('e.mp3'), datei('kaputt.mp3')]);
  assert.ok(tafel());
  mock.timers.tick(5000); await abarbeiten();
  assert.ok(tafel(), 'Fehler bleibt sichtbar');
  const zeilen = tafel().querySelectorAll('.dateien-upload');
  assert.equal(zeilen.length, 1, 'nur die fehlgeschlagene Zeile bleibt');
  assert.ok(zeilen[0].classList.contains('fehler'));
  assert.equal(knopfMitText(tafel(), 'dateien.alle_abbrechen'), undefined, 'kein „Alle abbrechen“, wenn nichts mehr läuft');
  assert.ok(aktionen() && knopfMitText(aktionen(), 'dateien.alle_erneut'), '„Alle erneut versuchen“ in eigener Zeile unter dem Kopf');
  assert.ok(knopfMitTitel(kopf(), 'rahmen.schliessen'), 'X bleibt im Kopf neben dem Titel');
  await d.navigieren({ id: 'dateien', teile: ['private', 'KI Musik'] }); await abarbeiten();
  assert.ok(tafel(), 'offener Fehler bleibt beim Ordnerwechsel sichtbar');
  knopfMitTitel(tafel(), 'rahmen.schliessen').click(); await abarbeiten();
  assert.equal(tafel(), null);
  await d.navigieren({ id: 'dateien', teile: ['private'] }); await abarbeiten();
  assert.equal(tafel(), null, 'nach X auch mit Fehlern nicht wieder da');
});

test('Upload-Tafel: neuer Stapel nach dem Schließen zeigt eine frische Tafel ohne alte Einträge', async () => {
  const w = wurzel;
  await hochladen(w, [datei('f.mp3')]);
  assert.ok(tafel());
  assert.equal(tafel().querySelectorAll('.dateien-upload').length, 1, 'nur der neue Eintrag');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Upload-Tafel: während ein Upload läuft – „Alle abbrechen“, kein X, Ordnerwechsel behält die Tafel; nach Abbruch schließt sie nach 5 s', async () => {
  await hochladen(wurzel, [datei('haengt.mp3')]);
  assert.ok(tafel());
  assert.ok(aktionen() && knopfMitText(aktionen(), 'dateien.alle_abbrechen'), '„Alle abbrechen“ solange etwas läuft');
  assert.equal(knopfMitTitel(kopf(), 'rahmen.schliessen'), undefined, 'kein X während des Hochladens');
  mock.timers.tick(10000); await abarbeiten();
  assert.ok(tafel(), 'laufender Upload: Tafel bleibt');
  await d.navigieren({ id: 'dateien', teile: ['private', 'KI Musik'] }); await abarbeiten();
  assert.ok(tafel(), 'laufender Upload: Tafel bleibt beim Ordnerwechsel sichtbar');
  knopfMitText(aktionen(), 'dateien.alle_abbrechen').click(); await abarbeiten();
  assert.equal(tafel().querySelector('.dateien-uploads-aktionen'), null, 'nach dem Abbruch keine Sammelknöpfe mehr');
  assert.ok(knopfMitTitel(kopf(), 'rahmen.schliessen'), 'X nach dem Abbruch');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null, 'abgebrochene Einträge verschwinden wie erfolgreiche');
  await d.navigieren({ id: 'dateien', teile: ['private'] }); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Upload-Tafel: ein offener Fehler bleibt auch beim Wechsel in eine andere Ansicht stehen (bis X), eine erledigte Tafel schließt beim Verlassen sofort', async () => {
  await hochladen(wurzel, [datei('kaputt2.mp3')]);
  mock.timers.tick(5000); await abarbeiten();
  assert.ok(tafel(), 'Fehler steht');
  d.verlassen(); wurzel.remove(); await abarbeiten();
  assert.ok(tafel(), 'Ansicht verlassen: Fehler bleibt sichtbar (Tafel am body)');
  assert.ok(knopfMitText(aktionen(), 'dateien.alle_erneut'), '„Erneut versuchen“ bleibt nutzbar');
  ({ wurzel } = await einbinden(d));
  assert.equal(dokument.body.children.filter((k) => k.classList.contains('dateien-uploads')).length, 1, 'nach dem Wiedereinstieg genau eine Tafel');
  knopfMitTitel(kopf(), 'rahmen.schliessen').click(); await abarbeiten();
  assert.equal(tafel(), null);
  await hochladen(wurzel, [datei('g.mp3')]);
  assert.ok(tafel());
  d.verlassen(); wurzel.remove(); await abarbeiten();
  assert.equal(tafel(), null, 'erledigte Tafel schließt beim Verlassen');
  ({ wurzel } = await einbinden(d));
  assert.equal(tafel(), null);
});

test('Upload-Tafel: Sitzungsende (Abmelden) bricht laufende Uploads ab und verwirft Tafel und Fehler – nichts taucht beim nächsten Nutzer auf', async () => {
  await hochladen(wurzel, [datei('kaputt3.mp3')]);
  mock.timers.tick(5000); await abarbeiten();
  await hochladen(wurzel, [datei('haengt2.mp3')]);
  assert.ok(tafel());
  assert.equal(typeof d.sitzungEnde, 'function', 'Ansicht bietet sitzungEnde()');
  d.sitzungEnde(); await abarbeiten();
  assert.equal(tafel(), null, 'Tafel sofort weg');
  mock.timers.tick(10000); await abarbeiten();
  assert.equal(tafel(), null, 'der abgebrochene Upload holt die Tafel nicht zurück');
  d.verlassen(); wurzel.remove();
  ({ wurzel } = await einbinden(d));
  assert.equal(tafel(), null, 'nächster Nutzer: keine Tafel');
  await d.navigieren({ id: 'dateien', teile: ['private', 'KI Musik'] }); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Ordner hochladen: ein zweiter Stapel mit demselben Ordner legt ihn erneut an (er kann inzwischen gelöscht sein – der Agent verlangt einen vorhandenen Zielordner)', async () => {
  const ordnerAnlagen = () => apiAufrufe.filter((a) => a.aktion === 'dateien.ordner').map((a) => `${a.params.pfad}|${a.params.name}`);
  await d.navigieren({ id: 'dateien', teile: ['private'] }); await abarbeiten();
  apiAufrufe.length = 0;
  await ordnerHochladen(wurzel, [{ name: 'a.mp3', size: 10, webkitRelativePath: 'KI Musik/a.mp3' }]);
  mock.timers.tick(5000); await abarbeiten();
  assert.ok(ordnerAnlagen().includes('|KI Musik'), 'erster Stapel legt „KI Musik“ an');
  apiAufrufe.length = 0;
  await ordnerHochladen(wurzel, [{ name: 'b.mp3', size: 10, webkitRelativePath: 'KI Musik/b.mp3' }]);
  mock.timers.tick(5000); await abarbeiten();
  assert.ok(ordnerAnlagen().includes('|KI Musik'), 'zweiter Stapel stellt „KI Musik“ erneut sicher (kein Merken über den Stapel hinaus)');
  assert.equal(tafel(), null);
});

const zeilenNamen = () => tafel().querySelectorAll('.dateien-upload').map((z) => z.alle().find((k) => k.classList.contains('dateien-upload-name')).textContent);

test('Ordner-Upload: scheitert das Anlegen des Ordners einmal, legt ihn die erste Datei an – kein toter Fehler, Tafel schließt nach 5 s', async () => {
  steuerung.ordner.set('Alben', 'scheitert-einmal');
  await ordnerHochladen(wurzel, [{ name: 'a.mp3', size: 10, webkitRelativePath: 'Alben/a.mp3' }, { name: 'b.mp3', size: 10, webkitRelativePath: 'Alben/b.mp3' }]);
  assert.equal(tafel().querySelectorAll('.dateien-upload.fehler').length, 0, 'kein Fehler stehen geblieben');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null, 'Tafel schließt – vorher blieb „0 von 0 fertig“ ohne Zeilen für immer stehen');
});

test('Ordner-Upload: scheitert der Ordner wirklich, steht er als eigene Zeile mit „Erneut versuchen“ da (nie eine leere Tafel)', async () => {
  // Ein leerer Ordner (per Ablage gezogen) ergibt nur den Ordner-Eintrag – keine Datei legt ihn nebenbei an
  steuerung.ordner.set('Kaputt', 'scheitert-einmal');
  const bereich = wurzel.alle().find((k) => k.classList.contains('dateien-bereich'));
  const ordnerEintrag = { isFile: false, isDirectory: true, name: 'Kaputt', createReader: () => ({ readEntries: (ok) => ok([]) }) };
  bereich.ausloesen('drop', { dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => ordnerEintrag }], files: [] } });
  await abarbeiten();
  mock.timers.tick(5000); await abarbeiten();
  assert.ok(tafel(), 'Fehler bleibt sichtbar');
  assert.deepEqual(zeilenNamen(), ['Kaputt/'], 'Ordner-Fehler als Zeile');
  assert.ok(knopfMitText(tafel(), 'dateien.erneut_versuchen'), '„Erneut versuchen“ in der Zeile');
  knopfMitText(tafel(), 'dateien.erneut_versuchen').click(); await abarbeiten();
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null, 'nach erfolgreichem Wiederholen geschlossen');
});

test('Abbrechen während der Ordneranlage: „Alle abbrechen“ und Abmelden verhindern den Upload danach (kein Start, keine Meldung)', async () => {
  // a) „Alle abbrechen“
  steuerung.ordner.set('Warte', 'haengt'); steuerung.hochgeladen.length = 0; steuerung.meldungen.length = 0;
  await ordnerHochladen(wurzel, [{ name: 'x.txt', size: 10, webkitRelativePath: 'Warte/x.txt' }]);
  assert.ok(steuerung.haengendeOrdner.length >= 1, 'Ordneranlage hängt');
  knopfMitText(aktionen(), 'dateien.alle_abbrechen').click(); await abarbeiten();
  for (const h of steuerung.haengendeOrdner.splice(0)) h.ok({});
  await abarbeiten();
  assert.deepEqual(steuerung.hochgeladen, [], 'kein Upload nach „Alle abbrechen“');
  assert.equal(steuerung.meldungen.filter((m) => m.art === 'fehler').length, 0);
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
  // b) Abmelden: die Ordneranlage kommt danach mit 401 zurück – keine Fehlermeldung mit dem Pfad des Vorgängers
  steuerung.ordner.set('Privat', 'haengt'); steuerung.meldungen.length = 0;
  await ordnerHochladen(wurzel, [{ name: 'geheim.txt', size: 10, webkitRelativePath: 'Privat/geheim.txt' }]);
  d.sitzungEnde(); await abarbeiten();
  for (const h of steuerung.haengendeOrdner.splice(0)) h.nein(Object.assign(fehlerMit('E_ANMELDUNG', 'Bitte anmelden'), { status: 401 }));
  await abarbeiten();
  assert.deepEqual(steuerung.hochgeladen, [], 'kein Upload nach dem Abmelden');
  assert.deepEqual(steuerung.meldungen, [], 'keine Meldung nach dem Abmelden');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
  steuerung.ordner.clear();
});

test('Zweiter Stapel innerhalb von 5 s: nur seine Zeilen, Erfolgsmeldung zählt nur ihn', async () => {
  steuerung.meldungen.length = 0;
  await hochladen(wurzel, [datei('s1.mp3'), datei('s2.mp3')]);
  mock.timers.tick(3000); await abarbeiten();
  await hochladen(wurzel, [datei('langsam-s3.mp3')]);
  assert.deepEqual(zeilenNamen(), ['langsam-s3.mp3'], 'alte „fertig“-Zeilen sind weg');
  steuerung.laeufe.get('langsam-s3.mp3').ok(); await abarbeiten();
  const erfolg = steuerung.meldungen.filter((m) => m.art === 'erfolg').map((m) => zahlIn(m.text, 'n'));
  assert.deepEqual(erfolg, [2, 1], 'jede Erfolgsmeldung zählt nur ihren Stapel – vorher 2 und dann 3');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('„Erneut versuchen“ innerhalb von 5 s: Erfolgsmeldung zählt nur die wiederholte Datei', async () => {
  steuerung.meldungen.length = 0;
  await hochladen(wurzel, [datei('w1.mp3'), datei('w2.mp3'), datei('wackel-w3.mp3')]);
  assert.deepEqual(steuerung.meldungen.filter((m) => m.art === 'erfolg').map((m) => zahlIn(m.text, 'n')), [2]);
  mock.timers.tick(1000); await abarbeiten();
  knopfMitText(tafel(), 'dateien.erneut_versuchen').click(); await abarbeiten();
  assert.deepEqual(steuerung.meldungen.filter((m) => m.art === 'erfolg').map((m) => zahlIn(m.text, 'n')), [2, 1], 'vorher „3 Dateien hochgeladen“');
  assert.deepEqual(zeilenNamen(), ['wackel-w3.mp3'], 'nur die wiederholte Zeile');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Ordner-Fehler, den eine Datei danach doch anlegt: Fehlerzeile verschwindet sofort, nicht erst am Ende des Datei-Uploads', async () => {
  steuerung.ordner.set('Film', 'scheitert-dann-haengt');
  await ordnerHochladen(wurzel, [{ name: 'langsam-gross.mkv', size: 10, webkitRelativePath: 'Film/langsam-gross.mkv' }]);
  assert.deepEqual(tafel().querySelectorAll('.dateien-upload.fehler').map((z) => z.dataset.upload).length, 1, 'Ordner „Film/“ zunächst als Fehler');
  for (const h of steuerung.haengendeOrdner.splice(0)) h.ok({});
  await abarbeiten();
  assert.equal(tafel().querySelectorAll('.dateien-upload.fehler').length, 0, 'Fehlerzeile weg, während die Datei noch läuft');
  assert.equal(zahlIn(tafelTitel(), 'gesamt'), 1, 'Kopf zählt nur noch die Datei');
  steuerung.laeufe.get('langsam-gross.mkv').ok(); await abarbeiten();
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
  steuerung.ordner.clear();
});

test('Abbrechen während der Ordneranlage: keine weitere Ordnerebene wird danach noch angelegt', async () => {
  steuerung.ordner.set('Tief', 'haengt'); steuerung.hochgeladen.length = 0;
  await ordnerHochladen(wurzel, [{ name: 'x.txt', size: 10, webkitRelativePath: 'Tief/Unter/x.txt' }]);
  knopfMitText(aktionen(), 'dateien.alle_abbrechen').click(); await abarbeiten();
  apiAufrufe.length = 0;
  for (const h of steuerung.haengendeOrdner.splice(0)) h.ok({});
  await abarbeiten();
  assert.deepEqual(apiAufrufe.filter((a) => a.aktion === 'dateien.ordner').map((a) => a.params.name), [], 'kein „Unter“ nach dem Abbruch');
  assert.deepEqual(steuerung.hochgeladen, []);
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
  steuerung.ordner.clear();
});

test('Kopf bei reinem Ordner-Fehler: zählt die Fehlerzeile („0 von 1“ statt „0 von 0“)', async () => {
  steuerung.ordner.set('Leer', 'scheitert-einmal');
  const bereich = wurzel.alle().find((k) => k.classList.contains('dateien-bereich'));
  const leer = { isFile: false, isDirectory: true, name: 'Leer', createReader: () => ({ readEntries: (ok) => ok([]) }) };
  bereich.ausloesen('drop', { dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => leer }], files: [] } });
  await abarbeiten();
  mock.timers.tick(5000); await abarbeiten();
  assert.deepEqual(zeilenNamen(), ['Leer/']);
  assert.equal(zahlIn(tafelTitel(), 'fertig'), 0); assert.equal(zahlIn(tafelTitel(), 'gesamt'), 1);
  knopfMitTitel(kopf(), 'rahmen.schliessen').click(); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Leerer Ordner abgelegt: während der Anlage eine Ordnerzeile, danach sofort zu (keine leere Tafel für 5 s)', async () => {
  steuerung.ordner.set('Neu', 'haengt');
  const bereich = wurzel.alle().find((k) => k.classList.contains('dateien-bereich'));
  const leer = { isFile: false, isDirectory: true, name: 'Neu', createReader: () => ({ readEntries: (ok) => ok([]) }) };
  bereich.ausloesen('drop', { dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => leer }], files: [] } });
  await abarbeiten();
  assert.deepEqual(zeilenNamen(), ['Neu/'], 'Ordner in Arbeit ist sichtbar');
  assert.equal(zahlIn(tafelTitel(), 'gesamt'), 1, 'Kopf „0 von 1“ passend zur Zeile');
  assert.equal(tafel().querySelector('.dateien-upload-status').textContent, '', 'keine Größenangabe für Ordner');
  for (const h of steuerung.haengendeOrdner.splice(0)) h.ok({});
  await abarbeiten();
  assert.equal(tafel(), null, 'sofort zu, nicht 5 s lang leer');
  steuerung.ordner.clear();
});

test('Mehr als 30 Einträge mit vielen Fehlern: kein Fehler und kein laufender Upload wird verdrängt', async () => {
  const liste = [...Array.from({ length: 31 }, (_, i) => datei(`kaputt-${i}.mp3`)), datei('langsam-a.mp3'), datei('langsam-b.mp3'), ...Array.from({ length: 5 }, (_, i) => datei(`langsam-w${i}.mp3`))];
  await hochladen(wurzel, liste);
  const klassen = () => tafel().querySelectorAll('.dateien-upload').map((z) => z.klassen()[1]);
  assert.equal(klassen().filter((k) => k === 'fehler').length, 31, 'alle 31 Fehler sichtbar');
  assert.equal(klassen().filter((k) => k === 'laeuft').length, 2, 'beide laufenden sichtbar');
  assert.equal(zahlIn(tafel().querySelector('.dateien-uploads-weitere').textContent, 'n'), 5, 'die 5 wartenden als „weitere“');
  knopfMitText(aktionen(), 'dateien.alle_abbrechen').click(); await abarbeiten();
  knopfMitTitel(kopf(), 'rahmen.schliessen').click(); await abarbeiten();
  assert.equal(tafel(), null);
  steuerung.laeufe.clear();
});

test('Mehr als 30 Dateien: laufende Uploads haben immer eine Zeile, Fortschritt kommt an, Hinweis auf weitere', async () => {
  const liste = Array.from({ length: 40 }, (_, i) => datei(`langsam-${String(i).padStart(2, '0')}.mp3`));
  await hochladen(wurzel, liste);
  const laufend = () => tafel().querySelectorAll('.dateien-upload.laeuft').map((z) => z.dataset.upload);
  assert.equal(tafel().querySelectorAll('.dateien-upload').length, 30, 'höchstens 30 Zeilen');
  assert.equal(laufend().length, 2, 'beide laufenden Uploads sichtbar und als „läuft“ markiert');
  assert.equal(zahlIn(tafel().querySelector('.dateien-uploads-weitere').textContent, 'n'), 10, 'Hinweis „und 10 weitere Einträge“');
  const erster = steuerung.laeufe.get('langsam-00.mp3');
  erster.beiFortschritt(5);
  const zeile00 = tafel().querySelectorAll('.dateien-upload').find((z) => z.alle().some((k) => k.textContent === 'langsam-00.mp3'));
  assert.match(zeile00.querySelector('.dateien-upload-status').textContent, / · /, 'Fortschritt landet in der richtigen Zeile');
  for (let i = 0; i < 40; i++) { const l = steuerung.laeufe.get(`langsam-${String(i).padStart(2, '0')}.mp3`); if (l) l.ok(); await abarbeiten(); }
  await abarbeiten();
  assert.equal(tafel().querySelectorAll('.dateien-upload.fertig').length, 30);
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Abmelden während hängender Ordneranlagen: der nächste Nutzer bekommt sofort beide Upload-Plätze, späte Rückläufer melden nichts doppelt', async () => {
  steuerung.ordner.set('S1A', 'haengt'); steuerung.ordner.set('S1B', 'haengt');
  await ordnerHochladen(wurzel, [{ name: 'x.txt', size: 10, webkitRelativePath: 'S1A/x.txt' }, { name: 'y.txt', size: 10, webkitRelativePath: 'S1B/y.txt' }]);
  const alt = steuerung.haengendeOrdner.splice(0);
  assert.ok(alt.length >= 2, 'zwei Ordneranlagen hängen');
  d.sitzungEnde(); d.verlassen(); wurzel.remove();
  ({ wurzel } = await einbinden(d));
  steuerung.ordner.clear(); steuerung.hochgeladen.length = 0; steuerung.meldungen.length = 0;
  await hochladen(wurzel, [datei('langsam-n1.mp3'), datei('langsam-n2.mp3')]);
  assert.deepEqual(steuerung.hochgeladen, ['langsam-n1.mp3', 'langsam-n2.mp3'], 'beide starten sofort – vorher blockierten die alten Anfragen die Plätze');
  alt[0].ok({}); await abarbeiten();
  steuerung.laeufe.get('langsam-n1.mp3').ok(); steuerung.laeufe.get('langsam-n2.mp3').ok(); await abarbeiten();
  alt[1].nein(fehlerMit('E_AGENT', 'weg')); await abarbeiten();
  for (const h of steuerung.haengendeOrdner.splice(0)) h.ok({});
  await abarbeiten();
  assert.deepEqual(steuerung.meldungen.map((m) => [m.art, zahlIn(m.text, 'n')]), [['erfolg', 2]], 'genau eine Erfolgsmeldung mit n=2');
  assert.deepEqual(steuerung.hochgeladen, ['langsam-n1.mp3', 'langsam-n2.mp3'], 'kein Upload der alten Sitzung');
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
  await hochladen(wurzel, [datei('langsam-p1.mp3'), datei('langsam-p2.mp3'), datei('langsam-p3.mp3')]);
  assert.equal(steuerung.hochgeladen.filter((n) => n.startsWith('langsam-p')).length, 2, 'danach wieder genau 2 parallel');
  for (const n of ['langsam-p1.mp3', 'langsam-p2.mp3']) { steuerung.laeufe.get(n).ok(); await abarbeiten(); }
  steuerung.laeufe.get('langsam-p3.mp3').ok(); await abarbeiten();
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// Namenskonflikte beim Hochladen (Betreiber-Fund 26.09.: vorhandene Dateien wurden ohne Rückfrage überschrieben)
// ---------------------------------------------------------------------------------------------------------------------
const offenerDialog = () => dokument.body.children.find((k) => k.tagName === 'DIALOG') || null;
const wahlKnoepfe = () => offenerDialog().querySelectorAll('.dateien-konflikt-wahl').map((k) => k.dataset.wahl);
const waehle = async (wahl, fuerAlle = false) => {
  const dlg = offenerDialog();
  if (fuerAlle) { const kasten = dlg.alle().find((k) => k.tagName === 'INPUT' && k.getAttribute('type') === 'checkbox'); assert.ok(kasten, '„Für alle“-Haken vorhanden'); kasten.checked = true; }
  dlg.querySelectorAll('.dateien-konflikt-wahl').find((k) => k.dataset.wahl === wahl).click();
  await abarbeiten();
};
function konfliktAufraeumen() { steuerung.vorhanden.clear(); steuerung.bei.length = 0; steuerung.meldungen.length = 0; steuerung.belegt.clear(); }

test('Konflikt: ohne vorhandene Namen keine Rückfrage, Upload mit bei_vorhanden „fehler“ (überschreibt nie)', async () => {
  konfliktAufraeumen();
  await hochladen(wurzel, [datei('frei-1.txt'), datei('frei-2.txt')]);
  assert.equal(offenerDialog(), null);
  assert.deepEqual(steuerung.bei, [['frei-1.txt', 'fehler'], ['frei-2.txt', 'fehler']]);
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Konflikt: Rückfrage je Datei mit Vergleich; „Beide behalten“ für alle übrigen, freie Dateien normal', async () => {
  konfliktAufraeumen();
  steuerung.vorhanden.set('k-a.txt', { art: 'datei', groesse: 10, geaendert: '2026-09-20T10:00:00.000Z' });
  steuerung.vorhanden.set('k-b.txt', { art: 'datei', groesse: 20, geaendert: '2026-09-20T10:00:00.000Z' });
  await hochladen(wurzel, [datei('k-a.txt'), datei('k-b.txt'), datei('k-c.txt')]);
  assert.ok(offenerDialog(), 'Dialog erscheint vor dem Hochladen');
  assert.equal(steuerung.bei.length, 0, 'noch nichts hochgeladen');
  assert.deepEqual(wahlKnoepfe(), ['ersetzen', 'beide', 'ueberspringen']);
  assert.match(offenerDialog().textContent, /dateien\.konflikt_vorhanden.*dateien\.konflikt_neu/, 'Vergleich vorhanden/neu');
  assert.ok(offenerDialog().textContent.includes('dateien.konflikt_fuer_alle{"n":1}'), '„für den übrigen Konflikt“');
  assert.ok(offenerDialog().textContent.includes('k-a (1).txt'), 'Vorschlag für den nummerierten Namen');
  await waehle('beide', true);
  assert.equal(offenerDialog(), null, 'kein zweiter Dialog – gilt für alle');
  assert.deepEqual(steuerung.bei.sort(), [['k-a.txt', 'beide'], ['k-b.txt', 'beide'], ['k-c.txt', 'fehler']]);
  const status = tafel().querySelectorAll('.dateien-upload-status').map((k) => k.textContent).join(' | ');
  assert.ok(status.includes('dateien.upload_als{"name":"k-a (1).txt"}'), `Tafel nennt den neuen Namen: ${status}`);
  mock.timers.tick(5000); await abarbeiten();
});

test('Konflikt: einzeln Ersetzen und Überspringen; übersprungene werden gemeldet und nicht hochgeladen', async () => {
  konfliktAufraeumen();
  steuerung.vorhanden.set('e-a.txt', { art: 'datei', groesse: 1, geaendert: '2026-09-20T10:00:00.000Z' });
  steuerung.vorhanden.set('e-b.txt', { art: 'datei', groesse: 1, geaendert: '2026-09-20T10:00:00.000Z' });
  await hochladen(wurzel, [datei('e-a.txt'), datei('e-b.txt')]);
  await waehle('ersetzen');
  assert.ok(offenerDialog(), 'ohne Haken: zweiter Konflikt wird einzeln gefragt');
  assert.equal(offenerDialog().alle().find((k) => k.tagName === 'INPUT'), undefined, 'beim letzten Konflikt kein „für alle“');
  await waehle('ueberspringen');
  assert.deepEqual(steuerung.bei, [['e-a.txt', 'ersetzen']]);
  assert.ok(steuerung.meldungen.some((m) => m.text === 'dateien.uebersprungen{"n":1}'));
  assert.ok(tafel().querySelectorAll('.dateien-upload-status').some((k) => k.textContent.includes('dateien.upload_ersetzt')));
  mock.timers.tick(5000); await abarbeiten();
});

test('Konflikt: Schließen/Abbrechen bricht das ganze Hochladen ab; alles übersprungen legt auch keine Ordner an', async () => {
  konfliktAufraeumen();
  steuerung.vorhanden.set('x-a.txt', { art: 'datei', groesse: 1, geaendert: null });
  await hochladen(wurzel, [datei('x-a.txt'), datei('x-b.txt')]);
  knopfMitText(offenerDialog(), 'dateien.konflikt_abbrechen_hochladen').click(); await abarbeiten();
  assert.equal(offenerDialog(), null); assert.equal(steuerung.bei.length, 0, 'nichts hochgeladen'); assert.equal(tafel(), null);
  // Ordner-Upload, alle Dateien vorhanden → Überspringen für alle → keine Ordneranlage, kein Upload
  steuerung.vorhanden.set('proj/a.txt', { art: 'datei', groesse: 1, geaendert: null });
  steuerung.vorhanden.set('proj/b.txt', { art: 'datei', groesse: 1, geaendert: null });
  const vorherOrdner = apiAufrufe.filter((a) => a.aktion === 'dateien.ordner').length;
  await ordnerHochladen(wurzel, [{ name: 'a.txt', size: 1, webkitRelativePath: 'proj/a.txt' }, { name: 'b.txt', size: 1, webkitRelativePath: 'proj/b.txt' }]);
  const vh = apiAufrufe.filter((a) => a.aktion === 'dateien.vorhanden').at(-1);
  assert.deepEqual(vh.params.namen, ['proj/a.txt', 'proj/b.txt'], 'Prüfung mit Pfaden relativ zum Zielordner');
  await waehle('ueberspringen', true);
  assert.equal(steuerung.bei.length, 0);
  assert.equal(apiAufrufe.filter((a) => a.aktion === 'dateien.ordner').length, vorherOrdner, 'keine Ordner angelegt');
  assert.equal(tafel(), null);
});

test('Konflikt: vorhandener Ordner – kein „Ersetzen“; „für alle ersetzen“ fragt ihn trotzdem einzeln', async () => {
  konfliktAufraeumen();
  steuerung.vorhanden.set('o-a.txt', { art: 'datei', groesse: 1, geaendert: null });
  steuerung.vorhanden.set('o-ordner', { art: 'ordner', groesse: null, geaendert: null });
  await hochladen(wurzel, [datei('o-a.txt'), datei('o-ordner')]);
  await waehle('ersetzen', true);
  assert.ok(offenerDialog(), 'Ordner-Konflikt wird trotz „für alle“ gefragt');
  assert.deepEqual(wahlKnoepfe(), ['beide', 'ueberspringen']);
  await waehle('beide');
  assert.deepEqual(steuerung.bei.sort(), [['o-a.txt', 'ersetzen'], ['o-ordner', 'beide']]);
  mock.timers.tick(5000); await abarbeiten();
});

test('Konflikt: Upload scheitert, weil der Name inzwischen belegt ist → „Erneut versuchen“ fragt nach', async () => {
  konfliktAufraeumen();
  steuerung.belegt.add('spaet.txt');
  await hochladen(wurzel, [datei('spaet.txt')]);
  assert.equal(offenerDialog(), null, 'bei der Prüfung war der Name frei');
  const zeile = tafel().querySelectorAll('.dateien-upload')[0];
  assert.ok(zeile.classList.contains('fehler'));
  steuerung.vorhanden.set('spaet.txt', { art: 'datei', groesse: 5, geaendert: null });
  knopfMitText(tafel(), 'dateien.erneut_versuchen').click(); await abarbeiten();
  assert.ok(offenerDialog(), 'Rückfrage beim Wiederholen');
  await waehle('ersetzen');
  assert.deepEqual(steuerung.bei, [['spaet.txt', 'fehler'], ['spaet.txt', 'ersetzen']]);
  mock.timers.tick(5000); await abarbeiten();
  assert.equal(tafel(), null);
});

test('Konflikt: nummerierter Namensvorschlag wie im Agenten', async () => {
  const { nummerierterName } = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'dateien.js')).href);
  assert.equal(nummerierterName('Bericht.pdf'), 'Bericht (1).pdf');
  assert.equal(nummerierterName('Bild (2).png'), 'Bild (3).png');
  assert.equal(nummerierterName('archiv.tar.gz'), 'archiv (1).tar.gz');
  assert.equal(nummerierterName('.bashrc'), '.bashrc (1)');
  assert.equal(nummerierterName('ohne'), 'ohne (1)');
});

test('Rahmen: Abmelden und abgelaufene Sitzung (401) rufen sitzungEnde() aller geladenen Ansichten auf', async () => {
  const fs = await import('node:fs/promises');
  const q = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.ok(q.includes("for (const m of module.values()) { if (typeof m.sitzungEnde === 'function')"), 'sitzungBeendet() geht über alle geladenen Ansichten');
  const abmelden = q.slice(q.indexOf('async function abmelden()'), q.indexOf('function baueNavigation()'));
  assert.match(abmelden, /zustand\.nutzer = null;\s*sitzungBeendet\(\);/, 'abmelden()');
  assert.ok(q.includes("zustand.nutzer = null; sitzungBeendet(); zeigeSolo('anmeldung'); return; }"), 'zeigeFehler() bei 401');
  assert.ok(q.includes("zustand.nutzer = null; sitzungBeendet(); await zeigeSolo('anmeldung'); return; }"), 'starten() bei 401');
});

test.after(() => { mock.timers.reset(); });

test('Upload-Tafel: Netzfehler → automatisch bis zu 3 neue Versuche nach je 10 s, dann erst Fehler (Betreiber 12.10.2026)', async () => {
  const w = wurzel;
  const meldungenVorher = steuerung.meldungen.length;
  await hochladen(w, [datei('netzweg.mp3'), datei('netzweg-immer.mp3')]);
  assert.equal(steuerung.netzweg.get('netzweg.mp3'), 1);
  assert.ok(tafel().textContent.includes('dateien.upload_neuer_versuch'), 'Hinweis „neuer Versuch“ in der Tafel');
  assert.ok(!steuerung.meldungen.slice(meldungenVorher).some((m) => m.art === 'fehler'), 'noch keine Fehlermeldung');
  mock.timers.tick(9999); await abarbeiten();
  assert.equal(steuerung.netzweg.get('netzweg.mp3'), 1, 'nicht vor 10 s');
  mock.timers.tick(1); await abarbeiten();
  assert.equal(steuerung.netzweg.get('netzweg.mp3'), 2, 'zweiter Versuch nach 10 s');
  mock.timers.tick(10000); await abarbeiten();
  assert.equal(steuerung.netzweg.get('netzweg.mp3'), 3, 'dritter Versuch klappt');
  mock.timers.tick(10000); await abarbeiten();
  assert.equal(steuerung.netzweg.get('netzweg-immer.mp3'), 4, 'erster Versuch + 3 Wiederholungen');
  mock.timers.tick(10000); await abarbeiten();
  assert.equal(steuerung.netzweg.get('netzweg-immer.mp3'), 4, 'danach kein weiterer Versuch');
  const fehler = steuerung.meldungen.slice(meldungenVorher).filter((m) => m.art === 'fehler');
  assert.equal(fehler.length, 1, 'genau eine Fehlermeldung – für die Datei, die immer scheitert');
  assert.ok(fehler[0].text.includes('netzweg-immer.mp3'));
  assert.ok(tafel().textContent.includes('dateien.upload_nach_versuchen'), 'Fehlertext nennt die Wiederholungen');
  knopfMitTitel(tafel(), 'rahmen.schliessen').click(); await abarbeiten();
});
