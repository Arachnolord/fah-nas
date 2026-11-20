<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Chat – Handbuch

Mit dem **Chat** schreibst du mit anderen Nutzern deines NAS – in Räumen für mehrere Leute oder in Direktnachrichten zu zweit.
Du kannst Dateien schicken, Gäste ohne Konto per Link in einen Raum holen und dich benachrichtigen lassen, wenn jemand schreibt.
Alles läuft auf deinem NAS; nichts geht über fremde Server (außer der Handy-Meldung, wenn du sie einschaltest – und die verrät nur,
wer geschrieben hat).

Den Chat findest du in der Navigation unter **Zusammenarbeit → Chat**.

## 1. Überblick

- **Links** stehen deine Räume und Direktnachrichten. Die Unterhaltung mit der neuesten Nachricht steht oben, eine Zahl zeigt,
  wie viele Nachrichten du noch nicht gelesen hast.
- **Rechts** ist der offene Raum: oben Name, Beschreibung und Knöpfe, in der Mitte der Verlauf, unten das Eingabefeld.
- **Profilbilder:** Neben jedem Namen steht das Bild der Person – hinterlegt wird es unter **Nutzer → Mein Konto**. Ohne Bild
  steht dort ihr Anfangsbuchstabe. Gäste sehen keine Profilbilder und haben selbst keins.
- **Am Handy** siehst du zuerst nur die Liste. Tippst du einen Raum an, öffnet er sich; der Pfeil oben links bringt dich zurück.
- Die Zahl ungelesener Nachrichten steht auch in der Navigation, im Titel des Browser-Tabs (z. B. „(3) Chat – nas“) und in der
  Kachel **Chat** auf der Übersicht – du siehst also auch in anderen Ansichten, wenn etwas Neues da ist.

## 2. Räume und Direktnachrichten

- **Neuer Raum:** Plus neben „Räume“ (oder „Neuer Raum“). Gib einen Namen, auf Wunsch eine Beschreibung und die Mitglieder an. Wer
  einen Raum anlegt, **verwaltet** ihn.
- **Direktnachricht:** Plus neben „Direktnachrichten“, dann die Person wählen. Eine Direktnachricht gibt es zwischen zwei Personen
  genau einmal; öffnest du sie erneut, geht die alte Unterhaltung weiter.
- **Mitglieder** (Personen-Knopf im Raumkopf): zeigt alle Mitglieder, wer den Raum verwaltet und welche Gäste dabei sind.
  Wer verwaltet, kann Mitglieder hinzufügen und entfernen, andere zu Verwaltern machen, den Raum umbenennen oder löschen.
- **Raum verlassen:** im Mitglieder-Fenster ganz unten. Zurück kommst du nur, wenn dich jemand wieder hinzufügt oder einlädt.
  Der letzte Verwalter kann erst gehen, wenn er einen anderen zum Verwalter gemacht hat (oder als Letzter im Raum ist).
- **Raum löschen** entfernt den Verlauf und alle Anhänge für alle – das lässt sich nicht rückgängig machen. Direktnachrichten
  lassen sich nicht löschen.

## 3. Schreiben

- **Senden** mit Enter, eine neue Zeile mit Umschalt + Enter. Eine Nachricht darf bis zu 10 000 Zeichen lang sein; ab 9 000
  Zeichen zeigt ein Zähler, wie viel noch geht.
- **Formatierung** wie in Markdown: `**fett**`, `*kursiv*`, `` `Code` `` und Codeblöcke mit drei Backticks; Adressen mit
  `http://` oder `https://` werden anklickbar. Zeilenumbrüche bleiben erhalten.
- **Antworten:** Pfeil an einer Nachricht (am Rechner beim Darüberfahren, am Handy darunter). Deine Antwort zeigt ein kurzes
  Zitat; ein Klick darauf springt zur ursprünglichen Nachricht.
- **Reaktionen:** Smiley an einer Nachricht, dann ein Emoji wählen. Ein zweiter Klick nimmt die Reaktion zurück.
- **Bearbeiten und Löschen:** nur eigene Nachrichten (Verwalter dürfen im eigenen Raum alle löschen). Gelöschte Nachrichten
  bleiben als „Nachricht gelöscht“ stehen, Text und Anhänge sind weg – auch aus Zitaten.
- **„… schreibt“** erscheint unter dem Verlauf, solange jemand tippt; **„Gelesen von …“** zeigt, wer bis zur letzten Nachricht
  gelesen hat.
- **Suchen** (Lupe im Raumkopf): ab 2 Zeichen. Ein Klick auf einen Treffer lädt ältere Nachrichten nach und springt hin.
- Ältere Nachrichten lädt der Chat beim Hochscrollen von selbst nach.

## 4. Dateien senden und empfangen

- **Senden:** Büroklammer im Eingabefeld, Dateien ins Eingabefeld ziehen oder einfügen. Bis zu 10 Dateien je Nachricht; während
  des Hochladens siehst du den Fortschritt.
- **Bilder** erscheinen als Vorschau (Klick öffnet das Original), **Videos** spielen direkt im Chat, andere Dateien stehen als
  Zeile mit Name und Größe da.
- **Was mit einer Datei passiert, entscheidet jeder Empfänger selbst** – über die Auswahl unter der Datei und **Los**:
  - **Herunterladen** – auf das Gerät, an dem du gerade sitzt.
  - **In <Ordner> speichern** – direkt auf das NAS in deinen Standardordner (erscheint nur, wenn du einen festgelegt hast).
  - **Anderen Ordner wählen …** – Ordner auf dem NAS aussuchen; du siehst nur Ordner, in die du schreiben darfst.
  Gespeichert wird immer mit **deinen** Rechten; gibt es den Namen schon, hängt FAH-NAS „(1)“ an.
- **Standardordner** legst du unter **Chat-Einstellungen** (Zahnrad oben links) fest – oder entfernst ihn wieder.
- **„Im Chat teilen …“** im Dateimanager (Menü einer Datei): schickt eine Datei vom NAS in einen Raum oder eine Direktnachricht,
  auf Wunsch mit Begleittext.
- **Größengrenze:** Wie groß eine Datei höchstens sein darf, stellt ein Admin ein (Standard 2048 MiB).

## 5. Gäste einladen

- **Einladen** (Knopf im Raumkopf, nur wer den Raum verwaltet, nicht in Direktnachrichten): erzeugt einen Link.
  - **Gültigkeit:** 1 Stunde, 24 Stunden, 7 Tage, 30 Tage oder dauerhaft.
  - **Höchstens so viele Gäste:** leer lassen für beliebig viele; ist die Zahl erreicht, gilt der Link nicht mehr.
  - **Kopieren** legt den Link in die Zwischenablage, **QR-Code** zeigt ihn zum Abscannen, **Löschen** macht ihn ungültig.
- **Gäste** öffnen den Link, geben einen Namen ein und sind sofort im Raum – ohne Konto. Gäste sehen **nur diesen einen Raum** und
  nur Nachrichten **ab ihrem Beitritt**. Gäste können schreiben, Dateien schicken und herunterladen, aber nichts auf dem NAS
  speichern. In der Mitgliederliste stehen sie mit der Marke „Gast“.
- **Ein Browser hält einen Gastzugang.** Wer denselben Link später wieder öffnet, landet direkt im Raum. Ein neuer Link in
  einem anderen Raum ersetzt den alten Gastzugang in diesem Browser.
- **Entfernen:** im Mitglieder-Fenster. Der Gast fliegt sofort heraus („Du bist nicht mehr in diesem Raum.“). Die Rückfrage bietet
  an, auch seinen Einladungslink zu löschen (vorgewählt) – sonst könnte er über denselben Link als neuer Gast zurückkommen. Teilen
  sich mehrere Gäste einen Link, sperrt das auch sie für neue Beitritte. Läuft ein Link ab oder löschst du ihn, bleiben schon
  beigetretene Gäste im Raum, bis du sie entfernst.
- **NAS-Nutzer** mit Konto, die einen Einladungslink öffnen, melden sich einfach an und werden normales Mitglied.

## 6. Benachrichtigungen

- **Zähler:** in Navigation, Tab-Titel und Übersicht – immer, auch für stumme Räume.
- **Ton:** ein kurzer Doppelton, wenn eine Nachricht kommt und du gerade nicht in den Raum schaust. Abschaltbar in den
  Chat-Einstellungen.
- **Browser-Meldungen:** eine Meldung des Browsers, wenn FAH-NAS im Hintergrund ist. Beim Einschalten fragt der Browser um
  Erlaubnis. Die Meldung nennt nur Raum und Absender – nie den Text.
- **Handy-Meldungen** (über die App **ntfy**): in den Chat-Einstellungen einschalten, den QR-Code mit der ntfy-App scannen –
  fertig. Du bekommst eine Meldung, wenn du gerade nicht in FAH-NAS bist. Auch hier steht nur, **wer** geschrieben hat, nie der
  Text. **Testmeldung senden** prüft den Weg. Kommt nichts an, muss ein Admin unter **System → Benachrichtigungen** den
  ntfy-Server prüfen.
- **Stumm** (Knopf im Raumkopf): kein Ton, keine Browser- und keine Handy-Meldung für diesen Raum. Ungelesene zählen weiter.

## 7. Anrufe

- **Anrufen:** im Raumkopf Hörer (nur Ton) oder Kamera (mit Bild). Wer schon telefoniert, sieht du am Banner „Anruf läuft ·
  n im Anruf“ – mit **Beitreten** bist du dabei. Laufende Anrufe stehen auch auf der Kachel **Chat** in der Übersicht.
- **Direktnachrichten klingeln** überall in FAH-NAS: oben erscheint „… ruft an“ mit **Annehmen**, **Mit Video annehmen** und
  **Ablehnen**, der Tab-Titel blinkt, ein Klingelton spielt (auch wenn der Chat-Ton aus ist). Nach 45 Sekunden ohne Antwort
  steht im Verlauf „Verpasster Anruf von …“, und der andere bekommt – falls eingeschaltet – eine Handy-Meldung.
- **Steuerleiste** im Anruf: Mikrofon an/aus, Kamera an/aus, **Bildschirm teilen** (am Rechner, nicht auf dem Handy), **Geräte**
  (Mikrofon und Kamera wählen), **Vollbild**, **Verkleinern** (der Anruf läuft unten rechts weiter, während du im Chat oder
  anderswo arbeitest) und **Auflegen**.
- **Höchstens 6 Personen** je Anruf. Gäste dürfen mit. Je Person zählt ein Gerät: Trittst du auf dem Handy bei, verlässt der
  Rechner den Anruf.
- Ein Anruf je Browser-Tab: Rufst du in einem anderen Raum an, legst du den laufenden Anruf vorher auf.
- In den Verlauf kommt nur, **dass** telefoniert wurde („Anruf beendet · 12 Min“) – kein Mitschnitt.

### Anrufe von unterwegs

Im Heimnetz und über das VPN klappen Anrufe immer. Damit sie auch zwischen verschiedenen Netzen gehen (Handy im Mobilnetz,
Gäste unterwegs), vermittelt FAH-NAS selbst die Verbindung („Verbindungshilfe“, Admins unter **Chat-Einstellungen → Anrufe von
unterwegs**). Dafür braucht es **eine** Portweiterleitung am Router.

So richtest du sie am UniFi-Gateway ein (**Einstellungen → Portweiterleitung**, je nach Version unter „Routing“ oder „Firewall &
Sicherheit“):

| Feld | Wert |
|---|---|
| Name | FAH-NAS Anrufe |
| Protokoll | **UDP** |
| Port von außen | 3478 |
| Ziel-IP | die NAS-IP aus der Karte („Am Router weiterleiten: UDP 3478 → …“) |
| Ziel-Port | 3478 |

Danach von unterwegs einmal anrufen: In der Karte steht dann „Zuletzt von außen genutzt: …“. Änderst du den Port in der Karte,
passe die Weiterleitung genauso an.


## 8. Für Admins

- **Maximale Größe je Datei** (Chat-Einstellungen): gilt für alle Räume, Nutzer und Gäste.
- **Räume verwalten** (Chat-Einstellungen): Liste aller Räume mit Mitglieder- und Gästezahl – **ohne Nachrichten**. Du kannst einen
  Raum löschen, aber über die Oberfläche nicht hineinsehen, wenn du kein Mitglied bist.
- **Kein Ende-zu-Ende:** Nachrichten und Anhänge liegen auf dem NAS (`/data/chat`, nur für root lesbar). Wer root-Zugang zum NAS
  hat, kann sie lesen. Das Protokoll hält fest, **dass** etwas geschah (Raum angelegt, Einladung erzeugt …), aber keine Texte.
- Der Chat-Speicher ist nicht Teil des Konfigurations-Exports; sichere ihn wie andere Daten über Schnappschüsse.

## 9. Fehlersuche

- **„Verbindung unterbrochen – wird neu aufgebaut“:** Das NAS ist kurz nicht erreichbar (Neustart, Netzwerk). Der Chat verbindet
  sich von selbst neu und lädt Verpasstes nach.
- **Eine Datei lässt sich nicht senden:** zu groß (Grenze siehe oben) oder mehr als 10 Dateien auf einmal.
- **„In <Ordner> speichern“ fehlt:** Du hast keinen Standardordner festgelegt – oder du bist Gast.
- **„Hier darfst du nicht schreiben“** in der Ordnerwahl: Für diesen Ordner hast du nur Leserechte; wähle einen anderen.
- **Keine Handy-Meldung:** Testmeldung senden. Kommt sie nicht an, fehlt der ntfy-Server (Admin) oder die ntfy-App hat das
  Thema nicht abonniert (QR-Code erneut scannen). Bist du gerade in FAH-NAS aktiv, kommt absichtlich keine Meldung.
- **Gast sieht „Diese Einladung ist ungültig oder abgelaufen“:** Link abgelaufen, gelöscht oder Höchstzahl erreicht – neuen Link
  erzeugen.
- **„Zu viele Versuche – bitte warte … Sekunden“:** Zu viele falsche Links von derselben Adresse; kurz warten.
- **„Kein Zugriff auf das Mikrofon“:** Erlaube Mikrofon (und Kamera) in den Website-Einstellungen des Browsers und rufe erneut an.
- **„Der Anruf ist voll“:** Es telefonieren schon 6 Personen.
- **Schwarzes Bild statt Kamera:** Die Kamera ist in einer anderen App belegt – dort schließen, dann Kamera aus- und wieder einschalten.
- **Von außen kommt keine Verbindung zustande:** Die Weiterleitung UDP 3478 fehlt oder der Port wurde geändert; im Heimnetz und
  über VPN geht es trotzdem.
