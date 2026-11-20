// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Darstellung je Nutzer (Betreiber 12.10.2026: „themes wie bei allinone mit animiertem Hintergrund … animierte wallpaper
// oder videos … individuell für jeden nutzer“): Themes (Hell/Dunkel/System + Midnight, Ocean, Steampunk, Cyberpunk aus
// allinone), Akzentfarbe, Hintergrund (aus, Circuit, Polygone, eigene Tapete als Bild/GIF/Video mit Abdunkeln) und
// Glas-Look wie macOS/iOS (Betreiber 12.10.2026: „transparenz modus (glass look) … wie transparent es sein soll“).
// Tapete seit 15.10.2026 aus der eigenen Sammlung ({quelle:'eigen', id}) oder einem Freigabe-Ordner ({quelle:'ordner',
// freigabe, pfad}, gelesen mit den Rechten des Nutzers) und mit wählbarer Skalierung (Füllen, Einpassen, Strecken,
// Zentriert, Kacheln – Kacheln nur bei Bildern). Seit 16.10.2026 Zoom (Betreiber: „schieberegler um den zoom für das bild
// anzupassen … immer ausgehend vom nas screen“): 100 % = so, wie die Skalierung die Tapete auf dem Bildschirm zeigt,
// darüber/darunter vergrößert bzw. verkleinert zur Bildschirmmitte hin. Ebenfalls 16.10.2026 Skalierung „Automatisch“ als
// Standard (Betreiber: „4K … wirken vergrößert … sollten den bildschirm ohne ränder ausfüllen – korrekt aber das ganze bild
// darstellen. immer automatisch nach browserfenstergröße“): ganzes Bild, Abweichung im Seitenverhältnis bis 5 % unmerklich
// gestreckt (füllt dann randlos), darüber hinaus füllt eine unscharfe Kopie den Rest – neu gerechnet bei jeder Fenstergröße.
// Gespeichert in den persönlichen Einstellungen (Bereich „darstellung“), im Browser zwischengespeichert für sofortiges
// Anzeigen. Die Animationen stammen aus allinone (Circuit-Pulse, Polygon-Netz) und folgen der Akzentfarbe.

export const THEMES = Object.freeze([
  { id: 'auto', muster: 'linear-gradient(135deg, #ffffff 50%, #1c1f23 50%)' },
  { id: 'hell', muster: '#ffffff' },
  { id: 'dunkel', muster: '#1c1f23' },
  { id: 'midnight', muster: 'linear-gradient(135deg, #07030d 45%, #a855f7)', dunkel: true },
  { id: 'ocean', muster: 'linear-gradient(135deg, #0a1628 45%, #0ea5e9)', dunkel: true },
  { id: 'steampunk', muster: 'linear-gradient(135deg, #1a1109 45%, #b87333)', dunkel: true },
  { id: 'cyberpunk', muster: 'linear-gradient(135deg, #0a0a0e 45%, #ff2a6d)', dunkel: true },
]);
export const AKZENTE = Object.freeze([
  { id: 'standard', farbe: null }, { id: 'violett', farbe: '#7c6fdb' }, { id: 'blau', farbe: '#3b82f6' }, { id: 'tuerkis', farbe: '#14b8a6' },
  { id: 'gruen', farbe: '#22c55e' }, { id: 'gelb', farbe: '#eab308' }, { id: 'orange', farbe: '#f97316' }, { id: 'rot', farbe: '#ef4444' },
  { id: 'pink', farbe: '#ec4899' }, { id: 'grau', farbe: '#6b7280' },
]);
export const HINTERGRUENDE = Object.freeze(['aus', 'circuit', 'polygone', 'tapete']);
export const SKALIERUNGEN = Object.freeze(['auto', 'fuellen', 'einpassen', 'strecken', 'mitte', 'kacheln']);
export const STANDARD = Object.freeze({ theme: 'auto', akzent: 'standard', hintergrund: 'aus', tapete: null, tapetenordner: null, skalierung: 'auto', zoom: 100, abdunkeln: 40, glas: false, transparenz: 45 });
export const ALT_ID = '000000000000';
const FREIGABE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID = /^[0-9a-f]{12}$/;
const V = /^[a-z0-9]{1,16}$/;

/** Relativer Pfad in einer Freigabe (ohne „..“, Steuerzeichen, führenden Schrägstrich) oder null. */
export function sichererPfad(p, leerErlaubt = false) {
  // eslint-disable-next-line no-control-regex
  if (typeof p !== 'string' || p.length > 1024 || /[\u0000-\u001f]/.test(p)) return null;
  const teile = p.split('/').filter((x) => x !== '' && x !== '.');
  if (teile.some((x) => x === '..')) return null;
  const r = teile.join('/');
  return r || leerErlaubt ? r : null;
}

/** Ordner-Angabe {freigabe, pfad} prüfen → gleiche Form oder null. */
export function normalOrdner(o) {
  if (!o || typeof o !== 'object' || !FREIGABE.test(String(o.freigabe || ''))) return null;
  const pfad = sichererPfad(o.pfad == null ? '' : o.pfad, true);
  return pfad === null ? null : { freigabe: o.freigabe, pfad };
}

/** Gewählte Tapete prüfen; die alte Form {art, v} (eine Datei je Nutzer) wird zur ersten Tapete der Sammlung. */
export function normalTapete(x) {
  if (!x || typeof x !== 'object' || !['bild', 'video'].includes(x.art) || !V.test(String(x.v || ''))) return null;
  const v = String(x.v);
  if (x.quelle === 'ordner') {
    const pfad = sichererPfad(x.pfad);
    return FREIGABE.test(String(x.freigabe || '')) && pfad ? { quelle: 'ordner', freigabe: x.freigabe, pfad, art: x.art, v } : null;
  }
  if (x.quelle === undefined) return { quelle: 'eigen', id: ALT_ID, art: x.art, v };
  return x.quelle === 'eigen' && ID.test(String(x.id || '')) ? { quelle: 'eigen', id: x.id, art: x.art, v } : null;
}

/** Adresse der Tapetendatei (eigene Sammlung oder Freigabe). */
export function tapeteUrl(t) {
  if (!t) return '';
  const k = encodeURIComponent;
  if (t.quelle === 'ordner') return `/api/dateien/herunterladen?freigabe=${k(t.freigabe)}&pfad=${k(t.pfad)}&anzeigen=1&v=${k(t.v)}`;
  return `/api/hintergrund?id=${k(t.id)}&v=${k(t.v)}`;
}

/** Gleiche Tapete? */
export function gleicheTapete(a, b) {
  if (!a || !b || a.quelle !== b.quelle) return false;
  return a.quelle === 'ordner' ? a.freigabe === b.freigabe && a.pfad === b.pfad : a.id === b.id;
}

/** Wirksame Skalierung: Videos lassen sich nicht kacheln → Automatisch. */
export function wirksameSkalierung(skalierung, tapete) { return skalierung === 'kacheln' && tapete && tapete.art === 'video' ? 'auto' : skalierung; }

/** Wirksamer Zoom in Prozent: bei „Automatisch“ immer 100 (der Regler ist dort gesperrt, das ganze Bild passt schon). */
export function wirksamerZoom(d) { return wirksameSkalierung(d.skalierung, d.tapete) === 'auto' ? 100 : d.zoom; }

/** Höchstens so viel Verzerrung gleicht „Automatisch“ aus (5 % fallen im Bild nicht auf). */
export const AUTO_TOLERANZ = 0.05;

/**
 * Größe der Tapete bei „Automatisch“: das ganze Bild (wie Einpassen), aber um bis zu `toleranz` im Seitenverhältnis
 * gestreckt, damit es das Fenster möglichst randlos füllt. `luecke` = es bleibt ein Rand (dann füllt die unscharfe Kopie).
 */
export function einpassMass(bild, fenster, toleranz = AUTO_TOLERANZ) {
  const W = fenster.w; const H = fenster.h;
  if (!(bild && bild.w > 0 && bild.h > 0 && W > 0 && H > 0)) return { w: W, h: H, luecke: false };
  const rb = bild.w / bild.h; const rf = W / H;
  let w; let h;
  if (rb >= rf) { w = W; h = Math.min(H, (W / rb) * (1 + toleranz)); } else { h = H; w = Math.min(W, H * rb * (1 + toleranz)); }
  w = Math.round(w); h = Math.round(h);
  return { w, h, luecke: w < W || h < H };
}
export const TRANSPARENZ = Object.freeze({ min: 10, max: 85 });
export const ZOOM = Object.freeze({ min: 50, max: 300, schritt: 5 });
const CACHE = 'fahnas_darstellung';

/** Eingaben auf gültige Werte bringen (fremde/alte Werte → Standard). */
export function normal(d) {
  const x = d && typeof d === 'object' ? d : {};
  const tapete = normalTapete(x.tapete);
  const ab = Number(x.abdunkeln);
  const tr = Number(x.transparenz);
  const zo = Number(x.zoom);
  return {
    theme: THEMES.some((t) => t.id === x.theme) ? x.theme : STANDARD.theme,
    akzent: AKZENTE.some((a) => a.id === x.akzent) ? x.akzent : STANDARD.akzent,
    hintergrund: HINTERGRUENDE.includes(x.hintergrund) && (x.hintergrund !== 'tapete' || tapete) ? x.hintergrund : 'aus',
    tapete,
    tapetenordner: normalOrdner(x.tapetenordner),
    skalierung: SKALIERUNGEN.includes(x.skalierung) ? x.skalierung : STANDARD.skalierung,
    zoom: x.zoom != null && Number.isFinite(zo) ? Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(zo / ZOOM.schritt) * ZOOM.schritt)) : STANDARD.zoom,
    abdunkeln: Number.isFinite(ab) ? Math.min(85, Math.max(0, Math.round(ab))) : STANDARD.abdunkeln,
    glas: x.glas === true,
    transparenz: Number.isFinite(tr) ? Math.min(TRANSPARENZ.max, Math.max(TRANSPARENZ.min, Math.round(tr))) : STANDARD.transparenz,
  };
}

/**
 * Glas-Werte zur Transparenz (Prozent Durchsicht): Deckung der Flächen und Unschärfe dahinter. Je klarer das Glas, desto
 * weniger Unschärfe – sonst verwischen feine Muster (Circuit) zu einer gleichmäßigen Fläche und das Glas wirkt deckend
 * (Betreiber-Fund 12.10.2026). 85 % ≈ 1 px (klares Glas), 45 % ≈ 10 px, 10 % ≈ 20 px (Milchglas).
 */
export function glasVariablen(transparenz) {
  const t = Math.min(TRANSPARENZ.max, Math.max(TRANSPARENZ.min, Number(transparenz) || STANDARD.transparenz));
  return { '--fahnas-glas-deckung': `${100 - t}%`, '--fahnas-glas-unschaerfe': `${Math.round(24 * (1 - t / 100) ** 1.5)}px` };
}

// ---- Farben ------------------------------------------------------------------------------------------------------
export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const rgbHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mischen = (a, b, anteil) => ({ r: a.r + (b.r - a.r) * anteil, g: a.g + (b.g - a.g) * anteil, b: a.b + (b.b - a.b) * anteil });
/** Relative Helligkeit (WCAG). */
export function helligkeit({ r, g, b }) {
  const k = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * k(r) + 0.7152 * k(g) + 0.0722 * k(b);
}

/** Akzent-Variablen für eine Farbe – passend zu hellem oder dunklem Design. */
export function akzentVariablen(hex, dunkel) {
  const c = hexRgb(hex);
  if (!c) return null;
  const weiss = { r: 255, g: 255, b: 255 }; const schwarz = { r: 0, g: 0, b: 0 };
  const flaeche = dunkel ? { r: 38, g: 42, b: 48 } : weiss;
  // Schrift auf dem Akzent: die Farbe mit dem besseren Kontrast (Weiß oder fast Schwarz)
  const L = helligkeit(c);
  const textAufAkzent = (1.05 / (L + 0.05)) >= ((L + 0.05) / (helligkeit({ r: 16, g: 20, b: 24 }) + 0.05)) ? '#ffffff' : '#101418';
  return {
    '--fahnas-akzent': rgbHex(c),
    '--fahnas-akzent-dunkel': rgbHex(mischen(c, dunkel ? weiss : schwarz, 0.18)),
    '--fahnas-akzent-hell': rgbHex(mischen(flaeche, c, dunkel ? 0.22 : 0.16)),
    '--fahnas-akzent-text': textAufAkzent,
    '--fahnas-akzent-auf-hell': rgbHex(mischen(c, dunkel ? weiss : schwarz, dunkel ? 0.35 : 0.35)),
    '--fahnas-fokus': rgbHex(c),
  };
}

function istDunkel(theme) {
  const t = THEMES.find((x) => x.id === theme);
  if (t && t.dunkel) return true;
  if (theme === 'dunkel') return true;
  if (theme === 'hell') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

// ---- Anwenden ----------------------------------------------------------------------------------------------------
let aktuell = normal(null);
let setzeDesignFn = null;

/**
 * Darstellung anwenden. `setzeDesign` (aus app.js) setzt data-design für Hell/Dunkel/System; Farbthemes setzen „dunkel“
 * plus data-theme. Der Akzent kommt als Inline-Variablen ans html-Element.
 */
export function anwenden(d, { setzeDesign } = {}) {
  if (setzeDesign) setzeDesignFn = setzeDesign;
  aktuell = normal(d);
  const root = document.documentElement;
  const farbtheme = THEMES.find((x) => x.id === aktuell.theme && x.dunkel);
  if (setzeDesignFn) setzeDesignFn(farbtheme ? 'dunkel' : aktuell.theme, false);
  if (farbtheme) root.dataset.theme = farbtheme.id; else delete root.dataset.theme;
  const akzent = AKZENTE.find((a) => a.id === aktuell.akzent);
  const vars = akzent && akzent.farbe ? akzentVariablen(akzent.farbe, istDunkel(aktuell.theme)) : null;
  for (const k of ['--fahnas-akzent', '--fahnas-akzent-dunkel', '--fahnas-akzent-hell', '--fahnas-akzent-text', '--fahnas-akzent-auf-hell', '--fahnas-fokus']) {
    if (vars) root.style.setProperty(k, vars[k]); else root.style.removeProperty(k);
  }
  root.dataset.hintergrund = aktuell.hintergrund;
  root.dataset.glas = aktuell.glas ? 'an' : 'aus';
  for (const [k, v] of Object.entries(glasVariablen(aktuell.transparenz))) root.style.setProperty(k, v);
  root.style.setProperty('--fahnas-abdunkeln', String(aktuell.abdunkeln / 100));
  root.dataset.skalierung = wirksameSkalierung(aktuell.skalierung, aktuell.tapete);
  root.style.setProperty('--fahnas-zoom', String(wirksamerZoom(aktuell) / 100));
  tapeteSetzen(aktuell.hintergrund === 'tapete' ? aktuell.tapete : null);
  tapeteEinpassen();
  muster.setzen(aktuell.hintergrund === 'circuit' || aktuell.hintergrund === 'polygone' ? aktuell.hintergrund : null);
  try { localStorage.setItem(CACHE, JSON.stringify(aktuell)); } catch { /* privater Modus */ }
  try { document.dispatchEvent(new CustomEvent('fahnas-darstellung')); } catch { /* ältere Umgebung */ } // z. B. Kachel „Tapete“
  return aktuell;
}

export function zwischengespeichert() { try { return normal(JSON.parse(localStorage.getItem(CACHE) || 'null')); } catch { return null; } }
export function aktuelleDarstellung() { return { ...aktuell }; }

// ---- Tapete (Bild/GIF/Video) ---------------------------------------------------------------------------------------
// Die Tapete gehört dem Konto (/api/hintergrund und Freigaben brauchen eine Sitzung). Vor der Anmeldung zeigt der
// Zwischenspeicher sie schon an – der Abruf scheitert dann mit 401. Scheitert das Laden, vergisst tapeteSetzen den
// Schlüssel, damit das nächste anwenden() (nach der Anmeldung) neu lädt, statt das tote Element stehen zu lassen
// (Betreiber-Fund 16.10.2026: „nach dem login ist das animated wallpaper weg“).
let tapeteKnoten = null; let tapeteSchluessel = '';
let tapeteVorn = null;     // das Bild/Video selbst (bei „Automatisch“ mit eigener Größe)
let tapeteMasse = null;    // {w, h} natürliche Größe, sobald bekannt
let unschaerfeTimer = 0;   // Video: unscharfe Kopie alle 250 ms nachzeichnen (nur wenn ein Rand bleibt)
let tapeteRand = false;
let tapeteBeobachter = null; // ResizeObserver auf der Tapetenfläche (Fenstergröße, Scrollleiste kommt/geht)
function tapeteSetzen(t) {
  const schluessel = t ? `${t.art}:${tapeteUrl(t)}` : '';
  if (schluessel === tapeteSchluessel) return;
  tapeteSchluessel = schluessel;
  if (tapeteKnoten) { tapeteKnoten.remove(); tapeteKnoten = null; }
  clearInterval(unschaerfeTimer); unschaerfeTimer = 0; tapeteVorn = null; tapeteMasse = null; tapeteRand = false;
  if (tapeteBeobachter) { tapeteBeobachter.disconnect(); tapeteBeobachter = null; }
  if (!t) return;
  const knoten = document.createElement('div');
  tapeteKnoten = knoten;
  knoten.className = 'fahnas-tapete';
  knoten.setAttribute('aria-hidden', 'true');
  const url = tapeteUrl(t);
  const gescheitert = () => { if (tapeteKnoten === knoten) tapeteSchluessel = ''; };
  const masse = (w, h) => { if (tapeteKnoten === knoten && w > 0 && h > 0) { tapeteMasse = { w, h }; tapeteEinpassen(); } };
  if (t.art === 'video') {
    // unscharfe Kopie für den Rand bei „Automatisch“: kleines Canvas, aus dem laufenden Video nachgezeichnet
    const unscharf = document.createElement('canvas');
    unscharf.className = 'fahnas-tapete-unschaerfe';
    unscharf.width = 64; unscharf.height = 36;
    knoten.appendChild(unscharf);
    const v = document.createElement('video');
    v.addEventListener('error', gescheitert);
    v.addEventListener('loadedmetadata', () => masse(v.videoWidth, v.videoHeight));
    tapeteVorn = v;
    unschaerfeTimer = setInterval(() => { if (tapeteRand && !document.hidden) unschaerfeZeichnen(v, unscharf); }, 250);
    Object.assign(v, { src: url, muted: true, loop: true, autoplay: true, playsInline: true, defaultMuted: true });
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) v.autoplay = false;
    knoten.appendChild(v);
    v.play?.().catch(() => { /* Autoplay blockiert – Standbild bleibt */ });
  } else {
    // Bild als CSS-Hintergrund: so gehen auch Zentriert und Kacheln (background-repeat); GIF/WebP bleiben animiert
    // CSS-Hintergründe melden keinen Fehler – ein unsichtbares Probe-Bild (gleiche Adresse, aus dem Cache) schon; es
    // liefert auch die natürliche Größe für „Automatisch“. Davor die unscharfe Kopie (nur bei „Automatisch“ sichtbar).
    const unscharf = document.createElement('div');
    unscharf.className = 'fahnas-tapete-unschaerfe';
    unscharf.style.backgroundImage = `url("${url}")`;
    const i = document.createElement('div');
    i.className = 'fahnas-tapete-bild';
    i.style.backgroundImage = `url("${url}")`;
    knoten.append(unscharf, i);
    tapeteVorn = i;
    if (typeof Image === 'function') { const probe = new Image(); probe.onerror = gescheitert; probe.onload = () => masse(probe.naturalWidth, probe.naturalHeight); probe.src = url; }
  }
  document.body.prepend(knoten);
  if (typeof ResizeObserver === 'function') { tapeteBeobachter = new ResizeObserver(() => tapeteEinpassen()); tapeteBeobachter.observe(knoten); }
}

/** „Automatisch“: Größe und Lage des Bildes zum Fenster setzen (sonst die festen CSS-Regeln der anderen Skalierungen). */
function tapeteEinpassen() {
  const vorn = tapeteVorn;
  if (!vorn) return;
  const auto = document.documentElement.dataset.skalierung === 'auto';
  const root = document.documentElement;
  if (!auto || !tapeteMasse) {
    for (const k of ['left', 'top', 'width', 'height']) vorn.style.removeProperty(k);
    tapeteRand = auto; // Maße noch unbekannt: unscharfe Kopie schon zeichnen lassen
    root.dataset.tapeteRand = auto ? 'unbekannt' : 'nein';
    return;
  }
  // Fläche der Tapete selbst (ohne Scrollleiste), nicht innerWidth
  const W = (tapeteKnoten && tapeteKnoten.clientWidth) || window.innerWidth; const H = (tapeteKnoten && tapeteKnoten.clientHeight) || window.innerHeight;
  const m = einpassMass(tapeteMasse, { w: W, h: H });
  vorn.style.left = `${Math.round((W - m.w) / 2)}px`; vorn.style.top = `${Math.round((H - m.h) / 2)}px`;
  vorn.style.width = `${m.w}px`; vorn.style.height = `${m.h}px`;
  tapeteRand = m.luecke;
  // ohne Rand keine Unschärfe-Ebene; mit Rand läuft die Bildkante weich in die unscharfe Kopie aus (seitlich oder oben/unten)
  root.dataset.tapeteRand = !m.luecke ? 'nein' : m.w < W ? 'seiten' : 'oben';
}

/** Unscharfe Kopie eines Videobilds wie „Füllen“ ins kleine Canvas (das CSS zieht es groß und weich). */
function unschaerfeZeichnen(v, c) {
  if (v.readyState < 2 || !v.videoWidth) return;
  const g = c.getContext('2d'); if (!g) return;
  const rc = ((tapeteKnoten && tapeteKnoten.clientWidth) || window.innerWidth || 16) / ((tapeteKnoten && tapeteKnoten.clientHeight) || window.innerHeight || 9);
  const ch = Math.max(8, Math.round(64 / rc));
  if (c.height !== ch) c.height = ch;
  const rv = v.videoWidth / v.videoHeight;
  let sw = v.videoWidth; let sh = v.videoHeight;
  if (rv > rc) sw = sh * rc; else sh = sw / rc;
  try { g.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height); } catch { /* Bild noch nicht bereit */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof ResizeObserver !== 'function') {
  let geplant = false;
  window.addEventListener('resize', () => { if (geplant) return; geplant = true; requestAnimationFrame(() => { geplant = false; tapeteEinpassen(); }); });
}

// ---- Animierte Muster (aus allinone: Circuit-Pulse und Polygon-Netz) -----------------------------------------------
const muster = (() => {
  let canvas = null; let ctx = null; let art = null; let raf = 0; let w = 0; let h = 0;
  let nodes = []; let edges = []; let pulses = []; let verts = []; let tris = [];
  let farbe = { r: 11, g: 114, b: 114 }; let hell = false; let resizeTO = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  const rgba = (a) => `rgba(${farbe.r},${farbe.g},${farbe.b},${a})`;
  const bewegungAus = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function farbeLesen() {
    try {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;color:var(--fahnas-akzent)';
      document.body.appendChild(probe);
      const m = getComputedStyle(probe).color.match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
      probe.remove();
      if (m) farbe = { r: +m[1], g: +m[2], b: +m[3] };
    } catch { /* Standard */ }
    hell = !istDunkel(aktuell.theme);
  }
  function kante(a, b, waagerechtZuerst) {
    const ecke = waagerechtZuerst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const l1 = Math.hypot(ecke.x - a.x, ecke.y - a.y); const l2 = Math.hypot(b.x - ecke.x, b.y - ecke.y);
    return { a, b, ecke, l1, l2, summe: (l1 + l2) || 1 };
  }
  function punktAuf(e, t) {
    const d = t * e.summe;
    if (d <= e.l1) { const k = e.l1 ? d / e.l1 : 0; return { x: e.a.x + (e.ecke.x - e.a.x) * k, y: e.a.y + (e.ecke.y - e.a.y) * k }; }
    const k2 = e.l2 ? (d - e.l1) / e.l2 : 0;
    return { x: e.ecke.x + (e.b.x - e.ecke.x) * k2, y: e.ecke.y + (e.b.y - e.ecke.y) * k2 };
  }
  function aufbauen() {
    w = window.innerWidth; h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (art === 'circuit') {
      const gap = 96; const cols = Math.ceil(w / gap) + 2; const rows = Math.ceil(h / gap) + 2; const grid = [];
      nodes = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const n = { x: (x - 0.5) * gap + rand(-16, 16), y: (y - 0.5) * gap + rand(-16, 16) }; grid[y * cols + x] = n; nodes.push(n); }
      edges = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const a = grid[y * cols + x];
        if (x + 1 < cols && Math.random() < 0.6) edges.push(kante(a, grid[y * cols + x + 1], Math.random() < 0.5));
        if (y + 1 < rows && Math.random() < 0.6) edges.push(kante(a, grid[(y + 1) * cols + x], Math.random() < 0.5));
      }
      pulses = [];
      const anzahl = Math.min(70, Math.max(18, Math.round((w * h) / 32000)));
      for (let i = 0; i < anzahl && edges.length; i++) pulses.push({ e: edges[(Math.random() * edges.length) | 0], t: Math.random(), speed: rand(0.0025, 0.0075) });
    } else {
      const gap = 110; const cols = Math.ceil(w / gap) + 2; const rows = Math.ceil(h / gap) + 2; const grid = [];
      verts = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const hx = (x - 0.5) * gap + rand(-14, 14); const hy = (y - 0.5) * gap + rand(-14, 14);
        grid[y * cols + x] = verts.length;
        verts.push({ hx, hy, x: hx, y: hy, ph1: rand(0, Math.PI * 2), ph2: rand(0, Math.PI * 2), f1: rand(0.00025, 0.00055), f2: rand(0.0002, 0.00048), amp: gap * rand(0.16, 0.30) });
      }
      tris = [];
      for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
        const a = grid[y * cols + x]; const b = grid[y * cols + x + 1]; const c = grid[(y + 1) * cols + x]; const d = grid[(y + 1) * cols + x + 1];
        if (Math.random() < 0.5) { tris.push([a, b, c, rand(0, Math.PI * 2)]); tris.push([b, d, c, rand(0, Math.PI * 2)]); } else { tris.push([a, b, d, rand(0, Math.PI * 2)]); tris.push([a, d, c, rand(0, Math.PI * 2)]); }
      }
    }
  }
  function circuitStatisch() {
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(hell ? 0.10 : 0.14); ctx.beginPath();
    for (const e of edges) { ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.ecke.x, e.ecke.y); ctx.lineTo(e.b.x, e.b.y); }
    ctx.stroke(); ctx.fillStyle = rgba(hell ? 0.16 : 0.22);
    for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }
  function circuitBild() {
    ctx.clearRect(0, 0, w, h); circuitStatisch();
    ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = rgba(0.9);
    for (const p of pulses) {
      p.t += p.speed;
      if (p.t >= 1) { p.t = 0; p.e = edges[(Math.random() * edges.length) | 0]; p.speed = rand(0.0025, 0.0075); }
      const pt = punktAuf(p.e, p.t); ctx.fillStyle = rgba(hell ? 0.75 : 0.95);
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function polygonBild(jetzt) {
    for (const v of verts) { v.x = v.hx + Math.sin(jetzt * v.f1 + v.ph1) * v.amp; v.y = v.hy + Math.cos(jetzt * v.f2 + v.ph2) * v.amp; }
    ctx.clearRect(0, 0, w, h);
    const grund = hell ? 0.045 : 0.07; const puls = hell ? 0.03 : 0.05; const linie = hell ? 0.10 : 0.16;
    ctx.lineWidth = 1;
    for (const tri of tris) {
      const a = verts[tri[0]]; const b = verts[tri[1]]; const c = verts[tri[2]];
      const p = (Math.sin(jetzt * 0.00035 + tri[3]) + 1) / 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      ctx.fillStyle = rgba(grund + puls * p); ctx.fill(); ctx.strokeStyle = rgba(linie); ctx.stroke();
    }
  }
  function bild(jetzt) {
    if (!art) return;
    if (art === 'circuit') circuitBild(); else polygonBild(jetzt);
    raf = requestAnimationFrame(bild);
  }
  function starten() {
    cancelAnimationFrame(raf);
    if (!art || document.hidden) return;
    farbeLesen();
    if (bewegungAus()) { if (art === 'circuit') { ctx.clearRect(0, 0, w, h); circuitStatisch(); } else polygonBild(0); return; }
    raf = requestAnimationFrame(bild);
  }
  function setzen(neu) {
    if (!neu) { art = null; cancelAnimationFrame(raf); if (canvas) { canvas.remove(); canvas = null; } return; }
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'fahnas-muster'; canvas.setAttribute('aria-hidden', 'true');
      document.body.prepend(canvas);
      ctx = canvas.getContext('2d');
      window.addEventListener('resize', () => { clearTimeout(resizeTO); resizeTO = setTimeout(() => { if (art) { aufbauen(); starten(); } }, 180); });
      document.addEventListener('visibilitychange', () => { if (art) starten(); }); // im Hintergrund-Tab keine Rechenzeit
    }
    const umbauen = art !== neu;
    art = neu;
    if (umbauen) aufbauen();
    starten();
  }
  return { setzen, farbeNeu: () => { if (art) starten(); } };
})();

/** Nach Akzent-/Themewechsel die Musterfarbe neu lesen (für das Fenster „Darstellung“). */
export function musterFarbeNeu() { muster.farbeNeu(); }
