#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# FAH-NAS Installer – early-command: Zielplatte wählen und die storage-Sektion in /autoinstall.yaml schreiben.
# Die Entscheidung trifft platte_waehlen.py (gleicher Ordner); dieses Skript protokolliert nach
# /var/log/fahnas-platte.log (wird von den error-commands ausgegeben) und prüft die Installer-Umgebung.
# Exit ≠ 0 stoppt die Installation, BEVOR eine Platte angefasst wird.
set -uo pipefail
LOG="${FAHNAS_PLATTE_LOG:-/var/log/fahnas-platte.log}"
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
exec > >(tee -a "$LOG") 2>&1
echo "=== FAH-NAS Plattenwahl $(date '+%d.%m.%Y %H:%M:%S') ==="

if ! command -v python3 >/dev/null 2>&1; then
    echo "FEHLER: python3 fehlt in der Installer-Umgebung – die Plattenwahl braucht es (subiquity selbst ist Python)."
    exit 1
fi
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    echo "FEHLER: python3-yaml fehlt in der Installer-Umgebung – /autoinstall.yaml kann nicht umgeschrieben werden."
    exit 1
fi
if [ ! -f /autoinstall.yaml ]; then
    echo "FEHLER: /autoinstall.yaml fehlt – wurde das Medium mit „autoinstall ds=nocloud;s=/cdrom/nocloud/“ gestartet?"
    exit 1
fi
for w in lsblk findmnt; do
    command -v "$w" >/dev/null 2>&1 || { echo "FEHLER: $w fehlt in der Installer-Umgebung."; exit 1; }
done

python3 "$HIER/platte_waehlen.py" "$@"
rc=$?
if [ "$rc" -ne 0 ]; then
    echo "FEHLER: Plattenwahl abgebrochen (Code $rc). Die Installation wurde gestoppt, keine Platte wurde verändert."
    echo "Abhilfe: im GRUB-Menü mit „e“ die Zeile „linux …“ um fahnas.platte=/dev/sdX ergänzen (F10 startet), oder fahnas.neu=1 für eine komplett neue Einrichtung."
fi
exit "$rc"
