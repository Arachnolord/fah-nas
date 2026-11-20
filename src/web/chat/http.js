// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat über HTTP (Plan 02): Einladungsseite /einladung/<token> (öffentlich, gebremst wie Freigabelinks), Gast-Beitritt
// mit Keks, Gast-Identität und -Abmelden, Anhänge lesen (inline/herunterladen/Vorschau) und hochladen – für NAS-Nutzer
// (Sitzung) und Gäste (Keks). Gemischte Routen laufen ohne Router-Sitzung, aber mit Herkunftsprüfung für POST.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { json, leseJson, cookieText, cookieAnhaengen } from '../server.js';
import { gastKontext } from '../api/anmelden.js';
import { inhaltslaenge } from '../api/dateien.js';
import { GAST_KEKS, keksLesen } from './identitaet.js';

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const RAUM = /^(r[A-Za-z0-9_-]{16}|d[A-Za-z0-9_-]{20})$/;
const ANHANG = /^a[A-Za-z0-9_-]{16}$/;
const KEKS_ALTER_S = 34_560_000; // 400 Tage
const VORSCHAU = new Set(['128', '256', '512']);
const VORSCHAU_MIME = /^image\/(webp|jpeg|png)$/;

function html(text) { return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** HTML-Hülle der Einladungsseite; `fehler` = 'ungueltig' | 'fehler' | null (dann ohne Skript, nur die Meldung de/en). */
export function einladungSeiteHtml(titel, fehler = null) {
  const kopf = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${html(titel || 'Chat')} – FAH-NAS</title>
<link rel="icon" href="/symbole.svg" type="image/svg+xml">
<link rel="stylesheet" href="/stil.css">
<link rel="stylesheet" href="/ansichten/chat.css">
<link rel="stylesheet" href="/chat-gast.css">
</head>
<body>`;
  if (fehler) {
    const [de, en] = fehler === 'ungueltig'
      ? ['Diese Einladung ist ungültig oder abgelaufen.', 'This invitation is invalid or has expired.']
      : ['Der Chat ist gerade nicht erreichbar. Bitte versuche es später noch einmal.', 'The chat is currently unavailable. Please try again later.'];
    return `${kopf}
<main class="chat-gast-leer"><div class="chat-gast-meldung"><p>${de}</p><p class="chat-gast-schwach" lang="en">${en}</p></div></main>
</body>
</html>
`;
  }
  return `${kopf}
<main id="chat-gast" class="chat-gast" aria-live="polite"></main>
<script type="module" src="/chat-gast.js"></script>
</body>
</html>
`;
}

function seiteSenden(res, status, seite) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(seite), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(seite);
}

/** Identität für gemischte Routen: NAS-Sitzung (ohne offene 2FA) oder Gast-Keks; sonst E_ANMELDUNG. */
async function wer(ctx, dienst) {
  const s = await dienst.auth.sitzungAus(ctx.req).catch(() => null);
  if (s && !s.totp_offen) return { art: 'nutzer', kontext: { nutzer: s.nutzer, rolle: s.rolle, ip: ctx.ip }, ticketNutzer: s.nutzer };
  const ausweis = keksLesen(ctx.req);
  const g = ausweis ? await dienst.pruefer.pruefen(ausweis, ctx.ip) : null;
  if (g) return { art: 'gast', ausweis, gast: g, kontext: gastKontext(ctx.ip), ticketNutzer: `gast:${g.id}` };
  throw new FahnasFehler('E_ANMELDUNG', 'Bitte melde dich an oder tritt über eine Einladung bei');
}

export function chatHttpRouten(router, dienst) {
  const { agent, bremse } = dienst;

  /** Einladung beim Agenten prüfen; ungültige Tokens zählen in der gemeinsamen Bremse (wie Freigabelinks). */
  async function einladung(ctx) {
    const token = ctx.params.token;
    bremse?.pruefen(ctx.ip, '');
    if (!TOKEN.test(token)) { bremse?.fehler(ctx.ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)'); }
    try {
      return await agent.aktion('chat.gast.einladung', { token }, gastKontext(ctx.ip));
    } catch (e) {
      if (e && (e.code === 'E_NICHT_GEFUNDEN' || e.code === 'E_PARAMS')) { bremse?.fehler(ctx.ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)'); }
      throw e;
    }
  }

  router.add('GET', '/einladung/:token', { sitzung: 'keine' }, async (ctx) => {
    let info = null; let fehler = null;
    try { info = await einladung(ctx); } catch (e) { if (e && e.code === 'E_BREMSE') throw e; fehler = e; }
    if (fehler) return seiteSenden(ctx.res, fehler.code === 'E_NICHT_GEFUNDEN' ? 404 : 503, einladungSeiteHtml(null, fehler.code === 'E_NICHT_GEFUNDEN' ? 'ungueltig' : 'fehler'));
    return seiteSenden(ctx.res, 200, einladungSeiteHtml(info.raum_name));
  });

  router.add('GET', '/api/chat/einladung/:token', { sitzung: 'keine' }, async (ctx) => {
    const info = await einladung(ctx);
    const s = await dienst.auth.sitzungAus(ctx.req).catch(() => null);
    const ausweis = keksLesen(ctx.req);
    const g = ausweis ? await dienst.pruefer.pruefen(ausweis, ctx.ip) : null;
    ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    json(ctx.res, 200, { ok: true, ergebnis: { raum_name: info.raum_name, gueltig: true, angemeldet: !!(s && !s.totp_offen), gast_hier: !!(g && g.raum === info.raum) } });
  });

  router.add('POST', '/api/chat/gast/beitreten', { sitzung: 'keine', herkunft: true }, async (ctx) => {
    bremse?.pruefen(ctx.ip, '');
    const body = await leseJson(ctx.req);
    const token = String(body.token || '');
    if (!TOKEN.test(token)) { bremse?.fehler(ctx.ip, ''); throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)'); }
    let r;
    try { r = await agent.aktion('chat.gast.beitreten', { token, name: typeof body.name === 'string' ? body.name : '' }, gastKontext(ctx.ip)); } catch (e) {
      if (e && e.code === 'E_NICHT_GEFUNDEN') bremse?.fehler(ctx.ip, '');
      throw e;
    }
    const g = await dienst.pruefer.pruefen(r.ausweis, ctx.ip);
    cookieAnhaengen(ctx.res, cookieText(GAST_KEKS, `${r.ausweis.id}.${r.ausweis.geheimnis}`, { httpOnly: true, secure: dienst.secure, maxAge: KEKS_ALTER_S }));
    dienst.protokoll?.eintrag?.('chat_gast_beitritt', { ip: ctx.ip, raum: r.raum });
    json(ctx.res, 200, { ok: true, ergebnis: { raum: r.raum, raum_name: g ? g.raum_name : '', name: g ? g.name : '' } });
  });

  router.add('GET', '/api/chat/gast/ich', { sitzung: 'keine' }, async (ctx) => {
    const ausweis = keksLesen(ctx.req);
    const g = ausweis ? await dienst.pruefer.pruefen(ausweis, ctx.ip) : null;
    if (!g) throw new FahnasFehler('E_ANMELDUNG', 'Kein gültiger Gastzugang');
    json(ctx.res, 200, { ok: true, ergebnis: { raum: g.raum, raum_name: g.raum_name, name: g.name, gast: g.id } });
  });

  router.add('POST', '/api/chat/gast/abmelden', { sitzung: 'keine', herkunft: true }, async (ctx) => {
    const ausweis = keksLesen(ctx.req);
    if (ausweis) {
      try { await agent.aktion('chat.gast.verlassen', { ausweis }, gastKontext(ctx.ip)); } catch { /* schon weg */ }
      dienst.pruefer.verwerfen({ gast: ausweis.id });
    }
    cookieAnhaengen(ctx.res, cookieText(GAST_KEKS, '', { httpOnly: true, secure: dienst.secure, maxAge: 0 }));
    json(ctx.res, 200, { ok: true, ergebnis: { abgemeldet: true } });
  });

  router.add('GET', '/api/chat/anhang', { sitzung: 'keine' }, async (ctx) => {
    const raum = ctx.query.get('raum') || ''; const anhang = ctx.query.get('anhang') || ''; const vorschau = ctx.query.get('vorschau');
    if (!RAUM.test(raum) || !ANHANG.test(anhang) || (vorschau !== null && !VORSCHAU.has(vorschau))) throw new FahnasFehler('E_PARAMS', 'Raum, Anhang oder Vorschaugröße ungültig');
    const w = await wer(ctx, dienst);
    const params = { raum, anhang, ...(vorschau ? { vorschau: Number(vorschau) } : {}), ...(w.art === 'gast' ? { ausweis: w.ausweis } : {}) };
    const erg = await agent.aktion(w.art === 'gast' ? 'chat.gast.anhang_lesen' : 'chat.anhang.lesen', params, w.kontext);
    if (vorschau) {
      const daten = Buffer.from(String((erg && erg.daten) || ''), 'base64');
      if (!daten.length) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte kein Vorschaubild');
      ctx.res.writeHead(200, {
        'Content-Type': VORSCHAU_MIME.test(erg.mime) ? erg.mime : 'image/jpeg', 'Content-Length': String(daten.length),
        'Cache-Control': 'private, max-age=604800, immutable', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      ctx.res.end(daten);
      return;
    }
    await dienst.dateien.herunterladen(ctx, erg, { anzeigen: ctx.query.get('herunterladen') !== '1', nutzer: w.ticketNutzer, range: ctx.req.headers.range || null });
  });

  router.add('POST', '/api/chat/hochladen', { sitzung: 'keine', herkunft: true }, async (ctx) => {
    const raum = ctx.query.get('raum') || ''; const name = ctx.query.get('name') || '';
    if (!RAUM.test(raum) || !name || name.length > 255) throw new FahnasFehler('E_PARAMS', 'Raum oder Dateiname ungültig', { feld: !RAUM.test(raum) ? 'raum' : 'name' });
    const groesse = inhaltslaenge(ctx.req);
    const w = await wer(ctx, dienst);
    const t = await agent.aktion(w.art === 'gast' ? 'chat.gast.anhang_ticket' : 'chat.anhang.ticket', { ...(w.art === 'gast' ? { ausweis: w.ausweis } : {}), raum, name, groesse }, w.kontext);
    const erg = await dienst.dateien._hochladenStrom(ctx, t.ticket, w.ticketNutzer);
    if (!erg.ergebnis) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst bestätigte den Anhang nicht');
    json(ctx.res, 200, { ok: true, ergebnis: { anhang: erg.ergebnis } });
  });
}
