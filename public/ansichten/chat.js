// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Chat“ (Plan 02) – aufgebaut wie Element: links Räume und Direktnachrichten, rechts der offene Raum mit
// Kopf (Mitglieder, Einladen, Stumm, Suchen), Verlauf und Eingabe. Am Handy zeigt #/chat nur die Liste und
// #/chat/<raum> nur den Raum. Alles läuft über die eine Chat-Verbindung (WebSocket); persönliche Einstellungen und
// Admin-Aktionen über ctx.api.

import { el, t, symbol, format, hashFuer } from '../app.js';
import { chatVerbindung } from '../chat/verbindung.js';
import { chatStand } from '../chat/rahmen.js';
import { raumlisteAufbauen } from '../chat/raumliste.js';
import { verlaufAnsicht, zusammenfuehren, ereignisAnwenden, nachWiederverbinden } from '../chat/verlauf.js';
import { eingabeLeiste } from '../chat/eingabe.js';
import { anhangElement, anhangUrl, anhangHochladen } from '../chat/anhang.js';
import { raumAnlegenDialog, dmDialog, mitgliederDialog, einladungenDialog, sucheDialog } from '../chat/raum-dialoge.js';
import { einstellungenNormal, einstellungenSeite } from '../chat/einstellungen.js';
import { erweiterungenBauen } from '../chat/erweiterungen.js';
import { ordnerWaehlen } from '../ordnerwahl.js';
import '../chat/anruf-erweiterungen.js'; // Anrufen im Raumkopf, Karte „Anrufe von unterwegs“ (Plan 03)

const RAUM = /^(r[A-Za-z0-9_-]{16}|d[A-Za-z0-9_-]{20})$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SEITE = 50;
const GELESEN_MS = 1000;
const UEBERSICHT_MS = 400;
const MAX_ANHAENGE = 10;
const VERLAUF_EREIGNISSE = new Set(['nachricht', 'bearbeitet', 'geloescht', 'reaktion']);

/** #/chat → Liste, #/chat/<raum>, #/chat/einstellungen, #/chat/einladung/<token>; alles andere → Liste. */
export function routeAuswerten(teile) {
  const [a, b] = Array.isArray(teile) ? teile : [];
  if (!a) return { art: 'liste' };
  if (a === 'einstellungen') return { art: 'einstellungen' };
  if (a === 'einladung' && TOKEN.test(b || '')) return { art: 'einladung', token: b };
  if (RAUM.test(a)) return { art: 'raum', raum: a };
  return { art: 'liste' };
}

const H = { el, t, symbol, format };
let z = null; // Zustand der eingebundenen Ansicht

function steuerung() {
  return {
    get ich() { return z.ich; },
    get einstellungen() { return z.einstellungen; },
    aufrufen: (aktion, params = {}) => z.verbindung.aufrufen(aktion, params),
    personen: () => {
      if (!z.personen) z.personen = z.verbindung.aufrufen('chat.personen', {}).then((r) => (r && r.personen) || []).catch((e) => { if (z) z.personen = null; throw e; });
      return z.personen;
    },
    aktualisieren: () => uebersichtLaden(),
    oeffnen: (id) => z.ctx.navigiere(hashFuer('chat', id)),
    zurListe: () => zurListe(),
    raum: (id) => ((z.uebersicht && z.uebersicht.raeume) || []).find((r) => r.id === id) || null,
    einstellungenSpeichern: async (teil) => {
      const neu = { ...z.einstellungen, ...teil };
      await z.ctx.api('nutzer.einstellungen.setzen', { name: z.ich, bereich: 'chat', wert: neu });
      z.einstellungen = einstellungenNormal(neu);
      chatStand.einstellungen = z.einstellungen;
      if (z.raumV && Object.hasOwn(teil, 'standardordner')) z.raumV.neuZeichnen();
    },
  };
}

function modus(m) { z.knoten.chat.setAttribute('data-modus', m); }

function zurListe() { if (z) z.ctx.navigiere(hashFuer('chat')); }

function statusZeigen(text) {
  const s = z.knoten.status;
  s.hidden = !text; s.textContent = text || '';
}

// ---- Übersicht und Raumliste ---------------------------------------------------------------------------------------

async function uebersichtLaden() {
  if (!z) return;
  const lauf = z;
  try {
    const u = await z.verbindung.aufrufen('chat.uebersicht', {});
    if (z !== lauf) return;
    z.uebersicht = u;
    listeZeichnen();
    if (z.raum) {
      const r = z.v.raum(z.raum);
      if (!r) { z.ctx.melden(t('chat.raum_weg'), 'warnung'); zurListe(); } else kopfZeichnen(r);
    }
  } catch (e) {
    if (z === lauf) statusZeigen(z.ctx.fehlerText(e));
  }
}

function uebersichtSpaeter() {
  if (!z || z.timer.uebersicht) return;
  z.timer.uebersicht = setTimeout(() => { if (z) { z.timer.uebersicht = null; uebersichtLaden(); } }, UEBERSICHT_MS);
}

function listeZeichnen() {
  raumlisteAufbauen(z.knoten.liste, {
    h: H, raeume: (z.uebersicht && z.uebersicht.raeume) || [], aktiv: z.raum, online: z.online, ich: z.ich,
    beiWahl: (id) => z.v.oeffnen(id), beiNeu: () => raumAnlegenDialog(z.ctx, z.v), beiDm: () => dmDialog(z.ctx, z.v),
  });
}

// ---- Raum ------------------------------------------------------------------------------------------------------------

function raumSchliessen() {
  if (!z) return;
  if (z.raumV) z.raumV.verlassen();
  if (z.timer.gelesen) { clearTimeout(z.timer.gelesen); z.timer.gelesen = null; }
  z.raum = null; z.raumV = null; z.eingabe = null; z.nachrichten = []; z.mehr = false; z.gelesen = {}; z.gemeldetBis = null;
  chatStand.offenerRaum = null;
}

function kopfZeichnen(raum) {
  const k = z.knoten.kopf;
  if (!k) return;
  k.textContent = '';
  const gaeste = (raum.gaeste || []).length; const n = (raum.mitglieder || []).length;
  const knopf = (sym, text, fn, klasse = '') => el('button', { class: `knopf-symbol ${klasse}`.trim(), type: 'button', 'aria-label': text, title: text, onclick: fn }, [symbol(sym)]);
  const stumm = el('button', { class: 'knopf knopf-zweit knopf-klein chat-raumkopf-stumm', type: 'button', 'aria-pressed': raum.stumm ? 'true' : 'false', title: t('chat.stumm_erklaerung'),
    onclick: async () => {
      const liste = new Set(z.einstellungen.stumm);
      if (raum.stumm) liste.delete(raum.id); else liste.add(raum.id);
      try { await z.v.einstellungenSpeichern({ stumm: [...liste] }); await uebersichtLaden(); } catch (e) { z.ctx.zeigeFehler(e); }
    } }, raum.stumm ? `🔕 ${t('chat.stumm_an')}` : `🔔 ${t('chat.stumm')}`);
  k.appendChild(el('button', { class: 'knopf-symbol chat-zurueck', type: 'button', 'aria-label': t('chat.zurueck'), title: t('chat.zurueck'), onclick: () => zurListe() }, [symbol('zurueck')]));
  k.appendChild(el('div', { class: 'chat-raumkopf-info' }, [
    el('h2', { class: 'chat-raumkopf-name', text: raum.name || '' }),
    raum.beschreibung ? el('p', { class: 'chat-raumkopf-beschreibung erklaerung', text: raum.beschreibung }) : null,
    el('p', { class: 'schwach klein', text: gaeste ? t('chat.mitglieder_gaeste', { n, g: gaeste }) : t('chat.mitglieder_anzahl', { n }) }),
  ]));
  k.appendChild(el('div', { class: 'chat-raumkopf-knoepfe' }, [
    knopf('nutzer', t('chat.mitglieder'), () => mitgliederDialog(z.ctx, z.v, z.v.raum(raum.id) || raum)),
    raum.verwalter && raum.art === 'raum' ? knopf('einladung', t('chat.einladen'), () => einladungenDialog(z.ctx, z.v, raum), 'chat-raumkopf-einladen') : null,
    knopf('suchen', t('chat.suchen'), () => sucheDialog(z.ctx, z.v, raum, (n) => zuNachricht(n))),
    stumm,
    ...erweiterungenBauen('raumKopf', raum, z.ctx, z.v),
  ]));
  z.ctx.setzeTitel(raum.name || t('chat.titel'));
}

async function raumOeffnen(id) {
  if (z.raum === id && z.raumV) return;
  raumSchliessen();
  let raum = z.v.raum(id);
  if (!raum) { await uebersichtLaden(); raum = z && z.v.raum(id); }
  if (!z) return;
  if (!raum) { z.ctx.melden(t('chat.raum_weg'), 'warnung'); zurListe(); return; }
  z.raum = id; chatStand.offenerRaum = id;
  modus('raum');
  listeZeichnen();
  const haupt = z.knoten.haupt; haupt.textContent = '';
  z.knoten.kopf = el('header', { class: 'chat-raumkopf' });
  const verlaufBehaelter = el('div', { class: 'chat-verlauf-behaelter' });
  z.knoten.hochladen = el('p', { class: 'chat-hochladen schwach klein', hidden: true, 'aria-live': 'polite' });
  const eingabeBehaelter = el('div', { class: 'chat-eingabe-behaelter' });
  haupt.appendChild(z.knoten.kopf); haupt.appendChild(verlaufBehaelter); haupt.appendChild(z.knoten.hochladen); haupt.appendChild(eingabeBehaelter);
  kopfZeichnen(raum);
  const fehler = (e) => { if (z) z.ctx.zeigeFehler(e); };
  z.raumV = verlaufAnsicht(verlaufBehaelter, {
    h: H, ich: z.ich, verwalter: !!raum.verwalter,
    beiAntworten: (n) => { if (z && z.eingabe) z.eingabe.antwortSetzen(n); },
    beiReaktion: (n, emoji, an) => { z.v.aufrufen('chat.reaktion', { raum: id, nachricht: n.id, emoji, an }).catch(fehler); },
    beiLoeschen: async (n) => {
      if (!await z.ctx.bestaetigen(t('chat.nachricht_loeschen_frage'), { titel: t('chat.nachricht_loeschen'), ok: t('chat.loeschen'), gefahr: true })) return;
      z.v.aufrufen('chat.loeschen', { raum: id, nachricht: n.id }).catch(fehler);
    },
    beiBearbeiten: (n) => bearbeiten(id, n),
    beiAnhang: (a) => anhangElement(a, { h: H, url: (o) => anhangUrl(id, a.id, o), standardordner: z.einstellungen.standardordner, beiSpeichern: (an, ziel) => anhangSpeichern(id, an, ziel) }),
    beiAelter: () => aelterLaden(id),
  });
  // Geschlossene DM (Konto des Partners gelöscht): Verlauf lesbar, statt der Eingabe ein Hinweis
  if (raum.geschlossen) eingabeBehaelter.appendChild(el('p', { class: 'chat-geschlossen schwach', text: t('chat.dm_geschlossen') }));
  else {
    z.eingabe = eingabeLeiste(eingabeBehaelter, {
      h: H, beiSenden: (x) => senden(id, x), beiTippen: () => { z.verbindung.senden({ art: 'tippt', raum: id }); },
    });
  }
  let r;
  try { r = await z.v.aufrufen('chat.verlauf', { raum: id, anzahl: SEITE }); } catch (e) { if (z && z.raum === id) z.ctx.zeigeFehler(e); return; }
  if (!z || z.raum !== id) return;
  z.nachrichten = zusammenfuehren([], r.nachrichten || []); z.mehr = !!r.mehr; z.gelesen = r.gelesen || {};
  z.raumV.setzen(z.nachrichten, z.mehr);
  gelesenAnzeigen();
  gelesenMelden(true);
  if (z.eingabe) z.eingabe.fokus();
}

function gelesenAnzeigen() {
  const raum = z.v.raum(z.raum);
  const namen = Object.fromEntries(((raum && raum.mitglieder) || []).map((m) => [m.name, m.anzeigename || m.name]));
  z.raumV.gelesenSetzen(z.gelesen, namen);
}

/** „Gelesen bis“ melden: beim Öffnen sofort, bei neuen Nachrichten höchstens einmal je Sekunde; nur wenn sichtbar. */
function gelesenMelden(sofort) {
  if (!z || !z.raum || (globalThis.document && document.visibilityState === 'hidden')) return;
  const melden = () => {
    if (!z) return;
    z.timer.gelesen = null;
    const letzte = z.nachrichten.length ? z.nachrichten[z.nachrichten.length - 1].id : null;
    if (!letzte || letzte === z.gemeldetBis) return;
    z.gemeldetBis = letzte;
    const lauf = z;
    z.verbindung.aufrufen('chat.gelesen', { raum: z.raum, bis: letzte }).catch(() => { if (z === lauf) z.gemeldetBis = null; });
  };
  if (sofort) { if (z.timer.gelesen) clearTimeout(z.timer.gelesen); melden(); } else if (!z.timer.gelesen) z.timer.gelesen = setTimeout(melden, GELESEN_MS);
}

async function aelterLaden(id) {
  if (!z || z.raum !== id || !z.nachrichten.length) return;
  const r = await z.v.aufrufen('chat.verlauf', { raum: id, vor: z.nachrichten[0].id, anzahl: SEITE });
  if (!z || z.raum !== id) return;
  z.nachrichten = zusammenfuehren(r.nachrichten || [], z.nachrichten); z.mehr = !!r.mehr;
  z.raumV.setzen(z.nachrichten, z.mehr);
}

/** Suchtreffer: ältere Seiten nachladen, bis die Nachricht im Verlauf steht, dann hinscrollen. */
async function zuNachricht(n) {
  const id = z && z.raum;
  for (let i = 0; z && z.raum === id && z.mehr && !z.nachrichten.some((x) => x.id === n.id) && i < 20; i++) await aelterLaden(id);
  if (!z || z.raum !== id) return;
  const k = z.knoten.haupt.querySelector(`[data-id="${n.id}"]`);
  if (!k) { z.ctx.melden(t('chat.suchen_weg'), 'info'); return; }
  if (typeof k.scrollIntoView === 'function') k.scrollIntoView({ block: 'center', behavior: 'smooth' });
  k.classList.add('chat-hervor'); setTimeout(() => k.classList.remove('chat-hervor'), 2500);
}

async function senden(id, { text, antwort, dateien }) {
  if (dateien.length > MAX_ANHAENGE) { z.ctx.melden(t('chat.zu_viele_dateien', { n: MAX_ANHAENGE }), 'warnung'); throw new Error('zu viele Dateien'); }
  const status = z.knoten.hochladen;
  const anhaenge = [];
  try {
    for (const d of dateien) {
      status.hidden = false; status.textContent = t('chat.hochladen_laeuft', { name: d.name, prozent: format.prozent(0) });
      z.hochladen = anhangHochladen(id, d, { beiFortschritt: (x) => { status.textContent = t('chat.hochladen_laeuft', { name: d.name, prozent: format.prozent(x * 100) }); } });
      anhaenge.push((await z.hochladen.fertig).id);
    }
  } catch (e) { if (z) z.ctx.zeigeFehler(e); throw e; } finally { if (z) { z.hochladen = null; status.hidden = true; } }
  try {
    const r = await z.v.aufrufen('chat.senden', { raum: id, text, antwort, anhaenge });
    if (z && z.raum === id && r && r.nachricht) {
      z.nachrichten = zusammenfuehren(z.nachrichten, [r.nachricht]);
      z.raumV.anwenden('nachricht', r.nachricht);
      gelesenMelden(false);
    }
  } catch (e) { if (z) z.ctx.zeigeFehler(e); throw e; }
}

function bearbeiten(id, n) {
  const feld = el('textarea', { class: 'eingabe chat-bearbeiten-feld', rows: '4', maxlength: '10000' });
  feld.value = n.text || '';
  const fehler = el('p', { class: 'feld-fehler', hidden: true });
  const form = el('form', { class: 'dialog-form', onsubmit: async (ev) => {
    ev.preventDefault();
    try { await z.v.aufrufen('chat.bearbeiten', { raum: id, nachricht: n.id, text: feld.value }); d.schliessen(); } catch (e) { fehler.textContent = z ? z.ctx.fehlerText(e) : ''; fehler.hidden = false; }
  } }, [feld, fehler, el('div', { class: 'dialog-knoepfe' }, [
    el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
    el('button', { class: 'knopf', type: 'submit' }, t('chat.speichern')),
  ])]);
  const d = z.ctx.dialog(form, { titel: t('chat.bearbeiten') });
  feld.focus();
}

async function anhangSpeichern(id, anhang, ziel) {
  let wohin = ziel;
  if (!wohin) {
    wohin = await ordnerWaehlen(z.ctx, { titel: t('chat.speichern_titel'), erklaerung: t('chat.speichern_erklaerung', { name: anhang.name }), okText: t('chat.speichern'), start: z.einstellungen.standardordner });
  }
  if (!wohin || !z) return;
  try {
    const r = await z.v.aufrufen('chat.anhang.speichern', { raum: id, anhang: anhang.id, freigabe: wohin.freigabe, ordner: wohin.pfad || '' });
    z.ctx.melden(t('chat.gespeichert', { pfad: `${r.freigabe}/${r.pfad}` }), 'erfolg');
  } catch (e) { z.ctx.zeigeFehler(e); }
}

// ---- Ereignisse ------------------------------------------------------------------------------------------------------

function chatEreignis(e) {
  if (!z || !e) return;
  const { raum, ereignis: art, daten } = e;
  if (raum && raum === z.raum && z.raumV) {
    if (VERLAUF_EREIGNISSE.has(art)) {
      z.nachrichten = ereignisAnwenden(z.nachrichten, art, daten);
      z.raumV.anwenden(art, daten);
      if (art === 'nachricht') gelesenMelden(false);
    } else if (art === 'gelesen' && daten && daten.wer) {
      z.gelesen = { ...z.gelesen, [daten.wer]: daten.bis };
      gelesenAnzeigen();
    } else if (art === 'raum_weg') {
      z.ctx.melden(t('chat.raum_weg'), 'warnung');
      zurListe();
    }
  }
  if (art === 'raum' || art === 'raum_weg') z.personen = null;
  uebersichtSpaeter();
}

// ---- Seiten ----------------------------------------------------------------------------------------------------------

function leerSeite() {
  modus('liste');
  const haupt = z.knoten.haupt; haupt.textContent = '';
  haupt.appendChild(el('div', { class: 'chat-leer' }, [
    symbol('chat', 'gross'), el('p', { class: 'leer-titel', text: t('chat.waehlen') }), el('p', { class: 'erklaerung', text: t('chat.untertitel') }),
    el('div', { class: 'knopf-reihe' }, [
      el('button', { class: 'knopf', type: 'button', onclick: () => raumAnlegenDialog(z.ctx, z.v) }, [symbol('plus'), t('chat.raum_neu')]),
      el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => dmDialog(z.ctx, z.v) }, [symbol('nutzer'), t('chat.dm_neu')]),
    ]),
  ]));
  z.ctx.setzeTitel(t('chat.titel'));
  listeZeichnen();
}

function einstellungenZeigen() {
  modus('einstellungen');
  const haupt = z.knoten.haupt; haupt.textContent = '';
  const behaelter = el('div', { class: 'chat-einstellungen' });
  haupt.appendChild(el('header', { class: 'chat-raumkopf' }, [
    el('button', { class: 'knopf-symbol chat-zurueck', type: 'button', 'aria-label': t('chat.zurueck'), title: t('chat.zurueck'), onclick: () => zurListe() }, [symbol('zurueck')]),
    el('div', { class: 'chat-raumkopf-info' }, [el('h2', { class: 'chat-raumkopf-name', text: t('chat.einstellungen') })]),
  ]));
  haupt.appendChild(behaelter);
  einstellungenSeite(behaelter, z.ctx, z.v);
  z.ctx.setzeTitel(t('chat.einstellungen'));
  listeZeichnen();
}

async function anzeigen(r) {
  if (!z) return;
  if (r.art === 'einladung') {
    try {
      const e = await z.v.aufrufen('chat.einladung.annehmen', { token: r.token });
      await uebersichtLaden();
      if (z) z.ctx.navigiere(hashFuer('chat', e.raum));
    } catch (f) { if (z) { z.ctx.zeigeFehler(f); zurListe(); } }
    return;
  }
  if (r.art === 'raum') { await raumOeffnen(r.raum); return; }
  raumSchliessen();
  if (r.art === 'einstellungen') einstellungenZeigen(); else leerSeite();
}

export default {
  id: 'chat',
  symbol: 'chat',
  rolle: 'nutzer',
  titel: (tt) => tt('chat.titel'),

  async einbinden(wurzel, ctx) {
    if (z) this.verlassen();
    const verbindung = ctx._chatVerbindung ?? chatVerbindung();
    const knoten = {
      status: el('p', { class: 'chat-status hinweis hinweis-warnung', hidden: true, role: 'status' }),
      liste: el('nav', { class: 'chat-raumliste', 'aria-label': t('chat.raeume') }),
      haupt: el('div', { class: 'chat-haupt' }),
      kopf: null, hochladen: null,
    };
    knoten.chat = el('div', { class: 'chat', 'data-modus': 'liste' }, [
      el('aside', { class: 'chat-seite' }, [
        el('div', { class: 'chat-seite-kopf' }, [
          el('h1', { text: t('chat.titel') }),
          el('a', { class: 'knopf-symbol', href: hashFuer('chat', 'einstellungen'), 'aria-label': t('chat.einstellungen'), title: t('chat.einstellungen') }, [symbol('system')]),
        ]),
        knoten.status, knoten.liste,
      ]),
      knoten.haupt,
    ]);
    wurzel.appendChild(knoten.chat);
    z = {
      wurzel, ctx, verbindung, knoten, ich: ctx.nutzer && ctx.nutzer.name, ab: [], timer: { uebersicht: null, gelesen: null },
      uebersicht: null, einstellungen: einstellungenNormal(chatStand.einstellungen), personen: null, online: new Set(),
      raum: null, raumV: null, eingabe: null, nachrichten: [], mehr: false, gelesen: {}, gemeldetBis: null, hochladen: null,
    };
    z.v = steuerung();
    const lauf = z;
    z.ab.push(
      verbindung.on('chat', chatEreignis),
      verbindung.on('tippt', (e) => { if (z && z.raumV && e && e.raum === z.raum && e.name) z.raumV.tippt(e.name); }),
      verbindung.on('online', (e) => { if (z) { z.online = new Set((e && e.nutzer) || []); listeZeichnen(); } }),
      verbindung.on('status', (s) => { if (z) statusZeigen(s === 'getrennt' ? t('chat.verbindung_weg') : ''); }),
      verbindung.on('wieder', async () => {
        if (!z) return;
        z.ctx.melden(t('chat.verbindung_wieder'), 'erfolg');
        await uebersichtLaden();
        if (z && z.raum && z.raumV) {
          const id = z.raum;
          try {
            const r = await z.v.aufrufen('chat.verlauf', { raum: id, anzahl: SEITE });
            if (z && z.raum === id) { ({ nachrichten: z.nachrichten, mehr: z.mehr } = nachWiederverbinden(z.nachrichten, r, z.mehr)); z.raumV.setzen(z.nachrichten, z.mehr); gelesenMelden(false); }
          } catch { /* nächster Versuch beim nächsten Wiederverbinden */ }
        }
      }),
    );
    z.sichtbar = () => { if (globalThis.document && document.visibilityState !== 'hidden') gelesenMelden(true); };
    document.addEventListener('visibilitychange', z.sichtbar);
    verbindung.starten();
    ctx.api('nutzer.einstellungen.lesen', { name: z.ich, bereich: 'chat' }).then((r) => {
      if (z !== lauf) return;
      z.einstellungen = einstellungenNormal(r && r.wert);
      chatStand.einstellungen = z.einstellungen;
      if (z.raumV) z.raumV.neuZeichnen();
    }).catch(() => { /* Standardwerte bleiben */ });
    await uebersichtLaden();
    if (z !== lauf) return;
    await anzeigen(routeAuswerten(ctx.route && ctx.route.teile));
  },

  async navigieren(route, ctx) {
    if (!z) return;
    z.ctx = ctx;
    await anzeigen(routeAuswerten(route && route.teile));
  },

  verlassen() {
    if (!z) return;
    raumSchliessen();
    for (const ab of z.ab) { try { ab(); } catch { /* egal */ } }
    if (z.timer.uebersicht) clearTimeout(z.timer.uebersicht);
    if (z.hochladen) z.hochladen.abbrechen();
    document.removeEventListener('visibilitychange', z.sichtbar);
    z = null;
  },

  sitzungEnde() {
    this.verlassen();
    chatStand.einstellungen = null;
  },
};
