#!/usr/bin/env node
// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Prüft iso/nocloud/user-data: YAML lesbar (über ruby -ryaml oder python3+PyYAML – was da ist; Node hat keinen
// YAML-Leser an Bord), gültig gegen iso/cache/autoinstall-schema.json (eigener kleiner JSON-Schema-Prüfer für die
// dort benutzte Teilmenge) und Pflichtinhalte von FAH-NAS (version 1, storage mit Labels, early-/late-commands).
// Wird von iso/build_iso.sh vor dem ISO-Bau und von tests/einheit/iso.test.js benutzt.
//   node iso/werkzeuge/autoinstall_pruefen.mjs [user-data] [schema.json]   → Exit 0 oder 1 mit Meldungen

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
export const USER_DATA_STANDARD = path.join(HIER, '..', 'nocloud', 'user-data');
export const SCHEMA_STANDARD = path.join(HIER, '..', 'autoinstall-schema.json'); // versioniert; iso/cache ist nur Ablage für Downloads

function laufen(programm, args, eingabe) {
  return new Promise((ok) => {
    const kind = execFile(programm, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (e, stdout, stderr) => {
      ok({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    kind.on('error', () => {});
    if (eingabe !== undefined && kind.stdin) kind.stdin.end(eingabe);
  });
}

/**
 * YAML → JS-Objekt über ein vorhandenes Werkzeug: erst ruby (macOS/Linux mit ruby), dann python3 mit PyYAML.
 * Wirft mit klarer Meldung, wenn keines da ist.
 */
export async function yamlNachJson(datei) {
  const text = await fs.readFile(datei, 'utf8');
  const ruby = await laufen('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'], text);
  if (ruby.code === 0 && ruby.stdout.trim()) return { daten: JSON.parse(ruby.stdout), werkzeug: 'ruby' };
  const py = await laufen('python3', ['-c', 'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], text);
  if (py.code === 0 && py.stdout.trim()) return { daten: JSON.parse(py.stdout), werkzeug: 'python3' };
  throw new Error(`Kein YAML-Leser gefunden (ruby -ryaml: ${ruby.stderr.trim().split('\n')[0] || 'fehlt'}; python3 yaml: ${py.stderr.trim().split('\n')[0] || 'fehlt'}). macOS: ruby ist Bestandteil des Systems; Linux: apt install ruby oder python3-yaml.`);
}

// --- kleiner JSON-Schema-Prüfer (Teilmenge: type, properties, required, additionalProperties, items, enum, const, anyOf, oneOf,
//     minimum, maximum, minLength, maxLength, pattern) ---------------------------------------------------------------------
function typVon(w) {
  if (w === null) return 'null';
  if (Array.isArray(w)) return 'array';
  if (typeof w === 'number') return Number.isInteger(w) ? 'integer' : 'number';
  return typeof w;
}
function typPasst(erwartet, w) {
  const t = typVon(w);
  const liste = Array.isArray(erwartet) ? erwartet : [erwartet];
  return liste.some((e) => e === t || (e === 'number' && t === 'integer'));
}

/** Gibt eine Liste von Fehlern zurück (leer = gültig). */
export function schemaPruefen(schema, daten, pfad = '$') {
  const fehler = [];
  if (!schema || typeof schema !== 'object') return fehler;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(daten)) fehler.push(`${pfad}: muss ${JSON.stringify(schema.const)} sein`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(daten))) fehler.push(`${pfad}: muss einer dieser Werte sein: ${schema.enum.join(', ')}`);
  if (schema.type && !typPasst(schema.type, daten)) { fehler.push(`${pfad}: Typ ${typVon(daten)}, erwartet ${[].concat(schema.type).join('|')}`); return fehler; }
  if (schema.anyOf) {
    const treffer = schema.anyOf.map((s) => schemaPruefen(s, daten, pfad));
    if (!treffer.some((f) => f.length === 0)) fehler.push(`${pfad}: passt zu keiner anyOf-Variante (${treffer.map((f) => f[0]).join(' / ')})`);
  }
  if (schema.oneOf) {
    const treffer = schema.oneOf.map((s) => schemaPruefen(s, daten, pfad)).filter((f) => f.length === 0).length;
    if (treffer !== 1) fehler.push(`${pfad}: passt zu ${treffer} oneOf-Varianten, erwartet genau 1`);
  }
  const t = typVon(daten);
  if (t === 'object') {
    const props = schema.properties || {};
    for (const p of schema.required || []) if (!(p in daten)) fehler.push(`${pfad}: Pflichtfeld „${p}“ fehlt`);
    for (const [k, v] of Object.entries(daten)) {
      if (k in props) fehler.push(...schemaPruefen(props[k], v, `${pfad}.${k}`));
      else if (schema.additionalProperties === false) fehler.push(`${pfad}: unbekanntes Feld „${k}“`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') fehler.push(...schemaPruefen(schema.additionalProperties, v, `${pfad}.${k}`));
    }
  } else if (t === 'array') {
    if (schema.items) daten.forEach((e, i) => fehler.push(...schemaPruefen(schema.items, e, `${pfad}[${i}]`)));
  } else if (t === 'string') {
    if (schema.minLength !== undefined && daten.length < schema.minLength) fehler.push(`${pfad}: zu kurz`);
    if (schema.maxLength !== undefined && daten.length > schema.maxLength) fehler.push(`${pfad}: zu lang`);
    if (schema.pattern && !new RegExp(schema.pattern).test(daten)) fehler.push(`${pfad}: passt nicht zu ${schema.pattern}`);
  } else if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && daten < schema.minimum) fehler.push(`${pfad}: kleiner als ${schema.minimum}`);
    if (schema.maximum !== undefined && daten > schema.maximum) fehler.push(`${pfad}: größer als ${schema.maximum}`);
  }
  return fehler;
}

export const PAKETE_PFLICHT = ['samba', 'samba-vfs-modules', 'avahi-daemon', 'btrfs-progs', 'snapper', 'nodejs', 'docker.io', 'docker-compose-v2', 'docker-buildx',
  'qemu-system-x86', 'libvirt-daemon-system', 'libvirt-clients', 'virtinst', 'zram-tools', 'smartmontools', 'lm-sensors', 'nftables',
  'zip', 'unzip', 'acl', 'attr', 'openssl', 'curl', 'tar', 'zstd', 'hdparm', 'iproute2', 'inotify-tools', 'conntrack', 'ffmpeg', 'rsync', 'unison', 'cifs-utils', 'smbclient', 'wireguard-tools', 'qrencode'];

/** FAH-NAS-Pflichtinhalte der Autoinstall-Konfiguration (Objekt unterhalb von „autoinstall“). Liste von Fehlern. */
export function pflichtPruefen(cfg) {
  const f = [];
  if (!cfg || typeof cfg !== 'object') return ['autoinstall fehlt oder ist kein Objekt'];
  if (cfg.version !== 1) f.push('version muss 1 sein');
  if (JSON.stringify(cfg['interactive-sections']) !== JSON.stringify(['identity'])) f.push('interactive-sections muss genau [identity] sein');
  if (cfg.locale !== 'de_DE.UTF-8') f.push('locale muss de_DE.UTF-8 sein');
  if (cfg.keyboard?.layout !== 'de') f.push('keyboard.layout muss de sein');
  if (cfg.timezone !== 'Europe/Berlin') f.push('timezone muss Europe/Berlin sein');
  if (cfg.source?.id !== 'ubuntu-server' || cfg.source?.search_drivers !== false) f.push('source: id ubuntu-server, search_drivers false');
  if (cfg.ssh?.['install-server'] !== true || cfg.ssh?.['allow-pw'] !== true) f.push('ssh: install-server und allow-pw müssen true sein');
  if (cfg.updates !== 'security') f.push('updates muss security sein');
  if (cfg.apt?.fallback !== 'offline-install') f.push('apt.fallback muss offline-install sein');
  const pakete = Array.isArray(cfg.packages) ? cfg.packages : [];
  for (const p of PAKETE_PFLICHT) if (!pakete.includes(p)) f.push(`packages: ${p} fehlt`);
  if (pakete.includes('grub-btrfs')) f.push('packages: grub-btrfs ist kein Ubuntu-Paket (baut der Erststart aus der Quelle) – Installer würde abbrechen');
  const frueh = (cfg['early-commands'] || []).map(String).join('\n');
  if (!/platte_waehlen\.sh/.test(frueh)) f.push('early-commands müssen platte_waehlen.sh aufrufen');
  const spaet = (cfg['late-commands'] || []).map(String).join('\n');
  if (!/partitionen\.sh/.test(spaet)) f.push('late-commands müssen partitionen.sh aufrufen');
  if (!/\/target\/opt\/fahnas-install/.test(spaet)) f.push('late-commands müssen /cdrom/fahnas nach /target/opt/fahnas-install kopieren');
  if (!/systemctl enable fahnas-erststart\.service/.test(spaet)) f.push('late-commands müssen fahnas-erststart.service aktivieren');
  const st = cfg.storage;
  if (!st || typeof st !== 'object' || !Array.isArray(st.config)) f.push('storage.config (curtin-Liste) fehlt');
  else {
    if (st.version !== 2) f.push('storage.version muss 2 sein (preserve/offset brauchen v2)');
    if (st.swap?.size !== 0) f.push('storage.swap.size muss 0 sein (Auslagerungspartition statt Datei)');
    const disks = st.config.filter((a) => a.type === 'disk');
    if (disks.length !== 1 || disks[0].path !== 'FAHNAS_ZIELPLATTE' || disks[0].ptable !== 'gpt') f.push('storage: genau eine disk mit path FAHNAS_ZIELPLATTE und ptable gpt');
    const labels = st.config.filter((a) => a.type === 'format').map((a) => a.label);
    for (const l of ['FAHNAS-EFI', 'FAHNAS-SWAP', 'FAHNAS-SYSTEM', 'FAHNAS-DATEN']) if (!labels.includes(l)) f.push(`storage: format mit label ${l} fehlt`);
    const daten = st.config.find((a) => a.type === 'partition' && a.size === 'FAHNAS_DATEN_GROESSE');
    if (!daten) f.push('storage: Datenpartition mit Platzhalter FAHNAS_DATEN_GROESSE fehlt');
    const mounts = st.config.filter((a) => a.type === 'mount').map((a) => a.path);
    if (!mounts.includes('/') || !mounts.includes('/boot/efi')) f.push('storage: mounts / und /boot/efi fehlen');
    const efi = st.config.find((a) => a.type === 'partition' && a.flag === 'boot');
    if (!efi || efi.grub_device !== true) f.push('storage: EFI-Partition (flag boot) braucht grub_device true');
    const sys = st.config.find((a) => a.type === 'partition' && a.number === 3);
    if (!sys || sys.size !== 48 * 1024 ** 3) f.push('storage: Partition 3 muss 48 GiB haben');
    const swap = st.config.find((a) => a.type === 'partition' && a.number === 2);
    if (!swap || swap.size !== 8 * 1024 ** 3 || swap.flag !== 'swap') f.push('storage: Partition 2 muss 8 GiB swap sein');
    if (!efi || efi.size !== 1024 ** 3) f.push('storage: EFI-Partition muss 1 GiB haben');
  }
  return f;
}

/** Gesamtprüfung; gibt {fehler:[…], werkzeug, cfg} zurück. */
export async function pruefen(userData = USER_DATA_STANDARD, schemaDatei = SCHEMA_STANDARD) {
  const { daten, werkzeug } = await yamlNachJson(userData);
  const fehler = [];
  const text = await fs.readFile(userData, 'utf8');
  if (!text.startsWith('#cloud-config')) fehler.push('user-data muss mit „#cloud-config“ beginnen');
  if (!daten || typeof daten !== 'object' || !daten.autoinstall) fehler.push('Schlüssel „autoinstall“ fehlt');
  const cfg = daten && daten.autoinstall;
  let schema = null;
  try { schema = JSON.parse(await fs.readFile(schemaDatei, 'utf8')); } catch { fehler.push(`Schema nicht lesbar: ${schemaDatei} (Hinweis: iso/cache/autoinstall-schema.json aus dem Installer/der Doku)`); }
  if (schema && cfg) fehler.push(...schemaPruefen(schema, cfg, 'autoinstall'));
  if (cfg) fehler.push(...pflichtPruefen(cfg));
  return { fehler, werkzeug, cfg };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [ud, sch] = process.argv.slice(2);
  pruefen(ud || USER_DATA_STANDARD, sch || SCHEMA_STANDARD).then(({ fehler, werkzeug, cfg }) => {
    if (fehler.length) {
      process.stderr.write(`user-data ungültig (${fehler.length} Fund${fehler.length > 1 ? 'e' : ''}):\n  - ${fehler.join('\n  - ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`user-data in Ordnung (YAML über ${werkzeug}, Schema geprüft, ${(cfg.packages || []).length} Pakete, ${cfg.storage.config.length} storage-Aktionen).\n`);
  }).catch((e) => { process.stderr.write(`Prüfung nicht möglich: ${e.message}\n`); process.exit(1); });
}
