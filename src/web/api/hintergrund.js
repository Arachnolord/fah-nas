// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigene Tapete je Nutzer (Betreiber 12.10.2026: „animierte wallpaper oder videos als wallpaper … individuell für jeden
// nutzer“): POST /api/hintergrund (Rohdaten, Bild/GIF/Video), GET /api/hintergrund (nur die eigene Datei, mit Range für
// Videos), POST /api/hintergrund/loeschen. Ablage im Ordner des Web-Dienstes (/data/config/web/hintergrund/), Dateiname =
// Hash des Nutzernamens. Welche Tapete gilt, steht in den persönlichen Einstellungen (Bereich „darstellung“).
// Seit 15.10.2026 (Betreiber: „auf ein folder verweisen um zwischen verschiedenen hochgeladenen wallpaper auswählen zu
// können“) eine Sammlung je Nutzer: Ordner <hash>/ mit <id>.<ext> und namen.json, GET /api/hintergrund/liste,
// GET /api/hintergrund?id=, POST /api/hintergrund/loeschen?id=. Die frühere Einzeldatei <hash>.<ext> zieht beim ersten
// Zugriff als id ALT_ID in die Sammlung um (gleiche Änderungszeit → gleiches v). Tapeten aus einem Freigabe-Ordner
// laufen nicht hier, sondern über /api/dateien (mit den Rechten des Nutzers).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { json } from '../server.js';
import { bereichAusRange } from './dateien.js';

export const MAX_BYTES = 300 * 1024 * 1024;
export const MAX_ANZAHL = 30;
export const ALT_ID = '000000000000';
export const TYPEN = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm' });
const MIME = Object.freeze(Object.fromEntries(Object.entries(TYPEN).map(([m, e]) => [e, m])));
export const istVideo = (ext) => ext === 'mp4' || ext === 'webm';
const ID = /^[0-9a-f]{12}$/;
const DATEI = /^([0-9a-f]{12})\.([a-z0-9]{3,4})$/;

/** Anzeigename aus dem Upload: ohne Pfad und Steuerzeichen, höchstens 80 Zeichen. */
export function anzeigename(roh) {
  // eslint-disable-next-line no-control-regex
  const n = String(roh || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return n || 'Tapete';
}

export class HintergrundApi {
  constructor({ ordner }) { this.ordner = path.join(ordner, 'hintergrund'); }

  basis(nutzer) { return path.join(this.ordner, crypto.createHash('sha256').update(String(nutzer)).digest('hex').slice(0, 24)); }

  /** Nutzer umbenannt: Sammlung (und eine alte Einzeldatei) unter den Ordner des neuen Namens. */
  async umbenennen(alt, neu) {
    const von = this.basis(alt); const nach = this.basis(neu);
    for (const [a, b] of [[von, nach], ...Object.values(TYPEN).map((ext) => [`${von}.${ext}`, `${nach}.${ext}`])]) {
      try { await fsp.rename(a, b); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  /** Sammlungsordner des Nutzers; eine alte Einzeldatei zieht dabei hinein. */
  async sammlung(nutzer, anlegen = false) {
    const dir = this.basis(nutzer);
    for (const ext of Object.values(TYPEN)) {
      const alt = `${dir}.${ext}`;
      try { await fsp.stat(alt); } catch { continue; }
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.rename(alt, path.join(dir, `${ALT_ID}.${ext}`));
      await this.namenSetzen(nutzer, ALT_ID, istVideo(ext) ? 'Video' : 'Bild');
    }
    if (anlegen) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async namen(nutzer) { try { const n = JSON.parse(await fsp.readFile(path.join(this.basis(nutzer), 'namen.json'), 'utf8')); return n && typeof n === 'object' ? n : {}; } catch { return {}; } }
  async namenSetzen(nutzer, id, name) {
    const n = await this.namen(nutzer);
    if (name === null) delete n[id]; else n[id] = name;
    const ziel = path.join(this.basis(nutzer), 'namen.json');
    await fsp.writeFile(`${ziel}.neu`, JSON.stringify(n), { mode: 0o600 });
    await fsp.rename(`${ziel}.neu`, ziel);
  }

  /** Alle Tapeten des Nutzers → [{id, name, art, groesse, v, pfad, ext}], älteste zuerst. */
  async liste(nutzer) {
    const dir = await this.sammlung(nutzer);
    let dateien = [];
    try { dateien = await fsp.readdir(dir); } catch { return []; }
    const namen = await this.namen(nutzer);
    const aus = [];
    for (const f of dateien) {
      const m = DATEI.exec(f);
      if (!m || !MIME[m[2]]) continue;
      try {
        const st = await fsp.stat(path.join(dir, f));
        aus.push({ id: m[1], name: typeof namen[m[1]] === 'string' ? namen[m[1]] : f, art: istVideo(m[2]) ? 'video' : 'bild', groesse: st.size, v: Math.floor(st.mtimeMs).toString(36), pfad: path.join(dir, f), ext: m[2], zeit: st.mtimeMs });
      } catch { /* gerade gelöscht */ }
    }
    return aus.sort((a, b) => a.zeit - b.zeit || a.id.localeCompare(b.id));
  }

  /** Eine Tapete des Nutzers oder null. Ohne id (alte Oberfläche): die übernommene Einzeldatei. */
  async datei(nutzer, id = ALT_ID) { return (await this.liste(nutzer)).find((x) => x.id === id) || null; }

  async alleLoeschen(nutzer) {
    await this.sammlung(nutzer);
    await fsp.rm(this.basis(nutzer), { recursive: true, force: true });
  }

  routen(router) {
    router.add('GET', '/api/hintergrund/liste', { sitzung: 'voll' }, async (ctx) => {
      const l = await this.liste(ctx.sitzung.nutzer);
      json(ctx.res, 200, { ok: true, ergebnis: { eintraege: l.map(({ id, name, art, groesse, v }) => ({ id, name, art, groesse, v })), max: MAX_ANZAHL, max_bytes: MAX_BYTES } });
    });
    router.add('POST', '/api/hintergrund', { sitzung: 'voll', csrf: true }, (ctx) => this.hochladen(ctx));
    router.add('GET', '/api/hintergrund', { sitzung: 'voll' }, (ctx) => this.liefern(ctx));
    router.add('POST', '/api/hintergrund/loeschen', { sitzung: 'voll', csrf: true }, async (ctx) => {
      const id = ctx.query.get('id');
      if (id === null || id === '') { await this.alleLoeschen(ctx.sitzung.nutzer); json(ctx.res, 200, { ok: true, ergebnis: { geloescht: true } }); return; }
      if (!ID.test(id)) throw new FahnasFehler('E_PARAMS', 'Ungültige Tapete', { feld: 'id' });
      const d = await this.datei(ctx.sitzung.nutzer, id);
      if (!d) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Tapete gibt es nicht (mehr)');
      await fsp.rm(d.pfad, { force: true });
      await this.namenSetzen(ctx.sitzung.nutzer, id, null);
      json(ctx.res, 200, { ok: true, ergebnis: { geloescht: true, id } });
    });
  }

  async hochladen(ctx) {
    const { req, res } = ctx;
    const typ = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = TYPEN[typ];
    // abgelehnte Uploads: Verbindung schließen statt den (evtl. großen) Rest abzuwarten
    const ablehnen = (f) => { res.setHeader('Connection', 'close'); req.on('end', () => {}); req.resume(); throw f; };
    if (!ext) ablehnen(new FahnasFehler('E_PARAMS', 'Bitte ein Bild (JPG, PNG, WebP, GIF, AVIF) oder Video (MP4, WebM) wählen', { feld: 'datei' }));
    const laenge = Number(req.headers['content-length']);
    if (Number.isFinite(laenge) && laenge > MAX_BYTES) ablehnen(new FahnasFehler('E_PLATZ', `Die Datei ist zu groß (höchstens ${MAX_BYTES / 1024 ** 2} MB)`, { feld: 'datei' }));
    const nutzer = ctx.sitzung.nutzer;
    if ((await this.liste(nutzer)).length >= MAX_ANZAHL) ablehnen(new FahnasFehler('E_PLATZ', `Höchstens ${MAX_ANZAHL} eigene Tapeten – bitte erst eine entfernen`, { feld: 'datei' }));
    const dir = await this.sammlung(nutzer, true);
    const id = crypto.randomBytes(6).toString('hex');
    const ziel = path.join(dir, `${id}.${ext}`);
    const tmp = `${ziel}.${crypto.randomBytes(4).toString('hex')}.neu`;
    let gezaehlt = 0;
    await new Promise((fertig, fehler) => {
      const aus = fs.createWriteStream(tmp, { mode: 0o600 });
      let zuGross = false;
      req.on('data', (d) => { gezaehlt += d.length; if (gezaehlt > MAX_BYTES && !zuGross) { zuGross = true; req.unpipe(aus); aus.destroy(); req.resume(); fehler(new FahnasFehler('E_PLATZ', `Die Datei ist zu groß (höchstens ${MAX_BYTES / 1024 ** 2} MB)`, { feld: 'datei' })); } });
      req.on('error', fehler); aus.on('error', fehler);
      aus.on('finish', () => { if (!zuGross) fertig(); });
      req.pipe(aus);
    }).catch(async (e) => { await fsp.rm(tmp, { force: true }); throw FahnasFehler.aus(e); });
    if (!gezaehlt) { await fsp.rm(tmp, { force: true }); throw new FahnasFehler('E_PARAMS', 'Die Datei ist leer', { feld: 'datei' }); }
    await fsp.rename(tmp, ziel);
    const name = anzeigename(ctx.query.get('name'));
    await this.namenSetzen(nutzer, id, name);
    const d = await this.datei(nutzer, id);
    json(res, 200, { ok: true, ergebnis: { id, name, art: istVideo(ext) ? 'video' : 'bild', groesse: d.groesse, v: d.v } });
  }

  async liefern(ctx) {
    const { req, res } = ctx;
    const id = ctx.query.get('id') || ALT_ID;
    if (!ID.test(id)) throw new FahnasFehler('E_PARAMS', 'Ungültige Tapete', { feld: 'id' });
    const d = await this.datei(ctx.sitzung.nutzer, id);
    if (!d) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Keine eigene Tapete hochgeladen');
    const kopf = { 'Content-Type': MIME[d.ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
    const b = bereichAusRange(req.headers.range, d.groesse);
    if (b && b.unerfuellbar) { res.writeHead(416, { ...kopf, 'Content-Range': `bytes */${d.groesse}` }); res.end(); return; }
    if (b) {
      res.writeHead(206, { ...kopf, 'Content-Range': `bytes ${b.start}-${b.ende}/${d.groesse}`, 'Content-Length': b.ende - b.start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(d.pfad, { start: b.start, end: b.ende }).pipe(res);
      return;
    }
    res.writeHead(200, { ...kopf, 'Content-Length': d.groesse });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(d.pfad).pipe(res);
  }
}
