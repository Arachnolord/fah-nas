// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Texteditor im Dateimanager (Plan 01, Entwurf §4): Textdateien öffnen sich bearbeitbar, gespeichert wird beim
// Schließen (Dialog-Veto V3) und mit Strg/⌘+S. Wurde die Datei inzwischen woanders geändert (E_GEAENDERT), wird nie
// still überschrieben, sondern gefragt: als Kopie speichern / trotzdem überschreiben / verwerfen / abbrechen.
// Nur lesen ohne Schreibrecht, im Papierkorb und bei Dateien, die kein UTF-8 sind. CRLF und BOM bleiben byte-genau.
// Beim Schließen wird so lange gespeichert, bis nichts Ungespeichertes mehr da ist (auch nach einem laufenden Speichern);
// scheitert es, fragt der Editor: weiter bearbeiten, Text herunterladen, als Kopie speichern oder ohne Speichern schließen.

import { el, t, symbol, bestaetigen } from './app.js';
import { markdownZuKnoten } from './markdown.js';

/** Größte Datei, die der Editor öffnet (gleich MAX_TEXT_VORSCHAU im Dateimanager). */
export const TEXT_OEFFNEN_MAX = 1024 * 1024;

/** Überwiegendes Zeilenende einer Datei: '\r\n' (Windows) oder '\n'. */
export function zeilenendeErkennen(text) {
  const crlf = (String(text).match(/\r\n/g) || []).length;
  const lf = (String(text).match(/(^|[^\r])\n/g) || []).length;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/** Textfeld-Inhalt (immer '\n') für die Platte zurück ins ursprüngliche Zeilenende wandeln. */
export function fuerSpeichern(wert, zeilenende) {
  return zeilenende === '\r\n' ? String(wert).replace(/\r?\n/g, '\r\n') : String(wert);
}

/** Name der Kopie bei einem Konflikt: „<Stamm> (bearbeitet JJJJ-MM-TT HH-MM)[ (n)]<.endung>“ (Ortszeit). */
export function kopieName(name, datum, n = 1) {
  const z = (x) => String(x).padStart(2, '0');
  const stempel = `${datum.getFullYear()}-${z(datum.getMonth() + 1)}-${z(datum.getDate())} ${z(datum.getHours())}-${z(datum.getMinutes())}`;
  const punkt = name.lastIndexOf('.');
  const stamm = punkt > 0 ? name.slice(0, punkt) : name;
  const endung = punkt > 0 ? name.slice(punkt) : '';
  return `${stamm} (bearbeitet ${stempel})${n > 1 ? ` (${n})` : ''}${endung}`;
}

export function istMarkdown(name) { return /\.(md|markdown)$/i.test(String(name)); }

/** Bytes → Text. Kein gültiges UTF-8 → utf8:false (dann nur lesen, damit beim Speichern nichts kaputtgeht). BOM bleibt. */
export function textDekodieren(puffer) {
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(puffer), utf8: true }; } catch {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(puffer), utf8: false };
  }
}

function fehlerText(ctx, e) {
  if (ctx && typeof ctx.fehlerText === 'function') { try { return ctx.fehlerText(e); } catch { /* unten */ } }
  return (e && (e.meldung || e.message)) || '';
}

/** Konfliktfrage → 'kopie' | 'ueberschreiben' | 'verwerfen' | 'abbrechen' (Esc = abbrechen). */
function konfliktFragen(ctx) {
  return new Promise((fertig) => {
    let wahl = 'abbrechen';
    let griff = null;
    const knopf = (w, text, zweit = true) => el('button', {
      class: `knopf${zweit ? ' knopf-zweit' : ''}`, type: 'button', 'data-wahl': w, text,
      onclick: () => { wahl = w; griff.schliessen(undefined, { sofort: true }); },
    });
    griff = ctx.dialog([
      el('p', { text: t('dateien.editor_konflikt_text') }),
      el('div', { class: 'knopf-reihe texteditor-konflikt' }, [
        knopf('kopie', t('dateien.editor_als_kopie'), false), knopf('ueberschreiben', t('dateien.editor_ueberschreiben')),
        knopf('verwerfen', t('dateien.editor_verwerfen')), knopf('abbrechen', t('dateien.editor_abbrechen')),
      ]),
    ], { titel: t('dateien.editor_konflikt_titel'), festhalten: true, beimSchliessen: () => fertig(wahl) });
  });
}

/** Speicherfehler beim Schließen → 'weiter' | 'herunterladen' | 'kopie' | 'verwerfen' (Esc = weiter). */
function fehlerFragen(ctx, e) {
  return new Promise((fertig) => {
    let wahl = 'weiter';
    let griff = null;
    const knopf = (w, text, art = 'knopf-zweit') => el('button', {
      class: `knopf ${art}`.trim(), type: 'button', 'data-wahl': w, text,
      onclick: () => { wahl = w; griff.schliessen(undefined, { sofort: true }); },
    });
    griff = ctx.dialog([
      el('p', { text: t('dateien.editor_speicherfehler_text', { grund: fehlerText(ctx, e) || '–' }) }),
      el('div', { class: 'knopf-reihe texteditor-konflikt' }, [
        knopf('weiter', t('dateien.editor_abbrechen'), ''), knopf('herunterladen', t('dateien.editor_text_herunterladen')),
        knopf('kopie', t('dateien.editor_als_kopie')), knopf('verwerfen', t('dateien.editor_ohne_speichern'), 'knopf-zweit knopf-gefahr'),
      ]),
    ], { titel: t('dateien.editor_speicherfehler_titel'), festhalten: true, beimSchliessen: () => fertig(wahl) });
  });
}

/**
 * Öffnet den Editor als Dialog und lädt die Datei. Gibt {element, feld, status, hinweis, speichern, schliessen}
 * zurück (für Tests und Aufrufer). `jetzt` liefert die Uhrzeit (Kopie-Name, Statuszeile).
 */
export async function texteditorOeffnen(ctx, { freigabe, pfad, eintrag = {}, schreibbar = true, nachSpeichern = null, jetzt = () => new Date() }) {
  const name = eintrag.name || String(pfad).split('/').pop();
  const ordner = String(pfad).includes('/') ? String(pfad).slice(0, String(pfad).lastIndexOf('/')) : '';
  let geladen = false; let nurLesen = true; let ursprung = ''; let zeilenende = '\n'; let stand = null; let laeuft = null; let letzterFehler = null;
  const geaendert = () => geladen && !nurLesen && feld.value !== ursprung;

  const status = el('span', { class: 'texteditor-status', role: 'status', 'aria-live': 'polite' });
  const hinweis = el('p', { class: 'hinweis hinweis-info texteditor-hinweis', hidden: true });
  const feld = el('textarea', { class: 'eingabe texteditor-feld', spellcheck: 'false', 'aria-label': name, readOnly: true });
  const ansicht = el('div', { class: 'texteditor-ansicht', hidden: true });
  const speicherKnopf = el('button', { class: 'knopf knopf-klein', type: 'button', text: t('dateien.editor_speichern'), disabled: true, onclick: () => { if (geaendert()) speichern(); } });
  const modusKnopf = (m, text) => el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', 'data-modus': m, 'aria-pressed': m === 'bearbeiten' ? 'true' : 'false', text, onclick: () => modusSetzen(m) });
  const umschalter = istMarkdown(name) ? el('div', { class: 'texteditor-umschalter', role: 'group' }, [modusKnopf('bearbeiten', t('dateien.editor_bearbeiten')), modusKnopf('ansicht', t('dateien.editor_ansicht'))]) : null;
  const leiste = el('div', { class: 'texteditor-leiste' }, [umschalter, status, speicherKnopf]);
  const fuss = el('div', { class: 'dateien-vorschau-fuss' }, [
    el('a', { class: 'knopf knopf-zweit', href: ctx.downloadUrl(freigabe, pfad), download: name }, [symbol('herunterladen'), t('dateien.herunterladen')]),
  ]);

  function zeige(art, e) {
    if (art === 'ungespeichert') status.textContent = t('dateien.editor_ungespeichert');
    else if (art === 'speichert') status.textContent = t('dateien.editor_speichert');
    else if (art === 'gespeichert') status.textContent = t('dateien.editor_gespeichert', { zeit: uhrzeit(jetzt()) });
    else if (art === 'fehler') status.textContent = `${t('dateien.editor_fehler_speichern')} ${fehlerText(ctx, e)}`.trim();
    else if (art === 'fehler_laden') status.textContent = `${t('dateien.vorschau_fehler')} ${fehlerText(ctx, e)}`.trim();
    else status.textContent = '';
    speicherKnopf.disabled = !geaendert() || !!laeuft;
  }
  function hinweisZeigen(text) { hinweis.textContent = text; hinweis.hidden = false; }
  function modusSetzen(m) {
    const an = m === 'ansicht';
    if (an) ansicht.replaceChildren(markdownZuKnoten(feld.value));
    feld.hidden = an; ansicht.hidden = !an;
    if (umschalter) for (const k of umschalter.querySelectorAll('[data-modus]')) k.setAttribute('aria-pressed', k.getAttribute('data-modus') === m ? 'true' : 'false');
  }
  function gespeichert(wert, r) {
    if (r && r.geaendert) stand = { geaendert: r.geaendert, groesse: Number(r.groesse) };
    ursprung = wert;
    zeige(geaendert() ? 'ungespeichert' : 'gespeichert');
    if (typeof nachSpeichern === 'function') { try { nachSpeichern(); } catch { /* egal */ } }
  }

  /** Text als Kopie neben der Datei speichern („<Name> (bearbeitet …)“); true = gespeichert. Fehler werden geworfen. */
  async function kopieSpeichern(wert) {
    const inhalt = fuerSpeichern(wert, zeilenende);
    const datum = jetzt();
    let letzter = null;
    for (let n = 1; n <= 20; n++) {
      const kName = kopieName(name, datum, n);
      try {
        await ctx.api('dateien.text.speichern', { freigabe, pfad: ordner ? `${ordner}/${kName}` : kName, inhalt, neu: true });
        ursprung = wert; zeige(null);
        if (typeof ctx.melden === 'function') ctx.melden(t('dateien.editor_kopie_gespeichert', { name: kName }), 'erfolg');
        if (typeof nachSpeichern === 'function') { try { nachSpeichern(); } catch { /* egal */ } }
        return true;
      } catch (e) { if (!e || e.code !== 'E_EXISTIERT') throw e; letzter = e; }
    }
    throw letzter;
  }

  /** Konflikt lösen; true = Editor darf zu. */
  async function konflikt(wert) {
    const wahl = await konfliktFragen(ctx);
    if (wahl === 'abbrechen') { zeige('ungespeichert'); return false; }
    if (wahl === 'verwerfen') { ursprung = feld.value; zeige(null); return true; }
    try {
      if (wahl === 'ueberschreiben') {
        gespeichert(wert, await ctx.api('dateien.text.speichern', { freigabe, pfad, inhalt: fuerSpeichern(wert, zeilenende) }));
        return true;
      }
      return await kopieSpeichern(wert);
    } catch (e) { letzterFehler = e; zeige('fehler', e); return false; }
  }

  /** Den Text, wie er im Feld steht, als Datei herunterladen (ohne Server – hilft, wenn Speichern nicht geht). */
  function textHerunterladen() {
    const blob = new Blob([fuerSpeichern(feld.value, zeilenende)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Nach einem Speicherfehler beim Schließen fragen; true = Editor darf zu. */
  async function nachFehler() {
    const wahl = await fehlerFragen(ctx, letzterFehler);
    if (wahl === 'herunterladen') { textHerunterladen(); return false; }
    if (wahl === 'kopie') {
      try { return await kopieSpeichern(feld.value); } catch (e) { letzterFehler = e; zeige('fehler', e); return false; }
    }
    if (wahl === 'verwerfen') {
      if (!(await bestaetigen(t('dateien.editor_ohne_speichern_frage'), { titel: t('dateien.editor_ohne_speichern'), ok: t('dateien.editor_ohne_speichern'), gefahr: true }))) return false;
      ursprung = feld.value; zeige(null);
      return true;
    }
    return false;
  }

  /** Schließen: speichern, bis nichts Ungespeichertes mehr da ist (auch nach einem laufenden Speichern); dabei kein Tippen. */
  async function speichernVorDemSchliessen() {
    if (!geaendert() && !laeuft) return true;
    feld.readOnly = true;
    try {
      for (;;) {
        if (laeuft) { await laeuft; await null; continue; }
        if (!geaendert()) return true;
        if (await speichern()) continue;
        return letzterFehler ? await nachFehler() : false; // Konflikt abgebrochen → offen bleiben
      }
    } finally {
      if (geladen) feld.readOnly = nurLesen;
    }
  }

  /** Speichert den aktuellen Inhalt; true = gespeichert (oder Konflikt gelöst), false = Fehler/abgebrochen. */
  async function speichern() {
    if (laeuft) return laeuft;
    laeuft = (async () => {
      const wert = feld.value;
      letzterFehler = null;
      zeige('speichert');
      try {
        gespeichert(wert, await ctx.api('dateien.text.speichern', { freigabe, pfad, inhalt: fuerSpeichern(wert, zeilenende), erwartet: stand }));
        return true;
      } catch (e) {
        if (e && e.code === 'E_GEAENDERT') return konflikt(wert);
        letzterFehler = e;
        zeige('fehler', e);
        return false;
      }
    })();
    try { return await laeuft; } finally { laeuft = null; speicherKnopf.disabled = !geaendert(); }
  }

  const warnen = (ev) => { if (geaendert()) { ev.preventDefault(); ev.returnValue = ''; } };
  window.addEventListener('beforeunload', warnen);
  const griff = ctx.dialog([el('div', { class: 'texteditor' }, [leiste, hinweis, feld, ansicht]), fuss], {
    titel: name, breit: true, klasse: 'texteditor-dialog',
    festhalten: true, // ein Klick neben den Editor (z. B. Markieren über den Rand) schließt ihn nicht
    vorSchliessen: () => speichernVorDemSchliessen(),
    beimSchliessen: () => window.removeEventListener('beforeunload', warnen),
  });
  feld.addEventListener('input', () => zeige(geaendert() ? 'ungespeichert' : null));
  griff.element.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && String(ev.key).toLowerCase() === 's') {
      ev.preventDefault();
      if (geaendert()) speichern();
    }
  });

  status.textContent = t('rahmen.laden');
  try {
    let info = await ctx.api('dateien.info', { freigabe, pfad });
    const blob = await ctx.ladeBlob(freigabe, pfad, TEXT_OEFFNEN_MAX);
    if (blob.size !== Number(info.groesse)) info = await ctx.api('dateien.info', { freigabe, pfad }); // zwischen Info und Laden geändert
    const { text, utf8 } = textDekodieren(await blob.arrayBuffer());
    zeilenende = zeilenendeErkennen(text);
    ursprung = text.replace(/\r\n?/g, '\n');
    feld.value = ursprung;
    stand = { geaendert: info.geaendert, groesse: Number(info.groesse) };
    nurLesen = !schreibbar || !utf8;
    feld.readOnly = nurLesen;
    if (!utf8) hinweisZeigen(t('dateien.editor_nicht_utf8'));
    else if (!schreibbar) hinweisZeigen(t('dateien.editor_nur_lesen'));
    geladen = true;
    if (!ansicht.hidden) ansicht.replaceChildren(markdownZuKnoten(feld.value)); // „Ansicht“ schon während des Ladens gewählt
    zeige(null);
    if (!nurLesen && typeof feld.focus === 'function') { try { feld.focus(); } catch { /* egal */ } }
  } catch (e) {
    zeige('fehler_laden', e);
  }
  return { element: griff.element, feld, status, hinweis, speichern, schliessen: griff.schliessen };
}

function uhrzeit(d) {
  try { return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
