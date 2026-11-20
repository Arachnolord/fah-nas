// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Statische Oberfläche aus public/: sicheres Pfadauflösen (kein .., keine versteckten Dateien, kein Verlassen der
// Wurzel), korrekte MIME-Typen, ETag aus dem Inhalt (im Speicher), index.html no-store, Rest no-cache (ETag-Nachfrage, 304).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PUBLIC_STANDARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
});

const MAX_IM_SPEICHER = 4 * 1024 * 1024; // größere Dateien werden nicht im Speicher gehalten

const HTML_404 = '<!doctype html><html lang="de"><meta charset="utf-8"><title>Nicht gefunden</title>'
  + '<body style="font-family:system-ui;margin:3rem"><h1>404 – Seite nicht gefunden</h1><p><a href="/">Zur Startseite</a></p></body></html>';

export class Statisch {
  constructor(ordner = PUBLIC_STANDARD) {
    this.ordner = path.resolve(ordner);
    this.speicher = new Map(); // absoluter Pfad → {mtimeMs, groesse, etag, inhalt}
  }

  /**
   * Löst einen URL-Pfad sicher innerhalb der Wurzel auf. Gibt den absoluten Pfad oder null (verboten/ungültig).
   * "/" → index.html. "/public/<x>" (Vertrag §5) und "/<x>" zeigen beide auf public/<x>.
   * Segmente mit "..", leere oder versteckte (".") Segmente sind verboten.
   */
  aufloesen(urlPfad) {
    let p;
    try { p = decodeURIComponent(urlPfad); } catch { return null; }
    if (p.includes('\0') || p.includes('\\')) return null;
    if (p === '/' || p === '') p = '/index.html';
    const teile = p.split('/').filter((t) => t !== '');
    if (teile.length > 1 && teile[0] === 'public') teile.shift();
    if (teile.length === 0) return null;
    for (const t of teile) if (t === '.' || t === '..' || t.startsWith('.')) return null;
    const ziel = path.resolve(this.ordner, ...teile);
    if (ziel !== this.ordner && !ziel.startsWith(this.ordner + path.sep)) return null;
    return ziel;
  }

  async _laden(abs) {
    let st;
    try { st = await fs.stat(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const alt = this.speicher.get(abs);
    if (alt && alt.mtimeMs === st.mtimeMs && alt.groesse === st.size) return alt;
    if (st.size > MAX_IM_SPEICHER) {
      const eintrag = { mtimeMs: st.mtimeMs, groesse: st.size, etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, inhalt: null };
      this.speicher.set(abs, eintrag);
      return eintrag;
    }
    const inhalt = await fs.readFile(abs);
    const etag = `"${crypto.createHash('sha256').update(inhalt).digest('base64url').slice(0, 22)}"`;
    const eintrag = { mtimeMs: st.mtimeMs, groesse: st.size, etag, inhalt };
    this.speicher.set(abs, eintrag);
    return eintrag;
  }

  nichtGefunden(res) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(HTML_404), 'Cache-Control': 'no-store' });
    res.end(HTML_404);
  }

  /** Bedient GET/HEAD. Unbekanntes → 404 HTML. „/novnc/…“ kommt aus dem Ubuntu-Paket novnc (VM-Konsole). */
  async bedienen(req, res, urlPfad) {
    if (typeof urlPfad === 'string' && urlPfad.startsWith('/novnc/')) {
      if (!/\.(js|css|svg|png|ico|json|woff2?)$/i.test(urlPfad)) return this.nichtGefunden(res);
      if (!this.novnc) this.novnc = new Statisch(process.env.FAHNAS_NOVNC || '/usr/share/novnc');
      return this.novnc.bedienen(req, res, urlPfad.slice('/novnc'.length));
    }
    const abs = this.aufloesen(urlPfad);
    if (!abs) return this.nichtGefunden(res);
    const d = await this._laden(abs);
    if (!d) return this.nichtGefunden(res);
    const istIndex = path.basename(abs) === 'index.html';
    const kopf = {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      // no-cache = immer mit ETag nachfragen (304, wenn unverändert): nach `fahnas update` zeigt der nächste Seitenaufruf die neue
      // Oberfläche. Mit max-age=3600 lief bis zu eine Stunde die alte Ansicht gegen die neue API (Betreiber-Fund 28.09., 0.4.1).
      'Cache-Control': istIndex ? 'no-store' : 'no-cache',
      ETag: d.etag,
      'Content-Length': d.groesse,
    };
    if (!istIndex && req.headers['if-none-match'] && req.headers['if-none-match'].split(',').map((t) => t.trim()).includes(d.etag)) {
      res.writeHead(304, { ETag: d.etag, 'Cache-Control': kopf['Cache-Control'] });
      return res.end();
    }
    res.writeHead(200, kopf);
    if (req.method === 'HEAD') return res.end();
    if (d.inhalt) return res.end(d.inhalt);
    // große Datei: streamen
    const fh = await fs.open(abs, 'r');
    const strom = fh.createReadStream();
    strom.on('error', () => res.destroy());
    strom.pipe(res);
  }
}
