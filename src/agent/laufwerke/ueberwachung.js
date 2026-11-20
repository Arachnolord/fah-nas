// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Überwachung der Laufwerke: startet „udevadm monitor --udev --subsystem-match=block“ (über system.starten) und
// wertet die Zeilen aus (add/remove je Block-Gerät). Als Rückfall (kein udev, Container) läuft alle 15 s ein
// lsblk-Abgleich. Beide Wege rufen die vom Aufrufer übergebenen Rückrufe: `aufEreignis({aktion, geraet})` bei
// einer udev-Zeile und `abgleich()` regelmäßig (Abgleich + Auto-Einhängen). Die eigentliche Fachlogik liegt in
// aktionen/laufwerke.js – hier ist nur die Verkabelung, damit es keinen Ringimport gibt.

const ABGLEICH_MS = 15_000;
const zustand = { laeuft: false, kind: null, intervall: null };

/** Setzt eine udev-monitor-Zeile in {aktion, geraet} um; null, wenn es keine Aktionszeile ist. */
export function parseUdevZeile(zeile) {
  // Beispiel: „UDEV  [12345.678] add      /devices/…/block/sdb/sdb1 (block)“
  const m = /^\s*(?:UDEV|KERNEL)\s*\[[0-9.]+\]\s+(add|remove|change|bind|unbind|move)\s+(\S+)/.exec(String(zeile));
  if (!m) return null;
  const teile = m[2].split('/').filter(Boolean);
  return { aktion: m[1], geraet: teile[teile.length - 1] || m[2] };
}

/** Läuft die Überwachung schon? */
export function laeuft() { return zustand.laeuft; }

/**
 * Startet die Überwachung (einmalig). Optionen:
 *   system      – Kapselung mit `starten(programm, args, optionen)` (spawn).
 *   aufEreignis – async (ereignis) bei jeder udev-Zeile mit Aktion.
 *   abgleich    – async () im 15-s-Takt (Rückfall + Auto-Einhängen).
 * Über FAHNAS_UEBERWACHUNG=0 lässt sich der Start unterdrücken (Tests). Gibt true zurück, wenn gestartet.
 */
export function starten({ system, aufEreignis, abgleich } = {}) {
  if (zustand.laeuft) return false;
  if (process.env.FAHNAS_UEBERWACHUNG === '0') return false;
  zustand.laeuft = true;
  if (system && typeof system.starten === 'function') {
    try {
      const kind = system.starten('udevadm', ['monitor', '--udev', '--subsystem-match=block'], { stdio: ['ignore', 'pipe', 'ignore'] });
      zustand.kind = kind;
      let rest = '';
      if (kind.stdout) {
        kind.stdout.setEncoding('utf8');
        kind.stdout.on('data', (d) => {
          rest += d;
          let i;
          while ((i = rest.indexOf('\n')) >= 0) {
            const z = rest.slice(0, i); rest = rest.slice(i + 1);
            const ev = parseUdevZeile(z);
            if (ev && typeof aufEreignis === 'function') Promise.resolve(aufEreignis(ev)).catch((e) => process.stderr.write(`[laufwerke] Ereignis: ${e.message}\n`));
          }
        });
      }
      if (typeof kind.on === 'function') kind.on('error', (e) => process.stderr.write(`[laufwerke] udevadm nicht verfügbar (${e.message}) – nur 15-s-Abgleich\n`));
    } catch (e) {
      process.stderr.write(`[laufwerke] udevadm konnte nicht gestartet werden: ${e.message}\n`);
    }
  }
  if (typeof abgleich === 'function') {
    zustand.intervall = setInterval(() => { Promise.resolve(abgleich()).catch((e) => process.stderr.write(`[laufwerke] Abgleich: ${e.message}\n`)); }, ABGLEICH_MS);
    if (typeof zustand.intervall.unref === 'function') zustand.intervall.unref();
  }
  return true;
}

/** Beendet die Überwachung (udev-Kind + Takt). */
export function stoppen() {
  if (zustand.intervall) { clearInterval(zustand.intervall); zustand.intervall = null; }
  if (zustand.kind) { try { zustand.kind.kill('SIGTERM'); } catch { /* schon weg */ } zustand.kind = null; }
  zustand.laeuft = false;
}

export const _test = { stoppen, zustand };
