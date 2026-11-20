// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Auswahl im Tabellen-Raster (Plan 06): Anker (die aktive Zelle) und Kopf (das bewegliche Ende) wie in Excel, Bewegen
// mit Pfeiltasten (Umschalt erweitert, Strg/⌘ springt an die Grenze des Datenblocks), Umwandlung in die Auswahl des
// Sync-Motors {blatt, von, bis} und Tastendrücke → Befehle des Editors. Ohne DOM.

import { GRENZEN, adresse, adresseLesen } from './formeln/adresse.js';

const SCHRITTE = Object.freeze({ hoch: ['z', -1], runter: ['z', 1], links: ['s', -1], rechts: ['s', 1] });
const PFEILE = Object.freeze({ ArrowUp: 'hoch', ArrowDown: 'runter', ArrowLeft: 'links', ArrowRight: 'rechts' });
/** Strg/⌘-Kürzel (Kleinbuchstabe) → Befehl; Strg+C/X/V fehlen absichtlich – sie laufen über die Zwischenablage-Ereignisse. */
const KUERZEL = Object.freeze({ y: 'vor', d: 'ausfuellen', b: 'fett', i: 'kursiv', a: 'alles' });

/** Neue Auswahl aus einer Zelle: {blatt, anker:{z,s}, kopf:{z,s}}. */
export function auswahlNeu(blatt, z = 1, s = 1) {
  return { blatt, anker: { z, s }, kopf: { z, s } };
}

/** Rechteck der Auswahl {z1, s1, z2, s2} (z1 ≤ z2, s1 ≤ s2). */
export function bereichVon(aw) {
  return { z1: Math.min(aw.anker.z, aw.kopf.z), s1: Math.min(aw.anker.s, aw.kopf.s), z2: Math.max(aw.anker.z, aw.kopf.z), s2: Math.max(aw.anker.s, aw.kopf.s) };
}

/** Auswahl für den Sync-Motor: {blatt, von, bis} mit von = oben links. */
export function alsSyncAuswahl(aw) {
  const b = bereichVon(aw);
  return { blatt: aw.blatt, von: adresse(b.z1, b.s1), bis: adresse(b.z2, b.s2) };
}

/** Auswahl aus dem Sync-Motor (z. B. von anderen) → Anker oben links, Kopf unten rechts; Unlesbares → null. */
export function ausSyncAuswahl(x) {
  if (!x || typeof x !== 'object') return null;
  const von = adresseLesen(x.von, { zeilen: Infinity, spalten: Infinity }), bis = adresseLesen(x.bis, { zeilen: Infinity, spalten: Infinity });
  if (!von || !bis || typeof x.blatt !== 'string') return null;
  return { blatt: x.blatt, anker: von, kopf: bis };
}

/** Strg+Pfeil: ist die Nachbarzelle belegt und die aktuelle auch, bis zur letzten belegten in Folge, sonst zur nächsten belegten, keine → Rand. */
function springen(start, feld, d, max, belegt) {
  const zelle = (i) => (feld === 'z' ? belegt(i, start.s) : belegt(start.z, i));
  const i0 = start[feld];
  if (i0 + d < 1 || i0 + d > max) return i0;
  if (zelle(i0) && zelle(i0 + d)) {
    let i = i0 + d;
    while (i + d >= 1 && i + d <= max && zelle(i + d)) i += d;
    return i;
  }
  for (let i = i0 + d; i >= 1 && i <= max; i += d) if (zelle(i)) return i;
  return d > 0 ? max : 1;
}

/**
 * Auswahl bewegen. Ohne Umschalt (erweitern) zieht die aktive Zelle (Anker) wie in Excel um und die Auswahl schrumpft auf
 * sie; mit Umschalt wandert nur der Kopf. springen = Strg/⌘ (belegt(z, s) sagt, ob eine Zelle Inhalt hat). Am Rand bleibt
 * die Auswahl stehen.
 */
export function bewegen(aw, richtung, { erweitern = false, springen: springe = false, belegt = () => false, max = GRENZEN } = {}) {
  const schritt = SCHRITTE[richtung];
  if (!schritt) return aw;
  const [feld, d] = schritt;
  const grenze = feld === 'z' ? max.zeilen : max.spalten;
  const start = erweitern ? aw.kopf : aw.anker;
  const i = springe ? springen(start, feld, d, grenze, belegt) : Math.min(Math.max(start[feld] + d, 1), grenze);
  const ziel = { ...start, [feld]: i };
  return erweitern ? { ...aw, kopf: ziel } : { ...aw, anker: ziel, kopf: { ...ziel } };
}

/**
 * Tastendruck → Befehl des Editors oder null (Browser-Standard). Strg = ctrlKey oder metaKey, aber nicht zusammen mit
 * Alt: Strg+Alt ist auf Windows AltGr und tippt Zeichen wie @ oder €. Beim Bearbeiten einer Zelle zählen nur Enter, Tab
 * und Escape; alles andere gehört dem Eingabefeld.
 */
export function tasteZuBefehl(e, { bearbeitet = false } = {}) {
  const key = typeof e?.key === 'string' ? e.key : '';
  const strg = (e.ctrlKey || e.metaKey) && !e.altKey;
  const zurueck = Boolean(e.shiftKey);
  if (key === 'Enter') return { befehl: 'enter', zurueck };
  if (key === 'Tab') return { befehl: 'tab', zurueck };
  if (bearbeitet) return key === 'Escape' ? { befehl: 'abbrechen' } : null;
  if (Object.hasOwn(PFEILE, key)) return { befehl: 'bewegen', richtung: PFEILE[key], erweitern: zurueck, springen: strg };
  if (key === 'F2') return { befehl: 'bearbeiten' };
  if (key === 'Delete' || key === 'Backspace') return { befehl: 'leeren' };
  if (strg) {
    const k = key.toLowerCase();
    if (k === 'z') return { befehl: zurueck ? 'vor' : 'zurueck' };
    return Object.hasOwn(KUERZEL, k) ? { befehl: KUERZEL[k] } : null;
  }
  return key.length === 1 && !e.metaKey ? { befehl: 'tippen' } : null;
}
