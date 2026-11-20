// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Virtuelle Maschinen (Teilprojekt 3, Betreiber 12.10.2026: „inkl. zu groß das VM Thema“) – reine Regeln ohne
// Systemzugriff: Eingaben prüfen, virt-install-Argumente bauen, virsh-Ausgaben auswerten.

import { FahnasFehler } from '../../gemeinsam/fehler.js';

const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
export const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const SYSTEME = Object.freeze(['linux', 'windows', 'andere']);
export const NETZE = Object.freeze(['nat', 'bruecke']);
export const STEUERN = Object.freeze({ start: ['start'], herunterfahren: ['shutdown'], ausschalten: ['destroy'], neustart: ['reboot'], pause: ['suspend'], fortsetzen: ['resume'] });

/** Neue VM prüfen. `host` = {cpus, ram_mb}; `isos` = erlaubte ISO-Pfade (aus den Freigaben). */
export function vmNormal(e, { host = { cpus: 4, ram_mb: 8192 }, isos = [], vorhanden = [] } = {}) {
  const name = String(e && e.name || '').trim().toLowerCase();
  if (!NAME.test(name)) throw fehler('Name: Kleinbuchstaben, Ziffern und -, höchstens 31 Zeichen (z. B. allinone)', 'name');
  if (vorhanden.includes(name)) throw new FahnasFehler('E_EXISTIERT', `Eine VM „${name}“ gibt es schon`, { feld: 'name' });
  const system = SYSTEME.includes(e.system) ? e.system : 'linux';
  const cpu = Number(e.cpu); const ram = Number(e.ram_mb); const platte = Number(e.platte_gb);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > host.cpus) throw fehler(`Prozessorkerne: 1 bis ${host.cpus}`, 'cpu');
  const ramMax = Math.max(512, host.ram_mb - 1024);
  if (!Number.isInteger(ram) || ram < 512 || ram > ramMax) throw fehler(`Arbeitsspeicher: 512 bis ${ramMax} MB (1 GB bleibt für das NAS)`, 'ram_mb');
  if (system === 'windows' && ram < 4096) throw fehler('Windows braucht mindestens 4096 MB Arbeitsspeicher', 'ram_mb');
  if (!Number.isInteger(platte) || platte < 4 || platte > 16384) throw fehler('Platte: 4 bis 16384 GB', 'platte_gb');
  if (system === 'windows' && platte < 64) throw fehler('Windows 11 braucht mindestens 64 GB Platte', 'platte_gb');
  const iso = e.iso ? String(e.iso) : '';
  if (iso && !isos.includes(iso)) throw fehler('Dieses ISO liegt in keiner Freigabe (oder gibt es nicht mehr)', 'iso');
  const netz = NETZE.includes(e.netz) ? e.netz : 'nat';
  const firmware = system === 'windows' ? 'uefi' : (e.firmware === 'bios' ? 'bios' : 'uefi');
  return { name, system, cpu, ram_mb: ram, platte_gb: platte, iso, netz, firmware, tpm: system === 'windows', autostart: !!e.autostart, titel: String(e.titel || '').trim().slice(0, 60) };
}

/** virt-install-Argumente. `plattePfad` = qcow2 im VM-Ordner, `schnittstelle` = LAN-Karte für die Brücke. */
export function virtInstallArgumente(v, { plattePfad, schnittstelle, osinfo }) {
  const win = v.system === 'windows';
  const a = ['--connect', 'qemu:///system', '--name', v.name, '--memory', String(v.ram_mb), '--vcpus', String(v.cpu), '--cpu', 'host-passthrough',
    '--disk', `path=${plattePfad},size=${v.platte_gb},format=qcow2,bus=${win ? 'sata' : 'virtio'},cache=none,discard=unmap`];
  if (v.iso) a.push('--cdrom', v.iso); else a.push('--import');
  a.push('--osinfo', osinfo || (win ? 'win11' : 'detect=on,require=off'));
  const modell = win ? 'e1000e' : 'virtio';
  a.push('--network', v.netz === 'bruecke' ? `type=direct,source=${schnittstelle},source_mode=bridge,model=${modell}` : `network=default,model=${modell}`);
  a.push('--graphics', 'vnc,listen=127.0.0.1', '--video', win ? 'qxl' : 'virtio');
  if (v.firmware === 'uefi') a.push('--boot', 'uefi');
  if (v.tpm) a.push('--tpm', 'emulator,model=tpm-crb,version=2.0');
  if (v.titel) a.push('--metadata', `title=${v.titel.replace(/[,"]/g, ' ')}`);
  a.push('--noautoconsole', '--wait', '0');
  return a;
}

/** `virsh dominfo` → {zustand, cpu, ram_mb, autostart, persistent}. */
export function dominfoParsen(text) {
  const w = {};
  for (const z of String(text || '').split('\n')) { const i = z.indexOf(':'); if (i > 0) w[z.slice(0, i).trim()] = z.slice(i + 1).trim(); }
  const kib = Number(String(w['Max memory'] || '').split(' ')[0]) || 0;
  return { zustand: w.State || 'unbekannt', cpu: Number(w['CPU(s)']) || 0, ram_mb: Math.round(kib / 1024), autostart: w.Autostart === 'enable', titel: w.Title || '' };
}

/** Zustand in die Ampelform der Oberfläche. */
export function zustandKurz(z) {
  if (/running/.test(z)) return 'laeuft';
  if (/paused/.test(z)) return 'pause';
  if (/shut off|shutoff/.test(z)) return 'aus';
  if (/crashed/.test(z)) return 'fehler';
  return 'unbekannt';
}

/** `virsh vncdisplay` („127.0.0.1:0“ oder „:3“) → TCP-Port 5900+n oder null. */
export function vncPort(text) {
  const m = /:(\d+)\s*$/.exec(String(text || '').trim());
  return m ? 5900 + Number(m[1]) : null;
}

/** `virsh domifaddr` → erste IPv4. */
export function ipAus(text) {
  const m = /ipv4\s+(\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(text || ''));
  return m ? m[1] : null;
}

/** `virsh domblklist --details` → Platten- und CD-Pfade. */
export function plattenParsen(text) {
  const aus = { platten: [], cd: null, cd_ziel: null };
  for (const z of String(text || '').split('\n').slice(2)) {
    const t = z.trim().split(/\s+/);
    if (t.length < 3) continue;
    const [, geraet, ziel, ...quelle] = t;
    const pfad = quelle.join(' ');
    if (geraet === 'cdrom') { aus.cd_ziel = ziel; aus.cd = pfad && pfad !== '-' ? pfad : null; } else if (geraet === 'disk' && pfad !== '-') aus.platten.push(pfad);
  }
  return aus;
}
