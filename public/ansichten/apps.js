// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Apps“ (Teilprojekt 2, Docker-Katalog): Reiter „Installiert“ (Karten mit Zustand-Ampel, CPU/RAM, Öffnen,
// Start/Stopp/Neustart, Protokoll, Einstellungen, Aktualisieren, Löschen) und „Katalog“ (Suche mit Verzögerung,
// Kategorie-/Quellenfilter, Unraid-Feed laden, Vorlage importieren, Installieren-Dialog mit Feldern je Art, Prüfung
// über apps.pruefen, riskante Rechte einzeln bestätigen, Compose-Vorschau). Rolle nutzer: Liste, Öffnen, Protokoll.
// Ergebnisformen aus docs/schnittstellen.md §11 und dem Apps-Entwurf §3 – tolerant gelesen.
// ZIP-Apps (09.10.): „App aus ZIP“ lädt eine Release-ZIP mit manage.sh hoch (apps.zip.ticket → /api/agent-upload),
// prüft sie (apps.zip.pruefen) und installiert sie (apps.zip.installieren); „Neue ZIP einspielen“ = apps.zip.aktualisieren.
// Aus FAH-Git bauen (26.10.2026): Projekt + Zweig wählen → apps.fahgit.holen (Archiv in den ZIP-Eingang, Prüfung) →
// apps.zip.installieren; Karten zeigen Projekt/Commit, „Aus FAH-Git aktualisieren“ und „automatisch bei neuem Commit“.
// Direktsprung aus FAH-Git: #/apps/fahgit/<projektpfad>/<zweig>.

import {
  el, leeren, stilLaden, eingabe, auswahl, textbereich, feld, schalter, radiogruppe, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel,
  dialogOeffnen, alleDialogeSchliessen, aufgabeStarten, api, fehlerText, istAdmin, melden, bestaetigen, abo, kopfzeile, uebersetzer, formatierer, felderPruefen,
  fortschritt, csrfWert, gebiet
} from './verwaltung-hilfen.js';
import { suchzielAnspringen } from './verwaltung-hilfen.js';
import { dialogUebernahme } from './apps-uebernahme.js';

/** Wie der Agent (apps.installieren): klein, 2–31 Zeichen, a-z 0-9 -, Anfang Buchstabe oder Ziffer */
export const MUSTER_APPNAME = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const SUCHE_VERZOEGERUNG_MS = 300;
export const PRUEFEN_VERZOEGERUNG_MS = 450;
export const KATALOG_JE_SEITE = 48;
export const PROTOKOLL_ZEILEN = Object.freeze([50, 200, 500, 1000]);
const PROTOKOLL_INSTALLATION = '__installation';
export const QUELLEN = Object.freeze(['eingebaut', 'unraid', 'eigen']);
const ZUSTAND_TEXT = Object.freeze({ aktiv: 'apps.zustand_aktiv', inaktiv: 'apps.zustand_inaktiv', warnung: 'apps.zustand_warnung', fehler: 'apps.zustand_fehler', unbekannt: 'apps.zustand_unbekannt' });
const GESUNDHEIT_TEXT = Object.freeze({ healthy: 'apps.gesundheit_healthy', unhealthy: 'apps.gesundheit_unhealthy', starting: 'apps.gesundheit_starting' });
const QUELLE_TEXT = Object.freeze({ eingebaut: 'apps.quelle_eingebaut', unraid: 'apps.quelle_unraid', eigen: 'apps.quelle_eigen' });
const RESSOURCEN_TAKT_MS = 20_000;

let zuletztT = (k) => ({ 'apps.titel': 'Apps' }[k] || k);
let abmelder = [];
let timer = [];
/** Zeitstempel des letzten Unraid-Ladens (aus der Aufgabe), falls die Liste ihn nicht mitliefert */
let unraidStand = null;

// ---------------------------------------------------------------------------------------------------------------
// Reine Helfer (auch für Tests)

/** Ampelfarbe aus Docker-Zustand und Gesundheit: aktiv | inaktiv | warnung | fehler | unbekannt */
export function zustandAmpel(zustand, gesundheit) {
  const z = String(zustand || '').toLowerCase();
  const g = String(gesundheit || '').toLowerCase();
  if (['running', 'laeuft', 'läuft', 'aktiv', 'up'].includes(z)) return g === 'unhealthy' || g === 'starting' ? 'warnung' : 'aktiv';
  // „fehlt“ = keine Container angelegt (A2 docker.zustandZusammenfassen) → wie gestoppt; „teilweise“ = nicht alle laufen
  if (['exited', 'stopped', 'gestoppt', 'inaktiv', 'created', 'aus', 'down', 'fehlt'].includes(z)) return 'inaktiv';
  if (['restarting', 'paused', 'starting', 'neustart', 'pausiert', 'warnung', 'removing', 'teilweise'].includes(z)) return 'warnung';
  if (['dead', 'fehler', 'error', 'failed'].includes(z)) return 'fehler';
  return 'unbekannt';
}

/** App-Name aus der Katalog-ID vorbelegen: klein, nur a-z 0-9 -, 2–31 Zeichen */
export function appNameVorschlag(katalogId) {
  let n = String(katalogId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (n.length > 31) n = n.slice(0, 31).replace(/-+$/g, '');
  if (n.length === 1) n = `${n}-app`;
  return n;
}

/** Liste aus verschiedenen Antwortformen holen: Array | {apps} | {eintraege} | {liste} */
export function listeAus(r, ...schluessel) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') for (const k of [...schluessel, 'eintraege', 'liste']) if (Array.isArray(r[k])) return r[k];
  return [];
}

/** Quellen-Info aus apps.katalog.liste: {eingebaut:{anzahl, zeit}, unraid:{…}, eigen:{…}} – Zahlen oder Objekte */
export function quellenInfo(r) {
  const aus = {};
  const q = r && typeof r === 'object' && r.quellen && typeof r.quellen === 'object' ? r.quellen : {};
  for (const name of QUELLEN) {
    const w = q[name];
    if (w && typeof w === 'object') aus[name] = { anzahl: Number.isFinite(Number(w.anzahl)) ? Number(w.anzahl) : null, zeit: w.zeit || w.stand || null };
    else aus[name] = { anzahl: Number.isFinite(Number(w)) && w !== null && w !== undefined ? Number(w) : null, zeit: null };
  }
  const zeit = r && (r.unraid_zeit || r.unraid_stand || r.zeit_unraid || (r.stand && r.stand.unraid) || (typeof r.unraid_geladen === 'string' ? r.unraid_geladen : null));
  if (zeit && !aus.unraid.zeit) aus.unraid.zeit = zeit;
  // A2 liefert zusätzlich unraid_geladen (Zeit oder false) und unraid_anzahl
  if (r && aus.unraid.anzahl === null && r.unraid_anzahl !== undefined && r.unraid_anzahl !== null && Number.isFinite(Number(r.unraid_anzahl))) aus.unraid.anzahl = Number(r.unraid_anzahl);
  return aus;
}

/** Riskanter Punkt aus apps.pruefen: Text oder Objekt → {kennung, text} */
export function riskantEintrag(r) {
  if (typeof r === 'string') return { kennung: r, text: r };
  if (!r || typeof r !== 'object') return { kennung: String(r), text: String(r) };
  const kennung = r.kennung || r.id || r.code || r.art || r.schluessel || r.text || r.meldung || JSON.stringify(r);
  const text = r.text || r.meldung || r.beschreibung || r.grund || String(kennung);
  return { kennung: String(kennung), text: String(text) };
}

/**
 * Port-Konflikt für ein Feld finden: Konflikte sind Zahlen, Texte oder {feld, port, protokoll, app|belegt_von, vorschlag?}
 * (A2: `{feld, port, protokoll, belegt_von}`). Ohne Vorschlag des Agenten schlägt die Oberfläche den nächsten Port vor.
 */
export function portKonfliktFuer(konflikte, feldName, wert) {
  const port = Number(wert);
  const mit = (p, app, vorschlag) => ({ port: p, app: app || '', vorschlag: vorschlag !== null && vorschlag !== undefined && vorschlag !== '' ? vorschlag : (Number.isFinite(p) && p < 65535 ? p + 1 : null) });
  for (const k of Array.isArray(konflikte) ? konflikte : []) {
    if (k && typeof k === 'object') {
      if (k.feld && k.feld === feldName) return mit(Number(k.port) || port, k.app || k.belegt_von, k.vorschlag ?? k.frei ?? null);
      if (!k.feld && Number(k.port) === port && Number.isFinite(port)) return mit(port, k.app || k.belegt_von, k.vorschlag ?? k.frei ?? null);
    } else if (Number(k) === port && Number.isFinite(port)) return mit(port, '', null);
  }
  return null;
}

/**
 * Rechnername für App-Adressen. Kam die Oberfläche über einen Reverse-Proxy (z. B. https://fah-nas.example über NPM),
 * reicht der nur die Oberfläche weiter – unter seiner Domain gibt es die App-Ports nicht (dort antwortet der Proxy-Rechner).
 * Dann direkt an der Adresse des NAS öffnen, auf der der Proxy ankam (im Heimnetz/VPN erreichbar); sonst der Name aus der
 * Adresszeile. `zugang` = {ueber_proxy, nas_adresse} aus /api/ich.
 */
export function appHost(zugang, hostname) {
  const eigen = hostname || 'localhost';
  const a = zugang && zugang.ueber_proxy ? zugang.nas_adresse : null;
  if (!a || a === '127.0.0.1' || a === '::1') return eigen; // Proxy läuft auf dem NAS selbst: dessen Name gilt
  return a.includes(':') ? `[${a}]` : a;
}

/** WebUI-Adresse: {HOST} durch den Rechnernamen ersetzen (siehe appHost); nur http(s) erlaubt */
export function webuiAufloesen(webui, host) {
  if (!webui || typeof webui !== 'string') return '';
  const url = webui.replace(/\{HOST\}|\[IP\]/g, host || 'localhost').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

/** Pfad-Feld: Wert aus Modus zusammensetzen – App-Ordner (relativ) oder Freigabe (absolut aus freigabe.pfad) */
export function pfadWert({ modus, relativ, freigabePfad, unterordner }) {
  if (modus === 'freigabe') {
    const basis = String(freigabePfad || '').replace(/\/+$/, '');
    const u = String(unterordner || '').replace(/^\/+|\/+$/g, '');
    return u ? `${basis}/${u}` : basis;
  }
  return String(relativ || '').replace(/^\/+|\/+$/g, '');
}

/** Pfad-Feld: bestehenden Wert zerlegen (absolut → Freigabe, sonst App-Ordner) */
export function pfadZerlegen(wert, freigaben = []) {
  const w = String(wert || '');
  if (w.startsWith('/')) {
    const f = [...freigaben].filter((x) => x && x.pfad).sort((a, b) => b.pfad.length - a.pfad.length).find((x) => w === x.pfad || w.startsWith(`${x.pfad.replace(/\/+$/, '')}/`));
    if (f) return { modus: 'freigabe', freigabe: f.name, unterordner: w.slice(f.pfad.replace(/\/+$/, '').length).replace(/^\/+/, ''), relativ: '' };
    const m = /^\/data\/shares\/([^/]+)\/?(.*)$/.exec(w);
    if (m) return { modus: 'freigabe', freigabe: m[1], unterordner: m[2] || '', relativ: '' };
    return { modus: 'freigabe', freigabe: '', unterordner: w, relativ: '' };
  }
  return { modus: 'app', freigabe: '', unterordner: '', relativ: w };
}

export function pfadGueltig(teil) { const t = String(teil || ''); return !t.split('/').some((s) => s === '..') && !/[\u0000-\u001f]/.test(t); }

/** Auswahl-Werte einer Vorlage: Liste aus Texten oder {wert, text} */
export function auswahlOptionen(werte) {
  return (Array.isArray(werte) ? werte : []).map((w) => (w && typeof w === 'object' ? { wert: String(w.wert ?? w.value ?? ''), text: String(w.text ?? w.beschriftung ?? w.wert ?? '') } : { wert: String(w), text: String(w) }));
}

/** Tag eines Image-Namens („ghcr.io/x/y:stable“ → „stable“, ohne Tag „latest“; Port im Registry-Namen zählt nicht). */
function imageTag(image) {
  const s = String(image || '').split('@')[0];
  const i = s.lastIndexOf(':');
  return i > s.lastIndexOf('/') && i >= 0 ? s.slice(i + 1) : 'latest';
}

/** Kennung kurz: „sha256:…“ → die ersten 12 Hex-Zeichen. */
function kennungKurz(d) { return String(d || '').replace(/^sha256:/i, '').slice(0, 12); }

/**
 * Version kurz. Der Agent liefert `{images: {"<image>": "sha256:…"}}` (Digest bzw. Image-ID je Image, siehe apps.liste) –
 * ein Image → „<tag> <12 Zeichen>“, mehrere → „<n> Images“. Texte: Digest (@sha256:…) auf 12 Zeichen kürzen, höchstens 40 Zeichen.
 */
/** „Sichtbar für …“-Text einer App (Plan 07): leere Liste = nur Admins. */
export function sichtbarText(liste, t) {
  const l = Array.isArray(liste) ? liste : [];
  return l.length ? l.join(', ') : t('apps.sichtbar_nur_admins');
}

/** Auswahl für den Sichtbarkeitsdialog: Gruppen (@name) zuerst, dann Nutzer ohne Admin-Rolle (Admins sehen ohnehin alles). */
export function sichtbarAuswahl(nutzer, gruppen, gewaehlt) {
  const g = new Set(Array.isArray(gewaehlt) ? gewaehlt : []);
  const aus = [];
  for (const gr of (Array.isArray(gruppen) ? gruppen : []).map((x) => x && x.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'))) aus.push({ wert: `@${gr}`, text: `@${gr}`, gewaehlt: g.has(`@${gr}`) });
  for (const n of (Array.isArray(nutzer) ? nutzer : []).filter((x) => x && x.name && x.rolle !== 'admin').map((x) => x.name).sort((a, b) => a.localeCompare(b, 'de'))) aus.push({ wert: n, text: n, gewaehlt: g.has(n) });
  return aus;
}

export function versionKurz(v) {
  if (v && typeof v === 'object') {
    const images = Object.entries((v.images && typeof v.images === 'object') ? v.images : {}).filter(([, d]) => d);
    if (!images.length) return '';
    if (images.length > 1) return `${images.length} Images`;
    const [image, d] = images[0];
    return versionKurz(`${imageTag(image)} ${kennungKurz(d)}`);
  }
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /^(.*?)@sha256:([0-9a-f]+)$/i.exec(s);
  const kurz = m ? `${m[1] ? m[1] + ' ' : ''}${m[2].slice(0, 12)}` : s;
  return kurz.length > 40 ? `${kurz.slice(0, 39)}…` : kurz;
}

/** Ausführliche Version für den Tooltip: je Image „<image> <kennung>“ (Objekt vom Agenten) oder der Text selbst. */
export function versionTitel(v) {
  if (v && typeof v === 'object') return Object.entries((v.images && typeof v.images === 'object') ? v.images : {}).filter(([, d]) => d).map(([image, d]) => `${image} ${d}`).join('\n');
  return String(v || '');
}

/** Protokollzeilen aus {zeilen:[…]} | [] | "text" */
export function protokollZeilen(r) {
  if (typeof r === 'string') return r.split('\n');
  const l = listeAus(r, 'zeilen', 'protokoll');
  return l.map((z) => (typeof z === 'string' ? z : z && typeof z === 'object' ? [z.zeit, z.dienst, z.text || z.zeile || z.meldung].filter(Boolean).join(' ') : String(z)));
}

// ---------------------------------------------------------------------------------------------------------------

export default {
  id: 'apps',
  symbol: 'apps',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('apps.titel'); },

  async einbinden(wurzel, ctx) {
    suchzielAnspringen(wurzel, ctx.route); // Suche/„Beheben“: #/apps/ziel/<name>
    stilLaden();
    stilLaden(new URL('./apps.css', import.meta.url).href);
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    const admin = istAdmin(ctx);
    const host = appHost(ctx.zugang, typeof location !== 'undefined' ? location.hostname : '');
    const umgeleitet = typeof location !== 'undefined' && host !== (location.hostname || 'localhost'); // über Proxy-Domain → NAS-Adresse
    leeren(wurzel);
    wurzel.classList.add('ap-wurzel');

    // ---- Reiter -------------------------------------------------------------------------------------------
    const reiterInstalliert = el('button', { typ: 'button', klasse: 'ap-reiter', attr: { role: 'tab', 'aria-selected': 'true', 'aria-controls': 'ap-panel-installiert' }, text: t('apps.reiter_installiert') });
    const reiterKatalog = el('button', { typ: 'button', klasse: 'ap-reiter', attr: { role: 'tab', 'aria-selected': 'false', 'aria-controls': 'ap-panel-katalog' }, text: t('apps.reiter_katalog') });
    const reiterleiste = el('div', { klasse: 'ap-reiterleiste', attr: { role: 'tablist' } }, reiterInstalliert, reiterKatalog);
    const panelInstalliert = el('div', { id: 'ap-panel-installiert', klasse: 'ap-panel', attr: { role: 'tabpanel' } });
    const panelKatalog = el('div', { id: 'ap-panel-katalog', klasse: 'ap-panel', attr: { role: 'tabpanel' } });
    panelKatalog.hidden = true;
    // Katalog nur für Admins (Plan 07): Nicht-Admins installieren nichts und sehen nur freigegebene Apps
    wurzel.append(...[kopfzeile(t('apps.titel'), t(admin ? 'apps.untertitel_admin' : 'apps.untertitel_nutzer')), admin ? reiterleiste : null, panelInstalliert, admin ? panelKatalog : null].filter(Boolean));

    let aktiverReiter = 'installiert';
    function reiterWaehlen(name) {
      aktiverReiter = name;
      const installiert = name === 'installiert';
      reiterInstalliert.setAttribute('aria-selected', installiert ? 'true' : 'false');
      reiterKatalog.setAttribute('aria-selected', installiert ? 'false' : 'true');
      panelInstalliert.hidden = !installiert; panelKatalog.hidden = installiert;
      if (!installiert && !katalogGeladen) ladeKatalog(true);
    }
    reiterInstalliert.addEventListener('click', () => reiterWaehlen('installiert'));
    reiterKatalog.addEventListener('click', () => reiterWaehlen('katalog'));

    // ---- Installierte Apps -----------------------------------------------------------------------------------
    const listeInstalliert = el('div', { klasse: 'ap-liste' });
    if (admin) {
      panelInstalliert.appendChild(el('div', { klasse: 'ap-werkzeuge' },
        el('div', { klasse: 'vw-knopfleiste' }, knopf(t('apps.fg_knopf'), { art: 'zweit', titel: t('apps.fg_kurz'), beiKlick: () => dialogFahgit() }), knopf(t('apps.zip_knopf'), { art: 'zweit', beiKlick: () => dialogZip() }),
          knopf(t('apps.ue_knopf'), { art: 'zweit', titel: t('apps.ue_kurz'), beiKlick: () => dialogUebernahme(ctx, t, fmt, { belegt: apps.map((x) => x.name), nachher: () => ladeApps(true) }) })),
        el('p', { klasse: 'erklaerung', text: t('apps.fg_kurz') }),
        el('p', { klasse: 'erklaerung', text: t('apps.zip_kurz') }),
        el('p', { klasse: 'erklaerung', text: t('apps.ue_kurz') })));
    }
    panelInstalliert.appendChild(listeInstalliert);
    let apps = [];
    let ladeLauf = 0;
    let fgStand = new Map(); // Apps aus FAH-Git: name → {neu, neuer, neu_betreff, fehler}

    async function ladeApps(still = false) {
      const lauf = ++ladeLauf;
      if (!still) { leeren(listeInstalliert); listeInstalliert.appendChild(leerHinweis(t('apps.laden'))); }
      let r;
      try { r = await api(ctx, 'apps.liste', {}); } catch (e) {
        if (lauf !== ladeLauf) return;
        if (still && apps.length) return;
        leeren(listeInstalliert);
        listeInstalliert.appendChild(hinweis(`${t('apps.lade_fehl')} ${fehlerText(e)}`, 'fehler'));
        if (e && (e.code === 'E_NICHT_GEFUNDEN' || e.code === 'E_AGENT')) listeInstalliert.appendChild(el('p', { klasse: 'erklaerung', text: t('apps.nicht_verfuegbar') }));
        return;
      }
      if (lauf !== ladeLauf) return;
      apps = listeAus(r, 'apps');
      reiterInstalliert.textContent = apps.length ? `${t('apps.reiter_installiert')} (${apps.length})` : t('apps.reiter_installiert');
      zeigeApps();
      if (admin && apps.some((a) => a.fahgit)) {
        // Stand in FAH-Git (Agent fragt höchstens jede Minute nach) – kommt nach, die Liste steht schon
        api(ctx, 'apps.fahgit.stand', {}).then((st) => {
          if (lauf !== ladeLauf) return;
          const neu = new Map(listeAus(st, 'apps').map((x) => [x.name, x]));
          const vorher = JSON.stringify([...fgStand]); fgStand = neu;
          if (JSON.stringify([...fgStand]) !== vorher) zeigeApps();
        }).catch(() => {});
      }
    }

    function zeigeApps() {
      leeren(listeInstalliert);
      if (!apps.length) { listeInstalliert.appendChild(leerZustand('apps', t(admin ? 'apps.keine_installiert_admin' : 'apps.keine_installiert_nutzer'), admin ? knopf(t('apps.reiter_katalog'), { art: 'zweit', beiKlick: () => reiterWaehlen('katalog') }) : null)); return; }
      for (const a of apps) listeInstalliert.appendChild(appKarte(a));
    }

    function leerZustand(symbolName, text, ...kinder) {
      const box = el('div', { klasse: 'leer ap-leer' });
      if (typeof ctx.symbol === 'function') { try { box.appendChild(ctx.symbol(symbolName, 'gross')); } catch { /* ohne Symbol */ } }
      box.appendChild(el('p', { klasse: 'leer-text', text }));
      for (const k of kinder) if (k) box.appendChild(k);
      return box;
    }

    /** App-Symbol: <img> von der Quell-URL, bei Ladefehler das eingebaute Apps-Symbol */
    function appSymbol(url, titel) {
      const huelle = el('div', { klasse: 'ap-symbol' });
      const rueckfall = () => { leeren(huelle); huelle.classList.add('ap-symbol-rueckfall'); if (typeof ctx.symbol === 'function') { try { huelle.appendChild(ctx.symbol('apps', 'gross')); return; } catch { /* Text */ } } huelle.appendChild(el('span', { text: String(titel || '?').slice(0, 1).toUpperCase() })); };
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        const img = el('img', { src: url, alt: t('apps.symbol_alt'), attr: { loading: 'lazy', referrerpolicy: 'no-referrer', width: '48', height: '48' } });
        img.addEventListener('error', rueckfall);
        huelle.appendChild(img);
      } else rueckfall();
      return huelle;
    }

    function zustandBadge(a) {
      const z = zustandAmpel(a.zustand, a.gesundheit);
      const g = String(a.gesundheit || '').toLowerCase();
      const text = GESUNDHEIT_TEXT[g] && z !== 'inaktiv' ? `${t(ZUSTAND_TEXT[z])} · ${t(GESUNDHEIT_TEXT[g])}` : t(ZUSTAND_TEXT[z]);
      return el('span', { klasse: `ap-zustand ap-zustand-${z}` }, ampel(z, text), el('span', { text }));
    }

    function appKarte(a) {
      const z = zustandAmpel(a.zustand, a.gesundheit);
      const laeuft = z === 'aktiv' || z === 'warnung';
      const webui = webuiAufloesen(a.webui, host);
      const cpu = Number(a.cpu_prozent); const ram = Number(a.ram_bytes);
      const ressourcen = Number.isFinite(cpu) || Number.isFinite(ram)
        ? t('apps.ressourcen', { cpu: Number.isFinite(cpu) ? `${cpu.toLocaleString(gebiet(), { maximumFractionDigits: 1 })} %` : '–', ram: Number.isFinite(ram) ? fmt.groesse(ram) : '–' })
        : t('apps.ressourcen_unbekannt');
      const ports = Array.isArray(a.ports) ? a.ports.map((p) => (p && typeof p === 'object' ? `${p.port || p.host || ''}${p.protokoll && p.protokoll !== 'tcp' ? '/' + p.protokoll : ''}` : String(p))).filter(Boolean) : [];
      const badges = el('div', { klasse: 'vw-badges ap-badges' });
      if (a.autostart) badges.appendChild(badge(t('apps.autostart_kurz'), t('apps.autostart_titel'), 'akzent'));
      const version = versionKurz(a.version);
      if (version) badges.appendChild(badge(t('apps.version', { version }), versionTitel(a.version)));
      const istUebernommen = !!a.uebernommen;
      const istFahgit = !!a.fahgit && !istUebernommen;
      const istZip = a.art === 'zip' && !istUebernommen && !istFahgit;
      if (istUebernommen) badges.appendChild(badge(t('apps.ue_badge'), t('apps.ue_badge_titel', { quelle: a.uebernommen.quelle || '?', ordner: a.uebernommen.ordner || '–' })));
      if (istZip) badges.appendChild(badge(t('apps.zip_badge'), a.zip && a.zip.datei ? t('apps.zip_badge_titel', { datei: a.zip.datei, zeit: a.zip.eingespielt ? fmt.zeit(a.zip.eingespielt) : '–' }) : undefined));
      const fg = istFahgit ? fgStand.get(a.name) : null;
      if (istFahgit) {
        badges.appendChild(badge(t('apps.fg_badge', { zweig: a.fahgit.zweig, commit: String(a.fahgit.commit || '').slice(0, 7) }),
          t('apps.fg_badge_titel', { pfad: a.fahgit.pfad, betreff: a.fahgit.betreff || '–', zeit: a.fahgit.eingespielt ? fmt.zeit(a.fahgit.eingespielt) : '–' })));
        if (a.fahgit.auto) badges.appendChild(badge(t('apps.fg_auto_badge'), t('apps.fg_auto_titel'), 'akzent'));
        if (fg && fg.neuer) badges.appendChild(badge(t('apps.fg_neu_badge'), t('apps.fg_neu_titel', { commit: String(fg.neu || '').slice(0, 7), betreff: fg.neu_betreff || '–' }), 'warnung'));
        if (fg && fg.fehler) badges.appendChild(badge(t('apps.fg_fehler_badge'), fg.fehler, 'gefahr'));
      }
      if (a.angepasst) badges.appendChild(badge(t('apps.angepasst'), t('apps.angepasst_titel')));
      if (a.portkonflikt) badges.appendChild(badge(t('apps.portkonflikt'), a.portkonflikt, 'warnung'));

      const knoepfe = el('div', { klasse: 'vw-knopfleiste ap-knoepfe' });
      if (webui) knoepfe.appendChild(el('a', { klasse: 'knopf ap-oeffnen', href: webui, target: '_blank', rel: 'noopener noreferrer', text: t('apps.oeffnen'), attr: { title: umgeleitet ? t('apps.oeffnen_heimnetz', { adresse: host }) : t('apps.oeffnen_titel') } }));
      if (admin) {
        knoepfe.appendChild(laeuft ? knopf(t('apps.stopp'), { art: 'zweit', beiKlick: () => steuern(a, 'stopp') }) : knopf(t('apps.start'), { art: 'zweit', beiKlick: () => steuern(a, 'start') }));
        if (laeuft) knoepfe.appendChild(knopf(t('apps.neustart'), { art: 'zweit', beiKlick: () => steuern(a, 'neustart') }));
      }
      if (admin) {
        knoepfe.appendChild(knopf(t('apps.protokoll'), { art: 'zweit', beiKlick: () => dialogProtokoll(a) }));
        const sichtbarKnopf = knopf(t('apps.sichtbar_knopf'), { art: 'zweit', beiKlick: () => dialogSichtbarkeit(a) });
        sichtbarKnopf.setAttribute('data-aktion', 'sichtbarkeit');
        knoepfe.appendChild(sichtbarKnopf);
        knoepfe.appendChild(knopf(t('apps.bearbeiten'), { art: 'zweit', beiKlick: () => dialogBearbeiten(a) }));
        if (istFahgit) {
          knoepfe.appendChild(knopf(t('apps.fg_aktualisieren'), { art: fg && fg.neuer ? 'haupt' : 'zweit', titel: t('apps.fg_aktualisieren_titel'), beiKlick: () => fahgitAktualisieren(a) }));
          knoepfe.appendChild(knopf(t('apps.fg_einstellungen'), { art: 'zweit', beiKlick: () => dialogFahgitEinstellungen(a) }));
        } else {
          knoepfe.appendChild(istZip
            ? knopf(t('apps.zip_neu'), { art: 'zweit', beiKlick: () => dialogZip(a) })
            : knopf(t('apps.aktualisieren'), { art: 'zweit', beiKlick: () => aktualisieren(a) }));
        }
        knoepfe.appendChild(knopf(t('apps.loeschen'), { art: 'gefahr', beiKlick: () => dialogLoeschen(a) }));
      }
      return el('section', { klasse: `karte vw-karte ap-karte ap-karte-${z}`, daten: { app: a.name, suchziel: a.name } },
        el('div', { klasse: 'ap-kopf' },
          appSymbol(a.symbol, a.titel || a.name),
          el('div', { klasse: 'ap-kopf-text' },
            el('h2', { klasse: 'ap-titel', text: a.titel || a.name }),
            el('p', { klasse: 'ap-name vw-mono vw-gedaempft', text: a.name }),
            zustandBadge(a))),
        badges.childNodes.length ? badges : null,
        el('p', { klasse: 'ap-ressourcen vw-gedaempft', text: ressourcen }),
        ports.length ? el('p', { klasse: 'ap-ports vw-gedaempft', text: t('apps.ports', { liste: ports.join(', ') }) }) : null,
        a.portkonflikt && admin ? el('p', { klasse: 'ap-portkonflikt' }, el('span', { text: `${a.portkonflikt}. ` }), knopf(t('apps.bearbeiten_portkonflikt'), { art: 'zweit', klein: true, beiKlick: () => dialogBearbeiten(a) })) : null,
        a.aktualisiert ? el('p', { klasse: 'ap-aktualisiert vw-gedaempft', text: t('apps.aktualisiert_am', { zeit: fmt.zeit(a.aktualisiert) }) }) : null,
        admin ? el('p', { klasse: 'ap-sichtbar vw-gedaempft', text: t('apps.sichtbar_fuer', { liste: sichtbarText(a.sichtbar_fuer, t) }) }) : null,
        knoepfe);
    }

    /** Wer darf die App sehen? (Plan 07) – Kontrollkästchen für Gruppen und Nutzer ohne Admin-Rolle. */
    async function dialogSichtbarkeit(a) {
      let nutzer = []; let gruppen = [];
      try { [nutzer, gruppen] = await Promise.all([api(ctx, 'nutzer.liste', {}), api(ctx, 'nutzer.gruppen', {})]); } catch (e) { melden(ctx, `${t('apps.lade_fehl')} ${fehlerText(e)}`, 'fehler'); return; }
      const auswahl = sichtbarAuswahl(listeAus(nutzer, 'nutzer'), listeAus(gruppen, 'gruppen'), a.sichtbar_fuer);
      const kaesten = auswahl.map((o) => { const k = el('input', { typ: 'checkbox', attr: { value: o.wert } }); k.value = o.wert; k.checked = o.gewaehlt; return k; });
      const liste = el('ul', { klasse: 'ap-sichtbar-liste' }, ...auswahl.map((o, i) => el('li', {}, el('label', {}, kaesten[i], el('span', { text: o.text })))));
      const inhalt = el('div', { klasse: 'ap-sichtbar-dialog' },
        el('p', { klasse: 'erklaerung', text: t('apps.sichtbar_erklaerung') }),
        auswahl.length ? liste : el('p', { klasse: 'vw-gedaempft', text: t('apps.sichtbar_keine_nutzer') }),
        el('p', { klasse: 'hinweis hinweis-info', text: t('apps.sichtbar_grenze') }));
      const griff = dialogOeffnen({ ctx, titel: t('apps.sichtbar_titel', { name: a.titel || a.name }), inhalt, knoepfe: [{
        text: t('apps.sichtbar_speichern'),
        beiKlick: async (g) => {
          g.beschaeftigt(true);
          try {
            const r = await api(ctx, 'apps.sichtbarkeit', { name: a.name, sichtbar_fuer: kaesten.filter((k) => k.checked).map((k) => k.value) });
            a.sichtbar_fuer = (r && r.sichtbar_fuer) || a.sichtbar_fuer;
            melden(ctx, t('apps.sichtbar_gespeichert'), 'erfolg');
            g.schliessen();
            ladeApps(true);
          } catch (e) { g.beschaeftigt(false); melden(ctx, `${t('apps.lade_fehl')} ${fehlerText(e)}`, 'fehler'); }
        },
      }] });
      if (griff && griff.knoepfe && griff.knoepfe[0]) griff.knoepfe[0].setAttribute('data-aktion', 'sichtbar-speichern');
    }

    async function steuern(a, aktion) {
      try {
        await api(ctx, 'apps.steuern', { name: a.name, aktion });
        melden(ctx, t(aktion === 'start' ? 'apps.gestartet' : aktion === 'stopp' ? 'apps.gestoppt' : 'apps.neugestartet', { name: a.name }), 'erfolg');
      } catch (e) { melden(ctx, t('apps.steuern_fehl', { name: a.name, meldung: fehlerText(e) }), 'fehler'); }
      await ladeApps(true);
    }

    async function aktualisieren(a) {
      try {
        const r = await aufgabeStarten(ctx, 'apps.aktualisieren', { name: a.name }, aufgabenTexte(t('apps.aktualisieren_titel', { name: a.name }), t('apps.aktualisieren_laeuft')));
        // A2: {alt:{image:digest}, neu:{…}, geaendert:[image…], neustart, warnungen, hinweis}; ältere Form: alt/neu als Text
        let text;
        if (r && Array.isArray(r.geaendert)) text = r.geaendert.length ? t('apps.aktualisiert_images', { name: a.name, n: r.geaendert.length }) : t('apps.aktualisiert_keine', { name: a.name });
        else if (r && (typeof r.alt === 'string' || typeof r.neu === 'string')) text = t('apps.aktualisiert_meldung', { name: a.name, alt: r.alt || '–', neu: r.neu || '–' });
        else text = t('apps.aktualisiert_ohne', { name: a.name });
        melden(ctx, text, 'erfolg');
        if (r && typeof r.hinweis === 'string' && r.hinweis) melden(ctx, r.hinweis, 'info');
      } catch { /* im Aufgabendialog gezeigt */ }
      await ladeApps(true);
    }

    function aufgabenTexte(titel, meldung) {
      return { titel, meldung, abbrechen: t('apps.aufgabe_abbrechen'), schliessen: t('apps.schliessen'), fehler: (m) => t('apps.aufgabe_fehl', { meldung: m }), abgebrochen: t('apps.aufgabe_abgebrochen') };
    }

    // ---- Protokoll ------------------------------------------------------------------------------------------------
    function dialogProtokoll(a) {
      const zeilenWahl = auswahl({ optionen: PROTOKOLL_ZEILEN.map((n) => ({ wert: String(n), text: String(n) })), wert: '200', klasse: 'ap-zeilenwahl' });
      // Dienst-Auswahl erscheint, sobald der Agent mehrere Dienste (Container) der App meldet
      const dienstWahl = auswahl({ optionen: [{ wert: '', text: t('apps.protokoll_dienst_alle') }], klasse: 'ap-dienstwahl' });
      const dienstFeld = feld({ label: t('apps.protokoll_dienst'), erklaerung: t('apps.protokoll_dienst_erklaerung'), eingabe: dienstWahl }); dienstFeld.hidden = true;
      const ausgabe = el('pre', { klasse: 'ap-protokoll vw-mono', attr: { tabindex: '0', 'aria-live': 'polite' } });
      const fz = fehlerzeile();
      const nachladen = knopf(t('apps.protokoll_nachladen'), { art: 'zweit', beiKlick: () => laden() });
      const inhalt = el('div', { klasse: 'ap-protokoll-dialog' },
        el('div', { klasse: 'vw-zeile ap-protokoll-leiste' }, feld({ label: t('apps.protokoll_zeilen'), erklaerung: t('apps.protokoll_zeilen_erklaerung'), eingabe: zeilenWahl }), dienstFeld, el('div', { klasse: 'vw-feld ap-knopf-feld' }, nachladen)),
        fz.element, ausgabe);
      const griff = dialogOeffnen({ ctx, titel: t('apps.protokoll_titel', { name: a.name }), inhalt, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() }] });
      zeilenWahl.addEventListener('change', () => laden());
      dienstWahl.addEventListener('change', () => laden());
      async function laden() {
        fz.leeren(); nachladen.disabled = true; ausgabe.textContent = t('apps.protokoll_laden');
        try {
          const params = { name: a.name, zeilen: Number(zeilenWahl.value) || 200 };
          if (dienstWahl.value === PROTOKOLL_INSTALLATION) params.installation = true;
          else if (dienstWahl.value) params.dienst = dienstWahl.value;
          const r = await api(ctx, 'apps.protokoll', params);
          const dienste = r && Array.isArray(r.dienste) ? r.dienste.map(String).filter(Boolean) : [];
          const mitInstallation = Boolean(r && r.installation_vorhanden);
          if ((dienste.length > 1 || mitInstallation) && dienstWahl.childNodes.length === 1) {
            if (dienste.length > 1) for (const d of dienste) dienstWahl.appendChild(el('option', { wert: d, text: d }));
            if (mitInstallation) dienstWahl.appendChild(el('option', { wert: PROTOKOLL_INSTALLATION, text: t('apps.protokoll_installation') }));
            dienstFeld.hidden = false;
          }
          const zeilen = protokollZeilen(r);
          ausgabe.textContent = zeilen.length ? zeilen.join('\n') : t('apps.protokoll_leer');
          ausgabe.scrollTop = ausgabe.scrollHeight;
        } catch (e) { ausgabe.textContent = ''; fz.zeigen(`${t('apps.protokoll_fehl')} ${fehlerText(e)}`); } finally { nachladen.disabled = false; }
      }
      laden();
      void griff;
    }

    // ---- Löschen ---------------------------------------------------------------------------------------------------
    function dialogLoeschen(a) {
      const form = el('form', { attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const wahl = radiogruppe({ wert: 'behalten', optionen: [
        { wert: 'behalten', text: t('apps.loeschen_behalten'), erklaerung: t('apps.loeschen_behalten_erklaerung', { name: a.name }) },
        { wert: 'loeschen', text: t('apps.loeschen_loeschen'), erklaerung: t('apps.loeschen_loeschen_erklaerung') },
      ] });
      const tipp = eingabe({ maxlength: 32, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      tipp.setAttribute('autocapitalize', 'none');
      form.append(...[el('p', { text: t('apps.loeschen_erklaerung') }), a.uebernommen ? hinweis(t('apps.ue_loeschen_hinweis', { ordner: a.uebernommen.ordner || '–' }), 'info') : null, el('div', { klasse: 'vw-feld' }, wahl.element),
        feld({ label: t('apps.loeschen_tippen'), erklaerung: t('apps.loeschen_tippen_erklaerung', { name: a.name }), eingabe: tipp }), fz.element].filter(Boolean));
      const griff = dialogOeffnen({ ctx, titel: t('apps.loeschen_titel', { name: a.name }), inhalt: form, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.loeschen_knopf'), art: 'gefahr', absenden: true, deaktiviert: true }] });
      const loeschKnopf = griff.knoepfe[1];
      tipp.addEventListener('input', () => { loeschKnopf.disabled = tipp.value.trim() !== a.name; });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (tipp.value.trim() !== a.name) return;
        griff.beschaeftigt(true);
        try {
          const r = await aufgabeStarten(ctx, 'apps.loeschen', { name: a.name, daten: wahl.wert() || 'behalten' }, aufgabenTexte(t('apps.loeschen_titel', { name: a.name }), t('apps.loeschen_laeuft')));
          const frei = r && Number(r.frei_bytes) > 0 ? Number(r.frei_bytes) : 0;
          melden(ctx, frei ? t('apps.geloescht_frei', { name: a.name, groesse: fmt.groesse(frei) }) : t('apps.geloescht', { name: a.name }), 'erfolg');
          griff.schliessen();
          await ladeApps(true);
        } catch (e) { griff.beschaeftigt(false); loeschKnopf.disabled = false; if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); }
      });
    }

    // ---- Felder einer Vorlage (Installieren + Einstellungen) --------------------------------------------------------
    /**
     * Baut die Feld-Elemente einer Vorlage. Gibt {element, werte(), setzeKonflikte(konflikte), pruefen(fz)} zurück.
     * `vorhanden` = bestehende Werte (Einstellungen), `geheimnisLeerErlaubt` = leere Passwörter bleiben unverändert.
     */
    function felderBauen(felder, vorhanden, { geheimnisLeerErlaubt = false, beiAenderung } = {}) {
      const element = el('div', { klasse: 'ap-felder' });
      const eintraege = [];
      let freigaben = null; let freigabenLaden = null;
      const freigabenHolen = () => {
        if (!freigabenLaden) freigabenLaden = api(ctx, 'freigaben.liste', {}).then((r) => { freigaben = listeAus(r, 'freigaben'); return freigaben; }).catch((e) => { freigaben = null; throw e; });
        return freigabenLaden;
      };
      const melde = () => { if (beiAenderung) beiAenderung(); };
      if (!Array.isArray(felder) || !felder.length) element.appendChild(leerHinweis(t('apps.felder_keine')));
      for (const f of Array.isArray(felder) ? felder : []) {
        if (!f || !f.name) continue;
        const art = String(f.art || 'variable');
        const wert = vorhanden && f.name in vorhanden ? vorhanden[f.name] : f.standard;
        const label = f.beschriftung || f.name;
        const erklaerung = f.erklaerung || f.beschreibung || '';
        const eintrag = { feld: f, art };
        if (art === 'port') {
          const e = eingabe({ typ: 'number', wert: wert ?? '', min: 1, max: 65535, schritt: 1, inputmode: 'numeric', klasse: 'ap-port' });
          const konflikt = el('p', { klasse: 'feld-fehler ap-konflikt' }); konflikt.hidden = true;
          e.addEventListener('input', melde);
          eintrag.eingabe = e; eintrag.konflikt = konflikt;
          eintrag.wert = () => (e.value === '' ? '' : Number(e.value));
          eintrag.pruefen = () => (e.value === '' || (Number.isInteger(Number(e.value)) && Number(e.value) >= 1 && Number(e.value) <= 65535) ? null : t('apps.feld_port_fehler'));
          element.appendChild(feld({ label, erklaerung: erklaerung || t('apps.feld_port_erklaerung'), eingabe: e, hinweisElement: konflikt }));
        } else if (art === 'pfad') {
          const zerlegt = pfadZerlegen(wert, []);
          const relativ = eingabe({ wert: zerlegt.relativ || (typeof f.standard === 'string' && !f.standard.startsWith('/') ? f.standard : 'daten'), maxlength: 200, spellcheck: false, klasse: 'vw-mono' });
          const freigabeWahl = auswahl({ optionen: [], klasse: 'ap-freigabewahl' });
          const unterordner = eingabe({ wert: zerlegt.unterordner, maxlength: 200, spellcheck: false, platzhalter: t('apps.pfad_unterordner_platzhalter'), klasse: 'vw-mono' });
          const freigabeHinweis = el('p', { klasse: 'erklaerung ap-freigabe-hinweis' });
          const unterWaehlen = knopf(`📁 ${t('apps.ordner_waehlen')}`, { art: 'zweit', klein: true, beiKlick: async () => {
            const fr = (freigaben || []).find((x) => x.name === freigabeWahl.value);
            if (!fr) return;
            const wurzel = fr.pfad || `/data/shares/${fr.name}`;
            const gew = await ordnerWaehlen(null, unterordner.value.trim() ? `${wurzel}/${unterordner.value.trim().replace(/^\/+/, '')}` : wurzel);
            if (gew && (gew === wurzel || gew.startsWith(`${wurzel}/`))) { unterordner.value = gew.slice(wurzel.length).replace(/^\/+/, ''); melde(); }
          } });
          const bereichApp = el('div', { klasse: 'ap-pfad-app' }, relativ);
          const bereichFreigabe = el('div', { klasse: 'ap-pfad-freigabe' }, freigabeWahl, el('label', { klasse: 'vw-label ap-unterordner-label', fuer: unterordner.id, text: t('apps.pfad_unterordner') }), unterordner, unterWaehlen, freigabeHinweis);
          const modus = radiogruppe({ wert: zerlegt.modus, optionen: [
            { wert: 'app', text: t('apps.pfad_app'), erklaerung: t('apps.pfad_app_erklaerung', { name: '<name>' }) },
            { wert: 'freigabe', text: t('apps.pfad_freigabe'), erklaerung: t('apps.pfad_freigabe_erklaerung') },
          ], beiWechsel: (m) => { umschalten(m); melde(); } });
          // Die Freigabenliste wird je Dialog einmal geladen (geteilte Zusage), aber jedes Pfadfeld füllt seine Auswahl selbst.
          let gefuellt = false;
          const umschalten = (m) => { bereichApp.hidden = m !== 'app'; bereichFreigabe.hidden = m !== 'freigabe'; if (m === 'freigabe' && !gefuellt) freigabenFuellen(); };
          const freigabenFuellen = async () => {
            gefuellt = true;
            freigabeHinweis.textContent = t('apps.pfad_freigaben_laden');
            try {
              const liste = await freigabenHolen();
              leeren(freigabeWahl);
              for (const fr of liste) freigabeWahl.appendChild(el('option', { wert: fr.name, text: fr.name }));
              freigabeHinweis.textContent = liste.length ? '' : t('apps.pfad_keine_freigaben');
              const wieder = pfadZerlegen(wert, liste);
              if (wieder.modus === 'freigabe' && wieder.freigabe) { freigabeWahl.value = wieder.freigabe; unterordner.value = wieder.unterordner; }
            } catch { gefuellt = false; freigabeHinweis.textContent = t('apps.pfad_freigaben_fehl'); }
          };
          relativ.addEventListener('input', melde); unterordner.addEventListener('input', melde); freigabeWahl.addEventListener('change', melde);
          umschalten(zerlegt.modus);
          eintrag.eingabe = relativ;
          eintrag.wert = () => {
            if (modus.wert() === 'freigabe') {
              const fr = (freigaben || []).find((x) => x.name === freigabeWahl.value);
              return pfadWert({ modus: 'freigabe', freigabePfad: fr ? fr.pfad : `/data/shares/${freigabeWahl.value}`, unterordner: unterordner.value });
            }
            return pfadWert({ modus: 'app', relativ: relativ.value });
          };
          eintrag.pruefen = () => {
            if (modus.wert() === 'freigabe') return freigabeWahl.value && pfadGueltig(unterordner.value) ? null : t(freigabeWahl.value ? 'apps.pfad_fehler' : 'apps.pfad_keine_freigaben');
            return relativ.value.trim() && pfadGueltig(relativ.value) ? null : t('apps.pfad_fehler');
          };
          const modusText = f.modus === 'ro' || f.modus === 'lesen' || f.nur_lesen === true ? ` (${t('apps.modus_ro')})` : '';
          element.appendChild(el('div', { klasse: 'feld vw-feld ap-pfadfeld' },
            el('span', { klasse: 'feld-beschriftung vw-label', text: `${label}${modusText}` }),
            modus.element, bereichApp, bereichFreigabe,
            erklaerung ? el('p', { klasse: 'erklaerung', text: erklaerung }) : null));
        } else if (art === 'geheimnis') {
          const e = eingabe({ typ: 'password', wert: geheimnisLeerErlaubt ? '' : (wert ?? ''), autocomplete: 'new-password', maxlength: 512 });
          e.addEventListener('input', melde);
          eintrag.eingabe = e; eintrag.wert = () => e.value; eintrag.leerLassen = geheimnisLeerErlaubt;
          eintrag.pruefen = () => (f.pflicht && !geheimnisLeerErlaubt && !e.value ? t('apps.feld_pflicht', { feld: label }) : null);
          element.appendChild(feld({ label, erklaerung: geheimnisLeerErlaubt ? `${erklaerung} ${t('apps.geheimnis_leer_erklaerung')}`.trim() : erklaerung, eingabe: e }));
        } else if (art === 'auswahl') {
          const optionen = auswahlOptionen(f.werte || f.optionen);
          const e = auswahl({ optionen, wert: wert ?? (optionen[0] ? optionen[0].wert : '') });
          e.addEventListener('change', melde);
          eintrag.eingabe = e; eintrag.wert = () => e.value; eintrag.pruefen = () => null;
          element.appendChild(feld({ label, erklaerung, eingabe: e }));
        } else if (art === 'schalter') {
          const an = wert === true || wert === 'true' || wert === 1 || wert === '1' || wert === 'ja';
          const s = schalter({ label, erklaerung, wert: an, beiWechsel: melde });
          eintrag.eingabe = s.eingabe; eintrag.wert = () => s.eingabe.checked; eintrag.pruefen = () => null;
          element.appendChild(s.element);
        } else {
          const e = eingabe({ wert: wert ?? '', maxlength: 1024 });
          e.addEventListener('input', melde);
          eintrag.eingabe = e; eintrag.wert = () => e.value; eintrag.pruefen = () => null;
          element.appendChild(feld({ label, erklaerung, eingabe: e }));
        }
        eintraege.push(eintrag);
      }
      return {
        element,
        eintraege,
        werte() {
          const w = {};
          for (const e of eintraege) { const v = e.wert(); if (e.leerLassen && v === '') continue; w[e.feld.name] = v; }
          return w;
        },
        pruefen(fz) { return felderPruefen(eintraege.filter((e) => e.eingabe).map((e) => ({ eingabe: e.eingabe, pruefen: () => e.pruefen() })), fz); },
        setzeKonflikte(konflikte) {
          let anzahl = 0;
          for (const e of eintraege) {
            if (e.art !== 'port') continue;
            const k = portKonfliktFuer(konflikte, e.feld.name, e.wert());
            leeren(e.konflikt);
            if (!k) { e.konflikt.hidden = true; e.eingabe.setAttribute('aria-invalid', 'false'); continue; }
            anzahl++;
            e.eingabe.setAttribute('aria-invalid', 'true'); e.konflikt.hidden = false;
            e.konflikt.appendChild(el('span', { text: t('apps.port_konflikt', { port: k.port, app: k.app ? t('apps.port_konflikt_app', { app: k.app }) : '' }) }));
            if (k.vorschlag !== null && k.vorschlag !== undefined && k.vorschlag !== '') {
              e.konflikt.appendChild(el('span', { text: ` ${t('apps.port_vorschlag', { port: k.vorschlag })} ` }));
              e.konflikt.appendChild(knopf(t('apps.port_vorschlag_uebernehmen'), { art: 'zweit', klein: true, beiKlick: () => { e.eingabe.value = String(k.vorschlag); melde(); } }));
            }
          }
          return anzahl;
        },
      };
    }

    /** Prüfbereich (apps.pruefen): Warnungen, Hinweise der Vorlage, riskante Punkte (nach Kennung/Art gruppiert) mit Bestätigung, Compose-Vorschau. */
    function pruefbereichBauen({ vorbestaetigt } = {}) {
      const status = el('p', { klasse: 'ap-pruefstatus vw-gedaempft' });
      const warnungen = el('div', { klasse: 'ap-warnungen' });
      const riskantBox = el('div', { klasse: 'ap-riskant' }); riskantBox.hidden = true;
      const riskantListe = el('div', {});
      riskantBox.append(el('h3', { klasse: 'ap-untertitel vw-rot', text: t('apps.riskant') }), el('p', { klasse: 'erklaerung', text: t('apps.riskant_erklaerung') }), riskantListe);
      // keine Compose-Vorschau mehr (Betreiber 12.10.2026) – Ports, Pfade und Variablen ändert „Bearbeiten“ einfach und lesbar
      const element = el('div', { klasse: 'ap-pruefbereich' }, status, warnungen, riskantBox);
      const bestaetigt = new Set(Array.isArray(vorbestaetigt) ? vorbestaetigt.map(String) : []);
      let riskant = [];
      const textVon = (w) => (typeof w === 'string' ? w : (w && (w.text || w.meldung)) || JSON.stringify(w));
      return {
        element,
        laeuft() { status.textContent = t('apps.pruefen_laeuft'); status.classList.remove('vw-rot'); },
        fehler(meldung) { status.textContent = t('apps.pruefen_fehl', { meldung }); status.classList.add('vw-rot'); },
        zeigen(r, konfliktAnzahl) {
          status.classList.remove('vw-rot');
          status.textContent = konfliktAnzahl ? '' : t('apps.pruefen_ok');
          leeren(warnungen);
          const warn = r && Array.isArray(r.warnungen) ? r.warnungen : [];
          const hin = r && Array.isArray(r.hinweise) ? r.hinweise : [];
          if (warn.length) warnungen.appendChild(el('h3', { klasse: 'ap-untertitel', text: t('apps.warnungen') }));
          for (const w of warn) warnungen.appendChild(hinweis(textVon(w), 'warnung'));
          if (hin.length) warnungen.appendChild(el('h3', { klasse: 'ap-untertitel', text: t('apps.hinweise') }));
          for (const w of hin) warnungen.appendChild(hinweis(textVon(w), 'info'));
          riskant = listeAus(r, 'riskant').map(riskantEintrag);
          leeren(riskantListe);
          riskantBox.hidden = !riskant.length;
          // A2 liefert je Dienst/Wert einen Eintrag mit derselben `art`; bestätigt wird die Art – ein Schalter je Art, weitere Texte darunter
          const gruppen = new Map();
          for (const p of riskant) { if (!gruppen.has(p.kennung)) gruppen.set(p.kennung, []); if (!gruppen.get(p.kennung).includes(p.text)) gruppen.get(p.kennung).push(p.text); }
          for (const [kennung, texte] of gruppen) {
            const s = schalter({ label: texte[0], erklaerung: t('apps.riskant_bestaetigen'), wert: bestaetigt.has(kennung), beiWechsel: (an) => { if (an) bestaetigt.add(kennung); else bestaetigt.delete(kennung); } });
            s.element.classList.add('ap-riskant-punkt');
            riskantListe.appendChild(s.element);
            for (const weitere of texte.slice(1)) riskantListe.appendChild(el('p', { klasse: 'erklaerung ap-riskant-weitere', text: weitere }));
          }
        },
        alleBestaetigt() { return riskant.every((p) => bestaetigt.has(p.kennung)); },
        bestaetigte() { return [...new Set(riskant.filter((p) => bestaetigt.has(p.kennung)).map((p) => p.kennung))]; },
      };
    }

    // ---- Installieren -------------------------------------------------------------------------------------------------
    async function dialogInstallieren(eintrag) {
      const inhalt = el('div', {}, leerHinweis(t('apps.installieren_laden')));
      const griff = dialogOeffnen({ ctx, titel: t('apps.installieren_titel', { name: eintrag.name || eintrag.id }), inhalt, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.installieren_knopf'), absenden: true, deaktiviert: true }] });
      const installKnopf = griff.knoepfe[1];
      let vorlage;
      try { vorlage = await api(ctx, 'apps.katalog.eintrag', { id: eintrag.id }); } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(`${t('apps.installieren_fehl')} ${fehlerText(e)}`, 'fehler')); return; }
      vorlage = vorlage && typeof vorlage === 'object' ? vorlage : eintrag;
      const form = el('form', { klasse: 'ap-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const name = eingabe({ wert: appNameVorschlag(vorlage.id || eintrag.id), maxlength: 31, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      name.setAttribute('autocapitalize', 'none');
      const nameHinweis = el('p', { klasse: 'feld-fehler ap-konflikt' }); nameHinweis.hidden = true;
      const felder = felderBauen(vorlage.felder, null, { beiAenderung: () => pruefenVerzoegert() });
      const autostart = schalter({ label: t('apps.autostart'), erklaerung: t('apps.autostart_erklaerung'), wert: true });
      const pruef = pruefbereichBauen();
      form.append(fz.element,
        el('div', { klasse: 'ap-vorlage-kopf' }, appSymbol(vorlage.symbol || eintrag.symbol, vorlage.name), el('p', { klasse: 'ap-vorlage-beschreibung', text: vorlage.beschreibung || eintrag.beschreibung || t('apps.beschreibung_fehlt') })),
        feld({ label: t('apps.name'), erklaerung: t('apps.name_erklaerung'), eingabe: name, hinweisElement: nameHinweis }),
        felder.element, autostart.element, pruef.element);
      leeren(inhalt); inhalt.appendChild(form);
      // Der Rahmen-Dialog reicht Enter im Formular an submit weiter; der Knopf im Fuß löst requestSubmit nur bei <form>-Inhalt aus – hier ist der Inhalt ein <div>, deshalb selbst verdrahten.
      installKnopf.addEventListener('click', () => form.requestSubmit());
      installKnopf.disabled = false;

      let pruefTimer = null; let pruefLauf = 0; let letzteKonflikte = 0;
      const pruefenVerzoegert = () => { clearTimeout(pruefTimer); pruefTimer = setTimeout(pruefen, PRUEFEN_VERZOEGERUNG_MS); };
      abmelder.push(() => clearTimeout(pruefTimer));
      name.addEventListener('input', pruefenVerzoegert);
      async function pruefen() {
        const n = name.value.trim();
        if (!MUSTER_APPNAME.test(n)) return;
        const lauf = ++pruefLauf;
        pruef.laeuft();
        try {
          const r = await api(ctx, 'apps.pruefen', { katalog_id: vorlage.id || eintrag.id, name: n, werte: felder.werte() });
          if (lauf !== pruefLauf) return;
          letzteKonflikte = felder.setzeKonflikte(r && Array.isArray(r.port_konflikte) ? r.port_konflikte : listeAus(r, 'konflikte'));
          pruef.zeigen(r, letzteKonflikte);
          // A2: name_frei:false = eine App mit diesem Namen gibt es schon
          const vergeben = !!r && r.name_frei === false;
          nameHinweis.hidden = !vergeben; nameHinweis.textContent = vergeben ? t('apps.name_vergeben', { name: n }) : '';
          name.setAttribute('aria-invalid', vergeben ? 'true' : 'false');
        } catch (e) { if (lauf === pruefLauf) pruef.fehler(fehlerText(e)); }
      }
      pruefen();

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const n = name.value.trim();
        if (!felderPruefen([{ eingabe: name, pruefen: (w) => (MUSTER_APPNAME.test(w.trim()) ? null : t('apps.name_fehler')) }], fz)) return;
        if (!nameHinweis.hidden) { fz.zeigen(t('apps.name_vergeben', { name: n })); name.focus(); return; }
        if (!felder.pruefen(fz)) return;
        if (!pruef.alleBestaetigt()) { fz.zeigen(t('apps.riskant_offen')); return; }
        griff.beschaeftigt(true);
        try {
          const params = { katalog_id: vorlage.id || eintrag.id, name: n, werte: felder.werte(), autostart: autostart.eingabe.checked };
          const bestaetigt = pruef.bestaetigte();
          if (bestaetigt.length) params.bestaetigt_riskant = bestaetigt;
          const r = await aufgabeStarten(ctx, 'apps.installieren', params, aufgabenTexte(t('apps.installieren_titel', { name: n }), t('apps.installieren_laeuft')));
          const webui = webuiAufloesen(r && r.webui, host);
          melden(ctx, webui ? t('apps.installiert_offen', { name: n, webui }) : t('apps.installiert', { name: n }), 'erfolg');
          griff.schliessen();
          reiterWaehlen('installiert');
          await ladeApps(true);
        } catch (e) {
          griff.beschaeftigt(false);
          if (e && e.code === 'E_ABGEBROCHEN') return;
          fz.zeigen(fehlerText(e));
          const feldName = e && e.details && e.details.feld;
          if (feldName === 'name') name.focus();
          if (e && e.code === 'E_BELEGT') pruefen();
          form.scrollTop = 0;
        }
      });
    }

    // ---- App aus ZIP (Release-ZIP mit manage.sh) ---------------------------------------------------------------------
    /** Roh-Upload in ein Schreib-Ticket mit Fortschritt (XMLHttpRequest – fetch kennt keinen Upload-Fortschritt). */
    function zipHochladen(datei, ticket, beiFortschritt) {
      return new Promise((ok, nein) => {
        const x = new XMLHttpRequest();
        x.open('POST', `/api/agent-upload?ticket=${encodeURIComponent(ticket)}`);
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.setRequestHeader('X-FAHNAS-CSRF', csrfWert());
        x.upload.addEventListener('progress', (e) => { if (e.lengthComputable && e.total) beiFortschritt(e.loaded / e.total); });
        x.addEventListener('load', () => {
          let d = null; try { d = JSON.parse(x.responseText); } catch { /* keine JSON-Antwort */ }
          if (x.status >= 200 && x.status < 300 && !(d && d.ok === false)) { ok(d); return; }
          if (x.status === 413) { nein({ code: 'E_PLATZ', meldung: t('apps.zip_zu_gross_proxy') }); return; }
          nein((d && d.fehler) || { code: 'E_AGENT', meldung: t('apps.zip_hochladen_fehl', { status: x.status }) });
        });
        x.addEventListener('error', () => nein({ code: 'E_AGENT', meldung: t('apps.zip_hochladen_fehl', { status: 0 }) }));
        x.addEventListener('abort', () => nein({ code: 'E_ABGEBROCHEN', meldung: t('apps.aufgabe_abgebrochen') }));
        x.send(datei);
      });
    }

    /**
     * Dialog „App aus ZIP“ (a = null) bzw. „Neue ZIP einspielen“ (a = ZIP-App): Datei wählen → hochladen und prüfen
     * (Inhalt, Name, riskante Punkte inkl. „Skript läuft mit vollen Rechten“) → installieren / einspielen als Aufgabe.
     */
    async function dialogZip(a = null) {
      const update = !!a;
      const form = el('form', { klasse: 'ap-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const datei = el('input', { typ: 'file', klasse: 'eingabe vw-eingabe', attr: { accept: '.zip,application/zip' } });
      const balken = fortschritt(); balken.element.hidden = true;
      const ergebnis = el('div', { klasse: 'ap-zip-ergebnis' }); ergebnis.hidden = true;
      form.append(fz.element,
        el('p', { klasse: 'erklaerung', text: update ? t('apps.zip_update_erklaerung', { name: a.name }) : t('apps.zip_erklaerung') }),
        feld({ label: t('apps.zip_datei'), erklaerung: t('apps.zip_datei_erklaerung'), eingabe: datei }), balken.element, ergebnis);
      const griff = dialogOeffnen({ ctx, titel: update ? t('apps.zip_update_titel', { name: a.name }) : t('apps.zip_titel'), inhalt: form, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.zip_pruefen_knopf'), absenden: true }] });
      const hauptKnopf = griff.knoepfe[1];
      let phase = 'auswahl'; let kennung = null; let pruef = null; let nameE = null; let autostart = null; let vorbestaetigt = [];
      if (update) { try { const d = await api(ctx, 'apps.details', { name: a.name }); vorbestaetigt = (d && d.bestaetigt_riskant) || []; } catch { /* dann eben neu bestätigen */ } }
      const zuruecksetzen = () => { phase = 'auswahl'; kennung = null; pruef = null; leeren(ergebnis); ergebnis.hidden = true; hauptKnopf.textContent = t('apps.zip_pruefen_knopf'); };
      datei.addEventListener('change', () => { zuruecksetzen(); fz.leeren(); });
      form.addEventListener('submit', (ev) => { ev.preventDefault(); fz.leeren(); if (phase === 'auswahl') hochladenUndPruefen(); else ausfuehren(); });

      async function hochladenUndPruefen() {
        const f = datei.files && datei.files[0];
        if (!f) { fz.zeigen(t('apps.zip_keine_datei')); datei.focus(); return; }
        if (!/\.zip$/i.test(f.name)) { fz.zeigen(t('apps.zip_keine_zip')); datei.focus(); return; }
        griff.beschaeftigt(true); balken.element.hidden = false; balken.setzen(0, t('apps.zip_hochladen', { datei: f.name }));
        try {
          const tk = await api(ctx, 'apps.zip.ticket', { dateiname: f.name, groesse: f.size });
          await zipHochladen(f, tk.ticket, (anteil) => balken.setzen(anteil, t('apps.zip_hochladen_prozent', { prozent: Math.round(anteil * 100), datei: f.name })));
          balken.setzen(1, t('apps.zip_pruefen_laeuft'));
          const r = await api(ctx, 'apps.zip.pruefen', update ? { kennung: tk.kennung, name: a.name } : { kennung: tk.kennung });
          kennung = tk.kennung;
          zeigePruefung(r);
          phase = 'bereit';
          hauptKnopf.textContent = t(update ? 'apps.zip_update_knopf' : 'apps.installieren_knopf');
        } catch (e) { fz.zeigen(fehlerText(e)); } finally { balken.element.hidden = true; griff.beschaeftigt(false); }
      }

      function zeigePruefung(r) {
        leeren(ergebnis); ergebnis.hidden = false;
        const inhalt = [
          [t('apps.zip_inhalt_datei'), `${r.dateiname} (${fmt.groesse(r.groesse)})`],
          [t('apps.zip_inhalt_skript'), r.manage || t('apps.zip_ohne_skript')],
          [t('apps.zip_inhalt_compose'), r.compose_datei || t('apps.zip_inhalt_keine')],
        ];
        ergebnis.appendChild(el('dl', { klasse: 'ap-zip-inhalt' }, inhalt.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { klasse: 'vw-mono', text: v })])));
        if (!update) {
          nameE = eingabe({ wert: r.name_vorschlag || '', maxlength: 31, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
          nameE.setAttribute('autocapitalize', 'none');
          ergebnis.appendChild(feld({ label: t('apps.name'), erklaerung: t('apps.zip_name_erklaerung'), eingabe: nameE }));
          if (Array.isArray(r.installiert_als) && r.installiert_als.length) ergebnis.appendChild(hinweis(t('apps.zip_schon_installiert', { name: r.installiert_als.join(', ') }), 'warnung'));
          else if (r.name_frei === false) ergebnis.appendChild(hinweis(t('apps.name_vergeben', { name: r.name_vorschlag }), 'warnung'));
          autostart = schalter({ label: t('apps.autostart'), erklaerung: t('apps.autostart_erklaerung'), wert: true });
          ergebnis.appendChild(autostart.element);
        }
        pruef = pruefbereichBauen({ vorbestaetigt });
        ergebnis.appendChild(pruef.element);
        pruef.zeigen(r, 0);
      }

      async function ausfuehren() {
        if (!kennung || !pruef) return;
        if (!update && !felderPruefen([{ eingabe: nameE, pruefen: (w) => (MUSTER_APPNAME.test(w.trim()) ? null : t('apps.name_fehler')) }], fz)) return;
        if (!pruef.alleBestaetigt()) { fz.zeigen(t('apps.riskant_offen')); return; }
        const n = update ? a.name : nameE.value.trim();
        griff.beschaeftigt(true);
        try {
          const params = update ? { kennung, name: n } : { kennung, name: n, autostart: autostart.eingabe.checked };
          const b = pruef.bestaetigte(); if (b.length) params.bestaetigt_riskant = b;
          const r = await aufgabeStarten(ctx, update ? 'apps.zip.aktualisieren' : 'apps.zip.installieren', params,
            aufgabenTexte(update ? t('apps.zip_update_titel', { name: n }) : t('apps.zip_installieren_titel', { name: n }), t('apps.zip_laeuft')));
          const webui = webuiAufloesen(r && r.webui, host);
          melden(ctx, update ? t('apps.zip_aktualisiert', { name: n }) : (webui ? t('apps.installiert_offen', { name: n, webui }) : t('apps.installiert', { name: n })), 'erfolg');
          for (const w of (r && Array.isArray(r.warnungen) ? r.warnungen : []).slice(0, 3)) melden(ctx, String(w), 'warnung');
          griff.schliessen();
          reiterWaehlen('installiert');
          await ladeApps(true);
          // Portkonflikt: App ist gebaut, aber nicht gestartet → gleich den Editor öffnen, dort freien Port eintragen und starten
          if (r && r.portkonflikt) dialogBearbeiten({ name: n, titel: n });
        } catch (e) {
          griff.beschaeftigt(false);
          if (e && e.code === 'E_ABGEBROCHEN') return;
          fz.zeigen(fehlerText(e));
          const ausgabe = e && e.details && e.details.ausgabe;
          if (ausgabe) ergebnis.appendChild(el('details', { klasse: 'vw-details', open: true }, el('summary', { text: t('apps.zip_ausgabe') }), el('pre', { klasse: 'ap-compose vw-mono', text: String(ausgabe) })));
          // Fehler vor dem Start (Name, Bestätigung) lassen die ZIP im Eingang – sonst ist sie verbraucht: neu hochladen
          if (!(e && ['E_RECHTE', 'E_EXISTIERT', 'E_PARAMS'].includes(e.code))) { phase = 'auswahl'; kennung = null; hauptKnopf.textContent = t('apps.zip_pruefen_knopf'); }
        }
      }
    }

    // ---- Aus FAH-Git bauen (Betreiber 26.10.2026) ------------------------------------------------------------------------
    /**
     * Dialog „Aus FAH-Git bauen“: Projekt und Zweig wählen → holen und prüfen (apps.fahgit.holen) → bauen
     * (apps.zip.installieren) oder, wenn das Projekt schon als App läuft, neuen Stand einspielen (apps.zip.aktualisieren).
     * `vorgabe` = {pfad, zweig} aus dem Direktsprung von FAH-Git.
     */
    async function dialogFahgit(vorgabe = {}) {
      const form = el('form', { klasse: 'ap-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const kopf = el('div', {}, leerHinweis(t('apps.fg_laden')));
      const ergebnis = el('div', { klasse: 'ap-zip-ergebnis' }); ergebnis.hidden = true;
      form.append(fz.element, el('p', { klasse: 'erklaerung', text: t('apps.fg_erklaerung') }), kopf, ergebnis);
      const griff = dialogOeffnen({ ctx, titel: t('apps.fg_titel'), inhalt: form, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.fg_holen_knopf'), absenden: true, deaktiviert: true }] });
      const hauptKnopf = griff.knoepfe[1];
      let projekte = []; let projektWahl = null; let zweigWahl = null; let zweigInfo = null;
      let phase = 'auswahl'; let kennung = null; let pruef = null; let nameE = null; let autostart = null; let auto = null; let ziel = null;
      try { projekte = listeAus(await api(ctx, 'fahgit.projekte', {})); } catch (e) {
        leeren(kopf);
        kopf.appendChild(hinweis(fehlerText(e), e && e.code === 'E_PARAMS' ? 'info' : 'fehler'));
        if (e && e.code === 'E_PARAMS') kopf.appendChild(el('p', {}, el('a', { href: '#/system/fahgit', text: t('apps.fg_zur_verbindung') })));
        return;
      }
      leeren(kopf);
      if (!projekte.length) { kopf.appendChild(hinweis(t('apps.fg_keine_projekte'), 'info')); return; }
      projektWahl = auswahl({ optionen: [{ wert: '', text: t('apps.fg_projekt_waehlen') }, ...projekte.map((p) => ({ wert: p.pfad, text: `${p.ordner ? `${p.ordner} / ` : ''}${p.name}${p.app ? ` – ${t('apps.fg_schon_app', { name: p.app })}` : ''}` }))], wert: '' });
      zweigWahl = auswahl({ optionen: [{ wert: '', text: '–' }], wert: '' }); zweigWahl.disabled = true;
      zweigInfo = el('p', { klasse: 'erklaerung vw-mono' });
      kopf.append(feld({ label: t('apps.fg_projekt'), erklaerung: t('apps.fg_projekt_erklaerung'), eingabe: projektWahl }),
        feld({ label: t('apps.fg_zweig'), erklaerung: t('apps.fg_zweig_erklaerung'), eingabe: zweigWahl }), zweigInfo);
      let zweige = [];
      const zuruecksetzen = () => { phase = 'auswahl'; kennung = null; pruef = null; leeren(ergebnis); ergebnis.hidden = true; hauptKnopf.textContent = t('apps.fg_holen_knopf'); };
      const zweigZeigen = () => { const z = zweige.find((x) => x.name === zweigWahl.value); zweigInfo.textContent = z ? t('apps.fg_zweig_stand', { commit: z.sha.slice(0, 7), betreff: z.betreff || '–', zeit: z.datum ? fmt.zeit(z.datum) : '–' }) : ''; };
      async function projektGewaehlt(wunschZweig) {
        zuruecksetzen(); fz.leeren(); hauptKnopf.disabled = true; zweigWahl.disabled = true; zweigInfo.textContent = '';
        if (!projektWahl.value) return;
        try {
          const d = await api(ctx, 'fahgit.zweige', { pfad: projektWahl.value });
          zweige = listeAus(d, 'zweige');
          leeren(zweigWahl);
          for (const z of zweige) zweigWahl.appendChild(el('option', { attr: { value: z.name }, text: z.name === d.standard ? `${z.name} (${t('apps.fg_standard')})` : z.name }));
          zweigWahl.value = zweige.some((z) => z.name === wunschZweig) ? wunschZweig : d.standard;
          zweigWahl.disabled = !zweige.length; hauptKnopf.disabled = !zweige.length;
          if (d.leer || !zweige.length) fz.zeigen(t('apps.fg_projekt_leer'));
          zweigZeigen();
        } catch (e) { fz.zeigen(fehlerText(e)); }
      }
      projektWahl.addEventListener('change', () => projektGewaehlt());
      zweigWahl.addEventListener('change', () => { zuruecksetzen(); zweigZeigen(); });
      form.addEventListener('submit', (ev) => { ev.preventDefault(); fz.leeren(); if (phase === 'auswahl') holen(); else ausfuehren(); });
      if (vorgabe.pfad && projekte.some((p) => p.pfad === vorgabe.pfad)) { projektWahl.value = vorgabe.pfad; await projektGewaehlt(vorgabe.zweig); }
      else if (vorgabe.pfad) fz.zeigen(t('apps.fg_projekt_unbekannt', { pfad: vorgabe.pfad }));

      async function holen() {
        if (!projektWahl.value) { fz.zeigen(t('apps.fg_projekt_fehlt')); projektWahl.focus(); return; }
        griff.beschaeftigt(true);
        try {
          const r = await api(ctx, 'apps.fahgit.holen', { pfad: projektWahl.value, zweig: zweigWahl.value });
          kennung = r.kennung;
          zeigePruefung(r);
          phase = 'bereit';
          hauptKnopf.textContent = t(ziel ? 'apps.fg_update_knopf' : 'apps.fg_bauen_knopf');
        } catch (e) { fz.zeigen(fehlerText(e)); } finally { griff.beschaeftigt(false); }
      }

      function zeigePruefung(r) {
        leeren(ergebnis); ergebnis.hidden = false;
        ziel = Array.isArray(r.installiert_als) && r.installiert_als.length ? r.installiert_als[0] : null;
        const fgI = r.fahgit || {};
        const inhalt = [
          [t('apps.fg_inhalt_stand'), `${fgI.zweig || '?'} @ ${String(fgI.commit || '').slice(0, 7)} – ${fgI.betreff || ''}`],
          [t('apps.fg_inhalt_bauweise'), r.manage ? t('apps.fg_bauweise_skript', { datei: r.manage }) : (r.compose_datei ? t('apps.fg_bauweise_compose', { datei: r.compose_datei }) : t('apps.fg_bauweise_dockerfile'))],
          [t('apps.zip_inhalt_datei'), `${r.dateiname} (${fmt.groesse(r.groesse)})`],
        ];
        ergebnis.appendChild(el('dl', { klasse: 'ap-zip-inhalt' }, inhalt.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { klasse: 'vw-mono', text: v })])));
        if (ziel) ergebnis.appendChild(hinweis(t('apps.fg_schon_gebaut', { name: ziel }), 'info'));
        else {
          nameE = eingabe({ wert: r.name_vorschlag || '', maxlength: 31, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
          nameE.setAttribute('autocapitalize', 'none');
          ergebnis.appendChild(feld({ label: t('apps.name'), erklaerung: t('apps.zip_name_erklaerung'), eingabe: nameE }));
          if (r.name_frei === false) ergebnis.appendChild(hinweis(t('apps.name_vergeben', { name: r.name_vorschlag }), 'warnung'));
          autostart = schalter({ label: t('apps.autostart'), erklaerung: t('apps.autostart_erklaerung'), wert: true });
          auto = schalter({ label: t('apps.fg_auto'), erklaerung: t('apps.fg_auto_erklaerung'), wert: false });
          ergebnis.append(autostart.element, auto.element);
        }
        pruef = pruefbereichBauen({ vorbestaetigt: [] });
        ergebnis.appendChild(pruef.element);
        pruef.zeigen(r, 0);
      }

      async function ausfuehren() {
        if (!kennung || !pruef) return;
        if (!ziel && !felderPruefen([{ eingabe: nameE, pruefen: (w) => (MUSTER_APPNAME.test(w.trim()) ? null : t('apps.name_fehler')) }], fz)) return;
        if (!pruef.alleBestaetigt()) { fz.zeigen(t('apps.riskant_offen')); return; }
        const n = ziel || nameE.value.trim();
        griff.beschaeftigt(true);
        try {
          const params = ziel ? { kennung, name: n } : { kennung, name: n, titel: (projekte.find((p) => p.pfad === projektWahl.value) || {}).name || n, autostart: autostart.eingabe.checked, fahgit_auto: auto.eingabe.checked };
          const b = pruef.bestaetigte(); if (b.length) params.bestaetigt_riskant = b;
          const r = await aufgabeStarten(ctx, ziel ? 'apps.zip.aktualisieren' : 'apps.zip.installieren', params,
            aufgabenTexte(t(ziel ? 'apps.fg_update_titel' : 'apps.fg_bauen_titel', { name: n }), t('apps.fg_laeuft')));
          const webui = webuiAufloesen(r && r.webui, host);
          melden(ctx, ziel ? t('apps.fg_aktualisiert', { name: n }) : (webui ? t('apps.installiert_offen', { name: n, webui }) : t('apps.installiert', { name: n })), 'erfolg');
          for (const w of (r && Array.isArray(r.warnungen) ? r.warnungen : []).slice(0, 3)) melden(ctx, String(w), 'warnung');
          griff.schliessen();
          reiterWaehlen('installiert');
          await ladeApps(true);
          if (r && r.portkonflikt) dialogBearbeiten({ name: n, titel: n });
        } catch (e) {
          griff.beschaeftigt(false);
          if (e && e.code === 'E_ABGEBROCHEN') return;
          fz.zeigen(fehlerText(e));
          const ausgabe = e && e.details && e.details.ausgabe;
          if (ausgabe) ergebnis.appendChild(el('details', { klasse: 'vw-details', open: true }, el('summary', { text: t('apps.zip_ausgabe') }), el('pre', { klasse: 'ap-compose vw-mono', text: String(ausgabe) })));
          if (!(e && ['E_RECHTE', 'E_EXISTIERT', 'E_PARAMS'].includes(e.code))) zuruecksetzen();
        }
      }
    }

    /** Neuesten Commit des Zweigs holen und neu bauen (nichts tun, wenn schon aktuell). */
    async function fahgitAktualisieren(a) {
      try {
        const r = await aufgabeStarten(ctx, 'apps.fahgit.aktualisieren', { name: a.name }, aufgabenTexte(t('apps.fg_update_titel', { name: a.name }), t('apps.fg_laeuft')));
        melden(ctx, r && r.gleich ? t('apps.fg_schon_aktuell', { name: a.name }) : t('apps.fg_aktualisiert_commit', { name: a.name, commit: String((r && r.commit) || '').slice(0, 7) }), r && r.gleich ? 'info' : 'erfolg');
        for (const w of (r && Array.isArray(r.warnungen) ? r.warnungen : []).slice(0, 3)) melden(ctx, String(w), 'warnung');
      } catch { /* im Aufgabendialog gezeigt */ }
      await ladeApps(true);
    }

    /** Einstellungen einer FAH-Git-App: automatisch bei neuem Commit, Zweig. */
    async function dialogFahgitEinstellungen(a) {
      const fz = fehlerzeile();
      const auto = schalter({ label: t('apps.fg_auto'), erklaerung: t('apps.fg_auto_erklaerung'), wert: !!a.fahgit.auto });
      const zweigWahl = auswahl({ optionen: [{ wert: a.fahgit.zweig, text: a.fahgit.zweig }], wert: a.fahgit.zweig });
      const inhalt = el('div', { klasse: 'ap-form' }, fz.element,
        el('p', { klasse: 'erklaerung vw-mono', text: `${a.fahgit.pfad} · ${a.fahgit.zweig} @ ${String(a.fahgit.commit || '').slice(0, 7)}` }),
        auto.element, feld({ label: t('apps.fg_zweig'), erklaerung: t('apps.fg_zweig_wechsel_erklaerung'), eingabe: zweigWahl }));
      api(ctx, 'fahgit.zweige', { pfad: a.fahgit.pfad }).then((d) => {
        leeren(zweigWahl);
        for (const z of listeAus(d, 'zweige')) zweigWahl.appendChild(el('option', { attr: { value: z.name }, text: z.name }));
        zweigWahl.value = a.fahgit.zweig;
      }).catch((e) => fz.zeigen(fehlerText(e)));
      dialogOeffnen({ ctx, titel: t('apps.fg_einstellungen_titel', { name: a.titel || a.name }), inhalt, schliessenText: t('apps.schliessen'), knoepfe: [{
        text: t('apps.sichtbar_speichern'),
        beiKlick: async (g) => {
          g.beschaeftigt(true);
          try {
            await api(ctx, 'apps.fahgit.einstellen', { name: a.name, auto: auto.eingabe.checked, zweig: zweigWahl.value });
            melden(ctx, t('apps.fg_eingestellt', { name: a.name }), 'erfolg');
            g.schliessen();
            await ladeApps(true);
          } catch (e) { g.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
        },
      }] });
    }

    // ---- Bearbeiten wie bei Unraid (Ports, Pfade, Variablen) – Betreiber 12.10.2026 ---------------------------------------
    /** Belegte NAS-Ports anderer Apps (für den Hinweis beim Tippen; endgültig prüft der Agent beim Speichern). */
    function fremdePorts(name) {
      const m = new Map();
      for (const x of apps) if (x.name !== name) for (const p of x.ports || []) if (p && p.port) m.set(`${p.port}/${p.protokoll || 'tcp'}`, x.titel || x.name);
      return m;
    }

    /**
     * Ordnerwahl (Betreiber 12.10.2026: „Dropdown zur Ordnerwahl statt Tippen“): blättert durch App-Ordner und Freigaben
     * (apps.ordner) und liefert den gewählten absoluten Pfad – oder null bei Abbrechen.
     */
    function ordnerWaehlen(appName, start) {
      return new Promise((aufloesen) => {
        let gewaehlt = null; let aktuell = '';
        const ort = el('p', { klasse: 'vw-mono ap-ordner-ort' });
        const liste = el('ul', { klasse: 'ap-ordner-liste', role: 'list' });
        const griff = dialogOeffnen({ ctx, titel: t('apps.ordner_titel'), inhalt: el('div', {}, el('p', { klasse: 'erklaerung', text: t('apps.ordner_erklaerung') }), ort, liste), schliessenText: t('apps.schliessen'),
          knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.ordner_nehmen'), deaktiviert: true, beiKlick: (g) => { gewaehlt = aktuell; g.schliessen(); } }],
          beimSchliessen: () => aufloesen(gewaehlt) });
        async function zeigen(pfad) {
          leeren(liste); liste.appendChild(el('li', { klasse: 'vw-gedaempft', text: t('apps.ordner_laden') }));
          let r;
          try { r = await api(ctx, 'apps.ordner', { ...(appName ? { name: appName } : {}), pfad }); } catch (e) {
            if (pfad) { zeigen(''); return; }
            leeren(liste); liste.appendChild(el('li', { text: fehlerText(e) })); return;
          }
          aktuell = r.pfad || '';
          ort.textContent = r.pfad || t('apps.ordner_wurzeln');
          griff.knoepfe[1].disabled = !r.pfad;
          leeren(liste);
          if (r.eltern !== null && r.eltern !== undefined) liste.appendChild(el('li', {}, knopf(t('apps.ordner_hoch'), { art: 'zweit', klein: true, beiKlick: () => zeigen(r.eltern) })));
          if (!r.ordner.length) liste.appendChild(el('li', { klasse: 'vw-gedaempft', text: t('apps.ordner_keine') }));
          for (const o of r.ordner) liste.appendChild(el('li', {}, el('button', { typ: 'button', klasse: 'ap-ordner-knopf', text: `📁 ${o.name}`, onclick: () => zeigen(o.pfad) })));
        }
        zeigen(typeof start === 'string' && start.startsWith('/') ? start : '');
      });
    }

    function zeilenListe(titel, erklaerung, neuText, neuZeile, zeilen) {
      const liste = el('div', { klasse: 'ap-edit-liste' });
      const eintraege = [];
      const hinzufuegen = (z) => {
        const e = neuZeile(z);
        const weg = knopf('×', { art: 'zweit', klein: true, titel: t('apps.bearbeiten_entfernen'), beiKlick: () => { e.element.remove(); eintraege.splice(eintraege.indexOf(e), 1); } });
        weg.setAttribute('aria-label', t('apps.bearbeiten_entfernen'));
        e.element.appendChild(weg);
        eintraege.push(e); liste.appendChild(e.element);
      };
      for (const z of zeilen) hinzufuegen(z);
      const element = el('div', { klasse: 'ap-edit-abschnitt' },
        el('h4', { klasse: 'ap-untertitel', text: titel }), el('p', { klasse: 'erklaerung', text: erklaerung }), liste,
        knopf(neuText, { art: 'zweit', klein: true, beiKlick: () => hinzufuegen(null) }));
      return { element, werte: () => eintraege.map((e) => e.wert()) };
    }

    const GPU_TEXT = { keine: 'apps.bearbeiten_gpu_keine', dri: 'apps.bearbeiten_gpu_dri', nvidia: 'apps.bearbeiten_gpu_nvidia' };
    /** Grafikkarten-Wahl je Dienst – nur angeboten, was das NAS hat (oder der Dienst schon nutzt). */
    function gpuAuswahl(d, gpuInfo) {
      const arten = ['keine'];
      if ((gpuInfo && gpuInfo.dri && gpuInfo.dri.vorhanden) || d.gpu === 'dri') arten.push('dri');
      if ((gpuInfo && gpuInfo.nvidia && gpuInfo.nvidia.bereit) || d.gpu === 'nvidia') arten.push('nvidia');
      if (arten.length === 1) return null;
      const wahl = auswahl({ optionen: arten.map((a) => ({ wert: a, text: t(GPU_TEXT[a]) })), wert: d.gpu || 'keine', klasse: 'ap-edit-gpu' });
      const hinweisNvidia = gpuInfo && gpuInfo.nvidia && gpuInfo.nvidia.karte && !gpuInfo.nvidia.bereit ? el('p', { klasse: 'erklaerung', text: t('apps.bearbeiten_gpu_nvidia_fehlt') }) : null;
      return { element: el('div', { klasse: 'ap-edit-abschnitt' }, el('h4', { klasse: 'ap-untertitel', text: t('apps.bearbeiten_gpu') }), el('p', { klasse: 'erklaerung', text: t('apps.bearbeiten_gpu_erklaerung') }), wahl, hinweisNvidia), wert: () => wahl.value };
    }

    function dienstEditor(d, name, mehrere, gpuInfo) {
      const fremd = fremdePorts(name);
      const ports = zeilenListe(t('apps.bearbeiten_ports'), t('apps.bearbeiten_ports_erklaerung'), t('apps.bearbeiten_port_neu'), (p) => {
        const host = eingabe({ typ: 'number', min: 1, max: 65535, wert: p ? p.host : '', klasse: 'ap-edit-port', platzhalter: '8080' });
        const container = eingabe({ typ: 'number', min: 1, max: 65535, wert: p ? p.container : '', klasse: 'ap-edit-port', platzhalter: '80' });
        const proto = auswahl({ optionen: [{ wert: 'tcp', text: 'TCP' }, { wert: 'udp', text: 'UDP' }], wert: p ? p.protokoll : 'tcp', klasse: 'ap-edit-proto' });
        const warn = el('span', { klasse: 'ap-edit-warnung' });
        const pruefen = () => { const k = `${host.value}/${proto.value}`; warn.textContent = fremd.has(k) ? t('apps.bearbeiten_port_belegt', { app: fremd.get(k) }) : ''; };
        host.addEventListener('input', pruefen); proto.addEventListener('change', pruefen); pruefen();
        host.setAttribute('aria-label', t('apps.bearbeiten_nas_port')); container.setAttribute('aria-label', t('apps.bearbeiten_container_port'));
        return {
          element: el('div', { klasse: 'ap-edit-zeile' }, el('span', { klasse: 'ap-edit-label', text: t('apps.bearbeiten_nas_port') }), host, el('span', { text: '→' }), el('span', { klasse: 'ap-edit-label', text: t('apps.bearbeiten_container_port') }), container, proto, warn),
          wert: () => ({ host: Number(host.value), container: Number(container.value), protokoll: proto.value, adresse: p ? p.adresse || '' : '' }),
        };
      }, d.ports);
      const pfade = zeilenListe(t('apps.bearbeiten_pfade'), t('apps.bearbeiten_pfade_erklaerung'), t('apps.bearbeiten_pfad_neu'), (p) => {
        const volume = p && p.art === 'volume';
        const host = eingabe({ wert: p ? p.host : '', klasse: 'vw-mono ap-edit-pfad', spellcheck: false, platzhalter: p ? '' : '/data/shares/medien', nurLesen: volume });
        const waehlen = volume ? null : knopf('📁', { art: 'zweit', klein: true, titel: t('apps.ordner_waehlen'), beiKlick: async () => { const gew = await ordnerWaehlen(name, host.value.trim()); if (gew) host.value = gew; } });
        if (waehlen) waehlen.setAttribute('aria-label', t('apps.ordner_waehlen'));
        const container = eingabe({ wert: p ? p.container : '', klasse: 'vw-mono ap-edit-pfad', spellcheck: false, platzhalter: p ? '' : '/media' });
        const ro = el('input', { typ: 'checkbox' }); ro.checked = !!(p && p.nur_lesen);
        host.setAttribute('aria-label', t('apps.bearbeiten_nas_ordner')); container.setAttribute('aria-label', t('apps.bearbeiten_container_ordner'));
        return {
          element: el('div', { klasse: 'ap-edit-zeile' }, el('span', { klasse: 'ap-edit-label', text: volume ? t('apps.bearbeiten_volume') : t('apps.bearbeiten_nas_ordner') }), host, waehlen, el('span', { text: '→' }), el('span', { klasse: 'ap-edit-label', text: t('apps.bearbeiten_container_ordner') }), container, el('label', { klasse: 'ap-edit-ro' }, ro, el('span', { text: t('apps.bearbeiten_nur_lesen') }))),
          wert: () => ({ art: volume ? 'volume' : 'ordner', host: host.value.trim(), container: container.value.trim(), nur_lesen: ro.checked }),
        };
      }, d.pfade);
      const variablen = zeilenListe(t('apps.bearbeiten_variablen'), t('apps.bearbeiten_variablen_erklaerung'), t('apps.bearbeiten_variable_neu'), (v) => {
        const geheim = !!(v && v.geheim);
        // Beispiel-Platzhalter nur in neuen Zeilen – bei leeren vorhandenen Werten sah „Europe/Berlin“ wie ein Wert aus
        const name = eingabe({ wert: v ? v.name : '', klasse: 'vw-mono ap-edit-name', spellcheck: false, platzhalter: v ? '' : 'TZ' });
        const wert = eingabe({ typ: geheim ? 'password' : 'text', wert: v ? v.wert : '', klasse: 'vw-mono ap-edit-wert', spellcheck: false, autocomplete: 'off', platzhalter: geheim ? t('apps.bearbeiten_geheim_unveraendert') : (v ? t('apps.bearbeiten_leer') : 'Europe/Berlin') });
        if (v && v.name) name.title = v.name;
        name.setAttribute('aria-label', t('apps.bearbeiten_variable_name')); wert.setAttribute('aria-label', t('apps.bearbeiten_variable_wert'));
        return { element: el('div', { klasse: 'ap-edit-zeile' }, name, el('span', { text: '=' }), wert), wert: () => ({ name: name.value.trim(), wert: wert.value }) };
      }, d.variablen);
      const kopf = mehrere || d.netz_host ? el('h3', { klasse: 'ap-untertitel', text: d.image ? `${d.name} · ${d.image}` : d.name }) : null;
      const gpu = gpuAuswahl(d, gpuInfo);
      return {
        element: el('section', { klasse: 'ap-edit-dienst' }, kopf, d.netz_host ? hinweis(t('apps.bearbeiten_host_netz'), 'info') : null, ports.element, pfade.element, variablen.element, gpu ? gpu.element : null),
        wert: () => ({ name: d.name, ports: ports.werte(), pfade: pfade.werte(), variablen: variablen.werte(), ...(gpu ? { gpu: gpu.wert() } : {}) }),
      };
    }

    async function dialogBearbeiten(a) {
      const inhalt = el('div', { klasse: 'ap-edit' }, leerHinweis(t('apps.bearbeiten_laden')));
      const griff = dialogOeffnen({ ctx, titel: t('apps.bearbeiten_titel', { name: a.titel || a.name }), inhalt, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [
          { text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('apps.bearbeiten_zuruecksetzen'), art: 'gefahr', deaktiviert: true },
          { text: t('apps.speichern'), art: 'zweit', deaktiviert: true },
          { text: t('apps.bearbeiten_speichern_start'), deaktiviert: true },
        ] });
      const [, zurueckKnopf, speichernKnopf, startKnopf] = griff.knoepfe;
      zurueckKnopf.hidden = true;
      let e;
      let gpuInfo = null;
      try { [e, gpuInfo] = await Promise.all([api(ctx, 'apps.einstellungen', { name: a.name }), api(ctx, 'gpu.lesen', {}).catch(() => null)]); } catch (f) { leeren(inhalt); inhalt.appendChild(hinweis(fehlerText(f), 'fehler')); return; }
      const fz = fehlerzeile();
      const editoren = (e.dienste || []).map((d) => dienstEditor(d, a.name, (e.dienste || []).length > 1, gpuInfo));
      const autostart = schalter({ label: t('apps.autostart'), erklaerung: t('apps.autostart_erklaerung'), wert: !!e.autostart });
      leeren(inhalt);
      // append() schreibt null als Text „null“ – leere Teile vorher weglassen
      inhalt.append(...[
        el('p', { klasse: 'erklaerung', text: e.laeuft ? t('apps.bearbeiten_erklaerung_laeuft') : t('apps.bearbeiten_erklaerung') }),
        e.portkonflikt ? hinweis(t('apps.bearbeiten_konflikt_hinweis', { text: e.portkonflikt }), 'warnung') : null,
        e.angepasst ? hinweis(t('apps.bearbeiten_angepasst_hinweis'), 'info') : null,
        fz.element, ...editoren.map((x) => x.element), autostart.element].filter(Boolean));
      startKnopf.textContent = e.laeuft ? t('apps.bearbeiten_speichern_neustart') : t('apps.bearbeiten_speichern_start');
      for (const k of [speichernKnopf, startKnopf]) k.disabled = false;
      if (e.angepasst) { zurueckKnopf.hidden = false; zurueckKnopf.disabled = false; }

      const speichern = async (neustart) => {
        fz.leeren(); griff.beschaeftigt(true);
        try {
          const r = await aufgabeStarten(ctx, 'apps.einstellungen.speichern', { name: a.name, dienste: editoren.map((x) => x.wert()), autostart: autostart.eingabe.checked, neustart },
            aufgabenTexte(t('apps.bearbeiten_titel', { name: a.titel || a.name }), t('apps.bearbeiten_laeuft')));
          if (neustart && !e.laeuft && !(r && r.neu_gestartet)) { await api(ctx, 'apps.steuern', { name: a.name, aktion: 'start' }); }
          melden(ctx, neustart ? t('apps.bearbeiten_gespeichert_start', { name: a.titel || a.name }) : t('apps.bearbeiten_gespeichert', { name: a.titel || a.name }), 'erfolg');
          griff.schliessen();
          await ladeApps(true);
        } catch (f) { griff.beschaeftigt(false); if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); inhalt.scrollTop = 0; }
      };
      speichernKnopf.addEventListener('click', () => speichern(false));
      startKnopf.addEventListener('click', () => speichern(true));
      zurueckKnopf.addEventListener('click', async () => {
        if (!await bestaetigen(ctx, t('apps.bearbeiten_zuruecksetzen_frage', { name: a.titel || a.name }))) return;
        griff.beschaeftigt(true);
        try {
          await aufgabeStarten(ctx, 'apps.einstellungen.zuruecksetzen', { name: a.name, neustart: !!e.laeuft }, aufgabenTexte(t('apps.bearbeiten_titel', { name: a.titel || a.name }), t('apps.bearbeiten_laeuft')));
          melden(ctx, t('apps.bearbeiten_zurueckgesetzt', { name: a.titel || a.name }), 'erfolg');
          griff.schliessen(); await ladeApps(true);
        } catch (f) { griff.beschaeftigt(false); if (f && f.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(f)); }
      });
    }

    // ---- Katalog ---------------------------------------------------------------------------------------------------
    const suche = eingabe({ typ: 'search', platzhalter: t('apps.suche_platzhalter'), autocomplete: 'off', klasse: 'ap-suche' });
    const kategorieWahl = auswahl({ optionen: [{ wert: '', text: t('apps.kategorie_alle') }] });
    const quelleWahl = auswahl({ optionen: [{ wert: '', text: t('apps.quelle_alle') }, ...QUELLEN.map((q) => ({ wert: q, text: t(QUELLE_TEXT[q]) }))] });
    const unraidKnopf = admin ? knopf(t('apps.unraid_laden'), { art: 'zweit', beiKlick: () => unraidLaden() }) : null;
    const unraidText = el('p', { klasse: 'ap-unraid-stand vw-gedaempft', text: '' });
    const importKnopf = admin ? knopf(t('apps.importieren'), { art: 'zweit', beiKlick: () => dialogImportieren() }) : null;
    const composeKnopf = admin ? knopf(t('apps.compose_knopf'), { beiKlick: () => dialogCompose() }) : null;
    const zipKnopf = admin ? knopf(t('apps.zip_knopf'), { art: 'zweit', beiKlick: () => dialogZip() }) : null;
    const filterleiste = el('div', { klasse: 'ap-filter' },
      feld({ label: t('apps.suche'), erklaerung: t('apps.suche_erklaerung'), eingabe: suche }),
      feld({ label: t('apps.kategorie'), erklaerung: t('apps.kategorie_erklaerung'), eingabe: kategorieWahl }),
      feld({ label: t('apps.quelle'), erklaerung: t('apps.quelle_erklaerung'), eingabe: quelleWahl }));
    const werkzeugleiste = admin ? el('div', { klasse: 'ap-werkzeuge' }, el('div', { klasse: 'vw-knopfleiste' }, composeKnopf, zipKnopf, unraidKnopf, importKnopf), unraidText) : el('div', { klasse: 'ap-werkzeuge' }, unraidText);
    const trefferText = el('p', { klasse: 'ap-treffer vw-gedaempft' });
    const listeKatalog = el('div', { klasse: 'ap-liste ap-katalog' });
    const mehrKnopf = knopf(t('apps.katalog_mehr'), { art: 'zweit', beiKlick: () => ladeKatalog(false, true) });
    const mehrBereich = el('div', { klasse: 'ap-mehr' }, mehrKnopf); mehrBereich.hidden = true;
    panelKatalog.append(werkzeugleiste, filterleiste, trefferText, listeKatalog, mehrBereich);

    let katalogGeladen = false; let katalogLauf = 0; let seite = 1; let gezeigt = 0; let gesamt = 0; let kategorienGesetzt = false; let quellen = quellenInfo(null);
    /** Katalog-IDs, aus denen schon eine App installiert ist (A2: `installiert:[{name, katalog_id}]` in apps.katalog.liste) */
    let installierteIds = new Set();
    let sucheTimer = null;
    suche.addEventListener('input', () => { clearTimeout(sucheTimer); sucheTimer = setTimeout(() => ladeKatalog(true), SUCHE_VERZOEGERUNG_MS); });
    abmelder.push(() => clearTimeout(sucheTimer));
    kategorieWahl.addEventListener('change', () => ladeKatalog(true));
    quelleWahl.addEventListener('change', () => ladeKatalog(true));

    function katalogParams() {
      const p = { seite, je_seite: KATALOG_JE_SEITE };
      if (suche.value.trim()) p.suche = suche.value.trim();
      if (kategorieWahl.value) p.kategorie = kategorieWahl.value;
      if (quelleWahl.value) p.quelle = quelleWahl.value;
      return p;
    }

    async function ladeKatalog(neu = true, mehr = false) {
      const lauf = ++katalogLauf;
      if (mehr) seite += 1; else seite = 1;
      if (!mehr) { leeren(listeKatalog); listeKatalog.appendChild(leerHinweis(t('apps.katalog_laden'))); mehrBereich.hidden = true; trefferText.textContent = ''; }
      mehrKnopf.disabled = true;
      let r;
      try { r = await api(ctx, 'apps.katalog.liste', katalogParams()); } catch (e) {
        if (lauf !== katalogLauf) return;
        if (!mehr) { leeren(listeKatalog); listeKatalog.appendChild(hinweis(`${t('apps.katalog_fehl')} ${fehlerText(e)}`, 'fehler')); }
        mehrKnopf.disabled = false;
        return;
      }
      if (lauf !== katalogLauf) return;
      katalogGeladen = true;
      const eintraege = listeAus(r, 'eintraege', 'vorlagen', 'katalog');
      gesamt = r && Number.isFinite(Number(r.gesamt)) ? Number(r.gesamt) : eintraege.length;
      quellen = quellenInfo(r);
      if (quellen.unraid.zeit) unraidStand = quellen.unraid.zeit;
      if (r && Array.isArray(r.installiert)) installierteIds = new Set(r.installiert.map((x) => (x && typeof x === 'object' ? String(x.katalog_id || '') : String(x))).filter(Boolean));
      unraidAnzeigen();
      if (!kategorienGesetzt && r && Array.isArray(r.kategorien) && r.kategorien.length) {
        kategorienGesetzt = true;
        for (const k of r.kategorien) kategorieWahl.appendChild(el('option', { wert: String(typeof k === 'object' ? k.name : k), text: String(typeof k === 'object' ? `${k.name} (${k.anzahl})` : k) }));
      }
      if (!mehr) { leeren(listeKatalog); gezeigt = 0; }
      if (!eintraege.length && !mehr) {
        const unraidLeer = (quellen.unraid.anzahl === 0 || quellen.unraid.anzahl === null) && !unraidStand;
        listeKatalog.appendChild(leerZustand('suchen', t(unraidLeer && !suche.value.trim() && !kategorieWahl.value ? 'apps.katalog_leer_unraid' : 'apps.katalog_leer')));
      }
      for (const e of eintraege) listeKatalog.appendChild(katalogKarte(e));
      gezeigt += eintraege.length;
      trefferText.textContent = gesamt ? t('apps.katalog_treffer', { gezeigt, gesamt }) : '';
      mehrBereich.hidden = gezeigt >= gesamt || !eintraege.length;
      mehrKnopf.disabled = false;
      void neu;
    }

    function unraidAnzeigen() {
      const n = quellen.unraid.anzahl;
      if (unraidStand || (n !== null && n > 0)) {
        unraidText.textContent = t('apps.unraid_stand', { anzahl: n !== null ? n : '–', zeit: unraidStand ? fmt.zeit(unraidStand) : '–' });
        if (unraidKnopf) unraidKnopf.textContent = t('apps.unraid_erneuern');
      } else {
        unraidText.textContent = t('apps.unraid_nicht_geladen');
        if (unraidKnopf) unraidKnopf.textContent = t('apps.unraid_laden');
      }
    }

    function katalogKarte(e) {
      const quelle = String(e.quelle || '');
      const badges = el('div', { klasse: 'vw-badges ap-badges' });
      badges.appendChild(badge(e.kategorie ? String(e.kategorie) : t('apps.kategorie_ohne')));
      if (QUELLE_TEXT[quelle]) badges.appendChild(badge(t(QUELLE_TEXT[quelle]), undefined, quelle === 'eingebaut' ? 'akzent' : quelle === 'eigen' ? 'warnung' : ''));
      if (installierteIds.has(String(e.id))) badges.appendChild(badge(t('apps.katalog_installiert'), t('apps.katalog_installiert_titel'), 'erfolg'));
      const knoepfe = el('div', { klasse: 'vw-knopfleiste ap-knoepfe' });
      if (admin) {
        knoepfe.appendChild(knopf(t('apps.installieren'), { beiKlick: () => dialogInstallieren(e) }));
        if (quelle === 'eigen') knoepfe.appendChild(knopf(t('apps.vorlage_entfernen'), { art: 'zweit', beiKlick: () => vorlageEntfernen(e) }));
      }
      const beschreibung = String(e.beschreibung || t('apps.beschreibung_fehlt'));
      return el('section', { klasse: 'karte vw-karte ap-karte ap-katalog-karte', daten: { katalog: e.id } },
        el('div', { klasse: 'ap-kopf' }, appSymbol(e.symbol, e.name), el('div', { klasse: 'ap-kopf-text' }, el('h2', { klasse: 'ap-titel', text: e.name || e.id }), el('p', { klasse: 'ap-name vw-mono vw-gedaempft', text: e.id }))),
        badges,
        el('p', { klasse: 'ap-beschreibung', text: beschreibung, attr: { title: beschreibung.length > 160 ? beschreibung : undefined } }),
        knoepfe.childNodes.length ? knoepfe : null);
    }

    async function vorlageEntfernen(e) {
      if (!(await bestaetigen(ctx, t('apps.vorlage_entfernen_frage', { name: e.name || e.id })))) return;
      try { await api(ctx, 'apps.katalog.loeschen', { id: e.id }); melden(ctx, t('apps.vorlage_entfernt', { name: e.name || e.id }), 'erfolg'); await ladeKatalog(true); } catch (err) { melden(ctx, fehlerText(err), 'fehler'); }
    }

    async function unraidLaden() {
      try {
        const r = await aufgabeStarten(ctx, 'apps.katalog.unraid_laden', {}, aufgabenTexte(t('apps.unraid_titel'), t('apps.unraid_laeuft')));
        unraidStand = (r && r.zeit) || new Date().toISOString();
        if (r && Number.isFinite(Number(r.anzahl))) quellen.unraid.anzahl = Number(r.anzahl);
        melden(ctx, t('apps.unraid_fertig', { anzahl: r && r.anzahl !== undefined ? r.anzahl : '–' }), 'erfolg');
        unraidAnzeigen();
        await ladeKatalog(true);
      } catch { /* im Aufgabendialog gezeigt */ }
    }

    /** Eigene App aus einer Compose-Datei: einfügen oder Datei wählen → eigene Vorlage → direkt der Installieren-Dialog. */
    function dialogCompose() {
      const form = el('form', { klasse: 'ap-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const titel = eingabe({ platzhalter: t('apps.compose_name_platzhalter'), autocomplete: 'off', maxlength: 100 });
      const text = textbereich({ zeilen: 16, klasse: 'vw-mono ap-import-text', platzhalter: 'services:\n  meine-app:\n    image: …\n    ports:\n      - "8080:80"\n    volumes:\n      - ./daten:/data' });
      const datei = el('input', { typ: 'file', attr: { accept: '.yml,.yaml,text/yaml,application/x-yaml,text/plain' } });
      datei.addEventListener('change', async () => {
        const f = datei.files && datei.files[0]; if (!f) return;
        if (f.size > 200_000) { fz.zeigen(t('apps.compose_zu_gross')); return; }
        text.value = await f.text();
        if (!titel.value.trim()) titel.value = f.name.replace(/\.(ya?ml)$/i, '').replace(/^docker-compose$|^compose$/i, '');
      });
      form.append(fz.element,
        el('p', { klasse: 'erklaerung', text: t('apps.compose_erklaerung') }),
        feld({ label: t('apps.compose_name'), erklaerung: t('apps.compose_name_erklaerung'), eingabe: titel }),
        feld({ label: t('apps.compose_datei'), erklaerung: t('apps.compose_datei_erklaerung'), eingabe: datei }),
        feld({ label: t('apps.compose_text'), erklaerung: t('apps.compose_text_erklaerung'), eingabe: text }));
      const griff = dialogOeffnen({ ctx, titel: t('apps.compose_titel'), inhalt: form, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.compose_weiter'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([
          { eingabe: titel, pruefen: (w) => (w.trim() ? null : t('apps.compose_name_fehler')) },
          { eingabe: text, pruefen: (w) => (/\bservices\s*:/.test(w) ? null : t('apps.compose_text_fehler')) },
        ], fz)) return;
        griff.beschaeftigt(true);
        try {
          const r = await api(ctx, 'apps.katalog.importieren', { compose: text.value, titel: titel.value.trim() });
          griff.schliessen();
          quelleWahl.value = 'eigen';
          ladeKatalog(true);
          dialogInstallieren(r && r.id ? r : { id: r && r.id, name: titel.value.trim() });
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); form.scrollTop = 0; }
      });
    }

    function dialogImportieren() {
      const form = el('form', { klasse: 'ap-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const text = textbereich({ zeilen: 10, klasse: 'vw-mono ap-import-text', platzhalter: '<?xml version="1.0"?>\n<Container …' });
      const url = eingabe({ typ: 'url', platzhalter: 'https://…', autocomplete: 'off', spellcheck: false, klasse: 'vw-mono' });
      const bereichText = el('div', {}, feld({ label: t('apps.importieren_text'), eingabe: text }));
      const bereichUrl = el('div', {}, feld({ label: t('apps.importieren_adresse'), eingabe: url })); bereichUrl.hidden = true;
      const art = radiogruppe({ wert: 'xml', optionen: [
        { wert: 'xml', text: t('apps.importieren_xml'), erklaerung: t('apps.importieren_xml_erklaerung') },
        { wert: 'url', text: t('apps.importieren_url'), erklaerung: t('apps.importieren_url_erklaerung') },
      ], beiWechsel: (w) => { bereichText.hidden = w !== 'xml'; bereichUrl.hidden = w !== 'url'; } });
      form.append(fz.element, el('p', { klasse: 'erklaerung', text: t('apps.importieren_erklaerung') }), el('div', { klasse: 'vw-feld' }, art.element), bereichText, bereichUrl);
      const griff = dialogOeffnen({ ctx, titel: t('apps.importieren_titel'), inhalt: form, breit: true, schliessenText: t('apps.schliessen'),
        knoepfe: [{ text: t('apps.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() }, { text: t('apps.importieren_knopf'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const perUrl = art.wert() === 'url';
        const ok = perUrl
          ? felderPruefen([{ eingabe: url, pruefen: (w) => (/^https:\/\/\S+$/i.test(w.trim()) ? null : t('apps.importieren_adresse_fehler')) }], fz)
          : felderPruefen([{ eingabe: text, pruefen: (w) => (w.trim() ? null : t('apps.importieren_text_fehler')) }], fz);
        if (!ok) return;
        griff.beschaeftigt(true);
        try {
          const r = await api(ctx, 'apps.katalog.importieren', perUrl ? { url: url.value.trim() } : { xml: text.value });
          melden(ctx, t('apps.importiert', { name: (r && (r.name || r.id)) || '?' }), 'erfolg');
          griff.schliessen();
          quelleWahl.value = 'eigen';
          await ladeKatalog(true);
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); form.scrollTop = 0; }
      });
    }

    // ---- Start, Ereignisse, Takt ------------------------------------------------------------------------------------
    await ladeApps();
    if (admin && typeof ctx.route === 'object' && ctx.route && Array.isArray(ctx.route.teile) && ctx.route.teile[0] === 'katalog') reiterWaehlen('katalog');
    // Direktsprung aus FAH-Git („Auf FAH-NAS bauen“): #/apps/fahgit/<projektpfad>/<zweig>
    if (admin && ctx.route && Array.isArray(ctx.route.teile) && ctx.route.teile[0] === 'fahgit') dialogFahgit({ pfad: ctx.route.teile[1] || '', zweig: ctx.route.teile[2] || '' });
    let ereignisTimer = null;
    abmelder.push(abo(ctx, 'konfig', (e) => {
      const d = e && e.daten ? e.daten : e;
      if (d && d.bereich && d.bereich !== 'apps') return;
      clearTimeout(ereignisTimer); ereignisTimer = setTimeout(() => ladeApps(true), 300);
    }));
    abmelder.push(() => clearTimeout(ereignisTimer));
    const takt = setInterval(() => { if (aktiverReiter === 'installiert' && apps.length && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) ladeApps(true); }, RESSOURCEN_TAKT_MS);
    timer.push(takt);
  },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    for (const z of timer.splice(0)) { clearTimeout(z); clearInterval(z); }
    alleDialogeSchliessen();
  },
};
