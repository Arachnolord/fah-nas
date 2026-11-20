#!/usr/bin/env node
// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Baut die Kartendaten der Weltkarte aus Natural Earth 1:50m Admin 0 (gemeinfrei) – einmal beim Entwickeln, beide
// Ergebnisse liegen im Git:
//   public/karte/welt.json – Länderumrisse (Vertrag Spec §4.4): ganze Zahlen in 1/100 Grad, erster Punkt absolut, dann
//                            Differenzen; Antarktis entfernt; Douglas-Peucker so fein, wie die 400-KB-Grenze erlaubt
//                            (statisch.js komprimiert nicht). Gemeinsame Grenzen werden EINMAL vereinfacht und in beiden
//                            Ländern mit denselben Stützpunkten gespeichert – sonst klaffen beim Zoomen Spalten.
//   geo/laender.json       – Landesmitten + deutsche Namen je ISO-alpha-2 (Spec §4.3) für die Länder-Ortssuche.
// Die Quelle wird einmal nach iso/cache/ geladen (gitignored) und danach von dort gelesen.
//   node tools/karte_bauen.mjs [--quelle <geojson>]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUELLE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
export const QUELLE_CACHE = path.join(WURZEL, 'iso', 'cache', 'ne_50m_admin_0_countries.geojson');
export const WELT_ZIEL = path.join(WURZEL, 'public', 'karte', 'welt.json');
export const LAENDER_ZIEL = path.join(WURZEL, 'geo', 'laender.json');
export const QUELLE_TEXT = 'Natural Earth 1:50m Admin 0 (gemeinfrei)';
export const Q = 100;                 // Koordinaten in 1/100 Grad (≈ 1,1 km am Äquator)
export const GRENZE_BYTE = 400_000;   // welt.json höchstens so groß
const TOLERANZ_START = 4;             // 0,04° – Vorgabe aus dem Plan; feiner nur, wenn die Grenze es zulässt
const TOLERANZ_MIN = 1;               // feiner als die Quantisierung (0,01°) bringt nichts

// --- reine Helfer (auch von tests/einheit/karte_daten.test.js benutzt) ---------------------------------------------

/** Quadrat des Abstands von Punkt p zur Strecke a–b (bei a = b: zum Punkt a). */
function abstand2(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = a[0] + t * dx - p[0]; const qy = a[1] + t * dy - p[1];
  return qx * qx + qy * qy;
}

/**
 * Douglas-Peucker mit festen Endpunkten (iterativ, keine Rekursionstiefe). Toleranz in den Einheiten der Punkte.
 * Geschlossene Linien (Anfang = Ende) gehen auch: dann zählt der Abstand zum Anfangspunkt, der entfernteste Punkt wird
 * zum ersten Anker.
 */
export function vereinfacheLinie(punkte, toleranz) {
  const n = punkte.length;
  if (n <= 2) return punkte.slice();
  const behalten = new Uint8Array(n);
  behalten[0] = 1; behalten[n - 1] = 1;
  const t2 = toleranz * toleranz;
  const stapel = [0, n - 1];
  while (stapel.length) {
    const b = stapel.pop(); const a = stapel.pop();
    let max = -1; let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = abstand2(punkte[i], punkte[a], punkte[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0 && max > t2) { behalten[idx] = 1; stapel.push(a, idx, idx, b); }
  }
  return punkte.filter((_, i) => behalten[i]);
}

/** Ring aus ganzen Zahlen → [x0, y0, dx1, dy1, …] (erster Punkt absolut, danach Differenzen; Vertrag §4.4). */
export function kodiereRing(punkte) {
  const aus = [punkte[0][0], punkte[0][1]];
  for (let i = 1; i < punkte.length; i++) aus.push(punkte[i][0] - punkte[i - 1][0], punkte[i][1] - punkte[i - 1][1]);
  return aus;
}

/**
 * Kennung eines Natural-Earth-Merkmals: ISO_A2, sonst ISO_A2_EH, sonst WB_A2 (Frankreich, Norwegen, Kosovo, Taiwan
 * stehen in ISO_A2 als „-99“ bzw. „CN-TW“). Ohne gültige alpha-2-Kennung (Somaliland, Nordzypern, Siachen) die
 * Ersatzkennung ADM0_A3 – das Gebiet bleibt auf der Karte (sonst Loch), kommt aber nicht in laender.json.
 * rang: 0 = ISO_A2 direkt, 1 = ISO_A2_EH, 2 = WB_A2, 3 = Ersatz (kleiner = Hauptteil beim Zusammenfassen).
 */
export function kennung(p) {
  const felder = [p.ISO_A2, p.ISO_A2_EH, p.WB_A2];
  for (let rang = 0; rang < felder.length; rang++) {
    if (typeof felder[rang] === 'string' && /^[A-Z]{2}$/.test(felder[rang])) return { iso: felder[rang], alpha2: true, rang };
  }
  const ersatz = String(p.ADM0_A3 || '');
  return /^[A-Z]{3}$/.test(ersatz) ? { iso: ersatz, alpha2: false, rang: 3 } : null;
}

const istAntarktis = (p) => p.ISO_A2 === 'AQ' || p.ADM0_A3 === 'ATA';
const flaeche = (ring) => { // doppelte Fläche (Gaußsche Trapezformel), Betrag
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s);
};

/** GeoJSON-Ring → offener Ring aus ganzen Zahlen ohne doppelte Nachbarpunkte (auch nicht über den Ringschluss). */
function quantisiereRing(ring) {
  const aus = [];
  for (const [lon, lat] of ring) {
    const p = [Math.round(lon * Q), Math.round(lat * Q)];
    const v = aus[aus.length - 1];
    if (!v || v[0] !== p[0] || v[1] !== p[1]) aus.push(p);
  }
  while (aus.length > 1 && aus[0][0] === aus[aus.length - 1][0] && aus[0][1] === aus[aus.length - 1][1]) aus.pop();
  return aus;
}

/** Doppelte Nachbarpunkte entfernen (zyklisch) – nach dem Vereinfachen können Hin-und-zurück-Zacken zusammenfallen. */
function entdoppeln(ring) {
  const aus = [];
  for (const p of ring) { const v = aus[aus.length - 1]; if (!v || v[0] !== p[0] || v[1] !== p[1]) aus.push(p); }
  while (aus.length > 1 && aus[0][0] === aus[aus.length - 1][0] && aus[0][1] === aus[aus.length - 1][1]) aus.pop();
  return aus;
}

// Punktschlüssel als Zahl (schneller als Zeichenketten): x ∈ [−18000, 18000], y ∈ [−9000, 9000]
const schluessel = (p) => (p[0] + 18000) * 20001 + (p[1] + 9000);

/**
 * Natural-Earth-GeoJSON → Länderliste mit Ringen in Bögen zerlegt (Topologie). Ein Bogen ist ein Stück Umriss zwischen
 * zwei Knoten; Knoten sind Punkte mit mehr als zwei verschiedenen Nachbarn über alle Ringe (Dreiländerecken, Übergang
 * Grenze → Küste). Zwei Länder mit gemeinsamer Grenze teilen sich so genau einen Bogen, der nur einmal vereinfacht wird.
 * Ringe ohne Knoten (Inseln, Enklaven) sind ein geschlossener Bogen ab ihrem kleinsten Punkt.
 */
export function zerlege(geojson) {
  const laender = new Map(); // iso → { iso, name, alpha2, haupt:{rang, flaeche, p}, ringe:[[p…]] }
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    if (istAntarktis(p)) continue;
    const k = kennung(p);
    if (!k) continue;
    const g = f.geometry || {};
    const polygone = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const ringe = polygone.flat(1).map(quantisiereRing).filter((r) => r.length >= 3);
    if (!ringe.length) continue;
    const gesamt = ringe.reduce((s, r) => s + flaeche(r), 0);
    const teil = { rang: k.rang, flaeche: gesamt, name: p.NAME_DE || p.NAME, p: [p.LABEL_X, p.LABEL_Y] };
    const l = laender.get(k.iso);
    if (!l) laender.set(k.iso, { iso: k.iso, alpha2: k.alpha2, haupt: teil, ringe });
    else { // mehrere Merkmale mit derselben Kennung (AU: Festland, Territorien im Indischen Ozean, Ashmore/Cartier)
      l.ringe.push(...ringe);
      if (teil.rang < l.haupt.rang || (teil.rang === l.haupt.rang && teil.flaeche > l.haupt.flaeche)) l.haupt = teil;
    }
  }

  // Nachbarn je Punkt über alle Ringe → Knoten
  const nachbarn = new Map();
  const merke = (a, b) => { let s = nachbarn.get(a); if (!s) nachbarn.set(a, s = new Set()); s.add(b); };
  for (const l of laender.values()) {
    for (const r of l.ringe) {
      for (let i = 0; i < r.length; i++) {
        const a = schluessel(r[i]); const b = schluessel(r[(i + 1) % r.length]);
        merke(a, b); merke(b, a);
      }
    }
  }
  const istKnoten = (p) => nachbarn.get(schluessel(p)).size > 2;

  // Ringe in Bögen zerlegen; gleiche Bögen (auch rückwärts) bekommen dieselbe Nummer
  const boegen = [];           // Nummer → Punktfolge in kanonischer Richtung
  const nummer = new Map();    // kanonische Schlüsselfolge → Nummer
  const bogenVon = (folge) => {
    const ks = folge.map(schluessel);
    const n = ks.length;
    // Kanonische Richtung: kleinerer Endpunkt zuerst; bei geschlossenen Bögen entscheidet der zweite Punkt.
    const rueck = ks[0] > ks[n - 1] || (ks[0] === ks[n - 1] && n > 2 && ks[1] > ks[n - 2]);
    const kanon = rueck ? [...ks].reverse() : ks;
    const id = kanon.join(',');
    let nr = nummer.get(id);
    if (nr === undefined) { nr = boegen.length; nummer.set(id, nr); boegen.push(rueck ? [...folge].reverse() : folge); }
    return { nr, rueck };
  };
  for (const l of laender.values()) {
    l.bogenRinge = l.ringe.map((r) => {
      let start = r.findIndex(istKnoten);
      if (start < 0) { // kein Knoten: ab dem kleinsten Punkt (für Enklave und umgebendes Land derselbe Anfang)
        start = 0;
        for (let i = 1; i < r.length; i++) if (schluessel(r[i]) < schluessel(r[start])) start = i;
      }
      const gedreht = [...r.slice(start), ...r.slice(0, start), r[start]]; // geschlossen, beginnt und endet am Knoten
      const teile = [];
      let anfang = 0;
      for (let i = 1; i < gedreht.length; i++) {
        if (i === gedreht.length - 1 || istKnoten(gedreht[i])) { teile.push(bogenVon(gedreht.slice(anfang, i + 1))); anfang = i; }
      }
      return teile;
    });
  }
  return { laender: [...laender.values()].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0)), boegen };
}

/** Ringe eines Landes aus den vereinfachten Bögen zusammensetzen; zu klein gewordene Ringe fallen weg. */
function setzeRinge(bogenRinge, einfach) {
  const ringe = [];
  for (const teile of bogenRinge) {
    const ring = [];
    for (const { nr, rueck } of teile) {
      const b = rueck ? [...einfach[nr]].reverse() : einfach[nr];
      for (let i = 0; i < b.length - 1; i++) ring.push(b[i]); // Endpunkt = Anfang des nächsten Bogens
    }
    const sauber = entdoppeln(ring);
    if (sauber.length >= 3) ringe.push(sauber);
  }
  return ringe;
}

/** welt.json-Inhalt (Objekt) für eine Toleranz in 1/100 Grad. */
export function baueWelt(zerlegt, toleranz) {
  const einfach = zerlegt.boegen.map((b) => vereinfacheLinie(b, toleranz));
  const laender = [];
  for (const l of zerlegt.laender) {
    let ringe = setzeRinge(l.bogenRinge, einfach);
    if (!ringe.length) { // Kleinststaat ganz weggefallen (Inselstaaten, Enklaven): größten Ring unvereinfacht behalten
      const groesster = l.ringe.reduce((a, b) => (flaeche(b) > flaeche(a) ? b : a));
      ringe = [groesster];
    }
    laender.push({
      iso: l.iso, name: l.haupt.name,
      p: [Math.round(l.haupt.p[0] * Q), Math.round(l.haupt.p[1] * Q)],
      r: ringe.map(kodiereRing),
    });
  }
  return { v: 1, quelle: QUELLE_TEXT, q: Q, laender };
}

/** laender.json-Inhalt: nur echte alpha-2-Kennungen, Mitte = Beschriftungspunkt des Hauptteils (auf 0,01° gerundet). */
export function baueLaender(zerlegt) {
  const laender = {};
  for (const l of zerlegt.laender) {
    if (!l.alpha2) continue;
    laender[l.iso] = { name: l.haupt.name, lat: Math.round(l.haupt.p[1] * 100) / 100, lon: Math.round(l.haupt.p[0] * 100) / 100 };
  }
  return { quelle: QUELLE_TEXT, laender };
}

/** laender.json lesbar: ein Land je Zeile (kleine Diffs im Git). */
export function laenderText(inhalt) {
  const zeilen = Object.entries(inhalt.laender).map(([iso, l]) => `    ${JSON.stringify(iso)}: ${JSON.stringify(l)}`);
  return `{\n  "quelle": ${JSON.stringify(inhalt.quelle)},\n  "laender": {\n${zeilen.join(',\n')}\n  }\n}\n`;
}

/**
 * Feinste Toleranz, bei der welt.json unter die Grenze passt: ab 0,04° in Schritten von 0,005° nach oben, bis es passt;
 * passt schon 0,04°, wird nach unten bis zur Quantisierung (0,01°) weiter verfeinert, solange es passt.
 */
export function feinsteWelt(zerlegt, grenze = GRENZE_BYTE) {
  const probe = (t) => { const w = baueWelt(zerlegt, t); const text = JSON.stringify(w); return { t, w, text, byte: Buffer.byteLength(text) }; };
  let bestes = null;
  let t = TOLERANZ_START;
  let r = probe(t);
  if (r.byte <= grenze) {
    bestes = r;
    for (t = TOLERANZ_START - 0.5; t >= TOLERANZ_MIN; t -= 0.5) { r = probe(t); if (r.byte > grenze) break; bestes = r; }
  } else {
    while (r.byte > grenze) { t += 0.5; if (t > 100) throw new Error('welt.json passt selbst bei 1° Toleranz nicht unter die Grenze'); r = probe(t); }
    bestes = r;
  }
  return bestes;
}

// --- Ausführung ---------------------------------------------------------------------------------------------------------

async function schreibeAtomar(ziel, text) {
  await fs.mkdir(path.dirname(ziel), { recursive: true });
  const tmp = `${ziel}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, ziel);
}

/** Quelle aus dem Zwischenspeicher oder einmal aus dem Netz (nach iso/cache/, atomar). */
export async function ladeQuelle(datei = QUELLE_CACHE, url = QUELLE_URL) {
  try { return JSON.parse(await fs.readFile(datei, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  console.log(`Lade ${url} …`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Natural Earth: HTTP ${res.status}`);
  const text = await res.text();
  const daten = JSON.parse(text);
  if (daten.type !== 'FeatureCollection' || !(daten.features?.length >= 200)) throw new Error('Natural Earth: unerwarteter Inhalt');
  await schreibeAtomar(datei, text);
  return daten;
}

async function hauptprogramm(argv) {
  let quelle = QUELLE_CACHE;
  let toleranz = null; // in Grad; null = feinste, die unter die Grenze passt
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--quelle') quelle = path.resolve(argv[++i]);
    else if (argv[i] === '--toleranz') {
      toleranz = Number(argv[++i]);
      if (!(toleranz > 0 && toleranz <= 1)) throw new Error('--toleranz erwartet Grad zwischen 0 und 1, z. B. 0.04');
    } else if (['-h', '--help', 'hilfe'].includes(argv[i])) { console.log('Aufruf: node tools/karte_bauen.mjs [--quelle <geojson>] [--toleranz <grad>]'); return; }
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  const zerlegt = zerlege(await ladeQuelle(quelle));
  let welt;
  if (toleranz === null) welt = feinsteWelt(zerlegt);
  else {
    const w = baueWelt(zerlegt, toleranz * Q); const text = JSON.stringify(w);
    welt = { t: toleranz * Q, w, text, byte: Buffer.byteLength(text) };
    if (welt.byte > GRENZE_BYTE) throw new Error(`welt.json wäre ${welt.byte} Byte groß (Grenze ${GRENZE_BYTE}) – Toleranz erhöhen`);
  }
  const punkte = welt.w.laender.reduce((s, l) => s + l.r.reduce((t, r) => t + r.length / 2, 0), 0);
  await schreibeAtomar(WELT_ZIEL, welt.text);
  const laender = baueLaender(zerlegt);
  await schreibeAtomar(LAENDER_ZIEL, laenderText(laender));
  console.log(`welt.json: ${welt.w.laender.length} Länder, ${punkte} Stützpunkte, Toleranz ${(welt.t / Q).toFixed(3)}°, ${welt.byte} Byte`);
  console.log(`laender.json: ${Object.keys(laender.laender).length} Länder`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  hauptprogramm(process.argv.slice(2)).catch((e) => { console.error(`karte_bauen: ${e.message}`); process.exit(1); });
}
