// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Integrationstest 16: Umstieg-Ausbau (0.25.0) auf Loop-Dateien wie auf einem UGREEN (GPT, Teil 2 = RAID-Mitglied):
// Volume A = RAID1 aus 2 Platten → LVM → btrfs (Backups mit Unterordner-Rechten, @home, docker mit App-Daten und
// Compose-Projekt), Volume B = RAID1 mit EINER Platte („Basis“) → LVM → ext4 mit alter Docker-Ablage (@docker).
// Prüft: Unterordner-Rechte → Ordnerrechte, App-Daten unverändert, persönlicher Ordner per Bind, alter Pfad, RAID prüfen,
// Platte tauschen, Spiegel ergänzen, Docker-Übernahme mit echtem Docker (Testprojekt „umtest“, lokales Image), Speicherort
// „vms“ auf Volume A und zurück, Trennen-Sperren, Trennen (Daten bleiben).
// Sicher auf einem laufenden FAH-NAS: nur eigene Loop-Geräte und Ordner unter /var/tmp; systemctl, nft, ufw, smbcontrol und
// virsh werden abgefangen (nichts am laufenden System umgestellt); Docker wird nie angehalten. Räumt immer auf.
// Aufruf: sudo node tests/integration/16_umstieg_ausbau.mjs   → Exit 0 alles ok, 1 Fehler, 3 übersprungen

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IT = process.env.FAHNAS_IT_UMSTIEG2 || '/var/tmp/fahnas-umstieg2';
const IMAGE = process.env.FAHNAS_IT_IMAGE || 'caddy:2.10.2-alpine'; // muss lokal vorhanden sein (kein Download)
let ok = 0; let fehler = 0;
const gut = (t) => { ok++; console.log(`OK      ${t}`); };
const schlecht = (t) => { fehler++; console.log(`FEHLER  ${t}`); };
const pruefe = (b, t) => (b ? gut(t) : schlecht(t));
const sh = (prog, args, o = {}) => execFileSync(prog, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...o });
const leise = (prog, args) => { try { return sh(prog, args); } catch { return null; } };
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.getuid() !== 0) { console.log('ÜBERSPRUNGEN: muss als root laufen'); process.exit(3); }
for (const w of ['mdadm', 'pvcreate', 'mkfs.btrfs', 'mkfs.ext4', 'losetup', 'sgdisk', 'setfacl', 'setpriv', 'findmnt', 'rsync', 'docker']) {
  if (!leise('sh', ['-c', `command -v ${w}`])) { console.log(`ÜBERSPRUNGEN: ${w} fehlt`); process.exit(3); }
}
if (!leise('docker', ['image', 'inspect', IMAGE])) { console.log(`ÜBERSPRUNGEN: Image ${IMAGE} fehlt lokal`); process.exit(3); }
process.env.FAHNAS_RAID_TEST_LOOPS = '1';
process.env.FAHNAS_PROGRAMM = WURZEL; // Startschritt-Unit aus diesem Stand (systemd/)
process.env.FAHNAS_SYSTEMD = `${IT}/systemd`;

const VG = ['ug_UMTEST_1_pool1', 'ug_UMTEST_2_pool2'];
const loops = [];
const ANONYM = crypto.randomBytes(32).toString('hex');

function eigeneRaids() {
  const namen = loops.map((l) => path.basename(l));
  return String(leise('cat', ['/proc/mdstat']) || '').split('\n').filter((z) => /^md\d+ :/.test(z) && namen.some((n) => new RegExp(`\\b${n}p\\d\\[`).test(z))).map((z) => `/dev/${z.split(' ')[0]}`);
}
function raidsStoppen(streng = false) {
  for (const v of VG) (streng ? sh : leise)('vgchange', ['-an', v]);
  for (const m of eigeneRaids()) (streng ? sh : leise)('mdadm', ['--stop', m]);
}
function aufraeumen() {
  leise('docker', ['compose', '-p', 'umtest', 'down', '-v', '--remove-orphans']);
  for (const c of String(leise('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=umtest']) || '').split('\n').filter(Boolean)) leise('docker', ['rm', '-f', '-v', c]);
  for (const v of String(leise('docker', ['volume', 'ls', '-q']) || '').split('\n').filter((x) => x.startsWith('umtest_'))) leise('docker', ['volume', 'rm', v]);
  for (const m of (leise('findmnt', ['-rn', '-o', 'TARGET']) || '').split('\n').filter((z) => z.startsWith(IT)).sort().reverse()) leise('umount', ['-l', m]);
  raidsStoppen();
  for (const l of loops) { for (const t of [`${l}p2`, l]) leise('mdadm', ['--zero-superblock', t]); leise('losetup', ['-d', l]); }
  leise('chattr', ['-R', '-i', IT]);
  leise('rm', ['-rf', IT]);
}
process.on('exit', aufraeumen);
process.on('SIGINT', () => process.exit(130));

const PFADE = {
  konfig: `${IT}/config`, shares: `${IT}/shares`, snapshots: `${IT}/snapshots`, importe: `${IT}/import`, run: `${IT}/run`,
  samba: `${IT}/samba`, avahi: `${IT}/avahi`, backup: `${IT}/backup`, daten: IT, apps: `${IT}/apps`, vms: `${IT}/vms`,
  alteWurzel: `${IT}/alt`, nft: `${IT}/fahnas.nft`, docker: `${IT}/docker-unbenutzt`,
};

/** Warten, bis das RAID nichts mehr tut. */
async function ruhig(md, sekunden = 300) {
  const datei = `/sys/block/${path.basename(md)}/md/sync_action`;
  for (let i = 0; i < sekunden; i++) { if (String(await fs.readFile(datei, 'utf8').catch(() => 'idle')).trim() === 'idle') return true; await warte(1000); }
  return false;
}

try {
  aufraeumen();
  for (const p of Object.values(PFADE)) if (!p.endsWith('.nft')) await fs.mkdir(p, { recursive: true });
  // ---- 1. Platten: GPT mit Teil 1 (System) und Teil 2 (Daten) wie unter UGOS; zwei freie Platten ---------------------
  for (let i = 0; i < 5; i++) {
    const datei = `${IT}/platte${i}.img`;
    sh('truncate', ['-s', '300M', datei]);
    loops.push(sh('losetup', ['--find', '--show', '-P', datei]).trim());
  }
  const [A1, A2, B1, F1, F2] = loops;
  for (const l of [A1, A2, B1]) { sh('sgdisk', ['-n', '1:0:+16M', '-n', '2:0:0', l]); leise('partprobe', [l]); }
  sh('udevadm', ['settle']);
  const uid = (name) => Number(sh('id', ['-u', name]).trim());
  const UGOS = { daemon: 1001, bin: 1002 };
  sh('mdadm', ['--create', '/dev/md/fahnas-ut2-a', '--level=1', '--raid-devices=2', '--metadata=1.2', '--run', '--homehost=UGREEN', `${A1}p2`, `${A2}p2`], { input: 'y\n' });
  sh('mdadm', ['--create', '/dev/md/fahnas-ut2-b', '--level=1', '--raid-devices=1', '--force', '--metadata=1.2', '--run', '--homehost=UGREEN', `${B1}p2`], { input: 'y\n' });
  const lvs = [];
  for (const [i, m] of ['/dev/md/fahnas-ut2-a', '/dev/md/fahnas-ut2-b'].entries()) {
    sh('pvcreate', ['-ff', '-y', m]); sh('vgcreate', [VG[i], m]); sh('lvcreate', ['-y', '-l', '100%FREE', '-n', 'volume1', VG[i]]);
    lvs.push(`/dev/${VG[i]}/volume1`);
  }
  sh('mkfs.btrfs', ['-q', '-f', lvs[0]]); sh('mkfs.ext4', ['-q', '-F', lvs[1]]);
  const uuidA = sh('blkid', ['-s', 'UUID', '-o', 'value', lvs[0]]).trim(); const uuidB = sh('blkid', ['-s', 'UUID', '-o', 'value', lvs[1]]).trim();
  const bau = `${IT}/bau`; await fs.mkdir(bau);
  // Volume A: Freigaben als Unterlaufwerke, 0777 wie unter UGOS
  sh('mount', [lvs[0], bau]);
  for (const s of ['Backups', '@home', 'docker', '@appstore']) sh('btrfs', ['subvolume', 'create', `${bau}/${s}`]);
  for (const d of ['Backups/UgreenNAS', 'Backups/NPM', '@home/daemon', 'docker/umtest/pgdata']) await fs.mkdir(`${bau}/${d}`, { recursive: true });
  for (const d of ['Backups', 'Backups/UgreenNAS', 'Backups/NPM', 'docker', 'docker/umtest']) await fs.chmod(`${bau}/${d}`, 0o777);
  const geheim = crypto.randomBytes(50_000); const privat = crypto.randomBytes(40_000);
  await fs.writeFile(`${bau}/Backups/UgreenNAS/geheim.bin`, geheim); await fs.writeFile(`${bau}/Backups/NPM/npm.txt`, 'npm\n');
  await fs.chown(`${bau}/Backups/NPM/npm.txt`, UGOS.bin, 100);
  await fs.writeFile(`${bau}/@home/daemon/privat.bin`, privat); await fs.chown(`${bau}/@home/daemon/privat.bin`, UGOS.daemon, 100);
  await fs.chown(`${bau}/@home/daemon`, UGOS.daemon, 100); await fs.chmod(`${bau}/@home/daemon`, 0o700);
  // App-Daten: Datenbank-Ordner gehört dem Container-Konto 999 mit 0700 – darf NICHT umgeschrieben werden
  await fs.writeFile(`${bau}/docker/umtest/pgdata/PG_VERSION`, '17\n');
  await fs.chown(`${bau}/docker/umtest/pgdata`, 999, 999); await fs.chown(`${bau}/docker/umtest/pgdata/PG_VERSION`, 999, 999); await fs.chmod(`${bau}/docker/umtest/pgdata`, 0o700);
  await fs.writeFile(`${bau}/docker/umtest/docker-compose.yml`, [
    'services:', '  app:', `    image: ${IMAGE}`, '    command: ["sleep", "3600"]', '    volumes:', '      - daten:/daten', '      - /cache', 'volumes:', '  daten:', '',
  ].join('\n'));
  const ugacl = (e) => { const b = Buffer.alloc(4 + 20 * e.length); b.writeUInt32LE(1, 0); e.forEach(([a, m, id], i) => { b.writeUInt32LE(a, 4 + 20 * i); b.writeUInt32LE(m, 8 + 20 * i); b.writeUInt32LE(6, 12 + 20 * i); b.writeUInt32LE(id >>> 0, 16 + 20 * i); }); return b.toString('base64'); };
  const RW = 0x37cf;
  await fs.writeFile(`${bau}/Backups/fahnas-ugos-export.json`, JSON.stringify({
    version: 1, quelle: 'UGOS', rechner: 'ugreen-test', erstellt: new Date().toISOString(),
    nutzer: [{ name: 'daemon', uid: UGOS.daemon, gid: 100 }, { name: 'bin', uid: UGOS.bin, gid: 100 }], gruppen: [{ name: 'admin', gid: 10, mitglieder: [] }],
    volumes: [{ mount: '/volume1', uuid: uuidA, ordner: [
      { name: 'Backups', uid: 0, ugacl: ugacl([[5, RW, UGOS.daemon], [5, RW, UGOS.bin]]), unter: [{ pfad: 'UgreenNAS', ugacl: ugacl([[10, RW, 10]]) }] },
      { name: 'docker', uid: 0, ugacl: ugacl([[5, RW, UGOS.daemon]]), unter: [{ pfad: 'umtest', ugacl: ugacl([[10, RW, 10]]) }] },
      { name: '@home', uid: 0, ugacl: null, heim: [{ name: 'daemon', uid: UGOS.daemon, ugacl: null }] },
    ] }],
  }));
  sh('umount', [bau]);
  // Volume B: alte Docker-Ablage (nur config.v2.json/hostconfig.json + Volume-Daten)
  sh('mount', [lvs[1], bau]);
  const cid = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(`${bau}/@docker/containers/${cid}`, { recursive: true });
  const labels = { 'com.docker.compose.project': 'umtest', 'com.docker.compose.service': 'app', 'com.docker.compose.project.working_dir': '/volume1/docker/umtest', 'com.docker.compose.project.config_files': '/volume1/docker/umtest/docker-compose.yml' };
  await fs.writeFile(`${bau}/@docker/containers/${cid}/config.v2.json`, JSON.stringify({ ID: cid, Name: '/umtest-app-1', State: { Running: true }, HasBeenManuallyStopped: false,
    Config: { Image: IMAGE, Labels: labels, Env: ['PUID=1001'] },
    MountPoints: { '/daten': { Type: 'volume', Name: 'umtest_daten', Destination: '/daten', Driver: 'local' }, '/cache': { Type: 'volume', Name: ANONYM, Destination: '/cache', Driver: 'local' } } }));
  await fs.writeFile(`${bau}/@docker/containers/${cid}/hostconfig.json`, JSON.stringify({ RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'umtest_default' }));
  const inhaltDaten = crypto.randomBytes(80_000); const inhaltCache = crypto.randomBytes(20_000);
  await fs.mkdir(`${bau}/@docker/volumes/umtest_daten/_data/unter`, { recursive: true }); await fs.mkdir(`${bau}/@docker/volumes/${ANONYM}/_data`, { recursive: true });
  await fs.writeFile(`${bau}/@docker/volumes/umtest_daten/_data/unter/inhalt.bin`, inhaltDaten); await fs.chown(`${bau}/@docker/volumes/umtest_daten/_data/unter/inhalt.bin`, 999, 999);
  await fs.writeFile(`${bau}/@docker/volumes/${ANONYM}/_data/cache.bin`, inhaltCache);
  sh('umount', [bau]);
  raidsStoppen(true);
  gut('UGOS-Nachbau: RAID1 (2 Platten) → btrfs, RAID1 „Basis“ (1 Platte) → ext4 mit @docker, 2 freie Platten');

  // ---- 2. Agent (beteiligte Bereiche), Systemzugriffe auf das laufende NAS abgefangen -----------------------------------
  process.env.FAHNAS_RUN = PFADE.run;
  const { Konfig } = await import(`${WURZEL}/src/gemeinsam/konfig.js`);
  const echt = await import(`${WURZEL}/src/gemeinsam/system.js`);
  const abgefangen = [];
  const ABFANGEN = new Set(['systemctl', 'nft', 'ufw', 'smbcontrol', 'virsh', 'systemd-run']);
  const system = { ...echt, ausfuehren: async (prog, args = [], o = {}) => { if (ABFANGEN.has(prog)) { abgefangen.push([prog, ...args]); return { code: 0, stdout: '', stderr: '' }; } return echt.ausfuehren(prog, args, o); } };
  const { Register } = await import(`${WURZEL}/src/agent/register.js`);
  const konfig = new Konfig(PFADE.konfig); await konfig.sicherstellen();
  await konfig.speichern('users.json', { nutzer: [{ name: 'daemon', rolle: 'nutzer', uid: uid('daemon'), gruppen: [] }, { name: 'bin', rolle: 'nutzer', uid: uid('bin'), gruppen: [] }, { name: 'sys', rolle: 'admin', uid: uid('sys'), gruppen: [] }], gruppen: [] });
  await konfig.speichern('shares.json', { freigaben: [] });
  await konfig.speichern('system.json', { ssh: true });
  const reg = new Register();
  const w = { konfig, system, pfade: PFADE, audit: { eintrag() {} }, konfigGeaendert() {} };
  const rufen = async (aktion, params = {}) => { const k = { nutzer: 'system', rolle: 'system', ip: '-' }; const { aktion: a, params: p } = reg.vorbereiten(aktion, params, k); return a.ausfuehren(p, k, w, { fortschritt() {}, abgebrochen: () => false }); };
  w.intern = rufen;
  for (const b of ['freigaben', 'importe', 'heim', 'apps', 'speicherorte']) (await import(`${WURZEL}/src/agent/aktionen/${b}.js`)).registriere(reg, w);
  reg.aktion('benachrichtigungen.senden', { rolle: 'system', schema: {}, ausfuehren: async () => true });

  // ---- 3. Suchen ------------------------------------------------------------------------------------------------------
  const such = await rufen('importe.suchen');
  const vA = such.volumes.find((v) => v.uuid === uuidA); const vB = such.volumes.find((v) => v.uuid === uuidB);
  const oA = Object.fromEntries((vA?.ordner || []).map((o) => [o.name, o]));
  pruefe(vA && vB, 'Suchen findet beide Volumes');
  pruefe(vA?.alter_pfad === '/volume1' && vA.alter_pfad_frei === true && vB?.alter_pfad === '/volume2', 'Alter Pfad: aus dem Export (/volume1) bzw. aus pool2 (/volume2)');
  pruefe(JSON.stringify(oA.Backups?.ordnerrechte) === JSON.stringify([{ pfad: 'UgreenNAS', regeln: { bin: 'keiner', daemon: 'keiner' } }]), `Unterordner UgreenNAS (nur Admins) → Ordnerrechte keiner (${JSON.stringify(oA.Backups?.ordnerrechte)})`);
  pruefe(oA.docker?.app_daten === true && !oA.Backups?.app_daten, 'docker-Ordner als App-Daten erkannt');
  pruefe(JSON.stringify((vA?.heim || []).map((h) => [h.ordner, h.vorschlag])) === JSON.stringify([['@home/daemon', 'daemon']]), 'Persönlicher Ordner @home/daemon → Nutzer daemon vorgeschlagen');

  // ---- 4. Übernehmen --------------------------------------------------------------------------------------------------
  const erg = await rufen('importe.uebernehmen', {
    volumes: [
      { uuid: uuidA, alter_pfad: '/volume1', heime: [{ ordner: '@home/daemon', nutzer: 'daemon' }], ordner: [
        { ordner: 'Backups', name: 'backups', lesen: [], schreiben: ['bin', 'daemon'], ordnerrechte: oA.Backups.ordnerrechte },
        { ordner: 'docker', name: 'docker-alt', lesen: [], schreiben: ['daemon'], rechte_lassen: true },
      ] },
      { uuid: uuidB, ordner: [] },
    ],
    besitzer: { [UGOS.daemon]: 'daemon', [UGOS.bin]: 'bin' },
  });
  pruefe(erg.angelegt.length === 2 && erg.heime.length === 1 && !erg.fehler.length, `Übernommen: 2 Freigaben, 1 persönlicher Ordner${erg.fehler.length ? ` – ${JSON.stringify(erg.fehler)}` : ''}`);
  const S = (n) => `${PFADE.shares}/${n}`;
  const als = (n, ...cmd) => { try { sh('setpriv', ['--reuid', n, '--regid', n, '--clear-groups', '--', ...cmd]); return true; } catch { return false; } };
  pruefe(als('bin', 'cat', `${S('backups')}/NPM/npm.txt`) && !als('bin', 'ls', `${S('backups')}/UgreenNAS`) && !als('daemon', 'cat', `${S('backups')}/UgreenNAS/geheim.bin`), 'Ordnerrecht aus UGOS wirkt: UgreenNAS für daemon und bin gesperrt, NPM lesbar');
  pruefe(Buffer.compare(await fs.readFile(`${S('backups')}/UgreenNAS/geheim.bin`), geheim) === 0, 'Gesperrter Inhalt unverändert');
  const pg = await fs.stat(`${S('docker-alt')}/umtest/pgdata`);
  pruefe(pg.uid === 999 && (pg.mode & 0o777) === 0o700 && (await fs.stat(`${S('docker-alt')}/umtest/pgdata/PG_VERSION`)).uid === 999, 'App-Daten: Besitzer 999 und 0700 unverändert');
  pruefe(erg.rechte.some((r) => r.name === 'docker-alt' && r.unveraendert), 'App-Daten-Freigabe ohne Rechte-Abgleich');
  let verweigert = false;
  try { await rufen('freigaben.rechte.anwenden', { name: 'docker-alt' }); } catch (e) { verweigert = /unverändert/.test(e.message); }
  pruefe(verweigert, '„Rechte übertragen“ verweigert bei App-Daten (ohne erzwingen)');
  const heim = `${IT}/homes/daemon`;
  pruefe(sh('findmnt', ['-rn', '-o', 'TARGET']).split('\n').includes(heim), 'Persönlicher Ordner per Bind-Mount eingehängt');
  const hs = await fs.stat(heim);
  pruefe(hs.uid === uid('daemon') && (hs.mode & 0o777) === 0o700 && (await fs.stat(`${heim}/privat.bin`)).uid === uid('daemon'), 'Persönlicher Ordner gehört daemon (0700), Datei umgeschrieben');
  pruefe(als('daemon', 'cat', `${heim}/privat.bin`) && !als('bin', 'ls', heim), 'Nur daemon sieht seinen persönlichen Ordner');
  pruefe(Buffer.compare(await fs.readFile(`${heim}/privat.bin`), privat) === 0, 'Inhalt des persönlichen Ordners unverändert');
  const users = await konfig.laden('users.json');
  pruefe(users.nutzer.find((n) => n.name === 'daemon')?.heim?.quelle?.ordner === '@home/daemon', 'users.json: heim.quelle gesetzt');
  await rufen('heim.setzen', { name: 'daemon', aktiv: true, groesse_gb: 5 });
  pruefe((await konfig.laden('users.json')).nutzer.find((n) => n.name === 'daemon')?.heim?.quelle && (await konfig.laden('users.json')).nutzer.find((n) => n.name === 'daemon').heim.groesse_gb === null, 'heim.setzen behält die Quelle (keine Grenze)');
  const alt1 = `${PFADE.alteWurzel}/volume1`;
  pruefe((await fs.readdir(`${alt1}/docker/umtest`)).includes('docker-compose.yml'), 'Alter Pfad /volume1 zeigt das Volume');

  // ---- 5. RAID: prüfen, Platte tauschen, Spiegel ergänzen ---------------------------------------------------------------
  let liste = await rufen('importe.liste');
  let rA = liste.volumes.find((v) => v.uuid === uuidA)?.raid; let rB = liste.volumes.find((v) => v.uuid === uuidB)?.raid;
  pruefe(rA?.mitglieder?.length === 2 && rB?.platten_soll === 1, `RAID-Details: A mit 2, B mit 1 Platte (${rA?.md}, ${rB?.md})`);
  await ruhig(rA.md); await ruhig(rB.md);
  await rufen('importe.raid.pruefen', { uuid: uuidA });
  pruefe(await ruhig(rA.md, 120) && String(await fs.readFile(`/sys/block/${path.basename(rA.md)}/md/mismatch_cnt`, 'utf8')).trim() === '0', 'Prüfung lief durch, keine Abweichungen');
  sh('mdadm', ['--manage', rA.md, '--fail', `${A2}p2`]);
  liste = await rufen('importe.liste'); rA = liste.volumes.find((v) => v.uuid === uuidA).raid;
  pruefe(rA.mitglieder.some((m) => m.geraet === `${A2}p2` && m.zustand === 'defekt'), 'Ausfall erkannt (Mitglied defekt)');
  let falsch = null;
  try { await rufen('importe.raid.ersetzen', { uuid: uuidA, alt: `${A1}p2`, neu: path.basename(F2), bestaetigung: path.basename(F2) }); } catch (e) { falsch = e.message; }
  pruefe(/funktioniert/.test(falsch || ''), 'Gesunde Platte wird nie getauscht');
  try { await rufen('importe.raid.ersetzen', { uuid: uuidA, alt: `${A2}p2`, neu: path.basename(F2), bestaetigung: 'falsch' }); falsch = null; } catch (e) { falsch = e.message; }
  pruefe(/eintippen/.test(falsch || ''), 'Ohne eingetippten Plattennamen geht nichts');
  const tausch = await rufen('importe.raid.ersetzen', { uuid: uuidA, alt: `${A2}p2`, neu: path.basename(F2), bestaetigung: path.basename(F2) });
  pruefe(tausch.modus === 'tauschen' && tausch.neu === `${F2}p2`, `Platte getauscht: ${tausch.neu}`);
  pruefe(await ruhig(rA.md, 300), 'Neuaufbau fertig');
  liste = await rufen('importe.liste'); rA = liste.volumes.find((v) => v.uuid === uuidA).raid;
  pruefe(!rA.degraded && rA.mitglieder.length === 2 && rA.mitglieder.every((m) => m.zustand === 'ok') && rA.mitglieder.some((m) => m.geraet === `${F2}p2`), 'RAID A wieder vollständig mit neuer Platte');
  pruefe(sh('sgdisk', ['-p', F2]).includes('Number') && (await fs.stat(`${F2}p1`).then(() => true, () => false)), 'Neue Platte hat die Aufteilung der gesunden (Teil 1 + 2)');
  const spiegel = await rufen('importe.raid.ersetzen', { uuid: uuidB, neu: path.basename(F1), bestaetigung: path.basename(F1) });
  pruefe(spiegel.modus === 'spiegel', 'RAID B „Basis“: Spiegel ergänzt');
  pruefe(await ruhig(rB.md, 300), 'Spiegel aufgebaut');
  liste = await rufen('importe.liste'); rB = liste.volumes.find((v) => v.uuid === uuidB).raid;
  pruefe(rB.platten_soll === 2 && rB.mitglieder.length === 2 && !rB.degraded, 'RAID B jetzt mit 2 Platten');
  pruefe(Buffer.compare(await fs.readFile(`${S('backups')}/UgreenNAS/geheim.bin`), geheim) === 0, 'Daten nach Tausch unverändert');

  // ---- 6. Docker-Übernahme ----------------------------------------------------------------------------------------------
  const ds = await rufen('apps.uebernahme.suchen');
  const ab = ds.ablagen.find((a) => a.volume === uuidB);
  const pr = ab?.projekte.find((p) => p.projekt === 'umtest');
  pruefe(pr && pr.dateien_da && !pr.fehlende_pfade.length && pr.autostart && pr.volumes.length === 2, `Alte Ablage gelesen: Projekt umtest, 2 Volumes, alter Pfad da (${JSON.stringify(pr && { f: pr.fehlende_pfade, d: pr.dateien_da })})`);
  const ue = await rufen('apps.uebernahme.starten', { volume: uuidB, projekte: [{ projekt: 'umtest', name: 'umtest', autostart: true }] });
  const u0 = ue.uebernommen[0];
  pruefe(u0 && u0.gestartet && !ue.fehler.length, `Übernommen und gestartet${ue.fehler.length ? ` – ${JSON.stringify(ue.fehler)}` : u0?.start_fehler ? ` – ${u0.start_fehler}` : ''}`);
  const cont = String(sh('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=umtest'])).trim();
  const lies = (datei) => execFileSync('docker', ['exec', cont, 'cat', datei]);
  pruefe(cont && Buffer.compare(lies('/daten/unter/inhalt.bin'), inhaltDaten) === 0, 'Benanntes Volume mit Daten im Container');
  pruefe(cont && Buffer.compare(lies('/cache/cache.bin'), inhaltCache) === 0, 'Früheres anonymes Volume über die Zusatzdatei eingebunden');
  pruefe(String(sh('docker', ['exec', cont, 'stat', '-c', '%u', '/daten/unter/inhalt.bin'])).trim() === '999', 'Besitzer als Zahl kopiert (999)');
  const satz = await konfig.laden('apps/umtest/app.json');
  pruefe(satz?.uebernommen && satz.projekt_ordner === `${alt1}/docker/umtest` && satz.compose_dateien.some((d) => d.endsWith('fahnas-uebernahme.yml')), 'App-Satz: übernommen, Projektordner am alten Pfad, Zusatzdatei');
  await rufen('apps.loeschen', { name: 'umtest', daten: 'loeschen' });
  const vols = String(sh('docker', ['volume', 'ls', '-q'])).split('\n').filter((x) => x.startsWith('umtest_'));
  pruefe(!String(sh('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=umtest'])).trim() && !vols.length, 'Löschen: Container und kopierte Volumes weg');
  pruefe((await fs.readdir(`${alt1}/docker/umtest`)).includes('docker-compose.yml'), 'Löschen: Compose-Ordner am alten Ort unangetastet');
  pruefe(Buffer.compare(await fs.readFile(`${PFADE.importe}/${uuidB.replace(/-/g, '').slice(0, 12)}/@docker/volumes/umtest_daten/_data/unter/inhalt.bin`), inhaltDaten) === 0, 'Alte Docker-Ablage unverändert');

  // ---- 7. Speicherort „vms“ auf Volume A und zurück ----------------------------------------------------------------------
  await fs.mkdir(`${IT}/@vms/isos`, { recursive: true });
  const vmInhalt = crypto.randomBytes(120_000);
  await fs.writeFile(`${IT}/@vms/isos/test.iso`, vmInhalt);
  sh('mount', ['--bind', `${IT}/@vms`, PFADE.vms]); // wie fstab: /data/vms = Unterlaufwerk @vms
  sh('mount', ['--make-private', PFADE.vms]); // eigene Einhängung wie aus der fstab (kein gespiegelter Partner von /)
  await rufen('speicherorte.setzen', { bereich: 'vms', ziel: uuidA });
  const volVms = `${PFADE.importe}/${uuidA.replace(/-/g, '').slice(0, 12)}/@fahnas/vms`;
  const [st1, st2] = await Promise.all([fs.stat(PFADE.vms), fs.stat(volVms)]);
  pruefe(st1.dev === st2.dev && st1.ino === st2.ino, '/data/vms zeigt jetzt auf das Volume');
  pruefe(Buffer.compare(await fs.readFile(`${PFADE.vms}/isos/test.iso`), vmInhalt) === 0, 'VM-Dateien kopiert');
  pruefe((await fs.readFile(`${IT}/systemd/libvirtd.service.d/fahnas-speicherort.conf`, 'utf8')).includes('Requires=fahnas-speicherorte.service'), 'Drop-in für libvirtd geschrieben');
  pruefe(abgefangen.some((a) => a.join(' ') === 'systemctl enable fahnas-speicherorte.service'), 'Startschritt würde aktiviert (abgefangen)');
  let gesperrt = null;
  try { await rufen('importe.trennen', { uuid: uuidA }); } catch (e) { gesperrt = e.message; }
  pruefe(/Speicherorte|VMs/.test(gesperrt || ''), 'Trennen gesperrt, solange die VMs auf dem Volume liegen');
  await fs.writeFile(`${PFADE.vms}/neu.txt`, 'neu\n');
  sh('umount', [PFADE.vms]); // „Neustart“: Bind weg
  await rufen('speicherorte.apply');
  const st3 = await fs.stat(PFADE.vms);
  pruefe(st3.ino === st2.ino && st3.dev === st2.dev, 'Startschritt hängt den Speicherort wieder ein');
  await rufen('speicherorte.setzen', { bereich: 'vms', ziel: 'system' });
  pruefe((await fs.readFile(`${PFADE.vms}/neu.txt`, 'utf8')) === 'neu\n' && (await fs.readFile(`${IT}/@vms/neu.txt`, 'utf8')) === 'neu\n', 'Zurück auf die Systemplatte – neue Datei mitgenommen');
  pruefe(!(await fs.access(`${IT}/systemd/libvirtd.service.d/fahnas-speicherort.conf`).then(() => true, () => false)), 'Drop-in wieder entfernt');

  // ---- 8. Trennen: persönlicher Ordner gelöst, Daten bleiben -----------------------------------------------------------
  const tr = await rufen('importe.trennen', { uuid: uuidA });
  pruefe(tr.heime.includes('daemon') && !sh('findmnt', ['-rn', '-o', 'TARGET']).split('\n').includes(heim), 'Trennen löst den persönlichen Ordner');
  pruefe((await konfig.laden('users.json')).nutzer.find((n) => n.name === 'daemon')?.heim?.aktiv === false, 'users.json: persönlicher Ordner aus');
  pruefe(!sh('findmnt', ['-rn', '-o', 'TARGET']).split('\n').includes(alt1), 'Alter Pfad gelöst');
  sh('mount', ['-o', 'ro', `UUID=${uuidA}`, bau]);
  pruefe(Buffer.compare(await fs.readFile(`${bau}/@home/daemon/privat.bin`), privat) === 0 && Buffer.compare(await fs.readFile(`${bau}/Backups/UgreenNAS/geheim.bin`), geheim) === 0, 'Daten unverändert auf den Platten');
  sh('umount', [bau]);
} catch (e) {
  schlecht(`Abbruch: ${e.stack || e.message}`);
}
console.log(`\nErgebnis: ${ok} in Ordnung, ${fehler} fehlgeschlagen.`);
process.exitCode = fehler ? 1 : 0;
