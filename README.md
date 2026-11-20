# FAH-NAS

Eigenes NAS-Betriebssystem für Mini-PCs mit einer internen SSD: Ubuntu Server 26.04 LTS als Unterbau, darüber eine
eigene Steuerzentrale (Node 22, keine Fremdpakete). Das Beste aus Unraid (Apps, VMs, Konfiguration an einem Ort,
Updates mit Rückfall) und UGOS (Freigaben, Time Machine, Dateimanager, Schnappschüsse, aufgeräumte Oberfläche).

- Entwurf: `docs/superpowers/specs/2026-09-25-fahnas-kern-design.md`
- Verbindliche Schnittstellen: `docs/schnittstellen.md`
- Abweichungen/offene Punkte aus dem Bau: `docs/abweichungen.md`

## Aufbau

```
src/gemeinsam   Schema, Konfiguration (atomares JSON), Pfade, Fehler, Systemaufrufe, NDJSON
src/agent       fahnas-agent: root, Unix-Socket, Aktionsregister, Audit, Aufgaben, Datenkanal, Renderer
src/web         fahnas-web: HTTPS, Sitzungen, CSRF, Bremse, SSE, statische Oberfläche, Datenkanal-Weiterleitung
public          Oberfläche (Vanilla HTML/CSS/JS, ES-Module, Deutsch)
iso             Installer-ISO (Autoinstall, Partitionierung, Erststart)
systemd         Dienst-Units
tools           fahnas (Kommandozeile), build_release.sh
tests           Einheitstests (node:test, macOS-lauffähig) und Integrationstests (Linux)
```

## Entwickeln

```
node --test tests/einheit/*.test.js          # alle Einheitstests
FAHNAS_CONFIG=/tmp/fahnas/config FAHNAS_RUN=/tmp/fahnas/run node src/agent/agent.js
FAHNAS_CONFIG=/tmp/fahnas/config FAHNAS_RUN=/tmp/fahnas/run FAHNAS_OHNE_TLS=1 FAHNAS_WEB_PORT=8443 node src/web/web.js
```

## Release und ISO

```
tools/build_release.sh                       # dist/fahnas_release.tar.gz (+ .sha256)
iso/build_iso.sh                             # iso/aus/fahnas-<version>-<datum>-ubuntu26.04-amd64.iso
```

Auf dem Zielsystem: `fahnas status | apply | startcode | export | import | update <archiv>`.

Erdacht und programmiert von Fabian Hammer. Alle Rechte vorbehalten.
