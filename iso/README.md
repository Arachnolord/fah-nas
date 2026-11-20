# FAH-NAS Installer-ISO

Eigenständiges Installationsmedium: **Ubuntu Server 26.04 LTS (amd64) + Autoinstall + FAH-NAS-Release + Erststart**.
Der Nutzer startet das ISO, beantwortet die Benutzerfrage (Name, Rechnername, Benutzername, Passwort), bestätigt zweimal
(„Confirm destructive action“, am Ende „Reboot Now“ – siehe „Zwei Bestätigungen“ unten), und nach dem Neustart richtet
`fahnas-erststart.service` alles ein. Danach stehen Adresse und Startcode auf der Konsole.

## Bauen (macOS oder Linux)

```sh
brew install xorriso                 # einmalig (Linux: apt install xorriso)
tools/build_release.sh               # dist/fahnas_release.tar.gz + .sha256
NUR_PRUEFEN=1 iso/build_iso.sh       # Probelauf: nur Vorprüfungen (Archiv, Skripte, user-data, ISO-/grub-btrfs-Prüfsumme)
iso/build_iso.sh                     # → iso/aus/fahnas-<version>-<datum>-ubuntu26.04-amd64.iso (+ .sha256)
```

Die Ubuntu-ISO liegt (geprüft gegen SHA256SUMS) unter `iso/cache/`, das Autoinstall-Schema liegt versioniert unter `iso/autoinstall-schema.json`, im Cache außerdem das
grub-btrfs-Quellarchiv (`iso/payload/quellen.env`, Prüfsumme festgenagelt). Vor dem Bau prüft das Skript die
Shell-Skripte (`bash -n`), das Python (`py_compile`) und `nocloud/user-data` mit `iso/werkzeuge/autoinstall_pruefen.mjs`
(YAML über ruby oder python3-yaml, JSON-Schema-Teilmenge, FAH-NAS-Pflichtinhalte). Volumen-ID: `FAH-NAS Installer`.

## Aufbau des Mediums

| Ort im ISO | Inhalt |
|---|---|
| `boot/grub/grub.cfg` | Menü: „FAH-NAS installieren (Platte wird eingerichtet)“ (Standard, 10 s), „… Textmodus/serielle Konsole“, „Von der Festplatte starten“; Kernelzeile `autoinstall ds=nocloud\;s=/cdrom/nocloud/ ---` |
| `nocloud/user-data`, `meta-data` | Autoinstall v1 (Deutsch, Berlin, SSH, Sicherheitsupdates, `apt.fallback: offline-install`, Pakete, early-/late-/error-commands, storage-Vorlage) |
| `fahnas/` | `fahnas_release.tar.gz` + `.sha256`, `erststart.sh`, `partitionen.sh`, `platte_waehlen.sh` + `.py`, `fahnas-erststart.service`, `quellen.env`, `zram.conf`, `samba/smb.conf`, `nftables/fahnas.nft`, `grub-btrfs-<v>.tar.gz`, `README.txt` |

Secure Boot bleibt intakt: shim/GRUB/Kernel sind die signierten Originale; neu sind nur `grub.cfg`, `loopback.cfg`,
`md5sum.txt`, `nocloud/`, `fahnas/`. Die 26.04-ISO hat weiterhin ein BIOS-El-Torito-Image (`boot/grub/i386-pc/eltorito.img`)
und das UEFI-Image als angehängte GPT-Partition – das ISO startet also per BIOS und UEFI (Bootstruktur wie das Original,
`xorriso -report_el_torito as_mkisofs` geprüft am 25.09.2026).

## Ablauf der Installation

1. **early-commands → `platte_waehlen.sh`/`.py`** (vor dem Anfassen irgendeiner Platte):
   Kandidaten sind interne Platten (`lsblk`: `type disk`, nicht wechselbar, kein USB, nicht das Installationsmedium
   hinter `/cdrom`, ≥ 64 GiB). Genau eine Platte mit btrfs-Label `FAHNAS-DATEN` → diese (Übernahme). Sonst genau ein
   Kandidat → dieser. Sonst **Stopp mit Liste** – FAH-NAS rät nie. Kernelparameter: `fahnas.platte=/dev/sdX` erzwingt
   eine Platte (auch USB), `fahnas.neu=1` löscht eine vorhandene Datenpartition. Startmodus (UEFI/BIOS) aus
   `/sys/firmware/efi`. Ist der Ubuntu-Spiegel nicht erreichbar, wird `packages` entfernt (sonst bricht subiquity dort ab;
   der Erststart holt die Pakete nach).
   Das Skript ersetzt die `storage`-Sektion in **`/autoinstall.yaml`**. Belegter Mechanismus (subiquity, Ubuntu 26.04):
   - Doku „early-commands“: *„The autoinstall configuration is available at `/autoinstall.yaml` (irrespective of how
     it was provided), and the file is re-read after the early-commands have run to allow them to alter the
     configuration if necessary.“* (canonical-subiquity.readthedocs-hosted.com, Autoinstall-Referenz)
   - Quelle `subiquity/server/server.py`: `select_autoinstall()` kopiert die gefundene Datei (bei NoCloud
     `run/subiquity/cloud.autoinstall.yaml`, also der Inhalt des `autoinstall`-Schlüssels der user-data) nach
     `/autoinstall.yaml` (`copy_file_if_exists(loc, rootpath)`); `start()` ruft `load_autoinstall_config(only_early=True)`,
     dann `Early.run()`, dann `load_autoinstall_config(only_early=False)`; `_read_config()` packt einen umschließenden
     Schlüssel `autoinstall` aus. Das Skript behandelt beide Formen.
   - curtin storage v2: `preserve: true` an einer Partition = „curtin will verify that the partition exists and that the
     size and flag match“; `preserve: true` am format = „curtin will not format the partition“ (curtin-Doku „storage“).
     Neue Partitionen ohne `offset` werden nach der vorhergehenden auf 1 MiB ausgerichtet (`block_meta_v2.py`).
     Die Datenpartition bekommt im Neu-Fall `size: -1` – Autoinstall-Referenz (storage): *„For the last partition
     specified for a particular device, you can specify the size as -1 to indicate that the partition should fill the
     remaining space.“* subiquity rechnet damit mit den echten Ausrichtungsdaten (auch 4Kn-Platten, deren GPT-Sicherung
     33 × 4096 Byte braucht); die eigene Rechnung (34 × 512 Byte Reserve) dient nur noch der Mindestgrößen-Prüfung und dem
     Hinweistext. Bei der Übernahme bleiben die Größen aus `lsblk` (preserve).
2. **Partitionierung durch curtin** (aus der geschriebenen storage-Sektion):
   - Neu, UEFI: GPT · p1 1 GiB FAT32 `FAHNAS-EFI` (`/boot/efi`, `grub_device`) · p2 8 GiB swap `FAHNAS-SWAP` ·
     p3 48 GiB btrfs `FAHNAS-SYSTEM` (`/`) · p4 Rest btrfs `FAHNAS-DATEN`. `swap: {size: 0}` verhindert die Auslagerungsdatei.
   - Neu, BIOS: zusätzlich p1 1 MiB `bios_grub` (GRUB auf GPT braucht das), alle Nummern +1, `grub_device` an der Platte.
   - Übernahme: Platte `preserve: true`, alle Partitionen `preserve: true` mit Größe/Offset aus `lsblk`; EFI/Swap/System
     werden neu formatiert (`format preserve: false`, curtin mkfs mit `--force`), `FAHNAS-DATEN` bleibt (`format preserve: true`),
     fremde Partitionen bleiben unangetastet. Fehlt eine Rolle (kein EFI/Swap/System-Label, BIOS ohne bios_grub) → Stopp.
3. **Identity** interaktiv (einziger Dialog) – **plus zwei Bestätigungen**, weil subiquity mit `interactive-sections` in
   den interaktiven Modus wechselt: „Confirm destructive action“ vor dem Schreiben auf die Platte und „Reboot Now“ nach
   dem Ende. Belegt in der subiquity-Quelle (main, 25.09.2026): `server/controllers/install.py` bestätigt automatisch nur
   `if not self.app.interactive: if "autoinstall" in self.app.kernel_cmdline: await self.model.confirm()`, danach
   `ApplicationState.NEEDS_CONFIRMATION` + `wait_confirmation()`; `server/controllers/shutdown.py`: `if self.app.interactive:
   await self.user_shutdown_event.wait()` – der Autoinstall-Schlüssel `shutdown` wählt nur reboot/poweroff, er überspringt
   die Frage nicht. Einen Konfigurationsschlüssel für „interaktiv, aber ohne Bestätigung“ gibt es nicht (Autoinstall-Referenz
   nennt zu `interactive-sections` nur „still show in the UI“). Netz: DHCP (subiquity-Standard).
4. **late-commands → `partitionen.sh`**: hängt das Ziel aus, hängt System- und Datenpool per `subvolid=5` ein, legt
   `@` an und zieht die installierte Wurzel hinein (über die Unterlaufwerksgrenze gibt es kein `rename` – Reflink-Kopie
   `cp -a --reflink=auto`, danach Quelle löschen; Fertig-Kriterium „Top-Level enthält nur `@*`“, ein abgebrochener Lauf
   wird so wiederholbar), `@log` (Inhalt von `/var/log`), `@snapshots`;
   `btrfs subvolume set-default @`; auf der Datenpartition `@config @docker @apps @vms @shares @backup @snapshots_daten`
   **nur wenn sie fehlen** (Übernahme), `chattr +C` auf `@docker`/`@vms`; schreibt `/etc/fstab` (UUIDs, `subvol=`,
   **überall** `compress=zstd:1,noatime`, `/data` = Top-Level `subvolid=5`, `/data/.snapshots` = `@snapshots_daten`), hängt das
   Ziel nach dieser Liste wieder ein (prüft die fstab damit gleich), erzeugt GRUB neu (`grub-install` UEFI bzw. BIOS auf die
   Platte, `update-grub`, prüft `rootflags=subvol=@`). Protokoll `/var/log/fahnas-partitionen.log` (auch im Ziel).
   Danach kopieren die late-commands `/cdrom/fahnas` nach `/target/opt/fahnas-install` und aktivieren `fahnas-erststart.service`.
5. **Erststart** (`erststart.sh`, root, idempotent, Markierungen `/var/lib/fahnas/erststart/<schritt>.ok`, Protokoll
   `/var/log/fahnas-erststart.log`, Kurzmeldungen auf tty1): Pakete nachinstallieren (wartet bis 5 min auf Internet, nur
   wenn etwas fehlt) · Gruppen `fahnas`, `fahnas-nutzer`, `fahnas-admin`, Systemnutzer `fahnas`, Installer-Benutzer (uid
   1000) → `fahnas-admin`, `docker`, `libvirt` · Release nach `/opt/fahnas` (Prüfsumme; `/usr/local/bin/fahnas`; ein
   installierter Stand, der NEUER als das Medium ist – `fahnas update` –, bleibt auch bei `--erneut` erhalten, `sort -V`) ·
   Rechte unter `/data` · Startcode (`fahnas startcode`, Rückfall eigene Erzeugung; entfällt, sobald Nutzer existieren) ·
   Samba (`smb.conf` = `globaleVorlage()` aus dem Release, `alle.conf`, nmbd aus, **smbd nach dem Tausch neu gestartet** –
   sonst liefe er mit der Paket-smb.conf und dem alten `private dir` weiter –, avahi an) · snapper `root`
   (Konfiguration aus der Vorlage geschrieben, weil `create-config` am eingehängten `@snapshots` scheitert) + Timer ·
   grub-btrfs aus dem geprüften Quellarchiv (`/etc/grub.d/41_snapshots-btrfs`, `grub-btrfsd`, Limit 20,
   `GRUB_BTRFS_SCRIPT_CHECK=grub-script-check` – nur der Name, das Skript hängt `bindir` davor) · GRUB-Menü sichtbar über
   `/etc/default/grub.d/fahnas.cfg` (`GRUB_TIMEOUT_STYLE=menu`, `GRUB_TIMEOUT=3`) · `update-grub` mit Prüfung, dass
   `41_snapshots-btrfs` in `grub.cfg` steht · zram (`ALGO=zstd`, `PERCENT=50`) · **nftables VOR Docker/libvirt**
   (`/etc/nftables.conf` = Grundregelwerk + `include "/etc/nftables.d/*.nft"`, Datei des Agenten vorbelegt, Drop-in
   `nftables.service.d/fahnas.conf` mit `ExecStop=-nft delete table inet fahnas`, geladen mit `nft -f`, NIE `systemctl
   restart nftables`) · Docker (`daemon.json`) · libvirt (eigener Schritt: `libvirtd.service`, wenn vorhanden und nicht
   maskiert, sonst `virtqemud/virtnetworkd/virtstoraged.socket`) · Units aus `/opt/fahnas/systemd` → `fahnas-agent`,
   `fahnas-web` · `fahnas issue` (`/etc/issue.d/fahnas.issue` mit `\4` = aktuelle IPv4, `/etc/motd.d/fahnas`; Startcode nur,
   solange `/etc/fahnas/startcode` existiert – der Agent ruft `fahnas issue` nach der Ersteinrichtung erneut) · Unit deaktivieren.
   Fehlt ein Schritt: Exit 1, `Restart=on-failure` nach 60 s (kein Startlimit), und bei jedem Systemstart bis `fertig.ok`.
   Wiederholen: `sudo bash /opt/fahnas-install/erststart.sh --erneut`.

## Rechte, die der Erststart setzt (für den Web-Dienst, Nutzer `fahnas`)

`/data` 0751 root · `/data/config` **2750 root:fahnas** (setgid: vom Agenten neu angelegte Dateien erben die Gruppe) ·
`system.json`, `shares.json`, `snapshots.json`, `version.json` 0640 root:fahnas · `users.json` 0600 root ·
`/data/config/web` 0750 fahnas:fahnas · `/data/config/samba` 0700 root · `protokoll/`, `apps/`, `vms/`, `eingang/` 0750
root:fahnas · `/data/shares` 0751 root:fahnas-nutzer · `/data/.snapshots`, `/data/apps`, `/data/vms`, `/data/backup` 0750
root · `/etc/fahnas` 0700, `startcode` 0600 · `/run/fahnas` 0750 root:fahnas (RuntimeDirectory des Agenten mit
`Group=fahnas`, `RuntimeDirectoryPreserve=yes`, damit der Web-Dienst nach einem Agent-Neustart nicht ins Leere schaut).

## systemd-Units (`systemd/`)

- `fahnas-agent.service`: `Type=notify` + `NotifyAccess=all` (der Agent meldet „bereit“ über `systemd-notify`, ein
  eigener Prozess), root, `Group=fahnas`, `RuntimeDirectory=fahnas` 0750, `Restart=always`, `After=network-online.target
  smbd.service`. Bewusst ohne `NoNewPrivileges`/`ProtectSystem`/`ProtectKernelTunables` (Nutzerwechsel, /etc-Rendern, hdparm).
- `fahnas-web.service`: Nutzer `fahnas`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `ReadWritePaths=/data/config/web /run/fahnas`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelTunables`,
  `ProtectControlGroups`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `Requires`/`After=fahnas-agent.service`,
  Ports 443/80 über Umgebung. Ohne `MemoryDenyWriteExecute` (Node-JIT) und ohne `SystemCallFilter` (siehe Kommentar).
- `fahnas.target`: Bequemlichkeit (`systemctl restart fahnas.target`).

## Bewusste Entscheidungen

- **Kein Raten bei mehreren Platten.** Der Entwurf sah eine interaktive `storage`-Sektion vor; subiquitys Oberfläche kann
  aber keine Dateisystem-Labels setzen, und `partitionen.sh` braucht `FAHNAS-SYSTEM`/`FAHNAS-DATEN`. Eine interaktive
  Aufteilung ergäbe ein System ohne Datenpartition. Deshalb: klarer Stopp mit Liste, Auswahl per `fahnas.platte=`.
- **`grub-btrfs` ist kein Ubuntu-Paket** (packages.ubuntu.com, alle Suites, 25.09.2026). Es liegt als geprüftes Quellarchiv
  (v4.14, SHA-256 in `quellen.env`) auf dem Medium; fehlt es dort, lädt der Erststart es von GitHub und prüft die Summe.
  Die Dateien werden wie im Makefile installiert (kein `make` nötig). `inotify-tools` ist dafür in den Paketen.
- **Pakete sind nicht im ISO-Pool** (die Server-ISO enthält nur ~190 Pakete für GRUB/NVIDIA/Treiber). Offline scheitert
  `packages` in subiquity fatal → `platte_waehlen.py` entfernt die Liste, wenn der Spiegel nicht erreichbar ist; der
  Erststart installiert nach. Ohne Internet auch beim ersten Start bleibt das NAS ohne Samba/Docker – ehrlich gesagt:
  „ohne Internet installierbar“ gilt nur für die Basis, die Dienste brauchen einmal Netz (oder einen eigenen Spiegel).
- **`set-default @`** ist reine Kernel-Rückfallhilfe: GRUBs btrfs-Treiber löst Pfade immer ab dem Top-Level (Objekt-ID 5)
  auf (`grub-core/fs/btrfs.c`, `get_root()` mit `GRUB_BTRFS_ROOT_VOL_OBJECTID`), deshalb sind `/@/boot/grub`-Präfix und
  grub-btrfs-Einträge (`rootflags=subvol=@snapshots/N/snapshot`) davon unabhängig.
- **Zwei Bestätigungen im Installer** („Confirm destructive action“, „Reboot Now“) sind Folge von `interactive-sections:
  [identity]` (Beleg oben, Schritt 3). Die Alternative – feste `identity` ohne Dialog, Installer läuft ohne jede Eingabe –
  hätte bis zur Ersteinrichtung im Browser **kein bekanntes Konsolen-/SSH-Passwort** (Entwurf §4 will den Installer-Benutzer
  als ersten Linux-Admin; `nutzer.anlegen` legt NAS-Nutzer mit `nologin` an). Deshalb bleibt der Dialog, und Abnahme-
  kriterium 1 („ohne Eingaben außer Benutzer/Passwort“) ist als „… plus zwei Bestätigungen“ zu lesen (Koordinator/Handbuch).
- **btrfs-Einhängeoptionen gelten je Dateisystem, nicht je Unterlaufwerk** (btrfs(5): nur die erste Einhängung zählt).
  Deshalb tragen ALLE fstab-Zeilen einer Partition dieselben Optionen (`compress=zstd:1,noatime`); `nodatacow` steht
  nirgends in der fstab – es hätte je Startreihenfolge für den ganzen Datenpool Prüfsummen und Kompression abgeschaltet.
  Kein Copy-on-Write für `@docker`/`@vms` kommt ausschließlich von `chattr +C` auf dem leeren Unterlaufwerk.
- Samba-Passwörter liegen mit `private dir = /data/config/samba` auf der Datenpartition (A), damit sie eine Neuinstallation
  überleben; der Erststart legt den Ordner 0700 an, bevor smbd startet, und startet smbd nach dem Tausch der smb.conf neu.
- Firewall: `/etc/nftables.conf` ohne `flush ruleset` und ohne forward-Kette – Docker/libvirt verwalten eigene Tabellen.
  Geladen wird nur mit `nft -f` (kein `systemctl restart nftables`: Debians `ExecStop=nft flush ruleset` leert alles; der
  Erststart setzt ein Drop-in, das beim Stop nur `inet fahnas` entfernt). Das Grundregelwerk erlaubt zusätzlich **IGMP**
  (Switches mit IGMP-Snooping streichen den Port sonst aus der mDNS-Gruppe → Bonjour/Time Machine unzuverlässig) und
  **`iifname "virbr*"`** (DHCP/DNS/TFTP der libvirt-Brücke: in nftables muss ein Paket JEDE Basiskette desselben Hooks
  passieren, libvirts eigene Erlaubnis in `ip filter` reicht gegen unsere `policy drop` nicht). **Hinweis an den
  Renderer `src/agent/render/firewall.js` (Teil C):** beide Regeln dort ergänzen – bis dahin gelten sie nur bis zum ersten
  `apply`, weil der Agent `/etc/nftables.d/fahnas.nft` mit seiner Fassung ersetzt. Der Einheitstest prüft, dass jede Regel
  des Renderers im Grundregelwerk steht (Renderer ⊆ Payload), nicht umgekehrt.
- `fahnas update` erneuert die systemd-Units aus dem Release (`/opt/fahnas/systemd`) mit Inhaltsvergleich, sichert die
  alte Fassung unter `/opt/fahnas.alt/systemd.installiert/`, ruft `daemon-reload` und spielt sie beim Rücktausch zurück.

## Test der Bausteine

- Einheitstests (macOS): `node --test tests/einheit/iso.test.js` – user-data (Schema, Pflichtinhalte), Plattenwahl gegen
  Probe-`lsblk`-Daten (UEFI/BIOS/Übernahme/mehrere Platten), fstab-Text, GRUB-Menü, Units, smb.conf = Renderer, nft-Regeln,
  `bash -n`/`shellcheck` (falls installiert), Urheber-Köpfe.
- Integration (Ubuntu 26.04, root): `tests/integration/` – siehe dort, insbesondere `06_partitionen.sh` mit Loop-Images,
  `07_wiederaufbau.sh` (Abnahmekriterium 8), `08_export_import.sh`, `09_kontingent.sh`.
- Nach dem ersten snapper-Stand auf echter Hardware/VM prüfen: `snapper -c root create -d test; update-grub;
  test -s /boot/grub/grub-btrfs.cfg` (die Syntaxprüfung von grub-btrfs meldet Fehler nur auf stderr und endet mit Exit 0).
- Schnellprüfung in QEMU (UEFI): `qemu-system-x86_64 -machine q35 -m 4096 -drive if=pflash,format=raw,readonly=on,file=/opt/homebrew/share/qemu/edk2-x86_64-code.fd -drive file=platte.qcow2,if=virtio -cdrom iso/aus/<iso> -boot d`
  (Platte vorher `qemu-img create -f qcow2 platte.qcow2 80G`). BIOS: dieselbe Zeile ohne pflash.

## Offene Risiken

- **Nicht in einer VM durchgelaufen** (der Koordinator baut das ISO). Zu prüfen: Installation bis Anmeldeseite, Neuinstallation
  mit Datenpartition-Übernahme, BIOS-Start (bios_grub-Zweig), Textmodus-Eintrag auf serieller Konsole.
- curtin-Größenprüfung bei Übernahme: `size`/`offset` kommen aus `lsblk -b` (Byte, START × 512); curtin vergleicht mit
  `sfdisk`. Bei 4Kn-Platten sind beide Wege byte-genau, aber ungetestet.
- Ubuntu 26.04 könnte `/usr/sbin` nach `/usr/bin` zusammenlegen; `GRUB_BTRFS_MKCONFIG` wird deshalb aus `command -v grub-mkconfig` gesetzt.
- `Restart=on-failure` an einer `Type=oneshot`-Unit braucht systemd ≥ 244 (26.04: 259).
- Systemschnappschüsse (snapper) sind nur lesbar; ein Start daraus über grub-btrfs braucht ein Overlay im initramfs (Ubuntu 26.04
  nutzt dracut) – das Menü zeigt die Stände, „Alten Stand starten“ braucht noch den Overlay-Baustein (Teil B/Update-Kanal).
