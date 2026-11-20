#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 02: Startcode → erster Admin über die Web-API; Linux-Konto, Samba-Konto, Sitzung, falscher Code.
# Ubuntu 26.04, root. Exit 0/1/3 (übersprungen).
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd pdbedit smbpasswd useradd chpasswd
umgebung_vorbereiten
melde "== 02 Ersteinrichtung =="

pruefe "Samba-Grundkonfiguration (Renderer) + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten

# Startcode erzeugen; erst ein falscher Code (muss abgelehnt werden, ohne den echten zu verbrauchen)
pruefe "Startcode über die CLI erzeugen" node "$WURZEL/tools/fahnas" startcode
CODE="$(tr -d '[:space:]' < "$FAHNAS_STARTCODE")"
bedingung "Startcode hat 8 Zeichen" "${#CODE}" = "8"
enthaelt "Startcode ohne 0/O/1/I" '^[A-HJ-NP-Z2-9]{8}$' "$CODE"
FALSCH="$(api_post /api/ersteinrichtung "{\"startcode\":\"FALSCH00\",\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\",\"anzeigename\":\"X\"}")"
enthaelt "Falscher Startcode wird abgelehnt (E_ANMELDUNG)" '"code":"E_ANMELDUNG"' "$FALSCH"
bedingung "Startcode bleibt nach Fehlversuch bestehen" -s "$FAHNAS_STARTCODE"
rm -f "$KEKSE"

ANTWORT="$(api_post /api/ersteinrichtung "{\"startcode\":\"$CODE\",\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\",\"anzeigename\":\"Test-Admin\"}")"
enthaelt "Ersteinrichtung mit richtigem Code" '"ok":true' "$ANTWORT"
enthaelt "Direkt angemeldet" '"angemeldet":true' "$ANTWORT"
bedingung "Startcode nach der Ersteinrichtung gelöscht" ! -e "$FAHNAS_STARTCODE"
bedingung "Sitzungskeks gesetzt" -n "$(awk '$6 == "fahnas_sitzung" { print $7 }' "$KEKSE" | tail -1)"
bedingung "CSRF-Keks gesetzt" -n "$(csrf_token)"

ICH="$(api_get /api/ich)"
enthaelt "/api/ich kennt den Admin" "\"name\":\"$ADMIN_NAME\"" "$ICH"
enthaelt "/api/ich Rolle admin" '"rolle":"admin"' "$ICH"
pruefe "Linux-Konto $ADMIN_NAME existiert" id "$ADMIN_NAME"
enthaelt "Linux-Konto ohne Anmeldeshell" 'nologin' "$(getent passwd "$ADMIN_NAME")"
enthaelt "Linux-Konto in Gruppe fahnas-nutzer" 'fahnas-nutzer' "$(id -nG "$ADMIN_NAME")"
enthaelt "Samba-Konto vorhanden (pdbedit -L)" "^$ADMIN_NAME:" "$(pdbedit -L 2>/dev/null)"
enthaelt "users.json enthält den Admin mit scrypt-Hash" 'scrypt\$' "$(cat "$FAHNAS_CONFIG/users.json")"
bedingung "users.json 0600" "$(stat -c '%a' "$FAHNAS_CONFIG/users.json")" = "600"

ZWEIT="$(api_post /api/ersteinrichtung "{\"startcode\":\"$CODE\",\"name\":\"zweiter\",\"passwort\":\"$ADMIN_PW\",\"anzeigename\":\"X\"}")"
enthaelt "Zweite Ersteinrichtung wird abgelehnt" '"ok":false' "$ZWEIT"
NOETIG="$(api_get /api/ersteinrichtung)"
enthaelt "Ersteinrichtung nicht mehr nötig" '"noetig":false' "$NOETIG"

rm -f "$KEKSE"
ANMELDUNG="$(api_post /api/anmelden "{\"name\":\"$ADMIN_NAME\",\"passwort\":\"$ADMIN_PW\"}")"
enthaelt "Anmeldung mit Passwort" '"ok":true' "$ANMELDUNG"
rm -f "$KEKSE"
FALSCHPW="$(api_post /api/anmelden "{\"name\":\"$ADMIN_NAME\",\"passwort\":\"falsch-falsch\"}")"
enthaelt "Falsches Passwort abgelehnt" '"code":"E_ANMELDUNG"' "$FALSCHPW"

ergebnis
