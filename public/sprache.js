// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sprachdateien: lädt public/sprache/<sprache>/<bereich>.json für alle bekannten Bereiche, flacht verschachtelte
// Objekte zu Punkt-Schlüsseln ab und mischt sie. Doppelte Schlüssel über Dateien hinweg werden gemeldet.

/** Bekannte Bereiche (Dateien, die es geben kann; fehlende werden übersprungen). */
export const BEREICHE = Object.freeze([
  'gemeinsam', 'dashboard', 'dateien', 'apps', 'freigaben', 'laufwerke', 'nutzer', 'snapshots', 'spiegelung', 'system', 'vms', 'anmeldung', 'chat', 'office',
]);

/** Flacht {a:{b:"x"}} zu {"a.b":"x"} ab. Werte bleiben Text (Zahlen/Boolesche werden zu Text). */
export function flach(obj, vorsilbe = '', aus = {}) {
  if (!obj || typeof obj !== 'object') return aus;
  for (const [k, v] of Object.entries(obj)) {
    const voll = vorsilbe ? `${vorsilbe}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flach(v, voll, aus);
    else aus[voll] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return aus;
}

/**
 * Mischt mehrere Bereiche: `teile` = [{bereich, daten}]. Gibt {texte, doppelte:[{schluessel, bereiche}]} zurück.
 * Schlüsselregel: ein Schlüssel OHNE Punkt bekommt den Dateinamen als Vorsilbe (`anmeldung.json` → "name" wird
 * "anmeldung.name"); ein Schlüssel MIT Punkt gilt als vollständig ("rahmen.laden" in gemeinsam.json bleibt so).
 * Bei Dopplung gewinnt der zuerst geladene Bereich (gemeinsam), damit Rahmentexte stabil bleiben.
 */
export function mischen(teile) {
  const texte = {};
  const herkunft = {};
  const doppelte = [];
  for (const { bereich, daten } of teile) {
    for (const [roh, v] of Object.entries(flach(daten))) {
      const k = roh.includes('.') ? roh : `${bereich}.${roh}`;
      if (k in texte) { doppelte.push({ schluessel: k, bereiche: [herkunft[k], bereich] }); continue; }
      texte[k] = v; herkunft[k] = bereich;
    }
  }
  return { texte, doppelte };
}

/**
 * Erzeugt die t()-Funktion: `t("bereich.schluessel", {name:"x"})` ersetzt {name}; `{n|Eintrag|Einträge}` wählt Ein-/Mehrzahl.
 * Fehlende Schlüssel geben den
 * Schlüssel selbst zurück und landen in `t.fehlend` (Menge) – so fallen sie im Test und in der Konsole auf.
 */
export function erzeugeT(texte) {
  const fehlend = new Set();
  const t = (schluessel, werte) => {
    let text = texte[schluessel];
    if (text === undefined) {
      if (!fehlend.has(schluessel)) { fehlend.add(schluessel); if (typeof console !== 'undefined') console.warn(`[sprache] fehlt: ${schluessel}`); }
      text = schluessel;
    }
    if (Array.isArray(text)) text = text.join('\n');
    if (werte && typeof werte === 'object') {
      // Pluralform: {n|Eintrag|Einträge} → Einzahl bei genau 1, sonst Mehrzahl
      text = text.replace(/\{([a-zA-Z0-9_]+)\|([^|}]*)\|([^}]*)\}/g, (ganz, name, eins, viele) => (name in werte ? (Number(werte[name]) === 1 ? eins : viele) : ganz));
      text = text.replace(/\{([a-zA-Z0-9_]+)\}/g, (ganz, name) => (name in werte && werte[name] != null ? String(werte[name]) : ganz));
    }
    return text;
  };
  t.fehlend = fehlend;
  t.hat = (schluessel) => schluessel in texte;
  t.texte = texte;
  return t;
}

/**
 * Lädt alle Bereiche (parallel) und mischt sie. Fehlende Dateien (404) sind kein Fehler.
 * @returns {Promise<{texte:object, doppelte:Array, geladen:string[]}>}
 */
export async function ladeSprache(sprache = 'de', bereiche = BEREICHE, basis = new URL('./sprache/', import.meta.url)) {
  const geladen = [];
  const teile = await Promise.all(bereiche.map(async (bereich) => {
    const url = new URL(`${sprache}/${bereich}.json`, basis);
    try {
      const antwort = await fetch(url, { credentials: 'same-origin' });
      if (!antwort.ok) return null;
      const daten = await antwort.json();
      geladen.push(bereich);
      return { bereich, daten };
    } catch (e) {
      if (typeof console !== 'undefined') console.warn(`[sprache] ${bereich}.json nicht ladbar:`, e && e.message);
      return null;
    }
  }));
  const { texte, doppelte } = mischen(teile.filter(Boolean));
  if (doppelte.length && typeof console !== 'undefined') {
    console.warn('[sprache] doppelte Schlüssel:', doppelte.map((d) => `${d.schluessel} (${d.bereiche.join(', ')})`).join('; '));
  }
  return { texte, doppelte, geladen };
}
