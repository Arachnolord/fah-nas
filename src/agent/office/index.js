// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Index (V14): office.json (0600, nur root) mit allen Dokumenten nach ID – Ort, Besitzer, Office-Freigaben –
// und „zuletzt geöffnet“ je Nutzer. Inhalte liegen nie hier, sondern im Bündel auf der Freigabe. nachfuehren hält den
// Index beim Umbenennen, Verschieben und beim Papierkorb des Dateimanagers mit.

import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { ENDUNGEN, artAusName } from '../../gemeinsam/office.js';

export const INDEX_DATEI = 'office.json';
export const INDEX_STANDARD = Object.freeze({ version: 1, dokumente: {}, zuletzt: {} });
export const ZULETZT_MAX = 20;

/** Index lesen (fehlt die Datei: leerer Index). */
export async function indexLaden(w) {
  const ix = await w.konfig.laden(INDEX_DATEI, INDEX_STANDARD);
  ix.dokumente ??= {}; ix.zuletzt ??= {};
  return ix;
}

/** Lesen-Ändern-Schreiben unter der Sperre der Datei, immer 0600. */
export async function indexAendern(w, fn) {
  return w.konfig.aendern(INDEX_DATEI, (ix) => { ix.dokumente ??= {}; ix.zuletzt ??= {}; return fn(ix); }, INDEX_STANDARD, 0o600);
}

/** Der (nicht gelöschte) Eintrag, dessen Bündel genau an diesem Ort liegt, sonst null. */
export function eintragAmOrt(index, freigabe, pfad) {
  return Object.values(index.dokumente || {}).find((d) => d && !d.geloescht && d.freigabe === freigabe && d.pfad === pfad) ?? null;
}

/** Wert unter einem eigenen Schlüssel (Nutzernamen wie „constructor“ dürfen nie Object.prototype treffen), sonst undefined. */
export function eigen(obj, schluessel) { return obj && typeof obj === 'object' && Object.hasOwn(obj, schluessel) ? obj[schluessel] : undefined; }

/** „Zuletzt geöffnet“: vorn einfügen, ältere Doppel entfernen, auf ZULETZT_MAX kürzen. */
export function zuletztMerken(index, nutzer, id, zeit) {
  index.zuletzt ??= {};
  const alt = eigen(index.zuletzt, nutzer);
  const liste = (Array.isArray(alt) ? alt : []).filter((z) => z && z.id !== id);
  index.zuletzt[nutzer] = [{ id, zeit }, ...liste].slice(0, ZULETZT_MAX);
}

/** Liegt `pfad` gleich `basis` oder darunter (relative Pfade mit „/“)? */
export function pfadUnter(pfad, basis) { return pfad === basis || pfad.startsWith(basis + '/'); }

const jetztIso = (w) => new Date(typeof w.jetzt === 'function' ? w.jetzt() : Date.now()).toISOString();

/**
 * Index nach einer Dateiaktion nachführen (wirft nie; Fehler landen in stderr). `aenderung`:
 * {art:'umbenannt', freigabe, von, nach} | {art:'verschoben', freigabe, nach_freigabe, paare:[{von, nach}]} |
 * {art:'geloescht', freigabe, pfade, endgueltig} | {art:'wiederhergestellt', freigabe, pfade, umbenannt:[{pfad, neu}]} |
 * {art:'korb_geleert', freigabe}. Ereignisse: office {art:'pfad', …} je umgezogenem, {art:'geloescht', id} je
 * verschwundenem Eintrag.
 */
export async function nachfuehren(w, aenderung) {
  try {
    const ereignisse = [];
    const zeit = jetztIso(w);
    await indexAendern(w, (ix) => {
      const vorher = ereignisse.length;
      let geaendert = false;
      const alle = Object.values(ix.dokumente).filter(Boolean);
      const lebend = alle.filter((d) => !d.geloescht);
      const weg = (d) => { delete ix.dokumente[d.id]; geaendert = true; if (!d.geloescht) ereignisse.push({ art: 'geloescht', id: d.id }); };
      const inKorb = (d) => { d.geloescht = zeit; geaendert = true; ereignisse.push({ art: 'geloescht', id: d.id }); };
      // Gleichzeitig umziehen (Serien tauschen Namen): erst planen, dann Ziele frei machen, dann anwenden
      const umziehen = (von, nach, paare) => {
        const plan = []; const bewegt = new Set();
        for (const pa of paare) for (const d of lebend) if (d.freigabe === von && !bewegt.has(d.id) && pfadUnter(d.pfad, pa.von)) { plan.push([d, pa.nach + d.pfad.slice(pa.von.length)]); bewegt.add(d.id); }
        for (const [, pfad] of plan) for (const d of lebend) if (!bewegt.has(d.id) && !d.geloescht && d.freigabe === nach && d.pfad === pfad) inKorb(d);
        for (const [d, pfad] of plan) {
          const datei = pfad.split('/').pop();
          if (artAusName(datei) !== d.art) { weg(d); continue; } // Endung weg oder andere Art → kein Office-Dokument mehr
          Object.assign(d, { freigabe: nach, pfad, name: datei.slice(0, -ENDUNGEN[d.art].length) }); geaendert = true;
          ereignisse.push({ art: 'pfad', id: d.id, freigabe: nach, pfad, name: d.name });
        }
      };
      const f = aenderung.freigabe;
      if (aenderung.art === 'umbenannt') umziehen(f, f, [{ von: aenderung.von, nach: aenderung.nach }]);
      else if (aenderung.art === 'verschoben') umziehen(f, aenderung.nach_freigabe, aenderung.paare || []);
      else if (aenderung.art === 'geloescht') {
        for (const d of alle) {
          if (d.freigabe !== f || !(aenderung.pfade || []).some((p) => pfadUnter(d.pfad, p))) continue;
          if (aenderung.endgueltig) weg(d); else if (!d.geloescht) inKorb(d);
        }
      } else if (aenderung.art === 'wiederhergestellt') {
        const umbenannt = new Map((aenderung.umbenannt || []).map((u) => [u.neu, u.pfad]));
        for (const ziel of aenderung.pfade || []) {
          const ursprung = umbenannt.get(ziel) ?? ziel;
          // je Endpfad nur der zuletzt gelöschte Eintrag (derselbe Ort kann mehrmals im Papierkorb liegen)
          const beste = new Map();
          for (const d of alle) {
            if (d.freigabe !== f || !d.geloescht || !pfadUnter(d.pfad, ursprung)) continue;
            const pfad = ziel + d.pfad.slice(ursprung.length);
            const b = beste.get(pfad);
            if (!b || String(d.geloescht) > String(b[0].geloescht)) beste.set(pfad, [d, pfad]);
          }
          for (const [d, pfad] of beste.values()) {
            for (const x of alle) if (x !== d && !x.geloescht && x.freigabe === f && x.pfad === pfad) inKorb(x); // verschwundenes Bündel am Ziel
            delete d.geloescht; geaendert = true;
            if (pfad !== d.pfad) {
              const datei = pfad.split('/').pop();
              Object.assign(d, { pfad, name: datei.slice(0, -ENDUNGEN[d.art].length) });
              ereignisse.push({ art: 'pfad', id: d.id, freigabe: f, pfad, name: d.name });
            }
          }
        }
      } else if (aenderung.art === 'korb_geleert') {
        for (const d of alle) if (d.freigabe === f && d.geloescht) weg(d);
      }
      if (!geaendert) { ereignisse.length = vorher; return UNVERAENDERT; }
      return ix;
    });
    for (const e of ereignisse) w.ereignis('office', e);
  } catch (f) {
    process.stderr.write(`[office] Index: ${f && f.message}\n`);
  }
}

/**
 * Konto gelöscht (Prüfbericht Plan 04, I2): Office-Freigaben an diesen Namen, sein „Zuletzt“ und sein Besitz fallen weg –
 * ein später gleichnamig angelegter Nutzer erbt nichts. Dokumente des Gelöschten verlieren ihre Office-Freigaben und
 * haben keinen Besitzer mehr (Zugriff nur noch über die Freigabe-Rechte). Je betroffenem Dokument ein Ereignis „rechte“.
 * Wirft nie; → betroffene IDs.
 */
export async function officeKontoEntfernen(w, name) {
  const betroffen = new Set();
  try {
    await indexAendern(w, (ix) => {
      let geaendert = false;
      for (const d of Object.values(ix.dokumente || {})) {
        if (!d) continue;
        if (d.freigaben && Object.hasOwn(d.freigaben, name)) { delete d.freigaben[name]; betroffen.add(d.id); geaendert = true; }
        if (d.besitzer === name) { d.besitzer = null; d.freigaben = {}; betroffen.add(d.id); geaendert = true; }
      }
      if (ix.zuletzt && Object.hasOwn(ix.zuletzt, name)) { delete ix.zuletzt[name]; geaendert = true; }
      return geaendert ? ix : UNVERAENDERT;
    });
  } catch (e) {
    process.stderr.write(`[office] Konto ${name} bereinigen: ${e && e.message}\n`);
    return [];
  }
  for (const id of betroffen) { try { w.ereignis('office', { art: 'rechte', id }); } catch { /* nie werfen */ } }
  return [...betroffen];
}

/**
 * Konto umbenannt: Besitz, Office-Freigaben und „Zuletzt“ gehen auf den neuen Namen über. Je betroffenem Dokument ein
 * Ereignis „rechte“. Wirft nie; → betroffene IDs.
 */
export async function officeKontoUmbenennen(w, alt, neu) {
  const betroffen = new Set();
  try {
    await indexAendern(w, (ix) => {
      let geaendert = false;
      for (const d of Object.values(ix.dokumente || {})) {
        if (!d) continue;
        if (d.besitzer === alt) { d.besitzer = neu; betroffen.add(d.id); geaendert = true; }
        if (d.freigaben && Object.hasOwn(d.freigaben, alt)) {
          d.freigaben = Object.fromEntries(Object.entries(d.freigaben).map(([k, v]) => [k === alt ? neu : k, v]));
          betroffen.add(d.id); geaendert = true;
        }
      }
      if (ix.zuletzt && Object.hasOwn(ix.zuletzt, alt)) { ix.zuletzt[neu] = ix.zuletzt[alt]; delete ix.zuletzt[alt]; geaendert = true; }
      return geaendert ? ix : UNVERAENDERT;
    });
  } catch (e) {
    process.stderr.write(`[office] Konto ${alt} → ${neu}: ${e && e.message}\n`);
    return [];
  }
  for (const id of betroffen) { try { w.ereignis('office', { art: 'rechte', id }); } catch { /* nie werfen */ } }
  return [...betroffen];
}
