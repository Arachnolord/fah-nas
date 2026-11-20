// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für den eingebauten App-Katalog (katalog/*.json, Teil C2): gültiges JSON, Pflichtfelder, eindeutige IDs,
// Platzhalter ↔ Felder, Ports nur über Felder, Compose als YAML-Teilmenge (eigener Prüfer), Symbol https, webui,
// Erklärtexte, Pflicht-Einträge (FAH-Apps), README und Handbuch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.resolve(HIER, '..', '..');
const KATALOG = path.join(WURZEL, 'katalog');

const KATEGORIEN = new Set(['Medien', 'Fotos', 'Dateien & Sync', 'Sicherung', 'Netzwerk & DNS', 'Smart Home', 'Entwicklung',
  'Werkzeuge', 'Verwaltung', 'Überwachung', 'Dokumente', 'Sicherheit']);
const FELDARTEN = new Set(['port', 'pfad', 'variable', 'geheimnis', 'auswahl', 'schalter']);
const ID_MUSTER = /^[a-z0-9][a-z0-9-]{1,40}$/;
const FELDNAME_MUSTER = /^[A-Z][A-Z0-9_]{1,40}$/;
const PLATZHALTER = /\$\{([A-Z0-9_]+)\}/g;
const PFLICHT_IDS = ['fah-sicherung', 'fah-adblock', 'fah-medienconverter', 'fah-downloader', 'fah-passwortwechsel', 'fah-proxy'];
/** Schlüssel, die ein Compose-Fragment auf oberster Ebene haben darf (Entwurf §2). */
const OBERSTE_SCHLUESSEL = new Set(['services', 'volumes', 'networks']);
/** Dienst-Schlüssel, die eine Vorlage nie enthalten darf. */
const VERBOTENE_DIENSTSCHLUESSEL = new Set(['build', 'container_name', 'privileged', 'pid', 'env_file', 'extends', 'profiles']);
const MIN_EINTRAEGE = 25;

let zwischenspeicher = null;
async function alleEintraege() {
  if (zwischenspeicher) return zwischenspeicher;
  const dateien = (await fs.readdir(KATALOG)).filter((d) => d.endsWith('.json')).sort();
  const aus = [];
  for (const d of dateien) {
    const text = await fs.readFile(path.join(KATALOG, d), 'utf8');
    let daten;
    try { daten = JSON.parse(text); } catch (e) { assert.fail(`${d}: kein gültiges JSON – ${e.message}`); }
    aus.push({ datei: d, daten, text });
  }
  zwischenspeicher = aus;
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kleiner YAML-Teilmengen-Parser: Block-Maps, Block-Listen (auch Listen aus Maps), Skalare (mit/ohne Anführungszeichen),
// Kommentare. Genau das, was Compose-Fragmente des Katalogs brauchen – kein vollständiges YAML.
// ---------------------------------------------------------------------------------------------------------------------
function yamlZeilen(text) {
  const zeilen = [];
  text.split('\n').forEach((roh, i) => {
    const nr = i + 1;
    assert.ok(!roh.includes('\t'), `Zeile ${nr}: Tabulator im YAML`);
    const ohneKommentar = roh.replace(/(^|\s)#.*$/, '');
    if (!ohneKommentar.trim()) return;
    const einzug = ohneKommentar.match(/^ */)[0].length;
    assert.equal(einzug % 2, 0, `Zeile ${nr}: Einrückung ${einzug} ist kein Vielfaches von 2`);
    zeilen.push({ nr, einzug, inhalt: ohneKommentar.trim() });
  });
  return zeilen;
}

function skalar(text, nr) {
  const t = text.trim();
  if (t === '') return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    assert.ok(t.length >= 2, `Zeile ${nr}: kaputter Skalar`);
    return t.slice(1, -1);
  }
  assert.ok(!/^["'[{]/.test(t), `Zeile ${nr}: Flow-Syntax oder unvollständige Anführungszeichen (${t})`);
  return t;
}

/** Trennt "schluessel: rest" – der Schlüssel darf keine Anführungszeichen enthalten, Werte schon. */
function schluesselWert(inhalt, nr) {
  const m = inhalt.match(/^([A-Za-z0-9_.\-/$]+):(?:\s+(.*))?$/);
  assert.ok(m, `Zeile ${nr}: weder "schlüssel: wert" noch Listeneintrag (${inhalt})`);
  return { schluessel: m[1], rest: m[2] ?? '' };
}

function parseBlock(zeilen, pos, einzug) {
  const erste = zeilen[pos];
  if (!erste || erste.einzug < einzug) return [null, pos];
  if (erste.inhalt.startsWith('- ') || erste.inhalt === '-') return parseListe(zeilen, pos, erste.einzug);
  return parseMap(zeilen, pos, erste.einzug);
}

function parseMap(zeilen, pos, einzug) {
  const map = {};
  while (pos < zeilen.length && zeilen[pos].einzug === einzug && !zeilen[pos].inhalt.startsWith('- ')) {
    const z = zeilen[pos];
    const { schluessel, rest } = schluesselWert(z.inhalt, z.nr);
    assert.ok(!(schluessel in map), `Zeile ${z.nr}: Schlüssel ${schluessel} doppelt`);
    pos++;
    if (rest.trim() !== '') { map[schluessel] = skalar(rest, z.nr); continue; }
    const naechste = zeilen[pos];
    if (naechste && naechste.einzug > einzug) {
      [map[schluessel], pos] = parseBlock(zeilen, pos, naechste.einzug);
    } else if (naechste && naechste.einzug === einzug && naechste.inhalt.startsWith('- ')) {
      // Liste auf gleicher Höhe wie der Schlüssel (in Compose-Dateien üblich, z. B. "ports:\n- …") – wir verlangen Einrückung
      assert.fail(`Zeile ${naechste.nr}: Listeneinträge müssen unter "${schluessel}:" eingerückt sein`);
    } else {
      map[schluessel] = null;
    }
  }
  if (pos < zeilen.length && zeilen[pos].einzug > einzug) assert.fail(`Zeile ${zeilen[pos].nr}: unerwartete Einrückung`);
  return [map, pos];
}

function parseListe(zeilen, pos, einzug) {
  const liste = [];
  while (pos < zeilen.length && zeilen[pos].einzug === einzug && (zeilen[pos].inhalt.startsWith('- ') || zeilen[pos].inhalt === '-')) {
    const z = zeilen[pos];
    const rest = z.inhalt.slice(1).trim();
    pos++;
    if (rest === '') { [liste[liste.length], pos] = parseBlock(zeilen, pos, einzug + 2); continue; }
    // Eintrag "- schlüssel: wert" → Map, deren weitere Schlüssel um 2 eingerückt folgen
    const alsMap = rest.match(/^([A-Za-z_][A-Za-z0-9_.\-]*):(?:\s+(.*))?$/);
    if (alsMap && !rest.startsWith('"') && !rest.startsWith("'") && !/^[A-Za-z0-9_]+=/.test(rest) && !/^\//.test(rest) && !rest.includes('${')) {
      const map = {};
      map[alsMap[1]] = alsMap[2] !== undefined ? skalar(alsMap[2], z.nr) : null;
      if (alsMap[2] === undefined && zeilen[pos] && zeilen[pos].einzug > einzug + 2) [map[alsMap[1]], pos] = parseBlock(zeilen, pos, zeilen[pos].einzug);
      while (pos < zeilen.length && zeilen[pos].einzug === einzug + 2 && !zeilen[pos].inhalt.startsWith('- ')) {
        const w = zeilen[pos];
        const { schluessel, rest: r } = schluesselWert(w.inhalt, w.nr);
        pos++;
        if (r.trim() !== '') map[schluessel] = skalar(r, w.nr);
        else if (zeilen[pos] && zeilen[pos].einzug > einzug + 2) [map[schluessel], pos] = parseBlock(zeilen, pos, zeilen[pos].einzug);
        else map[schluessel] = null;
      }
      liste.push(map);
    } else {
      liste.push(skalar(rest, z.nr));
    }
  }
  return [liste, pos];
}

/** Parst ein Compose-Fragment; wirft assert-Fehler mit Zeilennummer. */
export function composeParsen(text) {
  const zeilen = yamlZeilen(text);
  assert.ok(zeilen.length > 0, 'compose ist leer');
  assert.equal(zeilen[0].einzug, 0, 'compose muss ohne Einrückung beginnen');
  const [baum, pos] = parseMap(zeilen, 0, 0);
  assert.equal(pos, zeilen.length, `Zeile ${zeilen[pos]?.nr}: konnte nicht zu Ende gelesen werden`);
  return baum;
}

function platzhalter(text) {
  return [...String(text).matchAll(PLATZHALTER)].map((m) => m[1]);
}

/** Durchläuft alle Skalare eines Baums und ruft fn(wert, pfadAlsListe). */
function skalareBesuchen(knoten, fn, pfad = []) {
  if (Array.isArray(knoten)) knoten.forEach((k, i) => skalareBesuchen(k, fn, [...pfad, i]));
  else if (knoten && typeof knoten === 'object') Object.entries(knoten).forEach(([k, v]) => skalareBesuchen(v, fn, [...pfad, k]));
  else fn(knoten, pfad);
}

// ---------------------------------------------------------------------------------------------------------------------

test('katalog: mindestens 25 Vorlagen, jede Datei gültiges JSON mit Dateiname = id', async () => {
  const eintraege = await alleEintraege();
  assert.ok(eintraege.length >= MIN_EINTRAEGE, `nur ${eintraege.length} Einträge, mindestens ${MIN_EINTRAEGE} nötig`);
  for (const { datei, daten, text } of eintraege) {
    assert.equal(daten.id, path.basename(datei, '.json'), `${datei}: id muss dem Dateinamen entsprechen`);
    assert.ok(text.endsWith('\n'), `${datei}: Datei endet nicht mit Zeilenumbruch`);
    assert.equal(text, JSON.stringify(daten, null, 2) + '\n', `${datei}: nicht mit 2 Leerzeichen formatiert (JSON.stringify(…, null, 2))`);
  }
});

test('katalog: IDs eindeutig und im Format /^[a-z0-9][a-z0-9-]+$/', async () => {
  const gesehen = new Set();
  for (const { datei, daten } of await alleEintraege()) {
    assert.match(daten.id, ID_MUSTER, `${datei}: id ungültig`);
    assert.ok(!gesehen.has(daten.id), `${datei}: id ${daten.id} doppelt`);
    gesehen.add(daten.id);
  }
});

test('katalog: Pflichtfelder, Typen, Kategorien, quelle "eingebaut", Symbol https, deutsche Beschreibung (1–2 Sätze)', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    const erlaubt = new Set(['id', 'name', 'beschreibung', 'kategorie', 'symbol', 'quelle', 'verfuegbar', 'bauen', 'host_ports', 'dokumentation', 'webui', 'compose', 'felder', 'hinweise', 'risiko', 'nur_bestand']);
    for (const k of Object.keys(daten)) assert.ok(erlaubt.has(k), `${datei}: unbekanntes Feld ${k}`);
    for (const k of ['id', 'name', 'beschreibung', 'kategorie', 'symbol', 'quelle', 'compose']) assert.equal(typeof daten[k], 'string', `${datei}: ${k} fehlt oder ist kein Text`);
    assert.ok(daten.name.trim().length >= 2 && daten.name.length <= 60, `${datei}: name zu kurz/lang`);
    assert.equal(daten.quelle, 'eingebaut', `${datei}: quelle muss "eingebaut" sein`);
    assert.ok(KATEGORIEN.has(daten.kategorie), `${datei}: unbekannte Kategorie "${daten.kategorie}"`);
    assert.match(daten.symbol, /^https:\/\/[^\s"']+\.(png|svg|webp|jpg)$/i, `${datei}: symbol muss eine https-URL auf ein Bild sein`);
    assert.ok(daten.beschreibung.length >= 40 && daten.beschreibung.length <= 320, `${datei}: beschreibung ${daten.beschreibung.length} Zeichen (40–320 erwartet)`);
    assert.match(daten.beschreibung.trim(), /[.!]$/, `${datei}: beschreibung endet nicht mit Satzzeichen`);
    const saetze = daten.beschreibung.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).length;
    assert.ok(saetze <= 3, `${datei}: beschreibung hat ${saetze} Sätze (höchstens 2–3)`);
    if ('verfuegbar' in daten) assert.equal(daten.verfuegbar, false, `${datei}: verfuegbar nur als false angeben (true = Standard)`);
    if (daten.dokumentation !== null && daten.dokumentation !== undefined) assert.match(daten.dokumentation, /^https:\/\//, `${datei}: dokumentation muss https sein`);
    if (daten.webui !== null) assert.match(daten.webui, /^https?:\/\/\{HOST\}(:(\d{2,5}|\{[A-Z0-9_]+\}))?(\/[^\s]*)?$/, `${datei}: webui im Format http(s)://{HOST}:{PORT_X}/pfad erwartet`);
    assert.ok(Array.isArray(daten.felder), `${datei}: felder muss eine Liste sein`);
    for (const k of ['hinweise', 'risiko']) if (k in daten) {
      assert.ok(Array.isArray(daten[k]) && daten[k].length > 0 && daten[k].every((h) => typeof h === 'string' && h.trim().length >= 15), `${datei}: ${k} muss eine nicht-leere Liste aus Texten sein`);
    }
  }
});

test('katalog: Felder – Art, Standard, Beschriftung und Erklärtext (Betreiber-Vorgabe: jede Einstellung erklärt)', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    const namen = new Set();
    for (const f of daten.felder) {
      const wo = `${datei} Feld ${f.name}`;
      assert.match(String(f.name), FELDNAME_MUSTER, `${wo}: Feldname muss GROSS_MIT_UNTERSTRICH sein`);
      assert.ok(!namen.has(f.name), `${wo}: doppelt`); namen.add(f.name);
      assert.notEqual(f.name, 'HOST', `${wo}: HOST ist für die Adresse des NAS reserviert`);
      assert.ok(FELDARTEN.has(f.art), `${wo}: unbekannte Art ${f.art}`);
      assert.ok('standard' in f, `${wo}: standard fehlt`);
      assert.ok(typeof f.beschriftung === 'string' && f.beschriftung.trim().length >= 3 && f.beschriftung.length <= 60, `${wo}: beschriftung fehlt oder zu lang`);
      assert.ok(typeof f.erklaerung === 'string' && f.erklaerung.trim().length >= 20, `${wo}: erklaerung fehlt oder ist zu kurz (jede Einstellung braucht eine Erklärung)`);
      assert.ok(!/\bSie\b|\bIhnen\b|\bIhr(e|en)?\b/.test(f.erklaerung), `${wo}: Erklärtext siezt`);
      const erlaubt = new Set(['name', 'art', 'standard', 'beschriftung', 'erklaerung', 'werte', 'pflicht', 'erzeugen', 'protokoll', 'adresse_feld']);
      if ('protokoll' in f) assert.ok(f.art === 'port' && ['tcp', 'udp', 'tcp+udp'].includes(f.protokoll), `${wo}: protokoll nur bei Ports (tcp, udp, tcp+udp)`);
      if ('adresse_feld' in f) assert.ok(f.art === 'port' && daten.felder.some((x) => x.name === f.adresse_feld && x.art === 'variable'), `${wo}: adresse_feld muss ein Text-Feld der Vorlage sein`);
      for (const k of Object.keys(f)) assert.ok(erlaubt.has(k), `${wo}: unbekannter Schlüssel ${k}`);
      switch (f.art) {
        case 'port':
          assert.ok(Number.isInteger(f.standard) && f.standard >= 1 && f.standard <= 65535, `${wo}: Port-Standard muss 1–65535 sein`);
          break;
        case 'pfad':
          assert.ok(typeof f.standard === 'string' && f.standard.length > 0, `${wo}: Pfad-Standard fehlt`);
          assert.ok(!f.standard.includes('..') && !/^\.?\//.test(f.standard) || /^\/data\/shares\/[a-z0-9_-]+/.test(f.standard), `${wo}: Pfad muss relativ (im App-Ordner) oder eine Freigabe unter /data/shares/<name> sein – der Ordner aller Freigaben ist nicht erlaubt`);
          break;
        case 'variable':
          assert.equal(typeof f.standard, 'string', `${wo}: variable-Standard muss Text sein`);
          break;
        case 'geheimnis':
          assert.equal(typeof f.standard, 'string', `${wo}: geheimnis-Standard muss Text sein`);
          if (f.erzeugen) assert.equal(f.standard, '', `${wo}: erzeugen nur mit leerem Standard`);
          if (f.pflicht) assert.equal(f.standard, '', `${wo}: pflicht nur mit leerem Standard`);
          assert.ok(!(f.erzeugen && f.pflicht), `${wo}: erzeugen und pflicht schließen sich aus`);
          break;
        case 'auswahl':
          assert.ok(Array.isArray(f.werte) && f.werte.length >= 2 && f.werte.every((w) => typeof w === 'string'), `${wo}: werte-Liste fehlt`);
          assert.ok(f.werte.includes(f.standard), `${wo}: Standard nicht in werte`);
          break;
        case 'schalter':
          assert.equal(typeof f.standard, 'boolean', `${wo}: schalter-Standard muss true/false sein`);
          break;
        default: assert.fail(`${wo}: Art ${f.art}`);
      }
      if ('pflicht' in f) assert.equal(f.pflicht, true, `${wo}: pflicht nur als true angeben`);
      if ('erzeugen' in f) { assert.equal(f.erzeugen, true, `${wo}: erzeugen nur als true angeben`); assert.equal(f.art, 'geheimnis', `${wo}: erzeugen nur bei geheimnis`); }
      if ('werte' in f) assert.equal(f.art, 'auswahl', `${wo}: werte nur bei auswahl`);
    }
  }
});

test('katalog: jeder Platzhalter im compose hat ein Feld und jedes Feld wird im compose benutzt', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    const imCompose = new Set(platzhalter(daten.compose));
    const felder = new Set(daten.felder.map((f) => f.name));
    for (const p of imCompose) assert.ok(felder.has(p), `${datei}: Platzhalter \${${p}} ohne Feld`);
    for (const f of felder) assert.ok(imCompose.has(f), `${datei}: Feld ${f} kommt im compose nicht vor`);
    // Kein anderes $-Konstrukt (Compose würde $VAR oder ${VAR:-x} auch auflösen – wir wollen nur ${NAME})
    const fremd = daten.compose.replace(PLATZHALTER, '').match(/\$[A-Za-z{]/g);
    assert.equal(fremd, null, `${datei}: nur \${NAME}-Platzhalter erlaubt, gefunden: ${fremd}`);
  }
});

test('katalog: webui nutzt {HOST} und nur vorhandene Port-Felder', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    if (daten.webui === null) continue;
    const felder = new Map(daten.felder.map((f) => [f.name, f]));
    const namen = [...daten.webui.matchAll(/\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
    assert.ok(namen.includes('HOST'), `${datei}: webui ohne {HOST}`);
    for (const n of namen.filter((x) => x !== 'HOST')) {
      assert.ok(felder.has(n), `${datei}: webui nutzt unbekanntes Feld ${n}`);
      assert.equal(felder.get(n).art, 'port', `${datei}: webui-Feld ${n} ist kein Port`);
    }
    if (!namen.some((x) => x !== 'HOST')) {
      // Fester Port in der webui nur bei Host-Netz (kein Port-Feld möglich)
      assert.match(daten.compose, /network_mode: host/, `${datei}: webui mit festem Port nur bei network_mode: host`);
    }
  }
});

test('katalog: compose ist gültige YAML-Teilmenge – services vorhanden, nur services/volumes/networks oben, restart, Image mit Tag, keine verbotenen Schlüssel', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    let baum;
    try { baum = composeParsen(daten.compose); } catch (e) { assert.fail(`${datei}: ${e.message}`); }
    for (const k of Object.keys(baum)) assert.ok(OBERSTE_SCHLUESSEL.has(k), `${datei}: oberster Schlüssel ${k} nicht erlaubt`);
    assert.ok(baum.services && typeof baum.services === 'object' && !Array.isArray(baum.services), `${datei}: services fehlt`);
    const dienste = Object.entries(baum.services);
    assert.ok(dienste.length >= 1, `${datei}: kein Dienst`);
    for (const [name, d] of dienste) {
      const wo = `${datei} Dienst ${name}`;
      assert.match(name, /^[a-z0-9][a-z0-9_-]*$/, `${wo}: Dienstname`);
      assert.ok(d && typeof d === 'object', `${wo}: leer`);
      assert.match(String(d.image), /^([a-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9._/-]+:[A-Za-z0-9._-]+$/, `${wo}: image muss "name:tag" sein (${d.image})`);
      assert.equal(d.restart, 'unless-stopped', `${wo}: restart: unless-stopped fehlt`);
      for (const k of Object.keys(d)) assert.ok(!VERBOTENE_DIENSTSCHLUESSEL.has(k), `${wo}: Schlüssel ${k} ist im Katalog verboten`);
      if (d.cap_add) for (const c of d.cap_add) assert.ok(['NET_ADMIN', 'NET_RAW', 'NET_BIND_SERVICE'].includes(c), `${wo}: cap_add ${c} nicht erlaubt`);
      if (d.environment !== undefined) {
        assert.ok(Array.isArray(d.environment), `${wo}: environment als Liste "- NAME=wert" schreiben`);
        for (const z of d.environment) assert.match(String(z), /^[A-Za-z_][A-Za-z0-9_]*=/, `${wo}: environment-Eintrag "${z}" nicht im Format NAME=wert`);
      }
    }
    if (baum.volumes) for (const [n, v] of Object.entries(baum.volumes)) assert.ok(v === null || typeof v === 'object', `${datei}: volumes.${n}`);
  }
});

test('katalog: Host-Ports nur über Port-Felder, Protokollangabe gültig, Port-Felder nur in ports/environment', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    const baum = composeParsen(daten.compose);
    const felder = new Map(daten.felder.map((f) => [f.name, f]));
    let portZeilen = 0;
    for (const [name, d] of Object.entries(baum.services)) {
      const wo = `${datei} Dienst ${name}`;
      if (d.network_mode === 'host') {
        assert.ok(!d.ports, `${wo}: ports zusammen mit network_mode: host`);
        assert.ok((daten.risiko || []).some((r) => /host/i.test(r)), `${datei}: network_mode: host braucht einen risiko-Hinweis`);
      }
      for (const p of d.ports || []) {
        portZeilen++;
        const m = String(p).match(/^\$\{([A-Z0-9_]+)\}:(\d{1,5})(\/(tcp|udp))?$/);
        assert.ok(m, `${wo}: Port-Eintrag "${p}" muss "\${PORT_FELD}:containerport[/tcp|/udp]" sein (kein fester Host-Port)`);
        assert.equal(felder.get(m[1])?.art, 'port', `${wo}: ${m[1]} ist kein Port-Feld`);
        assert.ok(+m[2] >= 1 && +m[2] <= 65535, `${wo}: Container-Port ${m[2]}`);
      }
      // Volumes: nur Pfad-Felder als Host-Seite, benannte Volumes oder docker.sock (Risiko-Hinweis nötig)
      for (const v of d.volumes || []) {
        assert.equal(typeof v, 'string', `${wo}: volumes nur in Kurzform "quelle:ziel[:opt]"`);
        const [quelle, ziel] = v.split(':');
        assert.ok(ziel && ziel.startsWith('/'), `${wo}: Volume "${v}" ohne absoluten Zielpfad`);
        if (quelle === '/var/run/docker.sock') {
          assert.ok((daten.risiko || []).some((r) => /docker\.sock/.test(r)), `${datei}: docker.sock braucht einen risiko-Hinweis`);
        } else if (quelle.startsWith('${')) {
          const n = platzhalter(quelle)[0];
          assert.equal(felder.get(n)?.art, 'pfad', `${wo}: Volume-Quelle ${quelle} ist kein Pfad-Feld`);
        } else {
          assert.match(quelle, /^[a-z][a-z0-9_-]*$/, `${wo}: Volume-Quelle "${quelle}" muss Pfad-Feld, benanntes Volume oder docker.sock sein`);
          assert.ok(baum.volumes && quelle in baum.volumes, `${wo}: benanntes Volume ${quelle} nicht unter volumes deklariert`);
        }
      }
    }
    // Port-Felder dürfen außer in ports nur in environment-Zeilen vorkommen (Host-Netz-Apps)
    for (const f of daten.felder.filter((x) => x.art === 'port')) {
      const zeilen = daten.compose.split('\n').filter((z) => z.includes(`\${${f.name}}`));
      for (const z of zeilen) assert.match(z.trim(), /^- ("?\$\{[A-Z0-9_]+\}:\d+|[A-Za-z0-9_]+=\$\{)/, `${datei}: Port-Feld ${f.name} in unerwarteter Zeile: ${z.trim()}`);
    }
    if (portZeilen === 0) assert.ok(daten.webui === null || /network_mode: host/.test(daten.compose), `${datei}: keine Ports, aber webui`);
  }
});

test('katalog: Geheimnis-Felder nur in environment/command, Pfad-Felder nur als Volume-Quelle oder in environment', async () => {
  for (const { datei, daten } of await alleEintraege()) {
    const baum = composeParsen(daten.compose);
    const felder = new Map(daten.felder.map((f) => [f.name, f]));
    skalareBesuchen(baum, (wert, pfad) => {
      for (const n of platzhalter(wert ?? '')) {
        const f = felder.get(n);
        const abschnitt = pfad[2]; // services.<dienst>.<abschnitt>
        if (f.art === 'geheimnis') assert.ok(['environment', 'command'].includes(abschnitt), `${datei}: Geheimnis ${n} außerhalb von environment (${pfad.join('.')})`);
        if (f.art === 'pfad') assert.ok(['volumes', 'environment'].includes(abschnitt), `${datei}: Pfad ${n} außerhalb von volumes/environment (${pfad.join('.')})`);
        if (f.art === 'schalter' || f.art === 'auswahl') assert.ok(['environment', 'command'].includes(abschnitt), `${datei}: ${f.art} ${n} außerhalb von environment (${pfad.join('.')})`);
      }
    });
  }
});

test('katalog: Pflicht-Einträge (FAH-Apps) vorhanden, bauen aus dem Release-ZIP (FAH-NAS baut selbst), Ports/Images laut Compose-Beispielen', async () => {
  const eintraege = new Map((await alleEintraege()).map(({ daten }) => [daten.id, daten]));
  for (const id of PFLICHT_IDS) {
    const e = eintraege.get(id);
    assert.ok(e, `Pflicht-Eintrag ${id} fehlt`);
    assert.ok(e.bauen && /^[A-Za-z0-9._-]+\.zip$/.test(e.bauen.release_zip), `${id}: bauen.release_zip fehlt`);
    assert.ok(!('verfuegbar' in e), `${id}: kein verfuegbar:false – installierbar wird die App durch den mitgelieferten Quellcode`);
    assert.ok(!e.hinweise.some((h) => /docker build|~\/claude/.test(h)), `${id}: kein Hand-Bau-Hinweis und kein Mac-Pfad in den Hinweisen`);
    assert.ok(e.hinweise.some((h) => /Release-ZIP/.test(h)), `${id}: Hinweis „baut aus dem Release-ZIP“ fehlt`);
    assert.ok(!/build:/.test(e.compose), `${id}: kein build: im Katalog`);
    assert.match(e.compose, new RegExp(`image: ${id}:latest`), `${id}: lokales Image ${id}:latest`);
  }
  const port = (e, name) => e.felder.find((f) => f.name === name)?.standard;
  assert.equal(port(eintraege.get('fah-sicherung'), 'PORT_WEB'), 8060);
  assert.match(eintraege.get('fah-sicherung').compose, /:8060"/);
  assert.equal(port(eintraege.get('fah-adblock'), 'PORT_DNS'), 53);
  assert.equal(port(eintraege.get('fah-adblock'), 'PORT_WEB'), 8053);
  assert.match(eintraege.get('fah-adblock').compose, /network_mode: host/);
  assert.match(eintraege.get('fah-adblock').compose, /DNS_PORT=\$\{PORT_DNS\}/);
  assert.equal(port(eintraege.get('fah-medienconverter'), 'PORT_WEB'), 8686);
  assert.match(eintraege.get('fah-medienconverter').compose, /:8686"/);
  assert.equal(port(eintraege.get('fah-downloader'), 'PORT_WEB'), 8080);
  assert.match(eintraege.get('fah-downloader').compose, /:8080"/);
  assert.equal(port(eintraege.get('fah-passwortwechsel'), 'PORT_WEB'), 8070);
  assert.match(eintraege.get('fah-passwortwechsel').compose, /:8070"[\s\S]*read_only: true/);
});

test('katalog: geforderte Fremd-Apps vorhanden, Risiko-Hinweise bei docker.sock, Port-53-Hinweis bei DNS-Apps', async () => {
  const eintraege = new Map((await alleEintraege()).map(({ daten }) => [daten.id, daten]));
  for (const id of ['jellyfin', 'plex', 'immich', 'nextcloud', 'home-assistant', 'vaultwarden', 'uptime-kuma', 'portainer', 'paperless-ngx',
    'syncthing', 'qbittorrent', 'pihole', 'adguard-home', 'gitea', 'grafana', 'prometheus', 'node-red', 'mosquitto', 'code-server',
    'filebrowser', 'navidrome', 'audiobookshelf', 'photoprism', 'duplicati', 'homepage', 'watchtower', 'dozzle', 'stirling-pdf', 'it-tools', 'frigate']) {
    assert.ok(eintraege.has(id), `Eintrag ${id} fehlt`);
  }
  for (const id of ['portainer', 'watchtower', 'dozzle', 'homepage', 'fah-sicherung']) {
    assert.ok(eintraege.get(id).risiko?.some((r) => /docker\.sock/.test(r)), `${id}: risiko docker.sock fehlt`);
  }
  for (const id of ['pihole', 'adguard-home', 'fah-adblock']) {
    assert.ok(eintraege.get(id).hinweise?.some((h) => /systemd-resolved/.test(h)), `${id}: Hinweis auf Port-53-Konflikt mit systemd-resolved fehlt`);
  }
  assert.match(eintraege.get('plex').compose, /PLEX_CLAIM=\$\{PLEX_CLAIM\}/);
  assert.equal(Object.keys(composeParsen(eintraege.get('immich').compose).services).length, 4, 'immich: vier Dienste (server, machine-learning, redis, postgres)');
  assert.ok(Object.keys(composeParsen(eintraege.get('nextcloud').compose).services).length >= 2, 'nextcloud: mit Datenbank');
  assert.ok(Object.keys(composeParsen(eintraege.get('paperless-ngx').compose).services).length >= 2, 'paperless-ngx: mit Redis/Valkey');
  assert.ok(eintraege.get('frigate').hinweise.some((h) => /Coral/.test(h)), 'frigate: Hinweis Kamera/Coral');
});

test('katalog: Kategorien aus dem vorgegebenen Satz werden alle benutzt', async () => {
  const benutzt = new Set((await alleEintraege()).map(({ daten }) => daten.kategorie));
  for (const k of KATEGORIEN) assert.ok(benutzt.has(k), `Kategorie „${k}“ ohne Eintrag`);
});

test('katalog: README erklärt das Format (alle Feldarten, Platzhalter, Pflichtfelder), Handbuch vorhanden', async () => {
  const readme = await fs.readFile(path.join(KATALOG, 'README.md'), 'utf8');
  for (const w of ['id', 'name', 'beschreibung', 'kategorie', 'symbol', 'quelle', 'webui', 'compose', 'felder', 'hinweise', 'risiko', 'verfuegbar',
    '{HOST}', '${', 'port', 'pfad', 'variable', 'geheimnis', 'auswahl', 'schalter', 'erzeugen', 'pflicht', 'restart: unless-stopped', 'docker.sock']) {
    assert.ok(readme.includes(w), `README.md erwähnt „${w}“ nicht`);
  }
  assert.ok(/Fabian Hammer/.test(readme), 'README ohne Urheber');
  const handbuch = await fs.readFile(path.join(WURZEL, 'docs', 'handbuch', 'apps.md'), 'utf8');
  for (const w of ['Katalog', 'Installieren', 'Unraid', 'Risik', 'Schnappsch', 'Aktualisieren', 'docker.sock']) {
    assert.ok(handbuch.includes(w), `docs/handbuch/apps.md behandelt „${w}“ nicht`);
  }
  assert.ok(!/\bSie\b/.test(handbuch.replace(/„[^“]*“/g, '')), 'Handbuch siezt');
});

test('katalog: YAML-Teilmengen-Prüfer erkennt typische Fehler', () => {
  assert.throws(() => composeParsen('services:\n\tapp:\n'), /Tabulator/);
  assert.throws(() => composeParsen('services:\n   app:\n    image: a:b\n'), /Vielfaches von 2/);
  assert.throws(() => composeParsen('services:\n  app:\n    image: a:b\n    image: c:d\n'), /doppelt/);
  assert.throws(() => composeParsen('services:\n  app:\n    ports:\n    - "1:2"\n'), /eingerückt/);
  assert.throws(() => composeParsen('services:\n  app:\n    image: "a:b\n'), /Anführungszeichen/);
  const baum = composeParsen('services:\n  app:\n    image: a:b # Kommentar\n    ports:\n      - "${P}:80"\n    environment:\n      - X=1\n    command:\n      - -c\n      - \'echo "hi"\'\n    tmpfs:\n      - /tmp:size=1m\nvolumes:\n  daten:\n');
  assert.deepEqual(baum.services.app.ports, ['${P}:80']);
  assert.deepEqual(baum.services.app.command, ['-c', 'echo "hi"']);
  assert.equal(baum.services.app.image, 'a:b');
  assert.deepEqual(baum.volumes, { daten: null });
  const liste = composeParsen('services:\n  a:\n    volumes:\n      - type: tmpfs\n        target: /x\n        tmpfs:\n          size: 5\n');
  assert.deepEqual(liste.services.a.volumes, [{ type: 'tmpfs', target: '/x', tmpfs: { size: '5' } }]);
});

test('katalog: eigene FAH-Apps stehen in der Liste vorn', async () => {
  const { suchen } = await import('../../src/agent/apps/katalog.js');
  const alle = [
    { id: 'jellyfin', name: 'Jellyfin', quelle: 'eingebaut', kategorie: 'Medien', beliebtheit: 99 },
    { id: 'fah-sicherung', name: 'FAH-Sicherung', quelle: 'eingebaut', kategorie: 'Sicherung' },
    { id: 'adguard', name: 'AdGuard Home', quelle: 'eingebaut', kategorie: 'Netzwerk & DNS' },
    { id: 'fah-adblock', name: 'FAH-Adblock', quelle: 'eingebaut', kategorie: 'Netzwerk & DNS' },
  ];
  const r = suchen(alle, {});
  const ids = (r.eintraege || r).map((v) => v.id);
  assert.deepEqual(ids.slice(0, 2).sort(), ['fah-adblock', 'fah-sicherung']);
});

test('katalog: eigene FAH-Apps sind nur noch Bestand (Betreiber 12.10.2026: eigene Apps nur per ZIP)', async () => {
  const fah = (await alleEintraege()).filter(({ daten }) => daten.bauen && daten.bauen.release_zip);
  assert.ok(fah.length >= 1);
  for (const { datei, daten } of fah) assert.equal(daten.nur_bestand, true, `${datei}: FAH-App muss nur_bestand sein`);
  for (const { datei, daten } of await alleEintraege()) if (!(daten.bauen && daten.bauen.release_zip)) assert.ok(!daten.nur_bestand, `${datei}: nur FAH-Apps sind Bestand`);
});
