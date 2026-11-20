#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 07: Wiederaufbau aus /data/config (Abnahmekriterium 8). Nach einer „Neuinstallation mit übernommener
# Datenpartition“ liegen users.json/shares.json und die Samba-Passwortdatenbank (private dir unter config/samba) vor, aber
# Linux-Konten, Samba-Includes, ACLs und – im Härtefall – das Unterlaufwerk der Freigabe fehlen. Der Agent-Start ruft
# system.apply (nutzer.apply → freigaben.apply → snapshots.apply) und muss Nutzer (gleiche uid), Gruppen, Freigabe, Rechte
# und Includes wiederherstellen; danach klappen Web- und SMB-Anmeldung, und die Rechte greifen wie vorher.
# Ubuntu 26.04, root, Loop-Geräte nötig (--privileged). Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd smbclient pdbedit btrfs losetup mkfs.btrfs setfacl getfacl userdel
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots" FAHNAS_DATEN="$POOL"
umgebung_vorbereiten
melde "== 07 Wiederaufbau aus der Konfiguration =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET unter $POOL"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SNAPSHOTS"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung (Admin $ADMIN_NAME)" ersteinrichtung_durchfuehren

# --- Ausgangslage: zweiter Nutzer, Freigabe mit Lese-/Schreibrecht --------------------------------------------------------------
LESER="$(agent_aktion nutzer.anlegen "{\"name\":\"leser\",\"anzeigename\":\"Leser\",\"passwort\":\"$ADMIN_PW\",\"rolle\":\"nutzer\"}")"
enthaelt "Zweiter Nutzer „leser“ angelegt" '"ok":true' "$LESER"
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"lesen\":[\"leser\"],\"schreiben\":[\"$ADMIN_NAME\"]}")"
enthaelt "Rechte gesetzt: leser liest, $ADMIN_NAME schreibt" '"ok":true' "$AEND"
UID_ADMIN="$(id -u "$ADMIN_NAME")"; UID_LESER="$(id -u leser)"
enthaelt "users.json führt die uid von $ADMIN_NAME ($UID_ADMIN)" "\"uid\": $UID_ADMIN" "$(cat "$FAHNAS_CONFIG/users.json")"
bedingung "Samba-Passwortdatenbank liegt in der Konfiguration (private dir)" -f "$FAHNAS_CONFIG/samba/passdb.tdb"

# --- „Neuinstallation“: Konfiguration + Samba-DB bleiben (Datenpartition übernommen), das System ist frisch ----------------------
agent_web_stoppen
linux_nutzer_entfernen "$ADMIN_NAME" leser
rm -f "$FAHNAS_SAMBA/$FREIGABE.conf"; printf '# FAH-NAS Test (frisches System)\n' > "$FAHNAS_SAMBA/alle.conf"
btrfs subvolume delete "$FAHNAS_SHARES/$FREIGABE" >/dev/null 2>&1 || rm -rf "$FAHNAS_SHARES/$FREIGABE"
bedingung "Vorbereitung: Linux-Konto $ADMIN_NAME fehlt" -z "$(getent passwd "$ADMIN_NAME" || true)"
bedingung "Vorbereitung: Linux-Konto leser fehlt" -z "$(getent passwd leser || true)"
bedingung "Vorbereitung: Freigabe-Unterlaufwerk fehlt" ! -e "$FAHNAS_SHARES/$FREIGABE"
bedingung "Vorbereitung: Include-Datei fehlt" ! -e "$FAHNAS_SAMBA/$FREIGABE.conf"
bedingung "Vorbereitung: users.json vorhanden" -s "$FAHNAS_CONFIG/users.json"
bedingung "Vorbereitung: shares.json vorhanden" -s "$FAHNAS_CONFIG/shares.json"

# --- Agent-Start = system.apply ---------------------------------------------------------------------------------------------------
pruefe "Agent und Web erneut starten (apply beim Start)" dienste_starten
pruefe "Linux-Konto $ADMIN_NAME wiederhergestellt" warte_bis 30 getent passwd "$ADMIN_NAME"
pruefe "Linux-Konto leser wiederhergestellt" warte_bis 30 getent passwd leser
pruefe "Freigabe-Unterlaufwerk wieder angelegt" warte_bis 30 test -d "$FAHNAS_SHARES/$FREIGABE"
pruefe "Include-Datei wieder da" warte_bis 30 test -f "$FAHNAS_SAMBA/$FREIGABE.conf"
bedingung "uid von $ADMIN_NAME unverändert ($UID_ADMIN)" "$(id -u "$ADMIN_NAME" 2>/dev/null)" = "$UID_ADMIN"
bedingung "uid von leser unverändert ($UID_LESER)" "$(id -u leser 2>/dev/null)" = "$UID_LESER"
enthaelt "$ADMIN_NAME ohne Anmeldeshell" 'nologin' "$(getent passwd "$ADMIN_NAME")"
enthaelt "$ADMIN_NAME in Gruppe fahnas-nutzer" 'fahnas-nutzer' "$(id -nG "$ADMIN_NAME" 2>/dev/null)"
enthaelt "$ADMIN_NAME in Gruppe fahnas-admin" 'fahnas-admin' "$(id -nG "$ADMIN_NAME" 2>/dev/null)"
bedingung "Freigabe ist ein btrfs-Unterlaufwerk" "$(stat -c %i "$FAHNAS_SHARES/$FREIGABE" 2>/dev/null)" = "256"
enthaelt "Rechte 2770 auf der Freigabe" '^2770$' "$(stat -c '%a' "$FAHNAS_SHARES/$FREIGABE" 2>/dev/null)"
ACL="$(getfacl -p "$FAHNAS_SHARES/$FREIGABE" 2>/dev/null)"
enthaelt "ACL: $ADMIN_NAME rwx" "user:$ADMIN_NAME:rwx" "$ACL"
enthaelt "ACL: leser r-x" 'user:leser:r-x' "$ACL"
enthaelt "alle.conf bindet die Freigabe wieder ein" "include = .*/$FREIGABE\.conf" "$(cat "$FAHNAS_SAMBA/alle.conf")"
pruefe "testparm akzeptiert die Gesamtkonfiguration" testparm -s --suppress-prompt /etc/samba/smb.conf
enthaelt "Samba-Konto $ADMIN_NAME weiterhin in der passdb (pdbedit -L)" "^$ADMIN_NAME:" "$(pdbedit -L 2>/dev/null)"
STATUS="$(node "$WURZEL/tools/fahnas" status 2>&1)"
enthaelt "fahnas status ohne Ersteinrichtungs-Hinweis" 'FAH-NAS' "$STATUS"
bedingung "fahnas status verlangt keine Ersteinrichtung" -z "$(printf '%s' "$STATUS" | grep -F 'Ersteinrichtung' || true)"

# --- Anmeldung klappt: Web (users.json) und SMB (Samba-DB + neues Linux-Konto mit alter uid) ---------------------------------------
rm -f "$KEKSE"
ANM="$(api_post /api/anmelden "{\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\"}")"
enthaelt "Web-Anmeldung $ADMIN_NAME" '"ok":true' "$ANM"
LISTE="$(smbclient -L //127.0.0.1 -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 2>&1)"
enthaelt "SMB-Anmeldung: smbclient -L zeigt die Freigabe" "^\s*$FREIGABE\s+Disk" "$LISTE"
printf 'nach dem Wiederaufbau %s\n' "$(date +%s)" > "$IT/neu.txt"
pruefe "Datei per SMB als $ADMIN_NAME schreiben" smbclient "//127.0.0.1/$FREIGABE" -U "$ADMIN_NAME%$ADMIN_PW" -m SMB3 -c "put $IT/neu.txt neu.txt"
enthaelt "Datei gehört uid $UID_ADMIN ($ADMIN_NAME)" "^$UID_ADMIN$" "$(stat -c '%u' "$FAHNAS_SHARES/$FREIGABE/neu.txt" 2>/dev/null)"
LISTE_L="$(smbclient "//127.0.0.1/$FREIGABE" -U "leser%$ADMIN_PW" -m SMB3 -c "ls" 2>&1)"
enthaelt "leser darf lesen (ls zeigt neu.txt)" 'neu\.txt' "$LISTE_L"
SCHREIB="$(smbclient "//127.0.0.1/$FREIGABE" -U "leser%$ADMIN_PW" -m SMB3 -c "put $IT/neu.txt verboten.txt" 2>&1 || true)"
enthaelt "leser darf weiterhin nicht schreiben (ACCESS_DENIED)" 'ACCESS_DENIED|Permission denied|NT_STATUS_' "$SCHREIB"
bedingung "Keine Datei verboten.txt angelegt" ! -e "$FAHNAS_SHARES/$FREIGABE/verboten.txt"

ergebnis
