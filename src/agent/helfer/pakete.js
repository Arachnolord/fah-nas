// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Pakete bei Bedarf nachinstallieren (Ausbau Oktober 2026): Funktionen wie VPN, USV oder NFS brauchen Ubuntu-Pakete, die
// ältere Installationen nicht haben. Installiert wird erst, wenn der Betreiber die Funktion einschaltet – als eigene
// systemd-Unit (systemd-run --wait), damit apt bei einem Neustart des Steuerdienstes nicht mittendrin abbricht.

import { FahnasFehler } from '../../gemeinsam/fehler.js';

const UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' });
const NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
const ZEITLIMIT_MS = 20 * 60_000;

/** Welche der Pakete fehlen? (dpkg-query; unbekannte Pakete gelten als fehlend) */
export async function paketeFehlend(system, pakete) {
  const fehlend = [];
  for (const p of pakete) {
    if (!NAME.test(p)) throw new FahnasFehler('E_PARAMS', `Paketname ungültig: ${p}`);
    let status = '';
    try { status = String((await system.ausfuehren('dpkg-query', ['-W', '-f=${Status}', p], { umgebung: UMGEBUNG, erlaubteCodes: [0, 1], zeitlimit_ms: 20_000 })).stdout || ''); } catch { status = ''; }
    if (!/install ok installed/.test(status)) fehlend.push(p);
  }
  return fehlend;
}

/** Befehlszeile für systemd-run (rein, für Tests). */
export function installationsArgumente(fehlend, unit) {
  const apt = 'apt-get -o DPkg::Lock::Timeout=300 -q';
  return [`--unit=${unit}`, '--wait', '--collect', '--quiet', '--setenv=DEBIAN_FRONTEND=noninteractive', '/bin/sh', '-c',
    `${apt} update && ${apt} -y -o Dpkg::Options::=--force-confold install ${fehlend.join(' ')}`];
}

/**
 * Fehlende Pakete installieren. `fortschritt(text)` meldet den Schritt. Gibt die installierten Pakete zurück (leer =
 * war schon alles da). Wirft E_SYSTEM mit verständlichem Text, wenn apt scheitert (meist: kein Internet).
 */
export async function paketeSicherstellen(system, pakete, { fortschritt, zweck = 'diese Funktion' } = {}) {
  const fehlend = await paketeFehlend(system, pakete);
  if (!fehlend.length) return [];
  fortschritt?.(`Installiere ${fehlend.join(', ')} …`);
  const unit = `fahnas-pakete-${Date.now()}`;
  try {
    await system.ausfuehren('systemd-run', installationsArgumente(fehlend, unit), { umgebung: UMGEBUNG, zeitlimit_ms: ZEITLIMIT_MS });
  } catch (e) {
    const f = FahnasFehler.aus(e);
    throw new FahnasFehler('E_SYSTEM', `Für ${zweck} fehlen Pakete (${fehlend.join(', ')}), die sich nicht installieren ließen – hat das NAS Internet? Einzelheiten: journalctl -u ${unit}`, { ausgabe: f.details?.ausgabe || f.message });
  }
  const rest = await paketeFehlend(system, fehlend);
  if (rest.length) throw new FahnasFehler('E_SYSTEM', `Pakete fehlen weiterhin: ${rest.join(', ')}`);
  return fehlend;
}
