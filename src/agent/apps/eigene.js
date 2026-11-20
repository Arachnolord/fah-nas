// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigene App aus einer Compose-Datei: wandelt eine übliche docker-compose.yml in eine FAH-NAS-Vorlage um.
// Host-Ports und Host-Pfade werden zu Formularfeldern (Port-Konflikte, Pfadprüfung und Risiko-Bestätigung greifen
// damit wie bei Katalog-Apps), ${VARIABLEN} aus der Datei werden zu Variablenfeldern. Nicht unterstützt: build,
// env_file, configs/secrets – dafür gibt es eine klare Meldung.

import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { yamlLesen, vorlagePruefen } from './compose.js';
import { slug } from './unraid.js';

const MAX_TEXT = 200_000;
const HARMLOS = new Set(['/etc/localtime', '/etc/timezone', '/var/run/docker.sock', '/run/docker.sock']);
const GEHEIM = /(PASS|PASSWORD|PASSWORT|SECRET|TOKEN|KEY|PWD)/i;

function fehler(text, extra) { return new FahnasFehler('E_PARAMS', text, { feld: 'compose', ...(extra || {}) }); }

/** Großbuchstaben-Kennung für Feldnamen (A–Z, 0–9, _; beginnt mit Buchstabe). */
function kennung(s) {
  const k = String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(k) ? k : `X_${k || 'W'}`;
}

/** Schreibt ein Compose-Dokument als YAML (Teilmenge, die yamlLesen wieder lesen kann: Blockstil, Strings doppelt zitiert). */
export function yamlSchreiben(wert, tiefe = 0) {
  const ein = '  '.repeat(tiefe);
  const skalar = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return JSON.stringify(String(v));
  };
  const schluessel = (k) => (/^[A-Za-z0-9_.\-/]+$/.test(k) ? k : JSON.stringify(k));
  const zeilen = [];
  if (Array.isArray(wert)) {
    for (const e of wert) {
      if (e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length) {
        const innen = yamlSchreiben(e, tiefe + 1).split('\n');
        zeilen.push(`${ein}- ${innen[0].trimStart()}`, ...innen.slice(1));
      } else if (Array.isArray(e)) {
        zeilen.push(`${ein}- ${e.length ? JSON.stringify(e.map((x) => String(x))) : '[]'}`);
      } else {
        zeilen.push(`${ein}- ${e && typeof e === 'object' ? '{}' : skalar(e)}`);
      }
    }
    return zeilen.join('\n');
  }
  for (const [k, v] of Object.entries(wert || {})) {
    if (Array.isArray(v)) {
      if (!v.length) zeilen.push(`${ein}${schluessel(k)}: []`);
      else zeilen.push(`${ein}${schluessel(k)}:`, yamlSchreiben(v, tiefe + 1));
    } else if (v && typeof v === 'object') {
      if (!Object.keys(v).length) zeilen.push(`${ein}${schluessel(k)}: {}`);
      else zeilen.push(`${ein}${schluessel(k)}:`, yamlSchreiben(v, tiefe + 1));
    } else {
      zeilen.push(`${ein}${schluessel(k)}: ${skalar(v)}`);
    }
  }
  return zeilen.join('\n');
}

/**
 * Wandelt eine Compose-Datei in eine eigene Vorlage (quelle „eigen“) um.
 * @param {string} text   Inhalt der docker-compose.yml
 * @param {{titel?:string}} optionen
 * @returns {object} geprüfte Vorlage (vorlagePruefen)
 */
export function vorlageAusCompose(text, { titel } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw fehler('Bitte den Inhalt einer Compose-Datei einfügen');
  if (text.length > MAX_TEXT) throw fehler('Die Compose-Datei ist zu groß (max. 200 KB)');

  // ${VAR:-standard} / ${VAR-standard} / ${VAR:?meldung} → ${VAR} und Standardwert merken (FAH-NAS setzt Werte über .env)
  const standards = new Map();
  const vereinfacht = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])([^}]*)\}/g, (_, name, art, rest) => {
    if (art.endsWith('-') && !standards.has(name)) standards.set(name, rest);
    return `\${${name}}`;
  });
  const doc = yamlLesen(vereinfacht);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fehler('Das ist keine Compose-Datei (oberste Ebene muss ein Mapping sein)');
  for (const k of Object.keys(doc)) {
    if (!['services', 'volumes', 'networks', 'version', 'name'].includes(k) && !k.startsWith('x-')) {
      throw fehler(`„${k}:“ wird nicht unterstützt – erlaubt sind services, volumes und networks`, { wert: k });
    }
  }
  delete doc.version; delete doc.name; // Projektname vergibt FAH-NAS selbst (fahnas-<app>)
  if (!doc.services || typeof doc.services !== 'object' || !Object.keys(doc.services).length) throw fehler('Die Compose-Datei enthält keine services');

  const felder = [];
  const hinweise = [];
  const vergeben = new Set();
  const feldName = (vorsilbe, teil) => {
    const basis = kennung(`${vorsilbe}_${teil}`);
    let n = basis; let i = 2;
    while (vergeben.has(n)) n = `${basis}_${i++}`;
    vergeben.add(n);
    return n;
  };

  for (const [dn, d] of Object.entries(doc.services)) {
    if (!d || typeof d !== 'object') throw fehler(`Dienst „${dn}“ ist leer`);
    if (d.build !== undefined) throw fehler(`Dienst „${dn}“ nutzt „build:“ – FAH-NAS braucht ein fertiges Image (image:). Baue das Image vorher und trage es als image ein.`, { wert: dn });
    if (typeof d.image !== 'string' || !d.image.trim()) throw fehler(`Dienst „${dn}“ hat kein image`, { wert: dn });
    if (d.env_file !== undefined) throw fehler(`Dienst „${dn}“ nutzt „env_file:“ – bitte die Variablen direkt unter environment eintragen`, { wert: dn });
    if (d.configs !== undefined || d.secrets !== undefined) throw fehler(`Dienst „${dn}“ nutzt configs/secrets – nicht unterstützt`, { wert: dn });
    if (d.container_name !== undefined) hinweise.push(`Dienst „${dn}“ hat einen festen container_name (${d.container_name}) – zwei Installationen derselben App würden sich stören.`);

    // Ports → Port-Felder
    if (Array.isArray(d.ports)) {
      d.ports = d.ports.map((p) => {
        if (p && typeof p === 'object') {
          if (p.published === undefined) return p;
          const pub = String(p.published);
          if (!/^\d+$/.test(pub)) return p; // Bereich bleibt wörtlich
          const proto = p.protocol === 'udp' ? 'udp' : 'tcp';
          const name = feldName('PORT', `${dn}_${p.target ?? pub}${proto === 'udp' ? '_UDP' : ''}`);
          felder.push({ name, art: 'port', standard: Number(pub), container: Number(p.target ?? pub), protokoll: proto,
            beschriftung: `Port ${p.target ?? pub}/${proto} (${dn})`, erklaerung: `Port auf dem NAS, unter dem ${dn} erreichbar ist (im Container ${p.target ?? pub}).` });
          return { ...p, published: `\${${name}}` };
        }
        const s = String(p).trim();
        // [ip:]host:container[/proto] oder nur container[/proto]
        const m = /^(?:(\[[^\]]+\]|\d+\.\d+\.\d+\.\d+):)?(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(s);
        if (!m) return s; // Bereiche u. Ä. bleiben wörtlich (werden bei der Prüfung trotzdem auf Konflikte geprüft)
        const ip = m[1] ? `${m[1]}:` : ''; const host = m[2] || m[3]; const ziel = m[3]; const proto = m[4] === 'udp' ? 'udp' : 'tcp';
        const name = feldName('PORT', `${dn}_${ziel}${proto === 'udp' ? '_UDP' : ''}`);
        felder.push({ name, art: 'port', standard: Number(host), container: Number(ziel), protokoll: proto,
          beschriftung: `Port ${ziel}/${proto} (${dn})`, erklaerung: `Port auf dem NAS, unter dem ${dn} erreichbar ist (im Container ${ziel}).` });
        return `${ip}\${${name}}:${ziel}${m[4] ? `/${m[4]}` : ''}`;
      });
    }

    // Bind-Mounts → Pfad-Felder (App-Ordner oder Freigabe); benannte Volumes und harmlose Systempfade bleiben
    if (Array.isArray(d.volumes)) {
      d.volumes = d.volumes.map((v) => {
        const lang = v && typeof v === 'object';
        const quelle = lang ? (v.type === 'bind' || v.type === undefined ? v.source : null) : String(v).split(':')[0];
        if (quelle === null || quelle === undefined) return v;
        const q = String(quelle);
        const ziel0 = lang ? String(v.target || '') : String(v).split(':')[1] || '';
        const modus0 = lang ? (v.read_only ? 'ro' : '') : (String(v).split(':')[2] || '');
        // Quelle ist selbst eine Variable (${UPLOAD_LOCATION}:/…) → Pfad-Feld unter diesem Namen
        const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(q);
        if (variable) {
          const vn = variable[1]; const name = /^[A-Z][A-Z0-9_]*$/.test(vn) && !vergeben.has(vn) ? vn : feldName('PFAD', vn);
          vergeben.add(name); vergeben.add(vn);
          const roh = standards.get(vn);
          const std = roh && roh.startsWith('/data/shares/') ? path.posix.normalize(roh)
            : `daten/${(path.posix.basename(path.posix.normalize(String(roh || ziel0 || vn).replace(/^~/, ''))) || 'daten').replace(/[^A-Za-z0-9._-]+/g, '_')}`;
          felder.push({ name, art: 'pfad', standard: std, container: ziel0, nur_lesen: /(^|,)ro(,|$)/.test(modus0),
            beschriftung: `${vn} (${dn}: ${ziel0 || 'Daten'})`, erklaerung: 'Ordner im App-Ordner (relativ) oder eine Freigabe (/data/shares/…), der im Container eingehängt wird.' });
          if (lang) return { ...v, type: 'bind', source: `\${${name}}` };
          return `\${${name}}:${ziel0}${modus0 ? `:${modus0}` : ''}`;
        }
        if (!(q.startsWith('/') || q.startsWith('.') || q.startsWith('~'))) return v; // benanntes Volume
        if (HARMLOS.has(path.posix.normalize(q)) || q.startsWith('/dev/')) return v; // Risiko-Prüfung greift später
        const ziel = lang ? String(v.target || '') : String(v).split(':')[1] || '';
        const modus = lang ? (v.read_only ? 'ro' : '') : (String(v).split(':')[2] || '');
        const nurLesen = /(^|,)ro(,|$)/.test(modus);
        let standard;
        if (q.startsWith('/data/shares/')) standard = path.posix.normalize(q);
        else {
          const teil = path.posix.basename(path.posix.normalize(q.replace(/^~/, ''))) || path.posix.basename(ziel) || 'daten';
          standard = `daten/${teil.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
          if (q.startsWith('/')) hinweise.push(`${dn}: „${q}“ liegt außerhalb von FAH-NAS und wurde in den App-Ordner verlegt (${standard}) – bei Bedarf im Formular auf eine Freigabe unter /data/shares umstellen.`);
        }
        const name = feldName('PFAD', `${dn}_${path.posix.basename(ziel) || 'DATEN'}`);
        felder.push({ name, art: 'pfad', standard, container: ziel, nur_lesen: nurLesen,
          beschriftung: `Ordner für ${ziel || 'Daten'} (${dn})`, erklaerung: 'Ordner im App-Ordner (relativ) oder eine Freigabe (/data/shares/…), der im Container eingehängt wird.' });
        if (lang) return { ...v, type: 'bind', source: `\${${name}}` };
        return `\${${name}}:${ziel}${modus ? `:${modus}` : ''}`;
      });
    }
  }

  let compose = yamlSchreiben(doc) + '\n';
  // übrige ${VARIABLEN} (z. B. in environment) → Variablen-/Geheimnis-Felder
  for (const m of compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const n = m[1];
    if (vergeben.has(n)) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(n)) {
      // Feldnamen müssen groß sein – kleingeschriebene Variablen umbenennen
      const neu = feldName('VAR', n);
      compose = compose.split(`\${${n}}`).join(`\${${neu}}`);
      felder.push({ name: neu, art: GEHEIM.test(n) ? 'geheimnis' : 'variable', standard: standards.get(n) ?? '', pflicht: !standards.has(n) && GEHEIM.test(n), beschriftung: n, erklaerung: `Wert für ${n} aus der Compose-Datei.` });
      continue;
    }
    vergeben.add(n);
    felder.push({ name: n, art: GEHEIM.test(n) ? 'geheimnis' : 'variable', standard: standards.get(n) ?? '', pflicht: !standards.has(n) && GEHEIM.test(n), beschriftung: n, erklaerung: `Wert für ${n} aus der Compose-Datei.` });
  }
  // $VAR ohne Klammern in Werten ist bei compose eine Variable – für FAH-NAS eindeutig machen
  if (/\$(?!\$|\{)[A-Za-z_]/.test(compose.replace(/\$\$/g, ''))) {
    throw fehler('Die Datei nutzt Variablen in der Form $NAME – bitte ${NAME} schreiben (oder $$ für ein echtes Dollarzeichen)');
  }

  const name = String(titel || '').trim() || Object.keys(doc.services)[0];
  const ersteDienst = Object.values(doc.services)[0] || {};
  const portFeld = felder.find((f) => f.art === 'port' && f.protokoll === 'tcp');
  return vorlagePruefen({
    id: `eigen-${slug(name) || 'app'}`,
    name,
    beschreibung: `Eigene App aus einer Compose-Datei (${Object.keys(doc.services).length} Dienst${Object.keys(doc.services).length === 1 ? '' : 'e'}, Image ${ersteDienst.image}).`,
    kategorie: 'Eigene Apps',
    quelle: 'eigen',
    webui: portFeld ? `http://{HOST}:{${portFeld.name}}` : '',
    compose,
    felder,
    hinweise,
    herkunft: { art: 'compose' },
  }, { quelle: 'eigen' });
}
