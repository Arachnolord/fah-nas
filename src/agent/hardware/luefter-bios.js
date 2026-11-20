// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Lüfter an das BIOS zurückgeben – läuft als ExecStopPost des Agenten (auch nach einem Absturz). Liest den beim Start
// gesicherten Zustand (/run/fahnas/luefter-bios.json), schreibt ihn über /dev/port zurück und löscht die Datei. Ohne
// Datei (kein UGREEN-Gehäuse, Lüfter nie übernommen) tut es nichts. Exit immer 0 – der Dienst soll nie daran hängen.

import fs from 'node:fs';
import path from 'node:path';
import { devPort, ec, pwmZurueck } from './ugreen.js';

const datei = path.join(process.env.FAHNAS_RUN || '/run/fahnas', 'luefter-bios.json');
try {
  const bios = JSON.parse(fs.readFileSync(datei, 'utf8'));
  const io = devPort();
  try {
    const e = ec(io, Number(bios.basis));
    for (const [i, alt] of Object.entries(bios.kanaele || {})) pwmZurueck(e, Number(i), alt);
  } finally { io.schliessen(); }
  fs.unlinkSync(datei);
  process.stdout.write('[luefter-bios] Lüfter an das BIOS zurückgegeben\n');
} catch (e) {
  if (e.code !== 'ENOENT') process.stderr.write(`[luefter-bios] ${e.message}\n`);
}
