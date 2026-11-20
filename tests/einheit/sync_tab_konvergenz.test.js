// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konvergenz des Datentyps „tabelle“ über den Sync-Motor (Plan 06 Aufgabe 10): drei Klienten ändern gleichzeitig
// Zellen (Zahlen, Text, Formeln über Blattgrenzen), Formate, Zeilen und Spalten, sortieren und legen Blätter an, benennen,
// verschieben und löschen sie (auch das letzte). Nach dem Ausliefern haben alle den Stand des Servers, der Stand ist eine
// gültige Mappe und keine Formel enthält Unlesbares. Dazu Review Focus 1 in allen sechs Reihenfolgen, die gefundenen
// Fälle als feste Abläufe und eine Modellprüfung der Blatt-Ops (Löschen mit rest, Standardblatt, Zurückholen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulieren } from './sync_simulation.js';
import { mappe, werteVon, tp1 } from './sync_tab_beispiele.js';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..', '..');
const { tabelle, datenPruefen, LEER_F } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'typen', 'tabelle.js')).href);
const { SyncKlient } = await import(pathToFileURL(path.join(WURZEL, 'public', 'gemeinsam', 'sync', 'klient.js')).href);
const { zerlegen } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'tabelle', 'formeln', 'lexer.js')).href);
const { adresse } = await import(pathToFileURL(path.join(WURZEL, 'public', 'office', 'tabelle', 'formeln', 'adresse.js')).href);

const wahl = (rng, l) => l[Math.floor(rng() * l.length)];
const zahl = (rng, von, bis) => von + Math.floor(rng() * (bis - von + 1));
const zaehler = new Map();
const neueId = (nutzer) => { const n = (zaehler.get(nutzer) || 0) + 1; zaehler.set(nutzer, n); return `${nutzer}${String(n).padStart(4, '0')}`; };
const POSITIONEN = ['a', 'f', 'i', 'k', 'p', 'r', 'u', 'z', 'ii', 'im'];
const STRUKTUR = ['zeilen_einfuegen', 'zeilen_loeschen', 'spalten_einfuegen', 'spalten_loeschen'];

/** Zufälliger Zellinhalt; Formeln aus der Liste des Plans, Blattbezug auf ein anderes Blatt, wenn es eines gibt. */
function zufallsW(rng, anderes) {
  const r = rng();
  if (r < 0.3) return String(zahl(rng, -50, 500));
  if (r < 0.45) return wahl(rng, ['Text', 'ja', "'007", null]);
  return wahl(rng, ['=SUM(A1:B3)', '=A2*2', anderes ? `=[${anderes.id}]!C4` : '=A2*2', '=SUM(B:B)']);
}
const zufallsF = (rng) => wahl(rng, [{ fett: true }, { fett: null }, { farbe: '#b42318' }, { kursiv: true, ausr: 'mitte' }, { zahl: 'euro', hinter: '#fff3a3' }, LEER_F]);

/** Sortieren: Zeilen eines Bereichs zufällig umgeordnet, jede Adresse mit vollem Eintrag. */
function sortierenOp(rng, blatt) {
  const z1 = zahl(rng, 1, 10), z2 = Math.min(12, z1 + zahl(rng, 1, 3)), s1 = zahl(rng, 1, 5), s2 = Math.min(6, s1 + zahl(rng, 0, 1));
  const quellen = [];
  for (let z = z1; z <= z2; z++) quellen.splice(Math.floor(rng() * (quellen.length + 1)), 0, z);
  const zellen = {};
  quellen.forEach((q, k) => {
    for (let s = s1; s <= s2; s++) {
      const alt = blatt.zellen[adresse(q, s)];
      zellen[adresse(z1 + k, s)] = { w: alt?.w ?? null, f: { ...LEER_F, ...(alt?.f || {}) } };
    }
  });
  return { typ: 'sortieren', blatt: blatt.id, bereich: `${adresse(z1, s1)}:${adresse(z2, s2)}`, spalte: zahl(rng, s1, s2), absteigend: rng() < 0.5, zellen };
}

/** Zufällige Änderung aus dem eigenen Stand, Adressen nur in A1:F12 (damit sich Ops oft treffen). */
function zufallsOp(daten, rng, nutzer) {
  const blatt = wahl(rng, daten.blaetter);
  const andere = daten.blaetter.filter((b) => b.id !== blatt.id);
  const anderes = andere.length ? wahl(rng, andere) : null;
  const adr = () => adresse(zahl(rng, 1, 12), zahl(rng, 1, 6));
  const r = rng();
  if (r < 0.25) {
    const w = zufallsW(rng, anderes);
    return { typ: 'zelle', blatt: blatt.id, zelle: adr(), w, ...(rng() < 0.2 ? { f: zufallsF(rng) } : {}) };
  }
  if (r < 0.37) {
    const werte = {};
    for (let i = zahl(rng, 1, 6); i > 0; i--) werte[adr()] = rng() < 0.5 ? { w: zufallsW(rng, anderes) } : rng() < 0.5 ? { f: zufallsF(rng) } : { w: zufallsW(rng, anderes), f: zufallsF(rng) };
    return { typ: 'zellen', blatt: blatt.id, werte };
  }
  if (r < 0.62) return { typ: wahl(rng, STRUKTUR), blatt: blatt.id, ab: zahl(rng, 1, 8), anzahl: zahl(rng, 1, 3) };
  if (r < 0.68) return sortierenOp(rng, blatt);
  if (r < 0.74) {
    const neu = { id: neueId(nutzer), name: `Blatt ${nutzer}`, pos: wahl(rng, POSITIONEN) };
    if (rng() < 0.5) neu.zellen = { A1: { w: `=[${blatt.id}]!B2+SUM([${blatt.id}]!A1:A3)` }, B1: { w: '=A1*2' } };
    return { typ: 'blatt_neu', blatt: neu };
  }
  if (r < 0.78) return { typ: 'blatt_umbenennen', blatt: blatt.id, name: wahl(rng, ['Umsatz', 'Kosten', 'Daten 2', 'März']) };
  if (r < 0.83) return { typ: 'blatt_loeschen', blatt: blatt.id, rest: andere.map((b) => b.id) }; // wie der Editor: die übrigen Blätter
  if (r < 0.87) return { typ: 'blatt_verschieben', blatt: blatt.id, pos: wahl(rng, POSITIONEN) };
  if (r < 0.94) return { typ: 'spalte_breite', blatt: blatt.id, spalte: zahl(rng, 1, 6), breite: rng() < 0.3 ? null : zahl(rng, 20, 400) };
  return { typ: 'fixieren', blatt: blatt.id, zeilen: rng() < 0.5 ? 0 : 1 };
}

for (let seed = 1; seed <= 40; seed++) {
  test(`Tabelle konvergiert seed ${seed}`, () => {
    const { server, klienten } = simulieren({ typ: tabelle, zufallsOp, seed, schritte: 200 });
    for (const { nutzer, klient } of klienten) { assert.equal(klient.ausstehend, 0, nutzer); assert.deepEqual(klient.daten, server.daten, nutzer); }
    assert.doesNotThrow(() => datenPruefen(server.daten));
    for (const b of server.daten.blaetter) {
      for (const z of Object.values(b.zellen)) if (z.w?.startsWith('=')) assert.ok(!zerlegen(z.w.slice(1)).some((t) => t.art === 'unbekannt'), z.w);
    }
    assert.ok(server.version > 20, 'genug Ops');
  });
}

const META = Object.freeze({ id: 'oAAAAAAAAAAAAAAAA', art: 'tabelle', name: 'Fokus', freigabe: 'team', pfad: 'Fokus.fahtab', besitzer: 'anna' });
const PERMUTATIONEN_3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** Wie simulieren, aber fest: je Klient eine Op mit Basis 0, vorgegebene Reihenfolge am Server, Rückleitung erst am Ende. */
function ablauf(start, ops, reihenfolge) {
  const server = new OffenesDokument({ meta: META, typ: tabelle, version: 0, daten: start, stand: 'S0' });
  const namen = ['anna', 'ben', 'cara'].slice(0, ops.length);
  const hoch = {}, kl = {};
  for (const n of namen) { hoch[n] = []; kl[n] = new SyncKlient({ typ: tabelle, version: 0, daten: start, senden: (m) => hoch[n].push(m), cidVorsilbe: n }); }
  namen.forEach((n, i) => kl[n].lokal(ops[i]));
  const runter = [];
  for (const i of reihenfolge) {
    for (const m of hoch[namen[i]]) {
      const e = server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: namen[i] });
      runter.push({ art: 'op', version: e.v, cid: e.cid, op: e.op });
    }
  }
  for (const n of namen) for (const m of runter) kl[n].empfangen(m);
  for (const n of namen) assert.deepEqual(kl[n].daten, server.daten, `${n}, Reihenfolge ${reihenfolge}`);
  return server.daten;
}
const festerAblauf = (reihenfolge) => ablauf(mappe({ blatt1: { A1: '1', A2: '2', A3: '3', A4: '4' } }),
  [{ typ: 'zelle', blatt: 'blatt1', zelle: 'A5', w: '=SUM(A1:A4)' }, { typ: 'zeilen_einfuegen', blatt: 'blatt1', ab: 3, anzahl: 1 }, { typ: 'zeilen_loeschen', blatt: 'blatt1', ab: 2, anzahl: 1 }], reihenfolge);

test('Review Focus 1: Formel tippen, Zeile einfügen, Zeile löschen – jede Reihenfolge', () => {
  /* Start: A1..A4 = 1,2,3,4 auf blatt1. anna: zelle A5 '=SUM(A1:A4)'; ben: zeilen_einfuegen ab 3 anzahl 1; cara: zeilen_loeschen ab 2 anzahl 1;
     alle drei mit Basis 0, alle sechs Reihenfolgen am Server. bens Zeile kommt direkt nach caras gelöschter Zeile und geht nach dem
     Ruling aus Aufgabe 9 mit ihr (Einfügen am Rand eines gleichzeitig gelöschten Bereichs verliert). Erwartet: A1 '1', A2 '3', A3 '4',
     annas Formel in A4 als '=SUM(A1:A3)' – sie summiert genau die verbliebenen Zeilen 1, 3, 4. */
  for (const reihenfolge of PERMUTATIONEN_3) assert.deepEqual(werteVon(festerAblauf(reihenfolge), 'blatt1'), { A1: '1', A2: '3', A3: '4', A4: '=SUM(A1:A3)' });
});

test('Gefunden: Struktur-Op auf einem gleichzeitig gelöschten Blatt – Bezüge darauf werden in jeder Reihenfolge #REF!', () => {
  const start = mappe({ blatt1: { B2: '5' }, blatt2: { A1: '=[blatt1]!B2+SUM([blatt1]!A1:A3)' } });
  for (const typ of ['spalten_einfuegen', 'zeilen_loeschen']) {
    for (const r of [[0, 1], [1, 0]]) {
      const d = ablauf(start, [{ typ, blatt: 'blatt1', ab: 1, anzahl: 2 }, { typ: 'blatt_loeschen', blatt: 'blatt1', rest: ['blatt2'] }], r);
      assert.deepEqual(werteVon(d, 'blatt2'), { A1: '=#REF!+SUM(#REF!)' });
    }
  }
});

test('Gefunden: letztes Blatt löschen, während andere ein Blatt anlegen bzw. das andere letzte löschen – jede Reihenfolge', () => {
  const neu = { typ: 'blatt_neu', blatt: { id: 'ben00001', name: 'Neu', pos: 'z' } };
  for (const r of [[0, 1], [1, 0]]) {
    const d = ablauf(mappe({ blatt1: { A1: '1' } }), [{ typ: 'blatt_loeschen', blatt: 'blatt1', rest: [] }, neu], r);
    assert.deepEqual(d.blaetter.map((b) => [b.id, Object.keys(b.zellen).length]), [['blatt1', 0], ['ben00001', 0]], 'Standardblatt neben dem neuen');
  }
  for (const r of PERMUTATIONEN_3) {
    const d = ablauf(mappe({ x00001: { A1: '1' }, y00001: { A1: '2' } }), [{ typ: 'blatt_loeschen', blatt: 'x00001', rest: ['y00001'] }, { typ: 'blatt_loeschen', blatt: 'y00001', rest: ['x00001'] }, neu], r);
    assert.deepEqual(d.blaetter.map((b) => b.id), ['blatt1', 'ben00001'], `Reihenfolge ${r}`);
    assert.doesNotThrow(() => datenPruefen(d));
  }
});

test('Blatt-Ops: TP1 auf allen kleinen Ständen, auch nach Transformation gegen eine dritte Op (Modellprüfung)', () => {
  // Stände: jede nichtleere Teilmenge von drei Blättern (blatt1 ist zugleich das Standardblatt), jedes mit einer Formel auf alle
  // anderen. Ops: jedes Löschen mit jeder möglichen rest-Liste, neues Blatt, Zurückholen eines fehlenden Blatts (wie Rückgängig;
  // blatt1 nur als leeres Standardblatt), eine Zelle mit Blattbezug und Zeilen einfügen – als Paare und nach Transformation
  // gegen eine dritte Op.
  const A = (d, op) => tabelle.anwenden(d, op);
  const T = tabelle.transformiere;
  const IDS = ['blatt1', 'x00001', 'y00001', 'z00001'];
  const teilmengen = (l) => l.reduce((acc, x) => acc.concat(acc.map((t) => [...t, x])), [[]]);
  const blattAus = (id) => ({ id, name: `B${IDS.indexOf(id)}`, pos: 'ikmo'[IDS.indexOf(id)], zellen: { A1: { w: '=' + IDS.filter((x) => x !== id).map((x) => `[${x}]!A1`).join('+') }, B1: { w: id } }, spalten: {}, zeilen: {}, fixiert: { zeilen: 0 } });
  const opsFuer = (d) => {
    const da = d.blaetter.map((b) => b.id);
    const ops = [];
    for (const id of da) for (const rest of teilmengen(da.filter((x) => x !== id))) ops.push({ typ: 'blatt_loeschen', blatt: id, rest });
    for (const id of IDS.filter((x) => !da.includes(x) && x !== 'blatt1')) ops.push({ typ: 'blatt_neu', blatt: blattAus(id) });
    if (!da.includes('blatt1')) ops.push({ typ: 'blatt_neu', blatt: tabelle.leer().blaetter[0] }); // blatt1 nur als Standardblatt
    for (const id of da) ops.push({ typ: 'zelle', blatt: id, zelle: 'C1', w: `=[${da[0]}]!A1` }, { typ: 'zeilen_einfuegen', blatt: id, ab: 1, anzahl: 1 });
    for (const op of ops) tabelle.pruefen(op);
    return ops;
  };
  for (const ids of teilmengen(IDS.slice(0, 3)).filter((t) => t.length)) {
    const d = { blaetter: ids.map(blattAus) };
    const ops = opsFuer(d);
    for (const a of ops) {
      const d1 = A(d, a);
      for (const b of ops) {
        tp1(d, a, b);
        for (const c of ops) for (const s1 of ['links', 'rechts']) for (const s2 of ['links', 'rechts']) tp1(d1, T(b, a, s1), T(c, a, s2));
      }
    }
  }
});
