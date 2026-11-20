<!--
  Erdacht und programmiert von Fabian Hammer, Deutschland.
  (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
-->

# Lizenz-Hinweise für mitgelieferte und geladene Fremddaten

FAH-NAS selbst ist urheberrechtlich geschützt (siehe README.md). Für die Weltkarte der Übersicht nutzt es zwei
freie Datenquellen. Beide werden **lokal** ausgewertet – keine IP-Adresse und kein Standort verlässt den NAS.

In der Oberfläche steht die Namensnennung im Fuß der Kachel „Weltkarte“:

> IP-Geolokalisierung: DB-IP.com (CC BY 4.0) · Karte: Natural Earth

## DB-IP Lite (IP-Geolokalisierung)

- Herausgeber: DB-IP, <https://db-ip.com> – „IP Geolocation by DB-IP“
- Lizenz: Creative Commons Namensnennung 4.0 International (CC BY 4.0),
  <https://creativecommons.org/licenses/by/4.0/>
- Verwendet werden:
  - **DB-IP Country Lite** (`geo/dbip-country-lite.mmdb`): beim Release-Bau von
    <https://download.db-ip.com/free/> geladen (`tools/geo_holen.mjs`) und mit dem Programm ausgeliefert – Rückfall
    ohne Internet (nur Länder).
  - **DB-IP City Lite** (`/data/geo/dbip-city-lite.mmdb`): vom NAS monatlich selbst geladen, solange die Einstellung
    „Ortsdaten monatlich laden“ eingeschaltet ist (Städte).
- Die Daten werden unverändert im MaxMind-DB-Format gelesen (eigener Leser `src/agent/helfer/mmdb.js`) und nicht
  bearbeitet. Die Genauigkeit der Lite-Ausgaben ist begrenzt; Orte sind ungefähre Angaben.

## Natural Earth (Weltkarte)

- Herausgeber: Natural Earth, <https://www.naturalearthdata.com> – „Made with Natural Earth“
- Lizenz: gemeinfrei (Public Domain), <https://www.naturalearthdata.com/about/terms-of-use/>
- Verwendet wird **Admin 0 – Countries, 1:50m** (`ne_50m_admin_0_countries`). Daraus erzeugt
  `tools/karte_bauen.mjs` vereinfachte Umrisse (`public/karte/welt.json`, Antarktis entfernt) und Landesmitten mit
  deutschen Namen (`geo/laender.json`).
