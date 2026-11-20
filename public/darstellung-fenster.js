// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fenster „Darstellung“ (Kopfleiste): Sprache, Theme, Akzentfarbe, Hintergrund (aus/Circuit/Polygone/eigene Tapete),
// Glas-Look mit Transparenz-Regler, Tapete hochladen/entfernen, Abdunkeln. Jede Änderung wirkt sofort und wird im eigenen
// Konto gespeichert. Seit 15.10.2026: Tapeten-Galerie aus eigener Sammlung + Freigabe-Ordner und Skalierung; seit
// 16.10.2026 Zoom-Regler (wirkt beim Schieben sofort auf dem Bildschirm, gespeichert beim Loslassen).

import { el, t, dialog, melden, aktuelleSprache, spracheWechseln, setzeDesign } from './app.js';
import { api } from './api.js';
import { THEMES, AKZENTE, TRANSPARENZ, SKALIERUNGEN, ZOOM, wirksameSkalierung, anwenden, aktuelleDarstellung, normal, glasVariablen, gleicheTapete, tapeteUrl } from './darstellung.js';
import { alleLaden, vorschauAdresse, auswahlForm, hochladen, loeschen } from './tapeten.js';

const THEME_TEXT = Object.freeze({ auto: 'darstellung.theme_auto', hell: 'darstellung.theme_hell', dunkel: 'darstellung.theme_dunkel', midnight: 'darstellung.theme_midnight', ocean: 'darstellung.theme_ocean', steampunk: 'darstellung.theme_steampunk', cyberpunk: 'darstellung.theme_cyberpunk' });
const AKZENT_TEXT = Object.freeze({ standard: 'darstellung.akzent_standard', violett: 'darstellung.akzent_violett', blau: 'darstellung.akzent_blau', tuerkis: 'darstellung.akzent_tuerkis', gruen: 'darstellung.akzent_gruen', gelb: 'darstellung.akzent_gelb', orange: 'darstellung.akzent_orange', rot: 'darstellung.akzent_rot', pink: 'darstellung.akzent_pink', grau: 'darstellung.akzent_grau' });
const HG_TEXT = Object.freeze({ aus: 'darstellung.hg_aus', circuit: 'darstellung.hg_circuit', polygone: 'darstellung.hg_polygone', tapete: 'darstellung.hg_tapete' });
const SK_TEXT = Object.freeze({ auto: 'darstellung.sk_auto', fuellen: 'darstellung.sk_fuellen', einpassen: 'darstellung.sk_einpassen', strecken: 'darstellung.sk_strecken', mitte: 'darstellung.sk_mitte', kacheln: 'darstellung.sk_kacheln' });
const SK_STUFE = Object.freeze({ auto: 'darstellung.sk_auto_text', fuellen: 'darstellung.sk_fuellen_text', einpassen: 'darstellung.sk_einpassen_text', strecken: 'darstellung.sk_strecken_text', mitte: 'darstellung.sk_mitte_text', kacheln: 'darstellung.sk_kacheln_text' });

/** Vorschau-Kachel einer Tapete (Bild per Vorschaudienst, eigenes Video als stummes Standbild). */
export function tapetenBild(tp) {
  const adresse = vorschauAdresse(tp);
  if (adresse) return el('img', { src: adresse, alt: '', loading: 'lazy', decoding: 'async' });
  const v = el('video', { src: `${tapeteUrl(tp)}#t=0.5`, preload: 'metadata', muted: '', playsinline: '' });
  v.muted = true;
  return v;
}

/** Abdunkeln-Stufe als Text unter dem Regler. */
export function abdunkelnText(w) {
  if (w <= 10) return t('darstellung.abdunkeln_kaum', { n: w });
  if (w <= 45) return t('darstellung.abdunkeln_mittel', { n: w });
  return t('darstellung.abdunkeln_stark', { n: w });
}

/** Zoom-Stufe als Text unter dem Regler (Kacheln: Größe der Kacheln). */
export function zoomText(w, kacheln = false) {
  if (w === 100) return t('darstellung.zoom_normal', { n: w });
  if (kacheln) return t(w < 100 ? 'darstellung.zoom_kacheln_klein' : 'darstellung.zoom_kacheln_gross', { n: w });
  return t(w < 100 ? 'darstellung.zoom_klein' : 'darstellung.zoom_gross', { n: w });
}

/** Transparenz-Stufe des Glases als Text unter dem Regler. */
export function transparenzText(w) {
  if (w <= 25) return t('darstellung.glas_dezent', { n: w });
  if (w <= 55) return t('darstellung.glas_mittel', { n: w });
  return t('darstellung.glas_klar', { n: w });
}

let speichernTimer = null;
function speichern(nutzer, d) {
  clearTimeout(speichernTimer);
  speichernTimer = setTimeout(() => {
    api('nutzer.einstellungen.setzen', { name: nutzer, bereich: 'darstellung', wert: d }).catch((e) => melden(t('darstellung.speichern_fehler', { grund: e.message }), 'fehler'));
  }, 400);
}

/** Öffnet das Fenster. `nutzer` = Name des angemeldeten Kontos. */
export function oeffnen(nutzer) {
  let d = aktuelleDarstellung();
  const aendern = (teil) => { d = normal({ ...d, ...teil }); anwenden(d, { setzeDesign }); speichern(nutzer, d); zeichnen(); markieren(); };
  const inhalt = el('div', { class: 'darstellung' });
  const abschnitt = (titel, erklaerung, ...kinder) => el('section', { class: 'darstellung-abschnitt' }, [el('h3', { text: titel }), erklaerung ? el('p', { class: 'erklaerung', text: erklaerung }) : null, ...kinder]);
  const tupfer = (aktiv, titel, stil, beiKlick, klasse = '') => el('button', { type: 'button', class: `darstellung-tupfer${aktiv ? ' aktiv' : ''} ${klasse}`.trim(), title: titel, 'aria-label': titel, 'aria-pressed': aktiv ? 'true' : 'false', style: { background: stil }, onclick: beiKlick });
  const status = el('p', { class: 'erklaerung', 'aria-live': 'polite' });
  const datei = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm', multiple: true, hidden: true });
  let bestand = { eigene: [], ordner: [], max: 30, eigeneFehler: null, ordnerFehler: null, geladen: false };
  let wahl = null; // Ordnerwahl offen: {freigabe|null, pfad}
  const galerie = el('div', { class: 'darstellung-galerie-bereich' });
  const kacheln = []; // [{tp, knopf}] zum Markieren ohne Neuaufbau (Videos/Bilder bleiben geladen)
  const markieren = () => { for (const k of kacheln) { const an = gleicheTapete(k.tp, d.tapete); k.knopf.classList.toggle('aktiv', an); k.knopf.setAttribute('aria-pressed', an ? 'true' : 'false'); } };
  async function neuLaden() { bestand = { ...(await alleLaden(d)), geladen: true }; galerieZeichnen(); }

  datei.addEventListener('change', async () => {
    const liste = [...(datei.files || [])]; datei.value = '';
    let letzte = null;
    for (const f of liste) {
      status.textContent = t('darstellung.tapete_laedt', { name: f.name });
      try { letzte = await hochladen(f); } catch (e) { status.textContent = t('darstellung.tapete_fehler', { grund: e.message }); letzte = null; break; }
    }
    if (letzte) { status.textContent = ''; aendern({ hintergrund: 'tapete', tapete: auswahlForm(letzte) }); melden(t('darstellung.tapete_fertig'), 'erfolg'); }
    await neuLaden();
  });

  function raster(liste, mitLoeschen) {
    return el('div', { class: 'darstellung-galerie', role: 'group' }, liste.map((tp) => {
      const knopf = el('button', { type: 'button', class: 'darstellung-galerie-bild', title: tp.name, 'aria-label': tp.name, onclick: () => aendern({ hintergrund: 'tapete', tapete: auswahlForm(tp) }) },
        [tapetenBild(tp), tp.art === 'video' ? el('span', { class: 'darstellung-galerie-video', text: '▶' }) : null]);
      kacheln.push({ tp, knopf });
      return el('div', { class: 'darstellung-galerie-zelle' }, [knopf, mitLoeschen ? el('button', { type: 'button', class: 'darstellung-galerie-weg', title: t('darstellung.tapete_entfernen'), 'aria-label': t('darstellung.tapete_entfernen_name', { name: tp.name }), onclick: async () => {
        try { await loeschen(tp.id); } catch (e) { melden(t('darstellung.tapete_fehler_loeschen', { grund: e.message }), 'fehler'); return; }
        if (gleicheTapete(tp, d.tapete)) aendern({ tapete: null, hintergrund: d.hintergrund === 'tapete' ? 'aus' : d.hintergrund });
        await neuLaden();
      } }, '×') : null]);
    }));
  }

  function galerieZeichnen() {
    galerie.textContent = ''; kacheln.length = 0;
    if (!bestand.geladen) { galerie.append(el('p', { class: 'erklaerung', text: t('darstellung.tapete_laden') })); return; }
    // eigene Sammlung
    const voll = bestand.eigene.length >= bestand.max;
    galerie.append(el('h4', { text: t('darstellung.tapete_eigene', { n: bestand.eigene.length, max: bestand.max }) }),
      el('p', { class: 'erklaerung', text: t('darstellung.tapete_eigene_erklaerung') }));
    if (bestand.eigeneFehler) galerie.append(el('p', { class: 'erklaerung', text: t('darstellung.tapete_fehler_liste', { grund: bestand.eigeneFehler.message }) }));
    if (bestand.eigene.length) galerie.append(raster(bestand.eigene, true));
    galerie.append(el('div', { class: 'darstellung-reihe' }, [
      el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', disabled: voll, title: voll ? t('darstellung.tapete_voll', { max: bestand.max }) : undefined, onclick: () => datei.click() }, t('darstellung.tapete_hochladen')), datei]), status);
    // Ordner aus einer Freigabe
    const o = d.tapetenordner;
    galerie.append(el('h4', { text: t('darstellung.tapete_ordner') }), el('p', { class: 'erklaerung', text: t('darstellung.tapete_ordner_erklaerung') }));
    if (wahl) { galerie.append(ordnerWahl()); markieren(); return; }
    galerie.append(el('div', { class: 'darstellung-reihe' }, [
      o ? el('span', { class: 'darstellung-ordnerpfad', text: `${o.freigabe}/${o.pfad}` }) : null,
      el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', onclick: () => { wahl = o ? { ...o } : { freigabe: null, pfad: '' }; galerieZeichnen(); } }, t(o ? 'darstellung.tapete_ordner_anders' : 'darstellung.tapete_ordner_waehlen')),
      o ? el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', onclick: async () => { aendern({ tapetenordner: null }); await neuLaden(); } }, t('darstellung.tapete_ordner_loesen')) : null,
      o ? el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', title: t('darstellung.tapete_ordner_neu_titel'), onclick: () => neuLaden() }, t('darstellung.tapete_ordner_neu')) : null,
    ]));
    if (o && bestand.ordnerFehler) galerie.append(el('p', { class: 'erklaerung', text: t('darstellung.tapete_fehler_liste', { grund: bestand.ordnerFehler.message }) }));
    else if (o && !bestand.ordner.length) galerie.append(el('p', { class: 'erklaerung', text: t('darstellung.tapete_ordner_leer') }));
    else if (o) galerie.append(raster(bestand.ordner, false));
    markieren();
  }

  /** Ordnerwahl im Fenster: oben die Freigaben, darunter die Unterordner. */
  function ordnerWahl() {
    const box = el('div', { class: 'darstellung-ordnerwahl' });
    const liste = el('ul', { class: 'darstellung-ordnerliste', role: 'list' }, [el('li', { class: 'erklaerung', text: t('darstellung.tapete_laden') })]);
    const ort = wahl.freigabe ? `${wahl.freigabe}/${wahl.pfad}` : t('darstellung.tapete_ordner_freigaben');
    const hoch = () => { if (!wahl.pfad) wahl = { freigabe: null, pfad: '' }; else wahl = { ...wahl, pfad: wahl.pfad.includes('/') ? wahl.pfad.slice(0, wahl.pfad.lastIndexOf('/')) : '' }; galerieZeichnen(); };
    box.append(el('p', { class: 'darstellung-ordnerpfad', text: ort }), liste, el('div', { class: 'darstellung-reihe' }, [
      wahl.freigabe ? el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', onclick: hoch }, t('darstellung.tapete_ordner_hoch')) : null,
      el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', onclick: () => { wahl = null; galerieZeichnen(); } }, t('rahmen.abbrechen')),
      wahl.freigabe ? el('button', { type: 'button', class: 'knopf knopf-klein', onclick: async () => { const neu = { freigabe: wahl.freigabe, pfad: wahl.pfad }; wahl = null; aendern({ tapetenordner: neu }); bestand.geladen = false; galerieZeichnen(); await neuLaden(); } }, t('darstellung.tapete_ordner_nehmen')) : null,
    ]));
    const stand = wahl;
    (async () => {
      let eintraege = [];
      try {
        if (!stand.freigabe) { const r = await api('freigaben.liste', {}); eintraege = (Array.isArray(r) ? r : (r && r.freigaben) || []).map((f) => ({ name: f.name, freigabe: f.name, pfad: '' })); }
        else { const r = await api('dateien.liste', { freigabe: stand.freigabe, pfad: stand.pfad }); eintraege = (Array.isArray(r) ? r : (r && r.eintraege) || []).filter((e) => e.art === 'ordner').map((e) => ({ name: e.name, freigabe: stand.freigabe, pfad: stand.pfad ? `${stand.pfad}/${e.name}` : e.name })); }
      } catch (e) { if (wahl === stand) { liste.textContent = ''; liste.append(el('li', { class: 'erklaerung', text: e.message })); } return; }
      if (wahl !== stand) return;
      liste.textContent = '';
      eintraege.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      if (!eintraege.length) liste.append(el('li', { class: 'erklaerung', text: t(stand.freigabe ? 'darstellung.tapete_ordner_keine_unter' : 'darstellung.tapete_ordner_keine_freigabe') }));
      for (const e of eintraege) liste.append(el('li', {}, [el('button', { type: 'button', class: 'darstellung-ordnerknopf', onclick: () => { wahl = { freigabe: e.freigabe, pfad: e.pfad }; galerieZeichnen(); } }, `📁 ${e.name}`)]));
    })();
    return box;
  }

  function zeichnen() {
    inhalt.textContent = '';
    const sprache = aktuelleSprache();
    inhalt.append(
      abschnitt(t('darstellung.sprache'), null, el('div', { class: 'darstellung-reihe' }, [
        el('button', { type: 'button', class: `knopf ${sprache === 'de' ? '' : 'knopf-zweit'}`, lang: 'de', onclick: () => { if (sprache !== 'de') spracheWechseln('de'); } }, 'Deutsch'),
        el('button', { type: 'button', class: `knopf ${sprache === 'en' ? '' : 'knopf-zweit'}`, lang: 'en', onclick: () => { if (sprache !== 'en') spracheWechseln('en'); } }, 'English'),
      ])),
      abschnitt(t('darstellung.theme'), t('darstellung.theme_erklaerung'), el('div', { class: 'darstellung-reihe' },
        THEMES.map((x) => tupfer(d.theme === x.id, t(THEME_TEXT[x.id]), x.muster, () => aendern({ theme: x.id }))))),
      abschnitt(t('darstellung.akzent'), t('darstellung.akzent_erklaerung'), el('div', { class: 'darstellung-reihe' },
        AKZENTE.map((a) => tupfer(d.akzent === a.id, t(AKZENT_TEXT[a.id]), a.farbe || 'var(--fahnas-flaeche-2)', () => aendern({ akzent: a.id }), a.farbe ? '' : 'darstellung-tupfer-standard')))),
      abschnitt(t('darstellung.glas'), t('darstellung.glas_erklaerung'),
        el('div', { class: 'darstellung-reihe darstellung-segmente', role: 'group', 'aria-label': t('darstellung.glas') }, [false, true].map((an) =>
          el('button', { type: 'button', class: `knopf knopf-klein ${d.glas === an ? '' : 'knopf-zweit'}`, 'aria-pressed': d.glas === an ? 'true' : 'false', onclick: () => aendern({ glas: an }) }, t(an ? 'darstellung.glas_an' : 'darstellung.glas_aus')))),
        d.glas ? (() => {
          const regler = el('input', { type: 'range', min: String(TRANSPARENZ.min), max: String(TRANSPARENZ.max), step: '5', value: String(d.transparenz), 'aria-label': t('darstellung.transparenz') });
          const stufe = el('p', { class: 'erklaerung darstellung-stufe', text: transparenzText(d.transparenz) });
          regler.addEventListener('input', () => {
            stufe.textContent = transparenzText(Number(regler.value));
            for (const [k, v] of Object.entries(glasVariablen(Number(regler.value)))) document.documentElement.style.setProperty(k, v); // Vorschau ohne Speichern
          });
          regler.addEventListener('change', () => aendern({ transparenz: Number(regler.value) }));
          return el('div', { class: 'darstellung-regler' }, [el('label', { text: t('darstellung.transparenz') }), regler, stufe]);
        })() : null),
      abschnitt(t('darstellung.hintergrund'), t('darstellung.hintergrund_erklaerung'), el('div', { class: 'darstellung-reihe darstellung-segmente', role: 'group' },
        Object.keys(HG_TEXT).map((h) => el('button', { type: 'button', class: `knopf knopf-klein ${d.hintergrund === h ? '' : 'knopf-zweit'}`, 'aria-pressed': d.hintergrund === h ? 'true' : 'false', disabled: h === 'tapete' && !d.tapete,
          title: h === 'tapete' && !d.tapete ? t('darstellung.tapete_erst_waehlen') : undefined, onclick: () => aendern({ hintergrund: h }) }, t(HG_TEXT[h]))))),
      abschnitt(t('darstellung.tapete'), t('darstellung.tapete_erklaerung'), galerie,
        el('h4', { text: t('darstellung.skalierung') }),
        el('p', { class: 'erklaerung', text: t('darstellung.skalierung_erklaerung') }),
        el('div', { class: 'darstellung-reihe darstellung-segmente', role: 'group', 'aria-label': t('darstellung.skalierung') }, SKALIERUNGEN.map((sk) => {
          const gesperrt = sk === 'kacheln' && d.tapete && d.tapete.art === 'video';
          return el('button', { type: 'button', class: `knopf knopf-klein ${d.skalierung === sk ? '' : 'knopf-zweit'}`, 'aria-pressed': d.skalierung === sk ? 'true' : 'false', disabled: gesperrt, title: gesperrt ? t('darstellung.sk_kacheln_video') : undefined, onclick: () => aendern({ skalierung: sk }) }, t(SK_TEXT[sk]));
        })),
        el('p', { class: 'erklaerung darstellung-stufe', text: d.skalierung === 'kacheln' && d.tapete && d.tapete.art === 'video' ? t('darstellung.sk_kacheln_video') : t(SK_STUFE[d.skalierung]) }),
        d.tapete ? (() => {
          const kacheln = d.skalierung === 'kacheln' && d.tapete.art !== 'video';
          // bei „Automatisch“ gesperrt (Betreiber 16.10.2026: „regler ausgrauen – nur anwendbar bei den settings nach automatisch“)
          const gesperrt = wirksameSkalierung(d.skalierung, d.tapete) === 'auto';
          const regler = el('input', { type: 'range', min: String(ZOOM.min), max: String(ZOOM.max), step: String(ZOOM.schritt), value: String(gesperrt ? 100 : d.zoom), disabled: gesperrt, 'aria-label': t('darstellung.zoom') });
          const stufe = el('p', { class: 'erklaerung darstellung-stufe', text: gesperrt ? t('darstellung.zoom_auto') : zoomText(d.zoom, kacheln) });
          const zurueck = el('button', { type: 'button', class: 'knopf knopf-zweit knopf-klein', hidden: gesperrt || d.zoom === 100, onclick: () => aendern({ zoom: 100 }) }, t('darstellung.zoom_zuruecksetzen'));
          regler.addEventListener('input', () => {
            const w = Number(regler.value);
            stufe.textContent = zoomText(w, kacheln); zurueck.hidden = w === 100;
            document.documentElement.style.setProperty('--fahnas-zoom', String(w / 100)); // Vorschau auf dem NAS-Bildschirm
          });
          regler.addEventListener('change', () => aendern({ zoom: Number(regler.value) }));
          return el('div', { class: `darstellung-regler${gesperrt ? ' gesperrt' : ''}`, 'aria-disabled': gesperrt ? 'true' : undefined }, [el('label', { text: t('darstellung.zoom') }), el('p', { class: 'erklaerung', text: t('darstellung.zoom_erklaerung') }), regler, stufe, zurueck]);
        })() : null,
        d.tapete ? (() => {
          const regler = el('input', { type: 'range', min: '0', max: '85', step: '5', value: String(d.abdunkeln), 'aria-label': t('darstellung.abdunkeln') });
          const stufe = el('p', { class: 'erklaerung darstellung-stufe', text: abdunkelnText(d.abdunkeln) });
          regler.addEventListener('input', () => { stufe.textContent = abdunkelnText(Number(regler.value)); document.documentElement.style.setProperty('--fahnas-abdunkeln', String(Number(regler.value) / 100)); });
          regler.addEventListener('change', () => aendern({ abdunkeln: Number(regler.value) }));
          return el('div', { class: 'darstellung-regler' }, [el('label', { text: t('darstellung.abdunkeln') }), regler, stufe]);
        })() : null),
    );
  }
  zeichnen();
  galerieZeichnen();
  neuLaden().catch(() => {});
  return dialog([inhalt], { titel: t('darstellung.titel'), klasse: 'darstellung-dialog' });
}
