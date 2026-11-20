// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kanban-Board (Plan 04, V18): Werkzeugleiste (Filter „Meine Karten“, Etikett, Fälligkeit, Archiv, Etiketten
// verwalten, Spalte hinzufügen), darunter die Spalten waagerecht scrollbar. Karten zeigen Etiketten, Fälligkeit,
// Zähler und Zuständige; sie lassen sich ziehen (Maus, Stift, Touch nach Halten) oder im Kartendialog verschieben.
// Jede Änderung geht als Op über die Sitzung; fremde Änderungen zeichnen das Board neu, eine fremde Auswahl zeigt
// einen farbigen Rand mit Namen. Wer nur lesen darf, bekommt keine Ziehgriffe und keine Bearbeiten-Knöpfe.

import { el, t, symbol } from '../../app.js';
import { zwischen, sortiert, ETIKETT_FARBEN } from '../../gemeinsam/sync/typen/board.js';
import { sichtbareKarten, mitglieder as mitgliederAus, heuteText } from './ansicht.js';
import { zielBerechnen, ziehenEinrichten } from './ziehen.js';
import { karteDialog, neueId, farbeSicher, datumText } from './karte-dialog.js';
import { avatarKnoten } from '../../avatar.js';

const POS_MAX = 64;
const KLICK_SPERRE_MS = 400;
const RAND_PX = 40;
const eigen = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

/** Board-Editor in `behaelter` einbinden (V18). Export gibt es für Boards nicht. */
export async function editorEinbinden(behaelter, { ctx, sitzung, recht }) {
  const ich = ctx.nutzer && ctx.nutzer.name;
  const z = {
    filter: { meine: false, etikett: null, faellig: null }, archiv: false,
    mitglieder: [sitzung.dok.besitzer].filter(Boolean), namen: new Map(),
    fremd: new Map(), ziehen: null, nachZiehen: false, geplant: false, weg: false, klickSperreBis: 0,
    entwuerfe: new Map(), // Spalte → Text der offenen „+ Karte“-Zeile
    recht: recht || sitzung.recht, ab: [], ziehAb: [], dialog: null,
  };
  if (ctx.nutzer && ctx.nutzer.anzeigename) z.namen.set(ich, ctx.nutzer.anzeigename);
  const darf = () => z.recht === 'bearbeiten';
  const anzeige = (n) => z.namen.get(n) || n;
  const aendern = (op) => { try { sitzung.lokal(op); return true; } catch (e) { ctx.zeigeFehler(e); return false; } };

  // ---- Werkzeugleiste (einmal gebaut, danach nur nachgeführt) ---------------------------------------------------
  const meine = el('button', { class: 'knopf knopf-zweit ob-filter-meine', type: 'button', 'aria-pressed': 'false', onclick: () => { z.filter.meine = !z.filter.meine; zeichnen(); } }, [symbol('nutzer'), t('office.board_filter_meine')]);
  const etikettFilter = el('select', { class: 'ob-filter-etikett', 'aria-label': t('office.board_filter_etikett') });
  etikettFilter.addEventListener('change', () => { z.filter.etikett = etikettFilter.value || null; zeichnen(); });
  const faelligFilter = el('select', { class: 'ob-filter-faellig', 'aria-label': t('office.board_filter_faellig') },
    ['', 'heute', 'ueberfaellig', 'woche'].map((w) => el('option', { value: w, text: t(`office.board_faellig_${w || 'alle'}`) })));
  faelligFilter.value = '';
  faelligFilter.addEventListener('change', () => { z.filter.faellig = faelligFilter.value || null; zeichnen(); });
  const archiv = el('button', { class: 'knopf knopf-zweit ob-archiv-umschalten', type: 'button', 'aria-pressed': 'false', onclick: () => { z.archiv = !z.archiv; zeichnen(); } }, [symbol('archiv'), t('office.board_archiv')]);
  const etikettenKnopf = el('button', { class: 'knopf knopf-zweit ob-etiketten-verwalten', type: 'button', onclick: () => etikettenDialog() }, t('office.board_etiketten_verwalten'));
  const spaltePlus = el('button', { class: 'knopf ob-spalte-plus', type: 'button', onclick: () => spalteHinzufuegen() }, [symbol('plus'), t('office.board_spalte_neu')]);
  const leiste = el('div', { class: 'ob-leiste', role: 'toolbar', 'aria-label': t('office.board_werkzeuge') });
  const spaltenBox = el('div', { class: 'ob-spalten' });
  const wurzel = el('div', { class: 'ob' }, [leiste, spaltenBox]);
  behaelter.appendChild(wurzel);
  let etikettStand = '';

  function leisteNachfuehren() {
    meine.setAttribute('aria-pressed', z.filter.meine ? 'true' : 'false');
    archiv.setAttribute('aria-pressed', z.archiv ? 'true' : 'false');
    const etiketten = Object.entries(sitzung.daten.etiketten || {}).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), 'de'));
    const stand = JSON.stringify(etiketten);
    if (stand !== etikettStand) {
      etikettStand = stand;
      etikettFilter.textContent = '';
      etikettFilter.appendChild(el('option', { value: '', text: t('office.board_etikett_alle') }));
      for (const [id, e] of etiketten) etikettFilter.appendChild(el('option', { value: id, text: e.name || t('office.board_etikett_ohne_name') }));
      if (z.filter.etikett && !etiketten.some(([id]) => id === z.filter.etikett)) z.filter.etikett = null;
    }
    etikettFilter.value = z.filter.etikett || '';
    etikettFilter.hidden = etikettFilter.children.length < 2;
    leiste.textContent = '';
    for (const k of [meine, etikettFilter, faelligFilter, archiv, darf() ? etikettenKnopf : null, darf() ? spaltePlus : null]) if (k) leiste.appendChild(k);
  }

  // ---- Zeichnen --------------------------------------------------------------------------------------------------
  function zeichnen() {
    z.geplant = false;
    if (z.weg) return;
    if (z.ziehen) { z.nachZiehen = true; return; } // während des Ziehens nicht umbauen
    for (const x of z.ziehAb) x();
    z.ziehAb = [];
    leisteNachfuehren();
    const daten = sitzung.daten;
    const aktiv = typeof document !== 'undefined' ? document.activeElement : null;
    const fokusSpalte = aktiv && aktiv.classList && aktiv.classList.contains('ob-neue-karte') ? aktiv.closest?.('.ob-spalte')?.dataset.id || null : null;
    spaltenBox.textContent = '';
    wurzel.classList.toggle('ob-archivansicht', z.archiv);
    const liste = sichtbareKarten(daten, { filter: z.filter, nutzer: ich, heute: heuteText(), archiv: z.archiv });
    if (z.archiv) { spaltenBox.appendChild(archivElement(liste[0].karten, daten)); return; }
    if (!liste.length) spaltenBox.appendChild(el('p', { class: 'leer', text: t('office.board_keine_spalten') }));
    for (const { spalte, karten } of liste) spaltenBox.appendChild(spalteElement(spalte, karten, daten, fokusSpalte === spalte.id));
  }
  const zeichnenBald = () => { if (z.geplant || z.weg) return; z.geplant = true; queueMicrotask(zeichnen); };

  function karteElement(k, daten, ziehbar) {
    const heute = heuteText();
    const etiketten = (k.etiketten || []).map((id) => eigen(daten.etiketten, id)).filter(Boolean);
    const erledigt = k.checkliste.filter((p) => p.erledigt).length;
    const fremd = [...z.fremd.values()].find((f) => f.karte === k.id);
    const kn = el('div', {
      class: `ob-karte${fremd ? ' ob-fremd' : ''}${k.archiviert ? ' ob-archiviert' : ''}`, role: 'listitem', tabindex: '0', 'data-id': k.id,
      'aria-label': k.titel || t('office.board_ohne_titel'), style: fremd ? { '--farbe': fremd.farbe } : undefined,
      onclick: () => { if (Date.now() >= z.klickSperreBis) oeffnen(k.id); },
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); oeffnen(k.id); } },
    }, [
      etiketten.length ? el('ul', { class: 'ob-etiketten', role: 'list' }, etiketten.map((e) => el('li', { class: `ob-etikett ob-etikett-${farbeSicher(e.farbe)}`, text: e.name }))) : null,
      el('p', { class: 'ob-karte-titel', text: k.titel || t('office.board_ohne_titel') }),
      el('div', { class: 'ob-karte-info' }, [
        k.faellig ? el('span', { class: `ob-faellig${k.faellig < heute ? ' warnung' : k.faellig === heute ? ' heute' : ''}`, title: t('office.board_faellig') }, [symbol('uhr'), datumText(k.faellig)]) : null,
        k.checkliste.length ? el('span', { class: 'ob-zaehler', title: t('office.board_checkliste') }, [symbol('haken'), `${erledigt}/${k.checkliste.length}`]) : null,
        k.kommentare.length ? el('span', { class: 'ob-zaehler', title: t('office.board_kommentare') }, [symbol('chat'), String(k.kommentare.length)]) : null,
        k.anhaenge.length ? el('span', { class: 'ob-zaehler', title: t('office.board_anhaenge') }, [symbol('anhang'), String(k.anhaenge.length)]) : null,
        k.zustaendig.length ? el('span', { class: 'ob-personen' }, k.zustaendig.map((n) => avatarKnoten({ name: n, anzeige: anzeige(n), groesse: 24, klasse: 'ob-person', titel: anzeige(n) }))) : null, // Avatare (0.22.0)
      ]),
      fremd ? el('span', { class: 'ob-fremd-name', text: fremd.name }) : null,
    ]);
    if (ziehbar) z.ziehAb.push(ziehenFuer(kn, k.id));
    return kn;
  }

  function spalteElement(spalte, karten, daten, fokus) {
    const kopf = el('header', { class: 'ob-spalte-kopf' }, [
      el('h2', { class: 'ob-spalte-titel', text: spalte.titel, title: spalte.titel, ondblclick: () => { if (darf()) spalteUmbenennen(spalte); } }),
      el('span', { class: 'ob-anzahl', 'aria-label': t('office.board_anzahl', { n: karten.length }), text: String(karten.length) }),
      darf() ? el('button', { class: 'knopf-symbol ob-spalte-menue', type: 'button', 'aria-label': t('office.board_spalte_menue', { name: spalte.titel }), title: t('office.board_spalte_menue', { name: spalte.titel }), onclick: () => spaltenMenue(spalte) }, [symbol('menue')]) : null,
    ]);
    const liste = el('div', { class: 'ob-karten', role: 'list' }, karten.map((k) => karteElement(k, daten, darf())));
    const knoten = el('section', { class: 'ob-spalte', 'data-id': spalte.id, 'aria-label': spalte.titel }, [kopf, liste]);
    if (darf()) knoten.appendChild(fussElement(spalte, fokus));
    return knoten;
  }

  /** „+ Karte“: Knopf oder (offen) Eingabezeile; Enter legt an und lässt die Zeile für die nächste offen. */
  function fussElement(spalte, fokus) {
    const fuss = el('div', { class: 'ob-spalte-fuss' });
    const zeigen = () => {
      fuss.textContent = '';
      if (!z.entwuerfe.has(spalte.id)) {
        fuss.appendChild(el('button', { class: 'knopf knopf-zweit ob-karte-plus', type: 'button', onclick: () => { z.entwuerfe.set(spalte.id, ''); zeigen(); eingabeFokus(); } }, [symbol('plus'), t('office.board_karte_neu')]));
        return;
      }
      const eingabe = el('input', { class: 'eingabe ob-neue-karte', type: 'text', maxlength: 200, value: z.entwuerfe.get(spalte.id), placeholder: t('office.board_karte_titel_platzhalter'), 'aria-label': t('office.board_karte_neu') });
      eingabe.addEventListener('input', () => z.entwuerfe.set(spalte.id, eingabe.value));
      eingabe.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); karteAnlegen(spalte.id, eingabe); }
        if (ev.key === 'Escape') { ev.preventDefault(); z.entwuerfe.delete(spalte.id); zeigen(); }
      });
      fuss.appendChild(el('div', { class: 'ob-neue-karte-zeile' }, [
        eingabe,
        el('button', { class: 'knopf ob-neue-karte-ok', type: 'button', onclick: () => karteAnlegen(spalte.id, eingabe) }, t('office.board_anlegen')),
        el('button', { class: 'knopf-symbol ob-neue-karte-zu', type: 'button', 'aria-label': t('rahmen.abbrechen'), onclick: () => { z.entwuerfe.delete(spalte.id); zeigen(); } }, [symbol('schliessen')]),
      ]));
    };
    const eingabeFokus = () => { const e = fuss.querySelector('.ob-neue-karte'); if (e) try { e.focus(); } catch { /* egal */ } };
    zeigen();
    if (fokus) eingabeFokus();
    return fuss;
  }

  function karteAnlegen(spalteId, eingabe) {
    const titel = eingabe.value.trim().slice(0, 200);
    if (!titel) return;
    const letzte = sortiert(Object.values(sitzung.daten.karten || {}).filter((k) => k.spalte === spalteId && !k.archiviert)).at(-1);
    const pos = zwischen(letzte ? letzte.pos : null, null);
    if (pos.length > POS_MAX) { ctx.melden(t('office.board_zu_eng'), 'warnung'); return; }
    const ok = aendern({ typ: 'karte_neu', karte: { id: neueId(), spalte: spalteId, pos, titel, erstellt: new Date().toISOString(), ersteller: ich } });
    if (ok) { eingabe.value = ''; z.entwuerfe.set(spalteId, ''); }
  }

  function archivElement(karten, daten) {
    return el('section', { class: 'ob-archiv' }, [
      el('h2', { text: t('office.board_archiv') }),
      el('p', { class: 'erklaerung', text: t('office.board_archiv_erklaerung') }),
      karten.length ? el('div', { class: 'ob-karten ob-archiv-liste', role: 'list' }, karten.map((k) => karteElement(k, daten, false))) : el('p', { class: 'leer', text: t('office.board_archiv_leer') }),
    ]);
  }

  // ---- Ziehen ----------------------------------------------------------------------------------------------------
  function geometrie() {
    return [...spaltenBox.querySelectorAll('.ob-spalte')].map((s) => {
      const r = s.getBoundingClientRect();
      return { id: s.dataset.id, links: r.left, rechts: r.right, karten: [...s.querySelectorAll('.ob-karte')].map((k) => { const kr = k.getBoundingClientRect(); return { id: k.dataset.id, oben: kr.top, unten: kr.bottom }; }) };
    });
  }
  const markeWeg = () => { for (const m of [...spaltenBox.querySelectorAll('.ob-ziel-marke')]) m.remove(); };
  function markeSetzen(ziel) {
    markeWeg();
    if (!ziel) return;
    const spalte = spaltenBox.querySelector(`.ob-spalte[data-id="${ziel.spalte}"] .ob-karten`);
    if (!spalte) return;
    const marke = el('div', { class: 'ob-ziel-marke', 'aria-hidden': 'true' });
    const nach = ziel.nach ? spalte.querySelector(`.ob-karte[data-id="${ziel.nach}"]`) : null;
    if (nach) spalte.insertBefore(marke, nach); else spalte.appendChild(marke);
  }
  function randScrollen(x) {
    const r = spaltenBox.getBoundingClientRect();
    if (!r || !r.width) return;
    if (x < r.left + RAND_PX) spaltenBox.scrollLeft -= 24; else if (x > r.right - RAND_PX) spaltenBox.scrollLeft += 24;
  }
  function ziehenFuer(kn, id) {
    return ziehenEinrichten(kn, {
      beiStart: ({ x, y }) => {
        z.ziehen = { id, x0: x, y0: y };
        kn.classList.add('ob-zieht'); wurzel.classList.add('ob-ziehmodus');
      },
      beiZug: ({ x, y }) => {
        if (!z.ziehen) return;
        kn.style.transform = `translate(${Math.round(x - z.ziehen.x0)}px, ${Math.round(y - z.ziehen.y0)}px)`;
        randScrollen(x);
        markeSetzen(zielBerechnen(geometrie(), x, y, id));
      },
      beiEnde: ({ x, y, abgebrochen }) => {
        const geo = abgebrochen ? null : geometrie();
        kn.classList.remove('ob-zieht'); wurzel.classList.remove('ob-ziehmodus'); kn.style.transform = '';
        markeWeg();
        z.ziehen = null; z.klickSperreBis = Date.now() + KLICK_SPERRE_MS;
        if (geo) verschieben(id, zielBerechnen(geo, x, y, id), geo);
        if (z.nachZiehen) { z.nachZiehen = false; zeichnenBald(); }
      },
    });
  }

  /** Karte an das Ziel setzen: Position zwischen den Nachbarn; zu lang (> 64 Zeichen) → ans Ende der Spalte. */
  function verschieben(id, ziel, geo) {
    if (!ziel) return;
    const daten = sitzung.daten;
    const k = eigen(daten.karten, id);
    if (!k) return;
    const bisher = geo.find((s) => s.karten.some((x) => x.id === id));
    if (bisher && bisher.id === ziel.spalte && k.spalte === ziel.spalte) {
      const i = bisher.karten.findIndex((x) => x.id === id);
      const vor = i > 0 ? bisher.karten[i - 1].id : null;
      const nach = i < bisher.karten.length - 1 ? bisher.karten[i + 1].id : null;
      if (vor === ziel.vor && nach === ziel.nach) return; // dieselbe Stelle
    }
    const posVon = (kid) => (kid ? (eigen(daten.karten, kid) || {}).pos ?? null : null);
    let pos = zwischen(posVon(ziel.vor), posVon(ziel.nach));
    if (pos.length > POS_MAX) {
      const letzte = sortiert(Object.values(daten.karten).filter((x) => x.spalte === ziel.spalte && x.id !== id && !x.archiviert)).at(-1);
      pos = zwischen(letzte ? letzte.pos : null, null);
    }
    if (pos.length > POS_MAX) { ctx.melden(t('office.board_zu_eng'), 'warnung'); return; }
    aendern({ typ: 'karte_verschieben', id, spalte: ziel.spalte, pos });
  }

  // ---- Dialoge ---------------------------------------------------------------------------------------------------
  function oeffnen(id) {
    if (z.dialog) { try { z.dialog.schliessen(); } catch { /* egal */ } }
    z.dialog = karteDialog(ctx, sitzung, id, { mitglieder: z.mitglieder, namen: z.namen, recht: z.recht });
  }

  async function spalteHinzufuegen() {
    const titel = await ctx.eingabe({ titel: t('office.board_spalte_neu'), beschriftung: t('office.board_spalte_name'), maxlaenge: 80, ok: t('office.board_anlegen') });
    if (!titel) return;
    const letzte = sortiert(sitzung.daten.spalten || []).at(-1);
    const pos = zwischen(letzte ? letzte.pos : null, null);
    if (pos.length > POS_MAX) { ctx.melden(t('office.board_zu_eng'), 'warnung'); return; }
    aendern({ typ: 'spalte_neu', spalte: { id: neueId(), titel: titel.slice(0, 80), pos } });
  }

  async function spalteUmbenennen(spalte) {
    const titel = await ctx.eingabe({ titel: t('office.board_spalte_umbenennen'), beschriftung: t('office.board_spalte_name'), wert: spalte.titel, maxlaenge: 80 });
    if (titel && titel !== spalte.titel) aendern({ typ: 'spalte_setzen', id: spalte.id, titel: titel.slice(0, 80) });
  }

  function spalteVerschieben(spalte, richtung) {
    const spalten = sortiert(sitzung.daten.spalten || []);
    const i = spalten.findIndex((s) => s.id === spalte.id);
    let pos = null;
    if (richtung < 0 && i > 0) pos = zwischen(i > 1 ? spalten[i - 2].pos : null, spalten[i - 1].pos);
    if (richtung > 0 && i >= 0 && i < spalten.length - 1) pos = zwischen(spalten[i + 1].pos, i < spalten.length - 2 ? spalten[i + 2].pos : null);
    if (!pos) return;
    if (pos.length > POS_MAX) { ctx.melden(t('office.board_zu_eng'), 'warnung'); return; }
    aendern({ typ: 'spalte_verschieben', id: spalte.id, pos });
  }

  function spaltenMenue(spalte) {
    const spalten = sortiert(sitzung.daten.spalten || []);
    const i = spalten.findIndex((s) => s.id === spalte.id);
    const knopf = (klasse, text, sym, fn, aus = false) => el('button', { class: `knopf knopf-zweit ${klasse}`, type: 'button', disabled: aus, onclick: () => { d.schliessen(); fn(); } }, [sym ? symbol(sym) : null, text]);
    const d = ctx.dialog(el('div', { class: 'ob-menue' }, [
      knopf('ob-spalte-umbenennen', t('office.board_spalte_umbenennen'), 'umbenennen', () => spalteUmbenennen(spalte)),
      knopf('ob-spalte-links', t('office.board_spalte_links'), 'zurueck', () => spalteVerschieben(spalte, -1), i <= 0),
      knopf('ob-spalte-rechts', t('office.board_spalte_rechts'), 'weiter', () => spalteVerschieben(spalte, 1), i < 0 || i >= spalten.length - 1),
      knopf('ob-spalte-loeschen knopf-gefahr', t('office.board_spalte_loeschen'), 'loeschen', async () => {
        const karten = sortiert(Object.values(sitzung.daten.karten || {}).filter((k) => k.spalte === spalte.id)).map((k) => k.id);
        const ja = await ctx.bestaetigen(t('office.board_spalte_loeschen_frage', { name: spalte.titel, anzahl: karten.length }), { titel: t('office.board_spalte_loeschen'), ok: t('office.board_loeschen'), gefahr: true });
        if (ja) aendern({ typ: 'spalte_loeschen', id: spalte.id, karten });
      }),
    ]), { titel: spalte.titel });
  }

  function etikettenDialog() {
    const liste = el('ul', { class: 'ob-etiketten-liste', role: 'list' });
    const farbWahl = (wert, klasse) => {
      const s = el('select', { class: klasse, 'aria-label': t('office.board_etikett_farbe') }, ETIKETT_FARBEN.map((f) => el('option', { value: f, text: t(`office.board_farbe_${f}`) })));
      s.value = farbeSicher(wert);
      return s;
    };
    const zeichnenListe = () => {
      liste.textContent = '';
      const etiketten = Object.entries(sitzung.daten.etiketten || {}).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), 'de'));
      for (const [id, e] of etiketten) {
        const name = el('input', { class: 'eingabe ob-etikett-name', type: 'text', maxlength: 40, value: e.name || '', 'aria-label': t('office.board_etikett_name') });
        name.addEventListener('change', () => { const v = name.value.trim().slice(0, 40); if (v !== e.name) aendern({ typ: 'etikett', id, etikett: { name: v } }); });
        const farbe = farbWahl(e.farbe, 'ob-etikett-farbe');
        farbe.addEventListener('change', () => aendern({ typ: 'etikett', id, etikett: { farbe: farbe.value } }));
        liste.appendChild(el('li', { class: 'ob-etikett-zeile', 'data-id': id }, [
          el('span', { class: `ob-etikett ob-etikett-${farbeSicher(e.farbe)}`, text: e.name || t('office.board_etikett_ohne_name') }), name, farbe,
          el('button', { class: 'knopf-symbol ob-etikett-weg', type: 'button', 'aria-label': t('office.board_entfernen'), onclick: () => aendern({ typ: 'etikett', id, etikett: { weg: true } }) }, [symbol('loeschen')]),
        ]));
      }
      if (!etiketten.length) liste.appendChild(el('li', { class: 'schwach klein', text: t('office.board_keine_etiketten') }));
    };
    const neuName = el('input', { class: 'eingabe ob-etikett-neu-name', type: 'text', maxlength: 40, placeholder: t('office.board_etikett_name'), 'aria-label': t('office.board_etikett_name') });
    const neuFarbe = farbWahl('blau', 'ob-etikett-neu-farbe');
    const neu = () => {
      const name = neuName.value.trim().slice(0, 40);
      if (!name) return;
      if (aendern({ typ: 'etikett', id: neueId(), etikett: { name, farbe: neuFarbe.value } })) neuName.value = '';
    };
    zeichnenListe();
    const ab = sitzung.on('aenderung', ({ op }) => { if (op && op.typ === 'etikett') zeichnenListe(); });
    ctx.dialog([
      el('p', { class: 'erklaerung', text: t('office.board_etiketten_erklaerung') }),
      liste,
      el('div', { class: 'knopf-reihe ob-etikett-neu' }, [neuName, neuFarbe, el('button', { class: 'knopf ob-etikett-hinzu', type: 'button', onclick: neu }, [symbol('plus'), t('office.board_hinzufuegen')])]),
    ], { titel: t('office.board_etiketten_verwalten'), beimSchliessen: () => ab() });
  }

  // ---- Mitglieder, Ereignisse ------------------------------------------------------------------------------------
  async function mitgliederLaden() {
    try {
      const r = await ctx.api('office.freigaben', { id: sitzung.dok.id });
      if (z.weg) return;
      z.mitglieder = mitgliederAus(r, sitzung.dok.besitzer);
      for (const g of (r && r.geteilt_mit) || []) if (g && g.name) z.namen.set(g.name, g.anzeigename || g.name);
    } catch { /* Besitzer bleibt einziges Mitglied */ }
  }

  z.ab.push(
    sitzung.on('aenderung', () => zeichnenBald()),
    sitzung.on('auswahl', (a) => {
      if (!a || !a.von) return;
      if (a.auswahl && a.auswahl.karte) z.fremd.set(a.von, { karte: a.auswahl.karte, name: a.name || a.nutzer || '', farbe: a.farbe || '' });
      else z.fremd.delete(a.von);
      zeichnenBald();
    }),
    sitzung.on('recht', ({ recht: neu } = {}) => { z.recht = neu || sitzung.recht; mitgliederLaden(); zeichnenBald(); }),
  );
  zeichnen();
  await mitgliederLaden();

  return {
    exportformate: [],
    exportieren: async () => { throw new Error('kein_export'); },
    verlassen() {
      z.weg = true;
      for (const x of [...z.ab, ...z.ziehAb]) { try { x(); } catch { /* egal */ } }
      z.ab = []; z.ziehAb = [];
      if (z.dialog) { try { z.dialog.schliessen(); } catch { /* egal */ } z.dialog = null; }
      wurzel.remove();
    },
  };
}
