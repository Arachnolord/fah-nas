// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests der Grundlage: Schema, Pfade, Konfig, Register, Aufgaben, Agent-Socket Ende-zu-Ende.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruefe, R } from '../../src/gemeinsam/schema.js';
import { relativerPfad, sicherAufloesen, pruefeDateiname } from '../../src/gemeinsam/pfade.js';
import { Konfig, UNVERAENDERT } from '../../src/gemeinsam/konfig.js';
import { kennung, MAX_ZEILE } from '../../src/gemeinsam/protokoll.js';
import { Register } from '../../src/agent/register.js';
import { Aufgaben } from '../../src/agent/aufgaben.js';
import { Audit, parameterKuerzen } from '../../src/agent/audit.js';
import { Agent, fehlerFuerRolle } from '../../src/agent/agent.js';
import { AgentClient } from '../../src/web/agentclient.js';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-')); }

test('schema: Pflicht, Typ, Muster, unbekannte Felder, Standardwerte', () => {
  const s = { name: R.nutzername, aktiv: { typ: 'boolean', standard: true }, anzahl: { typ: 'integer', min: 1, max: 5 } };
  assert.deepEqual(pruefe(s, { name: 'fabian' }), { name: 'fabian', aktiv: true });
  assert.throws(() => pruefe(s, {}), (e) => e.code === 'E_PARAMS' && e.details.feld === 'name');
  assert.throws(() => pruefe(s, { name: 'Fabian' }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pruefe(s, { name: 'fabian', anzahl: 1.5 }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pruefe(s, { name: 'fabian', anzahl: 9 }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pruefe(s, { name: 'fabian', schmuggel: 1 }), (e) => e.code === 'E_PARAMS');
  assert.deepEqual(pruefe({ l: R.liste_namen }, { l: ['a1', '@gruppe'] }), { l: ['a1', '@gruppe'] });
  assert.throws(() => pruefe({ l: R.liste_namen }, { l: ['../x'] }), (e) => e.code === 'E_PARAMS');
  // Punkte im Nutzernamen (m.mustermann), aber nie am Anfang/Ende/doppelt und nicht in @Gruppen
  for (const n of ['m.mustermann', 'max.mustermann', 'a.b.c', 'm.w-1']) assert.equal(pruefe(s, { name: n }).name, n);
  for (const n of ['.mw', 'mw.', 'm..w', '..', 'm./x', 'm.mustermann', 'm.-w', 'a', `m.${'w'.repeat(30)}`]) assert.throws(() => pruefe(s, { name: n }), (e) => e.code === 'E_PARAMS', n);
  assert.deepEqual(pruefe({ l: R.liste_namen }, { l: ['m.mustermann'] }), { l: ['m.mustermann'] });
  for (const n of ['@m.mustermann', 'm..w', '.x']) assert.throws(() => pruefe({ l: R.liste_namen }, { l: [n] }), (e) => e.code === 'E_PARAMS', n);
});

test('pfade: relativer Pfad wird bereinigt, .. abgelehnt, Symlink-Flucht erkannt', async () => {
  assert.equal(relativerPfad('/a//b/./c/'), 'a/b/c');
  assert.equal(relativerPfad(''), '');
  assert.throws(() => relativerPfad('a/../../etc'), (e) => e.code === 'E_PARAMS');
  assert.throws(() => relativerPfad('a\u0000b'), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pruefeDateiname('a/b'), (e) => e.code === 'E_PARAMS');
  const w = await tmp();
  await fs.mkdir(path.join(w, 'share/ordner'), { recursive: true });
  await fs.symlink('/etc', path.join(w, 'share/flucht'));
  assert.equal(await sicherAufloesen(path.join(w, 'share'), 'ordner/neu.txt'), path.join(await fs.realpath(w), 'share/ordner/neu.txt'));
  await assert.rejects(sicherAufloesen(path.join(w, 'share'), 'flucht/passwd'), (e) => e.code === 'E_RECHTE');
  await assert.rejects(sicherAufloesen(path.join(w, 'share'), 'flucht'), (e) => e.code === 'E_RECHTE');
});

test('konfig: Standardwerte, atomares Speichern, kaputtes JSON', async () => {
  const w = await tmp();
  const k = new Konfig(w);
  await k.sicherstellen();
  const sys = await k.laden('system.json');
  assert.equal(sys.hostname, 'fahnas');
  await k.aendern('system.json', (d) => { d.hostname = 'box'; });
  assert.equal((await k.laden('system.json')).hostname, 'box');
  assert.equal((await fs.readdir(w)).filter((n) => n.endsWith('.tmp')).length, 0);
  await fs.writeFile(path.join(w, 'shares.json'), '{kaputt');
  await assert.rejects(k.laden('shares.json'), (e) => e.code === 'E_KONFIG');
  assert.throws(() => k.pfad('../x.json'), (e) => e.code === 'E_KONFIG');
});

test('konfig: aendern läuft komplett in der Kette – fünf parallele Änderungen gehen nicht verloren (P1a); Fehler schreibt nichts; UNVERAENDERT schreibt nichts', async () => {
  const w = await tmp();
  const k = new Konfig(w);
  await k.speichern('x.json', { liste: [] });
  await Promise.all([1, 2, 3, 4, 5].map((i) => k.aendern('x.json', async (o) => { await new Promise((r) => setTimeout(r, 5)); o.liste.push(i); })));
  assert.deepEqual((await k.laden('x.json')).liste.sort(), [1, 2, 3, 4, 5]);
  // aendern parallel zu speichern: speichern reiht sich ein, überschreibt aber keinen späteren aendern-Schritt
  await Promise.all([k.aendern('x.json', (o) => { o.liste.push(6); }), k.speichern('x.json', { liste: [0] }), k.aendern('x.json', (o) => { o.liste.push(7); })]);
  assert.deepEqual((await k.laden('x.json')).liste, [0, 7]);
  await assert.rejects(k.aendern('x.json', () => { throw new FahnasFehler('E_PARAMS', 'nein'); }), (e) => e.code === 'E_PARAMS');
  assert.deepEqual((await k.laden('x.json')).liste, [0, 7], 'Fehler in der Änderungsfunktion schreibt nichts');
  const vorher = (await fs.stat(path.join(w, 'x.json'))).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  await k.aendern('x.json', () => UNVERAENDERT);
  assert.equal((await fs.stat(path.join(w, 'x.json'))).mtimeMs, vorher, 'UNVERAENDERT schreibt nicht');
  // Kette lebt nach einem Fehler weiter
  await k.aendern('x.json', (o) => { o.liste.push(8); });
  assert.deepEqual((await k.laden('x.json')).liste, [0, 7, 8]);
});

test('konfig: MODUS-Tabelle gilt für speichern UND aendern (users.json/links.json 0600, Rest 0640); liegen gebliebene tmp vererbt keinen Modus (P7)', async () => {
  const w = await tmp();
  const k = new Konfig(w);
  await k.speichern('links.json', [{ token: 'T' }]);
  assert.equal(((await fs.stat(path.join(w, 'links.json'))).mode & 0o777), 0o600);
  await k.aendern('links.json', (l) => l, []);
  assert.equal(((await fs.stat(path.join(w, 'links.json'))).mode & 0o777), 0o600);
  await k.speichern('users.json', { nutzer: [], gruppen: [] });
  assert.equal(((await fs.stat(path.join(w, 'users.json'))).mode & 0o777), 0o600);
  await k.speichern('system.json', { hostname: 'x' });
  assert.equal(((await fs.stat(path.join(w, 'system.json'))).mode & 0o777), 0o640);
  // tmp-Datei aus einem „Absturz“ mit falschem Modus liegt herum → wird ersetzt, nicht übernommen
  await fs.writeFile(path.join(w, `users.json.${process.pid}.tmp`), 'alt', { mode: 0o666 });
  await k.speichern('users.json', { nutzer: [{ name: 'a' }], gruppen: [] });
  assert.equal(((await fs.stat(path.join(w, 'users.json'))).mode & 0o777), 0o600);
  assert.equal((await fs.readdir(w)).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('kennung: aus crypto.randomBytes – 16 Zeichen base64url je Kennung, keine Wiederholung', () => {
  const alle = new Set();
  for (let i = 0; i < 2000; i++) { const k = kennung('k-'); assert.match(k, /^k-[A-Za-z0-9_-]{16}$/); alle.add(k); }
  assert.equal(alle.size, 2000);
  assert.equal(kennung().length, 16);
});

test('fehlerFuerRolle: nutzer sieht nur harmlose Details, admin alles (R1 Fund 14)', () => {
  const f = new FahnasFehler('E_SYSTEM', 'kaputt', { befehl: 'btrfs subvolume delete /data/shares/x', ausgabe: 'stderr…', pfad: '/data/shares/x', code: 1, feld: 'pfad', frei: 12 }).toJSON();
  assert.deepEqual(fehlerFuerRolle(f, 'nutzer'), { code: 'E_SYSTEM', meldung: 'kaputt', details: { feld: 'pfad', frei: 12 } });
  assert.deepEqual(fehlerFuerRolle(f, 'gast'), { code: 'E_SYSTEM', meldung: 'kaputt', details: { feld: 'pfad', frei: 12 } });
  assert.deepEqual(fehlerFuerRolle(f, 'admin'), f);
  assert.deepEqual(fehlerFuerRolle(f, 'system'), f);
  assert.deepEqual(fehlerFuerRolle(new FahnasFehler('E_UNBEKANNT', 'x', { grund: 'ENOENT /etc/x' }).toJSON(), 'nutzer'), { code: 'E_UNBEKANNT', meldung: 'x' });
  assert.deepEqual(fehlerFuerRolle(new FahnasFehler('E_PARAMS', 'x').toJSON(), 'nutzer'), { code: 'E_PARAMS', meldung: 'x' });
});

test('audit: Aufbewahrung löscht alte Monatsdateien, Lesen zeilenweise, überlange Parameter werden gekürzt', async () => {
  const w = await tmp();
  const a = new Audit(w);
  for (const m of ['2025-01', '2025-09', '2026-08', '2026-09']) await fs.writeFile(path.join(w, `audit-${m}.jsonl`), JSON.stringify({ zeit: `${m}-15T10:00:00.000Z`, nutzer: 'x', aktion: 'a.b', ok: true }) + '\n');
  await fs.writeFile(path.join(w, 'notiz.txt'), 'bleibt');
  const weg = await a.aufraeumen(2, new Date('2026-09-25T00:00:00Z'));
  assert.deepEqual(weg.sort(), ['audit-2025-01.jsonl', 'audit-2025-09.jsonl']);
  assert.deepEqual((await fs.readdir(w)).sort(), ['audit-2026-08.jsonl', 'audit-2026-09.jsonl', 'notiz.txt']);
  assert.deepEqual(await a.aufraeumen(12, new Date('2026-09-25T00:00:00Z')), []);
  const r = await a.lesen({});
  assert.equal(r.gesamt, 2); assert.equal(r.eintraege[0].zeit, '2026-09-15T10:00:00.000Z');
  // Parameter-Deckel: Pfadliste mit 1000 langen Einträgen landet als Zusammenfassung im Protokoll
  const gross = parameterKuerzen({ freigabe: 'medien', pfade: Array.from({ length: 1000 }, (_, i) => `ordner/${'x'.repeat(200)}/${i}`) });
  assert.equal(gross._gekuerzt, true); assert.equal(gross.felder.freigabe, 'medien'); assert.equal(gross.felder.pfade, '[1000 Einträge]');
  assert.deepEqual(parameterKuerzen({ a: 1 }), { a: 1 });
  await a.eintrag({ nutzer: 'x', aktion: 'dateien.loeschen', params: { pfade: Array.from({ length: 1000 }, (_, i) => `p/${'y'.repeat(200)}/${i}`) }, ok: true, dauer_ms: 1 });
  const e = (await a.lesen({ aktion: 'dateien.loeschen' })).eintraege[0];
  assert.equal(e.params._gekuerzt, true);
});

test('aufgaben: Zustandsdatei spiegelt die Liste; offene Aufgaben werden nach „Neustart“ als abgebrochen übernommen und gemeldet (R1 Fund 12)', async () => {
  let gespeichert = null;
  const ablage = { laden: async () => gespeichert ?? [], speichern: async (l) => { gespeichert = structuredClone(l); } };
  const e1 = [];
  const a = new Aufgaben((e) => e1.push(e), 1, ablage);
  let freigeben;
  const id1 = a.einstellen({ aktion: 'dateien.kopieren', nutzer: 'lisa', rolle: 'nutzer', arbeit: () => new Promise((r) => { freigeben = r; }) });
  const id2 = a.einstellen({ aktion: 'system.import', nutzer: 'chef', rolle: 'admin', arbeit: async () => 'nie' });
  await a.gespeichert();
  assert.deepEqual(gespeichert.map((x) => [x.id, x.status, x.rolle]).sort(), [[id1, 'laeuft', 'nutzer'], [id2, 'wartet', 'admin']].sort());
  assert.ok(gespeichert.every((x) => x._arbeit === undefined && x._abbruch === undefined), 'nur die Ansicht wird gespiegelt');
  // „Neustart“: neue Instanz liest die Datei
  const e2 = [];
  const b = new Aufgaben((e) => e2.push(e), 1, ablage);
  const abgebrochen = await b.wiederherstellen();
  assert.deepEqual(abgebrochen.sort(), [id1, id2].sort());
  for (const id of [id1, id2]) {
    const x = b.hole(id);
    assert.equal(x.status, 'abgebrochen'); assert.equal(x.fehler.code, 'E_ABGEBROCHEN'); assert.ok(x.beendet); assert.match(x.meldung, /neu gestartet/);
    assert.ok(e2.some((e) => e.ereignis === 'aufgabe' && e.aufgabe === id && e.status === 'abgebrochen'), 'Ereignis je abgebrochener Aufgabe');
  }
  await b.gespeichert();
  assert.ok(gespeichert.every((x) => x.status === 'abgebrochen'));
  // Liste seitenweise
  assert.equal(b.liste({ seite: 1, je_seite: 1 }).length, 1); assert.equal(b.liste({ seite: 3, je_seite: 1 }).length, 0); assert.equal(b.liste().length, 2);
  freigeben('egal'); await new Promise((r) => setTimeout(r, 10));
  // ohne Ablage: alles wie bisher
  const c = new Aufgaben(() => {}, 1);
  assert.deepEqual(await c.wiederherstellen(), []);
});

test('register: Rolle und Schema werden vor der Ausführung geprüft', () => {
  const r = new Register();
  r.aktion('test.tun', { rolle: 'admin', schema: { n: { typ: 'string', pflicht: true } }, ausfuehren: async () => 1 });
  assert.throws(() => r.vorbereiten('test.tun', { n: 'x' }, { rolle: 'nutzer' }), (e) => e.code === 'E_RECHTE');
  assert.throws(() => r.vorbereiten('test.tun', {}, { rolle: 'admin' }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => r.vorbereiten('test.nix', {}, { rolle: 'admin' }), (e) => e.code === 'E_NICHT_GEFUNDEN');
  assert.deepEqual(r.vorbereiten('test.tun', { n: 'x' }, { rolle: 'admin' }).params, { n: 'x' });
});

test('aufgaben: Fortschritt, Fertig, Fehler, Abbruch, Parallelität', async () => {
  const ereignisse = [];
  const a = new Aufgaben((e) => ereignisse.push(e), 1);
  const id1 = a.einstellen({ aktion: 'x', nutzer: 'u', arbeit: async (g) => { g.fortschritt(0.5, 'halb'); await new Promise((r) => setTimeout(r, 20)); return 42; } });
  const id2 = a.einstellen({ aktion: 'y', nutzer: 'u', arbeit: async () => { throw new FahnasFehler('E_PLATZ', 'voll'); } });
  const id3 = a.einstellen({ aktion: 'z', nutzer: 'u', arbeit: async () => 1 });
  a.abbrechen(id3);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(a.hole(id1).status, 'fertig'); assert.equal(a.hole(id1).ergebnis, 42);
  assert.equal(a.hole(id2).status, 'fehler'); assert.equal(a.hole(id2).fehler.code, 'E_PLATZ');
  assert.equal(a.hole(id3).status, 'abgebrochen');
  assert.ok(ereignisse.some((e) => e.aufgabe === id1 && e.fortschritt === 0.5 && e.meldung === 'halb'));
});

test('agent + client: Ende-zu-Ende über Unix-Socket, Rollen, Aufgaben-Ereignisse, Audit', async () => {
  const w = await tmp();
  const sock = path.join(w, 'a.sock'); const dsock = path.join(w, 'd.sock');
  // hintergrund:false – keine Hintergrunddienste der Bereiche (Verbindungs-Sammler, Ortsdaten-Download) im Einheitstest
  const agent = new Agent({ konfigOrdner: path.join(w, 'config'), socketPfad: sock, datenSocket: dsock, hintergrund: false });
  agent.register.aktion('test.echo', { rolle: 'nutzer', schema: { t: { typ: 'string', pflicht: true } }, ausfuehren: async (p) => ({ t: p.t }) });
  agent.register.aktion('test.admin', { rolle: 'admin', schema: {}, ausfuehren: async () => 'geheim' });
  agent.register.aktion('test.lang', { rolle: 'nutzer', schema: {}, aufgabe: true, ausfuehren: async (_p, _k, _w, g) => { g.fortschritt(0.3, 'läuft'); return 'fertig'; } });
  agent.register.aktion('test.gross', { rolle: 'nutzer', schema: { mb: { typ: 'integer', pflicht: true } }, ausfuehren: async (p) => 'x'.repeat(p.mb * 1024 * 1024) });
  agent.register.aktion('test.langsam', { rolle: 'nutzer', schema: {}, ausfuehren: () => new Promise((r) => setTimeout(() => r('fertig'), 150)) });
  agent.register.aktion('test.systemfehler', { rolle: 'nutzer', schema: {}, ausfuehren: async () => { throw new FahnasFehler('E_SYSTEM', 'Befehl schlug fehl', { befehl: 'btrfs subvolume delete /data/x', ausgabe: 'stderr', feld: 'pfad' }); } });
  agent.register.aktion('test.aufgabenfehler', { rolle: 'nutzer', schema: {}, aufgabe: true, ausfuehren: async () => { throw new FahnasFehler('E_SYSTEM', 'kaputt', { befehl: 'rm -r /data/x', feld: 'pfad' }); } });
  // aktionenLaden würde die (noch fehlenden) Bereiche laden – hier nur die eingebauten
  const laden = agent.aktionenLaden.bind(agent);
  agent.aktionenLaden = async () => { const alt = agent.register; await laden(); void alt; };
  // eine offene Aufgabe aus einem „früheren Lauf“ in der Zustandsdatei
  await fs.mkdir(path.join(w, 'config'), { recursive: true });
  await fs.writeFile(path.join(w, 'config', 'aufgaben.json'), JSON.stringify([{ id: 't-alt', aktion: 'dateien.kopieren', nutzer: 'fabian', rolle: 'nutzer', status: 'laeuft', fortschritt: 0.4, gestartet: '2026-09-25T00:00:00.000Z' }]));
  await agent.starten();
  assert.equal(agent.aufgaben.hole('t-alt').status, 'abgebrochen', 'offene Aufgabe aus dem letzten Lauf gilt als abgebrochen');
  // Rollenabgleich: fabian steht in users.json als nutzer; ein „admin“-Anspruch aus der Sitzung zählt nicht
  await agent.konfig.speichern('users.json', { nutzer: [{ name: 'fabian', rolle: 'nutzer', gesperrt: false }, { name: 'gesperrt', rolle: 'admin', gesperrt: true }], gruppen: [] });
  const c = new AgentClient(sock, dsock);
  await new Promise((ok) => { c.once('verbunden', ok); c.starten(); });
  const k = { nutzer: 'fabian', rolle: 'nutzer', ip: '1.2.3.4' };
  const K = { nutzer: 'konsole', rolle: 'admin', ip: '-' };
  try {
  // Große Antwort (R1 Fund 6): 5 MB gehen durch (Grenze 64 MB); darüber E_SYSTEM für DIESE Anfrage, die Verbindung bleibt, parallele Anfragen laufen weiter
  assert.equal(MAX_ZEILE, 64 * 1024 * 1024);
  assert.equal((await c.aktion('test.gross', { mb: 5 }, k)).length, 5 * 1024 * 1024);
  let getrennt = 0; c.on('getrennt', () => getrennt++);
  const [langsam, gross] = await Promise.allSettled([c.aktion('test.langsam', {}, k), c.aktion('test.gross', { mb: 65 }, k)]);
  assert.equal(gross.status, 'rejected'); assert.equal(gross.reason.code, 'E_SYSTEM'); assert.match(gross.reason.message, /zu groß/);
  assert.equal(langsam.status, 'fulfilled'); assert.equal(langsam.value, 'fertig');
  assert.equal(getrennt, 0, 'Steuerverbindung bleibt für alle bestehen');
  assert.deepEqual(await c.aktion('test.echo', { t: 'danach' }, k), { t: 'danach' });
  // Fehlerdetails (R1 Fund 14): nutzer nur harmlose Felder, konsole/admin alles – auch in Aufgaben-Ereignissen
  await assert.rejects(c.aktion('test.systemfehler', {}, k), (e) => e.code === 'E_SYSTEM' && JSON.stringify(e.details) === JSON.stringify({ feld: 'pfad' }));
  await assert.rejects(c.aktion('test.systemfehler', {}, K), (e) => e.code === 'E_SYSTEM' && e.details.befehl === 'btrfs subvolume delete /data/x' && e.details.ausgabe === 'stderr');
  {
    const ev = []; const h = (e) => ev.push(e); c.on('ereignis', h);
    const { aufgabe: a1 } = await c.aktion('test.aufgabenfehler', {}, k);
    const { aufgabe: a2 } = await c.aktion('test.aufgabenfehler', {}, K);
    await new Promise((r) => setTimeout(r, 80));
    c.off('ereignis', h);
    const f1 = ev.find((e) => e.aufgabe === a1 && e.status === 'fehler').fehler; const f2 = ev.find((e) => e.aufgabe === a2 && e.status === 'fehler').fehler;
    assert.deepEqual(f1.details, { feld: 'pfad' }); assert.equal(f2.details.befehl, 'rm -r /data/x');
  }
  // agent.aufgaben seitenweise, nur eigene; Zustandsdatei enthält die Aufgaben
  const eigene = await c.aktion('agent.aufgaben', { seite: 1, je_seite: 1 }, k);
  assert.equal(eigene.length, 1); assert.equal(eigene[0].nutzer, 'fabian');
  await agent.aufgaben.gespeichert();
  assert.ok((await agent.konfig.laden('aufgaben.json', [])).some((x) => x.id === 't-alt' && x.status === 'abgebrochen'));
  await assert.rejects(c.aktion('test.admin', {}, { ...k, rolle: 'admin' }), (e) => e.code === 'E_RECHTE', 'Sitzung behauptet admin, users.json sagt nutzer');
  await assert.rejects(c.aktion('test.echo', { t: 'x' }, { nutzer: 'unbekannt', rolle: 'nutzer', ip: '-' }), (e) => e.code === 'E_RECHTE', 'unbekannter Nutzer');
  await assert.rejects(c.aktion('test.echo', { t: 'x' }, { nutzer: 'gesperrt', rolle: 'admin', ip: '-' }), (e) => e.code === 'E_RECHTE', 'gesperrter Nutzer');
  assert.equal(await c.aktion('test.admin', {}, { nutzer: 'konsole', rolle: 'admin', ip: '-' }), 'geheim', 'Konsole bleibt admin');
  assert.deepEqual(await c.aktion('test.echo', { t: 'hallo' }, k), { t: 'hallo' });
  await assert.rejects(c.aktion('test.admin', {}, k), (e) => e.code === 'E_RECHTE');
  await assert.rejects(c.aktion('test.echo', { t: 5 }, k), (e) => e.code === 'E_PARAMS');
  await assert.rejects(c.aktion('test.echo', { t: 'x' }, { ...k, rolle: 'system' }), (e) => e.code === 'E_RECHTE');
  const ereignisse = [];
  c.on('ereignis', (e) => ereignisse.push(e));
  const { aufgabe } = await c.aktion('test.lang', {}, k);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(ereignisse.some((e) => e.ereignis === 'aufgabe' && e.aufgabe === aufgabe && e.status === 'fertig' && e.ergebnis === 'fertig'));
  assert.ok((await c.aktion('agent.aktionen', {}, k)).some((x) => x.name === 'test.echo'));
  const audit = await agent.audit.lesen({});
  assert.ok(audit.eintraege.some((e) => e.aktion === 'test.admin' && e.ok === false && e.fehler.code === 'E_RECHTE'));
  } finally { c.stoppen(); await agent.stoppen(); }
});
