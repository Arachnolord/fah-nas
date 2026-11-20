#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 11: externe Laufwerke (Teil D2) mit zwei Loop-Images (exfat, ext4) als „externe Geräte“.
# Prüft: Erkennen (lsblk, system:false), Einhängen nach shares/<name>, Datei schreiben, extern-Freigabe im
# Samba-Include mit available=yes, Aushängen → available=no, Wieder-Einhängen, Vergessen (Eintrag aus laufwerke.json).
# Ubuntu 26.04, root, Loop-Geräte nötig (--privileged). Exit 0/1/3.
# Loop-Geräte werden nur mit FAHNAS_LAUFWERKE_TEST_LOOPS=1 als externe Platten behandelt; die Überwachung ist im
# Test abgeschaltet (FAHNAS_UEBERWACHUNG=0), damit der 15-s-Abgleich das Aushängen nicht sofort rückgängig macht.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd lsblk findmnt mount umount losetup blkid mkfs.exfat mkfs.ext4
export FAHNAS_LAUFWERKE_TEST_LOOPS=1 FAHNAS_UEBERWACHUNG=0
umgebung_vorbereiten
melde "== 11 Externe Laufwerke =="

# Zwei Loop-Images mit je einem Dateisystem direkt auf dem Gerät (kein Partitionstisch → lsblk zeigt loop mit fstype).
loop_bild() {
    local name="$1" fs="$2" label="$3" groesse="$4" bild="$IT/$name.img" geraet
    rm -f "$bild"; truncate -s "$groesse" "$bild"
    geraet="$(loop_anhaengen "$bild")" || return 1
    LOOP_GERAETE="$geraet $LOOP_GERAETE"
    case "$fs" in
        exfat) mkfs.exfat -n "$label" "$geraet" >/dev/null 2>&1 || return 1 ;;
        ext4)  mkfs.ext4 -F -L "$label" "$geraet" >/dev/null 2>&1 || return 1 ;;
        *) return 1 ;;
    esac
    printf '%s' "$geraet"
}

EXFAT_DEV="$(loop_bild ex exfat FAHTEST-EX 512M)" || { schlecht "exfat-Loop-Image anlegen (exfatprogs?)"; ergebnis; }
ok "exfat-Loop-Image $EXFAT_DEV (Label FAHTEST-EX)"
EXT4_DEV="$(loop_bild e4 ext4 FAHTEST-E4 512M)" || { schlecht "ext4-Loop-Image anlegen"; ergebnis; }
ok "ext4-Loop-Image $EXT4_DEV (Label FAHTEST-E4)"

pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung (Admin $ADMIN_NAME)" ersteinrichtung_durchfuehren

# --- Erkennen -----------------------------------------------------------------------------------------------------
LISTE="$(agent_aktion laufwerke.liste)"
enthaelt "laufwerke.liste liefert ein Ergebnis" '"ok":true' "$LISTE"
EXFAT_FS="$(node -e 'const d=JSON.parse(process.argv[1]);const g=(d.ergebnis||[]).find(x=>x.pfad===process.argv[2]);process.stdout.write(g?`${g.fs}:${g.system}`:"fehlt")' "$LISTE" "$EXFAT_DEV")"
enthaelt "exfat-Loop wird als externes exfat-Laufwerk erkannt (system:false)" '^exfat:false$' "$EXFAT_FS"
EXT4_FS="$(node -e 'const d=JSON.parse(process.argv[1]);const g=(d.ergebnis||[]).find(x=>x.pfad===process.argv[2]);process.stdout.write(g?`${g.fs}:${g.system}`:"fehlt")' "$LISTE" "$EXT4_DEV")"
enthaelt "ext4-Loop wird als externes ext4-Laufwerk erkannt (system:false)" '^ext4:false$' "$EXT4_FS"

# --- Einhängen (exfat) mit Freigabe ------------------------------------------------------------------------------
EIN="$(agent_aktion laufwerke.einhaengen "{\"pfad\":\"$EXFAT_DEV\",\"name\":\"usbex\",\"freigabe\":true}")"
enthaelt "exfat einhängen (als Freigabe usbex)" '"ok":true' "$EIN"
KENN="$(json_feld "$EIN" ergebnis.kennung)"
ZIEL="$(json_feld "$EIN" ergebnis.einhaengepunkt)"
bedingung "Einhängepunkt liegt unter den Freigaben" "$ZIEL" = "$FAHNAS_SHARES/usbex"
enthaelt "Laufwerk ist eingehängt (findmnt)" "$ZIEL" "$(findmnt -n -o TARGET "$ZIEL" 2>/dev/null)"
bedingung "Ordner unter shares vorhanden" -d "$ZIEL"
printf 'Hallo vom Laufwerkstest %s\n' "$(date +%s)" > "$ZIEL/hallo.txt" && ok "Datei auf das exfat-Laufwerk geschrieben" || schlecht "Datei schreiben"
bedingung "geschriebene Datei liegt auf dem Laufwerk" -f "$ZIEL/hallo.txt"
enthaelt "laufwerke.json kennt das Gerät (automatisch)" '"automatisch": true' "$(cat "$FAHNAS_CONFIG/laufwerke.json")"
bedingung "Samba-Include usbex.conf angelegt" -f "$FAHNAS_SAMBA/usbex.conf"
enthaelt "Include: extern-Freigabe zeigt auf den Einhängepunkt" "path = $ZIEL" "$(cat "$FAHNAS_SAMBA/usbex.conf")"

# --- Rechte geben → available=yes --------------------------------------------------------------------------------
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"usbex\",\"schreiben\":[\"$ADMIN_NAME\"]}")"
enthaelt "Schreibrecht für $ADMIN_NAME auf usbex" '"ok":true' "$AEND"
CONF="$(cat "$FAHNAS_SAMBA/usbex.conf")"
enthaelt "Include hat valid users" "valid users = $ADMIN_NAME" "$CONF"
bedingung "eingehängt → KEIN available=no" -z "$(printf '%s\n' "$CONF" | grep -F 'available = no' || true)"
pruefe "testparm akzeptiert die Gesamtkonfiguration mit externer Freigabe" testparm -s --suppress-prompt /etc/samba/smb.conf

# --- Aushängen → available=no, Freigabe bleibt -------------------------------------------------------------------
AUS="$(agent_aktion laufwerke.aushaengen "{\"kennung\":\"$KENN\"}")"
enthaelt "Laufwerk auswerfen" '"ok":true' "$AUS"
bedingung "nicht mehr eingehängt" -z "$(findmnt -n -o TARGET "$ZIEL" 2>/dev/null)"
enthaelt "Freigabe bleibt in shares.json" '"name": "usbex"' "$(cat "$FAHNAS_CONFIG/shares.json")"
enthaelt "Include jetzt available=no (Laufwerk nicht eingehängt)" 'available = no' "$(cat "$FAHNAS_SAMBA/usbex.conf")"

# --- Wieder einhängen → available wieder da ----------------------------------------------------------------------
EIN2="$(agent_aktion laufwerke.einhaengen "{\"pfad\":\"$EXFAT_DEV\",\"name\":\"usbex\",\"freigabe\":true}")"
enthaelt "Laufwerk wieder einhängen" '"ok":true' "$EIN2"
enthaelt "wieder eingehängt (findmnt)" "$ZIEL" "$(findmnt -n -o TARGET "$ZIEL" 2>/dev/null)"
bedingung "Datei ist wieder da" -f "$ZIEL/hallo.txt"
bedingung "wieder eingehängt → KEIN available=no" -z "$(grep -F 'available = no' "$FAHNAS_SAMBA/usbex.conf" || true)"

# --- Vergessen → Eintrag aus laufwerke.json ----------------------------------------------------------------------
VERG="$(agent_aktion laufwerke.aushaengen "{\"kennung\":\"$KENN\",\"vergessen\":true}")"
enthaelt "Laufwerk vergessen (auswerfen + abschalten)" '"ok":true' "$VERG"
bedingung "nach Vergessen nicht mehr eingehängt" -z "$(findmnt -n -o TARGET "$ZIEL" 2>/dev/null)"
KENNT="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((d.geraete||[]).some(g=>g.kennung===process.argv[2])))' "$FAHNAS_CONFIG/laufwerke.json" "$KENN" 2>/dev/null)"
bedingung "Gerät ist aus laufwerke.json entfernt" "$KENNT" = "false"

ergebnis
