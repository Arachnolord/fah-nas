#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# FAH-NAS Installer – late-command: btrfs-Unterlaufwerke anlegen, die frisch installierte Wurzel nach @ verschieben,
# /etc/fstab schreiben, GRUB im Ziel neu erzeugen. Läuft in der Installer-Umgebung mit dem Ziel unter /target
# (curtin hat Partition 3 als Top-Level-Unterlaufwerk nach /target eingehängt, dazu /target/boot/efi).
#
# Warum: subiquity/curtin kann btrfs formatieren, aber keine Unterlaufwerke anlegen (offener Fehler seit 2023).
#
# System (FAHNAS-SYSTEM):  @ (/ inkl. /boot)   @log (/var/log)   @snapshots (/.snapshots, snapper)
# Daten  (FAHNAS-DATEN):   Top-Level → /data (subvolid=5, Verwaltung)   @config @docker @apps @vms @shares @backup
#                          @snapshots_daten (/data/.snapshots) – vorhandene Unterlaufwerke werden ÜBERNOMMEN.
# btrfs-Einhängeoptionen (compress, nodatacow …) gelten je DATEISYSTEM, nicht je Unterlaufwerk: „only options in the
# first mounted subvolume will take effect“ (btrfs(5)). Deshalb tragen ALLE fstab-Zeilen einer Partition dieselben
# Optionen; stünde „nodatacow“ nur an @docker/@vms, gewänne je Startreihenfolge mal diese, mal jene Zeile – und
# „nodatacow“ schaltet für den ganzen Pool Prüfsummen und Kompression ab. Kein Copy-on-Write für @docker/@vms kommt
# ausschließlich von „chattr +C“ auf dem leeren Unterlaufwerk (wirkt auf alles, was darin neu entsteht).
#
# Umgebung (für Tests/Reparatur): FAHNAS_TARGET (/target), FAHNAS_LOG, FAHNAS_MNT (/mnt/fahnas), FAHNAS_OHNE_GRUB=1
# (kein GRUB, EFI/Auslagerung optional), FAHNAS_SYS_DEV/FAHNAS_DATEN_DEV/FAHNAS_EFI_DEV/FAHNAS_SWAP_DEV (statt Label-Suche).
# Aufruf „partitionen.sh --fstab-test“ erzeugt nur den fstab-Text aus UUID_SYS/UUID_DATEN/UUID_EFI/UUID_SWAP (Einheitstest).
# Idempotent: Fertig-Kriterium für den Umzug nach @ ist „das Top-Level enthält nur noch @*“; ein zweiter (oder nach
# Abbruch wiederholter) Lauf setzt den Umzug fort bzw. überspringt ihn und schreibt fstab/GRUB erneut.
set -euo pipefail

TARGET="${FAHNAS_TARGET:-/target}"
LOG="${FAHNAS_LOG:-/var/log/fahnas-partitionen.log}"
MNT="${FAHNAS_MNT:-/mnt/fahnas}"
OHNE_GRUB="${FAHNAS_OHNE_GRUB:-0}"
LABEL_SYS="FAHNAS-SYSTEM"
LABEL_DATEN="FAHNAS-DATEN"
LABEL_EFI="FAHNAS-EFI"
LABEL_SWAP="FAHNAS-SWAP"
OPT_BTRFS="compress=zstd:1,noatime"
DATEN_SUBVOLS="@config @docker @apps @vms @shares @backup @snapshots_daten"
UUID_SYS="${UUID_SYS:-}"; UUID_DATEN="${UUID_DATEN:-}"; UUID_EFI="${UUID_EFI:-}"; UUID_SWAP="${UUID_SWAP:-}"
CHROOT_BINDS=""

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fehler() { log "FEHLER: $*"; exit 1; }

# --- fstab: eine Zeile je Einhängung, dieselbe Liste dient dem Einhängen (Gerät|UUID|Ziel|Typ|Optionen|dump|pass) ------
SYS="${FAHNAS_SYS_DEV:-}"; DATEN="${FAHNAS_DATEN_DEV:-}"; EFI="${FAHNAS_EFI_DEV-}"; SWAP="${FAHNAS_SWAP_DEV-}"
einhaengungen() {
    echo "$SYS|$UUID_SYS|/|btrfs|subvol=@,$OPT_BTRFS|0|0"
    [ -n "$UUID_EFI" ] && echo "$EFI|$UUID_EFI|/boot/efi|vfat|umask=0077|0|1"
    echo "$SYS|$UUID_SYS|/var/log|btrfs|subvol=@log,$OPT_BTRFS|0|0"
    echo "$SYS|$UUID_SYS|/.snapshots|btrfs|subvol=@snapshots,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data|btrfs|subvolid=5,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/config|btrfs|subvol=@config,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/var/lib/docker|btrfs|subvol=@docker,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/apps|btrfs|subvol=@apps,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/vms|btrfs|subvol=@vms,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/shares|btrfs|subvol=@shares,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/backup|btrfs|subvol=@backup,$OPT_BTRFS|0|0"
    echo "$DATEN|$UUID_DATEN|/data/.snapshots|btrfs|subvol=@snapshots_daten,$OPT_BTRFS|0|0"
    return 0
}

fstab_text() {
    echo "# /etc/fstab – erzeugt von FAH-NAS (iso/payload/partitionen.sh). Nicht von Hand ändern."
    echo "# System: btrfs FAHNAS-SYSTEM (@ = Wurzel inkl. /boot, @log, @snapshots) · Daten: btrfs FAHNAS-DATEN (Top-Level unter /data)."
    echo "# btrfs-Optionen (compress, nodatacow …) gelten je DATEISYSTEM ab der ersten Einhängung, nicht je Unterlaufwerk (btrfs(5)):"
    echo "# deshalb haben alle Zeilen einer Partition dieselben Optionen. Kein Copy-on-Write für @docker/@vms kommt von „chattr +C“"
    echo "# auf dem Unterlaufwerk – NICHT als Einhängeoption eintragen (schaltete Prüfsummen und Kompression für den ganzen Pool ab)."
    echo "# <Gerät>  <Einhängepunkt>  <Typ>  <Optionen>  <dump>  <pass>"
    einhaengungen | while IFS='|' read -r _geraet uuid ziel typ optionen dump pass; do
        printf 'UUID=%s  %s  %s  %s  %s  %s\n' "$uuid" "$ziel" "$typ" "$optionen" "$dump" "$pass"
    done
    if [ -n "$UUID_SWAP" ]; then
        printf 'UUID=%s  none  swap  sw  0  0\n' "$UUID_SWAP"
    fi
}

if [ "${1:-}" = "--fstab-test" ]; then
    [ -n "$UUID_SYS" ] && [ -n "$UUID_DATEN" ] || { echo "UUID_SYS und UUID_DATEN müssen gesetzt sein" >&2; exit 2; }
    fstab_text
    exit 0
fi

# --- Hilfen -------------------------------------------------------------------------------------------------------------
finde_label() {   # Gerätepfad zu einem Dateisystem-Label (lsblk live, Rückfall blkid ohne Cache)
    local l="$1" p
    p="$(lsblk -rno PATH,LABEL 2>/dev/null | awk -v l="$l" '$2 == l { print $1; exit }')"
    [ -n "$p" ] || p="$(blkid -c /dev/null -L "$l" 2>/dev/null || true)"
    printf '%s' "$p"
}
uuid_von() { blkid -c /dev/null -s UUID -o value "$1"; }
fstyp_von() { blkid -c /dev/null -s TYPE -o value "$1"; }
ist_subvol() { [ -d "$1" ] && [ "$(stat -c %i "$1")" = "256" ]; }
subvol_sicherstellen() {   # legt ein Unterlaufwerk an, wenn es fehlt; ein gleichnamiger normaler Ordner ist ein Fehler
    if ist_subvol "$1"; then log "Unterlaufwerk vorhanden (übernommen): $1"; return 0; fi
    [ -e "$1" ] && fehler "$1 existiert, ist aber kein Unterlaufwerk – Aufbau unklar, nicht angefasst"
    btrfs subvolume create "$1" >/dev/null
    log "Unterlaufwerk angelegt: $1"
}
eingehaengt() { findmnt -n "$1" >/dev/null 2>&1; }
aufraeumen() {
    local rc=$?
    for d in "$MNT/daten" "$MNT/sys"; do eingehaengt "$d" && umount "$d" 2>/dev/null || true; done
    for d in $CHROOT_BINDS; do umount "$d" 2>/dev/null || true; done
    [ "$rc" -eq 0 ] || log "Abgebrochen mit Code $rc – Protokoll: $LOG"
}
in_target() {   # Befehl im Ziel ausführen: im Installer über curtin, sonst chroot mit Bind-Mounts
    if command -v curtin >/dev/null 2>&1; then
        curtin in-target --target="$TARGET" -- "$@"
    else
        local d
        for d in dev proc sys run; do
            if ! eingehaengt "$TARGET/$d"; then mount --bind "/$d" "$TARGET/$d"; CHROOT_BINDS="$TARGET/$d $CHROOT_BINDS"; fi
        done
        chroot "$TARGET" "$@"
    fi
}

# --- Vorprüfungen --------------------------------------------------------------------------------------------------------
[ "$(id -u)" = "0" ] || { echo "Muss als root laufen." >&2; exit 1; }
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
trap aufraeumen EXIT
log "=== FAH-NAS Partitionen $(date '+%d.%m.%Y %H:%M:%S') · Ziel $TARGET ==="
for w in btrfs blkid lsblk findmnt mount umount chattr; do command -v "$w" >/dev/null 2>&1 || fehler "Werkzeug fehlt: $w"; done
[ -d "$TARGET" ] || fehler "Zielordner $TARGET fehlt"
eingehaengt "$TARGET" || fehler "Unter $TARGET ist nichts eingehängt (curtin sollte die Systempartition dort eingehängt haben)"

[ -n "$SYS" ] || SYS="$(finde_label "$LABEL_SYS")"
[ -n "$DATEN" ] || DATEN="$(finde_label "$LABEL_DATEN")"
[ -n "${FAHNAS_EFI_DEV+x}" ] || EFI="$(finde_label "$LABEL_EFI")"
[ -n "${FAHNAS_SWAP_DEV+x}" ] || SWAP="$(finde_label "$LABEL_SWAP")"
[ -n "$SYS" ] || fehler "Keine Partition mit Label $LABEL_SYS gefunden"
[ -n "$DATEN" ] || fehler "Keine Partition mit Label $LABEL_DATEN gefunden"
[ "$(fstyp_von "$SYS")" = "btrfs" ] || fehler "$SYS ist kein btrfs"
[ "$(fstyp_von "$DATEN")" = "btrfs" ] || fehler "$DATEN ist kein btrfs"
if [ -z "$EFI" ] && [ -z "${FAHNAS_EFI_DEV+x}" ]; then EFI="$(findmnt -n -o SOURCE "$TARGET/boot/efi" 2>/dev/null || true)"; fi
if [ -z "$EFI" ] && [ "$OHNE_GRUB" != "1" ]; then fehler "Keine EFI-Partition gefunden (Label $LABEL_EFI oder Einhängung $TARGET/boot/efi)"; fi
if [ -z "$SWAP" ]; then
    # Rückfall: Auslagerungspartition auf derselben Platte wie das System
    PLATTE_NAME="$(lsblk -no PKNAME "$SYS" 2>/dev/null | head -1 || true)"
    if [ -n "$PLATTE_NAME" ]; then SWAP="$(lsblk -rno PATH,FSTYPE "/dev/$PLATTE_NAME" 2>/dev/null | awk '$2 == "swap" { print $1; exit }' || true)"; fi
    [ -n "$SWAP" ] || log "Hinweis: keine Auslagerungspartition gefunden – fstab ohne swap-Zeile (zram bleibt)"
fi
QUELLE="$(findmnt -n -o SOURCE --target "$TARGET" | head -1 | sed 's/\[.*//')"
[ "$(readlink -f "$QUELLE")" = "$(readlink -f "$SYS")" ] || fehler "Unter $TARGET ist $QUELLE eingehängt, nicht die Systempartition $SYS"
log "System $SYS · Daten $DATEN · EFI ${EFI:--} · Auslagerung ${SWAP:--}"

# --- 1. Ziel aushängen, beide Top-Level-Unterlaufwerke einhängen -------------------------------------------------------------
[ -f "$TARGET/etc/fstab" ] && cp "$TARGET/etc/fstab" /run/fahnas-fstab.installer 2>/dev/null || true
log "Hänge $TARGET aus"
umount -R "$TARGET"
mkdir -p "$MNT/sys" "$MNT/daten"
mount -t btrfs -o subvolid=5 "$SYS" "$MNT/sys"
mount -t btrfs -o subvolid=5 "$DATEN" "$MNT/daten"

# --- 2. @ anlegen und die installierte Wurzel hineinschieben ------------------------------------------------------------------
# Über eine Unterlaufwerksgrenze gibt es kein rename(2) (btrfs: EXDEV) – „mv“ würde still kopieren und löschen, und ein
# abgebrochener Lauf ließe @/etc halb gefüllt zurück, während der alte Marker „@/etc existiert“ den zweiten Lauf zum
# Überspringen verleitete. Deshalb ausdrücklich: Kopie mit Reflink (teilt die Blöcke, dauert Sekunden, erhält Rechte,
# xattrs, Links, Zeiten; „cp -a“ ergänzt in schon vorhandene Ordner) und erst NACH erfolgreicher Kopie die Quelle löschen.
# Fertig-Kriterium: das Top-Level enthält nur noch @*.
toplevel_hat_reste() { [ -n "$(find "$MNT/sys" -mindepth 1 -maxdepth 1 ! -name '@*' -print -quit)" ]; }
subvol_sicherstellen "$MNT/sys/@"
if toplevel_hat_reste; then
    log "Kopiere die installierte Wurzel nach @ (Reflink) und lösche danach die Quelle"
    find "$MNT/sys" -mindepth 1 -maxdepth 1 ! -name '@*' -exec cp -a --reflink=auto -t "$MNT/sys/@/" -- {} +
    find "$MNT/sys" -mindepth 1 -maxdepth 1 ! -name '@*' -exec rm -rf -- {} +
else
    log "Top-Level enthält nur Unterlaufwerke – Umzug nach @ schon erledigt, Verschieben übersprungen (zweiter Lauf)"
fi
[ -d "$MNT/sys/@/etc" ] || fehler "Nach dem Umzug fehlt @/etc – Systempartition war leer?"
toplevel_hat_reste && fehler "Am Top-Level der Systempartition sind Reste geblieben"

# --- 3. @log (Inhalt von /var/log), @snapshots, Einhängepunkte in @ -------------------------------------------------------
subvol_sicherstellen "$MNT/sys/@log"
mkdir -p "$MNT/sys/@/var/log"
if [ -n "$(ls -A "$MNT/sys/@/var/log")" ]; then
    log "Kopiere /var/log nach @log (Reflink) und leere die Quelle"
    find "$MNT/sys/@/var/log" -mindepth 1 -maxdepth 1 -exec cp -a --reflink=auto -t "$MNT/sys/@log/" -- {} +
    find "$MNT/sys/@/var/log" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
subvol_sicherstellen "$MNT/sys/@snapshots"
mkdir -p "$MNT/sys/@/.snapshots" "$MNT/sys/@/data" "$MNT/sys/@/var/lib/docker" "$MNT/sys/@/boot/efi"
chmod 0750 "$MNT/sys/@/.snapshots"

# --- 4. Standard-Unterlaufwerk @ (Kernel-Rückfall ohne rootflags; GRUB selbst löst Pfade immer ab Top-Level auf) ---------------
btrfs subvolume set-default "$MNT/sys/@"
log "Standard-Unterlaufwerk: $(btrfs subvolume get-default "$MNT/sys")"

# --- 5. Datenpartition: Unterlaufwerke nur anlegen, wenn sie fehlen (Übernahme!) ------------------------------------------------
for sv in $DATEN_SUBVOLS; do subvol_sicherstellen "$MNT/daten/$sv"; done
chattr +C "$MNT/daten/@docker" "$MNT/daten/@vms" 2>/dev/null || log "Hinweis: chattr +C auf @docker/@vms nicht möglich"
mkdir -p "$MNT/daten/config" "$MNT/daten/apps" "$MNT/daten/vms" "$MNT/daten/shares" "$MNT/daten/backup" "$MNT/daten/.snapshots"
chmod 0751 "$MNT/daten"
chmod 0750 "$MNT/daten/@config" "$MNT/daten/@snapshots_daten" "$MNT/daten/@backup" "$MNT/daten/@apps" "$MNT/daten/@vms"
chmod 0751 "$MNT/daten/@shares"

# --- 6. fstab -----------------------------------------------------------------------------------------------------------------
UUID_SYS="$(uuid_von "$SYS")"; UUID_DATEN="$(uuid_von "$DATEN")"
UUID_EFI=""; [ -n "$EFI" ] && UUID_EFI="$(uuid_von "$EFI")"
UUID_SWAP=""; [ -n "$SWAP" ] && UUID_SWAP="$(uuid_von "$SWAP")"
[ -n "$UUID_SYS" ] && [ -n "$UUID_DATEN" ] || fehler "UUID von System- oder Datenpartition nicht lesbar"
[ -f "$MNT/sys/@/etc/fstab" ] && [ ! -f "$MNT/sys/@/etc/fstab.installer" ] && cp "$MNT/sys/@/etc/fstab" "$MNT/sys/@/etc/fstab.installer"
fstab_text > "$MNT/sys/@/etc/fstab"
log "fstab geschrieben:"; sed 's/^/    /' "$MNT/sys/@/etc/fstab"

# --- 7. Neu einhängen wie im Betrieb (prüft die fstab gleich mit; curtin/subiquity brauchen /target weiter) --------------------
umount "$MNT/daten"; umount "$MNT/sys"
einhaengungen | while IFS='|' read -r geraet _uuid ziel typ optionen _dump _pass; do
    mkdir -p "$TARGET$ziel"
    mount -t "$typ" -o "$optionen" "$geraet" "$TARGET$ziel" || { echo "Einhängen fehlgeschlagen: $geraet → $TARGET$ziel ($optionen)"; exit 1; }
done || fehler "Neu einhängen nach fstab fehlgeschlagen"
log "Ziel neu eingehängt: $(findmnt -n -o OPTIONS "$TARGET")"

# --- 8. GRUB im Ziel neu (Pfad-Präfix /@/boot/grub und rootflags=subvol=@) ---------------------------------------------------
if [ "$OHNE_GRUB" = "1" ]; then
    log "GRUB übersprungen (FAHNAS_OHNE_GRUB=1)"
else
    if [ -d /sys/firmware/efi ]; then
        log "GRUB (UEFI) neu installieren"
        in_target grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck \
            || in_target grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck --no-nvram \
            || fehler "grub-install (UEFI) fehlgeschlagen"
    else
        PLATTE="/dev/$(lsblk -no PKNAME "$SYS" | head -1)"
        [ -b "$PLATTE" ] || fehler "Platte zu $SYS nicht ermittelbar (BIOS-GRUB)"
        log "GRUB (BIOS) neu installieren auf $PLATTE"
        in_target grub-install --target=i386-pc --recheck "$PLATTE" || fehler "grub-install (BIOS) fehlgeschlagen"
    fi
    in_target update-grub || fehler "update-grub fehlgeschlagen"
    grep -q 'rootflags=subvol=@' "$TARGET/boot/grub/grub.cfg" || fehler "grub.cfg enthält kein rootflags=subvol=@ – Wurzel würde falsch eingehängt"
    log "GRUB erneuert (rootflags=subvol=@ vorhanden)"
fi

mkdir -p "$TARGET/var/log"
cp "$LOG" "$TARGET/var/log/" 2>/dev/null || true
log "=== Partitionen fertig ==="
