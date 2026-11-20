// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Lokale FAH-NAS-Instanz für Bedienproben ohne Live-NAS (Mac): echter Agent + Webdienst auf http://127.0.0.1:18443,
// Wegwerf-Daten unter <ordner>/nas, Systembefehle als Attrappe (Docker leer, nur node/du/cat/zip/unzip/cp echt).
//   taskpolicy -c utility node tools/lokale_instanz.mjs <leerer-ordner> <passwort-für-fabian>
// Danach mit Headless-Chrome über das DevTools-Protokoll bedienen; am Ende Prozess beenden und den Ordner löschen.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const S = process.argv[2];
const PW = process.argv[3];
const d = (n) => path.join(S, 'nas', n);
for (const [k, n] of Object.entries({ FAHNAS_CONFIG: 'config', FAHNAS_RUN: 'run', FAHNAS_SHARES: 'shares', FAHNAS_APPS: 'apps', FAHNAS_VMS: 'vms',
  FAHNAS_BACKUP: 'backup', FAHNAS_CHAT: 'chat', FAHNAS_DATEN: 'daten', FAHNAS_VORSCHAU: 'vorschau', FAHNAS_GEO: 'geo', FAHNAS_IMPORT: 'import',
  FAHNAS_SNAPSHOTS: 'snapshots', FAHNAS_SAMBA: 'samba', FAHNAS_AVAHI: 'avahi', FAHNAS_NFT: 'nft/fahnas.nft', FAHNAS_NETPLAN: 'netplan', FAHNAS_STARTCODE: 'startcode' })) {
  process.env[k] = d(n);
  await fs.mkdir(n.endsWith('.nft') || n === 'startcode' ? path.dirname(d(n)) : d(n), { recursive: true });
}
process.env.FAHNAS_PROGRAMM = R;
process.env.FAHNAS_UEBERWACHUNG = '0';
process.chdir(d('run'));

const ich = os.userInfo();
const { _test } = await import(`${R}/src/gemeinsam/system.js`);
const echt = new Set(['node', 'du', 'cat', 'zip', 'unzip', 'cp']);
_test.setzeBefehl((prog, args = [], opt = {}) => new Promise((ok, nein) => {
  const erlaubt = opt.erlaubteCodes || [0];
  const antwort = (code, stdout = '', stderr = '') => {
    if (!erlaubt.includes(code)) { const e = new Error(`Befehl ${prog} schlug fehl (${code})`); e.code = 'E_SYSTEM'; e.details = { ausgabe: stderr || stdout }; nein(e); return; }
    ok({ code, stdout, stderr });
  };
  if (prog === 'getent' && args[0] === 'passwd') return antwort(0, `${args[1]}:x:${ich.uid}:${ich.gid}::${ich.homedir}:/bin/zsh\n`);
  if (prog === 'getent') return antwort(erlaubt.includes(2) ? 2 : 0, '');
  if (prog === 'id') return antwort(0, `uid=${ich.uid}(${ich.username}) gid=${ich.gid}(staff) groups=${ich.gid}(staff)\n`);
  if (prog === 'df') return antwort(0, 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/x 1000000000000 400000000000 600000000000 40% /data\n');
  if (prog === 'docker' && args[0] === 'version') return antwort(0, '29.1.3\n');
  // Dateihelfer (dateien.*): läuft als process.execPath mit JSON auf stdin – hier ohne uid-Wechsel als eigenes Konto
  if (prog === process.execPath && opt.eingabe !== undefined) {
    const k = execFile(prog, args, { cwd: opt.cwd, maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) => antwort(e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr));
    k.stdin.end(opt.eingabe);
    return undefined;
  }
  if (echt.has(prog)) {
    execFile(prog, args, { cwd: opt.cwd, maxBuffer: 64 * 1024 * 1024, encoding: opt.encoding === 'buffer' ? 'buffer' : 'utf8' }, (e, stdout, stderr) => antwort(e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr));
    return undefined;
  }
  return antwort(erlaubt.includes(1) && !erlaubt.includes(0) ? 1 : 0, '');
}));

// Testkonto fabian (Admin)
const totp = await import(`${R}/src/agent/totp.js`);
await fs.writeFile(path.join(d('config'), 'users.json'), JSON.stringify({ nutzer: [{ name: 'fabian', anzeigename: 'Fabian', rolle: 'admin', uid: ich.uid, gruppen: [], hash: await totp.hashErzeugen(PW), totp: null, gesperrt: false, erstellt: new Date().toISOString(), letzte_anmeldung: null }], gruppen: [] }), { mode: 0o600 });

const { Agent } = await import(`${R}/src/agent/agent.js`);
class LokalAgent extends Agent { async aktionenLaden() { await super.aktionenLaden(); this.register.aktionen.delete('system.apply'); } }
const agent = new LokalAgent({ hintergrund: false, socketPfad: 'agent.sock', datenSocket: 'daten.sock' });
await agent.starten();
const { WebDienst } = await import(`${R}/src/web/web.js`);
const web = new WebDienst({ ohneTls: true, port: 18443, httpPort: null, publicOrdner: `${R}/public`, agentSocket: 'agent.sock', datenSocket: 'daten.sock', turn: { portFest: 0 } });
await web.starten();
process.stdout.write('BEREIT\n');
