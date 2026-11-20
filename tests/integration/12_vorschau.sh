#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 12: Vorschaubilder (0.4.0) – GET /api/dateien/vorschau mit echtem ffmpeg als Nutzer: Bild (Seitenverhältnis,
# kein Vergrößern), Video (Sprung auf Sekunde 3, kurzes Video ab 0), WebP, Zwischenspeicher (root 0700, zweiter Abruf
# identisch), Leserecht über die Freigabe-ACL (Lesenutzer bekommt das Bild; ohne Recht an der Datei → E_RECHTE, auch bei
# Treffer), Fehler als JSON (kaputt, falsche Größe,
# Textdatei). Ubuntu 26.04, root, Loop-Geräte nötig. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd btrfs losetup mkfs.btrfs setfacl ffmpeg ffprobe setpriv cmp
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots"
umgebung_vorbereiten
export FAHNAS_VORSCHAU="$IT/vorschau"
melde "== 12 Vorschaubilder =="

mkdir -p "$POOL"
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 2G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"
bedingung "Zwischenspeicher-Ordner beim Start angelegt (root 0700)" "$(stat -c '%U:%a' "$FAHNAS_VORSCHAU" 2>/dev/null)" = "root:700"
# Zweiter Nutzer „leser“ mit Leserecht VOR dem Hochladen (die ACL der Freigabe vererbt sich nur auf neue Dateien)
LESER="$(agent_aktion nutzer.anlegen "{\"name\":\"leser\",\"anzeigename\":\"Leser\",\"passwort\":\"$ADMIN_PW\",\"rolle\":\"nutzer\"}")"
enthaelt "Nutzer leser angelegt" '"ok":true' "$LESER"
AEND="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"lesen\":[\"leser\"],\"schreiben\":[\"$ADMIN_NAME\"]}")"
enthaelt "leser darf die Freigabe lesen" '"ok":true' "$AEND"

# Testdateien: Foto 400×200, PNG mit Transparenz, Videos (1 s und 5 s), kaputte JPEG, Textdatei
FF="ffmpeg -nostdin -hide_banner -loglevel error -y"
$FF -f lavfi -i testsrc=size=400x200:rate=1 -frames:v 1 "$IT/foto.jpg"
$FF -f lavfi -i color=c=red@0.5:size=100x100:rate=1,format=rgba -frames:v 1 "$IT/alpha.png"
$FF -f lavfi -i testsrc=size=320x180:rate=25 -t 1 -c:v libx264 -pix_fmt yuv420p "$IT/kurz.mp4"
$FF -f lavfi -i testsrc=size=320x180:rate=25 -t 5 -c:v libx264 -pix_fmt yuv420p "$IT/lang.mp4"
head -c 2000 /dev/urandom > "$IT/kaputt.jpg"
printf 'nur Text\n' > "$IT/notiz.txt"
hochladen() { curl -sk -b "$KEKSE" -c "$KEKSE" -H "X-FAHNAS-CSRF: $(csrf_token)" -H 'Content-Type: application/octet-stream' --data-binary "@$IT/$1" "$BASIS/api/dateien/hochladen?freigabe=$FREIGABE&pfad=&name=$1"; }
for f in foto.jpg alpha.png kurz.mp4 lang.mp4 kaputt.jpg notiz.txt; do enthaelt "Hochladen $f" '"ok":true' "$(hochladen "$f")"; done

vorschau() {   # vorschau <pfad> <groesse> <ausgabedatei> → HTTP-Status; Kopfzeilen in <ausgabedatei>.kopf
    curl -sk -b "$KEKSE" -o "$3" -D "$3.kopf" -w '%{http_code}' "$BASIS/api/dateien/vorschau?freigabe=$FREIGABE&pfad=$1&groesse=$2&v=1-2"
}
masse() { ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$1" 2>/dev/null | head -1; }

# Foto: 256 → 256×128 (Seitenverhältnis), WebP, Cache-Kopfzeilen
S="$(vorschau foto.jpg 256 "$IT/v_foto.webp")"
bedingung "Vorschau Foto: HTTP 200" "$S" = "200"
enthaelt "Antwort ist image/webp" '^Content-Type: image/webp' "$(cat "$IT/v_foto.webp.kopf")"
enthaelt "Browser darf 7 Tage zwischenspeichern" 'max-age=604800' "$(cat "$IT/v_foto.webp.kopf")"
enthaelt "Eigene CSP auf der Bildantwort" "default-src 'none'" "$(cat "$IT/v_foto.webp.kopf")"
bedingung "Foto 400×200 → 256×128" "$(masse "$IT/v_foto.webp")" = "256,128"
ANZ="$(find "$FAHNAS_VORSCHAU" -type f -name '*.webp' | wc -l | tr -d ' ')"
bedingung "Zwischenspeicher enthält genau ein Bild" "$ANZ" = "1"
bedingung "Bild im Zwischenspeicher gehört root, 0600" "$(stat -c '%U:%a' "$(find "$FAHNAS_VORSCHAU" -type f -name '*.webp' | head -1)")" = "root:600"
S="$(vorschau foto.jpg 256 "$IT/v_foto2.webp")"
pruefe "Zweiter Abruf liefert dasselbe Bild (Zwischenspeicher)" cmp "$IT/v_foto.webp" "$IT/v_foto2.webp"
bedingung "Zwischenspeicher weiterhin ein Bild" "$(find "$FAHNAS_VORSCHAU" -type f -name '*.webp' | wc -l | tr -d ' ')" = "1"
# 512: kein Vergrößern über das Original (400×200 bleibt)
vorschau foto.jpg 512 "$IT/v_foto512.webp" >/dev/null
bedingung "512 vergrößert nicht: 400×200" "$(masse "$IT/v_foto512.webp")" = "400,200"
# 128
vorschau foto.jpg 128 "$IT/v_foto128.webp" >/dev/null
bedingung "128 → 128×64" "$(masse "$IT/v_foto128.webp")" = "128,64"
# PNG mit Transparenz bleibt transparent (yuva)
vorschau alpha.png 256 "$IT/v_alpha.webp" >/dev/null
enthaelt "Transparenz bleibt erhalten (Pixelformat mit Alpha)" 'yuva|argb|rgba' "$(ffprobe -v error -show_entries stream=pix_fmt -of csv=p=0 "$IT/v_alpha.webp")"
# Videos: lang (Sprung auf Sekunde 3) und kurz (Rückfall ab 0)
S="$(vorschau lang.mp4 256 "$IT/v_lang.webp")"; bedingung "Video 5 s: HTTP 200" "$S" = "200"
bedingung "Video 320×180 → 256×144" "$(masse "$IT/v_lang.webp")" = "256,144"
S="$(vorschau kurz.mp4 256 "$IT/v_kurz.webp")"; bedingung "Video 1 s (kürzer als Sprung): HTTP 200" "$S" = "200"
bedingung "kurzes Video: Bild ab Anfang 256×144" "$(masse "$IT/v_kurz.webp")" = "256,144"
# Fehler als JSON
S="$(vorschau kaputt.jpg 256 "$IT/v_kaputt.json")"
bedingung "Kaputte Datei: HTTP 5xx" "${S:0:1}" = "5"
enthaelt "Kaputte Datei: E_SYSTEM als JSON" '"code":"E_SYSTEM"' "$(cat "$IT/v_kaputt.json")"
S="$(vorschau kaputt.jpg 256 "$IT/v_kaputt2.json")"
enthaelt "Kaputte Datei erneut: gemerkter Fehler" '"code":"E_SYSTEM"' "$(cat "$IT/v_kaputt2.json")"
S="$(vorschau notiz.txt 256 "$IT/v_txt.json")"; bedingung "Textdatei: HTTP 400" "$S" = "400"
enthaelt "Textdatei: E_PARAMS" '"code":"E_PARAMS"' "$(cat "$IT/v_txt.json")"
S="$(vorschau foto.jpg 300 "$IT/v_300.json")"; bedingung "Größe 300: HTTP 400" "$S" = "400"
S="$(vorschau fehlt.jpg 256 "$IT/v_fehlt.json")"; bedingung "Fehlende Datei: HTTP 404" "$S" = "404"
S="$(curl -sk -o /dev/null -w '%{http_code}' "$BASIS/api/dateien/vorschau?freigabe=$FREIGABE&pfad=foto.jpg&groesse=256")"
bedingung "Ohne Sitzung: HTTP 401" "$S" = "401"

# Zweiter Nutzer „leser“ (Leserecht auf der Freigabe, siehe oben – ACLs gelten für danach angelegte Dateien): Vorschau aus dem
# Speicher erlaubt; ohne Leserecht an der Datei → E_RECHTE
KEKSE_ADMIN="$KEKSE"; KEKSE="$IT/kekse_leser"
ANM="$(api_post /api/anmelden "{\"name\":\"leser\",\"passwort\":\"$ADMIN_PW\"}")"
enthaelt "leser angemeldet" '"ok":true' "$ANM"
S="$(vorschau foto.jpg 256 "$IT/v_leser.webp")"
bedingung "leser mit Leserecht: HTTP 200 (Treffer aus dem Speicher)" "$S" = "200"
pruefe "leser bekommt dasselbe Bild" cmp "$IT/v_foto.webp" "$IT/v_leser.webp"
chmod 600 "$FAHNAS_SHARES/$FREIGABE/foto.jpg"; chown "$ADMIN_NAME" "$FAHNAS_SHARES/$FREIGABE/foto.jpg"
S="$(vorschau foto.jpg 256 "$IT/v_leser2.json")"
bedingung "leser ohne Leserecht an der Datei: HTTP 403 trotz Treffer" "$S" = "403"
enthaelt "… mit E_RECHTE" '"code":"E_RECHTE"' "$(cat "$IT/v_leser2.json")"
S="$(vorschau lang.mp4 512 "$IT/v_leser3.webp")"
bedingung "leser: neues Bild (512) für lesbare Datei wird als Nutzer erzeugt" "$S" = "200"
bedingung "… 320×180 bleibt (kein Vergrößern)" "$(masse "$IT/v_leser3.webp")" = "320,180"
chmod 600 "$FAHNAS_SHARES/$FREIGABE/lang.mp4"; chown "$ADMIN_NAME" "$FAHNAS_SHARES/$FREIGABE/lang.mp4"
S="$(vorschau lang.mp4 128 "$IT/v_leser4.json")"
bedingung "leser: Erzeugen ohne Leserecht → 403" "$S" = "403"
KEKSE="$KEKSE_ADMIN"
S="$(vorschau foto.jpg 256 "$IT/v_admin.webp")"
bedingung "Admin (Besitzer) weiterhin: HTTP 200" "$S" = "200"
# Aufräumen des Zwischenspeichers über die Klasse (Alter 0 → alles weg)
node --input-type=module -e "
  import { Vorschau } from '$WURZEL/src/agent/helfer/vorschau.js';
  const v = new Vorschau({ system: {}, ordner: '$FAHNAS_VORSCHAU', protokoll: () => {} });
  const r = await v.aufraeumen({ maxAlterMs: 0 });
  process.stdout.write(String(r.geloescht));
" > "$IT/aufgeraeumt.txt"
bedingung "aufraeumen(maxAlter 0) löscht alle Bilder" "$(cat "$IT/aufgeraeumt.txt")" = "$(( $(find "$FAHNAS_VORSCHAU" -type f | wc -l | tr -d ' ') + $(cat "$IT/aufgeraeumt.txt") ))"
bedingung "Zwischenspeicher danach leer" "$(find "$FAHNAS_VORSCHAU" -type f | wc -l | tr -d ' ')" = "0"
ergebnis
