// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Karte „Speicher aus einem anderen NAS übernehmen“ in der Ansicht Laufwerke (Betreiber 19.10.2026, Umstieg von UGOS):
// übernommene Volumes mit Zustand und Trennen; Assistent: Suchen (nur lesend) → je Ordner Häkchen, Freigabename und
// Rechte (aus dem UGOS-Export vorgeschlagen) → Besitzer-Zuordnung alt → neu → Bestätigung → Übernehmen (Aufgabe).
// Nie formatieren, nie löschen – das steht auch so im Dialog.
// 0.25.0: alter Pfad (/volumeN), Unterordner-Rechte als Ordnerrechte, App-Daten mit unveränderten Rechten, persönliche
// Ordner (@home) als persönliche FAH-NAS-Ordner, RAID der übernommenen Volumes (Prüfen, Platte ersetzen, Spiegel ergänzen).

import {
  el, leeren, eingabe, auswahl, feld, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel, api, fehlerText, melden, karte,
  aufgabeStarten, dialogOeffnen,
} from './verwaltung-hilfen.js';

export const MUSTER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVIERT = new Set(['global', 'homes', 'printers', 'alle', 'docker']);

/** Kurztext der Rechte eines Ordners: „schreiben: anna, @work · lesen: carl“ bzw. „nur Admins“. */
export function rechteKurz(r, t) {
  const teile = [];
  if (r.schreiben.length) teile.push(t('laufwerke.import_rechte_schreiben', { liste: r.schreiben.join(', ') }));
  if (r.lesen.length) teile.push(t('laufwerke.import_rechte_lesen', { liste: r.lesen.join(', ') }));
  return teile.join(' · ') || t('laufwerke.import_rechte_nur_admins');
}

/**
 * Parameter für importe.uebernehmen aus dem Formularzustand; prüft Namen (gültig, eindeutig, frei) und dass kein Nutzer
 * zwei persönliche Ordner bekommt. → {params, fehler}
 */
export function auftragBauen(volumes, besitzer, belegt = new Set()) {
  const namen = new Set(); const fehler = []; const heimNutzer = new Set();
  const aus = [];
  for (const v of volumes) {
    const ordner = v.ordner.filter((o) => o.gewaehlt).map((o) => {
      const name = String(o.name || '').trim();
      if (!MUSTER_NAME.test(name)) fehler.push({ ordner: o.ordner, grund: 'ungueltig' });
      else if (RESERVIERT.has(name) || belegt.has(name)) fehler.push({ ordner: o.ordner, grund: 'belegt' });
      else if (namen.has(name)) fehler.push({ ordner: o.ordner, grund: 'doppelt' });
      namen.add(name);
      const e = { ordner: o.ordner, name, lesen: [...o.lesen], schreiben: [...o.schreiben], papierkorb: true };
      if (o.rechte_lassen) { e.rechte_lassen = true; e.papierkorb = false; } else if (o.ordnerrechteAn && (o.ordnerrechte || []).length) e.ordnerrechte = o.ordnerrechte;
      return e;
    });
    const heime = (v.heime || []).filter((h) => h.gewaehlt && h.nutzer).map((h) => {
      if (heimNutzer.has(h.nutzer)) fehler.push({ ordner: h.ordner, grund: 'heim_doppelt' });
      heimNutzer.add(h.nutzer);
      return { ordner: h.ordner, nutzer: h.nutzer };
    });
    const eintrag = { uuid: v.uuid, ordner };
    if (v.alterPfadAn && v.alter_pfad) {
      if (!/^\/volume\d{1,2}$/.test(v.alter_pfad)) fehler.push({ ordner: v.alter_pfad, grund: 'alter_pfad' });
      eintrag.alter_pfad = v.alter_pfad;
    }
    if (heime.length) eintrag.heime = heime;
    if (ordner.length || heime.length || eintrag.alter_pfad) aus.push(eintrag);
  }
  return { params: { volumes: aus, besitzer: { ...besitzer } }, fehler };
}

/** Kurztext der Ordnerrechte aus UGOS: „UgreenNAS: conny kein Zugriff, media kein Zugriff“. */
export function ordnerrechteKurz(regeln, t) {
  return (regeln || []).map((r) => `${r.pfad}: ${Object.entries(r.regeln).map(([k, s]) => `${k} ${t(s === 'keiner' ? 'laufwerke.import_or_keiner' : 'laufwerke.import_or_lesen')}`).join(', ')}`).join(' · ');
}

export function karteImport(ctx, t, fmt) {
  const inhalt = el('div', { klasse: 'lw-import' });
  const k = karte(t('laufwerke.import_titel'), el('p', { klasse: 'erklaerung', text: t('laufwerke.import_erklaerung') }), inhalt);

  async function zeichnen() {
    let stand;
    try { stand = await api(ctx, 'importe.liste', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    leeren(inhalt);
    for (const v of stand.volumes || []) inhalt.appendChild(volumeZeile(v));
    if (!(stand.volumes || []).length) inhalt.appendChild(leerHinweis(t('laufwerke.import_keine')));
    inhalt.appendChild(el('div', { klasse: 'vw-knopfleiste' }, knopf(t('laufwerke.import_suchen'), { beiKlick: suchen })));
    inhalt.appendChild(el('p', { klasse: 'erklaerung', text: t('laufwerke.import_export_tipp') }));
  }

  function raidText(r) {
    if (!r) return null;
    const stufe = String(r.stufe || '').replace(/^raid/, 'RAID ');
    return r.degraded ? t('laufwerke.import_raid_beeintraechtigt', { stufe }) : t('laufwerke.import_raid_ok', { stufe });
  }

  function volumeZeile(v) {
    const r = v.raid;
    const defekt = (r?.mitglieder || []).some((m) => m.zustand === 'defekt');
    const zustand = !v.vorhanden ? 'fehler' : !v.eingehaengt ? 'warnung' : r?.degraded || defekt ? 'warnung' : 'aktiv';
    const ztext = !v.vorhanden ? t('laufwerke.import_fehlt') : !v.eingehaengt ? t('laufwerke.import_nicht_eingehaengt') : raidText(r) || t('laufwerke.import_eingehaengt');
    const knoepfe = [];
    const schutz = r && /^raid(1|4|5|6|10)$/.test(r.stufe || '');
    if (v.vorhanden && schutz && r.sync === 'idle') {
      knoepfe.push(knopf(t('laufwerke.import_raid_pruefen'), { art: 'zweit', klein: true, titel: t('laufwerke.import_raid_pruefen_titel'), beiKlick: () => raidPruefen(v) }));
      if (r.degraded || defekt) knoepfe.push(knopf(t('laufwerke.import_raid_ersetzen'), { klein: true, beiKlick: () => raidErsetzen(v, 'ersetzen') }));
      else if (r.stufe === 'raid1') knoepfe.push(knopf(t('laufwerke.import_raid_spiegel'), { art: 'zweit', klein: true, titel: t('laufwerke.import_raid_spiegel_titel'), beiKlick: () => raidErsetzen(v, 'spiegel') }));
    }
    knoepfe.push(knopf(t('laufwerke.import_trennen'), { art: 'gefahr', klein: true, beiKlick: () => trennen(v) }));
    const mitglieder = (r?.mitglieder || []).map((m) => `${m.geraet} ${t(`laufwerke.import_raid_m_${m.zustand}`)}`).join(' · ');
    const sync = r && r.sync && r.sync !== 'idle' ? t('laufwerke.import_raid_sync', { art: t(`laufwerke.import_raid_s_${['check', 'resync', 'recover', 'repair', 'reshape'].includes(r.sync) ? r.sync : 'sonst'}`), prozent: r.fortschritt != null ? Math.floor(r.fortschritt * 100) : '?' }) : null;
    return el('section', { klasse: 'lw-raid lw-import-volume' },
      el('div', { klasse: 'lw-raid-kopf' }, ampel(zustand, ztext), el('strong', { text: v.bezeichnung || v.uuid }), badge(String(v.fstype || '').toUpperCase()), el('span', { text: ztext })),
      el('p', { klasse: 'erklaerung', text: t('laufwerke.import_volume_freigaben', { liste: (v.freigaben || []).map((f) => f.name).join(', ') || '–' }) }),
      (v.heime || []).length ? el('p', { klasse: 'erklaerung', text: t('laufwerke.import_volume_heime', { liste: v.heime.map((h) => h.nutzer).join(', ') }) }) : null,
      v.alter_pfad ? el('p', { klasse: 'erklaerung', text: t(v.alter_pfad_aktiv ? 'laufwerke.import_alter_pfad_aktiv' : 'laufwerke.import_alter_pfad_inaktiv', { pfad: v.alter_pfad }) }) : null,
      mitglieder ? el('p', { klasse: 'erklaerung', text: t('laufwerke.import_raid_mitglieder', { liste: mitglieder }) }) : (v.platten || []).length ? el('p', { klasse: 'erklaerung', text: (v.platten || []).map((p) => `${p.geraet}${p.modell ? ` (${p.modell})` : ''}`).join(' · ') }) : null,
      sync ? el('p', { klasse: 'erklaerung', text: sync }) : null,
      el('div', { klasse: 'vw-knopfleiste' }, ...knoepfe));
  }

  async function raidPruefen(v) {
    try { await api(ctx, 'importe.raid.pruefen', { uuid: v.uuid }); melden(ctx, t('laufwerke.import_raid_pruefen_gestartet'), 'erfolg'); await zeichnen(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
  }

  /** Platte ersetzen oder (RAID 1) Spiegel ergänzen: freie Platte wählen, Namen eintippen – die Platte wird geleert. */
  async function raidErsetzen(v, modus) {
    let platten = [];
    try { platten = ((await api(ctx, 'raid.liste', {})).platten || []).filter((p) => !p.grund); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); return; }
    const fz = fehlerzeile();
    const defekte = (v.raid?.mitglieder || []).filter((m) => m.zustand === 'defekt');
    const wahl = auswahl({ optionen: platten.map((p) => ({ wert: p.name, text: `${p.name} · ${fmt.groesse(p.groesse)}${p.modell ? ` · ${p.modell}` : ''}` })), wert: platten[0]?.name || '' });
    const alt = defekte.length ? auswahl({ optionen: defekte.map((m) => ({ wert: m.geraet, text: m.geraet })), wert: defekte[0].geraet }) : null;
    const bestaetigung = eingabe({ wert: '', maxlength: 64, spellcheck: false, autocomplete: 'off' });
    dialogOeffnen({
      ctx, titel: t(modus === 'spiegel' ? 'laufwerke.import_raid_spiegel' : 'laufwerke.import_raid_ersetzen'), schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {},
        el('p', { text: t(modus === 'spiegel' ? 'laufwerke.import_raid_spiegel_text' : 'laufwerke.import_raid_ersetzen_text', { name: v.bezeichnung || v.uuid }) }),
        platten.length ? feld({ label: t('laufwerke.import_raid_neue_platte'), erklaerung: t('laufwerke.import_raid_neue_platte_erklaerung'), eingabe: wahl }) : hinweis(t('laufwerke.import_raid_keine_platte'), 'warnung'),
        alt ? feld({ label: t('laufwerke.import_raid_alte_platte'), erklaerung: t('laufwerke.import_raid_alte_platte_erklaerung'), eingabe: alt }) : null,
        hinweis(t('laufwerke.import_raid_loescht'), 'warnung'),
        feld({ label: t('laufwerke.import_raid_bestaetigen'), erklaerung: t('laufwerke.import_raid_bestaetigen_erklaerung'), eingabe: bestaetigung }), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        ...(platten.length ? [{ text: t(modus === 'spiegel' ? 'laufwerke.import_raid_spiegel' : 'laufwerke.import_raid_ersetzen'), art: 'gefahr', beiKlick: async (g) => {
          fz.leeren();
          if (bestaetigung.value.trim() !== wahl.value) { fz.zeigen(t('laufwerke.import_raid_bestaetigen_falsch', { name: wahl.value })); return; }
          g.beschaeftigt(true);
          try {
            await aufgabeStarten(ctx, 'importe.raid.ersetzen', { uuid: v.uuid, neu: wahl.value, bestaetigung: bestaetigung.value.trim(), ...(alt ? { alt: alt.value } : {}) },
              { titel: t('laufwerke.import_raid_ersetzen'), meldung: t('laufwerke.import_raid_ersetzen_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); melden(ctx, t('laufwerke.import_raid_ersetzen_fertig'), 'erfolg'); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } }] : []),
      ],
    });
  }

  async function trennen(v) {
    const fz = fehlerzeile();
    dialogOeffnen({
      ctx, titel: t('laufwerke.import_trennen'), schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', {}, el('p', { text: t('laufwerke.import_trennen_text', { name: v.bezeichnung || v.uuid, liste: (v.freigaben || []).map((f) => f.name).join(', ') || '–' }) }), hinweis(t('laufwerke.import_trennen_sicher'), 'info'), fz.element),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        { text: t('laufwerke.import_trennen'), art: 'gefahr', beiKlick: async (g) => {
          g.beschaeftigt(true);
          try { await api(ctx, 'importe.trennen', { uuid: v.uuid }); g.schliessen(); melden(ctx, t('laufwerke.import_getrennt'), 'erfolg'); await zeichnen(); } catch (e) { fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } },
      ],
    });
  }

  async function suchen() {
    let r;
    try {
      r = await aufgabeStarten(ctx, 'importe.suchen', {}, { titel: t('laufwerke.import_suchen'), meldung: t('laufwerke.import_suchen_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
    } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') melden(ctx, fehlerText(e), 'fehler'); return; }
    assistent(r || {});
  }

  function assistent(r) {
    const nutzer = (r.nutzer || []).filter((n) => n.rolle !== 'admin').map((n) => n.name);
    const konten = [...(r.gruppen || []).map((g) => `@${g}`), ...nutzer];
    const neue = (r.volumes || []).filter((v) => !v.importiert);
    const fz = fehlerzeile();
    const teile = [hinweis(t('laufwerke.import_sicher'), 'info')];
    const formular = [];
    const fehlendeKonten = new Set();
    if (!neue.length) teile.push(leerHinweis(t('laufwerke.import_nichts_gefunden')));
    for (const v of neue) {
      const kopf = el('div', { klasse: 'lw-raid-kopf' }, el('strong', { text: v.name || [v.herkunft || t('laufwerke.import_fremd'), v.lvm?.lv || v.geraet].join(' · ') }),
        badge(String(v.fstype || '').toUpperCase()), v.raid ? badge(String(v.raid.stufe).replace(/^raid/, 'RAID ')) : null,
        el('span', { text: v.groesse ? t('laufwerke.import_groesse', { gesamt: fmt.groesse(v.groesse), frei: v.frei != null ? fmt.groesse(v.frei) : '?' }) : '' }));
      const sektion = el('section', { klasse: 'lw-raid lw-import-volume' }, kopf,
        el('p', { klasse: 'erklaerung', text: (v.platten || []).map((p) => `${p.geraet}${p.modell ? ` (${p.modell})` : ''}`).join(' · ') }));
      if (v.raid_zustand?.degraded) sektion.appendChild(hinweis(t('laufwerke.import_raid_warnung'), 'warnung'));
      if (v.fehler) { sektion.appendChild(hinweis(t('laufwerke.import_volume_fehler', { fehler: v.fehler }), 'fehler')); teile.push(sektion); continue; }
      if (v.ugos_export?.passt) sektion.appendChild(hinweis(t('laufwerke.import_export_gefunden', { zeit: v.ugos_export.erstellt ? fmt.zeit(v.ugos_export.erstellt) : '?' }), 'erfolg'));
      else if (v.herkunft === 'UGOS') sektion.appendChild(hinweis(t('laufwerke.import_export_fehlt'), 'warnung'));
      const zustand = { uuid: v.uuid, ordner: [] };
      const liste = el('div', { klasse: 'lw-import-ordner' });
      for (const o of (v.ordner || []).filter((x) => x.art !== 'intern')) {
        const rechte = o.rechte || { lesen: [], schreiben: [], hinweise: [] };
        for (const h of rechte.hinweise || []) { const m = /„(.+?)“ gibt es auf FAH-NAS noch nicht/.exec(h); if (m) fehlendeKonten.add(m[1]); }
        const z = { ordner: o.name, name: o.vorschlag, gewaehlt: o.art === 'freigabe', lesen: new Set(rechte.lesen || []), schreiben: new Set(rechte.schreiben || []),
          rechte_lassen: !!o.app_daten, ordnerrechte: o.ordnerrechte || [], ordnerrechteAn: true };
        zustand.ordner.push(z);
        const haken = el('input', { typ: 'checkbox', attr: { 'aria-label': t('laufwerke.import_uebernehmen_fuer', { ordner: o.name }) } }); haken.checked = z.gewaehlt;
        const name = eingabe({ wert: o.vorschlag, maxlength: 32, spellcheck: false, autocomplete: 'off' });
        const kurz = el('span', { klasse: 'erklaerung lw-import-rechte-kurz', text: rechteKurz({ lesen: [...z.lesen], schreiben: [...z.schreiben] }, t) });
        const rechteListe = el('div', { klasse: 'lw-import-rechte' }, konten.map((konto) => {
          const s = auswahl({ optionen: [{ wert: '', text: t('laufwerke.import_recht_kein') }, { wert: 'lesen', text: t('laufwerke.import_recht_lesen') }, { wert: 'schreiben', text: t('laufwerke.import_recht_schreiben') }],
            wert: z.schreiben.has(konto) ? 'schreiben' : z.lesen.has(konto) ? 'lesen' : '' });
          s.setAttribute('aria-label', t('laufwerke.import_recht_fuer', { konto, ordner: o.name }));
          s.addEventListener('change', () => { z.lesen.delete(konto); z.schreiben.delete(konto); if (s.value === 'lesen') z.lesen.add(konto); if (s.value === 'schreiben') z.schreiben.add(konto); kurz.textContent = rechteKurz({ lesen: [...z.lesen], schreiben: [...z.schreiben] }, t); });
          return el('label', { klasse: 'lw-import-recht' }, el('span', { text: konto }), s);
        }));
        const details = el('details', { klasse: 'lw-import-details' }, el('summary', { text: t('laufwerke.import_rechte_aendern') }), el('p', { klasse: 'erklaerung', text: t('laufwerke.import_rechte_erklaerung') }), rechteListe);
        haken.addEventListener('change', () => { z.gewaehlt = haken.checked; zeile.classList.toggle('aus', !haken.checked); });
        name.addEventListener('input', () => { z.name = name.value.trim().toLowerCase(); });
        // App-Daten (Docker): Rechte und Besitzer bleiben – sonst starteten Datenbanken & Co. nicht mehr
        const lassen = el('input', { typ: 'checkbox' }); lassen.checked = z.rechte_lassen;
        const orHaken = el('input', { typ: 'checkbox' }); orHaken.checked = true;
        const orZeile = z.ordnerrechte.length ? el('label', { klasse: 'lw-import-option' }, orHaken,
          el('span', { text: t('laufwerke.import_or_uebernehmen', { anzahl: z.ordnerrechte.length }) }),
          el('span', { klasse: 'erklaerung', text: ordnerrechteKurz(z.ordnerrechte, t) })) : null;
        const orGesperrt = () => { orHaken.disabled = z.rechte_lassen; if (orZeile) orZeile.classList.toggle('aus', z.rechte_lassen); };
        lassen.addEventListener('change', () => { z.rechte_lassen = lassen.checked; orGesperrt(); });
        orHaken.addEventListener('change', () => { z.ordnerrechteAn = orHaken.checked; });
        orGesperrt();
        const lassenZeile = o.art === 'freigabe' ? el('label', { klasse: 'lw-import-option' }, lassen, el('span', { text: t('laufwerke.import_rechte_lassen') }),
          el('span', { klasse: 'erklaerung', text: t(o.app_daten ? 'laufwerke.import_rechte_lassen_app' : 'laufwerke.import_rechte_lassen_erklaerung') })) : null;
        const zeile = el('div', { klasse: `lw-import-zeile${z.gewaehlt ? '' : ' aus'}` },
          el('label', { klasse: 'lw-import-wahl' }, haken, el('strong', { text: o.name }), o.art === 'heim' ? badge(t('laufwerke.import_heim')) : null, o.app_daten ? badge(t('laufwerke.import_app_daten'), t('laufwerke.import_app_daten_titel')) : null, o.unterlaufwerk && v.fstype === 'btrfs' ? badge(t('laufwerke.import_schnappschuesse'), t('laufwerke.import_schnappschuesse_titel')) : null),
          feld({ label: t('laufwerke.import_freigabename'), erklaerung: t('laufwerke.import_freigabename_erklaerung'), eingabe: name }),
          kurz, (rechte.hinweise || []).length ? el('p', { klasse: 'erklaerung vw-gedaempft', text: rechte.hinweise.join(' · ') }) : null, lassenZeile, orZeile, details);
        liste.appendChild(zeile);
      }
      const intern = (v.ordner || []).filter((x) => x.art === 'intern').map((x) => x.name);
      sektion.appendChild(liste);
      // persönliche Ordner (@home/<name>) → persönlicher FAH-NAS-Ordner des gewählten Nutzers (eingebunden, nicht kopiert)
      zustand.heime = [];
      if ((v.heim || []).length) {
        const zeilen = v.heim.map((h) => {
          const hz = { ordner: h.ordner, nutzer: h.vorschlag || '', gewaehlt: !!h.vorschlag };
          zustand.heime.push(hz);
          const hk = el('input', { typ: 'checkbox', attr: { 'aria-label': t('laufwerke.import_heim_fuer', { ordner: h.name }) } }); hk.checked = hz.gewaehlt;
          const sel = auswahl({ optionen: [{ wert: '', text: t('laufwerke.import_heim_niemand') }, ...(r.nutzer || []).map((n) => ({ wert: n.name, text: n.name }))], wert: hz.nutzer });
          sel.setAttribute('aria-label', t('laufwerke.import_heim_nutzer', { ordner: h.name }));
          hk.addEventListener('change', () => { hz.gewaehlt = hk.checked; });
          sel.addEventListener('change', () => { hz.nutzer = sel.value; if (sel.value) { hz.gewaehlt = true; hk.checked = true; } });
          return el('div', { klasse: 'lw-import-heim' }, el('label', { klasse: 'lw-import-wahl' }, hk, el('strong', { text: h.ordner })), el('span', { text: '→' }), sel);
        });
        sektion.appendChild(el('div', { klasse: 'lw-import-heime' }, el('h4', { text: t('laufwerke.import_heime_titel') }), el('p', { klasse: 'erklaerung', text: t('laufwerke.import_heime_erklaerung') }), ...zeilen));
      }
      // alter Pfad (/volumeN): Compose-Dateien, Skripte und die Docker-Übernahme finden ihre Ordner unverändert
      zustand.alter_pfad = v.alter_pfad || ''; zustand.alterPfadAn = !!v.alter_pfad && v.alter_pfad_frei !== false;
      const apHaken = el('input', { typ: 'checkbox' }); apHaken.checked = zustand.alterPfadAn;
      const apFeld = eingabe({ wert: zustand.alter_pfad, maxlength: 12, spellcheck: false, autocomplete: 'off', platzhalter: '/volume1' });
      apHaken.addEventListener('change', () => { zustand.alterPfadAn = apHaken.checked; });
      apFeld.addEventListener('input', () => { zustand.alter_pfad = apFeld.value.trim(); if (zustand.alter_pfad) { zustand.alterPfadAn = true; apHaken.checked = true; } });
      sektion.appendChild(el('div', { klasse: 'lw-import-alterpfad' },
        el('label', { klasse: 'lw-import-option' }, apHaken, el('span', { text: t('laufwerke.import_alter_pfad') })), apFeld,
        el('p', { klasse: 'erklaerung', text: t('laufwerke.import_alter_pfad_erklaerung') }),
        v.alter_pfad_frei === false ? hinweis(t('laufwerke.import_alter_pfad_belegt', { pfad: v.alter_pfad }), 'warnung') : null));
      if (intern.length) sektion.appendChild(el('p', { klasse: 'erklaerung vw-gedaempft', text: t('laufwerke.import_intern', { liste: intern.join(', ') }) }));
      formular.push(zustand);
      teile.push(sektion);
    }
    // Besitzer alt → neu (über alle Volumes)
    const besitzer = new Map();
    for (const v of neue) for (const b of v.besitzer || []) if (!besitzer.has(b.uid)) besitzer.set(b.uid, b);
    const besitzerWahl = {};
    if (besitzer.size) {
      const zeilen = [...besitzer.values()].map((b) => {
        besitzerWahl[b.uid] = b.vorschlag;
        const s = auswahl({ optionen: [{ wert: 'root', text: t('laufwerke.import_besitzer_root') }, ...(r.nutzer || []).map((n) => ({ wert: n.name, text: n.name }))], wert: b.vorschlag });
        s.addEventListener('change', () => { besitzerWahl[b.uid] = s.value; });
        return feld({ label: t('laufwerke.import_besitzer_alt', { uid: b.uid, name: b.alt_name || '?' }), eingabe: s });
      });
      teile.push(el('section', { klasse: 'lw-import-besitzer' }, el('h3', { text: t('laufwerke.import_besitzer_titel') }), el('p', { klasse: 'erklaerung', text: t('laufwerke.import_besitzer_erklaerung') }), ...zeilen));
    }
    if (fehlendeKonten.size) teile.push(hinweis(t('laufwerke.import_konten_fehlen', { liste: [...fehlendeKonten].sort().join(', ') }), 'warnung'));
    const verstanden = el('input', { typ: 'checkbox' });
    if (neue.length) teile.push(el('label', { klasse: 'lw-import-bestaetigung' }, verstanden, el('span', { text: t('laufwerke.import_bestaetigung') })));
    teile.push(fz.element);
    dialogOeffnen({
      ctx, titel: t('laufwerke.import_titel'), breit: true, schliessenText: t('laufwerke.schliessen'),
      inhalt: el('div', { klasse: 'lw-import-assistent' }, ...teile),
      knoepfe: [
        { text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        ...(neue.length ? [{ text: t('laufwerke.import_uebernehmen'), beiKlick: async (g) => {
          fz.leeren();
          if (!verstanden.checked) { fz.zeigen(t('laufwerke.import_bestaetigung_fehlt')); return; }
          const { params, fehler } = auftragBauen(formular, besitzerWahl, new Set(r.belegt || []));
          if (fehler.length) { fz.zeigen(t(`laufwerke.import_name_${fehler[0].grund}`, { ordner: fehler[0].ordner })); return; }
          if (!params.volumes.length) { fz.zeigen(t('laufwerke.import_nichts_gewaehlt')); return; }
          g.beschaeftigt(true);
          try {
            const erg = await aufgabeStarten(ctx, 'importe.uebernehmen', params, { titel: t('laufwerke.import_titel'), meldung: t('laufwerke.import_laeuft'), abbrechen: t('laufwerke.abbrechen'), schliessen: t('laufwerke.schliessen') });
            g.schliessen(); ergebnisZeigen(erg || {}); await zeichnen();
          } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
        } }] : []),
      ],
    });
  }

  function ergebnisZeigen(erg) {
    const teile = [];
    if ((erg.angelegt || []).length) teile.push(hinweis(t('laufwerke.import_fertig', { liste: erg.angelegt.map((a) => a.name).join(', ') }), 'erfolg'));
    if ((erg.heime || []).length) teile.push(hinweis(t('laufwerke.import_heime_fertig', { liste: erg.heime.map((h) => `${h.ordner} → ${h.nutzer}`).join(', ') }), 'erfolg'));
    const unveraendert = (erg.rechte || []).filter((x) => x.unveraendert).map((x) => x.name);
    if (unveraendert.length) teile.push(hinweis(t('laufwerke.import_rechte_gelassen', { liste: unveraendert.join(', ') }), 'info'));
    for (const f of erg.fehler || []) teile.push(hinweis(`${f.name || f.ordner || f.volume}: ${f.meldung}`, 'fehler'));
    if (!teile.length) teile.push(leerHinweis(t('laufwerke.import_nichts_gewaehlt')));
    teile.push(el('p', { klasse: 'erklaerung', text: t('laufwerke.import_fertig_tipp') }));
    dialogOeffnen({ ctx, titel: t('laufwerke.import_titel'), inhalt: el('div', {}, ...teile), schliessenText: t('laufwerke.schliessen'), knoepfe: [{ text: t('laufwerke.schliessen'), beiKlick: (g) => g.schliessen() }] });
  }

  zeichnen();
  k.neuZeichnen = zeichnen;
  return k;
}
