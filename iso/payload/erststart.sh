#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# FAH-NAS – Erststart nach der Installation (root, aus fahnas-erststart.service). Idempotent: jeder Schritt hinterlässt
# /var/lib/fahnas/erststart/<schritt>.ok und wird danach übersprungen; „--erneut“ löscht die Markierungen (Reparatur).
# Bricht ein Schritt ab: Protokoll, Exit 1 → die Unit versucht es nach 60 s erneut, und bei jedem Systemstart, bis
# fertig.ok existiert. Protokoll: /var/log/fahnas-erststart.log, Kurzmeldungen auf tty1.
#
# Schritte: pakete · gruppen_nutzer · release · konfig_rechte* · startcode* · samba · snapper_grub · zram ·
#           firewall · docker · libvirt · dienste · konsole* · fertig        (* = läuft bei jedem Lauf, ohne Markierung)
# Die Firewall kommt VOR Docker/libvirt: unser Regelwerk fasst fremde Tabellen nie an (kein „flush ruleset“, kein
# „systemctl restart nftables“ – Debians ExecStop leert das gesamte Regelwerk inkl. Docker/libvirt).
#
# Rechte, die der Web-Dienst (Nutzer fahnas) braucht: /data/config 2750 root:fahnas (setgid → neue Dateien erben die
# Gruppe), system.json/shares.json/snapshots.json/version.json 0640 root:fahnas, users.json 0600 root, /data/config/web
# 0750 fahnas:fahnas (Sitzungen, TLS, Bremse, Web-Protokoll), /run/fahnas 0750 root:fahnas (systemd RuntimeDirectory).
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LOG=/var/log/fahnas-erststart.log
QUELLE=/opt/fahnas-install
PROGRAMM=/opt/fahnas
KONFIG=/data/config
MARKER=/var/lib/fahnas/erststart
STARTCODE=/etc/fahnas/startcode
PAKETE="samba samba-vfs-modules avahi-daemon btrfs-progs snapper inotify-tools nodejs docker.io docker-compose-v2 docker-buildx qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst zram-tools smartmontools lm-sensors hdparm nftables conntrack iproute2 zip unzip acl attr openssl curl tar zstd ntfs-3g exfatprogs dosfstools e2fsprogs xfsprogs hfsprogs udisks2 ffmpeg rsync unison cifs-utils smbclient wireguard-tools qrencode mdadm lvm2 i2c-tools gdisk"
GRUB_BTRFS_VERSION=""; GRUB_BTRFS_URL=""; GRUB_BTRFS_DATEI=""; GRUB_BTRFS_SHA256=""

# neuer_als <a> <b> → 0, wenn Version a NEUER als b ist (sort -V; leeres b = „nichts installiert“ → a ist neuer).
# „--erneut“ darf ein per „fahnas update“ eingespieltes Release nicht durch den älteren Stand des Mediums ersetzen.
neuer_als() {
    [ -n "${1:-}" ] || return 1
    [ -n "${2:-}" ] || return 0
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}
# Einheitstest-Haken (kein root nötig): erststart.sh --neuer-als <a> <b>
if [ "${1:-}" = "--neuer-als" ]; then neuer_als "${2:-}" "${3:-}"; exit $?; fi

[ "$(id -u)" = "0" ] || { echo "Muss als root laufen (sudo bash $0)." >&2; exit 1; }
mkdir -p "$MARKER" "$(dirname "$LOG")"
if [ "${1:-}" = "--erneut" ]; then rm -f "$MARKER"/*.ok; fi
exec >>"$LOG" 2>&1
echo "=== FAH-NAS Erststart $(date '+%d.%m.%Y %H:%M:%S') ==="
# shellcheck source=quellen.env
[ -f "$QUELLE/quellen.env" ] && . "$QUELLE/quellen.env"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
konsole() { printf '\n[FAH-NAS] %s\n' "$*" > /dev/tty1 2>/dev/null || true; }
fehlschlag() { log "FEHLER: $*"; return 1; }

# Führt einen Schritt in einer Unterschale mit set -e aus; Markierung nur bei Erfolg.
# Die Unterschale läuft bewusst NICHT als if-Bedingung: dort schaltet bash „set -e“ ab (auch in allen aufgerufenen
# Funktionen) – ein „… || fehlschlag“ mitten im Schritt wurde nur protokolliert und der Schritt trotzdem als OK markiert
# (Mini-PC 25.09.: „snapper kennt die Konfiguration root nicht“ → Schritt snapper_grub: OK).
schritt() {
    local name="$1" fn="$2" rc
    if [ -f "$MARKER/$name.ok" ]; then log "Schritt $name: schon erledigt"; return 0; fi
    log "--- Schritt $name ---"
    ( set -euo pipefail; "$fn" ); rc=$?
    if [ "$rc" -eq 0 ]; then
        touch "$MARKER/$name.ok"; log "Schritt $name: OK"
    else
        log "Schritt $name: FEHLGESCHLAGEN – Abbruch. Nächster Versuch in 60 s bzw. beim nächsten Systemstart."
        konsole "Einrichtung: Schritt „$name“ fehlgeschlagen – Einzelheiten in $LOG. Es wird automatisch erneut versucht."
        exit 1
    fi
}
schritt_immer() {   # ohne Markierung (billig und idempotent)
    local name="$1" fn="$2" rc
    log "--- Schritt $name ---"
    ( set -euo pipefail; "$fn" ); rc=$?
    if [ "$rc" -eq 0 ]; then log "Schritt $name: OK"; else
        log "Schritt $name: FEHLGESCHLAGEN – Abbruch."; konsole "Einrichtung: Schritt „$name“ fehlgeschlagen – siehe $LOG"; exit 1
    fi
}

warte_auf_internet() {   # höchstens 5 Minuten
    local i
    for i in $(seq 1 60); do
        if curl -fsI -m 5 http://archive.ubuntu.com/ubuntu/ >/dev/null 2>&1 || getent hosts archive.ubuntu.com >/dev/null 2>&1; then return 0; fi
        [ "$i" = "1" ] && konsole "Warte auf Internet (Pakete nachinstallieren) …"
        sleep 5
    done
    return 1
}

# Schlüssel in einer Konfigurationsdatei setzen (ersetzt auch auskommentierte Vorgaben), sonst anhängen.
setze_konfig() {
    local datei="$1" schluessel="$2" wert="$3"
    if grep -Eq "^[#[:space:]]*${schluessel}=" "$datei"; then
        sed -i -E "s|^[#[:space:]]*${schluessel}=.*|${schluessel}=${wert}|" "$datei"
    else
        printf '%s=%s\n' "$schluessel" "$wert" >> "$datei"
    fi
}

nutzer_vorhanden() {   # gibt es schon einen NAS-Nutzer in users.json?
    [ -f "$KONFIG/users.json" ] || return 1
    if command -v node >/dev/null 2>&1; then
        node -e 'const u=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Array.isArray(u.nutzer)&&u.nutzer.length?0:1)' "$KONFIG/users.json" 2>/dev/null
    else
        grep -q '"hash"' "$KONFIG/users.json"
    fi
}

# ---------------------------------------------------------------------------------------------------------------------
s_pakete() {
    local fehlend=() p versuch
    for p in $PAKETE; do
        dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || fehlend+=("$p")
    done
    if [ "${#fehlend[@]}" -eq 0 ]; then log "Alle Pakete vorhanden."; return 0; fi
    log "Fehlende Pakete: ${fehlend[*]}"
    konsole "Installiere ${#fehlend[@]} Pakete: ${fehlend[*]} …"
    warte_auf_internet || log "Kein Internet nach 5 Minuten – versuche apt trotzdem (eigener Spiegel/Proxy?)."
    for versuch in 1 2 3; do
        if apt-get -q update && apt-get -q -y -o Dpkg::Options::=--force-confold install "${fehlend[@]}"; then return 0; fi
        log "apt-Versuch $versuch fehlgeschlagen."; sleep 30
    done
    fehlschlag "Pakete konnten nicht installiert werden: ${fehlend[*]}"
}

s_gruppen_nutzer() {
    local g nutzer
    for g in fahnas fahnas-nutzer fahnas-admin; do getent group "$g" >/dev/null || groupadd -r "$g"; done
    getent passwd fahnas >/dev/null || useradd --system --gid fahnas --shell /usr/sbin/nologin --home-dir /nonexistent --no-create-home --comment "FAH-NAS Web-Dienst" fahnas
    nutzer="$(id -nu 1000 2>/dev/null || true)"
    if [ -n "$nutzer" ]; then
        for g in fahnas-admin docker libvirt; do getent group "$g" >/dev/null && usermod -aG "$g" "$nutzer"; done
        log "Installer-Benutzer $nutzer in Gruppen fahnas-admin, docker, libvirt."
    else
        log "Hinweis: kein Benutzer mit uid 1000."
    fi
    getent group fahnas >/dev/null && getent passwd fahnas >/dev/null
}

s_release() {
    local archiv="$QUELLE/fahnas_release.tar.gz" version alt
    [ -f "$archiv" ] || fehlschlag "Release-Archiv fehlt: $archiv"
    [ -f "$archiv.sha256" ] || fehlschlag "Prüfsumme fehlt: $archiv.sha256"
    (cd "$QUELLE" && sha256sum -c --quiet fahnas_release.tar.gz.sha256) || fehlschlag "Prüfsumme des Release-Archivs stimmt nicht"
    # „|| true“: ohne BUILD_VERSION im Archiv soll die eigene Meldung darunter greifen, nicht set -e an dieser Zuweisung
    version="$(tar -xzOf "$archiv" BUILD_VERSION 2>/dev/null | tr -d '[:space:]' || true)"
    [ -n "$version" ] || fehlschlag "BUILD_VERSION fehlt im Archiv"
    alt=""; [ -f "$PROGRAMM/BUILD_VERSION" ] && alt="$(tr -d '[:space:]' < "$PROGRAMM/BUILD_VERSION")"
    if [ "$alt" = "$version" ] && [ -f "$PROGRAMM/src/agent/agent.js" ]; then
        log "Programm $version liegt schon unter $PROGRAMM."
    elif [ -f "$PROGRAMM/src/agent/agent.js" ] && ! neuer_als "$version" "$alt"; then
        # Nur ersetzen, wenn das Medium NEUER ist (oder nichts Brauchbares liegt): nach „fahnas update“ ist der installierte
        # Stand jünger als das Installationsmedium – „--erneut“ darf ihn nicht still zurückdrehen.
        log "Installierter Stand $alt ist neuer als das Medium ($version) – belassen."
    else
        rm -rf "$PROGRAMM.neu"; mkdir -p "$PROGRAMM.neu"
        tar -C "$PROGRAMM.neu" --no-same-owner -xzf "$archiv"
        [ -f "$PROGRAMM.neu/src/agent/agent.js" ] || fehlschlag "Archiv enthält kein FAH-NAS (src/agent/agent.js fehlt)"
        rm -rf "$PROGRAMM.alt"
        [ -d "$PROGRAMM" ] && mv "$PROGRAMM" "$PROGRAMM.alt"
        mv "$PROGRAMM.neu" "$PROGRAMM"
        log "Programm $version nach $PROGRAMM entpackt."
    fi
    chmod 755 "$PROGRAMM/tools/fahnas" 2>/dev/null || true
    ln -sfn "$PROGRAMM/tools/fahnas" /usr/local/bin/fahnas
    command -v node >/dev/null || fehlschlag "node fehlt (Paket nodejs)"
    log "Node $(node --version)"
}

s_konfig_rechte() {
    local d f
    mountpoint -q /data || fehlschlag "/data ist nicht eingehängt – fstab prüfen"
    mountpoint -q "$KONFIG" || fehlschlag "$KONFIG ist nicht eingehängt (Unterlaufwerk @config)"
    chown root:root /data; chmod 0751 /data
    chown root:fahnas "$KONFIG"; chmod 2750 "$KONFIG"
    for d in protokoll apps vms eingang; do mkdir -p "$KONFIG/$d"; chown root:fahnas "$KONFIG/$d"; chmod 0750 "$KONFIG/$d"; done
    mkdir -p "$KONFIG/web"; chown fahnas:fahnas "$KONFIG/web"; chmod 0750 "$KONFIG/web"
    mkdir -p "$KONFIG/samba"; chown root:root "$KONFIG/samba"; chmod 0700 "$KONFIG/samba"
    for f in system.json shares.json snapshots.json version.json; do [ -f "$KONFIG/$f" ] && { chown root:fahnas "$KONFIG/$f"; chmod 0640 "$KONFIG/$f"; }; done
    [ -f "$KONFIG/users.json" ] && { chown root:root "$KONFIG/users.json"; chmod 0600 "$KONFIG/users.json"; }
    mkdir -p /data/shares /data/.snapshots /data/apps /data/vms /data/backup
    chown root:fahnas-nutzer /data/shares; chmod 0751 /data/shares
    chown root:root /data/.snapshots /data/apps /data/vms /data/backup; chmod 0751 /data/.snapshots; chmod 0750 /data/apps /data/vms /data/backup   # .snapshots: Nutzer müssen hindurch (Schnappschüsse tragen die Freigabe-Rechte)
    mkdir -p /etc/fahnas; chmod 0700 /etc/fahnas
    return 0
}

s_startcode() {
    local code
    if nutzer_vorhanden; then log "Es gibt schon Nutzer – kein Startcode nötig."; rm -f "$STARTCODE"; return 0; fi
    if [ -s "$STARTCODE" ]; then log "Startcode vorhanden."; chmod 0600 "$STARTCODE"; return 0; fi
    if [ -x "$PROGRAMM/tools/fahnas" ] && FAHNAS_STARTCODE="$STARTCODE" FAHNAS_CONFIG="$KONFIG" "$PROGRAMM/tools/fahnas" startcode >/dev/null 2>&1 && [ -s "$STARTCODE" ]; then
        log "Startcode über fahnas startcode erzeugt."
    else
        # tr endet an SIGPIPE, sobald head genug hat – mit pipefail wäre das ein Fehler, deshalb „|| true“ (Länge wird geprüft)
        code="$(LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom 2>/dev/null | head -c 8 || true)"
        [ "${#code}" = "8" ] || fehlschlag "Startcode konnte nicht erzeugt werden"
        printf '%s\n' "$code" > "$STARTCODE"
        log "Startcode selbst erzeugt."
    fi
    chmod 0600 "$STARTCODE"
}

s_samba() {
    local neu=/etc/samba/smb.conf.fahnas.neu
    mkdir -p /etc/samba/fahnas /etc/avahi/services "$KONFIG/samba"
    chmod 0700 "$KONFIG/samba"
    [ -f /etc/samba/fahnas/alle.conf ] || printf '# FAH-NAS – Liste der Freigaben. Wird vom Agenten erzeugt; nicht von Hand ändern.\n' > /etc/samba/fahnas/alle.conf
    {
        printf '# ============================================================================\n'
        printf '# Erdacht und programmiert von Fabian Hammer, Deutschland.\n'
        printf '# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.\n'
        printf '# ============================================================================\n'
        # Bevorzugt der Text aus dem installierten Programm (immer identisch zum Renderer), sonst die Vorlage vom Medium
        if ! node -e 'import(process.argv[1]).then(m=>process.stdout.write(m.globaleVorlage()))' "$PROGRAMM/src/agent/render/samba.js" 2>/dev/null; then
            grep -v '^# ====\|^# Erdacht\|^# (c) 2026' "$QUELLE/samba/smb.conf"
        fi
    } > "$neu"
    grep -q '^\[global\]' "$neu" || fehlschlag "smb.conf-Vorlage unbrauchbar"
    testparm -s --suppress-prompt "$neu" >/dev/null 2>&1 || { testparm -s --suppress-prompt "$neu"; fehlschlag "testparm lehnt die smb.conf ab"; }
    [ -f /etc/samba/smb.conf ] && [ ! -f /etc/samba/smb.conf.ubuntu ] && cp /etc/samba/smb.conf /etc/samba/smb.conf.ubuntu
    mv "$neu" /etc/samba/smb.conf
    systemctl disable --now nmbd.service >/dev/null 2>&1 || true   # kein NetBIOS – nur SMB2/3 + Avahi
    systemctl enable smbd.service avahi-daemon.service >/dev/null
    # smbd läuft seit der Paketinstallation mit der Paket-smb.conf (private dir /var/lib/samba/private). Nach dem Tausch
    # MUSS er neu starten, sonst schreibt nutzer.anlegen (smbpasswd) nach /data/config/samba, während der laufende smbd
    # weiter die alte Passwortdatenbank liest – die erste Finder-Anmeldung scheiterte. „enable --now“ wäre bei einem
    # aktiven Dienst ein No-op, „reload-config“ wechselt das private dir nicht zuverlässig → Restart.
    systemctl restart smbd.service || fehlschlag "smbd konnte mit der neuen smb.conf nicht neu gestartet werden"
    systemctl is-active --quiet smbd || fehlschlag "smbd läuft nicht"
    systemctl start avahi-daemon.service || true
    systemctl is-active --quiet avahi-daemon || log "Hinweis: avahi-daemon läuft nicht (Bonjour-Ankündigung fehlt)"
}

s_snapper_grub() {
    local vorlage=/usr/share/snapper/config-templates/default t d mkconfig
    mountpoint -q /.snapshots || fehlschlag "/.snapshots ist nicht eingehängt (Unterlaufwerk @snapshots)"
    if [ ! -f /etc/snapper/configs/root ]; then
        # „snapper create-config“ will das Unterlaufwerk .snapshots selbst anlegen und scheitert am eingehängten @snapshots –
        # deshalb die Konfiguration direkt aus der Vorlage (genau das tut create-config sonst auch).
        [ -f "$vorlage" ] || fehlschlag "snapper-Vorlage $vorlage fehlt"
        mkdir -p /etc/snapper/configs
        sed -e 's|^SUBVOLUME=.*|SUBVOLUME="/"|' -e 's|^FSTYPE=.*|FSTYPE="btrfs"|' "$vorlage" > /etc/snapper/configs/root
        chmod 0640 /etc/snapper/configs/root
    fi
    if [ -f /etc/default/snapper ] && grep -q '^SNAPPER_CONFIGS=' /etc/default/snapper; then
        grep -Eq '^SNAPPER_CONFIGS="([^"]* )?root( [^"]*)?"' /etc/default/snapper || sed -i -E 's|^SNAPPER_CONFIGS="([^"]*)"|SNAPPER_CONFIGS="\1 root"|; s|SNAPPER_CONFIGS=" root"|SNAPPER_CONFIGS="root"|' /etc/default/snapper
    else
        echo 'SNAPPER_CONFIGS="root"' >> /etc/default/snapper
    fi
    # snapperd (DBus) liest die Liste der Konfigurationen nur beim Start. Beim ersten Systemstart weckt ihn schon
    # snapper-boot.timer – dann kennt er „root“ nicht („The config 'root' does not exist“), obwohl die Datei jetzt liegt.
    local versuch
    for versuch in 1 2 3; do
        systemctl try-restart snapperd.service >/dev/null 2>&1 || true
        if snapper -c root list >/dev/null; then break; fi
        [ "$versuch" = 3 ] && fehlschlag "snapper kennt die Konfiguration root nicht"
        sleep 2
    done
    systemctl enable --now snapper-timeline.timer snapper-cleanup.timer

    # grub-btrfs (kein Ubuntu-Paket): aus dem geprüften Quellarchiv (Medium, sonst GitHub) – Dateien wie das Makefile installiert
    if [ ! -x /usr/bin/grub-btrfsd ] || [ ! -f /etc/grub.d/41_snapshots-btrfs ]; then
        [ -n "$GRUB_BTRFS_DATEI" ] && [ -n "$GRUB_BTRFS_SHA256" ] || fehlschlag "quellen.env ohne grub-btrfs-Angaben"
        local archiv="$QUELLE/$GRUB_BTRFS_DATEI"
        if [ ! -f "$archiv" ]; then
            log "grub-btrfs-Archiv nicht auf dem Medium – lade $GRUB_BTRFS_URL"
            warte_auf_internet || fehlschlag "Kein Internet für grub-btrfs"
            curl -fsSL --retry 3 -o "$archiv" "$GRUB_BTRFS_URL" || fehlschlag "Download grub-btrfs fehlgeschlagen"
        fi
        echo "$GRUB_BTRFS_SHA256  $archiv" | sha256sum -c --quiet || { rm -f "$archiv"; fehlschlag "Prüfsumme von grub-btrfs stimmt nicht"; }
        t="$(mktemp -d)"; tar -C "$t" -xzf "$archiv"; d="$t/grub-btrfs-$GRUB_BTRFS_VERSION"
        [ -f "$d/41_snapshots-btrfs" ] || fehlschlag "grub-btrfs-Archiv hat unerwarteten Aufbau"
        install -D -m 755 "$d/41_snapshots-btrfs" /etc/grub.d/41_snapshots-btrfs
        [ -f /etc/default/grub-btrfs/config ] || install -D -m 644 "$d/config" /etc/default/grub-btrfs/config
        install -D -m 744 "$d/grub-btrfsd" /usr/bin/grub-btrfsd
        install -D -m 644 "$d/grub-btrfsd.service" /usr/lib/systemd/system/grub-btrfsd.service
        [ -f "$d/manpages/grub-btrfs.8.man" ] && install -D -m 644 "$d/manpages/grub-btrfs.8.man" /usr/share/man/man8/grub-btrfs.8
        rm -rf "$t"
        log "grub-btrfs $GRUB_BTRFS_VERSION installiert."
    fi
    mkconfig="$(command -v grub-mkconfig || echo /usr/sbin/grub-mkconfig)"
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_LIMIT '"20"'
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_SUBMENUNAME '"FAH-NAS – Schnappschüsse (alten Stand starten)"'
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_MKCONFIG "$mkconfig"
    # NUR der Name, kein Pfad: 41_snapshots-btrfs ruft "${bindir}/${GRUB_BTRFS_SCRIPT_CHECK}" (bindir = /usr/bin aus
    # grub-mkconfig_lib) – mit einem vollen Pfad entstünde /usr/bin//usr/bin/grub-script-check, die Syntaxprüfung schlüge
    # still fehl (print_error endet mit exit 0) und grub-btrfs.cfg würde nie geschrieben.
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_SCRIPT_CHECK grub-script-check
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_GRUB_DIRNAME '"/boot/grub"'
    setze_konfig /etc/default/grub-btrfs/config GRUB_BTRFS_BOOT_DIRNAME '"/boot"'
    # GRUB-Menü sichtbar: Ubuntu Server versteckt es (GRUB_TIMEOUT_STYLE=hidden, GRUB_TIMEOUT=0) – dann sähe niemand das
    # Schnappschuss-Untermenü. Drop-in statt Änderung an /etc/default/grub (Paketdatei bleibt unangetastet).
    mkdir -p /etc/default/grub.d
    cat > /etc/default/grub.d/fahnas.cfg <<'TXT'
# FAH-NAS: GRUB-Menü 3 s anzeigen, damit „FAH-NAS – Schnappschüsse (alten Stand starten)“ erreichbar ist.
GRUB_TIMEOUT_STYLE=menu
GRUB_TIMEOUT=3
GRUB_RECORDFAIL_TIMEOUT=10
TXT
    systemctl daemon-reload
    systemctl enable --now grub-btrfsd.service || log "Hinweis: grub-btrfsd startet nicht – das Schnappschuss-Menü wird dann nur bei update-grub erneuert"
    update-grub || fehlschlag "update-grub fehlgeschlagen"
    # grub-mkconfig rahmt jedes Skript aus /etc/grub.d mit „### BEGIN /etc/grub.d/41_snapshots-btrfs ###“ ein – auch ohne
    # Schnappschüsse. Fehlt der Rahmen, ist grub-btrfs nicht eingebunden.
    grep -q '41_snapshots-btrfs' /boot/grub/grub.cfg || fehlschlag "grub.cfg enthält keinen Abschnitt 41_snapshots-btrfs – grub-btrfs nicht eingebunden"
    grep -q 'timeout=3' /boot/grub/grub.cfg || log "Hinweis: grub.cfg zeigt kein timeout=3 – GRUB-Menü eventuell weiter versteckt"
}

s_zram() {
    local soll ist
    # Unit vorhanden? LoadState statt „systemctl list-unit-files | grep -q“: grep -q endet beim ersten Treffer, systemctl
    # schreibt den Rest in die geschlossene Pipe („Failed to print table: Broken pipe“) und pipefail macht daraus
    # „zram-tools fehlt“ (Mini-PC 25.09.: drei Fehlversuche, erst der vierte kam zufällig durch).
    [ "$(systemctl show -p LoadState --value zramswap.service 2>/dev/null)" = "loaded" ] || fehlschlag "Paket zram-tools (zramswap.service) fehlt"
    install -m 0644 "$QUELLE/zram.conf" /etc/default/zramswap
    # zram-tools entlädt beim Stop das Kernelmodul (modprobe -r zram). Direkt nach swapoff hält udev das Gerät oft noch
    # offen → „Module zram is in use“, der Stop scheitert, und der Start kann Verfahren/Größe am belegten Gerät nicht
    # ändern (der Neustart übernahm /etc/default/zramswap nicht, es blieb lz4). Drop-in: swapoff + Gerät zurücksetzen.
    mkdir -p /etc/systemd/system/zramswap.service.d
    cat > /etc/systemd/system/zramswap.service.d/fahnas.conf <<'TXT'
# FAH-NAS: Stop = swapoff + zram0 zurücksetzen (statt „modprobe -r zram“, das direkt nach swapoff oft an udev scheitert).
[Service]
ExecStop=
ExecStop=-/sbin/swapoff /dev/zram0
ExecStop=/bin/sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /sys/block/zram0/reset ] || exit 0; echo 1 > /sys/block/zram0/reset 2>/dev/null && exit 0; udevadm settle -t 2 2>/dev/null; sleep 0.5; done; echo "zram0 lässt sich nicht zurücksetzen (Gerät belegt)" >&2; exit 1'
ExecReload=
ExecReload=/bin/systemctl restart zramswap.service
TXT
    systemctl daemon-reload
    systemctl enable zramswap.service >/dev/null 2>&1 || true
    if ! systemctl restart zramswap.service; then
        log "Hinweis: zramswap konnte nicht gestartet werden (fehlt das zram-Kernelmodul?) – die Auslagerungspartition bleibt."
        return 0
    fi
    soll="$(sed -n 's/^ALGO=//p' /etc/default/zramswap | tail -n 1)"
    ist="$(cat /sys/block/zram0/comp_algorithm 2>/dev/null || true)"
    if [ -n "$soll" ] && [[ "$ist" != *"[$soll]"* ]]; then
        log "Hinweis: zram läuft nicht mit $soll (aktiv: ${ist:-unbekannt})"
    fi
    case " $(swapon --show=NAME --noheadings 2>/dev/null | tr '\n' ' ') " in
        *" /dev/zram0 "*) ;;
        *) log "Hinweis: /dev/zram0 ist nicht als Auslagerung aktiv" ;;
    esac
    log "zram: $(zramctl --noheadings -o NAME,ALGORITHM,DISKSIZE /dev/zram0 2>/dev/null | tr -s ' ' || echo 'unbekannt')"
}

s_docker() {
    local soll='{"storage-driver":"overlay2","log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"3"}}'
    local neu=0
    mkdir -p /etc/docker
    if [ ! -f /etc/docker/daemon.json ] || ! node -e 'const a=JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));process.exit(a===process.argv[2]?0:1)' /etc/docker/daemon.json "$soll" 2>/dev/null; then
        printf '%s\n' "$soll" > /etc/docker/daemon.json
        chmod 0644 /etc/docker/daemon.json
        neu=1
    fi
    mountpoint -q /var/lib/docker || fehlschlag "/var/lib/docker ist nicht eingehängt (Unterlaufwerk @docker)"
    # Das Paket startet Docker schon vor dem Erststart – mit dem Standard von Docker 29 (containerd-Speicher auf der
    # SYSTEMpartition). Ohne Neustart griffe overlay2 erst beim nächsten Hochfahren, und alle bis dahin angelegten Images
    # und Container wären unsichtbar (Mini-PC 09.10.: 4 Apps weg, 16 GB in /var/lib/containerd). Deshalb jetzt neu starten.
    if [ "$neu" = 1 ] && systemctl is-active --quiet docker; then
        log "Docker-Einstellungen neu geschrieben – Docker wird neu gestartet (overlay2 auf @docker)"
        systemctl restart docker.service || fehlschlag "Docker startet mit der neuen daemon.json nicht"
    fi
    systemctl enable --now docker.service
    docker info --format '{{.Driver}}' 2>/dev/null | grep -qx overlay2 || fehlschlag "Docker nutzt nicht overlay2 (daemon.json wirkt nicht)"
    systemctl is-active --quiet docker || fehlschlag "Docker läuft nicht"
}

s_libvirt() {
    # libvirt gibt es monolithisch (libvirtd.service) oder modular (virtqemud/virtnetworkd/virtstoraged über Sockets).
    # Eine vorhandene, aber MASKIERTE libvirtd-Unit ließe „enable --now“ scheitern und den Erststart endlos wiederholen –
    # deshalb der Zustand, nicht nur die Datei. Eigener Schritt, damit ein libvirt-Problem Docker nicht blockiert.
    local zustand
    zustand="$(systemctl is-enabled libvirtd.service 2>/dev/null || true)"
    if [ "$(systemctl show -p LoadState --value libvirtd.service 2>/dev/null)" = "loaded" ] && [ "$zustand" != "masked" ]; then
        systemctl enable --now libvirtd.service
        systemctl is-active --quiet libvirtd || fehlschlag "libvirtd läuft nicht"
        log "libvirt monolithisch (libvirtd.service) aktiv."
    else
        log "libvirtd.service fehlt oder ist maskiert (${zustand:-fehlt}) – modulare Daemons über Sockets aktivieren."
        systemctl enable --now virtqemud.socket virtnetworkd.socket virtstoraged.socket
        systemctl is-active --quiet virtqemud.socket || fehlschlag "virtqemud.socket ist nicht aktiv"
    fi
}

s_firewall() {
    mkdir -p /etc/nftables.d /etc/systemd/system/nftables.service.d
    [ -f /etc/nftables.conf ] && [ ! -f /etc/nftables.conf.ubuntu ] && cp /etc/nftables.conf /etc/nftables.conf.ubuntu
    install -m 0755 "$QUELLE/nftables/fahnas.nft" /etc/nftables.conf
    # Datei des Steuerdienstes vorbelegen (gleiche Tabelle): der Glob-Include trifft immer, der Agent überschreibt beim ersten apply
    [ -f /etc/nftables.d/fahnas.nft ] || grep -v '^include ' "$QUELLE/nftables/fahnas.nft" > /etc/nftables.d/fahnas.nft
    chmod 0644 /etc/nftables.d/fahnas.nft
    # Debians nftables.service hat „ExecStop=nft flush ruleset“: jeder Stop/Restart leerte das GESAMTE Regelwerk, also auch
    # die Tabellen von Docker (iptables-nft) und libvirt. Drop-in: beim Stop nur die eigene Tabelle entfernen.
    cat > /etc/systemd/system/nftables.service.d/fahnas.conf <<'TXT'
# FAH-NAS: Stop/Restart der Unit darf nicht das ganze Regelwerk leeren (Docker/libvirt pflegen eigene Tabellen).
[Service]
ExecStop=
ExecStop=-/usr/sbin/nft delete table inet fahnas
TXT
    systemctl daemon-reload
    nft -c -f /etc/nftables.conf || fehlschlag "nft lehnt /etc/nftables.conf ab"
    # Kein „systemctl restart nftables“ (Stop = Flush). Unit für den Systemstart aktivieren, das Regelwerk jetzt direkt
    # laden: unsere Datei kennt kein „flush ruleset“, „table + flush table inet fahnas“ ersetzt nur die eigene Tabelle –
    # genauso lädt der Steuerdienst seine Datei später mit „nft -f“.
    systemctl enable nftables.service >/dev/null
    systemctl start nftables.service || log "Hinweis: nftables.service ließ sich nicht starten – Regelwerk wird direkt geladen"
    nft -f /etc/nftables.conf || fehlschlag "nft -f /etc/nftables.conf fehlgeschlagen"
    nft list table inet fahnas >/dev/null || fehlschlag "Tabelle inet fahnas fehlt nach dem Laden"
    # Weltkarte (Übersicht): Byte-Zähler je Verbindung (conntrack). nf_conntrack früh laden (modules-load.d), sonst gibt
    # es die Einstellung noch nicht, wenn systemd-sysctl beim Systemstart läuft. Der Steuerdienst prüft und setzt sie
    # zusätzlich selbst (gleicher Dateiinhalt) – ein Fehlschlag hier ist deshalb nur ein Hinweis.
    printf '%s\n' '# FAH-NAS: Verbindungstabelle für die Weltkarte früh laden' 'nf_conntrack' > /etc/modules-load.d/60-fahnas-conntrack.conf
    cat > /etc/sysctl.d/60-fahnas-conntrack.conf <<'TXT'
# FAH-NAS: Byte-Zähler je Verbindung für die Weltkarte (Übersicht → Weltkarte)
net.netfilter.nf_conntrack_acct = 1
TXT
    modprobe nf_conntrack 2>/dev/null || true
    sysctl -p /etc/sysctl.d/60-fahnas-conntrack.conf >/dev/null || log "Hinweis: nf_conntrack_acct ließ sich nicht setzen – der Steuerdienst holt das nach"
}

s_dienste() {
    local u
    for u in fahnas-agent.service fahnas-web.service fahnas.target; do
        [ -f "$PROGRAMM/systemd/$u" ] && install -m 0644 "$PROGRAMM/systemd/$u" "/etc/systemd/system/$u"
    done
    [ -f /etc/systemd/system/fahnas-agent.service ] && [ -f /etc/systemd/system/fahnas-web.service ] || fehlschlag "systemd-Units fehlen im Release ($PROGRAMM/systemd)"
    systemctl daemon-reload
    systemctl enable fahnas-agent.service fahnas-web.service >/dev/null
    [ -f /etc/systemd/system/fahnas.target ] && { systemctl enable fahnas.target >/dev/null 2>&1 || true; }
    systemctl restart fahnas-agent.service
    sleep 3
    systemctl is-active --quiet fahnas-agent || { journalctl -u fahnas-agent -n 40 --no-pager; fehlschlag "fahnas-agent läuft nicht"; }
    [ -S /run/fahnas/agent.sock ] || fehlschlag "/run/fahnas/agent.sock fehlt"
    systemctl restart fahnas-web.service
    sleep 3
    systemctl is-active --quiet fahnas-web || { journalctl -u fahnas-web -n 40 --no-pager; fehlschlag "fahnas-web läuft nicht"; }
    log "Dienste laufen: $(systemctl is-active fahnas-agent fahnas-web | tr '\n' ' ')"
}

s_dns_rueckfall() {   # Gateway + 1.1.1.1/8.8.8.8 als DNS-Rückfall, auch bei jedem weiteren Start (eigene Unit)
    local quelle="$QUELLE/dns_rueckfall.sh"
    [ -f "$quelle" ] || quelle="/opt/fahnas-install/dns_rueckfall.sh"
    [ -f "$quelle" ] || { log "dns_rueckfall.sh fehlt – übersprungen"; return 0; }
    install -m 755 "$quelle" /usr/local/sbin/fahnas-dns-rueckfall
    [ -f "$(dirname "$quelle")/fahnas-dns-rueckfall.service" ] && install -m 644 "$(dirname "$quelle")/fahnas-dns-rueckfall.service" /etc/systemd/system/fahnas-dns-rueckfall.service
    systemctl daemon-reload; systemctl enable fahnas-dns-rueckfall.service >/dev/null 2>&1 || true
    /usr/local/sbin/fahnas-dns-rueckfall   # Ausgabe landet schon im Protokoll (exec >>"$LOG") – kein tee, sonst doppelt
}

s_konsole() {
    # Konsolenhinweis (/etc/issue.d/fahnas.issue mit agetty-\4 = aktuelle IPv4, /etc/motd.d/fahnas) schreibt „fahnas issue“:
    # der Startcode steht nur darin, solange /etc/fahnas/startcode existiert – der Steuerdienst ruft denselben Befehl nach
    # der Ersteinrichtung erneut auf, damit der verbrauchte Code von tty1 verschwindet.
    rm -f /etc/update-motd.d/60-fahnas   # frühere Fassung (dynamisches motd-Skript) – ersetzt durch /etc/motd.d/fahnas
    FAHNAS_STARTCODE="$STARTCODE" FAHNAS_CONFIG="$KONFIG" "$PROGRAMM/tools/fahnas" issue || fehlschlag "fahnas issue fehlgeschlagen"
}

s_fertig() {
    systemctl disable fahnas-erststart.service >/dev/null 2>&1 || true
    touch "$MARKER/fertig.ok"
    local ip code
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    code="$(cat "$STARTCODE" 2>/dev/null | tr -d '[:space:]' || true)"
    konsole "Fertig. Oberfläche: https://${ip:-<ip>}:8443  ${code:+· Startcode: $code}"
    log "=== Erststart abgeschlossen $(date '+%H:%M:%S') ==="
}

# ---------------------------------------------------------------------------------------------------------------------
konsole "Einrichtung läuft – Protokoll: $LOG"
schritt_immer dns_rueckfall s_dns_rueckfall
schritt pakete s_pakete
schritt gruppen_nutzer s_gruppen_nutzer
schritt release s_release
schritt_immer konfig_rechte s_konfig_rechte
schritt_immer startcode s_startcode
schritt samba s_samba
schritt snapper_grub s_snapper_grub
schritt zram s_zram
schritt firewall s_firewall
schritt docker s_docker
schritt libvirt s_libvirt
schritt dienste s_dienste
schritt_immer konsole s_konsole
schritt_immer fertig s_fertig
exit 0
