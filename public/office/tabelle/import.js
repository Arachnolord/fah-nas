// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Import-Modul der Tabelle (Plan 06, V18): .xlsx bzw. .csv/.tsv/.txt einlesen → Daten und übersetzte Hinweise, was
// nicht übernommen wurde. Kaputte oder zu große Dateien werfen einen Fehler mit übersetztem Satz (importAblauf aus
// Plan 04 zeigt ihn). Tabellen haben keine eigenen Dateien: `dateien` ist immer leer, `verknuepfen` ändert nichts.

import { t } from '../../app.js';
import { GRENZEN } from './formeln/adresse.js';
import { csvDekodieren, csvZuDaten } from './csv.js';
import { xlsxLesen } from './xlsx.js';

const CSV_ENDUNGEN = new Set(['csv', 'tsv', 'txt']);

/** Hinweistexte je Art (feste Schlüssel, damit die Sprachprüfung sie findet). */
const FEHLTE_TEXT = {
  diagramme: (n) => t('office.tab_fehlte_diagramme', { n }),
  pivot: (n) => t('office.tab_fehlte_pivot', { n }),
  bedingt: (n) => t('office.tab_fehlte_bedingt', { n }),
  verbunden: (n) => t('office.tab_fehlte_verbunden', { n }),
  makros: (n) => t('office.tab_fehlte_makros', { n }),
  bilder: (n) => t('office.tab_fehlte_bilder', { n }),
  kommentare: (n) => t('office.tab_fehlte_kommentare', { n }),
  links: (n) => t('office.tab_fehlte_links', { n }),
  datenpruefung: (n) => t('office.tab_fehlte_datenpruefung', { n }),
  formeln: (n) => t('office.tab_fehlte_formeln', { n }),
  funktionen: (n, namen) => t('office.tab_fehlte_funktionen', { n, namen: (namen || []).join(', ') }),
  groesse: (n) => t('office.tab_fehlte_groesse', { n }),
};

/** Dateiname → [Stamm, Endung klein]: „Kunden.CSV“ → ['Kunden', 'csv'], ohne Endung → [Name, '']. */
function zerlegeName(name) {
  const datei = String(name ?? '').split(/[\\/]/).pop();
  const i = datei.lastIndexOf('.');
  return i > 0 ? [datei.slice(0, i), datei.slice(i + 1).toLowerCase()] : [datei, ''];
}

/** .xlsx/.csv → {daten, dateien: [], fehlte: [übersetzter Text]}; Fehler mit übersetzter Meldung. */
export async function importieren(blob, name) {
  const [stamm, endung] = zerlegeName(name);
  let r;
  try {
    if (endung === 'xlsx') r = await xlsxLesen(await blob.arrayBuffer());
    else if (CSV_ENDUNGEN.has(endung)) r = csvZuDaten(csvDekodieren(new Uint8Array(await blob.arrayBuffer())), { name: stamm });
    else throw new Error('kein_format');
  } catch (e) {
    throw new Error(t(e && e.message === 'zip_zu_gross' ? 'office.tab_import_zu_gross' : 'office.tab_import_kaputt'), { cause: e });
  }
  // office.import_setzen nimmt höchstens 16 MiB JSON – gemessen in Byte (UTF-8), nicht in Zeichen
  if (new TextEncoder().encode(JSON.stringify(r.daten)).length > GRENZEN.json_import) throw new Error(t('office.tab_import_zu_gross'));
  const fehlte = (r.fehlte || []).filter((f) => Object.hasOwn(FEHLTE_TEXT, f.art)).map((f) => FEHLTE_TEXT[f.art](f.anzahl, f.namen));
  return { daten: r.daten, dateien: [], fehlte };
}

/** Tabellen tragen keine Dateien – die Daten bleiben, wie sie sind. */
export function verknuepfen(daten, karte) { // eslint-disable-line no-unused-vars
  return daten;
}
