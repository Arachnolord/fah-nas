// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Dialoge der Chat-Ansicht (Plan 02): Raum anlegen, Direktnachricht beginnen, Mitglieder/Verwalter/Gäste,
// Raum umbenennen, Einladungslinks (Gültigkeit, Höchstzahl, Kopieren, QR-Code, Löschen) und Suche im Raum.
// `v` ist die Steuerung der Ansicht: {ich, aufrufen, personen(), aktualisieren(), oeffnen(id), raum(id), zurListe()}.

import { el, t, symbol, format } from '../app.js';
import { qrErzeugen, qrZeichnen } from '../ansichten/nutzer.qr.js';
import { avatarKnoten } from '../avatar.js';

/** Gültigkeit neuer Einladungslinks in Stunden; 0 = dauerhaft. */
export const GUELTIGKEITEN = Object.freeze([1, 24, 168, 720, 0]);
const GUELTIG_TEXT = { 1: 'chat.gueltig_1h', 24: 'chat.gueltig_24h', 168: 'chat.gueltig_7t', 720: 'chat.gueltig_30t', 0: 'chat.gueltig_immer' };

/** Volle Adresse eines Einladungslinks: gelernte öffentliche Domain (nur http/https), sonst die Adresse im Browser. */
export function einladungsAdresse(zugang, token, herkunft = location.origin) {
  const basis = zugang && typeof zugang.link_basis === 'string' && /^https?:\/\/[^/\s]+$/.test(zugang.link_basis) ? zugang.link_basis : herkunft;
  return `${basis}/einladung/${token}`;
}

/** Passt die Adresse in einen QR-Code der eingebauten Größe? */
export function qrTauglich(adresse) { return new TextEncoder().encode(adresse).length <= 213; }

/** Auswahlliste von Personen mit Filter; {element, gewaehlt() → string[]}. */
function personenWahl(personen, { leerText }) {
  const gewaehlt = new Set();
  const liste = el('ul', { class: 'chat-personen', role: 'list' });
  const filter = el('input', { class: 'eingabe', type: 'search', placeholder: t('chat.personen_filter'), 'aria-label': t('chat.personen_filter') });
  const zeigen = () => {
    const f = (filter.value || '').trim().toLowerCase();
    liste.textContent = '';
    const sichtbar = personen.filter((p) => !f || p.name.toLowerCase().includes(f) || String(p.anzeigename).toLowerCase().includes(f));
    if (!sichtbar.length) { liste.appendChild(el('li', { class: 'erklaerung', text: leerText })); return; }
    for (const p of sichtbar) {
      const box = el('input', { type: 'checkbox', checked: gewaehlt.has(p.name), onchange: () => { if (box.checked) gewaehlt.add(p.name); else gewaehlt.delete(p.name); } });
      liste.appendChild(el('li', {}, [el('label', { class: 'chat-person' }, [box, avatarKnoten({ name: p.name, anzeige: p.anzeigename || p.name, groesse: 28 }), el('span', { text: p.anzeigename }), p.anzeigename !== p.name ? el('span', { class: 'schwach klein', text: p.name }) : null])]));
    }
  };
  filter.addEventListener('input', zeigen);
  zeigen();
  return { element: el('div', { class: 'chat-personen-wahl' }, [personen.length > 8 ? filter : null, liste]), gewaehlt: () => [...gewaehlt] };
}

function feld(beschriftung, eingabe, erklaerung) {
  return el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: beschriftung }), eingabe, erklaerung ? el('p', { class: 'erklaerung', text: erklaerung }) : null]);
}

async function personenLaden(ctx, v, ohne) {
  try { return (await v.personen()).filter((p) => !ohne.has(p.name)); } catch (e) { ctx.zeigeFehler(e); return []; }
}

/** Neuer Raum: Name, Beschreibung, Mitglieder. Öffnet ihn danach. */
export async function raumAnlegenDialog(ctx, v) {
  const personen = await personenLaden(ctx, v, new Set([v.ich]));
  return new Promise((fertig) => {
    let ergebnis = null;
    const name = el('input', { class: 'eingabe', type: 'text', maxlength: '80', autocomplete: 'off' });
    const beschreibung = el('input', { class: 'eingabe', type: 'text', maxlength: '300', autocomplete: 'off' });
    const wahl = personenWahl(personen, { leerText: t('chat.personen_leer') });
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const los = el('button', { class: 'knopf', type: 'submit' }, t('chat.raum_anlegen'));
    const form = el('form', { class: 'dialog-form', onsubmit: async (ev) => {
      ev.preventDefault();
      const n = name.value.trim();
      if (!n) { fehler.textContent = t('chat.raum_name_fehlt'); fehler.hidden = false; name.focus(); return; }
      los.disabled = true;
      try {
        const r = await v.aufrufen('chat.raum.anlegen', { name: n, beschreibung: beschreibung.value.trim(), mitglieder: wahl.gewaehlt() });
        ergebnis = r.raum; d.schliessen();
        await v.aktualisieren(); v.oeffnen(r.raum);
      } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; los.disabled = false; }
    } }, [
      feld(t('chat.raum_name'), name),
      feld(t('chat.raum_beschreibung'), beschreibung, t('chat.raum_beschreibung_erklaerung')),
      el('div', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('chat.mitglieder') }), wahl.element, el('p', { class: 'erklaerung', text: t('chat.mitglieder_erklaerung') })]),
      fehler,
      el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')), los]),
    ]);
    const d = ctx.dialog(form, { titel: t('chat.raum_neu'), beimSchliessen: () => fertig(ergebnis) });
    name.focus();
  });
}

/** Direktnachricht: eine Person wählen, öffnet die Unterhaltung (legt sie beim ersten Mal an). */
export async function dmDialog(ctx, v) {
  const personen = await personenLaden(ctx, v, new Set([v.ich]));
  return new Promise((fertig) => {
    let ergebnis = null;
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const knoepfe = personen.map((p) => el('li', {}, [el('button', { class: 'chat-person-knopf', type: 'button', onclick: async () => {
      try { const r = await v.aufrufen('chat.dm.oeffnen', { nutzer: p.name }); ergebnis = r.raum; d.schliessen(); await v.aktualisieren(); v.oeffnen(r.raum); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
    } }, [avatarKnoten({ name: p.name, anzeige: p.anzeigename || p.name, groesse: 28 }), el('span', { text: p.anzeigename }), p.anzeigename !== p.name ? el('span', { class: 'schwach klein', text: p.name }) : null])]));
    const d = ctx.dialog([
      el('p', { class: 'erklaerung', text: t('chat.dm_erklaerung') }),
      knoepfe.length ? el('ul', { class: 'chat-personen', role: 'list' }, knoepfe) : el('p', { class: 'erklaerung', text: t('chat.personen_leer') }),
      fehler,
    ], { titel: t('chat.dm_neu'), beimSchliessen: () => fertig(ergebnis) });
  });
}

/** Name und Beschreibung ändern (Verwalter). */
export function raumBearbeitenDialog(ctx, v, raum) {
  return new Promise((fertig) => {
    let ergebnis = false;
    const name = el('input', { class: 'eingabe', type: 'text', maxlength: '80', value: raum.name || '' });
    const beschreibung = el('input', { class: 'eingabe', type: 'text', maxlength: '300', value: raum.beschreibung || '' });
    const fehler = el('p', { class: 'feld-fehler', hidden: true });
    const form = el('form', { class: 'dialog-form', onsubmit: async (ev) => {
      ev.preventDefault();
      if (!name.value.trim()) { fehler.textContent = t('chat.raum_name_fehlt'); fehler.hidden = false; return; }
      try { await v.aufrufen('chat.raum.aendern', { raum: raum.id, name: name.value.trim(), beschreibung: beschreibung.value.trim() }); ergebnis = true; d.schliessen(); await v.aktualisieren(); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
    } }, [
      feld(t('chat.raum_name'), name), feld(t('chat.raum_beschreibung'), beschreibung, t('chat.raum_beschreibung_erklaerung')), fehler,
      el('div', { class: 'dialog-knoepfe' }, [el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')), el('button', { class: 'knopf', type: 'submit' }, t('chat.speichern'))]),
    ]);
    const d = ctx.dialog(form, { titel: t('chat.raum_bearbeiten'), beimSchliessen: () => fertig(ergebnis) });
  });
}

/** Mitglieder, Verwalter und Gäste; Verwalter fügen hinzu, entfernen, ernennen, benennen um und löschen. */
export function mitgliederDialog(ctx, v, raumStart) {
  const inhalt = el('div', { class: 'chat-mitglieder' });
  const fehler = el('p', { class: 'feld-fehler', hidden: true });
  let raum = raumStart;
  const tun = async (fn) => {
    fehler.hidden = true;
    try { await fn(); await v.aktualisieren(); raum = v.raum(raum.id) || raum; zeichnen(); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
  };
  const mitglieder = (aenderung) => v.aufrufen('chat.raum.mitglieder', { raum: raum.id, hinzu: [], weg: [], verwalter_hinzu: [], verwalter_weg: [], ...aenderung });

  function zeichnen() {
    inhalt.textContent = '';
    const darf = raum.verwalter && raum.art === 'raum';
    const verwaltende = new Set(raum.verwaltende || []);
    const zeilen = (raum.mitglieder || []).map((m) => el('li', { class: 'chat-mitglied' }, [
      avatarKnoten({ name: m.name, anzeige: m.anzeigename || m.name, groesse: 28 }), el('span', { class: 'chat-mitglied-name', text: m.anzeigename || m.name }),
      verwaltende.has(m.name) ? el('span', { class: 'chat-marke', text: t('chat.verwalter') }) : null,
      m.name === v.ich ? el('span', { class: 'schwach klein', text: t('chat.du') }) : null,
      darf && m.name !== v.ich ? el('span', { class: 'chat-mitglied-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => tun(() => mitglieder(verwaltende.has(m.name) ? { verwalter_weg: [m.name] } : { verwalter_hinzu: [m.name] })) },
          verwaltende.has(m.name) ? t('chat.verwalter_weg') : t('chat.verwalter_machen')),
        el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => tun(() => mitglieder({ weg: [m.name] })) }, t('chat.entfernen')),
      ]) : null,
    ]));
    const gaeste = (raum.gaeste || []).map((g) => el('li', { class: 'chat-mitglied' }, [
      avatarKnoten({ anzeige: g.name, groesse: 28 }), el('span', { class: 'chat-mitglied-name', text: g.name }), el('span', { class: 'chat-marke chat-marke-gast', text: t('chat.gast') }),
      darf ? el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: async () => {
        const wahl = await gastEntfernenFragen(ctx, g.name);
        if (wahl) tun(() => v.aufrufen('chat.gast.entfernen', { raum: raum.id, gast: g.id, link_sperren: wahl.link_sperren }));
      } }, t('chat.entfernen')) : null,
    ]));
    inhalt.appendChild(el('ul', { class: 'chat-mitglieder-liste', role: 'list' }, [...zeilen, ...gaeste]));
    if (darf) {
      inhalt.appendChild(el('div', { class: 'knopf-reihe' }, [
        el('button', { class: 'knopf', type: 'button', onclick: () => hinzufuegen() }, [symbol('plus'), t('chat.mitglieder_hinzu')]),
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: async () => { if (await raumBearbeitenDialog(ctx, v, raum)) { raum = v.raum(raum.id) || raum; zeichnen(); } } }, [symbol('umbenennen'), t('chat.raum_bearbeiten')]),
        el('button', { class: 'knopf knopf-zweit knopf-gefahr', type: 'button', onclick: async () => {
          if (!await ctx.bestaetigen(t('chat.raum_loeschen_frage', { name: raum.name }), { titel: t('chat.raum_loeschen'), ok: t('chat.loeschen'), gefahr: true })) return;
          try { await v.aufrufen('chat.raum.loeschen', { raum: raum.id }); d.schliessen(); await v.aktualisieren(); v.zurListe(); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
        } }, [symbol('loeschen'), t('chat.raum_loeschen')]),
      ]));
    }
    if (raum.art === 'raum') {
      inhalt.appendChild(el('div', { class: 'knopf-reihe chat-verlassen' }, [el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: async () => {
        if (!await ctx.bestaetigen(t('chat.verlassen_frage', { name: raum.name }), { titel: t('chat.verlassen'), ok: t('chat.verlassen') })) return;
        try { await mitglieder({ weg: [v.ich] }); d.schliessen(); await v.aktualisieren(); v.zurListe(); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
      } }, [symbol('abmelden'), t('chat.verlassen')])]));
    }
    inhalt.appendChild(fehler);
  }

  async function hinzufuegen() {
    const schon = new Set((raum.mitglieder || []).map((m) => m.name));
    const personen = await personenLaden(ctx, v, schon);
    const wahl = personenWahl(personen, { leerText: t('chat.personen_alle_da') });
    const dd = ctx.dialog([
      wahl.element,
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => dd.schliessen() }, t('rahmen.abbrechen')),
        el('button', { class: 'knopf', type: 'button', onclick: () => { const neu = wahl.gewaehlt(); dd.schliessen(); if (neu.length) tun(() => mitglieder({ hinzu: neu })); } }, t('chat.mitglieder_hinzu')),
      ]),
    ], { titel: t('chat.mitglieder_hinzu') });
  }

  zeichnen();
  const d = ctx.dialog(inhalt, { titel: t('chat.mitglieder_titel', { name: raum.name }) });
  return d;
}

/**
 * Gast entfernen? Mit der Wahl, auch seinen Einladungslink zu löschen – sonst kommt er über denselben Link als neuer Gast
 * zurück (vorgewählt). → {link_sperren} oder null (abgebrochen).
 */
function gastEntfernenFragen(ctx, name) {
  return new Promise((aufloesen) => {
    let ergebnis = null;
    const haken = el('input', { type: 'checkbox', checked: true });
    const d = ctx.dialog([
      el('p', { class: 'dialog-text', text: t('chat.gast_entfernen_frage', { name }) }),
      el('label', { class: 'schalter' }, [haken, el('span', { text: t('chat.gast_link_sperren') })]),
      el('p', { class: 'erklaerung schwach klein', text: t('chat.gast_link_sperren_erklaerung', { name }) }),
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => d.schliessen() }, t('rahmen.abbrechen')),
        el('button', { class: 'knopf knopf-gefahr', type: 'button', onclick: () => { ergebnis = { link_sperren: haken.checked }; d.schliessen(); } }, t('chat.entfernen')),
      ]),
    ], { titel: t('chat.gast_entfernen_titel'), beimSchliessen: () => aufloesen(ergebnis) });
  });
}

/** Einladungslinks eines Raums (Verwalter): anlegen, kopieren, als QR-Code zeigen, löschen. */
export function einladungenDialog(ctx, v, raum) {
  const gueltig = el('select', { class: 'eingabe' }, GUELTIGKEITEN.map((h) => el('option', { value: String(h), text: t(GUELTIG_TEXT[h]), selected: h === 168 })));
  gueltig.value = '168';
  const max = el('input', { class: 'eingabe', type: 'number', min: '1', max: '1000', step: '1', placeholder: t('chat.einladung_max_leer') });
  const liste = el('ul', { class: 'chat-einladungen', role: 'list' });
  const fehler = el('p', { class: 'feld-fehler', hidden: true });

  const zeile = (e) => {
    const adresse = einladungsAdresse(ctx.zugang, e.token);
    const qr = el('canvas', { class: 'chat-qr', hidden: true, 'aria-label': t('chat.qr') });
    const ablauf = e.ablauf ? t('chat.einladung_bis', { zeit: format.zeitGenau(e.ablauf) }) : t('chat.gueltig_immer');
    const beitritte = e.max ? t('chat.einladung_beitritte_max', { n: e.beitritte, max: e.max }) : t('chat.einladung_beitritte', { n: e.beitritte });
    return el('li', { class: 'chat-einladung' }, [
      el('input', { class: 'eingabe chat-einladung-adresse', type: 'text', readonly: '', value: adresse, 'aria-label': t('chat.einladung_link'), onfocus: (ev) => { try { ev.target.select(); } catch { /* egal */ } } }),
      el('p', { class: 'schwach klein', text: `${ablauf} · ${beitritte}` }),
      el('div', { class: 'knopf-reihe' }, [
        el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(adresse); ctx.melden(t('chat.kopiert'), 'erfolg'); } catch { ctx.melden(t('chat.kopieren_selbst'), 'info'); }
        } }, [symbol('kopieren'), t('chat.kopieren')]),
        qrTauglich(adresse) ? el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', onclick: () => {
          if (qr.hidden) { try { qrZeichnen(qr, qrErzeugen(adresse), 4, 4); qr.hidden = false; } catch { ctx.melden(t('chat.qr_fehl'), 'warnung'); } } else qr.hidden = true;
        } }, t('chat.qr')) : null,
        el('button', { class: 'knopf knopf-zweit knopf-klein knopf-gefahr', type: 'button', onclick: async () => {
          if (!await ctx.bestaetigen(t('chat.einladung_loeschen_frage'), { titel: t('chat.einladung_loeschen'), ok: t('chat.loeschen'), gefahr: true })) return;
          try { await v.aufrufen('chat.einladung.loeschen', { raum: raum.id, id: e.id }); laden(); } catch (f) { fehler.textContent = ctx.fehlerText(f); fehler.hidden = false; }
        } }, [symbol('loeschen'), t('chat.loeschen')]),
      ]),
      qr,
    ]);
  };

  async function laden() {
    let alle;
    try { alle = await v.aufrufen('chat.einladung.liste', { raum: raum.id }); } catch (e) { liste.textContent = ''; liste.appendChild(el('li', { class: 'erklaerung', text: ctx.fehlerText(e) })); return; }
    liste.textContent = '';
    if (!Array.isArray(alle) || !alle.length) { liste.appendChild(el('li', { class: 'erklaerung', text: t('chat.einladungen_leer') })); return; }
    for (const e of alle) liste.appendChild(zeile(e));
  }

  const anlegen = el('button', { class: 'knopf', type: 'button', onclick: async () => {
    fehler.hidden = true;
    const p = { raum: raum.id, gueltig_h: Number(gueltig.value || 168) };
    const m = Math.round(Number(max.value));
    if (max.value && (!Number.isFinite(m) || m < 1 || m > 1000)) { fehler.textContent = t('chat.einladung_max_ungueltig'); fehler.hidden = false; return; }
    if (max.value) p.max_beitritte = m;
    anlegen.disabled = true;
    try { await v.aufrufen('chat.einladung.anlegen', p); max.value = ''; await laden(); } catch (e) { fehler.textContent = ctx.fehlerText(e); fehler.hidden = false; }
    anlegen.disabled = false;
  } }, [symbol('link'), t('chat.einladung_neu')]);

  laden();
  return ctx.dialog([
    el('p', { class: 'erklaerung', text: t('chat.einladungen_erklaerung') }),
    el('div', { class: 'chat-einladung-form' }, [
      feld(t('chat.einladung_gueltig'), gueltig, t('chat.einladung_gueltig_erklaerung')),
      feld(t('chat.einladung_max'), max, t('chat.einladung_max_erklaerung')),
      el('div', { class: 'knopf-reihe' }, [anlegen]),
    ]),
    fehler,
    el('h3', { text: t('chat.einladungen_aktiv') }),
    liste,
  ], { titel: t('chat.einladungen_titel', { name: raum.name }), breit: true });
}

/** Suche im Raum (ab 2 Zeichen); ein Klick auf einen Treffer ruft beiTreffer(nachricht). */
export function sucheDialog(ctx, v, raum, beiTreffer) {
  const feldSuche = el('input', { class: 'eingabe', type: 'search', maxlength: '100', placeholder: t('chat.suchen_platzhalter'), 'aria-label': t('chat.suchen') });
  const treffer = el('ul', { class: 'chat-treffer', role: 'list' });
  const suchen = async () => {
    const text = feldSuche.value.trim();
    treffer.textContent = '';
    if (text.length < 2) { treffer.appendChild(el('li', { class: 'erklaerung', text: t('chat.suchen_kurz') })); return; }
    try {
      const r = await v.aufrufen('chat.suche', { raum: raum.id, text });
      const liste = (r && r.treffer) || [];
      if (!liste.length) { treffer.appendChild(el('li', { class: 'erklaerung', text: t('chat.suchen_nichts') })); return; }
      for (const n of liste) {
        treffer.appendChild(el('li', {}, [el('button', { class: 'chat-treffer-knopf', type: 'button', onclick: () => { d.schliessen(); beiTreffer(n); } }, [
          el('span', { class: 'chat-name', text: n.von_name || '' }), el('span', { class: 'schwach klein', text: format.zeitGenau(n.zeit) }),
          el('span', { class: 'chat-treffer-text', text: String(n.text || '').slice(0, 200) }),
        ])]));
      }
    } catch (e) { treffer.appendChild(el('li', { class: 'feld-fehler', text: ctx.fehlerText(e) })); }
  };
  const form = el('form', { class: 'dialog-form', onsubmit: (ev) => { ev.preventDefault(); suchen(); } }, [
    el('div', { class: 'knopf-reihe' }, [feldSuche, el('button', { class: 'knopf', type: 'submit' }, [symbol('suchen'), t('chat.suchen')])]), treffer,
  ]);
  const d = ctx.dialog(form, { titel: t('chat.suchen_titel', { name: raum.name }) });
  feldSuche.focus();
  return d;
}
