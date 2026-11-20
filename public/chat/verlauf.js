// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Nachrichtenverlauf des Chats (Plan 02): reine Helfer (zusammenführen, Ereignisse anwenden, nach Tagen gruppieren) und
// die Ansicht. Text läuft immer über markdownZuKnoten (V4) – nie als HTML. Unveränderte Nachrichten behalten ihr
// Element (ein laufendes Video bricht nicht ab); „Ältere laden“ beim Hochscrollen; wer unten war, bleibt unten.

import { markdownZuKnoten } from '../markdown.js';
import { EMOJIS } from './eingabe.js';
import { anrufSystemText } from './anruf-stand.js';
import { avatarKnoten } from '../avatar.js';

const FOLGE_MS = 5 * 60_000;
const TIPPT_MS = 5000;
const SYSTEM_ARTEN = new Set(['beitritt', 'austritt', 'umbenannt', 'gast_beitritt', 'gast_entfernt']);

const kurz = (text, max = 80) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** Zwei Listen nach `id` vereinen (die neuere Fassung gewinnt), aufsteigend sortiert (IDs sind nach Zeit sortierbar). */
export function zusammenfuehren(alt, neu) {
  const m = new Map();
  for (const n of alt || []) if (n && n.id) m.set(n.id, n);
  for (const n of neu || []) if (n && n.id) m.set(n.id, n);
  return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Nach dem Wiederverbinden die neueste Seite übernehmen: überschneidet sie sich mit der Liste (oder reicht bis zum Anfang),
 * werden beide vereint; sonst ersetzt sie die Liste mit „ältere laden“ – eine stille Lücke darf es nicht geben, weil danach
 * „gelesen bis zur neuesten“ gemeldet wird (Prüfbericht Plan 02, Befund 9). → {nachrichten, mehr}
 */
export function nachWiederverbinden(alt, seite, mehrAlt) {
  const neu = (seite && seite.nachrichten) || [];
  const ids = new Set((alt || []).map((n) => n && n.id));
  if (!seite || !seite.mehr || neu.some((n) => n && ids.has(n.id))) return { nachrichten: zusammenfuehren(alt, neu), mehr: !!mehrAlt };
  return { nachrichten: zusammenfuehren([], neu), mehr: true };
}

/** Ein Ereignis vom Server auf die Liste anwenden (rein; unbekannte IDs lassen die Liste unverändert). */
export function ereignisAnwenden(liste, ereignis, daten) {
  if (!daten || !daten.id) return liste;
  if (ereignis === 'nachricht') return zusammenfuehren(liste, [daten]);
  const i = liste.findIndex((n) => n.id === daten.id);
  if (i < 0) return liste;
  const alt = liste[i];
  let neu; let zitat = null;
  if (ereignis === 'bearbeitet') { neu = { ...alt, text: daten.text, bearbeitet: daten.bearbeitet || true }; zitat = { kurz: kurz(daten.text) }; }
  else if (ereignis === 'geloescht') { neu = { ...alt, geloescht: true, text: '', anhaenge: [], reaktionen: {} }; zitat = { kurz: '', geloescht: true }; }
  else if (ereignis === 'reaktion') neu = { ...alt, reaktionen: daten.reaktionen || {} };
  else return liste;
  return liste.map((n, j) => {
    if (j === i) return neu;
    if (zitat && n.antwort && n.antwort.id === daten.id) return { ...n, antwort: { ...n.antwort, ...zitat } };
    return n;
  });
}

const zwei = (x) => String(x).padStart(2, '0');
function tagVon(iso) { const d = new Date(iso); return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`; }
/** Absender zum Vergleichen: Login-Name, sonst (Gastsicht) der Anzeigename. */
const werVon = (n) => n.von || (n.von_name ? `~${n.von_name}` : '');

/** Nach Tagen gruppieren; `folge` = gleicher Absender höchstens 5 min nach der vorigen Nachricht (keine Systemzeile). */
export function gruppiere(liste, { ich } = {}) {
  const gruppen = []; let vorige = null;
  for (const n of liste) {
    const tag = tagVon(n.zeit);
    let g = gruppen[gruppen.length - 1];
    if (!g || g.tag !== tag) { g = { tag, eintraege: [] }; gruppen.push(g); vorige = null; }
    const folge = !!(vorige && !vorige.system && !n.system && werVon(n) && werVon(vorige) === werVon(n)
      && Date.parse(n.zeit) - Date.parse(vorige.zeit) <= FOLGE_MS);
    g.eintraege.push({ nachricht: n, folge, eigen: !!ich && n.von === ich });
    vorige = n;
  }
  return gruppen;
}

function gebiet() { return globalThis.document && document.documentElement && document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE'; }
function uhrzeit(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleTimeString(gebiet(), { hour: '2-digit', minute: '2-digit' }); } catch { return `${zwei(d.getHours())}:${zwei(d.getMinutes())}`; }
}

/**
 * Verlauf in `behaelter`. Rückrufe: beiAntworten(n), beiReaktion(n, emoji, an), beiLoeschen(n), beiBearbeiten(n),
 * beiAnhang(anhang, n) → Element|null, beiAelter() → Promise. `verwalter` darf alle Nachrichten löschen.
 */
export function verlaufAnsicht(behaelter, { h, ich, istGast = false, verwalter = false, beiAntworten, beiReaktion, beiLoeschen, beiBearbeiten, beiAnhang, beiAelter }) {
  const { el, t, symbol } = h;
  let nachrichten = []; let mehr = false; let laedt = false; let gelesen = {}; let gelesenNamen = {};
  const cache = new Map(); const tage = new Map(); const tippend = new Map();

  const aeltere = el('button', { class: 'knopf knopf-zweit knopf-klein chat-aeltere', type: 'button', hidden: true, onclick: () => aelterLaden() }, t('chat.aeltere'));
  const liste = el('div', { class: 'chat-verlauf-liste' });
  const gelesenZeile = el('p', { class: 'chat-gelesen schwach klein', hidden: true });
  const tipptZeile = el('p', { class: 'chat-tippt schwach klein', hidden: true, 'aria-live': 'polite' });
  const scroller = el('div', { class: 'chat-verlauf', role: 'log', 'aria-live': 'polite', tabindex: '0' }, [
    el('div', { class: 'chat-verlauf-kopf' }, [aeltere]), liste, gelesenZeile, tipptZeile,
  ]);
  behaelter.appendChild(scroller);

  let beobachter = null;
  if (typeof globalThis.IntersectionObserver === 'function') {
    beobachter = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) aelterLaden(); }, { root: scroller });
    beobachter.observe(aeltere);
  }

  function aelterLaden() {
    if (!mehr || laedt || typeof beiAelter !== 'function') return;
    laedt = true; aeltere.disabled = true;
    Promise.resolve().then(() => beiAelter()).catch(() => {}).finally(() => { laedt = false; aeltere.disabled = false; });
  }

  function systemText(n) {
    const s = n.system || {};
    const anruf = anrufSystemText(s, t, h.format);
    if (anruf !== null) return anruf;
    const art = SYSTEM_ARTEN.has(s.art) ? s.art : 'sonst';
    return t(`chat.system_${art}`, { wer: s.wer_name || '', ...(s.daten && typeof s.daten === 'object' ? s.daten : {}) });
  }

  function tagKnoten(tag) {
    if (tage.has(tag)) return tage.get(tag);
    const heute = tagVon(new Date().toISOString()); const gestern = tagVon(new Date(Date.now() - 86_400_000).toISOString());
    let text = tag;
    if (tag === heute) text = t('chat.heute');
    else if (tag === gestern) text = t('chat.gestern');
    else { try { text = new Date(`${tag}T12:00:00`).toLocaleDateString(gebiet(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { /* bleibt */ } }
    const k = el('div', { class: 'chat-tag', role: 'separator' }, [el('span', { text })]);
    tage.set(tag, k);
    return k;
  }

  function zitatKnoten(a) {
    // Gäste sehen Zitate von Nachrichten vor ihrem Beitritt nur als Hinweis (kein Inhalt, kein Sprungziel)
    if (a.frueher) return el('div', { class: 'chat-zitat chat-zitat-frueher' }, [el('span', { class: 'chat-zitat-text', text: t('chat.antwort_frueher') })]);
    const springen = () => {
      if (!/^n[a-z0-9]+$/.test(String(a.id))) return;
      const ziel = liste.querySelector(`[data-id="${a.id}"]`);
      if (ziel && typeof ziel.scrollIntoView === 'function') ziel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    return el('div', { class: 'chat-zitat', role: 'button', tabindex: '0', onclick: springen, onkeydown: (ev) => { if (ev.key === 'Enter') springen(); } }, [
      el('span', { class: 'chat-zitat-name', text: a.von_name || '' }),
      el('span', { class: 'chat-zitat-text', text: a.geloescht ? t('chat.geloescht') : (a.kurz || '📎') }),
    ]);
  }

  function reaktionenKnoten(n) {
    const r = Object.entries(n.reaktionen || {}).filter(([, wer]) => Array.isArray(wer) && wer.length);
    if (!r.length) return null;
    return el('div', { class: 'chat-reaktionen' }, r.map(([emoji, wer]) => {
      const hab = !!ich && wer.includes(ich);
      return el('button', { class: 'chat-reaktion', type: 'button', 'aria-pressed': hab ? 'true' : 'false', title: wer.map((x) => (String(x).startsWith('gast:') ? t('chat.gast') : x)).join(', '),
        onclick: () => { if (beiReaktion) beiReaktion(n, emoji, !hab); } }, `${emoji} ${wer.length}`);
    }));
  }

  function aktionenKnoten(n, eigen) {
    const knoepfe = [];
    const k = (sym, text, fn) => el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': text, title: text, onclick: fn }, [symbol(sym)]);
    if (beiAntworten) knoepfe.push(k('antworten', t('chat.antworten'), () => beiAntworten(n)));
    if (beiReaktion) {
      const wahl = el('div', { class: 'chat-emoji-wahl', hidden: true, role: 'group', 'aria-label': t('chat.reagieren') }, EMOJIS.map((e) => el('button', { class: 'chat-emoji', type: 'button',
        onclick: () => { wahl.hidden = true; const hab = !!ich && ((n.reaktionen || {})[e] || []).includes(ich); beiReaktion(n, e, !hab); } }, e)));
      knoepfe.push(k('smiley', t('chat.reagieren'), () => { wahl.hidden = !wahl.hidden; }), wahl);
    }
    if (eigen && beiBearbeiten && !istGast) knoepfe.push(k('umbenennen', t('chat.bearbeiten'), () => beiBearbeiten(n)));
    if ((eigen || verwalter) && beiLoeschen) knoepfe.push(k('loeschen', t('chat.loeschen'), () => beiLoeschen(n)));
    return knoepfe.length ? el('div', { class: 'chat-aktionen' }, knoepfe) : null;
  }

  function nachrichtBauen({ nachricht: n, folge, eigen }) {
    if (n.system) {
      return el('div', { class: 'chat-system', 'data-id': n.id }, [el('span', { text: systemText(n) }), ' ', el('time', { class: 'chat-zeit', datetime: n.zeit, text: uhrzeit(n.zeit) })]);
    }
    const kinder = [];
    if (!folge) {
      kinder.push(el('div', { class: 'chat-kopf' }, [
        avatarKnoten({ name: n.gast ? '' : (n.von || ''), anzeige: n.von_name || '', groesse: 24, klasse: 'chat-avatar' }), // Bild nur für Mitglieder (0.22.0)
        el('span', { class: 'chat-name', text: n.von_name || '' }),
        n.gast ? el('span', { class: 'chat-gast-marke', text: t('chat.gast') }) : null,
        el('time', { class: 'chat-zeit', datetime: n.zeit, text: uhrzeit(n.zeit) }),
      ]));
    }
    if (n.antwort) kinder.push(zitatKnoten(n.antwort));
    if (n.geloescht) kinder.push(el('p', { class: 'chat-geloescht', text: t('chat.geloescht') }));
    else {
      if (n.text) { const text = el('div', { class: 'chat-text' }); text.appendChild(markdownZuKnoten(n.text, { modus: 'chat' })); kinder.push(text); }
      if (n.bearbeitet) kinder.push(el('span', { class: 'chat-bearbeitet schwach klein', text: t('chat.bearbeitet') }));
      const anhaenge = (n.anhaenge || []).map((a) => (beiAnhang ? beiAnhang(a, n) : null)).filter(Boolean);
      if (anhaenge.length) kinder.push(el('div', { class: 'chat-anhaenge' }, anhaenge));
      kinder.push(reaktionenKnoten(n));
      kinder.push(aktionenKnoten(n, eigen));
    }
    return el('div', { class: `chat-nachricht${eigen ? ' eigen' : ''}${folge ? ' folge' : ''}${n.geloescht ? ' geloescht' : ''}`, 'data-id': n.id }, kinder);
  }

  function nachrichtKnoten(e) {
    const n = e.nachricht;
    const sig = JSON.stringify([n.text, n.bearbeitet, n.geloescht, n.reaktionen, (n.anhaenge || []).map((a) => a.id), n.antwort, n.von_name, n.system, e.folge, e.eigen]);
    const alt = cache.get(n.id);
    if (alt && alt.sig === sig) return alt.knoten;
    const knoten = nachrichtBauen(e);
    cache.set(n.id, { sig, knoten });
    return knoten;
  }

  /** Kinder von `eltern` auf `soll` bringen, ohne unveränderte Knoten anzufassen. */
  function abgleichen(eltern, soll) {
    soll.forEach((k, i) => { const jetzt = eltern.childNodes[i]; if (jetzt !== k) eltern.insertBefore(k, jetzt || null); });
    while (eltern.childNodes.length > soll.length) eltern.removeChild(eltern.childNodes[eltern.childNodes.length - 1]);
  }

  const amEnde = () => !scroller.scrollHeight || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40;

  function zeichnen({ ersteVorher = null } = {}) {
    const unten = amEnde();
    const hoeheVorher = scroller.scrollHeight || 0; const obenVorher = scroller.scrollTop || 0;
    const soll = [];
    for (const g of gruppiere(nachrichten, { ich })) {
      soll.push(tagKnoten(g.tag));
      for (const e of g.eintraege) soll.push(nachrichtKnoten(e));
    }
    abgleichen(liste, soll);
    const ids = new Set(nachrichten.map((n) => n.id));
    for (const id of [...cache.keys()]) if (!ids.has(id)) cache.delete(id);
    aeltere.hidden = !mehr;
    gelesenZeigen();
    if (unten) scroller.scrollTop = scroller.scrollHeight;
    else if (ersteVorher && nachrichten.length && nachrichten[0].id < ersteVorher) scroller.scrollTop = obenVorher + ((scroller.scrollHeight || 0) - hoeheVorher);
  }

  function gelesenZeigen() {
    const letzte = nachrichten.length ? nachrichten[nachrichten.length - 1].id : null;
    const namen = letzte ? Object.entries(gelesen).filter(([wer, bis]) => wer !== ich && typeof bis === 'string' && bis >= letzte).map(([wer]) => gelesenNamen[wer] || wer) : [];
    gelesenZeile.hidden = !namen.length;
    gelesenZeile.textContent = namen.length ? t('chat.gelesen_von', { namen: namen.join(', ') }) : '';
  }

  function tipptZeigen() {
    const namen = [...tippend.keys()];
    tipptZeile.hidden = !namen.length;
    tipptZeile.textContent = namen.length ? t('chat.tippt', { name: namen.join(', ') }) : '';
  }

  return {
    setzen(neu, mehrDa) {
      const ersteVorher = nachrichten.length ? nachrichten[0].id : null;
      nachrichten = zusammenfuehren([], neu); mehr = !!mehrDa;
      zeichnen({ ersteVorher });
    },
    anwenden(ereignis, daten) {
      if (ereignis === 'nachricht' && daten && daten.von_name && tippend.has(daten.von_name)) { clearTimeout(tippend.get(daten.von_name)); tippend.delete(daten.von_name); tipptZeigen(); }
      const neu = ereignisAnwenden(nachrichten, ereignis, daten);
      if (neu === nachrichten) return;
      nachrichten = neu;
      zeichnen();
    },
    tippt(name) {
      if (!name) return;
      if (tippend.has(name)) clearTimeout(tippend.get(name));
      tippend.set(name, setTimeout(() => { tippend.delete(name); tipptZeigen(); }, TIPPT_MS));
      tipptZeigen();
    },
    gelesenSetzen(stand, namen) { gelesen = stand || {}; gelesenNamen = namen || {}; gelesenZeigen(); },
    neuZeichnen() { cache.clear(); zeichnen(); },
    verlassen() {
      for (const x of tippend.values()) clearTimeout(x);
      tippend.clear();
      if (beobachter) beobachter.disconnect();
    },
  };
}
