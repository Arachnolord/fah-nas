#!/usr/bin/env bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Einzelne Testdateien auf dem Mini-PC prüfen (der Mac bleibt frei): Stand per rsync nach /tmp/fahnas-pruefung,
# dann je Datei `taskset -c 1 nice -n 19 timeout <s> node --test` – nacheinander, nie parallel.
#   bash tests/minipc.sh tests/einheit/a.test.js [tests/einheit/b.test.js …]
#   bash tests/minipc.sh --aufraeumen      → Prüfordner und Testreste in /tmp (tmpfs!) löschen
# Umgebung: FAHNAS_PRUEF_ZIEL (Standard benutzer@192.168.1.29), FAHNAS_PRUEF_ZEIT (Sekunden je Datei, Standard 90),
# FAHNAS_PRUEF_ORDNER (eigener Prüfordner je Arbeitskopie: /tmp/fahnas-pruefung oder /tmp/fahnas-pruefung-<name>).
# Mehrere Arbeitskopien dürfen gleichzeitig prüfen: ihre Läufe warten auf dem Mini-PC per flock aufeinander, es läuft
# also weiterhin nie mehr als ein Test zur selben Zeit.
set -euo pipefail
ZIEL="${FAHNAS_PRUEF_ZIEL:-benutzer@192.168.1.29}"
ORDNER="${FAHNAS_PRUEF_ORDNER:-/tmp/fahnas-pruefung}"
SPERRE=/tmp/.fahnas-pruefung.sperre
# rsync --delete schreibt in diesen Ordner: nur die festen Namen zulassen
[[ "$ORDNER" =~ ^/tmp/fahnas-pruefung(-[a-z0-9]+)?$ ]] || { echo "FAHNAS_PRUEF_ORDNER ungültig: $ORDNER" >&2; exit 2; }
ZEIT="${FAHNAS_PRUEF_ZEIT:-90}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${1:-}" == "--aufraeumen" ]]; then
  /usr/bin/ssh "$ZIEL" "rm -rf /tmp/fahnas-pruefung /tmp/fahnas-pruefung-* /tmp/fahnas-web-* /tmp/fahnas-a-* /tmp/fahnas-b-* /tmp/fahnas-apps-* /tmp/fahnas-iso-*"
  exit 0
fi
rsync -a --delete --exclude .git --exclude .superpowers --exclude dist --exclude iso/arbeit --exclude iso/aus --exclude iso/cache ./ "$ZIEL:$ORDNER/"
rc=0
for f in "$@"; do
  echo "== $f"
  /usr/bin/ssh "$ZIEL" "cd $ORDNER && flock $SPERRE taskset -c 1 nice -n 19 timeout $ZEIT node --test --test-force-exit --test-reporter=spec '$f'" || rc=1
done
exit $rc
