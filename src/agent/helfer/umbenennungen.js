// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Umbenannte Nutzer (Betreiber 20.10.2026: „usernamen nicht nachträglich ändern“): users.json führt `umbenennungen`
// [{alt, neu, zeit}]. Office-Inhalte (Kommentare, Karten: wer/ersteller/zustaendig/besitzer) liegen in Bündeln auf den
// Freigaben und sind oft gerade im Web-Dienst geöffnet – sie werden nicht auf der Platte umgeschrieben, sondern beim Laden
// übersetzt; das nächste Speichern schreibt dann die neuen Namen. Ketten (a → b → c) sind beim Merken schon aufgelöst.

/** Höchstens so viele Einträge (älteste fallen heraus). */
export const UMBENENNUNGEN_MAX = 500;
const SCHLUESSEL = new Set(['wer', 'ersteller', 'zustaendig', 'besitzer']);

/** In users.json-Daten merken: `neu` ist ab jetzt vergeben (alte Einträge mit alt = neu fallen weg), Ketten zeigen auf neu. */
export function umbenennungMerken(daten, alt, neu, zeit = new Date().toISOString()) {
  const liste = (Array.isArray(daten.umbenennungen) ? daten.umbenennungen : []).filter((u) => u && u.alt !== neu && u.alt !== alt);
  for (const u of liste) if (u.neu === alt) u.neu = neu;
  liste.push({ alt, neu, zeit });
  daten.umbenennungen = liste.slice(-UMBENENNUNGEN_MAX);
}

/** Ein Name wird neu vergeben (Nutzer angelegt): alte Inhalte mit diesem Namen gehören ab jetzt ihm. */
export function umbenennungVergessen(daten, name) {
  if (Array.isArray(daten.umbenennungen)) daten.umbenennungen = daten.umbenennungen.filter((u) => u && u.alt !== name);
}

/** Map alt → neu aus users.json (leer, wenn nichts umbenannt wurde). */
export async function umbenennungenLaden(w) {
  let d = null;
  try { d = await w.konfig.laden('users.json', null); } catch { /* keine */ }
  return new Map((Array.isArray(d && d.umbenennungen) ? d.umbenennungen : []).filter((u) => u && typeof u.alt === 'string' && typeof u.neu === 'string').map((u) => [u.alt, u.neu]));
}

/** Nutzerfelder (wer, ersteller, zustaendig, besitzer) in Office-Daten oder -Ops übersetzen; ohne Treffer derselbe Wert. */
export function namenErsetzen(wert, karte) {
  if (!karte || !karte.size) return wert;
  const tausch = (x) => (typeof x === 'string' && karte.has(x) ? karte.get(x) : x);
  const lauf = (v) => {
    if (Array.isArray(v)) return v.map(lauf);
    if (!v || typeof v !== 'object') return v;
    const aus = {};
    for (const [k, x] of Object.entries(v)) {
      if (SCHLUESSEL.has(k)) aus[k] = Array.isArray(x) ? [...new Set(x.map(tausch))] : tausch(x);
      else aus[k] = lauf(x);
    }
    return aus;
  };
  return lauf(wert);
}
