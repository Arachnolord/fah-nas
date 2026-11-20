// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Volle Adresse eines Freigabelinks. Der Agent speichert nur „/link/<token>“; davor kommt die öffentliche Domain, über die
// die Oberfläche zuletzt über den Reverse-Proxy aufgerufen wurde (/api/ich → zugang.link_basis, gelernt im Web-Dienst).
// Nichts ist fest eingetragen: wechselt die Domain, zeigen alle Links die neue Adresse. Ohne gelernte Domain gilt die
// Adresse im Browser.

/** @param {{link_basis?:string}|null} zugang aus /api/ich @param {{url?:string, token?:string}} l Link aus dateien.link.* */
export function linkAdresse(zugang, l) {
  const rel = l && l.url ? l.url : (l && l.token ? `/link/${l.token}` : '');
  if (!rel) return '';
  if (/^https?:\/\//.test(rel)) return rel;
  const basis = zugang && typeof zugang.link_basis === 'string' && /^https?:\/\/[^/\s]+$/.test(zugang.link_basis)
    ? zugang.link_basis : (typeof location !== 'undefined' ? location.origin : '');
  return basis ? new URL(rel, basis).href : rel;
}
