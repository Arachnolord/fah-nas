// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bezüge verschieben wie Excel (Plan 06). Zwei Fälle:
// - Struktur: Zeilen/Spalten werden eingefügt oder gelöscht. Betroffen sind nur Bezüge auf dieses Blatt, auch absolute
//   ($A$5 rückt mit). Ein Bereich wächst, wenn innen eingefügt wird, und schrumpft beim Löschen; ist alles weg, wird der
//   Bezug zu #REF! (die Blattvorsilbe fällt weg). Am Rand von Excel (Zeile 1 048 576, Spalte XFD) bleibt ein
//   Bereichsende stehen, ein Einzelbezug oder Bereichsanfang, der darüber hinaus rückte, wird #REF!.
// - Kopieren/Ausfüllen: relative Teile wandern um dz/ds, absolute bleiben; ein Teil, der vor A1 oder hinter den Rand
//   fiele, macht den ganzen Bezug zu #REF!.
// Unbetroffene Tokens bleiben zeichengleich, ein geänderter Bezug behält seine Blattvorsilbe wie geschrieben. Dieselben
// Regeln laufen im Browser und im Web-Dienst (über den Sync-Typ), damit alle Beteiligten gleich verschieben. Ohne DOM.

import { EXCEL_MAX } from './adresse.js';
import { zerlegen, tokensText, bezugText } from './lexer.js';

/** Index (Zeile oder Spalte) nach Einfügen/Löschen; null = gelöscht. */
export function indexVerschieben(i, { art, ab, anzahl }) {
  if (art === 'einfuegen') return i >= ab ? i + anzahl : i;
  if (art === 'loeschen') return i < ab ? i : (i <= ab + anzahl - 1 ? null : i - anzahl);
  return i;
}

/** Spanne von..bis (von ≤ bis) nach Einfügen/Löschen; null = ganz gelöscht. */
export function spanneVerschieben(von, bis, { art, ab, anzahl }) {
  if (art === 'einfuegen') {
    if (von >= ab) return [von + anzahl, bis + anzahl];
    return ab <= bis ? [von, bis + anzahl] : [von, bis];
  }
  if (art !== 'loeschen') return [von, bis];
  const e = ab + anzahl - 1;
  if (von >= ab && bis <= e) return null;
  return [von < ab ? von : (von > e ? von - anzahl : ab), bis < ab ? bis : (bis > e ? bis - anzahl : ab - 1)];
}

const refToken = (modus) => { const text = modus === 'anzeige' ? '#BEZUG!' : '#REF!'; return { art: 'fehler', text, wert: '#REF!' }; };

/** Bezug mit neuen Teilen; die Blattvorsilbe bleibt wie geschrieben (Quotes, Groß/Klein), nur die Adresse wird neu. */
function mitTeilen(t, von, bis, modus) {
  const vorsilbe = t.blatt === null ? '' : t.text.slice(0, t.text.lastIndexOf('!') + 1);
  return { ...t, von, bis, text: vorsilbe + bezugText({ blatt: null, von, bis }, modus) };
}

/** Ein Bezug-Token gegen Einfügen/Löschen auf der Achse feld ('z' oder 's'). */
function bezugStruktur(t, feld, op, max) {
  const abs = feld === 'z' ? 'zAbs' : 'sAbs';
  if (t.bis === null) {
    const n = indexVerschieben(t.von[feld], op);
    if (n === t.von[feld]) return t;
    return n === null || n > max ? refToken('intern') : mitTeilen(t, { ...t.von, [feld]: n }, null, 'intern');
  }
  // Bereich: auf dieser Achse erst ordnen (jeder Wert nimmt sein $ mit), dann als Spanne verschieben.
  const [unten, oben] = t.von[feld] <= t.bis[feld] ? [t.von, t.bis] : [t.bis, t.von];
  const r = spanneVerschieben(unten[feld], oben[feld], op);
  if (r === null || r[0] > max) return refToken('intern');
  const a = r[0], b = Math.min(r[1], max);
  if (a === unten[feld] && b === oben[feld]) return t;
  return mitTeilen(t, { ...t.von, [feld]: a, [abs]: unten[abs] }, { ...t.bis, [feld]: b, [abs]: oben[abs] }, 'intern');
}

/**
 * Formel (intern, ohne „=“) nach Einfügen/Löschen von Zeilen oder Spalten auf Blatt `blatt`. Bezüge ohne Blattvorsilbe
 * gehören zu `eigenesBlatt` (dem Blatt der Zelle). Unverändert, wenn nichts betroffen ist.
 */
export function strukturVerschieben(formel, { eigenesBlatt, blatt, achse, art, ab, anzahl }) {
  const op = { art, ab, anzahl };
  const feld = achse === 'spalten' ? 's' : 'z';
  const max = achse === 'spalten' ? EXCEL_MAX.spalten : EXCEL_MAX.zeilen;
  const tokens = zerlegen(formel, 'intern');
  let geaendert = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    // Ganze Spalten (A:A) betrifft das Zeilen-Einfügen nicht, ganze Zeilen (2:4) nicht das Spalten-Einfügen.
    if (t.art !== 'bezug' || (t.blatt ?? eigenesBlatt) !== blatt || t.von[feld] === null) continue;
    const neu = bezugStruktur(t, feld, op, max);
    if (neu !== t) { tokens[k] = neu; geaendert = true; }
  }
  return geaendert ? tokensText(tokens) : formel;
}

/** Ein Bezugsteil beim Kopieren um dz/ds; null, wenn er vor A1 oder hinter den Rand fiele. */
function teilKopieren(t, dz, ds) {
  const z = t.z === null || t.zAbs ? t.z : t.z + dz;
  const s = t.s === null || t.sAbs ? t.s : t.s + ds;
  if ((z !== null && (z < 1 || z > EXCEL_MAX.zeilen)) || (s !== null && (s < 1 || s > EXCEL_MAX.spalten))) return null;
  return { z, s, zAbs: t.zAbs, sAbs: t.sAbs };
}

/** Formel beim Kopieren/Ausfüllen um dz Zeilen und ds Spalten versetzen (relative Teile wandern, absolute bleiben). */
export function formelVerschieben(formel, dz, ds, modus = 'intern') {
  const tokens = zerlegen(formel, modus);
  let geaendert = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.art !== 'bezug') continue;
    const von = teilKopieren(t.von, dz, ds), bis = t.bis === null ? null : teilKopieren(t.bis, dz, ds);
    if (von === null || (t.bis !== null && bis === null)) { tokens[k] = refToken(modus); geaendert = true; continue; }
    if (von.z === t.von.z && von.s === t.von.s && (bis === null || (bis.z === t.bis.z && bis.s === t.bis.s))) continue;
    tokens[k] = mitTeilen(t, von, bis, modus); geaendert = true;
  }
  return geaendert ? tokensText(tokens) : formel;
}
