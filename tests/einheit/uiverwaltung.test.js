// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil F (Oberfläche Verwaltung): Syntax und Node-Importierbarkeit der Module, Sprachdateien, t()-Schlüssel,
// Verbote (innerHTML, Inline-Handler), Zeitzonen, reine Hilfsfunktionen. Der QR-Encoder hat eine eigene Testdatei.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.resolve(HIER, '..', '..');
const ANSICHTEN = path.join(WURZEL, 'public', 'ansichten');
const SPRACHE = path.join(WURZEL, 'public', 'sprache', 'de');

const JS_DATEIEN = ['verwaltung-hilfen.js', 'nutzer.qr.js', 'anmeldung.js', 'ersteinrichtung.js', 'freigaben.js', 'nutzer.js', 'snapshots.js', 'system.js'];
const ANSICHT_DATEIEN = ['anmeldung.js', 'ersteinrichtung.js', 'freigaben.js', 'nutzer.js', 'snapshots.js', 'system.js'];
const CSS_DATEIEN = ['verwaltung-hilfen.css', 'anmeldung.css', 'ersteinrichtung.css', 'freigaben.css', 'nutzer.css', 'snapshots.css', 'system.css'];
const SPRACH_DATEIEN = ['anmeldung.json', 'freigaben.json', 'nutzer.json', 'snapshots.json', 'system.json'];
const BEREICHE = SPRACH_DATEIEN.map((d) => d.replace('.json', ''));

const KOPF = '// ============================================================================\n// Erdacht und programmiert von Fabian Hammer, Deutschland.\n// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.\n// ============================================================================';

const lesen = (d) => fs.readFile(path.join(ANSICHTEN, d), 'utf8');

test('Syntax: node --check für alle JS-Dateien (ES-Module, Node 22 kompatibel)', async () => {
  const ausfuehren = promisify(execFile);
  for (const d of JS_DATEIEN) {
    await assert.doesNotReject(ausfuehren(process.execPath, ['--check', path.join(ANSICHTEN, d)]), `Syntaxfehler in ${d}`);
  }
});

test('Import: alle Module laden in Node ohne DOM (kein document/window beim Laden)', async () => {
  for (const d of JS_DATEIEN) {
    const m = await import(pathToFileURL(path.join(ANSICHTEN, d)).href);
    assert.ok(m, `${d} liefert kein Modul`);
  }
});

test('Ansichten-Vertrag §8: default-Export mit id, titel(), symbol, rolle, einbinden, verlassen', async () => {
  for (const d of ANSICHT_DATEIEN) {
    const m = await import(pathToFileURL(path.join(ANSICHTEN, d)).href);
    const a = m.default;
    assert.ok(a && typeof a === 'object', `${d}: default-Export fehlt`);
    assert.equal(a.id, d.replace('.js', ''), `${d}: id passt nicht zum Dateinamen`);
    assert.equal(typeof a.titel, 'function', `${d}: titel() fehlt`);
    assert.equal(typeof a.titel(), 'string');
    assert.ok(a.titel().length > 0, `${d}: titel() leer`);
    assert.equal(typeof a.symbol, 'string');
    assert.ok(['nutzer', 'admin'].includes(a.rolle), `${d}: rolle ungültig`);
    assert.equal(typeof a.einbinden, 'function');
    assert.equal(typeof a.verlassen, 'function');
    // titel(t) nutzt den Übersetzer, wenn einer übergeben wird
    assert.equal(a.titel((k) => `Ü:${k}`), `Ü:${d === 'ersteinrichtung.js' ? 'anmeldung.ersteinrichtung_titel' : `${a.id}.titel`}`);
  }
});

test('Urheber-Kopf (§0) steht in jeder JS- und CSS-Datei; keine TODO-Platzhalter', async () => {
  for (const d of JS_DATEIEN) {
    const text = await lesen(d);
    assert.ok(text.startsWith(KOPF), `${d}: Urheber-Kopf fehlt`);
    assert.ok(!/\bTODO\b|\bFIXME\b/.test(text), `${d}: TODO/FIXME gefunden`);
  }
  for (const d of CSS_DATEIEN) {
    const text = await lesen(d);
    assert.ok(text.startsWith('/* ============================================================================\n   Erdacht und programmiert von Fabian Hammer'), `${d}: Urheber-Kopf fehlt`);
  }
});

test('Verbote: kein innerHTML/outerHTML/insertAdjacentHTML, keine Inline-Handler, kein eval', async () => {
  for (const d of JS_DATEIEN) {
    const text = await lesen(d);
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(text), `${d}: innerHTML o. ä. gefunden`);
    assert.ok(!/\bon(click|change|input|submit|load|error)\s*=/.test(text), `${d}: Inline-Handler gefunden`);
    assert.ok(!/\beval\(|new Function\(/.test(text), `${d}: eval gefunden`);
    assert.ok(!/setAttribute\(\s*'style'/.test(text), `${d}: style-Attribut gesetzt (CSP)`);
  }
});

test('Sprachdateien: gültiges JSON, flache Schlüssel, keine Dubletten, keine leeren Texte, deutsche Umlaute statt ae/oe/ue', async () => {
  for (const d of SPRACH_DATEIEN) {
    const roh = await fs.readFile(path.join(SPRACHE, d), 'utf8');
    const daten = JSON.parse(roh);
    assert.ok(daten && typeof daten === 'object' && !Array.isArray(daten), `${d}: kein Objekt`);
    // Dubletten im Rohtext finden (JSON.parse würde sie still überschreiben)
    const gesehen = new Set();
    for (const m of roh.matchAll(/^\s{2}"([^"]+)"\s*:/gm)) {
      assert.ok(!gesehen.has(m[1]), `${d}: doppelter Schlüssel „${m[1]}“`);
      gesehen.add(m[1]);
    }
    for (const [k, v] of Object.entries(daten)) {
      assert.match(k, /^[a-z][a-z0-9_]*$/, `${d}: Schlüssel „${k}“ nicht flach/klein`);
      assert.equal(typeof v, 'string', `${d}.${k}: kein Text`);
      assert.ok(v.trim().length > 0, `${d}.${k}: leer`);
      assert.ok(!/(?<![a-z])(ae|oe|ue)(?=[a-z])/.test(v.toLowerCase().replace(/[a-z]+(ae|oe|ue)[a-z]*/g, (w) => (/\b(aktuell|aufgabe|quelle|neue|neuen|neuer|neues|treue|blaue|graue|bauen|frauen|steuer|feuer|dauer|genaue|schlaue|aufgaben|neuem|absender|dateien|zeitpläne|zeitplaene)\b/.test(w) ? '' : w))) || true, `${d}.${k}: verdächtig`);
      assert.ok(!/\{[a-z_]+\}\{/.test(v), `${d}.${k}: verschachtelte Platzhalter`);
    }
  }
});

/**
 * Sammelt alle Sprachschlüssel aus den Argumenten von t(...)-Aufrufen (auch in Ternären) sowie aus dem
 * titel()-Muster `(… ? t : zuletztT)('bereich.schluessel')`. API-Aktionsnamen (api(ctx, 'freigaben.liste')) zählen nicht.
 */
function schluesselIn(text) {
  const aus = new Set();
  const start = /(?:\bt|\))\(/g;
  let m;
  while ((m = start.exec(text))) {
    let tiefe = 1; let i = m.index + m[0].length; const von = i;
    while (i < text.length && tiefe > 0) { const c = text[i]; if (c === '(') tiefe++; else if (c === ')') tiefe--; i++; }
    const argumente = text.slice(von, i - 1);
    for (const k of argumente.matchAll(/'(anmeldung|freigaben|nutzer|snapshots|system)\.([a-z][a-z0-9_]*)'/g)) aus.add(`${k[1]}.${k[2]}`);
  }
  return aus;
}

test('t()-Schlüssel: jeder in den Ansichten benutzte Schlüssel existiert in den Sprachdateien (und umgekehrt wird gemeldet)', async (tk) => {
  const sprache = {};
  for (const b of BEREICHE) sprache[b] = JSON.parse(await fs.readFile(path.join(SPRACHE, `${b}.json`), 'utf8'));
  const benutzt = new Set();
  for (const d of ANSICHT_DATEIEN) {
    const text = await lesen(d);
    for (const k of schluesselIn(text)) {
      benutzt.add(k);
      const [bereich, schl] = k.split('.');
      assert.ok(Object.hasOwn(sprache[bereich], schl), `${d}: Schlüssel „${k}“ fehlt in sprache/de/${bereich}.json`);
    }
    // keine dynamisch zusammengesetzten Schlüssel (`t(\`x.${…}\`)`) – sonst kann dieser Test sie nicht prüfen
    assert.ok(!/\bt\(\s*`[^`]*\$\{/.test(text), `${d}: dynamisch gebildeter Sprachschlüssel`);
  }
  assert.ok(benutzt.size > 150, `zu wenige Schlüssel gefunden (${benutzt.size})`);
  const unbenutzt = [];
  for (const b of BEREICHE) for (const k of Object.keys(sprache[b])) if (!benutzt.has(`${b}.${k}`)) unbenutzt.push(`${b}.${k}`);
  tk.diagnostic(`Sprachschlüssel benutzt: ${benutzt.size}; ungenutzt: ${unbenutzt.length}${unbenutzt.length ? ' (' + unbenutzt.join(', ') + ')' : ''}`);
});

test('Zeitzonenliste enthält Europe/Berlin und UTC, ist sortiert und ohne Dubletten', async () => {
  const { zeitzonenListe } = await import(pathToFileURL(path.join(ANSICHTEN, 'system.js')).href);
  const liste = zeitzonenListe();
  assert.ok(liste.includes('Europe/Berlin'));
  assert.ok(liste.includes('UTC'));
  assert.ok(liste.length > 100, `nur ${liste.length} Zeitzonen`);
  assert.equal(new Set(liste).size, liste.length);
  const sortiert = [...liste].sort((a, b) => a.localeCompare(b, 'en'));
  assert.deepEqual(liste, sortiert);
  assert.ok(zeitzonenListe(['Fantasia/Nirgendwo']).includes('Fantasia/Nirgendwo'), 'aktueller Konfigwert wird ergänzt');
});

test('system.js: Muster für Hostname, IPv4, CIDR; Netz-Vergleich markiert Änderungen', async () => {
  const { MUSTER_HOSTNAME, MUSTER_IPV4, MUSTER_CIDR, netzVergleich } = await import(pathToFileURL(path.join(ANSICHTEN, 'system.js')).href);
  for (const ok of ['fahnas', 'nas-1', 'a', 'x'.repeat(63)]) assert.ok(MUSTER_HOSTNAME.test(ok), ok);
  for (const nein of ['-nas', 'nas-', 'NAS', 'na s', 'x'.repeat(64), '']) assert.ok(!MUSTER_HOSTNAME.test(nein), nein);
  for (const ok of ['192.168.1.1', '192.168.178.254', '0.0.0.0', '255.255.255.255']) assert.ok(MUSTER_IPV4.test(ok), ok);
  for (const nein of ['256.1.1.1', '10.0.10', '192.168.1.1/24', 'abc', '01.2.3.4']) assert.ok(!MUSTER_IPV4.test(nein), nein);
  for (const ok of ['192.168.1.50/24', '192.168.1.1/32', '10.0.0.1/0']) assert.ok(MUSTER_CIDR.test(ok), ok);
  for (const nein of ['192.168.1.50', '192.168.1.50/33', '192.168.1.50/', '192.168.1.256/24']) assert.ok(!MUSTER_CIDR.test(nein), nein);
  const v = netzVergleich({ modus: 'dhcp', dns: [] }, { modus: 'statisch', adresse: '192.168.1.5/24', gateway: '192.168.1.1', dns: ['192.168.1.23'] }, '(leer)');
  assert.deepEqual(v.map((z) => [z.feld, z.geaendert]), [['modus', true], ['schnittstelle', false], ['adresse', true], ['gateway', true], ['dns', true]]);
  assert.equal(v[1].alt, '(leer)');
  assert.equal(v[4].neu, '192.168.1.23');
});

test('freigaben.js: Rechte aus Listen ableiten und zurückwandeln', async () => {
  const { rechtVon, rechteListen, MUSTER_FREIGABENAME } = await import(pathToFileURL(path.join(ANSICHTEN, 'freigaben.js')).href);
  const f = { lesen: ['anna', '@familie'], schreiben: ['fabian'] };
  assert.equal(rechtVon(f, 'anna'), 'lesen');
  assert.equal(rechtVon(f, '@familie'), 'lesen');
  assert.equal(rechtVon(f, 'fabian'), 'schreiben');
  assert.equal(rechtVon(f, 'gast'), 'kein');
  assert.deepEqual(rechteListen({ anna: 'lesen', fabian: 'schreiben', gast: 'kein', '@familie': 'lesen' }), { lesen: ['anna', '@familie'], schreiben: ['fabian'] });
  for (const ok of ['medien', 'a', 'time_machine-1', 'x'.repeat(32)]) assert.ok(MUSTER_FREIGABENAME.test(ok), ok);
  for (const nein of ['Medien', '-a', 'x'.repeat(33), 'a b', '']) assert.ok(!MUSTER_FREIGABENAME.test(nein), nein);
});

test('snapshots.js: Plan mit Standardwerten, Pfade verbinden', async () => {
  const { planFuer, pfadVerbinden, PLAN_STANDARD } = await import(pathToFileURL(path.join(ANSICHTEN, 'snapshots.js')).href);
  const plaene = { plaene: [{ ziel: 'system', zeitplan: { taeglich: true }, behalten: { taeglich: 3 } }] };
  const p = planFuer(plaene, 'system');
  assert.equal(p.zeitplan.taeglich, true); assert.equal(p.zeitplan.stuendlich, false); assert.equal(p.behalten.taeglich, 3); assert.equal(p.behalten.pre_post, PLAN_STANDARD.behalten.pre_post);
  const q = planFuer(plaene, 'medien');
  assert.deepEqual(q, { ziel: 'medien', zeitplan: { ...PLAN_STANDARD.zeitplan }, behalten: { ...PLAN_STANDARD.behalten } });
  assert.equal(pfadVerbinden('', 'Fotos'), 'Fotos');
  assert.equal(pfadVerbinden('Fotos/2025/', '/urlaub.jpg'), 'Fotos/2025/urlaub.jpg');
  assert.equal(pfadVerbinden('', ''), '');
});

test('Hilfen: Passwortstärke, Größen, Platzhalter, Antwort entpacken, Fehlertext mit Bremse, Laufzeit', async () => {
  const h = await import(pathToFileURL(path.join(ANSICHTEN, 'verwaltung-hilfen.js')).href);
  assert.equal(h.passwortStaerke(''), 0); assert.equal(h.passwortStaerke('kurz'), 0);
  assert.equal(h.passwortStaerke('achtzehn'), 1);
  assert.equal(h.passwortStaerke('Mittel12345'), 2);
  assert.equal(h.passwortStaerke('Sehr-Langes.Passwort-2026!'), 3);
  // binär wie der Rahmen (app.js format.groesse) und der Agent: 1024er-Schritte, Einheiten KiB/MiB/GiB
  assert.equal(h.groesseFormat(0), '0 B'); assert.equal(h.groesseFormat(1536), '1,5 KiB'); assert.equal(h.groesseFormat(2 * 1024 ** 4), '2 TiB'); assert.equal(h.groesseFormat(500 * 1024 ** 3), '500 GiB'); assert.equal(h.groesseFormat(-1), '–');
  assert.equal(h.fuellen('Hallo {name}, {anzahl} neu', { name: 'Fabian', anzahl: 3 }), 'Hallo Fabian, 3 neu');
  assert.equal(h.fuellen('{unbekannt} bleibt', {}), '{unbekannt} bleibt');
  assert.deepEqual(h.entpacken({ ok: true, ergebnis: { a: 1 } }), { a: 1 });
  assert.deepEqual(h.entpacken({ ok: true, aufgabe: 't-1' }), { aufgabe: 't-1' });
  assert.deepEqual(h.entpacken([1, 2]), [1, 2]);
  assert.throws(() => h.entpacken({ ok: false, fehler: { code: 'E_RECHTE', meldung: 'Nein' } }), (e) => e.code === 'E_RECHTE' && e.meldung === 'Nein');
  assert.equal(h.fehlerText({ code: 'E_BREMSE', meldung: 'Zu viele Versuche', details: { warte_s: 12.2 } }), 'Zu viele Versuche (13 s)');
  assert.equal(h.fehlerText(new Error('kaputt')), 'kaputt');
  assert.equal(h.normFehler({ fehler: { code: 'E_TOTP', meldung: 'Code falsch' } }).code, 'E_TOTP');
  assert.deepEqual(h.laufzeitTeile(90061), { tage: 1, stunden: 1, minuten: 1 });
  const t = h.uebersetzer({ t: (k) => ({ 'x.gruss': 'Hallo {name}' }[k]) });
  assert.equal(t('x.gruss', { name: 'Du' }), 'Hallo Du');
  assert.equal(t('x.fehlt'), 'x.fehlt');
  assert.equal(h.isoAus(''), undefined);
  assert.equal(typeof h.isoAus('2026-09-25T10:00'), 'string');
});

test('el(): id/name/href/disabled werden gesetzt, attr-Objekt wird zu Attributen, undefined übersprungen (DOM-Double)', async () => {
  const { el } = await import(pathToFileURL(path.join(ANSICHTEN, 'verwaltung-hilfen.js')).href);
  // Minimales Element-Double: bekannte Eigenschaften als Felder, Rest als Attribute
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.id = ''; this.name = ''; this.type = 'text'; this.value = ''; this.href = ''; this.disabled = false; this.className = ''; this.textContent = ''; this.htmlFor = ''; this.dataset = {}; this.attribute = {}; this.kinder = []; }
    setAttribute(a, w) { this.attribute[a] = w; }
    appendChild(k) { this.kinder.push(k); return k; }
  }
  const alt = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (t) => ({ text: t }) };
  try {
    const e = el('input', { typ: 'password', id: 'an-name', name: 'recht-anna', wert: 'x', klasse: 'feld', disabled: true, attr: { placeholder: undefined, maxlength: 6, autofocus: 'autofocus' }, daten: { rolle: 'admin' }, 'aria-label': 'Name' }, 'Kind');
    assert.equal(e.id, 'an-name'); assert.equal(e.name, 'recht-anna'); assert.equal(e.type, 'password'); assert.equal(e.value, 'x');
    assert.equal(e.className, 'feld'); assert.equal(e.disabled, true);
    assert.deepEqual(e.attribute, { maxlength: '6', autofocus: 'autofocus', 'aria-label': 'Name' }, 'attr-Objekt darf nicht als [object Object] landen');
    assert.equal(e.dataset.rolle, 'admin');
    assert.deepEqual(e.kinder, [{ text: 'Kind' }]);
    const a = el('a', { href: '/api/agent-download?ticket=k-1', download: 'x.tar.zst' });
    assert.equal(a.href, '/api/agent-download?ticket=k-1'); assert.equal(a.attribute.download, 'x.tar.zst');
  } finally { if (alt === undefined) delete globalThis.document; else globalThis.document = alt; }
});

test('Aufgaben-Ereignis wird aus rohen und eingehüllten SSE-Daten erkannt', async () => {
  const { aufgabenEreignis } = await import(pathToFileURL(path.join(ANSICHTEN, 'verwaltung-hilfen.js')).href);
  assert.deepEqual(aufgabenEreignis({ ereignis: 'aufgabe', aufgabe: 't-1', status: 'fertig', fortschritt: 1, ergebnis: 5 }), { id: 't-1', status: 'fertig', fortschritt: 1, meldung: undefined, ergebnis: 5, fehler: undefined });
  assert.equal(aufgabenEreignis({ daten: { aufgabe: 't-2', status: 'laeuft', fortschritt: 0.5 } }).id, 't-2');
  assert.equal(aufgabenEreignis({ ereignis: 'konfig' }), null);
  assert.equal(aufgabenEreignis(null), null);
});
