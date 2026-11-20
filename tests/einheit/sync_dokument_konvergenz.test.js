// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konvergenz des Datentyps „dokument“ über den Sync-Motor (Plan 05 Aufgabe 4): drei Klienten ändern gleichzeitig Text,
// Formate, Zeilenformate, Bilder, Seitenumbrüche, Tabellen (alle 8 Tabellen-Ops) und Kommentare; nach dem Ausliefern
// haben alle den Stand des Servers, und der Stand ist ein gültiges Dokument. Dazu ein fester Tabellen-Ablauf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulieren } from './sync_simulation.js';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { dokument, dokumentPruefen } = await import(pathToFileURL(path.join(SYNC, 'typen', 'dokument.js')).href);
const { sichtbareZeilen, sichtbareSpalten, TABELLEN_OPS } = await import(pathToFileURL(path.join(SYNC, 'typen', 'dokument-tabelle.js')).href);
const { SyncKlient } = await import(pathToFileURL(path.join(SYNC, 'klient.js')).href);

const wahl = (rng, l) => l[Math.floor(rng() * l.length)];
const zaehler = new Map();
const neueId = (nutzer) => { const n = (zaehler.get(nutzer) || 0) + 1; zaehler.set(nutzer, n); return `${nutzer}${String(n).padStart(5, '0')}`; };
const zeit = (rng) => new Date(Date.UTC(2026, 9, 18) + Math.floor(rng() * 50) * 1000).toISOString();

/** Elemente des Dokuments: je Zeichen bzw. Embed {art:'text'|'nl'|'bild'|'seitenumbruch'|'tabelle', wert?}. */
function elemente(delta) {
  const aus = [];
  for (const op of delta) {
    if (typeof op.insert === 'string') for (const z of op.insert) aus.push({ art: z === '\n' ? 'nl' : 'text' });
    else { const [name, wert] = Object.entries(op.insert)[0]; aus.push({ art: name, wert }); }
  }
  return aus;
}
const pre = (p, ops) => (p > 0 ? [{ retain: p }, ...ops] : ops);

/** Inline-Format über einen Bereich, Embeds ausgelassen (wie der Editor). */
function formatOps(el, von, bis, attributes) {
  const ops = [];
  let lauf = 0; let art = null;
  const schliessen = () => { if (lauf) ops.push(art === 'fmt' ? { retain: lauf, attributes } : { retain: lauf }); lauf = 0; };
  for (let i = von; i < bis; i++) {
    const a = el[i].art === 'text' ? 'fmt' : 'frei';
    if (a !== art) { schliessen(); art = a; }
    lauf++;
  }
  schliessen();
  return ops;
}

function tabellenOps(rng, w, nutzer) {
  const zeilen = sichtbareZeilen(w); const spalten = sichtbareSpalten(w);
  const typ = wahl(rng, TABELLEN_OPS);
  const weg = w.weg.filter(Boolean);
  switch (typ) {
    case 'zelle': return zeilen.length && spalten.length ? [{ typ, zeile: wahl(rng, zeilen), spalte: wahl(rng, spalten), inhalt: rng() < 0.2 ? [] : [{ insert: `${nutzer[0]}${Math.floor(rng() * 99)}`, ...(rng() < 0.3 ? { attributes: { fett: true } } : {}) }] }] : null;
    case 'zeile_einfuegen': return [{ typ, nach: rng() < 0.2 ? null : wahl(rng, w.zeilen), id: neueId(nutzer) }];
    case 'spalte_einfuegen': return w.spalten.length < 8 ? [{ typ, nach: rng() < 0.2 ? null : wahl(rng, w.spalten), id: neueId(nutzer) }] : null;
    case 'zeile_loeschen': return zeilen.length > 1 ? [{ typ, id: wahl(rng, zeilen) }] : null;
    case 'spalte_loeschen': return spalten.length > 1 ? [{ typ, id: wahl(rng, spalten) }] : null;
    case 'zeile_zurueck': { const z = weg.filter((id) => w.zeilen.includes(id)); return z.length ? [{ typ, id: wahl(rng, z), zellen: {} }] : null; }
    case 'spalte_zurueck': { const s = weg.filter((id) => w.spalten.includes(id)); return s.length ? [{ typ, id: wahl(rng, s), zellen: {}, ...(rng() < 0.5 ? { breite: 120 } : {}) }] : null; }
    case 'breite': return spalten.length ? [{ typ, spalte: wahl(rng, spalten), px: rng() < 0.3 ? null : 40 + Math.floor(rng() * 300) }] : null;
    default: return null;
  }
}

/** Zufällige Änderung aus dem eigenen Stand. */
function zufallsOp(daten, rng, nutzer) {
  const el = elemente(daten.delta);
  const L = el.length; // ≥ 1, letztes ist '\n'
  const kommentare = Object.keys(daten.kommentare);
  const r = rng();
  if (r < 0.25) { // Text einfügen
    const p = Math.floor(rng() * L); // vor dem letzten \n
    const attributes = rng() < 0.3 ? wahl(rng, [{ fett: true }, { kursiv: true }, { farbe: 'rot' }, { link: 'https://fah.de' }]) : undefined;
    return { d: pre(p, [{ insert: wahl(rng, ['a', 'bc', ' ', '\n', 'de\nf']), ...(attributes ? { attributes } : {}) }]) };
  }
  if (r < 0.4) { // Bereich löschen, nie das letzte \n
    if (L < 2) return null;
    const p = Math.floor(rng() * (L - 1)); const n = 1 + Math.floor(rng() * Math.min(4, L - 1 - p));
    return { d: pre(p, [{ delete: n }]) };
  }
  if (r < 0.5) { // Inline-Format
    const p = Math.floor(rng() * L); const n = 1 + Math.floor(rng() * Math.min(5, L - p));
    const ops = formatOps(el, p, p + n, wahl(rng, [{ fett: true }, { fett: null }, { farbe: 'blau', hintergrund: 'gelb' }, { farbe: null }, { link: null }, { code: true }]));
    return ops.some((o) => o.attributes) ? { d: pre(p, ops) } : null;
  }
  if (r < 0.58) { // Zeilenformat auf einem Zeilenumbruch
    const nls = el.map((e, i) => (e.art === 'nl' ? i : -1)).filter((i) => i >= 0);
    const q = wahl(rng, nls);
    const attributes = wahl(rng, [{ ueberschrift: 1 + Math.floor(rng() * 3) }, { ueberschrift: null }, { liste: wahl(rng, ['punkte', 'zahlen', 'aufgabe']) }, { liste: null, erledigt: null }, { einzug: 1 + Math.floor(rng() * 8) }, { ausrichtung: 'mitte' }, { ausrichtung: null }, { zitat: true }]);
    return { d: pre(q, [{ retain: 1, attributes }]) };
  }
  if (r < 0.63) { // Block (Seitenumbruch oder Tabelle) allein in seiner Zeile
    const p = Math.floor(rng() * L);
    const zeilenanfang = p === 0 || el[p - 1].art === 'nl';
    const block = rng() < 0.4 ? { seitenumbruch: true } : { tabelle: { id: neueId(nutzer), zeilen: [neueId(nutzer), neueId(nutzer)], spalten: [neueId(nutzer), neueId(nutzer)], weg: [], zellen: {}, breiten: {} } };
    return { d: pre(p, [...(zeilenanfang ? [] : [{ insert: '\n' }]), { insert: block }, { insert: '\n' }]) };
  }
  if (r < 0.67) { // Bild einfügen
    const p = Math.floor(rng() * L);
    const n = zaehler.get(nutzer) || 0;
    return { d: pre(p, [{ insert: { bild: { datei: `${nutzer.padEnd(4, 'x').slice(0, 4)}${String(n).padStart(8, '0')}-b.png`, breite: 100 } } }]) };
  }
  if (r < 0.71) { // Bild ändern
    const bilder = el.map((e, i) => (e.art === 'bild' ? i : -1)).filter((i) => i >= 0);
    if (!bilder.length) return null;
    return { d: pre(wahl(rng, bilder), [{ retain: { bild: rng() < 0.5 ? { breite: 16 + Math.floor(rng() * 500) } : { alt: rng() < 0.5 ? null : `alt ${nutzer}` } } }]) };
  }
  if (r < 0.85) { // Tabellen-Ops
    const tabellen = el.map((e, i) => (e.art === 'tabelle' ? i : -1)).filter((i) => i >= 0);
    if (!tabellen.length) return null;
    const q = wahl(rng, tabellen);
    const liste = tabellenOps(rng, el[q].wert, nutzer);
    return liste ? { d: pre(q, [{ retain: { tabelle: liste } }]) } : null;
  }
  // Kommentare
  const eintrag = () => ({ wer: nutzer, name: nutzer.toUpperCase(), zeit: zeit(rng), text: `t${Math.floor(rng() * 100)}` });
  const k = rng();
  if (k < 0.35 || !kommentare.length) {
    const id = neueId(nutzer);
    const p = Math.floor(rng() * L); const n = 1 + Math.floor(rng() * Math.min(4, L - p));
    const ops = formatOps(el, p, p + n, { kommentar: id });
    return { ...(ops.some((o) => o.attributes) ? { d: pre(p, ops) } : {}), k: { [id]: { neu: eintrag() } } };
  }
  const id = wahl(rng, kommentare);
  if (k < 0.65) return { k: { [id]: { antworten: { [neueId(nutzer)]: eintrag() } } } };
  if (k < 0.85) return { k: { [id]: { erledigt: rng() < 0.5 } } };
  return { k: { [id]: null } };
}

for (let seed = 1; seed <= 40; seed++) {
  test(`Dokument konvergiert seed ${seed}`, () => {
    const { server, klienten } = simulieren({ typ: dokument, zufallsOp, seed, schritte: 200 });
    for (const { nutzer, klient } of klienten) { assert.equal(klient.ausstehend, 0, nutzer); assert.deepEqual(klient.daten, server.daten, nutzer); }
    assert.doesNotThrow(() => dokumentPruefen(server.daten));
    assert.ok(server.version > 20, 'genug Ops');
  });
}

test('Tabellenzeile löschen, während in einer Zelle dieser Zeile getippt wird (fester Ablauf)', () => {
  const tab = { id: 'tab001', zeilen: ['z00001', 'z00002', 'z00003'], spalten: ['s00001'], weg: [], zellen: { 'z00002|s00001': [{ insert: 'alt' }] }, breiten: {} };
  const start = dokument.anwenden(dokument.leer(), { d: [{ insert: { tabelle: tab } }, { insert: '\n' }] });
  const server = new OffenesDokument({ meta: { id: 'oAAAAAAAAAAAAAAAA', art: 'dokument', name: 'T', freigabe: 'team', pfad: 'T.fahdoc', besitzer: 'anna' }, typ: dokument, version: 0, daten: start, stand: 'S0' });
  const hoch = []; const runter = { anna: [], ben: [], cara: [] };
  const kl = Object.fromEntries(['anna', 'ben', 'cara'].map((n) => [n, new SyncKlient({ typ: dokument, version: 0, daten: start, senden: (m) => hoch.push([n, m]), cidVorsilbe: n })]));
  kl.anna.lokal({ d: [{ retain: { tabelle: [{ typ: 'zelle', zeile: 'z00002', spalte: 's00001', inhalt: [{ insert: 'neu' }] }] } }] });
  kl.ben.lokal({ d: [{ retain: { tabelle: [{ typ: 'zeile_loeschen', id: 'z00002' }] } }] });
  kl.cara.lokal({ d: [{ retain: { tabelle: [{ typ: 'zeile_einfuegen', nach: 'z00002', id: 'cara01' }] } }] });
  for (const [n, m] of hoch.reverse()) {
    const e = server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: n });
    for (const x of Object.keys(runter)) runter[x].push({ art: 'op', version: e.v, cid: e.cid, op: e.op });
  }
  for (const [n, liste] of Object.entries(runter)) for (const m of liste) kl[n].empfangen(m);
  for (const k of Object.values(kl)) assert.deepEqual(k.daten, server.daten);
  const t = server.daten.delta[0].insert.tabelle;
  assert.deepEqual(t.weg, ['z00002']);
  assert.deepEqual(t.zellen['z00002|s00001'], [{ insert: 'neu' }], 'Löschen versteckt nur – annas Eingabe bleibt für „zurück“ erhalten (Prüfbericht I-4)');
  assert.deepEqual(sichtbareZeilen(t), ['z00001', 'cara01', 'z00003'], 'caras Zeile direkt vor z00003');
  assert.doesNotThrow(() => dokumentPruefen(server.daten));
});
