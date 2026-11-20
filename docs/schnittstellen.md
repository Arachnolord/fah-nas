# FAH-NAS – Schnittstellen (verbindlich für alle Teile)

Gilt zusammen mit `docs/superpowers/specs/2026-09-25-fahnas-kern-design.md`. Wer ein Teil baut, hält sich an diese
Verträge; Abweichungen werden hier eingetragen, nicht still eingebaut.

## 0. Konventionen

- Node 22, ES-Module (`"type": "module"`), keine npm-Abhängigkeiten. Nur `node:`-Module.
- Deutsch in Bezeichnern der Fachlichkeit (`freigabe`, `nutzer`, `schnappschuss`), Englisch nur für Technik-Begriffe
  ohne gute Übersetzung (`socket`, `token`, `hash`). Kommentare Deutsch. Nutzer wird geduzt.
- Jede Quelldatei beginnt mit dem Kopf:
  ```
  // ============================================================================
  // Erdacht und programmiert von Fabian Hammer, Deutschland.
  // (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
  // ============================================================================
  ```
  (Shell: `#`-Variante, HTML: `<!-- -->`, CSS: `/* */`.)
- Kein `exec`/`execSync`/`sh -c`. Nur `spawn`/`execFile` mit Argumentliste.
- Fehler sind `FahnasFehler(code, meldung, details?)` aus `src/gemeinsam/fehler.js`. Codes siehe §6.
- Zeiten ISO-8601 UTC (`new Date().toISOString()`), Anzeige lokal im Browser.
- Tests: `node --test tests/einheit/` (macOS-lauffähig, keine Linux-Befehle nötig; Systemaufrufe werden über
  `src/gemeinsam/system.js` gekapselt und im Test ersetzt).

## 1. Pfade auf dem Zielsystem

| Zweck | Pfad |
|---|---|
| Programm | `/opt/fahnas/` (Release-Archiv entpackt; `src/`, `public/`, `tools/`, `BUILD_VERSION`) |
| Konfiguration | `/data/config/` (siehe Entwurf §5.2) |
| Steuersocket | `/run/fahnas/agent.sock` (0660 root:fahnas) |
| Datenkanal | `/run/fahnas/daten.sock` (0660 root:fahnas) |
| Startcode | `/etc/fahnas/startcode` (0600 root) |
| Samba-Includes | `/etc/samba/fahnas/<freigabe>.conf`, eingebunden über `include = /etc/samba/fahnas/alle.conf` |
| Freigaben | `/data/shares/<name>` (btrfs-Unterlaufwerk), Papierkorb `/data/shares/<name>/.papierkorb` |
| Schnappschüsse Freigabe | `/data/.snapshots/<name>/<zeitstempel>` (nur lesbar) |
| Schnappschüsse System | `/.snapshots/<nr>/snapshot` (snapper) |
| Protokolle | `/data/config/protokoll/` |
| Vorschaubilder | `/data/vorschau/` (root 0700; Zwischenspeicher des Dateimanagers, kein Export; `FAHNAS_VORSCHAU`) |
| Web-Zustand | `/data/config/web/` (`tls/`, `sitzungen.json`, `bremse.json`) |

Umgebungsvariablen (für Tests/Entwicklung überschreibbar): `FAHNAS_CONFIG` (Standard `/data/config`),
`FAHNAS_RUN` (`/run/fahnas`), `FAHNAS_SHARES` (`/data/shares`), `FAHNAS_SNAPSHOTS` (`/data/.snapshots`),
`FAHNAS_SAMBA` (`/etc/samba/fahnas`), `FAHNAS_WEB_PORT` (8443 seit 0.6.17, vorher 443), `FAHNAS_HTTP_PORT` (leer = keine Umleitung; seit 0.6.17 – 80/443 gehören FAH-Proxy, damit Haus und VPN die Domains direkt erreichen), `FAHNAS_OHNE_TLS=1` (Entwicklung).
Zentral gelesen in `src/gemeinsam/pfade.js`.

## 2. Steuerprotokoll Web ⇄ Agent (NDJSON über Unix-Socket)

Anfrage (eine Zeile JSON):
```json
{"id":"a1b2","aktion":"freigaben.anlegen","params":{"name":"medien"},"kontext":{"nutzer":"fabian","rolle":"admin","ip":"192.168.1.5"}}
```
Antwort:
```json
{"id":"a1b2","ok":true,"ergebnis":{...}}
{"id":"a1b2","ok":false,"fehler":{"code":"E_PARAMS","meldung":"Name darf nur a-z, 0-9, - und _ enthalten","details":{"feld":"name"}}}
```
Aufgaben (lang laufend): Sofortantwort `{"id":"…","ok":true,"aufgabe":"t-…"}`; danach schickt der Agent auf
DERSELBEN Verbindung Ereigniszeilen ohne `id`:
`{"ereignis":"aufgabe","aufgabe":"t-…","status":"laeuft|fertig|fehler|abgebrochen","fortschritt":0.42,"meldung":"…","ergebnis":{…}}`
Außerdem allgemeine Ereignisse `{"ereignis":"konfig","bereich":"freigaben"}` (etwas hat sich geändert) und
`{"ereignis":"system","art":"platte_voll","daten":{…}}`. Der Web-Dienst hält EINE dauerhafte Verbindung, multiplext
über `id`, verbindet bei Abbruch neu (Rückfall 1 s → 30 s).

Der `kontext` kommt IMMER vom Web-Dienst (aus der Sitzung), niemals vom Browser. Der Agent prüft `rolle` gegen die
Mindestrolle der Aktion. Aktionen mit `rolle: "system"` darf nur der Agent selbst (Timer, apply) aufrufen.

Präzisierungen 25.09. (Prüfbericht R1, Agent-Seite, FX1a):
- **Nachrichtengrenze** `MAX_ZEILE` = 64 MB je Zeile (vorher 4 MB). Passt ein Ergebnis nicht in eine Zeile, antwortet der Agent
  nur auf DIESE Anfrage mit `E_SYSTEM` „Ergebnis zu groß – bitte die Anfrage einschränken“ (`details.zeichen`, `details.max`); die
  Verbindung bleibt für alle anderen Anfragen bestehen. Zu große Ereignisse werden nicht gesendet (stderr).
- **Fehlerdetails je Rolle**: `fehler.details` gehen vollständig nur an `admin`/`system` (und die Konsole). An `nutzer`/`gast`
  bleiben nur `feld, warte_s, verbleibend, noetig, frei, prozent, aktion, freigabe, wert, stufe, name, dateiname`; `befehl`,
  `ausgabe`, `pfad`, `grund`, `code` u. ä. werden zentral beim Senden entfernt – auch in `aufgabe`-Ereignissen (Rolle des
  Auftraggebers, Feld `rolle` im Aufgabenobjekt). Der Web-Dienst filtert zusätzlich nach seiner Liste (§5).
- **Aufgaben-Zustandsdatei** `aufgaben.json` in der Konfiguration (Ansicht der Liste, 0640; nicht im Export). Beim Start des
  Agenten werden dort noch offene Aufgaben (`wartet`/`laeuft`) als `abgebrochen` übernommen (`fehler.code = E_ABGEBROCHEN`,
  `meldung` „Der Steuerdienst wurde neu gestartet …“) und als `aufgabe`-Ereignis gemeldet; `agent.aufgaben` zeigt sie.
- `agent.aufgaben` nutzer `{seite?:1, je_seite?:200 (max 500)}` → Liste (eigene; admin alle), neueste zuerst. Aufgabenobjekte tragen
  zusätzlich `rolle` (Rolle des Auftraggebers).
- Kennungen (`r-…`, `t-…`, Tickets `k-…`) kommen aus `crypto.randomBytes`, nie aus `Math.random`.
- Der Agent-Prozess fängt `uncaughtException`/`unhandledRejection` ab (Protokoll auf stderr) – ein einzelner Kanalfehler beendet
  den Dienst nicht mehr.

## 3. Datenkanal (Rohdaten, Unix-Socket `daten.sock`)

Für Herunter-/Hochladen: 1. Web fragt per Steuerprotokoll `dateien.ticket` (`{freigabe, pfad, art:"lesen"|"schreiben"|"zip", groesse?}`)
→ Ergebnis `{ticket, dateiname, groesse?, mime}`. 2. Web öffnet `daten.sock`, sendet EINE Zeile `{"ticket":"…","nutzer":"…"}` –
`nutzer` ist Pflicht (seit 25.09., Prüfbericht R1 Fund 3): der Sitzungsnutzer, bei `GET /link/<token>` der Link-Ersteller aus dem
Feld `nutzer` des Ergebnisses von `dateien.link.pruefen`. 3. Agent prüft Ticket (einmalig, 60 s gültig, an Nutzer gebunden: `nutzer`
im Kopf muss dem Nutzer des Tickets entsprechen, sonst Fehlerzeile `E_TICKET`, das Ticket bleibt dabei unverbraucht) und startet als der Nutzer (`uid/gid`):
`lesen` → `cat <pfad>` mit stdout=Socket; `zip` → `zip -r -q - .` in `<pfad>` mit stdout=Socket;
`schreiben` → `dd of=<pfad> status=none` mit stdin=Socket (Kontingent vorher geprüft). Socket-Ende = Ende der Übertragung.
Seit 0.3.4 (Namenskonflikte): Bei Datei-Uploads ist `<pfad>` eine versteckte Zwischendatei `.fahnas-upload-<16 hex>` im Zielordner
(nie in `dateien.liste`, nach 24 h unberührt weggeräumt). Kam genau die angekündigte `groesse` an und endete dd mit 0, ruft der
Datenkanal den `abschluss(true)` des Tickets auf (Helfer `upload_abschliessen` als Nutzer: ablegen je `bei_vorhanden`), sonst
`abschluss(false)` (`upload_verwerfen`: nur die Zwischendatei weg – das Ziel bleibt unberührt). Ein vorzeitiges EOF (Hochlader brach
ab) zählt als unvollständig → Fehlerzeile `E_ABGEBROCHEN`. Die Erfolgszeile trägt dann `{ok:true, ergebnis:{pfad, name, ersetzt,
umbenannt, papierkorb}}` mit dem tatsächlichen Namen.
Fehler vor dem Start: Agent schreibt EINE JSON-Zeile `{"fehler":{…}}`, schließt seine Schreibseite und verwirft den Rest der Sendung
(der Hochlader bleibt nie auf „drain“ hängen). Endet `dd` beim `schreiben` vorzeitig (Zielordner weg, kein Platz, Kontingent), kommt
statt eines Abbruchs die Fehlerzeile `E_PLATZ` (bei „No space left“/„Disk quota exceeded“) bzw. `E_SYSTEM` mit `details.ausgabe`.

## 4. Aktionsregister (Agent)

Registrierung in `src/agent/aktionen/<bereich>.js`: `export function registriere(reg)`; darin
`reg.aktion("bereich.name", { rolle: "admin"|"nutzer"|"system", schema: {…}, aufgabe?: true, ausfuehren: async (params, kontext, werkzeuge) => ergebnis })`.
`schema` ist ein Objekt `{ feld: { typ: "string"|"number"|"boolean"|"array"|"object", pflicht?: true, muster?: RegExp,
min?, max?, werte?: [...], elemente?: {…} } }` – geprüft von `src/gemeinsam/schema.js` VOR `ausfuehren`.
`werkzeuge` = `{ konfig, system, audit, aufgaben, ereignis(name, daten), render }`.
Bei `aufgabe: true` bekommt `ausfuehren` zusätzlich `aufgabe` mit `aufgabe.fortschritt(anteil, meldung)` und
`aufgabe.abgebrochen()` und läuft in der Warteschlange.

### Aktionen des Kerns (Bereich → Aktion → Mindestrolle → Parameter → Ergebnis)

**system**
- `system.status` nutzer `{}` → `{version, hostname, laufzeit_s, kernel, dienste:{samba,docker,libvirt,avahi,ssh}: "aktiv"|"inaktiv"|"fehler", platten:[{pfad, gesamt, frei, label}], datenpartition_prozent}`
- `system.lesen` admin `{}` → `system.json`
- `system.setzen` admin `{aenderungen:{hostname?, zeitzone?, sprache?, design?, netz?, energie?, aufbewahrung?}}` → `system.json`; rendert Hostname/netplan/Timer.
  `netz` (präzisiert 25.09., R3 Fund 2): mit `modus` ersetzt es den Bestand KOMPLETT – `"dhcp"` leert Adresse und Gateway und behält nur, was
  mitgeschickt wird (`schnittstelle?`, `dns?`; sonst `null`/`[]`); `"statisch"` verlangt `schnittstelle` und `adresse` (`E_PARAMS` mit
  `details.feld`, kein stilles Auffüllen aus dem Bestand). Ohne `modus` ist es eine Teiländerung über dem Bestand. Wird unter der Sperre
  von `system.json` gerendert und geschrieben (Renderfehler → nichts gespeichert).
- `system.setzen` … `ssh_port:integer` (seit 0.30.0, Standard 22): 22 oder 1024–65535, nicht 80/443/445/5353/8443 (`pruefeSshPort`). `render/sshport.js` schreibt `Port` nach `/etc/ssh/sshd_config.d/fahnas-port.conf` und `ListenStream` nach `/etc/systemd/system/ssh.socket.d/fahnas-port.conf` (Ubuntu startet sshd über ssh.socket), dann `sshd -t`, `daemon-reload`, Neustart von ssh.socket; bei Fehlern zurück auf den alten Stand. Offene Sitzungen bleiben. Die Firewall-Übersicht nennt den Port.
- Admins sind root (seit 0.30.0, Betreiber 11.11.2026, `render/adminroot.js`, Schritt `admin_root` in `system.apply`): `/etc/sudoers.d/fahnas-admin` (`%fahnas-admin` ohne Passwort, vorher `visudo -cf`), `/etc/ssh/sshd_config.d/fahnas-admin.conf` (`Match Group fahnas-admin` → `ForceCommand /usr/local/lib/fahnas/admin-als-root`). Der Wrapper startet Shell (`sudo -i`), Befehle (`sudo -H bash -c`) und SFTP (`sudo sftp-server -u 0002`) als root; geht `sudo -n` nicht, läuft alles als der Nutzer. Normale Konten bleiben in der SFTP-Ansicht (`fahnas-sftp.conf`). Kein Schalter im Client: die Rolle beim Login entscheidet.
- `system.setzen` … `docker_freigabe:boolean` (seit 0.6.16, Standard `false`): Samba-System-Freigabe `docker` = `/data/apps`
  (`valid users = @fahnas-admin`, `force user = root`, `inherit owner/permissions = yes`); gerendert von `render/samba.js`
  (`dockerFreigabeText`, liest system.json), nach dem Speichern per `freigaben.apply` – scheitert das, wird der Schalter
  zurückgedreht. Der Name `docker` ist für eigene Freigaben reserviert. `/var/lib/docker` wird bewusst NICHT freigegeben.
- `system.dienst` admin `{dienst:"ssh"|"samba"|"docker"|"libvirt"|"avahi", zustand:"an"|"aus"|"neustart"}` → `{dienst, zustand:"aktiv"|"inaktiv"|"fehler", angefordert:"an"|"aus"|"neustart", unit}`
  (präzisiert 25.09., R3 Fund 11: `zustand` ist der ECHTE Zustand nach der Aktion aus `systemctl is-active`, der Wunsch steht in `angefordert`)
- `system.updates.pruefen` admin `{}` (aufgabe) → `{anzahl, pakete:[{name, alt, neu}], sicherheit}`
- `system.updates.einspielen` admin `{}` (aufgabe) → `{eingespielt, neustart_noetig, schnappschuss_vor, schnappschuss_nach}`
- `system.smart` admin `{}` → `[{geraet, modell, temperatur, zustand:"ok"|"warnung"|"fehler"|"unbekannt", stunden, details}]`
  (seit 0.6.15: keine S.M.A.R.T.-Werte – USB-Adapter ohne SAT, virtuelle Platte – ist `unbekannt` (grau „keine Werte“), keine Warnung;
  `details.smartctl` trägt die Meldung von smartctl; gilt ebenso für `laufwerke.smart`)
- `system.neustart` admin `{}`; `system.herunterfahren` admin `{}`
- `system.protokoll` admin `{von?, bis?, nutzer?, aktion?, seite?, je_seite?}` → `{eintraege:[…], gesamt}`
- `system.export` admin `{mit_geheimnissen:boolean, passwort?}` → `dateien.ticket`-artiges `{ticket, dateiname}` (Datenkanal lesen)
- `system.import` admin `{ticket}` (aufgabe; Archiv vorher per Datenkanal `schreiben` nach `/data/config/eingang/`) → `{unterschiede, angewendet}`.
  Ein `ticket` aus `system.import.ticket` gilt nur für den Admin, der es angelegt hat (sonst `E_RECHTE`, 25.09. R1 Fund 3). Das Archiv
  wird vor dem Entpacken geprüft (`tar -tvf`/`-tf`): Symlinks, Hardlinks, Gerätedateien, `..`-Bestandteile und absolute Namen →
  `E_PARAMS` „Das Archiv enthält Verknüpfungen oder unerlaubte Pfade“ (`details.gruende`); entpackt wird mit `--no-same-owner
  --no-same-permissions` (GNU tar zusätzlich `--no-overwrite-dir`), danach nochmals per `lstat` geprüft; `apps/`, `vms/` werden nur mit
  regulären Dateien/Ordnern übernommen. Übernommene Dateien tragen die Rechte der MODUS-Tabelle (§7).
- `system.apply` system `{}` → `{gerendert:[…]}`
- `system.programm.ticket` admin `{dateiname:"*.tar.gz|*.tgz", groesse≤200 MiB}` → `{ticket, kennung}` (Datenkanal `schreiben` nach
  `/data/config/eingang/<kennung>.tar.gz`; Kennung gilt nur für den hochladenden Admin, sonst `E_RECHTE`) – seit 0.6.14.
- `system.programm.pruefen` admin `{kennung}` → `{kennung, dateiname, groesse, version_neu, version_alt, vergleich:"neuer"|"gleich"|"aelter"}`
  (`tar -tzf`: `src/agent/agent.js` + `BUILD_VERSION` im Wurzelordner, sonst `E_PARAMS` „kein FAH-NAS-Release“).
- `system.programm.einspielen` admin `{kennung}` → `{gestartet:true, von, nach}`; schreibt `<archiv>.sha256`, `programm-update.json`
  und leert `programm-update.log` (beide in `/data/config`), startet `fahnas update <archiv>` als transiente Unit
  `fahnas-programm-update` (`systemd-run --collect`, Ausgabe `truncate:` ins Log, letzte Zeile `FAHNAS_ENDE <rc>`, Archiv danach weg) –
  ein Kindprozess des Agenten stürbe beim Neustart mit (`KillMode=mixed`). `E_BELEGT`, solange die Unit läuft oder Aufgaben laufen/warten.
- `system.programm.status` admin `{}` (lesend) → `{zustand:"keins"|"laeuft"|"erfolg"|"fehler"|"abgebrochen", version, von?, nach?, nutzer?,
  gestartet?, ausgabe?:[letzte 60 Zeilen]}`; die Oberfläche (Karte „FAH-NAS aktualisieren“) fragt alle 2 s, Fehler während des
  Neustarts zählen nicht, bei `erfolg` lädt sie die Seite neu.
- `system.ersteinrichtung.status` (ohne Anmeldung, Web ruft mit kontext.rolle="gast") → `{noetig:boolean}`
- `system.ersteinrichtung` gast `{startcode, admin:{name, passwort, anzeigename}}` → `{ok}`; legt ersten Admin an, löscht Startcode.
  Präzisiert 25.09. (R1 Fund 7, R2 Fund 14): `E_EXISTIERT` aus `nutzer.anlegen` (Systemkonto uid < 1000, Gruppenname) wird DURCHGEREICHT –
  der Rückfall „Passwort direkt setzen“ greift nur, wenn der Bereich `nutzer` fehlt, und lehnt dann ebenfalls Systemkonten (uid < 1000)
  und reservierte Namen ab. Nach Erfolg ruft der Agent `<programm>/tools/fahnas issue` (Konsolenanzeige ohne Startcode; Fehler egal).

**nutzer**
- `nutzer.liste` admin → `[{name, anzeigename, rolle, uid, gruppen, totp:boolean, gesperrt, erstellt, letzte_anmeldung}]` (ohne Hashes)
- `nutzer.anlegen` admin `{name:MUSTER_NUTZERNAME (2–31 Zeichen a-z0-9_- plus einzelne Punkte, z. B. m.mustermann), anzeigename, passwort(min 8), rolle, gruppen?}` → Eintrag; Linux `useradd -M -s /usr/sbin/nologin -G fahnas-nutzer`, `chpasswd`, `smbpasswd -a -s`
- `nutzer.aendern` admin `{name, anzeigename?, rolle?, gruppen?, gesperrt?}`
- `nutzer.passwort` nutzer (eigenes) / admin (alle) `{name, passwort, altes_passwort?(Pflicht bei eigenem ohne admin)}`
- `nutzer.loeschen` admin `{name, dateien:"behalten"|"loeschen"}` (letzter Admin nicht löschbar)
- `nutzer.umbenennen` admin `{name, neu}` (0.25.2) → öffentlicher Eintrag + `alt`. Prüft wie `anlegen` (reserviert, Nutzer/Gruppe/
  Freigabe/persönlicher Ordner gleichen Namens). Linux `usermod -l` (+ eigene Gruppe `groupmod -n`, echtes /home/<alt> mit `-m`),
  Samba: NT-Hash per `pdbedit -L -w` übernehmen (`smbpasswd -x alt` vor usermod, danach `pdbedit -a -t` + `--set-nt-hash`,
  Sperre `D` bleibt) – Passwort gilt weiter. `<daten>/homes/<alt>` wird umbenannt (Bind-Mount: lösen, heim.apply bindet neu;
  heim.apply läuft dazu exklusiv). Danach: shares.json (lesen/schreiben/ordnerrechte), protokolle.json (NFS als_nutzer),
  apps sichtbar_fuer, links.json, office.json (besitzer/freigaben/zuletzt), Chat (Mitglieder, Verwalter, Ersteller, Einladungen,
  Verlauf von/wer, Anhang-Meta; offene DMs ziehen an dmId(neu, partner, folge) um, Stumm-Listen folgen), Avatar,
  Handlungsbedarf-Quittungen. users.json `umbenennungen:[{alt,neu,zeit}]` übersetzt Office-Inhalte (wer/ersteller/zustaendig/
  besitzer) beim Laden (office.laden, fällige Karten); `nutzer.anlegen` mit einem alten Namen löscht dessen Eintrag. Web-Dienst:
  alle Sitzungen des alten Namens enden (Grund `umbenannt`, TURN gesperrt), Abmelde-Zeit und Hintergrundbilder ziehen mit.
- `nutzer.pruefen` system `{name, passwort}` → `{ok, rolle, totp_noetig}` (Web-Login; scrypt-Vergleich zeitkonstant)
- `nutzer.totp.einrichten` nutzer `{name, passwort}` → `{geheimnis, uri}` – **`passwort` = Passwort des Handelnden (`kontext.nutzer`), Pflicht
  seit 25.09. (R1 Fund 10; fehlend → `E_PARAMS` feld `passwort`, falsch → `E_ANMELDUNG`)**: auch bei schon aktiver 2FA kann eine gestohlene
  Sitzung Geheimnis und Wiederherstellungscodes nicht tauschen. `nutzer.totp.bestaetigen` `{name, code}` → `{wiederherstellungscodes}`;
  `nutzer.totp.entfernen` `{name, passwort?}` – Passwort des Handelnden, Pflicht außer für Rolle `system` und die Kennung `konsole`
  (Kommandozeile als root, Notfallweg `fahnas totp-entfernen`, R1 Fund 13); `nutzer.totp.pruefen` system `{name, code}` → `{ok}`.
  Alle Lesen-Ändern-Schreiben-Pfade von `users.json` laufen unter der Sperre der Datei (`konfig.aendern`), auch `letzte_anmeldung`
  in `nutzer.pruefen` (R1 Fund 5).
- `nutzer.gruppen` admin `{}` → `[{name, mitglieder}]`; `nutzer.gruppe.anlegen`/`loeschen` admin `{name}`

**freigaben**
- `freigaben.liste` nutzer → alle sichtbaren `[{name, beschreibung, pfad, gaeste, lesen, schreiben, papierkorb, timemachine, groesse_gb, belegt, versteckt, schnappschuesse, speicherort}]`.
  `belegt` (präzisiert 25.09., R1 Fund 9): aus dem Kontingent (qgroup), wenn Quoten aktiv sind; sonst aus einem Zwischenspeicher (5 min) oder
  **`null`** („noch nicht ermittelt“ – Oberfläche zeigt „–“). Die Liste wartet nie auf `du`; der Agent ermittelt die Belegung im Hintergrund
  (`nice -n 19 ionice -c 3 du -s -B1`, Zeitlimit 10 min, je Freigabe höchstens ein Lauf) und meldet danach `{ereignis:"konfig", bereich:"freigaben"}`.
  ACL jeder Freigabe enthält zusätzlich `group:fahnas-admin:rwx` (+ default), damit Admins im Dateimanager (Helfer mit Admin-uid) überall dürfen.
  `speicherort` (seit 0.21.0, Zusatzauftrag Z1 – Betreiber 18.10.2026: „wo sehe ich, wo neue Freigaben erstellt wurden (auf welcher
  Festplatte)“): `{art, geraet, platte, modell}`, unbekannte Werte `null` – nie ein Listenfehler. `art`: `datenplatte` | `verschluesselt`
  (die verschlüsselten Daten liegen ebenfalls auf der Datenplatte) – beide mit Gerät (`/dev/sda4`), Platte (`/dev/sda`) und Modell der Platte
  unter `PFADE.shares`: `findmnt -rn -o SOURCE -T <PFADE.shares>` (btrfs-Zusatz `[/@shares]` entfällt) und `lsblk` mit derselben Auswertung
  wie `laufwerke.liste`; das Ergebnis gilt 10 min (auch ein Fehlschlag, gleichzeitige Listen teilen den Lauf). `extern`: zusätzlich `label`,
  `label`/`modell` aus `laufwerke.json` (wie die Laufwerke-Ansicht das Laufwerk zeigt, ohne Prozess), `geraet`/`platte` `null`. `verbund`:
  zusätzlich `stufe` und `platten:[{name, modell}]` aus `raid.json`, `geraet` = `/dev/md/fahnas-<name>`. Oberfläche: Zeile „Speicherort:
  Datenplatte (Samsung SSD 840) · /data/shares/<name>“ (ohne Modell ohne Klammer, Gerät als Tooltip; extern „Externes Laufwerk „<label>“
  (<modell>)“, Verbund „Speicherverbund RAID1 aus 2 Platten (<modelle>)“); die automatische Beschreibung „Externes Laufwerk (…)“ bzw.
  „Speicherverbund RAIDn“ entfällt daneben, eigene Beschreibungen bleiben.
- `freigaben.speicherort` admin `{}` (lesend, seit 0.21.0) → `{art:"datenplatte", geraet, platte, modell, pfad}` (`pfad` = `PFADE.shares`,
  derselbe Zwischenspeicher wie die Liste) – damit sagt der Dialog „Neue Freigabe“ vorher „Wird auf der Datenplatte (Samsung SSD 840) unter
  /data/shares/<Name> angelegt.“ (folgt dem getippten Namen; ohne Antwort kein Satz).
- `freigaben.anlegen` admin `{name:/^[a-z0-9][a-z0-9_-]{0,31}$/, beschreibung?, gaeste?, lesen?:[nutzer|@gruppe], schreiben?:[…], papierkorb?:true, timemachine?:false, groesse_gb?, versteckt?}` → Eintrag; `btrfs subvolume create`, Rechte 2770 root:fahnas-nutzer + ACL, Samba-Include, `testparm`, `smbcontrol all reload-config`
- `freigaben.aendern` admin `{name, …}`; `freigaben.loeschen` admin `{name, daten:"behalten"|"loeschen"}` (behalten = Unterlaufwerk nach `/data/backup/geloescht/<name>-<zeit>` verschieben)
- `freigaben.verbindung` nutzer `{name}` → `{smb, hinweise:{mac, windows, linux}}`

**dateien** (alle als anfragender Nutzer; `pfad` relativ zur Freigabe, normalisiert, kein `..`)
- `dateien.liste` `{freigabe, pfad, sortierung?, versteckte?}` → `{eintraege:[{name, art:"ordner"|"datei"|"link", groesse, geaendert, rechte, mime?}], pfad, eltern}`
- `dateien.ordner` `{freigabe, pfad, name}`; `dateien.umbenennen` `{freigabe, pfad, neuer_name}`; `dateien.verschieben` `{freigabe, quellen:[…], ziel_freigabe, ziel_pfad, ersetzen?:[namen], beide?:[namen]}` (aufgabe); `dateien.kopieren` (aufgabe, gleiche Form).
  Namenskonflikt am Ziel ohne Angabe → `E_EXISTIERT` (nichts passiert). `ersetzen`: Vorhandenes kommt vorher in den Papierkorb der
  Zielfreigabe (`papierkorb.json` mit `grund:"ersetzt"`; ohne Papierkorb endgültig weg). `beide`: Ablage als „Name (n).ext“; Kopieren
  an denselben Ort nur mit `beide` (Duplikat). Ergebnis zusätzlich `{ersetzt, papierkorb}`.
- `dateien.vorhanden` nutzer (Leserecht) `{freigabe, pfad, namen:[relativ zu pfad, auch mit Unterordnern, max. 1000]}` → `{vorhanden:[{name, art, groesse, geaendert}]}`
  – nur existierende; die Oberfläche fragt damit vor Hochladen/Kopieren/Verschieben nach (Ersetzen / Beide behalten / Überspringen).
- `dateien.loeschen` `{freigabe, pfade:[…], endgueltig?:false}` → in `.papierkorb/<zeit>/…` (mit `papierkorb.json` für Herkunft) oder `rm -r`
- `dateien.papierkorb.liste` `{freigabe}`; `dateien.papierkorb.wiederherstellen` `{freigabe, eintraege:[…]}` → `{wiederhergestellt, uebersprungen, umbenannt:[{pfad, neu}]}`
  (seit 0.3.4: ist der ursprüngliche Ort belegt, kommt der Eintrag als „Name (n)“ daneben statt übersprungen zu werden); `dateien.papierkorb.leeren` `{freigabe}`
- `dateien.ticket` `{freigabe, pfad, art:"lesen"|"schreiben"|"zip", groesse?, bei_vorhanden?:"fehler"|"ersetzen"|"beide"}` → `{ticket, dateiname, groesse?, mime}` (§3).
  `bei_vorhanden` (nur schreiben, Standard `fehler`): `fehler` überschreibt nie (`E_EXISTIERT` bei der Prüfung und – atomar per hartem
  Link – beim Abschluss), `ersetzen` legt die alte Version in den Papierkorb (harter Link + rename = atomarer Austausch), `beide` legt
  bei belegtem Namen als „Name (n).ext“ ab. Web: `POST /api/dateien/hochladen?…&bei_vorhanden=` → `{freigabe, pfad, name, groesse, ersetzt, umbenannt, papierkorb}`.
- `dateien.info` `{freigabe, pfad}` → `{name, art, groesse, geaendert, erstellt, rechte, besitzer, mime, bild?:{breite, hoehe}}`
- `dateien.ordnergroesse` `{freigabe, pfad}` → `{groesse, dateien, ordner, vollstaendig, uebersprungen}` – Summe samt Unterordnern als Nutzer, höchstens 20 s (sonst `vollstaendig:false`), 2 min zwischengespeichert, lesend (0.16.1)
- `dateien.vorschau` nutzer (Leserecht) `{freigabe, pfad, groesse?:128|256|512 (Standard 256)}` → `{mime:"image/webp"|"image/jpeg", daten:<base64>,
  groesse, aus_cache}` (seit 0.4.0). Nur für Bilder (png/jpg/gif/webp/bmp/avif/tiff/heic/heif/jxl/RAW) und Videos (mp4/m4v/webm/mov/
  mkv/avi/mts/ts/wmv/flv/3gp/mpeg) nach Endung, sonst `E_PARAMS`; `lesend` (kein Prüfprotokoll-Eintrag je Abruf). Erzeugt
  `src/agent/helfer/vorschau.js` mit `nice -n 10 prlimit --as=1,5 GiB ffmpeg` ALS NUTZER (setpriv; Adressraum-Deckel gegen Pixelbomben): längste Seite ≤ groesse, kein Vergrößern, EXIF-/Video-Drehung übernimmt ffmpeg 8 selbst (geprüft 28.09.); Video =
  Einzelbild bei Sekunde 3, kürzere Videos ab 0; WebP mit Transparenz, JPEG-Rückfall ohne libwebp. Zwischenspeicher `/data/vorschau/
  <xx>/<sha256(pfad, mtime, größe, zielgröße, formatversion)>.webp` (root 0700; ZUERST öffnet `head -c 1` als Nutzer das Original (echtes
  open(2) – `test -r` übersieht ACL-Rechte): ohne Leserecht `E_RECHTE`, bevor Existenz, Größe oder gemerkte Fehler sichtbar werden), höchstens 2 ffmpeg-Läufe gleichzeitig (Warteschlange), Zeitlimit 30 s Bild / 60 s Video, gescheiterte
  Dateien 10 min gemerkt (kein erneuter Lauf), Belegung wird mitgeführt, > 2 GiB räumt sofort auf (sonst täglich: > 180 Tage oder > 2 GiB → älteste zuerst). Fehlt ffmpeg (Installation
  vor 0.4.0), startet der Agent beim Start die transiente Unit `fahnas-ffmpeg-install` (apt-get install → update → install) und antwortet
  bis dahin `E_SYSTEM` mit `details.hinweis`; das ISO installiert ffmpeg von Anfang an (erststart PAKETE).
- `dateien.link.anlegen` `{freigabe, pfad, gueltig_h}` (0 = dauerhaft → `ablauf: null`, seit 0.19.0) → `{token, url, name, ablauf}`; `dateien.link.liste`/`loeschen`;
  `dateien.link.oeffnen` (gast, lesend) – siehe §18; Web: `GET /link/<token>` ohne Anmeldung

**snapshots**
- `snapshots.liste` nutzer `{ziel:"system"|<freigabe>}` → `[{id, zeit, art:"manuell"|"zeitplan"|"pre"|"post"|"sicherheit", beschreibung, groesse?}]`
- `snapshots.erzeugen` admin `{ziel, beschreibung?}` → Eintrag (`btrfs subvolume snapshot -r` bzw. `snapper create`)
- `snapshots.loeschen` admin `{ziel, id}`
- `snapshots.durchsuchen` nutzer `{ziel(freigabe), id, pfad}` → wie `dateien.liste` (aus dem Schnappschuss, nur lesen)
- `snapshots.zurueckholen` nutzer `{freigabe, id, pfade:[…], ziel_pfad, ueberschreiben?:false}` (aufgabe; kopiert aus dem Schnappschuss; verlangt
  Schreibrecht in der Freigabe). `ueberschreiben:false` (Standard) → `E_EXISTIERT`, wenn am Ziel schon etwas liegt; die Oberfläche schickt
  `true` nur, wenn der Nutzer im Zurückholen-Dialog „Vorhandene ersetzen“ wählt, und blendet den Knopf ohne Schreibrecht aus (Recht aus
  `dateien.liste.schreiben`, Rückfall `freigaben.liste.schreiben`).
- `snapshots.zurueckrollen` admin `{freigabe, id}` (aufgabe; erst Sicherheits-Schnappschuss, dann Unterlaufwerk tauschen)
- `snapshots.system.standard` admin `{id}` → macht den snapper-Schnappschuss `<id>` zum Stand für den nächsten Start. Umbenenn-Ansatz
  (kein `set-default`, kein `update-grub`, weil Ubuntus GRUB `rootflags=subvol=@` und die fstab `subvol=@` festschreiben): Poolwurzel
  `subvolid=5` nach `/run/fahnas/sysroot` einhängen, snapper-Sicherheitseintrag „Vor Rückrollen auf <id> (FAH-NAS)“, `mv @ → @_alt_<zeit>`,
  `btrfs subvolume snapshot /.snapshots/<id>/snapshot → @`, fstab/grub.cfg im neuen `@` prüfen (nur Warnungen), höchstens 2 Reste behalten,
  aushängen → `{id, quelle, alt:"@_alt_<zeit>", sicherheit:<snapper-Nr>|null, neustart_noetig:true, hinweis, geloeschte_reste:[…], warnungen:[…]}`.
  Fehler: `E_NICHT_GEFUNDEN` (kein Schnappschuss), `E_BELEGT` (ein Lauf läuft schon), `E_SYSTEM` mit `details.stufe` – Umbenennungen zurückgedreht.
- `snapshots.system.startmenue` admin `{}` → `{eintraege:[{id, titel, zeit?, art?, beschreibung?}], experimentell:true, hinweis}` – der Start eines
  Eintrags aus dem Startmenü (grub-btrfs) ist nur lesend/experimentell; dauerhaft wird ein Stand nur über `snapshots.system.standard` + Neustart.
- `snapshots.system.reste` admin `{}` → `{reste:[{name, art:"alt"|"kaputt", zeit, laufend}], wurzel, behalten:2}` – Unterlaufwerke `@_alt_<zeit>` /
  `@_kaputt_<zeit>` der Systempartition (neueste zuerst); `laufend:true` = daraus läuft das System gerade (nicht löschbar); `wurzel` = Name der laufenden Wurzel (normal `@`).
- `snapshots.system.rest_loeschen` admin `{name}` → `{name, geloescht:true}` (`btrfs subvolume delete --recursive`; `E_BELEGT` für die laufende Wurzel).
- `snapshots.system.zurueck` admin `{name}` → Rücktausch `@ → @_kaputt_<zeit>`, `<name> → @` → `{alt:<name>, kaputt:"@_kaputt_<zeit>", neustart_noetig:true, hinweis, geloeschte_reste, warnungen}`.
- `snapshots.plan.lesen` admin `{}` → `snapshots.json`; `snapshots.plan.setzen` admin `{ziel, zeitplan, behalten}` → rendert systemd-Timer/snapper
  Seit 0.32.0 vierter Takt `monatlich` (am 1. um 04:00; System: `TIMELINE_LIMIT_MONTHLY`), `behalten.monatlich` Standard 12.
  Oberfläche: Zeile je Takt mit Schalter, Anzahl und Frist (Wert + Einheit, gekoppelt: Monat ≈ 30,4 Tage, Jahr = 365 Tage),
  darunter „Ältester Stand reicht ca. …“; Update-Paare (nur System) unter „Erweitert“.

## 5. Web-API (Browser ⇄ Web-Dienst)

Alle Antworten JSON `{ok:true, ergebnis}` oder `{ok:false, fehler:{code, meldung, details?}}`. Schreibend = POST mit
Header `X-FAHNAS-CSRF` (Wert des Cookies `fahnas_csrf`). Sitzung im Cookie `fahnas_sitzung`.

- `GET  /api/ersteinrichtung` → `{noetig}`; `POST /api/ersteinrichtung {startcode, name, passwort, anzeigename}`
  → `{angelegt:true, angemeldet:boolean, name, rolle, totp_noetig:false}` (präzisiert 25.09., R3 Fund 14): bei `angemeldet:true` hat
  der Web-Dienst die Sitzung schon angelegt und Sitzungs- + CSRF-Cookie gesetzt – die Oberfläche ruft dann NICHT mehr `/api/anmelden`
  (sonst zweite Sitzung); nur bei `angemeldet:false` ist die normale Anmeldung nötig. Nach abgeschlossener Ersteinrichtung antwortet
  `POST` mit 409 `E_EXISTIERT` („schon abgeschlossen – bitte melde dich an“), nicht mehr 503.
- `POST /api/anmelden {name, passwort, angemeldet_bleiben}` → `{ok, totp_noetig?}`; `POST /api/anmelden/totp {code}` (TOTP- oder
  Wiederherstellungscode) → `{totp_noetig:false, wiederherstellung?:true, verbleibend?:n}`; `POST /api/abmelden`.
  Bremse (präzisiert 25.09., R1 Fund 4): der Versuch wird VOR dem Agent-Aufruf reserviert – gleichzeitig abgeschickte Anfragen über
  die Grenze (5 je IP und je Name, Fehler + laufende) bekommen sofort 429 `E_BREMSE` mit `details.warte_s`; gilt für Passwort, TOTP,
  Wiederherstellungscode und Startcode (`POST /api/ersteinrichtung`).
- `GET  /api/ich` → `{name, anzeigename, rolle, totp, sprache, design}`
- `POST /api/agent/<aktion>` mit `params` als Body → wird 1:1 an den Agenten gereicht (kontext aus Sitzung). Nur Aktionen der
  Rolle `admin`/`nutzer`, nie `system`. Aufgaben liefern `{aufgabe}`; Fortschritt kommt über SSE.
- `GET  /api/ereignisse` (SSE): `messwerte` (1/s: cpu, ram, platten, netz, temperatur), `aufgabe`, `konfig`, `system`, `agent` (`verbunden`/`getrennt`)
- `GET  /api/messwerte/verlauf` → Ringpuffer 10 min
- `GET  /api/dateien/herunterladen?freigabe=&pfad=` (Datei) und `?…&zip=1` (Ordner) → holt Ticket, streamt Datenkanal, `Content-Disposition`
- `POST /api/dateien/hochladen?freigabe=&pfad=&name=` (Body = Rohdaten, `Content-Length` Pflicht) → Ticket `schreiben`, streamt
- `GET  /api/dateien/vorschau?freigabe=&pfad=&groesse=128|256|512[&v=<mtime>-<größe>]` (seit 0.4.0) → ruft `dateien.vorschau` und antwortet als
  Bild (`Content-Type` image/webp|jpeg, `Content-Length`, `Cache-Control: private, max-age=604800, immutable`, `Content-Disposition: inline`,
  eigene CSP `default-src 'none'; sandbox`). `v` wird nicht ausgewertet – es macht die URL je Dateistand eindeutig (Browser-Cache). Fehler
  als JSON wie überall (E_PARAMS ohne Pfad/bei falscher Größe, E_RECHTE, E_SYSTEM ohne ffmpeg); das `<img>` der Oberfläche zeigt dann das Symbol.
- `GET  /link/<token>` → öffentliche Linkseite (seit 0.19.0, §18); `?herunterladen=1` = alter direkter Download über `dateien.link.pruefen`
- `GET /api/agent-download?ticket=` und `POST /api/agent-upload?ticket=` (D6) nehmen seit 25.09. (R1 Fund 3) nur Tickets an, die
  DIESELBE Sitzung zuvor aus einem Ergebnis von `POST /api/agent/<aktion>` erhalten hat (90 s gemerkt, einmalig); fremde, unbekannte oder
  abgelaufene Tickets → 404 `E_NICHT_GEFUNDEN`, ohne das Ticket des Besitzers zu verbrauchen (Web-Protokoll `ticket_fremd`).
  Gemerkter Dateiname/MIME gewinnen gegen `dateiname=`/`mime=` aus der Anfrage.
- Fehlerantworten (25.09., R1 Fund 14): `fehler.details` gehen vollständig nur an Rolle `admin`. Für `nutzer`/`gast` bleiben nur
  `feld, warte_s, verbleibend, noetig, frei, max, min, aktion, hinweis, wiederherstellung`; wurde etwas weggelassen, steht in
  `details.protokoll` der Verweis „Einzelheiten stehen im Protokoll des Web-Dienstes“ (Web-Protokoll `fehler_details`). Gilt ebenso
  für `fehler.details` in SSE-`aufgabe`-Ereignissen an Nicht-Admins. Die SSE-Rolle wird beim Senden aus der Sitzung gelesen.
- HTTP→HTTPS-Umleitung (nur wenn `FAHNAS_HTTP_PORT` gesetzt; seit 0.6.17 aus) übernimmt den `Host` nur, wenn er bekannt ist (Hostname, `system.json.hostname`, jeweils auch
  `.local`, `localhost`, die erreichte IP); sonst zielt sie auf die IP-Adresse, unter der der Client den Dienst erreicht hat.
- Statisch: `/` → `public/index.html`, `/public/*`; Kopfzeilen laut Entwurf §7; CSP `default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:`.
  Cache (seit 0.4.2): `index.html` no-store, alle anderen Dateien `no-cache` + ETag aus dem Inhalt (304 bei Gleichheit) – nach `fahnas update`
  zeigt der nächste Seitenaufruf die neue Oberfläche (vorher max-age=3600: bis zu eine Stunde alte Ansichten gegen die neue API).

## 6. Fehlercodes

`E_PARAMS` (Eingabe ungültig, `details.feld`), `E_RECHTE` (Rolle/Recht fehlt), `E_ANMELDUNG` (Login falsch),
`E_TOTP` (Code falsch/nötig), `E_BREMSE` (zu viele Versuche, `details.warte_s`), `E_CSRF`, `E_NICHT_GEFUNDEN`,
`E_EXISTIERT`, `E_BELEGT` (Name/Port/Pfad in Benutzung), `E_KONFIG` (Konfiguration ungültig/nicht schreibbar),
`E_RENDER` (testparm o. ä. schlägt fehl, `details.ausgabe`), `E_SYSTEM` (Systembefehl schlug fehl, `details.befehl`, `details.ausgabe`;
auch „Ergebnis zu groß“ mit `details.zeichen`/`details.max`, §2), `E_PLATZ` (Kontingent/Platte voll), `E_AGENT` (Agent nicht erreichbar),
`E_TICKET` (Datenkanal-Ticket ungültig/abgelaufen/für einen anderen Nutzer), `E_ABGEBROCHEN`, `E_GEAENDERT` (seit 0.21.0: Datei wurde seit dem
Laden geändert, HTTP 409, `details.geaendert`/`details.groesse` = Stand auf der Platte, auch für Nicht-Admins sichtbar), `E_UNBEKANNT`.
Seit 0.21.0 trägt `E_NICHT_GEFUNDEN` aus `office.*` das Detailfeld `office` (`'verschoben'` = das Bündel liegt nicht mehr am
bekannten Ort, `'geloescht'` = es liegt im Papierkorb); es erreicht auch Nicht-Admins (§20.4).
`details.befehl`/`details.ausgabe`/`details.pfad`/`details.grund` erreichen nur Admins (§2, Filter im Agenten).

## 7. Konfigurationsdateien (Schemata) – siehe Entwurf §5.2

Zusätzlich verbindlich:
- Schreiben immer atomar über `konfig.speichern(name, daten)` (tmp mit `wx` + fsync + rename; liegen gebliebene tmp werden ersetzt). Lesen mit Standardwerten
  (`konfig.laden(name, standard)`). `version.json` = `{schema: 1}`; Migrationen in `src/gemeinsam/migrationen.js`.
- **Lesen-Ändern-Schreiben nur über `konfig.aendern(name, fn, standard?, modus?)`** (25.09., R1 Fund 5): lädt, ändert und schreibt unter der
  Sperre der Datei (je Datei eine Kette, in der auch `speichern` läuft). Wirft `fn`, wird nichts geschrieben; gibt `fn` `UNVERAENDERT`
  (Export aus `konfig.js`) zurück, ebenfalls nicht. Module (nutzer, freigaben, dateien/links, snapshots-Zustand, system.json) nutzen kein
  `laden` + `speichern` mehr für Änderungen. Der Rückgabewert von `aendern` sind die geschriebenen Daten.
- **MODUS-Tabelle** (`users.json`, `links.json` → 0600, sonst 0640) gilt für `speichern` UND `aendern` UND den Import (R1 Fund 11).
- `aufgaben.json` = Zustandsdatei der Aufgaben (§2), nie im Export.
- Export ohne Geheimnisse lässt zusätzlich zu `web/tls` auch `samba/` (passdb.tdb = NT-Hashes, secrets.tdb = SID) und `links.json`
  (Download-Tokens) weg (R1 Fund 2). Der Import prüft Archive auf Verknüpfungen/Pfade (§4 `system.import`).
- Prüfprotokoll: Monatsdateien älter als `system.json.aufbewahrung.protokoll_monate` löscht der Agent beim Start und täglich; `system.protokoll`
  liest zeilenweise; `params` je Eintrag höchstens 8192 Zeichen, sonst `{_gekuerzt:true, zeichen, felder}` (R1 Sammelfund a).
- `users.json`: Hash-Format `scrypt$N$r$p$salz_b64$hash_b64` (N=32768, r=8, p=1, 32 Byte). TOTP-Geheimnis Base32,
  Wiederherstellungscodes als scrypt-Hashes.
- `shares.json`: `lesen`/`schreiben` sind Listen aus Nutzernamen oder `@gruppe`. `gaeste:true` = `guest ok`.

## 8. Oberfläche – Ansichten-Vertrag

`public/app.js` (Rahmen) lädt Ansichten dynamisch: jede Datei `public/ansichten/<name>.js` exportiert
`export default { id, titel(), symbol, rolle:"nutzer"|"admin", async einbinden(wurzel, ctx), verlassen?() }`.
`ctx = { api(aktion, params), get(pfad), post(pfad, body), sse.on(art, fn), t(schluessel, werte?), nutzer, melden(text, art), bestaetigen(text), dialog(inhalt) }`.
Registrierung in `public/ansichten/index.js` als Liste `[ {id, datei, rolle, reihenfolge} ]`. Der Rahmen rendert
Navigation (unten auf dem Handy, links auf dem Desktop), Kopfzeile, Zustandsleiste (Agent getrennt), Meldungen.

Stil: `public/stil.css` definiert Variablen (`--fahnas-hintergrund`, `--fahnas-flaeche`, `--fahnas-text`,
`--fahnas-akzent`, `--fahnas-gefahr`, `--fahnas-rand`, `--fahnas-radius`) für hell/dunkel und Basisklassen
`.karte`, `.knopf`, `.knopf-gefahr`, `.feld`, `.schalter`, `.tabelle`, `.hinweis`, `.leer`, `.kachel`, `.fortschritt`.
Weitere Ansichten liefern eigenes CSS in `public/ansichten/<name>.css` (vom Rahmen beim Einbinden geladen).
Jede Einstellung: Beschriftung + kurzer Erklärtext (`<p class="erklaerung">`).

Sprache: `public/sprache/de/<bereich>.json`; `ctx.t("bereich.schluessel")`. Fehlende Schlüssel → Test schlägt fehl.

Größen: die Oberfläche rechnet durchgängig binär (1024er-Schritte) und schreibt die Einheiten `KiB`/`MiB`/`GiB`/`TiB`
(`app.js format.groesse`, `verwaltung-hilfen.js groesseFormat`); `groesse_gb` einer Freigabe ist GiB (`× 1024³`, wie der Agent) und heißt in
der Oberfläche „Kontingent (GiB)“. Kontraste: Text auf Fläche ≥ 4,5:1 (WCAG AA) für alle Farbpaare der Stilvariablen in hell und dunkel; dafür
gibt es zusätzlich `--fahnas-akzent-auf-hell` (Schrift auf `--fahnas-akzent-hell`), `--fahnas-gefahr-text` und `--fahnas-gefahr-dunkel`
(Schrift/hover der Gefahr-Knöpfe) – geprüft in `tests/einheit/ui_fixes.test.js`. Tabellen aus `verwaltung-hilfen.js tabelle()` sind unter
720 px Kartenlisten (`.tabelle-karten`, `data-label` je Zelle aus der Spaltenüberschrift). Berührungsziele auf dem Handy ≥ 40 px
(`.knopf-klein`, Dateiname-Knopf und Baum-Aufklapper 44 px).

Formen, die die Oberfläche an den Agenten schickt (Stand nach Prüfung R3): `system.setzen {aenderungen:{netz}}` bei DHCP nur
`{modus:"dhcp", schnittstelle:"<name>"|"", dns:[…]}` (Adresse/Gateway leert der Agent selbst), bei statisch zusätzlich `adresse` und `gateway`
(leer = `""`, niemals `null` – `null` fällt in der Schemaprüfung weg und der alte Wert bliebe stehen); Schnittstellenname ≤ 15 Zeichen, DNS
≤ 3, `platten_ruhe_min` ≤ 330 werden schon im Formular geprüft. `system.dienst` wird mit `zustand: "aktiv"|"inaktiv"|"fehler"` gelesen (alte
Form `an|aus|neustart` wird zugeordnet). `system.updates.einspielen` liefert `eingespielt` als Paketliste, `anzahl` als Zahl. `dateien.liste`
liefert `schreiben`/`papierkorb`, die Hochladen/Neuer Ordner/Umbenennen/Verschieben/Löschen/Ablage und den Papierkorb-Knopf schalten.
Kachelansicht (seit 0.4.0, `public/ansichten/dateien.js`): jede Kachel hat ein Bildfeld (4:3) mit dem Symbol der Art; Bilder und Videos
laden darüber `<img loading="lazy">` von `GET /api/dateien/vorschau` (Größe 128/256/512 aus Kachelstufe × Pixelverhältnis, `v` aus
`geaendert`+`groesse`; Fehler → Symbol bleibt), Videos mit Abspiel-Zeichen. Schieberegler „Kachelgröße“ (nur in der Kachelansicht, sechs
Stufen 96–340 px Mindestbreite, `--dateien-kachel-min` am Raster, Erklärung als Tooltip, aria-describedby und einmaliger Hinweis beim
ersten Verstellen je Gerät) – gemerkt je Gerät in `localStorage` `fahnas_dateien_kachelgroesse`; wechselt die nötige Bildgröße, werden die
Kacheln nach 150 ms Ruhe neu gezeichnet, das zuletzt geladene Bild bleibt bis zum Vorladen des schärferen stehen; Bilder aus dem
Browser-Cache gelten sofort als geladen (kein Flackern beim Neuzeichnen). Nur Endungen aus `VORSCHAU_MUSTER` (Spiegel der Agent-Liste)
werden angefragt – SVG/ICO nicht. Im Papierkorb und in der Listenansicht gibt es keine Vorschaubilder.
`POST /api/ersteinrichtung` antwortet `{angelegt:true, angemeldet:true}` – die Oberfläche ruft dann kein `POST /api/anmelden` mehr.

## 9. Zuständigkeiten beim parallelen Bau

| Teil | Dateien (exklusiv) |
|---|---|
| Grundlage (vorgegeben) | `src/gemeinsam/*`, `src/agent/agent.js`, `src/agent/register.js`, `src/agent/audit.js`, `src/agent/aufgaben.js`, `src/agent/datenkanal.js`, `src/web/agentclient.js`, `package.json` |
| A Nutzer+Freigaben | `src/agent/aktionen/nutzer.js`, `freigaben.js`, `src/agent/render/samba.js`, `linuxnutzer.js`, `tests/einheit/nutzer*.test.js`, `freigaben*.test.js`, `samba*.test.js` |
| B Dateien+Schnappschüsse | `src/agent/aktionen/dateien.js`, `snapshots.js`, `src/agent/render/snapper.js`, `tests/einheit/dateien*.test.js`, `snapshots*.test.js` |
| C System+Export+CLI | `src/agent/aktionen/system.js`, `src/agent/render/{netplan,firewall,hostname}.js`, `src/agent/export.js`, `tools/fahnas`, `tools/build_release.sh`, `tests/einheit/system*.test.js`, `export*.test.js` |
| D Web-Dienst | `src/web/*` außer `agentclient.js`, `tests/einheit/web*.test.js`, `auth*.test.js`, `totp*.test.js` |
| E Oberfläche Rahmen+Dashboard+Dateien | `public/index.html`, `public/app.js`, `public/stil.css`, `public/ansichten/{index,dashboard,dateien}.*`, `public/sprache/de/{gemeinsam,dashboard,dateien}.json`, `public/symbole.svg` |
| F Oberfläche Verwaltung | `public/ansichten/{freigaben,nutzer,snapshots,system,anmeldung,ersteinrichtung}.*`, `public/sprache/de/{freigaben,nutzer,snapshots,system,anmeldung}.json` |
| G ISO+Erststart | `iso/*`, `systemd/*`, `tests/integration/*` |

## 10. Kommandozeile `tools/fahnas` (Konsole, root) – Unterbefehle, die andere Teile aufrufen oder kennen müssen

Alle Aufrufe an den Agenten laufen mit `kontext = {nutzer:"konsole", rolle:"admin", ip:"-"}` (Rolle `system` lehnt der
Socket ab). Für Tests ersetzbar: `FAHNAS_SYSTEMCTL` (Pfad statt `systemctl`), `FAHNAS_SYSTEMD` (statt `/etc/systemd/system`),
`FAHNAS_ISSUE_D` (`/etc/issue.d`), `FAHNAS_MOTD_D` (`/etc/motd.d`), `FAHNAS_GESUNDHEIT_MS` (Wartezeit nach `update`).

- `fahnas issue` – schreibt `/etc/issue.d/fahnas.issue` (agetty-`\4` = aktuelle IPv4, Rechnername) und `/etc/motd.d/fahnas`
  (pam_motd, statisch). Der Startcode steht NUR darin, solange `/etc/fahnas/startcode` existiert. Der Erststart ruft ihn im
  Schritt `konsole`; **der Agent ruft `fahnas issue` nach erfolgreicher `system.ersteinrichtung`** (Startcode gelöscht →
  Hinweis ohne Code; `execFile(<programm>/tools/fahnas, ['issue'])`, Fehler nur protokollieren). `fahnas startcode` ruft
  ihn selbst mit (still, wenn `/etc` nicht schreibbar).
- `fahnas totp-entfernen <nutzer>` – ruft `nutzer.totp.entfernen {name}` **ohne `passwort`**. Der Agent behandelt
  `kontext.nutzer === "konsole"` wie Rolle `system` (kein Passwort nötig; Schema-Feld `passwort` nicht mehr `pflicht`) –
  Änderung in `src/agent/aktionen/nutzer.js` (Teil A / FX1a). Notfallweg, wenn Handy und Wiederherstellungscodes fehlen.
- `fahnas sitzungen-beenden <nutzer>` – hält `fahnas-web` an (`systemctl stop`), entfernt aus `web/sitzungen.json`
  (`{sitzungen:{<id>:{nutzer,…}}}`) alle Einträge mit diesem `nutzer` (Besitzer/Modus der Datei bleiben), startet den
  Web-Dienst wieder. Ohne systemctl (Container) wird nur die Datei geändert – wirksam beim nächsten Start des Web-Dienstes.
- `fahnas update <release.tar.gz>` – zusätzlich zum Programmtausch: Units aus `<release>/systemd/*.{service,target,timer,socket,path}`
  nach `/etc/systemd/system` (nur bei geändertem Inhalt; alte Fassung unter `/opt/fahnas.alt/systemd.installiert/`),
  `systemctl daemon-reload`, beim Rücktausch werden die Units zurückgespielt. Ausgabe nennt die erneuerten Units.
- `erststart.sh --erneut` ersetzt `/opt/fahnas` nur noch, wenn das Medium eine NEUERE `BUILD_VERSION` trägt (`sort -V`) oder
  `src/agent/agent.js` fehlt; ein per `fahnas update` eingespielter, neuerer Stand bleibt.

## 11. Teilprojekt 2 – Apps (verbindlich, Entwurf docs/superpowers/specs/2026-09-25-fahnas-apps-design.md)

Aufräumen (seit 0.6.16): `apps.loeschen` entfernt nach `down` die Images der App (`docker image rm` ohne `-f` – von anderen
Containern benutzte bleiben) und liefert `images_entfernt`, `frei_bytes`; `apps.loeschen`, `apps.aktualisieren`,
`apps.zip.aktualisieren` und `apps.apply` (nach einem Neubau) rufen `docker image prune -f` + `docker builder prune -f
--filter until=168h` (unbenannte alte Fassungen, Bau-Zwischenspeicher > 7 Tage), Ergebnis `frei_bytes`.
`apps.steuern start` baut ein fehlendes FAH-Image aus dem Quellcode (Web-Zeitlimit 15 min, seit 0.6.15).
Aktionen Bereich `apps` (Rollen/Parameter/Ergebnisse siehe Entwurf §3): `apps.katalog.liste`, `apps.katalog.eintrag`,
`apps.katalog.unraid_laden` (Aufgabe), `apps.katalog.importieren`, `apps.katalog.loeschen`, `apps.pruefen`, `apps.installieren`
(Aufgabe), `apps.liste`, `apps.details`, `apps.steuern`, `apps.aendern` (Aufgabe), `apps.aktualisieren` (Aufgabe), `apps.loeschen`
(Aufgabe), `apps.protokoll`, `apps.ports` (system), `apps.apply` (system; wird von system.apply nach snapshots.apply gerufen).
Pfade: eingebauter Katalog `<programm>/katalog/*.json` (PFADE.katalog, ENV FAHNAS_KATALOG), Importe/Feed `PFADE.apps/_katalog/`,
Apps `PFADE.apps/<name>/{app.json, compose.yml, .env, daten/}`, Spiegel `PFADE.konfig/apps/<name>/app.json`.
Docker nur über `ausfuehren('docker', ['compose', '-f', <compose>, '--env-file', <env>, '-p', 'fahnas-<name>', …])`.
Ereignisse: `{ereignis:"konfig", bereich:"apps"}` nach jeder Änderung; Aufgaben wie üblich.
Web: keine neuen Routen nötig (alles über `/api/agent/apps.*`); App-Symbole lädt der Browser direkt von der Quell-URL
(CSP `img-src` muss `https:` erlauben → Web-Fixer ergänzt `img-src 'self' blob: data: https:`).
Oberfläche: Ansicht `apps` (rolle nutzer, reihenfolge 25) in `public/ansichten/apps.js` (+ `.css`), Sprache `public/sprache/de/apps.json`,
Dashboard-Kachel „Apps“ füllt `dashboard.js` aus `apps.liste`.
Fehlercodes zusätzlich verwendet: `E_BELEGT` (Port/Name), `E_PARAMS` (Vorlage ungültig), `E_RECHTE` (riskant ohne Bestätigung),
`E_SYSTEM` (docker), `E_NICHT_GEFUNDEN`.

Präzisierungen 25.09. (C2, eingebauter Katalog `katalog/*.json`, Format vollständig in `katalog/README.md`, geprüft durch
`tests/einheit/katalog.test.js`):
- **Zusätzliche Schlüssel je Vorlage**: `dokumentation` (https-URL | null), `webui` darf `null` sein (App ohne Weboberfläche, z. B.
  Watchtower, Mosquitto), `hinweise: string[]` (Erstpasswort, erste Schritte, bewusst Weggelassenes), `risiko: string[]` (Pflicht bei
  `/var/run/docker.sock`, `network_mode: host`, `cap_add`; die Oberfläche zeigt sie als Warnung mit Bestätigungsschalter →
  `bestaetigt_riskant`), `verfuegbar: false` (Image nur lokal baubar – die fünf FAH-Apps; `apps.katalog.liste`/`eintrag` reichen den
  Schlüssel durch, die Oberfläche zeigt den Eintrag grau mit Hinweis; `apps.installieren` prüft vorher `docker image inspect <image>` und
  antwortet sonst `E_NICHT_GEFUNDEN` „Image fehlt – erst lokal bauen“ statt `pull`). Fehlt `verfuegbar`, gilt `true`.
- **Feld-Attribute**: `pflicht: true` (Installation nur mit nicht-leerem Wert → sonst `E_PARAMS` mit `details.feld`; der Installer setzt
  `pflicht` bei `port`/`pfad`/`auswahl`/`schalter` selbst auf true, bei `variable`/`geheimnis` nur, wenn angegeben), `werte: string[]`
  (nur `auswahl`). `HOST` ist kein Feldname (in `webui` reserviert). **Vorschlag, noch nicht umgesetzt**: `erzeugen: true` (nur
  `geheimnis`: leerer Wert → Zufallswert aus ≥ 32 Zeichen `A-Za-z0-9` aus `crypto.randomBytes`) – bis dahin tragen interne
  Passwörter, ohne die eine App nicht startet (Datenbank, `PAPERLESS_SECRET_KEY`, Duplicati-Schlüssel), `pflicht: true`.
- **Rendering der Feldarten in die `.env`** (`NAME='wert'`; Compose löst `${NAME}` daraus überall im YAML auf, auch in `shm_size`,
  `hostname`, `command`; `'` ist in Werten verboten): `port` → die Zahl; `pfad` → absoluter Pfad (relativ = `PFADE.apps/<name>/<rel>`;
  absolut nur unter `PFADE.shares/<freigabe>` – `PFADE.shares` selbst wird abgelehnt; der Installer legt fehlende Ordner im App-Ordner
  mit 0777 an, damit auch Container-Nutzer ≠ root schreiben können); `variable` → Text unverändert; `geheimnis` → nur in `.env` (0600),
  nie in `compose.yml`, in der Oberfläche maskiert; `auswahl` → gewählter Text; `schalter` → die Texte `true` bzw. `false` (Feld-Attribute
  `an`/`aus` des Installers, Standard genau so). `{HOST}` in `webui` ersetzt die Oberfläche durch die Adresse, unter der sie das NAS
  erreicht; `{PORT_X}` durch den Wert.
- **Offen für den Koordinator (Stand 25.09.)**: `vorlagePruefen` in `src/agent/apps/compose.js` reicht `verfuegbar`, `risiko` und
  `dokumentation` noch nicht durch (nur `hinweise`, `herkunft`, `version`) – die Oberfläche kann FAH-Apps deshalb noch nicht grau
  zeigen und die Katalog-Risikotexte nicht anzeigen (die Risiko-ERKENNUNG selbst macht `analysieren` unabhängig davon).
- **Compose-Regeln der eingebauten Vorlagen** (Importer soll dieselben Prüfungen anwenden): nur `${NAME}`-Platzhalter (kein `$NAME`,
  kein `${NAME:-x}`); Host-Ports ausschließlich `"${PORT_X}:cport[/tcp|/udp]"` (dasselbe Port-Feld darf für tcp und udp stehen);
  Volume-Quellen nur Pfad-Felder, benannte Volumes oder `/var/run/docker.sock`; `environment` als Liste `- NAME=wert`; kein `build`,
  `container_name`, `privileged`, `pid`, `env_file`, `extends`, `profiles`; `cap_add` nur `NET_ADMIN`/`NET_RAW`/`NET_BIND_SERVICE`
  (jeweils Bestätigung); `image` immer mit Tag; `restart: unless-stopped`; keine `devices` (NAS-abhängig, stehen in `hinweise`).
  Einträge, die beim ersten Start eine Konfigurationsdatei brauchen (Mosquitto, Prometheus), legen sie über `command`/`entrypoint`
  (`sh -c`, nur wenn keine existiert) selbst an; Images ohne root (Grafana, Prometheus, Node-RED, File Browser) starten mit `user: "0:0"`.
- Katalog-`id`s folgen `/^[a-z0-9][a-z0-9-]+$/`; Dateiname = `<id>.json`; `kategorie` aus dem festen Satz von zwölf deutschen Kategorien.

Präzisierungen Oberfläche (Teil B2, 25.09., `public/ansichten/apps.js`; Formen tolerant gelesen, Empfehlung für A2 in Klammern):
- Listen: `apps.liste` und `apps.katalog.liste.eintraege` als Array oder `{apps|eintraege|liste:[…]}`. Zustand → Ampel: `running`
  (+`gesundheit` `healthy`|leer = grün, `unhealthy`/`starting` = orange), `exited|created|stopped` = grau, `restarting|paused` = orange,
  `dead|fehler` = rot. `webui`: `{HOST}` bzw. `[IP]` ersetzt der Browser durch `location.hostname`; nur `http(s)://` wird als
  „Öffnen“ gezeigt (`target=_blank`, `rel=noopener noreferrer`). `symbol` wird als `<img>` von der Quell-URL geladen (Rückfall bei
  Ladefehler auf das eingebaute Apps-Symbol). `version` mit `@sha256:…` wird gekürzt angezeigt (Digest 12 Zeichen).
- `apps.katalog.liste`: Oberfläche schickt `{suche?, kategorie?, quelle?, seite, je_seite:48}` („Mehr anzeigen“ = `seite+1`, Anhängen);
  liest `gesamt`, `kategorien` (Texte oder `{name, anzahl}`), `quellen.<name>` als Zahl oder `{anzahl, zeit}`; Unraid-Stand aus
  `unraid_zeit` (optional, ISO) oder aus dem Ergebnis von `apps.katalog.unraid_laden` `{anzahl, zeit}`. Route `#/apps/katalog` öffnet
  den Reiter Katalog. Karten mit `quelle:"eigen"` bekommen „Aus Katalog entfernen“ (`apps.katalog.loeschen {id}`).
- `apps.pruefen {katalog_id, name, werte}` wird beim Tippen (450 ms verzögert) gerufen; verstandene Formen: `port_konflikte` als Zahlen
  oder `{feld?, port, app?, vorschlag?}` (Empfehlung: Objekt mit `feld` und `vorschlag` – dann gibt es „Vorschlag übernehmen“),
  `riskant` als Texte oder `{id|code|kennung, text|meldung}` (die Kennung geht 1:1 in `bestaetigt_riskant`), `warnungen` als Texte oder
  `{text|meldung}`, `compose` als Text. Ohne Bestätigung aller riskanten Punkte schickt die Oberfläche kein `apps.installieren`.
- Feldwerte in `werte`: `port` → Zahl (1–65535), `pfad` → relativer Unterordner (App-Ordner, z. B. `daten`) oder absoluter Pfad
  `<freigabe.pfad>/<unterordner>` (Freigabe aus `freigaben.liste`), `geheimnis` → Text (bei `apps.aendern` weggelassen, wenn leer =
  unverändert), `auswahl` → Text (`werte` als Texte oder `{wert, text}`), `schalter` → boolean, `variable` → Text. Feldobjekte:
  `{name, art, standard, beschriftung, erklaerung, werte?, pflicht?, modus?:"ro"}`. App-Name vorbelegt aus der Katalog-ID (Muster).
- Parameter: `apps.installieren {katalog_id, name, werte, autostart, bestaetigt_riskant?}` und `apps.aendern {name, werte, autostart,
  bestaetigt_riskant?}` (`bestaetigt_riskant` nur, wenn nicht leer); `apps.loeschen {name, daten:"behalten"|"loeschen"}` mit Tipp-
  Bestätigung des Namens; `apps.steuern {name, aktion:"start"|"stopp"|"neustart"}`; `apps.protokoll {name, zeilen:50|200|500|1000}` →
  `{zeilen:[Text]}` (auch `{zeit, dienst, text}` je Zeile oder ein Text mit Zeilenumbrüchen); `apps.details {name}` → Oberfläche liest
  `werte`, `autostart`, `compose` und `felder?` (sonst `apps.katalog.eintrag {id: katalog_id}` für die Felddefinitionen);
  `apps.katalog.importieren {xml}` oder `{url}` (nie beides); `apps.aktualisieren` → `{alt, neu}` in der Erfolgsmeldung.
- Live: Ereignis `{ereignis:"konfig", bereich:"apps"}` lädt die Liste neu (300 ms gebündelt); zusätzlich alle 20 s für CPU/RAM, solange der
  Reiter „Installiert“ offen und der Browser-Tab sichtbar ist. Rolle nutzer sieht Karten mit „Öffnen“ und „Protokoll“, Katalog ohne Knöpfe.
- Sprache: `public/sprache/de/apps.json` enthält den Menüschlüssel `navigation.apps` (Punkt-Schlüssel gilt als vollständig); wird er in
  `gemeinsam.json` aufgenommen, muss er hier raus (sonst Dublette im Sprachtest). Dashboard-Kachel „Apps“: Anzahl, `laufend · gestoppt ·
  mit Fehler` (fehlerhaft = `dead|fehler|restarting` oder `running`+`unhealthy`), orange bei Fehlern, „Gerade nicht verfügbar.“ bei
  `E_NICHT_GEFUNDEN`/`E_AGENT`.

Präzisierungen Agent (Teil A2, 25.09., `src/agent/aktionen/apps.js`, Hilfsmodule `src/agent/apps/{compose,katalog,unraid,docker}.js`,
Tests `tests/einheit/apps*.test.js`, `tests/integration/10_apps.sh`, Testdaten `tests/daten/{katalog,unraid}`):
- **Dateien je App**: `compose.yml` (0640) = Compose-Fragment der Vorlage UNVERÄNDERT mit `${FELD}`-Platzhaltern; `.env` (0600 root)
  trägt ALLE Feldwerte als `NAME='wert'` (auch Geheimnisse und normale Variablen; `'`, Zeilenumbrüche und Steuerzeichen in Werten →
  `E_PARAMS`). Werte werden nie in YAML eingesetzt (kein Injektionsrisiko); für Prüfung/Vorschau setzt der Agent in einer Kopie ein.
  `app.json` im App-Ordner ist nur eine Kopie – Wahrheit ist der Spiegel `<konfig>/apps/<name>/app.json` (über `konfig.aendern`):
  `{name, katalog_id, titel, symbol, kategorie, webui, vorlage:{id, name, quelle, beschreibung, kategorie, symbol, webui, compose, felder,
  herkunft, hinweise, version}, eingabe (Rohwerte ohne Geheimnisse), werte (geprüft, Pfade absolut), geheimnisse:[Feldnamen],
  ports:[{port, protokoll, dienst, ziel, feld}], dienste:[{name, image}], binds, benannte_volumes, risiken:[art…], bestaetigt_riskant,
  warnungen, autostart, installiert, geaendert, aktualisiert, version:{images:{<image>: digest}}, sicherungen:[{ordner, zeit, groesse}]}`.
  Geheimnisse stehen NUR in `.env` – geht sie verloren (Neuinstallation ohne `@apps`), rendert `apps.apply` sie als leer bzw. bei
  Pflicht-Geheimnissen als `BITTE-NEU-SETZEN` mit Warnung; neu setzen über `apps.aendern {werte:{<GEHEIMNIS>: …}}`.
- **Ordnerrechte**: App-Ordner 0750 root; `daten/` und alle Pfad-Felder unterhalb des App-Ordners werden mit 0777 angelegt (Container-
  Nutzer ≠ root müssen schreiben können); Pfade in Freigaben müssen existieren (`E_NICHT_GEFUNDEN`, `details.feld`) und werden nicht angelegt.
- **Docker-Aufrufe** (nur Argumentlisten, JSON-Ausgaben): `docker compose --ansi never --progress plain -p fahnas-<name> -f <compose>
  --env-file <env> <pull [--ignore-pull-failures] | up -d --remove-orphans | down --remove-orphans [--volumes] | stop | restart |
  ps -a --format json | logs --no-color --timestamps --tail N [dienst] | config -q | config --images>`; `docker ps -a --no-trunc --format
  json` + `docker stats --no-stream --format json` (für `apps.liste`, 10 s Zwischenspeicher, Zuordnung über Label
  `com.docker.compose.project`), `docker image inspect --format '{{json .RepoDigests}}|{{.Id}}'` (Digest, sonst Image-ID),
  `docker version`, `ss -ltnuH` (belegte Ports), `curl -fsSL` (Feed/Import), `du -s -B1`, `cp --reflink=auto -a`, `mv`. Umgebung der
  Docker-Aufrufe: `PATH`, `LANG`, `HOME`, `DOCKER_CLI_HINTS=false`. Mit `system.starten` laufen pull/up mit Live-Zeilen (Fortschritt =
  fertige Dienste „Pulled“/gesamt), ohne `starten` über `ausfuehren` (Zeilen am Ende).
- `apps.installieren`: Reihenfolge Prüfung → Konflikte → Dateien → `config -q` → `pull --ignore-pull-failures` (lokal gebaute Images gehen;
  Fehler je Dienst als `warnungen`, `up -d` entscheidet) → `up -d` → Digests → Spiegel → Firewall → Ereignis. Vorlagen mit `verfuegbar:false`:
  vorher `docker image inspect`, ohne Image `E_NICHT_GEFUNDEN` („erst lokal bauen“, `details.image`), kein pull. Schlägt etwas fehl, werden
  Container (`down`), Ordner und Spiegel wieder entfernt. Ergebnis `{name, zustand, gesundheit, webui ({HOST} bleibt), ports, warnungen, risiken}`.
  `apps.steuern start` = `up -d` (idempotent, legt fehlende Container an); Ergebnis `{name, aktion, zustand, gesundheit}`.
- **Zustände**: `running|exited|created|paused|dead|restarting|teilweise|fehlt|unbekannt` (Docker-Wörter; `teilweise` = nicht alle Dienste
  laufen, `fehlt` = keine Container, `unbekannt` = Docker nicht erreichbar), `gesundheit` `healthy|unhealthy|starting|null`. `apps.liste`
  liefert je App `{name, katalog_id, titel, symbol, kategorie, zustand, gesundheit, webui, ports, autostart, cpu_prozent, ram_bytes,
  installiert, aktualisiert, version, container (Anzahl), risiken, quelle}` – CPU/RAM Summe der laufenden Container, `null` ohne stats.
  `apps.details` = Spiegel (ohne `eingabe`-Geheimnisse) + `werte, eingabe, felder, compose (Datei), container:[{id, name, dienst, zustand,
  gesundheit, status, image, exitcode, ports}], docker:boolean, zustand, gesundheit, webui`.
- `apps.pruefen` → `{compose (Vorschau mit eingesetzten Werten, Geheimnisse als ********), warnungen:[Text], riskant:[{art, kennung (=art),
  dienst, wert, text}], port_konflikte:[{feld|null, port, protokoll, belegt_von, app|null, vorschlag (nächster freier Port)}], ports, webui,
  dienste, binds, name_frei, felder, hinweise}`. `bestaetigt_riskant` nimmt die Kennungen `privileged, network_host, pid_host, ipc_host,
  userns_host, cap_add, security_opt, devices, docker_sock`; JEDES `cap_add` braucht Bestätigung (NET_ADMIN/NET_RAW/NET_BIND_SERVICE mit
  erklärendem Text). Bind-Mounts außerhalb von `<apps>/<name>` und `<shares>/<freigabe>` → `E_PARAMS` (Ausnahmen: `docker.sock` = Risiko
  `docker_sock`, `/etc/localtime`/`/etc/timezone` nur lesend, `/dev/*` = Risiko `devices`); Host-Port ohne Host-Angabe („80“) → `E_PARAMS`;
  `sysctls` und fehlendes `restart` sind Warnungen. `E_BELEGT` beim Installieren/Ändern trägt `details.port_konflikte` und `details.feld`.
- `apps.katalog.liste` → `{eintraege:[Vorlage ohne compose/felder, dazu felder_anzahl, geheimnisse (Anzahl), verfuegbar, dokumentation,
  risiko?, hinweise?, herkunft?, beliebtheit?], gesamt, seite, je_seite, kategorien:[Text], quellen:{eingebaut, unraid, eigen} (Zahlen),
  unraid_geladen = unraid_zeit (ISO|null), unraid_anzahl, installiert:[{name, katalog_id}]}`; Reihenfolge: Namenstreffer zuerst, dann
  eingebaut vor Rest, dann Beliebtheit (Unraid-Downloads), dann Name. `apps.katalog.eintrag` = vollständige Vorlage + `installiert:[Namen]`.
  `apps.katalog.unraid_laden {url?}` (Aufgabe) → `{anzahl, zeit, feed_stand, uebersprungen:{plugin, sprache, deprecated, blacklist,
  ohne_repository, fehlerhaft}}`; Zwischenspeicher `<apps>/_katalog/unraid-feed.json` = die ÜBERSETZTEN Vorlagen (`{geladen, quelle, anzahl,
  eintraege}`, ~14 MB, nicht der Rohfeed); Kennungen `unraid-<slug des Namens>`. Eigene Importe liegen unter `<apps>/_katalog/eigen/<id>.json`
  mit Kennung `eigen-<slug>`; `apps.katalog.importieren` gibt die geprüfte Vorlage zurück (`hinweise` = Übersetzungs-Hinweise: PostArgs
  verworfen, unbekannte ExtraParams, Netzwerk-Modus, Voraussetzungen, privilegiert); `apps.katalog.loeschen` nur `eigen-…`.
- **Unraid-Übersetzung** (`src/agent/apps/unraid.js`, XML v2 mit `<Config>` und v1 mit `<Networking>/<Data>/<Environment>`, Feed-Einträge
  mit `Config[].@attributes`): ein Dienst `app`, `container_name: fahnas-<slug>`, `restart` aus `--restart` sonst `unless-stopped`;
  Port-Config → Feld `PORT_<containerport>[_UDP]` (Standard = Host-Port der Vorlage), Path → `PFAD_<ziel>` (Standard `daten/<letzter Teil
  des Ziels>`, `/mnt/…`-Vorgaben werden verworfen; Ziel/Vorgabe `docker.sock` wird fester Mount `/var/run/docker.sock:<ziel>[:ro]` statt
  Feld), Variable → Feld mit dem Variablennamen (Mask=true → `geheimnis`; Default `a|b|c` → `auswahl`; Required → `pflicht`), Device →
  `devices` (leer/`/dev/` → Hinweis), Label → `labels`; `Network` host → `network_mode: host` (keine `ports`, Hinweis), `none` → `network_mode:
  none`, eigene Netze → bridge + Hinweis; `Privileged` true → `privileged: true`; ExtraParams bekannt: `--restart, -e/--env, --cap-add,
  --cap-drop, --device, --sysctl, --shm-size, --hostname/-h, --stop-timeout (→ stop_grace_period), --dns, --user/-u, --read-only, --tmpfs,
  --memory/-m, --cpus, --runtime, --security-opt, --label/-l, --entrypoint, --mac-address, --add-host, --group-add, --init, --privileged,
  --pid=host, --no-healthcheck`; alles andere Hinweis. WebUI `[IP]`→`{HOST}`, `[PORT:x]`→`{PORT_x}` (Feld), sonst Zahl; nur `http(s)://`.
  Kategorie → deutsche Hauptkategorie (Werkzeuge, Produktivität, Medien, Medienserver, Downloads, Sicherung, Cloud, Smart Home,
  Automatisierung, Netzwerk, Sicherheit, Spieleserver, KI, Krypto, Treiber, Entwicklung, Datenbanken, Überwachung, Speicher, Soziales,
  Finanzen, Webseiten, Webserver, Server, System, Sonstiges). Literal-`$` im erzeugten YAML wird als `$$` maskiert.
- `apps.aendern`: `werte` wird über `eingabe` gelegt; leere/fehlende Geheimnisse bleiben aus `.env` erhalten; frühere `bestaetigt_riskant`
  gelten weiter; eigene Ports der App sind kein Konflikt; scheitert `up`, werden alte `compose.yml`/`.env` zurückgeschrieben und die alten
  Container gestartet. Nur `{name, autostart}` ändert ohne Docker-Aufruf. Ergebnis `{name, autostart, neu_gestartet, zustand, gesundheit,
  ports, webui, warnungen}`.
- `apps.aktualisieren` → `{name, alt:{image:digest}, neu, geaendert:[image], neustart, sicherung:<pfad>|null, zustand, gesundheit,
  warnungen, hinweis (Rückweg)}`; Sicherung `<app>/daten.vor-update-<zeit>` per `cp --reflink=auto -a` nur, wenn `du -s -B1 daten` < 5 GiB
  (sonst Warnung), höchstens 2 Stände (ältere werden gelöscht). pull hier OHNE `--ignore-pull-failures` (`E_SYSTEM`); `up -d` nur bei
  geändertem Digest.
- `apps.loeschen` → `{name, daten, aufbewahrt:<pfad>|null, warnungen}`; `behalten` verschiebt den App-Ordner nach
  `<backup>/apps-geloescht/<name>-<zeit>`; `down --volumes` nur bei `daten:"loeschen"` UND benannten Volumes; fehlt `compose.yml`, werden
  die Container des Projekts per `docker rm -f` entfernt. Löschen lässt `E_NICHT_GEFUNDEN` für unbekannte Apps.
- `apps.protokoll {name, zeilen?:200 (1–5000), dienst?, installation?}` → `{name, dienst|null, zeilen:[Text „<dienst>-1  | <zeit> <text>“], dienste, installation_vorhanden}`; mit `installation:true` die letzten Zeilen der manage.sh-Ausgabe (`fahnas-install.log`), `E_NICHT_GEFUNDEN` ohne diese Datei
  (unbekannter Dienst → `E_NICHT_GEFUNDEN`); `apps.ports` → `[{port, protokoll, app}]`; `apps.apply` → `{apps, gerendert:[Namen mit neu
  geschriebenen Dateien], gestartet, fehler:[{name, code, meldung}], warnungen}` (Docker nicht erreichbar → nur Warnung).
- **Firewall** (`src/agent/render/firewall.js`, system.js unverändert): neue Exporte `appPortsLesen(konfigOrdner)` (liest `ports` aus
  `<konfig>/apps/*/app.json`) und `zusatzZusammenfuehren(...listen)`; `rendereFirewall(o, {system, pfad, erzwingen, zusatzPorts?,
  konfigOrdner?})` nimmt OHNE `zusatzPorts` die App-Ports aus dem Spiegel (so überleben sie SSH-Schalter und `system.apply`), MIT
  `zusatzPorts: [{port, protokoll, app}]` genau diese (`[]` = keine); `o.zusatz` (VMs/Fernzugriff) kommt immer dazu; Kern-Ports
  (8443/445/22 tcp, 5353 udp – seit 0.6.17 sind 80/443 App-Ports) und Duplikate fallen weg; Regelkommentar `App <name>`; Ergebnis zusätzlich `zusatz`. apps.js rendert nach
  Installieren/Ändern/Löschen selbst mit allen App-Ports (`ssh` aus `system.json`); Fehler dabei werden `warnungen`, kein Abbruch.
- Sperre je App (`E_BELEGT` „läuft gerade ein anderer Vorgang“) für installieren/steuern/aendern/aktualisieren/loeschen. Rolle `nutzer`:
  `apps.katalog.liste/eintrag`, `apps.liste`, `apps.details`, `apps.protokoll`. App-Name `/^[a-z0-9][a-z0-9-]{1,30}$/`; Vorlagen-Kennung
  `/^[a-z0-9][a-z0-9._-]{0,99}$/`; Feldnamen `/^[A-Z][A-Z0-9_]{0,63}$/` (`HOST` ist in `webui` reserviert, kein Feld).
- Grenzen (Stand 25.09.): `docker compose` ≥ 2.21 (JSON je Zeile) vorausgesetzt (Array-Form wird auch gelesen); Ereignis-/Live-Strom des
  Protokolls nicht vorgesehen (nur tail); kein Sammel-Update aller Apps; Erzeugen zufälliger Geheimnisse (`erzeugen:true`, C2-Vorschlag) nicht
  umgesetzt.
- Nachtrag nach Abgleich mit dem Agenten von A2 (25.09.): `riskant`-Einträge sind `{art, dienst, wert, text}` – die Oberfläche zeigt EINEN
  Schalter je `art` (weitere Texte derselben Art darunter) und schickt die Arten in `bestaetigt_riskant`; `port_konflikte` sind
  `{feld, port, protokoll, belegt_von}` – ohne `vorschlag` schlägt die Oberfläche `port+1` vor; `name_frei:false` blockt das Installieren
  schon im Formular („Name schon vergeben“); `hinweise` der Vorlage erscheinen als Info-Hinweise; `apps.katalog.liste` liefert zusätzlich
  `unraid_geladen` (ISO-Zeit oder `false`), `unraid_anzahl` und `installiert:[{name, katalog_id}]` (Abzeichen „installiert“ auf
  Katalogkarten); `apps.details` liefert `eingabe` (Nutzereingaben, bevorzugt fürs Vorbelegen), `werte` (gerendert) und
  `bestaetigt_riskant` (bleibt bestätigt); `apps.aktualisieren` → `{alt:{image:digest}, neu:{…}, geaendert:[image…], neustart, hinweis}`
  (Meldung „n Images erneuert“ bzw. „schon aktuell“, `hinweis` = Rückweg als zweiter Toast); `apps.protokoll` → `{zeilen, dienste}` –
  bei mehreren Diensten zeigt der Dialog eine Dienst-Auswahl (`dienst` im Parameter); Zustände `fehlt` (keine Container) = gestoppt,
  `teilweise` = orange; Importadresse nur `https://`; Pfad-Felder tragen `nur_lesen:true` statt `modus:"ro"`.

### 11.x Nachtrag 0.2.3/0.2.4 (Mini-PC 25.09.): FAH-Apps bauen, Host-Netz-Ports, NAS-Marken

- **Bauen aus mitgeliefertem Quellcode** (nur eingebaute Vorlagen, Schlüssel `bauen: {release_zip, dienst?}`): `tools/build_release.sh`
  legt den Build-Kontext (nur Dockerfile + COPY/ADD-Quellen des finalen Release-ZIPs) nach `katalog/quellen/<id>/` und
  `<id>.json` (`zip, sha256, version`). Der Katalog setzt `bauen.kontext|quelle|version` und `verfuegbar` (= Quellcode da).
  `apps.installieren`: statt pull `docker build --pull -t <image> --label fahnas.quelle=<sha256> --label fahnas.katalog=<id>
  [--label fahnas.version=…] [--progress plain] <kontext>` – nur, wenn das Image fehlt oder `fahnas.quelle` abweicht; Fortschritt
  aus „#n [i/N]“ bzw. „Step i/N“. `apps.aktualisieren`: Bauvorlage aus dem Katalog (auch für Sätze ohne `vorlage.bauen`), vor der
  Datensicherung geprüft; Image mit `fahnas.katalog`, aber ohne Katalogvorlage → `E_NICHT_GEFUNDEN`. `apps.apply` baut ein
  fehlendes Image vor `up -d`. Ohne Quellcode: `E_NICHT_GEFUNDEN` „Quellcode … fehlt im Programm“.
- **Host-Netz-Ports** (`network_mode: host`): `hostPorts(vorlage, werte)` = Port-Felder im Host-Dienst, Anzeige-Felder (in
  `webui` oder bei reinen Host-Netz-Vorlagen), `host_ports` und fester webui-Port; nie Felder mit Loopback-Bindung
  (`127.0.0.1:${P}:…`, `host_ip`). Sie stehen in `ports` des Satzes (`host: true`, optional `adresse`) und damit in der Firewall.
  Port-Felder: `protokoll` `tcp|udp|tcp+udp`, `adresse_feld` = Text-Feld mit der Lauschadresse. `apps.apply` frischt die
  Vorlagen-Kopie im Satz aus dem Katalog auf (host_ports, Port-Protokolle, bauen) und trägt fehlende Host-Ports nach.
- **Konfliktprüfung je Lauschadresse**: `docker.belegtePortsMitAdressen()` (ss-Adressen, Container = „*“); Konflikt nur bei
  Überlappung (Wildcard oder gleiche Adresse). Eigene Ports einer App werden bei `apps.aendern` nur übersprungen, solange die
  Adresse gleich bleibt.
- **NAS-Marken** in Standardwerten von Text-Feldern: `{NAS_IP}`, `{NAS_GATEWAY}` (aus `ip -4 route get 1.1.1.1`);
  `apps.katalog.eintrag` liefert die eingesetzten Werte, der Installer setzt sie ebenfalls ein (unbekannt → `E_PARAMS`).

### 11.y ZIP-Apps (0.5.0, Betreiber 09.10.: „ZIPs wie unifi-extraktor installierbar, alles stellt sich nach der inkludierten manage.sh ein“)
Release-ZIPs mit eigener `manage.sh` (Regel aller FAH-Apps: ZIP + manage.sh in einen leeren Ordner, `./manage.sh update`).
FAH-NAS baut die Logik nicht nach, sondern führt die mitgelieferte manage.sh aus (`src/agent/apps/zip.js`).
- `apps.zip.ticket {dateiname (.zip), groesse}` admin → `{ticket, kennung}`; Upload über `POST /api/agent-upload?ticket=` in den
  Eingang `<apps>/_eingang/<kennung>.zip` (+ `.json` mit Originalname/Größe; älter als 24 h wird weggeräumt).
- `apps.zip.pruefen {kennung, name?}` admin → `{dateiname, groesse, manage, ordner, compose_datei, compose, dockerfile, riskant,
  warnungen, name_vorschlag, titel_vorschlag, name_frei, installiert_als}`. manage.sh im obersten Ordner oder eine Ebene tiefer,
  sonst `E_PARAMS`. `riskant` enthält IMMER `skript` (manage.sh läuft als root) plus Arten aus der Compose-Datei (privileged,
  network_host, pid_host, cap_add, devices, docker_sock, host_pfade = Bind-Mount außerhalb des App-Ordners).
- `apps.zip.installieren {kennung, name, titel?, autostart, bestaetigt_riskant}` Aufgabe: `<apps>/<name>/` anlegen, ZIP-Inhalt
  hinein entpacken (liegt die manage.sh in einem Projektordner der ZIP, dessen Inhalt – „unzip; cd <ordner>“ wie FunkSichta),
  ZIP mit Originalnamen daneben (selbstentpackende manage.sh suchen sie), `bash manage.sh update` (cwd = App-Ordner, kein Terminal, 3 h, Zeilen als
  Fortschritt und in `fahnas-install.log`), danach Container per Label `com.docker.compose.project.working_dir=<ordner>` →
  Satz `{art:"zip", projekt, compose_dateien, ports (veröffentlicht, ohne 127.0.0.1), dienste, webui (Label `fahnas.webui` eines Containers, sonst aus den Ports), zip:{datei, basis, sha256,
  groesse, eingespielt}}`, Firewall. Fehler: Container des Ordners weg, Protokoll nach `_eingang/<name>-fehler-<zeit>.log`, Ordner
  weg; `details.ausgabe` = letzte 40 Zeilen.
- `apps.zip.aktualisieren {kennung, name, bestaetigt_riskant}` Aufgabe: neue ZIP in den Ordner, `manage.sh update <zip-pfad>` (die App
  ersetzt sich selbst; Daten/.env bleiben), Ports/Firewall neu. Bestätigungen gelten weiter (Vereinigung mit dem Satz). Fehler:
  bisherige Version läuft weiter, die neue ZIP wird aus dem Ordner entfernt.
- Steuern/Protokoll/Löschen/Autostart (`apps.apply`) laufen über `docker compose -p <projekt> --project-directory <ordner>
  -f <compose_dateien…>` ohne `--env-file` (compose liest `.env` im Ordner). `apps.aendern` nur `autostart` (Werte → `E_PARAMS`),
  `apps.aktualisieren` → `E_PARAMS` („neue ZIP einspielen“). `apps.liste` liefert zusätzlich `art` und `zip`.

## 12. Teilprojekt 2b – Externe Laufwerke (Betreiber-Vorgabe 25.09.: „externe Laufwerke in der GUI erkennen und einbinden, NTFS, exFAT etc.“)

Ziel: USB-/SATA-Laufwerke, die nicht zur Systemplatte gehören, erkennen, mit einem Klick einhängen (Dateisysteme ntfs (Kernel
ntfs3, Rückfall ntfs-3g), exfat, vfat, ext2/3/4, btrfs, xfs; hfsplus nur lesend), sicher auswerfen, beim Anstecken automatisch
einhängen (einstellbar), und auf Wunsch als Netzfreigabe anbieten.
Einhängepunkt: `PFADE.shares/<name>` (Name aus Label, sonst `usb-<modell>`; `/^[a-z0-9][a-z0-9_-]{0,31}$/`), damit Dateimanager
und Samba unverändert funktionieren. Einhängeoptionen: `noatime,nofail,x-fahnas`; bei vfat/exfat/ntfs zusätzlich
`uid=root,gid=<fahnas-nutzer-gid>,umask=007` (kein POSIX-ACL möglich), ntfs3 `windows_names`; ext4/btrfs/xfs mit
Verzeichnisrechten wie bei Freigaben (chown root:fahnas-nutzer, 2770) nur auf der Wurzel des Laufwerks.
Freigaben mit `extern:true` in shares.json: KEIN btrfs-Unterlaufwerk, KEINE ACL/Quota/Schnappschüsse, `pfad` = Einhängepunkt,
Samba-Include wie üblich (Rechte lesen/schreiben nur über valid users/write list; ohne ACL gilt umask), `available = no`,
solange nicht eingehängt (Renderer prüft `findmnt`). snapshots-Zeitplan überspringt extern-Freigaben.
Zustand: `PFADE.konfig/laufwerke.json` `{geraete:[{kennung(UUID|PARTUUID|SERIAL+PARTN), name, fs, label, modell, groesse, automatisch:true,
freigabe:true|false, optionen:{nur_lesen}, zuletzt}]}`; `laufwerke.apply` (system, von system.apply nach apps.apply) hängt bekannte,
angeschlossene Geräte mit `automatisch:true` ein und rendert Samba. Überwachung: der Agent startet `udevadm monitor --udev
--subsystem-match=block` (system.starten) und wertet add/remove aus (Rückfall: lsblk alle 15 s), Ereignis `{ereignis:"system",
art:"laufwerk", zustand:"angesteckt|eingehaengt|entfernt", geraet:{…}}`.
Aktionen Bereich `laufwerke`: `laufwerke.liste {}` nutzer → `[{pfad, kennung, name, fs, label, modell, groesse, belegt, frei, eingehaengt,
einhaengepunkt, system:boolean (Teil der Systemplatte → nicht anfassbar), tran(usb|sata|nvme), bekannt, automatisch, freigabe}]`
(lsblk -J -o NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,PARTUUID,MODEL,SERIAL,TRAN,RM,MOUNTPOINT,PKNAME,FSAVAIL,FSUSED + findmnt);
`laufwerke.einhaengen {pfad, name?, nur_lesen?:false, automatisch?:true, freigabe?:false}` admin → Eintrag (mkdir, mount,
laufwerke.json, optional freigaben.anlegen extern); `laufwerke.aushaengen {kennung, vergessen?:false}` admin → `sync`, `umount`
(bei EBUSY: `fuser -vm` → E_BELEGT mit Prozessliste, `smbcontrol close-share` vorher), Freigabe `available = no`, `udisksctl
power-off`/`echo 1 > /sys/block/<x>/device/delete` nur bei `vergessen`; `laufwerke.aendern {kennung, automatisch?, freigabe?,
nur_lesen?}` admin; `laufwerke.formatieren {pfad, fs:"exfat"|"ext4"|"btrfs"|"ntfs", label}` admin, Aufgabe, nur nicht
eingehängte Nicht-System-Geräte, Namen tippen (mkfs.exfat/mkfs.ext4/mkfs.btrfs/mkntfs -f); `laufwerke.smart {pfad}` admin
(wie system.smart für ein Gerät); `laufwerke.apply {}` system.
Pakete (user-data + erststart PAKETE gleich halten): `ntfs-3g exfatprogs dosfstools e2fsprogs xfsprogs hfsprogs udisks2`
(hfsprogs universe; xfsprogs/e2fsprogs meist schon da).
Oberfläche: Ansicht `laufwerke` (rolle nutzer, reihenfolge 35; Aktionen admin): Karten je Gerät (Symbol nach tran, Modell,
Größe/Belegung, Dateisystem, Zustand), Knöpfe Einhängen (Dialog: Name, nur lesen, automatisch, als Freigabe), Auswerfen,
Formatieren (Warnung, Namen tippen), S.M.A.R.T.; Systemplatte grau mit Hinweis; Live über Ereignis `laufwerk`.
Sprache `public/sprache/de/laufwerke.json`. Dashboard: Kachel „Laufwerke“ (Anzahl eingehängt) in dashboard.js (Teil B2).

### Ergänzung 19.10.2026 (0.22.0): Avatare (Profilbilder)
Betreiber: „möglichkeit ein avatar/bild zu hinterlegen was dann als userbild überall angezeigt wird“.
- `nutzer.avatare` nutzer `{}` → `{<name>: v}` (nur Nutzer mit Bild; v = 12 Hex aus SHA-256 des Bildes).
- `nutzer.avatar.lesen` nutzer `{name}` → `{mime, v, daten(base64)}`; ohne Bild `E_NICHT_GEFUNDEN`.
- `nutzer.avatar.setzen` nutzer (eigenes Konto; Admin alle) `{name, daten(base64)}` → `{v}`; nur PNG, JPEG oder WebP (an den
  ersten Bytes erkannt, nie SVG), höchstens 300 KB. `nutzer.avatar.loeschen` nutzer (eigenes; Admin alle) `{name}` → `{name}`.
- Ablage `config/avatare/<name>` (0640, Zwischendatei + Umbenennen), in users.json nur `nutzer[].avatar = {v, mime}`;
  `nutzer.liste` liefert `avatar: v|null`. Jede Änderung meldet `konfig`/`nutzer`. `nutzer.loeschen` nimmt das Bild mit;
  Export enthält den Ordner, der Import übernimmt ihn (`IMPORT_ORDNER`).
- Web: `GET /api/avatar/:name?v=` (Sitzung voll – Chat-Gäste nie) → Bild; passt `v`, `Cache-Control: private, max-age=31536000,
  immutable`, sonst `private, no-cache`; `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`.
- Anrufe: Teilnehmer im Stand tragen für Mitglieder als Empfänger `nutzer` (Login) – fürs Bild der Kachel; Gäste bekommen ihn nie.
- Oberfläche: `public/avatar.js` (ohne app.js, auch auf der Gastseite): `avatarKnoten({name, anzeige, groesse, farbe, titel})` → Bild
  oder Anfangsbuchstabe auf fester Farbe je Person, `avatareSetzen` tauscht alle sichtbaren (data-avatar), Ladefehler → Buchstabe;
  `bildVorbereiten(datei)` schneidet im Browser quadratisch aus der Mitte auf 256 px (WebP, sonst PNG). Hochladen in „Nutzer“ →
  „Mein Konto“ und (Admin) im Bearbeiten-Dialog. Angezeigt in Kopfzeile, Nutzerliste, Chat (Nachrichten, DMs, Mitglieder,
  Personenwahl), Anrufkacheln, Office (Anwesende, Freigeben, Board-Zuständige) und der Übersichts-Kachel `profil` [3, 4].

### Ergänzung 25.09. (Koordinator): persönliche Einstellungen
- `nutzer.einstellungen.lesen` nutzer (eigenes Konto; Admin alle) `{name, bereich:/^[a-z][a-z0-9_-]{0,31}$/}` → `{bereich, wert|null}`
- `nutzer.einstellungen.setzen` nutzer `{name, bereich, wert?:object}` → `{bereich, wert|null}`; ohne `wert` wird der Bereich gelöscht; max. 32 KB je Bereich.
  Ablage `users.json` → `nutzer[].einstellungen[bereich]`; `nutzer.liste` liefert sie nicht mit. Verwendung: Übersichts-Kacheln (Bereich `uebersicht`).
- Bereich `uebersicht` (Stand 0.6.0, Rasterplatzierung): `{version:4, kacheln:[{id, x:0–11, y:≥0, b:2–12, h:2–40}], ausgeblendet:[id]}`
  in Zellen eines 12-Spalten-Rasters mit 40-px-Zeilen (`public/ansichten/dashboard-raster.js`). Lücken bleiben; Überlappungen werden
  beim Lesen aufgelöst (spätere rutschen nach unten). v3 (`breite` 1–4 von 4 Spalten, `hoehe_px`) wird zeilenweise umgerechnet
  (Breite × 3, Höhe → ⌈(px + 16) / 56⌉ Zeilen), ältere Formen bekommen die Standardhöhe; gespeichert wird immer v4. Kacheln, die
  das Layout nicht kennt, kommen unten dazu.
- Bereich `favoriten` (seit 0.31.0, Betreiber 13.11.2026): `{liste:[{freigabe, pfad}]}` – Ordner-Favoriten je Nutzer, höchstens
  50, `pfad` relativ zur Freigabe ("" = Freigabe-Wurzel). Nur Oberfläche (`public/favoriten.js`, liest vor jedem Umschalten frisch):
  Stern neben den Brotkrumen und „Zu Favoriten“ im Ordnermenü (Dateien), Eintrag „Favoriten“ direkt unter „Dateien“ in der
  Navigation (aufklappbar, beim Laden immer eingeklappt; Handy: nur im aufgeklappten Daten-Menü), Übersicht-Kachel `favoriten`.

Präzisierungen Oberfläche (Teil B2, 25.09., `public/ansichten/laufwerke.js`; Formen tolerant gelesen, Empfehlung für D2 in Klammern):
- `laufwerke.liste` als Array oder `{geraete|laufwerke:[…]}`; je Gerät liest die Oberfläche `nur_lesen` aus `optionen.nur_lesen` oder
  `nur_lesen`; Belegung aus `belegt`/`frei` (gesamt = belegt + frei, Rückfall `groesse`); `tran` `usb|sata|ata|nvme` → Symbol;
  `system:true` → gedämpfte Karte ohne Knöpfe im Abschnitt „Systemplatte“; ohne `fs` → „Einhängen“ gesperrt, „Formatieren“ erlaubt;
  Sortierung: externe (eingehängte zuerst) vor System. `bekannt:true` + nicht eingehängt → Knopf „Vergessen“ = `laufwerke.aushaengen
  {kennung, vergessen:true}`; eingehängt + bekannt → „Einstellungen“ = `laufwerke.aendern {kennung, automatisch, freigabe, nur_lesen}`.
- `laufwerke.einhaengen` bekommt immer alle Felder: `{pfad, name, nur_lesen, automatisch, freigabe}` (boolean, nie undefined). Name
  vorbelegt aus `label` (klein, Umlaute umgeschrieben, Muster), sonst `usb-<modell>`, bei bekannten Geräten `name`; `hfsplus|hfs` erzwingt
  `nur_lesen:true` (Schalter gesperrt). Hinweistext ohne Rechteverwaltung bei `vfat|exfat|ntfs`.
- `laufwerke.aushaengen {kennung, vergessen}`: `kennung` = `kennung` des Geräts (Rückfall `uuid`, `partuuid`, `pfad`). Bei `E_BELEGT`
  zeigt die Oberfläche `details.prozesse:[{pid, befehl, nutzer}]` (Empfehlung) oder parst `details.ausgabe` (Format `fuser -vm`); der
  Dialog bleibt offen für einen zweiten Versuch. Sofortige Fehler wie `E_BELEGT` müssen für Admins die `details` behalten (§2-Filter).
- `laufwerke.formatieren {pfad, fs:"exfat"|"ext4"|"btrfs"|"ntfs", label}` (Aufgabe): Label aus `[A-Za-z0-9 _-]`, höchstens 11 (exfat) /
  16 (ext4) / 64 (btrfs) / 32 (ntfs) Zeichen, darf leer sein; Tipp-Bestätigung = Basisname (`sdd`) oder voller Gerätepfad.
- `laufwerke.smart {pfad}` → Objekt oder Liste mit einem Objekt `{geraet, modell, temperatur, zustand:"ok"|"warnung"|"fehler", stunden,
  details:{…, hinweis?}}` (`details.hinweis` wird als Hinweis gezeigt, z. B. „USB-Gehäuse reicht S.M.A.R.T. nicht durch“).
- Live: Ereignis `system` mit `art:"laufwerk"`, `zustand:"angesteckt"|"eingehaengt"|"entfernt"`, `geraet:{…}` (roh oder unter `daten`)
  → Toast „Laufwerk angesteckt/eingehängt/entfernt: <label|name|modell>“ und Neuladen (400 ms gebündelt); außerdem `konfig` mit
  `bereich:"laufwerke"|"freigaben"`. Knopf „Neu einlesen“ ruft `laufwerke.liste` erneut.
- Sprache: `public/sprache/de/laufwerke.json` enthält den Menüschlüssel `navigation.laufwerke` (bei Aufnahme in `gemeinsam.json` dort
  entfernen). `public/symbole.svg` (Teil E) hat noch kein `symbol-laufwerke` – der Navigationspunkt erscheint bis dahin ohne Symbol; die
  Ansicht selbst bringt eigene Strichsymbole (USB/SATA/NVMe) mit. Dashboard-Kachel „Laufwerke“: „<n> eingehängt“ + „<m> externe
  Laufwerke erkannt“ (extern = `system` falsch), Neuladen bei `konfig` laufwerke/freigaben, `system`/laufwerk und alle 30 s.

### §12 Präzisierungen 25.09. (Teil D2, Agent-Seite)

- **Kennung** trägt eine Vorsilbe je Quelle: `uuid:<UUID>`, sonst `partuuid:<PARTUUID>`, sonst `serial:<SERIAL>:<PARTN>`
  (ganze Platte ohne Partitionsnummer → `:0`). Geräte ohne stabile Kennung lassen sich nicht einhängen (`E_SYSTEM`).
- **`lsblk`** wird mit `-b` (Byte-Zahlen statt „40G“) und zusätzlich `RO,PARTN` aufgerufen; `groesse/belegt/frei` sind Byte-Zahlen
  oder `null`. Je nutzbarem Dateisystem (Partition; sonst ganze Platte) entsteht ein Eintrag; unbekannte Dateisysteme erscheinen mit
  `fs:null` (nur formatierbar). `loop/zram/sr/ram/fd` werden übersprungen – außer mit `FAHNAS_LAUFWERKE_TEST_LOOPS=1` (Integrationstest:
  Loop-Images gelten dann als externe Platten, squashfs ausgenommen).
- **Systemplatte** = Platte, auf der ein Gerät ein `FAHNAS-*`-Label ODER einen der System-Einhängepunkte trägt (`/`, `/boot`,
  `/boot/efi`, `/var`, `/var/log`, `/.snapshots`, `/data`, `/usr`, `/home`, `[SWAP]`) – **genaue** Übereinstimmung, kein Präfix, damit
  externe Laufwerke unter `/data/shares/<name>` nicht fälschlich als System gelten.
- **`freigaben.anlegen`** nimmt zusätzlich `extern?:boolean` und `pfad?:string` (nur mit `extern`; muss der Einhängepunkt
  `PFADE.shares/<name>` sein und dort muss etwas hängen, sonst `E_BELEGT`/`E_PARAMS`). Extern → kein Unterlaufwerk/ACL/Quota; der Papierkorb `.papierkorb` in der Wurzel gilt für das ganze Laufwerk und läuft nach 30 Tagen ab (seit 0.27.0);
  `freigaben.loeschen` einer externen Freigabe fasst das Dateisystem NICHT an (kein Verschieben/Löschen). `freigaben.liste` liefert je
  Eintrag zusätzlich `extern:boolean` und – bei extern – `eingehaengt:boolean`, `belegt` und `kapazitaet` (Bytes, seit 0.4.3 aus
  `df -B1 --output=size,avail` des Einhängepunkts, Zeitlimit 5 s; nicht eingehängt oder df gescheitert → beide `null`).
- **Übersicht** (seit 0.5.0, Betreiber 09.10.: je eine Karte): Kachel `laufwerke` = „Externe Laufwerke“ mit einer Zeile je
  eingehängtem externem Laufwerk aus `laufwerke.liste` (Belegt % = belegt / (belegt + frei), alle 30 s und bei Ereignissen neu);
  Kachel `platte` = „Interne Festplatte“ (Gesamt + Zeilen System `/` und Daten `/data`) ersetzt `systemplatte`/`datenplatte` –
  gespeicherte Layouts übernehmen Platz und Größe der ersten der beiden (`layoutMigrieren`).
- **Samba-Renderer** setzt `available = no` für eine externe Freigabe, solange `findmnt` unter dem Einhängepunkt nichts findet
  (`samba.eingehaengt`); die Rechte/`valid users` bleiben dabei erhalten.
- **`laufwerke.aushaengen`**: `E_BELEGT` trägt `details.prozesse` (Ausgabe von `fuser -vm`). `laufwerke.formatieren` verlangt zusätzlich
  `bestaetigung` (muss dem `pfad` gleichen; getippt in der Oberfläche) und nur `fs ∈ exfat|ext4|btrfs|ntfs`.
- **Überwachung**: `laufwerke.apply` (Rolle system) hängt bekannte Geräte ein, rendert danach Samba (`freigaben.apply`) und startet
  `udevadm monitor` + einen 15-s-Abgleich; `FAHNAS_UEBERWACHUNG=0` unterdrückt den Start (Tests). Ereignis
  `{ereignis:"system", art:"laufwerk", zustand:"angesteckt|eingehaengt|entfernt", geraet:{…}}`.
- **snapshots**: externe Freigaben werden im Zeitplan (`zeitplanTick`) übersprungen und `snapshots.liste {ziel:<extern>}` liefert `[]`.
- Nachtrag nach Abgleich mit dem Agenten von D2 (25.09.): `laufwerke.formatieren` verlangt zusätzlich `bestaetigung` (= `pfad`, die Oberfläche
  schickt den Gerätepfad, nachdem der Nutzer Basisname oder Pfad getippt hat) und ein Pflicht-`label` (`/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/`;
  die Oberfläche begrenzt zusätzlich exfat 11, ext4 16, btrfs/ntfs 32 Zeichen); `E_BELEGT` beim Auswerfen trägt `details.prozesse` als TEXT
  (Ausgabe von `fuser -vm`) – die Oberfläche parst ihn zu PID/Befehl/Nutzer; vergebener Name beim Einhängen → `E_EXISTIERT` (Feld `name`);
  udev meldet je Platte und Partition (`geraet:{name:"sdb1"}`) – gleiche Toasts innerhalb von 2 s werden nur einmal gezeigt;
  `laufwerke.liste` liefert `name` nur für bekannte Geräte (sonst `null`), `nur_lesen` auf oberster Ebene.

## 13. Weltkarte „Verbindungen“ (Betreiber-Auftrag 26.09., Entwurf docs/superpowers/specs/2026-09-26-weltkarte-design.md)

Ziel: Übersichtskachel „Weltkarte“ (nur Admins) mit Umschalter **Eingehend | Ausgehend** – wohin der NAS, seine Apps und VMs
Verbindungen aufbauen bzw. wer ihn anspricht. Verbindungsdaten nur im Arbeitsspeicher (Fenster 1 h), nie auf Platte, nie im
Prüfprotokoll; Orte werden lokal aufgelöst (DB-IP Lite), keine IP verlässt den NAS. Verbindlich sind die Verträge in Entwurf §4;
hier die Kurzform.

**Agent, Bereich `netz`** (`src/agent/aktionen/netz.js`, neu in `BEREICHE`; exportiert zusätzlich `starten(werkzeuge)`/`stoppen()`,
die agent.js nach dem Registrieren bzw. beim Beenden aufruft – Geo und Sammler starten mit dem Agenten):
- `netz.verbindungen` admin, `lesend:true`, `{richtung:"ein"|"aus"}` (Pflicht) →
  `{richtung, zeit:ISO, fenster_s:3600, aufzeichnung:boolean, werkzeug:{ok, hinweis|null, gekuerzt?:true}, geo:{quelle:"stadt"|"land"|"keine", stand:"JJJJ-MM"|null, hinweis|null},
  heimat:{lat, lon, name}|null, summe:{anzahl, bytes, gegenstellen}, gegenstellen:[{ip, privat, anycast, ort:Ort|null, anzahl, bytes, erst, zuletzt,
  lokal:[{name, art:"host"|"app"|"vm"|"dienst", anzahl}]}] (≤ 500, nach zuletzt absteigend), lokal:[{name, art, anzahl, bytes}]}`.
  `aufzeichnung:false` → alle Listen leer. `bytes` = 0, solange `nf_conntrack_acct` gerade erst eingeschaltet wurde. Aus = Absender
  (`FAH-NAS`, App-Name, `VM`), ein = Dienste (`SSH`, `Web`, `SMB`, `mDNS`, `AFP`, App mit diesem Host-Port, sonst `Port N`).
- `Ort = {land:"DE", land_name:"Deutschland", stadt:"…"|null, lat, lon, genau:"stadt"|"land"}`. Private Gegenstellen (10/8, 172.16/12,
  192.168/16, 100.64/10, 127/8, 169.254/16, Multicast, fc00::/7, fe80::/10) und Anycast-Resolver (fester Katalog,
  `src/agent/helfer/netzadressen.js`) bekommen keinen Ort; die Karte bündelt private am Standort („Heimnetz“).
- **Register-Flag `lesend:true`**: erfolgreiche Aufrufe landen nicht im Prüfprotokoll (fehlgeschlagene schon). Gilt für
  `netz.verbindungen` und `system.protokoll` (beide fragt die Übersicht regelmäßig ab).
- Quelle: `conntrack -L [-f ipv6] -o extended` alle 10 s (Paket `conntrack`, bei Bedarf einmal je Agent-Start nachinstalliert;
  `net.netfilter.nf_conntrack_acct=1` über `/etc/sysctl.d/60-fahnas-conntrack.conf`); `[UNREPLIED]` wird verworfen. Grenzen 20 000
  Tupel, 5 000 Gegenstellen.

**`system.json`** (STANDARD, `system.setzen {aenderungen:{…}}`):
`standort:{lat:null, lon:null, name:""}` (lat −90…90, lon −180…180, beide Zahl oder beide null, name ≤ 64 ohne Steuerzeichen; wird komplett
ersetzt), `verbindungen:{aufzeichnen:true}`, `geo:{stadt_laden:true}` (beide flach gemischt), `vertraute_proxys:[IP|CIDR]` (≤ 50, gab es
schon – jetzt mit Feld in der Oberfläche). Wirkt ohne Neustart.

**Ortsdaten** (DB-IP Lite, CC BY 4.0): mitgeliefert `<programm>/geo/dbip-country-lite.mmdb` (beim Release-Bau von `tools/geo_holen.mjs`
geladen, nicht im Git) und `geo/laender.json` (Landesmitten + deutsche Namen, im Git) – `PFADE.geoMit` (`FAHNAS_GEO_MIT`). Monatlich
geladen (wenn `geo.stadt_laden`): `https://download.db-ip.com/free/dbip-city-lite-JJJJ-MM.mmdb.gz` (404 → Vormonat) nach `PFADE.geo`
= `/data/geo` (`FAHNAS_GEO`, außerhalb von `/data/config`, kein Export) als `dbip-city-lite.mmdb` + `stand.json {monat, geladen, bytes}`;
gestreamt entpackt in eine Temp-Datei, geprüft, atomar umbenannt; Prüfung beim Start und alle 6 h, nach Fehler frühestens nach 1 h
erneut. Eigener MMDB-Leser `src/agent/helfer/mmdb.js` (ohne Pakete), Verwaltung `src/agent/helfer/geo.js`.

**Kartendaten**: `public/karte/welt.json` `{v:1, quelle, q:100, laender:[{iso, name, p:[lon·q, lat·q], r:[[x0, y0, dx1, dy1, …], …]}]}`
(Natural Earth 1:50m, gemeinfrei, ohne Antarktis, ≤ 400 KB; erzeugt von `tools/karte_bauen.mjs`, im Git).
Namensnennung sichtbar im Fuß der Kachel: „IP-Geolokalisierung: DB-IP.com (CC BY 4.0) · Karte: Natural Earth“, außerdem `LICENSE-HINWEIS.md`.

**Oberfläche**:
- Karten-Modul `public/ansichten/weltkarte.js` (keine Ansicht): `projektion(lon, lat) → [x, y]` (Natural Earth I), `dekodiereWelt(json)`,
  `erzeugeWeltkarte(behaelter, {t, bewegungReduziert, holeWelt}) → {setzeDaten(ergebnis, {filter, laedt}), setzeFilter(name|null), groesse(),
  pausieren(bool), zerstoeren()}`; zeigt selbst die Hinweise „kein Standort“, „Aufzeichnung aus“ und `werkzeug.hinweis` (`.wk-hinweis`;
  bei `ok:false` als Warnung, bei `ok:true` – Teilausfall oder `gekuerzt` – als Info).
  `holeWelt` optional (Standard: `public/karte/welt.json` einmal je Seite, nach Fehler neu). `laedt:true` = Platzhalter beim Umschalten
  (Karte leer, abgedunkelt, `aria-busy`, keine Hinweise daraus, nächste Daten ohne Flüge). Ticker `role=log`, `aria-live=off` (rein
  visuell, die Listen tragen dieselbe Information). Tastatur: Fläche fokussierbar, Pfeile verschieben, + − zoomen, 0 = ganze Welt;
  Knopf/Taste zoomen um den Standort, solange er im Bild ist. Tooltip höchstens so hoch wie die Fläche, schmal (< 480 px) 2 IPs.
- Kachel `weltkarte` in `public/ansichten/dashboard.js`, nur für Admins, Standard `data-breite="4"`, Höhe automatisch (`standardKacheln`
  liest `data-breite`, sonst wie bisher). Lädt `weltkarte.js` erst beim Aufbau per `import()`. Kopf: Umschalter (zwei Knöpfe mit
  `aria-pressed`); Inhalt: Karte + zwei Listen (Ziele bzw. Quellen: Flagge, Ort, IP, Anzahl, Datenmenge; Absender bzw. Dienste mit
  Klick-Filter → `setzeFilter`); breit (Container ≥ 720 px, CSS setzt `--wk-gebunden: 1` an `.dashboard-wk-seite`) Karte : Listen = 3 : 1,
  Seitenleiste `.gebunden` (`contain: size`, so hoch wie die Karte), Zeilen, die nicht hineinpassen, bekommen `.dashboard-wk-weg`
  (höchstens 60 vorbereitet), Knopf „+N weitere · alle zeigen“ hebt die Bindung auf; schmal je 10 Einträge + „alle zeigen“;
  Neu-Einpassen per ResizeObserver (Karte und Inhalt, einmal je Bild); Fuß: Stand, Ortsdaten-Quelle, Namensnennung; Hinweise der Kachel:
  Abfragefehler, Karten-Modul fehlt, „eingehend nur Heimnetz“. Abfrage `netz.verbindungen` alle 5 s nur bei sichtbarer Kachel
  (IntersectionObserver, nicht ausgeblendet) und sichtbarem Tab, sofort beim Umschalten und beim Sichtbarwerden; läuft für dieselbe
  Richtung schon eine Abfrage, kommt keine zweite dazu; nur die Antwort der jüngsten Abfrage zählt (schnelles Umschalten). Beim
  Umschalten sofort `setzeDaten({richtung, heimat, gegenstellen:[]}, {filter:null, laedt:true})`. Listen nur bei echter Änderung neu
  (Knoten je IP/Name, Fokus bleibt). Die Karte füllt zusätzliche Kachelhöhe (SVG `meet`, ohne Zusatz bisheriges Seitenverhältnis, höchstens 72vh).
- Richtung je Nutzer: `nutzer.einstellungen` Bereich `weltkarte`, Wert `{richtung:"ein"|"aus"}` (Standard `aus`).
- System → Karte „Standort und Verbindungen“ (`public/ansichten/system.js`): Breitengrad, Längengrad (Komma oder Punkt), Ortsname,
  Schalter „Verbindungen aufzeichnen“, Schalter „Ortsdaten monatlich laden (DB-IP City Lite, ca. 60 MB)“ mit aktuellem Stand (aus
  `netz.verbindungen` → `geo`), „Vertraute Proxys“ (eine Adresse/ein Netz je Zeile) – jede mit Erklärtext. Speichern schickt
  `system.setzen {aenderungen:{standort, verbindungen:{aufzeichnen}, geo:{stadt_laden}, vertraute_proxys}}`; Feldfehler (Breite außerhalb
  −90…90, nur eine Koordinate, Name > 64, ungültiger Proxy, > 50 Proxys) verhindern den Aufruf.

## 14. Spiegelung (0.7.0, Betreiber 11.10.2026, Entwurf docs/superpowers/specs/2026-10-11-spiegelung-design.md)

Ordner zweier Freigaben (auch externe Laufwerke) automatisch abgleichen: **einseitig** (rsync, Ziel = Kopie der Quelle)
oder **beidseitig** (unison, bei Konflikt gewinnt die neuere Fassung, die andere bleibt als `… (conflict_on_<datum>)`).
Gelöschtes/Überschriebenes landet in `<ziel>/.fah-papierkorb/<JJJJ-MM-TT_HHMMSS>/` und wird nach 30 Tagen gelöscht
(`.fah-papierkorb` selbst bleibt stehen; der Wächter filtert eigene Pfade selbst – inotifywaits --exclude ließ das Anlegen durch).
Ziel auf exFAT/FAT/NTFS → rsync `-rt --modify-window=2` (ohne Besitzer/Rechte/Verknüpfungen), sonst `-aH --numeric-ids`;
unison mit `-fat`, Archiv je Spiegelung in `/data/config/spiegelung/unison/<id>` (verworfen beim Löschen und wenn sich
Quelle/Ziel/Richtung ändern – ein Archiv je Ordnerpaar erzeugte im Praxistest falsche „was_deleted“-Konflikte). Fehlende Werkzeuge installiert der Agent per apt nach.

- Konfiguration `spiegelung.json` `{version:1, auftraege:[{id:"s-…", name, aktiv, quelle:{freigabe,pfad}, ziel:{freigabe,pfad},
  richtung:"einseitig"|"beidseitig", ausloeser:"zeitplan"|"aenderung"|"hand", tage:[0–6, 0 = So], zeiten:["HH:MM"],
  wartezeit_min:1–1440, erstellt, geaendert}]}`; `spiegelung-zustand.json` je id `{letzter, bedient_bis, ausstehend}`;
  `spiegelung-verlauf.json` je id die letzten 20 Läufe `{beginn, ende, dauer_ms, anlass, ergebnis, meldung, zahlen, protokoll[]}`.
- Aktionen (alle admin): `spiegelung.liste {}` (lesend) → `{auftraege:[…auftrag, zustand:{laeuft, fortschritt, meldung,
  beginn, letzter, ausstehend, naechster, waechter}], werkzeuge:{rsync, unison}}` · `spiegelung.speichern {id?, name, aktiv,
  quelle, ziel, richtung, ausloeser, tage, zeiten, wartezeit_min}` → Auftrag · `spiegelung.loeschen {id}` (Ordner bleiben;
  `E_BELEGT` während eines Laufs) · `spiegelung.starten {id}` → `{gestartet}` bzw. `{gestartet:false, nochmal:true}`
  (läuft schon – danach noch einmal) · `spiegelung.abbrechen {id}` · `spiegelung.vorschau {id}` (Aufgabe, nur einseitig,
  `rsync --dry-run --itemize-changes`) → `{zahlen, vorschau:{neu, geaendert, geloescht, ordner_neu, zeilen[≤300]}}` ·
  `spiegelung.verlauf {id}` (lesend) → `{laeufe}`.
- `ergebnis`: ok · warnung (rsync 23/24, unison 1/2) · fehler · uebersprungen (Laufwerk fehlt → `ausstehend`, der Planer
  holt den Lauf nach, sobald es eingehängt ist; nie ins leere Einhängeverzeichnis schreiben) · abgebrochen.
- Schutz: Quelle und Ziel nicht gleich/ineinander; einseitig mit leerer Quelle und vollem Ziel → Abbruch; unison bricht
  bei komplett geleerter Seite selbst ab (confirmbigdel). Je Spiegelung höchstens ein Lauf; Läufe laufen NICHT in der
  Aufgaben-Warteschlange (nur die Vorschau).
- Auslöser: Planer-Takt 30 s (fälliger Zeitpunkt jünger als `bedient_bis`, verpasste höchstens 24 h alt einmal nachholen;
  Speichern setzt `bedient_bis` = jetzt). „aenderung“: `inotifywait -m -r` je Spiegelung (beidseitig: beide Seiten),
  Lauf nach `wartezeit_min` Ruhe, keine Änderung wird verworfen (während eines Laufs → danach noch einmal; beidseitig
  höchstens ein zusätzlicher leerer Lauf durch die eigenen Schreibvorgänge), Neustart des Wächters nach 60 s; nach dem Start des Agenten läuft jede „aenderung“-Spiegelung einmal nach der Wartezeit.
- Ereignisse: `{ereignis:"spiegelung", id, zustand:"laeuft", fortschritt, meldung}` (höchstens 1/s) und
  `{…, zustand:"fertig", ergebnis, meldung}` (nur admin); `konfig` Bereich `spiegelung` nach Speichern/Löschen.
- Oberfläche: Ansicht `spiegelung` (admin, Reihenfolge 55, Symbol `spiegelung`); Dashboard-Kachel `spiegelung` (admin,
  Standard 3×5) mit Anzahl, Zustand und einer Zeile je Spiegelung.

### Ergänzung 12.10.2026 (0.7.4): System-Freigabe „docker“ auch im Dateimanager, Protokoll aufklappbar
- `freigaben.liste {mit_system?:boolean}` – nur der Dateimanager fragt mit `mit_system:true`; für Admins kommt dann bei
  eingeschaltetem `system.json docker_freigabe` zusätzlich `{name:"docker", pfad:"/data/apps", system:true, papierkorb:false, …}`.
  Freigaben-Verwaltung, Spiegelung und Schnappschüsse sehen sie nicht.
- Alle `dateien.*`-Aktionen nehmen `freigabe:"docker"` (nur Admins, sonst E_NICHT_GEFUNDEN). Dort läuft der Dateihelfer als root
  (`idsFuer`), wie Samba mit `force user = root`. Kein Papierkorb (Löschen ist endgültig), `dateien.link.anlegen` → E_RECHTE.
- System-Ansicht: Karte „Protokoll“ ist zugeklappt (`details`) und lädt `system.protokoll` erst beim ersten Öffnen.

### Ergänzung 12.10.2026 (0.8.0): Spiegelung mit anderen NAS (SMB)
- Seite `{zugang?:"z-…", freigabe, pfad}`; mit `zugang` liegt sie auf einem anderen NAS (Freigabename dort 1–80 Zeichen, auch
  mit Leerzeichen). Verbindungen in `spiegelung-zugaenge.json` (0600) `{zugaenge:[{id, name, adresse, benutzer, passwort, …}]}`.
- Aktionen (admin):
  - `spiegelung.zugaenge {}` → `[{id, name, adresse, benutzer, passwort_gesetzt, benutzt}]`.
  - `spiegelung.zugang.speichern {id?, name, adresse, benutzer, passwort?}`; leeres Passwort beim Ändern heißt unverändert.
    Ändert sich die Adresse, werden die unison-Archive der betroffenen Spiegelungen verworfen.
  - `spiegelung.zugang.loeschen {id}` → `E_BELEGT`, solange eine Spiegelung die Verbindung nutzt.
  - `spiegelung.zugang.pruefen {id}` → `{freigaben:[{name, kommentar}]}` (smbclient -L -g -A).
  - `spiegelung.zugang.ordner {zugang, freigabe, pfad}` (lesend) → `{pfad, ordner[]}` (kurz nur lesend eingehängt).
  - `spiegelung.liste` liefert zusätzlich `zugaenge:[{id, name, adresse}]` für die Anzeige.
- Ablauf eines Laufs:
  - Fremde Seiten werden nach `/run/fahnas/spiegelung/<id>-q|z` eingehängt (`mount -t cifs`, Zugangsdaten per `credentials=`
    aus einer 0600-Datei, die sofort wieder gelöscht wird) und im finally wieder ausgehängt.
  - Dateisystem `cifs` gilt als einfach (rsync `-rt`, unison `-fat`).
  - Nicht erreichbar → „übersprungen“; der Planer prüft per TCP 445 und holt den Lauf nach.
  - Falsche Anmeldung → E_RECHTE, fehlende Freigabe → E_NICHT_GEFUNDEN.
- Regeln:
  - Der Wächter beobachtet nur Seiten auf diesem NAS.
  - „aenderung“ ist nicht erlaubt bei einseitig mit fremder Quelle und bei beidseitig mit zwei fremden Seiten.
  - Der Papierkorb eines fremden Ziels wird am Ende jedes Laufs aufgeräumt.
- Pakete `cifs-utils` und `smbclient` installiert der Agent bei Bedarf nach, im ISO sind sie schon dabei.

### Ergänzung 09.11.2026 (0.29.0): Sicherung oder Spiegelung, neuer Ordner in der Ordnerwahl
Betreiber: „man müsste besser sehen, was eine Spiegelung und was eine Sicherung ist … am Zielordner neue Ordner erstellen können“.
- Auftrag `art: "sicherung" | "spiegelung"`. Eine Sicherung ist immer `einseitig` (sonst `E_PARAMS` feld `richtung`).
  Fehlt das Feld: gespeicherte Art bleibt beim Bearbeiten; ältere Aufträge ohne Feld sind nur dann eine Sicherung, wenn
  sie wie beim Assistenten einseitig nach `FAH-NAS/…` kopieren, sonst eine Spiegelung (`artVon`, 0.29.1 – Betreiber:
  „die meisten sind doch Spiegelungen“). `spiegelung.liste` liefert `art` immer mit. Der Assistent „Sicherung einrichten“
  setzt `sicherung`, „Neue Spiegelung“ startet mit `spiegelung` (im Dialog umstellbar, bei Sicherung ist die Richtung ausgeblendet).
- Oberfläche: Seite „Sicherung & Spiegelung“ mit zwei Abschnitten, Karten mit farbigem Rand, Plakette (Schild `symbol-sicherung`
  bzw. Doppelpfeil `symbol-spiegelung`) und „Einseitig/Beidseitig“ klein daneben. Dashboard-Kachel zählt je Art.
- `spiegelung.zugang.ordner.anlegen {zugang, freigabe, pfad, name}` (admin) → `{pfad}`: neuer Ordner auf einem anderen NAS
  (kurz beschreibbar eingehängt, `E_EXISTIERT` wenn vorhanden) oder in der Cloud (`rclone mkdir`; bei S3/B2 entsteht er erst
  beim ersten Lauf). Name: keine `/ \ : * ? " < > |`, kein Punkt vorn oder hinten, höchstens 255 Byte. Auf diesem NAS nimmt die
  Ordnerwahl `dateien.ordner`.

### Ergänzung 12.10.2026 (0.9.0): App-Editor wie bei Unraid, ZIP ohne manage.sh
- `apps.einstellungen {name}` (admin, lesend) → `{dienste:[{name, image, netz_host, ports:[{host, container, protokoll, adresse}],
  pfade:[{art:"ordner"|"volume", host, container, nur_lesen}], variablen:[{name, wert, geheim}]}], original, angepasst, laeuft,
  zustand, autostart, portkonflikt}`. Grundlage ist `docker compose config --format json`; geheime Werte (pass/secret/token/key …)
  sind leer.
- `apps.einstellungen.speichern {name, dienste, autostart?, neustart?}` (Aufgabe) schreibt `<app>/fahnas.anpassung.yml` (0600) mit
  `ports/volumes/environment: !override`.
  - Prüfung: Ports 1–65535, keine Doppelten, Konflikte → E_BELEGT mit Vorschlag. Neue NAS-Ordner nur im App-Ordner oder
    unter /data/shares, unveränderte Einhängungen bleiben erlaubt.
  - Ein leeres Geheimnis bleibt unverändert. Port-Felder der Vorlage und der Link werden der neuen Belegung angeglichen.
- `apps.einstellungen.zuruecksetzen {name, neustart?}` löscht die Anpassungsdatei.
- `docker.js composeArgs` hängt die Anpassungsdatei bei jedem Aufruf als letztes `-f` an. ZIP-Apps mit manage.sh bekommen sie
  nach einem ZIP-Update per `up -d` wieder.
- Start scheitert an belegtem Port → E_BELEGT („unter Bearbeiten freien Port eintragen“) und `satz.portkonflikt`.
  `apps.liste` liefert `angepasst` und `portkonflikt`, die Apps-Kachel zählt die Portkonflikte.
- ZIP ohne manage.sh (`zip.ohne_skript`): Compose (auch eine Ebene tiefer, `.example` → compose.yml) oder nur Dockerfile.
  Dann erzeugt FAH-NAS eine Compose mit Port aus EXPOSE. Projekt `fahnas-<name>`, `up -d --build`.
  - Bei Portkonflikt wird nur gebaut, die App steht im Satz mit portkonflikt.
  - Update: ZIP per `cp -a` über den Ordner legen (Daten, .env und Anpassung bleiben), dann neu bauen.
- Oberfläche: „Bearbeiten“ ersetzt „Einstellungen“ und die Compose-Vorschau. Nach der Installation mit Portkonflikt öffnet
  sich der Editor direkt.

## 15. Ausbau Oktober 2026 (0.10.0/0.11.0, Betreiber 12.10.2026: „klein bis mittel inkl. VM-Thema“)

Gemeinsamer Helfer `src/agent/helfer/pakete.js`: `paketeSicherstellen(system, [pakete], {fortschritt, zweck})` installiert
fehlende Ubuntu-Pakete erst beim Einschalten einer Funktion – als eigene Unit (`systemd-run --wait --collect`), damit apt
einen Neustart des Agenten übersteht. Updates dieser Pakete laufen über System → Updates (Schild „Wofür“ je Paket,
`paketBereich()` in system.js).

### 15.1 Benachrichtigungen (0.10.0)
`benachrichtigungen.lesen|speichern|test|verlauf` (admin), `benachrichtigungen.senden` (system: {art, stufe, titel, text,
schluessel}). Arten: platte, spiegelung, apps, updates, usv, energie, vpn, vms. Datei `benachrichtigungen.json` (0600).

### 15.2 WireGuard-VPN (`src/agent/vpn/`, `aktionen/vpn.js`)
| Aktion | Rolle | Parameter | Ergebnis |
|---|---|---|---|
| vpn.lesen | admin | – | {aktiv, port, netz, adresse, dns, server_ip, nas_ip, lan_netze, geraete[{id,name,ip,zugriff}], laeuft, pakete_fehlen, selbsttest} |
| vpn.status | admin | – | {aktiv, laeuft, geraete[{id,name,verbunden,handshake,rx,tx,endpunkt}]} |
| vpn.speichern | admin, Aufgabe | {aktiv?, port?, netz?, adresse?, dns?} | wie lesen + hinweis |
| vpn.geraet.anlegen / .aendern | admin | {name, zugriff: nas\|heimnetz\|alles} / {id, name?, zugriff?} | {id, name, ip, zugriff, dateiname, text (.conf), qr_svg} |
| vpn.geraet.loeschen / .konfig | admin | {id} | {geloescht} / wie anlegen |
| vpn.oeffentliche_ip | admin | – | {ip} |
| vpn.selbsttest | admin, Aufgabe | – | {zeit, gesamt, schritte[{schritt, zustand, titel, text, tun?}]} |
| vpn.apply | system | – | stellt Dienst aus vpn.json her |
Datei `vpn.json` (0600, Schlüssel). Schnittstelle `wg-fahnas`, wg-quick@wg-fahnas, Standard UDP 51821, Netz 10.149.27.0/24.
Firewall (Renderer liest vpn.json selbst): `udp dport <port> accept`, `iifname "wg-fahnas" accept`, Kette forward (policy
accept; Zugriff je Gerät), Kette postrouting (masquerade), Set `vpn_quellen` (Selbsttest: Absender am VPN-Port, 30 min).
Selbsttest von außen über check-host.net (UDP), DNS von außen über DNS-over-HTTPS (Cloudflare/Google).

### 15.3 Grafikkarte (`helfer/gpu.js`, `aktionen/gpu.js`)
`gpu.lesen` (admin) → {karten[{adresse, hersteller, modell, treiber, takt?, auslastung?}], dri{vorhanden, geraete, kfd},
nvidia{karte, treiber, smi[], toolkit, docker, bereit}, apps[{app, art, laeuft}]}. `gpu.nvidia_einrichten` (admin, Aufgabe).
App-Editor: `apps.einstellungen` liefert je Dienst `gpu: keine|dri|nvidia`; `apps.einstellungen.speichern` nimmt `gpu` je
Dienst an und schreibt bei Abweichung vom Original `devices`/`group_add`/`deploy` mit `!override`.

### 15.4 Energie (`energie/regeln.js`, `aktionen/energie.js`)
`energie.lesen|status` (admin), `energie.speichern` (admin, Aufgabe: {zeitplan?{aktiv, aus{tage,zeit}, an{aktiv,tage,zeit}},
wol?{an?, geraete?[{name,mac}]}, usv?{aktiv, art: usb|netz, host, ups, benutzer, passwort, akku_unter, minuten_auf_akku}}),
`energie.aufwecken` {mac}, `energie.usv_suchen` (Aufgabe), `energie.apply` (system; bei USV aus räumt es eingeschaltete NUT-Reste ab: `nut.target` aus, `ups.conf` ohne Gerät). Datei `energie.json` (0600),
Zustand `energie-zustand.json`. Takt 30 s: Ausschalten (Nachholfenster 10 min, Aufschub bei laufenden Aufgaben bis 2 h,
RTC-Wecker per `rtcwake -m no -t`), USV-Regeln (upsc).

### 15.5 Protokolle (`protokolle/regeln.js`, `aktionen/protokolle.js`)
`protokolle.lesen` (admin), `protokolle.speichern` (admin, Aufgabe: {sftp{aktiv}, webdav{aktiv, port}, nfs{aktiv, netz,
freigaben[{name, nur_lesen, als_nutzer}]}, dlna{aktiv, name, freigaben[]}}), `protokolle.apply` (system; auch nach
Änderungen an Nutzern/Freigaben/Laufwerken). Ansichten je Nutzer `/run/fahnas-ansicht/<nutzer>/<freigabe>` (rbind+rslave,
nur lesen per remount; externe Laufwerke nur bei Schreibrecht), DLNA `/run/fahnas-dlna`. SFTP: Gruppe `fahnas-sftp`
(Konten ohne Shell), sshd-Ergänzung mit ChrootDirectory. WebDAV: `fahnas-webdav.service` (rclone, HTTPS mit dem Zertifikat
der Oberfläche, Anmeldung `src/agent/protokolle/webdav-auth.js`). DLNA: `fahnas-dlna.service`. NFS: nur v4 (2049/tcp).

### 15.6 Cloud-Ziele der Spiegelung (`spiegelung/cloud.js`)
`spiegelung.zugang.speichern` nimmt zusätzlich {art: cloud, anbieter: s3|b2|webdav|sftp, endpunkt, region, hersteller,
port, schluessel_id, schluessel}; Ansicht mit art/anbieter (ohne Geheimnisse). Cloud-Spiegelungen nur einseitig, eine Seite
auf diesem NAS; Lauf mit `rclone sync` (kurzlebige 0600-rclone.conf, Passwörter verschleiert wie `rclone obscure`),
Papierkorb `--backup-dir <ziel>/.fah-papierkorb/<Stempel>`, Leer-Schutz, Vorschau per `--dry-run`.

### 15.7 VMs (`vms/regeln.js`, `aktionen/vms.js`, Ansicht `vms`)
`vms.liste` (admin) → {verfuegbar, kvm, host{cpus, ram_mb}, vms[{name, titel, zustand: laeuft|pause|aus|fehler, cpu, ram_mb,
autostart, ip, cd, platte_belegt_gb, konsole}]}; `vms.isos`; `vms.anlegen` (Aufgabe: {name, titel?, system: linux|windows|
andere, cpu, ram_mb, platte_gb, iso?, netz: nat|bruecke, firmware?, autostart?}); `vms.steuern` {name, aktion: start|
herunterfahren|ausschalten|neustart|pause|fortsetzen}; `vms.aendern` {name, cpu?, ram_mb?, autostart?, iso?}; `vms.loeschen`;
`vms.konsole` {name} → Datenkanal-Ticket `art: konsole`. Platten unter /data/vms/<name>/platte.qcow2 (NOCOW).
**Datenkanal-Ticket „tcp“** (§3): nur zu 127.0.0.1; nach dem Verbinden eine Zeile `{"ok":true}`, danach rohe Bytes.
**Web:** WebSocket `GET /api/vm-konsole?ticket=…` (Upgrade; gleiche Herkunft, Admin-Sitzung ohne offene 2FA, Ticket nur aus
derselben Sitzung, einmalig) ↔ Datenkanal. noVNC wird aus dem Ubuntu-Paket unter `/novnc/…` ausgeliefert.

### 15.8 Englische Oberfläche
`public/sprache/en/*.json` (gleiche Schlüssel wie de). Sprache: eigene Wahl im Browser (Knopf „DE/EN“ oben rechts,
localStorage `fahnas_sprache`), sonst `system.json.sprache` (System → Allgemein), vor der Anmeldung die Browsersprache.
Englisch liegt über Deutsch (fehlende Übersetzung → deutscher Text). Meldungen des Agenten bleiben deutsch.

### 15.9 Speicherverbünde / RAID (0.13.0, `raid/regeln.js`, `aktionen/raid.js`, Karte in der Ansicht `laufwerke`)
Linux-Software-RAID (mdadm, Metadaten 1.2, Bitmap intern) mit btrfs darauf (`noatime,compress=zstd:1`); btrfs-eigenes
RAID 5/6 bewusst nicht. Stufen raid1 (≥2), raid5 (≥3), raid6 (≥4), raid10 (≥4, gerade, Layout n2), raid0 (≥2). Nur ganze
interne Platten (keine USB-, Loop-, CD-Geräte; Loop nur mit `FAHNAS_RAID_TEST_LOOPS=1` für Prüfungen), gesperrt mit Grund
`system | verbund | eingehaengt` (alle Ebenen unter der Platte). Wahrheit `raid.json` {version, verbuende[{name, stufe,
platten[{name, pfad, groesse, modell, seriennummer, ersatz?}], fs_uuid, md_uuid, erstellt, erstabgleich?}]} (erstabgleich: neues RAID 5 baut sich als „recovery“ auf – gilt als ok, bis fertig); Gerät `/dev/md/fahnas-<name>`,
Label `FAHNAS-RAID-<name>`, verwalteter Block in `/etc/mdadm/mdadm.conf`. Einhängepunkt `/data/shares/<name>` ist
ausgehängt unveränderlich (`chattr +i`).
`raid.liste` (admin) → {verbuende[{name, stufe, zustand: ok|wiederaufbau|beeintraechtigt|ausgefallen|fehlt, md, aktiv,
gesamt, fortschritt{art, prozent, rest_min}|null, geraete[{pfad, rolle}], eingehaengt, platz{gesamt, frei}|null, platten,
erstellt}], platten[…, grund?], stufen{raidN:{min, gerade}}}; `raid.anlegen` (Aufgabe: {name, stufe, platten[], bestaetigung
= name}) legt zusätzlich die Freigabe `verbund:true` an (Ersteller schreibt); `raid.platte_ersetzen` (Aufgabe: {name, alt?,
neu}); `raid.ersatz_hinzufuegen` {name, neu}; `raid.pruefen` {name} (sync_action check); `raid.loeschen` (Aufgabe: {name,
bestaetigung}); `raid.apply` (system, in `system.apply` vor `freigaben.apply`). Minutentakt meldet Ausfall (art `platte`,
stufe fehler) und „wieder in Ordnung“. Dashboard-Kachel `raid` → `#/laufwerke/raid`.
**Freigabe `verbund`:** wie intern (ACL, Papierkorb, Time Machine), aber kein Kontingent und keine Schnappschüsse (eigenes
Dateisystem); Samba `available = no`, solange nicht eingehängt; `freigaben.loeschen` nur mit `mitVerbund` (raid.loeschen).

### 15.10 Katalog nur mit fremden Apps (0.13.0, Betreiber 12.10.2026)
Eigene FAH-Apps tragen im Katalog `"nur_bestand": true`: `apps.katalog.liste` zeigt sie nicht mehr, `apps.installieren`
lehnt sie ab (Installation nur als ZIP-App); bereits installierte laufen und aktualisieren weiter wie bisher.

### 15.11 Bedienung (0.13.3/0.14.0, Betreiber 12.10.2026: „hierzu alles davon“)
- **Glas-Look:** Darstellung `glas` (bool) + `transparenz` (10–85, Durchsicht in %); CSS `:root[data-glas="an"]`, Variablen
  `--fahnas-glas-deckung`/`--fahnas-glas-unschaerfe` (darstellung.js `glasVariablen`); `prefers-reduced-transparency` → deckend.
- **Navigation in Gruppen:** `ansichten/index.js` `GRUPPEN` (speicher, daten, dienste, verwaltung) + `gruppe` je Ansicht.
- **System-Reiter:** `SYSTEM_REITER` in `ansichten/system.js` (grundlagen, zugriff, hardware, wartung); `#/system/<reiter>`
  oder `#/system/<karte>` (öffnet den Reiter der Karte).
- **Suche (Strg+K/⌘K):** `public/suche.js`; Treffer springen auf `#/<ansicht>/<karte>` bzw. `#/<ansicht>/ziel/<name>` –
  Listen markieren Einträge mit `data-suchziel` (Freigaben, Apps, Nutzer/Gruppen, VMs, Spiegelungen, Laufwerke: Kennung),
  `suchzielAnspringen()` in verwaltung-hilfen.js.
- **Handlungsbedarf (Dashboard, nur Admins):** `handlungsbedarf()` in dashboard.js aus den geladenen Listen + neue Aktion
  `system.hinweise` (admin, lesend, {neu?}) → {smart:[{geraet, modell, zustand, grund}], updates:{anzahl, sicherheit}|null,
  benachrichtigungen:bool, geprueft}; SMART mit `-n standby` (weckt keine Platte), Updates per `apt-get -s dist-upgrade`
  ohne `update`, 6 h zwischengespeichert.
- **Geführte Abläufe:** `ansichten/sicherung-assistent.js` (Quelle → Ziel Laufwerk/NAS/Cloud → Wann → Fertig; legt eine
  einseitige Spiegelung an, auf Wunsch Schnappschüsse der Quelle täglich 14/wöchentlich 8, startet den ersten Lauf);
  `#/spiegelung/neu[/<laufwerk>]`. Laufwerke: unbekannte Platte → „einbinden / in Verbund aufnehmen / als Sicherungsziel“;
  `laufwerke.liste` liefert dafür `platte` (/dev/sdX).
- **Rechte aus Nutzersicht:** Nutzer → „Zugriff“ (je Freigabe kein/lesen/schreiben, Gruppenrechte angezeigt) → `freigaben.aendern`.
- **Englisch:** `public/sprache/agent-en.json` = [[deutsch mit {1}…, english]] für Meldungen des Agenten (`public/agent-text.js`).
- **„Was tun?“:** an Fehler-Toasts, Fehlerhinweisen und Formular-Fehlerzeilen; Hilfe je Code (`fehler.hilfe_<CODE>`), Details
  zum Kopieren, Admins: Link ins Protokoll; ohne Fehlerobjekt der letzte Fehler einer Anfrage (`letzterFehler()` in api.js).

### 15.12 Vor UGOS/ZimaOS (0.15.0, Betreiber 12.10.2026: „mach alle 8 punkte“)
1. **Automatische Prüfungen** (`aktionen/wartung.js`, `wartung/regeln.js`): wöchentlich kurzer SMART-Selbsttest (Tag/Uhrzeit),
   am ersten Prüftag im Monat gründlich + RAID-Datenprüfung; Ergebnis aus `smartctl -l selftest` (alle 10 min nachgesehen),
   Fehler → Benachrichtigung (art platte) + Handlungsbedarf. `wartung.lesen`, `wartung.speichern` {pruefungen, auto_updates},
   `wartung.jetzt` {art: smart_kurz|smart_lang|raid}, `wartung.apply` (system). Zustand `wartung_zustand.json`.
2. **Sicherheits-Check** `wartung.sicherheit` → [{id, stufe, schluessel, werte, ziel}] (Admin ohne 2FA, einfaches Anmelde-
   passwort (scrypt-Vergleich, 6 h zwischengespeichert), Gästefreigaben, SSH mit Passwort, automatische Updates aus,
   schwache Passwörter in App-.env, Neustart nötig, gesperrte verschlüsselte Freigaben, persönlicher Ordner ≥ 90 %,
   fehlgeschlagene Selbsttests/RAID-Prüfungen); `system.hinweise` liefert sie als `sicherheit`.
3. **Automatische Updates**: unattended-upgrades über `/etc/apt/apt.conf.d/21fahnas-auto-upgrades`,
   `52fahnas-unattended-upgrades` (Umfang sicherheit|alle, Neustart + Uhrzeit) und Timer-Drop-in
   `apt-daily-upgrade.timer.d/fahnas.conf`; Standard: an, nur Sicherheitsupdates, 04:00.
4. **Verbund erweitern**: `raid.erweitern` (Aufgabe: {name, platten[], stufe?, bestaetigung}; RAID 5/6 + Platten, RAID 1 aus
   2 Platten → RAID 5 oder weiterer Spiegel; interne Bitmap wird für den Umbau entfernt und danach wieder angelegt),
   `raid.vergroessern` {name} (`--size=max` nach Tausch gegen größere Platten). Merker `wachstum`; ist der Umbau fertig,
   wächst btrfs (`filesystem resize max`) und es kommt eine Meldung. Zustand `umbau` mit Fortschritt; `raid.liste` liefert
   `vergroesserbar`, `wachstum`, `nutzgroesse`.
5. **Schnappschüsse auf Verbünden**: neue Verbünde (`layout: 2`) haben die Unterlaufwerke `daten` (Freigabe) und
   `schnappschuesse` (eingehängt unter `/data/.snapshots/<name>`) – das Schnappschuss-Modul arbeitet unverändert.
   Ganzes Zurücksetzen ist dort gesperrt (einzeln zurückholen geht).
6. **Sicherung mit Versionen**: Auftrag `versionen_tage` (7|30|90|365, Standard 30) für die Stände im Papierkorb der Ziel-Freigabe: `.papierkorb/spiegelung-<auftrag>-<stempel>/<Pfad ab Freigabe>` mit `papierkorb.json`, sichtbar auch im Dateimanager (seit 0.27.0, vorher `.fah-papierkorb` je Zielordner; Altlasten laufen ab). Nur Cloud-Ziele behalten `.fah-papierkorb`, dort gibt es keine Freigaben;
   `spiegelung.versionen` {id}, `spiegelung.versionen.inhalt` {id, stand, pfad}, `spiegelung.versionen.zurueckholen`
   {id, stand, pfad} (nur Ziele auf diesem NAS; vorhandenes bleibt, die Kopie heißt „Name (Stand JJJJ-MM-TT HH.MM)“).
7. **Verschlüsselte Freigaben** (`freigaben/krypt.js`, gocryptfs): `freigaben.anlegen` {verschluesselt, passwort, merken};
   Daten in `<daten>/.krypt/<name>` (Unterlaufwerk), entsperrt am Einhängepunkt; `freigaben.entsperren` {name, passwort,
   merken?}, `freigaben.sperren` {name, vergessen?}; gespeicherter Schlüssel `<konfig>/krypt/<name>.schluessel` (0600) →
   `freigaben.apply` entsperrt beim Start. Samba aus, solange gesperrt; keine Kontingente/Schnappschüsse.
8. **Persönliche Ordner mit Speicherplatz je Nutzer** (`aktionen/heim.js`): `<daten>/homes/<nutzer>` (Unterlaufwerk, 0700,
   qgroup-Grenze), Samba `[homes]` (\\NAS\<nutzer>); users.json `heim {aktiv, groesse_gb}`; `heim.liste`, `heim.setzen`,
   `heim.apply` (bewahrt Ordner gelöschter Nutzer in backup/geloescht auf).

## 16. Übersicht-Kacheln nach Unraid/ZimaOS (0.17.0, Betreiber 15.10.2026: „alles bauen“)

Neue Kacheln in `public/ansichten/dashboard.js` (Standardgrößen in `dashboard-raster.js`, bei gespeicherten Layouts unten angefügt):
`freigaben` (alle Nutzer, `freigaben.liste`), `uhr` (alle Nutzer, Gerätezeit), nur Admins: `schnappschuesse`, `verbindungen`,
`docker`, `updates`. Die Kachel `apps` listet jede App (Fehler → laufend → gestoppt), Name öffnet die WebUI (wie `apps.js`
appHost/webuiAufloesen), Admins starten/stoppen/neu starten über `apps.steuern` (Stopp mit Rückfrage), Abzeichen „Update“.
Neue Agent-Aktionen (alle admin):
- `apps.updates` lesend `{pruefen?}` → `{geprueft, laeuft, anzahl, apps:[{name, titel, stand: update|aktuell|unbekannt, images:[{image,
  stand: aktuell|update|lokal|fest|fehlt|fehler, grund?}]}]}`. Abgleich `apps/registry.js`: HEAD auf `/v2/<repo>/manifests/<tag>`
  (anonymer Bearer aus WWW-Authenticate), Docker-Content-Digest gegen die RepoDigests des lokalen Images. Ergebnis in
  `<konfig>/apps-updates.json`; von selbst höchstens alle 12 h (nach Fehlschlag 30 min Ruhe), `pruefen:true` wartet auf den Abgleich.
  ZIP-Apps und FAH-Apps (bauen) werden nicht gefragt. `apps.liste` liefert je App `update` (bool); `apps.aktualisieren` setzt den
  Stand der App auf aktuell. Ende des Abgleichs → `konfig`-Ereignis `apps`.
- `apps.docker_speicher` lesend `{neu?}` → `{images, container, volumes, cache: {anzahl, aktiv, bytes, frei_bytes}|null, logs, wurzel,
  gemessen}` aus `docker system df --format '{{json .}}'`, `docker info` (DockerRootDir) und der Summe der `*-json.log`; 5 min Zwischenspeicher.
- `apps.docker_aufraeumen` (Aufgabe) `{}` → `{frei_bytes}`: `docker image prune -f` + `docker builder prune -f` (ganzer
  Bau-Zwischenspeicher). Container, Volumes und benutzte Images bleiben.
- `snapshots.uebersicht` lesend `{}` → `{ziele:[{ziel: system|<freigabe>, anzahl, letzter, naechster, fehler?}]}`; naechster aus dem
  Zeitplan (`naechsteFaelligkeit` = letzteFaelligkeit + Takt). Freigaben ohne Schnappschüsse (extern, verschlüsselt) fehlen.
- `system.verbindungen` lesend `{}` → `{smb: {sitzungen:[{nutzer, rechner, adresse, protokoll, freigaben}], dateien:[{nutzer,
  freigabe, datei, seit}]}|null, ssh:[{nutzer, adresse}], webdav:[{adresse, anzahl}], nfs:[{adresse, anzahl}], gemessen}` aus
  `smbstatus --json` und `ss -Htnp state established` (nur Host-Namensraum; SSH-Nutzer aus /proc/<pid>/cmdline von sshd-session,
  WebDAV über den Port aus protokolle.json, NFS Port 2049). Auswertung in `helfer/zugriffe.js`.
Web-Sitzungen der Kachel „Verbindungen“ kommen aus `GET /api/sitzungen` (aktiv = in den letzten 15 min benutzt).

## 17. Anmeldung, Tapeten-Zoom, Systemübersicht, Schnappschuss-Aufräumen (0.18.0, Betreiber 16.10.2026)

- **Automatisch abmelden** je Nutzer: `POST /api/sitzung/abmelden {minuten}` (CSRF, eigene Sitzung) mit `minuten` aus
  `null` (Standard: 12 h, mit „Angemeldet bleiben“ 30 Tage), `15, 60, 240, 720, 1440, 10080, 43200` oder `0` (nie).
  Gespeichert in `/data/config/web/abmelden.json` (0600), gilt sofort für alle Sitzungen des Nutzers (Ablauf neu ab
  `zuletzt`). Mit eigener Zeit ist das Cookie dauerhaft (Max-Age 400 Tage, wie bei „Angemeldet bleiben“) – ob die Sitzung
  gilt, entscheidet allein der Server. `GET /api/ich` liefert zusätzlich `abmelden` und erneuert die Cookies. Oberfläche:
  Regler in „Mein Konto“ (Ansicht `nutzer`), Kachel `anmeldung`.
- **Tapete**: Darstellung bekommt `zoom` (50–300 %, 5er-Schritte, Standard 100) – 100 % = wie die Skalierung die Tapete
  auf dem Bildschirm zeigt, Zoom zur Bildschirmmitte (CSS `--fahnas-zoom`; Kacheln: Fläche ÷ Zoom, damit lückenlos).
  Scheitert das Laden der Tapete (vor der Anmeldung 401), lädt das nächste `anwenden()` sie neu.
  Seit 0.18.2 Skalierung `auto` („Automatisch“, neuer Standard): ganzes Bild, um bis zu 5 % im Seitenverhältnis gestreckt
  (`einpassMass`, `AUTO_TOLERANZ`), bleibt ein Rand, füllt ihn eine unscharfe Kopie (`data-tapete-rand="ja"`); neu
  gerechnet bei jeder Fenstergröße. Videos mit „Kacheln“ gelten als `auto`. Der Zoom-Regler ist bei `auto` gesperrt und wirkt dort
  nicht (`wirksamerZoom`, 0.18.4). Dateiansicht: „Als Hintergrund“ (Auswahlleiste bei genau einer Bild-/Videodatei, Menü,
  Vorschau) setzt `{quelle:'ordner', freigabe, pfad, art, v}` + `hintergrund:'tapete'` (0.18.5).
- **Kachel `systemleiste`** („Systemübersicht“, 12 × 3, feste Höhe ohne Rollen): CPU (+ Temperatur), GPU (nur Admin,
  `gpu.lesen`), RAM, Netz, Datenpartition. Fehlt sie in einem gespeicherten Layout, erscheint sie oben (`NEU_OBEN` in
  `dashboard-raster.js`), alle anderen rutschen um ihre Höhe nach unten. Seit 0.18.1 rechts in der Kopfzeile Name, Version, Kernel und
  Laufzeit (wie Kachel `system`, aus `system.status`).
- **snapper** räumt stündlich auf: Zusatz `snapper-cleanup.timer.d/fahnas-stuendlich.conf` (`FAHNAS_SYSTEMD`, Standard
  `/etc/systemd/system`), geschrieben von `render/snapper.js` bei `snapshots.apply`. Grund: die Zeitleiste legt jede
  Stunde einen Stand an, auch ohne „Stündlich“; mit täglichem Aufräumen lagen bis zu 24 überzählige Stände herum.
  Seit 0.32.0 Kalendertakt `OnCalendar=*-*-* *:30:00` + `OnBootSec=10m` (vorher `OnUnitActiveSec=` leer + `1h`: Die leere
  Zuweisung löschte auch `OnBootSec` der Original-Unit, nach einem Neustart lief das Aufräumen nie mehr – 396 Zeitleisten-Stände
  auf dem Mini-PC, 13.11.2026).

## 18. Freigabelinks: Linkseite, dauerhaft, Zugriffe (0.19.0, Betreiber 16.10.2026)

Auftrag: „Gültigkeit für Freigabelinks auch dauerhaft, bis ich diese selbst lösche … ein Widget, was per Link freigegeben wurde inkl.
der Gültigkeit und wer gerade zugreift (IP) … Freigabelink sollte das Ziel öffnen und nicht als ZIP herunterladen.“ Empfänger sind Leute
außerhalb des Heimnetzes; die Domain `fah-nas.example.org` steht dafür im FAH-Proxy auf „Öffentlich“ (Betreiber).

- **Dauerhaft:** `gueltig_h: 0` → `ablauf: null`; `linksGueltig` behält solche Links, bis sie gelöscht werden.
- **Agent `dateien.link.oeffnen`** (Rolle gast, lesend) `{token, pfad, was: liste|lesen|zip|vorschau, groesse?}`: Link einlösen mit den
  Rechten des Erstellers (`linkEinloesen`), `pfad` relativ zum geteilten Ziel (`linkPfad`): keine versteckten Teile (`.…`), nicht aus dem
  geteilten Ordner hinaus – auch nicht über Verknüpfungen innerhalb der Freigabe (`sicherAufloesen(linkWurzel, sub)`), Datei-Links ohne
  Unterpfad. `liste` → `{name, art_link, ablauf, nutzer, art:"ordner", pfad, eltern, eintraege:[{name, art, groesse, geaendert, mime,
  vorschau}]}` (ohne Verknüpfungen/Versteckte) bzw. `{…, art:"datei", eintrag}`; `lesen`/`zip` → Ticket + `nutzer` (Ersteller);
  `vorschau` → `{mime, daten}`. Unbekannt/abgelaufen → `E_NICHT_GEFUNDEN` mit `details.link = "ungueltig"`.
- **Agent `netz.orte`** (nutzer, lesend) `{ips:[…≤100]}` → `{ip: {stadt, land, land_name}|null}` aus den lokalen DB-IP-Daten.
- **Web (ohne Sitzung):** `GET /link/<token>` = HTML-Hülle (`public/teilen.js` + `teilen.css`, ungültig → 404-Seite ohne Skript),
  `/link/<token>/liste?pfad=` (JSON ohne `nutzer`), `/datei?pfad=[&anzeigen=1]` (Range), `/zip?pfad=`, `/vorschau?pfad=&groesse=`.
  Alle mit `X-Robots-Tag: noindex, nofollow`. Bremse: jedes ungültige Token zählt als Fehlversuch der IP (gemeinsame Bremse mit der
  Anmeldung, 5 → 30 s …), gesperrt → 429 auch für gültige Links.
- **Zugriffe** (`src/web/links.js` `LinkZugriffe`): je Link (Schlüssel = gekürzter SHA-256 des Tokens) IPs der letzten 24 h im Speicher,
  „gerade“ = Anfrage ≤ 5 min oder laufender Download; `aufrufe` (Seite, Ansehen ab Byte 0, Herunterladen, ZIP) und `zuletzt {zeit, ip}`
  in `/data/config/web/link-zugriffe.json` (0600). Web-Protokoll `link_zugriff {ip, link, was, datei?}`.
- **`GET /api/links`** (Sitzung): `dateien.link.liste` des Nutzers (Admin: alle) + `zugriffe {aufrufe, zuletzt, aktiv:[{ip, seit, letzte,
  laeuft}]}` + `orte` aus `netz.orte`. Dashboard-Kachel `links` „Freigabelinks“ (alle Nutzer, Standard 4×6): Gültigkeit, wer gerade
  zugreift (IP · Ort, „schaut gerade“/„lädt herunter“), zuletzt, Kopieren, Löschen.
- **Link-Adresse** (`OeffentlicheAdresse`, `/api/ich` → `zugang.link_basis`): gelernt aus dem Aufruf der Oberfläche über einen
  VERTRAUTEN Proxy (Host bzw. X-Forwarded-Host = Domain, keine IP/.local/.lan), gespeichert in `web/link-adresse.json`. Nichts fest
  eingetragen: wechselt die Domain, zeigen Dialog und Kachel die neue Adresse (`public/links.js` `linkAdresse`).
- **Freigaben → Verbinden:** `freigaben.verbindung` liefert `smb://<NAS-IP>/<name>` (geht zu Hause und über VPN) plus `smb_lokal`
  (`.local`); IP aus `nasNetz()` (`helfer/netzadressen.js`, auch für {NAS_IP} der Apps). SMB über die Internet-Domain bleibt zu.


## 19. Anmeldeschutz für Zugriffe aus dem Internet (0.20.0, Betreiber 16.10.2026: „bau alle vier Punkte“)

Anlass: `fah-nas.example.org` ist für Freigabelinks öffentlich (§18), damit steht auch die Anmeldung im Internet.
„Aus dem Internet“ = Client-IP (nach den vertrauten Proxys) ist keine private Adresse (`istPrivat`: RFC1918, CGNAT, Loopback,
Link-Local, ULA). Heimnetz und VPN bleiben unverändert. Umsetzung `src/web/anmeldeschutz.js` (`Anmeldeschutz`).

1. **Strenge Bremse:** eigene `Bremse` (Datei `web/bremse-extern.json`, Grenze 3, feste Stufen 1 h → 24 h), Namensschlüssel
   `@internet:<name>` – Angriffe von außen sperren nie das Konto für Heimnetz/VPN. Gilt für Passwort und TOTP-Code.
2. **Ländersperre:** `system.json` `anmeldeschutz.laender` (Standard `["DE"]`, leer = alle; `system.setzen` prüft zweistellige
   Kürzel). Land über Agent `netz.land` (gast, lesend, lokale DB-IP-Daten, 1 h im Web zwischengespeichert). Unbekannt = gesperrt
   → `E_RECHTE` mit `details {grund:"land", land, laender}`.
3. **Rechenaufgabe:** `GET /api/anmelden/aufgabe` (ohne Sitzung) → Heimnetz `{noetig:false}`; Internet `{noetig:true, aufgabe, bits,
   warte_s}` bzw. `{noetig:true, land_gesperrt:true, meldung, laender}`. Aufgabe `zeit36.bits36.zufall.hmac16` (HMAC mit
   Prozessschlüssel, an die IP gebunden, 5 min, einmalig), Lösung = Zahl n mit SHA-256(`aufgabe:n`) ≥ bits führenden Null-Bits.
   Bits = 18 + Fehler der IP + 2 × Sperrstufe (max. 22). Browser: Web-Worker `public/anmeldung-aufgabe.js` (eigenes SHA-256 für einen
   Block, `type:"module"`). `POST /api/anmelden` aus dem Internet verlangt `{aufgabe, loesung}` (sonst `E_PARAMS feld aufgabe`).
   Reihenfolge: Bremse prüfen → Land → Aufgabe → Versuch reservieren → Passwort.
4. **Meldungen:** Agent `benachrichtigungen.anmeldung` (gast) `{art: erfolg|sperre, nutzer?, ip, ort?, minuten?}` baut Titel/Text
   selbst, höchstens 30 je Stunde; neue Ereignisart `anmeldung` (Standard an) in der Karte Benachrichtigungen.
   Sperren gebündelt (0.20.3, ntfy.sh erlaubt 250 Nachrichten/Tag): die erste sofort, alle weiteren innerhalb einer Stunde als EINE
   Sammelmeldung am Ende der Stunde (`sperreMelden`/`sammelSenden`, höchstens 10 Adressen ausgeschrieben).
- **2FA nur von außen** (Betreiber: „nur wenn ich außerhalb von VPN oder Heimnetz zugreife“): aus dem Heimnetz wird `totp_offen`
  nicht gesetzt, die Sitzung bekommt `totp_spaeter`. `Auth.sitzungAus` setzt `totp_offen`, sobald so eine Sitzung mit einer
  Internet-Adresse auftaucht (Protokoll `totp_nachgefordert`); der Code-Schritt löscht `totp_spaeter`.
- **Übersicht** `GET /api/anmeldeschutz` (Admin): `{laender, bits, grenze, sperren_ms, sperren:[{ip, bis, ort}], fehler_24h, land_24h,
  letzte:[{nutzer, ip, ort, zeit}], du_extern}` (Stand in `web/anmeldeschutz.json`). Karte System → Zugriff → „Anmeldeschutz“
  (#/system/anmeldeschutz, Länderfeld, Stand, Hinweis bei ausgeschalteten Benachrichtigungen), Kachel `anmeldeschutz` (Admin, 3×5).


## 20. Zusammenarbeit (0.21.0, Betreiber 18.10.2026)

Auftrag: „wenn ich Dateien wie .md oder .txt anklicke, würde ich den Inhalt auch gerne editieren können und autospeichern bei
Schließen. Kannst du zudem noch einen Chatroom einbauen, um mit Usern chatten, callen zu können, sowie ein Office einbauen.“
Entwurf `docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md`, Pläne `docs/superpowers/plans/2026-10-18-zusammenarbeit-*.md`.
Abschnitte: 20.1 Texteditor, 20.2 Chat, 20.3 Anrufe, 20.4 Office, 20.5 App-Sichtbarkeit.

### 20.1 Texteditor (Plan 01)

- **Agent `dateien.text.speichern`** (Rolle nutzer) `{freigabe, pfad, inhalt (≤ 2 MiB Bytes, Standard ''), erwartet?: {geaendert, groesse},
  neu (Standard false)}` → `{pfad, name, geaendert, groesse}`. Schreibt über die Dateihelfer-Op `text_schreiben` ALS der Nutzer: Zwischendatei
  `.fahnas-upload-<hex>` im selben Ordner, fsync, rename. Rechte-Bits der alten Datei bleiben. Ohne `neu` muss eine reguläre Datei da sein
  (`E_NICHT_GEFUNDEN`; Ordner → `E_PARAMS`). Weicht der Stand von `erwartet` ab (geprüft vorher UND direkt vor dem Tausch) → `E_GEAENDERT
  {geaendert, groesse}` (Stand auf der Platte, nichts geschrieben). `neu` legt exklusiv an (Hardlink bzw. Rückfall rename; vorhanden →
  `E_EXISTIERT {name}`). Kein Papierkorb für alte Fassungen (Schnappschüsse). Ohne Schreibrecht `E_RECHTE`, Papierkorb/`..` gesperrt.
  Prüfprotokoll nur `{freigabe, pfad, neu}`.
- **V1 Audit-Schwärzung:** `reg.aktion(name, {…, audit?: false | (p) => object})`; `auditParams(aktion, params, ok)` in
  `src/agent/register.js`. `false` = erfolgreiche Aufrufe ohne Eintrag, Fehler mit `{}`; Funktion = Ersatz-Parameter (auch bei
  Schemafehlern mit rohen Parametern und bei Aufgaben). Pflicht für alle Aktionen mit Text, Dateiinhalt, Dokumentdaten oder Ausweisen.
- **V2 große JSON-Anfragen:** `GROSSE_AKTIONEN` in `src/web/api/agent.js` (`dateien.text.speichern` 8 MiB; sonst `MAX_JSON` 1 MiB).
- **V3 Dialog-Veto:** `ctx.dialog(inhalt, {…, vorSchliessen: async (wert) => boolean})` – Esc, Klick daneben, X und `schliessen(wert)`
  fragen erst den Haken (nur `true` schließt, weitere Versuche während der Prüfung zählen nicht); `schliessen(wert, {sofort:true})`
  umgeht ihn; erzwingt der Browser das Schließen (zweites Esc), öffnet der Dialog wieder und fragt.
- **V4 Markdown:** `public/markdown.js` `markdownZuKnoten(text, {modus: 'voll'|'chat'})` → DocumentFragment (nur DOM-Aufbau, HTML bleibt
  Text, Links nur http/https/mailto mit `rel="noopener noreferrer" target="_blank"`; einzelner Zeilenumbruch → `<br>`).
- **V5 `E_GEAENDERT`** (HTTP 409, §6), `details.geaendert/groesse` auch für Nicht-Admins (`DETAILS_FUER_NUTZER`/`DETAILS_FUER_ALLE`).
- **Oberfläche** `public/texteditor.js` `texteditorOeffnen(ctx, {freigabe, pfad, eintrag, schreibbar, nachSpeichern})`: Klick auf eine
  Textdatei (Endungen/MIME wie bisher `artVon` → `text`, bis 1 MiB) öffnet den Editor statt der Vorschau. Laden: erst `dateien.info`
  (Stand), dann der Inhalt; nicht UTF-8 → nur lesen mit Hinweis. Speichern beim Schließen (V3) und mit Strg/⌘+S; `beforeunload` warnt nur
  bei ungespeicherten Änderungen; Netzfehler → Dialog bleibt mit Text offen. `E_GEAENDERT` → Frage: „Als Kopie speichern“ (Name
  `<Stamm> (bearbeitet JJJJ-MM-TT HH-MM)[ (n)]<.endung>`, Ortszeit, bis 20 Versuche), „Trotzdem überschreiben“ (ohne `erwartet`), „Meine
  Änderungen verwerfen“, „Weiter bearbeiten“. CRLF und BOM bleiben byte-genau. Markdown-Dateien mit Umschalter Bearbeiten/Ansicht.
  Nur lesen ohne Schreibrecht und im Papierkorb.

### 20.2 Chat (Plan 02)

Wie Matrix/Element: Räume und Direktnachrichten unter NAS-Nutzern, Dateien (herunterladen oder auf dem NAS speichern, je
Empfänger frei wählbar), Einladungslinks für Gäste ohne Konto (mit/ohne Ablauf), Ungelesen im Rahmen, Ton/Browser-/Handy-Meldung.
Alles eigener Code (keine Fremd-Bibliothek); kein Ende-zu-Ende – die Inhalte liegen lesbar für root auf dem NAS.

- **Ablage `PFADE.chat`** (`FAHNAS_CHAT`, Standard `/data/chat`, eigenes btrfs-Unterlaufwerk, root 0700, Dateien 0600, NICHT im
  Konfig-Export): `raeume/<id>/raum.json` `{schema:1, id, art:"raum"|"dm", name, beschreibung, erstellt, ersteller, verwalter:[…],
  mitglieder:{<nutzer>:{seit, gelesen, ungelesen}}, gaeste:{<gid>:{name, seit, geheimnis_hash, gelesen, ungelesen, einladung}}, gaeste_alt, einladungen:
  [{id, token, erstellt, von, ablauf|null, max|null, beitritte}], letzte:{id, zeit, von, kurz}|null}` (nur der Agent schreibt, atomar,
  im Speicher zwischengehalten); `raeume/<id>/verlauf/<JJJJ-MM>.ndjson` mit Zeilen `{t:"n", id, zeit, von, text, antwort?, anhaenge}`
  (Nachricht), `{t:"s", id, zeit, art, wer, daten}` (Systemzeile: `beitritt`, `austritt`, `umbenannt {alt, neu}`, `gast_beitritt`,
  `gast_entfernt`), `{t:"b", id, zeit, text}` (bearbeitet), `{t:"l", id, zeit}` (gelöscht – Text, Anhänge, Reaktionen weg),
  `{t:"r", id, von, emoji, an}` (Reaktion); unbekannte Arten werden übersprungen. Verlauf im Speicher: LRU 20 Räume.
  `anhaenge/<raum>/<aid>` + `<aid>.json` `{id, name, groesse, mime, von, nachricht, zeit}`; ungebundene Anhänge und `.teil`-Reste
  nach 24 h weg (Takt 24 h). `gaeste.json` = Index Gast → Raum.
- **Kennungen:** Raum `r` + 16, DM `d` + 20 (SHA-256 der beiden Namen, symmetrisch), Nachricht `n` + 15 (Zeit base36 + Zufall,
  sortierbar), Anhang `a` + 16, Gast `g` + 16, Einladung `e` + 16, Einladungs-Token 32 Byte base64url, Gast-Ausweis
  `{id, geheimnis(43)}` (im Raum nur der SHA-256, Vergleich mit `timingSafeEqual`).
- **Konfig:** `chat.json` (0600, im Export nur ohne Geheimnisse) `{version, max_anhang_mb (Standard 2048, 1–20480), turn:{aktiv:true,
  port:3478}}`; `benachrichtigungen-persoenlich.json` (Tageszähler, nie im Export). Persönlich je Nutzer in `users.json`
  `einstellungen.chat = {standardordner:{freigabe,pfad}|null, ton, browser, stumm:[raum…]}` und `einstellungen.benachrichtigung =
  {aktiv, thema}` (V9).
- **Agent-Aktionen** (`src/agent/aktionen/chat.js`; „still“ = kein Audit-Eintrag, „ohne Text“ = Parameter ohne Inhalte):

  | Aktion | Rolle | Parameter | Ergebnis / Fehler | Audit |
  |---|---|---|---|---|
  | `chat.uebersicht` | nutzer, lesend | – | `{raeume:[{id, art, name, beschreibung, mitglieder:[{name, anzeigename}], gaeste:[{id,name}], ungelesen, letzte, verwalter, verwaltende, stumm}]}` (nur eigene Räume, auch für Admins) | normal |
  | `chat.personen` | nutzer, lesend | – | `{personen:[{name, anzeigename}]}` ohne gesperrte (DM-/Mitgliederwahl) | still |
  | `chat.raum.anlegen` | nutzer | `{name (1–80), beschreibung (≤300), mitglieder:[…]}` | `{raum}`; unbekannt/gesperrt → `E_PARAMS {feld:'mitglieder'}` | Name + Mitglieder |
  | `chat.raum.aendern` | nutzer (Verwalter) | `{raum, name?, beschreibung?}` | `{raum}`; Systemzeile `umbenannt` | normal |
  | `chat.raum.mitglieder` | nutzer (Verwalter; jeder sich selbst entfernen) | `{raum, hinzu, weg, verwalter_hinzu, verwalter_weg}` | neuer Stand; Systemzeilen `beitritt`/`austritt`; letzter Verwalter bleibt, solange andere da sind | normal |
  | `chat.raum.loeschen` | nutzer (Verwalter) oder Admin | `{raum}` | `{geloescht}`; DMs nicht löschbar | normal |
  | `chat.raum.alle` | admin, lesend | – | `[{id, name, mitglieder_anzahl, gaeste_anzahl, ersteller, letzte_zeit}]` ohne Inhalte | normal |
  | `chat.dm.oeffnen` | nutzer | `{nutzer}` | `{raum}` (legt beim ersten Mal an) | normal |
  | `chat.empfaenger` | nutzer, lesend | `{raum}` | `{nutzer, gaeste}` | still |
  | `chat.verlauf` | nutzer, lesend | `{raum, vor?, anzahl 1–100 (50)}` | `{nachrichten, mehr, gelesen:{nutzer: id|null}}` | normal |
  | `chat.senden` | nutzer | `{raum, text ≤10000, antwort?, anhaenge ≤10}` (`aktiv` setzt der Web-Dienst) | `{nachricht}`; Push an Abwesende | still |
  | `chat.bearbeiten` / `chat.loeschen` | nutzer | `{raum, nachricht, text}` / `{raum, nachricht}` | `{nachricht}` / `{geloescht}`; nur eigene (Löschen: auch Verwalter) | still / normal |
  | `chat.reaktion` | nutzer | `{raum, nachricht, emoji ≤16, an}` | `{reaktionen}` | still |
  | `chat.gelesen` | nutzer | `{raum, bis}` | neuer Lesestand; Ereignis `gelesen` an die Mitglieder | still |
  | `chat.suche` | nutzer, lesend | `{raum, text 2–100}` | `{treffer:[Nachricht]}` (höchstens 50) | nur Raum |
  | `chat.anhang.ticket` | nutzer | `{raum, name, groesse}` | Upload-Ticket (Datenkanal, als root in `<aid>.teil`); zu groß → `E_PARAMS {feld:'groesse', max}` | normal |
  | `chat.anhang.lesen` | nutzer, lesend | `{raum, anhang, vorschau? 128/256/512}` | Ticket bzw. `{mime, daten}` | normal |
  | `chat.anhang.speichern` | nutzer | `{raum, anhang, freigabe, ordner}` | `{freigabe, pfad, name}` – Kopie ALS der Nutzer (`kopierenAls`), freier Name „(1)“ | normal |
  | `chat.anhang.aus_nas` | nutzer | `{raum, freigabe, pfad}` | `{anhang}` („Im Chat teilen …“, nur Dateien) | normal |
  | `chat.einladung.anlegen` | nutzer (Verwalter) | `{raum, gueltig_h 0–8760 (0 = dauerhaft), max_beitritte? 1–1000}` | `{id, token, url, ablauf, max, beitritte, erstellt}` | ohne Token |
  | `chat.einladung.liste` / `.loeschen` | nutzer (Verwalter) | `{raum}` / `{raum, id}` | Liste / `{geloescht}` (Beigetretene bleiben) | normal |
  | `chat.einladung.annehmen` | nutzer | `{token}` | `{raum}` (NAS-Nutzer wird Mitglied) | leer |
  | `chat.gast.entfernen` | nutzer (Verwalter) | `{raum, gast}` | `{entfernt}`; Socket des Gasts → 4003 | normal |
  | `chat.gast.einladung` / `.beitreten` / `.pruefen` | gast | `{token}` / `{token, name ≤200}` / `{ausweis}` | `{raum, raum_name, gueltig}` / `{ausweis, raum}` / `{raum, raum_name, name, gast}` | leer / Name / leer |
  | `chat.gast.verlauf` `.senden` `.loeschen` `.reaktion` `.gelesen` `.anhang_ticket` `.anhang_lesen` `.empfaenger` `.verlassen` | gast | wie die Nutzer-Aktionen + `ausweis` | Gäste sehen nur ihren Raum ab Beitritt, Login-Namen werden zu Anzeigenamen; Drossel 20 Nachrichten/min, 20 Uploads/h (`E_BREMSE {warte_s}`, nur im Speicher) | ohne Ausweis bzw. still |
  | `chat.einstellungen.lesen` / `.setzen` | nutzer / admin | – / `{max_anhang_mb?, turn?:{aktiv, port}}` | `{max_anhang_mb, turn}` | normal |
  | `benachrichtigungen.persoenlich_test` / `_info` | nutzer | – | `{gesendet}` / `{server}` (ohne Zugangsdaten) | normal |

- **Ereignis `chat`** (Agent → Web) `{raum, art, daten, daten_gast?, an:{nutzer:[…], gaeste:[…]}}`, `art`: `nachricht`, `bearbeitet`
  `{id, text, bearbeitet}`, `geloescht {id}`, `reaktion {id, reaktionen}`, `gelesen {wer, bis}` (nur Nutzer), `raum` (angelegt/geändert,
  Kurzform), `raum_weg`, `einladungen` (an Verwalter), `gast_entfernt {gast}`. Geht nie über SSE (V7: `PRIVATE_EREIGNISSE`), nur an die
  genannten Empfänger über den WebSocket; Gäste bekommen `daten_gast`.
- **WebSocket `/api/chat/ws`** (`src/web/ws.js` eigenes RFC 6455 ohne Erweiterungen, Upgrade-Verteiler V6; Herkunft muss passen):
  Identität aus der Sitzung (ohne offene 2FA) oder dem Gast-Keks. Client → Server: `{art:"aufruf", id ≤64, aktion, params}`,
  `{art:"sichtbar", ja}` (aktiv = sichtbar in den letzten 120 s → keine Handy-Meldung), `{art:"tippt", raum}` (≤ 1 je 2 s),
  `{art:"anruf.*", …}` (Haken `handler('anruf.*')` für Plan 03). Server → Client: `{art:"antwort", id, ok, ergebnis|fehler}`,
  `{art:"chat", raum, ereignis, daten}`, `{art:"tippt", raum, wer, name}`, `{art:"online", nutzer:[…]}`, `{art:"fehler", fehler}`.
  Nutzer nur Aktionen aus `NUTZER_AKTIONEN`, Gäste nur `GAST_ABBILDUNG` (`chat.verlauf` → `chat.gast.verlauf` …, der Ausweis kommt vom
  Server). Grenzen: 10 Sockets je Nutzer, 3 je Gast (sonst 429), 50 Aufrufe je 10 s (`E_BREMSE`), Nachricht ≤ 1 MiB, Rückstand ≤ 4 MiB
  (sonst 1013), Ping alle 25 s. Schließcodes: 4001 abgemeldet, 4003 entfernt/Raum weg, 1001 Dienst endet, 1009 zu groß.
- **Web-Endpunkte** (`src/web/chat/http.js`): `GET /einladung/<token>` HTML-Hülle (`chat-gast.js`), ungültig → 404 ohne Skript, Bremse wie
  Freigabelinks (gemeinsame IP-Bremse); `GET /api/chat/einladung/<token>` `{raum_name, gueltig, angemeldet, gast_hier}` (ohne Raum-ID);
  `POST /api/chat/gast/beitreten {token, name}` setzt `fahnas_chatgast=<gid>.<geheimnis>` (HttpOnly, SameSite=Lax, Secure bei TLS,
  400 Tage); `GET /api/chat/gast/ich`; `POST /api/chat/gast/abmelden` (verlässt den Raum, Keks weg); `GET /api/chat/anhang?raum&anhang
  [&vorschau=128|256|512][&herunterladen=1]` (Nutzer oder Gast; aktive Typen beim Anzeigen als Text, Vorschau mit `sandbox`);
  `POST /api/chat/hochladen?raum&name` (Content-Length Pflicht). Gemischte Routen ohne Router-Sitzung, POST mit Herkunftsprüfung.
- **Oberfläche:** Ansicht `chat` (Gruppe „Zusammenarbeit“, Rolle nutzer) mit `#/chat`, `#/chat/<raum>`, `#/chat/einstellungen`,
  `#/chat/einladung/<token>`; Rahmen lädt `public/chat/rahmen.js` (Ungelesen an Navigation, Gruppenknopf und Tab-Titel „(n) …“, stumme
  Räume zählen mit); Bausteine ohne `app.js` (`verlauf.js`, `eingabe.js`, `anhang.js`, `hinweise.js`) auch für die Gastseite;
  Ordnerwahl V8 (`public/ordnerwahl.js`), Karte Handy-Meldungen V9 (`public/handy-meldungen.js`), „Im Chat teilen …“ im Dateimanager;
  Andockstellen `public/chat/erweiterungen.js` (`raumKopf`, `einstellungen`, `kachel`).
- **Kachel** `chat` „Chat“ (alle Nutzer, Standard 4×6): Summe ungelesen, Räume mit Ungelesenem zuerst (höchstens 8), Link in den Raum.
- **Verträge** V6 WebSocket + Upgrade-Verteiler, V7 SSE-Privatsphäre, V8 Ordnerwahl (`ordnerWaehlen(ctx, {titel, erklaerung, okText,
  nurSchreibbar, start, mitSystem})`), V9 persönliche Meldungen (je Schlüssel ≤ 1 in 120 s, ≤ 200 je Tag, nur Absender – nie Text),
  V10 `kopierenAls`/`stromKopieren`, V11 `PFADE.chat` – Einzelheiten im Übersichtsplan `2026-10-18-zusammenarbeit-00-uebersicht.md`.

### 20.3 Anrufe (Plan 03)

Audio- und Videoanrufe mit 2–6 Personen in Räumen und Direktnachrichten, Bildschirm teilen, Klingeln in DMs, Gäste dürfen
mit. Die Medien laufen Browser-zu-Browser (WebRTC, Vollvermaschung, „Perfect Negotiation“); das NAS vermittelt nur die
Signale und – über einen eigenen STUN/TURN-Dienst – im Notfall die verschlüsselten Pakete. Kein Mitschnitt.

- **Agent `chat.anruf`** (Rolle nutzer, Audit still) `{raum, art: beginn|ende|verpasst, video? (false), dauer_s? 0–86400, aktiv? ≤100}`
  → `{benachrichtigt, nachricht?}`; Fehler `E_NICHT_GEFUNDEN` (kein Mitglied), `E_PARAMS {feld:'art'}` (verpasst außerhalb von DMs).
  `beginn` schickt Handy-Meldungen an Mitglieder ohne den Anrufer, ohne `aktiv`, ohne stumm geschaltete; `ende` schreibt die
  Notiz `anruf_ende`; `verpasst` die Notiz `anruf_verpasst` und eine Meldung an den anderen. **Agent `chat.gast.anruf`** (Rolle gast)
  wie oben mit `ausweis`, ohne `verpasst`, fremder Raum `E_RECHTE`. **Agent `chat.turn_info`** (Rolle gast, lesend) `{}` →
  `{lan_ip, aktiv, port}` (LAN-IP aus `nasNetz`, sonst `null`).
- **Systemzeilen** `anruf_ende {dauer_s, video}` (Dauer 0 = „Anruf nicht angenommen“), `anruf_verpasst {video}` mit `wer` (Anrufer).
  Handy-Meldungen (V9): Beginn Titel = Raumname bzw. Anzeigename des Anrufers (DM), Text „<Name> ruft an“, Schlüssel
  `anruf:<raum>:<nutzer>`; Verpasst Text „Verpasster Anruf von <Name>“, Schlüssel `anruf_verpasst:<raum>:<nutzer>`.
- **WebSocket `/api/chat/ws`, Arten `anruf.*`** (`src/web/chat/anrufe.js`, nur im Speicher des Web-Dienstes): c→s
  `anruf.beitreten {raum, video}`, `anruf.verlassen {raum}`, `anruf.signal {raum, an, daten:{beschreibung?:{type:offer|answer,
  sdp ≤60000}, kandidat?}}`, `anruf.medien {raum, audio, video, bildschirm}`, `anruf.ablehnen {raum}` (nur der Angerufene in
  einer DM), `anruf.abfragen {}`; s→c `anruf.stand {raum, teilnehmer:[{id, name, gast, medien, ich}], beginn (ISO, vorbei: null)}`,
  `anruf.beigetreten {raum, id, teilnehmer}`, `anruf.signal {raum, von, daten}`, `anruf.klingelt {raum, von_name, video}`,
  `anruf.abgelehnt {raum, von_name}`, `anruf.ende {raum, grund: ersetzt|abgelehnt|keine_antwort|entfernt}`, `anruf.fehler {raum,
  fehler:{code, meldung}}`. Grenzen: 6 Teilnehmende (`E_BELEGT` „Anruf ist voll (höchstens 6)“), eine Teilnahme je Identität
  (zweites Gerät ersetzt das erste), Klingeln 45 s, Signal ≤ 64 KiB, 200 Nachrichten je Verbindung in 10 s (`E_BREMSE`).
  Signale nur zwischen Teilnehmenden desselben Anrufs; Verbindung weg = verlassen; raum_weg/gast_entfernt beenden die Teilnahme.
- **Web-Endpunkte** `GET /api/chat/ice` (Sitzung oder Gast-Keks, `Cache-Control: no-store`) → `{ice_server:[{urls, username,
  credential}], gueltig_bis}` (ohne laufenden Dienst `{ice_server:[], gueltig_bis:null}`); `GET /api/chat/turn` (Admin) →
  `{aktiv, port, lan_ip, zuteilungen, extern_zuletzt, fehler: null|keine_lan_ip|port_belegt|agent|start}`.
- **STUN/TURN** (`src/web/turn/`, im Web-Prozess, keine eigene systemd-Einheit): UDP 3478 (`chat.json` `turn.{aktiv, port}`,
  Standard an), nur IPv4/UDP; Relay-Ports fest 49160–49200 (nicht weiterleiten – Relay-zu-Relay läuft auf dem NAS). Methoden
  Binding (ohne Zugang), Allocate, Refresh, CreatePermission, ChannelBind, Send/Data-Indication, ChannelData; Fehlercodes 400,
  401, 403, 420, 437, 438, 440, 441, 442, 443, 486, 508. Zugang: `username = <ablauf_unix>:<wer>` (`wer` = Nutzer bzw.
  `gast-<gastId>`, 12 h), `credential = base64(HMAC-SHA1(geheimnis, username))`, Langzeit-Schlüssel MD5(`username:fah-nas:credential`),
  bei jeder Anfrage geprüft; Nonce mit Zeitstempel (600 s). Zuteilung 600 s (höchstens 3600), Erlaubnis 300 s, Kanal 600 s;
  höchstens 6 Zuteilungen je Identität. Gegenstellen-Filter: nie an 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
  169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, Multicast, 240.0.0.0/4 (inkl. Broadcast), `::`, `::1`, `ff00::/8`, nie an
  eigene Adressen des NAS und nie an Port 0; einzige Ausnahme die LAN-IP des NAS im Relay-Portbereich (Relay zu Relay), in
  beide Richtungen geprüft. Erlaubnisse: höchstens 8 Gegenstellen je CreatePermission (sonst 400), 128 je Zuteilung (sonst
  508). Protokoll nur Start/Stopp/Fehler; kein Paket (auch Quellport 0) kann den Web-Dienst beenden.
- **Dateien:** `/data/config/web/turn.json` `{version, geheimnis (32 Byte), extern_zuletzt}` (0600, nie im Export, höchstens alle
  600 s geschrieben). **Kopf** `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(),
  payment=(), usb=(), interest-cohort=()`.
- **Oberfläche:** Anrufen (Audio/Video) und Banner „Anruf läuft – Beitreten“ im Raumkopf, Anruf-Ebene über der ganzen Oberfläche
  (verkleinerbar, ein Anruf je Tab; Beitritt woanders legt vorher auf), Klingeln in DMs überall (Hinweis, blinkender Titel,
  Klingelton unabhängig vom Ton-Schalter), Admin-Karte „Anrufe von unterwegs“, Gastseite mit Anrufknöpfen.
- **Kachel** `chat` (4×6) zeigt zusätzlich laufende Anrufe mit „Beitreten“.

### 20.4 Office – Kern, Board, Dokument und Tabelle (Plan 04–06)

Eigene Textverarbeitung, Tabellenkalkulation und Kanban-Boards für NAS-Nutzer, allein oder gleichzeitig mit anderen. Dieser
Abschnitt beschreibt den gemeinsamen Kern und das Board; die Typen `dokument` und `tabelle` (mit docx/xlsx/csv) folgen in
Plan 05/06 und nutzen dieselben Verträge. Alles eigener Code (keine Fremd-Bibliothek, keine eingebettete App).

- **Bündel (V13, `src/gemeinsam/office.js`):** Ein Dokument ist ein Ordner `<Name>.fahdoc` (dokument), `.fahtab` (tabelle) oder
  `.fahboard` (board) in einer Freigabe. Darin `inhalt.json` = `{format:'fah-office', art, schema:1, id, version, erstellt, geaendert,
  besitzer, daten}` (höchstens 32 MiB; `daten: null` und `version: 0` = frisch angelegt), `verlauf.ndjson` mit den letzten 500 Zeilen
  `{v, op, cid?}` und `dateien/<12 Zeichen base64url>-<Name>` für Bilder und Anhänge (je höchstens 100 MiB, `DATEI_MUSTER`). Kein Bündel
  in einem Bündel. Schreiben: zuerst `inhalt.json` (Zwischendatei `.fahnas-upload-<hex>`, fsync, Stand-Prüfung direkt vor dem rename,
  Rechte-Bits bleiben), danach der Verlauf – bricht es dazwischen ab, fehlen nur Verlaufszeilen und Klienten laden neu. Stand = mtime
  von `inhalt.json` (ISO). Schnappschüsse, Papierkorb, Spiegelung und Kontingente gelten, weil es gewöhnliche Dateien sind.
- **Index `office.json`** (Konfig, 0600): `{version:1, dokumente:{<id>:{id, art, name, freigabe, pfad, besitzer, erstellt, geaendert,
  freigaben:{<nutzer>:'lesen'|'bearbeiten'}, geloescht?}}, zuletzt:{<nutzer>:[{id, zeit}]}}` (je Nutzer höchstens 20). ID = `o` + 16 Zeichen
  base64url. `geloescht` (Zeitpunkt) = das Bündel liegt im Papierkorb; der Eintrag bleibt für die Wiederherstellung. Im Konfig-Export
  enthalten, beim Import nicht übernommen (die Bündel liegen in den Freigaben, ein fremder Index zeigte auf falsche Orte). Ein Bündel
  ohne Eintrag (etwa per SMB kopiert oder verschoben) bekommt beim ersten Öffnen über seinen Ort einen: Liegt das Original nicht mehr am
  alten Ort, zieht dessen Eintrag mit (Office-Freigaben bleiben); kennt der Index die ID aus `inhalt.json` nicht, wird sie samt aktivem
  Besitzer übernommen; eine Kopie neben dem Original bekommt eine neue ID und gehört dem, der sie öffnet.
- **Zugriff (`src/agent/office/zugriff.js`):** Das höhere Recht aus den Freigabe-Rechten des Aufrufers (Admin-Sonderrecht gilt) und
  einer Office-Freigabe des Besitzers. Über die Office-Freigabe arbeitet der Dateihelfer als Besitzer und nur so weit, wie der Besitzer
  selbst noch darf (`bearbeiten` sinkt auf `lesen`, wenn er nur lesen darf); ist der Besitzer gesperrt, gelöscht oder ohne Recht, bleibt
  nur der Freigabeweg (sonst `E_RECHTE` mit Grund). Ohne jedes Recht `E_NICHT_GEFUNDEN` – wer nichts darf, erfährt nicht, dass es das
  Dokument gibt. `office.liste` rechnet für Admins ohne Sonderrecht: „Meine“ und „Für mich“ zeigen nur Eigenes und ausdrücklich
  Freigegebenes, „Zuletzt“ das selbst Geöffnete. Admins erscheinen in `geteilt_mit` nur mit einer Office-Freigabe.
- **Agent-Aktionen** (`src/agent/aktionen/office.js`, alle Rolle nutzer; Inhalte nie im Prüfprotokoll, V1):

  | Aktion | Parameter | Ergebnis | Fehler | Prüfprotokoll |
  |---|---|---|---|---|
  | `office.anlegen` | `{art, freigabe, ordner, name, beide?}` (Name 1–200 Zeichen ohne `/` `\`, nicht mit Punkt vorn) | `{id, art, freigabe, pfad, name}` | `E_EXISTIERT {name}`, `E_NICHT_GEFUNDEN` (Ordner), `E_RECHTE`, `E_PARAMS` | `{art, freigabe, ordner, name}` |
  | `office.import_setzen` | `{id, daten}` (JSON bis 16 MiB, V2) | `{version:1, stand}` | `E_PARAMS` (nicht mehr leer), `E_RECHTE` | `{id}` |
  | `office.laden` | `{id}` oder `{freigabe, pfad}` | `{id, art, name, freigabe, pfad, besitzer, recht, version, daten, stand, verlauf, schnappschuesse}` | `E_NICHT_GEFUNDEN {office?}`, `E_RECHTE`, `E_PARAMS` (beschädigt/zu groß) | kein Eintrag |
  | `office.speichern` | `{id, version, daten, ops:[{v, op, cid?}] (≤ 5000), stand?}` | `{stand}` | `E_GEAENDERT {geaendert, groesse}`, `E_RECHTE`, `E_NICHT_GEFUNDEN {office:'verschoben'}` | `{id, version}` |
  | `office.recht` | `{id}` oder `{freigabe, pfad}`, `merken?` | `{id, recht, stand}` | `E_NICHT_GEFUNDEN` | kein Eintrag |
  | `office.umbenennen` | `{id, name}` | `{id, name, pfad}` | `E_EXISTIERT`, `E_RECHTE` | Parameter |
  | `office.datei_ticket` | `{id, name (≤ 200), groesse}` | `{ticket}` (Datenkanal, schreiben) | `E_PARAMS {feld:'groesse', max}`, `E_RECHTE` | Parameter |
  | `office.datei_lesen` | `{id, datei}` | `{ticket}` (Datenkanal, lesen) | `E_NICHT_GEFUNDEN` | kein Eintrag |
  | `office.datei_kopieren` | `{id, freigabe, pfad}` (Quelle mit eigenen Rechten) | `{datei, name, groesse, mime}` | `E_PARAMS` (keine Datei, zu groß), `E_RECHTE` | Parameter |
  | `office.liste` | `{}` | `{zuletzt, meine, fuer_mich}` je `[{id, art, name, freigabe, pfad, besitzer, besitzer_name, geaendert, recht, geteilt}]` | – | kein Eintrag |
  | `office.freigaben` | `{id}` | `{besitzer, freigaben, geteilt_mit:[{name, anzeigename, recht, ueber:'freigabe'|'office'}], privat}` | `E_NICHT_GEFUNDEN` | kein Eintrag |
  | `office.freigeben` | `{id, nutzer, recht:'lesen'|'bearbeiten'|'keins'}` | `{freigaben}` | `E_RECHTE` (nicht Besitzer), `E_PARAMS` (Besitzer selbst, unbekannt) | Parameter |
  | `office.faellig` | `{}` | `{karten:[{board_id, board_name, karte_id, titel, faellig, ueberfaellig}]}` | – | kein Eintrag |
  | `office.personen` | `{}` | `[{name, anzeigename}]` (ohne Gesperrte, ohne mich) | – | kein Eintrag |

  Ereignis `office` (nur an den Web-Dienst, nie über SSE – V7): `{art:'rechte', id}` (Office-Freigaben geändert), `{art:'pfad', id,
  freigabe, pfad, name}` (umbenannt oder verschoben) und `{art:'geloescht', id}`.
- **Dateihelfer-Ops** (als Nutzer bzw. als Besitzer): `office_anlegen {wurzel, rel_ordner, name, endung, inhalt, beide}` → `{pfad, name,
  stand}` (exklusiv; `beide` = freier Name „Name (n)“), `office_lesen {wurzel, rel, mit_verlauf}` → `{inhalt, stand, verlauf?}` (prüft
  Form und Art), `office_schreiben {wurzel, rel, inhalt, stand_vorher, verlauf, verlauf_max}` → `{stand}` (`E_GEAENDERT`, wenn der Stand
  abweicht). Bilder und Anhänge laufen über die vorhandenen Upload-Ops in `dateien/`.
- **Index-Nachführung** (`nachfuehren` in `src/agent/office/index.js`, gerufen von `dateien.umbenennen`, `umbenennen_serie`,
  `verschieben`, `loeschen`, `papierkorb.wiederherstellen` und `leeren`): Pfade ziehen mit (auch in andere Freigaben); Endung weg oder
  andere Art → Eintrag weg; Papierkorb → `geloescht`; Wiederherstellen → wieder lebendig, auch unter neuem Namen; Leeren → Eintrag weg.
  Je Änderung ein Ereignis. Liegt ein Bündel nicht mehr am Index-Ort (etwa per SMB verschoben), antworten die Aktionen
  `E_NICHT_GEFUNDEN {office:'verschoben'}`, gelöschte Einträge `{office:'geloescht'}` (§6).
- **Fällige Karten:** `office.faellig` merkt sich das Ergebnis 300 s je Nutzer und liest höchstens 200 Boards (neueste zuerst).
  Morgen-Meldung täglich um 08:00 Ortszeit an alle mit eingeschalteten Handy-Meldungen und `einstellungen.office.faellig_push !== false`:
  Titel „FAH-NAS Office“, Text „1 Karte heute fällig“ bzw. „<n> Karten heute fällig“, Schlüssel `faellig:<nutzer>:<JJJJ-MM-TT>`
  (höchstens einmal am Tag).
- **WebSocket `/api/office/ws`** (V12, `src/web/office/`): Nachrichten wie V12, zusätzlich `geoeffnet.dok.schnappschuesse`, `fehler`
  mit `cid` für abgelehnte Ops, `wiederaufnehmen` auch ohne vorheriges `oeffnen` (nach einem Neustart), `neu_laden.grund` =
  `zu_alt` | `version` | `geloescht`, `{art:'recht', dok, recht}` und `{art:'umbenannt', dok, name, pfad}`; `sichtbar` wird übergangen.
  Annahme nur bei gleicher Herkunft und Sitzung ohne offenes TOTP; höchstens 10 Verbindungen je Nutzer (sonst 429), Nachrichten bis
  8 MiB, abgemeldet → 4001. Der Server (`DokumentRegister`) ist während einer Sitzung die Wahrheit: er prüft jede Op mit dem Typ,
  transformiert sie gegen den Verlauf seit `basis` und verteilt sie mit Version an alle. Bietet der Typ `aufwand(op, gegenListe)` an
  (Tabelle: Einträge × Struktur-Ops), lehnt der Server über `AUFWAND_MAX` = 250 000 mit `E_GEAENDERT` ab – der Klient bekommt
  `neu_laden` „zu_alt“, statt dass der Web-Dienst sekundenlang rechnet. Der Verlauf im Speicher hält höchstens 500 Einträge und
  `VERLAUF_ZEICHEN` = 32 Mi JSON-Zeichen an Gespeichertem (Ungespeichertes nie gekürzt). Speichern 1,5 s nach der letzten Op, spätestens
  5 s nach der ersten ungespeicherten, im Namen eines Klienten mit Schreibrecht; scheitert es, `speicherfehler` an alle und ein neuer
  Versuch nach 10 s. Alle 30 s Vergleich des Stands: außerhalb geändert → frisch laden und `extern` an alle (nichts wird still
  überschrieben). 30 s nach dem letzten Klienten wird das Dokument entladen (erst nach dem Speichern). V15: `WebDienst.stoppen()` wartet
  bis zu 20 s auf `office.abschliessen()` (alles speichern).
- **Web-Endpunkte:** `GET /api/office/datei?id&datei` (Sitzung; `office.datei_lesen` → Datenkanal, inline, Range,
  `Cache-Control: private, max-age=31536000, immutable`) und `POST /api/office/hochladen?id&name` (Sitzung + CSRF, Content-Length Pflicht,
  bis 100 MiB; `office.datei_ticket` → Datenkanal) → `{datei, name}`.
- **Typ `board`** (`public/gemeinsam/sync/typen/board.js`, Sync-Motor V12 in `public/gemeinsam/sync/`): Daten `{spalten:[{id, titel, pos}],
  karten:{<id>:{id, spalte, pos, titel, beschreibung, zustaendig, faellig, etiketten, checkliste, kommentare, anhaenge, archiviert,
  erstellt, ersteller}}, etiketten:{<id>:{name, farbe}}}`. Ops: `karte_neu`, `karte_setzen`, `karte_verschieben`, `karte_loeschen`,
  `spalte_neu`, `spalte_setzen`, `spalte_verschieben`, `spalte_loeschen {id, karten}`, `kommentar`, `checkliste`, `etikett`, `anhang`
  (und `noop`). Regeln: (1) Felder je Feld „spätere Änderung gewinnt“, (2) Verschieben „spätere gewinnt“, (3) Löschen gewinnt immer –
  Ops auf gleichzeitig gelöschte Karten oder Spalten werden Noops, (4) Reihenfolgen über Bruchindizes `pos` (0–9, a–z, höchstens 64
  Zeichen) mit der ID als Gleichstandsregel, auch für Checkpunkte, (5) Kommentare und neue Karten nur im eigenen Namen (der Server
  prüft `autorPruefen`), löschen nur den eigenen Kommentar. Grenzen: Titel 200, Beschreibung 20 000, Kommentar 5 000, Checkpunkt 500,
  Spaltentitel 80, Etikettname 40, je Karte 50 Zuständige, 20 Etiketten, 200 Checkpunkte, 1 000 Kommentare, 100 Anhänge; 10 000 Karten.
  Etikettfarben rot, orange, gelb, gruen, tuerkis, blau, lila, grau (Text mindestens 4,5:1 in hell und dunkel).
- **Oberfläche:** Ansicht `office` (Rolle nutzer, Gruppe Zusammenarbeit): `#/office` Startseite (Neu, „Zuletzt bearbeitet“, „Meine“,
  „Für mich freigegeben“, Einstellungen), `#/office/neu/<art>`, `#/office/oeffnen/<freigabe>/<pfad>` (danach `#/office/d/<id>` ohne
  neuen Verlaufseintrag), `#/office/d/<id>`. `public/office/sitzung.js`: `sitzungOeffnen({ref, ctx})` → `OfficeSitzung` (V18; je Tab und
  Dokument eine, Wiederaufnahme nach Abbruch, „eigene ungesichert“ = unbestätigte oder nach dem letzten Speichern bestätigte eigene
  Ops, `kopieSichern` legt „<Name> (meine Fassung JJJJ-MM-TT HH-MM)“ daneben an, `beforeunload` warnt bei Unbestätigtem; Ereignis
  `verworfen` `{ops}`, wenn eine fremde Op eigene unbestätigte Ops wirkungslos macht – der Tabellen-Editor meldet es, außer bei
  eigenen Löschungen, die die fremde Op schon erledigt hat).
  Editor-Vertrag V18 (`public/office/<art>/editor.js`). Board-Editor `public/office/board/` (Ziehen mit Maus/Stift ab 5 px, Touch nach
  300 ms Halten; Kartendialog mit 500 ms Ruhe je Textfeld). Import `public/office/import.js` (.docx → dokument, .xlsx/.csv → tabelle,
  immer als Kopie). Einstellung `einstellungen.office` = `{standardordner:{freigabe, pfad}|null, faellig_push}` (Standard: kein Ordner,
  Handy-Meldung an). Dateimanager: ein Bündel ist ein Element mit dem Symbol seiner Art, Doppelklick öffnet das Office, .docx/.xlsx/.csv
  fragen nach dem Import; Ordnerwahl V8 mit `dateien:true` für „Anhang aus dem NAS“.
- **Kachel** `office` (alle Nutzer, Standard 4×6): höchstens 5 zuletzt bearbeitete Dokumente und 5 meiner fälligen Karten (überfällige
  zuerst, rot), Wert „{n} fällig“; lädt beim Öffnen der Übersicht und danach höchstens alle 2 Minuten.

#### Dokument (Plan 05)

- **Datenmodell** (Typ `dokument` in `public/gemeinsam/sync/typen/dokument.js`, Delta-Kern `public/gemeinsam/sync/delta.js`):
  Delta-Ops `{insert: string | {bild:{datei, breite?, alt?}} | {seitenumbruch:true} | {tabelle:T}, attributes?}`,
  `{retain: number | {bild:{breite?, alt?}} | {tabelle:[TabOp…]}, attributes?}`, `{delete: number}`. Ein Embed hat die Länge 1,
  `null` heißt „entfernen“ und steht nie in einem `insert`; ein Dokument besteht nur aus `insert` und endet mit `\n`. Daten
  `{delta, kommentare:{<id>:{wer, name, zeit, text, erledigt, antworten:[{id, wer, name, zeit, text}]}}}` (Antworten nach `(zeit, id)`).
  Inline-Attribute: `fett`, `kursiv`, `unterstrichen`, `durchgestrichen`, `code` (je `true`), `farbe` (rot, orange, gelb, gruen,
  tuerkis, blau, lila, grau oder `#rrggbb`), `hintergrund` (gelb, gruen, tuerkis, blau, lila, rosa, orange, grau oder `#rrggbb`),
  `link` (nur http, https, mailto; höchstens 2048 Zeichen), `kommentar` (Kennung). Zeilen-Attribute nur auf `\n`: `ueberschrift`
  1–3, `zitat`, `liste` (`punkte`|`zahlen`|`aufgabe`), `erledigt`, `einzug` 1–8, `ausrichtung` (`mitte`|`rechts`|`block`);
  Standardwerte (Einzug 0, linksbündig) werden nicht gespeichert. `seitenumbruch` und `tabelle` stehen allein in ihrer Zeile.
  Tabelle `T = {id, zeilen, spalten, weg, zellen:{'<zeile>|<spalte>': Text-Delta ohne \n am Ende}, breiten:{<spalte>: px 40–2000}}`;
  `weg` sind Grabsteine (gelöschte Zeilen/Spalten bleiben in der Liste, aufsteigend sortiert); Löschen versteckt nur, Inhalte und
  Breiten bleiben gespeichert. TabOps `zelle {zeile, spalte, inhalt}`, `zeile_einfuegen {nach: id|null, id}`, `zeile_loeschen {id}`,
  `zeile_zurueck {id}` (macht wieder sichtbar; ein mitgeschicktes `zellen` bzw. `breite` bleibt ohne Wirkung), Spalten entsprechend,
  `breite {spalte, px|null}`. Zellen und Breiten wirken auch auf versteckte Zeilen/Spalten. Op `{d?, k?: {<id>: null | {neu?:{wer, name, zeit, text},
  erledigt?, antworten?: {<aid>: Eintrag | null}}}}`; Kommentare und Antworten nur im eigenen Namen (`autorPruefen`). Grenzen:
  100 000 Teil-Ops, Einfügetext 1 000 000 Zeichen, Kommentar 5 000, Name 100, 200 Antworten, Bild-`alt` 500, Bildbreite 16–2000 px,
  Tabelle 10 000 Zeilen, 1 000 Spalten, 1 000 TabOps und 20 000 Zeichen je Zelle (die Oberfläche bietet 200 × 50 an).
- **Transformation:** Delta wie Quill – an derselben Stelle steht bei `links` (`gegen` kam später) die eigene Einfügung vorn, bei
  Attributen gewinnt die spätere Op, Löschen gewinnt gegen Ändern. Embeds über Handler (`registriereEmbed`): Bild „letzte Änderung
  gewinnt“ je Feld; Tabelle (1) Zellen und Breiten: letzte Änderung gewinnt, (2) Einfügen hinter `nach` (auch hinter Grabsteinen),
  an derselben Stelle nach Kennung, (3) Sichtbarkeit derselben Zeile/Spalte (`*_loeschen` ↔ `*_zurueck`): die spätere Op gewinnt,
  (4) alles andere vertauscht sich – Eingaben in einer gleichzeitig gelöschten Zeile bleiben versteckt erhalten. Kommentare je Feld bzw. je Antwort; das Löschen eines Kommentars gewinnt.
- **Typ-Vertrag:** `anwenden` darf werfen (`SyncFehler E_PARAMS`), wenn eine Op nicht zum Stand passt; `OffenesDokument.opAnnehmen`
  fängt das ab und lehnt nur diese Op mit `fehler {cid}` ab.
- **ZIP/XML (V17, `public/office/format/`):** `zipLesen(daten) → Map(Name → Bytes)`, `zipSchreiben([{name, daten}], {zeit}) →
  Uint8Array` (Medien ungepackt, sonst deflate), `crc32(bytes)`. `ZIP_GRENZEN`: 200 MiB Summe, 100 MiB je Eintrag, Packverhältnis
  höchstens 100:1 – vor und beim Entpacken gezählt, ein lügender Kopf fällt auf. Fehler `zip_zu_gross`, `zip_kaputt`,
  `zip_nicht_unterstuetzt` (Zip64, Verschlüsselung, fremde Packverfahren). `xmlLesen(text) → {name, attribute, kinder, text}` (Text
  ungetrimmt, eine DTD wird übersprungen und nie ausgewertet, höchstens 256 Ebenen, Fehler `xml_kaputt`), dazu `xmlText`, `xmlEscape`,
  `kind`, `kinder`.
- **docx** (`public/office/dokument/docx.js`): `docxSchreiben(daten, dateiLader, {titel, autor, zeit}) → Blob` (`MIME_DOCX`),
  `docxLesen(arrayBuffer) → {daten, dateien:[{schluessel, name, blob}], fehlte:[{art, anzahl}]}` (Bilder tragen bis `verknuepfen` den
  Schlüssel `bild1`, `bild2` … als `datei`), `bildMasse(bytes)`. Fehler `docx_kaputt` bzw. die ZIP-Fehler.

  | Merkmal | Export | Import |
  | --- | --- | --- |
  | Überschrift 1–3, Zitat | Stile Heading1–3, Quote | Stile (auch über die Stilkette, Überschriften ab 4 → 3), Gliederungsebene |
  | fett, kursiv, unterstrichen, durchgestrichen | ja | ja (auch aus Zeichenstilen) |
  | Code | Zeichenstil Code (Consolas, grau hinterlegt) | Code-Stil oder Monospace-Schrift |
  | Schriftfarbe, Hervorhebung | `w:color`, `w:shd` | `w:color`, `w:highlight`, `w:shd` (Palette oder `#rrggbb`) |
  | Links | Hyperlink (extern) | nur http, https, mailto |
  | Listen Punkte/Zahlen, Einzug, Ausrichtung | Nummerierung je Block neu (alle 9 Ebenen), `w:ind`, `w:jc` | Nummerierung und Listenstile, eigener Einzug, Ausrichtung |
  | Aufgaben | ☐/☑ vor dem Text | ☐/☑/☒ vor dem Text einer Punkte-Liste |
  | Seitenumbruch | `w:br w:type="page"` | Seitenumbruch (auch `pageBreakBefore`) |
  | Bilder | PNG/JPEG/GIF eingebettet, WebP als PNG, Breite | eingebettete Bilder (Typ nach Inhalt), Breite; nicht in Zellen |
  | Tabellen | Gitter, Breiten, höchstens 200 × 50 | Zellen nach Gitterspalten, Breiten |
  | Kommentare | nein | nein (gezählt) |

  `FEHLTE_ARTEN` (Reihenfolge der Meldung): `kopfzeilen` (Kopf- und Fußzeilen), `fussnoten`, `kommentare` (Word-Kommentare),
  `diagramme`, `formen`, `textfelder`, `felder` (nur das Ergebnis bleibt), `formeln`, `objekte` (eingebettete Objekte), `bilder`
  (nicht unterstütztes Format oder Verweis), `verbunden` (verbundene Zellen), `verschachtelt` (verschachtelte Tabellen),
  `tabellengroesse` (über 200 Zeilen, 50 Spalten oder 20 000 Zeichen je Zelle). Feste Teile: `[Content_Types].xml`, `_rels/.rels`,
  `docProps/core.xml`, `docProps/app.xml`, `word/document.xml`, `word/styles.xml`, `word/numbering.xml`,
  `word/_rels/document.xml.rels`, `word/media/*`; Seite A4 mit 20 mm Rand. Kommentare werden nicht exportiert.
- **Markdown-Export** (`md.js`, `markdownSchreiben(daten) → string`): Blöcke durch eine Leerzeile getrennt, Listenzeilen ohne, leere
  Zeilen entfallen, genau ein `\n` am Ende. Listen mit 4 Leerzeichen je Ebene (`1.` dezimal je Ebene, `-`, `- [ ]`/`- [x]`),
  Überschrift `#`–`###`, Zitat `> `, Seitenumbruch `---`, Bild `![alt](<Name ohne Kennung, URL-kodiert>)`, Tabelle mit der ersten
  Zeile als Kopf. Formate `**`, `*`, `~~`, Code in Backticks, Links `[…](url)`; Unterstrichen, Farben, Hervorhebung, Kommentare und
  Ausrichtung entfallen. Escapes `\` vor `` \ ` * _ [ ] < > ``, am Zeilenanfang auch vor `# > - +` und `1.`; in Zellen `|` → `\|`.
- **Import-Modul (V18, `import.js`):** `importieren(blob, name) → {daten, dateien, fehlte: [übersetzter Text]}`; JSON über 15 MiB →
  `dok_import_zu_gross` (vor dem Senden geprüft), `zip_zu_gross` → `dok_import_zu_gross`, alles andere → `dok_import_kaputt`.
  `verknuepfen(daten, karte)` setzt nach dem Hochladen die Datei-Kennungen ein; Bilder mit unbekanntem Schlüssel fallen weg.
- **Editor** (`public/office/dokument/`): `editor.js` (Aufbau Leiste/Seite/Rand, `ed`, Export), `eingabe.js` (Tippen in einer Zeile
  über den Zeilen-Diff; `beforeinput` rechnet Enter, Löschen und Tippen über Zeilengrenzen, Ausschneiden, Formate und Rückgängig
  übers Modell; IME-Komposition läuft ungestört und wird am Ende gegen fremde Änderungen verschoben; Sicherheitsnetz: passt der
  DOM nicht zum Modell, wird ohne Op neu aufgebaut), `darstellung.js` (Zeilen, Abbildung DOM ↔ Index, nur geänderte Zeilen neu,
  Tabellen an Ort und Stelle), `modell.js`, `befehle.js`, `verlauf.js` (Rückgängig: 500-ms-Gruppen, 200 Schritte, fremde
  Änderungen verschieben den Verlauf), `werkzeugleiste.js`, `einfuegen.js` (HTML aus Word/Webseiten, Klartext), `tabelle.js`
  (Zellen senden 300 ms nach der letzten Eingabe), `bilder.js`, `druck.js`, `kommentare.js`, `cursor.js`. Exportformate `docx`, `md`,
  `pdf` (Druckdialog; `exportieren` liefert `null`, der Rahmen lädt dann nichts herunter – `exportAusfuehren`). Drucken: Kopie
  `.od-druck` ohne Bearbeitungsteile, `html.od-drucken`, `@page` A4 mit 20 mm Rand; Strg+P druckt ebenso nur den Text.
- **Kachel:** keine neue – die Kachel „Office“ aus Plan 04 listet Dokumente mit dem Symbol `dokument`.

#### Tabelle (Plan 06)

- **Datenmodell** (Typ `tabelle` in `public/gemeinsam/sync/typen/tabelle.js`, Register `TYPEN = { board, dokument, tabelle }`):
  Daten `{blaetter:[{id, name, pos, zellen:{'A1':{w?, f?}}, spalten:{'B':{breite}}, zeilen:{'3':{hoehe}}, fixiert:{zeilen}}]}`,
  Blätter nach `(pos, id)` sortiert (`pos` Bruchindex 0–9, a–z, höchstens 64 Zeichen, `zwischen` wie beim Board). `leer()` = ein Blatt
  `blatt1` „Tabelle1“ mit `pos 'i'`. **`w`** (interne Form): `'=…'` Formel (englische Namen, Trenner `,`, Dezimalpunkt, Blattbezug
  `[<blattId>]!A1`), `"'…"` Text (das führende `'` gehört nicht dazu), Zahl nach `ZAHL_INTERN = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i`,
  `TRUE`/`FALSE`, sonst Text; Text, der wie Zahl, Wahrheitswert, Formel oder `'…` aussähe, bekommt immer ein `'` (`textIntern`).
  **`f`**: `fett`/`kursiv` (`true`), `farbe`/`hinter` (`#rrggbb`, klein), `ausr` (`links`, `mitte`, `rechts`), `zahl` (`zahl2`, `euro`,
  `prozent`, `datum`, `text`); Standardwerte (`false`, `standard`) werden nie gespeichert, eine Zelle ohne `w` und `f` fehlt.
  Spaltenbreite 20–1000 px (Standard 100), Zeilenhöhe 12–400 px (Standard 24, nur aus dem Import), `fixiert.zeilen` 0 oder 1.
  Blattnamen 1–31 Zeichen ohne `: \ / ? * [ ]` und ohne `'` am Rand (prüft der Typ); Steuerzeichen, Namen nur aus Leerraum und
  doppelte Namen (ohne Groß/Klein) lehnt die Oberfläche ab (`blattNamePruefen` → `leer`, `lang`, `zeichen`, `doppelt`).
  **`GRENZEN`** (`public/office/tabelle/formeln/adresse.js`): 100 000 Zeilen, 1024 Spalten (A…AMJ), 50 000 Einträge je Zell-Op,
  200 000 Zellen und 100 Blätter je Mappe, `w` 32 767 Zeichen, Formel 8192, Name 31, Sortieren 50 000 Zellen, Import-JSON 15 MiB. Sie
  gelten für Daten und Op-Parameter, nie fürs Verschieben – nach dem Einfügen dürfen Zellen jenseits liegen, keine fällt heraus.
- **Ops** (`OP_TYPEN`: 13 Arten und `noop`; `ab` 1-basiert, Spalten als Zahl; `pruefen` verlangt genau diese Felder, sonst `E_PARAMS`):

  | Typ | Felder | Wirkung | Umkehrung (`invertieren`) |
  | --- | --- | --- | --- |
  | `zelle` | `{blatt, zelle, w?, f?}` | je Feld setzen, `null` (bei `w` auch `''`) entfernt | `zellen` mit den alten Feldwerten |
  | `zellen` | `{blatt, werte:{<adr>:{w?, f?}}}` (1–50 000) | wie `zelle` je Adresse (Einfügen, Ausfüllen, Formate, Leeren) | `zellen` mit den alten Feldwerten (in Stücken: höchstens 50 000 Einträge und 2 000 000 JSON-Zeichen je Op) |
  | `zeilen_einfuegen` | `{blatt, ab, anzahl}` | Zellen und Höhen ab `ab` rücken, Formeln aller Blätter wandern mit | `zeilen_loeschen` (+ `zellen` für Formeln, die nicht zeichengleich zurückkommen) |
  | `zeilen_loeschen` | `{blatt, ab, anzahl}` | Zellen und Höhen fallen weg, Bezüge darauf → `#REF!`, Bereiche schrumpfen | `zeilen_einfuegen` + `zellen` (gelöschte Zellen ganz, geänderte Formeln aller Blätter) |
  | `spalten_einfuegen` | `{blatt, ab, anzahl}` | wie Zeilen, mit Breiten | `spalten_loeschen` (+ `zellen`) |
  | `spalten_loeschen` | `{blatt, ab, anzahl}` | wie Zeilen, mit Breiten | `spalten_einfuegen` + `zellen` + `spalte_breite` je gelöschter Breite |
  | `sortieren` | `{blatt, bereich, spalte, absteigend, zellen}` | Schnappschuss `zellen` (jede Adresse des Bereichs, leere als `{w:null, f:LEER_F}`) wie `zellen` | `zellen` mit den alten Werten |
  | `blatt_neu` | `{blatt:{id, name, pos, zellen?, spalten?, zeilen?, fixiert?}}` | Blatt anlegen (Kennung schon da → nichts; `blatt1` nur als leeres Standardblatt) | `blatt_loeschen` mit `rest` |
  | `blatt_umbenennen` | `{blatt, name}` | Name setzen (Formeln tragen die Kennung, nichts wird umgeschrieben) | alter Name |
  | `blatt_loeschen` | `{blatt, rest:[Kennungen]}` | Blatt weg, Bezüge anderer Blätter darauf → `#REF!`; `rest` leer → Standardblatt `blatt1` | `blatt_neu` mit dem leeren Blatt (`blatt1` unter neuer Kennung) + seine Zellen als `zellen` in Stücken + `zellen` für die alten Bezüge (+ Löschen des angelegten Standardblatts) |
  | `blatt_verschieben` | `{blatt, pos}` | `pos` setzen, Blätter neu sortieren | alte `pos` |
  | `spalte_breite` | `{blatt, spalte, breite}` (px oder `null`) | Breite setzen, `null` = Standard | alte Breite |
  | `fixieren` | `{blatt, zeilen}` (0 oder 1) | erste Zeile fixieren | alter Wert |
  | `noop` | – | nichts | – |

  `anwenden` ändert nie die Eingabe und wirft nicht; Ops auf unbekannte Blätter ändern nichts. `rest` (Pflicht) = die übrigen Blätter,
  die der Auslöser kennt – ohne die Liste wäre „letztes Blatt gelöscht → Standardblatt“ neben einem gleichzeitig angelegten Blatt nicht
  konvergent. `invertieren(daten, op) → op[]` ist ein Zusatz zum Typ-Vertrag nur für Rückgängig im Editor (der Server ruft es nie).
- **Transformation** (`transformiere(op, gegen, seite)` nach V12: `'links'` = `gegen` kam später an und gewinnt Feldkonflikte, `op`
  gewinnt Gleichstände der Position):
  1. `noop` auf einer Seite → `op` unverändert.
  2. `gegen` löscht Blatt X: Ops auf X werden `noop` (auch ein `blatt_neu` mit der Kennung X); Formeln anderer Zell-Ops und neuer
     Blätter verlieren ihre Bezüge auf X (`#REF!`) wie die gespeicherten. Zwei Löschungen verschiedener Blätter führen ihre `rest`
     zusammen; dasselbe Blatt zweimal → die spätere bewirkt nichts (außer dem Standardblatt, wenn nur sie es angelegt hätte).
  3. Zell-Op (`zelle`, `zellen`, `sortieren`) gegen Zeilen/Spalten einfügen oder löschen: auf demselben Blatt wandern die Adressen
     (gelöschte Einträge fallen weg); jede Formel wandert – auf jedem Blatt – wie die gespeicherten; nichts übrig → `noop`. Bei
     `sortieren` wandern `bereich` und `spalte` mit (reine Angaben, die Wirkung tragen die Einträge).
  4. Struktur gegen Struktur (gleiches Blatt, gleiche Achse; `s…e` = Bereich von `gegen`, `m` = dessen Anzahl): Einfügen gegen
     Einfügen → davor gleich, an derselben Stelle `'links'` gleich und `'rechts'` `ab + m`, dahinter `ab + m`; Einfügen gegen Löschen →
     davor gleich, hinter `e + 1` `ab − m`, im gelöschten Bereich **oder direkt an seinem Rand** (`s ≤ ab ≤ e + 1`) `noop` – Löschen
     gewinnt, die neuen Zeilen gehen mit; Löschen gegen Einfügen → Einfügen davor `ab + m`, hinter dem eigenen Ende + 1 gleich, sonst
     `anzahl + m`; Löschen gegen Löschen → Überlappung abziehen, nichts übrig → `noop`. Andere Achse oder anderes Blatt → unverändert.
  5. Struktur-Op gegen Zell-Op → unverändert.
  6. Zell-Op gegen Zell-Op auf demselben Blatt: `'rechts'` unverändert, `'links'` verliert die Felder, die `gegen` setzt.
     **Zellen: letzte Änderung gewinnt je Feld** (Wert, Fett, Farbe … einzeln). `sortieren` setzt alle Felder seiner Einträge –
     **Sortieren ist ein Schnappschuss**: gleichzeitige Eingaben im sortierten Bereich können überschrieben werden.
  7. `spalte_breite` gegen Spalten einfügen/löschen → die Spalte wandert, gelöscht → `noop`; gegen `spalte_breite` derselben Spalte
     bei `'links'` → `noop`.
  8. `blatt_umbenennen`, `blatt_verschieben`, `fixieren` gegen dieselbe Art am selben Blatt bei `'links'` → `noop`.
  9. `blatt_neu` gegen Struktur-Ops: die Formeln der Nutzlast wandern (bei gleicher Kennung, etwa nach Rückgängig, auch Zellen und
     Maße); alles andere bleibt unverändert.

  `zusammensetzen(a, b)`: zwei `zelle`/`zellen` desselben Blatts → `zellen` (je Feld `b` über `a`; über 50 000 Einträge oder
  2 000 000 JSON-Zeichen `null`, damit keine zusammengesetzte Op die Bytegrenze `OP_MAX` sprengt);
  `spalte_breite` derselben Spalte und `blatt_umbenennen`/`blatt_verschieben`/`fixieren` am selben Blatt → `b`; sonst `null`.
  `istNoop`: `noop` sowie `zellen`/`sortieren` ohne Einträge. `auswahlTransformieren({blatt, von, bis}, op)`: Struktur-Ops auf dem
  Blatt verschieben beide Ecken (eine gelöschte Ecke landet am Anfang des gelöschten Bereichs), gelöschtes Blatt → `null`; die Sitzung
  führt damit fremde Auswahlen nach. Konvergenz (TP1) prüfen `sync_tab_transformation.test.js` (alle Paare, alle Bereichsränder) und
  `sync_tab_konvergenz.test.js` (Zufalls-Ops mit drei Klienten, Modellprüfung kleiner Stände, Review Focus 1).
- **Formelsprache** (`public/office/tabelle/formeln/`, ohne DOM; der Web-Dienst lädt `adresse.js`, `lexer.js` und `verschieben.js`
  über den Typ). Drei Schreibweisen derselben Formel (immer ohne `=`), übersetzt Token für Token (`uebersetzen.js`; nur Namen, Zahlen,
  Trenner, Wahrheits- und Fehlerwerte und Bezüge ändern sich, Leerraum und Text bleiben zeichengleich):

  | Modus | Dezimal | Trenner | Blattbezug | Funktionen, Wahrheitswerte, Fehler |
  | --- | --- | --- | --- | --- |
  | `intern` (Daten) | `.` | `,` | `[id]!A1` | englisch (`SUM`, `TRUE`, `#REF!`) |
  | `excel` (xlsx) | `.` | `,` | `Name!A1`, `'Mein Blatt'!A1` | englisch, neuere mit `_xlfn.` |
  | `anzeige` (Eingabe, Bearbeitungszeile) | `,` | `;` | `Name!A1`, `'Mein Blatt'!A1` | deutsch (`SUMME`, `WAHR`, `#BEZUG!`) |

  Vorrang von schwach nach stark: Vergleich (`= <> < > <= >=`) < `&` < `+ −` < `* /` < `^` (links-assoziativ wie Excel, `2^3^2` = 64)
  < Vorzeichen (`-2^2` = 4) < `%`. Bezüge `A1`, `$A$1`, `A$1`, `$A1`, `A1:B3`, ganze Spalten `A:A`, ganze Zeilen `1:3`, jeweils auch mit
  Blatt; der Lexer liest bis `XFD1048576`, darüber ist es ein Name (`#NAME?`). Höchstens 256 Klammer-/Funktionsebenen. Blattnamen in
  Formeln ohne Groß/Klein, bei doppelten gilt das erste Blatt; ein unbekanntes Blatt ist ein Eingabefehler, ein gelöschtes zeigt
  `#BEZUG!`. **Verschieben** (`verschieben.js`): Einfügen rückt Bezüge ab der Stelle, ein Bereich, der sie überspannt, wächst; Löschen
  macht Bezüge im gelöschten Teil zu `#REF!`, Bereiche schrumpfen (ganz gelöscht → `#REF!`); am Excel-Rand wird ein hinausgeschobener
  Einzelbezug `#REF!`, ein Bereichsende bleibt am Rand. Kopieren, Einfügen und Ausfüllen (`formelVerschieben`): relative Teile wandern,
  `$`-Teile bleiben, ein Teil unter 1 oder über den Excel-Rand → `#REF!`.
- **Funktionen** (`funktionen.js`; Argumente werden erst bei Bedarf ausgewertet; ein Bezug als Argument ist ein Bereich, ein
  1×1-Bereich zählt wie sein Wert):

  | Deutsch | Englisch | Argumente | Besonderheiten |
  | --- | --- | --- | --- |
  | `SUMME` | `SUM` | 1–255 | im Bereich nur Zahlen; direkt auch Wahrheitswerte und lesbarer Text, sonst `#WERT!` |
  | `MITTELWERT` | `AVERAGE` | 1–255 | wie SUMME; keine Zahl → `#DIV/0!` |
  | `MIN`, `MAX` | `MIN`, `MAX` | 1–255 | wie SUMME; keine Zahl → 0 |
  | `ANZAHL` | `COUNT` | 1–255 | zählt Zahlen (direkt auch lesbaren Text); Fehler zählen nicht |
  | `ANZAHL2` | `COUNTA` | 1–255 | zählt alles außer leeren Zellen (auch `""` und Fehler) |
  | `WENN` | `IF` | 2–3 | wertet nur den gewählten Zweig; ohne Sonst → FALSCH, leerer Dann-Zweig → 0; ein Bereich geht unverändert durch |
  | `UND`, `ODER` | `AND`, `OR` | 1–255 | Text und Leeres in Bereichen zählen nicht; kein Wahrheitswert → `#WERT!` |
  | `RUNDEN` | `ROUND` | 2 | halb vom Nullpunkt weg, gegen Gleitkommafehler gesichert (`RUNDEN(2,675;2)` = 2,68); negative Stellen vor dem Komma |
  | `SVERWEIS` | `VLOOKUP` | 3–4 | genau (FALSCH: mit `* ? ~`, ohne Groß/Klein) oder ungefähr (Standard, erste Spalte aufsteigend); Spalte < 1 → `#WERT!`, zu groß → `#BEZUG!`, kein Treffer → `#NV` |
  | `SUMMEWENN` | `SUMIF` | 2–3 | Summenbereich ab seiner Ecke in der Größe des Prüfbereichs |
  | `ZÄHLENWENN` | `COUNTIF` | 2 | Kriterien wie unter „Werte“; `ZAEHLENWENN` gilt auch |
  | `HEUTE`, `JETZT` | `TODAY`, `NOW` | 0 | rechnen beim Öffnen und jede Minute neu |
  | `TEXT` | `TEXT` | 2 | Formatcodes wie unter „Werte“ |
  | `VERKETTEN` | `CONCATENATE` | 1–255 | Zahlen mit Komma, WAHR/FALSCH; ein Bereich oder über 32 767 Zeichen → `#WERT!` |

  Unbekannte Funktionen bleiben in der Formel, aus Excel samt `_xlfn.`/`_xlws.`, und rechnen `#NAME?` (beim Export wieder mit
  ihrem Namen und der Vorsilbe, die `internZuExcel` klein schreibt). **Fehlerwerte:**

  | intern | Anzeige | xlsx | Wann |
  | --- | --- | --- | --- |
  | `#DIV/0!` | `#DIV/0!` | `#DIV/0!` | Division durch 0 |
  | `#NAME?` | `#NAME?` | `#NAME?` | unbekannte Funktion oder Name, nicht lesbare Formel |
  | `#REF!` | `#BEZUG!` | `#REF!` | Bezug gelöscht, Blatt fehlt, Spalte außerhalb (SVERWEIS) |
  | `#VALUE!` | `#WERT!` | `#VALUE!` | falscher Typ, Bereich, wo ein Wert gebraucht wird |
  | `#N/A` | `#NV` | `#N/A` | kein Treffer (SVERWEIS) |
  | `#NUM!` | `#ZAHL!` | `#NUM!` | Überlauf, ungültige Potenz |
  | `#CIRC` | `#ZIRKEL` | `#VALUE!` | Zirkelbezug – die ganze Schleife und was davon abhängt |
- **Werte** (`werte.js`, ohne `Intl`, damit die Anzeige nicht von der ICU-Ausstattung abhängt): Zahl, Text, Wahrheitswert, leer,
  Fehler. Datum im 1900-System von Excel samt Schaltjahrfehler (Seriennummer 1 = 01.01.1900, 60 = 29.02.1900, 61 = 01.03.1900,
  46313 = 18.10.2026, Bruchteil = Uhrzeit); Mappen im 1904-System werden beim Import umgerechnet (+1462). Zahlformate:

  | `zahl` | Anzeige |
  | --- | --- |
  | (Standard) | `1234,5`; 10 gültige Ziffern, ab 1E+11 mit Exponent (`1,23457E+11`), keine Tausenderpunkte |
  | `zahl2` | `1.234,50` |
  | `euro` | `1.234,50 €` |
  | `prozent` | `12,50 %` (0,125) |
  | `datum` | `18.10.2026`, mit Uhrzeit `18.10.2026 18:00`; außerhalb 1…2958465 wie Standard |
  | `text` | wie Standard; Eingaben bleiben Text |

  **Eingabe** (`eingabeZuIntern`, wie im deutschen Excel): leer leert; Zellformat Text → Text; `'…` → Text wie getippt; `=…` → Formel
  (deutsch, wird übersetzt; ein Fehler meldet „Die Formel enthält einen Fehler – bitte prüfen.“ und lässt das Bearbeiten offen);
  `WAHR`/`FALSCH`/`TRUE`/`FALSE`; Zahl `1.234,5`, `12,5 %` (→ `prozent`), `1.234,50 €` bzw. `€ 5` (→ `euro`); Datum `18.10.2026`,
  `18.10.26` (00–29 → 20xx), `18.10.` (laufendes Jahr), `2026-10-18`, jeweils optional mit `14:30[:15]` (→ `datum`); ungültige Daten
  und reine Uhrzeiten bleiben Text; sonst Text. Ein erkanntes Format wird nur gesetzt, wenn die Zelle noch keins hat; `=HEUTE()` und
  `=JETZT()` als ganze Formel bekommen `datum`. Zurück in die Bearbeitungszeile (`internZuEingabe`) so, dass dieselbe Eingabe wieder
  dasselbe ergibt (`'0049`, `12,5 %`, Formeln deutsch). Vergleiche: Zahl < Text < Wahrheitswert; Text ohne Groß/Klein, aber mit
  Akzenten (`Müller` ≠ `Muller`); Zahlen sind gleich, wenn 15 Stellen übereinstimmen (0,1 + 0,2 = 0,3). **TEXT-Formatcodes:** `0`
  (Pflichtziffer), `#`, `,` (Dezimal), `.` (Tausender), `%`, `"…"` und `\x` wörtlich, Abschnitte `positiv;negativ;null`, `TT`/`DD`,
  `TTT`/`TTTT` (Wochentag), `MM`/`MMM`/`MMMM`, `JJ`/`JJJJ` (auch `YY`/`YYYY`), `hh`, `mm` (direkt nach `hh` bzw. vor `ss` Minuten),
  `ss`, „Standard“. **Kriterien** (SUMMEWENN, ZÄHLENWENN): Zahl → gleiche Zahl; `>5`, `<=5,5`, `<>0`, `>=18.10.2026` → Vergleich nur
  mit Zahlen; `WAHR`/`FALSCH` → nur Wahrheitswerte; sonst Text ohne Groß/Klein mit `*`, `?`, `~`; `""` und `=` → leer, `<>` → nicht
  leer; eine leere Zelle als Kriterium zählt wie 0.
- **xlsx** (`xlsx.js`, über V17 `zipSchreiben`/`zipLesen` und `xmlLesen`): `xlsxSchreiben(daten, {titel, autor, zeit, jetzt}) → Blob`
  (`MIME_XLSX`; ein eigener Rechner rechnet die Werte mit `jetzt`), `xlsxLesen(arrayBuffer) → {daten, dateien: [], fehlte: [{art,
  anzahl, namen?}]}`; Fehler `xlsx_kaputt` bzw. die ZIP-Fehler (`zip_zu_gross`, `zip_kaputt`).

  | Merkmal | Export | Import |
  | --- | --- | --- |
  | Blätter, Reihenfolge, Namen | ja; Namen gültig gemacht (`_`, 31 Zeichen, `History` → `History_`, Doppelte ` (2)`) | ja (Chartsheets übersprungen) |
  | Text, Zahl, Wahrheitswert | gemeinsame Zeichenketten, `<v>`, `t="b"` | auch Inline-Text und formatierte Läufe |
  | Formeln | `<f>` mit Blattnamen und zwischengespeichertem Ergebnis | bekannte Formeln übersetzt, gemeinsame ausgeklappt; unbekannte Funktionen bleiben (`#NAME?`) |
  | Fehlerwerte | `t="e"`, `#ZIRKEL` als `#VALUE!` | ja; `#NULL!`, `#SPILL!`, `#CALC!` … → `=#VALUE!` |
  | Matrix- und Datentabellen-Formeln, Strukturbezüge, Blattbereiche | – | nur der Wert (`formeln`) |
  | Zahlformate | 4, 165 (`#,##0.00\ "€"`), 10, 164 (`DD.MM.YYYY`), 49 | 2/4, 5–8, 9/10, 14–17/22, 49 und eigene Codes (`€`, `%`, Datumsbuchstaben, `@`, `0.00`) |
  | fett, kursiv, Schrift- und Füllfarbe | ja (ARGB) | ja; Theme- und Index-Farben entfallen |
  | Ausrichtung | `left`, `center`, `right` | ja |
  | Spaltenbreite, Zeilenhöhe | `width = (px − 5) / 7`, `ht = px × 3 / 4` | `px = round(width × 7 + 5)`, `round(pt × 4 / 3)` |
  | erste Zeile fixiert | `pane ySplit="1" state="frozen"` | ja |
  | 1904-Datumssystem | – | umgerechnet |

  Feste Teile: `[Content_Types].xml`, `_rels/.rels`, `docProps/core.xml`, `docProps/app.xml` („FAH-NAS Office“), `xl/workbook.xml`
  (`calcPr calcId="191029" fullCalcOnLoad="1"` – Excel, LibreOffice und Numbers rechnen beim Öffnen neu), `xl/_rels/workbook.xml.rels`,
  `xl/styles.xml` (Reihenfolge numFmts, fonts, fills, borders, cellStyleXfs, cellXfs, cellStyles), `xl/sharedStrings.xml`,
  `xl/worksheets/sheet<n>.xml` (sheetViews, sheetFormatPr, cols, sheetData); Zellen jenseits von XFD1048576 werden nicht geschrieben.
  `FEHLTE_ARTEN_XLSX` (Reihenfolge der Meldung, Text `office.tab_fehlte_<art>`): `diagramme`, `pivot`, `bedingt` (bedingte
  Formatierung), `verbunden` (verbundene Zellen, der Inhalt steht in der ersten), `makros`, `bilder`, `kommentare`, `links`,
  `datenpruefung`, `formeln` (nur als Wert übernommen), `funktionen` (Formeln mit unbekannten Funktionen, Namen in der Meldung),
  `groesse` (Zellen außerhalb von 100 000 Zeilen × 1024 Spalten bzw. über 200 000 Zellen).
- **CSV** (`csv.js`): Lesen – UTF-8 (mit oder ohne BOM), UTF-16LE mit BOM, sonst Windows-1252 (eigene Tabelle); Trennzeichen aus bis
  zu 20 nicht leeren Zeilen (gleiche Anzahl in allen, die höchste gewinnt, Gleichstand `;` vor Tab vor `,`, keines → `;`); Felder nach
  RFC 4180 (`"…"`, `""`, Zeilenumbruch im Feld, CRLF/LF/CR), ein offenes Anführungszeichen nimmt den Rest; jedes Feld wie getippt
  (deutsche Zahlen und Daten, beim Komma-Trenner englische Zahlen), **nie als Formel** (`=x` bleibt Text); Blattname aus dem
  Dateinamen. Schreiben (`blattZuCsv`, aktuelles Blatt): `;`, CRLF, UTF-8 mit BOM, A1 bis zur letzten Zeile/Spalte mit Inhalt, Werte
  im **Anzeigeformat** der Zelle (`1.234,50 €`), Anführungszeichen nur wo nötig, Text mit `= + - @`, Tab oder CR am Anfang bekommt ein
  `'` davor (Excel führt ihn nicht aus).
- **Import-Modul (V18, `import.js`):** `importieren(blob, name) → {daten, dateien: [], fehlte: [übersetzter Text]}` für `.xlsx` und
  `.csv`/`.tsv`/`.txt` (Endung ohne Groß/Klein); JSON über 15 MiB (UTF-8-Byte) oder `zip_zu_gross` → `office.tab_import_zu_gross`,
  alles andere → `office.tab_import_kaputt`. `verknuepfen(daten, karte)` gibt `daten` unverändert zurück (Tabellen haben keine Dateien).
- **Editor** (`public/office/tabelle/`): `editor.js` (V18 `editorEinbinden`: Leiste, Bearbeitungszeile, Raster, Fokusfalle, Reiter;
  `ed` mit Rechner, Verlauf, Auswahl, Filter; Export), `raster.js` (virtualisiert: nur Sichtbares plus 2 Zeilen/1 Spalte Puffer, Zellen
  aus einem Vorrat per `transform`, Kopfzeile/-spalte und fixierte erste Zeile angeheftet, eigene und fremde Auswahl, Spaltengriff mit
  Vorschau, Filterknopf; ohne messbare Größe 600 × 800), `werkzeugleiste.js` (Leiste, Blätter-Reiter, Kontextmenü, Filterdialog),
  `masse.js` (Präfixsummen, sichtbarer Bereich; gezeichnet werden mindestens 100 × 26 bzw. belegt + 50 Zeilen/+ 10 Spalten),
  `auswahl.js` (Anker/Kopf, Bewegen, Tasten), `aktionen.js` (Ops aus Eingabe, Leeren, Formaten, Kopieren/Einfügen, Ausfüllen,
  Sortieren, Zeilen/Spalten, neuem Blatt), `zwischenablage.js`, `filter.js`, `verlauf.js` (Rückgängig: 100 Schritte, fremde Ops
  schieben den Verlauf, Strg+Z nimmt nur Eigenes zurück – ein Schritt, der löschen würde, was eine fremde Op geschrieben oder
  eingefügt hat (`loeschtFremdes`), fällt samt allen älteren weg; ein Schritt geht ganz oder gar nicht hinaus – besteht eine seiner Ops
  `pruefen` oder die Bytegrenze nicht, bleibt er liegen und es kommt die Meldung `office.tab_rueckgaengig_geht_nicht`), `csv.js`, `xlsx.js`, `import.js`, `formeln/` (Rechner mit
  Abhängigkeitsgraph, Zirkel `#ZIRKEL`, Ketten über 20 000 Zeilen ohne Stapelüberlauf). **Tastenkürzel** (Strg oder ⌘, nicht zusammen
  mit Alt – AltGr bleibt für Zeichen): Pfeile (Umschalt erweitert, Strg springt an den Rand des Datenblocks), Enter/Umschalt+Enter und
  Tab/Umschalt+Tab (übernehmen und weiter, die Auswahl wird eine Zelle), F2, Entf/Rücktaste (Inhalt löschen, Format bleibt), Esc
  (verwerfen), Strg+Z, Strg+Y bzw. Strg+Umschalt+Z, Strg+D (nach unten ausfüllen), Strg+B/I, Strg+A (A1 bis zur letzten belegten
  Zelle), Strg+C/X/V über die Zwischenablage-Ereignisse. **Zwischenablage:** `text/plain` als TSV (angezeigte Werte, für andere
  Programme) und `application/x-fah-tabelle` (JSON `{quelle:{z, s}, zellen:[[{w, f}|null]]}` mit Formeln und Formaten, Formeln wandern
  beim Einfügen relativ); Ausschneiden leert sofort, Einfügen verschiebt keine Bezüge; eine einzelne Zelle füllt eine größere Auswahl.
  Der **Filter** ist eine Ansicht (`ed.filter`, nur in diesem Browser-Tab, keine Op): `filterSetzen` hält die ausgeblendeten
  Zeilen fest (`versteckt`, wie „Erneut anwenden“ in Excel), Struktur-Ops verschieben sie und die Filterspalte (Spalte gelöscht →
  Filter weg). Eigene Auswahl höchstens alle 150 ms an die
  anderen, `HEUTE`/`JETZT` jede Minute neu, eine Op über `OP_MAX` = 7 340 032 Byte (`zuGross` im Typ) geht nicht hinaus (Meldung). Handy: einmal tippen wählt,
  nochmal tippen (600 ms) bearbeitet oben in der Bearbeitungszeile, „⋯“ in der Leiste öffnet das Kontextmenü. Exportformate `xlsx`
  (ganze Mappe, `<Name>.xlsx`) und `csv` (aktuelles Blatt, `<Name>.csv`, bei mehreren Blättern `<Name> - <Blatt>.csv`).
- **Kachel:** keine neue – die Kachel „Office“ aus Plan 04 zeigt Tabellen mit dem Symbol `tabelle`.

### 20.5 App-Sichtbarkeit (Plan 07, Betreiber-Nachtrag 18.10.2026)

Anlass: Ein neuer Nutzer („uwe“, Rolle nutzer) sah alle zehn installierten Apps samt Protokoll und Katalog. Betreiber: „ein neuer
Nutzer sollte keinen Zugriff auf Apps eines anderen Nutzers haben“.

- **Feld `sichtbar_fuer`** in jedem App-Satz (`apps/<name>/app.json`): Liste aus Nutzernamen und `@gruppe` (≤ 500). Fehlt das
  Feld (alle Apps von vor 0.21.0) oder ist die Liste leer → nur Admins (keine Migration). `satzSchreiben` übernimmt das Feld aus
  dem gespeicherten Satz, wenn ein neu gebauter Satz es nicht trägt (Bearbeiten, Aktualisieren, ZIP neu einspielen).
- **`appSichtbar(app, kontext, users)`** (`src/agent/aktionen/apps.js`): Admin/System immer; sonst Name oder eine Gruppe des
  Nutzers (`users.nutzer[].gruppen` bzw. `users.gruppen[].mitglieder`) in `sichtbar_fuer`.
- **Agent `apps.sichtbarkeit`** (Rolle admin) `{name, sichtbar_fuer:[…]}` → `{name, sichtbar_fuer}` (ohne Doppel, sortiert);
  unbekannter Nutzer/Gruppe → `E_PARAMS {feld:'sichtbar_fuer', wert}`; Ereignis `konfig` Bereich `apps`.
- **`apps.liste`** (Rolle nutzer): Nicht-Admins nur sichtbare Apps (vor den Docker-Abfragen gefiltert) und ohne `sichtbar_fuer`,
  `risiken`, `quelle`, `zip`, `portkonflikt`; Admins zusätzlich `sichtbar_fuer`.
- **Rollen geändert:** `apps.details`, `apps.protokoll`, `apps.katalog.liste`, `apps.katalog.eintrag` → admin (vorher nutzer).
- **Oberfläche:** Nicht-Admins ohne Katalog-Reiter und Protokoll-Knopf, Leerhinweis „Dir wurde noch keine App freigegeben“;
  Admins sehen je Karte „Sichtbar für …“ und den Knopf **Sichtbarkeit** (Dialog mit Gruppen und Nutzern ohne Admin-Rolle,
  Erklärung + Hinweis auf die Grenze); Kachel „Apps“ für Nicht-Admins mit eigenem Leertext.
- **Grenze:** Die App bleibt im Heimnetz über `NAS-IP:Port` erreichbar (Firewall bleibt aus, Betreiber-Regel) – dort schützt nur
  die Anmeldung der App selbst.

## 21. Ordnerrechte (0.23.0, Betreiber 19.10.2026)

„Ordner einer Freigabe für Nutzer/Gruppen ausschließen – kein Zugriff oder nur lesend, auf den Ordner und alles darunter.“
Entwurf: `docs/superpowers/specs/2026-10-19-ordnerrechte-design.md`.

- **Wahrheit:** `shares.json` → `freigaben[].ordnerrechte = [{pfad, regeln: {"<nutzer>"|"@<gruppe>": "lesen"|"keiner"}}]`
  (pfad relativ zur Freigabe, nie die Wurzel; nicht bei `extern`). Regeln schränken nur ein; wirksam ist das Strengste aus
  allen Regeln am Ordner und darüber. Gruppenregeln treffen jedes Nicht-Admin-Mitglied, Admins nie. Gastkonto (`gaeste`)
  bekommt die strengste Stufe des Bereichs.
- **Aktionen:** `freigaben.ordnerrechte.liste` (admin, lesend) → `{ordnerrechte:[{freigabe,pfad,regeln,vorhanden}], letzter_abgleich}`;
  `freigaben.ordnerrechte.lesen {freigabe,pfad}` (admin) → `{regeln, geerbt:{konto:{stufe,von}}, konten:[{konto,art,recht,mitglieder?}],
  admins, gaeste, darunter}`; `freigaben.ordnerrechte.setzen {freigabe,pfad,regeln}` (admin, Aufgabe; leere regeln = entfernen,
  der Bereich bekommt die Rechte darüber zurück); `freigaben.ordnerrechte.apply {gruendlich?, freigabe?, pfade?}` (system).
- **Platte:** `src/agent/freigaben/ordnerrechte-abgleich.js` – POSIX-ACL je Eintrag (Ordner mit `default:`), eigener `user:`-Eintrag
  je eingeschränktem Nutzer, Einträge eingeschränkter Besitzer → root. Kein Pfad-Abgleich als root: Öffnen über
  `/proc/self/fd/<fd>/<name>` mit `O_PATH|O_NOFOLLOW`, Werkzeuge bekommen `/proc/<agent>/fd/<n>`. Nur Abweichungen werden geschrieben.
  Abgleich: beim Speichern, bei `freigaben.apply` (Wurzeln), nach Nutzer-/Gruppenänderung (Wurzeln), stündlich gründlich, nach
  Verschieben/Kopieren/Zurückholen in einen Bereich, nach dem Zurückrollen einer Freigabe.
- **Agent:** `freigabeRechte()` liefert `bereiche` (Sperren des Nutzers) und für Admins `regelpfade`. `dateien.liste` markiert
  Ordner mit `gesperrt` / `nur_lesen` / `ordnerrecht` (Admin) und meldet `schreiben:false` + `nur_lesen_ordner` in Nur-lesen-Bereichen.
  Jede Datei-Aktion in einem gesperrten Bereich → `E_RECHTE` mit `details.gesperrt` („Nicht für dich freigegeben“), Schreiben in
  „nur lesen“ → `E_RECHTE` mit `details.nur_lesen`. Gilt auch für Freigabelinks (Rechte des Erstellers; gesperrte Ordner fehlen
  auf der Linkseite) und Schnappschüsse. Umbenennen/Verschieben in der Weboberfläche zieht Regelpfade mit, Löschen entfernt sie.
- **Ansichten:** SFTP/WebDAV-Ansicht je Nutzer: gesperrt → leeres tmpfs `fahnas-gesperrt`, nur lesen → Bind ro;
  DLNA: Bereiche mit „kein Zugriff“ für irgendwen fehlen. Eigene Über-Einhängungen in `/run/fahnas/ueber-einhaengungen.json`.
- **Oberfläche:** `public/ordnerrechte.js` (Dialog + Overlay „Nicht für dich freigegeben“), Dateimanager ⋯ → „Ordnerrechte …“ und
  Werkzeugknopf im geöffneten Ordner, Freigaben-Karte „Ordnerrechte (N)“, Kachel `ordnerrechte`.
- **Ordnergröße:** `dateien.ordnergroesse` merkt nur Läufe ≥ 1 s; jede schreibende Helfer-Operation leert die Werte der Freigabe.

## 22. Umstieg von UGOS & Co.: Speicher übernehmen, Gehäuse-LEDs und Lüfter (0.24.0, Betreiber 19.10.2026)

Entwurf: `docs/superpowers/specs/2026-10-19-ugos-umstieg-design.md`. Gewählt: je Ordner eine Freigabe, FAH-NAS regelt den Lüfter.

- **Speicher übernehmen** (`src/agent/aktionen/importe.js`, `src/agent/import/{erkennen,einhaengen}.js`, Wahrheit `importe.json`):
  `importe.suchen` (admin, Aufgabe; mdadm/lvm2 bei Bedarf, RAID zusammensetzen, LVM aktivieren, jedes fremde ext4/btrfs/xfs
  nur lesend unter /run/fahnas/import-probe ansehen) → `{volumes:[{uuid, fstype, raid, lvm, platten, herkunft, ordner:[{name,
  art:'freigabe'|'heim'|'intern', unterlaufwerk, vorschlag, rechte}], besitzer:[{uid, alt_name, vorschlag}], ugos_export}], nutzer,
  gruppen, belegt}`. `importe.uebernehmen` (admin, Aufgabe) `{volumes:[{uuid, ordner:[{ordner, name, lesen, schreiben}]}], besitzer:
  {alte_uid: name|'root'}}` → Volume unter `/data/import/<kurz>` (root 0700, Einhängepunkt chattr +i), Ordner per Bind-Mount
  (`mount --no-canonicalize` auf `/proc/<pid>/fd/<n>`) nach `/data/shares/<name>`, btrfs-Unterlaufwerke zusätzlich Ablage
  `<volume>/@fahnas-schnappschuesse/<name>` unter `/data/.snapshots/<name>`; Freigabe `importiert:{volume, ordner, schnappschuesse}`;
  danach Rechte rekursiv (fd-sicherer Abgleich) und Besitzer alte uid → neue uid (über den NAMEN, Unbekanntes → root).
  `importe.liste` (admin), `importe.trennen {uuid}` (nur aushängen, Daten bleiben), `importe.apply` (system, nach raid.apply).
  Nie formatieren, nie partitionieren, nie löschen. Samba: übernommene Freigaben `available = no`, solange nicht eingehängt.
- **UGOS-Rechte:** `tools/ugos-export.py` läuft unter UGOS (nur lesen) und legt `fahnas-ugos-export.json` in einen beschreibbaren
  Freigabe-Ordner jedes Volumes. `system.ugacl_self`: Version 1, Einträge `[art, maske, vererbung, id, 0]` (uint32 LE); art 5/6
  Nutzer, 10 Gruppe, 34 „Jeder“; maske Bit 0x2 schreiben, 0x1 lesen (0x37cf = rw, 0x1c5 = r). Abbildung über Namen.
- **Rechte auf vorhandene Dateien:** `freigaben.rechte.anwenden {name}` (admin, Aufgabe) – Freigabe-ACL auf alles, Ordnerrechte
  bleiben; bei übernommenen Freigaben automatisch nach Rechteänderung.
- **Installer:** Platten mit RAID-/LVM-/ZFS-Mitgliedern werden nie automatisch gewählt (nur mit `fahnas.platte=`).
- **Gehäuse** (`src/agent/hardware/ugreen.js`, `src/agent/aktionen/hardware.js`, `hardware.json`): nur bei DMI `DXP…`. LEDs per
  i2c-tools an SMBus I801 / 0x3a (Protokoll miskcoo/ugreen_leds_controller, MIT), Takt 300 ms, Befehle nur bei Wechsel; Schacht =
  ATA-Port. Lüfter IT8613E über /dev/port (Super-I/O 0x2e, LDN 4, EC Basis+5/+6; Steuerung 0x15… Bit 7 Automatik, Tastgrad 0x63…,
  Drehzahl 16 Bit), Modi bios/leise/normal/leistung, Kurve aus coretemp/drivetemp/nvme, Minimum 25 %, 100 % bei unlesbarer CPU oder
  Stillstand (Meldung), BIOS-Zustand in /run/fahnas/luefter-bios.json, Rückgabe beim Stopp und per `ExecStopPost`
  (`src/agent/hardware/luefter-bios.js`). Kernel-Lockdown sperrt /dev/port → Hinweis. Aktionen `hardware.status`, `hardware.einstellen`.
- **Oberfläche:** Laufwerke → Karte „Speicher aus einem anderen NAS übernehmen“ (`public/ansichten/import-karte.js`), System →
  Hardware → „Gehäuse“, Freigaben-Knopf „Rechte auf Dateien übertragen“, Kacheln `gehaeuse` und `importe`.
- **Proben:** `tests/integration/15_umstieg.mjs` (UGOS-Nachbau RAID1+LVM+btrfs/ext4 auf Loop-Dateien, 26/26), Einheitstest
  `umstieg.test.js` (nachgebauter IT8613E, LED-Prüfsummen).

## 23. Umstieg-Ausbau: alter Pfad, Unterordner-Rechte, persönliche Ordner, RAID, Docker-Übernahme, Speicherorte (0.25.0, Betreiber 19.10.2026: „bau alles – Docker-Übernahme mit“)

- **Alter Pfad** (`src/agent/import/einhaengen.js`): `importe.uebernehmen` nimmt je Volume `alter_pfad` (`/volume1` … `/volume99`);
  das Volume wird zusätzlich per Bind-Mount dort eingehängt (Einhängepunkt chattr +i, nie über vorhandene Dateien), gemerkt in
  `importe.json` (`alter_pfad`), bei `importe.apply` wieder eingehängt, bei `importe.trennen` gelöst. Vorschlag in `importe.suchen`
  (`alter_pfad`, `alter_pfad_frei`): aus dem UGOS-Export (`mount`), sonst aus dem UGOS-Namen `…_pool<N>` (am DXP4800 Plus geprüft).
- **Unterordner-Rechte:** `tools/ugos-export.py` schreibt je Freigabe-Ordner `unter:[{pfad, ugacl}]` (Unterordner mit eigener
  `system.ugacl_self`, höchstens 20 000 Ordner, Tiefe 8, ohne `#`/`@`/`.`-Ordner) und je `@home/<name>` die ugacl.
  `erkennen.ordnerrechteVorschlag` vergleicht mit den Rechten der Freigabe: weniger → Ordnerrecht `lesen`/`keiner`, mehr → Hinweis
  (Ordnerrechte schränken nur ein), Gruppenregel trifft ein Mitglied mit persönlich mehr Rechten → Hinweis. `importe.suchen` liefert
  je Ordner `ordnerrechte`, `importe.uebernehmen` nimmt `ordner[].ordnerrechte` (geprüft wie `freigaben.ordnerrechte.setzen`).
- **App-Daten:** `importe.suchen` markiert Ordner mit Compose-Dateien (im Ordner oder eine Ebene tiefer) oder Namen „docker“ als
  `app_daten`. `ordner[].rechte_lassen` → Freigabe `importiert.rechte_lassen`, KEIN Rechte-/Besitzer-Abgleich, keine Ordnerrechte,
  kein Papierkorb; `freigaben.rechte.anwenden` verweigert ohne `erzwingen:true`, Rechteänderung zieht nicht automatisch nach.
  Grund: Datenbanken (Postgres 999, MongoDB …) prüfen den Besitzer ihrer Dateien.
- **Persönliche Ordner:** `importe.uebernehmen` nimmt je Volume `heime:[{ordner:'@home/<name>', nutzer}]` → users.json
  `heim:{aktiv:true, groesse_gb:null, quelle:{volume, ordner}}`, `heim.setzen` bindet `<volume>/@home/<name>` per Bind-Mount nach
  `<daten>/homes/<nutzer>` (nie verschieben/kopieren; belegter persönlicher Ordner → Fehler). Danach Besitz → Nutzer, ACL nur Nutzer
  (fd-sicherer Abgleich). `heim.setzen` behält `quelle` (keine Grenze möglich), `aktiv:false` löst nur; Ordner gelöschter Nutzer
  werden nur gelöst (Daten bleiben auf dem Volume); `importe.trennen` löst und schaltet sie aus. `system.apply`-Reihenfolge:
  `raid.apply` → `importe.apply` → `speicherorte.apply` → `heim.apply`.
- **RAID übernommener Volumes** (`src/agent/import/raid.js`): `importe.liste` → `raid:{md, stufe, platten_soll, degraded, sync,
  fortschritt, mitglieder:[{geraet, zustand:'ok'|'defekt'|'aufbau'}]}` aus `/sys/block/<md>/md`. `importe.raid.pruefen {uuid}`
  (sync_action=check). `importe.raid.ersetzen {uuid, alt?, neu, bestaetigung}` (Aufgabe): `ersatzPlan` → `tauschen` (defektes
  Mitglied --fail/--remove/--zero-superblock), `hinzufuegen` (beeinträchtigt) oder `spiegel` (vollständiges RAID 1 →
  `mdadm --grow --raid-devices=n+1 --add`); nie eine gesunde Platte; neue Platte frei (raid.plattenLesen), ohne Spuren von
  RAID/LVM/ZFS/LUKS, mindestens so groß, Name eingetippt; Aufteilung per `sgdisk --replicate` + `-G` (nur GPT), dann Teil N.
  Takt 60 s: beeinträchtigt / wieder in Ordnung / Prüfergebnis (mismatch_cnt) als Benachrichtigung.
- **Docker-Übernahme** (`src/agent/apps/uebernahme.js`, Aktionen in `apps.js`): `apps.uebernahme.suchen` (Aufgabe) liest auf
  übernommenen Volumes `@docker/containers/<id>/{config.v2.json,hostconfig.json}` (nur lesen) → Compose-Projekte mit Dateien,
  Diensten, Images, Volumes (benannt/anonym, Größe per du), `alte_pfade`, `fehlende_pfade`, Autostart (always/unless-stopped,
  nicht von Hand gestoppt), Warnungen (Host-Netz, privilegiert, Geräte, UGOS-Pfade), PUID/PGID-Hinweise (`importe.json besitz`);
  Container ohne Compose → `einzeln`. `apps.uebernahme.starten {volume, projekte:[{projekt, name, autostart, leer:[volume]}]}`
  (Aufgabe): Volumes `docker volume create` (Compose-Labels bei `<projekt>_<kurz>`) + `rsync -aHAX --numeric-ids` (vorhandenes
  Volume mit Daten wird nie überschrieben), anonyme → `<projekt>_fahnas_<12>` + `/data/apps/<name>/fahnas-uebernahme.yml`
  (extern, ersetzt per Ziel-Pfad), App-Satz `art:'zip'`, `katalog_id:'uebernommen'`, `projekt` = altes Projekt, `compose_dateien` =
  alte Pfade (+ Zusatzdatei), `projekt_ordner` = alter Arbeitsordner (`--project-directory`), `uebernommen:{volume, quelle, ordner,
  alte_pfade, volumes, volumes_extern}`; Start mit `up -d`. Löschen fasst den alten Ordner nie an (`daten:'loeschen'` entfernt nur
  die kopierten Volumes), `apps.aktualisieren` = pull (lokale Images übersprungen) + up. `importe.trennen` verweigert, solange eine
  übernommene App das Volume oder seinen alten Pfad braucht.
- **Speicherorte** (`src/agent/import/speicherorte.js`, `src/agent/aktionen/speicherorte.js`, Wahrheit `speicherorte.json`):
  Bereiche `docker` (/var/lib/docker), `apps` (/data/apps), `vms` (/data/vms) wahlweise auf `<volume>/@fahnas/<bereich>` (btrfs:
  Unterlaufwerk) per Bind-Mount; Systemstand `/data/@<bereich>` bleibt darunter. `speicherorte.liste`, `speicherorte.setzen
  {bereich, ziel: uuid|'system'}` (Aufgabe: Platz ≥ 1,1 × belegt + 1 GiB (kleine Volumes: 10 % ihrer Größe), Ziel leer oder Rest eines Umzugs (Marke
  `.fahnas-umzug`), VMs aus; Docker stoppen → rsync -aHAX --numeric-ids (zurück: `--delete` nur in `/data/@<bereich>`) →
  umschalten → prüfen (gleiches Gerät/Inode) → Startschritt; Fehler → alter Ort wieder, nichts gelöscht),
  `speicherorte.alt_loeschen {bereich, bestaetigung}` (alten Systemstand löschen), `speicherorte.apply` (system). Beim Start:
  `systemd/fahnas-speicherorte.service` (`src/agent/import/speicherorte-start.js`: RAID/LVM, Volume, Bind) vor Docker/libvirt;
  Drop-ins `docker.service.d`/`libvirtd.service.d/fahnas-speicherort.conf` mit `Requires=`/`After=` – fehlt das Volume, starten sie
  nicht. `apps.apply` startet nichts, solange der App-Ordner-Ort fehlt. `importe.trennen` verweigert bei belegtem Speicherort.
- **Oberfläche:** Import-Assistent (alter Pfad, App-Daten, Unterordner-Rechte, persönliche Ordner), übernommene Volumes mit
  RAID-Platten, Neuaufbau-Fortschritt, „Prüfen“, „Platte ersetzen“, „Spiegel ergänzen“; Laufwerke → Karte „Speicherorte“
  (`public/ansichten/speicherorte-karte.js`); Apps → „Vom alten NAS übernehmen“ (`public/ansichten/apps-uebernahme.js`), Plakette
  „Übernommen“; Kachel `speicherorte`, Kachel `importe` mit RAID-Fortschritt.
- **Proben:** Einheitstest `umstieg_ausbau.test.js`; Integration `tests/integration/16_umstieg_ausbau.mjs`.
- **0.25.1 – Watchdog und Volume-Namen:** `tools/watchdog_halten.py` (nur UGREEN DXP, DMI) lädt `it87_wdt` (Ubuntu sperrt den Treiber
  für das automatische Laden; geladen hält der Kernel einen vom BIOS gestarteten Watchdog am Leben) oder schaltet den Watchdog des
  IT8613E ohne Treiber im Chip aus (LDN 7, 0x72 Bit 7 = Sekunden, 0x73/0x74 = 0). Läuft im Installer (Kernelparameter
  `modules-load=it87_wdt` + erster early-command) und im Ziel als `systemd/fahnas-watchdog.service` (sehr früh, vor Erststart und
  Agent; late-commands aktivieren sie, der Agent prüft sie auf DXP-Geräten). `hardware.status.watchdog {verfuegbar, zustand,
  sekunden, start_unit, schutz}`, `hardware.einstellen {watchdog:{schutz}}` = systemd `RuntimeWatchdogSec=3min` in
  `/etc/systemd/system.conf.d/fahnas-watchdog.conf` (+ daemon-reexec). Volume-Namen: `erkennen.volumeName` – alter Pfad statt des
  UGOS-Einheitsnamens „volume1“, dazu das Plattenmodell („UGOS volume3 · Samsung SSD 980 1TB“).

## 24. Apps aus FAH-Git (0.26.0, Betreiber 26.10.2026: „in FAH-NAS bei Apps ‚aus FAH-Git bauen‘ und in den Admin-Einstellungen die Verbindung zu FAH-Git inkl. Token – nur 1× ein Token, der für alle Projekte greift“)

- **Verbindung** (`src/agent/apps/fahgit.js`, Wahrheit `fahgit.json`, 0600, nur root): `{version, adresse, token, geprueft}`.
  `fahgit.verbindung` (lesend) → `{eingerichtet, adresse, schluessel_anfang, geprueft}` – der Schlüssel verlässt den Agenten nie.
  `fahgit.verbindung.speichern {adresse, token?}` prüft ZUERST (`GET /api/status` mit Bearer) und speichert nur bei Erfolg; leerer
  Schlüssel = bisheriger bleibt; nur `fgit_…`. `fahgit.verbindung.pruefen`, `fahgit.verbindung.loeschen` (gebaute Apps bleiben).
  FAH-NAS liest nur: `GET /api/baum`, `/api/projekt?pfad=` (Zweige mit Kopf-Commit), `/api/archiv?pfad=&ref=<sha>` (ZIP, höchstens
  ZIP_MAX_BYTES). Empfohlen: Schlüssel „Nur lesen“ in FAH-Git.
- **Projekte:** `fahgit.projekte` (lesend) → flach `[{pfad, slug, name, ordner, beschreibung, zuletzt, app}]` (`app` = schon daraus
  gebaute App), `fahgit.zweige {pfad}` → `{standard, leer, zweige:[{name, sha, datum, betreff, autor}]}`.
- **Bauen:** `apps.fahgit.holen {pfad, zweig?, name?}` lädt das Archiv des Kopf-Commits in den ZIP-Eingang (`<kennung>.zip` +
  `.json` mit `fahgit:{pfad, name, zweig, commit, betreff, datum}`) und liefert das Ergebnis von `apps.zip.pruefen` (+ `fahgit`;
  `installiert_als` = Apps aus demselben Projekt). Danach wie bei ZIPs: `apps.zip.installieren {…, fahgit_auto}` bzw.
  `apps.zip.aktualisieren`. Eine manage.sh ganz oben im Projekt hat Vorrang vor Compose-Datei und Dockerfile (seit 0.28.0): Die
  Dateien kommen in den App-Ordner, danach läuft `manage.sh update` ohne ZIP-Argument, weil das Archiv den Projektordner als oberste
  Ebene hat. Bestandsapps mit `zip.ohne_skript` bleiben auf dem Compose-Weg. Liegt die manage.sh tiefer, lehnt FAH-NAS mit klarer
  Meldung ab. App-Satz: `kategorie:'FAH-Git'`, `fahgit:{pfad, name, zweig, commit, betreff, datum,
  auto, eingespielt}`; `apps.liste` zeigt `fahgit` nur Admins.
- **Aktualisieren:** `apps.fahgit.aktualisieren {name, erzwingen?}` (Aufgabe) → ohne neuen Commit `{gleich:true}`, sonst holen +
  `apps.zip.aktualisieren` (Daten, .env, Anpassungen bleiben). `apps.fahgit.einstellen {name, auto?, zweig?}`.
  `apps.fahgit.stand {frisch?}` (lesend, 60 s zwischengespeichert) → `{verbunden, apps:[{name, titel, pfad, zweig, commit, betreff,
  eingespielt, auto, neu, neu_betreff, neuer, fehler, webui}]}`. Takt alle 5 min (`apps.starten()`): Apps mit `auto` und neuem
  Commit → Aufgabe `apps.fahgit.aktualisieren` (Nutzer `system`).
- **Oberfläche:** System → Grundlagen → Karte „Verbindung zu FAH-Git“ (`karteFahgit` in system-zusatz.js, Sprungziel
  `#/system/fahgit`, Suche); Apps → „Aus FAH-Git bauen“ (Projekt, Zweig, Holen und prüfen, Bauen bzw. Neuen Stand einspielen,
  „Bei neuem Commit automatisch neu bauen“), Karten mit Plakette „FAH-Git zweig @ commit“, „Neuer Stand in FAH-Git“,
  „Aus FAH-Git aktualisieren“, „FAH-Git …“ (automatisch, Zweig). Direktsprung aus FAH-Git („Auf FAH-NAS bauen“):
  `#/apps/fahgit/<projektpfad, kodiert>/<zweig>`. Übersicht-Kachel `fahgit` „Apps aus FAH-Git“.
- **Proben:** Einheitstest `apps_fahgit.test.js` (nachgestelltes FAH-Git per node:http, Compose-Weg mit Docker-Attrappe);
  Bedienprobe lokal (echter Agent + Web, echtes FAH-Git) für Karte, Dialog, Direktsprung, Kachel.
