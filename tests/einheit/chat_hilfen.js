// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Umgebung aller Chat-Agent-Tests (Plan 02): Werkzeuge wie der Agent (werkzeugeBauen), Chat-Speicher im
// Temp-Ordner, Nutzer anna/ben/cara (nutzer) und chef (admin), Freigaben team (anna, ben schreiben), lesen (anna liest),
// geheim (niemand). Der Dateihelfer läuft echt, aber ohne Nutzerwechsel; Datenkanal-Tickets und Handy-Meldungen
// werden nur aufgezeichnet.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as system from '../../src/gemeinsam/system.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const CHAT_MODUL = path.join(HIER, '..', '..', 'src', 'agent', 'aktionen', 'chat.js');
const GAST = { nutzer: 'web', rolle: 'gast', ip: '1.2.3.4' };

export async function chatUmgebung() {
  const u = await werkzeugeBauen();
  const w = u.werkzeuge;
  const chat = path.join(u.pfade.daten, 'chat');
  u.pfade.chat = chat;
  const shares = u.pfade.shares;
  await u.konfig.speichern('users.json', {
    nutzer: [
      { name: 'anna', anzeigename: 'Anna A.', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'ben', anzeigename: 'Ben', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'cara', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'chef', anzeigename: 'Chef', rolle: 'admin', gesperrt: false, gruppen: [] },
    ],
    gruppen: [],
  });
  await u.konfig.speichern('shares.json', {
    freigaben: [
      { name: 'team', gaeste: false, lesen: [], schreiben: ['anna', 'ben'], papierkorb: true },
      { name: 'lesen', gaeste: false, lesen: ['anna'], schreiben: [], papierkorb: true },
      { name: 'geheim', gaeste: false, lesen: [], schreiben: [], papierkorb: true },
    ],
  });
  for (const f of ['team', 'lesen', 'geheim']) await fs.mkdir(path.join(shares, f), { recursive: true });

  // Systemhülle: Dateihelfer echt (ohne Nutzerwechsel), df mit viel Platz, alles andere ans Scheinsystem
  w.system = {
    ...system,
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined, gruppen: undefined });
      if (prog === 'df') return { code: 0, stdout: '1B-blocks Avail\n1000000000000 500000000000\n', stderr: '' };
      return system.ausfuehren(prog, args, opt);
    },
    starten(prog, args, opt = {}) { return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined, gruppen: undefined }); },
    async nutzerIds() { return { uid: 2000, gid: 100, gruppen: [] }; },
  };
  const tickets = [];
  w.datenkanal = { ticket(d) { tickets.push(d); return { ticket: `k-${tickets.length}`, dateiname: d.dateiname, groesse: d.groesse, mime: d.mime || 'application/octet-stream' }; } };
  const push = [];
  w.persoenlichSenden = async (_w, nutzer, m) => { push.push({ nutzer, ...m }); return true; };

  try {
    const m = await import(pathToFileURL(CHAT_MODUL).href);
    m.registriere(u.reg, w);
  } catch (e) {
    if (e && e.code !== 'ERR_MODULE_NOT_FOUND') throw e; // Aufgaben 1–3: chat.js gibt es noch nicht
  }

  return {
    u, w, chat, shares, tickets, push,
    als: (nutzer, rolle = 'nutzer') => u.als(nutzer, rolle),
    gast: (aktion, params) => u.rufen(aktion, params, GAST),
    ereignisse: () => u.ereignisse.filter((e) => e.ereignis === 'chat'),
    async ticketAbschliessen(i, inhalt) {
      await fs.mkdir(path.dirname(tickets[i].pfad), { recursive: true });
      await fs.writeFile(tickets[i].pfad, inhalt);
      return tickets[i].abschluss(true);
    },
    aufraeumen: () => u.aufraeumen(),
  };
}
