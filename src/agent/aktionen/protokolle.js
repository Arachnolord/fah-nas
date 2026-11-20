// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „protokolle.*“ (Ausbau Oktober 2026): NFS (v4), SFTP, WebDAV und DLNA neben SMB. Wahrheit protokolle.json;
// protokolle.apply stellt Ansichten (Bind-Mounts je Nutzer), NFS-Exporte, sshd-Ergänzung und die rclone-Dienste her.
// Nach Änderungen an Nutzern, Freigaben oder Laufwerken werden die Ansichten automatisch nachgezogen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { paketeSicherstellen, paketeFehlend } from '../helfer/pakete.js';
import { rendereFirewall } from '../render/firewall.js';
import * as r from '../protokolle/regeln.js';
import { ordnerGriff, griffPfad } from '../freigaben/ordnerrechte-abgleich.js';
import { unter } from '../freigaben/ordnerrechte.js';

export const DATEI = 'protokolle.json';
const GRUPPE_NUTZER = 'fahnas-nutzer';
const p = {
  ansicht: () => process.env.FAHNAS_ANSICHT || r.ANSICHT_WURZEL,
  dlna: () => process.env.FAHNAS_DLNA || r.DLNA_WURZEL,
  exports: () => process.env.FAHNAS_EXPORTS || '/etc/exports.d/fahnas.exports',
  nfsConf: () => process.env.FAHNAS_NFS_CONF || '/etc/nfs.conf.d/fahnas.conf',
  sshd: () => process.env.FAHNAS_SSHD_SFTP || '/etc/ssh/sshd_config.d/fahnas-sftp.conf',
  units: () => process.env.FAHNAS_UNITS || '/etc/systemd/system',
  ueber: () => path.join(process.env.FAHNAS_RUN || PFADE.run, 'ueber-einhaengungen.json'),
};

const laden = async (w) => {
  const d = await w.konfig.laden(DATEI, null);
  return d && typeof d === 'object' ? { ...structuredClone(r.STANDARD), ...d } : structuredClone(r.STANDARD);
};

async function daten(w) {
  const users = (await w.konfig.laden('users.json', { nutzer: [], gruppen: [] })) || { nutzer: [], gruppen: [] };
  const shares = (await w.konfig.laden('shares.json', { freigaben: [] })) || { freigaben: [] };
  return { users, shares };
}

const datei = async (ziel, inhalt, modus = 0o644) => { await fs.mkdir(path.dirname(ziel), { recursive: true }); await fs.writeFile(ziel, inhalt, { mode: modus }); };
const weg = async (ziel) => { try { await fs.unlink(ziel); return true; } catch { return false; } };
const leise = async (w, prog, args, o) => { try { await w.system.ausfuehren(prog, args, o); return true; } catch { return false; } };

/**
 * Bind-Mounts unter `wurzel` an den Soll-Plan angleichen: [{ziel, quelle, nur_lesen}]. Überzählige werden ausgehängt
 * (lazy, damit eine laufende Übertragung nichts blockiert), fehlende eingehängt (rbind + rslave: späteres Ein-/Aushängen
 * externer Laufwerke wirkt durch), Nur-lesen per remount.
 */
async function mountsAngleichen(w, wurzel, soll, ordner = []) {
  let info = '';
  try { info = await fs.readFile('/proc/self/mountinfo', 'utf8'); } catch { /* kein Linux */ }
  const ist = r.mountinfoParsen(info, [wurzel]);
  const sollZiele = new Set(soll.map((s) => s.ziel));
  for (const ziel of [...ist.keys()].sort((a, b) => b.length - a.length)) {
    if (!sollZiele.has(ziel) && !soll.some((s) => ziel.startsWith(`${s.ziel}/`))) await leise(w, 'umount', ['-l', ziel]);
  }
  await fs.mkdir(wurzel, { recursive: true, mode: 0o755 });
  await fs.chmod(wurzel, 0o755).catch(() => {});
  // Ordner je Nutzer auch ohne Freigaben (SFTP-Chroot und WebDAV brauchen ihn)
  for (const o of ordner) { await fs.mkdir(o, { recursive: true, mode: 0o755 }); await fs.chmod(o, 0o755).catch(() => {}); }
  for (const s of soll) {
    try { await fs.access(s.quelle); } catch { continue; }
    await fs.mkdir(s.ziel, { recursive: true, mode: 0o755 });
    const da = ist.get(s.ziel);
    if (!da) {
      await w.system.ausfuehren('mount', ['--rbind', s.quelle, s.ziel]);
      await leise(w, 'mount', ['--make-rslave', s.ziel]);
      if (s.nur_lesen) await w.system.ausfuehren('mount', ['-o', 'remount,bind,ro', s.ziel]);
    } else if (da.ro !== !!s.nur_lesen) {
      await w.system.ausfuehren('mount', ['-o', `remount,bind,${s.nur_lesen ? 'ro' : 'rw'}`, s.ziel]);
    }
  }
  // leere Ordner ohne Einhängung aufräumen (gelöschte Nutzer/Freigaben)
  const behalten = new Set([...soll.flatMap((s) => [s.ziel, path.dirname(s.ziel)]), ...ordner]);
  let eintraege = [];
  try { eintraege = await fs.readdir(wurzel); } catch { return; }
  for (const e of eintraege) {
    const ordner = path.join(wurzel, e);
    if (behalten.has(ordner)) {
      for (const k of await fs.readdir(ordner).catch(() => [])) { const z = path.join(ordner, k); if (!behalten.has(z)) await fs.rmdir(z).catch(() => {}); }
      continue;
    }
    for (const k of await fs.readdir(ordner).catch(() => [])) await fs.rmdir(path.join(ordner, k)).catch(() => {});
    await fs.rmdir(ordner).catch(() => {});
  }
}

/**
 * Über-Einhängungen der Ordnerrechte unter `wurzel` angleichen: soll = [{rel, art:'gesperrt'|'lesen'}]. Ziele werden
 * Teil für Teil ohne Verknüpfungen geöffnet und per `mount --no-canonicalize /proc/<agent>/fd/<n>` belegt – tauscht ein
 * Nutzer einen Ordner gegen eine Verknüpfung, landet nichts außerhalb. Eigene Einhängungen merkt sich
 * /run/fahnas/ueber-einhaengungen.json (nur die werden wieder ausgehängt).
 */
async function ueberAngleichen(w, wurzel, schluessel, soll) {
  let info = '';
  try { info = await fs.readFile('/proc/self/mountinfo', 'utf8'); } catch { /* kein Linux */ }
  const ist = r.mountinfoTypen(info, [wurzel]);
  let stand = {};
  try { stand = JSON.parse(await fs.readFile(p.ueber(), 'utf8')) || {}; } catch { /* erster Lauf */ }
  const vorher = Array.isArray(stand[schluessel]) ? stand[schluessel] : [];
  if (!soll.length && !vorher.length) return; // keine Ordnerrechte in den Ansichten – nichts zu tun, nichts zu merken
  const sollZiele = new Map(soll.map((s) => [path.join(wurzel, s.rel), s]));
  for (const ziel of [...vorher].sort((a, b) => b.length - a.length)) if (!sollZiele.has(ziel) && ist.has(ziel)) await leise(w, 'umount', ['-l', ziel]);
  const fertig = [];
  for (const [ziel, s] of sollZiele) {
    const da = ist.get(ziel);
    const passt = da && (s.art === 'gesperrt' ? da.typ === 'tmpfs' && da.quelle === 'fahnas-gesperrt' : da.ro && da.typ !== 'tmpfs');
    if (passt) { fertig.push(ziel); continue; }
    if (da && vorher.includes(ziel)) await leise(w, 'umount', ['-l', ziel]);
    const fh = await ordnerGriff(wurzel, s.rel).catch(() => null);
    if (!fh) continue; // Ordner fehlt in der Ansicht (z. B. per SMB umbenannt) – nie anlegen
    try {
      if (s.art === 'gesperrt') {
        await w.system.ausfuehren('mount', ['--no-canonicalize', '-t', 'tmpfs', '-o', 'ro,mode=000,size=4k,nr_inodes=8', 'fahnas-gesperrt', griffPfad(fh)]);
      } else {
        await w.system.ausfuehren('mount', ['--no-canonicalize', '--bind', griffPfad(fh), griffPfad(fh)]);
        const oben = await ordnerGriff(wurzel, s.rel); // neuer Griff = die eben entstandene Einhängung
        try { await w.system.ausfuehren('mount', ['--no-canonicalize', '-o', 'remount,bind,ro', griffPfad(oben)]); } finally { await oben?.close().catch(() => {}); }
      }
      fertig.push(ziel);
    } finally { await fh.close().catch(() => {}); }
  }
  stand[schluessel] = fertig;
  await datei(p.ueber(), JSON.stringify(stand), 0o600);
}

/** Vor dem Aushängen eines Laufwerks/Verbunds: Ansichten lösen, die sein Dateisystem festhalten (der nächste Abgleich baut sie neu). */
export async function ansichtenLoesen(w, quelle) {
  let info = '';
  try { info = await fs.readFile(process.env.FAHNAS_MOUNTINFO || '/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const ziele = r.ansichtenDesDateisystems(info, quelle, [p.ansicht(), p.dlna()]);
  for (const z of ziele) { if (!(await leise(w, 'umount', [z]))) await leise(w, 'umount', ['-l', z]); }
  return ziele;
}

async function uidsVon(w, namen) {
  const aus = {};
  for (const n of namen) { try { aus[n] = Number(String((await w.system.ausfuehren('id', ['-u', n])).stdout).trim()); } catch { /* fehlt */ } }
  return aus;
}
async function gidVon(w, gruppe) { try { return Number(String((await w.system.ausfuehren('getent', ['group', gruppe])).stdout).split(':')[2]); } catch { return null; } }

/** Alles aus protokolle.json herstellen. Gibt {ansichten, fehler} zurück. */
export async function anwenden(w, c, { fortschritt = () => {} } = {}) {
  const { users, shares } = await daten(w);
  const fehler = [];
  const schritt = async (name, fn) => { try { await fn(); } catch (e) { const f = FahnasFehler.aus(e); fehler.push({ schritt: name, meldung: f.message, ausgabe: f.details?.ausgabe }); } };
  // Ansichten je Nutzer (SFTP/WebDAV)
  const plan = r.ansichtenPlan(users, shares);
  const braucheAnsicht = c.sftp.aktiv || c.webdav.aktiv;
  fortschritt('Ansichten je Nutzer');
  await schritt('ansichten', () => mountsAngleichen(w, p.ansicht(), braucheAnsicht ? [...plan.entries()].flatMap(([n, l]) => l.map((x) => ({ ziel: path.join(p.ansicht(), n, x.freigabe), quelle: x.quelle, nur_lesen: x.nur_lesen }))) : [],
    braucheAnsicht ? [...plan.keys()].map((n) => path.join(p.ansicht(), n)) : []));
  // Ordnerrechte in den Ansichten (WebDAV läuft als root): gesperrte Ordner leer, Nur-lesen-Ordner schreibgeschützt
  await schritt('ordnerrechte', () => ueberAngleichen(w, p.ansicht(), 'ansicht', braucheAnsicht ? r.ueberAnsichten(users, shares, plan) : []));
  // DLNA-Ansicht (nur lesen): gewählte Ordner, nie über eine Verknüpfung aus der Freigabe hinaus
  await schritt('dlna_ansicht', async () => {
    const soll = []; const ueberDlna = [];
    if (c.dlna.aktiv) {
      for (const z of r.dlnaZiele(r.dlnaOrdner(c.dlna), shares.freigaben || [])) {
        try {
          const [echt, wurzel] = await Promise.all([fs.realpath(z.quelle), fs.realpath(z.wurzel)]);
          if (echt !== wurzel && !echt.startsWith(`${wurzel}/`)) continue;
        } catch { continue; } // Ordner fehlt (z. B. Laufwerk abgezogen) – beim nächsten Abgleich wieder dabei
        // Ordnerrechte: DLNA kennt keine Anmeldung – Ordner, die für irgendwen gesperrt sind, bleiben draußen
        const f = (shares.freigaben || []).find((x) => x.pfad === z.wurzel);
        const relOrdner = z.quelle === z.wurzel ? '' : z.quelle.slice(z.wurzel.replace(/\/+$/, '').length + 1);
        const gesperrt = f ? r.dlnaGesperrt(f) : [];
        if (gesperrt.some((g) => relOrdner && unter(relOrdner, g))) continue;
        soll.push({ ziel: path.join(p.dlna(), z.name), quelle: z.quelle, nur_lesen: true });
        for (const g of gesperrt) if (!relOrdner || unter(g, relOrdner)) ueberDlna.push({ rel: `${z.name}/${relOrdner ? g.slice(relOrdner.length + 1) : g}`, art: 'gesperrt' });
      }
    }
    await mountsAngleichen(w, p.dlna(), soll);
    await ueberAngleichen(w, p.dlna(), 'dlna', ueberDlna.filter((u, i, a) => !a.some((v, j) => j !== i && unter(u.rel, v.rel) && u.rel !== v.rel)));
  });
  // SMB (Samba) – an/aus; Firewall (445) und Bonjour-Ankündigung folgen protokolle.json (firewall.js / samba.js)
  fortschritt('SMB');
  await schritt('smb', async () => {
    const smbAn = !(c.smb && c.smb.aktiv === false);
    await w.system.ausfuehren('systemctl', [smbAn ? 'enable' : 'disable', '--now', 'smbd.service'], { zeitlimit_ms: 60_000 });
    try { await w.intern('freigaben.apply', {}); } catch { /* Bereich fehlt (Test) */ } // Bonjour-Ankündigung angleichen
  });
  // NFS
  fortschritt('NFS');
  await schritt('nfs', async () => {
    if (c.nfs.aktiv) {
      await datei(p.nfsConf(), r.NFS_CONF);
      await datei(p.exports(), r.exportsText(c, shares.freigaben || [], await uidsVon(w, [...new Set(c.nfs.freigaben.map((f) => f.als_nutzer))]), await gidVon(w, GRUPPE_NUTZER) ?? 100));
      await w.system.ausfuehren('systemctl', ['enable', 'nfs-server.service']);
      await w.system.ausfuehren('systemctl', ['restart', 'nfs-server.service'], { zeitlimit_ms: 60_000 });
      await w.system.ausfuehren('exportfs', ['-ra']);
    } else if (await weg(p.exports())) {
      await leise(w, 'exportfs', ['-ra']);
      await leise(w, 'systemctl', ['disable', '--now', 'nfs-server.service']);
    }
  });
  // SFTP
  fortschritt('SFTP');
  await schritt('sftp', async () => {
    await leise(w, 'groupadd', ['-f', '-r', r.SFTP_GRUPPE]);
    // Mitglieder: NAS-Konten ohne Anmeldeshell (Admin-Konten mit Shell behalten ihr normales SSH)
    for (const n of users.nutzer || []) {
      let shell = '';
      try { shell = String((await w.system.ausfuehren('getent', ['passwd', n.name])).stdout).trim().split(':')[6] || ''; } catch { continue; }
      // Admins nie: sie arbeiten per SSH/SFTP als root (render/adminroot.js), die Ansicht würde sie einsperren
      const soll = c.sftp.aktiv && !n.gesperrt && n.rolle !== 'admin' && /nologin|false$/.test(shell);
      await leise(w, 'gpasswd', [soll ? '-a' : '-d', n.name, r.SFTP_GRUPPE], { erlaubteCodes: [0, 3] });
    }
    const vorher = await fs.readFile(p.sshd(), 'utf8').catch(() => null);
    if (c.sftp.aktiv) {
      if (vorher !== r.sshdText()) {
        await datei(p.sshd(), r.sshdText());
        try { await w.system.ausfuehren('sshd', ['-t']); } catch (e) { if (vorher === null) await weg(p.sshd()); else await datei(p.sshd(), vorher); throw e; }
        await leise(w, 'systemctl', ['reload', 'ssh.service']);
      }
    } else if (vorher !== null) { await weg(p.sshd()); await leise(w, 'systemctl', ['reload', 'ssh.service']); }
  });
  // WebDAV + DLNA (rclone)
  fortschritt('WebDAV und DLNA');
  const unit = async (name, aktiv, inhalt) => {
    const ziel = path.join(p.units(), name);
    if (aktiv) {
      const alt = await fs.readFile(ziel, 'utf8').catch(() => null);
      if (alt !== inhalt) { await datei(ziel, inhalt); await w.system.ausfuehren('systemctl', ['daemon-reload']); }
      await w.system.ausfuehren('systemctl', ['enable', name]);
      await w.system.ausfuehren('systemctl', [alt !== inhalt ? 'restart' : 'start', name], { zeitlimit_ms: 60_000 });
    } else if (await fs.access(ziel).then(() => true, () => false)) {
      await leise(w, 'systemctl', ['disable', '--now', name]);
      await weg(ziel); await leise(w, 'systemctl', ['daemon-reload']);
    }
  };
  const tls = path.join(PFADE.web, 'tls');
  await schritt('webdav', () => unit('fahnas-webdav.service', c.webdav.aktiv, r.webdavUnit(c, { authSkript: path.join(PFADE.programm, 'src', 'agent', 'protokolle', 'webdav-auth.js'), cert: path.join(tls, 'cert.pem'), key: path.join(tls, 'key.pem') })));
  await schritt('dlna', () => unit('fahnas-dlna.service', c.dlna.aktiv, r.dlnaUnit(c)));
  // Firewall (liest protokolle.json selbst)
  await schritt('firewall', async () => { const sys = await w.konfig.laden('system.json', null); await rendereFirewall({ ssh: !(sys && sys.ssh === false) }, { system: w.system }); });
  return { ansichten: Object.fromEntries([...plan.entries()].map(([n, l]) => [n, braucheAnsicht ? l.map((x) => ({ freigabe: x.freigabe, nur_lesen: x.nur_lesen })) : []])), fehler };
}

function pakete(c) {
  const l = [];
  if (c.nfs.aktiv) l.push('nfs-kernel-server');
  if (c.webdav.aktiv || c.dlna.aktiv) l.push('rclone');
  return l;
}

export function registriere(reg, w) {
  reg.aktion('protokolle.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'NFS, SFTP, WebDAV und DLNA – Einstellungen und Zustand',
    ausfuehren: async () => {
      const c = await laden(w);
      const { users, shares } = await daten(w);
      const zustand = {};
      for (const [k, u] of [['smb', 'smbd.service'], ['nfs', 'nfs-server.service'], ['webdav', 'fahnas-webdav.service'], ['dlna', 'fahnas-dlna.service'], ['sftp', 'ssh.service']]) {
        try { zustand[k] = String((await w.system.ausfuehren('systemctl', ['is-active', u], { erlaubteCodes: [0, 3, 4] })).stdout).trim(); } catch { zustand[k] = 'unbekannt'; }
      }
      const sys = await w.konfig.laden('system.json', null);
      let lan = '';
      try { const rt = JSON.parse((await w.system.ausfuehren('ip', ['-j', '-4', 'route', 'show', 'table', 'main'])).stdout || '[]'); const std = rt.find((x) => x.dst === 'default'); lan = (rt.find((x) => std && x.dev === std.dev && x.scope === 'link' && String(x.dst).includes('/')) || {}).dst || ''; } catch { /* egal */ }
      return {
        ...c, zustand, ssh_an: !(sys && sys.ssh === false), lan_vorschlag: lan,
        freigaben: (shares.freigaben || []).map((f) => ({ name: f.name, extern: !!f.extern, pfad: f.pfad })), dlna: { ...c.dlna, ordner: r.dlnaOrdner(c.dlna) }, nutzer: (users.nutzer || []).map((n) => n.name),
        ansichten: Object.fromEntries([...r.ansichtenPlan(users, shares).entries()].map(([n, l]) => [n, l.map((x) => ({ freigabe: x.freigabe, nur_lesen: x.nur_lesen }))])),
      };
    },
  });

  reg.aktion('protokolle.speichern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'SMB, NFS, SFTP, WebDAV und DLNA einstellen',
    schema: { smb: { typ: 'object' }, nfs: { typ: 'object' }, sftp: { typ: 'object' }, webdav: { typ: 'object' }, dlna: { typ: 'object' } },
    ausfuehren: async (e, _k, _w, aufgabe) => {
      const alt = await laden(w);
      const { users, shares } = await daten(w);
      const c = r.normal(e, alt, { freigaben: shares.freigaben || [], nutzer: (users.nutzer || []).map((n) => n.name) });
      const fehlen = pakete(c);
      if (fehlen.length) await paketeSicherstellen(w.system, fehlen, { fortschritt: (t) => aufgabe?.fortschritt(0.2, t), zweck: 'die Protokolle' });
      if (c.sftp.aktiv) {
        const sys = await w.konfig.laden('system.json', null);
        if (sys && sys.ssh === false) { aufgabe?.fortschritt(0.4, 'SSH-Dienst einschalten (SFTP läuft darüber)'); await w.intern('system.dienst', { dienst: 'ssh', zustand: 'an' }); }
      }
      await w.konfig.speichern(DATEI, c);
      const erg = await anwenden(w, c, { fortschritt: (t) => aufgabe?.fortschritt(0.6, t) });
      w.konfigGeaendert?.('protokolle');
      if (erg.fehler.length) throw new FahnasFehler('E_SYSTEM', `Nicht alles ließ sich einrichten: ${erg.fehler.map((f) => `${f.schritt} – ${f.meldung}`).join('; ')}`, { fehler: erg.fehler });
      aufgabe?.fortschritt(1, 'Fertig');
      return { ...c, ansichten: erg.ansichten };
    },
  });

  reg.aktion('protokolle.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Protokolle aus protokolle.json herstellen (Start, Import, nach Änderungen)',
    ausfuehren: async () => {
      const c = await laden(w);
      if (!c.nfs.aktiv && !c.sftp.aktiv && !c.webdav.aktiv && !c.dlna.aktiv) return false;
      if ((await paketeFehlend(w.system, pakete(c))).length) return false;
      const erg = await anwenden(w, c);
      if (erg.fehler.length) throw new FahnasFehler('E_SYSTEM', erg.fehler.map((f) => `${f.schritt}: ${f.meldung}`).join('; '));
      return true;
    },
  });
}

/** Umbenannter Nutzer: NFS-Freigaben „als Nutzer“ folgen (Anwenden übernimmt das Ereignis „nutzer“ unten). */
export async function protokolleNutzerUmbenennen(w, alt, neu) {
  let n = 0;
  await w.konfig.aendern(DATEI, (d) => {
    for (const f of (d && d.nfs && Array.isArray(d.nfs.freigaben) ? d.nfs.freigaben : [])) if (f && f.als_nutzer === alt) { f.als_nutzer = neu; n++; }
    return n ? d : UNVERAENDERT;
  }, null);
  return n;
}

// Nutzer, Freigaben oder Laufwerke geändert → Ansichten/Exporte nachziehen (gebündelt nach 3 s)
let abmelden = null; let timer = null;
export async function starten(w) {
  abmelden = w.beobachten?.((e) => {
    const relevant = (e && e.ereignis === 'konfig' && ['nutzer', 'freigaben', 'laufwerke'].includes(e.bereich)) || (e && e.ereignis === 'system' && e.art === 'laufwerk');
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(() => { w.intern('protokolle.apply', {}).catch((f) => process.stderr.write(`[protokolle] ${f && f.message}\n`)); }, 3000);
    timer.unref?.();
  }) || null;
}
export function stoppen() { clearTimeout(timer); if (typeof abmelden === 'function') abmelden(); abmelden = null; }
