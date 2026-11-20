// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Erkennung externer Laufwerke aus der JSON-Ausgabe von lsblk. Bestimmt je nutzbarem Dateisystem
// (Partition oder ganze Platte) einen Eintrag mit stabiler Kennung (UUID > PARTUUID > SERIAL+PARTN),
// erkennt die Systemplatte (FAHNAS-*-Label oder System-Einhängepunkt → nie anfassbar) und schlägt aus dem
// Label (sonst Modell/Anschluss) einen bereinigten Freigabenamen vor. Keine Systemaufrufe – reine Auswertung.

/** Partitionslabels der Systemplatte (vom Installer vergeben). Ihre Platte wird nie angefasst. */
export const SYSTEM_LABELS = new Set(['FAHNAS-EFI', 'FAHNAS-SWAP', 'FAHNAS-SYSTEM', 'FAHNAS-DATEN']);
// Einhängepunkte des laufenden Systems – GENAUE Übereinstimmung (kein Präfix!): externe Laufwerke hängen unter
// PFADE.shares (/data/shares/<name>), also unter „/data“ – ein Präfixvergleich würde sie fälschlich zur Systemplatte
// zählen und unauswerfbar machen. Die Systemplatte wird ohnehin sicher an ihren FAHNAS-*-Labels erkannt.
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/efi', '/var', '/var/log', '/.snapshots', '/data', '/usr', '/home']);
/** Gerätenamen, die nie ein externes Laufwerk sind (Schleifen, RAM, optische Laufwerke). */
const NICHT_PLATTE = /^(loop|zram|sr|ram|fd)/;
/** Freigabename: klein, 1–32 Zeichen aus a-z, 0-9, - und _. */
export const NAME_MUSTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Dateisysteme, die als „nutzbar“ gelten (Rest wird zwar gelistet, aber als fs=null behandelt). */
const NUTZBARE_FS = new Set(['ntfs', 'ntfs3', 'exfat', 'vfat', 'fat', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'hfsplus']);

function zahl(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/** Ist der Einhängepunkt einer des laufenden Systems? */
function istSystemMount(mp) {
  if (!mp) return false;
  if (mp === '[SWAP]') return true;
  return SYSTEM_MOUNTS.has(mp);
}

/** Gehört die ganze Platte (mit allen Partitionen) zum laufenden System? */
export function plattenIstSystem(disk) {
  const alle = [disk, ...(disk.children || [])];
  return alle.some((d) => (d && d.label && SYSTEM_LABELS.has(d.label)) || istSystemMount(d && d.mountpoint));
}

/** Stabile Kennung eines Dateisystems: UUID > PARTUUID > SERIAL+PARTN (mit Vorsilbe, damit eindeutig). */
export function kennungVon({ uuid, partuuid, serial, partn } = {}) {
  if (uuid) return `uuid:${uuid}`;
  if (partuuid) return `partuuid:${partuuid}`;
  if (serial) return `serial:${serial}:${partn ?? 0}`;
  return null;
}

/** Bereinigt einen Text zu einem Namensbestandteil (klein, nur a-z0-9-, ohne Rand-Bindestriche). */
function bereinige(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // Akzente entfernen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Schlägt einen Freigabenamen vor: aus dem Label, sonst „<anschluss>-<modell>“, sonst „<anschluss>-laufwerk“.
 * `belegt` (Set bereits vergebener Namen) sorgt für ein Suffix bei Kollision.
 */
export function nameVorschlag(eintrag, belegt = new Set()) {
  let basis = bereinige(eintrag.label);
  if (!basis) {
    const modell = bereinige(eintrag.modell);
    const anschluss = bereinige(eintrag.tran) || 'usb';
    basis = modell ? `${anschluss}-${modell}` : `${anschluss}-laufwerk`;
  }
  basis = basis.slice(0, 32).replace(/[-_]+$/, '');
  if (!/^[a-z0-9]/.test(basis)) basis = ('d' + basis).slice(0, 32);
  if (!basis) basis = 'laufwerk';
  let name = basis;
  let i = 2;
  while (belegt.has(name)) {
    const suffix = '-' + i;
    name = basis.slice(0, 32 - suffix.length).replace(/[-_]+$/, '') + suffix;
    i++;
  }
  return name;
}

/** Erzeugt aus Platte + Blatt (Partition oder Platte selbst) einen Laufwerkseintrag. */
function baueEintrag(disk, blatt, system) {
  const istPlatteSelbst = blatt === disk;
  const partn = istPlatteSelbst ? null : (blatt.partn ?? null);
  const fsRoh = blatt.fstype || null;
  const fs = fsRoh && NUTZBARE_FS.has(fsRoh) ? fsRoh : null;
  const mp = blatt.mountpoint || null;
  return {
    pfad: blatt.path,
    platte: disk.path,
    kennung: kennungVon({ uuid: blatt.uuid, partuuid: blatt.partuuid, serial: disk.serial, partn }),
    fs,
    fs_roh: fsRoh,
    label: blatt.label || null,
    modell: (disk.model || '').trim() || null,
    seriennummer: disk.serial || null,
    groesse: zahl(blatt.size),
    tran: disk.tran || null,
    entfernbar: blatt.rm === true || disk.rm === true,
    einhaengepunkt: mp === '[SWAP]' ? null : mp,
    eingehaengt: !!mp && mp !== '[SWAP]',
    belegt: zahl(blatt.fsused),
    frei: zahl(blatt.fsavail),
    system,
    partn,
  };
}

/**
 * Wertet die JSON-Ausgabe von `lsblk -J -b -o …` aus und liefert eine Liste von Laufwerkseinträgen
 * (je nutzbarem Dateisystem einer). Schleifen-/RAM-/optische Geräte werden übersprungen; mit gesetzter
 * Umgebungsvariable `FAHNAS_LAUFWERKE_TEST_LOOPS=1` gelten Loop-Geräte (außer squashfs) als externe Platten,
 * damit der Integrationstest mit Loop-Images arbeiten kann.
 */
export function geraeteLesen(json) {
  const erlaubeLoop = process.env.FAHNAS_LAUFWERKE_TEST_LOOPS === '1';
  const geraete = (json && Array.isArray(json.blockdevices) ? json.blockdevices : []).filter((d) => {
    if (!d || typeof d.name !== 'string') return false;
    if (d.type === 'disk' && !NICHT_PLATTE.test(d.name)) return true;
    if (erlaubeLoop && d.type === 'loop' && d.fstype !== 'squashfs') return true;
    return false;
  });
  const aus = [];
  for (const disk of geraete) {
    // Platten eines RAID-Verbunds gehören nicht zu den einzeln einhängbaren Laufwerken
    if (disk.fstype === 'linux_raid_member' || (disk.children || []).some((c) => c && /^raid/.test(c.type || ''))) continue;
    const system = plattenIstSystem(disk);
    const kinder = (disk.children || []).filter((c) => c && c.type === 'part');
    const blaetter = kinder.length ? kinder : [disk];
    for (const blatt of blaetter) aus.push(baueEintrag(disk, blatt, system));
  }
  return aus;
}
