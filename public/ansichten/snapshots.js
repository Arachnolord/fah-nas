// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Schnappschüsse“: Zielwahl (System nur Admin, Freigaben nach Recht), Liste, Erzeugen, Löschen, Durchsuchen
// mit Pfadleiste und Zurückholen (Aufgabe mit Fortschritt), Zurückrollen (doppelte Bestätigung), Systemstände im
// Startmenü, Zeitpläne mit Aufbewahrung, Belegungshinweis ab 85 %.

import {
  el, anhaengen, leeren, stilLaden, eingabe, feld, schalter, auswahl, knopf, fehlerzeile, hinweis, leerHinweis, badge, tabelle, tabellenzeile,
  dialogOeffnen, alleDialogeSchliessen, aufgabeStarten, api, fehlerText, istAdmin, nutzernameVon, melden, bestaetigen, abo,
  kopfzeile, karte, uebersetzer, formatierer, felderPruefen,
} from './verwaltung-hilfen.js';
import { gesperrtHinweis } from '../ordnerrechte.js';
import { leerMitSchritt } from './verwaltung-hilfen.js';

let zuletztT = (k) => ({ 'snapshots.titel': 'Schnappschüsse' }[k] || k);
let abmelder = [];

/** Wirksame Aufbewahrung des Agenten (render/snapper.js anzahlBehalten): 0 oder fehlend = diese Standardwerte. */
export const BEHALTEN_STANDARD = Object.freeze({ stuendlich: 24, taeglich: 7, woechentlich: 4, monatlich: 12, pre_post: 10 });
export const PLAN_STANDARD = Object.freeze({ zeitplan: { stuendlich: false, taeglich: false, woechentlich: false, monatlich: false }, behalten: { ...BEHALTEN_STANDARD } });

// ---- Zeitplan: Anzahl ↔ Frist (0.32.0, Betreiber 13.11.2026: „täglich, wöchentlich oder monatlich sichern mit anzahl
// und frist“) – Zeile je Takt, beide Felder rechnen sich gegenseitig um. Monat ≈ 30,4 Tage, Jahr = 365 Tage.
export const PLAN_TAKTE = Object.freeze(['taeglich', 'woechentlich', 'monatlich', 'stuendlich']);
export const TAKT_STUNDEN = Object.freeze({ stuendlich: 1, taeglich: 24, woechentlich: 168, monatlich: 730 });
export const EINHEIT_STUNDEN = Object.freeze({ stunde: 1, tag: 24, woche: 168, monat: 730, jahr: 8760 });
export const EINHEITEN_JE_TAKT = Object.freeze({
  stuendlich: ['stunde', 'tag', 'woche'], taeglich: ['tag', 'woche', 'monat', 'jahr'], woechentlich: ['woche', 'monat', 'jahr'], monatlich: ['monat', 'jahr'],
});
export const ANZAHL_MAX = 1000;

/** Frist (Wert + Einheit) → Anzahl Stände dieses Takts (mindestens 1, höchstens ANZAHL_MAX). */
export function anzahlAusFrist(takt, wert, einheit) {
  const n = Math.round((Number(wert) * EINHEIT_STUNDEN[einheit]) / TAKT_STUNDEN[takt]);
  return Math.min(ANZAHL_MAX, Math.max(1, Number.isFinite(n) ? n : 1));
}

/** Anzahl → Frist in der größten passenden Einheit (7 tägliche = 1 Woche, 12 monatliche = 1 Jahr, 4 wöchentliche = 4 Wochen). */
export function fristAusAnzahl(takt, anzahl) {
  const stunden = Math.max(1, Number(anzahl) || 1) * TAKT_STUNDEN[takt];
  const einheiten = EINHEITEN_JE_TAKT[takt];
  for (const e of [...einheiten].reverse()) {
    const v = stunden / EINHEIT_STUNDEN[e];
    const r = Math.round(v);
    if (r >= 1 && Math.abs(v - r) / r <= 0.05) return { wert: r, einheit: e };   // 30 tägliche ≈ 1 Monat (Monat = 30,4 Tage)
  }
  return { wert: Math.round(stunden / EINHEIT_STUNDEN[einheiten[0]]), einheit: einheiten[0] };
}

/** Wie weit der älteste Stand zurückreicht (größte Frist der eingeschalteten Takte) oder null ohne Zeitplan. */
export function aeltesterStand(zeitplan, behalten) {
  const an = PLAN_TAKTE.filter((tk) => zeitplan && zeitplan[tk]);
  if (!an.length) return null;
  const stunden = Math.max(...an.map((tk) => (Number(behalten && behalten[tk]) || BEHALTEN_STANDARD[tk]) * TAKT_STUNDEN[tk]));
  for (const e of ['jahr', 'monat', 'woche', 'tag', 'stunde']) {
    const v = stunden / EINHEIT_STUNDEN[e];
    if (v >= 1) return { wert: Math.round(v * 10) / 10, einheit: e };
  }
  return { wert: stunden, einheit: 'stunde' };
}

/** 0/fehlend → Standardwert, damit die Felder zeigen, was der Agent wirklich behält (0 heißt beim Agenten „Standard“, nicht „keine“). */
export function wirksamBehalten(behalten) {
  const aus = {};
  for (const [k, standard] of Object.entries(BEHALTEN_STANDARD)) {
    const w = Number(behalten && behalten[k]);
    aus[k] = Number.isInteger(w) && w > 0 ? w : standard;
  }
  return aus;
}

/** Plan für ein Ziel aus snapshots.json holen (oder Standard); Aufbewahrung als wirksame Werte */
export function planFuer(plaene, ziel) {
  const liste = Array.isArray(plaene) ? plaene : (plaene && plaene.plaene) || [];
  const p = liste.find((x) => x.ziel === ziel);
  return { ziel, zeitplan: { ...PLAN_STANDARD.zeitplan, ...(p && p.zeitplan) }, behalten: wirksamBehalten(p && p.behalten) };
}

/** Relativen Pfad zusammensetzen (ohne führende/doppelte Schrägstriche) */
export function pfadVerbinden(...teile) {
  return teile.filter((x) => x !== undefined && x !== null && x !== '').join('/').split('/').filter(Boolean).join('/');
}

/** Parameter für snapshots.zurueckholen – `ueberschreiben` nur, wenn der Nutzer „Vorhandene ersetzen“ gewählt hat (Standard false → E_EXISTIERT beim Agenten). */
export function zurueckholenParams({ freigabe, id, pfade, zielPfad, ersetzen }) {
  return { freigabe, id, pfade: [...pfade], ziel_pfad: pfadVerbinden(zielPfad), ueberschreiben: ersetzen === true };
}

/**
 * Schreibrecht aus freigaben.liste ableiten (Rückfall, wenn dateien.liste kein `schreiben` liefert): Admin immer; sonst
 * steht der Nutzer in `schreiben` – oder eine @Gruppe, deren Mitglieder die Oberfläche nicht kennt (dann lieber anbieten
 * und den Agenten entscheiden lassen, als einem Berechtigten den Knopf zu nehmen).
 */
export function schreibrechtAusListe(freigabe, nutzer, admin = false) {
  if (admin) return true;
  if (!freigabe) return true;
  const liste = Array.isArray(freigabe.schreiben) ? freigabe.schreiben.map(String) : [];
  return liste.includes(String(nutzer)) || liste.some((x) => x.startsWith('@'));
}

/** Darf der Nutzer in die Freigabe zurückholen? Bevorzugt das `schreiben` aus dateien.liste (kennt Gruppen), sonst Rückfall aus der Freigabenliste. */
export async function schreibrechtPruefen(ctx, freigabeName, freigaben, admin) {
  if (admin) return true;
  try {
    const r = await api(ctx, 'dateien.liste', { freigabe: freigabeName, pfad: '' });
    if (r && typeof r.schreiben === 'boolean') return r.schreiben;
  } catch { /* Aktion fehlt oder Fehler – Rückfall */ }
  return schreibrechtAusListe((freigaben || []).find((f) => f.name === freigabeName), nutzernameVon(ctx), admin);
}

export default {
  id: 'snapshots',
  symbol: 'snapshots',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('snapshots.titel'); },

  async einbinden(wurzel, ctx) {
    stilLaden();
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    const admin = istAdmin(ctx);
    leeren(wurzel);
    wurzel.classList.add('sn-wurzel');

    const artText = { manuell: t('snapshots.art_manuell'), zeitplan: t('snapshots.art_zeitplan'), pre: t('snapshots.art_pre'), post: t('snapshots.art_post'), sicherheit: t('snapshots.art_sicherheit') };

    const belegungBereich = el('div', { klasse: 'sn-belegung' });
    const zielKarte = karte(null);
    const listeKarte = karte(t('snapshots.liste_titel'));
    const systemKarte = admin ? karte(t('snapshots.system_titel')) : null;
    const planKarte = admin ? karte(t('snapshots.plan_titel')) : null;
    // anhaengen() überspringt null (systemKarte/planKarte bei Rolle nutzer) – wurzel.append(null) schriebe den Text „null“
    anhaengen(wurzel, [kopfzeile(t('snapshots.titel'), t('snapshots.untertitel')), belegungBereich, zielKarte, listeKarte, systemKarte, planKarte]);

    let freigaben = [];
    let ziel = admin ? 'system' : null;
    let schnappschuesse = [];

    // ---- Belegung ----------------------------------------------------------------------------------------------
    async function belegungPruefen() {
      leeren(belegungBereich);
      try {
        const s = await api(ctx, 'system.status', {});
        const p = Number(s && s.datenpartition_prozent);
        if (Number.isFinite(p) && p >= 95) belegungBereich.appendChild(hinweis(t('snapshots.belegung_gestoppt', { prozent: Math.round(p) }), 'fehler'));
        else if (Number.isFinite(p) && p >= 85) belegungBereich.appendChild(hinweis(t('snapshots.belegung_warnung', { prozent: Math.round(p) }), 'warnung'));
      } catch { /* kein Status – kein Hinweis */ }
    }

    // ---- Zielwahl + Erzeugen -------------------------------------------------------------------------------------
    let zielAuswahl = null;
    function zielKarteZeichnen() {
      leeren(zielKarte);
      const optionen = [];
      if (admin) optionen.push({ wert: 'system', text: t('snapshots.ziel_system') });
      for (const f of freigaben) optionen.push({ wert: f.name, text: t('snapshots.ziel_freigabe', { name: f.name }) });
      if (!optionen.length) { zielKarte.appendChild(leerHinweis(t('snapshots.kein_ziel'))); return; }
      if (!ziel || !optionen.some((o) => o.wert === ziel)) ziel = optionen[0].wert;
      if (admin) zielKarte.appendChild(el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.erzeugen_titel') }));
      zielAuswahl = auswahl({ optionen, wert: ziel });
      zielAuswahl.addEventListener('change', async () => { ziel = zielAuswahl.value; await listeLaden(); systemKarteZeichnen(); });
      const zeile = el('div', { klasse: 'vw-zeile' }, feld({ label: t('snapshots.ziel'), erklaerung: t('snapshots.ziel_erklaerung'), eingabe: zielAuswahl }));
      if (admin) {
        const beschreibung = eingabe({ maxlength: 200, platzhalter: '' });
        const erzeugenKnopf = knopf(t('snapshots.erzeugen'), { beiKlick: async () => {
          erzeugenKnopf.disabled = true;
          try { await api(ctx, 'snapshots.erzeugen', { ziel, beschreibung: beschreibung.value.trim() }); melden(ctx, t('snapshots.erzeugt'), 'erfolg'); beschreibung.value = ''; await listeLaden(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); } finally { erzeugenKnopf.disabled = false; }
        } });
        zeile.append(feld({ label: t('snapshots.erzeugen_beschreibung'), erklaerung: t('snapshots.erzeugen_beschreibung_erklaerung'), eingabe: beschreibung }), el('div', { klasse: 'vw-feld sn-knopf-feld' }, erzeugenKnopf));
      }
      zielKarte.appendChild(zeile);
    }

    // ---- Liste ---------------------------------------------------------------------------------------------------
    async function listeLaden() {
      leeren(listeKarte); listeKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.liste_titel') }));
      if (!ziel) { listeKarte.appendChild(leerHinweis(t('snapshots.kein_ziel'))); return; }
      listeKarte.appendChild(leerHinweis(t('snapshots.laden')));
      try {
        const r = await api(ctx, 'snapshots.liste', { ziel });
        schnappschuesse = Array.isArray(r) ? r : (r && r.schnappschuesse) || [];
      } catch (e) { leeren(listeKarte); listeKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.liste_titel') }), hinweis(`${t('snapshots.lade_fehl')} ${fehlerText(e)}`, 'fehler')); return; }
      leeren(listeKarte); listeKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.liste_titel') }));
      if (!schnappschuesse.length) { listeKarte.appendChild(planKarte && ziel !== 'system' ? leerMitSchritt(t('snapshots.keine'), t('snapshots.plan_einrichten'), () => { planKarte.scrollIntoView({ behavior: 'smooth', block: 'start' }); planKarte.classList.add('karte-hervorgehoben'); setTimeout(() => planKarte.classList.remove('karte-hervorgehoben'), 2500); }) : leerHinweis(t('snapshots.keine'))); return; }
      const tab = tabelle([{ text: t('snapshots.spalte_zeit') }, { text: t('snapshots.spalte_art') }, { text: t('snapshots.spalte_beschreibung') }, { text: t('snapshots.spalte_groesse') }, { text: t('snapshots.spalte_aktionen') }], [], { klasse: 'sn-tabelle' });
      const istSystem = ziel === 'system';
      for (const s of [...schnappschuesse].sort((a, b) => (a.zeit < b.zeit ? 1 : -1))) {
        const aktionen = el('td', { klasse: 'vw-aktionen' },
          !istSystem ? knopf(t('snapshots.durchsuchen'), { art: 'zweit', klein: true, beiKlick: () => dialogDurchsuchen(s) }) : null,
          admin && !istSystem ? knopf(t('snapshots.zurueckrollen'), { art: 'zweit', klein: true, beiKlick: () => zurueckrollen(s) }) : null,
          admin && istSystem ? knopf(t('snapshots.standard'), { art: 'zweit', klein: true, beiKlick: () => systemStandard(s) }) : null,
          admin ? knopf(t('snapshots.loeschen'), { art: 'gefahr', klein: true, beiKlick: () => loeschen(s) }) : null);
        tabellenzeile(tab.koerper, [fmt.zeit(s.zeit), badge(artText[s.art] || String(s.art || ''), undefined), s.beschreibung || '', s.groesse !== undefined && s.groesse !== null ? fmt.groesse(s.groesse) : '–', aktionen]);
      }
      listeKarte.appendChild(tab.element);
    }

    async function loeschen(s) {
      if (!(await bestaetigen(ctx, t('snapshots.loeschen_frage', { zeit: fmt.zeit(s.zeit) })))) return;
      try { await api(ctx, 'snapshots.loeschen', { ziel, id: s.id }); melden(ctx, t('snapshots.geloescht'), 'erfolg'); await listeLaden(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }

    // ---- Durchsuchen + Zurückholen -----------------------------------------------------------------------------
    function dialogDurchsuchen(s) {
      const freigabe = ziel;
      let pfad = '';
      const ausgewaehlt = new Set();
      const pfadleiste = el('nav', { klasse: 'vw-pfadleiste', attr: { 'aria-label': t('snapshots.pfad_wurzel') } });
      const liste = el('div', { klasse: 'sn-ordner' });
      const auswahlText = el('span', { klasse: 'vw-gedaempft sn-auswahl', text: t('snapshots.auswahl', { anzahl: 0 }) });
      // Zurückholen braucht Schreibrecht in der Freigabe (Agent: freigabeHolen(…, true)) – ohne Recht Knopf weg, Hinweis statt E_RECHTE
      let darfSchreiben = admin;
      const rechtHinweis = hinweis(t('snapshots.zurueckholen_kein_recht'), 'info'); rechtHinweis.classList.add('vw-versteckt');
      const inhalt = el('div', {}, el('p', { klasse: 'erklaerung', text: t('snapshots.durchsuchen_erklaerung') }), rechtHinweis, pfadleiste, liste, auswahlText);
      const griff = dialogOeffnen({ ctx, titel: t('snapshots.durchsuchen_titel', { zeit: fmt.zeit(s.zeit) }), inhalt, breit: true, schliessenText: t('snapshots.schliessen'),
        knoepfe: [
          { text: t('snapshots.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('snapshots.zurueckholen'), deaktiviert: true, beiKlick: () => dialogZurueckholen() },
        ] });
      const holenKnopf = griff.knoepfe[1];
      const auswahlAktualisieren = () => { auswahlText.textContent = t('snapshots.auswahl', { anzahl: ausgewaehlt.size }); holenKnopf.disabled = ausgewaehlt.size === 0 || !darfSchreiben; };
      schreibrechtPruefen(ctx, freigabe, freigaben, admin).then((ja) => {
        darfSchreiben = ja;
        holenKnopf.hidden = !ja;
        rechtHinweis.classList.toggle('vw-versteckt', ja);
        auswahlAktualisieren();
      });

      function pfadleisteZeichnen() {
        leeren(pfadleiste);
        pfadleiste.appendChild(knopf(t('snapshots.pfad_wurzel'), { art: 'zweit', klein: true, beiKlick: () => oeffnen('') }));
        const teile = pfad.split('/').filter(Boolean);
        teile.forEach((teil, i) => {
          pfadleiste.append(el('span', { klasse: 'vw-pfad-trenner', text: '/' }), knopf(teil, { art: 'zweit', klein: true, beiKlick: () => oeffnen(teile.slice(0, i + 1).join('/')) }));
        });
      }

      async function oeffnen(neuerPfad) {
        pfad = neuerPfad; pfadleisteZeichnen();
        leeren(liste); liste.appendChild(leerHinweis(t('snapshots.laden')));
        let r;
        try { r = await api(ctx, 'snapshots.durchsuchen', { ziel: freigabe, id: s.id, pfad }); } catch (e) { leeren(liste); liste.appendChild(hinweis(`${t('snapshots.durchsuchen_fehl')} ${fehlerText(e)}`, 'fehler')); return; }
        const eintraege = (r && r.eintraege) || (Array.isArray(r) ? r : []);
        leeren(liste);
        if (!eintraege.length) { liste.appendChild(leerHinweis(t('snapshots.ordner_leer'))); return; }
        const ul = el('ul', { klasse: 'vw-liste' });
        for (const e of [...eintraege].sort((a, b) => (a.art === b.art ? a.name.localeCompare(b.name, 'de') : a.art === 'ordner' ? -1 : 1))) {
          const voll = pfadVerbinden(pfad, e.name);
          const cb = el('input', { typ: 'checkbox' }); cb.checked = ausgewaehlt.has(voll); cb.disabled = !!e.gesperrt;
          cb.setAttribute('aria-label', e.name);
          cb.addEventListener('change', () => { if (cb.checked) ausgewaehlt.add(voll); else ausgewaehlt.delete(voll); auswahlAktualisieren(); });
          const name = e.art === 'ordner'
            ? knopf(`${e.gesperrt ? '🔒 ' : ''}${e.name}/`, { art: 'zweit', klasse: 'vw-liste-name vw-ordner sn-ordnerknopf', beiKlick: () => (e.gesperrt ? gesperrtHinweis(ctx, e.name) : oeffnen(voll)) })
            : el('span', { klasse: 'vw-liste-name', text: e.name });
          ul.appendChild(el('li', {}, cb, name, el('span', { klasse: 'vw-liste-meta', text: e.art === 'ordner' ? '' : `${fmt.groesse(e.groesse)} · ${fmt.zeit(e.geaendert)}` })));
        }
        liste.appendChild(ul);
      }

      function dialogZurueckholen() {
        const form = el('form', { attr: { novalidate: 'novalidate' } });
        const fz = fehlerzeile();
        const zielPfad = eingabe({ wert: pfad, maxlength: 4096, klasse: 'vw-mono', spellcheck: false });
        // Standard: nichts überschreiben (Agent antwortet sonst E_EXISTIERT). Der Schalter schickt ueberschreiben:true mit.
        const ersetzen = schalter({ label: t('snapshots.zurueckholen_ersetzen'), erklaerung: t('snapshots.zurueckholen_ersetzen_erklaerung'), wert: false });
        form.append(el('p', { text: t('snapshots.zurueckholen_erklaerung') }), el('p', { klasse: 'vw-gedaempft', text: t('snapshots.auswahl', { anzahl: ausgewaehlt.size }) }),
          feld({ label: t('snapshots.zurueckholen_ziel'), erklaerung: t('snapshots.zurueckholen_ziel_erklaerung'), eingabe: zielPfad }), ersetzen.element, fz.element);
        const g2 = dialogOeffnen({ ctx, titel: t('snapshots.zurueckholen_titel'), inhalt: form, schliessenText: t('snapshots.schliessen'),
          knoepfe: [{ text: t('snapshots.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('snapshots.zurueckholen_start'), absenden: true }] });
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          if (!felderPruefen([{ eingabe: zielPfad, pruefen: (w) => (w.includes('..') ? t('snapshots.zurueckholen_ziel_erklaerung') : null) }], fz)) return;
          const pfade = [...ausgewaehlt];
          const params = zurueckholenParams({ freigabe, id: s.id, pfade, zielPfad: zielPfad.value, ersetzen: ersetzen.eingabe.checked });
          g2.schliessen();
          try {
            const erg = await aufgabeStarten(ctx, 'snapshots.zurueckholen', params,
              { titel: t('snapshots.zurueckholen_titel'), meldung: t('snapshots.zurueckholen_laeuft'), abbrechen: t('snapshots.abbrechen'), schliessen: t('snapshots.schliessen') });
            melden(ctx, t('snapshots.zurueckholen_fertig', { anzahl: (erg && erg.anzahl) || pfade.length }), 'erfolg');
            griff.schliessen();
          } catch { /* Fehler steht im Aufgabendialog */ }
        });
      }

      oeffnen('');
    }

    // ---- Zurückrollen ------------------------------------------------------------------------------------------
    async function zurueckrollen(s) {
      const freigabe = ziel;
      if (!(await bestaetigen(ctx, t('snapshots.zurueckrollen_frage1', { name: freigabe, zeit: fmt.zeit(s.zeit) })))) return;
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const tipp = eingabe({ maxlength: 32, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      form.append(hinweis(t('snapshots.zurueckrollen_erklaerung'), 'warnung'), feld({ label: t('snapshots.zurueckrollen_tippen'), erklaerung: t('snapshots.zurueckrollen_tippen_erklaerung', { name: freigabe }), eingabe: tipp }), fz.element);
      const griff = dialogOeffnen({ ctx, titel: t('snapshots.zurueckrollen_titel'), inhalt: form, schliessenText: t('snapshots.schliessen'),
        knoepfe: [{ text: t('snapshots.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('snapshots.zurueckrollen_knopf'), art: 'gefahr', absenden: true, deaktiviert: true }] });
      tipp.addEventListener('input', () => { griff.knoepfe[1].disabled = tipp.value.trim() !== freigabe; });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (tipp.value.trim() !== freigabe) return;
        griff.schliessen();
        try {
          await aufgabeStarten(ctx, 'snapshots.zurueckrollen', { freigabe, id: s.id }, { titel: t('snapshots.zurueckrollen_titel'), meldung: t('snapshots.zurueckrollen_laeuft'), abbrechen: t('snapshots.abbrechen'), schliessen: t('snapshots.schliessen') });
          melden(ctx, t('snapshots.zurueckrollen_fertig'), 'erfolg');
          await listeLaden();
        } catch { /* Fehler steht im Aufgabendialog */ }
      });
    }

    // ---- System: Startmenü + Standard --------------------------------------------------------------------------
    async function systemKarteZeichnen() {
      if (!systemKarte) return;
      leeren(systemKarte);
      if (ziel !== 'system') { systemKarte.classList.add('vw-versteckt'); return; }
      systemKarte.classList.remove('vw-versteckt');
      systemKarte.append(
        el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.system_titel') }),
        el('p', { klasse: 'erklaerung', text: t('snapshots.system_erklaerung') }),
        el('details', { klasse: 'vw-details' }, el('summary', { text: t('snapshots.system_anleitung_titel') }), el('p', { klasse: 'sn-anleitung', text: t('snapshots.system_anleitung') })),
      );
      const bereich = el('div', {}, leerHinweis(t('snapshots.laden')));
      systemKarte.appendChild(bereich);
      try {
        const r = await api(ctx, 'snapshots.system.startmenue', {});
        const eintraege = Array.isArray(r) ? r : (r && r.eintraege) || [];
        leeren(bereich);
        if (!eintraege.length) { bereich.appendChild(leerHinweis(t('snapshots.startmenue_keine'))); return; }
        const ul = el('ul', { klasse: 'vw-liste sn-startmenue' });
        for (const e of eintraege) {
          const titel = typeof e === 'string' ? e : e.titel || e.name || e.id || '';
          const id = typeof e === 'string' ? e : e.id;
          ul.appendChild(el('li', {}, el('span', { klasse: 'vw-liste-name' }, el('span', { text: titel }), e.zeit ? el('span', { klasse: 'vw-liste-meta', text: ` ${fmt.zeit(e.zeit)}` }) : null),
            id !== undefined ? knopf(t('snapshots.standard'), { art: 'zweit', klein: true, beiKlick: () => systemStandard({ id, zeit: e.zeit, beschreibung: titel }) }) : null));
        }
        bereich.appendChild(ul);
      } catch (e) { leeren(bereich); bereich.appendChild(hinweis(`${t('snapshots.startmenue_laden_fehl')} ${fehlerText(e)}`, 'warnung')); }
    }

    function systemStandard(s) {
      const fz = fehlerzeile();
      const griff = dialogOeffnen({ ctx, titel: t('snapshots.standard_titel'), schliessenText: t('snapshots.schliessen'),
        inhalt: el('div', {}, el('p', { text: t('snapshots.standard_frage') }), el('p', { klasse: 'vw-gedaempft', text: `${fmt.zeit(s.zeit)} ${s.beschreibung || ''}`.trim() }), hinweis(t('snapshots.standard_warnung'), 'warnung'), fz.element),
        knoepfe: [
          { text: t('snapshots.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('snapshots.standard_knopf'), art: 'gefahr', beiKlick: async (g) => {
            g.beschaeftigt(true);
            try { await api(ctx, 'snapshots.system.standard', { id: s.id }); melden(ctx, t('snapshots.standard_gesetzt'), 'erfolg'); g.schliessen(); } catch (e) { g.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
          } },
        ] });
      void griff;
    }

    // ---- Zeitpläne ---------------------------------------------------------------------------------------------
    // Zeile je Takt: Schalter, Anzahl, Frist (Wert + Einheit). Anzahl und Frist rechnen sich gegenseitig um; darunter,
    // wie weit der älteste Stand zurückreicht. Update-Paare (nur System) unter „Erweitert“.
    // feste Schlüssel (keine zusammengesetzten – die Sprachprüfung muss sie finden)
    const EINHEIT_TEXT = {
      stunde: (n) => t('snapshots.einheit_stunde', { n }), tag: (n) => t('snapshots.einheit_tag', { n }), woche: (n) => t('snapshots.einheit_woche', { n }),
      monat: (n) => t('snapshots.einheit_monat', { n }), jahr: (n) => t('snapshots.einheit_jahr', { n }),
    };
    const einheitText = (e, n) => EINHEIT_TEXT[e](n);
    const TAKT_NAME = { stuendlich: () => t('snapshots.plan_stuendlich'), taeglich: () => t('snapshots.plan_taeglich'), woechentlich: () => t('snapshots.plan_woechentlich'), monatlich: () => t('snapshots.plan_monatlich') };
    const TAKT_ZEIT = { stuendlich: () => t('snapshots.plan_zeit_stuendlich'), taeglich: () => t('snapshots.plan_zeit_taeglich'), woechentlich: () => t('snapshots.plan_zeit_woechentlich'), monatlich: () => t('snapshots.plan_zeit_monatlich') };
    async function planKarteZeichnen() {
      if (!planKarte) return;
      leeren(planKarte);
      planKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('snapshots.plan_titel') }), el('p', { klasse: 'erklaerung', text: t('snapshots.plan_erklaerung') }));
      let plaene;
      try { plaene = await api(ctx, 'snapshots.plan.lesen', {}); } catch (e) { planKarte.appendChild(hinweis(`${t('snapshots.plan_lade_fehl')} ${fehlerText(e)}`, 'warnung')); return; }
      const ziele = ['system', ...freigaben.map((f) => f.name)];
      const raster = el('div', { klasse: 'sn-plan-raster' });
      for (const z of ziele) {
        const p = planFuer(plaene, z);
        const istSystem = z === 'system';
        const fz = fehlerzeile();
        const zeilen = {};
        const reicht = el('p', { klasse: 'sn-plan-reicht' });
        const reichtSetzen = () => {
          const zp = {}; const bh = {};
          for (const tk of PLAN_TAKTE) { zp[tk] = zeilen[tk].an.checked; bh[tk] = Number(zeilen[tk].anzahl.value) || 0; }
          const a = aeltesterStand(zp, bh);
          reicht.textContent = a ? t('snapshots.plan_reicht', { frist: `${String(a.wert).replace('.', ',')} ${einheitText(a.einheit, a.wert)}` }) : t('snapshots.plan_reicht_keiner');
        };
        const tabelleZeilen = PLAN_TAKTE.map((tk) => {
          const an = el('input', { typ: 'checkbox', attr: { role: 'switch', 'aria-label': TAKT_NAME[tk]() } });
          an.checked = !!p.zeitplan[tk];
          const anzahl = eingabe({ typ: 'number', wert: p.behalten[tk], min: 1, max: ANZAHL_MAX, schritt: 1, inputmode: 'numeric', klasse: 'sn-zahl' });
          anzahl.setAttribute('aria-label', t('snapshots.plan_anzahl_fuer', { takt: TAKT_NAME[tk]() }));
          const f = fristAusAnzahl(tk, p.behalten[tk]);
          const fristWert = eingabe({ typ: 'number', wert: f.wert, min: 1, max: 9999, schritt: 1, inputmode: 'numeric', klasse: 'sn-zahl sn-frist-wert' });
          fristWert.setAttribute('aria-label', t('snapshots.plan_frist_fuer', { takt: TAKT_NAME[tk]() }));
          const einheit = auswahl({ optionen: EINHEITEN_JE_TAKT[tk].map((e) => ({ wert: e, text: einheitText(e, 2) })), wert: f.einheit, klasse: 'sn-frist-einheit' });
          einheit.setAttribute('aria-label', t('snapshots.plan_frist_einheit'));
          const zeile = el('div', { klasse: `sn-takt${an.checked ? '' : ' aus'}` },
            el('label', { klasse: 'sn-takt-name' }, an, el('span', {}, el('span', { klasse: 'sn-takt-titel', text: TAKT_NAME[tk]() }), el('span', { klasse: 'sn-takt-zeit', text: TAKT_ZEIT[tk]() }))),
            el('div', { klasse: 'sn-takt-werte' },
              el('span', { klasse: 'sn-takt-wert' }, el('span', { text: t('snapshots.plan_spalte_anzahl') }), anzahl),
              el('span', { klasse: 'sn-takt-wert sn-frist' }, el('span', { text: t('snapshots.plan_spalte_frist') }), fristWert, einheit)));
          const einheitenText = () => { for (const o of einheit.options) o.textContent = einheitText(o.value, Number(fristWert.value) || 1); };
          anzahl.addEventListener('input', () => {
            const n = Number(anzahl.value);
            if (Number.isInteger(n) && n >= 1) { const fr = fristAusAnzahl(tk, n); fristWert.value = String(fr.wert); einheit.value = fr.einheit; einheitenText(); }
            reichtSetzen();
          });
          const ausFrist = () => { const w = Number(fristWert.value); if (w > 0) anzahl.value = String(anzahlAusFrist(tk, w, einheit.value)); einheitenText(); reichtSetzen(); };
          fristWert.addEventListener('input', ausFrist);
          einheit.addEventListener('change', ausFrist);
          an.addEventListener('change', () => { an.setAttribute('aria-checked', an.checked ? 'true' : 'false'); zeile.classList.toggle('aus', !an.checked); reichtSetzen(); });
          an.setAttribute('aria-checked', an.checked ? 'true' : 'false');
          einheitenText();
          zeilen[tk] = { an, anzahl };
          return zeile;
        });
        const bPp = istSystem ? eingabe({ typ: 'number', wert: p.behalten.pre_post, min: 1, max: ANZAHL_MAX, schritt: 1, inputmode: 'numeric', klasse: 'sn-zahl' }) : null;
        const speichern = knopf(t('snapshots.plan_speichern'), { art: 'zweit' });
        const block = el('form', { klasse: 'karte sn-plan', attr: { novalidate: 'novalidate' } },
          el('h3', { klasse: 'sn-plan-titel', text: istSystem ? t('snapshots.ziel_system') : t('snapshots.ziel_freigabe', { name: z }) }),
          ...tabelleZeilen,
          reicht,
          el('p', { klasse: 'erklaerung', text: t('snapshots.plan_behalten_erklaerung') }),
          bPp ? el('details', { klasse: 'sn-plan-erweitert' }, el('summary', { text: t('snapshots.plan_erweitert') }),
            feld({ label: t('snapshots.plan_behalten_pre_post'), erklaerung: t('snapshots.plan_pre_post_erklaerung'), eingabe: bPp })) : null,
          fz.element, speichern);
        reichtSetzen();
        speichern.type = 'submit';
        block.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const ganz = (w) => (w !== '' && Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= ANZAHL_MAX ? null : t('snapshots.plan_zahl_fehler'));
          if (!felderPruefen([...PLAN_TAKTE.map((tk) => ({ eingabe: zeilen[tk].anzahl, pruefen: ganz })), ...(bPp ? [{ eingabe: bPp, pruefen: ganz }] : [])], fz)) return;
          speichern.disabled = true;
          const zeitplan = {}; const behalten = {};
          for (const tk of PLAN_TAKTE) { zeitplan[tk] = zeilen[tk].an.checked; behalten[tk] = Number(zeilen[tk].anzahl.value); }
          if (bPp) behalten.pre_post = Number(bPp.value);
          try {
            await api(ctx, 'snapshots.plan.setzen', { ziel: z, zeitplan, behalten });
            melden(ctx, t('snapshots.plan_gespeichert', { ziel: istSystem ? t('snapshots.ziel_system') : z }), 'erfolg');
          } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
        });
        raster.appendChild(block);
      }
      planKarte.appendChild(raster);
    }

    // ---- Start ---------------------------------------------------------------------------------------------------
    try { const r = await api(ctx, 'freigaben.liste', {}); freigaben = Array.isArray(r) ? r : (r && r.freigaben) || []; } catch { freigaben = []; }
    zielKarteZeichnen();
    await Promise.all([belegungPruefen(), listeLaden(), systemKarteZeichnen(), planKarteZeichnen()]);

    abmelder.push(abo(ctx, 'konfig', (e) => { const d = e && e.daten ? e.daten : e; if (d && d.bereich === 'snapshots') { listeLaden(); planKarteZeichnen(); } }));
    abmelder.push(abo(ctx, 'system', (e) => { const d = e && e.daten ? e.daten : e; if (d && (d.art === 'platte_voll' || d.art === 'platte')) belegungPruefen(); }));
  },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
