// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für src/agent/apps/compose.js: YAML-Leser, Vorlagenprüfung, Feld-/Pfad-/Port-Prüfung, Rendering-Solltexte
// (compose.yml mit Platzhaltern, .env, Vorschau mit Maske), Risiko-Erkennung, Host-Ports, Bind-Mount-Wurzeln.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yamlLesen, skalarLesen, vorlagePruefen, wertePruefen, pfadPruefen, rendern, analysieren, einsetzen, envText, portsVonDienst, risikenBestaetigt, webuiRendern, platzhalter, feldNormieren, hostPorts, feldProtokolle, nasMarkenEinsetzen, hatNasMarke } from '../../src/agent/apps/compose.js';
import { adresseNormieren, adressenKollidieren } from '../../src/agent/apps/docker.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZELN = { appOrdner: '/data/apps/probe', shares: '/data/shares' };
async function beispiele() { return JSON.parse(await fs.readFile(path.join(HIER, '..', 'daten', 'katalog', 'beispiele.json'), 'utf8')).vorlagen; }

test('yaml: Mappings, Sequenzen, Skalare, Fluss-Listen, Blockskalare, Kommentare, Anführungszeichen', () => {
  const y = yamlLesen(`# Kopf
services:
  app:
    image: "louislam/uptime-kuma:1"   # Kommentar dahinter
    ports:
      - "\${PORT_WEB}:3001"
      - 8081:81/udp
    environment:
      - TZ=Europe/Berlin
      - 'A=b # kein Kommentar'
    cap_add: [NET_ADMIN, "SYS_ADMIN"]
    labels:
      a.b: "c: d"
      leer:
    command: |
      sh -c "echo hi"
      echo zwei
    beschreibung: >-
      eins
      zwei
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
    privileged: yes
    zahl: 0o17
    hex: 0xff
    fliess: 1.5
    nix: ~
  db:
    image: postgres:16
    ports:
      - target: 5432
        published: 15432
        protocol: tcp
volumes:
  dbdata: {}
  x:
    driver: local
`);
  assert.equal(y.services.app.image, 'louislam/uptime-kuma:1');
  assert.deepEqual(y.services.app.ports, ['${PORT_WEB}:3001', '8081:81/udp']);
  assert.deepEqual(y.services.app.environment, ['TZ=Europe/Berlin', 'A=b # kein Kommentar']);
  assert.deepEqual(y.services.app.cap_add, ['NET_ADMIN', 'SYS_ADMIN']);
  assert.deepEqual(y.services.app.labels, { 'a.b': 'c: d', leer: null });
  assert.equal(y.services.app.command, 'sh -c "echo hi"\necho zwei\n');
  assert.equal(y.services.app.beschreibung, 'eins zwei');
  assert.deepEqual(y.services.app.healthcheck.test, ['CMD', 'curl', '-f', 'http://localhost']);
  assert.equal(y.services.app.privileged, 'yes'); // YAML 1.2: „yes“ ist Text – die Risiko-Erkennung wertet es trotzdem als wahr
  assert.equal(y.services.app.zahl, 15); assert.equal(y.services.app.hex, 255); assert.equal(y.services.app.fliess, 1.5); assert.equal(y.services.app.nix, null);
  assert.deepEqual(y.services.db.ports, [{ target: 5432, published: 15432, protocol: 'tcp' }]);
  assert.deepEqual(y.volumes, { dbdata: {}, x: { driver: 'local' } });
  // Sequenz direkt unter dem Schlüssel (gleicher Einzug) und mehrzeilige Fluss-Liste
  assert.deepEqual(yamlLesen('a:\n- 1\n- 2\nb: [1,\n  2]\n'), { a: [1, 2], b: [1, 2] });
  assert.deepEqual(yamlLesen('---\nx: "a\\"b\\n"\n...\n'), { x: 'a"b\n' });
  assert.equal(yamlLesen('   \n\n'), null);
  assert.equal(skalarLesen("'it''s'"), "it's");
  // Ablehnungen
  for (const [text, muster] of [['a: &x 1', /Anker/], ['a: *x', /Anker/], ['a: !!str 1', /Anker/], ['a:\n\tb: 1', /Tabulator/], ['a: 1\n  b: 2', /Einzug/], ['a: 1\na: 2', /doppelt/], ['a: [1, 2', /nicht geschlossen/], ['nur text', /kein Schlüssel/]]) {
    assert.throws(() => yamlLesen(text), (e) => e.code === 'E_PARAMS' && muster.test(e.message), text);
  }
});

test('vorlagePruefen: Kennung, Compose-Schlüssel, Dienste mit image, Felder, Platzhalter nur aus Feldern', async () => {
  const [nginx, kuma] = await beispiele();
  const v = vorlagePruefen(nginx);
  assert.equal(v.id, 'test-nginx'); assert.equal(v.quelle, 'eingebaut'); assert.equal(v.felder.length, 2);
  assert.deepEqual(v.felder[0], { name: 'PORT_WEB', art: 'port', beschriftung: 'Port der Weboberfläche', erklaerung: nginx.felder[0].erklaerung, pflicht: true, standard: 8080, protokoll: 'tcp' });
  assert.equal(v.felder[1].nur_lesen, false);
  const k = vorlagePruefen(kuma, { quelle: 'eigen' });
  assert.equal(k.quelle, 'eigen', 'Quelle aus dem Aufruf gewinnt');
  assert.deepEqual(k.felder.map((f) => f.art), ['port', 'pfad', 'schalter', 'auswahl', 'geheimnis']);
  assert.equal(k.felder[2].an, '1'); assert.equal(k.felder[2].aus, '0'); assert.equal(k.felder[4].pflicht, false); assert.equal(k.felder[3].standard, 'info');
  assert.deepEqual(platzhalter('a ${X} b $Y ${Z}'), ['X', 'Y', 'Z']);
  const basis = { id: 'x', name: 'X', compose: 'services:\n  a:\n    image: i\n', felder: [] };
  assert.throws(() => vorlagePruefen({ ...basis, id: 'Groß' }), (e) => e.code === 'E_PARAMS' && e.details.feld === 'id');
  assert.throws(() => vorlagePruefen({ ...basis, compose: 'services:\n  a:\n    image: i\nsecrets:\n  s: {}\n' }), (e) => e.code === 'E_PARAMS' && /secrets/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, compose: 'services:\n  a:\n    build: .\n' }), (e) => e.code === 'E_PARAMS' && /image/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, compose: 'services:\n  a:\n    image: i\n    ports:\n      - "${PORT}:80"\n' }), (e) => e.code === 'E_PARAMS' && /Platzhalter \$\{PORT\}/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, felder: [{ name: 'port', art: 'port' }, { name: 'PORT', art: 'port' }] }), (e) => /doppelt/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, felder: [{ name: 'A', art: 'komisch' }] }), (e) => /Feldart/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, felder: [{ name: 'A', art: 'auswahl' }] }), (e) => /werte/.test(e.message));
  assert.throws(() => feldNormieren({ name: '1A', art: 'variable' }), (e) => /Feldname/.test(e.message));
  assert.equal(vorlagePruefen({ ...basis, symbol: 'http://unsicher/x.png', webui: 'ftp://x' }).symbol, '', 'nur https-Symbole');
  assert.equal(vorlagePruefen({ ...basis, compose: 'x-fahnas:\n  a: 1\nservices:\n  a:\n    image: i\n' }).id, 'x', 'x-* ist erlaubt');
  // Zusatzschlüssel des eingebauten Katalogs (§11 C2): dokumentation, risiko, verfuegbar; webui null erlaubt
  const c2 = vorlagePruefen({ ...basis, webui: null, dokumentation: 'https://doku/x', risiko: ['Zugriff auf Docker'], verfuegbar: false, hinweise: ['Erstes Passwort: admin'] });
  assert.equal(c2.webui, ''); assert.equal(c2.dokumentation, 'https://doku/x'); assert.deepEqual(c2.risiko, ['Zugriff auf Docker']); assert.equal(c2.verfuegbar, false); assert.deepEqual(c2.hinweise, ['Erstes Passwort: admin']);
  const c3 = vorlagePruefen(basis);
  assert.equal(c3.verfuegbar, true); assert.equal(c3.dokumentation, null); assert.equal(c3.risiko, undefined);
  assert.equal(vorlagePruefen({ ...basis, dokumentation: 'http://unsicher' }).dokumentation, null);
});

test('wertePruefen/pfadPruefen: Port 1–65535, Pfade nur im App-Ordner oder unter den Freigaben, Auswahl, Schalter, Geheimnis, Pflicht', async () => {
  const [, kuma] = await beispiele();
  const v = vorlagePruefen(kuma);
  const g = wertePruefen(v, { PORT_WEB: '3010', RAHMEN_ERLAUBEN: true, ADMIN_TOKEN: 'geheim-1' }, WURZELN);
  assert.deepEqual(g.werte, { PORT_WEB: 3010, PFAD_DATEN: '/data/apps/probe/daten', RAHMEN_ERLAUBEN: '1', PROTOKOLLSTUFE: 'info' });
  assert.deepEqual(g.geheimnisse, { ADMIN_TOKEN: 'geheim-1' });
  assert.deepEqual(g.hostPfade, { PFAD_DATEN: '/data/apps/probe/daten' });
  assert.deepEqual(wertePruefen(v, {}, WURZELN).geheimnisse, { ADMIN_TOKEN: '' }, 'optionales Geheimnis bleibt leer');
  const f = (werte) => { try { wertePruefen(v, werte, WURZELN); return null; } catch (e) { return e; } };
  assert.equal(f({ PORT_WEB: 0 }).details.feld, 'PORT_WEB'); assert.equal(f({ PORT_WEB: 70000 }).code, 'E_PARAMS'); assert.equal(f({ PORT_WEB: 'abc' }).code, 'E_PARAMS');
  assert.equal(f({ PROTOKOLLSTUFE: 'trace' }).details.feld, 'PROTOKOLLSTUFE');
  assert.equal(f({ RAHMEN_ERLAUBEN: 'vielleicht' }).details.feld, 'RAHMEN_ERLAUBEN');
  assert.equal(f({ FREMD: 1 }).details.wert, 'FREMD');
  assert.match(f({ ADMIN_TOKEN: "a'b" }).message, /Anführungszeichen/);
  assert.match(f({ ADMIN_TOKEN: 'a\nb' }).message, /Steuerzeichen/);
  // Pfade
  const feld = v.felder[1];
  assert.equal(pfadPruefen('daten', feld, WURZELN), '/data/apps/probe/daten');
  assert.throws(() => pfadPruefen('daten/../daten2', feld, WURZELN), (e) => /\.\./.test(e.message), 'kein .. – auch nicht innerhalb des App-Ordners');
  assert.throws(() => pfadPruefen('../andere', feld, WURZELN), (e) => /\.\./.test(e.message));
  assert.equal(pfadPruefen('/data/shares/medien/filme', feld, WURZELN), '/data/shares/medien/filme');
  assert.throws(() => pfadPruefen('/data/shares', feld, WURZELN), (e) => /Freigabe wählen/.test(e.message));
  assert.throws(() => pfadPruefen('/data/config', feld, WURZELN), (e) => /App-Ordner/.test(e.message) && e.details.feld === 'PFAD_DATEN');
  assert.throws(() => pfadPruefen('/data/apps/andere/daten', feld, WURZELN), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pfadPruefen('daten:x', feld, WURZELN), (e) => /unerlaubte Zeichen/.test(e.message));
  assert.throws(() => pfadPruefen('da"ten', feld, WURZELN), (e) => e.code === 'E_PARAMS');
  assert.throws(() => pfadPruefen('$HOME', feld, WURZELN), (e) => e.code === 'E_PARAMS');
  // Pflichtfeld ohne Standard
  const p = vorlagePruefen({ id: 'p', name: 'P', compose: 'services:\n  a:\n    image: i\n    volumes:\n      - "${PFAD}:/x"\n', felder: [{ name: 'PFAD', art: 'pfad' }] });
  assert.throws(() => wertePruefen(p, {}, WURZELN), (e) => e.code === 'E_PARAMS' && e.details.feld === 'PFAD' && /fehlt/.test(e.message));
});

test('rendern: compose.yml behält Platzhalter, .env trägt alle Werte einfach zitiert, Vorschau maskiert Geheimnisse, Ports mit Feldbezug, WebUI', async () => {
  const [, kuma] = await beispiele();
  const v = vorlagePruefen(kuma);
  const r = rendern(v, { PORT_WEB: 3010, ADMIN_TOKEN: 'tok-123', PROTOKOLLSTUFE: 'debug' }, WURZELN);
  assert.equal(r.compose, kuma.compose, 'compose.yml = Vorlage, unverändert (keine Werte im YAML)');
  assert.equal(r.env, [
    '# Erzeugt von FAH-NAS – Werte der App-Felder. Nicht von Hand ändern (Einstellungen in der Oberfläche).',
    "ADMIN_TOKEN='tok-123'", "PFAD_DATEN='/data/apps/probe/daten'", "PORT_WEB='3010'", "PROTOKOLLSTUFE='debug'", "RAHMEN_ERLAUBEN='0'", '',
  ].join('\n'));
  assert.ok(r.vorschau.includes('"3010:3001"') && r.vorschau.includes('"/data/apps/probe/daten:/app/data"') && r.vorschau.includes('ADMIN_TOKEN=********') && !r.vorschau.includes('tok-123'));
  assert.deepEqual(r.ports, [{ port: 3010, protokoll: 'tcp', ziel: 3001, dienst: 'app', feld: 'PORT_WEB' }]);
  assert.deepEqual(r.risiken, []); assert.deepEqual(r.warnungen, []);
  assert.deepEqual(r.dienste, [{ name: 'app', image: 'louislam/uptime-kuma:1' }]);
  assert.deepEqual(r.binds, [{ dienst: 'app', quelle: '/data/apps/probe/daten', nurLesen: false, art: 'app' }]);
  assert.equal(r.webui, 'http://{HOST}:3010', '{HOST} bleibt für den Browser');
  assert.equal(webuiRendern('http://{HOST}:{PORT_WEB}/admin', { PORT_WEB: 81 }, 'nas.local'), 'http://nas.local:81/admin');
  assert.equal(webuiRendern('', {}), '');
  assert.throws(() => envText({ A: "x'y" }), (e) => e.code === 'E_PARAMS');
  assert.equal(einsetzen('a ${X} ${Y}', { X: 1 }), 'a 1 ${Y}', 'unbekannte Platzhalter bleiben stehen');
  // Freigabe-Pfad als Bind-Mount
  const r2 = rendern(v, { PFAD_DATEN: '/data/shares/medien/kuma' }, WURZELN);
  assert.equal(r2.binds[0].art, 'freigabe');
});

test('Risiko-Erkennung: privileged, network_mode host, docker.sock, cap_add (NET_ADMIN nur Warnung), pid host, devices, security_opt; Bestätigung', () => {
  const doc = yamlLesen(`services:
  a:
    image: x
    privileged: true
    network_mode: host
    pid: host
    ipc: host
    cap_add: [NET_ADMIN, SYS_ADMIN, CAP_SYS_PTRACE]
    devices:
      - /dev/dri:/dev/dri
    security_opt:
      - apparmor:unconfined
    sysctls:
      - net.ipv4.ip_forward=1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /dev/ttyUSB0:/dev/ttyUSB0
      - /etc/localtime:/etc/localtime:ro
      - /data/apps/probe/daten:/d
      - dbdata:/var/lib/db
    ports:
      - "8080:80"
    restart: always
volumes:
  dbdata: {}
`);
  const a = analysieren(doc, WURZELN);
  assert.deepEqual(a.risiken.map((r) => `${r.art}:${r.wert}`).sort(), ['cap_add:NET_ADMIN', 'cap_add:SYS_ADMIN', 'cap_add:SYS_PTRACE', 'devices:/dev/dri', 'devices:/dev/ttyUSB0', 'docker_sock:/var/run/docker.sock', 'ipc_host:host', 'network_host:host', 'pid_host:host', 'privileged:true', 'security_opt:apparmor:unconfined']);
  assert.ok(a.risiken.every((r) => r.kennung === r.art && typeof r.text === 'string' && r.dienst === 'a'), 'kennung = art für die Oberfläche');
  assert.match(a.risiken.find((r) => r.wert === 'NET_ADMIN').text, /VPN- und Netzwerk-Apps/);
  assert.ok(a.warnungen.some((w) => /sysctls/.test(w)) && a.warnungen.some((w) => /ports werden im Netzwerkmodus host nicht/.test(w)));
  assert.deepEqual(a.ports, [], 'host-Netz veröffentlicht keine Ports');
  assert.equal(a.benannteVolumes, true);
  assert.deepEqual(a.binds.map((b) => b.art), ['docker_sock', 'geraet', 'zeit', 'app']);
  // Bestätigung: alle Arten nötig
  assert.throws(() => risikenBestaetigt(a.risiken, ['privileged']), (e) => e.code === 'E_RECHTE' && e.details.feld === 'bestaetigt_riskant' && e.details.noetig.includes('docker_sock') && !e.details.noetig.includes('privileged'));
  assert.deepEqual(risikenBestaetigt(a.risiken, ['privileged', 'network_host', 'pid_host', 'ipc_host', 'cap_add', 'devices', 'security_opt', 'docker_sock']).sort(), ['cap_add', 'devices', 'docker_sock', 'ipc_host', 'network_host', 'pid_host', 'privileged', 'security_opt']);
  assert.deepEqual(risikenBestaetigt([], []), []);
  // „privileged: yes“ zählt als wahr
  assert.equal(analysieren(yamlLesen('services:\n  a:\n    image: x\n    privileged: yes\n'), WURZELN).risiken[0].art, 'privileged');
  // Bind-Mounts außerhalb → Ablehnung; relative → Ablehnung; ..
  for (const [vol, muster] of [['/etc:/etc', /außerhalb/], ['/data/shares:/s', /außerhalb/], ['./x:/x', /relativer/], ['/data/apps/probe/../andere:/x', /außerhalb|\.\./], ['/data/config:/c:ro', /außerhalb/]]) {
    assert.throws(() => analysieren(yamlLesen(`services:\n  a:\n    image: x\n    volumes:\n      - "${vol}"\n`), WURZELN), (e) => e.code === 'E_PARAMS' && muster.test(e.message), vol);
  }
});

test('Host-Ports: kurze/lange Form, Bereiche, udp, Bindeadresse; nur Containerport und doppelte Ports abgelehnt', () => {
  assert.deepEqual(portsVonDienst({ ports: ['8080:80', '127.0.0.1:8081:81/udp', '9000-9002:9000-9002', { published: 15432, target: 5432, protocol: 'tcp' }, { published: '7000-7001', target: 7000 }] }), [
    { port: 8080, protokoll: 'tcp', ziel: 80 }, { port: 8081, protokoll: 'udp', ziel: 81 },
    { port: 9000, protokoll: 'tcp', ziel: 9000 }, { port: 9001, protokoll: 'tcp', ziel: 9001 }, { port: 9002, protokoll: 'tcp', ziel: 9002 },
    { port: 15432, protokoll: 'tcp', ziel: 5432 }, { port: 7000, protokoll: 'tcp', ziel: 7000 }, { port: 7001, protokoll: 'tcp', ziel: 7000 },
  ]);
  assert.throws(() => portsVonDienst({ ports: ['80'] }), (e) => /Host-Port:Container-Port/.test(e.message));
  assert.throws(() => portsVonDienst({ ports: ['70000:80'] }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => analysieren(yamlLesen('services:\n  a:\n    image: x\n    ports: ["8080:80"]\n  b:\n    image: y\n    ports: ["8080:81"]\n'), WURZELN), (e) => /doppelt/.test(e.message));
  assert.deepEqual(analysieren(yamlLesen('services:\n  a:\n    image: x\n    ports: ["8080:80", "8080:80/udp"]\n    restart: always\n'), WURZELN).ports.map((p) => p.protokoll), ['tcp', 'udp']);
});

// ---------------------------------------------------------------------------------------------------------------
// Host-Netz-Ports, Bauen aus dem Quellcode, NAS-Marken (Mini-PC 25.09.: Home Assistant 8123 hinter der Firewall,
// FAH-Adblock nicht installierbar, 0.0.0.0:53 belegt)
// ---------------------------------------------------------------------------------------------------------------
const DNS_VORLAGE = {
  id: 'dns', name: 'DNS', quelle: 'eingebaut', webui: 'http://{HOST}:{PORT_WEB}',
  compose: 'services:\n  dns:\n    image: fah-dns:latest\n    restart: unless-stopped\n    network_mode: host\n    environment:\n      - DNS_BIND=${ADRESSE}\n      - DNS_PORT=${PORT_DNS}\n      - WEB_PORT=${PORT_WEB}\n',
  felder: [
    { name: 'PORT_DNS', art: 'port', standard: 53, protokoll: 'tcp+udp', adresse_feld: 'ADRESSE' },
    { name: 'PORT_WEB', art: 'port', standard: 8053 },
    { name: 'ADRESSE', art: 'variable', standard: '{NAS_IP}', pflicht: true },
  ],
};

test('hostPorts: Port-Felder im Host-Dienst (tcp+udp mit Lauschadresse), host_ports, fester webui-Port; nur bei network_mode host', () => {
  const v = vorlagePruefen(DNS_VORLAGE, { quelle: 'eingebaut' });
  assert.deepEqual(feldProtokolle(v.felder[0]), ['tcp', 'udp']);
  assert.deepEqual(feldProtokolle({ protokoll: 'udp' }), ['udp']);
  assert.deepEqual(feldProtokolle({}), ['tcp']);
  assert.equal(v.felder[0].adresse_feld, 'ADRESSE');
  assert.deepEqual(hostPorts(v, { PORT_DNS: 53, PORT_WEB: 8053, ADRESSE: '192.168.1.29' }).map((p) => `${p.port}/${p.protokoll}@${p.adresse || '*'}:${p.feld}`),
    ['53/tcp@192.168.1.29:PORT_DNS', '53/udp@192.168.1.29:PORT_DNS', '8053/tcp@*:PORT_WEB']);
  const ha = vorlagePruefen({ id: 'ha', name: 'HA', webui: 'http://{HOST}:8123', host_ports: [{ port: 21063, protokoll: 'tcp+udp', beschreibung: 'HomeKit' }], compose: 'services:\n  ha:\n    image: ha:1\n    network_mode: host\n', felder: [] }, { quelle: 'eingebaut' });
  assert.deepEqual(hostPorts(ha, {}).map((p) => `${p.port}/${p.protokoll}`), ['21063/tcp', '21063/udp', '8123/tcp']);
  // ohne Host-Netz: nichts (Ports kommen aus ports:)
  const bruecke = vorlagePruefen({ id: 'b', name: 'B', webui: 'http://{HOST}:8123', compose: 'services:\n  a:\n    image: a:1\n    ports:\n      - "8123:8123"\n', felder: [] }, { quelle: 'eingebaut' });
  assert.deepEqual(hostPorts(bruecke, {}), []);
  assert.throws(() => vorlagePruefen({ ...DNS_VORLAGE, host_ports: [{ port: 0 }] }), (e) => e.code === 'E_PARAMS' && /host_ports/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...DNS_VORLAGE, host_ports: [{ port: 80, protokoll: 'sctp' }] }), (e) => /Protokoll/.test(e.message));
  assert.throws(() => feldNormieren({ name: 'P', art: 'port', adresse_feld: 'klein weg' }), (e) => /adresse_feld/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...DNS_VORLAGE, felder: [{ name: 'PORT_DNS', art: 'port', standard: 53, adresse_feld: 'FEHLT' }, DNS_VORLAGE.felder[1], DNS_VORLAGE.felder[2]] }), (e) => /adresse_feld FEHLT/.test(e.message));
});

test('rendern: Host-Netz-Ports landen in g.ports (Firewall), NAS-Marken werden eingesetzt, unbekannte NAS-Adresse → E_PARAMS', () => {
  const v = vorlagePruefen(DNS_VORLAGE, { quelle: 'eingebaut' });
  const g = rendern(v, {}, { ...WURZELN, nas: { ip: '192.168.1.29', gateway: '192.168.1.1' } });
  assert.equal(g.werte.ADRESSE, '192.168.1.29');
  assert.deepEqual(g.ports.map((p) => `${p.port}/${p.protokoll}`), ['53/tcp', '53/udp', '8053/tcp']);
  assert.ok(g.ports.every((p) => p.host === true));
  assert.ok(g.risiken.some((r) => r.art === 'network_host' && /Firewall gibt nur die Ports/.test(r.text || r.meldung || JSON.stringify(r))), 'Risikotext beschreibt die Firewall richtig');
  assert.throws(() => rendern(v, {}, WURZELN), (e) => e.code === 'E_PARAMS' && e.details.feld === 'ADRESSE' && /Netzadresse des NAS/.test(e.message));
  assert.equal(rendern(v, { ADRESSE: '192.168.1.5' }, WURZELN).werte.ADRESSE, '192.168.1.5', 'eigene Eingabe braucht keine NAS-Adresse');
  assert.equal(nasMarkenEinsetzen('{NAS_IP}/{NAS_GATEWAY}', { ip: '1.2.3.4', gateway: '1.2.3.1' }), '1.2.3.4/1.2.3.1');
  assert.equal(nasMarkenEinsetzen('{NAS_GATEWAY}', { ip: '1.2.3.4' }), '{NAS_GATEWAY}');
  assert.ok(hatNasMarke('x{NAS_IP}')); assert.ok(!hatNasMarke('10.0.0.1')); assert.ok(!hatNasMarke(53));
});

test('vorlagePruefen bauen: nur eingebaut, Dienst muss existieren, Image lokal mit Tag (ohne Registry/Platzhalter), release_zip ein ZIP-Name', () => {
  const basis = { id: 'fah-x', name: 'X', compose: 'services:\n  x:\n    image: fah-x:latest\n    restart: unless-stopped\n', felder: [] };
  assert.deepEqual(vorlagePruefen({ ...basis, bauen: { release_zip: 'fah-x_release.zip' } }, { quelle: 'eingebaut' }).bauen, { dienst: 'x', image: 'fah-x:latest', release_zip: 'fah-x_release.zip' });
  assert.throws(() => vorlagePruefen({ ...basis, bauen: {} }, { quelle: 'eigen' }), (e) => /Nur eingebaute/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, bauen: {} }, { quelle: 'unraid' }), (e) => /Nur eingebaute/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, bauen: { dienst: 'y' } }, { quelle: 'eingebaut' }), (e) => /kein Dienst/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, compose: basis.compose.replace('fah-x:latest', 'ghcr.io/a/fah-x:1') , bauen: {} }, { quelle: 'eingebaut' }), (e) => /lokaler Name/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, compose: basis.compose.replace('fah-x:latest', 'fah-x') , bauen: {} }, { quelle: 'eingebaut' }), (e) => /lokaler Name/.test(e.message));
  assert.throws(() => vorlagePruefen({ ...basis, bauen: { release_zip: '../x.zip' } }, { quelle: 'eingebaut' }), (e) => /ZIP-Dateiname/.test(e.message));
  assert.equal(vorlagePruefen(basis, { quelle: 'eingebaut' }).bauen, undefined);
});

test('Lauschadressen: ss-Formen normieren, Kollision nur bei Überlappung (Wildcard oder gleiche Adresse)', () => {
  assert.equal(adresseNormieren('127.0.0.53%lo'), '127.0.0.53');
  assert.equal(adresseNormieren('[::]'), '*'); assert.equal(adresseNormieren('0.0.0.0'), '*'); assert.equal(adresseNormieren('*'), '*'); assert.equal(adresseNormieren(''), '*');
  assert.equal(adresseNormieren('[fe80::1%eth0]'), 'fe80::1'); assert.equal(adresseNormieren('[::1]'), '::1');
  const fahnas53 = ['127.0.0.53', '127.0.0.54', '192.168.122.1'];
  assert.equal(adressenKollidieren('192.168.1.29', fahnas53), false, 'NAS-IP kollidiert nicht mit resolved/dnsmasq');
  assert.equal(adressenKollidieren('0.0.0.0', fahnas53), true, 'Wildcard kollidiert mit allem');
  assert.equal(adressenKollidieren(undefined, fahnas53), true, 'ohne Adresse = alle Adressen');
  assert.equal(adressenKollidieren('192.168.1.29', ['*']), true);
  assert.equal(adressenKollidieren('192.168.1.29', ['192.168.1.29']), true);
  assert.equal(adressenKollidieren('192.168.1.29', []), false);
});

test('hostPorts (Prüfung 0.2.3): Unraid-Anzeigefelder (nur webui/reines Host-Netz) zählen, Loopback-Bindung nie, Brückenfelder bleiben bei ports:', () => {
  // Unraid-Übersetzung: Platzhalter nicht im Compose, nur in webui
  const unraid = vorlagePruefen({ id: 'u', name: 'U', webui: 'http://{HOST}:{PORT_8123}', compose: 'services:\n  ha:\n    image: ha:1\n    network_mode: host\n', felder: [{ name: 'PORT_8123', art: 'port', standard: 8123 }, { name: 'PORT_21063', art: 'port', standard: 21063 }] }, { quelle: 'unraid' });
  assert.deepEqual(hostPorts(unraid, { PORT_8123: 8123, PORT_21063: 21063 }).map((p) => `${p.port}/${p.protokoll}`), ['8123/tcp', '21063/tcp'], 'reines Host-Netz: alle Port-Felder');
  // Loopback: nur lokal gemeint → nie in die Firewall
  const lokal = vorlagePruefen({ id: 'l', name: 'L', compose: 'services:\n  p:\n    image: p:1\n    network_mode: host\n    ports:\n      - "127.0.0.1:${PORT_ADMIN}:9000"\n    environment:\n      - WEB=${PORT_WEB}\n', felder: [{ name: 'PORT_ADMIN', art: 'port', standard: 9000 }, { name: 'PORT_WEB', art: 'port', standard: 8080 }] }, { quelle: 'eigen' });
  assert.deepEqual(hostPorts(lokal, { PORT_ADMIN: 9000, PORT_WEB: 8080 }).map((p) => p.port), [8080]);
  const lang = vorlagePruefen({ id: 'l2', name: 'L2', compose: 'services:\n  p:\n    image: p:1\n    network_mode: host\n    ports:\n      - target: 9000\n        published: ${PORT_ADMIN}\n        host_ip: 127.0.0.1\n', felder: [{ name: 'PORT_ADMIN', art: 'port', standard: 9000 }] }, { quelle: 'eigen' });
  assert.deepEqual(hostPorts(lang, { PORT_ADMIN: 9000 }), [], 'Langform host_ip 127.0.0.1');
  // gemischt: Feld eines Brücken-Dienstes veröffentlicht Docker selbst – kein Doppel, auch wenn webui darauf zeigt
  const gemischt = vorlagePruefen({ id: 'g', name: 'G', webui: 'http://{HOST}:{PORT_WEB}', compose: 'services:\n  web:\n    image: w:1\n    ports:\n      - "${PORT_WEB}:80"\n  agent:\n    image: a:1\n    network_mode: host\n', felder: [{ name: 'PORT_WEB', art: 'port', standard: 8088 }] }, { quelle: 'eingebaut' });
  assert.deepEqual(hostPorts(gemischt, { PORT_WEB: 8088 }), []);
  assert.deepEqual(rendern(gemischt, {}, WURZELN).ports.map((p) => `${p.port}/${p.protokoll}`), ['8088/tcp']);
});
