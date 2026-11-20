// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Steuerung der Anrufe in einem Tab (Plan 03): höchstens ein Anruf je Tab, als Ebene über der ganzen Oberfläche (auch
// beim Wechsel der Ansicht). Beitreten holt die ICE-Zugänge, startet den Anruf und zeigt die Anruf-Ansicht; endet der
// Anruf mit einem Grund, steht die Meldung 4 s da. Ein Beitritt in einem anderen Raum legt vorher auf. Ohne app.js.

import { Anruf } from './anruf.js';
import { anrufAnsicht } from './anruf-ansicht.js';

const MELDUNG_MS = 4000;
const GRUND_TEXT = Object.freeze({
  ersetzt: 'chat.anruf_ersetzt', keine_antwort: 'chat.anruf_keine_antwort', abgelehnt: 'chat.anruf_abgelehnt', entfernt: 'chat.anruf_entfernt',
  voll: 'chat.anruf_voll', kein_zugriff: 'chat.anruf_kein_zugriff', kein_raum: 'chat.anruf_kein_raum', fehler: 'chat.anruf_fehler',
});

/** ICE-Server für diesen Browser (Sitzung oder Gast-Keks). */
export async function iceHolen(holen = globalThis.fetch) {
  const r = await holen('/api/chat/ice', { credentials: 'same-origin' });
  const j = await r.json();
  if (!j || !j.ok) throw Object.assign(new Error((j && j.fehler && j.fehler.meldung) || 'ICE nicht verfügbar'), { code: (j && j.fehler && j.fehler.code) || 'E_AGENT' });
  return j.ergebnis;
}

const steuerungen = new WeakMap(); // Verbindung → Steuerung

export function anrufSteuerung({ verbindung, h, iceHolen: holenIce = iceHolen, dokument = globalThis.document, AnrufKlasse = Anruf }) {
  if (steuerungen.has(verbindung)) return steuerungen.get(verbindung);
  let aktiv = null; let ausklingend = null;
  const hoerer = new Set();
  const melden = () => { const s = aktiv ? { raum: aktiv.raum } : null; for (const fn of [...hoerer]) { try { fn(s); } catch (e) { console.error(e); } } };
  const cssLaden = () => {
    if (dokument.head.querySelector('link[href="/chat/anruf.css"]')) return;
    dokument.head.appendChild(h.el('link', { rel: 'stylesheet', href: '/chat/anruf.css' }));
  };
  const ebeneWeg = (a) => {
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    if (a.ansicht) a.ansicht.verlassen();
    a.ebene.remove();
    if (ausklingend === a) ausklingend = null;
    if (aktiv === a) { aktiv = null; melden(); }
  };
  const ausklingen = (a, text) => {
    if (aktiv === a) { aktiv = null; melden(); }
    if (a.ansicht) a.ansicht.meldung(text); else a.ebene.textContent = text;
    ausklingend = a;
    a.timer = setTimeout(() => ebeneWeg(a), MELDUNG_MS);
  };

  const steuerung = {
    async beitreten(raum, { video = false, raumName = '' } = {}) {
      if (aktiv && aktiv.raum === raum) { aktiv.ebene.classList.remove('anruf-ebene-klein'); return; }
      if (aktiv) steuerung.verlassen();
      if (aktiv) ebeneWeg(aktiv);
      if (ausklingend) ebeneWeg(ausklingend);
      cssLaden();
      const ebene = h.el('div', { class: 'anruf-ebene', role: 'dialog', 'aria-label': `${h.t('chat.anruf_audio')} – ${raumName}` });
      dokument.body.appendChild(ebene);
      const a = { raum, ebene, anruf: null, ansicht: null, timer: null, abgelehntVon: '' };
      aktiv = a; melden();
      const warten = h.el('p', { class: 'anruf-meldung', text: h.t('chat.anruf_verbinde') });
      ebene.appendChild(warten);
      let ice = { ice_server: [] };
      try { ice = await holenIce(); } catch { /* ohne Vermittlung: im Heimnetz klappt es trotzdem */ }
      if (aktiv !== a) return;
      const anruf = new AnrufKlasse({ raum, verbindung, iceServer: (ice && ice.ice_server) || [] });
      a.anruf = anruf;
      warten.remove();
      a.ansicht = anrufAnsicht(ebene, { h, anruf, raumName, beiAuflegen: () => steuerung.verlassen(), beiKlein: () => ebene.classList.toggle('anruf-ebene-klein') });
      anruf.on('abgelehnt', ({ von_name }) => { a.abgelehntVon = von_name || ''; });
      anruf.on('ende', ({ grund }) => {
        if (!GRUND_TEXT[grund]) { ebeneWeg(a); return; }
        ausklingen(a, h.t(GRUND_TEXT[grund], grund === 'abgelehnt' ? { name: a.abgelehntVon } : undefined));
      });
      const ok = await anruf.starten({ video });
      if (!ok && aktiv === a) ausklingen(a, h.t(GRUND_TEXT.kein_zugriff));
    },
    aktiv: () => (aktiv ? { raum: aktiv.raum } : null),
    verlassen() {
      const a = aktiv;
      if (!a) return;
      if (a.anruf) a.anruf.verlassen(); // löst 'ende' {grund:'verlassen'} aus → Ebene weg
      if (aktiv === a) ebeneWeg(a);
    },
    on(fn) { hoerer.add(fn); return () => { hoerer.delete(fn); }; },
  };
  steuerungen.set(verbindung, steuerung);
  return steuerung;
}
