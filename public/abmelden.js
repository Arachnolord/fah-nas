// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// „Automatisch abmelden“ (Betreiber 16.10.2026: „werde immer nach geraumer zeit ausgeloggt – das würde ich gerne einstellen
// können wann und überhaupt“): die Stufen des Reglers in „Mein Konto“ und ihre Texte, auch für die Dashboard-Kachel.
// Muss zu ABMELDEN_STUFEN in src/web/sitzungen.js passen (Minuten; null = Standard, 0 = nie).

export const ABMELDEN_STUFEN = Object.freeze([null, 15, 60, 240, 720, 1440, 10080, 43200, 0]);

/** Reglerstellung (0 … 8) zu einer gespeicherten Wahl; Unbekanntes → Standard. */
export function stufeVon(minuten) { const i = ABMELDEN_STUFEN.indexOf(minuten === undefined ? null : minuten); return i < 0 ? 0 : i; }

/** Kurzform für Kachel und Regler-Beschriftung: „Standard“, „15 Minuten“, …, „Nie“. */
export function abmeldenKurz(t, minuten) {
  if (minuten === null || minuten === undefined) return t('abmelden.kurz_standard');
  if (minuten === 0) return t('abmelden.kurz_nie');
  return t(`abmelden.dauer_${minuten}`);
}

/** Text zur Stellung (unter dem Regler und in der Kachel). */
export function abmeldenText(t, minuten) {
  if (minuten === null || minuten === undefined) return t('abmelden.text_standard');
  if (minuten === 0) return t('abmelden.text_nie');
  return t('abmelden.text_zeit', { dauer: t(`abmelden.nach_${minuten}`) });
}
