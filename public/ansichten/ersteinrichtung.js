// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Ersteinrichtung“ (Sonderansicht ohne Navigation): Startcode von der Konsole, erstes Admin-Konto mit
// Passwort-Stärkeanzeige. POST /api/ersteinrichtung, danach Anmeldung mit denselben Daten.

import {
  el, leeren, stilLaden, eingabe, feld, knopf, fehlerzeile, get, post, fehlerText, normFehler, staerkeanzeige, felderPruefen, uebersetzer,
} from './verwaltung-hilfen.js';
import { kopfMitLogo, angemeldet } from './anmeldung.js';

export const MUSTER_NUTZERNAME = /^(?=.{2,31}$)[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
export const MUSTER_STARTCODE = /^[A-Za-z0-9]{8}$/;

let zuletztT = (k) => ({ 'anmeldung.ersteinrichtung_titel': 'Ersteinrichtung' }[k] || k);

/**
 * Ersten Admin anlegen. Der Web-Dienst meldet dabei schon an und antwortet {angelegt:true, angemeldet:true} – dann gibt
 * es KEINE zweite Anmeldung (sonst zwei Sitzungen desselben Geräts). Nur ohne `angemeldet:true` folgt POST /api/anmelden.
 * Gibt {angemeldet, zweiteAnmeldung} zurück.
 */
export async function ersteinrichtungAbschliessen(ctx, daten) {
  const r = await post(ctx, '/api/ersteinrichtung', daten);
  if (r && r.angemeldet === true) return { angemeldet: true, zweiteAnmeldung: false, uebernommen: r.uebernommen === true };
  try {
    await post(ctx, '/api/anmelden', { name: daten.name, passwort: daten.passwort, angemeldet_bleiben: false });
    return { angemeldet: true, zweiteAnmeldung: true };
  } catch {
    return { angemeldet: false, zweiteAnmeldung: true };
  }
}

export default {
  id: 'ersteinrichtung',
  symbol: 'ersteinrichtung',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('anmeldung.ersteinrichtung_titel'); },

  async einbinden(wurzel, ctx) {
    stilLaden();
    stilLaden(new URL('./anmeldung.css', import.meta.url).href); // Anmeldung und Ersteinrichtung teilen sich den Stil
    const t = uebersetzer(ctx); zuletztT = t;
    leeren(wurzel);
    wurzel.classList.add('an-wurzel');
    const karte = el('div', { klasse: 'karte an-karte an-breit' });
    wurzel.appendChild(karte);

    const form = el('form', { klasse: 'an-form', attr: { novalidate: 'novalidate', autocomplete: 'off' } });
    const startcode = eingabe({ id: 'ee-startcode', autocomplete: 'one-time-code', maxlength: 8, spellcheck: false, klasse: 'vw-mono', autofokus: true });
    startcode.setAttribute('autocapitalize', 'characters');
    startcode.addEventListener('input', () => { startcode.value = startcode.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const name = eingabe({ id: 'ee-name', autocomplete: 'username', maxlength: 31, spellcheck: false });
    name.setAttribute('autocapitalize', 'none');
    const anzeigename = eingabe({ id: 'ee-anzeigename', autocomplete: 'name', maxlength: 100 });
    const passwort = eingabe({ typ: 'password', id: 'ee-passwort', autocomplete: 'new-password', maxlength: 256 });
    const wiederholung = eingabe({ typ: 'password', id: 'ee-wiederholung', autocomplete: 'new-password', maxlength: 256 });
    const staerke = staerkeanzeige({ label: t('anmeldung.staerke'), schwach: t('anmeldung.staerke_schwach'), mittel: t('anmeldung.staerke_mittel'), stark: t('anmeldung.staerke_stark') });
    passwort.addEventListener('input', () => staerke.aktualisieren(passwort.value));
    const fz = fehlerzeile();
    const senden = knopf(t('anmeldung.einrichten'), { typ: 'submit', klasse: 'an-haupt' });

    form.append(
      kopfMitLogo(t('anmeldung.ersteinrichtung_untertitel'), ctx),
      el('p', { klasse: 'an-erklaerung', text: t('anmeldung.ersteinrichtung_erklaerung') }),
      feld({ label: t('anmeldung.startcode'), erklaerung: t('anmeldung.startcode_erklaerung'), eingabe: startcode }),
      feld({ label: t('anmeldung.admin_name'), erklaerung: t('anmeldung.admin_name_erklaerung'), eingabe: name }),
      feld({ label: t('anmeldung.anzeigename'), erklaerung: t('anmeldung.anzeigename_erklaerung'), eingabe: anzeigename }),
      feld({ label: t('anmeldung.passwort_neu'), erklaerung: t('anmeldung.passwort_erklaerung'), eingabe: passwort, hinweisElement: staerke.element }),
      feld({ label: t('anmeldung.passwort_wiederholung'), eingabe: wiederholung }),
      fz.element,
      senden,
    );
    karte.appendChild(form);

    // Ist die Ersteinrichtung überhaupt noch nötig?
    try {
      const status = typeof ctx.get === 'function' ? await get(ctx, '/api/ersteinrichtung') : null;
      if (status && status.noetig === false) {
        fz.element.classList.remove('vw-fehler'); fz.element.classList.add('vw-warnung');
        fz.zeigen(t('anmeldung.schon_eingerichtet'));
        senden.disabled = true;
        const weiter = knopf(t('anmeldung.zurueck'), { art: 'zweit', klasse: 'an-link', beiKlick: () => angemeldet(ctx) });
        form.appendChild(el('div', { klasse: 'an-links' }, weiter));
      }
    } catch { /* Status nicht lesbar – Formular trotzdem anbieten */ }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ok = felderPruefen([
        { eingabe: startcode, pruefen: (w) => (MUSTER_STARTCODE.test(w.trim()) ? null : t('anmeldung.startcode_fehler')) },
        { eingabe: name, pruefen: (w) => (MUSTER_NUTZERNAME.test(w.trim()) ? null : t('anmeldung.admin_name_fehler')) },
        { eingabe: passwort, pruefen: (w) => (w.length >= 8 ? null : t('anmeldung.passwort_kurz')) },
        { eingabe: wiederholung, pruefen: (w) => (w === passwort.value ? null : t('anmeldung.passwort_wiederholung_fehler')) },
      ], fz);
      if (!ok) return;
      senden.disabled = true; const alt = senden.textContent; senden.textContent = t('anmeldung.einrichten_laeuft');
      const daten = { startcode: startcode.value.trim().toUpperCase(), name: name.value.trim(), passwort: passwort.value, anzeigename: anzeigename.value.trim() || name.value.trim() };
      try {
        const erg = await ersteinrichtungAbschliessen(ctx, daten);
        fz.element.classList.remove('vw-fehler'); fz.element.classList.add('vw-erfolg');
        fz.zeigen(t('anmeldung.einrichten_erfolg'));
        // Anmeldung klappt nicht automatisch (z. B. Bremse) → zur Anmeldung wechseln
        if (!erg.angemeldet) fz.zeigen(t('anmeldung.einrichten_dann_anmelden'));
        // Installer-Konto übernommen: Konsole/SSH/sudo laufen ab jetzt mit dem NAS-Passwort – das muss der Nutzer wissen
        if (erg.uebernommen) ctx.melden(t('anmeldung.einrichten_uebernommen', { name: daten.name }), 'info');
        angemeldet(ctx);
      } catch (e) {
        const f = normFehler(e);
        if (f.code === 'E_BREMSE') fz.zeigen(t('anmeldung.bremse', { sekunden: Math.ceil(Number(f.details && f.details.warte_s) || 1) }));
        else if (f.code === 'E_ANMELDUNG' || f.code === 'E_RECHTE' || (f.details && f.details.feld === 'startcode')) {
          const rest = f.details && f.details.verbleibend;
          fz.zeigen(rest !== undefined ? `${t('anmeldung.startcode_falsch')} ${t('anmeldung.startcode_verbleibend', { anzahl: rest })}` : t('anmeldung.startcode_falsch'));
          startcode.focus(); startcode.select();
        } else if (f.code === 'E_EXISTIERT') fz.zeigen(t('anmeldung.schon_eingerichtet'));
        else fz.zeigen(fehlerText(f));
        senden.disabled = false; senden.textContent = alt;
      }
    });

    setTimeout(() => startcode.focus(), 0);
  },

  verlassen() {},
};
