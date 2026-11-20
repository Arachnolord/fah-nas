// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Raster der Office-Tabelle (Plan 06): eine Scrollfläche mit einem Abstandhalter in voller Größe; gezeichnet werden nur
// die sichtbaren Zellen (plus Puffer), absolut per transform gesetzt und beim Bildlauf aus einem Vorrat wiederverwendet.
// Kopfzeile (A, B, …) und Kopfspalte (1, 2, …) sind angeheftet (sticky), eine fixierte erste Zeile liegt als zweite
// angeheftete Ebene darunter. Darüber liegen die eigene Auswahl, fremde Auswahlen (Rahmen in der Farbe der Person, das
// Namensschild nur kurz nach jeder Bewegung) und das Eingabefeld der Zelle. Jeder Spaltenkopf trägt einen Griff für die Breite (Vorschau beim Ziehen,
// Op beim Loslassen), die gefilterte Spalte dazu den Filterknopf. Das Raster ist immer hell wie Papier. Es liest alles
// aus dem Editor (ed); ändern kann es nur die Spaltenbreite (über ed.aendern).

import { el, t, symbol } from '../../app.js';
import { GRENZEN, adresse, spalteZuText } from './formeln/adresse.js';
import { wertAnzeigen, istFehler } from './formeln/werte.js';
import { Masse, masseAusBlatt, sichtbarerBereich } from './masse.js';
import { bereichVon, ausSyncAuswahl } from './auswahl.js';

/** Höhe der Kopfzeile und Breite der Kopfspalte (px). */
export const KOPF_HOEHE = 24;
export const KOPF_BREITE = 48;
/** Ohne messbare Größe (noch nicht im Layout, Tests) gilt dieser Ausschnitt [Entscheidung Planer]. */
const RUECKFALL = Object.freeze({ hoehe: 600, breite: 800 });
/** Spaltenbreite beim Ziehen am Griff (px, wie der Datentyp). */
const BREITE = Object.freeze({ min: 20, max: 1000 });
/** Namensschild einer fremden Auswahl: so lange nach jeder Bewegung, danach nur der Rahmen (es verdeckt die Zelle darüber). */
export const NAME_MS = 3000;
/** Gemeinsame leere Menge „keine Zeile ausgeblendet“ (wird nie verändert). */
const KEINE = new Set();

/**
 * Raster für den Editor `ed` bauen → { element, zellEingabe, zeichnen(), zelleBei(x, y), zellElement(z, s),
 * sichtbarMachen(z, s), masse(), entfernen() }. ed liefert: sitzung, rechner, blatt/aktivesBlatt(), aw, fremd,
 * filter, stand, bearbeitet/bearbeitOrt/bearbeitZelle, neuZeichnen().
 */
export function rasterBauen(ed) {
  const ecke = el('div', { class: 'ot-ecke', 'aria-hidden': 'true' });
  const kopfzeile = el('div', { class: 'ot-kopfzeile' }, [ecke]);
  const fixKopf = el('div', { class: 'ot-kopfspalte' });
  const fixzeile = el('div', { class: 'ot-fixzeile', hidden: true }, [fixKopf]);
  const kopfspalte = el('div', { class: 'ot-kopfspalte' });
  const koerper = el('div', { class: 'ot-koerper' }, [kopfspalte]);
  const flaeche = el('div', { class: 'ot-flaeche' }, [kopfzeile, fixzeile, koerper]);
  const element = el('div', { class: 'ot-raster', tabindex: '0', role: 'grid', 'aria-label': t('office.tab_raster') }, [flaeche]);
  const zellEingabe = el('input', {
    class: 'ot-zelleingabe', type: 'text', hidden: true, autocomplete: 'off', spellcheck: 'false', maxlength: GRENZEN.w,
    'aria-label': t('office.tab_formel'),
  });
  koerper.appendChild(zellEingabe); // liegt immer bereit (versteckt), damit der Fokus beim Zeigen nicht verloren geht

  const z = {
    zellen: new Map(), // 'z|s' → Eintrag {el, adr, text, klassen, pos, b, h, zf, zh}
    vorrat: [], // freie Zelleinträge
    koepfe: new Map(), // 's<n>' bzw. 'z<n>' → Kopfeintrag
    kopfVorrat: { spalte: [], zeile: [] },
    auswahl: [el('div', { class: 'ot-auswahl', 'aria-hidden': 'true' }), el('div', { class: 'ot-auswahl', 'aria-hidden': 'true' })],
    fremd: [], // Elemente fremder Auswahlen (jedes Zeichnen neu)
    namenUhr: null, // weckt das Raster, wenn das nächste Namensschild verschwindet
    masse: null, // {blatt, versteckt, wert: {zeilen, spalten}}
    ro: null,
  };

  // ---- Maße --------------------------------------------------------------------------------------------------------

  /** Vom Filter ausgeblendete Zeilen des Blatts (eine Ansicht, nur bei mir; beim Setzen festgehalten, ed.filterSetzen). */
  function versteckteFuer(blatt) {
    const filter = ed.filter.get(blatt.id);
    return filter && filter.versteckt instanceof Set ? filter.versteckt : KEINE;
  }

  /**
   * Maße des aktiven Blatts {zeilen, spalten}, solange Blatt, Ausblendung und Breiten-Vorschau gleich bleiben aus dem
   * Vorrat. Die Vorschau (ed.breiteVorschau beim Ziehen am Griff) gilt nur hier, gesendet wird erst beim Loslassen.
   */
  function masse() {
    const blatt = ed.aktivesBlatt();
    if (!blatt) return masseAusBlatt(null);
    const versteckt = versteckteFuer(blatt);
    const vorschau = ed.breiteVorschau && ed.breiteVorschau.blatt === blatt.id ? ed.breiteVorschau : null;
    const m = z.masse;
    if (m && m.blatt === blatt && m.versteckt === versteckt && m.vorschau === vorschau) return m.wert;
    let wert = masseAusBlatt(blatt, { versteckt });
    if (vorschau) {
      const sp = wert.spalten;
      wert = { zeilen: wert.zeilen, spalten: new Masse({ standard: sp.standard, eigene: new Map(sp.eigene).set(vorschau.spalte, vorschau.breite), anzahl: sp.anzahl }) };
    }
    z.masse = { blatt, versteckt, vorschau, wert };
    return wert;
  }

  // ---- Spaltenbreite und Filterknopf im Spaltenkopf ----------------------------------------------------------------

  const breiteGrenzen = (b) => Math.min(BREITE.max, Math.max(BREITE.min, Math.round(b)));

  /**
   * Griff am rechten Rand eines Spaltenkopfs: Ziehen zeigt die neue Breite sofort (Vorschau), die Op geht erst beim
   * Loslassen (20–1000 px); Doppelklick setzt die Standardbreite. Nimmt der Kopfzeile das Ereignis (keine Spaltenwahl).
   */
  function griffBauen() {
    const griff = el('div', { class: 'ot-griff', title: t('office.tab_spaltenbreite'), 'aria-hidden': 'true' });
    let zug = null;
    const spalte = () => Number(griff.getAttribute('data-spalte'));
    griff.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (ed.nurLesen || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      const s = spalte();
      const b0 = masse().spalten.groesse(s);
      zug = { id: e.pointerId, s, blatt: ed.blatt, x0: e.clientX || 0, b0 };
      try { griff.setPointerCapture(e.pointerId); } catch { /* ohne Capture endet das Ziehen am Rand */ }
    });
    griff.addEventListener('pointermove', (e) => {
      if (!zug || e.pointerId !== zug.id) return;
      const breite = breiteGrenzen(zug.b0 + (e.clientX || 0) - zug.x0);
      const v = ed.breiteVorschau;
      if (v && v.blatt === zug.blatt && v.spalte === zug.s && v.breite === breite) return;
      ed.breiteVorschau = { blatt: zug.blatt, spalte: zug.s, breite };
      ed.neuZeichnen();
    });
    const ende = (e, uebernehmen) => {
      if (!zug || e.pointerId !== zug.id) return;
      const { s, blatt, b0 } = zug;
      const breite = breiteGrenzen(zug.b0 + (e.clientX || 0) - zug.x0);
      zug = null;
      ed.breiteVorschau = null;
      try { griff.releasePointerCapture(e.pointerId); } catch { /* egal */ }
      if (uebernehmen && breite !== b0) ed.aendern({ typ: 'spalte_breite', blatt, spalte: s, breite });
      ed.neuZeichnen();
    };
    griff.addEventListener('pointerup', (e) => { e.stopPropagation(); ende(e, true); });
    griff.addEventListener('pointercancel', (e) => ende(e, false));
    griff.addEventListener('click', (e) => e.stopPropagation());
    griff.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const blatt = ed.aktivesBlatt();
      const s = spalte();
      if (!blatt || ed.nurLesen || !(blatt.spalten && blatt.spalten[spalteZuText(s)])) return;
      ed.aendern({ typ: 'spalte_breite', blatt: blatt.id, spalte: s, breite: null });
    });
    return griff;
  }

  /** Filterknopf im Kopf der gefilterten Spalte (öffnet den Filterdialog dieser Spalte). */
  function filterKnopfSetzen(e, an) {
    if (an && !e.filterKnopf) {
      e.filterKnopf = el('button', {
        class: 'ot-filterknopf', type: 'button', title: t('office.tab_filter_spalte'), 'aria-label': t('office.tab_filter_spalte'),
        onclick: (ev) => { ev.stopPropagation(); if (typeof ed.filterOeffnen === 'function') ed.filterOeffnen(e.nummer); },
      }, symbol('filter'));
      e.filterKnopf.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      e.el.appendChild(e.filterKnopf);
    } else if (!an && e.filterKnopf) {
      e.filterKnopf.remove();
      e.filterKnopf = null;
    }
  }

  /** Fixierte erste Zeile: Höhe der angehefteten Ebene (0 = nicht fixiert). */
  function fixHoehe(blatt, zeilen) {
    return blatt && blatt.fixiert && blatt.fixiert.zeilen === 1 ? zeilen.groesse(1) : 0;
  }

  // ---- Zeichnen ----------------------------------------------------------------------------------------------------

  function farbeSetzen(e, name, wert) {
    const neu = typeof wert === 'string' ? wert : '';
    if (e[name] === neu) return;
    e[name] = neu;
    if (neu) e.el.style.setProperty(name, neu); else e.el.style.removeProperty(name);
  }

  /** Eine Zelle an ihren Platz setzen; nur Geändertes fasst das DOM an. */
  function zelleSetzen(e, blatt, zz, s, ebene, x, y, b, h) {
    const adr = adresse(zz, s);
    const zelle = blatt.zellen ? blatt.zellen[adr] : undefined;
    const f = zelle && zelle.f;
    const wert = zelle && typeof zelle.w === 'string' ? ed.rechner.wert(blatt.id, adr) : null;
    const text = wertAnzeigen(wert, (f && f.zahl) || null);
    // ohne eigene Ausrichtung: Zahlen rechts, Wahrheitswerte und Fehler mittig, sonst links (wie Excel)
    const ausr = (f && f.ausr) || (typeof wert === 'number' ? 'rechts' : typeof wert === 'boolean' || istFehler(wert) ? 'mitte' : 'links');
    const klassen = `ot-zelle ot-ausr-${ausr}${f && f.fett ? ' ot-fett' : ''}${f && f.kursiv ? ' ot-kursiv' : ''}`;
    if (e.adr !== adr) { e.el.setAttribute('data-adr', adr); e.adr = adr; }
    if (e.text !== text) { e.el.textContent = text; e.text = text; }
    if (e.klassen !== klassen) { e.el.className = klassen; e.klassen = klassen; }
    farbeSetzen(e, '--zf', f && f.farbe);
    farbeSetzen(e, '--zh', f && f.hinter);
    const pos = `translate(${x}px, ${y}px)`;
    if (e.pos !== pos) { e.el.style.transform = pos; e.pos = pos; }
    if (e.b !== b) { e.el.style.width = `${b}px`; e.b = b; }
    if (e.h !== h) { e.el.style.height = `${h}px`; e.h = h; }
    if (e.el.parentNode !== ebene) ebene.appendChild(e.el);
  }

  /** Kopf (Spalte oder Zeile) an seinen Platz setzen; aktiv = Teil der eigenen Auswahl, gefiltert = Filterknopf. */
  function kopfSetzen(art, nummer, ebene, versatz, groesse, aktiv, gefiltert = false) {
    const schluessel = `${art === 'spalte' ? 's' : 'z'}${nummer}`;
    let e = z.koepfe.get(schluessel);
    if (e) z.koepfe.delete(schluessel);
    else {
      e = z.kopfVorrat[art].pop();
      if (!e) {
        const textEl = el('span', { class: 'ot-kopf-text' });
        e = { el: el('div', { class: `ot-kopf ot-kopf-${art}` }, [textEl]), textEl, art, griff: null, filterKnopf: null };
        if (art === 'spalte') { e.griff = griffBauen(); e.el.appendChild(e.griff); }
      }
    }
    if (e.nummer !== nummer) {
      e.el.setAttribute(art === 'spalte' ? 'data-s' : 'data-z', String(nummer));
      if (e.griff) e.griff.setAttribute('data-spalte', String(nummer));
      e.textEl.textContent = art === 'spalte' ? spalteZuText(nummer) : String(nummer);
      e.nummer = nummer;
    }
    if (art === 'spalte') filterKnopfSetzen(e, gefiltert);
    const pos = art === 'spalte' ? `translate(${versatz}px, 0px)` : `translate(0px, ${versatz}px)`;
    if (e.pos !== pos) { e.el.style.transform = pos; e.pos = pos; }
    if (e.groesse !== groesse) { e.el.style[art === 'spalte' ? 'width' : 'height'] = `${groesse}px`; e.groesse = groesse; }
    if (e.aktiv !== aktiv) { e.el.classList.toggle('ot-kopf-aktiv', aktiv); e.aktiv = aktiv; }
    if (e.el.parentNode !== ebene) ebene.appendChild(e.el);
    return [schluessel, e];
  }

  /**
   * Rechteck eines Bereichs in den Ebenen: bei fixierter erster Zeile bis zu zwei Teile (Zeile 1 oben angeheftet, der Rest
   * im Körper) → [{ebene, x, y, b, h, oben}] (oben = beginnt in der obersten sichtbaren Zeile, das Namensschild muss
   * nach unten).
   */
  function rechteckTeile(b, zeilen, spalten, h1) {
    const x = KOPF_BREITE + spalten.position(b.s1);
    const breite = spalten.position(b.s2 + 1) - spalten.position(b.s1);
    const teile = [];
    if (h1 && b.z1 === 1) teile.push({ ebene: fixzeile, x, y: 0, b: breite, h: h1, oben: true });
    const z1 = h1 ? Math.max(2, b.z1) : b.z1;
    if (z1 <= b.z2) {
      const y = zeilen.position(z1) - h1;
      teile.push({ ebene: koerper, x, y, b: breite, h: zeilen.position(b.z2 + 1) - zeilen.position(z1), oben: !h1 && z1 === 1 });
    }
    return teile.filter((p) => p.b > 0 && p.h > 0);
  }

  function rahmenSetzen(knoten, p) {
    knoten.style.transform = `translate(${p.x}px, ${p.y}px)`;
    knoten.style.width = `${p.b}px`;
    knoten.style.height = `${p.h}px`;
    if (knoten.parentNode !== p.ebene) p.ebene.appendChild(knoten);
  }

  /** Eigene und fremde Auswahl als Rahmen; fremde nur auf dem aktiven Blatt, kurz nach einer Bewegung mit Namensschild am obersten Teil. */
  function auswahlZeichnen(blatt, zeilen, spalten, h1) {
    const teile = ed.aw && ed.aw.blatt === blatt.id ? rechteckTeile(bereichVon(ed.aw), zeilen, spalten, h1) : [];
    z.auswahl.forEach((knoten, i) => { if (teile[i]) rahmenSetzen(knoten, teile[i]); else knoten.remove(); });

    for (const knoten of z.fremd) knoten.remove();
    z.fremd = [];
    const jetzt = Date.now(); let naechstes = Infinity;
    for (const f of ed.fremd.values()) {
      const a = ausSyncAuswahl(f.auswahl);
      if (!a || a.blatt !== blatt.id) continue;
      const rest = (f.seit || 0) + NAME_MS - jetzt;
      if (rest > 0) naechstes = Math.min(naechstes, rest);
      rechteckTeile(bereichVon(a), zeilen, spalten, h1).forEach((p, i) => {
        const knoten = el('div', { class: `ot-fremd${p.oben ? ' ot-fremd-oben' : ''}`, 'aria-hidden': 'true', style: { '--farbe': f.farbe || null } },
          i === 0 && rest > 0 ? [el('span', { class: 'ot-fremd-name', text: f.name })] : []);
        rahmenSetzen(knoten, p);
        z.fremd.push(knoten);
      });
    }
    if (z.namenUhr) { clearTimeout(z.namenUhr); z.namenUhr = null; }
    if (naechstes < Infinity) z.namenUhr = setTimeout(() => { z.namenUhr = null; ed.neuZeichnen(); }, naechstes);
  }

  /** Eingabefeld über der bearbeiteten Zelle (nur beim Bearbeiten in der Zelle und auf deren Blatt). */
  function eingabeSetzen(blatt, zeilen, spalten, h1) {
    const ort = ed.bearbeitZelle;
    const zeigen = ed.bearbeitet && ed.bearbeitOrt === 'zelle' && ort && ort.blatt === blatt.id;
    if (!zeigen) { if (!zellEingabe.hidden) zellEingabe.hidden = true; return; }
    const imFix = h1 && ort.z === 1;
    const ebene = imFix ? fixzeile : koerper;
    zellEingabe.style.transform = `translate(${KOPF_BREITE + spalten.position(ort.s)}px, ${imFix ? 0 : zeilen.position(ort.z) - h1}px)`;
    zellEingabe.style.width = `${Math.max(spalten.groesse(ort.s), 60)}px`;
    zellEingabe.style.height = `${Math.max(zeilen.groesse(ort.z), 24)}px`;
    if (zellEingabe.parentNode !== ebene) ebene.appendChild(zellEingabe); // nie umhängen, solange es den Fokus hat
    if (zellEingabe.hidden) zellEingabe.hidden = false;
  }

  function zeichnen() {
    const blatt = ed.aktivesBlatt();
    if (!blatt) return;
    const { zeilen, spalten } = masse();
    const h1 = fixHoehe(blatt, zeilen);
    flaeche.style.width = `${KOPF_BREITE + spalten.summe}px`;
    flaeche.style.height = `${KOPF_HOEHE + zeilen.summe}px`;
    koerper.style.top = `${KOPF_HOEHE + h1}px`;
    koerper.style.height = `${Math.max(0, zeilen.summe - h1)}px`;
    fixzeile.style.height = `${h1}px`;
    if (fixzeile.hidden !== !h1) fixzeile.hidden = !h1;

    const b = sichtbarerBereich({
      oben: element.scrollTop || 0, links: element.scrollLeft || 0,
      hoehe: element.clientHeight || RUECKFALL.hoehe, breite: element.clientWidth || RUECKFALL.breite, zeilen, spalten,
    });
    const reihen = [];
    if (h1) reihen.push(1); // die fixierte Zeile ist immer zu sehen
    for (let r = Math.max(b.z1, h1 ? 2 : 1); r <= b.z2; r++) if (zeilen.groesse(r) > 0) reihen.push(r);
    const spaltenListe = [];
    for (let s = b.s1; s <= b.s2; s++) if (spalten.groesse(s) > 0) spaltenListe.push(s);
    const aw = ed.aw && ed.aw.blatt === blatt.id ? bereichVon(ed.aw) : null;

    // Zellen: Elemente derselben Stelle behalten; was aus dem Ausschnitt fällt, geht zuerst in den Vorrat
    const gebraucht = new Set();
    for (const r of reihen) for (const s of spaltenListe) gebraucht.add(`${r}|${s}`);
    for (const [k, e] of z.zellen) if (!gebraucht.has(k)) { z.zellen.delete(k); z.vorrat.push(e); }
    const neu = new Map();
    for (const r of reihen) {
      const imFix = h1 && r === 1;
      const ebene = imFix ? fixzeile : koerper;
      const y = imFix ? 0 : zeilen.position(r) - h1;
      const h = zeilen.groesse(r);
      for (const s of spaltenListe) {
        const k = `${r}|${s}`;
        const e = z.zellen.get(k) || z.vorrat.pop() || { el: el('div', { class: 'ot-zelle' }) };
        zelleSetzen(e, blatt, r, s, ebene, KOPF_BREITE + spalten.position(s), y, spalten.groesse(s), h);
        neu.set(k, e);
      }
    }
    for (const e of z.vorrat) if (e.el.parentNode) e.el.remove();
    z.zellen = neu;

    // Köpfe ebenso
    const kopfGebraucht = new Set([...spaltenListe.map((s) => `s${s}`), ...reihen.map((r) => `z${r}`)]);
    for (const [k, e] of z.koepfe) if (!kopfGebraucht.has(k)) { z.koepfe.delete(k); z.kopfVorrat[e.art].push(e); }
    const koepfe = new Map();
    const filter = ed.filter.get(blatt.id);
    for (const s of spaltenListe) {
      const [k, e] = kopfSetzen('spalte', s, kopfzeile, KOPF_BREITE + spalten.position(s), spalten.groesse(s), !!aw && s >= aw.s1 && s <= aw.s2, !!filter && filter.spalte === s);
      koepfe.set(k, e);
    }
    for (const r of reihen) {
      const imFix = h1 && r === 1;
      const [k, e] = kopfSetzen('zeile', r, imFix ? fixKopf : kopfspalte, imFix ? 0 : zeilen.position(r) - h1, zeilen.groesse(r), !!aw && r >= aw.z1 && r <= aw.z2);
      koepfe.set(k, e);
    }
    for (const art of ['spalte', 'zeile']) for (const e of z.kopfVorrat[art]) if (e.el.parentNode) e.el.remove();
    z.koepfe = koepfe;

    auswahlZeichnen(blatt, zeilen, spalten, h1);
    eingabeSetzen(blatt, zeilen, spalten, h1);
  }

  // ---- Treffer und Bildlauf ----------------------------------------------------------------------------------------

  /** Zelle unter dem Zeiger (Bildschirmkoordinaten) → {z, s}; über den Köpfen → null. */
  function zelleBei(x, y) {
    const r = element.getBoundingClientRect();
    const vx = x - r.left, vy = y - r.top;
    if (!(vx >= KOPF_BREITE) || !(vy >= KOPF_HOEHE)) return null;
    const { zeilen, spalten } = masse();
    const h1 = fixHoehe(ed.aktivesBlatt(), zeilen);
    const s = spalten.index(vx - KOPF_BREITE + (element.scrollLeft || 0));
    const zz = h1 && vy < KOPF_HOEHE + h1 ? 1 : zeilen.index(vy - KOPF_HOEHE + (element.scrollTop || 0));
    return { z: zz, s };
  }

  /** Gezeichnetes Element der Zelle oder null. */
  function zellElement(zz, s) {
    const e = z.zellen.get(`${zz}|${s}`);
    return e ? e.el : null;
  }

  /** So weit scrollen, dass die Zelle ganz zu sehen ist (die angehefteten Köpfe und die fixierte Zeile verdecken). */
  function sichtbarMachen(zz, s) {
    const { zeilen, spalten } = masse();
    const h1 = fixHoehe(ed.aktivesBlatt(), zeilen);
    const hoehe = element.clientHeight || RUECKFALL.hoehe, breite = element.clientWidth || RUECKFALL.breite;
    const oben = element.scrollTop || 0, links = element.scrollLeft || 0;
    if (!(h1 && zz === 1) && zz >= 1 && zz <= zeilen.anzahl) {
      const anfang = zeilen.position(zz), ende = zeilen.position(zz + 1);
      if (anfang - h1 < oben) element.scrollTop = Math.max(0, anfang - h1);
      else if (KOPF_HOEHE + ende > oben + hoehe) element.scrollTop = Math.max(0, KOPF_HOEHE + ende - hoehe);
    }
    if (s >= 1 && s <= spalten.anzahl) {
      const anfang = spalten.position(s), ende = spalten.position(s + 1);
      if (anfang < links) element.scrollLeft = Math.max(0, anfang);
      else if (KOPF_BREITE + ende > links + breite) element.scrollLeft = Math.max(0, Math.min(anfang, KOPF_BREITE + ende - breite));
    }
  }

  const beimBildlauf = () => ed.neuZeichnen();
  element.addEventListener('scroll', beimBildlauf, { passive: true });
  if (typeof ResizeObserver === 'function') {
    z.ro = new ResizeObserver(() => ed.neuZeichnen());
    z.ro.observe(element);
  }

  return {
    element, zellEingabe, zeichnen, zelleBei, zellElement, sichtbarMachen, masse,
    entfernen() {
      if (z.namenUhr) { clearTimeout(z.namenUhr); z.namenUhr = null; }
      if (z.ro) { try { z.ro.disconnect(); } catch { /* egal */ } z.ro = null; }
      element.removeEventListener('scroll', beimBildlauf);
      element.remove();
    },
  };
}
