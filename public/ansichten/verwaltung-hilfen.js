// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Bausteine der Verwaltungsansichten (Teil F): Elemente ohne innerHTML, Formularfelder mit Erklärtext,
// Dialoge, Aufgaben mit Fortschritt, Formatierung. Kein Zugriff auf `document` beim Laden – damit die Module auch in
// Node-Tests importierbar sind.

// ---------------------------------------------------------------------------------------------------------------
// Elemente

import { agentText } from '../agent-text.js';

/**
 * Erzeugt ein Element. `eig` kennt: klasse, text, id, typ, fuer, wert, attr:{…}, daten:{…}, sowie beliebige
 * Eigenschaften (z. B. disabled, required, placeholder). Kinder: Text (wird zu Textknoten), Knoten, Listen.
 */
export function el(tag, eig = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(eig)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'klasse') { e.className = v; }
    else if (k === 'text') { e.textContent = String(v); }
    else if (k === 'typ') { e.type = v; }
    else if (k === 'fuer') { e.htmlFor = v; }
    else if (k === 'wert') { e.value = String(v); }
    else if (k === 'attr') { for (const [a, w] of Object.entries(v)) { if (w !== undefined && w !== null && w !== false) e.setAttribute(a, String(w)); } }
    else if (k === 'daten') { for (const [a, w] of Object.entries(v)) e.dataset[a] = String(w); }
    else if (k in e) { e[k] = v; }
    else { e.setAttribute(k, String(v)); }
  }
  anhaengen(e, kinder);
  return e;
}

export function anhaengen(eltern, kinder) {
  for (const k of kinder) {
    if (k === undefined || k === null || k === false || k === '') continue;
    if (Array.isArray(k)) { anhaengen(eltern, k); continue; }
    eltern.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
  return eltern;
}

/** Gebietsschema für Zahlen/Datum – folgt der Sprache der Oberfläche (html lang). */
export function gebiet() { return typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE'; }

export function leeren(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

// ---------------------------------------------------------------------------------------------------------------
// Stil der Verwaltungsansichten – einmal laden, Pfad relativ zu diesem Modul (unabhängig davon, wie der Rahmen
// die Dateien ausliefert)

const geladeneStile = new Set();
/** Lädt ein Stylesheet genau einmal. Ohne Argument: den gemeinsamen Verwaltungsstil. */
export function stilLaden(url) {
  if (typeof document === 'undefined') return;
  const href = url || new URL('./verwaltung-hilfen.css', import.meta.url).href;
  if (geladeneStile.has(href)) return;
  geladeneStile.add(href);
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
  document.head.appendChild(el('link', { rel: 'stylesheet', href }));
}

// ---------------------------------------------------------------------------------------------------------------
// Formularbausteine (jede Einstellung: Beschriftung + Erklärtext)

let laufnummer = 0;
export function neueId(vorsilbe = 'vw') { laufnummer += 1; return `${vorsilbe}-${laufnummer}`; }

/** Eingabefeld (input) mit Basisklasse .eingabe (Rahmen) + .vw-eingabe (Rückfall) */
export function eingabe(eig = {}) {
  const { typ = 'text', id, wert, platzhalter, muster, pflicht, min, max, schritt, autocomplete, inputmode, maxlength, nurLesen, klasse, autofokus, spellcheck } = eig;
  const e = el('input', {
    typ, id: id || neueId(), klasse: `eingabe vw-eingabe ${klasse || ''}`.trim(),
    attr: {
      placeholder: platzhalter, pattern: muster, required: pflicht ? 'required' : undefined, min, max, step: schritt,
      autocomplete, inputmode, maxlength, readonly: nurLesen ? 'readonly' : undefined, autofocus: autofokus ? 'autofocus' : undefined,
      spellcheck: spellcheck === false ? 'false' : undefined,
    },
  });
  if (wert !== undefined && wert !== null) e.value = String(wert);
  return e;
}

/** Auswahlliste (select) */
export function auswahl({ id, optionen, wert, klasse } = {}) {
  const s = el('select', { id: id || neueId(), klasse: `eingabe vw-eingabe ${klasse || ''}`.trim() });
  for (const o of optionen || []) {
    const opt = el('option', { wert: o.wert, text: o.text });
    if (o.deaktiviert) opt.disabled = true;
    s.appendChild(opt);
  }
  if (wert !== undefined && wert !== null) s.value = String(wert);
  return s;
}

/** Mehrzeiliges Textfeld */
export function textbereich({ id, wert, zeilen = 3, platzhalter, klasse } = {}) {
  const t = el('textarea', { id: id || neueId(), klasse: `eingabe vw-eingabe ${klasse || ''}`.trim(), attr: { rows: zeilen, placeholder: platzhalter } });
  if (wert !== undefined && wert !== null) t.value = String(wert);
  return t;
}

/** Feld = Beschriftung + Eingabe + Erklärtext (Rahmen-Muster: .feld > label.feld-beschriftung, .eingabe, p.erklaerung) */
export function feld({ label, erklaerung, eingabe: e, klasse, hinweisElement }) {
  const id = e.id || (e.id = neueId());
  return el('div', { klasse: `feld vw-feld ${klasse || ''}`.trim() },
    el('label', { fuer: id, klasse: 'feld-beschriftung vw-label', text: label }),
    e,
    hinweisElement || null,
    erklaerung ? el('p', { klasse: 'erklaerung', text: erklaerung }) : null,
  );
}

/**
 * Schalter (Checkbox als Kippschalter) mit Erklärtext – Rahmen-Muster von stil.css:
 * label.schalter > span.schalter-beschriftung + input[type=checkbox] + p.erklaerung (Grid, Checkbox rechts).
 * Gibt {element, eingabe} zurück.
 */
export function schalter({ label, erklaerung, wert = false, beiWechsel, id }) {
  const e = el('input', { typ: 'checkbox', id: id || neueId('schalter'), attr: { role: 'switch', 'aria-checked': wert ? 'true' : 'false' } });
  e.checked = !!wert;
  e.addEventListener('change', () => { e.setAttribute('aria-checked', e.checked ? 'true' : 'false'); if (beiWechsel) beiWechsel(e.checked); });
  const element = el('label', { klasse: 'schalter vw-schalter', fuer: e.id },
    el('span', { klasse: 'schalter-beschriftung vw-schalter-text', text: label }),
    e,
    erklaerung ? el('p', { klasse: 'erklaerung', text: erklaerung }) : null,
  );
  return { element, eingabe: e };
}

/** Radiogruppe: optionen [{wert, text, erklaerung}] → {element, wert()} */
export function radiogruppe({ name, optionen, wert, beiWechsel }) {
  const n = name || neueId('radio');
  const eingaben = [];
  const element = el('div', { klasse: 'vw-radio-gruppe', attr: { role: 'radiogroup' } });
  for (const o of optionen) {
    const r = el('input', { typ: 'radio', name: n, wert: o.wert, id: neueId('r') });
    if (o.wert === wert) r.checked = true;
    if (beiWechsel) r.addEventListener('change', () => r.checked && beiWechsel(o.wert));
    eingaben.push(r);
    element.appendChild(el('div', { klasse: 'vw-radio' },
      el('label', { fuer: r.id, klasse: 'vw-radio-label' }, r, el('span', { text: o.text })),
      o.erklaerung ? el('p', { klasse: 'erklaerung', text: o.erklaerung }) : null));
  }
  return { element, wert: () => (eingaben.find((r) => r.checked) || {}).value, eingaben };
}

/** Knopf; art: haupt | zweit | gefahr */
export function knopf(text, { art = 'haupt', beiKlick, typ = 'button', deaktiviert = false, klein = false, titel, klasse } = {}) {
  const k = el('button', {
    typ, text, klasse: ['knopf', art === 'zweit' ? 'knopf-zweit' : '', art === 'gefahr' ? 'knopf-gefahr' : '', klein ? 'knopf-klein vw-klein' : '', klasse || ''].filter(Boolean).join(' '),
    attr: { title: titel },
  });
  k.disabled = !!deaktiviert;
  if (beiKlick) k.addEventListener('click', (ev) => { ev.preventDefault(); beiKlick(ev, k); });
  return k;
}

/** Fehlerzeile für Formulare: {element, zeigen(text), leeren()} */
export function fehlerzeile() {
  const element = el('p', { klasse: 'hinweis vw-fehler vw-formfehler', attr: { role: 'alert', hidden: 'hidden' } });
  return {
    element,
    zeigen(text) { element.textContent = text; if (wasTun.fn) element.append(' ', wasTunKnopf(text)); element.hidden = false; },
    leeren() { element.textContent = ''; element.hidden = true; },
  };
}

/** Hinweis-Absatz; art: info | warnung | fehler | erfolg (Rahmenklassen hinweis-info/-warnung/-fehler + eigene vw-*) */
export function hinweis(text, art = 'info') {
  const rahmenArt = ['info', 'warnung', 'fehler'].includes(art) ? ` hinweis-${art}` : '';
  if (art === 'fehler' && wasTun.fn) return el('p', { klasse: `hinweis${rahmenArt} vw-hinweis vw-${art}` }, el('span', { text }), ' ', wasTunKnopf(text));
  return el('p', { klasse: `hinweis${rahmenArt} vw-hinweis vw-${art}`, text });
}

// „Was tun?“ an jeder Fehlermeldung (Betreiber 12.10.2026) – der Rahmen setzt Fenster und Beschriftung (wasTunSetzen)
const wasTun = { fn: null, text: 'Was tun?' };
export function wasTunSetzen(fn, text) { wasTun.fn = typeof fn === 'function' ? fn : null; if (text) wasTun.text = text; }
function wasTunKnopf(meldung) {
  return el('button', { klasse: 'knopf knopf-zweit knopf-klein vw-was-tun', typ: 'button', text: wasTun.text, onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); if (wasTun.fn) wasTun.fn(null, meldung); } });
}

export function leerHinweis(text) { return el('p', { klasse: 'leer vw-leer', text }); }
/** Leerer Zustand mit dem nächsten Schritt als Knopf (Betreiber 12.10.2026: „Leere Seiten mit dem nächsten Schritt“). */
export function leerMitSchritt(text, knopfText, beiKlick) {
  return el('div', { klasse: 'leer vw-leer vw-leer-schritt' }, el('p', { klasse: 'leer-text', text }), knopfText && beiKlick ? knopf(knopfText, { beiKlick }) : null);
}

/** Kleines Abzeichen (z. B. Gäste, Time Machine); klasse: warnung | erfolg | gefahr | akzent | '' */
export function badge(text, titel, klasse = '') {
  const art = ['warnung', 'erfolg', 'gefahr', 'akzent'].includes(klasse) ? ` plakette-${klasse}` : '';
  return el('span', { klasse: `plakette${art} vw-badge ${klasse ? `vw-badge-${klasse}` : ''}`.trim(), text, attr: { title: titel || undefined } });
}

/** Ampelpunkt: zustand aktiv | inaktiv | fehler | warnung | unbekannt */
export function ampel(zustand, titel) {
  const z = zustand || 'unbekannt';
  return el('span', { klasse: `ampel ampel-${z} vw-ampel vw-ampel-${z}`, attr: { title: titel, 'aria-label': titel } });
}

/**
 * Tabelle: spalten [{text, klasse?}], zeilen [[Zelle…]] (Zelle = Text oder Knoten). Gibt {element, koerper} zurück.
 * Eingehüllt in .tabelle-huelle, damit sie auf dem Handy waagerecht rollt. Mit `karten` (Standard) wird sie unter
 * 720 px zur Kartenliste des Rahmens (.tabelle-karten): jede Zelle bekommt über tabellenzeile() ihre Spalten-
 * überschrift als data-label, damit Aktionen und alle Spalten ohne seitliches Wischen erreichbar sind.
 */
export function tabelle(spalten, zeilen = [], { klasse, karten = true } = {}) {
  const koerper = el('tbody');
  koerper._spalten = spalten.map((s) => (s && s.text ? String(s.text) : ''));
  const element = el('table', { klasse: `tabelle vw-tabelle ${karten ? 'tabelle-karten' : ''} ${klasse || ''}`.replace(/\s+/g, ' ').trim() },
    el('thead', {}, el('tr', {}, spalten.map((s) => el('th', { text: s.text, klasse: s.klasse, attr: { scope: 'col' } })))),
    koerper);
  for (const z of zeilen) tabellenzeile(koerper, z);
  return { element: el('div', { klasse: 'tabelle-huelle vw-rollen' }, element), tabelle: element, koerper };
}

/** Zeile anhängen; Zellen ohne eigenes data-label bekommen die Spaltenüberschrift (Kartenliste auf dem Handy). */
export function tabellenzeile(koerper, zellen, { klasse } = {}) {
  const tr = el('tr', { klasse });
  const spalten = Array.isArray(koerper._spalten) ? koerper._spalten : [];
  zellen.forEach((z, i) => {
    const td = z instanceof Node && z.tagName === 'TD' ? z : el('td', {}, z);
    const label = spalten[i];
    if (label && td.dataset && !td.dataset.label) td.dataset.label = label;
    tr.appendChild(td);
  });
  koerper.appendChild(tr);
  return tr;
}

/** Fortschrittsbalken: {element, setzen(anteil 0..1, meldung?)} – Rahmenklassen .fortschritt > .fortschritt-balken */
export function fortschritt() {
  const balken = el('span', { klasse: 'fortschritt-balken vw-balken-fuellung' });
  const leiste = el('div', { klasse: 'fortschritt vw-balken', attr: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 } }, balken);
  const text = el('p', { klasse: 'vw-balken-text' });
  const element = el('div', { klasse: 'vw-fortschritt' }, leiste, text);
  return {
    element,
    setzen(anteil, meldung) {
      const p = Math.round(Math.max(0, Math.min(1, Number(anteil) || 0)) * 100);
      balken.style.width = `${p}%`;
      leiste.setAttribute('aria-valuenow', String(p));
      if (meldung !== undefined) text.textContent = meldung;
    },
  };
}

/** Belegungsbalken (z. B. Kontingent): anteil 0..1, ab 0,85 Warnfarbe */
export function belegungsbalken(anteil, beschriftung) {
  const p = Math.round(Math.max(0, Math.min(1, Number(anteil) || 0)) * 100);
  const fuellung = el('span', { klasse: 'fortschritt-balken vw-balken-fuellung' });
  fuellung.style.width = `${p}%`;
  return el('div', { klasse: 'vw-belegung' },
    el('div', { klasse: `fortschritt vw-balken ${p >= 95 ? 'gefahr vw-balken-kritisch' : p >= 85 ? 'warnung vw-balken-warnung' : ''}`.trim(), attr: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p } }, fuellung),
    el('span', { klasse: 'vw-belegung-text', text: beschriftung }));
}

/** Passwortstärke 0..3 (schwach, mittel, stark) – einfache Heuristik, kein Ersatz für Länge */
export function passwortStaerke(pw) {
  if (!pw || pw.length < 8) return 0;
  let punkte = 0;
  if (pw.length >= 12) punkte++;
  if (pw.length >= 16) punkte++;
  if (/[a-zäöüß]/.test(pw) && /[A-ZÄÖÜ]/.test(pw)) punkte++;
  if (/\d/.test(pw)) punkte++;
  if (/[^A-Za-z0-9äöüÄÖÜß]/.test(pw)) punkte++;
  if (punkte >= 4) return 3;
  if (punkte >= 2) return 2;
  return 1;
}

/** Stärkeanzeige: texte {label, schwach, mittel, stark} → {element, aktualisieren(pw)} */
export function staerkeanzeige(texte) {
  const segmente = [0, 1, 2].map(() => el('span', { klasse: 'vw-staerke-segment' }));
  const wort = el('span', { klasse: 'vw-staerke-wort' });
  const element = el('div', { klasse: 'vw-staerke', attr: { 'aria-live': 'polite' } }, el('span', { klasse: 'vw-staerke-label', text: `${texte.label}: ` }), el('span', { klasse: 'vw-staerke-balken' }, segmente), wort);
  return {
    element,
    aktualisieren(pw) {
      const s = passwortStaerke(pw);
      segmente.forEach((seg, i) => { seg.className = `vw-staerke-segment ${i < s ? `vw-staerke-${s}` : ''}`.trim(); });
      wort.textContent = s === 0 ? '' : s === 1 ? texte.schwach : s === 2 ? texte.mittel : texte.stark;
    },
  };
}

/** Prüft Felder: regeln [{eingabe, pruefen:(wert)=>fehlertext|null}]. Setzt Fokus aufs erste fehlerhafte Feld. */
export function felderPruefen(regeln, fz) {
  for (const r of regeln) {
    const wert = r.eingabe.type === 'checkbox' ? r.eingabe.checked : r.eingabe.value;
    const fehler = r.pruefen(wert);
    r.eingabe.setAttribute('aria-invalid', fehler ? 'true' : 'false');
    if (fehler) { if (fz) fz.zeigen(fehler); r.eingabe.focus(); return false; }
  }
  if (fz) fz.leeren();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Dialoge (eigener <dialog> mit Stilklasse .dialog; Rückgabe eines Griffs zum Schließen)

const offeneDialoge = new Set();

/**
 * Öffnet einen Dialog. `knoepfe`: [{text, art, beiKlick(griff, knopf), absenden?:true (löst Formular aus), deaktiviert}]
 * `inhalt` darf ein <form> sein: ein Knopf mit `absenden` ruft form.requestSubmit(), Enter im Formular auch.
 * Mit `ctx.dialog(inhalt, {titel, breit, klasse, beimSchliessen})` des Rahmens (liefert {schliessen, element, koerper})
 * wird dessen Fenster benutzt; ohne Rahmen ein eigenes <dialog class="dialog">.
 * Gibt {element, schliessen(), inhalt, knoepfe:[button…], beschaeftigt(bool)} zurück.
 */
export function dialogOeffnen({ ctx, titel, inhalt, knoepfe = [], schliessenText = 'Schließen', beimSchliessen, breit = false, klasse }) {
  stilLaden();
  const griff = {};
  let geschlossen = false;
  const fuss = el('div', { klasse: 'dialog-knoepfe vw-dialog-fuss' });
  const buttons = [];
  for (const k of knoepfe) {
    const b = knopf(k.text, {
      art: k.art || 'haupt', deaktiviert: k.deaktiviert,
      beiKlick: async (_ev, btn) => {
        if (k.absenden && inhalt instanceof HTMLFormElement) { inhalt.requestSubmit(); return; }
        if (k.beiKlick) await k.beiKlick(griff, btn);
      },
    });
    buttons.push(b); fuss.appendChild(b);
  }
  griff.inhalt = inhalt; griff.knoepfe = buttons;
  const beimZu = () => { if (geschlossen) return; geschlossen = true; offeneDialoge.delete(griff); if (beimSchliessen) beimSchliessen(); };

  // Weg 1: Dialog des Rahmens
  if (ctx && typeof ctx.dialog === 'function') {
    let d = null;
    try { d = ctx.dialog(el('div', { klasse: 'vw-dialog-inhalt' }, inhalt, knoepfe.length ? fuss : null), { titel, breit, klasse, beimSchliessen: beimZu }); } catch { d = null; }
    if (d && typeof d.schliessen === 'function') {
      griff.element = d.element || null;
      griff.beschaeftigt = (ja) => { for (const b of buttons) b.disabled = !!ja; if (griff.element) griff.element.classList.toggle('vw-beschaeftigt', !!ja); };
      griff.schliessen = () => { if (geschlossen) return; d.schliessen(); beimZu(); };
      offeneDialoge.add(griff);
      return griff;
    }
  }

  // Weg 2: eigenes Fenster
  const koerper = el('div', { klasse: 'dialog-koerper vw-dialog-koerper' }, inhalt, knoepfe.length ? fuss : null);
  const zu = knopf('×', { art: 'zweit', klein: true, klasse: 'vw-dialog-zu', titel: schliessenText, beiKlick: () => griff.schliessen() });
  zu.setAttribute('aria-label', schliessenText);
  const element = el('dialog', { klasse: `dialog vw-dialog ${breit ? 'dialog-breit vw-dialog-breit' : ''} ${klasse || ''}`.trim(), attr: { 'aria-labelledby': neueId('dt') } },
    el('div', { klasse: 'dialog-kopf vw-dialog-kopf' }, el('h2', { text: titel, klasse: 'dialog-titel vw-dialog-titel' }), zu),
    koerper);
  element.querySelector('h2').id = element.getAttribute('aria-labelledby');
  griff.element = element;
  griff.beschaeftigt = (ja) => { for (const b of buttons) b.disabled = !!ja; zu.disabled = !!ja; element.classList.toggle('vw-beschaeftigt', !!ja); };
  griff.schliessen = () => {
    if (geschlossen) return;
    try { element.close(); } catch { /* schon zu */ }
    element.remove();
    beimZu();
  };
  element.addEventListener('cancel', (ev) => { ev.preventDefault(); if (!zu.disabled) griff.schliessen(); });
  element.addEventListener('click', (ev) => { if (ev.target === element && !zu.disabled) griff.schliessen(); });
  document.body.appendChild(element);
  offeneDialoge.add(griff);
  if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', 'open');
  const erstes = koerper.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, button');
  if (erstes) erstes.focus();
  return griff;
}

/** Schließt alle offenen Dialoge dieser Ansichten (beim Verlassen). */
export function alleDialogeSchliessen() { for (const g of [...offeneDialoge]) g.schliessen(); }

// ---------------------------------------------------------------------------------------------------------------
// Web-Zugriff: Antworten entpacken, Fehlertexte, Rolle

/** Entpackt {ok, ergebnis} falls der Rahmen die Rohantwort durchreicht; wirft bei {ok:false}. */
export function entpacken(r) {
  if (r && typeof r === 'object' && r.ok === false && r.fehler) throw fehlerObjekt(r.fehler);
  if (r && typeof r === 'object' && r.ok === true && ('ergebnis' in r || 'aufgabe' in r)) return 'aufgabe' in r && !('ergebnis' in r) ? { aufgabe: r.aufgabe } : r.ergebnis;
  return r;
}

export function fehlerObjekt(f) {
  const e = new Error(f && (f.meldung || f.message) || 'Unbekannter Fehler');
  e.code = (f && f.code) || 'E_UNBEKANNT'; e.meldung = e.message; e.details = f && f.details;
  return e;
}

/** Ruft eine Agent-Aktion über den Rahmen und liefert das Ergebnis (bei Aufgaben {aufgabe}). */
export async function api(ctx, aktion, params = {}) {
  try { return entpacken(await ctx.api(aktion, params)); } catch (e) { throw normFehler(e); }
}

export async function get(ctx, pfad) { try { return entpacken(await ctx.get(pfad)); } catch (e) { throw normFehler(e); } }
export async function post(ctx, pfad, body) { try { return entpacken(await ctx.post(pfad, body)); } catch (e) { throw normFehler(e); } }

/** Stellt sicher, dass ein Fehler code/meldung/details trägt. */
export function normFehler(e) {
  if (e && typeof e === 'object' && e.code && (e.meldung || e.message)) { if (!e.meldung) e.meldung = e.message; return e; }
  if (e && typeof e === 'object' && e.fehler) return fehlerObjekt(e.fehler);
  return fehlerObjekt({ code: 'E_UNBEKANNT', meldung: e && e.message ? e.message : String(e) });
}

/** Lesbarer Fehlertext aus fehler.meldung; Bremse mit Wartezeit. */
export function fehlerText(e) {
  const f = normFehler(e);
  if (f.code === 'E_BREMSE' && f.details && f.details.warte_s !== undefined) return `${agentText(f.meldung)} (${Math.ceil(Number(f.details.warte_s))} s)`;
  return agentText(f.meldung) || 'Unbekannter Fehler';
}

export function rolleVon(ctx) { return ctx.rolle || (ctx.nutzer && ctx.nutzer.rolle) || 'nutzer'; }
export function nutzernameVon(ctx) { return typeof ctx.nutzer === 'string' ? ctx.nutzer : (ctx.nutzer && ctx.nutzer.name) || ''; }
export function istAdmin(ctx) { return rolleVon(ctx) === 'admin'; }

/** Meldung über den Rahmen; art: erfolg | fehler | info */
export function melden(ctx, text, art = 'info') { try { if (typeof ctx.melden === 'function') ctx.melden(text, art); } catch { /* egal */ } }

/** Bestätigung über den Rahmen (Promise<boolean>); Rückfall window.confirm */
export async function bestaetigen(ctx, text) {
  if (typeof ctx.bestaetigen === 'function') return !!(await ctx.bestaetigen(text));
  return typeof window !== 'undefined' && window.confirm ? window.confirm(text) : true;
}

/** SSE-Abo mit Abmelde-Funktion (egal, ob der Rahmen eine Abmelde-Funktion zurückgibt oder sse.off kennt). */
export function abo(ctx, art, fn) {
  const sse = ctx.sse;
  if (!sse || typeof sse.on !== 'function') return () => {};
  let aktiv = true;
  const huelle = (...a) => { if (aktiv) fn(...a); };
  const r = sse.on(art, huelle);
  return () => {
    aktiv = false;
    if (typeof r === 'function') { try { r(); } catch { /* egal */ } } else if (typeof sse.off === 'function') { try { sse.off(art, huelle); } catch { /* egal */ } }
  };
}

/** Normalisiert ein Aufgaben-Ereignis (SSE-Daten können roh oder als {daten} kommen). */
export function aufgabenEreignis(e) {
  const d = e && e.daten && typeof e.daten === 'object' && e.daten.aufgabe ? e.daten : e;
  if (!d || typeof d !== 'object') return null;
  const id = typeof d.aufgabe === 'string' ? d.aufgabe : (d.aufgabe && d.aufgabe.id) || d.id;
  return id ? { id, status: d.status, fortschritt: d.fortschritt, meldung: d.meldung, ergebnis: d.ergebnis, fehler: d.fehler } : null;
}

/**
 * Startet eine Aufgabe (Agent-Aktion mit aufgabe:true), zeigt einen Dialog mit Fortschritt und liefert das Ergebnis.
 * texte: {titel, meldung?, abbrechen, schliessen, fehler(meldung), abgebrochen}
 */
export function aufgabeStarten(ctx, aktion, params, texte) {
  return new Promise((aufloesen, ablehnen) => {
    let id = null; let fertig = false;
    const puffer = [];
    const balken = fortschritt();
    balken.setzen(0, texte.meldung || '');
    const fz = fehlerzeile();
    let abmelden = () => {};
    const ende = (ok, wert) => {
      if (fertig) return; fertig = true; abmelden();
      if (ok) { griff.schliessen(); aufloesen(wert); } else {
        fz.zeigen(texte.fehler ? texte.fehler(fehlerText(wert)) : fehlerText(wert));
        griff.beschaeftigt(false);
        griff.knoepfe[0].hidden = true; griff.knoepfe[1].hidden = false;
        ablehnen(normFehler(wert));
      }
    };
    const verarbeiten = (ev) => {
      const a = aufgabenEreignis(ev);
      if (!a || a.id !== id) return;
      if (a.status === 'laeuft' || a.status === 'wartet') balken.setzen(a.fortschritt, agentText(a.meldung));
      else if (a.status === 'fertig') { balken.setzen(1, agentText(a.meldung)); ende(true, a.ergebnis); }
      else if (a.status === 'fehler') ende(false, a.fehler || { code: 'E_UNBEKANNT', meldung: a.meldung || 'Fehler' });
      else if (a.status === 'abgebrochen') ende(false, { code: 'E_ABGEBROCHEN', meldung: texte.abgebrochen || 'Abgebrochen' });
    };
    abmelden = abo(ctx, 'aufgabe', (ev) => { if (id === null) puffer.push(ev); else verarbeiten(ev); });
    const griff = dialogOeffnen({
      ctx, titel: texte.titel, inhalt: el('div', {}, balken.element, fz.element), schliessenText: texte.schliessen,
      knoepfe: [
        { text: texte.abbrechen, art: 'zweit', beiKlick: async () => { if (id) { try { await api(ctx, 'agent.aufgabe_abbrechen', { id }); } catch (e) { fz.zeigen(fehlerText(e)); } } } },
        { text: texte.schliessen, art: 'zweit', beiKlick: (g) => g.schliessen() },
      ],
      beimSchliessen: () => { if (!fertig) { fertig = true; abmelden(); ablehnen(normFehler({ code: 'E_ABGEBROCHEN', meldung: texte.abgebrochen || 'Abgebrochen' })); } },
    });
    griff.knoepfe[1].hidden = true;
    api(ctx, aktion, params).then((r) => {
      id = r && r.aufgabe ? String(r.aufgabe) : null;
      if (!id) { ende(true, r); return; } // keine Aufgabe, sondern direktes Ergebnis
      for (const ev of puffer.splice(0)) verarbeiten(ev);
    }).catch((e) => ende(false, e));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Formatierung

/** Binäre Einheiten (1024er-Schritte, GiB) – gleiche Rechnung wie der Agent (groesse_gb × 1024³) und der Rahmen (app.js). */
export const GROESSEN_EINHEITEN = Object.freeze(['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']);
export const GIB = 1024 ** 3;

export function groesseFormat(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '–';
  let w = n; let i = 0;
  while (w >= 1024 && i < GROESSEN_EINHEITEN.length - 1) { w /= 1024; i++; }
  return `${i === 0 ? w : w.toLocaleString(gebiet(), { maximumFractionDigits: w >= 100 ? 0 : 1 })} ${GROESSEN_EINHEITEN[i]}`;
}

export function zeitFormat(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(gebiet(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function laufzeitTeile(sekunden) {
  const s = Math.max(0, Math.floor(Number(sekunden) || 0));
  return { tage: Math.floor(s / 86400), stunden: Math.floor((s % 86400) / 3600), minuten: Math.floor((s % 3600) / 60) };
}

/** Aus einem datetime-local-Wert eine ISO-Zeit (UTC) machen; leer → undefined */
export function isoAus(lokal) {
  if (!lokal) return undefined;
  const d = new Date(lokal);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------------------------------------------------------------------------------------------------------------
// Zwischenablage, Download

export async function kopieren(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Rückfall unten */ }
  try {
    const t = el('textarea', { wert: text, attr: { readonly: 'readonly', 'aria-hidden': 'true' }, klasse: 'vw-unsichtbar' });
    document.body.appendChild(t); t.select();
    const ok = document.execCommand && document.execCommand('copy');
    t.remove();
    return !!ok;
  } catch { return false; }
}

export function herunterladenText(dateiname, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: dateiname, klasse: 'vw-unsichtbar' });
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function herunterladenUrl(url, dateiname) {
  const a = el('a', { href: url, klasse: 'vw-unsichtbar' });
  if (dateiname) a.download = dateiname;
  document.body.appendChild(a); a.click();
  setTimeout(() => a.remove(), 1000);
}

/** CSRF-Wert aus dem Cookie fahnas_csrf (für Roh-Uploads außerhalb von ctx.post) */
export function csrfWert() {
  const m = typeof document !== 'undefined' && document.cookie ? document.cookie.match(/(?:^|;\s*)fahnas_csrf=([^;]*)/) : null;
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------------------------------------------------------------------------------------------------------------
// Kopfzeile einer Ansicht: Titel, Untertitel, Knöpfe rechts

export function kopfzeile(titel, untertitel, ...knoepfe) {
  return el('div', { klasse: 'vw-kopf' },
    el('div', { klasse: 'vw-kopf-text' }, el('h1', { klasse: 'vw-titel', text: titel }), untertitel ? el('p', { klasse: 'vw-untertitel', text: untertitel }) : null),
    knoepfe.length ? el('div', { klasse: 'vw-knopfleiste' }, knoepfe) : null);
}

export function karte(titel, ...inhalt) {
  return el('section', { klasse: 'karte vw-karte' }, titel ? el('h2', { klasse: 'vw-karte-titel', text: titel }) : null, inhalt);
}

/** Text mit Platzhaltern {name} füllen – Rückfall, falls ctx.t keine Werte ersetzt */
export function fuellen(text, werte) {
  if (!werte || typeof text !== 'string') return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in werte ? String(werte[k]) : m));
}

/** Formatierer: nimmt ctx.format des Rahmens (einheitliche Einheiten in der ganzen Oberfläche), sonst eigene */
export function formatierer(ctx) {
  const f = ctx && ctx.format && typeof ctx.format === 'object' ? ctx.format : null;
  return {
    groesse: f && typeof f.groesse === 'function' ? (b) => f.groesse(b) : groesseFormat,
    zeit: f && typeof f.zeitGenau === 'function' ? (z) => f.zeitGenau(z) : zeitFormat,
  };
}

/** Übersetzer mit Platzhalter-Rückfall */
export function uebersetzer(ctx) {
  return (schluessel, werte) => {
    let text;
    try { text = ctx.t(schluessel, werte); } catch { text = undefined; }
    if (text === undefined || text === null) text = schluessel;
    return fuellen(String(text), werte);
  };
}

/** Zur Karte aus dem Sprungziel scrollen und sie kurz hervorheben. */
export function karteAnspringen(wurzel, route) {
  const ziel = route && Array.isArray(route.teile) ? route.teile[0] : null;
  if (!ziel || !wurzel || typeof wurzel.querySelector !== 'function') return false;
  const k = wurzel.querySelector(`[data-karte="${String(ziel).replace(/[^a-z0-9-]/g, '')}"]`);
  if (!k) return false;
  const hin = (sanft) => { try { k.scrollIntoView({ behavior: sanft ? 'smooth' : 'auto', block: 'start' }); } catch { /* alt */ } };
  setTimeout(() => { hin(true); k.classList.add('karte-hervorgehoben'); setTimeout(() => k.classList.remove('karte-hervorgehoben'), 2500); }, 50);
  setTimeout(() => hin(false), 900); // Karten darüber laden ihre Inhalte nach und verschieben die Lage
  return true;
}

/**
 * Sprungziel einer Suche oder eines „Beheben“-Knopfs (#/<ansicht>/ziel/<name>): wartet bis zu 6 s auf das Element mit
 * data-suchziel=<name> (Listen laden nach), scrollt hin und hebt es kurz hervor.
 */
export function suchzielAnspringen(wurzel, route) {
  const teile = route && Array.isArray(route.teile) ? route.teile : [];
  if (teile[0] !== 'ziel' || !teile[1] || !wurzel || typeof wurzel.querySelectorAll !== 'function') return false;
  const name = teile[1]; const ende = Date.now() + 6000;
  const versuch = () => {
    const k = [...wurzel.querySelectorAll('[data-suchziel]')].find((x) => x.dataset.suchziel === name);
    if (!k) { if (Date.now() < ende && wurzel.isConnected !== false) setTimeout(versuch, 150); return; }
    try { k.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* alt */ }
    k.classList.add('suchziel-hervorgehoben'); setTimeout(() => k.classList.remove('suchziel-hervorgehoben'), 2600);
  };
  versuch();
  return true;
}
