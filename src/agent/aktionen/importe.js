// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „importe.*“ (Betreiber 19.10.2026: „bau den Import-Assistenten“, Umstieg von UGOS): Speicher eines anderen NAS
// ohne Datenverlust übernehmen. Suchen hängt fremde Volumes nur lesend ein und liest Ordner, Unterlaufwerke und @home;
// Übernehmen hängt das Volume dauerhaft unter /data/import/<kurz> ein, macht jeden gewählten Ordner zur Freigabe
// (Bind-Mount, je Ordner eine Freigabe – Betreiber-Wahl) und überträgt die FAH-NAS-Rechte auf alle Dateien. Nie formatieren,
// nie partitionieren; Trennen hängt nur aus. Wahrheit der Volumes: importe.json.
// Dazu (0.25.0): alter Pfad (/volume1 …) für Compose-Dateien und Skripte, Unterordner-Rechte aus dem UGOS-Export als
// Ordnerrechte, persönliche Ordner (@home/<name>) als persönliche FAH-NAS-Ordner (Bind-Mount, siehe heim.js).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { paketeSicherstellen } from '../helfer/pakete.js';
import { volumesAusLsblk, ordnerArt, herkunftVon, freigabenameVorschlag, besitzerVorschlag, kurzVon, rechteVorschlag, ordnerrechteVorschlag, alterPfadVorschlag, volumeName, EXPORT_DATEI } from '../import/erkennen.js';
import { speicherAktivieren, probeEinhaengen, volumeEinhaengen, volumePfad, ordnerEinhaengen, freigabeLoesen, volumeAushaengen, importWurzel, alterPfadEinhaengen, alterPfadLoesen, alterPfadZiel, heimLoesen, ALTER_PFAD } from '../import/einhaengen.js';
import { freigabeImportieren, rechteAnwenden } from './freigaben.js';
import { heimPfad } from './heim.js';
import { bereichAbgleichen } from '../freigaben/ordnerrechte-abgleich.js';
import { eingehaengt } from '../render/samba.js';
import { raidDetails, ersatzPlan, fremdeSpuren, partitionPfad } from '../import/raid.js';
import { plattenLesen } from './raid.js';

const DATEI = 'importe.json';
const TAKT_MS = 60_000;
const sysBlock = () => process.env.FAHNAS_SYS_BLOCK || '/sys/block';
const LSBLK = ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,MOUNTPOINTS,MODEL,SERIAL,TRAN'];
const MAX_ORDNER = 500;
// Persönlicher Ordner: nur der Nutzer (wie ein neu angelegter persönlicher Ordner, 0700)
const HEIM_SOLL = Object.freeze({
  ordner: ['user::rwx', 'group::---', 'other::---'], datei: ['user::rw-', 'group::---', 'other::---'],
  dateiX: ['user::rwx', 'group::---', 'other::---'], eingeschraenktUids: new Set(),
});

async function laden(w) {
  const d = await w.konfig.laden(DATEI, null);
  return { volumes: Array.isArray(d?.volumes) ? d.volumes : [] };
}

/** UUIDs, die FAH-NAS schon selbst verwaltet: eigene Speicherverbünde (raid.json). */
async function eigeneUuids(w) {
  const raid = (await w.konfig.laden('raid.json', null)) || {};
  return new Set((raid.verbuende || []).map((v) => v.fs_uuid).filter(Boolean));
}

async function volumesLesen(w) {
  const { stdout } = await w.system.ausfuehren('lsblk', LSBLK, { zeitlimit_ms: 30_000 });
  return volumesAusLsblk(JSON.parse(stdout), { ausschliessen: await eigeneUuids(w), importWurzel: importWurzel(w) });
}

/** Zustand eines RAIDs aus /sys (kein mdadm-Aufruf): {degraded, sync} oder null. */
async function raidZustand(geraet) {
  const name = path.basename(String(geraet || ''));
  if (!/^md\d+$/.test(name)) return null;
  const lies = async (d) => String(await fs.readFile(`/sys/block/${name}/md/${d}`, 'utf8').catch(() => '')).trim();
  const degraded = await lies('degraded');
  return { degraded: degraded !== '' && degraded !== '0', sync: (await lies('sync_action')) || null, zustand: (await lies('array_state')) || null };
}

/** Oberste Ebene eines (eingehängten) Volumes lesen: Ordner mit Art, Unterlaufwerk, Besitzer; @home-Konten. */
async function ebeneLesen(wurzel, fstype) {
  const eintraege = await fs.readdir(wurzel, { withFileTypes: true });
  const ordner = []; const heim = []; const uids = new Set();
  for (const e of eintraege.slice(0, MAX_ORDNER)) {
    if (!e.isDirectory()) continue;
    let st;
    try { st = await fs.lstat(path.join(wurzel, e.name)); } catch { continue; }
    const art = ordnerArt(e.name);
    ordner.push({ name: e.name, art, unterlaufwerk: fstype === 'btrfs' && st.ino === 256, uid: st.uid, app_daten: art === 'freigabe' && await appDatenDrin(path.join(wurzel, e.name), e.name) });
    if (art === 'freigabe') {
      uids.add(st.uid);
      // Besitzer eine Ebene tiefer (Dateien der Nutzer) – günstig und deckt die üblichen Konten ab
      try { for (const k of (await fs.readdir(path.join(wurzel, e.name), { withFileTypes: true })).slice(0, 200)) { try { uids.add((await fs.lstat(path.join(wurzel, e.name, k.name))).uid); } catch { /* weg */ } } } catch { /* nicht lesbar */ }
    }
    if (art === 'heim') {
      try {
        for (const h of await fs.readdir(path.join(wurzel, e.name), { withFileTypes: true })) {
          if (!h.isDirectory()) continue;
          const hs = await fs.lstat(path.join(wurzel, e.name, h.name)).catch(() => null);
          if (hs) { heim.push({ name: h.name, uid: hs.uid }); uids.add(hs.uid); }
        }
      } catch { /* nicht lesbar */ }
    }
  }
  const stat = await fs.statfs(wurzel).catch(() => null);
  return { ordner: ordner.sort((a, b) => a.name.localeCompare(b.name, 'de')), heim, uids: [...uids], groesse: stat ? stat.blocks * stat.bsize : null, frei: stat ? stat.bavail * stat.bsize : null };
}

const COMPOSE = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
/**
 * Liegen in dem Ordner Daten von Docker-Apps (Compose-Dateien im Ordner oder eine Ebene tiefer, oder er heißt „docker“)?
 * Dann gehören die Dateien Container-Konten (Postgres 999, MongoDB …) – Rechte übertragen würde die Apps zerstören.
 */
async function appDatenDrin(pfad, name) {
  if (/^docker$/i.test(name)) return true;
  try {
    const eintraege = await fs.readdir(pfad, { withFileTypes: true });
    if (eintraege.some((e) => e.isFile() && COMPOSE.has(e.name))) return true;
    for (const e of eintraege.filter((x) => x.isDirectory()).slice(0, 300)) {
      try { if ((await fs.readdir(path.join(pfad, e.name))).some((n) => COMPOSE.has(n))) return true; } catch { /* nicht lesbar */ }
    }
  } catch { /* nicht lesbar */ }
  return false;
}

/** UGOS-Export (tools/ugos-export.py) in den Freigabe-Ordnern eines eingehängten Volumes suchen → Export oder null. */
async function exportFinden(wurzel, ordner) {
  for (const o of ordner.filter((x) => x.art === 'freigabe')) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(wurzel, o.name, EXPORT_DATEI), 'utf8'));
      if (d && d.version === 1 && Array.isArray(d.volumes)) return { ...d, gefunden_in: o.name };
    } catch { /* nicht hier */ }
  }
  return null;
}

/** Ist der alte Pfad frei (nicht da, leer oder schon unser Bind-Mount)? */
async function alterPfadFrei(w, alterPfad) {
  const ziel = alterPfadZiel(w, alterPfad);
  if (await eingehaengt(w.system, ziel)) return false;
  const da = await fs.readdir(ziel).catch(() => null);
  return !da || !da.length;
}

/** Hat der Nutzer schon einen persönlichen Ordner mit Inhalt (oder einen übernommenen)? */
async function heimBelegt(w, name) {
  const pfad = heimPfad(w, name);
  if (await eingehaengt(w.system, pfad)) return true;
  const da = await fs.readdir(pfad).catch(() => null);
  return !!(da && da.length);
}

async function nutzerdaten(w) {
  const d = await w.konfig.laden('users.json', null);
  return { nutzer: Array.isArray(d?.nutzer) ? d.nutzer : [], gruppen: Array.isArray(d?.gruppen) ? d.gruppen : [] };
}

export function registriere(reg, w) {
  reg.aktion('importe.suchen', {
    rolle: 'admin', aufgabe: true, schema: {},
    beschreibung: 'Speicher eines anderen NAS suchen (RAID/LVM zusammensetzen, Volumes nur lesend ansehen) – ändert nichts',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      aufgabe?.fortschritt(0.05, 'Werkzeuge für RAID und LVM prüfen');
      await paketeSicherstellen(w.system, ['mdadm', 'lvm2'], { fortschritt: (t) => aufgabe?.fortschritt(0.1, t), zweck: 'die Übernahme' });
      aufgabe?.fortschritt(0.2, 'RAID-Verbünde und Volume-Gruppen zusammensetzen');
      await speicherAktivieren(w);
      const volumes = await volumesLesen(w);
      const shares = (await w.konfig.laden('shares.json', null))?.freigaben || [];
      const belegt = new Set(shares.map((f) => f.name));
      const nd = await nutzerdaten(w);
      const aus = [];
      let i = 0;
      for (const v of volumes) {
        aufgabe?.fortschritt(0.3 + (0.65 * i++) / Math.max(1, volumes.length), `${v.lvm?.lv || v.geraet} ansehen`);
        const eintrag = { ...v, raid_zustand: v.raid ? await raidZustand(v.raid.geraet) : null, ordner: [], heim: [], besitzer: [], herkunft: null, fehler: null };
        if (v.importiert) { aus.push(eintrag); continue; }
        let probe = null;
        try {
          probe = await probeEinhaengen(w, v.uuid, v.fstype);
          const ebene = await ebeneLesen(probe.pfad, v.fstype);
          eintrag.herkunft = herkunftVon({ vg: v.lvm?.vg, ordner: ebene.ordner.map((o) => o.name) });
          // UGOS-Export (vor dem Umstieg unter UGOS erzeugt): Rechte je Ordner und Namen der alten Konten
          const ex = await exportFinden(probe.pfad, ebene.ordner);
          const exVol = ex ? ex.volumes.find((x) => x.uuid === v.uuid) : null;
          eintrag.ugos_export = ex ? { erstellt: ex.erstellt || null, rechner: ex.rechner || null, gefunden_in: ex.gefunden_in, passt: !!exVol } : null;
          eintrag.ordner = ebene.ordner.map((o) => {
            if (o.art !== 'freigabe' && o.art !== 'heim') return o;
            const n = freigabenameVorschlag(o.art === 'heim' ? `${o.name.replace(/^@/, '')}-alt` : o.name, belegt); belegt.add(n);
            const exO = exVol ? exVol.ordner.find((x) => x.name === o.name) : null;
            const rechte = exVol ? { ...rechteVorschlag(exO?.ugacl, ex, nd), quelle: 'ugos' } : null;
            // Unterordner mit eigenen UGOS-Rechten → Ordnerrechte (nur echte Einschränkungen gegenüber der Freigabe)
            const or = rechte && exO?.unter?.length ? ordnerrechteVorschlag(rechte, exO.unter, ex, nd) : { regeln: [], hinweise: [] };
            if (rechte) rechte.hinweise = [...rechte.hinweise, ...or.hinweise];
            return { ...o, vorschlag: n, rechte, ordnerrechte: or.regeln, app_daten: o.art === 'freigabe' && o.app_daten };
          });
          eintrag.alter_pfad = alterPfadVorschlag(v.lvm || {}, exVol?.mount);
          eintrag.name = volumeName({ ...v, herkunft: eintrag.herkunft }, eintrag.alter_pfad);
          eintrag.alter_pfad_frei = eintrag.alter_pfad ? await alterPfadFrei(w, eintrag.alter_pfad) : null;
          // persönliche Ordner: gleichnamiger FAH-NAS-Nutzer als Vorschlag; schon belegter persönlicher Ordner = Konflikt
          eintrag.heim = [];
          for (const h of ebene.heim) {
            const n = nd.nutzer.find((x) => x.name === h.name || x.name === h.name.toLowerCase());
            eintrag.heim.push({ ...h, ordner: `${ebene.ordner.find((o) => o.art === 'heim')?.name || '@home'}/${h.name}`, vorschlag: n ? n.name : null });
          }
          const alteNamen = [...ebene.heim, ...(ex?.nutzer || []).map((x) => ({ name: x.name, uid: x.uid }))];
          eintrag.besitzer = besitzerVorschlag(ebene.uids, alteNamen, nd.nutzer);
          eintrag.groesse = ebene.groesse ?? v.groesse; eintrag.frei = ebene.frei;
        } catch (e) {
          eintrag.fehler = FahnasFehler.aus(e).message;
        } finally { await probe?.loesen(); }
        aus.push(eintrag);
      }
      aufgabe?.fortschritt(1, 'fertig');
      return { volumes: aus, nutzer: nd.nutzer.map((n) => ({ name: n.name, rolle: n.rolle })), gruppen: nd.gruppen.map((g) => g.name), belegt: shares.map((f) => f.name) };
    },
  });

  reg.aktion('importe.uebernehmen', {
    rolle: 'admin', aufgabe: true,
    schema: {
      volumes: { typ: 'array', pflicht: true, max: 32, elemente: { typ: 'object', felder: {
        uuid: { typ: 'string', pflicht: true, max: 64, muster: /^[0-9a-fA-F-]{8,64}$/ },
        ordner: { typ: 'array', pflicht: true, max: MAX_ORDNER, elemente: { typ: 'object', felder: {
          ordner: { typ: 'string', pflicht: true, max: 255 }, name: { typ: 'string', pflicht: true, max: 32 },
          lesen: { typ: 'array', max: 500, elemente: { typ: 'string', max: 64 } }, schreiben: { typ: 'array', max: 500, elemente: { typ: 'string', max: 64 } },
          papierkorb: { typ: 'boolean' }, rechte_lassen: { typ: 'boolean' },
          ordnerrechte: { typ: 'array', max: 200, elemente: { typ: 'object', felder: { pfad: { typ: 'string', pflicht: true, max: 4096 }, regeln: { typ: 'object', pflicht: true } } } },
        } } },
        alter_pfad: { typ: 'string', max: 16 },
        heime: { typ: 'array', max: 500, elemente: { typ: 'object', felder: { ordner: { typ: 'string', pflicht: true, max: 300 }, nutzer: { typ: 'string', pflicht: true, max: 64 } } } },
      } } },
      besitzer: { typ: 'object' },
    },
    beschreibung: 'Gewählte Ordner fremder Volumes als Freigaben übernehmen (ohne Formatieren) und Rechte übertragen',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      await speicherAktivieren(w);
      const gefunden = new Map((await volumesLesen(w)).map((v) => [v.uuid, v]));
      const nd = await nutzerdaten(w);
      // Besitzer: alte uid → FAH-NAS-Nutzer (Name) oder root; alles nicht Zugeordnete gehört danach root
      const uidVon = new Map(nd.nutzer.filter((n) => Number.isInteger(Number(n.uid))).map((n) => [n.name, Number(n.uid)]));
      const karte = new Map();
      for (const [alt, neu] of Object.entries(p.besitzer || {})) {
        const a = Number(alt);
        if (!Number.isInteger(a) || a < 0) throw new FahnasFehler('E_PARAMS', `Besitzer-Zuordnung: „${alt}“ ist keine uid`, { feld: 'besitzer' });
        if (neu === 'root') karte.set(a, 0);
        else if (uidVon.has(neu)) karte.set(a, uidVon.get(neu));
        else throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${neu}“ gibt es nicht`, { feld: 'besitzer', wert: neu });
      }
      const besitzNeu = (uid) => (uid === 0 ? null : karte.has(uid) ? karte.get(uid) : 0);
      const daten = await laden(w);
      const angelegt = []; const fehler = []; const heime = [];
      const anzahl = p.volumes.reduce((s, v) => s + v.ordner.length + (v.heime || []).length, 0) || 1;
      let schritt = 0;
      for (const auftrag of p.volumes) {
        const v = gefunden.get(auftrag.uuid);
        if (!v) { fehler.push({ volume: auftrag.uuid, meldung: 'Volume nicht (mehr) gefunden oder anderswo eingehängt' }); continue; }
        aufgabe?.fortschritt(0.02 + 0.2 * (schritt / anzahl), `${v.lvm?.lv || v.geraet} einhängen`);
        const vol = await volumeEinhaengen(w, v.uuid);
        let probeOrdner = [];
        try { probeOrdner = (await ebeneLesen(vol, v.fstype)).ordner; } catch { /* unten je Ordner geprüft */ }
        const herkunft = herkunftVon({ vg: v.lvm?.vg, ordner: probeOrdner.map((o) => o.name) });
        if (!daten.volumes.some((x) => x.uuid === v.uuid)) {
          daten.volumes.push({
            uuid: v.uuid, kurz: kurzVon(v.uuid), fstype: v.fstype, geraet: v.geraet, raid: v.raid, lvm: v.lvm, platten: v.platten, herkunft,
            bezeichnung: volumeName({ ...v, herkunft }, auftrag.alter_pfad || alterPfadVorschlag(v.lvm || {})), erstellt: new Date().toISOString(),
          });
          await w.konfig.speichern(DATEI, daten);
        }
        // Besitz-Zuordnung merken (Docker-Übernahme: Hinweise zu PUID/PGID)
        if (karte.size) {
          const besitz = Object.fromEntries([...karte].map(([alt, neu]) => [String(alt), neu]));
          await w.konfig.aendern(DATEI, (d) => { const e = (d?.volumes || []).find((x) => x.uuid === v.uuid); if (e) e.besitz = { ...(e.besitz || {}), ...besitz }; return d; }, { volumes: [] });
        }
        // alter Pfad (/volume1 …): Compose-Dateien und Skripte vom alten NAS finden ihre Ordner wieder
        if (auftrag.alter_pfad) {
          try {
            if (!ALTER_PFAD.test(auftrag.alter_pfad)) throw new FahnasFehler('E_PARAMS', `Alter Pfad „${auftrag.alter_pfad}“ ungültig (erlaubt: /volume1 … /volume99)`);
            if (daten.volumes.some((x) => x.uuid !== v.uuid && x.alter_pfad === auftrag.alter_pfad)) throw new FahnasFehler('E_BELEGT', `${auftrag.alter_pfad} gehört schon einem anderen übernommenen Volume`);
            await alterPfadEinhaengen(w, v.uuid, auftrag.alter_pfad);
            const name = volumeName({ ...v, herkunft }, auftrag.alter_pfad);
            await w.konfig.aendern(DATEI, (d) => { const e = (d?.volumes || []).find((x) => x.uuid === v.uuid); if (e) { e.alter_pfad = auftrag.alter_pfad; e.bezeichnung = name; } return d; }, { volumes: [] });
            const e = daten.volumes.find((x) => x.uuid === v.uuid); if (e) { e.alter_pfad = auftrag.alter_pfad; e.bezeichnung = name; }
          } catch (e) { fehler.push({ volume: v.uuid, meldung: `Alter Pfad: ${FahnasFehler.aus(e).message}` }); }
        }
        for (const o of auftrag.ordner) {
          schritt++;
          aufgabe?.fortschritt(0.05 + 0.3 * (schritt / anzahl), `Freigabe „${o.name}“ anlegen`);
          const info = probeOrdner.find((x) => x.name === o.ordner);
          if (!info) { fehler.push({ ordner: o.ordner, name: o.name, meldung: 'Ordner nicht gefunden' }); continue; }
          if (info.art === 'intern') { fehler.push({ ordner: o.ordner, name: o.name, meldung: 'Interner Ordner des alten Systems – wird nicht übernommen' }); continue; }
          const schnappschuesse = v.fstype === 'btrfs' && info.unterlaufwerk;
          const lassen = !!o.rechte_lassen;
          try {
            await ordnerEinhaengen(w, v.uuid, o.ordner, o.name, { schnappschuesse });
            // App-Daten: Rechte/Besitzer bleiben wie sie sind – dann auch keine Ordnerrechte (sie änderten Besitz und ACLs)
            await freigabeImportieren(w, { name: o.name, lesen: o.lesen || [], schreiben: o.schreiben || [], papierkorb: lassen ? false : o.papierkorb !== false, importiert: { volume: v.uuid, ordner: o.ordner, schnappschuesse, herkunft, ...(lassen ? { rechte_lassen: true } : {}) }, ordnerrechte: lassen ? [] : o.ordnerrechte || [] });
            angelegt.push({ name: o.name, ordner: o.ordner, schnappschuesse, rechte_lassen: lassen });
          } catch (e) {
            await freigabeLoesen(w, o.name).catch(() => {});
            fehler.push({ ordner: o.ordner, name: o.name, meldung: FahnasFehler.aus(e).message });
          }
        }
        // persönliche Ordner (@home/<name>) → persönlicher FAH-NAS-Ordner des gewählten Nutzers
        const heimOrdner = probeOrdner.find((x) => x.art === 'heim');
        for (const h of auftrag.heime || []) {
          schritt++;
          aufgabe?.fortschritt(0.05 + 0.3 * (schritt / anzahl), `Persönlichen Ordner für „${h.nutzer}“ übernehmen`);
          try {
            const n = nd.nutzer.find((x) => x.name === h.nutzer);
            if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${h.nutzer}“ gibt es nicht`);
            if (!heimOrdner || !h.ordner.startsWith(`${heimOrdner.name}/`) || h.ordner.split('/').length !== 2 || h.ordner.endsWith('/..') || h.ordner.endsWith('/.')) throw new FahnasFehler('E_PARAMS', `„${h.ordner}“ ist kein persönlicher Ordner des alten NAS`);
            if (heime.some((x) => x.nutzer === h.nutzer)) throw new FahnasFehler('E_PARAMS', `„${h.nutzer}“ ist zweimal gewählt`);
            if (await heimBelegt(w, h.nutzer)) throw new FahnasFehler('E_BELEGT', `„${h.nutzer}“ hat auf FAH-NAS schon einen persönlichen Ordner mit Inhalt – der alte wird nicht darübergelegt`);
            await w.konfig.aendern('users.json', (d) => {
              const x = (d.nutzer || []).find((y) => y.name === h.nutzer);
              if (!x) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${h.nutzer}“ gibt es nicht`);
              x.heim = { aktiv: true, groesse_gb: null, quelle: { volume: v.uuid, ordner: h.ordner } };
              return d;
            });
            await w.intern('heim.setzen', { name: h.nutzer, aktiv: true });
            heime.push({ nutzer: h.nutzer, ordner: h.ordner, uid: Number(n.uid) });
          } catch (e) {
            fehler.push({ ordner: h.ordner, name: h.nutzer, meldung: `Persönlicher Ordner: ${FahnasFehler.aus(e).message}` });
          }
        }
      }
      // Rechte auf alle vorhandenen Dateien (unter UGOS standen die Freigaben auf 0777 – „jeder darf alles“)
      const rechte = [];
      for (const [i, f] of angelegt.entries()) {
        if (f.rechte_lassen) { rechte.push({ name: f.name, unveraendert: true }); continue; }
        let gemeldet = 0;
        const basis = 0.35 + 0.63 * (i / angelegt.length);
        aufgabe?.fortschritt(basis, `Rechte in „${f.name}“ übertragen`);
        try {
          rechte.push(await rechteAnwenden(w, f.name, {
            besitzKarte: besitzNeu, abgebrochen: () => !!aufgabe?.abgebrochen(),
            fortschritt: (n) => { if (n - gemeldet >= 500) { gemeldet = n; aufgabe?.fortschritt(basis, `Rechte in „${f.name}“: ${n} Einträge`); } },
          }));
        } catch (e) { fehler.push({ name: f.name, meldung: `Rechte: ${FahnasFehler.aus(e).message}` }); }
      }
      // persönliche Ordner: alles gehört dem Nutzer, nur er hat Zugriff
      const abgleich = w.ordnerrechteAbgleich || bereichAbgleichen;
      for (const h of heime) {
        aufgabe?.fortschritt(0.98, `Persönlicher Ordner „${h.nutzer}“: Besitz übertragen`);
        try {
          const r = await abgleich(w.system, { wurzel: heimPfad(w, h.nutzer), start: '', sollFuer: () => HEIM_SOLL, besitzKarte: (uid) => (uid === h.uid ? null : h.uid), abgebrochen: () => !!aufgabe?.abgebrochen() });
          rechte.push({ name: `~${h.nutzer}`, geprueft: r.geprueft, geaendert: r.geaendert, besitz: r.besitz });
        } catch (e) { fehler.push({ name: h.nutzer, meldung: `Persönlicher Ordner, Rechte: ${FahnasFehler.aus(e).message}` }); }
      }
      w.konfigGeaendert?.('importe');
      return { angelegt, heime: heime.map((h) => ({ nutzer: h.nutzer, ordner: h.ordner })), rechte, fehler };
    },
  });

  reg.aktion('importe.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Übernommene Volumes mit Zustand (eingehängt, RAID) und ihren Freigaben',
    ausfuehren: async () => {
      const daten = await laden(w);
      if (!daten.volumes.length) return { volumes: [] };
      let aktuell = new Map();
      try { aktuell = new Map((await volumesLesen(w)).map((v) => [v.uuid, v])); } catch { /* lsblk nicht da */ }
      const shares = (await w.konfig.laden('shares.json', null))?.freigaben || [];
      const nd = await nutzerdaten(w);
      const aus = [];
      for (const v of daten.volumes) {
        const jetzt = aktuell.get(v.uuid);
        const raid = jetzt?.raid || v.raid || null;
        aus.push({
          uuid: v.uuid, bezeichnung: v.bezeichnung, herkunft: v.herkunft || null, fstype: v.fstype, erstellt: v.erstellt,
          vorhanden: !!jetzt, eingehaengt: await eingehaengt(w.system, volumePfad(w, v.uuid)),
          raid: raid ? { stufe: raid.stufe, ...(await raidZustand(raid.geraet) || {}), ...(await raidDetails(raid.geraet, sysBlock()) || {}) } : null, lvm: v.lvm || null,
          platten: (jetzt?.platten || v.platten || []).map((x) => ({ geraet: x.geraet, modell: x.modell })),
          freigaben: shares.filter((f) => f.importiert?.volume === v.uuid).map((f) => ({ name: f.name, ordner: f.importiert.ordner, schnappschuesse: !!f.importiert.schnappschuesse })),
          alter_pfad: v.alter_pfad || null, alter_pfad_aktiv: v.alter_pfad ? await eingehaengt(w.system, alterPfadZiel(w, v.alter_pfad)) : false,
          heime: nd.nutzer.filter((n) => n.heim?.quelle?.volume === v.uuid).map((n) => ({ nutzer: n.name, ordner: n.heim.quelle.ordner, aktiv: !!n.heim.aktiv })),
        });
      }
      return { volumes: aus };
    },
  });

  reg.aktion('importe.trennen', {
    rolle: 'admin', schema: { uuid: { typ: 'string', pflicht: true, max: 64 } },
    beschreibung: 'Übernommenes Volume trennen: Freigaben entfernen und aushängen – die Daten bleiben unverändert auf den Platten',
    ausfuehren: async (p) => {
      const daten = await laden(w);
      if (!daten.volumes.some((v) => v.uuid === p.uuid)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Volume ist nicht übernommen', { feld: 'uuid' });
      // übernommene Docker-Projekte, deren Compose-Dateien oder Volumes hier liegen, zuerst entfernen
      const eintragAlt = daten.volumes.find((v) => v.uuid === p.uuid);
      const apps = (await w.intern('apps.liste', {}).catch(() => [])) || [];
      const haengen = apps.filter((a) => a.uebernommen && (a.uebernommen.volume === p.uuid || (eintragAlt?.alter_pfad && (a.uebernommen.alte_pfade || []).includes(eintragAlt.alter_pfad))));
      if (haengen.length) throw new FahnasFehler('E_BELEGT', `Erst die übernommenen Apps entfernen, die dieses Volume brauchen: ${haengen.map((a) => a.name).join(', ')}`, { feld: 'uuid' });
      const orte = (await w.konfig.laden('speicherorte.json', null)) || {};
      const hier = ['docker', 'apps', 'vms'].filter((b) => orte[b]?.volume === p.uuid);
      if (hier.length) throw new FahnasFehler('E_BELEGT', `Auf diesem Volume liegen ${hier.map((b) => (b === 'docker' ? 'Docker' : b === 'apps' ? 'die Apps' : 'die VMs')).join(', ')} – erst unter Speicherorte zurück auf die Systemplatte umziehen`, { feld: 'uuid' });
      const shares = (await w.konfig.laden('shares.json', null))?.freigaben || [];
      const namen = shares.filter((f) => f.importiert?.volume === p.uuid).map((f) => f.name);
      for (const name of namen) await w.intern('freigaben.loeschen', { name, daten: 'behalten' });
      // persönliche Ordner von diesem Volume lösen (Daten bleiben dort); der Nutzer hat danach keinen persönlichen Ordner
      const heime = [];
      for (const n of (await nutzerdaten(w)).nutzer.filter((x) => x.heim?.quelle?.volume === p.uuid)) {
        await heimLoesen(w, heimPfad(w, n.name));
        await w.konfig.aendern('users.json', (d) => { const x = (d.nutzer || []).find((y) => y.name === n.name); if (x) x.heim = { aktiv: false, groesse_gb: null }; return d; });
        heime.push(n.name);
      }
      if (heime.length) await w.intern('freigaben.apply', {}).catch(() => {});
      const eintrag = daten.volumes.find((v) => v.uuid === p.uuid);
      if (eintrag?.alter_pfad) await alterPfadLoesen(w, eintrag.alter_pfad);
      await volumeAushaengen(w, p.uuid);
      await w.konfig.aendern(DATEI, (d) => ({ volumes: (d?.volumes || []).filter((v) => v.uuid !== p.uuid) }), { volumes: [] });
      w.konfigGeaendert?.('importe');
      return { uuid: p.uuid, freigaben: namen, heime };
    },
  });

  // ---- RAID übernommener Volumes (Betreiber 19.10.2026: „Platte ersetzen, Prüfen, Meldungen, Spiegel ergänzen“) ----
  async function raidVon(uuid) {
    const daten = await laden(w);
    const e = daten.volumes.find((x) => x.uuid === uuid);
    if (!e) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Volume ist nicht übernommen', { feld: 'uuid' });
    const v = (await volumesLesen(w)).find((x) => x.uuid === uuid);
    if (!v) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Das Volume ist gerade nicht da (Platten gezogen?)', { feld: 'uuid' });
    if (!v.raid?.geraet) throw new FahnasFehler('E_PARAMS', 'Dieses Volume liegt auf keinem RAID', { feld: 'uuid' });
    const d = await raidDetails(v.raid.geraet, sysBlock());
    if (!d) throw new FahnasFehler('E_SYSTEM', `RAID ${v.raid.geraet} nicht lesbar`);
    return { e, v, d };
  }

  reg.aktion('importe.raid.pruefen', {
    rolle: 'admin', schema: { uuid: { typ: 'string', pflicht: true, max: 64 } },
    beschreibung: 'RAID eines übernommenen Volumes prüfen (liest alle Platten und vergleicht – läuft im Hintergrund)',
    ausfuehren: async (p) => {
      const { d } = await raidVon(p.uuid);
      if (!/^raid(1|4|5|6|10)$/.test(d.stufe)) throw new FahnasFehler('E_PARAMS', `${d.stufe.toUpperCase()} hat nichts zum Vergleichen`);
      if (d.sync !== 'idle') throw new FahnasFehler('E_BELEGT', `Das RAID arbeitet gerade (${d.sync})`);
      await fs.writeFile(path.join(sysBlock(), path.basename(d.md), 'md', 'sync_action'), 'check\n');
      return raidDetails(d.md, sysBlock());
    },
  });

  reg.aktion('importe.raid.ersetzen', {
    rolle: 'admin', aufgabe: true,
    schema: { uuid: { typ: 'string', pflicht: true, max: 64 }, alt: { typ: 'string', max: 64 }, neu: { typ: 'string', pflicht: true, max: 64 }, bestaetigung: { typ: 'string', pflicht: true, max: 64 } },
    beschreibung: 'Ausgefallene Platte eines übernommenen RAIDs ersetzen oder ein RAID 1 um einen Spiegel ergänzen (die neue Platte wird dabei geleert)',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const { d } = await raidVon(p.uuid);
      let plan;
      try { plan = ersatzPlan(d, { alt: p.alt || null }); } catch (e) { throw new FahnasFehler('E_PARAMS', e.message, { feld: 'alt' }); }
      const json = JSON.parse((await w.system.ausfuehren('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,FSTYPE,PTTYPE,MOUNTPOINT'], { zeitlimit_ms: 30_000 })).stdout || '{}');
      const platten = await plattenLesen(w);
      const neu = platten.find((x) => x.name === String(p.neu).replace(/^\/dev\//, ''));
      if (!neu) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Platte ${p.neu} gibt es nicht`, { feld: 'neu' });
      if (neu.grund) throw new FahnasFehler('E_PARAMS', `Platte ${neu.name} ist nicht wählbar (${neu.grund === 'system' ? 'Systemplatte' : neu.grund === 'verbund' ? 'gehört zu einem RAID' : 'eingehängt'})`, { feld: 'neu' });
      const spuren = fremdeSpuren(json, neu.name);
      if (spuren) throw new FahnasFehler('E_PARAMS', `Auf ${neu.name} liegen Daten eines anderen Speichers (${spuren}) – sie wird nicht angefasst. Erst übernehmen oder bewusst leeren.`, { feld: 'neu' });
      if (p.bestaetigung !== neu.name) throw new FahnasFehler('E_PARAMS', `Zur Sicherheit bitte „${neu.name}“ eintippen – alles auf dieser Platte wird gelöscht`, { feld: 'bestaetigung' });
      const quellPlatte = path.basename(plan.quelle.platte);
      const quelle = (json.blockdevices || []).find((x) => x.name === quellPlatte);
      if (quelle && Number(quelle.size) > neu.groesse) throw new FahnasFehler('E_PARAMS', `Platte ${neu.name} ist kleiner als ${quellPlatte} – sie muss mindestens gleich groß sein`, { feld: 'neu' });
      if (plan.quelle.nr !== null && quelle?.pttype && quelle.pttype !== 'gpt') throw new FahnasFehler('E_PARAMS', `${quellPlatte} hat keine GPT-Partitionstabelle – das Ersetzen kann FAH-NAS hier nicht sicher übernehmen`);
      if (plan.quelle.nr !== null) await paketeSicherstellen(w.system, ['gdisk'], { fortschritt: (t) => aufgabe?.fortschritt(0.05, t), zweck: 'das Ersetzen' });
      if (plan.alt) {
        aufgabe?.fortschritt(0.15, `Defekte Platte ${plan.alt} aus dem RAID nehmen`);
        try { await w.system.ausfuehren('mdadm', ['--manage', d.md, '--fail', plan.alt]); } catch { /* schon ausgefallen */ }
        await w.system.ausfuehren('mdadm', ['--manage', d.md, '--remove', plan.alt]);
        try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', plan.alt]); } catch { /* Platte tot oder schon gezogen */ }
      }
      aufgabe?.fortschritt(0.3, `Neue Platte ${neu.name} vorbereiten`);
      try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', neu.pfad]); } catch { /* keine alten Metadaten */ }
      await w.system.ausfuehren('wipefs', ['-a', neu.pfad]);
      let teil = neu.pfad;
      if (plan.quelle.nr !== null) {
        // gleiche Aufteilung wie eine gesunde Platte (UGOS: Teil 1 System, Teil 2 Daten), neue GUIDs
        await w.system.ausfuehren('sgdisk', [`--replicate=${neu.pfad}`, plan.quelle.platte]);
        await w.system.ausfuehren('sgdisk', ['-G', neu.pfad]);
        try { await w.system.ausfuehren('partprobe', [neu.pfad]); } catch { /* udev erledigt es */ }
        try { await w.system.ausfuehren('udevadm', ['settle', '--timeout=20']); } catch { /* egal */ }
        teil = partitionPfad(neu.pfad, plan.quelle.nr);
        let da = false;
        for (let i = 0; i < 20 && !da; i++) { da = await fs.access(teil).then(() => true, () => false); if (!da) await new Promise((r) => setTimeout(r, 500)); }
        if (!da) throw new FahnasFehler('E_SYSTEM', `Partition ${teil} erscheint nicht`);
        try { await w.system.ausfuehren('mdadm', ['--zero-superblock', '--force', teil]); } catch { /* frisch */ }
        await w.system.ausfuehren('wipefs', ['-a', teil]);
      }
      aufgabe?.fortschritt(0.7, plan.modus === 'spiegel' ? 'Spiegel ergänzen' : 'Platte ins RAID aufnehmen');
      if (plan.modus === 'spiegel') await w.system.ausfuehren('mdadm', ['--grow', d.md, `--raid-devices=${plan.platten_neu}`, '--add', teil]);
      else await w.system.ausfuehren('mdadm', ['--manage', d.md, '--add', teil]);
      await w.konfig.aendern(DATEI, (x) => { const e = (x?.volumes || []).find((y) => y.uuid === p.uuid); if (e) e.raid_ersatz = { modus: plan.modus, neu: teil, alt: plan.alt, seit: new Date().toISOString() }; return x; }, { volumes: [] });
      w.konfigGeaendert?.('importe');
      aufgabe?.fortschritt(1, 'Der Neuaufbau läuft im Hintergrund');
      return { modus: plan.modus, neu: teil, alt: plan.alt, raid: await raidDetails(d.md, sysBlock()) };
    },
  });

  reg.aktion('importe.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Übernommene Volumes und Ordner einhängen (Start, nach Änderungen)',
    ausfuehren: async () => {
      const daten = await laden(w);
      if (!daten.volumes.length) return false;
      await speicherAktivieren(w);
      const shares = (await w.konfig.laden('shares.json', null))?.freigaben || [];
      const fehler = [];
      for (const v of daten.volumes) {
        try { await volumeEinhaengen(w, v.uuid); } catch (e) { fehler.push(`${v.bezeichnung || v.uuid}: ${FahnasFehler.aus(e).message}`); continue; }
        if (v.alter_pfad) { try { await alterPfadEinhaengen(w, v.uuid, v.alter_pfad); } catch (e) { fehler.push(`${v.alter_pfad}: ${FahnasFehler.aus(e).message}`); } }
        for (const f of shares.filter((x) => x.importiert?.volume === v.uuid)) {
          try { await ordnerEinhaengen(w, v.uuid, f.importiert.ordner, f.name, { schnappschuesse: !!f.importiert.schnappschuesse }); } catch (e) { fehler.push(`${f.name}: ${FahnasFehler.aus(e).message}`); }
        }
      }
      if (fehler.length) throw new FahnasFehler('E_SYSTEM', `Übernommener Speicher nicht vollständig eingehängt: ${fehler.join('; ')}`);
      return true;
    },
  });
}

// ---- Takt: Ausfall, Wiederaufbau und Prüfergebnis übernommener RAIDs melden ----------------------------------------------
let takt = null;
const gemeldet = new Map(); // uuid → {zustand:'ok'|'beeintraechtigt', sync}
export async function taktPruefen(w) {
  const daten = await laden(w);
  if (!daten.volumes.some((v) => v.raid)) return;
  let aktuell = new Map();
  try { aktuell = new Map((await volumesLesen(w)).map((v) => [v.uuid, v])); } catch { return; }
  for (const v of daten.volumes.filter((x) => x.raid)) {
    const md = aktuell.get(v.uuid)?.raid?.geraet;
    const d = md ? await raidDetails(md, sysBlock()) : null;
    if (!d) continue;
    const name = v.bezeichnung || v.uuid;
    const vorher = gemeldet.get(v.uuid) || { zustand: 'ok', sync: 'idle' };
    const zustand = d.degraded || d.mitglieder.some((m) => m.zustand === 'defekt') ? 'beeintraechtigt' : 'ok';
    if (zustand === 'beeintraechtigt' && vorher.zustand !== zustand) {
      const defekt = d.mitglieder.filter((m) => m.zustand === 'defekt').map((m) => m.geraet).join(', ');
      await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: 'fehler', titel: `RAID von „${name}“ beeinträchtigt`,
        text: `Im übernommenen RAID ${d.md} (${d.stufe.toUpperCase()}) fehlt eine Platte${defekt ? ` (${defekt})` : ''}. Die Daten sind noch da, aber ohne Reserve – bitte unter Speicher übernehmen die Platte ersetzen.`,
        schluessel: `import_raid_${v.uuid}_beeintraechtigt` }).catch(() => {});
    } else if (zustand === 'ok' && vorher.zustand !== 'ok' && d.sync === 'idle') {
      await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: 'info', titel: `RAID von „${name}“ wieder in Ordnung`, text: `Das RAID ${d.md} ist wieder vollständig.`, schluessel: `import_raid_${v.uuid}_ok_${Date.now()}` }).catch(() => {});
    }
    // Prüfung fertig: Abweichungen melden (mismatch_cnt)
    if (vorher.sync === 'check' && d.sync === 'idle') {
      const abw = Number(String(await fs.readFile(path.join(sysBlock(), path.basename(d.md), 'md', 'mismatch_cnt'), 'utf8').catch(() => '0')).trim()) || 0;
      await w.intern('benachrichtigungen.senden', { art: 'platte', stufe: abw ? 'warnung' : 'info', titel: `RAID-Prüfung von „${name}“ ${abw ? 'mit Abweichungen' : 'ohne Befund'}`,
        text: abw ? `Die Prüfung von ${d.md} fand ${abw} abweichende Sektoren. Die Platten-Gesundheit (SMART) ansehen.` : `Die Prüfung von ${d.md} ist fertig – alle Platten stimmen überein.`,
        schluessel: `import_raid_${v.uuid}_check_${Date.now()}` }).catch(() => {});
    }
    // Ersatz/Spiegel fertig: Vermerk entfernen
    if (v.raid_ersatz && zustand === 'ok' && d.sync === 'idle') {
      await w.konfig.aendern(DATEI, (x) => { const e = (x?.volumes || []).find((y) => y.uuid === v.uuid); if (e) delete e.raid_ersatz; return x; }, { volumes: [] }).catch(() => {});
    }
    gemeldet.set(v.uuid, { zustand: zustand === 'ok' && d.sync !== 'idle' && vorher.zustand !== 'ok' ? vorher.zustand : zustand, sync: d.sync });
  }
}
export async function starten(w) { takt = setInterval(() => { taktPruefen(w).catch(() => {}); }, TAKT_MS); takt.unref?.(); }
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
export const _test = { gemeldet };
