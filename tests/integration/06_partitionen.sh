#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 06: iso/payload/partitionen.sh gegen vier Loop-Images (EFI vfat, swap, System btrfs, Daten btrfs mit
# vorhandenem @shares → Übernahme). Prüft Unterlaufwerke, Verschieben der Wurzel nach @, @log, Standard-Unterlaufwerk,
# chattr +C, fstab-Text, Neu-Einhängung, Idempotenz (zweiter Lauf).
# Ubuntu 26.04, root, Loop-Geräte nötig (--privileged). Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht btrfs losetup mkfs.btrfs mkfs.vfat mkswap blkid lsblk findmnt chattr lsattr
melde "== 06 Partitionen (partitionen.sh) =="
mkdir -p "$IT"
ZIEL="$IT/target"; MNT="$IT/mnt"; LOG="$IT/partitionen.log"
mkdir -p "$ZIEL" "$MNT"

bild() { local name="$1" groesse="$2" g; rm -f "$IT/$name.img"; truncate -s "$groesse" "$IT/$name.img"; g="$(loop_anhaengen "$IT/$name.img")" || return 1; LOOP_GERAETE="$g $LOOP_GERAETE"; printf '%s' "$g"; }
EFI_DEV="$(bild efi 64M)"   && mkfs.vfat -F 32 -n FAHNAS-EFI "$EFI_DEV" >/dev/null 2>&1 || { schlecht "EFI-Image"; ergebnis; }
SWAP_DEV="$(bild swap 64M)" && mkswap -L FAHNAS-SWAP "$SWAP_DEV" >/dev/null 2>&1 || { schlecht "Swap-Image"; ergebnis; }
SYS_DEV="$(bild sys 2G)"    && mkfs.btrfs -q -f -L FAHNAS-SYSTEM "$SYS_DEV" >/dev/null || { schlecht "System-Image"; ergebnis; }
DAT_DEV="$(bild daten 2G)"  && mkfs.btrfs -q -f -L FAHNAS-DATEN "$DAT_DEV" >/dev/null || { schlecht "Daten-Image"; ergebnis; }
ok "Vier Loop-Images: $EFI_DEV $SWAP_DEV $SYS_DEV $DAT_DEV"

# Datenpartition wie nach einer früheren Installation: @shares mit Inhalt, @config mit system.json
mount -t btrfs -o subvolid=5 "$DAT_DEV" "$MNT"; EINHAENGUNGEN="$MNT $EINHAENGUNGEN"
btrfs subvolume create "$MNT/@shares" >/dev/null && mkdir -p "$MNT/@shares/medien" && printf 'alt\n' > "$MNT/@shares/medien/bestand.txt"
btrfs subvolume create "$MNT/@config" >/dev/null && printf '{"hostname":"altnas"}\n' > "$MNT/@config/system.json"
umount "$MNT"; EINHAENGUNGEN="${EINHAENGUNGEN#"$MNT "}"
ok "Datenpartition mit vorhandenem @shares/@config vorbereitet (Übernahme-Fall)"

# Systempartition wie von curtin: Top-Level nach $ZIEL eingehängt, ein „installiertes“ System darin, EFI unter /boot/efi
mount -t btrfs -o subvolid=5 "$SYS_DEV" "$ZIEL"; EINHAENGUNGEN="$ZIEL $EINHAENGUNGEN"
mkdir -p "$ZIEL/etc" "$ZIEL/var/log" "$ZIEL/boot/efi" "$ZIEL/usr/bin" "$ZIEL/home/tester"
printf 'installer-fstab\n' > "$ZIEL/etc/fstab"; printf 'kernel\n' > "$ZIEL/boot/vmlinuz"; printf 'protokoll\n' > "$ZIEL/var/log/installer.log"
printf 'x\n' > "$ZIEL/usr/bin/probe"; printf 'h\n' > "$ZIEL/home/tester/.profile"
mount -t vfat "$EFI_DEV" "$ZIEL/boot/efi"
ok "Ziel wie nach curtin eingehängt ($ZIEL, Top-Level + /boot/efi)"

export FAHNAS_TARGET="$ZIEL" FAHNAS_LOG="$LOG" FAHNAS_MNT="$MNT" FAHNAS_OHNE_GRUB=1
export FAHNAS_SYS_DEV="$SYS_DEV" FAHNAS_DATEN_DEV="$DAT_DEV" FAHNAS_EFI_DEV="$EFI_DEV" FAHNAS_SWAP_DEV="$SWAP_DEV"
pruefe "partitionen.sh läuft durch (erster Lauf)" bash "$WURZEL/iso/payload/partitionen.sh"
[ -f "$LOG" ] && melde "$(sed 's/^/    /' "$LOG" | tail -25)"

# Ergebnis prüfen: Ziel ist jetzt @, Inhalt verschoben, Einhängungen wie im Betrieb
enthaelt "Ziel ist mit subvol=@ eingehängt" 'subvol=/@(,|$)' "$(findmnt -n -o OPTIONS "$ZIEL")"
bedingung "@/etc/fstab vorhanden" -f "$ZIEL/etc/fstab"
bedingung "Installer-fstab gesichert" -f "$ZIEL/etc/fstab.installer"
bedingung "Kernel in @/boot" -f "$ZIEL/boot/vmlinuz"
bedingung "Nutzerdaten in @/home" -f "$ZIEL/home/tester/.profile"
enthaelt "/var/log ist @log" 'subvol=/@log' "$(findmnt -n -o OPTIONS "$ZIEL/var/log")"
bedingung "Protokoll nach @log verschoben" -f "$ZIEL/var/log/installer.log"
enthaelt "/.snapshots ist @snapshots" 'subvol=/@snapshots' "$(findmnt -n -o OPTIONS "$ZIEL/.snapshots")"
enthaelt "/boot/efi ist die EFI-Partition" "$EFI_DEV" "$(findmnt -n -o SOURCE "$ZIEL/boot/efi")"
enthaelt "/data ist Top-Level (subvolid=5)" 'subvolid=5' "$(findmnt -n -o OPTIONS "$ZIEL/data")"
enthaelt "/data/config ist @config" 'subvol=/@config' "$(findmnt -n -o OPTIONS "$ZIEL/data/config")"
enthaelt "/var/lib/docker ist @docker" 'subvol=/@docker' "$(findmnt -n -o OPTIONS "$ZIEL/var/lib/docker")"
enthaelt "/data/vms ist @vms" 'subvol=/@vms' "$(findmnt -n -o OPTIONS "$ZIEL/data/vms")"
enthaelt "/data/shares ist @shares" 'subvol=/@shares' "$(findmnt -n -o OPTIONS "$ZIEL/data/shares")"
enthaelt "/data/backup ist @backup" 'subvol=/@backup' "$(findmnt -n -o OPTIONS "$ZIEL/data/backup")"
enthaelt "/data/apps ist @apps" 'subvol=/@apps' "$(findmnt -n -o OPTIONS "$ZIEL/data/apps")"
enthaelt "/data/.snapshots ist @snapshots_daten" 'subvol=/@snapshots_daten' "$(findmnt -n -o OPTIONS "$ZIEL/data/.snapshots")"
bedingung "Übernahme: bestand.txt in @shares erhalten" -f "$ZIEL/data/shares/medien/bestand.txt"
enthaelt "Übernahme: system.json in @config erhalten" 'altnas' "$(cat "$ZIEL/data/config/system.json")"
enthaelt "chattr +C auf @docker" 'C' "$(lsattr -d "$ZIEL/data/@docker" | awk '{print $1}')"
enthaelt "chattr +C auf @vms" 'C' "$(lsattr -d "$ZIEL/data/@vms" | awk '{print $1}')"
enthaelt "Standard-Unterlaufwerk ist @" 'path @$' "$(btrfs subvolume get-default "$ZIEL")"

UUID_SYS="$(blkid -c /dev/null -s UUID -o value "$SYS_DEV")"; UUID_DAT="$(blkid -c /dev/null -s UUID -o value "$DAT_DEV")"
UUID_EFI="$(blkid -c /dev/null -s UUID -o value "$EFI_DEV")"; UUID_SWAP="$(blkid -c /dev/null -s UUID -o value "$SWAP_DEV")"
FSTAB="$(cat "$ZIEL/etc/fstab")"
enthaelt "fstab: / subvol=@ compress noatime" "UUID=$UUID_SYS  /  btrfs  subvol=@,compress=zstd:1,noatime  0  0" "$FSTAB"
enthaelt "fstab: /boot/efi vfat" "UUID=$UUID_EFI  /boot/efi  vfat  umask=0077  0  1" "$FSTAB"
enthaelt "fstab: /var/log @log" "UUID=$UUID_SYS  /var/log  btrfs  subvol=@log," "$FSTAB"
enthaelt "fstab: /.snapshots @snapshots" "UUID=$UUID_SYS  /.snapshots  btrfs  subvol=@snapshots," "$FSTAB"
enthaelt "fstab: /data subvolid=5" "UUID=$UUID_DAT  /data  btrfs  subvolid=5," "$FSTAB"
enthaelt "fstab: /data/config @config" "UUID=$UUID_DAT  /data/config  btrfs  subvol=@config," "$FSTAB"
# btrfs-Optionen gelten je Dateisystem (erste Einhängung zählt) – deshalb überall dieselben; nodatacow nur per chattr +C
enthaelt "fstab: /var/lib/docker @docker mit denselben Optionen wie der Pool" "UUID=$UUID_DAT  /var/lib/docker  btrfs  subvol=@docker,compress=zstd:1,noatime" "$FSTAB"
enthaelt "fstab: /data/vms @vms mit denselben Optionen wie der Pool" "UUID=$UUID_DAT  /data/vms  btrfs  subvol=@vms,compress=zstd:1,noatime" "$FSTAB"
bedingung "fstab: nirgends nodatacow als Einhängeoption" -z "$(printf '%s\n' "$FSTAB" | grep -v '^#' | grep -F 'nodatacow' || true)"
enthaelt "Alle Einhängungen der Datenpartition tragen compress=zstd:1" 'compress=zstd:1' "$(findmnt -n -o OPTIONS "$ZIEL/var/lib/docker")"
enthaelt "fstab: /data/shares @shares" "UUID=$UUID_DAT  /data/shares  btrfs  subvol=@shares," "$FSTAB"
enthaelt "fstab: /data/backup @backup" "UUID=$UUID_DAT  /data/backup  btrfs  subvol=@backup," "$FSTAB"
enthaelt "fstab: /data/.snapshots @snapshots_daten" "UUID=$UUID_DAT  /data/.snapshots  btrfs  subvol=@snapshots_daten," "$FSTAB"
enthaelt "fstab: swap" "UUID=$UUID_SWAP  none  swap  sw  0  0" "$FSTAB"
bedingung "Protokoll im Ziel abgelegt" -f "$ZIEL/var/log/$(basename "$LOG")"

# Top-Level der Systempartition: nur die drei Unterlaufwerke, nichts vergessen
mount -t btrfs -o subvolid=5 "$SYS_DEV" "$MNT"; EINHAENGUNGEN="$MNT $EINHAENGUNGEN"
REST="$(ls -A "$MNT" | sort | tr '\n' ' ')"
bedingung "Top-Level enthält genau @ @log @snapshots" "$REST" = "@ @log @snapshots "
umount "$MNT"; EINHAENGUNGEN="${EINHAENGUNGEN#"$MNT "}"

# Zweiter Lauf: idempotent
pruefe "partitionen.sh zweiter Lauf (idempotent)" bash "$WURZEL/iso/payload/partitionen.sh"
enthaelt "Zweiter Lauf: Verschieben übersprungen" 'Verschieben übersprungen' "$(cat "$LOG")"
bedingung "Zweiter Lauf: Kernel weiterhin in @/boot" -f "$ZIEL/boot/vmlinuz"
bedingung "Zweiter Lauf: bestand.txt weiterhin da" -f "$ZIEL/data/shares/medien/bestand.txt"

# Aufräumen der Zieleinhängung (Loop-Geräte räumt die EXIT-Falle ab)
umount -R "$ZIEL" 2>/dev/null || true
ergebnis
