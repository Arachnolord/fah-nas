#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 09: Kontingent je Freigabe. groesse_gb setzt ein btrfs-qgroup-Limit („btrfs quota enable“ auf der
# Pool-Wurzel FAHNAS_DATEN, „qgroup limit“ am Unterlaufwerk), freigaben.liste zeigt die Belegung aus der qgroup, ein
# Upload über die Grenze scheitert VOR der Übertragung mit E_PLATZ (Ticket-Prüfung), groesse_gb 0 hebt das Limit auf.
# Ubuntu 26.04, root, Loop-Geräte nötig (--privileged). Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd btrfs losetup mkfs.btrfs setfacl fallocate cmp
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots" FAHNAS_DATEN="$POOL"
umgebung_vorbereiten
melde "== 09 Kontingent (btrfs qgroup) =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 3G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET (3 GiB) unter $POOL = FAHNAS_DATEN"
# Umgebungsprüfung: manche Kernel (z. B. UGREEN 6.18 im Container) melden „quota enable“ als Erfolg, ohne Quoten einzuschalten
if btrfs quota enable "$POOL" >/dev/null 2>&1 && ! btrfs qgroup show "$POOL" >/dev/null 2>&1; then
    melde "ÜBERSPRUNGEN: btrfs-Quoten lassen sich auf diesem Kernel/Dateisystem nicht einschalten (qgroup show: quotas not enabled) – Kontingent-Test nicht möglich."
    exit 3
fi
btrfs quota disable "$POOL" >/dev/null 2>&1 || true
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SNAPSHOTS"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren

qgroup_max() { btrfs qgroup show -reF --raw "$1" 2>/dev/null | awk '/^[0-9]+\/[0-9]+/ { print $4; exit }'; }
belegt_laut_liste() {   # belegt_laut_liste '<freigaben.liste-Antwort>' <name> → Bytes
    node -e 'const d=JSON.parse(process.argv[1]);const l=Array.isArray(d.ergebnis)?d.ergebnis:[];const f=l.find(x=>x.name===process.argv[2]);process.stdout.write(f&&f.belegt!=null?String(f.belegt):"")' "$1" "$2"
}
hochladen() {   # hochladen <lokale datei> <name in der freigabe> → JSON-Antwort
    curl -sk --max-time 180 -b "$KEKSE" -c "$KEKSE" -H "X-FAHNAS-CSRF: $(csrf_token)" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$1" "$BASIS/api/dateien/hochladen?freigabe=$FREIGABE&pfad=&name=$2" || true
}

# --- Freigabe mit 1 GiB Kontingent ---------------------------------------------------------------------------------------------------------
ANL="$(agent_aktion freigaben.anlegen "{\"name\":\"$FREIGABE\",\"beschreibung\":\"Kontingent\",\"schreiben\":[\"$ADMIN_NAME\"],\"groesse_gb\":1}")"
enthaelt "Freigabe mit groesse_gb 1 angelegt" '"ok":true' "$ANL"
enthaelt "Ergebnis nennt groesse_gb 1" '"groesse_gb":1' "$ANL"
pruefe "btrfs-Quoten auf der Pool-Wurzel aktiv (qgroup show antwortet)" btrfs qgroup show "$POOL"
bedingung "qgroup-Limit der Freigabe = 1 GiB (max_rfer 1073741824)" "$(qgroup_max "$FAHNAS_SHARES/$FREIGABE")" = "1073741824"

# --- 200 MB passen ----------------------------------------------------------------------------------------------------------------------------
head -c 200000000 /dev/urandom > "$IT/a.bin"
HOCH1="$(hochladen "$IT/a.bin" a.bin)"
enthaelt "Upload 200 MB unter dem Kontingent klappt" '"ok":true' "$HOCH1"
bedingung "a.bin liegt in der Freigabe" -f "$FAHNAS_SHARES/$FREIGABE/a.bin"

# --- Freigabe bis ~900 MB füllen (fallocate = echte Belegung, unabhängig von der Kompression) ------------------------------------------------
pruefe "Freigabe mit 700 MB füllen (fallocate)" fallocate -l 700M "$FAHNAS_SHARES/$FREIGABE/fuellung.bin"
chown "$ADMIN_NAME:fahnas-nutzer" "$FAHNAS_SHARES/$FREIGABE/fuellung.bin"
sync; btrfs filesystem sync "$POOL" >/dev/null 2>&1 || true; sleep 1
LISTE="$(agent_aktion freigaben.liste '{}')"
BELEGT="$(belegt_laut_liste "$LISTE" "$FREIGABE")"
bedingung "freigaben.liste zeigt belegt ≥ 850 MB (ist: ${BELEGT:-?} Byte)" "${BELEGT:-0}" -ge 850000000
enthaelt "freigaben.liste zeigt groesse_gb 1" '"groesse_gb":1' "$LISTE"

# --- 300 MB überschreiten die Grenze → E_PLATZ, nichts angelegt --------------------------------------------------------------------------------
head -c 300000000 /dev/urandom > "$IT/b.bin"
HOCH2="$(hochladen "$IT/b.bin" b.bin)"
enthaelt "Upload über dem Kontingent scheitert mit E_PLATZ" '"code":"E_PLATZ"' "$HOCH2"
bedingung "b.bin wurde nicht angelegt" ! -e "$FAHNAS_SHARES/$FREIGABE/b.bin"
bedingung "a.bin unverändert vorhanden" -f "$FAHNAS_SHARES/$FREIGABE/a.bin"

# --- Kontingent aufheben (groesse_gb 0) → Upload klappt ------------------------------------------------------------------------------------------
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"groesse_gb\":0}")"
enthaelt "groesse_gb 0 angenommen" '"ok":true' "$AEND"
bedingung "qgroup-Limit aufgehoben (max_rfer none)" "$(qgroup_max "$FAHNAS_SHARES/$FREIGABE")" = "none"
HOCH3="$(hochladen "$IT/b.bin" b.bin)"
enthaelt "Upload 300 MB ohne Kontingent klappt" '"ok":true' "$HOCH3"
pruefe "Inhalt von b.bin identisch" cmp "$IT/b.bin" "$FAHNAS_SHARES/$FREIGABE/b.bin"
LISTE2="$(agent_aktion freigaben.liste '{}')"
enthaelt "freigaben.liste zeigt groesse_gb null" '"groesse_gb":null' "$LISTE2"

ergebnis
