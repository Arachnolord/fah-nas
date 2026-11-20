// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eingehende Anrufe in Direktnachrichten klingeln in der ganzen Oberfläche (Plan 03): Hinweis oben mittig mit
// Annehmen, Mit Video annehmen, Ablehnen; der Tab-Titel blinkt, alle 3 s ein Klingelton. Nach 45 s, beim Annehmen auf
// einem anderen Gerät oder wenn der Anrufer auflegt, verschwindet der Hinweis. Der Klingelton folgt bewusst nicht dem
// Chat-Schalter „Ton“ – sonst bliebe ein Anruf im Hintergrund-Tab unbemerkt. Ohne app.js.

export const KLINGEL_MS = 45_000;
const BLINK_MS = 1000;
const TON_MS = 3000;

/** Zustand Raum → {von_name, video, seit} aus Ereignissen (rein). */
export function klingelnReduzieren(zustand, ereignis, jetzt) {
  const e = ereignis || {};
  const ohne = (raum) => { if (!zustand.has(raum)) return zustand; const z = new Map(zustand); z.delete(raum); return z; };
  if (e.art === 'anruf.klingelt' && typeof e.raum === 'string') {
    const z = new Map(zustand); z.set(e.raum, { von_name: e.von_name || '', video: !!e.video, seit: jetzt }); return z;
  }
  if (e.art === 'anruf.stand') {
    const t = Array.isArray(e.teilnehmer) ? e.teilnehmer : [];
    return !t.length || t.some((x) => x && x.ich) ? ohne(e.raum) : zustand;
  }
  if (e.art === 'anruf.ende' || e.art === 'weg') return ohne(e.raum);
  if (e.art === 'zeit') {
    const alt = [...zustand].filter(([, x]) => jetzt - x.seit >= KLINGEL_MS).map(([raum]) => raum);
    if (!alt.length) return zustand;
    const z = new Map(zustand); for (const r of alt) z.delete(r); return z;
  }
  return zustand;
}

/** Tab-Titel beim Blinken. */
export function titelText(original, name, an, t) { return an ? t('chat.anruf_ruft_an', { name }) : original; }

/** Hört auf anruf.klingelt/stand/ende und zeigt die Hinweise; beiAnnehmen(raum, {video, raumName}). */
export function klingelnStarten({ verbindung, h, beiAnnehmen, dokument = globalThis.document, tonErzeugen = () => new AudioContext(), uhr = globalThis }) {
  const { el, t, symbol } = h;
  let zustand = new Map(); const hinweise = new Map(); const ablauf = new Map();
  let original = null; let blinkTimer = null; let blinkAn = false; let tonTimer = null; let audio = null;
  const stapel = el('div', { class: 'klingeln-stapel' });

  function ton() {
    try {
      if (!audio) audio = tonErzeugen();
      const start = () => {
        const jetzt = audio.currentTime;
        for (const beginn of [0, 0.6]) {
          const g = audio.createGain();
          g.gain.value = 0.15;
          g.connect(audio.destination);
          for (const hz of [440, 480]) {
            const o = audio.createOscillator();
            o.type = 'sine'; o.frequency.value = hz;
            o.connect(g); o.start(jetzt + beginn); o.stop(jetzt + beginn + 0.4);
          }
        }
      };
      if (audio.state === 'suspended' && typeof audio.resume === 'function') audio.resume().then(start, () => { /* Autoplay gesperrt: still */ });
      else start();
    } catch { /* ohne Ton */ }
  }

  function blinken() {
    blinkAn = !blinkAn;
    const [, erster] = [...zustand][0] || [];
    dokument.title = titelText(original, erster ? erster.von_name : '', blinkAn, t);
  }

  function zeigen() {
    for (const [raum, k] of hinweise) if (!zustand.has(raum)) { k.remove(); hinweise.delete(raum); }
    for (const [raum, x] of zustand) {
      if (hinweise.has(raum)) continue;
      const knopf = (id, text, sym, fn) => el('button', { class: `knopf${id === 'ablehnen' ? ' knopf-gefahr' : ''}`, type: 'button', 'data-knopf': id, onclick: fn }, [symbol(sym), text]);
      const k = el('div', { class: 'klingeln karte', role: 'alertdialog', 'aria-label': t('chat.anruf_ruft_an', { name: x.von_name }) }, [
        el('p', { class: 'klingeln-text' }, [symbol('anruf'), t('chat.anruf_ruft_an', { name: x.von_name })]),
        el('div', { class: 'knopf-reihe' }, [
          knopf('annehmen', t('chat.anruf_annehmen'), 'anruf', () => annehmen(raum, false)),
          knopf('annehmen_video', t('chat.anruf_annehmen_video'), 'kamera', () => annehmen(raum, true)),
          knopf('ablehnen', t('chat.anruf_ablehnen'), 'auflegen', () => { verbindung.senden({ art: 'anruf.ablehnen', raum }); anwenden({ art: 'weg', raum }); }),
        ]),
      ]);
      hinweise.set(raum, k);
      stapel.appendChild(k);
    }
    if (zustand.size) {
      if (dokument.head && !dokument.head.querySelector('link[href="/chat/anruf.css"]')) dokument.head.appendChild(el('link', { rel: 'stylesheet', href: '/chat/anruf.css' }));
      if (!stapel.parentNode) dokument.body.appendChild(stapel);
      if (original === null) original = dokument.title;
      if (!blinkTimer) blinkTimer = uhr.setInterval(blinken, BLINK_MS);
      if (!tonTimer) { ton(); tonTimer = uhr.setInterval(ton, TON_MS); }
    } else {
      if (blinkTimer) { uhr.clearInterval(blinkTimer); blinkTimer = null; }
      if (tonTimer) { uhr.clearInterval(tonTimer); tonTimer = null; }
      if (original !== null) { dokument.title = original; original = null; blinkAn = false; }
      stapel.remove();
    }
  }

  function anwenden(e) {
    const vorher = zustand;
    zustand = klingelnReduzieren(zustand, e, Date.now());
    if (e.art === 'anruf.klingelt' && zustand.has(e.raum)) {
      if (ablauf.has(e.raum)) uhr.clearTimeout(ablauf.get(e.raum));
      ablauf.set(e.raum, uhr.setTimeout(() => anwenden({ art: 'weg', raum: e.raum }), KLINGEL_MS));
    }
    for (const [raum, timer] of ablauf) if (!zustand.has(raum)) { uhr.clearTimeout(timer); ablauf.delete(raum); }
    if (zustand !== vorher) zeigen();
  }

  function annehmen(raum, video) {
    const x = zustand.get(raum);
    anwenden({ art: 'weg', raum });
    if (x && beiAnnehmen) beiAnnehmen(raum, { video, raumName: x.von_name });
  }

  const ab = ['anruf.klingelt', 'anruf.stand', 'anruf.ende'].map((art) => verbindung.on(art, (n) => anwenden(n || {})));
  return {
    stoppen() {
      for (const x of ab) { try { x(); } catch { /* egal */ } }
      zustand = new Map();
      zeigen();
      for (const timer of ablauf.values()) uhr.clearTimeout(timer);
      ablauf.clear();
      if (audio && typeof audio.close === 'function') audio.close().catch(() => {});
      audio = null;
    },
  };
}
