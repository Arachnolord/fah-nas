// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Samba-Renderer: erzeugt aus shares.json je Freigabe /etc/samba/fahnas/<name>.conf und alle.conf (include-
// Zeilen), prüft mit testparm, tauscht erst dann die Dateien (Schreiben in .neu → prüfen → rename) und lädt
// smbd neu. Liefert außerdem die globale smb.conf-Vorlage für den Erststart und die Avahi-Dienstdatei
// (Time Machine / SMB-Ankündigung). Alle Werte werden geprüft – kein Zeilenumbruch, keine Anführungszeichen –
// damit niemand über eine Beschreibung Zeilen in die smb.conf schmuggeln kann.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PFADE } from '../../gemeinsam/pfade.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { MUSTER_NUTZER_ODER_GRUPPE } from '../../gemeinsam/schema.js';
import { GRUPPE_NUTZER, GRUPPE_ADMIN } from './linuxnutzer.js';

export const GASTKONTO = 'nobody';
/** System-Freigabe des App-Ordners (Schalter system.json docker_freigabe) – Name ist für eigene Freigaben gesperrt. */
export const DOCKER_FREIGABE = 'docker';
export const ALLE_DATEI = 'alle.conf';
export const AVAHI_DATEI = 'fahnas-timemachine.service';
export const AVAHI_STANDARD = '/etc/avahi/services';
const PRUEF_DATEI = '.pruef.smb.conf';

// Werte in der smb.conf: keine Steuerzeichen, kein Zeilenumbruch, keine Anführungszeichen.
// eslint-disable-next-line no-control-regex
export const MUSTER_WERT = /^[^\r\n"\u0000-\u001f\u007f]*$/;
const MUSTER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MUSTER_KONTO = MUSTER_NUTZER_ODER_GRUPPE;

/** Prüft einen Wert für eine smb.conf-Zeile; wirft E_PARAMS bei Schmuggelware. */
export function pruefeWert(wert, feld) {
  if (typeof wert !== 'string' || !MUSTER_WERT.test(wert)) {
    throw new FahnasFehler('E_PARAMS', `„${feld}“ enthält unerlaubte Zeichen (Zeilenumbruch oder Anführungszeichen)`, { feld });
  }
  return wert;
}

function pruefeName(name) {
  if (typeof name !== 'string' || !MUSTER_NAME.test(name)) throw new FahnasFehler('E_PARAMS', 'Freigabename ungültig', { feld: 'name' });
  return name;
}

function pruefeKonten(liste, feld) {
  if (!Array.isArray(liste)) return [];
  for (const k of liste) if (typeof k !== 'string' || !MUSTER_KONTO.test(k)) throw new FahnasFehler('E_PARAMS', `„${feld}“ enthält einen ungültigen Namen`, { feld });
  return liste;
}

/** Pfade aus den Werkzeugen (Tests geben eigene mit). */
export function pfadeVon(werkzeuge) {
  const p = (werkzeuge && werkzeuge.pfade) || PFADE;
  return {
    samba: p.samba || PFADE.samba,
    shares: p.shares || PFADE.shares,
    konfig: p.konfig || PFADE.konfig,
    apps: p.apps || PFADE.apps,
    avahi: p.avahi || process.env.FAHNAS_AVAHI || AVAHI_STANDARD,
  };
}

/** Text der globalen smb.conf – der Erststart (Teil G) schreibt genau diesen Text nach /etc/samba/smb.conf. */
export function globaleVorlage({ sambaOrdner = PFADE.samba, konfigOrdner = PFADE.konfig, mitInclude = true } = {}) {
  const z = [
    '# FAH-NAS – globale Samba-Konfiguration. Erzeugt aus src/agent/render/samba.js; nicht von Hand ändern.',
    '# Freigaben liegen als einzelne Dateien unter ' + sambaOrdner + ' und werden vom Agenten gerendert.',
    '[global]',
    '    workgroup = WORKGROUP',
    '    server string = FAH-NAS',
    '    server role = standalone server',
    '    security = user',
    '    map to guest = Bad User',
    `    guest account = ${GASTKONTO}`,
    '    server min protocol = SMB2',
    // Samba-Passwortdatenbank und lokale SID auf der Datenpartition: überlebt eine Neuinstallation
    `    private dir = ${path.join(konfigOrdner, 'samba')}`,
    '    passdb backend = tdbsam',
    '    ea support = yes',
    '    vfs objects = fruit streams_xattr',
    '    fruit:metadata = stream',
    '    fruit:model = MacSamba',
    '    fruit:posix_rename = yes',
    '    fruit:veto_appledouble = no',
    '    fruit:nfs_aces = no',
    '    fruit:wipe_intentionally_left_blank_rfork = yes',
    '    fruit:delete_empty_adfiles = yes',
    '    log level = 1',
    '    logging = systemd',
  ];
  if (mitInclude) z.push(`    include = ${path.join(sambaOrdner, ALLE_DATEI)}`);
  return z.join('\n') + '\n';
}

/** Hat die Freigabe einen Papierkorb? Externe Laufwerke immer, er gilt für alle Ordner darauf. Time Machine nie. */
export function hatPapierkorb(f) { return !f.timemachine && (!!f.extern || !!f.papierkorb); }

/**
 * Text der Include-Datei einer Freigabe.
 * @param {object} f  Eintrag aus shares.json
 * @param {{sharesPfad?:string, verfuegbar?:boolean}} [o]  `verfuegbar:false` = externes Laufwerk gerade nicht eingehängt
 *        → `available = no` (die Rechte bleiben stehen, damit die Freigabe beim Wiederanstecken sofort wieder greift).
 */
export function freigabeText(f, { sharesPfad = PFADE.shares, verfuegbar = true, ohneXattr = false } = {}) {
  pruefeName(f.name);
  const lesen = pruefeKonten(f.lesen || [], 'lesen');
  const schreiben = pruefeKonten(f.schreiben || [], 'schreiben');
  const z = [`[${f.name}]`];
  const zeile = (schluessel, wert) => { z.push(`    ${schluessel} = ${pruefeWert(String(wert), schluessel)}`); };

  zeile('path', path.join(sharesPfad, f.name));
  if (f.beschreibung) zeile('comment', pruefeWert(f.beschreibung, 'beschreibung'));
  zeile('browseable', f.versteckt ? 'no' : 'yes');
  zeile('read only', 'no');

  const gueltig = [...new Set([...lesen, ...schreiben])];
  if (f.gaeste) gueltig.push(GASTKONTO);
  if (gueltig.length === 0) {
    // leere „valid users“ hieße bei Samba: jeder darf – deshalb Freigabe abschalten, bis jemand Rechte bekommt
    zeile('available', 'no');
  } else {
    // externes Laufwerk nicht eingehängt → abschalten (Rechte/valid users bleiben für das Wiederanstecken erhalten)
    if (verfuegbar === false) zeile('available', 'no');
    zeile('valid users', gueltig.join(', '));
  }
  const nurLesen = lesen.filter((k) => !schreiben.includes(k));
  if (nurLesen.length) zeile('read list', nurLesen.join(', '));
  if (schreiben.length) zeile('write list', schreiben.join(', '));
  zeile('guest ok', f.gaeste ? 'yes' : 'no');
  zeile('force group', GRUPPE_NUTZER);
  zeile('create mask', '0660');
  zeile('directory mask', '2770');
  zeile('inherit permissions', 'yes');

  // vfs objects je Freigabe überschreibt die globale Liste – fruit/streams_xattr deshalb wiederholen. Ausnahme: externe
  // Laufwerke ohne erweiterte Attribute (exFAT/FAT): dort scheitert jeder Stream (SMB-Probe 26.09.: Finder-Metadaten →
  // „object name not found“). Ohne Stream-Angebot legt der Mac seine Metadaten als ._-Dateien ab – wie am Stick direkt.
  const vfs = ohneXattr ? [] : ['fruit', 'streams_xattr'];
  const korb = hatPapierkorb(f);
  if (korb) vfs.push('recycle');
  zeile('vfs objects', vfs.join(' '));
  if (ohneXattr) {
    zeile('ea support', 'no'); zeile('store dos attributes', 'no');
    // DOS-Attribute (Archiv, versteckt, System, schreibgeschützt) nicht auf Unix-Rechte abbilden: exFAT/FAT-Dateien gehören
    // root (Einhänge-Option), ein chmod des Nutzers scheitert → Löschen per SMB meldete ACCESS_DENIED (Probe 26.09.)
    for (const m of ['map archive', 'map hidden', 'map system', 'map readonly']) zeile(m, 'no');
  }
  if (korb) {
    zeile('recycle:repository', '.papierkorb/samba');
    zeile('recycle:keeptree', 'yes');
    zeile('recycle:versions', 'yes');
    zeile('recycle:touch', 'yes');
    zeile('recycle:exclude_dir', '/.papierkorb');
  }
  if (f.timemachine) {
    zeile('fruit:time machine', 'yes');
    if (Number.isInteger(f.groesse_gb) && f.groesse_gb > 0) zeile('fruit:time machine max size', `${f.groesse_gb}G`);
    zeile('durable handles', 'yes');
    zeile('kernel oplocks', 'no');
    zeile('posix locking', 'no');
  }
  return z.join('\n') + '\n';
}

/**
 * System-Freigabe „docker“: der App-Ordner (je App Compose-Datei, .env, Daten) zum Anpassen von Hand – nur Admins.
 * Die Dateien gehören root bzw. den Container-Nutzern, deshalb Zugriff als root; neue Dateien erben Besitzer und Rechte
 * des Ordners (Daten-Ordner einer App gehören oft dem Container-Nutzer). /var/lib/docker bleibt bewusst außen vor.
 */
export function dockerFreigabeText({ appsPfad = PFADE.apps } = {}) {
  return [
    `[${DOCKER_FREIGABE}]`,
    `    path = ${pruefeWert(appsPfad, 'path')}`,
    '    comment = Docker-Apps von FAH-NAS (Compose, .env, Daten) - nur Admins',
    '    browseable = yes',
    '    read only = no',
    `    valid users = @${GRUPPE_ADMIN}`,
    '    guest ok = no',
    '    force user = root',
    '    force group = root',
    '    inherit owner = yes',
    '    inherit permissions = yes',
    '    vfs objects = fruit streams_xattr',
  ].join('\n') + '\n';
}

/**
 * Persönliche Ordner (12.10.2026): [homes] → \\NAS\<nutzer> zeigt <daten>/homes/<nutzer>; nur der Nutzer selbst.
 * Erscheint nur, wenn mindestens ein Nutzer einen persönlichen Ordner hat.
 */
export function homesText({ heimWurzel }) {
  return [
    '[homes]',
    '    comment = Persoenlicher Ordner',
    `    path = ${pruefeWert(heimWurzel, 'path')}/%S`,
    '    browseable = no',
    '    read only = no',
    '    valid users = %S',
    '    guest ok = no',
    '    create mask = 0600',
    '    directory mask = 0700',
    '    vfs objects = fruit streams_xattr',
  ].join('\n') + '\n';
}

/** Text von alle.conf: eine include-Zeile je Freigabe. */
export function alleText(freigaben, { sambaOrdner = PFADE.samba } = {}) {
  const z = ['# FAH-NAS – Liste der Freigaben. Wird vom Agenten erzeugt; nicht von Hand ändern.'];
  for (const f of freigaben) z.push(`include = ${path.join(sambaOrdner, `${pruefeName(f.name)}.conf`)}`);
  return z.join('\n') + '\n';
}

/** Avahi-Dienstdatei: SMB-Ankündigung, Mac-Symbol und – je Time-Machine-Freigabe – ein adisk-Eintrag. */
export function avahiText(freigaben) {
  const tm = freigaben.filter((f) => f.timemachine).map((f) => pruefeName(f.name));
  const z = [
    '<?xml version="1.0" standalone=\'no\'?>',
    '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">',
    '<!-- FAH-NAS: wird vom Agenten erzeugt; nicht von Hand ändern -->',
    '<service-group>',
    '  <name replace-wildcards="yes">%h</name>',
    '  <service>',
    '    <type>_smb._tcp</type>',
    '    <port>445</port>',
    '  </service>',
    '  <service>',
    '    <type>_device-info._tcp</type>',
    '    <port>0</port>',
    '    <txt-record>model=MacSamba</txt-record>',
    '  </service>',
  ];
  if (tm.length) {
    z.push('  <service>', '    <type>_adisk._tcp</type>', '    <port>9</port>', '    <txt-record>sys=waMa=0,adVF=0x100</txt-record>');
    tm.forEach((name, i) => z.push(`    <txt-record>dk${i}=adVN=${name},adVF=0x82</txt-record>`));
    z.push('  </service>');
  }
  z.push('</service-group>');
  return z.join('\n') + '\n';
}

async function lesenOderNull(p) { try { return await fs.readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

/** Ist unter `pfad` gerade ein Dateisystem eingehängt? (findmnt; für externe Freigaben, siehe §12.) */
export async function eingehaengt(system, pfad) {
  return (await einhaengung(system, pfad)).eingehaengt;
}

/** Dateisysteme ohne erweiterte Attribute (Samba darf dort keine Streams über xattr anbieten). */
export const OHNE_XATTR = new Set(['exfat', 'vfat', 'msdos', 'fat']);

/** Einhängung unter `pfad`: {eingehaengt, fs} (fs = findmnt-FSTYPE, z. B. exfat, ntfs3, fuseblk, ext4). */
export async function einhaengung(system, pfad) {
  try {
    const r = await system.ausfuehren('findmnt', ['-n', '-o', 'TARGET,FSTYPE', '--', pfad], { erlaubteCodes: [0, 1] });
    const zeile = String(r.stdout).trim().split('\n')[0] || '';
    if (r.code !== 0 || !zeile) return { eingehaengt: false, fs: null };
    const teile = zeile.split(/\s+/);
    return { eingehaengt: true, fs: teile.length > 1 ? teile[teile.length - 1] : null };
  } catch { return { eingehaengt: false, fs: null }; }
}

async function atomarSchreiben(p, text, modus = 0o644) {
  const tmp = `${p}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w', modus);
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, p);
}

/**
 * Rendert alle Freigaben nach Samba und Avahi.
 * Ablauf: Solltexte bauen → mit Bestand vergleichen → .neu-Dateien schreiben → Prüfdatei (globale Vorlage +
 * alle Abschnitte) mit testparm prüfen → bei Fehler .neu verwerfen und E_RENDER (alte Dateien bleiben) →
 * sonst rename, verwaiste <name>.conf entfernen, smbcontrol all reload-config.
 * @returns {Promise<{geaendert:boolean, dateien:string[], avahi_geaendert:boolean}>}
 */
export async function rendern(werkzeuge, freigaben) {
  const { system } = werkzeuge;
  let sys = null;
  try { sys = werkzeuge.konfig ? await werkzeuge.konfig.laden('system.json', null) : null; } catch { sys = null; }
  const dockerAn = !!(sys && sys.docker_freigabe);
  const pf = pfadeVon(werkzeuge);
  await fs.mkdir(pf.samba, { recursive: true, mode: 0o755 });
  // „private dir“ der globalen Vorlage (passdb.tdb, secrets.tdb) – nur root, muss vor smbd existieren
  await fs.mkdir(path.join(pf.konfig, 'samba'), { recursive: true, mode: 0o700 });

  const soll = new Map();
  for (const f of freigaben) {
    // externe Laufwerke: available=no, solange nichts unter dem Einhängepunkt hängt (Renderer prüft findmnt, §12)
    // RAID-Verbund und übernommene Ordner (anderes NAS) wie externes Laufwerk: aus, solange nicht eingehängt
    const e = f.extern || f.verbund || f.verschluesselt || f.importiert ? await einhaengung(system, path.join(pf.shares, f.name)) : { eingehaengt: true, fs: null };
    soll.set(`${pruefeName(f.name)}.conf`, freigabeText(f, { sharesPfad: pf.shares, verfuegbar: e.eingehaengt, ohneXattr: OHNE_XATTR.has(e.fs) }));
  }
  // System-Freigabe „docker“ (App-Ordner) – eigene Freigaben dürfen so nicht heißen (freigaben.anlegen)
  const abschnitte = freigaben.filter((f) => f.name !== DOCKER_FREIGABE);
  if (dockerAn) { soll.set(`${DOCKER_FREIGABE}.conf`, dockerFreigabeText({ appsPfad: pf.apps })); abschnitte.push({ name: DOCKER_FREIGABE }); }
  let users = null;
  try { users = werkzeuge.konfig ? await werkzeuge.konfig.laden('users.json', null) : null; } catch { users = null; }
  if (((users && users.nutzer) || []).some((n) => n && n.heim && n.heim.aktiv)) {
    const wp = (werkzeuge && werkzeuge.pfade) || {};
    soll.set('homes.conf', homesText({ heimWurzel: path.join(wp.daten || path.dirname(pf.shares), 'homes') }));
    abschnitte.push({ name: 'homes' });
  }
  soll.set(ALLE_DATEI, alleText(abschnitte, { sambaOrdner: pf.samba }));

  // Bestand vergleichen
  const vorhanden = (await fs.readdir(pf.samba)).filter((d) => d.endsWith('.conf') && !d.startsWith('.'));
  const verwaist = vorhanden.filter((d) => !soll.has(d));
  let geaendert = verwaist.length > 0;
  if (!geaendert) {
    for (const [datei, text] of soll) {
      if ((await lesenOderNull(path.join(pf.samba, datei))) !== text) { geaendert = true; break; }
    }
  }

  if (geaendert) {
    const neuDateien = [];
    const pruefPfad = path.join(pf.samba, PRUEF_DATEI);
    try {
      for (const [datei, text] of soll) {
        const p = path.join(pf.samba, `${datei}.neu`);
        await atomarSchreiben(p, text);
        neuDateien.push(p);
      }
      // Prüfdatei: globale Vorlage ohne include + alle Abschnitte wörtlich
      const pruefText = globaleVorlage({ sambaOrdner: pf.samba, konfigOrdner: pf.konfig, mitInclude: false })
        + '\n' + abschnitte.map((f) => soll.get(`${f.name}.conf`)).join('\n');
      await atomarSchreiben(pruefPfad, pruefText);
      const r = await system.ausfuehren('testparm', ['-s', '--suppress-prompt', pruefPfad], { erlaubteCodes: [0, 1] });
      if (r.code !== 0) {
        throw new FahnasFehler('E_RENDER', 'Samba lehnt die neue Konfiguration ab – die alte bleibt in Kraft', { ausgabe: String(r.stderr || r.stdout).slice(0, 4000) });
      }
    } catch (e) {
      for (const p of neuDateien) { try { await fs.unlink(p); } catch { /* egal */ } }
      try { await fs.unlink(pruefPfad); } catch { /* egal */ }
      throw e instanceof FahnasFehler ? e : FahnasFehler.aus(e);
    }
    for (const p of neuDateien) await fs.rename(p, p.slice(0, -'.neu'.length));
    for (const d of verwaist) { try { await fs.unlink(path.join(pf.samba, d)); } catch { /* egal */ } }
    try { await fs.unlink(pruefPfad); } catch { /* egal */ }
    // smbd läuft vielleicht gerade nicht (Dienst aus) – dann ist der Reload kein Fehler
    await system.ausfuehren('smbcontrol', ['all', 'reload-config'], { erlaubteCodes: [0, 1, 255] });
  }

  // Avahi (liest sein Verzeichnis selbst neu ein, kein Reload nötig)
  let avahiGeaendert = false;
  const avahiPfad = path.join(pf.avahi, AVAHI_DATEI);
  let protokolle = null;
  try { protokolle = werkzeuge.konfig ? await werkzeuge.konfig.laden('protokolle.json', null) : null; } catch { protokolle = null; }
  const smbAn = !(protokolle && protokolle.smb && protokolle.smb.aktiv === false);
  const avahi = smbAn ? avahiText(freigaben) : null; // SMB aus → keine Bonjour-Ankündigung für SMB/Time Machine
  if (avahi === null) { if ((await lesenOderNull(avahiPfad)) !== null) { await fs.rm(avahiPfad, { force: true }); avahiGeaendert = true; } }
  else if ((await lesenOderNull(avahiPfad)) !== avahi) {
    await fs.mkdir(pf.avahi, { recursive: true, mode: 0o755 });
    await atomarSchreiben(avahiPfad, avahi);
    avahiGeaendert = true;
  }

  return { geaendert, dateien: [...soll.keys()], avahi_geaendert: avahiGeaendert };
}
