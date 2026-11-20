#!/bin/bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Integrationstest 13: Zusammenarbeit (0.21.0) auf echtem Linux –
#   (a) Texteditor: dateien.text.speichern legt die Datei mit der uid des Nutzers an; veralteter Stand (Größe) → E_GEAENDERT
#       (HTTP 409, Stand der Platte in details), nichts geschrieben, keine Zwischendatei; mit aktuellem Stand klappt es.
#   (b) Chat: Anhang „auf dem NAS speichern“ (chat.anhang.speichern) kopiert ALS der Nutzer in die Freigabe (freier Name
#       „(1)“); Freigabe ohne Schreibrecht → E_RECHTE, keine Datei.
#   (c) Office: Bündel des Admins, vom zweiten Nutzer über eine Office-Freigabe bearbeitet – über den WebSocket
#       /api/office/ws wie im Browser (Speichern macht der Web-Dienst) – gehört danach weiter dem Besitzer.
#   (d) Chat-Speicher (FAHNAS_CHAT, im Betrieb /data/chat): beim Start als btrfs-Unterlaufwerk angelegt, root 0700.
#   Dazu: keine Inhalte (Text, Nachricht, Dokument) im Prüfprotokoll (V1).
# Ubuntu 26.04, root, Loop-Geräte nötig. Exit 0/1/3.
. "$(dirname "${BASH_SOURCE[0]}")/_gemeinsam.sh"
als_root
braucht node curl testparm smbd btrfs losetup mkfs.btrfs setfacl setpriv cmp
POOL="${FAHNAS_IT:-/tmp/fahnas-it}/pool"
# Chat-Speicher wie /data/chat auf dem Daten-Pool (eigenes btrfs-Unterlaufwerk), Freigaben und Schnappschüsse ebenso
export FAHNAS_SHARES="$POOL/shares" FAHNAS_SNAPSHOTS="$POOL/.snapshots" FAHNAS_CHAT="$POOL/chat"
umgebung_vorbereiten
melde "== 13 Zusammenarbeit (Texteditor, Chat, Office) =="

ZWEITER="leser"   # zweiter Nutzer (Rolle nutzer): in „$FREIGABE“ nur Leserecht, in „$TEAM“ Schreibrecht
TEAM="team"
KEKSE_ZWEITER="$IT/kekse_$ZWEITER"
als_zweiter() ( KEKSE="$KEKSE_ZWEITER"; "$@" )   # Web-API mit der Sitzung des zweiten Nutzers (Unterschale)
agent_status() {   # agent_status <aktion> '<json>' <ausgabedatei> → HTTP-Status; die Antwort steht in der Datei
    curl -sk -b "$KEKSE" -c "$KEKSE" -H 'Content-Type: application/json' -H "X-FAHNAS-CSRF: $(csrf_token)" -X POST \
        --data-binary "$2" -o "$3" -w '%{http_code}' "$BASIS/api/agent/$1"
}
keks_kopf() {   # keks_kopf <keksdatei> → „name=wert; …“ für den Cookie-Kopf (auch HttpOnly-Kekse)
    awk 'NF >= 7 && ($1 !~ /^#/ || $1 ~ /^#HttpOnly_/) { printf "%s%s=%s", (n++ ? "; " : ""), $6, $7 }' "$1"
}

mkdir -p "$POOL"
# 6 GiB (dünn belegt): der Chat hält auf seiner Platte 2 GiB Reserve frei – auf 2 GiB nähme er keinen Anhang an
GERAET="$(btrfs_pool_anlegen FAHNAS-DATEN 6G "$POOL")" || { schlecht "btrfs-Loop-Pool anlegen"; ergebnis; }
ok "btrfs-Loop-Pool $GERAET"
mkdir -p "$FAHNAS_SHARES" "$FAHNAS_SNAPSHOTS"; chown root:fahnas-nutzer "$FAHNAS_SHARES"; chmod 0751 "$FAHNAS_SHARES"
pruefe "Samba-Grundkonfiguration + smbd" samba_vorbereiten
pruefe "Agent und Web starten" dienste_starten
pruefe "Ersteinrichtung" ersteinrichtung_durchfuehren

# --- (d) Chat-Speicher: beim Start angelegt, eigenes btrfs-Unterlaufwerk, root 0700 ----------------------------------------
warte_bis 10 test -d "$FAHNAS_CHAT/anhaenge"
bedingung "Chat-Speicher beim Start angelegt: root 0700" "$(stat -c '%U:%a' "$FAHNAS_CHAT" 2>/dev/null)" = "root:700"
bedingung "… als eigenes btrfs-Unterlaufwerk" "$(stat -c %i "$FAHNAS_CHAT" 2>/dev/null)" = "256"
bedingung "… raeume/ und anhaenge/ ebenso root 0700" "$(stat -c '%U:%a' "$FAHNAS_CHAT/raeume" "$FAHNAS_CHAT/anhaenge" 2>/dev/null | sort -u | tr '\n' ' ')" = "root:700 "

# --- Nutzer und Freigaben ------------------------------------------------------------------------------------------------
pruefe "Freigabe „$FREIGABE“ anlegen" freigabe_anlegen "$FREIGABE"
A="$(agent_aktion nutzer.anlegen "{\"name\":\"$ZWEITER\",\"anzeigename\":\"Zweiter Nutzer\",\"passwort\":\"$ADMIN_PW\",\"rolle\":\"nutzer\"}")"
enthaelt "Nutzer $ZWEITER angelegt" '"ok":true' "$A"
# Leserecht VOR dem Office-Dokument (die ACL der Freigabe vererbt sich nur auf neue Dateien)
A="$(agent_aktion freigaben.aendern "{\"name\":\"$FREIGABE\",\"lesen\":[\"$ZWEITER\"],\"schreiben\":[\"$ADMIN_NAME\"]}")"
enthaelt "$ZWEITER darf „$FREIGABE“ nur lesen" '"ok":true' "$A"
A="$(agent_aktion freigaben.anlegen "{\"name\":\"$TEAM\",\"beschreibung\":\"Integrationstest\",\"schreiben\":[\"$ADMIN_NAME\",\"$ZWEITER\"]}")"
enthaelt "Freigabe „$TEAM“ mit Schreibrecht für $ZWEITER" '"ok":true' "$A"
A="$(als_zweiter api_post /api/anmelden "{\"name\":\"$ZWEITER\",\"passwort\":\"$ADMIN_PW\"}")"
enthaelt "$ZWEITER angemeldet" '"ok":true' "$A"
UID_Z="$(id -u "$ZWEITER")"; GID_Z="$(id -g "$ZWEITER")"; GRUPPEN_Z="$(id -G "$ZWEITER" | tr ' ' ',')"
T="$FAHNAS_SHARES/$TEAM"
ALS_Z=(setpriv "--reuid=$UID_Z" "--regid=$GID_Z" "--groups=$GRUPPEN_Z" --inh-caps=-all --)   # wie der Agent den Nutzer wechselt
pruefe "Gegenprobe: $ZWEITER liest den Pool" "${ALS_Z[@]}" ls "$POOL"
enthaelt "$ZWEITER kommt nicht in den Chat-Speicher" 'Permission denied|Keine Berechtigung' "$("${ALS_Z[@]}" ls "$FAHNAS_CHAT" 2>&1)"

# --- (a) Texteditor ----------------------------------------------------------------------------------------------------------
A="$(als_zweiter agent_aktion dateien.text.speichern "{\"freigabe\":\"$TEAM\",\"pfad\":\"notiz.txt\",\"inhalt\":\"Erste Zeile\\n\",\"neu\":true}")"
enthaelt "Texteditor: $ZWEITER legt notiz.txt neu an" '"ok":true' "$A"
bedingung "… mit seiner uid ($UID_Z)" "$(stat -c %u "$T/notiz.txt" 2>/dev/null)" = "$UID_Z"
printf 'Erste Zeile\n' > "$IT/text1.txt"
pruefe "… Inhalt byte-genau" cmp "$IT/text1.txt" "$T/notiz.txt"
G1="$(json_feld "$A" ergebnis.geaendert)"; S1="$(json_feld "$A" ergebnis.groesse)"
bedingung "… Stand = Größe auf der Platte" "$S1" = "$(stat -c %s "$T/notiz.txt" 2>/dev/null)"
# veraltete Größe (Zeit stimmt) → E_GEAENDERT mit dem Stand der Platte, nichts geschrieben
S="$(als_zweiter agent_status dateien.text.speichern "{\"freigabe\":\"$TEAM\",\"pfad\":\"notiz.txt\",\"inhalt\":\"Zweite Fassung\\n\",\"erwartet\":{\"geaendert\":\"$G1\",\"groesse\":$((S1 + 3))}}" "$IT/a_groesse.json")"
bedingung "Veraltete Größe: HTTP 409" "$S" = "409"
A="$(cat "$IT/a_groesse.json")"
enthaelt "… E_GEAENDERT" '"code":"E_GEAENDERT"' "$A"
bedingung "… details: Stand der Platte (auch für Nutzer)" "$(json_feld "$A" fehler.details.groesse) $(json_feld "$A" fehler.details.geaendert)" = "$S1 $G1"
pruefe "… nichts geschrieben" cmp "$IT/text1.txt" "$T/notiz.txt"
# Änderung von außen (wie über SMB angehängt): der Stand des Editors ist veraltet
printf 'von außen angehängt\n' >> "$T/notiz.txt"; cp "$T/notiz.txt" "$IT/text2.txt"
S="$(als_zweiter agent_status dateien.text.speichern "{\"freigabe\":\"$TEAM\",\"pfad\":\"notiz.txt\",\"inhalt\":\"Zweite Fassung\\n\",\"erwartet\":{\"geaendert\":\"$G1\",\"groesse\":$S1}}" "$IT/a_aussen.json")"
bedingung "Nach Änderung von außen: HTTP 409" "$S" = "409"
A="$(cat "$IT/a_aussen.json")"
enthaelt "… E_GEAENDERT" '"code":"E_GEAENDERT"' "$A"
bedingung "… details.groesse = neue Größe" "$(json_feld "$A" fehler.details.groesse)" = "$(stat -c %s "$T/notiz.txt" 2>/dev/null)"
pruefe "… die Änderung von außen bleibt" cmp "$IT/text2.txt" "$T/notiz.txt"
bedingung "… keine Zwischendatei zurückgelassen" -z "$(find "$T" -maxdepth 1 -name '.fahnas-upload-*' 2>/dev/null)"
G2="$(json_feld "$A" fehler.details.geaendert)"; S2="$(json_feld "$A" fehler.details.groesse)"
A="$(als_zweiter agent_aktion dateien.text.speichern "{\"freigabe\":\"$TEAM\",\"pfad\":\"notiz.txt\",\"inhalt\":\"Zweite Fassung\\n\",\"erwartet\":{\"geaendert\":\"$G2\",\"groesse\":$S2}}")"
enthaelt "Mit aktuellem Stand gespeichert" '"ok":true' "$A"
bedingung "… gehört weiter $ZWEITER" "$(stat -c %u "$T/notiz.txt" 2>/dev/null)" = "$UID_Z"
bedingung "… neuer Inhalt" "$(cat "$T/notiz.txt")" = "Zweite Fassung"

# --- (b) Chat-Anhang auf dem NAS speichern -----------------------------------------------------------------------------------
A="$(agent_aktion chat.raum.anlegen "{\"name\":\"Integrationstest\",\"mitglieder\":[\"$ZWEITER\"]}")"
enthaelt "Chat-Raum mit $ZWEITER angelegt" '"ok":true' "$A"
RAUM="$(json_feld "$A" ergebnis.raum)"
bedingung "raum.json im Chat-Speicher: root 0600" "$(stat -c '%U:%a' "$FAHNAS_CHAT/raeume/$RAUM/raum.json" 2>/dev/null)" = "root:600"
printf 'Anhang aus dem Chat %s\n' "$(date +%s%N)" > "$IT/anhang.txt"
A="$(curl -sk -b "$KEKSE" -c "$KEKSE" -H 'Content-Type: application/octet-stream' --data-binary "@$IT/anhang.txt" "$BASIS/api/chat/hochladen?raum=$RAUM&name=anhang.txt")"
enthaelt "Anhang hochgeladen ($ADMIN_NAME)" '"ok":true' "$A"
AID="$(json_feld "$A" ergebnis.anhang.id)"
bedingung "Anhang im Chat-Speicher: root 0600" "$(stat -c '%U:%a' "$FAHNAS_CHAT/anhaenge/$RAUM/$AID" 2>/dev/null)" = "root:600"
A="$(agent_aktion chat.senden "{\"raum\":\"$RAUM\",\"text\":\"Hier die Datei\",\"anhaenge\":[\"$AID\"]}")"
enthaelt "Nachricht mit Anhang gesendet" '"ok":true' "$A"
A="$(als_zweiter agent_aktion chat.anhang.speichern "{\"raum\":\"$RAUM\",\"anhang\":\"$AID\",\"freigabe\":\"$TEAM\",\"ordner\":\"\"}")"
enthaelt "$ZWEITER speichert den Anhang in „$TEAM“" '"ok":true' "$A"
bedingung "… als anhang.txt" "$(json_feld "$A" ergebnis.pfad)" = "anhang.txt"
bedingung "… Datei gehört $ZWEITER (uid $UID_Z), nicht root" "$(stat -c %u "$T/anhang.txt" 2>/dev/null)" = "$UID_Z"
pruefe "… Inhalt gleich" cmp "$IT/anhang.txt" "$T/anhang.txt"
A="$(als_zweiter agent_aktion chat.anhang.speichern "{\"raum\":\"$RAUM\",\"anhang\":\"$AID\",\"freigabe\":\"$TEAM\",\"ordner\":\"\"}")"
bedingung "Noch einmal: freier Name „anhang (1).txt“" "$(json_feld "$A" ergebnis.name)" = "anhang (1).txt"
S="$(als_zweiter agent_status chat.anhang.speichern "{\"raum\":\"$RAUM\",\"anhang\":\"$AID\",\"freigabe\":\"$FREIGABE\",\"ordner\":\"\"}" "$IT/b_rechte.json")"
bedingung "Freigabe ohne Schreibrecht: HTTP 403" "$S" = "403"
enthaelt "… E_RECHTE" '"code":"E_RECHTE"' "$(cat "$IT/b_rechte.json")"
bedingung "… keine Datei in „$FREIGABE“" ! -e "$FAHNAS_SHARES/$FREIGABE/anhang.txt"

# --- (c) Office über eine Office-Freigabe ------------------------------------------------------------------------------------
A="$(agent_aktion office.anlegen "{\"art\":\"dokument\",\"freigabe\":\"$FREIGABE\",\"ordner\":\"\",\"name\":\"Protokoll\"}")"
enthaelt "Office-Dokument als $ADMIN_NAME angelegt" '"ok":true' "$A"
DOK="$(json_feld "$A" ergebnis.id)"; BUENDEL="$FAHNAS_SHARES/$FREIGABE/$(json_feld "$A" ergebnis.pfad)"
bedingung "Bündel gehört $ADMIN_NAME" "$(stat -c %U "$BUENDEL/inhalt.json" 2>/dev/null)" = "$ADMIN_NAME"
# WebSocket-Klient wie der Browser (wss, gleiche Herkunft, Sitzungs-Keks): öffnen, eine Op senden, auf „gespeichert“ warten
cat > "$IT/office_ws.mjs" <<'JS'
import https from 'node:https';
import crypto from 'node:crypto';

const [port, keks, dok, opText, wurzel] = process.argv.slice(2);
const { maskiert, serverRahmenLesen } = await import(`${wurzel}/tests/einheit/ws_hilfen.js`);
const aus = { recht: null, version: null, antwort: null, fehler: null, gespeichert: false, version_nachher: null };
const fertig = (code) => { process.stdout.write(`${JSON.stringify(aus)}\n`); process.exit(code); };
setTimeout(() => { aus.fehler ??= 'zeit'; fertig(1); }, 45_000);

function verbinden() {
  return new Promise((ok, nein) => {
    const req = https.request({
      host: '127.0.0.1', port: Number(port), path: '/api/office/ws', rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: `https://127.0.0.1:${port}`, Cookie: keks,
      },
    });
    req.on('response', (res) => { res.resume(); nein(new Error(`kein Upgrade (HTTP ${res.statusCode})`)); });
    req.on('error', nein);
    req.on('upgrade', (_res, socket, kopf) => {
      const eingang = []; const wartende = [];
      let puffer = Buffer.alloc(0);
      const zustellen = (o) => { const i = wartende.findIndex((w) => w.pruef(o)); if (i >= 0) wartende.splice(i, 1)[0].ok(o); else eingang.push(o); };
      const lesen = (d) => {
        puffer = Buffer.concat([puffer, d]);
        const r = serverRahmenLesen(puffer); puffer = Buffer.from(r.rest);
        for (const f of r.rahmen) {
          if (f.opcode === 1) zustellen(JSON.parse(f.daten.toString('utf8')));
          else if (f.opcode === 9) socket.write(maskiert(f.daten, 0xa));
        }
      };
      socket.on('data', lesen);
      socket.on('error', () => {});
      if (kopf && kopf.length) lesen(kopf);
      ok({
        senden: (o) => socket.write(maskiert(Buffer.from(JSON.stringify(o)))),
        warte: (pruef, ms) => new Promise((r, n) => {
          const i = eingang.findIndex(pruef);
          if (i >= 0) { r(eingang.splice(i, 1)[0]); return; }
          const w = { pruef, ok: (o) => { clearTimeout(t); r(o); } };
          const t = setTimeout(() => { wartende.splice(wartende.indexOf(w), 1); n(new Error('keine Antwort')); }, ms);
          wartende.push(w);
        }),
        schliessen: () => { try { socket.end(maskiert(Buffer.from([0x03, 0xe8]), 8)); } catch { /* egal */ } },
      });
    });
    req.end();
  });
}

let ws = null;
try {
  ws = await verbinden();
  ws.senden({ art: 'oeffnen', anfrage: 'it-1', ref: { id: dok } });
  const g = await ws.warte((o) => o.anfrage === 'it-1', 15_000);
  if (g.art !== 'geoeffnet') { aus.antwort = g.art; aus.fehler = g.fehler?.code ?? null; } else {
    aus.recht = g.dok.recht; aus.version = g.dok.version;
    const cid = `it-${crypto.randomBytes(6).toString('hex')}`;
    ws.senden({ art: 'op', dok, basis: g.dok.version, cid, op: JSON.parse(opText) });
    const a = await ws.warte((o) => o.cid === cid || o.art === 'neu_laden', 15_000);
    aus.antwort = a.art; aus.fehler = a.fehler?.code ?? null;
    if (a.art === 'op') {
      const s = await ws.warte((o) => o.art === 'gespeichert' || o.art === 'speicherfehler', 20_000);
      aus.gespeichert = s.art === 'gespeichert'; aus.version_nachher = s.version ?? null;
      if (!aus.gespeichert) aus.fehler = s.fehler?.code ?? 'speicherfehler';
    }
    ws.senden({ art: 'schliessen', dok });
  }
} catch (e) { aus.fehler ??= String((e && e.message) || e); }
ws?.schliessen();
fertig(0);
JS
office_op() { node "$IT/office_ws.mjs" "$PORT_WEB" "$(keks_kopf "$KEKSE_ZWEITER")" "$DOK" "$1" "$WURZEL"; }   # office_op '<op>'
W="$(office_op '{"d":[{"insert":"Nur gelesen"}]}')"
enthaelt "$ZWEITER öffnet das Dokument über die Freigabe nur lesend" '"recht":"lesen"' "$W"
enthaelt "… seine Änderung wird mit E_RECHTE abgelehnt" '"antwort":"fehler","fehler":"E_RECHTE"' "$W"
A="$(agent_aktion office.freigeben "{\"id\":\"$DOK\",\"nutzer\":\"$ZWEITER\",\"recht\":\"bearbeiten\"}")"
enthaelt "Office-Freigabe „bearbeiten“ für $ZWEITER" '"ok":true' "$A"
W="$(office_op '{"d":[{"insert":"Hallo vom zweiten Nutzer"}]}')"
enthaelt "$ZWEITER darf jetzt bearbeiten (Office-Freigabe)" '"recht":"bearbeiten"' "$W"
enthaelt "… Änderung angenommen und gespeichert (Version 1)" '"antwort":"op",.*"gespeichert":true,"version_nachher":1[^0-9]' "$W"
bedingung "inhalt.json gehört weiter $ADMIN_NAME" "$(stat -c %U "$BUENDEL/inhalt.json" 2>/dev/null)" = "$ADMIN_NAME"
bedingung "verlauf.ndjson gehört $ADMIN_NAME" "$(stat -c %U "$BUENDEL/verlauf.ndjson" 2>/dev/null)" = "$ADMIN_NAME"
bedingung "Bündelordner gehört $ADMIN_NAME" "$(stat -c %U "$BUENDEL" 2>/dev/null)" = "$ADMIN_NAME"
A="$(cat "$BUENDEL/inhalt.json" 2>/dev/null)"
bedingung "inhalt.json: Version 1, Besitzer $ADMIN_NAME" "$(json_feld "$A" version) $(json_feld "$A" besitzer)" = "1 $ADMIN_NAME"
enthaelt "… mit dem Text des zweiten Nutzers" 'Hallo vom zweiten Nutzer' "$A"
bedingung "… keine Zwischendatei im Bündel" -z "$(find "$BUENDEL" -name '.fahnas-upload-*' 2>/dev/null)"

# --- Prüfprotokoll: nur Kennungen und Pfade (V1) -----------------------------------------------------------------------------
PROTO="$(cat "$FAHNAS_CONFIG"/protokoll/audit-*.jsonl 2>/dev/null)"
enthaelt "Prüfprotokoll führt dateien.text.speichern (nur freigabe, pfad, neu)" '"aktion":"dateien\.text\.speichern","params":\{"freigabe":"team","pfad":"notiz\.txt","neu":' "$PROTO"
enthaelt "Prüfprotokoll führt chat.anhang.speichern" '"aktion":"chat\.anhang\.speichern"' "$PROTO"
if printf '%s' "$PROTO" | grep -Eq 'Erste Zeile|Zweite Fassung|Hier die Datei|Hallo vom zweiten Nutzer|Anhang aus dem Chat'; then
    schlecht "Prüfprotokoll enthält Inhalte"; printf '%s' "$PROTO" | grep -E 'Erste Zeile|Zweite Fassung|Hier die Datei|Hallo vom zweiten Nutzer|Anhang aus dem Chat' | head -3
else
    ok "Prüfprotokoll ohne Inhalte (Text, Nachricht, Anhang, Dokument)"
fi

ergebnis
