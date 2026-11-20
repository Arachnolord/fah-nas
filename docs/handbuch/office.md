<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Office – Handbuch

Im **Office** schreibst du Dokumente, rechnest in Tabellen und planst Aufgaben auf Kanban-Boards – allein oder gleichzeitig mit
anderen Nutzern deines NAS. Alles liegt als gewöhnliche Datei in deinen Freigaben und läuft komplett auf dem NAS; nichts geht an
fremde Server.

## 1. Überblick

- Das Office findest du links in der Navigation unter **Zusammenarbeit → Office**.
- Die Startseite zeigt drei Listen: **Zuletzt bearbeitet**, **Meine** (was dir gehört) und **Für mich freigegeben** (was andere mit
  dir geteilt haben). Ein Klick öffnet das Dokument.
- Es gibt drei Arten: **Dokument** (Textverarbeitung), **Tabelle** (Tabellenkalkulation) und **Board** (Kanban wie Nextcloud Deck).
- Gespeichert wird automatisch – es gibt keinen Speichern-Knopf. Oben im Dokument siehst du, ob alles gesichert ist.

## 2. Neu anlegen und Standardordner

1. Tippe auf der Startseite auf **Neues Dokument**, **Neue Tabelle** oder **Neues Board**.
2. Gib einen Namen ein. Darunter steht der Ordner, in dem die Datei landet; mit **Ändern** wählst du einen anderen.
3. Beim ersten Mal wählst du den Ordner selbst. Vorgeschlagen wird die erste Freigabe, in der du schreiben darfst. Lass den Haken
   **Als Standardordner merken** gesetzt, dann fragt das Office beim nächsten Mal nicht mehr.
4. **Anlegen** öffnet die neue Datei sofort.

Den Standardordner änderst oder entfernst du jederzeit auf der Startseite unter **Einstellungen**. Zur Wahl stehen nur Freigaben aus
dem Dateimanager, keine persönlichen Ordner. Gibt es den Namen im Ordner schon, sagt dir das der Dialog – wähle dann einen anderen.

## 3. Office-Dateien im Dateimanager

- Jede Office-Datei ist ein **Ordner** mit der Endung `.fahdoc`, `.fahtab` oder `.fahboard`. Der Dateimanager zeigt sie als **ein**
  Element mit dem Symbol der Art; ein Doppelklick öffnet sie im Office.
- Verschieben, Umbenennen, Kopieren und Löschen funktionieren wie bei jedem Ordner. Das Office merkt sich den neuen Ort selbst.
- **Herunterladen** liefert ein ZIP mit dem ganzen Inhalt (Text bzw. Tabelle, Bilder, Anhänge).
- **Schnappschüsse** und **Papierkorb** gelten wie für alle Dateien. Ältere Fassungen holst du über die Schnappschüsse der Freigabe
  zurück – das Office führt keinen eigenen Versionsverlauf. Hat die Freigabe keine Schnappschüsse, weist dich das Office beim ersten
  Öffnen eines Dokuments einmal darauf hin.

## 4. Privat oder geteilt

- Wer eine Office-Datei über die Rechte seiner Freigabe lesen darf, darf sie im Office lesen; wer schreiben darf, darf sie bearbeiten.
- Zusätzlich kannst du als **Besitzer** eine Datei gezielt freigeben: Tippe oben auf **Freigeben**, wähle unter **Person
  hinzufügen** jemanden aus und stelle **Darf lesen** oder **Darf bearbeiten** ein. Die Person sieht die Datei dann unter **Für mich
  freigegeben**, auch wenn sie die Freigabe sonst nicht sehen kann. Die Person arbeitet dabei mit deinen Rechten – aber nur an genau dieser
  Datei. **Entfernen** nimmt die Freigabe wieder zurück.
- Oben an jedem Dokument steht **Privat** oder **Geteilt mit …**. Privat heißt: Außer dir hat kein Nutzer Zugriff. Admins können auf
  FAH-NAS trotzdem alle Freigaben öffnen.
- Bilder und Anhänge gehören zur Datei. Wer die Datei öffnen darf, darf auch ihre Anhänge öffnen – und sonst nichts von dir. Fügst du
  etwas **aus dem NAS** ein, wird es kopiert, nicht verknüpft.

## 5. Gemeinsam bearbeiten und Speichern

- Öffnen mehrere Leute dieselbe Datei, sehen alle die Änderungen der anderen nach etwa einer Sekunde. Oben erscheinen die
  Profilbilder (ohne Bild der Anfangsbuchstabe) im Ring ihrer Farbe für alle, die gerade dabei sind; eine Karte, die jemand offen hat, trägt einen Rand in seiner Farbe mit seinem Namen.
- Der Speicherstatus oben zeigt **Gespeichert**, **Speichert …**, **Offline – Änderungen werden nachgereicht** oder **Speichern
  fehlgeschlagen**. Bei „Offline“ arbeitest du einfach weiter: Sobald die Verbindung zurück ist, gehen deine Änderungen nach.
- Schließt du den Browser, während noch etwas unterwegs ist, fragt er nach. Ein Neustart oder Update des NAS ist kein Problem: Was
  bis dahin gespeichert war, bleibt, und offene Browser reichen den Rest nach.
- Ändert jemand die Datei **außerhalb des Office** (über SMB oder durch Wiederherstellen aus einem Schnappschuss), lädt das Office
  sie neu und sagt es dir. Hattest du gerade eigene, noch nicht gespeicherte Änderungen, bietet es **Meine Fassung als Kopie sichern**
  an: Deine Fassung liegt dann als „Name (meine Fassung Datum Uhrzeit)“ neben dem Original. Anhänge, die nur deine Fassung hatte,
  kommen dabei nicht mit.
- Darfst du nur lesen, steht oben **Nur lesen**, und alle Knöpfe zum Ändern fehlen.

## 6. Kanban-Board

- **Spalten:** Ein neues Board hat „Zu erledigen“, „In Arbeit“ und „Erledigt“. **Spalte hinzufügen** legt weitere an; über das Menü
  einer Spalte benennst du sie um, schiebst sie nach links oder rechts oder löschst sie (samt ihren Karten – das Board fragt vorher).
- **Karten:** **Karte hinzufügen** am Ende einer Spalte, Titel eintippen, Enter – die Zeile bleibt für die nächste Karte offen.
  Karten ziehst du mit der Maus an eine andere Stelle oder in eine andere Spalte. **Auf dem Handy drückst du eine Karte kurz lang**
  (etwa eine Drittelsekunde), bis sie sich anhebt, und ziehst sie dann. Esc bricht das Ziehen ab.
- **Kartendialog:** Ein Klick auf eine Karte öffnet Titel, Beschreibung (mit einfacher Formatierung, Umschalter Bearbeiten/Ansicht),
  Zuständige, Fälligkeit, Etiketten, Spalte, **Nach oben/unten** (ohne Ziehen), Checkliste, Kommentare und Anhänge. Was du tippst,
  wird nach einer halben Sekunde Pause gespeichert. Eigene Kommentare kannst du löschen.
- **Etiketten verwalten** legt farbige Etiketten für das ganze Board an; in der Karte schaltest du sie per Tippen an und aus.
- **Filter:** **Meine Karten** (für dich zuständig), ein Etikett, oder die Fälligkeit (heute, überfällig, die nächsten 7 Tage).
- **Archiv:** Erledigte Karten archivierst du im Kartendialog; **Archiv** in der Leiste zeigt sie, dort kannst du sie
  **Wiederherstellen**.
- **Anhänge:** **Hochladen** (bis 100 MiB je Datei) oder **Aus dem NAS** (wird kopiert). Ein Klick auf den Namen öffnet die Datei.

## 7. Dokument (Textverarbeitung)

- **Werkzeugleiste** (von links): Rückgängig und Wiederholen, Absatzformat (Absatz, Überschrift 1–3), Fett, Kursiv, Unterstrichen,
  Durchgestrichen, Code, Schriftfarbe und Hervorheben (Palette, „Eigene Farbe“, „Ohne“), Link, Aufzählung, Nummerierung,
  Aufgabenliste, Einzug verkleinern/vergrößern, Ausrichtung (links, zentriert, rechts, Blocksatz), Zitat, Tabelle einfügen,
  Bild einfügen, Seitenumbruch und Kommentar. Ein hervorgehobener Knopf zeigt, was an der Cursorstelle gilt.
- **Tastenkürzel** (Strg unter Windows und Linux, ⌘ auf dem Mac): **B** fett, **I** kursiv, **U** unterstrichen, **K** Link,
  **Z** rückgängig, **Umschalt+Z** oder **Y** wiederholen. **Tab** rückt in einer Liste ein (Umschalt+Tab wieder aus), sonst fügt
  er einen Tabulator ein. Ohne Auswahl gilt ein Format für das, was du als Nächstes tippst.
- **Links:** Text markieren, **Link** (oder Strg/⌘+K), Adresse eintragen – erlaubt sind https://, http:// und mailto:. Leer
  lassen entfernt den Link. Zum Öffnen klickst du mit gedrückter Strg/⌘-Taste darauf; beim Nur-Lesen genügt ein Klick.
- **Tabellen:** **Tabelle einfügen** legt 3 × 3 Zellen an. Steht der Cursor in einer Zelle, erscheint in der Leiste die Gruppe
  **Tabelle** mit Zeile darüber/darunter, Spalte links/rechts und Zeile/Spalte löschen (höchstens 200 Zeilen und 50 Spalten). Die
  Spaltenbreite ziehst du am schmalen Griff über der Spalte. Löschst du die letzte Zeile oder Spalte, verschwindet die Tabelle.
  Auf dem Handy wischst du breite Tabellen waagerecht.
- **Bilder:** **Bild einfügen → Hochladen** (PNG, JPEG, GIF, WebP) oder **Aus dem NAS** – das Bild wird ins Dokument kopiert, das
  Original bleibt, wo es ist. Bilder kannst du auch hineinziehen oder einfügen. Die Breite änderst du am runden Griff unten rechts.
- **Seitenumbruch:** erzwingt beim Drucken und im Word-Export eine neue Seite; im Editor erscheint eine gestrichelte Linie.
- **Kommentare:** Text markieren, **Kommentar**, Text schreiben, **Speichern**. Die Kommentare stehen rechts neben der Seite in der
  Reihenfolge ihrer Stellen; ein Klick auf eine Karte markiert die Stelle, ein Klick auf markierten Text hebt die Karte hervor. Du
  kannst **Antworten**, einen Kommentar **Erledigt** setzen (**Erledigte zeigen** holt ihn zurück) und – als Autor oder Besitzer
  des Dokuments – **Löschen**. Auf dem Handy öffnet der Knopf **Kommentare (n)** in der Leiste dieselbe Liste.
- **Gemeinsam schreiben:** Andere sehen deinen Cursor mit deinem Namen in deiner Farbe, du ihre. Ihr könnt gleichzeitig in
  derselben Zeile tippen. **Rückgängig nimmt nur deine eigenen Änderungen zurück**, nie die der anderen.
- **Drucken und PDF:** **Exportieren → PDF (über den Druckdialog)** oder Strg/⌘+P druckt nur den Text, ohne Leiste und Rahmen,
  auf A4 mit 20 mm Rand. Als PDF speicherst du im Druckdialog über „Als PDF sichern“ bzw. „Microsoft Print to PDF“.

## 8. Tabelle (Tabellenkalkulation)

Eine Tabelle besteht aus einem oder mehreren **Blättern** mit Zellen. In jede Zelle schreibst du Text, eine Zahl, ein Datum oder eine
Formel. Oben steht die **Werkzeugleiste**, darunter die **Bearbeitungszeile** (links die Adresse der Zelle, rechts ihr Inhalt), dann
das Raster und ganz unten die Reiter der Blätter. Das Raster ist immer hell wie Papier, auch im dunklen Design.

### Zellen wählen und bearbeiten

- **Maus:** Ein Klick wählt eine Zelle. Ziehen oder **Umschalt+Klick** wählt einen Bereich. Ein Klick auf einen Spaltenkopf (A, B …)
  oder Zeilenkopf (1, 2 …) wählt die ganze Spalte bzw. Zeile, die Ecke oben links alles bis zur letzten belegten Zelle.
- **Tippen:** Wähle eine Zelle und tipp einfach los – der neue Inhalt ersetzt den alten. **Enter** übernimmt und geht eine Zeile
  nach unten, **Tab** eine Spalte nach rechts. **Esc** verwirft, was du getippt hast.
- **Ändern statt ersetzen:** **F2**, ein Doppelklick auf die Zelle oder ein Klick in die Bearbeitungszeile öffnet den bisherigen
  Inhalt zum Ändern. Klickst du währenddessen in eine andere Zelle, gilt das Getippte.
- **Handy:** Einmal tippen wählt eine Zelle, nochmal auf dieselbe Zelle tippen öffnet sie oben in der Bearbeitungszeile – die bleibt
  beim Blättern sichtbar. Wischen blättert durch die Tabelle. Zeilen, Spalten und die Zwischenablage erreichst du über **⋯** in der
  Leiste.
- **Formeln** stehen in der Bearbeitungszeile auf Deutsch (siehe unten), in der Zelle siehst du das Ergebnis.

### Tastenkürzel

Strg gilt unter Windows und Linux, ⌘ auf dem Mac.

| Taste | Wirkung |
| --- | --- |
| Pfeiltasten | eine Zelle weiter |
| Umschalt + Pfeil | Auswahl vergrößern oder verkleinern |
| Strg/⌘ + Pfeil | an den Rand des Datenblocks springen (oder zur nächsten belegten Zelle) |
| Enter / Umschalt + Enter | übernehmen und nach unten / oben |
| Tab / Umschalt + Tab | übernehmen und nach rechts / links |
| F2 | Inhalt der Zelle ändern |
| Entf oder Rücktaste | Inhalt der gewählten Zellen löschen (Formate bleiben) |
| Esc | Eingabe verwerfen |
| Strg/⌘ + C / X / V | kopieren / ausschneiden / einfügen |
| Strg/⌘ + Z | rückgängig (nur deine eigenen Änderungen) |
| Strg/⌘ + Y oder Strg/⌘ + Umschalt + Z | wiederholen |
| Strg/⌘ + D | nach unten ausfüllen |
| Strg/⌘ + B / I | fett / kursiv |
| Strg/⌘ + A | alles bis zur letzten belegten Zelle wählen |

### Formeln auf Deutsch

- Eine Formel beginnt mit **=**. Funktionsnamen sind deutsch, Argumente trennst du mit **;**, Dezimalzahlen schreibst du mit
  **Komma**: `=SUMME(A1:A10)`, `=RUNDEN(A1*1,19;2)`. Die Sprache der Formeln bleibt Deutsch, auch wenn die Oberfläche auf Englisch
  steht.
- **Bezüge:** `A1` (eine Zelle), `$A$1` (fest – wandert beim Kopieren nicht mit; `$A1` und `A$1` halten nur Spalte bzw. Zeile fest),
  `A1:B3` (Bereich), `A:A` (ganze Spalte), `1:3` (ganze Zeilen), auf einem anderen Blatt `Kosten!A1` und mit Leerzeichen im Namen
  `'Mein Blatt'!A1`.
- **Rechenzeichen:** `+ - * /`, `^` (hoch), `%` (Prozent), `&` (Text verbinden) und Vergleiche `= <> < > <= >=` (Ergebnis WAHR oder
  FALSCH). Text in Formeln steht in Anführungszeichen: `=A1&" €"`.
- Der Knopf **Funktion einfügen** (fx) in der Leiste listet alle Funktionen und setzt `=NAME(` in die Bearbeitungszeile.
- Fügt jemand Zeilen oder Spalten ein oder löscht sie, passen sich die Bezüge aller Formeln an – auch auf anderen Blättern. Wird die
  Zeile oder Spalte gelöscht, auf die eine Formel zeigt, wird daraus `#BEZUG!`.

**Die 17 Funktionen:**

| Funktion | Beispiel | Ergebnis |
| --- | --- | --- |
| SUMME | `=SUMME(A1:A10)` | Summe aller Zahlen |
| MITTELWERT | `=MITTELWERT(B2:B20)` | Durchschnitt der Zahlen |
| MIN, MAX | `=MAX(C:C)` | kleinste bzw. größte Zahl |
| ANZAHL | `=ANZAHL(A:A)` | wie viele Zellen eine Zahl enthalten |
| ANZAHL2 | `=ANZAHL2(A:A)` | wie viele Zellen nicht leer sind |
| WENN | `=WENN(B2>=100;"groß";"klein")` | je nach Bedingung das eine oder das andere |
| UND, ODER | `=UND(B2>0;C2>0)` | WAHR, wenn alle (UND) bzw. eine (ODER) Bedingung stimmen |
| RUNDEN | `=RUNDEN(2,675;2)` | 2,68 (kaufmännisch gerundet) |
| SVERWEIS | `=SVERWEIS(A2;Preise!A:C;3;FALSCH)` | sucht A2 in der ersten Spalte und liefert die dritte Spalte daneben |
| SUMMEWENN | `=SUMMEWENN(A:A;"Miete";B:B)` | summiert B dort, wo in A „Miete“ steht |
| ZÄHLENWENN | `=ZÄHLENWENN(C:C;">5")` | zählt Zellen, die die Bedingung erfüllen |
| HEUTE | `=HEUTE()` | heutiges Datum (aktualisiert sich jede Minute) |
| JETZT | `=JETZT()` | Datum und Uhrzeit |
| TEXT | `=TEXT(A1;"#.##0,00")` | Zahl als Text im gewünschten Format, etwa `TT.MM.JJJJ` für Daten |
| VERKETTEN | `=VERKETTEN(A1;" ";B1)` | verbindet Texte |

Bei SUMMEWENN, ZÄHLENWENN und SVERWEIS (mit FALSCH) gehen auch Platzhalter: `*` für beliebig viele Zeichen, `?` für genau eins
(`"Ber*"` findet Berlin und Bern). Groß- und Kleinschreibung spielt dort keine Rolle.

**Fehlerwerte** – so zeigt eine Zelle, dass etwas nicht aufgeht:

| Anzeige | Bedeutung |
| --- | --- |
| `#DIV/0!` | Division durch 0 (oder MITTELWERT ohne Zahlen) |
| `#NAME?` | unbekannte Funktion oder ein Name, den es nicht gibt (Tippfehler?) |
| `#BEZUG!` | die Zelle oder das Blatt, auf das die Formel zeigte, wurde gelöscht |
| `#WERT!` | falsche Art von Wert, zum Beispiel Text, wo eine Zahl gebraucht wird |
| `#NV` | SVERWEIS hat nichts gefunden |
| `#ZAHL!` | Ergebnis zu groß oder ungültige Rechnung (etwa 0 hoch 0) |
| `#ZIRKEL` | Zirkelbezug: die Formel hängt (über Umwege) von sich selbst ab |

### Zahlen, Daten und Formate

- Du tippst Zahlen wie gewohnt: `1.234,5`. Mit `12,5 %` entsteht eine Prozentzahl, mit `1.234,50 €` ein Eurobetrag, mit `18.10.2026`
  (oder `18.10.26`, `18.10.`) ein Datum, auf Wunsch mit Uhrzeit `18.10.2026 14:30`. Das Format merkt sich die Zelle, wenn sie noch keins
  hat. Soll etwas Text bleiben, das wie eine Zahl aussieht (etwa eine Vorwahl), setz ein Hochkomma davor: `'0049`.
- **Zahlformat** in der Leiste: Standard, Zahl (1.234,50), Währung (1.234,50 €), Prozent (12,50 %), Datum (18.10.2026) und Text (was du
  danach eintippst, bleibt Text).
- **Fett**, **Kursiv**, **Schriftfarbe**, **Füllfarbe** (jeweils mit „Keine“) und die **Ausrichtung** (links, mittig, rechts) gelten für
  alle gewählten Zellen. Ohne eigene Ausrichtung stehen Zahlen rechts, WAHR/FALSCH und Fehler in der Mitte, Text links.

### Sortieren, Filtern, Ausfüllen

- **Sortieren:** Klick in die Spalte, nach der sortiert werden soll, und dann auf **Aufsteigend** oder **Absteigend sortieren**. Hast du
  mehrere Zeilen markiert, wird genau dieser Bereich sortiert, sonst alle belegten Zeilen. Ist die erste Zeile fixiert, bleibt sie als
  Überschrift stehen. Zahlen kommen vor Text, leere Zellen ans Ende; jede Zeile nimmt ihre Zellen im sortierten Bereich mit.
- **Filter:** Klick in eine Spalte und auf **Filter**. Hake an, welche Werte zu sehen sein sollen (bei vielen Werten hilft das
  Suchfeld), und tipp auf **Übernehmen**. Zeile 1 gilt als Überschrift und bleibt immer stehen. **Der Filter gilt nur für dich** – die
  anderen sehen weiter alle Zeilen, und er wird nicht gespeichert. Der Knopf im Spaltenkopf öffnet ihn wieder, **Filter entfernen**
  zeigt alles. Wie in Excel blendet der Filter die Zeilen beim Übernehmen aus: Was du danach neu einträgst oder änderst, bleibt
  sichtbar, bis du den Filter erneut übernimmst. Fügt jemand Zeilen oder Spalten ein, wandert der Filter mit.
- **Nach unten ausfüllen:** Markiere die Zeile mit dem Inhalt und die Zeilen darunter und drück **Strg/⌘+D**. Formeln passen ihre
  Bezüge an (aus `=A1*2` wird in der nächsten Zeile `=A2*2`); Formate kommen mit. Ist nur eine Zeile markiert, kommt der Inhalt der
  Zeile darüber.
- **Kopieren und Einfügen** geht auch mit Excel, LibreOffice und Google Tabellen. Innerhalb des Office kommen Formeln und Formate mit,
  Formeln passen ihre Bezüge an. **Ausschneiden** leert die Zellen sofort; beim Einfügen bleiben Bezüge anderer Formeln, wo sie sind.
  Kopierst du eine einzelne Zelle in einen größeren markierten Bereich, füllt sie ihn ganz.

### Zeilen, Spalten und Blätter

- **Rechte Maustaste** auf eine Zelle oder einen Kopf (auf dem Handy **⋯** in der Leiste) öffnet das Menü: Ausschneiden, Kopieren,
  Einfügen, **Zeilen oberhalb einfügen**, **Zeilen löschen**, **Spalten links einfügen**, **Spalten löschen**, Sortieren, Filter und
  Inhalt löschen. Es werden so viele Zeilen bzw. Spalten eingefügt oder gelöscht, wie du markiert hast.
- **Spaltenbreite:** Zieh am rechten Rand eines Spaltenkopfs; ein Doppelklick dort stellt die Standardbreite wieder her.
- **Erste Zeile fixieren** (Knopf in der Leiste): Die erste Zeile bleibt beim Blättern oben stehen – praktisch für Überschriften.
  Nochmal tippen hebt es auf.
- **Blätter:** Die Reiter unten wechseln das Blatt, **+** legt ein neues an. Ein Doppelklick auf einen Reiter benennt ihn um; über
  **⋯** am Reiter, die rechte Maustaste oder (auf dem Handy) langes Drücken erreichst du **Umbenennen**, **Nach links**, **Nach
  rechts** und **Löschen**. Das letzte Blatt lässt sich nicht löschen. Blattnamen haben höchstens 31 Zeichen, ohne `: \ / ? * [ ]` und
  ohne `'` am Anfang oder Ende, und jeder Name kommt nur einmal vor (Groß-/Kleinschreibung zählt dabei nicht).

### Gemeinsam rechnen

- Arbeiten mehrere an derselben Tabelle, siehst du ihre Auswahl als farbigen Rahmen; die anderen sehen deine. Der Name steht nach
  jeder Bewegung 3 Sekunden über dem Rahmen und verschwindet dann, damit er die Zelle darüber nicht verdeckt.
- Je Zelle gilt **die letzte Änderung** – und zwar je Eigenschaft: Schreibt jemand einen Wert und ein anderer macht dieselbe Zelle
  gleichzeitig fett, bleibt beides.
- Fügt jemand Zeilen ein, während du eine Formel tippst, rutscht deine Formel samt ihren Bezügen richtig mit. Löscht jemand die Zeile,
  in der du gerade tippst, endet dein Bearbeiten ohne Übernahme.
- **Einfügen und Löschen zur selben Zeit an derselben Stelle:** Fügst du Zeilen genau dort ein, wo jemand gleichzeitig Zeilen löscht
  (im gelöschten Bereich oder direkt dahinter), gewinnt das Löschen – deine neuen Zeilen gehen mit, sonst rechneten die Formeln bei
  euch verschieden. Geht dabei etwas verloren, das du gerade eingegeben hast, sagt dir das Office es mit einer Meldung; gib es dann
  noch einmal ein.
- **Sortieren** schreibt den sortierten Bereich auf einmal neu. Was ein anderer gleichzeitig in diesen Bereich tippt, kann dabei
  überschrieben werden – sprecht euch bei großen Umsortierungen kurz ab.
- **Rückgängig nimmt nur deine eigenen Änderungen zurück** (bis zu 100 Schritte), auch wenn andere inzwischen etwas geändert haben;
  deren Änderungen bleiben stehen. Hat jemand in Zeilen, Spalten oder ein Blatt geschrieben, die du gerade eingefügt hast, lässt
  sich dieses Einfügen (und was davor lag) nicht mehr rückgängig machen – sonst verschwände seine Eingabe mit.

## 9. Importieren und Exportieren

- Ein Doppelklick auf eine **.docx**, **.xlsx** oder **.csv** im Dateimanager fragt, ob du sie **im Office öffnen (Kopie
  importieren)** möchtest. Das Original bleibt unverändert; im Office entsteht eine neue Datei daneben (darfst du dort nicht
  schreiben, wählst du einen Ordner). Bei .csv kannst du stattdessen **Als Text bearbeiten**. Was sich nicht übernehmen ließ, sagt
  eine Meldung in einem Satz.
- **Word importieren (.docx):** Übernommen werden Überschriften, Absätze, Zeichenformate, Farben, Links, Listen (auch Aufgaben mit
  ☐/☑), Zitate, Ausrichtung, Einzüge, Seitenumbrüche, Tabellen und eingebettete Bilder.
- Aus Word **nicht übernommen** wird zum Beispiel: Kopf- und Fußzeilen, Fußnoten, Word-Kommentare, Diagramme, Formen und
  Textfelder, Formeln, eingebettete Objekte, verbundene oder verschachtelte Tabellenzellen und Tabellenteile über 200 Zeilen, 50
  Spalten oder 20 000 Zeichen je Zelle. Von Feldern (etwa Inhaltsverzeichnis) bleibt nur das Ergebnis.
- **Excel importieren (.xlsx):** Übernommen werden alle Blätter mit ihren Namen, Texte, Zahlen, Wahrheitswerte, Formeln (auf
  Deutsch umgeschrieben; Excel-Funktionen, die das Office nicht kennt, bleiben stehen und zeigen `#NAME?`), Zahlformate (Zahl,
  Währung, Prozent, Datum, Text), fett, kursiv, Schrift- und Füllfarben, Ausrichtung, Spaltenbreiten, Zeilenhöhen und eine fixierte
  erste Zeile.
- Aus Excel **nicht übernommen** wird zum Beispiel: Diagramme, Pivot-Tabellen, bedingte Formatierung, verbundene Zellen (der Inhalt
  steht in der ersten Zelle), Makros, Bilder, Kommentare, Links, Datenüberprüfung, Matrixformeln (nur ihr Wert kommt mit) und
  Zellen jenseits von 100 000 Zeilen oder 1024 Spalten. Farben aus dem Excel-Design (Designfarben) entfallen. Die Meldung sagt dann
  etwa „Nicht übernommen: 2 Diagramme, bedingte Formatierung (3 Regeln)“.
- **CSV importieren:** Das Office erkennt die Kodierung (UTF-8, auch Windows-1252 aus deutschem Excel) und das Trennzeichen (`;`,
  `,` oder Tab) selbst. Deutsche Zahlen (`1.234,50`) und Daten (`18.10.2026`) werden zu Zahlen und Daten. Formeln aus einer CSV
  werden **nie** ausgeführt – `=…` bleibt Text. Das Blatt heißt wie die Datei.
- **Dokument exportieren** (Knopf **Exportieren** oben im Dokument): **Word (.docx)**, **Markdown (.md)** und **PDF (über den
  Druckdialog)**. Im Word-Export fehlen nur die Kommentare; Aufgaben stehen als ☐/☑ vor dem Text. Im Markdown entfallen Farben,
  Hervorhebung, Unterstreichung, Ausrichtung und Kommentare, Bilder stehen nur mit ihrem Namen darin (die Bilddatei selbst ist
  nicht dabei).
- **Tabelle exportieren** (Knopf **Exportieren** oben in der Tabelle) – **Excel (.xlsx)** mit allen Blättern: öffnet sich in Excel,
  LibreOffice und Numbers und rechnet beim Öffnen neu. Blattnamen, die Excel nicht erlaubt, werden angepasst (verbotene Zeichen →
  `_`, doppelte bekommen „(2)“); `#ZIRKEL` steht in Excel als `#WERT!`, Daten erscheinen dort ohne Uhrzeit.
- **CSV (.csv, aktuelles Blatt)** im Format für deutsches Excel: Semikolon, Umlaute dank BOM richtig, Werte so, wie sie in der
  Zelle angezeigt werden (`1.234,50 €`). Text, der mit `=`, `+`, `-` oder `@` beginnt, bekommt ein `'` davor, damit Excel ihn nicht
  als Formel ausführt. Hat die Tabelle mehrere Blätter, heißt die Datei „Name - Blatt.csv“.

## 10. Kachel und Handy-Meldung um 8 Uhr

- Die Übersicht hat eine Kachel **Office** mit deinen zuletzt bearbeiteten Dateien und deinen fälligen Karten (überfällige rot und
  zuerst). Ein Klick öffnet Datei bzw. Board.
- Sind Karten, für die du zuständig bist, heute fällig oder überfällig, kommt um **8 Uhr** eine Meldung aufs Handy – vorausgesetzt,
  deine Handy-Meldungen sind eingerichtet. Abschalten kannst du nur diese Meldung auf der Office-Startseite unter **Einstellungen →
  Fällige Karten aufs Handy**.

## 11. Fehlersuche

- **„Offline – Änderungen werden nachgereicht“ verschwindet nicht:** Prüfe die Netzverbindung. Steht das NAS hinter einem
  Reverse-Proxy, muss er WebSockets für `/api/office/ws` durchlassen.
- **„Speichern fehlgeschlagen“:** Meist ist die Freigabe voll oder dein Schreibrecht ist weg. Das Office versucht es alle 10 Sekunden
  erneut; schaffe Platz bzw. lass dir das Recht wieder geben.
- **„Das Dokument liegt nicht mehr an seinem Ort“:** Jemand hat die Datei außerhalb des Office verschoben. Öffne sie neu über den
  Dateimanager, dann merkt sich das Office den neuen Ort.
- **„Diese Dokumentart ist noch nicht verfügbar“:** Die Datei gehört zu einer Art, deren Editor noch nicht eingebaut ist.
- **Eine Person sieht eine freigegebene Datei nicht mehr:** Ist der Besitzer gesperrt oder hat er selbst keinen Zugriff mehr, gilt
  seine Office-Freigabe nicht mehr.
- **Karten lassen sich auf dem Handy nicht ziehen:** Halte die Karte etwas länger still, bevor du sie bewegst – eine schnelle
  Bewegung blättert die Seite.
- **„Die Datei ist kein lesbares Word-Dokument“:** Die Datei ist beschädigt, verschlüsselt (Kennwortschutz) oder kein echtes .docx
  (etwa ein umbenanntes .doc). Öffne sie in Word oder LibreOffice, speichere sie als .docx und importiere sie erneut.
- **Ein Bild fehlt im Export:** Das Bild ließ sich nicht laden (gelöscht oder beschädigt) – im Word-Export steht dann ein
  Platzhalter. Im Editor zeigt ein solches Bild „Bild nicht gefunden“; füge es neu ein.
- **„Eingabe konnte nicht übernommen werden – bitte noch einmal tippen“:** Der Browser hat den Text anders verändert, als das Office
  es erwartet hat (etwa durch eine Erweiterung, die in Webseiten schreibt). Das Office hat den letzten gesicherten Stand wiederhergestellt;
  tippe die letzten Zeichen noch einmal.
- **#ZIRKEL in einer Zelle:** Die Formel hängt über Umwege von sich selbst ab (etwa A1 `=B1` und B1 `=A1`). Alle Zellen der Schleife
  und alles, was darauf aufbaut, zeigen `#ZIRKEL`. Korrigiere einen Bezug, dann rechnet die Tabelle sofort wieder.
- **#NAME? nach dem Import:** Die Excel-Datei nutzt eine Funktion, die das Office nicht kennt – die Meldung beim Import nennt sie.
  Ersetze sie durch eine der 17 Funktionen oder lass sie stehen: Im Export nach Excel rechnet Excel sie wieder. Neuere
  Excel-Funktionen stehen in der Bearbeitungszeile mit der Vorsilbe `_xlfn.` (etwa `_xlfn.XLOOKUP`) – lass sie stehen.
- **CSV zeigt in Excel falsche Umlaute:** Öffne die Datei per Doppelklick oder über **Daten → Aus Text/CSV** mit „65001: Unicode
  (UTF-8)“. Sehr alte Excel-Versionen übersehen die Kennung für UTF-8; dann hilft der Export als .xlsx.
- **„Die Datei ist keine lesbare Excel- oder CSV-Tabelle“:** Die Datei ist beschädigt, mit Kennwort geschützt oder hat ein anderes
  Format (etwa das alte .xls oder .ods). Öffne sie in Excel oder LibreOffice, speichere sie als .xlsx und importiere sie erneut.
- **„Die Formel enthält einen Fehler – bitte prüfen.“:** Meist fehlt eine Klammer, am Ende steht ein Rechenzeichen, oder die Argumente
  sind mit Komma statt Semikolon getrennt (`=SUMME(A1;A2)`, Dezimalzahlen mit Komma: `2,5`). Das Bearbeiten bleibt offen – korrigiere
  die Formel oder verwirf sie mit Esc.
- **„Zu viele Zellen auf einmal (höchstens 50 000).“:** Eine Aktion betrifft mehr Zellen, als in einem Schritt gehen (etwa eine ganze
  Spalte formatieren). Markiere einen kleineren Bereich, zum Beispiel nur die belegten Zeilen.
