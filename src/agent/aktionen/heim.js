// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „heim.*“ – persönliche Ordner mit Speicherplatz je Nutzer (Betreiber 12.10.2026: „Kontingent je Nutzer“).
// btrfs kennt Grenzen nur je Unterlaufwerk, nicht je Benutzer. Darum bekommt jeder Nutzer auf Wunsch einen eigenen Ordner
// <daten>/homes/<name> (Unterlaufwerk, nur er hat Zugriff) mit eigener Grenze; im Netz erscheint er als \\NAS\<name>
// (Samba [homes]). In users.json je Nutzer: heim {aktiv, groesse_gb}.
// Vom alten NAS übernommene persönliche Ordner (Umstieg, 19.10.2026): heim.quelle = {volume, ordner:'@home/<name>'} –
// dann ist <daten>/homes/<name> ein Bind-Mount auf den Ordner des alten Volumes (keine Grenze, nie verschieben).

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { R } from '../../gemeinsam/schema.js';
import { kontingentPfadAngleichen, kontingentZeigen } from './freigaben.js';
import { GRUPPE_NUTZER } from '../render/linuxnutzer.js';
import { eingehaengt } from '../render/samba.js';
import { heimEinhaengen, heimLoesen, leererPunktWeg } from '../import/einhaengen.js';

export const ORDNER = 'homes';
export function heimWurzel(w) {
  const p = (w && w.pfade) || {};
  return path.join(p.daten || path.dirname(p.shares || PFADE.shares), ORDNER);
}
export const heimPfad = (w, name) => path.join(heimWurzel(w), name);
const existiert = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };

// heim.apply und das Umbenennen eines Nutzers laufen nacheinander: dazwischen hielte heim.apply den schon umbenannten
// Ordner (oder den alten Namen in users.json) für verwaist und schöbe ihn in die Sicherung.
let kette = Promise.resolve();
export function heimExklusiv(fn) {
  const lauf = kette.catch(() => {}).then(fn);
  kette = lauf.catch(() => {});
  return lauf;
}

/** Ist am Platz des neuen Namens schon ein persönlicher Ordner (z. B. eines früher gelöschten Nutzers)? */
export const heimBelegt = (w, name) => existiert(heimPfad(w, name));

/**
 * Persönlichen Ordner beim Umbenennen mitnehmen: btrfs-Unterlaufwerk umbenennen (Grenze bleibt); ein übernommener Ordner
 * (Bind-Mount) wird gelöst – heim.apply bindet ihn danach am neuen Platz. Nur innerhalb von heimExklusiv aufrufen.
 */
export async function heimUmbenennen(w, n, neu) {
  const von = heimPfad(w, n.name);
  if (n.heim?.quelle || await eingehaengt(w.system, von)) { await heimLoesen(w, von); return 'geloest'; }
  if (!(await existiert(von))) return null;
  await fs.rename(von, heimPfad(w, neu));
  return 'umbenannt';
}

/** Ordner eines Nutzers anlegen/angleichen: Unterlaufwerk, nur der Nutzer (0700), Grenze. */
async function heimAnwenden(w, n) {
  const pfad = heimPfad(w, n.name);
  await fs.mkdir(heimWurzel(w), { recursive: true, mode: 0o755 });
  if (n.heim?.quelle) {
    // übernommener Ordner: binden statt anlegen; fehlt das Volume, bleibt der Platz leer (nichts landet auf der Systemplatte)
    await heimEinhaengen(w, n.heim.quelle, pfad);
    await w.system.ausfuehren('chown', [`${n.name}:${GRUPPE_NUTZER}`, pfad]);
    await w.system.ausfuehren('chmod', ['0700', pfad]);
    return;
  }
  if (!(await existiert(pfad))) await w.system.ausfuehren('btrfs', ['subvolume', 'create', pfad]);
  await w.system.ausfuehren('chown', [`${n.name}:${GRUPPE_NUTZER}`, pfad]);
  await w.system.ausfuehren('chmod', ['0700', pfad]);
  await kontingentPfadAngleichen(w, pfad, n.heim && n.heim.groesse_gb ? n.heim.groesse_gb : null);
}

/** Ordner gelöschter Nutzer (oder ausgeschaltete) bleiben – Daten nie still löschen; Gelöschte wandern in die Sicherung. */
async function verwaisteAufbewahren(w, namen) {
  let da = [];
  try { da = await fs.readdir(heimWurzel(w)); } catch { return []; }
  const weg = [];
  const backup = (w.pfade && w.pfade.backup) || PFADE.backup;
  for (const name of da.filter((x) => !namen.has(x))) {
    // übernommener Ordner (Bind-Mount): nur lösen – die Daten liegen auf dem alten Volume und bleiben dort
    if (await eingehaengt(w.system, heimPfad(w, name))) { try { await heimLoesen(w, heimPfad(w, name)); } catch { /* bleibt */ } continue; }
    if (await leererPunktWeg(w, heimPfad(w, name)).catch(() => false)) continue;
    const ziel = path.join(backup, 'geloescht', `${name}-persoenlich-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fs.mkdir(path.dirname(ziel), { recursive: true });
    try { await w.system.ausfuehren('mv', [heimPfad(w, name), ziel]); weg.push(ziel); } catch { /* bleibt */ }
  }
  return weg;
}

export function registriere(reg, w) {
  const nutzerLaden = async () => ((await w.konfig.laden('users.json', null)) || {}).nutzer || [];

  reg.aktion('heim.liste', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Persönliche Ordner: je Nutzer an/aus, Grenze, Belegung',
    ausfuehren: async () => {
      const aus = [];
      for (const n of await nutzerLaden()) {
        const h = n.heim || {};
        let belegt = null;
        if (h.aktiv && !h.quelle && await existiert(heimPfad(w, n.name))) { try { belegt = (await kontingentZeigen(w.system, heimPfad(w, n.name))).belegt; } catch { belegt = null; } }
        aus.push({ name: n.name, aktiv: !!h.aktiv, groesse_gb: h.groesse_gb || null, belegt, quelle: h.quelle || null });
      }
      return aus;
    },
  });

  reg.aktion('heim.setzen', {
    rolle: 'admin', beschreibung: 'Persönlichen Ordner eines Nutzers ein-/ausschalten und seine Grenze setzen',
    schema: { name: R.nutzername, aktiv: { typ: 'boolean', pflicht: true }, groesse_gb: { typ: 'integer', min: 0, max: 1_000_000 } },
    ausfuehren: async (p) => {
      let n = null;
      await w.konfig.aendern('users.json', (d) => {
        n = (d.nutzer || []).find((x) => x.name === p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        const quelle = n.heim?.quelle || null; // übernommener Ordner bleibt übernommen (keine Grenze möglich)
        n.heim = quelle ? { aktiv: p.aktiv, groesse_gb: null, quelle } : { aktiv: p.aktiv, groesse_gb: p.groesse_gb ? p.groesse_gb : null };
        return d;
      });
      if (p.aktiv) await heimAnwenden(w, n);
      else if (n.heim.quelle) await heimLoesen(w, heimPfad(w, n.name));
      await w.intern('freigaben.apply', {}).catch(() => {}); // Samba [homes] neu
      w.konfigGeaendert?.('nutzer');
      return { name: n.name, aktiv: p.aktiv, groesse_gb: n.heim.groesse_gb, pfad: heimPfad(w, n.name) };
    },
  });

  reg.aktion('heim.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Persönliche Ordner angleichen (Start, nach Nutzeränderungen); Ordner gelöschter Nutzer aufbewahren',
    ausfuehren: () => heimExklusiv(async () => {
      const nutzer = await nutzerLaden();
      const fehler = [];
      for (const n of nutzer.filter((x) => x.heim && x.heim.aktiv)) { try { await heimAnwenden(w, n); } catch (e) { fehler.push(`${n.name}: ${e.message}`); } }
      for (const n of nutzer.filter((x) => x.heim && !x.heim.aktiv && x.heim.quelle)) { try { await heimLoesen(w, heimPfad(w, n.name)); } catch { /* bleibt */ } }
      const aufbewahrt = await verwaisteAufbewahren(w, new Set(nutzer.map((x) => x.name)));
      if (fehler.length) throw new FahnasFehler('E_SYSTEM', `Persönliche Ordner: ${fehler.join('; ')}`);
      return { aufbewahrt };
    }),
  });
}
