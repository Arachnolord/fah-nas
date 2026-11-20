# Umstieg vom UGREEN DXP4800 Plus (UGOS) auf FAH-NAS

Stand 19.10.2026, FAH-NAS 0.25.1. Gilt für das DXP4800 Plus des Betreibers (am Gerät gelesen):

| Platte | Inhalt unter UGOS | Beim Installieren |
|---|---|---|
| nvme2n1 YSR 128 GB (eingebaut) | UGOS selbst | **wird überschrieben** – hier kommt FAH-NAS hin |
| sda + sdb HUH721010 10 TB (Schacht) | volume1 (RAID 1, ext4) | ziehen |
| sdc + sdd Crucial BX500 1 TB (Schacht) | volume2 (RAID 1, btrfs) | ziehen |
| nvme1n1 Samsung 980 1 TB (M.2) | volume3 (docker) | **bleibt drin** |
| nvme0n1 Lexar NM620 256 GB (M.2) | volume4 | **bleibt drin** |
| sde WD 1 TB (USB) | externe Platte | abstecken |

Warum die NVMe-Platten drinbleiben dürfen: Der Installer nimmt Platten mit RAID-/LVM-Daten nie (beide NVMe sind unter UGOS
RAID-Mitglieder). Mit gezogenen Schächten bleibt genau eine Platte übrig – die UGOS-Systemplatte. Der Installer fragt vor dem
Löschen trotzdem noch einmal nach. Zur Sicherheit liegt vorher eine Kopie des docker-Ordners auf den gezogenen Platten (Schritt 3).

---

## Teil A – Vorbereitung unter UGOS (alles läuft noch)

1. **UGOS-Export erstellen** (liest nur, schreibt je Volume eine Datei `fahnas-ugos-export.json`). Im Terminal des Mac:

   ```
   ssh -p 2222 benutzer@192.168.1.23 'python3 -' < "/Users/benutzer/claude/NEUE ZIPs/FAH-NAS/ugos-export.py"
   ```

   Am Ende stehen vier Zeilen „geschrieben: …“. Kurz vor dem Umstieg ausführen (Rechte von heute = Rechte nach dem Umstieg).

2. **Konten notieren:** fabian (Admin), uwe, lisa, alex, media, conny. Unter FAH-NAS werden sie mit **gleichem Namen** neu
   angelegt (Passwörter neu vergeben).

3. **Sicherheitskopie der NVMe-Daten auf die Schachtplatten:** In UGOS die Docker-Projekte stoppen (Docker-App → alle
   Projekte stoppen), dann mit der UGOS-App „Sicherung & Synchronisation“ den Ordner `docker` von volume3 nach
   `volume2/Backups/Umstieg-docker` kopieren (volume2 hat genug Platz). Die Images (`@docker`, rund 200 GB) müssen nicht
   mit – die lädt Docker später neu.

4. **USB-Stick vorbereiten** (mindestens 4 GB, wird gelöscht) mit `NEUE ZIPs/FAH-NAS/fah-nas.iso`:
   am einfachsten mit balenaEtcher oder dem Raspberry Pi Imager („Eigenes Image“). Im Terminal geht es so – erst die
   Nummer des Sticks ablesen, im Beispiel `disk4`:

   ```
   diskutil list
   diskutil unmountDisk /dev/disk4
   sudo dd if="/Users/benutzer/claude/NEUE ZIPs/FAH-NAS/fah-nas.iso" of=/dev/rdisk4 bs=4m
   ```

5. **Bereitlegen:** Bildschirm am HDMI-Anschluss des NAS, USB-Tastatur, Netzwerkkabel wie bisher.

## Teil B – Installation (am Gerät, ca. 20 Minuten)

1. UGOS herunterfahren (Oberfläche → Herunterfahren), Strom bleibt dran.
2. **Alle vier Schachtplatten ziehen** (vorher markieren: Schacht 1–4). Die USB-Platte abstecken.
3. USB-Stick, Bildschirm und Tastatur anstecken, einschalten und das Boot-Menü öffnen. Die Taste dafür zeigt der Bildschirm
   kurz beim Start an. Dort den USB-Stick wählen.
4. Der Installer läuft von selbst. Wenn er nachfragt, ob die Platte **YSR128…** (119 GB) gelöscht werden darf: nur bei
   genau dieser Platte bestätigen. Steht dort eine andere Platte → **abbrechen** und melden.
5. Nach dem Neustart den Stick abziehen. Der Bildschirm zeigt „Oberfläche: https://<IP>:8443 · Startcode: …“.
6. Ersteinrichtung im Browser: Startcode, Admin `fabian`, Hostname, Zeitzone.

**Watchdog:** Das Gehäuse hat einen Hardware-Watchdog (unter UGOS aktiv, 178 Sekunden). FAH-NAS übernimmt ihn ab 0.25.1 selbst –
schon im Installer und beim ersten Start –, damit er das NAS nicht nach drei Minuten zurücksetzt. Startet das Gerät trotzdem
während der Installation nach etwa 3 Minuten von selbst neu: bitte melden, bevor du im BIOS etwas umstellst.

## Teil C – Übernehmen (aus der Ferne möglich)

1. **Nutzer anlegen:** Nutzer → uwe, lisa, alex, media, conny (gleiche Namen wie unter UGOS), Gruppen nach Bedarf.
2. **Herunterfahren, die vier Schachtplatten wieder einstecken** (gleiche Schächte), einschalten.
3. **Laufwerke → „Speicher aus einem anderen NAS übernehmen“ → „Speicher suchen …“.** Der Assistent zeigt alle vier
   Volumes mit grüner Meldung „UGOS-Export gefunden“. Prüfen:
   - je Volume **„Unter dem alten Pfad bereitstellen“** an (`/volume1` … `/volume4`) – nötig für die Docker-Apps,
   - `docker`-Ordner: Plakette **App-Daten**, Haken **„Rechte und Besitzer unverändert lassen“** bleibt gesetzt,
   - Unterordner-Rechte (z. B. `Backups/UgreenNAS`) und **persönliche Ordner** (`@home/…` → gleichnamiger Nutzer),
   - Besitzer alt → neu (über den Namen vorgeschlagen).
   Bestätigen → **Übernehmen.** Nichts wird formatiert oder gelöscht.
4. **Laufwerke → Speicherorte → Docker → „Umziehen …“** auf **„UGOS volume3 · Samsung SSD 980 1TB“** (die 128-GB-Systemplatte
   ist für die Images zu klein). Docker ist dabei kurz aus.
5. **Apps → „Vom alten NAS übernehmen“:** Projekte anhaken (Vorschlag: alle, die unter UGOS liefen), Volumes kopieren lassen,
   **Übernehmen.** Docker lädt die Images neu aus dem Internet – bei vielen Apps dauert das.
   - **Eigene Apps** (allinone, KnowSora, FunkSichta, Downloader, Medienconverter, Homepage …) baut die manage.sh aus der
     Release-ZIP. Sie besser über **Apps → „App aus ZIP“** mit der jeweiligen Release-ZIP neu einspielen.
   - Apps auf Port 80/443/445 kollidieren mit FAH-NAS selbst → unter „Bearbeiten“ einen anderen Port wählen.
   - Plex (Host-Netz, /dev/dri) läuft wie bisher; im Ergebnis stehen Hinweise zu PUID/PGID, falls Besitzer umgeschrieben wurden.
6. **Prüfen:** Freigaben im Finder öffnen, je Nutzer anmelden, Apps öffnen. Danach die vier `fahnas-ugos-export.json` löschen.
7. Optional: **System → Hardware → Gehäuse** (LEDs, Lüfter, Watchdog – „Neustart bei Systemhänger“ wie unter UGOS),
   unter Laufwerke beim Volume der Samsung 980 bzw. Lexar
   **„Spiegel ergänzen“**, sobald eine zweite Platte da ist.

## Rückweg

Solange der docker-Ordner nicht weiter benutzt wurde, liegt alles noch so da wie unter UGOS: FAH-NAS schreibt auf den
Datenplatten nur Besitzer/Rechte der übernommenen Freigaben, die eigenen Ordner `@fahnas…` und – erst beim Umziehen von Docker –
`@fahnas/docker` auf der Samsung 980. Zurück zu UGOS geht es nur über eine Neuinstallation von UGOS (Wiederherstellung von
UGREEN); die Daten auf den Platten bleiben dafür lesbar.
