// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Simulation des Sync-Motors für Konvergenztests (Plan 05 Aufgabe 4): ein Server (OffenesDokument) und mehrere
// Klienten (SyncKlient), je Richtung und Klient eine FIFO-Leitung, zufällige Reihenfolge der Auslieferung. Am Ende
// werden alle Leitungen geleert; danach müssen alle Klienten den Stand des Servers haben.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { SyncKlient } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'klient.js')).href);

/** Eigener Zufall (mulberry32), damit ein Seed immer denselben Ablauf ergibt. */
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const META = Object.freeze({ id: 'oAAAAAAAAAAAAAAAA', art: 'dokument', name: 'Sim', freigabe: 'team', pfad: 'Sim.fahdoc', besitzer: 'anna', schnappschuesse: false });

/**
 * Lauf: je Schritt zu 50 % eine Op eines zufälligen Klienten aus dessen Stand (`zufallsOp(daten, rng, nutzer)`), sonst die
 * älteste Nachricht einer zufälligen nichtleeren Leitung. `start` = Anfangsdaten (Standard typ.leer()).
 */
export function simulieren({ typ, zufallsOp, seed, schritte, nutzer = ['anna', 'ben', 'cara'], start = null }) {
  const rng = mulberry32(seed);
  const anfang = start ?? typ.leer();
  const server = new OffenesDokument({ meta: { ...META, art: typ.name }, typ, version: 0, daten: anfang, stand: 'S0' });
  const klienten = nutzer.map((n, i) => {
    const c = { nutzer: n, hoch: [], runter: [], klient: null };
    c.klient = new SyncKlient({ typ, version: 0, daten: anfang, senden: (m) => c.hoch.push(m), cidVorsilbe: `k${i}` });
    return c;
  });
  const serverEmpfaengt = (c, m) => {
    const e = server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: c.nutzer });
    const n = { art: 'op', version: e.v, cid: e.cid, op: e.op };
    if (e.doppelt) { c.runter.push(n); return; }
    for (const x of klienten) x.runter.push(n);
  };
  const ausliefern = () => {
    const leitungen = [];
    for (const c of klienten) { if (c.hoch.length) leitungen.push(['hoch', c]); if (c.runter.length) leitungen.push(['runter', c]); }
    if (!leitungen.length) return false;
    const [richtung, c] = leitungen[Math.floor(rng() * leitungen.length)];
    if (richtung === 'hoch') serverEmpfaengt(c, c.hoch.shift()); else c.klient.empfangen(c.runter.shift());
    return true;
  };
  for (let i = 0; i < schritte; i++) {
    if (rng() < 0.5) {
      const c = klienten[Math.floor(rng() * klienten.length)];
      const op = zufallsOp(c.klient.daten, rng, c.nutzer);
      if (op) c.klient.lokal(op);
    } else ausliefern();
  }
  for (let i = 0; i < 1_000_000 && ausliefern(); i++);
  return { server, klienten: klienten.map((c) => ({ nutzer: c.nutzer, klient: c.klient })) };
}
