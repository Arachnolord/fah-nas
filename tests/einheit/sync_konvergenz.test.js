// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konvergenz-Eigenschaftstest (Plan 04, Aufgabe 9): drei Klienten (anna, ben, cara) erzeugen zufällige gültige Board-Ops
// aus ihrem eigenen Stand, Nachrichten laufen über FIFO-Leitungen mit zufälliger Verzögerung, Verbindungen reißen ab
// (Wiederaufnahme oder Neuladen), der Server speichert zwischendurch (Verlauf wird gekürzt). Am Ende: alle gleich.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OffenesDokument } from '../../src/web/office/dokument.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync');
const { board, zwischen, sortiert, ETIKETT_FARBEN } = await import(pathToFileURL(path.join(SYNC, 'typen', 'board.js')).href);
const { SyncKlient } = await import(pathToFileURL(path.join(SYNC, 'klient.js')).href);

/** Kleiner, reproduzierbarer Zufall. */
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wahl = (rng, liste) => liste[Math.floor(rng() * liste.length)];
const META = { id: 'oAAAAAAAAAAAAAAAA', art: 'board', name: 'Plan', freigabe: 'team', pfad: 'Plan.fahboard', besitzer: 'anna', schnappschuesse: false };

/** Gültige Zufalls-Op aus dem Stand `d` des Klienten (alle 13 Typen). `z` = Zähler für eindeutige IDs und Zeiten. */
function zufallsOp(d, rng, nutzer, z) {
  const neueId = (vor) => `${vor}${nutzer}${String(++z.n).padStart(4, '0')}`; // eindeutig je Klient (im Betrieb: Zufalls-IDs)
  const karten = Object.values(d.karten);
  const spalten = d.spalten;
  const karte = () => wahl(rng, karten);
  const posIn = (spalte) => { const ps = sortiert(karten.filter((k) => k.spalte === spalte)).map((k) => k.pos); const i = Math.floor(rng() * (ps.length + 1)); return zwischen(i > 0 ? ps[i - 1] : null, i < ps.length ? ps[i] : null); };
  const zielSpalte = () => (z.geloescht && rng() < 0.4 ? z.geloescht : spalten.length ? wahl(rng, spalten).id : 'todo00');
  const art = wahl(rng, ['karte_neu', 'karte_neu', 'karte_setzen', 'karte_setzen', 'karte_verschieben', 'karte_verschieben', 'karte_loeschen', 'spalte_neu', 'spalte_setzen', 'spalte_verschieben', 'spalte_loeschen', 'kommentar', 'checkliste', 'etikett', 'anhang', 'noop']);
  const brauchtKarte = ['karte_setzen', 'karte_verschieben', 'karte_loeschen', 'kommentar', 'checkliste', 'anhang'].includes(art);
  if (brauchtKarte && !karten.length) return neueKarte();
  if (['spalte_setzen', 'spalte_verschieben', 'spalte_loeschen'].includes(art) && !spalten.length) return { typ: 'spalte_neu', spalte: { id: neueId('s'), titel: 'Neu', pos: zwischen(null, null) } };
  function neueKarte() {
    const spalte = zielSpalte();
    return { typ: 'karte_neu', karte: { id: neueId('k'), spalte, pos: posIn(spalte), titel: `K${z.n}`, erstellt: zeit(), ersteller: nutzer } };
  }
  function zeit() { return new Date(Date.UTC(2026, 9, 18) + Math.floor(rng() * 50) * 1000).toISOString(); }
  switch (art) {
    case 'karte_neu': return neueKarte();
    case 'karte_setzen': {
      const felder = {};
      if (rng() < 0.6) felder.titel = `T${z.n++}`;
      if (rng() < 0.3) felder.beschreibung = rng() < 0.5 ? '' : `B${z.n++}`;
      if (rng() < 0.3) felder.zustaendig = rng() < 0.5 ? [] : [nutzer];
      if (rng() < 0.3) felder.faellig = rng() < 0.5 ? null : '2026-10-2' + Math.floor(rng() * 9);
      if (rng() < 0.3) felder.etiketten = Object.keys(d.etiketten).filter(() => rng() < 0.5);
      if (rng() < 0.3 || !Object.keys(felder).length) felder.archiviert = rng() < 0.5;
      return { typ: 'karte_setzen', id: karte().id, felder };
    }
    case 'karte_verschieben': { const spalte = zielSpalte(); return { typ: 'karte_verschieben', id: karte().id, spalte, pos: posIn(spalte) }; }
    case 'karte_loeschen': return { typ: 'karte_loeschen', id: karte().id };
    case 'spalte_neu': return { typ: 'spalte_neu', spalte: { id: neueId('s'), titel: `S${z.n}`, pos: zwischen(spalten.length ? spalten[spalten.length - 1].pos : null, null) } };
    case 'spalte_setzen': return { typ: 'spalte_setzen', id: wahl(rng, spalten).id, titel: `S${z.n++}` };
    case 'spalte_verschieben': { const ps = spalten.map((s) => s.pos); const i = Math.floor(rng() * (ps.length + 1)); return { typ: 'spalte_verschieben', id: wahl(rng, spalten).id, pos: zwischen(i > 0 ? ps[i - 1] : null, i < ps.length ? ps[i] : null) }; }
    case 'spalte_loeschen': { const s = wahl(rng, spalten); z.geloescht = s.id; return { typ: 'spalte_loeschen', id: s.id, karten: karten.filter((k) => k.spalte === s.id).map((k) => k.id) }; }
    case 'kommentar': {
      const k = karte(); const eigene = k.kommentare.filter((c) => c.wer === nutzer);
      if (eigene.length && rng() < 0.3) return { typ: 'kommentar', karte: k.id, kommentar: { id: wahl(rng, eigene).id, wer: nutzer, weg: true } };
      return { typ: 'kommentar', karte: k.id, kommentar: { id: neueId('c'), wer: nutzer, name: nutzer, zeit: zeit(), text: `C${z.n}` } };
    }
    case 'checkliste': {
      const k = karte();
      if (k.checkliste.length && rng() < 0.6) {
        const p = wahl(rng, k.checkliste);
        if (rng() < 0.3) return { typ: 'checkliste', karte: k.id, eintrag: { id: p.id, weg: true } };
        const e = { id: p.id };
        if (rng() < 0.5) e.text = `P${z.n++}`;
        if (rng() < 0.5) e.erledigt = rng() < 0.5;
        if (rng() < 0.3 || (e.text === undefined && e.erledigt === undefined)) e.pos = zwischen(null, null) + 'm';
        return { typ: 'checkliste', karte: k.id, eintrag: e };
      }
      const letzte = k.checkliste.length ? k.checkliste[k.checkliste.length - 1].pos : null;
      return { typ: 'checkliste', karte: k.id, eintrag: { id: neueId('p'), text: `P${z.n}`, pos: zwischen(letzte, null), neu: true } };
    }
    case 'etikett': {
      const ids = Object.keys(d.etiketten);
      if (ids.length && rng() < 0.3) return { typ: 'etikett', id: wahl(rng, ids), etikett: { weg: true } };
      if (ids.length && rng() < 0.5) return { typ: 'etikett', id: wahl(rng, ids), etikett: rng() < 0.5 ? { farbe: wahl(rng, ETIKETT_FARBEN) } : { name: `E${z.n++}` } };
      return { typ: 'etikett', id: neueId('e'), etikett: { name: `E${z.n}`, farbe: wahl(rng, ETIKETT_FARBEN) } };
    }
    case 'anhang': {
      const k = karte();
      if (k.anhaenge.length && rng() < 0.4) return { typ: 'anhang', karte: k.id, anhang: { datei: wahl(rng, k.anhaenge).datei, weg: true } };
      const kennung = `${nutzer}${String(++z.n).padStart(12 - nutzer.length, '0')}`; // genau 12 Zeichen
      return { typ: 'anhang', karte: k.id, anhang: { datei: `${kennung}-a${z.n}.pdf`, name: `a${z.n}.pdf`, groesse: z.n, mime: 'application/pdf' } };
    }
    default: return { typ: 'noop' };
  }
}

/** Ein Lauf: Klienten, Leitungen, Server; gibt Server und Klienten zurück, wenn alles ausgeliefert ist. */
function lauf(seed, schritte) {
  const rng = mulberry32(seed);
  const server = new OffenesDokument({ meta: META, typ: board, version: 0, daten: board.leer(), stand: 'S0', verlauf_max: 25 });
  const verbindungen = ['anna', 'ben', 'cara'].map((nutzer, i) => {
    const c = { nutzer, hoch: [], runter: [], verbunden: true, z: { n: 0, geloescht: null }, generation: 0, klient: null };
    c.neu = () => {
      c.generation++;
      c.klient = new SyncKlient({ typ: board, version: server.version, daten: server.daten, senden: (m) => c.hoch.push(m), cidVorsilbe: `${'abc'[i]}${c.generation}` });
      c.klient.on('neu_laden', () => { c.neuLaden = true; });
    };
    c.neu();
    return c;
  });
  const serverEmpfaengt = (c, m) => {
    if (m.art === 'op') {
      let e;
      try { e = server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: c.nutzer }); } catch (f) {
        if (f.code === 'E_GEAENDERT') { if (c.verbunden) c.runter.push({ art: 'neu_laden', grund: 'zu_alt' }); return; }
        throw f;
      }
      const n = { art: 'op', version: e.v, cid: e.cid, op: e.op };
      if (e.doppelt) { if (c.verbunden) c.runter.push(n); return; }
      for (const x of verbindungen) if (x.verbunden) x.runter.push(n);
    } else if (m.art === 'wiederaufnehmen') {
      c.verbunden = true;
      const ops = server.opsSeit(m.version);
      c.runter.push(ops === null ? { art: 'neu_laden', grund: 'zu_alt' } : { art: 'wiederaufgenommen', version: server.version, ops });
    }
  };
  const klientEmpfaengt = (c, m) => {
    c.klient.empfangen(m);
    if (c.neuLaden) { c.neuLaden = false; c.neu(); } // wie die Oberfläche: Dokument neu öffnen
  };
  const ausliefern = () => {
    const leitungen = [];
    for (const c of verbindungen) { if (c.hoch.length) leitungen.push(['hoch', c]); if (c.runter.length) leitungen.push(['runter', c]); }
    if (!leitungen.length) return false;
    const [richtung, c] = wahl(rng, leitungen);
    if (richtung === 'hoch') serverEmpfaengt(c, c.hoch.shift()); else klientEmpfaengt(c, c.runter.shift());
    return true;
  };
  for (let i = 0; i < schritte; i++) {
    const r = rng();
    if (r < 0.45) { const c = wahl(rng, verbindungen); const op = zufallsOp(c.klient.daten, rng, c.nutzer, c.z); c.klient.lokal(op); }
    else if (r < 0.97) ausliefern();
    else if (r < 0.985) {
      const c = wahl(rng, verbindungen);
      c.verbunden = false; c.runter = [];
      if (rng() < 0.5) c.hoch = []; // Gesendetes ging verloren
      c.klient.wiederaufnehmen();
    } else server.gespeichert(server.version, `S${server.version}`);
  }
  for (let i = 0; i < 1_000_000 && ausliefern(); i++);
  return { server, klienten: verbindungen.map((c) => Object.assign(c.klient, { nutzer: c.nutzer })) };
}

for (let seed = 1; seed <= 60; seed++) {
  test(`Konvergenz seed ${seed}`, () => {
    const { server, klienten } = lauf(seed, 250);
    for (const k of klienten) { assert.equal(k.ausstehend, 0, `Klient ${k.nutzer} hat Unbestätigtes`); assert.deepEqual(k.daten, server.daten, `Klient ${k.nutzer}`); }
    assert.ok(server.version > 20, 'genug Ops');
  });
}

test('Spalte löschen gegen gleichzeitiges Anlegen und Hineinziehen (fester Ablauf)', () => {
  const start = [
    { typ: 'karte_neu', karte: { id: 'k1aaaa', spalte: 'todo00', pos: 'i', titel: 'Eins', erstellt: '2026-10-18T08:00:00.000Z', ersteller: 'anna' } },
    { typ: 'karte_neu', karte: { id: 'k2aaaa', spalte: 'doing0', pos: 'i', titel: 'Zwei', erstellt: '2026-10-18T08:00:00.000Z', ersteller: 'anna' } },
  ].reduce((d, op) => board.anwenden(d, op), board.leer());
  const server = new OffenesDokument({ meta: META, typ: board, version: 0, daten: start, stand: 'S0' });
  const hoch = []; const runter = { anna: [], ben: [], cara: [] };
  const kl = Object.fromEntries(['anna', 'ben', 'cara'].map((n) => [n, new SyncKlient({ typ: board, version: 0, daten: start, senden: (m) => hoch.push([n, m]), cidVorsilbe: n })]));
  kl.anna.lokal({ typ: 'spalte_loeschen', id: 'todo00', karten: ['k1aaaa'] });
  kl.ben.lokal({ typ: 'karte_neu', karte: { id: 'k9aaaa', spalte: 'todo00', pos: 'r', titel: 'Neu', erstellt: '2026-10-18T09:00:00.000Z', ersteller: 'ben' } });
  kl.cara.lokal({ typ: 'karte_verschieben', id: 'k2aaaa', spalte: 'todo00', pos: 'z' });
  for (const [n, m] of hoch.reverse()) {
    const e = server.opAnnehmen({ basis: m.basis, cid: m.cid, op: m.op, nutzer: n });
    for (const x of Object.keys(runter)) runter[x].push({ art: 'op', version: e.v, cid: e.cid, op: e.op });
  }
  for (const [n, liste] of Object.entries(runter)) for (const m of liste.reverse().sort((a, b) => a.version - b.version)) kl[n].empfangen(m);
  for (const k of Object.values(kl)) assert.deepEqual(k.daten, server.daten);
  const d = server.daten;
  assert.equal(d.karten.k1aaaa, undefined); assert.equal(d.karten.k9aaaa.spalte, 'todo00'); assert.equal(d.karten.k2aaaa.spalte, 'todo00');
  assert.equal(d.spalten.some((s) => s.id === 'todo00'), false);
});
