// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Board-Editor (Plan 04 Aufgabe 14): Etikett-Farben mit genug Kontrast, sichtbare Karten (verwaist, Archiv, Filter),
// Board-Mitglieder, Zielberechnung und Ziehen (Maus/Stift ab 5 px, Touch nach 300 ms Halten, Esc), Kartendialog
// (Felder nach 500 ms Ruhe, Kommentare, Checkliste, Anhänge), Spalten und Karten anlegen, Leser ohne Bearbeiten.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HIER, '..', '..', 'public');
const OFFICE_CSS = path.join(PUBLIC, 'ansichten', 'office.css');
const ID = 'oAAAAAAAAAAAAAAAA';
let dom; let app; let board; let ETIKETT_FARBEN; let ansicht; let ziehen; let dialogMod; let editorMod;
const ticks = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const dialogJetzt = () => document.body.querySelectorAll('dialog').at(-1) || null;

before(async () => {
  dom = domAttrappe();
  app = await import(pathToFileURL(path.join(PUBLIC, 'app.js')).href);
  app._test.setzeT((k, w) => (w ? `${k}:${Object.values(w).join(',')}` : k));
  ({ board, ETIKETT_FARBEN } = await import(pathToFileURL(path.join(PUBLIC, 'gemeinsam', 'sync', 'typen', 'board.js')).href));
  ansicht = await import(pathToFileURL(path.join(PUBLIC, 'office', 'board', 'ansicht.js')).href);
  ziehen = await import(pathToFileURL(path.join(PUBLIC, 'office', 'board', 'ziehen.js')).href);
  dialogMod = await import(pathToFileURL(path.join(PUBLIC, 'office', 'board', 'karte-dialog.js')).href);
  editorMod = await import(pathToFileURL(path.join(PUBLIC, 'office', 'board', 'editor.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { for (const d of document.body.querySelectorAll('dialog')) d.remove(); document.body.textContent = ''; });

const karte = (k) => ({ beschreibung: '', zustaendig: [], faellig: null, etiketten: [], checkliste: [], kommentare: [], anhaenge: [], archiviert: false, erstellt: '2026-10-01T08:00:00.000Z', ersteller: 'anna', titel: '', ...k });
const DATEN = () => ({
  spalten: [{ id: 'todo00', titel: 'Zu erledigen', pos: 'i' }, { id: 'doing0', titel: 'In Arbeit', pos: 'r' }],
  karten: {
    k1aaaa: karte({ id: 'k1aaaa', spalte: 'todo00', pos: 'i', titel: 'Eins', zustaendig: ['anna'], faellig: '2026-10-18', etiketten: ['e1aaaa'] }),
    k2aaaa: karte({ id: 'k2aaaa', spalte: 'todo00', pos: 'r', titel: 'Zwei', faellig: '2026-10-10' }),
    k3aaaa: karte({ id: 'k3aaaa', spalte: 'doing0', pos: 'i', titel: 'Drei', faellig: '2026-10-22', zustaendig: ['ben'] }),
  },
  etiketten: { e1aaaa: { name: 'Wichtig', farbe: 'rot' } },
});
const DATEN_MIT_VERWAIST = {
  spalten: [{ id: 'fertig', titel: 'Erledigt', pos: 'v' }, { id: 'doing0', titel: 'In Arbeit', pos: 'r' }],
  karten: {
    k2aaaa: karte({ id: 'k2aaaa', spalte: 'doing0', pos: 'i' }),
    k9aaaa: karte({ id: 'k9aaaa', spalte: 'todo00', pos: 'r' }),
    k5aaaa: karte({ id: 'k5aaaa', spalte: 'doing0', pos: 'a', archiviert: true }),
  },
  etiketten: {},
};

function ctxBauen(antworten = {}) {
  const aufrufe = []; const meldungen = []; const fehler = [];
  return {
    aufrufe, meldungen, fehler,
    nutzer: { name: 'anna', anzeigename: 'Anna A.', rolle: 'nutzer' }, rolle: 'nutzer', t: app.t,
    dialog: app.dialog, eingabe: app.eingabe, bestaetigen: app.bestaetigen, fehlerText: (e) => (e && e.message) || String(e),
    melden: (text, art) => { meldungen.push([text, art]); }, zeigeFehler: (e) => { fehler.push(e); }, navigiere: () => {},
    api: async (aktion, params) => {
      aufrufe.push([aktion, params]);
      if (aktion in antworten) { const a = antworten[aktion]; return typeof a === 'function' ? a(params) : structuredClone(a); }
      if (aktion === 'office.freigaben') return { besitzer: 'anna', freigaben: { ben: 'bearbeiten' }, geteilt_mit: [{ name: 'ben', anzeigename: 'Ben B.', recht: 'bearbeiten', ueber: 'office' }], privat: false };
      throw new Error(`unerwartet: ${aktion}`);
    },
  };
}

/** Schein-Sitzung: lokal prüft und wendet wie der echte Klient an und meldet 'aenderung'. */
function scheinSitzung(daten, recht = 'bearbeiten') {
  const hoerer = new Map();
  const s = {
    dok: { id: ID, art: 'board', name: 'Sprint', besitzer: 'anna', recht }, recht, kid: 'k1', anwesend: [], daten, ops: [], auswahlen: [],
    lokal(op) { board.pruefen(op); s.daten = board.anwenden(s.daten, op); s.ops.push(op); s.emit('aenderung', { op, lokal: true }); },
    fremd(op) { s.daten = board.anwenden(s.daten, op); s.emit('aenderung', { op, lokal: false }); },
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => { hoerer.get(art)?.delete(fn); }; },
    emit(art, x) { for (const fn of [...(hoerer.get(art) || [])]) fn(x); },
    hoererZahl() { let n = 0; for (const x of hoerer.values()) n += x.size; return n; },
    auswahlSenden(a) { s.auswahlen.push(a); },
    dateiUrl: (d) => `/api/office/datei?id=${ID}&datei=${encodeURIComponent(d)}`,
    dateiHochladen: async (f) => ({ datei: `abcdefghijkl-${f.name}`, name: f.name }),
    dateiAusNas: async () => ({ datei: 'abcdefghijkl-plan.pdf', name: 'plan.pdf', groesse: 10, mime: 'application/pdf' }),
  };
  return s;
}

/** Hex-Farbe → relative Leuchtdichte (WCAG 2.x). */
function leuchtdichte(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function kontrast(a, b) {
  assert.match(String(a), /^#[0-9a-f]{6}$/i); assert.match(String(b), /^#[0-9a-f]{6}$/i);
  const [x, y] = [leuchtdichte(a), leuchtdichte(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function cssBloecke(css) {
  const block = (re, name) => {
    const m = css.match(re);
    assert.ok(m, `Block ${name} fehlt`);
    const werte = {};
    for (const [, k, v] of m[1].matchAll(/(--ob-[a-z]+-(?:grund|text))\s*:\s*(#[0-9a-fA-F]{6})/g)) werte[k] = v.toLowerCase();
    return { name, werte, ...werte };
  };
  return [
    block(/(?:^|\n):root\s*\{([^}]*)\}/, 'hell'),
    block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-design="hell"\]\)\s*\{([^}]*)\}/, 'dunkel-automatisch'),
    block(/:root\[data-design="dunkel"\]\s*\{([^}]*)\}/, 'dunkel'),
  ];
}

/** Zeigerereignis mit Koordinaten. */
const zeiger = (typ, x, y, mehr = {}) => Object.assign(new Event(typ, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, ...mehr });

/** Geometrie in der Attrappe: Spalten nebeneinander (270 px), Karten untereinander (50 px hoch, 10 px Abstand). */
function geometrieSetzen(wurzel) {
  const spalten = wurzel.querySelectorAll('.ob-spalte');
  spalten.forEach((s, i) => {
    s.getBoundingClientRect = () => ({ left: i * 280, right: i * 280 + 270, top: 0, bottom: 600, width: 270, height: 600 });
    s.querySelectorAll('.ob-karte').forEach((k, j) => {
      k.getBoundingClientRect = () => ({ left: i * 280, right: i * 280 + 270, top: j * 60, bottom: j * 60 + 50, width: 270, height: 50 });
    });
  });
}
const karteEl = (wurzel, id) => wurzel.querySelector(`.ob-karte[data-id="${id}"]`);

async function editorBauen(daten = DATEN(), recht = 'bearbeiten', antworten = {}) {
  const s = scheinSitzung(daten, recht);
  const ctx = ctxBauen(antworten);
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const ed = await editorMod.editorEinbinden(behaelter, { ctx, sitzung: s, recht });
  await ticks();
  return { s, ctx, behaelter, ed };
}

test('Etikett-Farben: Text ≥ 4,5:1 hell und dunkel, beide Dunkel-Blöcke gleich', async () => {
  const css = await fs.readFile(OFFICE_CSS, 'utf8');
  const bloecke = cssBloecke(css);
  assert.equal(ETIKETT_FARBEN.length, 8);
  for (const farbe of ETIKETT_FARBEN) {
    for (const b of bloecke) assert.ok(kontrast(b[`--ob-${farbe}-text`], b[`--ob-${farbe}-grund`]) >= 4.5, `${farbe} in ${b.name}`);
    assert.match(css, new RegExp(`\\.ob-etikett-${farbe}\\s*\\{[^}]*var\\(--ob-${farbe}-grund\\)[^}]*var\\(--ob-${farbe}-text\\)`), `Chip-Klasse ${farbe}`);
  }
  assert.deepEqual(bloecke[1].werte, bloecke[2].werte);
  assert.equal(bloecke[0]['--ob-rot-grund'], '#fbd5d5'); assert.equal(bloecke[2]['--ob-rot-grund'], '#7a2424');
});

test('verwaiste Karten in der ersten Spalte, Reihenfolge nach pos/id, Archiv getrennt', () => {
  const s = ansicht.sichtbareKarten(DATEN_MIT_VERWAIST, { nutzer: 'anna', heute: '2026-10-18' });
  assert.deepEqual(s.map((x) => [x.spalte.id, x.karten.map((k) => k.id)]), [['doing0', ['k2aaaa', 'k9aaaa']], ['fertig', []]]);
  assert.deepEqual(ansicht.sichtbareKarten(DATEN_MIT_VERWAIST, { nutzer: 'anna', heute: '2026-10-18', archiv: true })[0].karten.map((k) => k.id), ['k5aaaa']);
  assert.deepEqual(ansicht.sichtbareKarten({ spalten: [], karten: {}, etiketten: {} }, { nutzer: 'anna', heute: '2026-10-18' }), []);
});

test('Filter meine/etikett/faellig und Board-Mitglieder', () => {
  const ids = (filter) => ansicht.sichtbareKarten(DATEN(), { filter, nutzer: 'anna', heute: '2026-10-18' }).map((x) => [x.spalte.id, x.karten.map((k) => k.id)]);
  assert.deepEqual(ids({}), [['todo00', ['k1aaaa', 'k2aaaa']], ['doing0', ['k3aaaa']]]);
  assert.deepEqual(ids({ meine: true }), [['todo00', ['k1aaaa']], ['doing0', []]]);
  assert.deepEqual(ids({ etikett: 'e1aaaa' }), [['todo00', ['k1aaaa']], ['doing0', []]]);
  assert.deepEqual(ids({ faellig: 'heute' }), [['todo00', ['k1aaaa']], ['doing0', []]]);
  assert.deepEqual(ids({ faellig: 'ueberfaellig' }), [['todo00', ['k2aaaa']], ['doing0', []]]);
  assert.deepEqual(ids({ faellig: 'woche' }), [['todo00', ['k1aaaa']], ['doing0', ['k3aaaa']]]);
  assert.deepEqual(ids({ meine: true, faellig: 'woche' }), [['todo00', ['k1aaaa']], ['doing0', []]]);
  assert.deepEqual(ansicht.mitglieder({ geteilt_mit: [{ name: 'cara', recht: 'lesen' }, { name: 'ben', recht: 'bearbeiten' }, { name: 'anna', recht: 'bearbeiten' }] }, 'anna'), ['anna', 'ben']);
  assert.deepEqual(ansicht.mitglieder(null, 'anna'), ['anna']);
});

test('zielBerechnen: zwischen zwei Karten, leere Spalte, außerhalb → null, über sich selbst → gleiche Nachbarn', () => {
  const spalten = [
    { id: 's1', links: 0, rechts: 270, karten: [{ id: 'a', oben: 0, unten: 50 }, { id: 'b', oben: 60, unten: 110 }, { id: 'c', oben: 120, unten: 170 }] },
    { id: 's2', links: 280, rechts: 550, karten: [] },
  ];
  assert.deepEqual(ziehen.zielBerechnen(spalten, 100, 80, 'x'), { spalte: 's1', vor: 'a', nach: 'b' });
  assert.deepEqual(ziehen.zielBerechnen(spalten, 100, 5, 'x'), { spalte: 's1', vor: null, nach: 'a' });
  assert.deepEqual(ziehen.zielBerechnen(spalten, 100, 500, 'x'), { spalte: 's1', vor: 'c', nach: null });
  assert.deepEqual(ziehen.zielBerechnen(spalten, 300, 40, 'x'), { spalte: 's2', vor: null, nach: null });
  assert.equal(ziehen.zielBerechnen(spalten, 275, 40, 'x'), null);
  assert.equal(ziehen.zielBerechnen(spalten, 900, 40, 'x'), null);
  assert.deepEqual(ziehen.zielBerechnen(spalten, 100, 85, 'b'), { spalte: 's1', vor: 'a', nach: 'c' });
});

test('Ziehen erzeugt karte_verschieben mit pos aus zwischen; > 64 Zeichen → ans Ende; Esc bricht ab', async () => {
  const { s, behaelter } = await editorBauen();
  geometrieSetzen(behaelter);
  const k3 = karteEl(behaelter, 'k3aaaa');
  k3.dispatchEvent(zeiger('pointerdown', 300, 25));
  k3.dispatchEvent(zeiger('pointermove', 303, 26));
  assert.equal(k3.classList.contains('ob-zieht'), false, 'unter 5 px noch kein Ziehen');
  k3.dispatchEvent(zeiger('pointermove', 320, 40));
  assert.equal(k3.classList.contains('ob-zieht'), true);
  k3.dispatchEvent(zeiger('pointermove', 100, 55));
  k3.dispatchEvent(zeiger('pointerup', 100, 55));
  k3.dispatchEvent(zeiger('click', 100, 55));
  await ticks();
  assert.deepEqual(s.ops, [{ typ: 'karte_verschieben', id: 'k3aaaa', spalte: 'todo00', pos: 'm' }]);
  assert.equal(dialogJetzt(), null, 'der Klick nach dem Ziehen öffnet nichts');

  // zu lange Position → ans Ende der Zielspalte
  const lang = DATEN();
  lang.karten.k1aaaa.pos = `i${'0'.repeat(62)}`; lang.karten.k2aaaa.pos = `i${'0'.repeat(62)}1`;
  const b = await editorBauen(lang);
  geometrieSetzen(b.behaelter);
  const k = karteEl(b.behaelter, 'k3aaaa');
  k.dispatchEvent(zeiger('pointerdown', 300, 25)); k.dispatchEvent(zeiger('pointermove', 320, 40)); k.dispatchEvent(zeiger('pointermove', 100, 55)); k.dispatchEvent(zeiger('pointerup', 100, 55));
  await ticks();
  assert.deepEqual(b.s.ops, [{ typ: 'karte_verschieben', id: 'k3aaaa', spalte: 'todo00', pos: 'r' }]);

  // Esc bricht ab; an derselben Stelle loslassen ändert nichts
  const c = await editorBauen();
  geometrieSetzen(c.behaelter);
  const k1 = karteEl(c.behaelter, 'k1aaaa');
  k1.dispatchEvent(zeiger('pointerdown', 20, 25)); k1.dispatchEvent(zeiger('pointermove', 40, 40)); k1.dispatchEvent(zeiger('pointermove', 300, 30));
  document.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
  k1.dispatchEvent(zeiger('pointerup', 300, 30));
  k1.dispatchEvent(zeiger('pointerdown', 20, 25)); k1.dispatchEvent(zeiger('pointermove', 40, 30)); k1.dispatchEvent(zeiger('pointerup', 40, 30));
  await ticks();
  assert.deepEqual(c.s.ops, []);
});

test('Touch: Ziehen erst nach 300 ms Halten; Bewegung > 8 px vorher ist Blättern', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, behaelter } = await editorBauen();
  geometrieSetzen(behaelter);
  const k3 = karteEl(behaelter, 'k3aaaa');
  const touch = { pointerType: 'touch' };
  k3.dispatchEvent(zeiger('pointerdown', 300, 25, touch));
  t.mock.timers.tick(299);
  k3.dispatchEvent(zeiger('pointermove', 303, 27, touch));
  assert.equal(k3.classList.contains('ob-zieht'), false);
  t.mock.timers.tick(1);
  assert.equal(k3.classList.contains('ob-zieht'), true, 'nach 300 ms Halten');
  k3.dispatchEvent(zeiger('pointermove', 100, 55, touch)); k3.dispatchEvent(zeiger('pointerup', 100, 55, touch));
  await ticks();
  assert.deepEqual(s.ops, [{ typ: 'karte_verschieben', id: 'k3aaaa', spalte: 'todo00', pos: 'm' }]);
  geometrieSetzen(behaelter);
  const k1 = karteEl(behaelter, 'k1aaaa');
  k1.dispatchEvent(zeiger('pointerdown', 20, 25, touch));
  k1.dispatchEvent(zeiger('pointermove', 20, 40, touch));
  t.mock.timers.tick(300);
  assert.equal(k1.classList.contains('ob-zieht'), false, 'geblättert, nicht gezogen');
  k1.dispatchEvent(zeiger('pointermove', 300, 40, touch)); k1.dispatchEvent(zeiger('pointerup', 300, 40, touch));
  await ticks();
  assert.equal(s.ops.length, 1);
});

test('Kartendialog: Titel nach 500 ms Ruhe als karte_setzen, Kommentar mit wer/name/zeit, Anhang über dateiHochladen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = scheinSitzung(DATEN());
  const ctx = ctxBauen();
  const griff = dialogMod.karteDialog(ctx, s, 'k1aaaa', { mitglieder: ['anna', 'ben'], recht: 'bearbeiten' });
  const d = dialogJetzt();
  assert.deepEqual(s.auswahlen, [{ karte: 'k1aaaa' }], 'Auswahl für die anderen');
  const titel = d.querySelector('.ob-titel-feld');
  assert.equal(titel.value, 'Eins');
  titel.value = 'Neu'; titel.dispatchEvent(new Event('input', { bubbles: true }));
  t.mock.timers.tick(499);
  assert.equal(s.ops.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(s.ops[0], { typ: 'karte_setzen', id: 'k1aaaa', felder: { titel: 'Neu' } });

  d.querySelector('.ob-kommentar-neu').value = 'hallo';
  d.querySelector('.ob-kommentar-senden').click();
  const k = s.ops.at(-1);
  assert.equal(k.typ, 'kommentar'); assert.equal(k.karte, 'k1aaaa');
  assert.match(k.kommentar.id, /^[A-Za-z0-9_-]{6,24}$/);
  assert.equal(k.kommentar.wer, 'anna'); assert.equal(k.kommentar.name, 'Anna A.'); assert.equal(k.kommentar.text, 'hallo');
  assert.match(k.kommentar.zeit, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(d.querySelectorAll('.ob-kommentar').length, 1, 'neu gezeichnet');
  d.querySelector('.ob-kommentar .ob-kommentar-loeschen').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'kommentar', karte: 'k1aaaa', kommentar: { id: k.kommentar.id, wer: 'anna', weg: true } });

  const datei = { name: 'foto.png', size: 1234, type: 'image/png' };
  const feld = d.querySelector('.ob-anhang-datei');
  feld.files = [datei]; feld.dispatchEvent(new Event('change', { bubbles: true }));
  await ticks();
  assert.deepEqual(s.ops.at(-1), { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'abcdefghijkl-foto.png', name: 'foto.png', groesse: 1234, mime: 'image/png' } });
  d.querySelector('.ob-anhang-nas').click();
  await ticks();
  assert.deepEqual(s.ops.at(-1), { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'abcdefghijkl-plan.pdf', name: 'plan.pdf', groesse: 10, mime: 'application/pdf' } });
  const link = d.querySelector('.ob-anhang a');
  assert.equal(link.getAttribute('href'), `/api/office/datei?id=${ID}&datei=abcdefghijkl-foto.png`);
  d.querySelector('.ob-anhang[data-datei="abcdefghijkl-foto.png"] .ob-anhang-weg').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'anhang', karte: 'k1aaaa', anhang: { datei: 'abcdefghijkl-foto.png', weg: true } });

  // Checkliste, Zuständige, Fälligkeit, Etikett, Spalte
  d.querySelector('.ob-punkt-neu').value = 'Punkt A';
  d.querySelector('.ob-punkt-hinzu').click();
  const p = s.ops.at(-1);
  assert.equal(p.typ, 'checkliste'); assert.equal(p.eintrag.text, 'Punkt A'); assert.equal(p.eintrag.pos, 'i'); assert.equal(p.eintrag.neu, true);
  const haken = d.querySelector(`.ob-punkt[data-id="${p.eintrag.id}"] input[type="checkbox"]`);
  haken.checked = true; haken.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { typ: 'checkliste', karte: 'k1aaaa', eintrag: { id: p.eintrag.id, erledigt: true } });
  const ben = d.querySelector('.ob-zustaendig input[data-nutzer="ben"]');
  ben.checked = true; ben.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k1aaaa', felder: { zustaendig: ['anna', 'ben'] } });
  const faellig = d.querySelector('.ob-faellig-feld');
  faellig.value = '2026-11-01'; faellig.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k1aaaa', felder: { faellig: '2026-11-01' } });
  d.querySelector('.ob-faellig-leeren').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k1aaaa', felder: { faellig: null } });
  d.querySelector('.ob-etikett-wahl[data-id="e1aaaa"]').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k1aaaa', felder: { etiketten: [] } });
  const spalte = d.querySelector('.ob-spalte-wahl');
  spalte.value = 'doing0'; spalte.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_verschieben', id: 'k1aaaa', spalte: 'doing0', pos: 'r' });

  // ungesendeter Text geht beim Schließen raus; Auswahl wird aufgehoben
  const beschreibung = d.querySelector('.ob-beschreibung-feld');
  beschreibung.value = '**fett**'; beschreibung.dispatchEvent(new Event('input', { bubbles: true }));
  griff.schliessen();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k1aaaa', felder: { beschreibung: '**fett**' } });
  assert.equal(s.auswahlen.at(-1), null);
  assert.equal(s.hoererZahl(), 0, 'Dialog meldet sich ab');
});

test('Kartendialog: Archivieren, Löschen mit Rückfrage, Nach oben/unten, Karte fremd gelöscht → zu', async () => {
  const s = scheinSitzung(DATEN());
  const ctx = ctxBauen();
  dialogMod.karteDialog(ctx, s, 'k2aaaa', { mitglieder: ['anna'], recht: 'bearbeiten' });
  let d = dialogJetzt();
  d.querySelector('.ob-nach-oben').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_verschieben', id: 'k2aaaa', spalte: 'todo00', pos: '9' }, 'vor k1aaaa (i)');
  d.querySelector('.ob-archivieren').click();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_setzen', id: 'k2aaaa', felder: { archiviert: true } });
  assert.equal(d.querySelector('.ob-archivieren').textContent, 'office.board_wiederherstellen');
  d.querySelector('.ob-karte-loeschen').click();
  await ticks();
  const frage = dialogJetzt();
  assert.notEqual(frage, d);
  frage.querySelector('.knopf-gefahr').click();
  await ticks();
  assert.deepEqual(s.ops.at(-1), { typ: 'karte_loeschen', id: 'k2aaaa' });
  assert.equal(document.body.querySelectorAll('dialog').length, 0);

  dialogMod.karteDialog(ctx, s, 'k1aaaa', { mitglieder: ['anna'], recht: 'bearbeiten' });
  d = dialogJetzt();
  s.fremd({ typ: 'karte_loeschen', id: 'k1aaaa' });
  assert.equal(dialogJetzt(), null);
  assert.deepEqual(ctx.meldungen.at(-1), ['office.board_karte_weg', 'info']);
});

test('Editor: Spalten und Karten, „+ Karte“, Spalte hinzufügen/löschen, fremde Auswahl, kein Export', async () => {
  const { s, ctx, behaelter, ed } = await editorBauen();
  assert.deepEqual(behaelter.querySelectorAll('.ob-spalte').map((x) => x.dataset.id), ['todo00', 'doing0']);
  assert.deepEqual(behaelter.querySelectorAll('.ob-spalte[data-id="todo00"] .ob-karte').map((x) => x.dataset.id), ['k1aaaa', 'k2aaaa']);
  const k1 = karteEl(behaelter, 'k1aaaa');
  assert.equal(k1.querySelector('.ob-karte-titel').textContent, 'Eins');
  assert.equal(k1.querySelector('.ob-etikett').textContent, 'Wichtig'); assert.ok(k1.querySelector('.ob-etikett').classList.contains('ob-etikett-rot'));
  assert.ok(karteEl(behaelter, 'k2aaaa').querySelector('.ob-faellig').classList.contains('warnung'), 'überfällig markiert');
  assert.deepEqual(ed.exportformate, []);
  await assert.rejects(ed.exportieren('x'), /kein_export/);

  // + Karte
  behaelter.querySelector('.ob-spalte[data-id="doing0"] .ob-karte-plus').click();
  const eingabe = behaelter.querySelector('.ob-spalte[data-id="doing0"] .ob-neue-karte');
  eingabe.value = 'Vier';
  eingabe.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Enter' }));
  const neu = s.ops.at(-1);
  assert.equal(neu.typ, 'karte_neu'); assert.equal(neu.karte.spalte, 'doing0'); assert.equal(neu.karte.titel, 'Vier');
  assert.equal(neu.karte.pos, 'r', 'hinter der letzten Karte (i)'); assert.equal(neu.karte.ersteller, 'anna');
  assert.match(neu.karte.erstellt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.match(neu.karte.id, /^[A-Za-z0-9_-]{6,24}$/);
  await ticks();
  assert.ok(karteEl(behaelter, neu.karte.id));
  assert.ok(behaelter.querySelector('.ob-spalte[data-id="doing0"] .ob-neue-karte'), 'Eingabezeile bleibt für die nächste Karte');

  // Spalte hinzufügen (Eingabedialog)
  behaelter.querySelector('.ob-spalte-plus').click();
  await ticks();
  const feld = dialogJetzt().querySelector('input');
  feld.value = 'Test';
  dialogJetzt().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await ticks();
  const sp = s.ops.at(-1);
  assert.equal(sp.typ, 'spalte_neu'); assert.equal(sp.spalte.titel, 'Test'); assert.equal(sp.spalte.pos, 'v');
  assert.equal(behaelter.querySelectorAll('.ob-spalte').length, 3);

  // Spalte löschen mit Rückfrage (nennt die Kartenzahl) → spalte_loeschen mit allen Karten der Spalte
  behaelter.querySelector('.ob-spalte[data-id="todo00"] .ob-spalte-menue').click();
  await ticks();
  dialogJetzt().querySelector('.ob-spalte-loeschen').click();
  await ticks();
  assert.match(dialogJetzt().querySelector('.dialog-text').textContent, /office\.board_spalte_loeschen_frage:Zu erledigen,2/);
  dialogJetzt().querySelector('.knopf-gefahr').click();
  await ticks();
  assert.deepEqual(s.ops.at(-1), { typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa', 'k2aaaa'] });

  // fremde Auswahl: farbiger Rand mit Namen
  s.emit('auswahl', { von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2563eb', auswahl: { karte: 'k3aaaa' } });
  await ticks();
  const k3 = karteEl(behaelter, 'k3aaaa');
  assert.ok(k3.classList.contains('ob-fremd')); assert.equal(k3.querySelector('.ob-fremd-name').textContent, 'Ben');
  assert.equal(k3.style.getPropertyValue('--farbe'), '#2563eb');
  s.emit('auswahl', { von: 'k2', nutzer: 'ben', name: 'Ben', farbe: '#2563eb', auswahl: null });
  await ticks();
  assert.equal(karteEl(behaelter, 'k3aaaa').classList.contains('ob-fremd'), false);

  // Klick öffnet den Kartendialog; Filter „Meine Karten“
  karteEl(behaelter, 'k3aaaa').click();
  assert.ok(dialogJetzt().querySelector('.ob-titel-feld'));
  dialogJetzt().querySelector('.dialog-schliessen').click();
  behaelter.querySelector('.ob-filter-meine').click();
  await ticks();
  assert.equal(karteEl(behaelter, 'k3aaaa'), null);
  assert.equal(ctx.aufrufe.filter(([a]) => a === 'office.freigaben').length, 1, 'Mitglieder einmal geladen');
  ed.verlassen();
  assert.equal(s.hoererZahl(), 0);
  assert.equal(behaelter.querySelector('.ob'), null);
});

test('Zuständige auf der Karte und im Kartendialog mit Avatar (0.22.0)', async () => {
  const av = await import(pathToFileURL(path.join(PUBLIC, 'avatar.js')).href);
  av.avatareSetzen({ anna: 'abcdef012345' });
  try {
    const { behaelter } = await editorBauen();
    const person = karteEl(behaelter, 'k1aaaa').querySelector('.ob-personen .avatar');
    assert.equal(person.getAttribute('data-avatar'), 'anna'); assert.ok(person.classList.contains('ob-person'));
    assert.equal(person.querySelector('img').getAttribute('src'), '/api/avatar/anna?v=abcdef012345');
    assert.equal(karteEl(behaelter, 'k3aaaa').querySelector('.ob-personen .avatar').textContent, 'B', 'ohne Bild der Anfangsbuchstabe');
  } finally { av.avatareSetzen({}); }
});

test('Leser: keine Ziehgriffe, Dialog nur lesend', async () => {
  const { s, behaelter } = await editorBauen(DATEN(), 'lesen');
  const k1 = karteEl(behaelter, 'k1aaaa');
  assert.equal((k1.hoerer.get('pointerdown') || []).length, 0, 'kein pointerdown-Hörer');
  assert.equal(behaelter.querySelector('.ob-karte-plus'), null);
  assert.equal(behaelter.querySelector('.ob-spalte-plus'), null);
  assert.equal(behaelter.querySelector('.ob-spalte-menue'), null);
  k1.click();
  const d = dialogJetzt();
  assert.equal(d.querySelector('.ob-titel-feld').readOnly, true);
  assert.equal(d.querySelector('.ob-beschreibung-feld'), null, 'Beschreibung nur als Ansicht');
  assert.ok(d.querySelector('.ob-beschreibung-ansicht'));
  assert.ok(d.querySelectorAll('.ob-zustaendig input').every((x) => x.disabled));
  assert.equal(d.querySelector('.ob-kommentar-neu'), null);
  assert.equal(d.querySelector('.ob-anhang-datei'), null); assert.equal(d.querySelector('.ob-anhang-nas'), null);
  assert.equal(d.querySelector('.ob-karte-loeschen'), null); assert.equal(d.querySelector('.ob-archivieren'), null);
  assert.equal(d.querySelector('.ob-spalte-wahl').disabled, true);
  assert.deepEqual(s.ops, []);
});

test('Prüfbericht Plan 04, I5: Kommentar-Autor kommt aus „wer“, nicht aus dem mitgeschickten Namen', () => {
  const daten = DATEN();
  daten.karten.k1aaaa.kommentare = [{ id: 'c1aaaa', wer: 'ben', name: 'Anna A.', zeit: '2026-10-18T08:00:00.000Z', text: 'gefälscht' }];
  const s = scheinSitzung(daten);
  dialogMod.karteDialog(ctxBauen(), s, 'k1aaaa', { mitglieder: ['anna', 'ben'], namen: new Map([['ben', 'Ben B.']]), recht: 'bearbeiten' });
  assert.equal(dialogJetzt().querySelector('.ob-kommentar strong').textContent, 'Ben B.');
  dialogJetzt().querySelector('.dialog-schliessen').click();
  dialogMod.karteDialog(ctxBauen(), s, 'k1aaaa', { mitglieder: ['anna'], recht: 'bearbeiten' });
  assert.equal(dialogJetzt().querySelector('.ob-kommentar strong').textContent, 'ben', 'unbekannt → Anmeldename');
});
