// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einladungen und Gäste (Plan 02, Aufgabe 8): Einladungslinks (Ablauf, Höchstzahl), Gast-Ausweis (Hash), Gast sieht nur
// seinen Raum ab Beitritt, nie Login-Namen; Drossel; Entfernen/Verlassen; NAS-Nutzer nehmen Einladungen an.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatUmgebung } from './chat_hilfen.js';
import { _test as ablageTest } from '../../src/agent/chat/ablage.js';
import { _test as raeumeTest } from '../../src/agent/chat/raeume.js';
import { _test as verlaufTest } from '../../src/agent/chat/verlauf.js';
import { _test as gaesteTest } from '../../src/agent/chat/gaeste.js';

let e; let raum; let dm; let token; let einladungId;
beforeEach(async () => {
  ablageTest.zuruecksetzen(); raeumeTest.zuruecksetzen(); verlaufTest.zuruecksetzen(); gaesteTest.drosselZuruecksetzen();
  e = await chatUmgebung();
  ({ raum } = await e.als('anna')('chat.raum.anlegen', { name: 'Team', mitglieder: ['ben'] }));
  ({ raum: dm } = await e.als('anna')('chat.dm.oeffnen', { nutzer: 'ben' }));
  ({ token, id: einladungId } = await e.als('anna')('chat.einladung.anlegen', { raum, gueltig_h: 24 }));
});
afterEach(async () => { await e.aufraeumen(); });
const raumJson = async (r = raum) => JSON.parse(await fs.readFile(path.join(e.chat, 'raeume', r, 'raum.json'), 'utf8'));
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

test('Einladung anlegen: Token 43 Zeichen, Ablauf, nur Verwalter, nicht in DMs', async () => {
  const a = await e.als('anna')('chat.einladung.anlegen', { raum, gueltig_h: 24, max_beitritte: 2 });
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(a.url, `/einladung/${a.token}`); assert.equal(a.max, 2); assert.equal(a.beitritte, 0);
  assert.equal(Date.parse(a.ablauf) - Date.parse(a.erstellt), 24 * 3_600_000);
  assert.equal((await e.als('anna')('chat.einladung.anlegen', { raum, gueltig_h: 0 })).ablauf, null);
  await assert.rejects(e.als('ben')('chat.einladung.anlegen', { raum, gueltig_h: 1 }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.als('anna')('chat.einladung.anlegen', { raum: dm, gueltig_h: 1 }), (f) => f.code === 'E_PARAMS');
  const liste = await e.als('anna')('chat.einladung.liste', { raum });
  assert.equal(liste.length, 3);
  assert.ok(e.ereignisse().some((x) => x.art === 'einladungen' && x.an.nutzer.length === 1 && x.an.nutzer[0] === 'anna'));
});

test('Gast tritt bei: Ausweis, Hash in raum.json, Index, Systemzeile, Ereignis an Mitglieder', async () => {
  const info = await e.gast('chat.gast.einladung', { token });
  assert.deepEqual(info, { raum, raum_name: 'Team', gueltig: true });
  const { ausweis, raum: r } = await e.gast('chat.gast.beitreten', { token, name: '  Gustav  ' });
  assert.equal(r, raum); assert.match(ausweis.geheimnis, /^[A-Za-z0-9_-]{43}$/); assert.match(ausweis.id, /^g[A-Za-z0-9_-]{16}$/);
  const roh = await fs.readFile(path.join(e.chat, 'raeume', raum, 'raum.json'), 'utf8');
  assert.ok(!roh.includes(ausweis.geheimnis)); assert.equal(JSON.parse(roh).gaeste[ausweis.id].name, 'Gustav');
  assert.equal(JSON.parse(roh).einladungen.find((x) => x.id === einladungId).beitritte, 1);
  const index = JSON.parse(await fs.readFile(path.join(e.chat, 'gaeste.json'), 'utf8'));
  assert.equal(index[ausweis.id], raum);
  assert.deepEqual(await e.gast('chat.gast.pruefen', { ausweis }), { raum, raum_name: 'Team', name: 'Gustav', gast: ausweis.id });
  await assert.rejects(e.gast('chat.gast.pruefen', { ausweis: { ...ausweis, geheimnis: 'x'.repeat(43) } }), (f) => f.code === 'E_RECHTE');
  const ev = e.ereignisse().find((x) => x.art === 'nachricht' && x.daten.system && x.daten.system.art === 'gast_beitritt');
  assert.ok(ev, 'Systemzeile gast_beitritt');
  assert.equal(ev.daten.system.wer_name, 'Gustav');
  await assert.rejects(e.gast('chat.gast.beitreten', { token, name: '\u0007' }), (f) => f.code === 'E_PARAMS');
});

test('Einladung: abgelaufen, gelöscht, voll → E_NICHT_GEFUNDEN; bereits Beigetretene bleiben', async () => {
  const eine = await e.als('anna')('chat.einladung.anlegen', { raum, gueltig_h: 1, max_beitritte: 1 });
  const { ausweis } = await e.gast('chat.gast.beitreten', { token: eine.token, name: 'Erster' });
  await assert.rejects(e.gast('chat.gast.beitreten', { token: eine.token, name: 'Zweiter' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await e.als('anna')('chat.einladung.loeschen', { raum, id: eine.id });
  await assert.rejects(e.gast('chat.gast.einladung', { token: eine.token }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  assert.equal((await e.gast('chat.gast.pruefen', { ausweis })).name, 'Erster');
  // abgelaufen
  await e.u.reg; // (kein Zugriff nötig)
  const { chatKonfig } = await import('../../src/agent/chat/ablage.js');
  await chatKonfig(e.w).aendern(`raeume/${raum}/raum.json`, (d) => ({ ...d, einladungen: d.einladungen.map((x) => (x.id === einladungId ? { ...x, ablauf: '2020-01-01T00:00:00.000Z' } : x)) }));
  raeumeTest.zuruecksetzen();
  await assert.rejects(e.gast('chat.gast.einladung', { token }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.gast('chat.gast.einladung', { token: 'x'.repeat(43) }), (f) => f.code === 'E_NICHT_GEFUNDEN');
});

test('Gast bricht nicht aus: fremder Raum, fremder Anhang, Anhang vor Beitritt, fremde Nachricht', async () => {
  // Anhang vor dem Beitritt (im Raum) und Anhang in einem anderen Raum
  await e.als('anna')('chat.anhang.ticket', { raum, name: 'alt.txt', groesse: 1 });
  const vorher = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('a'));
  const { nachricht: annasNachricht } = await e.als('anna')('chat.senden', { raum, text: 'vorher', anhaenge: [vorher.id] });
  const { raum: andererRaum } = await e.als('anna')('chat.raum.anlegen', { name: 'Anders' });
  await e.als('anna')('chat.anhang.ticket', { raum: andererRaum, name: 'b.txt', groesse: 1 });
  const fremd = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('b'));
  await e.als('anna')('chat.senden', { raum: andererRaum, anhaenge: [fremd.id] });
  await warte(5);
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  await assert.rejects(e.gast('chat.gast.verlauf', { ausweis, raum: andererRaum }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.gast('chat.gast.senden', { ausweis, raum: andererRaum, text: 'x' }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.gast('chat.gast.anhang_lesen', { ausweis, raum, anhang: fremd.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.gast('chat.gast.anhang_lesen', { ausweis, raum, anhang: vorher.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.gast('chat.gast.loeschen', { ausweis, raum, nachricht: annasNachricht.id }), (f) => f.code === 'E_NICHT_GEFUNDEN', 'vor dem Beitritt = gibt es nicht');
  await assert.rejects(e.gast('chat.verlauf', { raum }), (f) => f.code === 'E_RECHTE'); // Rolle gast reicht nicht für nutzer-Aktionen
  await assert.rejects(e.gast('chat.raum.mitglieder', { raum, weg: ['ben'] }), (f) => f.code === 'E_RECHTE');
  await assert.rejects(e.gast('chat.gast.verlauf', { ausweis: { id: ausweis.id, geheimnis: 'y'.repeat(43) }, raum }), (f) => f.code === 'E_RECHTE');
});

test('Gast sieht Verlauf ab Beitritt, keine Login-Namen, kein gelesen', async () => {
  await e.als('anna')('chat.senden', { raum, text: 'vor dem Beitritt' });
  await warte(5);
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const { nachricht } = await e.als('anna')('chat.senden', { raum, text: 'nach dem Beitritt' });
  await e.als('ben')('chat.reaktion', { raum, nachricht: nachricht.id, emoji: '👍', an: true });
  const v = await e.gast('chat.gast.verlauf', { ausweis, raum });
  const texte = v.nachrichten.filter((n) => !n.system).map((n) => n.text);
  assert.deepEqual(texte, ['nach dem Beitritt']);
  const n = v.nachrichten.find((x) => x.text === 'nach dem Beitritt');
  assert.equal(n.von, null); assert.equal(n.von_name, 'Anna A.');
  assert.deepEqual(n.reaktionen, { '👍': ['Ben'] });
  assert.equal('gelesen' in v, false);
  assert.equal(JSON.stringify(v).includes('"anna"'), false, 'kein Login-Name');
  const ev = e.ereignisse().filter((x) => x.art === 'nachricht').at(-1);
  assert.equal(ev.daten_gast.von, null);
});

test('Gast sieht nichts von vor seinem Beitritt: Zitat, Bearbeiten, Reaktion, Löschen; Antworten/Reagieren darauf wie nicht vorhanden', async () => {
  const { nachricht: alt } = await e.als('anna')('chat.senden', { raum, text: 'GEHEIM intern' });
  await warte(5);
  const { ausweis: frieda } = await e.gast('chat.gast.beitreten', { token, name: 'Frieda' });
  await warte(5);
  const { nachricht: mitte } = await e.als('anna')('chat.senden', { raum, text: 'MITTE' });
  await warte(5);
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  // Antwort auf „MITTE“: Frieda (vorher da) sieht das Zitat, Gustav nur „frühere Nachricht“ – je genau ein Ereignis
  const n0 = e.ereignisse().length;
  const { nachricht: antwort } = await e.als('anna')('chat.senden', { raum, text: 'Antwort', antwort: mitte.id });
  const evs = e.ereignisse().slice(n0).filter((x) => x.art === 'nachricht');
  const fuer = (gid) => evs.filter((x) => x.an.gaeste.includes(gid));
  assert.equal(fuer(ausweis.id).length, 1); assert.equal(fuer(frieda.id).length, 1);
  assert.deepEqual(fuer(ausweis.id)[0].daten_gast.antwort, { frueher: true });
  assert.equal(JSON.stringify(fuer(ausweis.id)[0]).includes('MITTE'), false, 'auch nicht im Feld daten');
  assert.equal(fuer(frieda.id)[0].daten_gast.antwort.kurz, 'MITTE');
  assert.equal(evs.filter((x) => x.an.nutzer.includes('ben')).length, 1);
  assert.equal(evs.find((x) => x.an.nutzer.includes('ben')).daten.antwort.kurz, 'MITTE');
  const v = await e.gast('chat.gast.verlauf', { ausweis, raum });
  assert.deepEqual(v.nachrichten.find((n) => n.id === antwort.id).antwort, { frueher: true });
  assert.equal(JSON.stringify(v).includes('MITTE'), false);
  assert.equal((await e.gast('chat.gast.verlauf', { ausweis: frieda, raum })).nachrichten.find((n) => n.id === antwort.id).antwort.kurz, 'MITTE');
  // Bearbeiten, Reaktion, Löschen alter Nachrichten: Ereignisse nur an Gäste, die die Nachricht sehen
  await e.als('anna')('chat.bearbeiten', { raum, nachricht: alt.id, text: 'NEU GEHEIM' });
  assert.deepEqual(e.ereignisse().filter((x) => x.art === 'bearbeitet').at(-1).an.gaeste, []);
  await e.als('anna')('chat.bearbeiten', { raum, nachricht: mitte.id, text: 'MITTE2' });
  assert.deepEqual(e.ereignisse().filter((x) => x.art === 'bearbeitet').at(-1).an.gaeste, [frieda.id]);
  await e.als('ben')('chat.reaktion', { raum, nachricht: alt.id, emoji: '👍', an: true });
  assert.deepEqual(e.ereignisse().filter((x) => x.art === 'reaktion').at(-1).an.gaeste, []);
  await e.als('anna')('chat.loeschen', { raum, nachricht: alt.id });
  assert.deepEqual(e.ereignisse().filter((x) => x.art === 'geloescht').at(-1).an.gaeste, []);
  // Gustav: Antworten, Reagieren, Löschen auf „MITTE“ → wie nicht vorhanden; Frieda darf antworten
  await assert.rejects(e.gast('chat.gast.senden', { ausweis, raum, text: 'x', antwort: mitte.id }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'antwort');
  await assert.rejects(e.gast('chat.gast.reaktion', { ausweis, raum, nachricht: mitte.id, emoji: '👍', an: true }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await assert.rejects(e.gast('chat.gast.loeschen', { ausweis, raum, nachricht: mitte.id }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  await e.gast('chat.gast.senden', { ausweis: frieda, raum, text: 'ok', antwort: mitte.id });
});

test('Reaktionen nur aus der Emoji-Liste der Oberfläche; Gast-Reaktionen gedrosselt (Befund 8)', async () => {
  const { EMOJIS } = await import('../../src/agent/chat/nachrichten.js');
  const quelle = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'chat', 'eingabe.js'), 'utf8');
  assert.deepEqual([...EMOJIS], JSON.parse(/EMOJIS = Object\.freeze\((\[[^\]]*\])\)/.exec(quelle)[1].replace(/'/g, '"')), 'gleiche Liste wie die Oberfläche');
  const { nachricht } = await e.als('anna')('chat.senden', { raum, text: 'x' });
  await assert.rejects(e.als('ben')('chat.reaktion', { raum, nachricht: nachricht.id, emoji: 'AAAA', an: true }), (f) => f.code === 'E_PARAMS' && f.details.feld === 'emoji');
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const { nachricht: n2 } = await e.als('anna')('chat.senden', { raum, text: 'y' });
  await assert.rejects(e.gast('chat.gast.reaktion', { ausweis, raum, nachricht: n2.id, emoji: 'xyz', an: true }), (f) => f.code === 'E_PARAMS');
  for (let i = 0; i < 60; i++) await e.gast('chat.gast.reaktion', { ausweis, raum, nachricht: n2.id, emoji: '👍', an: i % 2 === 0 });
  await assert.rejects(e.gast('chat.gast.reaktion', { ausweis, raum, nachricht: n2.id, emoji: '👍', an: true }), (f) => f.code === 'E_BREMSE');
});

test('Gast schreibt: von gast:<id>, Name in der Ansicht, Mitglieder zählen ungelesen', async () => {
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const { nachricht } = await e.gast('chat.gast.senden', { ausweis, raum, text: 'Hallo von Gustav' });
  assert.deepEqual([nachricht.von, nachricht.von_name, nachricht.gast], [`gast:${ausweis.id}`, 'Gustav', true]);
  const r = await raumJson();
  assert.equal(r.mitglieder.anna.ungelesen, 1);
  assert.equal(r.gaeste[ausweis.id].ungelesen, 0);
  assert.equal((await e.als('anna')('chat.uebersicht', {})).raeume.find((x) => x.id === raum).letzte.von_name, 'Gustav');
  assert.deepEqual(await e.gast('chat.gast.gelesen', { ausweis, raum, bis: nachricht.id }), { ungelesen: 0 });
  assert.deepEqual(await e.gast('chat.gast.loeschen', { ausweis, raum, nachricht: nachricht.id }), { geloescht: true });
});

test('Gast-Drossel: 21. Nachricht in 60 s → E_BREMSE mit warte_s', async () => {
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  for (let i = 0; i < 20; i++) await e.gast('chat.gast.senden', { ausweis, raum, text: `n${i}` });
  await assert.rejects(e.gast('chat.gast.senden', { ausweis, raum, text: 'zu viel' }), (f) => f.code === 'E_BREMSE' && f.details.warte_s > 0);
});

test('Gast entfernen und verlassen: raum.json, Index, Ereignis gast_entfernt an Gast und Mitglieder', async () => {
  const g1 = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const g2 = await e.gast('chat.gast.beitreten', { token, name: 'Grete' });
  await e.gast('chat.gast.senden', { ausweis: g1.ausweis, raum, text: 'bin gleich weg' });
  await assert.rejects(e.als('ben')('chat.gast.entfernen', { raum, gast: g1.ausweis.id }), (f) => f.code === 'E_RECHTE');
  await e.als('anna')('chat.gast.entfernen', { raum, gast: g1.ausweis.id });
  const ev = e.ereignisse().find((x) => x.art === 'gast_entfernt');
  assert.deepEqual(ev.daten, { gast: g1.ausweis.id });
  assert.ok(ev.an.gaeste.includes(g1.ausweis.id)); assert.ok(ev.an.nutzer.includes('anna'));
  await assert.rejects(e.gast('chat.gast.pruefen', { ausweis: g1.ausweis }), (f) => f.code === 'E_RECHTE');
  // alte Nachrichten behalten den Namen
  const v = await e.als('anna')('chat.verlauf', { raum });
  assert.equal(v.nachrichten.find((n) => n.text === 'bin gleich weg').von_name, 'Gustav');
  assert.deepEqual(await e.gast('chat.gast.verlassen', { ausweis: g2.ausweis }), { verlassen: true });
  const r = await raumJson();
  assert.deepEqual(Object.keys(r.gaeste), []);
  const index = JSON.parse(await fs.readFile(path.join(e.chat, 'gaeste.json'), 'utf8'));
  assert.deepEqual(index, {});
  const austritt = e.ereignisse().filter((x) => x.art === 'nachricht' && x.daten.system && x.daten.system.art === 'austritt').at(-1);
  assert.equal(austritt.daten.system.wer_name, 'Grete');
});

test('Gast entfernen mit link_sperren: Link gelöscht – derselbe Link lässt niemanden mehr hinein; ohne: Link bleibt (Befund 10)', async () => {
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  assert.deepEqual(await e.als('anna')('chat.gast.entfernen', { raum, gast: ausweis.id }), { entfernt: true, link_geloescht: false });
  const { ausweis: zwei } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  assert.deepEqual(await e.als('anna')('chat.gast.entfernen', { raum, gast: zwei.id, link_sperren: true }), { entfernt: true, link_geloescht: true });
  await assert.rejects(e.gast('chat.gast.beitreten', { token, name: 'Gustav' }), (f) => f.code === 'E_NICHT_GEFUNDEN');
  assert.equal((await e.als('anna')('chat.einladung.liste', { raum })).some((x) => x.id === einladungId), false);
  assert.ok(e.ereignisse().some((x) => x.art === 'einladungen'));
});

test('Gäste sehen keine Login-Namen: Mitglieder ohne Anzeigenamen heißen „Mitglied N“ (Befund 11)', async () => {
  const { nachricht: alt } = await e.als('anna')('chat.senden', { raum, text: 'Hallo' });
  await warte(5);
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  const { nachricht: n0 } = await e.als('anna')('chat.senden', { raum, text: 'nach Beitritt' });
  await warte(5);
  await e.als('anna')('chat.raum.mitglieder', { raum, hinzu: ['cara'], weg: [], verwalter_hinzu: [], verwalter_weg: [] });
  const { nachricht } = await e.als('cara')('chat.senden', { raum, text: 'Ich bin neu' });
  await e.als('cara')('chat.reaktion', { raum, nachricht: n0.id, emoji: '👍', an: true });
  const v = await e.gast('chat.gast.verlauf', { ausweis, raum });
  assert.equal(v.nachrichten.find((n) => n.id === nachricht.id).von_name, 'Mitglied 3');
  assert.deepEqual(v.nachrichten.find((n) => n.id === n0.id).reaktionen, { '👍': ['Mitglied 3'] });
  assert.equal(v.nachrichten.find((n) => n.system && n.system.art === 'beitritt').system.wer_name, 'Mitglied 3');
  assert.equal(JSON.stringify(v).includes('cara'), false, 'kein Login-Name');
  const ev = e.ereignisse().filter((x) => x.art === 'nachricht' && x.daten.id === nachricht.id).at(-1);
  assert.equal(ev.daten_gast.von_name, 'Mitglied 3'); assert.equal(ev.daten.von_name, 'cara', 'Mitglieder sehen weiter den Namen');
  void alt;
});

test('NAS-Nutzer nimmt Einladung an', async () => {
  assert.deepEqual(await e.als('cara')('chat.einladung.annehmen', { token }), { raum });
  let r = await raumJson();
  assert.ok(r.mitglieder.cara);
  assert.equal(r.einladungen.find((x) => x.id === einladungId).beitritte, 1);
  assert.deepEqual(await e.als('cara')('chat.einladung.annehmen', { token }), { raum });
  r = await raumJson();
  assert.equal(r.einladungen.find((x) => x.id === einladungId).beitritte, 1);
});

test('Gast lädt hoch und sendet mit Anhang; Ticket-Nutzer gast:<id>', async () => {
  const { ausweis } = await e.gast('chat.gast.beitreten', { token, name: 'Gustav' });
  await e.gast('chat.gast.anhang_ticket', { ausweis, raum, name: 'bild.png', groesse: 3 });
  assert.equal(e.tickets.at(-1).nutzer, `gast:${ausweis.id}`);
  const a = await e.ticketAbschliessen(e.tickets.length - 1, Buffer.from('png'));
  const { nachricht } = await e.gast('chat.gast.senden', { ausweis, raum, anhaenge: [a.id] });
  assert.equal(nachricht.anhaenge[0].name, 'bild.png');
  await e.gast('chat.gast.anhang_lesen', { ausweis, raum, anhang: a.id });
  assert.equal(e.tickets.at(-1).art, 'lesen'); assert.equal(e.tickets.at(-1).nutzer, `gast:${ausweis.id}`);
  assert.deepEqual(await e.gast('chat.gast.empfaenger', { ausweis, raum }), { nutzer: ['anna', 'ben'], gaeste: [ausweis.id] });
});

test('Prüfprotokoll ohne Ausweis und Text', () => {
  const def = e.u.reg.hole('chat.gast.loeschen');
  assert.deepEqual(def.audit({ ausweis: { id: 'g', geheimnis: 'GEHEIM' }, raum: 'r', nachricht: 'n' }), { raum: 'r', nachricht: 'n' });
  assert.deepEqual(e.u.reg.hole('chat.gast.beitreten').audit({ token: 'T', name: 'Gustav' }), { name: 'Gustav' });
  assert.equal(e.u.reg.hole('chat.gast.senden').audit, false);
});
