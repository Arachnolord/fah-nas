// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übersicht-Kacheln nach Unraid/ZimaOS (0.17.0): Registry-Abgleich (App-Updates), docker system df, Verbindungen
// (smbstatus/ss), nächster Schnappschuss und die reinen Auswertungen der Kacheln in dashboard.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageZerlegen, bearerHinweis, lokaleDigests, entfernterDigest, imagePruefen } from '../../src/agent/apps/registry.js';
import { systemDfParsen } from '../../src/agent/apps/docker.js';
import { adresseOhnePort, ssParsen, sshNutzer, verbindungenZuordnen, smbStatusParsen } from '../../src/agent/helfer/zugriffe.js';
import { naechsteFaelligkeit, naechsterTermin } from '../../src/agent/aktionen/snapshots.js';

const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;

test('imageZerlegen: Docker Hub, library/, Registry mit Port, Digest', () => {
  assert.deepEqual(imageZerlegen('nginx'), { registry: 'docker.io', repo: 'library/nginx', tag: 'latest', digest: null, name: 'nginx' });
  assert.deepEqual(imageZerlegen('linuxserver/plex:1.2'), { registry: 'docker.io', repo: 'linuxserver/plex', tag: '1.2', digest: null, name: 'linuxserver/plex' });
  assert.deepEqual(imageZerlegen('ghcr.io/home-assistant/home-assistant:stable'), { registry: 'ghcr.io', repo: 'home-assistant/home-assistant', tag: 'stable', digest: null, name: 'ghcr.io/home-assistant/home-assistant' });
  assert.equal(imageZerlegen('localhost:5000/app').tag, 'latest');
  assert.equal(imageZerlegen('localhost:5000/app').registry, 'localhost:5000');
  assert.equal(imageZerlegen(`redis@${D1}`).digest, D1);
  assert.equal(imageZerlegen(''), null);
});

test('bearerHinweis und lokaleDigests', () => {
  assert.deepEqual(bearerHinweis('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'),
    { realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/nginx:pull' });
  assert.equal(bearerHinweis('Basic realm="x"'), null);
  assert.deepEqual(lokaleDigests([`nginx@${D1}`, `ghcr.io/a/b@${D2}`], 'nginx'), [D1]);
  assert.deepEqual(lokaleDigests([`docker.io/library/nginx@${D1}`], 'nginx'), [D1]);
  assert.deepEqual(lokaleDigests([], 'nginx'), []);
});

/** Attrappe einer Registry: erst 401 mit Bearer-Hinweis, mit Token der Digest. */
function registry(digest, aufrufe = []) {
  return async (url, o = {}) => {
    aufrufe.push({ url, o });
    const kopf = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
    if (url.startsWith('https://auth.')) return { ok: true, status: 200, json: async () => ({ token: 'T' }), headers: kopf({}) };
    if (!o.headers || o.headers.Authorization !== 'Bearer T') return { ok: false, status: 401, headers: kopf({ 'www-authenticate': 'Bearer realm="https://auth.example/token",service="reg"' }) };
    return { ok: true, status: 200, headers: kopf({ 'docker-content-digest': digest }) };
  };
}

test('entfernterDigest: anonyme Anmeldung, HEAD mit Token, Scope aus dem Repo', async () => {
  const aufrufe = [];
  assert.equal(await entfernterDigest(imageZerlegen('nginx:1.27'), { abruf: registry(D1, aufrufe) }), D1);
  assert.equal(aufrufe[0].url, 'https://registry-1.docker.io/v2/library/nginx/manifests/1.27');
  assert.equal(aufrufe[0].o.method, 'HEAD');
  assert.match(aufrufe[1].url, /scope=repository%3Alibrary%2Fnginx%3Apull/);
  assert.equal(aufrufe[2].o.headers.Authorization, 'Bearer T');
});

test('imagePruefen: aktuell, update, lokal gebaut, festgenagelt, fehlt, Netzfehler', async () => {
  const inspect = (l) => async () => l;
  assert.equal((await imagePruefen('nginx', { inspect: inspect([`nginx@${D1}`]), abruf: registry(D1) })).stand, 'aktuell');
  assert.equal((await imagePruefen('nginx', { inspect: inspect([`nginx@${D1}`]), abruf: registry(D2) })).stand, 'update');
  assert.equal((await imagePruefen('fahnas/app:1', { inspect: inspect([]), abruf: registry(D1) })).stand, 'lokal');
  assert.equal((await imagePruefen(`nginx@${D1}`, { inspect: inspect([]), abruf: registry(D1) })).stand, 'fest');
  assert.equal((await imagePruefen('nginx', { inspect: inspect(null), abruf: registry(D1) })).stand, 'fehlt');
  const kaputt = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await imagePruefen('nginx', { inspect: inspect([`nginx@${D1}`]), abruf: kaputt });
  assert.equal(r.stand, 'fehler'); assert.match(r.grund, /ENOTFOUND/);
});

test('systemDfParsen: je Art Anzahl, aktiv, Bytes (SI wie docker)', () => {
  const t = [
    '{"Active":"5","Reclaimable":"1.2GB (30%)","Size":"4.1GB","TotalCount":"7","Type":"Images"}',
    '{"Active":"4","Reclaimable":"0B (0%)","Size":"12.5kB","TotalCount":"6","Type":"Containers"}',
    '{"Active":"2","Reclaimable":"0B","Size":"300MB","TotalCount":"3","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"850MB","Size":"850MB","TotalCount":"40","Type":"Build Cache"}',
  ].join('\n');
  const d = systemDfParsen(t);
  assert.deepEqual(d.images, { anzahl: 7, aktiv: 5, bytes: 4_100_000_000, frei_bytes: 1_200_000_000 });
  assert.equal(d.container.bytes, 12_500);
  assert.equal(d.volumes.anzahl, 3);
  assert.equal(d.cache.bytes, 850_000_000);
  assert.deepEqual(systemDfParsen(''), { images: null, container: null, volumes: null, cache: null });
});

test('Verbindungen: ss, sshd-Titel, Zuordnung, smbstatus --json', () => {
  assert.equal(adresseOhnePort('[::ffff:192.168.1.5]:51234'), '192.168.1.5');
  assert.equal(adresseOhnePort('192.168.1.5:22'), '192.168.1.5');
  assert.equal(adresseOhnePort('[fe80::1%eth0]:22'), 'fe80::1');
  const ss = ssParsen([
    '0      0               192.168.1.29:22            192.168.1.146:58393 users:(("sshd-session",pid=4711,fd=4),("sshd-session",pid=4720,fd=4))',
    '0      0               192.168.1.29:5006          192.168.1.20:50000 users:(("rclone",pid=900,fd=9))',
    '0      0               192.168.1.29:5006          192.168.1.20:50001 users:(("rclone",pid=900,fd=10))',
    '0      0               192.168.1.29:2049          192.168.1.30:700',
    '0      0               192.168.1.29:40860             9.9.9.9:443 users:(("node",pid=1,fd=3))',
  ].join('\n'));
  assert.equal(ss.length, 5);
  assert.deepEqual(ss[0].prozesse[0], { name: 'sshd-session', pid: 4711 });
  assert.equal(sshNutzer('sshd-session: fabian [priv]'), 'fabian');
  assert.equal(sshNutzer('sshd: anna@notty'), 'anna');
  assert.equal(sshNutzer('sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups'), null);
  const z = verbindungenZuordnen(ss, { webdavPort: 5006, titel: (pid) => (pid === 4711 ? 'sshd-session: fabian [priv]' : '') });
  assert.deepEqual(z.ssh, [{ nutzer: 'fabian', adresse: '192.168.1.146' }]);
  assert.deepEqual(z.webdav, [{ adresse: '192.168.1.20', anzahl: 2 }]);
  assert.deepEqual(z.nfs, [{ adresse: '192.168.1.30', anzahl: 1 }]);
  assert.deepEqual(verbindungenZuordnen(ss, {}).webdav, [], 'WebDAV aus → Port 5006 zählt nicht');
  const smb = smbStatusParsen({
    sessions: { 1: { session_id: '1', uid: 1000, username: 'FAHNAS\\fabian', remote_machine: '192.168.1.143', hostname: 'ipv4:192.168.1.143:50094', session_dialect: 'SMB3_11' } },
    tcons: { a: { service: 'private', session_id: '1' }, b: { service: 'IPC$', session_id: '1' } },
    open_files: { '/data/shares/private/film.mkv': { service_path: '/data/shares/private', filename: 'film.mkv', opens: { '1/2': { uid: 1000, opened_at: '2026-10-15T14:00:00+02:00' } } } },
  });
  assert.deepEqual(smb.sitzungen, [{ nutzer: 'fabian', rechner: '192.168.1.143', adresse: '192.168.1.143', protokoll: 'SMB3_11', freigaben: ['private'] }]);
  assert.deepEqual(smb.dateien, [{ nutzer: 'fabian', freigabe: 'private', datei: 'film.mkv', seit: '2026-10-15T14:00:00+02:00' }]);
  assert.deepEqual(smbStatusParsen({ timestamp: 'x' }), { sitzungen: [], dateien: [] });
});

test('nächster Schnappschuss: stündlich zur vollen Stunde, täglich 03:00, wöchentlich So 03:30', () => {
  const jetzt = new Date(2026, 9, 15, 14, 20); // Do 15.10.2026 14:20 Ortszeit
  assert.deepEqual(naechsteFaelligkeit(jetzt, 'stuendlich'), new Date(2026, 9, 15, 15, 0));
  assert.deepEqual(naechsteFaelligkeit(jetzt, 'taeglich'), new Date(2026, 9, 16, 3, 0));
  assert.deepEqual(naechsteFaelligkeit(jetzt, 'woechentlich'), new Date(2026, 9, 18, 3, 30));
  assert.equal(naechsterTermin({ zeitplan: { taeglich: true, woechentlich: true } }, jetzt), new Date(2026, 9, 16, 3, 0).toISOString());
  assert.equal(naechsterTermin({ zeitplan: {} }, jetzt), null);
  assert.equal(naechsterTermin(undefined, jetzt), null);
});

test('dashboard.js: Auswertungen der neuen Kacheln', async () => {
  const d = await import('../../public/ansichten/dashboard.js');
  const z = d.appsZeilen([{ name: 'p', titel: 'Plex', zustand: 'running', symbol: 'https://x/p.png', webui: 'http://[IP]:32400/web', update: true }]);
  assert.deepEqual(z[0], { name: 'p', titel: 'Plex', stufe: 'laeuft', portkonflikt: false, symbol: 'https://x/p.png', webui: 'http://[IP]:32400/web', update: true });
  const fg = d.freigabenZeilen([
    { name: 'klein', belegt: 1024 ** 3, groesse_gb: 4 },
    { name: 'gross', belegt: 10 * 1024 ** 3, groesse_gb: null },
    { name: 'usb', extern: true, belegt: 50, kapazitaet: 100 },
    { name: 'tresor', verschluesselt: true, entsperrt: false, belegt: null },
  ]);
  assert.deepEqual(fg.map((f) => f.name), ['gross', 'klein', 'usb', 'tresor'], 'nach Belegung absteigend, unbekannt zuletzt');
  assert.equal(fg[1].prozent, 25);
  assert.equal(fg[0].prozent, null, 'ohne Kontingent kein Balken');
  assert.equal(fg[2].prozent, 50);
  assert.equal(fg[3].gesperrt, true);
  const jetzt = Date.parse('2026-10-15T14:00:00Z');
  const v = d.verbindungenZeilen(
    { smb: { sitzungen: [{ nutzer: 'fabian', rechner: 'MacBook', adresse: '192.168.1.143', freigaben: ['private'] }], dateien: [{ freigabe: 'private', datei: 'a', nutzer: 'fabian' }] }, ssh: [{ nutzer: 'anna', adresse: '192.168.1.9' }], webdav: [{ adresse: '192.168.1.20', anzahl: 2 }], nfs: [] },
    [{ nutzer: 'fabian', ip: '192.168.1.143', zuletzt: '2026-10-15T13:58:00Z', aktuell: true }, { nutzer: 'alt', ip: '1.2.3.4', zuletzt: '2026-10-15T12:00:00Z' }],
    jetzt);
  assert.deepEqual(v.zeilen.map((x) => `${x.art}:${x.nutzer}:${x.adresse}`), ['web:fabian:192.168.1.143', 'smb:fabian:MacBook', 'ssh:anna:192.168.1.9', 'webdav::192.168.1.20']);
  assert.equal(v.zeilen[0].du, true);
  assert.equal(v.dateien.length, 1);
  const dk = d.dockerZeilen({ images: { anzahl: 7, aktiv: 5, bytes: 100 }, container: { anzahl: 6, aktiv: 4, bytes: 10 }, volumes: null, cache: { anzahl: 1, aktiv: 0, bytes: 5 }, logs: 3 });
  assert.deepEqual(dk.zeilen.map((x) => x.art), ['images', 'container', 'cache', 'logs']);
  assert.equal(dk.summe, 118);
  const u = d.updatesZusammenfassung({ apps: [{ name: 'a', titel: 'A', stand: 'update' }, { name: 'b', titel: 'B', stand: 'aktuell' }, { name: 'c', titel: 'C', stand: 'unbekannt' }] }, { updates: { anzahl: 12, sicherheit: 3 } });
  assert.equal(u.anzahl, 13);
  assert.deepEqual(u.apps.map((a) => a.name), ['a']);
  assert.deepEqual(u.ubuntu, { anzahl: 12, sicherheit: 3 });
  assert.equal(u.unbekannt, 1);
  assert.equal(d.updatesZusammenfassung(null, null).anzahl, 0);
});
