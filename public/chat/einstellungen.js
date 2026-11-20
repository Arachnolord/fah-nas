// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Einstellungen (Plan 02): je Nutzer Standardordner für Anhänge, Ton, Browser-Meldungen und Handy-Meldungen;
// für Admins zusätzlich die größte erlaubte Datei und „Räume verwalten“ (alle Räume ohne Inhalte, Löschen).
// Gespeichert in users.json → einstellungen.chat (nutzer.einstellungen.setzen, Bereich „chat“).

import { el, t, symbol, format } from '../app.js';
import { ordnerWaehlen } from '../ordnerwahl.js';
import { karteHandyMeldungen } from '../handy-meldungen.js';
import { erweiterungenBauen } from './erweiterungen.js';

/** Gespeicherten Wert auf die bekannte Form bringen (fehlende Felder → Standard). */
export function einstellungenNormal(wert) {
  const w = wert && typeof wert === 'object' ? wert : {};
  const so = w.standardordner;
  return {
    standardordner: so && typeof so === 'object' && typeof so.freigabe === 'string' && so.freigabe ? { freigabe: so.freigabe, pfad: typeof so.pfad === 'string' ? so.pfad : '' } : null,
    ton: w.ton !== false,
    browser: w.browser === true,
    stumm: Array.isArray(w.stumm) ? w.stumm.filter((x) => typeof x === 'string') : [],
  };
}

const ordnerText = (o) => (o.pfad ? `${o.freigabe}/${o.pfad}` : o.freigabe);

function karte(titel, klasse, ...inhalt) {
  return el('section', { class: `karte ${klasse}` }, [el('h2', { text: titel }), ...inhalt]);
}

function schalter(text, erklaerung, wert, beiWechsel) {
  const eingabe = el('input', { type: 'checkbox', role: 'switch', 'aria-checked': wert ? 'true' : 'false' });
  eingabe.checked = !!wert;
  eingabe.addEventListener('change', () => { eingabe.setAttribute('aria-checked', eingabe.checked ? 'true' : 'false'); beiWechsel(eingabe.checked, eingabe); });
  return el('label', { class: 'schalter' }, [el('span', { class: 'schalter-beschriftung', text }), eingabe, el('p', { class: 'erklaerung', text: erklaerung })]);
}

/**
 * Baut die Einstellungen in `behaelter`. `v` = {ich, einstellungen, einstellungenSpeichern(teil) → Promise, aufrufen}.
 * Admin-Karten laden ihre Daten über ctx.api (die Aktionen sind nicht über den Chat-WebSocket freigegeben).
 */
export function einstellungenSeite(behaelter, ctx, v) {
  const e = v.einstellungen || einstellungenNormal(null);
  const speichern = async (teil, beiFehler) => {
    try { await v.einstellungenSpeichern(teil); ctx.melden(t('chat.gespeichert_einstellung'), 'erfolg'); return true; } catch (f) { if (beiFehler) beiFehler(); ctx.zeigeFehler(f); return false; }
  };

  // Standardordner
  const ordnerZeile = el('p', { class: 'chat-standardordner' });
  const entfernen = el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: async () => { if (await speichern({ standardordner: null })) { e.standardordner = null; ordnerZeigen(); } } }, t('chat.standardordner_weg'));
  const ordnerZeigen = () => {
    ordnerZeile.textContent = e.standardordner ? t('chat.standardordner_ist', { ordner: ordnerText(e.standardordner) }) : t('chat.standardordner_keiner');
    entfernen.hidden = !e.standardordner;
  };
  ordnerZeigen();
  const waehlen = el('button', { class: 'knopf', type: 'button', onclick: async () => {
    const ziel = await ordnerWaehlen(ctx, { titel: t('chat.standardordner'), erklaerung: t('chat.standardordner_wahl'), okText: t('chat.standardordner_setzen'), start: e.standardordner });
    if (ziel && await speichern({ standardordner: ziel })) { e.standardordner = ziel; ordnerZeigen(); }
  } }, [symbol('ordner'), t('chat.standardordner_waehlen')]);
  behaelter.appendChild(karte(t('chat.standardordner'), 'chat-karte-ordner', el('p', { class: 'erklaerung', text: t('chat.standardordner_erklaerung') }), ordnerZeile, el('div', { class: 'knopf-reihe' }, [waehlen, entfernen])));

  // Ton und Browser-Meldungen
  behaelter.appendChild(karte(t('chat.hinweise'), 'chat-karte-hinweise',
    el('div', { class: 'chat-ton' }, [schalter(t('chat.ton'), t('chat.ton_erklaerung'), e.ton, async (an, eingabe) => {
      if (await speichern({ ton: an }, () => { eingabe.checked = !an; })) e.ton = an;
    })]),
    el('div', { class: 'chat-browser' }, [schalter(t('chat.browser'), t('chat.browser_erklaerung'), e.browser, async (an, eingabe) => {
      if (an) {
        let erlaubt = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
        if (erlaubt === 'default' && typeof Notification.requestPermission === 'function') { try { erlaubt = await Notification.requestPermission(); } catch { erlaubt = 'denied'; } }
        if (erlaubt !== 'granted') { eingabe.checked = false; ctx.melden(t('chat.browser_verweigert'), 'warnung', 8000); return; }
      }
      if (await speichern({ browser: an }, () => { eingabe.checked = !an; })) e.browser = an;
    })])));

  behaelter.appendChild(karteHandyMeldungen(ctx));

  if (ctx.rolle === 'admin') {
    behaelter.appendChild(karteMaxAnhang(ctx));
    behaelter.appendChild(karteRaeumeVerwalten(ctx));
  }
  for (const k of erweiterungenBauen('einstellungen', ctx)) behaelter.appendChild(k);
}

function karteMaxAnhang(ctx) {
  const feld = el('input', { type: 'number', min: '1', max: '20480', step: '1', class: 'chat-max-feld', disabled: true, 'aria-label': t('chat.max_anhang') });
  const knopf = el('button', { class: 'knopf', type: 'button', disabled: true, onclick: async () => {
    const n = Math.round(Number(feld.value));
    if (!Number.isFinite(n) || n < 1 || n > 20480) { ctx.melden(t('chat.max_anhang_ungueltig'), 'warnung'); return; }
    knopf.disabled = true;
    try { await ctx.api('chat.einstellungen.setzen', { max_anhang_mb: n }); ctx.melden(t('chat.gespeichert_einstellung'), 'erfolg'); } catch (f) { ctx.zeigeFehler(f); }
    knopf.disabled = false;
  } }, t('chat.speichern'));
  ctx.api('chat.einstellungen.lesen', {}).then((w) => { feld.value = String((w && w.max_anhang_mb) || 2048); feld.disabled = false; knopf.disabled = false; }).catch((f) => ctx.zeigeFehler(f));
  return karte(t('chat.max_anhang'), 'chat-max-anhang',
    el('p', { class: 'erklaerung', text: t('chat.max_anhang_erklaerung') }),
    el('div', { class: 'knopf-reihe' }, [feld, el('span', { text: 'MiB' }), knopf]));
}

function karteRaeumeVerwalten(ctx) {
  const liste = el('ul', { class: 'chat-verwalten-liste', role: 'list' }, [el('li', { class: 'erklaerung', text: t('rahmen.laden') })]);
  const laden = async () => {
    let raeume;
    try { raeume = await ctx.api('chat.raum.alle', {}); } catch (f) { liste.textContent = ''; liste.appendChild(el('li', { class: 'erklaerung', text: ctx.fehlerText(f) })); return; }
    liste.textContent = '';
    if (!Array.isArray(raeume) || !raeume.length) { liste.appendChild(el('li', { class: 'erklaerung', text: t('chat.verwalten_leer') })); return; }
    for (const r of raeume) {
      liste.appendChild(el('li', { class: 'chat-verwalten-zeile' }, [
        el('span', { class: 'chat-verwalten-name' }, [el('strong', { text: r.name }), ' ',
          el('span', { class: 'schwach klein', text: t('chat.verwalten_info', { mitglieder: r.mitglieder_anzahl, gaeste: r.gaeste_anzahl, zuletzt: r.letzte_zeit ? format.zeit(r.letzte_zeit) : '–' }) })]),
        el('button', { class: 'knopf knopf-zweit knopf-gefahr', type: 'button', onclick: async () => {
          if (!await ctx.bestaetigen(t('chat.raum_loeschen_frage', { name: r.name }), { titel: t('chat.raum_loeschen'), ok: t('chat.loeschen'), gefahr: true })) return;
          try { await ctx.api('chat.raum.loeschen', { raum: r.id }); ctx.melden(t('chat.raum_geloescht', { name: r.name }), 'erfolg'); laden(); } catch (f) { ctx.zeigeFehler(f); }
        } }, [symbol('loeschen'), t('chat.loeschen')]),
      ]));
    }
  };
  laden();
  return karte(t('chat.raeume_verwalten'), 'chat-raeume-verwalten', el('p', { class: 'erklaerung', text: t('chat.raeume_verwalten_erklaerung') }), liste);
}
