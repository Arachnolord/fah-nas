// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Renderer für snapper: erzeugt aus dem Plan „system“ in snapshots.json die Konfiguration /etc/snapper/configs/root
// (Zeitleiste + Aufbewahrung, NUMBER_LIMIT für pre/post um apt-Läufe) und sorgt dafür, dass die snapper-Timer laufen.
// Pfad der Konfigurationen per ENV FAHNAS_SNAPPER (Standard /etc/snapper/configs), /etc/default/snapper per
// FAHNAS_SNAPPER_DEFAULT. Idempotent: geschrieben wird nur, wenn sich der Text ändert.
// Seit 16.10.2026 räumt snapper stündlich auf (Zusatz zu snapper-cleanup.timer unter FAHNAS_SYSTEMD, Standard
// /etc/systemd/system): die Zeitleiste legt jede Stunde einen Stand an – auch wenn „Stündlich“ aus ist, dann behält sie
// nur die täglichen/wöchentlichen. Mit dem täglichen Aufräumen lagen bis zu 24 überzählige Stände herum (Betreiber-Fund:
// „werden schnappschüsse garnicht überschrieben?“ – 33 Stände bei 7 täglich + 4 wöchentlich).

import fs from 'node:fs/promises';
import path from 'node:path';

export const BEHALTEN_STANDARD = Object.freeze({ stuendlich: 24, taeglich: 7, woechentlich: 4, monatlich: 12, pre_post: 10 });

export function snapperOrdner() { return process.env.FAHNAS_SNAPPER || '/etc/snapper/configs'; }
export function snapperStandardDatei() { return process.env.FAHNAS_SNAPPER_DEFAULT || '/etc/default/snapper'; }
export function systemdOrdner() { return process.env.FAHNAS_SYSTEMD || '/etc/systemd/system'; }
export const AUFRAEUMEN_ZUSATZ = 'snapper-cleanup.timer.d/fahnas-stuendlich.conf';
// FALLE (bis 0.31.0): Ein leeres „OnUnitActiveSec=“ setzt bei systemd die GANZE Liste der Zeitauslöser zurück – auch
// OnBootSec=10m der Original-Unit. Übrig blieb „1 h nach dem letzten Lauf“, und den gibt es nach einem Neustart nicht:
// Der Timer lief seit dem Neustart am 28.10.2026 nie mehr, auf dem Mini-PC sammelten sich 396 Zeitleisten-Stände.
// Jetzt fester Stundentakt (Kalender, jeweils :30 – versetzt zur Zeitleiste um :00) plus einmal 10 min nach dem Start.
export const AUFRAEUMEN_TEXT = [
  '# Erzeugt von FAH-NAS: snapper räumt stündlich auf statt einmal am Tag (die Zeitleiste legt jede Stunde einen Stand an).',
  '# Leere Zuweisungen setzen die Auslöser der Original-Unit zurück; danach fester Kalendertakt (läuft auch nach Neustarts).',
  '[Timer]',
  'OnBootSec=',
  'OnUnitActiveSec=',
  'OnBootSec=10m',
  'OnCalendar=*-*-* *:30:00',
  'Persistent=true',
].join('\n') + '\n';

/** Wie viele Stände eines Takts bleiben: der eingestellte Wert, bei 0/fehlend der Standard (nie „unbegrenzt“). */
export function anzahlBehalten(takt, behalten) {
  const w = behalten && behalten[takt];
  return Number.isInteger(w) && w > 0 ? w : BEHALTEN_STANDARD[takt];
}

/** Text der snapper-Konfiguration „root“ für einen Plan {zeitplan, behalten} (null = keine Zeitleiste). */
export function snapperKonfigText(plan) {
  const z = (plan && plan.zeitplan) || {};
  const b = (plan && plan.behalten) || {};
  const zeitleiste = !!(z.stuendlich || z.taeglich || z.woechentlich || z.monatlich);
  const prePost = anzahlBehalten('pre_post', b);
  return [
    '# Erzeugt von FAH-NAS aus snapshots.json (Plan „system“). Nicht von Hand ändern – wird beim nächsten Rendern überschrieben.',
    '# Unterlaufwerk @ ist als / eingehängt, Schnappschüsse liegen unter /.snapshots (Unterlaufwerk @snapshots).',
    'SUBVOLUME="/"',
    'FSTYPE="btrfs"',
    'QGROUP=""',
    'SPACE_LIMIT="0.5"',
    'FREE_LIMIT="0.2"',
    'ALLOW_USERS=""',
    'ALLOW_GROUPS=""',
    'SYNC_ACL="no"',
    'BACKGROUND_COMPARISON="yes"',
    '# pre/post-Paare um apt-Läufe (system.updates.einspielen)',
    'NUMBER_CLEANUP="yes"',
    'NUMBER_MIN_AGE="1800"',
    `NUMBER_LIMIT="${prePost}"`,
    `NUMBER_LIMIT_IMPORTANT="${prePost}"`,
    '# Zeitleiste',
    `TIMELINE_CREATE="${zeitleiste ? 'yes' : 'no'}"`,
    'TIMELINE_CLEANUP="yes"',
    'TIMELINE_MIN_AGE="1800"',
    `TIMELINE_LIMIT_HOURLY="${z.stuendlich ? anzahlBehalten('stuendlich', b) : 0}"`,
    `TIMELINE_LIMIT_DAILY="${z.taeglich ? anzahlBehalten('taeglich', b) : 0}"`,
    `TIMELINE_LIMIT_WEEKLY="${z.woechentlich ? anzahlBehalten('woechentlich', b) : 0}"`,
    `TIMELINE_LIMIT_MONTHLY="${z.monatlich ? anzahlBehalten('monatlich', b) : 0}"`,
    'TIMELINE_LIMIT_YEARLY="0"',
    'EMPTY_PRE_POST_CLEANUP="yes"',
    'EMPTY_PRE_POST_MIN_AGE="1800"',
  ].join('\n') + '\n';
}

async function atomarSchreiben(datei, text, modus = 0o640) {
  const tmp = `${datei}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w', modus);
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, datei);
}

/** Trägt „root“ in SNAPPER_CONFIGS von /etc/default/snapper ein, falls die Datei existiert und der Eintrag fehlt. */
async function standardDateiPflegen(datei) {
  let text;
  try { text = await fs.readFile(datei, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const m = text.match(/^SNAPPER_CONFIGS="([^"]*)"[ \t]*$/m);
  if (m) {
    const namen = m[1].split(/\s+/).filter(Boolean);
    if (namen.includes('root')) return false;
    namen.push('root');
    await atomarSchreiben(datei, text.replace(m[0], `SNAPPER_CONFIGS="${namen.join(' ')}"`), 0o644);
    return true;
  }
  await atomarSchreiben(datei, `${text.endsWith('\n') || text === '' ? text : text + '\n'}SNAPPER_CONFIGS="root"\n`, 0o644);
  return true;
}

/**
 * Schreibt die Konfiguration und aktiviert die Timer.
 * @param {object|null} planSystem  Eintrag mit ziel "system" aus snapshots.json
 * @param {{system?:object, ordner?:string, standardDatei?:string, systemd?:string}} o  system = werkzeuge.system (für systemctl)
 * @returns {Promise<{datei:string, geaendert:boolean, timer:boolean, aufraeumen:boolean}>}
 */
export async function rendereSnapper(planSystem, { system, ordner = snapperOrdner(), standardDatei = snapperStandardDatei(), systemd = systemdOrdner() } = {}) {
  const text = snapperKonfigText(planSystem);
  const datei = path.join(ordner, 'root');
  await fs.mkdir(ordner, { recursive: true, mode: 0o750 });
  let alt = null;
  try { alt = await fs.readFile(datei, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let geaendert = false;
  if (alt !== text) { await atomarSchreiben(datei, text); geaendert = true; }
  if (await standardDateiPflegen(standardDatei)) geaendert = true;
  // stündliches Aufräumen: Zusatz zum Timer, nur bei Änderung neu laden
  const zusatz = path.join(systemd, AUFRAEUMEN_ZUSATZ);
  let zusatzAlt = null;
  try { zusatzAlt = await fs.readFile(zusatz, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const aufraeumen = zusatzAlt !== AUFRAEUMEN_TEXT;
  if (aufraeumen) { await fs.mkdir(path.dirname(zusatz), { recursive: true, mode: 0o755 }); await atomarSchreiben(zusatz, AUFRAEUMEN_TEXT, 0o644); }
  let timer = false;
  if (system) {
    if (aufraeumen) await system.ausfuehren('systemctl', ['daemon-reload']);
    await system.ausfuehren('systemctl', ['enable', '--now', 'snapper-timeline.timer', 'snapper-cleanup.timer']);
    // Neustart übernimmt den neuen Takt; war der letzte Lauf länger als eine Stunde her, räumt snapper gleich auf
    if (aufraeumen) await system.ausfuehren('systemctl', ['restart', 'snapper-cleanup.timer']);
    timer = true;
  }
  return { datei, geaendert, timer, aufraeumen };
}
