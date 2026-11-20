// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests Teil B2 (Oberfläche Apps + Laufwerke + Dashboard-Kacheln): Syntax und Node-Importierbarkeit, Ansichten-Vertrag §8,
// Verbote (innerHTML, Inline-Handler, style-Attribut), Sprachdateien (flach, Umlaute, Dubletten), alle benutzten Sprach-
// schlüssel vorhanden (auch in Zuordnungstabellen), CSS-Vorsilben/Handy-Regeln, reine Helfer (Ampel, Namen, Pfade,
// Konflikte, Belegung, Prozesslisten, Ereignisse, Zusammenfassungen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.resolve(HIER, '..', '..');
const PUBLIC = path.join(WURZEL, 'public');
const ANSICHTEN = path.join(PUBLIC, 'ansichten');
const SPRACHE = path.join(PUBLIC, 'sprache', 'de');

const JS_DATEIEN = ['apps.js', 'laufwerke.js', 'dashboard.js', 'weltkarte.js']; // weltkarte.js: Karten-Modul der Übersicht (Weltkarte)
const NEUE_ANSICHTEN = ['apps.js', 'laufwerke.js'];
const CSS_DATEIEN = ['apps.css', 'laufwerke.css'];
const SPRACH_DATEIEN = ['apps.json', 'laufwerke.json'];
const KOPF_JS = '// ============================================================================\n// Erdacht und programmiert von Fabian Hammer, Deutschland.\n// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.\n// ============================================================================';
const KOPF_CSS = '/* ============================================================================\n   Erdacht und programmiert von Fabian Hammer';
/** Agent-Aktionen der Bereiche apps/laufwerke (§11/§12) – sind keine Sprachschlüssel */
const AKTIONEN = new Set([
  'apps.katalog.liste', 'apps.katalog.eintrag', 'apps.katalog.unraid_laden', 'apps.katalog.importieren', 'apps.katalog.loeschen', 'apps.pruefen', 'apps.installieren',
  'apps.liste', 'apps.details', 'apps.steuern', 'apps.aendern', 'apps.aktualisieren', 'apps.loeschen', 'apps.protokoll', 'apps.ports', 'apps.apply', 'apps.sichtbarkeit',
  'apps.einstellungen', 'apps.einstellungen.speichern', 'apps.einstellungen.zuruecksetzen', 'apps.ordner', // App-Editor + Ordnerwahl (12.10.2026)
  'apps.zip.ticket', 'apps.zip.pruefen', 'apps.zip.installieren', 'apps.zip.aktualisieren',
  'apps.fahgit.holen', 'apps.fahgit.aktualisieren', 'apps.fahgit.einstellen', 'apps.fahgit.stand',
  'apps.updates', 'apps.docker_speicher', 'apps.docker_aufraeumen', // Übersicht-Kacheln Updates/Docker-Speicher (0.17.0)
  'laufwerke.liste', 'laufwerke.einhaengen', 'laufwerke.aushaengen', 'laufwerke.aendern', 'laufwerke.formatieren', 'laufwerke.smart', 'laufwerke.apply',
]);

const lesen = (d) => fs.readFile(path.join(ANSICHTEN, d), 'utf8');
const laden = (d) => import(pathToFileURL(path.join(ANSICHTEN, d)).href);

test('B2 Syntax: node --check für apps.js, laufwerke.js, dashboard.js; Urheber-Kopf in JS und CSS; keine TODO-Platzhalter', async () => {
  const ausfuehren = promisify(execFile);
  for (const d of JS_DATEIEN) {
    await assert.doesNotReject(ausfuehren(process.execPath, ['--check', path.join(ANSICHTEN, d)]), `Syntaxfehler in ${d}`);
    const text = await lesen(d);
    assert.ok(text.startsWith(KOPF_JS), `${d}: Urheber-Kopf fehlt`);
    assert.ok(!/\bTODO\b|\bFIXME\b/.test(text), `${d}: TODO/FIXME gefunden`);
  }
  for (const d of CSS_DATEIEN) assert.ok((await lesen(d)).startsWith(KOPF_CSS), `${d}: Urheber-Kopf fehlt`);
});

test('B2 Import ohne DOM und Ansichten-Vertrag §8: id, titel(t), symbol, rolle nutzer, einbinden, verlassen; Registrierung 25/29', async () => {
  for (const d of NEUE_ANSICHTEN) {
    const m = await laden(d);
    const a = m.default;
    assert.ok(a && typeof a === 'object', `${d}: default-Export fehlt`);
    assert.equal(a.id, d.replace('.js', ''));
    assert.equal(typeof a.titel, 'function'); assert.ok(a.titel().length > 0);
    assert.equal(a.titel((k) => `Ü:${k}`), `Ü:${a.id}.titel`, 'titel(t) nutzt den Übersetzer');
    assert.equal(typeof a.symbol, 'string');
    assert.equal(a.rolle, 'nutzer', `${d}: Ansicht ist für Nutzer sichtbar, Verwaltung nur admin`);
    assert.equal(typeof a.einbinden, 'function'); assert.equal(typeof a.verlassen, 'function');
    await fs.access(path.join(ANSICHTEN, `${a.id}.css`));
  }
  const { ANSICHTEN: REG } = await import(pathToFileURL(path.join(ANSICHTEN, 'index.js')).href);
  const apps = REG.find((x) => x.id === 'apps'); const lw = REG.find((x) => x.id === 'laufwerke');
  assert.ok(apps && apps.datei === 'apps.js' && apps.rolle === 'nutzer' && apps.reihenfolge === 25, 'apps registriert (25, nutzer)');
  assert.ok(lw && lw.datei === 'laufwerke.js' && lw.rolle === 'nutzer' && lw.reihenfolge === 29 && lw.gruppe === 'speicher', 'laufwerke registriert (29, nutzer, Gruppe Speicher – 12.10.2026)');
});

test('B2 Verbote: kein innerHTML/outerHTML/insertAdjacentHTML/document.write, keine Inline-Handler, kein eval, kein style-Attribut, Öffnen-Link mit rel=noopener', async () => {
  for (const d of JS_DATEIEN) {
    const text = await lesen(d);
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(text), `${d}: innerHTML o. ä. gefunden`);
    assert.ok(!/\bon(click|change|input|submit|load|error)\s*=\s*["'{]/.test(text), `${d}: Inline-Handler gefunden`);
    assert.ok(!/\beval\(|new Function\(/.test(text), `${d}: eval gefunden`);
    assert.ok(!/setAttribute\(\s*'style'/.test(text), `${d}: style-Attribut gesetzt (CSP)`);
  }
  const apps = await lesen('apps.js');
  assert.match(apps, /target:\s*'_blank',\s*rel:\s*'noopener noreferrer'/, 'Öffnen-Link: neuer Tab mit rel=noopener noreferrer');
  assert.match(apps, /addEventListener\('error'/, 'App-Symbol hat einen Rückfall bei Ladefehler');
  assert.match(apps, /SUCHE_VERZOEGERUNG_MS/, 'Suche mit Verzögerung');
  const lw = await lesen('laufwerke.js');
  assert.match(lw, /E_BELEGT/, 'Auswerfen behandelt E_BELEGT (Prozessliste)');
  assert.match(lw, /bestaetigung: g\.pfad/, 'Formatieren schickt die Bestätigung (Gerätepfad) mit – Schema von D2');
  assert.match(lw, /abo\(ctx, 'system'/, 'Live über SSE-Ereignis system/laufwerk');
});

test('B2 Sprachdateien apps.json/laufwerke.json: gültig, flach (plus navigation.<id>), keine Dubletten, keine leeren Texte, Umlaute intakt', async () => {
  for (const d of SPRACH_DATEIEN) {
    const roh = await fs.readFile(path.join(SPRACHE, d), 'utf8');
    const daten = JSON.parse(roh);
    const bereich = d.replace('.json', '');
    assert.ok(daten && typeof daten === 'object' && !Array.isArray(daten), `${d}: kein Objekt`);
    const gesehen = new Set();
    for (const m of roh.matchAll(/^\s{2}"([^"]+)"\s*:/gm)) { assert.ok(!gesehen.has(m[1]), `${d}: doppelter Schlüssel „${m[1]}“`); gesehen.add(m[1]); }
    assert.ok(Object.hasOwn(daten, `navigation.${bereich}`), `${d}: navigation.${bereich} (Beschriftung im Menü) fehlt`);
    for (const [k, v] of Object.entries(daten)) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(k) || k === `navigation.${bereich}`, `${d}: Schlüssel „${k}“ nicht flach/klein`);
      assert.equal(typeof v, 'string', `${d}.${k}: kein Text`);
      assert.ok(v.trim().length > 0, `${d}.${k}: leer`);
      assert.ok(!/\\u00|Ã/.test(v), `${d}.${k}: kaputte Umlaute`);
      assert.ok(!/\{[a-z_]+\}\{/.test(v), `${d}.${k}: verschachtelte Platzhalter`);
    }
    // Erklärtexte zu jeder Einstellung: zu jedem *_erklaerung gibt es die Beschriftung (oder ein Präfix-Feld)
    for (const k of Object.keys(daten).filter((x) => x.endsWith('_erklaerung'))) {
      const basis = k.replace(/_erklaerung$/, '');
      assert.ok(Object.keys(daten).some((x) => x === basis || x.startsWith(`${basis}_`) || x.startsWith(basis.replace(/_[a-z]+$/, ''))), `${d}: ${k} ohne Beschriftung ${basis}`);
    }
  }
});

/** Alle Zeichenketten 'bereich.schluessel' der Bereiche apps/laufwerke in einer Quelldatei (Kommentare ausgenommen) */
function bereichsSchluessel(quelle, bereiche) {
  const text = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const aus = new Set();
  for (const m of text.matchAll(/'((?:[a-z]+)\.[a-z][a-z0-9_.]*)'/g)) if (bereiche.includes(m[1].split('.')[0])) aus.add(m[1]);
  return aus;
}

test('B2 Sprachschlüssel: jeder in apps.js/laufwerke.js benutzte apps./laufwerke.-Schlüssel (auch in Zuordnungstabellen) existiert; dashboard.js-Schlüssel in dashboard.json; Rahmen-Schlüssel in gemeinsam.json', async (tk) => {
  const sprache = {};
  for (const b of ['apps', 'laufwerke', 'dashboard', 'gemeinsam']) sprache[b] = JSON.parse(await fs.readFile(path.join(SPRACHE, `${b}.json`), 'utf8'));
  const gemeinsam = new Set(Object.keys(sprache.gemeinsam));
  const benutzt = { apps: new Set(), laufwerke: new Set() };
  for (const d of NEUE_ANSICHTEN) {
    const text = await lesen(d);
    for (const k of bereichsSchluessel(text, ['apps', 'laufwerke', 'rahmen'])) {
      // Aktionsnamen (api/aufgabeStarten) sind keine Sprachschlüssel – außer sie stehen auch in einem t('…')-Aufruf (z. B. apps.protokoll als Knopftext)
      if (AKTIONEN.has(k) && !text.includes(`t('${k}'`)) continue;
      const [bereich, ...rest] = k.split('.');
      const schl = rest.join('.');
      if (bereich === 'rahmen') { assert.ok(gemeinsam.has(k), `${d}: Rahmen-Schlüssel „${k}“ fehlt in gemeinsam.json`); continue; }
      assert.ok(Object.hasOwn(sprache[bereich], schl), `${d}: Schlüssel „${k}“ fehlt in sprache/de/${bereich}.json`);
      benutzt[bereich].add(schl);
    }
    assert.ok(!/\bt\(\s*`[^`]*\$\{/.test(text), `${d}: dynamisch gebildeter Sprachschlüssel – nicht prüfbar`);
  }
  assert.ok(benutzt.apps.size > 80, `apps.js: nur ${benutzt.apps.size} Schlüssel gefunden`);
  assert.ok(benutzt.laufwerke.size > 60, `laufwerke.js: nur ${benutzt.laufwerke.size} Schlüssel gefunden`);
  const unbenutzt = [];
  for (const b of ['apps', 'laufwerke']) for (const k of Object.keys(sprache[b])) if (!benutzt[b].has(k) && k !== `navigation.${b}`) unbenutzt.push(`${b}.${k}`);
  tk.diagnostic(`B2 Sprachschlüssel benutzt: apps ${benutzt.apps.size}, laufwerke ${benutzt.laufwerke.size}; ungenutzt: ${unbenutzt.length}${unbenutzt.length ? ' (' + unbenutzt.join(', ') + ')' : ''}`);
  // Dashboard (Teil-E-Datei, Schlüssel mit Punkt): alle festen t('dashboard.…') vorhanden, die neuen Kacheln-Schlüssel benutzt
  const dash = (await lesen('dashboard.js')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of dash.matchAll(/t\(\s*'(dashboard\.[a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(sprache.dashboard, m[1]), `dashboard.js: „${m[1]}“ fehlt in dashboard.json`);
  for (const k of ['dashboard.apps_wert', 'dashboard.apps_zusammenfassung', 'dashboard.apps_keine', 'dashboard.apps_link', 'dashboard.laufwerke', 'dashboard.laufwerke_wert', 'dashboard.laufwerke_zusammenfassung', 'dashboard.laufwerke_keine', 'dashboard.laufwerke_link', 'dashboard.nicht_verfuegbar', 'dashboard.vms_wert', 'dashboard.vms_link']) {
    assert.ok(dash.includes(`'${k}'`), `dashboard.js benutzt ${k}`);
    assert.ok(Object.hasOwn(sprache.dashboard, k), `dashboard.json enthält ${k}`);
  }
  assert.ok(gemeinsam.has('rahmen.laden'), 'gemeinsam.json: rahmen.laden (Kachel-Ladehinweis)');
});

test('B2 CSS: Vorsilben .ap-/.lw-, Stilvariablen, Handy-Regel (eine Spalte, Knöpfe ≥ 44 px), keine Rahmenklassen neu definiert', async () => {
  for (const [d, vorsilbe] of [['apps.css', 'ap'], ['laufwerke.css', 'lw']]) {
    const css = await lesen(d);
    assert.ok(css.includes(`.${vorsilbe}-`), `${d}: Vorsilbe .${vorsilbe}-`);
    assert.ok(css.includes('var(--fahnas-'), `${d}: Stilvariablen`);
    assert.match(css, /@media \(max-width: 719px\)[\s\S]*grid-template-columns: 1fr/, `${d}: Karten auf dem Handy einspaltig`);
    assert.match(css, /@media \(max-width: 719px\)[\s\S]*min-height: 44px/, `${d}: Knöpfe auf dem Handy mindestens 44 px`);
    for (const klasse of ['.karte', '.knopf', '.feld', '.schalter', '.dialog', '.kachel']) {
      assert.ok(!new RegExp(`^\\s*${klasse.replace('.', '\\.')}\\s*\\{`, 'm').test(css), `${d}: Rahmenklasse ${klasse} darf nicht neu definiert werden`);
    }
  }
});

test('B2 apps.js Helfer: Ampel, Namensvorschlag, Listen, Quellen, riskante Punkte, Port-Konflikte, WebUI, Pfade, Protokoll', async () => {
  const a = await laden('apps.js');
  // Ampel aus Zustand + Gesundheit
  assert.equal(a.zustandAmpel('running'), 'aktiv'); assert.equal(a.zustandAmpel('running', 'healthy'), 'aktiv');
  assert.equal(a.zustandAmpel('running', 'unhealthy'), 'warnung'); assert.equal(a.zustandAmpel('running', 'starting'), 'warnung');
  assert.equal(a.zustandAmpel('exited'), 'inaktiv'); assert.equal(a.zustandAmpel('created'), 'inaktiv'); assert.equal(a.zustandAmpel('gestoppt'), 'inaktiv');
  assert.equal(a.zustandAmpel('restarting'), 'warnung'); assert.equal(a.zustandAmpel('paused'), 'warnung');
  assert.equal(a.zustandAmpel('dead'), 'fehler'); assert.equal(a.zustandAmpel('fehler'), 'fehler');
  assert.equal(a.zustandAmpel('fehlt'), 'inaktiv', 'A2: keine Container angelegt = gestoppt'); assert.equal(a.zustandAmpel('teilweise'), 'warnung', 'A2: nicht alle Container laufen');
  assert.equal(a.zustandAmpel(undefined), 'unbekannt'); assert.equal(a.zustandAmpel('irgendwas'), 'unbekannt');
  // Name aus Katalog-ID – Muster des Agenten
  for (const [id, soll] of [['uptime-kuma', 'uptime-kuma'], ['Uptime Kuma', 'uptime-kuma'], ['nginx', 'nginx'], ['x', 'x-app'], ['--Home_Assistant--', 'home-assistant'], ['a'.repeat(40), 'a'.repeat(31)]]) {
    assert.equal(a.appNameVorschlag(id), soll, id);
    assert.ok(a.MUSTER_APPNAME.test(a.appNameVorschlag(id)), `Vorschlag „${a.appNameVorschlag(id)}“ passt zum Muster`);
  }
  for (const ok of ['ab', 'uptime-kuma', '0a', 'a'.repeat(31)]) assert.ok(a.MUSTER_APPNAME.test(ok), ok);
  for (const nein of ['a', 'A-b', '-ab', 'a_b', 'a b', 'a'.repeat(32), '']) assert.ok(!a.MUSTER_APPNAME.test(nein), nein);
  // Listen aus verschiedenen Formen
  assert.deepEqual(a.listeAus([1, 2], 'apps'), [1, 2]);
  assert.deepEqual(a.listeAus({ apps: [3] }, 'apps'), [3]);
  assert.deepEqual(a.listeAus({ eintraege: [4] }), [4]);
  assert.deepEqual(a.listeAus(null), []); assert.deepEqual(a.listeAus({ x: 1 }), []);
  // Quellen: Zahlen oder Objekte, Unraid-Zeit tolerant
  const q1 = a.quellenInfo({ quellen: { eingebaut: 25, unraid: 0, eigen: 2 } });
  assert.equal(q1.eingebaut.anzahl, 25); assert.equal(q1.unraid.anzahl, 0); assert.equal(q1.unraid.zeit, null);
  const q2 = a.quellenInfo({ quellen: { unraid: { anzahl: 3120, zeit: '2026-09-25T10:00:00Z' } } });
  assert.equal(q2.unraid.anzahl, 3120); assert.equal(q2.unraid.zeit, '2026-09-25T10:00:00Z'); assert.equal(q2.eingebaut.anzahl, null);
  assert.equal(a.quellenInfo({ quellen: { unraid: 5 }, unraid_zeit: 'Z' }).unraid.zeit, 'Z');
  const q3 = a.quellenInfo({ quellen: { eingebaut: 25, unraid: 3120, eigen: 0 }, unraid_geladen: '2026-09-25T12:00:00Z', unraid_anzahl: 3120 });
  assert.equal(q3.unraid.zeit, '2026-09-25T12:00:00Z', 'A2: unraid_geladen trägt die Zeit'); assert.equal(q3.unraid.anzahl, 3120);
  assert.equal(a.quellenInfo({ unraid_geladen: false, unraid_anzahl: 0 }).unraid.anzahl, 0);
  assert.equal(a.quellenInfo(null).eigen.anzahl, null);
  // riskante Punkte
  assert.deepEqual(a.riskantEintrag('privileged'), { kennung: 'privileged', text: 'privileged' });
  assert.deepEqual(a.riskantEintrag({ id: 'docker_sock', text: 'Vollzugriff auf Docker' }), { kennung: 'docker_sock', text: 'Vollzugriff auf Docker' });
  assert.deepEqual(a.riskantEintrag({ code: 'host_netz', meldung: 'network_mode: host' }), { kennung: 'host_netz', text: 'network_mode: host' });
  assert.deepEqual(a.riskantEintrag({ art: 'docker_sock', dienst: 'app', wert: '/var/run/docker.sock', text: 'Vollzugriff' }), { kennung: 'docker_sock', text: 'Vollzugriff' }, 'A2: Kennung = art');
  // Port-Konflikte: Zahlen, Objekte mit feld oder port
  assert.deepEqual(a.portKonfliktFuer([8080], 'PORT_WEB', '8080'), { port: 8080, app: '', vorschlag: 8081 }, 'ohne Vorschlag des Agenten: nächster Port');
  assert.equal(a.portKonfliktFuer([8080], 'PORT_WEB', 8081), null);
  assert.deepEqual(a.portKonfliktFuer([{ feld: 'PORT_WEB', port: 8080, app: 'nginx', vorschlag: 8081 }], 'PORT_WEB', 8080), { port: 8080, app: 'nginx', vorschlag: 8081 });
  assert.deepEqual(a.portKonfliktFuer([{ port: 3001, app: 'kuma' }], 'PORT_WEB', '3001'), { port: 3001, app: 'kuma', vorschlag: 3002 });
  assert.deepEqual(a.portKonfliktFuer([{ feld: 'PORT_WEB', port: 3001, protokoll: 'tcp', belegt_von: 'App uptime-kuma' }], 'PORT_WEB', 3001), { port: 3001, app: 'App uptime-kuma', vorschlag: 3002 }, 'A2-Form mit belegt_von');
  assert.equal(a.portKonfliktFuer([65535], 'P', 65535).vorschlag, null);
  assert.equal(a.portKonfliktFuer([{ feld: 'ANDERES', port: 3001 }], 'PORT_WEB', 3001), null);
  assert.equal(a.portKonfliktFuer(undefined, 'PORT_WEB', 80), null);
  // WebUI
  assert.equal(a.webuiAufloesen('http://{HOST}:3001', 'nas.local'), 'http://nas.local:3001');
  assert.equal(a.webuiAufloesen('http://[IP]:8080/admin', '192.168.1.6'), 'http://192.168.1.6:8080/admin');
  assert.equal(a.webuiAufloesen('javascript:alert(1)', 'x'), '', 'nur http(s)');
  assert.equal(a.webuiAufloesen('', 'x'), ''); assert.equal(a.webuiAufloesen(null, 'x'), '');
  // Über die Domain eines Reverse-Proxys (der nur die Oberfläche weiterreicht) öffnen Apps direkt an der NAS-Adresse
  assert.equal(a.appHost({ ueber_proxy: true, nas_adresse: '192.168.1.29' }, 'fah-nas.example.org'), '192.168.1.29');
  assert.equal(a.appHost({ ueber_proxy: false, nas_adresse: '192.168.1.29' }, 'fahnas.local'), 'fahnas.local', 'direkt: Name aus der Adresszeile');
  assert.equal(a.appHost({ ueber_proxy: true, nas_adresse: '127.0.0.1' }, 'nas.example'), 'nas.example', 'Proxy auf dem NAS selbst: Name bleibt');
  assert.equal(a.appHost({ ueber_proxy: true, nas_adresse: 'fd00::29' }, 'nas.example'), '[fd00::29]', 'IPv6 in Klammern');
  assert.equal(a.appHost({ ueber_proxy: true, nas_adresse: null }, 'nas.example'), 'nas.example');
  assert.equal(a.appHost(null, ''), 'localhost'); assert.equal(a.appHost(undefined, '192.168.1.29'), '192.168.1.29');
  assert.equal(a.webuiAufloesen('http://{HOST}:8086', a.appHost({ ueber_proxy: true, nas_adresse: '192.168.1.29' }, 'fah-nas.example.org')), 'http://192.168.1.29:8086');
  const q = await lesen('apps.js');
  assert.ok(q.includes('appHost(ctx.zugang, '), 'Apps-Ansicht nimmt die Zugangsangaben aus ctx');
  assert.ok(!/const host = \(typeof location !== 'undefined' && location\.hostname\) \|\| 'localhost';/.test(q), 'nicht mehr blind location.hostname');
  const rahmen = await lesen('../app.js');
  assert.ok(rahmen.includes("zugang: zustand.nutzer ? zustand.nutzer.zugang || null : null"), 'ctx.zugang aus /api/ich');
  // Pfade: App-Ordner relativ, Freigabe absolut
  assert.equal(a.pfadWert({ modus: 'app', relativ: '/daten/' }), 'daten');
  assert.equal(a.pfadWert({ modus: 'freigabe', freigabePfad: '/data/shares/medien/', unterordner: '/Filme/' }), '/data/shares/medien/Filme');
  assert.equal(a.pfadWert({ modus: 'freigabe', freigabePfad: '/data/shares/medien', unterordner: '' }), '/data/shares/medien');
  const freigaben = [{ name: 'medien', pfad: '/data/shares/medien' }, { name: 'medien-alt', pfad: '/data/shares/medien-alt' }];
  assert.deepEqual(a.pfadZerlegen('daten', freigaben), { modus: 'app', freigabe: '', unterordner: '', relativ: 'daten' });
  assert.deepEqual(a.pfadZerlegen('/data/shares/medien/Filme', freigaben), { modus: 'freigabe', freigabe: 'medien', unterordner: 'Filme', relativ: '' });
  assert.deepEqual(a.pfadZerlegen('/data/shares/medien-alt', freigaben), { modus: 'freigabe', freigabe: 'medien-alt', unterordner: '', relativ: '' }, 'längster Treffer gewinnt');
  assert.deepEqual(a.pfadZerlegen('/data/shares/fotos/2026', []), { modus: 'freigabe', freigabe: 'fotos', unterordner: '2026', relativ: '' }, 'ohne Freigabenliste aus dem Pfad');
  assert.ok(a.pfadGueltig('daten/unter')); assert.ok(!a.pfadGueltig('../raus')); assert.ok(!a.pfadGueltig('a/../b'));
  assert.deepEqual(a.auswahlOptionen(['a', { wert: 'b', text: 'B' }]), [{ wert: 'a', text: 'a' }, { wert: 'b', text: 'B' }]);
  // Version kurz
  assert.equal(a.versionKurz('louislam/uptime-kuma:1@sha256:9f1c0a7b3c4d5e6f7a8b'), 'louislam/uptime-kuma:1 9f1c0a7b3c4d');
  assert.equal(a.versionKurz('10.9.11'), '10.9.11'); assert.equal(a.versionKurz(''), ''); assert.equal(a.versionKurz('x'.repeat(50)).length, 40);
  // Form des Agenten (apps.liste: version = {images:{image: digest}}) – Mini-PC 25.09.: „Version [object Object]“
  assert.equal(a.versionKurz({ images: { 'ghcr.io/home-assistant/home-assistant:stable': 'sha256:0123456789abcdef0123' } }), 'stable 0123456789ab');
  assert.equal(a.versionKurz({ images: { 'fah-adblock:latest': 'sha256:fedcba9876543210' } }), 'latest fedcba987654');
  assert.equal(a.versionKurz({ images: { 'registry:5000/app': 'sha256:aaaaaaaaaaaaaaaa' } }), 'latest aaaaaaaaaaaa', 'Port im Registry-Namen ist kein Tag');
  assert.equal(a.versionKurz({ images: { 'a:1': 'sha256:1', 'b:2': 'sha256:2' } }), '2 Images');
  assert.equal(a.versionKurz({ images: {} }), ''); assert.equal(a.versionKurz({ images: { 'a:1': null } }), ''); assert.equal(a.versionKurz({}), '');
  assert.ok(!a.versionKurz({ images: { 'a:1': 'sha256:1' } }).includes('[object'));
  assert.equal(a.versionTitel({ images: { 'a:1': 'sha256:11', 'b:2': 'sha256:22' } }), 'a:1 sha256:11\nb:2 sha256:22');
  assert.equal(a.versionTitel('10.9.11'), '10.9.11'); assert.equal(a.versionTitel(null), '');
  // Protokoll
  assert.deepEqual(a.protokollZeilen({ zeilen: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(a.protokollZeilen('x\ny'), ['x', 'y']);
  assert.deepEqual(a.protokollZeilen({ zeilen: [{ zeit: 'T', text: 'hallo' }] }), ['T hallo']);
  assert.deepEqual(a.protokollZeilen(null), []);
  assert.deepEqual([...a.PROTOKOLL_ZEILEN], [50, 200, 500, 1000]);
});

test('B2 laufwerke.js Helfer: Anschluss, Namen, Vorschlag, Kennung, Belegung, Dateisystem-Eigenschaften, Sortierung, Prozesse, Ereignisse, Label', async () => {
  const l = await laden('laufwerke.js');
  assert.equal(l.tranArt({ tran: 'usb' }), 'usb'); assert.equal(l.tranArt({ tran: 'sata' }), 'sata'); assert.equal(l.tranArt({ tran: 'nvme' }), 'nvme'); assert.equal(l.tranArt({ tran: 'ata' }), 'sata'); assert.equal(l.tranArt({}), 'sonst');
  assert.equal(l.anzeigeName({ label: 'BACKUP', modell: 'WD Elements' }), 'BACKUP');
  assert.equal(l.anzeigeName({ modell: 'WD Elements', pfad: '/dev/sdb1' }), 'WD Elements');
  assert.equal(l.anzeigeName({ pfad: '/dev/sdb1' }), 'sdb1');
  assert.equal(l.basename('/dev/sdb1'), 'sdb1'); assert.equal(l.basename('sdb'), 'sdb');
  // Namensvorschlag: Label → usb-<modell> → Muster
  assert.equal(l.namenVorschlag({ label: 'BACKUP' }), 'backup');
  assert.equal(l.namenVorschlag({ label: 'Fotos Übersee!' }), 'fotos-uebersee');
  assert.equal(l.namenVorschlag({ modell: 'WD Elements 25A3' }), 'usb-wd-elements-25a3');
  assert.equal(l.namenVorschlag({ pfad: '/dev/sdb1' }), 'usb-sdb1');
  assert.equal(l.namenVorschlag({ name: 'sdb1', label: 'STICK' }), 'stick', 'Kernelname zählt nicht als Name');
  assert.equal(l.namenVorschlag({ name: 'backup-usb', bekannt: true }), 'backup-usb');
  assert.equal(l.namenVorschlag({ label: '-_-' }), 'usb');
  for (const g of [{ label: 'A'.repeat(50) }, { label: '###' }, { modell: 'Ä Ö Ü' }, {}]) assert.ok(l.MUSTER_NAME.test(l.namenVorschlag(g)), `Vorschlag für ${JSON.stringify(g)} passt: ${l.namenVorschlag(g)}`);
  assert.equal(l.kennungVon({ kennung: 'UUID-1', pfad: '/dev/sdb1' }), 'UUID-1'); assert.equal(l.kennungVon({ pfad: '/dev/sdb1' }), '/dev/sdb1');
  // Belegung: aus belegt/frei, aus groesse/frei, unbekannt
  assert.deepEqual(l.belegung({ belegt: 30, frei: 70 }), { anteil: 0.3, belegt: 30, frei: 70, gesamt: 100 });
  assert.deepEqual(l.belegung({ groesse: 200, frei: 50 }), { anteil: 0.75, belegt: 150, frei: 50, gesamt: 200 });
  assert.equal(l.belegung({ groesse: 200 }).anteil, null); assert.equal(l.belegung({ groesse: 200, belegt: null, frei: null }).anteil, null);
  assert.equal(l.belegung({}).gesamt, null);
  // Dateisysteme
  assert.deepEqual(l.fsInfo('ntfs'), { fs: 'ntfs', bekannt: true, rechte: false, nurLesen: false });
  assert.deepEqual(l.fsInfo('exfat'), { fs: 'exfat', bekannt: true, rechte: false, nurLesen: false });
  assert.deepEqual(l.fsInfo('vfat'), { fs: 'vfat', bekannt: true, rechte: false, nurLesen: false });
  assert.deepEqual(l.fsInfo('ext4'), { fs: 'ext4', bekannt: true, rechte: true, nurLesen: false });
  assert.deepEqual(l.fsInfo('btrfs').rechte, true);
  assert.deepEqual(l.fsInfo('hfsplus'), { fs: 'hfsplus', bekannt: true, rechte: true, nurLesen: true });
  assert.deepEqual(l.fsInfo(''), { fs: '', bekannt: false, rechte: false, nurLesen: false });
  assert.deepEqual(l.FS_FORMATE.map((f) => f.fs), ['exfat', 'ext4', 'btrfs', 'ntfs']);
  assert.equal(l.labelMax('exfat'), 11); assert.equal(l.labelMax('ntfs'), 32); assert.equal(l.labelMax('ext4'), 16); assert.equal(l.labelMax('btrfs'), 32, 'Agent erlaubt höchstens 32'); assert.equal(l.labelMax('fremd'), 16);
  assert.ok(l.MUSTER_LABEL.test('Backup 2026')); assert.ok(!l.MUSTER_LABEL.test('Böse/Label')); assert.ok(!l.MUSTER_LABEL.test('-anfang'), 'Agent: beginnt mit Buchstabe/Ziffer'); assert.ok(!l.MUSTER_LABEL.test(''), 'Pflichtfeld');
  // Sortierung: extern vor System, eingehängt vor nicht, dann Pfad
  const sortiert = l.geraeteSortieren([{ pfad: '/dev/nvme0n1p2', system: true }, { pfad: '/dev/sdc1', eingehaengt: false }, { pfad: '/dev/sdb1', eingehaengt: true }, { pfad: '/dev/sda1', eingehaengt: false }]);
  assert.deepEqual(sortiert.map((g) => g.pfad), ['/dev/sdb1', '/dev/sda1', '/dev/sdc1', '/dev/nvme0n1p2']);
  // Prozesse aus E_BELEGT-Details
  assert.deepEqual(l.prozesseAus({ prozesse: [{ pid: 1234, befehl: 'smbd', nutzer: 'fabian' }] }), [{ pid: 1234, befehl: 'smbd', nutzer: 'fabian' }]);
  assert.deepEqual(l.prozesseAus({ prozesse: ['smbd (1234)'] }), [{ pid: '', befehl: 'smbd (1234)', nutzer: '' }]);
  const fuser = 'USER        PID ACCESS COMMAND\n/data/shares/backup:\n                     root     kernel mount /data/shares/backup\n                     fabian    4711 F.c.. rsync\n';
  const p = l.prozesseAus({ ausgabe: fuser });
  assert.ok(p.some((x) => x.pid === '4711' && x.befehl === 'rsync' && x.nutzer === 'fabian'), JSON.stringify(p));
  const p2 = l.prozesseAus({ name: 'backup', prozesse: fuser });
  assert.ok(p2.length === 1 && p2[0].pid === '4711' && p2[0].befehl === 'rsync', 'D2: prozesse als fuser-Text ' + JSON.stringify(p2));
  assert.deepEqual(l.prozesseAus({}), []); assert.deepEqual(l.prozesseAus(undefined), []);
  assert.deepEqual(l.prozesseAus({ ausgabe: 'irgendein Text' }), [{ pid: '', befehl: 'irgendein Text', nutzer: '' }]);
  // Ereignisse: roh oder in daten eingehüllt, andere Arten ignoriert
  assert.deepEqual(l.ereignisDaten({ ereignis: 'system', art: 'laufwerk', zustand: 'angesteckt', geraet: { pfad: '/dev/sdb1', label: 'STICK' } }), { zustand: 'angesteckt', geraet: { pfad: '/dev/sdb1', label: 'STICK' } });
  assert.equal(l.ereignisDaten({ daten: { art: 'laufwerk', zustand: 'entfernt', geraet: { pfad: '/dev/sdb1' } } }).zustand, 'entfernt');
  assert.equal(l.ereignisDaten({ art: 'laufwerk', daten: { zustand: 'eingehaengt', geraet: { pfad: '/dev/sdb1' } } }).zustand, 'eingehaengt');
  assert.equal(l.ereignisDaten({ ereignis: 'system', art: 'platte_voll', daten: { prozent: 96 } }), null);
  assert.equal(l.ereignisDaten(null), null); assert.equal(l.ereignisDaten({ ereignis: 'system' }), null);
});

test('B2 dashboard.js: Zusammenfassungen für die Kacheln „Apps“ und „Laufwerke“ (Formen aus §11/§12; VM-Kachel seit Teilprojekt 3 echt)', async () => {
  const d = await laden('dashboard.js');
  assert.deepEqual(d.appsZusammenfassung([{ zustand: 'running' }, { zustand: 'exited' }, { zustand: 'running', gesundheit: 'unhealthy' }, { zustand: 'dead' }, { zustand: 'restarting' }]), { gesamt: 5, laufend: 1, gestoppt: 1, fehlerhaft: 3, portkonflikt: 0 });
  assert.deepEqual(d.appsZusammenfassung({ apps: [{ zustand: 'running', gesundheit: 'healthy' }] }), { gesamt: 1, laufend: 1, gestoppt: 0, fehlerhaft: 0, portkonflikt: 0 });
  assert.equal(d.appsZusammenfassung([{ zustand: 'exited', portkonflikt: 'NAS-Port 8088 ist belegt' }]).portkonflikt, 1, 'Portkonflikt wird gezählt');
  assert.deepEqual(d.appsZusammenfassung([]), { gesamt: 0, laufend: 0, gestoppt: 0, fehlerhaft: 0, portkonflikt: 0 });
  assert.deepEqual(d.appsZusammenfassung(null), { gesamt: 0, laufend: 0, gestoppt: 0, fehlerhaft: 0, portkonflikt: 0 });
  assert.deepEqual(d.appsZeilen([{ name: 'b', titel: 'Beta', zustand: 'exited' }, { name: 'z', titel: 'Zeta', zustand: 'running' }, { name: 'a', titel: 'Alpha', zustand: 'running' }, { name: 'x', titel: 'Xeno', zustand: 'dead' }]).map((z) => `${z.stufe}:${z.name}`),
    ['fehler:x', 'laeuft:a', 'laeuft:z', 'gestoppt:b'], 'Kachel listet jede App: Fehler, laufende, gestoppte – je nach Titel');
  assert.deepEqual(d.appsZeilen(null), []);
  assert.deepEqual(d.laufwerkeZusammenfassung([{ pfad: '/dev/nvme0n1p2', system: true, eingehaengt: true }, { pfad: '/dev/sdb1', eingehaengt: true }, { pfad: '/dev/sdc1', eingehaengt: false }]), { gesamt: 3, extern: 2, eingehaengt: 1 });
  assert.deepEqual(d.laufwerkeZusammenfassung({ geraete: [] }), { gesamt: 0, extern: 0, eingehaengt: 0 });
  const quelle = await lesen('dashboard.js');
  assert.match(quelle, /c\.api\('apps\.liste'/, 'Kachel Apps liest apps.liste');
  assert.match(quelle, /c\.api\('laufwerke\.liste'/, 'Kachel Laufwerke liest laufwerke.liste');
  assert.ok(!/kommt_spaeter/.test(quelle), 'VM-Kachel ist kein Platzhalter mehr');
  assert.match(quelle, /api\('vms\.liste'/, 'VM-Kachel liest vms.liste');
  assert.ok(!/kachel\('apps'[^\n]*kommt_spaeter/.test(quelle), 'Apps-Kachel ist kein Platzhalter mehr');
});
