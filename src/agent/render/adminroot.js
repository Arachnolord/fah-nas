// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Admins sind im System root (Betreiber 11.11.2026): „ist ein user admin = sieht er alles // ist es ein normaler
// user = keine root ansicht“. Entschieden wird bei der Anmeldung über die Gruppe fahnas-admin, kein Schalter im Client.
//   - sudoers: %fahnas-admin darf alles ohne Passwort.
//   - sshd: Match Group fahnas-admin → ForceCommand auf den Wrapper. Der startet Shell, Befehle und SFTP über sudo als
//     root. Klappt `sudo -n` nicht, läuft alles wie bisher als der angemeldete Nutzer – so sperrt sich niemand aus.
// Normale NAS-Konten (Gruppe fahnas-sftp) bleiben in ihrer Ansicht eingesperrt (fahnas-sftp.conf, protokolle.js).
// Idempotent: geschrieben und neu geladen wird nur, was sich unterscheidet. Aufruf aus system.apply (auch beim Agent-Start).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { GRUPPE_ADMIN } from './linuxnutzer.js';

export const SFTP_SERVER = '/usr/lib/openssh/sftp-server';

/** Zielpfade, in Tests per Umgebung umbiegbar. */
export const pfade = {
  sudoers: () => process.env.FAHNAS_SUDOERS_ADMIN || '/etc/sudoers.d/fahnas-admin',
  sshd: () => process.env.FAHNAS_SSHD_ADMIN || '/etc/ssh/sshd_config.d/fahnas-admin.conf',
  wrapper: () => process.env.FAHNAS_ADMIN_WRAPPER || '/usr/local/lib/fahnas/admin-als-root',
};

export function sudoersText() {
  return ['# Erzeugt von FAH-NAS – nicht von Hand ändern.',
    '# FAH-NAS-Admins haben im System Root-Rechte (Betreiber 11.11.2026).',
    `%${GRUPPE_ADMIN} ALL=(ALL:ALL) NOPASSWD: ALL`, ''].join('\n');
}

export function sshdText(wrapper = pfade.wrapper()) {
  return ['# Erzeugt von FAH-NAS – nicht von Hand ändern.',
    '# FAH-NAS-Admins arbeiten per SSH und SFTP als root, normale Nutzer nicht (Betreiber 11.11.2026).',
    `Match Group ${GRUPPE_ADMIN}`,
    // Erster Wert gewinnt: ein Admin, der zusätzlich in fahnas-sftp stünde, wird so nie in die Ansicht gesperrt
    '    ChrootDirectory none',
    '    PermitTTY yes',
    '    AllowTcpForwarding yes',
    `    ForceCommand ${wrapper}`,
    'Match all', ''].join('\n');
}

/**
 * Wrapper für die Admin-Anmeldung. SSH_ORIGINAL_COMMAND ist leer (Shell), der SFTP-Server (Subsystem) oder ein Befehl.
 * Neue Dateien per SFTP bekommen umask 0002, damit die Gruppe einer Freigabe weiter schreiben kann.
 * Ubuntu 26.04 nutzt sudo-rs: nur -n, -i und -- verwenden (kein -H; HOME setzt sudo ohnehin auf das Ziel).
 */
export function wrapperText() {
  return [
    '#!/bin/sh',
    '# Erzeugt von FAH-NAS – nicht von Hand ändern.',
    '# FAH-NAS-Admins arbeiten per SSH und SFTP als root (Betreiber 11.11.2026): Shell, Befehle und SFTP laufen über sudo.',
    '# Geht sudo ohne Passwort nicht, läuft alles wie bisher als der angemeldete Nutzer.',
    'befehl=${SSH_ORIGINAL_COMMAND-}',
    `sftp=${SFTP_SERVER}`,
    'shell=$(getent passwd "$(id -un)" | cut -d: -f7)',
    '[ -x "$shell" ] || shell=/bin/sh',
    'if sudo -n true 2>/dev/null; then',
    '  case $befehl in',
    "    '') exec sudo -n -i ;;",
    '    internal-sftp|"internal-sftp "*|"$sftp"|"$sftp "*) exec sudo -n -- "$sftp" -u 0002 ;;',
    '    *) exec sudo -n -- /bin/bash -c "$befehl" ;;',
    '  esac',
    'fi',
    'case $befehl in',
    `  '') exec "$shell" -l ;;`,
    'internal-sftp|"internal-sftp "*|"$sftp"|"$sftp "*) exec "$sftp" ;;',
    '  *) exec "$shell" -c "$befehl" ;;',
    'esac',
    '',
  ].join('\n');
}

const lesen = (ziel) => fs.readFile(ziel, 'utf8').catch(() => null);

async function schreiben(ziel, inhalt, modus) {
  await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o755 });
  await fs.writeFile(ziel, inhalt, { mode: modus });
  await fs.chmod(ziel, modus);
}

/**
 * Bringt Wrapper, sudoers und sshd-Regel auf den Sollstand. Reihenfolge: erst Wrapper und sudoers, dann sshd – so
 * zeigt die Anmeldung nie auf einen Wrapper, der fehlt.
 * @param {{system:{ausfuehren:Function}}} o
 * @returns {Promise<{geaendert:string[]}>}
 */
export async function rendereAdminRoot(o) {
  const { system } = o;
  const geaendert = [];

  const wrapper = pfade.wrapper();
  if ((await lesen(wrapper)) !== wrapperText()) {
    await schreiben(wrapper, wrapperText(), 0o755);
    geaendert.push('wrapper');
  } else {
    await fs.chmod(wrapper, 0o755);
  }

  const sudoers = pfade.sudoers();
  if ((await lesen(sudoers)) !== sudoersText()) {
    // Erst prüfen, dann ablegen. sudo liest in sudoers.d keine Dateien mit Punkt im Namen – die Zwischendatei ist also nie aktiv.
    const zwischen = `${sudoers}.neu`;
    await fs.unlink(zwischen).catch(() => {});
    await schreiben(zwischen, sudoersText(), 0o440);
    try {
      await system.ausfuehren('visudo', ['-c', '-f', zwischen]);
    } catch (e) {
      await fs.unlink(zwischen).catch(() => {});
      throw new FahnasFehler('E_RENDER', 'sudo-Regel für Admins ist ungültig', { ausgabe: e.details?.ausgabe || e.message });
    }
    await fs.rename(zwischen, sudoers);
    geaendert.push('sudoers');
  }

  const sshd = pfade.sshd();
  const vorher = await lesen(sshd);
  if (vorher !== sshdText()) {
    await schreiben(sshd, sshdText(), 0o644);
    try {
      await system.ausfuehren('sshd', ['-t']);
    } catch (e) {
      if (vorher === null) await fs.unlink(sshd).catch(() => {}); else await schreiben(sshd, vorher, 0o644);
      throw new FahnasFehler('E_RENDER', 'SSH-Regel für Admins ist ungültig', { ausgabe: e.details?.ausgabe || e.message });
    }
    try { await system.ausfuehren('systemctl', ['reload', 'ssh.service']); } catch { /* SSH aus: greift beim nächsten Start */ }
    geaendert.push('sshd');
  }
  return { geaendert };
}
