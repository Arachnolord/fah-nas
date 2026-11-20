// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Messwerte im 1-Sekunden-Takt: CPU (/proc/stat), RAM (/proc/meminfo), Platten (statfs / und /data), Netz
// (/proc/net/dev ohne lo), Temperatur (/sys/class/thermal, x86_pkg_temp bevorzugt; hwmon als Rückfall),
// Laufzeit. Ringpuffer 600 Einträge (10 min). Auf Systemen ohne /proc (macOS) greifen Rückfälle über node:os.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const RINGGROESSE = 600;

async function lesen(p) { try { return await fs.readFile(p, 'utf8'); } catch { return null; } }

/** CPU-Zeiten aus /proc/stat (erste Zeile) oder os.cpus(). */
export function cpuZeiten(statText) {
  if (statText) {
    const zeile = statText.split('\n').find((z) => z.startsWith('cpu '));
    if (zeile) {
      const w = zeile.trim().split(/\s+/).slice(1).map(Number);
      const gesamt = w.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      const leer = (w[3] || 0) + (w[4] || 0); // idle + iowait
      return { gesamt, leer };
    }
  }
  let gesamt = 0; let leer = 0;
  for (const c of os.cpus()) { const t = c.times; gesamt += t.user + t.nice + t.sys + t.idle + t.irq; leer += t.idle; }
  return { gesamt, leer };
}

/** CPU-Zeiten je Kern aus /proc/stat (Zeilen cpu0, cpu1, …) – leer ohne Datei. */
export function kernZeiten(statText) {
  if (!statText) return [];
  return statText.split('\n').filter((z) => /^cpu\d+ /.test(z)).map((z) => {
    const w = z.trim().split(/\s+/).slice(1).map(Number);
    return { gesamt: w.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0), leer: (w[3] || 0) + (w[4] || 0) };
  });
}

/**
 * Prozessor einmal lesen (Betreiber 12.10.2026: „bei prozessor … immer der hersteller … sowie die kerne“):
 * Modell aufgeräumt („Intel Core i5-6500T @ 2.50GHz“), Hersteller, physische Kerne und Threads.
 */
export function prozessorInfo(cpuinfoText) {
  const roh = (os.cpus()[0] || {}).model || '';
  const modell = roh.replace(/\((R|TM|tm|r)\)/g, '').replace(/\bCPU\b/g, '').replace(/\s+/g, ' ').trim();
  const hersteller = /intel/i.test(roh) ? 'Intel' : /amd|ryzen|epyc/i.test(roh) ? 'AMD' : /arm|cortex|apple/i.test(roh) ? 'ARM' : (modell.split(' ')[0] || '');
  const threads = os.cpus().length;
  let kerne = null;
  if (cpuinfoText) {
    const paare = new Set();
    let phys = '0';
    for (const z of cpuinfoText.split('\n')) {
      const p = /^physical id\s*:\s*(\d+)/.exec(z); if (p) phys = p[1];
      const c = /^core id\s*:\s*(\d+)/.exec(z); if (c) paare.add(`${phys}:${c[1]}`);
    }
    if (paare.size) kerne = paare.size;
  }
  return { modell, hersteller, kerne: kerne || threads, threads };
}

/** RAM aus /proc/meminfo (kB) oder os. */
export function ramWerte(meminfoText) {
  if (meminfoText) {
    const wert = (name) => { const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfoText); return m ? Number(m[1]) * 1024 : null; };
    const gesamt = wert('MemTotal'); const verfuegbar = wert('MemAvailable');
    if (gesamt && verfuegbar !== null) return { gesamt, verfuegbar, prozent: Math.round((1 - verfuegbar / gesamt) * 1000) / 10 };
  }
  const gesamt = os.totalmem(); const verfuegbar = os.freemem();
  return { gesamt, verfuegbar, prozent: Math.round((1 - verfuegbar / gesamt) * 1000) / 10 };
}

/** Summen rx/tx aus /proc/net/dev ohne lo; null ohne Datei. */
export function netzSummen(netdevText) {
  if (!netdevText) return null;
  let rx = 0; let tx = 0; let gefunden = false;
  for (const zeile of netdevText.split('\n').slice(2)) {
    const i = zeile.indexOf(':');
    if (i < 0) continue;
    const name = zeile.slice(0, i).trim();
    if (name === 'lo') continue;
    const f = zeile.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    rx += f[0] || 0; tx += f[8] || 0; gefunden = true;
  }
  return gefunden ? { rx, tx } : null;
}

export class Messwerte extends EventEmitter {
  /**
   * @param {{intervall_ms?:number, groesse?:number, proc?:string, sys?:string, platten?:Array<{pfad:string,name:string}>}} o
   */
  constructor({ intervall_ms = 1000, groesse = RINGGROESSE, proc = '/proc', sys = '/sys', platten = [{ pfad: '/', name: 'system' }, { pfad: '/data', name: 'daten' }] } = {}) {
    super();
    this.intervall_ms = intervall_ms; this.groesse = groesse; this.proc = proc; this.sys = sys; this.platten = platten;
    this.puffer = []; this.timer = null; this.laeuft = false;
    this.vorher = null; // {zeit, cpu:{gesamt,leer}, netz:{rx,tx}}
    this.aktuell = null;
    this.temperaturQuelle = undefined; // gemerkter Pfad, damit nicht jede Sekunde gesucht wird
  }

  async _temperatur() {
    if (this.temperaturQuelle === null) return null;
    if (this.temperaturQuelle) {
      const t = await lesen(this.temperaturQuelle);
      if (t !== null) { const n = Number(t.trim()); return Number.isFinite(n) ? Math.round(n / 100) / 10 : null; }
      this.temperaturQuelle = undefined; // Quelle weg – neu suchen
    }
    // thermal_zone*: type + temp, x86_pkg_temp bevorzugt
    try {
      const thermal = path.join(this.sys, 'class', 'thermal');
      const zonen = (await fs.readdir(thermal)).filter((d) => d.startsWith('thermal_zone')).sort();
      let erste = null;
      for (const z of zonen) {
        const typ = (await lesen(path.join(thermal, z, 'type')) || '').trim();
        const tempPfad = path.join(thermal, z, 'temp');
        const t = await lesen(tempPfad);
        if (t === null || !Number.isFinite(Number(t.trim()))) continue;
        if (typ === 'x86_pkg_temp') { this.temperaturQuelle = tempPfad; return Math.round(Number(t.trim()) / 100) / 10; }
        if (!erste) erste = { pfad: tempPfad, wert: Number(t.trim()) };
      }
      if (erste) { this.temperaturQuelle = erste.pfad; return Math.round(erste.wert / 100) / 10; }
    } catch { /* kein thermal */ }
    // hwmon-Rückfall: erstes temp1_input
    try {
      const hwmon = path.join(this.sys, 'class', 'hwmon');
      for (const h of (await fs.readdir(hwmon)).sort()) {
        const p = path.join(hwmon, h, 'temp1_input');
        const t = await lesen(p);
        if (t !== null && Number.isFinite(Number(t.trim()))) { this.temperaturQuelle = p; return Math.round(Number(t.trim()) / 100) / 10; }
      }
    } catch { /* kein hwmon */ }
    this.temperaturQuelle = null;
    return null;
  }

  async _platten() {
    const aus = [];
    for (const { pfad, name } of this.platten) {
      try {
        const st = await fs.statfs(pfad);
        const gesamt = Number(st.blocks) * Number(st.bsize);
        const frei = Number(st.bavail) * Number(st.bsize);
        if (!Number.isFinite(gesamt) || gesamt <= 0) continue;
        aus.push({ pfad, name, gesamt, frei, prozent: Math.round((1 - frei / gesamt) * 1000) / 10 });
      } catch { /* Pfad fehlt (Entwicklung) */ }
    }
    return aus;
  }

  /** Eine Messung; hängt sie an den Ringpuffer und meldet „messwerte“. */
  async messen() {
    if (this.laeuft) return this.aktuell;
    this.laeuft = true;
    try {
      const jetzt = Date.now();
      const [stat, meminfo, netdev, platten, temperatur] = await Promise.all([
        lesen(path.join(this.proc, 'stat')), lesen(path.join(this.proc, 'meminfo')), lesen(path.join(this.proc, 'net', 'dev')), this._platten(), this._temperatur(),
      ]);
      const cpu = cpuZeiten(stat);
      const kerne = kernZeiten(stat);
      if (!this.prozessor) this.prozessor = prozessorInfo(await lesen(path.join(this.proc, 'cpuinfo')));
      const netz = netzSummen(netdev);
      let cpuProzent = 0; let netzRate = { rx_bs: 0, tx_bs: 0 };
      if (this.vorher) {
        const dGesamt = cpu.gesamt - this.vorher.cpu.gesamt; const dLeer = cpu.leer - this.vorher.cpu.leer;
        if (dGesamt > 0) cpuProzent = Math.max(0, Math.min(100, Math.round((1 - dLeer / dGesamt) * 1000) / 10));
        const dt = (jetzt - this.vorher.zeit) / 1000;
        if (netz && this.vorher.netz && dt > 0) {
          netzRate = { rx_bs: Math.max(0, Math.round((netz.rx - this.vorher.netz.rx) / dt)), tx_bs: Math.max(0, Math.round((netz.tx - this.vorher.netz.tx) / dt)) };
        }
      }
      const jeKern = this.vorher && this.vorher.kerne ? kerne.map((k, i) => {
        const v = this.vorher.kerne[i]; if (!v) return null;
        const dg = k.gesamt - v.gesamt; const dl = k.leer - v.leer;
        return dg > 0 ? Math.max(0, Math.min(100, Math.round((1 - dl / dg) * 100))) : 0;
      }) : kerne.map(() => null);
      this.vorher = { zeit: jetzt, cpu, netz, kerne };
      const m = {
        zeit: new Date(jetzt).toISOString(),
        cpu: { prozent: cpuProzent, kerne: os.cpus().length, je_kern: jeKern, modell: this.prozessor.modell, hersteller: this.prozessor.hersteller, kerne_physisch: this.prozessor.kerne, threads: this.prozessor.threads },
        ram: ramWerte(meminfo),
        platten,
        netz: { ...netzRate, verfuegbar: netz !== null },
        temperatur,
        laufzeit_s: Math.round(os.uptime()),
      };
      this.aktuell = m;
      this.puffer.push(m);
      if (this.puffer.length > this.groesse) this.puffer.splice(0, this.puffer.length - this.groesse);
      this.emit('messwerte', m);
      return m;
    } finally { this.laeuft = false; }
  }

  verlauf() { return this.puffer.slice(); }

  starten() {
    if (this.timer) return;
    this.messen().catch(() => {});
    this.timer = setInterval(() => { this.messen().catch(() => {}); }, this.intervall_ms);
    this.timer.unref();
  }

  stoppen() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
