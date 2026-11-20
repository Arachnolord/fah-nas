#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 08: Export/Import der Konfiguration über Kommandozeile und Agenten. Export ohne Geheimnisse darf weder
# Passwort-Hashes noch samba/ (NT-Hashes, SID), links.json (Download-Token), web/tls, Sitzungen oder Bremse enthalten
# (Fund R1-2); Export mit Geheimnissen trägt die Hashes; verschlüsselter Export (.fahnas, Kopf FAHNAS1) ist kein lesbares
# tar. Import zeigt Unterschiede (neue Freigabe fehlt im Archiv, geänderte Beschreibung), --anwenden stellt den Stand her
# und rendert (verwaister Samba-Include verschwindet); falsches Passwort wird abgelehnt.
# Ubuntu 26.04, root, Loop-Geräte nötig (--privileged). Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd tar btrfs losetup mkfs.btrfs setfacl
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots" FAHNAS_DATEN="$POOL"
umgebung_vorbereiten
melde "== 08 Export / Import =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SNAPSHOTS"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"

# Eine Datei und ein Freigabe-Link, damit links.json (Token = Geheimnis) existiert
printf 'nur fuer den Link\n' > "$IT/link.txt"
HOCH="$(curl -sk -b "$KEKSE" -c "$KEKSE" -H "X-FAHNAS-CSRF: $(csrf_token)" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$IT/link.txt" "$BASIS/api/dateien/hochladen?freigabe=$FREIGABE&pfad=&name=link.txt")"
enthaelt "Datei hochgeladen" '"ok":true' "$HOCH"
LINK="$(agent_aktion dateien.link.anlegen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"link.txt\",\"gueltig_h\":1}")"
enthaelt "Freigabe-Link angelegt" '"token"' "$LINK"
bedingung "links.json vorhanden" -s "$FAHNAS_CONFIG/links.json"
bedingung "TLS-Schlüssel des Web-Dienstes vorhanden" -s "$FAHNAS_CONFIG/web/tls/key.pem"
bedingung "Samba-Passwortdatenbank unter config/samba" -f "$FAHNAS_CONFIG/samba/passdb.tdb"

# --- Export ohne Geheimnisse (CLI liest die Konfiguration direkt, kein Agent nötig) ------------------------------------------------
pruefe "fahnas export (ohne Geheimnisse)" node "$WURZEL/tools/fahnas" export "$IT/ohne.tar"
OHNE="$(tar -tf "$IT/ohne.tar")"
for d in users.json shares.json system.json version.json snapshots.json; do
    enthaelt "Export ohne Geheimnisse enthält $d" "(^|/)$d\$" "$OHNE"
done
for d in samba/ links.json web/tls web/sitzungen.json web/bremse.json eingang; do
    bedingung "Export ohne Geheimnisse enthält NICHT $d" -z "$(printf '%s\n' "$OHNE" | grep -F "$d" || true)"
done
mkdir -p "$IT/ohne"; tar -C "$IT/ohne" -xf "$IT/ohne.tar"
USERS_OHNE="$(find "$IT/ohne" -name users.json | head -1)"
bedingung "users.json ohne Geheimnisse hat keinen Hash" -z "$(grep -F '"hash"' "$USERS_OHNE" || true)"
enthaelt "users.json ohne Geheimnisse kennt den Admin" "\"name\": \"$ADMIN_NAME\"" "$(cat "$USERS_OHNE")"

# --- Export mit Geheimnissen ---------------------------------------------------------------------------------------------------------
pruefe "fahnas export --mit-geheimnissen" node "$WURZEL/tools/fahnas" export "$IT/mit.tar" --mit-geheimnissen
MIT="$(tar -tf "$IT/mit.tar")"
mkdir -p "$IT/mit"; tar -C "$IT/mit" -xf "$IT/mit.tar"
enthaelt "users.json mit Geheimnissen trägt den scrypt-Hash" 'scrypt\$' "$(cat "$(find "$IT/mit" -name users.json | head -1)")"
for d in web/sitzungen.json web/bremse.json eingang; do
    bedingung "Export mit Geheimnissen enthält NICHT $d" -z "$(printf '%s\n' "$MIT" | grep -F "$d" || true)"
done
bedingung "Exportdatei 0600" "$(stat -c '%a' "$IT/mit.tar")" = "600"

# --- Verschlüsselter Export (Passwort zweimal über stdin, kein Terminal) ---------------------------------------------------------------
printf 'Archiv-Passwort-1\nArchiv-Passwort-1\n' | node "$WURZEL/tools/fahnas" export "$IT/geheim" --mit-geheimnissen --passwort >"$IT/export_geheim.log" 2>&1 \
    && ok "fahnas export --passwort" || { schlecht "fahnas export --passwort"; cat "$IT/export_geheim.log"; }
bedingung "Verschlüsselte Datei $IT/geheim.fahnas angelegt" -s "$IT/geheim.fahnas"
enthaelt "Kopf FAHNAS1" '^FAHNAS1' "$(head -c 7 "$IT/geheim.fahnas")"
if tar -tf "$IT/geheim.fahnas" >/dev/null 2>&1; then schlecht "verschlüsseltes Archiv ist als tar lesbar"; else ok "verschlüsseltes Archiv ist kein lesbares tar"; fi

# --- Stand ändern: zweite Freigabe, Beschreibung der ersten ändern ---------------------------------------------------------------------
pruefe "Zweite Freigabe „zweite“ anlegen" freigabe_anlegen zweite
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"beschreibung\":\"geändert\"}")"
enthaelt "Beschreibung von $FREIGABE geändert" '"ok":true' "$AEND"
bedingung "Include zweite.conf existiert" -f "$FAHNAS_SAMBA/zweite.conf"

# --- Import: nur Unterschiede zeigen ---------------------------------------------------------------------------------------------------
AUS="$(node "$WURZEL/tools/fahnas" import "$IT/mit.tar" 2>&1)" || { schlecht "fahnas import (Unterschiede)"; printf '%s\n' "$AUS"; }
enthaelt "Import zeigt: „zweite“ fehlt im Archiv" 'fehlen im Archiv: zweite' "$AUS"
enthaelt "Import zeigt: „$FREIGABE“ geändert" "geändert: $FREIGABE" "$AUS"
enthaelt "Ohne --anwenden wird nichts geändert" 'Nichts geändert' "$AUS"
enthaelt "shares.json hat weiterhin „zweite“" '"zweite"' "$(cat "$FAHNAS_CONFIG/shares.json")"

# --- Import anwenden -----------------------------------------------------------------------------------------------------------------------
AUS2="$(node "$WURZEL/tools/fahnas" import "$IT/mit.tar" --anwenden 2>&1)" || { schlecht "fahnas import --anwenden"; printf '%s\n' "$AUS2"; }
enthaelt "Übernommen: shares.json" 'Übernommen:.*shares\.json' "$AUS2"
enthaelt "Übernommen: users.json" 'Übernommen:.*users\.json' "$AUS2"
bedingung "shares.json ohne „zweite“" -z "$(grep -F '"zweite"' "$FAHNAS_CONFIG/shares.json" || true)"
enthaelt "Beschreibung von $FREIGABE zurückgesetzt" '"beschreibung": "Integrationstest"' "$(cat "$FAHNAS_CONFIG/shares.json")"
pruefe "Verwaister Include zweite.conf nach apply entfernt" warte_bis 15 test ! -e "$FAHNAS_SAMBA/zweite.conf"
bedingung "Include $FREIGABE.conf bleibt" -f "$FAHNAS_SAMBA/$FREIGABE.conf"
bedingung "users.json nach Import 0600" "$(stat -c '%a' "$FAHNAS_CONFIG/users.json")" = "600"
bedingung "web/ vom Import nicht angefasst (TLS-Schlüssel bleibt)" -s "$FAHNAS_CONFIG/web/tls/key.pem"
rm -f "$KEKSE"
ANM="$(api_post /api/anmelden "{\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\"}")"
enthaelt "Anmeldung nach dem Import klappt (Hash übernommen)" '"ok":true' "$ANM"

# --- Verschlüsselter Import: falsches und richtiges Passwort ----------------------------------------------------------------------------
FALSCH="$(printf 'falsch-falsch\n' | node "$WURZEL/tools/fahnas" import "$IT/geheim.fahnas" 2>&1 || true)"
enthaelt "Falsches Archiv-Passwort abgelehnt" 'Passwort|E_PARAMS' "$FALSCH"
bedingung "Falsches Passwort ändert nichts (shares.json unverändert)" -z "$(grep -F '"zweite"' "$FAHNAS_CONFIG/shares.json" || true)"
RICHTIG="$(printf 'Archiv-Passwort-1\n' | node "$WURZEL/tools/fahnas" import "$IT/geheim.fahnas" 2>&1)" || { schlecht "fahnas import verschlüsselt"; printf '%s\n' "$RICHTIG"; }
enthaelt "Richtiges Passwort: Archiv gelesen und verglichen" 'im Vergleich zum aktuellen Stand' "$RICHTIG"
enthaelt "Verschlüsseltes Archiv = aktueller Stand (keine Unterschiede bei Freigaben)" 'Freigaben\s+keine Unterschiede' "$RICHTIG"

ergebnis
