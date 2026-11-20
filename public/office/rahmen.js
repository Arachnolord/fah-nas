// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rahmen um einen Office-Editor (Plan 04): Kopfzeile mit Titel (Umbenennen), Speicherstatus, „Nur lesen“, Anwesenden,
// „Privat“ bzw. „Geteilt mit …“, Export und „Freigeben“ (nur der Besitzer ändert Office-Freigaben). Reagiert auf die
// Sitzung: Außenänderung oder Neuladen mit eigenen ungesicherten Änderungen bietet „Meine Fassung als Kopie sichern“
// an; ein gelöschtes Dokument führt zur Startseite. Hat die Freigabe keine Schnappschüsse, weist er einmal je Dokument
// darauf hin.

import { el, t, symbol, hashFuer } from '../app.js';
import { kopieSichern } from './sitzung.js';
import { avatarKnoten } from '../avatar.js';

const STATUS = Object.freeze(['gespeichert', 'speichert', 'offline', 'fehler']);
const RECHTE = Object.freeze(['lesen', 'bearbeiten']);

/** Text des Speicherstatus; bei „fehler“ mit dem Fehlertext. */
export function statusText(status, tt, fehler = '') {
  if (status === 'fehler') return tt('office.status_fehler', { fehler: fehler || '' });
  return tt(`office.status_${STATUS.includes(status) ? status : 'gespeichert'}`);
}

/** „Privat“ oder „Geteilt mit Anna A., Ben“ aus office.freigaben. */
export function geteiltText(freigaben, tt) {
  const namen = (freigaben && Array.isArray(freigaben.geteilt_mit) ? freigaben.geteilt_mit : []).map((n) => n && (n.anzeigename || n.name)).filter(Boolean);
  if (!namen.length) return tt('office.privat');
  return tt('office.geteilt_mit', { namen: namen.join(', ') });
}

/** Schnappschuss-Hinweis nötig? Einmal je Dokument (gemerkt im Browser); ohne lesbaren Speicher lieber zeigen. */
export function hinweisNoetig(dok, speicher) {
  if (!dok || dok.schnappschuesse) return false;
  const schluessel = `fahnas.office.hinweis.${dok.id}`;
  try {
    if (speicher.getItem(schluessel)) return false;
  } catch { return true; }
  try { speicher.setItem(schluessel, '1'); } catch { /* dann eben beim nächsten Mal wieder */ }
  return true;
}

function browserSpeicher() { try { return globalThis.localStorage; } catch { return null; } }

function herunterladen(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  const zeitgeber = setTimeout(() => URL.revokeObjectURL(url), 10_000); // der Download braucht die Adresse noch kurz
  if (zeitgeber && typeof zeitgeber.unref === 'function') zeitgeber.unref();
}

/** Export-Ergebnis {name, blob} herunterladen. */
export function blobHerunterladen({ name, blob }) { herunterladen(name, blob); }

/**
 * Export ausführen (V18): ein Ergebnis {name, blob} wird heruntergeladen (true); null heißt, der Editor hat es selbst
 * erledigt (etwa den Druckdialog) – dann nichts herunterladen (false).
 */
export async function exportAusfuehren(editor, id, laden = blobHerunterladen) {
  const r = await editor.exportieren(id);
  if (!r || !r.blob) return false;
  laden(r);
  return true;
}

/**
 * Baut den Rahmen in `behaelter` → {element, inhalt (Platz für den Editor), setzeEditor(editor), entfernen()}.
 */
export function rahmenBauen(behaelter, { ctx, sitzung }) {
  const ab = [];
  let editor = null;
  let weg = false;
  const ich = ctx.nutzer && ctx.nutzer.name;
  const titel = el('h1', { class: 'of-titel' });
  const umbenennen = el('button', { class: 'knopf-symbol of-umbenennen', type: 'button', 'aria-label': t('office.umbenennen'), title: t('office.umbenennen'), onclick: () => umbenennenDialog() }, [symbol('umbenennen')]);
  const nurLesen = el('span', { class: 'of-marke of-nurlesen', text: t('office.nur_lesen') });
  const status = el('span', { class: 'of-status', role: 'status', 'aria-live': 'polite' });
  const geteilt = el('span', { class: 'of-geteilt' });
  const anwesende = el('ul', { class: 'of-anwesend', role: 'list', 'aria-label': t('office.anwesend') });
  const exportKnopf = el('button', { class: 'knopf knopf-zweit of-export', type: 'button', hidden: true, onclick: () => exportDialog() }, [symbol('herunterladen'), el('span', { text: t('office.exportieren') })]);
  const teilen = el('button', { class: 'knopf knopf-zweit of-teilen', type: 'button', onclick: () => freigebenDialog() }, [symbol('teilen'), el('span', { text: t('office.freigeben') })]);
  const hinweisText = el('span', { class: 'of-hinweis-text' });
  const hinweis = el('p', { class: 'hinweis of-hinweis', hidden: true }, [
    symbol('info'), hinweisText,
    el('button', { class: 'knopf-symbol of-hinweis-weg', type: 'button', 'aria-label': t('office.hinweis_schliessen'), onclick: () => { hinweis.hidden = true; } }, [symbol('schliessen')]),
  ]);
  const inhalt = el('div', { class: 'of-inhalt' });
  const element = el('div', { class: 'of-rahmen' }, [
    el('header', { class: 'of-kopf' }, [
      el('a', { class: 'knopf-symbol of-zurueck', href: hashFuer('office'), 'aria-label': t('office.zur_startseite'), title: t('office.zur_startseite') }, [symbol('zurueck')]),
      el('div', { class: 'of-titelzeile' }, [titel, umbenennen, nurLesen]),
      el('div', { class: 'of-kopf-info' }, [status, geteilt]),
      anwesende,
      el('div', { class: 'of-kopf-knoepfe' }, [exportKnopf, teilen]),
    ]),
    hinweis,
    inhalt,
  ]);
  behaelter.appendChild(element);

  const titelZeigen = () => { titel.textContent = sitzung.dok.name; };
  const rechtZeigen = () => {
    const lesen = sitzung.recht !== 'bearbeiten';
    umbenennen.hidden = lesen;
    nurLesen.hidden = !lesen;
  };
  const statusZeigen = () => {
    const f = sitzung.fehler;
    status.textContent = statusText(sitzung.status, t, f ? ctx.fehlerText({ code: f.code, message: f.meldung || f.code }) : '');
    status.dataset.status = sitzung.status || 'gespeichert';
  };
  const anwesendZeigen = () => {
    anwesende.textContent = '';
    const andere = (Array.isArray(sitzung.anwesend) ? sitzung.anwesend : []).filter((a) => a && a.kid !== sitzung.kid);
    for (const a of andere) {
      const name = String(a.name || a.nutzer || '?');
      // Avatar (0.22.0) im Ring der Sitzungsfarbe; ohne Bild der Buchstabe in dieser Farbe
      anwesende.appendChild(el('li', { class: 'of-person-kreis', title: name, 'aria-label': name, style: { '--farbe': a.farbe || '' } }, [avatarKnoten({ name: a.nutzer || '', anzeige: name, groesse: 28, farbe: a.farbe || '' })]));
    }
    anwesende.hidden = !andere.length;
  };
  const geteiltLaden = async () => {
    try {
      const r = await ctx.api('office.freigaben', { id: sitzung.dok.id });
      if (!weg) geteilt.textContent = geteiltText(r, t);
      return r;
    } catch { return null; }
  };

  titelZeigen(); rechtZeigen(); statusZeigen(); anwesendZeigen();
  geteiltLaden();
  const speicher = browserSpeicher();
  if (hinweisNoetig(sitzung.dok, speicher || { getItem() { throw new Error('kein Speicher'); }, setItem() {} })) {
    hinweisText.textContent = t('office.hinweis_schnappschuesse');
    hinweis.hidden = false;
  }

  async function umbenennenDialog() {
    const neu = await ctx.eingabe({
      titel: t('office.umbenennen'), beschriftung: t('office.name'), wert: sitzung.dok.name, ok: t('office.umbenennen_ok'), maxlaenge: 200,
      pruefen: (w) => (!w ? t('rahmen.eingabe_leer') : /^(?!\.)[^/\\\u0000-\u001f\u007f]+$/.test(w) ? null : t('office.name_ungueltig')),
    });
    if (!neu || neu === sitzung.dok.name) return;
    try { await ctx.api('office.umbenennen', { id: sitzung.dok.id, name: neu }); } catch (f) { ctx.zeigeFehler(f); }
  }

  function exportDialog() {
    if (!editor || !editor.exportformate || !editor.exportformate.length) return;
    const d = ctx.dialog([
      el('p', { class: 'erklaerung', text: t('office.export_erklaerung') }),
      el('div', { class: 'of-export-liste' }, editor.exportformate.map((f) => el('button', { class: 'knopf knopf-zweit of-export-format', type: 'button', 'data-format': f.id, onclick: async (ev) => {
        const knopf = ev.currentTarget; knopf.disabled = true;
        try {
          await exportAusfuehren(editor, f.id);
          d.schliessen();
        } catch (e) { knopf.disabled = false; ctx.zeigeFehler(e); }
      } }, [symbol('herunterladen'), f.titel]))),
    ], { titel: t('office.exportieren') });
  }

  async function freigebenDialog() {
    const istBesitzer = !!ich && ich === sitzung.dok.besitzer;
    let stand;
    try { stand = await ctx.api('office.freigaben', { id: sitzung.dok.id }); } catch (f) { ctx.zeigeFehler(f); return; }
    let personen = [];
    if (istBesitzer) { try { personen = await ctx.api('office.personen', {}); } catch (f) { ctx.zeigeFehler(f); } }
    const text = el('p', { class: 'of-geteilt-text' });
    const liste = el('ul', { class: 'of-freigaben', role: 'list' });
    const personWahl = el('select', { class: 'of-person', 'aria-label': t('office.person') });
    const personRecht = rechtWahl('lesen', 'of-person-recht');
    const hinzu = el('button', { class: 'knopf of-hinzufuegen', type: 'button', onclick: () => { if (personWahl.value) setzen(personWahl.value, personRecht.value); } }, [symbol('plus'), t('office.hinzufuegen')]);
    const personZeile = el('div', { class: 'of-person-zeile knopf-reihe' }, [personWahl, personRecht, hinzu]);
    const anzeigename = (n) => {
      const g = (stand.geteilt_mit || []).find((x) => x && x.name === n) || (Array.isArray(personen) ? personen : []).find((x) => x && x.name === n);
      return (g && (g.anzeigename || g.name)) || n;
    };
    function rechtWahl(wert, klasse) {
      const s = el('select', { class: klasse, 'aria-label': t('office.recht') }, RECHTE.map((r) => el('option', { value: r, text: t(`office.recht_${r}`) })));
      s.value = wert;
      return s;
    }
    async function setzen(nutzer, recht) {
      try {
        await ctx.api('office.freigeben', { id: sitzung.dok.id, nutzer, recht });
        const neu = await geteiltLaden();
        if (neu) stand = neu;
        zeichnen();
      } catch (f) { ctx.zeigeFehler(f); }
    }
    function zeichnen() {
      text.textContent = geteiltText(stand, t);
      if (!istBesitzer) return;
      const freigaben = stand.freigaben && typeof stand.freigaben === 'object' ? stand.freigaben : {};
      const namen = Object.keys(freigaben).sort((a, b) => a.localeCompare(b, 'de'));
      liste.textContent = '';
      if (!namen.length) liste.appendChild(el('li', { class: 'schwach klein', text: t('office.keine_freigaben') }));
      for (const n of namen) {
        const wahl = rechtWahl(freigaben[n], 'of-freigabe-recht');
        wahl.addEventListener('change', () => setzen(n, wahl.value));
        liste.appendChild(el('li', { class: 'of-freigabe-zeile', 'data-nutzer': n }, [
          avatarKnoten({ name: n, anzeige: anzeigename(n), groesse: 28 }), el('span', { class: 'of-freigabe-name', text: anzeigename(n) }), wahl,
          el('button', { class: 'knopf knopf-zweit of-entfernen', type: 'button', onclick: () => setzen(n, 'keins') }, t('office.entfernen')),
        ]));
      }
      personWahl.textContent = '';
      const frei = (Array.isArray(personen) ? personen : []).filter((p) => p && p.name && !Object.hasOwn(freigaben, p.name));
      for (const p of frei) personWahl.appendChild(el('option', { value: p.name, text: p.anzeigename || p.name }));
      personWahl.value = frei.length ? frei[0].name : '';
      personZeile.hidden = !frei.length;
    }
    zeichnen();
    const d = ctx.dialog([
      text,
      istBesitzer ? el('p', { class: 'erklaerung', text: t('office.freigabe_erklaerung') }) : null,
      istBesitzer ? liste : null,
      istBesitzer ? personZeile : null,
      el('p', { class: 'erklaerung', text: t('office.privat_erklaerung') }),
      el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf of-freigaben-schliessen', type: 'button', onclick: () => d.schliessen() }, t('rahmen.schliessen'))]),
    ], { titel: t('office.freigeben') });
  }

  /** Außenänderung/Neuladen: mit eigenen ungesicherten Änderungen „Meine Fassung als Kopie sichern“ anbieten. */
  function neuGeladen(e) {
    if (!e) return;
    // gelöscht oder (etwa per SMB) verschoben: die Sitzung ist zu Ende – eigene Änderungen lassen sich noch als Kopie sichern
    const weg = e.grund === 'geloescht' || e.grund === 'verschoben';
    if (weg && !e.eigeneUngesichert) {
      ctx.melden(t(e.grund === 'geloescht' ? 'office.geloescht_meldung' : 'office.verschoben_meldung'), 'warnung');
      ctx.navigiere(hashFuer('office'));
      return;
    }
    if (!e.eigeneUngesichert) { ctx.melden(t('office.extern_neu_geladen'), 'info'); return; }
    const daten = e.daten;
    const text = weg ? (e.grund === 'geloescht' ? 'office.geloescht_text' : 'office.verschwunden_text') : e.grund === 'extern' ? 'office.extern_text' : 'office.neu_laden_text';
    const textAbsatz = el('p', { class: 'dialog-text', text: t(text) });
    const knoepfe = el('div', { class: 'dialog-knoepfe' });
    const kopie = el('button', { class: 'knopf of-kopie', type: 'button', onclick: async () => {
      kopie.disabled = true;
      try {
        const r = await kopieSichern(ctx, sitzung, new Date(), daten);
        if (!r) { kopie.disabled = false; return; } // Ordnerwahl abgebrochen
        textAbsatz.textContent = t('office.kopie_gesichert', { name: r.name });
        knoepfe.textContent = '';
        knoepfe.appendChild(el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.schliessen')));
        knoepfe.appendChild(el('a', { class: 'knopf of-kopie-oeffnen', href: hashFuer('office', 'd', r.id), onclick: () => d.schliessen() }, t('office.kopie_oeffnen')));
      } catch (f) { kopie.disabled = false; ctx.zeigeFehler(f); }
    } }, t('office.kopie_sichern'));
    knoepfe.appendChild(el('button', { class: 'knopf knopf-zweit of-neu-laden', type: 'button', onclick: () => d.schliessen() }, t(weg ? 'rahmen.schliessen' : 'office.neu_laden')));
    knoepfe.appendChild(kopie);
    const d = ctx.dialog([textAbsatz, knoepfe], {
      titel: t(weg ? 'office.verschwunden_titel' : 'office.extern_titel'),
      beimSchliessen: () => { if (weg) ctx.navigiere(hashFuer('office')); },
    });
  }

  ab.push(
    sitzung.on('status', statusZeigen),
    sitzung.on('anwesend', anwesendZeigen),
    sitzung.on('recht', () => { rechtZeigen(); geteiltLaden(); }),
    sitzung.on('umbenannt', () => { titelZeigen(); if (typeof ctx.setzeTitel === 'function') ctx.setzeTitel(sitzung.dok.name); }),
    sitzung.on('extern', (e) => neuGeladen({ ...e, grund: 'extern' })),
    sitzung.on('neu_laden', neuGeladen),
    sitzung.on('fehler', (f) => {
      if (!f) return;
      ctx.zeigeFehler({ code: f.code, message: f.meldung || f.code, details: f.details });
      if (f.code === 'E_RECHTE' || f.code === 'E_NICHT_GEFUNDEN') ctx.navigiere(hashFuer('office'));
    }),
  );

  return {
    element,
    inhalt,
    setzeEditor(neu) {
      editor = neu || null;
      exportKnopf.hidden = !(editor && Array.isArray(editor.exportformate) && editor.exportformate.length);
    },
    entfernen() {
      weg = true;
      for (const x of ab) { try { x(); } catch { /* egal */ } }
      ab.length = 0;
      element.remove();
    },
  };
}
