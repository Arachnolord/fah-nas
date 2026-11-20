// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Vorlage → Compose: Prüfung einer Katalog-Vorlage (Felder, Compose-Fragment), Prüfung der Werte je Feldart,
// Rendern (Platzhalter ${FELD} nur aus definierten Feldern), Risiko-Erkennung (privileged, network_mode host,
// docker.sock, cap_add, pid host, devices …), veröffentlichte Host-Ports und Bind-Mount-Wurzeln.
//
// Kleiner YAML-Leser (Block-Mappings, Sequenzen, Skalare, Fluss-Listen/-Mappings, Blockskalare) ohne Fremdpaket –
// er versteht die Teilmenge, die Compose-Dateien benutzen; Anker/Aliase/Tags lehnt er ab (E_PARAMS).
//
// Sicherheitsgrundsatz: Werte des Nutzers werden NIE in den YAML-Text eingesetzt. compose.yml behält die Platzhalter
// ${FELD}; alle Werte (auch Geheimnisse) stehen in der .env-Datei (0600 root), aus der docker compose interpoliert.
// Für die Prüfung (Risiken, Ports, Pfade) wird in einer Kopie eingesetzt – nie in die Datei geschrieben.

import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const NAME_APP = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const NAME_FELD = /^[A-Z][A-Z0-9_]{0,63}$/;
export const ID_KATALOG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const FELDARTEN = Object.freeze(['port', 'pfad', 'variable', 'geheimnis', 'auswahl', 'schalter']);
export const QUELLEN = Object.freeze(['eingebaut', 'unraid', 'eigen']);
export const PORT_PROTOKOLLE = Object.freeze(['tcp', 'udp', 'tcp+udp']);
/**
 * Marken im Standardwert eines Text-Felds, die Oberfläche (apps.katalog.eintrag) und Installer mit dem Netz des NAS
 * füllen: {NAS_IP} = IPv4-Adresse im Heimnetz, {NAS_GATEWAY} = Router (Standardroute).
 */
export const NAS_MARKEN = Object.freeze({ '{NAS_IP}': 'ip', '{NAS_GATEWAY}': 'gateway' });

/** Setzt NAS-Marken in einen Text ein; fehlt ein Wert, bleibt die Marke stehen (Aufrufer prüft mit hatNasMarke). */
export function nasMarkenEinsetzen(text, nas) {
  let t = String(text);
  for (const [marke, schluessel] of Object.entries(NAS_MARKEN)) if (nas && nas[schluessel]) t = t.split(marke).join(nas[schluessel]);
  return t;
}
export function hatNasMarke(text) { return typeof text === 'string' && Object.keys(NAS_MARKEN).some((m) => text.includes(m)); }
/** Erlaubte oberste Schlüssel eines Compose-Fragments (x-* zusätzlich). */
const OBERSTE_SCHLUESSEL = new Set(['services', 'volumes', 'networks', 'version', 'name']);
/** Bind-Mounts, die jede App lesend bekommen darf (Zeitzone) */
const HARMLOSE_BINDS = new Set(['/etc/localtime', '/etc/timezone']);
const DOCKER_SOCK = new Set(['/var/run/docker.sock', '/run/docker.sock']);
/** cap_add, die VPN-/Netzwerk-Apps regelmäßig brauchen – trotzdem nur mit Bestätigung (§11, C2), aber mit erklärendem Text */
const CAPS_NETZ = new Set(['NET_ADMIN', 'NET_RAW', 'NET_BIND_SERVICE']);
const MAX_COMPOSE = 200_000;
const MAX_WERT = 4096;

// ---------------------------------------------------------------------------------------------------------------
// YAML-Leser (Teilmenge)
// ---------------------------------------------------------------------------------------------------------------
function yamlFehler(text, nr) { return new FahnasFehler('E_PARAMS', `Compose-Vorlage ungültig: ${text}${nr ? ` (Zeile ${nr})` : ''}`, { feld: 'compose', zeile: nr }); }

/** Entfernt einen Kommentar außerhalb von Anführungszeichen. */
function ohneKommentar(z) {
  let q = null;
  for (let i = 0; i < z.length; i++) {
    const c = z[i];
    if (q) { if (c === q && !(q === '"' && z[i - 1] === '\\')) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(z[i - 1]))) return z.slice(0, i).trimEnd();
  }
  return z.trimEnd();
}

function zeilenAufbereiten(text) {
  const aus = [];
  const roh = String(text).replace(/\r\n?/g, '\n').split('\n');
  roh.forEach((r, i) => {
    if (r.includes('\t') && /^\s*\t/.test(r)) throw yamlFehler('Tabulatoren sind in YAML-Einzügen nicht erlaubt', i + 1);
    const inhalt = ohneKommentar(r);
    const einzug = r.length - r.trimStart().length;
    // „...“ am Zeilenanfang = Dokumentende (YAML): beendet jeden Block
    aus.push({ nr: i + 1, roh: r, inhalt: inhalt.trim(), einzug, leer: inhalt.trim() === '', ende: einzug === 0 && inhalt.trim() === '...' });
  });
  return aus;
}

function klammernAusgeglichen(s) {
  let tiefe = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && !(q === '"' && s[i - 1] === '\\')) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') tiefe++;
    else if (c === ']' || c === '}') tiefe--;
  }
  return tiefe <= 0 && q === null;
}

function doppeltZitiert(s, nr) {
  let aus = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { aus += c; continue; }
    const n = s[++i];
    switch (n) {
      case 'n': aus += '\n'; break; case 't': aus += '\t'; break; case 'r': aus += '\r'; break; case '0': aus += '\0'; break;
      case '"': aus += '"'; break; case '\\': aus += '\\'; break; case '/': aus += '/'; break; case ' ': aus += ' '; break;
      case 'x': aus += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': aus += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; break;
      default: throw yamlFehler(`unbekannte Escape-Folge \\${n}`, nr);
    }
  }
  return aus;
}

/** Zerlegt eine Fluss-Liste/-Mapping an Kommas außerhalb von Anführungszeichen/Klammern. */
function flussTeile(s) {
  const teile = []; let akt = ''; let tiefe = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { akt += c; if (c === q && !(q === '"' && s[i - 1] === '\\')) q = null; continue; }
    if (c === '"' || c === "'") { q = c; akt += c; continue; }
    if (c === '[' || c === '{') tiefe++;
    if (c === ']' || c === '}') tiefe--;
    if (c === ',' && tiefe === 0) { teile.push(akt.trim()); akt = ''; continue; }
    akt += c;
  }
  if (akt.trim()) teile.push(akt.trim());
  return teile;
}

/** Trennt „schlüssel: wert“ am ersten „: “ (oder abschließenden „:“) außerhalb von Anführungszeichen. */
function schluesselTrennen(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && !(q === '"' && s[i - 1] === '\\')) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0) q = c; continue; }
    if (c === ':' && (i === s.length - 1 || /\s/.test(s[i + 1]))) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  }
  return null;
}

export function skalarLesen(s, nr) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t[0] === '&' || t[0] === '*' || t[0] === '!') throw yamlFehler('Anker, Aliase und Tags werden nicht unterstützt', nr);
  if (t[0] === '"') { if (t.at(-1) !== '"' || t.length < 2) throw yamlFehler('Anführungszeichen nicht geschlossen', nr); return doppeltZitiert(t, nr); }
  if (t[0] === "'") { if (t.at(-1) !== "'" || t.length < 2) throw yamlFehler('Anführungszeichen nicht geschlossen', nr); return t.slice(1, -1).replace(/''/g, "'"); }
  if (t[0] === '[') {
    if (t.at(-1) !== ']') throw yamlFehler('Fluss-Liste nicht geschlossen', nr);
    const innen = t.slice(1, -1).trim();
    return innen === '' ? [] : flussTeile(innen).map((x) => skalarLesen(x, nr));
  }
  if (t[0] === '{') {
    if (t.at(-1) !== '}') throw yamlFehler('Fluss-Mapping nicht geschlossen', nr);
    const aus = {};
    const innen = t.slice(1, -1).trim();
    if (innen === '') return aus;
    for (const teil of flussTeile(innen)) {
      const kv = schluesselTrennen(teil) || [teil, ''];
      aus[String(skalarLesen(kv[0], nr))] = skalarLesen(kv[1], nr);
    }
    return aus;
  }
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * Liest YAML-Text (Compose-Teilmenge) in ein JavaScript-Objekt. Wirft E_PARAMS bei allem, was der Leser nicht versteht.
 */
export function yamlLesen(text) {
  if (typeof text !== 'string') throw yamlFehler('Text erwartet');
  const zeilen = zeilenAufbereiten(text);
  let i = 0;
  const naechsteNichtLeer = (von) => { let k = von; while (k < zeilen.length && zeilen[k].leer) k++; return k; };
  i = naechsteNichtLeer(0);
  if (i < zeilen.length && /^(---|%YAML)/.test(zeilen[i].inhalt)) i = naechsteNichtLeer(i + 1);
  if (i >= zeilen.length) return null;

  function blockSkalar(kopf, einzug, ab) {
    const falten = kopf[0] === '>';
    const chomp = kopf.includes('-') ? 'strip' : kopf.includes('+') ? 'keep' : 'clip';
    const teile = []; let k = ab; let blockEinzug = null;
    while (k < zeilen.length) {
      const z = zeilen[k];
      if (!z.leer && z.einzug <= einzug) break;
      if (!z.leer && blockEinzug === null) blockEinzug = z.einzug;
      teile.push(z.leer ? '' : z.roh.slice(blockEinzug));
      k++;
    }
    while (teile.length && teile.at(-1) === '') teile.pop();
    let s = falten ? teile.join(' ').replace(/ {2,}/g, ' ') : teile.join('\n');
    if (chomp !== 'strip' && teile.length) s += '\n';
    return { wert: s, weiter: k };
  }

  function wertLesen(rest, einzug, ab, nr) {
    // rest = Text hinter „schlüssel:“ bzw. „- “
    if (rest === '') {
      const n = naechsteNichtLeer(ab);
      if (n < zeilen.length && (zeilen[n].einzug > einzug || (zeilen[n].einzug === einzug && /^-(\s|$)/.test(zeilen[n].inhalt)))) return block(n, zeilen[n].einzug);
      return { wert: null, weiter: ab };
    }
    if (/^[|>][-+]?\d?$/.test(rest)) return blockSkalar(rest, einzug, ab);
    if ((rest[0] === '[' || rest[0] === '{') && !klammernAusgeglichen(rest)) {
      let s = rest; let k = ab;
      while (k < zeilen.length && !klammernAusgeglichen(s)) { s += ' ' + zeilen[k].inhalt; k++; }
      if (!klammernAusgeglichen(s)) throw yamlFehler('Fluss-Sammlung nicht geschlossen', nr);
      return { wert: skalarLesen(s, nr), weiter: k };
    }
    return { wert: skalarLesen(rest, nr), weiter: ab };
  }

  function block(ab, einzug) {
    const erste = zeilen[ab];
    if (/^-(\s|$)/.test(erste.inhalt)) return sequenz(ab, einzug);
    return mapping(ab, einzug);
  }

  function sequenz(ab, einzug) {
    const aus = []; let k = ab;
    while (k < zeilen.length) {
      const z = zeilen[k];
      if (z.leer) { k++; continue; }
      if (z.ende || z.einzug < einzug) break;
      if (z.einzug > einzug) throw yamlFehler('unerwarteter Einzug', z.nr);
      if (!/^-(\s|$)/.test(z.inhalt)) break;
      const rest = z.inhalt.slice(1).trimStart();
      const spalte = z.einzug + 1 + (z.inhalt.length - 1 - z.inhalt.slice(1).trimStart().length);
      const kv = rest && rest[0] !== '"' && rest[0] !== "'" && rest[0] !== '[' && rest[0] !== '{' ? schluesselTrennen(rest) : null;
      if (kv) {
        // „- schlüssel: wert“ → Mapping, dessen weitere Einträge in Spalte `spalte` stehen
        zeilen[k] = { ...z, inhalt: rest, einzug: spalte };
        const r = mapping(k, spalte);
        aus.push(r.wert); k = r.weiter;
      } else {
        const r = wertLesen(rest, einzug, k + 1, z.nr);
        aus.push(r.wert); k = r.weiter;
      }
    }
    return { wert: aus, weiter: k };
  }

  function mapping(ab, einzug) {
    const aus = {}; let k = ab;
    while (k < zeilen.length) {
      const z = zeilen[k];
      if (z.leer) { k++; continue; }
      if (z.ende || z.einzug < einzug) break;
      if (z.einzug > einzug) throw yamlFehler('unerwarteter Einzug', z.nr);
      if (/^-(\s|$)/.test(z.inhalt)) break;
      const kv = schluesselTrennen(z.inhalt);
      if (!kv) throw yamlFehler(`„${z.inhalt.slice(0, 40)}“ ist kein Schlüssel-Wert-Paar`, z.nr);
      const schluessel = String(skalarLesen(kv[0], z.nr));
      if (schluessel in aus) throw yamlFehler(`Schlüssel „${schluessel}“ doppelt`, z.nr);
      const r = wertLesen(kv[1], einzug, k + 1, z.nr);
      aus[schluessel] = r.wert; k = r.weiter;
    }
    return { wert: aus, weiter: k };
  }

  const r = block(i, zeilen[i].einzug);
  const rest = naechsteNichtLeer(r.weiter);
  if (rest < zeilen.length && zeilen[rest].inhalt !== '...') throw yamlFehler('unerwarteter Text nach dem Dokument', zeilen[rest].nr);
  return r.wert;
}

// ---------------------------------------------------------------------------------------------------------------
// Vorlage prüfen und normieren
// ---------------------------------------------------------------------------------------------------------------
function fehler(text, feld, extra) { return new FahnasFehler('E_PARAMS', text, { feld, ...(extra || {}) }); }
function textOderLeer(w, max = 2000) { return typeof w === 'string' ? w.slice(0, max) : ''; }

/** Normiert eine Felddefinition (wirft E_PARAMS). */
export function feldNormieren(f, i = 0) {
  if (!f || typeof f !== 'object') throw fehler(`Feld ${i + 1} ist kein Objekt`, 'felder');
  const name = String(f.name || '').toUpperCase();
  if (!NAME_FELD.test(name)) throw fehler(`Feldname „${f.name}“ ungültig (A–Z, 0–9, _; beginnt mit Buchstabe)`, 'felder', { wert: f.name });
  const art = FELDARTEN.includes(f.art) ? f.art : null;
  if (!art) throw fehler(`Feld ${name}: unbekannte Feldart „${f.art}“`, 'felder', { wert: f.art });
  const aus = {
    name, art, beschriftung: textOderLeer(f.beschriftung, 200) || name, erklaerung: textOderLeer(f.erklaerung, 2000),
    pflicht: f.pflicht === undefined ? (art === 'port' || art === 'pfad' || art === 'auswahl' || art === 'schalter') : !!f.pflicht,
  };
  if (f.standard !== undefined && f.standard !== null) aus.standard = f.standard;
  if (art === 'port') {
    if (f.container !== undefined) aus.container = Number(f.container);
    aus.protokoll = PORT_PROTOKOLLE.includes(f.protokoll) ? f.protokoll : 'tcp';
    // Host-Netz: Feld mit der Lauschadresse des Dienstes (z. B. DNS_ADRESSE) – für die Konfliktprüfung je Adresse
    if (f.adresse_feld !== undefined) {
      const a = String(f.adresse_feld || '').toUpperCase();
      if (!NAME_FELD.test(a)) throw fehler(`Feld ${name}: adresse_feld „${f.adresse_feld}“ ungültig`, 'felder', { wert: f.adresse_feld });
      aus.adresse_feld = a;
    }
  }
  if (art === 'pfad') { aus.nur_lesen = !!f.nur_lesen; if (f.container !== undefined) aus.container = String(f.container); }
  if (art === 'auswahl') {
    if (!Array.isArray(f.werte) || !f.werte.length) throw fehler(`Feld ${name}: Auswahl ohne „werte“`, 'felder');
    aus.werte = f.werte.map((w) => String(w));
    if (aus.standard === undefined) aus.standard = aus.werte[0];
  }
  if (art === 'schalter') { aus.an = f.an === undefined ? 'true' : String(f.an); aus.aus = f.aus === undefined ? 'false' : String(f.aus); if (aus.standard === undefined) aus.standard = false; }
  if (f.gruppe) aus.gruppe = textOderLeer(f.gruppe, 60);
  if (f.erweitert) aus.erweitert = true;
  return aus;
}

/** Protokolle eines Port-Felds: „tcp“, „udp“ oder beide („tcp+udp“, z. B. DNS im Host-Netz). */
export function feldProtokolle(f) {
  return f && f.protokoll === 'tcp+udp' ? ['tcp', 'udp'] : [f && f.protokoll === 'udp' ? 'udp' : 'tcp'];
}

/** Findet alle ${NAME}-Platzhalter im Text. */
export function platzhalter(text) {
  const aus = new Set();
  // „$$“ ist für compose ein maskiertes Dollarzeichen – kein Platzhalter
  for (const m of String(text).matchAll(/\$\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) { if (m[0] === '$$') continue; aus.add(m[1] !== undefined ? m[1] : m[2]); }
  return [...aus];
}

/**
 * Prüft und normiert eine Katalog-Vorlage: id, name, beschreibung, kategorie, symbol, quelle, webui, compose (Text,
 * nur services/volumes/networks/x-*), felder (jeder ${PLATZHALTER} im Compose muss ein Feld sein).
 */
export function vorlagePruefen(v, { quelle } = {}) {
  if (!v || typeof v !== 'object') throw fehler('Vorlage ist kein Objekt', 'vorlage');
  const id = String(v.id || '').toLowerCase();
  if (!ID_KATALOG.test(id)) throw fehler(`Vorlagen-Kennung „${v.id}“ ungültig`, 'id');
  const name = textOderLeer(v.name, 100).trim();
  if (!name) throw fehler('Vorlage ohne Namen', 'name');
  if (typeof v.compose !== 'string' || !v.compose.trim()) throw fehler('Vorlage ohne Compose-Fragment', 'compose');
  if (v.compose.length > MAX_COMPOSE) throw fehler('Compose-Fragment zu groß', 'compose');
  const doc = yamlLesen(v.compose);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fehler('Compose-Fragment muss ein Mapping sein', 'compose');
  for (const k of Object.keys(doc)) if (!OBERSTE_SCHLUESSEL.has(k) && !k.startsWith('x-')) throw fehler(`Compose-Fragment: oberster Schlüssel „${k}“ ist nicht erlaubt (nur services, volumes, networks)`, 'compose', { wert: k });
  if (!doc.services || typeof doc.services !== 'object' || Array.isArray(doc.services) || !Object.keys(doc.services).length) throw fehler('Compose-Fragment ohne services', 'compose');
  for (const [dn, d] of Object.entries(doc.services)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(dn)) throw fehler(`Dienstname „${dn}“ ungültig`, 'compose', { wert: dn });
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw fehler(`Dienst „${dn}“ ist kein Mapping`, 'compose');
    if (typeof d.image !== 'string' || !d.image.trim()) throw fehler(`Dienst „${dn}“ ohne image (build wird nicht unterstützt)`, 'compose', { wert: dn });
    if (d.build !== undefined) throw fehler(`Dienst „${dn}“: build wird nicht unterstützt`, 'compose', { wert: dn });
  }
  const felder = (Array.isArray(v.felder) ? v.felder : []).map(feldNormieren);
  const namen = new Set();
  for (const f of felder) { if (namen.has(f.name)) throw fehler(`Feld ${f.name} doppelt`, 'felder', { wert: f.name }); namen.add(f.name); }
  for (const f of felder) {
    if (f.adresse_feld && !felder.some((x) => x.name === f.adresse_feld && x.art === 'variable')) throw fehler(`Feld ${f.name}: adresse_feld ${f.adresse_feld} ist kein Text-Feld der Vorlage`, 'felder', { wert: f.adresse_feld });
  }
  for (const p of platzhalter(v.compose)) {
    if (!NAME_FELD.test(p) || !namen.has(p)) throw fehler(`Compose-Fragment verwendet den Platzhalter \${${p}}, der kein Feld der Vorlage ist`, 'compose', { wert: p });
  }
  const q = QUELLEN.includes(quelle) ? quelle : (QUELLEN.includes(v.quelle) ? v.quelle : 'eigen');
  const symbol = typeof v.symbol === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v.symbol) ? v.symbol.slice(0, 500) : '';
  const aus = {
    id, name, beschreibung: textOderLeer(v.beschreibung, 4000), kategorie: textOderLeer(v.kategorie, 60) || 'Sonstiges', symbol, quelle: q,
    webui: typeof v.webui === 'string' && /^https?:\/\//i.test(v.webui) ? v.webui.slice(0, 500) : '', compose: v.compose, felder,
  };
  if (v.herkunft && typeof v.herkunft === 'object') aus.herkunft = v.herkunft;
  if (Array.isArray(v.hinweise)) aus.hinweise = v.hinweise.map((h) => String(h).slice(0, 500)).slice(0, 50);
  if (typeof v.version === 'string') aus.version = v.version.slice(0, 40);
  // Zusätzliche Schlüssel des eingebauten Katalogs (§11, C2): Dokumentation, Risikotexte, „nur lokal baubar“
  aus.dokumentation = typeof v.dokumentation === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v.dokumentation) ? v.dokumentation.slice(0, 500) : null;
  if (Array.isArray(v.risiko)) aus.risiko = v.risiko.map((r) => String(r).slice(0, 500)).slice(0, 20);
  aus.verfuegbar = v.verfuegbar !== false;
  // eigene FAH-Apps (Betreiber 12.10.2026): nur noch für schon installierte Apps – neu nur per ZIP; nur eingebaute Vorlagen
  if (v.nur_bestand === true && q === 'eingebaut') aus.nur_bestand = true;
  // Feste Ports von Diensten im Host-Netz (Home Assistant 8123 …) – die Firewall gibt sie frei (hostPorts)
  if (v.host_ports !== undefined) {
    if (!Array.isArray(v.host_ports) || v.host_ports.length > 50) throw fehler('host_ports muss eine Liste sein (max. 50)', 'host_ports');
    aus.host_ports = v.host_ports.map((h, i) => {
      const port = Number(h && h.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fehler(`host_ports[${i}]: Port ungültig`, 'host_ports', { wert: h && h.port });
      const protokoll = h.protokoll === undefined ? 'tcp' : h.protokoll;
      if (!PORT_PROTOKOLLE.includes(protokoll)) throw fehler(`host_ports[${i}]: Protokoll „${h.protokoll}“ ungültig (tcp, udp, tcp+udp)`, 'host_ports', { wert: h.protokoll });
      return { port, protokoll, beschreibung: textOderLeer(h.beschreibung, 200) };
    });
  }
  // Nur eingebaute Vorlagen dürfen aus dem mitgelieferten Quellcode bauen (<programm>/katalog/quellen/<id>/)
  if (v.bauen !== undefined && v.bauen !== null) {
    if (q !== 'eingebaut') throw fehler('Nur eingebaute Vorlagen können aus dem Quellcode gebaut werden', 'bauen');
    const b = v.bauen;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw fehler('bauen muss ein Objekt sein', 'bauen');
    const dienste = Object.keys(doc.services);
    const dienst = b.dienst === undefined ? dienste[0] : String(b.dienst);
    if (!dienste.includes(dienst)) throw fehler(`bauen.dienst „${b.dienst}“ ist kein Dienst der Vorlage`, 'bauen', { wert: b.dienst });
    const image = String(doc.services[dienst].image);
    if (image.includes('${') || image.includes('/') || !/^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/.test(image)) throw fehler(`bauen: Image „${image}“ muss ein lokaler Name mit Tag sein (ohne Registry, ohne Platzhalter)`, 'bauen', { wert: image });
    if (b.release_zip !== undefined && !/^[A-Za-z0-9._-]+\.zip$/.test(String(b.release_zip))) throw fehler('bauen.release_zip muss ein ZIP-Dateiname sein', 'bauen', { wert: b.release_zip });
    aus.bauen = { dienst, image, ...(b.release_zip ? { release_zip: String(b.release_zip) } : {}) };
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Werte prüfen
// ---------------------------------------------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

function portPruefen(w, f) {
  const n = typeof w === 'string' && /^\d+$/.test(w.trim()) ? Number(w.trim()) : w;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fehler(`${f.beschriftung}: Port muss zwischen 1 und 65535 liegen`, f.name, { wert: w });
  return n;
}

/**
 * Prüft einen Pfad-Wert: relativ (unter <apps>/<name>/) oder absolut unterhalb der Freigaben. Gibt den absoluten
 * Host-Pfad zurück. Kein „..“, keine Steuerzeichen, kein Doppelpunkt/Anführungszeichen (Volume-Syntax).
 */
/**
 * Freigabe-Pfade wie im Dateimanager deuten (Betreiber 12.10.2026: kopierter Pfad „private/fah-downloader“ scheiterte):
 * „private/x“, „/private/x“, „\\\\fahnas\\private\\x“, „//fahnas/private/x“ und „smb://fahnas/private/x“ zeigen auf
 * <shares>/private/x, sobald der erste Teil eine Freigabe ist. Alles andere bleibt, wie es ist.
 */
export function pfadDeuten(eingabe, { appOrdner, shares, freigaben = [] } = {}) {
  let s = String(eingabe || '').trim();
  const unc = /^(?:smb:\/\/|\\\\|\/\/)[^\\/]+[\\/](.+)$/i.exec(s);
  if (unc) s = unc[1].replace(/\\/g, '/');
  const wurzel = String(shares || '').replace(/\/+$/, '');
  const unter = (w) => !!w && (s === w || s.startsWith(`${w.replace(/\/+$/, '')}/`));
  if (s.startsWith('/') && (unter(appOrdner) || unter(wurzel))) return s;
  const teile = s.split('/').filter(Boolean);
  if (teile.length && freigaben.includes(teile[0]) && wurzel) return `${wurzel}/${teile.join('/')}`;
  return unc ? s : String(eingabe || '').trim();
}

export function pfadPruefen(w, f, { appOrdner, shares, freigaben = [] }) {
  if (typeof w !== 'string') throw fehler(`${f.beschriftung}: Pfad fehlt`, f.name);
  const s = pfadDeuten(w, { appOrdner, shares, freigaben });
  if (!s) throw fehler(`${f.beschriftung}: Pfad fehlt`, f.name);
  if (STEUERZEICHEN.test(s) || /[:"'$\\]/.test(s) || s.length > 1024) throw fehler(`${f.beschriftung}: Pfad enthält unerlaubte Zeichen (kein :, ", ', $ oder \\)`, f.name, { wert: s });
  if (s.split('/').some((t) => t === '..')) throw fehler(`${f.beschriftung}: „..“ ist im Pfad nicht erlaubt`, f.name, { wert: s });
  const abs = path.posix.normalize(s.startsWith('/') ? s : path.posix.join(appOrdner, s));
  const unter = (wurzel) => abs === wurzel || abs.startsWith(wurzel.replace(/\/+$/, '') + '/');
  if (!unter(appOrdner) && !unter(shares)) throw fehler(`${f.beschriftung}: Pfad muss im App-Ordner (${appOrdner}) oder in einer Freigabe liegen – z. B. ${shares.replace(/\/+$/, '')}/${freigaben[0] || 'private'}/ordner oder kurz ${freigaben[0] || 'private'}/ordner`, f.name, { wert: s });
  if (unter(shares) && abs === shares.replace(/\/+$/, '')) throw fehler(`${f.beschriftung}: bitte eine Freigabe wählen, nicht den Ordner aller Freigaben`, f.name, { wert: s });
  return abs;
}

function textPruefen(w, f) {
  if (typeof w === 'number' || typeof w === 'boolean') w = String(w);
  if (typeof w !== 'string') throw fehler(`${f.beschriftung}: Text erwartet`, f.name);
  if (w.length > MAX_WERT) throw fehler(`${f.beschriftung}: zu lang (max. ${MAX_WERT} Zeichen)`, f.name);
  if (STEUERZEICHEN.test(w)) throw fehler(`${f.beschriftung}: Steuerzeichen/Zeilenumbrüche sind nicht erlaubt`, f.name);
  if (w.includes("'")) throw fehler(`${f.beschriftung}: ein einfaches Anführungszeichen (') ist nicht erlaubt`, f.name);
  return w;
}

/**
 * Prüft alle Werte gegen die Felder der Vorlage (Standardwerte füllen Lücken, Pflichtfelder müssen belegt sein).
 * @returns {{werte:object, geheimnisse:object, hostPfade:object}} werte = alle Nicht-Geheimnisse (Pfade absolut),
 *   geheimnisse = Name→Wert, hostPfade = Feldname→absoluter Pfad
 */
export function wertePruefen(vorlage, werte, { appOrdner, shares, nas, freigaben = [] }) {
  if (werte && (typeof werte !== 'object' || Array.isArray(werte))) throw fehler('werte muss ein Objekt sein', 'werte');
  const rein = werte || {};
  const bekannt = new Set(vorlage.felder.map((f) => f.name));
  for (const k of Object.keys(rein)) if (!bekannt.has(k)) throw fehler(`Unbekanntes Feld „${k}“`, 'werte', { wert: k });
  const aus = { werte: {}, geheimnisse: {}, hostPfade: {} };
  for (const f of vorlage.felder) {
    let w = rein[f.name];
    if (w === undefined || w === null || w === '') w = f.standard;
    if (w === undefined || w === null || w === '') {
      if (f.pflicht) throw fehler(`${f.beschriftung} fehlt`, f.name);
      if (f.art === 'geheimnis') aus.geheimnisse[f.name] = ''; else aus.werte[f.name] = '';
      continue;
    }
    switch (f.art) {
      case 'port': aus.werte[f.name] = portPruefen(w, f); break;
      case 'pfad': { const abs = pfadPruefen(String(w), f, { appOrdner, shares, freigaben }); aus.werte[f.name] = abs; aus.hostPfade[f.name] = abs; break; }
      case 'auswahl': if (!f.werte.includes(String(w))) throw fehler(`${f.beschriftung}: „${w}“ ist keine gültige Auswahl`, f.name, { wert: w }); aus.werte[f.name] = String(w); break;
      case 'schalter': {
        const an = w === true || w === 'true' || w === '1' || w === f.an;
        if (!an && !(w === false || w === 'false' || w === '0' || w === f.aus)) throw fehler(`${f.beschriftung}: an oder aus erwartet`, f.name, { wert: w });
        aus.werte[f.name] = an ? f.an : f.aus; break;
      }
      case 'geheimnis': aus.geheimnisse[f.name] = textPruefen(w, f); break;
      default: {
        const t = nasMarkenEinsetzen(textPruefen(w, f), nas);
        if (hatNasMarke(t)) throw fehler(`${f.beschriftung}: die Netzadresse des NAS ist nicht bekannt – bitte selbst eintragen`, f.name, { wert: t });
        aus.werte[f.name] = t;
      }
    }
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Einsetzen (nur für die Prüfung), .env, Ports, Risiken
// ---------------------------------------------------------------------------------------------------------------
/** Setzt ${FELD} durch Werte ein (nur für die Analyse; für Geheimnisse optional eine Maske). */
export function einsetzen(text, werte, { maske } = {}) {
  return String(text).replace(/\$\$|\$\{([A-Z][A-Z0-9_]*)\}/g, (ganz, n) => {
    if (ganz === '$$' || !(n in werte)) return ganz;
    return maske && maske.has(n) ? '********' : String(werte[n]);
  });
}

/** .env-Text: jede Zeile NAME='wert' (einfach zitiert = keine Interpolation durch compose; ' ist im Wert verboten). */
export function envText(werte) {
  const zeilen = ['# Erzeugt von FAH-NAS – Werte der App-Felder. Nicht von Hand ändern (Einstellungen in der Oberfläche).'];
  for (const [k, v] of Object.entries(werte).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const s = String(v ?? '');
    if (s.includes("'") || /[\r\n]/.test(s)) throw fehler(`Wert von ${k} enthält unerlaubte Zeichen`, k);
    zeilen.push(`${k}='${s}'`);
  }
  return zeilen.join('\n') + '\n';
}

function wahr(w) { return w === true || /^(true|yes|on|1)$/i.test(String(w)); }

/** Host-Ports aus einem Dienst („8080:80“, „127.0.0.1:8080:80/udp“, „8080-8081:80-81“, lange Form {published, target, protocol}). */
export function portsVonDienst(d) {
  const aus = [];
  const ports = Array.isArray(d.ports) ? d.ports : [];
  for (const p of ports) {
    if (p && typeof p === 'object') {
      const pub = p.published !== undefined ? String(p.published) : null;
      if (pub === null) continue;
      for (const n of bereich(pub)) aus.push({ port: n, protokoll: p.protocol === 'udp' ? 'udp' : 'tcp', ziel: p.target !== undefined ? Number(p.target) : null });
      continue;
    }
    const s = String(p).trim();
    const m = /^(?:(.*):)?([0-9]+(?:-[0-9]+)?):([0-9]+(?:-[0-9]+)?)(?:\/(tcp|udp))?$/.exec(s) || /^([0-9]+(?:-[0-9]+)?)(?:\/(tcp|udp))?$/.exec(s) && null;
    if (!m) {
      // nur Containerport („80“) → Docker wählt einen zufälligen Host-Port; unerlaubt (Firewall nicht planbar)
      throw fehler(`Port-Angabe „${s}“ ist nicht erlaubt – bitte Host-Port:Container-Port angeben`, 'compose', { wert: s });
    }
    const hostTeil = m[2]; const proto = m[4] === 'udp' ? 'udp' : 'tcp';
    const ziele = bereich(m[3]);
    bereich(hostTeil).forEach((n, i) => aus.push({ port: n, protokoll: proto, ziel: ziele[i] ?? ziele[0] ?? null }));
  }
  return aus;
}

function bereich(s) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(s).trim());
  if (!m) throw fehler(`Port „${s}“ ungültig`, 'compose', { wert: s });
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b > 65535 || b < a || b - a > 1000) throw fehler(`Portbereich „${s}“ ungültig`, 'compose', { wert: s });
  const aus = []; for (let n = a; n <= b; n++) aus.push(n);
  return aus;
}

/** Host-Seite eines volumes-Eintrags (kurze oder lange Form); null bei benannten Volumes/tmpfs. */
function bindQuelle(v) {
  if (v && typeof v === 'object') {
    if (v.type && v.type !== 'bind') return null;
    const q = v.source !== undefined ? String(v.source) : null;
    return q && (q.startsWith('/') || q.startsWith('.') || q.startsWith('~')) ? { quelle: q, nurLesen: !!v.read_only } : null;
  }
  const s = String(v);
  if (!(s.startsWith('/') || s.startsWith('.') || s.startsWith('~'))) return null; // benanntes Volume
  const teile = s.split(':');
  return { quelle: teile[0], nurLesen: /(^|,)ro(,|$)/.test(teile[2] || '') };
}

/**
 * Analysiert ein (mit Werten eingesetztes) Compose-Dokument: Dienste, Ports, Bind-Mounts, Risiken, Warnungen.
 * @param {object} doc  geparstes Compose
 * @param {{appOrdner:string, shares:string}} wurzeln
 */
export function analysieren(doc, { appOrdner, shares }) {
  const aus = { dienste: [], ports: [], binds: [], risiken: [], warnungen: [], benannteVolumes: !!(doc.volumes && Object.keys(doc.volumes).length) };
  const unter = (p, wurzel) => p === wurzel || p.startsWith(wurzel.replace(/\/+$/, '') + '/');
  // `kennung` = `art` (die Oberfläche schickt sie 1:1 in bestaetigt_riskant zurück, §11 B2)
  const risiko = (art, dienst, wert, text) => { if (!aus.risiken.some((r) => r.art === art && r.dienst === dienst && r.wert === wert)) aus.risiken.push({ art, kennung: art, dienst, wert: wert === undefined ? null : String(wert), text }); };
  const gesehen = new Set();
  for (const [dn, d] of Object.entries(doc.services || {})) {
    aus.dienste.push({ name: dn, image: String(d.image || '') });
    if (wahr(d.privileged)) risiko('privileged', dn, true, `Dienst „${dn}“ läuft privilegiert (voller Zugriff auf das System)`);
    if (d.network_mode === 'host') risiko('network_host', dn, 'host', `Dienst „${dn}“ nutzt das Netzwerk des NAS direkt (network_mode: host) – keine Port-Trennung zum NAS; die Firewall gibt nur die Ports aus den Einstellungen der Vorlage frei`);
    else if (typeof d.network_mode === 'string' && !/^(bridge|none|service:|container:)/.test(d.network_mode)) aus.warnungen.push(`Dienst „${dn}“: network_mode „${d.network_mode}“ – Netzwerk muss vorhanden sein`);
    if (d.pid === 'host') risiko('pid_host', dn, 'host', `Dienst „${dn}“ sieht alle Prozesse des NAS (pid: host)`);
    if (d.ipc === 'host') risiko('ipc_host', dn, 'host', `Dienst „${dn}“ teilt den IPC-Namensraum mit dem NAS (ipc: host)`);
    if (d.userns_mode === 'host') risiko('userns_host', dn, 'host', `Dienst „${dn}“ nutzt den Nutzer-Namensraum des NAS`);
    for (const c of Array.isArray(d.cap_add) ? d.cap_add : []) {
      const cap = String(c).toUpperCase().replace(/^CAP_/, '');
      risiko('cap_add', dn, cap, `Dienst „${dn}“ erhält die erweiterte Berechtigung ${cap}${CAPS_NETZ.has(cap) ? ' (üblich für VPN- und Netzwerk-Apps)' : ''}`);
    }
    for (const s of Array.isArray(d.security_opt) ? d.security_opt : []) {
      if (/unconfined|no-new-privileges:false/i.test(String(s))) risiko('security_opt', dn, String(s), `Dienst „${dn}“ schaltet einen Schutz ab (${s})`);
    }
    for (const dev of Array.isArray(d.devices) ? d.devices : []) {
      const q = typeof dev === 'object' ? String(dev.source || dev.path || '') : String(dev).split(':')[0];
      risiko('devices', dn, q, `Dienst „${dn}“ bekommt das Gerät ${q} des NAS`);
    }
    if (d.sysctls) aus.warnungen.push(`Dienst „${dn}“ setzt Kernel-Parameter (sysctls) im Container`);
    if (d.volumes !== undefined && !Array.isArray(d.volumes)) throw fehler(`Dienst „${dn}“: volumes muss eine Liste sein`, 'compose');
    for (const v of d.volumes || []) {
      const b = bindQuelle(v);
      if (!b) continue;
      const q = path.posix.normalize(b.quelle);
      if (DOCKER_SOCK.has(q)) { risiko('docker_sock', dn, q, `Dienst „${dn}“ erhält Zugriff auf den Docker-Dienst (${q}) – das entspricht Vollzugriff auf das NAS`); aus.binds.push({ dienst: dn, quelle: q, nurLesen: b.nurLesen, art: 'docker_sock' }); continue; }
      if (HARMLOSE_BINDS.has(q)) { aus.binds.push({ dienst: dn, quelle: q, nurLesen: true, art: 'zeit' }); continue; }
      if (q.startsWith('/dev/')) { risiko('devices', dn, q, `Dienst „${dn}“ bekommt das Gerät ${q} des NAS`); aus.binds.push({ dienst: dn, quelle: q, nurLesen: b.nurLesen, art: 'geraet' }); continue; }
      if (!q.startsWith('/')) throw fehler(`Dienst „${dn}“: relativer Bind-Mount „${b.quelle}“ – bitte ein Pfad-Feld verwenden`, 'compose', { wert: b.quelle });
      if (q.split('/').some((t) => t === '..')) throw fehler(`Dienst „${dn}“: „..“ im Bind-Mount ${b.quelle}`, 'compose', { wert: b.quelle });
      if (unter(q, appOrdner)) { aus.binds.push({ dienst: dn, quelle: q, nurLesen: b.nurLesen, art: 'app' }); continue; }
      if (unter(q, shares) && q !== shares.replace(/\/+$/, '')) { aus.binds.push({ dienst: dn, quelle: q, nurLesen: b.nurLesen, art: 'freigabe' }); continue; }
      throw fehler(`Dienst „${dn}“: Bind-Mount „${q}“ liegt außerhalb der erlaubten Wurzeln (${appOrdner}, ${shares})`, 'compose', { wert: q });
    }
    if (d.network_mode === 'host') {
      if (Array.isArray(d.ports) && d.ports.length) aus.warnungen.push(`Dienst „${dn}“: ports werden im Netzwerkmodus host nicht veröffentlicht`);
      continue;
    }
    for (const p of portsVonDienst(d)) {
      const k = `${p.port}/${p.protokoll}`;
      if (gesehen.has(k)) throw fehler(`Host-Port ${k} wird in der App doppelt vergeben`, 'compose', { wert: k });
      gesehen.add(k);
      aus.ports.push({ ...p, dienst: dn });
    }
    if (d.restart === undefined) aus.warnungen.push(`Dienst „${dn}“ ohne restart-Regel – wird nach einem Neustart des NAS nicht automatisch gestartet (Autostart der App übernimmt das)`);
  }
  return aus;
}

/**
 * Rendert eine Vorlage mit Werten: prüft Werte, setzt sie in eine Kopie ein, analysiert Ports/Risiken/Pfade und
 * liefert die Dateien (compose.yml mit Platzhaltern, .env mit allen Werten).
 * @returns {{compose:string, env:string, vorschau:string, werte:object, geheimnisse:object, hostPfade:object, ports:Array,
 *   risiken:Array, warnungen:string[], dienste:Array, binds:Array, benannteVolumes:boolean, webui:string}}
 */
export function rendern(vorlage, werte, { appOrdner, shares, host, nas, freigaben = [] }) {
  const g = wertePruefen(vorlage, werte, { appOrdner, shares, nas, freigaben });
  const alle = { ...g.werte, ...g.geheimnisse };
  const eingesetzt = einsetzen(vorlage.compose, alle);
  const doc = yamlLesen(eingesetzt);
  const a = analysieren(doc, { appOrdner, shares });
  // Ports, die aus einem Feld stammen, tragen den Feldnamen (für Konfliktmeldungen mit Feldbezug)
  for (const p of a.ports) {
    const feld = vorlage.felder.find((f) => f.art === 'port' && g.werte[f.name] === p.port && feldProtokolle(f).includes(p.protokoll));
    if (feld) p.feld = feld.name;
  }
  for (const p of hostPorts(vorlage, g.werte)) {
    if (a.ports.some((x) => x.port === p.port && x.protokoll === p.protokoll)) throw fehler(`Host-Port ${p.port}/${p.protokoll} wird in der App doppelt vergeben`, 'compose', { wert: `${p.port}/${p.protokoll}` });
    a.ports.push(p);
  }
  const maske = new Set(Object.keys(g.geheimnisse));
  return {
    compose: vorlage.compose, env: envText(alle), vorschau: einsetzen(vorlage.compose, alle, { maske }),
    werte: g.werte, geheimnisse: g.geheimnisse, hostPfade: g.hostPfade,
    ports: a.ports, risiken: a.risiken, warnungen: a.warnungen, dienste: a.dienste, binds: a.binds, benannteVolumes: a.benannteVolumes,
    webui: webuiRendern(vorlage.webui, g.werte, host),
  };
}

/** WebUI-Adresse: {FELD} durch Werte ersetzen, {HOST} durch den Host (oder als Platzhalter für den Browser lassen). */
/**
 * Ports von Diensten im Host-Netz (network_mode: host). Docker veröffentlicht dort nichts – die App lauscht direkt auf
 * dem NAS, und die Firewall (policy drop) ließ ohne Eintrag niemanden durch (Home Assistant 25.09.: 8123 lief ins Leere).
 * Quellen: Port-Felder, deren Platzhalter im Host-Dienst stehen (mit Lauschadresse aus `adresse_feld`), `host_ports`
 * der Vorlage und ein fester Port in der webui-Adresse (http://{HOST}:8123).
 * @returns {Array<{port:number, protokoll:string, dienst:string, feld:string|null, ziel:null, host:true, adresse?:string}>}
 */
export function hostPorts(vorlage, werte) {
  let doc = null;
  try { doc = yamlLesen(vorlage.compose); } catch { return []; }
  const dienste = Object.entries((doc && doc.services) || {}).filter(([, d]) => d && typeof d === 'object' && d.network_mode === 'host');
  if (!dienste.length) return [];
  const aus = []; const gesehen = new Set();
  const dazu = (port, protokoll, dienst, feld, adresse) => {
    const n = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
    if (!Number.isInteger(n) || n < 1 || n > 65535) return;
    for (const pr of feldProtokolle({ protokoll })) {
      const k = `${n}/${pr}`;
      if (gesehen.has(k)) continue;
      gesehen.add(k);
      aus.push({ port: n, protokoll: pr, dienst, feld: feld || null, ziel: null, host: true, ...(adresse ? { adresse } : {}) });
    }
  };
  // Port-Felder: im Host-Dienst verwendet – oder nur zur Anzeige (Unraid-Übersetzer: Platzhalter nicht im Compose, nur in
  // webui bzw. bei reinen Host-Netz-Vorlagen gar nicht), dann dem ersten Host-Dienst zugeordnet. Felder, die ein Dienst im
  // Brückennetz benutzt, veröffentlicht Docker selbst (ports:) – die bleiben hier außen vor.
  const inBruecke = new Set(Object.entries(doc.services).filter(([, d]) => !(d && d.network_mode === 'host')).flatMap(([, d]) => platzhalter(JSON.stringify(d))));
  // Port-Felder, die irgendwo ausdrücklich nur an Loopback gebunden sind („127.0.0.1:${P}:9000“, host_ip 127.x/::1), sind als
  // nur lokal gemeint – die Firewall darf sie nie für das Netz öffnen (Prüfung 0.2.3)
  const nurLokal = new Set();
  for (const d of Object.values(doc.services)) {
    for (const e of (d && Array.isArray(d.ports) ? d.ports : [])) {
      const lokal = typeof e === 'string' ? /^\s*\[?(127\.[\d.]+|::1|localhost)\]?:/.test(e) : !!(e && typeof e === 'object' && /^\[?(127\.[\d.]+|::1|localhost)\]?$/.test(String(e.host_ip || '')));
      if (lokal) for (const n of platzhalter(JSON.stringify(e))) nurLokal.add(n);
    }
  }
  const inWebui = new Set([...String(vorlage.webui || '').matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]));
  const nurHost = dienste.length === Object.keys(doc.services).length;
  const hostNamen = dienste.map(([dn, d]) => [dn, new Set(platzhalter(JSON.stringify(d)))]);
  for (const f of vorlage.felder || []) {
    if (f.art !== 'port' || nurLokal.has(f.name)) continue;
    const treffer = hostNamen.find(([, namen]) => namen.has(f.name));
    const dn = treffer ? treffer[0] : (!inBruecke.has(f.name) && (inWebui.has(f.name) || nurHost) ? dienste[0][0] : null);
    if (dn) dazu(werte[f.name], f.protokoll, dn, f.name, f.adresse_feld ? String(werte[f.adresse_feld] || '').trim() : '');
  }
  for (const h of vorlage.host_ports || []) dazu(h.port, h.protokoll, dienste[0][0], null, '');
  const m = /^https?:\/\/\{HOST\}:(\d+)(?:[/?#]|$)/i.exec(vorlage.webui || '');
  if (m) dazu(Number(m[1]), 'tcp', dienste[0][0], null, '');
  return aus;
}

export function webuiRendern(webui, werte, host) {
  if (!webui) return '';
  return String(webui).replace(/\{([A-Z][A-Z0-9_]*)\}/g, (ganz, n) => (n === 'HOST' ? (host || ganz) : (n in werte ? String(werte[n]) : ganz)));
}

/** Prüft die Bestätigungen: jede Risiko-Art muss in `bestaetigt` stehen; sonst E_RECHTE mit der Liste. */
export function risikenBestaetigt(risiken, bestaetigt) {
  const b = new Set(Array.isArray(bestaetigt) ? bestaetigt.map(String) : []);
  const offen = risiken.filter((r) => !b.has(r.art));
  if (offen.length) {
    throw new FahnasFehler('E_RECHTE', `Diese App verlangt besondere Rechte, die du erst bestätigen musst: ${[...new Set(offen.map((r) => r.art))].join(', ')}`, { feld: 'bestaetigt_riskant', riskant: offen, noetig: [...new Set(offen.map((r) => r.art))] });
  }
  return [...new Set(risiken.map((r) => r.art))];
}
