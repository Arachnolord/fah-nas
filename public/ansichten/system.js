// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „System“ (admin): Allgemein (Hostname, Zeitzone, Sprache, Design), Netzwerk (DHCP/statisch mit Vorher-
// Nachher-Prüfung), Standort und Verbindungen (Weltkarte: Standort, Aufzeichnung, Ortsdaten, vertraute Proxys),
// Dienste (Ampel, An/Aus/Neustart, SSH = Notausgang), FAH-NAS aktualisieren (Release hochladen, prüfen, einspielen),
// Ubuntu-Updates (Prüfen/Einspielen als Aufgabe),
// Energie, S.M.A.R.T., Protokoll mit Filtern und Seiten, Export/Import über Tickets, Neustart/Herunterfahren, Über.

import {
  el, leeren, stilLaden, eingabe, textbereich, feld, schalter, auswahl, radiogruppe, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel, tabelle, tabellenzeile,
  laufzeitTeile, isoAus, dialogOeffnen, alleDialogeSchliessen, aufgabeStarten, api, fehlerText, melden, bestaetigen, abo,
  herunterladenUrl, csrfWert, kopfzeile, karte, uebersetzer, formatierer, felderPruefen, get,
} from './verwaltung-hilfen.js';
import { karteAnspringen } from './verwaltung-hilfen.js';
import { karteBenachrichtigungen, karteVpn, karteGpu, karteEnergieZusatz, karteProtokolle, kartePruefungen, karteAutoUpdates, karteGehaeuse, karteFahgit } from './system-zusatz.js';

export const MUSTER_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}';
export const MUSTER_IPV4 = new RegExp(`^${IPV4}$`);
export const MUSTER_CIDR = new RegExp(`^${IPV4}/(\\d|[12]\\d|3[0-2])$`);
/** Linux-Grenze IFNAMSIZ: Schnittstellennamen haben höchstens 15 Zeichen (Agent: schema max 15) */
export const MUSTER_SCHNITTSTELLE = /^[A-Za-z0-9_.:-]{1,15}$/;
/** Agent (system.setzen): höchstens 3 DNS-Server, Platten-Ruhe höchstens 330 Minuten (hdparm -S kennt maximal 5,5 h) */
export const MAX_DNS = 3;
export const MAX_PLATTEN_RUHE = 330;
/** Export erzeugt fahnas-export-<host>-<datum>.tar bzw. .tar.fahnas (verschlüsselt) – beides im Dateidialog anbieten */
export const IMPORT_ACCEPT = '.tar,.fahnas,.tar.fahnas,application/x-tar,application/octet-stream';
/** FAH-NAS-Release (tools/build_release.sh): fahnas_release.tar.gz */
export const PROGRAMM_ACCEPT = '.tar.gz,.tgz,application/gzip,application/x-gzip';
/** Programm-Update verfolgen: alle 2 s fragen, nach 5 Minuten aufgeben (das Update selbst braucht etwa eine Minute) */
export const PROGRAMM_ABFRAGE_MS = 2000;
export const PROGRAMM_MAX_MS = 5 * 60 * 1000;
export const DIENSTE = Object.freeze(['samba', 'docker', 'libvirt', 'avahi', 'ssh']);
export const PROTOKOLL_JE_SEITE = 50;

/**
 * Netz-Parameter für system.setzen: bei DHCP nur modus, schnittstelle und dns – Adresse/Gateway leert der Agent selbst.
 * Leere Felder gehen als '' (nicht null): null würde die Schemaprüfung verwerfen und die alten Werte stünden weiter im Bestand.
 */
export function netzParams({ modus, schnittstelle, adresse, gateway, dns }) {
  const s = (w) => (w === undefined || w === null ? '' : String(w).trim());
  const statisch = modus === 'statisch';
  const neu = { modus: statisch ? 'statisch' : 'dhcp', schnittstelle: s(schnittstelle), dns: Array.isArray(dns) ? dns.map(s).filter(Boolean) : [] };
  if (statisch) { neu.adresse = s(adresse); neu.gateway = s(gateway); }
  return neu;
}

/** Zustand nach system.dienst: der Agent liefert aktiv|inaktiv|fehler; alte Form an|aus|neustart wird zugeordnet, sonst aus dem Wunsch abgeleitet. */
export function dienstZustand(antwort, gewuenscht) {
  const zuordnung = { aktiv: 'aktiv', inaktiv: 'inaktiv', fehler: 'fehler', an: 'aktiv', aus: 'inaktiv', neustart: 'aktiv' };
  const roh = antwort && antwort.zustand !== undefined && antwort.zustand !== null ? String(antwort.zustand) : '';
  return zuordnung[roh] || (gewuenscht === 'aus' ? 'inaktiv' : 'aktiv');
}

/** Ergebnis von system.updates.einspielen: `eingespielt` ist eine Paketliste, `anzahl` die Zahl; Rückfall = Zahl der Prüfung. */
export function eingespieltAuswerten(r, rueckfall = 0) {
  const liste = r && Array.isArray(r.eingespielt) ? r.eingespielt.map((p) => (p && typeof p === 'object' ? String(p.name || '') : String(p))).filter(Boolean) : [];
  let anzahl;
  if (r && Array.isArray(r.eingespielt)) anzahl = liste.length;
  else if (r && Number.isFinite(Number(r.anzahl))) anzahl = Number(r.anzahl);
  else if (r && typeof r.eingespielt === 'number' && Number.isFinite(r.eingespielt)) anzahl = r.eingespielt;
  else anzahl = Number(rueckfall) || 0;
  return { anzahl, pakete: liste };
}

/** Alle bekannten Zeitzonen (Intl), Europe/Berlin immer enthalten, sortiert. */
export function zeitzonenListe(zusaetzlich = []) {
  let liste = [];
  try { if (typeof Intl.supportedValuesOf === 'function') liste = Intl.supportedValuesOf('timeZone'); } catch { liste = []; }
  const menge = new Set([...liste, 'Europe/Berlin', 'UTC', ...zusaetzlich.filter(Boolean)]);
  return [...menge].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Agent (system.setzen): vertraute_proxys höchstens 50 Einträge zu je höchstens 43 Zeichen (längstes IPv6-Netz) */
export const MAX_PROXYS = 50;
/** Standortname (system.json.standort.name) höchstens 64 Zeichen */
export const MAX_ORTSNAME = 64;
const DEZIMAL = /^[+-]?\d{1,3}(?:\.\d+)?$/;
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

/** Koordinate aus einem Eingabefeld: Komma oder Punkt, typografisches Minus erlaubt, kein Exponent/Hex. '' → null, ungültig → NaN */
function koordinate(roh) {
  const w = String(roh ?? '').trim().replace(/−/g, '-').replace(',', '.');
  if (w === '') return null;
  return DEZIMAL.test(w) ? Number(w) : NaN;
}

/**
 * Standort für system.setzen: `{standort:{lat, lon, name}}` – beide Koordinaten Zahl oder beide null (= kein Standort) –
 * oder `{fehler:'breite'|'laenge'|'paar'|'name'}` für das erste falsche Feld.
 */
export function standortAus(breite, laenge, name) {
  const lat = koordinate(breite); const lon = koordinate(laenge);
  if (Number.isNaN(lat) || (lat !== null && (lat < -90 || lat > 90))) return { fehler: 'breite' };
  if (Number.isNaN(lon) || (lon !== null && (lon < -180 || lon > 180))) return { fehler: 'laenge' };
  if ((lat === null) !== (lon === null)) return { fehler: 'paar' };
  const n = String(name ?? '').trim();
  if (n.length > MAX_ORTSNAME || STEUERZEICHEN.test(n)) return { fehler: 'name' };
  return { standort: { lat, lon, name: n } };
}

/** IPv6 in Textform (verkürzt, mit eingebetteter IPv4 am Ende); ohne Zonen-ID – die hat bei einem Proxy nichts verloren. */
function istIpv6(w) {
  if (!/^[0-9a-fA-F:.]+$/.test(w) || !w.includes(':')) return false;
  const haelften = w.split('::');
  if (haelften.length > 2) return false;
  const gruppen = (s) => (s === '' ? [] : s.split(':'));
  const links = gruppen(haelften[0]); const rechts = haelften.length === 2 ? gruppen(haelften[1]) : [];
  const letzte = haelften.length === 2 ? rechts : links; // eine IPv4 darf nur ganz am Ende stehen
  let breite = 0;
  for (const [teil, istLetzteSeite] of [[links, letzte === links], [rechts, letzte === rechts]]) {
    for (let i = 0; i < teil.length; i++) {
      const g = teil[i];
      if (g.includes('.')) { if (!istLetzteSeite || i !== teil.length - 1 || !MUSTER_IPV4.test(g)) return false; breite += 2; }
      else if (/^[0-9a-fA-F]{1,4}$/.test(g)) breite += 1;
      else return false;
    }
  }
  return haelften.length === 2 ? breite <= 7 : breite === 8;
}

/**
 * Vertraute Proxys aus dem Textfeld (eine Adresse oder ein Netz je Zeile; Komma, Semikolon, Leerzeichen trennen auch):
 * `{liste}` ohne Doppelte oder `{fehler:'eintrag', wert}` bzw. `{fehler:'zuviele'}`. Der Agent prüft noch einmal.
 */
export function proxysAus(text) {
  const liste = [...new Set(String(text ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
  for (const w of liste) {
    const [ip, praefix, rest] = w.split('/');
    const v4 = MUSTER_IPV4.test(ip); const v6 = !v4 && istIpv6(ip);
    const praefixOk = praefix === undefined || (/^\d{1,3}$/.test(praefix) && Number(praefix) <= (v4 ? 32 : 128));
    if (w.length > 43 || rest !== undefined || !(v4 || v6) || !praefixOk) return { fehler: 'eintrag', wert: w };
  }
  if (liste.length > MAX_PROXYS) return { fehler: 'zuviele' };
  return { liste };
}

/** Zeilen für die Vorher-Nachher-Anzeige des Netzes */
export function netzVergleich(alt, neu, leerText = '') {
  const z = (w) => (Array.isArray(w) ? (w.length ? w.join(', ') : leerText) : (w === null || w === undefined || w === '' ? leerText : String(w)));
  return ['modus', 'schnittstelle', 'adresse', 'gateway', 'dns'].map((k) => ({ feld: k, alt: z(alt && alt[k]), neu: z(neu && neu[k]), geaendert: z(alt && alt[k]) !== z(neu && neu[k]) }));
}

let zuletztT = (k) => ({ 'system.titel': 'System' }[k] || k);
let abmelder = [];
let neustartTimer = null;
let programmTimer = null;

export { karteAnspringen };

/**
 * Reiter der System-Seite (Betreiber 12.10.2026: „System-Seite gliedern … vier Reiter mit kurzer Unternavigation“).
 * Sprungziel #/system/<reiter> oder #/system/<karte> – eine Karte öffnet ihren Reiter.
 */
export const SYSTEM_REITER = Object.freeze([
  { id: 'grundlagen', titel: 'system.reiter_grundlagen', karten: ['allgemein', 'netzwerk', 'standort', 'dienste', 'docker', 'fahgit'] },
  { id: 'zugriff', titel: 'system.reiter_zugriff', karten: ['anmeldeschutz', 'vpn', 'protokolle', 'benachrichtigungen'] },
  { id: 'hardware', titel: 'system.reiter_hardware', karten: ['gehaeuse', 'grafikkarte', 'platten', 'energie', 'smart', 'pruefungen', 'strom'] },
  { id: 'wartung', titel: 'system.reiter_wartung', karten: ['programm', 'updates', 'autoupdates', 'export', 'protokoll', 'ueber'] },
]);
/** Reiter zu einem Sprungziel (Reiter- oder Karten-ID); unbekannt → erster Reiter. */
export function reiterVon(ziel) {
  const r = SYSTEM_REITER.find((x) => x.id === ziel || x.karten.includes(ziel));
  return (r || SYSTEM_REITER[0]).id;
}

/** Reiterleiste + Unternavigation (Karten des Reiters als Sprungknöpfe) über den Karten. */
function reiterAufbauen(wurzel, ctx, t) {
  const leiste = el('div', { klasse: 'sy-reiter', attr: { role: 'tablist', 'aria-label': t('system.titel') } });
  const unter = el('nav', { klasse: 'sy-unternav', attr: { 'aria-label': t('system.unternav') } });
  const knoepfe = SYSTEM_REITER.map((r) => {
    const k = el('button', { klasse: 'sy-reiter-knopf', typ: 'button', attr: { role: 'tab', 'aria-selected': 'false', 'data-reiter': r.id }, text: t(r.titel) });
    k.addEventListener('click', () => { location.hash = ctx.hashFuer ? ctx.hashFuer('system', r.id) : `#/system/${r.id}`; });
    return k;
  });
  leiste.append(...knoepfe);
  function zeigen(ziel) {
    const id = reiterVon(ziel);
    const reiter = SYSTEM_REITER.find((x) => x.id === id);
    for (const k of knoepfe) k.setAttribute('aria-selected', k.dataset.reiter === id ? 'true' : 'false');
    leeren(unter);
    for (const kid of reiter.karten) {
      const karteEl = wurzel.querySelector(`[data-karte="${kid}"]`);
      if (!karteEl) continue;
      const titel = (karteEl.querySelector('h2, .vw-karte-titel') || {}).textContent || kid;
      const chip = el('button', { klasse: 'sy-unternav-knopf', typ: 'button', text: titel });
      chip.addEventListener('click', () => { location.hash = ctx.hashFuer ? ctx.hashFuer('system', kid) : `#/system/${kid}`; });
      unter.appendChild(chip);
    }
    for (const k of wurzel.querySelectorAll('[data-karte]')) k.hidden = !reiter.karten.includes(k.dataset.karte);
    return id;
  }
  return { leiste, unter, zeigen };
}

/** Sprungziel anwenden: Reiter zeigen; bei einer Karte dorthin scrollen, bei einem Reiter nach oben. */
function reiterUndKarte(wurzel, route) {
  const ziel = route && Array.isArray(route.teile) ? route.teile[0] : null;
  if (!wurzel || !wurzel.syReiter) return;
  wurzel.syReiter.zeigen(ziel);
  if (ziel && !SYSTEM_REITER.some((r) => r.id === ziel)) karteAnspringen(wurzel, route);
  else { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* alt */ } }
}

export default {
  id: 'system',
  symbol: 'system',
  rolle: 'admin',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('system.titel'); },

  async einbinden(wurzel, ctx) {
    stilLaden();
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    leeren(wurzel);
    wurzel.classList.add('sy-wurzel');
    wurzel.appendChild(kopfzeile(t('system.titel'), t('system.untertitel')));
    const lade = leerHinweis(t('system.laden'));
    wurzel.appendChild(lade);

    let status = {};
    let konfig = {};
    try {
      const [s, k] = await Promise.all([api(ctx, 'system.status', {}), api(ctx, 'system.lesen', {})]);
      status = s || {}; konfig = k || {};
    } catch (e) {
      lade.replaceWith(hinweis(`${t('system.lade_fehl')} ${fehlerText(e)}`, 'fehler'));
      return;
    }
    lade.remove();

    const dienstText = { samba: t('system.dienst_samba'), docker: t('system.dienst_docker'), libvirt: t('system.dienst_libvirt'), avahi: t('system.dienst_avahi'), ssh: t('system.dienst_ssh') };
    const dienstErklaerung = { samba: t('system.dienst_samba_erklaerung'), docker: t('system.dienst_docker_erklaerung'), libvirt: t('system.dienst_libvirt_erklaerung'), avahi: t('system.dienst_avahi_erklaerung'), ssh: t('system.dienst_ssh_erklaerung') };
    const zustandText = { aktiv: t('system.zustand_aktiv'), inaktiv: t('system.zustand_inaktiv'), fehler: t('system.zustand_fehler') };

    async function setzen(aenderungen, meldung) {
      const r = await api(ctx, 'system.setzen', { aenderungen });
      if (r && typeof r === 'object') konfig = { ...konfig, ...Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))) };
      else konfig = { ...konfig, ...aenderungen };
      melden(ctx, meldung || t('system.gespeichert'), 'erfolg');
    }

    // ---- Allgemein --------------------------------------------------------------------------------------------
    function karteAllgemein() {
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal' });
      const fz = fehlerzeile();
      const hostname = eingabe({ wert: konfig.hostname || status.hostname || '', maxlength: 63, spellcheck: false, klasse: 'vw-mono' });
      const zeitzone = auswahl({ optionen: zeitzonenListe([konfig.zeitzone]).map((z) => ({ wert: z, text: z })), wert: konfig.zeitzone || 'Europe/Berlin' });
      const sprache = auswahl({ optionen: [{ wert: 'de', text: t('system.sprache_de') }, { wert: 'en', text: t('system.sprache_en') }], wert: konfig.sprache || 'de' });
      const design = auswahl({ optionen: [{ wert: 'auto', text: t('system.design_auto') }, { wert: 'hell', text: t('system.design_hell') }, { wert: 'dunkel', text: t('system.design_dunkel') }], wert: konfig.design || 'auto' });
      const speichern = knopf(t('system.speichern'), { typ: 'submit' });
      form.append(fz.element,
        feld({ label: t('system.hostname'), erklaerung: t('system.hostname_erklaerung'), eingabe: hostname }),
        feld({ label: t('system.zeitzone'), erklaerung: t('system.zeitzone_erklaerung'), eingabe: zeitzone }),
        feld({ label: t('system.sprache'), erklaerung: t('system.sprache_erklaerung'), eingabe: sprache }),
        feld({ label: t('system.design'), erklaerung: t('system.design_erklaerung'), eingabe: design }),
        speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([{ eingabe: hostname, pruefen: (w) => (MUSTER_HOSTNAME.test(w.trim()) ? null : t('system.hostname_fehler')) }], fz)) return;
        speichern.disabled = true;
        try { const vorher = konfig.sprache || 'de'; await setzen({ hostname: hostname.value.trim(), zeitzone: zeitzone.value, sprache: sprache.value, design: design.value }); if (typeof ctx.designSetzen === 'function') ctx.designSetzen(design.value); if (sprache.value !== vorher && typeof ctx.systemSpracheGeaendert === 'function') ctx.systemSpracheGeaendert(); } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
      });
      return karte(t('system.allgemein_titel'), form);
    }

    // ---- Netzwerk ---------------------------------------------------------------------------------------------
    function karteNetz() {
      const netz = { modus: 'dhcp', schnittstelle: null, adresse: null, gateway: null, dns: [], ...(konfig.netz || {}) };
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal' });
      const fz = fehlerzeile();
      const schnittstelle = eingabe({ wert: netz.schnittstelle || '', maxlength: 15, spellcheck: false, klasse: 'vw-mono' });
      let schnittstelleElement = schnittstelle;
      let schnittstelleWert = () => schnittstelle.value.trim();
      // Teil C liefert system.schnittstellen → Auswahlliste statt Freitext (Rückfall bleibt das Textfeld)
      api(ctx, 'system.schnittstellen', {}).then((liste) => {
        if (!Array.isArray(liste) || !liste.length || !schnittstelle.isConnected) return;
        const zustandText = { oben: t('system.netz_oben'), unten: t('system.netz_unten') };
        const optionen = [{ wert: '', text: t('system.netz_schnittstelle_auto') }, ...liste.map((x) => ({ wert: x.name, text: [x.name, x.mac, zustandText[x.zustand]].filter(Boolean).join(' · ') }))];
        if (netz.schnittstelle && !liste.some((x) => x.name === netz.schnittstelle)) optionen.push({ wert: netz.schnittstelle, text: netz.schnittstelle });
        const sel = auswahl({ optionen, wert: netz.schnittstelle || '', klasse: 'vw-mono' });
        sel.id = schnittstelle.id;
        schnittstelle.replaceWith(sel);
        schnittstelleElement = sel;
        schnittstelleWert = () => sel.value;
      }).catch(() => { /* Aktion fehlt – Textfeld bleibt */ });
      const statischBlock = el('div', { klasse: netz.modus === 'statisch' ? '' : 'vw-versteckt' });
      const modus = radiogruppe({ wert: netz.modus === 'statisch' ? 'statisch' : 'dhcp', optionen: [{ wert: 'dhcp', text: t('system.netz_dhcp') }, { wert: 'statisch', text: t('system.netz_statisch') }],
        beiWechsel: (w) => statischBlock.classList.toggle('vw-versteckt', w !== 'statisch') });
      const adresse = eingabe({ wert: netz.adresse || '', maxlength: 18, spellcheck: false, klasse: 'vw-mono', platzhalter: '192.168.1.50/24', inputmode: 'decimal' });
      const gateway = eingabe({ wert: netz.gateway || '', maxlength: 15, spellcheck: false, klasse: 'vw-mono', platzhalter: '192.168.1.1', inputmode: 'decimal' });
      // textbereich() trägt .eingabe (Rahmen) – nicht die Wrapper-Klasse .feld, die den Abstand zum Erklärtext verdoppelt hätte
      const dns = textbereich({ zeilen: 3, klasse: 'vw-mono', wert: (netz.dns || []).join('\n') });
      dns.setAttribute('spellcheck', 'false');
      statischBlock.append(
        feld({ label: t('system.netz_adresse'), erklaerung: t('system.netz_adresse_erklaerung'), eingabe: adresse }),
        feld({ label: t('system.netz_gateway'), erklaerung: t('system.netz_gateway_erklaerung'), eingabe: gateway }),
        feld({ label: t('system.netz_dns'), erklaerung: t('system.netz_dns_erklaerung'), eingabe: dns }));
      const speichern = knopf(t('system.speichern'), { typ: 'submit' });
      form.append(hinweis(t('system.netz_warnung'), 'warnung'), fz.element,
        feld({ label: t('system.netz_schnittstelle'), erklaerung: t('system.netz_schnittstelle_erklaerung'), eingabe: schnittstelle }),
        el('div', { klasse: 'vw-feld' }, el('span', { klasse: 'vw-label', text: t('system.netz_modus') }), modus.element, el('p', { klasse: 'erklaerung', text: t('system.netz_modus_erklaerung') })),
        statischBlock, speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const statisch = modus.wert() === 'statisch';
        const dnsListe = dns.value.split(/[\n,;\s]+/).map((x) => x.trim()).filter(Boolean);
        const dnsRegel = { eingabe: dns, pruefen: () => {
          if (dnsListe.length > MAX_DNS) return t('system.netz_dns_zuviele', { max: MAX_DNS });
          const falsch = dnsListe.find((d) => !MUSTER_IPV4.test(d)); return falsch ? t('system.netz_dns_fehler', { wert: falsch }) : null;
        } };
        const schnittstelleRegel = { eingabe: schnittstelleElement, pruefen: () => { const w = schnittstelleWert(); return w === '' || MUSTER_SCHNITTSTELLE.test(w) ? null : t('system.netz_schnittstelle_fehler'); } };
        const regeln = statisch ? [
          schnittstelleRegel,
          { eingabe: adresse, pruefen: (w) => (MUSTER_CIDR.test(w.trim()) ? null : t('system.netz_adresse_fehler')) },
          { eingabe: gateway, pruefen: (w) => (w.trim() === '' || MUSTER_IPV4.test(w.trim()) ? null : t('system.netz_gateway_fehler')) },
          dnsRegel,
        ] : [schnittstelleRegel, dnsRegel];
        if (!felderPruefen(regeln, fz)) return;
        const neu = netzParams({ modus: statisch ? 'statisch' : 'dhcp', schnittstelle: schnittstelleWert(), adresse: adresse.value, gateway: gateway.value, dns: dnsListe });
        // Vorher-Nachher
        const zeilen = netzVergleich(konfig.netz || {}, neu, t('system.netz_leer'));
        const tab = tabelle([{ text: '' }, { text: t('system.netz_vorher') }, { text: t('system.netz_nachher') }]);
        const feldText = { modus: t('system.netz_modus'), schnittstelle: t('system.netz_schnittstelle'), adresse: t('system.netz_adresse'), gateway: t('system.netz_gateway'), dns: t('system.netz_dns') };
        for (const z of zeilen) tabellenzeile(tab.koerper, [feldText[z.feld], el('td', { klasse: 'vw-mono', text: z.alt }), el('td', { klasse: `vw-mono ${z.geaendert ? 'sy-geaendert' : ''}`.trim(), text: z.neu })]);
        const fz2 = fehlerzeile();
        dialogOeffnen({ ctx, titel: t('system.netz_vergleich_titel'), schliessenText: t('system.schliessen'), inhalt: el('div', {}, hinweis(t('system.netz_vergleich_erklaerung'), 'warnung'), tab.element, fz2.element),
          knoepfe: [
            { text: t('system.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
            { text: t('system.uebernehmen'), art: 'gefahr', beiKlick: async (g) => {
              g.beschaeftigt(true);
              try {
                await setzen({ netz: neu }, t('system.netz_gespeichert'));
                g.schliessen();
                // Anzeige aus der Antwort des Agenten neu aufbauen (er leert bei DHCP Adresse/Gateway selbst)
                netzKarteErneuern();
              } catch (e) { g.beschaeftigt(false); fz2.zeigen(fehlerText(e)); }
            } },
          ] });
      });
      return karte(t('system.netz_titel'), form);
    }
    let netzKarte = null;
    function netzKarteErneuern() {
      const frisch = karteNetz();
      if (netzKarte && netzKarte.isConnected) netzKarte.replaceWith(frisch);
      netzKarte = frisch;
      return frisch;
    }

    // ---- Standort und Verbindungen (Weltkarte der Übersicht) ---------------------------------------------------
    function karteStandort() {
      const standort = { lat: null, lon: null, name: '', ...(konfig.standort || {}) };
      const verbindungen = { aufzeichnen: true, ...(konfig.verbindungen || {}) };
      const geo = { stadt_laden: true, ...(konfig.geo || {}) };
      const zahlText = (w) => (typeof w === 'number' && Number.isFinite(w) ? String(w) : '');
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal' });
      const fz = fehlerzeile();
      const breite = eingabe({ wert: zahlText(standort.lat), maxlength: 24, spellcheck: false, klasse: 'vw-mono sy-standort-breite', platzhalter: '48.6284', inputmode: 'decimal', autocomplete: 'off' });
      const laenge = eingabe({ wert: zahlText(standort.lon), maxlength: 24, spellcheck: false, klasse: 'vw-mono sy-standort-laenge', platzhalter: '11.7989', inputmode: 'decimal', autocomplete: 'off' });
      const name = eingabe({ wert: standort.name || '', maxlength: MAX_ORTSNAME, klasse: 'sy-standort-name', platzhalter: 'Sandelzhausen', autocomplete: 'off' });
      const aufzeichnen = schalter({ label: t('system.verbindungen_aufzeichnen'), erklaerung: t('system.verbindungen_aufzeichnen_erklaerung'), wert: verbindungen.aufzeichnen !== false });
      aufzeichnen.eingabe.classList.add('sy-verbindungen-aufzeichnen');
      const stadtLaden = schalter({ label: t('system.geo_stadt_laden'), erklaerung: t('system.geo_stadt_laden_erklaerung'), wert: geo.stadt_laden !== false });
      stadtLaden.eingabe.classList.add('sy-geo-stadt-laden');
      // Stand der Ortsdaten: liefert netz.verbindungen im Block `geo` mit – ohne Antwort bleibt die Zeile weg
      const stand = el('p', { klasse: 'erklaerung sy-geo-stand', attr: { 'aria-live': 'polite' } });
      stand.hidden = true;
      const proxys = textbereich({ zeilen: 3, klasse: 'vw-mono sy-proxys', wert: (Array.isArray(konfig.vertraute_proxys) ? konfig.vertraute_proxys : []).join('\n'), platzhalter: '192.168.1.23' });
      proxys.setAttribute('spellcheck', 'false');
      const speichern = knopf(t('system.speichern'), { typ: 'submit' });
      form.append(fz.element,
        el('div', { klasse: 'vw-zeile sy-standort-zeile' },
          feld({ label: t('system.standort_breite'), erklaerung: t('system.standort_breite_erklaerung'), eingabe: breite }),
          feld({ label: t('system.standort_laenge'), erklaerung: t('system.standort_laenge_erklaerung'), eingabe: laenge })),
        feld({ label: t('system.standort_name'), erklaerung: t('system.standort_name_erklaerung'), eingabe: name }),
        aufzeichnen.element, stadtLaden.element, stand,
        feld({ label: t('system.proxys'), erklaerung: t('system.proxys_erklaerung', { max: MAX_PROXYS }), eingabe: proxys }),
        speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const s = standortAus(breite.value, laenge.value, name.value);
        const p = proxysAus(proxys.value);
        const regeln = [
          { eingabe: breite, pruefen: () => (s.fehler === 'breite' ? t('system.standort_breite_fehler') : s.fehler === 'paar' && !breite.value.trim() ? t('system.standort_paar_fehler') : null) },
          { eingabe: laenge, pruefen: () => (s.fehler === 'laenge' ? t('system.standort_laenge_fehler') : s.fehler === 'paar' && !laenge.value.trim() ? t('system.standort_paar_fehler') : null) },
          { eingabe: name, pruefen: () => (s.fehler === 'name' ? t('system.standort_name_fehler', { max: MAX_ORTSNAME }) : null) },
          { eingabe: proxys, pruefen: () => (p.fehler === 'zuviele' ? t('system.proxys_zuviele', { max: MAX_PROXYS }) : p.fehler ? t('system.proxys_fehler', { wert: p.wert }) : null) },
        ];
        if (!felderPruefen(regeln, fz)) return;
        speichern.disabled = true;
        try {
          await setzen({ standort: s.standort, verbindungen: { aufzeichnen: aufzeichnen.eingabe.checked }, geo: { stadt_laden: stadtLaden.eingabe.checked }, vertraute_proxys: p.liste }, t('system.standort_gespeichert'));
          // bereinigte Werte zurück in die Felder (Komma → Punkt, Leerzeichen, doppelte Proxys)
          breite.value = zahlText(s.standort.lat); laenge.value = zahlText(s.standort.lon); name.value = s.standort.name; proxys.value = p.liste.join('\n');
        } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
      });
      api(ctx, 'netz.verbindungen', { richtung: 'aus' }).then((r) => {
        const g = r && r.geo; if (!g || typeof g !== 'object') return;
        const text = g.quelle === 'stadt' ? t('system.geo_stand_stadt', { stand: g.stand || '–' }) : g.quelle === 'land' ? t('system.geo_stand_land') : t('system.geo_stand_keine');
        stand.textContent = g.hinweis ? `${text} ${g.hinweis}` : text;
        stand.hidden = false;
      }).catch(() => { /* ältere Agenten ohne netz.verbindungen: kein Stand */ });
      const k = karte(t('system.standort_titel'), el('p', { klasse: 'erklaerung sy-einleitung', text: t('system.standort_erklaerung') }), form);
      k.classList.add('sy-standort');
      return k;
    }

    // ---- Anmeldeschutz (Zugriff aus dem Internet, 16.10.2026) --------------------------------------------------
    function karteAnmeldeschutz() {
      const schutz = { laender: ['DE'], ...(konfig.anmeldeschutz || {}) };
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal' });
      const fz = fehlerzeile();
      const laender = eingabe({ wert: (Array.isArray(schutz.laender) ? schutz.laender : []).join(', '), maxlength: 240, klasse: 'vw-mono sy-schutz-laender', platzhalter: 'DE', autocomplete: 'off', spellcheck: false });
      const speichern = knopf(t('system.speichern'), { typ: 'submit' });
      const stand = el('p', { klasse: 'erklaerung sy-schutz-stand', attr: { 'aria-live': 'polite' } });
      stand.hidden = true;
      const warnung = el('div', {}); warnung.hidden = true;
      const punkte = el('ul', { klasse: 'sy-schutz-punkte' },
        ['system.schutz_punkt_sperre', 'system.schutz_punkt_aufgabe', 'system.schutz_punkt_2fa', 'system.schutz_punkt_meldung'].map((k) => el('li', { text: t(k) })));
      form.append(fz.element,
        feld({ label: t('system.schutz_laender'), erklaerung: t('system.schutz_laender_erklaerung'), eingabe: laender }),
        speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const liste = [...new Set(laender.value.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
        if (!felderPruefen([{ eingabe: laender, pruefen: () => (liste.some((x) => !/^[A-Z]{2}$/.test(x)) ? t('system.schutz_laender_fehler') : null) }], fz)) return;
        speichern.disabled = true;
        try { await setzen({ anmeldeschutz: { laender: liste } }, t('system.schutz_gespeichert')); laender.value = liste.join(', '); } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
      });
      // Stand der letzten 24 h und ein Hinweis, falls keine Benachrichtigung eingerichtet ist
      get(ctx, '/api/anmeldeschutz').then((u) => {
        stand.textContent = t('system.schutz_stand', { fehler: u.fehler_24h || 0, land: u.land_24h || 0, gesperrt: (u.sperren || []).length });
        stand.hidden = false;
      }).catch(() => {});
      api(ctx, 'benachrichtigungen.lesen', {}).then((b) => {
        if (b && ((b.email && b.email.aktiv) || (b.ntfy && b.ntfy.aktiv))) return;
        warnung.replaceChildren(hinweis(t('system.schutz_ohne_meldung'), 'warnung')); warnung.hidden = false;
      }).catch(() => {});
      return karte(t('system.schutz_titel'), el('p', { klasse: 'erklaerung sy-einleitung', text: t('system.schutz_erklaerung') }), punkte, warnung, stand, form);
    }

    // ---- Dienste ----------------------------------------------------------------------------------------------
    function karteDienste() {
      const k = karte(t('system.dienste_titel'), el('p', { klasse: 'erklaerung', text: t('system.dienste_erklaerung') }));
      const liste = el('ul', { klasse: 'vw-liste sy-dienste' });
      k.appendChild(liste);
      const zeichnen = () => {
        leeren(liste);
        const dienste = (status && status.dienste) || {};
        for (const d of DIENSTE) {
          const z = dienste[d] || 'unbekannt';
          const schalten = async (zustand) => {
            if (d === 'ssh' && zustand === 'aus' && !(await bestaetigen(ctx, t('system.dienst_ssh_aus_frage')))) return;
            try {
              const r = await api(ctx, 'system.dienst', { dienst: d, zustand });
              melden(ctx, t('system.dienst_geschaltet', { dienst: dienstText[d], zustand: zustandText[dienstZustand(r, zustand)] }), 'erfolg');
              await statusNeu();
            } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
          };
          liste.appendChild(el('li', { klasse: 'sy-dienst' },
            el('div', { klasse: 'vw-liste-name' },
              el('div', { klasse: 'sy-dienst-kopf' }, ampel(z, zustandText[z] || t('system.zustand_unbekannt')), el('strong', { text: dienstText[d] }), ' ', el('span', { klasse: 'vw-gedaempft', text: zustandText[z] || t('system.zustand_unbekannt') })),
              el('p', { klasse: 'erklaerung', text: dienstErklaerung[d] })),
            el('div', { klasse: 'vw-knopfleiste sy-dienst-knoepfe' },
              knopf(t('system.an'), { art: 'zweit', klein: true, deaktiviert: z === 'aktiv', beiKlick: () => schalten('an') }),
              knopf(t('system.aus'), { art: z === 'aktiv' ? 'gefahr' : 'zweit', klein: true, deaktiviert: z === 'inaktiv', beiKlick: () => schalten('aus') }),
              knopf(t('system.neustart'), { art: 'zweit', klein: true, beiKlick: () => schalten('neustart') })),
            d === 'ssh' ? sshPortFormular() : null));
        }
      };
      zeichnen();
      k.neuZeichnen = zeichnen;
      return k;
    }

    // SSH-Port selbst wählen (Betreiber 11.11.2026), mit Hinweis, was sich dadurch ändert
    function sshPortFormular() {
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal sy-ssh-port' });
      const fz = fehlerzeile();
      const jetzt = Number(konfig.ssh_port) || 22;
      const port = eingabe({ typ: 'number', wert: jetzt, min: 1, max: 65535, schritt: 1, inputmode: 'numeric' });
      const speichern = knopf(t('system.speichern'), { typ: 'submit', klein: true });
      form.append(fz.element, feld({ label: t('system.ssh_port'), erklaerung: t('system.ssh_port_erklaerung'), eingabe: port }),
        hinweis(t('system.ssh_port_hinweis'), 'info'), speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const gueltig = (w) => { const n = Number(w); return Number.isInteger(n) && (n === 22 || (n >= 1024 && n <= 65535)) && n !== 5353 && n !== 8443; };
        if (!felderPruefen([{ eingabe: port, pruefen: (w) => (gueltig(w) ? null : t('system.ssh_port_fehler')) }], fz)) return;
        const neu = Number(port.value);
        if (neu === (Number(konfig.ssh_port) || 22)) return;
        if (!(await bestaetigen(ctx, t('system.ssh_port_frage', { port: neu })))) return;
        speichern.disabled = true;
        try { await setzen({ ssh_port: neu }, t('system.ssh_port_gespeichert', { port: neu })); } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
      });
      return form;
    }

    async function statusNeu() {
      try { status = (await api(ctx, 'system.status', {})) || status; } catch { /* alter Stand */ }
      if (diensteKarte.neuZeichnen) diensteKarte.neuZeichnen();
      if (ueberKarte.neuZeichnen) ueberKarte.neuZeichnen();
    }

    // ---- Docker-Ordner als Freigabe (App-Ordner /data/apps zum Anpassen von Hand, nur Admins) -------------------
    function karteDockerFreigabe() {
      const host = status.hostname || konfig.hostname || 'fahnas';
      const adresse = el('p', { klasse: 'erklaerung vw-mono' });
      const adresseZeigen = (an) => { adresse.textContent = an ? t('system.docker_freigabe_adresse', { host }) : ''; adresse.hidden = !an; };
      const s = schalter({ label: t('system.docker_freigabe'), erklaerung: t('system.docker_freigabe_erklaerung'), wert: !!konfig.docker_freigabe, beiWechsel: async (an) => {
        s.eingabe.disabled = true;
        try { await setzen({ docker_freigabe: an }, t(an ? 'system.docker_freigabe_an' : 'system.docker_freigabe_aus')); adresseZeigen(an); } catch (e) {
          s.eingabe.checked = !an; s.eingabe.setAttribute('aria-checked', !an ? 'true' : 'false'); melden(ctx, fehlerText(e), 'fehler');
        } finally { s.eingabe.disabled = false; }
      } });
      adresseZeigen(!!konfig.docker_freigabe);
      return karte(t('system.docker_freigabe_titel'), s.element, adresse, hinweis(t('system.docker_freigabe_warnung'), 'warnung'));
    }

    // ---- Updates ----------------------------------------------------------------------------------------------
    function karteUpdates() {
      const ergebnis = el('div', { klasse: 'sy-updates-ergebnis' });
      const einspielen = knopf(t('system.updates_einspielen'), { deaktiviert: true });
      let gefunden = null;
      const pruefen = knopf(t('system.updates_pruefen'), { art: 'zweit', beiKlick: async () => {
        pruefen.disabled = true;
        try {
          const r = await aufgabeStarten(ctx, 'system.updates.pruefen', {}, { titel: t('system.updates_pruefen'), meldung: t('system.updates_pruefen_laeuft'), abbrechen: t('system.aufgabe_abbrechen'), schliessen: t('system.schliessen'), fehler: (m) => t('system.aufgabe_fehl', { meldung: m }), abgebrochen: t('system.aufgabe_abgebrochen') });
          zeigeGefunden(r || { anzahl: 0, pakete: [], sicherheit: 0 });
        } catch { /* Fehler steht im Aufgabendialog */ } finally { pruefen.disabled = false; }
      } });
      /** Gefundene Updates als Tabelle; `ausListen` = aus den vorhandenen Paketlisten (ohne „Prüfen“), mit Hinweis. */
      function zeigeGefunden(g, { ausListen = false } = {}) {
        gefunden = g;
        leeren(ergebnis);
        const anzahl = Number(gefunden.anzahl) || (gefunden.pakete || []).length;
        if (!anzahl) { ergebnis.appendChild(hinweis(t('system.updates_keine'), 'erfolg')); einspielen.disabled = true; return; }
        ergebnis.appendChild(hinweis(t('system.updates_gefunden', { anzahl, sicherheit: Number(gefunden.sicherheit) || 0 }), 'info'));
        if (ausListen) ergebnis.appendChild(el('p', { klasse: 'erklaerung', text: t('system.updates_aus_listen') }));
        const tab = tabelle([{ text: t('system.updates_paket') }, { text: t('system.updates_bereich') }, { text: t('system.updates_alt') }, { text: t('system.updates_neu') }]);
        for (const p of gefunden.pakete || []) tabellenzeile(tab.koerper, [el('td', { klasse: 'vw-mono', text: p.name || '' }), p.bereich ? badge(p.bereich) : t('system.updates_grundsystem'), p.alt || '', p.neu || '']);
        ergebnis.appendChild(tab.element);
        einspielen.disabled = false;
      }
      // Beim Öffnen gleich zeigen, was die Paketlisten schon kennen (Handlungsbedarf „x Updates“ → hier sichtbar)
      api(ctx, 'system.hinweise', {}).then((h) => { if (!gefunden && h && h.updates && Number(h.updates.anzahl) > 0) zeigeGefunden(h.updates, { ausListen: true }); }).catch(() => {});
      einspielen.addEventListener('click', async () => {
        const anzahl = gefunden ? (Number(gefunden.anzahl) || (gefunden.pakete || []).length) : 0;
        if (!(await bestaetigen(ctx, t('system.updates_einspielen_frage', { anzahl })))) return;
        einspielen.disabled = true;
        try {
          const r = await aufgabeStarten(ctx, 'system.updates.einspielen', {}, { titel: t('system.updates_einspielen'), meldung: t('system.updates_einspielen_laeuft'), abbrechen: t('system.aufgabe_abbrechen'), schliessen: t('system.schliessen'), fehler: (m) => t('system.aufgabe_fehl', { meldung: m }), abgebrochen: t('system.aufgabe_abgebrochen') });
          leeren(ergebnis);
          const eingespielt = eingespieltAuswerten(r, anzahl);
          ergebnis.appendChild(hinweis(t('system.updates_fertig', { anzahl: eingespielt.anzahl }), 'erfolg'));
          if (eingespielt.pakete.length) ergebnis.appendChild(el('p', { klasse: 'vw-gedaempft vw-umbruch', text: t('system.updates_eingespielt_liste', { liste: eingespielt.pakete.join(', ') }) }));
          if (r && (r.schnappschuss_vor || r.schnappschuss_nach)) ergebnis.appendChild(el('p', { klasse: 'vw-gedaempft', text: t('system.updates_schnappschuesse', { vor: r.schnappschuss_vor || '–', nach: r.schnappschuss_nach || '–' }) }));
          if (r && r.neustart_noetig) ergebnis.append(hinweis(t('system.updates_neustart_noetig'), 'warnung'), knopf(t('system.neustart_knopf'), { art: 'gefahr', beiKlick: neustart }));
          gefunden = null;
        } catch { einspielen.disabled = false; }
      });
      return karte(t('system.updates_titel'),
        el('p', { klasse: 'erklaerung', text: t('system.updates_erklaerung') }),
        el('div', { klasse: 'vw-knopfleiste' }, pruefen, einspielen),
        ergebnis,
        el('details', { klasse: 'vw-details' }, el('summary', { text: t('system.updates_rueckfall_titel') }), el('p', { klasse: 'sy-anleitung', text: t('system.updates_rueckfall') })));
    }

    // ---- FAH-NAS aktualisieren (Release-Archiv hochladen, prüfen, einspielen) ------------------------------------
    // Das Update startet Agent und Web neu: während der Abfragen sind Fehler normal, erst Zustand erfolg/fehler zählt.
    function karteProgramm() {
      const fz = fehlerzeile();
      const datei = el('input', { typ: 'file', klasse: 'eingabe vw-eingabe', attr: { accept: PROGRAMM_ACCEPT } });
      const pruefenKnopf = knopf(t('system.programm_pruefen'), { typ: 'submit', art: 'zweit' });
      const ergebnis = el('div', { klasse: 'sy-programm-ergebnis', attr: { 'aria-live': 'polite' } });
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'sy-block' });
      form.append(fz.element, feld({ label: t('system.programm_datei'), erklaerung: t('system.programm_datei_erklaerung'), eingabe: datei }), pruefenKnopf);
      const ausgabeBlock = (zeilen) => (Array.isArray(zeilen) && zeilen.length
        ? el('details', { klasse: 'vw-details' }, el('summary', { text: t('system.programm_ausgabe') }), el('pre', { klasse: 'sy-programm-ausgabe vw-mono', text: zeilen.join('\n') }))
        : null);
      const zeigen = (...knoten) => { leeren(ergebnis); for (const k of knoten) if (k) ergebnis.appendChild(k); };

      function verfolgen(von, nach) {
        if (programmTimer) clearTimeout(programmTimer);
        form.hidden = true;
        zeigen(hinweis(t('system.programm_laeuft', { nach }), 'info'));
        const ende = Date.now() + PROGRAMM_MAX_MS;
        const abfragen = async () => {
          programmTimer = null;
          let s = null;
          try { s = await api(ctx, 'system.programm.status', {}); } catch { /* Dienste starten gerade neu */ }
          if (s && s.zustand === 'erfolg') {
            zeigen(hinweis(t('system.programm_erfolg', { nach: s.nach || nach }), 'erfolg'));
            programmTimer = setTimeout(() => location.reload(), 3000);
            return;
          }
          if (s && (s.zustand === 'fehler' || s.zustand === 'abgebrochen')) {
            form.hidden = false;
            zeigen(hinweis(t(s.zustand === 'fehler' ? 'system.programm_fehler' : 'system.programm_abgebrochen', { von: s.von || von, nach: s.nach || nach }), 'fehler'), ausgabeBlock(s.ausgabe));
            return;
          }
          if (Date.now() > ende) { form.hidden = false; zeigen(hinweis(t('system.programm_zeitueberschreitung'), 'warnung')); return; }
          programmTimer = setTimeout(abfragen, PROGRAMM_ABFRAGE_MS);
        };
        programmTimer = setTimeout(abfragen, PROGRAMM_ABFRAGE_MS);
      }

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = datei.files && datei.files[0];
        if (!f) { fz.zeigen(t('system.programm_keine_datei')); datei.focus(); return; }
        fz.leeren(); leeren(ergebnis); pruefenKnopf.disabled = true;
        try {
          const tk = await api(ctx, 'system.programm.ticket', { dateiname: f.name, groesse: f.size });
          if (!tk || !tk.ticket) throw new Error('Kein Ticket erhalten');
          zeigen(hinweis(t('system.programm_hochladen'), 'info'));
          const antwort = await fetch(`/api/agent-upload?ticket=${encodeURIComponent(tk.ticket)}`, {
            method: 'POST', body: f, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'X-FAHNAS-CSRF': csrfWert() },
          });
          let antwortDaten = null;
          try { antwortDaten = await antwort.json(); } catch { /* keine JSON-Antwort */ }
          if (!antwort.ok || (antwortDaten && antwortDaten.ok === false)) throw (antwortDaten && antwortDaten.fehler) || new Error(`${t('system.programm_upload_fehl')} (HTTP ${antwort.status})`);
          const r = await api(ctx, 'system.programm.pruefen', { kennung: tk.kennung });
          const texte = { neu: r.version_neu, alt: r.version_alt };
          const einspielen = knopf(t('system.programm_einspielen'), { art: r.vergleich === 'aelter' ? 'gefahr' : undefined, beiKlick: async () => {
            if (!(await bestaetigen(ctx, t('system.programm_frage', texte)))) return;
            einspielen.disabled = true;
            try {
              const e = await api(ctx, 'system.programm.einspielen', { kennung: tk.kennung });
              datei.value = '';
              verfolgen(e.von || r.version_alt, e.nach || r.version_neu);
            } catch (x) { einspielen.disabled = false; fz.zeigen(fehlerText(x)); }
          } });
          const art = r.vergleich === 'aelter' ? 'warnung' : 'info';
          const text = r.vergleich === 'aelter' ? 'system.programm_aelter' : r.vergleich === 'gleich' ? 'system.programm_gleich' : 'system.programm_neuer';
          zeigen(hinweis(t(text, texte), art), el('div', { klasse: 'vw-knopfleiste' }, einspielen));
        } catch (e) { leeren(ergebnis); fz.zeigen(fehlerText(e)); } finally { pruefenKnopf.disabled = false; }
      });

      const installiert = el('p', { klasse: 'vw-gedaempft', text: t('system.programm_installiert', { version: status.version || '–' }) });
      const letztes = el('div');
      // letzter Lauf (auch nach dem Neuladen): läuft er noch, weiter verfolgen; sonst Ergebnis mit Ausgabe zeigen
      api(ctx, 'system.programm.status', {}).then((s) => {
        if (!s || s.zustand === 'keins') return;
        if (s.zustand === 'laeuft') { verfolgen(s.von, s.nach); return; }
        const zustand = { erfolg: t('system.programm_zustand_erfolg'), fehler: t('system.programm_zustand_fehler'), abgebrochen: t('system.programm_zustand_abgebrochen') }[s.zustand] || s.zustand;
        letztes.append(el('p', { klasse: 'vw-gedaempft', text: t('system.programm_letztes', { von: s.von || '–', nach: s.nach || '–', zeit: s.gestartet ? fmt.zeit(s.gestartet) : '–', zustand }) }));
        const block = ausgabeBlock(s.ausgabe); if (block) letztes.append(block);
      }).catch(() => { /* ohne Verlauf */ });
      return karte(t('system.programm_titel'), el('p', { klasse: 'erklaerung', text: t('system.programm_erklaerung') }), installiert, form, ergebnis, letztes);
    }

    // ---- Energie ----------------------------------------------------------------------------------------------
    function karteEnergie() {
      const energie = { platten_ruhe_min: 0, zeitplan: [], ...(konfig.energie || {}) };
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'vw-schmal' });
      const fz = fehlerzeile();
      const ruhe = eingabe({ typ: 'number', wert: Number(energie.platten_ruhe_min) || 0, min: 0, max: MAX_PLATTEN_RUHE, schritt: 1, inputmode: 'numeric' });
      const speichern = knopf(t('system.speichern'), { typ: 'submit' });
      form.append(fz.element, feld({ label: t('system.energie_platten'), erklaerung: t('system.energie_platten_erklaerung', { max: MAX_PLATTEN_RUHE }), eingabe: ruhe }), speichern);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([{ eingabe: ruhe, pruefen: (w) => (w !== '' && Number.isInteger(Number(w)) && Number(w) >= 0 && Number(w) <= MAX_PLATTEN_RUHE ? null : t('system.energie_fehler', { max: MAX_PLATTEN_RUHE })) }], fz)) return;
        speichern.disabled = true;
        try { await setzen({ energie: { ...energie, platten_ruhe_min: Number(ruhe.value) } }); } catch (e) { fz.zeigen(fehlerText(e)); } finally { speichern.disabled = false; }
      });
      return karte(t('system.energie_titel'), form);
    }

    // ---- S.M.A.R.T. -------------------------------------------------------------------------------------------
    function karteSmart() {
      const bereich = el('div', {});
      const neu = knopf(t('system.smart_aktualisieren'), { art: 'zweit', klein: true, beiKlick: () => laden() });
      const k = karte(null, el('div', { klasse: 'vw-karte-kopf' }, el('h2', { klasse: 'vw-karte-titel', text: t('system.smart_titel') }), neu), el('p', { klasse: 'erklaerung', text: t('system.smart_erklaerung') }), bereich);
      const zustandKlasse = { ok: 'aktiv', warnung: 'warnung', fehler: 'fehler', unbekannt: 'unbekannt' };
      const zustandT = { ok: t('system.smart_ok'), warnung: t('system.smart_warnung'), fehler: t('system.smart_fehler'), unbekannt: t('system.smart_unbekannt') };
      async function laden() {
        leeren(bereich); bereich.appendChild(leerHinweis(t('system.smart_laden'))); neu.disabled = true;
        try {
          const r = await api(ctx, 'system.smart', {});
          const platten = Array.isArray(r) ? r : (r && r.platten) || [];
          leeren(bereich);
          if (!platten.length) { bereich.appendChild(leerHinweis(t('system.smart_keine'))); return; }
          const tab = tabelle([{ text: t('system.smart_geraet') }, { text: t('system.smart_modell') }, { text: t('system.smart_zustand') }, { text: t('system.smart_temperatur') }, { text: t('system.smart_stunden') }], [], { klasse: 'sy-smart' });
          for (const p of platten) {
            tabellenzeile(tab.koerper, [
              el('td', { klasse: 'vw-mono', text: p.geraet || '' }), p.modell || '',
              el('td', {}, ampel(zustandKlasse[p.zustand] || 'unbekannt', zustandT[p.zustand] || String(p.zustand || '')), zustandT[p.zustand] || String(p.zustand || t('system.zustand_unbekannt'))),
              p.temperatur !== undefined && p.temperatur !== null ? `${p.temperatur} °C` : '–',
              p.stunden !== undefined && p.stunden !== null ? String(p.stunden) : '–',
            ], { klasse: p.zustand === 'fehler' ? 'vw-zeile-fehler' : '' });
            if (p.details) {
              const details = el('details', { klasse: 'vw-details' }, el('summary', { text: t('system.smart_details') }));
              if (typeof p.details === 'object') {
                const dl = el('dl', { klasse: 'vw-kv' });
                for (const [kk, vv] of Object.entries(p.details)) dl.append(el('dt', { text: kk }), el('dd', { klasse: 'vw-mono', text: typeof vv === 'object' ? JSON.stringify(vv) : String(vv) }));
                details.appendChild(dl);
              } else details.appendChild(el('pre', { text: String(p.details) }));
              const tr = el('tr', { klasse: 'sy-details-zeile' }, el('td', { attr: { colspan: 5 } }, details));
              tab.koerper.appendChild(tr);
            }
          }
          bereich.appendChild(tab.element);
        } catch (e) { leeren(bereich); bereich.appendChild(hinweis(`${t('system.smart_fehl')} ${fehlerText(e)}`, 'warnung')); } finally { neu.disabled = false; }
      }
      laden();
      return k;
    }

    // ---- Protokoll --------------------------------------------------------------------------------------------
    function karteProtokoll() {
      const form = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'sy-filter' });
      const nutzer = eingabe({ maxlength: 64, spellcheck: false, klasse: 'vw-mono' });
      const aktion = eingabe({ maxlength: 64, spellcheck: false, klasse: 'vw-mono' });
      const von = eingabe({ typ: 'datetime-local' });
      const bis = eingabe({ typ: 'datetime-local' });
      const filtern = knopf(t('system.protokoll_filtern'), { typ: 'submit', art: 'zweit' });
      form.append(el('div', { klasse: 'vw-zeile' },
        feld({ label: t('system.protokoll_nutzer'), erklaerung: t('system.protokoll_nutzer_erklaerung'), eingabe: nutzer }),
        feld({ label: t('system.protokoll_aktion'), erklaerung: t('system.protokoll_aktion_erklaerung'), eingabe: aktion }),
        feld({ label: t('system.protokoll_von'), eingabe: von }), feld({ label: t('system.protokoll_bis'), eingabe: bis }),
        el('div', { klasse: 'vw-feld sy-filter-knopf' }, filtern)));
      const bereich = el('div', {});
      const seitenleiste = el('div', { klasse: 'sy-seiten' });
      let seite = 1;
      async function laden() {
        leeren(bereich); bereich.appendChild(leerHinweis(t('system.protokoll_laden'))); leeren(seitenleiste);
        try {
          const params = { seite, je_seite: PROTOKOLL_JE_SEITE };
          if (nutzer.value.trim()) params.nutzer = nutzer.value.trim();
          if (aktion.value.trim()) params.aktion = aktion.value.trim();
          const v = isoAus(von.value); const b = isoAus(bis.value);
          if (v) params.von = v; if (b) params.bis = b;
          const r = await api(ctx, 'system.protokoll', params);
          const eintraege = (r && r.eintraege) || [];
          const gesamt = Number(r && r.gesamt) || eintraege.length;
          leeren(bereich);
          if (!eintraege.length) { bereich.appendChild(leerHinweis(t('system.protokoll_keine'))); return; }
          const tab = tabelle([{ text: t('system.protokoll_zeit') }, { text: t('system.protokoll_nutzer') }, { text: t('system.protokoll_ip') }, { text: t('system.protokoll_aktion') }, { text: t('system.protokoll_ergebnis') }, { text: t('system.protokoll_dauer') }], [], { klasse: 'sy-protokoll' });
          for (const e of eintraege) {
            const fehl = e.ok === false;
            tabellenzeile(tab.koerper, [
              fmt.zeit(e.zeit), el('td', { klasse: 'vw-mono', text: e.nutzer || '-' }), el('td', { klasse: 'vw-mono', text: e.ip || '-' }), el('td', { klasse: 'vw-mono', text: e.aktion || '' }),
              fehl ? el('td', {}, badge(e.fehler && e.fehler.code ? e.fehler.code : 'Fehler', undefined, 'gefahr'), ' ', el('span', { text: e.fehler && e.fehler.meldung ? e.fehler.meldung : '' })) : t('system.protokoll_ok'),
              e.dauer_ms !== undefined ? `${e.dauer_ms} ms` : '',
            ], { klasse: fehl ? 'vw-zeile-fehler' : '' });
          }
          bereich.appendChild(tab.element);
          const seiten = Math.max(1, Math.ceil(gesamt / PROTOKOLL_JE_SEITE));
          seitenleiste.append(
            knopf(t('system.protokoll_zurueck'), { art: 'zweit', klein: true, deaktiviert: seite <= 1, beiKlick: () => { seite -= 1; laden(); } }),
            el('span', { klasse: 'vw-gedaempft', text: t('system.protokoll_seite', { seite, seiten, gesamt }) }),
            knopf(t('system.protokoll_weiter'), { art: 'zweit', klein: true, deaktiviert: seite >= seiten, beiKlick: () => { seite += 1; laden(); } }));
        } catch (e) { leeren(bereich); bereich.appendChild(hinweis(`${t('system.protokoll_fehl')} ${fehlerText(e)}`, 'warnung')); }
      }
      form.addEventListener('submit', (ev) => { ev.preventDefault(); seite = 1; laden(); });
      // Zugeklappt und erst beim Öffnen geladen (Betreiber 12.10.: sonst müsse man über alle Einträge rollen, um ans Ende zu kommen)
      const klappe = el('details', { klasse: 'sy-klappe' },
        el('summary', { klasse: 'sy-klappe-kopf' }, el('h2', { klasse: 'vw-karte-titel', text: t('system.protokoll_titel') }), el('span', { klasse: 'erklaerung sy-klappe-hinweis', text: t('system.protokoll_aufklappen') })),
        el('p', { klasse: 'erklaerung', text: t('system.protokoll_erklaerung') }), form, bereich, seitenleiste);
      let geladen = false;
      klappe.addEventListener('toggle', () => { if (klappe.open && !geladen) { geladen = true; laden(); } });
      return karte(null, klappe);
    }

    // ---- Export / Import --------------------------------------------------------------------------------------
    function karteExportImport() {
      // Export
      const exportForm = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'sy-block' });
      const fzE = fehlerzeile();
      const passwortFeld = eingabe({ typ: 'password', autocomplete: 'new-password', maxlength: 256 });
      const passwortWrap = feld({ label: t('system.export_passwort'), erklaerung: t('system.export_passwort_erklaerung'), eingabe: passwortFeld });
      passwortWrap.classList.add('vw-versteckt');
      const geheim = schalter({ label: t('system.export_geheimnisse'), erklaerung: t('system.export_geheimnisse_erklaerung'), wert: false, beiWechsel: (an) => passwortWrap.classList.toggle('vw-versteckt', !an) });
      const exportKnopf = knopf(t('system.export_knopf'), { typ: 'submit' });
      exportForm.append(el('h3', { klasse: 'sy-untertitel', text: t('system.export_titel') }), el('p', { klasse: 'erklaerung', text: t('system.export_erklaerung') }), fzE.element, geheim.element, passwortWrap, exportKnopf);
      exportForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const mit = geheim.eingabe.checked;
        if (mit && passwortFeld.value.length < 8) { fzE.zeigen(t('system.export_passwort_fehler')); passwortFeld.focus(); return; }
        fzE.leeren(); exportKnopf.disabled = true;
        try {
          const params = { mit_geheimnissen: mit };
          if (mit) params.passwort = passwortFeld.value;
          const r = await api(ctx, 'system.export', params);
          if (!r || !r.ticket) throw new Error('Kein Ticket erhalten');
          const url = `/api/agent-download?ticket=${encodeURIComponent(r.ticket)}${r.dateiname ? `&dateiname=${encodeURIComponent(r.dateiname)}` : ''}`;
          herunterladenUrl(url, r.dateiname);
          melden(ctx, t('system.export_gestartet', { datei: r.dateiname || 'fahnas-export.tar' }), 'erfolg');
        } catch (e) { fzE.zeigen(fehlerText(e)); } finally { exportKnopf.disabled = false; }
      });

      // Import
      const importForm = el('form', { attr: { novalidate: 'novalidate' }, klasse: 'sy-block' });
      const fzI = fehlerzeile();
      const datei = el('input', { typ: 'file', klasse: 'eingabe vw-eingabe', attr: { accept: IMPORT_ACCEPT } });
      const importPasswort = eingabe({ typ: 'password', autocomplete: 'off', maxlength: 256 });
      const pruefenKnopf = knopf(t('system.import_pruefen'), { typ: 'submit', art: 'zweit' });
      importForm.append(el('h3', { klasse: 'sy-untertitel', text: t('system.import_titel') }), el('p', { klasse: 'erklaerung', text: t('system.import_erklaerung') }), fzI.element,
        feld({ label: t('system.import_datei'), erklaerung: t('system.import_datei_erklaerung'), eingabe: datei }),
        feld({ label: t('system.import_passwort'), erklaerung: t('system.import_passwort_erklaerung'), eingabe: importPasswort }), pruefenKnopf);
      importForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = datei.files && datei.files[0];
        if (!f) { fzI.zeigen(t('system.import_keine_datei')); datei.focus(); return; }
        fzI.leeren(); pruefenKnopf.disabled = true;
        const aufgabenTexte = (titel, meldung) => ({ titel, meldung, abbrechen: t('system.aufgabe_abbrechen'), schliessen: t('system.schliessen'), fehler: (m) => t('system.aufgabe_fehl', { meldung: m }), abgebrochen: t('system.aufgabe_abgebrochen') });
        try {
          // 1. Ticket für den Upload
          const tk = await api(ctx, 'system.import.ticket', { dateiname: f.name, groesse: f.size });
          if (!tk || !tk.ticket) throw new Error('Kein Ticket erhalten');
          // 2. Hochladen über den Ticket-Upload-Weg (Rohdaten, CSRF-Kopf)
          melden(ctx, t('system.import_hochladen'), 'info');
          const antwort = await fetch(`/api/agent-upload?ticket=${encodeURIComponent(tk.ticket)}`, {
            method: 'POST', body: f, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'X-FAHNAS-CSRF': csrfWert() },
          });
          let antwortDaten = null;
          try { antwortDaten = await antwort.json(); } catch { /* keine JSON-Antwort */ }
          if (!antwort.ok || (antwortDaten && antwortDaten.ok === false)) throw (antwortDaten && antwortDaten.fehler) || new Error(`${t('system.import_fehl')} (HTTP ${antwort.status})`);
          // 3. Prüfen (anwenden:false) → Unterschiede
          const params = { ticket: tk.ticket, anwenden: false };
          if (importPasswort.value) params.passwort = importPasswort.value;
          const r = await aufgabeStarten(ctx, 'system.import', params, aufgabenTexte(t('system.import_pruefen'), t('system.import_pruefen_laeuft')));
          const unterschiede = r && r.unterschiede;
          const zeilen = Array.isArray(unterschiede) ? unterschiede : unterschiede && typeof unterschiede === 'object' ? Object.entries(unterschiede).map(([k, v]) => ({ bereich: k, alt: v && v.alt, neu: v && v.neu })) : [];
          const inhalt = el('div', {}, el('p', { klasse: 'erklaerung', text: t('system.import_vergleich_erklaerung') }));
          if (!zeilen.length) inhalt.appendChild(hinweis(t('system.import_keine_unterschiede'), 'info'));
          else {
            const tab = tabelle([{ text: t('system.unterschied_bereich') }, { text: t('system.unterschied_alt') }, { text: t('system.unterschied_neu') }]);
            const z = (w) => (w === undefined ? '' : typeof w === 'object' ? JSON.stringify(w) : String(w));
            for (const u of zeilen) tabellenzeile(tab.koerper, [el('td', { klasse: 'vw-mono', text: z(u.bereich ?? u.pfad ?? u.schluessel ?? u.datei ?? '') }), el('td', { klasse: 'vw-mono vw-umbruch', text: z(u.alt) }), el('td', { klasse: 'vw-mono vw-umbruch sy-geaendert', text: z(u.neu) })]);
            inhalt.appendChild(tab.element);
          }
          const fz2 = fehlerzeile(); inhalt.appendChild(fz2.element);
          dialogOeffnen({ ctx, titel: t('system.import_vergleich_titel'), inhalt, breit: true, schliessenText: t('system.schliessen'),
            knoepfe: [
              { text: t('system.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
              { text: t('system.import_uebernehmen'), art: 'gefahr', deaktiviert: !zeilen.length, beiKlick: async (g) => {
                g.schliessen();
                try {
                  // Das Ticket ist nach dem Prüflauf verbraucht – Teil C nimmt zum Übernehmen den Dateinamen aus dem Ticket-Ergebnis
                  const anwenden = { dateiname: (r && r.dateiname) || tk.dateiname || f.name, anwenden: true };
                  if (importPasswort.value) anwenden.passwort = importPasswort.value;
                  await aufgabeStarten(ctx, 'system.import', anwenden, aufgabenTexte(t('system.import_uebernehmen'), t('system.import_uebernehmen_laeuft')));
                  melden(ctx, t('system.import_fertig'), 'erfolg');
                  datei.value = ''; importPasswort.value = '';
                } catch { /* Fehler steht im Aufgabendialog */ }
              } },
            ] });
        } catch (e) { fzI.zeigen(fehlerText(e)); } finally { pruefenKnopf.disabled = false; }
      });
      return karte(t('system.export_titel'), el('div', { klasse: 'sy-zweispaltig' }, exportForm, importForm));
    }

    // ---- Neustart / Herunterfahren ----------------------------------------------------------------------------
    async function neustart() {
      if (!(await bestaetigen(ctx, t('system.neustart_frage')))) return;
      try {
        await api(ctx, 'system.neustart', {});
        melden(ctx, t('system.neustart_gestartet'), 'info');
        if (neustartTimer) clearTimeout(neustartTimer);
        neustartTimer = setTimeout(() => location.reload(), 60_000);
      } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }
    async function herunterfahren() {
      if (!(await bestaetigen(ctx, t('system.herunterfahren_frage')))) return;
      try { await api(ctx, 'system.herunterfahren', {}); melden(ctx, t('system.herunterfahren_gestartet'), 'info'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
    }
    function karteStrom() {
      return karte(t('system.strom_titel'), el('p', { klasse: 'erklaerung', text: t('system.strom_erklaerung') }),
        el('div', { klasse: 'vw-knopfleiste' }, knopf(t('system.neustart_knopf'), { art: 'gefahr', beiKlick: neustart }), knopf(t('system.herunterfahren_knopf'), { art: 'gefahr', beiKlick: herunterfahren })));
    }

    // ---- Über -------------------------------------------------------------------------------------------------
    function karteUeber() {
      const k = karte(t('system.ueber_titel'));
      const zeichnen = () => {
        leeren(k); k.appendChild(el('h2', { klasse: 'vw-karte-titel', text: t('system.ueber_titel') }));
        const lz = laufzeitTeile(status.laufzeit_s);
        const dl = el('dl', { klasse: 'vw-kv' },
          el('dt', { text: t('system.ueber_version') }), el('dd', { klasse: 'vw-mono', text: status.version || '–' }),
          el('dt', { text: t('system.ueber_hostname') }), el('dd', { klasse: 'vw-mono', text: status.hostname || konfig.hostname || '–' }),
          el('dt', { text: t('system.ueber_kernel') }), el('dd', { klasse: 'vw-mono', text: status.kernel || '–' }),
          el('dt', { text: t('system.ueber_laufzeit') }), el('dd', { text: t('system.laufzeit_format', lz) }));
        if (Array.isArray(status.platten) && status.platten.length) {
          dl.append(el('dt', { text: t('system.ueber_platten') }), el('dd', {}, el('ul', { klasse: 'sy-platten' }, status.platten.map((p) => el('li', {}, el('span', { klasse: 'vw-mono', text: `${p.label || p.pfad || ''} ` }), el('span', { klasse: 'vw-gedaempft', text: `${fmt.groesse((Number(p.gesamt) || 0) - (Number(p.frei) || 0))} / ${fmt.groesse(p.gesamt)}` }))))));
        }
        k.append(dl, el('p', { klasse: 'erklaerung sy-projekt', text: t('system.ueber_projekt') }));
      };
      zeichnen();
      k.neuZeichnen = zeichnen;
      return k;
    }

    const diensteKarte = karteDienste();
    const ueberKarte = karteUeber();
    // Sprungziele (#/system/<karte>) – Dashboard-Kacheln verlinken direkt auf ihre Einstellungskarte
    const markiert = (id, k) => { if (k && k.dataset) k.dataset.karte = id; return k; };
    wurzel.append(markiert('allgemein', karteAllgemein()), markiert('netzwerk', netzKarteErneuern()), markiert('standort', karteStandort()), markiert('anmeldeschutz', karteAnmeldeschutz()), markiert('dienste', diensteKarte),
      markiert('docker', karteDockerFreigabe()), markiert('fahgit', karteFahgit(ctx, t, fmt)), markiert('programm', karteProgramm()), markiert('updates', karteUpdates()), markiert('autoupdates', karteAutoUpdates(ctx, t, fmt)), markiert('platten', karteEnergie()),
      markiert('energie', karteEnergieZusatz(ctx, t, fmt)), markiert('smart', karteSmart()), markiert('pruefungen', kartePruefungen(ctx, t, fmt)), markiert('benachrichtigungen', karteBenachrichtigungen(ctx, t, fmt)),
      markiert('vpn', karteVpn(ctx, t, fmt)), markiert('grafikkarte', karteGpu(ctx, t)), markiert('gehaeuse', karteGehaeuse(ctx, t)), markiert('protokolle', karteProtokolle(ctx, t)), markiert('protokoll', karteProtokoll()),
      markiert('export', karteExportImport()), markiert('strom', karteStrom()), markiert('ueber', ueberKarte));
    const reiter = reiterAufbauen(wurzel, ctx, t);
    wurzel.syReiter = reiter;
    const ersteKarte = wurzel.querySelector('[data-karte]');
    wurzel.insertBefore(reiter.leiste, ersteKarte); wurzel.insertBefore(reiter.unter, ersteKarte);
    reiter.zeigen(ctx.route && ctx.route.teile ? ctx.route.teile[0] : null);
    if (ctx.route && ctx.route.teile && ctx.route.teile[0] && !SYSTEM_REITER.some((r) => r.id === ctx.route.teile[0])) karteAnspringen(wurzel, ctx.route);

    abmelder.push(abo(ctx, 'konfig', (e) => { const d = e && e.daten ? e.daten : e; if (d && d.bereich === 'system') statusNeu(); }));
    abmelder.push(abo(ctx, 'agent', () => statusNeu()));
  },

  /** Gleiche Ansicht, anderes Sprungziel (z. B. zweiter Klick auf eine Kachel). */
  navigieren(route) { reiterUndKarte(document.querySelector('.sy-wurzel'), route); },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
    if (neustartTimer) { clearTimeout(neustartTimer); neustartTimer = null; }
    if (programmTimer) { clearTimeout(programmTimer); programmTimer = null; }
  },
};
