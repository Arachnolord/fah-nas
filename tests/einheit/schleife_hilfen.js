// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Test-Hilfe: Wie lange steht die Ereignisschleife, während `fn` läuft? Ein 5-ms-Takt (setInterval) misst jede Lücke
// zwischen zwei Takten zweimal – als Wandzeit und als Rechenzeit des Prozesses (process.cpuUsage). Gezählt wird das
// Kleinere von beiden: blockiert der Prozess selbst, sind beide gleich groß; wird er nur vom Betriebssystem verdrängt
// (die Suite läuft parallel in vielen Prozessen, daneben arbeiten andere Programme), wächst nur die Wandzeit. So bleibt
// die Prüfung „nie länger als 200 ms blockiert“ auch auf einer voll ausgelasteten Maschine aussagekräftig.

import { performance } from 'node:perf_hooks';

const rechenMs = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };

/**
 * Führt `fn` aus und misst die Blockaden der Ereignisschleife.
 * @param {() => Promise<any>|any} fn
 * @returns {Promise<{ergebnis:any, luecke:number, wandLuecke:number, wand:number, rechen:number}>}
 *   luecke = größte Lücke (ms, Minimum aus Wand- und Rechenzeit), wandLuecke = größte Lücke nur nach Wanduhr,
 *   wand/rechen = Gesamtdauer von fn
 */
export async function blockadeMessen(fn, takt_ms = 5) {
  let letzteWand = performance.now(); let letzteRechen = rechenMs();
  let luecke = 0; let wandLuecke = 0;
  const messen = () => {
    const w = performance.now(); const r = rechenMs();
    luecke = Math.max(luecke, Math.min(w - letzteWand, r - letzteRechen));
    wandLuecke = Math.max(wandLuecke, w - letzteWand);
    letzteWand = w; letzteRechen = r;
  };
  const takt = setInterval(messen, takt_ms);
  const w0 = performance.now(); const r0 = rechenMs();
  let ergebnis;
  try { ergebnis = await fn(); } finally { clearInterval(takt); messen(); }
  return { ergebnis, luecke, wandLuecke, wand: performance.now() - w0, rechen: rechenMs() - r0 };
}
