// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// „Im Chat teilen …“ (Plan 02): eine Datei aus einer Freigabe in einen Raum oder eine Direktnachricht schicken. Der
// Agent kopiert sie als Anhang (chat.anhang.aus_nas), danach geht die Nachricht mit optionalem Begleittext raus.

import { el, t, symbol, hashFuer } from '../app.js';
import { chatVerbindung } from './verbindung.js';
import { raeumeOrdnen } from './raumliste.js';

/** Dialog „Im Chat teilen“; Promise<{raum, nachricht}|null> (null = abgebrochen). */
export async function imChatTeilen(ctx, { freigabe, pfad }, { verbindung = chatVerbindung() } = {}) {
  verbindung.starten();
  let uebersicht;
  try { uebersicht = await verbindung.aufrufen('chat.uebersicht', {}); } catch (e) { ctx.zeigeFehler(e); return null; }
  const { raeume, dms } = raeumeOrdnen((uebersicht && uebersicht.raeume) || []);
  const name = String(pfad || '').split('/').pop();
  return new Promise((fertig) => {
    let ergebnis = null; let gewaehlt = null; let gewaehltKnopf = null;
    const text = el('textarea', { class: 'eingabe chat-teilen-text', rows: '2', maxlength: '10000', placeholder: t('chat.teilen_text'), 'aria-label': t('chat.teilen_text') });
    const fehler = el('p', { class: 'feld-fehler', hidden: true, role: 'alert' });
    const senden = el('button', { class: 'knopf chat-teilen-senden', type: 'button', disabled: true, onclick: async () => {
      if (!gewaehlt || senden.disabled) return;
      senden.disabled = true; fehler.hidden = true;
      try {
        const a = await verbindung.aufrufen('chat.anhang.aus_nas', { raum: gewaehlt.id, freigabe, pfad });
        const r = await verbindung.aufrufen('chat.senden', { raum: gewaehlt.id, text: text.value || '', anhaenge: [a.anhang.id] });
        ergebnis = { raum: gewaehlt.id, nachricht: r.nachricht };
        d.schliessen();
        const toast = ctx.melden(t('chat.geteilt', { raum: gewaehlt.name }), 'erfolg', 8000);
        if (toast && toast.element) toast.element.appendChild(el('a', { class: 'toast-link', href: hashFuer('chat', gewaehlt.id), text: t('chat.oeffnen') }));
      } catch (e) {
        ctx.zeigeFehler(e);
        fehler.textContent = ctx.fehlerText(e); fehler.hidden = false;
        senden.disabled = false;
      }
    } }, [symbol('senden'), t('chat.senden')]);
    const raumKnopf = (r) => el('li', {}, [el('button', { class: 'chat-teilen-raum chat-person-knopf', type: 'button', 'data-raum': r.id, 'aria-pressed': 'false', onclick: (ev) => {
      if (gewaehltKnopf) gewaehltKnopf.setAttribute('aria-pressed', 'false');
      gewaehlt = r; gewaehltKnopf = ev.currentTarget || null;
      if (gewaehltKnopf) gewaehltKnopf.setAttribute('aria-pressed', 'true');
      senden.disabled = false;
    } }, [symbol(r.art === 'dm' ? 'nutzer' : 'chat'), el('span', { text: r.name || '' })])]);
    const abschnitt = (titel, liste) => (liste.length ? [el('h3', { class: 'chat-teilen-titel', text: titel }), el('ul', { class: 'chat-personen', role: 'list' }, liste.map(raumKnopf))] : []);
    const d = ctx.dialog([
      el('p', { class: 'erklaerung', text: t('chat.teilen_erklaerung', { name }) }),
      ...(raeume.length || dms.length ? [...abschnitt(t('chat.raeume'), raeume), ...abschnitt(t('chat.direkt'), dms)] : [el('p', { class: 'erklaerung', text: t('chat.teilen_keine_raeume') })]),
      el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('chat.teilen_text') }), text]),
      fehler,
      el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf knopf-zweit chat-teilen-abbrechen', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')), senden]),
    ], { titel: t('chat.teilen_titel'), beimSchliessen: () => fertig(ergebnis) });
  });
}
