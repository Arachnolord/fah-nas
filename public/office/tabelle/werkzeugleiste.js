// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Werkzeugleiste, Blätter-Reiter, Kontextmenü und Filter der Office-Tabelle (Plan 06):
// - Leiste: Rückgängig/Wiederholen, Fett/Kursiv, Schrift- und Füllfarbe (Klappmenü mit Palette und „Keine“),
//   Ausrichtung, Zahlformat, Sortieren, Filter, erste Zeile fixieren, Funktionen (fügt =NAME( ein) und „⋯“ (das
//   Kontextmenü, auf dem Handy der Weg zu Zeilen/Spalten und Zwischenablage). Die Knöpfe folgen der aktiven Zelle
//   (aria-pressed). Wer nur lesen darf, sieht nur Filter und Menü.
// - Reiter: je Blatt ein Knopf (Klick wechselt, Doppelklick benennt um), „⋯“ bzw. rechte Maustaste bzw. langes Drücken
//   öffnet Umbenennen, Verschieben und Löschen; „+“ legt ein Blatt an.
// - Kontextmenü: Zwischenablage, Zeilen/Spalten einfügen und löschen (so viele, wie gewählt sind), Sortieren, Filter,
//   Inhalt löschen.
// - Filter: eine Ansicht nur für mich (ed.filter), nie eine Op.

import { el, t, symbol } from '../../app.js';
import { FARBEN, HINTERGRUENDE } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { zwischen } from '../../gemeinsam/sync/typen/board.js';
import { blattVon } from '../../gemeinsam/sync/typen/tabelle.js';
import { GRENZEN, adresse, spalteZuText } from './formeln/adresse.js';
import { FUNKTIONEN } from './formeln/funktionen.js';
import { blattNamePruefen } from './formeln/uebersetzen.js';
import { bereichVon, auswahlNeu } from './auswahl.js';
import { formatOp, sortierenOp, sortierBereich, strukturOp, neuesBlattOp } from './aktionen.js';
import { filterWerte } from './filter.js';

/** Länger wird eine Blatt-Position nicht (wie beim Board); sonst „kein Platz mehr“. */
const POS_MAX = 64;
/** Langes Drücken auf einen Reiter öffnet sein Menü (ms). */
const LANG_MS = 500;
/** Ab so vielen Werten bekommt der Filter ein Suchfeld. */
const SUCHE_AB = 20;
const ZAHLFORMATE = Object.freeze(['standard', 'zahl2', 'euro', 'prozent', 'datum', 'text']);
const AUSRICHTUNGEN = Object.freeze(['links', 'mitte', 'rechts']);
const FUNKTIONSNAMEN = Object.freeze(Object.values(FUNKTIONEN).map((f) => f.de).sort((a, b) => a.localeCompare(b, 'de')));

/** Zuletzt über das Menü Kopiertes: liest das Menü genau diesen Text zurück, gilt das interne Format (Formeln, Formate). */
const ablage = { tsv: null, intern: null };

const druecken = (knopf, an) => { if (knopf) knopf.setAttribute('aria-pressed', an ? 'true' : 'false'); };

/** Formatfeld im ganzen gewählten Bereich setzen (null = entfernen; fett/kursiv: 'umschalten'). */
function formatSetzen(ed, feld, wert) {
  ed.ausfuehren(() => formatOp(ed.sitzung.daten, ed.blatt, bereichVon(ed.aw), feld, wert));
  ed.fokusZurueck();
}

/** Sortieren: ein mehrzeiliger gewählter Bereich, sonst die belegten Zeilen; Schlüssel ist die Spalte der aktiven Zelle. */
function sortieren(ed, absteigend) {
  if (ed.nurLesen) return;
  const daten = ed.sitzung.daten;
  const b = sortierBereich(daten, ed.blatt, ed.aw);
  if (!b) return;
  const spalte = Math.min(Math.max(ed.aw.anker.s, b.s1), b.s2);
  ed.ausfuehren(() => sortierenOp(daten, ed.rechner, ed.blatt, b, spalte, absteigend));
  ed.fokusZurueck();
}

/** Zeilen/Spalten einfügen oder löschen: so viele, wie die Auswahl umfasst. */
function struktur(ed, art) {
  ed.ausfuehren(() => strukturOp(art, ed.blatt, bereichVon(ed.aw)));
  ed.fokusZurueck();
}

function fixierenUmschalten(ed) {
  const blatt = ed.aktivesBlatt();
  if (!blatt || ed.nurLesen) return;
  ed.aendern({ typ: 'fixieren', blatt: blatt.id, zeilen: blatt.fixiert && blatt.fixiert.zeilen === 1 ? 0 : 1 });
  ed.fokusZurueck();
}

/** =NAME( in die Bearbeitungszeile; beim Bearbeiten an der Schreibmarke einfügen (ohne = davor, außer das Feld ist leer). */
function funktionEinfuegen(ed, name) {
  if (ed.nurLesen) return;
  if (!ed.bearbeitet) { ed.bearbeitenStarten(`=${name}(`, 'zeile'); return; }
  const feld = ed.bearbeitOrt === 'zelle' ? ed.raster.zellEingabe : ed.formel;
  const text = feld.value;
  const einschub = text.trim() === '' ? `=${name}(` : `${name}(`;
  const von = typeof feld.selectionStart === 'number' ? feld.selectionStart : text.length;
  const bis = typeof feld.selectionEnd === 'number' ? feld.selectionEnd : von;
  feld.value = text.slice(0, von) + einschub + text.slice(bis);
  (feld === ed.formel ? ed.raster.zellEingabe : ed.formel).value = feld.value;
  ed.fokusZurueck();
  try { feld.setSelectionRange(von + einschub.length, von + einschub.length); } catch { /* egal */ }
}

// ---- Zwischenablage über das Menü ------------------------------------------------------------------------------------

function menueKopieren(ed, schneiden) {
  const k = ed.kopierenIn(null, { schneiden });
  if (!k) return;
  ablage.tsv = k.tsv; ablage.intern = k.intern;
  const cb = globalThis.navigator && globalThis.navigator.clipboard;
  if (cb && typeof cb.writeText === 'function') cb.writeText(k.tsv).catch(() => ed.ctx.melden(t('office.tab_einfuegen_tastatur'), 'info'));
}

/** Einfügen über navigator.clipboard.readText; geht das nicht (Rechte, Browser), der Hinweis auf Strg+V. */
async function menueEinfuegen(ed) {
  if (ed.nurLesen) return;
  const cb = globalThis.navigator && globalThis.navigator.clipboard;
  let text = null;
  try { if (cb && typeof cb.readText === 'function') text = await cb.readText(); } catch { text = null; }
  if (typeof text !== 'string') { ed.ctx.melden(t('office.tab_einfuegen_tastatur'), 'info'); return; }
  ed.einfuegenAus(text === ablage.tsv && ablage.intern ? { intern: ablage.intern, text } : { text });
  ed.fokusZurueck();
}

// ---- Kontextmenü -----------------------------------------------------------------------------------------------------

/**
 * Kontextmenü für die Auswahl öffnen (art 'zelle' | 'zeile' | 'spalte') an der Bildschirmstelle x, y. Schließt bei Wahl,
 * Esc, Klick daneben und beim Verlassen des Editors.
 */
export function kontextmenue(ed, { art = 'zelle', x = 0, y = 0 } = {}) {
  if (ed.kontextSchliessen) ed.kontextSchliessen();
  const lesen = ed.nurLesen;
  const eintrag = (aktion, text, fn) => el('button', { type: 'button', role: 'menuitem', 'data-aktion': aktion, onclick: () => { schliessen(); fn(); } }, text);
  const trenner = () => el('div', { class: 'ot-kontext-trenner', role: 'separator' });
  const teile = [
    lesen ? null : eintrag('ausschneiden', t('office.tab_ausschneiden'), () => menueKopieren(ed, true)),
    eintrag('kopieren', t('office.tab_kopieren'), () => menueKopieren(ed, false)),
    lesen ? null : eintrag('einfuegen', t('office.tab_einfuegen'), () => menueEinfuegen(ed)),
    trenner(),
    !lesen && art !== 'spalte' ? eintrag('zeilen_einfuegen', t('office.tab_zeilen_einfuegen'), () => struktur(ed, 'zeilen_einfuegen')) : null,
    !lesen && art !== 'spalte' ? eintrag('zeilen_loeschen', t('office.tab_zeilen_loeschen'), () => struktur(ed, 'zeilen_loeschen')) : null,
    !lesen && art !== 'zeile' ? eintrag('spalten_einfuegen', t('office.tab_spalten_einfuegen'), () => struktur(ed, 'spalten_einfuegen')) : null,
    !lesen && art !== 'zeile' ? eintrag('spalten_loeschen', t('office.tab_spalten_loeschen'), () => struktur(ed, 'spalten_loeschen')) : null,
    lesen ? null : trenner(),
    lesen ? null : eintrag('sortieren_auf', t('office.tab_sortieren_auf'), () => sortieren(ed, false)),
    lesen ? null : eintrag('sortieren_ab', t('office.tab_sortieren_ab'), () => sortieren(ed, true)),
    eintrag('filter', t('office.tab_filter'), () => filterDialog(ed, filterSpalte(ed))),
    lesen ? null : trenner(),
    lesen ? null : eintrag('inhalt_loeschen', t('office.tab_inhalt_loeschen'), () => { ed.befehl('leeren'); ed.fokusZurueck(); }),
  ];
  const menue = el('div', { class: 'ot-kontext', role: 'menu', 'aria-label': t('office.tab_menue') }, teile);
  // im Bild halten: an den Zeiger, notfalls nach links/oben gerückt
  const breite = globalThis.innerWidth || 0, hoehe = globalThis.innerHeight || 0;
  menue.style.left = `${Math.max(8, breite ? Math.min(x, breite - 240) : x)}px`;
  menue.style.top = `${Math.max(8, hoehe ? Math.min(y, hoehe - 420) : y)}px`;
  const draussen = (e) => { if (!menue.contains(e.target)) schliessen(); };
  const taste = (e) => { if (e.key === 'Escape') { e.preventDefault(); schliessen(); ed.fokusZurueck(); } };
  function schliessen() {
    menue.remove();
    document.removeEventListener('pointerdown', draussen, true);
    if (ed.kontextSchliessen === schliessen) ed.kontextSchliessen = null;
  }
  menue.addEventListener('keydown', taste);
  document.addEventListener('pointerdown', draussen, true);
  ed.kontextSchliessen = schliessen;
  ed.wurzel.appendChild(menue);
  const erster = menue.querySelector('button');
  if (erster) { try { erster.focus({ preventScroll: true }); } catch { /* egal */ } }
  return { element: menue, schliessen };
}

// ---- Filter ----------------------------------------------------------------------------------------------------------

/** Spalte, die der Filter-Knopf meint: die schon gefilterte Spalte des Blatts, sonst die der aktiven Zelle. */
function filterSpalte(ed) {
  const f = ed.filter.get(ed.blatt);
  return f ? f.spalte : ed.aw.anker.s;
}

/** Nach der Filterspalte sortieren: Zeile 1 ist der Kopf und bleibt stehen, sortiert werden die belegten Zeilen darunter. */
function filterSortieren(ed, spalte, absteigend) {
  if (ed.nurLesen) return;
  const daten = ed.sitzung.daten;
  const b = sortierBereich(daten, ed.blatt, auswahlNeu(ed.blatt, 1, spalte));
  if (!b) return;
  const bereich = { z1: Math.max(2, b.z1), s1: Math.min(b.s1, spalte), z2: b.z2, s2: Math.max(b.s2, spalte) };
  if (bereich.z2 < bereich.z1) return;
  ed.ausfuehren(() => sortierenOp(daten, ed.rechner, ed.blatt, bereich, spalte, absteigend));
}

/**
 * Filterdialog für Spalte `spalte` des aktiven Blatts: Kontrollkästchen je angezeigtem Wert (ab Zeile 2, mit Anzahl;
 * Suchfeld bei mehr als 20 Werten), „Alle“/„Keine“, Sortieren, „Filter entfernen“, „Übernehmen“. Alles angehakt = kein
 * Filter. Gilt nur für mich und wird nicht gespeichert.
 */
export function filterDialog(ed, spalte) {
  const blattId = ed.blatt;
  const alt = ed.filter.get(blattId);
  const vorher = alt && alt.spalte === spalte ? alt.erlaubt : null;
  const kaesten = filterWerte(ed.sitzung.daten, ed.rechner, blattId, spalte).map(({ text, anzahl }) => {
    const kasten = el('input', { type: 'checkbox', value: text, checked: !vorher || vorher.has(text) });
    const zeile = el('label', { class: 'ot-filter-wert' }, [
      kasten, el('span', { class: 'ot-filter-text', text: text === '' ? t('office.tab_filter_leer') : text }), el('span', { class: 'ot-filter-anzahl', text: String(anzahl) }),
    ]);
    return { text, kasten, zeile };
  });
  let suche = null;
  if (kaesten.length > SUCHE_AB) {
    suche = el('input', { class: 'eingabe ot-filter-suche', type: 'search', placeholder: t('office.tab_filter_suchen'), 'aria-label': t('office.tab_filter_suchen') });
    suche.addEventListener('input', () => {
      const q = suche.value.trim().toLocaleLowerCase('de');
      for (const k of kaesten) k.zeile.hidden = !!q && !k.text.toLocaleLowerCase('de').includes(q);
    });
  }
  const alleSetzen = (an) => { for (const k of kaesten) if (!k.zeile.hidden) k.kasten.checked = an; };
  const knopf = (aktion, text, fn, klasse = 'knopf knopf-zweit') => el('button', { class: klasse, type: 'button', 'data-aktion': aktion, onclick: fn }, text);
  const d = ed.ctx.dialog([
    el('p', { class: 'erklaerung', text: t('office.tab_filter_erklaerung') }),
    suche,
    el('div', { class: 'knopf-reihe' }, [knopf('alle', t('office.tab_alle'), () => alleSetzen(true)), knopf('keine', t('office.tab_keine'), () => alleSetzen(false))]),
    el('div', { class: 'ot-filter-liste' }, kaesten.map((k) => k.zeile)),
    ed.nurLesen ? null : el('div', { class: 'knopf-reihe' }, [
      knopf('sortieren_auf', [symbol('sortieren-auf'), t('office.tab_sortieren_auf')], () => { d.schliessen(); filterSortieren(ed, spalte, false); }),
      knopf('sortieren_ab', [symbol('sortieren-ab'), t('office.tab_sortieren_ab')], () => { d.schliessen(); filterSortieren(ed, spalte, true); }),
    ]),
    el('div', { class: 'dialog-knoepfe' }, [
      alt ? knopf('entfernen', t('office.tab_filter_entfernen'), () => { d.schliessen(); ed.filterSetzen(blattId, null); }) : null,
      knopf('uebernehmen', t('office.tab_uebernehmen'), () => {
        const erlaubt = new Set(kaesten.filter((k) => k.kasten.checked).map((k) => k.text));
        d.schliessen();
        ed.filterSetzen(blattId, erlaubt.size === kaesten.length ? null : { spalte, erlaubt });
      }, 'knopf'),
    ]),
  ], { titel: `${t('office.tab_filter')} ${spalteZuText(spalte)}` });
  return d;
}

// ---- Werkzeugleiste --------------------------------------------------------------------------------------------------

/** Leiste in ed.leiste bauen → { element, aktualisieren() }; bei Rechtewechsel baut sie sich neu. */
export function werkzeugleisteBauen(ed) {
  const element = ed.leiste;
  const z = { menues: [], fett: null, kursiv: null, ausr: new Map(), zahl: null, filter: null, fixieren: null, zurueck: null, vor: null, gebaut: false };

  const knopf = (aktion, symbolName, text, fn, { wert, umschalter = false } = {}) => el('button', {
    class: 'knopf-symbol', type: 'button', title: text, 'aria-label': text, 'data-aktion': aktion, 'data-wert': wert,
    'aria-pressed': umschalter ? 'false' : undefined, onclick: fn,
  }, symbol(symbolName));
  const gruppe = (...kinder) => el('div', { class: 'ot-leiste-gruppe' }, kinder);

  /** Klappmenü: Öffner [data-menue] und eine Fläche mit Knöpfen; Klick daneben oder Esc schließt. */
  function klappmenue(name, symbolName, text, inhalt, klasse = '') {
    const flaeche = el('div', { class: `ot-klapp${klasse ? ' ' + klasse : ''}`, role: 'group', 'aria-label': text, hidden: true });
    const auf = el('button', { class: 'knopf-symbol', type: 'button', title: text, 'aria-label': text, 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-menue': name }, symbol(symbolName));
    const menue = {
      wurzel: el('div', { class: 'ot-klappmenue' }, [auf, flaeche]),
      schliessen() { flaeche.hidden = true; auf.setAttribute('aria-expanded', 'false'); },
    };
    auf.addEventListener('click', () => {
      const oeffnen = flaeche.hidden;
      for (const m of z.menues) m.schliessen();
      flaeche.hidden = !oeffnen;
      auf.setAttribute('aria-expanded', oeffnen ? 'true' : 'false');
    });
    flaeche.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); menue.schliessen(); try { auf.focus(); } catch { /* egal */ } } });
    for (const k of inhalt(menue)) flaeche.appendChild(k);
    z.menues.push(menue);
    return menue.wurzel;
  }

  /** Farbpalette (Schrift: FARBEN, Füllung: HINTERGRUENDE) mit „Keine“. */
  function palette(feld, symbolName, text) {
    const liste = feld === 'farbe' ? FARBEN : HINTERGRUENDE;
    return klappmenue(feld, symbolName, text, (menue) => [
      ...Object.entries(liste).map(([n, wert]) => {
        const name = t(`office.tab_farbe_${n}`);
        return el('button', {
          class: `ot-farbknopf ot-farbknopf-${feld}`, type: 'button', title: name, 'aria-label': name, 'data-aktion': feld, 'data-wert': wert,
          style: { '--muster': wert }, onclick: () => { menue.schliessen(); formatSetzen(ed, feld, wert); },
        }, feld === 'farbe' ? 'A' : '');
      }),
      el('button', { class: 'knopf knopf-zweit ot-farbe-keine', type: 'button', 'data-aktion': feld, 'data-wert': '', onclick: () => { menue.schliessen(); formatSetzen(ed, feld, null); } }, t('office.tab_keine')),
    ]);
  }

  function bauen() {
    for (const m of z.menues) m.schliessen();
    element.textContent = '';
    z.menues = []; z.ausr = new Map();
    z.fett = z.kursiv = z.zahl = z.fixieren = z.zurueck = z.vor = null;
    z.filter = knopf('filter', 'filter', t('office.tab_filter'), () => filterDialog(ed, filterSpalte(ed)), { umschalter: true });
    const menue = knopf('menue', 'menue', t('office.tab_menue'), (e) => {
      const r = e.currentTarget && typeof e.currentTarget.getBoundingClientRect === 'function' ? e.currentTarget.getBoundingClientRect() : { left: 0, bottom: 0 };
      kontextmenue(ed, { art: 'zelle', x: r.left, y: r.bottom });
    });
    if (ed.nurLesen) {
      element.append(gruppe(z.filter), gruppe(menue));
    } else {
      z.zurueck = knopf('zurueck', 'rueckgaengig', t('office.tab_rueckgaengig'), () => { ed.befehl('zurueck'); ed.fokusZurueck(); });
      z.vor = knopf('vor', 'wiederholen', t('office.tab_wiederholen'), () => { ed.befehl('vor'); ed.fokusZurueck(); });
      z.fett = knopf('fett', 'fett', t('office.tab_fett'), () => formatSetzen(ed, 'fett', 'umschalten'), { umschalter: true });
      z.kursiv = knopf('kursiv', 'kursiv', t('office.tab_kursiv'), () => formatSetzen(ed, 'kursiv', 'umschalten'), { umschalter: true });
      for (const w of AUSRICHTUNGEN) {
        z.ausr.set(w, knopf('ausr', `ausrichten-${w}`, t(`office.tab_ausr_${w}`), () => {
          const f = aktiveFormate();
          formatSetzen(ed, 'ausr', f.ausr === w ? null : w);
        }, { wert: w, umschalter: true }));
      }
      z.zahl = el('select', { class: 'ot-zahlformat', 'data-aktion': 'zahl', title: t('office.tab_zahlformat'), 'aria-label': t('office.tab_zahlformat') },
        ZAHLFORMATE.map((w) => el('option', { value: w, text: t(`office.tab_zahl_${w}`) })));
      z.zahl.addEventListener('change', () => formatSetzen(ed, 'zahl', z.zahl.value === 'standard' ? null : z.zahl.value));
      z.fixieren = knopf('fixieren', 'fixieren', t('office.tab_fixieren'), () => fixierenUmschalten(ed), { umschalter: true });
      const funktionen = klappmenue('funktion', 'funktion', t('office.tab_funktionen'), (m) => FUNKTIONSNAMEN.map((name) => el('button', {
        class: 'knopf knopf-zweit', type: 'button', 'data-aktion': 'funktion', 'data-wert': name, onclick: () => { m.schliessen(); funktionEinfuegen(ed, name); },
      }, name)), 'ot-funktionsliste');
      element.append(
        gruppe(z.zurueck, z.vor),
        gruppe(z.fett, z.kursiv),
        gruppe(palette('farbe', 'farbe', t('office.tab_farbe')), palette('hinter', 'markieren', t('office.tab_hinter'))),
        gruppe(...z.ausr.values()),
        gruppe(z.zahl),
        gruppe(knopf('sortieren_auf', 'sortieren-auf', t('office.tab_sortieren_auf'), () => sortieren(ed, false)), knopf('sortieren_ab', 'sortieren-ab', t('office.tab_sortieren_ab'), () => sortieren(ed, true)), z.filter),
        gruppe(z.fixieren),
        gruppe(funktionen),
        gruppe(menue),
      );
    }
    z.gebaut = true;
    aktualisieren();
  }

  function aktiveFormate() {
    const blatt = ed.aktivesBlatt();
    const p = ed.aw && ed.aw.anker;
    const zelle = blatt && p && blatt.zellen ? blatt.zellen[adresse(p.z, p.s)] : undefined;
    return (zelle && zelle.f) || {};
  }

  /** Gedrückt-Zustände nach der aktiven Zelle, Fixieren/Filter nach dem Blatt, Rückgängig nach dem Verlauf. */
  function aktualisieren() {
    if (!z.gebaut) return;
    const f = aktiveFormate();
    const blatt = ed.aktivesBlatt();
    druecken(z.fett, f.fett === true);
    druecken(z.kursiv, f.kursiv === true);
    for (const [w, k] of z.ausr) druecken(k, f.ausr === w);
    if (z.zahl) z.zahl.value = f.zahl || 'standard';
    druecken(z.fixieren, !!(blatt && blatt.fixiert && blatt.fixiert.zeilen === 1));
    druecken(z.filter, ed.filter.has(ed.blatt));
    if (z.zurueck) z.zurueck.disabled = !ed.verlauf.kannZurueck;
    if (z.vor) z.vor.disabled = !ed.verlauf.kannVor;
  }

  // Knöpfe nehmen dem Raster nicht den Fokus (Tasten und Zwischenablage laufen weiter dort)
  element.addEventListener('mousedown', (e) => { if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) e.preventDefault(); });
  const draussen = (e) => { for (const m of z.menues) if (!m.wurzel.contains(e.target)) m.schliessen(); };
  document.addEventListener('pointerdown', draussen);
  const ab = [
    ed.on('auswahl', aktualisieren), ed.on('aenderung', aktualisieren), ed.on('blatt', aktualisieren), ed.on('filter', aktualisieren),
    ed.on('recht', bauen),
    ed.on('verlassen', () => {
      document.removeEventListener('pointerdown', draussen);
      if (ed.kontextSchliessen) ed.kontextSchliessen();
      for (const x of ab) x();
    }),
  ];
  bauen();
  return { element, aktualisieren };
}

// ---- Blätter-Reiter --------------------------------------------------------------------------------------------------

function blattNeu(ed) {
  if (ed.nurLesen) return;
  const daten = ed.sitzung.daten;
  if (daten.blaetter.length >= GRENZEN.blaetter) { ed.ctx.melden(t('office.tab_blaetter_max'), 'warnung'); return; }
  const op = neuesBlattOp(daten, t('office.tab_blatt_standard'));
  if (op.blatt.pos.length > POS_MAX) { ed.ctx.melden(t('office.tab_zu_eng'), 'warnung'); return; }
  if (ed.aendern(op)) ed.blattWechseln(op.blatt.id);
}

/** Umbenennen mit Prüfung im Dialog (Gründe als Text); vor dem Senden noch einmal gegen den aktuellen Stand geprüft. */
async function blattUmbenennen(ed, id) {
  const blatt = blattVon(ed.sitzung.daten, id);
  if (!blatt || ed.nurLesen) return;
  const pruefen = (w) => {
    const grund = blattNamePruefen(w, ed.sitzung.daten.blaetter, id);
    return grund ? t(`office.tab_name_${grund}`) : null;
  };
  const name = await ed.ctx.eingabe({ titel: t('office.tab_blatt_umbenennen'), beschriftung: t('office.tab_blatt_name'), wert: blatt.name, maxlaenge: GRENZEN.name, ok: t('office.tab_blatt_umbenennen'), pruefen });
  if (typeof name !== 'string' || ed.nurLesen) return;
  const jetzt = blattVon(ed.sitzung.daten, id);
  if (!jetzt || name === jetzt.name || pruefen(name)) return;
  ed.aendern({ typ: 'blatt_umbenennen', blatt: id, name });
}

function blattVerschieben(ed, id, richtung) {
  const bl = ed.sitzung.daten.blaetter;
  const i = bl.findIndex((b) => b.id === id);
  let pos = null;
  if (richtung < 0 && i > 0) pos = zwischen(i > 1 ? bl[i - 2].pos : null, bl[i - 1].pos);
  if (richtung > 0 && i >= 0 && i < bl.length - 1) pos = zwischen(bl[i + 1].pos, i < bl.length - 2 ? bl[i + 2].pos : null);
  if (!pos) return;
  if (pos.length > POS_MAX) { ed.ctx.melden(t('office.tab_zu_eng'), 'warnung'); return; }
  ed.aendern({ typ: 'blatt_verschieben', blatt: id, pos });
}

/** Löschen nach Rückfrage; das letzte Blatt bleibt. rest = alle übrigen Blätter (Pflicht des Typs, Aufgabe 10). */
async function blattLoeschen(ed, id) {
  const blatt = blattVon(ed.sitzung.daten, id);
  if (!blatt || ed.nurLesen || ed.sitzung.daten.blaetter.length <= 1) return;
  const ja = await ed.ctx.bestaetigen(t('office.tab_blatt_loeschen_frage', { name: blatt.name }), { titel: t('office.tab_blatt_loeschen'), ok: t('office.tab_blatt_loeschen'), gefahr: true });
  const daten = ed.sitzung.daten;
  if (!ja || ed.nurLesen || !blattVon(daten, id) || daten.blaetter.length <= 1) return;
  ed.aendern({ typ: 'blatt_loeschen', blatt: id, rest: daten.blaetter.map((b) => b.id).filter((x) => x !== id) });
}

/** Menü eines Blatts (Dialog): Umbenennen, Nach links/rechts, Löschen (beim letzten Blatt aus). */
function blattMenue(ed, id) {
  const blaetter = ed.sitzung.daten.blaetter;
  const i = blaetter.findIndex((b) => b.id === id);
  if (i < 0 || ed.nurLesen) return null;
  const knopf = (aktion, text, symbolName, fn, aus = false) => el('button', {
    class: `knopf knopf-zweit${aktion === 'loeschen' ? ' knopf-gefahr' : ''}`, type: 'button', 'data-aktion': aktion, disabled: aus,
    onclick: () => { d.schliessen(); fn(); },
  }, [symbol(symbolName), text]);
  const d = ed.ctx.dialog(el('div', { class: 'ot-blatt-menue' }, [
    knopf('umbenennen', t('office.tab_blatt_umbenennen'), 'umbenennen', () => blattUmbenennen(ed, id)),
    knopf('links', t('office.tab_blatt_links'), 'zurueck', () => blattVerschieben(ed, id, -1), i <= 0),
    knopf('rechts', t('office.tab_blatt_rechts'), 'weiter', () => blattVerschieben(ed, id, 1), i >= blaetter.length - 1),
    knopf('loeschen', t('office.tab_blatt_loeschen'), 'loeschen', () => blattLoeschen(ed, id), blaetter.length <= 1),
  ]), { titel: blaetter[i].name });
  return d;
}

/** Reiter in ed.reiter bauen → { element, aktualisieren() }. */
export function reiterBauen(ed) {
  const element = el('div', { class: 'ot-tabs', role: 'tablist', 'aria-label': t('office.tab_blaetter') });
  const neu = el('button', { class: 'knopf-symbol ot-blatt-neu', type: 'button', 'data-aktion': 'neu', title: t('office.tab_blatt_neu'), 'aria-label': t('office.tab_blatt_neu'), onclick: () => blattNeu(ed) }, symbol('plus'));
  ed.reiter.appendChild(element);
  let stand = '';

  function tabBauen(blatt) {
    const aktiv = blatt.id === ed.blatt;
    let lang = null;
    const halt = () => { if (lang) { clearTimeout(lang.timer); lang = null; } };
    const name = el('button', {
      class: 'ot-tab-name', type: 'button', role: 'tab', 'aria-selected': aktiv ? 'true' : 'false', title: blatt.name, text: blatt.name,
      onclick: () => { if (Date.now() >= (ed.reiterKlickSperre || 0)) ed.blattWechseln(blatt.id); },
      ondblclick: () => blattUmbenennen(ed, blatt.id),
      oncontextmenu: (e) => { if (ed.nurLesen) return; e.preventDefault(); blattMenue(ed, blatt.id); },
    });
    // Handy: langes Drücken öffnet das Menü (der folgende Klick wechselt dann nicht)
    name.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || ed.nurLesen) return;
      halt();
      lang = { x: e.clientX || 0, y: e.clientY || 0, timer: setTimeout(() => { lang = null; ed.reiterKlickSperre = Date.now() + 400; blattMenue(ed, blatt.id); }, LANG_MS) };
    });
    name.addEventListener('pointermove', (e) => { if (lang && Math.hypot((e.clientX || 0) - lang.x, (e.clientY || 0) - lang.y) > 10) halt(); });
    name.addEventListener('pointerup', halt);
    name.addEventListener('pointercancel', halt);
    return el('div', { class: `ot-tab${aktiv ? ' ot-tab-aktiv' : ''}`, 'data-id': blatt.id }, [
      name,
      ed.nurLesen ? null : el('button', {
        class: 'knopf-symbol ot-tab-menue', type: 'button', 'data-aktion': 'menue', title: t('office.tab_blatt_menue', { name: blatt.name }),
        'aria-label': t('office.tab_blatt_menue', { name: blatt.name }), onclick: () => blattMenue(ed, blatt.id),
      }, symbol('menue')),
    ]);
  }

  /** Neu zeichnen, wenn sich Blätter, Namen, das aktive Blatt oder das Recht geändert haben. */
  function aktualisieren() {
    const blaetter = ed.sitzung.daten.blaetter;
    const neuStand = JSON.stringify([ed.blatt, ed.nurLesen, blaetter.map((b) => [b.id, b.name])]);
    if (neuStand === stand) return;
    stand = neuStand;
    element.textContent = '';
    for (const b of blaetter) element.appendChild(tabBauen(b));
    if (ed.nurLesen) neu.remove(); else if (neu.parentNode !== ed.reiter) ed.reiter.appendChild(neu);
  }

  const ab = [ed.on('aenderung', aktualisieren), ed.on('blatt', aktualisieren), ed.on('recht', aktualisieren)];
  ed.on('verlassen', () => { for (const x of ab) x(); });
  aktualisieren();
  return { element, aktualisieren };
}
