// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gastseite für Chat-Einladungen (GET /einladung/<token>, ohne Konto). Ablauf: Einladung prüfen → angemeldete
// NAS-Nutzer gehen in ihre Chat-Ansicht; Gäste geben einen Namen ein und treten bei (Keks) → genau dieser eine Raum mit
// Verlauf, Eingabe und Anhängen (nur herunterladen). Entfernt der Verwalter den Gast (Schließcode 4003), endet die Seite.
// Rahmen-Texte stehen hier, die der geteilten Bausteine kommen aus chat.json. Kein innerHTML: alles sind fremde Daten.

import { ChatVerbindung } from './chat/verbindung.js';
import { verlaufAnsicht, zusammenfuehren, ereignisAnwenden, nachWiederverbinden } from './chat/verlauf.js';
import { eingabeLeiste } from './chat/eingabe.js';
import { anhangElement, anhangUrl, anhangHochladen } from './chat/anhang.js';
import { melden as hinweisMelden } from './chat/hinweise.js';
import { anrufKopf } from './chat/anruf-kopf.js';
import { anrufSteuerung, iceHolen } from './chat/anruf-steuerung.js';
import { anrufStand } from './chat/anruf-stand.js';

const TEXTE = {
  de: {
    laden: 'Wird geladen …', willkommen: 'Einladung in „{raum}“', name_frage: 'Wie sollen dich die anderen nennen?',
    name_erklaerung: 'Dein Name erscheint bei deinen Nachrichten. Du siehst nur diesen Raum.', name_fehlt: 'Bitte gib einen Namen mit 1 bis 40 Zeichen ein.',
    beitreten: 'Beitreten', konto: 'Du hast ein Konto auf diesem NAS?', konto_link: 'Mit NAS-Konto anmelden',
    als: 'Du bist als „{name}“ hier (Gast).', verlassen: 'Raum verlassen', verlassen_frage: 'Raum wirklich verlassen? Zurück kommst du nur mit einem neuen Einladungslink.',
    ja: 'Verlassen', nein: 'Abbrechen', verlassen_fertig: 'Du hast den Raum verlassen. Du kannst dieses Fenster schließen.',
    entfernt: 'Du bist nicht mehr in diesem Raum.', ungueltig: 'Diese Einladung ist ungültig oder abgelaufen.',
    fehler: 'Der Chat ist gerade nicht erreichbar. Bitte versuche es später noch einmal.', bremse: 'Zu viele Versuche – bitte warte {s} Sekunden.',
    getrennt: 'Verbindung unterbrochen – wird neu aufgebaut …', zu_viele: 'Höchstens 10 Dateien je Nachricht.', meldung: '{name} hat geschrieben',
  },
  en: {
    laden: 'Loading …', willkommen: 'Invitation to “{raum}”', name_frage: 'What should the others call you?',
    name_erklaerung: 'Your name appears with your messages. You only see this room.', name_fehlt: 'Please enter a name with 1 to 40 characters.',
    beitreten: 'Join', konto: 'Do you have an account on this NAS?', konto_link: 'Sign in with your NAS account',
    als: 'You are here as “{name}” (guest).', verlassen: 'Leave room', verlassen_frage: 'Really leave the room? You can only come back with a new invitation link.',
    ja: 'Leave', nein: 'Cancel', verlassen_fertig: 'You have left the room. You can close this window.',
    entfernt: 'You are no longer in this room.', ungueltig: 'This invitation is invalid or has expired.',
    fehler: 'The chat is currently unavailable. Please try again later.', bremse: 'Too many attempts – please wait {s} seconds.',
    getrennt: 'Connection lost – reconnecting …', zu_viele: 'At most 10 files per message.', meldung: '{name} wrote',
  },
};

const fuellen = (text, werte = {}) => String(text).replace(/\{(\w+)\}/g, (m, n) => (werte[n] !== undefined && werte[n] !== null ? String(werte[n]) : m));

/** Token aus /einladung/<token> (16–128 Zeichen A–Z a–z 0–9 _ -), sonst null. */
export function tokenAusPfad(pfad) {
  const m = /^\/einladung\/([A-Za-z0-9_-]{16,128})\/?$/.exec(String(pfad || ''));
  return m ? m[1] : null;
}

/** Rahmen-Texte der Gastseite; unbekannte Sprache → deutsch, unbekannter Schlüssel → der Schlüssel. */
export function gastTexte(sprache) {
  const tab = TEXTE[sprache] || TEXTE.de;
  return (k, werte) => fuellen(tab[k] ?? TEXTE.de[k] ?? k, werte);
}

/** Texte der geteilten Bausteine aus /sprache/<de|en>/chat.json (Rückfall de); Schlüssel ohne Punkt bekommen „chat.“. */
export async function chatTexteLaden(sprache, holen = fetch) {
  const laden = async (sp) => {
    const r = await holen(`/sprache/${sp}/chat.json`);
    if (!r || !r.ok) throw new Error(`HTTP ${r ? r.status : '?'}`);
    return r.json();
  };
  let daten = {};
  const sp = sprache === 'en' ? 'en' : 'de';
  try { daten = await laden(sp); } catch { if (sp !== 'de') { try { daten = await laden('de'); } catch { daten = {}; } } }
  const texte = {};
  for (const [k, v] of Object.entries(daten || {})) texte[k.includes('.') ? k : `chat.${k}`] = String(v);
  return (k, werte) => fuellen(texte[k] ?? k, werte);
}

// ---- Helfer wie im Rahmen der Oberfläche (die Bausteine erwarten diese Form) -------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'use']);
const EIGENSCHAFTEN = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'multiple']);

export function el(tag, attrs, kinder) {
  const k = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [n, w] of Object.entries(attrs || {})) {
    if (w === undefined || w === null || w === false) continue;
    if (n === 'class') { if (SVG_TAGS.has(tag)) k.setAttribute('class', w); else k.className = w; }
    else if (n === 'text') k.textContent = String(w);
    else if (n.startsWith('on') && typeof w === 'function') k.addEventListener(n.slice(2).toLowerCase(), w);
    else if (EIGENSCHAFTEN.has(n)) k[n] = w;
    else k.setAttribute(n, w === true ? '' : String(w));
  }
  const anhaengen = (c) => {
    if (c === undefined || c === null || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(anhaengen); return; }
    k.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  };
  anhaengen(kinder);
  return k;
}

export function symbol(name, klasse = '') {
  const s = el('svg', { class: `symbol${klasse ? ` ${klasse}` : ''}`, 'aria-hidden': 'true', focusable: 'false' });
  s.appendChild(el('use', { href: `/symbole.svg#symbol-${name}` }));
  return s;
}

function groesse(b) {
  if (b === null || b === undefined || !Number.isFinite(Number(b))) return '';
  const e = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let w = Math.max(0, Number(b)); let i = 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i++; }
  return `${i === 0 ? w : w.toLocaleString(document.documentElement.lang || 'de', { maximumFractionDigits: w < 10 ? 1 : 0 })} ${e[i]}`;
}
const prozent = (p) => `${Math.round(Number(p) || 0)} %`;
const dauer = (sek) => { const s = Math.max(0, Math.round(Number(sek) || 0)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

/** Anrufe für Gäste (Plan 03): Knöpfe im Kopf; ein Ende der Verbindung (z. B. 4003 „entfernt“) legt auf. Kein Klingeln. */
export function anrufeGastStarten({ verbindung, h, kopf, raum, holen = globalThis.fetch }) {
  const steuerung = anrufSteuerung({ verbindung, h, iceHolen: () => iceHolen(holen) });
  const knoten = anrufKopf(raum, { h, steuerung, stand: anrufStand(verbindung) });
  kopf.appendChild(knoten);
  const ab = verbindung.on('beendet', () => steuerung.verlassen());
  return { steuerung, stoppen() { ab(); steuerung.verlassen(); knoten.remove(); } };
}

// ---- Seite -----------------------------------------------------------------------------------------------------------

async function anfrage(methode, url, body) {
  const r = await fetch(url, { method: methode, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* keine JSON-Antwort */ }
  if (r.ok && j && j.ok) return j.ergebnis;
  const f = (j && j.fehler) || {};
  throw Object.assign(new Error(f.meldung || `HTTP ${r.status}`), { code: f.code || 'E_AGENT', details: f.details || null, status: r.status });
}

async function start() {
  const wurzel = document.getElementById('chat-gast');
  const sprache = String(navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
  document.documentElement.lang = sprache;
  const tg = gastTexte(sprache);
  const fehlerText = (e) => (e && e.code === 'E_BREMSE' ? tg('bremse', { s: (e.details && e.details.warte_s) || 30 }) : (e && e.code === 'E_NICHT_GEFUNDEN' ? tg('ungueltig') : (e && e.message) || tg('fehler')));
  const meldung = (text) => { wurzel.textContent = ''; wurzel.className = 'chat-gast chat-gast-leer'; wurzel.appendChild(el('div', { class: 'chat-gast-meldung' }, [el('p', { text })])); };
  const token = tokenAusPfad(location.pathname);
  if (!token) { meldung(tg('ungueltig')); return; }
  wurzel.appendChild(el('p', { class: 'chat-gast-schwach', text: tg('laden') }));
  const [tc, info] = await Promise.all([chatTexteLaden(sprache), anfrage('GET', `/api/chat/einladung/${encodeURIComponent(token)}`).catch((e) => e)]);
  if (info instanceof Error) { meldung(fehlerText(info)); return; }
  if (info.angemeldet) { location.replace(`/#/chat/einladung/${encodeURIComponent(token)}`); return; }
  const h = { el, t: tc, symbol, format: { groesse, prozent, dauer } };
  if (info.gast_hier) { await chatZeigen(wurzel, { h, tg, fehlerText, meldung }); return; }

  // Name eingeben und beitreten
  wurzel.textContent = ''; wurzel.className = 'chat-gast chat-gast-leer';
  const name = el('input', { class: 'eingabe', type: 'text', maxlength: '40', autocomplete: 'nickname', 'aria-label': tg('name_frage') });
  const fehler = el('p', { class: 'feld-fehler', hidden: true, role: 'alert' });
  const knopf = el('button', { class: 'knopf', type: 'submit' }, tg('beitreten'));
  wurzel.appendChild(el('form', { class: 'chat-gast-karte karte', onsubmit: async (ev) => {
    ev.preventDefault();
    const n = name.value.trim();
    if (!n || n.length > 40) { fehler.textContent = tg('name_fehlt'); fehler.hidden = false; name.focus(); return; }
    knopf.disabled = true;
    try { await anfrage('POST', '/api/chat/gast/beitreten', { token, name: n }); await chatZeigen(wurzel, { h, tg, fehlerText, meldung }); } catch (e) { fehler.textContent = fehlerText(e); fehler.hidden = false; knopf.disabled = false; }
  } }, [
    el('h1', { text: tg('willkommen', { raum: info.raum_name }) }),
    el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: tg('name_frage') }), name, el('p', { class: 'erklaerung', text: tg('name_erklaerung') })]),
    fehler,
    el('div', { class: 'dialog-knoepfe' }, [knopf]),
    el('p', { class: 'chat-gast-konto erklaerung' }, [tg('konto'), ' ', el('a', { href: `/#/chat/einladung/${encodeURIComponent(token)}`, text: tg('konto_link') })]),
  ]));
  document.title = `${info.raum_name} – FAH-NAS`;
  name.focus();
}

async function chatZeigen(wurzel, { h, tg, fehlerText, meldung }) {
  let ich;
  try { ich = await anfrage('GET', '/api/chat/gast/ich'); } catch (e) { meldung(fehlerText(e)); return; }
  const raum = ich.raum; const meinId = `gast:${ich.gast}`;
  document.title = `${ich.raum_name} – FAH-NAS`;
  wurzel.textContent = ''; wurzel.className = 'chat-gast';
  const status = el('p', { class: 'chat-status hinweis hinweis-warnung', hidden: true, role: 'status' });
  const hochladen = el('p', { class: 'chat-hochladen chat-gast-schwach', hidden: true, 'aria-live': 'polite' });
  const verlaufBehaelter = el('div', { class: 'chat-verlauf-behaelter' });
  const eingabeBehaelter = el('div', { class: 'chat-eingabe-behaelter' });
  const verbindung = new ChatVerbindung({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/chat/ws` });
  let nachrichten = []; let mehr = false; let gemeldet = null; let beendet = false;

  let anrufe = null;
  const verlassen = el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: async () => {
    if (!globalThis.confirm(tg('verlassen_frage'))) return;
    if (anrufe) anrufe.stoppen();
    verbindung.stoppen();
    try { await anfrage('POST', '/api/chat/gast/abmelden', {}); } catch { /* Keks ist trotzdem weg */ }
    meldung(tg('verlassen_fertig'));
  } }, tg('verlassen'));
  const anrufPlatz = el('div', { class: 'chat-raumkopf-knoepfe' });
  wurzel.appendChild(el('header', { class: 'chat-raumkopf chat-gast-kopf' }, [
    el('div', { class: 'chat-raumkopf-info' }, [el('h1', { class: 'chat-raumkopf-name', text: ich.raum_name }), el('p', { class: 'chat-gast-schwach', text: tg('als', { name: ich.name }) })]),
    anrufPlatz, verlassen,
  ]));
  wurzel.appendChild(status);
  wurzel.appendChild(verlaufBehaelter); wurzel.appendChild(hochladen); wurzel.appendChild(eingabeBehaelter);

  const gelesen = () => {
    const letzte = nachrichten.length ? nachrichten[nachrichten.length - 1].id : null;
    if (!letzte || letzte === gemeldet || document.visibilityState === 'hidden') return;
    gemeldet = letzte;
    verbindung.aufrufen('chat.gelesen', { raum, bis: letzte }).catch(() => { gemeldet = null; });
  };
  const fehler = (e) => { status.hidden = false; status.textContent = fehlerText(e); };
  const v = verlaufAnsicht(verlaufBehaelter, {
    h, ich: meinId, istGast: true,
    beiAntworten: (n) => eingabe.antwortSetzen(n),
    beiReaktion: (n, emoji, an) => { verbindung.aufrufen('chat.reaktion', { raum, nachricht: n.id, emoji, an }).catch(fehler); },
    beiLoeschen: (n) => { if (globalThis.confirm(h.t('chat.nachricht_loeschen_frage'))) verbindung.aufrufen('chat.loeschen', { raum, nachricht: n.id }).catch(fehler); },
    beiAnhang: (a) => anhangElement(a, { h, url: (o) => anhangUrl(raum, a.id, o), istGast: true }),
    beiAelter: async () => {
      if (!nachrichten.length) return;
      const r = await verbindung.aufrufen('chat.verlauf', { raum, vor: nachrichten[0].id, anzahl: 50 });
      nachrichten = zusammenfuehren(r.nachrichten || [], nachrichten); mehr = !!r.mehr; v.setzen(nachrichten, mehr);
    },
  });
  const eingabe = eingabeLeiste(eingabeBehaelter, {
    h,
    beiSenden: async ({ text, antwort, dateien }) => {
      if (beendet) throw new Error('beendet');
      if (dateien.length > 10) { fehler({ message: tg('zu_viele') }); throw new Error('zu viele'); }
      const anhaenge = [];
      try {
        for (const d of dateien) {
          hochladen.hidden = false; hochladen.textContent = h.t('chat.hochladen_laeuft', { name: d.name, prozent: prozent(0) });
          const lauf = anhangHochladen(raum, d, { beiFortschritt: (x) => { hochladen.textContent = h.t('chat.hochladen_laeuft', { name: d.name, prozent: prozent(x * 100) }); } });
          anhaenge.push((await lauf.fertig).id);
        }
      } catch (e) { fehler(e); throw e; } finally { hochladen.hidden = true; }
      try {
        const r = await verbindung.aufrufen('chat.senden', { raum, text, antwort, anhaenge });
        if (r && r.nachricht) { nachrichten = zusammenfuehren(nachrichten, [r.nachricht]); v.anwenden('nachricht', r.nachricht); }
      } catch (e) { fehler(e); throw e; }
    },
    beiTippen: () => { verbindung.senden({ art: 'tippt', raum }); },
  });

  verbindung.on('chat', (e) => {
    if (!e || e.raum !== raum) return;
    if (['nachricht', 'bearbeitet', 'geloescht', 'reaktion'].includes(e.ereignis)) {
      nachrichten = ereignisAnwenden(nachrichten, e.ereignis, e.daten);
      v.anwenden(e.ereignis, e.daten);
      if (e.ereignis === 'nachricht') {
        gelesen();
        if (e.daten && e.daten.von !== meinId) hinweisMelden(e.daten, { id: raum, name: ich.raum_name }, { ton: true, browser: false }, { ich: meinId, offenerRaum: raum });
      }
    }
  });
  verbindung.on('tippt', (e) => { if (e && e.raum === raum && e.name) v.tippt(e.name); });
  verbindung.on('status', (s) => { if (beendet) return; status.hidden = s !== 'getrennt'; status.textContent = s === 'getrennt' ? tg('getrennt') : ''; });
  verbindung.on('beendet', ({ code }) => {
    beendet = true; v.verlassen();
    meldung(code === 4003 ? tg('entfernt') : tg('fehler'));
  });
  verbindung.on('wieder', async () => {
    try { const r = await verbindung.aufrufen('chat.verlauf', { raum, anzahl: 50 }); ({ nachrichten, mehr } = nachWiederverbinden(nachrichten, r, mehr)); v.setzen(nachrichten, mehr); gelesen(); } catch { /* später */ }
  });
  document.addEventListener('visibilitychange', gelesen);
  verbindung.starten();
  anrufe = anrufeGastStarten({ verbindung, h, kopf: anrufPlatz, raum: { id: raum, name: ich.raum_name } });
  try {
    const r = await verbindung.aufrufen('chat.verlauf', { raum, anzahl: 50 });
    nachrichten = zusammenfuehren([], r.nachrichten || []); mehr = !!r.mehr;
    v.setzen(nachrichten, mehr);
    gelesen();
    eingabe.fokus();
  } catch (e) { fehler(e); }
}

// Automatischer Start im Browser (im Test gibt es kein #chat-gast)
if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('chat-gast')) {
  start().catch((e) => { console.error(e); });
}
