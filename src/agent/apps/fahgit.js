// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Verbindung zu FAH-Git (Betreiber 26.10.2026: „in den Admin-Einstellungen hinterlegt man die Adresse als Verbindung zu
// FAH-Git inkl. Token – nur 1× ein Token, der für alle Projekte greift“). FAH-NAS liest nur: Baum, Projekt (Zweige),
// Archiv eines Commits. Der Zugangsschlüssel liegt in <konfig>/fahgit.json (0600, nur root) und verlässt den Agenten nie.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const FAHGIT_DATEI = 'fahgit.json';
export const SCHLUESSEL_MUSTER = /^fgit_[A-Za-z0-9_-]{20,80}$/;
const ADRESSE_MUSTER = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;
const ZEITLIMIT_MS = 15_000;
const ARCHIV_ZEITLIMIT_MS = 10 * 60_000;

/** Adresse vereinheitlichen: Schema Pflicht, ohne abschließenden Schrägstrich; ungültig → FahnasFehler. */
export function adresseNormieren(roh) {
  const a = String(roh || '').trim().replace(/\/+$/, '');
  if (!a) throw new FahnasFehler('E_PARAMS', 'Bitte die Adresse von FAH-Git angeben, z. B. http://nas.local:3300', { feld: 'adresse' });
  if (!ADRESSE_MUSTER.test(a)) throw new FahnasFehler('E_PARAMS', 'Die Adresse muss mit http:// oder https:// beginnen, z. B. http://nas.local:3300', { feld: 'adresse' });
  return a;
}

/** Gespeicherte Verbindung ({adresse, token, …}) oder null. */
export async function verbindungLaden(konfig) {
  const d = await konfig.laden(FAHGIT_DATEI, null);
  return d && d.adresse && d.token ? d : null;
}

/** Verbindung für die Oberfläche – ohne Schlüssel, nur dessen Anfang. */
export function verbindungAnsicht(d) {
  if (!d) return { eingerichtet: false, adresse: '', schluessel_anfang: '', geprueft: null };
  return { eingerichtet: !!(d.adresse && d.token), adresse: d.adresse || '', schluessel_anfang: d.token ? `${d.token.slice(0, 9)}…` : '', geprueft: d.geprueft || null };
}

function fehlerAusAntwort(status, text) {
  let meldung = '';
  try { meldung = JSON.parse(text).fehler || ''; } catch { meldung = ''; }
  if (status === 401) return new FahnasFehler('E_RECHTE', 'FAH-Git lehnt den Zugangsschlüssel ab – bitte in FAH-Git unter „Mein Konto“ einen neuen anlegen und hier eintragen', { status });
  if (status === 403) return new FahnasFehler('E_RECHTE', `FAH-Git verweigert den Zugriff${meldung ? `: ${meldung}` : ''}`, { status });
  if (status === 404) return new FahnasFehler('E_NICHT_GEFUNDEN', `In FAH-Git nicht gefunden${meldung ? `: ${meldung}` : ''}`, { status });
  return new FahnasFehler('E_SYSTEM', `FAH-Git antwortet mit Fehler ${status}${meldung ? `: ${meldung}` : ''}`, { status });
}

function verbindungsFehler(e, adresse) {
  const ursache = e && (e.cause?.code || e.code || e.name);
  if (ursache === 'TimeoutError' || ursache === 'AbortError') return new FahnasFehler('E_SYSTEM', `FAH-Git unter ${adresse} antwortet nicht rechtzeitig`, { adresse });
  return new FahnasFehler('E_SYSTEM', `FAH-Git unter ${adresse} ist nicht erreichbar (${ursache || e.message})`, { adresse });
}

/** GET auf die FAH-Git-API mit Bearer-Schlüssel → JSON. */
export async function abrufen(v, pfad, params = {}) {
  const url = new URL(`${v.adresse}/api${pfad}`);
  for (const [k, w] of Object.entries(params)) if (w !== undefined && w !== null && w !== '') url.searchParams.set(k, String(w));
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${v.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(ZEITLIMIT_MS) });
  } catch (e) { throw verbindungsFehler(e, v.adresse); }
  const text = await res.text();
  if (!res.ok) throw fehlerAusAntwort(res.status, text);
  try { return JSON.parse(text); } catch { throw new FahnasFehler('E_SYSTEM', `Unter ${v.adresse} antwortet kein FAH-Git (keine gültige Antwort)`, { adresse: v.adresse }); }
}

/** Verbindung prüfen: angemeldeter Nutzer + Version. */
export async function pruefen(v) {
  const s = await abrufen(v, '/status');
  if (!s || !s.version) throw new FahnasFehler('E_SYSTEM', `Unter ${v.adresse} antwortet kein FAH-Git`, { adresse: v.adresse });
  if (!s.nutzer) throw new FahnasFehler('E_RECHTE', 'FAH-Git kennt den Zugangsschlüssel nicht – bitte in FAH-Git unter „Mein Konto“ einen neuen anlegen', {});
  return { nutzer: s.nutzer.name || s.nutzer.anzeige || '', admin: !!s.nutzer.admin, version: s.version };
}

/** Alle Projekte des Baums flach: {pfad, name, ordner (Namen der Ordner), beschreibung, zuletzt}. */
export function projekteFlach(baum) {
  const aus = [];
  const lauf = (knoten, namen) => {
    for (const p of (knoten && knoten.projekte) || []) aus.push({ pfad: p.pfad, slug: p.slug, name: p.name || p.slug, ordner: namen.join(' / '), beschreibung: p.beschreibung || '', zuletzt: p.zuletzt || null });
    for (const o of (knoten && knoten.ordner) || []) lauf(o, [...namen, o.name || o.slug]);
  };
  lauf(baum, []);
  return aus;
}

/** Projekt: Standardzweig + Zweige mit Kopf-Commit. */
export async function projekt(v, pfad) {
  const p = await abrufen(v, '/projekt', { pfad });
  return {
    pfad: p.pfad, slug: p.slug, name: p.name || p.slug, leer: !!p.leer, standard: p.standard || 'main',
    zweige: (p.zweige || []).map((z) => ({ name: z.name, sha: z.sha, datum: z.datum || null, betreff: z.betreff || '', autor: z.autor || '' })),
  };
}

/** Kopf-Commit eines Zweigs (oder Fehler, wenn es den Zweig nicht gibt). */
export async function kopf(v, pfad, zweig) {
  const p = await projekt(v, pfad);
  if (p.leer) throw new FahnasFehler('E_PARAMS', `Das Projekt ${pfad} ist in FAH-Git noch leer`, { feld: 'pfad' });
  const name = zweig || p.standard;
  const z = p.zweige.find((x) => x.name === name);
  if (!z) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Den Zweig „${name}“ gibt es im Projekt ${pfad} nicht`, { feld: 'zweig' });
  return { projekt: p, zweig: z };
}

/** Archiv (ZIP) eines Commits nach `ziel` laden – höchstens `maxBytes`, sonst Abbruch und Datei weg. */
export async function archivLaden(v, pfad, sha, ziel, maxBytes) {
  const url = new URL(`${v.adresse}/api/archiv`);
  url.searchParams.set('pfad', pfad); url.searchParams.set('ref', sha);
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${v.token}` }, redirect: 'error', signal: AbortSignal.timeout(ARCHIV_ZEITLIMIT_MS) });
  } catch (e) { throw verbindungsFehler(e, v.adresse); }
  if (!res.ok || !res.body) throw fehlerAusAntwort(res.status, await res.text().catch(() => ''));
  let n = 0;
  const zaehler = new Transform({
    transform(teil, _k, fertig) {
      n += teil.length;
      if (n > maxBytes) { fertig(new FahnasFehler('E_PLATZ', 'Das Projekt ist als ZIP zu groß für eine App', { max: maxBytes })); return; }
      fertig(null, teil);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), zaehler, fs.createWriteStream(ziel, { mode: 0o600 }));
  } catch (e) {
    await fsp.rm(ziel, { force: true }).catch(() => {});
    throw e instanceof FahnasFehler ? e : verbindungsFehler(e, v.adresse);
  }
  if (!n) { await fsp.rm(ziel, { force: true }).catch(() => {}); throw new FahnasFehler('E_SYSTEM', 'FAH-Git hat ein leeres Archiv geliefert', { pfad }); }
  return n;
}
