# FAH-NAS – Abweichungen und Lücken je Teil

Hier tragen die Teile ein, was vom Vertrag (`docs/schnittstellen.md`) abweicht oder dort fehlt. Nur anhängen.

## A – Nutzer + Freigaben (Agent)

### Vertragslücken in der Grundlage (nichts geändert, lokaler Umweg)

- **`PFADE` kennt keinen Avahi-Ordner und keine Pool-Wurzel.** Der Samba-Renderer braucht `/etc/avahi/services`
  (Time-Machine-Ankündigung), `freigaben.apply` braucht die Wurzel des Datenpools für `btrfs quota enable`.
  Umweg: `samba.pfadeVon(werkzeuge)` liest `werkzeuge.pfade.avahi`, sonst `FAHNAS_AVAHI`, sonst `/etc/avahi/services`;
  die Pool-Wurzel ist `werkzeuge.pfade.daten`, sonst der Elternordner von `PFADE.shares` (`/data`).
  Vorschlag für die Grundlage: `avahi: u.FAHNAS_AVAHI || '/etc/avahi/services'` und `daten: u.FAHNAS_DATEN || '/data'` in `pfade.js`.
- **`Konfig.aendern()` schreibt immer mit 0640.** `users.json` enthält Hashes und TOTP-Geheimnisse und wird von A
  deshalb über `konfig.speichern('users.json', daten, 0o600)` geschrieben (nur root liest). `Konfig.sicherstellen()`
  legt die Datei anfangs mit 0640 an – nach dem ersten Nutzer ist sie 0600. Vorschlag: `aendern(name, fn, standard, modus)`.
- **`users.json` ist laut Entwurf §5.2 eine Liste, laut `konfig.STANDARD` ein Objekt `{nutzer:[], gruppen:[]}`.** A folgt
  der Grundlage (Objekt). Felder je Nutzer: `name, anzeigename, rolle, uid, gruppen, hash, totp|null, totp_ausstehend?,
  gesperrt, erstellt, letzte_anmeldung`; `totp = {geheimnis, wiederherstellung:[scrypt-Hashes], letzter_schritt, aktiviert}`.
  Gruppen: `[{name, erstellt}]`, Mitgliedschaft steht nur beim Nutzer (`gruppen`).

### Bewusste Ergänzungen zum Vertrag

- **Globale smb.conf-Vorlage** (`samba.globaleVorlage()`) enthält zusätzlich `private dir = /data/config/samba` und
  `passdb backend = tdbsam`: Samba-Passwörter und lokale SID liegen damit auf der Datenpartition und überleben eine
  Neuinstallation (Abnahmekriterium 8). Aus scrypt-Hashes lassen sich Samba-Passwörter nicht wiederherstellen;
  ohne diese Zeilen müsste nach jeder Neuinstallation jeder Nutzer sein Passwort neu setzen. Teil G nutzt die Vorlage
  unverändert und legt `/data/config/samba` (0700 root) VOR dem ersten Start von smbd an; `samba.rendern()` stellt den
  Ordner bei jedem Rendern ebenfalls sicher.
  Außerdem `server string = FAH-NAS`, `guest account = nobody`, `ea support = yes`, `logging = systemd` und in der
  Avahi-Datei ein `_device-info._tcp`-Eintrag (`model=MacSamba`, Mac-Symbol im Finder).
- **`useradd -u <uid>`** beim Wiederaufbau (`nutzer.apply`), damit Dateibesitz in `/data/shares` nach Neuinstallation
  stimmt; ist die uid vergeben (Exit 4), fällt useradd auf eine freie zurück und `apply` meldet eine Warnung.
- **Übernahme vorhandener Linux-Konten:** `nutzer.anlegen` legt kein neues Konto an, wenn ein Linux-Nutzer mit uid ≥ 1000
  existiert (Installer-Benutzer), sondern ergänzt Gruppen und setzt das Passwort neu (`uebernommen: true` im Ergebnis).
  Systemkonten (uid < 1000) und reservierte Namen werden abgelehnt.
- **Leere Rechte = Freigabe aus:** ohne `lesen`/`schreiben`/`gaeste` schreibt der Renderer `available = no`, weil ein
  leeres `valid users` bei Samba „jeder darf“ bedeutet.
- **Gäste dürfen lesen und schreiben** (`gaeste:true` → `guest ok = yes`, `nobody` in `valid users`, ACL `user:nobody:rwx`).
  Für „Gäste nur lesen“ braucht es ein weiteres Feld – nicht im Vertrag.
- **Time Machine ohne Papierkorb:** `timemachine:true` setzt `papierkorb` still auf `false` (Time Machine löscht alte
  Bänder selbst; ein Papierkorb würde die Platte füllen).
- **Selbstschutz:** Admin kann sich nicht selbst sperren oder löschen; der letzte (aktive) Admin ist weder löschbar,
  sperrbar noch herabstufbar.
- **Replay-Schutz bei TOTP:** ein Zeitschritt wird nur einmal akzeptiert (`letzter_schritt`).
- **`nutzer.totp.entfernen {name, passwort}`:** `passwort` ist das Passwort des Handelnden (`kontext.nutzer`), auch wenn
  ein Admin die 2FA eines anderen entfernt. Rolle `system` (CLI-Notfall) braucht kein Passwort.
- **`nutzer.totp.pruefen`** nimmt auch Wiederherstellungscodes (10 Zeichen) und antwortet dann mit
  `{ok:true, wiederherstellung:true, verbleibend:n}`.
- **Idempotenz per Prüfung:** `freigaben.apply` liest `getfacl -p` und `btrfs qgroup show -r -f --raw` und setzt nur bei
  Abweichung; Samba-Includes werden mit dem Bestand verglichen (kein testparm/reload, wenn gleich).

### Dateinamen

- TOTP liegt laut Aufgabenstellung von A in `src/agent/totp.js` (Vertrag §9 nennt `src/web/totp.js` bei D). Der Test
  heißt `tests/einheit/totp_agent.test.js`, um mit einem möglichen `totp.test.js` von D nicht zu kollidieren.
- Testhilfe `tests/einheit/nutzer_scheinsystem.js` (kein Test, wird vom Glob `*.test.js` nicht ausgeführt).

### Hinweise für andere Teile

- **G (Erststart):** globale smb.conf = `globaleVorlage()`; `alle.conf` anfangs leer anlegen (bis der Agent das erste Mal
  rendert); `mkdir -m 0700 /data/config/samba` vor dem Start von smbd. Gruppen `fahnas-nutzer`/`fahnas-admin` mit
  `groupadd -r`. Avahi-Ordner `/etc/avahi/services` muss existieren. Pakete: `acl` (setfacl/getfacl) wird gebraucht.
- **D (Web):** nach `nutzer.passwort`, `nutzer.aendern {gesperrt:true}`, `nutzer.loeschen` Sitzungen des Nutzers beenden.
  `nutzer.pruefen` liefert `{ok:false}` ohne Grund (kein Nutzer-Existenz-Orakel).
- **B (Dateien):** Papierkorb-Ordner `.papierkorb` (0770 root:fahnas-nutzer, ACL-Vererbung) liegt schon, Samba legt
  `.papierkorb/samba/<pfad>` ab; `dateien.*` darf `.papierkorb/<zeit>/…` daneben benutzen. Löschen einer Freigabe
  räumt `/data/.snapshots/<name>/*` per `btrfs subvolume delete` weg.
- **C (system.ersteinrichtung):** `intern('nutzer.anlegen', {name, passwort, anzeigename, rolle:'admin'})` übernimmt den
  Installer-Linux-Nutzer automatisch (kein E_EXISTIERT).
- **F (Oberfläche):** Erklärtexte: Gäste = lesen+schreiben ohne Anmeldung; Time Machine schaltet Papierkorb aus;
  `groesse_gb: 0` hebt das Kontingent auf.

## C – System + Export + Kommandozeile + Release-Bau

### Ergänzungen (nicht im Vertrag, aber nötig oder harmlos)

- **Aktion `system.schnittstellen`** (admin, `{}` → `[{name, mac, zustand:"oben"|"unten"}]`): erkennt Netzwerkschnittstellen
  über `ip -j link`. Die Oberfläche braucht sie, damit der Nutzer für eine feste Adresse die Schnittstelle wählen kann.
- **Aktion `system.import.ticket`** (admin, `{dateiname, groesse?}` → `{ticket, dateiname}`): Ticket „schreiben“ mit uid/gid 0
  für den Upload des Export-Archivs nach `/data/config/eingang/<dateiname>` (vom Koordinator so vorgegeben).
  `system.import` nimmt danach `{ticket}` **oder** `{dateiname}` (Kommandozeile), dazu `passwort?` und `anwenden?`
  (Standard `false` = nur Unterschiede zeigen). Ergebnis `{unterschiede, angewendet, uebernommen?, apply?, dateiname, schema}`.
- `system.status` liefert zusätzlich `ersteinrichtung_noetig`; `system.ersteinrichtung.status` zusätzlich
  `startcode_vorhanden` und `hostname`; `system.setzen` gibt `system.json` plus `_gerendert:[…]` zurück;
  `system.export` liefert zusätzlich `verschluesselt` und `mit_geheimnissen`; `system.updates.pruefen` zusätzlich
  `entfernt:[…]` und `geprueft`; `system.smart` je Platte zusätzlich `rotierend`; `system.neustart`/`herunterfahren`
  antworten `{geplant:true, in_s:2}`.
- `system.setzen` nimmt in `aenderungen` auch `vertraute_proxys` (IP oder CIDR, IPv4/IPv6) und `ssh` (boolean) an – beides
  steht im Standard von `system.json`, fehlte aber im Parameter-Vertrag. `netz` wird als Ganzes über den Bestand gelegt und
  geprüft; Wechsel auf DHCP räumt Adresse/Gateway weg.
- Export ohne Geheimnisse lässt neben Sitzungen/Bremse auch `web/tls/` weg (privater TLS-Schlüssel). Der Import fasst
  `web/`, `protokoll/` und `version.json` nie an; `users.json` wird mit 0600 geschrieben (wie A).
- `system.dienst {dienst:"ssh"}` mit `an`/`aus` rendert die Firewall mit und pflegt `system.json.ssh`, damit
  Einstellung und Regelwerk nicht auseinanderlaufen. `system.apply` setzt zusätzlich Zeitzone (`timedatectl`) und
  Platten-Ruhe (`hdparm -S`, geht beim Neustart verloren), beides idempotent.

### Lücken in der Grundlage (nur gemeldet, nicht geändert)

- `werkzeuge` des Agenten enthalten kein `render` (Vertrag §4 nennt es). Teil C importiert seine Renderer direkt.
- `src/gemeinsam/system.js`: `nutzerIds()` und `gruppenId()` rufen `befehl()` direkt statt `ausfuehren()` und sind damit im
  Test nicht ersetzbar. Teil C liest `getent passwd` deshalb im Rückfall der Ersteinrichtung selbst über `ausfuehren`.
- `smartctl` nutzt Exit-Codes als Bitmaske (Bit 3 = Platte fällt aus, Bit 4/5 = Attribute). Die Vorgabe „erlaubte Exit-Codes
  0–7“ würde gerade kranke Platten als `E_SYSTEM` melden; Teil C erlaubt deshalb alle Codes 0–255 und wertet die Bits aus.
  Platten ohne S.M.A.R.T. (USB, virtuell) bekommen `zustand:"warnung"` mit `details.hinweis`, weil der Vertrag keinen
  Zustand „unbekannt“ kennt.
- Ersteinrichtung: A bestätigt, dass `nutzer.anlegen` den Installer-Linux-Nutzer übernimmt. Der Rückfall in C
  (`chpasswd`/`smbpasswd -a -s` über stdin + Eintrag mit scrypt-Hash im Vertragsformat) greift nur noch, wenn der Bereich
  `nutzer` fehlt oder unerwartet `E_EXISTIERT` liefert.

### Was andere Teile wissen müssen

- **G (Erststart):** `/etc/nftables.conf` muss `include "/etc/nftables.d/*.nft"` enthalten und der Ordner existieren, sonst
  gehen die vom Agenten gerenderten Regeln beim Neustart verloren (der Agent lädt sie bei jedem Start per `nft -f` neu, aber
  zwischen Boot und Agent-Start wäre die Firewall offen). Symlink `/usr/local/bin/fahnas → /opt/fahnas/tools/fahnas`;
  `fahnas startcode` beim Erststart aufrufen (schreibt `/etc/fahnas/startcode` 0600 und zeigt den Code). snapper-Konfiguration
  `root` muss existieren (`system.updates.einspielen` bricht sonst bewusst ab). Pakete `hdparm`, `nftables`, `smartmontools`,
  `snapper`, `iproute2` gehören dazu. Release-Archiv entpackt G mit `tar --no-same-owner -xzf` nach `/opt/fahnas`.
- **A/B:** `system.apply` ruft `nutzer.apply`, `freigaben.apply`, `snapshots.apply` in dieser Reihenfolge (Rolle `system`);
  fehlende Aktionen werden übersprungen, Fehler einzeln gemeldet, der Lauf geht weiter.
- **D/F (Web/Oberfläche):** Export: `system.export {mit_geheimnissen, passwort?}` → Ticket „lesen“ → Datenkanal streamt die
  Datei (Dateiname aus dem Ticket, `.tar` oder `.tar.fahnas`, `mime`). Import: `system.import.ticket {dateiname, groesse}` →
  Datenkanal „schreiben“ → `system.import {ticket, passwort?, anwenden:false}` (Aufgabe) zeigt Unterschiede; zum Übernehmen
  nochmals `system.import {dateiname:<aus Ticket-Ergebnis>, passwort?, anwenden:true}` (das Ticket ist verbraucht).
  Falsches Passwort lässt die hochgeladene Datei liegen (erneuter Versuch), andere Fehler löschen sie. Ereignisse:
  `{ereignis:"system", art:"neustart"|"herunterfahren"|"update_fertig", daten:{…}}`. Bremse der Ersteinrichtung liefert
  `E_BREMSE` mit `details.warte_s`, falscher Code `E_ANMELDUNG` mit `details.verbleibend`.

## D – Web-Dienst

### D1 Grundlage `src/agent/datenkanal.js`: Antwortzeile beim Hochladen geht verloren (Halbschluss)

`net.createServer((socket) => …)` wird ohne `{ allowHalfOpen: true }` erzeugt. Beim `schreiben` schickt der Web-Dienst
den Body und beendet dann seine Schreibseite (`socket.end()`, FIN). Node beendet daraufhin auf dem Agenten-Socket
automatisch auch die Schreibseite, bevor `dd` fertig ist – `sende(socket, {ok:true})` findet `socket.writable === false`
und schreibt nichts. Der Web-Dienst bekommt nie die Antwortzeile aus §3. Nachgewiesen mit einem Minimalbeispiel
(zwei Server, einmal mit, einmal ohne `allowHalfOpen`: ohne kommt `""`, mit kommt `{"ok":true}`).

**Nötige Änderung in der Grundlage:** `this.server = net.createServer({ allowHalfOpen: true }, (socket) => …)` in
`Datenkanal.starten()`; `socket.end()` nach der Antwortzeile ruft der Agent schon selbst.

**Lokaler Umweg (D):** `api/dateien.js` liest die Antwortzeile wie vereinbart. Kommt keine, prüft der Web-Dienst über
`dateien.info {freigabe, pfad}`, ob die Datei mit genau `Content-Length` Bytes liegt → dann 200 (Protokolleintrag
`hochladen_ohne_antwort`), sonst 503 `E_AGENT`. Beide Wege sind getestet (`tests/einheit/web_api.test.js`).

### D2 Gast-Aktionen für den Web-Dienst: `nutzer.pruefen`, `nutzer.totp.pruefen`, `dateien.link.pruefen` stehen im Vertrag als „system“

Der Agent lehnt `kontext.rolle === "system"` über den Socket grundsätzlich ab (`agent.js`, „Systemrolle nur intern“).
Der Web-Dienst ruft diese drei Aktionen deshalb mit `{nutzer:"web", rolle:"gast", ip}` auf. **Stand 25.09.: A hat
`nutzer.pruefen` (nutzer.js:207) und `nutzer.totp.pruefen` (nutzer.js:278) mit `rolle: 'system'` registriert, B
`dateien.link.pruefen` (dateien.js:375) ebenso – damit ist Web-Login derzeit unmöglich. Teil A und Teil B müssen sie
auf `rolle: "gast"` umstellen** (oder die Grundlage erlaubt „system“ vom Web-Socket – nicht empfohlen), sonst antwortet der Agent `E_RECHTE` und der
Web-Dienst meldet 503 `E_AGENT` mit dem Hinweis „Der Steuerdienst erlaubt dem Web-Dienst die Aktion nutzer.pruefen
nicht“ (im Web-Protokoll als `agent_verweigert`). Genauso `system.ersteinrichtung.status` / `system.ersteinrichtung`
(Teil C) – dort steht „gast“ schon im Vertrag.

### D3 `nutzer.pruefen` sollte mehr liefern als `{ok, rolle, totp_noetig}`

`/api/ich` muss `anzeigename` und `totp` (eingerichtet) liefern; `nutzer.liste` ist admin-only. Der Web-Dienst speichert
beim Anmelden `anzeigename` und `totp` aus dem Ergebnis von `nutzer.pruefen` in der Sitzung, wenn geliefert –
sonst `anzeigename = name`, `totp = totp_noetig`. **Bitte an Teil A:** `nutzer.pruefen` → `{ok, rolle, totp_noetig,
anzeigename, totp}` (bei `ok:false` weiter ohne Grund, wie A es beschreibt).

### D4 Ergebnisform von `dateien.link.pruefen` ist im Vertrag nicht festgelegt

Der Web-Dienst akzeptiert zwei Formen: (a) direkt ein Lese-Ticket `{ticket, dateiname, groesse?, mime, art?}` – der
Agent legt es im Namen des Link-Erstellers an (bevorzugt, weil dann kein Nutzerkontext geraten werden muss);
(b) `{freigabe, pfad, nutzer, rolle?, art?}` – dann holt der Web-Dienst selbst `dateien.ticket` mit Kontext
`{nutzer, rolle}`. **Bitte an Teil B:** Form (a) liefern und unbekannte/abgelaufene Token als `E_NICHT_GEFUNDEN`
melden (Web gibt 404 „Dieser Link ist ungültig oder abgelaufen“ aus).

### D5 Grenze: Rollen-/Sperr-Änderungen außerhalb des Web-Dienstes wirken erst bei der nächsten Anmeldung

Die Rolle steht in der Sitzung; der Agent prüft `kontext.rolle` nur gegen die Mindestrolle der Aktion und schaut
nicht in `users.json`. `E_RECHTE` taugt nicht als Signal (wird auch für objektbezogene Ablehnungen wie „Nicht deine
Aufgabe“ benutzt), und `nutzer.liste` ist admin-only. Deshalb:

- Alles, was **über diesen Web-Dienst** läuft, wird sofort nachgezogen (`api/agent.js`, „Nachwirkung“; entspricht dem
  Hinweis von A an D): `nutzer.aendern` (rolle/anzeigename → Sitzungen aktualisiert; `gesperrt:true` → Sitzungen
  beendet), `nutzer.loeschen` → Sitzungen beendet, `nutzer.passwort` → andere Sitzungen des Nutzers beendet,
  `nutzer.totp.bestaetigen/entfernen` → `totp` in der Sitzung.
- Änderungen über `tools/fahnas` (CLI) oder direkt in `users.json` greifen erst mit Ablauf (12 h / 30 Tage) oder
  Abmeldung. **Empfehlung an die Grundlage:** `Agent._verbindung` könnte `kontext.nutzer` gegen `users.json`
  (gesperrt, rolle) abgleichen; dann wäre die Sitzung nur noch Träger, nicht Wahrheit.
- Ergänzt (nicht im Vertrag §5): `GET /api/sitzungen` (Admin alle, Nutzer eigene; `kennung` = 10 Zeichen der ID,
  `aktuell:true` für die eigene) und `POST /api/sitzungen/beenden {nutzer | kennung | alle_anderen:true}` für
  „Sitzungen beenden“ in der Nutzerverwaltung (Entwurf §5.4).

### D6 Kleine Ergänzungen der Web-API gegenüber §5

- `GET /api/dateien/herunterladen?…&anzeigen=1` und `GET /link/<token>?anzeigen=1` → `Content-Disposition: inline`
  (Vorschau von PDF/Bild/Video im Browser statt Download). Bereichsanfragen (`Range`) unterstützt der Datenkanal
  nicht; Video-Springen im Browser fällt damit auf „von vorn laden“ zurück.
- `GET /api/messwerte` → letzte Messung (ohne Verlauf).
- Generische Ticket-Wege für Aktionen, die selbst ein Ticket liefern (Export/Import von Teil C, Oberfläche F):
  `GET /api/agent-download?ticket=[&dateiname=&mime=&anzeigen=1]` streamt ein Lese-Ticket (Sitzung nötig; Dateiname/MIME
  werden 90 s aus dem Aktionsergebnis von `/api/agent/<aktion>` gemerkt, sonst aus der Anfrage, sonst `download`/
  `application/octet-stream`); `POST /api/agent-upload?ticket=` (Sitzung + CSRF, `Content-Length` Pflicht, Body 1:1)
  → `{ok:true, ergebnis:{groesse, bestaetigt}}`. `bestaetigt:false` heißt: keine Antwortzeile vom Datenkanal (D1) –
  die Folgeaktion (`system.import`) prüft das Archiv selbst.
- Statisch: `/public/<x>` und `/<x>` zeigen beide auf `public/<x>` (index.html von E verweist auf `/public/app.js`).
- `POST /api/ersteinrichtung` reicht bei falschem Startcode `details` des Agenten durch (C: `verbleibend`), zusätzlich
  eigene Bremse je IP (`@ersteinrichtung`).
- `POST /api/anmelden` antwortet `{ok:true, totp_noetig, ergebnis:{totp_noetig, name, rolle}}` – `totp_noetig`
  wie im Vertrag oben UND in `ergebnis`.
- Tiefe Pfade wie `/dateien` liefern laut Vertrag 404 HTML (kein SPA-Rückfall auf `index.html`). Die Oberfläche
  benutzt Hash-Navigation unterhalb von `/`; wer echte Pfade will, sagt es.
- Fehlercodes → HTTP: zusätzlich `E_TICKET` 410, `E_ABGEBROCHEN` 409, `E_BREMSE` 429, `E_ANMELDUNG`/`E_TOTP` 401.
- Eine Datei, deren gesamter Inhalt genau eine JSON-Zeile `{"fehler":{"code":…}}` ist, ist vom Fehlerprotokoll des
  Datenkanals (§3) nicht unterscheidbar und würde als Fehler ausgegeben. Längere Dateien mit diesem Anfang werden
  korrekt ausgeliefert (getestet).
- Sitzungs-ID und CSRF-Token stehen in `web/sitzungen.json` (0600); `web/bremse.json` (0600); Web-Protokoll
  `web/web-JJJJ-MM.log` (0600, Aufbewahrung `system.json.aufbewahrung.protokoll_monate`).

### D7 systemd-Hinweise für Teil G

- `fahnas-web.service` braucht `ReadWritePaths=/data/config/web` und Lesezugriff auf `/data/config/system.json`
  (0640 root:fahnas laut Grundlage – der Nutzer `fahnas` muss in der Gruppe sein).
- `Type=notify` wird unterstützt (`systemd-notify --ready` nach `starten()`), sonst `Type=simple`.
- Zertifikat wird beim ersten Start vom Web-Dienst selbst erzeugt (`openssl req …`, Ordner `web/tls` 0700, `key.pem`
  0600) – der Erststart muss es nicht anlegen; `openssl` muss installiert sein (ist es auf Ubuntu Server).
- HSTS nur mit `FAHNAS_HSTS=1` (Teilprojekt 4 setzt es, wenn ein gültiges Zertifikat liegt).
- Start als Programm: `node /opt/fahnas/src/web/web.js`; Ports über `FAHNAS_WEB_PORT`/`FAHNAS_HTTP_PORT`;
  Port 0 = zufällig (Tests).

## B – Dateien + Schnappschüsse (Agent)

### Abweichungen vom Vertrag

- **`dateien.link.pruefen` hat Rolle `gast`, nicht `system`.** Der Agent lehnt `kontext.rolle === "system"` über den
  Socket ab (`agent.js`, „Systemrolle nur intern“); der Web-Dienst ruft die Aktion für `GET /link/<token>` aber ohne
  Sitzung auf (siehe D2). Der Token (32 Byte, base64url) ist das Geheimnis. Ergebnis ist Form (a) aus D4:
  `{ticket, dateiname, groesse?, mime, art:"lesen"|"zip", freigabe, pfad, nutzer, ablauf}` – das Ticket wird im Namen des
  Link-Erstellers angelegt (uid/gid des Erstellers, Rechte werden beim Einlösen neu geprüft; gesperrter Nutzer oder
  entzogenes Freigabe-Recht → `E_RECHTE`). Unbekannt/abgelaufen → `E_NICHT_GEFUNDEN`.
- **Papierkorb-Ordnername ohne Doppelpunkte:** `.papierkorb/2026-09-25T08-33-38-082Z/<pfad>` statt reiner ISO-Zeit, weil
  Windows-Clients über Samba keine `:` in Namen darstellen können. Die exakte Zeit steht in `papierkorb.json`
  (`{herkunft, nutzer, zeit, eintraege:[{pfad, name, art, groesse}]}`; `herkunft` = gemeinsamer Elternpfad der gelöschten
  Einträge, `""` = Wurzel). Kollision in derselben Millisekunde → Suffix `-2`, `-3` …
- **Schnappschuss-Kennung in UTC:** `<JJJJ-MM-TTThh-mm-ss>[-manuell|-plan|-sicherheit]` aus `toISOString()` (ohne `Z`).
  Die Ortszeit zeigt die Oberfläche aus dem Feld `zeit` (ISO UTC). Kollision (stündlich und täglich in derselben Sekunde)
  → Sekunde wird hochgezählt, `zeit` bleibt die echte.
- **Begleitdatei je Schnappschuss:** `/data/.snapshots/<freigabe>/<id>.json` = `{id, zeit, art, takt?, beschreibung, nutzer}`.
  Der Schnappschuss selbst ist nur lesbar, deshalb liegt die Beschreibung daneben. Fehlt sie (von Hand angelegt), werden
  Zeit und Art aus dem Namen abgeleitet, die Zeit optional aus `btrfs subvolume show` (Creation time). Verwaiste
  Begleitdateien räumt `snapshots.liste` weg. **Teil A (freigaben.loeschen) löscht bereits `/data/.snapshots/<name>/*` –
  die `.json`-Dateien bitte mitnehmen bzw. den Ordner ganz entfernen.**
- **`behalten` 0/fehlend = Standard, nicht „unbegrenzt“:** stündlich 24, täglich 7, wöchentlich 4, pre/post 10
  (`render/snapper.js: anzahlBehalten`). Gilt für Freigaben-Zeitplan und snapper-Konfiguration gleich.
- **Zeitplan holt nach:** fällig ist ein Takt, wenn die letzte Fälligkeitsgrenze (stündlich :00, täglich 03:00,
  wöchentlich Sonntag 03:30, Ortszeit) nach dem letzten Lauf liegt – war der Agent zur Minute 0 aus, wird beim nächsten
  Minutentakt nachgeholt (auch beim ersten `apply` nach Neuinstallation). Zustand in `snapshots_zustand.json`
  `{letzte:{<freigabe>:{stuendlich, taeglich, woechentlich}}, letzter_lauf, platte_voll_gemeldet}`.
  `snapshots.apply` führt sofort einen Durchlauf aus (nicht erst nach 60 s).
- **95 %-Sperre** gilt für Zeitplan UND manuelle Schnappschüsse UND Zurückrollen (`E_PLATZ`); das Ereignis
  `{ereignis:"system", art:"platte_voll", daten:{prozent, gesamt, frei, hinweis}}` kommt höchstens einmal je Stunde.
  Schlägt `df` fehl, wird NICHT gesperrt (stderr-Meldung) – ein kaputtes df ist keine volle Platte.
- **`gaeste:true` heißt in `dateien.*`: jeder angemeldete Nutzer darf LESEN.** Schreiben nur über die `schreiben`-Liste
  oder als admin. A rendert Gäste in Samba mit lesen+schreiben – das ist eine Interpretation des fehlenden Felds; wer
  Gäste im Dateimanager schreiben lassen will, ergänzt `schreiben` oder ein Feld `gaeste_schreiben`.
- **`snapshots.system.standard` setzt voraus, dass `/` NICHT mit festem `subvol=@` eingehängt wird** (fstab/Kernelzeile),
  sonst gewinnt `subvol=@` gegen `btrfs subvolume set-default`. **Hinweis an Teil G (`partitionen.sh`/fstab):** `/` ohne
  `subvol=`, Standard-Unterlaufwerk per `set-default` auf `@`; `/.snapshots`, `/var/log`, `/data/*` weiter mit `subvol=`.
  Ablauf im Kommentar über der Aktion (Kopie `/@_zurueck_<zeit>` bei nur lesbarem Schnappschuss, `set-default`, `update-grub`).

### Ergänzungen (nicht im Vertrag, harmlos)

- `dateien.liste`: Parameter `absteigend?`, `versteckte?`; Ergebnis zusätzlich `freigabe`, `schreiben` (darf der Nutzer
  hier schreiben) und `papierkorb` (Freigabe hat Papierkorb) – die Oberfläche kann Knöpfe danach schalten.
- `dateien.verschieben`/`kopieren`/`snapshots.zurueckholen`: Parameter `ueberschreiben?` (Standard `false` →
  `E_EXISTIERT`, wenn am Ziel schon etwas liegt). Ergebnis `{uebertragen:[{von, nach}], bytes}`. Verschieben über
  Unterlaufwerksgrenzen (andere Freigabe → `EXDEV`) fällt auf Kopieren+Löschen zurück. Kopien nutzen `COPYFILE_FICLONE`
  (btrfs teilt Blöcke), Symlinks bleiben Symlinks, Zeiten bleiben.
- `dateien.loeschen`: Ergebnis `{geloescht, endgueltig, papierkorb:<id>|null}`; Freigabe mit `papierkorb:false` löscht
  immer endgültig. `dateien.papierkorb.liste` → `[{id, quelle:"fahnas"|"samba", zeit, nutzer, herkunft, eintraege:[…]}]`;
  Samba-Einträge (`.papierkorb/samba/<pfad>`, vfs_recycle mit keeptree) erscheinen je Datei mit `id:"samba"`.
  `dateien.papierkorb.wiederherstellen {freigabe, eintraege:[{id, pfad?}]}` (bei `samba` ist `pfad` Pflicht) →
  `{wiederhergestellt:[…], uebersprungen:[{pfad, grund}]}` – belegte Ziele werden übersprungen, nicht überschrieben.
  `dateien.papierkorb.leeren` → `{entfernt, bytes}`.
- `dateien.info`: zusätzlich `pfad`, `besitzer` als Name (aus `users.json` per uid, sonst `uid <n>`), `eintraege` (Anzahl
  bei Ordnern), `ziel` (bei Symlinks), `bild:{breite, hoehe}` für PNG/GIF/JPEG aus dem Dateikopf.
- `dateien.ticket` prüft beim Schreiben Elternordner (vorhanden, für den Nutzer beschreibbar) und freien Platz per
  `df -B1 --output=size,avail` sowie – bei `groesse_gb` – das btrfs-Kontingent (`btrfs qgroup show -reF --raw`;
  Quoten aus → kein Deckel). ZIP-Ticket der Wurzel heißt `<freigabe>.zip`.
- `dateien.link.*`: Ablage `links.json` als Liste `[{token, freigabe, pfad, nutzer, dateiname, art, erstellt, ablauf}]`;
  `url` ist relativ (`/link/<token>`), der Web-Dienst setzt Host/Schema davor. `dateien.link.liste` zeigt eigene Links,
  admin alle. Abgelaufene werden bei jedem Lesen entfernt.
- `snapshots.liste` (Freigabe) liefert zusätzlich `takt` (bei Zeitplan-Ständen) und `nutzer`; System-Einträge zusätzlich
  `groesse` (used-space aus `--jsonout`, wenn vorhanden) und `pre` (Nummer des pre-Standes bei post).
- `snapshots.durchsuchen` nimmt `sortierung/absteigend/versteckte` wie `dateien.liste`; Ergebnis mit `nur_lesen:true`.
- `snapshots.plan.setzen` gibt `{plan, gerendert}` zurück; `snapshots.apply` `{gerendert, zeitplan:"aktiv", angelegt, geloescht}`.
- `snapshots.zurueckrollen` weigert sich mit `E_BELEGT`, wenn `<freigabe>.neu` oder `<freigabe>.alt` noch existieren
  (Rest eines abgebrochenen Laufs – von Hand prüfen).
- `render/snapper.js` trägt „root“ in `SNAPPER_CONFIGS` von `/etc/default/snapper` ein (ENV `FAHNAS_SNAPPER_DEFAULT`),
  falls die Datei existiert; `systemctl enable --now snapper-timeline.timer snapper-cleanup.timer` bei jedem Rendern
  (idempotent). Startmenü-Datei per ENV `FAHNAS_GRUB_CFG` (Standard `/boot/grub/grub.cfg`).

### Lücken in der Grundlage (nur gemeldet)

- `PFADE` kennt keine Pfade für snapper-Konfigurationen, `/etc/default/snapper` und `grub.cfg`; B liest eigene ENV-Variablen
  (`FAHNAS_SNAPPER`, `FAHNAS_SNAPPER_DEFAULT`, `FAHNAS_GRUB_CFG`). Vorschlag: in `pfade.js` aufnehmen.
- `werkzeuge.system.starten` (spawn) ist nicht über `_test.setzeBefehl` ersetzbar; B nutzt es für Aufgaben mit
  Live-Fortschritt (Helfer-Zeilen) und ersetzt in Tests das ganze `werkzeuge.system`-Objekt.
- Der Helfer bekommt vom Agenten `uid/gid`; `system.befehl` reicht sie an `execFile` durch – auf dem Zielsystem läuft der
  Agent als root, sonst scheitert das mit `EPERM`. Tests verwerfen die Option.

### Hinweise für andere Teile

- **C (`system.apply`):** ruft `snapshots.apply` bereits – gut so; damit läuft der Minutentakt ab Agent-Start.
- **D (Web):** `GET /link/<token>` → `dateien.link.pruefen` mit Gast-Kontext liefert direkt das Ticket (Form a). Bei
  Aufgaben (`dateien.kopieren/verschieben`, `snapshots.zurueckholen/zurueckrollen`) kommt der Fortschritt über die
  Aufgaben-Ereignisse; `E_ABGEBROCHEN` nach `agent.aufgabe_abbrechen` (Helfer wird per SIGTERM beendet, nach 15 s SIGKILL).
- **E (Dateien-Ansicht):** Formen oben; `dateien.liste` liefert `schreiben`/`papierkorb` zum Schalten der Knöpfe;
  `eltern` ist `null` an der Wurzel, sonst der Elternpfad (`""` = Wurzel).
- **F (Schnappschüsse):** Freigabe-IDs sind Zeichenketten wie `2026-09-25T08-30-00-plan`, System-IDs Nummern als Text.
  `snapshots.system.standard` → `{neustart_noetig:true, hinweis, unterlaufwerk, kopie_angelegt}`. Plan-Felder:
  `zeitplan:{stuendlich, taeglich, woechentlich}`, `behalten:{stuendlich, taeglich, woechentlich, pre_post}`; Erklärtext
  „0 = Standard (24/7/4/10)“.
- **G (Erststart):** `/data/.snapshots` und `/data/.snapshots/<freigabe>` legt B mit 0755 an (Nutzer müssen hinein, der
  Inhalt trägt die Rechte der Freigabe). snapper-Konfiguration `root` wird von B überschrieben – `snapper -c root
  create-config /` beim Erststart reicht; Pakete `snapper`, `grub-btrfs`, `btrfs-progs`, `coreutils` (`df`, `mv`).
  Für `snapshots.system.standard` siehe oben (`/` ohne `subvol=@`).

## F – Oberfläche Verwaltung

Stand nach Abgleich mit dem gelieferten Rahmen von E (`public/app.js`, `api.js`, `sprache.js`, `stil.css`, `ansichten/index.js`).

### F1 Registrierung in `public/ansichten/index.js` (Datei von E) – zwei Einträge passen nicht zur Fachlichkeit

E hat eingetragen: `freigaben` **admin** (30), `nutzer` **admin** (40), `snapshots` nutzer (50), `system` admin (60).
Aus F-Sicht nötig:

```js
{ id: 'freigaben', datei: 'freigaben.js', rolle: 'nutzer', reihenfolge: 30 },  // Rolle nutzer: eigene Freigaben + Verbindungshinweis
{ id: 'nutzer',    datei: 'nutzer.js',    rolle: 'nutzer', reihenfolge: 40 },  // Rolle nutzer: „Mein Konto“ (Passwort, 2FA, Sitzungen)
```
Die Ansichten selbst tragen `rolle: 'nutzer'` und blenden Verwaltungsteile für Nicht-Admins aus (im Browsertest geprüft:
Rolle nutzer sieht in Freigaben nur „Verbinden“, in Nutzer nur „Mein Konto“). Mit E's aktueller Registrierung kann ein
normaler Nutzer weder sein Passwort/2FA ändern noch den SMB-Verbindungshinweis sehen. Bitte E oder Koordinator anpassen
(alternativ ein eigener Navigationspunkt „Mein Konto“ auf `nutzer.js`). `system` mit 90 statt 60 wäre laut Vorgabe der letzte Platz –
unkritisch.

### F2 Zusätzliche Dateien in `public/ansichten/` (nicht in §9 genannt, eigener Namensraum)

- `verwaltung-hilfen.js` / `verwaltung-hilfen.css`: gemeinsame Bausteine der sechs Ansichten (Elemente ohne innerHTML,
  Felder mit Erklärtext, Schalter, Dialog-Griff, Aufgaben-Fortschritt, Formatierung, Rückfall-Stil). Das CSS laden die
  Ansichten selbst, einmalig, relativ zu `import.meta.url`.
- `nutzer.qr.js`: eigener QR-Encoder (Byte-Modus, Stufe M, Version 1–10) für die 2FA-Einrichtung; Chromes
  `BarcodeDetector` liest die gezeichnete otpauth-URI im Browsertest exakt zurück.
- `ersteinrichtung.js` importiert `kopfMitLogo`/`angemeldet` aus `anmeldung.js` und lädt `anmeldung.css` nach.
- Alle Module sind ohne DOM importierbar (Node-Tests).

### F3 Was F vom Rahmen (E) benutzt – und wo E noch etwas tun könnte

- **ctx**: `api/get/post` (ergebnis bzw. `{aufgabe}`, Fehler = `ApiFehler` mit code/meldung/details/status), `sse.on` →
  Abmeldefunktion, `t` (flache Schlüssel `bereich.schluessel`, Platzhalter `{x}`), `nutzer`, `rolle`, `hostname`, `hashFuer`,
  `format.groesse/zeitGenau` (einheitliche Einheiten), `melden`, `bestaetigen`, `dialog(inhalt, {titel, breit, beimSchliessen})`
  → `{schliessen, element, koerper}`, `angemeldet()`, `designSetzen()`. Ohne Rahmen (Tests) fallen die Ansichten auf eigene
  Umsetzungen zurück (eigener `<dialog class="dialog">`, eigene Formatierung, `location.reload()`).
- **Stilklassen**: `.feld` (Wrapper) > `label.feld-beschriftung`, `.eingabe`, `p.erklaerung`; `label.schalter` >
  `span.schalter-beschriftung` + `input[type=checkbox]` + `p.erklaerung` (E's Kippschalter); `.hinweis.hinweis-info|-warnung|-fehler`;
  `.plakette(-warnung|-erfolg|-gefahr)`; `.ampel.ampel-aktiv|-inaktiv|-fehler`; `.fortschritt > .fortschritt-balken` (+ `.warnung`/`.gefahr`);
  `.tabelle` in `.tabelle-huelle`; `.knopf-klein`; `.dialog-knoepfe`. Eigene Klassen mit Vorsilben `vw-`, `an-`, `fg-`, `nu-`, `sn-`, `sy-`;
  Variablen `--fahnas-text-schwach`, `--fahnas-warnung`, `--fahnas-erfolg`, `--fahnas-flaeche-2` mit Rückfallwerten. Keine Inline-Stile
  (CSP); Balkenbreiten per CSSOM.
- `sprache.js` listet den Bereich `ersteinrichtung` – eine solche Datei gibt es nicht (Texte der Ersteinrichtung liegen laut §9
  in `anmeldung.json`); der Ladeversuch erzeugt eine 404-Zeile in der Browserkonsole. E kann den Eintrag streichen.
- `titel(t)` nimmt den Übersetzer, wie E ihn übergibt; ohne Argument deutscher Fallback. Navigation zu den Schnappschüssen aus dem
  Freigaben-Dialog über `ctx.hashFuer('snapshots')`.
- E's `.solo-ansicht` begrenzt Anmeldung/Ersteinrichtung auf 440 px Breite – die Ersteinrichtungskarte (gedacht 520 px) fügt sich dem.

### F4 Web-API-Wege, die F benutzt (D hat sie in D5/D6 bestätigt)

- Export: `system.export {mit_geheimnissen, passwort?}` → `GET /api/agent-download?ticket=&dateiname=`.
- Import: `system.import.ticket {dateiname, groesse}` → `POST /api/agent-upload?ticket=` (Body = Datei, CSRF-Kopf
  `X-FAHNAS-CSRF` aus Cookie `fahnas_csrf`) → `system.import {ticket, passwort?, anwenden:false}` (Aufgabe, zeigt
  `unterschiede`) → `system.import {dateiname, passwort?, anwenden:true}` (Ticket ist verbraucht, wie C beschreibt).
  `unterschiede` wird generisch gezeigt (Liste `[{bereich|pfad|schluessel, alt, neu}]` oder Objekt).
- Sitzungen: `GET /api/sitzungen` (Zahl eigener Sitzungen in „Mein Konto“), `POST /api/sitzungen/beenden
  {alle_anderen:true}` bzw. `{nutzer}` (Admin: „Abmelden“ je Nutzerzeile, mit Bestätigung). „Sitzungen beenden“ (Entwurf §5.4) ist damit umgesetzt.
- 2FA-Anmeldung: `POST /api/anmelden/totp {code}` – ein Wiederherstellungscode geht im selben Feld (A erkennt ihn an der Länge).
- Netz: `system.schnittstellen` (C) füllt die Schnittstellen-Auswahl (Name · MAC · verbunden/kein Kabel); fehlt die Aktion, bleibt ein Textfeld.

### F5 Vertragsauslegungen für A/B/C

- `groesse_gb` ist zugleich Kontingent und Time-Machine-Größe (nur ein Feld im Vertrag); `0` = unbegrenzt/aufheben.
  Time Machine an → Papierkorb-Schalter wird ausgeschaltet und gesperrt (A schaltet ihn serverseitig ebenfalls aus). Erklärtexte
  nach A: Gäste = lesen UND schreiben ohne Anmeldung; ohne Rechte und ohne Gäste ist die Freigabe für niemanden erreichbar.
- Gruppenmitglieder werden über `nutzer.aendern {name, gruppen}` je Nutzer gepflegt (keine Aktion je Gruppe im Vertrag).
- `snapshots.system.startmenue` wird als `[{id, titel|name, zeit?}]` oder `[string]` gelesen; `snapshots.zurueckholen`
  darf `{anzahl}` liefern (sonst Zahl der gewählten Pfade). `snapshots.plan.lesen` als `{plaene:[…]}` oder Liste.
- `system.setzen`-Ergebnis: Schlüssel mit `_` (z. B. `_gerendert` von C) werden nicht in den Konfigurationsstand übernommen.
- Login-Fehler: `E_RECHTE` beim Anmelden wird als „Konto gesperrt“ angezeigt; `E_BREMSE` zeigt `details.warte_s` als
  laufenden Zähler und sperrt den Knopf; Ersteinrichtung zeigt `details.verbleibend` (C) und `E_BREMSE`.

### F6 Nicht umgesetzt / Grenzen

- Sprachdateien (`*.json`) können keinen Urheber-Kopf tragen (JSON kennt keine Kommentare).
- Englische Sprache ist im Design-Menü als „in Vorbereitung“ deaktiviert (nur `de` liegt vor).
- Keine App-/VM-/Fernzugriffs-Karten (Teilprojekte 2–4).

## G – Installer-ISO, Erststart, systemd, Integrationstests

### G1 Plattenwahl: Stopp statt interaktiver storage-Sektion bei mehreren Platten (Abweichung vom Entwurf §3)

Der Entwurf sah bei mehreren Platten eine interaktive `storage`-Sektion vor. Subiquitys Oberfläche kann aber keine
Dateisystem-Labels setzen, und `partitionen.sh` braucht `FAHNAS-SYSTEM`/`FAHNAS-DATEN` – eine interaktive Aufteilung ergäbe
ein Ubuntu ohne Datenpartition und einen Abbruch erst am Ende der Installation. Umgesetzt: `platte_waehlen.py` stoppt in den
early-commands mit einer Liste der Platten und der Anleitung (`fahnas.platte=/dev/sdX` im GRUB-Menü per „e“, oder Platten
abziehen). Genau eine Platte mit `FAHNAS-DATEN` wird auch bei mehreren Platten automatisch genommen (Übernahme);
`fahnas.neu=1` löscht sie bewusst. Wechselmedien/USB werden nie automatisch gewählt.

Belegter Mechanismus zum Umschreiben: subiquity kopiert die Autoinstall-Konfiguration nach `/autoinstall.yaml`
(`server.py select_autoinstall()` → `copy_file_if_exists(loc, rootpath)`), liest sie nach den early-commands neu
(`load_autoinstall_config(only_early=True)` → `Early.run()` → `load_autoinstall_config(only_early=False)`) und packt einen
umschließenden Schlüssel `autoinstall` aus (`_read_config`). Doku (Autoinstall-Referenz, early-commands): „the file is
re-read after the early-commands have run to allow them to alter the configuration if necessary“.

### G2 `packages` wird ohne erreichbaren Spiegel entfernt

Der ISO-Pool enthält keines unserer Pakete (nur ~190 Pakete für GRUB/Treiber). Ohne Spiegel schlägt `packages` in subiquity
fatal fehl (`install_package` wirft nach drei Versuchen). `platte_waehlen.py` prüft `archive.ubuntu.com` (bis ~50 s) und
entfernt die Liste, wenn der Spiegel nicht erreichbar ist; der Erststart installiert nach, sobald Internet da ist. Damit ist
„ohne Internet installierbar“ nur für die Basis wahr – Samba/Docker/Node brauchen einmal Netz oder einen eigenen Spiegel.

### G3 grub-btrfs ist kein Ubuntu-Paket

`grub-btrfs` fehlt in allen Ubuntu-Suites (packages.ubuntu.com, Launchpad, 25.09.2026) und steht deshalb NICHT in
`packages`. Es liegt als Quellarchiv v4.14 (SHA-256 in `iso/payload/quellen.env`, Prüfsumme aus dem heruntergeladenen
GitHub-Tag-Archiv) auf dem Medium; `build_iso.sh` holt es in den Cache, `erststart.sh` installiert die Dateien wie das
Makefile (`/etc/grub.d/41_snapshots-btrfs`, `/usr/bin/grub-btrfsd`, Unit, Konfiguration) und lädt es bei Bedarf selbst
mit Prüfsumme nach. `inotify-tools` (Abhängigkeit des Daemons) ist in den Paketen ergänzt, ebenso `hdparm`, `iproute2` (Hinweis C).

### G4 Systemschnappschüsse und `set-default` – Hinweis an B/Koordinator

`btrfs subvolume set-default @` wird wie verlangt gesetzt. Belegt (GRUB-Quelle `grub-core/fs/btrfs.c`, `get_root()` mit
`GRUB_BTRFS_ROOT_VOL_OBJECTID`): GRUB löst Pfade immer ab dem Top-Level (Objekt-ID 5) auf, folgt dem Standard-Unterlaufwerk
NICHT. Deshalb ist `set-default` harmlos für den Start (`/@/boot/grub`-Präfix, grub-btrfs-Einträge), aber nur ein
Kernel-Rückfall ohne `rootflags`. Ubuntus `/etc/grub.d/10_linux` trägt für ein btrfs-Wurzelunterlaufwerk IMMER
`rootflags=subvol=@` in die Kernelzeile ein, und die fstab hängt `/` laut Vertrag mit `subvol=@` ein. Damit greift
`snapshots.system.standard` (B: `set-default` auf eine Kopie, Kommentar „/ wird NICHT mit festem subvol=@ eingehängt“) im
Betrieb nicht: der Kernel bootet weiter `@`. Robuste Alternative für „Diesen Stand dauerhaft machen“: Top-Level einhängen
(`mount -o subvolid=5 <System-UUID> /mnt`), `mv @ @_alt_<zeit>`, `btrfs subvolume snapshot /mnt/@snapshots/<n>/snapshot /mnt/@`
(beschreibbar), `update-grub` – Pfad `@` bleibt gültig, kein Eingriff in GRUB-Skripte. Außerdem: snapper-Schnappschüsse sind
nur lesbar; ein Start daraus über grub-btrfs braucht ein Overlay im initramfs (26.04: dracut) – Baustein fehlt noch.

### G5 Kleinere Abweichungen/Ergänzungen

- **Partitionsnummern im BIOS-Modus**: p1 = 1 MiB `bios_grub` (GRUB auf GPT braucht das), EFI/Swap/System/Daten rücken auf
  2–5. `partitionen.sh` arbeitet mit Labels, nicht mit Nummern. Auch im BIOS-Fall wird die 1-GiB-EFI-Partition angelegt
  (späterer UEFI-Wechsel möglich).
- **nodatacow** je Unterlaufwerk gibt es in btrfs nicht als Einhängeoption (nur die erste Einhängung eines Dateisystems
  zählt, btrfs(5)); wirksam ist `chattr +C` auf dem leeren `@docker`/`@vms`. Die Option steht trotzdem als Absicht in der fstab.
- **`/data/config` mit setgid (2750 root:fahnas)**: der Agent schreibt JSON mit 0640 als root; ohne setgid hätten neue Dateien
  die Gruppe root und der Web-Dienst (Nutzer fahnas) könnte `system.json` nicht lesen. `users.json` wird 0600 root gesetzt.
- **`fahnas-agent.service` mit `Group=fahnas` und `RuntimeDirectoryPreserve=yes`**: sonst gehört `/run/fahnas` root:root
  (Web kommt nicht an die Sockets) bzw. verschwindet bei jedem Agent-Neustart aus dem Namensraum des Web-Dienstes
  (`ReadWritePaths` bindet den Ordner beim Start ein). `NotifyAccess=all` in beiden Units, weil Agent und Web „bereit“ über
  das Hilfsprogramm `systemd-notify` (eigener Prozess) melden – mit dem Standard `main` würde systemd die Meldung verwerfen
  und den Start nach 120 s als fehlgeschlagen abbrechen.
- **snapper-Konfiguration `root`** wird aus `/usr/share/snapper/config-templates/default` geschrieben (SUBVOLUME="/",
  FSTYPE="btrfs", Eintrag in `SNAPPER_CONFIGS`) statt `snapper create-config`: das würde das Unterlaufwerk `.snapshots`
  selbst anlegen und scheitert am bereits eingehängten `@snapshots`. B's `rendereSnapper` überschreibt den Text danach.
- **Firewall**: `/etc/nftables.conf` = Grundregelwerk (Tabelle `inet fahnas`, nur input, policy drop) + `include
  "/etc/nftables.d/*.nft"`; `/etc/nftables.d/fahnas.nft` wird mit denselben Regeln vorbelegt, damit der Glob immer trifft und
  der Agent die Datei beim ersten `apply` einfach ersetzt. Kein `flush ruleset`, keine forward-Kette (Docker/libvirt).
- **Startcode** kommt aus `fahnas startcode` (C); Rückfall eigene Erzeugung (A–Z ohne O/I, 2–9). `/etc/issue.d/fahnas.issue`
  zeigt ihn statisch (agetty `\4` für die IP), das motd-Skript liest ihn dynamisch (verschwindet nach der Ersteinrichtung).
- **Übernahme prüft Rollen**: fehlt auf einer Platte mit `FAHNAS-DATEN` eines der Labels `FAHNAS-EFI`/`FAHNAS-SWAP`/
  `FAHNAS-SYSTEM` (oder im BIOS-Modus `bios_grub`), stoppt der Installer mit Anleitung statt zu raten. Fremde Partitionen bleiben
  unangetastet (preserve ohne format).
- **Zusätzliche Dateien in `iso/`** (laut §9 Teil G): `iso/payload/platte_waehlen.py` (Logik, testbar), `iso/payload/quellen.env`,
  `iso/werkzeuge/autoinstall_pruefen.mjs` (user-data-Prüfer für Bau und Test), `tests/integration/_gemeinsam.sh`.
- `swap: {size: 0}` in der storage-Sektion verhindert die Auslagerungsdatei von curtin; die swap-Partition steht ohne mount-Aktion
  in der Konfiguration, ihre fstab-Zeile schreibt `partitionen.sh` (UUID).

### G6 Nicht umgesetzt / nicht geprüft

- Das ISO wurde hier NICHT gebaut und NICHT in einer VM durchlaufen (macht der Koordinator). Ungeprüft im echten Lauf:
  curtin-Verhalten mit `preserve`+`offset` (Übernahme), BIOS-Zweig, `grub-install` aus dem chroot nach dem `@`-Umzug,
  Erststart auf 26.04 (Unit-Namen `smbd`, `libvirtd`, `zramswap`, snapper-Vorlagenpfad).
- Integrationstests (`tests/integration/*.sh`) sind für Ubuntu 26.04 geschrieben und mit `bash -n` geprüft, aber auf dieser
  macOS-Maschine nicht ausgeführt.
- `shellcheck` ist hier nicht installiert; der Einheitstest ruft es nur auf, wenn vorhanden.

## F1 – System-Rückrollen

Behebt G4: `snapshots.system.standard` setzte `btrfs subvolume set-default`, aber Ubuntus `/etc/grub.d/10_linux` schreibt für eine
btrfs-Wurzel immer `rootflags=subvol=<rootsubvol>` in die Kernelzeile (`rootsubvol` aus `make_system_path_relative_to_its_root /`), und
`iso/payload/partitionen.sh` hängt `/` laut fstab mit `subvol=@` ein – der alte Stand startete weiter. Der B-Hinweis „`/` ohne `subvol=@`
einhängen“ ist damit **hinfällig**; G muss an fstab/GRUB nichts ändern.

### Umgesetzter Ablauf (`src/agent/aktionen/snapshots.js`, Sektion „System-Rückrollen“, Funktionen `systemStandard`, `systemZurueck`, `systemRestLoeschen`, `mitPoolwurzel`)

`snapshots.system.standard {id}` – alle Schritte über `werkzeuge.system.ausfuehren` mit Argumentlisten:

0. `btrfs subvolume show /.snapshots/<id>/snapshot` – fehlt er → `E_NICHT_GEFUNDEN`, nichts wird eingehängt.
1. `findmnt -n -o SOURCE /` → z. B. `/dev/nvme0n1p3[/@]`; Klammerteil = Name der laufenden Wurzel, Rest = Gerät. Poolwurzel per
   `mount -t btrfs -o subvolid=5 <gerät> /run/fahnas/sysroot` (Ordner 0700; `findmnt` auf den Mountpunkt löst einen Rest einer
   abgebrochenen Einhängung vorher per `umount`).
2. snapper-Sicherheitseintrag `snapper -c root create -t single -d "Vor Rückrollen auf <id> (FAH-NAS)" --print-number` – **nur wenn die
   laufende Wurzel `@` ist**; läuft das System aus einem Startmenü-Eintrag oder einem Rest, entfällt er (Warnung im Ergebnis), weil
   snapper mit `SUBVOLUME="/"` sonst einen Schnappschuss des Schnappschusses anlegte. Ohne Cleanup-Algorithmus, bleibt also stehen.
3. `mv -T sysroot/@ sysroot/@_alt_<zeit>` (UTC-Stempel wie die Freigabe-Kennungen; Kollision → Sekunde hochzählen). Die laufende
   Wurzel bleibt eingehängt – der Kernel hält Unterlaufwerke über ihre ID.
4. `btrfs subvolume snapshot /.snapshots/<id>/snapshot sysroot/@` (beschreibbare Kopie unter dem Namen `@`).
5. Prüfung im neuen `@` (nur Warnungen): `/etc/fstab` hängt `/` mit `subvol=@` ein, `/boot/grub/grub.cfg` trägt `rootflags=subvol=@`.
   `@log`/`@snapshots` bleiben eigene Unterlaufwerke und hängen laut fstab wieder.
6. Reste begrenzen: höchstens `RESTE_BEHALTEN = 2` Unterlaufwerke `@_alt_<zeit>`/`@_kaputt_<zeit>` (die neuesten) bleiben; ältere per
   `btrfs subvolume delete --recursive` (systemd legt `/var/lib/machines`, `/var/lib/portables` als Unterlaufwerke in `@` an; kennt
   btrfs-progs die Option nicht – Meldung „unknown/unrecognized option“ – zweiter Versuch ohne). Die laufende Wurzel wird nie gelöscht
   (dann bleiben vorübergehend 3). Fehler hier → Warnung, kein Abbruch: das Rückrollen selbst ist fertig.
7. `umount sysroot` – immer (`finally`), auch nach Fehlern.

**Kein `update-grub`:** es liefe im alten Stand (jetzt `@_alt_<zeit>`), würde dessen `/boot/grub/grub.cfg` mit `rootflags=subvol=@_alt_<zeit>`
schreiben – und GRUB liest ohnehin `/@/boot/grub/grub.cfg` des neuen Stands (Präfix aus `partitionen.sh`), der Kernel, initrd und Menü aus
seiner eigenen Zeit mitbringt. grub-btrfsd erneuert die Schnappschuss-Einträge nach dem Neustart.

Fehlertoleranz: gemeinsamer Helfer `rueckdreher()` (auch vom Freigabe-Zurückrollen genutzt) – scheitert Schritt 2–4, laufen die bisherigen
Umbenennungen rückwärts (`mv` zurück, angelegte Kopie löschen), Ergebnis `E_SYSTEM` mit `details.stufe` (`sicherheit`|`umbenennen`|`kopie`).
Parallele Läufe (`standard`, `zurueck`, `reste`, `rest_loeschen`) werden mit `E_BELEGT` abgewiesen, damit sich zwei Läufe nicht den
Mountpunkt wegziehen. Ergebnis: `{id, quelle, alt:"@_alt_<zeit>", sicherheit:<snapper-Nr>|null, neustart_noetig:true, hinweis,
geloeschte_reste, warnungen}` – die Felder `unterlaufwerk`/`kopie_angelegt` aus dem B-Hinweis gibt es nicht mehr (die Oberfläche nutzt nur
den Erfolg, `public/ansichten/snapshots.js`, Funktion `systemStandard`).

### Ergänzungen für Oberfläche F (später anbinden – nicht Teil dieses Fixes)

- `snapshots.system.startmenue` liefert jetzt `{eintraege, experimentell:true, hinweis}`; die Oberfläche liest `r.eintraege` bereits
  (`public/ansichten/snapshots.js`, Funktion `systemKarteZeichnen`: `Array.isArray(r) ? r : r.eintraege`). Den `hinweis` („Start aus dem
  Menü nur lesend/experimentell; dauerhaft nur über ‚Beim nächsten Start verwenden‘ + Neustart“) bitte über der Liste anzeigen.
- `snapshots.system.reste {}` → `{reste:[{name, art:"alt"|"kaputt", zeit, laufend}], wurzel, behalten:2}`: Karte „Frühere Systemstände“
  mit Zeit, Art (alt = vor einem Rückrollen ersetzter Stand, kaputt = beim Rücktausch verworfener Stand), Plakette „läuft gerade“ bei `laufend`.
- `snapshots.system.zurueck {name}` (Knopf „Diesen Stand wieder verwenden“, Bestätigung, danach Neustart-Hinweis wie bei `standard`).
- `snapshots.system.rest_loeschen {name}` (Knopf „Löschen“, gesperrt bei `laufend`; `E_BELEGT` = laufende Wurzel).
- Erklärtext zum Rückrollen: „Der bisherige Stand bleibt als Rest erhalten (höchstens zwei), Rückweg über ‚Frühere Systemstände‘.“

### Tests / Grenzen

- `tests/einheit/snapshots_system.test.js` (5 Tests): Befehlsfolgen für Erfolg, Fehler in Schritt 4 (mv zurück), Schritt 3, snapper,
  Gerät nicht ermittelbar, Layout ohne `@`, Reste-Begrenzung inkl. `--recursive`-Rückfall und Schutz der laufenden Wurzel, Rücktausch mit
  Zurückdrehen, Reste-Liste, gezieltes Löschen, Sperre, Rest einer alten Einhängung. `tests/einheit/snapshots.test.js`: Startmenü-Test an
  die neue Ergebnisform angepasst, der `set-default`-Teil ist entfernt.
- Nicht auf echter Hardware/VM geprüft (wie G6): `mv` eines eingehängten Wurzel-Unterlaufwerks in der Poolwurzel und
  `btrfs subvolume delete --recursive` auf Ubuntu 26.04 gehören in den Integrationstest. Die Doku zu btrfs-progs nennt `-R|--recursive`,
  aber nicht die Version der Einführung – deshalb der Rückfall.
- snapper-Sicherheitseinträge häufen sich mit jedem Rückrollen (kein Cleanup, bewusst); sie sind über `snapshots.loeschen {ziel:"system"}` entfernbar.

## D2 – Externe Laufwerke (Agent + Pakete)

Dateien: `src/agent/aktionen/laufwerke.js`, `src/agent/laufwerke/{erkennen,einhaengen,ueberwachung}.js`, Ergänzungen in
`freigaben.js`/`render/samba.js`/`snapshots.js` (extern), Paketlisten in `iso/nocloud/user-data` + `iso/payload/erststart.sh`,
`tests/einheit/laufwerke.test.js`, `tests/integration/11_laufwerke.sh`.

### Umsetzung/Präzisierungen (siehe schnittstellen.md §12 „Präzisierungen 25.09. (Teil D2)“)

- **Systemplatten-Erkennung ohne Präfix**: Externe Laufwerke hängen unter `PFADE.shares` (= `/data/shares/<name>`), also unter
  `/data`. Ein Präfixvergleich der Einhängepunkte hätte sie zur Systemplatte gezählt (nicht auswerfbar). Deshalb GENAUE
  Übereinstimmung der System-Einhängepunkte; die Systemplatte wird ohnehin sicher an ihren `FAHNAS-*`-Labels erkannt.
- **`lsblk -b`** (Byte-Zahlen) statt der reinen Spaltenliste aus §12 – die Oberfläche rechnet in Bytes; zusätzlich `RO,PARTN`.
- **S.M.A.R.T.**: eigene kleine Auswertung in `laufwerke.js` (kein Import aus `system.js`), damit das Modul unabhängig von Teil C ist.
- **`laufwerke.einhaengen freigabe:true`** legt die externe Freigabe zunächst OHNE Rechte an (kein `lesen`/`schreiben`-Parameter im
  Vertrag) → Samba `available = no`, bis ein Admin über `freigaben.aendern` Rechte vergibt. Der Integrationstest macht genau das.
- **`laufwerke.aendern {freigabe:false}`** entfernt die externe Freigabe über `freigaben.loeschen {daten:"behalten"}` – der
  extern-Zweig fasst das (fremde, evtl. eingehängte) Dateisystem NICHT an.
- **Aushängen**: `sync` → (bei Freigabe) `smbcontrol all close-share` → `umount`; `EBUSY`/Code 32 → `fuser -vm` → `E_BELEGT` mit
  `details.prozesse`. `vergessen` → Eintrag aus `laufwerke.json`, dann `udisksctl power-off -b <platte>` mit Rückfall
  `/sys/block/<x>/device/delete` (beides nicht fatal, nur protokolliert).
- **`laufwerke.json`** wird über `konfig.aendern` geschrieben (Sperre); Eintrag `{kennung, name, fs, label, modell, groesse,
  automatisch, freigabe, optionen:{nur_lesen}, zuletzt}`.

### Grenzen / nicht auf echter Hardware geprüft

- Einheitstests (macOS) mit ersetztem System vollständig grün (19 Tests). `tests/integration/11_laufwerke.sh` ist mit `bash -n`
  geprüft, aber hier nicht ausgeführt (kein Linux/Loop-Geräte auf dem Mac); `shellcheck` ist hier nicht installiert.
- Der wirkliche Kernel-Rückfall `ntfs3 → ntfs-3g`, `hfsplus ro`, `udisksctl power-off` und das udev-Monitoring sind nur auf einem
  echten Linux-System belastbar – siehe `live_test` im Bericht.
- Für die Oberfläche (Ansicht `laufwerke`, Teil B2/F): `laufwerke.liste`-Felder wie im Vertrag; `laufwerke.formatieren` braucht das
  Feld `bestaetigung` (Gerätepfad tippen); die Karte der Systemplatte ist grau (`system:true`).

## Weltkarte „Verbindungen“ (26.09., Entwurf docs/superpowers/specs/2026-09-26-weltkarte-design.md, schnittstellen.md §13)

### Abweichungen von der Grundlage (Agent)

- **Register-Flag `lesend`** (`src/agent/register.js`, `src/agent/agent.js`): Bisher kam jeder Aufruf ins Prüfprotokoll. Aktionen mit
  `lesend:true` schreiben bei Erfolg keine Audit-Zeile mehr (Fehler weiterhin). Grund: `netz.verbindungen` fragt die Übersicht alle 5 s ab,
  `system.protokoll` alle 30 s – das Prüfprotokoll wäre sonst voll mit Lesezugriffen, und Verbindungsdaten sollen nicht auf die Platte.
- **Neuer Bereich `netz`** in `BEREICHE` (agent.js) mit der Aktion `netz.verbindungen` (admin).
- **Start-Haken für Bereiche**: agent.js ruft nach dem Registrieren `bereich.starten?.(werkzeuge)` und beim Beenden `bereich.stoppen?.()`
  auf – bisher gab es keinen allgemeinen Start je Bereich. `netz.js` startet darüber Geo-Verwaltung und conntrack-Sammler.

### Oberfläche (Kachel „Weltkarte“, Einstellungen „Standort und Verbindungen“)

- **`kachel()` in dashboard.js** nimmt ein Optionsobjekt `{kopf, breite, hoch}`: `kopf` hängt ein Element rechts in den Kachelkopf (hier der
  Umschalter), `breite`/`hoch` werden `data-breite`/`data-hoch`. `standardKacheln` liest diese Attribute; ohne sie gilt wie bisher 1 Spalte
  (2 für `dashboard-breit`), normale Höhe – die Standardgrößen aller alten Kacheln sind unverändert (Test).
- **Test-Haken** `export const _test = { setzeKartenLader(fn), standardKacheln() }` in dashboard.js (wie `app.js _test`): Die Kachel lädt
  `./weltkarte.js` per `import()`; Tests ersetzen das Modul durch eine Attrappe, die jeden Aufruf mitschreibt.
- **Aufteilung der Hinweise**: „kein Standort“, „Aufzeichnung aus“ und `werkzeug.hinweis` (conntrack fehlt) zeigt die Karte selbst
  (weltkarte.js, Entwurf §4.8); die Kachel zeigt Abfragefehler, „Karten-Modul nicht ladbar“ und „eingehend nur Heimnetz“, in den Listen
  „Aufzeichnung ausgeschaltet“ statt „keine Verbindungen“ und im Fuß die Ortsdaten-Quelle (Städte/nur Länder/keine) samt `geo.hinweis`.
  Wirft das Karten-Modul, laufen Listen und Umschalter weiter (jeder Aufruf der Karte ist abgefangen).
- **Liste der Gegenstellen** ist nach Anzahl der Verbindungen sortiert (dann Datenmenge, dann IP), nicht nach `zuletzt` wie das Ergebnis –
  so springen die Einträge im 5-s-Takt nicht. Mit aktivem Filter zeigt sie nur Gegenstellen, deren `lokal` den gewählten Namen enthält.
  Ein Filter fällt weg, wenn es den Absender/Dienst in neuen Daten nicht mehr gibt, und beim Umschalten der Richtung.
- **Aufteilung Karte/Listen** über eine Container-Abfrage auf die Kachel (`container-type: inline-size`, ab 720 px Kachelbreite
  nebeneinander) statt über die Fensterbreite – eine auf 1–2 Spalten verkleinerte Kachel stapelt so ebenfalls; auf dem Handy ohnehin.
- **Stand der Ortsdaten in System → „Standort und Verbindungen“** kommt aus `netz.verbindungen {richtung:"aus"}` (Block `geo`), weil es
  keine eigene Status-Aktion gibt; ohne Antwort (älterer Agent) bleibt die Zeile weg.
- **Standort-Eingabe**: Komma oder Punkt, typografisches Minus (−) erlaubt; nur Dezimalzahlen (kein Exponent, kein Hex). **Vertraute
  Proxys** prüft das Formular vorab (IPv4/IPv6, Präfix ≤ 32/128, ohne Zonen-ID, ≤ 43 Zeichen, ≤ 50 Einträge, Doppelte werden entfernt);
  der Agent prüft wie bisher noch einmal (`pruefeIpOderCidr`).
- **Sprachschlüssel über die Plan-Liste hinaus** (dashboard.json): `weltkarte_richtung`, `_ziele`, `_quellen`, `_aufzeichnung_aus`,
  `_heimnetz`, `_anycast`, `_ort_unbekannt`, `_anzahl`, `_summe`, `_filter`, `_fehler`, `_karte_fehlt`, `_speichern_fehler`. Die
  `dashboard.karte_*`-Schlüssel gehören zu weltkarte.js und stehen dort.
- Tests: `tests/einheit/ui_weltkarte_kachel.test.js` (neu); `ui.test.js` zählt `ansichten/weltkarte.js` zu Teil E (fehlende Sprachschlüssel
  = Fehler) und verlangt `symbol-welt`; `uiapps.test.js` prüft Syntax, Urheber-Kopf und Verbote auch für `weltkarte.js`; `nutzer.test.js`
  prüft den Bereich `weltkarte` neben `uebersicht`.

## Texteditor (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.1)

### Oberfläche

- **Jedes Schließen mit ungesichertem Text fragt nach**, auch ein Schließen aus dem Code heraus; schließt der Browser den Dialog
  selbst, öffnet er sich wieder und fragt. Grund: Sonst gäbe es einen Weg, ungesicherten Text zu verlieren.
- **Im Fuß des Editors steht nur „Herunterladen“**, „Info“ bleibt im Kontextmenü der Datei. Grund: Der Info-Knopf hätte den Editor
  geschlossen.
- **Die Konfliktfrage bietet „Weiter bearbeiten“ statt „Abbrechen“.** Grund: Der Text sagt, was danach passiert.

## Chat (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.2)

### Abweichungen von der Grundlage (Agent)

- **raum.json führt `letzte` und je Mitglied `ungelesen`** mit, statt beides beim Öffnen der Übersicht aus dem Verlauf zu rechnen.
  Grund: Die Übersicht (Rahmen, Kachel) wird nach jedem Ereignis neu geladen und muss ohne Verlaufs-Lesen auskommen.
- **Systemzeilen haben eine eigene Nachrichten-ID** (`{t:"s", id, …}`) und stehen im Verlauf wie Nachrichten. Grund: „Gelesen bis“,
  Blättern mit `vor` und Sortierung brauchen eine durchgehende ID-Folge.
- **Gast-Index `gaeste.json`** (Gast → Raum) neben den Räumen. Grund: Der Ausweis-Prüfer muss einen Gast ohne Durchsuchen aller Räume
  finden; im Raum steht nur der SHA-256 des Geheimnisses.
- **Direktnachrichten lassen sich nicht löschen** (auch nicht von Admins über „Räume verwalten“, das nur Räume listet). Grund: Eine
  DM gehört beiden; einseitiges Löschen nähme dem anderen den Verlauf.
- **Der Agent liest `web/link-adresse.json`** für die Klick-Adresse der Handy-Meldung. Grund: Die öffentliche Adresse lernt der
  Web-Dienst; der Agent hat sonst keine Quelle.
- **Kein `fsync` je Verlaufszeile.** Grund: Chat-Zeilen sind klein und häufig; btrfs + Schnappschüsse sichern ausreichend, ein Absturz
  kostet höchstens die letzten Zeilen.
- **Neue Aktion `chat.personen`** (Rolle nutzer, still) und Feld `verwaltende` in `chat.uebersicht`. Grund: Ohne Nutzerliste für
  Nicht-Admins (`nutzer.liste` ist admin) gingen weder Direktnachrichten noch die Mitgliederwahl; der Mitglieder-Dialog muss die
  Verwalter zeigen.

### Oberfläche

- **Stumme Räume zählen mit** (Navigation, Tab-Titel, Kachel); nur Ton, Browser- und Handy-Meldung schweigen. Grund: Ungelesenes soll
  nie unsichtbar werden.
- **Chat in der Navigationsgruppe „Zusammenarbeit“** statt als eigener Punkt neben der Übersicht; der Gruppenknopf der Handy-Leiste zeigt
  die Summe der Ungelesenen. Grund: Betreiberentscheidung 12.10. „Navigation in Gruppen“ (jede Ansicht außer der Übersicht in einer
  Gruppe); Office kommt in dieselbe Gruppe.
- **Die Gastseite lädt `stil.css`, `ansichten/chat.css` und `sprache/<de|en>/chat.json`** und nutzt die Bausteine der Chat-Ansicht.
  Grund: Verlauf, Anhänge und Eingabe gibt es so nur einmal; nur der Seitenrahmen (Name eingeben, Raum verlassen) steht in
  `chat-gast.js`/`chat-gast.css`.
- **Natives `select` als Auswahl unter Anhängen** („Herunterladen“, „In … speichern“, „Anderen Ordner wählen …“) mit Knopf „Los“.
  Grund: Am Handy bedienbar und barrierearm ohne eigenes Aufklappmenü.
- **Ein Gast-Keks je Browser.** Ein zweiter Einladungslink ersetzt den ersten Gastzugang in diesem Browser. Grund: Ein Keks pro
  Herkunft hält die Prüfung einfach; Gäste wechseln selten den Raum.
- **Browser-Meldungen nennen nur Raum und Absender**, nie den Text. Grund: wie die Handy-Meldung – Meldungen erscheinen auch auf
  gesperrten Bildschirmen.
- **Ordnerbaum-Stile liegen jetzt in `stil.css`** (vorher `ansichten/dateien.css`). Grund: Die gemeinsame Ordnerwahl erscheint auch im
  Chat, wo `dateien.css` nicht geladen ist.

### Tests / Grenzen

- **WebSocket ohne Komprimierung und ohne Erweiterungen** (eigenes RFC 6455, `src/web/ws.js`). Grund: keine Fremdpakete; Chat-Nachrichten
  sind klein.
- **Gast-Drossel nur im Speicher** (20 Nachrichten/min, 20 Uploads/h) – nach einem Neustart des Agenten beginnt sie frisch. Grund: Sie
  bremst Spam im laufenden Betrieb; ein Neustart ist selten und kein Angriffsweg.
- **Die Chat-Ansicht ist mit Schein-Verbindung und DOM-Attrappe getestet**; die echte Bedienung im Browser prüft der Abschluss
  (Bedienprobe per CDP).

## Anrufe (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.3)

### Abweichungen von der Grundlage (Web/Agent)

- **Relay-Bereich fest 49160–49200 ohne Portweiterleitung.** Grund: Relay-zu-Relay läuft auf dem NAS selbst; weiterzuleiten ist
  nur UDP <port> (Standard 3478).
- **Nur IPv4/UDP, kein TURN über TCP/TLS, kein MESSAGE-INTEGRITY-SHA256.** Grund: reicht für alle Browser, weniger Angriffsfläche.
- **Quote je Identität statt je username** (höchstens 6 Zuteilungen). Grund: der username ändert sich mit jedem ICE-Abruf.
- **Geheimnis in `web/turn.json` statt `chat.json`.** Grund: Der Web-Dienst darf `chat.json` nicht lesen; `turn.json` ist nie im
  Export.
- **TURN standardmäßig an.** Grund: Auftrag „Anrufe auch von unterwegs“; im Heimnetz schadet der Dienst nicht.
- **Push-Schlüssel je Nutzer** (`anruf:<raum>:<nutzer>`). Grund: Die 120-s-Sperre gilt je Schlüssel – sonst bekäme nur der erste
  Empfänger eine Meldung.
- **Zugangsdaten bei jeder TURN-Anfrage geprüft.** Grund: abgelaufene Zugänge sollen sofort nicht mehr weiterleiten; Anrufe über
  12 h verlieren daher die Weiterleitung (direkte Verbindungen laufen weiter).
- **Nutzernamen mit „gast-“-Anfang gelten im TURN-username nicht als Nutzer.** Grund: Niemand soll sich als Gast ausgeben können.
- **TURN-Zugänge 12 h statt „je Anruf“, aber mit Widerruf** (Prüfbericht 18.10., I6): Ein Browser kann TURN-Zugänge nicht ohne
  ICE-Neustart erneuern; kürzere Zugänge rissen lange Anrufe ab. Dafür entzieht der Web-Dienst den Zugang sofort, wenn ein Gast
  entfernt oder ein Nutzer gesperrt/gelöscht wird: laufende Zuteilungen schließen, vorher ausgegebene Zugänge gelten nicht mehr.
- **Heimnetz gesperrt, nicht nur das NAS** (Prüfbericht 18.10., C2): Das Relay leitet nur an öffentliche Adressen weiter, ins LAN
  nur Relay zu Relay (NAS-IP im Relay-Portbereich). Grund: Sonst hätte jeder Gast mit Einladungslink UDP-Zugang zu DNS, Router
  (NAT-PMP/PCP) und Diensten des NAS. Anrufe laufen trotzdem, weil alle Teilnehmenden denselben TURN-Dienst bekommen.

### Oberfläche

- **Klingelton unabhängig vom Ton-Schalter.** Grund: Ein Anruf im Hintergrund-Tab bliebe sonst unbemerkt.
- **Beitritt in einen anderen Raum legt ohne Rückfrage auf.** Grund: ein Anruf je Tab, eine Frage mehr stört nur.
- **Ablehnen wirkt nur in Direktnachrichten.** Grund: In Räumen klingelt es nicht; dort tritt einfach niemand bei.
- **Nach einem Neustart des Web-Dienstes kurzer Wiederaufbau** (alle treten neu bei). Grund: Anrufe stehen nur im Speicher; ein
  Abgleich wäre aufwendiger als ein neues Aushandeln.
- **Ein Anruf je Tab, Anruf-Ebene über der ganzen Oberfläche.** Grund: Man soll während eines Anrufs weiterarbeiten können.
- **Jede Kachel hat ein Videoelement, auch ohne Bild.** Grund: Darüber läuft auch der Ton der anderen.

### Tests / Grenzen

- **Ende-zu-Ende nur mit `node:dgram` auf 127.0.0.1** (`loopbackErlauben` nur in Tests); die echte Browser-Probe mit Kamera und
  Mikrofon gehört zur Bedienprobe im Abschluss. Grund: In den Einheitstests gibt es kein WebRTC.
- **`extern_zuletzt` nur im Betrieb prüfbar.** Grund: braucht einen echten Zugriff von außerhalb des Heimnetzes.

## Office – Kern und Board (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.4)

### Abweichungen von der Grundlage (Agent)

- **Detailfeld `office` statt `grund`** bei `E_NICHT_GEFUNDEN` (`'verschoben'` | `'geloescht'`). Grund: `grund` erreicht nur Admins;
  die Oberfläche braucht die Unterscheidung für alle Nutzer.
- **Neue Aktionen `office.recht` und `office.personen`** (nicht in V14). Grund: Der Web-Dienst prüft Recht und Stand eines offenen
  Dokuments beim Öffnen, alle 30 s und nach Rechte-Ereignissen, ohne es jedes Mal ganz zu laden; „Freigeben“ braucht die Nutzerliste
  ohne Admin-Recht.
- **`daten: null` bei Version 0.** Grund: Der Agent kennt die Datentypen nicht (sie liegen im Browser-Code); den leeren Anfangsstand
  setzt der Web-Dienst aus `typ.leer()`.
- **Endung weg → Eintrag weg.** Grund: Wird `Plan.fahboard` in `Plan` umbenannt, ist es kein Office-Dokument mehr; ein toter Eintrag
  gäbe über Office-Freigaben sonst Zugriff auf einen gewöhnlichen Ordner.
- **Admins nur mit Office-Freigabe in `geteilt_mit`.** Grund: Admins dürfen auf FAH-NAS alle Freigaben öffnen; zählten sie mit, wäre
  nie etwas „Privat“. Die Erklärung neben „Privat“ nennt die Admins.
- **`office.anlegen` mit `beide`** (freier Name „Name (n)“) und **`office.datei_kopieren` mit `groesse` und `mime`.** Grund: Import und
  „meine Fassung“ sollen nie an einem vorhandenen Namen scheitern; ein Board-Anhang braucht Größe und Dateiart.

### Web

- **`ChatVerbindung` wiederverwendet, `sichtbar` wird übergangen.** Grund: Ein zweiter WebSocket-Klient mit eigener
  Wiederverbindung wäre doppelter Code; die Sichtbarkeitsmeldung schadet dem Office nicht.
- **`herunterladen`-Option `cache`** (Standard `no-store`, Office-Dateien `private, max-age=31536000, immutable`). Grund: Dateien im
  Bündel ändern sich nie (jeder Upload bekommt eine neue Datei-ID); Bilder sollen nicht bei jedem Neuzeichnen neu laden.
- **Speichern im Namen eines Klienten mit Schreibrecht, bei `E_RECHTE` der nächste.** Grund: Der Web-Dienst hat keine eigenen
  Dateirechte; geht der Speichernde ohne Recht, soll ein anderer Bearbeitender den Stand sichern.

### Oberfläche

- **Verwaiste Karten in der ersten Spalte statt Datenumzug.** Grund: Löscht jemand eine Spalte, während ein anderer eine Karte
  hineinschiebt, bleibt die Karte sichtbar; ein automatischer Umzug wäre eine Op ohne Urheber und konvergierte schlechter.
- **Checkpunkte mit `pos`.** Grund: Reihenfolgen konvergieren nur mit Positionen (Bruchindex), nicht mit Listenplätzen.
- **Kopie bei Außenänderung ohne Anhangsdateien.** Grund: „Meine Fassung“ übernimmt die Daten aus dem Browser; Dateien, die nur im
  alten Stand im Bündel lagen, sind nach dem Neuladen nicht mehr greifbar – die Einträge bleiben, die Dateien fehlen (steht im Handbuch).
- **Kommentare löscht nur, wer sie geschrieben hat.** Grund: Kommentare sind Aussagen einer Person; der Server prüft den Urheber.
- **Fremde Auswahl führt die Sitzung nach, nicht der Editor.** Grund: Ein Ort für die Transformation; Editoren (auch Plan 05/06)
  zeigen nur das jeweils letzte `auswahl`-Ereignis je Person an.

### Tests / Grenzen

- **Konvergenz per Eigenschaftstest** (60 Startwerte × 250 Schritte mit zufälligen Ops, Verzögerungen, Abbrüchen und Wiederaufnahmen).
  Grund: Alle Kombinationen von Hand aufzuschreiben ist nicht möglich; der Test findet Gegenbeispiele selbst.
- **Keine Text-OT in Kartenfeldern** – letzte Änderung gewinnt je Feld (Titel, Beschreibung). Grund: Der Entwurf erlaubt das für
  Kartenfelder ausdrücklich; zeichengenaues Zusammenführen ist dem Dokument (Plan 05) vorbehalten.
- **Anhänge gelöschter Karten bleiben im Bündel liegen.** Grund: Die Datei zu löschen ließe sich nicht rückgängig machen
  (Schnappschuss ausgenommen); der Platz ist das kleinere Übel.
- **Bedienprobe im Browser erst im Abschluss.** Grund: Ziehen mit echten Zeigerereignissen, Touch-Halten und mehrere gleichzeitige
  Sitzungen prüft nur ein echter Browser; die Einheitstests bilden sie mit Attrappen nach.

## Office – Dokument (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.4)

### Abweichungen von der Grundlage

- **`anwenden` darf werfen, `opAnnehmen` fängt ab.** Grund: Eine Op, die nicht zum Stand passt (etwa eine Tabellenänderung an einer
  inzwischen gelöschten Tabelle), lässt sich nicht sinnvoll anwenden; abgelehnt wird nur diese Op (`fehler {cid}`), das Dokument
  bleibt heil.
- **V17 ergänzt:** Fehlercodes `zip_zu_gross`, `zip_kaputt`, `zip_nicht_unterstuetzt`, `xml_kaputt`, `zipSchreiben` mit `zeit`,
  exportiertes `crc32`, XML-Text wird nicht getrimmt. Grund: Der Import muss „zu groß“ von „kaputt“ unterscheiden, Exporte sollen
  reproduzierbar sein, und `w:t` braucht führende und folgende Leerzeichen.
- **V18 `exportieren → null` und `exportAusfuehren` im Rahmen.** Grund: Der PDF-Export läuft über den Druckdialog des Browsers; es
  gibt nichts herunterzuladen.
- **`docxLesen.fehlte` als `{art, anzahl}`.** Grund: Die Übersetzung samt Einzahl/Mehrzahl gehört in die Oberfläche (`import.js`),
  nicht in das Lesen.

### Datenmodell

- **Grabsteine `weg` in Tabellen; Löschen versteckt nur, „zurück“ macht nur sichtbar.** Grund: „Einfügen nach X“ bleibt bei
  gleichzeitigem Löschen von X eindeutig. Dass Löschen Inhalte behält und Zellen auch auf Verstecktes wirken, macht gleichzeitiges
  Löschen, Rückgängig und Tippen in jeder Reihenfolge gleich (die Abschlussprüfung fand mit Inhalts-Schnappschüssen in „zurück“
  auseinanderlaufende Klienten, I-4); versteckte Inhalte kosten etwas Platz in der Datei.
- **Kommentar-Op je Feld bzw. je Antwort.** Grund: Beim Setzen des ganzen Kommentars ginge eine gleichzeitige Antwort verloren.
- **Standardwerte werden nicht gespeichert** (Einzug 0, linksbündig). Grund: Nur so ist ein Dokument nach der Rundreise
  (Word ↔ Office) gleich dem Ausgangsstand.

### Oberfläche

- **Papier immer hell** (auch im dunklen Design). Grund: Das Dokument soll so aussehen, wie es gedruckt wird; Farben sind auf
  Weiß geprüft (Kontrast mindestens 4,5:1).
- **Kommentarkarten ohne Ausrichtung an der Höhe ihrer Stelle**, in der Reihenfolge der Stellen. Grund: robust ohne
  Layout-Rechnung (Zeilenumbrüche, Bilder, Fenstergröße).
- **Links öffnen mit Strg/⌘+Klick** (beim Nur-Lesen mit einfachem Klick). Grund: Ein einfacher Klick setzt beim Bearbeiten den
  Cursor; sonst ließe sich ein Link nicht mehr ändern.
- **Letzte Zeile bzw. Spalte löschen entfernt die ganze Tabelle.** Grund: Eine Tabelle ohne Zeilen oder Spalten wäre unsichtbar
  und nicht mehr erreichbar.
- **Drucken über eine Kopie** des Textes (`.od-druck`), auch bei Strg+P. Grund: Leiste, Rand und Bearbeitungsteile gehören nicht aufs
  Papier, und der Text selbst bleibt beim Drucken unangetastet.

### Tests / Grenzen

- **Keine echte Browser-Layoutprüfung in Einheitstests.** Grund: Die DOM-Attrappe kennt keine Geometrie; Cursor-Rechtecke werden in
  den Tests eingesetzt, die Lage prüft die Bedienprobe im Browser.
- **LibreOffice-Echtprobe im Container, Word und Pages in der Bedienprobe.** Grund: LibreOffice läuft auf dem NAS-Testcontainer
  (Export → PDF ohne Fehler, Rundreise einer LibreOffice-Datei ergibt dasselbe Modell); Word und Pages gibt es dort nicht.
- **Tabellenzellen „letzte Änderung gewinnt“.** Grund: Der Entwurf erlaubt das; zeichengenaues Zusammenführen bleibt dem Fließtext
  vorbehalten.
- **Kommentare nicht im docx-Export.** Grund: Word-Kommentare brauchen eigene Teile mit Verankerung je Lauf; das lohnt erst mit
  einem Bedarf. Der Import zählt Word-Kommentare als „nicht übernommen“.
- **Aufgabenliste als Zeichen ☐/☑.** Grund: Word kennt keine Aufgabenliste ohne Inhaltssteuerelemente; die Zeichen kommen beim
  Import wieder als Aufgabe zurück.

## Office – Tabelle (18.10.2026, Entwurf docs/superpowers/specs/2026-10-18-texteditor-chat-office-design.md, schnittstellen.md §20.4)

### Abweichungen von der Grundlage

- **Blattbezüge intern über die Blatt-Kennung** (`[blattId]!A1`), angezeigt und nach Excel geschrieben mit dem Namen. Grund:
  Umbenennen, gleichnamige Blätter bei gleichzeitigem Anlegen und Rückgängig nach dem Löschen eines Blatts bleiben so ohne
  Umschreiben aller Formeln konvergent.
- **Zusätzliche Op `zellen`** (viele Zellen auf einmal) neben `zelle`. Grund: Einfügen, Ausfüllen, Formatieren und Leeren eines Bereichs
  sind eine Änderung – ein Schritt für Rückgängig und eine Nachricht statt tausender.
- **Blätter tragen `pos`** (Bruchindex wie die Board-Spalten), `blatt_verschieben` setzt sie. Grund: Reihenfolgen konvergieren nur
  mit Positionen, nicht mit Listenplätzen.
- **`sortieren` trägt den Schnappschuss** der sortierten Zellen (vom Auslöser berechnet) und wirkt wie eine Zell-Op. Grund: Eine
  Sortierung, die erst beim Anwenden rechnet, ist gegen gleichzeitige Zell- und Struktur-Ops nicht konvergent.
- **Zwei zusätzliche Dateien** `formeln/adresse.js` (Adressen, `GRENZEN`) und `formeln/werte.js` (Werttypen, Datum, Zahlformate,
  Kriterien). Grund: Typ, Rechner, Export und Oberfläche brauchen dieselben Regeln; der Web-Dienst lädt sie ohne DOM.
- **Fehlerwert `#ZAHL!`** (intern `#NUM!`) zusätzlich. Grund: Überlauf und ungültige Potenzen (0 hoch 0) brauchen einen eigenen Fehler
  wie in Excel.
- **`invertieren(daten, op)` als Zusatz zum Typ-Vertrag** (nur im Editor). Grund: Rückgängig in der Tabelle braucht die genaue
  Umkehrung je Op samt verschobener Formeln; der Server ruft es nie.
- **V18 `importieren(...).dateien` ist immer `[]`, `verknuepfen` gibt die Daten unverändert zurück.** Grund: Tabellen haben keine
  Bilder oder Anhänge im Bündel.
- **`blatt_loeschen` trägt das Pflichtfeld `rest`** (die übrigen Blätter, die der Auslöser kennt). Grund: „Letztes Blatt gelöscht →
  Standardblatt“ nach dem Zustand war neben einem gleichzeitig angelegten Blatt nicht konvergent (gefunden vom Konvergenztest).
- **Einfügen direkt neben gleichzeitig gelöschten Zeilen verliert**: das Einfügen wird Noop, das Löschen nimmt die neuen Zeilen mit.
  Grund: Nur so verschieben beide Reihenfolgen die Bezüge gleich (ein Bereich, dessen Ende im gelöschten Teil lag, landete sonst je
  nach Reihenfolge mit oder ohne die neuen Zeilen).

### Datenmodell

- **Standardwerte werden nicht gespeichert** (`fett:false`, `kursiv:false`, `zahl:'standard'`), eine leere Zelle verschwindet. Grund:
  Kleinere Dateien, und zwei Stände mit gleichem Inhalt sind auch gleich (wichtig für die Konvergenzprüfung).
- **`'`-Regel für Text:** Text, der wie Zahl, Wahrheitswert, Formel oder `'…` aussähe, steht mit einem `'` davor in `w`. Grund: `w`
  bleibt eine Zeichenkette ohne zusätzliches Typfeld und trotzdem eindeutig (`'0049` ist Text, `49` eine Zahl).
- **Zellen jenseits der Grenzen bleiben bei Struktur-Ops erhalten** (`GRENZEN` gilt nur für Daten und Op-Parameter). Grund: Fiele beim
  Einfügen eine Zelle am Rand heraus, gingen Daten ohne Rückfrage verloren und Rückgängig brächte sie nicht zurück.
- **Gelöschtes letztes Blatt → Standardblatt `blatt1`** (nur über `rest`); `blatt1` darf per `blatt_neu` nur leer kommen, Rückgängig
  holt ein gelöschtes `blatt1` unter neuer Kennung zurück. Grund: Eine Mappe hat immer ein Blatt; gleiche Kennungen stießen sonst
  zusammen.

### Oberfläche

- **Raster immer hell** (feste Farben, Text mindestens 4,5:1), auch im dunklen Design. Grund: Zellfarben und Formate sollen wie in Excel
  und im Export aussehen; wie das Papier im Dokument.
- **Formel-Sprache immer Deutsch** (Funktionsnamen, `;`, Komma), unabhängig von der Oberflächensprache. Grund: Eine Formel soll für alle
  Beteiligten gleich aussehen; intern steht sie ohnehin englisch.
- **Ausschneiden leert sofort, Einfügen verschiebt keine Bezüge.** Grund: Ein „Verschieben beim Einfügen“ wäre gegen gleichzeitige
  Änderungen anderer nicht sauber zu halten; so ist Ausschneiden Kopieren plus Leeren.
- **Filter nur als Ansicht** (nicht gespeichert, nicht gesendet). Grund: Gefilterte Zeilen sollen für die anderen nicht verschwinden.
- **Enter/Tab heben die Bereichsauswahl auf** (die Auswahl wird eine Zelle). Grund: Einfacher und auf dem Handy vorhersehbar; Excels
  Wandern innerhalb der Auswahl braucht man selten.
- **Uhrzeit nur mit Datum** (eine reine Uhrzeit wie `14:30` bleibt Text). Grund: Ohne eigenes Uhrzeit-Format würde sie als Bruchteil
  eines Tags (0,6) angezeigt.
- **Zeilenhöhe nur aus dem Import**, in der Oberfläche nicht änderbar. Grund: Der Entwurf verlangt nur die Spaltenbreite; Höhen aus
  Excel gehen trotzdem nicht verloren.
- **Navigation bleibt im gezeichneten Raster** (mindestens 100 × 26, sonst belegt + 50 Zeilen/+ 10 Spalten). Grund: Das Raster wächst
  mit den Daten; leere Zeilen bis 100 000 zu zeichnen, wäre unnötig.
- **Fremde Auswahl führt die Sitzung nach, der Editor zeigt sie nur.** Grund: Wie bei Board und Dokument ein Ort für die
  Transformation – sonst würde sie doppelt verschoben.

### Tests / Grenzen

- **Konvergenz per Eigenschaftstest** (40 Startwerte mit Zufalls-Ops dreier Klienten, Modellprüfung kleiner Stände, alle Bereichsränder,
  Review Focus 1 in allen Reihenfolgen). Grund: Alle Kombinationen von Hand aufzuschreiben ist nicht möglich.
- **LibreOffice-Echtprobe im Testcontainer, Excel und Numbers in der Bedienprobe** (A5). Grund: Excel und Numbers laufen nicht im
  Container; LibreOffice rechnet die Probe-Mappe dort nachprüfbar.
- **Rückgängig stellt Zeilenhöhen gelöschter Zeilen nicht wieder her.** Grund: Höhen kommen nur aus dem Import und lassen sich in der
  Oberfläche nicht setzen; die Umkehrung bliebe ohne Gegenstück.
- **Theme- und Index-Farben aus xlsx entfallen.** Grund: Sie hängen am Design der Datei; nur feste Farben (RGB) lassen sich verlustfrei
  übernehmen.
- **Datumsformat im Export ohne Uhrzeit** (`DD.MM.YYYY`). Grund: Ein Format für alle Datumszellen; die Uhrzeit bleibt im Wert erhalten.
- **CSV schreibt das Anzeigeformat** (`1.234,50 €`, Genauigkeit wie in der Zelle). Grund: So, wie Excel CSV speichert – die Datei soll
  zeigen, was man sieht.
- **Matrix- und Datentabellen-Formeln kommen nur als Wert.** Grund: Der Rechner kennt keine Matrixformeln; ein falsch gerechneter Wert
  wäre schlimmer als ein fester.
- **Formeln mit mehr als 256 Klammer- oder Funktionsebenen lassen sich nicht eingeben oder importieren.** Grund: Schutz vor
  Stapelüberlauf; Excel selbst erlaubt 64 Funktionsebenen.

## App-Sichtbarkeit (18.10.2026, Betreiber-Nachtrag, schnittstellen.md §20.5)

### Oberfläche

- **Knopf „Sichtbarkeit“, die Zeile „Sichtbar für …“ und das Protokoll einer App sehen nur Admins.** Grund: Die Protokoll-Aktion
  ist eine Admin-Aktion; Nutzer bedienen freigegebene Apps, verwalten sie aber nicht.
