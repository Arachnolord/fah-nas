// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Meldungen des Agenten in der englischen Oberfläche (Betreiber 12.10.2026: „Meldungen des Agenten in der englischen
// Oberfläche übersetzen“). Der Agent spricht deutsch; sprache/agent-en.json ordnet jedem deutschen Text (mit Platzhaltern
// {1}, {2} … für eingesetzte Werte) den englischen zu. Unbekannte Texte bleiben, wie sie sind.

let tabelle = null; // {genau: Map<de, en>, muster: [{re, en}]}

/** Muster „Freigabe „{1}“ gibt es schon“ → RegExp mit Gruppen (Platzhalter in Textreihenfolge). */
export function musterRegex(de) {
  const teile = String(de).split(/\{(\d+)\}/);
  let quelle = '^';
  const reihenfolge = [];
  teile.forEach((teil, i) => {
    if (i % 2) { reihenfolge.push(Number(teil)); quelle += '([\\s\\S]+?)'; } else quelle += teil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { re: new RegExp(`${quelle}$`), reihenfolge };
}

/** Tabelle aus [[de, en], …] aufbauen (genaue Texte zuerst, Muster mit mehr festem Text vor kürzeren). */
export function tabelleAufbauen(paare) {
  const genau = new Map(); const muster = [];
  for (const p of Array.isArray(paare) ? paare : []) {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string' || !p[1]) continue;
    if (/\{\d+\}/.test(p[0])) { const m = musterRegex(p[0]); muster.push({ ...m, en: p[1], fest: p[0].replace(/\{\d+\}/g, '').length }); } else genau.set(p[0], p[1]);
  }
  muster.sort((a, b) => b.fest - a.fest);
  return { genau, muster };
}

/** Text übersetzen (nur wenn die englische Tabelle geladen ist). */
export function agentText(s, t = tabelle) {
  if (!t || typeof s !== 'string' || !s) return s;
  const g = t.genau.get(s);
  if (g) return g;
  for (const m of t.muster) {
    const x = m.re.exec(s);
    if (!x) continue;
    const werte = {}; m.reihenfolge.forEach((nr, i) => { werte[nr] = x[i + 1]; });
    return m.en.replace(/\{(\d+)\}/g, (_, nr) => (werte[nr] !== undefined ? agentText(werte[nr], t) : ''));
  }
  return s;
}

/** Beim Sprachwechsel: Englisch → Tabelle laden, sonst leeren. */
export async function agentTexteLaden(sprache) {
  if (sprache !== 'en') { tabelle = null; return; }
  try {
    const r = await fetch(new URL('./sprache/agent-en.json', import.meta.url).href, { credentials: 'same-origin' });
    tabelle = r.ok ? tabelleAufbauen(await r.json()) : null;
  } catch { tabelle = null; }
}
