#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 04: Dateimanager über die Web-API mit curl – Hochladen (Datenkanal), Liste, Herunterladen (Vergleich),
# Ordner, Umbenennen, Löschen in den Papierkorb, Papierkorb-Liste, Wiederherstellen, Leeren, ZIP-Download eines Ordners.
# Ubuntu 26.04, root, Loop-Geräte nötig. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd btrfs losetup mkfs.btrfs setfacl zip unzip cmp
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots"
umgebung_vorbereiten
melde "== 04 Dateimanager =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"

# Hochladen (Rohdaten, Content-Length setzt curl)
head -c 3000000 /dev/urandom > "$IT/probe.bin"
HOCH="$(curl -sk -b "$KEKSE" -c "$KEKSE" -H "X-FAHNAS-CSRF: $(csrf_token)" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$IT/probe.bin" "$BASIS/api/dateien/hochladen?freigabe=$FREIGABE&pfad=&name=probe.bin")"
enthaelt "Hochladen ok" '"ok":true' "$HOCH"
bedingung "Datei liegt in der Freigabe" -f "$FAHNAS_SHARES/$FREIGABE/probe.bin"
pruefe "Inhalt auf der Platte identisch" cmp "$IT/probe.bin" "$FAHNAS_SHARES/$FREIGABE/probe.bin"
enthaelt "Datei gehört dem anfragenden Nutzer (nicht root)" "^$ADMIN_NAME$" "$(stat -c '%U' "$FAHNAS_SHARES/$FREIGABE/probe.bin")"

LISTE="$(agent_aktion dateien.liste "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"\"}")"
enthaelt "dateien.liste zeigt probe.bin" '"name":"probe.bin"' "$LISTE"
enthaelt "dateien.liste Größe 3000000" '"groesse":3000000' "$LISTE"

curl -sk -b "$KEKSE" -o "$IT/probe_zurueck.bin" -D "$IT/kopf.txt" "$BASIS/api/dateien/herunterladen?freigabe=$FREIGABE&pfad=probe.bin"
enthaelt "Herunterladen: Content-Disposition attachment" 'content-disposition: attachment' "$(tr 'A-Z' 'a-z' < "$IT/kopf.txt")"
pruefe "Heruntergeladener Inhalt identisch" cmp "$IT/probe.bin" "$IT/probe_zurueck.bin"

ORDNER="$(agent_aktion dateien.ordner "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"\",\"name\":\"bilder\"}")"
enthaelt "Ordner anlegen" '"ok":true' "$ORDNER"
bedingung "Ordner existiert" -d "$FAHNAS_SHARES/$FREIGABE/bilder"
UMB="$(agent_aktion dateien.umbenennen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"bilder\",\"neuer_name\":\"fotos\"}")"
enthaelt "Umbenennen" '"ok":true' "$UMB"
bedingung "Umbenannter Ordner existiert" -d "$FAHNAS_SHARES/$FREIGABE/fotos"
FLUCHT="$(agent_aktion dateien.liste "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"../../etc\"}")"
enthaelt "Pfadflucht wird abgelehnt (E_PARAMS)" '"code":"E_PARAMS"' "$FLUCHT"

# Papierkorb
LOESCH="$(agent_aktion dateien.loeschen "{\"freigabe\":\"$FREIGABE\",\"pfade\":[\"probe.bin\"]}")"
enthaelt "Löschen in den Papierkorb" '"ok":true' "$LOESCH"
bedingung "Datei weg aus der Freigabe" ! -e "$FAHNAS_SHARES/$FREIGABE/probe.bin"
PAPIER="$(agent_aktion dateien.papierkorb.liste "{\"freigabe\":\"$FREIGABE\"}")"
enthaelt "Papierkorb-Liste enthält probe.bin" 'probe\.bin' "$PAPIER"
EINTRAG_ID="$(node -e 'const d=JSON.parse(process.argv[1]);const l=Array.isArray(d.ergebnis)?d.ergebnis:(d.ergebnis&&d.ergebnis.eintraege)||[];const e=l.find(x=>JSON.stringify(x).includes("probe.bin"));process.stdout.write(e?(e.id||""):"")' "$PAPIER")"
bedingung "Papierkorb-Eintrag hat eine id" -n "$EINTRAG_ID"
WIEDER="$(agent_aktion dateien.papierkorb.wiederherstellen "{\"freigabe\":\"$FREIGABE\",\"eintraege\":[{\"id\":\"$EINTRAG_ID\"}]}")"
enthaelt "Wiederherstellen" '"ok":true' "$WIEDER"
bedingung "Datei wieder da" -f "$FAHNAS_SHARES/$FREIGABE/probe.bin"
pruefe "Inhalt nach Wiederherstellen identisch" cmp "$IT/probe.bin" "$FAHNAS_SHARES/$FREIGABE/probe.bin"
LEER="$(agent_aktion dateien.papierkorb.leeren "{\"freigabe\":\"$FREIGABE\"}")"
enthaelt "Papierkorb leeren" '"ok":true' "$LEER"

# ZIP eines Ordners
cp "$IT/hallo.txt" "$FAHNAS_SHARES/$FREIGABE/fotos/a.txt" 2>/dev/null || printf 'a\n' > "$FAHNAS_SHARES/$FREIGABE/fotos/a.txt"
chown "$ADMIN_NAME:fahnas-nutzer" "$FAHNAS_SHARES/$FREIGABE/fotos/a.txt"
curl -sk -b "$KEKSE" -o "$IT/fotos.zip" "$BASIS/api/dateien/herunterladen?freigabe=$FREIGABE&pfad=fotos&zip=1"
pruefe "ZIP-Download eines Ordners ist ein gültiges Archiv" unzip -tq "$IT/fotos.zip"
enthaelt "ZIP enthält a.txt" 'a\.txt' "$(unzip -l "$IT/fotos.zip")"

ergebnis
