// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dialog „Docker vom alten NAS übernehmen“ (Betreiber 19.10.2026): alte Docker-Ablage lesen (apps.uebernahme.suchen),
// je Compose-Projekt Häkchen, App-Name, Autostart und je Volume „Daten übernehmen“ → apps.uebernahme.starten.
// Die alte Ablage bleibt unverändert; Images lädt Docker neu, Volumes werden kopiert.

import {
  el, eingabe, feld, fehlerzeile, hinweis, leerHinweis, badge, fehlerText, melden, aufgabeStarten, dialogOeffnen,
} from './verwaltung-hilfen.js';

const NAME_APP = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Ist ein Projekt übernehmbar? → null oder Grund-Schlüssel */
export function sperrgrund(pr) {
  if (pr.schon_uebernommen) return 'ue_schon';
  if (pr.laeuft_hier) return 'ue_laeuft_hier';
  if (!(pr.dateien || []).length) return 'ue_keine_compose';
  if ((pr.fehlende_pfade || []).length) return 'ue_pfad_fehlt';
  if (!pr.dateien_da) return 'ue_compose_fehlt';
  return null;
}

/** Auftrag aus dem Formular: [{projekt, name, autostart, leer}] + Namensfehler. */
export function uebernahmeAuftrag(zustaende, belegt = new Set()) {
  const namen = new Set(); const fehler = [];
  const projekte = zustaende.filter((z) => z.gewaehlt).map((z) => {
    const name = String(z.name || '').trim();
    if (!NAME_APP.test(name)) fehler.push({ projekt: z.projekt, grund: 'ue_name_ungueltig' });
    else if (belegt.has(name) || namen.has(name)) fehler.push({ projekt: z.projekt, grund: 'ue_name_belegt' });
    namen.add(name);
    return { projekt: z.projekt, name, autostart: !!z.autostart, leer: [...z.leer] };
  });
  return { projekte, fehler };
}

export async function dialogUebernahme(ctx, t, fmt, { belegt = [], nachher } = {}) {
  let r;
  try {
    r = await aufgabeStarten(ctx, 'apps.uebernahme.suchen', {}, { titel: t('apps.ue_titel'), meldung: t('apps.ue_suchen_laeuft'), abbrechen: t('apps.abbrechen'), schliessen: t('apps.schliessen') });
  } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') melden(ctx, fehlerText(e), 'fehler'); return; }
  const ablagen = (r && r.ablagen) || [];
  const fz = fehlerzeile();
  const teile = [hinweis(t('apps.ue_sicher'), 'info')];
  // Platz im Docker-Speicher: Summe der gewählten Volumes gegen „frei“ (sonst läuft die kleine Systemplatte voll)
  const platz = r && r.docker_platz;
  const platzZeile = platz && Number.isFinite(platz.frei) ? el('p', { klasse: 'erklaerung', text: t(r.docker_auf_volume ? 'apps.ue_platz_volume' : 'apps.ue_platz_system', { frei: fmt.groesse(platz.frei), pfad: platz.pfad }) }) : null;
  if (platzZeile) teile.push(platzZeile);
  const formular = []; // [{volume, zustaende}]
  if (!ablagen.length) teile.push(leerHinweis(t('apps.ue_keine_ablage')));
  for (const a of ablagen) {
    const zustaende = [];
    const sektion = el('section', { klasse: 'ap-ue-ablage' }, el('h3', { text: t('apps.ue_ablage', { name: a.bezeichnung }) }));
    for (const pr of a.projekte || []) {
      const grund = sperrgrund(pr);
      const z = { projekt: pr.projekt, name: pr.name_vorschlag, gewaehlt: !grund, autostart: !!pr.autostart, leer: new Set() };
      zustaende.push(z);
      const haken = el('input', { typ: 'checkbox', attr: { 'aria-label': t('apps.ue_projekt_waehlen', { projekt: pr.projekt }) } });
      haken.checked = z.gewaehlt; haken.disabled = !!grund;
      const name = eingabe({ wert: pr.name_vorschlag, maxlength: 31, spellcheck: false, autocomplete: 'off' });
      name.disabled = !!grund;
      name.addEventListener('input', () => { z.name = name.value.trim().toLowerCase(); });
      const auto = el('input', { typ: 'checkbox' }); auto.checked = z.autostart; auto.disabled = !!grund;
      auto.addEventListener('change', () => { z.autostart = auto.checked; });
      const vols = (pr.volumes || []).map((v) => {
        const vh = el('input', { typ: 'checkbox' }); vh.checked = true; vh.disabled = !!grund;
        vh.addEventListener('change', () => { if (vh.checked) z.leer.delete(v.name); else z.leer.add(v.name); });
        return el('label', { klasse: 'ap-ue-volume' }, vh,
          el('span', { klasse: 'vw-mono', text: v.anonym ? t('apps.ue_volume_anonym', { kurz: v.name.slice(0, 12) }) : v.name }),
          el('span', { klasse: 'vw-gedaempft', text: v.groesse != null ? fmt.groesse(v.groesse) : '?' }));
      });
      const zeile = el('div', { klasse: `ap-ue-projekt${grund ? ' aus' : ''}` },
        el('label', { klasse: 'ap-ue-wahl' }, haken, el('strong', { text: pr.projekt }),
          pr.laeuft ? badge(t('apps.ue_lief'), t('apps.ue_lief_titel')) : null, grund ? badge(t(`apps.${grund}`), undefined, 'warnung') : null),
        el('p', { klasse: 'erklaerung vw-mono', text: (pr.dateien || []).join(', ') || '–' }),
        el('p', { klasse: 'erklaerung', text: t('apps.ue_dienste', { liste: (pr.dienste || []).join(', ') || '–', images: (pr.images || []).join(', ') || '–' }) }),
        (pr.fehlende_pfade || []).length ? hinweis(t('apps.ue_pfad_fehlt_text', { liste: pr.fehlende_pfade.join(', ') }), 'warnung') : null,
        feld({ label: t('apps.ue_name'), erklaerung: t('apps.ue_name_erklaerung'), eingabe: name }),
        el('label', { klasse: 'ap-ue-option' }, auto, el('span', { text: t('apps.ue_autostart') }), el('span', { klasse: 'erklaerung', text: t('apps.ue_autostart_erklaerung') })),
        vols.length ? el('div', { klasse: 'ap-ue-volumes' }, el('p', { klasse: 'erklaerung', text: t('apps.ue_volumes_erklaerung') }), ...vols) : null,
        [...(pr.warnungen || []), ...(pr.hinweise || [])].length ? el('p', { klasse: 'erklaerung vw-gedaempft', text: [...(pr.warnungen || []), ...(pr.hinweise || [])].join(' · ') }) : null);
      haken.addEventListener('change', () => { z.gewaehlt = haken.checked; zeile.classList.toggle('aus', !haken.checked); });
      sektion.appendChild(zeile);
    }
    if (!(a.projekte || []).length) sektion.appendChild(leerHinweis(t('apps.ue_keine_projekte')));
    if ((a.einzeln || []).length) sektion.appendChild(el('p', { klasse: 'erklaerung vw-gedaempft', text: t('apps.ue_einzeln', { liste: a.einzeln.map((x) => `${x.name} (${x.image})`).join(', ') }) }));
    formular.push({ volume: a.volume, zustaende });
    teile.push(sektion);
  }
  teile.push(fz.element);
  dialogOeffnen({
    ctx, titel: t('apps.ue_titel'), breit: true, schliessenText: t('apps.schliessen'),
    inhalt: el('div', { klasse: 'ap-ue' }, ...teile),
    knoepfe: [
      { text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
      ...(ablagen.length ? [{ text: t('apps.ue_starten'), beiKlick: async (g) => {
        fz.leeren();
        const auftraege = [];
        const vergeben = new Set(belegt);
        for (const f of formular) {
          const { projekte, fehler } = uebernahmeAuftrag(f.zustaende, vergeben);
          if (fehler.length) { fz.zeigen(t(`apps.${fehler[0].grund}`, { projekt: fehler[0].projekt })); return; }
          for (const p of projekte) vergeben.add(p.name);
          if (projekte.length) auftraege.push({ volume: f.volume, projekte });
        }
        if (!auftraege.length) { fz.zeigen(t('apps.ue_nichts_gewaehlt')); return; }
        const noetig = summeVolumes(ablagen, formular);
        if (platz && Number.isFinite(platz.frei) && platz.frei < noetig * 1.05 + 1024 ** 3) { fz.zeigen(t('apps.ue_platz_zu_wenig', { frei: fmt.groesse(platz.frei), noetig: fmt.groesse(noetig) })); return; }
        g.beschaeftigt(true);
        const ergebnisse = [];
        try {
          for (const a of auftraege) {
            ergebnisse.push(await aufgabeStarten(ctx, 'apps.uebernahme.starten', a, { titel: t('apps.ue_titel'), meldung: t('apps.ue_laeuft'), abbrechen: t('apps.abbrechen'), schliessen: t('apps.schliessen') }));
          }
          g.schliessen(); ergebnisZeigen(ctx, t, ergebnisse); if (nachher) await nachher();
        } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
      } }] : []),
    ],
  });
}

/** Größe aller gewählten (zu kopierenden) Volumes. */
export function summeVolumes(ablagen, formular) {
  let n = 0;
  for (const f of formular) {
    const a = ablagen.find((x) => x.volume === f.volume);
    for (const z of f.zustaende.filter((x) => x.gewaehlt)) {
      const pr = (a?.projekte || []).find((p) => p.projekt === z.projekt);
      for (const v of pr?.volumes || []) if (!z.leer.has(v.name)) n += Number(v.groesse) || 0;
    }
  }
  return n;
}

function ergebnisZeigen(ctx, t, ergebnisse) {
  const teile = [];
  for (const erg of ergebnisse) {
    for (const u of (erg && erg.uebernommen) || []) {
      teile.push(hinweis(u.start_fehler ? t('apps.ue_ok_start_fehler', { name: u.name, fehler: u.start_fehler }) : t(u.gestartet ? 'apps.ue_ok_gestartet' : 'apps.ue_ok', { name: u.name }), u.start_fehler ? 'warnung' : 'erfolg'));
      if ((u.hinweise || []).length) teile.push(el('p', { klasse: 'erklaerung vw-gedaempft', text: u.hinweise.join(' · ') }));
    }
    for (const f of (erg && erg.fehler) || []) teile.push(hinweis(`${f.projekt}: ${f.meldung}`, 'fehler'));
  }
  if (!teile.length) teile.push(leerHinweis(t('apps.ue_nichts_gewaehlt')));
  teile.push(el('p', { klasse: 'erklaerung', text: t('apps.ue_fertig_tipp') }));
  dialogOeffnen({ ctx, titel: t('apps.ue_titel'), inhalt: el('div', {}, ...teile), schliessenText: t('apps.schliessen'), knoepfe: [{ text: t('apps.schliessen'), beiKlick: (g) => g.schliessen() }] });
}
