// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// VM-Konsole im Browser (Teilprojekt 3): WebSocket /api/vm-konsole?ticket=… ↔ Datenkanal des Agenten (Ticket „tcp“ zum
// VNC-Port der VM auf 127.0.0.1). Eigenes, kleines WebSocket nach RFC 6455 ohne npm-Pakete. Zugang nur mit gültiger
// Sitzung (Admin, ohne offene 2FA), gleicher Herkunft und einem Einmal-Ticket aus genau dieser Sitzung.

import { annahmeSchluessel, rahmen, rahmenLesen, upgradeAblehnen as ablehnen } from './ws.js';
import { datenkanalOeffnen } from './api/dateien.js';
import { FahnasFehler } from '../gemeinsam/fehler.js';

export const PFAD = '/api/vm-konsole';

// Rahmen-Funktionen und Ablehnen liegen seit 0.21.0 in ws.js (gemeinsam mit Chat/Office) und werden hier weitergereicht.
export { annahmeSchluessel, rahmen, rahmenLesen } from './ws.js';

/** Erste Zeile aus dem Datenkanal lesen ({ok:true} oder {fehler}). */
function ersteZeile(kanal) {
  return new Promise((ok, nein) => {
    let puffer = Buffer.alloc(0);
    const daten = (d) => {
      puffer = Buffer.concat([puffer, d]);
      const i = puffer.indexOf(0x0a);
      if (i < 0) { if (puffer.length > 8192) nein(new Error('Kopf zu lang')); return; }
      kanal.removeListener('data', daten); kanal.pause();
      try { ok({ antwort: JSON.parse(puffer.subarray(0, i).toString('utf8')), rest: puffer.subarray(i + 1) }); } catch (e) { nein(e); }
    };
    kanal.on('data', daten);
    kanal.once('error', nein);
    kanal.once('end', () => nein(new Error('Datenkanal zu')));
  });
}

/**
 * Behandler für das „upgrade“-Ereignis des HTTPS-Servers.
 * @param {{auth, tickets, agent, protokoll}} o
 */
export function konsoleUpgrade({ auth, tickets, agent, protokoll }) {
  return async (req, socket, kopf) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://fahnas'); } catch { return ablehnen(socket, 400, 'Bad Request'); }
    if (url.pathname !== PFAD || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return ablehnen(socket, 404, 'Not Found');
    // gleiche Herkunft (Schutz vor Cross-Site-WebSocket-Übernahme)
    try { if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) return ablehnen(socket, 403, 'Forbidden'); } catch { return ablehnen(socket, 403, 'Forbidden'); }
    const s = await auth.sitzungAus(req).catch(() => null);
    if (!s || s.totp_offen || s.rolle !== 'admin') return ablehnen(socket, 401, 'Unauthorized');
    const ticket = url.searchParams.get('ticket') || '';
    const t = /^[A-Za-z0-9_-]{8,128}$/.test(ticket) ? tickets.hole(ticket, s.id) : null;
    if (!t || t.art !== 'konsole') { protokoll?.eintrag('ticket_fremd', { nutzer: s.nutzer, weg: PFAD, ticket: '***' }); return ablehnen(socket, 404, 'Not Found'); }
    let kanal;
    try {
      kanal = await datenkanalOeffnen(agent.datenSocket, { ticket, nutzer: s.nutzer });
      const { antwort, rest } = await ersteZeile(kanal);
      if (!antwort || antwort.ok !== true) throw new FahnasFehler('E_SYSTEM', (antwort && antwort.fehler && antwort.fehler.meldung) || 'Konsole nicht erreichbar');
      const protokolle = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim());
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${annahmeSchluessel(req.headers['sec-websocket-key'])}`, ...(protokolle.includes('binary') ? ['Sec-WebSocket-Protocol: binary'] : []), '', ''].join('\r\n'));
      if (rest.length) socket.write(rahmen(rest));
    } catch (e) {
      try { kanal?.destroy(); } catch { /* egal */ }
      protokoll?.eintrag('vm_konsole', { nutzer: s.nutzer, fehler: e.message });
      return ablehnen(socket, 502, 'Bad Gateway');
    }
    protokoll?.eintrag('vm_konsole', { nutzer: s.nutzer, start: true });
    let puffer = Buffer.alloc(0); let zu = false;
    const schliessen = () => { if (zu) return; zu = true; try { socket.end(rahmen(Buffer.alloc(0), 8)); } catch { /* egal */ } try { kanal.destroy(); } catch { /* egal */ } setTimeout(() => socket.destroy(), 1000).unref?.(); };
    const vomBrowser = (d) => {
      puffer = Buffer.concat([puffer, d]);
      let r;
      try { r = rahmenLesen(puffer); } catch { schliessen(); return; }
      puffer = Buffer.from(r.rest);
      for (const f of r.rahmen) {
        if (f.opcode === 0x8) { schliessen(); return; }
        if (f.opcode === 0x9) { try { socket.write(rahmen(f.daten, 0xa)); } catch { /* egal */ } continue; }
        if (f.opcode === 0xa) continue;
        if (f.opcode === 0x0 || f.opcode === 0x1 || f.opcode === 0x2) { if (f.daten.length) kanal.write(f.daten); }
      }
    };
    if (kopf && kopf.length) vomBrowser(kopf);
    socket.on('data', vomBrowser);
    kanal.on('data', (d) => { if (!zu) socket.write(rahmen(d)); });
    kanal.resume();
    kanal.on('end', schliessen); kanal.on('close', schliessen); kanal.on('error', schliessen);
    socket.on('close', schliessen); socket.on('end', schliessen);
  };
}
