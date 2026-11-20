# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
FAH-NAS – eigenes NAS-Betriebssystem (Ubuntu Server 26.04 LTS + Steuerzentrale)
================================================================================

Mindestens: 64-Bit-x86-Rechner, 4 GB RAM (8 GB empfohlen), EINE interne Platte mit mindestens 64 GiB (256 GB empfohlen),
Netzwerk per Kabel mit DHCP. Internet beim ersten Start wird gebraucht, wenn die Pakete während der Installation nicht
vom Ubuntu-Spiegel geholt werden konnten.

1. Von diesem Medium starten und „FAH-NAS installieren (Platte wird eingerichtet)“ wählen.
   Die Zielplatte wird automatisch gewählt, wenn es genau eine gibt. Bei mehreren Platten stoppt die Installation mit
   einer Liste – dann im GRUB-Menü mit „e“ die Zeile „linux …“ um  fahnas.platte=/dev/sdX  ergänzen (oder die anderen
   Platten abziehen). Eine Platte mit einer alten FAH-NAS-Datenpartition (Label FAHNAS-DATEN) wird bevorzugt und die
   Daten werden ÜBERNOMMEN, nur das System wird neu aufgesetzt. Alles neu (Daten löschen!): fahnas.neu=1.
2. Der Installer fragt Name, Rechnername, Benutzername und Passwort (Linux-Verwalter mit sudo). Danach sind zwei
   Bestätigungen nötig: „Confirm destructive action“ (die Platte wird jetzt beschrieben) und am Ende „Reboot Now“.
   Beides gehört zum interaktiven Modus von Ubuntus Installer und lässt sich nicht abschalten – also nach der
   Benutzerfrage kurz dranbleiben.
3. Nach dem Neustart richtet der Dienst fahnas-erststart alles ein (Protokoll: /var/log/fahnas-erststart.log,
   Fortschritt auf der Konsole). Danach stehen Adresse und Startcode auf der Konsole:
       FAH-NAS – Oberfläche: https://<ip>  und  https://<rechnername>.local
       Startcode: XXXXXXXX (nur bis zur Ersteinrichtung)
4. Im Browser die Adresse öffnen, Zertifikatswarnung bestätigen (selbstsigniert), Startcode eingeben, ersten Admin
   anlegen. Der Installer-Benutzer kann dabei übernommen werden.

Partitionen (GPT): 1 EFI 1 GB · 2 Auslagerung 8 GB · 3 System 48 GB btrfs FAHNAS-SYSTEM (@, @log, @snapshots) ·
4 Daten Rest btrfs FAHNAS-DATEN (@config @docker @apps @vms @shares @backup @snapshots_daten).
Bei BIOS-Start kommt davor eine 1-MB-Partition für GRUB (bios_grub), die Nummern verschieben sich um eins.

Konsole (als root/sudo):  fahnas status | apply | startcode | issue | export | import | update <archiv> |
                          passwort <nutzer> | totp-entfernen <nutzer> | sitzungen-beenden <nutzer>
Einrichtung wiederholen:  sudo bash /opt/fahnas-install/erststart.sh --erneut  (ein per „fahnas update“ eingespieltes,
                          neueres Release bleibt dabei erhalten)
Protokolle:               /var/log/fahnas-erststart.log, /var/log/fahnas-partitionen.log, journalctl -u fahnas-agent
