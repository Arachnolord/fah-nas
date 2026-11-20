// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// SSH-Port (Betreiber 11.11.2026: „fah-nas soll nicht den standard ssh port haben“). Ubuntu startet sshd über
// ssh.socket – der Port steht deshalb an zwei Stellen: im Socket (wer lauscht) und in sshd_config (falls sshd ohne
// Socket läuft). Port 22 = Ubuntus Standard, beide Dateien entfallen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const STANDARD_PORT = 22;
/** Ports, die FAH-NAS selbst belegt oder die als SSH-Port in die Irre führen. */
export const BELEGT = Object.freeze([80, 443, 445, 5353, 8443]);

export const pfade = {
  sshd: () => process.env.FAHNAS_SSHD_PORT || '/etc/ssh/sshd_config.d/fahnas-port.conf',
  socket: () => process.env.FAHNAS_SSH_SOCKET || '/etc/systemd/system/ssh.socket.d/fahnas-port.conf',
};

/** Prüft den Port: 22 oder 1024–65535, nicht von FAH-NAS belegt. */
export function pruefeSshPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || (p !== STANDARD_PORT && (p < 1024 || p > 65535)) || BELEGT.includes(p)) {
    throw new FahnasFehler('E_PARAMS', 'SSH-Port: 22 oder 1024–65535, nicht 8443 und keiner, den FAH-NAS selbst nutzt', { feld: 'ssh_port' });
  }
  return p;
}

export function sshdText(port) {
  return `# Erzeugt von FAH-NAS (System → Dienste → SSH) – nicht von Hand ändern.\nPort ${port}\n`;
}

export function socketText(port) {
  // IPv4 und IPv6 getrennt binden (wie Ubuntus ssh.socket) – sonst kollidiert [::]:P mit 0.0.0.0:P
  return ['# Erzeugt von FAH-NAS (System → Dienste → SSH) – nicht von Hand ändern.', '[Socket]', 'BindIPv6Only=ipv6-only', 'ListenStream=',
    `ListenStream=0.0.0.0:${port}`, `ListenStream=[::]:${port}`, ''].join('\n');
}

const lesen = (ziel) => fs.readFile(ziel, 'utf8').catch(() => null);
async function setzen(ziel, inhalt) {
  if (inhalt === null) { await fs.unlink(ziel).catch(() => {}); return; }
  await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o755 });
  await fs.writeFile(ziel, inhalt, { mode: 0o644 });
}

/**
 * Bringt sshd und ssh.socket auf den Port. Erst `sshd -t`, dann Socket neu laden; bestehende Sitzungen bleiben offen.
 * @param {number} port
 * try-restart: läuft SSH gerade nicht (aus), greift der neue Port beim nächsten Einschalten – daemon-reload ist schon gelaufen.
 * @param {{system:{ausfuehren:Function}}} o
 * @returns {Promise<{port:number, geaendert:boolean}>}
 */
export async function rendereSshPort(port, o) {
  const p = pruefeSshPort(port);
  const { system } = o;
  const sollSshd = p === STANDARD_PORT ? null : sshdText(p);
  const sollSocket = p === STANDARD_PORT ? null : socketText(p);
  const altSshd = await lesen(pfade.sshd());
  const altSocket = await lesen(pfade.socket());
  if (altSshd === sollSshd && altSocket === sollSocket) return { port: p, geaendert: false };

  await setzen(pfade.sshd(), sollSshd);
  try {
    await system.ausfuehren('sshd', ['-t']);
  } catch (e) {
    await setzen(pfade.sshd(), altSshd);
    throw new FahnasFehler('E_RENDER', 'SSH-Port: sshd lehnt die Einstellung ab', { ausgabe: e.details?.ausgabe || e.message });
  }
  await setzen(pfade.socket(), sollSocket);
  try {
    await system.ausfuehren('systemctl', ['daemon-reload']);
    await system.ausfuehren('systemctl', ['try-restart', 'ssh.socket']);
    await system.ausfuehren('systemctl', ['try-restart', 'ssh.service']);
  } catch (e) {
    // Zurück auf den alten Stand, damit SSH nicht auf einem halben Wechsel stehen bleibt
    await setzen(pfade.sshd(), altSshd);
    await setzen(pfade.socket(), altSocket);
    try {
      await system.ausfuehren('systemctl', ['daemon-reload']);
      await system.ausfuehren('systemctl', ['try-restart', 'ssh.socket']);
    } catch { /* bestmöglich */ }
    throw new FahnasFehler('E_RENDER', 'SSH-Port konnte nicht umgestellt werden', { ausgabe: e.details?.ausgabe || e.message });
  }
  return { port: p, geaendert: true };
}
