#!/usr/bin/env node
// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Start-Schritt von fahnas-speicherorte.service: Speicherorte (Docker/Apps/VMs auf übernommenem Volume) einhängen,
// bevor Docker und libvirt starten. Ohne Einstellung: nichts zu tun (Exit 0). Fehlt etwas: Exit 1 – dann starten die
// abhängigen Dienste nicht (Requires=), statt leer auf der Systemplatte loszulegen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ausfuehren } from '../../gemeinsam/system.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { bereitstellen, normieren, DATEI } from './speicherorte.js';

async function json(datei) { try { return JSON.parse(await fs.readFile(datei, 'utf8')); } catch { return null; } }

const orte = normieren(await json(path.join(PFADE.konfig, DATEI)));
const importe = await json(path.join(PFADE.konfig, 'importe.json'));
const r = await bereitstellen({ system: { ausfuehren }, pfade: PFADE, orte, volumes: importe?.volumes || [] });
for (const b of r.gebunden) process.stdout.write(`Speicherort ${b} eingehängt\n`);
if (r.fehler.length) { process.stderr.write(`Speicherorte nicht bereit: ${r.fehler.join('; ')}\n`); process.exit(1); }
