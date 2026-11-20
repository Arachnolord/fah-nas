// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „speicherorte.*“ (Betreiber 19.10.2026): Docker, Apps und VMs auf ein übernommenes Volume umziehen und zurück.
// Ablauf beim Umziehen: Prüfen (Platz, nichts Fremdes am Ziel, VMs aus) → Docker/libvirt anhalten → kopieren (rsync,
// Besitzer als Zahlen, Hardlinks, ACLs, Attribute) → umschalten (Bind-Mount) → Startschritt + Drop-ins → Dienste wieder an.
// Schlägt etwas fehl, bleibt der alte Ort in Betrieb (er wird nie gelöscht – erst „Alten Stand löschen“ gibt ihn frei).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { BEREICHE, DATEI, UMZUG_MARKE, UNIT, DIENSTE, zielPfad, systemOrt, volumeOrt, volumePfad, normieren, zeigtAuf, dropinText, bereitstellen } from '../import/speicherorte.js';
import { eingehaengt } from '../render/samba.js';

const SYSTEMD = () => process.env.FAHNAS_SYSTEMD || '/etc/systemd/system';
const DROPIN = 'fahnas-speicherort.conf';

const pf = (w) => ({ ...PFADE, ...(w.pfade || {}), apps: w.pfade?.apps || PFADE.apps, vms: w.pfade?.vms || PFADE.vms, daten: w.pfade?.daten || PFADE.daten, importe: w.pfade?.importe || PFADE.importe, docker: w.pfade?.docker || process.env.FAHNAS_DOCKER_WURZEL || '/var/lib/docker' });
const laden = async (w) => normieren(await w.konfig.laden(DATEI, null));
const importeLaden = async (w) => (await w.konfig.laden('importe.json', null))?.volumes || [];

async function platzVon(w, pfad) {
  try {
    const t = String((await w.system.ausfuehren('df', ['-B1', '--output=size,avail', pfad], { zeitlimit_ms: 10_000 })).stdout).trim().split('\n').pop().trim().split(/\s+/);
    return { gesamt: Number(t[0]), frei: Number(t[1]) };
  } catch { return null; }
}
async function belegtVon(w, pfad) {
  try { const r = await w.system.ausfuehren('du', ['-s', '-x', '-B1', pfad], { zeitlimit_ms: 600_000 }); const n = Number(String(r.stdout).trim().split(/\s+/)[0]); return Number.isFinite(n) ? n : null; } catch { return null; }
}

/** Startschritt und Drop-ins passend zu den gewählten Orten schreiben (oder entfernen), daemon-reload. */
async function startAngleichen(w, orte) {
  const dienste = new Set(BEREICHE.filter((b) => orte[b]).flatMap((b) => DIENSTE[b]));
  const alle = new Set(Object.values(DIENSTE).flat());
  let anders = false;
  const unitZiel = path.join(SYSTEMD(), UNIT);
  if (dienste.size && !(await fs.access(unitZiel).then(() => true, () => false))) {
    await fs.mkdir(SYSTEMD(), { recursive: true });
    await fs.copyFile(path.join(PFADE.programm, 'systemd', UNIT), unitZiel); anders = true;
  }
  for (const d of alle) {
    const datei = path.join(SYSTEMD(), `${d}.d`, DROPIN);
    const ist = await fs.readFile(datei, 'utf8').catch(() => null);
    if (dienste.has(d)) {
      if (ist !== dropinText()) { await fs.mkdir(path.dirname(datei), { recursive: true }); await fs.writeFile(datei, dropinText(), { mode: 0o644 }); anders = true; }
    } else if (ist !== null) { await fs.rm(datei, { force: true }); anders = true; }
  }
  if (anders) await w.system.ausfuehren('systemctl', ['daemon-reload']).catch(() => {});
  await w.system.ausfuehren('systemctl', [dienste.size ? 'enable' : 'disable', UNIT], { erlaubteCodes: [0, 1] }).catch(() => {});
}

/** Dienste eines Bereichs anhalten/starten (Docker: alle Container halten an). */
async function dienste(w, bereich, an) {
  if (bereich === 'vms') return; // VMs müssen aus sein (geprüft); libvirt selbst darf weiterlaufen
  if (an) {
    await w.system.ausfuehren('systemctl', ['start', 'docker.socket', 'docker.service'], { zeitlimit_ms: 180_000 });
  } else {
    await w.system.ausfuehren('systemctl', ['stop', 'docker.socket', 'docker.service'], { zeitlimit_ms: 300_000 });
  }
}

async function laufendeVms(w) {
  try {
    const r = await w.system.ausfuehren('virsh', ['-c', 'qemu:///system', 'list', '--name', '--state-running'], { zeitlimit_ms: 20_000, erlaubteCodes: [0, 1] });
    return String(r.stdout).split('\n').map((z) => z.trim()).filter(Boolean);
  } catch { return []; }
}

/** Ziel vorbereiten: leer oder Rest eines abgebrochenen Umzugs (Marke) – sonst Abbruch (nie Fremdes überschreiben). */
async function zielVorbereiten(w, ziel, { btrfs }) {
  const da = await fs.readdir(ziel).catch(() => null);
  if (da && da.length && !da.includes(UMZUG_MARKE)) throw new FahnasFehler('E_BELEGT', `Am Ziel ${ziel} liegen schon Dateien – FAH-NAS überschreibt sie nicht`);
  if (!da) {
    await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o755 });
    if (btrfs) await w.system.ausfuehren('btrfs', ['subvolume', 'create', ziel]); else await fs.mkdir(ziel, { mode: 0o711 });
  }
  await fs.writeFile(path.join(ziel, UMZUG_MARKE), new Date().toISOString());
}

export function registriere(reg, w) {
  reg.aktion('speicherorte.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Wo Docker, Apps und VMs liegen – Systemplatte oder übernommenes Volume – mit Platz',
    ausfuehren: async () => {
      const p = pf(w); const orte = await laden(w); const volumes = await importeLaden(w);
      const ziele = [];
      for (const v of volumes) {
        const vp = volumePfad(p, v.uuid);
        const drin = await eingehaengt(w.system, vp);
        ziele.push({ uuid: v.uuid, bezeichnung: v.bezeichnung || v.uuid, fstype: v.fstype, eingehaengt: drin, platz: drin ? await platzVon(w, vp) : null });
      }
      const bereiche = [];
      for (const b of BEREICHE) {
        const o = orte[b];
        const aktiv = o ? await zeigtAuf(zielPfad(p, b), volumeOrt(p, o.volume, b)) : true;
        bereiche.push({
          bereich: b, pfad: zielPfad(p, b), ort: o ? 'volume' : 'system', volume: o?.volume || null, seit: o?.seit || null,
          bezeichnung: o ? (volumes.find((v) => v.uuid === o.volume)?.bezeichnung || o.volume) : null,
          aktiv, platz: await platzVon(w, zielPfad(p, b)),
          alter_stand: o ? (await fs.readdir(systemOrt(p, b)).catch(() => [])).length > 0 : false,
        });
      }
      return { bereiche, ziele, system: await platzVon(w, p.daten) };
    },
  });

  reg.aktion('speicherorte.setzen', {
    rolle: 'admin', aufgabe: true,
    schema: { bereich: { typ: 'string', pflicht: true, werte: [...BEREICHE] }, ziel: { typ: 'string', pflicht: true, max: 64 } },
    beschreibung: 'Docker, Apps oder VMs umziehen (auf ein übernommenes Volume oder zurück auf die Systemplatte) – Docker hält dabei an',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const P = pf(w); const orte = await laden(w); const volumes = await importeLaden(w);
      const b = p.bereich; const jetzt = orte[b];
      const nachSystem = p.ziel === 'system';
      if (nachSystem ? !jetzt : jetzt?.volume === p.ziel) throw new FahnasFehler('E_PARAMS', 'Der Bereich liegt schon dort', { feld: 'ziel' });
      let zielVol = null;
      if (!nachSystem) {
        zielVol = volumes.find((v) => v.uuid === p.ziel);
        if (!zielVol) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Volume ist nicht übernommen', { feld: 'ziel' });
        if (!(await eingehaengt(w.system, volumePfad(P, p.ziel)))) throw new FahnasFehler('E_BELEGT', 'Das Volume ist nicht eingehängt', { feld: 'ziel' });
      }
      if (jetzt && !(await zeigtAuf(zielPfad(P, b), volumeOrt(P, jetzt.volume, b)))) throw new FahnasFehler('E_BELEGT', 'Der bisherige Speicherort ist gerade nicht eingehängt – erst das Volume wieder bereitstellen');
      if (b === 'vms') { const an = await laufendeVms(w); if (an.length) throw new FahnasFehler('E_BELEGT', `Erst alle VMs ausschalten: ${an.join(', ')}`); }
      const quelle = zielPfad(P, b); // zeigt immer auf den aktuellen Stand
      const ziel = nachSystem ? systemOrt(P, b) : volumeOrt(P, p.ziel, b);
      aufgabe?.fortschritt(0.03, 'Platz prüfen');
      const belegt = await belegtVon(w, quelle);
      const platz = await platzVon(w, nachSystem ? P.daten : volumePfad(P, p.ziel));
      // Reserve: 10 % mehr als belegt, dazu 1 GiB (bei kleinen Volumes höchstens 10 % ihrer Größe)
      if (belegt !== null && platz && platz.frei < belegt * 1.1 + Math.min(1024 ** 3, platz.gesamt * 0.1)) throw new FahnasFehler('E_PLATZ', `Am Ziel ist zu wenig Platz (${Math.round(platz.frei / 1e9)} GB frei, gebraucht ${Math.round(belegt / 1e9)} GB)`);
      // Gespiegelte Einhängung (Mount-Propagation über Bind-Mounts): Quelle und Ziel wären derselbe Ordner – dann würde
      // „kopiert“, ohne dass etwas passiert, und nach dem Umschalten liefe still ein alter Stand weiter. Lieber abbrechen.
      if (await zeigtAuf(ziel, quelle)) throw new FahnasFehler('E_SYSTEM', `${ziel} und ${quelle} sind dieselbe Einhängung – der Umzug wird nicht ausgeführt`);
      if (!nachSystem) await zielVorbereiten(w, ziel, { btrfs: zielVol.fstype === 'btrfs' });
      else await fs.writeFile(path.join(ziel, UMZUG_MARKE), new Date().toISOString()).catch(() => {});
      const docker = b !== 'vms';
      aufgabe?.fortschritt(0.08, docker ? 'Docker wird angehalten (alle Apps halten kurz an)' : 'VMs sind aus – es geht los');
      if (docker) await dienste(w, b, false);
      let umgeschaltet = false;
      try {
        aufgabe?.fortschritt(0.12, `${b === 'docker' ? 'Docker-Daten' : b === 'apps' ? 'App-Ordner' : 'VM-Dateien'} werden kopiert (${belegt !== null ? `${Math.round(belegt / 1e9)} GB` : 'Größe unbekannt'})`);
        // Einhängungen darunter (fremde Dateisysteme) würden mitkopiert oder fehlen – dann lieber nicht
        const darunter = String((await w.system.ausfuehren('findmnt', ['-rn', '-o', 'TARGET'], { zeitlimit_ms: 10_000 })).stdout).split('\n').filter((z) => z.startsWith(`${quelle}/`));
        if (darunter.length) throw new FahnasFehler('E_BELEGT', `Unter ${quelle} ist noch etwas eingehängt (${darunter.slice(0, 3).join(', ')}) – erst lösen`);
        // zurück aufs System: der alte Systemstand wird exakt angeglichen (--delete nur innerhalb von @<bereich>)
        const args = ['-aHAX', '--numeric-ids', ...(nachSystem ? ['--delete'] : []), `--exclude=/${UMZUG_MARKE}`, `${quelle}/`, `${ziel}/`];
        await w.system.ausfuehren('rsync', args, { zeitlimit_ms: 24 * 3600_000 });
        // Gegenprobe: ein zweiter Abgleich (nur ansehen) darf nichts mehr finden – sonst wird nicht umgeschaltet
        const rest = String((await w.system.ausfuehren('rsync', ['-n', '--delete', '--out-format=%n', ...args.filter((a) => a !== '--delete')], { zeitlimit_ms: 6 * 3600_000 })).stdout).split('\n').filter((z) => z.trim() && z.trim() !== './');
        if (rest.length) throw new FahnasFehler('E_SYSTEM', `Kopie nicht vollständig (${rest.length} Einträge weichen ab, z. B. ${rest.slice(0, 3).join(', ')})`);
        aufgabe?.fortschritt(0.85, 'Umschalten');
        if (jetzt) { await w.system.ausfuehren('umount', [quelle], { zeitlimit_ms: 120_000 }); umgeschaltet = true; }
        if (!nachSystem) { await w.system.ausfuehren('mount', ['--bind', ziel, quelle]); umgeschaltet = true; }
        if (!(await zeigtAuf(quelle, ziel))) throw new FahnasFehler('E_SYSTEM', `${quelle} zeigt nach dem Umschalten nicht auf ${ziel}`);
        // der Systemstand darunter muss der Systemstand bleiben (keine gespiegelte Einhängung)
        if (!nachSystem && await zeigtAuf(systemOrt(P, b), ziel)) throw new FahnasFehler('E_SYSTEM', `Die Einhängung wurde auf ${systemOrt(P, b)} gespiegelt – Umzug zurückgenommen`);
        await fs.rm(path.join(ziel, UMZUG_MARKE), { force: true });
        const neu = { ...orte, [b]: nachSystem ? null : { volume: p.ziel, seit: new Date().toISOString() } };
        await w.konfig.speichern(DATEI, neu);
        await startAngleichen(w, neu);
      } catch (e) {
        // Rückweg: alten Ort wieder einhängen, Dienste starten – nichts wird gelöscht
        if (umgeschaltet) {
          try { if (await zeigtAuf(quelle, ziel) && !nachSystem) await w.system.ausfuehren('umount', [quelle]); } catch { /* weiter */ }
          try { if (jetzt) await w.system.ausfuehren('mount', ['--bind', volumeOrt(P, jetzt.volume, b), quelle]); } catch { /* weiter */ }
        }
        if (docker) await dienste(w, b, true).catch(() => {});
        throw new FahnasFehler(FahnasFehler.aus(e).code, `Umzug abgebrochen, der bisherige Ort ist weiter in Betrieb: ${FahnasFehler.aus(e).message}`);
      }
      aufgabe?.fortschritt(0.92, 'Docker startet wieder');
      if (docker) { await dienste(w, b, true); await w.intern('apps.apply', {}).catch(() => {}); }
      w.konfigGeaendert?.('speicherorte');
      aufgabe?.fortschritt(1, 'Fertig');
      return { bereich: b, ziel: nachSystem ? 'system' : p.ziel, pfad: quelle, kopiert_bytes: belegt };
    },
  });

  reg.aktion('speicherorte.alt_loeschen', {
    rolle: 'admin', aufgabe: true, schema: { bereich: { typ: 'string', pflicht: true, werte: [...BEREICHE] }, bestaetigung: { typ: 'string', pflicht: true, max: 16 } },
    beschreibung: 'Alten Stand auf der Systemplatte löschen, nachdem der Bereich auf ein Volume umgezogen ist (gibt Platz frei)',
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const P = pf(w); const o = (await laden(w))[p.bereich];
      if (p.bestaetigung !== p.bereich) throw new FahnasFehler('E_PARAMS', `Zur Sicherheit bitte „${p.bereich}“ eintippen`, { feld: 'bestaetigung' });
      if (!o) throw new FahnasFehler('E_PARAMS', 'Der Bereich liegt auf der Systemplatte – dort gibt es keinen alten Stand', { feld: 'bereich' });
      const alt = systemOrt(P, p.bereich);
      if (!(await zeigtAuf(zielPfad(P, p.bereich), volumeOrt(P, o.volume, p.bereich)))) throw new FahnasFehler('E_BELEGT', 'Der neue Ort ist gerade nicht eingehängt – der alte Stand bleibt als Rückweg');
      if (await zeigtAuf(zielPfad(P, p.bereich), alt)) throw new FahnasFehler('E_SYSTEM', 'Der alte Stand ist gerade in Benutzung');
      const namen = await fs.readdir(alt).catch(() => []);
      for (const [i, n] of namen.entries()) {
        aufgabe?.fortschritt(i / Math.max(1, namen.length), `${n} wird gelöscht`);
        await fs.rm(path.join(alt, n), { recursive: true, force: true });
      }
      w.konfigGeaendert?.('speicherorte');
      return { bereich: p.bereich, geloescht: namen.length };
    },
  });

  reg.aktion('speicherorte.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Speicherorte prüfen (der Startschritt hängt sie ein) – hängt Fehlendes nach',
    ausfuehren: async () => {
      const orte = await laden(w);
      if (!BEREICHE.some((b) => orte[b])) return false;
      const r = await bereitstellen({ system: w.system, pfade: pf(w), orte, volumes: await importeLaden(w), wartenMs: 5_000 });
      await startAngleichen(w, orte).catch(() => {});
      if (r.fehler.length) throw new FahnasFehler('E_SYSTEM', `Speicherorte nicht bereit: ${r.fehler.join('; ')}`);
      return true;
    },
  });
}
