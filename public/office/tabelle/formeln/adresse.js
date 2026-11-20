// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zelladressen der Office-Tabelle (Plan 06): Spalten A…AMJ als Zahl und zurück, Adressen wie „B3“ und Bereiche wie
// „A1:C3“, dazu die Grenzen für Daten und Op-Parameter. Ohne DOM – der Web-Dienst lädt die Datei über den Sync-Typ.
// GRENZEN gilt nur fürs Anlegen und Prüfen, nie fürs Verschieben: nach dem Einfügen dürfen Zellen jenseits der Grenze
// liegen; wer solche Schlüssel lesen muss, gibt adresseLesen/bereichLesen eigene Grenzen mit.

export const GRENZEN = Object.freeze({
  zeilen: 100000, spalten: 1024, zellen_op: 50000, zellen_mappe: 200000, blaetter: 100,
  w: 32767, formel: 8192, name: 31, sortieren: 50000, json_import: 15728640,
});
/** Höchstwerte von Excel (XFD1048576): so weit liest der Lexer Bezüge, damit fremde Formeln lesbar bleiben. */
export const EXCEL_MAX = Object.freeze({ zeilen: 1048576, spalten: 16384 });

// Nur die kanonische Form: Großbuchstaben, Zeile ohne führende Null – sonst wären „b3“ und „B3“ zwei Zellen.
const ADRESSE = /^([A-Z]{1,7})([1-9]\d{0,14})$/;

/** Spaltennummer (1-basiert) → Buchstaben: 1 → A, 27 → AA, 1024 → AMJ. */
export function spalteZuText(n) {
  let text = '';
  for (let rest = Math.floor(n); rest > 0; rest = Math.floor((rest - 1) / 26)) text = String.fromCharCode(65 + ((rest - 1) % 26)) + text;
  return text;
}

/** Buchstaben → Spaltennummer, Groß/Klein egal; ungültig → 0. */
export function textZuSpalte(s) {
  if (typeof s !== 'string' || !/^[A-Za-z]{1,7}$/.test(s)) return 0;
  let n = 0;
  for (const zeichen of s.toUpperCase()) n = n * 26 + (zeichen.charCodeAt(0) - 64);
  return n;
}

/** „B3“ → {z: 3, s: 2}; ohne $, nur innerhalb der Grenzen (Standard GRENZEN), sonst null. */
export function adresseLesen(s, grenzen = GRENZEN) {
  const m = typeof s === 'string' ? ADRESSE.exec(s) : null;
  if (!m) return null;
  const z = Number(m[2]), sp = textZuSpalte(m[1]);
  return z <= grenzen.zeilen && sp <= grenzen.spalten ? { z, s: sp } : null;
}

/** {z, s} → „B3“. */
export function adresse(z, s) { return spalteZuText(s) + z; }

/** „C3:A1“ → {z1: 1, s1: 1, z2: 3, s2: 3} (normalisiert); eine einzelne Adresse ist ein Bereich aus einer Zelle. */
export function bereichLesen(s, grenzen = GRENZEN) {
  if (typeof s !== 'string') return null;
  const teile = s.split(':');
  if (teile.length > 2) return null;
  const a = adresseLesen(teile[0], grenzen), b = teile.length === 2 ? adresseLesen(teile[1], grenzen) : a;
  if (!a || !b) return null;
  return { z1: Math.min(a.z, b.z), s1: Math.min(a.s, b.s), z2: Math.max(a.z, b.z), s2: Math.max(a.s, b.s) };
}

/** {z1, s1, z2, s2} → „A1:C3“, eine Zelle → „B2“. */
export function bereichText({ z1, s1, z2, s2 }) {
  const von = adresse(z1, s1), bis = adresse(z2, s2);
  return von === bis ? von : `${von}:${bis}`;
}
