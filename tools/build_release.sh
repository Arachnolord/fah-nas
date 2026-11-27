#!/usr/bin/env bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Baut das Release-Archiv: dist/fahnas_release-<version>.tar.gz (+ .sha256) und die Kopie dist/fahnas_release.tar.gz.
# Läuft auf macOS (bsdtar) und Linux (GNU tar). Keine macOS-Metadaten (._*, .DS_Store), Besitzer root:root.
# FAH-Apps (Katalog-Vorlagen mit „bauen.release_zip“): der Inhalt des finalen Release-ZIPs der App kommt als
# Build-Kontext nach katalog/quellen/<id>/ (+ <id>.json mit Prüfsumme/Version) – FAH-NAS baut das Image beim Installieren
# selbst, es braucht keine Registry. ZIP-Ordner: $FAHNAS_APP_ZIPS (Standard ~/claude/NEUE ZIPs, samt Unterordnern).
# Ortsdaten: geo/ (laender.json aus dem Git + dbip-country-lite.mmdb, nicht im Git) kommt ins Release; die Länder-
# Datenbank holt tools/geo_holen.mjs bei Bedarf (fehlt, unlesbar oder älter als 45 Tage) – --ohne-geo-holen lässt das aus.
# --oeffentlich (27.11.2026): Release für die öffentliche Installer-ISO – ohne eigene Apps (Vorlagen mit release_zip bzw.
# katalog/fah-*.json, keine App-Quellen) und bereinigt wie der „Öffentliche Stand“ von FAH-Git (tools/oeffentlich_bereinigen.mjs,
# Regeln privat außerhalb des Repos: $FAHNAS_OEFFENTLICH_REGELN, Standard ~/.config/fah-oeffentlich/regeln.json). Bricht ab,
# sobald nach der Bereinigung noch Verbotenes drinsteckt. Ergebnis: dist/fahnas_release_oeffentlich.tar.gz (+ .sha256).
# Aufruf: tools/build_release.sh [--ausgabe <ordner>] [--ohne-app-quellen] [--ohne-geo-holen] [--oeffentlich]

set -euo pipefail

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUSGABE="$WURZEL/dist"
APP_ZIPS="${FAHNAS_APP_ZIPS:-$HOME/claude/NEUE ZIPs}"
OHNE_APP_QUELLEN=0
OHNE_GEO_HOLEN=0
OEFFENTLICH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ausgabe) AUSGABE="$2"; shift 2 ;;
    --ohne-app-quellen) OHNE_APP_QUELLEN=1; shift ;;
    --ohne-geo-holen) OHNE_GEO_HOLEN=1; shift ;;
    --oeffentlich) OEFFENTLICH=1; OHNE_APP_QUELLEN=1; shift ;;
    -h|--help|hilfe) echo "Aufruf: $0 [--ausgabe <ordner>] [--ohne-app-quellen] [--ohne-geo-holen] [--oeffentlich]"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

cd "$WURZEL"
[ -f BUILD_VERSION ] || { echo "BUILD_VERSION fehlt in $WURZEL" >&2; exit 1; }
VERSION="$(tr -d '[:space:]' < BUILD_VERSION)"
[ -n "$VERSION" ] || { echo "BUILD_VERSION ist leer" >&2; exit 1; }

# Alles wird in einem Bereitstellungsordner zusammengestellt – der Arbeitsbaum bleibt unangetastet (auch wenn der Bau
# mittendrin scheitert oder ein Test das Skript aufruft).
# Feste Dateirechte, egal mit welcher umask der Bau startet (16.10.2026: ein Bau unter umask 077 packte alles 0600/0700 –
# der Web-Dienst (Nutzer fahnas) konnte /opt/fahnas nicht mehr lesen, die Oberfläche fiel aus).
umask 022
BEREIT="$(mktemp -d "${TMPDIR:-/tmp}/fahnas-release.XXXXXX")"
trap 'rm -rf "$BEREIT"' EXIT
# Build-Kontexte der FAH-Apps aus den finalen Release-ZIPs (immer frisch – nichts Altes mitschleppen)
QUELLEN="$BEREIT/katalog/quellen"
if [ "$OHNE_APP_QUELLEN" = "0" ]; then
  command -v node >/dev/null || { echo "node fehlt (liest die Katalog-Vorlagen)" >&2; exit 1; }
  command -v unzip >/dev/null || { echo "unzip fehlt" >&2; exit 1; }
  mkdir -p "$QUELLEN"
  # id<TAB>zip je Vorlage mit bauen.release_zip
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    for (const n of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const v = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (v && v.bauen && v.bauen.release_zip) console.log(v.id + "\t" + v.bauen.release_zip);
    }' "$WURZEL/katalog" > "$QUELLEN/.liste"
  while IFS=$'\t' read -r id zip; do
    [ -n "$id" ] || continue
    quelle="$APP_ZIPS/$zip"
    if [ ! -f "$quelle" ]; then            # NEUE ZIPs ist seit 16.11.2026 in Unterordner sortiert: dort suchen (genau EIN Treffer)
      treffer="$(find "$APP_ZIPS" -type f -name "$zip" 2>/dev/null)"
      [ "$(printf '%s\n' "$treffer" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] && quelle="$treffer"
    fi
    [ -f "$quelle" ] || { echo "FEHLER: Release-ZIP für $id fehlt oder liegt mehrfach unter $APP_ZIPS: $zip (oder --ohne-app-quellen)" >&2; exit 1; }
    ziel="$QUELLEN/$id"
    mkdir -p "$ziel"
    unzip -q -o "$quelle" -d "$ziel"
    # interne Notizen des Betreibers (memory.md mit NAS-IP/SSH-Port, CLAUDE.md, .claude/) und macOS-Reste gehören nicht ins NAS-Programm
    find "$ziel" \( -name memory.md -o -name CLAUDE.md -o -name .claude -o -name __MACOSX -o -name .DS_Store -o -name '._*' \) -prune -exec rm -rf {} +
    # ZIP mit genau einem Oberordner (ohne Dockerfile auf der Wurzel) → Inhalt eine Ebene hoch
    if [ ! -f "$ziel/Dockerfile" ]; then
      unter="$(find "$ziel" -mindepth 1 -maxdepth 1)"
      if [ "$(printf '%s\n' "$unter" | wc -l | tr -d ' ')" = "1" ] && [ -f "$unter/Dockerfile" ]; then
        tmpd="$ziel.tmp"; mv "$unter" "$tmpd"; rm -rf "$ziel"; mv "$tmpd" "$ziel"
      fi
    fi
    [ -f "$ziel/Dockerfile" ] || { echo "FEHLER: $zip enthält keinen Dockerfile auf der obersten Ebene" >&2; exit 1; }
    # Nur behalten, was der Bau braucht: Dockerfile, .dockerignore, BUILD_VERSION und die Quellen der COPY/ADD-Zeilen.
    # README, Beispiel-.env, manage.sh, Tests usw. tragen Details des Heimnetzes (IPs, DDNS-Domain, VPN-Netz) – nicht ins NAS.
    node -e '
      const fs = require("fs"), path = require("path");
      const wurzel = process.argv[1];
      const text = fs.readFileSync(path.join(wurzel, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
      const behalten = new Set(["Dockerfile", ".dockerignore", "BUILD_VERSION"]);
      for (const zeile of text.split("\n")) {
        const m = /^\s*(COPY|ADD)\s+(.*)$/i.exec(zeile);
        if (!m) continue;
        let teile;
        const rest = m[2].trim();
        if (rest.startsWith("[")) teile = JSON.parse(rest); else teile = rest.split(/\s+/);
        teile = teile.filter((t) => !t.startsWith("--"));
        if (/(^|\s)--from=/.test(rest)) continue;
        for (const q of teile.slice(0, -1)) behalten.add(path.posix.normalize(q).replace(/^\.\//, "").replace(/\/+$/, ""));
      }
      if ([...behalten].some((b) => b === "." || b === "" || /[*?]/.test(b))) { console.log("  (COPY . oder Muster – Kontext bleibt vollständig)"); process.exit(0); }
      const weg = [];
      (function gehen(rel) {
        for (const n of fs.readdirSync(path.join(wurzel, rel))) {
          const r = rel ? rel + "/" + n : n;
          if ([...behalten].some((b) => r === b || r.startsWith(b + "/"))) continue;
          if ([...behalten].some((b) => b.startsWith(r + "/")) && fs.statSync(path.join(wurzel, r)).isDirectory()) { gehen(r); continue; }
          fs.rmSync(path.join(wurzel, r), { recursive: true, force: true }); weg.push(r);
        }
      })("");
      for (const b of behalten) if (!fs.existsSync(path.join(wurzel, b)) && !["Dockerfile", ".dockerignore", "BUILD_VERSION"].includes(b)) { console.error("FEHLER: COPY-Quelle fehlt im ZIP: " + b); process.exit(1); }
      console.log("  (entfernt, vom Bau nicht gebraucht: " + (weg.join(", ") || "nichts") + ")");
    ' "$ziel"
    if command -v sha256sum >/dev/null 2>&1; then summe="$(sha256sum "$quelle" | cut -d' ' -f1)"; else summe="$(shasum -a 256 "$quelle" | cut -d' ' -f1)"; fi
    appversion=""; [ -f "$ziel/BUILD_VERSION" ] && appversion="$(tr -d '[:space:]' < "$ziel/BUILD_VERSION")"
    printf '{"zip":"%s","sha256":"%s","version":"%s"}\n' "$zip" "$summe" "$appversion" > "$QUELLEN/$id.json"
    echo "  App-Quelle $id ← $zip (${appversion:-ohne Version}, sha256 ${summe:0:12}…)"
  done < "$QUELLEN/.liste"
  rm -f "$QUELLEN/.liste"
fi

# Länder-Ortsdaten (DB-IP Country Lite, CC BY 4.0) für den Rückfall des NAS ohne Internet. Einzige Ausnahme vom
# unberührten Arbeitsbaum: geo/dbip-country-lite.mmdb ist ein Zwischenspeicher (gitignored), damit nicht jeder Bau lädt.
if [ "$OHNE_GEO_HOLEN" = "0" ]; then
  command -v node >/dev/null || { echo "node fehlt (holt die Länder-Ortsdaten)" >&2; exit 1; }
  node tools/geo_holen.mjs --wenn-noetig || { echo "FEHLER: Länder-Ortsdaten fehlen (Internet? – oder --ohne-geo-holen)" >&2; exit 1; }
fi
[ -f geo/dbip-country-lite.mmdb ] || echo "Hinweis: geo/dbip-country-lite.mmdb fehlt – Release ohne Länder-Ortsdaten" >&2

# Inhalt: nur was auf dem NAS gebraucht wird (LICENSE-HINWEIS.md: Namensnennung DB-IP/Natural Earth reist mit den Daten)
INHALT=(src public tools systemd katalog geo package.json BUILD_VERSION README.md LICENSE-HINWEIS.md)
[ -d docs/handbuch ] && INHALT+=(docs/handbuch)
VORHANDEN=()
for e in "${INHALT[@]}"; do
  if [ -e "$e" ]; then
    VORHANDEN+=("$e")
    mkdir -p "$BEREIT/$(dirname "$e")"
    # katalog/quellen im Arbeitsbaum (Überbleibsel älterer Bauten) nie übernehmen – die Quellen kommen nur frisch aus den ZIPs
    if [ "$e" = "katalog" ]; then
      mkdir -p "$BEREIT/katalog"
      for k in katalog/* katalog/.[!.]*; do [ -e "$k" ] && [ "$k" != "katalog/quellen" ] && cp -R "$k" "$BEREIT/katalog/"; done
    else
      cp -R "$e" "$BEREIT/$e"
    fi
  else echo "Hinweis: $e fehlt, wird ausgelassen" >&2; fi
done
[ -d src ] && [ -f package.json ] || { echo "src/ oder package.json fehlt – falsches Verzeichnis?" >&2; exit 1; }

if [ "$OEFFENTLICH" = "1" ]; then
  command -v node >/dev/null || { echo "node fehlt (öffentliche Bereinigung)" >&2; exit 1; }
  # Eigene Apps raus: Vorlagen mit bauen.release_zip und katalog/fah-*.json (wie im GitHub-Spiegel weggelassen)
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1]; const weg = [];
    for (const n of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      let v = null; try { v = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch {}
      if (/^fah-/i.test(n) || (v && v.bauen && v.bauen.release_zip)) { fs.rmSync(path.join(dir, n)); weg.push(n); }
    }
    console.log("  öffentlich: eigene Apps entfernt (" + (weg.join(", ") || "keine") + ")");
  ' "$BEREIT/katalog"
  rm -rf "$BEREIT/katalog/quellen"
  # Persönliches Umstiegsprotokoll (Platten, Konten des eigenen NAS) gehört nicht in die öffentliche Fassung
  rm -f "$BEREIT/docs/handbuch/umstieg-ugos.md"
  node "$WURZEL/tools/oeffentlich_bereinigen.mjs" --regeln "${FAHNAS_OEFFENTLICH_REGELN:-$HOME/.config/fah-oeffentlich/regeln.json}" "$BEREIT" \
    || { echo "FEHLER: öffentliche Bereinigung fehlgeschlagen – kein öffentliches Release" >&2; exit 1; }
fi

mkdir -p "$AUSGABE"
BASIS="fahnas_release"; [ "$OEFFENTLICH" = "1" ] && BASIS="fahnas_release_oeffentlich"
NAME="$BASIS-$VERSION.tar.gz"
ZIEL="$AUSGABE/$NAME"

# tar-Variante erkennen: GNU tar (Linux) oder bsdtar (macOS) – Besitzer auf root normieren
TAR_OPTS=(--exclude='.DS_Store' --exclude='._*' --exclude='*.tmp' --exclude='node_modules')
if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
  TAR_OPTS+=(--owner=0 --group=0 --numeric-owner)
else
  TAR_OPTS+=(--uid 0 --gid 0 --uname root --gname root)
fi

# Kommandozeile muss ausführbar sein
chmod 755 tools/fahnas tools/build_release.sh 2>/dev/null || true

chmod 755 "$BEREIT/tools/fahnas" "$BEREIT/tools/build_release.sh" 2>/dev/null || true
# alles lesbar für alle (Ordner betretbar), ausführbare Dateien bleiben ausführbar, nichts für andere beschreibbar
chmod -R u+rwX,go+rX,go-w "$BEREIT"
COPYFILE_DISABLE=1 tar "${TAR_OPTS[@]}" -C "$BEREIT" -czf "$ZIEL" "${VORHANDEN[@]}"

# Prüfsumme (macOS: shasum, Linux: sha256sum) – Format wie sha256sum, damit „sha256sum -c“ funktioniert
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$AUSGABE" && sha256sum "$NAME" > "$NAME.sha256")
else
  (cd "$AUSGABE" && shasum -a 256 "$NAME" > "$NAME.sha256")
fi

cp "$ZIEL" "$AUSGABE/$BASIS.tar.gz"
SUMME="$(cut -d' ' -f1 "$ZIEL.sha256")"
printf '%s  %s\n' "$SUMME" "$BASIS.tar.gz" > "$AUSGABE/$BASIS.tar.gz.sha256"

GROESSE="$(du -k "$ZIEL" | cut -f1)"
echo "Release $VERSION gebaut:"
echo "  $ZIEL (${GROESSE} KB)"
echo "  $ZIEL.sha256  ($SUMME)"
echo "  $AUSGABE/$BASIS.tar.gz (+ .sha256)"
echo "Auf dem NAS einspielen: fahnas update fahnas_release.tar.gz"
