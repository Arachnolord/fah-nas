// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einhänge-Optionen und -Befehle je Dateisystem (laut docs/schnittstellen.md §12). Reine Argumentlisten,
// keine Systemaufrufe – der Aufrufer (aktionen/laufwerke.js) führt sie über werkzeuge.system.ausfuehren aus.
//   Basis überall: noatime,nofail,x-fahnas (+ ro bei nur_lesen).
//   Fremd-Dateisysteme ohne POSIX-Rechte (vfat/exfat/ntfs): zusätzlich uid=root,gid=<fahnas-nutzer>,umask=007
//     (Rechte kommen aus der Einhängung, nicht aus ACLs). ntfs zuerst mit dem Kernel-Treiber ntfs3
//     (Option windows_names), bei Fehler Rückfall auf ntfs-3g (FUSE).
//   POSIX-Dateisysteme (ext2/3/4, btrfs, xfs): nur die Basisoptionen; die Rechte setzt der Aufrufer per
//     chown root:fahnas-nutzer + chmod 2770 auf der Wurzel.
//   hfsplus: immer nur lesend (der Kernel-Treiber schreibt nicht zuverlässig).

/** POSIX-Dateisysteme, bei denen ein Rechte-Rundgang (chown/chmod) sinnvoll ist. */
const POSIX = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs']);
/** Alle Dateisysteme, für die es einen Einhänge-Weg gibt. */
export const FS_UNTERSTUETZT = new Set(['ntfs', 'ntfs3', 'exfat', 'vfat', 'fat', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'hfsplus']);

export function istPosix(fs) { return POSIX.has(fs); }
export function wirdUnterstuetzt(fs) { return FS_UNTERSTUETZT.has(fs); }

/** Basisoptionen als Liste (+ ro bei nur_lesen). */
export function basisOptionen({ nur_lesen = false } = {}) {
  const o = ['noatime', 'nofail', 'x-fahnas'];
  if (nur_lesen) o.push('ro');
  return o;
}

/**
 * Liefert die Reihenfolge der Einhänge-Versuche als Argumentlisten (jeweils ohne führendes „mount“-Wort:
 * das erste Element ist „mount“). ntfs hat zwei Versuche (ntfs3, dann ntfs-3g), alles andere genau einen.
 * Leere Liste = nicht unterstütztes Dateisystem.
 */
export function einhaengeVersuche(fs, geraet, ziel, { gid, nur_lesen = false } = {}) {
  const basis = basisOptionen({ nur_lesen });
  const fremd = [...basis, 'uid=root', `gid=${gid}`, 'umask=007'];
  switch (fs) {
    case 'ntfs':
    case 'ntfs3':
      return [
        ['mount', '-t', 'ntfs3', '-o', [...fremd, 'windows_names'].join(','), geraet, ziel],
        ['mount', '-t', 'ntfs-3g', '-o', fremd.join(','), geraet, ziel],
      ];
    case 'exfat':
      return [['mount', '-t', 'exfat', '-o', fremd.join(','), geraet, ziel]];
    case 'vfat':
    case 'fat':
      return [['mount', '-t', 'vfat', '-o', fremd.join(','), geraet, ziel]];
    case 'hfsplus':
      return [['mount', '-t', 'hfsplus', '-o', basisOptionen({ nur_lesen: true }).join(','), geraet, ziel]];
    case 'ext2':
    case 'ext3':
    case 'ext4':
    case 'btrfs':
    case 'xfs':
      return [['mount', '-t', fs, '-o', basis.join(','), geraet, ziel]];
    default:
      return [];
  }
}
