// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Startseite (Plan 04): „Neu“ (Dokument, Tabelle, Board), Listen „Zuletzt bearbeitet“, „Meine“ und „Für mich
// freigegeben“ aus office.liste, Karte „Einstellungen“ (Standardordner, fällige Karten aufs Handy). Der „Neu“-Dialog
// fragt nach Name und Ordner; vorbelegt ist der Standardordner, ohne ihn muss zuerst ein Ordner gewählt werden
// (vorgeschlagen: die erste Freigabe mit Schreibrecht). Gespeichert in users.json → einstellungen.office.

import { el, t, symbol, format, hashFuer } from '../app.js';
import { ordnerWaehlen } from '../ordnerwahl.js';

export const ARTEN = Object.freeze(['dokument', 'tabelle', 'board']);
const ID = /^o[A-Za-z0-9_-]{16}$/;
const NAME = /^(?!\.)[^/\\\u0000-\u001f\u007f]+$/;
const LISTEN = Object.freeze(['zuletzt', 'meine', 'fuer_mich']);
const VORSCHLAG_MAX = 8;

const ordnerText = (o) => (o.pfad ? `${o.freigabe}/${o.pfad}` : o.freigabe);
const gleicherOrt = (a, b) => !!a && !!b && a.freigabe === b.freigabe && (a.pfad || '') === (b.pfad || '');

/** Gespeicherten Wert auf die bekannte Form bringen (fehlende Felder → Standard: kein Ordner, Handy-Meldung an). */
export function einstellungNormal(wert) {
  const w = wert && typeof wert === 'object' ? wert : {};
  const so = w.standardordner;
  return {
    standardordner: so && typeof so === 'object' && typeof so.freigabe === 'string' && so.freigabe ? { freigabe: so.freigabe, pfad: typeof so.pfad === 'string' ? so.pfad : '' } : null,
    faellig_push: w.faellig_push !== false,
  };
}

/** Einträge aus office.liste für die Anzeige: Ort = Freigabe + Ordner des Dokuments; Unbekanntes fällt weg. */
export function listeAufbereiten(liste) {
  return (Array.isArray(liste) ? liste : []).filter((d) => d && ID.test(d.id) && ARTEN.includes(d.art)).map((d) => {
    const pfad = String(d.pfad || '');
    const i = pfad.lastIndexOf('/');
    return { id: d.id, art: d.art, name: String(d.name || ''), ort: i > 0 ? `${d.freigabe}/${pfad.slice(0, i)}` : String(d.freigabe || ''), geaendert: d.geaendert || null, geteilt: d.geteilt === true };
  });
}

async function einstellungenLesen(ctx) {
  try {
    const r = await ctx.api('nutzer.einstellungen.lesen', { name: ctx.nutzer && ctx.nutzer.name, bereich: 'office' });
    return r && r.wert && typeof r.wert === 'object' ? r.wert : null;
  } catch { return null; }
}

/** Erste Freigabe, in deren Wurzel ich schreiben darf (Vorschlag für die erste Ordnerwahl); keine → null. */
async function ersteSchreibbare(ctx) {
  try {
    const l = await ctx.api('freigaben.liste', {});
    const freigaben = (Array.isArray(l) ? l : (l && l.freigaben) || []).filter((f) => f && f.name).slice(0, VORSCHLAG_MAX);
    for (const f of freigaben) {
      try {
        const r = await ctx.api('dateien.liste', { freigabe: f.name, pfad: '' });
        if (!(r && r.schreiben === false)) return { freigabe: f.name, pfad: '' };
      } catch { /* nächste Freigabe */ }
    }
  } catch { /* ohne Vorschlag */ }
  return null;
}

const ordnerWahlText = () => ({ titel: t('office.ordner_waehlen'), erklaerung: t('office.ordner_erklaerung'), okText: t('office.ordner_ok'), nurSchreibbar: true });

/**
 * „Neu“: Name und Ordner wählen, office.anlegen. Mit „Als Standardordner merken“ wird der Ordner gespeichert (andere
 * Office-Einstellungen bleiben). Ein vorhandener Name zeigt den Fehler im Dialog, der Dialog bleibt offen.
 * Promise<{id}|null> (null = abgebrochen).
 */
export async function neuDialog(ctx, art, { ordnerWahl = ordnerWaehlen } = {}) {
  const roh = await einstellungenLesen(ctx);
  const e = einstellungNormal(roh);
  let ziel = e.standardordner;
  if (!ziel) {
    ziel = await ordnerWahl(ctx, { ...ordnerWahlText(), start: await ersteSchreibbare(ctx) });
    if (!ziel) return null;
  }
  return new Promise((aufloesen) => {
    let ergebnis = null;
    const name = el('input', { class: 'eingabe of-neu-name', type: 'text', value: t(`office.neu_${art}`), maxlength: 200, autocomplete: 'off', spellcheck: 'false' });
    const zielText = el('span', { class: 'of-neu-ziel' });
    const merken = el('input', { type: 'checkbox', class: 'of-neu-merken' });
    merken.checked = !e.standardordner;
    const merkenZeile = el('label', { class: 'of-neu-merken-zeile' }, [merken, el('span', { text: t('office.standard_merken') })]);
    const fehler = el('p', { class: 'feld-fehler of-neu-fehler', role: 'alert', hidden: true });
    const zeigen = () => { zielText.textContent = ordnerText(ziel); merkenZeile.hidden = gleicherOrt(ziel, e.standardordner); };
    const fehlerZeigen = (text) => { fehler.textContent = text; fehler.hidden = false; try { name.focus(); } catch { /* egal */ } };
    const aendern = el('button', { class: 'knopf knopf-zweit of-neu-aendern', type: 'button', onclick: async () => {
      const neu = await ordnerWahl(ctx, { ...ordnerWahlText(), start: ziel });
      if (!neu) return;
      ziel = neu;
      zeigen();
    } }, [symbol('ordner'), t('office.aendern')]);
    const anlegen = el('button', { class: 'knopf of-neu-anlegen', type: 'button', onclick: () => abschicken() }, t('office.anlegen'));
    const abschicken = async () => {
      if (anlegen.disabled) return;
      const n = name.value.trim();
      if (!n) { fehlerZeigen(t('rahmen.eingabe_leer')); return; }
      if (!NAME.test(n)) { fehlerZeigen(t('office.name_ungueltig')); return; }
      anlegen.disabled = true; fehler.hidden = true;
      try {
        const r = await ctx.api('office.anlegen', { art, freigabe: ziel.freigabe, ordner: ziel.pfad || '', name: n });
        if (merken.checked && !merkenZeile.hidden) {
          try { await ctx.api('nutzer.einstellungen.setzen', { name: ctx.nutzer && ctx.nutzer.name, bereich: 'office', wert: { ...(roh || {}), standardordner: ziel } }); } catch (f) { ctx.zeigeFehler(f); }
        }
        ergebnis = { id: r.id };
        d.schliessen();
      } catch (f) {
        anlegen.disabled = false;
        fehlerZeigen(f && f.code === 'E_EXISTIERT' ? t('office.name_vergeben') : ctx.fehlerText(f));
      }
    };
    const form = el('form', { class: 'dialog-form of-neu-form', onsubmit: (ev) => { ev.preventDefault(); abschicken(); } }, [
      el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('office.name') }), name]),
      el('div', { class: 'feld of-neu-ort' }, [el('span', { class: 'feld-beschriftung', text: t('office.ziel') }), el('div', { class: 'of-neu-ort-zeile' }, [zielText, aendern])]),
      merkenZeile,
      el('p', { class: 'erklaerung', text: t('office.ordner_erklaerung') }),
      fehler,
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit of-neu-abbrechen', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
        anlegen,
      ]),
    ]);
    zeigen();
    const d = ctx.dialog(form, { titel: t(`office.neu_${art}`), beimSchliessen: () => aufloesen(ergebnis) });
    try { name.focus(); name.select(); } catch { /* egal */ }
  });
}

function eintragElement(d) {
  return el('li', {}, [
    el('a', { class: 'of-eintrag', href: hashFuer('office', 'd', d.id), 'data-art': d.art }, [
      el('span', { class: 'of-eintrag-symbol', 'aria-label': t(`office.art_${d.art}`), role: 'img' }, [symbol(d.art)]),
      el('span', { class: 'of-eintrag-text' }, [
        el('span', { class: 'of-eintrag-name', text: d.name }),
        el('span', { class: 'of-eintrag-ort', text: d.ort }),
      ]),
      d.geaendert ? el('span', { class: 'of-eintrag-zeit', text: format.zeit(d.geaendert) }) : null,
      d.geteilt ? el('span', { class: 'of-marke of-geteilt-marke', text: t('office.geteilt') }) : null,
    ]),
  ]);
}

function listeKarte(art, eintraege) {
  const inhalt = eintraege.length
    ? el('ul', { class: 'of-eintraege', role: 'list' }, eintraege.map(eintragElement))
    : el('p', { class: 'leer of-leer', text: t(`office.leer_${art}`) });
  return el('section', { class: 'karte of-liste', 'data-liste': art }, [el('h2', { text: t(`office.${art}`) }), inhalt]);
}

function schalter(text, erklaerung, wert, klasse, beiWechsel) {
  const eingabe = el('input', { type: 'checkbox', role: 'switch', class: klasse, 'aria-checked': wert ? 'true' : 'false' });
  eingabe.checked = !!wert;
  eingabe.addEventListener('change', () => { eingabe.setAttribute('aria-checked', eingabe.checked ? 'true' : 'false'); beiWechsel(eingabe.checked, eingabe); });
  return el('label', { class: 'schalter' }, [el('span', { class: 'schalter-beschriftung', text }), eingabe, el('p', { class: 'erklaerung', text: erklaerung })]);
}

function einstellungenKarte(ctx, roh, ordnerWahl) {
  let wert = roh && typeof roh === 'object' ? { ...roh } : {};
  const speichern = async (teil) => {
    const neu = { ...wert, ...teil };
    try {
      await ctx.api('nutzer.einstellungen.setzen', { name: ctx.nutzer && ctx.nutzer.name, bereich: 'office', wert: neu });
      wert = neu;
      ctx.melden(t('office.gespeichert_einstellung'), 'erfolg');
      return true;
    } catch (f) { ctx.zeigeFehler(f); return false; }
  };
  const ordnerZeile = el('p', { class: 'of-standardordner' });
  const weg = el('button', { class: 'knopf knopf-zweit of-standardordner-weg', type: 'button', onclick: async () => { if (await speichern({ standardordner: null })) zeigen(); } }, t('office.standardordner_weg'));
  const zeigen = () => {
    const so = einstellungNormal(wert).standardordner;
    ordnerZeile.textContent = so ? t('office.standardordner_ist', { ordner: ordnerText(so) }) : t('office.standardordner_keiner');
    weg.hidden = !so;
  };
  const aendern = el('button', { class: 'knopf of-standardordner-aendern', type: 'button', onclick: async () => {
    const ziel = await ordnerWahl(ctx, { ...ordnerWahlText(), start: einstellungNormal(wert).standardordner });
    if (ziel && await speichern({ standardordner: ziel })) zeigen();
  } }, [symbol('ordner'), t('office.standardordner_aendern')]);
  zeigen();
  return el('section', { class: 'karte of-einstellungen' }, [
    el('h2', { text: t('office.einstellungen') }),
    el('div', { class: 'of-einstellung' }, [
      el('h3', { text: t('office.standardordner') }),
      el('p', { class: 'erklaerung', text: t('office.standardordner_erklaerung') }),
      ordnerZeile,
      el('div', { class: 'knopf-reihe' }, [aendern, weg]),
    ]),
    el('div', { class: 'of-einstellung' }, [
      schalter(t('office.faellig_push'), t('office.faellig_push_erklaerung'), einstellungNormal(wert).faellig_push, 'of-faellig-push', async (an, eingabe) => {
        if (!await speichern({ faellig_push: an })) { eingabe.checked = !an; eingabe.setAttribute('aria-checked', !an ? 'true' : 'false'); }
      }),
    ]),
  ]);
}

/** Startseite in `behaelter` aufbauen (lädt Liste und Einstellungen gleichzeitig). */
export async function startseite(behaelter, ctx, { ordnerWahl = ordnerWaehlen } = {}) {
  const listen = el('div', { class: 'of-listen' }, [el('p', { class: 'laden', role: 'status', text: t('rahmen.laden') })]);
  const seite = el('section', { class: 'of-start' }, [
    el('header', { class: 'of-start-kopf' }, [el('h1', { text: t('office.titel') }), el('p', { class: 'erklaerung', text: t('office.untertitel') })]),
    el('div', { class: 'of-neu knopf-reihe' }, ARTEN.map((art) => el('a', { class: 'knopf of-neu-knopf', href: hashFuer('office', 'neu', art), 'data-art': art }, [symbol(art), t(`office.neu_${art}`)]))),
    listen,
  ]);
  behaelter.textContent = '';
  behaelter.appendChild(seite);
  const [liste, roh] = await Promise.all([ctx.api('office.liste', {}).catch((f) => ({ fehler: f })), einstellungenLesen(ctx)]);
  listen.textContent = '';
  if (liste && liste.fehler) listen.appendChild(el('p', { class: 'feld-fehler', role: 'alert', text: ctx.fehlerText(liste.fehler) }));
  else for (const art of LISTEN) listen.appendChild(listeKarte(art, listeAufbereiten(liste && liste[art])));
  seite.appendChild(einstellungenKarte(ctx, roh, ordnerWahl));
}
