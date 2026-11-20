// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Weitere Protokolle neben SMB (Ausbau Oktober 2026): NFS (v4), SFTP, WebDAV, DLNA – reine Regeln ohne Systemzugriff.
// Rechte: SFTP und WebDAV sehen je Nutzer nur eine eigene Ansicht (/run/fahnas-ansicht/<nutzer>/<freigabe>, Bind-Mounts
// der erlaubten Freigaben, nur lesend wo nur Leserecht besteht). Externe Laufwerke (exFAT/NTFS ohne ACLs) erscheinen dort
// nur für Nutzer mit Schreibrecht – ein Nur-lesen-Schutz ließe sich auf ihren eingehängten Dateisystemen nicht erzwingen.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { relPfad } from '../spiegelung/regeln.js';
import { bereicheFuer, regelnNormieren, unter } from '../freigaben/ordnerrechte.js';

const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
export const ANSICHT_WURZEL = '/run/fahnas-ansicht';
export const DLNA_WURZEL = '/run/fahnas-dlna';
export const SFTP_GRUPPE = 'fahnas-sftp';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export const STANDARD = Object.freeze({
  version: 1,
  smb: { aktiv: true }, // Betreiber 12.10.2026: „smb ist auch ein netzwerkdienst und sollte auch zu deaktivieren sein“
  nfs: { aktiv: false, netz: '', freigaben: [] },
  sftp: { aktiv: false },
  webdav: { aktiv: false, port: 5006 },
  dlna: { aktiv: false, name: 'FAH-NAS', ordner: [] },
});

function cidrOk(t) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(t || '').trim());
  return !!m && m.slice(1, 5).every((x) => Number(x) <= 255) && Number(m[5]) >= 8 && Number(m[5]) <= 32;
}

export const MAX_DLNA_ORDNER = 20;

/** Medienordner der DLNA-Einstellung – auch aus der alten Form (nur ganze Freigaben). */
export function dlnaOrdner(dlna) {
  if (dlna && Array.isArray(dlna.ordner)) return dlna.ordner.filter((o) => o && o.freigabe).map((o) => ({ freigabe: String(o.freigabe), pfad: String(o.pfad || '') }));
  if (dlna && Array.isArray(dlna.freigaben)) return dlna.freigaben.map((f) => ({ freigabe: String(f), pfad: '' }));
  return [];
}

/**
 * Einträge im DLNA-Wurzelordner: Name = letzter Ordnerteil (bzw. Freigabe), bei gleichen Namen mit „(Freigabe)“ bzw.
 * Nummer eindeutig gemacht. → [{name, quelle, wurzel}] (wurzel = Freigabe, für die Prüfung gegen Verknüpfungen).
 */
export function dlnaZiele(ordner, freigaben) {
  const pfade = new Map((freigaben || []).map((f) => [f.name, f.pfad]));
  const aus = []; const namen = new Set();
  for (const o of ordner) {
    const wurzel = pfade.get(o.freigabe);
    if (!wurzel) continue;
    let name = o.pfad ? o.pfad.split('/').pop() : o.freigabe;
    if (namen.has(name)) name = `${name} (${o.freigabe})`;
    for (let i = 2; namen.has(name); i++) name = `${name.replace(/ \(\d+\)$/, '')} (${i})`;
    namen.add(name);
    aus.push({ name, quelle: o.pfad ? `${wurzel.replace(/\/+$/, '')}/${o.pfad}` : wurzel, wurzel });
  }
  return aus;
}

/** Eingaben prüfen. `freigaben` = shares.json-Liste, `nutzer` = Namen der NAS-Konten. */
export function normal(e = {}, alt = STANDARD, { freigaben = [], nutzer = [] } = {}) {
  const c = structuredClone({ ...STANDARD, ...alt });
  const intern = new Map(freigaben.filter((f) => !f.extern).map((f) => [f.name, f]));
  const alle = new Map(freigaben.map((f) => [f.name, f]));
  if (e.nfs) {
    const n = { ...c.nfs, ...e.nfs };
    n.aktiv = !!n.aktiv; n.netz = String(n.netz || '').trim();
    n.freigaben = (Array.isArray(n.freigaben) ? n.freigaben : []).map((x, i) => {
      if (!intern.has(x && x.name)) throw fehler(`NFS: „${x && x.name}“ ist keine interne Freigabe (externe Laufwerke lassen sich nicht per NFS teilen)`, `nfs.freigaben.${i}`);
      if (!nutzer.includes(x.als_nutzer)) throw fehler(`NFS: Zugriff als Nutzer „${x.als_nutzer}“ – diesen Nutzer gibt es nicht`, `nfs.freigaben.${i}.als_nutzer`);
      return { name: x.name, nur_lesen: !!x.nur_lesen, als_nutzer: x.als_nutzer };
    });
    if (n.aktiv && !cidrOk(n.netz)) throw fehler('NFS: erlaubtes Netz bitte wie 192.168.1.0/24 angeben', 'nfs.netz');
    if (n.aktiv && !n.freigaben.length) throw fehler('NFS: bitte mindestens eine Freigabe wählen', 'nfs.freigaben');
    c.nfs = n;
  }
  if (e.sftp) c.sftp = { aktiv: !!e.sftp.aktiv };
  if (e.smb) c.smb = { aktiv: e.smb.aktiv !== false };
  if (!c.smb || typeof c.smb.aktiv !== 'boolean') c.smb = { aktiv: true };
  if (e.webdav) {
    const port = Number(e.webdav.port ?? c.webdav.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8443, 3000, 8060].includes(port)) throw fehler('WebDAV-Port bitte zwischen 1024 und 65535 (Vorschlag 5006)', 'webdav.port');
    c.webdav = { aktiv: !!e.webdav.aktiv, port };
  }
  if (e.dlna) {
    const name = String(e.dlna.name ?? c.dlna.name).trim() || 'FAH-NAS';
    if (!NAME.test(name)) throw fehler('DLNA-Name: Buchstaben, Ziffern, Leerzeichen . _ -', 'dlna.name');
    // Ordner statt ganzer Freigaben (Betreiber 12.10.2026: Unterordner per Auswahl); alte Form „freigaben“ wird übernommen
    const roh = Array.isArray(e.dlna.ordner) ? e.dlna.ordner : Array.isArray(e.dlna.freigaben) ? e.dlna.freigaben.map((f) => ({ freigabe: f, pfad: '' })) : dlnaOrdner(c.dlna);
    const ordner = []; const gesehen = new Set();
    roh.forEach((x, i) => {
      const freigabe = String(x && x.freigabe || '');
      if (!alle.has(freigabe)) throw fehler(`DLNA: Freigabe „${freigabe}“ gibt es nicht`, `dlna.ordner.${i}`);
      const pfad = relPfad(x.pfad, `dlna.ordner.${i}.pfad`);
      const k = `${freigabe}/${pfad}`;
      if (!gesehen.has(k)) { gesehen.add(k); ordner.push({ freigabe, pfad }); }
    });
    if (ordner.length > MAX_DLNA_ORDNER) throw fehler(`DLNA: höchstens ${MAX_DLNA_ORDNER} Medienordner`, 'dlna.ordner');
    if (e.dlna.aktiv && !ordner.length) throw fehler('DLNA: bitte mindestens einen Ordner mit Medien wählen', 'dlna.ordner');
    c.dlna = { aktiv: !!e.dlna.aktiv, name, ordner };
  }
  return c;
}

/**
 * Welche Freigaben sieht welcher Nutzer (SFTP/WebDAV)? Admins sehen alle (wie auf der Platte: fahnas-admin hat rwx),
 * sonst nach lesen/schreiben (Nutzer oder @Gruppe). Gesperrte Nutzer bekommen keine Ansicht.
 * @returns {Map<string, Array<{freigabe, quelle, nur_lesen}>>}
 */
export function ansichtenPlan(users, shares) {
  const plan = new Map();
  const gruppenVon = new Map();
  for (const g of (users && users.gruppen) || []) for (const m of g.mitglieder || []) gruppenVon.set(m, [...(gruppenVon.get(m) || []), g.name]);
  for (const n of (users && users.nutzer) || []) {
    if (n.gesperrt) continue;
    const meine = new Set([n.name, ...(n.gruppen || []).map((g) => `@${g}`), ...(gruppenVon.get(n.name) || []).map((g) => `@${g}`)]);
    const liste = [];
    for (const f of (shares && shares.freigaben) || []) {
      if (!f || !f.name || !f.pfad) continue;
      const schreiben = n.rolle === 'admin' || (f.schreiben || []).some((k) => meine.has(k));
      const lesen = schreiben || (f.lesen || []).some((k) => meine.has(k));
      if (!lesen) continue;
      if (f.extern && !schreiben) continue; // Nur-lesen ist auf exFAT/NTFS nicht erzwingbar
      liste.push({ freigabe: f.name, quelle: f.pfad, nur_lesen: !schreiben });
    }
    plan.set(n.name, liste.sort((a, b) => a.freigabe.localeCompare(b.freigabe)));
  }
  return plan;
}

/**
 * Ansichts-Einhängungen (SFTP/WebDAV/DLNA), die dasselbe Dateisystem zeigen wie der Einhängepunkt `quelle` (mountinfo
 * Feld 3 „major:minor“). Sie halten ein Laufwerk/einen Verbund fest, auch wenn `quelle` selbst ausgehängt ist – vor dem
 * Auswerfen/Stoppen lösen. Tiefste zuerst.
 */
export function ansichtenDesDateisystems(text, quelle, wurzeln = [ANSICHT_WURZEL, DLNA_WURZEL]) {
  const zeilen = String(text || '').split('\n').map((z) => z.split(' ')).filter((t) => t.length >= 6).map((t) => ({ dev: t[2], ziel: t[4].replace(/\\040/g, ' ') }));
  const q = zeilen.filter((z) => z.ziel === quelle).pop();
  if (!q) return [];
  return zeilen.filter((z) => z.dev === q.dev && wurzeln.some((w) => z.ziel.startsWith(`${w}/`))).map((z) => z.ziel).sort((a, b) => b.length - a.length);
}

/** /proc/self/mountinfo → Map Einhängepunkt → {ro} (nur unterhalb der Wurzeln). */
export function mountinfoParsen(text, wurzeln = [ANSICHT_WURZEL, DLNA_WURZEL]) {
  const aus = new Map();
  for (const z of String(text || '').split('\n')) {
    const t = z.split(' ');
    if (t.length < 6) continue;
    const ziel = t[4].replace(/\\040/g, ' ');
    if (!wurzeln.some((w) => ziel === w || ziel.startsWith(`${w}/`))) continue;
    aus.set(ziel, { ro: t[5].split(',').includes('ro') });
  }
  return aus;
}

/** mountinfo → Map ziel → {ro, typ, quelle} unter den Wurzeln (Pfade mit \\040 \\011 \\012 \\134 entschlüsselt). */
export function mountinfoTypen(text, wurzeln) {
  const ent = (x) => x.replace(/\\(040|011|012|134)/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const aus = new Map();
  for (const z of String(text || '').split('\n')) {
    const t = z.split(' ');
    const trenner = t.indexOf('-');
    if (t.length < 6 || trenner < 0) continue;
    const ziel = ent(t[4]);
    if (!wurzeln.some((w) => ziel === w || ziel.startsWith(`${w}/`))) continue;
    aus.set(ziel, { ro: t[5].split(',').includes('ro'), typ: t[trenner + 1] || '', quelle: ent(t[trenner + 2] || '') });
  }
  return aus;
}

/**
 * Ordnerrechte in den Ansichten (SFTP/WebDAV, Betreiber 19.10.2026): WebDAV (rclone) läuft als root und sähe sonst
 * gesperrte Ordner. Je Nutzer und eingeschränktem Bereich eine Über-Einhängung: „kein Zugriff“ → leeres tmpfs
 * („gesperrt“), „nur lesen“ → derselbe Ordner noch einmal nur lesend („lesen“). Unter einem gesperrten Bereich nichts
 * weiter, „lesen“ nur, wenn die Ansicht nicht ohnehin nur lesend ist. → [{wurzel, rel, art}] (rel relativ zur Ansichtswurzel).
 */
export function ueberAnsichten(users, shares, plan) {
  const nachName = new Map(((shares && shares.freigaben) || []).map((f) => [f.name, f]));
  const aus = [];
  for (const [nutzer, liste] of plan) {
    for (const x of liste) {
      const f = nachName.get(x.freigabe);
      if (!f || f.extern) continue;
      const bereiche = bereicheFuer(f, users, nutzer).sort((a, b) => a.pfad.split('/').length - b.pfad.split('/').length || (a.pfad < b.pfad ? -1 : 1));
      const gesperrt = []; const lesend = [];
      for (const b of bereiche) {
        if (gesperrt.some((g) => unter(b.pfad, g))) continue;
        if (b.stufe === 'keiner') { gesperrt.push(b.pfad); aus.push({ rel: `${nutzer}/${x.freigabe}/${b.pfad}`, art: 'gesperrt' }); continue; }
        if (x.nur_lesen || lesend.some((l) => unter(b.pfad, l))) continue;
        lesend.push(b.pfad); aus.push({ rel: `${nutzer}/${x.freigabe}/${b.pfad}`, art: 'lesen' });
      }
    }
  }
  return aus;
}

/** Bereiche einer Freigabe, die für irgendwen „kein Zugriff“ sind – DLNA kennt keine Anmeldung und blendet sie ganz aus. */
export function dlnaGesperrt(f) {
  return regelnNormieren(f && !f.extern ? f.ordnerrechte : []).filter((r) => Object.values(r.regeln).includes('keiner')).map((r) => r.pfad);
}

/** Stabile fsid je Pfad (NFS braucht sie für btrfs-Teilvolumes). */
export function fsid(pfad) {
  let h = 2166136261;
  for (const c of Buffer.from(String(pfad))) { h ^= c; h = Math.imul(h, 16777619) >>> 0; }
  return (h % 2_000_000_000) + 1000;
}

export function exportsText(c, freigaben, uids, gid) {
  const z = ['# Erzeugt von FAH-NAS (System → Protokolle) – nicht von Hand ändern.'];
  const pfade = new Map(freigaben.map((f) => [f.name, f.pfad]));
  for (const f of c.nfs.freigaben) {
    const pfad = pfade.get(f.name); const uid = uids[f.als_nutzer];
    if (!pfad || uid === undefined) continue;
    z.push(`"${pfad}" ${c.nfs.netz}(${f.nur_lesen ? 'ro' : 'rw'},sync,no_subtree_check,all_squash,anonuid=${uid},anongid=${gid},fsid=${fsid(pfad)})`);
  }
  return z.join('\n') + '\n';
}

export const NFS_CONF = '# Erzeugt von FAH-NAS: nur NFSv4 (ein Port, 2049/tcp – kein rpcbind/mountd nach außen)\n[nfsd]\nvers3=n\nvers4=y\nvers4.0=y\nvers4.1=y\nvers4.2=y\n';

export function sshdText() {
  return ['# Erzeugt von FAH-NAS (System → Protokolle → SFTP) – nicht von Hand ändern.',
    `Match Group ${SFTP_GRUPPE}`,
    `    ChrootDirectory ${ANSICHT_WURZEL}/%u`,
    '    ForceCommand internal-sftp -d /',
    '    AllowTcpForwarding no',
    '    AllowAgentForwarding no',
    '    X11Forwarding no',
    '    PermitTTY no',
    '    PasswordAuthentication yes',
    'Match all', ''].join('\n');
}

/** systemd-Units für WebDAV und DLNA (rclone). */
export function webdavUnit(c, { node = '/usr/bin/node', authSkript, cert, key }) {
  return ['# Erzeugt von FAH-NAS (System → Protokolle → WebDAV) – nicht von Hand ändern.', '[Unit]', 'Description=FAH-NAS WebDAV (rclone)', 'After=network-online.target', 'Wants=network-online.target', '',
    '[Service]',
    `ExecStart=/usr/bin/rclone serve webdav --addr :${c.webdav.port} --cert ${cert} --key ${key} "--auth-proxy=${node} ${authSkript}" --dir-cache-time 5s --poll-interval 0 --log-level NOTICE`,
    'Restart=on-failure', 'RestartSec=5', '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n');
}

export function dlnaUnit(c) {
  const name = c.dlna.name.replace(/["\\]/g, '');
  return ['# Erzeugt von FAH-NAS (System → Protokolle → DLNA) – nicht von Hand ändern.', '[Unit]', 'Description=FAH-NAS DLNA-Medienserver (rclone)', 'After=network-online.target', 'Wants=network-online.target', '',
    '[Service]',
    `ExecStart=/usr/bin/rclone serve dlna ${DLNA_WURZEL} --addr :8200 "--name=${name}" --read-only --dir-cache-time 2m --log-level NOTICE`,
    'Restart=on-failure', 'RestartSec=5', '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n');
}

/** Firewall-Ports der eingeschalteten Protokolle. */
export function firewallPorts(c) {
  const p = [];
  if (!c) return p;
  if (c.nfs && c.nfs.aktiv) p.push({ proto: 'tcp', port: 2049, kommentar: 'NFSv4' });
  if (c.webdav && c.webdav.aktiv) p.push({ proto: 'tcp', port: Number(c.webdav.port) || 5006, kommentar: 'WebDAV (HTTPS)' });
  if (c.dlna && c.dlna.aktiv) p.push({ proto: 'tcp', port: 8200, kommentar: 'DLNA Medienserver' }, { proto: 'udp', port: 1900, kommentar: 'DLNA/SSDP Geraetesuche' });
  return p;
}
