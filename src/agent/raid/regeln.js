// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Speicherverbünde (RAID, Betreiber 12.10.2026: „RAID gerne noch einbauen (die gängigsten)“) – reine Regeln ohne
// Systemzugriff. Technik: Linux-Software-RAID (mdadm, RAID 0/1/5/6/10) mit btrfs darauf (Schnappschüsse, Kompression,
// ACLs wie bei internen Freigaben). btrfs-eigenes RAID 5/6 wird bewusst nicht genutzt (gilt als nicht ausfallsicher).

import { FahnasFehler } from '../../gemeinsam/fehler.js';

const fehler = (text, feld) => new FahnasFehler('E_PARAMS', text, { feld });
export const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Stufen: Mindestzahl Platten, nutzbare Kapazität (n Platten, kleinste s Bytes), verkraftbare Ausfälle. */
export const STUFEN = Object.freeze({
  raid1: { min: 2, kapazitaet: (n, s) => s, ausfaelle: (n) => n - 1 },
  raid5: { min: 3, kapazitaet: (n, s) => (n - 1) * s, ausfaelle: () => 1 },
  raid6: { min: 4, kapazitaet: (n, s) => (n - 2) * s, ausfaelle: () => 2 },
  raid10: { min: 4, gerade: true, kapazitaet: (n, s) => (n / 2) * s, ausfaelle: () => 1 },
  raid0: { min: 2, kapazitaet: (n, s) => n * s, ausfaelle: () => 0 },
});
export const MD_PFAD = (name) => `/dev/md/fahnas-${name}`;
export const FS_LABEL = (name) => `FAHNAS-RAID-${name}`.slice(0, 64);

/** Kapazität eines Vorschlags (Bytes) und verkraftbare Ausfälle. */
export function rechnen(stufe, groessen) {
  const s = STUFEN[stufe];
  if (!s || !groessen.length) return { kapazitaet: 0, ausfaelle: 0 };
  const kleinste = Math.min(...groessen);
  return { kapazitaet: Math.floor(s.kapazitaet(groessen.length, kleinste)), ausfaelle: s.ausfaelle(groessen.length), verschnitt: groessen.reduce((a, g) => a + (g - kleinste), 0) };
}

/**
 * Platten, die für einen Verbund taugen (lsblk -J -b -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINTS,LABEL,ROTA,PKNAME):
 * ganze Platten, nicht die Systemplatte, nicht USB, nichts eingehängt, nicht Teil eines laufenden Verbunds.
 * @returns {Array<{name, pfad, groesse, modell, seriennummer, art:'hdd'|'ssd'|'nvme', grund?:string}>} grund = warum nicht wählbar
 */
export function plattenAuswerten(json, { systemPruefen }) {
  const aus = [];
  for (const d of (json && Array.isArray(json.blockdevices) ? json.blockdevices : [])) {
    const testLoop = process.env.FAHNAS_RAID_TEST_LOOPS === '1' && d && d.type === 'loop' && /^loop\d+$/.test(d.name || '') && Number(d.size) > 0;
    if (!d || (!testLoop && (d.type !== 'disk' || /^(loop|zram|sr|ram|fd|md)/.test(d.name || '')))) continue;
    if (process.env.FAHNAS_RAID_TEST_LOOPS !== '1' && d.tran === 'usb') continue; // USB-Platten: für RAID ungeeignet (Abbrüche, Stromsparen)
    const nachfahren = (x) => (Array.isArray(x.children) ? x.children.flatMap((k) => (k ? [k, ...nachfahren(k)] : [])) : []);
    const kinder = nachfahren(d); // alle Ebenen (Partition → LVM/crypt → Dateisystem)
    const eintrag = { name: d.name, pfad: `/dev/${d.name}`, groesse: Number(d.size) || 0, modell: (d.model || '').trim(), seriennummer: (d.serial || '').trim(), art: /^nvme/.test(d.name) ? 'nvme' : d.rota === true || d.rota === '1' || d.rota === 1 ? 'hdd' : 'ssd' };
    const montiert = (x) => (Array.isArray(x.mountpoints) ? x.mountpoints : [x.mountpoint]).some((m) => m);
    if (systemPruefen({ ...d, children: kinder })) eintrag.grund = 'system';
    else if (kinder.some((k) => /^raid/.test(k.type || ''))) eintrag.grund = 'verbund';
    else if (montiert(d) || kinder.some(montiert)) eintrag.grund = 'eingehaengt';
    aus.push(eintrag);
  }
  return aus;
}

/** Neuen Verbund prüfen. `platten` = Ergebnis von plattenAuswerten, `belegt` = vorhandene Freigaben-/Verbundnamen. */
export function verbundNormal(e, { platten = [], belegt = [] } = {}) {
  const name = String(e && e.name || '').trim().toLowerCase();
  if (!NAME.test(name)) throw fehler('Name: Kleinbuchstaben, Ziffern, - und _, höchstens 32 Zeichen (z. B. daten)', 'name');
  if (belegt.includes(name)) throw new FahnasFehler('E_EXISTIERT', `„${name}“ gibt es schon als Freigabe oder Verbund`, { feld: 'name' });
  const stufe = STUFEN[e.stufe] ? e.stufe : null;
  if (!stufe) throw fehler('Bitte eine RAID-Stufe wählen', 'stufe');
  const namen = [...new Set((Array.isArray(e.platten) ? e.platten : []).map(String))];
  const gewaehlt = namen.map((n) => platten.find((p) => p.name === n));
  if (gewaehlt.some((p) => !p)) throw fehler('Eine gewählte Platte gibt es nicht (mehr) – Liste neu laden', 'platten');
  const gesperrt = gewaehlt.find((p) => p.grund);
  if (gesperrt) throw fehler(`Platte ${gesperrt.name} ist nicht wählbar (${gesperrt.grund === 'system' ? 'Systemplatte' : gesperrt.grund === 'verbund' ? 'gehört zu einem Verbund' : 'eingehängt'})`, 'platten');
  const s = STUFEN[stufe];
  if (gewaehlt.length < s.min) throw fehler(`${stufe.toUpperCase()} braucht mindestens ${s.min} Platten`, 'platten');
  if (s.gerade && gewaehlt.length % 2) throw fehler('RAID 10 braucht eine gerade Anzahl Platten', 'platten');
  if (gewaehlt.length > 16) throw fehler('Höchstens 16 Platten je Verbund', 'platten');
  return { name, stufe, platten: gewaehlt.map((p) => ({ name: p.name, pfad: p.pfad, groesse: p.groesse, modell: p.modell, seriennummer: p.seriennummer })) };
}

/** mdadm --create-Argumente (ganze Platten, Metadaten 1.2, Bitmap gegen lange Neuaufbauten nach Absturz). */
export function anlegenArgumente(v) {
  const a = ['--create', MD_PFAD(v.name), '--run', '--metadata=1.2', `--name=fahnas-${v.name}`, `--level=${v.stufe.replace('raid', '')}`, `--raid-devices=${v.platten.length}`];
  if (v.stufe !== 'raid0') a.push('--bitmap=internal');
  if (v.stufe === 'raid10') a.push('--layout=n2');
  return [...a, ...v.platten.map((p) => p.pfad)];
}

/** /proc/mdstat → {md127: {stufe, geraete:[name], status:'[UU_]', fortschritt?:{art, prozent, rest}}} */
export function mdstatParsen(text) {
  const aus = {};
  let akt = null;
  for (const z of String(text || '').split('\n')) {
    const m = /^(md\d+)\s*:\s*(\w+)\s+(?:\((?:auto-)?read-only\)\s+)?(raid\d+)?\s*(.*)$/.exec(z);
    if (m) { akt = aus[m[1]] = { zustand: m[2], stufe: m[3] || null, geraete: (m[4] || '').split(/\s+/).filter(Boolean).map((g) => ({ name: g.replace(/\[\d+\].*$/, ''), defekt: /\(F\)/.test(g), ersatz: /\(S\)/.test(g) })) }; continue; }
    if (!akt) continue;
    const st = /\[([U_]+)\]\s*$/.exec(z);
    if (st) akt.status = st[1];
    const f = /(recovery|resync|reshape|check)\s*=\s*([\d.]+)%.*?finish=([\d.]+)min/.exec(z);
    if (f) akt.fortschritt = { art: f[1], prozent: Number(f[2]), rest_min: Number(f[3]) };
    else { const f2 = /(recovery|resync|reshape|check)\s*=\s*DELAYED|(resync|recovery)=PENDING/.exec(z); if (f2) akt.fortschritt = { art: f2[1] || f2[2], prozent: 0, rest_min: null }; }
  }
  return aus;
}

/** mdadm --detail → {zustand:'clean, degraded', stufe, groesse, geraete:[{pfad, rolle}], uuid, aktiv, gesamt} */
export function detailParsen(text) {
  const w = {}; const geraete = [];
  let tabelle = false;
  for (const z of String(text || '').split('\n')) {
    if (/^\s*Number\s+Major\s+Minor/.test(z)) { tabelle = true; continue; }
    if (tabelle) {
      const t = z.trim().split(/\s+/);
      if (t.length >= 5 && /^\/dev\//.test(t[t.length - 1])) geraete.push({ pfad: t[t.length - 1], rolle: t.slice(4, -1).join(' ') });
      else if (t.length >= 4 && t[t.length - 1] === 'removed') geraete.push({ pfad: null, rolle: 'removed' });
      continue;
    }
    const i = z.indexOf(' : ');
    if (i > 0) w[z.slice(0, i).trim()] = z.slice(i + 3).trim();
  }
  return {
    zustand: w.State || '', stufe: w['Raid Level'] || '', groesse: Number((/^(\d+)/.exec(w['Array Size'] || '') || [])[1]) * 1024 || 0,
    uuid: w.UUID || '', aktiv: Number(w['Active Devices']) || 0, gesamt: Number(w['Raid Devices']) || 0, defekt: Number(w['Failed Devices']) || 0, ersatz: Number(w['Spare Devices']) || 0, geraete,
    nutzgroesse: Number((/^(\d+)/.exec(w['Used Dev Size'] || '') || [])[1]) * 1024 || 0, bitmap: /internal/i.test(w['Intent Bitmap'] || '') || /bitmap/i.test(w['Consistency Policy'] || ''),
  };
}

/** Bewertung für Oberfläche und Meldungen: ok | wiederaufbau | beeintraechtigt | ausgefallen | fehlt. */
export function zustandBewerten(detail, mdstat) {
  if (!detail || !detail.gesamt) return 'fehlt';
  const z = detail.zustand.toLowerCase();
  // FAILED/inactive = nicht mehr nutzbar (RAID 0 mit fehlender Platte, RAID 5 mit zwei fehlenden …)
  if (/failed|inactive/.test(z) || detail.aktiv === 0 || (detail.stufe === 'raid0' && detail.aktiv < detail.gesamt)) return 'ausgefallen';
  if (mdstat && mdstat.fortschritt && /recovery|reshape/.test(mdstat.fortschritt.art)) return 'wiederaufbau';
  if (/degraded/.test(z) || detail.aktiv < detail.gesamt) return 'beeintraechtigt';
  return 'ok';
}

/** Verwalteter Block in /etc/mdadm/mdadm.conf (ARRAY-Zeilen der FAH-NAS-Verbünde). */
export function mdadmConfBlock(text, zeilen) {
  const anfang = '# FAH-NAS Speicherverbünde – Anfang (nicht von Hand ändern)';
  const ende = '# FAH-NAS Speicherverbünde – Ende';
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ohne = String(text || '').replace(new RegExp(`\\n?${esc(anfang)}[\\s\\S]*?${esc(ende)}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  if (!zeilen.length) return `${ohne}\n`;
  return `${ohne}\n\n${anfang}\n${zeilen.join('\n')}\n${ende}\n`;
}

/** Welche Erweiterung passt? raid5/raid6: Platten dazu; raid1 mit 2 Platten: Umbau zu RAID 5 (oder weiterer Spiegel). */
export function erweiterungPruefen(v, { gesamt, neu = 0, ziel = v && v.stufe } = {}) {
  if (!v || !['raid1', 'raid5', 'raid6'].includes(v.stufe)) throw fehler('RAID 0 und RAID 10 lassen sich hier nicht erweitern', 'name');
  if (ziel !== v.stufe && !(v.stufe === 'raid1' && ziel === 'raid5')) throw fehler('Möglich ist nur der Umbau von RAID 1 zu RAID 5', 'stufe');
  if (ziel === 'raid5' && v.stufe === 'raid1' && gesamt !== 2) throw fehler('Den Umbau zu RAID 5 gibt es nur für ein RAID 1 aus zwei Platten', 'stufe');
  if (neu < 1) throw fehler('Bitte mindestens eine neue Platte wählen', 'platten');
  if (gesamt + neu > 16) throw fehler('Höchstens 16 Platten je Verbund', 'platten');
  return { ziel, gesamt: gesamt + neu, umbau: ziel !== v.stufe };
}

/** Lohnt „größere Platten nutzen“? Kleinste Mitgliedsplatte ist mindestens 1 GiB größer als der genutzte Teil. */
export function vergroesserbar(nutzgroesse, mitgliedGroessen) {
  if (!nutzgroesse || !mitgliedGroessen.length) return false;
  return Math.min(...mitgliedGroessen) - nutzgroesse > 1024 ** 3 + 64 * 1024 ** 2; // + Platz für Metadaten
}
