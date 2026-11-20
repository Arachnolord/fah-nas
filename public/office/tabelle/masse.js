// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Maße des Tabellen-Rasters (Plan 06): Zeilenhöhen bzw. Spaltenbreiten als Präfixsummen, damit das virtualisierte
// Raster Position ↔ Index schnell umrechnet (binäre Suche statt Aufsummieren bei jedem Bildlauf). Versteckte Einträge
// (gefilterte Zeilen) haben die Höhe 0 und werden beim Treffen übersprungen. Ohne DOM.

import { GRENZEN, adresseLesen, textZuSpalte } from './formeln/adresse.js';

/** Angezeigt werden mindestens so viele Zeilen/Spalten, sonst die belegten plus Reserve (Global Constraints). */
const MINDESTENS = Object.freeze({ zeilen: 100, spalten: 26 });
const RESERVE = Object.freeze({ zeilen: 50, spalten: 10 });
const OHNE_GRENZEN = Object.freeze({ zeilen: Infinity, spalten: Infinity });

/** Größen von `anzahl` Einträgen (1-basiert): Standard, eigene Werte, versteckte mit 0. */
export class Masse {
  constructor({ standard, eigene = new Map(), versteckt = new Set(), anzahl }) {
    this.standard = standard; this.eigene = eigene; this.versteckt = versteckt; this.anzahl = Math.max(0, Math.floor(anzahl));
    this._summen = null; // Präfixsummen, erst beim ersten Gebrauch: _summen[i] = Position von Eintrag i, _summen[anzahl + 1] = Summe
  }

  /** Größe eines Eintrags in px. */
  groesse(i) {
    if (this.versteckt.has(i)) return 0;
    return this.eigene.get(i) ?? this.standard;
  }

  _vorbereiten() {
    if (this._summen) return this._summen;
    const s = new Float64Array(this.anzahl + 2);
    for (let i = 1; i <= this.anzahl; i++) s[i + 1] = s[i] + this.groesse(i);
    this._summen = s;
    return s;
  }

  /** Abstand des Anfangs von Eintrag i zum Anfang von Eintrag 1 (px); i jenseits des Endes → Summe. */
  position(i) {
    const s = this._vorbereiten();
    return s[Math.min(Math.max(1, Math.floor(i)), this.anzahl + 1)];
  }

  get summe() { return this._vorbereiten()[this.anzahl + 1]; }

  /** Eintrag, der die Position px enthält; versteckte werden übersprungen, davor → 1, dahinter → letzter sichtbarer. */
  index(px) {
    const s = this._vorbereiten();
    if (this.anzahl < 1) return 1;
    if (!(px > 0)) return 1;
    let lo = 1, hi = this.anzahl; // größtes i mit s[i] ≤ px
    while (lo < hi) {
      const mitte = (lo + hi + 1) >> 1;
      if (s[mitte] <= px) lo = mitte; else hi = mitte - 1;
    }
    // Ein versteckter Eintrag hat dieselbe Position wie der nächste – nur am Ende kann der Treffer selbst versteckt sein
    while (lo > 1 && this.groesse(lo) === 0) lo--;
    return lo;
  }
}

/** Sichtbare Zeilen und Spalten eines Ausschnitts (px), mit Puffer zum Vorzeichnen. */
export function sichtbarerBereich({ oben, links, hoehe, breite, zeilen, spalten, puffer = { z: 2, s: 1 } }) {
  return {
    z1: Math.max(1, zeilen.index(oben) - puffer.z), z2: Math.min(zeilen.anzahl, zeilen.index(oben + hoehe - 1) + puffer.z),
    s1: Math.max(1, spalten.index(links) - puffer.s), s2: Math.min(spalten.anzahl, spalten.index(links + breite - 1) + puffer.s),
  };
}

/**
 * Maße eines Blatts: eigene Zeilenhöhen und Spaltenbreiten aus den Daten, versteckte Zeilen (Filter) mit Höhe 0.
 * Anzahl: mindestens 100 Zeilen und 26 Spalten, sonst die letzte belegte plus 50 bzw. 10, höchstens GRENZEN.
 */
export function masseAusBlatt(blatt, { versteckt = new Set(), hoehe = 24, breite = 100 } = {}) {
  let zMax = 0, sMax = 0;
  for (const adr of Object.keys(blatt?.zellen || {})) {
    const a = adresseLesen(adr, OHNE_GRENZEN);
    if (a) { if (a.z > zMax) zMax = a.z; if (a.s > sMax) sMax = a.s; }
  }
  const zeilenHoehen = new Map();
  for (const [k, v] of Object.entries(blatt?.zeilen || {})) if (Number.isFinite(v?.hoehe)) zeilenHoehen.set(Number(k), v.hoehe);
  const spaltenBreiten = new Map();
  for (const [k, v] of Object.entries(blatt?.spalten || {})) if (Number.isFinite(v?.breite)) spaltenBreiten.set(textZuSpalte(k), v.breite);
  return {
    zeilen: new Masse({ standard: hoehe, eigene: zeilenHoehen, versteckt, anzahl: Math.min(GRENZEN.zeilen, Math.max(MINDESTENS.zeilen, zMax + RESERVE.zeilen)) }),
    spalten: new Masse({ standard: breite, eigene: spaltenBreiten, anzahl: Math.min(GRENZEN.spalten, Math.max(MINDESTENS.spalten, sMax + RESERVE.spalten)) }),
  };
}
