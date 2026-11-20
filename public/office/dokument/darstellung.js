// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Darstellung des Office-Dokuments (Plan 05): je Zeile ein div.od-zeile mit Text-Läufen (Klassen .od-*), Embeds
// (.od-embed, zählen als ein Zeichen) und nicht zählenden Teilen (.od-nt, br). Dazu die Abbildung DOM-Stelle ↔ Index
// im Delta, die der Editor für Auswahl und Eingabe braucht. Neu gezeichnet werden nur Zeilen, deren Inhalt sich
// geändert hat – so bleiben Cursor und Komposition in den anderen Zeilen unberührt.

import { el, t } from '../../app.js';
import { OBJ, zeileBei, listenNummern } from './modell.js';
import { FARBEN, HINTERGRUENDE, DATEI_MUSTER, linkErlaubt } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { zellKey, sichtbareZeilen, sichtbareSpalten } from '../../gemeinsam/sync/typen/dokument-tabelle.js';

const HEX = /^#[0-9a-f]{6}$/i;
const PUNKTE = Object.freeze(['•', '◦', '▪']);
const LISTEN = Object.freeze(['punkte', 'zahlen', 'aufgabe']);
const AUSRICHTUNGEN = Object.freeze(['mitte', 'rechts', 'block']);
const SCHLUESSEL = new WeakMap(); // Zeilen-Element → Schlüssel seines Inhalts
const ZEILENART = new WeakMap(); // Zeilen-Element → [Zeilenattribute, Nummer] (Tabellen werden an Ort und Stelle abgeglichen)
const ZELLE = new WeakMap(); // td → Schlüssel des gezeigten Zellinhalts
const KOPF = new WeakMap(); // table → Schlüssel von Spalten, Breiten und Modus

const istEmbed = (k) => k.nodeType === 1 && k.classList.contains('od-embed');
const zaehltNicht = (k) => k.nodeType === 1 && (k.localName === 'br' || k.classList.contains('od-nt'));
const kinderVon = (k) => Array.prototype.slice.call(k.childNodes);

/** Text-Lauf mit Inline-Formaten → Textknoten (ohne Format), span oder a.od-link. */
function lauf(text, a) {
  const attr = a || {};
  const klassen = [];
  if (attr.fett) klassen.push('od-f');
  if (attr.kursiv) klassen.push('od-k');
  if (attr.unterstrichen) klassen.push('od-u');
  if (attr.durchgestrichen) klassen.push('od-s');
  if (attr.code) klassen.push('od-code');
  const stil = {};
  if (typeof attr.farbe === 'string') {
    if (Object.hasOwn(FARBEN, attr.farbe)) klassen.push(`od-farbe-${attr.farbe}`); else if (HEX.test(attr.farbe)) stil.color = attr.farbe;
  }
  if (typeof attr.hintergrund === 'string') {
    if (Object.hasOwn(HINTERGRUENDE, attr.hintergrund)) klassen.push(`od-hg-${attr.hintergrund}`); else if (HEX.test(attr.hintergrund)) stil.backgroundColor = attr.hintergrund;
  }
  const kommentar = typeof attr.kommentar === 'string' ? attr.kommentar : null;
  if (kommentar) klassen.push('od-kommentiert');
  const dataset = kommentar ? { kommentar } : undefined;
  if (linkErlaubt(attr.link)) {
    return el('a', { class: ['od-link', ...klassen].join(' '), href: attr.link, rel: 'noopener noreferrer', target: '_blank', style: stil, dataset }, text);
  }
  if (!klassen.length && !Object.keys(stil).length) return document.createTextNode(text);
  return el('span', { class: klassen.length ? klassen.join(' ') : undefined, style: stil, dataset }, text);
}

function bildRendern(wert, attr, { dateiUrl, nurLesen }) {
  const quelle = typeof wert.datei === 'string' && DATEI_MUSTER.test(wert.datei) ? dateiUrl(wert.datei) : '';
  const img = el('img', { class: 'od-bild', src: quelle, alt: typeof wert.alt === 'string' ? wert.alt : '', draggable: 'false' });
  if (Number.isInteger(wert.breite)) img.style.width = `${wert.breite}px`;
  img.addEventListener('error', () => { img.classList.add('od-bild-fehlt'); if (!img.getAttribute('alt')) img.setAttribute('alt', t('office.dok_bild_fehlt')); });
  const rahmen = el('span', { class: 'od-bild-rahmen od-embed', contenteditable: 'false' }, [img, nurLesen ? null : el('span', { class: 'od-bild-griff', 'aria-hidden': 'true' })]);
  if (attr && typeof attr.kommentar === 'string') { rahmen.classList.add('od-kommentiert'); rahmen.dataset.kommentar = attr.kommentar; }
  return rahmen;
}

function zellInhalt(delta) {
  return Array.isArray(delta) ? delta.filter((op) => typeof op.insert === 'string').map((op) => lauf(op.insert, op.attributes)) : [];
}

/** Tabelle: Rahmen (nicht bearbeitbar) mit Zellen als eigenen Eingabefeldern (außer im Nur-lesen-Modus). */
export function tabelleRendern(wert, { nurLesen = false } = {}) {
  const rahmen = el('div', { class: 'od-tabelle-rahmen od-embed', contenteditable: 'false', dataset: { tabelle: wert.id } }, el('table', { class: 'od-tabelle' }));
  tabelleAktualisieren(rahmen, wert, { nurLesen });
  return rahmen;
}

/** Der DOM der Zelle zeigt schon `inhalt` (gerade selbst getippt) – beim nächsten Abgleich nicht neu zeichnen. */
export function zelleMerken(td, inhalt) { ZELLE.set(td, JSON.stringify(inhalt)); }

const naechstesElement = (k) => { let x = k ? k.nextSibling : null; while (x && x.nodeType !== 1) x = x.nextSibling; return x; };

/**
 * Kinder von `eltern` auf die Kennungen `ids` bringen: Weggefallene entfernen, Fehlende an ihrer Stelle einfügen,
 * Bestehende bleiben, wo sie sind (Zeilen und Spalten werden nie umsortiert, nur eingefügt oder gelöscht).
 */
function ordnen(eltern, ids, kennung, neu, je) {
  const soll = new Set(ids);
  for (const k of kinderVon(eltern)) if (k.nodeType !== 1 || !soll.has(kennung(k))) eltern.removeChild(k);
  const da = new Map(kinderVon(eltern).map((k) => [kennung(k), k]));
  let pos = eltern.firstElementChild || null;
  for (const id of ids) {
    let k = da.get(id);
    if (!k) { k = neu(id); eltern.insertBefore(k, pos); } else if (k === pos) pos = naechstesElement(pos); else eltern.insertBefore(k, pos); // nur bei unerwarteter Reihenfolge
    je(k, id);
  }
}

/**
 * Tabelle an Ort und Stelle abgleichen: Spaltenköpfe (Griffe) und Breiten, Zeilen und Zellen nach Kennung; nur Zellen
 * mit geändertem Inhalt werden neu gefüllt, `fokusZelle` (ungesendet Getipptes) bleibt unangetastet.
 */
export function tabelleAktualisieren(rahmen, wert, { nurLesen = false, fokusZelle = null } = {}) {
  const table = rahmen.querySelector('table.od-tabelle');
  const spalten = sichtbareSpalten(wert); const zeilen = sichtbareZeilen(wert);
  const breiten = wert.breiten || {}; const zellen = wert.zellen || {};
  // Spaltenköpfe nur bei anderen Spalten neu bauen (ein laufendes Ziehen am Griff bleibt so erhalten), Breiten an Ort und Stelle
  const kopfSchluessel = JSON.stringify([spalten, nurLesen]);
  if (KOPF.get(table) !== kopfSchluessel) {
    for (const alt of kinderVon(table)) if (alt.nodeType === 1 && (alt.localName === 'colgroup' || alt.localName === 'thead')) table.removeChild(alt);
    const cols = el('colgroup', null, spalten.map(() => el('col')));
    const kopf = nurLesen ? null : el('thead', null, el('tr', { class: 'od-spaltenkopf' }, spalten.map((sp) => el('th', { dataset: { spalte: sp } }, el('span', { class: 'od-spaltengriff', 'aria-hidden': 'true' })))));
    table.insertBefore(cols, table.firstChild);
    if (kopf) table.insertBefore(kopf, cols.nextSibling);
    KOPF.set(table, kopfSchluessel);
  }
  const cols = table.querySelectorAll('col');
  spalten.forEach((sp, i) => {
    const w = Number.isInteger(breiten[sp]) ? `${breiten[sp]}px` : '';
    if (cols[i] && (cols[i].style.width || '') !== w) cols[i].style.width = w;
  });
  let body = table.querySelector('tbody');
  if (!body) { body = el('tbody'); table.appendChild(body); }
  // Zeilen und Zellen nur entfernen und einfügen, Bestehendes nie umhängen (ein umgehängtes Element verliert Fokus und Eingabe)
  ordnen(body, zeilen, (tr) => tr.dataset.zeile, (z) => el('tr', { dataset: { zeile: z } }), (tr, z) => {
    ordnen(tr, spalten, (td) => td.dataset.spalte, (sp) => el('td', { class: 'od-zelle', dataset: { zeile: z, spalte: sp } }), (td, sp) => {
      td.setAttribute('contenteditable', nurLesen ? 'false' : 'true');
      if (td === fokusZelle) return;
      const k = zellKey(z, sp);
      const inhalt = Object.hasOwn(zellen, k) ? zellen[k] : [];
      const schluessel = JSON.stringify(inhalt);
      if (ZELLE.get(td) === schluessel) return;
      td.textContent = '';
      for (const n of zellInhalt(inhalt)) td.appendChild(n);
      ZELLE.set(td, schluessel);
    });
  });
}

function embedElement(op, optionen) {
  const [name, wert] = Object.entries(op.insert)[0] || [];
  const eigen = typeof optionen.embedRendern === 'function' ? optionen.embedRendern(name, wert, op) : null;
  if (eigen) return eigen;
  if (name === 'bild' && wert && typeof wert === 'object') return bildRendern(wert, op.attributes, optionen);
  if (name === 'seitenumbruch') return el('div', { class: 'od-seitenumbruch od-embed', contenteditable: 'false' }, el('span', { text: t('office.dok_seitenumbruch') }));
  if (name === 'tabelle' && wert && typeof wert === 'object') return tabelleRendern(wert, { nurLesen: optionen.nurLesen });
  return el('span', { class: 'od-embed', contenteditable: 'false' });
}

/** Eine Zeile aus zeilenAus() → div.od-zeile. */
export function zeileRendern(zeile, { dateiUrl = () => '', nummer = null, nurLesen = false, embedRendern = null } = {}) {
  const a = zeile.attribute || {};
  const klassen = ['od-zeile'];
  if ([1, 2, 3].includes(a.ueberschrift)) klassen.push(`od-u${a.ueberschrift}`);
  const liste = LISTEN.includes(a.liste) ? a.liste : null;
  if (liste) klassen.push('od-liste', `od-liste-${liste}`);
  if (a.erledigt) klassen.push('od-erledigt');
  if (Number.isInteger(a.einzug) && a.einzug >= 1 && a.einzug <= 8) klassen.push(`od-einzug-${a.einzug}`);
  if (AUSRICHTUNGEN.includes(a.ausrichtung)) klassen.push(`od-ausr-${a.ausrichtung}`);
  if (a.zitat) klassen.push('od-zitat');
  if (zeile.block) klassen.push('od-block-zeile');
  const e = el('div', { class: klassen.join(' ') });
  if (liste === 'zahlen' && nummer) e.dataset.marke = nummer;
  else if (liste === 'punkte') e.dataset.marke = PUNKTE[(Number.isInteger(a.einzug) ? a.einzug : 0) % PUNKTE.length];
  if (liste === 'aufgabe') {
    e.appendChild(el('span', { class: 'od-haken od-nt', contenteditable: 'false', role: 'checkbox', 'aria-checked': a.erledigt ? 'true' : 'false', 'aria-disabled': nurLesen ? 'true' : undefined }));
  }
  const optionen = { dateiUrl, nurLesen, embedRendern };
  for (const op of zeile.inhalt) e.appendChild(typeof op.insert === 'string' ? lauf(op.insert, op.attributes) : embedElement(op, optionen));
  if (!zeile.inhalt.length) e.appendChild(el('br'));
  return e;
}

/**
 * Zeilen in `wurzel` zeichnen: Abgleich nach Position, unveränderte Zeilen (gleicher Inhalt, gleiche Attribute, gleiche
 * Nummer, gleicher Modus) bleiben dieselben Elemente. `optionen.behalten` lässt Elemente unangetastet: als Set<Element>
 * werden sie beim Abgleich übersprungen; als Map mit einem Eintrag Element → Zeilennummer (Komposition) bleibt das
 * Element stehen und die Zeilen davor und dahinter werden getrennt abgeglichen – so landet es an seiner Zeile, ohne
 * dass der Knoten bewegt wird (das bräche die Eingabe ab).
 */
export function dokumentRendern(wurzel, zeilen, optionen = {}) {
  const behalten = optionen.behalten || null;
  const nummern = listenNummern(zeilen);
  // Text o. ä. direkt in der Wurzel gehört zu keiner Zeile (nicht während einer Komposition anfassen)
  if (!behalten || !behalten.size) for (const k of kinderVon(wurzel)) if (k.nodeType !== 1) wurzel.removeChild(k);
  if (behalten instanceof Map && behalten.size === 1) {
    const [[k, ziel]] = [...behalten];
    if (k.parentNode === wurzel && Number.isInteger(ziel) && ziel >= 0 && ziel < zeilen.length) {
      abgleichen(wurzel, zeilen, nummern, optionen, 0, ziel, null, k);
      abgleichen(wurzel, zeilen, nummern, optionen, ziel + 1, zeilen.length, k, null);
      return;
    }
  }
  abgleichen(wurzel, zeilen, nummern, optionen, 0, zeilen.length, null, null, behalten);
}

/** Zeilen [a, b) gegen die Elemente zwischen `nach` und `vor` (je ausschließlich, null = Rand) abgleichen. */
function abgleichen(wurzel, zeilen, nummern, optionen, a, b, nach, vor, ueberspringen = null) {
  const alle = Array.prototype.slice.call(wurzel.children);
  const els = alle.slice(nach ? alle.indexOf(nach) + 1 : 0, vor ? alle.indexOf(vor) : alle.length);
  const n = b - a;
  const schluessel = Array.from({ length: n }, (_, k) => JSON.stringify([zeilen[a + k].inhalt, zeilen[a + k].attribute, nummern[a + k], !!optionen.nurLesen]));
  const passt = (el, k) => !!el && !(ueberspringen && ueberspringen.has(el)) && SCHLUESSEL.get(el) === schluessel[k];
  // gemeinsamer Anfang und gemeinsames Ende bleiben stehen: eine neue oder gelöschte Zeile zeichnet nicht alles danach neu
  let anfang = 0;
  while (anfang < n && anfang < els.length && passt(els[anfang], anfang)) anfang++;
  let ende = 0;
  while (ende < n - anfang && ende < els.length - anfang && passt(els[els.length - 1 - ende], n - 1 - ende)) ende++;
  const mitte = els.slice(anfang, els.length - ende);
  const halt = ende > 0 ? els[els.length - ende] : vor;
  for (let k = anfang; k < n - ende; k++) {
    const i = a + k; const alt = mitte[k - anfang];
    if (alt && ueberspringen && ueberspringen.has(alt)) continue;
    if (alt && SCHLUESSEL.get(alt) === schluessel[k]) continue;
    const art = JSON.stringify([zeilen[i].attribute, nummern[i]]);
    if (alt && zeilen[i].block === 'tabelle' && ZEILENART.get(alt) === art) {
      // dieselbe Tabelle: an Ort und Stelle abgleichen, damit Fokus und Cursor in einer Zelle bleiben
      const wert = zeilen[i].inhalt[0].insert.tabelle;
      const rahmen = alt.querySelector('.od-tabelle-rahmen');
      if (rahmen && rahmen.dataset.tabelle === wert.id) {
        tabelleAktualisieren(rahmen, wert, { nurLesen: !!optionen.nurLesen, fokusZelle: optionen.fokusZelle || null });
        SCHLUESSEL.set(alt, schluessel[k]);
        continue;
      }
    }
    const neu = zeileRendern(zeilen[i], { ...optionen, nummer: nummern[i] });
    SCHLUESSEL.set(neu, schluessel[k]); ZEILENART.set(neu, art);
    if (alt) alt.replaceWith(neu); else wurzel.insertBefore(neu, halt);
  }
  for (const rest of mitte.slice(Math.max(0, n - ende - anfang))) wurzel.removeChild(rest);
}

/** Text einer Zeile wie im Modell: Embeds als U+FFFC, Häkchen und br zählen nicht. */
export function textAusDom(zeilenEl) {
  let s = '';
  const gehe = (k) => {
    for (const c of kinderVon(k)) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType !== 1 || zaehltNicht(c)) continue;
      else if (istEmbed(c)) s += OBJ;
      else gehe(c);
    }
  };
  gehe(zeilenEl);
  return s;
}

/** Zeichen vor der DOM-Stelle (knoten, offset) innerhalb der Zeile; Stellen in einem Embed → dessen Anfang. */
export function zeilenOffset(zeilenEl, knoten, offset) {
  let n = 0;
  const gehe = (k) => {
    const kinder = kinderVon(k);
    for (let i = 0; i < kinder.length; i++) {
      if (k === knoten && i === offset) return true;
      const c = kinder[i];
      if (c.nodeType === 3) {
        if (c === knoten) { n += Math.min(Math.max(0, offset), c.data.length); return true; }
        n += c.data.length;
      } else if (c.nodeType === 1) {
        const drin = c === knoten || c.contains(knoten);
        if (istEmbed(c)) { if (drin) return true; n += 1; } else if (zaehltNicht(c)) { if (drin) return true; } else if (gehe(c)) return true;
      }
    }
    return k === knoten;
  };
  gehe(zeilenEl);
  return n;
}

/** DOM-Stelle → Index im Delta; liegt sie nicht in einer Zeile von `wurzel` → null. */
export function domZuIndex(wurzel, zeilen, knoten, offset) {
  if (!knoten || !wurzel.contains(knoten) || !zeilen.length) return null;
  if (knoten === wurzel) {
    const nr = kinderVon(wurzel).slice(0, offset).filter((k) => k.nodeType === 1).length;
    if (nr < zeilen.length) return zeilen[nr].start;
    const letzte = zeilen[zeilen.length - 1];
    return letzte.start + letzte.laenge - 1;
  }
  let zeilenEl = knoten;
  while (zeilenEl.parentNode !== wurzel) zeilenEl = zeilenEl.parentNode;
  const nr = Array.prototype.indexOf.call(wurzel.children, zeilenEl);
  if (nr < 0 || nr >= zeilen.length) return null;
  return zeilen[nr].start + zeilenOffset(zeilenEl, knoten, offset);
}

/**
 * Index → DOM-Stelle: erster Textknoten, in dem der Index liegt (am Gleichstand das Ende des vorigen), an Embed-Grenzen
 * {Elternelement, Kindindex}, in einer leeren Zeile vor dem ersten zählenden Kind (hinter dem Häkchen).
 */
export function indexZuDom(wurzel, zeilen, index) {
  const zeile = zeilen.length ? zeileBei(zeilen, index) : null;
  const zeilenEl = zeile ? wurzel.children[zeile.nr] : null;
  if (!zeilenEl) return { knoten: wurzel, offset: wurzel.childNodes.length };
  const o = Math.max(0, Math.min(index - zeile.start, zeile.laenge - 1));
  let p = 0; let treffer = null; let ersatz = null;
  const gehe = (k) => {
    const kinder = kinderVon(k);
    for (let i = 0; i < kinder.length && !treffer; i++) {
      const c = kinder[i];
      if (c.nodeType === 3) {
        if (o >= p && o <= p + c.data.length) treffer = { knoten: c, offset: o - p };
        p += c.data.length;
      } else if (c.nodeType === 1 && !zaehltNicht(c)) {
        if (istEmbed(c)) {
          if (o === p) { treffer = { knoten: k, offset: i }; break; }
          p += 1;
          if (o === p) ersatz = { knoten: k, offset: i + 1 };
        } else gehe(c);
      }
    }
  };
  gehe(zeilenEl);
  if (treffer) return treffer;
  if (ersatz) return ersatz;
  const kinder = kinderVon(zeilenEl);
  if (p === 0) {
    const erstes = kinder.findIndex((k) => !(k.nodeType === 1 && k.classList.contains('od-nt')));
    return { knoten: zeilenEl, offset: erstes < 0 ? kinder.length : erstes };
  }
  const letztes = kinder[kinder.length - 1];
  return { knoten: zeilenEl, offset: kinder.length - (letztes && letztes.nodeType === 1 && letztes.localName === 'br' ? 1 : 0) };
}
