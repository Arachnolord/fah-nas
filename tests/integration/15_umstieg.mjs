// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Integrationstest 15: Umstieg von UGOS (0.24.0) – echte Platten-Nachbildung auf Loop-Dateien wie auf einem UGREEN:
// Partition → mdadm-RAID1 (Superblock 1.2) → LVM (VG ug_…_poolN, LV volume1) → btrfs mit Unterlaufwerken bzw. ext4,
// Ordner 0777 wie unter UGOS, Dateien der alten uids 1001/1002, UGOS-Export mit Rechten. Dann wie nach dem Umzug:
// alles gestoppt → importe.suchen (nur lesend) → importe.uebernehmen → Prüfungen (Inhalte unverändert, Besitzer über den
// NAMEN umgeschrieben, Rechte, Schnappschuss auf demselben Volume) → „Neustart“ (alles aus) → importe.apply → Trennen
// (Daten bleiben). Fasst nur eigene Loop-Geräte an (auch auf einem laufenden FAH-NAS lauffähig, root nötig) und räumt
// immer auf. Als Konten dienen die Systemkonten daemon/bin/sys (es werden keine Nutzer angelegt).
// Aufruf: sudo node tests/integration/15_umstieg.mjs   → Exit 0 alles ok, 1 Fehler, 3 übersprungen

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IT = process.env.FAHNAS_IT_UMSTIEG || '/var/tmp/fahnas-umstieg';
let ok = 0; let fehler = 0;
const gut = (t) => { ok++; console.log(`OK      ${t}`); };
const schlecht = (t) => { fehler++; console.log(`FEHLER  ${t}`); };
const pruefe = (b, t) => (b ? gut(t) : schlecht(t));
const sh = (prog, args, o = {}) => execFileSync(prog, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...o });
const leise = (prog, args) => { try { return sh(prog, args); } catch { return null; } };

if (process.getuid() !== 0) { console.log('ÜBERSPRUNGEN: muss als root laufen'); process.exit(3); }
for (const w of ['mdadm', 'pvcreate', 'mkfs.btrfs', 'mkfs.ext4', 'losetup', 'setfacl', 'setpriv', 'findmnt']) {
  if (!leise('sh', ['-c', `command -v ${w}`])) { console.log(`ÜBERSPRUNGEN: ${w} fehlt`); process.exit(3); }
}

const MD = ['/dev/md/fahnas-umtest-a', '/dev/md/fahnas-umtest-b'];
const VG = ['ug_UMTEST_1_pool1', 'ug_UMTEST_2_pool2'];
const loops = [];

/** RAIDs mit eigenen Loop-Mitgliedern – nach dem Zusammensetzen durch den Agenten heißen sie md126/md127, nicht wie angelegt. */
function eigeneRaids() {
  const namen = loops.map((l) => path.basename(l));
  return String(leise('cat', ['/proc/mdstat']) || '').split('\n').filter((z) => /^md\d+ :/.test(z) && namen.some((n) => new RegExp(`\\b${n}\\[`).test(z))).map((z) => `/dev/${z.split(' ')[0]}`);
}
function raidsStoppen(streng = false) {
  for (const v of VG) (streng ? sh : leise)('vgchange', ['-an', v]);
  for (const m of eigeneRaids()) (streng ? sh : leise)('mdadm', ['--stop', m]);
}
function aufraeumen() {
  for (const m of (leise('findmnt', ['-rn', '-o', 'TARGET']) || '').split('\n').filter((z) => z.startsWith(IT)).sort().reverse()) leise('umount', ['-l', m]);
  raidsStoppen();
  for (const l of loops) { leise('mdadm', ['--zero-superblock', l]); leise('losetup', ['-d', l]); }
  leise('chattr', ['-R', '-i', IT]);
  leise('rm', ['-rf', IT]);
}
process.on('exit', aufraeumen);
process.on('SIGINT', () => process.exit(130));

const PFADE = {
  konfig: `${IT}/config`, shares: `${IT}/shares`, snapshots: `${IT}/snapshots`, importe: `${IT}/import`, run: `${IT}/run`,
  samba: `${IT}/samba`, avahi: `${IT}/avahi`, backup: `${IT}/backup`, daten: IT, apps: `${IT}/apps`,
};

try {
  aufraeumen();
  for (const p of Object.values(PFADE)) await fs.mkdir(p, { recursive: true });
  // ---- 1. UGOS-Platten nachbauen ------------------------------------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const datei = `${IT}/platte${i}.img`;
    sh('truncate', ['-s', '360M', datei]);
    loops.push(sh('losetup', ['--find', '--show', datei]).trim());
  }
  const uid = (name) => Number(sh('id', ['-u', name]).trim());
  const UGOS = { daemon: 1001, bin: 1002 }; // alte uids unter „UGOS“ – auf FAH-NAS heißen daemon/bin anders (uid 1/2)
  sh('mdadm', ['--create', MD[0], '--level=1', '--raid-devices=2', '--metadata=1.2', '--run', '--homehost=UGREEN', loops[0], loops[1]], { input: 'y\n' });
  sh('mdadm', ['--create', MD[1], '--level=1', '--raid-devices=2', '--metadata=1.2', '--run', '--homehost=UGREEN', loops[2], loops[3]], { input: 'y\n' });
  const lvs = [];
  for (const [i, m] of MD.entries()) {
    sh('pvcreate', ['-ff', '-y', m]); sh('vgcreate', [VG[i], m]); sh('lvcreate', ['-y', '-l', '100%FREE', '-n', 'volume1', VG[i]]);
    lvs.push(`/dev/${VG[i]}/volume1`);
  }
  sh('mkfs.btrfs', ['-q', '-f', lvs[0]]); sh('mkfs.ext4', ['-q', '-F', lvs[1]]);
  const uuidA = sh('blkid', ['-s', 'UUID', '-o', 'value', lvs[0]]).trim(); const uuidB = sh('blkid', ['-s', 'UUID', '-o', 'value', lvs[1]]).trim();
  const bau = `${IT}/bau`; await fs.mkdir(bau);
  sh('mount', [lvs[0], bau]);
  for (const s of ['Arbeit', 'Backups', '@home', '@appstore']) sh('btrfs', ['subvolume', 'create', `${bau}/${s}`]);
  await fs.mkdir(`${bau}/@home/daemon`); await fs.chown(`${bau}/@home/daemon`, UGOS.daemon, 100);
  await fs.mkdir(`${bau}/Arbeit/Projekt A`, { recursive: true });
  const inhaltA = crypto.randomBytes(300_000);
  await fs.writeFile(`${bau}/Arbeit/Projekt A/plan.bin`, inhaltA); await fs.chown(`${bau}/Arbeit/Projekt A/plan.bin`, UGOS.daemon, 100);
  await fs.writeFile(`${bau}/Arbeit/start.sh`, '#!/bin/sh\n'); await fs.chmod(`${bau}/Arbeit/start.sh`, 0o777);
  await fs.writeFile(`${bau}/Backups/sicherung.tar`, crypto.randomBytes(100_000)); await fs.chown(`${bau}/Backups/sicherung.tar`, UGOS.bin, 100);
  for (const d of ['Arbeit', 'Arbeit/Projekt A', 'Backups']) await fs.chmod(`${bau}/${d}`, 0o777);
  // UGOS-Export (tools/ugos-export.py) mit Rechten: Arbeit daemon schreibt, bin liest; Backups jeder schreibt
  const ugacl = (e) => { const b = Buffer.alloc(4 + 20 * e.length); b.writeUInt32LE(1, 0); e.forEach(([a, m, id], i) => { b.writeUInt32LE(a, 4 + 20 * i); b.writeUInt32LE(m, 8 + 20 * i); b.writeUInt32LE(6, 12 + 20 * i); b.writeUInt32LE(id >>> 0, 16 + 20 * i); }); return b.toString('base64'); };
  const exportDaten = {
    version: 1, quelle: 'UGOS', rechner: 'ugreen-test', erstellt: new Date().toISOString(),
    nutzer: [{ name: 'daemon', uid: UGOS.daemon, gid: 100 }, { name: 'bin', uid: UGOS.bin, gid: 100 }], gruppen: [{ name: 'admin', gid: 10, mitglieder: [] }],
    volumes: [{ mount: '/volume2', uuid: uuidA, ordner: [
      { name: 'Arbeit', uid: 0, ugacl: ugacl([[5, 0x37cf, UGOS.daemon], [6, 0x1c5, UGOS.bin], [10, 0x37cf, 10]]) },
      { name: 'Backups', uid: 0, ugacl: ugacl([[34, 0x37cf, 0xffffffff]]) },
    ] }],
  };
  await fs.writeFile(`${bau}/Arbeit/fahnas-ugos-export.json`, JSON.stringify(exportDaten));
  sh('umount', [bau]);
  sh('mount', [lvs[1], bau]);
  await fs.mkdir(`${bau}/medien/Filme`, { recursive: true }); await fs.chmod(`${bau}/medien`, 0o777);
  const inhaltB = crypto.randomBytes(200_000);
  await fs.writeFile(`${bau}/medien/Filme/film.mkv`, inhaltB); await fs.chown(`${bau}/medien/Filme/film.mkv`, UGOS.daemon, 100);
  sh('umount', [bau]);
  // „Platten umgezogen“: alles aus, wie nach dem Einbau in das neue System
  raidsStoppen(true);
  gut('UGOS-Nachbau: 2 × RAID1 → LVM → btrfs (Unterlaufwerke) / ext4, gestoppt');

  // ---- 2. FAH-NAS-Agent (nur die beteiligten Bereiche) ------------------------------------------------------------
  process.env.FAHNAS_RUN = PFADE.run;
  const { Konfig } = await import(`${WURZEL}/src/gemeinsam/konfig.js`);
  const system = await import(`${WURZEL}/src/gemeinsam/system.js`);
  const { Register } = await import(`${WURZEL}/src/agent/register.js`);
  const freigaben = await import(`${WURZEL}/src/agent/aktionen/freigaben.js`);
  const importe = await import(`${WURZEL}/src/agent/aktionen/importe.js`);
  const konfig = new Konfig(PFADE.konfig); await konfig.sicherstellen();
  await konfig.speichern('users.json', { nutzer: [{ name: 'daemon', rolle: 'nutzer', uid: uid('daemon'), gruppen: [] }, { name: 'bin', rolle: 'nutzer', uid: uid('bin'), gruppen: [] }, { name: 'sys', rolle: 'nutzer', uid: uid('sys'), gruppen: [] }], gruppen: [] });
  await konfig.speichern('shares.json', { freigaben: [] });
  const reg = new Register();
  const w = { konfig, system, pfade: PFADE, audit: { eintrag() {} }, konfigGeaendert() {} };
  const rufen = async (aktion, params = {}) => { const k = { nutzer: 'system', rolle: 'system', ip: '-' }; const { aktion: a, params: p } = reg.vorbereiten(aktion, params, k); return a.ausfuehren(p, k, w, { fortschritt() {}, abgebrochen: () => false }); };
  w.intern = rufen;
  freigaben.registriere(reg, w); importe.registriere(reg, w);

  // ---- 3. Suchen (nur lesend) -----------------------------------------------------------------------------------------
  const such = await rufen('importe.suchen');
  const volA = such.volumes.find((v) => v.uuid === uuidA); const volB = such.volumes.find((v) => v.uuid === uuidB);
  pruefe(volA && volB, 'Suchen findet beide Volumes (RAID/LVM selbst zusammengesetzt)');
  pruefe(volA?.herkunft === 'UGOS' && volA.raid?.stufe === 'raid1' && volA.platten.length === 2, 'Volume A: UGOS, RAID1 mit 2 Platten');
  pruefe(!(sh('findmnt', ['-rn', '-o', 'TARGET']).includes(`${IT}/import`)), 'Suchen hat nichts dauerhaft eingehängt');
  const ordnerA = Object.fromEntries((volA?.ordner || []).map((o) => [o.name, o]));
  pruefe(ordnerA.Arbeit?.art === 'freigabe' && ordnerA.Arbeit.unterlaufwerk === true && ordnerA['@appstore']?.art === 'intern' && ordnerA['@home']?.art === 'heim', 'Ordner richtig eingeordnet (Freigabe/Unterlaufwerk, intern, @home)');
  pruefe(volA?.ugos_export?.passt === true, 'UGOS-Export gefunden und zum Volume passend');
  pruefe(JSON.stringify(ordnerA.Arbeit?.rechte?.schreiben) === '["daemon"]' && JSON.stringify(ordnerA.Arbeit?.rechte?.lesen) === '["bin"]', 'Rechte aus UGOS vorgeschlagen (daemon schreibt, bin liest)');
  pruefe(JSON.stringify(ordnerA.Backups?.rechte?.schreiben) === '["bin","daemon","sys"]', '„Jeder“ → alle FAH-NAS-Nutzer');
  const besitzer = Object.fromEntries([...(volA?.besitzer || []), ...(volB?.besitzer || [])].map((b) => [b.uid, b.vorschlag]));
  pruefe(besitzer[UGOS.daemon] === 'daemon' && besitzer[UGOS.bin] === 'bin', 'Besitzer-Vorschlag über den Namen (alte uid 1001 → daemon)');

  // ---- 4. Übernehmen ---------------------------------------------------------------------------------------------------
  const erg = await rufen('importe.uebernehmen', {
    volumes: [
      { uuid: uuidA, ordner: [{ ordner: 'Arbeit', name: 'arbeit', lesen: ordnerA.Arbeit.rechte.lesen, schreiben: ordnerA.Arbeit.rechte.schreiben }, { ordner: 'Backups', name: 'backups', lesen: [], schreiben: ordnerA.Backups.rechte.schreiben }] },
      { uuid: uuidB, ordner: [{ ordner: 'medien', name: 'medien', lesen: ['bin'], schreiben: ['daemon'] }] },
    ],
    besitzer: { [UGOS.daemon]: 'daemon', [UGOS.bin]: 'bin' },
  });
  pruefe(erg.angelegt.length === 3 && !erg.fehler.length, `3 Freigaben übernommen${erg.fehler.length ? `: ${JSON.stringify(erg.fehler)}` : ''}`);
  const S = (n) => `${PFADE.shares}/${n}`;
  pruefe(Buffer.compare(await fs.readFile(`${S('arbeit')}/Projekt A/plan.bin`), inhaltA) === 0, 'Inhalt unverändert (btrfs)');
  pruefe(Buffer.compare(await fs.readFile(`${S('medien')}/Filme/film.mkv`), inhaltB) === 0, 'Inhalt unverändert (ext4)');
  pruefe((await fs.stat(`${S('arbeit')}/Projekt A/plan.bin`)).uid === uid('daemon'), 'Besitzer alte uid 1001 → FAH-NAS daemon (andere uid)');
  pruefe((await fs.stat(`${S('backups')}/sicherung.tar`)).uid === uid('bin'), 'Besitzer alte uid 1002 → FAH-NAS bin');
  pruefe(((await fs.stat(`${S('arbeit')}/start.sh`)).mode & 0o100) !== 0, 'Ausführbares bleibt ausführbar');
  const als = (n, ...cmd) => { try { sh('setpriv', ['--reuid', n, '--regid', n, '--clear-groups', '--', ...cmd]); return true; } catch { return false; } };
  pruefe(als('bin', 'cat', `${S('arbeit')}/Projekt A/plan.bin`) && !als('bin', 'touch', `${S('arbeit')}/neu-bin`), 'bin: Arbeit nur lesen');
  pruefe(als('daemon', 'touch', `${S('arbeit')}/neu-daemon`), 'daemon: Arbeit schreiben');
  pruefe(!als('sys', 'ls', `${S('arbeit')}`), 'sys: kein Zugriff auf Arbeit (unter UGOS stand 0777)');
  pruefe(als('sys', 'touch', `${S('backups')}/neu-sys`), '„Jeder“ schreibt in Backups');
  const mounts = sh('findmnt', ['-rn', '-o', 'TARGET']);
  pruefe(mounts.includes(`${PFADE.snapshots}/arbeit`) && !mounts.includes(`${PFADE.snapshots}/medien`), 'Schnappschuss-Ablage nur für btrfs-Unterlaufwerke');
  sh('btrfs', ['subvolume', 'snapshot', '-r', S('arbeit'), `${PFADE.snapshots}/arbeit/probe`]);
  pruefe((await fs.readdir(`${PFADE.snapshots}/arbeit/probe/Projekt A`)).includes('plan.bin'), 'Schnappschuss auf demselben Volume angelegt');
  const shares = (await konfig.laden('shares.json')).freigaben;
  pruefe(shares.find((f) => f.name === 'arbeit')?.importiert?.schnappschuesse === true && shares.find((f) => f.name === 'medien')?.importiert?.schnappschuesse === false, 'shares.json: importiert mit/ohne Schnappschüsse');

  // ---- 5. „Neustart“: alles aus, dann importe.apply --------------------------------------------------------------------
  for (const m of sh('findmnt', ['-rn', '-o', 'TARGET']).split('\n').filter((z) => z.startsWith(IT)).sort().reverse()) sh('umount', [m]);
  raidsStoppen(true);
  pruefe(!eigeneRaids().length, '„Neustart“: RAIDs gestoppt');
  await rufen('importe.apply');
  pruefe(Buffer.compare(await fs.readFile(`${S('medien')}/Filme/film.mkv`), inhaltB) === 0 && (await fs.readdir(S('arbeit'))).includes('Projekt A'), 'Nach „Neustart“ alles wieder eingehängt');

  // ---- 6. Trennen: Daten bleiben ---------------------------------------------------------------------------------------
  await rufen('importe.trennen', { uuid: uuidB });
  pruefe(!(await konfig.laden('shares.json')).freigaben.some((f) => f.name === 'medien') && !sh('findmnt', ['-rn', '-o', 'TARGET']).includes(`${PFADE.importe}/`.concat(uuidB.replace(/-/g, '').slice(0, 12))), 'Trennen: Freigabe weg, Volume ausgehängt');
  sh('mount', ['-o', 'ro', `UUID=${uuidB}`, bau]);
  pruefe(Buffer.compare(await fs.readFile(`${bau}/medien/Filme/film.mkv`), inhaltB) === 0, 'Trennen: Daten unverändert auf den Platten');
  sh('umount', [bau]);
} catch (e) {
  schlecht(`Abbruch: ${e.stack || e.message}`);
}
console.log(`\nErgebnis: ${ok} in Ordnung, ${fehler} fehlgeschlagen.`);
process.exitCode = fehler ? 1 : 0;
