// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/totp.js: Base32 (RFC 4648), TOTP (RFC 6238-Vektoren), scrypt-Hashes, Wiederherstellungscodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as t from '../../src/agent/totp.js';

test('base32: RFC-4648-Vektoren hin und zurück', () => {
  const vektoren = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
  for (const [klar, kodiert] of vektoren) {
    assert.equal(t.base32Kodieren(Buffer.from(klar), true), kodiert);
    assert.equal(t.base32Kodieren(Buffer.from(klar)), kodiert.replace(/=+$/, ''));
    assert.equal(t.base32Dekodieren(kodiert).toString(), klar);
    assert.equal(t.base32Dekodieren(kodiert.toLowerCase().replace(/=+$/, '')).toString(), klar);
  }
  assert.equal(t.base32Dekodieren('MZXW 6YTB').toString(), 'fooba');
  assert.throws(() => t.base32Dekodieren('MZXW1'), (e) => e.code === 'E_PARAMS');
  const zufall = t.geheimnisErzeugen();
  assert.match(zufall, /^[A-Z2-7]{32}$/);
  assert.equal(t.base32Dekodieren(zufall).length, 20);
});

test('totp: RFC-6238-Testvektoren (SHA1, 6 Stellen)', () => {
  const geheimnis = t.base32Kodieren(Buffer.from('12345678901234567890'));
  assert.equal(geheimnis, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const vektoren = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [zeit, code] of vektoren) assert.equal(t.totp(geheimnis, zeit), code, `Zeit ${zeit}`);
  // 8-stellige Originalwerte des RFC als Gegenprobe
  assert.equal(t.hotp(Buffer.from('12345678901234567890'), 1, 8), '94287082');
  assert.equal(t.hotp(Buffer.from('12345678901234567890'), Math.floor(1111111109 / 30), 8), '07081804');
});

test('totp: Prüfung mit ±1 Schritt, Ablehnung außerhalb, Replay-Schutz, Formatfehler', () => {
  const g = t.base32Kodieren(Buffer.from('12345678901234567890'));
  const jetzt = 1111111111; // Schritt 37037037
  const aktuell = t.totp(g, jetzt);
  const davor = t.totp(g, jetzt - 30);
  const danach = t.totp(g, jetzt + 30);
  const weitWeg = t.totp(g, jetzt + 90);
  assert.deepEqual(t.codePruefen(g, aktuell, { jetzt_s: jetzt }), { ok: true, schritt: 37037037 });
  assert.equal(t.codePruefen(g, davor, { jetzt_s: jetzt }).ok, true);
  assert.equal(t.codePruefen(g, danach, { jetzt_s: jetzt }).ok, true);
  assert.equal(t.codePruefen(g, `${danach.slice(0, 3)} ${danach.slice(3)}`, { jetzt_s: jetzt }).ok, true, 'Leerzeichen werden toleriert');
  assert.equal(t.codePruefen(g, weitWeg, { jetzt_s: jetzt }).ok, false);
  assert.equal(t.codePruefen(g, aktuell, { jetzt_s: jetzt, letzterSchritt: 37037037 }).ok, false, 'schon benutzter Code');
  assert.equal(t.codePruefen(g, aktuell, { jetzt_s: jetzt, letzterSchritt: 37037036 }).ok, true);
  assert.equal(t.codePruefen(g, '12345', { jetzt_s: jetzt }).ok, false);
  assert.equal(t.codePruefen(g, 'abcdef', { jetzt_s: jetzt }).ok, false);
  assert.equal(t.codePruefen(g, '', { jetzt_s: jetzt }).ok, false);
});

test('totp: otpauth-URI mit Aussteller FAH-NAS und Konto name@hostname', () => {
  const uri = t.otpauthUri({ geheimnis: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', konto: 'benutzer@fahnas' });
  assert.equal(uri, 'otpauth://totp/FAH-NAS:benutzer@fahnas?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=FAH-NAS&algorithm=SHA1&digits=6&period=30');
  assert.throws(() => t.otpauthUri({ geheimnis: 'kein base32!', konto: 'x' }), (e) => e.code === 'E_PARAMS');
});

test('scrypt: Hash-Format, Prüfung richtig/falsch, kaputter Hash wirft nicht', async () => {
  const hash = await t.hashErzeugen('geheim-und-lang');
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const z = t.hashZerlegen(hash);
  assert.equal(z.N, 32768); assert.equal(z.r, 8); assert.equal(z.p, 1); assert.equal(z.salz.length, 16); assert.equal(z.wert.length, 32);
  assert.equal(await t.hashPruefen('geheim-und-lang', hash), true);
  assert.equal(await t.hashPruefen('geheim-und-lanG', hash), false);
  assert.equal(await t.hashPruefen('', hash), false);
  assert.equal(await t.hashPruefen('geheim-und-lang', 'kaputt'), false);
  assert.equal(await t.hashPruefen('geheim-und-lang', null), false);
  assert.notEqual(await t.hashErzeugen('geheim-und-lang'), hash, 'neues Salz je Hash');
  await assert.rejects(t.hashErzeugen(''), (e) => e.code === 'E_PARAMS');
});

test('wiederherstellungscodes: 8 × 10 Zeichen, gehasht, einmalig einlösbar, Eingabe wird normiert', async () => {
  const codes = t.wiederherstellungscodesErzeugen();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
  const hashes = await t.wiederherstellungscodesHashen(codes);
  assert.equal(hashes.length, 8);
  for (const h of hashes) assert.match(h, /^scrypt\$/);
  const eingabe = `${codes[3].slice(0, 5).toUpperCase()}-${codes[3].slice(5)}`;
  const erst = await t.wiederherstellungscodeEinloesen(hashes, eingabe);
  assert.equal(erst.ok, true);
  assert.equal(erst.rest.length, 7);
  const zweit = await t.wiederherstellungscodeEinloesen(erst.rest, codes[3]);
  assert.equal(zweit.ok, false, 'derselbe Code gilt nur einmal');
  assert.equal(zweit.rest.length, 7);
  assert.equal((await t.wiederherstellungscodeEinloesen(erst.rest, 'zu-kurz')).ok, false);
  assert.equal((await t.wiederherstellungscodeEinloesen([], codes[0])).ok, false);
  assert.equal((await t.wiederherstellungscodeEinloesen(erst.rest, codes[0])).ok, true);
});
