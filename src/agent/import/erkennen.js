// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Speicher aus einem anderen NAS übernehmen (Betreiber 19.10.2026, Umstieg von UGOS): reine Auswertung ohne Systemzugriff.
// Findet in der lsblk-Ausgabe fremde Datenvolumes (Software-RAID → LVM → ext4/btrfs/xfs wie bei UGOS, Synology & Co., oder
// eine einfache interne Partition), beschreibt ihre Kette (RAID-Stufe, Platten, Volume-Gruppe) und ordnet die Ordner der
// obersten Ebene ein: Freigabe-Ordner (übernehmbar), interne Ordner des alten Systems (@…, lost+found) und @home.

import { NAME_MUSTER } from '../laufwerke/erkennen.js';

/** Dateisysteme, die FAH-NAS als Freigaben übernehmen kann (Rechte per POSIX-ACL). */
export const IMPORT_FS = new Set(['ext4', 'btrfs', 'xfs']);
/** Labels der eigenen Systemplatte – nie anfassen. */
const SYSTEM_LABELS = new Set(['FAHNAS-EFI', 'FAHNAS-SWAP', 'FAHNAS-SYSTEM', 'FAHNAS-DATEN']);
/** Namen, die FAH-NAS für Freigaben reserviert (wie RESERVIERT in aktionen/freigaben.js). */
const RESERVIERT = new Set(['global', 'homes', 'printers', 'print$', 'ipc$', 'alle', 'docker']);

/** LVM-Gerätename „vg-lv“ (Device-Mapper verdoppelt Bindestriche im Namen) → {vg, lv}. */
export function lvmName(dmName) {
  const teile = String(dmName || '').split(/(?<!-)-(?!-)/);
  if (teile.length !== 2) return { vg: null, lv: null };
  return { vg: teile[0].replace(/--/g, '-'), lv: teile[1].replace(/--/g, '-') };
}

/** Herkunft eines Volumes aus Volume-Gruppe und Ordnern: 'UGOS' | 'Synology' | 'QNAP' | null. */
export function herkunftVon({ vg = null, ordner = [] } = {}) {
  const namen = new Set(ordner);
  if ((vg && /^ug_/.test(vg)) || namen.has('@appstore') || (namen.has('@home') && namen.has('@snapshot'))) return 'UGOS';
  if ((vg && /^vg\d+$/.test(vg)) || namen.has('@eaDir') || namen.has('@database') || namen.has('homes')) return 'Synology';
  if ((vg && /^vg\d+$/i.test(vg) && namen.has('.@__thumb')) || namen.has('.qpkg')) return 'QNAP';
  return null;
}

/** Ordner der obersten Ebene einordnen: 'freigabe' | 'heim' | 'intern'. */
export function ordnerArt(name) {
  if (name === '@home' || name === 'homes') return 'heim';
  if (name.startsWith('@') || name.startsWith('.') || name.startsWith('#') || name === 'lost+found' || name === '$RECYCLE.BIN' || name === 'System Volume Information') return 'intern';
  return 'freigabe';
}

/** Ordnername → gültiger Freigabename (klein, a-z0-9-_, höchstens 32), eindeutig gegen `belegt`. „docker“ ist reserviert. */
export function freigabenameVorschlag(ordner, belegt = new Set()) {
  let basis = String(ordner || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32).replace(/[-_]+$/, '');
  if (!basis) basis = 'freigabe';
  if (!/^[a-z0-9]/.test(basis)) basis = `f${basis}`.slice(0, 32);
  if (RESERVIERT.has(basis)) basis = `${basis}-alt`;
  let name = basis; let i = 2;
  while (belegt.has(name) || RESERVIERT.has(name)) { const s = `-${i++}`; name = basis.slice(0, 32 - s.length).replace(/[-_]+$/, '') + s; }
  return NAME_MUSTER.test(name) ? name : `freigabe-${i}`;
}

function zahl(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/**
 * Fremde Datenvolumes aus `lsblk -J -b -o NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,MOUNTPOINTS,MODEL,SERIAL,TRAN`. Ein RAID
 * erscheint unter jeder Mitgliedspartition – Volumes werden deshalb über die UUID zusammengefasst und sammeln alle
 * Platten. Ausgeschlossen: eigene Systemplatte (FAHNAS-Labels), `ausschliessen` (UUIDs eigener Verbünde), eingehängte
 * Dateisysteme (außer unter `importWurzel` – dann gilt es als übernommen), reine USB-Partitionen (→ Laufwerke).
 * → [{uuid, geraet, fstype, label, groesse, art:'lvm'|'raid'|'part', raid:{name,stufe}|null, lvm:{vg,lv}|null, platten:[…], eingehaengt}]
 */
export function volumesAusLsblk(json, { ausschliessen = new Set(), importWurzel = '/data/import' } = {}) {
  const volumes = new Map();
  const besuche = (knoten, kette, platte) => {
    for (const k of knoten || []) {
      if (!k || typeof k.name !== 'string') continue;
      const neueKette = [...kette, k];
      const fs = String(k.fstype || '').toLowerCase();
      if (IMPORT_FS.has(fs) && k.uuid && k.type !== 'loop') {
        const raid = neueKette.find((x) => /^raid|^md$/.test(String(x.type || '')));
        const lvm = k.type === 'lvm' ? lvmName(k.name) : null;
        const v = volumes.get(k.uuid) || {
          uuid: k.uuid, geraet: k.path || `/dev/${k.name}`, fstype: fs, label: k.label || null, groesse: zahl(k.size),
          art: lvm ? 'lvm' : raid ? 'raid' : 'part', raid: raid ? { name: raid.name, geraet: raid.path || `/dev/${raid.name}`, stufe: String(raid.type) } : null,
          // alle Einhängepunkte: ein übernommenes Volume hängt zusätzlich am alten Pfad (/volumeN) – MOUNTPOINT zeigt nur einen
          lvm, platten: [], einhaengepunkte: [...new Set([...(Array.isArray(k.mountpoints) ? k.mountpoints : []), k.mountpoint].filter(Boolean))], system: false, usb: true,
        };
        if (k.label && SYSTEM_LABELS.has(k.label)) v.system = true;
        if (platte) {
          if (!v.platten.some((p) => p.geraet === (platte.path || `/dev/${platte.name}`))) {
            v.platten.push({ geraet: platte.path || `/dev/${platte.name}`, modell: (platte.model || '').trim() || null, seriennummer: platte.serial || null, groesse: zahl(platte.size), tran: platte.tran || null });
          }
          if (platte.tran !== 'usb') v.usb = false;
        }
        volumes.set(k.uuid, v);
      }
      besuche(k.children, neueKette, platte || (k.type === 'disk' || k.type === 'loop' ? k : null)); // loop: Prüfstand mit Abbildern
    }
  };
  besuche((json && json.blockdevices) || [], [], null);
  // Systemplatte: hat irgendeine Partition der Platte ein FAHNAS-Label, gehört die Platte dem System
  const systemPlatten = new Set();
  for (const d of (json && json.blockdevices) || []) if ((d.children || []).some((c) => c && c.label && SYSTEM_LABELS.has(c.label))) systemPlatten.add(d.path || `/dev/${d.name}`);
  const aus = [];
  for (const v of volumes.values()) {
    if (v.system || ausschliessen.has(v.uuid)) continue;
    if (v.platten.some((p) => systemPlatten.has(p.geraet))) continue;
    if (v.art === 'part' && v.usb) continue; // einfache USB-Laufwerke übernimmt die Laufwerke-Ansicht
    const importiert = v.einhaengepunkte.some((m) => m === importWurzel || m.startsWith(`${importWurzel}/`));
    if (v.einhaengepunkte.length && !importiert) continue; // anderswo eingehängt (z. B. von Hand) – nicht anfassen
    delete v.system; delete v.usb;
    aus.push({ ...v, importiert });
  }
  return aus.sort((a, b) => (a.lvm?.vg || a.geraet).localeCompare(b.lvm?.vg || b.geraet) || (a.lvm?.lv || '').localeCompare(b.lvm?.lv || ''));
}

/** Kurzkennung eines Volumes für den Einhängepunkt /data/import/<kurz>. */
export function kurzVon(uuid) { return String(uuid || '').replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase(); }

/**
 * Besitzer-Vorschlag: UGOS-uid → FAH-NAS-Name. Aus @home kennen wir die Namen der alten Konten (Ordner gehört dem Nutzer);
 * gibt es einen FAH-NAS-Nutzer gleichen Namens, wird er vorgeschlagen, sonst root (die Datei gehört dann niemandem –
 * Zugriff regeln ohnehin die Rechte der Freigabe).
 */
export function besitzerVorschlag(uids, heim, fahnasNutzer) {
  const namen = new Map((heim || []).map((h) => [Number(h.uid), h.name]));
  const vorhanden = new Set((fahnasNutzer || []).map((n) => n.name));
  const aus = [];
  for (const uid of [...new Set(uids)].sort((a, b) => a - b)) {
    if (uid === 0) continue;
    const alt = namen.get(uid) || null;
    aus.push({ uid, alt_name: alt, vorschlag: alt && vorhanden.has(alt) ? alt : 'root' });
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// UGOS-Rechte (tools/ugos-export.py liest sie unter UGOS aus system.ugacl_self; nach dem Umstieg sind sie nicht mehr lesbar)
// Aufbau (an echten Ordnern eines DXP4800 Plus entschlüsselt, 19.10.2026): 4 Byte Version (1), dann Einträge zu je 5 × uint32
// little-endian [art, maske, vererbung, id, 0]. art 5/6 = Nutzer, 10 = Gruppe, 34 = „Jeder“ (id 0xffffffff).
// maske 0x37cf = lesen + schreiben, 0x1c5 = nur lesen; Bit 1 (0x2) = Schreiben, Bit 0 (0x1) = Lesen. Wer fehlt, hat keinen Zugriff.
// ---------------------------------------------------------------------------------------------------------------
export const EXPORT_DATEI = 'fahnas-ugos-export.json';

export function ugaclLesen(b64) {
  let b;
  try { b = Buffer.from(String(b64 || ''), 'base64'); } catch { return null; }
  if (b.length < 4 || b.readUInt32LE(0) !== 1 || (b.length - 4) % 20 !== 0) return null;
  const eintraege = []; let unbekannt = 0;
  for (let i = 4; i + 20 <= b.length; i += 20) {
    const art = b.readUInt32LE(i); const maske = b.readUInt32LE(i + 4); const id = b.readUInt32LE(i + 12);
    const recht = maske & 0x2 ? 'schreiben' : maske & 0x1 ? 'lesen' : 'kein';
    if (art === 5 || art === 6) eintraege.push({ art: 'nutzer', id, recht });
    else if (art === 10) eintraege.push({ art: 'gruppe', id, recht });
    else if (art === 34 && id === 0xffffffff) eintraege.push({ art: 'jeder', id: null, recht });
    else unbekannt++;
  }
  return { eintraege, unbekannt };
}

/**
 * Rechte-Vorschlag für einen Ordner aus seinem UGOS-Eintrag: UGOS-Konten werden über den NAMEN auf FAH-NAS-Konten
 * abgebildet (uid/gid dürfen verschieden sein). Admins (UGOS-Gruppe admin bzw. FAH-NAS-Admins) brauchen nichts – sie
 * dürfen ohnehin alles. „Jeder“ → alle FAH-NAS-Nutzer. → {lesen, schreiben, hinweise}
 */
export function rechteVorschlag(ugaclB64, exportDaten, fahnas) {
  const aus = { lesen: new Set(), schreiben: new Set(), hinweise: [] };
  const u = ugaclLesen(ugaclB64);
  if (!u) { aus.hinweise.push('keine UGOS-Rechte gefunden – nur Admins'); return fertig(aus); }
  const uidName = new Map((exportDaten?.nutzer || []).map((n) => [Number(n.uid), n.name]));
  const gidGruppe = new Map((exportDaten?.gruppen || []).map((g) => [Number(g.gid), g]));
  const nutzer = new Map((fahnas.nutzer || []).map((n) => [n.name, n]));
  const gruppen = new Set((fahnas.gruppen || []).map((g) => (typeof g === 'string' ? g : g.name)));
  const geben = (konto, recht) => {
    if (recht === 'schreiben') { aus.schreiben.add(konto); aus.lesen.delete(konto); } else if (recht === 'lesen' && !aus.schreiben.has(konto)) aus.lesen.add(konto);
  };
  const nutzerGeben = (name, recht, quelle) => {
    const n = nutzer.get(name);
    if (!n) { aus.hinweise.push(`${quelle}: „${name}“ gibt es auf FAH-NAS noch nicht`); return; }
    if (n.rolle !== 'admin') geben(name, recht);
  };
  for (const e of u.eintraege) {
    if (e.recht === 'kein') continue;
    if (e.art === 'jeder') { for (const n of nutzer.values()) if (n.rolle !== 'admin') geben(n.name, e.recht); continue; }
    if (e.art === 'nutzer') {
      const name = uidName.get(e.id);
      if (!name) { aus.hinweise.push(`UGOS-Konto uid ${e.id} (gelöscht?) ohne Namen – übersprungen`); continue; }
      nutzerGeben(name, e.recht, 'UGOS-Nutzer');
      continue;
    }
    const g = gidGruppe.get(e.id);
    if (!g || e.id === 10 || g.name === 'admin' || g.name === 'administrators') continue; // UGOS-Admins = FAH-NAS-Admins
    if (gruppen.has(g.name)) geben(`@${g.name}`, e.recht);
    else for (const m of g.mitglieder || []) nutzerGeben(m, e.recht, `Gruppe ${g.name}`);
  }
  if (u.unbekannt) aus.hinweise.push(`${u.unbekannt} unbekannte UGOS-Einträge – bitte prüfen`);
  return fertig(aus);
}
function fertig(a) { return { lesen: [...a.lesen].sort(), schreiben: [...a.schreiben].sort(), hinweise: [...new Set(a.hinweise)] }; }

/**
 * Unterordner mit eigenen UGOS-Rechten → FAH-NAS-Ordnerrechte. UGOS speichert dort die VOLLSTÄNDIGE Liste (am DXP4800 Plus
 * geprüft: Backups/UgreenNAS ohne conny/media). Wer die Freigabe hat, im Unterordner aber weniger, bekommt eine Regel
 * („lesen“ bzw. „keiner“). Mehr Rechte als in der Freigabe kann FAH-NAS nicht abbilden (Ordnerrechte schränken nur ein) →
 * Hinweis. `freigabe` = {lesen, schreiben} des Ordners (Konten wie im Assistenten). → {regeln:[{pfad, regeln}], hinweise}
 */
export function ordnerrechteVorschlag(freigabe, unter, exportDaten, fahnas) {
  const aus = []; const hinweise = [];
  const hat = (konto) => (freigabe.schreiben.includes(konto) ? 'schreiben' : freigabe.lesen.includes(konto) ? 'lesen' : null);
  const konten = [...new Set([...freigabe.schreiben, ...freigabe.lesen])];
  for (const u of unter || []) {
    if (!u || typeof u.pfad !== 'string' || !u.pfad) continue;
    const r = rechteVorschlag(u.ugacl, exportDaten, fahnas);
    const regeln = {};
    for (const konto of konten) {
      const unten = r.schreiben.includes(konto) ? 'schreiben' : r.lesen.includes(konto) ? 'lesen' : null;
      if (unten === 'schreiben') continue;
      if (unten === 'lesen') { if (hat(konto) === 'schreiben') regeln[konto] = 'lesen'; continue; }
      regeln[konto] = 'keiner';
    }
    // Gruppenregeln treffen jedes Mitglied – hatte ein Mitglied hier persönlich mehr, sagen wir es
    for (const [konto, stufe] of Object.entries(regeln)) {
      if (!konto.startsWith('@')) continue;
      for (const n of fahnas.nutzer || []) {
        const persoenlich = r.schreiben.includes(n.name) ? 'schreiben' : r.lesen.includes(n.name) ? 'lesen' : null;
        const mitglied = (n.gruppen || []).map((g) => String(g).replace(/^@/, '')).includes(konto.slice(1))
          || (fahnas.gruppen || []).some((g) => g?.name === konto.slice(1) && (g.mitglieder || []).includes(n.name));
        if (mitglied && persoenlich && !(stufe === 'lesen' && persoenlich === 'lesen')) hinweise.push(`${u.pfad}: Regel für ${konto} trifft auch „${n.name}“, der unter UGOS hier „${persoenlich}“ durfte – bitte prüfen`);
      }
    }
    for (const konto of [...r.schreiben, ...r.lesen]) if (!hat(konto)) hinweise.push(`${u.pfad}: „${konto}“ hätte hier mehr Rechte als in der Freigabe – das kennt FAH-NAS nicht (Freigabe-Rechte erweitern und Ordnerrechte setzen)`);
    if (Object.keys(regeln).length) aus.push({ pfad: u.pfad, regeln });
  }
  return { regeln: aus, hinweise: [...new Set(hinweise)] };
}

/**
 * Alter Pfad eines Volumes für den Kompatibilitäts-Pfad: aus dem UGOS-Export (Einhängepunkt unter UGOS), sonst aus dem
 * UGOS-Namensschema „…_poolN“ (am DXP4800 Plus geprüft: pool1 → /volume1 … pool4 → /volume4). → '/volumeN' oder null.
 */
export function alterPfadVorschlag({ vg, lv } = {}, exportMount = null) {
  if (typeof exportMount === 'string' && /^\/volume\d{1,2}$/.test(exportMount)) return exportMount;
  const m = /^ug_.*_pool(\d{1,2})$/.exec(String(vg || ''));
  return m && /^volume\d+$/.test(String(lv || '')) ? `/volume${Number(m[1])}` : null;
}

/**
 * Anzeigename eines Volumes. UGOS nennt das LV in jedem Speicherpool „volume1“ – deshalb zählt der alte Pfad (/volume3 →
 * „volume3“), sonst das LV, sonst das Gerät; dazu das Modell der ersten Platte. → „UGOS volume3 · Samsung SSD 980 1TB“
 */
export function volumeName({ herkunft = null, lvm = null, geraet = '', platten = [] } = {}, alterPfad = null) {
  const kern = alterPfad && /^\/volume\d{1,2}$/.test(alterPfad) ? alterPfad.slice(1) : lvm?.lv || String(geraet).split('/').pop() || 'Volume';
  const modell = (platten || []).map((p) => p?.modell).find(Boolean);
  return [[herkunft, kern].filter(Boolean).join(' '), modell].filter(Boolean).join(' · ');
}
