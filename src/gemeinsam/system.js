// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kapselung aller Systemaufrufe (Befehle, Nutzer-IDs), damit Tests sie ersetzen können und niemals eine Shell
// interpoliert wird. Alle Aufrufe: execFile mit Argumentliste.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { FahnasFehler } from './fehler.js';

/** Größte Ausgabe (stdout bzw. stderr) eines Befehls ohne eigene Angabe; darüber bricht execFile ab (E_SYSTEM). */
export const MAX_AUSGABE = 32 * 1024 * 1024;

/**
 * Führt einen Befehl aus. Wirft E_SYSTEM bei Exit ≠ 0 (außer `erlaubteCodes`) und bei mehr als `maxBuffer` Bytes
 * Ausgabe (Standard MAX_AUSGABE; größer z. B. für die Verbindungstabelle von conntrack).
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function befehl(programmRoh, argumenteRoh = [], optionenRoh = {}) {
  const { programm, argumente, optionen } = startArgumente(programmRoh, argumenteRoh, optionenRoh);
  const { eingabe, erlaubteCodes = [0], zeitlimit_ms = 120_000, maxBuffer = MAX_AUSGABE, umgebung, uid, gid, cwd } = optionen;
  return new Promise((aufloesen, ablehnen) => {
    const kind = execFile(programm, argumente, {
      timeout: zeitlimit_ms, maxBuffer, env: umgebung || { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      uid, gid, cwd, windowsHide: true,
    }, (fehler, stdout, stderr) => {
      const code = fehler && typeof fehler.code === 'number' ? fehler.code : (fehler ? -1 : 0);
      if (fehler && !erlaubteCodes.includes(code)) {
        return ablehnen(new FahnasFehler('E_SYSTEM', `Befehl ${programm} schlug fehl`, {
          befehl: [programm, ...argumente.map(schwaerzen)].join(' '), code, ausgabe: String(stderr || stdout || fehler.message).slice(0, 4000),
        }));
      }
      aufloesen({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (eingabe !== undefined) { kind.stdin.end(eingabe); }
  });
}

function schwaerzen(a) { return /passw|secret|geheim/i.test(a) ? '***' : a; }

/** Startet einen Prozess mit frei wählbaren stdio (für den Datenkanal). Gibt das Kind zurück. */
export function starten(programmRoh, argumenteRoh, optionenRoh = {}) {
  const { programm, argumente, optionen } = startArgumente(programmRoh, argumenteRoh, optionenRoh);
  return spawn(programm, argumente, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, windowsHide: true, ...optionen });
}

// ---------------------------------------------------------------------------------------------------------------------
// Nutzerwechsel mit Zusatzgruppen
// ---------------------------------------------------------------------------------------------------------------------
// Node/libuv ruft beim Start mit {uid, gid} setgroups(0) auf – der Prozess verliert alle Zusatzgruppen. Rechte, die nur
// über eine Gruppe laufen (exFAT/NTFS/FAT sind mit gid=fahnas-nutzer,umask=007 eingehängt, eigene Gruppen der Freigaben),
// griffen dann nie (Betreiber-Fund 26.09.: Ventoy-Stick „Keine Berechtigung“). Deshalb wechselt setpriv (util-linux) den
// Nutzer und setzt die Zusatzgruppen ausdrücklich – nur die von FAH-NAS (fahnas-nutzer/-admin, eigene Gruppen ≥ 1000),
// nie Systemgruppen wie sudo, docker oder adm.

const GRUPPEN_NAMENTLICH = new Set(['fahnas-nutzer', 'fahnas-admin']);

/** Zusatzgruppen (gids) aus der Ausgabe von `id <name>`, gefiltert auf FAH-NAS-Gruppen, ohne die Hauptgruppe. */
export function gruppenAusId(text, hauptgid) {
  const m = /groups=(\S+)/.exec(String(text || ''));
  if (!m) return [];
  const aus = [];
  for (const g of m[1].matchAll(/(\d+)\(([^)]*)\)/g)) {
    const gid = Number(g[1]);
    if (gid === Number(hauptgid) || aus.includes(gid)) continue;
    if (GRUPPEN_NAMENTLICH.has(g[2]) || (gid >= 1000 && gid < 60000)) aus.push(gid);
  }
  return aus;
}

/** Befehl als anderer Nutzer: setpriv mit uid, gid, Zusatzgruppen (leer → ausdrücklich keine) und ohne vererbbare Rechte. */
export function alsNutzer(programm, argumente, { uid, gid, gruppen = [] } = {}) {
  if (!Number.isInteger(uid) || uid < 0) throw new FahnasFehler('E_UNBEKANNT', `alsNutzer: uid ungültig (${uid})`);
  if (!Number.isInteger(gid) || gid < 0) throw new FahnasFehler('E_UNBEKANNT', `alsNutzer: gid ungültig (${gid})`);
  if (!Array.isArray(gruppen) || gruppen.some((g) => !Number.isInteger(g) || g < 0)) throw new FahnasFehler('E_UNBEKANNT', 'alsNutzer: gruppen ungültig');
  return {
    programm: 'setpriv',
    argumente: [`--reuid=${uid}`, `--regid=${gid}`, gruppen.length ? `--groups=${gruppen.join(',')}` : '--clear-groups', '--inh-caps=-all', '--', programm, ...argumente],
  };
}

/**
 * Setzt uid/gid/gruppen aus den Optionen um: als root über setpriv (sonst gingen die Zusatzgruppen verloren), uid 0 bleibt
 * root; ohne root-Rechte (Entwicklung, Tests) wie bisher über spawn-uid/gid. Die übrigen Optionen bleiben unverändert.
 */
export function startArgumente(programm, argumente, optionen = {}, istRoot = !!(process.getuid && process.getuid() === 0)) {
  const { uid, gid, gruppen, ...rest } = optionen;
  if (uid === undefined || uid === null) return { programm, argumente, optionen: rest };
  if (!istRoot) return { programm, argumente, optionen: { ...rest, uid, gid } };
  if (uid === 0) return { programm, argumente, optionen: rest };
  const w = alsNutzer(programm, argumente, { uid, gid, gruppen: gruppen || [] });
  return { programm: w.programm, argumente: w.argumente, optionen: rest };
}

/** uid/gid eines Linux-Nutzers über getent (kein /etc/passwd-Parsing von Hand, damit auch andere Quellen gehen). */
export async function nutzerIds(name) {
  const { stdout } = await ausfuehren('getent', ['passwd', name], { erlaubteCodes: [0, 2] });
  const zeile = stdout.trim();
  if (!zeile) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Linux-Nutzer ${name} existiert nicht`);
  const t = zeile.split(':');
  const uid = Number(t[2]); const gid = Number(t[3]);
  let gruppen = [];
  try { gruppen = gruppenAusId((await ausfuehren('id', [name])).stdout, gid); } catch { /* ohne Zusatzgruppen */ }
  return { uid, gid, heim: t[5], gruppen };
}

/** Gruppen-ID */
export async function gruppenId(name) {
  const { stdout } = await ausfuehren('getent', ['group', name], { erlaubteCodes: [0, 2] });
  const zeile = stdout.trim();
  if (!zeile) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Gruppe ${name} existiert nicht`);
  return Number(zeile.split(':')[2]);
}

/** Existiert ein Pfad? */
export async function existiert(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Liest eine Datei, gibt null zurück, wenn sie fehlt. */
export async function lesenOderNull(p) { try { return await fs.readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

/** Test-Ersatz: `setzeBefehl(fn)` ersetzt die Ausführung; `fn(programm, argumente, optionen)` liefert {code, stdout, stderr}. */
export const _test = { setzeBefehl(fn) { ersatz = fn; } };
let ersatz = null;
const echt = befehl;
export async function ausfuehren(programm, argumente = [], optionen = {}) {
  if (ersatz) return ersatz(programm, argumente, optionen);
  return echt(programm, argumente, optionen);
}
