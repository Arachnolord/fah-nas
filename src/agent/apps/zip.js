// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ZIP-Apps (Betreiber 09.10.): Release-ZIPs mit eigener manage.sh. Zwei Konventionen kommen vor:
//  - selbstentpackend (unifi-extraktor, fah-converter …): ZIP + manage.sh in einen leeren Ordner, „manage.sh update“ sucht
//    sich die ZIP selbst;
//  - Projektordner (FunkSichta): „unzip; cd <ordner>; bash manage.sh update“, Updates mit „manage.sh update <zip>“ – die
//    manage.sh bindet Dateien ihres Ordners ein (tools/…).
// FAH-NAS deckt beide ab: Installieren = ZIP-Inhalt (ohne den einen Projektordner) in den App-Ordner entpacken, ZIP daneben,
// „manage.sh update“; neue ZIP = „manage.sh update <pfad>“ (alle bekannten manage.sh nehmen den Pfad an oder ignorieren ihn).
// Danach die Container des Ordners auslesen (Compose-Labels) → Ports, Firewall, Öffnen-Link.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { composeAusDockerfile } from './anpassung.js';
import { yamlLesen } from './compose.js';
import { jsonZeilen } from './docker.js';

export const ZIP_MAX_BYTES = 4 * 1024 ** 3;
export const MANAGE_ZEITLIMIT_MS = 3 * 60 * 60 * 1000; // FunkSichta baut beim ersten Mal Anwendung + Training
export const PROTOKOLL_DATEI = 'fahnas-install.log';
const COMPOSE_NAMEN = /^(docker-compose|compose)\.ya?ml(\.(example|beispiel|vorlage|sample))?$/i;
const COMPOSE_MAX = 512 * 1024;
const HARMLOSE_BINDS = new Set(['/etc/localtime', '/etc/timezone']);
const DOCKER_SOCK = new Set(['/var/run/docker.sock', '/run/docker.sock']);
const UMGEBUNG = Object.freeze({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/root', TERM: 'dumb', DOCKER_CLI_HINTS: 'false' });

/** Risiko „Skript“: gilt für jede ZIP-App und muss immer bestätigt werden. */
export const RISIKO_SKRIPT = Object.freeze({ art: 'skript', kennung: 'skript', dienst: null, wert: 'manage.sh', text: 'Das Installationsskript (manage.sh) dieser ZIP läuft mit vollen Rechten auf dem NAS – nur eigene oder vertrauenswürdige ZIPs installieren' });

/**
 * App-Name aus dem Dateinamen: „FunkSichta_release (2).zip“ → „funksichta“, „unifi-extraktor.zip“ → „unifi-extraktor“.
 * Leer, wenn nichts Brauchbares übrig bleibt.
 */
export function nameVorschlag(dateiname) {
  let s = path.basename(String(dateiname || '')).replace(/\.zip$/i, '').replace(/\s*\(\d+\)\s*$/, '');
  s = s.replace(/[_-](release|deploy|neu)$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 31).replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9-]{1,30}$/.test(s) ? s : '';
}

/** Lesbarer Titel aus dem Dateinamen: „FunkSichta_release.zip“ → „FunkSichta“. */
export function titelVorschlag(dateiname) {
  const s = path.basename(String(dateiname || '')).replace(/\.zip$/i, '').replace(/\s*\(\d+\)\s*$/, '').replace(/[_-](release|deploy|neu)$/i, '').trim();
  return s.slice(0, 60) || 'ZIP-App';
}

/** Einträge der ZIP (unzip -Z1). */
export async function zipEintraege(system, datei) {
  let r;
  try { r = await system.ausfuehren('unzip', ['-Z1', '--', datei], { zeitlimit_ms: 60_000 }); } catch (e) {
    throw new FahnasFehler('E_PARAMS', 'Die Datei ist keine lesbare ZIP-Datei', { feld: 'datei', ausgabe: String((e.details && e.details.ausgabe) || e.message).slice(0, 500) });
  }
  return String(r.stdout).split('\n').map((z) => z.replace(/\r$/, '')).filter((z) => z && !z.endsWith('/'));
}

/** Eine Datei aus der ZIP als Text (unzip -p), höchstens `max` Zeichen. */
async function zipText(system, datei, eintrag, max = COMPOSE_MAX) {
  const r = await system.ausfuehren('unzip', ['-p', '--', datei, eintrag], { zeitlimit_ms: 60_000 });
  return String(r.stdout).slice(0, max);
}

/**
 * manage.sh und Compose-Datei in der ZIP finden: manage.sh im Wurzelordner oder genau eine Ebene tiefer (ZIPs mit
 * einem Projektordner, z. B. FunkSichta). Die Compose-Datei liegt daneben (auch als .example).
 */
export function inhaltFinden(eintraege) {
  const sauber = (e) => !e.split('/').some((t) => t === '..' || t === '__MACOSX');
  const kandidaten = eintraege.filter((e) => /^(?:[^/]+\/)?manage\.sh$/.test(e) && sauber(e));
  const manage = kandidaten.find((e) => e === 'manage.sh') || kandidaten.sort((a, b) => a.length - b.length)[0] || null;
  let basis = manage ? manage.slice(0, manage.length - 'manage.sh'.length) : '';
  // Ohne manage.sh (Betreiber 12.10.2026): Compose-Datei oder Dockerfile im obersten Ordner oder genau eine Ebene tiefer
  if (!manage) {
    const projekt = eintraege.filter((e) => sauber(e) && /^(?:[^/]+\/)?(?:(?:docker-compose|compose)\.ya?ml|Dockerfile)$/i.test(e)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (projekt && projekt.includes('/')) basis = projekt.slice(0, projekt.lastIndexOf('/') + 1);
  }
  const imOrdner = eintraege.filter((e) => e.startsWith(basis) && !e.slice(basis.length).includes('/'));
  const namen = imOrdner.map((e) => e.slice(basis.length));
  const compose = imOrdner.filter((e) => COMPOSE_NAMEN.test(e.slice(basis.length)))
    .sort((a, b) => Number(/\.(example|beispiel|vorlage|sample)$/i.test(a)) - Number(/\.(example|beispiel|vorlage|sample)$/i.test(b)))[0] || null;
  return { manage, ordner: basis.replace(/\/$/, '') || null, compose, dockerfile: namen.some((n) => /^Dockerfile/i.test(n)) || eintraege.some((e) => e.startsWith(basis) && /(^|\/)Dockerfile[^/]*$/.test(e)), dateien: eintraege.length };
}

function wahr(w) { return w === true || /^(true|yes|on|1)$/i.test(String(w)); }

/**
 * Riskante Punkte der Compose-Datei (gleiche Arten wie bei Katalog-Apps: privileged, network_host, docker_sock …) plus
 * „host_pfade“ für Bind-Mounts außerhalb des App-Ordners. Relative Pfade (./daten) liegen im App-Ordner und sind harmlos.
 * Lässt sich die Datei nicht lesen, sucht eine Textprüfung die wichtigsten Muster (und meldet eine Warnung).
 */
export function composeRisiken(text) {
  const risiken = []; const warnungen = [];
  const risiko = (art, dienst, wert, t) => { if (!risiken.some((r) => r.art === art && r.dienst === dienst && r.wert === wert)) risiken.push({ art, kennung: art, dienst, wert: wert == null ? null : String(wert), text: t }); };
  let doc = null;
  try { doc = yamlLesen(String(text || '')); } catch (e) { warnungen.push(`Die Compose-Datei ließ sich nicht vollständig auswerten (${e.message}) – geprüft wurde nur nach Stichworten`); }
  if (doc && doc.services && typeof doc.services === 'object') {
    for (const [dn, d] of Object.entries(doc.services)) {
      if (!d || typeof d !== 'object') continue;
      if (wahr(d.privileged)) risiko('privileged', dn, true, `Dienst „${dn}“ läuft privilegiert (voller Zugriff auf das System)`);
      if (d.network_mode === 'host') risiko('network_host', dn, 'host', `Dienst „${dn}“ nutzt das Netzwerk des NAS direkt (network_mode: host) – seine Ports kennt FAH-NAS nicht und gibt sie in der Firewall nicht frei`);
      if (d.pid === 'host') risiko('pid_host', dn, 'host', `Dienst „${dn}“ sieht alle Prozesse des NAS (pid: host)`);
      for (const c of Array.isArray(d.cap_add) ? d.cap_add : []) risiko('cap_add', dn, String(c).toUpperCase(), `Dienst „${dn}“ erhält die erweiterte Berechtigung ${String(c).toUpperCase().replace(/^CAP_/, '')}`);
      for (const dev of Array.isArray(d.devices) ? d.devices : []) { const q = typeof dev === 'object' ? String(dev.source || '') : String(dev).split(':')[0]; risiko('devices', dn, q, `Dienst „${dn}“ bekommt das Gerät ${q} des NAS`); }
      for (const v of Array.isArray(d.volumes) ? d.volumes : []) {
        const q = typeof v === 'object' ? (v && v.type === 'bind' ? String(v.source || '') : '') : String(v).split(':')[0];
        if (!q.startsWith('/')) continue; // ./daten, benannte Volumes
        const n = path.posix.normalize(q);
        if (DOCKER_SOCK.has(n)) risiko('docker_sock', dn, n, `Dienst „${dn}“ erhält Zugriff auf den Docker-Dienst (${n}) – das entspricht Vollzugriff auf das NAS`);
        else if (n.startsWith('/dev/')) risiko('devices', dn, n, `Dienst „${dn}“ bekommt das Gerät ${n} des NAS`);
        else if (!HARMLOSE_BINDS.has(n)) risiko('host_pfade', dn, n, `Dienst „${dn}“ bekommt den Ordner ${n} des NAS`);
      }
    }
  } else if (text) {
    const t = String(text);
    if (/docker\.sock/.test(t)) risiko('docker_sock', null, 'docker.sock', 'Ein Dienst erhält Zugriff auf den Docker-Dienst – das entspricht Vollzugriff auf das NAS');
    if (/privileged:\s*(true|yes)/i.test(t)) risiko('privileged', null, true, 'Ein Dienst läuft privilegiert (voller Zugriff auf das System)');
    if (/network_mode:\s*["']?host/i.test(t)) risiko('network_host', null, 'host', 'Ein Dienst nutzt das Netzwerk des NAS direkt (network_mode: host)');
  }
  return { risiken, warnungen };
}

/**
 * ZIP auswerten: manage.sh (sonst Compose/Dockerfile, siehe unten); Compose-Datei (für Risiken und Vorschau), Dockerfile,
 * Vorschläge für Name und Titel. `bevorzugtCompose`: Compose/Dockerfile auch dann nehmen, wenn eine manage.sh dabei ist –
 * nur für Apps, die schon so laufen, ihr Weg ändert sich nicht.
 * @returns {Promise<{manage:string, ordner:string|null, compose_datei:string|null, compose:string, dockerfile:boolean,
 *   dateien:number, risiken:Array, warnungen:string[], name_vorschlag:string, titel_vorschlag:string}>}
 */
export async function zipAuswerten(system, datei, dateiname, { bevorzugtCompose = false } = {}) {
  const eintraege = await zipEintraege(system, datei);
  const inhalt = inhaltFinden(eintraege);
  if (!inhalt.manage || (bevorzugtCompose && (inhalt.compose || inhalt.dockerfile))) return zipOhneSkriptAuswerten(system, datei, dateiname, inhalt);
  const warnungen = [];
  let compose = '';
  if (inhalt.compose) compose = await zipText(system, datei, inhalt.compose);
  else warnungen.push('In der ZIP liegt keine Compose-Datei neben der manage.sh – riskante Rechte lassen sich vorab nicht prüfen');
  if (!inhalt.dockerfile && compose && !/\bimage:/.test(compose)) warnungen.push('Weder Dockerfile noch fertige Images gefunden – die manage.sh muss alles selbst mitbringen');
  const r = composeRisiken(compose);
  return {
    manage: inhalt.manage, ordner: inhalt.ordner, compose_datei: inhalt.compose, compose, dockerfile: inhalt.dockerfile, dateien: inhalt.dateien,
    risiken: [RISIKO_SKRIPT, ...r.risiken], warnungen: [...warnungen, ...r.warnungen],
    name_vorschlag: nameVorschlag(dateiname), titel_vorschlag: titelVorschlag(dateiname),
  };
}

/**
 * ZIP ohne manage.sh (Betreiber 12.10.2026): FAH-NAS baut und startet selbst (docker compose up -d --build). Pflicht ist
 * eine Compose-Datei ODER ein Dockerfile (dann legt FAH-NAS eine einfache Compose an, Port aus EXPOSE).
 */
async function zipOhneSkriptAuswerten(system, datei, dateiname, inhalt) {
  if (!inhalt.compose && !inhalt.dockerfile) {
    throw new FahnasFehler('E_PARAMS', 'In der ZIP liegt weder eine manage.sh noch eine Compose-Datei oder ein Dockerfile – so lässt sie sich nicht installieren', { feld: 'datei' });
  }
  const warnungen = [];
  let compose = '';
  if (inhalt.compose) compose = await zipText(system, datei, inhalt.compose);
  else {
    const eintraege = await zipEintraege(system, datei);
    const df = eintraege.find((e) => e === `${inhalt.ordner ? `${inhalt.ordner}/` : ''}Dockerfile`);
    if (!df) {
      // Nur Dockerfiles in Unterordnern: daraus entstünde eine App ohne Inhalt
      const tief = eintraege.find((e) => /\/manage\.sh$/.test(e));
      throw new FahnasFehler('E_PARAMS', tief
        ? `Die manage.sh liegt in „${path.dirname(tief)}“ – FAH-NAS sucht sie ganz oben im Projekt`
        : 'Das Dockerfile liegt nur in Unterordnern – FAH-NAS braucht es ganz oben im Projekt', { feld: 'datei' });
    }
    compose = composeAusDockerfile(await zipText(system, datei, df), 'app');
    warnungen.push('Die ZIP bringt nur ein Dockerfile mit – FAH-NAS legt eine einfache Compose-Datei an (Port aus EXPOSE). Ports, Pfade und Variablen kannst du danach unter „Bearbeiten“ einstellen.');
  }
  if (/\.(example|beispiel|vorlage|sample)$/i.test(inhalt.compose || '')) warnungen.push(`Die Compose-Datei heißt ${path.basename(inhalt.compose)} – FAH-NAS nimmt sie als Vorlage und legt sie als compose.yml an`);
  const r = composeRisiken(compose);
  return {
    manage: null, ohne_skript: true, ordner: inhalt.ordner, compose_datei: inhalt.compose, compose, dockerfile: inhalt.dockerfile, dateien: inhalt.dateien,
    risiken: r.risiken, warnungen: [...warnungen, ...r.warnungen],
    name_vorschlag: nameVorschlag(dateiname), titel_vorschlag: titelVorschlag(dateiname),
  };
}

/**
 * ZIP-Inhalt in den App-Ordner entpacken, wie es die Anleitungen verlangen („unzip; cd <projektordner>“): liegt die
 * manage.sh in einem Projektordner der ZIP (`ordnerInZip`), kommt dessen Inhalt direkt in `ziel`. unzip entfernt „../“
 * selbst; __MACOSX-Reste bleiben draußen. Danach ist manage.sh ausführbar.
 */
export async function zipAuspacken(system, datei, ordnerInZip, ziel, { mitManage = true } = {}) {
  const tmp = await fs.mkdtemp(path.join(path.dirname(ziel), '.zip-auspacken-'));
  try {
    await system.ausfuehren('unzip', ['-o', '-q', datei, '-x', '__MACOSX/*', '-d', tmp], { zeitlimit_ms: 10 * 60 * 1000, erlaubteCodes: [0, 1] });
    const quelle = ordnerInZip ? path.join(tmp, ordnerInZip) : tmp;
    for (const n of await fs.readdir(quelle)) await fs.rename(path.join(quelle, n), path.join(ziel, n));
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  if (!mitManage) return;
  const manage = path.join(ziel, 'manage.sh');
  const st = await fs.stat(manage).catch(() => null);
  if (!st || !st.size) throw new FahnasFehler('E_PARAMS', 'Die manage.sh in der ZIP ist leer oder fehlt nach dem Entpacken', { feld: 'datei' });
  await fs.chmod(manage, 0o755);
}

/**
 * Neue ZIP über eine vorhandene App ohne manage.sh legen: Dateien der ZIP ersetzen, alles andere im Ordner (Daten,
 * Anpassungen, .env) bleibt. Erst in einen Zwischenordner entpacken, dann mit cp -a darüberkopieren.
 */
export async function zipDrueberlegen(system, datei, ordnerInZip, ziel) {
  const tmp = await fs.mkdtemp(path.join(path.dirname(ziel), '.zip-auspacken-'));
  try {
    await system.ausfuehren('unzip', ['-o', '-q', datei, '-x', '__MACOSX/*', '-d', tmp], { zeitlimit_ms: 10 * 60 * 1000, erlaubteCodes: [0, 1] });
    const quelle = ordnerInZip ? path.join(tmp, ordnerInZip) : tmp;
    await system.ausfuehren('cp', ['-a', '--', `${quelle}/.`, `${ziel}/`], { zeitlimit_ms: 10 * 60 * 1000 });
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

/** ANSI-Farbcodes und Wagenrückläufe entfernen (manage.sh färbt nur am Terminal, aber sicher ist sicher). */
export function zeileSaeubern(z) { return String(z).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trimEnd(); }

/**
 * `bash manage.sh <befehl>` im App-Ordner ausführen (als root, ohne Terminal, stdin leer). Jede Ausgabezeile geht an
 * `beiZeile` und in die Protokolldatei des Ordners. Zeitlimit und Abbruch beenden die ganze Prozessgruppe (auch
 * laufende docker-Befehle). Wirft E_SYSTEM mit den letzten Zeilen, wenn das Skript nicht mit 0 endet.
 * @returns {Promise<{zeilen:string[]}>} die letzten (höchstens 400) Zeilen
 */
export async function manageAusfuehren(system, ordner, befehl, { argumente = [], beiZeile, abgebrochen, zeitlimit_ms = MANAGE_ZEITLIMIT_MS } = {}) {
  if (typeof system.starten !== 'function') throw new FahnasFehler('E_SYSTEM', 'Prozessstart nicht verfügbar');
  const log = await fs.open(path.join(ordner, PROTOKOLL_DATEI), 'a', 0o640);
  await log.write(`\n===== ${new Date().toISOString()} – manage.sh ${[befehl, ...argumente].join(' ')} (FAH-NAS) =====\n`);
  const letzte = [];
  try {
    return await new Promise((ok, nein) => {
      const kind = system.starten('bash', ['manage.sh', befehl, ...argumente], { cwd: ordner, env: { ...UMGEBUNG }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let puffer = ''; let fertig = false; let getoetet = null;
      const gruppeBeenden = (signal) => { try { process.kill(-kind.pid, signal); } catch { try { kind.kill(signal); } catch { /* schon weg */ } } };
      const zeile = (roh) => {
        const z = zeileSaeubern(roh);
        if (!z.trim()) return;
        letzte.push(z); if (letzte.length > 400) letzte.shift();
        log.write(z + '\n').catch(() => {});
        if (beiZeile) { try { beiZeile(z); } catch { /* egal */ } }
      };
      const daten = (d) => { puffer += d; let i; while ((i = puffer.indexOf('\n')) >= 0) { zeile(puffer.slice(0, i)); puffer = puffer.slice(i + 1); } };
      kind.stdout.setEncoding('utf8'); kind.stdout.on('data', daten);
      kind.stderr.setEncoding('utf8'); kind.stderr.on('data', daten);
      const timer = setTimeout(() => { getoetet = 'zeit'; gruppeBeenden('SIGTERM'); setTimeout(() => gruppeBeenden('SIGKILL'), 10_000).unref(); }, zeitlimit_ms); timer.unref();
      const waechter = setInterval(() => { if (!getoetet && abgebrochen && abgebrochen()) { getoetet = 'abbruch'; gruppeBeenden('SIGTERM'); setTimeout(() => gruppeBeenden('SIGKILL'), 10_000).unref(); } }, 500); waechter.unref();
      const ende = (code, startFehler) => {
        if (fertig) return; fertig = true; clearTimeout(timer); clearInterval(waechter);
        if (puffer.trim()) zeile(puffer);
        const ausgabe = letzte.slice(-40).join('\n');
        if (startFehler) return nein(new FahnasFehler('E_SYSTEM', `manage.sh ließ sich nicht starten: ${startFehler}`, { ausgabe }));
        if (getoetet === 'abbruch') return nein(new FahnasFehler('E_ABGEBROCHEN', 'Abgebrochen', { ausgabe }));
        if (getoetet === 'zeit') return nein(new FahnasFehler('E_SYSTEM', `manage.sh ${befehl} lief länger als ${Math.round(zeitlimit_ms / 60000)} Minuten und wurde beendet`, { ausgabe }));
        if (code !== 0) return nein(new FahnasFehler('E_SYSTEM', `manage.sh ${befehl} brach ab (Code ${code}): ${letzte.slice(-2).join(' · ').slice(0, 400)}`, { ausgabe, code }));
        ok({ zeilen: [...letzte] });
      };
      kind.on('error', (e) => ende(-1, e.message));
      kind.on('close', (code) => ende(code));
    });
  } finally {
    await log.close().catch(() => {});
  }
}

/**
 * Container, die Docker Compose aus `ordner` angelegt hat (Label com.docker.compose.project.working_dir) – egal unter
 * welchem Projektnamen die manage.sh sie gestartet hat. Je Container: Projekt, Dienst, Compose-Dateien, veröffentlichte
 * Host-Ports (ohne nur-lokale wie 127.0.0.1), Netzwerkmodus.
 */
export async function containerDesOrdners(system, ordner) {
  const umgebung = { PATH: UMGEBUNG.PATH, LANG: UMGEBUNG.LANG, HOME: UMGEBUNG.HOME, DOCKER_CLI_HINTS: 'false' };
  const r = await system.ausfuehren('docker', ['ps', '-a', '--no-trunc', '-q', '--filter', `label=com.docker.compose.project.working_dir=${ordner}`], { umgebung, zeitlimit_ms: 30_000 });
  const ids = [...new Set(String(r.stdout).split('\n').map((z) => z.trim()).filter((z) => /^[0-9a-f]{12,64}$/.test(z)))];
  if (!ids.length) return [];
  const i = await system.ausfuehren('docker', ['inspect', ...ids], { umgebung, zeitlimit_ms: 30_000 });
  let liste; try { liste = JSON.parse(String(i.stdout)); } catch { liste = jsonZeilen(i.stdout); }
  return (Array.isArray(liste) ? liste : []).map((c) => {
    const l = (c.Config && c.Config.Labels) || {};
    const ports = new Map();
    const bindungen = (c.HostConfig && c.HostConfig.PortBindings) || {};
    for (const [ziel, liste2] of Object.entries(bindungen)) {
      const [zport, proto] = ziel.split('/');
      for (const b of Array.isArray(liste2) ? liste2 : []) {
        const p = Number(b && b.HostPort);
        if (!Number.isInteger(p) || p < 1 || p > 65535) continue;
        if (/^(127\.|::1$|\[::1\])/.test(String(b.HostIp || ''))) continue; // nur lokal → keine Firewall-Freigabe
        ports.set(`${p}/${proto || 'tcp'}`, { port: p, protokoll: proto || 'tcp', ziel: Number(zport) || null, dienst: l['com.docker.compose.service'] || null });
      }
    }
    return {
      id: String(c.Id || ''), name: String(c.Name || '').replace(/^\//, ''), projekt: l['com.docker.compose.project'] || null,
      dienst: l['com.docker.compose.service'] || null, ordner: l['com.docker.compose.project.working_dir'] || null,
      dateien: String(l['com.docker.compose.project.config_files'] || '').split(',').map((s) => s.trim()).filter(Boolean),
      image: String((c.Config && c.Config.Image) || ''), netz: String((c.HostConfig && c.HostConfig.NetworkMode) || ''),
      zustand: String((c.State && c.State.Status) || '').toLowerCase(), ports: [...ports.values()],
      // Öffnen-Link, den die App selbst festlegt (Label fahnas.webui, z. B. „http://{HOST}:18181/“) – nur http(s)
      webui: /^https?:\/\/\S+$/i.test(String(l['fahnas.webui'] || '')) ? String(l['fahnas.webui']) : null,
    };
  });
}

/** Öffnen-Link aus den Ports (wenn kein Container ihn per Label fahnas.webui festlegt): bevorzugt der Port vor Container-Port 80/443/8080/3000/8000, sonst der erste TCP-Port. */
export function webuiAusPorts(ports) {
  const tcp = (ports || []).filter((p) => p.protokoll === 'tcp');
  if (!tcp.length) return '';
  const rang = (p) => { const i = [80, 443, 8080, 3000, 8000, 8443, 5000].indexOf(p.ziel); return i < 0 ? 99 : i; };
  const p = [...tcp].sort((a, b) => rang(a) - rang(b) || a.port - b.port)[0];
  return `${p.ziel === 443 || p.ziel === 8443 ? 'https' : 'http'}://{HOST}:${p.port}/`;
}
