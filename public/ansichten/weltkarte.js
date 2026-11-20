// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Weltkarte der Verbindungen – Modul, keine Ansicht (Vertrag: docs/superpowers/specs/2026-09-26-weltkarte-design.md
// §4.8). Natural-Earth-I-Projektion ohne Bibliothek, Länderumrisse aus public/karte/welt.json (§4.4), Bögen Standort ↔
// Ort mit fließenden Lichtpunkten, Punkte nach Anzahl, Standort mit Heimnetz-Zahl, Flüge neuer Verbindungen, Ticker,
// Tooltip, Zoom (Rad am Zeiger, Ziehen, Doppelklick, Knöpfe, Tastatur auf der fokussierten Fläche) und ehrliche
// Hinweise. Reines SVG über el(), Farben nur über Klassen und FAH-NAS-Variablen (dashboard.css, Abschnitt „Weltkarte –
// Karte“), kein innerHTML, kein style-Attribut (Positionen des Tooltips per CSSOM). Leistung: pausiert außerhalb des
// Bildschirms und bei verstecktem Tab, höchstens 12 fließende Bögen, 8 Pulse und 12 Flüge je Aktualisierung;
// requestAnimationFrame läuft nur, solange ein Flug oder eine kurze Zoom-Animation läuft.

import { el, format, gebiet } from '../app.js';

const W = 1000;                     // viewBox-Breite (Karteneinheiten)
const RAND = 10;
const LAT_NORD = 84;                // Weltgrenzen ohne Antarktis: 60° S bis 84° N
const LAT_SUED = -60;
const K_MAX = 20;                   // größter Zoom
const FLUSS_MAX = 12;               // Bögen mit fließenden Lichtpunkten
const PULS_MAX = 8;                 // pulsierende Orte (in der letzten Minute aktiv)
const FLUG_MAX = 12;                // Flüge je Aktualisierung
const TICKER_MAX = 4;
const TICKER_MS = 9000;
const FRISCH_MS = 60_000;
const E_MAX = 3;                    // höchstens so viele Karteneinheiten je Bildschirmpixel für Schrift/Marken (Handy)
const SCHMAL_PX = 480;              // Kartenfläche schmaler als das: kurzer Tooltip (2 IPs, 2 Absender)

// ---------------------------------------------------------------------------------------------------------------------
// Projektion und Kartendaten (rein, auch ohne DOM nutzbar)
// ---------------------------------------------------------------------------------------------------------------------

/** Natural Earth I (Šavrič/Patterson/Jenny) in Bogenmaß-Einheiten: x ≈ ±2,74, y ≈ ±1,42, Norden positiv. */
export function projektion(lon, lat) {
  const l = (lat * Math.PI) / 180; const l2 = l * l; const l4 = l2 * l2;
  const x = ((lon * Math.PI) / 180) * (0.8707 - 0.131979 * l2 + l4 * (-0.013791 + l4 * (0.003971 * l2 - 0.001529 * l4)));
  const y = l * (1.007226 + l2 * (0.015085 + l4 * (-0.044475 + 0.028874 * l2 - 0.005916 * l4)));
  return [x, y];
}

const X_MAX = projektion(180, 0)[0];
const Y_NORD = projektion(0, LAT_NORD)[1];
const Y_SUED = projektion(0, LAT_SUED)[1];
const MASS = (W - 2 * RAND) / (2 * X_MAX);
const H = Math.ceil((Y_NORD - Y_SUED) * MASS + 2 * RAND);

/** Länge/Breite → Punkt in der viewBox (0 … W × 0 … H, y nach unten). */
function bildpunkt(lon, lat) {
  const [x, y] = projektion(lon, lat);
  return [RAND + (x + X_MAX) * MASS, RAND + (Y_NORD - y) * MASS];
}

/**
 * welt.json (§4.4) → [{iso, name, p:[lon,lat]|null, ringe:[[[lon,lat],…],…]}]. Koordinaten sind ganze Zahlen in 1/q Grad,
 * erster Punkt eines Rings absolut, danach Differenzen. Kaputte Ringe (ungerade Länge, < 3 Punkte, keine Zahlen) fallen
 * weg; ist die Datei insgesamt unbrauchbar, gibt es einen Fehler.
 */
export function dekodiereWelt(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.laender)) throw new Error('Kartendaten ungültig (welt.json)');
  const q = Number.isFinite(json.q) && json.q > 0 ? json.q : 100;
  const aus = [];
  for (const l of json.laender) {
    if (!l || typeof l !== 'object') continue;
    const ringe = [];
    for (const r of Array.isArray(l.r) ? l.r : []) {
      if (!Array.isArray(r) || r.length < 6 || r.length % 2) continue;
      const ring = []; let x = 0; let y = 0; let ok = true;
      for (let i = 0; i < r.length; i += 2) {
        if (!Number.isFinite(r[i]) || !Number.isFinite(r[i + 1])) { ok = false; break; }
        x = i ? x + r[i] : r[i]; y = i ? y + r[i + 1] : r[i + 1];
        ring.push([x / q, y / q]);
      }
      if (ok && ring.length >= 3) ringe.push(ring);
    }
    const p = Array.isArray(l.p) && l.p.length === 2 && l.p.every(Number.isFinite) ? [l.p[0] / q, l.p[1] / q] : null;
    aus.push({ iso: String(l.iso || ''), name: String(l.name || l.iso || ''), p, ringe });
  }
  return aus;
}

/** Flagge aus dem Ländercode (Regional-Indicator-Zeichen), sonst leer. */
export function flagge(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
}

const z1 = (v) => v.toFixed(1);
const klemmen = (v, min, max) => Math.min(max, Math.max(min, v));
const weich = (s) => (s < 0.5 ? 2 * s * s : 1 - ((-2 * s + 2) ** 2) / 2);

/** SVG-Pfad aus Punktfolgen (gleiche Nachbarpunkte nach dem Runden werden übersprungen). */
function linienPfad(punktfolgen, schliessen) {
  let d = '';
  for (const folge of punktfolgen) {
    let letzter = ''; let teil = ''; let n = 0;
    for (const [x, y] of folge) {
      const p = `${z1(x)},${z1(y)}`;
      if (p === letzter) continue;
      teil += `${n ? 'L' : 'M'}${p}`; letzter = p; n++;
    }
    if (n >= 2) d += teil + (schliessen ? 'Z' : '');
  }
  return d;
}

let gradnetzD = null;
/** Gradnetz alle 10°: Meridiane als Kurven (Stützpunkte alle 4°), Breitenkreise sind in Natural Earth I gerade. */
function gradnetz() {
  if (gradnetzD) return gradnetzD;
  const folgen = [];
  for (let lon = -180; lon <= 180; lon += 10) {
    const f = [];
    for (let lat = LAT_SUED; lat < LAT_NORD; lat += 4) f.push(bildpunkt(lon, lat));
    f.push(bildpunkt(lon, LAT_NORD));
    folgen.push(f);
  }
  for (let lat = -60; lat <= 80; lat += 10) folgen.push([bildpunkt(-180, lat), bildpunkt(180, lat)]);
  gradnetzD = linienPfad(folgen, false);
  return gradnetzD;
}

/** Länderpfade je Weltdatei nur einmal berechnen (Ansichtswechsel baut die Karte neu, die Pfade bleiben). */
const landCache = new WeakMap();
function landDaten(json) {
  let d = landCache.get(json);
  if (!d) {
    d = dekodiereWelt(json)
      .map((l) => ({ iso: l.iso, name: l.name, d: linienPfad(l.ringe.map((r) => r.map(([lon, lat]) => bildpunkt(lon, lat))), true) }))
      .filter((l) => l.d);
    landCache.set(json, d);
  }
  return d;
}

let standardWelt = null;
/** Standard-Lader: public/karte/welt.json, einmal je Seite (Fehler → beim nächsten Mal neu versuchen). */
function ladeStandardWelt() {
  if (!standardWelt) {
    standardWelt = fetch(new URL('../karte/welt.json', import.meta.url), { credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((e) => { standardWelt = null; throw e; });
  }
  return standardWelt;
}

/** Quadratische Bézier von a nach b, Kontrollpunkt 25 % der Streckenlänge über der Mitte. */
function bogenD([x1, y1], [x2, y2]) {
  const cx = (x1 + x2) / 2; const cy = (y1 + y2) / 2 - Math.hypot(x2 - x1, y2 - y1) * 0.25;
  return `M${z1(x1)},${z1(y1)} Q${z1(cx)},${z1(cy)} ${z1(x2)},${z1(y2)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ergebnis von netz.verbindungen (§4.6) tolerant lesen – Unsinn führt nie zu einer Ausnahme
// ---------------------------------------------------------------------------------------------------------------------

const zahlOder = (v, rueckfall) => (typeof v === 'number' && Number.isFinite(v) ? v : rueckfall);
function zeitMs(v, rueckfall) { const ms = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(ms) ? ms : rueckfall; }
const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function ortLesen(o) {
  if (!o || typeof o !== 'object') return null;
  const lat = zahlOder(o.lat, NaN); const lon = zahlOder(o.lon, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { land: text(o.land, 8), land_name: text(o.land_name), stadt: text(o.stadt) || null, lat, lon, genau: o.genau === 'land' ? 'land' : 'stadt' };
}

function normalisiere(e) {
  const d = e && typeof e === 'object' ? e : {};
  const heimatLat = zahlOder(d.heimat?.lat, NaN); const heimatLon = zahlOder(d.heimat?.lon, NaN);
  const heimat = Number.isFinite(heimatLat) && Number.isFinite(heimatLon) && Math.abs(heimatLat) <= 90 && Math.abs(heimatLon) <= 180
    ? { lat: heimatLat, lon: heimatLon, name: text(d.heimat.name, 64) } : null;
  const gegenstellen = [];
  for (const g of Array.isArray(d.gegenstellen) ? d.gegenstellen : []) {
    if (!g || typeof g !== 'object' || typeof g.ip !== 'string' || !g.ip) continue;
    const anzahl = zahlOder(g.anzahl, 1);
    gegenstellen.push({
      ip: g.ip.slice(0, 64), privat: g.privat === true, anycast: g.anycast === true, ort: g.privat === true ? null : ortLesen(g.ort),
      anzahl: anzahl > 0 ? anzahl : 1, bytes: Math.max(0, zahlOder(g.bytes, 0)), zuletzt: zeitMs(g.zuletzt, 0),
      lokal: (Array.isArray(g.lokal) ? g.lokal : []).filter((l) => l && typeof l.name === 'string' && l.name)
        .map((l) => ({ name: l.name.slice(0, 80), art: text(l.art, 16), anzahl: Math.max(0, zahlOder(l.anzahl, 1)) })),
    });
  }
  return {
    richtung: d.richtung === 'ein' ? 'ein' : 'aus',
    zeit: zeitMs(d.zeit, Date.now()),
    fenster_ms: (zahlOder(d.fenster_s, 3600) > 0 ? zahlOder(d.fenster_s, 3600) : 3600) * 1000,
    aufzeichnung: d.aufzeichnung !== false,
    werkzeug: { ok: !(d.werkzeug && d.werkzeug.ok === false), hinweis: text(d.werkzeug?.hinweis, 400) || null },
    geo: { quelle: text(d.geo?.quelle, 16) || null },
    heimat,
    gegenstellen,
  };
}

function lokalDazu(ziel, lokal) { for (const l of lokal) ziel.set(l.name, (ziel.get(l.name) || 0) + l.anzahl); }
const ortSchluessel = (o) => `${o.lat.toFixed(1)},${o.lon.toFixed(1)}`;

// ---------------------------------------------------------------------------------------------------------------------
// Die Karte
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Baut die Karte in `behaelter`. `t` = Übersetzer, `bewegungReduziert` = true/false (undefiniert → prefers-reduced-motion),
 * `holeWelt` = liefert welt.json (Standard: public/karte/welt.json).
 * @returns {{setzeDaten(ergebnis, optionen?), setzeFilter(name|null), groesse(), pausieren(bool), zerstoeren()}}
 */
export function erzeugeWeltkarte(behaelter, { t = (k) => k, bewegungReduziert, holeWelt = ladeStandardWelt } = {}) {
  let zerstoert = false;
  let welt = null;              // [{iso, name, knoten, aktiv}] nach dem Laden
  let weltFehler = false;
  let daten = null;             // normalisiertes letztes Ergebnis
  let laedt = false;            // Platzhalter nach dem Umschalten: leer, abgedunkelt, bis echte Daten kommen
  let vorher = null;            // {richtung, zeit, anzahl: Map ip → anzahl} für die Erkennung neuer Verbindungen
  let filter = null;
  let zoom = { k: 1, x: 0, y: 0 };
  let zoomAnim = null;
  let e = 1;                    // Karteneinheiten je Bildschirmpixel (1 … E_MAX)
  let extern = false;           // pausieren(true) von außen
  let ausserhalb = false;       // IntersectionObserver: nicht im Bild
  let raf = 0;
  let ziehen = null;
  let klickSperre = false;
  let datenStand = 0;
  let tipSchluessel = '';
  let orte = [];                // aktuelle Orte (nach Filter), je {schluessel, xy, n, …}
  const ortNach = new Map();
  let heimInfo = { geraete: 0, n: 0, bytes: 0, ips: [], lokal: new Map() };
  let landInfo = new Map();
  let ohneOrt = 0;
  const ortKnoten = new Map();  // schluessel → {punktG, punkt, puls, bogenG, bogen, fluss}
  const fluege = new Set();
  const zeitgeber = new Set();

  const reduziert = () => {
    if (typeof bewegungReduziert === 'boolean') return bewegungReduziert;
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };
  const pausiert = () => extern || ausserhalb || (typeof document !== 'undefined' && document.hidden === true);
  const markenFaktor = () => Math.sqrt(e);
  const radiusBasis = (o) => 3 + Math.min(9, Math.sqrt(Math.max(0, o.n)) * 1.6);
  const heimName = () => (daten && daten.heimat && daten.heimat.name) || t('dashboard.karte_standort');

  const geplanteFluege = new Set(); // Zeitgeber verzögerter Flüge (liveLeeren bricht sie ab)
  function nachher(fn, ms) {
    const id = setTimeout(() => { zeitgeber.delete(id); if (!zerstoert) fn(); }, ms);
    zeitgeber.add(id);
    return id;
  }

  // --- Gerüst ---------------------------------------------------------------------------------------------------------
  const gLaender = el('g', { class: 'wk-laender', 'fill-rule': 'evenodd' });
  const gBoegen = el('g', { class: 'wk-boegen' });
  const gPunkte = el('g', { class: 'wk-punkte' });
  const gHeim = el('g', { class: 'wk-heimebene' });
  const gFluege = el('g', { class: 'wk-fluege' });
  const gNamen = el('g', { class: 'wk-namen' });
  const gWelt = el('g', { class: 'wk-welt', transform: 'translate(0.00,0.00) scale(1.0000)' }, [
    el('path', { class: 'wk-gradnetz', d: gradnetz() }), gLaender, gBoegen, gPunkte, gHeim, gFluege, gNamen,
  ]);
  const svg = el('svg', { class: 'wk-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': t('dashboard.karte_titel') }, [gWelt]);
  const heimPunkt = el('circle', { class: 'wk-heim-punkt', 'data-heim': true, r: 5 });
  const heimZahl = el('text', { class: 'wk-heim-zahl', 'text-anchor': 'middle' });
  const heimG = el('g', { class: 'wk-heim' }, [heimPunkt]);
  const laden = el('div', { class: 'wk-laden' }, [el('span', { class: 'laden-kreis', 'aria-hidden': 'true' }), t('dashboard.karte_laden')]);
  const tip = el('div', { class: 'wk-tip', role: 'tooltip', hidden: true });
  // Ticker rein visuell: aria-live off – die Listen der Kachel tragen dieselbe Information, Ansagen alle paar Sekunden
  // würden stören (Prüfbericht 26.09.); role log, damit er mit seinem Namen auffindbar bleibt
  const ticker = el('div', { class: 'wk-ticker', role: 'log', 'aria-live': 'off', 'aria-label': t('dashboard.karte_neu') });
  const knopf = (zeichen, titel, fn) => el('button', { type: 'button', class: 'wk-zoom-knopf', 'aria-label': titel, title: titel, onclick: fn }, zeichen);
  const zoomLeiste = el('div', { class: 'wk-zoom' }, [
    knopf('+', t('dashboard.karte_zoom_rein'), () => zoomSchritt(2)),
    knopf('−', t('dashboard.karte_zoom_raus'), () => zoomSchritt(0.5)),
    knopf('⟲', t('dashboard.karte_zoom_zurueck'), () => zoomZiel({ k: 1, x: 0, y: 0 })),
  ]);
  // Mit der Tastatur erreichbar: Pfeiltasten verschieben, + − zoomen, 0 zeigt die ganze Welt (beiTaste)
  const flaeche = el('div', { class: 'wk-flaeche', tabindex: '0', role: 'group', 'aria-label': t('dashboard.karte_tastatur') }, [svg, laden, ticker, zoomLeiste, tip]);
  flaeche.style.aspectRatio = `${W} / ${H}`;
  const hinweisBox = el('div', { class: 'wk-hinweise' });
  const legende = el('div', { class: 'wk-legende' });
  const wurzel = el('div', { class: 'wk wk-aus' }, [flaeche, hinweisBox, legende]);
  behaelter.appendChild(wurzel);

  // --- Zoom -----------------------------------------------------------------------------------------------------------
  /** Bildschirmpunkt → viewBox-Punkt (ungezoomt), berücksichtigt preserveAspectRatio „meet“. */
  function kartenPunkt(ev) {
    const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (!r || !(r.width > 0) || !(r.height > 0) || !Number.isFinite(ev.clientX)) return [W / 2, H / 2];
    const m = Math.min(r.width / W, r.height / H);
    return [(ev.clientX - r.left - (r.width - W * m) / 2) / m, (ev.clientY - r.top - (r.height - H * m) / 2) / m];
  }
  const begrenzt = (z) => ({ k: z.k, x: klemmen(z.x, W - W * z.k, 0), y: klemmen(z.y, H - H * z.k, 0) });
  /** Neuer Zoom mit Faktor um einen festen viewBox-Punkt (bezogen auf das laufende Animationsziel, falls vorhanden). */
  function zoomUmPunkt(faktor, px, py) {
    const basis = zoomAnim ? zoomAnim.nach : zoom;
    const k = klemmen(basis.k * faktor, 1, K_MAX);
    const wx = (px - basis.x) / basis.k; const wy = (py - basis.y) / basis.k;
    return begrenzt({ k, x: px - wx * k, y: py - wy * k });
  }
  function setzeZoom(z) {
    zoom = z;
    gWelt.setAttribute('transform', `translate(${z.x.toFixed(2)},${z.y.toFixed(2)}) scale(${z.k.toFixed(4)})`);
    tipVerstecken();
    massstabAnwenden();
  }
  function zoomZiel(ziel) {
    if (zerstoert) return;
    if (reduziert() || pausiert()) { zoomAnim = null; setzeZoom(ziel); return; }
    zoomAnim = { von: { ...zoom }, nach: ziel, start: null, dauer: 280 };
    bildAnfordern();
  }
  /**
   * Fester Punkt für Knopf und Taste: der Standort, solange er im Bild ist – so zoomt schon der erste Schritt auf das
   * eigene Netz zu und „+“ schiebt den Standort nicht mehr aus dem Bild; sonst (kein Standort, weggeschoben) die Mitte.
   */
  function knopfPunkt() {
    if (daten && daten.heimat) {
      const basis = zoomAnim ? zoomAnim.nach : zoom;
      const [hx, hy] = bildpunkt(daten.heimat.lon, daten.heimat.lat);
      const sx = hx * basis.k + basis.x; const sy = hy * basis.k + basis.y;
      if (sx >= W * 0.05 && sx <= W * 0.95 && sy >= H * 0.05 && sy <= H * 0.95) return [sx, sy];
    }
    return [W / 2, H / 2];
  }
  function zoomSchritt(faktor) { const [px, py] = knopfPunkt(); zoomZiel(zoomUmPunkt(faktor, px, py)); }
  /** Tastatur auf der fokussierten Kartenfläche; Strg/Alt/Cmd bleiben dem Browser (Seitenzoom). */
  function beiTaste(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const richtung = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
    if (richtung) {
      const basis = zoomAnim ? zoomAnim.nach : zoom;
      const ziel = begrenzt({ k: basis.k, x: basis.x + (richtung[0] * W) / 8, y: basis.y + (richtung[1] * H) / 8 });
      if (Math.abs(ziel.x - basis.x) < 0.01 && Math.abs(ziel.y - basis.y) < 0.01) return; // nichts zu verschieben → Seite rollt
      ev.preventDefault();
      zoomAnim = null;
      setzeZoom(ziel);
      return;
    }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomSchritt(2); }
    else if (ev.key === '-' || ev.key === '_' || ev.key === '−') { ev.preventDefault(); zoomSchritt(0.5); }
    else if (ev.key === '0') { ev.preventDefault(); zoomZiel({ k: 1, x: 0, y: 0 }); }
  }
  function beiRad(ev) {
    const schritt = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 1 : 0.002;
    const faktor = 2 ** (-(Number(ev.deltaY) || 0) * schritt * (ev.ctrlKey ? 10 : 1));
    if (!Number.isFinite(faktor) || faktor === 1) return;
    // Ganz heraus- bzw. hineingezoomt: das Rad gehört wieder der Seite
    if ((faktor < 1 && zoom.k <= 1.001) || (faktor > 1 && zoom.k >= K_MAX - 0.001)) return;
    ev.preventDefault();
    zoomAnim = null;
    const [px, py] = kartenPunkt(ev);
    setzeZoom(zoomUmPunkt(faktor, px, py));
  }
  function beiDruck(ev) {
    if (ev.pointerType === 'touch' || (ev.button != null && ev.button !== 0)) return; // Touch: Seite bleibt rollbar
    ziehen = { id: ev.pointerId, start: kartenPunkt(ev), x: zoom.x, y: zoom.y, bewegt: false };
    try { if (typeof svg.setPointerCapture === 'function') svg.setPointerCapture(ev.pointerId); } catch { /* ohne Einfang */ }
  }
  function beiBewegung(ev) {
    if (ziehen && ev.pointerId === ziehen.id) {
      const [px, py] = kartenPunkt(ev);
      const dx = px - ziehen.start[0]; const dy = py - ziehen.start[1];
      if (!ziehen.bewegt && Math.abs(dx) + Math.abs(dy) > 3) { ziehen.bewegt = true; wurzel.classList.add('zieht'); }
      if (ziehen.bewegt) { zoomAnim = null; setzeZoom(begrenzt({ k: zoom.k, x: ziehen.x + dx, y: ziehen.y + dy })); }
      return;
    }
    if (ev.pointerType !== 'touch') tipFuer(ev);
  }
  function beiLoslassen(ev) {
    if (!ziehen || ev.pointerId !== ziehen.id) return;
    klickSperre = ziehen.bewegt;
    ziehen = null;
    wurzel.classList.remove('zieht');
  }
  function beiKlick(ev) {
    if (klickSperre) { klickSperre = false; return; }
    tipFuer(ev); // Handy: Tippen auf einen Punkt zeigt den Tooltip
  }
  function beiDoppelklick(ev) {
    const [px, py] = kartenPunkt(ev);
    zoomZiel(zoomUmPunkt(ev.shiftKey ? 0.5 : 2, px, py));
  }
  svg.addEventListener('wheel', beiRad, { passive: false });
  svg.addEventListener('pointerdown', beiDruck);
  svg.addEventListener('pointermove', beiBewegung);
  svg.addEventListener('pointerup', beiLoslassen);
  svg.addEventListener('pointercancel', beiLoslassen);
  svg.addEventListener('pointerleave', () => tipVerstecken());
  svg.addEventListener('click', beiKlick);
  svg.addEventListener('dblclick', beiDoppelklick);
  flaeche.addEventListener('keydown', beiTaste);

  // --- Bildschleife: nur solange Flüge oder eine Zoom-Animation laufen ---------------------------------------------------
  function bildAnfordern() {
    if (raf || zerstoert || typeof requestAnimationFrame !== 'function') return;
    raf = requestAnimationFrame(bildSchritt);
  }
  function bildSchritt(jetzt) {
    raf = 0;
    if (zerstoert) return;
    if (zoomAnim) {
      if (zoomAnim.start == null) zoomAnim.start = jetzt;
      const roh = Math.min(1, (jetzt - zoomAnim.start) / zoomAnim.dauer); const s = weich(roh);
      const { von, nach } = zoomAnim;
      if (roh >= 1) { zoomAnim = null; setzeZoom(nach); }
      else {
        // Verschiebung im Gleichschritt mit dem Maßstab: der feste Punkt des Zooms (z. B. der Standort) bleibt in jedem
        // Bild an seinem Platz; ohne Maßstabsänderung (nur Verschieben) linear
        const k = von.k * (nach.k / von.k) ** s;
        const anteil = Math.abs(nach.k - von.k) > 1e-9 ? (k - von.k) / (nach.k - von.k) : s;
        setzeZoom(begrenzt({ k, x: von.x + (nach.x - von.x) * anteil, y: von.y + (nach.y - von.y) * anteil }));
      }
    }
    for (const f of [...fluege]) flugSchritt(f, jetzt);
    if (zoomAnim || fluege.size) bildAnfordern();
  }

  // --- Pause ----------------------------------------------------------------------------------------------------------
  function pauseAktualisieren() {
    if (zerstoert) return;
    const p = pausiert();
    wurzel.classList.toggle('pausiert', p);
    if (!p) return;
    for (const f of [...fluege]) { fluege.delete(f); f.g.remove(); }
    gFluege.textContent = '';
    if (zoomAnim) { const ziel = zoomAnim.nach; zoomAnim = null; setzeZoom(ziel); }
    if (raf) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); raf = 0; }
  }
  const sichtHoerer = () => pauseAktualisieren();
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', sichtHoerer);
  let io = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((eintraege) => { for (const x of eintraege) ausserhalb = !x.isIntersecting; pauseAktualisieren(); }, { rootMargin: '80px' });
    io.observe(wurzel);
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => groesse()); ro.observe(flaeche); }
  pauseAktualisieren();

  // --- Tooltip --------------------------------------------------------------------------------------------------------
  function tipVerstecken() { if (!tip.hidden) tip.hidden = true; tipSchluessel = ''; }
  const uhrzeit = (ms) => { try { return new Date(ms).toLocaleTimeString(gebiet()); } catch { return ''; } };
  // Schmale Fläche (Handy, schmale Kachel): höchstens 2 IPs und 2 Absender, sonst 5 bzw. 4 – so bleibt der Tooltip kurz
  let tipIps = 5; let tipLokal = 4;
  function ipText(ips) {
    const mehr = ips.length - tipIps;
    return ips.slice(0, tipIps).join(', ') + (mehr > 0 ? ` ${t('dashboard.karte_weitere', { n: mehr })}` : '');
  }
  const lokalZeilen = (lokal) => [...lokal.entries()].sort((a, b) => b[1] - a[1]).slice(0, tipLokal).map(([name, n]) => el('div', { class: 'wk-tip-zeile', text: `${name}: ${format.zahl(n)}` }));
  const mengeZeile = (n, bytes) => [t('dashboard.karte_verbindungen', { n }), bytes > 0 ? t('dashboard.karte_datenmenge', { menge: format.groesse(bytes) }) : null].filter(Boolean).join(' · ');

  /**
   * Linke obere Ecke des Tooltips neben dem Zeiger, innerhalb der Fläche und nicht über den Zoomknöpfen: überdeckt er
   * sie, weicht er links daneben, darüber oder darunter aus (erste freie Lage). Passt keine, liegen die Knöpfe per
   * z-index darüber (dashboard.css).
   */
  function tipLage(r, x, y, bw, bh) {
    const innen = (l, o) => [klemmen(l, 4, Math.max(4, r.width - bw - 4)), klemmen(o, 4, Math.max(4, r.height - bh - 4))];
    let [links, oben] = innen(x + 14 + bw > r.width - 4 ? x - bw - 14 : x + 14, y + 14);
    const z = typeof zoomLeiste.getBoundingClientRect === 'function' ? zoomLeiste.getBoundingClientRect() : null;
    if (!z || !(z.width > 0) || z.width >= r.width / 2 || z.height >= r.height / 2) return [links, oben]; // ohne echtes Layout
    const zl = z.left - r.left; const zo = z.top - r.top; const zr = zl + z.width; const zu = zo + z.height;
    const ueber = (l, o) => l < zr + 4 && l + bw > zl - 4 && o < zu + 4 && o + bh > zo - 4;
    if (!ueber(links, oben)) return [links, oben];
    const frei = [[zl - bw - 6, oben], [links, zo - bh - 6], [links, zu + 6]]
      .find(([l, o]) => l >= 4 && o >= 4 && l + bw <= r.width - 4 && o + bh <= r.height - 4 && !ueber(l, o));
    return frei || [links, oben];
  }

  function tipInhalt(z) {
    if (z.art === 'ort') {
      const o = ortNach.get(z.schluessel); if (!o) return null;
      return [
        el('b', { class: 'wk-tip-titel', text: `${flagge(o.land)} ${[o.land_name || o.land, o.stadt].filter(Boolean).join(', ')}`.trim() }),
        el('div', { text: mengeZeile(o.n, o.bytes) }),
        el('div', { text: t('dashboard.karte_zuletzt', { zeit: uhrzeit(o.zuletzt) }) }),
        o.genau === 'land' ? el('div', { class: 'wk-tip-zeile', text: t('dashboard.karte_landesmitte') }) : null,
        el('div', { class: 'wk-tip-ips', text: ipText(o.ips) }),
        ...lokalZeilen(o.lokal),
      ];
    }
    if (z.art === 'heim') {
      if (!daten || !daten.heimat) return null;
      return [
        el('b', { class: 'wk-tip-titel', text: heimName() }),
        el('div', { text: heimInfo.geraete ? t('dashboard.karte_heimnetz_zeile', { geraete: heimInfo.geraete, n: heimInfo.n }) : t('dashboard.karte_heimnetz_keine') }),
        heimInfo.ips.length ? el('div', { class: 'wk-tip-ips', text: ipText(heimInfo.ips) }) : null,
        ...lokalZeilen(heimInfo.lokal),
      ];
    }
    const info = landInfo.get(z.iso); if (!info) return null;
    return [
      el('b', { class: 'wk-tip-titel', text: `${flagge(z.iso)} ${info.name}`.trim() }),
      el('div', { text: mengeZeile(info.n, info.bytes) }),
      el('div', { text: t('dashboard.karte_ips', { n: info.ips }) }),
      ...lokalZeilen(info.lokal),
    ];
  }
  /** Was liegt unter dem Zeiger? Ort, Standort oder aktives Land (Elternkette bis zum SVG). */
  function zielVon(ev) {
    for (let k = ev.target; k && k !== svg; k = k.parentNode) {
      if (typeof k.getAttribute !== 'function') continue;
      const ort = k.getAttribute('data-ort'); if (ort) return { art: 'ort', schluessel: ort };
      if (k.hasAttribute('data-heim')) return { art: 'heim' };
      const iso = k.getAttribute('data-iso'); if (iso) return landInfo.has(iso) ? { art: 'land', iso } : null;
    }
    return null;
  }
  function tipFuer(ev) {
    const z = zielVon(ev);
    if (!z) { tipVerstecken(); return; }
    const r = flaeche.getBoundingClientRect();
    const schmal = r.width > 0 && r.width < SCHMAL_PX;
    const schluessel = `${z.art}|${z.schluessel || z.iso || ''}|${datenStand}|${schmal}`;
    if (schluessel !== tipSchluessel) {
      tipIps = schmal ? 2 : 5; tipLokal = schmal ? 2 : 4;
      const kinder = tipInhalt(z);
      if (!kinder) { tipVerstecken(); return; }
      tip.textContent = '';
      for (const kind of kinder) if (kind) tip.appendChild(kind);
      tipSchluessel = schluessel;
    }
    tip.hidden = false;
    const bw = tip.offsetWidth || 220; const bh = tip.offsetHeight || 90;
    const [links, oben] = tipLage(r, ev.clientX - r.left, ev.clientY - r.top, bw, bh);
    tip.style.left = `${Math.round(links)}px`;
    tip.style.top = `${Math.round(oben)}px`;
  }

  // --- Daten sammeln ------------------------------------------------------------------------------------------------
  function sammeln() {
    const d = daten;
    const karte = new Map();
    const heim = { geraete: 0, n: 0, bytes: 0, ips: [], lokal: new Map() };
    ohneOrt = 0;
    for (const g of d.gegenstellen) {
      const treffer = !filter || g.lokal.some((l) => l.name === filter);
      const nWahl = filter ? g.lokal.filter((l) => l.name === filter).reduce((s, l) => s + l.anzahl, 0) || g.anzahl : g.anzahl;
      if (g.privat) {
        if (!treffer) continue;
        heim.geraete++; heim.n += nWahl; heim.bytes += g.bytes; heim.ips.push(g.ip); lokalDazu(heim.lokal, g.lokal);
        continue;
      }
      if (!g.ort) { if (treffer) ohneOrt++; continue; }
      const schluessel = ortSchluessel(g.ort);
      let o = karte.get(schluessel);
      if (!o) {
        o = { schluessel, ...g.ort, xy: bildpunkt(g.ort.lon, g.ort.lat), alle: { n: 0, bytes: 0, ips: [], lokal: new Map(), zuletzt: 0 }, wahl: { n: 0, bytes: 0, ips: [], lokal: new Map(), zuletzt: 0 } };
        karte.set(schluessel, o);
      }
      for (const [teil, n] of treffer ? [[o.alle, g.anzahl], [o.wahl, nWahl]] : [[o.alle, g.anzahl]]) {
        teil.n += n; teil.bytes += g.bytes; teil.ips.push(g.ip); lokalDazu(teil.lokal, g.lokal); teil.zuletzt = Math.max(teil.zuletzt, g.zuletzt);
      }
    }
    orte = [...karte.values()].map((o) => {
      const geist = !!filter && !o.wahl.ips.length;
      const s = filter && !geist ? o.wahl : o.alle;
      return { ...o, geist, n: s.n, bytes: s.bytes, ips: s.ips, lokal: s.lokal, zuletzt: s.zuletzt, frisch: s.zuletzt >= d.zeit - FRISCH_MS };
    });
    ortNach.clear();
    for (const o of orte) ortNach.set(o.schluessel, o);
    heimInfo = heim;
    landInfo = new Map();
    for (const o of orte) {
      if (o.geist || !o.land) continue;
      const info = landInfo.get(o.land) || { name: o.land_name || (welt && welt.find((l) => l.iso === o.land)?.name) || o.land, n: 0, bytes: 0, ips: 0, lokal: new Map() };
      info.n += o.n; info.bytes += o.bytes; info.ips += o.ips.length; lokalDazu(info.lokal, [...o.lokal].map(([name, anzahl]) => ({ name, anzahl })));
      landInfo.set(o.land, info);
    }
  }

  // --- Zeichnen -------------------------------------------------------------------------------------------------------
  function zeichneLaender() {
    if (!welt) return;
    const maxN = Math.max(1, ...[...landInfo.values()].map((i) => i.n));
    for (const l of welt) {
      const info = landInfo.get(l.iso);
      if (info) {
        l.knoten.classList.add('aktiv');
        l.knoten.setAttribute('fill-opacity', (0.15 + (0.4 * Math.log1p(info.n)) / Math.log1p(maxN)).toFixed(3));
      } else if (l.aktiv) { l.knoten.classList.remove('aktiv'); l.knoten.removeAttribute('fill-opacity'); }
      l.aktiv = !!info;
    }
  }

  /** Kinder in die gewünschte Reihenfolge bringen, ohne richtig stehende zu bewegen (Animationen laufen weiter). */
  function ordnen(eltern, liste) {
    for (let i = 0; i < liste.length; i++) if (eltern.children[i] !== liste[i]) eltern.insertBefore(liste[i], eltern.children[i] || null);
  }

  function zeichneOrte() {
    const heim = daten.heimat ? bildpunkt(daten.heimat.lon, daten.heimat.lat) : null;
    const lebend = orte.filter((o) => !o.geist);
    const maxBytes = Math.max(1, ...lebend.map((o) => o.bytes)); const maxN = Math.max(1, ...lebend.map((o) => o.n));
    const nachBytes = lebend.some((o) => o.bytes > 0);
    const ruhig = reduziert();
    const nachAktivitaet = [...lebend].sort((a, b) => b.zuletzt - a.zuletzt || b.n - a.n);
    const fliesst = new Set(ruhig || !heim ? [] : nachAktivitaet.slice(0, FLUSS_MAX).map((o) => o.schluessel));
    const pulst = new Set(ruhig ? [] : nachAktivitaet.filter((o) => o.frisch).slice(0, PULS_MAX).map((o) => o.schluessel));
    // Blasse (Filter) zuunterst, dann große unter kleinen – so bleiben kleine Punkte greifbar
    const reihe = [...orte].sort((a, b) => (b.geist - a.geist) || (b.n - a.n) || (a.schluessel < b.schluessel ? -1 : 1));
    const fenster = daten.fenster_ms;
    for (const o of reihe) {
      let kn = ortKnoten.get(o.schluessel);
      if (!kn) {
        kn = { punktG: el('g', { class: 'wk-punktg', 'data-ort': o.schluessel }), punkt: el('circle', { class: 'wk-punkt' }), puls: null, bogenG: null, bogen: null, fluss: null };
        kn.punktG.appendChild(kn.punkt);
        ortKnoten.set(o.schluessel, kn);
      }
      kn.punktG.classList.toggle('wk-geist', o.geist);
      kn.punkt.setAttribute('class', `wk-punkt${o.frisch ? '' : ' alt'}`);
      kn.punkt.setAttribute('cx', z1(o.xy[0])); kn.punkt.setAttribute('cy', z1(o.xy[1]));
      if (pulst.has(o.schluessel)) {
        if (!kn.puls) { kn.puls = el('circle', { class: 'wk-puls' }); kn.punktG.insertBefore(kn.puls, kn.punkt); }
        kn.puls.setAttribute('cx', z1(o.xy[0])); kn.puls.setAttribute('cy', z1(o.xy[1]));
      } else if (kn.puls) { kn.puls.remove(); kn.puls = null; }
      if (heim) {
        if (!kn.bogenG) {
          kn.bogenG = el('g', { class: 'wk-bogeng', 'data-ort': o.schluessel });
          kn.bogen = el('path', { class: 'wk-bogen' });
          kn.bogenG.appendChild(kn.bogen);
        }
        const d = bogenD(heim, o.xy);
        const a = Math.max(0, 1 - (daten.zeit - o.zuletzt) / fenster);  // Alter im Fenster: frisch = 1
        kn.bogenG.classList.toggle('wk-geist', o.geist);
        if (kn.bogen.getAttribute('d') !== d) kn.bogen.setAttribute('d', d);
        kn.bogen.setAttribute('stroke-opacity', (0.12 + 0.42 * a * a).toFixed(3));
        const anteil = nachBytes ? Math.log1p(o.bytes) / Math.log1p(maxBytes) : Math.log1p(o.n) / Math.log1p(maxN);
        kn.bogen.setAttribute('stroke-width', (0.8 + 2.4 * anteil).toFixed(2));
        if (fliesst.has(o.schluessel)) {
          if (!kn.fluss) { kn.fluss = el('path', { class: 'wk-fluss' }); kn.bogenG.appendChild(kn.fluss); }
          if (kn.fluss.getAttribute('d') !== d) kn.fluss.setAttribute('d', d);
          kn.fluss.setAttribute('class', `wk-fluss${o.frisch ? ' frisch' : ''}`);
          kn.fluss.setAttribute('stroke-opacity', (0.3 + 0.65 * a * a).toFixed(3));
        } else if (kn.fluss) { kn.fluss.remove(); kn.fluss = null; }
      } else if (kn.bogenG) { kn.bogenG.remove(); kn.bogenG = null; kn.bogen = null; kn.fluss = null; }
    }
    for (const [schluessel, kn] of ortKnoten) {
      if (ortNach.has(schluessel)) continue;
      kn.punktG.remove(); if (kn.bogenG) kn.bogenG.remove();
      ortKnoten.delete(schluessel);
    }
    ordnen(gPunkte, reihe.map((o) => ortKnoten.get(o.schluessel).punktG));
    ordnen(gBoegen, reihe.map((o) => ortKnoten.get(o.schluessel).bogenG).filter(Boolean));
  }

  function zeichneHeim() {
    if (!daten.heimat) { heimG.remove(); return; }
    const [x, y] = bildpunkt(daten.heimat.lon, daten.heimat.lat);
    heimPunkt.setAttribute('cx', z1(x)); heimPunkt.setAttribute('cy', z1(y));
    if (heimInfo.geraete > 0) {
      heimZahl.textContent = String(heimInfo.geraete);
      if (heimZahl.parentNode !== heimG) heimG.appendChild(heimZahl);
    } else heimZahl.remove();
    if (heimG.parentNode !== gHeim) gHeim.appendChild(heimG);
  }

  /** Radien, Schrift und Standortmarke an Zoom und Bildschirmbreite anpassen (Punkte bleiben gleich groß). */
  function massstabAnwenden() {
    const k = zoom.k; const f = markenFaktor();
    for (const o of orte) {
      const kn = ortKnoten.get(o.schluessel); if (!kn) continue;
      const r = ((radiusBasis(o) * f) / k).toFixed(3);
      kn.punkt.setAttribute('r', r); if (kn.puls) kn.puls.setAttribute('r', r);
    }
    heimPunkt.setAttribute('r', ((5 * f) / k).toFixed(3));
    const zahlBox = heimZahlBox();
    if (zahlBox) {
      // unter der Standortmarke: links oben liegt bei einem NAS in Mitteleuropa fast immer Frankfurt/Amsterdam
      heimZahl.setAttribute('x', zahlBox.x.toFixed(2)); heimZahl.setAttribute('y', zahlBox.y.toFixed(2));
      heimZahl.setAttribute('font-size', zahlBox.fs.toFixed(3)); heimZahl.setAttribute('stroke-width', ((2.5 * e) / k).toFixed(3));
    }
    for (const fl of fluege) fl.kopf.setAttribute('r', ((3.4 * f) / k).toFixed(3));
    namenSetzen();
  }

  /** Lage der Heimnetz-Zahl (Grundlinie mittig unter der Standortmarke) samt Rechteck für die Kollisionsprüfung. */
  function heimZahlBox() {
    if (!daten || !daten.heimat || heimInfo.geraete <= 0) return null;
    const k = zoom.k; const f = markenFaktor(); const fs = (10 * e) / k;
    const [x, y] = bildpunkt(daten.heimat.lon, daten.heimat.lat);
    const oben = y + (5 * f) / k + (1.5 * e) / k; const breite = String(heimInfo.geraete).length * fs * 0.62;
    return { x, y: oben + fs * 0.9, fs, rechteck: [x - breite / 2, oben, x + breite / 2, oben + fs * 1.1] };
  }

  /** Ortsnamen: Standort zuerst, dann die meistbesuchten Orte; ein Name entfällt, wenn er einen gesetzten überdeckt. */
  function namenSetzen() {
    gNamen.textContent = '';
    if (!daten) return;
    const k = zoom.k; const f = markenFaktor(); const fs = (10 * e) / k; const belegt = [];
    const zahlBox = heimZahlBox();
    if (zahlBox) belegt.push(zahlBox.rechteck);
    const sichtRechts = (W - zoom.x) / k; const sichtLinks = -zoom.x / k;
    const kandidaten = orte.filter((o) => !o.geist).sort((a, b) => b.n - a.n).slice(0, k >= 3 ? 14 : 6)
      .map((o) => ({ x: o.xy[0], y: o.xy[1], text: o.stadt || o.land_name || o.land || '', r: (radiusBasis(o) * f) / k, heim: false }));
    if (daten.heimat) { const [x, y] = bildpunkt(daten.heimat.lon, daten.heimat.lat); kandidaten.unshift({ x, y, text: heimName(), r: (5 * f) / k, heim: true }); }
    for (const c of kandidaten) {
      if (!c.text) continue;
      const breite = c.text.length * fs * 0.58; const hoehe = fs * 1.2;
      let x = c.x + c.r + (3 * e) / k;
      if (x + breite > sichtRechts && c.x - c.r - (3 * e) / k - breite >= sichtLinks) x = c.x - c.r - (3 * e) / k - breite; // am rechten Rand links setzen
      const y = c.y + fs * 0.35;
      const rechteck = [x, y - hoehe, x + breite, y + (2 * e) / k];
      if (belegt.some((q) => !(rechteck[2] < q[0] || rechteck[0] > q[2] || rechteck[3] < q[1] || rechteck[1] > q[3]))) continue;
      belegt.push(rechteck);
      gNamen.appendChild(el('text', {
        class: `wk-name${c.heim ? ' wk-name-heim' : ''}`, x: x.toFixed(2), y: y.toFixed(2), 'font-size': fs.toFixed(3), 'stroke-width': ((2.5 * e) / k).toFixed(3),
      }, c.text));
    }
  }

  function legendeSetzen() {
    const eintraege = [
      el('span', { class: 'wk-legende-eintrag' }, [el('span', { class: 'wk-legende-punkt ich', 'aria-hidden': 'true' }), t('dashboard.karte_legende_ich')]),
      el('span', { class: 'wk-legende-eintrag' }, [el('span', { class: 'wk-legende-punkt', 'aria-hidden': 'true' }), t('dashboard.karte_legende_fern')]),
      el('span', { class: 'wk-legende-eintrag wk-legende-linie', text: t('dashboard.karte_legende_linie') }),
      ohneOrt ? el('span', { class: 'wk-legende-eintrag', text: t('dashboard.karte_ohne_ort', { n: ohneOrt }) }) : null,
    ].filter(Boolean);
    const neu = eintraege.map((x) => x.textContent).join('|');
    if (legende.dataset.stand === neu) return;
    legende.textContent = '';
    for (const x of eintraege) legende.appendChild(x);
    legende.dataset.stand = neu;
  }

  function hinweiseSetzen() {
    const liste = [];
    if (weltFehler) liste.push([t('dashboard.karte_fehler_karte'), 'warnung']);
    if (daten && !laedt) { // der Platzhalter beim Laden sagt nichts über Standort oder Verbindungen
      if (!daten.aufzeichnung) liste.push([t('dashboard.karte_aus'), 'info']);
      else {
        if (!daten.werkzeug.ok) liste.push([daten.werkzeug.hinweis || t('dashboard.karte_werkzeug'), 'warnung']);
        // läuft, meldet aber etwas (Tabelle gekürzt, eine Familie nicht lesbar) – als Info
        else if (daten.werkzeug.hinweis) liste.push([daten.werkzeug.hinweis, 'info']);
        if (!daten.heimat) liste.push([t('dashboard.karte_kein_standort'), 'info']);
        if (daten.geo.quelle === 'keine') liste.push([t('dashboard.karte_keine_ortsdaten'), 'warnung']);
        if (!liste.length && !daten.gegenstellen.length) liste.push([t('dashboard.karte_leer'), 'info']);
      }
    }
    const neu = liste.map(([x]) => x).join('|');
    if (hinweisBox.dataset.stand === neu) return;
    hinweisBox.textContent = '';
    for (const [x, art] of liste) hinweisBox.appendChild(el('p', { class: `wk-hinweis wk-hinweis-${art}`, text: x }));
    hinweisBox.dataset.stand = neu;
  }

  function zeichnen() {
    if (zerstoert) return;
    hinweiseSetzen();
    if (!daten) return;
    wurzel.classList.toggle('wk-ein', daten.richtung === 'ein');
    wurzel.classList.toggle('wk-aus', daten.richtung !== 'ein');
    wurzel.classList.toggle('wk-ruhig', reduziert());
    wurzel.classList.toggle('gefiltert', !!filter);
    wurzel.classList.toggle('wk-laedt', laedt);
    if (laedt) flaeche.setAttribute('aria-busy', 'true'); else flaeche.removeAttribute('aria-busy');
    if (!welt && !weltFehler) return; // Umrisse laden noch – danach wird gezeichnet
    datenStand++;
    sammeln();
    zeichneLaender();
    zeichneOrte();
    zeichneHeim();
    massstabAnwenden();
    legendeSetzen();
  }

  // --- Live: Ticker und Flüge ---------------------------------------------------------------------------------------
  function liveLeeren() {
    // auch die noch nicht gestarteten (verzögerten) Flüge – sonst flögen sie nach dem Umschalten auf der leeren Karte
    for (const id of geplanteFluege) { clearTimeout(id); zeitgeber.delete(id); }
    geplanteFluege.clear();
    ticker.textContent = '';
    for (const f of [...fluege]) { fluege.delete(f); f.g.remove(); }
    gFluege.textContent = '';
  }

  /** Neue Verbindungen seit dem letzten Stand: neue Gegenstelle oder mehr Verbindungen, jeweils nach der vorigen Zeit. */
  function neueErkennen(neu) {
    const alt = vorher;
    vorher = { richtung: neu.richtung, zeit: neu.zeit, anzahl: new Map(neu.gegenstellen.map((g) => [g.ip, g.anzahl])) };
    // Richtung gewechselt: Ticker und laufende Flüge gehören zur alten Richtung (sonst „Heimnetz → Web“ unter Ausgehend)
    if (alt && alt.richtung !== neu.richtung) liveLeeren();
    if (!alt || alt.richtung !== neu.richtung || !neu.aufzeichnung) return [];
    return neu.gegenstellen
      .filter((g) => g.zuletzt > alt.zeit && (!alt.anzahl.has(g.ip) || g.anzahl > alt.anzahl.get(g.ip)))
      .map((g) => ({ g, n: alt.anzahl.has(g.ip) ? g.anzahl - alt.anzahl.get(g.ip) : g.anzahl }));
  }

  function live(neue) {
    const gruppen = new Map();
    for (const { g, n } of neue) {
      if (filter && !g.lokal.some((l) => l.name === filter)) continue;
      const schluessel = g.privat ? 'heim' : g.ort ? ortSchluessel(g.ort) : null;
      if (!schluessel) continue; // Anycast/ohne Ort: nur in der Liste
      const gr = gruppen.get(schluessel) || { privat: g.privat, ort: g.ort, n: 0, ips: [], lokal: new Map(), zuletzt: 0 };
      gr.n += n; gr.ips.push(g.ip); lokalDazu(gr.lokal, g.lokal); gr.zuletzt = Math.max(gr.zuletzt, g.zuletzt);
      gruppen.set(schluessel, gr);
    }
    const reihe = [...gruppen.values()].sort((a, b) => b.zuletzt - a.zuletzt || b.n - a.n);
    for (const gr of reihe.slice(0, TICKER_MAX).reverse()) tickerEintrag(gr);
    if (reduziert() || pausiert() || !daten.heimat || (!welt && !weltFehler)) return;
    const flugListe = reihe.filter((gr) => !gr.privat).slice(0, FLUG_MAX);
    const abstand = flugListe.length > 1 ? Math.min(700, 2600 / flugListe.length) : 0;
    flugListe.forEach((gr, i) => {
      if (i === 0) { flugStarten(gr); return; }
      const id = nachher(() => { geplanteFluege.delete(id); flugStarten(gr); }, i * abstand);
      geplanteFluege.add(id);
    });
  }

  function tickerEintrag(gr) {
    const ortText = gr.privat ? t('dashboard.karte_heimnetz') : `${flagge(gr.ort.land)} ${gr.ort.stadt || gr.ort.land_name || gr.ort.land}`.trim();
    const lokal = [...gr.lokal.entries()].sort((a, b) => b[1] - a[1]);
    const lokalText = lokal.length ? `${lokal[0][0]}${lokal.length > 1 ? ` +${lokal.length - 1}` : ''}` : '–';
    const zeile = daten.richtung === 'ein' ? t('dashboard.karte_flug_ein', { ort: ortText, lokal: lokalText }) : t('dashboard.karte_flug_aus', { lokal: lokalText, ort: ortText });
    const eintrag = el('div', { class: `wk-ticker-eintrag${gr.privat ? ' heim' : ''}`, title: gr.ips.join(', ') }, [
      el('span', { class: 'wk-ticker-punkt', 'aria-hidden': 'true' }),
      el('span', { class: 'wk-ticker-text', text: zeile }),
      gr.n > 1 ? el('span', { class: 'wk-ticker-zahl', text: `×${gr.n}` }) : null,
      el('span', { class: 'wk-ticker-zeit', text: uhrzeit(gr.zuletzt) }),
    ]);
    ticker.insertBefore(eintrag, ticker.firstChild);
    while (ticker.children.length > TICKER_MAX) ticker.children[ticker.children.length - 1].remove();
    nachher(() => { eintrag.classList.add('weg'); nachher(() => eintrag.remove(), 650); }, TICKER_MS);
  }

  function welle([x, y], heim) {
    if (pausiert() || reduziert()) return;
    const w = el('circle', { class: `wk-welle${heim ? ' heim' : ''}`, cx: z1(x), cy: z1(y), r: ((3.5 * markenFaktor()) / zoom.k).toFixed(3) });
    gFluege.appendChild(w);
    nachher(() => w.remove(), 1500);
  }

  function flugStarten(gr) {
    if (zerstoert || pausiert() || reduziert() || !daten || !daten.heimat || !gr.ort || fluege.size >= FLUG_MAX * 2) return;
    const heim = bildpunkt(daten.heimat.lon, daten.heimat.lat); const ort = bildpunkt(gr.ort.lon, gr.ort.lat);
    const ein = daten.richtung === 'ein';
    const [von, nach] = ein ? [ort, heim] : [heim, ort];
    const spur = el('path', { class: 'wk-flug-spur', d: bogenD(von, nach) });
    const schweif = el('path', { class: 'wk-flug-schweif' });
    const kopf = el('circle', { class: 'wk-flug-kopf', r: ((3.4 * markenFaktor()) / zoom.k).toFixed(3), cx: z1(von[0]), cy: z1(von[1]) });
    const g = el('g', { class: 'wk-flug' }, [spur, schweif, kopf]);
    gFluege.appendChild(g);
    welle(von, !ein);
    const laenge = (typeof spur.getTotalLength === 'function' && spur.getTotalLength()) || Math.hypot(nach[0] - von[0], nach[1] - von[1]) * 1.1;
    const flug = { g, spur, schweif, kopf, laenge, nach, zuHause: ein, dauer: klemmen(1000 + laenge * 3, 1400, 3000), start: null };
    fluege.add(flug);
    nachher(() => { fluege.delete(flug); g.remove(); }, flug.dauer + 4000); // Sicherung, falls rAF im Hintergrund ruht
    bildAnfordern();
  }

  function flugSchritt(f, jetzt) {
    if (!f.g.isConnected) { fluege.delete(f); return; }
    if (f.start == null) f.start = jetzt;
    const roh = Math.min(1, (jetzt - f.start) / f.dauer); const s = weich(roh);
    const p = f.spur.getPointAtLength(f.laenge * s);
    f.kopf.setAttribute('cx', z1(p.x)); f.kopf.setAttribute('cy', z1(p.y));
    const von = Math.max(0, s - 0.28); const punkte = [];
    for (let i = 0; i <= 10; i++) { const q = f.spur.getPointAtLength(f.laenge * (von + ((s - von) * i) / 10)); punkte.push(`${z1(q.x)},${z1(q.y)}`); }
    f.schweif.setAttribute('d', `M${punkte.join('L')}`);
    if (roh < 1) return;
    fluege.delete(f);
    f.schweif.remove(); f.kopf.remove();
    f.g.classList.add('fertig');
    welle(f.nach, f.zuHause);
    nachher(() => f.g.remove(), 950);
  }

  // --- Welt laden -----------------------------------------------------------------------------------------------------
  Promise.resolve()
    .then(() => holeWelt())
    .then((json) => {
      if (zerstoert) return;
      welt = landDaten(json).map((l) => ({ iso: l.iso, name: l.name, aktiv: false, knoten: el('path', { class: 'wk-land', 'data-iso': l.iso, d: l.d }) }));
      for (const l of welt) gLaender.appendChild(l.knoten);
    })
    .catch((fehler) => {
      if (zerstoert) return;
      welt = null; weltFehler = true;
      if (typeof console !== 'undefined') console.warn('[weltkarte] Kartendaten nicht ladbar:', (fehler && fehler.message) || fehler);
    })
    .then(() => {
      if (zerstoert) return;
      laden.remove();
      groesse();
      zeichnen();
    });

  // --- Schnittstelle ----------------------------------------------------------------------------------------------------
  function groesse() {
    if (zerstoert) return;
    const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) e = klemmen(1 / Math.min(r.width / W, r.height / H), 1, E_MAX);
    tipVerstecken();
    massstabAnwenden();
  }

  return {
    /**
     * Neues Ergebnis von netz.verbindungen zeichnen; optionen.filter setzt den Filter mit. optionen.laedt = Platzhalter
     * beim Umschalten der Richtung (leere Gegenstellen, Standort beibehalten): Karte sofort leer und abgedunkelt
     * (.wk-laedt, aria-busy), keine Hinweise aus dem Platzhalter, Ticker und Flüge weg; die nächsten echten Daten gelten
     * als erster Stand (keine Flüge).
     */
    setzeDaten(ergebnis, optionen) {
      if (zerstoert) return;
      if (optionen && typeof optionen === 'object' && 'filter' in optionen) filter = optionen.filter || null;
      const neu = normalisiere(ergebnis);
      laedt = !!(optionen && typeof optionen === 'object' && optionen.laedt);
      let neue = [];
      if (laedt) { vorher = null; liveLeeren(); } else neue = neueErkennen(neu);
      daten = neu;
      zeichnen();
      if (neue.length) live(neue);
    },
    /** Nur Orte mit diesem Absender/Dienst voll zeigen (übrige blass); null hebt den Filter auf. */
    setzeFilter(name) {
      if (zerstoert) return;
      filter = name || null;
      zeichnen();
    },
    groesse,
    /** Von außen anhalten (z. B. Kachel ausgeblendet): keine Flüge, Animationen stehen. */
    pausieren(an) {
      if (zerstoert) return;
      extern = !!an;
      pauseAktualisieren();
    },
    zerstoeren() {
      if (zerstoert) return;
      zerstoert = true;
      for (const id of zeitgeber) clearTimeout(id);
      zeitgeber.clear();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0; fluege.clear(); zoomAnim = null;
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', sichtHoerer);
      wurzel.remove();
      ortKnoten.clear(); ortNach.clear();
    },
  };
}
