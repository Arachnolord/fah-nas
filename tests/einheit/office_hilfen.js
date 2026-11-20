// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Umgebung der Office-Agent-Tests (Plan 04): Werkzeuge wie der Agent, Nutzer anna „Anna A.“, ben „Ben“, cara,
// dora (gesperrt) und chef „Chef“ (admin); Freigaben team (anna, ben schreiben), privat (anna schreibt), lesen (anna
// schreibt, ben liest), geheim (niemand). Der Dateihelfer läuft echt ohne Nutzerwechsel; wer als wer schreibt,
// zeichnet nutzerIds auf. Datenkanal-Tickets und Handy-Meldungen werden nur aufgezeichnet.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as system from '../../src/gemeinsam/system.js';
import { werkzeugeBauen } from './nutzer_scheinsystem.js';
import * as dateien from '../../src/agent/aktionen/dateien.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const OFFICE_MODUL = path.join(HIER, '..', '..', 'src', 'agent', 'aktionen', 'office.js');

export async function officeUmgebung() {
  const u = await werkzeugeBauen();
  const w = u.werkzeuge;
  const shares = u.pfade.shares;
  await u.konfig.speichern('users.json', {
    nutzer: [
      { name: 'anna', anzeigename: 'Anna A.', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'ben', anzeigename: 'Ben', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'cara', rolle: 'nutzer', gesperrt: false, gruppen: [] },
      { name: 'dora', rolle: 'nutzer', gesperrt: true, gruppen: [] },
      { name: 'chef', anzeigename: 'Chef', rolle: 'admin', gesperrt: false, gruppen: [] },
    ],
    gruppen: [],
  });
  await u.konfig.speichern('shares.json', {
    freigaben: [
      { name: 'team', gaeste: false, lesen: [], schreiben: ['anna', 'ben'], papierkorb: true },
      { name: 'privat', gaeste: false, lesen: [], schreiben: ['anna'], papierkorb: true },
      { name: 'lesen', gaeste: false, lesen: ['ben'], schreiben: ['anna'], papierkorb: true },
      { name: 'geheim', gaeste: false, lesen: [], schreiben: [], papierkorb: true },
    ],
  });
  for (const f of ['team', 'privat', 'lesen', 'geheim']) await fs.mkdir(path.join(shares, f), { recursive: true });

  const ids = [];
  w.system = {
    ...system,
    async ausfuehren(prog, args, opt = {}) {
      if (prog === process.execPath) return system.befehl(prog, args, { ...opt, uid: undefined, gid: undefined, gruppen: undefined });
      if (prog === 'df') return { code: 0, stdout: '1B-blocks Avail\n1000000000000 500000000000\n', stderr: '' };
      return system.ausfuehren(prog, args, opt);
    },
    starten(prog, args, opt = {}) { return system.starten(prog, args, { ...opt, uid: undefined, gid: undefined, gruppen: undefined }); },
    async nutzerIds(n) { ids.push(n); return { uid: 2000, gid: 100, gruppen: [] }; },
  };
  const jetzt = { wert: Date.parse('2026-10-18T08:00:00.000Z') };
  w.jetzt = () => jetzt.wert;
  const tickets = [];
  w.datenkanal = { ticket(d) { tickets.push(d); return { ticket: `k-${tickets.length}`, dateiname: d.dateiname, groesse: d.groesse, mime: d.mime || 'application/octet-stream' }; } };
  const push = [];
  w.persoenlichSenden = async (_w, nutzer, m) => { push.push({ nutzer, ...m }); return true; };

  dateien.registriere(u.reg, w);
  try {
    const m = await import(pathToFileURL(OFFICE_MODUL).href);
    m.registriere(u.reg, w);
  } catch (e) {
    if (e && e.code !== 'ERR_MODULE_NOT_FOUND') throw e; // Aufgaben 1–2: office.js gibt es noch nicht
  }

  return {
    u, w, shares, ids, tickets, push, jetzt,
    als: (nutzer, rolle = 'nutzer') => u.als(nutzer, rolle),
    ereignisse: () => u.ereignisse.filter((e) => e.ereignis === 'office'),
    async ticketAbschliessen(i, inhalt) {
      await fs.mkdir(path.dirname(tickets[i].pfad), { recursive: true });
      await fs.writeFile(tickets[i].pfad, inhalt);
      return tickets[i].abschluss(true);
    },
    aufraeumen: () => u.aufraeumen(),
  };
}
