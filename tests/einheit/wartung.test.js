// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Wartung (12.10.2026): Prüfplan (wöchentlich kurz, monatlich gründlich + RAID), Selbsttest-Protokoll, Dateien für
// unattended-upgrades, Update-Log, schwache Passwörter, Aktionen mit Schein-smartctl und der Sicherheits-Check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as r from '../../src/agent/wartung/regeln.js';
import * as wartung from '../../src/agent/aktionen/wartung.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import { hashErzeugen } from '../../src/agent/totp.js';

const lokal = (j, mo, t, h, mi) => new Date(j, mo - 1, t, h, mi);

test('wartung: Prüfplan – Sonntag 03:30 kurz, erster Sonntag im Monat gründlich + RAID, nicht doppelt, nachholen bis Tagesende', () => {
  const plan = r.normal({}).pruefungen;
  assert.deepEqual(plan, { aktiv: true, tag: 0, zeit: '03:30', smart_lang: true, raid: true });
  assert.deepEqual(r.faellig(plan, {}, lokal(2026, 10, 18, 3, 29)), [], 'vor der Uhrzeit');
  assert.deepEqual(r.faellig(plan, {}, lokal(2026, 10, 18, 3, 30)), ['smart_kurz'], '3. Sonntag: kurz');
  assert.deepEqual(r.faellig(plan, {}, lokal(2026, 10, 4, 9, 0)), ['smart_lang', 'raid'], '1. Sonntag: gründlich + RAID (nachgeholt)');
  assert.deepEqual(r.faellig(plan, { smart: lokal(2026, 10, 18, 3, 31).getTime() }, lokal(2026, 10, 18, 5, 0)), [], 'schon gelaufen');
  assert.deepEqual(r.faellig(plan, {}, lokal(2026, 10, 19, 3, 30)), [], 'Montag');
  assert.deepEqual(r.faellig({ ...plan, smart_lang: false, raid: false }, {}, lokal(2026, 10, 4, 4, 0)), ['smart_kurz']);
  assert.deepEqual(r.faellig({ ...plan, aktiv: false }, {}, lokal(2026, 10, 18, 4, 0)), []);
  const n = r.naechsterTermin(plan, lokal(2026, 10, 12, 16, 0));
  assert.equal(new Date(n.zeit).getDate(), 18); assert.equal(n.art, 'smart_kurz');
  assert.equal(r.naechsterTermin(plan, lokal(2026, 10, 30, 12, 0)).art, 'smart_lang', '1. November ist ein Sonntag');
  assert.throws(() => r.normal({ pruefungen: { zeit: '25:00' } }, { streng: true }), (e) => e.details.feld === 'pruefungen.zeit');
  assert.throws(() => r.normal({ auto_updates: { umfang: 'beta' } }, { streng: true }), (e) => e.details.feld === 'auto_updates.umfang');
});

test('wartung: Selbsttest-Protokoll (ATA läuft/bestanden/fehlgeschlagen, NVMe)', () => {
  assert.deepEqual(r.selbsttestAuswerten({ ata_smart_data: { self_test: { status: { value: 249, string: 'in progress, 90% remaining', remaining_percent: 90 } } } }), { laeuft: true, bestanden: null, text: 'in progress, 90% remaining', prozent_rest: 90 });
  const ok = r.selbsttestAuswerten({ ata_smart_data: { self_test: { status: { value: 0, passed: true } } }, ata_smart_self_test_log: { standard: { table: [{ type: { string: 'Short offline' }, status: { value: 0, string: 'Completed without error', passed: true }, lifetime_hours: 1234 }] } } });
  assert.deepEqual([ok.laeuft, ok.bestanden, ok.text], [false, true, 'Short offline: Completed without error']);
  const kaputt = r.selbsttestAuswerten({ ata_smart_self_test_log: { standard: { table: [{ type: { string: 'Extended offline' }, status: { value: 121, string: 'Completed: read failure', passed: false } }] } } });
  assert.equal(kaputt.bestanden, false);
  assert.equal(r.selbsttestAuswerten({ nvme_self_test_log: { current_self_test_operation: { value: 1, string: 'Short' }, current_self_test_completion_percent: 30 } }).prozent_rest, 70);
  assert.equal(r.selbsttestAuswerten({ nvme_self_test_log: { current_self_test_operation: { value: 0 }, table: [{ self_test_code: { string: 'Short' }, self_test_result: { value: 0, string: 'Completed without error' } }] } }).bestanden, true);
  assert.equal(r.selbsttestAuswerten(null).bestanden, null);
});

test('wartung: unattended-upgrades-Dateien und letzter Lauf aus dem Log', () => {
  const d = r.autoUpdateDateien({ aktiv: true, umfang: 'alle', zeit: '04:00', neustart: true, neustart_zeit: '04:30' });
  assert.match(d.periodic, /Unattended-Upgrade "1"/);
  assert.match(d.unattended, /Automatic-Reboot "true"/); assert.match(d.unattended, /Automatic-Reboot-Time "04:30"/); assert.match(d.unattended, /\$\{distro_codename\}-updates/);
  assert.match(d.timer, /OnCalendar=\nOnCalendar=\*-\*-\* 04:00:00/);
  const aus = r.autoUpdateDateien({ aktiv: false, umfang: 'sicherheit', zeit: '03:00', neustart: false, neustart_zeit: '04:30' });
  assert.match(aus.periodic, /Unattended-Upgrade "0"/); assert.ok(!/-updates/.test(aus.unattended));
  const log = '2026-10-11 06:01:25,687 INFO Starting unattended upgrades script\n2026-10-11 06:01:26,660 INFO No packages found that can be upgraded unattended and no pending auto-removals\n2026-10-12 06:01:25,687 INFO Starting unattended upgrades script\n2026-10-12 06:01:30,100 INFO Packages that will be upgraded: libx11-6 libx11-data\n2026-10-12 06:02:00,000 INFO All upgrades installed\n';
  const l = r.letzterUpdateLauf(log);
  assert.equal(l.text, 'Eingespielt: libx11-6 libx11-data'); assert.equal(new Date(l.zeit).getDate(), 12); assert.equal(l.fehler, false);
  assert.equal(r.letzterUpdateLauf(''), null);
});

test('wartung: schwache Passwörter und .env-Werte', () => {
  for (const w of ['admin', 'Passwort', '1234567890', 'aaaaaaaaaa', 'kurz']) assert.equal(r.schwachesPasswort(w), true, w);
  for (const w of ['', 'Tz7!pQ2-xL9#', 'eine-lange-passphrase-aus-woertern']) assert.equal(r.schwachesPasswort(w), false, w);
  assert.equal(r.schwachesPasswort('fabian', { name: 'fabian' }), true);
  assert.deepEqual(r.envLesen('A=1\nADMIN_PASSWORD="admin"\n# x\nB = \'zwei\'\n'), { A: '1', ADMIN_PASSWORD: 'admin', B: 'zwei' });
  assert.ok(r.GEHEIM_SCHLUESSEL.test('ADMIN_PASSWORD') && r.GEHEIM_SCHLUESSEL.test('API_KEY') && !r.GEHEIM_SCHLUESSEL.test('TZ'));
  assert.ok(r.einfachePasswoerter('fabian').includes('fabian123'));
});

async function aufbau() {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-wartung-'));
  const konfig = new Konfig(path.join(wurzel, 'config')); await konfig.sicherstellen();
  process.env.FAHNAS_APT_CONF_D = path.join(wurzel, 'apt.conf.d');
  process.env.FAHNAS_UNITS = path.join(wurzel, 'systemd');
  process.env.FAHNAS_UU_LOG = path.join(wurzel, 'uu.log');
  process.env.FAHNAS_REBOOT_REQUIRED = path.join(wurzel, 'reboot-required');
  const befehle = []; const meldungen = []; const interne = [];
  const st = { smart: {} };
  const system = { ausfuehren: async (prog, args = []) => {
    befehle.push([prog, ...args].join(' '));
    if (prog === 'dpkg-query') return { code: 0, stdout: 'install ok installed' };
    if (prog === 'lsblk') return { code: 0, stdout: JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk', model: 'WD Red', tran: 'sata' }, { name: 'sdb', type: 'disk', model: 'Stick', tran: 'usb' }, { name: 'loop0', type: 'loop' }] }) };
    if (prog === 'smartctl' && args[0] === '-t') return { code: 0, stdout: args[2] === '/dev/sdb' ? 'Unknown USB bridge' : 'Testing has begun.' };
    if (prog === 'smartctl') return { code: 0, stdout: JSON.stringify(st.smart[args[args.length - 1]] || {}) };
    if (prog === 'sshd') return { code: 0, stdout: 'port 22\npasswordauthentication yes\n' };
    return { code: 0, stdout: '' };
  } };
  const w = { konfig, system, pfade: { apps: path.join(wurzel, 'apps') }, konfigGeaendert: () => {},
    intern: async (a, prm) => { interne.push(a); if (a === 'benachrichtigungen.senden') { meldungen.push(prm); return true; } if (a === 'raid.liste') return { verbuende: [] }; throw Object.assign(new Error('fehlt'), { code: 'E_NICHT_GEFUNDEN' }); } };
  const reg = new Register(); wartung.registriere(reg, w);
  const rufe = async (aktion, params = {}) => { const { aktion: a, params: pp } = reg.vorbereiten(aktion, params, { nutzer: 'chef', rolle: 'admin', ip: '-' }); return a.ausfuehren(pp, { nutzer: 'chef', rolle: 'admin' }, w); };
  return { wurzel, konfig, w, rufe, befehle, meldungen, interne, st, aufraeumen: () => fs.rm(wurzel, { recursive: true, force: true }) };
}

test('wartung: speichern schreibt apt.conf.d + Timer, lesen zeigt Plan/Status; jetzt startet Selbsttests, Takt wertet aus und meldet Fehler', async () => {
  const u = await aufbau();
  try {
    const neu = await u.rufe('wartung.speichern', { auto_updates: { umfang: 'alle', neustart: true, neustart_zeit: '05:15' }, pruefungen: { tag: 6, zeit: '02:00' } });
    assert.deepEqual([neu.auto_updates.umfang, neu.auto_updates.neustart, neu.pruefungen.tag], ['alle', true, 6]);
    assert.match(await fs.readFile(path.join(u.wurzel, 'apt.conf.d', '52fahnas-unattended-upgrades'), 'utf8'), /Automatic-Reboot-Time "05:15"/);
    assert.match(await fs.readFile(path.join(u.wurzel, 'systemd', 'apt-daily-upgrade.timer.d', 'fahnas.conf'), 'utf8'), /04:00:00/);
    assert.ok(u.befehle.includes('systemctl restart apt-daily-upgrade.timer'));
    await assert.rejects(u.rufe('wartung.speichern', { pruefungen: { zeit: 'mittags' } }), (e) => e.code === 'E_PARAMS');
    await fs.writeFile(path.join(u.wurzel, 'reboot-required'), '');
    let l = await u.rufe('wartung.lesen');
    assert.equal(l.updates.neustart_noetig, true); assert.ok(l.naechste_pruefung);
    // Selbsttest jetzt: sda nimmt an, der USB-Stick nicht
    assert.deepEqual(await u.rufe('wartung.jetzt', { art: 'smart_kurz' }), { gestartet: 1 });
    assert.ok(u.befehle.includes('smartctl -t short /dev/sda'));
    l = await u.rufe('wartung.lesen');
    assert.equal(l.smart['/dev/sda'].text, 'läuft'); assert.match(l.smart['/dev/sdb'].text, /nicht unterstützt/);
    // Auswertung erst nach 10 min; dann fehlgeschlagen → Meldung
    u.st.smart['/dev/sda'] = { ata_smart_self_test_log: { standard: { table: [{ type: { string: 'Short offline' }, status: { value: 121, string: 'Completed: read failure', passed: false } }] } } };
    await u.konfig.aendern('wartung_zustand.json', (z) => { z.smart['/dev/sda'].geprueft = 0; return z; });
    await wartung.taktPruefen(u.w, lokal(2026, 10, 14, 12, 0));
    l = await u.rufe('wartung.lesen');
    assert.equal(l.smart['/dev/sda'].bestanden, false);
    assert.equal(u.meldungen.length, 1); assert.equal(u.meldungen[0].stufe, 'fehler');
    const s = await u.rufe('wartung.sicherheit');
    assert.ok(s.some((x) => x.id === 'selbsttest-/dev/sda' && x.stufe === 'fehler' && x.ziel[1] === 'pruefungen'));
    assert.ok(s.some((x) => x.id === 'neustart'));
  } finally { await u.aufraeumen(); }
});

test('wartung: Sicherheits-Check – Admin ohne 2FA, einfaches Passwort, Gästefreigabe, SSH mit Passwort, Updates aus, schwaches App-Passwort', async () => {
  const u = await aufbau();
  try {
    await u.konfig.speichern('users.json', { nutzer: [
      { name: 'chef', rolle: 'admin', hash: await hashErzeugen('chef1234'), totp: null },
      { name: 'anna', rolle: 'nutzer', hash: await hashErzeugen('Tz7!pQ2-xL9#'), totp: null },
      { name: 'bert', rolle: 'admin', hash: await hashErzeugen('Kl4!mN8-zQ1#'), totp: { geheim: 'x' } },
    ] });
    await u.konfig.speichern('shares.json', { freigaben: [{ name: 'offen', gaeste: true }, { name: 'zu', gaeste: false }] });
    await u.konfig.speichern('system.json', { ssh: true });
    await u.rufe('wartung.speichern', { auto_updates: { aktiv: false } });
    await fs.mkdir(path.join(u.wurzel, 'apps', 'wiki'), { recursive: true });
    await fs.writeFile(path.join(u.wurzel, 'apps', 'wiki', '.env'), 'TZ=Europe/Berlin\nADMIN_PASSWORD=admin\n');
    await fs.mkdir(path.join(u.wurzel, 'apps', 'gut'), { recursive: true });
    await fs.writeFile(path.join(u.wurzel, 'apps', 'gut', '.env'), 'DB_PASSWORD=Hx9!vK2#mP7q\n');
    const ids = (await u.rufe('wartung.sicherheit')).map((x) => `${x.id}:${x.stufe}`).sort();
    assert.deepEqual(ids, ['2fa-chef:warnung', 'app-pw-wiki:warnung', 'auto-updates:warnung', 'gast-offen:hinweis', 'pw-chef:fehler', 'ssh:hinweis']);
  } finally { await u.aufraeumen(); }
});

test('wartung: RAID-Datenprüfung mit der echten intern-Form {ergebnis} (Echtprobe-Fund 12.10.2026)', async () => {
  const u = await aufbau();
  try {
    const gerufen = [];
    u.w.intern = async (a, prm) => { gerufen.push(a); if (a === 'raid.liste') return { ergebnis: { verbuende: [{ name: 'daten', stufe: 'raid5', zustand: 'ok', fortschritt: null }, { name: 'tempo', stufe: 'raid0', zustand: 'ok' }] } }; if (a === 'raid.pruefen') return { ergebnis: { name: prm.name } }; return { ergebnis: null }; };
    assert.deepEqual(await u.rufe('wartung.jetzt', { art: 'raid' }), { gestartet: 1 });
    assert.deepEqual(gerufen, ['raid.liste', 'raid.pruefen']);
  } finally { await u.aufraeumen(); }
});
