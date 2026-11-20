// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Werkzeugleiste des Dokument-Editors (Plan 05): Rückgängig/Wiederholen, Absatzformat, Zeichenformate, Schriftfarbe
// und Hervorhebung (Klappmenüs mit Palette, eigener Farbe, „Ohne“), Link, Listen, Einzug, Ausrichtung, Zitat, Einfügen
// (Tabelle, Bild, Seitenumbruch – die Aufgaben 13/14 hängen sich über ed.aktionen ein) und Kommentar. Knöpfe zeigen
// ihren Zustand an der Auswahl (aria-pressed). Dazu Tastenkürzel, Link-Dialog und Rückgängig über den Verlauf.
// Wer nur lesen darf, bekommt keine Bearbeiten-Knöpfe.

import { el, t, symbol } from '../../app.js';
import { positionTransformieren, zusammensetzen } from '../../gemeinsam/sync/delta.js';
import { dokument } from '../../gemeinsam/sync/typen/dokument.js';
import { FARBEN, HINTERGRUENDE, linkErlaubt } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { formateBei, zeilenAus, zeileBei, einfuegeFormate } from './modell.js';
import { formatDelta, zeilenFormatDelta, einzugDelta, linkBereich, eingabeDelta } from './befehle.js';

/** Übersetzte Farbnamen (feste Schlüssel, damit die Sprachprüfung sie findet). */
const FARBNAMEN = {
  rot: () => t('office.dok_farbe_rot'), orange: () => t('office.dok_farbe_orange'), gelb: () => t('office.dok_farbe_gelb'),
  gruen: () => t('office.dok_farbe_gruen'), tuerkis: () => t('office.dok_farbe_tuerkis'), blau: () => t('office.dok_farbe_blau'),
  lila: () => t('office.dok_farbe_lila'), grau: () => t('office.dok_farbe_grau'), rosa: () => t('office.dok_farbe_rosa'),
};
const FORMAT_EINGABE = new Map([['formatBold', 'fett'], ['formatItalic', 'kursiv'], ['formatUnderline', 'unterstrichen'], ['formatStrikeThrough', 'durchgestrichen']]);

const vonBis = (aw) => [Math.min(aw.anker, aw.kopf), Math.max(aw.anker, aw.kopf)];
const aktuelleAuswahl = (ed) => ed.auswahl() || ed.letzteAuswahl || null;
const nurGesetzte = (a) => Object.fromEntries(Object.entries(a || {}).filter(([, v]) => v !== null && v !== undefined && v !== false));
const aktualisieren = (ed) => { if (typeof ed.leisteAktualisieren === 'function') ed.leisteAktualisieren(); };

/** Formate an der Auswahl; zusammengeklappt die fürs Weitertippen samt Vorgemerktem. */
function formateJetzt(ed, aw) {
  const [von, bis] = vonBis(aw);
  const f = formateBei(ed.daten.delta, von, bis - von);
  if (von !== bis) return f;
  const inline = { ...f.inline };
  for (const [k, v] of Object.entries(ed.vorgemerkt)) { if (v === null || v === undefined || v === false) delete inline[k]; else inline[k] = v; }
  return { inline, zeile: f.zeile };
}

/** Taste → Befehl (rein): Strg auf Windows/Linux, ⌘ auf macOS; Strg+Alt (AltGr) bleibt für Sonderzeichen frei. */
export function tasteAuswerten(e) {
  const mod = !!(e.metaKey || e.ctrlKey);
  const taste = String(e.key || '');
  if (taste === 'Tab') return mod || e.altKey ? null : e.shiftKey ? 'einzug_weniger' : 'einzug_mehr';
  if (taste === 'Enter') return mod && !e.altKey && !e.shiftKey ? 'erledigt' : null;
  if (!mod || e.altKey) return null;
  switch (taste.toLowerCase()) {
    case 'b': return 'fett';
    case 'i': return 'kursiv';
    case 'u': return 'unterstrichen';
    case 'k': return 'link';
    case 'z': return e.shiftKey ? 'vor' : 'zurueck';
    case 'y': return 'vor';
    default: return null;
  }
}

/** Inline-Format setzen; zusammengeklappt wird es für die nächste Eingabe vorgemerkt. */
function formatSetzen(ed, attr, wert) {
  if (ed.nurLesen) return;
  const aw = aktuelleAuswahl(ed);
  if (!aw) return;
  const [von, bis] = vonBis(aw);
  if (von === bis) { ed.vormerken(attr, wert); aktualisieren(ed); return; }
  const d = formatDelta(ed.daten, aw, attr, wert);
  if (d) ed.aendern({ d });
}

/** Zeichenformat umschalten: liegt `wert` an der ganzen Auswahl schon an, wird es entfernt. */
export function formatUmschalten(ed, attr, wert = true) {
  if (ed.nurLesen) return;
  const aw = aktuelleAuswahl(ed);
  if (!aw) return;
  formatSetzen(ed, attr, formateJetzt(ed, aw).inline[attr] === wert ? null : wert);
}

/** Zeilenformat setzen; Liste und Zitat schalten um, eine Liste ohne Haken nimmt „erledigt“ mit, links = Standard. */
export function zeilenformatSetzen(ed, attr, wert) {
  if (ed.nurLesen) return;
  const aw = aktuelleAuswahl(ed);
  if (!aw) return;
  let w = attr === 'ausrichtung' && wert === 'links' ? null : wert;
  if ((attr === 'liste' || attr === 'zitat') && formateJetzt(ed, aw).zeile[attr] === w) w = null;
  let d = zeilenFormatDelta(ed.daten, aw, attr, w);
  if (attr === 'liste' && w !== 'aufgabe') {
    const [von, bis] = vonBis(aw);
    const zeilen = zeilenAus(ed.daten.delta);
    const betroffen = von === bis ? [zeileBei(zeilen, von)] : zeilen.filter((z) => z.start < bis && z.start + z.laenge > von);
    if (betroffen.some((z) => z.attribute.erledigt)) d = zusammensetzen(d, zeilenFormatDelta(ed.daten, aw, 'erledigt', null));
  }
  if (d && d.length) ed.aendern({ d });
}

function einzug(ed, schritt) {
  if (ed.nurLesen) return;
  const aw = aktuelleAuswahl(ed);
  if (!aw) return;
  const d = einzugDelta(ed.daten, aw, schritt);
  if (d) ed.aendern({ d });
}

function tabulator(ed, aw) {
  const [von] = vonBis(aw);
  const d = eingabeDelta(ed.daten, aw, '\t', nurGesetzte({ ...einfuegeFormate(ed.daten.delta, von), ...ed.vorgemerkt }));
  ed.vorgemerkt = {};
  if (d) ed.aendern({ d }, { cursor: positionTransformieren(von, d, true) });
}

function umkehren(ed, holen) {
  if (ed.nurLesen) return;
  const d = holen(ed.daten.delta);
  if (!d) return;
  const anfang = typeof d[0].retain === 'number' && !d[0].attributes ? d[0].retain : 0;
  if (!ed.aendern({ d }, { verlauf: false, cursor: positionTransformieren(anfang, d, true) })) ed.verlauf.leeren();
  aktualisieren(ed);
}
const rueckgaengig = (ed) => umkehren(ed, (delta) => ed.verlauf.rueckgaengig(delta));
const wiederholen = (ed) => umkehren(ed, (delta) => ed.verlauf.wiederholen(delta));

/** Nach einem Dialog: zurück in den Text, Auswahl wieder setzen. */
function zurueckInDenText(ed, aw) {
  try { ed.wurzel.focus({ preventScroll: true }); } catch { /* egal */ }
  if (aw) ed.auswahlSetzen(aw);
}

/**
 * Link bearbeiten: Auswahl → Link setzen bzw. ändern, im Link ohne Auswahl → den ganzen Link, sonst die Adresse als
 * verlinkten Text einfügen; leer entfernt den Link. Fremde Änderungen während des Dialogs verschieben die Stellen mit.
 */
export async function linkBearbeiten(ed) {
  if (ed.nurLesen || typeof ed.ctx.eingabe !== 'function') return;
  let aw = aktuelleAuswahl(ed);
  if (!aw) return;
  let [von, bis] = vonBis(aw);
  let bereich = von === bis ? linkBereich(ed.daten, von) : null;
  const vorhanden = von !== bis ? formateBei(ed.daten.delta, von, bis - von).inline.link : bereich && bereich.url;
  const ab = ed.sitzung.on('aenderung', ({ op, lokal } = {}) => {
    if (lokal || !op) return;
    aw = dokument.auswahlTransformieren(aw, op, false);
    if (bereich) {
      const b = dokument.auswahlTransformieren({ anker: bereich.start, kopf: bereich.start + bereich.laenge }, op, false);
      bereich = { ...bereich, start: b.anker, laenge: b.kopf - b.anker };
    }
  });
  let url;
  try {
    url = await ed.ctx.eingabe({
      titel: t('office.dok_link_titel'), beschriftung: t('office.dok_link_adresse'), erklaerung: t('office.dok_link_erklaerung'),
      wert: vorhanden || '', maxlaenge: 2048, pruefen: (w) => (w === '' || linkErlaubt(w) ? null : t('office.dok_link_ungueltig')),
    });
  } finally { ab(); }
  if (url === null || url === undefined || ed.nurLesen) { zurueckInDenText(ed, aw); return; }
  [von, bis] = vonBis(aw);
  zurueckInDenText(ed, aw);
  if (von !== bis) {
    const d = formatDelta(ed.daten, aw, 'link', url || null);
    if (d) ed.aendern({ d });
  } else if (bereich && bereich.laenge > 0) {
    const d = formatDelta(ed.daten, { anker: bereich.start, kopf: bereich.start + bereich.laenge }, 'link', url || null);
    if (d) ed.aendern({ d });
  } else if (url) {
    const formate = nurGesetzte({ ...einfuegeFormate(ed.daten.delta, von), ...ed.vorgemerkt, link: url });
    ed.vorgemerkt = {};
    const d = eingabeDelta(ed.daten, aw, url, formate);
    if (d) ed.aendern({ d }, { cursor: von + url.length });
  }
}

/** Leiste in ed.leiste bauen → {aktualisieren, element}. */
export function werkzeugleisteBauen(ed) {
  const element = el('div', { class: 'od-leiste-gruppen' });
  ed.leiste.appendChild(element);
  const z = { inline: new Map(), liste: new Map(), ausr: new Map(), zitat: null, absatz: null, zurueck: null, vor: null, menues: [] };

  const knopf = (symbolName, text, fn, { umschalter = false, klasse = '' } = {}) => {
    const b = el('button', { class: `knopf-symbol${klasse ? ' ' + klasse : ''}`, type: 'button', title: text, 'aria-label': text, 'data-bearbeiten': '', onclick: fn }, symbol(symbolName));
    if (umschalter) b.setAttribute('aria-pressed', 'false');
    return b;
  };
  const gruppe = (...kinder) => el('div', { class: 'od-leiste-gruppe' }, kinder);

  function palette(attr, symbolName, text) {
    const liste = attr === 'farbe' ? FARBEN : HINTERGRUENDE;
    const vorsilbe = attr === 'farbe' ? 'od-farbe-' : 'od-hg-';
    const menue = { schliessen: () => {} };
    const panel = el('div', { class: `od-palette od-palette-${attr === 'farbe' ? 'farbe' : 'hg'}`, role: 'group', 'aria-label': text, hidden: true });
    const waehlen = (wert) => { menue.schliessen(); formatSetzen(ed, attr, wert); };
    for (const n of Object.keys(liste)) {
      const name = FARBNAMEN[n]();
      panel.appendChild(el('button', { class: `od-farbknopf ${vorsilbe}${n}`, type: 'button', title: name, 'aria-label': name, 'data-bearbeiten': '', onclick: () => waehlen(n) }, attr === 'farbe' ? 'A' : ''));
    }
    const eigen = el('input', { type: 'color', class: 'od-farbe-eigen', title: t('office.dok_farbe_eigen'), 'aria-label': t('office.dok_farbe_eigen'), 'data-bearbeiten': '' });
    eigen.addEventListener('change', () => { const w = String(eigen.value || '').toLowerCase(); if (/^#[0-9a-f]{6}$/.test(w)) waehlen(w); });
    const ohne = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', 'aria-label': t('office.dok_farbe_ohne'), 'data-bearbeiten': '', onclick: () => waehlen(null) }, t('office.dok_farbe_ohne'));
    panel.appendChild(el('div', { class: 'od-palette-zeile' }, [eigen, ohne]));
    const auf = knopf(symbolName, text, () => {
      const offen = panel.hidden;
      for (const m of z.menues) m.schliessen();
      panel.hidden = !offen;
      auf.setAttribute('aria-expanded', offen ? 'true' : 'false');
    });
    auf.setAttribute('aria-haspopup', 'true'); auf.setAttribute('aria-expanded', 'false');
    menue.wurzel = el('div', { class: 'od-menue' }, [auf, panel]);
    menue.schliessen = () => { panel.hidden = true; auf.setAttribute('aria-expanded', 'false'); };
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); menue.schliessen(); auf.focus(); } });
    z.menues.push(menue);
    return menue.wurzel;
  }

  function bauen() {
    element.textContent = '';
    z.inline.clear(); z.liste.clear(); z.ausr.clear(); z.menues = [];
    if (ed.nurLesen) return;
    z.zurueck = knopf('rueckgaengig', t('office.dok_rueckgaengig'), () => rueckgaengig(ed));
    z.vor = knopf('wiederholen', t('office.dok_wiederholen'), () => wiederholen(ed));
    z.absatz = el('select', { class: 'od-absatz', 'aria-label': t('office.dok_absatzformat'), title: t('office.dok_absatzformat'), 'data-bearbeiten': '' }, [
      el('option', { value: '', text: t('office.dok_absatz') }),
      el('option', { value: '1', text: t('office.dok_ueberschrift_1') }),
      el('option', { value: '2', text: t('office.dok_ueberschrift_2') }),
      el('option', { value: '3', text: t('office.dok_ueberschrift_3') }),
    ]);
    z.absatz.addEventListener('change', () => {
      const aw = aktuelleAuswahl(ed);
      zeilenformatSetzen(ed, 'ueberschrift', z.absatz.value ? Number(z.absatz.value) : null);
      zurueckInDenText(ed, ed.auswahl() || aw);
    });
    const inline = [['fett', 'fett', t('office.dok_fett')], ['kursiv', 'kursiv', t('office.dok_kursiv')], ['unterstrichen', 'unterstrichen', t('office.dok_unterstrichen')],
      ['durchgestrichen', 'durchgestrichen', t('office.dok_durchgestrichen')], ['code', 'code', t('office.dok_code')]];
    const inlineKnoepfe = inline.map(([attr, sym, text]) => { const b = knopf(sym, text, () => formatUmschalten(ed, attr), { umschalter: true }); z.inline.set(attr, b); return b; });
    const listen = [['punkte', 'liste-punkte', t('office.dok_liste_punkte')], ['zahlen', 'liste-zahlen', t('office.dok_liste_zahlen')], ['aufgabe', 'liste-aufgabe', t('office.dok_liste_aufgabe')]];
    const listenKnoepfe = listen.map(([art, sym, text]) => { const b = knopf(sym, text, () => zeilenformatSetzen(ed, 'liste', art), { umschalter: true }); z.liste.set(art, b); return b; });
    const ausr = [['links', 'ausrichten-links', t('office.dok_ausrichten_links')], ['mitte', 'ausrichten-mitte', t('office.dok_ausrichten_mitte')],
      ['rechts', 'ausrichten-rechts', t('office.dok_ausrichten_rechts')], ['block', 'ausrichten-block', t('office.dok_ausrichten_block')]];
    const ausrKnoepfe = ausr.map(([w, sym, text]) => { const b = knopf(sym, text, () => zeilenformatSetzen(ed, 'ausrichtung', w), { umschalter: true }); z.ausr.set(w, b); return b; });
    z.zitat = knopf('zitat', t('office.dok_zitat'), () => zeilenformatSetzen(ed, 'zitat', true), { umschalter: true });
    const aktion = (name) => () => { const fn = ed.aktionen && ed.aktionen[name]; if (typeof fn === 'function') fn(); };
    element.append(
      gruppe(z.zurueck, z.vor),
      gruppe(z.absatz),
      gruppe(...inlineKnoepfe),
      gruppe(palette('farbe', 'farbe', t('office.dok_farbe')), palette('hintergrund', 'markieren', t('office.dok_hervorheben'))),
      gruppe(knopf('link', t('office.dok_link'), () => linkBearbeiten(ed))),
      gruppe(...listenKnoepfe),
      gruppe(knopf('einzug-weniger', t('office.dok_einzug_weniger'), () => einzug(ed, -1)), knopf('einzug-mehr', t('office.dok_einzug_mehr'), () => einzug(ed, 1))),
      gruppe(...ausrKnoepfe),
      gruppe(z.zitat),
      gruppe(
        knopf('tabelle', t('office.dok_tabelle'), aktion('tabelle'), { klasse: 'od-knopf-tabelle' }),
        knopf('bild', t('office.dok_bild'), aktion('bild'), { klasse: 'od-knopf-bild' }),
        knopf('seitenumbruch', t('office.dok_seitenumbruch'), aktion('seitenumbruch'), { klasse: 'od-knopf-seitenumbruch' }),
      ),
      gruppe(knopf('kommentar', t('office.dok_kommentar'), aktion('kommentar'), { klasse: 'od-knopf-kommentar' })),
    );
    for (const zusatz of ed.leisteZusaetze || []) { const g = zusatz(); if (g) element.appendChild(g); }
    aktualisierenJetzt();
  }

  function aktualisierenJetzt() {
    if (ed.nurLesen || !z.absatz) return;
    const aw = aktuelleAuswahl(ed);
    const f = aw ? formateJetzt(ed, aw) : { inline: {}, zeile: {} };
    for (const [attr, b] of z.inline) b.setAttribute('aria-pressed', f.inline[attr] === true ? 'true' : 'false');
    for (const [art, b] of z.liste) b.setAttribute('aria-pressed', f.zeile.liste === art ? 'true' : 'false');
    for (const [w, b] of z.ausr) b.setAttribute('aria-pressed', (f.zeile.ausrichtung || 'links') === w ? 'true' : 'false');
    z.zitat.setAttribute('aria-pressed', f.zeile.zitat ? 'true' : 'false');
    z.absatz.value = f.zeile.ueberschrift ? String(f.zeile.ueberschrift) : '';
    z.zurueck.disabled = !ed.verlauf.kannZurueck;
    z.vor.disabled = !ed.verlauf.kannVor;
  }

  function tasteGedrueckt(e) {
    if (ed.komposition || e.isComposing) return;
    for (let k = e.target; k && k !== ed.wurzel; k = k.parentNode) if (k.nodeType === 1 && k.classList && k.classList.contains('od-embed')) return; // Zellen regeln das selbst
    const befehl = tasteAuswerten(e);
    if (!befehl) return;
    if (befehl === 'einzug_mehr' || befehl === 'einzug_weniger') {
      if (ed.nurLesen) return;
      const aw = ed.auswahl();
      if (!aw) return;
      if (zeileBei(ed.zeilen, vonBis(aw)[0]).attribute.liste) { e.preventDefault(); einzug(ed, befehl === 'einzug_mehr' ? 1 : -1); } else if (befehl === 'einzug_mehr') { e.preventDefault(); tabulator(ed, aw); }
      return;
    }
    if (befehl === 'erledigt') {
      const aw = ed.auswahl();
      if (aw && typeof ed.erledigtUmschalten === 'function' && ed.erledigtUmschalten(zeileBei(ed.zeilen, vonBis(aw)[0]))) e.preventDefault();
      return;
    }
    e.preventDefault();
    if (befehl === 'link') linkBearbeiten(ed);
    else if (befehl === 'zurueck') rueckgaengig(ed);
    else if (befehl === 'vor') wiederholen(ed);
    else formatUmschalten(ed, befehl);
  }

  /** Links: im Editor Strg/⌘+Klick, im Nur-lesen-Modus der normale Klick. */
  function klick(e) {
    const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a.od-link') : null;
    if (!a || !(ed.nurLesen || e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const url = a.getAttribute('href');
    if (linkErlaubt(url)) globalThis.open(url, '_blank', 'noopener');
  }

  // Knöpfe nehmen dem Text weder Fokus noch Auswahl
  const mausAb = (e) => { if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) e.preventDefault(); };
  const draussen = (e) => { for (const m of z.menues) if (!m.wurzel.contains(e.target)) m.schliessen(); };
  element.addEventListener('mousedown', mausAb);
  ed.wurzel.addEventListener('keydown', tasteGedrueckt);
  ed.wurzel.addEventListener('click', klick);
  document.addEventListener('pointerdown', draussen);
  ed.formatEingabe = (art) => { const attr = FORMAT_EINGABE.get(art); if (attr) formatUmschalten(ed, attr); };
  ed.verlaufEingabe = (art) => { if (art === 'historyUndo') rueckgaengig(ed); else if (art === 'historyRedo') wiederholen(ed); };
  ed.leisteAktualisieren = aktualisierenJetzt;
  const ab = [ed.on('auswahl', aktualisierenJetzt), ed.on('gerendert', aktualisierenJetzt), ed.on('recht', bauen)];
  ed.beimVerlassen.push(() => {
    for (const x of ab) x();
    ed.wurzel.removeEventListener('keydown', tasteGedrueckt);
    ed.wurzel.removeEventListener('click', klick);
    document.removeEventListener('pointerdown', draussen);
  });
  bauen();
  return { aktualisieren: aktualisierenJetzt, element };
}
