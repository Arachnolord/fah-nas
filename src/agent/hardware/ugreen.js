// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// UGREEN-DXP-Gehäuse (Betreiber 19.10.2026: „die LEDs und Lüfter sollten schon funktionieren“, DXP4800 Plus):
//
// LEDs: Controller (MCU HT32F52231) am SMBus-I801-Adapter, Adresse 0x3a. Protokoll nach miskcoo/ugreen_leds_controller
//   (MIT): I²C-Block-Schreiben von 12 Bytes auf „Befehl = LED-Nummer“: [id, a0, 01, 00, 00, op, p0, p1, p2, p3, sum_hi, sum_lo],
//   Summe über die ersten 10 Bytes mit 0 statt id; op 1 Helligkeit, 2 Farbe, 3 an/aus, 4 blinken, 5 atmen. Status: 11 Bytes
//   ab 0x81 + id. LEDs: 0 Betrieb, 1 Netz, 2… Platten. Geschrieben wird mit i2cset (i2c-tools), nur bei Zustandswechsel.
// Lüfter: ITE IT8613E (Super-I/O 0x2e, Umgebungs-Controller ab Basis 0x0a30), den der Kernel 7.0 noch nicht kennt – direkt
//   über /dev/port. Register wie frankcrawford/it87: Steuerung 0x15/0x16/0x17/0x7f/0xa7 (Bit 7 = Automatik), Tastgrad
//   0x63/0x6b/0x73/0x7b/0xa3 (nur im Handbetrieb schreibbar), Drehzahl 16 Bit (0x0d…/0x18…), rpm = 1 350 000 / (2 × Zählwert).
// Alles hier ist rein bzw. bekommt seine Ein-/Ausgabe übergeben – testbar ohne Hardware.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Modelle
// ---------------------------------------------------------------------------------------------------------------
/** Bekannte Gehäuse (DMI product_name). platten = Schächte mit LED, nvme = M.2-Plätze. */
export const MODELLE = Object.freeze([
  { muster: /^DXP4800\s*Plus$/i, name: 'UGREEN DXP4800 Plus', platten: 4 },
  { muster: /^DXP4800\s*Pro$/i, name: 'UGREEN DXP4800 Pro', platten: 4 },
  { muster: /^DXP4800$/i, name: 'UGREEN DXP4800', platten: 4 },
  { muster: /^DXP2800$/i, name: 'UGREEN DXP2800', platten: 2 },
  { muster: /^DXP6800\s*(Pro)?$/i, name: 'UGREEN DXP6800 Pro', platten: 6 },
  { muster: /^DXP8800\s*(Plus)?$/i, name: 'UGREEN DXP8800 Plus', platten: 8 },
]);

export function modellVon(produkt) {
  const p = String(produkt || '').trim();
  return MODELLE.find((m) => m.muster.test(p)) || null;
}

// ---------------------------------------------------------------------------------------------------------------
// LEDs
// ---------------------------------------------------------------------------------------------------------------
export const LED_ADRESSE = 0x3a;
export const LED = Object.freeze({ betrieb: 0, netz: 1, platte: (n) => 1 + n }); // platte(1) = 2
const OP = Object.freeze({ helligkeit: 1, farbe: 2, schalten: 3, blinken: 4, atmen: 5 });

/** 12-Byte-Befehl für eine LED (wie ugreen_leds_t::_change_status). */
export function ledBefehl(id, op, params = []) {
  const d = [0x00, 0xa0, 0x01, 0x00, 0x00, op, params[0] ?? 0, params[1] ?? 0, params[2] ?? 0, params[3] ?? 0];
  const summe = d.reduce((s, x) => s + (x & 0xff), 0);
  d.push((summe >> 8) & 0xff, summe & 0xff);
  d[0] = id & 0xff;
  return d;
}

/** Befehle für einen Soll-Zustand {an, farbe:[r,g,b], helligkeit, blinken:[an_ms, aus_ms]|null}. */
export function ledBefehle(id, soll) {
  if (!soll || !soll.an) return [ledBefehl(id, OP.schalten, [0])];
  const [r, g, b] = soll.farbe || [255, 255, 255];
  const aus = [ledBefehl(id, OP.farbe, [r, g, b]), ledBefehl(id, OP.helligkeit, [Math.max(1, Math.min(255, soll.helligkeit ?? 64))])];
  if (soll.blinken) {
    const [an, ausMs] = soll.blinken; const hoch = an + ausMs;
    aus.push(ledBefehl(id, OP.blinken, [(hoch >> 8) & 0xff, hoch & 0xff, (an >> 8) & 0xff, an & 0xff]));
  } else aus.push(ledBefehl(id, OP.schalten, [1]));
  return aus;
}

/** Status-Antwort (11 Bytes) prüfen und lesen → {modus, helligkeit, farbe, an_ms, aus_ms} oder null. */
export function ledStatusLesen(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 11) return null;
  const summe = bytes.slice(0, 9).reduce((s, x) => s + x, 0);
  if (summe === 0 || summe !== ((bytes[9] << 8) | bytes[10])) return null;
  const modus = ['aus', 'an', 'blinken', 'atmen'][bytes[0]];
  if (!modus) return null;
  const hoch = (bytes[5] << 8) | bytes[6]; const an = (bytes[7] << 8) | bytes[8];
  return { modus, helligkeit: bytes[1], farbe: [bytes[2], bytes[3], bytes[4]], an_ms: an, aus_ms: Math.max(0, hoch - an) };
}

/** i2cget-Ausgabe „0x01 0x3f …“ → Bytes. */
export function i2cAusgabeLesen(text) {
  return String(text || '').trim().split(/\s+/).filter((t) => /^0x[0-9a-f]{1,2}$/i.test(t)).map((t) => parseInt(t, 16));
}

/** SMBus-I801-Bus suchen (/sys/class/i2c-dev/i2c-N/device/name). → N oder null. */
export async function i2cBusFinden(wurzel = '/sys/class/i2c-dev') {
  let namen = [];
  try { namen = await fsp.readdir(wurzel); } catch { return null; }
  for (const n of namen.sort()) {
    const name = await fsp.readFile(path.join(wurzel, n, 'device', 'name'), 'utf8').catch(() => '');
    if (name.startsWith('SMBus I801 adapter')) { const m = /^i2c-(\d+)$/.exec(n); if (m) return Number(m[1]); }
  }
  return null;
}

/**
 * Soll-Zustand aller LEDs aus dem Gerätezustand. `zustand` = {netz:{verbunden, verkehr}, platten:[{vorhanden, aktiv,
 * fehler}|null …]}, `e` = Einstellungen {an, helligkeit, aktivitaet}. Farben: weiß; Plattenfehler rot.
 */
export function ledSoll(zustand, e) {
  const hell = Math.round(255 * Math.max(0.02, Math.min(1, (e.helligkeit ?? 25) / 100)));
  const weiss = [255, 255, 255]; const rot = [255, 0, 0];
  const aus = { betrieb: { an: !!e.an, farbe: weiss, helligkeit: hell, blinken: null } };
  const n = zustand.netz || {};
  aus.netz = { an: !!e.an && !!n.verbunden, farbe: weiss, helligkeit: hell, blinken: e.aktivitaet && n.verkehr ? [100, 100] : null };
  (zustand.platten || []).forEach((p, i) => {
    const schlecht = !!p?.fehler;
    aus[`platte${i + 1}`] = {
      an: !!e.an && !!p?.vorhanden, farbe: schlecht ? rot : weiss, helligkeit: hell,
      blinken: schlecht ? [500, 500] : (e.aktivitaet && p?.aktiv ? [60, 60] : null),
    };
  });
  return aus;
}

/** LED-Name → Nummer. */
export function ledNummer(name) {
  if (name === 'betrieb') return LED.betrieb;
  if (name === 'netz') return LED.netz;
  const m = /^platte(\d+)$/.exec(name);
  return m ? LED.platte(Number(m[1])) : null;
}

/** Platte (sdX) → Schacht über den ATA-Port (ataN → Schacht N, wie UGOS). */
export async function schachtVon(geraet, sysBlock = '/sys/block') {
  try { const ziel = await fsp.readlink(path.join(sysBlock, geraet)); const m = /\/ata(\d+)\//.exec(ziel); return m ? Number(m[1]) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Lüfter (IT8613E über /dev/port)
// ---------------------------------------------------------------------------------------------------------------
export const IT8613E = 0x8613;
const SIO_PORTS = [0x2e, 0x4e];
const LDN_EC = 0x04;
export const REG = Object.freeze({
  fanLo: [0x0d, 0x0e, 0x0f, 0x80, 0x82], fanHi: [0x18, 0x19, 0x1a, 0x81, 0x83], fan16: 0x0c,
  pwmCtrl: [0x15, 0x16, 0x17, 0x7f, 0xa7], pwmDuty: [0x63, 0x6b, 0x73, 0x7b, 0xa3],
});

/** Port-Zugriff über /dev/port (root, kein Kernel-Lockdown). Für Tests ersetzbar: {inb(port), outb(port, wert), schliessen()}. */
export function devPort(pfad = '/dev/port') {
  const fd = fs.openSync(pfad, 'r+');
  const b = Buffer.alloc(1);
  return {
    inb(port) { fs.readSync(fd, b, 0, 1, port); return b[0]; },
    outb(port, wert) { b[0] = wert & 0xff; fs.writeSync(fd, b, 0, 1, port); },
    schliessen() { try { fs.closeSync(fd); } catch { /* egal */ } },
  };
}

/** Kernel-Lockdown aktiv? (Secure Boot sperrt /dev/port) */
export async function lockdownAktiv(datei = '/sys/kernel/security/lockdown') {
  const t = await fsp.readFile(datei, 'utf8').catch(() => '');
  return /\[(integrity|confidentiality)\]/.test(t);
}

/** Super-I/O suchen: {sio, chip, basis} oder null. Verlässt den Konfigurationsmodus immer wieder. */
export function superIoFinden(io) {
  for (const sio of SIO_PORTS) {
    io.outb(sio, 0x87); io.outb(sio, 0x01); io.outb(sio, 0x55); io.outb(sio, sio === 0x4e ? 0xaa : 0x55);
    try {
      const lies = (reg) => { io.outb(sio, reg); return io.inb(sio + 1); };
      const chip = (lies(0x20) << 8) | lies(0x21);
      if (chip !== IT8613E) continue;
      io.outb(sio, 0x07); io.outb(sio + 1, LDN_EC);
      const aktiv = lies(0x30) & 0x01;
      const basis = ((lies(0x60) << 8) | lies(0x61)) & ~0x07;
      if (!aktiv || !basis) continue;
      return { sio, chip, basis };
    } finally { io.outb(sio, 0x02); io.outb(sio + 1, 0x02); }
  }
  return null;
}

/** Umgebungs-Controller ab `basis`: Adressregister basis+5, Daten basis+6. */
export function ec(io, basis) {
  return {
    lesen(reg) { io.outb(basis + 5, reg); return io.inb(basis + 6); },
    schreiben(reg, wert) { io.outb(basis + 5, reg); io.outb(basis + 6, wert & 0xff); },
  };
}

/** Zählerbreite 16 Bit sicherstellen (wie der it87-Treiber für Lüfter 1–3). */
export function sechzehnBit(e) {
  const r = e.lesen(REG.fan16);
  if ((r & 0x07) !== 0x07) e.schreiben(REG.fan16, r | 0x07);
}

export function drehzahl(e, i) {
  const z = e.lesen(REG.fanLo[i]) | (e.lesen(REG.fanHi[i]) << 8);
  return z === 0 || z === 0xffff ? 0 : Math.round(1_350_000 / (2 * z));
}

export function pwmLesen(e, i) { return { ctrl: e.lesen(REG.pwmCtrl[i]), duty: e.lesen(REG.pwmDuty[i]) }; }

/** Handbetrieb mit Tastgrad 0–255 (Bit 7 aus, Temperaturzuordnung bleibt). */
export function pwmSetzen(e, i, duty) {
  const ctrl = e.lesen(REG.pwmCtrl[i]);
  if (ctrl & 0x80) e.schreiben(REG.pwmCtrl[i], ctrl & 0x7f);
  e.schreiben(REG.pwmDuty[i], Math.max(0, Math.min(255, Math.round(duty))));
}

/** BIOS-Zustand zurückschreiben (erst Tastgrad im Handbetrieb, dann die ursprüngliche Steuerung). */
export function pwmZurueck(e, i, alt) {
  const ctrl = e.lesen(REG.pwmCtrl[i]);
  if (ctrl & 0x80) e.schreiben(REG.pwmCtrl[i], ctrl & 0x7f);
  e.schreiben(REG.pwmDuty[i], alt.duty);
  e.schreiben(REG.pwmCtrl[i], alt.ctrl);
}

// ---------------------------------------------------------------------------------------------------------------
// Regelung
// ---------------------------------------------------------------------------------------------------------------
export const MIN_TASTGRAD = 64; // 25 %
export const MODI = Object.freeze({
  // [Temperatur °C, Tastgrad] – dazwischen linear, darunter der erste, darüber 255
  leise: { platten: [[40, 64], [50, 255]], nvme: [[60, 64], [80, 255]], cpu: [[65, 64], [90, 255]] },
  normal: { platten: [[38, 77], [48, 255]], nvme: [[55, 77], [75, 255]], cpu: [[60, 77], [85, 255]] },
  leistung: { platten: [[35, 102], [45, 255]], nvme: [[50, 102], [70, 255]], cpu: [[55, 102], [80, 255]] },
});

function kurve(punkte, t) {
  if (!Number.isFinite(t)) return 0;
  if (t <= punkte[0][0]) return punkte[0][1];
  for (let i = 1; i < punkte.length; i++) {
    const [t0, d0] = punkte[i - 1]; const [t1, d1] = punkte[i];
    if (t <= t1) return d0 + ((d1 - d0) * (t - t0)) / (t1 - t0);
  }
  return 255;
}

/**
 * Ziel-Tastgrad aus Temperaturen {cpu, platten:[°C], nvme:[°C]} und Modus. Ohne lesbare CPU-Temperatur: 255 (sicher).
 * `vorher`: letzter Tastgrad – nach oben sofort, nach unten höchstens 10 je Takt (kein Pumpen).
 */
export function zielTastgrad(t, modus, vorher = null) {
  const k = MODI[modus] || MODI.normal;
  if (!Number.isFinite(t.cpu)) return 255;
  let ziel = kurve(k.cpu, t.cpu);
  for (const p of t.platten || []) ziel = Math.max(ziel, kurve(k.platten, p));
  for (const p of t.nvme || []) ziel = Math.max(ziel, kurve(k.nvme, p));
  ziel = Math.round(Math.max(MIN_TASTGRAD, Math.min(255, ziel)));
  if (Number.isFinite(vorher) && ziel < vorher) ziel = Math.max(ziel, vorher - 10);
  return ziel;
}

/** Temperaturen aus hwmon: coretemp (Paket), drivetemp (SATA), nvme. */
export async function temperaturen(wurzel = '/sys/class/hwmon') {
  const aus = { cpu: null, platten: [], nvme: [] };
  let namen = [];
  try { namen = await fsp.readdir(wurzel); } catch { return aus; }
  for (const n of namen) {
    const d = path.join(wurzel, n);
    const name = String(await fsp.readFile(path.join(d, 'name'), 'utf8').catch(() => '')).trim();
    const t1 = Number(String(await fsp.readFile(path.join(d, 'temp1_input'), 'utf8').catch(() => '')).trim()) / 1000;
    if (!Number.isFinite(t1) || t1 <= 0) continue;
    if (name === 'coretemp') aus.cpu = Math.max(aus.cpu ?? -Infinity, t1);
    else if (name === 'drivetemp') aus.platten.push(t1);
    else if (name === 'nvme') aus.nvme.push(t1);
  }
  return aus;
}
