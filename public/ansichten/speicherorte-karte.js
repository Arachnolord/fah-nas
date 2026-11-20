// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Karte „Speicherorte“ in der Ansicht Laufwerke (Betreiber 19.10.2026): wo Docker, Apps und VMs liegen – Systemplatte
// oder ein übernommenes Volume – und Umziehen (mit Platzprüfung; Docker hält dabei an). Der alte Stand auf der
// Systemplatte bleibt als Rückweg, bis man ihn bewusst löscht.

import {
  el, leeren, eingabe, auswahl, feld, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel, api, fehlerText, melden, karte,
  aufgabeStarten, dialogOeffnen,
} from './verwaltung-hilfen.js';

/** Platztext „frei 120 GB von 1 TB“ (oder leer). */
export function platzText(p, fmt, t) {
  return p && Number.isFinite(p.frei) && Number.isFinite(p.gesamt) ? t('laufwerke.ort_platz', { frei: fmt.groesse(p.frei), gesamt: fmt.groesse(p.gesamt) }) : '';
}

export function karteSpeicherorte(ctx, t, fmt) {
  const inhalt = el('div', { klasse: 'lw-orte' });
  const k = karte(t('laufwerke.ort_titel'), el('p', { klasse: 'erklaerung', text: t('laufwerke.ort_erklaerung') }), inhalt);

  async function zeichnen() {
    let r;
    try { r = await api(ctx, 'speicherorte.liste', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    leeren(inhalt);
    const ziele = (r.ziele || []).filter((z) => z.eingehaengt);
    for (const b of r.bereiche || []) {
      const ort = b.ort === 'volume' ? t('laufwerke.ort_auf_volume', { name: b.bezeichnung || b.volume }) : t('laufwerke.ort_system');
      const zustand = b.ort === 'volume' && !b.aktiv ? 'fehler' : 'aktiv';
      const knoepfe = [knopf(t('laufwerke.ort_umziehen'), { art: 'zweit', klein: true, deaktiviert: !ziele.length && b.ort === 'system', titel: !ziele.length && b.ort === 'system' ? t('laufwerke.ort_kein_ziel') : undefined, beiKlick: () => umziehen(b, r) })];
      if (b.alter_stand && b.aktiv) knoepfe.push(knopf(t('laufwerke.ort_alt_loeschen'), { art: 'gefahr', klein: true, titel: t('laufwerke.ort_alt_loeschen_titel'), beiKlick: () => altLoeschen(b) }));
      inhalt.appendChild(el('section', { klasse: 'lw-raid lw-ort', daten: { bereich: b.bereich } },
        el('div', { klasse: 'lw-raid-kopf' }, ampel(zustand, ort), el('strong', { text: t(`laufwerke.ort_${b.bereich}`) }), badge(ort), el('span', { klasse: 'vw-mono vw-gedaempft', text: b.pfad })),
        el('p', { klasse: 'erklaerung', text: t(`laufwerke.ort_${b.bereich}_erklaerung`) }),
        b.ort === 'volume' && !b.aktiv ? hinweis(t('laufwerke.ort_nicht_aktiv'), 'fehler') : null,
        platzText(b.platz, fmt, t) ? el('p', { klasse: 'erklaerung', text: platzText(b.platz, fmt, t) }) : null,
        el('div', { klasse: 'vw-knopfleiste' }, ...knoepfe)));
    }
    if (!(r.ziele || []).length) inhalt.appendChild(leerHinweis(t('laufwerke.ort_keine_volumes')));
  }

  function umziehen(b, r) {
    const fz = fehlerzeile();
    const optionen = [
      ...(b.ort === 'volume' ? [{ wert: 'system', text: t('laufwerke.ort_system_ziel', { platz: platzText(r.system, fmt, t) }) }] : []),
      ...(r.ziele || []).filter((z) => z.eingehaengt && z.uuid !== b.volume).map((z) => ({ wert: z.uuid, text: `${z.bezeichnung}${platzText(z.platz, fmt, t) ? ` · ${platzText(z.platz, fmt, t)}` : ''}` })),
    ];
    if (!optionen.length) { melden(ctx, t('laufwerke.ort_kein_ziel'), 'warnung'); return; }
    const wahl = auswahl({ optionen, wert: optionen[0].wert });
    dialogOeffnen({
      ctx, titel: t('laufwerke.ort_umziehen_titel', { bereich: t(`laufwerke.ort_${b.bereich}`) }), schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {},
        feld({ label: t('laufwerke.ort_ziel'), erklaerung: t('laufwerke.ort_ziel_erklaerung'), eingabe: wahl }),
        hinweis(t(b.bereich === 'vms' ? 'laufwerke.ort_vms_aus' : 'laufwerke.ort_docker_haelt'), 'warnung'),
        hinweis(t('laufwerke.ort_sicher'), 'info'), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.ort_umziehen'), beiKlick: async (g) => {
          g.beschaeftigt(true);
          try {
            await aufgabeStarten(ctx, 'speicherorte.setzen', { bereich: b.bereich, ziel: wahl.value }, { titel: t('laufwerke.ort_umziehen_titel', { bereich: t(`laufwerke.ort_${b.bereich}`) }), meldung: t('laufwerke.ort_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); melden(ctx, t('laufwerke.ort_fertig'), 'erfolg'); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  function altLoeschen(b) {
    const fz = fehlerzeile();
    const bestaetigung = eingabe({ wert: '', maxlength: 16, spellcheck: false, autocomplete: 'off' });
    dialogOeffnen({
      ctx, titel: t('laufwerke.ort_alt_loeschen'), schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {}, el('p', { text: t('laufwerke.ort_alt_loeschen_text', { bereich: t(`laufwerke.ort_${b.bereich}`) }) }),
        feld({ label: t('laufwerke.ort_alt_bestaetigen', { wort: b.bereich }), eingabe: bestaetigung }), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.ort_alt_loeschen'), art: 'gefahr', beiKlick: async (g) => {
          if (bestaetigung.value.trim() !== b.bereich) { fz.zeigen(t('laufwerke.ort_alt_bestaetigen', { wort: b.bereich })); return; }
          g.beschaeftigt(true);
          try {
            await aufgabeStarten(ctx, 'speicherorte.alt_loeschen', { bereich: b.bereich, bestaetigung: b.bereich }, { titel: t('laufwerke.ort_alt_loeschen'), meldung: t('laufwerke.ort_alt_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); melden(ctx, t('laufwerke.ort_alt_geloescht'), 'erfolg'); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  zeichnen();
  k.neuZeichnen = zeichnen;
  return k;
}
