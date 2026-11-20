// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Testhilfe für Teil A: ein Scheinsystem, das Linux-Konten, Gruppen, Samba-Passwörter, btrfs-Quoten und ACLs im
// Speicher führt, alle Befehle mit Argumentlisten aufzeichnet und für system._test.setzeBefehl geeignet ist.
// Dazu Werkzeuge (Konfig in os.tmpdir(), Register, intern) zum Registrieren der Aktionsmodule.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FahnasFehler } from '../../src/gemeinsam/fehler.js';
import { Konfig } from '../../src/gemeinsam/konfig.js';
import { Register } from '../../src/agent/register.js';
import * as system from '../../src/gemeinsam/system.js';

export async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-a-')); }

/** Erzeugt das Scheinsystem. Zustand ist über `st` einsehbar und veränderbar. */
export function scheinsystem() {
  const st = {
    passwd: new Map(),      // name → {uid, gid, gruppen:Set, gesperrt}
    gruppen: new Map(),     // name → gid
    samba: new Map(),       // name → {aktiv, passwort}
    passwoerter: new Map(), // name → Linux-Passwort (aus chpasswd)
    quota: false,
    qgroups: new Map(),     // pfad → {rfer, max}
    acl: new Map(),         // pfad → {besitzer, gruppe, flags, eintraege}
    befehle: [],
    testparmFehler: null,   // Text → testparm schlägt fehl
    testparmInhalte: [],    // Inhalt der Prüfdatei bei jedem testparm-Aufruf
    naechsteUid: 1001,
    naechsteGid: 1001,
    fehlschlag: null,       // (programm, args) => {code, stderr} | null – erzwingt Fehler
  };

  function vorhanden(gid) { return [...st.gruppen.values()].includes(gid); }
  /** Stellvertreter für den NT-Hash (MD4 fehlt in neueren OpenSSL-Builds) – nur gleich/ungleich zählt. */
  const ntVon = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex').slice(0, 32).toUpperCase();

  async function roh(programm, args, opt) {
    const a = args;
    if (st.fehlschlag) { const f = st.fehlschlag(programm, args); if (f) return { code: f.code ?? 1, stdout: '', stderr: f.stderr || 'erzwungener Fehler' }; }
    switch (programm) {
      case 'getent': {
        if (a[0] === 'passwd') {
          const k = st.passwd.get(a[1]);
          return k ? { code: 0, stdout: `${a[1]}:x:${k.uid}:${k.gid}::/home/${a[1]}:${k.shell || '/usr/sbin/nologin'}\n`, stderr: '' } : { code: 2, stdout: '', stderr: '' };
        }
        if (a[0] === 'group') {
          const gid = st.gruppen.get(a[1]);
          if (gid === undefined) return { code: 2, stdout: '', stderr: '' };
          const mitglieder = [...st.passwd.entries()].filter(([, k]) => k.gruppen.has(a[1])).map(([n]) => n).join(',');
          return { code: 0, stdout: `${a[1]}:x:${gid}:${mitglieder}\n`, stderr: '' };
        }
        return { code: 2, stdout: '', stderr: '' };
      }
      case 'groupadd': {
        const name = a[a.length - 1];
        if (st.gruppen.has(name)) return { code: 9, stdout: '', stderr: `groupadd: group '${name}' already exists` };
        st.gruppen.set(name, st.naechsteGid++);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'groupdel': {
        if (!st.gruppen.has(a[0])) return { code: 6, stdout: '', stderr: 'groupdel: group does not exist' };
        st.gruppen.delete(a[0]);
        for (const k of st.passwd.values()) k.gruppen.delete(a[0]);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'useradd': {
        const name = a[a.length - 1];
        if (st.passwd.has(name)) return { code: 9, stdout: '', stderr: `useradd: user '${name}' already exists` };
        const iG = a.indexOf('-G'); const iU = a.indexOf('-u');
        const gruppen = new Set(iG >= 0 ? a[iG + 1].split(',') : []);
        for (const g of gruppen) if (!st.gruppen.has(g)) return { code: 6, stdout: '', stderr: `useradd: group '${g}' does not exist` };
        let uid = st.naechsteUid;
        if (iU >= 0) {
          uid = Number(a[iU + 1]);
          if ([...st.passwd.values()].some((k) => k.uid === uid)) return { code: 4, stdout: '', stderr: `useradd: UID ${uid} is not unique` };
        }
        while ([...st.passwd.values()].some((k) => k.uid === st.naechsteUid) || st.naechsteUid === uid) st.naechsteUid++;
        let gid = uid; while (vorhanden(gid)) gid++;
        st.gruppen.set(name, gid); // private Gruppe wie auf Ubuntu
        const iS = a.indexOf('-s');
        st.passwd.set(name, { uid, gid, gruppen, gesperrt: false, shell: iS >= 0 ? a[iS + 1] : '/usr/sbin/nologin' });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'usermod': {
        const name = a[a.length - 1];
        const k = st.passwd.get(name);
        if (!k) return { code: 6, stdout: '', stderr: 'usermod: user does not exist' };
        if (a[0] === '-l') {
          if (st.passwd.has(a[1])) return { code: 9, stdout: '', stderr: `usermod: user '${a[1]}' already exists` };
          st.passwd.delete(name); st.passwd.set(a[1], k);
          if (st.passwoerter.has(name)) { st.passwoerter.set(a[1], st.passwoerter.get(name)); st.passwoerter.delete(name); }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (a[0] === '-aG') { for (const g of a[1].split(',')) { if (!st.gruppen.has(g)) return { code: 6, stdout: '', stderr: `usermod: group '${g}' does not exist` }; k.gruppen.add(g); } }
        else if (a[0] === '-s') k.shell = a[1];
        else if (a[0] === '-L') k.gesperrt = true;
        else if (a[0] === '-U') { if (!st.passwoerter.has(name)) return { code: 3, stdout: '', stderr: 'usermod: unlocking the user\'s password would result in a passwordless account.' }; k.gesperrt = false; }
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'groupmod': {
        if (a[0] !== '-n' || !st.gruppen.has(a[2])) return { code: 6, stdout: '', stderr: 'groupmod: group does not exist' };
        if (st.gruppen.has(a[1])) return { code: 9, stdout: '', stderr: `groupmod: group '${a[1]}' already exists` };
        st.gruppen.set(a[1], st.gruppen.get(a[2])); st.gruppen.delete(a[2]);
        for (const k of st.passwd.values()) if (k.gruppen.delete(a[2])) k.gruppen.add(a[1]);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'gpasswd': {
        if (a[0] !== '-d') return { code: 1, stdout: '', stderr: '' };
        const k = st.passwd.get(a[1]);
        if (!k) return { code: 3, stdout: '', stderr: 'gpasswd: user does not exist' };
        k.gruppen.delete(a[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'id': {
        const k = st.passwd.get(a[1]);
        if (!k) return { code: 1, stdout: '', stderr: `id: '${a[1]}': no such user` };
        return { code: 0, stdout: `${a[1]} ${[...k.gruppen].join(' ')}\n`, stderr: '' };
      }
      case 'userdel': {
        if (!st.passwd.delete(a[a.length - 1])) return { code: 6, stdout: '', stderr: 'userdel: user does not exist' };
        st.gruppen.delete(a[a.length - 1]);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'chpasswd': {
        const zeile = String(opt.eingabe || '').split('\n')[0];
        const i = zeile.indexOf(':');
        if (i < 0) return { code: 1, stdout: '', stderr: 'chpasswd: line 1: missing new password' };
        const name = zeile.slice(0, i);
        if (!st.passwd.has(name)) return { code: 1, stdout: '', stderr: `chpasswd: (user ${name}) pam_chauthtok() failed` };
        st.passwoerter.set(name, zeile.slice(i + 1));
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'smbpasswd': {
        const name = a[a.length - 1];
        if (a.includes('-a')) {
          const [p1, p2] = String(opt.eingabe || '').split('\n');
          if (!p1 || p1 !== p2) return { code: 1, stdout: '', stderr: 'Mismatch - password unchanged.' };
          if (!st.passwd.has(name)) return { code: 1, stdout: '', stderr: `Failed to add entry for user ${name}.` };
          st.samba.set(name, { aktiv: true, passwort: p1, nt: ntVon(p1) });
          return { code: 0, stdout: '', stderr: '' };
        }
        const s = st.samba.get(name);
        if (!s) return { code: 1, stdout: '', stderr: `Failed to find entry for user ${name}.` };
        if (a[0] === '-d') s.aktiv = false; else if (a[0] === '-e') s.aktiv = true; else if (a[0] === '-x') st.samba.delete(name);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'pdbedit': {
        const iU = a.indexOf('-u'); const wer = iU >= 0 ? a[iU + 1] : null;
        if (a.includes('-w') && wer) {
          const s = st.samba.get(wer); const k = st.passwd.get(wer);
          if (!s) return { code: 255, stdout: '', stderr: 'Username not found!' };
          return { code: 0, stdout: `${wer}:${k ? k.uid : 4294967295}:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:${s.nt}:[${s.aktiv ? 'U' : 'DU'}          ]:LCT-6AD70DD9:\n`, stderr: '' };
        }
        if (a.includes('-a') && wer) {
          if (!st.passwd.has(wer)) return { code: 1, stdout: '', stderr: `Failed to find a Unix account for ${wer}` };
          const [p1, p2] = String(opt.eingabe || '').split('\n');
          if (!p1 || p1 !== p2) return { code: 1, stdout: '', stderr: 'Passwords do not match' };
          st.samba.set(wer, { aktiv: true, passwort: p1, nt: ntVon(p1) });
          return { code: 0, stdout: '', stderr: '' };
        }
        const iH = a.indexOf('--set-nt-hash');
        if (iH >= 0 && wer) { const s = st.samba.get(wer); if (!s) return { code: 1, stdout: '', stderr: 'Username not found!' }; s.nt = a[iH + 1]; s.passwort = null; return { code: 0, stdout: '', stderr: '' }; }
        let aus = '';
        for (const [name, s] of st.samba) {
          aus += `---------------\nUnix username:        ${name}\nNT username:          \nAccount Flags:        [${s.aktiv ? 'U' : 'DU'}          ]\n`;
        }
        return { code: 0, stdout: aus, stderr: '' };
      }
      case 'btrfs': {
        if (a[0] === 'subvolume' && a[1] === 'create') { await fs.mkdir(a[2]); return { code: 0, stdout: `Create subvolume '${a[2]}'\n`, stderr: '' }; }
        if (a[0] === 'subvolume' && a[1] === 'delete') { await fs.rm(a[2], { recursive: true, force: true }); return { code: 0, stdout: `Delete subvolume: '${a[2]}'\n`, stderr: '' }; }
        if (a[0] === 'quota' && a[1] === 'enable') { st.quota = true; return { code: 0, stdout: '', stderr: '' }; }
        if (a[0] === 'qgroup' && a[1] === 'show') {
          if (!st.quota) return { code: 1, stdout: '', stderr: "ERROR: can't list qgroups: quotas not enabled" };
          const pfad = a[a.length - 1];
          const q = st.qgroups.get(pfad) || { rfer: 16384, max: 'none' };
          return { code: 0, stdout: `Qgroupid    Referenced    Exclusive   Max referenced   Path\n--------    ----------    ---------   --------------   ----\n0/258       ${q.rfer}         16384       ${q.max}            shares/${path.basename(pfad)}\n`, stderr: '' };
        }
        if (a[0] === 'qgroup' && a[1] === 'limit') {
          if (!st.quota) return { code: 1, stdout: '', stderr: 'ERROR: quotas not enabled' };
          const pfad = a[a.length - 1];
          const q = st.qgroups.get(pfad) || { rfer: 16384, max: 'none' };
          st.qgroups.set(pfad, { ...q, max: a[2] === 'none' ? 'none' : Number(a[2]) });
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'btrfs: unbekannt' };
      }
      case 'chown': {
        const [b, g] = a[0].split(':'); const e = st.acl.get(a[1]) || { besitzer: 'root', gruppe: 'root', flags: '---', eintraege: ['user::rwx', 'group::r-x', 'other::r-x'] };
        st.acl.set(a[1], { ...e, besitzer: b, gruppe: g || e.gruppe });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'chmod': {
        const e = st.acl.get(a[1]) || { besitzer: 'root', gruppe: 'root', flags: '---', eintraege: ['user::rwx', 'group::r-x', 'other::r-x'] };
        const m = a[0]; const setgid = m.length === 4 && (Number(m[0]) & 2) !== 0;
        st.acl.set(a[1], { ...e, flags: setgid ? '-s-' : '---' });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'setfacl': {
        const e = st.acl.get(a[1]) || { besitzer: 'root', gruppe: 'root', flags: '---', eintraege: [] };
        const zeilen = String(opt.eingabe || '').split('\n').map((z) => z.trim()).filter(Boolean);
        for (const z of zeilen) {
          const m = /^(default:)?(user|group):([^:]*):/.exec(z);
          if (m && m[3] && m[3] !== 'nobody') {
            if (m[2] === 'user' && !st.passwd.has(m[3])) return { code: 1, stdout: '', stderr: `setfacl: Option -M: Invalid argument near character ... user ${m[3]}` };
            if (m[2] === 'group' && !st.gruppen.has(m[3])) return { code: 1, stdout: '', stderr: `setfacl: Option -M: Invalid argument ... group ${m[3]}` };
          }
        }
        st.acl.set(a[1], { ...e, eintraege: zeilen });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'getfacl': {
        const pfad = a[a.length - 1];
        const e = st.acl.get(pfad);
        if (!e) return { code: 0, stdout: `# file: ${pfad}\n# owner: root\n# group: root\nuser::rwx\ngroup::r-x\nother::r-x\n\n`, stderr: '' };
        let aus = `# file: ${pfad}\n# owner: ${e.besitzer}\n# group: ${e.gruppe}\n`;
        if (e.flags !== '---') aus += `# flags: ${e.flags}\n`;
        aus += e.eintraege.join('\n') + '\n\n';
        return { code: 0, stdout: aus, stderr: '' };
      }
      case 'testparm': {
        const datei = a[a.length - 1];
        st.testparmInhalte.push(await fs.readFile(datei, 'utf8'));
        if (st.testparmFehler) return { code: 1, stdout: '', stderr: st.testparmFehler };
        return { code: 0, stdout: 'Loaded services file OK.\n', stderr: '' };
      }
      case 'smbcontrol': return { code: 0, stdout: '', stderr: '' };
      case 'du': return { code: 0, stdout: `4096\t${a[a.length - 1]}\n`, stderr: '' };
      case 'nice': {
        // nice -n 19 ionice -c 3 du … → den eigentlichen Befehl nachspielen
        const i = a.indexOf('du');
        if (i >= 0) return roh('du', a.slice(i + 1), opt);
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'mv': await fs.rename(a[0], a[1]); return { code: 0, stdout: '', stderr: '' };
      case 'find': return { code: 0, stdout: '', stderr: '' };
      default: return { code: 0, stdout: '', stderr: '' };
    }
  }

  st.ausfuehren = async (programm, argumente = [], optionen = {}) => {
    st.befehle.push({ programm, args: [...argumente], eingabe: optionen.eingabe });
    const r = await roh(programm, argumente, optionen);
    const erlaubt = optionen.erlaubteCodes || [0];
    if (!erlaubt.includes(r.code)) {
      throw new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, { befehl: [programm, ...argumente].join(' '), code: r.code, ausgabe: r.stderr || r.stdout });
    }
    return r;
  };

  /** Kurzform: Befehle als "programm arg arg" */
  st.zeilen = () => st.befehle.map((b) => [b.programm, ...b.args].join(' '));
  st.leeren = () => { st.befehle.length = 0; st.testparmInhalte.length = 0; };
  return st;
}

/**
 * Baut Werkzeuge wie der Agent: Konfig im tmp-Ordner, eigene Pfade, Register, intern(). Das Scheinsystem wird
 * über system._test.setzeBefehl eingehängt – so laufen die Module gegen das echte system-Modul.
 */
export async function werkzeugeBauen({ scheins = scheinsystem(), module = [] } = {}) {
  const w = await tmp();
  const pfade = {
    konfig: path.join(w, 'config'), shares: path.join(w, 'data', 'shares'), snapshots: path.join(w, 'data', '.snapshots'),
    samba: path.join(w, 'etc', 'samba', 'fahnas'), backup: path.join(w, 'data', 'backup'), avahi: path.join(w, 'etc', 'avahi', 'services'),
    daten: path.join(w, 'data'), run: path.join(w, 'run'),
  };
  for (const p of Object.values(pfade)) await fs.mkdir(p, { recursive: true });
  const konfig = new Konfig(pfade.konfig);
  await konfig.sicherstellen();
  system._test.setzeBefehl(scheins.ausfuehren);
  const reg = new Register();
  const ereignisse = [];
  const werkzeuge = {
    konfig, system, pfade, audit: { eintrag() {} }, aufgaben: null,
    ereignis: (art, daten) => ereignisse.push({ ereignis: art, ...daten }),
    konfigGeaendert: (bereich) => ereignisse.push({ ereignis: 'konfig', bereich }),
    version: () => 'test',
  };
  werkzeuge.intern = (aktion, params) => rufen(aktion, params, { nutzer: 'system', rolle: 'system', ip: '-' });
  async function rufen(aktion, params, kontext) {
    const { aktion: a, params: p } = reg.vorbereiten(aktion, params ?? {}, kontext);
    return a.ausfuehren(p, kontext, werkzeuge);
  }
  for (const m of module) m.registriere(reg, werkzeuge);
  const ADMIN = { nutzer: 'chef', rolle: 'admin', ip: '10.0.0.1' };
  const SYSTEM = { nutzer: 'system', rolle: 'system', ip: '-' };
  return {
    w, pfade, konfig, reg, werkzeuge, scheins, ereignisse, rufen, ADMIN, SYSTEM,
    admin: (aktion, params) => rufen(aktion, params, ADMIN),
    system: (aktion, params) => rufen(aktion, params, SYSTEM),
    als: (nutzer, rolle = 'nutzer') => (aktion, params) => rufen(aktion, params, { nutzer, rolle, ip: '10.0.0.2' }),
    aufraeumen: async () => {
      // Hintergrundläufe der Belegung (nice … du) zu Ende laufen lassen, solange der Befehlsersatz noch hängt
      try { await (await import('../../src/agent/aktionen/freigaben.js'))._test.belegungWarten(); } catch { /* egal */ }
      system._test.setzeBefehl(null); await fs.rm(w, { recursive: true, force: true });
    },
  };
}
