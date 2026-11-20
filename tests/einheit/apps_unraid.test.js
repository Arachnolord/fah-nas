// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/apps/unraid.js: XML-Leser, Übersetzung echter Community-Applications-Vorlagen
// (tests/daten/unraid/*.xml: linuxserver nginx/heimdall/syncthing, binhex jellyfin/qbittorrentvpn, selfhosters
// dozzle/vaultwarden/hortusfox-web) in Katalog-Vorlagen, ExtraParams, WebUI, altes Format v1, Feed-Ausschnitt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmlLesen, entitaeten, datenAusXml, vorlageAusXml, vorlageAusUnraid, feedParsen, extraParamsZerlegen, extraParamsUebersetzen, kategorieUebersetzen, slug } from '../../src/agent/apps/unraid.js';
import { yamlLesen, rendern, vorlagePruefen } from '../../src/agent/apps/compose.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const DATEN = path.join(HIER, '..', 'daten', 'unraid');
const WURZELN = { appOrdner: '/data/apps/probe', shares: '/data/shares' };
async function xml(name) { return fs.readFile(path.join(DATEN, name), 'utf8'); }
const feld = (v, name) => v.felder.find((f) => f.name === name);

test('xmlLesen: Elemente, Attribute, Text, Entitäten, CDATA, Kommentare, selbstschließend; Fehler', () => {
  const d = xmlLesen('<?xml version="1.0"?>\n<!-- k -->\n<Container version="2">\n  <Name>A &amp; B</Name>\n  <Config Name="x" Default=\'y\' Mask="false"/>\n  <Overview><![CDATA[<b>fett</b> &amp; roh]]></Overview>\n  <Leer></Leer>\n</Container>');
  assert.equal(d.name, 'Container'); assert.deepEqual(d.attribute, { version: '2' });
  assert.equal(d.kinder[0].text, 'A & B');
  assert.deepEqual(d.kinder[1].attribute, { Name: 'x', Default: 'y', Mask: 'false' });
  assert.equal(d.kinder[2].text, '<b>fett</b> &amp; roh');
  assert.equal(d.kinder[3].text, '');
  assert.equal(entitaeten('&lt;&#65;&#x42;&quot;&apos;&gt;'), '<AB"\'>');
  assert.throws(() => xmlLesen('<a><b></a>'), (e) => e.code === 'E_PARAMS' && /passt nicht/.test(e.message));
  assert.throws(() => xmlLesen('<a>'), (e) => /nicht geschlossen/.test(e.message));
  assert.throws(() => xmlLesen('404: Not Found'), (e) => /Wurzelelement/.test(e.message));
  assert.throws(() => datenAusXml('<Plugin><Name>x</Name></Plugin>'), (e) => /Container/.test(e.message));
});

test('linuxserver/nginx.xml: Ports, Pfad (leerer Default → daten/config), Variablen, WebUI {PORT_80}, Kategorie fehlt → Sonstiges', async () => {
  const v = vorlageAusXml(await xml('linuxserver-nginx.xml'), { quelle_url: 'https://example/nginx.xml' });
  assert.equal(v.id, 'unraid-nginx'); assert.equal(v.name, 'nginx'); assert.equal(v.quelle, 'unraid'); assert.equal(v.kategorie, 'Sonstiges');
  assert.equal(v.symbol, 'https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/nginx-logo.png');
  assert.equal(v.webui, 'http://{HOST}:{PORT_80}');
  assert.deepEqual(v.felder.map((f) => `${f.name}:${f.art}`), ['PORT_80:port', 'PORT_443:port', 'PFAD_CONFIG:pfad', 'NGINX_AUTORELOAD:variable', 'NGINX_AUTORELOAD_WATCHLIST:variable', 'PUID:variable', 'PGID:variable', 'UMASK:variable']);
  assert.deepEqual(feld(v, 'PORT_80'), { name: 'PORT_80', art: 'port', beschriftung: 'WebUI', erklaerung: 'http', pflicht: true, standard: 80, container: 80, protokoll: 'tcp' });
  assert.equal(feld(v, 'PFAD_CONFIG').standard, 'daten/config'); assert.equal(feld(v, 'PFAD_CONFIG').container, '/config');
  assert.equal(feld(v, 'PUID').standard, '99'); assert.equal(feld(v, 'PUID').pflicht, true);
  assert.equal(feld(v, 'NGINX_AUTORELOAD').pflicht, false); assert.equal(feld(v, 'NGINX_AUTORELOAD').standard, undefined);
  assert.equal(v.herkunft.vorlage_url, 'https://example/nginx.xml'); assert.equal(v.herkunft.repository, 'lscr.io/linuxserver/nginx');
  const doc = yamlLesen(v.compose);
  assert.deepEqual(doc.services.app.ports, ['${PORT_80}:80', '${PORT_443}:443']);
  assert.deepEqual(doc.services.app.volumes, ['${PFAD_CONFIG}:/config']);
  assert.ok(doc.services.app.environment.includes('PUID=${PUID}'));
  assert.equal(doc.services.app.restart, 'unless-stopped'); assert.equal(doc.services.app.container_name, 'fahnas-nginx');
  assert.equal(doc.services.app.privileged, undefined);
  // rendert ohne Änderungen (Standardwerte) und ohne Risiken
  const r = rendern(v, {}, WURZELN);
  assert.deepEqual(r.ports.map((p) => p.port), [80, 443]); assert.deepEqual(r.risiken, []);
  assert.equal(r.werte.PFAD_CONFIG, '/data/apps/probe/daten/config');
});

test('linuxserver/heimdall.xml und syncthing.xml: udp-Port bekommt eigenes Feld, gleiche Containerports tcp/udp, Pfade', async () => {
  const h = vorlageAusXml(await xml('linuxserver-heimdall.xml'));
  assert.equal(h.id, 'unraid-heimdall'); assert.equal(h.webui, 'http://{HOST}:{PORT_80}');
  assert.deepEqual(h.felder.filter((f) => f.art === 'port').map((f) => f.name), ['PORT_80', 'PORT_443']);
  assert.equal(feld(h, 'ALLOW_INTERNAL_REQUESTS').art, 'variable'); assert.equal(feld(h, 'ALLOW_INTERNAL_REQUESTS').standard, 'false');
  const s = vorlageAusXml(await xml('linuxserver-syncthing.xml'));
  assert.equal(s.webui, 'http://{HOST}:{PORT_8384}');
  assert.deepEqual(s.felder.filter((f) => f.art === 'port').map((f) => `${f.name}/${f.protokoll}`), ['PORT_8384/tcp', 'PORT_22000/tcp', 'PORT_22000_UDP/udp', 'PORT_21027_UDP/udp']);
  assert.deepEqual(s.felder.filter((f) => f.art === 'pfad').map((f) => [f.name, f.standard]), [['PFAD_CONFIG', 'daten/config'], ['PFAD_DATA1', 'daten/data1'], ['PFAD_DATA2', 'daten/data2']]);
  const doc = yamlLesen(s.compose);
  assert.deepEqual(doc.services.app.ports, ['${PORT_8384}:8384', '${PORT_22000}:22000', '${PORT_22000_UDP}:22000/udp', '${PORT_21027_UDP}:21027/udp']);
  const r = rendern(s, {}, WURZELN);
  assert.deepEqual(r.ports.map((p) => `${p.port}/${p.protokoll}`), ['8384/tcp', '22000/tcp', '22000/udp', '21027/udp']);
});

test('binhex/jellyfin.xml: Kategorie Medien, --restart=always aus ExtraParams, Auswahl aus „yes|no“, /mnt/user-Vorgaben → daten/…', async () => {
  const v = vorlageAusXml(await xml('binhex-jellyfin.xml'));
  assert.equal(v.id, 'unraid-binhex-jellyfin'); assert.equal(v.kategorie, 'Medien'); assert.equal(v.webui, 'http://{HOST}:{PORT_8096}');
  assert.equal(yamlLesen(v.compose).services.app.restart, 'always');
  assert.deepEqual(feld(v, 'ENABLE_HEALTHCHECK'), { name: 'ENABLE_HEALTHCHECK', art: 'auswahl', beschriftung: 'Variable: ENABLE_HEALTHCHECK', erklaerung: 'Enable or disable healthchecks.', pflicht: false, werte: ['yes', 'no'], standard: 'yes' });
  assert.equal(feld(v, 'PFAD_CONFIG').standard, 'daten/config'); assert.equal(feld(v, 'PFAD_MEDIA').standard, 'daten/media');
  assert.equal(feld(v, 'PFAD_MEDIA').pflicht, true, 'Pfad-Felder sind immer Pflicht (Volume-Zeile)');
  assert.deepEqual(v.hinweise, []);
  assert.equal(v.herkunft.repository, 'ghcr.io/binhex/arch-jellyfin');
});

test('binhex/qbittorrentvpn.xml: Privileged → Risiko mit Bestätigung, --sysctl, Mask → Geheimnis, Auswahl mit vier Werten, 33 Felder', async () => {
  const v = vorlageAusXml(await xml('binhex-qbittorrentvpn.xml'));
  assert.equal(v.kategorie, 'Downloads'); assert.equal(v.felder.length, 33);
  const doc = yamlLesen(v.compose);
  assert.equal(doc.services.app.privileged, true);
  assert.deepEqual(doc.services.app.sysctls, ['net.ipv4.conf.all.src_valid_mark=1']);
  assert.equal(feld(v, 'VPN_USER').art, 'geheimnis'); assert.equal(feld(v, 'VPN_PASS').art, 'geheimnis'); assert.equal(feld(v, 'VPN_PASS').pflicht, true);
  assert.deepEqual(feld(v, 'VPN_PROV').werte, ['pia', 'airvpn', 'protonvpn', 'custom']);
  assert.equal(feld(v, 'LAN_NETWORK').standard, '192.168.1.0/24');
  assert.deepEqual(v.felder.filter((f) => f.art === 'port').map((f) => f.name), ['PORT_8080', 'PORT_8118', 'PORT_9118', 'PORT_58946', 'PORT_58946_UDP']);
  assert.ok(v.hinweise.some((h) => /privilegiert/.test(h)));
  const r = rendern(v, { VPN_USER: 'u', VPN_PASS: 'p', PFAD_DATA: 'daten/downloads' }, WURZELN);
  assert.deepEqual(r.risiken.map((x) => x.art), ['privileged']);
  assert.ok(r.warnungen.some((w) => /sysctls/.test(w)));
  assert.deepEqual(r.geheimnisse, { VPN_USER: 'u', VPN_PASS: 'p', SOCKS_USER: 'admin', SOCKS_PASS: 'socks' });
  assert.ok(r.env.includes("VPN_PASS='p'") && r.vorschau.includes('VPN_PASS=********'));
});

test('selfhosters/dozzle.xml: docker.sock wird fester Bind-Mount (Risiko docker_sock), Category Tools:Utilities → Werkzeuge, Default „/“', async () => {
  const v = vorlageAusXml(await xml('selfhosters-dozzle.xml'));
  assert.equal(v.id, 'unraid-dozzle'); assert.equal(v.kategorie, 'Werkzeuge'); assert.equal(v.webui, 'http://{HOST}:{PORT_8080}/');
  const doc = yamlLesen(v.compose);
  assert.deepEqual(doc.services.app.volumes, ['/var/run/docker.sock:/var/run/docker.sock:ro', '${PFAD_DATA}:/data']);
  assert.equal(v.felder.filter((f) => f.art === 'pfad').length, 1, 'docker.sock ist kein Feld');
  assert.equal(feld(v, 'DOZZLE_BASE').standard, '/');
  assert.equal(feld(v, 'DOZZLE_KEY').art, 'variable', 'Mask=false → normale Variable');
  const r = rendern(v, {}, WURZELN);
  assert.deepEqual(r.risiken.map((x) => `${x.art}:${x.wert}`), ['docker_sock:/var/run/docker.sock']);
  assert.equal(r.binds[0].art, 'docker_sock'); assert.equal(r.binds[0].nurLesen, true);
});

test('selfhosters/vaultwarden.xml und hortusfox-web.xml: Host-Port ≠ Containerport, Pfad zu /admin, Mask → Geheimnis (Pflicht), Config ohne Name, Requires-Hinweis', async () => {
  const v = vorlageAusXml(await xml('selfhosters-vaultwarden.xml'));
  assert.equal(v.kategorie, 'Werkzeuge'); assert.equal(v.webui, 'http://{HOST}:{PORT_80}/admin');
  assert.equal(feld(v, 'PORT_80').standard, 4743, 'Host-Port aus Default, Containerport aus Target'); assert.equal(feld(v, 'PORT_80').container, 80);
  assert.deepEqual(feld(v, 'SIGNUPS_ALLOWED').werte, ['true', 'false']);
  assert.equal(feld(v, 'ADMIN_TOKEN').art, 'geheimnis'); assert.equal(feld(v, 'ADMIN_TOKEN').pflicht, true);
  assert.equal(feld(v, 'PFAD_DATA').standard, 'daten/data');
  assert.throws(() => rendern(v, {}, WURZELN), (e) => e.code === 'E_PARAMS' && e.details.feld === 'ADMIN_TOKEN', 'Pflicht-Geheimnis ohne Wert');
  const r = rendern(v, { ADMIN_TOKEN: 'abc' }, WURZELN);
  assert.deepEqual(r.ports, [{ port: 4743, protokoll: 'tcp', ziel: 80, dienst: 'app', feld: 'PORT_80' }]);
  assert.equal(r.webui, 'http://{HOST}:4743/admin');
  const h = vorlageAusXml(await xml('selfhosters-hortusfox-web.xml'));
  assert.equal(h.kategorie, 'Produktivität'); assert.equal(h.felder.length, 41);
  assert.equal(feld(h, 'APP_ONLINE_MINUTE_LIMIT').beschriftung, 'APP_ONLINE_MINUTE_LIMIT', 'Config ohne Name → Variablenname');
  assert.equal(feld(h, 'PORT_80').standard, 8080);
  assert.deepEqual(h.felder.filter((f) => f.art === 'pfad').map((f) => f.name), ['PFAD_VAR_WWW_HTML_PUBLIC_IMG', 'PFAD_VAR_WWW_HTML_APP_LOGS']);
  assert.equal(feld(h, 'PFAD_VAR_WWW_HTML_PUBLIC_IMG').standard, 'daten/img');
  assert.ok(h.hinweise.some((x) => /Voraussetzung laut Vorlage: MariaDB/.test(x)));
  assert.equal(feld(h, 'SMTP_PASSWORD').art, 'variable', 'ohne Mask kein Geheimnis (Vorlage sagt Mask=false)');
});

test('ExtraParams: Zerlegen mit Anführungszeichen, bekannte Schalter übersetzt, Unbekanntes als Hinweis; PostArgs verworfen; Kategorien; slug', () => {
  assert.deepEqual(extraParamsZerlegen(`--restart=always -e "A=b c" --cap-add=NET_ADMIN --device /dev/dri:/dev/dri --sysctl="net.ipv4.ip_forward=1" --stop-timeout 60 --log-opt max-size=5m --init`), ['--restart=always', '-e', 'A=b c', '--cap-add=NET_ADMIN', '--device', '/dev/dri:/dev/dri', '--sysctl=net.ipv4.ip_forward=1', '--stop-timeout', '60', '--log-opt', 'max-size=5m', '--init']);
  const { dienst, hinweise } = extraParamsUebersetzen('--restart=always -e "A=b c" --cap-add=NET_ADMIN --device /dev/dri:/dev/dri --sysctl="net.ipv4.ip_forward=1" --stop-timeout 60 --log-opt max-size=5m --init --gpus all --komisch=1 --privileged --pid=host --shm-size=1g --user 1000:1000 --hostname nas');
  assert.equal(dienst.restart, 'always'); assert.deepEqual(dienst.environment, ['A=b c']); assert.deepEqual(dienst.cap_add, ['NET_ADMIN']); assert.deepEqual(dienst.devices, ['/dev/dri:/dev/dri']);
  assert.deepEqual(dienst.sysctls, ['net.ipv4.ip_forward=1']); assert.equal(dienst.stop_grace_period, '60s'); assert.equal(dienst.init, true); assert.equal(dienst.privileged, true); assert.equal(dienst.pid, 'host');
  assert.equal(dienst.shm_size, '1g'); assert.equal(dienst.user, '1000:1000'); assert.equal(dienst.hostname, 'nas');
  assert.deepEqual(hinweise, ['ExtraParams: „--log-opt max-size=5m“ wird nicht übernommen', 'ExtraParams: „--gpus all“ wird nicht übernommen', 'ExtraParams: „--komisch 1“ unbekannt – ignoriert']);
  const v = vorlageAusUnraid({ Name: 'Mosquitto', Repository: 'eclipse-mosquitto:2', Network: 'br0', PostArgs: '/usr/sbin/mosquitto -c /config/mosquitto.conf', ExtraParams: '--cap-add=SYS_ADMIN --device=/dev/ttyUSB0 --hostname=mq', Config: [{ attr: { Name: 'MQTT', Target: '1883', Default: '1883', Mode: 'tcp', Type: 'Port' }, value: '' }, { attr: { Name: 'Konfig', Target: '/config', Default: '/mnt/user/appdata/mosquitto', Mode: 'rw', Type: 'Path' }, value: '' }, { attr: { Name: 'Webcam', Target: '', Default: '', Type: 'Device' }, value: '/dev/video0' }, { attr: { Name: 'L', Target: 'org.x', Default: 'y', Type: 'Label' }, value: 'y' }, { attr: { Name: 'Komisch', Target: 'x', Type: 'Sonstwas' }, value: '' }] });
  assert.ok(v.hinweise.some((h) => /PostArgs/.test(h)) && v.hinweise.some((h) => /br0/.test(h)) && v.hinweise.some((h) => /Config-Typ „Sonstwas“/.test(h)));
  const doc = yamlLesen(v.compose);
  assert.deepEqual(doc.services.app.devices, ['/dev/video0', '/dev/ttyUSB0']); assert.deepEqual(doc.services.app.labels, ['org.x=y']); assert.deepEqual(doc.services.app.cap_add, ['SYS_ADMIN']); assert.equal(doc.services.app.hostname, 'mq');
  const r = rendern(v, {}, WURZELN);
  assert.deepEqual(r.risiken.map((x) => x.art).sort(), ['cap_add', 'devices', 'devices']);
  assert.equal(kategorieUebersetzen('MediaApp:Video MediaApp:Music'), 'Medien'); assert.equal(kategorieUebersetzen('Tools:', ['Tools-Utilities']), 'Werkzeuge');
  assert.equal(kategorieUebersetzen('', ['HomeAutomation']), 'Smart Home'); assert.equal(kategorieUebersetzen('Unbekannt:'), 'Sonstiges'); assert.equal(kategorieUebersetzen(undefined), 'Sonstiges');
  assert.equal(slug('Binhex Jellyfin (GPU)!'), 'binhex-jellyfin-gpu'); assert.equal(slug('Ärger Ößß'), 'aerger-oessss');
});

test('Netzwerkmodus host: keine ports-Zeilen, Risiko network_host, WebUI aus Feld; Format v1 (Networking/Data/Environment)', () => {
  const host = vorlageAusUnraid({ Name: 'Netz-App', Repository: 'x/y', Network: 'host', WebUI: 'http://[IP]:[PORT:8123]/', Config: [{ attr: { Name: 'Web', Target: '8123', Default: '8123', Type: 'Port', Mode: 'tcp' }, value: '' }] });
  const doc = yamlLesen(host.compose);
  assert.equal(doc.services.app.network_mode, 'host'); assert.equal(doc.services.app.ports, undefined);
  assert.equal(host.webui, 'http://{HOST}:{PORT_8123}/');
  assert.ok(host.hinweise.some((h) => /Netzwerkmodus host/.test(h)));
  assert.deepEqual(rendern(host, {}, WURZELN).risiken.map((x) => x.art), ['network_host']);
  // v1: Networking/Data/Environment als XML
  const v1 = vorlageAusXml(`<?xml version="1.0"?><Container><Name>Alt</Name><Repository>alt/bild:1</Repository><Networking><Mode>bridge</Mode><Publish><Port><HostPort>8000</HostPort><ContainerPort>80</ContainerPort><Protocol>tcp</Protocol></Port></Publish></Networking><Data><Volume><HostDir>/mnt/cache/appdata/alt</HostDir><ContainerDir>/config</ContainerDir><Mode>rw</Mode></Volume></Data><Environment><Variable><Name>TZ</Name><Value>Europe/Berlin</Value></Variable><Variable><Name>API_KEY</Name><Value></Value></Variable></Environment><WebUI>http://[IP]:[PORT:80]</WebUI></Container>`);
  assert.deepEqual(v1.felder.map((f) => `${f.name}:${f.art}`), ['PORT_80:port', 'PFAD_CONFIG:pfad', 'TZ:variable', 'API_KEY:geheimnis']);
  assert.equal(feld(v1, 'PORT_80').standard, 8000); assert.equal(v1.webui, 'http://{HOST}:{PORT_80}');
  assert.deepEqual(yamlLesen(v1.compose).services.app.ports, ['${PORT_80}:80']);
  // Fehler: kein Name / kein Repository
  assert.throws(() => vorlageAusUnraid({ Repository: 'x' }), (e) => /<Name>/.test(e.message));
  assert.throws(() => vorlageAusUnraid({ Name: 'x', Repository: 'https://raw.github/x.plg' }), (e) => /Repository/.test(e.message));
  // Nur unsere Platzhalter bleiben Platzhalter: „$“ im Wert wird für compose maskiert
  const d = vorlageAusUnraid({ Name: 'Dollar', Repository: 'a/b', ExtraParams: '-e "PS1=$ " -e "X=${HOME}"', Config: [] });
  assert.ok(d.compose.includes('"PS1=$$ "') && d.compose.includes('"X=$${HOME}"'), d.compose);
  assert.deepEqual(rendern(d, {}, WURZELN).risiken, []);
});

test('feedParsen: Ausschnitt des echten Feeds – Plugins, Sprachpakete, Deprecated, Blacklist fallen weg; Config-@attributes; Networking-Objekt', async () => {
  const roh = await fs.readFile(path.join(DATEN, 'feed-ausschnitt.json'), 'utf8');
  const f = feedParsen(roh);
  assert.equal(f.geladen, '2026-09-25 08:10');
  assert.deepEqual(f.uebersprungen, { plugin: 1, sprache: 1, deprecated: 1, blacklist: 1, ohne_repository: 0, fehlerhaft: 0 });
  assert.deepEqual(f.eintraege.map((v) => v.id), ['unraid-dozzle', 'unraid-vaultwarden', 'unraid-cncjs', 'unraid-lansweeper-network-discovery', 'unraid-brigata-studio2go', 'unraid-alarm-hub']);
  assert.equal(f.anzahl, 6);
  const dozzle = f.eintraege[0];
  assert.equal(dozzle.quelle, 'unraid'); assert.equal(dozzle.kategorie, 'Werkzeuge'); assert.equal(dozzle.webui, 'http://{HOST}:{PORT_8080}/');
  assert.equal(dozzle.herkunft.vorlage_url, 'https://raw.githubusercontent.com/selfhosters/unRAID-CA-templates/master/templates/dozzle.xml');
  assert.equal(typeof dozzle.beliebtheit, 'number');
  assert.deepEqual(yamlLesen(dozzle.compose).services.app.volumes, ['/var/run/docker.sock:/var/run/docker.sock:ro', '${PFAD_DATA}:/data']);
  const cnc = f.eintraege[2];
  assert.equal(yamlLesen(cnc.compose).services.app.privileged, true);
  assert.ok(cnc.hinweise.some((h) => /Gerät „Webcam“ ohne Pfad/.test(h)), 'Device-Config mit /dev/ wird als Hinweis gemeldet');
  const lans = f.eintraege[3];
  assert.equal(yamlLesen(lans.compose).services.app.network_mode, 'host');
  assert.deepEqual(yamlLesen(lans.compose).services.app.cap_add, ['NET_RAW', 'NET_ADMIN']);
  assert.equal(yamlLesen(lans.compose).services.app.stop_grace_period, '60s');
  const brig = f.eintraege[4];
  assert.equal(feld(brig, 'STANDALONE_ADMIN_PASSWORD').art, 'geheimnis', 'Mask=true im Feed');
  assert.equal(yamlLesen(f.eintraege[5].compose).services.app.restart, 'unless-stopped', '--restart unless-stopped aus ExtraParams (getrennt)');
  // Alle übersetzten Einträge sind gültige Vorlagen (vorlagePruefen wirft nicht)
  for (const v of f.eintraege) vorlagePruefen(v, { quelle: 'unraid' });
  assert.throws(() => feedParsen('{"x":1}'), (e) => e.code === 'E_PARAMS' && /applist/.test(e.message));
  assert.equal(feedParsen(JSON.stringify({ applist: [{ Name: 'ohne' }, { Name: 'Kaputt', Repository: 'a b c' }] })).uebersprungen.ohne_repository, 1);
  assert.equal(feedParsen(JSON.stringify({ applist: [{ Name: 'Kaputt', Repository: 'a b c' }] })).uebersprungen.fehlerhaft, 1);
});
