// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kartendialog des Boards (Plan 04): Titel, Beschreibung (Bearbeiten/Ansicht mit Markdown), Zuständige, Fälligkeit,
// Etiketten, Spalte und „Nach oben/unten“ (Tastaturweg statt Ziehen), Checkliste, Kommentare, Anhänge (hochladen oder
// aus dem NAS kopieren), Archivieren und Löschen. Textfelder senden nach 500 ms Ruhe, beim Verlassen und beim
// Schließen. Wer nur lesen darf, sieht alles ohne Bedienelemente zum Ändern. Solange der Dialog offen ist, sehen die
// anderen die Karte als „ausgewählt“.

import { el, t, symbol, format } from '../../app.js';
import { markdownZuKnoten } from '../../markdown.js';
import { zwischen, sortiert, ETIKETT_FARBEN } from '../../gemeinsam/sync/typen/board.js';
import { DATEI_MAX_BYTES } from '../../gemeinsam/sync/konstanten.js';
import { avatarKnoten } from '../../avatar.js';

const RUHE_MS = 500;
const POS_MAX = 64;
const MIME = /^[A-Za-z0-9.+-]{1,60}\/[A-Za-z0-9.+-]{1,60}$/;
const ID_ZEICHEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const eigen = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

/** Neue ID für Karten, Spalten, Etiketten, Checkpunkte und Kommentare (12 Zeichen). */
export function neueId() {
  const z = new Uint8Array(12); globalThis.crypto.getRandomValues(z);
  return [...z].map((b) => ID_ZEICHEN[b & 63]).join('');
}

/** Dateiart in der Form, die das Board annimmt; alles andere → application/octet-stream. */
export function mimeSicher(m) {
  const x = String(m || '').split(';')[0].trim().toLowerCase();
  return MIME.test(x) ? x : 'application/octet-stream';
}

export const farbeSicher = (f) => (ETIKETT_FARBEN.includes(f) ? f : 'grau');

/** Datum „JJJJ-MM-TT“ kurz in der Sprache der Oberfläche. */
export function datumText(datum) {
  const d = new Date(`${datum}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(datum || '');
  const gebiet = typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE';
  return d.toLocaleDateString(gebiet, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Karten einer Spalte ohne Archiv, nach Position. */
export function kartenDerSpalte(daten, spalte, ohne = null) {
  return sortiert(Object.values(daten.karten || {}).filter((k) => k && k.spalte === spalte && !k.archiviert && k.id !== ohne));
}

/**
 * Kartendialog öffnen → {schliessen(), element} | null (Karte gibt es nicht). `mitglieder` = Board-Mitglieder
 * (Namen), `namen` = Map Name → Anzeigename.
 */
export function karteDialog(ctx, sitzung, karteId, { mitglieder = [], namen = new Map(), recht } = {}) {
  const ich = ctx.nutzer && ctx.nutzer.name;
  const meinName = (ctx.nutzer && (ctx.nutzer.anzeigename || ctx.nutzer.name)) || ich;
  const darf = (recht ?? sitzung.recht) === 'bearbeiten';
  const karte = () => eigen(sitzung.daten && sitzung.daten.karten, karteId);
  if (!karte()) return null;
  const anzeige = (n) => namen.get(n) || (n === ich ? meinName : n);
  // Autor eines Kommentars: der vom Server geprüfte Anmeldename („wer“), nie der mitgeschickte Anzeigename
  const autor = (wer) => namen.get(wer) || (wer === ich ? meinName : wer);
  const ab = [];
  const sender = new Map(); // Feldname → senden() (schickt Ausstehendes sofort)
  const zeitgeber = new Map();
  let zu = false; let selbstGeloescht = false;

  const aendern = (op) => { try { sitzung.lokal(op); return true; } catch (e) { ctx.zeigeFehler(e); return false; } };
  const setzen = (felder) => aendern({ typ: 'karte_setzen', id: karteId, felder });
  const fokussiert = (feld) => typeof document !== 'undefined' && document.activeElement === feld;

  /** Textfeld: nach 500 ms Ruhe, beim Verlassen und beim Schließen senden – nur wenn der Text anders ist. */
  function textFeld(feld, name, max) {
    const senden = () => {
      const tm = zeitgeber.get(name);
      if (tm) { clearTimeout(tm); zeitgeber.delete(name); }
      const k = karte();
      if (!k || !darf) return;
      const wert = feld.value.slice(0, max);
      if (wert !== k[name]) setzen({ [name]: wert });
    };
    feld.addEventListener('input', () => {
      const tm = zeitgeber.get(name);
      if (tm) clearTimeout(tm);
      zeitgeber.set(name, setTimeout(senden, RUHE_MS));
    });
    feld.addEventListener('blur', senden);
    sender.set(name, senden);
    return feld;
  }
  const alleSenden = () => { for (const s of [...sender.values()]) s(); };

  // ---- Titel und Beschreibung ----------------------------------------------------------------------------------
  const titel = el('input', { class: 'eingabe ob-titel-feld', type: 'text', maxlength: 200, 'aria-label': t('office.board_titel'), readOnly: !darf });
  if (darf) textFeld(titel, 'titel', 200);
  const beschreibungBox = el('div', { class: 'ob-beschreibung' });
  let beschreibungBearbeiten = darf && !karte().beschreibung;
  let beschreibungFeld = null;
  function beschreibungZeichnen() {
    const k = karte();
    beschreibungBox.textContent = '';
    if (beschreibungBearbeiten && darf) {
      beschreibungFeld = el('textarea', { class: 'eingabe ob-beschreibung-feld', rows: 6, maxlength: 20000, 'aria-label': t('office.board_beschreibung') });
      beschreibungFeld.value = k.beschreibung || '';
      textFeld(beschreibungFeld, 'beschreibung', 20000);
      beschreibungBox.appendChild(beschreibungFeld);
      beschreibungBox.appendChild(el('button', { class: 'knopf knopf-zweit ob-beschreibung-umschalten', type: 'button', onclick: () => {
        const s = sender.get('beschreibung'); if (s) s();
        sender.delete('beschreibung'); beschreibungFeld = null; beschreibungBearbeiten = false; beschreibungZeichnen();
      } }, t('office.board_ansicht')));
      return;
    }
    beschreibungFeld = null;
    const ansicht = el('div', { class: 'ob-beschreibung-ansicht' });
    if (k.beschreibung) ansicht.appendChild(markdownZuKnoten(k.beschreibung, { modus: 'voll' }));
    else ansicht.appendChild(el('p', { class: 'schwach', text: t('office.board_keine_beschreibung') }));
    beschreibungBox.appendChild(ansicht);
    if (darf) beschreibungBox.appendChild(el('button', { class: 'knopf knopf-zweit ob-beschreibung-umschalten', type: 'button', onclick: () => { beschreibungBearbeiten = true; beschreibungZeichnen(); } }, [symbol('umbenennen'), t('office.board_bearbeiten')]));
  }

  // ---- Zuständige, Fälligkeit, Etiketten, Spalte ---------------------------------------------------------------
  const zustaendig = el('div', { class: 'ob-zustaendig' });
  const faellig = el('input', { class: 'eingabe ob-faellig-feld', type: 'date', 'aria-label': t('office.board_faellig'), disabled: !darf });
  faellig.addEventListener('change', () => { const v = faellig.value || null; if (v !== (karte().faellig ?? null)) setzen({ faellig: v }); });
  const faelligLeeren = darf ? el('button', { class: 'knopf knopf-zweit ob-faellig-leeren', type: 'button', onclick: () => { if (karte().faellig) setzen({ faellig: null }); } }, t('office.board_faellig_leeren')) : null;
  const etiketten = el('div', { class: 'ob-etikett-auswahl' });
  const spalteWahl = el('select', { class: 'ob-spalte-wahl', 'aria-label': t('office.board_spalte'), disabled: !darf });
  spalteWahl.addEventListener('change', () => {
    const ziel = spalteWahl.value;
    const k = karte();
    if (!k || ziel === k.spalte) return;
    const letzte = kartenDerSpalte(sitzung.daten, ziel, karteId).at(-1);
    const pos = zwischen(letzte ? letzte.pos : null, null);
    if (pos.length <= POS_MAX) aendern({ typ: 'karte_verschieben', id: karteId, spalte: ziel, pos });
  });
  const schieben = (richtung) => {
    const k = karte();
    const liste = kartenDerSpalte(sitzung.daten, k.spalte);
    const i = liste.findIndex((x) => x.id === karteId);
    if (i < 0) return;
    let pos = null;
    if (richtung < 0 && i > 0) pos = zwischen(i > 1 ? liste[i - 2].pos : null, liste[i - 1].pos);
    if (richtung > 0 && i < liste.length - 1) pos = zwischen(liste[i + 1].pos, i < liste.length - 2 ? liste[i + 2].pos : null);
    if (pos && pos.length <= POS_MAX) aendern({ typ: 'karte_verschieben', id: karteId, spalte: k.spalte, pos });
  };
  const nachOben = darf ? el('button', { class: 'knopf knopf-zweit ob-nach-oben', type: 'button', onclick: () => schieben(-1) }, [symbol('hoch'), t('office.board_nach_oben')]) : null;
  const nachUnten = darf ? el('button', { class: 'knopf knopf-zweit ob-nach-unten', type: 'button', onclick: () => schieben(1) }, t('office.board_nach_unten')) : null;

  function zustaendigZeichnen(k) {
    zustaendig.textContent = '';
    const alle = [...new Set([...mitglieder, ...k.zustaendig])].sort((a, b) => a.localeCompare(b, 'de'));
    for (const n of alle) {
      const box = el('input', { type: 'checkbox', 'data-nutzer': n, checked: k.zustaendig.includes(n), disabled: !darf });
      box.addEventListener('change', () => {
        const jetzt = new Set(karte().zustaendig);
        if (box.checked) jetzt.add(n); else jetzt.delete(n);
        setzen({ zustaendig: alle.filter((x) => jetzt.has(x)) });
      });
      zustaendig.appendChild(el('label', { class: 'ob-zustaendig-zeile' }, [box, avatarKnoten({ name: n, anzeige: anzeige(n), groesse: 24 }), el('span', { text: anzeige(n) })]));
    }
    if (!alle.length) zustaendig.appendChild(el('p', { class: 'schwach klein', text: t('office.board_keine_mitglieder') }));
  }

  function etikettenZeichnen(k) {
    etiketten.textContent = '';
    const alle = Object.entries(sitzung.daten.etiketten || {}).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), 'de'));
    for (const [id, e] of alle) {
      const an = k.etiketten.includes(id);
      etiketten.appendChild(el('button', {
        class: `ob-etikett ob-etikett-${farbeSicher(e.farbe)} ob-etikett-wahl${an ? ' an' : ''}`, type: 'button', 'data-id': id, 'aria-pressed': an ? 'true' : 'false', disabled: !darf,
        onclick: () => { const jetzt = karte().etiketten; setzen({ etiketten: an ? jetzt.filter((x) => x !== id) : [...jetzt, id] }); },
      }, [an ? symbol('haken') : null, e.name || t('office.board_etikett_ohne_name')]));
    }
    if (!alle.length) etiketten.appendChild(el('p', { class: 'schwach klein', text: t('office.board_keine_etiketten') }));
  }

  function spalteZeichnen(k) {
    const spalten = sortiert(sitzung.daten.spalten || []);
    spalteWahl.textContent = '';
    for (const s of spalten) spalteWahl.appendChild(el('option', { value: s.id, text: s.titel }));
    spalteWahl.value = spalten.some((s) => s.id === k.spalte) ? k.spalte : (spalten[0] ? spalten[0].id : '');
  }

  // ---- Checkliste ------------------------------------------------------------------------------------------------
  const checkliste = el('ul', { class: 'ob-checkliste', role: 'list' });
  const punktNeu = darf ? el('input', { class: 'eingabe ob-punkt-neu', type: 'text', maxlength: 500, 'aria-label': t('office.board_punkt_neu'), placeholder: t('office.board_punkt_neu') }) : null;
  const punktHinzu = () => {
    const text = punktNeu.value.trim();
    if (!text) return;
    const letzte = karte().checkliste.at(-1);
    const pos = zwischen(letzte ? letzte.pos : null, null);
    if (pos.length > POS_MAX) return;
    if (aendern({ typ: 'checkliste', karte: karteId, eintrag: { id: neueId(), text, pos, neu: true } })) punktNeu.value = '';
  };
  if (punktNeu) punktNeu.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); punktHinzu(); } });
  function checklisteZeichnen(k) {
    checkliste.textContent = '';
    for (const p of k.checkliste) {
      const haken = el('input', { type: 'checkbox', checked: p.erledigt, disabled: !darf, 'aria-label': p.text });
      haken.addEventListener('change', () => aendern({ typ: 'checkliste', karte: karteId, eintrag: { id: p.id, erledigt: haken.checked } }));
      checkliste.appendChild(el('li', { class: `ob-punkt${p.erledigt ? ' erledigt' : ''}`, 'data-id': p.id }, [
        el('label', { class: 'ob-punkt-text' }, [haken, el('span', { text: p.text })]),
        darf ? el('button', { class: 'knopf-symbol ob-punkt-umbenennen', type: 'button', 'aria-label': t('office.board_punkt_umbenennen'), onclick: async () => {
          const neu = await ctx.eingabe({ titel: t('office.board_punkt_umbenennen'), beschriftung: t('office.board_punkt'), wert: p.text, maxlaenge: 500 });
          if (neu && neu !== p.text) aendern({ typ: 'checkliste', karte: karteId, eintrag: { id: p.id, text: neu } });
        } }, [symbol('umbenennen')]) : null,
        darf ? el('button', { class: 'knopf-symbol ob-punkt-weg', type: 'button', 'aria-label': t('office.board_entfernen'), onclick: () => aendern({ typ: 'checkliste', karte: karteId, eintrag: { id: p.id, weg: true } }) }, [symbol('loeschen')]) : null,
      ]));
    }
  }

  // ---- Kommentare ------------------------------------------------------------------------------------------------
  const kommentare = el('ul', { class: 'ob-kommentare', role: 'list' });
  const kommentarNeu = darf ? el('textarea', { class: 'eingabe ob-kommentar-neu', rows: 2, maxlength: 5000, 'aria-label': t('office.board_kommentar_neu'), placeholder: t('office.board_kommentar_neu') }) : null;
  const kommentarSenden = () => {
    const text = kommentarNeu.value.trim();
    if (!text) return;
    const kommentar = { id: neueId(), wer: ich, name: String(meinName).slice(0, 200), zeit: new Date().toISOString(), text };
    if (aendern({ typ: 'kommentar', karte: karteId, kommentar })) kommentarNeu.value = '';
  };
  function kommentareZeichnen(k) {
    kommentare.textContent = '';
    for (const c of k.kommentare) {
      kommentare.appendChild(el('li', { class: 'ob-kommentar', 'data-id': c.id }, [
        el('div', { class: 'ob-kommentar-kopf' }, [
          el('strong', { text: autor(c.wer) }), el('span', { class: 'schwach klein', text: format.zeit(c.zeit) }),
          darf && c.wer === ich ? el('button', { class: 'knopf-symbol ob-kommentar-loeschen', type: 'button', 'aria-label': t('office.board_kommentar_loeschen'), onclick: () => aendern({ typ: 'kommentar', karte: karteId, kommentar: { id: c.id, wer: ich, weg: true } }) }, [symbol('loeschen')]) : null,
        ]),
        el('p', { class: 'ob-kommentar-text', text: c.text }),
      ]));
    }
    if (!k.kommentare.length) kommentare.appendChild(el('li', { class: 'schwach klein', text: t('office.board_keine_kommentare') }));
  }

  // ---- Anhänge ---------------------------------------------------------------------------------------------------
  const anhaenge = el('ul', { class: 'ob-anhaenge', role: 'list' });
  const anhangDazu = (r, groesse, mime) => aendern({ typ: 'anhang', karte: karteId, anhang: { datei: r.datei, name: String(r.name || '').slice(0, 200), groesse: Number.isInteger(groesse) && groesse >= 0 ? groesse : 0, mime: mimeSicher(mime) } });
  const anhangDatei = darf ? el('input', { class: 'ob-anhang-datei', type: 'file', multiple: true, hidden: true }) : null;
  const hochladenKnopf = darf ? el('button', { class: 'knopf knopf-zweit ob-anhang-hochladen', type: 'button', onclick: () => anhangDatei.click() }, [symbol('hochladen'), t('office.board_hochladen')]) : null;
  if (anhangDatei) anhangDatei.addEventListener('change', async () => {
    const dateien = [...(anhangDatei.files || [])];
    anhangDatei.value = '';
    hochladenKnopf.disabled = true;
    try {
      for (const f of dateien) {
        if (f.size > DATEI_MAX_BYTES) { ctx.melden(t('office.board_anhang_zu_gross', { name: f.name }), 'warnung'); continue; }
        try { anhangDazu(await sitzung.dateiHochladen(f), f.size, f.type); } catch (e) { ctx.zeigeFehler(e); }
      }
    } finally { hochladenKnopf.disabled = false; }
  });
  const nasKnopf = darf ? el('button', { class: 'knopf knopf-zweit ob-anhang-nas', type: 'button', onclick: async () => {
    nasKnopf.disabled = true;
    try { const r = await sitzung.dateiAusNas(); if (r) anhangDazu(r, r.groesse, r.mime); } catch (e) { ctx.zeigeFehler(e); } finally { nasKnopf.disabled = false; }
  } }, [symbol('ordner'), t('office.board_aus_nas')]) : null;
  function anhaengeZeichnen(k) {
    anhaenge.textContent = '';
    for (const a of k.anhaenge) {
      anhaenge.appendChild(el('li', { class: 'ob-anhang', 'data-datei': a.datei }, [
        el('a', { href: sitzung.dateiUrl(a.datei), target: '_blank', rel: 'noopener noreferrer' }, [symbol('anhang'), a.name]),
        el('span', { class: 'schwach klein', text: format.groesse(a.groesse) }),
        darf ? el('button', { class: 'knopf-symbol ob-anhang-weg', type: 'button', 'aria-label': t('office.board_entfernen'), onclick: () => aendern({ typ: 'anhang', karte: karteId, anhang: { datei: a.datei, weg: true } }) }, [symbol('loeschen')]) : null,
      ]));
    }
    if (!k.anhaenge.length) anhaenge.appendChild(el('li', { class: 'schwach klein', text: t('office.board_keine_anhaenge') }));
  }

  // ---- Archiv, Löschen -------------------------------------------------------------------------------------------
  const archivKnopf = darf ? el('button', { class: 'knopf knopf-zweit ob-archivieren', type: 'button', onclick: () => setzen({ archiviert: !karte().archiviert }) }) : null;
  const loeschKnopf = darf ? el('button', { class: 'knopf knopf-zweit knopf-gefahr ob-karte-loeschen', type: 'button', onclick: async () => {
    const k = karte();
    const ja = await ctx.bestaetigen(t('office.board_karte_loeschen_frage', { titel: k.titel || t('office.board_ohne_titel') }), { titel: t('office.board_karte_loeschen'), ok: t('office.board_loeschen'), gefahr: true });
    if (!ja || !karte()) return;
    selbstGeloescht = true;
    if (!aendern({ typ: 'karte_loeschen', id: karteId })) selbstGeloescht = false;
  } }, [symbol('loeschen'), t('office.board_loeschen')]) : null;

  const abschnitt = (titelText, ...inhalt) => el('section', { class: 'ob-abschnitt' }, [el('h3', { text: titelText }), ...inhalt]);

  /** Anzeige aus den aktuellen Daten nachziehen; fokussierte oder noch nicht gesendete Felder bleiben. */
  function aktualisieren() {
    if (zu) return;
    const k = karte();
    if (!k) {
      if (!selbstGeloescht) ctx.melden(t('office.board_karte_weg'), 'info');
      d.schliessen();
      return;
    }
    if (!fokussiert(titel) && !zeitgeber.has('titel')) titel.value = k.titel || '';
    if (beschreibungFeld) { if (!fokussiert(beschreibungFeld) && !zeitgeber.has('beschreibung')) beschreibungFeld.value = k.beschreibung || ''; } else beschreibungZeichnen();
    if (!fokussiert(faellig)) faellig.value = k.faellig || '';
    zustaendigZeichnen(k); etikettenZeichnen(k); spalteZeichnen(k); checklisteZeichnen(k); kommentareZeichnen(k); anhaengeZeichnen(k);
    if (archivKnopf) archivKnopf.textContent = t(k.archiviert ? 'office.board_wiederherstellen' : 'office.board_archivieren');
  }

  beschreibungZeichnen();
  const inhalt = el('div', { class: 'ob-dialog' }, [
    el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('office.board_titel') }), titel]),
    abschnitt(t('office.board_beschreibung'), beschreibungBox),
    el('div', { class: 'ob-dialog-raster' }, [
      abschnitt(t('office.board_zustaendig'), zustaendig),
      abschnitt(t('office.board_faellig'), el('div', { class: 'knopf-reihe' }, [faellig, faelligLeeren])),
      abschnitt(t('office.board_etiketten'), etiketten),
      abschnitt(t('office.board_spalte'), el('div', { class: 'knopf-reihe' }, [spalteWahl, nachOben, nachUnten])),
    ]),
    abschnitt(t('office.board_checkliste'), checkliste, punktNeu ? el('div', { class: 'knopf-reihe ob-punkt-zeile' }, [punktNeu, el('button', { class: 'knopf knopf-zweit ob-punkt-hinzu', type: 'button', onclick: punktHinzu }, [symbol('plus'), t('office.board_hinzufuegen')])]) : null),
    abschnitt(t('office.board_kommentare'), kommentare, kommentarNeu ? el('div', { class: 'ob-kommentar-form' }, [kommentarNeu, el('button', { class: 'knopf ob-kommentar-senden', type: 'button', onclick: kommentarSenden }, [symbol('senden'), t('office.board_kommentar_senden')])]) : null),
    abschnitt(t('office.board_anhaenge'), anhaenge, darf ? el('div', { class: 'knopf-reihe' }, [hochladenKnopf, nasKnopf, anhangDatei]) : null),
    darf ? el('div', { class: 'dialog-knoepfe ob-dialog-fuss' }, [archivKnopf, loeschKnopf]) : null,
  ]);
  const d = ctx.dialog(inhalt, {
    titel: t('office.board_karte'), breit: true, klasse: 'ob-karten-dialog',
    beimSchliessen: () => {
      alleSenden();
      zu = true;
      for (const x of ab) { try { x(); } catch { /* egal */ } }
      ab.length = 0;
      try { sitzung.auswahlSenden(null); } catch { /* egal */ }
    },
  });
  aktualisieren();
  ab.push(sitzung.on('aenderung', aktualisieren));
  try { sitzung.auswahlSenden({ karte: karteId }); } catch { /* egal */ }
  return { schliessen: () => d.schliessen(), element: d.element };
}
