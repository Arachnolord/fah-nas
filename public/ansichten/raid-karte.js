// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Karte „Speicherverbünde (RAID)“ in der Ansicht Laufwerke: Verbünde mit Zustand (Wiederaufbau in Prozent), Platten,
// Platte ersetzen, Ersatzplatte, Datenprüfung, Löschen (mit Namensbestätigung) und Anlegen mit Kapazitätsrechnung.

import {
  el, leeren, eingabe, feld, auswahl, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel, api, fehlerText, melden, karte,
  aufgabeStarten, dialogOeffnen,
} from './verwaltung-hilfen.js';

export const STUFEN = Object.freeze({
  raid1: { min: 2, kap: (n, s) => s, aus: (n) => n - 1 },
  raid5: { min: 3, kap: (n, s) => (n - 1) * s, aus: () => 1 },
  raid6: { min: 4, kap: (n, s) => (n - 2) * s, aus: () => 2 },
  raid10: { min: 4, gerade: true, kap: (n, s) => (n / 2) * s, aus: () => 1 },
  raid0: { min: 2, kap: (n, s) => n * s, aus: () => 0 },
});
const STUFE_TEXT = Object.freeze({ raid0: 'laufwerke.raid_stufe_raid0', raid1: 'laufwerke.raid_stufe_raid1', raid5: 'laufwerke.raid_stufe_raid5', raid6: 'laufwerke.raid_stufe_raid6', raid10: 'laufwerke.raid_stufe_raid10' });
const STUFE_ERKL = Object.freeze({ raid0: 'laufwerke.raid_erkl_raid0', raid1: 'laufwerke.raid_erkl_raid1', raid5: 'laufwerke.raid_erkl_raid5', raid6: 'laufwerke.raid_erkl_raid6', raid10: 'laufwerke.raid_erkl_raid10' });
const ZUSTAND = Object.freeze({ ok: ['aktiv', 'laufwerke.raid_z_ok'], wiederaufbau: ['warnung', 'laufwerke.raid_z_wiederaufbau'], beeintraechtigt: ['fehler', 'laufwerke.raid_z_beeintraechtigt'], ausgefallen: ['fehler', 'laufwerke.raid_z_ausgefallen'], fehlt: ['fehler', 'laufwerke.raid_z_fehlt'], umbau: ['warnung', 'laufwerke.raid_z_umbau'] });
const GRUND = Object.freeze({ system: 'laufwerke.raid_grund_system', verbund: 'laufwerke.raid_grund_verbund', eingehaengt: 'laufwerke.raid_grund_eingehaengt' });

/** Nutzbare Kapazität und verkraftbare Ausfälle eines Vorschlags. */
export function vorschlag(stufe, groessen) {
  const s = STUFEN[stufe];
  if (!s || groessen.length < s.min || (s.gerade && groessen.length % 2)) return null;
  const kleinste = Math.min(...groessen);
  return { kapazitaet: s.kap(groessen.length, kleinste), ausfaelle: s.aus(groessen.length) };
}

export function karteRaid(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('laufwerke.raid_laden')));
  const element = karte(t('laufwerke.raid_titel'), el('p', { klasse: 'erklaerung', text: t('laufwerke.raid_erklaerung') }), inhalt);
  let stand = { verbuende: [], platten: [] };

  async function zeichnen() {
    try { stand = await api(ctx, 'raid.liste', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    const frei = (stand.platten || []).filter((p) => !p.grund);
    leeren(inhalt);
    for (const v of stand.verbuende || []) inhalt.appendChild(verbundZeile(v, frei));
    if (!(stand.verbuende || []).length) inhalt.appendChild(leerHinweis(t('laufwerke.raid_keine')));
    if (frei.length < 2) inhalt.appendChild(hinweis(t('laufwerke.raid_zu_wenig_platten'), 'info'));
    inhalt.appendChild(el('div', { klasse: 'vw-knopfleiste' }, knopf(t('laufwerke.raid_neu'), { deaktiviert: frei.length < 2, beiKlick: () => neuDialog(frei) })));
  }

  function verbundZeile(v, frei) {
    const [amp, ztext] = ZUSTAND[v.zustand] || ZUSTAND.fehlt;
    const f = v.fortschritt;
    const zustandText = v.zustand === 'wiederaufbau' && f ? t('laufwerke.raid_z_wiederaufbau_prozent', { prozent: Math.round(f.prozent), min: f.rest_min ?? '?' })
      : v.zustand === 'umbau' && f ? t('laufwerke.raid_z_umbau_prozent', { prozent: Math.round(f.prozent), min: f.rest_min ?? '?' }) : t(ztext);
    const nebenbei = f && v.zustand === 'ok' ? t(f.art === 'check' ? 'laufwerke.raid_pruefung_laeuft' : 'laufwerke.raid_abgleich_laeuft', { prozent: Math.round(f.prozent) }) : null;
    const platten = el('ul', { klasse: 'sy-meldungen lw-raid-platten', role: 'list' }, (v.geraete || []).map((g) => el('li', {},
      ampel(/faulty|removed/.test(g.rolle) ? 'fehler' : /spare/.test(g.rolle) ? 'inaktiv' : /rebuild/.test(g.rolle) ? 'warnung' : 'aktiv'),
      ` ${g.pfad || t('laufwerke.raid_entfernt')} · ${rolleText(g.rolle)}`)));
    const knoepfe = [];
    if (v.stufe !== 'raid0' && (v.zustand === 'beeintraechtigt') && frei.length) knoepfe.push(knopf(t('laufwerke.raid_ersetzen'), { klein: true, beiKlick: () => ersetzenDialog(v, frei) }));
    if (v.stufe !== 'raid0' && frei.length) knoepfe.push(knopf(t('laufwerke.raid_ersatz'), { art: 'zweit', klein: true, beiKlick: () => ersatzDialog(v, frei) }));
    if (v.stufe !== 'raid0' && v.zustand === 'ok' && !f) knoepfe.push(knopf(t('laufwerke.raid_pruefen'), { art: 'zweit', klein: true, beiKlick: async () => { try { await api(ctx, 'raid.pruefen', { name: v.name }); melden(ctx, t('laufwerke.raid_pruefung_gestartet'), 'erfolg'); await zeichnen(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); } } }));
    // Erweitern (12.10.2026): Platten dazu, RAID 1 → RAID 5; größere Platten nutzen
    if (['raid1', 'raid5', 'raid6'].includes(v.stufe) && v.zustand === 'ok' && !f && frei.length) knoepfe.push(knopf(t('laufwerke.raid_erweitern'), { klein: true, beiKlick: () => erweiternDialog(v, frei) }));
    if (v.vergroesserbar) knoepfe.push(knopf(t('laufwerke.raid_vergroessern'), { klein: true, beiKlick: async () => {
      if (typeof ctx.bestaetigen === 'function' && !(await ctx.bestaetigen(t('laufwerke.raid_vergroessern_frage', { name: v.name })))) return;
      try { await api(ctx, 'raid.vergroessern', { name: v.name }); melden(ctx, t('laufwerke.raid_vergroessern_laeuft'), 'erfolg'); await zeichnen(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    } }));
    knoepfe.push(knopf(t('laufwerke.raid_loeschen'), { art: 'gefahr', klein: true, beiKlick: () => loeschenDialog(v) }));
    return el('section', { klasse: 'lw-raid' },
      el('div', { klasse: 'lw-raid-kopf' }, ampel(amp, t(ztext)), el('strong', { text: v.name }), badge(t(STUFE_TEXT[v.stufe] || STUFE_TEXT.raid1)), el('span', { text: zustandText })),
      el('p', { klasse: 'erklaerung', text: [v.platz ? t('laufwerke.raid_platz', { belegt: fmt.groesse(v.platz.gesamt - v.platz.frei), gesamt: fmt.groesse(v.platz.gesamt) }) : (v.eingehaengt ? '' : t('laufwerke.raid_nicht_eingehaengt')), nebenbei].filter(Boolean).join(' · ') }),
      platten, el('div', { klasse: 'vw-knopfleiste' }, knoepfe));
  }

  function rolleText(rolle) {
    if (/faulty/.test(rolle)) return t('laufwerke.raid_rolle_defekt');
    if (/rebuild/.test(rolle)) return t('laufwerke.raid_rolle_aufbau');
    if (/spare/.test(rolle)) return t('laufwerke.raid_rolle_ersatz');
    if (/removed/.test(rolle)) return t('laufwerke.raid_entfernt');
    return t('laufwerke.raid_rolle_aktiv');
  }
  const plattenText = (p) => `${p.name} · ${p.modell || '?'} · ${fmt.groesse(p.groesse)}${p.art ? ` · ${p.art.toUpperCase()}` : ''}`;

  function neuDialog(frei, vorwahl = []) {
    const fz = fehlerzeile();
    const name = eingabe({ platzhalter: 'daten', maxlength: 32, spellcheck: false });
    const stufe = auswahl({ optionen: Object.keys(STUFEN).map((s) => ({ wert: s, text: t(STUFE_TEXT[s]) })), wert: frei.length >= 3 ? 'raid5' : 'raid1' });
    const stufeErkl = el('p', { klasse: 'erklaerung' });
    const kaesten = frei.map((p) => { const k = el('input', { typ: 'checkbox' }); k.checked = vorwahl.includes(p.name); return { p, k, element: el('label', { klasse: 'lw-raid-wahl' }, k, el('span', { text: plattenText(p) })) }; });
    const gesperrt = (stand.platten || []).filter((p) => p.grund).map((p) => el('li', { klasse: 'vw-gedaempft', text: `${plattenText(p)} – ${t(GRUND[p.grund] || GRUND.eingehaengt)}` }));
    const rechnung = el('p', { klasse: 'erklaerung lw-raid-rechnung', attr: { 'aria-live': 'polite' } });
    const bestaetigung = eingabe({ maxlength: 32, spellcheck: false, autocomplete: 'off' });
    const neuRechnen = () => {
      stufeErkl.textContent = t(STUFE_ERKL[stufe.value]);
      const g = kaesten.filter((x) => x.k.checked).map((x) => x.p.groesse);
      const s = STUFEN[stufe.value];
      const v = vorschlag(stufe.value, g);
      rechnung.textContent = v ? t('laufwerke.raid_rechnung', { kapazitaet: fmt.groesse(v.kapazitaet), ausfaelle: v.ausfaelle }) : t(s.gerade ? 'laufwerke.raid_mindestens_gerade' : 'laufwerke.raid_mindestens', { n: s.min });
    };
    stufe.addEventListener('change', neuRechnen); for (const x of kaesten) x.k.addEventListener('change', neuRechnen); neuRechnen();
    dialogOeffnen({
      ctx, titel: t('laufwerke.raid_neu'), breit: true, schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', { klasse: 'lw-raid-formular' },
        feld({ label: t('laufwerke.raid_name'), erklaerung: t('laufwerke.raid_name_erklaerung'), eingabe: name }),
        feld({ label: t('laufwerke.raid_stufe'), eingabe: stufe }), stufeErkl,
        el('p', { klasse: 'vw-label', text: t('laufwerke.raid_platten') }), el('div', { klasse: 'lw-raid-wahlen' }, kaesten.map((x) => x.element)),
        gesperrt.length ? el('details', {}, el('summary', { text: t('laufwerke.raid_gesperrt') }), el('ul', {}, gesperrt)) : null,
        rechnung, hinweis(t('laufwerke.raid_warnung_loeschen'), 'warnung'),
        feld({ label: t('laufwerke.raid_bestaetigung'), erklaerung: t('laufwerke.raid_bestaetigung_erklaerung'), eingabe: bestaetigung }), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.raid_anlegen'), art: 'gefahr', beiKlick: async (g) => {
          fz.leeren(); g.beschaeftigt(true);
          try {
            await aufgabeStarten(ctx, 'raid.anlegen', { name: name.value.trim().toLowerCase(), stufe: stufe.value, platten: kaesten.filter((x) => x.k.checked).map((x) => x.p.name), bestaetigung: bestaetigung.value.trim().toLowerCase() },
              { titel: t('laufwerke.raid_neu'), meldung: t('laufwerke.raid_anlegen_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); melden(ctx, t('laufwerke.raid_angelegt'), 'erfolg'); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  function plattenDialog(titel, erkl, frei, mitAlt, v, aktion) {
    const fz = fehlerzeile();
    const neu = auswahl({ optionen: frei.map((p) => ({ wert: p.name, text: plattenText(p) })) });
    const defekt = (v.geraete || []).filter((g) => /faulty/.test(g.rolle) && g.pfad);
    const alt = mitAlt && defekt.length ? auswahl({ optionen: defekt.map((g) => ({ wert: g.pfad.replace('/dev/', ''), text: g.pfad })) }) : null;
    dialogOeffnen({
      ctx, titel, schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {}, el('p', { klasse: 'erklaerung', text: erkl }), alt ? feld({ label: t('laufwerke.raid_alte_platte'), eingabe: alt }) : null, feld({ label: t('laufwerke.raid_neue_platte'), eingabe: neu }), hinweis(t('laufwerke.raid_warnung_neue'), 'warnung'), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: titel, beiKlick: async (g) => {
          fz.leeren(); g.beschaeftigt(true);
          try { await aktion({ name: v.name, neu: neu.value, ...(alt ? { alt: alt.value } : {}) }); g.schliessen(); await zeichnen(); } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }
  const ersetzenDialog = (v, frei) => plattenDialog(t('laufwerke.raid_ersetzen'), t('laufwerke.raid_ersetzen_erklaerung'), frei, true, v,
    (d) => aufgabeStarten(ctx, 'raid.platte_ersetzen', d, { titel: t('laufwerke.raid_ersetzen'), meldung: t('laufwerke.raid_ersetzen_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') }));
  const ersatzDialog = (v, frei) => plattenDialog(t('laufwerke.raid_ersatz'), t('laufwerke.raid_ersatz_erklaerung'), frei, false, v, (d) => api(ctx, 'raid.ersatz_hinzufuegen', d));

  /** Erweitern: neue Platten wählen; ein RAID 1 aus zwei Platten wird dabei zu RAID 5 (mehr Platz) oder bekommt einen Spiegel mehr. */
  function erweiternDialog(v, frei) {
    const fz = fehlerzeile();
    const gesamt = (v.geraete || []).filter((g) => g.pfad && /active|sync/.test(g.rolle)).length;
    const kaesten = frei.map((p) => { const k = el('input', { typ: 'checkbox' }); return { p, k, element: el('label', { klasse: 'lw-raid-wahl' }, k, el('span', { text: plattenText(p) })) }; });
    const umbauMoeglich = v.stufe === 'raid1' && gesamt === 2;
    const ziel = umbauMoeglich ? auswahl({ optionen: [{ wert: 'raid5', text: t('laufwerke.raid_erweitern_zu_raid5') }, { wert: 'raid1', text: t('laufwerke.raid_erweitern_spiegel') }], wert: 'raid5' }) : null;
    const rechnung = el('p', { klasse: 'lw-raid-rechnung' });
    const bestaetigung = eingabe({ maxlength: 32, spellcheck: false, autocomplete: 'off' });
    const groessen = (v.platten || []).map((p) => p.groesse || 0).filter(Boolean);
    const neuRechnen = () => {
      const neu = kaesten.filter((x) => x.k.checked).map((x) => x.p.groesse);
      const stufe = ziel ? ziel.value : v.stufe;
      const vs = vorschlag(stufe, [...groessen.slice(0, gesamt), ...neu]);
      rechnung.textContent = neu.length && vs ? t('laufwerke.raid_rechnung', { kapazitaet: fmt.groesse(vs.kapazitaet), ausfaelle: vs.ausfaelle }) : t('laufwerke.raid_erweitern_waehlen');
    };
    for (const x of kaesten) x.k.addEventListener('change', neuRechnen); if (ziel) ziel.addEventListener('change', neuRechnen); neuRechnen();
    dialogOeffnen({
      ctx, titel: t('laufwerke.raid_erweitern_titel', { name: v.name }), breit: true, schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', { klasse: 'lw-raid-formular' }, el('p', { klasse: 'erklaerung', text: t('laufwerke.raid_erweitern_erklaerung') }),
        ziel ? feld({ label: t('laufwerke.raid_erweitern_art'), erklaerung: t('laufwerke.raid_erweitern_art_erklaerung'), eingabe: ziel }) : null,
        el('p', { klasse: 'vw-label', text: t('laufwerke.raid_platten') }), el('div', { klasse: 'lw-raid-wahlen' }, kaesten.map((x) => x.element)),
        rechnung, hinweis(t('laufwerke.raid_warnung_neue'), 'warnung'),
        feld({ label: t('laufwerke.raid_bestaetigung'), erklaerung: t('laufwerke.raid_bestaetigung_erklaerung'), eingabe: bestaetigung }), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.raid_erweitern'), art: 'gefahr', beiKlick: async (g) => {
          fz.leeren(); g.beschaeftigt(true);
          try {
            await aufgabeStarten(ctx, 'raid.erweitern', { name: v.name, platten: kaesten.filter((x) => x.k.checked).map((x) => x.p.name), ...(ziel ? { stufe: ziel.value } : {}), bestaetigung: bestaetigung.value.trim() },
              { titel: t('laufwerke.raid_erweitern'), meldung: t('laufwerke.raid_erweitern_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); melden(ctx, t('laufwerke.raid_erweitern_gestartet'), 'erfolg'); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  function loeschenDialog(v) {
    const fz = fehlerzeile();
    const bestaetigung = eingabe({ maxlength: 32, spellcheck: false, autocomplete: 'off' });
    dialogOeffnen({
      ctx, titel: t('laufwerke.raid_loeschen_titel', { name: v.name }), schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {}, hinweis(t('laufwerke.raid_loeschen_warnung', { name: v.name }), 'fehler'), feld({ label: t('laufwerke.raid_bestaetigung'), erklaerung: t('laufwerke.raid_bestaetigung_erklaerung'), eingabe: bestaetigung }), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.raid_loeschen'), art: 'gefahr', beiKlick: async (g) => {
          fz.leeren(); g.beschaeftigt(true);
          try { await aufgabeStarten(ctx, 'raid.loeschen', { name: v.name, bestaetigung: bestaetigung.value.trim() }, { titel: t('laufwerke.raid_loeschen'), meldung: t('laufwerke.raid_loeschen_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') }); g.schliessen(); melden(ctx, t('laufwerke.raid_geloescht', { name: v.name }), 'erfolg'); await zeichnen(); } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  /** Einstieg aus „Neue Platte erkannt“ (Laufwerke): Neu-Dialog mit dieser Platte vorgewählt. */
  element.neuMitPlatte = async (name) => {
    await zeichnen();
    const frei = (stand.platten || []).filter((p) => !p.grund);
    if (!frei.some((p) => p.name === name) || frei.length < 2) { melden(ctx, t('laufwerke.raid_zu_wenig_platten'), 'info'); return; }
    neuDialog(frei, [name]);
  };
  zeichnen();
  const takt = setInterval(() => { if (!element.isConnected) { clearInterval(takt); return; } if (!document.hidden && (stand.verbuende || []).some((v) => v.fortschritt)) zeichnen(); }, 10_000);
  return element;
}
