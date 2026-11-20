// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „vms.*“ (Teilprojekt 3): virtuelle Maschinen mit libvirt/KVM – anlegen (ISO aus einer Freigabe, Linux/
// Windows mit TPM und UEFI, NAT oder Brücke ins Heimnetz), starten/stoppen, ändern, löschen und die Konsole im Browser
// (noVNC über den Datenkanal: Ticket „tcp“ → VNC-Port der VM, nur 127.0.0.1). libvirt ist die Wahrheit über die VMs;
// ihre Platten liegen unter /data/vms/<name>/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import * as r from '../vms/regeln.js';

const VERBINDUNG = ['-c', 'qemu:///system'];
const ISO_TIEFE = 3;
const ISO_MAX = 200;
const TAKT_MS = 60_000;
const vmOrdner = (w) => (w.pfade && w.pfade.vms) || '/data/vms';

async function virsh(w, args, o = {}) { return w.system.ausfuehren('virsh', [...VERBINDUNG, ...args], { zeitlimit_ms: 60_000, ...o }); }
async function virshText(w, args) { try { return String((await virsh(w, args)).stdout || ''); } catch { return ''; } }
const S_NAME = { typ: 'string', pflicht: true, max: 31, muster: r.NAME, hinweis: 'Ungültiger VM-Name' };

/** Alle VMs mit Zustand, Kernen, Speicher, IP, Konsole, Platten. */
export async function vmListe(w) {
  let namen;
  try { namen = String((await virsh(w, ['list', '--all', '--name'])).stdout || '').split('\n').map((x) => x.trim()).filter(Boolean); } catch (e) {
    return { verfuegbar: false, grund: FahnasFehler.aus(e).details?.ausgabe?.trim().split('\n').pop() || 'libvirt antwortet nicht', vms: [] };
  }
  const vms = [];
  for (const name of namen.sort()) {
    const info = r.dominfoParsen(await virshText(w, ['dominfo', name]));
    const zustand = r.zustandKurz(info.zustand);
    const laeuft = zustand === 'laeuft' || zustand === 'pause';
    const blk = r.plattenParsen(await virshText(w, ['domblklist', name, '--details']));
    let ip = null;
    if (laeuft) ip = r.ipAus(await virshText(w, ['domifaddr', name, '--source', 'lease'])) || r.ipAus(await virshText(w, ['domifaddr', name, '--source', 'arp']));
    let platte_gb = null;
    // tatsächlich belegt (Blöcke), nicht die Endgröße der dünn bereitgestellten Platte
    for (const p of blk.platten) { try { const st = await fs.stat(p); platte_gb = Math.round(((st.blocks || 0) * 512) / 1024 ** 3 * 10) / 10; } catch { /* egal */ } break; }
    const titel = info.titel || (await virshText(w, ['desc', name, '--title'])).trim();
    vms.push({ name, titel, zustand, cpu: info.cpu, ram_mb: info.ram_mb, autostart: info.autostart, ip, cd: blk.cd, platte_belegt_gb: platte_gb, konsole: laeuft });
  }
  return { verfuegbar: true, vms };
}

/** ISO-Dateien in den Freigaben (bis 3 Ebenen tief) für die Auswahl. */
export async function isosFinden(w) {
  const d = await w.konfig.laden('shares.json', { freigaben: [] });
  const aus = [];
  const gehe = async (ordner, freigabe, rel, tiefe) => {
    if (aus.length >= ISO_MAX) return;
    let e; try { e = await fs.readdir(ordner, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (x.name.startsWith('.') || x.name.startsWith('@') || x.name.startsWith('#')) continue;
      const voll = path.join(ordner, x.name);
      if (x.isDirectory() && tiefe < ISO_TIEFE) await gehe(voll, freigabe, rel ? `${rel}/${x.name}` : x.name, tiefe + 1);
      else if (x.isFile() && /\.iso$/i.test(x.name)) { let g = 0; try { g = (await fs.stat(voll)).size; } catch { /* egal */ } aus.push({ pfad: voll, name: x.name, ort: `${freigabe}${rel ? `/${rel}` : ''}`, groesse: g }); }
      if (aus.length >= ISO_MAX) return;
    }
  };
  for (const f of (d && d.freigaben) || []) if (f && f.pfad) await gehe(f.pfad, f.name, '', 0);
  return aus.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}

/** Aussagekräftige Zeile aus der Ausgabe von virt-install (die ERROR-Zeile, nicht der Nachsatz). */
export function virtFehlerText(f) {
  const zeilen = String(f.details?.ausgabe || f.message || '').split('\n').map((z) => z.trim()).filter(Boolean);
  const e = zeilen.find((z) => /^ERROR\b/.test(z));
  return (e ? e.replace(/^ERROR\s+/, '') : zeilen.pop() || 'unbekannter Fehler').slice(0, 300);
}

function host() { return { cpus: os.cpus().length, ram_mb: Math.floor(os.totalmem() / 1024 ** 2) }; }

async function lanSchnittstelle(w) {
  try { return (JSON.parse((await w.system.ausfuehren('ip', ['-j', 'route', 'show', 'default'])).stdout || '[]')[0] || {}).dev || null; } catch { return null; }
}

export function registriere(reg, w) {
  reg.aktion('vms.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Virtuelle Maschinen mit Zustand',
    ausfuehren: async () => {
      let kvm = false; try { await fs.access('/dev/kvm'); kvm = true; } catch { /* keine Virtualisierung */ }
      return { ...(await vmListe(w)), kvm, host: host() };
    },
  });

  reg.aktion('vms.isos', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'ISO-Dateien in den Freigaben (für neue VMs)',
    ausfuehren: async () => isosFinden(w),
  });

  reg.aktion('vms.anlegen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Neue VM anlegen und starten',
    schema: { name: S_NAME, titel: { typ: 'string', max: 60 }, system: { typ: 'string', werte: [...r.SYSTEME] }, cpu: { typ: 'integer', pflicht: true }, ram_mb: { typ: 'integer', pflicht: true }, platte_gb: { typ: 'integer', pflicht: true }, iso: { typ: 'string', max: 4096 }, netz: { typ: 'string', werte: [...r.NETZE] }, firmware: { typ: 'string', werte: ['uefi', 'bios'] }, autostart: { typ: 'boolean' } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const liste = await vmListe(w);
      if (!liste.verfuegbar) throw new FahnasFehler('E_SYSTEM', `libvirt ist nicht bereit: ${liste.grund}`);
      const v = r.vmNormal(p, { host: host(), isos: (await isosFinden(w)).map((x) => x.pfad), vorhanden: liste.vms.map((x) => x.name) });
      aufgabe?.fortschritt(0.1, 'Ordner und Platte vorbereiten');
      const ordner = path.join(vmOrdner(w), v.name);
      await fs.mkdir(ordner, { recursive: true, mode: 0o711 });
      // qemu läuft als eigener Nutzer (libvirt-qemu): der VM-Ordner muss betretbar sein (nicht auflistbar)
      for (const o of [vmOrdner(w), ordner]) await fs.chmod(o, 0o711);
      try { await w.system.ausfuehren('chattr', ['+C', ordner]); } catch { /* nur btrfs: ohne Copy-on-Write ist die Platte schneller */ }
      const schnittstelle = v.netz === 'bruecke' ? await lanSchnittstelle(w) : null;
      if (v.netz === 'bruecke' && !schnittstelle) throw new FahnasFehler('E_SYSTEM', 'Keine Netzwerkkarte für die Brücke gefunden', { feld: 'netz' });
      aufgabe?.fortschritt(0.3, 'VM wird angelegt und gestartet');
      const versuche = v.system === 'windows' ? ['win11', 'win10', 'detect=on,require=off'] : ['detect=on,require=off'];
      let fehler = null;
      for (const osinfo of versuche) {
        try {
          await w.system.ausfuehren('virt-install', r.virtInstallArgumente(v, { plattePfad: path.join(ordner, 'platte.qcow2'), schnittstelle, osinfo }), { zeitlimit_ms: 10 * 60_000 });
          fehler = null; break;
        } catch (e) {
          fehler = FahnasFehler.aus(e);
          if (!/Unknown OS name|unknown OS/i.test(`${fehler.details?.ausgabe || ''} ${fehler.details?.grund || ''} ${fehler.message}`)) break;
        }
      }
      if (fehler) {
        for (const zusatz of [['--nvram', '--tpm'], ['--nvram'], []]) { try { await virsh(w, ['undefine', v.name, ...zusatz]); break; } catch { /* nicht angelegt */ } }
        try { await fs.rm(ordner, { recursive: true, force: true }); } catch { /* egal */ }
        throw new FahnasFehler('E_SYSTEM', `VM ließ sich nicht anlegen: ${virtFehlerText(fehler)}`, { ausgabe: fehler.details?.ausgabe });
      }
      if (v.autostart) { try { await virsh(w, ['autostart', v.name]); } catch { /* unten sichtbar */ } }
      w.konfigGeaendert?.('vms');
      aufgabe?.fortschritt(1, 'Fertig');
      return (await vmListe(w)).vms.find((x) => x.name === v.name) || { name: v.name };
    },
  });

  reg.aktion('vms.steuern', {
    rolle: 'admin', beschreibung: 'VM starten, herunterfahren, ausschalten, neu starten, pausieren, fortsetzen',
    schema: { name: S_NAME, aktion: { typ: 'string', pflicht: true, werte: Object.keys(r.STEUERN) } },
    ausfuehren: async (p) => {
      if (['herunterfahren', 'ausschalten'].includes(p.aktion)) vonHand.add(p.name); else if (['start', 'neustart', 'fortsetzen'].includes(p.aktion)) vonHand.delete(p.name);
      try { await virsh(w, [...r.STEUERN[p.aktion], p.name]); } catch (e) {
        const f = FahnasFehler.aus(e);
        throw new FahnasFehler('E_SYSTEM', `VM „${p.name}“: ${String(f.details?.ausgabe || f.message).trim().split('\n').filter(Boolean).pop()}`);
      }
      w.konfigGeaendert?.('vms');
      return (await vmListe(w)).vms.find((x) => x.name === p.name) || { name: p.name };
    },
  });

  reg.aktion('vms.aendern', {
    rolle: 'admin', beschreibung: 'Kerne, Speicher, Autostart oder eingelegtes ISO einer VM ändern',
    schema: { name: S_NAME, cpu: { typ: 'integer' }, ram_mb: { typ: 'integer' }, autostart: { typ: 'boolean' }, iso: { typ: 'string', max: 4096 } },
    ausfuehren: async (p) => {
      const vm = (await vmListe(w)).vms.find((x) => x.name === p.name);
      if (!vm) throw new FahnasFehler('E_NICHT_GEFUNDEN', `VM „${p.name}“ gibt es nicht`);
      const h = host();
      if ((p.cpu !== undefined && p.cpu !== vm.cpu) || (p.ram_mb !== undefined && p.ram_mb !== vm.ram_mb)) {
        if (vm.zustand !== 'aus') throw new FahnasFehler('E_PARAMS', 'Kerne und Speicher lassen sich nur bei ausgeschalteter VM ändern', { feld: 'cpu' });
        r.vmNormal({ name: 'pruefung', system: 'andere', cpu: p.cpu ?? vm.cpu, ram_mb: p.ram_mb ?? vm.ram_mb, platte_gb: 4 }, { host: h });
        if (p.cpu !== undefined) { await virsh(w, ['setvcpus', p.name, String(p.cpu), '--config', '--maximum']); await virsh(w, ['setvcpus', p.name, String(p.cpu), '--config']); }
        if (p.ram_mb !== undefined) { await virsh(w, ['setmaxmem', p.name, `${p.ram_mb}M`, '--config']); await virsh(w, ['setmem', p.name, `${p.ram_mb}M`, '--config']); }
      }
      if (typeof p.autostart === 'boolean') await virsh(w, p.autostart ? ['autostart', p.name] : ['autostart', '--disable', p.name]);
      if (p.iso !== undefined) {
        const blk = r.plattenParsen(await virshText(w, ['domblklist', p.name, '--details']));
        if (!blk.cd_ziel) throw new FahnasFehler('E_PARAMS', 'Diese VM hat kein CD-Laufwerk', { feld: 'iso' });
        const lebend = vm.zustand === 'laeuft' || vm.zustand === 'pause' ? ['--live'] : [];
        if (p.iso) {
          if (!(await isosFinden(w)).some((x) => x.pfad === p.iso)) throw new FahnasFehler('E_PARAMS', 'Dieses ISO liegt in keiner Freigabe', { feld: 'iso' });
          await virsh(w, ['change-media', p.name, blk.cd_ziel, p.iso, '--update', '--config', ...lebend]);
        } else await virsh(w, ['change-media', p.name, blk.cd_ziel, '--eject', '--config', ...lebend]);
      }
      w.konfigGeaendert?.('vms');
      return (await vmListe(w)).vms.find((x) => x.name === p.name);
    },
  });

  reg.aktion('vms.loeschen', {
    rolle: 'admin', beschreibung: 'VM samt Platte löschen',
    schema: { name: S_NAME },
    ausfuehren: async (p) => {
      const vm = (await vmListe(w)).vms.find((x) => x.name === p.name);
      if (!vm) throw new FahnasFehler('E_NICHT_GEFUNDEN', `VM „${p.name}“ gibt es nicht`);
      if (vm.zustand !== 'aus') { try { await virsh(w, ['destroy', p.name]); } catch { /* schon aus */ } }
      let weg = false;
      for (const zusatz of [['--nvram', '--tpm'], ['--nvram'], []]) { try { await virsh(w, ['undefine', p.name, ...zusatz]); weg = true; break; } catch { /* nächste Form */ } }
      if (!weg) throw new FahnasFehler('E_SYSTEM', `VM „${p.name}“ ließ sich nicht löschen`);
      const ordner = path.join(vmOrdner(w), p.name);
      if (ordner.startsWith(vmOrdner(w) + '/')) await fs.rm(ordner, { recursive: true, force: true });
      w.konfigGeaendert?.('vms');
      return { geloescht: p.name };
    },
  });

  reg.aktion('vms.konsole', {
    rolle: 'admin', beschreibung: 'Konsole einer laufenden VM im Browser öffnen (Einmal-Ticket für noVNC)',
    schema: { name: S_NAME },
    ausfuehren: async (p, k) => {
      await paketeSicherstellen(w.system, ['novnc'], { zweck: 'die VM-Konsole' });
      const port = r.vncPort(await virshText(w, ['vncdisplay', p.name]));
      if (!port) throw new FahnasFehler('E_PARAMS', `VM „${p.name}“ läuft nicht (oder hat keine Bildschirmausgabe)`, { feld: 'name' });
      return { ...w.datenkanal.ticket({ nutzer: k.nutzer, uid: 0, gid: 0, art: 'tcp', host: '127.0.0.1', port, pfad: '-', dateiname: `konsole-${p.name}` }), art: 'konsole' };
    },
  });
}

// ---- Takt: VMs mit Autostart, die nicht laufen ------------------------------------------------------------------------
let takt = null;
const schlecht = new Map();
const vonHand = new Set(); // von Hand ausgeschaltet → keine Meldung
export async function taktPruefen(w) {
  const l = await vmListe(w);
  if (!l.verfuegbar) return;
  for (const v of l.vms) {
    const problem = v.autostart && !vonHand.has(v.name) && (v.zustand === 'aus' || v.zustand === 'fehler');
    const z = schlecht.get(v.name) || 0;
    if (problem) {
      schlecht.set(v.name, z + 1);
      if (z + 1 === 2) await w.intern('benachrichtigungen.senden', { art: 'vms', stufe: 'fehler', titel: `VM „${v.name}“ läuft nicht`, text: `Die VM „${v.name}“ startet automatisch, ist aber ${v.zustand === 'fehler' ? 'abgestürzt' : 'aus'}. Unter VMs neu starten.`, schluessel: `vm_${v.name}` }).catch(() => {});
    } else {
      if (z >= 2) await w.intern('benachrichtigungen.senden', { art: 'vms', stufe: 'info', titel: `VM „${v.name}“ läuft wieder`, text: `Die VM „${v.name}“ läuft wieder.`, schluessel: `vm_${v.name}_ok_${Date.now()}` }).catch(() => {});
      schlecht.delete(v.name);
    }
  }
}
export async function starten(w) { takt = setInterval(() => { taktPruefen(w).catch(() => {}); }, TAKT_MS); takt.unref?.(); }
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
