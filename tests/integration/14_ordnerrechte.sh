#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 14: Ordnerrechte (0.23.0) – echte ACLs auf btrfs: „@work: kein Zugriff“ sperrt Mitglieder auch mit
# persönlichem Recht (Platte + SMB + Weboberfläche), „nur lesen“, Besitz eingeschränkter Nutzer geht an root, Ausführen-Bit
# bleibt, Neues erbt, Verschieben hinein wird angeglichen, Verknüpfungen nach /etc werden nie angefasst, zweiter Lauf
# ändert nichts, Entfernen gibt den Zugriff zurück; dazu Über-Einhängung per /proc/<pid>/fd (Mechanik für WebDAV/DLNA).
# Ubuntu 26.04, root, Loop-Geräte nötig. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd smbclient btrfs losetup mkfs.btrfs setfacl getfacl setpriv
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots"
umgebung_vorbereiten
# Reste eines früheren Laufs (Linux-Konten und Gruppe bleiben im Wegwerfsystem stehen)
for n in anna bert carl; do pdbedit -x "$n" >/dev/null 2>&1; userdel "$n" >/dev/null 2>&1; done; groupdel work >/dev/null 2>&1
melde "== 14 Ordnerrechte =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"

enthaelt "Gruppe work angelegt" '"ok":true' "$(agent_aktion nutzer.gruppe.anlegen '{"name":"work"}')"
for n in anna bert carl; do
  g='[]'; [ "$n" != carl ] && g='["work"]'
  enthaelt "Nutzer $n angelegt" '"ok":true' "$(agent_aktion nutzer.anlegen "{\"name\":\"$n\",\"passwort\":\"$ADMIN_PW\",\"rolle\":\"nutzer\",\"gruppen\":$g}")"
done
enthaelt "Freigabe: @work, anna (persönlich) und carl schreiben" '"ok":true' \
  "$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"schreiben\":[\"$ADMIN_NAME\",\"@work\",\"anna\",\"carl\"]}")"

F="$FAHNAS_SHARES/$FREIGABE"
als() { local n="$1"; shift; setpriv --reuid "$n" --regid "$(id -g "$n")" --init-groups -- "$@"; }
# Inhalt anlegen wie ein Nutzer (Besitz anna/bert), dazu ein Skript mit Ausführen-Bit und Verknüpfungen nach außen
# Ordner per Python statt mkdir: das Rust-mkdir (uutils) von Ubuntu 26.04 setzt unter einer default-ACL Sticky-/Setuid-Bits
als anna python3 -c 'import os,sys; [os.makedirs(p, exist_ok=True) for p in sys.argv[1:]]' "$F/Zugang/Alt" "$F/Offen"
als anna sh -c "printf geheim > '$F/Zugang/passwort.txt'; printf alt > '$F/Zugang/Alt/alt.txt'; printf '#!/bin/sh\n' > '$F/Zugang/start.sh'; chmod 770 '$F/Zugang/start.sh'"
als bert sh -c "printf bert > '$F/Zugang/von-bert.txt'"
ln -s /etc/hostname "$F/Zugang/link-datei"; ln -s /etc "$F/Zugang/link-ordner"
printf rein > "$F/Offen/rein.txt"; chown carl "$F/Offen/rein.txt"
ETC_VORHER="$(getfacl -p /etc /etc/hostname 2>/dev/null)"
bedingung "anna liest vor der Regel" "$(als anna cat "$F/Zugang/passwort.txt" 2>/dev/null)" = "geheim"

# --- Regel setzen: @work kein Zugriff, carl nur lesen ---------------------------------------------------------------
ANTWORT="$(agent_aktion freigaben.ordnerrechte.setzen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"Zugang\",\"regeln\":{\"@work\":\"keiner\",\"carl\":\"lesen\"}}")"
ID="$(json_feld "$ANTWORT" aufgabe)"
AUFGABE="$(aufgabe_abwarten "$ID")"
enthaelt "Regel gespeichert und angewendet (Aufgabe fertig)" '"status":"fertig"' "$AUFGABE"
enthaelt "Einträge geändert" '"geaendert":[1-9]' "$AUFGABE"

! als anna ls "$F/Zugang" >/dev/null 2>&1 && ok "anna (Gruppe + persönliches Recht) kommt nicht hinein" || schlecht "anna sieht Zugang"
! als anna cat "$F/Zugang/Alt/alt.txt" >/dev/null 2>&1 && ok "anna kommt auch nicht an Unterordner" || schlecht "anna liest Alt/alt.txt"
! als bert ls "$F/Zugang" >/dev/null 2>&1 && ok "bert (Gruppe) kommt nicht hinein" || schlecht "bert sieht Zugang"
bedingung "carl darf lesen" "$(als carl cat "$F/Zugang/passwort.txt" 2>/dev/null)" = "geheim"
! als carl touch "$F/Zugang/neu.txt" 2>/dev/null && ok "carl darf nicht schreiben" || schlecht "carl konnte schreiben"
! als carl rm -f "$F/Zugang/passwort.txt" 2>/dev/null && ok "carl darf nicht löschen" || schlecht "carl konnte löschen"
bedingung "Besitz von anna ging an root" "$(stat -c %U "$F/Zugang/passwort.txt")" = "root"
bedingung "Besitz von bert ging an root" "$(stat -c %U "$F/Zugang/von-bert.txt")" = "root"
bedingung "Ordner bleibt setgid" "$(stat -c %A "$F/Zugang" | cut -c7)" = "s"
enthaelt "Skript behält das Ausführen-Bit" '^user::rwx' "$(getfacl -p "$F/Zugang/start.sh" 2>/dev/null)"
enthaelt "Textdatei ohne Ausführen-Bit" '^user::rw-' "$(getfacl -p "$F/Zugang/passwort.txt" 2>/dev/null)"
enthaelt "Ordner trägt die Regel als default-ACL" '^default:user:anna:---' "$(getfacl -p "$F/Zugang" 2>/dev/null)"
bedingung "Verknüpfungen nach /etc nicht angefasst" "$(getfacl -p /etc /etc/hostname 2>/dev/null)" = "$ETC_VORHER"
bedingung "Freigabe-Wurzel unverändert (anna liest Offen)" "$(als anna ls "$F/Offen" 2>/dev/null)" = "rein.txt"

# Neues erbt: der Admin legt eine Datei an → anna/bert kommen nicht ran, carl liest
printf neu > "$F/Zugang/neu-vom-admin.txt"
enthaelt "Neue Datei erbt die Sperre" '^user:anna:---' "$(getfacl -p "$F/Zugang/neu-vom-admin.txt" 2>/dev/null)"

# SMB: anna wird abgewiesen, carl liest, darf aber nichts ablegen
SMB_ANNA="$(smbclient "//127.0.0.1/$FREIGABE" -U "anna%$ADMIN_PW" -m SMB3 -c 'ls Zugang\*' 2>&1)"
enthaelt "SMB: anna → Zugriff verweigert" 'NT_STATUS_ACCESS_DENIED' "$SMB_ANNA"
SMB_CARL="$(smbclient "//127.0.0.1/$FREIGABE" -U "carl%$ADMIN_PW" -m SMB3 -c 'ls Zugang\*' 2>&1)"
enthaelt "SMB: carl sieht den Inhalt" 'passwort.txt' "$SMB_CARL"
printf x > "$IT/smb.txt"
SMB_PUT="$(smbclient "//127.0.0.1/$FREIGABE" -U "carl%$ADMIN_PW" -m SMB3 -c "put $IT/smb.txt Zugang\\smb.txt" 2>&1)"
enthaelt "SMB: carl kann nichts ablegen" 'NT_STATUS_ACCESS_DENIED' "$SMB_PUT"

# Weboberfläche als anna: Ordner sichtbar, aber gesperrt; Öffnen → „Nicht für dich freigegeben“
KEKSE_ADMIN="$KEKSE"; KEKSE="$IT/kekse-anna"; rm -f "$KEKSE"
enthaelt "anna meldet sich an" '"ok":true' "$(api_post /api/anmelden "{\"name\":\"anna\",\"passwort\":\"$ADMIN_PW\"}")"
LISTE="$(agent_aktion dateien.liste "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"\"}")"
enthaelt "Liste: Zugang sichtbar und gesperrt" '"name":"Zugang"[^}]*"gesperrt":true' "$LISTE"
enthaelt "Öffnen → Nicht für dich freigegeben" '"gesperrt":true' "$(agent_aktion dateien.liste "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"Zugang\"}")"
KEKSE="$KEKSE_ADMIN"

# Zweiter Lauf ändert nichts (nur Abweichungen werden geschrieben – Schnappschüsse wachsen nicht)
ANTWORT="$(agent_aktion freigaben.ordnerrechte.setzen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"Zugang\",\"regeln\":{\"@work\":\"keiner\",\"carl\":\"lesen\"}}")"
enthaelt "Zweiter Lauf: nichts geändert" '"geaendert":0' "$(aufgabe_abwarten "$(json_feld "$ANTWORT" aufgabe)")"

# Verschieben hinein (Weboberfläche): die Datei behält sonst ihre alten Rechte → wird angeglichen
ANTWORT="$(agent_aktion dateien.verschieben "{\"freigabe\":\"$FREIGABE\",\"quellen\":[\"Offen/rein.txt\"],\"ziel_freigabe\":\"$FREIGABE\",\"ziel_pfad\":\"Zugang\"}")"
enthaelt "Verschieben hinein fertig" '"status":"fertig"' "$(aufgabe_abwarten "$(json_feld "$ANTWORT" aufgabe)") $ANTWORT"
enthaelt "Hineinverschobene Datei bekommt die Sperre" '^user:anna:---' "$(getfacl -p "$F/Zugang/rein.txt" 2>/dev/null)"

# Umbenennen in der Weboberfläche zieht die Regel mit
enthaelt "Umbenennen" '"ok":true' "$(agent_aktion dateien.umbenennen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"Zugang\",\"neuer_name\":\"Zugangsdaten\"}")"
enthaelt "Regel hängt am neuen Namen" '"pfad":"Zugangsdaten"' "$(agent_aktion freigaben.ordnerrechte.liste '{}')"

# Entfernen: Rechte der Freigabe gelten wieder
ANTWORT="$(agent_aktion freigaben.ordnerrechte.setzen "{\"freigabe\":\"$FREIGABE\",\"pfad\":\"Zugangsdaten\",\"regeln\":{}}")"
aufgabe_abwarten "$(json_feld "$ANTWORT" aufgabe)" >/dev/null
bedingung "Nach dem Entfernen liest anna wieder" "$(als anna cat "$F/Zugangsdaten/passwort.txt" 2>/dev/null)" = "geheim"
als bert touch "$F/Zugangsdaten/wieder.txt" 2>/dev/null && ok "bert schreibt wieder" || schlecht "bert kann nach dem Entfernen nicht schreiben"
bedingung "Verknüpfungen nach /etc weiterhin unberührt" "$(getfacl -p /etc /etc/hostname 2>/dev/null)" = "$ETC_VORHER"

# Über-Einhängung über /proc/<pid>/fd (Mechanik der WebDAV/DLNA-Ansichten): landet genau im Ordner, nicht hinter einer Verknüpfung
mkdir -p "$IT/ansicht/echt"; ln -s /etc "$IT/ansicht/falle"
UEBER="$(node --input-type=module -e "
const { ordnerGriff, griffPfad } = await import('$WURZEL/src/agent/freigaben/ordnerrechte-abgleich.js');
const { execFileSync } = await import('node:child_process');
const fh = await ordnerGriff('$IT/ansicht', 'echt');
execFileSync('mount', ['--no-canonicalize', '-t', 'tmpfs', '-o', 'ro,mode=000,size=4k', 'fahnas-gesperrt', griffPfad(fh)]);
await fh.close();
const falle = await ordnerGriff('$IT/ansicht', 'falle');
console.log(falle === null ? 'falle-abgelehnt' : 'falle-offen');
")"
enthaelt "Verknüpfung als Ziel wird abgelehnt" 'falle-abgelehnt' "$UEBER"
enthaelt "tmpfs liegt genau auf dem Ordner" "fahnas-gesperrt $IT/ansicht/echt tmpfs" "$(findmnt -rn -o SOURCE,TARGET,FSTYPE "$IT/ansicht/echt")"
umount "$IT/ansicht/echt" 2>/dev/null
ergebnis
