// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Registrierung der Ansichten für die Navigation. Der Rahmen filtert nach Rolle und sortiert nach `reihenfolge`.
// Gruppen (Betreiber 12.10.2026: Navigation in Gruppen): Zusammenarbeit (0.21.0), Speicher, Daten, Dienste, Verwaltung –
// Reihenfolge in GRUPPEN.
// Beschriftung: t("navigation.<id>"), Symbol: symbole.svg#symbol-<id>. Die Datei wird erst beim Aufruf geladen.
// Ansichten ohne Navigationsplatz (anmeldung, ersteinrichtung) stehen nicht hier – der Rahmen lädt sie direkt.

export const GRUPPEN = Object.freeze(['zusammenarbeit', 'speicher', 'daten', 'dienste', 'verwaltung']);

export const ANSICHTEN = Object.freeze([
  { id: 'dashboard', datei: 'dashboard.js', rolle: 'nutzer', reihenfolge: 10 },                       // ohne Gruppe, steht oben
  { id: 'chat', datei: 'chat.js', rolle: 'nutzer', reihenfolge: 12, gruppe: 'zusammenarbeit' }, // Chat mit Räumen, DMs, Gästen (0.21.0)
  { id: 'office', datei: 'office.js', rolle: 'nutzer', reihenfolge: 14, gruppe: 'zusammenarbeit' }, // Dokumente, Tabellen, Boards (0.21.0)
  { id: 'dateien', datei: 'dateien.js', rolle: 'nutzer', reihenfolge: 20, gruppe: 'daten' },
  { id: 'apps', datei: 'apps.js', rolle: 'nutzer', reihenfolge: 25, gruppe: 'dienste' },       // Teilprojekt 2: App-Katalog (Docker)
  { id: 'vms', datei: 'vms.js', rolle: 'admin', reihenfolge: 27, gruppe: 'dienste' },          // Teilprojekt 3: virtuelle Maschinen (12.10.2026)
  { id: 'freigaben', datei: 'freigaben.js', rolle: 'nutzer', reihenfolge: 30, gruppe: 'speicher' },
  { id: 'laufwerke', datei: 'laufwerke.js', rolle: 'nutzer', reihenfolge: 29, gruppe: 'speicher' }, // Teilprojekt 2b: externe Laufwerke
  { id: 'nutzer', datei: 'nutzer.js', rolle: 'nutzer', reihenfolge: 40, gruppe: 'verwaltung' },       // Nutzer: „Mein Konto“ (Passwort, 2FA, Sitzungen)
  { id: 'snapshots', datei: 'snapshots.js', rolle: 'nutzer', reihenfolge: 31, gruppe: 'speicher' },
  { id: 'spiegelung', datei: 'spiegelung.js', rolle: 'admin', reihenfolge: 22, gruppe: 'daten' }, // Ordner automatisch abgleichen (11.10.2026)
  { id: 'system', datei: 'system.js', rolle: 'admin', reihenfolge: 60, gruppe: 'verwaltung' },
]);

export default ANSICHTEN;
