// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rasterplatzierung der Übersicht (Betreiber 09.10.: „Rasterplatzierung wie bei einem Salesforce-Dashboard, Widgets frei
// verschieben“): 12 Spalten, Zeilen zu 40 px. Jede Kachel hat Position und Größe in Zellen {x, y, b, h}. Lücken bleiben,
// wo der Nutzer sie lässt; landet eine Kachel auf anderen, rutschen diese nach unten (nie Überlappung, nie automatisches
// Hochrutschen). Reine Funktionen ohne DOM – die Übersicht (dashboard.js) wendet das Ergebnis an.

export const SPALTEN = 12;
export const ZEILE_PX = 40;
export const ABSTAND_PX = 16;      // muss zu --dashboard-abstand passen (Umrechnung alter Pixelhöhen)
export const MIN_B = 2;
export const MIN_H = 2;
export const MAX_H = 40;
export const LAYOUT_VERSION = 4;

/** Standardgröße je Kachel in Zellen [Breite, Höhe] – so gewählt, dass der Inhalt hineinpasst (sonst rollt er). */
export const STANDARD_GROESSE = Object.freeze({
  cpu: [3, 4], ram: [3, 4], platte: [3, 5], netz: [3, 4], temperatur: [3, 3], system: [3, 4], dienste: [3, 5],
  aufgaben: [6, 4], ereignisse: [6, 6], weltkarte: [12, 10], apps: [3, 6], laufwerke: [3, 6], vms: [3, 4], spiegelung: [3, 5], meldungen: [3, 5], vpn: [3, 5], gpu: [3, 5], energie: [3, 5], protokolle: [3, 5], raid: [3, 5], wartung: [3, 5],
  freigaben: [3, 6], uhr: [3, 3], schnappschuesse: [3, 5], verbindungen: [3, 5], docker: [3, 5], updates: [3, 5], anmeldung: [3, 4], profil: [3, 4], links: [4, 6], anmeldeschutz: [3, 5], ordnerrechte: [3, 5], fahgit: [3, 5], gehaeuse: [3, 5], importe: [3, 5], speicherorte: [3, 5], chat: [4, 6], office: [4, 6], favoriten: [3, 5],
  systemleiste: [12, 3],
});
/** Neue Kacheln, die in einem gespeicherten Layout oben statt unten erscheinen (die anderen rutschen nach unten). */
export const NEU_OBEN = Object.freeze(['systemleiste']);

function ganz(n, min, max, standard) { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : standard; }

/** Kachel auf gültige Werte bringen (Breite 2–12, passt in die Zeile; Höhe 2–40). */
export function zelleNormal(e) {
  const b = ganz(e.b, MIN_B, SPALTEN, 3);
  return { id: e.id, x: ganz(e.x, 0, SPALTEN - b, 0), y: ganz(e.y, 0, 10_000, 0), b, h: ganz(e.h, MIN_H, MAX_H, 4) };
}

export function ueberlappt(a, b) { return a.x < b.x + b.b && b.x < a.x + a.b && a.y < b.y + b.h && b.y < a.y + a.h; }

/**
 * Überlappungen auflösen: `fest` (Kennung) bleibt, wo es ist; alle anderen behalten ihren Platz, außer sie überlappen –
 * dann rutschen sie (in Lesereihenfolge oben → unten, links → rechts) gerade so weit nach unten, bis sie frei sind.
 */
export function kollisionenAufloesen(liste, fest = null) {
  const festE = fest ? liste.find((e) => e.id === fest) : null;
  const platziert = festE ? [{ ...festE }] : [];
  const rest = liste.filter((e) => e !== festE).map((e) => ({ ...e })).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const e of rest) {
    let stoesst;
    while ((stoesst = platziert.filter((p) => ueberlappt(e, p))).length) e.y = Math.max(...stoesst.map((p) => p.y + p.h));
    platziert.push(e);
  }
  // in der ursprünglichen Reihenfolge zurück (stabile Kachel-Reihenfolge im DOM)
  return liste.map((e) => platziert.find((p) => p.id === e.id));
}

/** Unterkante des Rasters (erste ganz freie Zeile). */
export function unterkante(liste) { return liste.reduce((m, e) => Math.max(m, e.y + e.h), 0); }

/**
 * Zeilenweise Anordnung wie das alte Fließ-Layout: von links nach rechts, passt eine Kachel nicht mehr in die Zeile, beginnt
 * unter der höchsten Kachel der Zeile eine neue. `startY` = erste Zeile (z. B. unter vorhandenen Kacheln).
 */
export function flussPlatzieren(eintraege, startY = 0) {
  const aus = []; let x = 0; let y = startY; let zeilenHoehe = 0;
  for (const roh of eintraege) {
    const e = zelleNormal({ ...roh, x: 0, y: 0 });
    if (x + e.b > SPALTEN) { y += zeilenHoehe; x = 0; zeilenHoehe = 0; }
    aus.push({ ...e, x, y });
    x += e.b; zeilenHoehe = Math.max(zeilenHoehe, e.h);
  }
  return aus;
}

/** Alte Pixelhöhe (Layout v3, 40-px-Stufen) in Zeilen: so viele, dass die Kachel mindestens so hoch ist. */
export function zeilenAusPx(px) { return ganz(Math.ceil((Number(px) + ABSTAND_PX) / (ZEILE_PX + ABSTAND_PX)), MIN_H, MAX_H, 4); }

/** Standardgröße einer Kachel (aus der Tabelle, sonst 3 × 4). */
export function standardGroesse(id) { const g = STANDARD_GROESSE[id] || [3, 4]; return { b: g[0], h: g[1] }; }

/**
 * Wirksames Layout aus dem gespeicherten (oder null = Standard) und den vorhandenen Kacheln:
 * - Version 4: Zellen übernehmen, Überlappungen auflösen.
 * - ältere Versionen (Reihenfolge + Breite 1–4 von 4 Spalten + Mindesthöhe px): zeilenweise umrechnen (Breite × 3).
 * - Kacheln, die das Layout nicht kennt (neu nach einem Update), kommen unten dazu; ausgeblendete bleiben weg.
 * @param {object|null} l gespeichertes Layout
 * @param {string[]} ids vorhandene Kacheln in Standard-Reihenfolge
 * @returns {{kacheln:Array<{id,x,y,b,h}>, ausgeblendet:string[]}}
 */
export function layoutAufloesen(l, ids) {
  const vorhanden = new Set(ids);
  const aus = new Set(l && Array.isArray(l.ausgeblendet) ? l.ausgeblendet.filter((id) => vorhanden.has(id)) : []);
  const gesehen = new Set();
  const gespeichert = [];
  for (const e of (l && Array.isArray(l.kacheln) ? l.kacheln : [])) {
    if (!e || !vorhanden.has(e.id) || gesehen.has(e.id) || aus.has(e.id)) continue;
    gesehen.add(e.id); gespeichert.push(e);
  }
  let kacheln;
  if (l && l.version === LAYOUT_VERSION) kacheln = kollisionenAufloesen(gespeichert.map(zelleNormal));
  else {
    kacheln = flussPlatzieren(gespeichert.map((e) => {
      const std = standardGroesse(e.id);
      const breite = Math.round(Number(e.breite));
      return { id: e.id, b: breite >= 1 && breite <= 4 ? breite * 3 : std.b, h: Number(e.hoehe_px) > 0 ? zeilenAusPx(e.hoehe_px) : std.h };
    }));
  }
  let neu = ids.filter((id) => !gesehen.has(id) && !aus.has(id)).map((id) => ({ id, ...standardGroesse(id) }));
  if (l && Array.isArray(l.kacheln)) {
    for (const e of neu.filter((x) => NEU_OBEN.includes(x.id))) {
      kacheln = [{ id: e.id, x: 0, y: 0, b: e.b, h: e.h }, ...kacheln.map((k) => ({ ...k, y: k.y + e.h }))];
    }
    neu = neu.filter((x) => !NEU_OBEN.includes(x.id));
  }
  if (neu.length) kacheln = [...kacheln, ...flussPlatzieren(neu, unterkante(kacheln))];
  return { kacheln, ausgeblendet: ids.filter((id) => aus.has(id)) };
}

/** Speicherform des Layouts. */
export function layoutSpeicherform(w) {
  return { version: LAYOUT_VERSION, kacheln: w.kacheln.map((e) => ({ id: e.id, x: e.x, y: e.y, b: e.b, h: e.h })), ausgeblendet: [...w.ausgeblendet] };
}

/**
 * Neue Zellen nach einer Zieh-Bewegung (dx/dy in Pixeln, `schritt` = Pixel je Zelle inkl. Abstand):
 * art „bewegen“ verschiebt (rastet ab einer halben Zelle ein, bleibt im Raster), „groesse“ ändert Breite/Höhe ab der
 * oberen linken Ecke (2–12 Spalten bis zum rechten Rand, 2–40 Zeilen).
 */
export function zellenNachZiehen(start, { dx = 0, dy = 0, schritt, art }) {
  const sx = Math.round(dx / schritt.x); const sy = Math.round(dy / schritt.y);
  if (art === 'groesse') {
    const b = ganz(start.b + sx, MIN_B, SPALTEN - start.x, start.b);
    return { ...start, b, h: ganz(start.h + sy, MIN_H, MAX_H, start.h) };
  }
  return { ...start, x: ganz(start.x + sx, 0, SPALTEN - start.b, start.x), y: ganz(start.y + sy, 0, 10_000, start.y) };
}

/** Kachel `id` auf neue Zellen setzen und die anderen nach unten ausweichen lassen. */
export function kachelSetzen(kacheln, id, neu) {
  const liste = kacheln.map((e) => (e.id === id ? zelleNormal({ ...e, ...neu, id }) : e));
  return kollisionenAufloesen(liste, id);
}

/** Lesereihenfolge (oben → unten, links → rechts) – für die Handy-Ansicht und die Tastatur-Reihenfolge. */
export function lesereihenfolge(kacheln) { return [...kacheln].sort((a, b) => a.y - b.y || a.x - b.x).map((e) => e.id); }
