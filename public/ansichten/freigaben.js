// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Freigaben“: Liste mit Belegung, Speicherort und Merkmalen, Verbindungshinweis, Anlegen/Bearbeiten mit Rechte-Tabelle
// je Nutzer und Gruppe, Gäste/Papierkorb/Time Machine/Kontingent/Versteckt, Löschen mit Tipp-Bestätigung.
// Rolle nutzer sieht nur die eigenen Freigaben und den Verbindungshinweis.

import {
  el, leeren, stilLaden, eingabe, feld, schalter, radiogruppe, knopf, fehlerzeile, hinweis, leerHinweis, badge, tabelle, tabellenzeile,
  belegungsbalken, dialogOeffnen, alleDialogeSchliessen, api, fehlerText, istAdmin, melden, abo, kopieren, kopfzeile, uebersetzer, formatierer, felderPruefen, GIB,
} from './verwaltung-hilfen.js';
import { suchzielAnspringen } from './verwaltung-hilfen.js';
import { leerMitSchritt, bestaetigen, aufgabeStarten } from './verwaltung-hilfen.js';
import { ordnerrechteDialog, regelnKurz } from '../ordnerrechte.js';

export const MUSTER_FREIGABENAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Wie samba.MUSTER_WERT im Agenten: keine Anführungszeichen, Zeilenumbrüche oder Steuerzeichen (landen als Kommentar in smb.conf) */
export const MUSTER_BESCHREIBUNG = /^[^\r\n"\u0000-\u001f\u007f]*$/;

/** Kontingent in Byte – binär wie der Agent (groesse_gb × 1024³) und die Dateien-Ansicht; 0/leer = kein Kontingent */
export function kontingentBytes(groesseGb) {
  const gb = Number(groesseGb);
  return Number.isFinite(gb) && gb > 0 ? gb * GIB : 0;
}

let zuletztT = (k) => ({ 'freigaben.titel': 'Freigaben' }[k] || k);
let abmelder = [];

/** Rechte eines Eintrags (Nutzer oder @gruppe) aus den Listen ableiten */
export function rechtVon(freigabe, kennung) {
  if ((freigabe.schreiben || []).includes(kennung)) return 'schreiben';
  if ((freigabe.lesen || []).includes(kennung)) return 'lesen';
  return 'kein';
}

/** Aus der Rechte-Tabelle wieder Listen machen */
export function rechteListen(zuordnung) {
  const lesen = []; const schreiben = [];
  for (const [kennung, recht] of Object.entries(zuordnung)) {
    if (recht === 'schreiben') schreiben.push(kennung);
    else if (recht === 'lesen') lesen.push(kennung);
  }
  return { lesen, schreiben };
}

/**
 * Speicherort-Zeile der Karte aus `speicherort` des Agenten ('' ohne Angabe, z. B. älterer Agent) – Betreiber 18.10.2026:
 * „wo sehe ich, wo neue Freigaben erstellt wurden (auf welcher Festplatte)“. „Speicherort: Datenplatte (Samsung SSD 840) ·
 * /data/shares/medien“; extern mit Bezeichnung und Modell wie in der Laufwerke-Ansicht (das Modell nur, wenn es nicht schon
 * die Bezeichnung ist), Speicherverbund mit Stufe, Plattenzahl und Modellen. Verschlüsselte Freigaben liegen auf der Datenplatte.
 */
export function speicherortText(f, t) {
  const o = f && f.speicherort;
  if (!o || typeof o !== 'object') return '';
  const klammer = (s) => (s ? ` (${s})` : '');
  let ort;
  if (o.art === 'extern') {
    ort = (o.label ? t('freigaben.ort_extern', { name: o.label }) : t('freigaben.ort_extern_ohne_name')) + klammer(o.modell !== o.label ? o.modell : '');
  } else if (o.art === 'verbund') {
    const platten = Array.isArray(o.platten) ? o.platten : [];
    const stufe = o.stufe ? String(o.stufe).toUpperCase() : '';
    const modelle = [...new Set(platten.map((p) => p && p.modell).filter(Boolean))];
    ort = stufe && platten.length ? t('freigaben.ort_verbund', { stufe, anzahl: platten.length }) + klammer(modelle.join(', ')) : [t('freigaben.ort_verbund_ohne'), stufe].filter(Boolean).join(' ');
  } else if (o.art === 'import') {
    // übernommen (19.10.2026): „UGOS-Volume volume1 (RAID1, 2 Platten)“
    const platten = Array.isArray(o.platten) ? o.platten : [];
    const stufe = o.stufe ? String(o.stufe).toUpperCase() : '';
    ort = t('freigaben.ort_import', { name: o.bezeichnung || o.herkunft || '?' }) + klammer([stufe, platten.length ? t('freigaben.ort_import_platten', { anzahl: platten.length }) : ''].filter(Boolean).join(', '));
  } else {
    ort = t('freigaben.ort_datenplatte') + klammer(o.modell);
  }
  return t('freigaben.ort', { ort, pfad: f.pfad || '' });
}

// Beschreibungen, die FAH-NAS selbst vergibt (Laufwerke → Einhängen als Freigabe, Speicherverbund anlegen): Sie nennen nur
// den Ort – den zeigt die Speicherort-Zeile schon, also nicht doppelt.
const AUTO_EXTERN = /^Externes Laufwerk( \(.*\))?$/;
const AUTO_VERBUND = /^Speicherverbund RAID\d+$/;

/** Zeigt die Karte die Beschreibung? Nicht, wenn sie leer ist oder nur den Ort wiederholt, den die Speicherort-Zeile nennt. */
export function beschreibungZeigen(f) {
  const b = String((f && f.beschreibung) || '');
  if (!b) return false;
  if (!f.speicherort) return true;
  return !((f.extern && AUTO_EXTERN.test(b)) || (f.verbund && AUTO_VERBUND.test(b)));
}

/** Satz im Dialog „Neue Freigabe“: wo die Freigabe entsteht (aus freigaben.speicherort und dem getippten Namen; '' ohne Angabe). */
export function neuOrtText(o, name, t) {
  if (!o || typeof o !== 'object' || !o.pfad) return '';
  const pfad = `${String(o.pfad).replace(/\/+$/, '')}/${String(name || '').trim() || t('freigaben.ort_name_platzhalter')}`;
  return o.modell ? t('freigaben.ort_neu', { modell: o.modell, pfad }) : t('freigaben.ort_neu_ohne_modell', { pfad });
}

export default {
  id: 'freigaben',
  symbol: 'freigaben',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('freigaben.titel'); },

  async einbinden(wurzel, ctx) {
    suchzielAnspringen(wurzel, ctx.route); // Suche/„Beheben“: #/freigaben/ziel/<name>
    stilLaden();
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    const admin = istAdmin(ctx);
    leeren(wurzel);
    wurzel.classList.add('fg-wurzel');

    const liste = el('div', { klasse: 'fg-liste' });
    wurzel.append(
      kopfzeile(t('freigaben.titel'), t(admin ? 'freigaben.untertitel_admin' : 'freigaben.untertitel_nutzer'),
        admin ? knopf(t('freigaben.neu'), { beiKlick: () => dialogBearbeiten(null) }) : null),
      liste,
    );

    let freigaben = [];

    async function laden() {
      leeren(liste); liste.appendChild(leerHinweis(t('freigaben.laden')));
      try {
        const r = await api(ctx, 'freigaben.liste', {});
        freigaben = Array.isArray(r) ? r : (r && r.freigaben) || [];
      } catch (e) {
        leeren(liste); liste.appendChild(hinweis(`${t('freigaben.lade_fehl')} ${fehlerText(e)}`, 'fehler')); return;
      }
      leeren(liste);
      if (!freigaben.length) { liste.appendChild(admin ? leerMitSchritt(t('freigaben.keine_admin'), t('freigaben.erste'), () => dialogBearbeiten(null)) : leerHinweis(t('freigaben.keine_nutzer'))); return; }
      for (const f of freigaben) liste.appendChild(karteFuer(f));
    }

    function karteFuer(f) {
      const badges = el('div', { klasse: 'vw-badges' });
      if (f.gaeste) badges.appendChild(badge(t('freigaben.symbol_gaeste_kurz'), t('freigaben.symbol_gaeste'), 'warnung'));
      if (f.timemachine) badges.appendChild(badge(t('freigaben.symbol_timemachine_kurz'), t('freigaben.symbol_timemachine')));
      if (f.papierkorb) badges.appendChild(badge(t('freigaben.symbol_papierkorb_kurz'), t('freigaben.symbol_papierkorb')));
      if (f.versteckt) badges.appendChild(badge(t('freigaben.symbol_versteckt_kurz'), t('freigaben.symbol_versteckt')));
      if (f.verschluesselt) badges.appendChild(badge(t(f.entsperrt ? 'freigaben.krypt_offen' : 'freigaben.krypt_gesperrt'), t('freigaben.krypt_badge_titel'), f.entsperrt ? '' : 'warnung'));
      if (f.verbund) badges.appendChild(badge(t(f.eingehaengt === false ? 'freigaben.symbol_verbund_aus' : 'freigaben.symbol_verbund_kurz'), t('freigaben.symbol_verbund'), f.eingehaengt === false ? 'fehler' : ''));
      if (f.importiert) badges.appendChild(badge(t(f.eingehaengt === false ? 'freigaben.symbol_import_aus' : 'freigaben.symbol_import_kurz'), t('freigaben.symbol_import', { ordner: f.importiert.ordner }), f.eingehaengt === false ? 'fehler' : ''));
      const anzahlS = Array.isArray(f.schnappschuesse) ? f.schnappschuesse.length : Number(f.schnappschuesse);
      if (Number.isFinite(anzahlS) && anzahlS > 0) badges.appendChild(badge(t('freigaben.symbol_schnappschuesse', { anzahl: anzahlS }), undefined));

      const belegtBekannt = f.belegt !== null && f.belegt !== undefined && Number.isFinite(Number(f.belegt));
      const belegt = belegtBekannt ? Number(f.belegt) : 0;
      // Grenze: Kontingent, bei externen Laufwerken die Größe des Dateisystems (kapazitaet)
      const kapazitaet = belegtBekannt && Number(f.kapazitaet) > 0 ? Number(f.kapazitaet) : 0;
      const kontingent = kontingentBytes(f.groesse_gb) || kapazitaet;
      const balken = kontingent > 0
        ? belegungsbalken(belegt / kontingent, `${t('freigaben.belegt_von', { belegt: fmt.groesse(belegt), gesamt: fmt.groesse(kontingent) })} · ${t('freigaben.belegt_prozent', { prozent: Math.round((belegt / kontingent) * 100) })}`)
        : el('p', { klasse: 'vw-belegung-text', text: t('freigaben.belegt_ohne', { belegt: belegtBekannt ? fmt.groesse(belegt) : '–' }) });

      const knoepfe = el('div', { klasse: 'vw-knopfleiste fg-knoepfe' },
        knopf(t('freigaben.verbinden'), { art: 'zweit', beiKlick: () => dialogVerbindung(f) }),
        admin ? knopf(t('freigaben.bearbeiten'), { art: 'zweit', beiKlick: () => dialogBearbeiten(f) }) : null,
        admin && f.verschluesselt ? knopf(t(f.entsperrt ? 'freigaben.krypt_sperren' : 'freigaben.krypt_entsperren'), { art: f.entsperrt ? 'zweit' : 'haupt', beiKlick: () => (f.entsperrt ? sperren(f) : dialogEntsperren(f)) }) : null,
        admin && !f.extern ? knopf(t('freigaben.rechte_uebertragen'), { art: 'zweit', titel: t('freigaben.rechte_uebertragen_titel'), beiKlick: () => rechteUebertragen(f) }) : null,
        admin && !f.verbund ? knopf(t('freigaben.loeschen'), { art: 'gefahr', beiKlick: () => dialogLoeschen(f) }) : null, // Verbund: löschen nur unter Laufwerke → Speicherverbünde
        admin && f.verbund && typeof ctx.hashFuer === 'function' ? el('a', { href: ctx.hashFuer('laufwerke', 'raid'), klasse: 'fg-link', text: t('freigaben.verbund_verwalten') }) : null);

      const rechteText = admin ? el('p', { klasse: 'fg-rechte vw-gedaempft' },
        `${t('freigaben.rechte_lesen', { liste: (f.lesen || []).join(', ') || t('freigaben.rechte_niemand') })} · ${t('freigaben.rechte_schreiben', { liste: (f.schreiben || []).join(', ') || t('freigaben.rechte_niemand') })}`) : null;

      // Auf welcher Platte liegt die Freigabe? Gerät als Tooltip, wenn der Agent es kennt
      const ortText = speicherortText(f, t);
      const ortZeile = ortText ? el('p', { klasse: 'fg-ort vw-gedaempft', text: ortText,
        attr: { title: f.speicherort.geraet ? t('freigaben.ort_geraet', { geraet: f.speicherort.geraet }) : undefined } }) : null;

      return el('section', { klasse: 'karte vw-karte fg-karte', attr: { 'data-suchziel': f.name } },
        el('div', { klasse: 'fg-kopf' }, el('h2', { klasse: 'fg-name vw-mono', text: f.name }), badges),
        beschreibungZeigen(f) ? el('p', { klasse: 'fg-beschreibung', text: f.beschreibung }) : null,
        balken, ortZeile, rechteText, admin ? ordnerrechteBlock(f) : null, knoepfe);
    }

    // ---- Rechte auf vorhandene Dateien übertragen (19.10.2026): die Freigabe-ACL erbt sich nur auf NEUE Dateien; das hier
    // setzt sie auf alles, was schon da ist (Ordnerrechte bleiben). Übernommene Freigaben machen das bei Änderungen selbst.
    async function rechteUebertragen(f) {
      if (!(await bestaetigen(ctx, t('freigaben.rechte_uebertragen_frage', { name: f.name })))) return;
      try {
        const r = await aufgabeStarten(ctx, 'freigaben.rechte.anwenden', { name: f.name }, { titel: t('freigaben.rechte_uebertragen'), meldung: t('freigaben.rechte_uebertragen_laeuft'), abbrechen: t('freigaben.abbrechen'), schliessen: t('freigaben.schliessen') });
        melden(ctx, t('freigaben.rechte_uebertragen_fertig', { geprueft: r?.geprueft ?? 0, geaendert: r?.geaendert ?? 0 }), 'erfolg');
      } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') melden(ctx, fehlerText(e), 'fehler'); }
    }

    // ---- Ordnerrechte (19.10.2026): Ordner mit eigenen Rechten je Freigabe, Ändern öffnet denselben Dialog wie im Dateimanager
    function ordnerrechteBlock(f) {
      const regeln = Array.isArray(f.ordnerrechte) ? f.ordnerrechte : [];
      if (!regeln.length) return null;
      const liste = el('ul', { klasse: 'fg-ordnerrechte-liste' });
      for (const r of regeln) {
        liste.appendChild(el('li', { klasse: 'fg-ordnerrecht' },
          el('span', { klasse: 'fg-ordnerrecht-text' },
            el('span', { klasse: 'vw-mono fg-ordnerrecht-pfad', text: r.pfad }),
            el('span', { klasse: 'vw-gedaempft', text: regelnKurz(r.regeln) })),
          el('span', { klasse: 'fg-ordnerrecht-knoepfe' },
            knopf(t('freigaben.ordnerrechte_aendern'), { art: 'zweit', klein: true, beiKlick: () => ordnerrechteDialog(ctx, { freigabe: f.name, pfad: r.pfad, nachher: () => laden() }) }),
            typeof ctx.hashFuer === 'function' ? el('a', { href: ctx.hashFuer('dateien', f.name, r.pfad), klasse: 'fg-link', text: t('freigaben.ordnerrechte_oeffnen') }) : null)));
      }
      return el('details', { klasse: 'fg-ordnerrechte' },
        el('summary', { text: t('freigaben.ordnerrechte_titel', { n: regeln.length }) }),
        el('p', { klasse: 'vw-gedaempft', text: t('freigaben.ordnerrechte_info') }), liste);
    }

    // ---- Verbindungshinweis --------------------------------------------------------------------------------
    async function dialogVerbindung(f) {
      const inhalt = el('div', {}, leerHinweis(t('freigaben.laden')));
      const griff = dialogOeffnen({ ctx, titel: t('freigaben.verbindung_titel', { name: f.name }), inhalt, schliessenText: t('freigaben.schliessen'),
        knoepfe: [{ text: t('freigaben.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }] });
      try {
        const v = await api(ctx, 'freigaben.verbindung', { name: f.name });
        leeren(inhalt);
        const adresse = eingabe({ wert: v.smb || '', nurLesen: true, klasse: 'vw-mono' });
        adresse.addEventListener('focus', () => adresse.select());
        const kopierKnopf = knopf(t('freigaben.kopieren'), { art: 'zweit', beiKlick: async () => { melden(ctx, t((await kopieren(adresse.value)) ? 'freigaben.kopiert' : 'freigaben.kopieren_fehl'), 'info'); } });
        inhalt.append(
          feld({ label: t('freigaben.verbindung_adresse'), erklaerung: t('freigaben.verbindung_adresse_erklaerung'), eingabe: el('div', { klasse: 'fg-adresse' }, adresse, kopierKnopf) }),
        );
        const h = v.hinweise || {};
        const abschnitte = [[t('freigaben.verbindung_mac'), h.mac, true], [t('freigaben.verbindung_windows'), h.windows, false], [t('freigaben.verbindung_linux'), h.linux, false]];
        for (const [ueberschrift, text, offen] of abschnitte) {
          if (!text) continue;
          inhalt.appendChild(el('details', { klasse: 'vw-details', attr: offen ? { open: 'open' } : {} },
            el('summary', { text: ueberschrift }), el('p', { klasse: 'fg-hinweistext', text: String(text) })));
        }
      } catch (e) {
        leeren(inhalt); inhalt.appendChild(hinweis(`${t('freigaben.verbindung_fehl')} ${fehlerText(e)}`, 'fehler'));
      }
      void griff;
    }

    // ---- Anlegen / Bearbeiten ------------------------------------------------------------------------------
    async function dialogBearbeiten(f) {
      const neu = !f;
      const daten = f || { name: '', beschreibung: '', gaeste: false, lesen: [], schreiben: [], papierkorb: true, timemachine: false, groesse_gb: 0, versteckt: false };
      const form = el('form', { klasse: 'fg-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const name = eingabe({ wert: daten.name, maxlength: 32, spellcheck: false, klasse: 'vw-mono', nurLesen: !neu });
      name.setAttribute('autocapitalize', 'none');
      const beschreibung = eingabe({ wert: daten.beschreibung || '', maxlength: 200 });

      // Neue Freigabe: vorher sagen, wo sie entsteht (Platte + Pfad, folgt dem getippten Namen). Ohne Antwort kein Satz.
      const ortHinweis = neu ? hinweis('', 'info') : null;
      let ortDaten = null;
      const ortZeigen = () => {
        const text = neuOrtText(ortDaten, name.value, t);
        ortHinweis.textContent = text;
        ortHinweis.classList.toggle('vw-versteckt', !text);
      };
      if (ortHinweis) {
        ortHinweis.classList.add('fg-ort-neu');
        ortZeigen();
        name.addEventListener('input', ortZeigen);
        api(ctx, 'freigaben.speicherort', {}).then((o) => { ortDaten = o; ortZeigen(); }).catch(() => { /* nie ein Fehler – dann eben ohne Satz */ });
      }

      // Rechte-Tabelle
      const zuordnung = {};
      const rechteBereich = el('div', { klasse: 'vw-feld' }, el('span', { klasse: 'vw-label', text: t('freigaben.rechte') }), el('p', { klasse: 'erklaerung', text: t('freigaben.rechte_erklaerung') }));
      const rechteInhalt = el('div', {}, leerHinweis(t('freigaben.laden')));
      rechteBereich.appendChild(rechteInhalt);

      const gaesteWarnung = hinweis(t('freigaben.gaeste_warnung'), 'warnung'); gaesteWarnung.classList.toggle('vw-versteckt', !daten.gaeste);
      const gaeste = schalter({ label: t('freigaben.gaeste'), erklaerung: t('freigaben.gaeste_erklaerung'), wert: !!daten.gaeste, beiWechsel: (an) => gaesteWarnung.classList.toggle('vw-versteckt', !an) });
      const papierkorb = schalter({ label: t('freigaben.papierkorb'), erklaerung: t('freigaben.papierkorb_erklaerung'), wert: daten.papierkorb !== false && !daten.timemachine });
      const tmHinweis = hinweis(t('freigaben.timemachine_hinweis'), 'info'); tmHinweis.classList.toggle('vw-versteckt', !daten.timemachine);
      // Time Machine schaltet den Papierkorb aus (Teil A: Time Machine räumt alte Bänder selbst weg)
      let papierkorbVorher = papierkorb.eingabe.checked;
      const timemachine = schalter({ label: t('freigaben.timemachine'), erklaerung: t('freigaben.timemachine_erklaerung'), wert: !!daten.timemachine, beiWechsel: (an) => {
        tmHinweis.classList.toggle('vw-versteckt', !an);
        if (an) { papierkorbVorher = papierkorb.eingabe.checked; papierkorb.eingabe.checked = false; } else papierkorb.eingabe.checked = papierkorbVorher;
        papierkorb.eingabe.disabled = an;
      } });
      papierkorb.eingabe.disabled = !!daten.timemachine;
      const kontingent = eingabe({ typ: 'number', wert: Number(daten.groesse_gb) || 0, min: 0, max: 1000000, schritt: 1, inputmode: 'numeric' });
      const versteckt = schalter({ label: t('freigaben.versteckt'), erklaerung: t('freigaben.versteckt_erklaerung'), wert: !!daten.versteckt });
      // Verschlüsseln (nur beim Anlegen): Passwort + optional Schlüssel auf dem NAS speichern
      const kryptPw = eingabe({ typ: 'password', maxlength: 256, autocomplete: 'new-password' });
      const kryptPw2 = eingabe({ typ: 'password', maxlength: 256, autocomplete: 'new-password' });
      const kryptMerken = schalter({ label: t('freigaben.krypt_merken'), erklaerung: t('freigaben.krypt_merken_erklaerung'), wert: false });
      const kryptBereich = el('div', { klasse: 'fg-krypt vw-versteckt' },
        hinweis(t('freigaben.krypt_warnung'), 'warnung'),
        feld({ label: t('freigaben.krypt_passwort'), erklaerung: t('freigaben.krypt_passwort_erklaerung'), eingabe: kryptPw }),
        feld({ label: t('freigaben.krypt_passwort2'), eingabe: kryptPw2 }), kryptMerken.element);
      const krypt = neu ? schalter({ label: t('freigaben.krypt'), erklaerung: t('freigaben.krypt_erklaerung'), wert: false, beiWechsel: (an) => { kryptBereich.classList.toggle('vw-versteckt', !an); kontingentFeld.classList.toggle('vw-versteckt', an); } }) : null;
      const kontingentFeld = feld({ label: t('freigaben.kontingent'), erklaerung: t('freigaben.kontingent_erklaerung'), eingabe: kontingent });

      form.append(...[ // Verbund: Felder ohne Bedeutung fallen weg (null)
        fz.element,
        feld({ label: t('freigaben.name'), erklaerung: t('freigaben.name_erklaerung'), eingabe: name }),
        ortHinweis,
        feld({ label: t('freigaben.beschreibung'), erklaerung: t('freigaben.beschreibung_erklaerung'), eingabe: beschreibung }),
        rechteBereich,
        gaeste.element, gaesteWarnung,
        papierkorb.element,
        timemachine.element, tmHinweis,
        // Speicherverbund (RAID): eigenes Dateisystem – kein Kontingent (Schnappschüsse ja, seit 0.15)
        daten.verbund || daten.verschluesselt ? null : kontingentFeld,
        versteckt.element,
        krypt ? krypt.element : null, krypt ? kryptBereich : null,
        el('div', { klasse: 'vw-feld' }, el('span', { klasse: 'vw-label', text: t('freigaben.plan') }), el('p', { klasse: 'erklaerung', text: t('freigaben.plan_erklaerung') }),
          el('a', { href: typeof ctx.hashFuer === 'function' ? ctx.hashFuer('snapshots') : '#snapshots', klasse: 'fg-link', text: t('freigaben.plan_link') })),
      ].filter(Boolean));

      const griff = dialogOeffnen({ ctx,
        titel: neu ? t('freigaben.dialog_neu') : t('freigaben.dialog_bearbeiten', { name: daten.name }), inhalt: form, breit: true, schliessenText: t('freigaben.schliessen'),
        knoepfe: [
          { text: t('freigaben.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t(neu ? 'freigaben.anlegen' : 'freigaben.speichern'), absenden: true },
        ],
      });
      if (!neu) beschreibung.focus();

      // Nutzer und Gruppen laden
      try {
        const [nutzerL, gruppenL] = await Promise.all([api(ctx, 'nutzer.liste', {}), api(ctx, 'nutzer.gruppen', {})]);
        const nutzer = Array.isArray(nutzerL) ? nutzerL : (nutzerL && nutzerL.nutzer) || [];
        const gruppen = Array.isArray(gruppenL) ? gruppenL : (gruppenL && gruppenL.gruppen) || [];
        leeren(rechteInhalt);
        const eintraege = [...gruppen.map((g) => ({ kennung: `@${g.name}`, anzeige: `@${g.name}`, zusatz: t('freigaben.gruppe_kurz') })), ...nutzer.map((n) => ({ kennung: n.name, anzeige: n.name, zusatz: n.anzeigename && n.anzeigename !== n.name ? n.anzeigename : '' }))];
        if (!eintraege.length) { rechteInhalt.appendChild(leerHinweis(t('freigaben.rechte_keine_nutzer'))); } else {
          const tab = tabelle([{ text: t('freigaben.rechte_wer') }, { text: t('freigaben.rechte_kein'), klasse: 'vw-mitte' }, { text: t('freigaben.rechte_lesen_spalte'), klasse: 'vw-mitte' }, { text: t('freigaben.rechte_schreiben_spalte'), klasse: 'vw-mitte' }], [], { klasse: 'fg-rechte-tabelle' });
          for (const e of eintraege) {
            zuordnung[e.kennung] = rechtVon(daten, e.kennung);
            const gruppe = `recht-${e.kennung.replace(/[^a-z0-9_@.-]/g, '')}`;
            const radio = (wert) => {
              const r = el('input', { typ: 'radio', name: gruppe, wert });
              r.checked = zuordnung[e.kennung] === wert;
              r.setAttribute('aria-label', `${e.anzeige}: ${t(wert === 'kein' ? 'freigaben.rechte_kein' : wert === 'lesen' ? 'freigaben.rechte_lesen_spalte' : 'freigaben.rechte_schreiben_spalte')}`);
              r.addEventListener('change', () => { if (r.checked) zuordnung[e.kennung] = wert; });
              return el('td', { klasse: 'vw-mitte' }, r);
            };
            tabellenzeile(tab.koerper, [
              el('td', {}, el('span', { klasse: 'vw-mono', text: e.anzeige }), e.zusatz ? el('span', { klasse: 'vw-gedaempft fg-zusatz', text: ` ${e.zusatz}` }) : null),
              radio('kein'), radio('lesen'), radio('schreiben'),
            ]);
          }
          rechteInhalt.appendChild(tab.element);
        }
      } catch (e) {
        leeren(rechteInhalt); rechteInhalt.appendChild(hinweis(`${t('freigaben.rechte_laden_fehl')} ${fehlerText(e)}`, 'warnung'));
        // bestehende Rechte nicht verlieren
        for (const k of daten.lesen || []) zuordnung[k] = 'lesen';
        for (const k of daten.schreiben || []) zuordnung[k] = 'schreiben';
      }

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const ok = felderPruefen([
          { eingabe: name, pruefen: (w) => (MUSTER_FREIGABENAME.test(w.trim()) ? null : t('freigaben.name_fehler')) },
          { eingabe: beschreibung, pruefen: (w) => (MUSTER_BESCHREIBUNG.test(w) ? null : t('freigaben.beschreibung_fehler')) },
          { eingabe: kontingent, pruefen: (w) => (w === '' || (Number.isInteger(Number(w)) && Number(w) >= 0) ? null : t('freigaben.kontingent_fehler')) },
        ], fz);
        if (!ok) return;
        const { lesen, schreiben } = rechteListen(zuordnung);
        const params = {
          beschreibung: beschreibung.value.trim(), gaeste: gaeste.eingabe.checked, lesen, schreiben,
          papierkorb: papierkorb.eingabe.checked, timemachine: timemachine.eingabe.checked,
          groesse_gb: Number(kontingent.value) || 0, versteckt: versteckt.eingabe.checked,
        };
        if (krypt && krypt.eingabe.checked) {
          if (kryptPw.value.length < 8) { fz.zeigen(t('freigaben.krypt_zu_kurz')); kryptPw.focus(); return; }
          if (kryptPw.value !== kryptPw2.value) { fz.zeigen(t('freigaben.krypt_ungleich')); kryptPw2.focus(); return; }
          Object.assign(params, { verschluesselt: true, passwort: kryptPw.value, merken: kryptMerken.eingabe.checked, groesse_gb: 0 });
        }
        griff.beschaeftigt(true);
        try {
          if (neu) await api(ctx, 'freigaben.anlegen', { name: name.value.trim(), ...params });
          else await api(ctx, 'freigaben.aendern', { name: daten.name, ...params });
          melden(ctx, t(neu ? 'freigaben.angelegt' : 'freigaben.gespeichert', { name: neu ? name.value.trim() : daten.name }), 'erfolg');
          griff.schliessen();
          await laden();
        } catch (e) {
          griff.beschaeftigt(false);
          fz.zeigen(fehlerText(e));
          const feldName = e && e.details && e.details.feld;
          if (feldName === 'name') name.focus(); else if (feldName === 'groesse_gb') kontingent.focus(); else if (feldName === 'beschreibung') beschreibung.focus();
          form.scrollTop = 0;
        }
      });
    }

    // ---- Verschlüsselte Freigaben: entsperren / sperren -------------------------------------------------------
    function dialogEntsperren(f) {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const pw = eingabe({ typ: 'password', maxlength: 256, autocomplete: 'current-password' });
      const merken = schalter({ label: t('freigaben.krypt_merken'), erklaerung: t('freigaben.krypt_merken_erklaerung'), wert: !!f.schluessel_gespeichert });
      form.append(fz.element, feld({ label: t('freigaben.krypt_passwort'), eingabe: pw }), merken.element);
      const griff = dialogOeffnen({ ctx, titel: t('freigaben.krypt_entsperren_titel', { name: f.name }), inhalt: form, schliessenText: t('freigaben.schliessen'),
        knoepfe: [{ text: t('freigaben.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('freigaben.krypt_entsperren'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault(); fz.leeren(); griff.beschaeftigt(true);
        try { await api(ctx, 'freigaben.entsperren', { name: f.name, passwort: pw.value, merken: merken.eingabe.checked }); melden(ctx, t('freigaben.krypt_entsperrt', { name: f.name }), 'erfolg'); griff.schliessen(); await laden(); }
        catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); pw.focus(); }
      });
    }
    async function sperren(f) {
      if (!(await bestaetigen(ctx, t('freigaben.krypt_sperren_frage', { name: f.name })))) return;
      try { await api(ctx, 'freigaben.sperren', { name: f.name }); melden(ctx, t('freigaben.krypt_gesperrt_meldung', { name: f.name }), 'erfolg'); await laden(); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }

    // ---- Löschen -------------------------------------------------------------------------------------------
    function dialogLoeschen(f) {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const wahl = radiogruppe({ wert: 'behalten', optionen: [
        { wert: 'behalten', text: t('freigaben.loeschen_behalten'), erklaerung: t('freigaben.loeschen_behalten_erklaerung') },
        { wert: 'loeschen', text: t('freigaben.loeschen_loeschen'), erklaerung: t('freigaben.loeschen_loeschen_erklaerung') },
      ] });
      const tipp = eingabe({ maxlength: 32, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      tipp.setAttribute('autocapitalize', 'none');
      form.append(
        el('p', { text: t('freigaben.loeschen_erklaerung') }),
        el('div', { klasse: 'vw-feld' }, wahl.element),
        feld({ label: t('freigaben.loeschen_tippen'), erklaerung: t('freigaben.loeschen_tippen_erklaerung', { name: f.name }), eingabe: tipp }),
        fz.element,
      );
      const griff = dialogOeffnen({ ctx,
        titel: t('freigaben.loeschen_titel', { name: f.name }), inhalt: form, schliessenText: t('freigaben.schliessen'),
        knoepfe: [
          { text: t('freigaben.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('freigaben.loeschen_knopf'), art: 'gefahr', absenden: true, deaktiviert: true },
        ],
      });
      const loeschKnopf = griff.knoepfe[1];
      tipp.addEventListener('input', () => { loeschKnopf.disabled = tipp.value.trim() !== f.name; });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (tipp.value.trim() !== f.name) return;
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'freigaben.loeschen', { name: f.name, daten: wahl.wert() || 'behalten' });
          melden(ctx, t('freigaben.geloescht', { name: f.name }), 'erfolg');
          griff.schliessen();
          await laden();
        } catch (e) { griff.beschaeftigt(false); loeschKnopf.disabled = false; fz.zeigen(fehlerText(e)); }
      });
    }

    await laden();
    abmelder.push(abo(ctx, 'konfig', (e) => { const d = e && e.daten ? e.daten : e; if (!d || !d.bereich || d.bereich === 'freigaben' || d.bereich === 'nutzer') laden(); }));
  },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
