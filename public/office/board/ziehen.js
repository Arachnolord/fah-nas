// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Karten ziehen (Plan 04): Zielberechnung aus einer Geometrie-Momentaufnahme (Spalten nebeneinander, Karten
// untereinander) und das Einrichten der Zeigerereignisse – Maus/Stift ab 5 px Bewegung, Touch erst nach 300 ms Halten
// ohne mehr als 8 px Bewegung (sonst blättert die Seite), Esc bricht ab.

const MAUS_PX = 5;
const TOUCH_MS = 300;
const TOUCH_PX = 8;

/**
 * Ziel für die Karte `ziehendeId` am Punkt (x, y): Spalte unter x und die Nachbarn, zwischen die sie fällt (die gezogene
 * Karte selbst zählt nicht mit – über sich selbst ergibt das ihre bisherigen Nachbarn). Außerhalb jeder Spalte → null.
 */
export function zielBerechnen(spalten, x, y, ziehendeId) {
  const s = (spalten || []).find((sp) => x >= sp.links && x <= sp.rechts);
  if (!s) return null;
  const karten = (s.karten || []).filter((k) => k.id !== ziehendeId);
  let vor = null;
  for (const k of karten) {
    if (y < (k.oben + k.unten) / 2) return { spalte: s.id, vor, nach: k.id };
    vor = k.id;
  }
  return { spalte: s.id, vor, nach: null };
}

/**
 * Ziehen an `element` einrichten. beiStart({x, y}), beiZug({x, y}), beiEnde({x, y, abgebrochen}). Gibt die Abmeldung
 * zurück. Während des Ziehens hält das Element den Zeiger (setPointerCapture) und die Seite blättert nicht.
 */
export function ziehenEinrichten(element, { beiStart, beiZug, beiEnde }) {
  let z = null; // {id, art, x0, y0, timer, laeuft, x, y}
  const aufraeumen = () => {
    if (z && z.timer) clearTimeout(z.timer);
    document.removeEventListener('keydown', taste, true);
    z = null;
  };
  const starten = () => {
    z.laeuft = true; z.timer = null;
    try { element.setPointerCapture?.(z.id); } catch { /* schon losgelassen */ }
    document.addEventListener('keydown', taste, true);
    beiStart({ x: z.x, y: z.y });
  };
  const beenden = (abgebrochen) => {
    if (!z) return;
    const war = z;
    aufraeumen();
    try { element.releasePointerCapture?.(war.id); } catch { /* egal */ }
    if (war.laeuft) beiEnde({ x: war.x, y: war.y, abgebrochen });
  };
  function taste(ev) {
    if (ev.key !== 'Escape' || !z || !z.laeuft) return;
    ev.preventDefault(); ev.stopPropagation();
    beenden(true);
  }
  const unten = (ev) => {
    if (z || (ev.pointerType === 'mouse' && ev.button !== 0) || ev.isPrimary === false) return;
    z = { id: ev.pointerId, art: ev.pointerType || 'mouse', x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, laeuft: false, timer: null };
    if (z.art === 'touch') z.timer = setTimeout(() => { if (z && !z.laeuft) starten(); }, TOUCH_MS);
  };
  const bewegt = (ev) => {
    if (!z || ev.pointerId !== z.id) return;
    z.x = ev.clientX; z.y = ev.clientY;
    const weg = Math.hypot(z.x - z.x0, z.y - z.y0);
    if (!z.laeuft) {
      if (z.art === 'touch') { if (weg > TOUCH_PX) aufraeumen(); return; } // blättert
      if (weg < MAUS_PX) return;
      starten();
    }
    ev.preventDefault?.();
    beiZug({ x: z.x, y: z.y });
  };
  const oben = (ev) => { if (z && ev.pointerId === z.id) beenden(false); };
  const abbruch = (ev) => { if (z && ev.pointerId === z.id) beenden(true); };
  const touchBewegt = (ev) => { if (z && z.laeuft) ev.preventDefault(); }; // blättern verhindern, solange gezogen wird
  element.addEventListener('pointerdown', unten);
  element.addEventListener('pointermove', bewegt);
  element.addEventListener('pointerup', oben);
  element.addEventListener('pointercancel', abbruch);
  element.addEventListener('touchmove', touchBewegt, { passive: false });
  return () => {
    aufraeumen();
    element.removeEventListener('pointerdown', unten);
    element.removeEventListener('pointermove', bewegt);
    element.removeEventListener('pointerup', oben);
    element.removeEventListener('pointercancel', abbruch);
    element.removeEventListener('touchmove', touchBewegt, { passive: false });
  };
}
