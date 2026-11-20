// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Benachrichtigungen (Betreiber 12.10.2026): Mailtext, curl-Argumente (Passwort nie auf der Befehlszeile), echter
// Versand an einen Schein-SMTP-Server (Linux mit curl), ntfy mit Schein-fetch, Ereignis → Meldung, App-Abstürze,
// Einstellungen prüfen/verdecken, doppelte Meldungen, abgeschaltete Arten, Verlauf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as system from '../../src/gemeinsam/system.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { mailText, betreffKodieren, curlMailArgumente, emailSenden, ntfySenden, ntfyNachricht, meldungAusEreignis, appProblem } from '../../src/agent/benachrichtigung/senden.js';
import { eingabePruefen, ansicht, melden, appsPruefen, STANDARD, _test, sperreMelden, sammelSenden } from '../../src/agent/aktionen/benachrichtigungen.js';

test('benachrichtigung: Mailtext und curl-Argumente', () => {
  const m = mailText({ von: 'nas@x.de', an: ['a@x.de', 'b@x.de'], betreff: 'Platte fast voll ä', text: 'Zeile 1\nZeile 2', jetzt: new Date('2026-10-12T10:00:00Z') });
  assert.match(m, /^From: FAH-NAS <nas@x\.de>\r\nTo: a@x\.de, b@x\.de\r\n/);
  assert.ok(m.includes(`Subject: ${betreffKodieren('Platte fast voll ä')}`));
  assert.ok(m.includes('Content-Type: text/plain; charset=UTF-8') && m.includes('Zeile 1\r\nZeile 2'));
  const e = { server: 'smtp.x.de', port: 587, sicherheit: 'starttls', benutzer: 'nas@x.de', passwort: 'GEHEIM', absender: 'nas@x.de', empfaenger: ['a@x.de'] };
  const a = curlMailArgumente(e, '/tmp/n');
  assert.ok(a.includes('smtp://smtp.x.de:587') && a.includes('--ssl-reqd') && a.includes('--netrc-file'));
  assert.ok(!a.join(' ').includes('GEHEIM'), 'Passwort nie auf der Befehlszeile');
  assert.ok(curlMailArgumente({ ...e, sicherheit: 'tls', port: 465 }, '/tmp/n').includes('smtps://smtp.x.de:465'));
});

/** Minimaler SMTP-Schein-Server: EHLO mit AUTH, nimmt eine Mail an und merkt sich Anmeldung und Daten. */
function scheinSmtp() {
  const empfangen = [];
  const server = net.createServer((s) => {
    let daten = false; let puffer = ''; let warteAuf = null; const mail = { auth: null, von: null, an: [], text: '' };
    s.write('220 schein ESMTP\r\n');
    s.on('data', (d) => {
      puffer += d.toString('utf8');
      let i;
      while ((i = puffer.indexOf('\r\n')) >= 0) {
        const z = puffer.slice(0, i); puffer = puffer.slice(i + 2);
        if (daten) { if (z === '.') { daten = false; empfangen.push(mail); s.write('250 OK\r\n'); } else mail.text += `${z}\n`; continue; }
        if (/^EHLO/i.test(z)) s.write('250-schein\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (warteAuf === 'plain') { warteAuf = null; mail.auth = Buffer.from(z, 'base64').toString('utf8').split('\0'); s.write('235 OK\r\n'); }
        else if (warteAuf === 'login-name') { warteAuf = 'login-pw'; mail.auth = ['', Buffer.from(z, 'base64').toString('utf8')]; s.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (warteAuf === 'login-pw') { warteAuf = null; mail.auth.push(Buffer.from(z, 'base64').toString('utf8')); s.write('235 OK\r\n'); }
        else if (/^AUTH PLAIN \S+/i.test(z)) { mail.auth = Buffer.from(z.split(' ')[2], 'base64').toString('utf8').split('\0'); s.write('235 OK\r\n'); }
        else if (/^AUTH PLAIN$/i.test(z)) { warteAuf = 'plain'; s.write('334 \r\n'); }
        else if (/^AUTH LOGIN/i.test(z)) { warteAuf = 'login-name'; s.write('334 VXNlcm5hbWU6\r\n'); }
        else if (/^MAIL FROM/i.test(z)) { mail.von = z; s.write('250 OK\r\n'); }
        else if (/^RCPT TO/i.test(z)) { mail.an.push(z); s.write('250 OK\r\n'); }
        else if (/^DATA/i.test(z)) { daten = true; s.write('354 weiter\r\n'); }
        else if (/^QUIT/i.test(z)) { s.write('221 tschüss\r\n'); s.end(); }
        else s.write('250 OK\r\n');
      }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, empfangen })));
}

test('benachrichtigung: echte Mail per curl an einen Schein-Server (Anmeldung, Umlaute)', async (t) => {
  if (process.platform !== 'linux' || !(await system.existiert('/usr/bin/curl'))) { t.skip('curl fehlt'); return; }
  const s = await scheinSmtp();
  try {
    await emailSenden(system, { server: '127.0.0.1', port: s.port, sicherheit: 'keine', benutzer: 'nas@x.de', passwort: 'p@ss wört#1', absender: 'nas@x.de', empfaenger: ['ich@x.de'] }, { betreff: 'Spiegelung „Sicherung“ fehlgeschlagen', text: 'Prüfen!' });
    assert.equal(s.empfangen.length, 1);
    assert.deepEqual(s.empfangen[0].auth.slice(1), ['nas@x.de', 'p@ss wört#1'], 'Anmeldung mit Sonderzeichen-Passwort aus der netrc-Datei');
    assert.match(s.empfangen[0].an[0], /ich@x\.de/);
    assert.ok(s.empfangen[0].text.includes(betreffKodieren('Spiegelung „Sicherung“ fehlgeschlagen')));
    s.empfangen.length = 0;
    await emailSenden(system, { server: '127.0.0.1', port: s.port, sicherheit: 'keine', benutzer: 'nas@x.de', passwort: 'a"b\\c d', absender: 'nas@x.de', empfaenger: ['ich@x.de'] }, { betreff: 'x', text: 'y' });
    assert.equal(s.empfangen[0].auth[2], 'a"b\\c d', 'Anführungszeichen und Backslash im Passwort');
    await assert.rejects(emailSenden(system, { server: '127.0.0.1', port: 1, sicherheit: 'keine', absender: 'nas@x.de', empfaenger: ['ich@x.de'] }, { betreff: 'x', text: 'y' }), /E-Mail konnte nicht gesendet werden/);
  } finally { s.server.close(); }
});

test('benachrichtigung: ntfy – JSON, Priorität, Token/Benutzer, Fehler', async () => {
  const aufrufe = [];
  const holen = async (url, o) => { aufrufe.push({ url, o }); return { ok: true, status: 200 }; };
  await ntfySenden({ server: 'https://ntfy.sh/', thema: 'fah-nas', token: 'tk_x' }, { titel: 'Titel ä', text: 'Text', stufe: 'fehler' }, holen);
  assert.equal(aufrufe[0].url, 'https://ntfy.sh');
  assert.equal(aufrufe[0].o.headers.Authorization, 'Bearer tk_x');
  assert.deepEqual(JSON.parse(aufrufe[0].o.body), ntfyNachricht({ thema: 'fah-nas' }, { titel: 'Titel ä', text: 'Text', stufe: 'fehler' }));
  assert.equal(JSON.parse(aufrufe[0].o.body).priority, 5);
  await ntfySenden({ server: 'https://n.x', thema: 't', benutzer: 'u', passwort: 'p' }, { titel: 'a', text: 'b', stufe: 'info' }, holen);
  assert.equal(aufrufe[1].o.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  await assert.rejects(ntfySenden({ server: 'https://n.x', thema: 't' }, { titel: 'a', text: 'b' }, async () => ({ ok: false, status: 403 })), /Zugang prüfen/);
});

test('benachrichtigung: Ereignis → Meldung, App-Probleme', () => {
  assert.equal(meldungAusEreignis({ ereignis: 'system', art: 'platte_voll', daten: { prozent: 91.6 } }).titel, 'Datenplatte fast voll');
  assert.equal(meldungAusEreignis({ ereignis: 'system', art: 'update_fertig', daten: { anzahl: 3, neustart_noetig: false } }), null);
  assert.equal(meldungAusEreignis({ ereignis: 'system', art: 'update_fertig', daten: { anzahl: 3, neustart_noetig: true } }).art, 'updates');
  const s = meldungAusEreignis({ ereignis: 'spiegelung', id: 's-1', zustand: 'fertig', ergebnis: 'fehler', meldung: 'kaputt' }, { spiegelung: { 's-1': 'Sicherung' } });
  assert.equal(s.titel, 'Spiegelung „Sicherung“ fehlgeschlagen'); assert.equal(s.stufe, 'fehler');
  assert.equal(meldungAusEreignis({ ereignis: 'spiegelung', zustand: 'fertig', ergebnis: 'ok' }), null);
  assert.equal(appProblem({ autostart: true, zustand: 'exited' }), 'läuft nicht mehr');
  assert.equal(appProblem({ autostart: true, zustand: 'exited', von_hand_gestoppt: true }), null, 'von Hand gestoppt → kein Alarm');
  assert.equal(appProblem({ autostart: false, zustand: 'dead' }), null);
  assert.equal(appProblem({ autostart: true, zustand: 'running', gesundheit: 'unhealthy' }), 'meldet sich als ungesund');
});

test('benachrichtigung: Einstellungen prüfen – Geheimnisse bleiben, Ansicht verdeckt', () => {
  const alt = structuredClone(STANDARD); alt.email.passwort = 'alt'; alt.ntfy.token = 'tk';
  const neu = eingabePruefen({ email: { aktiv: true, server: 'smtp.x.de', absender: 'nas@x.de', empfaenger: 'a@x.de; b@x.de', passwort: '' }, ntfy: { aktiv: true, server: 'https://ntfy.sh/', thema: 'fah-nas', token: '' }, ereignisse: { vpn: true, gibtsnicht: true } }, alt);
  assert.equal(neu.email.passwort, 'alt'); assert.equal(neu.ntfy.token, 'tk');
  assert.deepEqual(neu.email.empfaenger, ['a@x.de', 'b@x.de']); assert.equal(neu.ntfy.server, 'https://ntfy.sh');
  assert.equal(neu.ereignisse.vpn, true); assert.ok(!('gibtsnicht' in neu.ereignisse));
  assert.throws(() => eingabePruefen({ email: { aktiv: true, server: 'x', absender: 'kaputt', empfaenger: 'a@x.de' } }, alt), /Absender/);
  assert.throws(() => eingabePruefen({ ntfy: { aktiv: true, server: 'ntfy.sh', thema: 'x' } }, alt), /http/);
  const a = ansicht(neu);
  assert.ok(!('passwort' in a.email) && a.email.passwort_gesetzt && a.ntfy.token_gesetzt && !('token' in a.ntfy));
});

async function umgebung() {
  const wurzel = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-melden-'));
  const konfig = new Konfig(path.join(wurzel, 'k')); await konfig.sicherstellen();
  const curl = []; const ereignisse = [];
  const w = {
    konfig, ereignis: (art, d) => ereignisse.push({ art, ...d }),
    system: { ausfuehren: async (prog, args, o) => { const i = args.indexOf('--netrc-file'); curl.push({ prog, args, eingabe: o.eingabe, netrc: i >= 0 ? await fs.readFile(args[i + 1], 'utf8') : null }); return { code: 0, stdout: '', stderr: '' }; } },
    intern: async () => ({ ergebnis: [] }),
  };
  return { w, curl, ereignisse, wurzel, aufraeumen: () => fs.rm(wurzel, { recursive: true, force: true }) };
}

test('benachrichtigung: melden – Versand, doppelt unterdrückt, Art abgeschaltet, Verlauf; App-Absturz nach zwei Takten', async () => {
  const u = await umgebung();
  try {
    _test.zuletzt.clear(); _test.appsZustand.clear();
    await u.w.konfig.speichern('benachrichtigungen.json', { ...STANDARD, email: { ...STANDARD.email, aktiv: true, server: 'smtp.x.de', benutzer: 'nas@x.de', passwort: 'GEHEIM', absender: 'nas@x.de', empfaenger: ['ich@x.de'] }, ereignisse: { ...STANDARD.ereignisse, updates: false } });
    const st = await fs.stat(u.w.konfig.pfad('benachrichtigungen.json'));
    assert.equal(st.mode & 0o777, 0o600, 'Zugangsdaten nur für root');
    const e = await melden(u.w, { art: 'platte', stufe: 'warnung', titel: 'Platte voll', text: 'x', schluessel: 'k1' });
    assert.deepEqual(e.kanaele, { email: 'ok' });
    assert.equal(u.curl.length, 1); assert.match(u.curl[0].netrc, /password "GEHEIM"/); assert.ok(!u.curl[0].args.join(' ').includes('GEHEIM'));
    assert.equal(await melden(u.w, { art: 'platte', stufe: 'warnung', titel: 'Platte voll', text: 'x', schluessel: 'k1' }), null, 'doppelt innerhalb 6 h');
    assert.equal(await melden(u.w, { art: 'updates', stufe: 'info', titel: 'U', text: 'x' }), null, 'Art abgeschaltet');
    assert.equal((await u.w.konfig.laden('benachrichtigungen-verlauf.json', [])).length, 1);
    assert.ok(u.ereignisse.some((x) => x.art === 'benachrichtigung'));
    // App-Absturz: zweimal hintereinander schlecht → eine Meldung; wieder gut → Entwarnung
    let zustand = 'exited';
    u.w.intern = async () => ({ ergebnis: [{ name: 'gitea', titel: 'Gitea', autostart: true, zustand }] });
    await appsPruefen(u.w); assert.equal(u.curl.length, 1, 'erster schlechter Takt meldet noch nicht');
    await appsPruefen(u.w); assert.equal(u.curl.length, 2, 'zweiter Takt meldet');
    await appsPruefen(u.w); assert.equal(u.curl.length, 2, 'nicht mehrfach');
    zustand = 'running'; await appsPruefen(u.w); assert.equal(u.curl.length, 3, 'Entwarnung');
    assert.match(u.curl[2].eingabe, /Subject: =\?UTF-8\?B\?/);
  } finally { await u.aufraeumen(); }
});

test('benachrichtigung: Sperren gebündelt – erste sofort, weitere innerhalb der Stunde als EINE Sammelmeldung', async () => {
  const u = await umgebung();
  const b = _test.sperrBuendel;
  try {
    _test.zuletzt.clear(); b.letzte = 0; b.offen.length = 0; clearTimeout(b.timer); b.timer = null;
    const jetzt = Date.now();
    const erste = await sperreMelden(u.w, { ip: '203.0.113.5', wo: '203.0.113.5 (Bonn, DE)', nutzer: 'fabian', minuten: 60 }, jetzt);
    assert.match(erste.titel, /Anmeldung gesperrt: 203\.0\.113\.5/); assert.match(erste.text, /für 1 h gesperrt/);
    for (let i = 0; i < 14; i++) assert.deepEqual(await sperreMelden(u.w, { ip: `198.51.100.${i}`, wo: `198.51.100.${i}`, nutzer: '', minuten: 60 }, jetzt + 1000), { gebuendelt: true, offen: i + 1 });
    await sperreMelden(u.w, { ip: '198.51.100.3', wo: '198.51.100.3', nutzer: '', minuten: 1440 }, jetzt + 2000); // gleiche Adresse: nur aktualisiert
    assert.ok(b.timer, 'Sammelmeldung geplant');
    assert.equal((await u.w.konfig.laden('benachrichtigungen-verlauf.json', [])).length, 1, 'bis jetzt nur die erste');
    clearTimeout(b.timer); b.timer = null;
    const sammel = await sammelSenden(u.w, jetzt + 3_600_000);
    assert.equal(sammel.titel, '14 Adressen gesperrt (letzte Stunde)');
    assert.equal(sammel.text.split('\n').length, 12, 'Kopfzeile + 10 Adressen + Rest');
    assert.match(sammel.text, /198\.51\.100\.3 – 24 h/); assert.match(sammel.text, /… und 4 weitere/);
    assert.equal(await sammelSenden(u.w), null, 'nichts offen → nichts');
    assert.equal((await u.w.konfig.laden('benachrichtigungen-verlauf.json', [])).length, 2, 'insgesamt zwei Meldungen statt 15');
  } finally { clearTimeout(b.timer); b.timer = null; b.offen.length = 0; b.letzte = 0; await u.aufraeumen(); }
});

