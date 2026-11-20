// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Anmeldung“ (Sonderansicht ohne Navigation): Name, Passwort, Angemeldet bleiben, zweiter Faktor (TOTP oder
// Wiederherstellungscode), Anmeldebremse mit Wartezeit. Nach Erfolg ctx.angemeldet() bzw. location.reload().
// Aus dem Internet vorher die Sicherheitsprüfung des Anmeldeschutzes (Rechenaufgabe im Web-Worker, Ländersperre).

import {
  el, leeren, stilLaden, eingabe, feld, schalter, knopf, fehlerzeile, post, fehlerText, normFehler, uebersetzer,
} from './verwaltung-hilfen.js';

let zuletztT = (k) => ({ 'anmeldung.titel': 'Anmeldung' }[k] || k);
let bremseTimer = null;

/** Hostname für den Kopf: vom Rahmen (ctx.hostname), sonst aus der Adresse im Browser */
function hostnameAnzeige(ctx) {
  if (ctx && typeof ctx.hostname === 'string' && ctx.hostname.trim()) return ctx.hostname.trim();
  try { return (location.hostname || '').replace(/\.local$/, '') || 'FAH-NAS'; } catch { return 'FAH-NAS'; }
}

/** Kopf mit Logo und Hostname – gemeinsam für Anmeldung und Ersteinrichtung */
export function kopfMitLogo(untertitel, ctx) {
  return el('div', { klasse: 'an-kopf' },
    el('div', { klasse: 'an-logo', attr: { 'aria-hidden': 'true' } }, el('span', { klasse: 'an-logo-wuerfel' }), el('span', { klasse: 'an-logo-text', text: 'FAH-NAS' })),
    el('h1', { klasse: 'an-hostname', text: hostnameAnzeige(ctx) }),
    untertitel ? el('p', { klasse: 'an-untertitel', text: untertitel }) : null);
}

/** Nach erfolgreicher Anmeldung: Rahmen-Rückruf oder Seite neu laden */
export function angemeldet(ctx) {
  if (typeof ctx.angemeldet === 'function') { ctx.angemeldet(); return; }
  location.reload();
}

/**
 * Anmeldeschutz (Zugriff aus dem Internet): Rechenaufgabe holen und im Web-Worker lösen. Heimnetz/VPN → {} (nichts zu tun).
 * Gesperrtes Land → Fehler mit der Meldung des Servers.
 */
async function sicherheitspruefung() {
  const r = await fetch('/api/anmelden/aufgabe', { cache: 'no-store', headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  const a = j && j.ok ? j.ergebnis : null;
  if (!a || !a.noetig) return {};
  if (a.land_gesperrt) { const e = new Error(a.meldung || 'Land gesperrt'); e.code = 'E_RECHTE'; e.meldung = a.meldung; throw e; }
  if (a.warte_s > 0) { const e = new Error('Bremse'); e.code = 'E_BREMSE'; e.details = { warte_s: a.warte_s }; throw e; }
  const loesung = await new Promise((ok, nein) => {
    const w = new Worker('/anmeldung-aufgabe.js', { type: 'module' });
    w.onmessage = (ev) => { w.terminate(); if (ev.data && ev.data.loesung) ok(ev.data.loesung); else nein(new Error(ev.data && ev.data.fehler)); };
    w.addEventListener('error', (ev) => { w.terminate(); nein(new Error(ev.message || 'Worker')); });
    w.postMessage({ aufgabe: a.aufgabe, bits: a.bits });
  });
  return { aufgabe: a.aufgabe, loesung };
}

/** Bremse-Anzeige mit Sekundenzähler; gibt eine Funktion zurück, die den Zähler stoppt */
function bremseAnzeigen(t, fz, knoepfe, sekunden) {
  let rest = Math.max(1, Math.ceil(Number(sekunden) || 1));
  // ab einer Minute als Uhrzeit-Dauer (Sperren aus dem Internet dauern 1 h bzw. 24 h)
  const setzen = () => {
    const text = rest < 60 ? t('anmeldung.bremse', { sekunden: rest })
      : t('anmeldung.bremse_lang', { dauer: `${Math.floor(rest / 3600)}:${String(Math.floor((rest % 3600) / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}` });
    fz.zeigen(text); for (const k of knoepfe) k.disabled = true;
  };
  setzen();
  if (bremseTimer) clearInterval(bremseTimer);
  bremseTimer = setInterval(() => {
    rest -= 1;
    if (rest <= 0) { clearInterval(bremseTimer); bremseTimer = null; fz.zeigen(t('anmeldung.bremse_vorbei')); for (const k of knoepfe) k.disabled = false; return; }
    setzen();
  }, 1000);
}

function fehlerAnzeigen(t, fz, knoepfe, e) {
  const f = normFehler(e);
  if (f.code === 'E_BREMSE') { bremseAnzeigen(t, fz, knoepfe, f.details && f.details.warte_s); return; }
  if (f.code === 'E_ANMELDUNG') { fz.zeigen(f.meldung || t('anmeldung.fehler_anmeldung')); return; }
  if (f.code === 'E_RECHTE') { fz.zeigen(f.details && f.details.gesperrt ? t('anmeldung.fehler_gesperrt') : (f.meldung || t('anmeldung.fehler_gesperrt'))); return; }
  if (f.code === 'E_TOTP') { fz.zeigen(f.meldung || t('anmeldung.totp_fehler')); return; }
  if (f.code === 'E_AGENT') { fz.zeigen(t('anmeldung.agent_weg')); return; }
  fz.zeigen(fehlerText(f));
}

export default {
  id: 'anmeldung',
  symbol: 'anmeldung',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('anmeldung.titel'); },

  async einbinden(wurzel, ctx) {
    stilLaden();
    const t = uebersetzer(ctx); zuletztT = t;
    leeren(wurzel);
    wurzel.classList.add('an-wurzel');

    const karte = el('div', { klasse: 'karte an-karte' });
    wurzel.appendChild(karte);

    // Schritt 1: Name + Passwort
    const schritt1 = el('form', { klasse: 'an-form', attr: { novalidate: 'novalidate', autocomplete: 'on' } });
    const name = eingabe({ id: 'an-name', autocomplete: 'username', autofokus: true, maxlength: 64, spellcheck: false });
    name.setAttribute('autocapitalize', 'none');
    const passwort = eingabe({ typ: 'password', id: 'an-passwort', autocomplete: 'current-password', maxlength: 256 });
    const bleiben = schalter({ id: 'an-bleiben', label: t('anmeldung.angemeldet_bleiben'), erklaerung: t('anmeldung.angemeldet_bleiben_erklaerung') });
    const fz = fehlerzeile();
    const anmeldenKnopf = knopf(t('anmeldung.anmelden'), { typ: 'submit', klasse: 'an-haupt' });
    schritt1.append(
      kopfMitLogo(t('anmeldung.untertitel'), ctx),
      feld({ label: t('anmeldung.name'), erklaerung: t('anmeldung.name_erklaerung'), eingabe: name }),
      feld({ label: t('anmeldung.passwort'), eingabe: passwort }),
      bleiben.element,
      fz.element,
      anmeldenKnopf,
    );

    // Schritt 2: zweiter Faktor
    const schritt2 = el('form', { klasse: 'an-form vw-versteckt', attr: { novalidate: 'novalidate' } });
    let wiederherstellung = false;
    const code = eingabe({ id: 'an-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, muster: '[0-9]{6}', spellcheck: false });
    const codeFeld = feld({ label: t('anmeldung.totp_code'), erklaerung: t('anmeldung.totp_erklaerung'), eingabe: code });
    const wcode = eingabe({ id: 'an-wcode', autocomplete: 'off', maxlength: 64, spellcheck: false, klasse: 'vw-mono' });
    const wcodeFeld = feld({ label: t('anmeldung.wiederherstellung_code'), erklaerung: t('anmeldung.wiederherstellung_erklaerung'), eingabe: wcode });
    wcodeFeld.classList.add('vw-versteckt');
    const fz2 = fehlerzeile();
    const totpTitel = el('h2', { klasse: 'an-schritt-titel', text: t('anmeldung.totp_titel') });
    const pruefenKnopf = knopf(t('anmeldung.totp_pruefen'), { typ: 'submit', klasse: 'an-haupt' });
    const umschalten = knopf(t('anmeldung.wiederherstellung_umschalten'), { art: 'zweit', klasse: 'an-link', beiKlick: () => {
      wiederherstellung = !wiederherstellung;
      codeFeld.classList.toggle('vw-versteckt', wiederherstellung);
      wcodeFeld.classList.toggle('vw-versteckt', !wiederherstellung);
      totpTitel.textContent = t(wiederherstellung ? 'anmeldung.wiederherstellung_titel' : 'anmeldung.totp_titel');
      umschalten.textContent = t(wiederherstellung ? 'anmeldung.wiederherstellung_zurueck' : 'anmeldung.wiederherstellung_umschalten');
      fz2.leeren();
      (wiederherstellung ? wcode : code).focus();
    } });
    const zurueck = knopf(t('anmeldung.zurueck'), { art: 'zweit', klasse: 'an-link', beiKlick: () => {
      schritt2.classList.add('vw-versteckt'); schritt1.classList.remove('vw-versteckt'); fz.leeren(); passwort.value = ''; passwort.focus();
    } });
    schritt2.append(kopfMitLogo(undefined, ctx), totpTitel, codeFeld, wcodeFeld, fz2.element, pruefenKnopf, el('div', { klasse: 'an-links' }, umschalten, zurueck));

    karte.append(schritt1, schritt2);

    // Absenden Schritt 1
    schritt1.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      fz.leeren();
      const n = name.value.trim(); const p = passwort.value;
      if (!n || !p) { fz.zeigen(t('anmeldung.fehler_leer')); (n ? passwort : name).focus(); return; }
      anmeldenKnopf.disabled = true; const alt = anmeldenKnopf.textContent; anmeldenKnopf.textContent = t('anmeldung.laeuft');
      try {
        // Aus dem Internet erst die Sicherheitsprüfung (Rechenaufgabe, Land); zu Hause/VPN kommt sofort {}
        anmeldenKnopf.textContent = t('anmeldung.pruefung');
        const pruefung = await sicherheitspruefung();
        anmeldenKnopf.textContent = t('anmeldung.laeuft');
        const r = await post(ctx, '/api/anmelden', { name: n, passwort: p, angemeldet_bleiben: bleiben.eingabe.checked, ...pruefung });
        if (r && r.totp_noetig) {
          schritt1.classList.add('vw-versteckt'); schritt2.classList.remove('vw-versteckt'); code.value = ''; wcode.value = ''; code.focus();
        } else {
          fz.element.classList.remove('vw-fehler'); fz.element.classList.add('vw-erfolg'); fz.zeigen(t('anmeldung.erfolg'));
          angemeldet(ctx);
        }
      } catch (e) {
        fehlerAnzeigen(t, fz, [anmeldenKnopf], e);
        if (normFehler(e).code !== 'E_BREMSE') { passwort.value = ''; passwort.focus(); }
      } finally {
        anmeldenKnopf.textContent = alt;
        if (!bremseTimer) anmeldenKnopf.disabled = false;
      }
    });

    // Absenden Schritt 2
    schritt2.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      fz2.leeren();
      let wert;
      if (wiederherstellung) {
        wert = wcode.value.trim();
        if (!wert) { fz2.zeigen(t('anmeldung.wiederherstellung_fehler_format')); wcode.focus(); return; }
      } else {
        wert = code.value.replace(/\s+/g, '');
        if (!/^\d{6}$/.test(wert)) { fz2.zeigen(t('anmeldung.totp_fehler_format')); code.focus(); return; }
      }
      pruefenKnopf.disabled = true;
      try {
        // Wiederherstellungscode geht denselben Weg; Agent/Web erkennen ihn am Format (10 Zeichen statt 6 Ziffern)
        await post(ctx, '/api/anmelden/totp', { code: wert });
        angemeldet(ctx);
      } catch (e) {
        fehlerAnzeigen(t, fz2, [pruefenKnopf], e);
        (wiederherstellung ? wcode : code).select();
      } finally { if (!bremseTimer) pruefenKnopf.disabled = false; }
    });

    // Fokus ins Namensfeld
    setTimeout(() => name.focus(), 0);
    wurzel.appendChild(el('p', { klasse: 'an-fuss vw-gedaempft', text: '© 2026 Fabian Hammer' }));
  },

  verlassen() { if (bremseTimer) { clearInterval(bremseTimer); bremseTimer = null; } },
};
