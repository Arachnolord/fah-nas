// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Import ins Office (Plan 04, V18): .docx → Dokument, .xlsx/.csv → Tabelle – immer als Kopie, das Original bleibt
// unverändert. Ablauf: Typmodul laden → Datei laden → importieren → office.anlegen (neben der Quelle bzw. im gewählten
// Ordner) → Bilder/Anhänge hochladen → verknüpfen → office.import_setzen → öffnen. Was nicht übernommen wurde, sagt
// eine Meldung in einem Satz.

import { t } from '../app.js';
import { ordnerWaehlen } from '../ordnerwahl.js';
import { xhrHochladen } from './sitzung.js';

const MAX_QUELLE = 200 * 1024 * 1024;
const MELDUNG_MS = 10_000;

/** Office-Art für eine importierbare Datei: .docx → dokument, .xlsx/.csv → tabelle, sonst null. */
export function artFuerImport(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.docx')) return 'dokument';
  if (n.endsWith('.xlsx') || n.endsWith('.csv')) return 'tabelle';
  return null;
}

/** Name ohne Endung, ohne Punkte vorn (Office-Namen dürfen nicht mit einem Punkt beginnen). */
function stammVon(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  const stamm = (i > 0 ? n.slice(0, i) : n).replace(/^\.+/, '').trim().slice(0, 200);
  return stamm || 'Import';
}

const modulStandard = (art) => import(new URL(`./${art}/import.js`, import.meta.url).href);

/**
 * Datei importieren und das neue Office-Dokument öffnen → {id} | null (nicht möglich, abgebrochen oder gescheitert –
 * eine Meldung sagt dann warum). `schreibbar` = Schreibrecht im Ordner der Quelle; sonst wird ein Ordner gewählt.
 */
export async function importAblauf(ctx, { freigabe, pfad, name, schreibbar }, { modulLaden = modulStandard, hochladen = xhrHochladen, ordnerWahl = ordnerWaehlen } = {}) {
  const art = artFuerImport(name);
  if (!art) return null;
  let modul;
  try { modul = await modulLaden(art); } catch { ctx.melden(t('office.import_nicht_verfuegbar'), 'warnung'); return null; }
  let ergebnis;
  try {
    const blob = await ctx.ladeBlob(freigabe, pfad, MAX_QUELLE);
    ergebnis = await modul.importieren(blob, name);
  } catch (e) {
    ctx.melden(ctx.fehlerText(e), 'fehler', MELDUNG_MS); // kaputte oder zu große Datei: nichts anlegen
    return null;
  }
  let ziel;
  if (schreibbar) {
    const i = String(pfad).lastIndexOf('/');
    ziel = { freigabe, pfad: i > 0 ? String(pfad).slice(0, i) : '' };
  } else {
    ziel = await ordnerWahl(ctx, { titel: t('office.import_ordner'), erklaerung: t('office.ordner_erklaerung'), okText: t('office.ordner_ok'), nurSchreibbar: true });
    if (!ziel) return null;
  }
  const neu = await ctx.api('office.anlegen', { art, freigabe: ziel.freigabe, ordner: ziel.pfad || '', name: stammVon(name), beide: true });
  try {
    const karte = new Map();
    for (const d of (ergebnis && ergebnis.dateien) || []) {
      const r = await hochladen(`/api/office/hochladen?id=${encodeURIComponent(neu.id)}&name=${encodeURIComponent(d.name)}`, d.blob);
      karte.set(d.schluessel, r.datei);
    }
    await ctx.api('office.import_setzen', { id: neu.id, daten: modul.verknuepfen(ergebnis.daten, karte) });
  } catch (e) {
    // das leere Dokument bleibt liegen – die Meldung sagt es
    ctx.melden(t('office.import_abgebrochen', { name: neu.name, fehler: ctx.fehlerText(e) }), 'fehler', MELDUNG_MS);
    return null;
  }
  const fehlte = Array.isArray(ergebnis.fehlte) ? ergebnis.fehlte.filter(Boolean) : [];
  if (fehlte.length) ctx.melden(t('office.import_fehlte', { liste: fehlte.join(', ') }), 'warnung', MELDUNG_MS);
  ctx.navigiere(ctx.hashFuer('office', 'd', neu.id));
  return { id: neu.id };
}
