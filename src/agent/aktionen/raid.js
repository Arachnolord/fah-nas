// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „raid.*“ – Speicherverbünde aus zusätzlichen internen Platten (mdadm RAID 0/1/5/6/10 + btrfs). Ein Verbund
// hängt unter /data/shares/<name> und ist eine Freigabe (verbund:true) mit Rechten wie eine interne. Wahrheit: raid.json;
// der Einhängepunkt ist im ausgehängten Zustand unveränderlich (chattr +i), damit nie etwas auf die Systemplatte darunter
// geschrieben wird. Meldung bei Plattenausfall und nach dem Wiederaufbau.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import { plattenIstSystem } from '../laufwerke/erkennen.js';
import { ansichtenLoesen } from './protokolle.js';
import * as r from '../raid/regeln.js';

export const DATEI = 'raid.json';
const TAKT_MS = 60_000;
const OPTIONEN = 'noatime,compress=zstd:1';
const mdadmConfPfad = () => process.env.FAHNAS_MDADM_CONF || '/etc/mdadm/mdadm.conf';
const sharesPfad = (w) => (w.pfade && w.pfade.shares) || PFADE.shares;
const snapPfad = (w, name) => path.join((w.pfade && w.pfade.snapshots) || PFADE.snapshots, name);
const laufPfad = (w) => (w.pfade && w.pfade.run) || PFADE.run || '/run/fahnas';

const laden = async (w) => { const d = await w.konfig.laden(DATEI, null); return { version: 1, verbuende: Array.isArray(d && d.verbuende) ? d.verbuende : [] }; };
const textVon = async (w, prog, args, o = {}) => { try { return String((await w.system.ausfuehren(prog, args, { zeitlimit_ms: 60_000, ...o })).stdout || ''); } catch { return ''; } };

export async function plattenLesen(w) {
  const json = JSON.parse(await textVon(w, 'lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINT,MOUNTPOINTS,LABEL,ROTA']) || '{}');
  return r.plattenAuswerten(json, { systemPruefen: plattenIstSystem });
}

async function eingehaengt(w, pfad) {
  try { const r2 = await w.system.ausfuehren('findmnt', ['-n', '-o', 'TARGET', '--mountpoint', pfad], { erlaubteCodes: [0, 1], zeitlimit_ms: 10_000 }); return String(r2.stdout).trim() === pfad; } catch { return false; }
}

async function platz(w, pfad) {
  try {
    const t = String((await w.system.ausfuehren('df', ['-B1', '--output=size,avail', pfad], { zeitlimit_ms: 10_000 })).stdout).trim().split('\n').pop().trim().split(/\s+/);
    return { gesamt: Number(t[0]), frei: Number(t[1]) };
  } catch { return null; }
}

/** Zustand eines Verbunds (mdadm --detail + /proc/mdstat + Einhängung). */
async function zustand(w, v) {
  const md = r.MD_PFAD(v.name);
  const detail = r.detailParsen(await textVon(w, 'mdadm', ['--detail', md]));
  let mdName = null;
  try { mdName = path.basename(await fs.realpath(md)); } catch { /* nicht zusammengesetzt */ }
  const mdstat = mdName ? r.mdstatParsen(await fs.readFile(process.env.FAHNAS_MDSTAT || '/proc/mdstat', 'utf8').catch(() => ''))[mdName] || null : null;
  const ziel = path.join(sharesPfad(w), v.name);
  const drin = await eingehaengt(w, ziel);
  let bewertung = r.zustandBewerten(detail, mdstat);
  // mdadm baut ein neues RAID 5 als „Wiederaufbau“ auf die letzte Platte auf – das ist der erste Abgleich, kein Ausfall
  if (v.erstabgleich && bewertung === 'wiederaufbau' && !detail.defekt) bewertung = 'ok';
  // Erweitern: mdadm baut um (reshape) – kein Ausfall
  if (mdstat && mdstat.fortschritt && mdstat.fortschritt.art === 'reshape' && !detail.defekt) bewertung = 'umbau';
  return {
    name: v.name, stufe: v.stufe, zustand: bewertung, md: mdName, detail_zustand: detail.zustand, aktiv: detail.aktiv, gesamt: detail.gesamt,
    fortschritt: mdstat && mdstat.fortschritt ? mdstat.fortschritt : null, geraete: detail.geraete, eingehaengt: drin, platz: drin ? await platz(w, ziel) : null,
    platten: v.platten, erstellt: v.erstellt, schnappschuesse: v.layout === 2, wachstum: !!v.wachstum, nutzgroesse: detail.nutzgroesse,
  };
}

async function confSchreiben(w, verbuende) {
  const zeilen = [];
  for (const v of verbuende) { const z = (await textVon(w, 'mdadm', ['--detail', '--brief', r.MD_PFAD(v.name)])).trim().replace(/\s+spares=\d+/, ''); if (z) zeilen.push(z); } // spares= nur Momentaufnahme (erster Abgleich)
  const p = mdadmConfPfad();
  const alt = await fs.readFile(p, 'utf8').catch(() => '');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, r.mdadmConfBlock(alt, zeilen));
}

/** Einhängepunkt sperren (unveränderlich, solange nichts eingehängt ist) und Verbund einhängen. */
async function einhaengen(w, v) {
  const quelle = v.fs_uuid ? `UUID=${v.fs_uuid}` : r.MD_PFAD(v.name);
  // Aufbau 2 (13.0.x+): Unterlaufwerk „daten“ = Freigabe, „schnappschuesse“ unter /data/.snapshots/<name> – so liegen die
  // Schnappschüsse auf demselben Dateisystem und das Schnappschuss-Modul arbeitet wie bei internen Freigaben
  const teile = [[path.join(sharesPfad(w), v.name), v.layout === 2 ? 'daten' : null]];
  if (v.layout === 2) teile.push([snapPfad(w, v.name), 'schnappschuesse']);
  for (const [ziel, subvol] of teile) {
    if (await eingehaengt(w, ziel)) continue;
    await fs.mkdir(ziel, { recursive: true, mode: 0o755 });
    try { await w.system.ausfuehren('chattr', ['+i', ziel]); } catch { /* Dateisystem ohne Attribute */ }
    await w.system.ausfuehren('mount', ['-o', subvol ? `${OPTIONEN},subvol=${subvol}` : OPTIONEN, quelle, ziel], { zeitlimit_ms: 120_000 });
  }
  return true;
}

/** Neues Dateisystem in Unterlaufwerke teilen (oberste Ebene kurz einhängen). */
async function unterlaufwerkeAnlegen(w, v) {
  const tmp = path.join(laufPfad(w), `raid-${v.name}`);
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  await w.system.ausfuehren('mount', ['-o', 'noatime', r.MD_PFAD(v.name), tmp], { zeitlimit_ms: 120_000 });
  try {
    for (const s of ['daten', 'schnappschuesse']) await w.system.ausfuehren('btrfs', ['subvolume', 'create', path.join(tmp, s)]);
  } finally {
    try { await w.system.ausfuehren('umount', [tmp], { zeitlimit_ms: 60_000 }); } catch { /* egal */ }
    try { await fs.rmdir(tmp); } catch { /* egal */ }
  }
}

/** Beide Einhängungen lösen (Schnappschüsse zuerst); Ansichten (SFTP/DLNA) vorher freigeben. */
async function aushaengen(w, v, { streng = false } = {}) {
  const ziel = path.join(sharesPfad(w), v.name);
  await ansichtenLoesen(w, ziel);
  for (const z of [snapPfad(w, v.name), ziel]) {
    if (!(await eingehaengt(w, z))) continue;
    try { await w.system.ausfuehren('umount', [z], { zeitlimit_ms: 60_000 }); } catch (e) { if (streng) throw e; }
  }
}

async function aufraeumen(w, v, mitglieder) {
  const ziel = path.join(sharesPfad(w), v.name);
  await aushaengen(w, v);
  try { await w.system.ausfuehren('mdadm', ['--stop', r.MD_PFAD(v.name)]); } catch (e) {
    if (!/does not appear to be an md device|No such file|not active|cannot open/i.test(String(FahnasFehler.aus(e).details?.ausgabe || e.message))) return false; // läuft noch → Platten NICHT leeren
  }
  for (const m of mitglieder) { try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', m]); } catch { /* egal */ } try { await w.system.ausfuehren('wipefs', ['-a', m]); } catch { /* egal */ } }
  for (const z of [ziel, snapPfad(w, v.name)]) {
    try { await w.system.ausfuehren('chattr', ['-i', z]); } catch { /* egal */ }
    try { await fs.rmdir(z); } catch { /* nicht leer oder weg */ }
  }
  return true;
}

const S_NAME = { typ: 'string', pflicht: true, max: 32, muster: r.NAME, hinweis: 'Ungültiger Name' };

export function registriere(reg, w) {
  reg.aktion('raid.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Speicherverbünde mit Zustand und wählbare Platten',
    ausfuehren: async () => {
      const d = await laden(w);
      const verbuende = [];
      const platten = await plattenLesen(w);
      for (const v of d.verbuende) {
        const z = await zustand(w, v);
        // „größere Platten nutzen“ lohnt, wenn alle Mitglieder deutlich größer sind als der genutzte Teil
        const groessen = z.geraete.filter((g) => g.pfad && /active|sync/.test(g.rolle)).map((g) => (platten.find((pl) => pl.pfad === g.pfad) || {}).groesse || 0);
        z.vergroesserbar = z.zustand === 'ok' && !z.fortschritt && v.stufe !== 'raid0' && groessen.length > 0 && !groessen.includes(0) && r.vergroesserbar(z.nutzgroesse, groessen);
        verbuende.push(z);
      }
      return { verbuende, platten, stufen: Object.fromEntries(Object.entries(r.STUFEN).map(([k, s]) => [k, { min: s.min, gerade: !!s.gerade }])) };
    },
  });

  reg.aktion('raid.anlegen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Speicherverbund aus Platten anlegen (alle Daten auf ihnen werden gelöscht)',
    schema: { name: S_NAME, stufe: { typ: 'string', pflicht: true, werte: Object.keys(r.STUFEN) }, platten: { typ: 'array', pflicht: true, max: 16, elemente: { typ: 'string', max: 64 } }, bestaetigung: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p, k, _w, aufgabe) => {
      await paketeSicherstellen(w.system, ['mdadm'], { fortschritt: (t) => aufgabe?.fortschritt(0.05, t), zweck: 'Speicherverbünde' });
      const d = await laden(w);
      const freigaben = ((await w.konfig.laden('shares.json', { freigaben: [] }))?.freigaben || []).map((f) => f.name);
      const v = r.verbundNormal(p, { platten: await plattenLesen(w), belegt: [...freigaben, ...d.verbuende.map((x) => x.name), 'docker'] });
      if (p.bestaetigung !== v.name) throw new FahnasFehler('E_PARAMS', 'Zur Sicherheit bitte den Namen des Verbunds zur Bestätigung eintippen', { feld: 'bestaetigung' });
      const mitglieder = v.platten.map((x) => x.pfad);
      try {
        aufgabe?.fortschritt(0.15, 'Platten werden geleert');
        for (const m of mitglieder) { try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', m]); } catch { /* keine alten Metadaten */ } await w.system.ausfuehren('wipefs', ['-a', m]); }
        aufgabe?.fortschritt(0.3, 'Verbund wird angelegt');
        await w.system.ausfuehren('mdadm', r.anlegenArgumente(v), { eingabe: 'y\n', zeitlimit_ms: 120_000 });
        try { await w.system.ausfuehren('udevadm', ['settle', '--timeout=20']); } catch { /* egal */ }
        aufgabe?.fortschritt(0.5, 'Dateisystem (btrfs) wird angelegt');
        await w.system.ausfuehren('mkfs.btrfs', ['-f', '-L', r.FS_LABEL(v.name), r.MD_PFAD(v.name)], { zeitlimit_ms: 300_000 });
        try { await w.system.ausfuehren('udevadm', ['settle', '--timeout=20']); } catch { /* egal */ }
        await unterlaufwerkeAnlegen(w, v);
        const fsUuid = (await textVon(w, 'blkid', ['-s', 'UUID', '-o', 'value', r.MD_PFAD(v.name)])).trim();
        const mdUuid = r.detailParsen(await textVon(w, 'mdadm', ['--detail', r.MD_PFAD(v.name)])).uuid;
        const eintrag = { ...v, fs_uuid: fsUuid, md_uuid: mdUuid, erstellt: new Date().toISOString(), erstabgleich: true, layout: 2 };
        aufgabe?.fortschritt(0.65, 'Verbund wird eingehängt');
        await einhaengen(w, eintrag);
        await w.konfig.aendern(DATEI, (roh) => ({ version: 1, verbuende: [...((roh && roh.verbuende) || []).filter((x) => x.name !== v.name), eintrag] }), { version: 1, verbuende: [] });
        await confSchreiben(w, (await laden(w)).verbuende);
        aufgabe?.fortschritt(0.8, 'Freigabe wird angelegt');
        await w.intern('freigaben.anlegen', { name: v.name, beschreibung: `Speicherverbund ${v.stufe.toUpperCase()}`, verbund: true, schreiben: k && k.nutzer && k.nutzer !== 'system' ? [k.nutzer] : [] });
      } catch (e) {
        await aufraeumen(w, v, mitglieder);
        await w.konfig.aendern(DATEI, (roh) => ({ version: 1, verbuende: ((roh && roh.verbuende) || []).filter((x) => x.name !== v.name) }), { version: 1, verbuende: [] });
        const f = FahnasFehler.aus(e);
        throw new FahnasFehler(f.code === 'E_UNBEKANNT' ? 'E_SYSTEM' : f.code, `Verbund ließ sich nicht anlegen: ${String(f.details?.ausgabe || f.message).trim().split('\n').filter(Boolean).pop()}`, { ausgabe: f.details?.ausgabe });
      }
      w.konfigGeaendert?.('raid');
      aufgabe?.fortschritt(1, 'Fertig – der erste Abgleich läuft im Hintergrund');
      return zustand(w, (await laden(w)).verbuende.find((x) => x.name === v.name));
    },
  });

  const S_PLATTE = { typ: 'string', pflicht: true, max: 64 };
  async function verbundHolen(name) {
    const v = (await laden(w)).verbuende.find((x) => x.name === name);
    if (!v) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Verbund „${name}“ gibt es nicht`, { feld: 'name' });
    return v;
  }
  async function plattePruefen(name, v) {
    const p = (await plattenLesen(w)).find((x) => x.name === name);
    if (!p) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Platte ${name} gibt es nicht`, { feld: 'neu' });
    if (p.grund) throw new FahnasFehler('E_PARAMS', `Platte ${name} ist nicht wählbar (${p.grund})`, { feld: 'neu' });
    const kleinste = Math.min(...v.platten.map((x) => x.groesse || Infinity));
    if (Number.isFinite(kleinste) && p.groesse < kleinste) throw new FahnasFehler('E_PARAMS', `Platte ${name} ist kleiner als die übrigen Platten des Verbunds`, { feld: 'neu' });
    return p;
  }

  reg.aktion('raid.platte_ersetzen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Ausgefallene Platte durch eine neue ersetzen (Wiederaufbau startet)',
    schema: { name: S_NAME, alt: { typ: 'string', max: 64 }, neu: S_PLATTE },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const v = await verbundHolen(p.name);
      if (v.stufe === 'raid0') throw new FahnasFehler('E_PARAMS', 'RAID 0 hat keine Ausfallsicherheit – eine Platte lässt sich nicht ersetzen');
      const neu = await plattePruefen(p.neu, v);
      const md = r.MD_PFAD(v.name);
      if (p.alt) {
        aufgabe?.fortschritt(0.2, 'Alte Platte wird entfernt');
        const altPfad = `/dev/${String(p.alt).replace(/^\/dev\//, '')}`;
        try { await w.system.ausfuehren('mdadm', ['--manage', md, '--fail', altPfad]); } catch { /* schon ausgefallen */ }
        try { await w.system.ausfuehren('mdadm', ['--manage', md, '--remove', altPfad]); } catch { /* schon entfernt */ }
        try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', altPfad]); } catch { /* Platte tot oder schon gezogen */ } // sonst beim Start als altes Mitglied erkannt
      }
      aufgabe?.fortschritt(0.5, 'Neue Platte wird aufgenommen');
      try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', neu.pfad]); } catch { /* egal */ }
      await w.system.ausfuehren('wipefs', ['-a', neu.pfad]);
      await w.system.ausfuehren('mdadm', ['--manage', md, '--add', neu.pfad]);
      await w.konfig.aendern(DATEI, (roh) => {
        const d = { version: 1, verbuende: (roh && roh.verbuende) || [] };
        const x = d.verbuende.find((y) => y.name === v.name);
        x.platten = [...x.platten.filter((y) => !p.alt || y.name !== String(p.alt).replace(/^\/dev\//, '')), { name: neu.name, pfad: neu.pfad, groesse: neu.groesse, modell: neu.modell, seriennummer: neu.seriennummer }];
        return d;
      }, { version: 1, verbuende: [] });
      await confSchreiben(w, (await laden(w)).verbuende);
      w.konfigGeaendert?.('raid');
      return zustand(w, await verbundHolen(v.name));
    },
  });

  reg.aktion('raid.ersatz_hinzufuegen', {
    rolle: 'admin', beschreibung: 'Ersatzplatte hinzufügen (springt bei einem Ausfall automatisch ein)',
    schema: { name: S_NAME, neu: S_PLATTE },
    ausfuehren: async (p) => {
      const v = await verbundHolen(p.name);
      if (v.stufe === 'raid0') throw new FahnasFehler('E_PARAMS', 'RAID 0 kann keine Ersatzplatte nutzen');
      const neu = await plattePruefen(p.neu, v);
      try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', neu.pfad]); } catch { /* egal */ }
      await w.system.ausfuehren('wipefs', ['-a', neu.pfad]);
      await w.system.ausfuehren('mdadm', ['--manage', r.MD_PFAD(v.name), '--add-spare', neu.pfad]);
      await w.konfig.aendern(DATEI, (roh) => { const d = { version: 1, verbuende: (roh && roh.verbuende) || [] }; d.verbuende.find((y) => y.name === v.name).platten.push({ name: neu.name, pfad: neu.pfad, groesse: neu.groesse, modell: neu.modell, seriennummer: neu.seriennummer, ersatz: true }); return d; }, { version: 1, verbuende: [] });
      await confSchreiben(w, (await laden(w)).verbuende);
      w.konfigGeaendert?.('raid');
      return zustand(w, await verbundHolen(v.name));
    },
  });

  // ---- Erweitern (Betreiber 12.10.2026: „Speicherverbund erweitern“) ---------------------------------------------
  async function bereitZumUmbau(v) {
    const z = await zustand(w, v);
    if (z.zustand !== 'ok' || z.fortschritt) throw new FahnasFehler('E_BELEGT', 'Der Verbund muss in Ordnung sein und darf gerade nicht abgleichen, prüfen oder umbauen', { feld: 'name' });
    return r.detailParsen(await textVon(w, 'mdadm', ['--detail', r.MD_PFAD(v.name)]));
  }
  async function wachstumMerken(v, aenderung) {
    await w.konfig.aendern(DATEI, (roh) => {
      const d = { version: 1, verbuende: (roh && roh.verbuende) || [] };
      const x = d.verbuende.find((y) => y.name === v.name);
      Object.assign(x, aenderung(x));
      return d;
    }, { version: 1, verbuende: [] });
    await confSchreiben(w, (await laden(w)).verbuende);
    w.konfigGeaendert?.('raid');
  }

  reg.aktion('raid.erweitern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Platten zu einem Verbund hinzufügen (RAID 1 → RAID 5 möglich); der Umbau läuft danach im Hintergrund',
    schema: { name: S_NAME, platten: { typ: 'array', pflicht: true, max: 15, elemente: { typ: 'string', max: 64 } }, stufe: { typ: 'string', werte: ['raid1', 'raid5', 'raid6'] }, bestaetigung: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const v = await verbundHolen(p.name);
      const detail = await bereitZumUmbau(v);
      const neue = [];
      for (const n of [...new Set(p.platten)]) neue.push(await plattePruefen(n, v));
      const plan = r.erweiterungPruefen(v, { gesamt: detail.gesamt, neu: neue.length, ziel: p.stufe || v.stufe });
      if (p.bestaetigung !== v.name) throw new FahnasFehler('E_PARAMS', 'Zur Sicherheit bitte den Namen des Verbunds zur Bestätigung eintippen', { feld: 'bestaetigung' });
      const md = r.MD_PFAD(v.name);
      // Eine interne Bitmap verhindert bei manchen mdadm-Versionen den Umbau – vorher weg, danach wieder an
      let bitmapWeg = false;
      if (detail.bitmap && v.stufe !== 'raid1') { try { await w.system.ausfuehren('mdadm', ['--grow', md, '--bitmap=none']); bitmapWeg = true; } catch { /* geht auch mit */ } }
      if (plan.umbau) { aufgabe?.fortschritt(0.2, 'Verbund wird zu RAID 5 umgestellt'); if (detail.bitmap && !bitmapWeg) { try { await w.system.ausfuehren('mdadm', ['--grow', md, '--bitmap=none']); bitmapWeg = true; } catch { /* egal */ } } await w.system.ausfuehren('mdadm', ['--grow', md, '--level=5'], { zeitlimit_ms: 120_000 }); }
      aufgabe?.fortschritt(0.4, 'Neue Platten werden aufgenommen');
      for (const n of neue) {
        try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', n.pfad]); } catch { /* egal */ }
        await w.system.ausfuehren('wipefs', ['-a', n.pfad]);
        await w.system.ausfuehren('mdadm', ['--manage', md, '--add', n.pfad]);
      }
      aufgabe?.fortschritt(0.7, 'Umbau wird gestartet');
      try { await w.system.ausfuehren('mdadm', ['--grow', md, `--raid-devices=${plan.gesamt}`], { zeitlimit_ms: 120_000 }); } catch (e) {
        if (bitmapWeg) { try { await w.system.ausfuehren('mdadm', ['--grow', md, '--bitmap=internal']); } catch { /* egal */ } }
        throw new FahnasFehler('E_SYSTEM', `Umbau ließ sich nicht starten: ${String(FahnasFehler.aus(e).details?.ausgabe || e.message).trim().split('\n').pop()} – die neuen Platten stehen als Ersatz bereit`, { ausgabe: FahnasFehler.aus(e).details?.ausgabe });
      }
      await wachstumMerken(v, (x) => ({
        stufe: plan.ziel, wachstum: { seit: new Date().toISOString(), bitmap: bitmapWeg },
        platten: [...x.platten, ...neue.map((n) => ({ name: n.name, pfad: n.pfad, groesse: n.groesse, modell: n.modell, seriennummer: n.seriennummer }))],
      }));
      aufgabe?.fortschritt(1, 'Umbau läuft im Hintergrund – der Platz wächst, sobald er fertig ist');
      return zustand(w, await verbundHolen(v.name));
    },
  });

  reg.aktion('raid.vergroessern', {
    rolle: 'admin', beschreibung: 'Nach dem Tausch gegen größere Platten den zusätzlichen Platz nutzen',
    schema: { name: S_NAME },
    ausfuehren: async (p) => {
      const v = await verbundHolen(p.name);
      if (v.stufe === 'raid0') throw new FahnasFehler('E_PARAMS', 'RAID 0 lässt sich hier nicht vergrößern');
      await bereitZumUmbau(v);
      await w.system.ausfuehren('mdadm', ['--grow', r.MD_PFAD(v.name), '--size=max'], { zeitlimit_ms: 120_000 });
      await wachstumMerken(v, () => ({ wachstum: { seit: new Date().toISOString(), bitmap: false } }));
      return zustand(w, await verbundHolen(v.name));
    },
  });

  reg.aktion('raid.pruefen', {
    rolle: 'admin', beschreibung: 'Datenprüfung starten (liest alle Platten und vergleicht – läuft im Hintergrund)',
    schema: { name: S_NAME },
    ausfuehren: async (p) => {
      const v = await verbundHolen(p.name);
      if (v.stufe === 'raid0') throw new FahnasFehler('E_PARAMS', 'RAID 0 hat keine Prüfsummen zum Vergleichen');
      const md = path.basename(await fs.realpath(r.MD_PFAD(v.name)));
      await fs.writeFile(path.join(process.env.FAHNAS_SYS_BLOCK || '/sys/block', md, 'md', 'sync_action'), 'check\n');
      return zustand(w, v);
    },
  });

  reg.aktion('raid.loeschen', {
    rolle: 'admin', aufgabe: true, beschreibung: 'Speicherverbund samt allen Daten löschen',
    schema: { name: S_NAME, bestaetigung: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const v = await verbundHolen(p.name);
      if (p.bestaetigung !== v.name) throw new FahnasFehler('E_PARAMS', 'Zur Sicherheit bitte den Namen des Verbunds zur Bestätigung eintippen', { feld: 'bestaetigung' });
      const detail = r.detailParsen(await textVon(w, 'mdadm', ['--detail', r.MD_PFAD(v.name)]));
      const mitglieder = [...new Set([...detail.geraete.map((g) => g.pfad).filter(Boolean), ...v.platten.map((x) => x.pfad)])];
      aufgabe?.fortschritt(0.2, 'Freigabe wird entfernt');
      try { await w.intern('freigaben.loeschen', { name: v.name, daten: 'behalten', mitVerbund: true }); } catch (e) { if (FahnasFehler.aus(e).code !== 'E_NICHT_GEFUNDEN') throw e; }
      aufgabe?.fortschritt(0.4, 'Verbund wird ausgehängt');
      const ziel = path.join(sharesPfad(w), v.name);
      if (await eingehaengt(w, ziel) || await eingehaengt(w, snapPfad(w, v.name))) {
        try { await aushaengen(w, v, { streng: true }); } catch (e) { // SFTP/WebDAV/DLNA-Ansichten löst aushaengen() vorher
          throw new FahnasFehler('E_BELEGT', 'Der Verbund wird noch benutzt (offene Dateien, App oder Freigabe) – bitte schließen und erneut versuchen', { ausgabe: FahnasFehler.aus(e).details?.ausgabe });
        }
      }
      aufgabe?.fortschritt(0.6, 'Platten werden freigegeben');
      if (!(await aufraeumen(w, v, mitglieder))) throw new FahnasFehler('E_BELEGT', 'Der Verbund ließ sich nicht stoppen – er wird noch benutzt. Bitte offene Dateien/Apps schließen und erneut löschen');
      await w.konfig.aendern(DATEI, (roh) => ({ version: 1, verbuende: ((roh && roh.verbuende) || []).filter((x) => x.name !== v.name) }), { version: 1, verbuende: [] });
      await confSchreiben(w, (await laden(w)).verbuende);
      w.konfigGeaendert?.('raid');
      return { geloescht: v.name };
    },
  });

  reg.aktion('raid.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Verbünde zusammensetzen und einhängen (Start, Import)',
    ausfuehren: async () => {
      const d = await laden(w);
      if (!d.verbuende.length) return false;
      try { await w.system.ausfuehren('mdadm', ['--assemble', '--scan'], { erlaubteCodes: [0, 1, 2], zeitlimit_ms: 120_000 }); } catch { /* schon zusammengesetzt */ }
      const fehler = [];
      for (const v of d.verbuende) { try { await einhaengen(w, v); } catch (e) { fehler.push(`${v.name}: ${FahnasFehler.aus(e).message}`); } }
      if (fehler.length) throw new FahnasFehler('E_SYSTEM', `Verbund nicht eingehängt: ${fehler.join('; ')}`);
      return true;
    },
  });
}

// ---- Takt: Ausfall und Wiederaufbau melden ---------------------------------------------------------------------------
let takt = null;
const gemeldet = new Map();
/** Nach dem Umbau/Vergrößern: btrfs auf die neue Größe ziehen, Bitmap wieder an, Meldung. */
async function wachstumAbschliessen(w, v, z) {
  const md = r.MD_PFAD(v.name);
  if (v.wachstum.bitmap) { try { await w.system.ausfuehren('mdadm', ['--grow', md, '--bitmap=internal']); } catch { /* ohne Bitmap weiter */ } }
  const ziel = path.join(sharesPfad(w), v.name);
  if (z.eingehaengt) await w.system.ausfuehren('btrfs', ['filesystem', 'resize', 'max', ziel], { zeitlimit_ms: 120_000 });
  await w.konfig.aendern(DATEI, (roh) => ({ version: 1, verbuende: ((roh && roh.verbuende) || []).map((x) => (x.name === v.name ? (({ wachstum, ...rest }) => rest)(x) : x)) }), { version: 1, verbuende: [] });
  await confSchreiben(w, (await laden(w)).verbuende);
  const p = z.eingehaengt ? await platz(w, ziel) : null;
  await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: 'info', titel: `RAID „${v.name}“ erweitert`, text: `Der Umbau des Verbunds „${v.name}“ ist fertig${p ? ` – jetzt ${Math.round(p.gesamt / 1e9)} GB` : ''}.`, schluessel: `raid_${v.name}_gewachsen_${v.wachstum.seit}` }).catch(() => {});
  w.konfigGeaendert?.('raid');
}

export async function taktPruefen(w) {
  const d = await laden(w);
  for (const v of d.verbuende) {
    const z = await zustand(w, v);
    if (v.wachstum && z.zustand === 'ok' && !z.fortschritt) { try { await wachstumAbschliessen(w, v, z); } catch (e) { process.stderr.write(`[raid] Erweitern abschließen (${v.name}): ${e.message}\n`); } }
    const vorher = gemeldet.get(v.name) || 'ok';
    const schlecht = z.zustand === 'beeintraechtigt' || z.zustand === 'ausgefallen';
    if (schlecht && vorher !== z.zustand) {
      const defekt = z.geraete.filter((g) => g.pfad && /faulty/.test(g.rolle)).map((g) => g.pfad).join(', ');
      await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: 'fehler', titel: `RAID „${v.name}“ ${z.zustand === 'ausgefallen' ? 'ausgefallen' : 'beeinträchtigt'}`,
        text: z.zustand === 'ausgefallen' ? `Der Verbund „${v.name}“ (${v.stufe.toUpperCase()}) ist ausgefallen.` : `Im Verbund „${v.name}“ (${v.stufe.toUpperCase()}) fehlt eine Platte${defekt ? ` (${defekt})` : ''}. Die Daten sind noch da, aber ohne Reserve – bitte unter Laufwerke die Platte ersetzen.`,
        schluessel: `raid_${v.name}_${z.zustand}` }).catch(() => {});
      gemeldet.set(v.name, z.zustand);
    } else if (z.zustand === 'ok' && vorher !== 'ok') {
      await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: 'info', titel: `RAID „${v.name}“ wieder in Ordnung`, text: `Der Verbund „${v.name}“ ist wieder vollständig.`, schluessel: `raid_${v.name}_ok_${Date.now()}` }).catch(() => {});
      gemeldet.set(v.name, 'ok');
    } // Wiederaufbau nach einem Ausfall: bleibt „beeinträchtigt“ gemerkt, bis er fertig ist → dann „wieder in Ordnung“
    if (v.erstabgleich && z.zustand === 'ok' && !z.fortschritt) {
      await w.konfig.aendern(DATEI, (roh) => ({ version: 1, verbuende: ((roh && roh.verbuende) || []).map((x) => (x.name === v.name ? (({ erstabgleich, ...rest }) => rest)(x) : x)) }), { version: 1, verbuende: [] });
    }
  }
}
export async function starten(w) { takt = setInterval(() => { taktPruefen(w).catch(() => {}); }, TAKT_MS); takt.unref?.(); }
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
export const _test = { gemeldet };
