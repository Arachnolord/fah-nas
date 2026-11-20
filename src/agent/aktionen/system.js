// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bereich „system“ des Agenten: Status, Einstellungen (Hostname, Zeit, Netz, SSH, Energie, Standort und Verbindungen
// für die Weltkarte), Dienste, Updates mit Schnappschüssen, S.M.A.R.T., Neustart, Prüfprotokoll, Export/Import, apply
// und Ersteinrichtung mit Startcode.
// Alle Systembefehle laufen über werkzeuge.system (Argumentlisten, keine Shell) und sind im Test ersetzbar.

import os from 'node:os';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { STANDARD } from '../../gemeinsam/konfig.js';
import { R } from '../../gemeinsam/schema.js';
import { PFADE, pruefeDateiname } from '../../gemeinsam/pfade.js';
import { rendereHostname, pruefeHostname } from '../render/hostname.js';
import { rendereNetplan, pruefeNetz, netplanPfad, schnittstellen } from '../render/netplan.js';
import { ufwAus, rendereFirewall, grundregelwerkEntschaerfen } from '../render/firewall.js';
import { rendereAdminRoot } from '../render/adminroot.js';
import { rendereSshPort, pruefeSshPort } from '../render/sshport.js';
import { exportErzeugen, importEntpacken, importAnwenden, unterschiede, aufraeumen } from '../export.js';
import { ssParsen, verbindungenZuordnen, smbStatusParsen } from '../helfer/zugriffe.js';

/** Abbildung Dienstname → systemd-Unit. Nur diese Namen sind erlaubt, keine freien Unit-Namen. */
export const DIENSTE = Object.freeze({ samba: 'smbd', docker: 'docker', libvirt: 'libvirtd', avahi: 'avahi-daemon', ssh: 'ssh' });
/** SSH an/aus schaltet Socket und Dienst gemeinsam. */
export const SSH_UNITS = Object.freeze(['ssh.socket', 'ssh.service']);

const APT_UMGEBUNG = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' });
const APT_ZEITLIMIT_MS = 60 * 60 * 1000;
const REBOOT_REQUIRED = '/var/run/reboot-required';
const ERSTEINRICHTUNG_MAX_FEHLVERSUCHE = 5;
const ERSTEINRICHTUNG_SPERRE_MS = 10 * 60 * 1000;
const SMART_ALLE_CODES = Object.freeze([...Array(256).keys()]);

/** Programm-Update aus der Oberfläche: eigene transiente Unit (überlebt den Neustart des Agenten), Ausgabe + Status im Konfig-Ordner. */
export const PROGRAMM_UNIT = 'fahnas-programm-update';
const PROGRAMM_MAX_BYTES = 200 * 1024 * 1024;
const PROGRAMM_KENNUNG = /^programm-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const PROGRAMM_STATUS = 'programm-update.json';
const PROGRAMM_LOG = 'programm-update.log';

/** Zustand im Speicher (Bremse der Ersteinrichtung, offene Import-Tickets, hochgeladene Releases, Verzögerung für Neustart). */
const bremse = { fehlversuche: 0, sperre_bis: 0 };
const importTickets = new Map();
const programmUploads = new Map();
/** Systemkonten (uid darunter) und diese Namen werden nie NAS-Admin – auch nicht im Rückfall der Ersteinrichtung. */
const ERSTE_NUTZER_UID = 1000;
const NIE_ADMIN = new Set(['root', 'nobody', 'nogroup', 'fahnas', 'konsole', 'web', 'gast', 'system', 'daemon', 'bin', 'sys', 'sync', 'www-data', 'backup', 'sshd', 'messagebus']);
export const _test = {
  verzoegerung_ms: 2000,
  letzteVerzoegerung: Promise.resolve(),
  bremseZuruecksetzen() { bremse.fehlversuche = 0; bremse.sperre_bis = 0; },
  bremse,
};

// ---------------------------------------------------------------------------------------------------------------
// Hilfsfunktionen (exportiert, damit Tests sie einzeln prüfen können)
// ---------------------------------------------------------------------------------------------------------------

/** Zustand einer systemd-Unit: "aktiv" | "inaktiv" | "fehler". */
export async function dienstZustand(system, unit) {
  try {
    const { stdout } = await system.ausfuehren('systemctl', ['is-active', unit], { erlaubteCodes: [0, 1, 2, 3, 4] });
    const z = stdout.trim().split('\n')[0];
    if (z === 'active' || z === 'reloading' || z === 'activating') return 'aktiv';
    if (z === 'failed' || z === 'deactivating') return 'fehler';
    return 'inaktiv';
  } catch {
    return 'fehler';
  }
}

/**
 * Plattenbelegung je Einhängepunkt über fs.statfs, Rückfall „df -B1“.
 * @returns {Promise<Array<{pfad, gesamt, frei, label}>>}
 */
export async function plattenLesen(system, ziele) {
  const aus = [];
  for (const { pfad, label } of ziele) {
    try {
      const st = await fs.statfs(pfad);
      aus.push({ pfad, label, gesamt: Number(st.blocks) * Number(st.bsize), frei: Number(st.bavail) * Number(st.bsize) });
      continue;
    } catch { /* Rückfall df */ }
    try {
      const { stdout } = await system.ausfuehren('df', ['-B1', '--output=size,avail', pfad]);
      const zeile = stdout.trim().split('\n').pop().trim().split(/\s+/);
      const gesamt = Number(zeile[0]); const frei = Number(zeile[1]);
      if (Number.isFinite(gesamt) && Number.isFinite(frei)) aus.push({ pfad, label, gesamt, frei });
    } catch { /* Pfad nicht eingehängt – auslassen */ }
  }
  return aus;
}

/**
 * Parst „apt-get -s dist-upgrade“: Zeilen „Inst paket [alt] (neu quelle [arch])“ und „Remv paket [alt]“.
 * Sicherheitsupdate = Quelle enthält „-security“.
 */
/** Wofür ein Paket da ist (Schild in der Update-Liste, Betreiber 12.10.2026) – null = Grundsystem. */
const PAKET_BEREICHE = [
  [/^(wireguard|qrencode)/, 'VPN'], [/^(libvirt|qemu|ovmf|swtpm|virtinst|virt-|osinfo|libosinfo|seabios|ipxe-qemu)/, 'VMs'], [/^(novnc|websockify)/, 'VM-Konsole'],
  [/^(nut|libupsclient|libnutscan)/, 'USV'], [/^rclone/, 'Cloud/WebDAV/DLNA'], [/^(nfs-|rpcbind|libnfs)/, 'NFS'],
  [/^(docker|containerd|runc|nvidia-container|libnvidia-container)/, 'Apps'], [/^(nvidia-|libnvidia|ubuntu-drivers)/, 'Grafikkarte'],
  [/^(samba|smbclient|libsmbclient|libwbclient|cifs-utils|winbind|avahi)/, 'Freigaben'], [/^(rsync|unison|inotify)/, 'Spiegelung'],
  [/^(snapper|btrfs|grub-btrfs)/, 'Schnappschüsse'], [/^(linux-image|linux-modules|linux-headers|linux-generic|linux-firmware)/, 'Kernel'], [/^(openssh|ssh)/, 'SSH/SFTP'],
  [/^(nodejs|libnode)/, 'FAH-NAS'], [/^(ffmpeg|libav)/, 'Vorschaubilder'], [/^(smartmontools|hdparm|lm-sensors|ethtool)/, 'System'],
];
export function paketBereich(name) { for (const [re, b] of PAKET_BEREICHE) if (re.test(String(name))) return b; return null; }

export function aptSimulationParsen(text) {
  const pakete = []; const entfernt = [];
  for (const zeile of String(text ?? '').split('\n')) {
    const inst = /^Inst\s+(\S+)(?:\s+\[([^\]]*)\])?\s+\(([^\s)]+)\s*([^)]*)\)/.exec(zeile);
    if (inst) {
      pakete.push({ name: inst[1], alt: inst[2] ?? null, neu: inst[3], sicherheit: /-security\b/.test(inst[4] || ''), bereich: paketBereich(inst[1]) });
      continue;
    }
    const remv = /^Remv\s+(\S+)(?:\s+\[([^\]]*)\])?/.exec(zeile);
    if (remv) entfernt.push({ name: remv[1], alt: remv[2] ?? null });
  }
  return { anzahl: pakete.length, pakete, sicherheit: pakete.filter((p) => p.sicherheit).length, entfernt };
}

/** hdparm -S-Wert aus Minuten: 0 = aus, 1–240 = n·5 s, 241–251 = (n−240)·30 min. */
export function hdparmWert(minuten) {
  const m = Number(minuten);
  if (!Number.isFinite(m) || m <= 0) return 0;
  if (m <= 20) return Math.max(1, Math.round(m * 12));
  return 240 + Math.min(11, Math.max(1, Math.ceil(m / 30)));
}

/**
 * Wertet smartctl-JSON aus (SATA und NVMe).
 * @returns {{geraet, modell, temperatur, zustand:"ok"|"warnung"|"fehler"|"unbekannt", stunden, details}}
 * „unbekannt“ = keine Werte (USB-Adapter ohne SAT, virtuelle Platte) – kein Hinweis auf einen Schaden, deshalb keine Warnung.
 */
export function smartAuswerten(geraet, json, exitCode = 0, modellFallback = null) {
  const aus = { geraet, modell: modellFallback, temperatur: null, zustand: 'ok', stunden: null, details: {} };
  const gruende = [];
  if (!json || typeof json !== 'object') {
    aus.zustand = 'unbekannt'; aus.details.hinweis = 'S.M.A.R.T. nicht lesbar'; return aus;
  }
  if (json.model_name) aus.modell = json.model_name;
  if (json.serial_number) aus.details.seriennummer = json.serial_number;
  if (json.user_capacity?.bytes) aus.details.kapazitaet = json.user_capacity.bytes;
  if (json.firmware_version) aus.details.firmware = json.firmware_version;
  if (Number.isFinite(json.temperature?.current)) aus.temperatur = json.temperature.current;
  if (Number.isFinite(json.power_on_time?.hours)) aus.stunden = json.power_on_time.hours;
  const nvme = json.nvme_smart_health_information_log;
  const meldungen = (json.smartctl?.messages ?? []).filter((m) => m && m.severity === 'error').map((m) => m.string);
  const oeffnenFehlgeschlagen = (exitCode & 0b110) !== 0 && !json.smart_status;
  if (oeffnenFehlgeschlagen || (!json.smart_status && !nvme && !json.ata_smart_attributes)) {
    aus.zustand = 'unbekannt';
    aus.details.hinweis = /USB bridge/i.test(meldungen[0] || '') ? 'Keine S.M.A.R.T.-Werte: der USB-Adapter gibt sie nicht weiter' : 'Keine S.M.A.R.T.-Werte (z. B. USB-Stick oder virtuelle Platte)';
    if (meldungen[0]) aus.details.smartctl = meldungen[0];
    return aus;
  }
  if (json.smart_status && json.smart_status.passed === false) gruende.push({ stufe: 'fehler', grund: 'Selbstprüfung der Platte meldet FEHLER' });
  if (exitCode & 0b1000) gruende.push({ stufe: 'fehler', grund: 'Platte fällt aus (smartctl Bit 3)' });
  if (exitCode & 0b10000) gruende.push({ stufe: 'warnung', grund: 'Vorwarn-Attribut unter Schwelle (smartctl Bit 4)' });
  if (nvme) {
    aus.details.typ = 'nvme';
    if (Number.isFinite(nvme.percentage_used)) aus.details.verbraucht_prozent = nvme.percentage_used;
    if (Number.isFinite(nvme.media_errors)) aus.details.medienfehler = nvme.media_errors;
    if (Number.isFinite(nvme.power_on_hours) && aus.stunden === null) aus.stunden = nvme.power_on_hours;
    if (Number.isFinite(nvme.temperature) && aus.temperatur === null) aus.temperatur = nvme.temperature;
    if (nvme.critical_warning) gruende.push({ stufe: 'fehler', grund: `Kritische Warnung der NVMe (${nvme.critical_warning})` });
    if (nvme.media_errors > 0) gruende.push({ stufe: 'warnung', grund: `${nvme.media_errors} Medienfehler` });
    if (nvme.percentage_used >= 90) gruende.push({ stufe: 'warnung', grund: `Lebensdauer zu ${nvme.percentage_used} % verbraucht` });
  }
  const tabelle = json.ata_smart_attributes?.table;
  if (Array.isArray(tabelle)) {
    aus.details.typ = aus.details.typ || 'sata';
    const kritisch = { 5: 'Reallocated_Sector_Ct', 187: 'Reported_Uncorrect', 197: 'Current_Pending_Sector', 198: 'Offline_Uncorrectable' };
    for (const a of tabelle) {
      if (!a || !(a.id in kritisch)) continue;
      const roh = Number(a.raw?.value ?? 0);
      aus.details[kritisch[a.id].toLowerCase()] = roh;
      if (roh > 0) gruende.push({ stufe: 'warnung', grund: `${a.name || kritisch[a.id]} = ${roh}` });
    }
  }
  if (gruende.some((g) => g.stufe === 'fehler')) aus.zustand = 'fehler';
  else if (gruende.length) aus.zustand = 'warnung';
  if (gruende.length) aus.details.gruende = gruende.map((g) => g.grund);
  return aus;
}

/** Zeitkonstanter Vergleich zweier Texte (über SHA-256, damit die Länge nichts verrät). */
export function zeitkonstantGleich(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function pruefeIpOderCidr(wert, feld) {
  if (typeof wert !== 'string') throw new FahnasFehler('E_PARAMS', `„${feld}“: IP-Adresse oder Netz (z. B. 10.0.0.0/24) erwartet`, { feld });
  const [ip, praefix, rest] = wert.split('/');
  const art = net.isIP(ip);
  if (art === 0 || rest !== undefined) throw new FahnasFehler('E_PARAMS', `„${feld}“: ${JSON.stringify(wert)} ist keine gültige IP-Adresse oder kein Netz`, { feld });
  if (praefix !== undefined) {
    const p = Number(praefix);
    if (!/^\d{1,3}$/.test(praefix) || p < 0 || p > (art === 4 ? 32 : 128)) throw new FahnasFehler('E_PARAMS', `„${feld}“: Präfix von ${wert} ungültig`, { feld });
  }
  return wert;
}

/** Erzeugt einen Passwort-Hash im Format aus §7 der Schnittstellen (Rückfall, wenn Bereich nutzer nicht kann). */
function scryptHash(passwort) {
  const salz = crypto.randomBytes(16);
  const hash = crypto.scryptSync(Buffer.from(passwort, 'utf8'), salz, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salz.toString('base64')}$${hash.toString('base64')}`;
}

/** Streamt einen Befehl zeilenweise (für Fortschritt beim Update). Gibt {code, ausgabe} zurück, wirft nie. */
function laufen(system, programm, argumente, { umgebung, beiZeile, zeitlimit_ms = APT_ZEITLIMIT_MS } = {}) {
  if (typeof system.starten !== 'function') {
    return system.ausfuehren(programm, argumente, { umgebung, erlaubteCodes: SMART_ALLE_CODES, zeitlimit_ms })
      .then((r) => ({ code: r.code, ausgabe: r.stdout + r.stderr }))
      .catch((e) => ({ code: -1, ausgabe: e.details?.ausgabe || e.message }));
  }
  return new Promise((ok) => {
    let kind;
    try { kind = system.starten(programm, argumente, { env: umgebung, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return ok({ code: -1, ausgabe: e.message }); }
    let ausgabe = ''; let rest = '';
    const zeilen = (d) => { rest += d; let i; while ((i = rest.indexOf('\n')) >= 0) { const z = rest.slice(0, i); rest = rest.slice(i + 1); if (beiZeile) beiZeile(z); } };
    const sammeln = (d) => { ausgabe += d; if (ausgabe.length > 400_000) ausgabe = ausgabe.slice(-200_000); zeilen(String(d)); };
    if (kind.stdout) { kind.stdout.setEncoding('utf8'); kind.stdout.on('data', sammeln); }
    if (kind.stderr) { kind.stderr.setEncoding('utf8'); kind.stderr.on('data', sammeln); }
    const timer = setTimeout(() => { try { kind.kill('SIGTERM'); } catch { /* egal */ } }, zeitlimit_ms);
    let fertig = false;
    const ende = (code, zusatz = '') => { if (fertig) return; fertig = true; clearTimeout(timer); if (rest && beiZeile) beiZeile(rest); ok({ code, ausgabe: ausgabe + zusatz }); };
    kind.on('error', (e) => ende(-1, `\n${e.message}`));
    kind.on('close', (code) => ende(code ?? -1));
  });
}

async function zeitzoneSetzen(w, zeitzone) {
  const tz = String(zeitzone || '');
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.includes('..')) {
    throw new FahnasFehler('E_PARAMS', 'Zeitzone ungültig (z. B. Europe/Berlin)', { feld: 'zeitzone' });
  }
  if (!(await w.system.existiert(path.join('/usr/share/zoneinfo', tz)))) {
    throw new FahnasFehler('E_PARAMS', `Zeitzone „${tz}“ ist unbekannt`, { feld: 'zeitzone' });
  }
  try { await w.system.ausfuehren('timedatectl', ['set-timezone', tz]); } catch (e) {
    throw new FahnasFehler('E_RENDER', 'Zeitzone konnte nicht gesetzt werden', { ausgabe: e.details?.ausgabe || e.message });
  }
  return { zeitzone: tz };
}

async function sshSetzen(w, an) {
  try {
    // Ubuntu startet sshd über ssh.socket: nur mit dem Socket ist SSH wirklich aus (sonst weckt die nächste Verbindung sshd)
    await w.system.ausfuehren('systemctl', an ? ['enable', '--now', ...SSH_UNITS] : ['disable', '--now', ...SSH_UNITS]);
  } catch (e) {
    throw new FahnasFehler('E_RENDER', an ? 'SSH konnte nicht eingeschaltet werden' : 'SSH konnte nicht ausgeschaltet werden', { ausgabe: e.details?.ausgabe || e.message });
  }
  return { ssh: an };
}

/** Liest die Platten über lsblk (nur echte Platten, keine loop/zram/CD). */
async function plattenListe(system) {
  let json;
  try {
    const { stdout } = await system.ausfuehren('lsblk', ['-J', '-d', '-o', 'NAME,TYPE,ROTA,MODEL']);
    json = JSON.parse(stdout || '{}');
  } catch (e) {
    throw new FahnasFehler('E_SYSTEM', 'Platten konnten nicht gelesen werden', { befehl: 'lsblk', ausgabe: e.details?.ausgabe || e.message });
  }
  return (json.blockdevices ?? [])
    .filter((d) => d && d.type === 'disk' && typeof d.name === 'string' && /^[a-zA-Z0-9]+$/.test(d.name) && !/^(loop|zram|sr|ram|fd)/.test(d.name))
    .map((d) => ({ name: d.name, rotierend: d.rota === true || d.rota === '1' || d.rota === 1, modell: (d.model || '').trim() || null }));
}

const HINWEISE_TTL_MS = 6 * 60 * 60 * 1000;
const hinweise = { stand: null, zeit: 0, laeuft: null, stempel: '' };
/** Änderungszeit von Paketlisten (apt-daily, „Prüfen“) und installierten Paketen (Einspielen, unattended-upgrades). */
async function aptStempel() {
  const teile = [];
  for (const p of [process.env.FAHNAS_APT_LISTEN || '/var/lib/apt/lists', process.env.FAHNAS_DPKG_STATUS || '/var/lib/dpkg/status']) {
    try { teile.push(Math.round((await fs.stat(p)).mtimeMs)); } catch { teile.push(0); }
  }
  return teile.join('/');
}
/** SMART (nur wache Platten) + Updates aus den Paketlisten. Fehler einzelner Teile → Teil leer, nie die ganze Antwort. */
async function hinweiseErmitteln(w) {
  const smart = [];
  let platten = [];
  try { platten = await plattenListe(w.system); } catch { /* lsblk fehlt */ }
  for (const pl of platten) {
    const geraet = `/dev/${pl.name}`;
    try {
      const r = await w.system.ausfuehren('smartctl', ['-j', '-H', '-A', '-n', 'standby', geraet], { erlaubteCodes: SMART_ALLE_CODES, zeitlimit_ms: 30_000 });
      let json = null; try { json = JSON.parse(r.stdout); } catch { json = null; }
      if (/STANDBY|SLEEP/i.test(String(r.stdout || '')) && (!json || !json.smart_status)) continue; // schläft – nicht wecken
      const a = smartAuswerten(geraet, json, r.code, pl.modell);
      if (a.zustand === 'fehler' || a.zustand === 'warnung') smart.push({ geraet, modell: a.modell || pl.modell || '', zustand: a.zustand, grund: (a.details && Array.isArray(a.details.gruende) && a.details.gruende[0]) || '' });
    } catch { /* smartctl fehlt */ }
  }
  let updates = null;
  try {
    const { stdout } = await w.system.ausfuehren('apt-get', ['-s', 'dist-upgrade'], { umgebung: APT_UMGEBUNG, zeitlimit_ms: 120_000 });
    const u = aptSimulationParsen(stdout);
    updates = { anzahl: u.anzahl, sicherheit: u.sicherheit, pakete: (u.pakete || []).slice(0, 300) };
  } catch { /* apt gesperrt (läuft gerade) – nächstes Mal */ }
  return { smart, updates };
}
export const _hinweise = hinweise;

/** Hersteller aus Modell/Vendor (lsblk zeigt bei SATA oft nur „ATA“ als Vendor). */
export function herstellerAusModell(modell = '', vendor = '') {
  const m = `${vendor || ''} ${modell || ''}`.trim();
  const tabelle = [[/samsung|\b(8[4-9]0|9[6-9]0)\s*(evo|pro|qvo)\b/i, 'Samsung'], [/^\s*(ata\s+)?wdc|western digital|\bwd[a-z0-9]/i, 'Western Digital'], [/seagate|^\s*(ata\s+)?st\d/i, 'Seagate'], [/toshiba|kioxia/i, 'Toshiba/Kioxia'],
    [/hgst|hitachi/i, 'HGST'], [/crucial|^\s*(ata\s+)?ct\d/i, 'Crucial'], [/kingston/i, 'Kingston'], [/intel/i, 'Intel'], [/micron/i, 'Micron'], [/sandisk/i, 'SanDisk'],
    [/sk ?hynix|hfs\d/i, 'SK hynix'], [/transcend/i, 'Transcend'], [/adata/i, 'ADATA'], [/lexar/i, 'Lexar'], [/verbatim/i, 'Verbatim'], [/patriot/i, 'Patriot'], [/teamgroup|\bteam\b/i, 'TeamGroup']];
  for (const [re, name] of tabelle) if (re.test(m)) return name;
  const v = String(vendor || '').trim();
  return v && !/^ata$/i.test(v) ? v : '';
}

const systemplatteCache = { zeit: 0, wert: null };
/** Systemplatte: Modell, Hersteller, Größe, Art (Betreiber 12.10.2026: „bei hdd sollte auch immer der hersteller dabei stehen“). */
async function systemplatteLesen(system) {
  if (systemplatteCache.wert && Date.now() - systemplatteCache.zeit < 10 * 60_000) return systemplatteCache.wert;
  try {
    const j = JSON.parse(String((await system.ausfuehren('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,MODEL,VENDOR,SIZE,ROTA,TRAN,LABEL,MOUNTPOINTS'])).stdout || '{}'));
    const alle = (x) => [x, ...(x.children || []).flatMap(alle)];
    const d = (j.blockdevices || []).find((x) => x.type === 'disk' && alle(x).some((y) => y.label === 'FAHNAS-SYSTEM' || (Array.isArray(y.mountpoints) && y.mountpoints.includes('/'))));
    if (!d) return null;
    const modell = String(d.model || '').trim();
    systemplatteCache.wert = { modell, hersteller: herstellerAusModell(modell, d.vendor), groesse: Number(d.size) || null, art: /^nvme/.test(d.name) ? 'nvme' : d.rota === true || d.rota === '1' ? 'hdd' : 'ssd' };
    systemplatteCache.zeit = Date.now();
    return systemplatteCache.wert;
  } catch { return null; }
}

/** hdparm -S auf alle rotierenden Platten; SSDs/NVMe werden ignoriert. */
async function plattenRuhe(w, minuten) {
  const wert = hdparmWert(minuten);
  const platten = (await plattenListe(w.system)).filter((p) => p.rotierend);
  const gesetzt = [];
  for (const p of platten) {
    try { await w.system.ausfuehren('hdparm', ['-S', String(wert), `/dev/${p.name}`]); gesetzt.push(p.name); } catch (e) {
      throw new FahnasFehler('E_RENDER', `Ruhezeit für /dev/${p.name} konnte nicht gesetzt werden`, { ausgabe: e.details?.ausgabe || e.message });
    }
  }
  return { wert, platten: gesetzt };
}

async function systemLaden(w) {
  const geladen = await w.konfig.laden('system.json');
  return { ...structuredClone(STANDARD['system.json']), ...geladen };
}

function zeitstempelKurz() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * Rückfall der Ersteinrichtung (nur wenn der Bereich nutzer fehlt): Linux-/Samba-Passwort direkt setzen und Eintrag in
 * users.json schreiben. Systemkonten (uid < 1000) und reservierte Namen werden abgelehnt – ein Dienstkonto darf nie
 * Passwort, Samba-Konto und Admin-Rolle bekommen.
 */
async function adminDirektAnlegen(w, { name, passwort, anzeigename }) {
  const sys = w.system;
  if (NIE_ADMIN.has(name)) throw new FahnasFehler('E_PARAMS', `„${name}“ ist ein reservierter Name`, { feld: 'name' });
  let ids = null;
  try {
    const { stdout } = await sys.ausfuehren('getent', ['passwd', name], { erlaubteCodes: [0, 2] });
    const z = stdout.trim().split('\n')[0];
    if (z) { const t = z.split(':'); ids = { uid: Number(t[2]), gid: Number(t[3]) }; }
  } catch (e) {
    throw new FahnasFehler('E_SYSTEM', 'Linux-Nutzer konnte nicht geprüft werden', { befehl: 'getent', ausgabe: e.details?.ausgabe || e.message });
  }
  if (ids && !(Number.isInteger(ids.uid) && ids.uid >= ERSTE_NUTZER_UID)) {
    throw new FahnasFehler('E_EXISTIERT', `„${name}“ ist ein Systemkonto und kann kein NAS-Admin werden – bitte einen anderen Namen wählen`, { feld: 'name' });
  }
  if (!ids) {
    // Admin = Anmeldeshell (sshd startet darüber den Root-Wrapper, render/adminroot.js)
    await sys.ausfuehren('useradd', ['-M', '-s', '/bin/bash', name]);
    const { stdout } = await sys.ausfuehren('getent', ['passwd', name], { erlaubteCodes: [0, 2] });
    const t = stdout.trim().split(':'); ids = { uid: Number(t[2]), gid: Number(t[3]) };
  }
  for (const gruppe of ['fahnas-admin', 'fahnas-nutzer']) {
    try { await sys.ausfuehren('usermod', ['-aG', gruppe, name]); } catch { /* Gruppe fehlt (Entwicklung) – Erststart legt sie an */ }
  }
  await sys.ausfuehren('chpasswd', [], { eingabe: `${name}:${passwort}\n` });
  await sys.ausfuehren('smbpasswd', ['-a', '-s', name], { eingabe: `${passwort}\n${passwort}\n` });
  const hash = scryptHash(passwort);
  await w.konfig.aendern('users.json', (u) => {
    u.nutzer = (u.nutzer ?? []).filter((n) => n.name !== name);
    u.nutzer.push({
      name, anzeigename: anzeigename || name, rolle: 'admin', uid: ids.uid, gruppen: ['fahnas-admin'], hash,
      totp: null, gesperrt: false, erstellt: new Date().toISOString(),
    });
    u.gruppen = u.gruppen ?? [];
  }); // Modus 0600 aus der MODUS-Tabelle: Hashes nur für root lesbar
  return { name, uid: ids.uid, direkt: true };
}

/**
 * Netz-Einstellung aus der Anfrage: mit `modus` ersetzt sie den Bestand komplett („dhcp“ leert Adresse/Gateway und
 * behält nur, was mitgeschickt wird; „statisch“ verlangt Schnittstelle und Adresse). Ohne `modus` ist es eine
 * Teiländerung über dem Bestand. Nötig, weil die Schema-Prüfung null-Werte auslässt – ein Mischen mit dem Bestand
 * hielte sonst die alte Schnittstelle/das alte Gateway fest.
 */
export function netzZusammenfuehren(alt, a) {
  if (a.modus !== undefined) return pruefeNetz({ modus: a.modus, schnittstelle: a.schnittstelle ?? null, adresse: a.adresse ?? null, gateway: a.gateway ?? null, dns: a.dns ?? [] });
  return pruefeNetz({ ...alt, ...a });
}

/**
 * Standort des NAS für die Weltkarte: ersetzt den Bestand komplett. Breite und Länge nur gemeinsam – beide Zahl oder
 * beide leer (die Schema-Prüfung lässt null-Werte aus, „fehlt“ heißt deshalb „leer“). Bereiche und Name prüft das Schema.
 */
export function standortUebernehmen(s) {
  const hatLat = typeof s.lat === 'number';
  const hatLon = typeof s.lon === 'number';
  if (hatLat !== hatLon) {
    throw new FahnasFehler('E_PARAMS', 'Breite und Länge gehören zusammen – bitte beide eintragen oder beide leeren', { feld: hatLat ? 'standort.lon' : 'standort.lat' });
  }
  return { lat: hatLat ? s.lat : null, lon: hatLon ? s.lon : null, name: typeof s.name === 'string' ? s.name.trim() : '' };
}

/** Versionen „a.b.c“ vergleichen: -1 (a älter), 0, 1 (a neuer). */
export function versionVergleich(a, b) {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Release-Archiv prüfen (tar -tzf): BUILD_VERSION und src/agent/agent.js im Wurzelordner, Version lesbar. Gibt die Version zurück. */
export async function releaseVersion(system, datei) {
  const kein = (grund) => new FahnasFehler('E_PARAMS', `Das ist kein FAH-NAS-Release (${grund}) – bitte die Datei fahnas_release.tar.gz wählen`, { feld: 'datei' });
  let liste;
  try { liste = (await system.ausfuehren('tar', ['-tzf', datei], { zeitlimit_ms: 120_000 })).stdout; } catch { throw kein('kein lesbares tar.gz-Archiv'); }
  const namen = new Set(String(liste).split('\n').map((z) => z.trim().replace(/^\.\//, '')));
  if (!namen.has('src/agent/agent.js')) throw kein('src/agent/agent.js fehlt');
  const eintrag = String(liste).split('\n').map((z) => z.trim()).find((z) => z.replace(/^\.\//, '') === 'BUILD_VERSION');
  if (!eintrag) throw kein('BUILD_VERSION fehlt');
  const version = String((await system.ausfuehren('tar', ['-xzOf', datei, eintrag], { zeitlimit_ms: 120_000 })).stdout).trim();
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) throw kein('Versionsangabe unlesbar');
  return version;
}

/** Zustand des letzten Programm-Updates aus Unit-Zustand und Protokoll: laeuft | erfolg | fehler | abgebrochen. */
export function programmZustand({ unitAktiv, log }) {
  if (unitAktiv) return 'laeuft';
  const ende = /^FAHNAS_ENDE (\d+)\s*$/m.exec(String(log || ''));
  if (!ende) return 'abgebrochen';
  return ende[1] === '0' ? 'erfolg' : 'fehler';
}

// ---------------------------------------------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------------------------------------------

export function registriere(reg) {
  // ---- Status -------------------------------------------------------------------------------------------------
  reg.aktion('system.status', {
    rolle: 'nutzer', schema: {}, beschreibung: 'Version, Dienste, Platten, Laufzeit',
    ausfuehren: async (_p, _k, w) => {
      const dienste = {};
      await Promise.all(Object.entries(DIENSTE).map(async ([name, unit]) => { dienste[name] = await dienstZustand(w.system, unit); }));
      const datenPfad = path.dirname(w.konfig.ordner);
      const platten = await plattenLesen(w.system, [{ pfad: '/', label: 'System' }, { pfad: datenPfad, label: 'Daten' }]);
      const daten = platten.find((p) => p.pfad === datenPfad);
      const users = await w.konfig.laden('users.json');
      return {
        version: typeof w.version === 'function' ? w.version() : '0.0.0',
        hostname: os.hostname().split('.')[0],
        laufzeit_s: Math.floor(os.uptime()),
        kernel: os.release(),
        dienste,
        platten,
        datenpartition_prozent: daten && daten.gesamt > 0 ? Math.round(((daten.gesamt - daten.frei) / daten.gesamt) * 100) : null,
        systemplatte: await systemplatteLesen(w.system),
        ersteinrichtung_noetig: !(users?.nutzer?.length > 0),
      };
    },
  });

  // ---- Einstellungen ------------------------------------------------------------------------------------------
  reg.aktion('system.lesen', { rolle: 'admin', schema: {}, beschreibung: 'system.json lesen', ausfuehren: async (_p, _k, w) => systemLaden(w) });

  reg.aktion('system.schnittstellen', {
    rolle: 'admin', schema: {}, beschreibung: 'Netzwerkschnittstellen erkennen (ip -j link)',
    ausfuehren: async (_p, _k, w) => schnittstellen({ system: w.system }),
  });

  reg.aktion('system.setzen', {
    rolle: 'admin', beschreibung: 'Einstellungen ändern und ins System rendern',
    schema: {
      aenderungen: {
        typ: 'object', pflicht: true,
        felder: {
          hostname: { typ: 'string', max: 63 },
          zeitzone: { typ: 'string', max: 64 },
          sprache: { typ: 'string', werte: ['de', 'en'] },
          design: { typ: 'string', werte: ['auto', 'hell', 'dunkel'] },
          netz: {
            typ: 'object',
            felder: {
              modus: { typ: 'string', werte: ['dhcp', 'statisch'] },
              schnittstelle: { typ: 'string', max: 15 },
              adresse: { typ: 'string', max: 18 },
              gateway: { typ: 'string', max: 15 },
              dns: { typ: 'array', max: 3, elemente: { typ: 'string', max: 45 } },
            },
          },
          energie: {
            typ: 'object',
            felder: {
              platten_ruhe_min: { typ: 'integer', min: 0, max: 330 },
              zeitplan: { typ: 'array', max: 20, elemente: { typ: 'object' } },
            },
          },
          aufbewahrung: { typ: 'object', felder: { protokoll_monate: { typ: 'integer', min: 1, max: 120 } } },
          vertraute_proxys: { typ: 'array', max: 50, elemente: { typ: 'string', max: 43 } },
          ssh: { typ: 'boolean' },
          ssh_port: { typ: 'integer', min: 1, max: 65535 },
          docker_freigabe: { typ: 'boolean' },
          standort: {
            typ: 'object',
            felder: {
              lat: { typ: 'number', min: -90, max: 90 },
              lon: { typ: 'number', min: -180, max: 180 },
              // eslint-disable-next-line no-control-regex
              name: { typ: 'string', max: 64, muster: /^[^\u0000-\u001f\u007f]*$/, hinweis: 'Der Ortsname darf keine Steuerzeichen (z. B. Zeilenumbrüche) enthalten' },
            },
          },
          verbindungen: { typ: 'object', felder: { aufzeichnen: { typ: 'boolean' } } },
          geo: { typ: 'object', felder: { stadt_laden: { typ: 'boolean' } } },
          anmeldeschutz: { typ: 'object', felder: { laender: { typ: 'array', max: 60, elemente: { typ: 'string', muster: /^[A-Za-z]{2}$/, hinweis: 'Länder als zweistellige Kürzel (z. B. DE, AT, CH)' } } } },
        },
      },
    },
    ausfuehren: async (p, _k, w) => {
      const a = p.aenderungen;
      const gerendert = [];
      let dockerGeaendert = false;
      // Lesen-Ändern-Schreiben unter der Sperre von system.json (kein Lost Update mit system.dienst o. ä.);
      // erst rendern, dann speichern: schlägt das Rendern fehl, wird nichts geschrieben und die alte Konfiguration bleibt die Wahrheit.
      const neu = await w.konfig.aendern('system.json', async (geladen) => {
        const alt = { ...structuredClone(STANDARD['system.json']), ...geladen };
        const n = structuredClone(alt);
        if (a.hostname !== undefined) n.hostname = pruefeHostname(a.hostname);
        if (a.zeitzone !== undefined) n.zeitzone = a.zeitzone;
        if (a.sprache !== undefined) n.sprache = a.sprache;
        if (a.design !== undefined) n.design = a.design;
        if (a.netz !== undefined) n.netz = netzZusammenfuehren(alt.netz, a.netz);
        if (a.energie !== undefined) n.energie = { ...alt.energie, ...a.energie };
        if (a.aufbewahrung !== undefined) n.aufbewahrung = { ...alt.aufbewahrung, ...a.aufbewahrung };
        if (a.vertraute_proxys !== undefined) n.vertraute_proxys = a.vertraute_proxys.map((v) => pruefeIpOderCidr(v, 'vertraute_proxys'));
        if (a.ssh !== undefined) n.ssh = a.ssh;
        if (a.ssh_port !== undefined) n.ssh_port = pruefeSshPort(a.ssh_port);
        if (a.docker_freigabe !== undefined) { n.docker_freigabe = a.docker_freigabe; dockerGeaendert = n.docker_freigabe !== !!alt.docker_freigabe; }
        // Weltkarte: wirken ohne Rendern – Sammler und Ortsdaten lesen system.json bei jeder Probe/Abfrage neu
        if (a.standort !== undefined) n.standort = standortUebernehmen(a.standort);
        if (a.verbindungen !== undefined) n.verbindungen = { ...alt.verbindungen, ...a.verbindungen };
        if (a.geo !== undefined) n.geo = { ...alt.geo, ...a.geo };
        // Anmeldeschutz: wirkt ohne Rendern – der Web-Dienst liest system.json nach jeder Änderung neu
        if (a.anmeldeschutz !== undefined) n.anmeldeschutz = { ...alt.anmeldeschutz, ...a.anmeldeschutz, laender: [...new Set((a.anmeldeschutz.laender ?? alt.anmeldeschutz?.laender ?? ['DE']).map((x) => String(x).toUpperCase()))] };

        if (n.hostname !== alt.hostname) { await rendereHostname(n.hostname, { system: w.system }); gerendert.push('hostname'); }
        if (n.zeitzone !== alt.zeitzone) { await zeitzoneSetzen(w, n.zeitzone); gerendert.push('zeitzone'); }
        if (JSON.stringify(n.netz) !== JSON.stringify(alt.netz)) { await rendereNetplan(n.netz, { system: w.system }); gerendert.push('netplan'); }
        const portAlt = alt.ssh_port ?? 22; const portNeu = n.ssh_port ?? 22;
        if (n.ssh !== alt.ssh || portNeu !== portAlt) {
          await rendereFirewall({ ssh: n.ssh !== false, ssh_port: portNeu }, { system: w.system });
          gerendert.push('firewall');
          if (n.ssh !== alt.ssh) { await sshSetzen(w, n.ssh !== false); gerendert.push('ssh'); }
        }
        if ((n.energie?.platten_ruhe_min ?? 0) !== (alt.energie?.platten_ruhe_min ?? 0)) { await plattenRuhe(w, n.energie.platten_ruhe_min); gerendert.push('platten_ruhe'); }
        // Port zuletzt: scheitert vorher etwas, lauscht sshd nicht schon auf einem Port, der gar nicht gespeichert wird
        if (portNeu !== portAlt) {
          try { await rendereSshPort(portNeu, { system: w.system }); } catch (e) {
            try { await rendereFirewall({ ssh: n.ssh !== false, ssh_port: portAlt }, { system: w.system }); } catch { /* nur Übersicht */ }
            throw e;
          }
          gerendert.push('ssh_port');
        }
        return n;
      });
      if (dockerGeaendert) {
        // Samba liest den Schalter aus system.json – deshalb erst nach dem Speichern rendern; scheitert es, Schalter zurück
        try { await w.intern('freigaben.apply', {}); gerendert.push('samba'); } catch (e) {
          await w.konfig.aendern('system.json', (s) => { s.docker_freigabe = !a.docker_freigabe; }, STANDARD['system.json']);
          const f = FahnasFehler.aus(e);
          throw new FahnasFehler(f.code === 'E_NICHT_GEFUNDEN' ? 'E_SYSTEM' : f.code, `Freigabe „docker“ konnte nicht ${a.docker_freigabe ? 'eingerichtet' : 'entfernt'} werden: ${f.message}`, { feld: 'docker_freigabe', ...(f.details || {}) });
        }
      }
      if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('system');
      return { ...(dockerGeaendert ? await w.konfig.laden('system.json') : neu), _gerendert: gerendert };
    },
  });

  // ---- Dienste ------------------------------------------------------------------------------------------------
  reg.aktion('system.dienst', {
    rolle: 'admin', beschreibung: 'Dienst starten/stoppen/neu starten',
    schema: { dienst: { typ: 'string', pflicht: true, werte: Object.keys(DIENSTE) }, zustand: { typ: 'string', pflicht: true, werte: ['an', 'aus', 'neustart'] } },
    ausfuehren: async (p, _k, w) => {
      const unit = DIENSTE[p.dienst];
      const units = p.dienst === 'ssh' ? SSH_UNITS : [unit];
      const argumente = p.zustand === 'an' ? ['enable', '--now', ...units] : p.zustand === 'aus' ? ['disable', '--now', ...units] : ['restart', unit];
      if (p.dienst === 'ssh' && p.zustand !== 'neustart') {
        // SSH: Firewall zuerst (bei „aus“ schließt sie Port 22), Einstellung merken
        await rendereFirewall({ ssh: p.zustand === 'an' }, { system: w.system });
      }
      try { await w.system.ausfuehren('systemctl', argumente); } catch (e) {
        throw new FahnasFehler('E_SYSTEM', `Dienst ${p.dienst} konnte nicht ${p.zustand === 'neustart' ? 'neu gestartet' : p.zustand === 'an' ? 'gestartet' : 'gestoppt'} werden`, { befehl: `systemctl ${argumente.join(' ')}`, ausgabe: e.details?.ausgabe || e.message });
      }
      if (p.dienst === 'ssh' && p.zustand !== 'neustart') {
        await w.konfig.aendern('system.json', (s) => { s.ssh = p.zustand === 'an'; }, STANDARD['system.json']);
        if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('system');
      }
      if (p.dienst === 'samba' && p.zustand !== 'neustart') {
        // Samba an/aus = Schalter „SMB“ der Protokolle: merken, Firewall (445) und Bonjour angleichen
        await w.konfig.aendern('protokolle.json', (c) => ({ ...(c || {}), smb: { aktiv: p.zustand === 'an' } }), { version: 1 });
        const sys = await w.konfig.laden('system.json', null);
        try { await rendereFirewall({ ssh: !(sys && sys.ssh === false), smb: p.zustand === 'an' }, { system: w.system, konfigOrdner: w.konfig.ordner }); } catch (e) { process.stderr.write(`[system] Firewall nach SMB: ${e.message}\n`); }
        try { await w.intern('freigaben.apply', {}); } catch { /* Bereich fehlt (Test) */ }
        w.konfigGeaendert?.('protokolle');
      }
      // Antwort mit dem ECHTEN Zustand (systemctl is-active), nicht mit dem Wunsch – die Oberfläche zeigt aktiv/inaktiv/fehler
      return { dienst: p.dienst, zustand: await dienstZustand(w.system, unit), angefordert: p.zustand, unit };
    },
  });

  // ---- Updates ------------------------------------------------------------------------------------------------
  reg.aktion('system.updates.pruefen', {
    rolle: 'admin', schema: {}, aufgabe: true, beschreibung: 'Paketquellen lesen und verfügbare Updates auflisten',
    ausfuehren: async (_p, _k, w, aufgabe) => {
      aufgabe?.fortschritt(0.1, 'Paketquellen werden gelesen');
      try { await w.system.ausfuehren('apt-get', ['update'], { umgebung: APT_UMGEBUNG, zeitlimit_ms: 600_000 }); } catch (e) {
        throw new FahnasFehler('E_SYSTEM', 'Paketquellen konnten nicht gelesen werden (Internet?)', { befehl: 'apt-get update', ausgabe: e.details?.ausgabe || e.message });
      }
      aufgabe?.fortschritt(0.7, 'Updates werden ermittelt');
      let stdout;
      try { ({ stdout } = await w.system.ausfuehren('apt-get', ['-s', 'dist-upgrade'], { umgebung: APT_UMGEBUNG, zeitlimit_ms: 600_000 })); } catch (e) {
        throw new FahnasFehler('E_SYSTEM', 'Updates konnten nicht ermittelt werden', { befehl: 'apt-get -s dist-upgrade', ausgabe: e.details?.ausgabe || e.message });
      }
      const ergebnis = aptSimulationParsen(stdout);
      aufgabe?.fortschritt(1, `${ergebnis.anzahl} Updates gefunden`);
      hinweise.stand = null; // Handlungsbedarf zeigt sofort den neuen Stand
      return { ...ergebnis, geprueft: new Date().toISOString() };
    },
  });

  reg.aktion('system.updates.einspielen', {
    rolle: 'admin', schema: {}, aufgabe: true, beschreibung: 'Updates einspielen (mit Schnappschuss davor und danach)',
    ausfuehren: async (_p, _k, w, aufgabe) => {
      const sys = w.system;
      aufgabe?.fortschritt(0.02, 'Schnappschuss vor dem Update');
      let vor = null;
      try {
        const { stdout } = await sys.ausfuehren('snapper', ['-c', 'root', 'create', '-t', 'pre', '-p', '-d', 'FAH-NAS Update', '--cleanup-algorithm', 'number']);
        vor = Number(stdout.trim()) || null;
      } catch (e) {
        throw new FahnasFehler('E_SYSTEM', 'Schnappschuss vor dem Update fehlgeschlagen – Update abgebrochen', { befehl: 'snapper create -t pre', ausgabe: e.details?.ausgabe || e.message });
      }
      aufgabe?.fortschritt(0.05, 'Umfang wird ermittelt');
      let plan = { anzahl: 0, pakete: [] };
      try { plan = aptSimulationParsen((await sys.ausfuehren('apt-get', ['-s', 'dist-upgrade'], { umgebung: APT_UMGEBUNG, zeitlimit_ms: 600_000 })).stdout); } catch { /* egal, nur Schätzung */ }
      const erwartet = Math.max(10, plan.anzahl * 8);
      let zeilen = 0;
      aufgabe?.fortschritt(0.1, plan.anzahl ? `${plan.anzahl} Pakete werden eingespielt` : 'Pakete werden eingespielt');
      const lauf = await laufen(sys, 'apt-get', ['-y', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'dist-upgrade'], {
        umgebung: APT_UMGEBUNG,
        beiZeile: (z) => {
          zeilen++;
          const kurz = z.trim().slice(0, 120);
          if (zeilen % 5 === 0 || /^(Unpacking|Setting up|Entpacken|Richte)/.test(z)) aufgabe?.fortschritt(0.1 + 0.7 * Math.min(1, zeilen / erwartet), kurz);
        },
      });
      aufgabe?.fortschritt(0.85, 'Schnappschuss nach dem Update');
      let nach = null;
      try {
        const argumente = ['-c', 'root', 'create', '-t', 'post', '-p', '-d', 'FAH-NAS Update', '--cleanup-algorithm', 'number'];
        if (vor) argumente.push('--pre-number', String(vor));
        const { stdout } = await sys.ausfuehren('snapper', argumente);
        nach = Number(stdout.trim()) || null;
      } catch { /* Post-Schnappschuss fehlgeschlagen – wird im Ergebnis sichtbar (null) */ }
      if (lauf.code !== 0) {
        throw new FahnasFehler('E_SYSTEM', 'Das Update ist fehlgeschlagen. Der Stand davor liegt als Schnappschuss vor.', {
          befehl: 'apt-get dist-upgrade', code: lauf.code, ausgabe: String(lauf.ausgabe).slice(-4000), schnappschuss_vor: vor, schnappschuss_nach: nach,
        });
      }
      const neustart_noetig = await sys.existiert(REBOOT_REQUIRED);
      aufgabe?.fortschritt(0.92, 'Nicht mehr benötigte Pakete werden entfernt');
      let autoremove = true;
      try { await sys.ausfuehren('apt-get', ['autoremove', '-y'], { umgebung: APT_UMGEBUNG, zeitlimit_ms: 600_000 }); } catch { autoremove = false; }
      const ergebnis = { eingespielt: plan.pakete.map((p) => p.name), anzahl: plan.anzahl, neustart_noetig, schnappschuss_vor: vor, schnappschuss_nach: nach, autoremove };
      hinweise.stand = null;
      aufgabe?.fortschritt(1, neustart_noetig ? 'Fertig – Neustart nötig' : 'Fertig');
      if (typeof w.ereignis === 'function') w.ereignis('system', { art: 'update_fertig', daten: { anzahl: plan.anzahl, neustart_noetig } });
      return ergebnis;
    },
  });

  // ---- FAH-NAS selbst aktualisieren (Release-Archiv aus der Oberfläche) ----------------------------------------
  // Hochladen per Ticket nach <konfig>/eingang, prüfen, dann „fahnas update“ als eigene transiente Unit: das Update startet
  // Agent und Web neu, ein Kindprozess des Agenten stürbe dabei mit (KillMode=mixed). Ausgabe und Status liegen im
  // Konfig-Ordner, der neue Agent liest sie für system.programm.status.
  const programmPfade = (w) => ({ eingang: path.join(w.konfig.ordner, 'eingang'), status: path.join(w.konfig.ordner, PROGRAMM_STATUS), log: path.join(w.konfig.ordner, PROGRAMM_LOG) });
  const programmUnitAktiv = async (w) => {
    try {
      const { stdout } = await w.system.ausfuehren('systemctl', ['is-active', PROGRAMM_UNIT], { erlaubteCodes: [0, 1, 2, 3, 4] });
      return ['active', 'activating', 'reloading'].includes(stdout.trim().split('\n')[0]);
    } catch { return false; }
  };
  /** Hochgeladenes Release zur Kennung (nur der Admin, der es hochgeladen hat) → {datei, version, version_alt, vergleich, groesse}. */
  const programmHolen = async (kennung, k, w) => {
    if (!PROGRAMM_KENNUNG.test(String(kennung || ''))) throw new FahnasFehler('E_PARAMS', 'Kennung des hochgeladenen Release ungültig', { feld: 'kennung' });
    const u = programmUploads.get(kennung);
    const datei = path.join(programmPfade(w).eingang, `${kennung}.tar.gz`);
    let st = null;
    try { st = await fs.stat(datei); } catch { /* fehlt */ }
    if (!u || !st) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Das hochgeladene Release ist nicht mehr da – bitte erneut hochladen', { feld: 'kennung' });
    if (u.nutzer !== k.nutzer) throw new FahnasFehler('E_RECHTE', 'Dieses Release hat ein anderer Admin hochgeladen', { feld: 'kennung' });
    if (st.size !== u.groesse) throw new FahnasFehler('E_ABGEBROCHEN', 'Das Release ist unvollständig angekommen – bitte erneut hochladen', { feld: 'kennung', erwartet: u.groesse, groesse: st.size });
    const version = await releaseVersion(w.system, datei);
    const alt = typeof w.version === 'function' ? w.version() : '0.0.0';
    const v = versionVergleich(version, alt);
    return { datei, version, version_alt: alt, vergleich: v > 0 ? 'neuer' : v < 0 ? 'aelter' : 'gleich', groesse: st.size, dateiname: u.dateiname };
  };

  reg.aktion('system.programm.ticket', {
    rolle: 'admin', beschreibung: 'Ticket zum Hochladen eines FAH-NAS-Release (fahnas_release.tar.gz) in den Eingang',
    schema: { dateiname: { typ: 'string', pflicht: true, max: 255 }, groesse: { typ: 'integer', pflicht: true, min: 1, max: PROGRAMM_MAX_BYTES } },
    ausfuehren: async (p, k, w) => {
      pruefeDateiname(p.dateiname, 'dateiname');
      if (!/\.(tar\.gz|tgz)$/i.test(p.dateiname)) throw new FahnasFehler('E_PARAMS', 'Bitte das Release-Archiv fahnas_release.tar.gz wählen', { feld: 'dateiname' });
      const { eingang } = programmPfade(w);
      await fs.mkdir(eingang, { recursive: true, mode: 0o750 });
      await aufraeumen(eingang);
      for (const [kn, v] of programmUploads) if (Date.now() - v.zeit > 24 * 60 * 60 * 1000) programmUploads.delete(kn);
      const kennung = `programm-${zeitstempelKurz()}-${crypto.randomBytes(3).toString('hex')}`;
      const t = w.datenkanal.ticket({ nutzer: k.nutzer, uid: 0, gid: 0, art: 'schreiben', pfad: path.join(eingang, `${kennung}.tar.gz`), dateiname: `${kennung}.tar.gz`, groesse: p.groesse });
      programmUploads.set(kennung, { nutzer: k.nutzer, groesse: p.groesse, dateiname: p.dateiname, zeit: Date.now() });
      return { ticket: t.ticket, kennung };
    },
  });

  reg.aktion('system.programm.pruefen', {
    rolle: 'admin', beschreibung: 'Hochgeladenes Release prüfen: FAH-NAS-Release? Welche Version gegenüber der laufenden?',
    schema: { kennung: { typ: 'string', pflicht: true, max: 60 } },
    ausfuehren: async (p, k, w) => {
      const r = await programmHolen(p.kennung, k, w);
      return { kennung: p.kennung, dateiname: r.dateiname, groesse: r.groesse, version_neu: r.version, version_alt: r.version_alt, vergleich: r.vergleich };
    },
  });

  reg.aktion('system.programm.einspielen', {
    rolle: 'admin', beschreibung: 'Geprüftes Release einspielen (fahnas update als eigene Unit: Schnappschuss, Tausch, Neustart, Rücktausch bei Fehler)',
    schema: { kennung: { typ: 'string', pflicht: true, max: 60 } },
    ausfuehren: async (p, k, w) => {
      if (await programmUnitAktiv(w)) throw new FahnasFehler('E_BELEGT', 'Ein FAH-NAS-Update läuft bereits');
      const laufend = typeof w.aufgaben?.liste === 'function' ? w.aufgaben.liste().filter((a) => a.status === 'laeuft' || a.status === 'wartet') : [];
      if (laufend.length) throw new FahnasFehler('E_BELEGT', `Erst warten, bis die laufenden Aufgaben fertig sind (${laufend.map((a) => a.aktion).join(', ')}) – das Update startet den Steuerdienst neu`, { aufgaben: laufend.map((a) => a.id) });
      const r = await programmHolen(p.kennung, k, w);
      const pf = programmPfade(w);
      const sha = crypto.createHash('sha256');
      for await (const teil of (await fs.open(r.datei)).createReadStream()) sha.update(teil);
      await fs.writeFile(`${r.datei}.sha256`, `${sha.digest('hex')}  ${path.basename(r.datei)}\n`, { mode: 0o600 });
      const status = { von: r.version_alt, nach: r.version, nutzer: k.nutzer, gestartet: new Date().toISOString() };
      await fs.writeFile(pf.status, JSON.stringify(status, null, 2) + '\n', { mode: 0o640 });
      await fs.writeFile(pf.log, '', { mode: 0o640 });
      const cli = path.join(w.pfade.programm || PFADE.programm, 'tools', 'fahnas');
      // Archiv und Prüfsumme nach dem Lauf weg; die letzte Zeile trägt den Exit-Code für system.programm.status
      const skript = '"$0" update "$1"; rc=$?; rm -f -- "$1" "$1.sha256"; echo "FAHNAS_ENDE $rc"; exit $rc';
      try { await w.system.ausfuehren('systemctl', ['reset-failed', PROGRAMM_UNIT], { erlaubteCodes: [0, 1, 5] }); } catch { /* nicht da */ }
      try {
        await w.system.ausfuehren('systemd-run', [`--unit=${PROGRAMM_UNIT}`, '--collect', '--quiet', '--description=FAH-NAS Programm-Update',
          `--property=StandardOutput=truncate:${pf.log}`, '--property=StandardError=inherit', '/bin/sh', '-c', skript, cli, r.datei], { zeitlimit_ms: 30_000 });
      } catch (e) {
        await fs.rm(`${r.datei}.sha256`, { force: true }).catch(() => {});
        await fs.writeFile(pf.log, `Start fehlgeschlagen: ${e.details?.ausgabe || e.message}\nFAHNAS_ENDE 1\n`).catch(() => {});
        throw new FahnasFehler('E_SYSTEM', 'Das Update konnte nicht gestartet werden', { befehl: 'systemd-run', ausgabe: e.details?.ausgabe || e.message });
      }
      programmUploads.delete(p.kennung);
      if (typeof w.ereignis === 'function') w.ereignis('system', { art: 'programm_update', daten: { von: r.version_alt, nach: r.version } });
      return { gestartet: true, von: r.version_alt, nach: r.version };
    },
  });

  reg.aktion('system.programm.status', {
    rolle: 'admin', lesend: true, beschreibung: 'Stand des letzten FAH-NAS-Updates aus der Oberfläche (die Oberfläche fragt während des Updates regelmäßig)',
    schema: {},
    ausfuehren: async (_p, _k, w) => {
      const pf = programmPfade(w);
      const version = typeof w.version === 'function' ? w.version() : '0.0.0';
      let status = null;
      try { status = JSON.parse(await fs.readFile(pf.status, 'utf8')); } catch { /* noch nie */ }
      if (!status) return { zustand: 'keins', version };
      const log = (await w.system.lesenOderNull(pf.log)) || '';
      const zustand = programmZustand({ unitAktiv: await programmUnitAktiv(w), log });
      const ausgabe = log.split('\n').filter((z) => z.trim() && !/^FAHNAS_ENDE /.test(z)).slice(-60);
      return { zustand, version, von: status.von, nach: status.nach, nutzer: status.nutzer, gestartet: status.gestartet, ausgabe };
    },
  });

  // ---- S.M.A.R.T. ---------------------------------------------------------------------------------------------
  reg.aktion('system.smart', {
    rolle: 'admin', schema: {}, beschreibung: 'Plattengesundheit (smartctl)',
    ausfuehren: async (_p, _k, w) => {
      const platten = await plattenListe(w.system);
      const aus = [];
      for (const p of platten) {
        const geraet = `/dev/${p.name}`;
        let json = null; let code = 0;
        try {
          const r = await w.system.ausfuehren('smartctl', ['-j', '-H', '-A', geraet], { erlaubteCodes: SMART_ALLE_CODES });
          code = r.code;
          try { json = JSON.parse(r.stdout); } catch { json = null; }
        } catch (e) {
          aus.push({ geraet, modell: p.modell, temperatur: null, zustand: 'warnung', stunden: null, details: { hinweis: 'smartctl nicht ausführbar', ausgabe: e.details?.ausgabe || e.message } });
          continue;
        }
        aus.push({ ...smartAuswerten(geraet, json, code, p.modell), rotierend: p.rotierend });
      }
      return aus;
    },
  });

  // ---- Hinweise für „Handlungsbedarf“ (Dashboard, 12.10.2026) -------------------------------------------------
  // SMART nur von wachen Platten (-n standby weckt keine schlafende HDD), Updates aus den vorhandenen Paketlisten (die
  // frischt apt-daily ohnehin täglich auf – hier kein apt-get update), Benachrichtigungen eingerichtet? 6 h zwischengespeichert.
  reg.aktion('system.hinweise', {
    rolle: 'admin', lesend: true, schema: { neu: { typ: 'boolean', standard: false } },
    beschreibung: 'Hinweise für „Handlungsbedarf“: SMART-Warnungen, verfügbare Updates, Benachrichtigungen eingerichtet',
    ausfuehren: async (p, _k, w) => {
      // neu ermitteln: nach 6 h, auf Wunsch, oder sobald sich Paketlisten/installierte Pakete geändert haben
      const stempel = await aptStempel();
      if (!hinweise.stand || p.neu || Date.now() - hinweise.zeit > HINWEISE_TTL_MS || stempel !== hinweise.stempel) {
        if (!hinweise.laeuft) hinweise.laeuft = hinweiseErmitteln(w).then((st) => { hinweise.stand = st; hinweise.zeit = Date.now(); hinweise.stempel = stempel; }).finally(() => { hinweise.laeuft = null; });
        await hinweise.laeuft;
      }
      const b = (await w.konfig.laden('benachrichtigungen.json', null)) || {};
      let sicherheit = [];
      try { const r = await w.intern('wartung.sicherheit', {}); sicherheit = (r && !Array.isArray(r) && 'ergebnis' in r ? r.ergebnis : r) || []; } catch { /* Bereich fehlt (Test) */ } // intern liefert {ergebnis}
      return { ...hinweise.stand, sicherheit, benachrichtigungen: !!((b.email && b.email.aktiv) || (b.ntfy && b.ntfy.aktiv)), geprueft: new Date(hinweise.zeit).toISOString() };
    },
  });

  // ---- Verbindungen (Kachel „Verbindungen“) -------------------------------------------------------------------
  reg.aktion('system.verbindungen', {
    rolle: 'admin', lesend: true, schema: {},
    beschreibung: 'Wer gerade zugreift: SMB (Nutzer, Rechner, Freigaben, offene Dateien), SSH/SFTP, WebDAV, NFS',
    ausfuehren: async (_p, _k, w) => {
      let smb = null;
      try {
        const r = await w.system.ausfuehren('smbstatus', ['--json'], { erlaubteCodes: [0, 1], zeitlimit_ms: 15_000 });
        smb = smbStatusParsen(JSON.parse(String(r.stdout)));
      } catch { /* Samba aus oder zu alt für --json */ }
      let netz = { ssh: [], webdav: [], nfs: [] };
      try {
        const prot = (await w.konfig.laden('protokolle.json', null)) || {};
        const webdavPort = prot.webdav && prot.webdav.aktiv ? Number(prot.webdav.port) || 5006 : null;
        const r = await w.system.ausfuehren('ss', ['-Htnp', 'state', 'established'], { erlaubteCodes: [0, 1], zeitlimit_ms: 15_000 });
        const liste = ssParsen(r.stdout);
        const titel = new Map();
        for (const v of liste) for (const pr of v.prozesse) if (/^sshd/.test(pr.name) && !titel.has(pr.pid)) titel.set(pr.pid, await w.system.lesenOderNull(`/proc/${pr.pid}/cmdline`).then((x) => (x || '').replace(/\0/g, ' ').trim()).catch(() => ''));
        netz = verbindungenZuordnen(liste, { webdavPort, titel: (pid) => titel.get(pid) || '' });
      } catch { /* ss fehlt */ }
      return { smb, ...netz, gemessen: new Date().toISOString() };
    },
  });

  // ---- Neustart / Herunterfahren ------------------------------------------------------------------------------
  const verzoegert = (w, art, argument) => {
    if (typeof w.ereignis === 'function') w.ereignis('system', { art, daten: { in_s: _test.verzoegerung_ms / 1000 } });
    _test.letzteVerzoegerung = new Promise((ok) => {
      const t = setTimeout(async () => {
        try { await w.system.ausfuehren('systemctl', [argument]); } catch (e) { process.stderr.write(`[system] ${argument}: ${e.message}\n`); }
        ok();
      }, _test.verzoegerung_ms);
      if (typeof t.unref === 'function' && _test.verzoegerung_ms >= 1000) t.unref();
    });
    return { geplant: true, in_s: _test.verzoegerung_ms / 1000 };
  };
  reg.aktion('system.neustart', { rolle: 'admin', schema: {}, beschreibung: 'NAS neu starten', ausfuehren: async (_p, _k, w) => verzoegert(w, 'neustart', 'reboot') });
  reg.aktion('system.herunterfahren', { rolle: 'admin', schema: {}, beschreibung: 'NAS herunterfahren', ausfuehren: async (_p, _k, w) => verzoegert(w, 'herunterfahren', 'poweroff') });

  // ---- Prüfprotokoll ------------------------------------------------------------------------------------------
  reg.aktion('system.protokoll', {
    rolle: 'admin', lesend: true, beschreibung: 'Prüfprotokoll lesen', // die Übersicht fragt alle 30 s – kein Eintrag je Abfrage
    schema: {
      von: { typ: 'string', max: 30 }, bis: { typ: 'string', max: 30 }, nutzer: { typ: 'string', max: 64 }, aktion: { typ: 'string', max: 64 },
      seite: { typ: 'integer', min: 1, max: 1_000_000 }, je_seite: { typ: 'integer', min: 1, max: 1000 },
    },
    ausfuehren: async (p, _k, w) => w.audit.lesen(p),
  });

  // ---- Export / Import ----------------------------------------------------------------------------------------
  reg.aktion('system.export', {
    rolle: 'admin', beschreibung: 'Konfiguration als Archiv exportieren (Ticket für den Datenkanal)',
    schema: { mit_geheimnissen: { typ: 'boolean', standard: false }, passwort: { typ: 'string', max: 256 } },
    ausfuehren: async (p, k, w) => {
      const e = await exportErzeugen({ konfigOrdner: w.konfig.ordner, mit_geheimnissen: p.mit_geheimnissen, passwort: p.passwort || '', system: w.system });
      const t = w.datenkanal.ticket({ nutzer: k.nutzer, uid: 0, gid: 0, art: 'lesen', pfad: e.pfad, dateiname: e.dateiname, groesse: e.groesse, mime: e.verschluesselt ? 'application/octet-stream' : 'application/x-tar' });
      return { ...t, verschluesselt: e.verschluesselt, mit_geheimnissen: p.mit_geheimnissen };
    },
  });

  reg.aktion('system.import.ticket', {
    rolle: 'admin', beschreibung: 'Ticket zum Hochladen eines Export-Archivs in den Eingang',
    schema: { dateiname: { typ: 'string', pflicht: true, max: 255 }, groesse: { typ: 'integer', min: 0, max: 2 * 1024 * 1024 * 1024 } },
    ausfuehren: async (p, k, w) => {
      pruefeDateiname(p.dateiname, 'dateiname');
      const eingang = path.join(w.konfig.ordner, 'eingang');
      await fs.mkdir(eingang, { recursive: true, mode: 0o750 });
      await aufraeumen(eingang);
      const endung = /\.fahnas$/i.test(p.dateiname) ? '.tar.fahnas' : '.tar';
      const name = `import-${zeitstempelKurz()}-${crypto.randomBytes(3).toString('hex')}${endung}`;
      const t = w.datenkanal.ticket({ nutzer: k.nutzer, uid: 0, gid: 0, art: 'schreiben', pfad: path.join(eingang, name), dateiname: name, groesse: p.groesse });
      importTickets.set(t.ticket, { dateiname: name, nutzer: k.nutzer, zeit: Date.now() });
      for (const [tk, v] of importTickets) if (Date.now() - v.zeit > 60 * 60 * 1000) importTickets.delete(tk);
      return { ticket: t.ticket, dateiname: name };
    },
  });

  reg.aktion('system.import', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Export-Archiv prüfen, Unterschiede zeigen, optional übernehmen',
    schema: {
      ticket: { typ: 'string', max: 128 }, dateiname: { typ: 'string', max: 255 },
      passwort: { typ: 'string', max: 256 }, anwenden: { typ: 'boolean', standard: false },
    },
    ausfuehren: async (p, k, w, aufgabe) => {
      let dateiname = null;
      if (p.ticket && importTickets.has(p.ticket)) {
        // nur der Admin, der das Ticket angelegt hat – sonst könnte ein anderer Admin fremde Uploads übernehmen
        const t = importTickets.get(p.ticket);
        if (t.nutzer !== k.nutzer) throw new FahnasFehler('E_RECHTE', 'Dieses Import-Ticket hat ein anderer Admin angelegt', { feld: 'ticket' });
        dateiname = t.dateiname; importTickets.delete(p.ticket);
      } else if (p.dateiname) { pruefeDateiname(p.dateiname, 'dateiname'); if (!/^[A-Za-z0-9._-]+$/.test(p.dateiname)) throw new FahnasFehler('E_PARAMS', 'Dateiname enthält unerlaubte Zeichen', { feld: 'dateiname' }); dateiname = p.dateiname; }
      else throw new FahnasFehler('E_PARAMS', 'Ticket oder Dateiname fehlt', { feld: 'ticket' });
      const eingang = path.join(w.konfig.ordner, 'eingang');
      const datei = path.join(eingang, dateiname);
      if (!(await w.system.existiert(datei))) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Hochgeladene Datei nicht gefunden – bitte erneut hochladen', { dateiname });
      aufgabe?.fortschritt(0.1, 'Archiv wird entpackt');
      let archiv;
      try {
        archiv = await importEntpacken({ datei, passwort: p.passwort, system: w.system });
      } catch (e) {
        if (!(e instanceof FahnasFehler && e.code === 'E_PARAMS' && e.details?.feld === 'passwort')) await fs.unlink(datei).catch(() => {});
        throw e;
      }
      try {
        aufgabe?.fortschritt(0.4, 'Unterschiede werden ermittelt');
        const jetzt = {
          system: await w.konfig.laden('system.json'), users: await w.konfig.laden('users.json'),
          shares: await w.konfig.laden('shares.json'), snapshots: await w.konfig.laden('snapshots.json'),
        };
        const diff = unterschiede(jetzt, archiv);
        const ergebnis = { unterschiede: diff, angewendet: false, dateiname, schema: archiv.version.schema };
        if (p.anwenden) {
          aufgabe?.fortschritt(0.6, 'Konfiguration wird übernommen');
          ergebnis.uebernommen = await importAnwenden({ inhalt: archiv.inhalt, konfigOrdner: w.konfig.ordner });
          aufgabe?.fortschritt(0.8, 'System wird gerendert');
          try { ergebnis.apply = (await w.intern('system.apply', {})).ergebnis ?? null; } catch (e) {
            const f = FahnasFehler.aus(e); ergebnis.apply = { fehler: [{ schritt: 'system.apply', code: f.code, meldung: f.message }] };
          }
          if (typeof w.konfigGeaendert === 'function') for (const b of ['system', 'nutzer', 'freigaben', 'snapshots']) w.konfigGeaendert(b);
          ergebnis.angewendet = true;
          await fs.unlink(datei).catch(() => {});
        }
        aufgabe?.fortschritt(1, p.anwenden ? 'Import abgeschlossen' : 'Unterschiede ermittelt');
        return ergebnis;
      } finally {
        await fs.rm(archiv.ordner, { recursive: true, force: true });
      }
    },
  });

  // ---- apply --------------------------------------------------------------------------------------------------
  reg.aktion('system.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Gesamte Konfiguration ins System rendern (idempotent)',
    ausfuehren: async (_p, _k, w) => {
      const gerendert = []; const uebersprungen = []; const fehler = [];
      // Firewall dauerhaft aus (Betreiber 12.10.2026): ufw aus, altes Grundregelwerk entschärfen (die eigenen Regeln mit
      // policy accept rendert der Schritt „firewall“ unten)
      await ufwAus(w.system);
      try { await grundregelwerkEntschaerfen(); } catch (e) { process.stderr.write(`[system] Grundregelwerk: ${e.message}\n`); }
      for (const a of ['nutzer.apply', 'raid.apply', 'importe.apply', 'speicherorte.apply', 'heim.apply', 'freigaben.apply', 'snapshots.apply', 'apps.apply', 'laufwerke.apply', 'vpn.apply', 'energie.apply', 'protokolle.apply', 'wartung.apply']) {
        try { await w.intern(a, {}); gerendert.push(a); } catch (e) {
          const f = FahnasFehler.aus(e);
          if (f.code === 'E_NICHT_GEFUNDEN' && f.details?.aktion === a) uebersprungen.push(a);
          else fehler.push({ schritt: a, code: f.code, meldung: f.message, details: f.details });
        }
      }
      const sys = await systemLaden(w);
      const schritt = async (name, fn) => {
        try {
          const r = await fn();
          if (r === false) uebersprungen.push(name); else gerendert.push(name);
        } catch (e) {
          const f = FahnasFehler.aus(e);
          fehler.push({ schritt: name, code: f.code, meldung: f.message, details: f.details });
        }
      };
      await schritt('hostname', () => rendereHostname(sys.hostname, { system: w.system }));
      await schritt('zeitzone', () => zeitzoneSetzen(w, sys.zeitzone));
      await schritt('netplan', async () => {
        if ((sys.netz?.modus ?? 'dhcp') === 'dhcp' && !(await w.system.existiert(netplanPfad()))) return false;
        return rendereNetplan(sys.netz, { system: w.system });
      });
      await schritt('firewall', () => rendereFirewall({ ssh: sys.ssh !== false, ssh_port: sys.ssh_port ?? 22 }, { system: w.system }));
      await schritt('ssh_port', async () => ((await rendereSshPort(sys.ssh_port ?? 22, { system: w.system })).geaendert ? true : false));
      await schritt('ssh', () => sshSetzen(w, sys.ssh !== false));
      // Admins sind im System root (Betreiber 11.11.2026), normale Konten nicht – siehe render/adminroot.js
      await schritt('admin_root', () => rendereAdminRoot({ system: w.system }));
      await schritt('platten_ruhe', async () => ((sys.energie?.platten_ruhe_min ?? 0) > 0 ? plattenRuhe(w, sys.energie.platten_ruhe_min) : false));
      return { gerendert, uebersprungen, fehler };
    },
  });

  // ---- Ersteinrichtung ----------------------------------------------------------------------------------------
  reg.aktion('system.ersteinrichtung.status', {
    rolle: 'gast', schema: {}, beschreibung: 'Ist die Ersteinrichtung nötig?',
    ausfuehren: async (_p, _k, w) => {
      const users = await w.konfig.laden('users.json');
      const noetig = !(users?.nutzer?.length > 0);
      return { noetig, startcode_vorhanden: noetig ? await w.system.existiert(w.pfade.startcode) : false, hostname: os.hostname().split('.')[0] };
    },
  });

  reg.aktion('system.ersteinrichtung', {
    rolle: 'gast', beschreibung: 'Ersten Admin mit Startcode anlegen',
    schema: {
      startcode: { typ: 'string', pflicht: true, min: 1, max: 64 },
      admin: { typ: 'object', pflicht: true, felder: { name: R.nutzername, passwort: R.passwort, anzeigename: { typ: 'string', max: 100 } } },
    },
    ausfuehren: async (p, _k, w) => {
      const users = await w.konfig.laden('users.json');
      if (users?.nutzer?.length > 0) throw new FahnasFehler('E_RECHTE', 'Die Ersteinrichtung ist bereits abgeschlossen – bitte melde dich an');
      const jetzt = Date.now();
      if (bremse.sperre_bis > jetzt) {
        throw new FahnasFehler('E_BREMSE', 'Zu viele falsche Startcodes – bitte warte, bevor du es erneut versuchst', { warte_s: Math.ceil((bremse.sperre_bis - jetzt) / 1000) });
      }
      const soll = await w.system.lesenOderNull(w.pfade.startcode);
      if (soll === null || !soll.trim()) {
        throw new FahnasFehler('E_KONFIG', 'Kein Startcode vorhanden. Führe auf der Konsole des NAS „fahnas startcode“ aus und gib den angezeigten Code hier ein.');
      }
      if (!zeitkonstantGleich(soll.trim().toUpperCase(), p.startcode.trim().toUpperCase())) {
        bremse.fehlversuche++;
        if (bremse.fehlversuche >= ERSTEINRICHTUNG_MAX_FEHLVERSUCHE) {
          bremse.fehlversuche = 0; bremse.sperre_bis = jetzt + ERSTEINRICHTUNG_SPERRE_MS;
          throw new FahnasFehler('E_BREMSE', 'Zu viele falsche Startcodes – 10 Minuten Sperre', { warte_s: ERSTEINRICHTUNG_SPERRE_MS / 1000 });
        }
        throw new FahnasFehler('E_ANMELDUNG', 'Der Startcode stimmt nicht', { verbleibend: ERSTEINRICHTUNG_MAX_FEHLVERSUCHE - bremse.fehlversuche });
      }
      const admin = { name: p.admin.name, passwort: p.admin.passwort, anzeigename: p.admin.anzeigename || p.admin.name, rolle: 'admin' };
      let ergebnis;
      try {
        ergebnis = (await w.intern('nutzer.anlegen', admin)).ergebnis ?? { name: admin.name };
      } catch (e) {
        const f = FahnasFehler.aus(e);
        const bereichFehlt = f.code === 'E_NICHT_GEFUNDEN' && f.details?.aktion === 'nutzer.anlegen';
        // Der Bereich nutzer übernimmt den Installer-Linux-Nutzer selbst und lehnt Systemkonten/Gruppennamen mit
        // E_EXISTIERT ab – das reichen wir durch. Der Rückfall greift NUR, wenn der Bereich fehlt.
        if (!bereichFehlt) throw f;
        ergebnis = await adminDirektAnlegen(w, admin);
      }
      bremse.fehlversuche = 0; bremse.sperre_bis = 0;
      try { await fs.unlink(w.pfade.startcode); } catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`[system] Startcode konnte nicht gelöscht werden: ${e.message}\n`); }
      // Konsolenanzeige (/etc/issue.d, motd) vom verbrauchten Startcode befreien – Fehler egal (Entwicklung, alte Kommandozeile)
      try { await w.system.ausfuehren(path.join((w.pfade && w.pfade.programm) || PFADE.programm, 'tools', 'fahnas'), ['issue'], { erlaubteCodes: [0, 1, 2], zeitlimit_ms: 30_000 }); } catch (e) { process.stderr.write(`[system] fahnas issue: ${e.message}\n`); }
      if (typeof w.konfigGeaendert === 'function') w.konfigGeaendert('nutzer');
      // uebernommen: der Installer-Linux-Nutzer wurde zum NAS-Admin – sein Konsolen-/SSH-Passwort ist jetzt das NAS-Passwort
      return { ok: true, name: admin.name, direkt: !!ergebnis?.direkt, uebernommen: !!ergebnis?.uebernommen };
    },
  });
}
