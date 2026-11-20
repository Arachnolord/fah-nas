// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Ordnerwahl (V8): Ordnerbaum über alle Freigaben (Unterordner werden beim Aufklappen aus dateien.liste
// nachgeladen). Mit nurSchreibbar zählt nur ein Ziel mit Schreibrecht: das ermittelt dateien.liste je Knoten beim
// Aufklappen bzw. Wählen (gemerkt), gesperrte Ordner sind ausgegraut und OK bleibt aus. Genutzt vom Dateimanager
// (Verschieben/Kopieren), vom Chat (Anhang auf dem NAS speichern, Standardordner) und vom Office. Mit `dateien` zeigt der
// Baum auch Dateien und liefert eine gewählte Datei (Office: Anhang aus dem NAS); Office-Bündel (.fahdoc, .fahtab,
// .fahboard) stehen in beiden Arten als nicht aufklappbare, nicht wählbare Einträge im Baum.

import { el, t, symbol } from './app.js';

/** Schreibrecht aus einem dateien.liste-Ergebnis: nur ein ausdrückliches `schreiben: false` sperrt. */
export function schreibbarAus(ergebnis) { return !(ergebnis && ergebnis.schreiben === false); }

const verbinde = (pfad, name) => (pfad ? `${pfad}/${name}` : name);
const BUENDEL = /\.(fahdoc|fahtab|fahboard)$/i;
const buendelSymbol = (name) => (/\.fahboard$/i.test(name) ? 'board' : /\.fahtab$/i.test(name) ? 'tabelle' : 'dokument');
const nachName = (a, b) => String(a.name).localeCompare(String(b.name), 'de', { numeric: true, sensitivity: 'base' });

/**
 * Dialog mit Ordnerbaum. `start` = {freigabe, pfad} wählt dieses Ziel vor; `mitSystem` zeigt Admins auch die
 * Systemfreigaben; `dateien` = eine Datei wählen (dann zählt nurSchreibbar nicht, OK nur bei gewählter Datei).
 * Promise<{freigabe, pfad}|null> (null = abgebrochen).
 */
export async function ordnerWaehlen(ctx, { titel, erklaerung, okText, nurSchreibbar: schreibbarNoetig = true, start = null, mitSystem = false, dateien = false } = {}) {
  const nurSchreibbar = schreibbarNoetig && !dateien;
  let freigaben = []; let ladeFehler = null;
  try {
    const l = await ctx.api('freigaben.liste', mitSystem ? { mit_system: true } : {});
    freigaben = (Array.isArray(l) ? l : (l && l.freigaben) || []).filter((f) => f && f.name);
  } catch (e) { ladeFehler = e; }

  return new Promise((aufloesen) => {
    let gewaehlt = null; let gewaehltZeile = null; let ergebnis = null;
    const schreibrecht = new Map(); // "freigabe\npfad" → Promise<{schreiben:boolean, eintraege?, fehler?}>
    const zielText = el('p', { class: 'dateien-ziel', hidden: true });
    const hinweis = el('p', { class: 'ordnerwahl-hinweis feld-fehler', role: 'status', hidden: true });
    const ok = el('button', { class: 'knopf ordnerwahl-ok', type: 'button', disabled: true, onclick: () => { if (ok.disabled || !gewaehlt) return; ergebnis = gewaehlt; d.schliessen(); } }, okText || t('rahmen.ok'));

    /** dateien.liste eines Knotens, einmal je Knoten; Fehler zählen als „nicht schreibbar“. */
    const liste = (fg, p) => {
      const k = `${fg}\n${p}`;
      if (!schreibrecht.has(k)) {
        schreibrecht.set(k, ctx.api('dateien.liste', { freigabe: fg, pfad: p })
          .then((r) => ({ schreiben: schreibbarAus(r), eintraege: Array.isArray(r) ? r : (r && r.eintraege) || [] }))
          .catch((e) => ({ schreiben: false, fehler: e })));
      }
      return schreibrecht.get(k);
    };
    const sperren = (zeile, gesperrt) => {
      zeile.classList.toggle('ordnerwahl-gesperrt', gesperrt);
      if (gesperrt) zeile.setAttribute('aria-disabled', 'true'); else zeile.removeAttribute('aria-disabled');
    };
    const okSetzen = (frei, text = '') => {
      ok.disabled = !frei;
      hinweis.hidden = !text; hinweis.textContent = text;
    };

    const baum = el('ul', { class: 'dateien-baum', role: 'tree' });
    const knotenFuer = (fg, p, name, tiefe) => {
      const li = el('li', { role: 'treeitem', 'aria-expanded': 'false' });
      const kinder = el('ul', { role: 'group', hidden: true });
      let geladen = false;
      const auf = el('button', { class: 'dateien-baum-auf', type: 'button', 'aria-expanded': 'false', 'aria-label': t('dateien.aufklappen', { name }), onclick: async (ev) => {
        ev.stopPropagation();
        const offen = auf.getAttribute('aria-expanded') === 'true';
        auf.setAttribute('aria-expanded', offen ? 'false' : 'true'); li.setAttribute('aria-expanded', offen ? 'false' : 'true');
        kinder.hidden = offen;
        if (offen || geladen) return;
        geladen = true;
        kinder.appendChild(el('li', { class: 'schwach klein', text: t('rahmen.laden') }));
        const r = await liste(fg, p);
        kinder.textContent = '';
        if (nurSchreibbar) sperren(zeile, !r.schreiben);
        if (r.fehler) { kinder.appendChild(el('li', { class: 'schwach klein', text: ctx.fehlerText(r.fehler) })); return; }
        const ordner = r.eintraege.filter((e) => e && e.art === 'ordner' && !BUENDEL.test(e.name)).sort(nachName);
        const buendel = r.eintraege.filter((e) => e && e.art === 'ordner' && BUENDEL.test(e.name)).sort(nachName);
        const dateiListe = dateien ? r.eintraege.filter((e) => e && e.art !== 'ordner').sort(nachName) : [];
        if (!ordner.length && !buendel.length && !dateiListe.length) kinder.appendChild(el('li', { class: 'schwach klein', text: t(dateien ? 'dateien.ordnerwahl_leer' : 'dateien.keine_unterordner') }));
        for (const o of ordner) kinder.appendChild(knotenFuer(fg, verbinde(p, o.name), o.name, tiefe + 1));
        for (const b of buendel) kinder.appendChild(blattFuer(fg, verbinde(p, b.name), b.name, true));
        for (const f of dateiListe) kinder.appendChild(blattFuer(fg, verbinde(p, f.name), f.name, false));
      } }, [symbol('weiter')]);
      const waehle = async () => {
        if (dateien) { markieren(zeile, null); okSetzen(false, t('dateien.ordnerwahl_datei_waehlen')); return; } // Ordner ist keine Datei
        gewaehlt = { freigabe: fg, pfad: p };
        if (gewaehltZeile) gewaehltZeile.setAttribute('aria-selected', 'false');
        gewaehltZeile = zeile; zeile.setAttribute('aria-selected', 'true');
        zielText.hidden = false; zielText.textContent = t('dateien.ziel', { ziel: `${fg}/${p}` });
        if (!nurSchreibbar) { okSetzen(true); return; }
        okSetzen(false);
        const r = await liste(fg, p);
        if (gewaehltZeile !== zeile) return; // inzwischen anders gewählt
        sperren(zeile, !r.schreiben);
        okSetzen(r.schreiben, r.schreiben ? '' : (r.fehler ? ctx.fehlerText(r.fehler) : t('dateien.ordner_gesperrt')));
      };
      const zeile = el('div', { class: 'dateien-baum-zeile', 'aria-selected': 'false', tabindex: '0', onclick: () => waehle(),
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); waehle(); } } },
      [auf, symbol(tiefe === 0 ? 'freigaben' : 'ordner'), el('span', { class: 'dateien-baum-name', text: name })]);
      li.appendChild(zeile); li.appendChild(kinder);
      if (!dateien && start && start.freigabe === fg && (start.pfad || '') === p) waehle();
      return li;
    };
    /** Zeile als gewählt markieren; `ziel` = gewählte Datei oder null (dann ist nichts Gültiges gewählt). */
    function markieren(zeile, ziel) {
      gewaehlt = ziel;
      if (gewaehltZeile) gewaehltZeile.setAttribute('aria-selected', 'false');
      gewaehltZeile = zeile; zeile.setAttribute('aria-selected', 'true');
      zielText.hidden = !ziel; zielText.textContent = ziel ? t('dateien.ordnerwahl_datei', { datei: `${ziel.freigabe}/${ziel.pfad}` }) : '';
    }
    /** Blatt im Baum: eine Datei (nur mit `dateien`, wählbar) oder ein Office-Bündel (nie aufklappbar oder wählbar). */
    function blattFuer(fg, p, name, istBuendel) {
      const waehleBlatt = () => {
        if (istBuendel) { markieren(zeile, null); okSetzen(false, t('dateien.ordnerwahl_buendel')); return; }
        markieren(zeile, { freigabe: fg, pfad: p });
        okSetzen(true);
      };
      const zeile = el('div', {
        class: `dateien-baum-zeile ${istBuendel ? 'ordnerwahl-buendel ordnerwahl-gesperrt' : 'ordnerwahl-datei'}`, 'aria-selected': 'false', tabindex: '0',
        'aria-disabled': istBuendel ? 'true' : undefined, onclick: () => waehleBlatt(),
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); waehleBlatt(); } },
      }, [el('span', { class: 'dateien-baum-platz', 'aria-hidden': 'true' }), symbol(istBuendel ? buendelSymbol(name) : 'datei'), el('span', { class: 'dateien-baum-name', text: name })]);
      return el('li', { role: 'treeitem' }, [zeile]);
    }
    for (const f of freigaben) baum.appendChild(knotenFuer(f.name, '', f.name, 0));
    if (ladeFehler) baum.appendChild(el('li', { class: 'schwach klein', text: ctx.fehlerText(ladeFehler) }));
    else if (!freigaben.length) baum.appendChild(el('li', { class: 'schwach klein', text: t('dateien.keine_freigaben') }));
    // ein tieferes Startziel steht nicht im (eingeklappten) Baum: nur als Ziel vorwählen
    if (!dateien && start && start.pfad && freigaben.some((f) => f.name === start.freigabe)) {
      const fg = start.freigabe; const p = start.pfad;
      gewaehlt = { freigabe: fg, pfad: p };
      zielText.hidden = false; zielText.textContent = t('dateien.ziel', { ziel: `${fg}/${p}` });
      if (!nurSchreibbar) okSetzen(true);
      else liste(fg, p).then((r) => { if (!gewaehltZeile) okSetzen(r.schreiben, r.schreiben ? '' : t('dateien.ordner_gesperrt')); });
    }

    const d = ctx.dialog([
      erklaerung ? el('p', { class: 'erklaerung', text: erklaerung }) : null,
      baum, zielText, hinweis,
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit ordnerwahl-abbrechen', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
        ok,
      ]),
    ], { titel, beimSchliessen: () => aufloesen(ergebnis) });
  });
}
