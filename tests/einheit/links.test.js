// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Freigabelinks (16.10.2026): Zugriffe je Link (gerade, zuletzt, Aufrufe), gelernte öffentliche Adresse, Link-Adresse in
// der Oberfläche, Zeilen der Dashboard-Kachel, Hülle der Linkseite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LinkZugriffe, OeffentlicheAdresse, oeffentlicherHost, linkSchluessel, AKTIV_MS } from '../../src/web/links.js';
import { linkSeiteHtml } from '../../src/web/api/dateien.js';
import { linkAdresse } from '../../public/links.js';
import { nasNetz } from '../../src/agent/helfer/netzadressen.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-links-'));

test('LinkZugriffe: gerade aktiv (5 min oder laufender Download), zuletzt + Aufrufe überleben den Neustart, Token nie auf der Platte', async () => {
  const ordner = await tmp();
  let jetzt = 1_000_000_000_000;
  const z = new LinkZugriffe(ordner, { jetzt: () => jetzt });
  await z.laden();
  z.treffer('tokenA', '203.0.113.5', { aufruf: true });
  const dl = z.treffer('tokenA', '198.51.100.7', { aufruf: true, laufend: true });
  jetzt += 60_000;
  let s = z.stand('tokenA');
  assert.equal(s.aufrufe, 2); assert.equal(s.zuletzt.ip, '198.51.100.7');
  assert.deepEqual(s.aktiv.map((a) => [a.ip, a.laeuft]).sort(), [['198.51.100.7', true], ['203.0.113.5', false]]);
  jetzt += AKTIV_MS; // 6 min nach dem Seitenaufruf: der Besucher ist weg, der Download läuft noch
  s = z.stand('tokenA');
  assert.deepEqual(s.aktiv.map((a) => a.ip), ['198.51.100.7']);
  dl.ende(); dl.ende();
  assert.equal(z.stand('tokenA').aktiv.length, 1, 'gerade fertig → noch 5 min sichtbar');
  jetzt += AKTIV_MS + 1;
  assert.equal(z.stand('tokenA').aktiv.length, 0);
  assert.deepEqual(z.stand('unbekannt'), { aufrufe: 0, zuletzt: null, aktiv: [] });
  await z.stoppen();
  const roh = await fs.readFile(path.join(ordner, 'link-zugriffe.json'), 'utf8');
  assert.ok(!roh.includes('tokenA') && roh.includes(linkSchluessel('tokenA')));
  assert.equal((await fs.stat(path.join(ordner, 'link-zugriffe.json'))).mode & 0o777, 0o600);
  const z2 = new LinkZugriffe(ordner, { jetzt: () => jetzt });
  await z2.laden();
  const s2 = z2.stand('tokenA');
  assert.equal(s2.aufrufe, 2); assert.equal(s2.zuletzt.ip, '198.51.100.7'); assert.deepEqual(s2.aktiv, []);
});

test('Öffentliche Adresse: nur Domains (keine IP, kein .local/.lan), Protokoll aus X-Forwarded-Proto, gespeichert', async () => {
  assert.equal(oeffentlicherHost('fah-nas.example.org'), 'fah-nas.example.org');
  assert.equal(oeffentlicherHost('FAH-NAS.Example.org.'), 'fah-nas.example.org');
  assert.equal(oeffentlicherHost('nas.example.org:8443'), 'nas.example.org:8443');
  for (const x of ['192.168.1.29', '192.168.1.29:8443', '[fd00::1]:8443', 'fahnas', 'fahnas.local', 'nas.lan', 'fritz.box', 'a b.de', '', 'x.example.com/evil']) assert.equal(oeffentlicherHost(x), null, x);
  const ordner = await tmp();
  const a = new OeffentlicheAdresse(ordner);
  await a.laden();
  assert.equal(a.lernen({ headers: { host: 'nas.example.org' } }, false), null, 'ohne vertrauten Proxy nie');
  assert.equal(a.lernen({ headers: { host: 'nas.example.org', 'x-forwarded-proto': 'https' } }, true), 'https://nas.example.org');
  assert.equal(a.lernen({ headers: { host: 'nas.example.org:443' } }, true), 'https://nas.example.org');
  assert.equal(a.lernen({ headers: { 'x-forwarded-host': 'neu.example.net, proxy.intern', host: '192.168.1.29:8443', 'x-forwarded-proto': 'http' } }, true), 'http://neu.example.net');
  await new Promise((r) => setTimeout(r, 50));
  const b = new OeffentlicheAdresse(ordner); await b.laden();
  assert.equal(b.wert, 'http://neu.example.net');
});

test('Link-Adresse der Oberfläche: gelernte Domain vor der Browser-Adresse, absolute URLs bleiben', () => {
  assert.equal(linkAdresse({ link_basis: 'https://fah-nas.example.org' }, { url: '/link/abc' }), 'https://fah-nas.example.org/link/abc');
  assert.equal(linkAdresse({ link_basis: 'https://fah-nas.example.org' }, { token: 'xyz' }), 'https://fah-nas.example.org/link/xyz');
  assert.equal(linkAdresse({ link_basis: 'javascript:alert(1)' }, { url: '/link/abc' }).startsWith('javascript'), false);
  assert.equal(linkAdresse(null, { url: 'https://x.example/link/1' }), 'https://x.example/link/1');
  assert.equal(linkAdresse(null, {}), '');
});

test('Linkseite: Hülle mit Titel (maskiert) und Skript, Fehlerseite ohne Skript', () => {
  const h = linkSeiteHtml('Urlaub <2026> & "mehr"');
  assert.match(h, /<title>Urlaub &lt;2026&gt; &amp; &quot;mehr&quot; – FAH-NAS<\/title>/);
  assert.match(h, /<script type="module" src="\/teilen\.js"><\/script>/);
  const f = linkSeiteHtml(null, 'ungueltig');
  assert.doesNotMatch(f, /<script/); assert.match(f, /ungültig oder abgelaufen/); assert.match(f, /invalid or has expired/);
});

test('nasNetz: Quelladresse und Router aus „ip route get“', async () => {
  const n = await nasNetz({ ausfuehren: async () => ({ stdout: '1.1.1.1 via 192.168.1.1 dev enp1s0 src 192.168.1.29 uid 0\n    cache\n' }) });
  assert.deepEqual(n, { ip: '192.168.1.29', gateway: '192.168.1.1' });
});
