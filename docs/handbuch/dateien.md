<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Dateien – Handbuch

In der Ansicht **Dateien** siehst du die Freigaben, auf die du Zugriff hast. Diese Seite erklärt, wie du Textdateien
direkt im Browser bearbeitest.

Auf welcher Platte eine Freigabe liegt, zeigt die Ansicht **Freigaben** auf jeder Karte unter **Speicherort** (zum Beispiel
„Datenplatte (Samsung SSD 840) · /data/shares/medien“ oder das externe Laufwerk); der Dialog **Neue Freigabe** nennt Platte und
Pfad schon vor dem Anlegen.

## 1. Textdateien bearbeiten

Ein Klick auf eine Textdatei (zum Beispiel `.txt`, `.md`, `.json`, `.yml`, `.conf`, `.sh`, `.csv`) öffnet sie im **Editor**.
Darfst du in diesem Ordner schreiben, kannst du den Text sofort ändern.

- **Speichern beim Schließen:** Schließt du den Editor (X, Esc oder Klick daneben), wird automatisch gespeichert. Ohne
  Änderung wird nichts geschrieben.
- **Zwischendurch speichern:** **Strg+S** (Mac: **⌘+S**) oder der Knopf **Speichern**.
- **Markdown:** Bei `.md`-Dateien zeigt der Umschalter **Ansicht** den Text formatiert, **Bearbeiten** wieder den Rohtext.
- **Klappt das Speichern nicht** (zum Beispiel Netz weg), bleibt der Editor mit deinem Text offen, und oben steht der Grund.
  Versuch es einfach noch einmal.
- **Nur lesen:** Ohne Schreibrecht, im Papierkorb und bei Dateien, die nicht im UTF-8-Format vorliegen, kannst du nur lesen –
  so geht beim Speichern kein Zeichen kaputt.
- Dateien bis 1 MiB öffnen sich im Editor, größere lädst du herunter.

Windows-Zeilenenden und eine Byte-Order-Mark am Anfang bleiben beim Speichern genau so erhalten.

## 2. Wenn die Datei inzwischen geändert wurde

Hat jemand anderes die Datei gespeichert, während du sie offen hattest (zum Beispiel über die Netzwerkfreigabe am PC),
überschreibt FAH-NAS sie nie still. Du wirst gefragt:

| Wahl | Was passiert |
|---|---|
| **Als Kopie speichern** | Deine Fassung landet daneben als „Name (bearbeitet 2026-10-18 15-42).md“. Das Original bleibt, wie es ist. |
| **Trotzdem überschreiben** | Deine Fassung ersetzt die Datei. |
| **Meine Änderungen verwerfen** | Der Editor schließt, deine Änderungen gehen verloren. |
| **Weiter bearbeiten** | Der Editor bleibt offen. |

## 3. Ältere Fassungen

Der Editor legt keine alten Fassungen in den Papierkorb. Frühere Stände holst du über **Schnappschüsse** zurück, sofern sie für
die Freigabe eingeschaltet sind.

## 4. Ordnerrechte – einzelne Ordner sperren

Manche Ordner einer Freigabe gehen nicht alle etwas an. Als Admin legst du deshalb je Ordner fest, wer ihn öffnen oder ändern
darf: im Dateimanager über **⋯ → Ordnerrechte …** am Ordner oder über den Knopf **Ordnerrechte**, wenn du den Ordner geöffnet hast.

| Stufe | Was passiert |
|---|---|
| **Wie Freigabe** | Es gelten die Rechte der ganzen Freigabe. |
| **Nur lesen** | Öffnen und Herunterladen gehen, Ändern, Anlegen und Löschen nicht. |
| **Kein Zugriff** | Der Ordner bleibt sichtbar. Ein Klick zeigt „Nicht für dich freigegeben“, man kommt nicht hinein, auch nicht in Unterordner. |

Gut zu wissen:

- Die Regel gilt für den Ordner und alles darin, auch für Dateien, die später dazukommen.
- Sie gilt überall: in der Weboberfläche, im Finder bzw. Explorer (SMB), per SFTP, WebDAV und NFS sowie für Freigabelinks und Schnappschüsse.
- Eine Gruppenregel trifft alle Mitglieder, auch wenn jemand die Freigabe zusätzlich persönlich hat.
- Admins haben immer vollen Zugriff.
- Ein Unterordner kann nur strenger sein als der Ordner darüber, nie lockerer.
- Gäste ohne Anmeldung bekommen in einem eingeschränkten Ordner die strengste Stufe, die dort eingestellt ist.
- Auf externen Laufwerken (exFAT/NTFS) gibt es keine Ordnerrechte, weil diese Laufwerke keine Dateirechte kennen.
- Wer einen eingeschränkten Ordner per SMB umbenennt, findet ihn in der Übersicht als „Ordner fehlt“. Die Sperre auf der Platte
  wandert trotzdem mit. Umbenennen in der Weboberfläche nimmt die Regel automatisch mit.

Alle Ordner mit eigenen Rechten stehen unter **Freigaben** auf der Karte der Freigabe („Ordnerrechte (N)“) und in der Kachel
**Ordnerrechte** auf der Übersicht.

## 5. Umstieg von UGOS: Platten übernehmen ohne Datenverlust

1. **Vorher unter UGOS:** `python3 ugos-export.py` starten (per SSH als Admin). Das Skript liest nur und legt
   `fahnas-ugos-export.json` in einen Freigabe-Ordner jedes Volumes – darin stehen die bisherigen Rechte je Ordner.
2. **Sicherung** der wichtigsten Daten. Am sichersten: die Datenplatten während der FAH-NAS-Installation herausziehen.
3. FAH-NAS installieren. Der Installer nimmt Platten mit RAID/LVM nie von selbst – beim UGREEN bleibt nur die alte Systemplatte.
4. Unter **Nutzer** die bisherigen Konten mit **gleichem Namen** anlegen (die Nummern dürfen anders sein).
5. **Laufwerke → Speicher aus einem anderen NAS übernehmen → Speicher suchen …** Der Assistent zeigt je Volume die Ordner, schlägt
   Namen und Rechte vor und ordnet die Besitzer über den Namen zu. Bestätigen → **Übernehmen**.

Nichts wird formatiert oder gelöscht; geändert werden nur Besitzer und Rechte. „Trennen“ hängt nur aus. Ordner, die unter UGOS
btrfs-Unterlaufwerke waren, bekommen FAH-NAS-Schnappschüsse. LEDs und Lüfter des Gehäuses stellst du unter **System → Hardware →
Gehäuse** ein (Lüfter: Leise / Normal / Leistung oder BIOS).

### Was der Assistent zusätzlich mitnimmt (ab 0.25.0)

- **Unterordner mit eigenen Rechten** (z. B. `Backups/UgreenNAS` nur für Admins) werden zu **Ordnerrechten** – vorausgesetzt,
  der Export von Schritt 1 ist aktuell. Hatte jemand in einem Unterordner *mehr* Rechte als in der Freigabe, zeigt der Assistent
  einen Hinweis (FAH-NAS-Ordnerrechte können nur einschränken).
- **Persönliche Ordner** (`@home/<name>`) werden zum persönlichen Ordner des gleichnamigen FAH-NAS-Nutzers – weiterhin sieht
  jeder nur seinen eigenen (im Netz `\\NAS\<name>`). Die Dateien bleiben auf der Platte, es wird nichts kopiert.
- **App-Daten** (der `docker`-Ordner und Ordner mit Compose-Dateien): Haken „Rechte und Besitzer unverändert lassen“ ist dort
  schon gesetzt. Bitte so lassen – sonst starten Datenbanken & Co. nicht mehr.
- **Alter Pfad** (`/volume1`, `/volume3` …): Das Volume ist zusätzlich unter seinem alten Pfad erreichbar. Compose-Dateien und
  Skripte vom alten NAS laufen dadurch unverändert.

### RAID der übernommenen Platten

Unter **Laufwerke → Speicher aus einem anderen NAS übernehmen** siehst du je Volume die Platten und ihren Zustand.
**Prüfen** liest alle Platten und vergleicht sie (läuft im Hintergrund, Ergebnis als Meldung). Fällt eine Platte aus, kommt
sofort eine Meldung; **Platte ersetzen** nimmt die defekte heraus und eine neue, freie Platte auf (Namen eintippen – sie wird
geleert). Bei einem RAID 1 mit nur einer Platte (UGOS „Basis“) macht **Spiegel ergänzen** daraus einen Spiegel mit zwei Platten.

### Docker-Apps übernehmen

1. Das Volume mit der alten Docker-Ablage (`@docker`) und die Volumes mit den Compose-Ordnern übernehmen, jeweils mit **altem Pfad**.
2. **Apps → Vom alten NAS übernehmen.** Je Compose-Projekt: Häkchen, App-Name, Autostart, je Volume „Daten kopieren“.
3. **Übernehmen.** FAH-NAS kopiert die Volumes, lädt die Images neu (Internet nötig) und startet die Apps.

Die alte Docker-Ablage bleibt unverändert (Rückweg). Container ohne Compose-Datei (`docker run`) zeigt der Dialog nur an – sie
müssen von Hand neu angelegt werden.

### Speicherorte: Docker, Apps und VMs auf eine große Platte

**Laufwerke → Speicherorte → Umziehen …** zieht Docker, die App-Ordner oder die VMs auf ein übernommenes Volume (z. B. die
Samsung 980). Während des Umzugs ist Docker aus; danach laufen alle Apps wieder, die Pfade bleiben gleich. Es wird kopiert, nicht
verschoben – der alte Stand auf der Systemplatte bleibt, bis du ihn mit **Alten Stand löschen** freigibst. Fehlt das Volume später
beim Start, startet Docker bewusst nicht (damit nichts auf der kleinen Systemplatte landet).

## Papierkorb

Jede Freigabe hat genau einen Papierkorb, nicht je Ordner. Bei externen Laufwerken gilt er für alle Ordner auf dem Laufwerk: Gelöschtes kommt dorthin, auch wenn du es über das Netzwerk löschst, und läuft nach 30 Tagen ab.

Ersetzt oder löscht eine **Spiegelung** Dateien am Ziel, landen die alten Fassungen im selben Papierkorb. Dort stehen sie mit dem Namen der Spiegelung und lassen sich zurückholen. Wie lange sie bleiben, stellst du je Spiegelung ein.
