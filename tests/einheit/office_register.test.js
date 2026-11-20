// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Register offener Office-Dokumente im Web-Dienst (Plan 04, Aufgabe 10): Speicherplanung (1500 ms Ruhe, spätestens
// 5000 ms), letzter Klient → sofort speichern und nach 30 s entladen, Kontextwahl beim Speichern, Außenänderungen,
// Wiederaufnahme nach Neustart über den Verlauf der Datei, Leserechte, Anwesenheitsfarben.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DokumentRegister, ANWESEND_FARBEN, SPEICHERN_RUHE_MS, SPEICHERN_MAX_MS, ENTLADEN_MS, EXTERN_PRUEFEN_MS, FEHLER_WIEDERHOLEN_MS } from '../../src/web/office/dokumente.js';

const ID = 'oAAAAAAAAAAAAAAAA';
const SETZ = (id, felder) => ({ typ: 'karte_setzen', id, felder });
const warte = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Schein-Agent: hält inhalt/stand/verlauf wie der echte Agent; Fehler je Aktion vormerkbar. */
function scheinAgent() {
  const a = {
    log: [], fehler: new Map(), inhalt: { version: 0, daten: null }, stand: 'S0', verlauf: [], gespeichert: { version: 0 },
    rechte: { anna: 'bearbeiten', ben: 'bearbeiten', cara: 'lesen' },
    aufrufe: (name) => a.log.filter((x) => x.name === name),
    naechsterFehler(name, ...codes) { if (!a.fehler.has(name)) a.fehler.set(name, []); a.fehler.get(name).push(...codes); },
    async aktion(name, params, kontext) {
      a.log.push({ name, params, kontext });
      const code = a.fehler.get(name)?.shift();
      if (code) throw Object.assign(new Error(code.code || code), typeof code === 'object' ? code : { code });
      const recht = a.rechte[kontext.nutzer];
      if (!recht) throw Object.assign(new Error('weg'), { code: 'E_NICHT_GEFUNDEN' });
      if (name === 'office.laden') return { id: ID, art: 'board', name: 'Plan', freigabe: 'team', pfad: 'Plan.fahboard', besitzer: 'anna', recht, version: a.inhalt.version, daten: a.inhalt.daten, stand: a.stand, verlauf: [...a.verlauf], schnappschuesse: false };
      if (name === 'office.recht') return { id: ID, recht, stand: a.stand };
      if (name === 'office.speichern') {
        if (recht !== 'bearbeiten') throw Object.assign(new Error('lesen'), { code: 'E_RECHTE' });
        if (params.stand !== a.stand) throw Object.assign(new Error('geändert'), { code: 'E_GEAENDERT' });
        a.inhalt = { version: params.version, daten: params.daten }; a.verlauf = [...a.verlauf, ...params.ops].slice(-500);
        a.stand = `S${params.version}`; a.gespeichert = { version: params.version };
        return { stand: a.stand };
      }
      throw new Error(`unbekannt ${name}`);
    },
  };
  return a;
}

let agent; let reg; let gesendet;
const klient = (kid, nutzer) => { gesendet[kid] = []; return { kid, kontext: { nutzer, rolle: 'nutzer', ip: '-' }, name: nutzer.toUpperCase(), senden: (o) => gesendet[kid].push(o) }; };
const opMit = (i, kid = 'k1') => ({ basis: i, cid: `${kid}-${i + 1}`, op: SETZ('k1aaaa', { titel: `T${i}` }) });

beforeEach(async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  agent = scheinAgent(); gesendet = {};
  reg = new DokumentRegister({ agent });
  await reg.oeffnen({ id: ID }, klient('k1', 'anna'));
  await reg.oeffnen({ id: ID }, klient('k2', 'ben'));
});
afterEach(() => { reg.stoppen(); mock.timers.reset(); });

test('Konstanten', () => {
  assert.deepEqual([SPEICHERN_RUHE_MS, SPEICHERN_MAX_MS, ENTLADEN_MS, EXTERN_PRUEFEN_MS, FEHLER_WIEDERHOLEN_MS], [1500, 5000, 30_000, 30_000, 10_000]);
  assert.deepEqual([...ANWESEND_FARBEN], ['#d14b4b', '#2f7fd1', '#2f9e5b', '#b5651d', '#8a4fd1', '#c2407f', '#13877f', '#6b7280']);
  assert.equal(agent.aufrufe('office.laden').length, 1, 'zweites Öffnen lädt nicht neu');
  assert.deepEqual(agent.aufrufe('office.recht').at(-1).params, { id: ID, merken: true });
});

test('Speichern 1500 ms nach der letzten Op, spätestens 5000 ms nach der ersten', async () => {
  for (let i = 0; i < 6; i++) { reg.op(ID, 'k1', opMit(i)); mock.timers.tick(1000); }
  assert.equal(agent.aufrufe('office.speichern').length, 1); // bei 5000 ms trotz Dauertippen
  await warte();
  mock.timers.tick(1500); await warte();
  assert.equal(agent.aufrufe('office.speichern').length, 2);
  assert.deepEqual(gesendet.k1.at(-1), { art: 'gespeichert', dok: ID, version: 6, zeit: gesendet.k1.at(-1).zeit });
  assert.deepEqual(gesendet.k2.filter((m) => m.art === 'op').map((m) => [m.version, m.von, m.cid]), [1, 2, 3, 4, 5, 6].map((v) => [v, 'k1', `k1-${v}`]));
  const s = agent.aufrufe('office.speichern').at(-1).params;
  assert.deepEqual([s.id, s.version, s.ops.map((o) => o.v), s.stand], [ID, 6, [6], 'S5']);
  assert.equal(agent.aufrufe('office.speichern')[0].kontext.nutzer, 'anna', 'Kontext des letzten Autors');
});

test('letzter Klient weg → sofort speichern, nach 30 s entladen', async () => {
  reg.op(ID, 'k1', opMit(0));
  reg.schliessen(ID, 'k1');
  assert.equal(agent.aufrufe('office.speichern').length, 0, 'noch jemand da');
  reg.schliessen(ID, 'k2');
  await warte();
  assert.equal(agent.aufrufe('office.speichern').length, 1, 'sofort');
  mock.timers.tick(ENTLADEN_MS - 1); assert.equal(reg.offen.has(ID), true);
  mock.timers.tick(1); assert.equal(reg.offen.has(ID), false);
  await reg.oeffnen({ id: ID }, klient('k3', 'anna'));
  assert.equal(agent.aufrufe('office.laden').length, 2, 'danach neu geladen');
});

test('Kontext des letzten Autors; E_RECHTE → nächster Bearbeiter; keiner → speicherfehler an alle, Wiederholung nach 10 s', async () => {
  reg.op(ID, 'k2', opMit(0, 'k2'));
  agent.naechsterFehler('office.speichern', 'E_RECHTE');
  mock.timers.tick(SPEICHERN_RUHE_MS); await warte();
  assert.deepEqual(agent.aufrufe('office.speichern').map((x) => x.kontext.nutzer), ['ben', 'anna']);
  assert.equal(agent.gespeichert.version, 1);
  reg.op(ID, 'k2', { basis: 1, cid: 'k2-2', op: SETZ('k1aaaa', { titel: 'x' }) });
  agent.naechsterFehler('office.speichern', 'E_RECHTE', 'E_RECHTE');
  mock.timers.tick(SPEICHERN_RUHE_MS); await warte();
  assert.equal(gesendet.k1.at(-1).art, 'speicherfehler'); assert.equal(gesendet.k2.at(-1).art, 'speicherfehler');
  assert.equal(gesendet.k1.at(-1).fehler.code, 'E_RECHTE');
  mock.timers.tick(FEHLER_WIEDERHOLEN_MS - 1); await warte();
  assert.equal(agent.gespeichert.version, 1);
  mock.timers.tick(1); await warte();
  assert.equal(agent.gespeichert.version, 2); assert.equal(gesendet.k1.at(-1).art, 'gespeichert');
  agent.naechsterFehler('office.speichern', 'E_PLATZ');
  reg.op(ID, 'k1', { basis: 2, cid: 'k1-9', op: SETZ('k1aaaa', { titel: 'y' }) });
  mock.timers.tick(SPEICHERN_RUHE_MS); await warte();
  assert.equal(gesendet.k1.at(-1).fehler.code, 'E_PLATZ', 'andere Fehler ebenso');
  mock.timers.tick(FEHLER_WIEDERHOLEN_MS); await warte();
  assert.equal(agent.gespeichert.version, 3);
});

test('extern: E_GEAENDERT → neu laden, {art:"extern"} an alle, Datei nicht überschrieben', async () => {
  agent.naechsterFehler('office.speichern', 'E_GEAENDERT');
  reg.op(ID, 'k1', opMit(0)); mock.timers.tick(SPEICHERN_RUHE_MS); await warte();
  assert.deepEqual([gesendet.k1.at(-1), gesendet.k2.at(-1)], [{ art: 'extern', dok: ID }, { art: 'extern', dok: ID }]);
  assert.equal(agent.aufrufe('office.laden').length, 2); assert.equal(agent.gespeichert.version, 0);
  assert.equal(reg.offen.get(ID).dok.version, 0, 'frischer Stand aus der Datei');
  assert.equal(reg.offen.get(ID).dok.ungespeichert().length, 0);
});

test('extern ohne eigenes Speichern: Prüfung alle 30 s über office.recht', async () => {
  const vorher = agent.aufrufe('office.recht').length;
  mock.timers.tick(EXTERN_PRUEFEN_MS); await warte();
  assert.equal(agent.aufrufe('office.recht').length, vorher + 1);
  assert.equal(gesendet.k1.some((m) => m.art === 'extern'), false, 'gleicher Stand: nichts');
  agent.stand = 'S-extern'; agent.inhalt = { version: 4, daten: null };
  mock.timers.tick(EXTERN_PRUEFEN_MS); await warte();
  assert.deepEqual(gesendet.k2.at(-1), { art: 'extern', dok: ID });
  assert.equal(reg.offen.get(ID).dok.version, 4);
});

test('Wiederaufnahme nach Neustart über verlauf.ndjson', async () => {
  reg.op(ID, 'k1', opMit(0));
  await reg.alleSpeichern();
  assert.deepEqual(agent.verlauf.map((e) => [e.v, e.cid]), [[1, 'k1-1']]);
  reg.stoppen();
  const neu = new DokumentRegister({ agent });
  const w = await neu.wiederaufnehmen({ id: ID }, 0, klient('k7', 'anna'));
  assert.deepEqual(w, { art: 'wiederaufgenommen', dok: ID, kid: 'k7', version: 1, ops: [{ v: 1, op: SETZ('k1aaaa', { titel: 'T0' }), cid: 'k1-1' }] });
  assert.deepEqual(await neu.wiederaufnehmen({ id: ID }, 5, klient('k8', 'anna')), { art: 'neu_laden', dok: ID, grund: 'version' });
  neu.stoppen();
  agent.inhalt = { version: 9, daten: null }; agent.verlauf = [{ v: 8, op: SETZ('k1aaaa', { titel: 'x' }), cid: 'q-1' }, { v: 9, op: SETZ('k1aaaa', { titel: 'y' }), cid: 'q-2' }];
  const drei = new DokumentRegister({ agent });
  assert.deepEqual(await drei.wiederaufnehmen({ id: ID }, 3, klient('k9', 'anna')), { art: 'neu_laden', dok: ID, grund: 'zu_alt' });
  drei.stoppen();
});

test('Leser darf keine Op senden', async () => {
  await reg.oeffnen({ id: ID }, klient('k3', 'cara'));
  reg.op(ID, 'k3', { basis: 0, cid: 'k3-1', op: SETZ('k1aaaa', { titel: 'x' }) });
  assert.deepEqual(gesendet.k3.at(-1), { art: 'fehler', dok: ID, cid: 'k3-1', fehler: { code: 'E_RECHTE', meldung: 'Du darfst dieses Dokument nur lesen' } });
  assert.equal(reg.offen.get(ID).dok.version, 0);
  reg.op(ID, 'k1', { basis: 0, cid: 'k1-1', op: { typ: 'karte_setzen', id: 'k1aaaa', felder: { boese: 1 } } });
  assert.equal(gesendet.k1.at(-1).fehler.code, 'E_PARAMS', 'kaputte Op → fehler mit cid');
  assert.equal(gesendet.k1.at(-1).cid, 'k1-1');
});

test('Anwesenheit: Farben in Reihenfolge, frei nach Verlassen', async () => {
  const r3 = await reg.oeffnen({ id: ID }, klient('k3', 'cara'));
  assert.equal(r3.farbe, '#2f9e5b');
  assert.deepEqual(gesendet.k1.at(-1), { art: 'anwesend', dok: ID, liste: [{ kid: 'k1', nutzer: 'anna', name: 'ANNA', farbe: '#d14b4b' }, { kid: 'k2', nutzer: 'ben', name: 'BEN', farbe: '#2f7fd1' }, { kid: 'k3', nutzer: 'cara', name: 'CARA', farbe: '#2f9e5b' }] });
  reg.schliessen(ID, 'k2');
  assert.deepEqual(gesendet.k3.at(-1).liste.map((x) => x.kid), ['k1', 'k3']);
  const r4 = await reg.oeffnen({ id: ID }, klient('k4', 'anna'));
  assert.equal(r4.farbe, '#2f7fd1', 'erste freie Farbe');
  reg.auswahl(ID, 'k1', { version: 0, auswahl: { karte: 'k1aaaa' } });
  assert.deepEqual(gesendet.k3.at(-1), { art: 'auswahl', dok: ID, von: 'k1', nutzer: 'anna', name: 'ANNA', farbe: '#d14b4b', version: 0, auswahl: { karte: 'k1aaaa' } });
  assert.equal(gesendet.k1.at(-1).art === 'auswahl', false, 'nicht an sich selbst');
});

test('Rechte, Umbenennen, Löschen aus Agent-Ereignissen', async () => {
  await reg.oeffnen({ id: ID }, klient('k3', 'cara'));
  agent.rechte.ben = 'lesen'; agent.rechte.cara = undefined;
  await reg.rechtePruefen(ID);
  assert.deepEqual(gesendet.k2.findLast((m) => m.art === 'recht'), { art: 'recht', dok: ID, recht: 'lesen' });
  assert.equal(gesendet.k3.at(-1).art, 'fehler'); assert.equal(gesendet.k3.at(-1).fehler.code, 'E_RECHTE');
  assert.deepEqual([...reg.offen.get(ID).klienten.keys()], ['k1', 'k2'], 'ohne Recht geschlossen');
  reg.pfadGeaendert(ID, { name: 'Q4', pfad: 'Neu/Q4.fahboard' });
  assert.deepEqual(gesendet.k1.at(-1), { art: 'umbenannt', dok: ID, name: 'Q4', pfad: 'Neu/Q4.fahboard' });
  assert.deepEqual([reg.offen.get(ID).dok.meta.name, reg.offen.get(ID).dok.meta.pfad], ['Q4', 'Neu/Q4.fahboard']);
  reg.geloescht(ID);
  assert.deepEqual(gesendet.k1.at(-1), { art: 'neu_laden', dok: ID, grund: 'geloescht' });
  assert.equal(reg.offen.has(ID), false);
});

// ---- Prüfbericht Plan 04 (I1, I3, I4, I6, I9) -------------------------------------------------------------------------

test('Prüfbericht I1: Pfad in eine andere Freigabe → Rechte neu, wer nichts mehr darf, fliegt raus und erfährt den Ort nicht', async () => {
  agent.rechte.ben = undefined; // in der neuen Freigabe darf ben nichts
  await reg.pfadGeaendert(ID, { name: 'Plan', pfad: 'Geheim/Plan.fahboard', freigabe: 'privat' });
  assert.equal(gesendet.k2.filter((m) => m.art === 'umbenannt').length, 0, 'ben erfährt den neuen Ort nicht');
  assert.equal(gesendet.k2.at(-1).fehler.code, 'E_RECHTE');
  assert.deepEqual(gesendet.k1.at(-1), { art: 'umbenannt', dok: ID, name: 'Plan', pfad: 'Geheim/Plan.fahboard' });
  reg.op(ID, 'k1', opMit(0));
  assert.equal(gesendet.k2.filter((m) => m.art === 'op').length, 0, 'keine Ops mehr an ben');
});

test('Prüfbericht I1: alleRechtePruefen und E_RECHTE beim Speichern prüfen die Rechte neu', async () => {
  agent.rechte.ben = 'lesen';
  await reg.alleRechtePruefen();
  assert.deepEqual(gesendet.k2.at(-1), { art: 'recht', dok: ID, recht: 'lesen' });
  agent.rechte.ben = 'bearbeiten';
  await reg.alleRechtePruefen();
  reg.op(ID, 'k2', { basis: 0, cid: 'k2-1', op: SETZ('k1aaaa', { titel: 'ben' }) });
  agent.rechte.ben = 'lesen'; // ohne Ereignis entzogen
  await reg.speichern(ID); await warte();
  assert.deepEqual(agent.aufrufe('office.speichern').map((x) => x.kontext.nutzer), ['ben', 'anna']);
  assert.deepEqual(gesendet.k2.filter((m) => m.art === 'recht').at(-1), { art: 'recht', dok: ID, recht: 'lesen' }, 'ben erfährt es sofort');
});

test('Prüfbericht I3: Abschluss speichert auch, was während eines laufenden Speicherns kam, und nimmt danach nichts mehr an', async () => {
  reg.op(ID, 'k1', opMit(0));
  let loesen = null;
  const orig = agent.aktion;
  agent.aktion = async (name, p, k) => { if (name === 'office.speichern' && !loesen) await new Promise((r) => { loesen = r; }); return orig.call(agent, name, p, k); };
  const s1 = reg.speichern(ID);
  await warte();
  reg.op(ID, 'k1', opMit(1)); // kommt während des Speicherns
  const fertig = reg.alleSpeichern();
  await warte();
  reg.op(ID, 'k2', { basis: 2, cid: 'k2-spaet', op: SETZ('k1aaaa', { titel: 'spät' }) }); // nach Beginn des Abschlusses
  loesen();
  await fertig; await s1;
  assert.equal(agent.aufrufe('office.speichern').length, 2);
  assert.equal(agent.inhalt.version, 2);
  assert.equal(gesendet.k2.filter((m) => m.cid === 'k2-spaet').length, 0, 'späte Op weder angewandt noch bestätigt');
  assert.equal(reg.offen.get(ID).dok.version, 2);
});

test('Prüfbericht I4: ungültige cid → E_PARAMS an den Absender, nichts angenommen', () => {
  for (const cid of ['x'.repeat(65), undefined, 42, '']) {
    reg.op(ID, 'k1', { basis: 0, cid, op: SETZ('k1aaaa', { titel: 'x' }) });
    assert.equal(gesendet.k1.at(-1).fehler.code, 'E_PARAMS', String(cid).slice(0, 10));
  }
  assert.equal(reg.offen.get(ID).dok.version, 0);
  assert.equal(gesendet.k2.filter((m) => m.art === 'op').length, 0);
});

test('Prüfbericht I6: Bündel verschwunden (Speichern) → neu_laden „verschoben“ an alle, Dokument entladen', async () => {
  reg.op(ID, 'k1', opMit(0));
  agent.naechsterFehler('office.speichern', { code: 'E_NICHT_GEFUNDEN', details: { office: 'verschoben' } });
  await reg.speichern(ID); await warte();
  assert.deepEqual(gesendet.k1.at(-1), { art: 'neu_laden', dok: ID, grund: 'verschoben' });
  assert.deepEqual(gesendet.k2.at(-1), { art: 'neu_laden', dok: ID, grund: 'verschoben' });
  assert.equal(reg.offen.has(ID), false);
  assert.equal(reg.op(ID, 'k1', opMit(1)), false, 'unbekannter Klient → false (der Dienst meldet es)');
  mock.timers.tick(20_000); await warte();
  assert.equal(agent.aufrufe('office.speichern').length, 1, 'kein endloses Wiederholen');
});

test('Prüfbericht I6: Außenprüfung findet das Bündel nicht mehr → ebenso; fehlendes Recht des Prüfenden entlädt nicht', async () => {
  agent.naechsterFehler('office.recht', { code: 'E_NICHT_GEFUNDEN' }); // nur kein Recht des ersten Klienten
  mock.timers.tick(30_000); await warte();
  assert.ok(reg.offen.has(ID), 'ohne office-Detail bleibt das Dokument offen');
  agent.naechsterFehler('office.recht', { code: 'E_NICHT_GEFUNDEN', details: { office: 'geloescht' } });
  mock.timers.tick(30_000); await warte();
  assert.equal(gesendet.k1.at(-1).grund, 'verschoben');
  assert.equal(reg.offen.has(ID), false);
});

test('Prüfbericht I9: Öffnen während des Entladens hängt den Klienten nicht an einen toten Eintrag', async () => {
  reg.schliessen(ID, 'k1'); reg.schliessen(ID, 'k2'); // Entladen in 30 s geplant
  let loesen = null;
  const orig = agent.aktion;
  agent.aktion = async (name, p, k) => { if (name === 'office.recht' && !loesen) await new Promise((r) => { loesen = r; }); return orig.call(agent, name, p, k); };
  const p = reg.oeffnen({ id: ID }, klient('k3', 'cara'));
  await warte();
  mock.timers.tick(30_000); await warte();
  loesen(); await p;
  assert.ok(reg.offen.get(ID), 'Dokument offen');
  assert.ok(reg.offen.get(ID).klienten.has('k3'), 'Klient im lebenden Eintrag');
});
