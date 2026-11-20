// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Wer greift gerade auf den NAS zu? (Kachel „Verbindungen“, wie Unraid „Users“/SMB-Status): SMB aus `smbstatus --json`
// (Nutzer, Rechner, Freigaben, offene Dateien), SSH/SFTP, WebDAV und NFS aus der Socket-Tabelle `ss -Htnp state
// established` – nur der Netz-Namensraum des Hosts, Container zählen nicht mit. Reine Auswertung ohne Systemzugriff.

/** Adresse ohne Port: „192.168.1.5:51234“ → 192.168.1.5, „[::ffff:192.168.1.5]:1“ → 192.168.1.5, „[fe80::1]:22“ → fe80::1. */
export function adresseOhnePort(a) {
  const s = String(a || '').trim();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  const roh = m ? m[1] : s.replace(/:\d+$/, '');
  return roh.replace(/^::ffff:/i, '').replace(/%[^%]*$/, '');
}
function portVon(a) { const m = /:(\d+)$/.exec(String(a || '')); return m ? Number(m[1]) : null; }

/**
 * `ss -Htnp state established` → [{lokal_port, gegenstelle, prozesse:[{name, pid}]}]. Ohne Root fehlt die Prozessspalte.
 */
export function ssParsen(text) {
  const aus = [];
  for (const z of String(text || '').split('\n')) {
    const t = z.trim().split(/\s+/);
    if (t.length < 4 || !/^\d+$/.test(t[0])) continue;
    const prozesse = [...z.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: Number(m[2]) }));
    aus.push({ lokal_port: portVon(t[2]), gegenstelle: adresseOhnePort(t[3]), prozesse });
  }
  return aus;
}

/** Nutzer aus dem Prozesstitel von sshd: „sshd-session: fabian [priv]“, „sshd: benutzer@notty“ → fabian. */
export function sshNutzer(titel) {
  const m = /^sshd(?:-session)?:\s+([^\s@[]+)(?:@|\s+\[|$)/.exec(String(titel || '').trim());
  return m && m[1] !== '/usr/sbin/sshd' ? m[1] : null;
}

/**
 * Verbindungen aus der Socket-Tabelle zuordnen. `titel(pid)` liefert den Prozesstitel (für den SSH-Nutzer).
 * @returns {{ssh:Array<{nutzer, adresse}>, webdav:Array<{adresse, anzahl}>, nfs:Array<{adresse, anzahl}>}}
 */
export function verbindungenZuordnen(ss, { webdavPort = null, titel = () => null } = {}) {
  const ssh = []; const zaehlen = (map, a) => map.set(a, (map.get(a) || 0) + 1);
  const dav = new Map(); const nfs = new Map();
  for (const v of ss) {
    const sshd = v.prozesse.find((p) => /^sshd/.test(p.name));
    if (sshd) { ssh.push({ nutzer: sshNutzer(titel(sshd.pid)), adresse: v.gegenstelle }); continue; }
    if (webdavPort && v.lokal_port === webdavPort) zaehlen(dav, v.gegenstelle);
    else if (v.lokal_port === 2049) zaehlen(nfs, v.gegenstelle);
  }
  const liste = (m) => [...m].map(([adresse, anzahl]) => ({ adresse, anzahl })).sort((a, b) => b.anzahl - a.anzahl);
  return { ssh, webdav: liste(dav), nfs: liste(nfs) };
}

/**
 * `smbstatus --json` → {sitzungen:[{nutzer, rechner, adresse, protokoll, freigaben:[…]}], dateien:[{nutzer, freigabe, datei}]}
 * (tolerant: fehlende Teile bleiben leer; dateien höchstens 50, neueste zuerst).
 */
export function smbStatusParsen(json) {
  const j = json && typeof json === 'object' ? json : {};
  const werte = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
  const sitzungen = new Map(); const uidName = new Map();
  for (const s of werte(j.sessions)) {
    const id = String(s.session_id ?? '');
    const nutzer = String(s.username || '').replace(/^.*\\/, '') || null;
    if (s.uid !== undefined && nutzer) uidName.set(String(s.uid), nutzer);
    sitzungen.set(id, { nutzer, rechner: s.remote_machine || null, adresse: adresseOhnePort(String(s.hostname || s.remote_machine || '').replace(/^ipv[46]:/i, '')), protokoll: s.session_dialect || null, freigaben: [] });
  }
  for (const t of werte(j.tcons)) {
    const s = sitzungen.get(String(t.session_id ?? ''));
    if (s && t.service && t.service !== 'IPC$' && !s.freigaben.includes(t.service)) s.freigaben.push(t.service);
  }
  const dateien = [];
  for (const f of werte(j.open_files)) {
    const freigabe = String(f.service_path || '').split('/').filter(Boolean).pop() || '';
    for (const o of werte(f.opens)) {
      dateien.push({ nutzer: uidName.get(String(o.uid)) || null, freigabe, datei: String(f.filename || ''), seit: o.opened_at || null });
    }
  }
  dateien.sort((a, b) => String(b.seit || '').localeCompare(String(a.seit || '')));
  return { sitzungen: [...sitzungen.values()], dateien: dateien.slice(0, 50) };
}
