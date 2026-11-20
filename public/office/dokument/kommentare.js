// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kommentare im Dokument (Plan 05): Rand mit Karten in der Reihenfolge ihrer Stellen (ohne Ausrichtung an der Höhe –
// robust ohne Layout-Rechnung), Antworten, Erledigen, Löschen (nur Autor oder Besitzer), Umschalter „Erledigte zeigen“.
// Anlegen markiert den gewählten Text und legt den Kommentar in EINER Op an. Karte und markierter Text heben sich
// gegenseitig hervor. Auf dem Handy öffnet ein Knopf in der Leiste dieselbe Liste im Dialog. Leser sehen alles ohne
// Eingaben.

import { el, t, format } from '../../app.js';
import { dokument } from '../../gemeinsam/sync/typen/dokument.js';
import { neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { formatDelta, attributEntfernenDelta } from './befehle.js';

const TEXT_MAX = 5000;

/** Kommentare mit ihren Stellen → [{id, wer, name, zeit, text, erledigt, antworten, start, laenge, ohneStelle}] nach Stelle. */
export function kommentarListe(daten, { erledigteZeigen = false } = {}) {
  const stellen = new Map(); // id → {start, ende}
  let p = 0;
  for (const op of daten.delta || []) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1;
    const id = op.attributes && op.attributes.kommentar;
    if (typeof id === 'string') {
      const s = stellen.get(id);
      if (s) s.ende = p + l; else stellen.set(id, { start: p, ende: p + l });
    }
    p += l;
  }
  const liste = [];
  for (const [id, k] of Object.entries(daten.kommentare || {})) {
    if (!k || (k.erledigt && !erledigteZeigen)) continue;
    const s = stellen.get(id);
    liste.push({ id, wer: k.wer, name: k.name, zeit: k.zeit, text: k.text, erledigt: !!k.erledigt, antworten: k.antworten || [], start: s ? s.start : null, laenge: s ? s.ende - s.start : 0, ohneStelle: !s });
  }
  return liste.sort((a, b) => (a.ohneStelle - b.ohneStelle) || ((a.start ?? 0) - (b.start ?? 0)) || (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0));
}

/** Mehrzeiliger Text im Dialog → Text (getrimmt, 1–5000 Zeichen) oder null bei Abbruch. */
function textDialog(ctx, { titel, beschriftung, ok }) {
  return new Promise((aufloesen) => {
    let ergebnis = null;
    const feld = el('textarea', { class: 'eingabe od-kommentar-feld', rows: '4', maxlength: String(TEXT_MAX) });
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const form = el('form', {
      class: 'dialog-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const w = String(feld.value || '').trim();
        if (!w) { fehler.textContent = t('office.dok_kommentar_leer'); fehler.hidden = false; return; }
        ergebnis = w.slice(0, TEXT_MAX);
        d.schliessen();
      },
    }, [
      el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: beschriftung }), feld, fehler]),
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
        el('button', { class: 'knopf', type: 'submit' }, ok),
      ]),
    ]);
    const d = ctx.dialog(form, { titel, beimSchliessen: () => aufloesen(ergebnis) });
    try { feld.focus(); } catch { /* egal */ }
  });
}

/** Rand, Handy-Knopf, „Kommentar“-Aktion und Hervorhebung am Editor einrichten → Abmelden. */
export function kommentareEinrichten(ed) {
  const { ctx, sitzung, wurzel } = ed;
  const z = { erledigteZeigen: false, aktiv: null, entwuerfe: new Map(), schluessel: null, dialogListen: new Set() };
  const ich = () => (ctx.nutzer && ctx.nutzer.name) || '';
  const meinName = () => (ctx.nutzer && (ctx.nutzer.anzeigename || ctx.nutzer.name)) || '';
  const eintrag = (text) => ({ wer: ich(), name: meinName().slice(0, 100), zeit: new Date().toISOString(), text });

  const schalter = el('input', { type: 'checkbox', class: 'od-erledigte-schalter' });
  schalter.addEventListener('change', () => { z.erledigteZeigen = schalter.checked; zeichnen(true); });
  const listeEl = el('div', { class: 'od-kommentar-liste' });
  ed.rand.append(
    el('div', { class: 'od-rand-kopf' }, [
      el('h2', { class: 'od-rand-titel', text: t('office.dok_kommentare_titel') }),
      el('label', { class: 'od-erledigte-zeigen' }, [schalter, t('office.dok_erledigte_zeigen')]),
    ]),
    listeEl,
  );
  const mobil = el('button', { class: 'knopf knopf-zweit knopf-klein od-knopf-kommentare', type: 'button', onclick: () => dialogOeffnen() });
  ed.leiste.appendChild(mobil);

  // ---- Aktionen ---------------------------------------------------------------------------------------------------
  const aktion = {
    antworten(id, text) {
      const w = String(text || '').trim().slice(0, TEXT_MAX);
      if (!w || ed.nurLesen) return;
      if (ed.aendern({ k: { [id]: { antworten: { [neueId()]: eintrag(w) } } } })) { z.entwuerfe.delete(id); zeichnen(true); }
    },
    erledigt(id, wert) { if (!ed.nurLesen) ed.aendern({ k: { [id]: { erledigt: wert } } }); },
    async loeschen(id) {
      if (ed.nurLesen) return;
      if (typeof ctx.bestaetigen === 'function' && !(await ctx.bestaetigen(t('office.dok_kommentar_loeschen_frage')))) return;
      const d = attributEntfernenDelta(ed.daten, 'kommentar', id);
      ed.aendern(d && d.length ? { d, k: { [id]: null } } : { k: { [id]: null } });
      z.entwuerfe.delete(id);
    },
    zeigen(id) {
      z.aktiv = id;
      markieren(); zeichnen(true);
      const k = kommentarListe(ed.daten, { erledigteZeigen: true }).find((x) => x.id === id);
      if (k && !k.ohneStelle) {
        try { wurzel.focus({ preventScroll: true }); } catch { /* egal */ }
        ed.auswahlSetzen({ anker: k.start, kopf: k.start + k.laenge });
      }
    },
  };

  function darfLoeschen(k) { return ich() !== '' && (ich() === k.wer || ich() === sitzung.dok.besitzer); }

  function karte(k) {
    const kopf = (name, zeit) => el('div', { class: 'od-kommentar-kopf' }, [
      el('span', { class: 'od-kommentar-name', text: name }),
      el('time', { class: 'od-kommentar-zeit', datetime: zeit, text: format.zeit(zeit) }),
    ]);
    const teile = [kopf(k.name, k.zeit), el('p', { class: 'od-kommentar-text', text: k.text })];
    if (k.ohneStelle) teile.push(el('p', { class: 'od-stelle-weg', text: t('office.dok_stelle_geloescht') }));
    if (k.antworten.length) {
      teile.push(el('ul', { class: 'od-antworten' }, k.antworten.map((a) => el('li', { class: 'od-antwort' }, [kopf(a.name, a.zeit), el('p', { class: 'od-kommentar-text', text: a.text })]))));
    }
    if (!ed.nurLesen) {
      const feld = el('textarea', { class: 'eingabe od-antwort-feld', rows: '2', maxlength: String(TEXT_MAX), 'aria-label': t('office.dok_antwort_feld'), placeholder: t('office.dok_antwort_feld'), dataset: { id: k.id } });
      feld.value = z.entwuerfe.get(k.id) || '';
      feld.addEventListener('input', () => { if (feld.value) z.entwuerfe.set(k.id, feld.value); else z.entwuerfe.delete(k.id); });
      const knopf = (text, fn, klasse = 'knopf knopf-zweit knopf-klein') => el('button', { class: klasse, type: 'button', 'aria-label': text, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
      teile.push(feld, el('div', { class: 'od-kommentar-knoepfe' }, [
        knopf(t('office.dok_antworten'), () => aktion.antworten(k.id, feld.value), 'knopf knopf-klein'),
        knopf(k.erledigt ? t('office.dok_wieder_oeffnen') : t('office.dok_erledigt'), () => aktion.erledigt(k.id, !k.erledigt)),
        darfLoeschen(k) ? knopf(t('office.dok_kommentar_loeschen'), () => aktion.loeschen(k.id), 'knopf knopf-zweit knopf-gefahr knopf-klein') : null,
      ]));
    }
    return el('article', {
      class: `od-kommentar${z.aktiv === k.id ? ' od-aktiv' : ''}${k.erledigt ? ' od-erledigt-karte' : ''}`, dataset: { id: k.id }, tabindex: '0',
      onclick: (e) => { if (e.target && typeof e.target.closest === 'function' && e.target.closest('textarea, button')) return; aktion.zeigen(k.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); aktion.zeigen(k.id); } },
    }, teile);
  }

  /** Karten in `behaelter` zeichnen; ein Antwortfeld mit Fokus bekommt ihn danach zurück. */
  function listeZeichnen(behaelter, liste) {
    const fokus = document.activeElement;
    const fokusId = fokus && fokus.localName === 'textarea' && behaelter.contains(fokus) ? fokus.dataset.id : null;
    behaelter.textContent = '';
    for (const k of liste) behaelter.appendChild(karte(k));
    if (fokusId) {
      const neu = [...behaelter.querySelectorAll('textarea.od-antwort-feld')].find((x) => x.dataset.id === fokusId);
      if (neu) { try { neu.focus(); const n = neu.value.length; neu.setSelectionRange(n, n); } catch { /* egal */ } }
    }
  }

  /** Rand (und offene Dialog-Listen) neu zeichnen, wenn sich Kommentare, Reihenfolge oder Modus geändert haben. */
  function zeichnen(immer = false) {
    const liste = kommentarListe(ed.daten, { erledigteZeigen: z.erledigteZeigen });
    const schluessel = JSON.stringify([liste.map((k) => [k.id, k.wer, k.name, k.zeit, k.text, k.erledigt, k.antworten, k.ohneStelle]), z.aktiv, ed.nurLesen, z.erledigteZeigen]);
    const alle = Object.keys(ed.daten.kommentare || {}).length;
    ed.rand.hidden = alle === 0;
    mobil.hidden = alle === 0;
    mobil.textContent = t('office.dok_kommentare', { n: alle });
    if (!immer && schluessel === z.schluessel) return;
    z.schluessel = schluessel;
    listeZeichnen(listeEl, liste);
    for (const b of z.dialogListen) listeZeichnen(b, liste);
  }

  function dialogOeffnen() {
    if (typeof ctx.dialog !== 'function') return;
    const b = el('div', { class: 'od-kommentar-liste od-kommentare-dialog' });
    z.dialogListen.add(b);
    ctx.dialog(b, { titel: t('office.dok_kommentare_titel'), beimSchliessen: () => z.dialogListen.delete(b) });
    listeZeichnen(b, kommentarListe(ed.daten, { erledigteZeigen: z.erledigteZeigen }));
  }

  function markieren() {
    for (const e of wurzel.querySelectorAll('.od-kommentiert')) e.classList.toggle('od-aktiv', !!z.aktiv && e.dataset.kommentar === z.aktiv);
  }

  /** Klick in den Text: markierte Stelle → ihre Karte hervorheben, sonst die Hervorhebung lösen. */
  function klick(e) {
    const m = e.target && typeof e.target.closest === 'function' ? e.target.closest('.od-kommentiert') : null;
    const id = m && m.dataset.kommentar ? m.dataset.kommentar : null;
    if (id === z.aktiv) return;
    z.aktiv = id;
    markieren(); zeichnen(true);
    if (id) {
      const k = [...listeEl.querySelectorAll('.od-kommentar')].find((x) => x.dataset.id === id);
      if (k && typeof k.scrollIntoView === 'function') k.scrollIntoView({ block: 'nearest' });
    }
  }

  function knopfStand() {
    const k = ed.leiste.querySelector('.od-knopf-kommentar');
    if (!k) return;
    const aw = ed.auswahl() || ed.letzteAuswahl;
    k.disabled = !aw || aw.anker === aw.kopf;
  }

  ed.aktionen.kommentar = async () => {
    if (ed.nurLesen || typeof ctx.dialog !== 'function') return;
    let aw = ed.auswahl() || ed.letzteAuswahl;
    if (!aw || aw.anker === aw.kopf) { ctx.melden(t('office.dok_kommentar_auswahl'), 'info'); return; }
    // fremde Änderungen während des Dialogs verschieben die Auswahl mit
    const ab = sitzung.on('aenderung', ({ op, lokal } = {}) => { if (!lokal && op) aw = dokument.auswahlTransformieren(aw, op, false); });
    let text;
    try { text = await textDialog(ctx, { titel: t('office.dok_kommentar_neu'), beschriftung: t('office.dok_kommentar_text'), ok: t('office.dok_kommentar_speichern') }); } finally { ab(); }
    if (!text || ed.nurLesen || aw.anker === aw.kopf) return;
    const id = neueId();
    const d = formatDelta(ed.daten, aw, 'kommentar', id);
    if (!d) { ctx.melden(t('office.dok_kommentar_auswahl'), 'info'); return; }
    if (ed.aendern({ d, k: { [id]: { neu: eintrag(text) } } })) { z.aktiv = id; markieren(); zeichnen(true); }
  };

  wurzel.addEventListener('click', klick);
  const ab = [
    ed.on('gerendert', () => { markieren(); zeichnen(); knopfStand(); }),
    ed.on('auswahl', knopfStand),
    ed.on('recht', () => { zeichnen(true); knopfStand(); }),
  ];
  zeichnen(true); markieren(); knopfStand();
  const abmelden = () => { wurzel.removeEventListener('click', klick); for (const x of ab) x(); z.dialogListen.clear(); };
  ed.beimVerlassen.push(abmelden);
  return abmelden;
}
