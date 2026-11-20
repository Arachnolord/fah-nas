// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Admin-Karte „Anrufe von unterwegs“ (Plan 03) in den Chat-Einstellungen: Verbindungshilfe (STUN/TURN) an/aus, Port,
// was am Router weiterzuleiten ist, wann zuletzt jemand von außen sie brauchte und ob gerade Weiterleitungen laufen.

import { el, t, format } from '../app.js';

const STANDARD_PORT = 3478;

/** Ganzzahliger Port 1024–65535, sonst null. */
export function portPruefen(wert) {
  const s = String(wert ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1024 && n <= 65535 ? n : null;
}

/** Hinweis für die Weiterleitung am Router (nur mit bekannter LAN-IP). */
export function weiterleitungText(tt, stand) {
  return stand && stand.lan_ip ? tt('chat.unterwegs_weiterleiten', { port: stand.port ?? STANDARD_PORT, ip: stand.lan_ip }) : '';
}

export function karteAnrufeUnterwegs(ctx) {
  const inhalt = el('div', { class: 'chat-unterwegs' }, [el('p', { class: 'erklaerung', text: t('rahmen.laden') })]);
  const karte = el('section', { class: 'karte chat-anrufe-unterwegs' }, [el('h2', { text: t('chat.unterwegs_titel') }), el('p', { class: 'erklaerung', text: t('chat.unterwegs_erklaerung') }), inhalt]);
  // Einstellung (was der Admin will, aus chat.json) und Laufzustand (was der Web-Dienst gerade tut) getrennt: ein belegter
  // Port darf weder den Schalter umlegen noch den falschen Port ins Feld schreiben (Prüfbericht Plan 03, I7)
  let einstellung = { aktiv: true, port: STANDARD_PORT };
  let stand = null;

  async function laden(erwartet = null, versuch = 0) {
    try {
      const e = await ctx.api('chat.einstellungen.lesen', {});
      if (e && e.turn) einstellung = { aktiv: e.turn.aktiv !== false, port: Number.isInteger(e.turn.port) ? e.turn.port : STANDARD_PORT };
      stand = await ctx.get('/api/chat/turn');
    } catch (e) {
      inhalt.textContent = '';
      inhalt.appendChild(el('p', { class: 'feld-fehler', text: ctx.fehlerText ? ctx.fehlerText(e) : e.message }));
      return;
    }
    zeichnen();
    // Der Dienst startet nach dem Speichern im Hintergrund neu: kurz nachsehen, bis der neue Stand da ist
    if (erwartet && versuch < 3 && (stand.aktiv !== erwartet.aktiv || (erwartet.aktiv && stand.port !== erwartet.port))) setTimeout(() => laden(erwartet, versuch + 1), 1000);
  }

  async function speichern(turn) {
    try { await ctx.api('chat.einstellungen.setzen', { turn }); if (ctx.melden) ctx.melden(t('chat.gespeichert_einstellung'), 'erfolg'); } catch (e) { if (ctx.zeigeFehler) ctx.zeigeFehler(e); }
    await laden(turn);
  }

  function zeichnen() {
    const s = stand || {};
    const port = einstellung.port;
    inhalt.textContent = '';
    const schalter = el('input', { type: 'checkbox', role: 'switch', 'aria-checked': einstellung.aktiv ? 'true' : 'false' });
    schalter.checked = !!einstellung.aktiv;
    schalter.addEventListener('change', () => { speichern({ aktiv: schalter.checked, port }); });
    inhalt.appendChild(el('label', { class: 'schalter' }, [
      el('span', { class: 'schalter-beschriftung', text: t('chat.unterwegs_schalter') }), schalter,
      el('p', { class: 'erklaerung', text: t('chat.unterwegs_schalter_erklaerung') }),
    ]));
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const portFeld = el('input', { class: 'eingabe chat-max-feld', type: 'number', min: '1024', max: '65535', step: '1', value: String(port) });
    portFeld.addEventListener('change', () => {
      const p = portPruefen(portFeld.value);
      if (p === null) { fehler.textContent = t('chat.unterwegs_port_fehler'); fehler.hidden = false; return; }
      fehler.hidden = true;
      if (p !== port) speichern({ aktiv: schalter.checked, port: p });
    });
    inhalt.appendChild(el('label', { class: 'feld' }, [
      el('span', { class: 'feld-beschriftung', text: t('chat.unterwegs_port') }), portFeld,
      el('p', { class: 'erklaerung', text: t('chat.unterwegs_port_erklaerung') }), fehler,
    ]));
    const zeilen = [];
    if (!einstellung.aktiv) zeilen.push(el('p', { class: 'erklaerung', text: t('chat.unterwegs_aus') }));
    else if (s.aktiv) {
      const w = weiterleitungText(t, s);
      if (w) zeilen.push(el('p', { class: 'chat-unterwegs-weiterleiten', text: w }));
      zeilen.push(el('p', { class: 'schwach klein', text: s.extern_zuletzt ? t('chat.unterwegs_zuletzt', { zeit: format.zeitGenau(s.extern_zuletzt) }) : t('chat.unterwegs_nie') }));
      zeilen.push(el('p', { class: 'schwach klein', text: t('chat.unterwegs_zuteilungen', { n: s.zuteilungen || 0 }) }));
    } else {
      // eingeschaltet, läuft aber nicht: den Grund zeigen
      const text = { port_belegt: t('chat.unterwegs_port_belegt', { port }), keine_lan_ip: t('chat.unterwegs_keine_ip'), agent: t('chat.unterwegs_fehler_agent'), start: t('chat.unterwegs_fehler_start') }[s.fehler];
      if (text) zeilen.push(el('p', { class: 'feld-fehler', text }));
    }
    for (const z of zeilen) inhalt.appendChild(z);
  }

  laden();
  return karte;
}
