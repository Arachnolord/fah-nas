# FAH-NAS – Integrationstests (Linux)

Die Einheitstests (`tests/einheit`) laufen auf macOS und ersetzen alle Systembefehle. Diese Skripte hier prüfen das
echte Zusammenspiel auf **Ubuntu 26.04** mit den echten Werkzeugen (useradd, smbd, btrfs, nft …). Sie brauchen root und –
für btrfs-Loop-Images – Loop-Geräte: also ein Container mit `--privileged` oder eine VM.

Jedes Skript gibt seine Prüfungen einzeln aus (`OK` / `FEHLER`) und endet mit Exit 0 (alles in Ordnung), 1 (mindestens
eine Prüfung fehlgeschlagen) oder 3 (übersprungen: kein root oder Werkzeuge fehlen). Alles, was ein Skript startet
(Agent, Web, smbd, Loop-Geräte, Einhängungen), räumt es über die EXIT-Falle wieder ab. Arbeitsordner ist
`/tmp/fahnas-it` (`FAHNAS_IT=` ändert ihn). Die Skripte legen Linux-Nutzer `admin` und `leser` an – nur auf einem
Wegwerfsystem laufen lassen.

## Ablauf im Container

```sh
cd FAH-NAS
docker run --rm -it --privileged -v "$PWD":/fahnas -w /fahnas ubuntu:26.04 bash

# im Container:
apt-get update
apt-get install -y nodejs samba samba-vfs-modules smbclient btrfs-progs dosfstools util-linux e2fsprogs acl attr \
                   zip unzip curl openssl python3 nftables snapper ruby exfatprogs ffmpeg
node --version        # 22.x

bash tests/integration/01_dienste.sh
bash tests/integration/02_ersteinrichtung.sh
bash tests/integration/03_freigabe.sh
bash tests/integration/04_dateimanager.sh
bash tests/integration/05_snapshot.sh
bash tests/integration/06_partitionen.sh
bash tests/integration/07_wiederaufbau.sh
bash tests/integration/08_export_import.sh
bash tests/integration/09_kontingent.sh
bash tests/integration/10_apps.sh          # braucht Docker mit compose v2 und Internet, sonst Exit 3
bash tests/integration/11_laufwerke.sh
bash tests/integration/12_vorschau.sh
bash tests/integration/13_zusammenarbeit.sh
```

Alle auf einmal, Abbruch beim ersten Fehler (Exit 3 = übersprungen zählt nicht als Fehler):

```sh
for t in tests/integration/[0-9]*.sh; do bash "$t"; rc=$?; [ $rc -eq 0 ] || [ $rc -eq 3 ] || { echo "ABBRUCH bei $t"; break; }; done
```

## Was die Skripte tun

| Skript | Prüft |
|---|---|
| `01_dienste.sh` | Agent + Web starten, `agent.sock`/`daten.sock` (0660), HTTPS `/api/ersteinrichtung` → `noetig:true`, HTTP → HTTPS-Umleitung, TLS-Schlüssel 0600, `fahnas status` über den Socket |
| `02_ersteinrichtung.sh` | `fahnas startcode` (8 Zeichen ohne 0/O/1/I), falscher Code → `E_ANMELDUNG`, richtiger Code → Admin angelegt + angemeldet, Startcode gelöscht, Linux-Konto (nologin, Gruppe `fahnas-nutzer`), Samba-Konto (`pdbedit -L`), `users.json` 0600 mit scrypt-Hash, zweite Ersteinrichtung abgelehnt, Anmeldung richtig/falsch |
| `03_freigabe.sh` | btrfs-Loop-Pool, Freigabe anlegen → Unterlaufwerk, 2770 + ACL, Include-Datei + `alle.conf`, `testparm`, `smbclient -L`, Datei als Nutzer schreiben/lesen (Besitzer, `force group`), Löschen → Samba-Papierkorb, Nur-Lese-Nutzer kann nicht schreiben, Verbindungshinweis |
| `04_dateimanager.sh` | Hochladen über `/api/dateien/hochladen` (Datenkanal, Besitzer = Nutzer), `dateien.liste`, Herunterladen mit Vergleich, Ordner, Umbenennen, Pfadflucht abgelehnt, Papierkorb (löschen, Liste, wiederherstellen, leeren), ZIP-Download eines Ordners |
| `05_snapshot.sh` | Freigabe-Schnappschuss (nur lesbar, unter `/.snapshots/<freigabe>/<id>`), Liste, Datei endgültig löschen, im Schnappschuss durchsuchen, zurückholen als Aufgabe (Fortschritt über `agent.aufgaben`), Inhalt gleich, Schnappschuss löschen |
| `06_partitionen.sh` | `iso/payload/partitionen.sh` gegen vier Loop-Images (EFI vfat, swap, System, Daten mit vorhandenem `@shares`/`@config`): `@`/`@log`/`@snapshots`, Wurzel per Reflink-Kopie nach `@` umgezogen (Quelle gelöscht), Standard-Unterlaufwerk, Daten-Unterlaufwerke angelegt bzw. übernommen, `chattr +C`, Neu-Einhängung wie im Betrieb, fstab-Zeilen mit UUIDs und **einheitlichen** btrfs-Optionen (kein `nodatacow` als Einhängeoption), zweiter Lauf idempotent |
| `07_wiederaufbau.sh` | Abnahmekriterium 8: Nutzer, zweiter Nutzer, Freigabe mit Lese-/Schreibrecht → Agent/Web stoppen, Linux-Konten löschen (`userdel`), Include + `alle.conf` leeren, Freigabe-Unterlaufwerk löschen (users.json/shares.json/Samba-passdb bleiben) → Agent neu starten (system.apply) → Konten mit **gleicher uid**, Gruppen, Unterlaufwerk, 2770 + ACL (`rwx`/`r-x`), Includes zurück; Web-Anmeldung, `smbclient` schreiben als Admin, Nur-Leser weiterhin ACCESS_DENIED |
| `08_export_import.sh` | `fahnas export` ohne Geheimnisse (users.json ohne Hash; **kein** `samba/`, `links.json`, `web/tls`, Sitzungen, Bremse, Eingang – Fund R1-2), mit Geheimnissen (scrypt-Hash), verschlüsselt (`.fahnas`, Kopf `FAHNAS1`, kein tar); zweite Freigabe + geänderte Beschreibung → `fahnas import` zeigt Unterschiede, `--anwenden` stellt shares.json/users.json her, verwaister Include verschwindet, Anmeldung klappt; falsches Archiv-Passwort abgelehnt, richtiges liest |
| `09_kontingent.sh` | `groesse_gb: 1` → `btrfs quota enable` auf `FAHNAS_DATEN` (= Pool) + `qgroup limit` 1 GiB; Upload 200 MB klappt; Freigabe mit `fallocate` gefüllt → `freigaben.liste` zeigt `belegt`; Upload 300 MB → `E_PLATZ` (nichts angelegt); `groesse_gb: 0` hebt das Limit auf (`max_rfer none`), Upload klappt |
| `10_apps.sh` | Apps mit echtem Docker: Katalog (Testvorlagen aus `tests/daten/katalog`), Vorschau, App `test-nginx` (nginx:alpine) über die Web-API installieren (Aufgabe) → running, `curl` auf den Port, Firewall-Datei trägt den Port, Liste/Details/Protokoll, Stopp/Start, Port ändern, Aktualisieren, Löschen (Ordner + Container weg), Unraid-Vorlage (XML) importieren und löschen; braucht Docker und Internet für das Image |
| `11_laufwerke.sh` | Externe Laufwerke mit zwei Loop-Images (exfat, ext4): Erkennen (`lsblk`, `system:false`), Einhängen nach `shares/<name>`, Datei schreiben, Samba-Include mit `available=yes`, Aushängen → `available=no`, Wieder-Einhängen, Vergessen (Eintrag aus `laufwerke.json`); `FAHNAS_LAUFWERKE_TEST_LOOPS=1`, Überwachung aus |
| `12_vorschau.sh` | `GET /api/dateien/vorschau` mit echtem ffmpeg als Nutzer: Bild (Seitenverhältnis, kein Vergrößern), Video (Sekunde 3, kurzes Video ab 0), WebP, Zwischenspeicher (root 0700, zweiter Abruf identisch), Leserecht über die Freigabe-ACL (ohne Recht an der Datei → `E_RECHTE`, auch bei Treffer im Zwischenspeicher), Fehler als JSON (kaputt, falsche Größe, Textdatei) |
| `13_zusammenarbeit.sh` | 0.21.0: Texteditor `dateien.text.speichern` mit uid des Nutzers, veralteter Stand → `E_GEAENDERT` (HTTP 409), nichts geschrieben; Chat-Anhang „auf dem NAS speichern“ als der Nutzer (freier Name „(1)“, ohne Schreibrecht `E_RECHTE`); Office-Bündel des Admins, vom zweiten Nutzer über eine Office-Freigabe per WebSocket `/api/office/ws` bearbeitet, gehört weiter dem Besitzer; Chat-Speicher (`FAHNAS_CHAT`) als btrfs-Unterlaufwerk, root 0700; keine Inhalte im Prüfprotokoll |

## Voraussetzungen im Einzelnen

- **root** (useradd, mount, losetup) und Loop-Geräte (`--privileged`; in Podman `--privileged --device /dev/loop-control`).
- Pakete: `nodejs` (22.x aus Ubuntu), `samba samba-vfs-modules smbclient` (smbd, testparm, pdbedit, smbcontrol),
  `btrfs-progs`, `dosfstools` (mkfs.vfat), `util-linux` (losetup, mkswap, findmnt, blkid), `e2fsprogs` (chattr/lsattr),
  `acl attr zip unzip curl openssl`. `ruby` nur für die Einheitstests des ISO (YAML lesen).
- Im Container gibt es kein systemd: die Skripte starten `smbd --foreground` selbst; der Agent meldet beim Start Fehler
  von `systemctl`/`nft`/`hostnamectl` (Rendern von Firewall/Hostname) – das ist erwartet und bricht nichts ab.
- `FAHNAS_DATEN` zeigt in 03–05 und 07–09 auf den Loop-Pool (`$IT/pool`), sonst würde `btrfs quota enable` auf `/data`
  zielen, das es im Container nicht gibt. `FAHNAS_ISSUE_D`/`FAHNAS_MOTD_D` lenken `fahnas startcode`/`fahnas issue` nach `$IT/etc`.
- 08 setzt voraus, dass der Export ohne Geheimnisse `samba/` und `links.json` auslässt (Korrektur zu Fund R1-2 in
  `src/agent/export.js`); solange sie fehlt, melden genau diese beiden Prüfungen FEHLER.
- 02–05 schreiben `/etc/samba/smb.conf` (aus dem Renderer `globaleVorlage()` mit Testpfaden); ein vorhandenes wird als
  `smb.conf.vor-fahnas-test` gesichert.
- Netz: die Web-API wird über `https://127.0.0.1:18443` (selbstsigniert, `curl -k`) und `http://127.0.0.1:18080` angesprochen;
  Ports über `FAHNAS_IT_PORT`/`FAHNAS_IT_HTTP` änderbar.

## Nicht hier: der Installer selbst

ISO in einer VM (QEMU/UGREEN-KVM) bis zur Anmeldeseite, Neuinstallation mit Übernahme der Datenpartition, BIOS-Start –
siehe `iso/README.md` („Schnellprüfung in QEMU“, „Offene Risiken“).

## Fallen aus dem ersten Lauf (25.09.2026, UGREEN-NAS, privilegierter Container)

- **Bind-Mount-Rechte:** Liegt das Projekt auf einem Host-Ordner mit `drwxrwx--- 1000:10` (UGREEN legt Ordner so an), kann der
  Test-Nutzer `admin` den Dateihelfer nicht laden („Cannot find module …/dateihelfer.js“). Projekt deshalb in den Container
  kopieren (`/srv/FAH-NAS`, `chown -R root:root`, `chmod -R a+rX`) oder den Ordner mit `o+x` versehen. Im echten System liegt
  `/opt/fahnas` als root:root 755 – dort gibt es das Problem nicht.
- **Loop-Geräteknoten:** Der Kernel vergibt `/dev/loop8+`, im Container fehlt der Knoten („device node /dev/loop8 (7:8) is
  lost“). `loop_anhaengen` in `_gemeinsam.sh` legt ihn per `mknod` nach.
- **Reste:** Jeder Lauf beginnt mit `reste_beseitigen` (Prozesse, Einhängungen, Loop-Geräte, `$IT`), sonst scheitert die
  Ersteinrichtung des nächsten Skripts an der noch vorhandenen `users.json`.
- Zombie-Einträge `[node] <defunct>` in `ps` stammen von beendeten Diensten ohne wartenden Elternprozess und sind harmlos.
