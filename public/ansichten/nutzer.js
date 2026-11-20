// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Nutzer“: oben „Mein Konto“ (jede Rolle: Passwort ändern, 2FA einrichten mit selbst gezeichnetem QR-Code,
// Wiederherstellungscodes, 2FA entfernen); für Admins darunter die Nutzertabelle (anlegen, bearbeiten, Passwort setzen,
// sperren, löschen) und die Gruppenverwaltung (anlegen, löschen, Mitglieder). Seit 16.10.2026 in „Mein Konto“ der Regler
// „Automatisch abmelden“ (Standard, 15 Minuten … 30 Tage, Nie) – POST /api/sitzung/abmelden. Seit 0.22.0 ein Profilbild
// (Avatar) in „Mein Konto“; Admins sehen die Bilder in der Liste und setzen sie im Bearbeiten-Dialog.

import {
  el, anhaengen, leeren, stilLaden, eingabe, feld, schalter, auswahl, radiogruppe, knopf, fehlerzeile, hinweis, leerHinweis, badge, tabelle, tabellenzeile,
  dialogOeffnen, alleDialogeSchliessen, api, get, post, fehlerText, istAdmin, nutzernameVon, melden, bestaetigen, abo, kopieren, herunterladenText,
  kopfzeile, karte, uebersetzer, formatierer, felderPruefen, staerkeanzeige, gebiet
} from './verwaltung-hilfen.js';
import { qrErzeugen, qrZeichnen } from './nutzer.qr.js';
import { ABMELDEN_STUFEN, stufeVon, abmeldenKurz, abmeldenText } from '../abmelden.js';
import { suchzielAnspringen } from './verwaltung-hilfen.js';
import { avatarKnoten, avatarUrl, avatareSetzen, bildVorbereiten } from '../avatar.js';

export const MUSTER_NUTZERNAME = /^(?=.{2,31}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
export const MUSTER_GRUPPE = /^[a-z][a-z0-9_-]{1,30}$/;
/** Ein Gerät zählt als angemeldet, wenn es in diesem Zeitraum benutzt wurde. */
export const GERAET_AKTIV_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Angemeldete Geräte statt Sitzungen: je Gerät einmal, nur in den letzten 30 Tagen benutzte (eine im privaten Fenster
 * oder in einem gelöschten Browser liegengebliebene Sitzung zählt nicht ewig mit); die eigene zählt immer. Sitzungen ohne
 * Gerät (von vor dem 20.10.2026) zählen nur als die eigene – die übrigen sind meist verwaist.
 */
export function geraeteZaehlen(sitzungen, jetzt = Date.now()) {
  const geraete = new Set();
  for (const s of sitzungen || []) {
    const frisch = jetzt - (Date.parse(s.zuletzt) || 0) <= GERAET_AKTIV_MS;
    if (s.aktuell) geraete.add(s.geraet || s.kennung);
    else if (s.geraet && frisch) geraete.add(s.geraet);
  }
  return geraete.size;
}
const ZUGRIFF_TEXT = Object.freeze({ kein: 'nutzer.zugriff_kein', lesen: 'nutzer.zugriff_lesen', schreiben: 'nutzer.zugriff_schreiben' });

let zuletztT = (k) => ({ 'nutzer.titel': 'Nutzer' }[k] || k);
let abmelder = [];

/** Passwortfelder (neu + Wiederholung + Stärke) als Baustein; gibt {elemente, pruefregeln, wert()} */
function passwortfelder(t, { labelNeu, erklaerung, labelWiederholung, autocomplete = 'new-password' }) {
  const neu = eingabe({ typ: 'password', autocomplete, maxlength: 256 });
  const wdh = eingabe({ typ: 'password', autocomplete, maxlength: 256 });
  const staerke = staerkeanzeige({ label: t('nutzer.staerke'), schwach: t('nutzer.staerke_schwach'), mittel: t('nutzer.staerke_mittel'), stark: t('nutzer.staerke_stark') });
  neu.addEventListener('input', () => staerke.aktualisieren(neu.value));
  return {
    neu, wdh,
    elemente: [feld({ label: labelNeu, erklaerung, eingabe: neu, hinweisElement: staerke.element }), feld({ label: labelWiederholung, eingabe: wdh })],
    pruefregeln: [
      { eingabe: neu, pruefen: (w) => (w.length >= 8 ? null : t('nutzer.passwort_kurz')) },
      { eingabe: wdh, pruefen: (w) => (w === neu.value ? null : t('nutzer.passwort_wiederholung_fehler')) },
    ],
    wert: () => neu.value,
  };
}

export default {
  id: 'nutzer',
  symbol: 'nutzer',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('nutzer.titel'); },

  async einbinden(wurzel, ctx) {
    suchzielAnspringen(wurzel, ctx.route); // Suche/„Beheben“: #/nutzer/ziel/<name>
    stilLaden();
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    const admin = istAdmin(ctx);
    leeren(wurzel);
    wurzel.classList.add('nu-wurzel');

    let ich = typeof ctx.nutzer === 'object' && ctx.nutzer ? { ...ctx.nutzer } : { name: nutzernameVon(ctx), rolle: admin ? 'admin' : 'nutzer', totp: false };
    let nutzerListe = [];
    let gruppenListe = [];

    const kontoKarte = karte(t('nutzer.konto_titel'));
    const nutzerKarte = admin ? karte(null) : null;
    const gruppenKarte = admin ? karte(null) : null;

    // anhaengen() überspringt null (nutzerKarte/gruppenKarte bei Rolle nutzer) – wurzel.append(null) schriebe den Text „null“
    anhaengen(wurzel, [
      kopfzeile(t('nutzer.titel'), admin ? t('nutzer.untertitel') : null, admin ? knopf(t('nutzer.neu'), { beiKlick: () => dialogNutzer(null) }) : null),
      kontoKarte, nutzerKarte, gruppenKarte,
    ]);

    // ---- Profilbild (0.22.0) ----------------------------------------------------------------------------------
    /** Bild (oder Anfangsbuchstabe) von `name` mit „Bild wählen“/„Entfernen“ – in „Mein Konto“ und im Bearbeiten-Dialog. */
    function avatarBlock(name, anzeige) {
      const block = el('div', { klasse: 'nu-avatar-block' });
      const datei = el('input', { attr: { type: 'file', accept: 'image/*', 'aria-hidden': 'true', tabindex: '-1' } });
      datei.hidden = true;
      datei.addEventListener('change', () => { const f = datei.files && datei.files[0]; if (f) hochladen(f); });
      async function neuLaden() { try { avatareSetzen(await api(ctx, 'nutzer.avatare', {})); } catch { /* das Ereignis holt es nach */ } zeichnen(); }
      async function hochladen(f) {
        let daten;
        try { daten = await bildVorbereiten(f); } catch { melden(ctx, t('nutzer.avatar_unlesbar'), 'fehler'); return; }
        try { await api(ctx, 'nutzer.avatar.setzen', { name, daten }); melden(ctx, t('nutzer.avatar_gespeichert'), 'erfolg'); await neuLaden(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
      }
      async function entfernen() {
        try { await api(ctx, 'nutzer.avatar.loeschen', { name }); melden(ctx, t('nutzer.avatar_entfernt'), 'erfolg'); await neuLaden(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
      }
      function zeichnen() {
        leeren(block);
        const hat = !!avatarUrl(name);
        block.append(
          avatarKnoten({ name, anzeige, groesse: 64, klasse: 'nu-avatar' }),
          el('div', { klasse: 'nu-avatar-text' },
            el('p', { klasse: 'erklaerung', text: t('nutzer.avatar_erklaerung') }),
            el('div', { klasse: 'nu-avatar-knoepfe' },
              knopf(t(hat ? 'nutzer.avatar_aendern' : 'nutzer.avatar_waehlen'), { art: 'zweit', beiKlick: () => { datei.value = ''; datei.click(); } }),
              hat ? knopf(t('nutzer.avatar_entfernen'), { art: 'zweit', beiKlick: entfernen }) : null)),
          datei);
      }
      zeichnen();
      return block;
    }

    // ---- Mein Konto ------------------------------------------------------------------------------------------
    function kontoZeichnen() {
      leeren(kontoKarte);
      const rolleText = t(ich.rolle === 'admin' ? 'nutzer.rolle_admin' : 'nutzer.rolle_nutzer');
      kontoKarte.append(
        el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.konto_titel') }),
        el('p', { klasse: 'nu-konto-zeile' }, el('strong', { text: ich.anzeigename || ich.name }), ' ', el('span', { klasse: 'vw-gedaempft', text: t('nutzer.konto_angemeldet', { name: ich.name, rolle: rolleText }) })),
        avatarBlock(ich.name, ich.anzeigename || ich.name),
        el('div', { klasse: 'nu-konto-raster' },
          el('div', { klasse: 'nu-konto-block' },
            el('p', { klasse: 'erklaerung', text: t('nutzer.konto_passwort_erklaerung') }),
            knopf(t('nutzer.konto_passwort'), { art: 'zweit', beiKlick: dialogEigenesPasswort })),
          el('div', { klasse: 'nu-konto-block' },
            el('p', { klasse: 'nu-totp-stand' }, badge(t(ich.totp ? 'nutzer.konto_totp_an' : 'nutzer.konto_totp_aus'), undefined, ich.totp ? 'erfolg' : '')),
            el('p', { klasse: 'erklaerung', text: t('nutzer.konto_totp_erklaerung') }),
            ich.totp
              ? knopf(t('nutzer.konto_totp_entfernen'), { art: 'gefahr', beiKlick: dialogTotpEntfernen })
              : knopf(t('nutzer.konto_totp_einrichten'), { beiKlick: dialogTotpEinrichten })),
          el('div', { klasse: 'nu-konto-block' },
            el('p', { klasse: 'nu-sitzungen-stand' }, el('strong', { text: t('nutzer.konto_sitzungen') }), ' ', sitzungenAnzahl),
            el('p', { klasse: 'erklaerung', text: t('nutzer.konto_sitzungen_erklaerung') }),
            knopf(t('nutzer.konto_sitzungen_beenden'), { art: 'zweit', beiKlick: async (_ev, k) => {
              k.disabled = true;
              try { await post(ctx, '/api/sitzungen/beenden', { alle_anderen: true }); melden(ctx, t('nutzer.konto_sitzungen_beendet'), 'erfolg'); sitzungenZaehlen(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); } finally { k.disabled = false; }
            } })),
          abmeldenBlock(),
        ),
      );
      sitzungenZaehlen();
    }

    // Automatisch abmelden: Regler über die Stufen; Text der Stellung darunter, gespeichert beim Loslassen
    function abmeldenBlock() {
      const gewaehlt = ich.abmelden === undefined ? null : ich.abmelden;
      const regler = el('input', { typ: 'range', klasse: 'nu-abmelden-regler', attr: { min: 0, max: ABMELDEN_STUFEN.length - 1, step: 1, 'aria-label': t('abmelden.titel') }, wert: stufeVon(gewaehlt) });
      const wert = el('strong', { klasse: 'nu-abmelden-wert', text: abmeldenKurz(t, gewaehlt) });
      const stufe = el('p', { klasse: 'erklaerung nu-abmelden-stufe', attr: { 'aria-live': 'polite' }, text: abmeldenText(t, gewaehlt) });
      const zeigen = () => { const m = ABMELDEN_STUFEN[Number(regler.value)]; wert.textContent = abmeldenKurz(t, m); stufe.textContent = abmeldenText(t, m); regler.setAttribute('aria-valuetext', abmeldenKurz(t, m)); };
      regler.addEventListener('input', zeigen);
      regler.addEventListener('change', async () => {
        const m = ABMELDEN_STUFEN[Number(regler.value)];
        regler.disabled = true;
        try {
          await post(ctx, '/api/sitzung/abmelden', { minuten: m });
          ich = { ...ich, abmelden: m };
          if (typeof ctx.nutzer === 'object' && ctx.nutzer) ctx.nutzer.abmelden = m;
          melden(ctx, t('abmelden.gespeichert', { wert: abmeldenKurz(t, m) }), 'erfolg');
        } catch (e) {
          melden(ctx, t('abmelden.fehler', { grund: fehlerText(e) }), 'fehler');
          regler.value = String(stufeVon(ich.abmelden === undefined ? null : ich.abmelden)); zeigen();
        } finally { regler.disabled = false; }
      });
      zeigen();
      return el('div', { klasse: 'nu-konto-block nu-abmelden' },
        el('p', {}, el('strong', { text: t('abmelden.titel') }), ' · ', wert),
        el('p', { klasse: 'erklaerung', text: t('abmelden.erklaerung') }),
        regler, stufe);
    }

    // Zahl der eigenen Geräte (GET /api/sitzungen); ohne Endpunkt bleibt die Zeile leer
    const sitzungenAnzahl = el('span', { klasse: 'vw-gedaempft nu-sitzungen-anzahl' });
    async function sitzungenZaehlen() {
      try {
        const r = await get(ctx, '/api/sitzungen');
        const liste = Array.isArray(r) ? r : (r && r.sitzungen) || [];
        const anzahl = geraeteZaehlen(liste.filter((s) => !s.nutzer || s.nutzer === ich.name));
        sitzungenAnzahl.textContent = anzahl === 1 ? t('nutzer.konto_sitzungen_eins') : t('nutzer.konto_sitzungen_anzahl', { anzahl });
      } catch { sitzungenAnzahl.textContent = ''; }
    }

    async function ichAktualisieren() {
      try { const r = await get(ctx, '/api/ich'); if (r && r.name) ich = { ...ich, ...r }; } catch { /* alter Stand bleibt */ }
      if (typeof ctx.nutzer === 'object' && ctx.nutzer) Object.assign(ctx.nutzer, ich);
      kontoZeichnen();
    }

    function dialogEigenesPasswort() {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const alt = eingabe({ typ: 'password', autocomplete: 'current-password', maxlength: 256 });
      const pw = passwortfelder(t, { labelNeu: t('nutzer.passwort_neu'), erklaerung: t('nutzer.passwort_neu_erklaerung'), labelWiederholung: t('nutzer.passwort_wiederholung') });
      form.append(fz.element, feld({ label: t('nutzer.passwort_alt'), erklaerung: t('nutzer.passwort_alt_erklaerung'), eingabe: alt }), ...pw.elemente);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.passwort_dialog_titel'), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.speichern'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([{ eingabe: alt, pruefen: (w) => (w ? null : t('nutzer.passwort_alt_erklaerung')) }, ...pw.pruefregeln], fz)) return;
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'nutzer.passwort', { name: ich.name, passwort: pw.wert(), altes_passwort: alt.value });
          melden(ctx, t('nutzer.passwort_geaendert'), 'erfolg'); griff.schliessen();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); alt.focus(); }
      });
    }

    async function dialogTotpEinrichten() {
      // Schritt 0: eigenes Passwort bestätigen (der Agent verlangt es, damit niemand mit offener Sitzung die 2FA umbiegt)
      const pw = eingabe({ typ: 'password', autocomplete: 'current-password' });
      const fzPw = fehlerzeile();
      const formPw = el('form', { attr: { novalidate: 'novalidate' } },
        el('p', { klasse: 'erklaerung', text: t('nutzer.totp_passwort_erklaerung') }),
        feld({ label: t('nutzer.passwort_alt'), eingabe: pw }), fzPw.element);
      const inhalt = el('div', {}, formPw);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.totp_titel'), inhalt, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.weiter'), beiKlick: () => formPw.requestSubmit() }] });
      pw.focus();
      const daten = await new Promise((fertig) => {
        formPw.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          if (!pw.value) { fzPw.zeigen(t('nutzer.passwort_alt_erklaerung')); pw.focus(); return; }
          griff.beschaeftigt(true);
          try { fertig(await api(ctx, 'nutzer.totp.einrichten', { name: ich.name, passwort: pw.value })); }
          catch (e) { griff.beschaeftigt(false); fzPw.zeigen(fehlerText(e)); pw.select(); }
        });
      });
      griff.beschaeftigt(false);
      if (griff.knoepfe[1]) griff.knoepfe[1].remove();
      leeren(inhalt);
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const canvas = el('canvas', { klasse: 'nu-qr', attr: { role: 'img', 'aria-label': t('nutzer.totp_schritt1') } });
      try { qrZeichnen(canvas, qrErzeugen(String(daten.uri || '')), 5, 4); } catch { canvas.replaceWith(hinweis(t('nutzer.totp_qr_fehl'), 'warnung')); }
      const geheimnis = eingabe({ wert: String(daten.geheimnis || ''), nurLesen: true, klasse: 'vw-mono', spellcheck: false });
      geheimnis.addEventListener('focus', () => geheimnis.select());
      const kopierKnopf = knopf(t('nutzer.kopieren'), { art: 'zweit', beiKlick: async () => melden(ctx, t((await kopieren(geheimnis.value)) ? 'nutzer.kopiert' : 'nutzer.kopieren_fehl'), 'info') });
      const code = eingabe({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, muster: '[0-9]{6}', spellcheck: false });
      form.append(
        el('h3', { klasse: 'nu-schritt', text: t('nutzer.totp_schritt1') }),
        el('p', { klasse: 'erklaerung', text: t('nutzer.totp_schritt1_erklaerung') }),
        el('div', { klasse: 'nu-qr-rahmen' }, canvas),
        feld({ label: t('nutzer.totp_geheimnis'), eingabe: el('div', { klasse: 'nu-zeile' }, geheimnis, kopierKnopf) }),
        el('h3', { klasse: 'nu-schritt', text: t('nutzer.totp_schritt2') }),
        el('p', { klasse: 'erklaerung', text: t('nutzer.totp_schritt2_erklaerung') }),
        feld({ label: t('nutzer.totp_code'), eingabe: code }),
        fz.element,
      );
      inhalt.appendChild(form);
      griff.knoepfe[0].after(knopf(t('nutzer.totp_bestaetigen'), { beiKlick: () => form.requestSubmit() }));
      griff.knoepfe.push(griff.knoepfe[0].nextSibling);
      code.focus();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const wert = code.value.replace(/\s+/g, '');
        if (!/^\d{6}$/.test(wert)) { fz.zeigen(t('nutzer.totp_code_fehler')); code.focus(); return; }
        griff.beschaeftigt(true);
        try {
          const r = await api(ctx, 'nutzer.totp.bestaetigen', { name: ich.name, code: wert });
          griff.schliessen();
          melden(ctx, t('nutzer.totp_aktiv'), 'erfolg');
          const codes = (r && r.wiederherstellungscodes) || [];
          dialogWiederherstellungscodes(codes);
          ich.totp = true; await ichAktualisieren();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); code.select(); }
      });
    }

    function dialogWiederherstellungscodes(codes) {
      const liste = el('div', { klasse: 'vw-codes' }, codes.map((c) => el('code', { text: String(c) })));
      const text = `FAH-NAS – Wiederherstellungscodes für ${ich.name}\n${new Date().toLocaleString(gebiet())}\n\n${codes.join('\n')}\n`;
      dialogOeffnen({ ctx, titel: t('nutzer.totp_codes_titel'), schliessenText: t('nutzer.schliessen'),
        inhalt: el('div', {}, hinweis(t('nutzer.totp_codes_erklaerung'), 'warnung'), liste),
        knoepfe: [
          { text: t('nutzer.kopieren'), art: 'zweit', beiKlick: async () => melden(ctx, t((await kopieren(codes.join('\n'))) ? 'nutzer.kopiert' : 'nutzer.kopieren_fehl'), 'info') },
          { text: t('nutzer.totp_codes_herunterladen'), art: 'zweit', beiKlick: () => herunterladenText(`fahnas-wiederherstellungscodes-${ich.name}.txt`, text) },
          { text: t('nutzer.totp_codes_gesichert'), beiKlick: (g) => g.schliessen() },
        ] });
    }

    function dialogTotpEntfernen() {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const pw = eingabe({ typ: 'password', autocomplete: 'current-password', maxlength: 256 });
      form.append(el('p', { text: t('nutzer.totp_entfernen_erklaerung') }), feld({ label: t('nutzer.totp_entfernen_passwort'), eingabe: pw }), fz.element);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.totp_entfernen_titel'), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.totp_entfernen_knopf'), art: 'gefahr', absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!pw.value) { fz.zeigen(t('nutzer.totp_entfernen_erklaerung')); pw.focus(); return; }
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'nutzer.totp.entfernen', { name: ich.name, passwort: pw.value });
          melden(ctx, t('nutzer.totp_entfernt'), 'erfolg'); griff.schliessen();
          ich.totp = false; await ichAktualisieren();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); pw.select(); }
      });
    }

    kontoZeichnen();
    if (!admin) return; // Rolle nutzer: nur „Mein Konto“

    // ---- Nutzertabelle (admin) -------------------------------------------------------------------------------
    async function ladenAlles() {
      leeren(nutzerKarte); nutzerKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.liste_titel') }), leerHinweis(t('nutzer.laden')));
      try {
        const [n, g] = await Promise.all([api(ctx, 'nutzer.liste', {}), api(ctx, 'nutzer.gruppen', {})]);
        nutzerListe = Array.isArray(n) ? n : (n && n.nutzer) || [];
        gruppenListe = Array.isArray(g) ? g : (g && g.gruppen) || [];
      } catch (e) {
        leeren(nutzerKarte); nutzerKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.liste_titel') }), hinweis(`${t('nutzer.lade_fehl')} ${fehlerText(e)}`, 'fehler'));
        leeren(gruppenKarte); gruppenKarte.append(el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.gruppen_titel') }), hinweis(t('nutzer.gruppen_lade_fehl'), 'warnung'));
        return;
      }
      nutzerZeichnen(); gruppenZeichnen();
    }

    function nutzerZeichnen() {
      leeren(nutzerKarte);
      nutzerKarte.appendChild(el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.liste_titel') }));
      if (!nutzerListe.length) { nutzerKarte.appendChild(leerHinweis(t('nutzer.keine'))); return; }
      const tab = tabelle([
        { text: t('nutzer.spalte_name') }, { text: t('nutzer.spalte_anzeigename') }, { text: t('nutzer.spalte_rolle') }, { text: t('nutzer.spalte_gruppen') },
        { text: t('nutzer.spalte_totp'), klasse: 'vw-mitte' }, { text: t('nutzer.spalte_gesperrt'), klasse: 'vw-mitte' }, { text: t('nutzer.spalte_anmeldung') }, { text: t('nutzer.spalte_aktionen') },
      ], [], { klasse: 'nu-tabelle' });
      for (const n of nutzerListe) {
        const istIch = n.name === ich.name;
        const aktionen = el('td', { klasse: 'vw-aktionen' },
          knopf(t('nutzer.bearbeiten'), { art: 'zweit', klein: true, beiKlick: () => dialogNutzer(n) }),
          knopf(t('nutzer.passwort_setzen'), { art: 'zweit', klein: true, beiKlick: () => dialogPasswortSetzen(n) }),
          knopf(t('nutzer.zugriff'), { art: 'zweit', klein: true, beiKlick: () => dialogZugriff(n) }),
          istIch ? null : knopf(t(n.gesperrt ? 'nutzer.entsperren' : 'nutzer.sperren'), { art: 'zweit', klein: true, beiKlick: () => sperrenUmschalten(n) }),
          istIch ? null : knopf(t('nutzer.abmelden'), { art: 'zweit', klein: true, beiKlick: () => sitzungenBeenden(n) }),
          istIch ? null : knopf(t('nutzer.loeschen'), { art: 'gefahr', klein: true, beiKlick: () => dialogLoeschen(n) }));
        const nutzerZeile = tabellenzeile(tab.koerper, [
          el('td', { klasse: 'nu-name-zelle' }, avatarKnoten({ name: n.name, anzeige: n.anzeigename || n.name, groesse: 28 }), el('span', { klasse: 'vw-mono', text: n.name }), istIch ? el('span', { klasse: 'vw-gedaempft', text: ` (${t('nutzer.du')})` }) : null),
          n.anzeigename || '',
          t(n.rolle === 'admin' ? 'nutzer.rolle_admin' : 'nutzer.rolle_nutzer'),
          (n.gruppen || []).map((g) => `@${g}`).join(', '),
          el('td', { klasse: 'vw-mitte', text: t(n.totp ? 'nutzer.ja' : 'nutzer.nein') }),
          el('td', { klasse: `vw-mitte ${n.gesperrt ? 'vw-rot' : ''}`.trim(), text: t(n.gesperrt ? 'nutzer.ja' : 'nutzer.nein') }),
          n.letzte_anmeldung ? fmt.zeit(n.letzte_anmeldung) : t('nutzer.nie'),
          aktionen,
        ], { klasse: n.gesperrt ? 'nu-gesperrt' : '' });
        nutzerZeile.dataset.suchziel = n.name;
      }
      nutzerKarte.appendChild(tab.element);
    }

    function gruppenKaestchen(ausgewaehlt) {
      const eingaben = [];
      const box = el('div', { klasse: 'vw-kaestchen-liste' });
      for (const g of gruppenListe) {
        const cb = el('input', { typ: 'checkbox', wert: g.name, id: undefined });
        cb.checked = (ausgewaehlt || []).includes(g.name);
        eingaben.push(cb);
        box.appendChild(el('label', { klasse: 'vw-kaestchen' }, cb, el('span', { klasse: 'vw-mono', text: `@${g.name}` })));
      }
      return { element: gruppenListe.length ? box : el('p', { klasse: 'vw-gedaempft', text: t('nutzer.gruppen_keine') }), werte: () => eingaben.filter((e) => e.checked).map((e) => e.value) };
    }

    function dialogNutzer(n) {
      const neu = !n;
      const form = el('form', { attr: { novalidate: 'novalidate', autocomplete: 'off' } });
      const fz = fehlerzeile();
      const name = eingabe({ wert: neu ? '' : n.name, maxlength: 31, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      name.setAttribute('autocapitalize', 'none');
      const anzeigename = eingabe({ wert: neu ? '' : n.anzeigename || '', maxlength: 100, autocomplete: 'off' });
      const rolle = auswahl({ optionen: [{ wert: 'nutzer', text: t('nutzer.rolle_nutzer') }, { wert: 'admin', text: t('nutzer.rolle_admin') }], wert: neu ? 'nutzer' : n.rolle });
      const gruppen = gruppenKaestchen(neu ? [] : n.gruppen);
      const pw = neu ? passwortfelder(t, { labelNeu: t('nutzer.passwort'), erklaerung: t('nutzer.passwort_erklaerung'), labelWiederholung: t('nutzer.passwort_wiederholung') }) : null;
      const gesperrt = neu ? null : schalter({ label: t('nutzer.gesperrt'), erklaerung: t('nutzer.gesperrt_erklaerung'), wert: !!n.gesperrt });
      if (gesperrt && n.name === ich.name) gesperrt.eingabe.disabled = true;
      form.append(...[
        fz.element,
        neu ? null : avatarBlock(n.name, n.anzeigename || n.name),
        feld({ label: t('nutzer.name'), erklaerung: neu ? t('nutzer.name_erklaerung') : t('nutzer.name_erklaerung_aendern'), eingabe: name }),
        feld({ label: t('nutzer.anzeigename'), erklaerung: t('nutzer.anzeigename_erklaerung'), eingabe: anzeigename }),
        ...(pw ? pw.elemente : []),
        feld({ label: t('nutzer.rolle'), erklaerung: t('nutzer.rolle_erklaerung'), eingabe: rolle }),
        el('div', { klasse: 'vw-feld' }, el('span', { klasse: 'vw-label', text: t('nutzer.gruppen') }), gruppen.element, el('p', { klasse: 'erklaerung', text: t('nutzer.gruppen_erklaerung') })),
        gesperrt ? gesperrt.element : null,
      ].filter(Boolean)); // append(null) schriebe den Text „null“ (neuer Nutzer hat keinen Sperr-Schalter)
      const griff = dialogOeffnen({ ctx, titel: neu ? t('nutzer.dialog_neu') : t('nutzer.dialog_bearbeiten', { name: n.name }), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t(neu ? 'nutzer.anlegen' : 'nutzer.speichern'), absenden: true }] });
      if (!neu) anzeigename.focus();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        name.value = name.value.trim().toLowerCase(); // „M.mustermann“ → m.mustermann (die Anmeldung macht es genauso)
        const regeln = [{ eingabe: name, pruefen: (w) => (MUSTER_NUTZERNAME.test(w.trim()) ? null : t('nutzer.name_fehler')) }, ...(pw ? pw.pruefregeln : [])];
        if (!felderPruefen(regeln, fz)) return;
        const umbenennen = !neu && name.value !== n.name;
        const frage = n.name === ich.name ? t('nutzer.umbenennen_frage_selbst', { neu: name.value }) : t('nutzer.umbenennen_frage', { alt: n.name, neu: name.value });
        if (umbenennen && !(await bestaetigen(ctx, frage))) return;
        griff.beschaeftigt(true);
        try {
          if (neu) {
            await api(ctx, 'nutzer.anlegen', { name: name.value, anzeigename: anzeigename.value.trim() || name.value, passwort: pw.wert(), rolle: rolle.value, gruppen: gruppen.werte() });
            melden(ctx, t('nutzer.angelegt', { name: name.value }), 'erfolg');
          } else {
            const params = { name: n.name, anzeigename: anzeigename.value.trim() || n.name, rolle: rolle.value, gruppen: gruppen.werte() };
            if (n.name !== ich.name) params.gesperrt = gesperrt.eingabe.checked;
            await api(ctx, 'nutzer.aendern', params);
            if (umbenennen) {
              await api(ctx, 'nutzer.umbenennen', { name: n.name, neu: name.value });
              if (n.name === ich.name) { // eigene Anmeldung endete – mit dem neuen Namen neu anmelden
                melden(ctx, t('nutzer.umbenannt_selbst', { neu: name.value }), 'erfolg');
                griff.schliessen(); setTimeout(() => location.reload(), 2500);
                return;
              }
              melden(ctx, t('nutzer.umbenannt', { alt: n.name, neu: name.value }), 'erfolg');
            } else melden(ctx, t('nutzer.gespeichert', { name: n.name }), 'erfolg');
          }
          griff.schliessen(); await ladenAlles();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); if (e && e.details && e.details.feld === 'name') name.focus(); }
      });
    }

    function dialogPasswortSetzen(n) {
      const form = el('form', { attr: { novalidate: 'novalidate', autocomplete: 'off' } });
      const fz = fehlerzeile();
      const pw = passwortfelder(t, { labelNeu: t('nutzer.passwort_neu'), erklaerung: t('nutzer.passwort_setzen_erklaerung'), labelWiederholung: t('nutzer.passwort_wiederholung') });
      form.append(fz.element, ...pw.elemente);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.passwort_setzen_titel', { name: n.name }), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.speichern'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen(pw.pruefregeln, fz)) return;
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'nutzer.passwort', { name: n.name, passwort: pw.wert() });
          melden(ctx, t('nutzer.passwort_gesetzt', { name: n.name }), 'erfolg'); griff.schliessen();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      });
    }

    // ---- Zugriff aus Sicht des Nutzers (Betreiber 12.10.2026: „Worauf hat Anna Zugriff?“) ---------------------------
    async function dialogZugriff(n) {
      const inhalt = el('div', { klasse: 'nu-zugriff' }, leerHinweis(t('nutzer.zugriff_laden')));
      const fz = fehlerzeile();
      let freigaben = [];
      const wahl = new Map(); // Freigabe → kein | lesen | schreiben (direkt für diesen Nutzer)
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.zugriff_titel', { name: n.name }), inhalt: el('div', {}, fz.element, inhalt), breit: true, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.speichern'), beiKlick: speichern }] });
      let heim = null;
      try {
        const [r, h] = await Promise.all([api(ctx, 'freigaben.liste', {}), api(ctx, 'heim.liste', {}).catch(() => [])]);
        freigaben = Array.isArray(r) ? r : (r && r.freigaben) || [];
        heim = (Array.isArray(h) ? h : []).find((x) => x.name === n.name) || { aktiv: false, groesse_gb: null, belegt: null };
      } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
      leeren(inhalt);
      // Persönlicher Ordner mit eigener Grenze (12.10.2026: „Kontingent je Nutzer“)
      const heimAn = schalter({ label: t('nutzer.heim'), erklaerung: t('nutzer.heim_erklaerung', { name: n.name }), wert: heim.aktiv });
      const heimGb = eingabe({ typ: 'number', wert: heim.groesse_gb || 0, min: 0, max: 1000000, schritt: 1, inputmode: 'numeric' });
      const heimBelegt = heim.aktiv && heim.belegt !== null ? el('p', { klasse: 'erklaerung', text: t('nutzer.heim_belegt', { belegt: fmt.groesse(heim.belegt), grenze: heim.groesse_gb ? `${heim.groesse_gb} GB` : t('nutzer.heim_unbegrenzt') }) }) : null;
      inhalt.append(el('h3', { klasse: 'nu-abschnitt', text: t('nutzer.heim_titel') }), heimAn.element, feld({ label: t('nutzer.heim_grenze'), erklaerung: t('nutzer.heim_grenze_erklaerung', { name: n.name }), eingabe: heimGb }), heimBelegt || '',
        el('h3', { klasse: 'nu-abschnitt', text: t('nutzer.zugriff_freigaben') }));
      if (n.rolle === 'admin') { inhalt.appendChild(hinweis(t('nutzer.zugriff_admin'), 'info')); return; }
      if (!freigaben.length) { inhalt.appendChild(leerHinweis(t('nutzer.zugriff_keine_freigaben'))); return; }
      const gruppen = (n.gruppen || []).map((g) => `@${g}`);
      inhalt.appendChild(el('p', { klasse: 'erklaerung', text: t('nutzer.zugriff_erklaerung') }));
      const tab = tabelle([{ text: t('nutzer.zugriff_freigabe') }, { text: t('nutzer.zugriff_kein'), klasse: 'vw-mitte' }, { text: t('nutzer.zugriff_lesen'), klasse: 'vw-mitte' }, { text: t('nutzer.zugriff_schreiben'), klasse: 'vw-mitte' }, { text: t('nutzer.zugriff_geerbt') }], [], { klasse: 'nu-zugriff-tabelle' });
      for (const f of freigaben) {
        const direkt = (f.schreiben || []).includes(n.name) ? 'schreiben' : (f.lesen || []).includes(n.name) ? 'lesen' : 'kein';
        wahl.set(f.name, direkt);
        const ueber = gruppen.find((g) => (f.schreiben || []).includes(g)) ? ['schreiben', gruppen.find((g) => (f.schreiben || []).includes(g))]
          : gruppen.find((g) => (f.lesen || []).includes(g)) ? ['lesen', gruppen.find((g) => (f.lesen || []).includes(g))] : null;
        const geerbt = f.gaeste ? t('nutzer.zugriff_gaeste') : ueber ? t(ueber[0] === 'schreiben' ? 'nutzer.zugriff_ueber_schreiben' : 'nutzer.zugriff_ueber_lesen', { gruppe: ueber[1] }) : '–';
        const radios = ['kein', 'lesen', 'schreiben'].map((stufe) => {
          const r = el('input', { typ: 'radio', attr: { name: `zugriff-${f.name}`, 'aria-label': `${f.name}: ${t(ZUGRIFF_TEXT[stufe])}` } });
          r.checked = direkt === stufe;
          r.addEventListener('change', () => { if (r.checked) wahl.set(f.name, stufe); });
          return el('td', { klasse: 'vw-mitte' }, r);
        });
        tabellenzeile(tab.koerper, [el('td', {}, el('span', { klasse: 'vw-mono', text: f.name }), f.extern ? el('span', { klasse: 'vw-gedaempft', text: ` (${t('nutzer.zugriff_laufwerk')})` }) : null), ...radios, el('td', { klasse: 'vw-gedaempft', text: geerbt })]);
      }
      inhalt.appendChild(tab.element);

      async function speichern(g) {
        fz.leeren(); g.beschaeftigt(true);
        try {
          let geaendert = 0;
          const gb = Number(heimGb.value) || 0;
          if (heimAn.eingabe.checked !== heim.aktiv || (heimAn.eingabe.checked && gb !== (heim.groesse_gb || 0))) {
            await api(ctx, 'heim.setzen', { name: n.name, aktiv: heimAn.eingabe.checked, groesse_gb: gb });
            geaendert += 1;
          }
          for (const f of freigaben) {
            if (!wahl.has(f.name)) continue; // Admins: keine Tabelle – Freigaben bleiben unangetastet
            const soll = wahl.get(f.name);
            const lesen = (f.lesen || []).filter((x) => x !== n.name); const schreiben = (f.schreiben || []).filter((x) => x !== n.name);
            if (soll === 'lesen') lesen.push(n.name); else if (soll === 'schreiben') schreiben.push(n.name);
            if (JSON.stringify(lesen) === JSON.stringify(f.lesen || []) && JSON.stringify(schreiben) === JSON.stringify(f.schreiben || [])) continue;
            await api(ctx, 'freigaben.aendern', { name: f.name, lesen, schreiben });
            geaendert += 1;
          }
          melden(ctx, geaendert ? t('nutzer.zugriff_gespeichert', { name: n.name, n: geaendert }) : t('nutzer.zugriff_unveraendert'), 'erfolg');
          g.schliessen();
        } catch (e) { g.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      }
    }

    async function sitzungenBeenden(n) {
      if (!(await bestaetigen(ctx, t('nutzer.abmelden_frage', { name: n.name })))) return;
      try { await post(ctx, '/api/sitzungen/beenden', { nutzer: n.name }); melden(ctx, t('nutzer.abgemeldet_meldung', { name: n.name }), 'erfolg'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }

    async function sperrenUmschalten(n) {
      if (!n.gesperrt && !(await bestaetigen(ctx, t('nutzer.sperren_frage', { name: n.name })))) return;
      try {
        await api(ctx, 'nutzer.aendern', { name: n.name, gesperrt: !n.gesperrt });
        melden(ctx, t(n.gesperrt ? 'nutzer.entsperrt_meldung' : 'nutzer.gesperrt_meldung', { name: n.name }), 'erfolg');
        await ladenAlles();
      } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }

    function dialogLoeschen(n) {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const wahl = radiogruppe({ wert: 'behalten', optionen: [
        { wert: 'behalten', text: t('nutzer.loeschen_behalten'), erklaerung: t('nutzer.loeschen_behalten_erklaerung') },
        { wert: 'loeschen', text: t('nutzer.loeschen_loeschen'), erklaerung: t('nutzer.loeschen_loeschen_erklaerung') },
      ] });
      form.append(el('p', { text: t('nutzer.loeschen_erklaerung') }), el('div', { klasse: 'vw-feld' }, wahl.element), fz.element);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.loeschen_titel', { name: n.name }), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.loeschen_knopf'), art: 'gefahr', absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'nutzer.loeschen', { name: n.name, dateien: wahl.wert() || 'behalten' });
          melden(ctx, t('nutzer.geloescht', { name: n.name }), 'erfolg'); griff.schliessen(); await ladenAlles();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      });
    }

    // ---- Gruppen (admin) -------------------------------------------------------------------------------------
    function gruppenZeichnen() {
      leeren(gruppenKarte);
      gruppenKarte.append(
        el('div', { klasse: 'vw-karte-kopf' }, el('h2', { klasse: 'vw-karte-titel', text: t('nutzer.gruppen_titel') }), knopf(t('nutzer.gruppe_neu'), { art: 'zweit', beiKlick: dialogGruppeNeu })),
        el('p', { klasse: 'erklaerung', text: t('nutzer.gruppen_untertitel') }),
      );
      if (!gruppenListe.length) { gruppenKarte.appendChild(leerHinweis(t('nutzer.gruppen_keine'))); return; }
      const ul = el('ul', { klasse: 'vw-liste nu-gruppen' });
      for (const g of gruppenListe) {
        const mitglieder = g.mitglieder || nutzerListe.filter((n) => (n.gruppen || []).includes(g.name)).map((n) => n.name);
        ul.appendChild(el('li', { attr: { 'data-suchziel': `@${g.name}` } },
          el('span', { klasse: 'vw-liste-name' }, el('span', { klasse: 'vw-mono', text: `@${g.name}` }), ' ', el('span', { klasse: 'vw-gedaempft nu-mitglieder', text: mitglieder.length ? `${t('nutzer.gruppe_mitglieder_anzahl', { anzahl: mitglieder.length })}: ${mitglieder.join(', ')}` : t('nutzer.gruppe_keine_mitglieder') })),
          knopf(t('nutzer.gruppe_mitglieder'), { art: 'zweit', klein: true, beiKlick: () => dialogMitglieder(g, mitglieder) }),
          knopf(t('nutzer.gruppe_loeschen'), { art: 'gefahr', klein: true, beiKlick: () => gruppeLoeschen(g) })));
      }
      gruppenKarte.appendChild(ul);
    }

    function dialogGruppeNeu() {
      const form = el('form', { attr: { novalidate: 'novalidate', autocomplete: 'off' } });
      const fz = fehlerzeile();
      const name = eingabe({ maxlength: 31, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      name.setAttribute('autocapitalize', 'none');
      form.append(fz.element, feld({ label: t('nutzer.gruppe_name'), erklaerung: t('nutzer.gruppe_name_erklaerung'), eingabe: name }));
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.gruppe_neu'), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('nutzer.anlegen'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([{ eingabe: name, pruefen: (w) => (MUSTER_GRUPPE.test(w.trim()) ? null : t('nutzer.gruppe_name_fehler')) }], fz)) return;
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'nutzer.gruppe.anlegen', { name: name.value.trim() });
          melden(ctx, t('nutzer.gruppe_angelegt', { name: name.value.trim() }), 'erfolg'); griff.schliessen(); await ladenAlles();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      });
    }

    async function gruppeLoeschen(g) {
      if (!(await bestaetigen(ctx, t('nutzer.gruppe_loeschen_frage', { name: g.name })))) return;
      try { await api(ctx, 'nutzer.gruppe.loeschen', { name: g.name }); melden(ctx, t('nutzer.gruppe_geloescht', { name: g.name }), 'erfolg'); await ladenAlles(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }

    function dialogMitglieder(g, mitglieder) {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const kaestchen = [];
      const box = el('div', { klasse: 'vw-kaestchen-liste' });
      for (const n of nutzerListe) {
        const cb = el('input', { typ: 'checkbox', wert: n.name }); cb.checked = mitglieder.includes(n.name);
        kaestchen.push({ cb, n, vorher: cb.checked });
        box.appendChild(el('label', { klasse: 'vw-kaestchen' }, cb, el('span', { klasse: 'vw-mono', text: n.name }), n.anzeigename && n.anzeigename !== n.name ? el('span', { klasse: 'vw-gedaempft', text: ` ${n.anzeigename}` }) : null));
      }
      form.append(el('p', { klasse: 'erklaerung', text: t('nutzer.gruppe_mitglieder_erklaerung') }), box, fz.element);
      const griff = dialogOeffnen({ ctx, titel: t('nutzer.gruppe_mitglieder_titel', { name: g.name }), inhalt: form, schliessenText: t('nutzer.schliessen'),
        knoepfe: [{ text: t('nutzer.abbrechen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }, { text: t('nutzer.speichern'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        griff.beschaeftigt(true);
        try {
          for (const { cb, n, vorher } of kaestchen) {
            if (cb.checked === vorher) continue;
            const gruppen = new Set(n.gruppen || []);
            if (cb.checked) gruppen.add(g.name); else gruppen.delete(g.name);
            await api(ctx, 'nutzer.aendern', { name: n.name, gruppen: [...gruppen] });
          }
          melden(ctx, t('nutzer.gruppe_gespeichert', { name: g.name }), 'erfolg'); griff.schliessen(); await ladenAlles();
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      });
    }

    await ladenAlles();
    abmelder.push(abo(ctx, 'konfig', (e) => { const d = e && e.daten ? e.daten : e; if (!d || !d.bereich || d.bereich === 'nutzer') ladenAlles(); }));
  },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
