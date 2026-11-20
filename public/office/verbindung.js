// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Verbindung (Plan 04): derselbe JSON-WebSocket-Klient wie im Chat (Wiederverbinden, Status, senden, on), nur
// zu /api/office/ws. Endgültig ist allein 4001 (abgemeldet); das „sichtbar“ der Chat-Klasse übergeht der Office-Dienst.

import { ChatVerbindung } from '../chat/verbindung.js';

let einzelstueck = null;

/** Die eine Office-Verbindung des Tabs (alle offenen Dokumente teilen sie). */
export function officeVerbindung() {
  if (!einzelstueck) {
    einzelstueck = new ChatVerbindung({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/office/ws`, endgueltig: [4001] });
  }
  return einzelstueck;
}
