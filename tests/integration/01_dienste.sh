#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 01: Agent und Web starten, Sockets vorhanden, HTTPS antwortet, HTTP leitet um, CLI erreicht den Agenten.
# Ubuntu 26.04, root. Exit 0 = alles in Ordnung, 1 = Fehler, 3 = übersprungen (Werkzeuge fehlen).
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl openssl
umgebung_vorbereiten
melde "== 01 Dienste (Arbeitsordner $IT) =="

pruefe "Agent und Web starten" dienste_starten
bedingung "Steuersocket vorhanden" -S "$FAHNAS_RUN/agent.sock"
bedingung "Datenkanal vorhanden" -S "$FAHNAS_RUN/daten.sock"
RECHTE="$(stat -c '%a' "$FAHNAS_RUN/agent.sock" 2>/dev/null)"
bedingung "Steuersocket 0660" "$RECHTE" = "660"

ANTWORT="$(api_get /api/ersteinrichtung)"
enthaelt "HTTPS /api/ersteinrichtung antwortet mit ok:true" '"ok":true' "$ANTWORT"
enthaelt "Ersteinrichtung ist nötig (kein Nutzer)" '"noetig":true' "$ANTWORT"
KOPF="$(curl -skI "$BASIS/" | head -30)"
enthaelt "Startseite liefert HTTP 200" 'HTTP/[0-9.]+ 200' "$KOPF"
enthaelt "Content-Security-Policy gesetzt" 'content-security-policy' "$(printf '%s' "$KOPF" | tr 'A-Z' 'a-z')"
UMLEITUNG="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$PORT_HTTP/" 2>/dev/null || true)"
enthaelt "HTTP $PORT_HTTP leitet auf https um" '^30[1278] https://' "$UMLEITUNG"
bedingung "TLS-Zertifikat erzeugt" -s "$FAHNAS_CONFIG/web/tls/key.pem"
TLS_RECHTE="$(stat -c '%a' "$FAHNAS_CONFIG/web/tls/key.pem" 2>/dev/null)"
bedingung "TLS-Schlüssel 0600" "$TLS_RECHTE" = "600"

STATUS="$(node "$WURZEL/tools/fahnas" status 2>&1)"
enthaelt "fahnas status erreicht den Agenten" 'FAH-NAS' "$STATUS"
enthaelt "fahnas status zeigt Dienste" 'Dienste:' "$STATUS"
bedingung "Konfigurationsdateien angelegt" -f "$FAHNAS_CONFIG/system.json"
bedingung "Prüfprotokoll-Ordner angelegt" -d "$FAHNAS_CONFIG/protokoll"

ergebnis
