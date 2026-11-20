// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Geführter Ablauf „Sicherung einrichten“ (Betreiber 12.10.2026: „Quelle → Ziel (USB, NAS oder Cloud) → Zeitplan → fertig.
// Spiegelung und Schnappschüsse sind dabei schon passend gesetzt“). Legt eine einseitige Spiegelung an (spiegelung.speichern),
// auf Wunsch Schnappschüsse der Quelle (täglich 14 + wöchentlich 8, nur wenn noch kein Plan da ist) und startet den ersten Lauf.

import { el, leeren, knopf, feld, auswahl, eingabe, schalter, radiogruppe, hinweis, fehlerzeile, dialogOeffnen, api, fehlerText, melden } from './verwaltung-hilfen.js';

const TAGE = Object.freeze([[1, 'spiegelung.tag_mo'], [2, 'spiegelung.tag_di'], [3, 'spiegelung.tag_mi'], [4, 'spiegelung.tag_do'], [5, 'spiegelung.tag_fr'], [6, 'spiegelung.tag_sa'], [0, 'spiegelung.tag_so']]);
export const SCHNAPPSCHUSS_VORSCHLAG = Object.freeze({ zeitplan: { stuendlich: false, taeglich: true, woechentlich: true }, behalten: { stuendlich: 0, taeglich: 14, woechentlich: 8 } });

export const VERSIONEN_TAGE = Object.freeze([7, 30, 90, 365]);
/** Auswahl „Ältere Stände aufbewahren“ (Tage). */
export function versionenAuswahl(wert = 30, t = (k, w) => (w ? `${w.n} Tage` : '1 Jahr')) {
  return auswahl({ optionen: VERSIONEN_TAGE.map((d) => ({ wert: String(d), text: d === 365 ? t('spiegelung.versionen_1_jahr') : t('spiegelung.versionen_n_tage', { n: d }) })), wert: String(wert) });
}

/**
 * Fenster „Ältere Stände“: Stände (je Lauf) auflisten, darin blättern, Datei/Ordner in die Quelle zurückholen.
 * Ziele auf einem anderen NAS / in der Cloud: Hinweis, wo die Stände liegen.
 */
export async function versionenZeigen(ctx, t, auftrag, zeitText = (iso) => new Date(iso).toLocaleString()) {
  const inhalt = el('div', { klasse: 'sa-versionen' }, el('p', { klasse: 'erklaerung', text: t('spiegelung.laden') }));
  const fz = fehlerzeile();
  const griff = dialogOeffnen({ ctx, titel: t('spiegelung.versionen_titel', { name: auftrag.name }), inhalt: el('div', {}, fz.element, inhalt), breit: true, schliessenText: t('spiegelung.schliessen'),
    knoepfe: [{ text: t('spiegelung.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }] });
  let r;
  try { r = await api(ctx, 'spiegelung.versionen', { id: auftrag.id }); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return griff; }
  const ueberblick = () => {
    leeren(inhalt);
    inhalt.appendChild(el('p', { klasse: 'erklaerung', text: t('spiegelung.versionen_erklaerung', { tage: r.tage }) }));
    if (r.fern) { inhalt.appendChild(hinweis(t('spiegelung.versionen_fern'), 'info')); return; }
    if (!r.staende.length) { inhalt.appendChild(el('p', { klasse: 'leer vw-leer', text: t('spiegelung.versionen_keine') })); return; }
    inhalt.appendChild(el('ul', { klasse: 'sa-staende', role: 'list' }, r.staende.map((s) => el('li', {}, knopf(zeitText(s.zeit), { art: 'zweit', klein: true, beiKlick: () => blaettern(s, '') })))));
  };
  const blaettern = async (s, pfad) => {
    fz.leeren();
    let d;
    try { d = await api(ctx, 'spiegelung.versionen.inhalt', { id: auftrag.id, stand: s.stand, pfad }); } catch (e) { fz.zeigen(fehlerText(e)); return; }
    leeren(inhalt);
    const hoch = pfad.includes('/') ? pfad.slice(0, pfad.lastIndexOf('/')) : '';
    inhalt.append(
      el('div', { klasse: 'vw-knopfleiste' }, knopf(t('spiegelung.versionen_alle'), { art: 'zweit', klein: true, beiKlick: ueberblick }), pfad ? knopf(t('spiegelung.ordner_hoch'), { art: 'zweit', klein: true, beiKlick: () => blaettern(s, hoch) }) : null),
      el('p', { klasse: 'sp-ort', text: `${t('spiegelung.versionen_stand', { zeit: zeitText(s.zeit) })} – /${pfad}` }),
      d.eintraege.length ? el('ul', { klasse: 'sa-stand-inhalt', role: 'list' }, d.eintraege.map((e) => {
        const rel = pfad ? `${pfad}/${e.name}` : e.name;
        return el('li', {},
          e.ordner ? el('button', { typ: 'button', klasse: 'sp-ordnerknopf', text: `📁 ${e.name}`, onclick: () => blaettern(s, rel) }) : el('span', { text: `📄 ${e.name}` }),
          knopf(t('spiegelung.versionen_zurueck'), { klein: true, beiKlick: async () => {
            fz.leeren();
            try { const x = await api(ctx, 'spiegelung.versionen.zurueckholen', { id: auftrag.id, stand: s.stand, pfad: rel }); melden(ctx, t('spiegelung.versionen_zurueck_fertig', { pfad: `${x.freigabe}/${x.ziel}` }), 'erfolg'); } catch (err) { fz.zeigen(fehlerText(err)); }
          } }));
      })) : el('p', { klasse: 'leer vw-leer', text: t('spiegelung.ordner_leer') }));
  };
  ueberblick();
  return griff;
}

/** Ordner auf dem Ziel: FAH-NAS/<Quelle>[/<Unterordner>] – so liegen mehrere Sicherungen sauber nebeneinander. */
export function zielOrdner(quelle) { return ['FAH-NAS', quelle.freigabe, quelle.pfad].filter(Boolean).join('/').replace(/\/+/g, '/'); }

/** Auftrag für spiegelung.speichern aus den Antworten des Assistenten. */
export function auftragAus({ quelle, ziel, wann, uhrzeit = '03:00', tag = 1, name, versionen_tage = 30 }) {
  const a = { name: name || `Sicherung ${quelle.freigabe}`, art: 'sicherung', aktiv: true, quelle: { freigabe: quelle.freigabe, pfad: quelle.pfad || '' },
    ziel: { ...(ziel.zugang ? { zugang: ziel.zugang } : {}), freigabe: ziel.freigabe, pfad: ziel.pfad || zielOrdner(quelle) }, richtung: 'einseitig', versionen_tage };
  if (wann === 'aenderung') return { ...a, ausloeser: 'aenderung', tage: [], zeiten: [], wartezeit_min: 5 };
  return { ...a, ausloeser: 'zeitplan', tage: wann === 'woechentlich' ? [tag] : [0, 1, 2, 3, 4, 5, 6], zeiten: [uhrzeit] };
}

/**
 * Assistent öffnen. `optionen.zielFreigabe` = vorgewähltes Laufwerk (aus „Neue Platte erkannt“), `verbindungAnlegen()` =
 * Dialog „Andere NAS/Cloud verbinden“ der Spiegelungsansicht (Promise), `fertig()` = danach neu laden.
 */
export async function assistentOeffnen(ctx, t, { zielFreigabe = null, verbindungAnlegen = null, fertig = null } = {}) {
  let freigaben = []; let zugaenge = []; let plaene = [];
  const laden = async () => {
    const [f, z, p] = await Promise.all([
      api(ctx, 'freigaben.liste', {}).catch(() => []), api(ctx, 'spiegelung.zugaenge', {}).catch(() => []), api(ctx, 'snapshots.plan.lesen', {}).catch(() => null),
    ]);
    freigaben = Array.isArray(f) ? f : (f && f.freigaben) || []; zugaenge = Array.isArray(z) ? z : []; plaene = (p && Array.isArray(p.plaene)) ? p.plaene : [];
  };
  await laden();

  const st = { schritt: 0, quelle: { freigabe: '', pfad: '' }, art: zielFreigabe ? 'laufwerk' : '', ziel: zielFreigabe ? { freigabe: zielFreigabe, pfad: '' } : null, wann: 'taeglich', uhrzeit: '03:00', tag: 1, schnappschuesse: true, sofort: true };
  const inhalt = el('div', { klasse: 'sa-assistent' });
  const fz = fehlerzeile();
  const schritte = ['spiegelung.sa_schritt_quelle', 'spiegelung.sa_schritt_ziel', 'spiegelung.sa_schritt_wann', 'spiegelung.sa_schritt_fertig'];
  const griff = dialogOeffnen({ ctx, titel: t('spiegelung.sa_titel'), inhalt, breit: true, schliessenText: t('spiegelung.schliessen'), knoepfe: [] });

  const lokal = () => freigaben.filter((f) => !f.extern && !f.verbund);
  const laufwerke = () => freigaben.filter((f) => (f.extern || f.verbund) && f.name !== st.quelle.freigabe);
  const quelleIntern = () => { const f = freigaben.find((x) => x.name === st.quelle.freigabe); return !!f && !f.extern && !f.verbund; };
  const planDa = () => plaene.some((p) => p.ziel === st.quelle.freigabe && p.zeitplan && (p.zeitplan.taeglich || p.zeitplan.stuendlich || p.zeitplan.woechentlich || p.zeitplan.monatlich));

  function fuss(weiterText, weiter, { zurueck = true, aus = false } = {}) {
    return el('div', { klasse: 'vw-knopfleiste sa-fuss' },
      zurueck ? knopf(t('spiegelung.sa_zurueck'), { art: 'zweit', beiKlick: () => { fz.leeren(); st.schritt -= 1; zeichnen(); } }) : null,
      knopf(weiterText, { deaktiviert: aus, beiKlick: weiter }));
  }

  function schrittQuelle() {
    const wahl = auswahl({ optionen: [{ wert: '', text: t('spiegelung.freigabe_waehlen') }, ...[...lokal(), ...freigaben.filter((f) => f.extern || f.verbund)].map((f) => ({ wert: f.name, text: f.extern ? t('spiegelung.freigabe_extern', { name: f.name }) : f.name }))], wert: st.quelle.freigabe });
    const unter = eingabe({ maxlength: 1024, wert: st.quelle.pfad, platzhalter: t('spiegelung.unterordner_platzhalter') });
    return [
      el('p', { klasse: 'erklaerung', text: t('spiegelung.sa_quelle_erklaerung') }),
      feld({ label: t('spiegelung.sa_quelle'), erklaerung: t('spiegelung.sa_quelle_info'), eingabe: wahl }),
      feld({ label: t('spiegelung.unterordner'), erklaerung: t('spiegelung.sa_unterordner_info'), eingabe: unter }),
      fuss(t('spiegelung.sa_weiter'), () => {
        if (!wahl.value) { fz.zeigen(t('spiegelung.erst_freigabe')); return; }
        st.quelle = { freigabe: wahl.value, pfad: unter.value.trim().replace(/^\/+|\/+$/g, '') };
        if (st.ziel && !st.ziel.zugang && st.ziel.freigabe === st.quelle.freigabe) st.ziel = null;
        fz.leeren(); st.schritt = 1; zeichnen();
      }, { zurueck: false }),
    ];
  }

  function schrittZiel() {
    const bereich = el('div', { klasse: 'sa-ziel' });
    const arten = [
      ['laufwerk', 'spiegelung.sa_ziel_laufwerk', 'spiegelung.sa_ziel_laufwerk_info'],
      ['nas', 'spiegelung.sa_ziel_nas', 'spiegelung.sa_ziel_nas_info'],
      ['cloud', 'spiegelung.sa_ziel_cloud', 'spiegelung.sa_ziel_cloud_info'],
    ];
    const kacheln = el('div', { klasse: 'sa-wahl', attr: { role: 'radiogroup', 'aria-label': t('spiegelung.sa_schritt_ziel') } }, arten.map(([id, titel, info]) =>
      el('button', { klasse: `sa-wahl-knopf${st.art === id ? ' aktiv' : ''}`, typ: 'button', attr: { role: 'radio', 'aria-checked': st.art === id ? 'true' : 'false' },
        onclick: () => { st.art = id; st.ziel = null; fz.leeren(); zeichnen(); } }, el('strong', { text: t(titel) }), el('span', { klasse: 'erklaerung', text: t(info) }))));
    let wert = () => null;
    if (st.art === 'laufwerk') {
      const lw = laufwerke();
      if (!lw.length) bereich.appendChild(hinweis(t('spiegelung.sa_keine_laufwerke'), 'info'));
      else {
        const wahl = auswahl({ optionen: [{ wert: '', text: t('spiegelung.sa_laufwerk_waehlen') }, ...lw.map((f) => ({ wert: f.name, text: f.kapazitaet ? `${f.name} (${Math.round((f.kapazitaet - (f.belegt || 0)) / 1e9)} GB ${t('spiegelung.sa_frei')})` : f.name }))], wert: st.ziel && !st.ziel.zugang ? st.ziel.freigabe : '' });
        bereich.appendChild(feld({ label: t('spiegelung.sa_laufwerk'), erklaerung: t('spiegelung.sa_laufwerk_info'), eingabe: wahl }));
        wert = () => (wahl.value ? { freigabe: wahl.value } : null);
      }
    } else if (st.art === 'nas' || st.art === 'cloud') {
      const passende = zugaenge.filter((z) => (st.art === 'cloud' ? z.art === 'cloud' : z.art !== 'cloud'));
      const neuKnopf = verbindungAnlegen ? knopf(t(st.art === 'cloud' ? 'spiegelung.sa_cloud_neu' : 'spiegelung.sa_nas_neu'), { art: 'zweit', klein: true, beiKlick: async () => { await verbindungAnlegen(); await laden(); zeichnen(); } }) : null;
      if (!passende.length) bereich.append(hinweis(t(st.art === 'cloud' ? 'spiegelung.sa_keine_cloud' : 'spiegelung.sa_keine_nas'), 'info'), neuKnopf || '');
      else {
        const ort = auswahl({ optionen: passende.map((z) => ({ wert: z.id, text: `${z.name} (${z.adresse || z.anbieter || ''})` })), wert: st.ziel && st.ziel.zugang ? st.ziel.zugang : passende[0].id });
        const fern = auswahl({ optionen: [{ wert: '', text: t('spiegelung.fern_freigaben_laden') }] });
        const fernLaden = async () => {
          leeren(fern); fern.appendChild(el('option', { wert: '', text: t('spiegelung.fern_freigaben_laden') }));
          try {
            const r = await api(ctx, 'spiegelung.zugang.pruefen', { id: ort.value });
            leeren(fern); fern.appendChild(el('option', { wert: '', text: t('spiegelung.freigabe_waehlen') }));
            for (const f of (r && r.freigaben) || []) fern.appendChild(el('option', { wert: f.name, text: f.name }));
            if (st.ziel && st.ziel.freigabe) fern.value = st.ziel.freigabe;
          } catch (e) { leeren(fern); fern.appendChild(el('option', { wert: '', text: '–' })); fz.zeigen(fehlerText(e)); }
        };
        ort.addEventListener('change', () => { fz.leeren(); fernLaden(); });
        fernLaden();
        bereich.append(feld({ label: t('spiegelung.sa_verbindung'), erklaerung: t('spiegelung.sa_verbindung_info'), eingabe: ort }),
          feld({ label: t(st.art === 'cloud' ? 'spiegelung.sa_bucket' : 'spiegelung.freigabe'), erklaerung: t('spiegelung.sa_fern_freigabe_info'), eingabe: fern }), neuKnopf || '');
        wert = () => (fern.value ? { zugang: ort.value, freigabe: fern.value } : null);
      }
    }
    return [
      el('p', { klasse: 'erklaerung', text: t('spiegelung.sa_ziel_erklaerung') }), kacheln, bereich,
      fuss(t('spiegelung.sa_weiter'), () => {
        const z = wert();
        if (!z) { fz.zeigen(t('spiegelung.sa_ziel_fehlt')); return; }
        st.ziel = { ...z, pfad: zielOrdner(st.quelle) };
        fz.leeren(); st.schritt = 2; zeichnen();
      }),
    ];
  }

  function schrittWann() {
    const uhr = eingabe({ typ: 'time', wert: st.uhrzeit });
    const tagWahl = auswahl({ optionen: TAGE.map(([d, k]) => ({ wert: String(d), text: t(k) })), wert: String(st.tag) });
    const zusatz = el('div', { klasse: 'sa-wann-zusatz' });
    const zeigen = (w) => {
      leeren(zusatz);
      if (w === 'woechentlich') zusatz.append(feld({ label: t('spiegelung.sa_tag'), erklaerung: t('spiegelung.sa_tag_info'), eingabe: tagWahl }));
      if (w !== 'aenderung') zusatz.append(feld({ label: t('spiegelung.sa_uhrzeit'), erklaerung: t('spiegelung.sa_uhrzeit_info'), eingabe: uhr }));
    };
    const wann = radiogruppe({ optionen: [
      { wert: 'taeglich', text: t('spiegelung.sa_taeglich'), erklaerung: t('spiegelung.sa_taeglich_info') },
      { wert: 'woechentlich', text: t('spiegelung.sa_woechentlich'), erklaerung: t('spiegelung.sa_woechentlich_info') },
      { wert: 'aenderung', text: t('spiegelung.ausloeser_aenderung'), erklaerung: t('spiegelung.sa_aenderung_info') },
    ], wert: st.wann, beiWechsel: zeigen });
    zeigen(st.wann);
    return [
      el('p', { klasse: 'erklaerung', text: t('spiegelung.sa_wann_erklaerung') }), wann.element, zusatz,
      fuss(t('spiegelung.sa_weiter'), () => {
        st.wann = wann.wert() || 'taeglich';
        if (st.wann !== 'aenderung' && !/^\d{2}:\d{2}$/.test(uhr.value)) { fz.zeigen(t('spiegelung.sa_uhrzeit_fehlt')); return; }
        st.uhrzeit = uhr.value || '03:00'; st.tag = Number(tagWahl.value);
        fz.leeren(); st.schritt = 3; zeichnen();
      }),
    ];
  }

  function schrittFertig() {
    const zielText = st.ziel.zugang ? `${(zugaenge.find((z) => z.id === st.ziel.zugang) || { name: '?' }).name}: ${st.ziel.freigabe}/${st.ziel.pfad}` : `${st.ziel.freigabe}/${st.ziel.pfad}`;
    const wannText = st.wann === 'aenderung' ? t('spiegelung.sa_zus_aenderung') : st.wann === 'woechentlich'
      ? t('spiegelung.sa_zus_woechentlich', { tag: t((TAGE.find(([d]) => d === st.tag) || TAGE[0])[1]), uhrzeit: st.uhrzeit }) : t('spiegelung.sa_zus_taeglich', { uhrzeit: st.uhrzeit });
    const snap = quelleIntern() && !planDa() ? schalter({ label: t('spiegelung.sa_schnappschuesse'), erklaerung: t('spiegelung.sa_schnappschuesse_info'), wert: st.schnappschuesse }) : null;
    const sofort = schalter({ label: t('spiegelung.sa_sofort'), erklaerung: t('spiegelung.sa_sofort_info'), wert: st.sofort });
    const versionen = versionenAuswahl(st.versionen_tage || 30, t);
    return [
      el('dl', { klasse: 'vw-kv sa-zusammenfassung' },
        el('dt', { text: t('spiegelung.sa_quelle') }), el('dd', { klasse: 'vw-mono', text: [st.quelle.freigabe, st.quelle.pfad].filter(Boolean).join('/') }),
        el('dt', { text: t('spiegelung.ziel') }), el('dd', { klasse: 'vw-mono', text: zielText }),
        el('dt', { text: t('spiegelung.sa_schritt_wann') }), el('dd', { text: wannText })),
      hinweis(t('spiegelung.sa_einseitig_info'), 'info'),
      quelleIntern() && planDa() ? hinweis(t('spiegelung.sa_plan_da'), 'info') : null,
      feld({ label: t('spiegelung.versionen_tage'), erklaerung: t('spiegelung.versionen_tage_erklaerung'), eingabe: versionen }),
      snap ? snap.element : null, sofort.element,
      fuss(t('spiegelung.sa_einrichten'), async () => {
        griff.beschaeftigt?.(true);
        try {
          const a = await api(ctx, 'spiegelung.speichern', auftragAus({ quelle: st.quelle, ziel: st.ziel, wann: st.wann, uhrzeit: st.uhrzeit, tag: st.tag, versionen_tage: Number(versionen.value) }));
          if (snap && snap.eingabe.checked) await api(ctx, 'snapshots.plan.setzen', { ziel: st.quelle.freigabe, ...SCHNAPPSCHUSS_VORSCHLAG }).catch((e) => melden(ctx, fehlerText(e), 'warnung'));
          if (sofort.eingabe.checked && a && a.id) await api(ctx, 'spiegelung.starten', { id: a.id }).catch((e) => melden(ctx, fehlerText(e), 'warnung'));
          melden(ctx, t('spiegelung.sa_fertig', { name: (a && a.name) || '' }), 'erfolg');
          griff.schliessen();
          if (fertig) fertig(a);
        } catch (e) { griff.beschaeftigt?.(false); fz.zeigen(fehlerText(e)); }
      }),
    ];
  }

  function zeichnen() {
    leeren(inhalt);
    const leiste = el('ol', { klasse: 'sa-schritte' }, schritte.map((s, i) => el('li', { klasse: i === st.schritt ? 'aktiv' : i < st.schritt ? 'erledigt' : '', text: t(s) })));
    const teile = [schrittQuelle, schrittZiel, schrittWann, schrittFertig][st.schritt]();
    inhalt.append(leiste, fz.element, ...teile.filter(Boolean));
    const erstes = inhalt.querySelector('select, input, .sa-wahl-knopf');
    if (erstes && erstes.focus) try { erstes.focus(); } catch { /* egal */ }
  }
  zeichnen();
  return griff;
}
