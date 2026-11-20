// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordnerrechte (Betreiber 19.10.2026): Dialog „Ordnerrechte“ für Admins – je Nutzer und Gruppe der Freigabe „Wie Freigabe“,
// „Nur lesen“ oder „Kein Zugriff“ für einen Ordner und alles darunter; dazu die Overlay-Meldung „Nicht für dich
// freigegeben“ für Nutzer. Genutzt vom Dateimanager und von der Freigaben-Ansicht.

import { el, t, symbol } from './app.js';

/** Stufen in der Reihenfolge der Auswahl; '' = wie Freigabe. */
export const STUFEN = Object.freeze(['', 'lesen', 'keiner']);
const RANG = { '': 0, lesen: 1, keiner: 2 };

/** Ist Stufe `a` mindestens so streng wie `b`? */
export function mindestens(a, b) { return RANG[a || ''] >= RANG[b || '']; }

/** Text einer Stufe und ihre Erklärung (je 1 Satz, Betreiber-Vorgabe „Info bei jeder Einstellung“). */
export function stufenText(stufe) {
  if (stufe === 'keiner') return { text: t('dateien.ordnerrechte_keiner'), info: t('dateien.ordnerrechte_keiner_info') };
  if (stufe === 'lesen') return { text: t('dateien.ordnerrechte_lesen'), info: t('dateien.ordnerrechte_lesen_info') };
  return { text: t('dateien.ordnerrechte_voll'), info: t('dateien.ordnerrechte_voll_info') };
}

/** Kurzfassung der Regeln eines Ordners: „anna: Kein Zugriff · @work: Nur lesen“. */
export function regelnKurz(regeln) {
  return Object.entries(regeln || {}).sort(([a], [b]) => a.localeCompare(b, 'de')).map(([konto, s]) => `${konto}: ${stufenText(s).text}`).join(' · ');
}

/** Recht an der Freigabe als Text. */
function freigabeRechtText(recht) {
  if (recht === 'schreiben') return t('dateien.ordnerrechte_freigabe_schreiben');
  if (recht === 'lesen') return t('dateien.ordnerrechte_freigabe_lesen');
  return t('dateien.ordnerrechte_freigabe_kein');
}

/** Overlay für Nutzer: „Nicht für dich freigegeben“ (Ordner bleibt sichtbar, der Klick führt nicht hinein). */
export function gesperrtHinweis(ctx, name) {
  const d = ctx.dialog([
    el('div', { class: 'ordnerrechte-gesperrt' }, [
      el('span', { class: 'ordnerrechte-gesperrt-symbol', 'aria-hidden': 'true' }, [symbol('schloss', 'gross')]),
      el('p', { class: 'leer-titel', text: t('dateien.nicht_freigegeben') }),
      el('p', { class: 'leer-text', text: t('dateien.nicht_freigegeben_text', { name }) }),
    ]),
    el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf', type: 'button', onclick: () => d.schliessen() }, t('dateien.verstanden'))]),
  ], { titel: name, klasse: 'ordnerrechte-gesperrt-dialog' });
  return d;
}

/**
 * Dialog „Ordnerrechte“ (nur Admins). `nachher()` läuft nach dem Speichern (Liste neu laden). Speichern ist eine Aufgabe:
 * der Agent setzt die Rechte auf alle Dateien darunter, bei großen Ordnern dauert das.
 */
export async function ordnerrechteDialog(ctx, { freigabe, pfad, name, nachher } = {}) {
  let info;
  try { info = await ctx.api('freigaben.ordnerrechte.lesen', { freigabe, pfad }); } catch (e) { ctx.zeigeFehler(e); return; }
  const wahl = new Map(); // konto → '' | 'lesen' | 'keiner' (eigene Regel)
  const zeilen = el('div', { class: 'ordnerrechte-zeilen', role: 'list' });
  const konten = [...(info.konten || [])].sort((a, b) => (a.art === b.art ? a.konto.localeCompare(b.konto, 'de') : a.art === 'gruppe' ? -1 : 1));
  for (const k of konten) {
    const geerbt = info.geerbt && info.geerbt[k.konto];
    const eigen = (info.regeln && info.regeln[k.konto]) || '';
    wahl.set(k.konto, eigen);
    const erklaerung = el('p', { class: 'erklaerung ordnerrechte-info' });
    const auswahl = el('select', { class: 'eingabe eingabe-klein', 'aria-label': t('dateien.ordnerrechte_fuer', { konto: k.konto }) },
      STUFEN.map((s) => el('option', { value: s, text: stufenText(s).text, selected: s === (geerbt && !mindestens(eigen, geerbt.stufe) ? geerbt.stufe : eigen), disabled: geerbt ? !mindestens(s, geerbt.stufe) : false })));
    const zeigen = () => {
      const s = auswahl.value;
      erklaerung.textContent = stufenText(s).info;
      zeile.classList.toggle('eingeschraenkt', !!s);
    };
    auswahl.addEventListener('change', () => { wahl.set(k.konto, auswahl.value); zeigen(); });
    const neben = k.art === 'gruppe'
      ? t('dateien.ordnerrechte_gruppe', { n: (k.mitglieder || []).length, mitglieder: (k.mitglieder || []).join(', ') || '–' })
      : (k.anzeigename && k.anzeigename !== k.konto ? k.anzeigename : '');
    const zeile = el('div', { class: 'ordnerrechte-zeile', role: 'listitem' }, [
      el('div', { class: 'ordnerrechte-konto' }, [
        el('span', { class: 'ordnerrechte-name', text: k.konto }),
        neben ? el('span', { class: 'schwach klein', text: neben }) : null,
        el('span', { class: 'schwach klein', text: freigabeRechtText(k.recht) }),
        geerbt ? el('span', { class: 'plakette', text: t('dateien.ordnerrechte_geerbt', { stufe: stufenText(geerbt.stufe).text, von: geerbt.von }) }) : null,
      ]),
      el('div', { class: 'ordnerrechte-wahl' }, [auswahl, erklaerung]),
    ]);
    zeigen();
    zeilen.appendChild(zeile);
  }
  const hinweise = [];
  if ((info.admins || []).length) hinweise.push(t('dateien.ordnerrechte_admins', { admins: info.admins.join(', ') }));
  if (info.gaeste) hinweise.push(t('dateien.ordnerrechte_gaeste'));
  if ((info.darunter || []).length) hinweise.push(t('dateien.ordnerrechte_darunter', { n: info.darunter.length }));
  const fehler = el('p', { class: 'feld-fehler', role: 'alert', hidden: true });
  const speichernKnopf = el('button', { class: 'knopf', type: 'button' }, t('dateien.ordnerrechte_speichern'));
  const d = ctx.dialog([
    el('p', { class: 'schwach klein abschneiden', text: `${freigabe}/${info.pfad}` }),
    el('p', { class: 'erklaerung', text: t('dateien.ordnerrechte_erklaerung') }),
    konten.length ? zeilen : el('p', { class: 'leer-text', text: t('dateien.ordnerrechte_niemand') }),
    ...hinweise.map((h) => el('p', { class: 'erklaerung ordnerrechte-hinweis', text: h })),
    fehler,
    el('div', { class: 'dialog-knoepfe' }, [
      el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
      speichernKnopf,
    ]),
  ], { titel: t('dateien.ordnerrechte_titel', { name: name || info.pfad.split('/').pop() }), breit: true, klasse: 'ordnerrechte-dialog' });

  speichernKnopf.addEventListener('click', async () => {
    const regeln = {};
    for (const [konto, s] of wahl) if (s) regeln[konto] = s;
    speichernKnopf.disabled = true; fehler.hidden = true;
    try {
      const antwort = await ctx.api('freigaben.ordnerrechte.setzen', { freigabe, pfad: info.pfad, regeln });
      d.schliessen();
      const id = antwort && antwort.aufgabe;
      if (id) {
        const toast = ctx.melden(t('dateien.ordnerrechte_laeuft'), 'info', 0);
        const textKnoten = toast && toast.element && toast.element.querySelector('.toast-text');
        try {
          await ctx.aufgabe(id, (e) => { if (textKnoten && e.status === 'laeuft' && e.meldung) textKnoten.textContent = `${t('dateien.ordnerrechte_laeuft')} – ${e.meldung}`; });
        } finally { if (toast) toast.schliessen(); }
      }
      ctx.melden(t(Object.keys(regeln).length ? 'dateien.ordnerrechte_gespeichert' : 'dateien.ordnerrechte_entfernt'), 'erfolg');
      if (typeof nachher === 'function') nachher();
    } catch (e) {
      if (d.element && d.element.isConnected) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; speichernKnopf.disabled = false; } else ctx.zeigeFehler(e);
    }
  });
  return d;
}
