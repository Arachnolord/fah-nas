#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Baut das FAH-NAS-Installer-ISO: Ubuntu Server 26.04 LTS (amd64) + Autoinstall + Release-Archiv + Erststart.
# Läuft auf macOS (brew install xorriso; python3, ruby, shasum sind da) und Linux (apt install xorriso python3 ruby).
#
#   ./iso/build_iso.sh [pfad/zum/fahnas_release.tar.gz]     Standard: ../dist/fahnas_release.tar.gz (tools/build_release.sh)
#   UBUNTU_ISO=<datei>   vorhandene Ubuntu-ISO benutzen (sonst: neueste 26.04.x aus iso/cache/ oder Download)
#   OHNE_PRUEFUNG=1      user-data-Prüfung überspringen (nur zum Ausprobieren)
#   NUR_PRUEFEN=1        Probelauf: alle Vorprüfungen (Archiv, Skripte, user-data, Ubuntu-ISO-Prüfsumme, grub-btrfs), kein ISO-Bau
#
# Ergebnis: iso/aus/fahnas-<version>-<datum>-ubuntu26.04-amd64.iso (+ .sha256)
# Vorgehen wie Ubuntus Anleitung „custom autoinstall ISO“: Original auspacken, nocloud/ + fahnas/ + grub.cfg einsetzen,
# md5sum.txt erneuern, mit den ORIGINALEN Boot-Images (BIOS + UEFI, Secure Boot bleibt intakt) neu zusammensetzen.
# Fallen (aus dem allinone-Bau übernommen): xorriso ≥ 1.5 nennt die Boot-Teile mbr_code_grub2.img und gpt_part2_efi.img;
# die 26.04-ISO hat weiterhin /casper/vmlinuz + /casper/initrd und /boot/grub/i386-pc/eltorito.img (geprüft 25.09.2026).
set -euo pipefail
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WURZEL="$(dirname "$HIER")"
ARCHIV="${1:-$WURZEL/dist/fahnas_release.tar.gz}"
REL="26.04"
VOLUMEN_ID="FAH-NAS Installer"
CACHE="$HIER/cache"; ARBEIT="$HIER/arbeit"; AUS="$HIER/aus"
mkdir -p "$CACHE" "$AUS"

fehler() { echo "FEHLER: $*" >&2; exit 1; }

# ── 0) Voraussetzungen
[ -s "$ARCHIV" ] || fehler "Release-Archiv fehlt: $ARCHIV – erst tools/build_release.sh ausführen (erzeugt dist/fahnas_release.tar.gz + .sha256)"
[ -s "$ARCHIV.sha256" ] || fehler "Prüfsumme fehlt: $ARCHIV.sha256 – erst tools/build_release.sh ausführen"
command -v xorriso >/dev/null || fehler "xorriso fehlt (macOS: brew install xorriso; Debian/Ubuntu: apt install xorriso)"
command -v python3 >/dev/null || fehler "python3 fehlt"
if command -v sha256sum >/dev/null; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
# Prüfsumme des Release-Archivs (Format „<summe>  fahnas_release.tar.gz“ aus build_release.sh)
SOLL="$(cut -d' ' -f1 "$ARCHIV.sha256")"; IST="$($SHA "$ARCHIV" | cut -d' ' -f1)"
[ "$SOLL" = "$IST" ] || fehler "Prüfsumme des Release-Archivs stimmt nicht ($ARCHIV.sha256)"
VERSION="$(tar -xzOf "$ARCHIV" BUILD_VERSION 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$VERSION" ] || VERSION="$(tr -d '[:space:]' < "$WURZEL/BUILD_VERSION" 2>/dev/null || echo unbekannt)"
echo "Release-Archiv: $ARCHIV (Version $VERSION, Prüfsumme geprüft)"

# ── 0b) Eigene Teile prüfen, bevor 3 GB bewegt werden
for s in "$HIER/payload/erststart.sh" "$HIER/payload/partitionen.sh" "$HIER/payload/platte_waehlen.sh"; do bash -n "$s" || fehler "Syntaxfehler in $s"; done
python3 -m py_compile "$HIER/payload/platte_waehlen.py" || fehler "Syntaxfehler in platte_waehlen.py"
python3 -m py_compile "$WURZEL/tools/watchdog_halten.py" || fehler "Syntaxfehler in watchdog_halten.py"
rm -rf "$HIER/payload/__pycache__" "$WURZEL/tools/__pycache__"
if [ "${OHNE_PRUEFUNG:-0}" != "1" ]; then
    if command -v node >/dev/null; then
        node "$HIER/werkzeuge/autoinstall_pruefen.mjs" "$HIER/nocloud/user-data" "$HIER/autoinstall-schema.json" || fehler "user-data ungültig"
    else
        echo "Hinweis: node fehlt – user-data nur mit ruby/python auf YAML-Lesbarkeit geprüft"
        if command -v ruby >/dev/null; then ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$HIER/nocloud/user-data" || fehler "user-data ist kein gültiges YAML"
        else python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' "$HIER/nocloud/user-data" || fehler "user-data ist kein gültiges YAML (python3-yaml nötig)"; fi
    fi
fi
grep -q 'autoinstall ds=nocloud\\;s=/cdrom/nocloud/' "$HIER/grub/grub.cfg" || fehler "grub.cfg ohne autoinstall-Eintrag"

# ── 1) Ubuntu-ISO: vorhanden im Cache (neueste 26.04.x) oder herunterladen; Prüfsumme gegen SHA256SUMS
if [ -n "${UBUNTU_ISO:-}" ]; then
    ISO_PFAD="$UBUNTU_ISO"; ISO_NAME="$(basename "$ISO_PFAD")"
    [ -s "$ISO_PFAD" ] || fehler "UBUNTU_ISO=$ISO_PFAD existiert nicht"
else
    ISO_NAME="$(ls "$CACHE" 2>/dev/null | grep -E "^ubuntu-$REL(\.[0-9]+)?-live-server-amd64\.iso$" | sort -V | tail -1 || true)"
    if [ -z "$ISO_NAME" ]; then
        command -v curl >/dev/null || fehler "curl fehlt für den Download der Ubuntu-ISO"
        ISO_NAME="$(curl -fsSL "https://releases.ubuntu.com/$REL/" | grep -o "ubuntu-$REL[0-9.]*-live-server-amd64\.iso" | sort -V | uniq | tail -1)"
        [ -n "$ISO_NAME" ] || fehler "keine Server-ISO unter releases.ubuntu.com/$REL gefunden"
        curl -fsSL -o "$CACHE/SHA256SUMS" "https://releases.ubuntu.com/$REL/SHA256SUMS"
        echo "→ Lade $ISO_NAME (~3 GB) ..."
        curl -fL --retry 3 -o "$CACHE/$ISO_NAME" "https://releases.ubuntu.com/$REL/$ISO_NAME"
    fi
    ISO_PFAD="$CACHE/$ISO_NAME"
    [ -s "$CACHE/SHA256SUMS" ] || { command -v curl >/dev/null && curl -fsSL -o "$CACHE/SHA256SUMS" "https://releases.ubuntu.com/$REL/SHA256SUMS"; } || fehler "SHA256SUMS fehlt im Cache"
    SOLL="$(grep " \*$ISO_NAME\$" "$CACHE/SHA256SUMS" | cut -d' ' -f1)"
    [ -n "$SOLL" ] || fehler "$ISO_NAME steht nicht in SHA256SUMS"
    echo "→ Prüfe Prüfsumme von $ISO_NAME (dauert kurz) ..."
    IST="$($SHA "$ISO_PFAD" | cut -d' ' -f1)"
    [ "$SOLL" = "$IST" ] || { rm -f "$ISO_PFAD"; fehler "Prüfsumme von $ISO_NAME stimmt nicht (Download beschädigt?) – Datei gelöscht"; }
    echo "OK: $ISO_NAME, Prüfsumme geprüft."
fi

# ── 1b) grub-btrfs-Quellarchiv (kein Ubuntu-Paket) für die Installation ohne Internet in den Cache holen
# shellcheck source=payload/quellen.env
. "$HIER/payload/quellen.env"
GB_PFAD="$CACHE/$GRUB_BTRFS_DATEI"
if [ ! -s "$GB_PFAD" ] && command -v curl >/dev/null; then
    echo "→ Lade $GRUB_BTRFS_DATEI ..."; curl -fsSL --retry 3 -o "$GB_PFAD" "$GRUB_BTRFS_URL" || { rm -f "$GB_PFAD"; echo "Hinweis: Download von grub-btrfs fehlgeschlagen – der Erststart lädt es später selbst."; }
fi
if [ -s "$GB_PFAD" ]; then
    IST="$($SHA "$GB_PFAD" | cut -d' ' -f1)"
    [ "$IST" = "$GRUB_BTRFS_SHA256" ] || { rm -f "$GB_PFAD"; fehler "Prüfsumme von $GRUB_BTRFS_DATEI stimmt nicht mit quellen.env überein – Datei gelöscht"; }
    echo "OK: $GRUB_BTRFS_DATEI, Prüfsumme geprüft."
fi

if [ "${NUR_PRUEFEN:-0}" = "1" ]; then
    echo "Probelauf beendet: alle Vorprüfungen bestanden (Version $VERSION, $ISO_NAME). Ohne NUR_PRUEFEN=1 wird jetzt das ISO gebaut."
    exit 0
fi

# ── 2) Original auspacken (Dateien + die beiden El-Torito-Boot-Images)
rm -rf "$ARBEIT"; mkdir -p "$ARBEIT/iso" "$ARBEIT/boot"
echo "→ Packe $ISO_NAME aus ..."
xorriso -osirrox on -indev "$ISO_PFAD" -extract / "$ARBEIT/iso" >/dev/null 2>&1
xorriso -osirrox on -indev "$ISO_PFAD" -extract_boot_images "$ARBEIT/boot" >/dev/null 2>&1
chmod -R u+w "$ARBEIT/iso"
BIOS_IMG="$ARBEIT/boot/mbr_code_grub2.img"; EFI_IMG="$ARBEIT/boot/gpt_part2_efi.img"
[ -s "$EFI_IMG" ] || EFI_IMG="$ARBEIT/boot/eltorito_img2_uefi.img"
[ -s "$BIOS_IMG" ] && [ -s "$EFI_IMG" ] || { echo "Boot-Images nicht gefunden:"; ls -la "$ARBEIT/boot"; fehler "xorriso -extract_boot_images lieferte nicht mbr_code_grub2.img/gpt_part2_efi.img"; }
[ -f "$ARBEIT/iso/casper/vmlinuz" ] && [ -f "$ARBEIT/iso/casper/initrd" ] && [ -f "$ARBEIT/iso/boot/grub/i386-pc/eltorito.img" ] || fehler "unerwarteter ISO-Aufbau (casper/vmlinuz, casper/initrd oder eltorito.img fehlt)"

# ── 3) Eigene Teile einsetzen: nocloud/ (Autoinstall), fahnas/ (Release + Erststart-Paket), grub.cfg
mkdir -p "$ARBEIT/iso/nocloud" "$ARBEIT/iso/fahnas/samba" "$ARBEIT/iso/fahnas/nftables"
cp "$HIER/nocloud/user-data" "$HIER/nocloud/meta-data" "$ARBEIT/iso/nocloud/"
cp "$ARCHIV" "$ARBEIT/iso/fahnas/fahnas_release.tar.gz"
# Prüfsummendatei im ISO immer mit dem festen Dateinamen (der Erststart prüft „sha256sum -c fahnas_release.tar.gz.sha256“)
printf '%s  fahnas_release.tar.gz\n' "$(cut -d' ' -f1 "$ARCHIV.sha256")" > "$ARBEIT/iso/fahnas/fahnas_release.tar.gz.sha256"
for d in erststart.sh partitionen.sh platte_waehlen.sh platte_waehlen.py dns_rueckfall.sh fahnas-dns-rueckfall.service fahnas-erststart.service README.txt quellen.env zram.conf; do
    cp "$HIER/payload/$d" "$ARBEIT/iso/fahnas/"
done
# Hardware-Watchdog (UGREEN DXP): Skript und Unit aus dem Programm – Installer (early-commands) und Ziel (late-commands)
cp "$WURZEL/tools/watchdog_halten.py" "$WURZEL/systemd/fahnas-watchdog.service" "$ARBEIT/iso/fahnas/"
cp "$HIER/payload/samba/smb.conf" "$ARBEIT/iso/fahnas/samba/"
cp "$HIER/payload/nftables/fahnas.nft" "$ARBEIT/iso/fahnas/nftables/"
[ -s "$GB_PFAD" ] && cp "$GB_PFAD" "$ARBEIT/iso/fahnas/"
chmod 755 "$ARBEIT/iso/fahnas/"*.sh "$ARBEIT/iso/fahnas/platte_waehlen.py" "$ARBEIT/iso/fahnas/watchdog_halten.py"
cp "$HIER/grub/grub.cfg" "$ARBEIT/iso/boot/grub/grub.cfg"
# loopback.cfg (Start des ISO als Datei aus einem GRUB heraus): gleiche Einträge, plus iso-scan/filename
sed 's|/casper/vmlinuz |/casper/vmlinuz iso-scan/filename=${iso_path} |' "$HIER/grub/grub.cfg" > "$ARBEIT/iso/boot/grub/loopback.cfg"
# md5sum.txt erneuern (Format wie im Original: "<md5>  ./pfad"), damit die Integritätsprüfung des Mediums stimmt
( cd "$ARBEIT/iso" && python3 - <<'PY'
import hashlib, os
zeilen = []
for wurzel, _dirs, dateien in os.walk("."):
    for d in sorted(dateien):
        p = os.path.join(wurzel, d)
        if p in ("./md5sum.txt", "./boot.catalog") or (p.startswith("./boot/grub/i386-pc/") and d == "eltorito.img"):
            continue
        h = hashlib.md5()
        with open(p, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        zeilen.append(f"{h.hexdigest()}  {p}")
open("md5sum.txt", "w").write("\n".join(sorted(zeilen)) + "\n")
print(f"md5sum.txt: {len(zeilen)} Einträge")
PY
)

# ── 4) ISO zusammensetzen (BIOS + UEFI, hybrid, GPT-Anhang wie das Original – Optionen aus xorriso -report_el_torito as_mkisofs)
STEMPEL="$(date +%Y%m%d)"
AUS_ISO="$AUS/fahnas-$VERSION-$STEMPEL-ubuntu$REL-amd64.iso"
echo "→ Baue $AUS_ISO ..."
xorriso -as mkisofs -r -V "$VOLUMEN_ID" -o "$AUS_ISO" \
  --grub2-mbr "$BIOS_IMG" --protective-msdos-label -partition_cyl_align off -partition_offset 16 --mbr-force-bootable \
  -append_partition 2 28732ac11ff8d211ba4b00a0c93ec93b "$EFI_IMG" \
  -appended_part_as_gpt -iso_mbr_part_type a2a0d0ebe5b9334487c068b6b72699c7 \
  -c '/boot.catalog' -b '/boot/grub/i386-pc/eltorito.img' \
  -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
  -eltorito-alt-boot -e '--interval:appended_partition_2:::' -no-emul-boot \
  "$ARBEIT/iso" 2>&1 | grep -E -i 'error|warn|Writing to|ISO image produced' | head -5 || true
[ -s "$AUS_ISO" ] || fehler "ISO wurde nicht geschrieben"
( cd "$AUS" && $SHA "$(basename "$AUS_ISO")" > "$(basename "$AUS_ISO").sha256" )

# ── 5) Nachprüfung: Boot-Einträge, eigene Dateien, Volumen-ID
echo "→ Prüfe ..."
xorriso -indev "$AUS_ISO" -report_el_torito plain 2>/dev/null | grep -E '^El Torito boot img' | head -2
xorriso -indev "$AUS_ISO" -pvd_info 2>/dev/null | grep -q "Volume Id *: $VOLUMEN_ID" || fehler "Volumen-ID nicht „$VOLUMEN_ID“"
for p in /nocloud/user-data /nocloud/meta-data /fahnas/fahnas_release.tar.gz /fahnas/fahnas_release.tar.gz.sha256 /fahnas/erststart.sh /fahnas/partitionen.sh \
         /fahnas/platte_waehlen.sh /fahnas/platte_waehlen.py /fahnas/fahnas-erststart.service /fahnas/quellen.env /fahnas/zram.conf /fahnas/README.txt \
         /fahnas/samba/smb.conf /fahnas/nftables/fahnas.nft /boot/grub/grub.cfg /boot/grub/loopback.cfg /casper/vmlinuz /casper/initrd; do
    xorriso -indev "$AUS_ISO" -find "$p" -type f >/dev/null 2>&1 || fehler "$p fehlt im ISO"
done
[ -s "$GB_PFAD" ] && { xorriso -indev "$AUS_ISO" -find "/fahnas/$GRUB_BTRFS_DATEI" -type f >/dev/null 2>&1 || fehler "/fahnas/$GRUB_BTRFS_DATEI fehlt im ISO"; }
rm -rf "$ARBEIT"
echo "OK: $(du -h "$AUS_ISO" | cut -f1 | tr -d ' ')  $AUS_ISO"
cat "$AUS_ISO.sha256"
