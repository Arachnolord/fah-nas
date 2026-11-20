// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fällige Board-Karten (Plan 04, Entwurf §6.1): je Nutzer die Karten, für die er zuständig ist und die heute oder
// früher fällig sind – nur aus Boards, die er ohne Admin-Sonderrecht öffnen darf. Kachel und Startseite fragen über
// office.faellig (Zwischenspeicher 300 s); um 08:00 Ortszeit geht je Nutzer höchstens eine Handy-Meldung raus.

import { indexLaden } from './index.js';
import { officeZugriff } from './zugriff.js';
import { helfer } from '../aktionen/dateien.js';
import { persoenlichSenden } from '../benachrichtigung/persoenlich.js';
import { umbenennungenLaden, namenErsetzen } from '../helfer/umbenennungen.js';

export const BOARDS_MAX = 200;
export const ZWISCHENSPEICHER_MS = 300_000;
const DATUM = /^\d{4}-\d\d-\d\d$/;
const merk = new Map(); // nutzer → {zeit, heute, karten}

const jetztMs = (w) => (typeof w.jetzt === 'function' ? w.jetzt() : Date.now());
const reihenfolge = (a, b) => a.faellig.localeCompare(b.faellig) || a.titel.localeCompare(b.titel, 'de');

/** Datum in Ortszeit als „JJJJ-MM-TT“. */
export function datumOrt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Karten eines Boards, für die `nutzer` zuständig ist und die bis `heute` fällig sind (ohne Archiv). */
export function faelligeKarten(daten, nutzer, heute) {
  const karten = daten && daten.karten && typeof daten.karten === 'object' ? Object.values(daten.karten) : [];
  return karten
    .filter((k) => k && !k.archiviert && Array.isArray(k.zustaendig) && k.zustaendig.includes(nutzer) && typeof k.faellig === 'string' && DATUM.test(k.faellig) && k.faellig <= heute)
    .map((k) => ({ karte_id: k.id, titel: String(k.titel ?? ''), faellig: k.faellig, ueberfaellig: k.faellig < heute }))
    .sort(reihenfolge);
}

/** Fällige Karten aller lesbaren Boards (höchstens BOARDS_MAX, zuletzt geänderte zuerst); unlesbare still übersprungen. */
export async function faelligFuer(w, kontext, jetzt = new Date(jetztMs(w))) {
  const heute = datumOrt(jetzt);
  const zeit = jetztMs(w);
  const m = merk.get(kontext.nutzer);
  if (m && m.heute === heute && zeit - m.zeit < ZWISCHENSPEICHER_MS) return { karten: m.karten.map((k) => ({ ...k })) };
  const alsNutzer = { ...kontext, rolle: 'nutzer' }; // ohne Admin-Sonderrecht
  const ix = await indexLaden(w);
  const boards = Object.values(ix.dokumente).filter((d) => d && d.art === 'board' && !d.geloescht)
    .sort((a, b) => String(b.geaendert).localeCompare(String(a.geaendert))).slice(0, BOARDS_MAX);
  const karten = [];
  const umbenannt = await umbenennungenLaden(w); // Karten umbenannter Nutzer tragen bis zum nächsten Speichern den alten Namen
  for (const b of boards) {
    try {
      const z = await officeZugriff(w, { id: b.id }, alsNutzer);
      const g = await helfer(w, z.als, 'office_lesen', { wurzel: z.wurzel, rel: z.rel });
      for (const k of faelligeKarten(namenErsetzen(g.inhalt.daten, umbenannt), kontext.nutzer, heute)) karten.push({ board_id: b.id, board_name: b.name, ...k });
    } catch { /* kein Recht, verschoben oder beschädigt → überspringen */ }
  }
  karten.sort(reihenfolge);
  merk.set(kontext.nutzer, { zeit, heute, karten });
  return { karten: karten.map((k) => ({ ...k })) };
}

/** Zwischenspeicher leeren (nach dem Speichern eines Boards, nach geänderten Office-Freigaben). */
export function faelligVergessen() { merk.clear(); }

/** Millisekunden bis zum nächsten 08:00:00.000 Ortszeit, strikt nach `jetzt`. */
export function msBisAcht(jetzt) {
  const ziel = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate(), 8, 0, 0, 0);
  if (ziel.getTime() <= jetzt.getTime()) ziel.setDate(ziel.getDate() + 1);
  return ziel.getTime() - jetzt.getTime();
}

/** Morgen-Meldung: je Nutzer mit eingeschalteten Handy-Meldungen (und faellig_push nicht aus) eine Meldung. */
export async function morgenlauf(w, jetzt = new Date(jetztMs(w))) {
  const senden = typeof w.persoenlichSenden === 'function' ? w.persoenlichSenden : persoenlichSenden;
  const users = await w.konfig.laden('users.json', { nutzer: [] });
  const heute = datumOrt(jetzt);
  let gesendet = 0;
  for (const n of users?.nutzer || []) {
    if (!n || n.gesperrt || n.einstellungen?.benachrichtigung?.aktiv !== true) continue;
    if (n.einstellungen?.office?.faellig_push === false) continue;
    const { karten } = await faelligFuer(w, { nutzer: n.name, rolle: n.rolle || 'nutzer', ip: '-' }, jetzt);
    if (!karten.length) continue;
    const text = karten.length === 1 ? '1 Karte heute fällig' : `${karten.length} Karten heute fällig`;
    if (await senden(w, n.name, { titel: 'FAH-NAS Office', text, schluessel: `faellig:${n.name}:${heute}` })) gesendet++;
  }
  return { gesendet };
}
