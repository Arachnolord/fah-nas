// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufe in der Oberfläche der NAS-Nutzer (Plan 03): meldet beim Laden die Andockstellen an (Raumkopf: Anrufen +
// Banner, Einstellungen: Admin-Karte „Anrufe von unterwegs“, Kachel: laufende Anrufe mit Beitreten) und startet im
// Rahmen Steuerung und Klingeln für den ganzen Tab.

import { el, t, symbol, format } from '../app.js';
import { erweiterungHinzu } from './erweiterungen.js';
import { chatVerbindung } from './verbindung.js';
import { anrufStand } from './anruf-stand.js';
import { anrufSteuerung } from './anruf-steuerung.js';
import { klingelnStarten } from './klingeln.js';
import { anrufKopf } from './anruf-kopf.js';
import { karteAnrufeUnterwegs } from './anruf-einstellungen.js';

const hilfen = () => ({ el, t, symbol, format }); // t ist eine Live-Bindung – erst beim Aufruf lesen

/** Laufende Anrufe in eigenen Räumen, ältester zuerst. */
export function laufendeZeilen(uebersicht, laufende) {
  const namen = new Map(((uebersicht && uebersicht.raeume) || []).map((r) => [r.id, r.name]));
  return [...laufende.values()]
    .filter((l) => l && namen.has(l.raum))
    .map((l) => ({ raum: l.raum, name: namen.get(l.raum), anzahl: (l.teilnehmer || []).length, beginn: l.beginn }))
    .sort((a, b) => String(a.beginn).localeCompare(String(b.beginn)));
}

function teile() {
  const verbindung = chatVerbindung();
  return { verbindung, steuerung: anrufSteuerung({ verbindung, h: hilfen() }), stand: anrufStand(verbindung) };
}

erweiterungHinzu('raumKopf', (raum) => {
  const { steuerung, stand } = teile();
  return anrufKopf(raum, { h: hilfen(), steuerung, stand });
});

erweiterungHinzu('einstellungen', (ctx) => (ctx && ctx.rolle === 'admin' ? karteAnrufeUnterwegs(ctx) : null));

erweiterungHinzu('kachel', (uebersicht) => {
  const { steuerung, stand } = teile();
  const h = hilfen();
  const liste = h.el('ul', { class: 'dashboard-spiegelung dashboard-anrufe', role: 'list', hidden: true });
  let warImDokument = false; let ab = null;
  const zeigen = () => {
    if (liste.isConnected) warImDokument = true;
    else if (warImDokument) { if (ab) ab(); return; }
    const zeilen = laufendeZeilen(uebersicht, stand.laufende());
    liste.textContent = '';
    liste.hidden = !zeilen.length;
    for (const z of zeilen) {
      liste.appendChild(h.el('li', { class: 'dashboard-spiegel dashboard-anruf' }, [
        h.el('span', { class: 'dashboard-spiegel-name' }, [h.symbol('anruf'), ` ${z.name} · ${h.t('chat.anruf_laeuft', { n: z.anzahl })}`]),
        h.el('button', { class: 'knopf knopf-klein', type: 'button', onclick: () => steuerung.beitreten(z.raum, { video: false, raumName: z.name }) }, h.t('chat.anruf_beitreten')),
      ]));
    }
  };
  ab = stand.on(zeigen);
  zeigen();
  return liste;
});

let laufend = null;

/** Im Rahmen: Anruf-Steuerung und Klingeln für den ganzen Tab. */
export function anrufeAppStarten() {
  if (laufend) return;
  const { verbindung, steuerung } = teile();
  verbindung.starten();
  const klingeln = klingelnStarten({ verbindung, h: hilfen(), beiAnnehmen: (raum, o) => steuerung.beitreten(raum, o) });
  laufend = { steuerung, klingeln };
}

/** Abmelden/Sitzungsende: auflegen, Klingeln aus. */
export function anrufeAppStoppen() {
  if (!laufend) return;
  try { laufend.steuerung.verlassen(); } catch { /* schon zu */ }
  laufend.klingeln.stoppen();
  laufend = null;
}
