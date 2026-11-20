#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 03: Freigabe anlegen (btrfs-Unterlaufwerk auf einem Loop-Pool) → testparm, smbclient -L, Datei als
# Nutzer über smbclient schreiben, Rechte/Besitzer, Include-Datei, Freigabe ohne Rechte unsichtbar.
# Ubuntu 26.04, root, braucht Loop-Geräte (Container: --privileged). Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd smbclient smbcontrol pdbedit btrfs losetup mkfs.btrfs setfacl getfacl
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots"
umgebung_vorbereiten
melde "== 03 Freigabe =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET unter $POOL"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung (Admin $ADMIN_NAME)" ersteinrichtung_durchfuehren

pruefe "Freigabe „$FREIGABE“ anlegen (Schreibrecht $ADMIN_NAME)" freigabe_anlegen "$FREIGABE"
bedingung "Unterlaufwerk $FAHNAS_SHARES/$FREIGABE ist ein btrfs-Unterlaufwerk" "$(stat -c %i "$FAHNAS_SHARES/$FREIGABE")" = "256"
enthaelt "Rechte 2770 auf der Freigabe" '^2770$' "$(stat -c '%a' "$FAHNAS_SHARES/$FREIGABE")"
enthaelt "ACL erlaubt $ADMIN_NAME rwx" "user:$ADMIN_NAME:rwx" "$(getfacl -p "$FAHNAS_SHARES/$FREIGABE" 2>/dev/null)"
bedingung "Include-Datei $FAHNAS_SAMBA/$FREIGABE.conf" -f "$FAHNAS_SAMBA/$FREIGABE.conf"
enthaelt "alle.conf bindet die Freigabe ein" "include = .*/$FREIGABE\.conf" "$(cat "$FAHNAS_SAMBA/alle.conf")"
enthaelt "Include: Pfad stimmt" "path = $FAHNAS_SHARES/$FREIGABE" "$(cat "$FAHNAS_SAMBA/$FREIGABE.conf")"
enthaelt "Include: vfs fruit + recycle (Papierkorb)" 'vfs objects = fruit streams_xattr recycle' "$(cat "$FAHNAS_SAMBA/$FREIGABE.conf")"
pruefe "testparm akzeptiert die Gesamtkonfiguration" testparm -s --suppress-prompt /etc/samba/smb.conf
enthaelt "shares.json enthält die Freigabe" "\"name\": \"$FREIGABE\"" "$(cat "$FAHNAS_CONFIG/shares.json")"

LISTE="$(smbclient -L //127.0.0.1 -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 2>&1)"
enthaelt "smbclient -L zeigt die Freigabe" "^\s*$FREIGABE\s+Disk" "$LISTE"
printf 'Hallo vom Integrationstest %s\n' "$(date +%s)" > "$IT/hallo.txt"
pruefe "Datei per smbclient als $ADMIN_NAME schreiben" smbclient "//127.0.0.1/$FREIGABE" -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 -c "put $IT/hallo.txt hallo.txt"
bedingung "Datei liegt in der Freigabe" -f "$FAHNAS_SHARES/$FREIGABE/hallo.txt"
enthaelt "Datei gehört $ADMIN_NAME" "^$ADMIN_NAME$" "$(stat -c '%U' "$FAHNAS_SHARES/$FREIGABE/hallo.txt")"
enthaelt "Datei hat Gruppe fahnas-nutzer (force group)" '^fahnas-nutzer$' "$(stat -c '%G' "$FAHNAS_SHARES/$FREIGABE/hallo.txt")"
pruefe "Datei per smbclient lesen" smbclient "//127.0.0.1/$FREIGABE" -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 -c "get hallo.txt $IT/hallo_zurueck.txt"
pruefe "Inhalt gleich" cmp "$IT/hallo.txt" "$IT/hallo_zurueck.txt"
pruefe "Löschen per smbclient landet im Papierkorb" smbclient "//127.0.0.1/$FREIGABE" -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 -c "del hallo.txt"
bedingung "Papierkorb-Kopie vorhanden" -n "$(find "$FAHNAS_SHARES/$FREIGABE/.papierkorb" -name 'hallo.txt*' 2>/dev/null | head -1)"

# Nur-Lesen-Nutzer: schreiben scheitert
LESER="$(agent_aktion nutzer.anlegen "{\"name\":\"leser\",\"anzeigename\":\"Leser\",\"passwort\":\"$ADMIN_PW\",\"rolle\":\"nutzer\"}")"
enthaelt "Nur-Lese-Nutzer angelegt" '"ok":true' "$LESER"
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"lesen\":[\"leser\"],\"schreiben\":[\"$ADMIN_NAME\"]}")"
enthaelt "Freigabe geändert: leser darf lesen" '"ok":true' "$AEND"
sleep 1
SCHREIB="$(smbclient "//127.0.0.1/$FREIGABE" -U "leser%$ADMIN_PW" -m SMB3 -c "put $IT/hallo.txt verboten.txt" 2>&1 || true)"
enthaelt "Schreiben als Nur-Leser scheitert (ACCESS_DENIED)" 'ACCESS_DENIED|Permission denied|NT_STATUS_' "$SCHREIB"
bedingung "Keine Datei verboten.txt angelegt" ! -e "$FAHNAS_SHARES/$FREIGABE/verboten.txt"

VERB="$(agent_aktion freigaben.verbindung "{\"name\":\"$FREIGABE\"}")"
enthaelt "Verbindungshinweis smb://" 'smb://' "$VERB"

ergebnis
