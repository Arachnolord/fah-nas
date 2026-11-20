// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat im Rahmen der Oberfläche (Plan 02): Ungelesen-Zahl am Navigationspunkt und im Tab-Titel, auch wenn die
// Chat-Ansicht nicht offen ist. Stumme Räume zählen mit – nur Ton, Browser- und Handy-Meldung schweigen dort.

const ENTPRELLEN_MS = 1000;

/** Geteilter Stand zwischen Chat-Ansicht und Rahmen: offener Raum (keine Meldung dafür) und Ton/Browser-Einstellungen. */
export const chatStand = { offenerRaum: null, einstellungen: null };

/** Summe der ungelesenen Nachrichten über alle Räume der Übersicht. */
export function ungelesenSumme(uebersicht) {
  const raeume = uebersicht && Array.isArray(uebersicht.raeume) ? uebersicht.raeume : [];
  return raeume.reduce((s, r) => s + (Number.isFinite(r && r.ungelesen) && r.ungelesen > 0 ? r.ungelesen : 0), 0);
}

/** Tab-Titel mit Zähler vorn: „(3) Titel“, ab 100 „(99+) Titel“, 0 lässt ihn unverändert. */
export function titelMitZaehler(titel, n) {
  if (!(n > 0)) return titel;
  return `(${n > 99 ? '99+' : n}) ${titel}`;
}

/**
 * Startet die Chat-Verbindung und hält Abzeichen und Tab-Titel aktuell: lädt chat.uebersicht, nach chat-Ereignissen
 * höchstens einmal je Sekunde neu und nach jedem Wiederverbinden. `hinweise.melden(nachricht, raum)` (optional) bekommt
 * neue Nachrichten anderer sofort.
 */
export async function chatRahmenStarten({ verbindung, nutzer, navigationAbzeichen, titelZaehlerSetzen, hinweise = null }) {
  let uebersicht = null; let timer = null; let gestoppt = false;
  const anzeigen = (n) => { navigationAbzeichen('chat', n); titelZaehlerSetzen(n); };

  async function aktualisieren() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    try {
      const u = await verbindung.aufrufen('chat.uebersicht', {});
      if (gestoppt) return;
      uebersicht = u;
      anzeigen(ungelesenSumme(u));
    } catch (e) {
      if (!gestoppt) console.warn('[chat] Übersicht nicht geladen:', e && (e.meldung || e.message));
    }
  }

  const spaeter = () => {
    if (timer !== null || gestoppt) return;
    timer = setTimeout(() => { timer = null; aktualisieren(); }, ENTPRELLEN_MS);
  };

  const abmelder = [
    verbindung.on('chat', (e) => {
      if (hinweise && e && e.ereignis === 'nachricht' && e.daten && e.daten.von !== (nutzer && nutzer.name)) {
        const raum = (uebersicht && Array.isArray(uebersicht.raeume) && uebersicht.raeume.find((r) => r.id === e.raum)) || { id: e.raum };
        try { hinweise.melden(e.daten, raum); } catch (f) { console.warn('[chat] Hinweis fehlgeschlagen:', f && f.message); }
      }
      spaeter();
    }),
    verbindung.on('wieder', () => { aktualisieren(); }),
  ];
  verbindung.starten();
  await aktualisieren();

  return {
    aktualisieren,
    stoppen() {
      gestoppt = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      for (const ab of abmelder) { try { ab(); } catch { /* egal */ } }
      if (typeof verbindung.stoppen === 'function') verbindung.stoppen();
      anzeigen(0);
    },
  };
}
