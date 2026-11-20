#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Gemeinsamer Unterbau der Integrationstests (Ubuntu 26.04, root, Container mit --privileged oder VM).
# Wird von 01_…06_ mit „. "$(dirname "$0")/_gemeinsam.sh"“ eingebunden. Kein Testinhalt hier.
#
# Stellt bereit: Prüf-Helfer (pruefe, bedingung, ergebnis), Arbeitsumgebung mit FAHNAS_*-Umgebungsvariablen unter
# $FAHNAS_IT (Standard /tmp/fahnas-it), Start/Stopp von Agent und Web, Samba-Vorbereitung, btrfs-Loop-Pools,
# Web-API-Aufrufe mit Sitzung/CSRF, Ersteinrichtung, Aufgaben abwarten. Alles räumt über die EXIT-Falle auf.
set -uo pipefail

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IT="${FAHNAS_IT:-/tmp/fahnas-it}"
PORT_WEB="${FAHNAS_IT_PORT:-18443}"
PORT_HTTP="${FAHNAS_IT_HTTP:-18080}"
ADMIN_NAME="${FAHNAS_IT_ADMIN:-admin}"
ADMIN_PW="${FAHNAS_IT_PASSWORT:-Testpasswort-2026!}"
FREIGABE="${FAHNAS_IT_FREIGABE:-test}"
BASIS="https://127.0.0.1:$PORT_WEB"
KEKSE="$IT/kekse.txt"
OK_ANZAHL=0; FEHLER_ANZAHL=0
PID_AGENT=""; PID_WEB=""; PID_SMBD=""
LOOP_GERAETE=""; EINHAENGUNGEN=""

# --- Ausgabe -------------------------------------------------------------------------------------------------------------
_farbe() { [ -t 1 ] && printf '\033[%sm%s\033[0m' "$1" "$2" || printf '%s' "$2"; }
melde() { printf '%s\n' "$*"; }
ok() { OK_ANZAHL=$((OK_ANZAHL + 1)); printf '%s  %s\n' "$(_farbe 32 'OK    ')" "$*"; }
schlecht() { FEHLER_ANZAHL=$((FEHLER_ANZAHL + 1)); printf '%s  %s\n' "$(_farbe 31 'FEHLER')" "$*"; }

# pruefe "Beschreibung" befehl args… → OK/FEHLER je nach Exit-Code, Ausgabe nur im Fehlerfall
pruefe() {
    local text="$1"; shift
    local aus
    if aus="$("$@" 2>&1)"; then ok "$text"; else schlecht "$text"; printf '      Befehl: %s\n      Ausgabe: %s\n' "$*" "$(printf '%s' "$aus" | tail -5)"; return 1; fi
}
# bedingung "Beschreibung" test-Argumente… → OK/FEHLER
bedingung() { local text="$1"; shift; if test "$@"; then ok "$text"; else schlecht "$text ($*)"; return 1; fi; }
# enthaelt "Beschreibung" "muster" "text"
enthaelt() { local text="$1" muster="$2" inhalt="$3"; if printf '%s' "$inhalt" | grep -Eq -- "$muster"; then ok "$text"; else schlecht "$text (erwartet /$muster/, bekommen: $(printf '%s' "$inhalt" | head -c 300))"; return 1; fi; }
ergebnis() {
    melde ""; melde "Ergebnis: $OK_ANZAHL in Ordnung, $FEHLER_ANZAHL fehlgeschlagen."
    [ "$FEHLER_ANZAHL" -eq 0 ] && exit 0 || exit 1
}
braucht() {   # braucht befehl… → Exit 3 („übersprungen“), wenn ein Werkzeug fehlt
    local w fehlt=""
    for w in "$@"; do command -v "$w" >/dev/null 2>&1 || fehlt="$fehlt $w"; done
    [ -z "$fehlt" ] || { melde "ÜBERSPRUNGEN: Werkzeuge fehlen:$fehlt (siehe tests/integration/README.md)"; exit 3; }
}
als_root() { [ "$(id -u)" = "0" ] || { melde "ÜBERSPRUNGEN: muss als root laufen"; exit 3; }; }
json_feld() {   # json_feld '<json>' 'pfad.zum.feld' → Wert (Zeichenkette) oder leer
    node -e 'let d=JSON.parse(process.argv[1]);for(const t of process.argv[2].split(".")){if(d==null)break;d=d[t];}process.stdout.write(d===undefined||d===null?"":(typeof d==="object"?JSON.stringify(d):String(d)))' "$1" "$2" 2>/dev/null
}

# --- Umgebung -------------------------------------------------------------------------------------------------------------
reste_beseitigen() {   # Prozesse, Einhängungen, Loop-Geräte und Arbeitsordner eines abgebrochenen/vorigen Laufs wegräumen
    local p
    for p in $(pgrep -f "node src/(agent/agent|web/web)\.js" 2>/dev/null); do kill "$p" 2>/dev/null || true; done
    sleep 0.3
    for p in $(pgrep -f "node src/(agent/agent|web/web)\.js" 2>/dev/null); do kill -9 "$p" 2>/dev/null || true; done
    if ! command -v systemctl >/dev/null 2>&1 || ! systemctl is-system-running >/dev/null 2>&1; then pkill -x smbd 2>/dev/null || true; fi
    if [ -d "$IT" ]; then
        local m; for m in $(findmnt -rn -o TARGET 2>/dev/null | grep -E "^$IT(/|$)" | sort -r); do umount -R "$m" 2>/dev/null || true; done
        local g; for g in $(losetup -a 2>/dev/null | grep -F "$IT/" | cut -d: -f1); do losetup -d "$g" 2>/dev/null || true; done
        rm -rf "$IT"
    fi
}

umgebung_vorbereiten() {   # Ordner + FAHNAS_*-Variablen; Gruppen wie der Erststart. Beginnt immer mit leerem $IT.
    reste_beseitigen
    mkdir -p "$IT"
    export FAHNAS_CONFIG="$IT/config" FAHNAS_RUN="$IT/run" FAHNAS_SAMBA="$IT/samba" FAHNAS_AVAHI="$IT/avahi" FAHNAS_STARTCODE="$IT/etc/startcode"
    export FAHNAS_SHARES="${FAHNAS_SHARES:-$IT/shares}" FAHNAS_SNAPSHOTS="${FAHNAS_SNAPSHOTS:-$IT/snapshots}" FAHNAS_BACKUP="$IT/backup"
    # FAHNAS_DATEN = Wurzel des btrfs-Pools („btrfs quota enable“ für Kontingente) – Skripte mit Loop-Pool setzen sie auf $POOL,
    # sonst zielte der Agent auf /data, das es im Container nicht gibt (Fund R2-11).
    export FAHNAS_DATEN="${FAHNAS_DATEN:-$IT}"
    # Chat-Speicher (0.21.0): der Agent legt ihn beim Start an – ohne die Variable als /data/chat im Testsystem
    export FAHNAS_CHAT="${FAHNAS_CHAT:-$IT/chat}"
    export FAHNAS_NFT="$IT/etc/fahnas.nft" FAHNAS_SNAPPER="$IT/etc/snapper" FAHNAS_SNAPPER_DEFAULT="$IT/etc/snapper-default" FAHNAS_SYSTEMD="$IT/etc/systemd"
    export FAHNAS_ISSUE_D="$IT/etc/issue.d" FAHNAS_MOTD_D="$IT/etc/motd.d"   # „fahnas startcode/issue“ schreiben nicht nach /etc
    export FAHNAS_PROGRAMM="$WURZEL" FAHNAS_WEB_PORT="$PORT_WEB" FAHNAS_HTTP_PORT="$PORT_HTTP"
    mkdir -p "$FAHNAS_CONFIG" "$FAHNAS_RUN" "$FAHNAS_SAMBA" "$FAHNAS_AVAHI" "$IT/etc" "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS" "$FAHNAS_BACKUP" "$FAHNAS_CONFIG/samba" "$FAHNAS_SNAPPER"
    chmod 0700 "$FAHNAS_CONFIG/samba"
    local g; for g in fahnas fahnas-nutzer fahnas-admin; do getent group "$g" >/dev/null || groupadd -r "$g"; done
    getent passwd fahnas >/dev/null || useradd --system --gid fahnas --shell /usr/sbin/nologin --no-create-home fahnas 2>/dev/null || true
    chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
    rm -f "$KEKSE"
}

samba_vorbereiten() {   # globale smb.conf aus dem Renderer (mit Testpfaden) + Include; smbd im Vordergrund starten, wenn kein systemd
    mkdir -p /etc/samba "$FAHNAS_SAMBA" /run/samba /var/log/samba
    [ -f /etc/samba/smb.conf ] && [ ! -f /etc/samba/smb.conf.vor-fahnas-test ] && cp /etc/samba/smb.conf /etc/samba/smb.conf.vor-fahnas-test
    node -e 'import(process.argv[1]).then(m=>process.stdout.write(m.globaleVorlage({sambaOrdner:process.argv[2],konfigOrdner:process.argv[3]})))' \
        "$WURZEL/src/agent/render/samba.js" "$FAHNAS_SAMBA" "$FAHNAS_CONFIG" > /etc/samba/smb.conf || return 1
    [ -f "$FAHNAS_SAMBA/alle.conf" ] || printf '# FAH-NAS Test\n' > "$FAHNAS_SAMBA/alle.conf"
    testparm -s --suppress-prompt /etc/samba/smb.conf >/dev/null 2>&1 || { testparm -s --suppress-prompt /etc/samba/smb.conf; return 1; }
    if pidof smbd >/dev/null 2>&1; then smbcontrol all reload-config >/dev/null 2>&1 || true
    elif command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then systemctl restart smbd
    # setsid: smbd (--no-process-group) beendet beim Stoppen seine ganze Prozessgruppe – ohne eigene Gruppe auch dieses Skript
    # und die Schale, die es aufrief (Exit 143)
    else setsid smbd --foreground --no-process-group >"$IT/smbd.log" 2>&1 & PID_SMBD=$!; pid_merken smbd "$PID_SMBD"; sleep 1; fi
    return 0
}

# Die PIDs stehen zusätzlich in $IT/<dienst>.pid: dienste_starten und samba_vorbereiten laufen meist in pruefe, also in einer
# Unterschale, deren Variablen nie zurückkommen – ohne die Dateien liefen die Dienste nach dem Skript weiter, und der
# „Neustart“ in 07 traf noch den alten Web-Dienst (der neue scheiterte an EADDRINUSE).
pid_merken() { printf '%s\n' "$2" > "$IT/$1.pid"; }   # pid_merken <agent|web|smbd> <pid>
pids_nachtragen() {
    [ -n "$PID_AGENT" ] || PID_AGENT="$(cat "$IT/agent.pid" 2>/dev/null)"
    [ -n "$PID_WEB" ] || PID_WEB="$(cat "$IT/web.pid" 2>/dev/null)"
    [ -n "$PID_SMBD" ] || PID_SMBD="$(cat "$IT/smbd.pid" 2>/dev/null)"
    return 0
}
dienste_starten() {   # Agent + Web im Hintergrund; wartet auf Socket und HTTPS-Antwort
    rm -f "$FAHNAS_RUN/agent.sock" "$FAHNAS_RUN/daten.sock"
    ( cd "$WURZEL" && exec node src/agent/agent.js ) >"$IT/agent.log" 2>&1 & PID_AGENT=$!
    pid_merken agent "$PID_AGENT"
    local i
    for i in $(seq 1 50); do [ -S "$FAHNAS_RUN/agent.sock" ] && break; sleep 0.2; done
    [ -S "$FAHNAS_RUN/agent.sock" ] || { melde "Agent startet nicht:"; tail -20 "$IT/agent.log"; return 1; }
    ( cd "$WURZEL" && exec node src/web/web.js ) >"$IT/web.log" 2>&1 & PID_WEB=$!
    pid_merken web "$PID_WEB"
    for i in $(seq 1 100); do curl -sk -o /dev/null "$BASIS/api/ersteinrichtung" 2>/dev/null && break; sleep 0.2; done
    curl -sk -o /dev/null "$BASIS/api/ersteinrichtung" || { melde "Web startet nicht:"; tail -20 "$IT/web.log"; return 1; }
    return 0
}
dienste_stoppen() {
    pids_nachtragen
    [ -n "$PID_WEB" ] && kill "$PID_WEB" 2>/dev/null; [ -n "$PID_AGENT" ] && kill "$PID_AGENT" 2>/dev/null
    [ -n "$PID_SMBD" ] && kill "$PID_SMBD" 2>/dev/null
    sleep 0.5
    [ -n "$PID_WEB" ] && kill -9 "$PID_WEB" 2>/dev/null; [ -n "$PID_AGENT" ] && kill -9 "$PID_AGENT" 2>/dev/null
    PID_WEB=""; PID_AGENT=""; PID_SMBD=""; rm -f "$IT/agent.pid" "$IT/web.pid" "$IT/smbd.pid"
    return 0
}
agent_web_stoppen() {   # nur Agent + Web beenden, smbd weiterlaufen lassen (Wiederaufbau-Test: „Neustart“ der Dienste)
    pids_nachtragen
    [ -n "$PID_WEB" ] && kill "$PID_WEB" 2>/dev/null; [ -n "$PID_AGENT" ] && kill "$PID_AGENT" 2>/dev/null
    sleep 0.5
    [ -n "$PID_WEB" ] && kill -9 "$PID_WEB" 2>/dev/null; [ -n "$PID_AGENT" ] && kill -9 "$PID_AGENT" 2>/dev/null
    PID_WEB=""; PID_AGENT=""; rm -f "$IT/agent.pid" "$IT/web.pid"
    return 0
}
warte_bis() {   # warte_bis <sekunden> befehl… → wartet im 0,5-s-Takt, bis der Befehl Exit 0 liefert (sonst Exit 1)
    local ende; ende=$(( $(date +%s) + $1 )); shift
    while ! "$@" >/dev/null 2>&1; do
        [ "$(date +%s)" -ge "$ende" ] && { "$@"; return 1; }
        sleep 0.5
    done
    return 0
}
linux_nutzer_entfernen() {   # Linux-Konten löschen (simuliert das frische System nach einer Neuinstallation; Samba-passdb bleibt)
    local n
    for n in "$@"; do getent passwd "$n" >/dev/null 2>&1 && { userdel "$n" 2>/dev/null || true; }; done
    return 0
}

# --- btrfs-Loop-Pool -------------------------------------------------------------------------------------------------------
btrfs_pool_anlegen() {   # btrfs_pool_anlegen <label> <groesse z. B. 2G> <einhaengepunkt> → gibt das Loop-Gerät aus
    local label="$1" groesse="$2" ziel="$3" bild="$IT/$1.img" geraet
    mkdir -p "$ziel"
    rm -f "$bild"; truncate -s "$groesse" "$bild"
    geraet="$(loop_anhaengen "$bild")" || return 1
    LOOP_GERAETE="$geraet $LOOP_GERAETE"
    mkfs.btrfs -q -f -L "$label" "$geraet" >/dev/null || return 1
    mount -t btrfs -o compress=zstd:1,noatime "$geraet" "$ziel" || return 1
    EINHAENGUNGEN="$ziel $EINHAENGUNGEN"
    printf '%s' "$geraet"
}
loop_anhaengen() {   # losetup --find --show mit Nachlegen fehlender /dev/loopN-Knoten (privilegierter Container)
    local bild="$1" aus geraet versuch
    for versuch in 1 2 3; do
        if aus="$(losetup --find --show "$bild" 2>&1)"; then printf '%s' "$aus"; return 0; fi
        geraet="$(printf '%s' "$aus" | sed -n 's/.*device node \(\/dev\/loop[0-9]*\) (7:\([0-9]*\)) is lost.*/\1 \2/p' | head -1)"
        [ -n "$geraet" ] || { melde "$aus"; return 1; }
        mknod "${geraet%% *}" b 7 "${geraet##* }" 2>/dev/null || true
    done
    melde "$aus"; return 1
}
loop_aufraeumen() {
    local m g
    for m in $EINHAENGUNGEN; do umount -R "$m" 2>/dev/null || true; done
    for g in $LOOP_GERAETE; do losetup -d "$g" 2>/dev/null || true; done
    EINHAENGUNGEN=""; LOOP_GERAETE=""
}
aufraeumen() {
    dienste_stoppen; loop_aufraeumen
    local m; for m in $(findmnt -rn -o TARGET 2>/dev/null | grep -E "^$IT(/|$)" | sort -r); do umount -R "$m" 2>/dev/null || true; done
    local g; for g in $(losetup -a 2>/dev/null | grep -F "$IT/" | cut -d: -f1); do losetup -d "$g" 2>/dev/null || true; done
}
trap aufraeumen EXIT

# --- Web-API ----------------------------------------------------------------------------------------------------------------
csrf_token() { awk '$6 == "fahnas_csrf" { print $7 }' "$KEKSE" 2>/dev/null | tail -1; }
api_get() { curl -sk -b "$KEKSE" -c "$KEKSE" "$BASIS$1"; }
api_post() {   # api_post <pfad> '<json>'
    curl -sk -b "$KEKSE" -c "$KEKSE" -H 'Content-Type: application/json' -H "X-FAHNAS-CSRF: $(csrf_token)" -X POST --data-binary "$2" "$BASIS$1"
}
agent_aktion() { api_post "/api/agent/$1" "${2:-{\}}"; }
aufgabe_abwarten() {   # aufgabe_abwarten <id> → gibt den Aufgaben-Eintrag (JSON) aus, Exit 1 bei Fehler/Abbruch/Zeit
    local id="$1" i liste eintrag status
    for i in $(seq 1 150); do
        liste="$(agent_aktion agent.aufgaben '{}')"
        eintrag="$(node -e 'const d=JSON.parse(process.argv[1]);const a=(d.ergebnis||[]).find(x=>x.id===process.argv[2]);process.stdout.write(a?JSON.stringify(a):"")' "$liste" "$id")"
        status="$(json_feld "$eintrag" status)"
        case "$status" in fertig) printf '%s' "$eintrag"; return 0 ;; fehler|abgebrochen) printf '%s' "$eintrag"; return 1 ;; esac
        sleep 0.2
    done
    printf '%s' "$eintrag"; return 1
}
ersteinrichtung_durchfuehren() {   # Startcode erzeugen, ersten Admin anlegen (meldet direkt an)
    local code antwort
    mkdir -p "$(dirname "$FAHNAS_STARTCODE")"
    node "$WURZEL/tools/fahnas" startcode >/dev/null || return 1
    code="$(tr -d '[:space:]' < "$FAHNAS_STARTCODE")"
    antwort="$(api_post /api/ersteinrichtung "{\"startcode\":\"$code\",\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\",\"anzeigename\":\"Test-Admin\"}")"
    [ "$(json_feld "$antwort" ok)" = "true" ] || { melde "Ersteinrichtung fehlgeschlagen: $antwort"; return 1; }
    [ "$(json_feld "$antwort" ergebnis.angemeldet)" = "true" ] || {
        antwort="$(api_post /api/anmelden "{\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\"}")"
        [ "$(json_feld "$antwort" ok)" = "true" ] || { melde "Anmeldung fehlgeschlagen: $antwort"; return 1; }
    }
    return 0
}
freigabe_anlegen() {   # freigabe_anlegen <name> → Freigabe mit Schreibrecht für den Admin
    local antwort
    antwort="$(agent_aktion freigaben.anlegen "{\"name\":\"$1\",\"beschreibung\":\"Integrationstest\",\"schreiben\":[\"$ADMIN_NAME\"]}")"
    [ "$(json_feld "$antwort" ok)" = "true" ] || { melde "freigaben.anlegen: $antwort"; return 1; }
    return 0
}
