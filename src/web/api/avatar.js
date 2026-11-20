// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatare (0.22.0, Betreiber 19.10.2026: „avatar/bild … was dann als userbild überall angezeigt wird“):
// GET /api/avatar/:name?v= liefert das Bild eines Nutzers aus dem Agenten (nutzer.avatar.lesen, mit den Rechten der
// Sitzung). Nur mit voller Sitzung – Chat-Gäste sehen keine Avatare (die Adresse trüge den Login-Namen). Passt v zur
// aktuellen Version, darf der Browser das Bild ein Jahr behalten (neues Bild → neue Version → neue Adresse), sonst nur
// kurz. Nie als Dokument ausführbar, nur als Bild einbettbar. Gesetzt wird über die Aktionen (nutzer.avatar.setzen).

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';

const NAME = MUSTER_NUTZERNAME;
const MIME = /^image\/(webp|jpeg|png)$/;
const VERSION = /^[0-9a-f]{12}$/;

export function avatarRouten(router, { agent }) {
  router.add('GET', '/api/avatar/:name', { sitzung: 'voll' }, async (ctx) => {
    const { res, query, kontext } = ctx;
    const name = ctx.params.name;
    if (!NAME.test(String(name))) throw new FahnasFehler('E_PARAMS', 'Nutzername ungültig', { feld: 'name' });
    const erg = await agent.aktion('nutzer.avatar.lesen', { name }, kontext);
    if (res.destroyed) return;
    const daten = Buffer.from(String((erg && erg.daten) || ''), 'base64');
    if (!daten.length) throw new FahnasFehler('E_AGENT', 'Der Steuerdienst lieferte kein Bild');
    const v = query.get('v');
    const dauerhaft = !!v && VERSION.test(v) && v === erg.v;
    res.writeHead(200, {
      'Content-Type': MIME.test(String(erg.mime)) ? erg.mime : 'application/octet-stream',
      'Content-Length': String(daten.length),
      'Cache-Control': dauerhaft ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(daten);
  });
}
