// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Wartung (Betreiber 12.10.2026: „mach alle 8 punkte“) – reine Regeln: Plan der automatischen Prüfungen (SMART-Selbsttest
// wöchentlich kurz, monatlich gründlich; RAID-Datenprüfung monatlich), Auswertung des Selbsttest-Protokolls, Dateien für
// unattended-upgrades und Erkennung schwacher Passwörter.

import { FahnasFehler } from '../../gemeinsam/fehler.js';

const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
const ZEIT = /^([01]\d|2[0-3]):[0-5]\d$/;

export const STANDARD = Object.freeze({
  pruefungen: Object.freeze({ aktiv: true, tag: 0, zeit: '03:30', smart_lang: true, raid: true }),
  auto_updates: Object.freeze({ aktiv: true, umfang: 'sicherheit', zeit: '04:00', neustart: false, neustart_zeit: '04:30' }),
});

/** Gespeicherte/eingegebene Wartungseinstellungen prüfen. */
export function normal(e = {}, { streng = false } = {}) {
  const p = { ...STANDARD.pruefungen, ...((e && e.pruefungen) || {}) };
  const u = { ...STANDARD.auto_updates, ...((e && e.auto_updates) || {}) };
  const zeit = (z, feld, standard) => { if (ZEIT.test(String(z || ''))) return String(z); if (streng) throw fehler('Uhrzeit in der Form 03:30', feld); return standard; };
  if (streng && !(Number.isInteger(p.tag) && p.tag >= 0 && p.tag <= 6)) throw fehler('Wochentag 0 (So) bis 6 (Sa)', 'pruefungen.tag');
  if (streng && !['sicherheit', 'alle'].includes(u.umfang)) throw fehler('Umfang: nur Sicherheitsupdates oder alle', 'auto_updates.umfang');
  return {
    pruefungen: { aktiv: p.aktiv !== false, tag: Number.isInteger(p.tag) && p.tag >= 0 && p.tag <= 6 ? p.tag : 0, zeit: zeit(p.zeit, 'pruefungen.zeit', STANDARD.pruefungen.zeit), smart_lang: p.smart_lang !== false, raid: p.raid !== false },
    auto_updates: { aktiv: u.aktiv !== false, umfang: u.umfang === 'alle' ? 'alle' : 'sicherheit', zeit: zeit(u.zeit, 'auto_updates.zeit', STANDARD.auto_updates.zeit), neustart: u.neustart === true, neustart_zeit: zeit(u.neustart_zeit, 'auto_updates.neustart_zeit', STANDARD.auto_updates.neustart_zeit) },
  };
}

/**
 * Fällige Prüfungen. Wöchentlich am Wochentag zur Uhrzeit ein kurzer Selbsttest; am ersten dieser Wochentage im Monat
 * stattdessen der gründliche (wenn eingeschaltet) und die RAID-Datenprüfung. `letzte` = {smart, raid} (ms) verhindert
 * doppelte Läufe; wer den Zeitpunkt verpasst (NAS aus), bekommt die Prüfung bis zum Tagesende nachgeholt.
 * @returns {Array<'smart_kurz'|'smart_lang'|'raid'>}
 */
export function faellig(plan, letzte = {}, jetzt = new Date()) {
  if (!plan || !plan.aktiv || jetzt.getDay() !== plan.tag) return [];
  const [h, m] = plan.zeit.split(':').map(Number);
  const slot = new Date(jetzt); slot.setHours(h, m, 0, 0);
  if (jetzt < slot) return [];
  const ersterImMonat = jetzt.getDate() <= 7;
  const aus = [];
  if ((letzte.smart || 0) < slot.getTime()) aus.push(ersterImMonat && plan.smart_lang ? 'smart_lang' : 'smart_kurz');
  if (ersterImMonat && plan.raid && (letzte.raid || 0) < slot.getTime()) aus.push('raid');
  return aus;
}

/** Nächster Prüftermin (für die Oberfläche). */
export function naechsterTermin(plan, jetzt = new Date()) {
  if (!plan || !plan.aktiv) return null;
  const [h, m] = plan.zeit.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(jetzt); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d.getDay() === plan.tag && d > jetzt) return { zeit: d.toISOString(), art: d.getDate() <= 7 && plan.smart_lang ? 'smart_lang' : 'smart_kurz' };
  }
  return null;
}

/**
 * Letzten Eintrag des Selbsttest-Protokolls lesen (smartctl -j -l selftest): {laeuft, bestanden, text, prozent_rest}.
 * ATA: ata_smart_self_test_log.standard.table[0] + ata_smart_data.self_test.status; NVMe: nvme_self_test_log.
 */
export function selbsttestAuswerten(json) {
  if (!json || typeof json !== 'object') return { laeuft: false, bestanden: null, text: 'Protokoll nicht lesbar' };
  const lauf = json.ata_smart_data && json.ata_smart_data.self_test && json.ata_smart_data.self_test.status;
  if (lauf && typeof lauf.value === 'number' && lauf.value >= 241 && lauf.value <= 249) return { laeuft: true, bestanden: null, text: lauf.string || 'läuft', prozent_rest: lauf.remaining_percent ?? null };
  const nvme = json.nvme_self_test_log;
  if (nvme && nvme.current_self_test_operation && nvme.current_self_test_operation.value) return { laeuft: true, bestanden: null, text: nvme.current_self_test_operation.string || 'läuft', prozent_rest: nvme.current_self_test_completion_percent != null ? 100 - nvme.current_self_test_completion_percent : null };
  const ata = json.ata_smart_self_test_log && json.ata_smart_self_test_log.standard && Array.isArray(json.ata_smart_self_test_log.standard.table) ? json.ata_smart_self_test_log.standard.table[0] : null;
  if (ata && ata.status) return { laeuft: false, bestanden: ata.status.passed !== false, text: `${(ata.type && ata.type.string) || ''}: ${ata.status.string || ''}`.trim(), stunden: ata.lifetime_hours ?? null };
  const n0 = nvme && Array.isArray(nvme.table) ? nvme.table[0] : null;
  if (n0 && n0.self_test_result) return { laeuft: false, bestanden: n0.self_test_result.value === 0, text: `${(n0.self_test_code && n0.self_test_code.string) || ''}: ${n0.self_test_result.string || ''}`.trim(), stunden: n0.power_on_hours ?? null };
  return { laeuft: false, bestanden: null, text: 'Kein Selbsttest im Protokoll' };
}

/** apt.conf.d-Dateien und Timer für unattended-upgrades. */
export function autoUpdateDateien(u) {
  const periodic = `// FAH-NAS: automatische Updates (System → Wartung) – wird überschrieben\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "${u.aktiv ? 1 : 0}";\n`;
  let unattended = `// FAH-NAS: automatische Updates (System → Wartung) – wird überschrieben\nUnattended-Upgrade::Automatic-Reboot "${u.neustart ? 'true' : 'false'}";\nUnattended-Upgrade::Automatic-Reboot-Time "${u.neustart_zeit}";\nUnattended-Upgrade::Remove-Unused-Kernel-Packages "true";\n`;
  if (u.umfang === 'alle') unattended += 'Unattended-Upgrade::Allowed-Origins {\n\t"${distro_id}:${distro_codename}-updates";\n};\n';
  const timer = `# FAH-NAS: Zeitpunkt der automatischen Updates\n[Timer]\nOnCalendar=\nOnCalendar=*-*-* ${u.zeit}:00\nRandomizedDelaySec=0\nPersistent=true\n`;
  return { periodic, unattended, timer };
}

/** Letzter Lauf aus /var/log/unattended-upgrades/unattended-upgrades.log: {zeit, text}. */
export function letzterUpdateLauf(log) {
  const zeilen = String(log || '').split('\n').filter(Boolean);
  let start = -1;
  for (let i = zeilen.length - 1; i >= 0; i--) if (/Starting unattended upgrades script/.test(zeilen[i])) { start = i; break; }
  if (start < 0) return null;
  const zeit = (/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(zeilen[start]) || [])[1] || null;
  const rest = zeilen.slice(start + 1).map((z) => z.replace(/^\S+ \S+ \w+ /, ''));
  const pakete = rest.find((z) => /^Packages that will be upgraded:/.test(z));
  const text = pakete ? pakete.replace('Packages that will be upgraded:', 'Eingespielt:').trim()
    : rest.some((z) => /No packages found that can be upgraded/.test(z)) ? 'Nichts zu tun' : (rest.find((z) => /ERROR|error/.test(z)) || rest[rest.length - 1] || '');
  return { zeit: zeit ? new Date(zeit.replace(' ', 'T')).toISOString() : null, text, fehler: rest.some((z) => /ERROR/.test(z)) };
}

const SCHWACH = ['admin', 'administrator', 'password', 'passwort', 'changeme', 'change_me', 'secret', 'geheim', 'test', 'root', 'default', 'qwerty', 'letmein', 'welcome', 'fahnas'];
/** Schwacher App-Wert? (zu kurz, Liste, nur Ziffern, Benutzername) */
export function schwachesPasswort(wert, { name = '' } = {}) {
  const w = String(wert ?? '').trim();
  if (!w) return false;
  const k = w.toLowerCase();
  return w.length < 8 || SCHWACH.includes(k) || /^\d+$/.test(w) || /^(.)\1+$/.test(w) || (!!name && k === String(name).toLowerCase());
}
/** Kandidaten, die gegen die Anmelde-Hashes geprüft werden (wenige, scrypt ist teuer). */
export function einfachePasswoerter(name) {
  return [...new Set(['admin', 'password', 'passwort', '12345678', '123456789', 'qwertz123', 'qwerty123', 'fahnas', 'changeme', name, `${name}123`, `${name}1234`])].filter((x) => x && x.length >= 6);
}

/** .env-Zeilen → {KEY: wert} (ohne Anführungszeichen). */
export function envLesen(text) {
  const aus = {};
  for (const z of String(text || '').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(z);
    if (m) aus[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return aus;
}
export const GEHEIM_SCHLUESSEL = /(PASS(WORD|WD)?|PWD|SECRET|TOKEN|API_?KEY)/i;
