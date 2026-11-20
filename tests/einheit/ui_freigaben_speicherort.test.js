// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Speicherort von Freigaben, Oberfläche (Zusatzauftrag Z1, 0.21.0): Die Karte zeigt „Speicherort: Datenplatte (Samsung
// SSD 840) · /data/shares/<name>“ (extern, Verbund, verschlüsselt entsprechend; die automatische Beschreibung externer
// Laufwerke steht nicht doppelt da), der Dialog „Neue Freigabe“ sagt vorher, wo die Freigabe entsteht. Mit den echten
// deutschen und englischen Texten, gegen die DOM-Attrappe.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const warte = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ticks = async () => { for (let i = 0; i < 8; i++) await warte(); };

let dom; let modul; let ansicht; let tDe; let tEn; let formVorher;
before(async () => {
  dom = domAttrappe();
  formVorher = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement');
  globalThis.HTMLFormElement = class {}; // dialogOeffnen fragt „instanceof HTMLFormElement“ – die Attrappe kennt die Klasse nicht
  const { erzeugeT, mischen } = await import(pathToFileURL(path.join(PUBLIC, 'sprache.js')).href);
  const texte = async (sprache) => erzeugeT(mischen([{ bereich: 'freigaben', daten: JSON.parse(await fs.readFile(path.join(PUBLIC, 'sprache', sprache, 'freigaben.json'), 'utf8')) }]).texte);
  tDe = await texte('de'); tEn = await texte('en');
  modul = await import(pathToFileURL(path.join(PUBLIC, 'ansichten', 'freigaben.js')).href);
  ansicht = modul.default;
});
after(() => {
  if (formVorher) Object.defineProperty(globalThis, 'HTMLFormElement', formVorher); else delete globalThis.HTMLFormElement;
  dom.aufraeumen();
});

const DATENPLATTE = { art: 'datenplatte', geraet: '/dev/sda4', platte: '/dev/sda', modell: 'Samsung SSD 840' };
const MEDIEN = { name: 'medien', beschreibung: 'Filme', pfad: '/data/shares/medien', lesen: ['anna'], schreiben: ['chef'], papierkorb: true, belegt: 1024, schnappschuesse: 0, extern: false, speicherort: DATENPLATTE };
const EXTERN = { name: '1500gb', beschreibung: 'Externes Laufwerk (1500GB)', pfad: '/data/shares/1500gb', lesen: [], schreiben: ['chef'], extern: true, eingehaengt: true, belegt: 10, kapazitaet: 100, speicherort: { art: 'extern', geraet: null, platte: null, modell: 'SSD 850 EVO 2TB', label: '1500GB' } };
const ALT = { name: 'alt', beschreibung: 'Externes Laufwerk (ALT)', pfad: '/data/shares/alt', lesen: [], schreiben: ['chef'], extern: true, belegt: null }; // älterer Agent ohne speicherort

// ---- reine Funktionen ------------------------------------------------------------------------------------------------

test('speicherortText: Datenplatte mit und ohne Modell, verschlüsselt wie Datenplatte (de/en); ohne Feld keine Zeile', () => {
  const f = (o, pfad = '/data/shares/medien') => ({ pfad, speicherort: o });
  assert.equal(modul.speicherortText(f(DATENPLATTE), tDe), 'Speicherort: Datenplatte (Samsung SSD 840) · /data/shares/medien');
  assert.equal(modul.speicherortText(f(DATENPLATTE), tEn), 'Location: data disk (Samsung SSD 840) · /data/shares/medien');
  assert.equal(modul.speicherortText(f({ ...DATENPLATTE, geraet: null, platte: null, modell: null }), tDe), 'Speicherort: Datenplatte · /data/shares/medien', 'kein Modell → ohne Klammer');
  assert.equal(modul.speicherortText(f({ ...DATENPLATTE, art: 'verschluesselt' }, '/data/shares/tresor'), tDe), 'Speicherort: Datenplatte (Samsung SSD 840) · /data/shares/tresor');
  assert.equal(modul.speicherortText({ pfad: '/data/shares/x' }, tDe), '', 'älterer Agent ohne Feld');
  assert.equal(modul.speicherortText(null, tDe), '');
});

test('speicherortText: externes Laufwerk wie in der Laufwerke-Ansicht (Bezeichnung + Modell, nichts doppelt), Speicherverbund mit Stufe und Platten', () => {
  const ext = (o) => ({ pfad: '/data/shares/1500gb', extern: true, speicherort: { art: 'extern', geraet: null, platte: null, ...o } });
  assert.equal(modul.speicherortText(ext({ label: '1500GB', modell: 'SSD 850 EVO 2TB' }), tDe), 'Speicherort: Externes Laufwerk „1500GB“ (SSD 850 EVO 2TB) · /data/shares/1500gb');
  assert.equal(modul.speicherortText(ext({ label: '1500GB', modell: 'SSD 850 EVO 2TB' }), tEn), 'Location: external drive “1500GB” (SSD 850 EVO 2TB) · /data/shares/1500gb');
  assert.equal(modul.speicherortText(ext({ label: null, modell: 'SSD 850 EVO 2TB' }), tDe), 'Speicherort: Externes Laufwerk (SSD 850 EVO 2TB) · /data/shares/1500gb');
  assert.equal(modul.speicherortText(ext({ label: 'Kingston DT', modell: 'Kingston DT' }), tDe), 'Speicherort: Externes Laufwerk „Kingston DT“ · /data/shares/1500gb', 'Modell gleich Bezeichnung → nur einmal');
  assert.equal(modul.speicherortText(ext({ label: null, modell: null }), tDe), 'Speicherort: Externes Laufwerk · /data/shares/1500gb');
  const vb = (o) => ({ pfad: '/data/shares/pool', verbund: true, speicherort: { art: 'verbund', geraet: '/dev/md/fahnas-pool', platte: null, modell: null, ...o } });
  assert.equal(modul.speicherortText(vb({ stufe: 'raid1', platten: [{ name: 'sdc', modell: 'WDC WD40EFRX' }, { name: 'sdd', modell: 'WDC WD40EFRX' }] }), tDe), 'Speicherort: Speicherverbund RAID1 aus 2 Platten (WDC WD40EFRX) · /data/shares/pool');
  assert.equal(modul.speicherortText(vb({ stufe: 'raid5', platten: [{ name: 'sdb', modell: 'A' }, { name: 'sdc', modell: 'B' }, { name: 'nvme0n1', modell: null }] }), tEn), 'Location: storage pool RAID5 of 3 disks (A, B) · /data/shares/pool');
  assert.equal(modul.speicherortText(vb({ geraet: null, stufe: null, platten: [] }), tDe), 'Speicherort: Speicherverbund · /data/shares/pool', 'raid.json ohne Eintrag');
});

test('beschreibungZeigen: automatische Beschreibung externer Laufwerke/Verbünde entfällt neben der Speicherort-Zeile – eigene Texte bleiben', () => {
  const ext = { art: 'extern' };
  assert.equal(modul.beschreibungZeigen({ extern: true, beschreibung: 'Externes Laufwerk (1500GB)', speicherort: ext }), false);
  assert.equal(modul.beschreibungZeigen({ extern: true, beschreibung: 'Externes Laufwerk', speicherort: ext }), false);
  assert.equal(modul.beschreibungZeigen({ verbund: true, beschreibung: 'Speicherverbund RAID10', speicherort: { art: 'verbund' } }), false);
  assert.equal(modul.beschreibungZeigen({ extern: true, beschreibung: 'Fotos von Oma', speicherort: ext }), true, 'eigene Beschreibung bleibt');
  assert.equal(modul.beschreibungZeigen({ beschreibung: 'Externes Laufwerk (x)', speicherort: { art: 'datenplatte' } }), true, 'nur bei externen Laufwerken und Verbünden');
  assert.equal(modul.beschreibungZeigen({ extern: true, beschreibung: 'Externes Laufwerk (1500GB)' }), true, 'ohne Speicherort-Zeile (älterer Agent) bleibt sie der einzige Hinweis');
  assert.equal(modul.beschreibungZeigen({ beschreibung: '' }), false);
  assert.equal(modul.beschreibungZeigen({}), false);
});

test('neuOrtText: Satz im Dialog „Neue Freigabe“ – Datenplatte, Modell, Pfad mit dem getippten Namen (de/en)', () => {
  const o = { ...DATENPLATTE, pfad: '/data/shares' };
  assert.equal(modul.neuOrtText(o, '', tDe), 'Wird auf der Datenplatte (Samsung SSD 840) unter /data/shares/<Name> angelegt.');
  assert.equal(modul.neuOrtText(o, 'medien', tDe), 'Wird auf der Datenplatte (Samsung SSD 840) unter /data/shares/medien angelegt.');
  assert.equal(modul.neuOrtText(o, '', tEn), 'Will be created on the data disk (Samsung SSD 840) at /data/shares/<name>.');
  assert.equal(modul.neuOrtText({ ...o, modell: null, pfad: '/data/shares/' }, 'medien', tDe), 'Wird auf der Datenplatte unter /data/shares/medien angelegt.');
  assert.equal(modul.neuOrtText(null, 'medien', tDe), '');
  assert.equal(modul.neuOrtText({ modell: 'X' }, 'medien', tDe), '', 'ohne Pfad kein Satz');
});

// ---- Ansicht mit DOM-Attrappe ----------------------------------------------------------------------------------------

function ctxBauen(antworten, rolle = 'admin') {
  const aufrufe = [];
  return {
    aufrufe, rolle, nutzer: { name: rolle === 'admin' ? 'chef' : 'anna', rolle }, route: { id: 'freigaben', teile: [] }, t: tDe,
    melden() {}, hashFuer: (...teile) => `#/${teile.join('/')}`,
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      const a = antworten[aktion];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(params) : a;
    },
  };
}

let wurzel = null;
afterEach(() => {
  try { ansicht.verlassen(); } catch { /* egal */ }
  for (const d of document.body.querySelectorAll('dialog')) d.remove();
  if (wurzel) wurzel.remove();
  wurzel = null;
});

async function einbinden(ctx) {
  wurzel = document.createElement('section');
  document.body.appendChild(wurzel);
  await ansicht.einbinden(wurzel, ctx);
  await ticks();
  return wurzel;
}
const karte = (w, name) => w.querySelectorAll('.fg-karte').find((k) => k.dataset.suchziel === name);
const knopfMit = (wurzelEl, text) => wurzelEl.querySelectorAll('button').find((b) => b.textContent === text);
const letzterDialog = () => [...document.body.querySelectorAll('dialog')].pop();

test('Karte: Speicherort-Zeile zwischen Belegung und Rechten; extern ohne doppelte Beschreibung; älterer Agent ohne Zeile', async () => {
  const ctx = ctxBauen({ 'freigaben.liste': [MEDIEN, EXTERN, ALT] });
  const w = await einbinden(ctx);
  const m = karte(w, 'medien');
  const ort = m.querySelector('.fg-ort');
  assert.ok(ort, 'Speicherort-Zeile vorhanden');
  assert.equal(ort.textContent, 'Speicherort: Datenplatte (Samsung SSD 840) · /data/shares/medien');
  assert.equal(ort.getAttribute('title'), 'Gerät /dev/sda4', 'Gerät als Tooltip');
  assert.equal(m.querySelector('.fg-beschreibung').textContent, 'Filme');
  const klassen = m.children.map((k) => k.className);
  const iBelegung = klassen.findIndex((k) => k.includes('vw-belegung')); const iOrt = klassen.findIndex((k) => k.includes('fg-ort')); const iRechte = klassen.findIndex((k) => k.includes('fg-rechte'));
  assert.ok(iBelegung >= 0 && iBelegung < iOrt && iOrt < iRechte, klassen.join(' | '));

  const e = karte(w, '1500gb');
  assert.equal(e.querySelector('.fg-ort').textContent, 'Speicherort: Externes Laufwerk „1500GB“ (SSD 850 EVO 2TB) · /data/shares/1500gb');
  assert.equal(e.querySelector('.fg-ort').getAttribute('title'), null, 'ohne bekanntes Gerät kein Tooltip');
  assert.equal(e.querySelector('.fg-beschreibung'), null, '„Externes Laufwerk (1500GB)“ stünde sonst doppelt da');

  const a = karte(w, 'alt');
  assert.equal(a.querySelector('.fg-ort'), null, 'ohne Feld keine Zeile – und kein Fehler');
  assert.equal(a.querySelector('.fg-beschreibung').textContent, 'Externes Laufwerk (ALT)');
  assert.ok(!/undefined|null|freigaben\./.test(w.textContent), 'keine Platzhalter oder Schlüssel im Text');
});

test('Karte: auch Nutzer sehen, wo ihre Freigabe liegt', async () => {
  const ctx = ctxBauen({ 'freigaben.liste': [MEDIEN] }, 'nutzer');
  const w = await einbinden(ctx);
  assert.equal(karte(w, 'medien').querySelector('.fg-ort').textContent, 'Speicherort: Datenplatte (Samsung SSD 840) · /data/shares/medien');
});

test('Dialog „Neue Freigabe“: sagt vorher, wo die Freigabe entsteht, und folgt dem getippten Namen', async () => {
  const ctx = ctxBauen({ 'freigaben.liste': [MEDIEN], 'nutzer.liste': [], 'nutzer.gruppen': [], 'freigaben.speicherort': { ...DATENPLATTE, pfad: '/data/shares' } });
  const w = await einbinden(ctx);
  knopfMit(w.querySelector('.vw-kopf'), 'Neue Freigabe').click(); await ticks();
  const dlg = letzterDialog();
  assert.ok(dlg, 'Dialog offen');
  const ort = dlg.querySelector('.fg-ort-neu');
  assert.ok(ort, 'Hinweis vorhanden');
  assert.equal(ort.textContent, 'Wird auf der Datenplatte (Samsung SSD 840) unter /data/shares/<Name> angelegt.');
  assert.ok(!ort.classList.contains('vw-versteckt'), 'sichtbar');
  const name = dlg.querySelector('input');
  assert.ok(ort.previousSibling && ort.previousSibling.contains(name), 'direkt unter dem Namensfeld');
  name.value = 'fotos'; name.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(ort.textContent, 'Wird auf der Datenplatte (Samsung SSD 840) unter /data/shares/fotos angelegt.');
  name.value = '  '; name.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(ort.textContent, 'Wird auf der Datenplatte (Samsung SSD 840) unter /data/shares/<Name> angelegt.');
  assert.deepEqual(ctx.aufrufe.filter(([a]) => a === 'freigaben.speicherort'), [['freigaben.speicherort', {}]]);
});

test('Dialog „Neue Freigabe“: Speicherort nicht abrufbar → kein Hinweis, keine Fehlermeldung, Dialog bleibt bedienbar', async () => {
  const fehler = Object.assign(new Error('Der Steuerdienst antwortet nicht'), { code: 'E_AGENT' });
  const ctx = ctxBauen({ 'freigaben.liste': [], 'nutzer.liste': [], 'nutzer.gruppen': [], 'freigaben.speicherort': fehler });
  const w = await einbinden(ctx);
  knopfMit(w.querySelector('.vw-kopf'), 'Neue Freigabe').click(); await ticks();
  const dlg = letzterDialog();
  assert.ok(dlg, 'Dialog offen');
  assert.ok(ctx.aufrufe.some(([a]) => a === 'freigaben.speicherort'), 'Speicherort wurde abgefragt');
  const ort = dlg.querySelector('.fg-ort-neu');
  assert.ok(!ort || ort.classList.contains('vw-versteckt'), 'kein (leerer) Hinweis');
  assert.equal(dlg.querySelector('.vw-formfehler').hidden, true, 'keine Fehlermeldung im Dialog');
  const name = dlg.querySelector('input');
  name.value = 'fotos'; name.dispatchEvent(new Event('input', { bubbles: true }));
  assert.ok(!ort || ort.classList.contains('vw-versteckt'));
});

test('Dialog „Bearbeiten“: kein Neu-Hinweis und keine Abfrage – der Ort steht schon auf der Karte', async () => {
  const ctx = ctxBauen({ 'freigaben.liste': [MEDIEN], 'nutzer.liste': [], 'nutzer.gruppen': [], 'freigaben.speicherort': { ...DATENPLATTE, pfad: '/data/shares' } });
  const w = await einbinden(ctx);
  knopfMit(karte(w, 'medien'), 'Bearbeiten').click(); await ticks();
  const dlg = letzterDialog();
  assert.ok(dlg, 'Dialog offen');
  assert.equal(dlg.querySelector('.fg-ort-neu'), null);
  assert.ok(!ctx.aufrufe.some(([a]) => a === 'freigaben.speicherort'));
});
