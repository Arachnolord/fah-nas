#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 10: Apps mit echtem Docker – Katalog (Testvorlagen aus tests/daten/katalog), Vorschau, App
# „test-nginx“ (nginx:alpine) über die Web-API installieren (Aufgabe) → running, curl auf den Port, Firewall-Datei
# trägt den Port, Liste/Details/Protokoll, Stopp/Start, Port ändern, Aktualisieren, Löschen (Ordner + Container weg),
# Unraid-Vorlage (XML) importieren und wieder löschen. Ubuntu 26.04, root, Docker-Dienst erreichbar, Internet für
# das Image. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl docker
docker info >/dev/null 2>&1 || { melde "ÜBERSPRUNGEN: Docker-Dienst nicht erreichbar"; exit 3; }
docker compose version >/dev/null 2>&1 || { melde "ÜBERSPRUNGEN: docker compose (v2) fehlt"; exit 3; }
umgebung_vorbereiten
export FAHNAS_APPS="$IT/apps" FAHNAS_KATALOG="$WURZEL/tests/daten/katalog"
mkdir -p "$FAHNAS_APPS"
APP="it-nginx"; PORT1="${FAHNAS_IT_APP_PORT:-18089}"; PORT2=$((PORT1 + 1))
apps_aufraeumen() { docker compose -p "fahnas-$APP" down --remove-orphans >/dev/null 2>&1 || true; docker rm -f "$(docker ps -aq --filter "label=com.docker.compose.project=fahnas-$APP" 2>/dev/null)" >/dev/null 2>&1 || true; aufraeumen; }
trap apps_aufraeumen EXIT
melde "== 10 Apps =="

pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung (Admin $ADMIN_NAME)" ersteinrichtung_durchfuehren

LISTE="$(agent_aktion apps.katalog.liste '{}')"
enthaelt "Katalog liefert die Testvorlagen" '"id":"test-nginx"' "$LISTE"
bedingung "Katalog: gesamt ≥ 2" "$(json_feld "$LISTE" ergebnis.gesamt)" -ge 2
EINTRAG="$(agent_aktion apps.katalog.eintrag '{"id":"test-nginx"}')"
enthaelt "Eintrag enthält Compose und Felder" 'nginx:alpine' "$EINTRAG"

VORSCHAU="$(agent_aktion apps.pruefen "{\"katalog_id\":\"test-nginx\",\"name\":\"$APP\",\"werte\":{\"PORT_WEB\":$PORT1}}")"
enthaelt "Vorschau: Name frei" '"name_frei":true' "$VORSCHAU"
enthaelt "Vorschau: keine Port-Konflikte" '"port_konflikte":\[\]' "$VORSCHAU"
enthaelt "Vorschau: Compose mit eingesetztem Port" "\"$PORT1:80\"" "$VORSCHAU"
KONFLIKT="$(agent_aktion apps.pruefen "{\"katalog_id\":\"test-nginx\",\"name\":\"$APP\",\"werte\":{\"PORT_WEB\":$PORT_WEB}}")"
enthaelt "Vorschau: belegter Port (Web-Dienst $PORT_WEB) wird als Konflikt gemeldet" "\"port\":$PORT_WEB" "$KONFLIKT"

START="$(agent_aktion apps.installieren "{\"katalog_id\":\"test-nginx\",\"name\":\"$APP\",\"werte\":{\"PORT_WEB\":$PORT1}}")"
AUFGABE="$(json_feld "$START" ergebnis.aufgabe)"
bedingung "Installation als Aufgabe gestartet" -n "$AUFGABE"
if ERG="$(aufgabe_abwarten "$AUFGABE")"; then ok "Aufgabe Installation fertig"; else schlecht "Aufgabe Installation: $(printf '%s' "$ERG" | head -c 600)"; fi
enthaelt "Ergebnis: Zustand running" '"zustand":"running"' "$ERG"
bedingung "App-Ordner mit compose.yml" -f "$FAHNAS_APPS/$APP/compose.yml"
bedingung ".env ist 0600" "$(stat -c %a "$FAHNAS_APPS/$APP/.env")" = "600"
enthaelt "compose.yml behält den Platzhalter" '\$\{PORT_WEB\}' "$(cat "$FAHNAS_APPS/$APP/compose.yml")"
enthaelt ".env trägt den Port" "PORT_WEB='$PORT1'" "$(cat "$FAHNAS_APPS/$APP/.env")"
bedingung "Spiegel in der Konfiguration" -f "$FAHNAS_CONFIG/apps/$APP/app.json"
enthaelt "Firewall-Datei öffnet den App-Port" "tcp dport $PORT1 accept comment \"App $APP\"" "$(cat "$FAHNAS_NFT" 2>/dev/null)"
printf '<h1>FAH-NAS Integrationstest</h1>\n' > "$FAHNAS_APPS/$APP/daten/html/index.html"
pruefe "Weboberfläche der App antwortet auf Port $PORT1" warte_bis 20 curl -sf -o /dev/null "http://127.0.0.1:$PORT1/"
enthaelt "Inhalt kommt aus dem Datenordner" 'FAH-NAS Integrationstest' "$(curl -s "http://127.0.0.1:$PORT1/")"
enthaelt "Container läuft im Projekt fahnas-$APP" 'running' "$(docker ps --filter "label=com.docker.compose.project=fahnas-$APP" --format '{{.State}}')"

LISTE="$(agent_aktion apps.liste '{}')"
enthaelt "apps.liste: running" "\"name\":\"$APP\"[^}]*\"zustand\":\"running\"" "$LISTE"
enthaelt "apps.liste: Port" "\"port\":$PORT1" "$LISTE"
DETAILS="$(agent_aktion apps.details "{\"name\":\"$APP\"}")"
enthaelt "apps.details: Container mit Dienst web" '"dienst":"web"' "$DETAILS"
PROTO="$(agent_aktion apps.protokoll "{\"name\":\"$APP\",\"zeilen\":50}")"
enthaelt "apps.protokoll liefert Zeilen" '"zeilen":\[' "$PROTO"
bedingung "Protokoll hat mindestens eine Zeile" "$(node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(String((d.ergebnis&&d.ergebnis.zeilen||[]).length))' "$PROTO")" -ge 1

STOPP="$(agent_aktion apps.steuern "{\"name\":\"$APP\",\"aktion\":\"stopp\"}")"
enthaelt "Stopp → exited" '"zustand":"exited"' "$STOPP"
pruefe "Port nach Stopp nicht mehr erreichbar" bash -c "! curl -sf -o /dev/null --max-time 3 http://127.0.0.1:$PORT1/"
STARTEN="$(agent_aktion apps.steuern "{\"name\":\"$APP\",\"aktion\":\"start\"}")"
enthaelt "Start → running" '"zustand":"running"' "$STARTEN"
pruefe "Port nach Start wieder erreichbar" warte_bis 20 curl -sf -o /dev/null "http://127.0.0.1:$PORT1/"

AEND="$(agent_aktion apps.aendern "{\"name\":\"$APP\",\"werte\":{\"PORT_WEB\":$PORT2}}")"
if ERG="$(aufgabe_abwarten "$(json_feld "$AEND" ergebnis.aufgabe)")"; then ok "Aufgabe Ändern fertig"; else schlecht "Aufgabe Ändern: $(printf '%s' "$ERG" | head -c 600)"; fi
pruefe "Neuer Port $PORT2 antwortet" warte_bis 20 curl -sf -o /dev/null "http://127.0.0.1:$PORT2/"
enthaelt "Firewall-Datei trägt den neuen Port" "tcp dport $PORT2 accept" "$(cat "$FAHNAS_NFT")"
bedingung "Firewall-Datei ohne alten Port" -z "$(grep -F "dport $PORT1 " "$FAHNAS_NFT")"

AKT="$(agent_aktion apps.aktualisieren "{\"name\":\"$APP\"}")"
if ERG="$(aufgabe_abwarten "$(json_feld "$AKT" ergebnis.aufgabe)")"; then ok "Aufgabe Aktualisieren fertig"; else schlecht "Aufgabe Aktualisieren: $(printf '%s' "$ERG" | head -c 600)"; fi
enthaelt "Aktualisieren meldet alt/neu" '"alt":\{' "$ERG"
bedingung "Sicherung des Datenordners angelegt" -n "$(ls -d "$FAHNAS_APPS/$APP"/daten.vor-update-* 2>/dev/null | head -1)"

XML_JSON="$(node -e 'process.stdout.write(JSON.stringify({xml: require("fs").readFileSync(process.argv[1], "utf8")}))' "$WURZEL/tests/daten/unraid/linuxserver-nginx.xml")"
IMP="$(agent_aktion apps.katalog.importieren "$XML_JSON")"
enthaelt "Unraid-Vorlage importiert (eigen-nginx)" '"id":"eigen-nginx"' "$IMP"
enthaelt "Import: Port-Feld PORT_80" '"name":"PORT_80"' "$IMP"
bedingung "Import liegt unter _katalog/eigen" -f "$FAHNAS_APPS/_katalog/eigen/eigen-nginx.json"
enthaelt "Katalog listet die eigene Vorlage" '"quelle":"eigen"' "$(agent_aktion apps.katalog.liste '{"quelle":"eigen"}')"
enthaelt "Eigene Vorlage löschen" '"geloescht":true' "$(agent_aktion apps.katalog.loeschen '{"id":"eigen-nginx"}')"

LOESCH="$(agent_aktion apps.loeschen "{\"name\":\"$APP\",\"daten\":\"loeschen\"}")"
if ERG="$(aufgabe_abwarten "$(json_feld "$LOESCH" ergebnis.aufgabe)")"; then ok "Aufgabe Löschen fertig"; else schlecht "Aufgabe Löschen: $(printf '%s' "$ERG" | head -c 600)"; fi
bedingung "App-Ordner entfernt" ! -e "$FAHNAS_APPS/$APP"
bedingung "Spiegel entfernt" ! -e "$FAHNAS_CONFIG/apps/$APP"
bedingung "Keine Container des Projekts mehr" -z "$(docker ps -aq --filter "label=com.docker.compose.project=fahnas-$APP")"
bedingung "Firewall-Datei ohne App-Port" -z "$(grep -F "App $APP" "$FAHNAS_NFT")"
enthaelt "apps.liste leer" '"ergebnis":\[\]' "$(agent_aktion apps.liste '{}')"

ergebnis
