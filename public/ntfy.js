// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ntfy-Hilfen der Oberfläche (V9): ein schwer zu erratendes Thema für Handy-Meldungen – systemweit (System →
// Benachrichtigungen) und persönlich (Chat → Handy-Meldungen).

/** Schwer zu erratendes ntfy-Thema (Betreiber 16.10.2026: Eingabe war „total komplex“ – FAH-NAS denkt es sich selbst aus). */
export function ntfyThemaNeu() {
  const zeichen = 'abcdefghijkmnpqrstuvwxyz23456789';
  const z = new Uint8Array(12); crypto.getRandomValues(z);
  return `fah-nas-${[...z].map((b) => zeichen[b % zeichen.length]).join('')}`;
}
