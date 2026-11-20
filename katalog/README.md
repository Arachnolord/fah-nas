<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Eingebauter App-Katalog (`katalog/*.json`)

Jede Datei in diesem Ordner ist **eine** App-Vorlage im Format aus dem Apps-Entwurf
(`docs/superpowers/specs/2026-09-25-fahnas-apps-design.md` §2). Der Agent liest den Ordner beim Start
(`PFADE.katalog`, im Release `/opt/fahnas/katalog/`), die Oberfläche zeigt die Einträge unter „Apps → Katalog“.
Der Dateiname ist die `id` plus `.json`. Die Tests in `tests/einheit/katalog.test.js` prüfen jede Datei; neue
Einträge müssen sie bestehen (`node --test tests/einheit/katalog.test.js`).

## Aufbau eines Eintrags

```json
{
  "id": "uptime-kuma",
  "name": "Uptime Kuma",
  "beschreibung": "Ein bis zwei deutsche Sätze: was die App tut und für wen sie ist.",
  "kategorie": "Überwachung",
  "symbol": "https://…/uptime-kuma.png",
  "quelle": "eingebaut",
  "dokumentation": "https://github.com/louislam/uptime-kuma",
  "webui": "http://{HOST}:{PORT_WEB}",
  "compose": "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2\n    restart: unless-stopped\n    ports:\n      - \"${PORT_WEB}:3001\"\n    volumes:\n      - \"${PFAD_DATEN}:/app/data\"\n",
  "felder": [
    { "name": "PORT_WEB", "art": "port", "standard": 3001, "beschriftung": "Port der Weboberfläche", "erklaerung": "…" },
    { "name": "PFAD_DATEN", "art": "pfad", "standard": "daten", "beschriftung": "Datenordner", "erklaerung": "…" }
  ],
  "hinweise": ["Beim ersten Aufruf legst du das Admin-Konto an."],
  "risiko": ["Nur wenn nötig: warum die App besondere Rechte braucht."]
}
```

| Schlüssel | Pflicht | Bedeutung |
|---|---|---|
| `id` | ja | `/^[a-z0-9][a-z0-9-]+$/`, eindeutig, gleich dem Dateinamen ohne `.json`. |
| `name` | ja | Anzeigename (2–60 Zeichen). |
| `beschreibung` | ja | Deutsch, 1–2 Sätze (40–320 Zeichen), endet mit Satzzeichen. Nutzer wird geduzt. |
| `kategorie` | ja | Eine aus: Medien, Fotos, Dateien & Sync, Sicherung, Netzwerk & DNS, Smart Home, Entwicklung, Werkzeuge, Verwaltung, Überwachung, Dokumente, Sicherheit. |
| `symbol` | ja | `https`-URL auf ein Bild (png/svg/webp/jpg). Fremde Apps: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<name>.png`; FAH-Apps: neutrale Twemoji-SVGs. Der Browser lädt das Bild direkt (CSP `img-src https:`). |
| `quelle` | ja | Immer `"eingebaut"` in diesem Ordner (`unraid`/`eigen` vergibt der Importer). |
| `verfuegbar` | nein | Nur `false` angeben: Das Image gibt es in keiner Registry und FAH-NAS bringt keinen Quellcode mit – „Installieren“ geht nur, wenn das Image schon lokal liegt. Fehlt der Schlüssel, gilt `true`. Für FAH-Apps stattdessen `bauen`. |
| `bauen` | nein | Nur eingebaute Vorlagen: `{ "release_zip": "fah-adblock_release.zip", "dienst": "adblock" }` (`dienst` optional, Standard = erster Dienst; dessen `image` muss ein lokaler Name mit Tag sein, z. B. `fah-adblock:latest`). `tools/build_release.sh` packt den Inhalt des finalen Release-ZIPs (aus `~/claude/NEUE ZIPs`, ohne `memory.md`/`CLAUDE.md`) nach `katalog/quellen/<id>/` ins Programm; der Installer baut das Image daraus (`docker build`, Label `fahnas.quelle` = Prüfsumme des ZIPs), „Aktualisieren“ baut neu, sobald ein FAH-NAS-Update neueren Quellcode mitbringt. Fehlt der Quellcode im Programm, gilt die Vorlage als nicht verfügbar. |
| `host_ports` | nein | Nur bei `network_mode: host`: feste Ports, auf denen die App direkt auf dem NAS lauscht – `[{ "port": 8123, "protokoll": "tcp", "beschreibung": "Weboberfläche" }]` (`protokoll` tcp, udp oder tcp+udp). Die Firewall (policy drop) gibt sie frei. Port-Felder, die im Host-Dienst vorkommen, und ein fester Port in `webui` zählen automatisch dazu. |
| `dokumentation` | nein | `https`-Link auf die offizielle Doku oder `null`. |
| `webui` | ja | `http(s)://{HOST}:{PORT_X}[/pfad]` oder `null` (App ohne Weboberfläche). `{HOST}` ersetzt die Oberfläche durch die Adresse, unter der sie das NAS erreicht; `{PORT_X}` muss ein Feld der Art `port` sein. Ein fester Port (z. B. `:8123`) ist nur bei `network_mode: host` erlaubt. |
| `compose` | ja | YAML-Text (Regeln unten). |
| `felder` | ja | Liste der Einstellungen (unten). Jeder Platzhalter `${NAME}` im `compose` braucht ein Feld, jedes Feld muss im `compose` vorkommen. |
| `hinweise` | nein | Liste deutscher Sätze: Erstpasswort, erste Schritte, was bewusst weggelassen wurde (z. B. `devices`), Besonderheiten. |
| `risiko` | nein | Liste deutscher Sätze, **Pflicht**, sobald das Fragment `/var/run/docker.sock`, `network_mode: host` oder `cap_add` enthält. Die Oberfläche zeigt sie als Warnung mit Bestätigungsschalter (`bestaetigt_riskant`). |

## Felder (`felder[]`)

Jedes Feld hat `name` (`/^[A-Z][A-Z0-9_]+$/`, im `compose` als `${NAME}`), `art`, `standard`, `beschriftung`
(kurz, ≤ 60 Zeichen) und `erklaerung` (mindestens ein ganzer Satz – **jede Einstellung wird erklärt**, Betreiber-Vorgabe).
`HOST` ist reserviert.

| `art` | `standard` | Rendering in `.env` | Besonderheiten |
|---|---|---|---|
| `port` | Ganzzahl 1–65535 | die Zahl | Host-Port. Der Installer prüft Konflikte mit belegten Ports und schlägt einen freien vor. Nur in `ports:` (`"${PORT_X}:cport[/tcp\|/udp]"`, dasselbe Feld darf für tcp **und** udp stehen) oder – bei Host-Netz – in `environment`. Bei Host-Netz sagt `protokoll` (`tcp`, `udp`, `tcp+udp`), was die Firewall freigibt; `adresse_feld` nennt das Text-Feld mit der Lauschadresse (Konfliktprüfung je Adresse: FAH-Adblock auf der NAS-IP kollidiert nicht mit systemd-resolved auf 127.0.0.53). |
| `pfad` | relativ (`daten/config`) oder eine Freigabe `/data/shares/<name>[/…]` | absoluter Pfad | Relativ = unterhalb `/data/apps/<name>/`; der Installer legt fehlende Ordner an (im App-Ordner beschreibbar für jeden Container-Nutzer). `/data/shares` selbst (der Ordner aller Freigaben) lehnt der Installer ab – die Vorlagen nutzen deshalb relative Standards und der Erklärtext sagt, wann eine Freigabe die bessere Wahl ist. Nur als Volume-Quelle oder in `environment` (Anzeige). |
| `variable` | Text | der Text unverändert | Umgebungsvariable, Hostname, `shm_size`, Zeitplan … Leerer Standard nur, wenn die App leer als „aus“ versteht. Kein `'` im Wert (die `.env` zitiert einfach). |
| `geheimnis` | Text (meist `""`) | nur in `.env` (0600), nie in `compose.yml`; Oberfläche maskiert | `pflicht: true` → Installation nur mit Wert (`E_PARAMS`, `details.feld`); für Passwörter, die der Nutzer kennen muss, **und** für interne Passwörter, ohne die die App nicht startet (Datenbank-Passwörter, `PAPERLESS_SECRET_KEY`, Duplicati-Schlüssel) – der Erklärtext sagt dann „beliebige Zeichenfolge, musst du dir nicht merken“. Ohne `pflicht` darf das Feld leer bleiben (App erzeugt selbst einen Wert oder braucht keinen). `erzeugen: true` (Installer füllt leere Werte mit Zufall) ist als Erweiterung im Vertrag vorgeschlagen, aber vom Installer **noch nicht umgesetzt** – kein eingebauter Eintrag verlässt sich darauf. Nur in `environment` (oder `command`). |
| `auswahl` | einer der `werte` | der gewählte Text | `werte: ["deu", "deu+eng", …]` (≥ 2 Texte). Nur in `environment`/`command`. |
| `schalter` | `true`/`false` | die Texte `true` bzw. `false` | Für Umgebungsvariablen, die genau diese Schreibweise erwarten. Erwartet die App `1`/`0` oder `yes`/`no`, nimm `auswahl`. Nur in `environment`/`command`. |

Alle Werte kommen als `NAME=wert` in die `.env` des App-Ordners; `docker compose --env-file` löst die Platzhalter auf.
Deshalb funktionieren `${NAME}` überall im YAML (auch in `shm_size`, `hostname`, `command`).

## Regeln für `compose`

- Nur die obersten Schlüssel `services`, `volumes`, `networks`. Mindestens ein Dienst.
- Je Dienst: `image` **mit Tag** (fester Tag; `:latest` nur, wenn das Projekt selbst nichts anderes empfiehlt), `restart: unless-stopped`.
- Verboten: `build`, `container_name` (Compose vergibt Namen über `-p fahnas-<name>`), `privileged`, `pid`, `env_file`, `extends`, `profiles`.
- `cap_add` nur `NET_ADMIN`, `NET_RAW`, `NET_BIND_SERVICE` – jeweils mit `risiko`-Text; `cap_drop` frei.
- Ports **nur** über Port-Felder: `"${PORT_X}:3001"`, `"${PORT_X}:53/udp"`. Keine festen Host-Ports.
- Volumes in Kurzform `quelle:ziel[:ro]`; Quelle = Pfad-Feld, benanntes Volume (unter `volumes:` deklariert) oder `/var/run/docker.sock` (mit `risiko`).
  Bind-Mounts außerhalb von `/data/apps/<name>` und `/data/shares` lehnt der Installer ab – also kein `/etc/localtime`, kein `/`; Zeitzone über `TZ`.
- `environment` als Liste `- NAME=wert`.
- Platzhalter ausschließlich `${NAME}` – kein `$NAME`, kein `${NAME:-x}` (Compose würde beides auflösen, unser Prüfer nicht).
- Einrückung 2 Leerzeichen, keine Tabulatoren, keine Flow-Syntax (`[…]`, `{…}`) außer in Anführungszeichen.
- Geräte (`devices`) fehlen absichtlich: Sie hängen vom NAS ab (GPU, Coral, USB-Sticks) und lassen einen Container ohne das Gerät nicht starten.
  Der `hinweise`-Text sagt, welche Zeile der Nutzer ergänzen kann.
- Braucht ein Image beim ersten Start eine Konfigurationsdatei (Mosquitto, Prometheus), legt der Startbefehl (`command`/`entrypoint`, `sh -c`)
  eine Grunddatei an, **wenn keine existiert**, und startet dann das Original. Das steht in den `hinweisen`.
- Images, die nicht als root laufen und Bind-Mounts beschreiben müssen (Grafana, Prometheus, Node-RED, File Browser), starten mit `user: "0:0"` –
  mit Hinweis. LinuxServer-Images steuern das über `PUID`/`PGID`.

## Prüfung vor dem Eintragen

1. Image, Tag, Ports, Volumes und Pflicht-Umgebungsvariablen gegen die **offizielle** Dokumentation prüfen (Docker-Hub-/GitHub-Seite, Compose-Beispiel des Projekts).
   Existenz des Tags: Docker-Hub-API `https://hub.docker.com/v2/repositories/<ns>/<repo>/tags/<tag>` bzw. Manifest-Abfrage bei ghcr.io.
2. `node --test tests/einheit/katalog.test.js`.
3. Rendern und mit Docker prüfen (auf einem Rechner mit Docker): Werte der Felder in eine `.env` schreiben, dann
   `docker compose -f compose.yml --env-file .env -p fahnas-test config` – muss ohne Fehler und ohne übrig gebliebene `${` durchlaufen.
4. Stand 25.09.2026: alle 35 Einträge so geprüft (Docker Compose 5.5.1 auf dem Entwicklungsrechner, kein Container gestartet); die
   40 verwendeten Images abzüglich der fünf lokal gebauten FAH-Images = 35 Registry-Images wurden mit ihrem Tag per Registry-API
   (Docker Hub, ghcr.io, docker.gitea.com) abgefragt – alle vorhanden.

## FAH-Apps (`bauen`)

`fah-sicherung`, `fah-adblock`, `fah-medienconverter`, `fah-downloader`, `fah-passwortwechsel` gibt es in keiner Registry – FAH-NAS
bringt ihren Quellcode mit (`bauen.release_zip`, siehe oben) und baut das Image beim Installieren selbst.
Standardwerte von Text-Feldern dürfen die Marken `{NAS_IP}` (IPv4-Adresse des NAS) und `{NAS_GATEWAY}` (Router) enthalten –
Oberfläche und Installer setzen die echten Werte ein (FAH-Adblock: Lauschadresse und Gateway). Die Vorlagen nutzen die Image-Namen
`fah-sicherung:latest`, `fah-adblock:latest`, `fah-medienconverter:latest`, `fah-downloader:latest`, `fah-passwortwechsel:latest`.
Ports, Volumes und Variablen stammen aus den `docker-compose.yml.example`-Dateien der Projekte; Bind-Mounts auf `/` bzw.
`/volume1` (Sicherung, Downloader, Medienconverter) wurden zu Pfad-Feldern, die auf eine Freigabe zeigen sollen, Sonderrechte fürs
CIFS-Mounten (Downloader), `security_opt unconfined` (PhotoPrism) und `devices: /dev/dri` (Medienconverter) weggelassen und in den
Hinweisen erklärt.

## Abgleich mit dem Installer (Stand 25.09.2026, `src/agent/apps/compose.js`)

`vorlagePruefen` lädt alle 35 Einträge ohne Warnung (Probe über `Katalog.eingebaut()`), `rendern` rendert jeden mit seinen
Standardwerten. Abweichungen, die der Koordinator kennen muss: `vorlagePruefen` reicht `verfuegbar`, `risiko` und
`dokumentation` derzeit **nicht** an die Oberfläche durch (nur `hinweise`), und `erzeugen` ist nicht umgesetzt (siehe oben).
