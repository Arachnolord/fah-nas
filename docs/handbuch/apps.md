<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Apps – Handbuch

FAH-NAS kann Programme als **Apps** betreiben: Medienserver, Fotoverwaltung, Werbeblocker, Passwortsafe, Smart-Home-Zentrale
und vieles mehr. Jede App läuft in einem eigenen Docker-Container, getrennt vom Rest des Systems, mit eigenem Datenordner.
Du brauchst dafür keine Kommandozeile – alles geht über die Ansicht **Apps**.

Diese Seite erklärt den Katalog, das Installieren, Unraid-Vorlagen, die Risiken bestimmter Rechte, wo deine Daten liegen
und wie du Apps aktualisierst.

## 1. Der Katalog

Unter **Apps → Katalog** findest du drei Quellen:

| Quelle | Was dahinter steckt |
|---|---|
| **Eingebaut** | Geprüfte Vorlagen, die mit FAH-NAS ausgeliefert werden (in eigenen Installationen zusätzlich die FAH-Apps wie Sicherung, Adblock, Medienconverter, Downloader, Passwortwechsel). Bei jeder Vorlage wurden Image, Ports, Ordner und Pflichteinstellungen gegen die offizielle Dokumentation geprüft. |
| **Unraid** | Der Feed der Unraid Community Applications mit tausenden Vorlagen. Wird auf Knopfdruck geladen und in eine FAH-NAS-Vorlage umgewandelt (Abschnitt 4). |
| **Eigen** | Vorlagen, die du selbst importiert hast (Unraid-XML einfügen oder Link angeben). |

Jede Karte zeigt Symbol, Name, Kategorie und eine kurze Beschreibung. Mit der **Suche** und den **Kategorien** (Medien, Fotos,
Dateien & Sync, Sicherung, Netzwerk & DNS, Smart Home, Entwicklung, Werkzeuge, Verwaltung, Überwachung, Dokumente, Sicherheit)
grenzt du die Liste ein. Ein Klick auf **Details** öffnet die Vorlage mit Hinweisen, Risiken und Link zur offiziellen Dokumentation.

Einige FAH-Apps sind im Katalog **grau** markiert: Ihr Image gibt es in keiner öffentlichen Registry, es muss einmal aus der
Release-ZIP des Programms gebaut werden (`docker build -t fah-adblock:latest .` im entpackten Ordner). Der Hinweis auf der Karte
sagt genau, welcher Befehl nötig ist. Danach lässt sich die App wie jede andere installieren.

## 2. Eine App installieren

1. Karte im Katalog anklicken → **Installieren**.
2. **Name** vergeben (Kleinbuchstaben, Ziffern, Bindestrich; z. B. `jellyfin` oder `jellyfin-kinder`). Der Name wird zum Ordner
   `/data/apps/<name>` und zum Präfix der Container (`fahnas-<name>`). Du kannst dieselbe Vorlage mehrfach unter verschiedenen Namen installieren.
3. **Einstellungen** ausfüllen. Jede Einstellung hat einen Erklärtext, der sagt, was sie bewirkt. Es gibt sechs Arten:

   | Art | Bedeutung | Tipp |
   |---|---|---|
   | **Port** | Unter welchem Port du die App im Heimnetz erreichst (`http://<NAS>:<Port>`). | Ist der Port schon belegt, wird das Feld rot und FAH-NAS schlägt einen freien vor. Bei DNS-Apps (Port 53) siehe Abschnitt 8. |
   | **Pfad** | Ein Ordner des NAS, den die App sieht. Standard ist ein Unterordner im App-Verzeichnis. | Für Medien, Fotos, Dokumente oder Downloads wähle eine **Freigabe** (`/data/shares/…`) – dann kommst du vom Mac oder PC direkt an die Dateien. Datenbanken bleiben besser im App-Ordner. |
   | **Variable** | Ein Textwert wie Zeitzone, Zeitplan oder Adresse. | Der Standard passt meist; der Erklärtext nennt Alternativen. |
   | **Geheimnis** | Passwörter und Schlüssel. Werden maskiert angezeigt und getrennt gespeichert (`.env`, nur root lesbar). | Pflichtfelder musst du selbst füllen: Admin-Passwörter notieren; interne Passwörter (Datenbank, Sitzungsschlüssel) sind beliebige lange Zeichenfolgen, die du dir nicht merken musst – FAH-NAS bewahrt sie in der `.env` auf. Felder, die leer bleiben dürfen, sagt der Erklärtext. |
   | **Auswahl** | Eine Liste fester Werte, z. B. die OCR-Sprache. | – |
   | **Schalter** | An/Aus, z. B. „Registrierung erlauben“. | Nach der Ersteinrichtung oft ausschalten (Einstellungen der App → Ändern). |

4. **Warnungen** lesen. Braucht die Vorlage besondere Rechte (Abschnitt 5), erscheint eine rote Warnung mit Bestätigungsschalter.
   Ohne Bestätigung wird nicht installiert.
5. Optional die **Compose-Vorschau** aufklappen: Das ist die fertige Docker-Compose-Datei mit deinen Werten (Geheimnisse ausgeblendet).
6. **Autostart** (Standard an): Die App startet nach einem Neustart des NAS von selbst.
7. **Installieren**. Der Fortschritt zeigt Herunterladen des Images und Start. Danach steht die App unter **Installierte Apps** mit
   Ampel (läuft / gestoppt / Fehler), CPU- und RAM-Verbrauch und dem Knopf **Öffnen**, der die Weboberfläche der App aufruft.

Beim ersten Öffnen legen die meisten Apps ein Admin-Konto an oder verlangen das Startpasswort aus den Hinweisen der Vorlage
(z. B. `admin / stirling` bei Stirling-PDF, zufälliges Passwort im Protokoll bei qBittorrent und File Browser).

## 3. Installierte Apps bedienen

- **Öffnen** – Weboberfläche der App in einem neuen Tab.
- **Start / Stopp / Neustart** – wirkt auf alle Container der App.
- **Protokoll** – die letzten Zeilen aus den Containern, mit Nachladen. Hier stehen Startpasswörter und Fehlermeldungen. Bei Apps mit `manage.sh` zeigt die Auswahl **Dienst → Ausgabe der Installation**, was das Skript gemeldet hat, zum Beispiel Adresse und Einrichtungscode.
- **Einstellungen** – Felder ändern (Ports, Pfade, Schalter). FAH-NAS rendert die Compose-Datei neu und startet die App mit den neuen Werten.
- **Aktualisieren** – neues Image holen (Abschnitt 7).
- **Löschen** – Container entfernen; du wählst, ob der Datenordner **behalten** (Standard) oder **gelöscht** wird. Zum Löschen tippst du den Namen der App.

Die Kachel **Apps** auf dem Dashboard zeigt, wie viele Apps laufen, gestoppt sind oder Fehler melden.

## 4. Unraid-Vorlagen

Unraid hat mit den *Community Applications* die größte Sammlung an Container-Vorlagen. FAH-NAS liest sie ein:

1. **Apps → Katalog → Unraid laden**. Der Feed (einige MB) wird heruntergeladen und zwischengespeichert; danach suchst du wie im eingebauten Katalog.
   **Erneuern** holt den aktuellen Stand.
2. Alternativ **Vorlage importieren**: den XML-Text einer Unraid-Vorlage einfügen oder ihren Link angeben. Die Vorlage landet unter **Eigen**.

Was übernommen wird: Image, Netzmodus, Weboberfläche, Symbol, Beschreibung, Kategorie und alle Einstellungen (Ports, Pfade,
Variablen, Geräte, Labels) samt Unraid-Beschreibungstexten. Bekannte Zusatzparameter (`--restart`, `-e`, `--cap-add`, `--device`)
werden umgesetzt; Unbekanntes zeigt FAH-NAS als Hinweis an und lässt es weg. Veraltete oder gesperrte Vorlagen werden ausgeblendet.

Achtung: Unraid-Vorlagen sind **nicht** von FAH-NAS geprüft. Pfade zeigen oft auf Unraid-Orte (`/mnt/user/appdata/…`) – setze sie
auf den App-Ordner oder eine Freigabe. Viele Vorlagen verlangen Host-Netz oder den Docker-Socket; lies die Warnung, bevor du bestätigst.

## 5. Risiken und Bestätigungen

Ein Container ist normalerweise vom NAS abgeschottet: eigenes Netz, nur die freigegebenen Ordner. Manche Apps brauchen mehr –
FAH-NAS zeigt das als Warnung und verlangt eine Bestätigung, die in der App-Konfiguration festgehalten wird:

| Recht | Was es bedeutet | Beispiele im Katalog |
|---|---|---|
| **`/var/run/docker.sock`** | Die App darf **alle** Container steuern – das entspricht Verwaltungsrechten auf dem ganzen NAS. Eine Lücke in der App ist eine Lücke im System. | Portainer, Watchtower, Dozzle (nur lesend), Homepage (nur lesend), FAH-Sicherung |
| **Host-Netz** (`network_mode: host`) | Der Container teilt den Netzwerkstapel des NAS: keine Port-Isolierung, alle Ports der App liegen direkt auf dem NAS. Nötig, wenn die App Geräte im Netz finden muss oder echte Absenderadressen sehen soll. | Home Assistant, FAH-Adblock |
| **`cap_add`** | Zusätzliche Linux-Fähigkeiten, z. B. `NET_BIND_SERVICE` (Port unter 1024 binden) oder `NET_ADMIN` (Netz konfigurieren, DHCP-Server). | FAH-Adblock |
| **`privileged`**, **`pid: host`** | Praktisch alle Rechte auf dem NAS. Im eingebauten Katalog **nicht** enthalten; aus Unraid-Vorlagen nur mit ausdrücklicher Bestätigung. | – |
| **Bind-Mounts außerhalb** von `/data/apps/<name>` und `/data/shares` | Die App könnte Systemdateien lesen oder ändern. Der Installer lehnt sie ab. | – |

Faustregeln: Apps mit Docker-Socket **nie** ungeschützt ins Internet stellen. Verwaltungswerkzeuge (Portainer) nur installieren,
wenn du sie wirklich nutzt. Sicherheitsrelevante Apps (Vaultwarden) nur über einen Reverse-Proxy mit HTTPS erreichbar machen.
Automatische Updater (Watchtower) können Apps unbemerkt kaputt machen – das FAH-NAS-eigene **Aktualisieren** je App ist der kontrolliertere Weg.

## 6. Daten, Ordner und Schnappschüsse

Jede App bekommt den Ordner `/data/apps/<name>/`:

```
/data/apps/jellyfin/
  app.json       Vorlage, deine Werte, Zeitstempel, Image-Stand (Konfiguration – Wahrheit, gespiegelt nach /data/config/apps/)
  compose.yml    gerenderte Docker-Compose-Datei
  .env           Werte der Felder inkl. Geheimnisse (nur root lesbar)
  daten/         Standardort für Pfad-Felder (config, cache, Datenbanken …)
```

- **Freigaben als Pfade**: Wählst du für ein Pfad-Feld eine Freigabe (`/data/shares/medien`), sieht die App genau diesen Ordner
  und du kommst über SMB an dieselben Dateien. Dateien, die die App dort anlegt, gehören dank der Freigabe-Rechte automatisch der
  Gruppe der NAS-Nutzer.
- **Rechte**: Die meisten Apps laufen im Container als root und dürfen überall schreiben, wo sie eingehängt sind. Apps mit
  `PUID`/`PGID` (LinuxServer-Images: qBittorrent, code-server, Duplicati) schreiben als der eingestellte Nutzer – meldet die App
  „Permission denied“, passe PUID/PGID an einen NAS-Nutzer mit Schreibrecht an oder setze 0.
- **Schnappschüsse**: `/data/apps` ist ein btrfs-Unterlaufwerk; der Schnappschuss-Plan **apps** (Ansicht Schnappschüsse) sichert alle
  App-Ordner gemeinsam. Datenbanken in laufenden Containern sind im Schnappschuss nicht immer konsistent – für Postgres/MariaDB
  (Immich, Nextcloud, PhotoPrism) zusätzlich einen Abzug per App-Sicherung (FAH-Sicherung, Duplicati) einplanen.
- **Export/Import**: Der System-Export enthält `app.json` aller Apps (mit Geheimnissen nur bei „mit Geheimnissen“). Nach einer
  Neuinstallation mit übernommener Datenpartition stehen die Apps nach dem ersten Start wieder da (`apps.apply`).
- **Löschen mit „Daten behalten“** lässt `/data/apps/<name>/daten` stehen; du kannst die App später unter demselben Namen neu
  installieren und die Daten weiterverwenden.

## 7. Aktualisieren

**Installierte Apps → Aktualisieren** holt das neue Image (`docker compose pull`) und startet die App neu (`up -d`). Vorher legt
FAH-NAS eine Kopie des Datenordners an (`daten.vor-update-<zeit>`, per Reflink ohne doppelten Platz), solange er kleiner als 5 GB ist –
sonst ein Hinweis, vorher selbst zu sichern. Geht etwas schief: App stoppen, Kopie zurück nach `daten` verschieben, in den
Einstellungen den alten Image-Tag eintragen, starten.

Was du wissen solltest:

- Vorlagen mit **festem Tag** (`louislam/uptime-kuma:2`, `immich-server:v3`, `gitea:1.27`, `eclipse-mosquitto:2`) bekommen nur
  Fehlerkorrekturen innerhalb dieser Version – ein Sprung auf die nächste Hauptversion ist eine bewusste Änderung des Tags in den Einstellungen.
  Lies vorher die Release-Hinweise der App (Link „Dokumentation“ in der Vorlage).
- Vorlagen mit `:latest` folgen immer der neuesten Version. Bei Nextcloud (`stable`) und Immich gilt: nie eine Hauptversion überspringen.
- Der Datenbank-Container (MariaDB, Postgres) wird mit aktualisiert. Bei einem Hauptversionssprung der Datenbank kann eine Migration
  nötig sein – Hinweise in der App-Dokumentation.
- **Watchtower** aktualisiert selbstständig alle Container. Wenn du es einsetzt, schalte „Nur markierte Container“ ein und markiere gezielt.

## 8. Tipps zu einzelnen Vorlagen

- **DNS-Apps (Pi-hole, AdGuard Home, FAH-Adblock)**: Port 53 ist auf Ubuntu meist von `systemd-resolved` belegt (Stub-Listener auf
  127.0.0.53). Startet die App nicht, in `/etc/systemd/resolved.conf` die Zeile `DNSStubListener=no` setzen und `systemd-resolved`
  neu starten. Danach im Router (DHCP) das NAS als DNS-Server eintragen – und einen zweiten DNS hinterlegen, falls die App einmal steht.
- **Vaultwarden**: Die Bitwarden-Apps verlangen HTTPS. Über `http://<NAS>:<Port>` klappt nur ein erster Test; für den Betrieb einen
  Reverse-Proxy mit Zertifikat davor setzen und dessen Adresse als „Öffentliche Adresse“ eintragen.
- **Home Assistant**: läuft im Host-Netz fest auf Port 8123. USB-Sticks (Zigbee/Z-Wave) brauchen eine `devices`-Zeile in der Compose-Datei.
- **Jellyfin, Plex, Medienconverter, PhotoPrism, Frigate**: Hardware-Beschleunigung braucht `/dev/dri` (Intel-GPU) bzw. den Coral als
  `devices` – bewusst nicht in den Vorlagen, weil sie vom NAS abhängen. Ohne Gerät läuft alles über den Prozessor.
- **Mosquitto, Prometheus**: Beim ersten Start entsteht eine Grundkonfiguration im Konfigurationsordner; danach kannst du sie frei anpassen
  und die App neu starten.
- **Immich, PhotoPrism, Nextcloud**: brauchen 4 GB RAM oder mehr; Datenbankordner nie auf USB-Stick oder Netzfreigabe legen.
- **Zeitzone**: Die meisten Vorlagen haben das Feld „Zeitzone“ (Standard `Europe/Berlin`); Zeitpläne und Protokolle laufen dann in Ortszeit.

## 9. Wer sieht welche App?

Admins sehen und verwalten alle Apps. Nutzer ohne Admin-Rechte sehen unter **Apps**, auf der **Übersicht** und in der
**Suche** nur die Apps, die ein Admin für sie freigegeben hat – den Katalog, die Protokolle und die Einstellungen sehen sie nicht.

So gibst du eine App frei: Auf der Karte der App steht „Sichtbar für: nur Admins“. Klick auf **Sichtbarkeit**, hake die
Nutzer oder Gruppen an, die die App öffnen dürfen, und speichere. Gibst du eine Gruppe frei (zum Beispiel `@familie`),
sehen alle Mitglieder der Gruppe die App – auch die, die du später in die Gruppe aufnimmst.

Apps, die vor FAH-NAS 0.21.0 installiert wurden, sind zunächst nur für Admins sichtbar.

Wichtig: Die App selbst bleibt im Heimnetz über die NAS-Adresse und ihren Port erreichbar. Dort schützt nur die eigene
Anmeldung der App. Richte deshalb in jeder App, die Daten enthält, eine Anmeldung ein.

## 10. Aus FAH-Git bauen

Eigene Projekte, die in FAH-Git liegen, baut FAH-NAS direkt als App – ohne ZIP herunter- und hochzuladen. Nur nötig, wenn du einen eigenen FAH-Git-Server betreibst: Der Knopf „Aus FAH-Git bauen“ und die Dashboard-Kachel erscheinen erst, wenn die Verbindung eingerichtet ist.

1. **Einmal verbinden:** In FAH-Git unter „Mein Konto“ einen Zugangsschlüssel **„Nur lesen“** anlegen. In FAH-NAS unter
   **System → Grundlagen → Verbindung zu FAH-Git** die Adresse (z. B. `http://nas.local:3300`) und den Schlüssel eintragen,
   **Speichern und prüfen**. Der Schlüssel gilt für alle Projekte, die das Konto in FAH-Git sehen darf.
2. **Bauen:** **Apps → Aus FAH-Git bauen**, Projekt und Zweig wählen, **Holen und prüfen**. FAH-NAS zeigt Stand, Bauweise
   und riskante Rechte. Liegt ganz oben im Projekt eine manage.sh, baut FAH-NAS damit, sonst mit docker compose oder dem Dockerfile. Name prüfen, **Bauen**.
   Aus FAH-Git geht es auch direkt: Knopf **„Auf FAH-NAS bauen“** am Projekt öffnet diesen Dialog schon ausgefüllt.
3. **Aktualisieren:** Die Karte der App zeigt **FAH-Git zweig @ commit** und **„Neuer Stand in FAH-Git“**, sobald auf dem Zweig
   ein neuer Commit liegt. **Aus FAH-Git aktualisieren** baut neu (Daten und .env bleiben). Unter **FAH-Git …** lässt sich
   **„Bei neuem Commit automatisch neu bauen“** einschalten (FAH-NAS fragt alle 5 Minuten nach) und der Zweig wechseln.
4. **Übersicht:** Die Kachel **„Apps aus FAH-Git“** zeigt alle so gebauten Apps und wartende neue Stände.

Voraussetzung im Projekt: eine `docker-compose.yml` oder ein `Dockerfile` im obersten Ordner („ready to build“).

## 11. Fehlersuche

| Symptom | Ursache / Abhilfe |
|---|---|
| Installation bricht bei „Image holen“ ab | Kein Internet, Registry nicht erreichbar oder Tag existiert nicht. Protokoll lesen; bei FAH-Apps das Image zuerst lokal bauen. |
| Port rot markiert | Ein anderer Dienst (oder eine andere App) nutzt den Port. Vorschlag übernehmen. |
| App startet immer wieder neu („restarting“) | Protokoll lesen: fehlende Pflichteinstellung (z. B. Admin-Passwort), zu wenig RAM (PhotoPrism, Immich), Rechteproblem auf einem Pfad. |
| „Permission denied“ im Protokoll | Pfad-Feld zeigt auf einen Ordner, in den der App-Nutzer nicht schreiben darf → PUID/PGID anpassen oder Ordner im App-Verzeichnis nutzen. |
| Weboberfläche lädt nicht, App läuft | Falscher Port in der Vorlage oder App braucht eine Ersteinrichtung auf einem anderen Port (AdGuard Home: Einrichtungsport 3000). Hinweise der Vorlage lesen. |
| Zugriff von außen scheitert | Die Firewall öffnet veröffentlichte Ports nur im Heimnetz; von außen über VPN oder Reverse-Proxy. |

Bleibt ein Problem, hilft **Protokoll → Nachladen** mit mehr Zeilen und der Link „Dokumentation“ in der Vorlage.
