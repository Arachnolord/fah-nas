// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Office“ (Plan 04): #/office = Startseite, #/office/neu/<art> = „Neu“-Dialog, #/office/oeffnen/<freigabe>/<pfad>
// = Datei aus dem Dateimanager öffnen (danach #/office/d/<id> ohne neuen Verlaufseintrag), #/office/d/<id> = Dokument
// im Rahmen mit dem Editor seiner Art (public/office/<art>/editor.js, V18). Lädt die Sitzung neu (Außenänderung,
// Neuladen), wird der Editor neu eingebunden. Beim Verlassen schließt die Sitzung, sobald nichts mehr aussteht.

import { el, t, symbol, hashFuer } from '../app.js';
import { sitzungOeffnen } from '../office/sitzung.js';
import { rahmenBauen } from '../office/rahmen.js';
import { startseite, neuDialog, ARTEN } from '../office/start.js';

const ID = /^o[A-Za-z0-9_-]{16}$/;

/** #/office/… → {art:'start'} | {art:'neu', dokArt} | {art:'oeffnen', freigabe, pfad} | {art:'dok', id}; Unbekanntes → start. */
export function routeAuswerten(teile) {
  const [a, b, ...rest] = Array.isArray(teile) ? teile : [];
  if (a === 'neu' && ARTEN.includes(b)) return { art: 'neu', dokArt: b };
  if (a === 'oeffnen' && b && rest.length && rest.every(Boolean)) return { art: 'oeffnen', freigabe: b, pfad: rest.join('/') };
  if (a === 'd' && ID.test(b || '')) return { art: 'dok', id: b };
  return { art: 'start' };
}

const editorLadenStandard = (art) => import(new URL(`../office/${art}/editor.js`, import.meta.url).href);

let z = null; // Zustand der eingebundenen Ansicht

function laden(text) { return el('div', { class: 'laden', role: 'status' }, [el('span', { class: 'laden-kreis' }), text]); }

/** Offenes Dokument verlassen: Editor weg, Rahmen weg, Sitzung schließt (ohne zu warten). */
function dokSchliessen() {
  if (!z) return;
  for (const ab of z.dokAb) { try { ab(); } catch { /* egal */ } }
  z.dokAb = [];
  if (z.editor) { try { z.editor.verlassen(); } catch (e) { console.error(e); } }
  if (z.rahmen) z.rahmen.entfernen();
  // noch Unbestätigtes (etwa offline): die Sitzung reicht es nach, bevor sie sich abmeldet – sagen, damit der Tab offen bleibt
  if (z.sitzung && z.sitzung.ausstehend > 0) z.ctx.melden(t('office.wird_nachgereicht'), 'info', 8000);
  if (z.sitzung) z.sitzung.schliessen().catch(() => {});
  z.editor = null; z.rahmen = null; z.sitzung = null;
}

async function editorEinbinden(lauf) {
  const { sitzung, rahmen } = z;
  if (z.editor) { try { z.editor.verlassen(); } catch (e) { console.error(e); } z.editor = null; }
  rahmen.setzeEditor(null);
  rahmen.inhalt.textContent = '';
  let modul;
  try { modul = await (z.ctx._editorLaden || editorLadenStandard)(sitzung.dok.art); } catch {
    if (z && z.lauf === lauf) rahmen.inhalt.appendChild(el('p', { class: 'leer of-art-fehlt', text: t('office.art_fehlt') }));
    return;
  }
  if (!z || z.lauf !== lauf || z.sitzung !== sitzung) return;
  try {
    const editor = await modul.editorEinbinden(rahmen.inhalt, { ctx: z.ctx, sitzung, recht: sitzung.recht });
    if (!z || z.lauf !== lauf || z.sitzung !== sitzung) { try { editor.verlassen(); } catch { /* egal */ } return; }
    z.editor = editor;
    rahmen.setzeEditor(editor);
  } catch (e) { z.ctx.zeigeFehler(e); }
}

async function dokOeffnen(ref) {
  const lauf = ++z.lauf;
  dokSchliessen();
  z.wurzel.textContent = '';
  z.wurzel.appendChild(laden(t('office.laden')));
  let sitzung;
  try {
    sitzung = await sitzungOeffnen({ ref, ctx: z.ctx, ...(z.ctx._officeVerbindung ? { verbindung: z.ctx._officeVerbindung } : {}) });
  } catch (e) {
    if (!z || z.lauf !== lauf) return;
    z.wurzel.textContent = '';
    const art = e && e.code === 'E_PARAMS' && e.details && e.details.art;
    z.wurzel.appendChild(el('div', { class: 'leer of-fehler' }, [
      symbol('warnung', 'gross'),
      el('p', { class: 'leer-titel', text: art ? t('office.art_fehlt') : z.ctx.fehlerText(e) }),
      el('a', { class: 'knopf knopf-zweit', href: hashFuer('office') }, t('office.zur_startseite')),
    ]));
    return;
  }
  if (!z || z.lauf !== lauf) { sitzung.schliessen().catch(() => {}); return; }
  z.sitzung = sitzung;
  z.wurzel.textContent = '';
  z.rahmen = rahmenBauen(z.wurzel, { ctx: z.ctx, sitzung });
  if (typeof z.ctx.setzeTitel === 'function') z.ctx.setzeTitel(sitzung.dok.name);
  z.dokAb.push(sitzung.on('neu_geladen', () => { if (z && z.sitzung === sitzung) editorEinbinden(z.lauf); }));
  if (ref.id !== sitzung.dok.id) location.replace(hashFuer('office', 'd', sitzung.dok.id));
  await editorEinbinden(lauf);
}

async function startZeigen() {
  ++z.lauf;
  dokSchliessen();
  if (typeof z.ctx.setzeTitel === 'function') z.ctx.setzeTitel(t('office.titel'));
  await startseite(z.wurzel, z.ctx);
}

async function anzeigen(r) {
  if (r.art === 'dok') {
    if (z.sitzung && z.sitzung.dok.id === r.id) return; // schon offen (z. B. nach location.replace)
    await dokOeffnen({ id: r.id });
    return;
  }
  if (r.art === 'oeffnen') { await dokOeffnen({ freigabe: r.freigabe, pfad: r.pfad }); return; }
  await startZeigen();
  if (r.art !== 'neu' || !z) return;
  const lauf = z.lauf;
  const neu = await neuDialog(z.ctx, r.dokArt);
  if (!z || z.lauf !== lauf) return;
  if (neu && neu.id) z.ctx.navigiere(hashFuer('office', 'd', neu.id));
  else location.replace(hashFuer('office'));
}

export default {
  id: 'office',
  symbol: 'office',
  rolle: 'nutzer',
  titel: (tt) => tt('office.titel'),

  async einbinden(wurzel, ctx) {
    if (z) this.verlassen();
    z = { wurzel, ctx, lauf: 0, sitzung: null, rahmen: null, editor: null, dokAb: [] };
    await anzeigen(routeAuswerten(ctx.route && ctx.route.teile));
  },

  async navigieren(route, ctx) {
    if (!z) return;
    z.ctx = ctx;
    await anzeigen(routeAuswerten(route && route.teile));
  },

  verlassen() {
    if (!z) return;
    ++z.lauf;
    dokSchliessen();
    z = null;
  },

  sitzungEnde() { this.verlassen(); },
};
