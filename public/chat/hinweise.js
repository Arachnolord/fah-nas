// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Hinweise auf neue Chat-Nachrichten im Browser (Plan 02): kurzer Ton und – wenn erlaubt – eine Browser-Meldung.
// Wer gerade in den offenen Raum schaut, wird nicht gestört; stumme Räume schweigen ganz. Die Meldung nennt nur, wer
// geschrieben hat – nie den Text (wie die Handy-Meldung).

/**
 * Was zu tun ist: eigene oder stumme → nichts; Tab sichtbar und Raum offen → nichts; Tab sichtbar, anderer Raum → nur
 * Ton; Tab versteckt → Ton und Meldung (Meldung nur mit `browser` und erteilter Erlaubnis).
 */
export function sollMelden({ eigen, sichtbar, raumOffen, stumm, ton, browser, erlaubt }) {
  if (eigen || stumm) return { ton: false, meldung: false };
  if (sichtbar && raumOffen) return { ton: false, meldung: false };
  if (sichtbar) return { ton: !!ton, meldung: false };
  return { ton: !!ton, meldung: !!browser && erlaubt === 'granted' };
}

let audio = null;

/** Zwei kurze Sinustöne (660 und 880 Hz, je 90 ms); ohne WebAudio still. */
export function tonSpielen() {
  try {
    const Klasse = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Klasse) return;
    if (!audio) audio = new Klasse();
    if (audio.state === 'suspended' && typeof audio.resume === 'function') audio.resume().catch(() => {});
    const jetzt = audio.currentTime;
    [660, 880].forEach((hz, i) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      const start = jetzt + i * 0.1; const ende = start + 0.09;
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ende);
      o.connect(g); g.connect(audio.destination);
      o.start(start); o.stop(ende);
    });
  } catch { /* ohne Ton */ }
}

/** Browser-Meldung (nur mit erteilter Erlaubnis); ein Klick holt das Fenster nach vorn. */
export function browserMeldung({ titel, text, beiKlick }) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
    const n = new Notification(titel, { body: text, tag: 'fahnas-chat' });
    n.onclick = () => {
      try { globalThis.focus(); } catch { /* egal */ }
      if (beiKlick) beiKlick();
      n.close();
    };
    return n;
  } catch { return null; }
}

/**
 * Neue Nachricht melden. `einstellungen` = {ton, browser} des Nutzers, `zustand` = {ich, sichtbar, offenerRaum,
 * text(nachricht, raum) → Meldungstext, beiKlick(raum)}. Gibt zurück, was getan wurde.
 */
export function melden(nachricht, raum, einstellungen, zustand) {
  const e = einstellungen || {}; const z = zustand || {};
  const sichtbar = typeof z.sichtbar === 'boolean' ? z.sichtbar : !(globalThis.document && globalThis.document.visibilityState === 'hidden');
  const soll = sollMelden({
    eigen: !!z.ich && nachricht.von === z.ich, sichtbar, raumOffen: !!raum && z.offenerRaum === raum.id, stumm: !!(raum && raum.stumm),
    ton: e.ton !== false, browser: e.browser === true, erlaubt: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  });
  if (soll.ton) tonSpielen();
  if (soll.meldung) {
    browserMeldung({
      titel: (raum && raum.name) || 'FAH-NAS',
      text: typeof z.text === 'function' ? z.text(nachricht, raum) : (nachricht.von_name || ''),
      beiKlick: typeof z.beiKlick === 'function' ? () => z.beiKlick(raum) : null,
    });
  }
  return soll;
}
