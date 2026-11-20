// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fällige Karten (Plan 04, Aufgabe 6): Auswahl je Nutzer, Rechte ohne Admin-Sonderrecht, Zwischenspeicher 300 s,
// Morgen-Meldung um 08:00 (je Nutzer eine, Schalter faellig_push), Zeitgeber startet/stoppt.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { officeUmgebung } from './office_hilfen.js';
import { faelligeKarten, msBisAcht, datumOrt, faelligVergessen, morgenlauf } from '../../src/agent/office/faellig.js';

let e;
beforeEach(async () => { faelligVergessen(); e = await officeUmgebung(); });
afterEach(async () => { await e.aufraeumen(); });

const karte = (id, titel, zustaendig, faellig, archiviert = false) => ({ id, titel, zustaendig, faellig, archiviert });
async function board(nutzer, freigabe, name, karten) {
  const { id } = await e.als(nutzer)('office.anlegen', { art: 'board', freigabe, ordner: '', name });
  const d = await e.als(nutzer)('office.laden', { id });
  await e.als(nutzer)('office.speichern', { id, version: 1, daten: { spalten: [], etiketten: {}, karten: Object.fromEntries(karten.map((k) => [k.id, k])) }, ops: [], stand: d.stand });
  return id;
}
async function einstellungen(werte) {
  await e.u.konfig.aendern('users.json', (u) => { for (const n of u.nutzer) if (werte[n.name]) n.einstellungen = werte[n.name]; return u; });
}

test('faelligeKarten: zuständig, fällig bis heute, nicht archiviert', () => {
  const daten = { spalten: [], etiketten: {}, karten: {
    k1aaaa: karte('k1aaaa', 'B', ['anna'], '2026-10-18'), k2aaaa: karte('k2aaaa', 'A', ['anna'], '2026-10-10'),
    k3aaaa: karte('k3aaaa', 'C', ['ben'], '2026-10-18'), k4aaaa: karte('k4aaaa', 'D', ['anna'], '2026-10-19'),
    k5aaaa: karte('k5aaaa', 'E', ['anna'], '2026-10-01', true), k6aaaa: karte('k6aaaa', 'F', ['anna'], null),
    k7aaaa: karte('k7aaaa', 'G', ['anna'], 'morgen') } };
  assert.deepEqual(faelligeKarten(daten, 'anna', '2026-10-18'), [
    { karte_id: 'k2aaaa', titel: 'A', faellig: '2026-10-10', ueberfaellig: true },
    { karte_id: 'k1aaaa', titel: 'B', faellig: '2026-10-18', ueberfaellig: false },
  ]);
  assert.deepEqual(faelligeKarten(null, 'anna', '2026-10-18'), []);
  assert.deepEqual(faelligeKarten({ karten: { x: null } }, 'anna', '2026-10-18'), []);
});

test('msBisAcht und datumOrt', () => {
  assert.equal(msBisAcht(new Date(2026, 9, 18, 7, 30)), 30 * 60_000);
  assert.equal(msBisAcht(new Date(2026, 9, 18, 8, 0, 0, 0)), 24 * 3600_000);
  assert.equal(msBisAcht(new Date(2026, 9, 18, 23, 0)), 9 * 3600_000);
  assert.equal(datumOrt(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('fällig ohne Sonderrecht: Admin sieht keine fremden Karten', async () => {
  const P = await board('anna', 'privat', 'Privat', [karte('k1aaaa', 'Steuer', ['chef'], '2026-10-18')]);
  assert.deepEqual(await e.als('chef', 'admin')('office.faellig', {}), { karten: [] });
  await e.als('anna')('office.freigeben', { id: P, nutzer: 'chef', recht: 'lesen' });
  assert.deepEqual(await e.als('chef', 'admin')('office.faellig', {}), { karten: [{ board_id: P, board_name: 'Privat', karte_id: 'k1aaaa', titel: 'Steuer', faellig: '2026-10-18', ueberfaellig: false }] });
});

test('Zwischenspeicher 300 s; Speichern eines Boards leert ihn', async () => {
  const T = await board('anna', 'team', 'Team', [karte('k1aaaa', 'Eins', ['ben'], '2026-10-17')]);
  assert.equal((await e.als('ben')('office.faellig', {})).karten.length, 1);
  const n = e.ids.length;
  assert.equal((await e.als('ben')('office.faellig', {})).karten.length, 1);
  assert.equal(e.ids.length, n, 'zweiter Aufruf liest kein Board');
  e.jetzt.wert += 300_001;
  await e.als('ben')('office.faellig', {});
  assert.ok(e.ids.length > n, 'nach 300 s wird neu gelesen');
  const d = await e.als('anna')('office.laden', { id: T });
  await e.als('anna')('office.speichern', { id: T, version: 2, daten: { spalten: [], etiketten: {}, karten: {} }, ops: [], stand: d.stand });
  assert.deepEqual(await e.als('ben')('office.faellig', {}), { karten: [] }, 'nach dem Speichern sofort aktuell');
});

test('morgenlauf: je Nutzer eine Meldung mit Anzahl und Schlüssel, ohne Fälliges keine', async () => {
  await board('anna', 'team', 'Team', [
    karte('k1aaaa', 'Heute', ['anna'], '2026-10-18'), karte('k2aaaa', 'Alt', ['anna'], '2026-10-01'),
    karte('k3aaaa', 'Ben', ['ben'], '2026-10-18'), karte('k4aaaa', 'Cara', ['cara'], '2026-10-18'),
  ]);
  const an = { benachrichtigung: { aktiv: true, thema: 'fahnas-test' } };
  await einstellungen({ anna: an, ben: { ...an, office: { faellig_push: false } }, chef: an, cara: { benachrichtigung: { aktiv: false, thema: 'x' } } });
  const r = await morgenlauf(e.w, new Date(2026, 9, 18, 8, 0));
  assert.equal(r.gesendet, 1);
  assert.deepEqual(e.push, [{ nutzer: 'anna', titel: 'FAH-NAS Office', text: '2 Karten heute fällig', schluessel: 'faellig:anna:2026-10-18' }]);
  await einstellungen({ ben: an });
  faelligVergessen();
  await morgenlauf(e.w, new Date(2026, 9, 18, 8, 0));
  assert.deepEqual(e.push.at(-1), { nutzer: 'ben', titel: 'FAH-NAS Office', text: '1 Karte heute fällig', schluessel: 'faellig:ben:2026-10-18' });
});

test('starten plant den Lauf auf 08:00, stoppen löscht den Zeitgeber', async () => {
  const office = await import('../../src/agent/aktionen/office.js');
  const vorher = globalThis.setTimeout; const geplant = [];
  globalThis.setTimeout = (fn, ms) => { geplant.push(ms); return { unref() {}, ref() {}, [Symbol.toPrimitive]: () => 0 }; };
  const geloescht = []; const vorherClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (t) => { geloescht.push(t); };
  try {
    await office.starten(e.w);
    assert.equal(geplant.length, 1); assert.ok(geplant[0] > 0 && geplant[0] <= 24 * 3600_000);
    await office.stoppen();
    assert.equal(geloescht.length, 1);
  } finally { globalThis.setTimeout = vorher; globalThis.clearTimeout = vorherClear; }
});
