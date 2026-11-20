// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Docker-Übernahme (Betreiber 19.10.2026: „bau alles – Docker-Übernahme mit“): die Docker-Ablage des alten NAS
// (UGOS/Synology: <volume>/@docker) nur LESEN – Container-Konfigurationen (containers/<id>/config.v2.json,
// hostconfig.json) zu Compose-Projekten bündeln, Volumes, Bind-Pfade und Konten erkennen. Die alte Ablage wird nie
// verändert und nie gestartet; übernommen werden Compose-Projekte (Compose-Dateien bleiben am alten Ort, der alte Pfad
// /volumeN macht sie lauffähig), die Daten benannter Volumes werden in neue Docker-Volumes kopiert. Anonyme Volumes
// (64 Hex-Zeichen) bekommen einen Namen und eine Zusatzdatei fahnas-uebernahme.yml – sonst legte Compose leere neue an.

import fs from 'node:fs/promises';
import path from 'node:path';

export const ABLAGEN = ['@docker', '@Docker', 'docker-data-root'];   // Docker-Ablage des alten Systems auf dem Volume
export const UEBERNAHME_DATEI = 'fahnas-uebernahme.yml';
const MAX_CONTAINER = 2000;
const MAX_JSON = 4 * 1024 * 1024;
const ANONYM = /^[0-9a-f]{64}$/;
export const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const KONTO_VARIABLEN = new Set(['PUID', 'PGID', 'UID', 'GID', 'USER_ID', 'GROUP_ID', 'USERMAP_UID', 'USERMAP_GID']);

async function jsonLesen(datei) {
  const st = await fs.stat(datei);
  if (st.size > MAX_JSON) throw new Error('zu groß');
  return JSON.parse(await fs.readFile(datei, 'utf8'));
}

/** Docker-Ablage auf einem eingehängten Volume finden (Ordner mit containers/ und volumes/). → Pfad oder null */
export async function ablageFinden(volumePfad) {
  for (const name of ABLAGEN) {
    const p = path.join(volumePfad, name);
    try {
      const [c, v] = await Promise.all([fs.stat(path.join(p, 'containers')), fs.stat(path.join(p, 'volumes'))]);
      if (c.isDirectory() && v.isDirectory()) return p;
    } catch { /* nicht hier */ }
  }
  return null;
}

/** Ein Container aus config.v2.json + hostconfig.json → schlanker Eintrag. */
export function containerAus(cfg, host) {
  const c = cfg || {}; const h = host || {};
  const l = (c.Config && c.Config.Labels) || {};
  const mounts = [];
  for (const [ziel, m] of Object.entries(c.MountPoints || {})) {
    if (!m) continue;
    const art = m.Type || (m.Name ? 'volume' : 'bind');
    if (art === 'volume') mounts.push({ art, name: String(m.Name || ''), ziel: m.Destination || ziel, anonym: ANONYM.test(String(m.Name || '')), treiber: m.Driver || 'local' });
    else if (art === 'bind') mounts.push({ art, quelle: String(m.Source || ''), ziel: m.Destination || ziel });
  }
  const env = {};
  for (const e of (c.Config && c.Config.Env) || []) {
    const i = String(e).indexOf('=');
    const k = i > 0 ? String(e).slice(0, i) : '';
    if (KONTO_VARIABLEN.has(k)) env[k] = String(e).slice(i + 1);
  }
  const rp = (h.RestartPolicy && h.RestartPolicy.Name) || '';
  return {
    id: String(c.ID || ''), name: String(c.Name || '').replace(/^\//, ''), image: String((c.Config && c.Config.Image) || ''),
    projekt: l['com.docker.compose.project'] || null, dienst: l['com.docker.compose.service'] || null,
    ordner: l['com.docker.compose.project.working_dir'] || null,
    dateien: String(l['com.docker.compose.project.config_files'] || '').split(',').map((s) => s.trim()).filter(Boolean),
    laeuft: !!(c.State && c.State.Running),
    neustart: rp, von_hand_gestoppt: !!c.HasBeenManuallyStopped,
    netz: String(h.NetworkMode || ''), geraete: (h.Devices || []).map((d) => d && d.PathOnHost).filter(Boolean),
    privilegiert: !!h.Privileged, mounts, konten: env,
  };
}

/** Alle Container der Ablage lesen (nur lesen). → [{…containerAus}] */
export async function containerLesen(ablage) {
  let ids = [];
  try { ids = (await fs.readdir(path.join(ablage, 'containers'))).filter((x) => /^[0-9a-f]{64}$/.test(x)).slice(0, MAX_CONTAINER); } catch { return []; }
  const aus = [];
  for (const id of ids) {
    const d = path.join(ablage, 'containers', id);
    try {
      const cfg = await jsonLesen(path.join(d, 'config.v2.json'));
      const host = await jsonLesen(path.join(d, 'hostconfig.json')).catch(() => ({}));
      aus.push(containerAus(cfg, host));
    } catch { /* kaputter Eintrag – überspringen */ }
  }
  return aus;
}

/** Alte Pfade (/volumeN), die ein Projekt braucht (Arbeitsordner, Compose-Dateien, Bind-Quellen). */
export function altePfade(projekt) {
  const s = new Set();
  const nimm = (p) => { const m = /^(\/volume\d{1,2})(?:\/|$)/.exec(String(p || '')); if (m) s.add(m[1]); };
  nimm(projekt.ordner); projekt.dateien.forEach(nimm);
  for (const c of projekt.container) for (const m of c.mounts) if (m.art === 'bind') nimm(m.quelle);
  return [...s].sort();
}

/**
 * Container zu Compose-Projekten bündeln. Container ohne Compose-Kennung (docker run) lassen sich nicht übernehmen –
 * sie kommen als `einzeln` zurück (mit Image und Mounts, damit man sie von Hand nachbauen kann).
 * → {projekte:[{projekt, ordner, dateien, container, dienste, volumes:[{name, anonym, dienste:[{dienst, ziel}]}], laeuft, autostart, konten, warnungen}], einzeln}
 */
export function projekteBilden(container) {
  const map = new Map(); const einzeln = [];
  for (const c of container) {
    if (!c.projekt) { einzeln.push({ name: c.name, image: c.image, laeuft: c.laeuft, mounts: c.mounts }); continue; }
    if (!map.has(c.projekt)) map.set(c.projekt, { projekt: c.projekt, ordner: c.ordner, dateien: [], container: [] });
    const p = map.get(c.projekt);
    p.container.push(c);
    if (!p.ordner && c.ordner) p.ordner = c.ordner;
    for (const d of c.dateien) if (!p.dateien.includes(d)) p.dateien.push(d);
  }
  const projekte = [];
  for (const p of map.values()) {
    const vols = new Map();
    for (const c of p.container) {
      for (const m of c.mounts.filter((x) => x.art === 'volume' && x.name)) {
        if (!vols.has(m.name)) vols.set(m.name, { name: m.name, anonym: m.anonym, treiber: m.treiber, dienste: [] });
        vols.get(m.name).dienste.push({ dienst: c.dienst, ziel: m.ziel });
      }
    }
    const warnungen = [];
    if (!p.dateien.length) warnungen.push('Keine Compose-Datei bekannt – das Projekt lässt sich nicht übernehmen');
    for (const c of p.container) {
      if (c.netz === 'host') warnungen.push(`„${c.dienst || c.name}“ nutzt das Netzwerk des NAS direkt (Host-Netz) – Ports können mit FAH-NAS-Diensten kollidieren`);
      if (c.privilegiert) warnungen.push(`„${c.dienst || c.name}“ läuft privilegiert (voller Zugriff aufs System)`);
      for (const g of c.geraete) warnungen.push(`„${c.dienst || c.name}“ braucht das Gerät ${g}`);
      for (const m of c.mounts) if (m.art === 'bind' && /^\/(ugreen|usr\/local\/ugreen|var\/packages|volume\d+\/@appstore)/.test(m.quelle)) warnungen.push(`„${c.dienst || c.name}“ bindet ${m.quelle} ein – das gehört zum alten System und fehlt unter FAH-NAS`);
    }
    const konten = {};
    for (const c of p.container) for (const [k, v] of Object.entries(c.konten)) konten[`${c.dienst || c.name}.${k}`] = v;
    projekte.push({
      projekt: p.projekt, ordner: p.ordner, dateien: p.dateien,
      dienste: [...new Set(p.container.map((c) => c.dienst).filter(Boolean))].sort(),
      images: [...new Set(p.container.map((c) => c.image).filter(Boolean))].sort(),
      volumes: [...vols.values()].sort((a, b) => a.name.localeCompare(b.name)),
      laeuft: p.container.some((c) => c.laeuft),
      // Autostart wie unter dem alten System: Neustart-Regel „always“/„unless-stopped“ und nicht von Hand gestoppt
      autostart: p.container.some((c) => (c.neustart === 'always' || c.neustart === 'unless-stopped') && !c.von_hand_gestoppt),
      konten, warnungen: [...new Set(warnungen)], alte_pfade: [], container: p.container,
    });
  }
  for (const p of projekte) p.alte_pfade = altePfade(p);
  return { projekte: projekte.sort((a, b) => a.projekt.localeCompare(b.projekt, 'de')), einzeln };
}

/** Neuer Name für ein Volume: benannte behalten ihren Namen, anonyme bekommen <projekt>_fahnas_<12 Zeichen>. */
export function neuerVolumeName(projekt, vol) {
  if (!vol.anonym) return vol.name;
  const basis = String(projekt).toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^[^a-z0-9]+/, '') || 'app';
  return `${basis}_fahnas_${vol.name.slice(0, 12)}`;
}

/** Compose-Labels für ein benanntes Volume des Projekts (nur bei „<projekt>_<kurz>“, sonst keine). */
export function volumeLabels(projekt, name) {
  const vorsilbe = `${projekt}_`;
  if (!name.startsWith(vorsilbe) || name.length === vorsilbe.length) return {};
  return { 'com.docker.compose.project': projekt, 'com.docker.compose.volume': name.slice(vorsilbe.length) };
}

/**
 * Zusatzdatei für Compose: anonyme Volumes → benannte (extern). Compose führt die Volumes eines Dienstes über den Pfad im
 * Container zusammen, der Eintrag hier ersetzt also den anonymen. → YAML-Text oder null (nichts zu tun)
 */
export function uebernahmeYaml(eintraege) {
  const dienste = new Map(); const namen = new Set();
  for (const e of eintraege) {
    if (!e.dienst || !VOLUME_NAME.test(e.name)) continue;
    if (!dienste.has(e.dienst)) dienste.set(e.dienst, []);
    dienste.get(e.dienst).push(e); namen.add(e.name);
  }
  if (!dienste.size) return null;
  const q = (s) => JSON.stringify(String(s)); // JSON-Zeichenkette = gültiges YAML in Anführungszeichen
  const z = ['# Von FAH-NAS bei der Docker-Übernahme angelegt: frühere anonyme Volumes mit ihren übernommenen Daten.', 'services:'];
  for (const [d, liste] of [...dienste].sort((a, b) => a[0].localeCompare(b[0]))) {
    z.push(`  ${q(d)}:`, '    volumes:');
    for (const e of liste) z.push('      - type: volume', `        source: ${q(e.name)}`, `        target: ${q(e.ziel)}`);
  }
  z.push('volumes:');
  for (const n of [...namen].sort()) z.push(`  ${q(n)}:`, '    external: true');
  return z.join('\n') + '\n';
}

/**
 * Hinweise zu Konto-Variablen (PUID/PGID …): alte uid → neue uid nach der Besitz-Zuordnung der Übernahme.
 * `besitz` = {alteUid: neueUid}. → [text]
 */
export function kontenHinweise(konten, besitz) {
  const aus = [];
  for (const [k, v] of Object.entries(konten || {})) {
    const alt = Number(v);
    if (!Number.isInteger(alt) || !/\.(PUID|UID|USER_ID|USERMAP_UID)$/.test(k)) continue;
    const neu = besitz && Object.prototype.hasOwnProperty.call(besitz, String(alt)) ? Number(besitz[String(alt)]) : null;
    if (neu !== null && neu !== alt) aus.push(`${k}=${alt}: diese Dateien gehören auf FAH-NAS jetzt uid ${neu} – ggf. in der Compose-Datei anpassen`);
  }
  return aus;
}
