// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zusätzliche Karten der Systemansicht (Ausbau Oktober 2026): Benachrichtigungen (E-Mail/ntfy), VPN (WireGuard) – weitere
// folgen (Grafikkarte, Energie, Protokolle). Jede Karte lädt ihre Daten selbst und arbeitet nur über Agent-Aktionen.

import {
  el, leeren, eingabe, feld, schalter, auswahl, knopf, fehlerzeile, hinweis, leerHinweis, badge, api, fehlerText, melden, karte,
  aufgabeStarten, dialogOeffnen, tabelle, tabellenzeile, ampel, kopieren,
} from './verwaltung-hilfen.js';
import { qrErzeugen, qrZeichnen } from './nutzer.qr.js';
import { ntfyThemaNeu } from '../ntfy.js';

// weiterhin von hier exportiert (bestehende Importe)
export { ntfyThemaNeu };

/** Ereignisarten mit Sprachschlüsseln (Name + Erklärung). */
const EREIGNISSE = Object.freeze([
  ['platte', 'system.benachrichtigung_ereignis_platte', 'system.benachrichtigung_ereignis_platte_erklaerung'],
  ['spiegelung', 'system.benachrichtigung_ereignis_spiegelung', 'system.benachrichtigung_ereignis_spiegelung_erklaerung'],
  ['apps', 'system.benachrichtigung_ereignis_apps', 'system.benachrichtigung_ereignis_apps_erklaerung'],
  ['updates', 'system.benachrichtigung_ereignis_updates', 'system.benachrichtigung_ereignis_updates_erklaerung'],
  ['usv', 'system.benachrichtigung_ereignis_usv', 'system.benachrichtigung_ereignis_usv_erklaerung'],
  ['energie', 'system.benachrichtigung_ereignis_energie', 'system.benachrichtigung_ereignis_energie_erklaerung'],
  ['vpn', 'system.benachrichtigung_ereignis_vpn', 'system.benachrichtigung_ereignis_vpn_erklaerung'],
  ['vms', 'system.benachrichtigung_ereignis_vms', 'system.benachrichtigung_ereignis_vms_erklaerung'],
  ['anmeldung', 'system.benachrichtigung_ereignis_anmeldung', 'system.benachrichtigung_ereignis_anmeldung_erklaerung'],
]);
const STUFE_BADGE = Object.freeze({ info: '', warnung: 'warnung', fehler: 'gefahr' });
const STUFE_TEXT = Object.freeze({ info: 'system.benachrichtigung_stufe_info', warnung: 'system.benachrichtigung_stufe_warnung', fehler: 'system.benachrichtigung_stufe_fehler' });

/** Karte „Benachrichtigungen“: E-Mail und ntfy-Push, Ereignisse, Test senden, Verlauf. */
export function karteBenachrichtigungen(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.benachrichtigung_laden')));
  const element = karte(t('system.benachrichtigung_titel'), el('p', { klasse: 'erklaerung', text: t('system.benachrichtigung_erklaerung') }), inhalt);

  async function zeichnen() {
    let c; let verlauf = [];
    try { [c, verlauf] = await Promise.all([api(ctx, 'benachrichtigungen.lesen', {}), api(ctx, 'benachrichtigungen.verlauf', {})]); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    const fz = fehlerzeile();
    c = c && typeof c === 'object' ? c : {};
    if (!Array.isArray(verlauf)) verlauf = [];
    const e = c.email || {}; const n = c.ntfy || {}; c.ereignisse = c.ereignisse || {};
    // E-Mail
    const eAn = schalter({ label: t('system.benachrichtigung_email'), erklaerung: t('system.benachrichtigung_email_erklaerung'), wert: !!e.aktiv });
    const server = eingabe({ wert: e.server, platzhalter: 'smtp.gmail.com', spellcheck: false });
    const port = eingabe({ typ: 'number', min: 1, max: 65535, wert: e.port || 587 });
    const sicherheit = auswahl({ optionen: [{ wert: 'starttls', text: 'STARTTLS (587)' }, { wert: 'tls', text: 'TLS (465)' }, { wert: 'keine', text: t('system.benachrichtigung_ohne_verschluesselung') }], wert: e.sicherheit || 'starttls' });
    const benutzer = eingabe({ wert: e.benutzer, autocomplete: 'off', spellcheck: false });
    const passwort = eingabe({ typ: 'password', autocomplete: 'new-password', platzhalter: e.passwort_gesetzt ? t('system.benachrichtigung_unveraendert') : '' });
    const absender = eingabe({ wert: e.absender, platzhalter: 'nas@beispiel.de', spellcheck: false });
    const empfaenger = eingabe({ wert: (e.empfaenger || []).join(', '), platzhalter: 'ich@beispiel.de', spellcheck: false });
    const emailFelder = el('div', { klasse: 'sy-zusatz-felder' },
      feld({ label: t('system.benachrichtigung_server'), erklaerung: t('system.benachrichtigung_server_erklaerung'), eingabe: server }),
      feld({ label: t('system.benachrichtigung_port'), eingabe: port }), feld({ label: t('system.benachrichtigung_sicherheit'), eingabe: sicherheit }),
      feld({ label: t('system.benachrichtigung_benutzer'), erklaerung: t('system.benachrichtigung_benutzer_erklaerung'), eingabe: benutzer }),
      feld({ label: t('system.benachrichtigung_passwort'), erklaerung: t('system.benachrichtigung_passwort_erklaerung'), eingabe: passwort }),
      feld({ label: t('system.benachrichtigung_absender'), eingabe: absender }),
      feld({ label: t('system.benachrichtigung_empfaenger'), erklaerung: t('system.benachrichtigung_empfaenger_erklaerung'), eingabe: empfaenger }));
    const emailSicht = () => { emailFelder.hidden = !eAn.eingabe.checked; };
    eAn.eingabe.addEventListener('change', emailSicht); emailSicht();
    // ntfy: im Normalfall nichts eintippen – Thema denkt sich FAH-NAS aus, das Handy abonniert per QR-Code. Eigener Server,
    // Token, Benutzer/Passwort und ein anderes Thema stehen zugeklappt darunter.
    const nAn = schalter({ label: t('system.benachrichtigung_ntfy'), erklaerung: t('system.benachrichtigung_ntfy_erklaerung'), wert: !!n.aktiv });
    const nServer = eingabe({ wert: n.server || 'https://ntfy.sh', spellcheck: false });
    const thema = eingabe({ wert: n.thema || ntfyThemaNeu(), platzhalter: 'fah-nas-…', spellcheck: false, klasse: 'vw-mono' });
    const token = eingabe({ typ: 'password', autocomplete: 'new-password', platzhalter: n.token_gesetzt ? t('system.benachrichtigung_unveraendert') : 'tk_…' });
    const nBenutzer = eingabe({ wert: n.benutzer, autocomplete: 'off', spellcheck: false });
    const nPasswort = eingabe({ typ: 'password', autocomplete: 'new-password', platzhalter: n.passwort_gesetzt ? t('system.benachrichtigung_unveraendert') : '' });
    const eigenerServer = el('details', { klasse: 'vw-details sy-ntfy-eigen' }, el('summary', { text: t('system.benachrichtigung_ntfy_eigen') }),
      el('div', { klasse: 'sy-zusatz-felder' },
        feld({ label: t('system.benachrichtigung_ntfy_server'), erklaerung: t('system.benachrichtigung_ntfy_server_erklaerung'), eingabe: nServer }),
        feld({ label: t('system.benachrichtigung_thema'), erklaerung: t('system.benachrichtigung_thema_erklaerung'), eingabe: thema }),
        feld({ label: t('system.benachrichtigung_token'), erklaerung: t('system.benachrichtigung_token_erklaerung'), eingabe: token }),
        feld({ label: t('system.benachrichtigung_benutzer'), erklaerung: t('system.benachrichtigung_ntfy_benutzer_erklaerung'), eingabe: nBenutzer }),
        feld({ label: t('system.benachrichtigung_passwort'), eingabe: nPasswort })));
    if ((n.server && n.server.replace(/\/+$/, '') !== 'https://ntfy.sh') || n.token_gesetzt || n.benutzer) eigenerServer.open = true;
    const qr = el('canvas', { klasse: 'sy-ntfy-qr', attr: { role: 'img' } });
    const themaText = el('code', { klasse: 'vw-mono sy-ntfy-thema' });
    const adresse = () => `${(nServer.value.trim() || 'https://ntfy.sh').replace(/\/+$/, '')}/${thema.value.trim()}`;
    const qrNeu = () => {
      themaText.textContent = thema.value.trim();
      qr.setAttribute('aria-label', t('system.benachrichtigung_ntfy_qr', { adresse: adresse() }));
      try { qrZeichnen(qr, qrErzeugen(adresse()), 5, 4); qr.hidden = false; } catch { qr.hidden = true; }
    };
    nServer.addEventListener('input', qrNeu); thema.addEventListener('input', qrNeu); qrNeu();
    const themaKopieren = knopf(t('system.benachrichtigung_ntfy_kopieren'), { art: 'zweit', klein: true, beiKlick: async () => melden(ctx, t((await kopieren(thema.value.trim())) ? 'system.benachrichtigung_ntfy_kopiert' : 'system.benachrichtigung_ntfy_kopieren_fehl'), 'info') });
    const ntfyFelder = el('div', { klasse: 'sy-ntfy' },
      el('div', { klasse: 'sy-ntfy-einrichten' },
        el('div', { klasse: 'sy-ntfy-qr-rahmen' }, qr),
        el('div', {},
          el('ol', { klasse: 'sy-ntfy-schritte' },
            el('li', { text: t('system.benachrichtigung_ntfy_schritt1') }),
            el('li', {}, t('system.benachrichtigung_ntfy_schritt2'), ' ', themaText, ' ', themaKopieren),
            el('li', { text: t('system.benachrichtigung_ntfy_schritt3') })))),
      eigenerServer);
    const ntfySicht = () => { ntfyFelder.hidden = !nAn.eingabe.checked; };
    nAn.eingabe.addEventListener('change', ntfySicht); ntfySicht();
    // Ereignisse
    const schalterListe = EREIGNISSE.map(([art, label, erkl]) => [art, schalter({ label: t(label), erklaerung: t(erkl), wert: c.ereignisse[art] !== false })]);
    // Knöpfe
    const ergebnis = el('p', { klasse: 'erklaerung', attr: { 'aria-live': 'polite' } });
    const daten = () => ({
      email: { aktiv: eAn.eingabe.checked, server: server.value.trim(), port: Number(port.value) || 587, sicherheit: sicherheit.value, benutzer: benutzer.value.trim(), passwort: passwort.value, absender: absender.value.trim(), empfaenger: empfaenger.value },
      ntfy: { aktiv: nAn.eingabe.checked, server: nServer.value.trim(), thema: thema.value.trim(), token: token.value, benutzer: nBenutzer.value.trim(), passwort: nPasswort.value },
      ereignisse: Object.fromEntries(schalterListe.map(([art, s]) => [art, s.eingabe.checked])),
    });
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren(); speichern.disabled = true;
      try { await api(ctx, 'benachrichtigungen.speichern', daten()); melden(ctx, t('system.benachrichtigung_gespeichert'), 'erfolg'); await zeichnen(); } catch (f) { fz.zeigen(fehlerText(f)); } finally { speichern.disabled = false; }
    } });
    const test = knopf(t('system.benachrichtigung_test'), { art: 'zweit', beiKlick: async () => {
      fz.leeren(); test.disabled = true; ergebnis.textContent = t('system.benachrichtigung_test_laeuft');
      try {
        await api(ctx, 'benachrichtigungen.speichern', daten());
        const r = await api(ctx, 'benachrichtigungen.test', {});
        ergebnis.textContent = Object.entries(r || {}).map(([k, v]) => `${k === 'email' ? 'E-Mail' : 'ntfy'}: ${v === 'ok' ? t('system.benachrichtigung_test_ok') : v}`).join(' · ');
        await verlaufZeichnen();
      } catch (f) { ergebnis.textContent = ''; fz.zeigen(fehlerText(f)); } finally { test.disabled = false; }
    } });
    // Verlauf
    const verlaufListe = el('ul', { klasse: 'sy-meldungen', role: 'list' });
    async function verlaufZeichnen(liste = null) {
      if (!liste) { try { liste = await api(ctx, 'benachrichtigungen.verlauf', {}); } catch { liste = []; } }
      leeren(verlaufListe);
      if (!liste.length) { verlaufListe.appendChild(el('li', { klasse: 'vw-gedaempft', text: t('system.benachrichtigung_verlauf_leer') })); return; }
      for (const m of liste.slice(0, 10)) {
        const fehler = Object.entries(m.kanaele || {}).filter(([, v]) => v !== 'ok');
        verlaufListe.appendChild(el('li', {}, badge(t(STUFE_TEXT[m.stufe] || STUFE_TEXT.info), undefined, STUFE_BADGE[m.stufe] || ''),
          ` ${fmt.zeit(m.zeit)} · ${m.titel}`, fehler.length ? el('span', { klasse: 'vw-rot', text: ` – ${fehler.map(([k, v]) => `${k}: ${v}`).join('; ')}` }) : null));
      }
    }
    leeren(inhalt);
    inhalt.append(fz.element,
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.benachrichtigung_kanaele') }), eAn.element, emailFelder, nAn.element, ntfyFelder,
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.benachrichtigung_ereignisse') }), ...schalterListe.map(([, s]) => s.element),
      el('div', { klasse: 'vw-knopfleiste' }, speichern, test), ergebnis,
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.benachrichtigung_verlauf') }), verlaufListe);
    verlaufZeichnen(verlauf);
  }
  zeichnen();
  return element;
}

// ---- VPN (WireGuard) ---------------------------------------------------------------------------------------------
const ZUGRIFF = Object.freeze(['nas', 'heimnetz', 'alles']);
const ZUGRIFF_TEXT = Object.freeze({ nas: 'system.vpn_zugriff_nas', heimnetz: 'system.vpn_zugriff_heimnetz', alles: 'system.vpn_zugriff_alles' });
export const VPN_GESAMT_TEXT = Object.freeze({ ok: 'system.vpn_gesamt_ok', warnung: 'system.vpn_gesamt_warnung', fehler: 'system.vpn_gesamt_fehler' });
const SCHRITT_AMPEL = Object.freeze({ ok: 'aktiv', warnung: 'warnung', fehler: 'fehler', info: 'unbekannt' });

/** Dialog mit QR-Code, Download und Text der Gerätekonfiguration. */
export function vpnKonfigDialog(ctx, t, k) {
  const url = URL.createObjectURL(new Blob([k.text], { type: 'text/plain' }));
  const laden = el('a', { klasse: 'knopf', text: t('system.vpn_herunterladen'), attr: { href: url, download: k.dateiname } });
  const qr = k.qr_svg ? el('img', { klasse: 'sy-vpn-qr', attr: { src: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(k.qr_svg)))}`, alt: t('system.vpn_qr_alt', { name: k.name }) } }) : hinweis(t('system.vpn_qr_fehlt'), 'warnung');
  const text = el('pre', { klasse: 'sy-vpn-text vw-mono', text: k.text });
  dialogOeffnen({
    ctx, titel: t('system.vpn_konfig_titel', { name: k.name }), schliessenText: t('system.schliessen'),
    inhalt: el('div', { klasse: 'sy-vpn-dialog' }, el('p', { klasse: 'erklaerung', text: t('system.vpn_konfig_erklaerung') }), qr, el('div', { klasse: 'vw-knopfleiste' }, laden), el('details', {}, el('summary', { text: t('system.vpn_konfig_text') }), text)),
    knoepfe: [{ text: t('system.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }],
    beimSchliessen: () => setTimeout(() => URL.revokeObjectURL(url), 60_000),
  });
}

/** Ergebnis des Selbsttests als Liste (Ampel, Titel, Text, „So geht’s“). */
export function vpnSelbsttestListe(t, fmt, e) {
  if (!e || !Array.isArray(e.schritte)) return leerHinweis(t('system.vpn_selbsttest_nie'));
  return el('div', {},
    el('p', { klasse: 'erklaerung', text: t('system.vpn_selbsttest_stand', { zeit: fmt.zeit(e.zeit), ergebnis: t(VPN_GESAMT_TEXT[e.gesamt] || VPN_GESAMT_TEXT.fehler) }) }),
    el('ul', { klasse: 'sy-vpn-schritte', role: 'list' }, e.schritte.map((s) => el('li', { klasse: `sy-vpn-schritt sy-vpn-${s.zustand}` },
      el('div', { klasse: 'sy-vpn-schritt-kopf' }, ampel(SCHRITT_AMPEL[s.zustand] || 'unbekannt', s.zustand), el('strong', { text: s.titel })),
      s.text ? el('p', { klasse: 'erklaerung', text: s.text }) : null,
      s.tun ? el('div', { klasse: 'sy-vpn-tun' }, el('strong', { text: t('system.vpn_so_gehts') }), el('p', { text: s.tun })) : null))));
}

/** Karte „VPN (WireGuard)“: Server, Adresse, Geräte mit QR-Code, Selbsttest. */
export function karteVpn(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.vpn_laden')));
  const element = karte(t('system.vpn_titel'), el('p', { klasse: 'erklaerung', text: t('system.vpn_erklaerung') }), inhalt);
  let takt = null;

  async function zeichnen() {
    let c; let status = null;
    try { [c, status] = await Promise.all([api(ctx, 'vpn.lesen', {}), api(ctx, 'vpn.status', {}).catch(() => null)]); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    c = c && typeof c === 'object' ? c : {};
    const geraete = Array.isArray(c.geraete) ? c.geraete : [];
    const fz = fehlerzeile();
    const an = schalter({ label: t('system.vpn_server'), erklaerung: t('system.vpn_server_erklaerung'), wert: !!c.aktiv });
    const adresse = eingabe({ wert: c.adresse, platzhalter: 'meinname.dyndns.org', spellcheck: false });
    const ipKnopf = knopf(t('system.vpn_ip_eintragen'), { art: 'zweit', klein: true, beiKlick: async () => {
      fz.leeren(); ipKnopf.disabled = true;
      try { const r = await api(ctx, 'vpn.oeffentliche_ip', {}); adresse.value = r.ip; } catch (f) { fz.zeigen(fehlerText(f)); } finally { ipKnopf.disabled = false; }
    } });
    const port = eingabe({ typ: 'number', min: 1024, max: 65535, wert: c.port || 51821 });
    const netz = eingabe({ wert: c.netz, spellcheck: false });
    if (geraete.length) netz.disabled = true;
    const dns = eingabe({ wert: c.dns, platzhalter: t('system.vpn_dns_automatisch'), spellcheck: false });
    const felder = el('div', { klasse: 'sy-zusatz-felder' },
      feld({ label: t('system.vpn_adresse'), erklaerung: t('system.vpn_adresse_erklaerung'), eingabe: adresse, hinweisElement: ipKnopf }),
      feld({ label: t('system.vpn_port'), erklaerung: t('system.vpn_port_erklaerung'), eingabe: port }),
      feld({ label: t('system.vpn_netz'), erklaerung: t(geraete.length ? 'system.vpn_netz_gesperrt' : 'system.vpn_netz_erklaerung'), eingabe: netz }),
      feld({ label: t('system.vpn_dns'), erklaerung: t('system.vpn_dns_erklaerung'), eingabe: dns }));
    const zustand = el('p', { klasse: 'erklaerung' },
      ampel(c.aktiv ? (c.laeuft ? 'aktiv' : 'fehler') : 'inaktiv'), ' ',
      c.aktiv ? (c.laeuft ? t('system.vpn_laeuft', { port: c.port, ip: c.server_ip }) : t('system.vpn_laeuft_nicht')) : t('system.vpn_aus'));
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren();
      try {
        const r = await aufgabeStarten(ctx, 'vpn.speichern', { aktiv: an.eingabe.checked, port: Number(port.value), netz: netz.value.trim(), adresse: adresse.value.trim(), dns: dns.value.trim() },
          { titel: t('system.vpn_titel'), meldung: t('system.vpn_speichern_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') });
        melden(ctx, r && r.hinweis ? r.hinweis : t('system.vpn_gespeichert'), 'erfolg');
        await zeichnen();
      } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
    } });
    const testErgebnis = el('div', {}, vpnSelbsttestListe(t, fmt, c.selbsttest));
    const test = knopf(t('system.vpn_selbsttest'), { art: 'zweit', deaktiviert: !c.aktiv, beiKlick: async () => {
      fz.leeren();
      try {
        const r = await aufgabeStarten(ctx, 'vpn.selbsttest', {}, { titel: t('system.vpn_selbsttest'), meldung: t('system.vpn_selbsttest_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') });
        leeren(testErgebnis); testErgebnis.appendChild(vpnSelbsttestListe(t, fmt, r));
      } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
    } });

    // Geräte
    const je = new Map(((status && status.geraete) || []).map((g) => [g.id, g]));
    const tab = tabelle([{ text: t('system.vpn_geraet') }, { text: t('system.vpn_zugriff') }, { text: t('system.vpn_status') }, { text: '' }]);
    for (const g of geraete) {
      const s = je.get(g.id) || {};
      const zugriff = auswahl({ optionen: ZUGRIFF.map((z) => ({ wert: z, text: t(ZUGRIFF_TEXT[z]) })), wert: g.zugriff });
      zugriff.addEventListener('change', async () => {
        fz.leeren();
        try { await api(ctx, 'vpn.geraet.aendern', { id: g.id, zugriff: zugriff.value }); melden(ctx, t('system.vpn_zugriff_geaendert', { name: g.name }), 'erfolg'); } catch (f) { fz.zeigen(fehlerText(f)); zugriff.value = g.zugriff; }
      });
      const stand = s.verbunden ? t('system.vpn_verbunden', { zeit: fmt.zeit(s.handshake) }) : s.handshake ? t('system.vpn_zuletzt', { zeit: fmt.zeit(s.handshake) }) : t('system.vpn_nie');
      tabellenzeile(tab.koerper, [
        el('div', {}, el('strong', { text: g.name }), el('div', { klasse: 'vw-gedaempft vw-mono', text: g.ip })),
        zugriff,
        el('div', {}, ampel(s.verbunden ? 'aktiv' : 'inaktiv'), ` ${stand}`, s.rx || s.tx ? el('div', { klasse: 'vw-gedaempft', text: `↓ ${fmt.groesse(s.tx)} · ↑ ${fmt.groesse(s.rx)}` }) : null),
        el('div', { klasse: 'vw-knopfleiste' },
          knopf(t('system.vpn_qr'), { art: 'zweit', klein: true, beiKlick: async () => { fz.leeren(); try { vpnKonfigDialog(ctx, t, await api(ctx, 'vpn.geraet.konfig', { id: g.id })); } catch (f) { fz.zeigen(fehlerText(f)); } } }),
          knopf(t('system.vpn_loeschen'), { art: 'gefahr', klein: true, beiKlick: async () => {
            if (typeof ctx.bestaetigen === 'function' && !(await ctx.bestaetigen(t('system.vpn_loeschen_frage', { name: g.name })))) return;
            fz.leeren();
            try { await api(ctx, 'vpn.geraet.loeschen', { id: g.id }); await zeichnen(); } catch (f) { fz.zeigen(fehlerText(f)); }
          } })),
      ]);
    }
    const neuName = eingabe({ platzhalter: t('system.vpn_neu_platzhalter'), maxlength: 32 });
    const neuZugriff = auswahl({ optionen: ZUGRIFF.map((z) => ({ wert: z, text: t(ZUGRIFF_TEXT[z]) })), wert: 'nas' });
    const neu = knopf(t('system.vpn_neu'), { beiKlick: async () => {
      fz.leeren(); neu.disabled = true;
      try { const k = await api(ctx, 'vpn.geraet.anlegen', { name: neuName.value.trim(), zugriff: neuZugriff.value }); neuName.value = ''; await zeichnen(); vpnKonfigDialog(ctx, t, k); } catch (f) { fz.zeigen(fehlerText(f)); } finally { neu.disabled = false; }
    } });

    leeren(inhalt);
    inhalt.append(...[fz.element, zustand,
      c.pakete_fehlen && c.pakete_fehlen.length ? hinweis(t('system.vpn_pakete', { pakete: c.pakete_fehlen.join(', ') }), 'info') : null,
      an.element, felder, el('div', { klasse: 'vw-knopfleiste' }, speichern, test),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.vpn_geraete') }),
      geraete.length ? tab.element : leerHinweis(t('system.vpn_keine_geraete')),
      el('div', { klasse: 'sy-zusatz-felder' },
        feld({ label: t('system.vpn_neu_name'), erklaerung: t('system.vpn_neu_erklaerung'), eingabe: neuName }),
        feld({ label: t('system.vpn_zugriff'), erklaerung: t('system.vpn_zugriff_erklaerung'), eingabe: neuZugriff })),
      el('div', { klasse: 'vw-knopfleiste' }, neu),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.vpn_selbsttest') }), el('p', { klasse: 'erklaerung', text: t('system.vpn_selbsttest_erklaerung') }), testErgebnis].filter(Boolean));
    if (takt) clearInterval(takt);
    if (c.aktiv && geraete.length) takt = setInterval(() => { if (!element.isConnected) { clearInterval(takt); takt = null; return; } if (!document.hidden && !inhalt.contains(document.activeElement)) zeichnen(); }, 30_000);
  }
  zeichnen();
  return element;
}

// ---- Grafikkarte -------------------------------------------------------------------------------------------------
/** Kurzbeschreibung einer Karte: Modell · Treiber · Takt bzw. Auslastung. */
export function gpuZeile(t, k) {
  const teile = [k.treiber ? t('system.gpu_treiber', { treiber: k.treiber }) : t('system.gpu_kein_treiber')];
  if (k.takt) teile.push(t('system.gpu_takt', { aktuell: k.takt.aktuell, max: k.takt.max }));
  if (k.auslastung !== null && k.auslastung !== undefined) teile.push(t('system.gpu_auslastung', { wert: k.auslastung }));
  return teile.join(' · ');
}

/** Karte „Grafikkarte“: erkannte GPUs, NVIDIA einrichten, Apps mit GPU. */
export function karteGpu(ctx, t) {
  const inhalt = el('div', {}, leerHinweis(t('system.gpu_laden')));
  const element = karte(t('system.gpu_titel'), el('p', { klasse: 'erklaerung', text: t('system.gpu_erklaerung') }), inhalt);

  async function zeichnen() {
    let g;
    try { g = await api(ctx, 'gpu.lesen', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    g = g && typeof g === 'object' ? g : {};
    const karten = Array.isArray(g.karten) ? g.karten : [];
    const nv = g.nvidia || {};
    const apps = Array.isArray(g.apps) ? g.apps : [];
    const fz = fehlerzeile();
    const teile = [fz.element];
    if (!karten.length) teile.push(leerHinweis(t('system.gpu_keine')));
    else {
      teile.push(el('ul', { klasse: 'sy-meldungen', role: 'list' }, karten.map((k) => el('li', {},
        el('strong', { text: `${k.hersteller_name} ${k.modell}` }), el('div', { klasse: 'vw-gedaempft', text: gpuZeile(t, k) })))));
    }
    if (g.dri && g.dri.vorhanden) teile.push(el('p', { klasse: 'erklaerung' }, ampel('aktiv'), ` ${t('system.gpu_dri_bereit', { geraete: g.dri.geraete.join(', ') })}`));
    if (nv.karte) {
      const zeile = (ok, text) => el('li', {}, ampel(ok ? 'aktiv' : 'inaktiv'), ` ${text}`);
      teile.push(el('h3', { klasse: 'sy-zusatz-abschnitt', text: 'NVIDIA' }),
        el('ul', { klasse: 'sy-meldungen', role: 'list' },
          zeile(nv.treiber, nv.treiber ? t('system.gpu_nv_treiber_ok', { version: (nv.smi[0] || {}).treiber || '?' }) : t('system.gpu_nv_treiber_fehlt')),
          zeile(nv.toolkit, t(nv.toolkit ? 'system.gpu_nv_toolkit_ok' : 'system.gpu_nv_toolkit_fehlt')),
          zeile(nv.docker, t(nv.docker ? 'system.gpu_nv_docker_ok' : 'system.gpu_nv_docker_fehlt'))));
      for (const s of nv.smi || []) teile.push(el('p', { klasse: 'erklaerung', text: t('system.gpu_nv_werte', { name: s.name, last: s.auslastung ?? '–', belegt: s.speicher_belegt_mb ?? '–', gesamt: s.speicher_mb ?? '–', temp: s.temperatur ?? '–' }) }));
      if (!nv.bereit) {
        const einrichten = knopf(t('system.gpu_nv_einrichten'), { beiKlick: async () => {
          if (typeof ctx.bestaetigen === 'function' && !(await ctx.bestaetigen(t('system.gpu_nv_einrichten_frage')))) return;
          fz.leeren();
          try {
            const r = await aufgabeStarten(ctx, 'gpu.nvidia_einrichten', {}, { titel: t('system.gpu_nv_einrichten'), meldung: t('system.gpu_nv_einrichten_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') });
            melden(ctx, r && r.neustart_noetig ? t('system.gpu_nv_neustart') : t('system.gpu_nv_fertig'), 'erfolg');
            await zeichnen();
          } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
        } });
        teile.push(el('p', { klasse: 'erklaerung', text: t('system.gpu_nv_einrichten_erklaerung') }), el('div', { klasse: 'vw-knopfleiste' }, einrichten));
      }
    }
    teile.push(el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.gpu_apps') }),
      apps.length ? el('ul', { klasse: 'sy-meldungen', role: 'list' }, apps.map((a) => el('li', {}, ampel(a.laeuft ? 'aktiv' : 'inaktiv'), ` ${a.app} · ${a.art === 'nvidia' ? 'NVIDIA' : 'Intel/AMD'}`)))
        : leerHinweis(t('system.gpu_apps_keine')));
    leeren(inhalt);
    inhalt.append(...teile);
  }
  zeichnen();
  return element;
}

// ---- Energie: Zeitplan, Wake-on-LAN, USV ---------------------------------------------------------------------------
const TAGE = Object.freeze([[1, 'system.tag_mo'], [2, 'system.tag_di'], [3, 'system.tag_mi'], [4, 'system.tag_do'], [5, 'system.tag_fr'], [6, 'system.tag_sa'], [0, 'system.tag_so']]);

/** Wochentage als Kästchen → {element, wert()} (0 = Sonntag wie Date.getDay()). */
function tageWahl(t, gewaehlt = []) {
  const kaesten = TAGE.map(([n, k]) => { const c = el('input', { typ: 'checkbox' }); c.checked = gewaehlt.includes(n); return [n, c, el('label', { klasse: 'sy-tag' }, c, el('span', { text: t(k) }))]; });
  return { element: el('div', { klasse: 'sy-tage', attr: { role: 'group' } }, kaesten.map((x) => x[2])), wert: () => kaesten.filter((x) => x[1].checked).map((x) => x[0]) };
}

/** USV-Zustand als Text. */
export function usvText(t, s) {
  if (!s) return t('system.usv_aus');
  if (s.fehler) return t('system.usv_fehler', { fehler: s.fehler });
  const teile = [s.akku ? t('system.usv_akku') : s.netz ? t('system.usv_netz') : s.status || '?'];
  if (s.ladung !== null && s.ladung !== undefined) teile.push(t('system.usv_ladung', { wert: s.ladung }));
  if (s.restzeit_s) teile.push(t('system.usv_restzeit', { min: Math.round(s.restzeit_s / 60) }));
  if (s.modell) teile.push(s.modell);
  return teile.join(' · ');
}

/** Karte „Zeitplan, Wake-on-LAN und USV“. */
export function karteEnergieZusatz(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.energie2_laden')));
  const element = karte(t('system.energie2_titel'), el('p', { klasse: 'erklaerung', text: t('system.energie2_erklaerung') }), inhalt);

  async function zeichnen() {
    let c; let st = null;
    try { [c, st] = await Promise.all([api(ctx, 'energie.lesen', {}), api(ctx, 'energie.status', {}).catch(() => null)]); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    c = c && typeof c === 'object' ? c : {};
    const z = c.zeitplan || { aus: {}, an: {} }; const wol = c.wol || {}; const u = c.usv || {};
    const fz = fehlerzeile();
    // Zeitplan
    const zAn = schalter({ label: t('system.zeitplan_an'), erklaerung: t('system.zeitplan_an_erklaerung'), wert: !!z.aktiv });
    const ausTage = tageWahl(t, (z.aus && z.aus.tage) || []);
    const ausZeit = eingabe({ typ: 'time', wert: (z.aus && z.aus.zeit) || '23:00' });
    const anSchalter = schalter({ label: t('system.zeitplan_wieder_an'), erklaerung: t('system.zeitplan_wieder_an_erklaerung'), wert: !!(z.an && z.an.aktiv) });
    const anTage = tageWahl(t, (z.an && z.an.tage) || []);
    const anZeit = eingabe({ typ: 'time', wert: (z.an && z.an.zeit) || '07:00' });
    const anFelder = el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.zeitplan_an_tage'), eingabe: anTage.element }), feld({ label: t('system.zeitplan_an_zeit'), eingabe: anZeit }));
    const zFelder = el('div', {}, el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.zeitplan_aus_tage'), eingabe: ausTage.element }), feld({ label: t('system.zeitplan_aus_zeit'), erklaerung: t('system.zeitplan_aus_erklaerung'), eingabe: ausZeit })), anSchalter.element, anFelder);
    const sicht = () => { zFelder.hidden = !zAn.eingabe.checked; anFelder.hidden = !anSchalter.eingabe.checked; };
    zAn.eingabe.addEventListener('change', sicht); anSchalter.eingabe.addEventListener('change', sicht); sicht();
    const naechste = el('p', { klasse: 'erklaerung', text: [c.naechstes_aus ? t('system.zeitplan_naechstes_aus', { zeit: fmt.zeit(c.naechstes_aus) }) : null, c.naechstes_an ? t('system.zeitplan_naechstes_an', { zeit: fmt.zeit(c.naechstes_an) }) : null].filter(Boolean).join(' · ') });
    // Wake-on-LAN
    const wolAn = schalter({ label: t('system.wol_an'), erklaerung: wol.schnittstelle ? t('system.wol_an_erklaerung', { mac: wol.mac || '?', schnittstelle: wol.schnittstelle }) : t('system.wol_keine_schnittstelle'), wert: !!wol.an });
    if (!wol.unterstuetzt) { wolAn.eingabe.disabled = !wol.an; }
    let geraete = Array.isArray(c.wol_geraete) ? [...c.wol_geraete] : [];
    const geraeteListe = el('ul', { klasse: 'sy-meldungen', role: 'list' });
    const geraeteZeichnen = () => {
      leeren(geraeteListe);
      if (!geraete.length) { geraeteListe.appendChild(el('li', { klasse: 'vw-gedaempft', text: t('system.wol_geraete_leer') })); return; }
      for (const g of geraete) {
        geraeteListe.appendChild(el('li', {}, el('strong', { text: g.name }), ` ${g.mac} `,
          knopf(t('system.wol_aufwecken'), { art: 'zweit', klein: true, beiKlick: async () => { fz.leeren(); try { await api(ctx, 'energie.aufwecken', { mac: g.mac }); melden(ctx, t('system.wol_gesendet', { name: g.name }), 'erfolg'); } catch (f) { fz.zeigen(fehlerText(f)); } } }),
          knopf(t('system.vpn_loeschen'), { art: 'gefahr', klein: true, beiKlick: () => { geraete = geraete.filter((x) => x !== g); geraeteZeichnen(); } })));
      }
    };
    geraeteZeichnen();
    const neuName = eingabe({ platzhalter: t('system.wol_neu_name'), maxlength: 32 });
    const neuMac = eingabe({ platzhalter: '00:11:22:33:44:55', spellcheck: false, maxlength: 17 });
    const neuKnopf = knopf(t('system.wol_hinzufuegen'), { art: 'zweit', klein: true, beiKlick: () => {
      if (!neuName.value.trim() || !/^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/i.test(neuMac.value.trim())) { fz.zeigen(t('system.wol_neu_fehler')); return; }
      fz.leeren(); geraete.push({ name: neuName.value.trim(), mac: neuMac.value.trim() }); neuName.value = ''; neuMac.value = ''; geraeteZeichnen();
    } });
    // USV
    const uAn = schalter({ label: t('system.usv_an'), erklaerung: t('system.usv_an_erklaerung'), wert: !!u.aktiv });
    const art = auswahl({ optionen: [{ wert: 'usb', text: t('system.usv_art_usb') }, { wert: 'netz', text: t('system.usv_art_netz') }], wert: u.art || 'usb' });
    const host = eingabe({ wert: u.host, platzhalter: '192.168.1.23', spellcheck: false });
    const upsName = eingabe({ wert: u.ups || 'ups', spellcheck: false });
    const benutzer = eingabe({ wert: u.benutzer, platzhalter: 'monuser', spellcheck: false, autocomplete: 'off' });
    const passwort = eingabe({ typ: 'password', autocomplete: 'new-password', platzhalter: u.passwort_gesetzt ? t('system.benachrichtigung_unveraendert') : '' });
    const akku = eingabe({ typ: 'number', min: 5, max: 95, wert: u.akku_unter ?? 30 });
    const minuten = eingabe({ typ: 'number', min: 0, max: 240, wert: u.minuten_auf_akku ?? 0 });
    const netzFelder = el('div', { klasse: 'sy-zusatz-felder' },
      feld({ label: t('system.usv_host'), erklaerung: t('system.usv_host_erklaerung'), eingabe: host }), feld({ label: t('system.usv_name'), eingabe: upsName }),
      feld({ label: t('system.usv_benutzer'), erklaerung: t('system.usv_benutzer_erklaerung'), eingabe: benutzer }), feld({ label: t('system.benachrichtigung_passwort'), eingabe: passwort }));
    const suchen = knopf(t('system.usv_suchen'), { art: 'zweit', klein: true, beiKlick: async () => {
      fz.leeren();
      try { const e = await aufgabeStarten(ctx, 'energie.usv_suchen', {}, { titel: t('system.usv_suchen'), meldung: t('system.usv_suchen_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') }); melden(ctx, e && e.gefunden ? t('system.usv_gefunden', { name: [e.treiber.vendor, e.treiber.product].filter(Boolean).join(' ') || e.treiber.driver }) : t('system.usv_nicht_gefunden'), e && e.gefunden ? 'erfolg' : 'warnung'); } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
    } });
    const uFelder = el('div', {}, el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.usv_art'), erklaerung: t('system.usv_art_erklaerung'), eingabe: art, hinweisElement: suchen })), netzFelder,
      el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.usv_akku_unter'), erklaerung: t('system.usv_akku_unter_erklaerung'), eingabe: akku }), feld({ label: t('system.usv_minuten'), erklaerung: t('system.usv_minuten_erklaerung'), eingabe: minuten })));
    const uSicht = () => { uFelder.hidden = !uAn.eingabe.checked; netzFelder.hidden = art.value !== 'netz'; suchen.hidden = art.value !== 'usb'; };
    uAn.eingabe.addEventListener('change', uSicht); art.addEventListener('change', uSicht); uSicht();
    const usvZustand = el('p', { klasse: 'erklaerung' }, ampel(!st || !st.usv_aktiv ? 'inaktiv' : st.usv && !st.usv.fehler ? (st.usv.akku ? 'warnung' : 'aktiv') : 'fehler'), ` ${usvText(t, st && st.usv_aktiv ? st.usv : null)}`);
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren();
      const daten = {
        zeitplan: { aktiv: zAn.eingabe.checked, aus: { tage: ausTage.wert(), zeit: ausZeit.value }, an: { aktiv: anSchalter.eingabe.checked, tage: anTage.wert(), zeit: anZeit.value } },
        wol: { geraete, ...(wolAn.eingabe.checked !== !!wol.an ? { an: wolAn.eingabe.checked } : {}) },
        usv: { aktiv: uAn.eingabe.checked, art: art.value, host: host.value.trim(), ups: upsName.value.trim(), benutzer: benutzer.value.trim(), passwort: passwort.value, akku_unter: Number(akku.value), minuten_auf_akku: Number(minuten.value) },
      };
      if (!uAn.eingabe.checked && !u.aktiv) delete daten.usv.passwort;
      try { await aufgabeStarten(ctx, 'energie.speichern', daten, { titel: t('system.energie2_titel'), meldung: t('system.energie2_speichern_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') }); melden(ctx, t('system.energie2_gespeichert'), 'erfolg'); await zeichnen(); } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
    } });
    leeren(inhalt);
    inhalt.append(...[fz.element,
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.zeitplan_titel') }), zAn.element, zFelder, naechste.textContent ? naechste : null,
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.wol_titel') }), wolAn.element,
      el('p', { klasse: 'erklaerung', text: t('system.wol_geraete_erklaerung') }), geraeteListe, el('div', { klasse: 'vw-knopfleiste' }, neuName, neuMac, neuKnopf),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.usv_titel') }), usvZustand,
      c.usv_pakete_fehlen && c.usv_pakete_fehlen.length && !u.aktiv ? hinweis(t('system.vpn_pakete', { pakete: c.usv_pakete_fehlen.join(', ') }), 'info') : null,
      uAn.element, uFelder, el('div', { klasse: 'vw-knopfleiste' }, speichern)].filter(Boolean));
  }
  zeichnen();
  return element;
}

// ---- Protokolle: NFS, SFTP, WebDAV, DLNA -------------------------------------------------------------------------
const DIENST_AMPEL = (z) => (z === 'active' ? 'aktiv' : z === 'failed' ? 'fehler' : 'inaktiv');

/** Karte „Weitere Protokolle“. */
export function karteProtokolle(ctx, t) {
  const inhalt = el('div', {}, leerHinweis(t('system.proto_laden')));
  const element = karte(t('system.proto_titel'), el('p', { klasse: 'erklaerung', text: t('system.proto_erklaerung') }), inhalt);
  const host = (typeof location !== 'undefined' && location.hostname) || 'fahnas';

  async function zeichnen() {
    let c;
    try { c = await api(ctx, 'protokolle.lesen', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    c = c && typeof c === 'object' ? c : {};
    const z = c.zustand || {};
    const freigaben = Array.isArray(c.freigaben) ? c.freigaben : [];
    const nutzer = Array.isArray(c.nutzer) ? c.nutzer : [];
    const fz = fehlerzeile();
    const kopf = (titel, zustand, an) => el('h3', { klasse: 'sy-zusatz-abschnitt' }, ampel(an ? DIENST_AMPEL(zustand) : 'inaktiv'), ` ${titel}`);
    // SMB (12.10.2026: abschaltbar wie die anderen)
    const smb = schalter({ label: t('system.proto_eingeschaltet'), erklaerung: t('system.proto_smb_erklaerung', { adresse: `\\\\${host}` }), wert: !(c.smb && c.smb.aktiv === false) });
    const smbHinweis = hinweis(t('system.proto_smb_aus_hinweis'), 'info');
    smb.eingabe.addEventListener('change', () => { smbHinweis.hidden = smb.eingabe.checked; });
    smbHinweis.hidden = smb.eingabe.checked;
    // SFTP
    const sftp = schalter({ label: t('system.proto_eingeschaltet'), erklaerung: t('system.proto_sftp_erklaerung', { adresse: `sftp://${host}` }), wert: !!(c.sftp && c.sftp.aktiv) });
    // WebDAV
    const wd = c.webdav || {};
    const webdav = schalter({ label: t('system.proto_eingeschaltet'), erklaerung: t('system.proto_webdav_erklaerung', { adresse: `https://${host}:${wd.port || 5006}` }), wert: !!wd.aktiv });
    const wdPort = eingabe({ typ: 'number', min: 1024, max: 65535, wert: wd.port || 5006 });
    const wdFelder = el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.vpn_port').replace(' (UDP)', ''), erklaerung: t('system.proto_webdav_port_erklaerung'), eingabe: wdPort }));
    // NFS
    const nf = c.nfs || { freigaben: [] };
    const nfs = schalter({ label: t('system.proto_eingeschaltet'), erklaerung: t('system.proto_nfs_erklaerung'), wert: !!nf.aktiv });
    const nfsNetz = eingabe({ wert: nf.netz || c.lan_vorschlag || '', platzhalter: '192.168.1.0/24', spellcheck: false });
    const nfsZeilen = freigaben.filter((f) => !f.extern).map((f) => {
      const vorher = (nf.freigaben || []).find((x) => x.name === f.name);
      const an = el('input', { typ: 'checkbox' }); an.checked = !!vorher;
      const ro = el('input', { typ: 'checkbox' }); ro.checked = !!(vorher && vorher.nur_lesen);
      const als = auswahl({ optionen: nutzer.map((n) => ({ wert: n, text: n })), wert: (vorher && vorher.als_nutzer) || nutzer[0] });
      return { name: f.name, an, ro, als, element: el('div', { klasse: 'sy-proto-zeile' }, el('label', { klasse: 'sy-tag' }, an, el('strong', { text: f.name })), el('label', { klasse: 'sy-tag' }, ro, el('span', { text: t('system.proto_nur_lesen') })), el('span', { text: t('system.proto_als_nutzer') }), als, el('code', { klasse: 'vw-gedaempft', text: `${host}:/data/shares/${f.name}` })) };
    });
    const nfsFelder = el('div', {}, el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.proto_nfs_netz'), erklaerung: t('system.proto_nfs_netz_erklaerung'), eingabe: nfsNetz })),
      el('p', { klasse: 'erklaerung', text: t('system.proto_nfs_freigaben') }), ...(nfsZeilen.length ? nfsZeilen.map((x) => x.element) : [leerHinweis(t('system.proto_keine_freigaben'))]));
    // DLNA
    const dl = c.dlna || { ordner: [] };
    const dlna = schalter({ label: t('system.proto_eingeschaltet'), erklaerung: t('system.proto_dlna_erklaerung'), wert: !!dl.aktiv });
    const dlName = eingabe({ wert: dl.name || 'FAH-NAS', maxlength: 64 });
    // Medienordner (Betreiber 12.10.2026: Unterordner per Auswahl statt nur ganzer Freigaben)
    let dlOrdner = Array.isArray(dl.ordner) ? dl.ordner.map((o) => ({ freigabe: o.freigabe, pfad: o.pfad || '' })) : [];
    const dlListe = el('ul', { klasse: 'sy-meldungen sy-dlna-liste', role: 'list' });
    const dlListeZeichnen = () => {
      leeren(dlListe);
      if (!dlOrdner.length) { dlListe.appendChild(el('li', { klasse: 'vw-gedaempft', text: t('system.proto_dlna_keine_ordner') })); return; }
      for (const o of dlOrdner) {
        dlListe.appendChild(el('li', {}, el('span', { klasse: 'vw-mono', text: `📁 ${o.pfad ? `${o.freigabe}/${o.pfad}` : o.freigabe}` }), ' ',
          knopf('×', { art: 'zweit', klein: true, titel: t('system.proto_dlna_entfernen'), beiKlick: () => { dlOrdner = dlOrdner.filter((x) => x !== o); dlListeZeichnen(); } })));
      }
    };
    dlListeZeichnen();
    const fgWahl = auswahl({ optionen: freigaben.map((f) => ({ wert: f.name, text: f.name })), wert: (freigaben[0] || {}).name });
    const ordWahl = auswahl({ optionen: [] });
    const gewaehlt = el('p', { klasse: 'erklaerung' });
    let rel = '';
    const wurzelVon = (name) => (freigaben.find((f) => f.name === name) || {}).pfad || '';
    async function ordnerLaden() {
      const fg = fgWahl.value;
      gewaehlt.textContent = t('system.proto_dlna_gewaehlt', { pfad: rel ? `${fg}/${rel}` : fg });
      leeren(ordWahl);
      ordWahl.appendChild(el('option', { wert: '', text: t('system.proto_dlna_dieser_ordner') }));
      if (rel) ordWahl.appendChild(el('option', { wert: '..', text: t('system.proto_dlna_hoeher') }));
      const wurzel = wurzelVon(fg);
      if (!wurzel) return;
      try {
        const r = await api(ctx, 'apps.ordner', { pfad: rel ? `${wurzel}/${rel}` : wurzel });
        for (const o of (r && r.ordner) || []) ordWahl.appendChild(el('option', { wert: o.name, text: `📁 ${o.name}` }));
      } catch (f) { ordWahl.appendChild(el('option', { wert: '', text: fehlerText(f), attr: { disabled: 'disabled' } })); }
      ordWahl.value = '';
    }
    fgWahl.addEventListener('change', () => { rel = ''; ordnerLaden(); });
    ordWahl.addEventListener('change', () => {
      const v = ordWahl.value;
      if (v === '..') rel = rel.split('/').slice(0, -1).join('/');
      else if (v) rel = rel ? `${rel}/${v}` : v;
      else return;
      ordnerLaden();
    });
    const dlHinzu = knopf(t('system.proto_dlna_hinzufuegen'), { art: 'zweit', klein: true, beiKlick: () => {
      const neu = { freigabe: fgWahl.value, pfad: rel };
      if (!neu.freigabe || dlOrdner.some((x) => x.freigabe === neu.freigabe && x.pfad === neu.pfad)) return;
      dlOrdner.push(neu); dlListeZeichnen();
    } });
    if (freigaben.length) ordnerLaden();
    const dlFelder = el('div', {}, el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.proto_dlna_name'), erklaerung: t('system.proto_dlna_name_erklaerung'), eingabe: dlName })),
      el('p', { klasse: 'erklaerung', text: t('system.proto_dlna_ordner_erklaerung') }), dlListe,
      el('div', { klasse: 'sy-zusatz-felder' }, feld({ label: t('system.proto_dlna_freigabe'), eingabe: fgWahl }), feld({ label: t('system.proto_dlna_unterordner'), erklaerung: t('system.proto_dlna_unterordner_erklaerung'), eingabe: ordWahl })),
      gewaehlt, el('div', { klasse: 'vw-knopfleiste' }, dlHinzu));
    const sicht = () => { wdFelder.hidden = !webdav.eingabe.checked; nfsFelder.hidden = !nfs.eingabe.checked; dlFelder.hidden = !dlna.eingabe.checked; };
    for (const s of [webdav, nfs, dlna]) s.eingabe.addEventListener('change', sicht);
    sicht();
    // Wer sieht was
    const ans = c.ansichten || {};
    const wer = el('details', {}, el('summary', { text: t('system.proto_wer_sieht') }),
      el('ul', { klasse: 'sy-meldungen', role: 'list' }, Object.entries(ans).map(([n, l]) => el('li', {}, el('strong', { text: n }), `: ${l.length ? l.map((x) => (x.nur_lesen ? `${x.freigabe} (${t('system.proto_nur_lesen')})` : x.freigabe)).join(', ') : t('system.proto_nichts')}`))),
      el('p', { klasse: 'erklaerung', text: t('system.proto_extern_hinweis') }));
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren();
      const daten = {
        smb: { aktiv: smb.eingabe.checked },
        sftp: { aktiv: sftp.eingabe.checked },
        webdav: { aktiv: webdav.eingabe.checked, port: Number(wdPort.value) },
        nfs: { aktiv: nfs.eingabe.checked, netz: nfsNetz.value.trim(), freigaben: nfsZeilen.filter((x) => x.an.checked).map((x) => ({ name: x.name, nur_lesen: x.ro.checked, als_nutzer: x.als.value })) },
        dlna: { aktiv: dlna.eingabe.checked, name: dlName.value.trim(), ordner: dlOrdner },
      };
      try { await aufgabeStarten(ctx, 'protokolle.speichern', daten, { titel: t('system.proto_titel'), meldung: t('system.proto_speichern_laeuft'), abbrechen: t('system.abbrechen'), schliessen: t('system.schliessen') }); melden(ctx, t('system.proto_gespeichert'), 'erfolg'); await zeichnen(); } catch (f) { if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
    } });
    leeren(inhalt);
    inhalt.append(...[fz.element,
      kopf('SMB', z.smb, !(c.smb && c.smb.aktiv === false)), smb.element, smbHinweis,
      kopf('SFTP', z.sftp, c.sftp && c.sftp.aktiv), sftp.element, !c.ssh_an ? hinweis(t('system.proto_sftp_ssh_aus'), 'info') : null,
      kopf('WebDAV', z.webdav, wd.aktiv), webdav.element, wdFelder,
      kopf('NFS', z.nfs, nf.aktiv), nfs.element, nfsFelder,
      kopf('DLNA', z.dlna, dl.aktiv), dlna.element, dlFelder,
      wer, el('div', { klasse: 'vw-knopfleiste' }, speichern)].filter(Boolean));
  }
  zeichnen();
  return element;
}

// ---- Wartung (12.10.2026): automatische Prüfungen und automatische Updates ------------------------------------------
const WOCHENTAGE = Object.freeze([[1, 'system.tag_mo'], [2, 'system.tag_di'], [3, 'system.tag_mi'], [4, 'system.tag_do'], [5, 'system.tag_fr'], [6, 'system.tag_sa'], [0, 'system.tag_so']]);
const zeitFeld = (wert) => eingabe({ typ: 'time', wert });

/** Karte „Automatische Prüfungen“: Selbsttests der Platten (wöchentlich kurz, monatlich gründlich), RAID-Datenprüfung. */
export function kartePruefungen(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.pruefungen_laden')));
  const element = karte(t('system.pruefungen_titel'), el('p', { klasse: 'erklaerung', text: t('system.pruefungen_erklaerung') }), inhalt);
  async function zeichnen() {
    let w;
    try { w = await api(ctx, 'wartung.lesen', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    if (!w || !w.pruefungen) { leeren(inhalt); inhalt.appendChild(hinweis(t('system.wartung_fehlt'), 'fehler')); return; }
    const pr = w.pruefungen;
    const fz = fehlerzeile();
    const aktiv = schalter({ label: t('system.pruefungen_aktiv'), erklaerung: t('system.pruefungen_aktiv_erklaerung'), wert: pr.aktiv });
    const tag = auswahl({ optionen: WOCHENTAGE.map(([d, k]) => ({ wert: String(d), text: t(k) })), wert: String(pr.tag) });
    const zeit = zeitFeld(pr.zeit);
    const lang = schalter({ label: t('system.pruefungen_lang'), erklaerung: t('system.pruefungen_lang_erklaerung'), wert: pr.smart_lang });
    const raid = schalter({ label: t('system.pruefungen_raid'), erklaerung: t('system.pruefungen_raid_erklaerung'), wert: pr.raid });
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren();
      try { await api(ctx, 'wartung.speichern', { pruefungen: { aktiv: aktiv.eingabe.checked, tag: Number(tag.value), zeit: zeit.value, smart_lang: lang.eingabe.checked, raid: raid.eingabe.checked } }); melden(ctx, t('system.gespeichert'), 'erfolg'); await zeichnen(); } catch (e) { fz.zeigen(fehlerText(e)); }
    } });
    const jetzt = (art, text) => knopf(t(text), { art: 'zweit', klein: true, beiKlick: async () => {
      fz.leeren();
      try { const r = await api(ctx, 'wartung.jetzt', { art }); melden(ctx, t('system.pruefungen_gestartet', { n: r.gestartet }), 'erfolg'); await zeichnen(); } catch (e) { fz.zeigen(fehlerText(e)); }
    } });
    const naechste = w.naechste_pruefung ? t(w.naechste_pruefung.art === 'smart_lang' ? 'system.pruefungen_naechste_lang' : 'system.pruefungen_naechste_kurz', { zeit: fmt.datumZeit ? fmt.datumZeit(w.naechste_pruefung.zeit) : new Date(w.naechste_pruefung.zeit).toLocaleString() }) : t('system.pruefungen_keine_naechste');
    const ergebnisse = Object.entries(w.smart || {});
    const tab = tabelle([{ text: t('system.pruefungen_platte') }, { text: t('system.pruefungen_art') }, { text: t('system.pruefungen_wann') }, { text: t('system.pruefungen_ergebnis') }]);
    for (const [geraet, s] of ergebnisse.sort()) {
      const zustand = !s.ende ? 'warnung' : s.bestanden === false ? 'fehler' : s.bestanden ? 'aktiv' : 'inaktiv';
      tabellenzeile(tab.koerper, [el('td', {}, el('span', { klasse: 'vw-mono', text: geraet }), s.modell ? el('div', { klasse: 'vw-gedaempft', text: s.modell }) : null),
        t(s.art === 'smart_lang' ? 'system.pruefungen_art_lang' : 'system.pruefungen_art_kurz'), new Date(s.ende || s.gestartet).toLocaleString(),
        el('td', {}, ampel(zustand), ` ${!s.ende ? t('system.pruefungen_laeuft', { rest: s.prozent_rest ?? '?' }) : s.text || '–'}`)]);
    }
    for (const [name, s] of Object.entries(w.raid || {})) {
      tabellenzeile(tab.koerper, [el('td', { klasse: 'vw-mono', text: `RAID ${name}` }), t('system.pruefungen_art_raid'), new Date(s.ende || s.gestartet).toLocaleString(),
        el('td', {}, ampel(!s.ende ? 'warnung' : s.fehler ? 'fehler' : 'aktiv'), ` ${!s.ende ? t('system.pruefungen_laeuft_raid') : s.text || '–'}`)]);
    }
    leeren(inhalt);
    inhalt.append(fz.element, aktiv.element,
      el('div', { klasse: 'vw-zeile' }, feld({ label: t('system.pruefungen_tag'), erklaerung: t('system.pruefungen_tag_erklaerung'), eingabe: tag }), feld({ label: t('system.pruefungen_zeit'), erklaerung: t('system.pruefungen_zeit_erklaerung'), eingabe: zeit })),
      lang.element, raid.element, el('div', { klasse: 'vw-knopfleiste' }, speichern),
      el('p', { klasse: 'erklaerung', text: naechste }),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.pruefungen_ergebnisse') }),
      ergebnisse.length || Object.keys(w.raid || {}).length ? tab.element : leerHinweis(t('system.pruefungen_noch_keine')),
      el('div', { klasse: 'vw-knopfleiste' }, jetzt('smart_kurz', 'system.pruefungen_jetzt_kurz'), jetzt('smart_lang', 'system.pruefungen_jetzt_lang'), jetzt('raid', 'system.pruefungen_jetzt_raid')));
  }
  zeichnen();
  return element;
}

/** Karte „Automatische Updates“ (unattended-upgrades): an/aus, Umfang, Uhrzeit, Neustart, letzter Lauf. */
export function karteAutoUpdates(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.auto_laden')));
  const element = karte(t('system.auto_titel'), el('p', { klasse: 'erklaerung', text: t('system.auto_erklaerung') }), inhalt);
  async function zeichnen() {
    let w;
    try { w = await api(ctx, 'wartung.lesen', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    if (!w || !w.auto_updates) { leeren(inhalt); inhalt.appendChild(hinweis(t('system.wartung_fehlt'), 'fehler')); return; }
    const u = w.auto_updates;
    const fz = fehlerzeile();
    const aktiv = schalter({ label: t('system.auto_aktiv'), erklaerung: t('system.auto_aktiv_erklaerung'), wert: u.aktiv });
    const umfang = auswahl({ optionen: [{ wert: 'sicherheit', text: t('system.auto_umfang_sicherheit') }, { wert: 'alle', text: t('system.auto_umfang_alle') }], wert: u.umfang });
    const zeit = zeitFeld(u.zeit);
    const neustart = schalter({ label: t('system.auto_neustart'), erklaerung: t('system.auto_neustart_erklaerung'), wert: u.neustart });
    const neustartZeit = zeitFeld(u.neustart_zeit);
    const speichern = knopf(t('system.speichern'), { beiKlick: async () => {
      fz.leeren(); speichern.disabled = true;
      try { await api(ctx, 'wartung.speichern', { auto_updates: { aktiv: aktiv.eingabe.checked, umfang: umfang.value, zeit: zeit.value, neustart: neustart.eingabe.checked, neustart_zeit: neustartZeit.value } }); melden(ctx, t('system.gespeichert'), 'erfolg'); await zeichnen(); } catch (e) { fz.zeigen(fehlerText(e)); speichern.disabled = false; }
    } });
    const l = w.updates && w.updates.letzter_lauf;
    leeren(inhalt);
    inhalt.append(fz.element, aktiv.element,
      el('div', { klasse: 'vw-zeile' }, feld({ label: t('system.auto_umfang'), erklaerung: t('system.auto_umfang_erklaerung'), eingabe: umfang }), feld({ label: t('system.auto_zeit'), erklaerung: t('system.auto_zeit_erklaerung'), eingabe: zeit })),
      neustart.element, feld({ label: t('system.auto_neustart_zeit'), erklaerung: t('system.auto_neustart_zeit_erklaerung'), eingabe: neustartZeit }),
      el('div', { klasse: 'vw-knopfleiste' }, speichern),
      el('p', { klasse: 'erklaerung', text: l ? t('system.auto_letzter', { zeit: l.zeit ? new Date(l.zeit).toLocaleString() : '?', text: l.text || '' }) : t('system.auto_noch_nie') }),
      w.updates && w.updates.neustart_noetig ? hinweis(t('system.auto_neustart_noetig'), 'warnung') : null);
  }
  zeichnen();
  return element;
}

// ---- Gehäuse (UGREEN DXP, 19.10.2026): LEDs und Lüfter -----------------------------------------------------------
const LUEFTER_MODI = Object.freeze(['bios', 'leise', 'normal', 'leistung']);

/** Temperaturen als kurze Zeile: „CPU 48 °C · Platten 34–37 °C · NVMe 45 °C“. */
export function temperaturText(t, temps) {
  if (!temps) return '';
  const r = (x) => Math.round(x);
  const spanne = (l) => (l.length ? (Math.min(...l) === Math.max(...l) ? `${r(l[0])} °C` : `${r(Math.min(...l))}–${r(Math.max(...l))} °C`) : null);
  return [Number.isFinite(temps.cpu) ? t('system.gehaeuse_temp_cpu', { wert: r(temps.cpu) }) : null,
    spanne(temps.platten || []) ? t('system.gehaeuse_temp_platten', { wert: spanne(temps.platten) }) : null,
    spanne(temps.nvme || []) ? t('system.gehaeuse_temp_nvme', { wert: spanne(temps.nvme) }) : null].filter(Boolean).join(' · ');
}

/** Karte „Gehäuse“: LEDs an/aus, Helligkeit, Blinken bei Zugriff; Lüftermodus mit Drehzahl und Temperaturen. */
export function karteGehaeuse(ctx, t) {
  const inhalt = el('div', {}, leerHinweis(t('system.gehaeuse_laden')));
  const element = karte(t('system.gehaeuse_titel'), el('p', { klasse: 'erklaerung', text: t('system.gehaeuse_erklaerung') }), inhalt);
  let takt = null;

  async function zeichnen() {
    let s;
    try { s = await api(ctx, 'hardware.status', {}); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
    leeren(inhalt);
    if (!s || !s.modell) { inhalt.appendChild(leerHinweis(t('system.gehaeuse_keines'))); return; }
    const fz = fehlerzeile();
    const l = s.leds || {}; const f = s.luefter || {}; const wd = s.watchdog || {};
    const schutz = schalter({ label: t('system.gehaeuse_watchdog_schutz'), erklaerung: t('system.gehaeuse_watchdog_schutz_erklaerung'), wert: !!wd.schutz });
    const an = schalter({ label: t('system.gehaeuse_leds_an'), erklaerung: t('system.gehaeuse_leds_an_erklaerung'), wert: l.an !== false });
    const regler = el('input', { typ: 'range', attr: { min: '2', max: '100', step: '1', 'aria-label': t('system.gehaeuse_helligkeit') } }); regler.value = String(l.helligkeit ?? 25);
    const stellung = el('p', { klasse: 'erklaerung' });
    const stellungZeigen = () => { stellung.textContent = t(Number(regler.value) <= 15 ? 'system.gehaeuse_helligkeit_dunkel' : Number(regler.value) <= 50 ? 'system.gehaeuse_helligkeit_mittel' : 'system.gehaeuse_helligkeit_hell', { prozent: regler.value }); };
    regler.addEventListener('input', stellungZeigen); stellungZeigen();
    const aktivitaet = schalter({ label: t('system.gehaeuse_aktivitaet'), erklaerung: t('system.gehaeuse_aktivitaet_erklaerung'), wert: l.aktivitaet !== false });
    const modus = auswahl({ optionen: LUEFTER_MODI.map((m) => ({ wert: m, text: t(`system.gehaeuse_modus_${m}`) })), wert: f.modus || 'normal' });
    const modusErkl = el('p', { klasse: 'erklaerung' });
    const modusZeigen = () => { modusErkl.textContent = t(`system.gehaeuse_modus_${modus.value}_erklaerung`); };
    modus.addEventListener('change', modusZeigen); modusZeigen();
    const zustand = el('ul', { klasse: 'sy-meldungen', role: 'list' },
      (f.kanaele || []).map((k) => el('li', {}, ampel(k.steht ? 'fehler' : 'aktiv'), ` ${t('system.gehaeuse_luefter_zeile', { nr: k.nr, rpm: k.rpm ?? '–', prozent: k.prozent ?? '–' })}${k.steht ? ` – ${t('system.gehaeuse_luefter_steht')}` : ''}`)));
    inhalt.append(
      el('p', { klasse: 'erklaerung' }, el('strong', { text: s.modell })),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.gehaeuse_leds') }),
      l.verfuegbar ? el('div', {}, an.element || an, feld({ label: t('system.gehaeuse_helligkeit'), eingabe: regler }), stellung, aktivitaet.element || aktivitaet)
        : hinweis(t('system.gehaeuse_leds_nicht', { grund: l.grund || '?' }), 'warnung'),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.gehaeuse_luefter') }),
      f.verfuegbar ? el('div', {}, feld({ label: t('system.gehaeuse_modus'), eingabe: modus }), modusErkl, zustand,
        el('p', { klasse: 'erklaerung', text: temperaturText(t, f.temperaturen) }))
        : hinweis(t('system.gehaeuse_luefter_nicht', { grund: f.grund || '?' }), 'warnung'),
      el('h3', { klasse: 'sy-zusatz-abschnitt', text: t('system.gehaeuse_watchdog') }),
      el('p', { klasse: 'erklaerung', text: wd.verfuegbar ? t('system.gehaeuse_watchdog_treiber', { zustand: t(wd.zustand === 'active' ? 'system.gehaeuse_watchdog_an' : 'system.gehaeuse_watchdog_aus'), sekunden: wd.sekunden ?? '?' }) : t('system.gehaeuse_watchdog_ohne') }),
      wd.start_unit === false ? hinweis(t('system.gehaeuse_watchdog_unit', { grund: wd.grund || '?' }), 'warnung') : null,
      wd.verfuegbar ? (schutz.element || schutz) : null,
      fz.element,
      (l.verfuegbar || f.verfuegbar || wd.verfuegbar) ? el('div', { klasse: 'vw-knopfleiste' }, knopf(t('system.speichern'), { beiKlick: async () => {
        fz.leeren();
        const wert = (sch) => { const i = (sch.element || sch).querySelector('input'); return i ? i.checked : true; };
        const p = {};
        if (l.verfuegbar) p.leds = { an: wert(an), helligkeit: Number(regler.value), aktivitaet: wert(aktivitaet) };
        if (f.verfuegbar) p.luefter = { modus: modus.value };
        if (wd.verfuegbar) p.watchdog = { schutz: !!(schutz.element || schutz).querySelector('input')?.checked };
        try { await api(ctx, 'hardware.einstellen', p); melden(ctx, t('system.gehaeuse_gespeichert'), 'erfolg'); await zeichnen(); } catch (e) { fz.zeigen(fehlerText(e)); }
      } })) : null);
    clearInterval(takt);
    takt = setInterval(async () => {
      if (!element.isConnected) { clearInterval(takt); return; }
      try {
        const n = await api(ctx, 'hardware.status', {});
        const ks = n?.luefter?.kanaele || [];
        zustand.textContent = '';
        for (const k of ks) zustand.appendChild(el('li', {}, ampel(k.steht ? 'fehler' : 'aktiv'), ` ${t('system.gehaeuse_luefter_zeile', { nr: k.nr, rpm: k.rpm ?? '–', prozent: k.prozent ?? '–' })}`));
      } catch { /* nächster Takt */ }
    }, 10_000);
  }
  zeichnen();
  return element;
}

/**
 * Verbindung zu FAH-Git (Betreiber 26.10.2026): Adresse + EIN Zugangsschlüssel für alle Projekte. FAH-NAS liest damit nur
 * (Projekte, Zweige, Archive) und baut unter Apps → „Aus FAH-Git bauen“ Docker-Apps daraus. Der Schlüssel verlässt den
 * Agenten nie; die Karte zeigt nur seinen Anfang.
 */
export function karteFahgit(ctx, t, fmt) {
  const inhalt = el('div', {}, leerHinweis(t('system.fahgit_laden')));
  const element = karte(t('system.fahgit_titel'), el('p', { klasse: 'erklaerung', text: t('system.fahgit_erklaerung') }), inhalt);

  function stand(v) {
    if (!v || !v.eingerichtet) return hinweis(t('system.fahgit_nicht_eingerichtet'), 'info');
    const g = v.geprueft;
    if (!g) return el('p', { klasse: 'erklaerung', text: t('system.fahgit_ungeprueft') });
    return el('p', { klasse: 'erklaerung' }, ampel(g.ok ? 'aktiv' : 'fehler'), ' ',
      el('span', { text: g.ok ? t('system.fahgit_ok', { nutzer: g.nutzer || '?', version: g.version || '?', zeit: fmt.zeit(g.zeit) }) : t('system.fahgit_fehl', { meldung: g.fehler || '?', zeit: fmt.zeit(g.zeit) }) }));
  }

  function zeichnen(v) {
    leeren(inhalt);
    const fz = fehlerzeile();
    const adresse = eingabe({ wert: (v && v.adresse) || '', maxlength: 260, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off', platzhalter: 'http://nas.local:3300' });
    const token = eingabe({ typ: 'password', wert: '', maxlength: 120, spellcheck: false, klasse: 'vw-mono', autocomplete: 'new-password',
      platzhalter: v && v.schluessel_anfang ? t('system.fahgit_token_bleibt', { anfang: v.schluessel_anfang }) : 'fgit_…' });
    const speichern = knopf(t('system.fahgit_speichern'), { beiKlick: async () => {
      fz.leeren();
      if (!adresse.value.trim()) { fz.zeigen(t('system.fahgit_adresse_fehlt')); adresse.focus(); return; }
      speichern.disabled = true;
      try {
        const r = await api(ctx, 'fahgit.verbindung.speichern', { adresse: adresse.value.trim(), token: token.value.trim() });
        melden(ctx, t('system.fahgit_gespeichert', { nutzer: (r.geprueft && r.geprueft.nutzer) || '?' }), 'erfolg');
        zeichnen(r);
      } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
    } });
    const pruefen = knopf(t('system.fahgit_pruefen'), { art: 'zweit', deaktiviert: !(v && v.eingerichtet), beiKlick: async () => {
      fz.leeren(); pruefen.disabled = true;
      try { const r = await api(ctx, 'fahgit.verbindung.pruefen', {}); zeichnen(r); melden(ctx, r.geprueft && r.geprueft.ok ? t('system.fahgit_pruefen_ok') : t('system.fahgit_pruefen_fehl'), r.geprueft && r.geprueft.ok ? 'erfolg' : 'fehler'); } catch (e) { fz.zeigen(fehlerText(e)); pruefen.disabled = false; }
    } });
    const entfernen = knopf(t('system.fahgit_entfernen'), { art: 'gefahr', deaktiviert: !(v && v.eingerichtet), beiKlick: async () => {
      fz.leeren();
      try { zeichnen(await api(ctx, 'fahgit.verbindung.loeschen', {})); melden(ctx, t('system.fahgit_entfernt'), 'erfolg'); } catch (e) { fz.zeigen(fehlerText(e)); }
    } });
    inhalt.append(stand(v), fz.element,
      feld({ label: t('system.fahgit_adresse'), erklaerung: t('system.fahgit_adresse_erklaerung'), eingabe: adresse }),
      feld({ label: t('system.fahgit_token'), erklaerung: t('system.fahgit_token_erklaerung'), eingabe: token }),
      el('div', { klasse: 'vw-knopfleiste' }, speichern, pruefen, entfernen),
      el('p', { klasse: 'erklaerung' }, el('span', { text: `${t('system.fahgit_weiter')} ` }), el('a', { href: '#/apps', text: t('system.fahgit_zu_apps') })));
  }

  api(ctx, 'fahgit.verbindung', {}).then(zeichnen).catch((e) => { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(e), 'fehler')); });
  return element;
}
