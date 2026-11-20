// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Anhänge (Plan 02): anhaenge/<raum>/<id> + <id>.json {id, name, groesse, mime, von, zeit, nachricht} im
// Chat-Speicher (root, 0600). Hochladen über den Datenkanal (als root in <id>.teil, der Abschluss benennt um), Binden an
// genau eine eigene Nachricht, Lesen/Vorschau als root für berechtigte Leser, Aufräumen ungebundener Reste nach 24 h.

import fs from 'node:fs/promises';
import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { pruefeDateiname } from '../../gemeinsam/pfade.js';
import { mimeVon } from '../helfer/dateihelfer.js';
import { anhangOrdner, neueAnhangId, chatWurzel, DATEIMODUS, ORDNERMODUS, S } from './ablage.js';
import { chatEinstellungen } from './raeume.js';
import { vorschauFuer, vorschauArt, plattenPlatz } from '../aktionen/dateien.js';

export const RESTE_MS = 24 * 3_600_000;
const ROOT = Object.freeze({ uid: 0, gid: 0, gruppen: [] });

async function ordnerSicher(w, raumId) {
  const o = anhangOrdner(w, raumId);
  await fs.mkdir(o, { recursive: true, mode: ORDNERMODUS });
  await fs.chmod(o, ORDNERMODUS);
  return o;
}

async function metaSchreiben(w, raumId, meta) {
  const datei = path.join(anhangOrdner(w, raumId), `${meta.id}.json`);
  const tmp = `${datei}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta) + '\n', { mode: DATEIMODUS });
  await fs.chmod(tmp, DATEIMODUS);
  await fs.rename(tmp, datei);
}

/** Metadaten eines Anhangs oder null (auch bei ungültiger ID). */
export async function metaLaden(w, raumId, anhangId) {
  if (typeof anhangId !== 'string' || !S.anhang.muster.test(anhangId)) return null;
  try { return JSON.parse(await fs.readFile(path.join(anhangOrdner(w, raumId), `${anhangId}.json`), 'utf8')); } catch { return null; }
}

/** Ansichten der Anhänge einer Nachricht (fehlende Metadaten werden übergangen). */
export async function anhangAnsichten(w, raumId, ids) {
  const aus = [];
  for (const id of ids || []) {
    const m = await metaLaden(w, raumId, id);
    if (m) aus.push({ id: m.id, name: m.name, groesse: m.groesse, mime: m.mime, bild: /^image\//.test(m.mime), video: /^video\//.test(m.mime) });
  }
  return aus;
}

async function groessePruefen(w, groesse) {
  const max = (await chatEinstellungen(w)).max_anhang_mb * 1048576;
  if (groesse > max) throw new FahnasFehler('E_PARAMS', 'Die Datei ist größer als erlaubt', { feld: 'groesse', max });
}

/** Reserve auf der Datenplatte, die der Chat (schreibt als root, ohne Kontingent) nie anrührt: 5 %, mindestens 2 GiB. */
export const RESERVE_ANTEIL = 0.05;
export const RESERVE_MIN_BYTES = 2 * 1024 ** 3;

/** Freien Platz prüfen (Prüfbericht Plan 02, Befund 6): sonst E_PLATZ – Konfig, Freigaben und Schnappschüsse brauchen Luft. */
async function platzPruefen(w, groesse) {
  let p;
  try { p = await plattenPlatz(w.system, chatWurzel(w)); } catch (e) { process.stderr.write(`[chat] Platzprüfung: ${e.message}\n`); return; }
  const frei = Math.max(0, p.frei - Math.max(RESERVE_MIN_BYTES, Math.floor(p.gesamt * RESERVE_ANTEIL)));
  if (groesse > frei) throw new FahnasFehler('E_PLATZ', 'Nicht genug freier Platz für diesen Anhang', { noetig: groesse, frei });
}

/** Fertige .teil-Datei übernehmen: umbenennen, 0600, Metadaten. */
async function uebernehmen(w, raumId, { id, teil, name, groesse, von }) {
  const ziel = path.join(anhangOrdner(w, raumId), id);
  await fs.rename(teil, ziel);
  await fs.chmod(ziel, DATEIMODUS);
  const mime = mimeVon(name);
  await metaSchreiben(w, raumId, { id, name, groesse, mime, von, zeit: new Date().toISOString(), nachricht: null });
  return { id, name, groesse, mime };
}

/** Upload-Ticket: der Datenkanal schreibt als root nach <id>.teil; der Abschluss legt den Anhang an. */
export async function hochladeTicket(w, raum, { von, ticketNutzer, name, groesse }) {
  pruefeDateiname(name, 'name');
  await groessePruefen(w, groesse);
  const ordner = await ordnerSicher(w, raum.id);
  await platzPruefen(w, groesse);
  const id = neueAnhangId();
  const teil = path.join(ordner, `${id}.teil`);
  return w.datenkanal.ticket({
    nutzer: ticketNutzer, ...ROOT, art: 'schreiben', pfad: teil, dateiname: name, groesse, mime: mimeVon(name),
    abschluss: async (erfolg) => {
      if (!erfolg) { await fs.rm(teil, { force: true }); return null; }
      return uebernehmen(w, raum.id, { id, teil, name, groesse, von });
    },
  });
}

/** Anhänge an eine Nachricht binden: nur eigene, ungebundene, aus diesem Raum, keine Doppelten. */
export async function anhaengeBinden(w, raum, ids, von, nachrichtId) {
  if (new Set(ids).size !== ids.length) throw new FahnasFehler('E_PARAMS', 'Ein Anhang ist doppelt angegeben', { feld: 'anhaenge' });
  const metas = [];
  for (const id of ids) {
    const m = await metaLaden(w, raum.id, id);
    if (!m || m.von !== von || m.nachricht !== null) throw new FahnasFehler('E_PARAMS', 'Diesen Anhang kannst du nicht senden', { feld: 'anhaenge' });
    metas.push(m);
  }
  for (const m of metas) await metaSchreiben(w, raum.id, { ...m, nachricht: nachrichtId });
  return metas;
}

/** Anhangdateien samt Metadaten löschen. */
export async function anhaengeLoeschen(w, raumId, ids) {
  for (const id of ids || []) {
    if (!S.anhang.muster.test(String(id))) continue;
    await fs.rm(path.join(anhangOrdner(w, raumId), id), { force: true });
    await fs.rm(path.join(anhangOrdner(w, raumId), `${id}.json`), { force: true });
  }
}

/** Lese-Ticket (als root, für `ticketNutzer`) oder mit `vorschau` ein Vorschaubild {mime, daten base64}. */
export async function leseTicket(w, raum, anhangId, { ticketNutzer, vorschau = null }) {
  const meta = await metaLaden(w, raum.id, anhangId);
  if (!meta) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Anhang gibt es nicht', { feld: 'anhang' });
  const abs = path.join(anhangOrdner(w, raum.id), meta.id);
  if (vorschau) {
    const art = vorschauArt(meta.name);
    if (!art) throw new FahnasFehler('E_PARAMS', 'Für diese Datei gibt es kein Vorschaubild', { feld: 'vorschau' });
    // Anhänge (auch von Gästen) nie als root durch ffmpeg: abgeschottet als nobody mit der Datei als Deskriptor
    const v = await vorschauFuer(w).holen({ abs, groesse: vorschau, art, abgeschottet: true });
    return { mime: v.mime, daten: Buffer.from(v.daten).toString('base64') };
  }
  return w.datenkanal.ticket({ nutzer: ticketNutzer, ...ROOT, art: 'lesen', pfad: abs, dateiname: meta.name, groesse: meta.groesse, mime: meta.mime });
}

/** Datei aus einer Freigabe in den Chat-Speicher kopieren (cat als Nutzer → dd als root); ungebundener Anhang. */
export async function ausDatei(w, raum, { von, quelleAbs, quelleIds, name, groesse, stromKopieren }) {
  await groessePruefen(w, groesse);
  const ordner = await ordnerSicher(w, raum.id);
  await platzPruefen(w, groesse);
  const id = neueAnhangId();
  const teil = path.join(ordner, `${id}.teil`);
  try {
    await stromKopieren(w, { quelleAbs, quelleIds, zielAbs: teil, zielIds: ROOT });
  } catch (e) { await fs.rm(teil, { force: true }); throw e; }
  return uebernehmen(w, raum.id, { id, teil, name, groesse, von });
}

/** Ungebundene Anhänge und .teil-Reste, die älter als 24 h sind, entfernen. */
export async function aufraeumen(w, jetzt = Date.now()) {
  let geloescht = 0;
  let raeume = [];
  try { raeume = await fs.readdir(path.join(chatWurzel(w), 'anhaenge')); } catch { return { geloescht }; }
  for (const raumId of raeume) {
    const o = path.join(chatWurzel(w), 'anhaenge', raumId);
    let namen = [];
    try { namen = await fs.readdir(o); } catch { continue; }
    for (const n of namen) {
      try {
        if (n.endsWith('.teil')) {
          const st = await fs.stat(path.join(o, n));
          if (jetzt - st.mtimeMs > RESTE_MS) { await fs.rm(path.join(o, n), { force: true }); geloescht++; }
        } else if (n.endsWith('.json')) {
          const m = JSON.parse(await fs.readFile(path.join(o, n), 'utf8'));
          if (m && m.nachricht === null && jetzt - Date.parse(m.zeit) > RESTE_MS) {
            await fs.rm(path.join(o, m.id), { force: true });
            await fs.rm(path.join(o, n), { force: true });
            geloescht++;
          }
        }
      } catch (e) { process.stderr.write(`[chat] Aufräumen ${raumId}/${n}: ${e.message}\n`); }
    }
  }
  return { geloescht };
}
