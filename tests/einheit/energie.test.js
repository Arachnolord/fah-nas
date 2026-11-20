// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Energie (Ausbau Oktober 2026): Zeitplan (fällig, Nachholfenster, Aufschub bei laufenden Aufgaben, RTC-Wecker),
// Wake-on-LAN (ethtool, Unit, Magic Packet), USV über NUT (Dateien, nut-scanner, upsc, Entscheidung, Herunterfahren).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-energie-'));
process.env.FAHNAS_NUT = path.join(wurzel, 'nut');
process.env.FAHNAS_WOL_UNIT = path.join(wurzel, 'fahnas-wol.service');
const r = await import('../../src/agent/energie/regeln.js');
const energie = await import('../../src/agent/aktionen/energie.js');
const { Konfig } = await import('../../src/gemeinsam/konfig.js');
test.after(() => fs.rm(wurzel, { recursive: true, force: true }));

const ort = (s) => new Date(s); // Ortszeit (ohne Z)

test('energie: Zeitplan – fällig, Nachholfenster, bedient, nächster Zeitpunkt', () => {
  const z = r.zeitplanNormal({ aktiv: true, aus: { tage: [1, 2, 3, 4, 5], zeit: '23:00' }, an: { aktiv: true, tage: [1, 2, 3, 4, 5, 6], zeit: '7:05' } });
  assert.equal(z.an.zeit, '07:05');
  const mo2301 = ort('2026-10-12T23:01:00'); // Montag
  const faellig = r.ausFaellig(z, mo2301, null);
  assert.equal(faellig, ort('2026-10-12T23:00:00').getTime());
  assert.equal(r.ausFaellig(z, mo2301, faellig), null, 'schon bedient');
  assert.equal(r.ausFaellig(z, ort('2026-10-12T23:20:00'), null), null, 'nach 10 Minuten nicht mehr nachholen');
  assert.equal(r.ausFaellig(z, ort('2026-10-11T23:01:00'), null), null, 'Sonntag nicht gewählt');
  assert.equal(r.ausFaellig({ ...z, aktiv: false }, mo2301, null), null);
  assert.equal(r.naechster(z.an, mo2301), ort('2026-10-13T07:05:00').getTime());
  assert.equal(r.naechster(z.an, ort('2026-10-17T08:00:00')), ort('2026-10-19T07:05:00').getTime(), 'Sa 8 Uhr → Mo');
  assert.throws(() => r.zeitplanNormal({ aktiv: true, aus: { tage: [], zeit: '23:00' }, an: { zeit: '07:00' } }), (e) => e.details.feld === 'zeitplan.aus.tage');
  assert.throws(() => r.zeitplanNormal({ aus: { zeit: '25:00' }, an: { zeit: '07:00' } }), (e) => e.details.feld === 'zeitplan.aus.zeit');
});

test('energie: Wake-on-LAN – MAC, Magic Packet, ethtool, Unit, Geräte', () => {
  assert.equal(r.macNormal('02-00-5e-10-00-75'), '02:00:5e:10:00:75');
  assert.throws(() => r.macNormal('c8:d3:ff'), (e) => e.code === 'E_PARAMS');
  const p = r.magicPacket('02:00:5e:10:00:75');
  assert.equal(p.length, 102); assert.ok(p.subarray(0, 6).every((b) => b === 0xff)); assert.equal(p.subarray(6, 12).toString('hex'), 'c8d3ffa0b975'); assert.equal(p.subarray(96).toString('hex'), 'c8d3ffa0b975');
  assert.deepEqual(r.ethtoolWol('Settings for eno1:\n\tSupports Wake-on: pumbg\n\tWake-on: g\n'), { unterstuetzt: 'pumbg', aktuell: 'g' });
  assert.match(r.wolUnit('eno1', true), /ExecStart=\/usr\/sbin\/ethtool -s eno1 wol g/);
  assert.match(r.wolUnit('eno1', false), /wol d$/m);
  assert.throws(() => r.wolUnit('eno1; rm', true), (e) => e.code === 'E_PARAMS');
  assert.deepEqual(r.wolGeraeteNormal([{ name: 'Kinder-PC', mac: '00-11-22-33-44-55' }]), [{ name: 'Kinder-PC', mac: '00:11:22:33:44:55' }]);
});

test('energie: Magic Packet geht an Broadcast Port 9', async () => {
  const gesendet = [];
  const s = Object.assign(new EventEmitter(), { bind: (_p, f) => f(), setBroadcast: (b) => gesendet.push({ broadcast: b }), send: (buf, port, ziel, f) => { gesendet.push({ laenge: buf.length, port, ziel }); f(); }, close: () => {} });
  assert.equal(await energie.aufwecken('00:11:22:33:44:55', { socketBauen: () => s }), 102);
  assert.deepEqual(gesendet, [{ broadcast: true }, { laenge: 102, port: 9, ziel: '255.255.255.255' }]);
});

test('energie: USV – Eingaben, NUT-Dateien (USB/Netz), nut-scanner, upsc, Entscheidung', () => {
  const u = r.usvNormal({ aktiv: true, art: 'usb', akku_unter: 25 });
  assert.match(u.monitor_passwort, /^[0-9a-f]{24}$/);
  const scan = r.nutScannerParsen('[nutdev1]\n\tdriver = "usbhid-ups"\n\tport = "auto"\n\tvendorid = "051D"\n\tproductid = "0002"\n\tproduct = "Back-UPS ES 700G"\n\tvendor = "American Power Conversion"\n\tbus = "001"\n');
  assert.deepEqual(scan, { driver: 'usbhid-ups', port: 'auto', vendorid: '051D', productid: '0002', product: 'Back-UPS ES 700G', vendor: 'American Power Conversion', bus: '001' });
  assert.equal(r.nutScannerParsen(''), null);
  const d = r.nutDateien(u, scan);
  assert.match(d['nut.conf'], /^MODE=standalone$/m);
  assert.match(d['ups.conf'], /\[fahnas\]\n {2}driver = "usbhid-ups"\n {2}port = "auto"/); assert.match(d['ups.conf'], /vendorid = "051D"/);
  assert.match(d['upsd.conf'], /^LISTEN 127\.0\.0\.1 3493$/m);
  assert.ok(d['upsd.users'].includes(`password = "${u.monitor_passwort}"`) && d['upsmon.conf'].includes(`MONITOR fahnas@localhost 1 fahnas-monitor "${u.monitor_passwort}" primary`));
  const n = r.usvNormal({ aktiv: true, art: 'netz', host: '192.168.1.23', ups: 'ups', benutzer: 'monuser', passwort: 'secret' });
  const dn = r.nutDateien(n);
  assert.match(dn['nut.conf'], /MODE=netclient/); assert.match(dn['upsmon.conf'], /MONITOR ups@192\.168\.1\.23 1 monuser "secret" secondary/);
  assert.ok(!dn['ups.conf'] && !dn['upsd.users']);
  assert.equal(r.usvNormal({ passwort: '' }, n).passwort, 'secret', 'leer = unverändert');
  assert.throws(() => r.usvNormal({ aktiv: true, art: 'netz', host: '', benutzer: 'x', passwort: 'y' }), (e) => e.details.feld === 'usv.host');
  assert.throws(() => r.usvNormal({ akku_unter: 2 }), (e) => e.details.feld === 'usv.akku_unter');
  const z = r.upscParsen('battery.charge: 87\nbattery.runtime: 1260\ndevice.mfr: American Power Conversion\ndevice.model: Back-UPS ES 700G\nups.load: 12\nups.status: OB DISCHRG\n');
  assert.deepEqual(z, { status: 'OB DISCHRG', netz: false, akku: true, schwach: false, ladung: 87, restzeit_s: 1260, last: 12, modell: 'American Power Conversion Back-UPS ES 700G' });
  const merk = { auf_akku_seit: null };
  const e1 = r.usvEntscheiden(z, { akku_unter: 30, minuten_auf_akku: 5 }, merk, 1_000_000);
  assert.match(e1.meldung.titel, /Stromausfall/); assert.equal(e1.herunterfahren, undefined);
  assert.equal(r.usvEntscheiden(z, { akku_unter: 30, minuten_auf_akku: 5 }, merk, 1_000_000 + 60_000).meldung, undefined, 'nur einmal melden');
  assert.match(r.usvEntscheiden(z, { akku_unter: 30, minuten_auf_akku: 5 }, merk, 1_000_000 + 5 * 60_000).herunterfahren, /5 Minuten auf Akku/);
  assert.match(r.usvEntscheiden({ ...z, ladung: 29 }, { akku_unter: 30, minuten_auf_akku: 0 }, merk, 1_000_000 + 70_000).herunterfahren, /Akkustand 29 %/);
  const e3 = r.usvEntscheiden({ ...z, akku: false, netz: true, status: 'OL' }, { akku_unter: 30, minuten_auf_akku: 0 }, merk, 2_000_000);
  assert.match(e3.meldung.titel, /Strom wieder da/); assert.equal(merk.auf_akku_seit, null);
});

/** Schein-System und Werkzeuge. */
async function aufbau({ aufgaben = [], upsc = 'ups.status: OL\nbattery.charge: 100\n', scanner = '[nutdev1]\n\tdriver = "usbhid-ups"\n\tport = "auto"\n', nutTarget = 'disabled' } = {}) {
  const konfig = new Konfig(path.join(wurzel, `k-${Math.random().toString(36).slice(2)}`)); await konfig.sicherstellen();
  const aufrufe = []; const gemeldet = [];
  const system = { ausfuehren: async (p, a) => {
    aufrufe.push([p, ...a].join(' '));
    if (p === 'ip') return { stdout: '[{"dst":"default","gateway":"192.168.1.1","dev":"eno1"}]' };
    if (p === 'ethtool') return { stdout: a.length === 1 ? '\tSupports Wake-on: pumbg\n\tWake-on: d\n' : '' };
    if (p === 'dpkg-query') return { stdout: 'install ok installed' };
    if (p === 'nut-scanner') return { stdout: scanner };
    if (p === 'getent') return { stdout: '' };
    if (p === 'upsc') return { stdout: upsc };
    if (p === 'systemctl' && a[0] === 'is-enabled') return { stdout: `${nutTarget}\n` };
    if (['systemctl', 'rtcwake'].includes(p)) return { stdout: '' };
    throw new Error(`unerwartet ${p}`);
  } };
  const w = { konfig, system, konfigGeaendert: () => {}, aufgaben: { liste: () => aufgaben }, intern: async (aktion, p) => { gemeldet.push({ aktion, ...p }); return { ergebnis: null }; } };
  const aktionen = {}; energie.registriere({ aktion: (n, d) => { aktionen[n] = d; } }, w);
  const rufe = (n, p = {}) => aktionen[n].ausfuehren(p, {}, w, { fortschritt: () => {} });
  return { w, aufrufe, gemeldet, rufe };
}

test('energie: Aktionen – Wake-on-LAN an (dauerhaft), USV per USB einrichten, Status, Ansicht ohne Passwörter', async () => {
  const u = await aufbau();
  const e = await u.rufe('energie.speichern', { wol: { an: true, geraete: [{ name: 'PC', mac: '001122334455' }] }, usv: { aktiv: true, art: 'usb', akku_unter: 30 } });
  assert.ok(u.aufrufe.includes('ethtool -s eno1 wol g'));
  assert.match(await fs.readFile(process.env.FAHNAS_WOL_UNIT, 'utf8'), /ethtool -s eno1 wol g/);
  assert.ok(u.aufrufe.includes('systemctl enable fahnas-wol.service'));
  assert.deepEqual(e.wol_geraete, [{ name: 'PC', mac: '00:11:22:33:44:55' }]);
  assert.equal(e.usv_treiber.driver, 'usbhid-ups');
  assert.match(await fs.readFile(path.join(process.env.FAHNAS_NUT, 'ups.conf'), 'utf8'), /driver = "usbhid-ups"/);
  assert.equal((await fs.stat(path.join(process.env.FAHNAS_NUT, 'upsd.users'))).mode & 0o777, 0o640);
  assert.ok(u.aufrufe.includes('systemctl restart nut-server.service') && u.aufrufe.includes('systemctl restart nut-monitor.service'));
  assert.ok(!JSON.stringify(e).includes((await u.w.konfig.laden('energie.json')).usv.monitor_passwort), 'kein Passwort in der Ansicht');
  const s = await u.rufe('energie.status');
  assert.equal(s.usv.netz, true); assert.equal(s.usv.ladung, 100);
  const ohne = await aufbau({ scanner: '' });
  await assert.rejects(ohne.rufe('energie.speichern', { usv: { aktiv: true, art: 'usb' } }), (f) => f.code === 'E_NICHT_GEFUNDEN' && /Keine USV/.test(f.message));
});

test('energie: USV aus – kein NUT-Dienst bleibt an, ups.conf ohne Gerät (sonst Neustart-Schleife des Treibers)', async () => {
  const u = await aufbau();
  await u.rufe('energie.speichern', { usv: { aktiv: true, art: 'usb', akku_unter: 30 } });
  assert.ok(u.aufrufe.includes('systemctl enable nut.target'), 'USB: nach „aus“ wieder einschalten, sonst startet nach dem Neustart nichts');
  assert.ok(u.aufrufe.includes('systemctl enable nut-driver-enumerator.path'));
  u.aufrufe.length = 0;
  await u.rufe('energie.speichern', { usv: { aktiv: false, art: 'usb', akku_unter: 30 } });
  const conf = await fs.readFile(path.join(process.env.FAHNAS_NUT, 'ups.conf'), 'utf8');
  assert.doesNotMatch(conf, /^\s*\[/m, 'kein Gerät mehr in ups.conf');
  for (const s of ['nut.target', 'nut-monitor.service', 'nut-server.service', 'nut-driver-enumerator.path', 'nut-driver-enumerator.service', 'nut-driver.target']) {
    assert.ok(u.aufrufe.includes(`systemctl disable --now ${s}`), `${s} bleibt sonst an`);
  }
  assert.ok(u.aufrufe.indexOf('systemctl restart nut-driver-enumerator.service') >= 0, 'Enumerator räumt nut-driver@fahnas ab');
  assert.ok(u.aufrufe.indexOf('systemctl restart nut-driver-enumerator.service') < u.aufrufe.indexOf('systemctl disable --now nut-driver-enumerator.service'), 'erst abräumen, dann abschalten');
});

test('energie: Netzwerk-USV – lokaler Treiber weg, Monitor bleibt beim Hochfahren dabei', async () => {
  const u = await aufbau();
  await u.rufe('energie.speichern', { usv: { aktiv: true, art: 'usb', akku_unter: 30 } });
  u.aufrufe.length = 0;
  await u.rufe('energie.speichern', { usv: { aktiv: true, art: 'netz', host: '192.168.1.23', ups: 'ups', benutzer: 'monuser', passwort: 'geheim', akku_unter: 30 } });
  assert.doesNotMatch(await fs.readFile(path.join(process.env.FAHNAS_NUT, 'ups.conf'), 'utf8'), /^\s*\[/m);
  assert.ok(u.aufrufe.includes('systemctl disable --now nut-server.service'));
  assert.ok(!u.aufrufe.includes('systemctl disable --now nut.target'), 'nut-monitor hängt an nut.target');
  assert.ok(u.aufrufe.includes('systemctl enable nut.target'));
  assert.ok(u.aufrufe.includes('systemctl restart nut-monitor.service'));
});

test('energie: Start räumt NUT-Reste ab, wenn die USV aus ist; ohne Reste passiert nichts', async () => {
  const rest = await aufbau({ nutTarget: 'enabled' });
  assert.equal(await rest.rufe('energie.apply'), true);
  assert.ok(rest.aufrufe.includes('systemctl disable --now nut.target'));
  const sauber = await aufbau();
  assert.equal(await sauber.rufe('energie.apply'), false);
  assert.ok(!sauber.aufrufe.some((z) => z.startsWith('systemctl disable')));
});

test('energie: Takt – Zeitplan fährt herunter (mit RTC-Wecker), nur einmal; Aufschub bei laufenden Aufgaben; USV-Grenze', async () => {
  const u = await aufbau();
  await u.rufe('energie.speichern', { zeitplan: { aktiv: true, aus: { tage: [1], zeit: '23:00' }, an: { aktiv: true, tage: [2], zeit: '07:00' } } });
  assert.equal(await energie.taktPruefen(u.w, ort('2026-10-12T22:59:00')), null);
  assert.equal(await energie.taktPruefen(u.w, ort('2026-10-12T23:00:20')), 'aus');
  assert.ok(u.aufrufe.includes(`rtcwake -m no -t ${Math.floor(ort('2026-10-13T07:00:00').getTime() / 1000)}`));
  assert.ok(u.aufrufe.includes('systemctl poweroff'));
  assert.ok(u.gemeldet.some((m) => m.titel === 'NAS fährt herunter'));
  assert.equal(await energie.taktPruefen(u.w, ort('2026-10-12T23:05:00')), null, 'nach dem Wiederanschalten nicht gleich wieder aus');

  const a = await aufbau({ aufgaben: [{ status: 'laeuft', aktion: 'spiegelung.starten' }] });
  await a.rufe('energie.speichern', { zeitplan: { aktiv: true, aus: { tage: [1], zeit: '23:00' }, an: { aktiv: false, zeit: '07:00' } } });
  assert.equal(await energie.taktPruefen(a.w, ort('2026-10-12T23:00:10')), 'aufschub');
  assert.ok(a.gemeldet.some((m) => m.titel === 'Ausschalten verschoben'));
  assert.equal(await energie.taktPruefen(a.w, ort('2026-10-12T23:05:00')), null, 'während des Aufschubs nichts');
  a.w.aufgaben.liste = () => [];
  assert.equal(await energie.taktPruefen(a.w, ort('2026-10-12T23:10:30')), 'aus', 'nach dem Aufschub aus, wenn nichts mehr läuft');
  assert.ok(!a.aufrufe.some((x) => x.startsWith('rtcwake')), 'ohne Einschalt-Plan kein Wecker');

  energie._test.merk.auf_akku_seit = null;
  const b = await aufbau({ upsc: 'ups.status: OB\nbattery.charge: 20\n' });
  await b.rufe('energie.speichern', { usv: { aktiv: true, art: 'usb', akku_unter: 30 } });
  assert.equal(await energie.taktPruefen(b.w, ort('2026-10-12T12:00:00')), 'usv');
  assert.ok(b.gemeldet.some((m) => m.art === 'usv' && /Stromausfall/.test(m.titel)));
  assert.ok(b.aufrufe.includes('systemctl poweroff'));
  energie._test.merk.auf_akku_seit = null;
});
