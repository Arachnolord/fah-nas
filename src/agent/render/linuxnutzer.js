// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rendert Nutzer und Gruppen aus users.json ins System: Linux-Konten (useradd/usermod/userdel, Gruppen) und
// Samba-Passwörter (smbpasswd). Alle Aufrufe laufen über system.ausfuehren mit Argumentliste; Passwörter gehen
// ausschließlich über stdin. Jede Funktion bekommt das `system`-Werkzeug, damit Tests es ersetzen können.

import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const GRUPPE_NUTZER = 'fahnas-nutzer';
export const GRUPPE_ADMIN = 'fahnas-admin';
export const NOLOGIN = '/usr/sbin/nologin';
export const ERSTE_NUTZER_UID = 1000; // darunter: Systemkonten, die wir nie anfassen

// --- Gruppen ---------------------------------------------------------------

/** Existiert die Linux-Gruppe? (getent group, Exit 2 = nicht vorhanden) */
export async function gruppeExistiert(system, name) {
  const r = await system.ausfuehren('getent', ['group', name], { erlaubteCodes: [0, 2] });
  return r.code === 0 && r.stdout.trim() !== '';
}

/** Legt die Gruppe an, wenn sie fehlt. `systemgruppe` = groupadd -r (fahnas-*). Gibt true zurück, wenn angelegt. */
export async function gruppeSicherstellen(system, name, systemgruppe = false) {
  if (await gruppeExistiert(system, name)) return false;
  await system.ausfuehren('groupadd', systemgruppe ? ['-r', name] : [name]);
  return true;
}

/** Löscht die Gruppe, wenn sie existiert. */
export async function gruppeLoeschen(system, name) {
  if (!(await gruppeExistiert(system, name))) return false;
  await system.ausfuehren('groupdel', [name]);
  return true;
}

// --- Konten ----------------------------------------------------------------

/** Linux-Konto lesen: {uid, gid, heim, shell} oder null. */
export async function linuxNutzer(system, name) {
  const r = await system.ausfuehren('getent', ['passwd', name], { erlaubteCodes: [0, 2] });
  const zeile = r.stdout.trim().split('\n')[0];
  if (r.code !== 0 || !zeile) return null;
  const t = zeile.split(':');
  return { name: t[0], uid: Number(t[2]), gid: Number(t[3]), heim: t[5] || '', shell: t[6] || '' };
}

/**
 * Legt ein Konto ohne Heimverzeichnis und ohne Anmeldeshell an. Mit `uid` wird die alte Kennung wiederverwendet
 * (Wiederaufbau nach Neuinstallation); ist sie vergeben (Exit 4), fällt useradd auf eine freie zurück.
 * @returns {Promise<{uidUebernommen:boolean}>}
 */
export async function nutzerAnlegen(system, { name, uid, gruppen = [GRUPPE_NUTZER] }) {
  const basis = ['-M', '-s', NOLOGIN, '-G', gruppen.join(',')];
  if (uid) {
    try {
      await system.ausfuehren('useradd', [...basis, '-u', String(uid), name]);
      return { uidUebernommen: true };
    } catch (e) {
      if (!(e instanceof FahnasFehler) || e.details?.code !== 4) throw e;
    }
  }
  await system.ausfuehren('useradd', [...basis, name]);
  return { uidUebernommen: false };
}

/** Anmeldeshell für Admins: sshd startet den Root-Wrapper (adminroot.js) über die Shell des Kontos – mit nologin liefe er nie. */
export const ADMIN_SHELL = '/bin/bash';

/**
 * Admins (aktiv) bekommen eine Anmeldeshell, normale und gesperrte Konten verlieren die von uns gesetzte wieder
 * (Betreiber 11.11.2026: „ist ein user admin = sieht er alles, normaler user = keine root ansicht“). Eine andere echte
 * Shell eines Admins (z. B. zsh) bleibt stehen. @returns {Promise<boolean>} geändert
 */
export async function shellAngleichen(system, name, admin) {
  const k = await linuxNutzer(system, name);
  if (!k) return false;
  const ohne = !k.shell || /(nologin|\/false)$/.test(k.shell);
  if (admin && ohne) { await system.ausfuehren('usermod', ['-s', ADMIN_SHELL, name]); return true; }
  if (!admin && k.shell === ADMIN_SHELL) { await system.ausfuehren('usermod', ['-s', NOLOGIN, name]); return true; }
  return false;
}

/** Ergänzende Gruppen eines Kontos (id -nG). */
export async function nutzerGruppen(system, name) {
  const r = await system.ausfuehren('id', ['-nG', name]);
  return r.stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * Bringt die Gruppenmitgliedschaft auf den Sollstand. Entfernt werden nur Gruppen aus `verwaltet`
 * (fahnas-admin und die selbst angelegten), fremde Gruppen (sudo, docker …) bleiben unberührt.
 * @returns {Promise<{ergaenzt:string[], entfernt:string[]}>}
 */
export async function gruppenAngleichen(system, name, soll, verwaltet) {
  const ist = new Set(await nutzerGruppen(system, name));
  const ergaenzt = [...new Set(soll)].filter((g) => !ist.has(g));
  const entfernt = [...ist].filter((g) => verwaltet.has(g) && !soll.includes(g));
  if (ergaenzt.length) await system.ausfuehren('usermod', ['-aG', ergaenzt.join(','), name]);
  for (const g of entfernt) await system.ausfuehren('gpasswd', ['-d', name, g]);
  return { ergaenzt, entfernt };
}

/** Setzt Linux- und Samba-Passwort – beides über stdin, nie als Argument. */
export async function passwortSetzen(system, name, passwort) {
  if (typeof passwort !== 'string' || /[\r\n\u0000]/.test(passwort)) throw new FahnasFehler('E_PARAMS', 'Passwort enthält unerlaubte Zeichen', { feld: 'passwort' });
  await system.ausfuehren('chpasswd', [], { eingabe: `${name}:${passwort}\n` });
  await system.ausfuehren('smbpasswd', ['-a', '-s', name], { eingabe: `${passwort}\n${passwort}\n` });
}

/** Sperrt Linux (usermod -L) und Samba (smbpasswd -d). */
export async function sperren(system, name) {
  await system.ausfuehren('usermod', ['-L', name]);
  await system.ausfuehren('smbpasswd', ['-d', name]);
}

/** Entsperrt; usermod -U liefert 3, wenn das Konto gar kein Passwort hätte – dann bleibt nur Samba. */
export async function entsperren(system, name) {
  await system.ausfuehren('usermod', ['-U', name], { erlaubteCodes: [0, 3] });
  await system.ausfuehren('smbpasswd', ['-e', name]);
}

/** Entfernt Samba-Eintrag (fehlt er, ist das kein Fehler) und Linux-Konto. */
export async function nutzerLoeschen(system, name) {
  await system.ausfuehren('smbpasswd', ['-x', name], { erlaubteCodes: [0, 1] });
  if (await linuxNutzer(system, name)) {
    // offene Sitzungen (SFTP, SMB) beenden – sonst verweigert userdel („currently used by process“)
    try { await system.ausfuehren('pkill', ['-KILL', '-u', name], { erlaubteCodes: [0, 1] }); } catch { /* keine Prozesse */ }
    await system.ausfuehren('userdel', [name]);
  }
}

/** Samba-Eintrag als NT-Hash + Sperre ({nt, gesperrt}) oder null – pdbedit -L -w (smbpasswd-Form). */
export async function sambaHash(system, name) {
  let r;
  try { r = await system.ausfuehren('pdbedit', ['-L', '-w', '-u', name], { erlaubteCodes: [0, 1, 255] }); } catch { return null; }
  const t = String(r.stdout || '').split('\n').find((z) => z.startsWith(`${name}:`));
  const teile = t ? t.split(':') : [];
  if (!/^[0-9A-F]{32}$/i.test(teile[3] || '')) return null;
  return { nt: teile[3].toUpperCase(), gesperrt: /^\[[^\]]*D/.test(teile[4] || '') };
}

/** Samba-Eintrag mit vorhandenem NT-Hash anlegen (ohne das Passwort zu kennen); Sperre wie vorher. */
export async function sambaHashSetzen(system, name, { nt, gesperrt }) {
  const zufall = crypto.randomBytes(24).toString('base64url'); // gilt nur bis zur nächsten Zeile
  await system.ausfuehren('pdbedit', ['-a', '-u', name, '-t'], { eingabe: `${zufall}\n${zufall}\n` });
  await system.ausfuehren('pdbedit', ['-u', name, '--set-nt-hash', nt]);
  if (gesperrt) await system.ausfuehren('smbpasswd', ['-d', name]);
}

/**
 * Benennt ein Konto um (Betreiber 20.10.2026: „usernamen nicht nachträglich ändern“): uid, Dateien, ACLs und Gruppen
 * bleiben, die eigene Gruppe gleichen Namens zieht mit, ein echtes /home/<alt> ebenso. Samba führt seine Konten nach Namen –
 * der NT-Hash wird übernommen, das Passwort bleibt also gültig. Den alten Samba-Eintrag löschen geht nur, solange das
 * Linux-Konto noch so heißt; schlägt usermod fehl, kommt er zurück. Offene SMB-/SFTP-Sitzungen enden (sonst verweigert usermod).
 */
export async function nutzerUmbenennen(system, alt, neu) {
  const konto = await linuxNutzer(system, alt);
  if (!konto) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Linux-Konto „${alt}“ gibt es nicht`, { feld: 'name' });
  if (await linuxNutzer(system, neu)) throw new FahnasFehler('E_EXISTIERT', `Ein Linux-Konto „${neu}“ gibt es schon`, { feld: 'neu' });
  const g = await system.ausfuehren('getent', ['group', alt], { erlaubteCodes: [0, 2] });
  const eigeneGruppe = g.code === 0 && Number(String(g.stdout).split(':')[2]) === konto.gid;
  if (eigeneGruppe && await gruppeExistiert(system, neu)) throw new FahnasFehler('E_EXISTIERT', `Eine Linux-Gruppe „${neu}“ gibt es schon`, { feld: 'neu' });
  const samba = await sambaHash(system, alt);
  try { await system.ausfuehren('pkill', ['-KILL', '-u', alt], { erlaubteCodes: [0, 1] }); } catch { /* keine Prozesse */ }
  if (samba) await system.ausfuehren('smbpasswd', ['-x', alt], { erlaubteCodes: [0, 1] });
  try {
    const heim = konto.heim === `/home/${alt}` ? ['-d', `/home/${neu}`, ...(typeof system.existiert === 'function' && await system.existiert(konto.heim) ? ['-m'] : [])] : [];
    await system.ausfuehren('usermod', ['-l', neu, ...heim, alt]);
  } catch (e) {
    if (samba) { try { await sambaHashSetzen(system, alt, samba); } catch (f) { process.stderr.write(`[nutzer] Samba-Eintrag ${alt} zurück: ${f.message}\n`); } }
    throw e;
  }
  if (eigeneGruppe) await system.ausfuehren('groupmod', ['-n', neu, alt]);
  if (samba) await sambaHashSetzen(system, neu, samba);
  return { samba: !!samba, gruppe: eigeneGruppe };
}

/**
 * Löscht alle Dateien eines Nutzers unterhalb `wurzel` (find … -delete). Nicht leere fremde Ordner bleiben.
 * Ohne Zeitlimit: auf großen Freigaben dauert das Minuten – ein Abbruch nach 120 s ließe eine halb gelöschte
 * Freigabe und einen weiter bestehenden Nutzer zurück.
 */
export async function dateienLoeschen(system, wurzel, { name, uid }) {
  const wer = Number.isInteger(uid) && uid >= ERSTE_NUTZER_UID ? ['-uid', String(uid)] : ['-user', name];
  await system.ausfuehren('find', [wurzel, '-xdev', ...wer, '-delete'], { erlaubteCodes: [0, 1], zeitlimit_ms: 0 });
}

/** Alle Samba-Konten mit Kontomarken (pdbedit -L -v): Map name → {flags}. 'D' in flags = gesperrt. */
export async function sambaKonten(system) {
  const r = await system.ausfuehren('pdbedit', ['-L', '-v'], { erlaubteCodes: [0, 1] });
  const konten = new Map();
  let aktuell = null;
  for (const zeile of r.stdout.split('\n')) {
    let m = /^Unix username:\s*(\S+)/.exec(zeile);
    if (m) { aktuell = m[1]; konten.set(aktuell, { flags: '' }); continue; }
    m = /^Account Flags:\s*\[([^\]]*)\]/.exec(zeile);
    if (m && aktuell) konten.get(aktuell).flags = m[1].replace(/\s/g, '');
  }
  return konten;
}
