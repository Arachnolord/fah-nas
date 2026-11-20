// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Zugriffsregel (V14): Recht über die Freigabe des Aufrufers oder über eine Office-Freigabe genau dieses
// Bündels – das höhere Recht gewinnt. Über eine Office-Freigabe arbeitet der Dateihelfer als Besitzer, und nur so
// weit, wie der Besitzer selbst noch darf. Wer gar kein Recht hat, erfährt nicht, dass es das Dokument gibt.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { freigabeRechte, freigabeHolen, pfadVorpruefen } from '../aktionen/dateien.js';
import { indexLaden, eintragAmOrt, eigen } from './index.js';

const STAERKE = { lesen: 1, bearbeiten: 2 };
/** Ist Recht a stärker als Recht b? (null = kein Recht) */
export const staerker = (a, b) => (STAERKE[a] || 0) > (STAERKE[b] || 0);
/** Ergebnis von freigabeRechte als 'bearbeiten' | 'lesen' | null. */
export const rechtAus = (r) => (r.schreiben ? 'bearbeiten' : r.lesen ? 'lesen' : null);
const gibtsNicht = (details) => new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Dokument gibt es nicht', details);

/** Nutzerdatensatz aus users.json oder null. */
export async function nutzerDatensatz(w, name) {
  const users = await w.konfig.laden('users.json');
  return (users?.nutzer || []).find((n) => n.name === name) || null;
}

/**
 * Das höhere Recht aus Freigabe und Office-Freigabe, ohne Fehler: {recht, ueber, als, sperre}. Über die Office-Freigabe
 * zählt nur, was der Besitzer selbst noch darf; `sperre` sagt, warum dieser Weg ausfiel ('besitzer_inaktiv' |
 * 'besitzer_ohne_recht'). `rechtVon(freigabe, kontext)` → Recht oder null, `besitzerVon(name)` → Datensatz oder null.
 */
export async function rechtErmitteln(eintrag, kontext, { rechtVon, besitzerVon }) {
  const rf = await rechtVon(eintrag.freigabe, kontext);
  const nurFreigabe = (sperre = null) => ({ recht: rf, ueber: 'freigabe', als: kontext, sperre });
  let ro = eigen(eintrag.freigaben, kontext.nutzer) ?? null;
  if (!staerker(ro, rf)) return nurFreigabe();
  const b = await besitzerVon(eintrag.besitzer);
  if (!b || b.gesperrt) return nurFreigabe('besitzer_inaktiv');
  const als = { nutzer: b.name, rolle: b.rolle, ip: kontext.ip };
  const fb = await rechtVon(eintrag.freigabe, als);
  if (!fb) return nurFreigabe('besitzer_ohne_recht');
  if (ro === 'bearbeiten' && fb !== 'bearbeiten') ro = 'lesen';
  return staerker(ro, rf) ? { recht: ro, ueber: 'office', als, sperre: null } : nurFreigabe();
}

/**
 * Prüft den Zugriff auf ein Office-Dokument über `id` oder über den Ort (`freigabe` + `pfad`, Eintrag darf fehlen).
 * Ergebnis: { eintrag, recht: 'lesen'|'bearbeiten', als (Kontext für den Dateihelfer), ueber: 'freigabe'|'office',
 * wurzel, rel }. Mit `schreiben` wirft „nur lesen“ E_RECHTE.
 */
export async function officeZugriff(w, { id, freigabe, pfad } = {}, kontext, { schreiben = false } = {}) {
  const nurLesen = () => new FahnasFehler('E_RECHTE', 'Du darfst dieses Dokument nur lesen');
  const index = await indexLaden(w);
  let eintrag;
  if (id) {
    eintrag = index.dokumente[id];
    if (!eintrag) throw gibtsNicht();
    if (eintrag.geloescht) throw gibtsNicht({ office: 'geloescht' });
  } else if (freigabe && pfad) {
    const r = await freigabeHolen(w, freigabe, kontext);
    const { rel } = await pfadVorpruefen(r.wurzel, pfad);
    eintrag = eintragAmOrt(index, freigabe, rel);
    if (!eintrag) {
      const recht = rechtAus(r);
      if (schreiben && recht !== 'bearbeiten') throw nurLesen();
      return { eintrag: null, recht, als: kontext, ueber: 'freigabe', wurzel: r.wurzel, rel };
    }
  } else {
    throw new FahnasFehler('E_PARAMS', 'Dokument-ID fehlt', { feld: 'id' });
  }

  let fr;
  try { fr = await freigabeRechte(w, eintrag.freigabe, kontext); } catch (f) {
    if (f instanceof FahnasFehler && f.code === 'E_NICHT_GEFUNDEN') throw gibtsNicht(); // Freigabe gibt es nicht mehr
    throw f;
  }
  const rechtVon = async (name, k) => {
    if (k === kontext) return rechtAus(fr);
    try { return rechtAus(await freigabeRechte(w, name, k)); } catch (f) { if (f instanceof FahnasFehler && f.code === 'E_NICHT_GEFUNDEN') return null; throw f; }
  };
  const r = await rechtErmitteln(eintrag, kontext, { rechtVon, besitzerVon: (n) => nutzerDatensatz(w, n) });
  if (!r.recht) {
    if (r.sperre === 'besitzer_inaktiv') throw new FahnasFehler('E_RECHTE', 'Der Besitzer dieses Dokuments ist nicht mehr aktiv');
    if (r.sperre === 'besitzer_ohne_recht') throw new FahnasFehler('E_RECHTE', 'Der Besitzer dieses Dokuments hat keinen Zugriff mehr darauf');
    throw gibtsNicht();
  }
  if (schreiben && r.recht !== 'bearbeiten') throw nurLesen();
  return { eintrag, recht: r.recht, als: r.als, ueber: r.ueber, wurzel: fr.wurzel, rel: eintrag.pfad };
}
