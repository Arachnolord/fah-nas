// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Import-Modul der Dokumentart (Plan 05, V18): .docx einlesen → Daten, Bilddateien zum Hochladen und übersetzte Hinweise,
// was nicht übernommen wurde. Kaputte oder zu große Dateien werfen einen Fehler mit übersetztem Satz (importAblauf aus
// Plan 04 zeigt ihn). `verknuepfen` setzt nach dem Hochladen die Datei-Kennungen der Bilder ein.

import { t } from '../../app.js';
import { normalisieren } from '../../gemeinsam/sync/delta.js';
import { docxLesen } from './docx.js';

/** office.import_setzen nimmt höchstens 16 MiB JSON (V2) – mit Luft darunter, wie Plan 06. */
const JSON_MAX = 15_728_640;

/** Hinweistexte je Art (feste Schlüssel, damit die Sprachprüfung sie findet). */
const FEHLTE_TEXT = {
  kopfzeilen: (n) => t('office.dok_fehlte_kopfzeilen', { n }),
  fussnoten: (n) => t('office.dok_fehlte_fussnoten', { n }),
  kommentare: (n) => t('office.dok_fehlte_kommentare', { n }),
  diagramme: (n) => t('office.dok_fehlte_diagramme', { n }),
  formen: (n) => t('office.dok_fehlte_formen', { n }),
  textfelder: (n) => t('office.dok_fehlte_textfelder', { n }),
  felder: (n) => t('office.dok_fehlte_felder', { n }),
  formeln: (n) => t('office.dok_fehlte_formeln', { n }),
  objekte: (n) => t('office.dok_fehlte_objekte', { n }),
  bilder: (n) => t('office.dok_fehlte_bilder', { n }),
  verbunden: (n) => t('office.dok_fehlte_verbunden', { n }),
  verschachtelt: (n) => t('office.dok_fehlte_verschachtelt', { n }),
  tabellengroesse: (n) => t('office.dok_fehlte_tabellengroesse', { n }),
};

/** .docx → {daten, dateien: [{schluessel, name, blob}], fehlte: [übersetzter Text]}; Fehler mit übersetzter Meldung. */
export async function importieren(blob, name) { // eslint-disable-line no-unused-vars
  let r;
  try {
    r = await docxLesen(await blob.arrayBuffer());
  } catch (e) {
    throw new Error(t(e && e.message === 'zip_zu_gross' ? 'office.dok_import_zu_gross' : 'office.dok_import_kaputt'), { cause: e });
  }
  if (JSON.stringify(r.daten).length > JSON_MAX) throw new Error(t('office.dok_import_zu_gross'));
  const fehlte = (r.fehlte || []).filter((f) => Object.hasOwn(FEHLTE_TEXT, f.art)).map((f) => FEHLTE_TEXT[f.art](f.anzahl));
  return { daten: r.daten, dateien: r.dateien || [], fehlte };
}

/** Bilder mit Schlüssel aus `karte` (Map Schlüssel → Datei-Kennung) bekommen die Kennung, unbekannte fallen weg. */
export function verknuepfen(daten, karte) {
  const delta = [];
  for (const op of daten.delta) {
    if (op.insert && typeof op.insert === 'object' && op.insert.bild) {
      const datei = karte.get(op.insert.bild.datei);
      if (datei) delta.push({ ...op, insert: { bild: { ...op.insert.bild, datei } } });
      continue;
    }
    delta.push(op);
  }
  return { ...daten, delta: normalisieren(delta) };
}
