// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatar-Baustein (public/avatar.js, 0.22.0): Bild des Nutzers oder Anfangsbuchstabe im Kreis; die Versionen kommen aus
// nutzer.avatare, jede Änderung tauscht alle sichtbaren Avatare sofort; ein Bild, das nicht lädt, fällt auf den
// Buchstaben zurück; ohne Login-Namen (Chat-Gäste) nie ein Bild. Dazu der Zuschnitt beim Hochladen.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
let dom; let av;
before(async () => {
  dom = domAttrappe();
  av = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'avatar.js')).href);
});
after(() => dom.aufraeumen());
afterEach(() => { av.avatareSetzen({}); document.body.textContent = ''; });

const bild = (k) => k.querySelector('img');

test('avatar: ohne Bild der Anfangsbuchstabe auf einer festen Farbe je Person, Größe als Variable', () => {
  const k = av.avatarKnoten({ name: 'anna', anzeige: 'Anna Berg', groesse: 24 });
  assert.equal(k.className, 'avatar');
  assert.equal(k.textContent, 'A');
  assert.equal(bild(k), null);
  assert.equal(k.getAttribute('data-avatar'), 'anna');
  assert.equal(k.getAttribute('aria-hidden'), 'true', 'neben dem Namen nur Schmuck');
  assert.equal(k.style.getPropertyValue('--avatar-groesse'), '24px');
  const farbe = k.style.getPropertyValue('--avatar-farbe');
  assert.match(farbe, /^hsl\(\d+ /);
  assert.equal(av.avatarKnoten({ name: 'anna', anzeige: 'Anna' }).style.getPropertyValue('--avatar-farbe'), farbe, 'dieselbe Person, dieselbe Farbe');
  assert.equal(av.avatarKnoten({ name: 'anna', farbe: '#2f7fd1' }).style.getPropertyValue('--avatar-farbe'), '#2f7fd1', 'Sitzungsfarbe (Office) geht vor');
  const benannt = av.avatarKnoten({ name: 'ben', anzeige: 'Ben', titel: 'Ben' });
  assert.equal(benannt.getAttribute('role'), 'img'); assert.equal(benannt.getAttribute('aria-label'), 'Ben'); assert.equal(benannt.title, 'Ben');
  assert.equal(benannt.getAttribute('aria-hidden'), null);
});

test('avatar: Bild aus der Version, live getauscht; Ladefehler → Buchstabe; ohne Login-Namen nie ein Bild', () => {
  const k = av.avatarKnoten({ name: 'anna', anzeige: 'Anna' });
  const gast = av.avatarKnoten({ anzeige: 'Probe-Gast' });
  document.body.append(k, gast);
  av.avatareSetzen({ anna: 'abcdef012345', ben: '0123456789ab' });
  assert.equal(bild(k).getAttribute('src'), '/api/avatar/anna?v=abcdef012345');
  assert.equal(bild(k).getAttribute('alt'), '');
  assert.ok(k.classList.contains('avatar-bild'));
  assert.equal(av.avatarUrl('ben'), '/api/avatar/ben?v=0123456789ab');
  assert.equal(av.avatarUrl('cara'), null);
  assert.equal(gast.textContent, 'P'); assert.equal(bild(gast), null);
  const neu = av.avatarKnoten({ name: 'anna', anzeige: 'Anna' });
  assert.equal(bild(neu).getAttribute('src'), '/api/avatar/anna?v=abcdef012345', 'neue Knoten bekommen gleich das Bild');
  bild(k).dispatchEvent(new Event('error'));
  assert.equal(bild(k), null); assert.equal(k.textContent, 'A'); assert.ok(!k.classList.contains('avatar-bild'));
  av.avatareSetzen({ anna: 'ffffff000000' });
  assert.equal(bild(k).getAttribute('src'), '/api/avatar/anna?v=ffffff000000', 'neue Version → neues Bild');
  av.avatareSetzen({});
  assert.equal(bild(k), null); assert.equal(k.textContent, 'A', 'Bild entfernt → wieder der Buchstabe');
  av.avatarAendern(k, { name: 'ben', anzeige: 'Ben' });
  assert.equal(k.getAttribute('data-avatar'), 'ben'); assert.equal(k.textContent, 'B');
});

test('avatar: Anfangsbuchstabe auch bei Umlaut, Emoji und leerem Namen; Zuschnitt aus der Bildmitte', () => {
  assert.equal(av.anfangsbuchstabe('  éva'), 'É');
  assert.equal(av.anfangsbuchstabe('😀 Max'), '😀');
  assert.equal(av.anfangsbuchstabe(''), '?');
  assert.equal(av.anfangsbuchstabe(null), '?');
  assert.deepEqual(av.zuschnitt(400, 300), { sx: 50, sy: 0, s: 300 });
  assert.deepEqual(av.zuschnitt(300, 500), { sx: 0, sy: 100, s: 300 });
  assert.deepEqual(av.zuschnitt(256, 256), { sx: 0, sy: 0, s: 256 });
});
