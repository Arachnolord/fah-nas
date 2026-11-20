// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Englische Oberfläche (Ausbau Oktober 2026): zu jeder deutschen Sprachdatei gibt es eine englische mit denselben
// Schlüsseln und denselben Platzhaltern ({name}, {n|eins|viele}) – neue Texte müssen in beiden Sprachen kommen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flach, BEREICHE, erzeugeT, mischen } from '../../public/sprache.js';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'sprache');
const platzhalter = (s) => [...new Set([...String(s).matchAll(/\{([a-zA-Z0-9_]+)(?:\|[^}]*)?\}/g)].map((m) => m[1]))].sort().join(','); // Namen, nicht Anzahl (Englisch braucht manchmal eine Pluralform mehr)

test('Sprachen: jede deutsche Datei hat eine englische mit gleichen Schlüsseln und Platzhaltern', async () => {
  for (const bereich of BEREICHE) {
    let de;
    try { de = flach(JSON.parse(await fs.readFile(path.join(WURZEL, 'de', `${bereich}.json`), 'utf8'))); } catch { continue; }
    const en = flach(JSON.parse(await fs.readFile(path.join(WURZEL, 'en', `${bereich}.json`), 'utf8')));
    const fehlt = Object.keys(de).filter((k) => !(k in en));
    const zuviel = Object.keys(en).filter((k) => !(k in de));
    assert.deepEqual(fehlt, [], `${bereich}: fehlt auf Englisch`);
    assert.deepEqual(zuviel, [], `${bereich}: nur auf Englisch`);
    for (const k of Object.keys(de)) assert.equal(platzhalter(en[k]), platzhalter(de[k]), `${bereich}: Platzhalter in ${k}`);
  }
});

test('Sprachen: Anzahlen haben eine Einzahl („1 Mitglied, 1 Gast“, „1 Karte“) (Bedienprobe 0.21.1)', async () => {
  for (const sprache of ['de', 'en']) {
    const teile = [];
    for (const bereich of ['chat', 'office']) teile.push({ bereich, daten: JSON.parse(await fs.readFile(path.join(WURZEL, sprache, `${bereich}.json`), 'utf8')) });
    const t = erzeugeT(mischen(teile).texte);
    const de = sprache === 'de';
    assert.equal(t('chat.mitglieder_gaeste', { n: 1, g: 1 }), de ? '1 Mitglied, 1 Gast' : '1 member, 1 guest');
    assert.equal(t('chat.mitglieder_gaeste', { n: 2, g: 3 }), de ? '2 Mitglieder, 3 Gäste' : '2 members, 3 guests');
    assert.equal(t('chat.mitglieder_anzahl', { n: 1 }), de ? '1 Mitglied' : '1 member');
    assert.equal(t('chat.verwalten_info', { mitglieder: 1, gaeste: 1, zuletzt: 'x' }), de ? '1 Mitglied, 1 Gast · zuletzt x' : '1 member, 1 guest · last x');
    assert.equal(t('chat.unterwegs_zuteilungen', { n: 1 }), de ? 'Gerade 1 Weiterleitung aktiv' : '1 relay active right now');
    assert.match(t('office.board_spalte_loeschen_frage', { name: 'A', anzahl: 1 }), de ? /mit 1 Karte löschen/ : /with 1 card\?/);
  }
});

test('Sprachen: Kopfleiste schaltet in die jeweils andere Sprache', async () => {
  const de = JSON.parse(await fs.readFile(path.join(WURZEL, 'de', 'gemeinsam.json'), 'utf8'));
  const en = JSON.parse(await fs.readFile(path.join(WURZEL, 'en', 'gemeinsam.json'), 'utf8'));
  assert.equal(de['kopf.sprache_kurz'], 'EN'); assert.equal(en['kopf.sprache_kurz'], 'DE');
});
