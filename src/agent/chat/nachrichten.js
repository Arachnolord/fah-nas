// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Nachrichten (Plan 02): senden, bearbeiten, löschen, Reaktionen, Lesestand und Systemeinträge – gemeinsam für
// NAS-Nutzer (`von` = Nutzername) und Gäste (`von` = 'gast:<id>'). Ansichten gibt es in zwei Fassungen: für NAS-Nutzer
// und für Gäste (ohne Login-Namen). Handy-Meldungen gehen nur an NAS-Mitglieder, die den Chat gerade nicht sichtbar
// offen haben, den Raum nicht stumm geschaltet haben und nicht selbst schreiben – und tragen nie den Nachrichtentext.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { nachrichtId } from './ablage.js';
import { laden, anhaengen } from './verlauf.js';
import { raumAendern, raumLaden, chatEreignis, empfaenger, nutzerDaten, anzeigename } from './raeume.js';
import { persoenlichSenden } from '../benachrichtigung/persoenlich.js';
import { anhangAnsichten, anhaengeBinden, anhaengeLoeschen } from './anhaenge.js';

const ADRESSE = /^https?:\/\/[^/\s]+$/;
/** Erlaubte Reaktionen – dieselbe Liste wie die Oberfläche (public/chat/eingabe.js, Test prüft Gleichheit). */
export const EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🎉', '👀', '✅']);
const istGast = (von) => typeof von === 'string' && von.startsWith('gast:');

/** Darf ein Gast (Eintrag aus raum.gaeste) diese Nachricht sehen? Nur, was ab seinem Beitritt geschrieben wurde. */
export function gastSichtbar(n, gast) { return !!n && !!gast && typeof gast.seit === 'string' && String(n.zeit) >= gast.seit; }

/** Gäste eines Raums, die Nachricht `n` sehen dürfen (sortierte IDs). */
function gaesteFuer(raum, n) { return Object.entries(raum.gaeste || {}).filter(([, g]) => gastSichtbar(n, g)).map(([id]) => id).sort(); }

/** Empfänger eines Ereignisses zu Nachricht `n`: alle Mitglieder, Gäste nur, wenn sie die Nachricht sehen dürfen. */
function anFuer(raum, n) { return { nutzer: empfaenger(raum).nutzer, gaeste: gaesteFuer(raum, n) }; }

/** Kurzfassung für Übersicht und Zitate: Leerraum zusammengefasst, höchstens `max` Zeichen. */
export function kurz(text, max = 80) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Name eines NAS-Mitglieds für Gäste: Anzeigename, sonst „Mitglied N“ (Reihenfolge des Beitritts) – nie der Login-Name
 * (Gäste kommen aus dem Internet; Prüfbericht Plan 02, Befund 11).
 */
export function gastAnzeigename(raum, namen, name) {
  const n = namen && namen.get(name);
  if (n && n.anzeigename && n.anzeigename !== name) return n.anzeigename;
  const m = (raum && raum.mitglieder) || {};
  const reihe = Object.keys(m).sort((a, b) => String(m[a].seit).localeCompare(String(m[b].seit)) || a.localeCompare(b));
  const i = reihe.indexOf(name);
  return i >= 0 ? `Mitglied ${i + 1}` : 'Mitglied';
}

/** Name eines Absenders: NAS-Nutzer → Anzeigename (für Gäste ohne Login-Namen), Gast → Name aus raum.gaeste (sonst „Gast“). */
export function absenderName(raum, namen, von, { fuerGast = false } = {}) {
  if (!von) return '';
  if (istGast(von)) {
    const id = von.slice(5);
    const g = raum && ((raum.gaeste && raum.gaeste[id]) || (raum.gaeste_alt && raum.gaeste_alt[id]));
    return (g && g.name) || 'Gast';
  }
  return fuerGast ? gastAnzeigename(raum, namen, von) : anzeigename(namen, von);
}

/** Reaktionen in Gast-Fassung: NAS-Login-Namen → Anzeigenamen bzw. „Mitglied N“, Gäste behalten 'gast:<id>'. */
export function reaktionenFuerGast(raum, namen, reaktionen) {
  const aus = {};
  for (const [e, liste] of Object.entries(reaktionen || {})) aus[e] = liste.map((x) => (istGast(x) ? x : absenderName(raum, namen, x, { fuerGast: true })));
  return aus;
}

/**
 * Nachricht → Ansicht für die Oberfläche (`fuerGast`: NAS-Login-Namen werden durch Anzeigenamen ersetzt). Zitate von
 * Nachrichten vor dem Beitritt (`gastSeit`) bzw. mit `zitatVerbergen` erscheinen für Gäste nur als {frueher:true}.
 */
export async function ansicht(w, raum, n, { namen, fuerGast = false, zustand = null, gastSeit = null, zitatVerbergen = false } = {}) {
  const nm = namen || await nutzerDaten(w);
  const name = (v) => absenderName(raum, nm, v, { fuerGast });
  const aus = {
    id: n.id, zeit: n.zeit, von: fuerGast && n.von && !istGast(n.von) ? null : n.von, von_name: n.von ? name(n.von) : '', gast: istGast(n.von),
    text: n.text, anhaenge: n.geloescht || !n.anhaenge || !n.anhaenge.length ? [] : await anhangAnsichten(w, raum.id, n.anhaenge), reaktionen: {},
  };
  for (const [emoji, wer] of Object.entries(n.reaktionen || {})) aus.reaktionen[emoji] = fuerGast ? wer.map((x) => (istGast(x) ? x : name(x))) : [...wer];
  if (n.antwort) {
    const o = zustand && zustand.nachrichten.get(n.antwort);
    if (o && fuerGast && (zitatVerbergen || (gastSeit && String(o.zeit) < gastSeit))) aus.antwort = { frueher: true };
    else if (o) aus.antwort = { id: o.id, von_name: o.von ? name(o.von) : '', kurz: kurz(o.text), ...(o.geloescht ? { geloescht: true } : {}) };
  }
  if (n.bearbeitet) aus.bearbeitet = n.bearbeitet;
  if (n.geloescht) aus.geloescht = n.geloescht;
  if (n.system) aus.system = { art: n.system.art, wer_name: n.system.wer ? name(n.system.wer) : '', daten: n.system.daten ?? null };
  return aus;
}

/**
 * Beide Fassungen einer Nachricht und das Ereignis an alle Empfänger. Zitiert sie eine Nachricht, die ein Gast nicht sehen
 * darf (vor seinem Beitritt), bekommt dieser Gast ein eigenes Ereignis mit der Fassung ohne Zitat.
 */
async function verteilen(w, raum, art, n, zustand) {
  const namen = await nutzerDaten(w);
  const daten = await ansicht(w, raum, n, { namen, zustand });
  const datenGast = await ansicht(w, raum, n, { namen, zustand, fuerGast: true });
  const o = n.antwort ? zustand.nachrichten.get(n.antwort) : null;
  const ohne = o ? Object.keys(raum.gaeste || {}).filter((id) => !gastSichtbar(o, raum.gaeste[id])).sort() : [];
  if (!ohne.length) chatEreignis(w, raum, art, daten, { datenGast });
  else {
    const mit = Object.keys(raum.gaeste || {}).filter((id) => !ohne.includes(id)).sort();
    chatEreignis(w, raum, art, daten, { datenGast, an: { nutzer: empfaenger(raum).nutzer, gaeste: mit } });
    const ohneZitat = await ansicht(w, raum, n, { namen, zustand, fuerGast: true, zitatVerbergen: true });
    chatEreignis(w, raum, art, ohneZitat, { datenGast: ohneZitat, an: { nutzer: [], gaeste: ohne } });
  }
  return { daten, datenGast, namen };
}

/** Letzte sichtbare Nachricht eines Raums (für die Übersicht) oder null. */
function letzteAus(zustand) {
  for (let i = zustand.ids.length - 1; i >= 0; i--) {
    const n = zustand.nachrichten.get(zustand.ids[i]);
    if (n && !n.geloescht && !n.system) return { id: n.id, zeit: n.zeit, von: n.von, kurz: kurz(n.text) || '📎' };
  }
  return null;
}

/**
 * Nachricht senden; gibt die Ansicht zurück (NAS-Fassung; für Gäste die Gast-Fassung). `gast` = Eintrag des sendenden
 * Gasts: Antworten auf Nachrichten vor seinem Beitritt gelten als nicht vorhanden.
 */
export async function senden(w, raum, { von, vonName = null, text = '', antwort = null, anhaenge = [], aktiv = [], gast = null }) {
  const zustand = await laden(w, raum.id);
  const t = String(text ?? '');
  const liste = Array.isArray(anhaenge) ? anhaenge : [];
  if (!t.trim() && !liste.length) throw new FahnasFehler('E_PARAMS', 'Die Nachricht ist leer', { feld: 'text' });
  if (antwort) {
    const o = zustand.nachrichten.get(antwort);
    if (!o || o.system || (gast && !gastSichtbar(o, gast))) throw new FahnasFehler('E_PARAMS', 'Die Nachricht, auf die du antwortest, gibt es nicht', { feld: 'antwort' });
  }
  const id = nachrichtId(); const zeit = new Date().toISOString();
  const metas = liste.length ? await anhaengeBinden(w, raum, liste, von, id) : [];
  await anhaengen(w, raum.id, { t: 'n', id, zeit, von, text: t, ...(antwort ? { antwort } : {}), ...(liste.length ? { anhaenge: liste } : {}) });
  const r = await raumAendern(w, raum.id, (d) => {
    const x = { ...d, mitglieder: { ...d.mitglieder }, gaeste: { ...(d.gaeste || {}) } };
    x.letzte = { id, zeit, von, kurz: kurz(t) || (metas.length ? `📎 ${metas[0].name}` : '📎') };
    for (const m of Object.keys(x.mitglieder)) if (m !== von) x.mitglieder[m] = { ...x.mitglieder[m], ungelesen: (x.mitglieder[m].ungelesen || 0) + 1 };
    for (const g of Object.keys(x.gaeste)) if (`gast:${g}` !== von) x.gaeste[g] = { ...x.gaeste[g], ungelesen: (x.gaeste[g].ungelesen || 0) + 1 };
    return x;
  });
  const z = await laden(w, r.id);
  const { daten, datenGast, namen } = await verteilen(w, r, 'nachricht', z.nachrichten.get(id), z);
  pushen(w, r, { von, vonName: vonName || absenderName(r, namen, von), aktiv, namen }).catch(() => {});
  return gast ? datenGast : daten;
}

/** Klick-Adresse einer Handy-Meldung: öffentliche Adresse der Oberfläche (vom Web-Dienst gelernt) + #/chat/<raum>. */
export async function klickAdresse(w, raumId) {
  try {
    const a = await w.konfig.laden('web/link-adresse.json', null);
    if (a && typeof a.adresse === 'string' && ADRESSE.test(a.adresse)) return `${a.adresse}/#/chat/${raumId}`;
  } catch { /* ohne Link */ }
  return undefined;
}

/** Handy-Meldungen (V9) an NAS-Mitglieder ohne Absender, ohne gerade Aktive, ohne stumm geschaltete. */
async function pushen(w, raum, { von, vonName, aktiv = [], namen }) {
  const stumm = (n) => { const d = namen.get(n); const s = d && d.einstellungen && d.einstellungen.chat && d.einstellungen.chat.stumm; return Array.isArray(s) && s.includes(raum.id); };
  const ziele = Object.keys(raum.mitglieder || {}).filter((n) => n !== von && !aktiv.includes(n) && !stumm(n));
  if (!ziele.length) return;
  const klick = await klickAdresse(w, raum.id);
  const senden = typeof w.persoenlichSenden === 'function' ? w.persoenlichSenden : persoenlichSenden;
  const titel = raum.art === 'dm' ? vonName : raum.name;
  for (const n of ziele) {
    Promise.resolve(senden(w, n, { titel, text: `${vonName}: neue Nachricht`, ...(klick ? { klick } : {}), schluessel: `chat:${raum.id}:${n}` })).catch(() => {});
  }
}

/** Nachricht im Zustand finden (keine Systemzeile; für Gäste nur ab Beitritt) – sonst E_NICHT_GEFUNDEN. */
function nachrichtHolen(zustand, id, gast = null) {
  const n = zustand.nachrichten.get(id);
  if (!n || n.system || (gast && !gastSichtbar(n, gast))) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Nachricht gibt es nicht', { feld: 'nachricht' });
  return n;
}

/** Eigene Nachricht bearbeiten. */
export async function bearbeiten(w, raum, id, wer, text) {
  const zustand = await laden(w, raum.id);
  const n = nachrichtHolen(zustand, id);
  if (n.geloescht) throw new FahnasFehler('E_PARAMS', 'Gelöschte Nachrichten lassen sich nicht bearbeiten', { feld: 'nachricht' });
  if (n.von !== wer) throw new FahnasFehler('E_RECHTE', 'Du kannst nur eigene Nachrichten bearbeiten', { feld: 'nachricht' });
  const t = String(text ?? '');
  if (!t.trim() && !(n.anhaenge && n.anhaenge.length)) throw new FahnasFehler('E_PARAMS', 'Die Nachricht ist leer', { feld: 'text' });
  const zeit = new Date().toISOString();
  await anhaengen(w, raum.id, { t: 'b', id, zeit, text: t });
  const r = (await raumLaden(w, raum.id)) || raum;
  if (r.letzte && r.letzte.id === id) await raumAendern(w, raum.id, (d) => ({ ...d, letzte: { ...d.letzte, kurz: kurz(t) || '📎' } }));
  chatEreignis(w, r, 'bearbeitet', { id, text: t, bearbeitet: zeit }, { an: anFuer(r, n) });
  const z = await laden(w, raum.id);
  return ansicht(w, r, z.nachrichten.get(id), { zustand: z });
}

/** Nachricht löschen (eigene; Verwalter alle im Raum). Ungelesen-Zähler und „letzte“ werden nachgeführt. */
export async function nachrichtLoeschen(w, raum, id, wer, { verwalter = false, gast = null } = {}) {
  const zustand = await laden(w, raum.id);
  const n = nachrichtHolen(zustand, id, gast);
  if (n.von !== wer && !verwalter) throw new FahnasFehler('E_RECHTE', 'Du kannst nur eigene Nachrichten löschen', { feld: 'nachricht' });
  if (n.geloescht) return { geloescht: true, anhaenge: [] };
  const anhaenge = [...(n.anhaenge || [])];
  await anhaengen(w, raum.id, { t: 'l', id, zeit: new Date().toISOString(), von: wer });
  const r = await raumAendern(w, raum.id, (d) => {
    const x = { ...d, mitglieder: { ...d.mitglieder }, gaeste: { ...(d.gaeste || {}) } };
    const senken = (eintrag, ich) => (ich !== n.von && (!eintrag.gelesen || eintrag.gelesen < id) ? { ...eintrag, ungelesen: Math.max(0, (eintrag.ungelesen || 0) - 1) } : eintrag);
    for (const m of Object.keys(x.mitglieder)) x.mitglieder[m] = senken(x.mitglieder[m], m);
    for (const g of Object.keys(x.gaeste)) x.gaeste[g] = senken(x.gaeste[g], `gast:${g}`);
    x.letzte = letzteAus(zustand);
    return x;
  });
  await anhaengeLoeschen(w, raum.id, anhaenge);
  chatEreignis(w, r, 'geloescht', { id }, { an: anFuer(r, n) });
  return { geloescht: true, anhaenge };
}

/** Reaktion an/aus; gibt die Reaktionen der Nachricht zurück (NAS-Fassung). `gast`: nur Nachrichten ab seinem Beitritt. */
export async function reaktion(w, raum, id, wer, emoji, an, { gast = null } = {}) {
  const zustand = await laden(w, raum.id);
  const n = nachrichtHolen(zustand, id, gast);
  if (n.geloescht) throw new FahnasFehler('E_PARAMS', 'Auf gelöschte Nachrichten gibt es keine Reaktionen', { feld: 'nachricht' });
  await anhaengen(w, raum.id, { t: 'r', id, von: wer, emoji, an: !!an });
  const reaktionen = { ...(zustand.nachrichten.get(id).reaktionen || {}) };
  const namen = await nutzerDaten(w);
  chatEreignis(w, raum, 'reaktion', { id, reaktionen }, { an: anFuer(raum, n), datenGast: { id, reaktionen: reaktionenFuerGast(raum, namen, reaktionen) } });
  return reaktionen;
}

/**
 * Lesestand setzen (nie zurück): `wer` = Nutzername bzw. Gast-ID (mit `gast:true`). Gibt die neue Zahl ungelesener
 * Nachrichten zurück; das Ereignis „gelesen“ geht nur an NAS-Mitglieder.
 */
export async function gelesenSetzen(w, raum, wer, bis, { gast = false } = {}) {
  const zustand = await laden(w, raum.id);
  const ich = gast ? `gast:${wer}` : wer;
  let ungelesen = 0; let stand = null;
  await raumAendern(w, raum.id, (d) => {
    const x = { ...d, mitglieder: { ...d.mitglieder }, gaeste: { ...(d.gaeste || {}) } };
    const tabelle = gast ? x.gaeste : x.mitglieder;
    const eintrag = Object.hasOwn(tabelle, wer) ? tabelle[wer] : null;
    if (!eintrag) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Raum gibt es nicht', { feld: 'raum' });
    stand = eintrag.gelesen && eintrag.gelesen > bis ? eintrag.gelesen : bis;
    ungelesen = zustand.ids.filter((i) => i > stand).map((i) => zustand.nachrichten.get(i)).filter((n) => n && !n.geloescht && !n.system && n.von !== ich).length;
    tabelle[wer] = { ...eintrag, gelesen: stand, ungelesen };
    return x;
  });
  if (!gast) chatEreignis(w, raum, 'gelesen', { wer, bis: stand }, { an: { nutzer: empfaenger(raum).nutzer, gaeste: [] } });
  return { ungelesen };
}

/** Systemeintrag (Beitritt, Austritt, Anrufe …) in den Verlauf und als Nachricht an alle Empfänger. */
export async function systemEintrag(w, raumId, { art, wer = null, daten = null }) {
  const id = nachrichtId(); const zeit = new Date().toISOString();
  await anhaengen(w, raumId, { t: 's', id, zeit, art, ...(wer ? { wer } : {}), ...(daten ? { daten } : {}) });
  const r = await raumLaden(w, raumId);
  if (!r) return null;
  const z = await laden(w, raumId);
  const { daten: ansichtNas } = await verteilen(w, r, 'nachricht', z.nachrichten.get(id), z);
  return ansichtNas;
}
