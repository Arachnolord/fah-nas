// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Editor der Office-Tabelle (Plan 06, V18): Werkzeugleiste (werkzeugleiste.js), Bearbeitungszeile mit Adresse und
// Inhalt, das virtualisierte Raster (raster.js), eine unsichtbare Fokusfalle für Tasten und Zwischenablage und die
// Blätter-Reiter; die rechte Maustaste öffnet das Kontextmenü, der Filter ist eine Ansicht nur bei mir (ed.filter).
// Eingaben werden über aktionen.js zu Ops und gehen über die Sitzung; eigene Ops merkt sich der Verlauf für Strg+Z,
// fremde schieben ihn weiter. Der Rechner rechnet nach jeder Änderung nur das Betroffene neu und
// HEUTE/JETZT einmal je Minute. Die eigene Auswahl geht höchstens alle 150 ms an die anderen, fremde Auswahlen zeigt
// das Raster als farbigen Rahmen mit Namen. Maus: Klick wählt, Ziehen und Umschalt+Klick erweitern, Doppelklick
// bearbeitet in der Zelle; Handy: einmal Tippen wählt, nochmal Tippen bearbeitet oben in der Bearbeitungszeile. Wer
// nur lesen darf, kann wählen, kopieren und filtern, aber nichts ändern. Export: .xlsx (alle Blätter) und .csv (das
// aktuelle Blatt).

import { el, t } from '../../app.js';
import { tabelle, blattVon, zuGross } from '../../gemeinsam/sync/typen/tabelle.js';
import { GRENZEN, adresse, adresseLesen, bereichText } from './formeln/adresse.js';
import { Rechner } from './formeln/auswerter.js';
import { FormelFehler } from './formeln/parser.js';
import { internZuEingabe } from './formeln/uebersetzen.js';
import { auswahlNeu, bereichVon, alsSyncAuswahl, bewegen, tasteZuBefehl } from './auswahl.js';
import { eingabeOp, leerenOp, formatOp, kopieren, einfuegenOp, ausfuellenOp } from './aktionen.js';
import { KOPIER_TYP } from './zwischenablage.js';
import { TabVerlauf } from './verlauf.js';
import { xlsxSchreiben } from './xlsx.js';
import { blattZuCsv } from './csv.js';
import { rasterBauen } from './raster.js';
import { werkzeugleisteBauen, reiterBauen, kontextmenue, filterDialog } from './werkzeugleiste.js';
import { versteckteZeilen } from './filter.js';
import { indexVerschieben } from './formeln/verschieben.js';

/** Für Tests: der zuletzt eingebundene Editor-Zustand. */
export const _test = { ed: null };

/** Eigene Auswahl höchstens so oft senden (ms). */
const AUSWAHL_MS = 150;
/** HEUTE/JETZT so oft neu rechnen (ms). */
const TAKT_MS = 60_000;
/** Zweites Tippen auf dieselbe Zelle innerhalb dieser Zeit bearbeitet (ms). */
const DOPPELTIPP_MS = 600;
/** Weiter bewegt ist es kein Tippen mehr, sondern Wischen (px). */
const TIPP_WEG_PX = 10;
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });
/** Ops, die keine Werte ändern – der Rechner bleibt, wie er ist. */
const OHNE_WERTE = new Set(['blatt_umbenennen', 'blatt_verschieben', 'spalte_breite', 'fixieren', 'noop']);
const STRUKTUR = new Set(['zeilen_einfuegen', 'zeilen_loeschen', 'spalten_einfuegen', 'spalten_loeschen']);
/** Eigene Löschungen, die eine gleichzeitige fremde schon erledigt hat, sind nicht verloren. */
const LOESCHEN = new Set(['zeilen_loeschen', 'spalten_loeschen', 'blatt_loeschen', 'noop']);
const FARBE = /^#[0-9a-fA-F]{3,8}$/;
/** Zwei Sync-Auswahlen {blatt, von, bis} gleich? (fremde Auswahl: nur eine echte Bewegung zeigt das Namensschild neu) */
const gleicheAuswahl = (x, y) => !!x && !!y && x.blatt === y.blatt && x.von === y.von && x.bis === y.bis;

function fokusSetzen(feld) {
  if (!feld || typeof feld.focus !== 'function') return;
  try { feld.focus({ preventScroll: true }); } catch { try { feld.focus(); } catch { /* egal */ } }
}

/** Schmale Ansicht (Handy): dort wird oben in der Bearbeitungszeile bearbeitet. */
function schmal() {
  try { return typeof matchMedia === 'function' && matchMedia('(max-width: 719px)').matches; } catch { return false; }
}

/** Tabellen-Editor in `behaelter` einbinden (V18). */
export async function editorEinbinden(behaelter, { ctx, sitzung, recht }) {
  const hoerer = new Map();
  const z = {
    ab: [], weg: false, geplant: false, bild: null, takt: null, sendeTimer: null, letztesSenden: -Infinity,
    anfang: '', zeiger: 'mouse', tipp: null, letzterTipp: null, ziehen: null,
    auswahlJeBlatt: new Map(), bildlaufJeBlatt: new Map(),
  };
  const ed = {
    ctx, sitzung, rechner: new Rechner(), verlauf: new TabVerlauf(),
    aw: null, blatt: null, nurLesen: (recht || sitzung.recht) !== 'bearbeiten',
    bearbeitet: false, bearbeitOrt: null, bearbeitZelle: null,
    filter: new Map(), // blattId → {spalte, erlaubt: Set<Text>} – nur bei mir, nie gesendet
    fremd: new Map(), // kid → {name, farbe, auswahl}
    stand: 0, // zählt Änderungen der angezeigten Werte (Filter rechnet dann neu)
  };

  // ---- Aufbau ------------------------------------------------------------------------------------------------------
  const leiste = el('div', { class: 'ot-leiste', role: 'toolbar', 'aria-label': t('office.tab_werkzeuge') });
  const adresseFeld = el('span', { class: 'ot-adresse', 'aria-live': 'polite' });
  const formel = el('input', { class: 'eingabe ot-formel', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: GRENZEN.w, 'aria-label': t('office.tab_formel') });
  const zeile = el('div', { class: 'ot-zeile' }, [adresseFeld, formel]);
  const fokus = el('textarea', { class: 'ot-fokus', tabindex: '-1', rows: '1', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'none', 'aria-label': t('office.tab_raster') });
  const reiter = el('div', { class: 'ot-reiter', 'aria-label': t('office.tab_blaetter') });
  const wurzel = el('div', { class: 'ot-editor' }, [leiste, zeile]);
  Object.assign(ed, { wurzel, leiste, reiter, zeile, formel, fokus });
  ed.blatt = sitzung.daten && sitzung.daten.blaetter && sitzung.daten.blaetter[0] ? sitzung.daten.blaetter[0].id : null;
  ed.aw = auswahlNeu(ed.blatt, 1, 1);
  const raster = rasterBauen(ed);
  ed.raster = raster;
  wurzel.append(raster.element, fokus, reiter);
  ed.rechner.setzen(sitzung.daten);

  // ---- Ereignisse des Editors (Aufgabe 19 hängt sich hier an) ------------------------------------------------------
  ed.on = (art, fn) => {
    if (!hoerer.has(art)) hoerer.set(art, new Set());
    hoerer.get(art).add(fn);
    return () => { hoerer.get(art)?.delete(fn); };
  };
  const melden = (art, x) => { for (const fn of [...(hoerer.get(art) || [])]) { try { fn(x); } catch (e) { console.error(e); } } };

  // ---- Zustand und Anzeige -----------------------------------------------------------------------------------------
  const aktivesBlatt = () => blattVon(sitzung.daten, ed.blatt);
  ed.aktivesBlatt = aktivesBlatt;

  function zeichnenJetzt() {
    if (z.weg) return;
    raster.zeichnen();
    melden('gezeichnet');
  }
  /** Neu zeichnen im nächsten Bild (ohne requestAnimationFrame sofort); mehrere Wünsche werden eins. */
  function neuZeichnen() {
    if (z.weg || z.geplant) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') { zeichnenJetzt(); return; }
    z.geplant = true;
    z.bild = raf(() => { z.geplant = false; z.bild = null; zeichnenJetzt(); });
  }
  ed.neuZeichnen = neuZeichnen;

  /** Bearbeitungszeile: Inhalt der aktiven Zelle so, wie man ihn eintippen würde (Formeln deutsch). */
  function formelZeigen() {
    const blatt = aktivesBlatt();
    const p = ed.aw && ed.aw.anker;
    const zelle = blatt && p && blatt.zellen ? blatt.zellen[adresse(p.z, p.s)] : undefined;
    formel.value = internZuEingabe(zelle && zelle.w, { blaetter: sitzung.daten.blaetter, zahl: (zelle && zelle.f && zelle.f.zahl) || null });
  }
  function adresseZeigen() { adresseFeld.textContent = ed.aw ? bereichText(bereichVon(ed.aw)) : ''; }
  function rechtZeigen() {
    wurzel.classList.toggle('ot-nur-lesen', ed.nurLesen);
    formel.readOnly = ed.nurLesen;
    if (ed.nurLesen) formel.setAttribute('title', t('office.tab_nur_lesen')); else formel.removeAttribute('title');
  }

  // ---- Auswahl -----------------------------------------------------------------------------------------------------
  function auswahlSendenJetzt() {
    if (z.weg || !ed.aw) return;
    z.letztesSenden = Date.now();
    try { sitzung.auswahlSenden(alsSyncAuswahl(ed.aw)); } catch { /* Sitzung zu – egal */ }
  }
  /** Höchstens alle 150 ms senden; der letzte Stand geht immer hinaus. */
  function auswahlMelden() {
    if (z.weg || z.sendeTimer) return;
    const warten = z.letztesSenden + AUSWAHL_MS - Date.now();
    if (warten <= 0) { auswahlSendenJetzt(); return; }
    z.sendeTimer = setTimeout(() => { z.sendeTimer = null; auswahlSendenJetzt(); }, warten);
  }

  /** Neue eigene Auswahl {blatt, anker, kopf}: Bearbeitungszeile, Adresse, senden, bei Bedarf hinscrollen, zeichnen. */
  function auswahlSetzen(neu, { sichtbar = true } = {}) {
    if (!neu || !neu.anker || !neu.kopf || z.weg) return;
    ed.aw = { blatt: neu.blatt || ed.blatt, anker: { z: neu.anker.z, s: neu.anker.s }, kopf: { z: neu.kopf.z, s: neu.kopf.s } };
    z.auswahlJeBlatt.set(ed.aw.blatt, ed.aw);
    if (!ed.bearbeitet) formelZeigen();
    adresseZeigen();
    auswahlMelden();
    if (sichtbar) raster.sichtbarMachen(ed.aw.kopf.z, ed.aw.kopf.s);
    melden('auswahl', ed.aw);
    neuZeichnen();
  }
  ed.auswahlSetzen = auswahlSetzen;

  /** Bewegen wie auswahl.js, begrenzt auf das gezeichnete Raster; vom Filter ausgeblendete Zeilen werden übersprungen. */
  function bewegenSichtbar(aw, richtung, { erweitern = false, springen = false } = {}) {
    const { zeilen, spalten } = raster.masse();
    const max = { zeilen: zeilen.anzahl, spalten: spalten.anzahl };
    const zellen = (aktivesBlatt() || {}).zellen || {};
    const belegt = (zz, s) => typeof (zellen[adresse(zz, s)] || {}).w === 'string';
    let neu = bewegen(aw, richtung, { erweitern, springen, belegt, max });
    if (richtung !== 'hoch' && richtung !== 'runter') return neu;
    const ende = (a) => (erweitern ? a.kopf : a.anker);
    for (let i = 0; i < zeilen.anzahl && zeilen.groesse(ende(neu).z) === 0; i++) {
      const weiter = bewegen(neu, richtung, { erweitern, max });
      if (ende(weiter).z === ende(neu).z) break; // am Rand
      neu = weiter;
    }
    return neu;
  }

  /** Belegter Bereich des aktiven Blatts (A1 bis letzte Zeile/Spalte mit Inhalt) wählen; leer → A1. */
  function allesWaehlen() {
    let zz = 1, ss = 1;
    for (const [adr, zelle] of Object.entries((aktivesBlatt() || {}).zellen || {})) {
      if (typeof (zelle || {}).w !== 'string') continue;
      const o = adresseLesen(adr, OHNE_GRENZEN);
      if (o) { zz = Math.max(zz, o.z); ss = Math.max(ss, o.s); }
    }
    auswahlSetzen({ blatt: ed.blatt, anker: { z: 1, s: 1 }, kopf: { z: zz, s: ss } }, { sichtbar: false });
  }

  /** Treffer (Zelle, Spalten- oder Zeilenkopf, Ecke) wählen; erweitern = Umschalt. */
  function waehlen(treffer, erweitern) {
    const { zeilen, spalten } = raster.masse();
    const alt = ed.aw && ed.aw.blatt === ed.blatt ? ed.aw : null;
    if (treffer.art === 'alles') { allesWaehlen(); return; }
    if (treffer.art === 'zelle') {
      const p = { z: treffer.z, s: treffer.s };
      auswahlSetzen(erweitern && alt ? { ...alt, kopf: p } : { blatt: ed.blatt, anker: p, kopf: p });
      return;
    }
    if (treffer.art === 'spalte') {
      const von = erweitern && alt ? alt.anker.s : treffer.s;
      auswahlSetzen({ blatt: ed.blatt, anker: { z: 1, s: von }, kopf: { z: zeilen.anzahl, s: treffer.s } }, { sichtbar: false });
      return;
    }
    const von = erweitern && alt ? alt.anker.z : treffer.z;
    auswahlSetzen({ blatt: ed.blatt, anker: { z: von, s: 1 }, kopf: { z: treffer.z, s: spalten.anzahl } }, { sichtbar: false });
  }

  /** Aktives Blatt wechseln (Auswahl und Bildlauf je Blatt gemerkt); ein offenes Bearbeiten wird erst übernommen. */
  function blattWechseln(id) {
    if (!id || !blattVon(sitzung.daten, id)) return false;
    if (ed.bearbeitet && !bearbeitenBeenden(true)) return false;
    if (id === ed.blatt) return true;
    if (ed.blatt) z.bildlaufJeBlatt.set(ed.blatt, { oben: raster.element.scrollTop || 0, links: raster.element.scrollLeft || 0 });
    ed.blatt = id;
    const bildlauf = z.bildlaufJeBlatt.get(id) || { oben: 0, links: 0 };
    raster.element.scrollTop = bildlauf.oben;
    raster.element.scrollLeft = bildlauf.links;
    auswahlSetzen(z.auswahlJeBlatt.get(id) || auswahlNeu(id, 1, 1), { sichtbar: false });
    melden('blatt', id);
    return true;
  }
  ed.blattWechseln = blattWechseln;

  /** Gibt es das aktive Blatt nicht mehr (gelöscht), geht es zum ersten; gemerkte Stände gelöschter Blätter fallen weg. */
  function blattPruefen() {
    const daten = sitzung.daten;
    for (const id of [...z.auswahlJeBlatt.keys()]) if (!blattVon(daten, id)) { z.auswahlJeBlatt.delete(id); z.bildlaufJeBlatt.delete(id); }
    if (blattVon(daten, ed.blatt)) return;
    if (ed.bearbeitet) bearbeitenBeenden(false);
    const erstes = daten && daten.blaetter && daten.blaetter[0];
    ed.blatt = null;
    if (erstes) blattWechseln(erstes.id);
  }

  // ---- Bearbeiten --------------------------------------------------------------------------------------------------

  /**
   * Bearbeiten der aktiven Zelle beginnen: text = erstes getipptes Zeichen (ersetzt den Inhalt), ohne text der Inhalt wie
   * in der Bearbeitungszeile. ort 'zelle' = Feld über der Zelle, 'zeile' = Bearbeitungszeile (Handy, Klick dorthin).
   */
  function bearbeitenStarten(text, ort) {
    if (ed.nurLesen || z.weg) return false;
    if (ed.bearbeitet) return true;
    const blatt = aktivesBlatt();
    if (!blatt || !ed.aw) return false;
    const { z: zz, s } = ed.aw.anker;
    const zelle = blatt.zellen ? blatt.zellen[adresse(zz, s)] : undefined;
    const vorher = internZuEingabe(zelle && zelle.w, { blaetter: sitzung.daten.blaetter, zahl: (zelle && zelle.f && zelle.f.zahl) || null });
    const wert = typeof text === 'string' ? text : vorher;
    ed.bearbeitet = true;
    ed.bearbeitOrt = ort === 'zelle' || ort === 'zeile' ? ort : (z.zeiger === 'touch' || schmal() ? 'zeile' : 'zelle');
    ed.bearbeitZelle = { blatt: blatt.id, z: zz, s };
    z.anfang = vorher;
    formel.value = wert;
    raster.zellEingabe.value = wert;
    wurzel.classList.add('ot-bearbeitet');
    raster.sichtbarMachen(zz, s);
    zeichnenJetzt(); // das Feld liegt jetzt über der Zelle
    const feld = ed.bearbeitOrt === 'zelle' ? raster.zellEingabe : formel;
    if (document.activeElement !== feld) {
      fokusSetzen(feld);
      try { feld.setSelectionRange(wert.length, wert.length); } catch { /* egal */ }
    }
    melden('bearbeiten', true);
    return true;
  }
  ed.bearbeitenStarten = bearbeitenStarten;

  /**
   * Bearbeiten beenden: uebernehmen → eingabeOp (unverändert: keine Op); ein Formelfehler meldet sich und lässt das
   * Bearbeiten offen (→ false). Sonst true.
   */
  function bearbeitenBeenden(uebernehmen) {
    if (!ed.bearbeitet) return true;
    const ort = ed.bearbeitZelle;
    const feld = ed.bearbeitOrt === 'zelle' ? raster.zellEingabe : formel;
    const text = feld.value;
    if (uebernehmen && text !== z.anfang && ort && blattVon(sitzung.daten, ort.blatt)) {
      let op;
      try { op = eingabeOp(sitzung.daten, ort.blatt, ort.z, ort.s, text); } catch (e) {
        if (e instanceof FormelFehler) { ctx.melden(t('office.tab_formel_fehler'), 'fehler'); return false; }
        throw e;
      }
      aendern(op);
    }
    const hatteFokus = typeof document !== 'undefined' && wurzel.contains(document.activeElement);
    ed.bearbeitet = false; ed.bearbeitOrt = null; ed.bearbeitZelle = null;
    wurzel.classList.remove('ot-bearbeitet');
    formelZeigen();
    zeichnenJetzt(); // Feld über der Zelle weg
    if (hatteFokus) {
      if (z.zeiger === 'touch') { try { document.activeElement.blur(); } catch { /* egal */ } } else fokusSetzen(fokus);
    }
    melden('bearbeiten', false);
    return true;
  }
  ed.bearbeitenBeenden = bearbeitenBeenden;

  /** Fokus zurück in den Editor: ins offene Eingabefeld, sonst in die Fokusfalle (nach Knöpfen der Leiste). */
  ed.fokusZurueck = () => {
    if (ed.bearbeitet) fokusSetzen(ed.bearbeitOrt === 'zelle' ? raster.zellEingabe : formel);
    else if (z.zeiger !== 'touch') fokusSetzen(fokus);
  };

  // ---- Ändern ------------------------------------------------------------------------------------------------------

  /** Fehler einer Aktion als kurze Meldung: zu viele Zellen, Formelfehler, sonst wie üblich. */
  function fehlerMelden(e) {
    if (e && e.message === 'zu_viel') ctx.melden(t('office.tab_zu_viel'), 'warnung');
    else if (e instanceof FormelFehler) ctx.melden(t('office.tab_formel_fehler'), 'fehler');
    else ctx.zeigeFehler(e);
  }
  ed.fehlerMelden = fehlerMelden;

  /**
   * Eigene Op senden: nur mit Recht „bearbeiten“, höchstens 7 340 032 Byte; der Verlauf merkt sie sich (außer beim
   * Rückgängig). → true, wenn gesendet.
   */
  function aendern(op, { rueckgaengig = false } = {}) {
    if (!op || ed.nurLesen || z.weg) return false;
    if (zuGross(op)) { ctx.melden(t('office.tab_zu_gross'), 'warnung'); return false; }
    const vorher = sitzung.daten;
    try { sitzung.lokal(op); } catch (e) { ctx.zeigeFehler(e); return false; }
    if (!rueckgaengig) ed.verlauf.eigene(vorher, op);
    return true;
  }
  ed.aendern = aendern;

  /** Op aus einer Aktion bauen und senden; zu_viel/Formelfehler melden sich. */
  function ausfuehren(bauen) {
    if (ed.nurLesen) return false;
    let op;
    try { op = bauen(); } catch (e) { fehlerMelden(e); return false; }
    return op ? aendern(op) : false;
  }

  /** Ein Rückgängig-Schritt geht ganz oder gar nicht hinaus: jede Op muss die Prüfung und die Bytegrenze bestehen. */
  const schrittPasst = (ops) => ops.every((op) => {
    try { tabelle.pruefen(op); } catch { return false; }
    return !zuGross(op);
  });

  function rueckgaengigMachen(vor) {
    if (ed.nurLesen || ed.bearbeitet) return;
    const ops = vor ? ed.verlauf.wiederholen(sitzung.daten, schrittPasst) : ed.verlauf.rueckgaengig(sitzung.daten, schrittPasst);
    if (ops === false) { ctx.melden(t('office.tab_rueckgaengig_geht_nicht'), 'warnung'); return; }
    for (const op of ops || []) aendern(op, { rueckgaengig: true });
  }

  const bereich = () => bereichVon(ed.aw);

  /** Befehle aus Tasten (tasteZuBefehl) und der Werkzeugleiste. */
  function befehl(b, e) {
    switch (b.befehl) {
      case 'enter': case 'tab': {
        if (ed.bearbeitet && !bearbeitenBeenden(true)) return;
        const richtung = b.befehl === 'enter' ? (b.zurueck ? 'hoch' : 'runter') : (b.zurueck ? 'links' : 'rechts');
        auswahlSetzen(bewegenSichtbar(ed.aw, richtung));
        return;
      }
      case 'abbrechen': bearbeitenBeenden(false); return;
      case 'bewegen': auswahlSetzen(bewegenSichtbar(ed.aw, b.richtung, { erweitern: b.erweitern, springen: b.springen })); return;
      case 'bearbeiten': bearbeitenStarten(undefined, 'zelle'); return;
      case 'tippen': bearbeitenStarten(e && e.key); return;
      case 'leeren': ausfuehren(() => leerenOp(sitzung.daten, ed.blatt, bereich())); return;
      case 'zurueck': rueckgaengigMachen(false); return;
      case 'vor': rueckgaengigMachen(true); return;
      case 'ausfuellen': ausfuehren(() => ausfuellenOp(sitzung.daten, ed.blatt, bereich())); return;
      case 'fett': case 'kursiv': ausfuehren(() => formatOp(sitzung.daten, ed.blatt, bereich(), b.befehl, 'umschalten')); return;
      case 'alles': allesWaehlen(); return;
      default:
    }
  }
  ed.befehl = (name, mehr = {}) => befehl({ befehl: name, ...mehr });
  ed.ausfuehren = ausfuehren;

  /**
   * Filter eines Blatts setzen (null = keiner): nur eine Ansicht bei mir – keine Op, nichts gespeichert. Die ausgeblendeten
   * Zeilen werden jetzt festgehalten (wie „Erneut anwenden“ in Excel): neue oder geänderte Zeilen bleiben sichtbar, bis der
   * Filter neu gesetzt wird; Zeilen und Spalte wandern mit Struktur-Ops (filterNachfuehren).
   */
  ed.filterSetzen = (blattId, filter) => {
    if (filter) ed.filter.set(blattId, { ...filter, versteckt: versteckteZeilen(sitzung.daten, ed.rechner, blattId, filter) });
    else ed.filter.delete(blattId);
    ed.stand++;
    melden('filter', blattId);
    neuZeichnen();
  };
  ed.filterOeffnen = (spalte) => filterDialog(ed, spalte);

  // ---- Zwischenablage ----------------------------------------------------------------------------------------------

  /** Auswahl in die Zwischenablage `cd` (TSV für andere Programme + eigener Typ); schneiden leert danach sofort. */
  function kopierenIn(cd, { schneiden = false } = {}) {
    let k;
    try { k = kopieren(sitzung.daten, ed.rechner, ed.blatt, bereich()); } catch (e) { fehlerMelden(e); return null; }
    if (cd) {
      cd.setData('text/plain', k.tsv);
      try { cd.setData(KOPIER_TYP, k.intern); } catch { /* Browser ohne eigene Typen: dann nur Text */ }
    }
    if (schneiden && !ed.nurLesen) ausfuehren(() => leerenOp(sitzung.daten, ed.blatt, bereich()));
    return k;
  }
  ed.kopierenIn = kopierenIn;

  /** Einfügen ab der Auswahl: eigener Typ vor Text (kaputtes JSON → Text); danach ist das Eingefügte gewählt. */
  function einfuegenAus({ intern = '', text = '' } = {}) {
    if (ed.nurLesen) return false;
    const b = bereich();
    const bauen = (inhalt) => einfuegenOp(sitzung.daten, ed.blatt, { z: b.z1, s: b.s1 }, inhalt, { auswahl: b });
    let op = null;
    try {
      if (intern) {
        try { op = bauen({ art: 'intern', json: intern }); } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          op = text ? bauen({ art: 'tsv', text }) : null;
        }
      } else if (text) op = bauen({ art: 'tsv', text });
    } catch (e) { fehlerMelden(e); return false; }
    if (!op || !aendern(op)) return false;
    let z1 = Infinity, s1 = Infinity, z2 = 0, s2 = 0;
    for (const adr of Object.keys(op.werte)) {
      const o = adresseLesen(adr, OHNE_GRENZEN);
      if (o) { z1 = Math.min(z1, o.z); s1 = Math.min(s1, o.s); z2 = Math.max(z2, o.z); s2 = Math.max(s2, o.s); }
    }
    if (z2) auswahlSetzen({ blatt: ed.blatt, anker: { z: z1, s: s1 }, kopf: { z: z2, s: s2 } }, { sichtbar: false });
    return true;
  }
  ed.einfuegenAus = einfuegenAus;

  fokus.addEventListener('copy', (e) => { if (!e.clipboardData) return; e.preventDefault(); kopierenIn(e.clipboardData); });
  fokus.addEventListener('cut', (e) => { if (!e.clipboardData) return; e.preventDefault(); kopierenIn(e.clipboardData, { schneiden: true }); });
  fokus.addEventListener('paste', (e) => {
    e.preventDefault();
    if (!e.clipboardData) return;
    einfuegenAus({ intern: e.clipboardData.getData(KOPIER_TYP), text: e.clipboardData.getData('text/plain') });
  });

  // ---- Tasten ------------------------------------------------------------------------------------------------------
  wurzel.addEventListener('keydown', (e) => {
    const ziel = e.target;
    if (ziel !== fokus && ziel !== formel && ziel !== raster.zellEingabe) return;
    if (e.isComposing || e.keyCode === 229) return; // Eingabe über IME läuft im Feld
    if (ziel === formel && !ed.bearbeitet) { // nur lesen: Text der Zeile markieren und kopieren geht, Enter/Esc zurück
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); fokusSetzen(fokus); }
      return;
    }
    const b = tasteZuBefehl(e, { bearbeitet: ed.bearbeitet });
    if (!b) return;
    e.preventDefault();
    befehl(b, e);
  });
  // Zeichen, die ohne keydown-Zeichen ankommen (Bildschirmtastatur, Eingabehilfen): als Anfang des Bearbeitens
  const fallenText = (e) => {
    if (e.isComposing) return;
    const text = fokus.value.replace(/[\r\n]+/g, '');
    fokus.value = '';
    if (text && !ed.nurLesen && !ed.bearbeitet) bearbeitenStarten(text);
  };
  fokus.addEventListener('input', fallenText);
  fokus.addEventListener('compositionend', fallenText);
  formel.addEventListener('focus', () => { if (!ed.bearbeitet && !ed.nurLesen && !z.weg) bearbeitenStarten(undefined, 'zeile'); });
  formel.addEventListener('input', () => { if (ed.bearbeitet) raster.zellEingabe.value = formel.value; });
  raster.zellEingabe.addEventListener('input', () => { if (ed.bearbeitet) formel.value = raster.zellEingabe.value; });
  // Verlässt der Fokus den Editor beim Bearbeiten, gilt das Getippte (wie ein Klick in eine andere Zelle)
  wurzel.addEventListener('focusout', (e) => {
    if (!ed.bearbeitet || (e.target !== formel && e.target !== raster.zellEingabe)) return;
    if (e.relatedTarget && wurzel.contains(e.relatedTarget)) return;
    bearbeitenBeenden(true);
  });

  // ---- Zeiger ------------------------------------------------------------------------------------------------------
  const re = raster.element;

  /** Was liegt unter dem Zeiger? Zelle, Spalten-/Zeilenkopf, Ecke – im Eingabefeld der Zelle nichts. */
  function trefferVon(e) {
    const ziel = e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!ziel || ziel.closest('.ot-zelleingabe')) return null;
    const zelle = ziel.closest('.ot-zelle');
    if (zelle) {
      const o = adresseLesen(zelle.getAttribute('data-adr') || '', OHNE_GRENZEN);
      return o ? { art: 'zelle', z: o.z, s: o.s } : null;
    }
    const kopf = ziel.closest('.ot-kopf');
    if (kopf) {
      const s = Number(kopf.getAttribute('data-s')), zz = Number(kopf.getAttribute('data-z'));
      return s ? { art: 'spalte', s } : zz ? { art: 'zeile', z: zz } : null;
    }
    if (ziel.closest('.ot-ecke')) return { art: 'alles' };
    const p = raster.zelleBei(e.clientX, e.clientY);
    return p ? { art: 'zelle', z: p.z, s: p.s } : null;
  }

  /** Touch: erstes Tippen wählt, zweites Tippen auf dieselbe Zelle (≤ 600 ms) bearbeitet oben in der Bearbeitungszeile. */
  function antippen(treffer) {
    const jetzt = Date.now();
    const vorher = z.letzterTipp;
    z.letzterTipp = null;
    if (treffer.art === 'zelle' && vorher && !ed.bearbeitet && vorher.blatt === ed.blatt && vorher.z === treffer.z && vorher.s === treffer.s && jetzt - vorher.zeit <= DOPPELTIPP_MS) {
      bearbeitenStarten(undefined, 'zeile');
      return;
    }
    if (ed.bearbeitet && !bearbeitenBeenden(true)) return;
    waehlen(treffer, false);
    if (treffer.art === 'zelle') z.letzterTipp = { blatt: ed.blatt, z: treffer.z, s: treffer.s, zeit: jetzt };
  }

  re.addEventListener('pointerdown', (e) => {
    const treffer = trefferVon(e);
    if (!treffer) return;
    z.zeiger = e.pointerType || 'mouse';
    if (e.pointerType === 'touch') { z.tipp = { treffer, x: e.clientX || 0, y: e.clientY || 0, id: e.pointerId }; return; } // Wischen scrollt nativ
    if (e.button !== undefined && e.button !== 0) return; // rechte Taste: Kontextmenü
    e.preventDefault();
    if (ed.bearbeitet && !bearbeitenBeenden(true)) return;
    waehlen(treffer, !!e.shiftKey);
    fokusSetzen(fokus);
    if (treffer.art !== 'alles') {
      z.ziehen = { id: e.pointerId, art: treffer.art };
      try { re.setPointerCapture(e.pointerId); } catch { /* ohne Capture: Ziehen endet am Rand */ }
    }
  });
  re.addEventListener('pointermove', (e) => {
    if (z.tipp && e.pointerId === z.tipp.id && Math.hypot((e.clientX || 0) - z.tipp.x, (e.clientY || 0) - z.tipp.y) > TIPP_WEG_PX) z.tipp = null;
    if (!z.ziehen || e.pointerId !== z.ziehen.id) return;
    const p = raster.zelleBei(e.clientX, e.clientY);
    if (!p || !ed.aw) return;
    const { zeilen, spalten } = raster.masse();
    const kopf = z.ziehen.art === 'spalte' ? { z: zeilen.anzahl, s: p.s } : z.ziehen.art === 'zeile' ? { z: p.z, s: spalten.anzahl } : p;
    if (kopf.z !== ed.aw.kopf.z || kopf.s !== ed.aw.kopf.s) auswahlSetzen({ ...ed.aw, kopf }, { sichtbar: z.ziehen.art === 'zelle' });
  });
  re.addEventListener('pointerup', (e) => {
    if (z.ziehen && e.pointerId === z.ziehen.id) {
      z.ziehen = null;
      try { re.releasePointerCapture(e.pointerId); } catch { /* egal */ }
      return;
    }
    const tipp = z.tipp;
    z.tipp = null;
    if (!tipp || e.pointerType !== 'touch' || tipp.id !== e.pointerId) return;
    if (Math.hypot((e.clientX || 0) - tipp.x, (e.clientY || 0) - tipp.y) > TIPP_WEG_PX) return;
    antippen(tipp.treffer);
  });
  re.addEventListener('pointercancel', () => { z.tipp = null; z.ziehen = null; });
  re.addEventListener('dblclick', (e) => {
    const treffer = trefferVon(e);
    if (treffer && treffer.art === 'zelle' && z.zeiger !== 'touch') bearbeitenStarten(undefined, 'zelle');
  });

  /** Liegt der Treffer schon in der Auswahl? Spalten- und Zeilenköpfe zählen nur bei ganz gewählten Spalten/Zeilen. */
  function inAuswahl(treffer) {
    if (!ed.aw || ed.aw.blatt !== ed.blatt) return false;
    const b = bereichVon(ed.aw);
    const { zeilen, spalten } = raster.masse();
    if (treffer.art === 'zelle') return treffer.z >= b.z1 && treffer.z <= b.z2 && treffer.s >= b.s1 && treffer.s <= b.s2;
    if (treffer.art === 'spalte') return b.z1 === 1 && b.z2 >= zeilen.anzahl && treffer.s >= b.s1 && treffer.s <= b.s2;
    if (treffer.art === 'zeile') return b.s1 === 1 && b.s2 >= spalten.anzahl && treffer.z >= b.z1 && treffer.z <= b.z2;
    return true;
  }
  // Rechte Maustaste: außerhalb der Auswahl erst wählen (wie Excel), dann das Kontextmenü
  re.addEventListener('contextmenu', (e) => {
    const treffer = trefferVon(e);
    if (!treffer) return;
    e.preventDefault();
    if (ed.bearbeitet && !bearbeitenBeenden(true)) return;
    if (!inAuswahl(treffer)) waehlen(treffer, false);
    kontextmenue(ed, { art: treffer.art === 'spalte' || treffer.art === 'zeile' ? treffer.art : 'zelle', x: e.clientX || 0, y: e.clientY || 0 });
  });
  // Tab-Taste ins Raster: weiter in die Fokusfalle, dort laufen Tasten und Zwischenablage
  re.addEventListener('focus', () => { if (document.activeElement === re && z.zeiger !== 'touch') fokusSetzen(fokus); });

  // ---- Sitzung -----------------------------------------------------------------------------------------------------

  /** Rechner nachführen: Zell-Ops rechnen nur das Betroffene, Struktur- und Blatt-Ops alles neu. */
  function rechnerNachfuehren(op, daten) {
    if (OHNE_WERTE.has(op.typ)) return;
    if (op.typ === 'zelle') ed.rechner.aendern(daten, op.blatt, [op.zelle]);
    else if (op.typ === 'zellen') ed.rechner.aendern(daten, op.blatt, Object.keys(op.werte || {}));
    else if (op.typ === 'sortieren') ed.rechner.aendern(daten, op.blatt, Object.keys(op.zellen || {}));
    else ed.rechner.setzen(daten);
  }

  /** Eine Zelle gegen eine fremde Struktur-Op verschieben (wie die Auswahl des Sync-Typs); unlesbar → null. */
  function punktNachfuehren(blattId, p, op) {
    const a = tabelle.auswahlTransformieren({ blatt: blattId, von: adresse(p.z, p.s), bis: adresse(p.z, p.s) }, op);
    return a ? adresseLesen(a.von, OHNE_GRENZEN) : null;
  }

  /** Fremde Zeilen/Spalten einfügen oder löschen: eigene Auswahl je Blatt mitführen; die bearbeitete Zelle auch –
   * fällt sie weg, endet das Bearbeiten ohne Übernahme. */
  function eigeneNachfuehren(op) {
    if (!STRUKTUR.has(op.typ)) return;
    for (const [id, aw] of [...z.auswahlJeBlatt]) {
      if (id !== op.blatt) continue;
      const anker = punktNachfuehren(id, aw.anker, op), kopf = punktNachfuehren(id, aw.kopf, op);
      if (anker && kopf) z.auswahlJeBlatt.set(id, { blatt: id, anker, kopf });
    }
    if (ed.aw && ed.aw.blatt === op.blatt && z.auswahlJeBlatt.has(op.blatt)) {
      ed.aw = z.auswahlJeBlatt.get(op.blatt);
      adresseZeigen();
      auswahlMelden();
      melden('auswahl', ed.aw);
    }
    const ort = ed.bearbeitZelle;
    if (!ed.bearbeitet || !ort || ort.blatt !== op.blatt) return;
    const zeilen = op.typ.startsWith('zeilen');
    const i = zeilen ? ort.z : ort.s;
    if (op.typ.endsWith('loeschen') && i >= op.ab && i < op.ab + op.anzahl) { bearbeitenBeenden(false); return; }
    const p = punktNachfuehren(op.blatt, ort, op);
    if (p) ed.bearbeitZelle = { blatt: op.blatt, z: p.z, s: p.s };
  }

  /**
   * Zeilen/Spalten einfügen oder löschen (eigene und fremde): der Filter des Blatts wandert mit – seine Spalte und die
   * festgehaltenen ausgeblendeten Zeilen; fällt die Filterspalte (oder das Blatt) weg, endet der Filter.
   */
  function filterNachfuehren(op) {
    if (op.typ === 'blatt_loeschen') { if (ed.filter.delete(op.blatt)) melden('filter', op.blatt); return; }
    const f = STRUKTUR.has(op.typ) ? ed.filter.get(op.blatt) : null;
    if (!f) return;
    const schritt = { art: op.typ.endsWith('loeschen') ? 'loeschen' : 'einfuegen', ab: op.ab, anzahl: op.anzahl };
    if (op.typ.startsWith('spalten')) {
      const spalte = indexVerschieben(f.spalte, schritt);
      if (spalte === null) ed.filter.delete(op.blatt); else ed.filter.set(op.blatt, { ...f, spalte });
    } else {
      const versteckt = new Set();
      for (const zeile of f.versteckt || []) { const n = indexVerschieben(zeile, schritt); if (n !== null) versteckt.add(n); }
      ed.filter.set(op.blatt, { ...f, versteckt });
    }
    melden('filter', op.blatt);
  }

  z.ab.push(
    sitzung.on('aenderung', ({ op, lokal } = {}) => {
      if (z.weg || !op) return;
      if (!lokal) ed.verlauf.fremde(op);
      rechnerNachfuehren(op, sitzung.daten);
      ed.stand++;
      filterNachfuehren(op);
      if (!lokal) eigeneNachfuehren(op);
      blattPruefen();
      if (!ed.bearbeitet) formelZeigen();
      melden('aenderung', { op, lokal });
      neuZeichnen();
    }),
    // eigene Änderung durch gleichzeitiges Löschen weggefallen (Zeile, Spalte, Blatt): sagen statt still verlieren
    sitzung.on('verworfen', ({ ops } = {}) => {
      if (!z.weg && (ops || []).some((op) => op && !LOESCHEN.has(op.typ))) ctx.melden(t('office.tab_weggefallen'), 'warnung');
    }),
    sitzung.on('auswahl', (a) => {
      if (!a || !a.von) return;
      if (a.auswahl && typeof a.auswahl === 'object') {
        // `seit` = letzte Bewegung (Namensschild, raster.js NAME_MS); dieselbe Auswahl noch einmal ist keine Bewegung
        const alt = ed.fremd.get(a.von);
        const seit = alt && gleicheAuswahl(alt.auswahl, a.auswahl) ? alt.seit : Date.now();
        ed.fremd.set(a.von, { name: String(a.name || a.nutzer || ''), farbe: FARBE.test(String(a.farbe || '')) ? a.farbe : '', auswahl: a.auswahl, seit });
      } else ed.fremd.delete(a.von);
      neuZeichnen();
    }),
    sitzung.on('anwesend', (liste) => {
      const da = new Set((Array.isArray(liste) ? liste : []).map((x) => x && x.kid));
      let weg = false;
      for (const von of [...ed.fremd.keys()]) if (!da.has(von)) { ed.fremd.delete(von); weg = true; }
      if (weg) neuZeichnen();
    }),
    sitzung.on('recht', ({ recht: neu } = {}) => {
      const lesen = (neu || sitzung.recht) !== 'bearbeiten';
      if (lesen && ed.bearbeitet) bearbeitenBeenden(false);
      ed.nurLesen = lesen;
      rechtZeigen();
      melden('recht', lesen);
      neuZeichnen();
    }),
  );

  // HEUTE/JETZT: einmal je Minute neu rechnen
  z.takt = setInterval(() => {
    if (z.weg) return;
    const neu = ed.rechner.volatileNeu(sitzung.daten);
    if (neu && neu.size) { ed.stand++; neuZeichnen(); }
  }, TAKT_MS);

  // ---- Start -------------------------------------------------------------------------------------------------------
  behaelter.appendChild(wurzel);
  rechtZeigen();
  z.auswahlJeBlatt.set(ed.blatt, ed.aw);
  werkzeugleisteBauen(ed);
  reiterBauen(ed);
  formelZeigen();
  adresseZeigen();
  zeichnenJetzt();
  auswahlMelden();
  _test.ed = ed;

  return {
    exportformate: [{ id: 'xlsx', titel: t('office.tab_export_xlsx') }, { id: 'csv', titel: t('office.tab_export_csv') }],
    /** xlsx: die ganze Mappe; csv: das aktuelle Blatt (bei mehreren Blättern mit dessen Namen im Dateinamen). */
    async exportieren(id) {
      const daten = sitzung.daten, name = sitzung.dok.name;
      if (id === 'xlsx') {
        const autor = (ctx.nutzer && (ctx.nutzer.anzeigename || ctx.nutzer.name)) || '';
        return { name: `${name}.xlsx`, blob: await xlsxSchreiben(daten, { titel: name, autor }) };
      }
      if (id === 'csv') {
        const blatt = aktivesBlatt() || daten.blaetter[0];
        const text = blattZuCsv(daten, blatt.id, ed.rechner);
        const datei = daten.blaetter.length > 1 ? `${name} - ${blatt.name}.csv` : `${name}.csv`;
        return { name: datei, blob: new Blob([text], { type: 'text/csv;charset=utf-8' }) };
      }
      throw new Error('kein_export');
    },
    verlassen() {
      if (z.weg) return;
      z.weg = true;
      clearInterval(z.takt);
      if (z.sendeTimer) clearTimeout(z.sendeTimer);
      if (z.bild !== null && typeof globalThis.cancelAnimationFrame === 'function') { try { globalThis.cancelAnimationFrame(z.bild); } catch { /* egal */ } }
      for (const x of z.ab) { try { x(); } catch { /* egal */ } }
      z.ab = [];
      melden('verlassen');
      hoerer.clear();
      raster.entfernen();
      wurzel.remove();
    },
  };
}
