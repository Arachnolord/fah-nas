#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# DNS-Rückfall: zusätzlich zu den DNS-Servern aus DHCP das Standard-Gateway sowie 1.1.1.1 und 8.8.8.8 eintragen
# (systemd-resolved, globale Server). Grund aus dem VM-Test 25.09.2026: In Netzen mit DNS-Zwang (UniFi-Firewall lässt
# nur den eigenen DNS/das Gateway durch) und bei VMs, die ihren Host nicht erreichen (macvtap), hängt sonst der
# Installer bei „apt-config“ und Docker kann keine Images laden. Idempotent; läuft im Installer (early-command) und bei
# jedem Start (fahnas-dns-rueckfall.service).
set -u
ZIEL="${FAHNAS_RESOLVED_D:-/etc/systemd/resolved.conf.d}/fahnas-rueckfall.conf"
gw="$(ip -4 route show default 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="via") {print $(i+1); exit}}')"
server=""
[ -n "$gw" ] && server="$gw"
server="$server 1.1.1.1 8.8.8.8"
mkdir -p "$(dirname "$ZIEL")"
neu="$(printf '[Resolve]\n# FAH-NAS: Gateway + öffentliche Rückfälle (dns_rueckfall.sh)\nDNS=%s\n' "${server# }")"
if [ ! -f "$ZIEL" ] || [ "$(cat "$ZIEL")" != "$neu" ]; then
    printf '%s\n' "$neu" > "$ZIEL"
    systemctl restart systemd-resolved 2>/dev/null || true
fi
echo "DNS-Rückfall: ${server# }"
exit 0
