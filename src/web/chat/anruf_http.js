// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// HTTP-Endpunkte für Anrufe (Plan 03): ICE-Zugänge für den Browser (NAS-Sitzung oder Gast-Keks) und der Stand des
// STUN/TURN-Dienstes für die Admin-Karte.

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { json } from '../server.js';
import { clientIp } from '../bremse.js';
import { identitaetAus } from './identitaet.js';

export function anrufRouten(router, { chat, turn, auth, vertrauteProxys }) {
  router.add('GET', '/api/chat/ice', { sitzung: 'keine' }, async (ctx) => {
    const ip = ctx.ip ?? clientIp(ctx.req, vertrauteProxys());
    const identitaet = await identitaetAus(ctx.req, { auth, pruefer: chat.pruefer, ip }).catch(() => null);
    if (!identitaet) throw new FahnasFehler('E_ANMELDUNG', 'Bitte melde dich an oder tritt über eine Einladung bei');
    ctx.res.setHeader('Cache-Control', 'no-store');
    json(ctx.res, 200, { ok: true, ergebnis: await turn.ice(identitaet) });
  });

  router.add('GET', '/api/chat/turn', { sitzung: 'voll' }, async (ctx) => {
    if (!ctx.sitzung || ctx.sitzung.rolle !== 'admin') throw new FahnasFehler('E_RECHTE', 'Nur Admins sehen den Vermittlungsdienst');
    json(ctx.res, 200, { ok: true, ergebnis: turn.stand() });
  });
}
