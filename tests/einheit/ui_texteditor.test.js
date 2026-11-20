// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Texteditor im Dateimanager (public/texteditor.js, Plan 01 Aufgabe 7): Speichern beim Schließen, Netzfehler hält
// den Dialog offen, Konfliktfrage mit Kopie, nur lesen, CRLF/BOM/Nicht-UTF-8, Strg/⌘+S, beforeunload.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
let dom; let app; let ed;
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 5; i++) await warte(); };
const INFO = { geaendert: '2026-10-18T10:00:00.000Z', groesse: 4 };
const JETZT = new Date(2026, 9, 18, 15, 42);

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  ed = await import(pathToFileURL(path.join(PUBLIC, 'texteditor.js')).href);
});
after(() => dom.aufraeumen());
// Editoren der Tests richtig schließen (sonst bliebe z. B. der beforeunload-Hörer eines ungespeicherten Editors aktiv)
const offen = [];
async function oeffnen(ctx, optionen) { const h = await ed.texteditorOeffnen(ctx, optionen); offen.push(h); return h; }
afterEach(() => {
  for (const h of offen.splice(0)) h.schliessen(undefined, { sofort: true });
  for (const d of document.body.querySelectorAll('dialog')) d.remove();
});

/** Schein-ctx: api zeichnet auf; `antworten` liefert je Aktion eine Folge von Ergebnissen oder Fehlern. */
function ctxBauen({ inhalt = 'alt\n', antworten = {} } = {}) {
  const aufrufe = [];
  const folge = Object.fromEntries(Object.entries(antworten).map(([k, v]) => [k, [...v]]));
  return {
    aufrufe,
    dialog: app.dialog, melden() {}, downloadUrl: () => '/api/dateien/herunterladen',
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion === 'dateien.info') return { ...INFO };
      const naechste = (folge[aktion] || []).shift();
      if (naechste instanceof Error) throw naechste;
      return naechste ?? { pfad: params.pfad, name: params.pfad.split('/').pop(), geaendert: '2026-10-18T10:05:00.000Z', groesse: 4 };
    },
    ladeBlob: async () => new Blob([inhalt]),
  };
}
const fehler = (code, details) => Object.assign(new Error(code), { code, details });
const speicherAufrufe = (ctx) => ctx.aufrufe.filter(([a]) => a === 'dateien.text.speichern').map(([, p]) => p);
const esc = (h) => h.element.dispatchEvent(new Event('cancel', { cancelable: true }));
function tippen(h, wert) { h.feld.value = wert; h.feld.dispatchEvent(new Event('input', { bubbles: true })); }

test('reine Helfer', () => {
  assert.equal(ed.zeilenendeErkennen('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(ed.zeilenendeErkennen('a\nb\n'), '\n');
  assert.equal(ed.fuerSpeichern('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(ed.fuerSpeichern('a\nb\n', '\n'), 'a\nb\n');
  assert.equal(ed.kopieName('notiz.md', JETZT), 'notiz (bearbeitet 2026-10-18 15-42).md');
  assert.equal(ed.kopieName('Makefile', new Date(2026, 9, 18, 9, 5), 2), 'Makefile (bearbeitet 2026-10-18 09-05) (2)');
  assert.equal(ed.kopieName('.env', JETZT), '.env (bearbeitet 2026-10-18 15-42)');
  assert.equal(ed.istMarkdown('A.MD'), true);
  assert.equal(ed.istMarkdown('a.txt'), false);
  assert.equal(ed.textDekodieren(new Uint8Array([0xe4, 0x0a]).buffer).utf8, false);
  assert.equal(ed.textDekodieren(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer).text, '﻿a');
});

test('tippen + Esc speichert mit erwartet-Stand und schließt', async () => {
  const ctx = ctxBauen(); let neu = 0;
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true, nachSpeichern: () => { neu++; } });
  assert.equal(h.feld.value, 'alt\n');
  tippen(h, 'neu\n'); esc(h); await ticks();
  assert.deepEqual(speicherAufrufe(ctx), [{ freigabe: 'daten', pfad: 'a.md', inhalt: 'neu\n', erwartet: INFO }]);
  assert.equal(h.element.open, false);
  assert.equal(neu, 1);
});

test('Netzfehler beim Schließen hält den Dialog offen', async () => {
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [fehler('E_AGENT')] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'neu\n'); esc(h); await ticks();
  assert.equal(h.element.open, true);
  assert.equal(h.feld.value, 'neu\n');
  assert.match(h.status.textContent, /dateien\.editor_fehler_speichern/);
});

test('Konflikt → Kopie (mit Ausweichnamen bei Doppel)', async () => {
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [fehler('E_GEAENDERT', { geaendert: 'x', groesse: 9 }), fehler('E_EXISTIERT', { name: 'n' })] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'ordner/notiz.md', eintrag: { name: 'notiz.md' }, schreibbar: true, jetzt: () => JETZT });
  tippen(h, 'meins\n'); esc(h); await ticks();
  const frage = [...document.body.querySelectorAll('dialog')].find((d) => d !== h.element);
  assert.ok(frage, 'Konfliktfrage ist offen');
  frage.querySelector('[data-wahl="kopie"]').click(); await ticks();
  const s = speicherAufrufe(ctx);
  assert.equal(s.length, 3);
  assert.deepEqual(s[1], { freigabe: 'daten', pfad: 'ordner/notiz (bearbeitet 2026-10-18 15-42).md', inhalt: 'meins\n', neu: true });
  assert.equal(s[2].pfad, 'ordner/notiz (bearbeitet 2026-10-18 15-42) (2).md');
  assert.equal(h.element.open, false);
});

test('Konflikt → Abbrechen lässt den Editor offen, Überschreiben speichert ohne erwartet', async () => {
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [fehler('E_GEAENDERT', {}), fehler('E_GEAENDERT', {})] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'x\n'); esc(h); await ticks();
  let frage = [...document.body.querySelectorAll('dialog')].find((d) => d !== h.element);
  frage.querySelector('[data-wahl="abbrechen"]').click(); await ticks();
  assert.equal(h.element.open, true);
  esc(h); await ticks();
  frage = [...document.body.querySelectorAll('dialog')].find((d) => d !== h.element);
  frage.querySelector('[data-wahl="ueberschreiben"]').click(); await ticks();
  const s = speicherAufrufe(ctx);
  assert.equal(s.length, 3);
  assert.equal('erwartet' in s[2], false);
  assert.equal(h.element.open, false);
});

test('unverändert → kein Speichern; nur lesen → readOnly und kein Speichern', async () => {
  const ctx = ctxBauen();
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  esc(h); await ticks();
  assert.equal(h.element.open, false);
  const ctx2 = ctxBauen();
  const h2 = await oeffnen(ctx2, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: false });
  assert.equal(h2.feld.readOnly, true);
  assert.match(h2.hinweis.textContent, /dateien\.editor_nur_lesen/);
  tippen(h2, 'egal'); esc(h2); await ticks();
  assert.deepEqual(speicherAufrufe(ctx), []);
  assert.deepEqual(speicherAufrufe(ctx2), []);
  assert.equal(h2.element.open, false);
});

test('CRLF bleibt', async () => {
  const ctx = ctxBauen({ inhalt: 'a\r\nb\r\n' });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'w.txt', eintrag: { name: 'w.txt' }, schreibbar: true });
  assert.equal(h.feld.value, 'a\nb\n');
  tippen(h, 'a\nb\nc\n'); esc(h); await ticks();
  assert.equal(speicherAufrufe(ctx)[0].inhalt, 'a\r\nb\r\nc\r\n');
});

test('BOM bleibt erhalten', async () => {
  const ctx = ctxBauen({ inhalt: new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]) });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'b.txt', eintrag: { name: 'b.txt' }, schreibbar: true });
  tippen(h, `${h.feld.value}b\n`); esc(h); await ticks();
  assert.equal(speicherAufrufe(ctx)[0].inhalt, '﻿a\nb\n');
});

test('Latin-1 nur lesen', async () => {
  const ctx = ctxBauen({ inhalt: new Uint8Array([0x66, 0xe4, 0x0a]) });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'l.txt', eintrag: { name: 'l.txt' }, schreibbar: true });
  assert.equal(h.feld.readOnly, true);
  assert.match(h.hinweis.textContent, /dateien\.editor_nicht_utf8/);
});

test('Strg/⌘+S speichert ohne zu schließen, beforeunload warnt nur bei ungespeichert', async () => {
  const ctx = ctxBauen();
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'neu\n');
  const vorher = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(vorher);
  assert.equal(vorher.defaultPrevented, true, 'ungespeichert → Warnung');
  const taste = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
  h.feld.dispatchEvent(taste); await ticks();
  assert.equal(taste.defaultPrevented, true);
  assert.equal(speicherAufrufe(ctx).length, 1);
  assert.equal(h.element.open, true);
  assert.match(h.status.textContent, /dateien\.editor_gespeichert/);
  const nachher = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(nachher);
  assert.equal(nachher.defaultPrevented, false, 'gespeichert → keine Warnung');
  esc(h); await ticks();
  assert.equal(h.element.open, false);
});

test('Markdown: Umschalter zeigt die Ansicht', async () => {
  const ctx = ctxBauen({ inhalt: '# Titel\n' });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  h.element.querySelector('[data-modus="ansicht"]').click();
  assert.equal(h.feld.hidden, true);
  assert.equal(h.element.querySelector('.texteditor-ansicht h1').textContent, 'Titel');
  h.element.querySelector('[data-modus="bearbeiten"]').click();
  assert.equal(h.feld.hidden, false);
});

test('Markdown: „Ansicht“ schon während des Ladens zeigt danach den Text (Bedienprobe 0.21.1)', async () => {
  let liefern; const blob = new Promise((r) => { liefern = r; });
  const ctx = { ...ctxBauen(), ladeBlob: () => blob };
  const laeuft = oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  document.body.querySelector('[data-modus="ansicht"]').click(); // der Dialog steht schon, der Text lädt noch
  liefern(new Blob(['# Titel\n']));
  const h = await laeuft;
  assert.equal(h.feld.hidden, true);
  assert.equal(h.element.querySelector('.texteditor-ansicht h1')?.textContent, 'Titel');
});

// ---- Abschlussprüfung Plan 01 (Befunde 1, 3, 9) -----------------------------------------------------------------
const frageKnopf = (wahl) => document.body.querySelector(`[data-wahl="${wahl}"]`);

test('Schließen während eines laufenden Speicherns: später Getipptes wird noch gespeichert, erst dann zu (Befund 1)', async () => {
  let freigeben;
  const verzoegert = new Promise((r) => { freigeben = () => r({ pfad: 'a.md', name: 'a.md', geaendert: '2026-10-18T10:05:00.000Z', groesse: 5 }); });
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [verzoegert] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'eins\n');
  h.feld.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await ticks();
  tippen(h, 'eins zwei\n');
  esc(h); await ticks();
  assert.equal(h.element.open, true, 'noch offen, solange gespeichert wird');
  assert.equal(h.feld.readOnly, true, 'beim Schließen kein Weitertippen');
  freigeben(); await ticks(); await ticks();
  assert.deepEqual(speicherAufrufe(ctx).map((p) => p.inhalt), ['eins\n', 'eins zwei\n']);
  assert.equal(speicherAufrufe(ctx)[1].erwartet.geaendert, '2026-10-18T10:05:00.000Z', 'zweites Speichern mit dem neuen Stand');
  assert.equal(h.element.open, false, 'erst nach dem zweiten Speichern zu');
});

test('Dauerhafter Speicherfehler: Weiter bearbeiten, Text herunterladen, Ohne Speichern schließen (Befund 3)', async (t) => {
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [fehler('E_NICHT_GEFUNDEN'), fehler('E_NICHT_GEFUNDEN'), fehler('E_NICHT_GEFUNDEN')] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'neu\n'); esc(h); await ticks();
  assert.ok(frageKnopf('weiter') && frageKnopf('herunterladen') && frageKnopf('kopie') && frageKnopf('verwerfen'), 'vier Wege');
  frageKnopf('weiter').click(); await ticks();
  assert.equal(h.element.open, true); assert.equal(h.feld.readOnly, false, 'wieder bearbeitbar');
  const blobs = [];
  t.mock.method(URL, 'createObjectURL', (b) => { blobs.push(b); return 'blob:test'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  esc(h); await ticks();
  frageKnopf('herunterladen').click(); await ticks();
  assert.equal(blobs.length, 1); assert.equal(await blobs[0].text(), 'neu\n');
  assert.equal(h.element.open, true, 'nach dem Herunterladen noch offen');
  esc(h); await ticks();
  frageKnopf('verwerfen').click(); await ticks();
  const ok = [...document.body.querySelectorAll('dialog .dialog-knoepfe .knopf')].at(-1);
  ok.click(); await ticks();
  assert.equal(h.element.open, false, 'ohne Speichern geschlossen');
  assert.equal(speicherAufrufe(ctx).length, 3);
});

test('Dauerhafter Speicherfehler → Als Kopie speichern schließt nach Erfolg (Befund 3)', async () => {
  const ctx = ctxBauen({ antworten: { 'dateien.text.speichern': [fehler('E_RECHTE')] } });
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'ordner/a.md', eintrag: { name: 'a.md' }, schreibbar: true, jetzt: () => JETZT });
  tippen(h, 'neu\n'); esc(h); await ticks();
  frageKnopf('kopie').click(); await ticks(); await ticks();
  const kopie = speicherAufrufe(ctx).at(-1);
  assert.equal(kopie.neu, true); assert.equal(kopie.pfad, 'ordner/a (bearbeitet 2026-10-18 15-42).md'); assert.equal(kopie.inhalt, 'neu\n');
  assert.equal(h.element.open, false);
});

test('Klick neben den Editor schließt ihn nicht (Markieren über den Rand, Befund 9)', async () => {
  const ctx = ctxBauen();
  const h = await oeffnen(ctx, { freigabe: 'daten', pfad: 'a.md', eintrag: { name: 'a.md' }, schreibbar: true });
  tippen(h, 'neu\n');
  h.element.dispatchEvent(new Event('click', { bubbles: true })); await ticks();
  assert.equal(h.element.open, true);
  assert.equal(speicherAufrufe(ctx).length, 0);
});
