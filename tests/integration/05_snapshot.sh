#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 05: btrfs-Loop-Pool → Freigabe → Schnappschuss (nur lesbar) → Datei endgültig löschen → im Schnappschuss
# durchsuchen → zurückholen (Aufgabe) → Inhalt gleich → Schnappschuss löschen.
# Ubuntu 26.04, root, Loop-Geräte nötig. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd btrfs losetup mkfs.btrfs setfacl cmp
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots"
umgebung_vorbereiten
melde "== 05 Schnappschuss =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SNAPSHOTS"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"

head -c 200000 /dev/urandom > "$IT/wichtig.bin"
HOCH="$(curl -sk -b "$KEKSE" -c "$KEKSE" -H "X-FAHNAS-CSRF: $(csrf_token)" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$IT/wichtig.bin" "$BASIS/api/dateien/hochladen?freigabe=$FREIGABE&pfad=&name=wichtig.bin")"
enthaelt "Datei hochgeladen" '"ok":true' "$HOCH"

SNAP="$(agent_aktion snapshots.erzeugen "{\"ziel\":\"$FREIGABE\",\"beschreibung\":\"Integrationstest\"}")"
enthaelt "Schnappschuss erzeugt" '"ok":true' "$SNAP"
ID="$(json_feld "$SNAP" ergebnis.id)"
bedingung "Schnappschuss hat eine id" -n "$ID"
bedingung "Schnappschuss liegt unter $FAHNAS_SNAPSHOTS/$FREIGABE/$ID" -d "$FAHNAS_SNAPSHOTS/$FREIGABE/$ID"
enthaelt "Schnappschuss ist nur lesbar (btrfs ro)" 'ro=true|Flags:\s+readonly' "$(btrfs property get "$FAHNAS_SNAPSHOTS/$FREIGABE/$ID" ro 2>&1; btrfs subvolume show "$FAHNAS_SNAPSHOTS/$FREIGABE/$ID" 2>&1)"
pruefe "Inhalt im Schnappschuss identisch" cmp "$IT/wichtig.bin" "$FAHNAS_SNAPSHOTS/$FREIGABE/$ID/wichtig.bin"
LISTE="$(agent_aktion snapshots.liste "{\"ziel\":\"$FREIGABE\"}")"
enthaelt "snapshots.liste zeigt den Schnappschuss" "\"id\":\"$ID\"" "$LISTE"

LOESCH="$(agent_aktion dateien.loeschen "{\"freigabe\":\"$FREIGABE\",\"pfade\":[\"wichtig.bin\"],\"endgueltig\":true}")"
enthaelt "Datei endgültig gelöscht" '"ok":true' "$LOESCH"
bedingung "Datei ist weg" ! -e "$FAHNAS_SHARES/$FREIGABE/wichtig.bin"

SUCHE="$(agent_aktion snapshots.durchsuchen "{\"ziel\":\"$FREIGABE\",\"id\":\"$ID\",\"pfad\":\"\"}")"
enthaelt "Durchsuchen zeigt wichtig.bin im Schnappschuss" '"name":"wichtig.bin"' "$SUCHE"

ZURUECK="$(agent_aktion snapshots.zurueckholen "{\"freigabe\":\"$FREIGABE\",\"id\":\"$ID\",\"pfade\":[\"wichtig.bin\"],\"ziel_pfad\":\"\"}")"
AUFGABE="$(json_feld "$ZURUECK" aufgabe)"
bedingung "Zurückholen läuft als Aufgabe" -n "$AUFGABE"
if ERG="$(aufgabe_abwarten "$AUFGABE")"; then ok "Aufgabe fertig"; else schlecht "Aufgabe nicht fertig: $ERG"; fi
bedingung "Datei ist zurück" -f "$FAHNAS_SHARES/$FREIGABE/wichtig.bin"
pruefe "Inhalt nach dem Zurückholen identisch" cmp "$IT/wichtig.bin" "$FAHNAS_SHARES/$FREIGABE/wichtig.bin"
enthaelt "Zurückgeholte Datei gehört dem Nutzer" "^$ADMIN_NAME$" "$(stat -c '%U' "$FAHNAS_SHARES/$FREIGABE/wichtig.bin")"

WEG="$(agent_aktion snapshots.loeschen "{\"ziel\":\"$FREIGABE\",\"id\":\"$ID\"}")"
enthaelt "Schnappschuss löschen" '"ok":true' "$WEG"
bedingung "Schnappschuss-Ordner entfernt" ! -e "$FAHNAS_SNAPSHOTS/$FREIGABE/$ID"

ergebnis
