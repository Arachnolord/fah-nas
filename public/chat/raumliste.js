// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Raumliste links in der Chat-Ansicht (Plan 02): Räume und Direktnachrichten getrennt, jeweils die neueste
// Unterhaltung oben, mit letzter Nachricht, Ungelesen-Zahl, „stumm“ und – bei Direktnachrichten – wer gerade da ist.

import { avatarKnoten } from '../avatar.js';

const zeitVon = (r) => (r && r.letzte && r.letzte.zeit) || '';

/** Räume und DMs trennen; je nach letzter Nachricht absteigend, ohne Nachricht nach Name. */
export function raeumeOrdnen(raeume) {
  const sortiert = [...(raeume || [])].sort((a, b) => zeitVon(b).localeCompare(zeitVon(a)) || String(a.name || '').localeCompare(String(b.name || ''), 'de'));
  return { raeume: sortiert.filter((r) => r.art !== 'dm'), dms: sortiert.filter((r) => r.art === 'dm') };
}

/**
 * Baut die Liste in `behaelter` (ersetzt den Inhalt). `aktiv` = offene Raum-ID, `online` = Set der anwesenden Nutzer,
 * `ich` = eigener Login-Name; beiWahl(id), beiNeu(), beiDm().
 */
export function raumlisteAufbauen(behaelter, { h, raeume, aktiv = null, online = new Set(), ich = '', beiWahl, beiNeu, beiDm }) {
  const { el, t, symbol } = h;
  const { raeume: liste, dms } = raeumeOrdnen(raeume);
  const eintrag = (r) => {
    const partner = r.art === 'dm' ? (r.mitglieder || []).find((m) => m.name !== ich) : null;
    const vorschau = r.letzte ? `${r.letzte.von_name ? `${r.letzte.von_name}: ` : ''}${r.letzte.kurz || ''}` : t('chat.noch_leer');
    return el('li', {}, [el('a', {
      class: `chat-raum-eintrag${r.ungelesen ? ' ungelesen' : ''}`, href: `#/chat/${encodeURIComponent(r.id)}`, 'data-raum': r.id,
      'aria-current': r.id === aktiv ? 'page' : null,
      onclick: (ev) => { if (beiWahl) { ev.preventDefault(); beiWahl(r.id); } },
    }, [
      el('span', { class: `chat-raum-zeichen${partner && online.has(partner.name) ? ' online' : ''}`, 'aria-hidden': 'true' }, [partner ? avatarKnoten({ name: partner.name, anzeige: partner.anzeigename || r.name, groesse: 34 }) : symbol(r.art === 'dm' ? 'nutzer' : 'chat')]),
      el('span', { class: 'chat-raum-text' }, [
        el('span', { class: 'chat-raum-name', text: r.name || '' }),
        el('span', { class: 'chat-raum-vorschau', text: vorschau }),
      ]),
      r.stumm ? el('span', { class: 'chat-raum-stumm', title: t('chat.stumm_an'), 'aria-label': t('chat.stumm_an') }, '🔕') : null,
      r.ungelesen ? el('span', { class: 'chat-raum-ungelesen', 'aria-label': t('navigation.abzeichen', { n: r.ungelesen }) }, r.ungelesen > 99 ? '99+' : String(r.ungelesen)) : null,
    ])]);
  };
  const abschnitt = (titel, eintraege, neuText, neuFn, leer) => el('section', { class: 'chat-liste-abschnitt' }, [
    el('div', { class: 'chat-liste-kopf' }, [
      el('h2', { text: titel }),
      neuFn ? el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': neuText, title: neuText, onclick: () => neuFn() }, [symbol('plus')]) : null,
    ]),
    eintraege.length ? el('ul', { class: 'chat-liste', role: 'list' }, eintraege.map(eintrag)) : el('p', { class: 'erklaerung', text: leer }),
  ]);
  behaelter.textContent = '';
  behaelter.appendChild(abschnitt(t('chat.raeume'), liste, t('chat.raum_neu'), beiNeu, t('chat.raeume_leer')));
  behaelter.appendChild(abschnitt(t('chat.direkt'), dms, t('chat.dm_neu'), beiDm, t('chat.direkt_leer')));
}
