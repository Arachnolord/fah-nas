// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Drucken des Dokuments (Plan 05): eine Kopie des Textes ohne Bearbeitungsteile kommt ans Seitenende, `html.od-drucken`
// blendet beim Drucken alles andere aus (Druck-CSS in office.css), danach räumt `afterprint` – spätestens der nächste
// Fokus des Fensters – wieder auf. Auch Strg+P druckt so (beforeprint im Editor).

import { el } from '../../app.js';

/** Druckkopie von `quelle` anlegen → Aufräumer (läuft auch selbst bei afterprint bzw. focus). */
export function druckVorbereiten(quelle, fenster = globalThis) {
  for (const alt of document.body.querySelectorAll('.od-druck')) alt.remove();
  const klon = quelle.cloneNode(true);
  for (const k of [klon, ...klon.querySelectorAll('[contenteditable]')]) k.removeAttribute('contenteditable');
  const kopie = el('div', { class: 'od-druck' }, klon);
  document.body.appendChild(kopie);
  document.documentElement.classList.add('od-drucken');
  let fertig = false;
  const aufraeumen = () => {
    if (fertig) return;
    fertig = true;
    kopie.remove();
    document.documentElement.classList.remove('od-drucken');
    fenster.removeEventListener('afterprint', aufraeumen);
    fenster.removeEventListener('focus', aufraeumen);
  };
  fenster.addEventListener('afterprint', aufraeumen);
  fenster.addEventListener('focus', aufraeumen);
  return aufraeumen;
}

/** Text drucken: Kopie anlegen, Druckdialog öffnen. */
export function drucken(quelle, { fenster = globalThis } = {}) {
  druckVorbereiten(quelle, fenster);
  fenster.print();
}
