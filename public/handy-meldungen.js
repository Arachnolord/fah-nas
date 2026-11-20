// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Karte „Handy-Meldungen“ (V9): jeder Nutzer schaltet persönliche ntfy-Meldungen für neue Chat-Nachrichten und Anrufe
// selbst ein. Das Thema denkt sich FAH-NAS aus; die ntfy-App abonniert es per QR-Code. Server und Zugang stellt der
// Admin unter System → Benachrichtigungen ein – die Karte zeigt nur den Server (ohne Zugangsdaten).

import { el, t } from './app.js';
import { ntfyThemaNeu } from './ntfy.js';
import { qrErzeugen, qrZeichnen } from './ansichten/nutzer.qr.js';

/** Karte für die Chat-Einstellungen; lädt ihre Daten selbst und speichert über nutzer.einstellungen.setzen. */
export function karteHandyMeldungen(ctx) {
  const name = ctx.nutzer && ctx.nutzer.name;
  let wert = { aktiv: false, thema: '' }; let server = '';

  const eingabe = el('input', { type: 'checkbox', role: 'switch', 'aria-checked': 'false', disabled: true });
  const canvas = el('canvas', { class: 'handy-qr-bild', 'aria-hidden': 'true' });
  const adresse = el('code', { class: 'handy-adresse' });
  const test = el('button', { class: 'knopf knopf-zweit handy-test', type: 'button', onclick: () => testSenden() }, t('chat.handy_test'));
  const qr = el('div', { class: 'handy-qr', hidden: true }, [
    canvas,
    el('p', { class: 'erklaerung', text: t('chat.handy_anleitung') }),
    adresse,
    el('div', { class: 'knopf-reihe' }, [test]),
  ]);
  const status = el('p', { class: 'erklaerung', text: t('rahmen.laden') });

  const zeigen = () => {
    eingabe.checked = !!wert.aktiv; eingabe.setAttribute('aria-checked', wert.aktiv ? 'true' : 'false');
    qr.hidden = !wert.aktiv;
    if (!wert.aktiv) return;
    const ziel = `${server.replace(/\/+$/, '')}/${wert.thema}`;
    adresse.textContent = ziel;
    try { qrZeichnen(canvas, qrErzeugen(ziel), 5, 4); canvas.hidden = false; } catch { canvas.hidden = true; }
  };

  async function speichern(aktiv) {
    const neu = { aktiv, thema: wert.thema || ntfyThemaNeu() };
    eingabe.disabled = true;
    try {
      await ctx.api('nutzer.einstellungen.setzen', { name, bereich: 'benachrichtigung', wert: neu });
      wert = neu;
      ctx.melden(t(aktiv ? 'chat.handy_an' : 'chat.handy_aus'), 'erfolg');
    } catch (e) { ctx.zeigeFehler(e); }
    eingabe.disabled = false;
    zeigen();
  }

  async function testSenden() {
    test.disabled = true;
    try {
      const r = await ctx.api('benachrichtigungen.persoenlich_test', {});
      if (r && r.gesendet) ctx.melden(t('chat.handy_test_ok'), 'erfolg'); else ctx.melden(t('chat.handy_test_nicht'), 'warnung');
    } catch (e) { ctx.zeigeFehler(e); }
    test.disabled = false;
  }

  eingabe.addEventListener('change', () => { speichern(eingabe.checked); });

  (async () => {
    try {
      const [e, info] = await Promise.all([
        ctx.api('nutzer.einstellungen.lesen', { name, bereich: 'benachrichtigung' }),
        ctx.api('benachrichtigungen.persoenlich_info', {}),
      ]);
      const w = e && e.wert && typeof e.wert === 'object' ? e.wert : {};
      wert = { aktiv: w.aktiv === true, thema: typeof w.thema === 'string' ? w.thema : '' };
      server = (info && info.server) || 'https://ntfy.sh';
      status.remove();
      eingabe.disabled = false;
      zeigen();
    } catch (f) { status.textContent = `${t('chat.handy_laden_fehl')} ${ctx.fehlerText(f)}`; }
  })();

  return el('section', { class: 'karte handy-meldungen' }, [
    el('h2', { text: t('chat.handy_titel') }),
    el('label', { class: 'schalter' }, [
      el('span', { class: 'schalter-beschriftung', text: t('chat.handy_schalter') }),
      eingabe,
      el('p', { class: 'erklaerung', text: t('chat.handy_erklaerung') }),
    ]),
    status, qr,
  ]);
}
