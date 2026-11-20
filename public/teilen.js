// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Öffentliche Linkseite (GET /link/<token>, ohne Anmeldung). Betreiber 16.10.2026: „Freigabelink soll das Ziel öffnen und
// nicht als ZIP herunterladen.“ Ordner: Kacheln mit Vorschaubildern (oder Liste), Unterordner durchklicken, Dateien im
// Betrachter ansehen (Bild, Video, Audio, PDF, Text) mit ← / →, einzeln herunterladen, „Alles herunterladen“ als ZIP.
// Datei-Link: Betrachter direkt auf der Seite. Alles kommt aus /link/<token>/{liste,datei,zip,vorschau} – nur innerhalb
// des geteilten Ziels (prüft der Agent). Kein innerHTML: Namen sind fremde Daten.

const TEXTE = {
  de: {
    laden: 'Wird geladen …', geteilt: 'Geteilt über FAH-NAS', gueltig_bis: 'Link gültig bis {zeit}', alles_zip: 'Alles herunterladen',
    ordner_zip: 'Ordner herunterladen', herunterladen: 'Herunterladen', leer: 'Dieser Ordner ist leer.', ordner: 'Ordner',
    ansicht_kacheln: 'Kacheln', ansicht_liste: 'Liste', schliessen: 'Schließen', zurueck: 'Vorherige', weiter: 'Nächste',
    eintraege: '{n} Einträge', eintrag: '1 Eintrag', nicht_abspielbar: 'Diese Datei kann der Browser nicht direkt abspielen – bitte herunterladen.',
    keine_ansicht: 'Für diese Datei gibt es keine Vorschau.', nur_vorschau: 'Verkleinerte Vorschau – das Original bekommst du über „Herunterladen“.',
    ungueltig: 'Dieser Link ist ungültig oder abgelaufen.', fehler: 'Der Inhalt ist gerade nicht erreichbar. Bitte versuche es später noch einmal.',
    bremse: 'Zu viele Versuche – bitte warte {s} Sekunden.', nicht_gefunden: 'Diese Datei oder diesen Ordner gibt es nicht mehr.', position: '{i} von {n}',
    gross: 'Die Datei ist zu groß für die Vorschau – bitte herunterladen.', start: 'Start',
  },
  en: {
    laden: 'Loading …', geteilt: 'Shared via FAH-NAS', gueltig_bis: 'Link valid until {zeit}', alles_zip: 'Download all',
    ordner_zip: 'Download folder', herunterladen: 'Download', leer: 'This folder is empty.', ordner: 'Folder',
    ansicht_kacheln: 'Tiles', ansicht_liste: 'List', schliessen: 'Close', zurueck: 'Previous', weiter: 'Next',
    eintraege: '{n} items', eintrag: '1 item', nicht_abspielbar: 'Your browser cannot play this file directly – please download it.',
    keine_ansicht: 'There is no preview for this file.', nur_vorschau: 'Reduced preview – download to get the original.',
    ungueltig: 'This link is invalid or has expired.', fehler: 'The content is currently unavailable. Please try again later.',
    bremse: 'Too many attempts – please wait {s} seconds.', nicht_gefunden: 'This file or folder no longer exists.', position: '{i} of {n}',
    gross: 'The file is too large for a preview – please download it.', start: 'Home',
  },
};
const SPRACHE = String(navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
document.documentElement.lang = SPRACHE;
function t(k, p = {}) { return String(TEXTE[SPRACHE][k] ?? TEXTE.de[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => (p[n] ?? '')); }

const TOKEN = decodeURIComponent((location.pathname.match(/^\/link\/([^/]+)/) || [])[1] || '');
const BASIS = `/link/${encodeURIComponent(TOKEN)}`;
const TEXT_MAX = 5 * 1024 * 1024;

// Dateiarten für den Betrachter (Endung, klein). Bilder ohne Browser-Unterstützung zeigt die Vorschau des NAS.
const ARTEN = [
  ['bild', /\.(jpe?g|png|gif|webp|avif|bmp|ico)$/i],
  ['bild_vorschau', /\.(heic|heif|tiff?|jxl|dng|cr2|nef|arw)$/i],
  ['video', /\.(mp4|m4v|webm|mov|ogv|mkv)$/i],
  ['audio', /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i],
  ['pdf', /\.pdf$/i],
  ['text', /\.(txt|md|log|csv|json|ya?ml|ini|conf|cfg|xml|srt|vtt|nfo|sh|py|js|ts|css)$/i],
];
function artVon(name) { for (const [a, m] of ARTEN) if (m.test(name)) return a; return 'sonst'; }
const SYMBOL = { bild: 'bild', bild_vorschau: 'bild', video: 'video', audio: 'audio', pdf: 'pdf', text: 'text', sonst: 'datei' };
function symbolFuer(e) {
  if (e.art === 'ordner') return 'ordner';
  if (/\.(zip|7z|rar|tar|gz|tgz|bz2|xz|zst)$/i.test(e.name)) return 'archiv';
  return SYMBOL[artVon(e.name)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------------------------------------------------
function el(tag, eig = {}, kinder = []) {
  const k = document.createElement(tag);
  for (const [n, w] of Object.entries(eig)) {
    if (w === undefined || w === null || w === false) continue;
    if (n === 'text') k.textContent = w;
    else if (n === 'klasse') k.className = w;
    else if (n.startsWith('on')) k.addEventListener(n.slice(2), w);
    else k.setAttribute(n, w === true ? '' : String(w));
  }
  for (const c of [].concat(kinder)) if (c !== null && c !== undefined && c !== false) k.append(c);
  return k;
}
function symbol(name, klasse = 'teilen-symbol') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg'); s.setAttribute('class', klasse); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use'); u.setAttribute('href', `/symbole.svg#symbol-${name}`); s.append(u);
  return s;
}
function groesse(b) {
  if (b === null || b === undefined || !Number.isFinite(Number(b))) return '';
  const n = Number(b); const e = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let w = n;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i++; }
  return `${i === 0 ? w : w.toLocaleString(SPRACHE, { maximumFractionDigits: w < 10 ? 1 : 0 })} ${e[i]}`;
}
function datum(iso, mitZeit = false) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(SPRACHE, mitZeit ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
const pfadVon = (ordner, name) => (ordner ? `${ordner}/${name}` : name);
const url = (weg, pfad, extra = '') => `${BASIS}/${weg}?pfad=${encodeURIComponent(pfad || '')}${extra}`;

/** Zustand aus der Adresse: #p=<ordner>&d=<datei im Betrachter> (Zurück-Taste schließt den Betrachter bzw. geht hoch). */
function zustandLesen() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { pfad: h.get('p') || '', datei: h.get('d') || '' };
}
function hashVon(pfad, datei = '') {
  const h = new URLSearchParams();
  if (pfad) h.set('p', pfad);
  if (datei) h.set('d', datei);
  const s = h.toString();
  return s ? `#${s}` : '#';
}

async function holen(pfad) {
  const r = await fetch(url('liste', pfad), { headers: { Accept: 'application/json' }, cache: 'no-store' });
  let j = null; try { j = await r.json(); } catch { j = null; }
  if (!r.ok || !j || !j.ok) {
    const f = (j && j.fehler) || {};
    const e = new Error(f.meldung || `HTTP ${r.status}`); e.code = f.code || ''; e.details = f.details || {}; e.status = r.status;
    throw e;
  }
  return j.ergebnis;
}

// ---------------------------------------------------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------------------------------------------------
const wurzel = document.getElementById('teilen');
let daten = null;          // letzte Antwort von /liste (Ordner)
let wurzelName = '';
let ansicht = null;        // 'kacheln' | 'liste' – null = automatisch (Kacheln, sobald Bilder/Videos da sind)
let betrachter = null;     // offenes Overlay {knoten, index, dateien}
let perKlick = false;      // Betrachter wurde in dieser Seite geöffnet → Schließen = Zurück
let laufNr = 0;

try { const a = localStorage.getItem('fahnas_teilen_ansicht'); if (a === 'kacheln' || a === 'liste') ansicht = a; } catch { /* privat */ }

function fehlerZeigen(e) {
  const text = e && e.code === 'E_BREMSE' ? t('bremse', { s: (e.details && e.details.warte_s) || 30 })
    : e && e.details && e.details.link === 'ungueltig' ? t('ungueltig')
      : e && e.code === 'E_NICHT_GEFUNDEN' ? t('nicht_gefunden') : t('fehler');
  wurzel.replaceChildren(el('div', { klasse: 'teilen-meldung' }, [symbol('link', 'teilen-meldung-symbol'), el('p', { text })]));
  wurzel.classList.add('teilen-leer');
}

function kopf(titel, unter, knoepfe) {
  return el('header', { klasse: 'teilen-kopf' }, [
    el('div', { klasse: 'teilen-kopf-text' }, [
      el('p', { klasse: 'teilen-marke' }, [symbol('link', 'teilen-symbol teilen-marke-symbol'), t('geteilt')]),
      el('h1', { klasse: 'teilen-titel', text: titel }),
      unter ? el('p', { klasse: 'teilen-schwach', text: unter }) : null,
    ]),
    el('div', { klasse: 'teilen-knoepfe' }, knoepfe),
  ]);
}

function knopfLink(text, href, symbolName, art = 'haupt') {
  return el('a', { klasse: `teilen-knopf teilen-knopf-${art}`, href, download: '' }, [symbol(symbolName), el('span', { text })]);
}

function ablaufText(d) { return d && d.ablauf ? t('gueltig_bis', { zeit: datum(d.ablauf, true) }) : ''; }

async function zeigen() {
  const nr = ++laufNr;
  const z = zustandLesen();
  let d;
  try { d = await holen(z.pfad); } catch (e) { if (nr === laufNr) { betrachterZu(true); fehlerZeigen(e); } return; }
  if (nr !== laufNr) return;
  wurzel.classList.remove('teilen-leer');
  wurzelName = d.name || '';
  document.title = `${d.name || 'FAH-NAS'} – FAH-NAS`;
  if (d.art === 'datei') {
    // Datei-Link (oder ein Pfad, der auf eine Datei zeigt): Betrachter direkt auf der Seite
    betrachterZu(true);
    daten = null;
    const e = d.eintrag;
    const p = d.pfad || '';
    wurzel.replaceChildren(
      kopf(e.name, [groesse(e.groesse), ablaufText(d)].filter(Boolean).join(' · '), [knopfLink(t('herunterladen'), url('datei', p), 'herunterladen')]),
      el('section', { klasse: 'teilen-einzeln' }, [inhaltFuer(e, p, true)]),
    );
    return;
  }
  daten = d;
  ordnerZeigen(d);
  // Betrachter laut Adresse (Zurück/Vor, geteilte Adresse mit #d=…)
  if (z.datei) {
    const dateien = d.eintraege.filter((x) => x.art === 'datei');
    const i = dateien.findIndex((x) => x.name === z.datei);
    if (i >= 0) betrachterAuf(dateien, i); else betrachterZu(true);
  } else betrachterZu(true);
}

function brotkrumen(pfad) {
  if (!pfad) return null;
  const teile = pfad.split('/');
  const nav = el('nav', { klasse: 'teilen-pfad', 'aria-label': t('ordner') });
  nav.append(el('a', { href: hashVon(''), text: wurzelName || t('start') }));
  teile.forEach((teil, i) => {
    nav.append(el('span', { klasse: 'teilen-pfad-trenner', 'aria-hidden': 'true', text: '›' }));
    if (i === teile.length - 1) nav.append(el('span', { 'aria-current': 'page', text: teil }));
    else nav.append(el('a', { href: hashVon(teile.slice(0, i + 1).join('/')), text: teil }));
  });
  return nav;
}

function ordnerZeigen(d) {
  const pfad = d.pfad || '';
  const eintraege = Array.isArray(d.eintraege) ? d.eintraege : [];
  const medien = eintraege.some((e) => e.vorschau);
  const wirksam = ansicht || (medien ? 'kacheln' : 'liste');
  const titel = pfad ? pfad.split('/').pop() : d.name;
  const anzahl = eintraege.length === 1 ? t('eintrag') : t('eintraege', { n: eintraege.length });
  const umschalter = el('div', { klasse: 'teilen-umschalter', role: 'group' }, ['kacheln', 'liste'].map((a) => el('button', {
    type: 'button', klasse: 'teilen-knopf-symbol', 'aria-pressed': String(wirksam === a), title: t(`ansicht_${a}`), 'aria-label': t(`ansicht_${a}`),
    onclick: () => { ansicht = a; try { localStorage.setItem('fahnas_teilen_ansicht', a); } catch { /* privat */ } ordnerZeigen(daten); },
  }, [symbol(a)])));
  const knoepfe = [umschalter];
  if (eintraege.length) knoepfe.push(knopfLink(pfad ? t('ordner_zip') : t('alles_zip'), url('zip', pfad), 'herunterladen'));
  const inhalt = eintraege.length
    ? (wirksam === 'kacheln' ? kachelnBauen(eintraege, pfad) : listeBauen(eintraege, pfad))
    : el('p', { klasse: 'teilen-schwach teilen-leer-text', text: t('leer') });
  wurzel.replaceChildren(...[kopf(titel, [anzahl, ablaufText(d)].filter(Boolean).join(' · '), knoepfe), brotkrumen(pfad), inhalt].filter(Boolean)); // replaceChildren macht aus null den Text „null“
}

/** Ordner: hinein; Datei: Betrachter (über die Adresse – „hashchange“ öffnet ihn, die Zurück-Taste schließt ihn). */
function oeffnen(e, pfad) {
  if (e.art === 'ordner') { location.hash = hashVon(pfadVon(pfad, e.name)); return; }
  perKlick = true;
  location.hash = hashVon(pfad, e.name);
}

/** Vorschaubild des NAS (`p` = voller Pfad im Link, bei einem Datei-Link „“); Fehler → Symbol. */
function vorschaubild(e, p, px) {
  const img = el('img', { klasse: 'teilen-bild', alt: '', loading: 'lazy', decoding: 'async', src: url('vorschau', p, `&groesse=${px}`) });
  img.addEventListener('error', () => img.replaceWith(symbol(symbolFuer(e), 'teilen-symbol teilen-symbol-gross')), { once: true });
  return img;
}

function kachelnBauen(eintraege, pfad) {
  const ul = el('ul', { klasse: 'teilen-kacheln', role: 'list' });
  for (const e of eintraege) {
    const bild = e.vorschau ? vorschaubild(e, pfadVon(pfad, e.name), 256) : symbol(symbolFuer(e), 'teilen-symbol teilen-symbol-gross');
    const knopf = el('button', { type: 'button', klasse: 'teilen-kachel', title: e.name, onclick: () => oeffnen(e, pfad) }, [
      el('span', { klasse: `teilen-kachel-bild${e.art === 'ordner' ? ' teilen-kachel-ordner' : ''}` }, [bild,
        artVon(e.name) === 'video' && e.art === 'datei' ? el('span', { klasse: 'teilen-abspielen', 'aria-hidden': 'true' }) : null]),
      el('span', { klasse: 'teilen-kachel-name', text: e.name }),
      el('span', { klasse: 'teilen-kachel-info', text: e.art === 'ordner' ? t('ordner') : groesse(e.groesse) }),
    ]);
    ul.append(el('li', {}, [knopf]));
  }
  return ul;
}

function listeBauen(eintraege, pfad) {
  const ul = el('ul', { klasse: 'teilen-liste', role: 'list' });
  for (const e of eintraege) {
    const p = pfadVon(pfad, e.name);
    const bild = e.vorschau ? vorschaubild(e, p, 128) : symbol(symbolFuer(e), 'teilen-symbol');
    const zeile = el('li', { klasse: 'teilen-zeile' }, [
      el('button', { type: 'button', klasse: 'teilen-zeile-haupt', onclick: () => oeffnen(e, pfad) }, [
        el('span', { klasse: 'teilen-zeile-bild' }, [bild]),
        el('span', { klasse: 'teilen-zeile-name', text: e.name }),
        el('span', { klasse: 'teilen-zeile-info', text: e.art === 'ordner' ? '' : groesse(e.groesse) }),
        el('span', { klasse: 'teilen-zeile-info teilen-zeile-datum', text: datum(e.geaendert) }),
      ]),
      el('a', {
        klasse: 'teilen-knopf-symbol', href: e.art === 'ordner' ? url('zip', p) : url('datei', p), download: '',
        title: e.art === 'ordner' ? t('ordner_zip') : t('herunterladen'), 'aria-label': `${e.art === 'ordner' ? t('ordner_zip') : t('herunterladen')}: ${e.name}`,
      }, [symbol('herunterladen')]),
    ]);
    ul.append(zeile);
  }
  return ul;
}

// ---------------------------------------------------------------------------------------------------------------------
// Betrachter
// ---------------------------------------------------------------------------------------------------------------------

/** Inhalt für eine Datei: Bild, Video, Audio, PDF, Text – sonst Symbol mit Hinweis. `einzeln` = Datei-Link ohne Overlay. */
function inhaltFuer(e, p, einzeln = false) {
  const art = artVon(e.name);
  const anzeigen = url('datei', p, '&anzeigen=1');
  const hinweis = (text) => el('p', { klasse: 'teilen-hinweis', text });
  const ersatz = (text) => el('div', { klasse: 'teilen-ersatz' }, [
    e.vorschau ? vorschaubild(e, p, 512) : symbol(symbolFuer(e), 'teilen-symbol teilen-symbol-riesig'),
    hinweis(text),
    einzeln ? null : knopfLink(t('herunterladen'), url('datei', p), 'herunterladen'),
  ]);
  if (art === 'bild') {
    const img = el('img', { klasse: 'teilen-voll', alt: e.name, src: anzeigen, decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(ersatz(t('keine_ansicht'))), { once: true });
    return img;
  }
  if (art === 'bild_vorschau') {
    const img = vorschaubild(e, p, 512); img.classList.add('teilen-voll');
    return el('figure', { klasse: 'teilen-figur' }, [img, el('figcaption', { klasse: 'teilen-hinweis', text: t('nur_vorschau') })]);
  }
  if (art === 'video') {
    const v = el('video', { klasse: 'teilen-voll', controls: true, playsinline: true, preload: 'metadata', src: anzeigen });
    v.addEventListener('error', () => v.replaceWith(ersatz(t('nicht_abspielbar'))), { once: true });
    return v;
  }
  if (art === 'audio') {
    const a = el('audio', { klasse: 'teilen-audio', controls: true, preload: 'metadata', src: anzeigen });
    a.addEventListener('error', () => a.replaceWith(ersatz(t('nicht_abspielbar'))), { once: true });
    return el('div', { klasse: 'teilen-ersatz' }, [symbol('audio', 'teilen-symbol teilen-symbol-riesig'), a]);
  }
  if (art === 'pdf') return el('iframe', { klasse: 'teilen-rahmen', title: e.name, src: anzeigen });
  if (art === 'text') {
    if (Number(e.groesse) > TEXT_MAX) return ersatz(t('gross'));
    return el('iframe', { klasse: 'teilen-rahmen teilen-rahmen-text', title: e.name, src: anzeigen, sandbox: '' });
  }
  return ersatz(t('keine_ansicht'));
}

function betrachterAuf(dateien, index) {
  if (!daten || index < 0 || index >= dateien.length) return;
  const pfad = daten.pfad || '';
  const e = dateien[index];
  const p = pfadVon(pfad, e.name);
  const gehe = (r) => {
    const n = (index + r + dateien.length) % dateien.length;
    history.replaceState(null, '', hashVon(pfad, dateien[n].name));
    betrachterAuf(dateien, n);
  };
  const mehrere = dateien.length > 1;
  const zu = el('button', { type: 'button', klasse: 'teilen-knopf-symbol teilen-hell', title: t('schliessen'), 'aria-label': t('schliessen'), onclick: () => betrachterSchliessen() }, [symbol('schliessen')]);
  const knoten = el('div', { klasse: 'teilen-betrachter', role: 'dialog', 'aria-modal': 'true', 'aria-label': e.name }, [
    el('div', { klasse: 'teilen-betrachter-kopf' }, [
      el('div', { klasse: 'teilen-betrachter-titel' }, [
        el('strong', { text: e.name }),
        el('span', { klasse: 'teilen-hell-schwach', text: [groesse(e.groesse), mehrere ? t('position', { i: index + 1, n: dateien.length }) : ''].filter(Boolean).join(' · ') }),
      ]),
      el('a', { klasse: 'teilen-knopf-symbol teilen-hell', href: url('datei', p), download: '', title: t('herunterladen'), 'aria-label': t('herunterladen') }, [symbol('herunterladen')]),
      zu,
    ]),
    el('div', { klasse: 'teilen-betrachter-flaeche', onclick: (ev) => { if (ev.target === ev.currentTarget) betrachterSchliessen(); } }, [inhaltFuer(e, p)]),
    mehrere ? el('button', { type: 'button', klasse: 'teilen-pfeil teilen-pfeil-links', title: t('zurueck'), 'aria-label': t('zurueck'), onclick: () => gehe(-1) }, [symbol('zurueck')]) : null,
    mehrere ? el('button', { type: 'button', klasse: 'teilen-pfeil teilen-pfeil-rechts', title: t('weiter'), 'aria-label': t('weiter'), onclick: () => gehe(1) }, [symbol('weiter')]) : null,
  ]);
  if (betrachter) betrachter.knoten.replaceWith(knoten); else { document.body.append(knoten); document.body.classList.add('teilen-gesperrt'); }
  betrachter = { knoten, gehe };
  // Wischen auf dem Handy: links/rechts blättern
  let startX = null;
  knoten.addEventListener('touchstart', (ev) => { startX = ev.touches.length === 1 ? ev.touches[0].clientX : null; }, { passive: true });
  knoten.addEventListener('touchend', (ev) => {
    if (startX === null || !mehrere) return;
    const dx = ev.changedTouches[0].clientX - startX; startX = null;
    if (Math.abs(dx) > 60) gehe(dx < 0 ? 1 : -1);
  });
  zu.focus({ preventScroll: true });
}

/** Overlay entfernen (ohne die Adresse anzufassen). */
function betrachterZu(still = false) {
  if (!betrachter) return;
  betrachter.knoten.remove(); betrachter = null;
  document.body.classList.remove('teilen-gesperrt');
  if (!still) perKlick = false;
}

/** Schließen per Knopf/Esc: war er per Klick geöffnet, geht die Seite einen Schritt zurück (Zurück-Taste bleibt stimmig). */
function betrachterSchliessen() {
  const z = zustandLesen();
  betrachterZu(true);
  if (perKlick) { perKlick = false; history.back(); } else history.replaceState(null, '', hashVon(z.pfad));
}

document.addEventListener('keydown', (ev) => {
  if (!betrachter) return;
  if (ev.key === 'Escape') { ev.preventDefault(); betrachterSchliessen(); } else if (ev.key === 'ArrowRight') { ev.preventDefault(); betrachter.gehe(1); } else if (ev.key === 'ArrowLeft') { ev.preventDefault(); betrachter.gehe(-1); }
});

window.addEventListener('hashchange', () => {
  const z = zustandLesen();
  // nur der Betrachter wechselt (gleicher Ordner) → ohne neu zu laden
  if (daten && (daten.pfad || '') === z.pfad) {
    if (!z.datei) { betrachterZu(true); perKlick = false; return; }
    const dateien = daten.eintraege.filter((x) => x.art === 'datei');
    const i = dateien.findIndex((x) => x.name === z.datei);
    if (i >= 0) { betrachterAuf(dateien, i); return; }
  }
  zeigen();
});

wurzel.replaceChildren(el('p', { klasse: 'teilen-schwach teilen-laden', text: t('laden') }));
zeigen();
