// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// App-Editor wie bei Unraid (Betreiber 12.10.2026): Ports, Pfade und Variablen jeder App (Katalog, eigene Compose, ZIP)
// einfach ändern. Grundlage ist die WIRKSAME Einstellung (`docker compose config --format json`); gespeichert wird eine
// Anpassungsdatei (fahnas.anpassung.yml) mit `!override`, die FAH-NAS bei jedem compose-Aufruf zuletzt mitgibt. Die
// Original-Compose bleibt unberührt, „Zurücksetzen“ löscht nur die Anpassungsdatei.

import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { pfadPruefen, pfadDeuten } from './compose.js';
import { gpuAusDienst, gpuUeberschreibung, GPU_ARTEN } from '../helfer/gpu.js';

export const ANPASSUNG_DATEI = 'fahnas.anpassung.yml';
const NAME_VAR = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const GEHEIM = /(pass(wor[dt])?|secret|geheim|token|api[_-]?key|private[_-]?key|credential)/i;
const STEUERZEICHEN = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const PROTOKOLLE = ['tcp', 'udp'];

function fehler(text, feld) { return new FahnasFehler('E_PARAMS', text, { feld }); }

/** Ist eine Variable vermutlich ein Geheimnis? (Wert wird in der Oberfläche verdeckt, leer gelassen = unverändert) */
export function istGeheim(name) { return GEHEIM.test(String(name)); }

/**
 * Wirksame Einstellungen aus `docker compose config --format json` in die Form des Editors bringen.
 * @returns {Array<{name, image, ports:[{host, container, protokoll, adresse}], pfade:[{art, host, container, nur_lesen}],
 *   variablen:[{name, wert, geheim}]}>} Geheimnis-Werte sind leer (die Oberfläche bekommt sie nie)
 */
export function einstellungenAusConfig(config, { geheimnisseZeigen = false } = {}) {
  const dienste = [];
  for (const [name, d] of Object.entries((config && config.services) || {})) {
    if (!d || typeof d !== 'object') continue;
    const ports = (Array.isArray(d.ports) ? d.ports : []).filter((p) => p && p.published !== undefined && p.published !== '').map((p) => ({
      host: Number(p.published), container: Number(p.target), protokoll: PROTOKOLLE.includes(p.protocol) ? p.protocol : 'tcp', adresse: p.host_ip || '',
    }));
    const pfade = (Array.isArray(d.volumes) ? d.volumes : []).filter((v) => v && (v.type === 'bind' || v.type === 'volume')).map((v) => ({
      art: v.type === 'bind' ? 'ordner' : 'volume', host: String(v.source || ''), container: String(v.target || ''), nur_lesen: !!v.read_only,
    }));
    const env = d.environment && typeof d.environment === 'object' ? d.environment : {};
    const variablen = Object.entries(env).map(([k, v]) => {
      const geheim = istGeheim(k);
      const wert = v === null || v === undefined ? '' : String(v).replace(/\$\$/g, '$');
      return { name: k, wert: geheim && !geheimnisseZeigen ? '' : wert, geheim };
    }).sort((a, b) => a.name.localeCompare(b.name));
    dienste.push({ name, image: d.image || (d.build ? '(wird gebaut)' : ''), netz_host: d.network_mode === 'host', ports, pfade, variablen, gpu: gpuAusDienst(d) });
  }
  return dienste.sort((a, b) => a.name.localeCompare(b.name));
}

/** Port-Eingabe prüfen. */
function portNormal(p, feld) {
  const host = Number(p && p.host); const container = Number(p && p.container);
  if (!Number.isInteger(host) || host < 1 || host > 65535) throw fehler(`NAS-Port „${p && p.host}“ ist ungültig (1–65535)`, feld);
  if (!Number.isInteger(container) || container < 1 || container > 65535) throw fehler(`Container-Port „${p && p.container}“ ist ungültig (1–65535)`, feld);
  const protokoll = PROTOKOLLE.includes(p.protokoll) ? p.protokoll : 'tcp';
  const adresse = typeof p.adresse === 'string' ? p.adresse.trim() : '';
  if (adresse && !/^[0-9a-fA-F.:[\]]{2,45}$/.test(adresse)) throw fehler(`Adresse „${adresse}“ ist ungültig`, feld);
  return { host, container, protokoll, adresse };
}

/**
 * Eingaben des Editors prüfen und normalisieren. `original` = Einstellungen der Compose OHNE Anpassung (mit Geheimnissen),
 * `aktuell` = wirksame Einstellungen MIT Anpassung (für „Geheimnis leer = unverändert“ und unveränderte Pfade).
 * Neue/geänderte NAS-Ordner nur im App-Ordner oder unter den Freigaben (wie bei der Installation); unverändert
 * übernommene Einhängungen (z. B. „/“ bei FAH-Sicherung) bleiben erlaubt.
 */
export function anpassungPruefen(eingabe, { original, aktuell, appOrdner, shares, freigaben = [] }) {
  if (!Array.isArray(eingabe) || !eingabe.length) throw fehler('Keine Einstellungen übergeben', 'dienste');
  const bekannt = new Map(original.map((d) => [d.name, d]));
  const jetzt = new Map(aktuell.map((d) => [d.name, d]));
  const erlaubtePfade = new Set([...original, ...aktuell].flatMap((d) => d.pfade.filter((p) => p.art === 'ordner').map((p) => p.host)));
  const belegt = new Set();
  const aus = [];
  for (const e of eingabe) {
    const o = bekannt.get(e && e.name);
    if (!o) throw fehler(`Unbekannter Dienst „${e && e.name}“`, 'dienste');
    const ports = (Array.isArray(e.ports) ? e.ports : []).map((p, i) => portNormal(p, `${e.name}.ports.${i}`));
    for (const p of ports) {
      const k = `${p.host}/${p.protokoll}`;
      if (belegt.has(k)) throw fehler(`NAS-Port ${p.host}/${p.protokoll} ist doppelt eingetragen`, `${e.name}.ports`);
      belegt.add(k);
    }
    const ziele = new Set();
    const pfade = (Array.isArray(e.pfade) ? e.pfade : []).map((p, i) => {
      const feld = `${e.name}.pfade.${i}`;
      const container = typeof p.container === 'string' ? p.container.trim() : '';
      if (!container.startsWith('/') || STEUERZEICHEN.test(container) || container.split('/').includes('..')) throw fehler(`Container-Pfad „${container}“ muss mit / beginnen`, feld);
      if (ziele.has(container)) throw fehler(`Container-Pfad ${container} ist doppelt eingetragen`, feld);
      ziele.add(container);
      if (p.art === 'volume') {
        const quelle = String(p.host || '');
        if (!o.pfade.some((x) => x.art === 'volume' && x.host === quelle)) throw fehler(`Docker-Volume „${quelle}“ gehört nicht zu dieser App`, feld);
        return { art: 'volume', host: quelle, container, nur_lesen: !!p.nur_lesen };
      }
      let host = typeof p.host === 'string' ? p.host.trim() : '';
      if (!host) throw fehler('Bitte einen NAS-Ordner eintragen', feld);
      if (!erlaubtePfade.has(host)) {
        host = pfadDeuten(host, { appOrdner, shares, freigaben });
        if (!host.startsWith('/')) host = path.posix.join(appOrdner, host);
        host = path.posix.normalize(host);
      }
      if (!erlaubtePfade.has(host)) host = pfadPruefen(host, { name: feld, beschriftung: `NAS-Ordner für ${container}` }, { appOrdner, shares, freigaben });
      return { art: 'ordner', host, container, nur_lesen: !!p.nur_lesen };
    });
    const namen = new Set();
    const vorher = new Map([...(jetzt.get(e.name)?.variablen || []), ...[]].map((v) => [v.name, v.wert]));
    const vorherOriginal = new Map(o.variablen.map((v) => [v.name, v.wert]));
    const variablen = (Array.isArray(e.variablen) ? e.variablen : []).map((v, i) => {
      const feld = `${e.name}.variablen.${i}`;
      const name = typeof v.name === 'string' ? v.name.trim() : '';
      if (!NAME_VAR.test(name)) throw fehler(`Variablenname „${name}“ ist ungültig (Buchstaben, Ziffern, _ . -)`, feld);
      if (namen.has(name)) throw fehler(`Variable ${name} ist doppelt eingetragen`, feld);
      namen.add(name);
      let wert = v.wert === undefined || v.wert === null ? '' : String(v.wert);
      // Geheimnis leer gelassen = unverändert (die Oberfläche kennt den Wert nicht)
      if (wert === '' && istGeheim(name)) wert = vorher.get(name) ?? vorherOriginal.get(name) ?? '';
      if (wert.length > 4096 || /[\u0000\n\r]/.test(wert)) throw fehler(`Wert von ${name}: höchstens 4096 Zeichen, keine Zeilenumbrüche`, feld);
      return { name, wert };
    });
    const gpu = GPU_ARTEN.includes(e.gpu) ? e.gpu : (jetzt.get(e.name)?.gpu || o.gpu || 'keine');
    aus.push({ name: e.name, ports, pfade, variablen, gpu });
  }
  return aus;
}

/** `$` für compose verdoppeln (sonst ersetzt compose ${…}/$NAME in der Anpassungsdatei). */
function dollar(s) { return String(s).replace(/\$/g, '$$$$'); }

/**
 * Anpassungsdatei (YAML) bauen: je Dienst `ports`, `volumes`, `environment` (und bei geänderter Grafikkarte `devices`,
 * `group_add`, `deploy`) mit `!override` (ersetzt statt ergänzt).
 * JSON ist gültiges YAML – die Listen stehen als JSON-Flow hinter dem Tag. Bind-Optionen (z. B. propagation rslave)
 * unveränderter Ordner bleiben aus der Original-Einstellung erhalten.
 */
export function anpassungYaml(dienste, originalConfig, gpuOpt = {}) {
  const z = ['# Von FAH-NAS geschrieben (App bearbeiten) – nicht von Hand ändern; „Auf Original zurücksetzen“ löscht die Datei', 'services:'];
  for (const d of dienste) {
    const orig = (originalConfig && originalConfig.services && originalConfig.services[d.name]) || {};
    const origVolumes = Array.isArray(orig.volumes) ? orig.volumes : [];
    const ports = d.ports.map((p) => ({ target: p.container, published: String(p.host), protocol: p.protokoll, ...(p.adresse ? { host_ip: p.adresse } : {}) }));
    const volumes = d.pfade.map((p) => {
      const alt = origVolumes.find((v) => v && v.target === p.container && String(v.source) === p.host);
      const v = { type: p.art === 'volume' ? 'volume' : 'bind', source: dollar(p.host), target: dollar(p.container), read_only: !!p.nur_lesen };
      if (alt && alt.bind && p.art !== 'volume') v.bind = alt.bind;
      if (alt && alt.volume && p.art === 'volume') v.volume = alt.volume;
      if (p.art !== 'volume' && !v.bind) v.bind = { create_host_path: true };
      return v;
    });
    const env = {}; for (const v of d.variablen) env[v.name] = dollar(v.wert);
    z.push(`  ${JSON.stringify(d.name)}:`);
    z.push(`    ports: !override ${JSON.stringify(ports)}`);
    z.push(`    volumes: !override ${JSON.stringify(volumes)}`);
    z.push(`    environment: !override ${JSON.stringify(env)}`);
    // Grafikkarte (Ausbau Oktober 2026): nur wenn die Wahl vom Original abweicht – fremde Geräte/Gruppen bleiben
    if (d.gpu && d.gpu !== gpuAusDienst(orig)) {
      const g = gpuUeberschreibung(d.gpu, orig, gpuOpt);
      z.push(`    devices: !override ${JSON.stringify(g.devices)}`);
      z.push(`    group_add: !override ${JSON.stringify(g.group_add)}`);
      if (g.deploy) z.push(`    deploy: !override ${JSON.stringify(g.deploy)}`);
    }
  }
  return z.join('\n') + '\n';
}

/** Ports für Satz/Firewall/Konfliktprüfung aus den geprüften Einstellungen. */
export function portsAusDiensten(dienste) {
  const aus = new Map();
  for (const d of dienste) for (const p of d.ports) aus.set(`${p.host}/${p.protokoll}`, { port: p.host, protokoll: p.protokoll, ziel: p.container, dienst: d.name, ...(p.adresse ? { adresse: p.adresse } : {}) });
  return [...aus.values()].sort((a, b) => a.port - b.port);
}

/** Einfaches Compose für eine ZIP, die nur ein Dockerfile mitbringt: Port(s) aus EXPOSE gleich nach außen. */
export function composeAusDockerfile(dockerfile, name) {
  const ports = [];
  for (const m of String(dockerfile || '').matchAll(/^\s*EXPOSE\s+(.+)$/gim)) {
    for (const teil of m[1].split(/\s+/)) {
      const t = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(teil.trim());
      if (t && Number(t[1]) >= 1 && Number(t[1]) <= 65535) ports.push(`"${t[1]}:${t[1]}${t[2] && t[2].toLowerCase() === 'udp' ? '/udp' : ''}"`);
    }
  }
  const zeilen = ['# Von FAH-NAS angelegt: die ZIP brachte nur ein Dockerfile mit. Ports/Pfade/Variablen über „Bearbeiten“ anpassen.', 'services:', `  ${name}:`, '    build: .', '    restart: unless-stopped'];
  if (ports.length) zeilen.push(`    ports: [${[...new Set(ports)].join(', ')}]`);
  return zeilen.join('\n') + '\n';
}
