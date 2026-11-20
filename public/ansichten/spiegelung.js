// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Spiegelung“ (admin): Ordner automatisch abgleichen – Karte je Spiegelung mit Zustand und Live-Fortschritt,
// getrennt nach Art: Sicherungen und Spiegelungen (Betreiber 09.11.2026: „besser sehen, was was ist“),
// Dialog zum Anlegen/Bearbeiten (Quelle/Ziel per Ordnerwahl, Richtung, Auslöser), Vorschau, Protokoll.
// Agent-Aktionen spiegelung.* (docs/schnittstellen.md §14), Ereignis „spiegelung“ für den Fortschritt.

import {
  el, leeren, anhaengen, stilLaden, eingabe, auswahl, feld, schalter, radiogruppe, knopf, fehlerzeile, hinweis, leerHinweis,
  badge, ampel, fortschritt, dialogOeffnen, alleDialogeSchliessen, api, fehlerText, melden, bestaetigen, abo, aufgabeStarten,
  kopfzeile, karte, formatierer, uebersetzer,
} from './verwaltung-hilfen.js';
import { suchzielAnspringen } from './verwaltung-hilfen.js';
import { assistentOeffnen, versionenAuswahl, versionenZeigen } from './sicherung-assistent.js';

/** Verbindungsarten (anderes NAS per SMB oder Cloud-Speicher über rclone). */
const ANBIETER_TEXT = Object.freeze({ smb: 'spiegelung.fern_art_smb', s3: 'spiegelung.fern_art_s3', b2: 'spiegelung.fern_art_b2', webdav: 'spiegelung.fern_art_webdav', sftp: 'spiegelung.fern_art_sftp' });

let zuletztT = (k) => k;
const abmelder = [];
let uhr = null;

/** Wochentage in Anzeige-Reihenfolge (Mo zuerst) → Sprachschlüssel. */
const TAGE = Object.freeze([[1, 'spiegelung.tag_mo'], [2, 'spiegelung.tag_di'], [3, 'spiegelung.tag_mi'], [4, 'spiegelung.tag_do'], [5, 'spiegelung.tag_fr'], [6, 'spiegelung.tag_sa'], [0, 'spiegelung.tag_so']]);
const ERGEBNIS = Object.freeze({ ok: 'spiegelung.ergebnis_ok', warnung: 'spiegelung.ergebnis_warnung', fehler: 'spiegelung.ergebnis_fehler', uebersprungen: 'spiegelung.ergebnis_uebersprungen', abgebrochen: 'spiegelung.ergebnis_abgebrochen' });
const ANLASS = Object.freeze({ hand: 'spiegelung.anlass_hand', zeitplan: 'spiegelung.anlass_zeitplan', aenderung: 'spiegelung.anlass_aenderung', nachholen: 'spiegelung.anlass_nachholen', nachlauf: 'spiegelung.anlass_nachlauf', start: 'spiegelung.anlass_start' });
const AMPEL = Object.freeze({ ok: 'aktiv', warnung: 'warnung', uebersprungen: 'warnung', abgebrochen: 'warnung', fehler: 'fehler' });

/** „private/fah-sicherung“ bzw. „UGREEN: Backups/x“ – Ort, Freigabe und Unterordner als Text. */
export function seiteText(s, zugaenge = []) {
  if (!s) return '–';
  const ort = s.zugang ? `${(zugaenge.find((z) => z.id === s.zugang) || { name: '?' }).name}: ` : '';
  return `${ort}${s.pfad ? `${s.freigabe}/${s.pfad}` : s.freigabe}`;
}

/** Uhrzeiten aus einem Eingabetext „5:00, 17:30“ → ['05:00', '17:30'] (Prüfung macht der Agent). */
export function zeitenAusText(text) {
  return String(text || '').split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean).map((z) => (/^\d:\d\d$/.test(z) ? `0${z}` : z));
}

/** Auslöser als Klartext. */
export function ausloeserText(a, t) {
  if (a.ausloeser === 'aenderung') return t('spiegelung.ausloeser_aenderung_text', { n: a.wartezeit_min });
  if (a.ausloeser === 'hand') return t('spiegelung.ausloeser_hand_text');
  const zeiten = (a.zeiten || []).join(', ');
  if ((a.tage || []).length === 7) return t('spiegelung.ausloeser_taeglich_text', { zeiten });
  const tage = TAGE.filter(([d]) => (a.tage || []).includes(d)).map(([, k]) => t(k)).join(', ');
  return t('spiegelung.ausloeser_tage_text', { tage, zeiten });
}

/** Zahlen eines Laufs als kurzer Text. */
export function zahlenText(l, t, fmt) {
  const z = l && l.zahlen;
  if (!z) return '';
  if (z.bytes_uebertragen !== undefined || z.geloescht !== undefined) {
    return t('spiegelung.zahlen_einseitig', { n: z.uebertragen || 0, geloescht: z.geloescht || 0, groesse: fmt.groesse(z.bytes_uebertragen || 0) });
  }
  return t('spiegelung.zahlen_beidseitig', { n: z.uebertragen || 0, uebersprungen: z.uebersprungen || 0 });
}

/** Art eines Auftrags (der Agent liefert sie mit; Rückfall wie im Agenten: nur Assistenten-Ziel „FAH-NAS/…“ = Sicherung). */
export function artVon(a) {
  if (a && (a.art === 'sicherung' || a.art === 'spiegelung')) return a.art;
  const p = (a && a.ziel && typeof a.ziel.pfad === 'string') ? a.ziel.pfad : '';
  return a && a.richtung !== 'beidseitig' && (p === 'FAH-NAS' || p.startsWith('FAH-NAS/')) ? 'sicherung' : 'spiegelung';
}

/** Aufträge nach Art gruppieren: Sicherungen zuerst. */
export function nachArt(auftraege) {
  const g = { sicherung: [], spiegelung: [] };
  for (const a of auftraege || []) g[artVon(a)].push(a);
  return g;
}

/** Symbol aus symbole.svg über ctx.symbol (ohne ctx.symbol: nichts). */
function artSymbol(ctx, art) {
  if (typeof ctx.symbol !== 'function') return null;
  try { return ctx.symbol(art === 'sicherung' ? 'sicherung' : 'spiegelung', 'sp-art-symbol'); } catch { return null; }
}

function daten(ev) { return ev && ev.daten && typeof ev.daten === 'object' ? ev.daten : ev; }

export default {
  id: 'spiegelung',
  symbol: 'spiegelung',
  rolle: 'admin',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('spiegelung.titel'); },

  async einbinden(wurzel, ctx) {
    suchzielAnspringen(wurzel, ctx.route); // Suche/„Beheben“: #/spiegelung/ziel/<name>
    stilLaden();
    stilLaden(new URL('./spiegelung.css', import.meta.url).href);
    const t = uebersetzer(ctx); zuletztT = t;
    const fmt = formatierer(ctx);
    const relativ = (iso) => (ctx.format && typeof ctx.format.zeit === 'function' ? ctx.format.zeit(iso) : fmt.zeit(iso));
    leeren(wurzel);
    wurzel.classList.add('sp-wurzel');

    // Geführt (Assistent) als Hauptweg, alle Möglichkeiten über „Neue Spiegelung“
    const assistent = (zielFreigabe = null) => assistentOeffnen(ctx, t, { zielFreigabe, verbindungAnlegen: () => new Promise((ok) => zugangBearbeiten(null, ok)), fertig: () => laden() });
    const neuKnopf = el('div', { klasse: 'vw-knopfleiste' }, knopf(t('spiegelung.sa_titel'), { beiKlick: () => assistent() }), knopf(t('spiegelung.neu'), { art: 'zweit', beiKlick: () => bearbeiten(null) }));
    const liste = el('div', { klasse: 'sp-gruppen' });
    const fernListe = el('div', { klasse: 'sp-fern-liste' });
    const fernKarte = karte(t('spiegelung.fern_titel'), el('p', { klasse: 'erklaerung', text: t('spiegelung.fern_erklaerung') }), fernListe,
      el('div', { klasse: 'vw-knopfleiste' }, knopf(t('spiegelung.fern_neu'), { art: 'zweit', beiKlick: () => zugangBearbeiten(null) })));
    anhaengen(wurzel, [kopfzeile(t('spiegelung.titel'), t('spiegelung.untertitel'), neuKnopf), liste, fernKarte]);

    let auftraege = [];
    let freigaben = [];
    let zugaenge = []; // Verbindungen zu anderen NAS (ohne Passwörter)
    const karten = new Map(); // id → {balken, meldung, element}

    async function freigabenLaden() {
      try { const r = await api(ctx, 'freigaben.liste', {}); freigaben = Array.isArray(r) ? r : (r && r.freigaben) || []; } catch { freigaben = []; }
    }

    async function laden() {
      try {
        const [r, z] = await Promise.all([api(ctx, 'spiegelung.liste', {}), api(ctx, 'spiegelung.zugaenge', {})]);
        auftraege = (r && Array.isArray(r.auftraege)) ? r.auftraege : [];
        zugaenge = Array.isArray(z) ? z : [];
        zeichnen(); fernZeichnen();
      } catch (e) { leeren(liste); liste.appendChild(hinweis(fehlerText(e), 'fehler')); }
    }

    // ---- Andere NAS (Verbindungen) -------------------------------------------------------------------------------
    function fernZeichnen() {
      leeren(fernListe);
      if (!zugaenge.length) { fernListe.appendChild(leerHinweis(t('spiegelung.fern_leer'))); return; }
      for (const z of zugaenge) {
        fernListe.appendChild(el('div', { klasse: 'sp-fern' },
          el('div', { klasse: 'sp-fern-text' }, el('strong', { text: `${z.art === 'cloud' ? '☁ ' : ''}${z.name}` }), el('span', { klasse: 'sp-weg', text: z.art === 'cloud' ? ` ${t(ANBIETER_TEXT[z.anbieter] || ANBIETER_TEXT.s3)} · ${z.adresse}` : ` ${z.benutzer}@${z.adresse}` }),
            el('span', { klasse: 'vw-gedaempft', text: ` · ${t('spiegelung.fern_benutzt', { n: z.benutzt || 0 })}` })),
          el('div', { klasse: 'vw-knopfleiste sp-knoepfe' },
            knopf(t('spiegelung.fern_pruefen'), { art: 'zweit', klein: true, beiKlick: () => zugangPruefen(z) }),
            knopf(t('spiegelung.bearbeiten'), { art: 'zweit', klein: true, beiKlick: () => zugangBearbeiten(z) }),
            knopf(t('spiegelung.loeschen'), { art: 'gefahr', klein: true, deaktiviert: (z.benutzt || 0) > 0, titel: (z.benutzt || 0) > 0 ? t('spiegelung.fern_loeschen_gesperrt') : undefined, beiKlick: async () => {
              if (!await bestaetigen(ctx, t('spiegelung.fern_loeschen_frage', { name: z.name }))) return;
              await aufruf('spiegelung.zugang.loeschen', { id: z.id }, t('spiegelung.geloescht', { name: z.name }));
            } }))));
      }
    }

    async function zugangPruefen(z) {
      const inhalt = el('div', {}, leerHinweis(t('spiegelung.fern_verbinde', { adresse: z.adresse })));
      dialogOeffnen({ ctx, titel: t('spiegelung.fern_pruefen_titel', { name: z.name }), inhalt, schliessenText: t('spiegelung.schliessen'), knoepfe: [{ text: t('spiegelung.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }] });
      try {
        const r = await api(ctx, 'spiegelung.zugang.pruefen', { id: z.id });
        const fl = (r && r.freigaben) || [];
        leeren(inhalt);
        inhalt.append(hinweis(t('spiegelung.fern_ok', { n: fl.length }), 'info'), el('ul', { klasse: 'sp-fern-freigaben' }, fl.map((f) => el('li', { text: f.kommentar ? `${f.name} – ${f.kommentar}` : f.name }))));
      } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); }
    }

    function zugangBearbeiten(z, nachher = null) {
      const fz = fehlerzeile();
      const art0 = z && z.art === 'cloud' ? z.anbieter : 'smb';
      const art = auswahl({ optionen: Object.keys(ANBIETER_TEXT).map((a) => ({ wert: a, text: t(ANBIETER_TEXT[a]) })), wert: art0 });
      if (z) art.disabled = true; // Art einer bestehenden Verbindung bleibt (Spiegelungen hängen daran)
      const name = eingabe({ maxlength: 40, wert: z ? z.name : '', platzhalter: 'UGREEN' });
      const adresse = eingabe({ maxlength: 260, wert: z && (z.art !== 'cloud' || z.anbieter === 'sftp') ? z.adresse : '', platzhalter: '192.168.1.23', spellcheck: false });
      const port = eingabe({ typ: 'number', min: 1, max: 65535, wert: (z && z.port) || 22 });
      const endpunkt = eingabe({ maxlength: 500, wert: (z && z.endpunkt) || '', spellcheck: false });
      const region = eingabe({ maxlength: 40, wert: (z && z.region) || '', platzhalter: 'eu-central-1', spellcheck: false });
      const hersteller = auswahl({ optionen: [{ wert: 'nextcloud', text: 'Nextcloud' }, { wert: 'owncloud', text: 'ownCloud' }, { wert: 'other', text: t('spiegelung.fern_hersteller_andere') }], wert: (z && z.hersteller) || 'nextcloud' });
      const schluesselId = eingabe({ maxlength: 128, wert: (z && z.schluessel_id) || '', autocomplete: 'off', spellcheck: false });
      const schluessel = eingabe({ typ: 'password', maxlength: 256, autocomplete: 'new-password', platzhalter: z ? t('spiegelung.fern_passwort_unveraendert') : '' });
      const benutzer = eingabe({ maxlength: 128, wert: z && z.art !== 'cloud' ? z.benutzer : (z && ['webdav', 'sftp'].includes(z.anbieter) ? z.benutzer : ''), autocomplete: 'off', spellcheck: false });
      const passwort = eingabe({ typ: 'password', maxlength: 256, autocomplete: 'new-password', platzhalter: z ? t('spiegelung.fern_passwort_unveraendert') : '' });
      const f = {
        adresse: feld({ label: t('spiegelung.fern_adresse'), erklaerung: t('spiegelung.fern_adresse_erklaerung'), eingabe: adresse }),
        port: feld({ label: t('spiegelung.fern_port'), eingabe: port }),
        endpunkt: feld({ label: t('spiegelung.fern_endpunkt'), erklaerung: t('spiegelung.fern_endpunkt_erklaerung'), eingabe: endpunkt }),
        region: feld({ label: t('spiegelung.fern_region'), erklaerung: t('spiegelung.fern_region_erklaerung'), eingabe: region }),
        hersteller: feld({ label: t('spiegelung.fern_hersteller'), eingabe: hersteller }),
        schluessel_id: feld({ label: t('spiegelung.fern_schluessel_id'), erklaerung: t('spiegelung.fern_schluessel_id_erklaerung'), eingabe: schluesselId }),
        schluessel: feld({ label: t('spiegelung.fern_schluessel'), eingabe: schluessel }),
        benutzer: feld({ label: t('spiegelung.fern_benutzer'), erklaerung: t('spiegelung.fern_benutzer_erklaerung'), eingabe: benutzer }),
        passwort: feld({ label: t('spiegelung.fern_passwort'), erklaerung: t('spiegelung.fern_passwort_erklaerung'), eingabe: passwort }),
      };
      const SICHTBAR = { smb: ['adresse', 'benutzer', 'passwort'], s3: ['endpunkt', 'region', 'schluessel_id', 'schluessel'], b2: ['schluessel_id', 'schluessel'], webdav: ['endpunkt', 'hersteller', 'benutzer', 'passwort'], sftp: ['adresse', 'port', 'benutzer', 'passwort'] };
      const artHinweis = el('p', { klasse: 'erklaerung' });
      const HINWEIS = { smb: 'spiegelung.fern_art_smb_erklaerung', s3: 'spiegelung.fern_art_s3_erklaerung', b2: 'spiegelung.fern_art_b2_erklaerung', webdav: 'spiegelung.fern_art_webdav_erklaerung', sftp: 'spiegelung.fern_art_sftp_erklaerung' };
      const sicht = () => {
        for (const [k, e] of Object.entries(f)) e.hidden = !SICHTBAR[art.value].includes(k);
        endpunkt.placeholder = art.value === 's3' ? 'https://fsn1.your-objectstorage.com' : 'https://cloud.example.de/remote.php/dav/files/NAME';
        adresse.placeholder = art.value === 'sftp' ? 'backup.example.de' : '192.168.1.23';
        artHinweis.textContent = t(HINWEIS[art.value]);
      };
      art.addEventListener('change', sicht); sicht();
      dialogOeffnen({
        beimSchliessen: () => { if (nachher) nachher(); },
        ctx, titel: z ? t('spiegelung.fern_bearbeiten_titel', { name: z.name }) : t('spiegelung.fern_neu'), schliessenText: t('spiegelung.schliessen'),
        inhalt: el('div', { klasse: 'sp-formular' },
          feld({ label: t('spiegelung.fern_art'), eingabe: art }), artHinweis,
          feld({ label: t('spiegelung.name'), erklaerung: t('spiegelung.fern_name_erklaerung'), eingabe: name }),
          ...Object.values(f), fz.element),
        knoepfe: [
          { text: t('spiegelung.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('spiegelung.speichern'), beiKlick: async (g) => {
            fz.leeren(); g.beschaeftigt(true);
            const a = art.value;
            const daten = a === 'smb'
              ? { art: 'smb', name: name.value.trim(), adresse: adresse.value.trim(), benutzer: benutzer.value.trim(), passwort: passwort.value }
              : { art: 'cloud', anbieter: a, name: name.value.trim(), adresse: adresse.value.trim(), port: Number(port.value) || 22, endpunkt: endpunkt.value.trim(), region: region.value.trim(), hersteller: hersteller.value, schluessel_id: schluesselId.value.trim(), schluessel: schluessel.value, benutzer: benutzer.value.trim(), passwort: passwort.value };
            try {
              const neu = await api(ctx, 'spiegelung.zugang.speichern', { ...(z ? { id: z.id } : {}), ...daten });
              g.schliessen(); await laden(); zugangPruefen(neu);
            } catch (e) { fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
          } },
        ],
      });
    }

    function zeichnen() {
      leeren(liste); karten.clear();
      if (!auftraege.length) { // leer → nächster Schritt statt nur „keine“
        liste.appendChild(karte(null, leerHinweis(t('spiegelung.leer')), el('div', { klasse: 'vw-knopfleiste' }, knopf(t('spiegelung.sa_erste'), { beiKlick: () => assistent() }))));
        return;
      }
      const g = nachArt(auftraege);
      for (const art of ['sicherung', 'spiegelung']) {
        const raster = el('div', { klasse: 'sp-liste' });
        if (g[art].length) for (const a of g[art]) raster.appendChild(karteFuer(a));
        else raster.appendChild(el('p', { klasse: 'vw-leer sp-gruppe-leer', text: t(`spiegelung.gruppe_${art}_leer`) }));
        liste.appendChild(el('section', { klasse: `sp-gruppe sp-art-${art}` },
          el('div', { klasse: 'sp-gruppe-kopf' }, artSymbol(ctx, art),
            el('h2', { klasse: 'sp-gruppe-titel', text: t(`spiegelung.gruppe_${art}`, { n: g[art].length }) })),
          el('p', { klasse: 'erklaerung sp-gruppe-erklaerung', text: t(`spiegelung.gruppe_${art}_erklaerung`) }),
          raster));
      }
    }

    function karteFuer(a) {
      const z = a.zustand || {};
      const l = z.letzter;
      const ampelZustand = !a.aktiv ? 'inaktiv' : (z.laeuft ? 'aktiv' : (l ? AMPEL[l.ergebnis] || 'unbekannt' : 'unbekannt'));
      const art = artVon(a);
      const kopf = el('div', { klasse: 'sp-kopf' },
        ampel(ampelZustand, l ? t(ERGEBNIS[l.ergebnis] || 'spiegelung.ergebnis_fehler') : t('spiegelung.nie_gelaufen')),
        el('h2', { klasse: 'vw-karte-titel sp-name', text: a.name }),
        el('span', { klasse: 'sp-art-plakette', attr: { title: t(`spiegelung.art_${art}_erklaerung`) } }, artSymbol(ctx, art), t(`spiegelung.art_${art}`)),
        el('span', { klasse: 'sp-richtung', text: a.richtung === 'beidseitig' ? t('spiegelung.richtung_beidseitig_kurz') : t('spiegelung.richtung_einseitig_kurz') }),
        !a.aktiv ? badge(t('spiegelung.pausiert'), null, 'warnung') : null,
        z.laeuft ? badge(t('spiegelung.laeuft'), null, 'erfolg') : null);
      const weg = el('p', { klasse: 'sp-weg' },
        el('span', { klasse: 'sp-seite', text: seiteText(a.quelle, zugaenge) }),
        el('span', { klasse: 'sp-pfeil', text: a.richtung === 'beidseitig' ? ' ↔ ' : ' → ', attr: { 'aria-hidden': 'true' } }),
        el('span', { klasse: 'sp-seite', text: seiteText(a.ziel, zugaenge) }));
      const zeilen = el('dl', { klasse: 'sp-daten' });
      const zeile = (dt, dd) => { zeilen.append(el('dt', { text: dt }), el('dd', {}, dd)); };
      zeile(t('spiegelung.ausloeser'), ausloeserText(a, t));
      if (l) {
        const teile = [`${relativ(l.ende || l.beginn)} · ${t(ERGEBNIS[l.ergebnis] || 'spiegelung.ergebnis_fehler')}`];
        const zt = zahlenText(l, t, fmt); if (zt) teile.push(zt);
        zeile(t('spiegelung.letzter_lauf'), el('span', {}, teile.join(' · '), l.meldung ? el('span', { klasse: `sp-meldung sp-meldung-${l.ergebnis}`, text: ` – ${l.meldung}` }) : null));
      } else zeile(t('spiegelung.letzter_lauf'), t('spiegelung.nie_gelaufen'));
      if (z.naechster) zeile(t('spiegelung.naechster_lauf'), fmt.zeit(z.naechster));
      if (z.ausstehend) zeile(t('spiegelung.ausstehend'), t('spiegelung.ausstehend_text'));
      if (z.waechter) zeile(t('spiegelung.waechter'), z.waechter.aktiv ? t('spiegelung.waechter_aktiv') : t('spiegelung.waechter_aus', { grund: z.waechter.fehler || '–' }));

      const balken = fortschritt();
      balken.element.hidden = !z.laeuft;
      if (z.laeuft) balken.setzen(z.fortschritt || 0, z.meldung || '');

      const knoepfe = el('div', { klasse: 'vw-knopfleiste sp-knoepfe' },
        z.laeuft
          ? knopf(t('spiegelung.abbrechen_lauf'), { art: 'gefahr', klein: true, beiKlick: () => aufruf('spiegelung.abbrechen', { id: a.id }, t('spiegelung.abbruch_gesendet')) })
          : knopf(t('spiegelung.jetzt'), { klein: true, beiKlick: () => aufruf('spiegelung.starten', { id: a.id }, t('spiegelung.gestartet', { name: a.name })) }),
        a.richtung === 'einseitig' ? knopf(t('spiegelung.vorschau'), { art: 'zweit', klein: true, deaktiviert: !!z.laeuft, beiKlick: () => vorschau(a) }) : null,
        knopf(t('spiegelung.protokoll'), { art: 'zweit', klein: true, beiKlick: () => protokoll(a) }),
        knopf(t('spiegelung.versionen'), { art: 'zweit', klein: true, beiKlick: () => versionenZeigen(ctx, t, a, relativ) }),
        knopf(t('spiegelung.bearbeiten'), { art: 'zweit', klein: true, beiKlick: () => bearbeiten(a) }),
        knopf(a.aktiv ? t('spiegelung.pausieren') : t('spiegelung.fortsetzen'), { art: 'zweit', klein: true, beiKlick: () => pausieren(a) }),
        knopf(t('spiegelung.loeschen'), { art: 'gefahr', klein: true, deaktiviert: !!z.laeuft, beiKlick: () => loeschen(a) }));
      const element = karte(null, kopf, weg, zeilen, balken.element, knoepfe);
      element.dataset.suchziel = String(a.id);
      element.classList.add('sp-karte', `sp-art-${art}`);
      karten.set(a.id, { balken, element });
      return element;
    }

    async function aufruf(aktion, params, erfolg) {
      try { await api(ctx, aktion, params); if (erfolg) melden(ctx, erfolg, 'erfolg'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
      await laden();
    }

    function eingabeFuer(a) {
      return { id: a.id, name: a.name, art: artVon(a), aktiv: a.aktiv, quelle: a.quelle, ziel: a.ziel, richtung: a.richtung, ausloeser: a.ausloeser, tage: a.tage, zeiten: a.zeiten, wartezeit_min: a.wartezeit_min };
    }

    async function pausieren(a) {
      await aufruf('spiegelung.speichern', { ...eingabeFuer(a), aktiv: !a.aktiv }, a.aktiv ? t('spiegelung.pausiert_meldung', { name: a.name }) : t('spiegelung.fortgesetzt_meldung', { name: a.name }));
    }

    async function loeschen(a) {
      if (!await bestaetigen(ctx, t('spiegelung.loeschen_frage', { name: a.name }))) return;
      await aufruf('spiegelung.loeschen', { id: a.id }, t('spiegelung.geloescht', { name: a.name }));
    }

    // ---- Vorschau ------------------------------------------------------------------------------------------------
    async function vorschau(a) {
      let r;
      try {
        r = await aufgabeStarten(ctx, 'spiegelung.vorschau', { id: a.id }, {
          titel: t('spiegelung.vorschau_titel', { name: a.name }), meldung: t('spiegelung.vorschau_laeuft'),
          abbrechen: t('spiegelung.abbrechen'), schliessen: t('spiegelung.schliessen'), abgebrochen: t('spiegelung.ergebnis_abgebrochen'),
        });
      } catch { return; }
      const v = (r && r.vorschau) || { neu: 0, geaendert: 0, geloescht: 0, zeilen: [] };
      const leer = !v.neu && !v.geaendert && !v.geloescht;
      dialogOeffnen({
        ctx, titel: t('spiegelung.vorschau_titel', { name: a.name }), breit: true, schliessenText: t('spiegelung.schliessen'),
        inhalt: el('div', {},
          el('p', { text: leer ? t('spiegelung.vorschau_nichts') : t('spiegelung.vorschau_zusammenfassung', { neu: v.neu, geaendert: v.geaendert, geloescht: v.geloescht }) }),
          v.geloescht ? hinweis(t('spiegelung.vorschau_papierkorb'), 'info') : null,
          v.zeilen && v.zeilen.length ? el('pre', { klasse: 'sp-pre', text: v.zeilen.join('\n') }) : null),
        knoepfe: [{ text: t('spiegelung.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }],
      });
    }

    // ---- Protokoll -----------------------------------------------------------------------------------------------
    async function protokoll(a) {
      const inhalt = el('div', { klasse: 'sp-protokoll' }, leerHinweis(t('spiegelung.laden')));
      dialogOeffnen({ ctx, titel: t('spiegelung.protokoll_titel', { name: a.name }), inhalt, breit: true, schliessenText: t('spiegelung.schliessen'), knoepfe: [{ text: t('spiegelung.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }] });
      try {
        const r = await api(ctx, 'spiegelung.verlauf', { id: a.id });
        const laeufe = (r && r.laeufe) || [];
        leeren(inhalt);
        if (!laeufe.length) { inhalt.appendChild(leerHinweis(t('spiegelung.protokoll_leer'))); return; }
        for (const l of laeufe) {
          const kopfText = `${fmt.zeit(l.beginn)} · ${t(ANLASS[l.anlass] || 'spiegelung.anlass_hand')} · ${t(ERGEBNIS[l.ergebnis] || 'spiegelung.ergebnis_fehler')}`;
          const zt = zahlenText(l, t, fmt);
          inhalt.appendChild(el('details', { klasse: 'sp-lauf' },
            el('summary', {}, ampel(AMPEL[l.ergebnis] || 'unbekannt', t(ERGEBNIS[l.ergebnis] || 'spiegelung.ergebnis_fehler')), ` ${kopfText}`),
            zt ? el('p', { text: zt }) : null,
            l.meldung ? el('p', { klasse: `sp-meldung sp-meldung-${l.ergebnis}`, text: l.meldung }) : null,
            el('pre', { klasse: 'sp-pre', text: (l.protokoll || []).join('\n') || t('spiegelung.protokoll_ohne') })));
        }
      } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); }
    }

    // ---- Ordnerwahl ----------------------------------------------------------------------------------------------
    function ordnerWaehlen(freigabe, start, zugang = null) {
      return new Promise((aufloesen) => {
        let pfad = start || '';
        let gewaehlt = null;
        const ort = el('p', { klasse: 'sp-ort' });
        const ordner = el('ul', { klasse: 'sp-ordner', role: 'list' });
        // Neuer Ordner (Betreiber 09.11.2026): am gerade gezeigten Ort anlegen und gleich hineinwechseln
        const nfz = fehlerzeile();
        const neuName = eingabe({ maxlength: 255, platzhalter: t('spiegelung.ordner_neu_platzhalter'), autocomplete: 'off', spellcheck: false });
        const neuAnlegen = knopf(t('spiegelung.ordner_neu_anlegen'), { klein: true, beiKlick: () => anlegen() });
        const neuZeile = el('div', { klasse: 'sp-ordner-neu' }, neuName, neuAnlegen, knopf(t('spiegelung.abbrechen'), { art: 'zweit', klein: true, beiKlick: () => { neuZeile.hidden = true; nfz.leeren(); ordnerNeuKnopf.hidden = false; } }));
        neuZeile.hidden = true;
        const ordnerNeuKnopf = knopf(t('spiegelung.ordner_neu'), { art: 'zweit', klein: true, beiKlick: () => { ordnerNeuKnopf.hidden = true; neuZeile.hidden = false; neuName.value = ''; neuName.focus(); } });
        neuName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); anlegen(); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); neuZeile.hidden = true; ordnerNeuKnopf.hidden = false; nfz.leeren(); } });
        async function anlegen() {
          const n = neuName.value.trim();
          nfz.leeren();
          if (!n) { nfz.zeigen(t('spiegelung.ordner_neu_leer')); neuName.focus(); return; }
          neuAnlegen.disabled = true;
          try {
            if (zugang) await api(ctx, 'spiegelung.zugang.ordner.anlegen', { zugang, freigabe, pfad, name: n });
            else await api(ctx, 'dateien.ordner', { freigabe, pfad, name: n });
            melden(ctx, t('spiegelung.ordner_neu_fertig', { name: n }), 'erfolg');
            pfad = pfad ? `${pfad}/${n}` : n;
            neuZeile.hidden = true; ordnerNeuKnopf.hidden = false;
            await zeigen();
          } catch (e) { nfz.zeigen(fehlerText(e)); neuName.focus(); } finally { neuAnlegen.disabled = false; }
        }
        async function zeigen() {
          ort.textContent = `${freigabe}/${pfad}`;
          leeren(ordner); ordner.appendChild(el('li', { text: t('spiegelung.laden') }));
          let eintraege = [];
          try {
            if (zugang) { const r = await api(ctx, 'spiegelung.zugang.ordner', { zugang, freigabe, pfad }); eintraege = ((r && r.ordner) || []).map((name) => ({ name })); }
            else { const r = await api(ctx, 'dateien.liste', { freigabe, pfad }); eintraege = ((r && r.eintraege) || []).filter((e) => e.art === 'ordner'); }
          } catch (e) { leeren(ordner); ordner.appendChild(el('li', { text: fehlerText(e) })); return; }
          leeren(ordner);
          if (pfad) ordner.appendChild(el('li', {}, knopf(t('spiegelung.ordner_hoch'), { art: 'zweit', klein: true, beiKlick: () => { pfad = pfad.includes('/') ? pfad.slice(0, pfad.lastIndexOf('/')) : ''; zeigen(); } })));
          if (!eintraege.length) ordner.appendChild(el('li', { klasse: 'vw-leer', text: t('spiegelung.ordner_leer') }));
          for (const e of eintraege) {
            ordner.appendChild(el('li', {}, el('button', { typ: 'button', klasse: 'sp-ordnerknopf', text: `📁 ${e.name}`, onclick: () => { pfad = pfad ? `${pfad}/${e.name}` : e.name; zeigen(); } })));
          }
        }
        dialogOeffnen({
          ctx, titel: t('spiegelung.ordner_titel'), schliessenText: t('spiegelung.schliessen'),
          inhalt: el('div', {}, ort, ordner, el('div', { klasse: 'sp-ordner-leiste' }, ordnerNeuKnopf, neuZeile), nfz.element),
          knoepfe: [
            { text: t('spiegelung.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
            { text: t('spiegelung.ordner_nehmen'), beiKlick: (g) => { gewaehlt = pfad; g.schliessen(); } },
          ],
          beimSchliessen: () => aufloesen(gewaehlt),
        });
        zeigen();
      });
    }

    // ---- Anlegen / Bearbeiten ------------------------------------------------------------------------------------
    async function bearbeiten(a) {
      if (!freigaben.length) await freigabenLaden();
      const neu = !a;
      const s = a || { name: '', art: 'spiegelung', aktiv: true, quelle: { freigabe: '', pfad: '' }, ziel: { freigabe: '', pfad: '' }, richtung: 'einseitig', ausloeser: 'zeitplan', tage: [0, 1, 2, 3, 4, 5, 6], zeiten: ['05:00'], wartezeit_min: 2 };
      const fz = fehlerzeile();
      const name = eingabe({ maxlength: 60, wert: s.name });
      const optionen = freigaben.map((f) => ({ wert: f.name, text: f.extern ? t('spiegelung.freigabe_extern', { name: f.name }) : f.name }));

      const fernHinweis = hinweis(t('spiegelung.fern_dialog_hinweis'), 'info');
      fernHinweis.hidden = true;
      const fernSichtbarkeit = () => { fernHinweis.hidden = !(quelle.ort() || ziel.ort()); };

      function seiteFelder(seite, label, erklaerung) {
        // Ort: dieses NAS oder eine gespeicherte Verbindung zu einem anderen NAS
        const ort = auswahl({ optionen: [{ wert: '', text: t('spiegelung.ort_hier') }, ...zugaenge.map((z) => ({ wert: z.id, text: `${z.name} (${z.adresse})` }))], wert: seite.zugang || '' });
        const wahl = auswahl({ optionen: [], wert: '' });
        const unter = eingabe({ maxlength: 1024, wert: seite.pfad, platzhalter: t('spiegelung.unterordner_platzhalter') });
        async function freigabenFuellen(wert) {
          leeren(wahl);
          if (!ort.value) {
            for (const o of [{ wert: '', text: t('spiegelung.freigabe_waehlen') }, ...optionen]) wahl.appendChild(el('option', { wert: o.wert, text: o.text }));
            wahl.value = wert || ''; return;
          }
          wahl.appendChild(el('option', { wert: '', text: t('spiegelung.fern_freigaben_laden') }));
          try {
            const r = await api(ctx, 'spiegelung.zugang.pruefen', { id: ort.value });
            leeren(wahl); wahl.appendChild(el('option', { wert: '', text: t('spiegelung.freigabe_waehlen') }));
            for (const f of (r && r.freigaben) || []) wahl.appendChild(el('option', { wert: f.name, text: f.name }));
            if (wert && ![...wahl.options].some((o) => o.value === wert)) wahl.appendChild(el('option', { wert, text: wert }));
            wahl.value = wert || '';
          } catch (e) { leeren(wahl); wahl.appendChild(el('option', { wert: wert || '', text: wert || '–' })); fz.zeigen(fehlerText(e)); }
        }
        ort.addEventListener('change', () => { fz.leeren(); unter.value = ''; freigabenFuellen(''); fernSichtbarkeit(); });
        freigabenFuellen(seite.freigabe);
        const waehlen = knopf(t('spiegelung.ordner_waehlen'), { art: 'zweit', klein: true, beiKlick: async () => {
          if (!wahl.value) { fz.zeigen(t('spiegelung.erst_freigabe')); return; }
          const p = await ordnerWaehlen(wahl.value, unter.value.trim().replace(/^\/+|\/+$/g, ''), ort.value || null);
          if (p !== null) unter.value = p;
        } });
        const block = el('div', { klasse: 'sp-seite-block' },
          feld({ label: `${label} – ${t('spiegelung.ort')}`, erklaerung: t('spiegelung.ort_erklaerung'), eingabe: ort }),
          el('div', { klasse: 'sp-seite-felder' },
            feld({ label: t('spiegelung.freigabe'), erklaerung, eingabe: wahl }),
            feld({ label: t('spiegelung.unterordner'), erklaerung: t('spiegelung.unterordner_erklaerung'), eingabe: unter }),
            el('div', { klasse: 'vw-feld sp-wahl-knopf' }, waehlen)));
        return { block, ort: () => ort.value, wert: () => ({ ...(ort.value ? { zugang: ort.value } : {}), freigabe: wahl.value, pfad: unter.value.trim() }) };
      }
      const quelle = seiteFelder(s.quelle, t('spiegelung.quelle'), t('spiegelung.quelle_erklaerung'));
      const ziel = seiteFelder(s.ziel, t('spiegelung.ziel'), t('spiegelung.ziel_erklaerung'));
      fernSichtbarkeit();

      const richtung = radiogruppe({ optionen: [
        { wert: 'einseitig', text: t('spiegelung.richtung_einseitig'), erklaerung: t('spiegelung.richtung_einseitig_erklaerung') },
        { wert: 'beidseitig', text: t('spiegelung.richtung_beidseitig'), erklaerung: t('spiegelung.richtung_beidseitig_erklaerung') },
      ], wert: s.richtung });
      // Art: eine Sicherung kopiert immer nur in eine Richtung → Richtung dann ausgeblendet
      const richtungTitel = el('h3', { klasse: 'sp-abschnitt', text: t('spiegelung.richtung') });
      const richtungSicherung = el('p', { klasse: 'erklaerung', text: t('spiegelung.richtung_bei_sicherung') });
      const artSicht = (wert) => {
        const sich = wert === 'sicherung';
        richtung.element.hidden = sich; richtungSicherung.hidden = !sich;
        if (sich) { const e = richtung.eingaben.find((r) => r.value === 'einseitig'); if (e) e.checked = true; }
      };
      const artWahl = radiogruppe({ optionen: [
        { wert: 'sicherung', text: t('spiegelung.art_sicherung'), erklaerung: t('spiegelung.art_sicherung_erklaerung') },
        { wert: 'spiegelung', text: t('spiegelung.art_spiegelung'), erklaerung: t('spiegelung.art_spiegelung_erklaerung') },
      ], wert: artVon(s), beiWechsel: artSicht });
      artSicht(artVon(s));

      const tageBoxen = TAGE.map(([d, k]) => {
        const box = el('input', { typ: 'checkbox', id: `sp-tag-${d}` });
        box.checked = (s.tage || []).includes(d);
        return { d, box, element: el('label', { klasse: 'sp-tag', fuer: box.id }, box, el('span', { text: t(k) })) };
      });
      const zeiten = eingabe({ maxlength: 200, wert: (s.zeiten || []).join(', '), platzhalter: '05:00, 17:30' });
      const planBereich = el('div', { klasse: 'sp-plan' },
        el('div', { klasse: 'feld vw-feld' }, el('span', { klasse: 'feld-beschriftung vw-label', text: t('spiegelung.tage') }), el('div', { klasse: 'sp-tage' }, tageBoxen.map((x) => x.element)), el('p', { klasse: 'erklaerung', text: t('spiegelung.tage_erklaerung') })),
        feld({ label: t('spiegelung.zeiten'), erklaerung: t('spiegelung.zeiten_erklaerung'), eingabe: zeiten }));
      const wartezeit = eingabe({ typ: 'number', min: 1, max: 1440, wert: s.wartezeit_min || 2 });
      const aenderungBereich = el('div', { klasse: 'sp-aenderung' }, feld({ label: t('spiegelung.wartezeit'), erklaerung: t('spiegelung.wartezeit_erklaerung'), eingabe: wartezeit }));
      const sichtbarkeit = (wert) => { planBereich.hidden = wert !== 'zeitplan'; aenderungBereich.hidden = wert !== 'aenderung'; };
      const ausloeser = radiogruppe({ optionen: [
        { wert: 'zeitplan', text: t('spiegelung.ausloeser_zeitplan'), erklaerung: t('spiegelung.ausloeser_zeitplan_erklaerung') },
        { wert: 'aenderung', text: t('spiegelung.ausloeser_aenderung'), erklaerung: t('spiegelung.ausloeser_aenderung_erklaerung') },
        { wert: 'hand', text: t('spiegelung.ausloeser_hand'), erklaerung: t('spiegelung.ausloeser_hand_erklaerung') },
      ], wert: s.ausloeser, beiWechsel: sichtbarkeit });
      sichtbarkeit(s.ausloeser);
      const aktiv = schalter({ label: t('spiegelung.aktiv'), erklaerung: t('spiegelung.aktiv_erklaerung'), wert: s.aktiv !== false });
      const versionen = versionenAuswahl(s.versionen_tage || 30, t);

      const form = el('div', { klasse: 'sp-formular' },
        feld({ label: t('spiegelung.name'), erklaerung: t('spiegelung.name_erklaerung'), eingabe: name }),
        el('h3', { klasse: 'sp-abschnitt', text: t('spiegelung.art') }), artWahl.element,
        el('h3', { klasse: 'sp-abschnitt', text: t('spiegelung.abschnitt_ordner') }), quelle.block, ziel.block, fernHinweis,
        richtungTitel, richtungSicherung, richtung.element,
        el('h3', { klasse: 'sp-abschnitt', text: t('spiegelung.ausloeser') }), ausloeser.element, planBereich, aenderungBereich,
        aktiv.element,
        feld({ label: t('spiegelung.versionen_tage'), erklaerung: t('spiegelung.versionen_tage_erklaerung'), eingabe: versionen }),
        fz.element);

      dialogOeffnen({
        ctx, titel: neu ? t('spiegelung.neu') : t('spiegelung.bearbeiten_titel', { name: s.name }), inhalt: form, breit: true, schliessenText: t('spiegelung.schliessen'),
        knoepfe: [
          { text: t('spiegelung.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('spiegelung.speichern'), beiKlick: async (g) => {
            fz.leeren();
            const params = {
              ...(a ? { id: a.id } : {}), name: name.value.trim(), art: artWahl.wert(), aktiv: aktiv.eingabe.checked,
              quelle: quelle.wert(), ziel: ziel.wert(), richtung: artWahl.wert() === 'sicherung' ? 'einseitig' : richtung.wert(), ausloeser: ausloeser.wert(),
              tage: tageBoxen.filter((x) => x.box.checked).map((x) => x.d), zeiten: zeitenAusText(zeiten.value),
              wartezeit_min: Number.parseInt(wartezeit.value, 10) || 2, versionen_tage: Number(versionen.value),
            };
            g.beschaeftigt(true);
            try {
              await api(ctx, 'spiegelung.speichern', params);
              melden(ctx, t('spiegelung.gespeichert', { name: params.name }), 'erfolg');
              g.schliessen();
              await laden();
            } catch (e) { fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
          } },
        ],
      });
    }

    // ---- Live-Zustand ----------------------------------------------------------------------------------------------
    abmelder.push(abo(ctx, 'spiegelung', (ev) => {
      const d = daten(ev);
      if (!d || !d.id) return;
      const k = karten.get(d.id);
      if (d.zustand === 'laeuft' && k && !k.balken.element.hidden) { k.balken.setzen(d.fortschritt || 0, d.meldung || ''); return; }
      laden();
      if (d.zustand === 'fertig' && d.ergebnis === 'fehler') {
        const a = auftraege.find((x) => x.id === d.id);
        melden(ctx, t('spiegelung.fehler_meldung', { name: a ? a.name : d.id, meldung: d.meldung || '' }), 'fehler');
      }
    }));
    abmelder.push(abo(ctx, 'konfig', (ev) => { const d = daten(ev); if (d && (d.bereich === 'spiegelung' || d.bereich === 'freigaben')) { if (d.bereich === 'freigaben') freigaben = []; laden(); } }));
    uhr = setInterval(() => { if (!document.hidden) laden(); }, 60_000);

    await Promise.all([freigabenLaden(), laden()]);
    // #/spiegelung/neu[/<laufwerk>] – Assistent direkt öffnen (Suche, Dashboard, „Neue Platte erkannt“)
    const r = ctx.route && Array.isArray(ctx.route.teile) ? ctx.route.teile : [];
    if (r[0] === 'neu') { assistent(r[1] || null); try { history.replaceState(null, '', ctx.hashFuer('spiegelung')); } catch { /* alt */ } } // Neu laden öffnet ihn nicht erneut
  },

  verlassen() {
    clearInterval(uhr); uhr = null;
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
